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
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { atomicWrite } from './io.ts'
import { YAML } from './yaml.ts'
import { clamp01, normChoice, numericOf } from './grading.ts'
import type { AlloKind } from './grading.ts'
import type { FsrsBlock } from './types.ts'
import type { Paths } from './paths.ts'
import type { ErrorCards } from './error-cards.ts'
import type { ConceptRegistry } from './concepts.ts'
import { Content } from './content.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import { asFm, loadNote, saveNote } from './notes.ts'
import type { FSRS } from 'ts-fsrs'
import { NOTE_SOURCE_COURSE } from './types.ts'
import type { EncEdge, ErratumRec, Fm, CourseEntry, JournalRec, PracticeRec, NoteSourceEntry, GRegion } from './types.ts'
import type { AdviceDismissRec } from './bank-advice.ts'
import type { LlmComplete } from './llm.ts'
import type { ExplainPoint } from './explain.ts'
import { advanceStrict } from './advance.ts'
import { sectionEntryOf } from './attribution.ts'
import { nodeTierOf, perSectionQuizTarget, sectionTierLabel } from './complexity.ts'
import { invokesTagged, invokesUnregistered, namesOf } from './concepts.ts'
import { dayOfTs, nowIsoOf } from './dates.ts'
import type { Clock } from './clock.ts'
import { DISPUTE_REVIEW_SYSTEM, PASS_SCORE, applyPracticeEvidence, evaluateAllo, parseDisputeReview, revealAnswer, netPracticeRecs } from './grading.ts'
import { FSRS_DIFFICULTY_MID } from './params.ts'
import { assertNoBrokenNotes, Sessions } from './sessions.ts'
import { masteryOfFm, effectiveStage } from './srs.ts'
import { xpForAnswer } from './xp.ts'
import { normSectionKey } from './attribution.ts'
import { adviceDismissKey, calibrationAdvice, tooEasyAdvice } from './bank-advice.ts'
import { cleanupCandidatesForNode } from './bank-cleanup.ts'
import type { CleanupReason } from './bank-cleanup.ts'
import { sectionBody } from './compass.ts'
import { ERROR_CARD_BATCH_MAX, MIN_ERROR_LAPSES, mineErrorPatterns, validateErrorCards } from './error-cards.ts'
import type { ErrorCard } from './error-cards.ts'
import { bankStemList, existingStemsPromptBlock, findDuplicateStem } from './question-dedup.ts'
import { questionViolation, repairQuestionStrings, auditQuestion } from './question-hygiene.ts'
import type {
  CleanupGroup, CleanupPreviewDoc, DifficultyAdviceDoc, DisputeApplyResult, DisputeReviewResult,
  ErrorAnswerResult, ErrorArchiveResult, ErrorCardItem, ErrorGenerateResult, ErrorMineDoc, ErrorQueueDoc,
  QuestionGetDoc, QuestionsAllDoc,
} from './views/bank.ts'
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
  /** numeric 题的数值容差（缺省极小相对容差，判卷侧兜底浮点毛刺）。 */
  tol?: number
  /** 来源正文节标题（mastery 会话按节轮转出题；缺省归入「通用」收尾轮）。 */
  section?: string
  /** 出生打标的概念引用（#141 一枚 invokes；#148 出生打标全链）：登记表在册名字
   * （canonical 或别名）；缺席恒合法 Missing。 */
  invokes?: string
  archived?: boolean
  /** 归档原因（skip=节点跳过自动归档 / cleanup=一键清理 / too_easy=过于简单建议
   * 确认 / erratum=瑕疵题作废 / manual=人工）。恢复归档时一并清除（ADR-0032）。 */
  archived_reason?: string
  /** 题目级 FSRS 调度（刷卡模型：每题一张卡，作答对错驱动推进）。 */
  fsrs?: FsrsBlock
  /** 作答统计（节点掌握度 = 各题该数据的汇总）。pending_rating = 复习刷卡流答对后
   * 待自评结算的挂起标记（questionRate 落盘时清除）。last_correct = 最近一次真实
   * 作答的对错（questions 读视图的 lastCorrect 原料，ADR-0027 直通卡）。 */
  stats?: { attempts: number; correct: number; last?: string; pending_rating?: boolean; last_correct?: boolean }
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

/** 写入侧答案形态门禁（prompt 约束的服务端兜底）：multi_choice 至少 2 个正确项。
 * 只拦写入（生成入库/修订），不做进 validateBank 的读取门禁——存量题库里
 * 历史生成的单正确项多选不该让整个题库读成 Broken（显式盘点修复，ADR-0004）。 */
export function questionAnswerShapeError(q: { kind?: unknown; answer?: unknown; options?: unknown }): string | null {
  if (q.kind !== 'multi_choice') return null
  const options = Array.isArray(q.options) ? q.options : []
  const picks = Array.isArray(q.answer) ? q.answer : []
  if (options.length >= 2 && picks.length >= 2
    && picks.every(p => typeof p === 'string' && p.trim())) return null
  return 'multi_choice 需要 options（≥2）且 answer 为**至少 2 个**合法选项字母数组（出题约束 1 的服务端兜底）'
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
      // 一枚 invokes（#141/#148）：出生打标的概念引用，登记表在册名字；缺席/空串 =
      // 合法 Missing（静默当缺席）；给了就必须是字符串（读侧折叠按 invokes 聚合，坏形态在这里拦）
      if (e.invokes !== undefined && e.invokes !== null && typeof e.invokes !== 'string') {
        errors.push(`questions.${n}.invokes: 必须是概念名字符串（一枚 invokes：登记表在册名字）；缺席/空串 = 合法 Missing`)
        return
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
        ...(typeof e.invokes === 'string' && e.invokes.trim() ? { invokes: e.invokes.trim() } : {}),
        ...(e.archived === true ? { archived: true } : {}),
        ...(typeof e.archived_reason === 'string' && e.archived_reason ? { archived_reason: e.archived_reason } : {}),
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
    await atomicWrite(p, YAML.stringify(doc))
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
    await atomicWrite(p, YAML.stringify(doc))
  }

  /** 追加单题 → 新题 id 与题库总题数。 */
  async addQuestion(courseRoot: string, node: string, question: Record<string, unknown>): Promise<{ id: string; count: number }> {
    const doc = await this.loadDoc(courseRoot, node) ?? { node, questions: [] as Array<Record<string, unknown>> }
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const id = typeof question.id === 'string' && question.id.trim() ? question.id.trim() : `q${list.length + 1}`
    if (list.some(q => (q as { id?: unknown }).id === id)) {
      throw new Error(`[question-add] 题目 id「${id}」已存在。`)
    }
    const shapeErr = questionAnswerShapeError(question)
    if (shapeErr) throw new Error(`[question-add] ${shapeErr}`)
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
    const shapeErr = questionAnswerShapeError(merged)
    if (shapeErr) throw new Error(`[question-update] ${qid}：${shapeErr}`)
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

  /** 归档/取消归档单题（归档题在 questionsAll 里仍可见并带标记，作答侧过滤）。
   * reason 记入 archived_reason（ADR-0032：skip/cleanup/too_easy/erratum/manual），
   * 恢复时与 flag 一并清除。 */
  async archiveQuestion(courseRoot: string, node: string, qid: string, archived: boolean, reason?: string): Promise<void> {
    const doc = await this.loadDoc(courseRoot, node)
    if (!doc) throw new Error(`[question-archive] ${node} 没有题库文件。`)
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const hit = list.find(q => (q as { id?: unknown }).id === qid)
    if (!hit) throw new Error(`[question-archive] ${node} 的题库没有 ${qid}。`)
    const rec = hit as { archived?: boolean; archived_reason?: string }
    if (archived) {
      rec.archived = true
      rec.archived_reason = reason?.trim() || 'manual'
    } else {
      delete rec.archived
      delete rec.archived_reason
    }
    const v = validateBank({ ...doc, questions: list }, node)
    if (v.errors) throw new Error(`[question-archive] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, questions: list })
  }

  /** 批量归档/恢复（skip 扫描与一键清理消费）：一次 load-validate-write 落盘，
   * 避免逐题整文件重写；返回实际改动的题数。reason 语义同 archiveQuestion。 */
  async archiveQuestions(courseRoot: string, node: string, qids: string[], archived: boolean, reason?: string): Promise<number> {
    if (!qids.length) return 0
    const doc = await this.loadDoc(courseRoot, node)
    if (!doc) throw new Error(`[question-archive] ${node} 没有题库文件。`)
    const list = Array.isArray(doc.questions) ? doc.questions as Array<Record<string, unknown>> : []
    const want = new Set(qids)
    let changed = 0
    for (const raw of list) {
      const q = raw as { id?: unknown; archived?: boolean; archived_reason?: string }
      if (!want.has(String(q.id))) continue
      if (archived) {
        q.archived = true
        q.archived_reason = reason?.trim() || 'manual'
      } else {
        delete q.archived
        delete q.archived_reason
      }
      changed++
    }
    const v = validateBank({ ...doc, questions: list }, node)
    if (v.errors) throw new Error(`[question-archive] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, questions: list })
    return changed
  }
}

