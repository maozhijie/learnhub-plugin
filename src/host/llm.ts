/**
 * 宿主 LLM 适配层（#152 刀 12 自 src/index.ts 抽出；#162 起是双模式缝的唯一适配文件）：
 * 部署配置 → 语义档翻译 → dsh llm 流式调用（空闲超时/截断重试/档位降级）
 * + 引擎侧 LlmComplete / LlmStream 端口的真实现适配 + 缝出口的调用记录捕获（#330）。
 *
 * 与路由/队列/工具面无关的纯技术层：本文件只依赖 cordis Context、dsh-llm 与
 * host/corpus 的捕获缝，不碰 engine 状态。ADR-0044：`@deepseek-ai/dsh-llm` /
 * `cordis` 的引擎侧引用点不增加——dsh 耦合 100% 收在本文件。
 * 捕获（#330 / ADR-0103，取代 #213 的缝出口单记）：所有真模型调用（补全 + 工具回路 +
 * 教练讲解直调）**在重试环内逐次尝试落档**——截断重试与档位降级不再不可见；每次尝试
 * 一节：请求 JSON（语义级请求 + 当次 maxTokens）+ 响应 JSON（text/reasoning/工具调用
 * 含 id/真实结束原因/usage 含缓存与总 token）。调用级失败记 failed+稳定错误码后原样
 * 上抛；解析级失败/容忍由宿主 catch 点经 capture.annotateLast 补标。站标签（station/kind）
 * 来自端口 opts（AgentSeam 贯通）或工厂闭包（单站注入点）；任务身份（course/node/来源）
 * 由调用点经 stampCorpusSink 盖在捕获缝上，不进端口类型。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createUserMessage,
  createToolResultMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { Message, TokenUsage, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import { stripFences } from '../engine/index.ts'
import type { LlmCallKind, LlmComplete, LlmEffort, LlmLoopTurn, LlmStream, LlmTokenUsage, LlmToolCall } from '../engine/index.ts'
import type { CallRequestRecord, CallResponseRecord, CorpusRecordInput, CorpusSink } from './corpus.ts'

export const llmCfg = {
  provider: 'deepseek-official', model: 'deepseek-v4-flash',
  fastEffort: 'off' as 'off' | 'low',
  deepEffort: 'low' as 'off' | 'low',
}

/** P4 分层 effort：机械调用统一走 fast 档；高复杂度节点的大纲/修复轮升 deep 档。
 * 调用点只声明语义档（注入侧可观测），翻译成部署的 fastEffort/deepEffort 收口在 llmSeam（#137）。
 * 名字留在 effort 词族——「档位」在 CONTEXT.md 语言表里专指复杂度档位（contentTierOf），不混用。 */
export function contentEffort(highTier: boolean): LlmEffort {
  return highTier ? 'deep' : 'fast'
}

/** 日志自查三态视图（#313 E26）：`failures` / `lastError` / `cappedDay` 此前生产零消费
 * （只有连续失败 5 次的 console.warn）——「日志自己坏了」在面板与 /status 上都看不到。
 * 读侧住宿主：具体实现（FileLogger）住这一层，引擎只认 Logger 端口，不为观测面加宽端口；
 * 端口实现不带这三态（如 noop/内存假实现）时返回 null，字段照旧在场（面板按 null 走空态）。 */
export function logHealthOf(logger: unknown): { failures: number; last_error: string | null; capped_today: string | null } | null {
  const l = logger as Partial<{ failures: number; lastError: string | null; cappedDay: string | null }> | null
  if (!l || typeof l.failures !== 'number') return null
  return { failures: l.failures, last_error: l.lastError ?? null, capped_today: l.cappedDay ?? null }
}

/** 当前 LLM 配置视图（模型透明，#? 与 /status、learnhub_status 一同带出，面板只读展示；
 * 切换模型 = 编辑 profile patch（cordis.patch.yml 的 dsh-learnhub 行 provider/model/
 * fastEffort/deepEffort）后重启宿主——插件不写宿主机器级配置）。 */
export function llmView() {
  return {
    provider: llmCfg.provider, model: llmCfg.model,
    fast_effort: llmCfg.fastEffort, deep_effort: llmCfg.deepEffort,
  }
}

