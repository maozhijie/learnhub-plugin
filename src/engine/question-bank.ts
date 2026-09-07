/**
 * 题库（P4，抄 allo 题型体系）：课程根/题库/<节点>.yaml，人类可读可手编。
 *
 * schema（单文件一节点）：
 *   node: 自然数
 *   questions:
 *     - id: q1
 *       kind: single_choice | true_false | fill_in_blank | reflection
 *             | multi_choice | numeric | ordering | matching | open_question
 *       q: 题干
 *       answer: "B" | true | ["答案1","答案2"] | 评分要点
 *               | ["A","C"](多选字母) | 数值 | [正确顺序项](排序) | [右列配对](匹配) | 参考要点(开放)
 *       options: ["A. …","B. …"]        # single_choice/multi_choice 必填；ordering=乱序项；matching=左列
 *       tol: 0.01                       # numeric 可选容差
 *       explanation: 解析                # 可选
 *       difficulty: 1-3                  # 可选
 *       uses: [前置技能]                  # 可选
 *
 * 判卷语义 = allo evaluate：对 1.0 / 错 0.0；reflection/open_question 走 AI 判卷
 * （open_question 0–10 分制，≥6 及格）。作答副作用 = practice 流水 + frontmatter
 * 计数/EMA（调度仍走 D15 settle）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import { normChoice, numericOf } from './grading.ts'
import type { AlloKind } from './grading.ts'
import type { FsrsBlock } from './types.ts'
import type { Paths } from './paths.ts'
import { safeFilename } from './paths.ts'

export interface BankQuestion {
  id: string
  kind: AlloKind
  q: string
  answer: string | boolean | string[]
  options?: string[]
  explanation?: string
  difficulty?: number
  uses?: string[]
  tags?: string[]
  /** numeric 题的数值容差（缺省 0）。 */
  tol?: number
  /** 来源正文节标题（mastery 会话按节轮转出题；缺省归入「通用」收尾轮）。 */
  section?: string
  archived?: boolean
  /** 题目级 FSRS 调度（刷卡模型：每题一张卡，作答对错驱动推进）。 */
  fsrs?: FsrsBlock
  /** 作答统计（节点掌握度 = 各题该数据的汇总）。 */
  stats?: { attempts: number; correct: number; last?: string }
}

export interface BankDoc { node: string; questions: BankQuestion[] }

const KINDS: AlloKind[] = [
  'single_choice', 'true_false', 'fill_in_blank', 'reflection',
  'multi_choice', 'numeric', 'ordering', 'matching', 'open_question',
]

/** question_update 允许修订的作者字段（白名单）；其余键（身份/调度/统计/归档）必须走独立操作。 */
const QUESTION_AUTHORING_FIELDS = new Set([
  'q', 'answer', 'options', 'explanation', 'difficulty', 'uses', 'tags', 'section', 'tol',
])

function bankError(op: string, path: string, detail: string): Error {
  return new Error(`[${op}] 题库 Broken（位置：${path}）\n  ✗ ${detail}`)
}

