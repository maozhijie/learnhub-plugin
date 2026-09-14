/**
 * 内容管线提示词文本（#237 / ADR-0075 自 `content-subsystem.ts`、`note-source.ts`、
 * `generation-jobs.ts` 迁出）：判卷（题面/作答/评分要点拼装 + 解析失败重问）、出生打标
 * 补标、大纲修复回灌三类**指令散文**的单源。
 *
 * **为什么搬出来**：这三处原本是长篇散文写在代码表达式里（模板字面量、`[…].join('\n')`），
 * 散文与代码共用一套语法——散文里出现反引号或 `${` 就把代码改坏，而「读不出这里插的是
 * 语法还是字面量」正是 AI 编辑改提示词的实测代价（ADR-0075 §1）。搬成惰性字符串后散文
 * 对代码零语法风险，变量面收窄成一处可对账的 `{{var}}` 占位符表，取值在调用点由
 * `prompt-render.ts::render` 完成（缺变量与渲染后残留占位符都抛，见该模块头注）。
 *
 * 本模块**零 import**（同 `templates.ts` 形态）：纯文本面，任何一层都能引，且文本不得
 * 反过来依赖渲染器——渲染器是调用点的事。
 *
 * **逐字节不动**：搬迁是纯位移，渲染结果与搬迁前的原表达式一字不差；判卷重问与大纲回灌
 * 的措辞是生产行为（`REPAIR_MECHANISMS` 的见证串盯着它们），改一个标点就是一次行为变更，
 * 不在本票范围。
 */

/** 反思题（reflection）判卷提示词：题面 + 学习者作答 + 评分要点三段的拼装骨架。 */
export const GRADING_REFLECTION_PROMPT = `Exercise prompt:\n{{question}}\n\nLearner's answer:\n{{learnerAnswer}}\n\nGrading rubric (评分要点):\n{{rubric}}`

/** 开放题（课时综合应用）判卷提示词：题面 + 学习者作答（参考要点走下一段）。 */
export const GRADING_OPEN_QUESTION_PROMPT = `Lesson question (综合应用):\n{{question}}\n\nLearner's answer:\n{{learnerAnswer}}`

/** 开放题参考要点附段：仅原题带参考要点时追加（含段前空行，缺席则整段不出现）。 */
export const GRADING_OPEN_QUESTION_REFERENCE = `\n\nReference points (参考要点):\n{{referencePoints}}`

/** 判卷解析失败后的重问消息（恰一次）：前接原提示词，纠偏「只输出 JSON 对象」。 */
export const GRADING_REASK_PROMPT = `{{prompt}}\n\n[重判要求] 上一次输出无法解析为判卷结果。这一次只输出一个 JSON 对象（shape 见系统提示），不要任何其他文字、解释或代码围栏。`

/** 出生打标补标（#148）的一次性提示词骨架：缺口题序 + 清单由调用点拼成两个值。 */
export const INVOKES_BACKFILL_PROMPT = `## 任务：为下列题目各补一枚 invokes 概念标注

从概念清单中为每道题选**恰一枚**本题最主要考察的概念，名字精确照抄清单（一字不差）。只输出一个 YAML 映射（不要代码围栏、不要任何解释），键为题目序号、值为概念名：

1: 概念名
2: 概念名

## 概念清单

{{conceptList}}

## 题目（按序号）

{{questionList}}`

/** 大纲节数护栏（OUTLINE_BUDGET）失败的恰一轮回灌反馈段。 */
export const OUTLINE_BUDGET_REPAIR_FEEDBACK = `## 大纲护栏反馈\n\n上一次大纲未过护栏（节数与本节点复杂度不匹配）：\n{{errorMessage}}\n\n请按上下文包 §9 复杂度档案的节段数区间重新规划。`

/** 大纲解析/形状（OUTLINE_SHAPE、MODEL_YAML）失败的恰一轮回灌反馈段。 */
export const OUTLINE_PARSE_REPAIR_FEEDBACK = `## 解析反馈\n\n上一次大纲输出未通过解析/结构校验：\n{{errorMessage}}\n\n请重新输出完整 YAML 文档，修正全部问题；不要输出解释。`
