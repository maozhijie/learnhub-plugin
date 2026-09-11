import type { PracticeRec, ErratumRec } from './types.ts'
import type { AlloKind } from './types.ts'
/**
 * 判卷与作答记录。
 *
 * 评分语义抄自 allo（nomifun-learning service/progress.rs 的 evaluate / answer_review）：
 * 四题型（single_choice / true_false / fill_in_blank / reflection），对=1.0 错=0.0，
 * 及格线 0.6；reflection/open_question 必须由 AI 按 {score, feedback} 严格 JSON 判卷，
 * 输出缺失/非法时作答事务失败（#9：不降级给分，不伪造证据）。
 * 兼容旧课程笔记练习区的 sympy|choice|ai|human 元数据（sympy 题降级为
 * 「归一相等 → 数值容差 → 逗号列表集合相等」三段规则判卷，符号等价交由 ai 通道）。
 *
 * 判卷不碰调度状态（D15：评分写入只走工作单→settle）；唯一副作用 =
 * practice 计数累加（frontmatter）+ 作答流水 + 练习证据 EMA（allo mastery 语义）。
 */
import type { Fm } from './types.ts'

// ---------------------------------------------------------------- 数值工具（#172 单一出处）

/** 两位舍入（原 15 处 `Math.round(x * 100) / 100` 的唯一实现：占比、正确率、S/D 值等展示值）。 */
export function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/** [0,1] 截断（原 7 处 `Math.min(1, Math.max(0, x))` 的唯一实现：掌握度、比率、带值）。 */
export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/** 比率 → 'NN%' 展示（原 5 处本地 pct 的唯一实现；四舍五入取整百分比，与各处旧输出一致）。 */
export function pctOf(x: number): string {
  return `${Math.round(x * 100)}%`
}

// ---------------------------------------------------------------- 答案归一（吸收自 Python grading.py）

export function normAnswer(s: string): string {
  return String(s).trim().replace(/\s+/g, '')
}

/** 填空答案归一（唯一答案填空口径，ADR-0029）：NFKC 折叠全角/半角 → 去全部空白 → 小写。
 * 唯一性由出题契约保证（术语/名称/符号），判卷只吸收书写差异（空格、全半角、大小写）。 */
export function normBlank(s: string): string {
  return normAnswer(s.normalize('NFKC')).toLowerCase()
}

/** 数值解析（容差判卷用）；解析失败返回 null。 */
export function numericOf(s: string): number | null {
  const t = normAnswer(s)
  if (!t) return null
  const n = Number(t)
  if (Number.isFinite(n)) return n
  // 简单分数 a/b 与百分数
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/)
  if (frac && Number(frac[2]) !== 0) return Number(frac[1]) / Number(frac[2])
  const pct = t.match(/^(-?\d+(?:\.\d+)?)%$/)
  if (pct) return Number(pct[1]) / 100
  return null
}

/** numeric 缺省容差：极小相对容差（1e-9×|答案|，下限 1e-12），只吸收浮点表示毛刺；
 * 有业务意义的容差必须由出题显式给 tol（prompt 硬约束）。 */
const NUMERIC_DEFAULT_REL_TOL = 1e-9
const NUMERIC_MIN_TOL = 1e-12

/** 三段规则判卷：归一相等 → 数值容差 → 逗号列表集合相等（全角逗号兼容）。 */
export function answersEqual(user: string, expected: string, tol?: number): boolean {
  const u = normAnswer(user)
  const e = normAnswer(expected)
  if (!u) return false
  if (u === e) return true
  if (tol !== undefined) {
    const nu = numericOf(u)
    const ne = numericOf(e)
    if (nu !== null && ne !== null && Math.abs(nu - ne) <= tol) return true
  }
  if (e.includes(',') || e.includes('，')) {
    const us = new Set(u.split(/[,，]/).map(normAnswer).filter(Boolean))
    const es = new Set(e.split(/[,，]/).map(normAnswer).filter(Boolean))
    if (us.size && us.size === es.size && [...us].every(x => es.has(x))) return true
  }
  return false
}

/** 选择题作答归一 → 大写字母（提不出字母返回原串归一化结果）。 */
export function normChoice(s: string): string {
  let t = normAnswer(s).toUpperCase()
  for (const pre of ['选项', '答案', '选']) {
    if (t.startsWith(pre)) t = t.slice(pre.length)
  }
  t = t.replace(/[。．.]+$/, '')
  const m = t.match(/[A-Z]/)
  return m ? m[0] : t
}