/** 题库 schema 校验（手写，错误行风格与引擎其余门禁一致）。 */
export function validateBank(doc: unknown, expectedNode?: string): { errors?: string[]; spec?: BankDoc } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (typeof d.node !== 'string' || !d.node.trim()) errors.push('node: 不能为空')
  if (!Array.isArray(d.questions) || !d.questions.length) errors.push('questions: 题组为空')
  const questions: BankQuestion[] = []
  if (Array.isArray(d.questions)) {
    d.questions.forEach((raw, i) => {
      const n = i + 1
      if (typeof raw !== 'object' || raw === null) {
        errors.push(`questions.${n}: 必须是映射`)
        return
      }
      const e = raw as Record<string, unknown>
      const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `q${n}`
      if (!KINDS.includes(e.kind as AlloKind)) {
        errors.push(`questions.${n}.kind: 非法题型 ${String(e.kind)}（允许 ${KINDS.join('/')}）`)
        return
      }
      if (typeof e.q !== 'string' || !e.q.trim()) {
        errors.push(`questions.${n}.q: 题干不能为空`)
        return
      }
      const kind = e.kind as AlloKind
      const answer = e.answer
      if (kind === 'single_choice') {
        const options = Array.isArray(e.options) ? e.options.map(String) : []
        const letters = options.map((_, j) => String.fromCharCode(65 + j))
        if (!options.length || typeof answer !== 'string' || !letters.includes(normChoice(answer))) {
          errors.push(`questions.${n}: single_choice 需要 options 且 answer 为合法选项字母（选项 ${options.length} 个）`)
          return
        }
      } else if (kind === 'true_false') {
        if (typeof answer !== 'boolean' && !['true', 'false', '对', '错', '正确', '错误', '是', '否'].includes(String(answer))) {
          errors.push(`questions.${n}: true_false 的 answer 必须是布尔或对/错`)
          return
        }
      } else if (kind === 'fill_in_blank') {
        const accepted = Array.isArray(answer) ? answer.map(String) : typeof answer === 'string' ? [answer] : []
        if (!accepted.length) {
          errors.push(`questions.${n}: fill_in_blank 的 answer 必须是字符串或字符串列表（可接受答案）`)
          return
        }
      } else if (kind === 'reflection') {
        if (typeof answer !== 'string' || !answer.trim()) {
          errors.push(`questions.${n}: reflection 的 answer 必须是评分要点文本`)
          return
        }
      } else if (kind === 'multi_choice') {
        const options = Array.isArray(e.options) ? e.options.map(String) : []
        const letters = options.map((_, j) => String.fromCharCode(65 + j))
        const picks = Array.isArray(answer) ? answer.map(a => String(a).trim()) : []
        if (options.length < 2 || !picks.length || picks.some(p => !letters.includes(normChoice(p)))) {
          errors.push(`questions.${n}: multi_choice 需要 options（≥2）且 answer 为合法选项字母数组`)
          return
        }
      } else if (kind === 'numeric') {
        if (numericOf(String(answer)) === null) {
          errors.push(`questions.${n}: numeric 的 answer 必须是数值（支持小数/分数/百分数）`)
          return
        }
        if (e.tol !== undefined && !(Number(e.tol) > 0)) {
          errors.push(`questions.${n}: numeric 的 tol 必须是正数`)
          return
        }
      } else if (kind === 'ordering') {
        const options = Array.isArray(e.options) ? e.options.map(String) : []
        const seq = Array.isArray(answer) ? answer.map(String) : []
        const same = options.length >= 2 && seq.length === options.length
          && [...seq].sort().join('\u0000') === [...options].sort().join('\u0000')
        if (!same) {
          errors.push(`questions.${n}: ordering 需要 options（≥2 乱序项）且 answer 为同一组项的正确顺序排列`)
          return
        }
      } else if (kind === 'matching') {
        const options = Array.isArray(e.options) ? e.options.map(String) : []
        const pairs = Array.isArray(answer) ? answer.map(String) : []
        if (options.length < 2 || pairs.length !== options.length || pairs.some(p => !p.trim())) {
          errors.push(`questions.${n}: matching 需要 options（左列 ≥2）且 answer 为与左列一一对应的右列文本数组`)
          return
        }
      } else if (kind === 'open_question') {
        if (answer !== undefined && answer !== null && typeof answer !== 'string') {
          errors.push(`questions.${n}: open_question 的 answer 必须是参考要点文本（可省略）`)
          return
        }
      }
      questions.push({
        id,
        kind,
        q: String(e.q).trim(),
        answer: kind === 'numeric' ? String(answer)
          : Array.isArray(answer) ? answer.map(String) : answer as string | boolean,
        ...(Array.isArray(e.options) && e.options.length ? { options: e.options.map(String) } : {}),
        ...(typeof e.explanation === 'string' && e.explanation ? { explanation: e.explanation } : {}),
        ...(e.difficulty !== undefined && Number.isInteger(Number(e.difficulty)) ? { difficulty: Number(e.difficulty) } : {}),
        ...(Array.isArray(e.uses) && e.uses.length ? { uses: e.uses.map(String) } : {}),
        ...(Array.isArray(e.tags) && e.tags.length ? { tags: e.tags.map(String) } : {}),
        ...(kind === 'numeric' && Number(e.tol) > 0 ? { tol: Number(e.tol) } : {}),
        ...(typeof e.section === 'string' && e.section.trim() ? { section: e.section.trim() } : {}),
        ...(e.archived === true ? { archived: true } : {}),
        // 调度/统计块由作答侧写入，schema 只透传不做内部校验
        ...(e.fsrs && typeof e.fsrs === 'object' ? { fsrs: e.fsrs as FsrsBlock } : {}),
        ...(e.stats && typeof e.stats === 'object' ? { stats: e.stats as BankQuestion['stats'] } : {}),
      })
    })
  }
  if (errors.length) return { errors }
  const spec: BankDoc = { node: (d.node as string).trim(), questions }
  if (expectedNode && spec.node !== expectedNode) {
    return { errors: [`node「${spec.node}」与命令行节点「${expectedNode}」不一致`] }
  }
  return { spec }
}

