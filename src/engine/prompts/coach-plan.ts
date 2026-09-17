/**
 * 教练思路官站的模型面散文（#311）：`coach/growth-subsystem.ts` 思路官回合的
 * 「上次裁决摘要」块（显式重裁族材料，「包骨架与交接契约之外」的那一段）。
 *
 * 思路官站的主散文面已住两处：站模板（`prompts/templates.ts` 的「思路官回合／思路官重裁」）、
 * 外部注入块与计划门反馈块（`prompts/projects.ts`）。本文件补齐余下的材料块。
 *
 * 文本是惰性字符串 + `{{变量}}` 占位符，取值由 `../infra/prompt-render.ts::render` 在调用点
 * 完成（缺变量与残留占位符都抛，详见 ADR-0075）。**本文件是模型可见散文，改动走章程 §8。**
 */

export const PLAN_SUMMARY_HEADING = '## 上次裁决摘要（上一次生长批的方向留痕——可沿用可推翻）'
export const PLAN_SUMMARY_OPERATOR = '- 算子：{{operator}}'
export const PLAN_SUMMARY_REASON = '- 理由：{{reason}}'
export const PLAN_SUMMARY_REASON_EMPTY = '（未留痕）'
export const PLAN_SUMMARY_PROPOSAL = '- 提案：#{{id}}（已应用）'
