/**
 * 题目卫生（ADR-0029/0030）：出题产物的转义损坏修复与记法/边界契约检测。
 *
 * 两个来源的确定性门禁：
 * 1. 转义损坏——模型用 YAML/JSON 双引号包题面时 `\t`/`\a`/`\f` 等被解释成控制字符
 *    （`\times` → tab+`imes`），按「控制字符 → 命令首字母 + 已知命令片段表」确定性
 *    修复并计数；修复不掉的高危控制字符判损坏，该题拒收重出。
 * 2. 记法/边界契约——题面/选项/解析剥掉 `$…$` 与代码后不得残留 ASCII 数学记号
 *    （`^`/`_`）或裸 LaTeX 命令；填空答案不得疑似数值或代数式（唯一答案填空边界）。
 *
 * 纯函数模块（出题管线、题库体检与测试共用）；拒收与修复计数由调用方报告。
 */
import { numericOf } from './grading.ts'

// ---------------------------------------------------------------- 转义损坏修复

/** 控制字符 → 被吃掉转义的首字母（\t→t、\a→响铃、\f→换页、\b→退格、\v→纵表）。
 * \n 与 \r 可能是合法换行：只尝试修复，不判损坏。 */
const CTRL_TO_LETTER: Record<string, string> = {
  '\t': 't', '\n': 'n', '\r': 'r', '\x0C': 'f', '\x07': 'a', '\x08': 'b', '\x0B': 'v',
}

/** 已知 LaTeX 命令片段表：首字母 → 去首字母后的剩余段（匹配时长段优先）。 */
const CMD_TAILS: Record<string, string[]> = {
  t: ['therefore', 'imes', 'heta', 'ext', 'an', 'au', 'o'],
  n: ['abla', 'eq'],
  r: ['ightarrow', 'ho'],
  f: ['rac', 'orall'],
  a: ['pprox', 'lpha', 'ngle'],
  b: ['eta', 'ar'],
  v: ['arepsilon', 'ec'],
}

/** \n/\r 修复的接受风险：合法换行后恰接 eq/abla 等片段的中文正文实际不存在，
 * 误修概率远小于 \neq/\nabla 被双引号吃掉的概率，故照常还原并计入修复数。 */

/** 高危控制字符：模型产出内容里从不合法出现，修复不掉即判转义损坏。 */
const RISK_CTRL = /[\t\x07\x0C\x08\x0B]/

/** 其余不可打印控制字符（含 DEL）：一律判损坏。 */
const ANY_CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

export interface EscapeRepairResult {
  text: string
  /** 成功还原的转义损坏处数。 */
  repaired: number
  /** 存在修复不掉的高危控制字符（该字符串整体不可信）。 */
  unrepairable: boolean
}

/** 确定性修复 YAML/JSON 双引号转义吃掉 LaTeX 命令的损坏：控制字符 + 后续文本
 * 命中已知命令片段表时还原为 `\命令`；修不掉的高危控制字符保留原文并标记不可修复。 */
export function repairModelEscapes(s: string): EscapeRepairResult {
  let out = ''
  let repaired = 0
  let unrepairable = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const letter = CTRL_TO_LETTER[ch]
    if (!letter) {
      out += ch
      continue
    }
    const rest = s.slice(i + 1)
    const tails = [...(CMD_TAILS[letter] ?? [])].sort((a, b) => b.length - a.length)
    const hit = tails.find(t => rest.startsWith(t))
    if (hit) {
      out += `\\${letter}${hit}`
      i += hit.length
      repaired++
      continue
    }
    if (ch !== '\n' && ch !== '\r') unrepairable = true
    out += ch
  }
  if (ANY_CTRL.test(out)) unrepairable = true
  return { text: out, repaired, unrepairable }
}

/** 字符串是否带转义损坏特征（体检用：题面含高危控制字符即疑似损坏）。 */
export function hasEscapeCorruption(s: string): boolean {
  return RISK_CTRL.test(s) || ANY_CTRL.test(s)
}

// ---------------------------------------------------------------- 记法契约检测

/** 剥掉数学定界与代码：$$…$$、$…$、围栏代码块、行内代码——记法检测只看剩余正文。 */
function stripMathAndCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ')
}

/** 记法契约（ADR-0030）：剥掉数学与代码后，残留 ASCII 上标/下标记号或裸 LaTeX
 * 命令即违规（渲染框架只认 $ 定界符，写了等于没写）。高精度信号，宁可漏过无 ^ 的
 * 纯 ASCII 数学也不误杀正常题面。 */
export function notationViolation(text: string): string | null {
  const t = stripMathAndCode(text)
  if (t.includes('^')) return '数学记法违规：ASCII 上标 ^——数学一律写入 $…$（KaTeX 记法）'
  if (/[A-Za-z0-9]_[A-Za-z0-9]/.test(t)) return '数学记法违规：ASCII 下标 _——数学一律写入 $…$（KaTeX 记法）'
  if (/\\[A-Za-z]{2,}/.test(t)) return '数学记法违规：裸 LaTeX 命令缺 $…$ 定界符'
  return null
}

// ---------------------------------------------------------------- 唯一答案填空边界

/** 填空答案疑似代数式的记号信号（含除号/根号；不含连字符——中文术语合法带连字符）。
 * 刻意保持高精度（ADR-0030 宁可漏过不误杀）：连写形如 `2x`/`x2` 不判——`3D打印`、
 * `H2O` 这类含数字字母连写的真实术语会被误杀；漏网部分由模板 v9 文字约束兜底。 */
