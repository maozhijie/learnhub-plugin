/**
 * 提示词契约后置拼装（#218 / ADR-0065）：全部生成站的最终 prompt 都由「材料」+「输出
 * 契约段」构成，契约段置尾——契约与「只输出 X」硬指令落在最终 prompt 末段、离生成点
 * 最近（lost-in-middle 对策；回执评审把契约放进 system 提示词是全仓先例，#212 §四.1）。
 *
 * 零依赖叶子（R5 同 io.ts 形态：本模块不 import 任何东西）：content.ts（模板切分与整节
 * 修复轮）与 seed.ts（种子修复轮）都要用它，而 content.ts → seed.ts 已有边——切分逻辑
 * 必须住在一个两边都能引、又不会形成环的地方，否则两处各自实现一遍切分必然漂移。
 */

/** 契约段切分：模板末段 = 最后一个 `## 输出…` 一级标题到模板末尾，即该站「输出什么
 * 形态 + 只输出 X」的契约段；前段 = 角色/立场/设计原则/硬约束。模板无 `## 输出` 段时
 * contract 为空串（无可后置的契约段，如规范块拼装的独立提示词）。 */
export function splitContractSection(tpl: string): { head: string; contract: string } {
  const hits = [...tpl.matchAll(/^## 输出[^\n]*$/gm)]
  const last = hits[hits.length - 1]
  if (!last || last.index === undefined) return { head: tpl.trimEnd(), contract: '' }
  return { head: tpl.slice(0, last.index).trimEnd(), contract: tpl.slice(last.index).trimEnd() }
}

/** 契约后置拼装：材料（上下文包/正文/任务块/修复反馈）在前，输出契约段置尾。材料为空
 * 时只输出模板本体。全部生成站的拼装都经这里——新站漏走会把契约留在中段，文本锚门
 * （tests/output-contract.test.ts）对此对账。 */
export function withContractLast(tpl: string, materials: string): string {
  const { head, contract } = splitContractSection(tpl)
  const m = materials.trim()
  if (!contract) return m ? `${head}\n\n${m}\n` : `${head}\n`
  return m ? `${head}\n\n${m}\n\n---\n\n${contract}\n` : `${head}\n\n---\n\n${contract}\n`
}

/** 门错修复轮提示词（种子起草 / 目标反编译同款机械）：材料 + 回灌块（上次产出原文 + 逐条
 * 校验清单）在前，模板的输出契约段置尾——修复轮里模型最后读到的仍是「只输出 X」，校验
 * 清单不占契约的位置。`headline` 是这一族的死因标题（各站一句，含「重新输出完整 YAML」
 * 的要求）。两站共用本函数：此前各写一份同形模板串，改措辞要改两处。 */
export function repairRoundPrompt(
  tpl: string, materials: string, headline: string, previous: string, errors: string[],
): string {
  return withContractLast(
    tpl,
    `${materials.trimEnd()}\n\n${headline}\n\n上一次输出：\n\n${previous}\n\n校验清单：\n\n${errors.join('\n')}\n`,
  )
}
