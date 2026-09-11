/**
 * 宿主 LLM 适配层（#152 刀 12 自 src/index.ts 抽出；#162 起是双模式缝的唯一适配文件）：
 * 部署配置 → 语义档翻译 → dsh llm 流式调用（空闲超时/截断重试/档位降级）
 * + 引擎侧 LlmComplete / LlmStream 端口的真实现适配。
 *
 * 与路由/队列/工具面无关的纯技术层：本文件只依赖 cordis Context 与 dsh-llm，
 * 不碰 engine 与宿主状态。ADR-0044：`@deepseek-ai/dsh-llm` / `cordis` 的引擎侧
 * 引用点不增加——dsh 耦合 100% 收在本文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createUserMessage,
  createToolResultMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { Message, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { LlmComplete, LlmEffort, LlmLoopTurn, LlmStream } from '../engine/index.ts'

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
 * page = 面板页签（learn/graph/bank/stats/lab/generate/practice/projects/global）；
 * prompt = 可直接粘进 dsh 会话的示例指令。 */

export const LLM_IDLE_TIMEOUT_MS = 120_000
/** max-tokens 截断重试（#116）的显式输出上限：截断是断尾 JSON/YAML 的常见诱因，
 * 原题提高输出上限重试一次（与引擎侧判卷重问相互独立、各限一次）。 */
export const LLM_TRUNCATION_RETRY_TOKENS = 8192

/** dsh llm 一次性调用：收集 text-delta；终止块非 success 即抛错。
 * opts.effort 指定思考档（如 'off' 快速路径）；路由不支持该档位时
 * （UNSUPPORTED_REASONING_EFFORT）自动降级为部署默认重试一次。 */
