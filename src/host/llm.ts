/**
 * 宿主 LLM 适配层（#152 刀 12 自 src/index.ts 抽出）：部署配置 → 语义档翻译 →
 * dsh llm 流式调用（空闲超时/截断重试/档位降级）+ 引擎侧 LlmComplete 缝实现。
 *
 * 与路由/队列/工具面无关的纯技术层：本文件只依赖 cordis Context 与 dsh-llm，
 * 不碰 engine 与宿主状态。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmComplete, LlmEffort } from '../engine/index.ts'

const llmCfg = {
  provider: 'deepseek-official', model: 'deepseek-v4-flash',
  fastEffort: 'off' as 'off' | 'low',
  deepEffort: 'low' as 'off' | 'low',
}

/** P4 分层 effort：机械调用统一走 fast 档；高复杂度节点的大纲/修复轮升 deep 档。
 * 调用点只声明语义档（注入侧可观测），翻译成部署的 fastEffort/deepEffort 收口在 llmSeam（#137）。
 * 名字留在 effort 词族——「档位」在 CONTEXT.md 语言表里专指复杂度档位（contentTierOf），不混用。 */
function contentEffort(highTier: boolean): LlmEffort {
  return highTier ? 'deep' : 'fast'
}

/** 当前 LLM 配置视图（模型透明，#? 与 /status、learnhub_status 一同带出，面板只读展示；
 * 切换模型 = 编辑 profile patch（cordis.patch.yml 的 dsh-learnhub 行 provider/model/
 * fastEffort/deepEffort）后重启宿主——插件不写宿主机器级配置）。 */
function llmView() {
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

const LLM_IDLE_TIMEOUT_MS = 120_000
/** max-tokens 截断重试（#116）的显式输出上限：截断是断尾 JSON/YAML 的常见诱因，
 * 原题提高输出上限重试一次（与引擎侧判卷重问相互独立、各限一次）。 */
const LLM_TRUNCATION_RETRY_TOKENS = 8192

/** dsh llm 一次性调用：收集 text-delta；终止块非 success 即抛错。
 * opts.effort 指定思考档（如 'off' 快速路径）；路由不支持该档位时
 * （UNSUPPORTED_REASONING_EFFORT）自动降级为部署默认重试一次。 */
async function llmComplete(ctx: Context, prompt: string, system?: string, opts?: { effort?: 'off' | 'low' }): Promise<string> {
  const attempt = async (effort?: 'off' | 'low', maxTokens?: number): Promise<string> => {
    const r = await llmStreamOnce(ctx, prompt, system, effort, maxTokens)
    if (!r.truncated) return r.text
    console.warn(`[learnhub] 模型输出被 max-tokens 截断（model=${llmCfg.model}），提高输出上限原题重试一次`)
    return (await llmStreamOnce(ctx, prompt, system, effort, LLM_TRUNCATION_RETRY_TOKENS)).text
  }
  if (opts?.effort === undefined) return attempt()
  try {
    return await attempt(opts.effort)
  } catch (err) {
    if (!(err instanceof Error && (err as { code?: string }).code === 'UNSUPPORTED_REASONING_EFFORT')) throw err
    return attempt()
  }
}

/** 宿主→引擎 LLM 补全注入缝的真实现适配器（#137）：语义档 fast/deep 翻译成部署的
 * fastEffort/deepEffort（不传档 = 部署默认），空闲超时/截断重试/档位降级都在底层
 * llmComplete。引擎侧生成/组装函数一律只认 LlmComplete 缝型——测试注入假实现
 * （固定回放/脚本化应答）即可不依赖真实模型确定性跑通金样本回放。 */
function llmSeam(ctx: Context): LlmComplete {
  return (prompt, system, opts) => llmComplete(ctx, prompt, system,
    opts?.effort === 'fast' ? { effort: llmCfg.fastEffort }
      : opts?.effort === 'deep' ? { effort: llmCfg.deepEffort }
        : undefined)
}

/** llmComplete 的单次流式执行；effort 非空时显式指定思考档。
 * 空闲超时：每收到一个 chunk 重置计时，LLM_IDLE_TIMEOUT_MS 内无新输出即 abort（#118）。
 * 返回 truncated 标记（finish reason = max-tokens），截断重试由 llmComplete 处理。 */
async function llmStreamOnce(ctx: Context, prompt: string, system?: string, effort?: 'off' | 'low', maxTokens?: number): Promise<{ text: string; truncated: boolean }> {
  const msg = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: prompt }],
  })
  let text = ''
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
      provider: llmCfg.provider, model: llmCfg.model, messages: [msg],
      ...system === undefined ? {} : { system },
      ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      ...maxTokens === undefined ? {} : { maxTokens },
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      armIdle()
      if (chunk.type === 'text-delta') text += chunk.text
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
  if (!text.trim()) throw new Error('模型没有返回内容')
  return { text: text.trim(), truncated }
}