// ---- Bank 子系统（#152 刀 6 / ADR-0043）：题库域——C-3 错误对比卡、面板题目管理、
// B2 难度感知回流、题库一键清理、瑕疵题勘误与判罚冲正。住领主文件 question-bank.ts
// （聚合+转发）；跨子系统依赖经结构化窄面 BankDeps 由门面注入（运行时回引门面，
// 类型面零门面导入——R6）。

/** Bank 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface BankDeps {
  /** 时钟端口（#175 阶段①）：勘误/回收站戳与移入回收站的唯一性后缀。 */
  clock: Clock
  /** store/registry/proposals 均为结构化窄面：question-bank 被通道域（note-source）
   * 反向 type-import，任何引向 store/registry/proposals 下游的类类型都会合拢成环（R7）。 */
  store: {
    appendErratum(rec: Omit<ErratumRec, 'ts'> & { ts?: string }): Promise<ErratumRec>
    appendJournal(rec: Omit<JournalRec, 'ts'> & { ts?: string }): Promise<JournalRec>
    appendPractice(rec: Omit<PracticeRec, 'ts'> & { ts?: string }): Promise<PracticeRec>
    erratumAll(): Promise<ErratumRec[]>
    loadAdviceDismissals(): Promise<AdviceDismissRec[]>
    practiceAll(): Promise<PracticeRec[]>
    saveAdviceDismissals(list: AdviceDismissRec[]): Promise<void>
  }
  paths: Paths
  registry: {
    enabled(): Promise<CourseEntry[]>
    get(key: string): Promise<CourseEntry | null>
    load(): Promise<CourseEntry[]>
    resolve(key?: string): Promise<CourseEntry>
    save(courses: CourseEntry[], noteSources?: NoteSourceEntry[]): Promise<void>
  }
  bank: QuestionBank
  errorCards: Pick<ErrorCards, 'addCards' | 'archiveCard' | 'load' | 'updateCardEvidence'>
  concepts: Pick<ConceptRegistry, 'load'>
  proposals: {
    ensureNotesFor(root: string, regions: GRegion[]): Promise<number>
  }
  /** 课程调度器实例缓存（FSRS 写回后失效用）。 */
  schedCache: Map<string | null, FSRS>
  sched(courseRoot: string | null): Promise<FSRS>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  loadPrompt(kind: string): Promise<string>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }>
  saveNodeNote(path: string, fm: Fm, body: string): Promise<void>
  vaultPriorFor(graph: Graph, node: string): Promise<string>
  logGradingFailure(rec: { course: string; node: string; qid: string; kind: string; attempt: number; error: string; raw: string }): Promise<void>
  questionContext(courseKey: string | undefined, node: string, qid: string, op: string): Promise<{ c: CourseEntry; graph: Graph; q: BankQuestion; idx: number }>
  exerciseGated(c: CourseEntry, node: string): Promise<boolean>
  repairInvokesOnce(llm: LlmComplete, items: unknown[], scope: string[]): Promise<number>
  admitQuestion(root: string, node: string, q: Record<string, unknown>, stem: string, existingStems: Array<{ q: string; kind?: string; difficulty?: number }>): Promise<{ verdict: 'added' } | { verdict: 'duplicate'; against: string } | { verdict: 'invalid' }>
  explainPoints(c: CourseEntry, graph: Graph, node: string): Promise<ExplainPoint[]>
  isNoteSourceCourse(courseKey: string | undefined): Promise<boolean>
}

export class BankSubsystem {
  constructor(private e: BankDeps) {}

// ---- 门面原分节：C3 ----
// ---- 门面原分节：panel ----
// ---- 门面原分节：B2 ----
// ---- 门面原分节：cleanup ----
// ---- 门面原分节：erratum ----


