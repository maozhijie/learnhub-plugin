/**
 * 出题第二意见门（#223 / ADR-0063）：出题生成时抽样让模型只看题面独立解题、与答案键
 * 确定性对账（申诉复核两段式的生成时复用），把键错题拦在学习者遭遇之前。
 *
 * - 抽样而非全量（逐题成本）：确定性等距抽样（不引随机数，测试全确定性），起步低
 *   （1/4）；高难度档（difficulty 3）恒入样 = 加权。
 * - 独立 solver 调用不携答案键与解析，逐客观题只答「答案 + 关键步骤」；开放/反思题
 *   排除（无确定性对账面）。
 * - 对账比较器 = evaluateAllo（判卷同款确定性比较：选择题字母归一、填空 NFKC 归一 +
 *   可接受答案数组白名单（同义写法不误拒）、numeric/tol 容差、排序配对逐位）——
 *   不一致 ≠ 键必错，误拒治理走题目量规（#221「键自洽」判据对表）与门红了先裁决。
 * - 不一致处置：该题拒收，拒收原因回灌修复轮（gateRepairRound 形态：恰一次，题目
 *   生成站 deep 档重产）；修复仍败则弃题，不阻塞整批。solver 输出不可解析 ≠ 键错
 *   ——保守放行（unresolved），审计失败不杀人。
 * - 消费语料/usage（#213）：solver 调用带独立站标签（独立解题）进语料；修复轮走
 *   题目生成站的 repair 形态（kind='repair'，站名由注入缝闭包钉住）。
 */

import { YAML } from './yaml.ts'
import { evaluateAllo, revealAnswer } from './grading.ts'
import type { AlloKind, AlloQuestion } from './grading.ts'
import type { LlmComplete } from './llm.ts'

/** 第二意见独立解题的语料站标签（host STATIONS.quizSolver 引门面同名常量对齐）。 */
export const QUIZ_SOLVER_STATION = '独立解题'

/** 抽样率缺省（起步低，#223）：宿主可经机器级 config quizAuditRate 覆盖。 */
export const DEFAULT_QUIZ_AUDIT_RATE = 0.25

/** 可独立解题对账的客观题型（reflection/open_question 无确定性比较面，排除）。 */
const AUDITABLE_KINDS: ReadonlySet<string> = new Set([
  'single_choice', 'true_false', 'fill_in_blank', 'multi_choice', 'numeric', 'ordering', 'matching',
])

const KIND_LABEL: Record<string, string> = {
  single_choice: '单选（answer 为选项字母）',
  multi_choice: '多选（answer 为正确选项字母数组，如 ["A","C"]）',
  true_false: '判断（answer 为 true 或 false）',
  fill_in_blank: '填空（answer 为你写出的术语/答案原文）',
  numeric: '数值（answer 为数值，支持 "3/4" 与 "25%" 写法）',
  ordering: '排序（answer 为正确顺序的项原文数组）',
  matching: '配对（answer 为与左列顺序一一对应的右项原文数组）',
}

/** 抽样率等配置（rate 缺省 = DEFAULT_QUIZ_AUDIT_RATE；≤0 = 关门）。 */
export interface SecondOpinionOptions {
  rate?: number
  isCancelled?: () => boolean
}

/** 门执行报告（抽样率与成本可见，#223 验收）。 */
export interface SecondOpinionReport {
  /** 本次生效的抽样率。 */
  rate: number
  /** 可对账的客观题数（reflection/open 之外）。 */
  eligible: number
  /** 抽样题数（含高难度加权恒入样）。 */
  sampled: number
  /** 首轮对账不一致数。 */
  inconsistent: number
  /** 修复轮改好（对账转一致）数。 */
  repaired: number
  /** 修复仍败弃题数（不阻塞整批）。 */
  discarded: number
  /** 解题输出不可判（保守放行）数。 */
  unresolved: number
  /** 独立解题调用数（首轮 + 修复后再审计；成本面）。 */
  solverCalls: number
}

export interface SecondOpinionResult {
  /** 对账后的题目清单（弃题移除、修复题替换）。 */
  items: Array<Record<string, unknown>>
  report: SecondOpinionReport
  /** 弃题的拒收条目（题目形态原样，供调用方并入 rejected 报告面）。 */
  rejected: Array<{ q: string; reason: string }>
}

/** 合并两份报告（逐节出题跨节聚合）。rate 取后者——两段同配率恒同值（门开一次一率）。 */
export function mergeSecondOpinionReports(a: SecondOpinionReport, b: SecondOpinionReport): SecondOpinionReport {
  return {
    rate: b.rate,
    eligible: a.eligible + b.eligible,
    sampled: a.sampled + b.sampled,
    inconsistent: a.inconsistent + b.inconsistent,
    repaired: a.repaired + b.repaired,
    discarded: a.discarded + b.discarded,
    unresolved: a.unresolved + b.unresolved,
    solverCalls: a.solverCalls + b.solverCalls,
  }
}

