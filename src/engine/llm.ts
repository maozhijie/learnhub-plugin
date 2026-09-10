/**
 * 宿主→引擎 LLM 补全注入缝（#137）。
 *
 * 引擎侧的生成/组装函数只依赖 LlmComplete：运行时由宿主注入真实现（dsh llm 流式
 * 适配，含空闲超时/截断重试/思考档降级），测试注入假实现（固定回放、脚本化应答）
 * ——金样本回放链路从此不依赖真实模型即可确定性跑通。
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
