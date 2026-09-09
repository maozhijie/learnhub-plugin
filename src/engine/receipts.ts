/**
 * 回执反馈环（U-1 #88 / ADR-0016）：外部练习回执 → AI 量表评审 → 渐退反馈计划。
 *
 * 回执（Receipt）= 学习者提交的外部练习证据：**自报即可信**（无反作弊门），形态自由
 * （文字/图片/导出/签核），**永不判 Broken**（没交回执是合法常态，连 Missing 都不算）；
 * 是证据不是内容——永不进内容管线、不被出题、不是复习对象。v1 落地载体 = 实践节点
 * （type='practice'）：评审分**同权进该节点 practice_ema**（旧 0.7 新 0.3，复用既有
 * EMA 通道；已入 EMA 的历史分值不回滚——账本只增）。
 *
 * 渐退反馈（guidance hypothesis，Salmoni 1984）：per 实践主体、频率随历史递减、学习者
 * 可控（随时可主动要完整评审）。纯函数曲线（本票定参）：第 i 份回执获得完整错误具体
 * 评审当且仅当 i ∈ {1,2,4,7,11,16,…}（间隔 1,2,3,… 封顶 FEEDBACK_MAX_EVERY）；非完整
 * 份仍走量表评分入 EMA，只省错误逐条拆解。回执零 XP、不推进任何 FSRS 卡（fsrs 块
 * 零触碰）。
 *
 * 落盘：state/回执.jsonl（append-only 证据流水）；Missing/Broken 纪律——文件缺失 =
 * 合法空态，损坏行 Broken 报出（流水带病读会数错渐退位置）。
 */
import { nowIso } from './dates.ts'
import { applyPracticeEvidence } from './grading.ts'
import type { Fm } from './types.ts'
import type { Store } from './store.ts'

/** 回执材料形态（来源枚举，ADR-0016 裁决 4：留档、同权进 EMA）。 */
export type ReceiptKind = 'text' | 'image' | 'export' | 'signoff'
export const RECEIPT_KINDS: ReceiptKind[] = ['text', 'image', 'export', 'signoff']
export const RECEIPT_KIND_LABEL: Record<ReceiptKind, string> = {
  text: '文字描述', image: '图片', export: '软件导出', signoff: '教练签核',
}

/** 回执流水行（state/回执.jsonl；append-only，id = 主体内序号 r1/r2/…）。 */
export interface ReceiptLogRec {
  id: string
  ts: string
  course: string
  node: string
  /** 学习日（过日界口径，ADR-0020；ts 是出处戳）。 */
  day: string
  kind: ReceiptKind
  /** 评审深度：full 完整错误具体评审 / brief 只评分+总评（渐退）。 */
  review_mode: 'full' | 'brief'
  /** 量表分 0–1（同权进 EMA；永不回滚）。 */
  score: number
  verdict: string
  /** 错误逐条拆解（仅 full 落盘）。 */
  errors?: Array<{ point: string; issue: string; advice: string }>
}

/** 渐退封顶：完整评审最密也只到每 5 份一次（间隔序列 1,2,3,4,5 后恒 5）。 */
export const FEEDBACK_MAX_EVERY = 5

/** 第 i 份回执（1-based）是否获得完整错误具体评审（纯函数，渐退曲线查询面）：
 * 完整评审位置 = {1,2,4,7,11,16,21,…}（间隔 1,2,3,… 封顶）——频率随历史单调递减、
 * 封顶不消失。 */
export function wantsFullReview(receiptIndex: number): boolean {
  if (!Number.isInteger(receiptIndex) || receiptIndex < 1) return false
  let p = 1
  let k = 1
  while (p < receiptIndex) {
    p += Math.min(k, FEEDBACK_MAX_EVERY)
    k++
  }
  return p === receiptIndex
}

/** 距下一次完整评审还有几份回执（「学习者可控」的可见性补偿）：输入主体已有份数，
 * 返回再交几份会吃到完整评审（= 下一个完整评审位置 − 已有份数）。 */
export function receiptsUntilNextFull(receiptIndex: number): number {
  let p = 1
  let k = 1
  while (p <= receiptIndex) {
    p += Math.min(k, FEEDBACK_MAX_EVERY)
    k++
  }
  return Math.max(0, p - receiptIndex)
}

/** AI 量表评审结果（严格 JSON 契约，见「回执评审」提示词模板）。 */
export interface ReceiptReviewDoc {
  /** 量表分 0–1（同权进 EMA）。 */
  score: number
  /** 一句话总评（brief/full 都有）。 */
  verdict: string
  /** 错误逐条拆解（full 语义；brief 模式调用方丢弃）。 */
  errors?: Array<{ point: string; issue: string; advice: string }>
}

/** AI 评审输出解析（不可解析抛错——评审失败零落盘，ADR-0004 事务性）。 */
export function parseReceiptReview(raw: string): ReceiptReviewDoc {
  let doc: unknown
  try {
    doc = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, ''))
  } catch {
    throw new Error(`[receipt-review] AI 评审输出不是合法 JSON，回执未落盘。\n原始输出前 400 字：${raw.slice(0, 400)}`)
  }
  const d = doc as Record<string, unknown>
  const score = typeof d.score === 'number' && Number.isFinite(d.score) ? Math.min(1, Math.max(0, d.score)) : NaN
  if (Number.isNaN(score)) throw new Error('[receipt-review] AI 评审缺 0–1 的 score 字段，回执未落盘。')
  const verdict = typeof d.verdict === 'string' && d.verdict.trim() ? d.verdict.trim() : ''
  if (!verdict) throw new Error('[receipt-review] AI 评审缺 verdict 总评，回执未落盘。')
  const errors = Array.isArray(d.errors)
    ? d.errors
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map(e => ({ point: String(e.point ?? ''), issue: String(e.issue ?? ''), advice: String(e.advice ?? '') }))
      .filter(e => e.issue)
    : []
  return { score: Math.round(score * 1000) / 1000, verdict, ...(errors.length ? { errors } : {}) }
}