/** 确定性抽样：等距取 k = round(n×rate) 题；difficulty 3 恒入样（高难度档加权）。
 * 不引随机数——同输入同抽样，剧本测试与金样本回放全确定性。 */
export function sampleAuditIndices(count: number, rate: number, difficulties: Array<number | undefined>): number[] {
  const k = Math.min(count, Math.round(count * rate))
  const set = new Set<number>()
  if (k > 0) {
    const stride = count / k
    for (let i = 0; i < k; i++) set.add(Math.min(count - 1, Math.floor(i * stride)))
  }
  difficulties.forEach((d, i) => {
    if (d === 3) set.add(i)
  })
  return [...set].sort((a, b) => a - b)
}

/** 独立解题提示词：只看题面与选项（零答案键零解析），按题型给定 answer 形态。 */
export function solverPromptFor(item: Record<string, unknown>): string {
  const kind = String(item.kind)
  const options = Array.isArray(item.options) ? item.options as unknown[] : []
  return [
    '# 独立解题（第二意见抽查）', '',
    '只看下面的题目，把它当作考生独立解一遍——给出你自己的解答，不要臆测标准答案的写法。', '',
    '## 题目', '',
    `题型：${KIND_LABEL[kind] ?? kind}`,
    `题干：${String(item.q ?? '').trim()}`,
    ...(options.length
      ? ['', '选项:', ...options.map((o, i) => `- ${String.fromCharCode(65 + i)}. ${String(o)}`)]
      : []),
    '', '## 输出', '',
    '只输出一个 JSON 对象（不要代码围栏、不要任何解释）：',
    '{"answer": <你的答案>, "steps": "<关键步骤一两句>"}',
  ].join('\n')
}

/** 容忍解析解题应答（剥围栏 → 取 {...} → 去尾逗号；不可解析抛错由调用方保守放行）。 */
export function parseSolverReply(raw: string): { answer: unknown; steps?: string } {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('解题应答中找不到 JSON 对象')
  const doc = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>
  if (!('answer' in doc)) throw new Error('解题应答缺 answer 字段')
  return {
    answer: doc.answer,
    ...(typeof doc.steps === 'string' && doc.steps.trim() ? { steps: doc.steps } : {}),
  }
}

/** 解题应答 → 判卷比较器的作答形态（排序/配对按换行拼接、多选逗号拼接，同作答流口径）。 */
function responseOf(item: Record<string, unknown>, answer: unknown): unknown {
  const kind = String(item.kind)
  if ((kind === 'ordering' || kind === 'matching') && Array.isArray(answer)) return answer.map(String).join('\n')
  if (kind === 'multi_choice' && Array.isArray(answer)) return answer.map(a => String(a).trim()).join(',')
  if (typeof answer === 'boolean') return answer
  if (typeof answer === 'number') return String(answer)
  return typeof answer === 'string' ? answer : JSON.stringify(answer)
}

/** 确定性对账：evaluateAllo（判卷同款比较器）。返回 unavailable = 应答形态不可判
 * （solver 输出坏/空）——审计失败保守放行，不等于键错。 */
function reconcileWithKey(item: Record<string, unknown>, reply: { answer: unknown }): { match: boolean; unavailable?: boolean } {
  const allo: AlloQuestion = {
    kind: String(item.kind) as AlloKind,
    q: String(item.q ?? ''),
    answer: item.answer as AlloQuestion['answer'],
    ...(Array.isArray(item.options) ? { options: item.options.map(String) } : {}),
    ...(item.tol !== undefined && Number(item.tol) > 0 ? { tol: Number(item.tol) } : {}),
  }
  try {
    return { match: evaluateAllo(allo, responseOf(item, reply.answer)).correct }
  } catch {
    return { match: false, unavailable: true }
  }
}

const trimStem = (item: Record<string, unknown>): string => String(item.q ?? '').slice(0, 80)

/** 抽样执行第二意见门：独立解题 → 对账 → 不一致恰一次回灌修复 → 修复后再审计 →
 * 仍不一致弃题。solver 不可判的题保守放行（unresolved）。 */