  /** 挖矿预览（只读）：当前流水中的高频错误模式候选（同一题 ≥MIN_ERROR_LAPSES 次
   * 实质答错；忘记申报不是错法证据）。人工抽查入口——生成走 errorCardGenerate，
   * 本方法零写入。 */
  async errorCardMine(courseKey: string | undefined, node?: string): Promise<ErrorMineDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const candidates = mineErrorPatterns(await this.e.store.practiceAll(),
      { course: c.name, ...(node ? { node } : {}) })
    return { course: c.name, candidates }
  }


  /** 在册错误卡全展开（(course, node, card) 三元组，文件名序稳定）：空目录 = 合法
   * 空态、Broken 卡组跳过不阻塞（体检面报出）。复习队列、全量清单、生成去重三处同缝。 */
  private async *errorCardTriples(
    courses: ReadonlyArray<{ name: string; root: string }>, nodeFilter?: string,
  ): AsyncGenerator<{ course: string; node: string; card: ErrorCard }> {
    for (const c of courses) {
      let files: string[] = []
      try {
        files = await readdir(this.e.paths.errorCardsDir(c.root))
      } catch {
        continue // 该课程还没有任何错误卡：合法空态
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const node = f.replace(/\.yaml$/, '')
        if (nodeFilter !== undefined && node !== nodeFilter) continue
        try {
          const doc = await this.e.errorCards.load(c.root, node)
          for (const card of doc.cards) {
            if (!card.archived) yield { course: c.name, node, card }
          }
        } catch {
          continue // Broken 卡组不阻塞其他卡（data-check 体检面报出）
        }
      }
    }
  }


  /** 全课程活跃错误卡已覆盖的 (node,qid) 集合（生成去重；Broken 文件跳过不阻塞）。 */
  private async errorCardCovered(course: { name: string; root: string }): Promise<Set<string>> {
    const covered = new Set<string>()
    for await (const { node, card } of this.errorCardTriples([course])) {
      covered.add(`${node}\n${card.source_q}`)
    }
    return covered
  }


  /** 生成错误对比卡（C-3）：挖矿 → 取前 ERROR_CARD_BATCH_MAX 个未覆盖候选 →
   * 原题材料（题干/答案/解析/学习者错答/节正文节选）喂「错误对比卡」提示词 →
   * 模型 YAML 过 schema 门禁（含 (node,source_q) 必须命中候选）逐节点落盘。
   * 归 learner-cards 同款事务性：模型产出不可解析/未过门禁时抛错零落盘。
   * 创建零 XP、零 canonical 写入——卡入错误 deck，复习时才走无绑定 XP。 */
  async errorCardGenerate(
    courseKey: string | undefined, opts: { node?: string; max?: number } | undefined,
    llm: LlmComplete,
  ): Promise<ErrorGenerateResult> {
    const c = await this.e.registry.resolve(courseKey)
    const candidates = mineErrorPatterns(await this.e.store.practiceAll(),
      { course: c.name, ...(opts?.node ? { node: opts.node } : {}) })
    const covered = await this.errorCardCovered(c)
    const fresh = candidates.filter(x => !covered.has(`${x.node}\n${x.qid}`))
    if (!fresh.length) {
      throw new Error('[error-card-generate] 没有可挖的新错误模式（判定线：同一题 ≥2 次实质答错且尚未建卡）；候选已被覆盖或证据不足。')
    }
    // max 只是下调旋钮（批上限硬帽 ERROR_CARD_BATCH_MAX 防注水；工具面宣称的 cap 在此强制）
    const max = Math.max(1, Math.min(opts?.max ?? ERROR_CARD_BATCH_MAX, ERROR_CARD_BATCH_MAX, fresh.length))
    // 图视图加载一次（fail loud——图 Broken 不能被静默读成先验缺席，Missing/Broken 两态
    // 不混同）；节误解先验（#147 出生期候选错法）取材于此，先验缺席仍合法。
    const { graph, state } = await this.e.loadView(c)
    const skipped: string[] = []
    interface Mat { node: string; qid: string; section: string | null; sectionBody: string | null }
    const mats: Array<Mat & { material: string }> = []
    for (const x of fresh.slice(0, max)) {
      let q: BankQuestion | undefined
      try {
        const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), x.node)
        q = bank.questions.find(q => q.id === x.qid && !q.archived)
      } catch {
        q = undefined
      }
      if (!q) {
        skipped.push(`${x.node}/${x.qid}（原题缺失或已归档，无法对照出卡）`)
        continue
      }
      // 节正文节选（答案对照面）：来源节命中该节正文，否则整课节选兜底（同 errorExplainPack 定位语义）
      let sectionTitle: string | null = null
      let sectionBody: string | null = null
      try {
        const manifest = state[x.node]?.content.sections
        const entry = sectionEntryOf(q.section, manifest)
        const sections = await this.e.explainPoints(c, graph, x.node)
        const hit = entry ? sections.find(s => s.title === entry.title) : null
        const point = hit ?? sections[0]
        if (point) {
          sectionTitle = entry?.title ?? point.title
          sectionBody = point.md.slice(0, 800)
        }
      } catch {
        // 正文缺失不阻塞生成：原题解析已足够对照
      }
      const wrongs = x.wrongs.map(w => `「${w}」`).join('、')
      const mis = graph.misconceptionsOf[x.node] ?? []
      mats.push({
        node: x.node, qid: x.qid, section: q.section ?? sectionTitle,
        sectionBody,
        material: [
          `### 候选：节点「${x.node}」 qid=${x.qid}（实质答错 ${x.lapses} 次）`,
          `- 题型：${q.kind}`,
          `- 原题题干：${q.q}`,
          ...(q.options?.length ? [`- 原题选项：${q.options.join(' | ')}`] : []),
          `- 原题正确答案：${typeof q.answer === 'boolean' ? (q.answer ? '对' : '错') : String(q.answer)}`,
          ...(q.explanation ? [`- 原题解析：${q.explanation}`] : []),
          `- 学习者的错答（去重，最近在前）：${wrongs}`,
          ...(mis.length ? [`- 误解先验（出生期候选错法；「干扰做法」项可从中改编，mine 仍以学习者错答为准）：${mis.map(m => `${m.concept}（${m.model}）`).join('；')}`] : []),
          ...(sectionBody ? [`- 来源节「${sectionTitle}」正文节选：${sectionBody}`] : []),
        ].join('\n'),
      })
    }
    if (!mats.length) {
      throw new Error(`[error-card-generate] 候选的原题全部缺失/归档，无法生成：${skipped.join('；')}`)
    }
    const tpl = await this.e.loadPrompt('错误对比卡')
    const prompt = `${tpl}\n\n## 挖出的错误模式（${mats.length} 个候选，每个候选出一张卡）\n\n${mats.map(m => m.material).join('\n\n')}`
    // 机械出卡调用恒走 fast 档（#137：档位沿缝声明，宿主适配器翻译成部署思考档）
    const raw = await llm(prompt, undefined, { effort: 'fast' })
    const doc = YAML.parseModel(raw) as { cards?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.cards) || !doc.cards.length) {
      throw new Error('[error-card-generate] 模型没有产出可用卡清单（cards 为空或不可解析），零落盘。')
    }
    const offered = new Set(mats.map(m => `${m.node}\n${m.qid}`))
    const byNode = new Map<string, Array<Record<string, unknown>>>()
    const errors: string[] = []
    const cardsRaw = doc.cards as Array<Record<string, unknown>>
    cardsRaw.forEach((e, i) => {
      const n = i + 1
      const node = typeof e.node === 'string' ? e.node.trim() : ''
      const qid = typeof e.source_q === 'string' ? e.source_q.trim() : ''
      if (!offered.has(`${node}\n${qid}`)) {
        errors.push(`cards.${n}: (node, source_q)=(${node || '空'}, ${qid || '空'}) 不在候选清单内（必须照抄系统给出的候选）`)
        return
      }
      const list = byNode.get(node) ?? []
      list.push({ ...e, kind: 'contrast', source_node: node, source_q: qid })
      byNode.set(node, list)
    })
    if (errors.length) {
      throw new Error(`[error-card-generate] 模型产出未过候选对照门，零落盘。\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const generated: Array<{ node: string; ids: string[]; count: number }> = []
    for (const [node, cards] of byNode) {
      const v = validateErrorCards({ node, cards })
      if (v.errors) {
        throw new Error(`[error-card-generate] 「${node}」的卡未过 schema 门禁，零落盘。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
      }
      const r = await this.e.errorCards.addCards(c.root, node,
        v.spec!.cards.map(({ kind: _kind, id: _id, source_node: _sn, archived: _a, fsrs: _f, stats: _st, ...rest }) => rest))
      generated.push({ node, ids: r.ids, count: r.count })
    }
    return { course: c.name, generated, ...(skipped.length ? { skipped } : {}) }
  }


  /** 错误卡作答结算（自动判分）：三选一答案唯一——选对=rating 3、选错=rating 1，
   * 一卡一学习日一次推进（stats.last 把守）。只推卡自身 FSRS（sched(null) 默认参数）；
   * 选对入无绑定 XP（xp_error 行，只计总账/目标/streak），选错 0 XP 同样留净行；
   * 复习日志/practice/节点调度面零写入。 */
  async errorCardAnswer(
    courseKey: string | undefined, node: string, cardId: string, choice: string,
  ): Promise<ErrorAnswerResult> {
    const pick = String(choice ?? '').trim()
    const c = await this.e.registry.resolve(courseKey)
    const doc = await this.e.errorCards.load(c.root, node)
    const card = doc.cards.find(x => x.id === cardId && !x.archived)
    if (!card) throw new Error(`[error-answer] 「${node}」的错误卡没有 ${cardId}（或已归档）。`)
    if (!card.options.includes(pick)) {
      throw new Error(`[error-answer] 所选选项不在本题三个选项内（收到「${pick.slice(0, 60)}」）。`)
    }
    const correct = pick === card.answer
    const rating = correct ? 3 : 1
    const { today } = await this.e.learningDay()
    // ADR-0014 advanceStrict：守门即原 stats.last 检查（一卡一天一次），文案是测试契约
    const pushed = advanceStrict(await this.e.sched(null), card, rating, today,
      `[error-answer] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    await this.e.errorCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats: pushed.stats })
    const diff = card.fsrs?.difficulty && card.fsrs.difficulty > 0 ? card.fsrs.difficulty : FSRS_DIFFICULTY_MID
    const xp = correct ? xpForAnswer(card.kind, diff, true, null, true).xp : 0
    await this.e.store.appendJournal({
      course: '*', node: '*', rating, kind: 'xp_error', elapsed_days: 0, xp,
      detail: `错误对比卡 ${c.name}/${node}#${cardId}（${correct ? 'correct 3' : 'wrong 1'}）`,
    })
    return {
      course: c.name, node, id: cardId, correct, rating,
      answer: card.answer, mine: card.mine, explanation: card.explanation,
      due: pushed.fs.due, scheduled: true, xp,
    }
  }


  /** 「错误卡」全量清单（管理面/agent 清点用）：到期卡按 due 升序在前，从未调度的
   * 新卡随后。复习呈现已并入 reviewQueue（C-3）——本清单只做全量盘点（含答案与
   * 错法标注，供人工抽查「错误模式合理」验收）。 */
  async errorCardQueue(courseKey?: string, today?: string): Promise<ErrorQueueDoc> {
    today ??= (await this.e.learningDay()).today
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const cards: ErrorCardItem[] = []
    for await (const { course, node, card } of this.errorCardTriples(courses)) {
      cards.push({
        course, node, id: card.id, q: card.q, options: card.options,
        answer: card.answer, mine: card.mine, explanation: card.explanation,
        source_q: card.source_q, source_section: card.source_section ?? null,
        due: card.fsrs?.reps ? card.fsrs.due : null,
        attempts: card.stats?.attempts ?? 0,
      })
    }
    const due = cards.filter(c => c.due !== null && String(c.due) <= today)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || `${a.node}/${a.id}`.localeCompare(`${b.node}/${b.id}`))
    const fresh = cards.filter(c => c.due === null)
      .sort((a, b) => `${a.node}/${a.id}`.localeCompare(`${b.node}/${b.id}`))
    return { date: today, total: cards.length, due_count: due.length, cards: [...due, ...fresh] }
  }


  /** 归档/恢复一张错误卡（管理面）：错误 deck 内部动作，canonical 零写入。 */
  async errorCardArchive(
    courseKey: string | undefined, node: string, cardId: string, archived: boolean,
  ): Promise<ErrorArchiveResult> {
    const c = await this.e.registry.resolve(courseKey)
    await this.e.errorCards.archiveCard(c.root, node, cardId, archived)
    return { course: c.name, node, id: cardId, archived }
  }

  /** 全部题库条目（题目管理列表；不含答案，带到期与统计）。 */
  async questionsAll(courseKey?: string): Promise<QuestionsAllDoc> {
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.registry.enabled()
    const out: Array<Record<string, unknown>> = []
    for (const c of courses) {
      let files: string[] = []
      try {
        files = await readdir(this.e.paths.bankDir(c.root))
      } catch {
        continue
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const node = f.replace(/\.yaml$/, '')
        const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
        bank.questions.forEach((q, i) => {
          out.push({
            course: c.name, node, qid: q.id, no: i + 1, kind: q.kind, q: q.q,
            difficulty: q.difficulty ?? 1, tags: q.tags ?? [],
            archived: q.archived === true,
            ...(q.archived_reason ? { archivedReason: q.archived_reason } : {}),
            hasExplanation: Boolean(q.explanation),
            // 调度字段（题目管理页「到期」列消费；未进调度的题为 null）
            due: q.fsrs?.reps ? q.fsrs.due : null,
            lastReview: q.fsrs?.reps ? q.fsrs.last_review : null,
            ...(q.options?.length ? { options: q.options } : {}),
            ...(q.kind === 'matching' && Array.isArray(q.answer)
              ? { pairOptions: [...new Set(q.answer as string[])] } : {}),
          })
        })
      }
    }
    return { total: out.length, questions: out }
  }

  /** 节点级只读检测：扫题库 stats/fsrs（bank per-qid）+ masteryOfFm + 门槛 →
   * {低掌握校准建议, 全对归档建议} 清单，供 orchestrator/harness 在出题与题目管理
   * 动作前消费。建议先行不自动改库——再生成走既有 question_generate/question_save
   * 与单节重写通道，归档走题目管理的独立归档操作；practice 节点无题库天然静默；
   * Broken 笔记 fail loud（与 status/recommend 同一门前置）。
   * 被忽略的建议（adviceDismiss）不进 nodes，只以 dismissed 计数带出（恢复入口消费）。 */
  async difficultyAdvice(courseKey?: string): Promise<DifficultyAdviceDoc> {
    const { today } = await this.e.learningDay()
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const dismissedKeys = new Set((await this.e.store.loadAdviceDismissals()).map(d => adviceDismissKey(d.course, d.node, d.qid)))
    let dismissed = 0
    const nodes: Array<Record<string, unknown>> = []
    for (const c of courses) {
      const { graph, state, broken } = await this.e.loadView(c)
      assertNoBrokenNotes('difficulty-advice', broken)
      await this.e.scanCourseBanks(c, async (node, bank) => {
        const fm = state[node]
        if (!fm || graph.typeOf[node] === 'practice') return // practice 节点无题库，合法空态
        const qs = bank.questions.filter(q => !q.archived)
        let attempts = 0
        let correct = 0
        for (const q of qs) {
          attempts += q.stats?.attempts ?? 0
          correct += q.stats?.correct ?? 0
        }
        const calibration = calibrationAdvice({
          stage: effectiveStage(state, node),
          attempts,
          accuracy: attempts ? correct / attempts : null,
          mastery: masteryOfFm(fm),
          bloom: graph.bloomOf[node],
        })
        const tooEasy = tooEasyAdvice(qs).filter(t => {
          if (dismissedKeys.has(adviceDismissKey(c.name, node, t.qid))) {
            dismissed++
            return false
          }
          return true
        })
        if (!calibration && !tooEasy.length) return
        nodes.push({
          course: c.name, node,
          ...(calibration ? { calibration } : {}),
          ...(tooEasy.length ? { too_easy: tooEasy } : {}),
        })
      })
    }
    return { date: today, nodes, dismissed }
  }


  /** 忽略/恢复一条「过于简单」建议（持久忽略清单，学习中心 state/难度建议忽略.json）：
   * undo=false 追加（幂等），true 移除；all=true 清空恢复。误判的恢复成本为零——
   * 与「建议先行、不自动移除」同一立场（ADR-0032 同期）。 */
  async adviceDismiss(course: string, node: string, qid: string | undefined, undo = false, all = false): Promise<{ dismissed: AdviceDismissRec[] }> {
    let list = await this.e.store.loadAdviceDismissals()
    if (all) {
      list = []
    } else if (undo) {
      list = list.filter(d => !(d.course === course && d.node === node && d.qid === qid))
    } else {
      if (!qid) throw new Error('[advice-dismiss] 忽略必须带 qid（恢复可用 all=true 清空）。')
      const key = adviceDismissKey(course, node, qid)
      if (!list.some(d => adviceDismissKey(d.course, d.node, d.qid) === key)) {
        list = [...list, { course, node, qid, date: (await this.e.learningDay()).today }]
      }
    }
    await this.e.store.saveAdviceDismissals(list)
    return { dismissed: list }
  }


  async questionAdd(courseKey: string, node: string, question: Record<string, unknown>): Promise<{ course: string; node: string; id: string; count: number }> {
    const c = await this.e.registry.resolve(courseKey)
    const r = await this.e.bank.addQuestion(this.e.paths.courseRoot(c.root), node, question)
    return { course: c.name, node, ...r }
  }


  /** 单题全量读取（含 answer/explanation）：修订/审题用——questionList 不带答案（作答流防泄题），改题前用这个看原题。
   * 笔记源卡（course=「笔记源」伪课程）同通道可读：漂移后审旧题用。 */
  async questionGet(courseKey: string | undefined, node: string, qid: string): Promise<QuestionGetDoc> {
    if (await this.e.isNoteSourceCourse(courseKey)) {
      const bank = await this.e.bank.load(this.e.paths.noteSourceDir, node)
      const q = bank.questions.find(x => x.id === qid)
      if (!q) throw new Error(`[question-get] 笔记源「${node}」的题库没有 ${qid}（共 ${bank.questions.length} 题）。`)
      return { course: NOTE_SOURCE_COURSE, node, question: q }
    }
    const c = await this.e.registry.resolve(courseKey)
    const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-get] 「${node}」的题库没有 ${qid}（共 ${bank.questions.length} 题）。`)
    return { course: c.name, node, question: q }
  }


  async questionUpdate(courseKey: string, node: string, qid: string, patch: Record<string, unknown>): Promise<{ course: string; node: string; qid: string }> {
    const c = await this.e.registry.resolve(courseKey)
    await this.e.bank.updateQuestion(this.e.paths.courseRoot(c.root), node, qid, patch)
    return { course: c.name, node, qid }
  }


  /** 归档/取消归档单题。笔记源卡（course=「笔记源」伪课程）同通道：漂移提示的
   * 「归档旧题」直达动作走这里（学习中心/笔记源 镜像题库）。reason 记入
   * archived_reason（ADR-0032：too_easy=建议确认、manual=人工等），恢复时清除。 */
  async questionArchive(courseKey: string, node: string, qid: string, archived: boolean, reason?: string): Promise<{ course: string; node: string; qid: string; archived: boolean }> {
    if (await this.e.isNoteSourceCourse(courseKey)) {
      await this.e.bank.archiveQuestion(this.e.paths.noteSourceDir, node, qid, archived, reason)
      return { course: NOTE_SOURCE_COURSE, node, qid, archived }
    }
    const c = await this.e.registry.resolve(courseKey)
    await this.e.bank.archiveQuestion(this.e.paths.courseRoot(c.root), node, qid, archived, reason)
    return { course: c.name, node, qid, archived }
  }

  /** 清理预览（只读）：两条规则扫全部启用课程——跳过节点全部未归档题 +
   * 已完成节点的休眠题。按课程/节点分组带题面样本，确认后才 apply。 */
  async bankCleanupPreview(courseKey?: string): Promise<CleanupPreviewDoc> {
    const { today } = await this.e.learningDay()
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const groups: CleanupGroup[] = []
    let total = 0
    for (const c of courses) {
      const { state } = await this.e.loadView(c)
      await this.e.scanCourseBanks(c, async (node, bank) => {
        const stage = state[node]?.stage
        const cands = cleanupCandidatesForNode(stage, bank.questions)
        if (!cands.length) return
        const reasons: Record<CleanupReason, number> = { skipped_node: 0, dormant_after_complete: 0 }
        for (const x of cands) reasons[x.reason]++
        const byId = new Map(bank.questions.map(q => [q.id, q]))
        total += cands.length
        groups.push({
          course: c.name, node, stage: stage ?? 'ready', count: cands.length, reasons,
          stems: cands.slice(0, 3).map(x => (byId.get(x.qid)?.q ?? '').slice(0, 80)),
        })
      })
    }
    return { date: today, total, groups }
  }


  /** 清理应用：按当前预览逐题归档（reason=cleanup，可逆；恢复走题库管理面）。
   * 预览与应用之间库可能变化——apply 现算一遍候选，不做两阶段锁。 */
  async bankCleanupApply(courseKey?: string): Promise<{ course: string; node: string; archived: number }[]> {
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const done: Array<{ course: string; node: string; archived: number }> = []
    for (const c of courses) {
      const { state } = await this.e.loadView(c)
      const courseRoot = this.e.paths.courseRoot(c.root)
      await this.e.scanCourseBanks(c, async (node, bank) => {
        const cands = cleanupCandidatesForNode(state[node]?.stage, bank.questions)
        if (cands.length) {
          await this.e.bank.archiveQuestions(courseRoot, node, cands.map(x => x.qid), true, 'cleanup')
          done.push({ course: c.name, node, archived: cands.length })
        }
      })
    }
    return done
  }

  /** 被申诉作答的定位与准入：该题最近一条判错的 practice 记录，未被冲正过。
   * 目标 = 最近一条（练习会话的即时申诉与直通卡/复习流的「最近一次答错」一致）。
   * AI 判卷题型（reflection/open_question）不在申诉范围（Q8 裁定）：评分异议走
   * 既有「讲解这道题」通道，判卷故障已有 #116 逃生门。 */
  private async disputeTarget(courseKey: string | undefined, node: string, qid: string, op: string) {
    const { c, graph, q } = await this.e.questionContext(courseKey, node, qid, op)
    if (q.kind === 'reflection' || q.kind === 'open_question') {
      throw new Error(`[${op}] AI 判卷题型（reflection/open_question）不走申诉：评分异议用「讲解这道题」，判卷故障有逃生门。`)
    }
    const rec = (await this.e.store.practiceAll())
      .filter(r => r.course === c.name && r.node === node && r.qid === qid && r.correct === false)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .at(-1)
    if (!rec) throw new Error(`[${op}] ${node}/${qid} 没有可申诉的判错作答记录（申诉只针对判错的作答）。`)
    const errata = await this.e.store.erratumAll()
    if (errata.some(e => e.target_ts === rec.ts && e.qid === qid)) {
      throw new Error(`[${op}] ${node}/${qid} 最近一条判错作答（${rec.ts}）已被冲正过，同一条作答至多申诉一次。`)
    }
    return { c, graph, q, rec }
  }


  /** 申诉复核（只读，不落盘）：LLM 两阶段复核——先独立解题再对账，三态裁定。
   * 解析失败自动重问一次，仍失败抛「AI 复核输出不可用」（UI 据此放行跳过复核的
   * 直接豁免降级入口）；原始输出照 #116 惯例留痕判卷失败.jsonl。 */
  async questionDisputeReview(
    llmComplete: LlmComplete,
    courseKey: string | undefined, node: string, qid: string,
  ): Promise<DisputeReviewResult> {
    const { c, graph, q, rec } = await this.disputeTarget(courseKey, node, qid, 'dispute')
    const note = await this.e.nodeNote(c, graph, node)
    const entry = sectionEntryOf(q.section, note.fm?.content.sections)
    const sectionMd = entry
      ? Sessions.lessonSections(note.body).find(s => s.title === entry.title)?.md ?? null
      : null
    const forgot = rec.judge === 'forget'
    const prompt = [
      '# 复核一道练习题的申诉', '',
      '学习者作答被判错并申诉「题目错了」。请严格按两阶段复核：',
      '1. **独立解题**：只看题面自己完整解一遍（此阶段忽略下面给出的存储答案键），写出过程与你的答案；',
      '2. **对账**：把你的独立结果与存储答案键/解析、以及学习者作答逐一比对；',
      '3. 按系统提示的三态规则给出裁定。', '',
      '## 题目', q.q,
      ...(q.options?.length ? q.options.map((o, i) => `- ${String.fromCharCode(65 + i)}. ${o}`) : []),
      '', `存储的答案键：${revealAnswer(q)}`,
      ...(q.explanation ? ['', `存储的解析：${q.explanation}`] : []),
      '', '## 学习者的作答',
      forgot ? '（空——学习者按「忘记」翻面，未作答）' : (rec.answer || '（空作答）'),
      '', '## 对应节正文（超纲判定依据）',
      ...(entry && sectionMd
        ? [`（来自节「${entry.title}」）`, '', sectionMd.slice(0, 4000)]
        : ['（未能定位到具体节——以下为整课节选）', '', note.body.replace(/^>\s*内容待生成。\s*$/m, '').trim().slice(0, 2500)]),
    ].join('\n')
    let lastError = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ask = attempt === 1
        ? prompt
        : `${prompt}\n\n[重判要求] 上一次输出无法解析为复核结果。这一次只输出一个 JSON 对象（shape 见系统提示），不要任何其他文字、解释或代码围栏。`
      const raw = await llmComplete(ask, DISPUTE_REVIEW_SYSTEM)
      try {
        const v = parseDisputeReview(raw)
        return {
          course: c.name, node, qid,
          target_ts: rec.ts,
          verdict: v.verdict,
          reasoning: v.reasoning,
          current_answer: revealAnswer(q),
          ...(v.suggested_answer !== undefined
            ? { suggested_answer: v.suggested_answer as DisputeReviewResult['suggested_answer'] } : {}),
          ...(v.suggested_explanation ? { suggested_explanation: v.suggested_explanation } : {}),
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        await this.e.logGradingFailure({ course: c.name, node, qid, kind: 'dispute-review', attempt, error: lastError, raw })
      }
    }
    throw new Error(`[dispute] AI 复核输出不可用，未做任何改动（可重试，或跳过复核直接豁免本题）：${lastError}`)
  }


  /** 申诉结算（落盘）：resolution 三选一。
   * - rekey：按 revision 修订题目（改键/解析，questionUpdate 作者门禁+形态门禁），
   *   用新键重判原作答——原作答符合新键则改判为对（XP 按对题补记、frontmatter
   *   correct+1、EMA 补 0.3 步）；不符合则只修键，判罚维持。
   * - void / overridden：本次作答作废（判卷逃生门口径）——XP 净值归零（乱猜罚随减）、
   *   attempts−1、EMA 逆向一步；void 语义 = 题是瑕疵题，归档随结算原子落盘（重出走
   *   生成队列、可重试）；overridden = 复核判题没问题但学习者坚持豁免（题保留在调度里）。
   * 共同边界（ADR-0031）：FSRS 不回滚、review-log 不抹；冲正走 勘误.jsonl 追加 +
   * 聚合账净额重算（practice.jsonl 永不改写）。EMA/frontmatter 计数是增量聚合，
   * 逆向调整在「争议条为该节点最新证据」时精确，否则为可接受的近似（派生读侧）；
   * rekey 且原作答与新键仍不符 = 净零变动（只修键，证据不动）。 */
  async questionDisputeApply(
    courseKey: string | undefined, node: string, qid: string,
    resolution: 'rekey' | 'void' | 'overridden',
    opts?: { targetTs?: string; revision?: { answer?: unknown; explanation?: string }; reason?: string },
  ): Promise<DisputeApplyResult> {
    if (resolution !== 'rekey' && resolution !== 'void' && resolution !== 'overridden') {
      throw new Error(`[dispute-apply] resolution 必须是 rekey/void/overridden（收到 ${String(resolution)}）。`)
    }
    const { c, graph, rec } = await this.disputeTarget(courseKey, node, qid, 'dispute-apply')
    if (opts?.targetTs && opts.targetTs !== rec.ts) {
      throw new Error(`[dispute-apply] targetTs 与该题最近判错记录不一致（${opts.targetTs} ≠ ${rec.ts}）——复核后题目状态可能已变化，请重新申诉。`)
    }
    const { cutoff } = await this.e.learningDay()
    let verdict: ErratumRec['verdict']
    let xpNet = rec.xp ?? 0
    let correctNow: boolean | null = false

    if (resolution === 'rekey') {
      const answer = opts?.revision?.answer
      if (answer === undefined || answer === null || (typeof answer === 'string' && !answer.trim())) {
        throw new Error('[dispute-apply] rekey 需要 revision.answer（新答案键）。')
      }
      const patch: Record<string, unknown> = { answer }
      if (typeof opts?.revision?.explanation === 'string' && opts.revision.explanation.trim()) {
        patch.explanation = opts.revision.explanation
      }
      await this.e.bank.updateQuestion(this.e.paths.courseRoot(c.root), node, qid, patch)
      const fresh = (await this.e.bank.load(this.e.paths.courseRoot(c.root), node)).questions.find(x => x.id === qid)
      if (!fresh) throw new Error(`[dispute-apply] ${node}/${qid} 改键后读取失败。`)
      // 重判原作答：空作答（忘记翻面）必然不符，且 evaluateAllo 对空作答按题型抛错——直接判不符
      const r = rec.answer && rec.judge !== 'forget'
        ? (() => { try { return evaluateAllo(fresh, rec.answer) } catch { return { score: 0 } } })()
        : { score: 0 }
      correctNow = r.score >= PASS_SCORE
      verdict = 'key_error'
      if (correctNow) {
        // 改判对：对题 XP 补记（豁免永不产生得分，改判只来自键修改后的重判）；乱猜罚随键纠正一并消失
        xpNet = xpForAnswer(fresh.kind, fresh.difficulty ?? 1, true, null, true).xp
      }
    } else {
      verdict = resolution === 'void' ? 'defective' : 'overridden'
      xpNet = 0 // 作废：本次作答 XP 净值归零（乱猜 −1 罚随之返还）
    }

    // 题目 stats 从净流水重算（作废剔除该条；改判按新对错计；rekey 维持 = 原样重写）；
    // FSRS 块不动
    const errata = await this.e.store.erratumAll()
    const pending: ErratumRec = {
      ts: nowIsoOf(this.e.clock.nowMs()), course: c.name, node, qid, target_ts: rec.ts,
      verdict, xp: xpNet,
      ...(correctNow === true ? { correct: true } : {}),
      ...(resolution === 'rekey' ? { revision: opts?.revision ?? {} } : {}),
      ...(opts?.reason?.trim() ? { reason: opts.reason.trim().slice(0, 500) } : {}),
    }
    const net = netPracticeRecs(
      (await this.e.store.practiceAll()).filter(r => r.course === c.name && r.node === node && r.qid === qid),
      [...errata, pending],
    )
    const latest = [...net].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)
    const stats = {
      attempts: net.length,
      correct: net.filter(r => r.correct === true).length,
      ...(latest ? { last: dayOfTs(latest.ts, cutoff), last_correct: latest.correct === true } : {}),
    }
    await this.e.bank.updateQuestionEvidence(this.e.paths.courseRoot(c.root), node, qid, { stats })

    // 节点 frontmatter 逆向调整：作废 = 撤 0 分步（attempts−1、EMA ÷0.7）；改判对 =
    // 撤 0 分步再补 1 分步（净 +0.3）；rekey 且判罚维持 = 净零变动（证据不动，只修键）。
    const evidenceChange = resolution !== 'rekey' || correctNow === true
    const note = await this.e.nodeNote(c, graph, node)
    let fmAfter = note.fm
    if (note.fm && evidenceChange) {
      const round3 = (x: number) => Math.round(clamp01(x) * 1000) / 1000
      const practice = {
        attempts: Math.max(0, note.fm.practice.attempts + (resolution === 'rekey' ? 0 : -1)),
        correct: Math.max(0, note.fm.practice.correct + (correctNow ? 1 : 0)),
      }
      const ema = note.fm.practice_ema
      const practice_ema = correctNow
        ? (ema === undefined ? 1 : round3(ema + 0.3))
        : (ema === undefined ? undefined : round3(ema / 0.7))
      fmAfter = {
        ...note.fm, practice,
        ...(practice_ema !== undefined ? { practice_ema } : {}),
      }
      await this.e.saveNodeNote(note.path, fmAfter, note.body)
    }
    await this.e.store.appendErratum(pending)
    if (resolution === 'void') {
      // 瑕疵题的归档随作废结算原子落盘（ADR-0031）：重出走生成队列（可重试），
      // 不再由 UI 两段拼接留下「已作废未归档」的悬空态。归档原因 erratum（ADR-0032）。
      await this.e.bank.archiveQuestion(this.e.paths.courseRoot(c.root), node, qid, true, 'erratum')
    }
    return {
      course: c.name, node, qid, resolution,
      verdict,
      correct_now: resolution === 'rekey' ? correctNow : null,
      xp: xpNet,
      ...(resolution === 'void' ? { archived: true } : {}),
      ...(fmAfter ? { mastery: masteryOfFm(fmAfter) } : {}),
    }
  }


  /** AI 出题：节点正文 → 出题提示词 + llm → 产出的题库 YAML 逐题过 validateBank 门禁追加落盘。
   * llm 由 host 注入（输出可能带 markdown 围栏，解析侧 parseModel 统一剥离）。骨架节点（无正文）直接报错。
   * count 缺省 = 既有默认 6（定向补生成 = 3）；一旦给出必须是正整数，非法值不改写成默认（#12）。
   * opts.sections = 节标注清单（逐节管线）：模型照抄清单节 id 进 section 字段；
   * opts.generic = 只出跨节综合题（section 强制「通用」，逐节管线收尾用）；
   * opts.section = 定向补生成（#117）：只为本节补题——提示词只附该节正文、产物强制
   *   section: s.id，与清单不符的先按标题归一化（剥「类型：」前缀+去空白，同会话口径）
   *   回填，仍无法归类的题拒收并在返回结果中报告（fail loud，不兜底挂「通用」）；
   * opts.instruction = 生成指令（#120 提意见重生成的学习者意见），原样注入提示词；
   * 防相似（#119）：提示词注入题库已有题面 ≤15 条（只题面/题型/难度），生成后逐题
   *   程序化查重（归一化精确 + trigram ≥0.8），命中的丢弃不入库并在 duplicates 报告。
   * 出生打标（#148）：概念清单（本节 teaches ∪ 前置闭包 teaches）在场时逐题必须恰一枚
   *   invokes——缺席先走一次补标调用（修复一次），仍空拒收并报告；清单缺席（存量/手编
   *   图）invokes 恒合法 Missing。返回的 enc = 题目 invokes 覆盖率投影（出生 w 作回退
   *   初值，随生长批经 set_enc 写入）。
   * opts.isCancelled = 逐题检查的取消旗标（GenJob 取消语义，#118）。 */
  async questionGenerate(
    courseKey: string | undefined, node: string, count?: number,
    llm: LlmComplete,
    opts?: {
      sections?: Array<{ id: string; title: string }>
      generic?: boolean
      section?: { id: string; title: string }
      instruction?: string
      isCancelled?: () => boolean
    },
  ): Promise<{
    course: string; node: string; added: number; skipped: number; total: number
    duplicates: Array<{ q: string; against: string }>
    rejected: Array<{ q: string; reason: string }>
    /** 转义损坏修复处数（ADR-0030：确定性修复留痕，不静默）。 */
    escapesRepaired: number
    /** invokes 覆盖率投影（#148）：节点全部在库题目的 enc 边候选（出生 w），随生长批 set_enc 写入。 */
    enc: EncEdge[]
  }> {
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
      throw new Error(`[quiz] count 必须是正整数（收到 ${String(count)}）；省略才使用默认。`)
    }
    const requested = count ?? (opts?.section ? 3 : 6)
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[quiz] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'quiz')
    // invokes 概念引用对表基线（#141）：登记表在册名字集，出题受理门逐题对照
    const conceptNames = namesOf(await this.e.concepts.load(c.root))
    const [, regionName] = graph.blockOf[node]
    const note = await loadNote(this.e.paths.courseNotePath(c.root, regionName, node))
    const body = note.body.replace(/^>\s*内容待生成。\s*$/m, '').trim()
    if (!body) throw new Error(`[quiz] 「${node}」还没有正文——先「生成正文」再出题。`)
    const tpl = await this.e.loadPrompt('题目生成')
    const tier = nodeTierOf(graph, node)
    const prior = await this.e.vaultPriorFor(graph, node)
    // 已有题面（#119）：注入提示词 + 查重基线（归档题不参与——归档旧题后按意见重出同题面是合法意图）
    const bankBefore = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
    const existingStems = bankStemList(bankBefore)

    // 定向补生成：只附该节正文（找不到该节 fail loud），节标注 = 单节强绑指令
    let contentBody = body
    let listing: string
    if (opts?.section) {
      const s = opts.section
      const md = sectionMdOf(body, s.title)
      if (md === null) throw new Error(`[quiz] 正文里找不到节「${s.title}」——定向补题需要该节正文，请先确认节标题。`)
      contentBody = `## ${s.title}\n\n${md}`
      listing = `\n\n## 节标注清单\n\n本批全部题目都属于这一节：section 字段必须精确写「${s.id}」（节标题：${s.title}），不要写「通用」或其他节。`
    } else if (opts?.sections?.length) {
      listing = `\n\n## 节标注清单\n\nsection 字段必须精确取自下列节 id（跨节综合题写「通用」）：\n${opts.sections.map(s => `- ${s.id} ｜ ${s.title}`).join('\n')}`
    } else {
      listing = ''
    }
    const instruction = opts?.instruction?.trim()
      ? `\n\n## 生成指令（学习者意见，优先遵循）\n\n${opts.instruction.trim()}`
      : ''
    const difficultyAnchor = tier === 1
      ? '本节点为低复杂度：题目难度集中在 1-2，不出 difficulty: 3 的收尾难题。'
      : tier === 3
        ? '本节点为高复杂度：收尾可出 1-2 道 difficulty: 3 的综合/易错题。'
        : '本节点为中复杂度：难度递进到 2，收尾至多 1 道 difficulty: 3。'
    const misBlock = misconceptionPromptBlock(graph.misconceptionsOf[node], '干扰项材料')
    // 出生打标（#148）：概念清单 = 本节 teaches ∪ 前置闭包 teaches；空清单 = 门不激活
    const conceptScope = Content.conceptScopeOf(graph, node)
    const conceptBlock = Content.conceptListBlock(conceptScope)
    const raw = await llm(`${tpl}${existingStemsPromptBlock(existingStems)}${listing}${instruction}\n\n## 题目数量\n\n${requested} 道\n\n## 难度锚定\n\n${difficultyAnchor}${misBlock}${conceptBlock}\n\n---\n\n${contentBody}${prior ? `\n\n---\n\n${prior}` : ''}`)
    const doc = YAML.parseModel(raw) as { node?: unknown; questions?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions) || !doc.questions.length) {
      throw new Error('[quiz] 模型没有产出可用题目（questions 为空）。')
    }
    // 出生打标修复轮（#148）：清单在场且有题缺 invokes → 恰一次补标调用；仍空由下方受理门拒收
    if (conceptScope.length) {
      if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
      await this.e.repairInvokesOnce(llm, doc.questions.slice(0, requested), conceptScope)
    }
    // doc.node 只是模型对节点的复述（常自创短名），落盘位置由入参决定，不作硬校验
    let added = 0
    let skipped = 0
    let escapesRepaired = 0
    const duplicates: Array<{ q: string; against: string }> = []
    const rejected: Array<{ q: string; reason: string }> = []
    for (const item of doc.questions.slice(0, requested)) {
      if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
      const q = { ...(item as Record<string, unknown>) }
      delete q.id // id 由 addQuestion 按现有题数自动编号，避免与既有 q1 冲突
      if (opts?.generic) q.section = '通用' // 综合题不绑节（轮装配时统一收尾）
      // 题目卫生（ADR-0029/0030）：先确定性修复转义损坏（计数留痕），修不好或记法/边界违规的题拒收
      const hygiene = repairQuestionStrings(q)
      escapesRepaired += hygiene.repaired
      const stem = typeof q.q === 'string' ? q.q : ''
      const violation = hygiene.unrepairable
        ? '题面含无法修复的转义损坏（控制字符）——YAML 双引号吃掉了 LaTeX 转义'
        : questionViolation(q)
      if (violation) {
        rejected.push({ q: stem.slice(0, 80), reason: violation })
        continue
      }
      // 定向补生成强校验（#117）：不符先按标题归一化回填，仍无法归类拒收并报告
      if (opts?.section) {
        const sec = typeof q.section === 'string' ? q.section : ''
        if (sec !== opts.section.id) {
          if (sec && normSectionKey(sec) === normSectionKey(opts.section.title)) {
            q.section = opts.section.id
          } else {
            rejected.push({ q: stem.slice(0, 80), reason: sec ? `section「${sec}」无法归类到节「${opts.section.title}」` : '缺少 section 标注' })
            continue
          }
        }
      }
      // 写入侧答案形态门禁（多选 ≥2 正确项，prompt 约束 9 的服务端兜底）：
      // 拒收并报告（与 #117 同款 fail loud），不静默降级成 skipped
      const shapeErr = questionAnswerShapeError(q)
      if (shapeErr) {
        rejected.push({ q: stem.slice(0, 80), reason: shapeErr })
        continue
      }
      // invokes 概念引用在册校验（#141 受理门对表）：未在册名字拒收并报告
      const invokesErr = invokesUnregistered(q, conceptNames)
      if (invokesErr) {
        rejected.push({ q: stem.slice(0, 80), reason: invokesErr })
        continue
      }
      // 出生打标门（#148）：清单在场时新题必须带恰一枚 invokes；修复一次仍不合格拒收
      if (conceptScope.length && !invokesTagged(q)) {
        rejected.push({ q: stem.slice(0, 80), reason: 'invokes 未标注恰一枚概念（出生打标；修复一次仍不合格，拒收）' })
        continue
      }
      // 程序化查重（#119）：与已有题、本批已收题比对，命中丢弃并报告
      const verdict = await this.e.admitQuestion(this.e.paths.courseRoot(c.root), node, q, stem, existingStems)
      if (verdict.verdict === 'duplicate') {
        duplicates.push({ q: stem.slice(0, 80), against: verdict.against.slice(0, 80) })
      } else if (verdict.verdict === 'added') {
        added++
      } else {
        skipped++ // 单题非法（如模型超纲出题型）不毁整批，好题照常入库
      }
    }
    if (!added) throw new Error('[quiz] 模型产出的题目全部未过校验门（题型/答案格式不符/记法违规/重复/无法归节/invokes 缺失），一道都没入库。')
    const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
    return { course: c.name, node, added, skipped, total: bank.questions.length, duplicates, rejected, escapesRepaired, enc: Content.invokesProjection(graph, node, bank.questions) }
  }


  /** 逐节出题（逐节管线第 2 段）：每个内容节一次模型调用（出题量随档位锚点：
   * 低/中/高档内容节目标 1/2/3 道，含练习节时 -1），section 服务端强制为该节 id；
   * 练习/交互节跳过，正文未生成的节（断点续跑）跳过。防相似（#119）：提示词注入
   * 节点已有题面 ≤15 条，生成后逐题查重，命中的丢弃并计入 duplicates。
   * 出生打标（#148）：与 questionGenerate 同一门——概念清单在场逐题恰一枚 invokes，
   * 缺席修复一次仍空即弃（不入库）；返回 enc = invokes 覆盖率投影（出生 w 作回退初值）。 */
  async questionGenerateSections(
    courseKey: string | undefined, node: string,
    llm: LlmComplete,
  ): Promise<{ course: string; node: string; added: number; sections: number; duplicates: number; escapesRepaired: number; enc: EncEdge[] }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[quiz] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'quiz')
    const manifest = state[node]?.content.sections
    if (!manifest?.length) throw new Error(`[quiz] 「${node}」没有节清单——先运行大纲。`)
    // invokes 概念引用对表基线（#141）：与 questionGenerate 同一受理门
    const conceptNames = namesOf(await this.e.concepts.load(c.root))
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.e.paths.courseNotePath(c.root, regionName, node))
    const mdByTitle = new Map<string, string>()
    for (const part of body.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      if (title) mdByTitle.set(title, (nl >= 0 ? part.slice(nl + 1) : '').trim())
    }
    const tpl = await this.e.loadPrompt('题目生成')
    const tier = nodeTierOf(graph, node)
    const prior = await this.e.vaultPriorFor(graph, node)
    const priorBlock = prior ? `\n\n---\n\n${prior}` : ''
    // 已有题面（#119）：注入 + 查重基线（本批新收题也进基线，批内互查）
    const bankBefore = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
    const existingStems = bankStemList(bankBefore)
    const stemBlock = existingStemsPromptBlock(existingStems)
    // 出题量弹性（P3，复杂度档案锚点）：每档给内容节目标题量；大纲含练习节时内容节 −1
    // （集中练习模式：读读读→集中练，综合题数随档位而非恒定 3）。
    const hasPracticeSection = manifest.some(s => s.type === '练习')
    const perSection = perSectionQuizTarget(tier, hasPracticeSection)
    const misBlock = misconceptionPromptBlock(graph.misconceptionsOf[node], '干扰项材料')
    // 出生打标（#148）：概念清单整课一次组装，逐节提示词与补标调用共用
    const conceptScope = Content.conceptScopeOf(graph, node)
    const conceptBlock = Content.conceptListBlock(conceptScope)
    let added = 0
    let sections = 0
    let duplicates = 0
    let escapesRepaired = 0
    for (const [si, s] of manifest.entries()) {
      if (s.type === '练习' || s.type === '交互') continue
      const sectionMd = mdByTitle.get(s.title)
      if (!sectionMd) continue
      if (perSection <= 0) continue // 该档位不要求本内容节单独出题（综合题兼底）
      sections++
      // 难度递进锚（#147）：逐节出题按节段难度档走（清单 tier 在场用清单值，缺席按
      // 节位置+节点难度推导）——替换写死的开头 d1/中间 d2/收尾 d3 模板口径。
      const tierLabel = sectionTierLabel(s.tier, graph.difficultyOf[node], graph.estOf[node], si + 1, manifest.length)
      const difficultyAnchor = tierLabel === '低'
        ? '本节难度档：低——题目难度 1 为主（至多 1 道 2），不出 difficulty: 3。'
        : tierLabel === '高'
          ? '本节难度档：高——允许 1-2 道 difficulty: 3 的易错/综合题。'
          : '本节难度档：中——难度递进到 2 即可（收尾至多 1 道 difficulty: 3）。'
      const raw = await llm(`${tpl}${stemBlock}\n\n## 节标注清单\n\nsection 字段必须精确写「${s.id}」（本批全部题目都属于这一节）。\n\n## 题目数量\n\n${perSection} 道\n\n## 难度锚定\n\n${difficultyAnchor}${misBlock}${conceptBlock}\n\n---\n\n## ${s.title}\n\n${sectionMd}${priorBlock}`)
      let doc: { questions?: unknown } | null = null
      try {
        doc = YAML.parseModel(raw) as { questions?: unknown } | null
      } catch {
        continue // 该节模型输出非法 YAML：跳过，综合调用兼底
      }
      if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions)) continue
      // 出生打标修复轮（#148）：清单在场且有题缺 invokes → 恰一次补标调用，仍空由下方门弃
      if (conceptScope.length) await this.e.repairInvokesOnce(llm, doc.questions, conceptScope)
      for (const rawQ of doc.questions) {
        const q: Record<string, unknown> = { ...((rawQ ?? {}) as Record<string, unknown>), section: s.id }
        delete q.id
        // 题目卫生（ADR-0029/0030）：转义修复留痕，修不好或记法/边界违规的题丢弃；
        // invokes 未在册同罪（#141 受理门对表，与 questionGenerate 同口径）；
        // 出生打标门（#148）：清单在场缺 invokes（修复一次仍空）同弃
        const hygiene = repairQuestionStrings(q)
        escapesRepaired += hygiene.repaired
        const stem = typeof q.q === 'string' ? q.q : ''
        if (hygiene.unrepairable || questionViolation(q) || invokesUnregistered(q, conceptNames)) continue
        if (conceptScope.length && !invokesTagged(q)) continue
        const verdict = await this.e.admitQuestion(this.e.paths.courseRoot(c.root), node, q, stem, existingStems)
        if (verdict.verdict === 'duplicate') duplicates++
        else if (verdict.verdict === 'added') added++ // 单题非法（invalid）不毁整批
      }
    }
    const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
    return { course: c.name, node, added, sections, duplicates, escapesRepaired, enc: Content.invokesProjection(graph, node, bank.questions) }
  }


  /** 交互件成绩结算：面板 sandbox iframe 上报 LEARNHUB_COMPLETE → practice 流水 +
   * 练习证据 EMA（复用题库作答链路；judge='interactive'、qid='interactive:<节id>'）。
   * 同一节同日只记一次（防刷）；不碰题目 FSRS（交互件不是题库题），
   * 节点掌握度为口径 B 派生值（masteryOfFm），随练习证据 EMA 变化并即时回传。 */
  async interactiveSettle(
    courseKey: string | undefined, node: string, sectionId: string, score: number, detail?: string,
  ): Promise<{ settled: boolean; mastery: number }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[interactive] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'interactive')
    if (!Number.isFinite(score)) throw new Error('[interactive] score 必须是数字。')
    const clamped = clamp01(score)
    const qid = `interactive:${sectionId}`
    const { today, cutoff } = await this.e.learningDay()
    const played = (await this.e.store.practiceAll()).some(r =>
      r.course === c.name && r.node === node && r.judge === 'interactive' && r.qid === qid
      && dayOfTs(r.ts, cutoff) === today)
    const [, regionName] = graph.blockOf[node]
    const path = this.e.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (played) return { settled: false, mastery: masteryOfFm(fm) }
    await this.e.store.appendPractice({
      course: c.name, node, ex: 0, answer: detail ?? '',
      correct: clamped >= PASS_SCORE, judge: 'interactive', qid,
      ...(detail ? { feedback: detail } : {}),
    })
    let next: Fm | null = null
    if (fm) {
      // probation 在途行使闸（#146）：实验中的插入节点只记流不回流。
      const evidenceGated = await this.e.exerciseGated(c, node)
      next = evidenceGated ? fm : applyPracticeEvidence(fm, clamped)
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await saveNote(path, next as unknown as Record<string, unknown>, body)
    }
    return { settled: true, mastery: masteryOfFm(next) }
  }


  /** 删除课程：注册表移除 + 课程目录移入 学习中心/.trash/（不真删，可手工找回）。 */
  async courseDelete(courseKey: string): Promise<{ removed: string; trash: string; sediment: string }> {
    const c = await this.e.registry.get(courseKey)
    if (!c) throw new Error(`[learnhub] 注册表中没有课程「${courseKey}」。`)
    const rest = (await this.e.registry.load()).filter(x => x.name !== c.name && x.id !== c.id)
    await this.e.registry.save(rest)
    const src = this.e.paths.courseRoot(c.root)
    const trash = `${this.e.paths.trashDir}/${c.root}-${this.e.clock.nowMs()}`
    if (existsSync(src)) {
      await mkdir(this.e.paths.trashDir, { recursive: true })
      await rename(src, trash)
    }
    this.e.schedCache.delete(this.e.paths.courseRoot(c.root)) // 缓存键是 courseRoot 路径，逐课失效须同键
    return {
      removed: c.name, trash,
      // 删除波及面单独确认项（#139）：卡级实例记忆随课进 .trash，沉淀层模型状态保留
      sediment: '沉淀层不受影响：泛用模型状态跨课程删除存活（先验连续，ADR-0034）',
    }
  }


  /** 为课程缺笔记的节点补骨架文件（幂等；存量课程修复/维护用）。 */
  async ensureAllNotes(courseKey?: string): Promise<{ courses: Array<{ course: string; created: number }> }> {
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.registry.enabled()
    const out: Array<{ course: string; created: number }> = []
    for (const c of courses) {
      const { graph } = await this.e.loadView(c)
      const created = await this.e.proposals.ensureNotesFor(c.root, graph.regions)
      out.push({ course: c.name, created })
    }
    return { courses: out }
  }
}

