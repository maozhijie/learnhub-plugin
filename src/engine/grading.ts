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

// ---------------------------------------------------------------- 答案归一（吸收自 Python grading.py）

export function normAnswer(s: string): string {
  return String(s).trim().replace(/\s+/g, '')
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
  /** numeric 题的容差（差值 ≤ tol 判对；缺省 0）。 */
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
      correct = Array.isArray(q.answer) && q.answer.some(c =>
        typeof c === 'string' && c.trim().toLowerCase() === s.toLowerCase())
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
      correct = nu !== null && ne !== null && Math.abs(nu - ne) <= (q.tol ?? 0)
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

/** 从模型回复中提取 {score, feedback}：容错（markdown 围栏、尾逗号、外层散文）。 */
export function parseReflectionGrading(raw: string): { score: number; feedback: string } {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('unparseable reflection grading reply')
  const doc = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')) as { score?: unknown; feedback?: unknown }
  if (typeof doc.score !== 'number' || typeof doc.feedback !== 'string') {
    throw new Error('reflection grading reply missing score/feedback')
  }
  if (!(doc.score >= 0 && doc.score <= 1)) {
    throw new Error(`reflection grading score 越界（${doc.score}，允许 0.0–1.0）`)
  }
  return { score: doc.score, feedback: doc.feedback }
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
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('unparseable open-question grading reply')
  const doc = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')) as { score?: unknown; feedback?: unknown }
  if (typeof doc.score !== 'number' || typeof doc.feedback !== 'string') {
    throw new Error('open-question grading reply missing score/feedback')
  }
  if (!Number.isInteger(doc.score) || doc.score < 0 || doc.score > 10) {
    throw new Error(`open-question grading score 越界（${doc.score}，允许整数 0–10）`)
  }
  return { score: doc.score, feedback: doc.feedback }
}

// ---------------------------------------------------------------- 作答记录与 EMA

/** 练习证据 EMA（allo 判卷流）：首证取分，之后旧值×0.7 + 本次分×0.3；是口径 B Mastery 的练习项。 */
export function nextEma(current: number | undefined, score: number): number {
  const prev = current && current > 0 ? current : null
  const next = prev === null ? score : prev * 0.7 + score * 0.3
  return Math.round(Math.min(1, Math.max(0, next)) * 1000) / 1000
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