const EXPRESSION_SIGNS = /[=+*/^\\√]/

/** 唯一答案填空边界（ADR-0029）：答案能解析成数值或疑似代数式即违规。 */
export function blankAnswerViolation(answer: string): string | null {
  const a = answer.trim()
  if (!a) return null
  if (numericOf(a) !== null) return `填空答案是数值「${a}」——数字答案走 numeric 题型（ADR-0029 唯一答案填空）`
  if (EXPRESSION_SIGNS.test(a)) return `填空答案「${a}」疑似代数式——表达式答案走 single_choice（ADR-0029 唯一答案填空）`
  return null
}

// ---------------------------------------------------------------- 单题组合门禁

/** 出题门禁的题目形状（生成产物未过 schema 前字段类型未知）。 */
interface RawQuestion {
  kind?: unknown
  q?: unknown
  answer?: unknown
  options?: unknown
  explanation?: unknown
}

/** texts 中首个记法违规（无则 null）——出题门禁与存量体检共用。 */
function firstNotationViolationOf(texts: ReadonlyArray<unknown>): string | null {
  for (const t of texts) {
    if (typeof t !== 'string') continue
    const v = notationViolation(t)
    if (v) return v
  }
  return null
}

/** 字符串/字符串数组答案的首个填空边界违规（无则 null）——两处门禁共用。 */
function firstBlankAnswerViolationOf(answer: unknown): string | null {
  const answers = Array.isArray(answer)
    ? answer.map(a => String(a))
    : typeof answer === 'string' ? [answer] : []
  for (const a of answers) {
    const v = blankAnswerViolation(a)
    if (v) return v
  }
  return null
}

/** 出题门禁：单题的首个记法/边界违规原因（无违规返回 null）。转义修复先于本检查。 */
export function questionViolation(q: RawQuestion): string | null {
  if (q.kind === 'fill_in_blank') {
    // 唯一答案填空（ADR-0029）先判——它是比记法违规更精确的诊断，且填空答案本就允许写进 LaTeX（如 $x^2$）
    const blank = firstBlankAnswerViolationOf(q.answer)
    if (blank) return blank
  }
  // answer 数组（matching/ordering 的项文本）也扫记法——渲染契约对一切题面文本生效
  return firstNotationViolationOf([
    q.q, q.explanation,
    ...(Array.isArray(q.options) ? q.options : []),
    ...(Array.isArray(q.answer) ? q.answer : []),
  ])
}

/** 对生成题目做转义修复（就地改写字符串字段），返回修复摘要。 */
export function repairQuestionStrings(q: Record<string, unknown>): { repaired: number; unrepairable: boolean } {
  let repaired = 0
  let unrepairable = false
  const fix = (s: string): string => {
    const r = repairModelEscapes(s)
    repaired += r.repaired
    if (r.unrepairable) unrepairable = true
    return r.text
  }
  if (typeof q.q === 'string') q.q = fix(q.q)
  if (typeof q.explanation === 'string') q.explanation = fix(q.explanation)
  if (typeof q.section === 'string') q.section = fix(q.section)
  for (const key of ['options', 'uses', 'tags'] as const) {
    if (Array.isArray(q[key])) {
      q[key] = (q[key] as unknown[]).map(o => typeof o === 'string' ? fix(o) : o)
    }
  }
  if (typeof q.answer === 'string') q.answer = fix(q.answer)
  if (Array.isArray(q.answer)) q.answer = q.answer.map(o => typeof o === 'string' ? fix(o) : o)
  return { repaired, unrepairable }
}

// ---------------------------------------------------------------- 存量体检（只读）

/** 解析超长软上限（ADR-0029/0030 落地后的存量盘点口径；新题生成契约 ≈150 字）。 */
export const EXPLANATION_SOFT_MAX = 400

/** 体检题目形状（BankQuestion 的只读子集）。 */
export interface AuditQuestion {
  id: string
  kind: string
  q: string
  answer: unknown
  options?: string[]
  explanation?: string
}

/** 单题体检：现行契约下的违规清单（空数组 = 合规）。只读，不改题。 */
export function auditQuestion(q: AuditQuestion): string[] {
  const issues: string[] = []
  const texts = [q.q, ...(q.options ?? []), q.explanation ?? '']
  for (const t of texts) {
    if (hasEscapeCorruption(t)) {
      issues.push('含控制字符——疑似 YAML 双引号转义损坏（\\t/\\a/\\f 被解释）')
      break
    }
  }
  const notation = firstNotationViolationOf(texts)
  if (notation) issues.push(notation)
  if (q.kind === 'fill_in_blank') {
    const blank = firstBlankAnswerViolationOf(q.answer)
    if (blank) issues.push(blank)
  }
  if ((q.explanation?.length ?? 0) > EXPLANATION_SOFT_MAX) {
    issues.push(`解析 ${q.explanation!.length} 字超过软上限 ${EXPLANATION_SOFT_MAX}（读不动等于没写）`)
  }
  return issues
}

export interface QuestionAuditFinding {
  course: string
  node: string
  id: string
  kind: string
  /** 题面截断（定位用）。 */
  q: string
  issues: string[]
}

export interface QuestionAuditReport {
  banks: number
  questions: number
  flagged: number
  findings: QuestionAuditFinding[]
}