/** 评审 user 材料拼装（量表来源 = 挂载实践节点的内容要点；mode 决定拆解深度）。 */
export function receiptReviewPrompt(input: {
  template: string
  course: string
  node: string
  kind: ReceiptKind
  material: string
  points: Array<{ title: string; md: string }>
  mode: 'full' | 'brief'
  recentVerdicts: string[]
}): string {
  const lines: string[] = [input.template, '', `## 评审对象：${input.course} / ${input.node}`,
    '', `## 回执材料（形态：${RECEIPT_KIND_LABEL[input.kind]}）`, '', input.material.slice(0, 6000),
    '', '## 量表来源：本实践节点的正文/交互要点（评分只对照这些）']
  for (const s of input.points) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  if (!input.points.length) {
    lines.push('', '（该节点还没有可对照的正文要点——按回执材料的自洽性与完成度给分，并在 verdict 里注明量表缺依据。）')
  }
  if (input.recentVerdicts.length) {
    lines.push('', '## 近几次评审总评（供连续性参考，不必重复）', '', ...input.recentVerdicts.slice(-3).map(v => `- ${v}`))
  }
  lines.push('', input.mode === 'full'
    ? '## 本次评审深度：完整（full）——按量表逐要点对照，errors 给出错误逐条拆解。'
    : '## 本次评审深度：简要（brief，渐退反馈）——只给 score 与一句话 verdict，errors 留空数组。')
  return lines.join('\n')
}

/** 评审 system 指令（严格 JSON 输出契约）。 */
export function receiptReviewSystem(): string {
  return [
    '你是 learnhub 的练习评审教练。学习者提交了一份真实练习的外部回执，你按量表给一次错误具体的定向评审。',
    '这是回执触发的讲解（错误当下的定向反馈），不是自由答疑：只对照量表来源逐点评审，不扩展新主题。',
    '语气直接、具体到错误本身；量表分诚实反映对照要点的达成度（0–1），不安慰性给分。',
    '',
    '## 输出（严格 JSON，不要代码围栏、不要任何额外解释）',
    '{',
    '  "score": 0.0,',
    '  "verdict": "一句话总评",',
    '  "errors": [ { "point": "对照的要点", "issue": "具体错误", "advice": "怎么改" } ]',
    '}',
    'brief 深度时 errors 必须是空数组。',
  ].join('\n')
}

/** 一次回执提交的产出（engine.receiptSubmit 的返回）。 */
export interface ReceiptSubmitResult {
  receipt: ReceiptLogRec
  /** 该主体第几份回执（1-based，渐退曲线的输入）。 */
  index: number
  review_mode: 'full' | 'brief'
  /** 评审后的节点 practice_ema（已含本次；ADR-0001 的 mastery 0.3 上限妥协照旧）。 */
  practice_ema: number
  /** 下一次完整评审还需几份（brief 时给学习者预期）。 */
  next_full_in: number | null
}

/** 回执提交（引擎侧收口）：评审（llm seam 注入）→ 流水落盘 → EMA 入账。评审解析失败
 * 时回执与 EMA 零落盘（ADR-0004 事务性）；fsrs 块经 fm 原样透传——回执永不推进任何
 * FSRS 卡。 */
export async function submitReceipt(input: {
  store: Store
  course: string
  node: string
  kind: ReceiptKind
  material: string
  /** 量表来源 = 挂载实践节点的内容要点（facade 的 explainPoints 同款抽取）。 */
  points: Array<{ title: string; md: string }>
  today: string
  forceFull: boolean
  /** 当前节点 frontmatter。 */
  fm: Fm
  saveFm: (fm: Fm) => Promise<void>
  llm: (prompt: string, system?: string) => Promise<string>
  template: string
}): Promise<ReceiptSubmitResult> {
  const prior = (await input.store.receiptsAll()).filter(r => r.course === input.course && r.node === input.node)
  const index = prior.length + 1
  const mode: 'full' | 'brief' = input.forceFull || wantsFullReview(index) ? 'full' : 'brief'
  const prompt = receiptReviewPrompt({
    template: input.template,
    course: input.course,
    node: input.node,
    kind: input.kind,
    material: input.material,
    points: input.points,
    mode,
    recentVerdicts: prior.map(p => p.verdict).filter(Boolean),
  })
  const review = parseReceiptReview(await input.llm(prompt, receiptReviewSystem()))
  const rec: ReceiptLogRec = {
    id: `r${index}`,
    ts: nowIso(),
    course: input.course, node: input.node,
    day: input.today,
    kind: input.kind,
    review_mode: mode,
    score: review.score,
    verdict: review.verdict,
    ...(mode === 'full' && review.errors?.length ? { errors: review.errors } : {}),
  }
  await input.store.appendReceipt(rec)
  // 同权进 EMA（旧 0.7 新 0.3）：复用既有 applyPracticeEvidence（ADR-0016 工程影响点名）
  const nextFm = applyPracticeEvidence(input.fm, review.score)
  await input.saveFm(nextFm)
  return {
    receipt: rec,
    index,
    review_mode: mode,
    practice_ema: nextFm.practice_ema ?? 0,
    next_full_in: mode === 'brief' ? receiptsUntilNextFull(index) : null,
  }
}