export function choiceAnswerOk(user: string, expected: string): boolean {
  return Boolean(normAnswer(user)) && normChoice(user) === normChoice(expected)
}

// ---------------------------------------------------------------- allo 判卷（evaluate 语义）

/** 新题库题型（P4 题库 schema）。
 * 规则判卷：single_choice / true_false / fill_in_blank / multi_choice / numeric / ordering / matching；
 * AI 判卷：reflection（0–1 评分要点）与 open_question（0–10 综合应用批改）。 */
export type AlloKind =
  | 'single_choice' | 'true_false' | 'fill_in_blank' | 'reflection'
  | 'multi_choice' | 'numeric' | 'ordering' | 'matching' | 'open_question'

export interface AlloQuestion {
  kind: AlloKind
  q: string
  answer: string | boolean | string[]
  options?: string[]
  explanation?: string
  /** numeric 题的容差（差值 ≤ tol 判对；缺省极小相对容差 1e-9×|答案|，只防浮点毛刺）。 */
  tol?: number
}

export const PASS_SCORE = 0.6

/** allo evaluate 的等价实现 → (score, feedback)；response 形状由题型决定。 */
export function evaluateAllo(q: AlloQuestion, response: unknown): { score: number; feedback: string; correct: boolean } {
  let correct = false
  const explanation = q.explanation || 'Try again and retrieve the governing concept before answering.'
  switch (q.kind) {
    case 'single_choice':
      correct = typeof response === 'string' && normChoice(response) === normChoice(String(q.answer))
      break
    case 'true_false':
      correct = normalizeBool(response) === normalizeBool(q.answer)
      break
    case 'fill_in_blank': {
      const s = typeof response === 'string' ? response.trim() : ''
      if (!s) throw new Error('fill_in_blank 作答不能为空')
      // 唯一答案填空（ADR-0029）：书写差异归一（空白/全半角/大小写），不做代数等价
      correct = Array.isArray(q.answer) && q.answer.some(c =>
        typeof c === 'string' && normBlank(c) === normBlank(s))
      break
    }
    case 'reflection': {
      const s = typeof response === 'string' ? response.trim() : ''
      if (!s) throw new Error('reflection 作答不能为空')
      throw new Error('reflection 必须经 AI 判卷通道评分；规则判卷不得降级为“非空即对”')
    }
    case 'multi_choice': {
      const s = typeof response === 'string' ? response : ''
      if (!normAnswer(s)) throw new Error('multi_choice 作答不能为空')
      const picked = new Set(s.split(/[,，]/).map(normChoice).filter(Boolean))
      const expected = new Set((Array.isArray(q.answer) ? q.answer : []).map(normChoice))
      correct = picked.size === expected.size && [...picked].every(x => expected.has(x))
      break
    }
    case 'numeric': {
      const s = typeof response === 'string' ? response.trim() : ''
      if (!s) throw new Error('numeric 作答不能为空')
      const nu = numericOf(s)
      const ne = numericOf(String(q.answer))
      // tol 缺省给极小相对容差：只吸收浮点表示毛刺，有意义的容差仍须显式给 tol
      correct = nu !== null && ne !== null
        && Math.abs(nu - ne) <= (q.tol ?? Math.max(Math.abs(ne) * NUMERIC_DEFAULT_REL_TOL, NUMERIC_MIN_TOL))
      break
    }
    case 'ordering': {
      const s = typeof response === 'string' ? response.trim() : ''
      if (!s) throw new Error('ordering 作答不能为空')
      // 提交 = 排序后的项文本按换行拼接；answer = 正确顺序的项文本数组
      const seq = s.split(/\n/).map(normAnswer).filter(Boolean)
      const expected = (Array.isArray(q.answer) ? q.answer : []).map(normAnswer)
      correct = seq.length === expected.length && seq.every((x, i) => x === expected[i])
      break
    }
    case 'matching': {
      const s = typeof response === 'string' ? response.trim() : ''
      if (!s) throw new Error('matching 作答不能为空')
      // 提交 = 与 options 左列一一对应的右项文本按换行拼接；answer = 正确配对文本数组
      const seq = s.split(/\n/).map(normAnswer)
      const expected = (Array.isArray(q.answer) ? q.answer : []).map(normAnswer)
      correct = seq.length === expected.length && seq.every((x, i) => x === expected[i])
      break
    }
    case 'open_question': {
      const s = typeof response === 'string' ? response.trim() : ''
      if (!s) throw new Error('open_question 作答不能为空')
      throw new Error('open_question 必须经 AI 判卷通道评分（0–10 分制）')
    }
  }
  const score = correct ? 1.0 : 0.0
  const feedback = correct ? (q.explanation || '') : explanation
  return { score, feedback, correct }
}

function normalizeBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '对' || s === '正确' || s === '是' || s === '√' || s === 't' || s === 'yes'
}

// ---------------------------------------------------------------- AI 反思判卷

/** AI 反思判卷系统提示词（抄 allo REFLECTION_GRADING_SYSTEM，本地化为中文输出）。 */
export const REFLECTION_GRADING_SYSTEM = `You are a strict but encouraging learning coach grading a learner's answer for a course exercise.

Score the answer from 0.0 to 1.0 (0.6 is passing):
- Correctness: does the answer align with the concepts this exercise targets?
- Completeness: does it cover the key points of those concepts?

Reply with ONLY one JSON object matching this shape:
{
  "score": 0.75,
  "feedback": "markdown text"
}
Rules:
- score must be a number between 0.0 and 1.0.
- feedback must be Markdown with two parts: (1) an evaluation of the answer, (2) concrete improvement suggestions.
- Write the feedback in the same language as the learner's answer.
- Output JSON only, without Markdown fences or commentary.`

/** 剥掉判卷回复可能包住的整段 markdown 代码围栏（与出题路径 stripFences 同款）。 */
function stripGradingFences(body: string): string {
  const m = body.match(/```(?:json|markdown|md)?\s*\n([\s\S]*?)\n```/)
  return m ? m[1] : body
}

/** 判卷 JSON 提取的公共容错（判卷/申诉复核共用）：剥围栏 → 取 {...} → 去尾逗号 → JSON.parse。 */
function parseGradingDoc(raw: string): Record<string, unknown> {
  const m = stripGradingFences(raw).match(/\{[\s\S]*\}/)
  if (!m) throw new Error('reply 中找不到 JSON 对象')
  return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>
}

/** score 数值化：模型常把分数写成字符串（"0.75"/"7"），可安全转数字的放行。 */
function numericScore(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** 从模型回复中提取 {score, feedback}：容错（markdown 围栏、尾逗号、外层散文、字符串分数）。 */
export function parseReflectionGrading(raw: string): { score: number; feedback: string } {
  const doc = parseGradingDoc(raw)
  const score = numericScore(doc.score)
  if (score === null || typeof doc.feedback !== 'string') {
    throw new Error('reflection grading reply missing score/feedback')
  }
  if (!(score >= 0 && score <= 1)) {
    throw new Error(`reflection grading score 越界（${score}，允许 0.0–1.0）`)
  }
  return { score, feedback: doc.feedback }
}

/** 开放题 AI 判卷系统提示词：0–10 分制，≥6 及格；批改 + 改进建议两段缺一不可。 */
export const OPEN_QUESTION_GRADING_SYSTEM = `You are a strict but constructive examiner grading a learner's open-ended answer that applies an entire lesson's content.

Score the answer from 0 to 10 (6 is passing):
- Coverage: does it apply the lesson's core concepts across sections?
- Correctness: are the applied concepts used accurately?
- Depth: does it show integrated understanding rather than surface recall?

Reply with ONLY one JSON object matching this shape:
{
  "score": 7,
  "feedback": "markdown text"
}
Rules:
- score must be an integer between 0 and 10.
- feedback must be Markdown with two mandatory parts: (1) 逐点批改 — go through the learner's answer point by point, marking what is right and what is wrong or missing; (2) 改进建议 — concrete, actionable suggestions to reach full marks.
- Write the feedback in the same language as the learner's answer.
- Output JSON only, without Markdown fences or commentary.`

/** 从模型回复中提取开放题 {score 0-10, feedback}：容错同 reflection。 */
export function parseOpenGrading(raw: string): { score: number; feedback: string } {
  const doc = parseGradingDoc(raw)
  const score = numericScore(doc.score)
  if (score === null || typeof doc.feedback !== 'string') {
    throw new Error('open-question grading reply missing score/feedback')
  }
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    throw new Error(`open-question grading score 越界（${score}，允许整数 0–10）`)
  }
  return { score, feedback: doc.feedback }
}

