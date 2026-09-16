/**
 * 提示词模板渲染（#237 / ADR-0075）：提示词文本是惰性字符串 + `{{变量}}` 占位符，取值在
 * 调用点由本函数完成。零依赖叶子（R5 同 io.ts、prompt-assembly.ts 形态：本模块不 import
 * 任何东西）——任何一层的提示词文件都能引它，不会形成环。
 *
 * **为什么不用 TS 模板字面量**：提示词是长篇散文，用 `${}` 拼装意味着散文与代码共用一套
 * 语法——散文里出现一个反引号或 `${` 就把代码改坏了。这条对 AI 编辑尤其致命：它读不出
 * 「我这里插的是语法还是字面量」。惰性字符串让散文对代码零语法风险，变量面收窄成一处
 * 可对账的占位符表。
 *
 * **严格是刻意的**（两类都不静默）：
 *   ① 模板要的变量没传 → 抛。否则模型看到的是 `{{targetNode}}` 原文。
 *   ② 替换进去的值自身带 `{{目标名}}` 形态 → 抛。占位符的失败模式就是「静默把原文喂给
 *      模型」，而模型不会报错、只会照着生成——这类缺陷只能靠渲染期抛错暴露。
 * 多余变量不抛（模板没用到就是没用到，传超集无害）；「传错名」由 ① 兜住。
 *
 * **占位符只认标识符形态**（`{{targetNode}}`），这是刻意收窄的口径：`{{…}}` 同时是
 * **挖空重述的卡面标记**（`learner-cards.ts` 的 cloze 语法，`{{答案}}`／`{{…}}`），而
 * 学习者自写的卡面内容会作为**值**流进提示词。若把「任何 `{{…}}`」都判成残留，学习者
 * 写一个英文挖空（`{{mitosis}}`）就会让自注讲解当场抛错——那是数据，不是没填的占位符。
 * 收窄到标识符形态后，剩下的误报面只有「值里恰好带 `{{英文标识符}}`」这一种，它本身
 * 就是真歧义（模型读到也分不清），抛错是诚实反应。
 */

/** 占位符形态：`{{name}}`，名字限标识符字符集——见头注「只认标识符形态」的收窄理由。 */
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

/** 渲染变量表：值只收字符串与数字（提示词只吃文本，别的类型都是调用点写错了）。 */
export type PromptVars = Record<string, string | number>

/** 渲染：`{{name}}` → `vars.name`。缺失与残留都抛，理由见模块头注。 */
export function render(template: string, vars: PromptVars): string {
  const out = template.replace(PLACEHOLDER, (_whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`[prompts] 缺变量 {{${name}}}：模板要它但没传（已传：${Object.keys(vars).join('、') || '无'}）`)
    }
    const v = vars[name]
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new Error(`[prompts] 变量 {{${name}}} 的值不是字符串或数字（收到 ${v === null ? 'null' : typeof v}）`)
    }
    return String(v)
  })
  const leftover = [...new Set([...out.matchAll(PLACEHOLDER)].map(m => m[1]))]
  if (leftover.length) {
    throw new Error(
      `[prompts] 渲染后残留占位符 ${leftover.map(n => `{{${n}}}`).join('、')}：`
      + '注入值自身带着 {{…}}——模型会看到这段原文，先把它清掉再注入',
    )
  }
  return out
}