/** Agent 独有能力在面板的说明锚点（能指南，ADR 面无此决议；与工具注册同文件维护，
 * 指南页与各页「这些事可以找 agent」提示都从这里渲染——单一事实源防文案漂移）。
 * 分流纪律：面板已有控件的动作不进指南（UI 是默认通道，agent 是进阶路径）——
 * 建课/生长/罗盘/回填/反编译/项目草案/项目创建已随面板下发退出本清单。
 * page = 面板区页签（#205 / ADR-0058 五区：today/courses/insight/projects/practice + global，与 ui/src/lib/router.ts 的 ZONE_KEYS 同构 + global，增删区键两处同步）；
 * prompt = 可直接粘进 dsh 会话的示例指令。 */

export const LLM_IDLE_TIMEOUT_MS = 120_000
/** max-tokens 截断重试（#116）的显式输出上限：截断是断尾 JSON/YAML 的常见诱因，
 * 原题提高输出上限重试一次（与引擎侧判卷重问相互独立、各限一次）。 */
export const LLM_TRUNCATION_RETRY_TOKENS = 8192

/** dsh llm 一次性调用：收集 text-delta；终止块非 success 即抛错。
 * opts.effort 指定思考档（如 'off' 快速路径）；路由不支持该档位时
 * （UNSUPPORTED_REASONING_EFFORT）自动降级为部署默认重试一次。
 * 语义档标签/站/形态/捕获缝/usage 回程随 opts 直通：捕获在 callWithCapture
 * 逐次尝试组装——成功记 ok、调用级失败记 failed+稳定码后原样上抛。
 * opts.temperature（#219）随行直通 provider（截断重试同一值）；不传 = 宿主默认。 */