// ---------------------------------------------------------------- 判错差异摘要与申诉复核

/** 判错差异摘要（瑕疵题勘误前置：判错结果态展示「正确答案 + 差异」，规则判卷题型专用）。
 * 返回 null = 没有可点名的差异（判对、AI 题型、或提不出结构化差异）。 */
export function answerDiff(q: AlloQuestion, response: unknown): string | null {
  if (q.kind === 'reflection' || q.kind === 'open_question') return null
  const s = typeof response === 'string' ? response : ''
  switch (q.kind) {
    case 'multi_choice': {
      const picked = new Set(s.split(/[,，]/).map(normChoice).filter(Boolean))
      if (!picked.size) return null
      const expected = (Array.isArray(q.answer) ? q.answer : []).map(normChoice)
      const missed = expected.filter(x => !picked.has(x))
      const extra = [...picked].filter(x => !expected.includes(x))
      const parts = [
        ...(missed.length ? [`漏选了 ${missed.join('、')}`] : []),
        ...(extra.length ? [`多选了 ${extra.join('、')}`] : []),
      ]
      return parts.length ? parts.join('，') : null
    }
    case 'single_choice': {
      const picked = normChoice(s)
      return picked ? `你选了 ${picked}` : null
    }
    case 'true_false': {
      if (!s) return null
      return `你的判断：${normalizeBool(s) ? '正确' : '错误'}`
    }
    case 'fill_in_blank':
      return s ? '你的作答不在可接受答案之列' : null
    case 'numeric': {
      if (!s) return null
      return `你的作答 ${normAnswer(s)} 不在容差（±${q.tol ?? 0}）内`
    }
    case 'ordering': {
      const seq = s.split(/\n/).map(normAnswer).filter(Boolean)
      const expected = (Array.isArray(q.answer) ? q.answer : []).map(normAnswer)
      if (seq.length !== expected.length) return '项数与题目不符'
      const i = seq.findIndex((x, j) => x !== expected[j])
      return i < 0 ? null : `从第 ${i + 1} 项起顺序不对`
    }
    case 'matching': {
      const seq = s.split(/\n/).map(normAnswer)
      const expected = (Array.isArray(q.answer) ? q.answer : []).map(normAnswer)
      const wrong = expected.filter((x, j) => seq[j] !== x).length
      return wrong > 0 ? `${wrong} 处配对不对` : null
    }
    default:
      return null
  }
}

/** 申诉复核三态裁定（瑕疵题勘误）：key_error = 答案键/解析与题面矛盾；defective = 题面
 * 含糊/自相矛盾/超纲；ok = 题与键都对、学习者确实答错。 */
export type DisputeVerdict = 'key_error' | 'defective' | 'ok'

export interface DisputeReviewDoc {
  verdict: DisputeVerdict
  reasoning: string
  /** key_error 时的建议新答案（与题目 answer 字段同构，形态由调用方按题型过门禁）。 */
  suggested_answer?: unknown
  suggested_explanation?: string
}

/** 申诉复核系统提示词：两阶段（先独立解题再对账）防锚定，三态裁定输出严格 JSON。 */
export const DISPUTE_REVIEW_SYSTEM = `You are a meticulous examiner auditing a disputed practice question for a learning system.

The learner's answer was marked wrong and they dispute it. Audit in two phases:
- Phase 1: solve the question YOURSELF from the stem alone (ignore the stored answer key while solving). Show the full work.
- Phase 2: compare your independent answer with the stored answer key and explanation, and the learner's submitted answer.

Reply with ONLY one JSON object matching this shape:
{
  "verdict": "key_error" | "defective" | "ok",
  "reasoning": "markdown text",
  "suggested_answer": "<same shape as the question's answer field, only for key_error>",
  "suggested_explanation": "markdown or null"
}
Verdict rules:
- "key_error": the stem is self-consistent and within the lesson content, but the stored answer key or explanation contradicts your independent solution. Must provide suggested_answer (same shape as the stored answer: e.g. an array of option letters for multi_choice) and ideally suggested_explanation.
- "defective": the stem itself is ambiguous, self-contradictory, or tests content the lesson never taught. Suggest voiding and regenerating.
- "ok": both the stem and the answer key are correct; the learner's submission genuinely does not match.
- Write reasoning in Chinese, Markdown: the phase 1 solution first, then the phase 2 reconciliation.
- Output JSON only, without Markdown fences or commentary.`

