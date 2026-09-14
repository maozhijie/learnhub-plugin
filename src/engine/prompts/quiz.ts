/**
 * 出题族提示词常量（#237 / ADR-0075）：出题线与题库线的**模型面向指令散文**单源。
 *
 * 四条来源（原散在拼装函数里，是 `['…', '…'].join('\n')` 或裸模板字面量）：
 * ① 出题第二意见门的独立解题提示词与修复轮回灌（`question-audit.ts`）；
 * ② 题库已有题注入段（`question-dedup.ts`，防相似 #119）；
 * ③ 申诉复核的用户提示词与重判后缀（`question-bank.ts`）；
 * ④ 误解先验注入段（`question-bank.ts`，误解目录消费 #147）。
 *
 * 文本是**惰性字符串**：不含 `${}` 插值，变量面收窄成 `{{name}}` 占位符，取值在调用点由
 * `prompt-render.ts::render()` 完成（缺变量与残留占位符都抛）。为什么不用 TS 模板字面量：
 * 这些散文里含缩进的 YAML/JSON 示例与反引号，与代码共用一套语法时，改散文的人（尤其 AI
 * 编辑）读不出「插的是语法还是字面量」——惰性串让散文对代码零语法风险，并把「这条提示词
 * 要哪些变量」变成一处可对账的清单（ADR-0075 §1）。
 *
 * 本文件是**纯文本面**（零 import，同 `templates.ts` 的先例）：常量原样就是提示词文本，
 * 不含渲染逻辑——渲染住 `prompt-render.ts`，消费方（出题族各文件）自己取值。
 *
 * **注意**：本文件的文本均不得改写成代码插值；改一条文本 = 改生产行为，按
 * `docs/agents/architecture.md` §8 走「登记 + 过门」两步。
 */

/** 第二意见门的独立解题提示词（#223）：只看题面与选项，零答案键零解析；answer 形态按题型给定。 */
export const QUIZ_SOLVER_PROMPT = `# 独立解题（第二意见抽查）

只看下面的题目，把它当作考生独立解一遍——给出你自己的解答，不要臆测标准答案的写法。

## 题目

题型：{{kindLabel}}
题干：{{stem}}{{options}}

## 输出

只输出一个 JSON 对象（不要代码围栏、不要任何解释）：
{"answer": <你的答案>, "steps": "<关键步骤一两句>"}`

/** 第二意见对账不一致的回灌修复轮骨架（#223）：散文 + 待修题目清单（`{{items}}`）+ 输出契约。
 * 首行的死因标题是本机制在语料与日志里的识别面。`REPAIR_MECHANISMS.auditRepairOncePerQuestion`
 * 的见证串随本票（#237 / ADR-0075）换成**调用点锚点**（`const repairPrompt = render(QUIZ_AUDIT_REPAIR_PROMPT`
 * 在 `question-audit.ts`）——**改这个常量名要同步那条登记**；只改文本则走 §8 的登记与人审。 */
export const QUIZ_AUDIT_REPAIR_PROMPT = `# 出题修复（第二意见抽查发现答案键不一致）

下列题目经「只看题面独立解题」抽查，独立解与答案键不一致。请逐题重新审视：先独立解题，再核对答案键、解析与题面三者——键错就改键（与解析一致），解析与键矛盾就改解析，题面含糊就改题面让它锁定唯一答案。只修列出的题，不要新出题、不要改动其它字段语义。

## 待修题目

{{items}}

## 输出

只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：
questions:
  - <修正后的完整题目（字段与原题同构，按原题顺序，一道不多不少）>`

/** 修复清单里的一道待修题（`QUIZ_AUDIT_REPAIR_PROMPT` 的 `{{items}}` 单元）：独立解、存储键
 * 与题目 YAML 原文三面并列，供模型对账；`{{solverSteps}}` 缺席时为空串（模型没给关键步骤）。 */
export const QUIZ_AUDIT_REPAIR_ITEM = `### 题 {{index}}

- 独立解题的答案：{{solverAnswer}}{{solverSteps}}
- 存储的答案键：{{storedAnswer}}

题目 YAML：

{{yaml}}`

/** 题库已有题注入段（#119 防相似）：只题面/题型/难度、不含答案；`{{lines}}` = 逐题一行清单。
 * 无已有题时调用方原样返回空串——整段缺席（不注入空标题）。 */
export const EXISTING_STEMS_BLOCK = `

## 题库已有题目（禁止重复出题）

下面题目已在题库中，与它们重复或高度相似的题一律不要出：
{{lines}}`

/** 申诉复核的用户提示词（两段式：先独立解题再对账，#223 继承判卷族先例）：题目、存储键/解析、
 * 学习者作答与对应节正文四段材料由调用点作为值注入；`{{sectionContext}}` 是节正文取材分支
 * （「来自节…」或「整课节选」的定位声明 + 正文——分支与它标注的材料同处一值）。 */
