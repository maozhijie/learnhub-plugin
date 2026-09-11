/**
 * 宿主→引擎 LLM 端口（#137 补全缝、#162 工具回路缝）。
 *
 * 引擎侧只依赖这里的纯类型端口：运行时由宿主注入真实现（dsh llm 流式适配，含空闲
 * 超时/截断重试/思考档降级，收口在 host/llm.ts 唯一适配文件），测试注入假实现（固定
 * 回放、脚本化应答）——金样本回放链路从此不依赖真实模型即可确定性跑通。
 *
 * opts.effort 是语义档，不是宿主推理档原值：'fast' = 机械批量调用（出卡/自注反馈），
 * 'deep' = 值得多思考一轮的高难调用（大纲/修复轮/回执评审）。档位只在任务级决定
 * （P4 纪律），沿缝贯通、注入侧可观测；翻译成部署的 fastEffort/deepEffort 只发生
 * 在宿主适配器。不传 effort = 部署默认档（判卷/出题等既有默认路径）。
 */

/** 语义思考档。 */
export type LlmEffort = 'fast' | 'deep'

/** 补全缝：prompt 必带；system 可选（人设/判卷约束）；opts.effort 语义档。 */
export type LlmComplete = (
  prompt: string,
  system?: string,
  opts?: { effort?: LlmEffort },
) => Promise<string>

// ---- 工具回路端口（#162 / ADR-0041 双模式的回路半）：端口中立形态，适配器翻译成
// 宿主 llm.stream 的原生 function calling；端口类型零导入、零 dsh 词汇。 ----

/** 工具规格（JSON Schema 直通 provider tools 字段）。 */
export interface LlmToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 模型请求的一次工具调用（arguments 是模型产出的原始 JSON 串）。 */
export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

/** 工具回路的一轮对话消息（引擎侧回路历史的唯一形态）。 */
export type LlmLoopTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; callId: string; text: string; isError?: boolean }

/** 工具回路缝：一次流式请求（整段回路历史 + 可选工具白名单），返回助手轮
 * （文本 + 工具调用）。空闲超时/截断重试/档位降级与补全缝同一套适配器机械。 */
export type LlmStream = (req: {
  messages: LlmLoopTurn[]
  system?: string
  effort?: LlmEffort
  tools?: LlmToolSpec[]
}) => Promise<{ text: string; toolCalls: LlmToolCall[] }>