/** 从模型回复中提取申诉复核结果（容错同判卷：围栏/尾逗号/外层散文）。 */
export function parseDisputeReview(raw: string): DisputeReviewDoc {
  const doc = parseGradingDoc(raw)
  const verdict = doc.verdict
  if (verdict !== 'key_error' && verdict !== 'defective' && verdict !== 'ok') {
    throw new Error(`dispute review verdict 非法：${String(verdict)}（允许 key_error/defective/ok）`)
  }
  if (typeof doc.reasoning !== 'string' || !doc.reasoning.trim()) {
    throw new Error('dispute review reply missing reasoning')
  }
  if (verdict === 'key_error' && doc.suggested_answer === undefined) {
    throw new Error('dispute review verdict=key_error 缺 suggested_answer')
  }
  return {
    verdict,
    reasoning: doc.reasoning,
    ...(doc.suggested_answer !== undefined ? { suggested_answer: doc.suggested_answer } : {}),
    ...(typeof doc.suggested_explanation === 'string' && doc.suggested_explanation.trim()
      ? { suggested_explanation: doc.suggested_explanation } : {}),
  }
}

// ---------------------------------------------------------------- 作答记录与 EMA

/** 练习证据 EMA（allo 判卷流）：首证取分，之后旧值×0.7 + 本次分×0.3；是口径 B Mastery 的练习项。 */
export function nextEma(current: number | undefined, score: number): number {
  const prev = current && current > 0 ? current : null
  const next = prev === null ? score : prev * 0.7 + score * 0.3
  return Math.round(clamp01(next) * 1000) / 1000
}

/** recordAttempt 的 frontmatter 侧更新：practice 计数 + 练习证据 EMA（mastery 纯派生，此处不落盘）。 */
export function applyPracticeEvidence(fm: Fm, score: number): Fm {
  const practice = {
    attempts: fm.practice.attempts + 1,
    correct: fm.practice.correct + (score >= PASS_SCORE ? 1 : 0),
  }
  const practice_ema = nextEma(fm.practice_ema, score)
  return { ...fm, practice, practice_ema }
}

/** 错题公布答案的题型化展示（多选字母并排、排序箭头链、匹配左→右）。
 * #152 刀 3 自门面文件归位：通道域（note-source.ts）出题/作答共用，住判卷域模块。 */
export function revealAnswer(q: { kind: AlloKind; answer: string | boolean | string[]; options?: string[] }): string {
  switch (q.kind) {
    case 'multi_choice': return Array.isArray(q.answer) ? q.answer.join('') : String(q.answer)
    case 'ordering': return Array.isArray(q.answer) ? q.answer.join(' → ') : String(q.answer)
    case 'matching': return Array.isArray(q.answer) && q.options?.length
      ? q.options.map((o, i) => `${o} → ${q.answer[i] ?? '?'}`).join('；')
      : Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer)
    case 'fill_in_blank': return Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer)
    default: return String(q.answer)
  }
}

/** 勘误冲正的读侧净值（ADR-0031）：key_error 的作答按勘误记录替换 xp/对错；
 * defective/overridden 的作答整体剔除。原始流水不动，聚合账（XP、作答统计）
 * 一律先过本函数再算——「行为流水即事实」包含冲正凭证本身。 */
export function netPracticeRecs<T extends PracticeRec>(recs: readonly T[], errata: readonly ErratumRec[]): T[] {
  const byKey = new Map(errata.map(e => [`${e.target_ts}|${e.qid}`, e]))
  const out: T[] = []
  for (const r of recs) {
    const e = r.ts ? byKey.get(`${r.ts}|${r.qid ?? ''}`) : undefined
    if (!e) {
      out.push(r as T)
    } else if (e.verdict === 'key_error') {
      out.push({ ...(r as T), xp: e.xp, correct: e.correct ?? r.correct })
    }
    // defective/overridden：本次作答作废，不出现在净流里
  }
  return out
}