export async function runSecondOpinion(
  llm: LlmComplete,
  items: Array<Record<string, unknown>>,
  opts?: SecondOpinionOptions,
): Promise<SecondOpinionResult> {
  const rate = opts?.rate ?? DEFAULT_QUIZ_AUDIT_RATE
  if (rate < 0 || rate > 1) {
    throw new Error(`[quiz-audit] 抽样率必须是 0–1 的数（收到 ${String(opts?.rate)}）；关门请把率配成 0 或省略 secondOpinion。`)
  }
  const report: SecondOpinionReport = {
    rate, eligible: 0, sampled: 0, inconsistent: 0, repaired: 0, discarded: 0, unresolved: 0, solverCalls: 0,
  }
  const rejected: Array<{ q: string; reason: string }> = []
  const out = [...items]
  /** 弃题的原位下标（循环结束后统一移除——弃题不阻塞整批，但绝不入库）。 */
  const discardPos = new Set<number>()
  if (rate <= 0 || !items.length) return { items: out, report, rejected }

  // 可对账题 = 客观题型 + 形状完整（缺 kind/q/answer 的残题交给既有逐题门拒收，不进审计）
  const eligibleIdx = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => AUDITABLE_KINDS.has(String(item.kind))
      && typeof item.q === 'string' && item.q.trim()
      && item.answer !== undefined && item.answer !== null)
  report.eligible = eligibleIdx.length
  const sampled = sampleAuditIndices(
    eligibleIdx.length, rate, eligibleIdx.map(({ item }) => (typeof item.difficulty === 'number' ? item.difficulty : undefined)),
  )
  report.sampled = sampled.length

  const solve = async (item: Record<string, unknown>): Promise<{ reply: ReturnType<typeof parseSolverReply> } | { broken: true }> => {
    const raw = await llm(solverPromptFor(item), undefined, { effort: 'fast', station: QUIZ_SOLVER_STATION })
    report.solverCalls++
    try {
      return { reply: parseSolverReply(raw) }
    } catch {
      return { broken: true }
    }
  }

  const inconsistent: Array<{ pos: number; item: Record<string, unknown>; reply: ReturnType<typeof parseSolverReply> }> = []
  for (const { item, i } of sampled.map(n => eligibleIdx[n]!)) {
    if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
    const r = await solve(item)
    if ('broken' in r) {
      report.unresolved++ // 审计失败 ≠ 键错：保守放行
      continue
    }
    const v = reconcileWithKey(item, r.reply)
    if (v.unavailable) {
      report.unresolved++
      continue
    }
    if (v.match) continue
    report.inconsistent++
    inconsistent.push({ pos: i, item, reply: r.reply })
  }
  if (!inconsistent.length) return { items: out, report, rejected }

  // 修复轮（gateRepairRound 形态：恰一次；修复调用走题目生成站 repair 形态——站名由
  // 注入缝闭包钉住，这里只声明 kind/档位）。
  if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
  const repairPrompt = [
    '# 出题修复（第二意见抽查发现答案键不一致）', '',
    '下列题目经「只看题面独立解题」抽查，独立解与答案键不一致。请逐题重新审视：先独立解题，再核对答案键、解析与题面三者——键错就改键（与解析一致），解析与键矛盾就改解析，题面含糊就改题面让它锁定唯一答案。只修列出的题，不要新出题、不要改动其它字段语义。', '',
    '## 待修题目', '',
    ...inconsistent.flatMap(({ item, reply }, n) => [
      `### 题 ${n + 1}`, '',
      `- 独立解题的答案：${JSON.stringify(reply.answer)}${typeof reply.steps === 'string' ? `（关键步骤：${reply.steps}）` : ''}`,
      `- 存储的答案键：${revealAnswer({ kind: String(item.kind) as AlloKind, answer: item.answer as AlloQuestion['answer'], ...(Array.isArray(item.options) ? { options: item.options.map(String) } : {}) })}`,
      '', '题目 YAML：', '', YAML.stringify(item),
    ]),
    '', '## 输出', '',
    '只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：',
    'questions:',
    '  - <修正后的完整题目（字段与原题同构，按原题顺序，一道不多不少）>',
  ].join('\n')
  let repairedItems: Array<Record<string, unknown>> | null = null
  try {
    const raw = await llm(repairPrompt, undefined, { effort: 'deep', kind: 'repair' })
    const doc = YAML.parseModel(raw) as { questions?: unknown } | null
    if (typeof doc === 'object' && doc !== null && Array.isArray(doc.questions)
      && doc.questions.length === inconsistent.length) {
      repairedItems = doc.questions as Array<Record<string, unknown>>
    }
  } catch {
    repairedItems = null // 修复轮产出不可解析 = 修复失败，走弃题
  }

  if (!repairedItems) {
    for (const { pos, item } of inconsistent) {
      report.discarded++
      discardPos.add(pos)
      rejected.push({ q: trimStem(item), reason: '第二意见：独立解题与答案键不一致，修复轮未产出可用修正，弃题' })
    }
    return { items: out.filter((_, i) => !discardPos.has(i)), report, rejected }
  }

  // 修复后再审计：逐题重新独立解题；一致才替换原位，仍不一致弃题。
  for (const [n, { pos, item }] of inconsistent.entries()) {
    const fixed = repairedItems[n]!
    if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
    const r = await solve(fixed)
    const ok = !('broken' in r) && (() => {
      const v = reconcileWithKey(fixed, r.reply)
      return !v.unavailable && v.match
    })()
    if (ok) {
      report.repaired++
      out[pos] = fixed
    } else {
      report.discarded++
      discardPos.add(pos)
      rejected.push({ q: trimStem(item), reason: '第二意见：独立解题与答案键不一致，修复一轮仍不一致，弃题' })
    }
  }
  return { items: out.filter((_, i) => !discardPos.has(i)), report, rejected }
}