// ---- 门面原模块级 helper（#152 刀 6 随 bank 域方法一并归位）----

/** 从节点正文提取一节的 markdown：先精确标题匹配，再按归一化标题回退；
 * 找不到返回 null（定向补题时 fail loud，不静默附全文）。 */
function sectionMdOf(body: string, title: string): string | null {
  const parts = body.split(/^## /m).slice(1)
  const wanted = normSectionKey(title)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const t = (nl >= 0 ? part.slice(0, nl) : part).trim()
    if (t === title) return (nl >= 0 ? part.slice(nl + 1) : '').trim()
  }
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const t = (nl >= 0 ? part.slice(0, nl) : part).trim()
    if (t && normSectionKey(t) === wanted) return (nl >= 0 ? part.slice(nl + 1) : '').trim()
  }
  return null
}

/** 误解先验注入段（#147 误解目录消费；节点无误解时返回 ''，Missing 合法空态）。
 * 生成期先验——真实错误检测归作答流水挖矿与申诉复核，有真实数据后先验让位，
 * 让位语义由各消费方模板措辞声明（干扰项以生成指令为准、错误卡 mine 以真实错答为准）。 */
function misconceptionPromptBlock(mis: Array<{ concept: string; model: string }> | undefined, use: string): string {
  if (!mis?.length) return ''
  return `\n\n## 误解先验（${use}）\n\n- 本节点登记在册的误解先验（概念：错误模型）：\n${mis.map(m => `- ${m.concept}：${m.model}`).join('\n')}`
}