export async function llmComplete(ctx: Context, prompt: string, system?: string, opts?: {
  effort?: 'off' | 'low'
  /** 语义档标签（frontmatter 记语义档；部署档翻译不丢失原值）。 */
  semanticEffort?: LlmEffort
  station?: string
  kind?: LlmCallKind
  capture?: CorpusSink
  usageSink?: (usage: LlmTokenUsage) => void
  /** 采样温度（#219）：缺省不传 = 宿主默认；调用点不设值。 */
  temperature?: number
}): Promise<string> {
  const r = await callWithCapture({
    capture: opts?.capture,
    station: opts?.station,
    kind: opts?.kind ?? 'complete',
    semanticEffort: opts?.semanticEffort,
    usageSink: opts?.usageSink,
    requestOf: applied => ({
      messages: [{ role: 'user', text: prompt }],
      ...(system === undefined ? {} : { system }),
      ...(opts?.semanticEffort === undefined ? {} : { effort: opts.semanticEffort }),
      ...(opts?.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(applied.maxTokens === undefined ? {} : { maxTokens: applied.maxTokens }),
    }),
    run: (effort, maxTokens) => streamDshTurn(ctx, {
      messages: [userTurn(prompt)],
      ...(system === undefined ? {} : { system }),
      ...(effort === undefined ? {} : { effort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(opts?.temperature === undefined ? {} : { temperature: opts.temperature }),
    }),
    effort: opts?.effort,
  })
  return r.text
}

/** 缝出口捕获 + 共享调用策略（#330 / ADR-0103；取代 #213 的环外单记 withCapture）：
 * **捕获点在重试环内**——每次物理尝试各记一条（尝试序号 attempt 递增），首轮截断与
 * 档位降级证据随节入档。请求 JSON 由 requestOf 组装（语义级 + 当次 maxTokens）；
 * 响应 JSON = StreamChunk 组装（成功取全量；失败取当次累积的部分响应——空闲超时/
 * 错误中止前的 text/工具调用不丢）。usage 先行回调观测面（逐尝试回调：重试的
 * token 代价如实计入成本面）。成功记 ok（finish=max-tokens 即截断随行），抛错记
 * failed + 稳定错误码（dsh failure.code / IDLE_TIMEOUT 等，无码归 LLM_ERROR）后原样
 * 上抛。捕获故障不挡调用（corpus.record 内部吞错）。
 * 策略（#137/#162 同一套机械，原 streamWithPolicies 并入）：max-tokens 截断提高输出
 * 上限原题重试一次；路由不支持该档位（UNSUPPORTED_REASONING_EFFORT）自动降级为部署
 * 默认重试一次。temperature 不在本函数——它住在 run 闭包（重试是同一调用意图的重放，
 * 采样旋钮不中途变）。 */
interface CaptureSpec {
  capture?: CorpusSink
  station?: string
  kind: LlmCallKind
  semanticEffort?: LlmEffort
  usageSink?: (usage: LlmTokenUsage) => void
  /** 当次尝试的语义级请求记录（applied = 本次实际下发的部署 effort/maxTokens）。 */
  requestOf: (applied: { effort?: 'off' | 'low'; maxTokens?: number }) => CallRequestRecord
  run: (effort?: 'off' | 'low', maxTokens?: number) => Promise<StreamTurnResult>
  effort?: 'off' | 'low'
}

async function callWithCapture(spec: CaptureSpec): Promise<StreamTurnResult> {
  let attemptNo = 0
  const attemptOnce = async (effort?: 'off' | 'low', maxTokens?: number): Promise<StreamTurnResult> => {
    attemptNo++
    const startedAt = Date.now()
    const applied: { effort?: 'off' | 'low'; maxTokens?: number } = {}
    if (effort !== undefined) applied.effort = effort
    if (maxTokens !== undefined) applied.maxTokens = maxTokens
    try {
      const r = await spec.run(effort, maxTokens)
      if (r.usage) spec.usageSink?.(r.usage)
      spec.capture?.(recordOf(spec, attemptNo, startedAt, applied, 'ok', {
        ...(r.usage ? { usage: r.usage } : {}),
        response: responseOf(r.text, r.reasoning, r.toolCalls, r.finish, r.usage),
      }))
      return r
    } catch (err) {
      spec.capture?.(recordOf(spec, attemptNo, startedAt, applied, 'failed', {
        code: (err as { code?: string }).code ?? 'LLM_ERROR',
        // LLM_ERROR = 调用级失败且无稳定码（与任务失败详情的 ERROR 归一口径有意区分：这是 llm 层非解析错误）
        response: (err as { response?: CallResponseRecord }).response ?? responseOf('', undefined, [], undefined, undefined),
      }))
      throw err
    }
  }
  const attempt = async (effort?: 'off' | 'low', maxTokens?: number): Promise<StreamTurnResult> => {
    const r = await attemptOnce(effort, maxTokens)
    if (!r.truncated) return r
    console.warn(`[learnhub] 模型输出被 max-tokens 截断（model=${llmCfg.model}），提高输出上限原题重试一次`)
    return attemptOnce(effort, LLM_TRUNCATION_RETRY_TOKENS)
  }
  if (spec.effort === undefined) return attempt()
  try {
    return await attempt(spec.effort)
  } catch (err) {
    if (!(err instanceof Error && (err as { code?: string }).code === 'UNSUPPORTED_REASONING_EFFORT')) throw err
    return attempt()
  }
}

function recordOf(spec: CaptureSpec, attempt: number, startedAt: number, applied: { effort?: 'off' | 'low'; maxTokens?: number }, outcome: 'ok' | 'failed', extra: { code?: string; usage?: LlmTokenUsage; response: CallResponseRecord }): CorpusRecordInput {
  return {
    ts: new Date().toISOString(),
    station: spec.station ?? '未知站',
    kind: spec.kind,
    ...(spec.semanticEffort !== undefined ? { effort: spec.semanticEffort } : {}),
    outcome,
    durationMs: Date.now() - startedAt,
    provider: llmCfg.provider,
    model: llmCfg.model,
    attempt,
    request: spec.requestOf(applied),
    ...extra,
  }
}

function responseOf(text: string, reasoning: string | undefined, toolCalls: Array<{ id: string; name: string; arguments: string }>, finish: string | undefined, usage: LlmTokenUsage | undefined): CallResponseRecord {
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finish !== undefined ? { finish } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** 宿主→引擎 LLM 补全注入缝的真实现适配器（#137）：语义档 fast/deep 翻译成部署的
 * fastEffort/deepEffort（不传档 = 部署默认），空闲超时/截断重试/档位降级都在底层
 * llmComplete。引擎侧生成/组装函数一律只认 LlmComplete 缝型——测试注入假实现
 * （固定回放/脚本化应答）即可不依赖真实模型确定性跑通金样本回放。
 * capture（#213）：单站注入点可带捕获缝；station：注入点闭包站名（端口 opts 的
 * opts.station 优先——AgentSeam 与多站共用实例的调用点在调用处标站）。 */
export function llmSeam(ctx: Context, capture?: CorpusSink, station?: string): LlmComplete {
  return (prompt, system, opts) => llmComplete(ctx, prompt, system,
    {
      ...(opts?.effort === 'fast' ? { effort: llmCfg.fastEffort, semanticEffort: 'fast' as const }
        : opts?.effort === 'deep' ? { effort: llmCfg.deepEffort, semanticEffort: 'deep' as const }
          : {}),
      ...(capture ? { capture } : {}),
      ...(station !== undefined || opts?.station !== undefined ? { station: opts?.station ?? station } : {}),  // 端口 opts 优先，闭包兜底
      ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts?.usageSink !== undefined ? { usageSink: opts.usageSink } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })
}

/** 机械站的补全缝（#175 阶段③：stripFences 九处接线随适配器归位）——llmSeam 包上
 * 补全后处理，投递层直接把它当 LlmComplete 传给引擎，不再各自 import stripFences
 * 手工包裹（stripFences 本体住 engine/infra/agent.ts，随缝定义；这里是它的适配器组装位）。 */
export function llmSeamStripped(ctx: Context, capture?: CorpusSink, station?: string): LlmComplete {
  const seam = llmSeam(ctx, capture, station)
  return async (prompt, system, opts) => stripFences(await seam(prompt, system, opts))
}

/** 宿主→引擎工具回路端口（LlmStream）的适配器（#162 / ADR-0041 回路半）：端口中立
 * 的回路历史翻译成 dsh 消息（user/assistant/tool-result），工具白名单直通 provider
 * function calling；语义档翻译、空闲超时、截断重试、档位降级与补全缝同一套机械
 * （callWithCapture：逐尝试落档）。消费方 = engine/infra/agent.ts 的 agentLoop()
 * （应用层端口消费者），测试注入假端口即可脚本化应答——回路逻辑不依赖真实模型确定性
 * 可测。req.station 沿请求贯通进调用记录（回路调用站 = 教练回合/罗盘）；
 * 请求 JSON 记结构化回路历史（原文级，取代旧的可读渲染段——#330 起 JSON 块即原文）。 */
export function llmStreamSeam(ctx: Context, capture?: CorpusSink): LlmStream {
  return async req => {
    const r = await callWithCapture({
      capture,
      station: req.station,
      kind: 'loop',
      semanticEffort: req.effort,
      requestOf: applied => ({
        messages: req.messages.map(t => t.role === 'assistant'
          ? {
            role: 'assistant' as const, text: t.text,
            ...(t.toolCalls?.length ? { toolCalls: t.toolCalls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments })) } : {}),
          }
          : t.role === 'tool' ? { role: 'tool' as const, text: t.text }
            : { role: 'user' as const, text: t.text }),
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(req.effort === undefined ? {} : { effort: req.effort }),
        ...(req.tools === undefined ? {} : { tools: req.tools }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        ...(applied.maxTokens === undefined ? {} : { maxTokens: applied.maxTokens }),
      }),
      run: (effort, maxTokens) => streamDshTurn(ctx, {
        messages: req.messages.map(toDshMessage),
        ...(req.system === undefined ? {} : { system: req.system }),
        ...(effort === undefined ? {} : { effort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(req.tools === undefined ? {} : { tools: req.tools.map(toDshTool) }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      }),
      effort: translateEffort(req.effort),
    })
    return { text: r.text, toolCalls: r.toolCalls, ...(r.usage ? { usage: r.usage } : {}) }
  }
}

/** 端口中立的一轮对话消息 → dsh 消息（user / assistant / tool-result）。 */
function toDshMessage(t: LlmLoopTurn): Message {
  if (t.role === 'user') return userTurn(t.text)
  if (t.role === 'assistant') {
    return createAssistantMessage({
      source: { provider: llmCfg.provider, model: llmCfg.model },
      content: [
        ...(t.text ? [{ type: 'text' as const, text: t.text }] : []),
        ...(t.toolCalls ?? []).map(c => ({
          type: 'tool-call' as const, id: c.id as ToolCallId, name: c.name, arguments: c.arguments,
        })),
      ],
    })
  }
  return createToolResultMessage({
    callId: t.callId as ToolCallId,
    content: [{ type: 'text', text: t.text }],
    isError: t.isError === true,
  })
}

/** 端口工具规格 → dsh ToolSchema（JSON Schema 直通）。 */
function toDshTool(t: { name: string; description: string; parameters: Record<string, unknown> }): ToolSchema {
  return { name: t.name, description: t.description, parameters: t.parameters }
}

function userTurn(text: string): Message {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

/** 语义档 → 部署档（翻译只发生在适配器）。 */
function translateEffort(effort?: LlmEffort): 'off' | 'low' | undefined {
  return effort === 'fast' ? llmCfg.fastEffort
    : effort === 'deep' ? llmCfg.deepEffort
      : undefined
}

/** llmComplete 的单次流式执行；effort 非空时显式指定思考档。
 * 空闲超时：每收到一个 chunk 重置计时，LLM_IDLE_TIMEOUT_MS 内无新输出即 abort（#118）。
 * 返回 truncated 标记（finish reason = max-tokens）、真实结束原因、思维内容与 token
 * 计量（含缓存/总，#330），截断重试由 callWithCapture 处理。 */
export async function llmStreamOnce(ctx: Context, prompt: string, system?: string, effort?: 'off' | 'low', maxTokens?: number, temperature?: number): Promise<StreamTurnResult> {
  return streamDshTurn(ctx, {
    messages: [userTurn(prompt)],
    ...(system === undefined ? {} : { system }),
    ...(effort === undefined ? {} : { effort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
  })
}

/** 一次流式尝试的结果（补全与工具回路同用）：文本、思维内容、工具调用（含 id）、
 * 截断标记、真实结束原因与 token 计量。 */
interface StreamTurnResult {
  text: string
  reasoning?: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  truncated: boolean
  finish?: string
  usage?: LlmTokenUsage
}

/** 一次 dsh llm 流式请求的共用执行体（补全与工具回路同用）：收集 text-delta、
 * reasoning-delta 与 block-end 的工具调用块；终止块 aborted/error 即抛错（空闲超时/
 * 取消/稳定错误码），**抛错前把当次累积的部分响应挂在 error.response 上**——捕获
 * 侧取它入档，失败尝试的现场不丢。usage chunk（finish 前发出）收进返回值，投影成
 * 端口中立 LlmTokenUsage（缓存与总 token 恢复随行，#330）。 */
async function streamDshTurn(ctx: Context, req: {
  messages: Message[]
  system?: string
  effort?: 'off' | 'low'
  maxTokens?: number
  tools?: ToolSchema[]
  /** 采样温度（#219）：直通 provider；缺省不传 = 宿主默认。 */
  temperature?: number
}): Promise<StreamTurnResult> {
  const msg = req.messages
  let text = ''
  let reasoning = ''
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let truncated = false
  let finish: string | undefined
  let usage: TokenUsage | undefined
  let timedOut = false
  const controller = new AbortController()
  let idle: ReturnType<typeof setTimeout> | undefined
  const armIdle = () => {
    clearTimeout(idle)
    idle = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, LLM_IDLE_TIMEOUT_MS)
  }
  /** 抛错前固化当次累积的部分响应（捕获侧入档失败尝试的现场）。 */
  const die = (e: Error): never => {
    ;(e as Error & { response?: CallResponseRecord }).response = responseOf(
      text.trim(), reasoning || undefined, toolCalls, finish, usage ? toPortUsage(usage) : undefined)
    throw e
  }
  armIdle()
  try {
    const stream = ctx.llm.stream({
      provider: llmCfg.provider, model: llmCfg.model, messages: msg,
      ...req.system === undefined ? {} : { system: req.system },
      ...req.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(req.effort) },
      ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
      ...(req.tools === undefined ? {} : { tools: req.tools }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      armIdle()
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') finish = chunk.reason.kind
      if (chunk.type === 'finish' && (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error')) {
        if (chunk.reason.kind === 'aborted') {
          die(new Error(timedOut
            ? `模型输出空闲超时（${Math.round(LLM_IDLE_TIMEOUT_MS / 1000)}s 无新输出），已中止本次调用`
            : '模型调用被取消'))
        }
        // failure.code 是稳定错误码（NO_ADAPTER/MISSING_CREDENTIAL/AUTH/RATE_LIMIT/...），一眼定位配置问题
        const f = chunk.reason.failure
        const status = f.status ? `/${f.status}` : ''
        const e: Error & { code?: string } = new Error(`模型调用失败[${f.code}${status}]（provider=${llmCfg.provider} model=${llmCfg.model}）：${String(f.message)}`)
        e.code = f.code
        die(e)
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') truncated = true
    }
  } catch (err) {
    clearTimeout(idle)
    die(err instanceof Error ? err : new Error(String(err)))
  }
  clearTimeout(idle)
  if (!text.trim() && !toolCalls.length) die(new Error('模型没有返回内容'))
  return {
    text: text.trim(),
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    truncated,
    ...(finish !== undefined ? { finish } : {}),
    ...(usage ? { usage: toPortUsage(usage) } : {}),
  }
}

/** dsh TokenUsage → 端口中立投影（#213 三值直通；#330 起缓存与总 token 恢复随行——
 * 缺省不造字段，路由不上报时不写 undefined）。 */
function toPortUsage(u: TokenUsage): LlmTokenUsage {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
    ...(u.totalTokens !== undefined ? { totalTokens: u.totalTokens } : {}),
    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
    ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
  }
}