export async function llmComplete(ctx: Context, prompt: string, system?: string, opts?: { effort?: 'off' | 'low' }): Promise<string> {
  return streamWithPolicies(
    (effort, maxTokens) => streamDshTurn(ctx, {
      messages: [userTurn(prompt)],
      ...(system === undefined ? {} : { system }),
      ...(effort === undefined ? {} : { effort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }),
    opts?.effort,
  ).then(r => r.text)
}

/** 宿主→引擎 LLM 补全注入缝的真实现适配器（#137）：语义档 fast/deep 翻译成部署的
 * fastEffort/deepEffort（不传档 = 部署默认），空闲超时/截断重试/档位降级都在底层
 * llmComplete。引擎侧生成/组装函数一律只认 LlmComplete 缝型——测试注入假实现
 * （固定回放/脚本化应答）即可不依赖真实模型确定性跑通金样本回放。 */
export function llmSeam(ctx: Context): LlmComplete {
  return (prompt, system, opts) => llmComplete(ctx, prompt, system,
    opts?.effort === 'fast' ? { effort: llmCfg.fastEffort }
      : opts?.effort === 'deep' ? { effort: llmCfg.deepEffort }
        : undefined)
}

/** 宿主→引擎工具回路端口（LlmStream）的适配器（#162 / ADR-0041 回路半）：端口中立
 * 的回路历史翻译成 dsh 消息（user/assistant/tool-result），工具白名单直通 provider
 * function calling；语义档翻译、空闲超时、截断重试、档位降级与补全缝同一套机械。
 * 消费方 = engine/agent.ts 的 agentLoop()（应用层端口消费者），测试注入假端口即可
 * 脚本化应答——回路逻辑不依赖真实模型确定性可测。 */
export function llmStreamSeam(ctx: Context): LlmStream {
  return async req => streamWithPolicies(
    (effort, maxTokens) => streamDshTurn(ctx, {
      messages: req.messages.map(toDshMessage),
      ...(req.system === undefined ? {} : { system: req.system }),
      ...(effort === undefined ? {} : { effort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(req.tools === undefined ? {} : { tools: req.tools.map(toDshTool) }),
    }),
    translateEffort(req.effort),
  ).then(r => ({ text: r.text, toolCalls: r.toolCalls }))
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

/** 共享调用策略（#137/#162 同一套机械）：max-tokens 截断提高输出上限原题重试一次；
 * 路由不支持该档位（UNSUPPORTED_REASONING_EFFORT）自动降级为部署默认重试一次。 */
async function streamWithPolicies<R extends { truncated: boolean }>(
  run: (effort?: 'off' | 'low', maxTokens?: number) => Promise<R>,
  effort?: 'off' | 'low',
): Promise<R> {
  const attempt = async (effort?: 'off' | 'low', maxTokens?: number): Promise<R> => {
    const r = await run(effort, maxTokens)
    if (!r.truncated) return r
    console.warn(`[learnhub] 模型输出被 max-tokens 截断（model=${llmCfg.model}），提高输出上限原题重试一次`)
    return run(effort, LLM_TRUNCATION_RETRY_TOKENS)
  }
  if (effort === undefined) return attempt()
  try {
    return await attempt(effort)
  } catch (err) {
    if (!(err instanceof Error && (err as { code?: string }).code === 'UNSUPPORTED_REASONING_EFFORT')) throw err
    return attempt()
  }
}

/** llmComplete 的单次流式执行；effort 非空时显式指定思考档。
 * 空闲超时：每收到一个 chunk 重置计时，LLM_IDLE_TIMEOUT_MS 内无新输出即 abort（#118）。
 * 返回 truncated 标记（finish reason = max-tokens），截断重试由 llmComplete 处理。 */
export async function llmStreamOnce(ctx: Context, prompt: string, system?: string, effort?: 'off' | 'low', maxTokens?: number): Promise<{ text: string; truncated: boolean }> {
  const r = await streamDshTurn(ctx, {
    messages: [userTurn(prompt)],
    ...(system === undefined ? {} : { system }),
    ...(effort === undefined ? {} : { effort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  })
  return { text: r.text, truncated: r.truncated }
}

/** 一次 dsh llm 流式请求的共用执行体（补全与工具回路同用）：收集 text-delta 与
 * block-end 的工具调用块；终止块 aborted/error 即抛错（空闲超时/取消/稳定错误码）。 */
async function streamDshTurn(ctx: Context, req: {
  messages: Message[]
  system?: string
  effort?: 'off' | 'low'
  maxTokens?: number
  tools?: ToolSchema[]
}): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; truncated: boolean }> {
  const msg = req.messages
  let text = ''
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let truncated = false
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
  armIdle()
  try {
    const stream = ctx.llm.stream({
      provider: llmCfg.provider, model: llmCfg.model, messages: msg,
      ...req.system === undefined ? {} : { system: req.system },
      ...req.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(req.effort) },
      ...req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens },
      ...req.tools === undefined ? {} : { tools: req.tools },
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      armIdle()
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCalls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      if (chunk.type === 'finish' && (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error')) {
        if (chunk.reason.kind === 'aborted') {
          throw new Error(timedOut
            ? `模型输出空闲超时（${Math.round(LLM_IDLE_TIMEOUT_MS / 1000)}s 无新输出），已中止本次调用`
            : '模型调用被取消')
        }
        // failure.code 是稳定错误码（NO_ADAPTER/MISSING_CREDENTIAL/AUTH/RATE_LIMIT/...），一眼定位配置问题
        const f = chunk.reason.failure
        const status = f.status ? `/${f.status}` : ''
        const e: Error & { code?: string } = new Error(`模型调用失败[${f.code}${status}]（provider=${llmCfg.provider} model=${llmCfg.model}）：${String(f.message)}`)
        e.code = f.code
        throw e
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') truncated = true
    }
  } finally {
    clearTimeout(idle)
  }
  if (!text.trim() && !toolCalls.length) throw new Error('模型没有返回内容')
  return { text: text.trim(), toolCalls, truncated }
}