export const DISPUTE_REVIEW_PROMPT = `# 复核一道练习题的申诉

学习者作答被判错并申诉「题目错了」。请严格按两阶段复核：
1. **独立解题**：只看题面自己完整解一遍（此阶段忽略下面给出的存储答案键），写出过程与你的答案；
2. **对账**：把你的独立结果与存储答案键/解析、以及学习者作答逐一比对；
3. 按系统提示的三态规则给出裁定。

## 题目
{{stem}}{{options}}

存储的答案键：{{storedAnswer}}{{explanation}}

## 学习者的作答
{{learnerAnswer}}

## 对应节正文（超纲判定依据）
{{sectionContext}}`

/** 申诉复核的重判后缀（解析失败自动重问一次）：拼在原提示词之后，含分隔用的前导空行。
 * `[重判要求]` 是这一步在语料与日志里的识别面。`REPAIR_MECHANISMS.disputeReaskOnce` 的见证串
 * 随本票（#237 / ADR-0075）换成**调用点锚点**（`render(DISPUTE_REASK_SUFFIX` 在 `question-bank.ts`）
 * ——**改这个常量名要同步那条登记**；只改文本则走 §8 的登记与人审。 */
export const DISPUTE_REASK_SUFFIX = `

[重判要求] 上一次输出无法解析为复核结果。这一次只输出一个 JSON 对象（shape 见系统提示），不要任何其他文字、解释或代码围栏。`

/** 误解先验注入段（#147 误解目录消费；无误解时调用方返回空串，Missing 合法空态）：
 * `{{use}}` = 本段的消费面声明（干扰项材料等），`{{items}}` = 「- 概念：错误模型」逐行清单。 */
export const MISCONCEPTION_PRIOR_BLOCK = `

## 误解先验（{{use}}）

- 本节点登记在册的误解先验（概念：错误模型）：
{{items}}`

/** 单节强绑的节标注指令（定向补题：整批都属于该节）：`section` 字段取值面锁死到一节。 */
export const QUIZ_SECTION_LISTING_SINGLE = `

## 节标注清单

本批全部题目都属于这一节：section 字段必须精确写「{{sectionId}}」（节标题：{{sectionTitle}}），不要写「通用」或其他节。`

/** 跨节出题的节标注指令（整节点出题）：`{{lines}}` = 「- <节 id> ｜ <节标题>」逐行清单。 */
export const QUIZ_SECTION_LISTING_MULTI = `

## 节标注清单

section 字段必须精确取自下列节 id（跨节综合题写「通用」）：
{{lines}}`

/** 逐节出题的节标注指令：与 `QUIZ_SECTION_LISTING_SINGLE` 同义，但不带节标题——该批的节正文
 * 以一级标题跟在材料末尾，标题已在那里出现过一次。 */
export const QUIZ_SECTION_LISTING_SINGLE_BATCH = `

## 节标注清单

section 字段必须精确写「{{sectionId}}」（本批全部题目都属于这一节）。`

/** 学习者意见注入段（「优先遵循」口径）：`{{instruction}}` 由调用点 trim 后注入。 */
export const QUIZ_INSTRUCTION_BLOCK = `

## 生成指令（学习者意见，优先遵循）

{{instruction}}`

/** 题量与难度锚定的段骨架（两处出题调用共用）：`{{count}}` 道 + `{{difficultyAnchor}}`。
 * 骨架之后紧接着误解/概念注入段，故不以换行收尾。 */
export const QUIZ_COUNT_AND_ANCHOR = `

## 题目数量

{{count}} 道

## 难度锚定

{{difficultyAnchor}}`

/** 整节点出题的难度锚（按节点复杂度档三选一）：d1–d3 的递进口径，收尾难题是否放行是分档判据。 */
export const QUIZ_NODE_ANCHOR_LOW = '本节点为低复杂度：题目难度集中在 1-2，不出 difficulty: 3 的收尾难题。'
export const QUIZ_NODE_ANCHOR_HIGH = '本节点为高复杂度：收尾可出 1-2 道 difficulty: 3 的综合/易错题。'
export const QUIZ_NODE_ANCHOR_MID = '本节点为中复杂度：难度递进到 2，收尾至多 1 道 difficulty: 3。'

/** 逐节出题的难度锚（按节段难度档三选一；档位由 `sectionTierLabel` 按清单/节位置推导）。 */
export const QUIZ_SECTION_ANCHOR_LOW = '本节难度档：低——题目难度 1 为主（至多 1 道 2），不出 difficulty: 3。'
export const QUIZ_SECTION_ANCHOR_HIGH = '本节难度档：高——允许 1-2 道 difficulty: 3 的易错/综合题。'
export const QUIZ_SECTION_ANCHOR_MID = '本节难度档：中——难度递进到 2 即可（收尾至多 1 道 difficulty: 3）。'