export class QuestionBank {
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  bankPath(courseRoot: string, node: string): string {
    return `${courseRoot}/题库/${safeFilename(node)}.yaml`
  }

  /** 读某节点题库；文件缺失返回空题库（合法 Missing）；存在但 YAML/契约坏则抛 Broken。 */
  async load(courseRoot: string, node: string): Promise<BankDoc> {
    const p = this.bankPath(courseRoot, node)
    if (!existsSync(p)) return { node, questions: [] }
    const text = await this.readBankText(p)
    const doc = this.parseBankDoc(p, text)
    const v = validateBank(doc, node)
    if (v.errors) throw bankError('question-load', p, v.errors.join('；'))
    return v.spec!
  }

  private async readBankText(p: string): Promise<string> {
    try {
      return await readFile(p, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw bankError('question-load', p, `无法读取: ${message}`)
    }
  }

  private parseBankDoc(p: string, text: string): Record<string, unknown> {
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw bankError('question-load', p, `YAML 无法解析: ${message}`)
    }
    if (typeof doc !== 'object' || doc === null) {
      throw bankError('question-load', p, '顶层必须是映射（node/questions）')
    }
    return doc as Record<string, unknown>
  }

  /** 校验并写入题库 YAML（LLM 产出过门禁后落盘）。 */
  async save(courseRoot: string, yamlText: string, expectedNode?: string): Promise<{ node: string; count: number; path: string }> {
    const doc = YAML.parseModel(yamlText)
    const v = validateBank(doc, expectedNode)
    if (v.errors) throw new Error(`[question-save] schema 校验失败，题库未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const p = this.bankPath(courseRoot, spec.node)
    await mkdir(p.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    await writeFile(p, YAML.stringify(doc), 'utf8')
    return { node: spec.node, count: spec.questions.length, path: p }
  }

  // ---- 单题操作（题目管理面板用；每次写回前全量过 validateBank 门禁）----

  /** 读并校验已有题库原始 YAML 文档（缺失返回 null；存在但 Broken 抛错，绝不静默当空库）。 */
  private async loadDoc(courseRoot: string, node: string): Promise<Record<string, unknown> | null> {
    const p = this.bankPath(courseRoot, node)
    if (!existsSync(p)) return null
    const doc = this.parseBankDoc(p, await this.readBankText(p))
    const v = validateBank(doc, node)
    if (v.errors) throw bankError('question-load', p, v.errors.join('；'))
    return doc
  }

  private async writeDoc(courseRoot: string, node: string, doc: unknown): Promise<void> {
    const p = this.bankPath(courseRoot, node)
    await mkdir(p.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    await writeFile(p, YAML.stringify(doc), 'utf8')
  }

  /** 追加单题 → 新题 id 与题库总题数。 */
  async addQuestion(courseRoot: string, node: string, question: Record<string, unknown>): Promise<{ id: string; count: number }> {
    const doc = await this.loadDoc(courseRoot, node) ?? { node, questions: [] as Array<Record<string, unknown>> }
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const id = typeof question.id === 'string' && question.id.trim() ? question.id.trim() : `q${list.length + 1}`
    if (list.some(q => (q as { id?: unknown }).id === id)) {
      throw new Error(`[question-add] 题目 id「${id}」已存在。`)
    }
    const next = [...list, { ...question, id }]
    const v = validateBank({ ...doc, questions: next }, node)
    if (v.errors) throw new Error(`[question-add] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, questions: next })
    return { id, count: next.length }
  }

  /** 更新单题作者字段（patch 白名单合并；id 不可改）。
   * 空 patch、未知字段、身份/调度/统计/归档字段一律拒绝——归档走 archiveQuestion 独立操作。 */
  async updateQuestion(courseRoot: string, node: string, qid: string, patch: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(patch)
    if (!keys.length) throw new Error(`[question-update] ${node} 的题库：patch 不能为空（空 patch 是 no-op，拒绝）。`)
    const unknown = keys.filter(k => !QUESTION_AUTHORING_FIELDS.has(k))
    if (unknown.length) {
      throw new Error(`[question-update] ${node} 的题库：patch 含不允许的字段 ${JSON.stringify(unknown)}（只允许 ${[...QUESTION_AUTHORING_FIELDS].join('/')}；id/kind/node/fsrs/stats/archived 是身份或派生块，不能经内容修订改动）`)
    }
    const doc = await this.loadDoc(courseRoot, node)
    if (!doc) throw new Error(`[question-update] ${node} 没有题库文件。`)
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const idx = list.findIndex(q => (q as { id?: unknown }).id === qid)
    if (idx < 0) throw new Error(`[question-update] ${node} 的题库没有 ${qid}。`)
    const merged = { ...list[idx], ...patch, id: qid }
    const next = [...list]
    next[idx] = merged
    const v = validateBank({ ...doc, questions: next }, node)
    if (v.errors) throw new Error(`[question-update] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, questions: next })
  }

  /** 引擎内部作答侧写回：题目级 FSRS/作答统计是派生证据，只能整体替换，不经作者白名单。 */
  async updateQuestionEvidence(
    courseRoot: string,
    node: string,
    qid: string,
    patch: { fsrs?: FsrsBlock | null; stats?: BankQuestion['stats'] },
  ): Promise<void> {
    const doc = await this.loadDoc(courseRoot, node)
    if (!doc) throw new Error(`[question-evidence] ${node} 没有题库文件。`)
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const idx = list.findIndex(q => (q as { id?: unknown }).id === qid)
    if (idx < 0) throw new Error(`[question-evidence] ${node} 的题库没有 ${qid}。`)
    const next = [...list]
    const current = { ...list[idx] }
    if (patch.fsrs !== undefined) {
      if (patch.fsrs === null) delete current.fsrs
      else current.fsrs = patch.fsrs
    }
    if (patch.stats !== undefined) {
      current.stats = patch.stats
    }
    next[idx] = current
    const v = validateBank({ ...doc, questions: next }, node)
    if (v.errors) throw new Error(`[question-evidence] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, questions: next })
  }

  /** 归档/取消归档单题（归档题在 questionsAll 里仍可见并带标记，作答侧过滤）。 */
  async archiveQuestion(courseRoot: string, node: string, qid: string, archived: boolean): Promise<void> {
    const doc = await this.loadDoc(courseRoot, node)
    if (!doc) throw new Error(`[question-archive] ${node} 没有题库文件。`)
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const hit = list.find(q => (q as { id?: unknown }).id === qid)
    if (!hit) throw new Error(`[question-archive] ${node} 的题库没有 ${qid}。`)
    if (archived) (hit as { archived?: boolean }).archived = true
    else delete (hit as { archived?: boolean }).archived
    const v = validateBank({ ...doc, questions: list }, node)
    if (v.errors) throw new Error(`[question-archive] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, questions: list })
  }
}
