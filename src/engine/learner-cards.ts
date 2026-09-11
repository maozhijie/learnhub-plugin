/**
 * 学习者产出卡（E1 / ADR-0009 Learner Output；schema 依据 #45 调研报告）。
 *
 * 独立卡域：课程根/我的卡/<节点>.yaml，独立 schema + 独立门禁，**不入**题库九题型
 * AlloKind、不进 nodeMastery/完成门禁/节点定价的任何消费面（独立目录 = 结构性隔离）。
 * 每卡自带 fsrs 调度块（默认参数，复习对象是卡自身）+ stats.last「一卡一学习日一次
 * 推进」门禁；调度内核复用 srs.applyRatingBlock，srs.ts 零改动。复习呈现并入复习
 * 队列、复习入账走无绑定 XP（ADR-0021）——节点调度面依旧零掺入。
 *
 * 三种卡面：recall_cue 提示重述 / cloze_rewrite 挖空重述 / self_explain 自注讲解。
 * 判分一律走复习自评语义（Hard/Good/Easy + 忘记），不走 evaluateAllo、不做 AI 判分
 * 入账——AI 只在创建时给非控制性反馈（判词入 E 档案）。
 *
 * Missing/Broken 纪律沿用 ADR-0004：文件缺失 = 合法空卡组；存在但坏 = 抛 Broken。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import type { FsrsBlock, Fm, CourseEntry, EArchiveRec, LearnerCardKind } from './types.ts'
import type { Paths } from './paths.ts'
import { safeFilename } from './paths.ts'
import type { Store } from './store.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank, BankDoc } from './question-bank.ts'
import type { Projects } from './projects.ts'
import type { Habits, HabitDoc, HabitRepeatRec, ExecutionIntention } from './habits.ts'
import { automationCurve, habitStreak } from './habits.ts'
import type { Skills, SkillDoc, ExecutionEvidence, ExecutionLogResult, ExecutionSource } from './skills.ts'
import { clampMaintenanceDays, executionRowIdentity, executionXpDetail, laneDue, laneEventKind, ratingFromEvidence } from './skills.ts'
import type { NoteSourceManifest } from './note-source.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import { loadNote } from './notes.ts'
import type { FSRS } from 'ts-fsrs'
import { todayStr, dayOfTs, nowIso } from './dates.ts'
import { nodeKeyOf } from './types.ts'
import { round2 } from './grading.ts'
import { atomicWrite, readLearnhubConfig, writeLearnhubConfig } from './io.ts'
import type { BandPref } from './adaptive.ts'
import { combinedDifficulty } from './adaptive.ts'
import { advanceStrict } from './advance.ts'
import { retrievabilityBlock } from './srs.ts'
import type { DiagnosticItem, RewriteFact, SignalSnapshot } from './attribution.ts'
import { evaluateSectionSignals, formatSignalDetail, parseRewriteDetail, parseSignalDetail } from './attribution.ts'
import { calibrationProfileView } from './calibration.ts'
import type { BandRec } from './coach.ts'
import { COACH_DUE_HARD_R, COACH_HARD_D, coachFeedback, withinCoachWindow } from './coach.ts'
import type { ExplainPoint, ExplainTag } from './explain.ts'
import { explainBackPack, explainFeedbackPrompt, explainFeedbackSystem, parseExplainVerdict } from './explain.ts'
import type { GoalIntentionInput, PinRec } from './goals.ts'
import { normalizeGoalIntention } from './goals.ts'
import { JOL_SAMPLE_RATE } from './jol.ts'
import type { KataAnswer, KataQuestion } from './kata.ts'
import { kataMonday, weekStartOf, weekEndOf, prevWeekStartOf, inWeek } from './kata.ts'
import { KATA_KIND, KATA_EMPTY, KATA_LEARNER_QUESTIONS, buildKataReality, renderKataReality, assembleKataDoc, parseKataBody, kataAnswered, kataEtaSummary } from './kata.ts'
import type { LlmComplete } from './llm.ts'
import { calibrationBins } from './memory.ts'
import { FSRS_DIFFICULTY_MID } from './params.ts'
import type { ReceiptKind, ReceiptLogRec, ReceiptSubmitResult } from './receipts.ts'
import { RECEIPT_KIND_LABEL, receiptsUntilNextFull, submitReceipt } from './receipts.ts'
import { Sessions } from './sessions.ts'
import { selfNoteFeedbackPrompt, selfNoteFeedbackSystem, selfNotePromptOf } from './self-note.ts'
import { writeOutputArtifact } from './output.ts'
import { execRecsAll } from './project-exec.ts'
import type { ProjectExecRec } from './project-exec.ts'
import type {
  CalibrationProfileDoc, HabitShowDoc, HabitsListDoc, KataDoc, LearnerQueueDoc, SkillsListDoc,
} from './views/learner.ts'
import type { LearnerArchiveResult, LearnerForgetResult, LearnerRateResult } from './views.ts'
import { assertNoBrokenNotes, withinStruggleWindow, STRUGGLE_WINDOW_DAYS } from './sessions.ts'
import type { NodeStat, WindowStat } from './sessions.ts'
import type { SedimentKind } from './sediment.ts'
import type { CompassEta } from './compass.ts'
import { readDayCutoff, xpForAnswer } from './xp.ts'

// LearnerCardKind / LEARNER_CARD_KINDS 住 types.ts（中立层，#152 刀 4）；
// 此处原路径 re-export，门面与 tests 的既有导入路径不晃。
export type { LearnerCardKind } from './types.ts'
export { LEARNER_CARD_KINDS } from './types.ts'
import { LEARNER_CARD_KINDS } from './types.ts'

/** 学习者产出卡。prompt = 卡面正面提示；content = 学习者自己的表述（翻面对照）。 */
export interface LearnerCard {
  id: string
  kind: LearnerCardKind
  prompt: string
  content: string
  /** 关联节点（软引用；节点重生成/改名后悬空按 Missing 展示标注，不 Broken）。 */
  source_node: string
  source_section?: string
  archived?: boolean
  /** 卡自身的隔离调度状态（E 池；永不写回节点 frontmatter / 题库）。 */
  fsrs?: FsrsBlock
  /** last = 「一卡一天一次推进」门禁；E 卡无 defer 挂起流（自评直推），无 pending 标记。 */
  stats?: { attempts: number; correct: number; last?: string }
}

export interface LearnerCardDoc { node: string; cards: LearnerCard[] }

/** 卫生约束（#45 §5）：防「整课粘贴成一张卡」与单文件膨胀拖慢每日全库扫描。 */
export const LEARNER_PROMPT_MAX = 500
export const LEARNER_CONTENT_MAX = 2000

/** 控制字符（除换行/制表）拒绝；渲染面与题干同链不放宽。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** 挖空标记：{{…}} 且挖空段非空。 */
const CLOZE_MARK = /\{\{[^{}]+\}\}/

function cardError(op: string, path: string, detail: string): Error {
  return new Error(`[${op}] 我的卡 Broken（位置：${path}）\n  ✗ ${detail}`)
}

/** 我的卡 schema 校验（手写，错误行风格与引擎其余门禁一致）。 */
export function validateLearnerCards(doc: unknown, expectedNode?: string): { errors?: string[]; spec?: LearnerCardDoc } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (typeof d.node !== 'string' || !d.node.trim()) errors.push('node: 不能为空')
  if (!Array.isArray(d.cards) || !d.cards.length) errors.push('cards: 卡组为空')
  const cards: LearnerCard[] = []
  if (Array.isArray(d.cards)) {
    d.cards.forEach((raw, i) => {
      const n = i + 1
      if (typeof raw !== 'object' || raw === null) {
        errors.push(`cards.${n}: 必须是映射`)
        return
      }
      const e = raw as Record<string, unknown>
      const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `c${n}`
      if (!LEARNER_CARD_KINDS.includes(e.kind as LearnerCardKind)) {
        errors.push(`cards.${n}.kind: 非法卡面 ${String(e.kind)}（允许 ${LEARNER_CARD_KINDS.join('/')}）`)
        return
      }
      if (typeof e.prompt !== 'string' || !e.prompt.trim()) {
        errors.push(`cards.${n}.prompt: 正面提示不能为空`)
        return
      }
      if (e.prompt.length > LEARNER_PROMPT_MAX) {
        errors.push(`cards.${n}.prompt: 超过 ${LEARNER_PROMPT_MAX} 字符上限`)
        return
      }
      if (typeof e.content !== 'string' || !e.content.trim()) {
        errors.push(`cards.${n}.content: 自注内容不能为空`)
        return
      }
      if (e.content.length > LEARNER_CONTENT_MAX) {
        errors.push(`cards.${n}.content: 超过 ${LEARNER_CONTENT_MAX} 字符上限`)
        return
      }
      if (CONTROL_CHARS.test(e.prompt) || CONTROL_CHARS.test(e.content)) {
        errors.push(`cards.${n}: 含控制字符（只允许换行/制表）`)
        return
      }
      if (e.kind === 'cloze_rewrite' && !CLOZE_MARK.test(e.content)) {
        errors.push(`cards.${n}.content: 挖空重述必须含至少一个非空挖空标记 {{…}}`)
        return
      }
      if (typeof e.source_node !== 'string' || !e.source_node.trim()) {
        errors.push(`cards.${n}.source_node: 关联节点不能为空`)
        return
      }
      cards.push({
        id,
        kind: e.kind as LearnerCardKind,
        prompt: e.prompt.trim(),
        content: e.content.trim(),
        source_node: e.source_node.trim(),
        ...(typeof e.source_section === 'string' && e.source_section.trim() ? { source_section: e.source_section.trim() } : {}),
        ...(e.archived === true ? { archived: true } : {}),
        // 调度/统计块由作答侧写入，schema 只透传不做内部校验
        ...(e.fsrs && typeof e.fsrs === 'object' ? { fsrs: e.fsrs as FsrsBlock } : {}),
        ...(e.stats && typeof e.stats === 'object' ? { stats: e.stats as LearnerCard['stats'] } : {}),
      })
    })
  }
  if (errors.length) return { errors }
  const spec: LearnerCardDoc = { node: (d.node as string).trim(), cards }
  if (expectedNode && spec.node !== expectedNode) {
    return { errors: [`node「${spec.node}」与节点「${expectedNode}」不一致`] }
  }
  return { spec }
}

export class LearnerCards {
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  cardPath(courseRoot: string, node: string): string {
    return `${this.paths.learnerCardsDir(courseRoot)}/${safeFilename(node)}.yaml`
  }

  /** 读某节点卡组；文件缺失返回空卡组（合法 Missing）；存在但坏则抛 Broken。 */
  async load(courseRoot: string, node: string): Promise<LearnerCardDoc> {
    const p = this.cardPath(courseRoot, node)
    if (!existsSync(p)) return { node, cards: [] }
    const doc = await this.readDoc(p)
    const v = validateLearnerCards(doc, node)
    if (v.errors) throw cardError('learner-card-load', p, v.errors.join('；'))
    return v.spec!
  }

  private async readDoc(p: string): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw cardError('learner-card-load', p, `无法读取: ${message}`)
    }
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw cardError('learner-card-load', p, `YAML 无法解析: ${message}`)
    }
    if (typeof doc !== 'object' || doc === null) {
      throw cardError('learner-card-load', p, '顶层必须是映射（node/cards）')
    }
    return doc as Record<string, unknown>
  }

  private async writeDoc(courseRoot: string, node: string, doc: unknown): Promise<void> {
    const p = this.cardPath(courseRoot, node)
    await atomicWrite(p, YAML.stringify(doc))
  }

  private async loadChecked(courseRoot: string, node: string, op: string): Promise<Record<string, unknown> | null> {
    const p = this.cardPath(courseRoot, node)
    if (!existsSync(p)) return null
    const doc = await this.readDoc(p)
    const v = validateLearnerCards(doc, node)
    if (v.errors) throw cardError(op, p, v.errors.join('；'))
    return doc
  }

  /** 追加一张卡 → 新卡 id。同节点同内容（trim 后全等）的活跃卡拒绝（防连点重复建卡）。 */
  async addCard(courseRoot: string, node: string, card: {
    kind: LearnerCardKind
    prompt: string
    content: string
    source_section?: string
  }): Promise<{ id: string; count: number }> {
    const doc = await this.loadChecked(courseRoot, node, 'learner-card-add')
      ?? { node, cards: [] as Array<Record<string, unknown>> }
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const content = String(card.content).trim()
    if (list.some(c =>
      (c as { archived?: unknown }).archived !== true
      && String((c as { content?: unknown }).content ?? '').trim() === content)) {
      throw new Error(`[learner-card-add] 同内容卡已存在（去重防连点；先归档旧卡再存新版本）。`)
    }
    const id = `c${list.length + 1}`
    if (list.some(c => (c as { id?: unknown }).id === id)) {
      throw new Error(`[learner-card-add] 卡 id「${id}」已存在。`)
    }
    const next = [...list, {
      kind: card.kind, prompt: card.prompt, content,
      source_node: node,
      ...(card.source_section ? { source_section: card.source_section } : {}),
      id,
    }]
    const v = validateLearnerCards({ ...doc, cards: next }, node)
    if (v.errors) throw new Error(`[learner-card-add] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: next })
    return { id, count: next.length }
  }

  /** 作答侧写回：fsrs/stats 只能整体替换（派生证据，不经作者白名单）。 */
  async updateCardEvidence(
    courseRoot: string, node: string, cardId: string,
    patch: { fsrs?: FsrsBlock | null; stats?: LearnerCard['stats'] },
  ): Promise<void> {
    const doc = await this.loadChecked(courseRoot, node, 'learner-card-evidence')
    if (!doc) throw new Error(`[learner-card-evidence] 「${node}」没有我的卡文件。`)
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const idx = list.findIndex(c => (c as { id?: unknown }).id === cardId)
    if (idx < 0) throw new Error(`[learner-card-evidence] 「${node}」的卡组没有 ${cardId}。`)
    const next = [...list]
    const current = { ...next[idx] }
    if (patch.fsrs !== undefined) {
      if (patch.fsrs === null) delete current.fsrs
      else current.fsrs = patch.fsrs
    }
    if (patch.stats !== undefined) current.stats = patch.stats
    next[idx] = current
    const v = validateLearnerCards({ ...doc, cards: next }, node)
    if (v.errors) throw new Error(`[learner-card-evidence] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: next })
  }

  /** 归档/恢复单卡（修订用白名单见 LEARNER_AUTHORING_FIELDS）。 */
  async archiveCard(courseRoot: string, node: string, cardId: string, archived: boolean): Promise<void> {
    const doc = await this.loadChecked(courseRoot, node, 'learner-card-archive')
    if (!doc) throw new Error(`[learner-card-archive] 「${node}」没有我的卡文件。`)
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const hit = list.find(c => (c as { id?: unknown }).id === cardId)
    if (!hit) throw new Error(`[learner-card-archive] 「${node}」的卡组没有 ${cardId}。`)
    if (archived) (hit as { archived?: boolean }).archived = true
    else delete (hit as { archived?: boolean }).archived
    const v = validateLearnerCards({ ...doc, cards: list }, node)
    if (v.errors) throw new Error(`[learner-card-archive] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: list })
  }
}

// ---- Learner 子系统（#152 刀 4 / ADR-0043）：学习者输出与自管理域——E3 pin、
// E4 JOL、U4 周复盘、E5 教练、E2 讲解、E1 我的卡、Self-Calibration、U 区技能/回执/
// 习惯。住领主文件 learner-cards.ts（聚合+转发）；跨子系统依赖经结构化窄面
// LearnerDeps 由门面注入（运行时回引门面，类型面零门面导入——R6）。

/** Learner 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface LearnerDeps {
  store: Pick<Store, 'appendBandRec' | 'appendEArchive' | 'appendHabitRepeat' | 'appendJournal' | 'appendReview' | 'bandRecsAll' | 'habitRepeatsAll' | 'journalTail' | 'loadPins' | 'practiceAll' | 'receiptsAll' | 'reviewLogAll' | 'savePins'>
  paths: Paths
  registry: Pick<Registry, 'resolve'>
  bank: Pick<QuestionBank, 'load'>
  projects: Pick<Projects, 'list'>
  habits: Pick<Habits, 'create' | 'list' | 'load' | 'setStatus'>
  skills: Pick<Skills, 'create' | 'list' | 'load' | 'save' | 'setStatus' | 'updateEvidence'>
  learnerCards: Pick<LearnerCards, 'addCard' | 'archiveCard' | 'load' | 'updateCardEvidence'>
  noteManifest: Pick<NoteSourceManifest, 'load'>
  sched(courseRoot: string | null): Promise<FSRS>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  loadPrompt(kind: string): Promise<string>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }>
  saveNodeNote(path: string, fm: Fm, body: string): Promise<void>
  sedimentSettle(): Promise<{ week: string | null; wrote: SedimentKind[]; skipped: Array<{ kind: SedimentKind; reason: string }>; profile: string }>
  compassEtaRefresh(courseKey?: string, opts?: { today?: string; force?: boolean }): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta }>>
  experimentPropose(templateId: string, course?: string): Promise<{ proposal: number; template: string; title: string; pool: number; scope_course: string | null }>
  refreshSourceFingerprints(absPaths: string[]): Promise<void>
}

export class LearnerSubsystem {
  constructor(private e: LearnerDeps) {}

// ---- 门面原分节：E3pin ----
// ---- 门面原分节：E4jol ----
// ---- 门面原分节：U4kata ----
// ---- 门面原分节：E5coach ----
// ---- 门面原分节：E2explain ----
// ---- 门面原分节：E1cards ----
// ---- 门面原分节：SC ----
// ---- 门面原分节：Uskill ----
// ---- 门面原分节：Ureceipt ----
// ---- 门面原分节：Uhabit ----


  /** pin 节点为今日推荐榜首：只改推荐读侧排序（课程内置顶、跨课按全局语义），
   * 保留就绪提示——未就绪节点不拒绝，软闸建议随事件带出。仅作用当日，次日自动
   * 失效；同一课程可叠加多个 pin（按 pin 序依次置顶）。节点不在图内 fail loud；
   * 写入时顺带清理过期条目。零调度副作用（不碰 canonical/XP/掌握度）。
   * intention（C-5 #84）：可选挂载执行意图（if-then 计划），随 pin 当日过期
   * （ADR-0017 裁决 6），格式锁死校验走 normalizeGoalIntention。 */
  async pinToday(courseKey: string | undefined, node: string, today?: string, intention?: GoalIntentionInput): Promise<{ course: string; node: string; date: string; intention?: ExecutionIntention }> {
    today ??= (await this.e.learningDay()).today
    const plan = normalizeGoalIntention(intention?.cue, intention?.action)
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[pin] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'pin')
    const rest = (await this.e.store.loadPins())
      .filter(p => p.date === today && !(p.course === c.name && p.node === node))
    const rec: PinRec = { course: c.name, node, date: today, ...(plan ? { intention: plan } : {}) }
    await this.e.store.savePins([...rest, rec])
    return { course: c.name, node, date: today, ...(plan ? { intention: plan } : {}) }
  }


  /** 在今日 pin 上写入/清除执行意图（C-5 #84）：if-then 计划挂载在「今天学它」的
   * 目标偏好上，只覆盖推荐读侧（随 pin 当日过期，ADR-0017 裁决 6）。cue/action
   * 都传 = 写入（格式锁死：稳定线索 + 单一具体行动），都不传 = 清除；当日无该
   * 节点的 pin = Missing fail loud——意图没有独立生命周期，载体缺失就不能悬空写。
   * 写入时顺带清理过期条目（pinToday/unpin 同款卫生步骤）。Learner Output：零调度副作用。 */
  async setGoalIntention(courseKey: string | undefined, node: string, intention: GoalIntentionInput | null, today?: string): Promise<{ course: string; node: string; intention: ExecutionIntention | null }> {
    today ??= (await this.e.learningDay()).today
    const plan = intention ? normalizeGoalIntention(intention.cue, intention.action) : undefined
    const c = await this.e.registry.resolve(courseKey)
    const pins = (await this.e.store.loadPins()).filter(p => p.date === today)
    const hit = pins.find(p => p.course === c.name && p.node === node)
    if (!hit) throw new Error(`[goal-intention] 「${c.name}/${node}」今天没有 pin：执行意图挂在「今天学它」的目标偏好上，先 learnhub_pin_today。`)
    const next = pins.map(p => p === hit
      ? (plan ? { ...p, intention: plan } : { course: p.course, node: p.node, date: p.date })
      : p)
    await this.e.store.savePins(next)
    return { course: c.name, node, intention: plan ?? null }
  }


  /** 取消 pin：移除该课程+节点的全部 pin（含过期条目），写入时顺带清理过期清单。 */
  async unpinToday(courseKey: string | undefined, node: string, today?: string): Promise<{ course: string; node: string; pinned: false }> {
    today ??= (await this.e.learningDay()).today
    const c = await this.e.registry.resolve(courseKey)
    const rest = (await this.e.store.loadPins())
      .filter(p => p.date === today && !(p.course === c.name && p.node === node))
    await this.e.store.savePins(rest)
    return { course: c.name, node, pinned: false }
  }


  /** B1 内容诊断（#69，信号层建议先行）：逐启用课程逐节评估 R1（单题 lapses≥3）/
   * R2（自节 version 锚点以来按（题,日）去重 ≥4 次且正确率 <0.5）。零新增文件——
   * 触发留痕写 journal（kind=section_regen_signal，detail 人类可读且机器可回读），
   * 它同时是 7 天冷却与 R1 二次升级的判定依据；条件命中期间建议项保持可见（met），
   * 冷却与快照守门只约束新触发（fresh）。v1 只重写既有节、确认后才触发（不自动动库）。 */
  async diagnosticsAdvice(today?: string): Promise<DiagnosticItem[]> {
    const { today: learningToday, cutoff } = await this.e.learningDay()
    today ??= learningToday
    const out: DiagnosticItem[] = []
    const practice = await this.e.store.practiceAll()
    for (const c of await this.e.enabledCourses()) {
      const { state, broken } = await this.e.loadView(c)
      assertNoBrokenNotes('diagnostics', broken)
      const journal = await this.e.store.journalTail(c.name, Number.MAX_SAFE_INTEGER)
      const signalsByNode = new Map<string, Array<SignalSnapshot & { day: string }>>()
      const rewritesByNode = new Map<string, RewriteFact[]>()
      for (const r of journal) {
        if (r.kind === 'section_regen_signal') {
          const snap = parseSignalDetail(r.detail)
          if (!snap) continue
          const list = signalsByNode.get(r.node) ?? []
          list.push({ ...snap, day: dayOfTs(r.ts, cutoff) })
          signalsByNode.set(r.node, list)
        } else if (r.kind === 'content_section') {
          // detail 历史上只有节标题没有节 id（content.ts 契约）——按清单标题回退对齐
          const title = parseRewriteDetail(r.detail)
          if (!title) continue
          const list = rewritesByNode.get(r.node) ?? []
          list.push({ title, day: dayOfTs(r.ts, cutoff) })
          rewritesByNode.set(r.node, list)
        }
      }
      await this.scanCourseBanks(c, async (node, bank) => {
        const manifest = state[node]?.content.sections
        if (!manifest?.length) return // 无清单旧节点：节归因不适用（标题匹配不出的节不产建议）
        const attempts = practice
          .filter(r => r.course === c.name && r.node === node)
          .map(r => ({ qid: r.qid ?? '', day: dayOfTs(r.ts, cutoff), correct: r.correct }))
        for (const v of evaluateSectionSignals({
          manifest,
          questions: bank.questions.filter(q => !q.archived).map(q => ({ id: q.id, section: q.section, fsrs: q.fsrs })),
          attempts,
          prevSignals: signalsByNode.get(node) ?? [],
          rewrites: rewritesByNode.get(node) ?? [],
          today,
        })) {
          if (v.fresh) {
            const ev = v.signal === 'R1'
              ? `qid=${v.evidence.qid} lapses=${v.evidence.lapses}`
              : `attempts=${v.evidence.attempts} correct=${v.evidence.correct} acc=${v.evidence.accuracy}`
            await this.e.store.appendJournal({
              course: c.name, node, rating: null, kind: 'section_regen_signal', elapsed_days: 0,
              detail: formatSignalDetail(
                { sectionId: v.sectionId, signal: v.signal, base: Number(v.signal === 'R1' ? v.evidence.lapses : v.evidence.attempts) },
                v.sectionTitle, ev),
            })
          }
          out.push({ course: c.name, node, ...v })
        }
      })
    }
    return out
  }


  /** struggle 近期窗口统计（#55 F 半）：作答流水按 (course,node) 聚合，只留窗口内的
   * 真实作答证据（含交互件结算与忘记申报）。recommendEvents 消费；与累计的题库
   * stats 分开——复习中节点的 struggle 只看近期窗口，老账不翻。 */
  private async struggleWindow(today: string): Promise<Map<string, Map<string, WindowStat>>> {
    const out = new Map<string, Map<string, WindowStat>>()
    const cutoff = await readDayCutoff(this.e.paths)
    for (const r of await this.e.store.practiceAll()) {
      if (typeof r.correct !== 'boolean' || !withinStruggleWindow(r.ts, today, STRUGGLE_WINDOW_DAYS, cutoff)) continue
      const byNode = out.get(r.course) ?? new Map<string, WindowStat>()
      const agg = byNode.get(r.node) ?? { attempts: 0, correct: 0 }
      agg.attempts++
      if (r.correct) agg.correct++
      byNode.set(r.node, agg)
      out.set(r.course, byNode)
    }
    return out
  }


  /** 单课程题库文件的共用遍历（bankSnapshot / difficultyAdvice / memoryHealth 消费）：
   * 对课程根题库目录下每个 <节点>.yaml 回调 (node, bank)；无题库目录的课程静默跳过。 */
  private async scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void> {
    let files: string[] = []
    try {
      files = await readdir(this.e.paths.bankDir(c.root))
    } catch {
      return
    }
    const courseRoot = this.e.paths.courseRoot(c.root)
    for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
      const node = f.replace(/\.yaml$/, '')
      await fn(node, await this.e.bank.load(courseRoot, node))
    }
  }


  /** 全部启用课程的题库聚合（一次遍历）：每节点 due/count/accuracy/attempts。
   * 复习队列（due/count）与 struggle 提示（accuracy）共用；未做题节点也入表
   * （accuracy=null），供推荐流判定 struggle 与面板通用轮组装。 */
  private async bankSnapshot(today: string): Promise<Map<string, NodeStat[]>> {
    const out = new Map<string, NodeStat[]>()
    for (const c of await this.e.enabledCourses()) {
      const items: NodeStat[] = []
      out.set(c.name, items)
      await this.scanCourseBanks(c, async (node, bank) => {
        const qs = bank.questions.filter(q => !q.archived)
        if (!qs.length) return
        let attempts = 0
        let correct = 0
        const dues: string[] = []
        for (const q of qs) {
          attempts += q.stats?.attempts ?? 0
          correct += q.stats?.correct ?? 0
          if (q.fsrs?.reps && q.fsrs.due <= today) dues.push(q.fsrs.due)
        }
        items.push({
          node,
          due: dues.sort()[0] ?? null,
          count: dues.length,
          accuracy: attempts ? round2(correct / attempts) : null,
          attempts,
        })
      })
    }
    return out
  }

  /** 读 JOL 抽查配置：enabled=false 全局关闭（复习流完全不弹预测）；rate 抽样率。 */
  async jolConfig(): Promise<{ enabled: boolean; rate: number }> {
    const doc = await readLearnhubConfig(this.e.paths.learnhubConfigPath) as {
      jol?: { enabled?: boolean; rate?: number }
    }
    const enabled = doc.jol?.enabled !== false
    const rate = typeof doc.jol?.rate === 'number' && doc.jol.rate > 0 && doc.jol.rate <= 1
      ? doc.jol.rate : JOL_SAMPLE_RATE
    return { enabled, rate }
  }


  /** 写 JOL 抽查配置（原子替换，保留配置文件其他字段）。 */
  async setJolConfig(patch: { enabled?: boolean; rate?: number }): Promise<{ enabled: boolean; rate: number }> {
    const prev = await readLearnhubConfig(this.e.paths.learnhubConfigPath)
    const cur = await this.jolConfig()
    const next = { enabled: patch.enabled ?? cur.enabled, rate: patch.rate ?? cur.rate }
    await writeLearnhubConfig(this.e.paths.learnhubConfigPath, { ...prev, jol: next })
    return next
  }

  /** 周复盘记录定位（<输出区>/周复盘/<周一>.md）。 */
  private kataPath(weekStart: string): string {
    return `${this.e.paths.outputKindDir('周复盘')}/${weekStart}.md`
  }


  /** 读复盘记录 → frontmatter + 五问各问（读侧收口，三个写点共用）。 */
  private async kataReadDoc(path: string): Promise<{ fm: Record<string, unknown>; sections: Record<KataQuestion, string> }> {
    const { fm, body } = await loadNote(path)
    return { fm, sections: parseKataBody(body) }
  }


  /** 落盘复盘记录 + 刷新已注册源指纹（写侧收口：引擎自己的写不算漂移）。 */
  private async kataPersist(
    path: string, weekStart: string, reality: string,
    sections: Record<KataQuestion, string>, created: string,
  ): Promise<void> {
    await this.kataWriteDoc(path, weekStart, weekEndOf(weekStart)!, reality, sections, created)
    await this.e.refreshSourceFingerprints([path])
  }


  /** 打开/发起周复盘：复盘对象 = 上一完整学习周（可显式指定更早的完整周补记）。
   * 打开即沉淀结算点（#139）：校准画像/速度韧性周档出生即写、档案投影重建（同周幂等）。
   * 罗盘每周挂载沙盘 ETA（#143：挂周复盘；标记周幂等，单课失败不挡复盘）。
   * 现状区旁挂沙盘 ETA 摘要（#150）：与罗盘挂载同一份折叠数据，逐课一行越阈参照。
   * 现状 = 引擎用该学习周真实数据现算重填（引擎段）；四问保留学习者已写内容。
   * 文件缺失即建（入口常驻、无推送、缺勤不罚）。weekStart 必须是周一且不晚于
   * 上一完整周——复盘只向后看，不预填未来。零 XP、零 canonical 写入。 */
  async kataOpen(weekStart?: string): Promise<KataDoc> {
    const { today, cutoff } = await this.e.learningDay()
    // 沉淀结算随周复盘走（#139）：开复盘 = 上一完整学习周的一次结算点——校准画像/
    // 速度韧性周档出生即写、学习者档案投影重建（同周幂等，重复打开不重写）
    await this.e.sedimentSettle()
    const target = kataMonday(weekStart ?? prevWeekStartOf(today) ?? '')
    const prev = prevWeekStartOf(today)!
    if (target > prev) {
      throw new Error(`[kata] 复盘对象是已完整结束的学习周：${prev} 起的那一周是最近的完整周。`)
    }
    // 罗盘每周挂载（#143）：ETA 段每周一刷（标记周判重），透明度装置失败不挡复盘；
    // 折叠结果随行携带 eta——现状区旁挂沙盘 ETA 摘要（#150）取同一份数据，不二次蒙特卡洛
    const etaMounts = await this.e.compassEtaRefresh(undefined, { today }).catch(() => [])
    const etas = etaMounts
      .filter(m => m.eta !== undefined)
      .map(m => kataEtaSummary(m.course, m.eta!))
    const weekEnd = weekEndOf(target)!
    const reality = renderKataReality(await this.kataRealityFor(target, weekEnd, cutoff), etas)
    const path = this.kataPath(target)
    let sections: Record<KataQuestion, string>
    let created: boolean
    if (existsSync(path)) {
      const { fm, sections: existing } = await this.kataReadDoc(path)
      existing['现状'] = reality // 引擎段随开随新；四问原样保留
      sections = existing
      created = false
      await this.kataPersist(path, target, reality, sections, String(fm.created ?? today))
    } else {
      sections = parseKataBody(assembleKataDoc({ weekStart: target, weekEnd, created: today, reality, answers: {} }))
      created = true
      await this.kataPersist(path, target, reality, sections, today)
    }
    return {
      date: today, week_start: target, week_end: weekEnd, path, created,
      reality, sections, answered: kataAnswered(sections),
      list: await this.kataList(),
    }
  }


  /** 保存四问作答（patch 语义：给出的键才写；值 trim 后空 = 退回占位）。「现状」是
   * 引擎段，不接受学习者改写——要改数据事实，去补做学习行为。 */
  async kataSave(weekStart: string, answers: Partial<Record<KataAnswer, string>>): Promise<KataDoc> {
    const { today } = await this.e.learningDay()
    const target = kataMonday(weekStart)
    const path = this.kataPath(target)
    if (!existsSync(path)) {
      throw new Error(`[kata] 该周还没有复盘记录（${path}）——先 learnhub_kata_open 发起。`)
    }
    const sections = (await this.kataReadDoc(path)).sections
    const reality = sections['现状']
    for (const q of KATA_LEARNER_QUESTIONS) {
      if (answers[q] === undefined) continue
      sections[q] = answers[q]!.trim() || KATA_EMPTY
    }
    await this.kataPersist(path, target, reality, sections, today)
    return {
      date: today, week_start: target, week_end: weekEndOf(target)!, path, created: false,
      reality, sections, answered: kataAnswered(sections), list: await this.kataList(),
    }
  }


  /** 「下一实验」一键转 N-of-1 实验提案（ADR-0023 的自然入口）：走 experimentPropose
   * 提案-确认制（确认仍要显式 apply）；提案号留痕写回复盘记录。 */
  async kataToExperiment(weekStart: string, templateId: string, course?: string): Promise<{ proposal: number; title: string; week_start: string }> {
    const target = kataMonday(weekStart)
    const path = this.kataPath(target)
    if (!existsSync(path)) throw new Error('[kata] 该周还没有复盘记录——先 learnhub_kata_open 发起。')
    const prop = await this.e.experimentPropose(templateId, course)
    await this.stampKata(path, target, `- 已转 N-of-1 实验提案 #${prop.proposal}（${prop.title}）——确认开跑走实验 apply 通道。`)
    return { proposal: prop.proposal, title: prop.title, week_start: target }
  }


  /** 「下一实验」一键转执行意图挂今日目标偏好（C-5 既有机制）：pin 节点为今日榜首
   * 并挂 if-then 意图（随 pin 当日过期）；留痕写回复盘记录。零 XP 零 canonical。 */
  async kataToIntention(
    weekStart: string, input: { course: string; node: string; cue: string; action: string },
  ): Promise<{ course: string; node: string; week_start: string }> {
    const target = kataMonday(weekStart)
    const path = this.kataPath(target)
    if (!existsSync(path)) throw new Error('[kata] 该周还没有复盘记录——先 learnhub_kata_open 发起。')
    await this.pinToday(input.course, input.node, undefined, { cue: input.cue, action: input.action })
    await this.stampKata(path, target, `- 已挂今日执行意图（${input.node}：「${input.cue.trim()}」之后 ${input.action.trim()}）。`)
    return { course: input.course, node: input.node, week_start: target }
  }


  /** 已有复盘清单（周一起排序；answered 现读现判——入口常驻的清单面）。 */
  async kataList(): Promise<Array<{ week_start: string; answered: boolean }>> {
    const dir = this.e.paths.outputKindDir('周复盘')
    if (!existsSync(dir)) return []
    const out: Array<{ week_start: string; answered: boolean }> = []
    for (const f of (await readdir(dir)).filter(f => f.endsWith('.md')).sort()) {
      try {
        const { body } = await loadNote(`${dir}/${f}`)
        const sections = parseKataBody(body)
        const fmWeek = /^#\s*周复盘\s+(\d{4}-\d{2}-\d{2})/.exec(body)?.[1]
        out.push({ week_start: fmWeek ?? f.replace(/\.md$/, ''), answered: kataAnswered(sections) })
      } catch {
        // 坏记录不阻塞清单（它是文档不是契约文件）；open 单独打开时会 fail loud
      }
    }
    return out
  }


  /** 上一学习周的真实数据聚合（现状引擎段的原料；全部只读）。 */
  private async kataRealityFor(weekStart: string, weekEnd: string, cutoff: number) {
    const [practice, journal, reviewLog, habitRepeats] = await Promise.all([
      this.e.store.practiceAll(),
      this.e.store.journalTail(null, Number.MAX_SAFE_INTEGER),
      this.e.store.reviewLogAll(),
      this.e.store.habitRepeatsAll(),
    ])
    const projects = (await this.e.projects.list()).filter(p => p.lifecycle === 'active')
    const projectExec: Record<string, ProjectExecRec[]> = {}
    for (const p of projects) projectExec[p.id] = await execRecsAll(this.e.paths, p.id)
    const noteSources: Record<string, { path: string; title?: string }> = {}
    for (const s of (await this.e.noteManifest.load()).sources) {
      noteSources[s.id] = { path: s.path, ...(s.title ? { title: s.title } : {}) }
    }
    const habitNames: Record<string, string> = {}
    for (const h of (await this.e.habits.list()).habits) habitNames[h.habit] = h.name
    const skillNames: Record<string, string> = {}
    for (const s of (await this.e.skills.list()).skills) skillNames[s.skill] = s.name
    return buildKataReality({
      weekStart, weekEnd, cutoffMin: cutoff,
      practice, journal, reviewLog, habitRepeats, projects, projectExec, noteSources, habitNames, skillNames,
    })
  }


  /** 落盘一份五问记录（我的产出/周复盘/<周一>.md；created/updated 出处戳用日历日）。 */
  private async kataWriteDoc(
    path: string, weekStart: string, weekEnd: string,
    reality: string, sections: Record<KataQuestion, string>, created: string,
  ): Promise<void> {
    const body = assembleKataDoc({ weekStart, weekEnd, created, reality, answers: sections })
    await writeOutputArtifact(this.e.paths, {
      kind: '周复盘', file: `${weekStart}.md`,
      fm: { kind: KATA_KIND, week_start: weekStart, week_end: weekEnd, created, updated: todayStr() },
      body,
    })
  }


  /** 「下一实验」出口留痕：目标小节追加一行转换记录（其余内容不动）。 */
  private async stampKata(path: string, weekStart: string, line: string): Promise<void> {
    const { fm, sections } = await this.kataReadDoc(path)
    const reality = sections['现状']
    sections['下一实验'] = `${sections['下一实验'].trim()}\n\n${line}`.trim()
    await this.kataPersist(path, weekStart, reality, sections, String(fm.created ?? todayStr()))
  }

  /** 难度带会话记录（会话结束反馈点调用，ReviewSession 收尾时带上当次带选择与
   * 作答结算）：append-only 落 state/难度带.jsonl。零调度副作用——只是教练的
   * 长期选择分布数据源（Learner Output）。 */
  async logBandSession(rec: { course: string; node: string; band: BandPref; answered: number; correct: number }, today?: string): Promise<BandRec> {
    today ??= (await this.e.learningDay()).today
    if (!['easy', 'standard', 'hard'].includes(rec.band)) {
      throw new Error(`[band] band 只能是 easy/standard/hard（收到 ${String(rec.band)}）。`)
    }
    const full: BandRec = { date: today, ...rec }
    await this.e.store.appendBandRec(full)
    return full
  }


  /** 教练反馈（低打扰）：7 天窗口内按选择分布与带内表现生成温和提示（0–2 条），
   * 到期难题数 = 全部启用课程中 due ≤ today、R ≥ COACH_DUE_HARD_R（按状态该会）
   * 且合用难度 ≥ COACH_HARD_D（难）的到期题。无触发返回空数组；低数据静默。 */
  async coachAdvice(today?: string): Promise<{ messages: string[]; due_hard: number }> {
    today ??= (await this.e.learningDay()).today
    const courses = await this.e.enabledCourses()
    let dueHard = 0
    for (const c of courses) {
      const sched = await this.e.sched(this.e.paths.courseRoot(c.root))
      await this.scanCourseBanks(c, async (_node, bank) => {
        for (const q of bank.questions) {
          if (q.archived || !q.fsrs?.reps || !q.fsrs.due || q.fsrs.due > today) continue
          if (retrievabilityBlock(sched, q.fsrs, today) < COACH_DUE_HARD_R) continue
          if (combinedDifficulty(q.difficulty, q.fsrs) < COACH_HARD_D) continue
          dueHard++
        }
      })
    }
    const recs = (await this.e.store.bandRecsAll()).filter(r => withinCoachWindow(r.date, today))
    return { messages: coachFeedback(recs, dueHard, today), due_hard: dueHard }
  }

  /** 讲解会话的正文要点（s1–s3 型）：lessonSections 切分（练习/反馈排除），
   * 封顶 8 节防包体失控（讲解包是会话 system，不是全文导出）。 */
  private async explainPoints(c: CourseEntry, graph: Graph, node: string): Promise<ExplainPoint[]> {
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.e.paths.courseNotePath(c.root, regionName, node))
    return Sessions.lessonSections(body).slice(0, 8)
  }


  /** 讲解会话包：{正文要点 + 图位置 + 初学者人设指令}——面板「讲给我听」会话的
   * system / 宿主会话的首条消息（同 Arc D 上下文包通道）。自愿入口：本方法只读，
   * 会话存续与否、何时收尾全由学习者掌握。 */
  async explainBackPack(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[explain-back] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'explain-back')
    const sections = await this.explainPoints(c, graph, node)
    return explainBackPack(c.name, node, sections, graph.preOf[node], graph.succ[node] ?? [])
  }


  /** 定位反馈回合：对照该节点要点给 对/错/部分对 + 定位标签（含糊/跳跃/说错）+
   * 「可怎么补」。判词解析失败时抛错（零副作用，不入档案）；成功只写 E 档案
   * （appendEArchive）——不产生 XP、不写 canonical 任何字段（#33 三不进）。 */
  async explainBackFeedback(
    courseKey: string | undefined, node: string, transcript: string,
    llm: LlmComplete,
  ): Promise<EArchiveRec & { reply: string }> {
    if (!transcript.trim()) throw new Error('[explain-feedback] 讲解对话记录为空，无从反馈。')
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[explain-feedback] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'explain-feedback')
    const sections = await this.explainPoints(c, graph, node)
    const raw = await llm(explainFeedbackPrompt(sections, transcript), explainFeedbackSystem())
    const v = parseExplainVerdict(raw)
    const rec = await this.e.store.appendEArchive({
      course: c.name, node, kind: 'explain_back',
      verdict: v.verdict, tags: [...v.tags] as ExplainTag[],
      ...(v.advice ? { advice: v.advice } : {}),
      excerpt: transcript.trim().slice(-800),
    })
    return { ...rec, reply: v.reply }
  }


  /** 把一版讲解存档为 E1 自注卡（#68 存档目标）：卡面两档——再讲一遍（recall_cue，
   * 默认）与挖空重述（cloze_rewrite，content 须带 {{…}} 挖空）。入「我的卡」独立域
   * （复习呈现已并入复习队列、复习走无绑定 XP，ADR-0021）；判词与卡都属 Learner
   * Output，创建零 XP、节点调度面零写入。 */
  async explainArchiveCard(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: 'recall_cue' | 'cloze_rewrite'; prompt?: string; section?: string },
  ): Promise<{ course: string; node: string; id: string; kind: LearnerCard['kind']; count: number }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[explain-archive] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'explain-archive')
    const kind = opts.kind ?? 'recall_cue'
    if (kind !== 'recall_cue' && kind !== 'cloze_rewrite') {
      throw new Error(`[explain-archive] 讲解存档卡面只能是 recall_cue（再讲一遍）/ cloze_rewrite（挖空重述）之一（收到 ${String(kind)}）。`)
    }
    const content = opts.content?.trim()
    if (!content) throw new Error('[explain-archive] 讲稿内容为空，无可存档。')
    const sectionTitle = opts.section
      ? state[node]?.content.sections?.find(s => s.id === opts.section)?.title ?? opts.section
      : undefined
    const prompt = opts.prompt?.trim()
      || (kind === 'cloze_rewrite'
        ? `补全你自己的讲法：${sectionTitle ?? node}`
        : `再讲一遍：用你的话讲清「${sectionTitle ?? node}」`)
    const r = await this.e.learnerCards.addCard(c.root, node, {
      kind, prompt, content, ...(sectionTitle ? { source_section: sectionTitle } : {}),
    })
    return { course: c.name, node, id: r.id, kind, count: r.count }
  }

  /** 「我的卡」全量清单（管理面 / agent 清点用）：到期卡按 due 升序在前，从未调度的
   * 新卡随后。复习呈现已并入 reviewQueue（ADR-0021）——本清单不再承担复习入口，
   * 只做全量盘点（队列只出到期+新卡，这里还能看到未到期卡）。 */
  async learnerQueue(courseKey?: string, today?: string): Promise<LearnerQueueDoc> {
    today ??= (await this.e.learningDay()).today
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const cards: Array<Record<string, unknown>> = []
    for (const c of courses) {
      const dir = this.e.paths.learnerCardsDir(c.root)
      let files: string[] = []
      try {
        files = await readdir(dir)
      } catch {
        continue // 该课程还没有任何我的卡：合法空态
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const node = f.replace(/\.yaml$/, '')
        let doc: LearnerCardDoc
        try {
          doc = await this.e.learnerCards.load(c.root, node)
        } catch {
          continue // Broken 卡组不阻塞 E 池其他卡（data-check 体检面报出）
        }
        for (const card of doc.cards) {
          if (card.archived) continue
          cards.push(this.learnerCardView(c.name, node, card))
        }
      }
    }
    const due = cards.filter(c => c.due !== null && String(c.due) <= today)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || String(a.id).localeCompare(String(b.id)))
    const fresh = cards.filter(c => c.due === null)
      .sort((a, b) => String(a.node).localeCompare(String(b.node)) || String(a.id).localeCompare(String(b.id)))
    return { date: today, total: cards.length, due_count: due.length, cards: [...due, ...fresh] }
  }


  /** E 卡的作答视图：正面 = prompt（提示重述/挖空/自注主题），背面 = content（学习者
   * 自己的话）。content 随卡带出但 UI 在翻面前不展示——泄露面是学习者自己，且无判分。 */
  private learnerCardView(course: string, node: string, card: LearnerCard): Record<string, unknown> {
    return {
      course, node, id: card.id, kind: card.kind,
      prompt: card.prompt, content: card.content,
      source_section: card.source_section ?? null,
      due: card.fsrs?.reps ? card.fsrs.due : null,
      attempts: card.stats?.attempts ?? 0,
    }
  }


  private async learnerCardContext(courseKey: string | undefined, node: string, cardId: string, op: string): Promise<{
    c: CourseEntry; card: LearnerCard
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const doc = await this.e.learnerCards.load(c.root, node)
    const card = doc.cards.find(x => x.id === cardId)
    if (!card) throw new Error(`[${op}] 「${node}」的我的卡没有 ${cardId}。`)
    return { c, card }
  }


  /** E 卡自评结算（2/3/4）：新卡在此首推，老卡按档推进；一卡一学习日一次推进
   * （stats.last 把守）。复习呈现已并入复习队列（ADR-0021）：入账走无绑定 XP
   * （与题卡同公式、权重 1，难度取卡自身 FSRS difficulty、未调度取中性 5）；
   * 复习日志/practice/节点调度面零写入（ADR-0021 裁决 2）。 */
  async learnerCardRate(
    courseKey: string | undefined, node: string, cardId: string, rating: number,
  ): Promise<LearnerRateResult> {
    const r = Math.round(rating)
    if (r < 2 || r > 4) throw new Error(`[learner-rate] 自评档位只能是 2/3/4（收到 ${String(rating)}）；忘记走 learner-forget。`)
    const { c, card } = await this.learnerCardContext(courseKey, node, cardId, 'learner-rate')
    const { today } = await this.e.learningDay()
    // ADR-0014 advanceStrict：守门即原 stats.last 检查（一卡一天一次），文案是测试契约
    const pushed = advanceStrict(await this.e.sched(null), card, r, today,
      `[learner-rate] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    await this.e.learnerCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats: pushed.stats })
    const diff = card.fsrs?.difficulty && card.fsrs.difficulty > 0 ? card.fsrs.difficulty : FSRS_DIFFICULTY_MID
    const settle = xpForAnswer(card.kind, diff, true, null, true)
    await this.e.store.appendJournal({
      course: '*', node: '*', rating: r, kind: 'xp_learner', elapsed_days: 0,
      xp: settle.xp, detail: `我的卡 ${c.name}/${node}#${cardId}（self ${r}）`,
    })
    return { course: c.name, node, id: cardId, rating: r, due: pushed.fs.due, scheduled: true, xp: settle.xp }
  }


  /** E 卡忘记申报（rating=1）：不作答直接翻面，一卡一学习日一次；0 XP 无绑定行，
   * 节点调度面零写入。 */
  async learnerCardForget(
    courseKey: string | undefined, node: string, cardId: string,
  ): Promise<LearnerForgetResult> {
    const { c, card } = await this.learnerCardContext(courseKey, node, cardId, 'learner-forget')
    const { today } = await this.e.learningDay()
    const pushed = advanceStrict(await this.e.sched(null), card, 1, today,
      `[learner-forget] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    await this.e.learnerCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats: pushed.stats })
    await this.e.store.appendJournal({
      course: '*', node: '*', rating: 1, kind: 'xp_learner', elapsed_days: 0,
      xp: 0, detail: `我的卡 ${c.name}/${node}#${cardId}（forget）`,
    })
    return { course: c.name, node, id: cardId, rating: 1, due: pushed.fs.due, scheduled: true, xp: 0 }
  }


  /** E1「加我的理解」节级入口（#70）：学习者用自己的话写一句解释/例子/助记
   * （锚点 = 节 id/标题），AI 对照该节已教要点给 是非 + 定位（含糊/跳跃/说错）
   * + 可怎么补——判词入 E 档案（kind=self_note），产出成独立域 LearnerCard。
   * ADR-0009/0021 边界：创建零 XP、不写掌握度/节点调度面；卡汇入复习队列、
   * 复习走无绑定 XP。AI 判词不可解析时抛错，卡与判词零落盘（ADR-0004 事务性）。 */
  async learnerNoteAdd(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: LearnerCard['kind']; prompt?: string; section?: string },
    llm: LlmComplete,
  ): Promise<{
    course: string; node: string
    card: { id: string; kind: LearnerCard['kind']; count: number }
    verdict: EArchiveRec; reply: string
  }> {
    const content = opts.content?.trim()
    if (!content) throw new Error('[understanding] 自注内容为空——「加我的理解」存的是学习者自己的话。')
    const kind = opts.kind ?? 'recall_cue'
    if (!LEARNER_CARD_KINDS.includes(kind)) {
      throw new Error(`[understanding] 卡面只能是 ${LEARNER_CARD_KINDS.join('/')}（收到 ${String(opts.kind)}）。`)
    }
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[understanding] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'understanding')
    // 对照面 = 节锚点（清单 id/标题 → 该节正文）；锚点给了但该节还没有正文时，
    // 对照面为空并随反馈明示——不静默退化为全节要点（锚点语义必须可预期）
    const sections = await this.explainPoints(c, graph, node)
    let sectionTitle: string | undefined
    if (opts.section?.trim()) {
      const raw = opts.section.trim()
      sectionTitle = state[node]?.content.sections?.find(s => s.id === raw || s.title === raw)?.title ?? raw
    }
    const points = sectionTitle ? sections.filter(s => s.title === sectionTitle) : sections
    // 机械反馈调用恒走 fast 档（#137：档位沿缝声明，宿主适配器翻译成部署思考档）
    const raw = await llm(selfNoteFeedbackPrompt(points, sectionTitle, content), selfNoteFeedbackSystem(), { effort: 'fast' })
    const v = parseExplainVerdict(raw) // 不可解析抛错 → 卡与判词零落盘
    const card = await this.e.learnerCards.addCard(c.root, node, {
      kind,
      prompt: opts.prompt?.trim() || selfNotePromptOf(kind, sectionTitle ?? node),
      content,
      ...(sectionTitle ? { source_section: sectionTitle } : {}),
    })
    const verdict = await this.e.store.appendEArchive({
      course: c.name, node, kind: 'self_note',
      verdict: v.verdict, tags: [...v.tags] as ExplainTag[],
      ...(v.advice ? { advice: v.advice } : {}),
      excerpt: content.slice(-800),
    })
    return { course: c.name, node, card: { id: card.id, kind, count: card.count }, verdict, reply: v.reply }
  }


  /** 归档/恢复一张我的卡（管理面）：E 池内部动作，canonical 零写入。 */
  async learnerCardArchive(
    courseKey: string | undefined, node: string, cardId: string, archived: boolean,
  ): Promise<LearnerArchiveResult> {
    const c = await this.e.registry.resolve(courseKey)
    await this.e.learnerCards.archiveCard(c.root, node, cardId, archived)
    return { course: c.name, node, id: cardId, archived }
  }

  /** 自评校准画像：分源切片（主视图）+ 全局参考视图（带域特异警戒）。
   * practice 流水配对的只读派生——零落盘、零 canonical 写入（ADR-0022 红线）；
   * 与 memory.ts 的 FSRS 自校准（calibrationBins，模型体检）正交，永不混入。 */
  async calibrationProfile(): Promise<CalibrationProfileDoc> {
    return calibrationProfileView(await this.e.store.practiceAll())
  }


  /** 读显式过信提示开关（state/learnhub.json 的 calibration.hints 字段；缺省开——
   * 「可全局关」）。关闭后复习队列不带轻提示、抽查密度不再加强（JOL 抽查本身
   * 仍由 jol.enabled 独立控制）。 */
  async calibrationHintsConfig(): Promise<{ hints_enabled: boolean }> {
    const doc = await readLearnhubConfig(this.e.paths.learnhubConfigPath) as {
      calibration?: { hints_enabled?: boolean }
    }
    return { hints_enabled: doc.calibration?.hints_enabled !== false }
  }


  /** 写显式过信提示开关（原子替换，保留配置文件其他字段；照 jolConfig 先例）。 */
  async setCalibrationHints(hints_enabled: boolean): Promise<{ hints_enabled: boolean }> {
    const prev = await readLearnhubConfig(this.e.paths.learnhubConfigPath)
    await writeLearnhubConfig(this.e.paths.learnhubConfigPath,
      { ...prev, calibration: { hints_enabled } })
    return { hints_enabled }
  }

  /** 建技能条目（执行事件调度 lane 的载体）：与题目 FSRS 并行，不复用题目卡、
   * 不进复习队列、无 mastery。 */
  async skillCreate(name: string, opts?: { id?: string; maintenance_days?: number | null }): Promise<SkillDoc> {
    return this.e.skills.create({ name, ...opts })
  }


  /** 技能清单 + lane 生效到期（维持节拍帽已折算）：可排期视图——due ≤ 今日即到期，
   * due_kind 标明这次是习得（acquisition）还是维持复活（maintenance/迷你重做+回放）。 */
  async skillList(today?: string): Promise<SkillsListDoc> {
    today ??= (await this.e.learningDay()).today
    const { skills, broken } = await this.e.skills.list()
    return {
      date: today,
      skills: skills.map(s => {
        const due = laneDue(s.fsrs ?? null, s.maintenance_days)
        return {
          id: s.skill, name: s.name, status: s.status,
          maintenance_days: s.maintenance_days,
          due,
          /** 到期种类（仅在已到期时有意义；fresh = null 表示从未执行、无到期语义）。 */
          due_kind: due !== null && due <= today ? laneEventKind(s.fsrs ?? null, s.maintenance_days, today) : null,
          attempts: s.stats?.attempts ?? 0,
        }
      }),
      broken,
    }
  }


  /** 调维持节拍上限（天；null 关）。纯实体属性：不影响既有 FSRS 状态。 */
  async skillSetMaintenance(id: string, days: number | null): Promise<SkillDoc> {
    const doc = await this.e.skills.load(id)
    doc.maintenance_days = clampMaintenanceDays(days, 'skill-maintenance')
    await this.e.skills.save(id, doc)
    return doc
  }


  /** 归档/恢复技能条目（可逆）。archived 只是收纳标签：归档后拒绝再记执行事件。 */
  async skillArchive(id: string, archived: boolean): Promise<SkillDoc> {
    if (typeof archived !== 'boolean') throw new Error('[skill-archive] archived 必须显式给出（true 归档 / false 恢复）。')
    return this.e.skills.setStatus(id, archived ? 'archived' : 'active')
  }


  /** 执行事件落账（通道核心）：表现评级（1-4 整数 + 来源 auto/self/ai）推进技能条目
   * 的 lane（复用推进内核，一 lane 一学习日一次）；事件行进复习日志
   * （rating_source='execution' + event_kind 维持/习得区分，不复用题目卡）；
   * XP 按原生专注时长入账（journal kind='xp_execution'，1 XP ≈ 1 分钟，进 streak
   * 口径；时长来源 = 学习者申报，不设反作弊门，ADR-0019）。auto 来源必须携带可观测
   * 证据走确定性映射；self/ai 走显式评级。 */
  async executionLog(
    skillId: string,
    input: { source: ExecutionSource; minutes: number; rating?: number; evidence?: ExecutionEvidence; note?: string },
  ): Promise<ExecutionLogResult> {
    const doc = await this.e.skills.load(skillId)
    if (doc.status !== 'active') {
      throw new Error(`[execution-log] 技能「${skillId}」已归档——先 learnhub_skill_archive 恢复，再记执行事件。`)
    }
    const source = input.source
    if (!(source === 'auto' || source === 'self' || source === 'ai')) {
      throw new Error(`[execution-log] source 只能是 auto/self/ai（收到 ${String(source)}）。`)
    }
    let rating: 1 | 2 | 3 | 4
    if (source === 'auto') {
      if (!input.evidence) throw new Error("[execution-log] source='auto' 需要可观测证据（evidence.accuracy/self_help）——确定性映射是自动来源的唯一入口；无可观测判据时改用自评档（source='self' + rating）。")
      rating = ratingFromEvidence(input.evidence)
    } else {
      // 1-4 整数硬校验（ADR-0018 入口契约）：小数静默取整会让 FSRS 丢乘子，不收
      const r = input.rating
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 4) {
        throw new Error(`[execution-log] ${source === 'self' ? '自评' : 'AI'} 评级必须是 1-4 的整数（收到 ${String(r)}）。`)
      }
      rating = r
    }
    const minutes = input.minutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error(`[execution-log] minutes 必须是 1–1440 的整数（本次专注分钟数，收到 ${String(minutes)}）。`)
    }
    const { today } = await this.e.learningDay()
    // 事件种类在推进前判定（帽/因判定读的是旧状态）
    const kind = laneEventKind(doc.fsrs ?? null, doc.maintenance_days, today)
    const pushed = advanceStrict(await this.e.sched(null), doc, rating, today,
      `[execution-log] 技能「${skillId}」今天已记过执行事件（一 lane 一学习日一次）。`)
    await this.e.skills.updateEvidence(skillId, { fsrs: pushed.fs, stats: pushed.stats })
    await this.e.store.appendReview({
      ...executionRowIdentity(doc.skill),
      rating, rating_source: 'execution', event_kind: kind, exec_source: source,
      elapsed_days: pushed.log.elapsed_days,
      stability_before: pushed.log.stability_before,
      difficulty_before: pushed.log.difficulty_before,
      r_pred: pushed.log.r_pred,
    })
    // XP：原生专注时长直入（1 XP ≈ 1 分钟），无绑定行进总账/每日目标/streak（ADR-0019）
    await this.e.store.appendJournal({
      course: '*', node: '*', rating, kind: 'xp_execution', elapsed_days: 0,
      xp: minutes, duration_s: minutes * 60,
      detail: executionXpDetail({ skill: doc.skill, source, kind, rating, minutes })
        + (input.note?.trim() ? `；${input.note.trim()}` : ''),
    })
    return {
      skill: doc.skill, rating, source, kind,
      due: laneDue(pushed.fs, doc.maintenance_days) ?? pushed.fs.due,
      xp: minutes, minutes, attempts: pushed.stats.attempts,
    }
  }

  /** 回执提交全链：材料 → AI 量表评审（rubric = 实践节点内容要点）→ 评审分同权进
   * practice_ema；渐退反馈 per 主体（完整评审位置 = wantsFullReview 曲线，学习者可
   * force_full 越过）。零 XP、不推进任何 FSRS 卡；v1 只挂实践节点（type=practice）。 */
  async receiptSubmit(
    courseKey: string | undefined, node: string,
    input: { kind: ReceiptKind; material: string; force_full?: boolean },
    llm: LlmComplete,
  ): Promise<ReceiptSubmitResult> {
    const kind = input.kind
    if (!RECEIPT_KIND_LABEL[kind]) {
      throw new Error(`[receipt-submit] kind 只能是 ${Object.keys(RECEIPT_KIND_LABEL).join('/')}（收到 ${String(kind)}）；其它形态用 text 一句话描述（链接/路径写进 material）。`)
    }
    const material = input.material?.trim()
    if (!material) throw new Error('[receipt-submit] material 不能为空——回执是练习证据（描述/图片路径/导出/签核皆可）。')
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[receipt-submit] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'receipt-submit')
    if (graph.typeOf[node] !== 'practice') {
      throw new Error(`[receipt-submit] 「${node}」不是实践节点（type=practice）——v1 回执只挂实践节点（ADR-0016：机制按通用实践主体建模，项目/技能条目载体后续接入）。`)
    }
    const note = await this.e.nodeNote(c, graph, node)
    if (!note.fm) throw new Error('[receipt-submit] 节点笔记缺 frontmatter，无法入练习证据 EMA。')
    const points = await this.explainPoints(c, graph, node)
    const { today } = await this.e.learningDay()
    const result = await submitReceipt({
      store: this.e.store,
      course: c.name, node,
      kind, material,
      points,
      today,
      forceFull: input.force_full === true,
      fm: note.fm,
      saveFm: async fm => { await this.e.saveNodeNote(note.path, fm, note.body) },
      llm,
      template: await this.e.loadPrompt('回执评审'),
    })
    // 回执的项目工作区镜像（V-5 #113）：里程碑计划关联了本节点（nodes 命中节点名
    // 或「课程/节点」）的项目各得一份可读副本；canonical 流水仍是中心回执.jsonl，
    // 镜像只是「无界项目也有家」的文档面。零 XP/EMA 语义不受影响。
    const mirrored = await this.mirrorReceiptToProjects(c.name, node, result.receipt, material)
    return { ...result, ...(mirrored.length ? { mirrored_projects: mirrored } : {}) }
  }


  /** 关联节点回执 → 项目工作区可读副本（V-5 #113）：返回镜像到的项目 id 列表。 */
  private async mirrorReceiptToProjects(
    courseName: string, node: string, rec: ReceiptLogRec, material: string,
  ): Promise<string[]> {
    const specs = new Set([node, nodeKeyOf(courseName, node)])
    const out: string[] = []
    for (const p of await this.e.projects.list()) {
      if (!p.plan.some(m => (m.nodes ?? []).some(n => specs.has(n)))) continue
      const dir = this.e.paths.projectReceiptDir(p.id)
      await mkdir(dir, { recursive: true })
      const file = `${safeFilename(courseName)}-${safeFilename(node)}-${safeFilename(rec.id)}.md`
      const lines = [
        '---',
        `kind: receipt`,
        `subject: ${courseName}/${node}`,
        `receipt: ${rec.id}`,
        `day: ${rec.day}`,
        `score: ${rec.score}`,
        `review_mode: ${rec.review_mode}`,
        '---',
        '',
        '## 回执材料',
        '',
        material,
        '',
        '## 评审',
        '',
        rec.verdict,
      ]
      for (const e of rec.errors ?? []) {
        lines.push(`- **${e.point}**：${e.issue} → ${e.advice}`)
      }
      await writeFile(`${dir}/${file}`, lines.join('\n').trimEnd() + '\n', 'utf8')
      out.push(p.id)
    }
    return out
  }


  /** 回执历史 + 渐退计划状态（per 实践主体）。 */
  async receiptList(courseKey: string | undefined, node: string): Promise<{
    course: string; node: string
    receipts: ReceiptLogRec[]
    total: number
    next_full_in: number | null
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const all = await this.e.store.receiptsAll()
    const receipts = all.filter(r => r.course === c.name && r.node === node)
    return {
      course: c.name, node, receipts,
      total: receipts.length,
      // 空态 = 1：首份回执即完整评审（与纯函数 receiptsUntilNextFull 同一口径）
      next_full_in: receiptsUntilNextFull(receipts.length),
    }
  }

  /** 建习惯（执行意图 = 稳定线索 + 单一具体行动，格式锁死）。 */
  async habitCreate(input: { name: string; cue: string; action: string; id?: string }): Promise<HabitDoc> {
    return this.e.habits.create(input)
  }


  /** 习惯清单 + 派生面（累计重复 / 宽容 streak / 自动化曲线摘要）。曲线与 streak 只
   * 展示给学习者：这里返回的数字永不进 Mastery/XP/任何 canonical 度量。 */
  async habitList(today?: string): Promise<HabitsListDoc> {
    today ??= (await this.e.learningDay()).today
    const { habits, broken } = await this.e.habits.list()
    const repeats = await this.e.store.habitRepeatsAll()
    return {
      date: today,
      habits: habits.map(h => {
        const mine = repeats.filter(r => r.habit === h.habit)
        const curve = automationCurve(mine)
        return {
          id: h.habit, name: h.name, status: h.status,
          intention: h.intention,
          total_repeats: mine.length,
          streak: habitStreak([...new Set(mine.map(r => r.day))], today),
          latest_rating: curve.length ? curve[curve.length - 1].rating : null,
        }
      }),
      broken,
    }
  }


  /** 单个习惯详情：意图 + 完整自动化曲线（x=累计重复次数，y=自评 1-5）+ 近期重复。 */
  async habitShow(habitId: string, today?: string): Promise<HabitShowDoc> {
    today ??= (await this.e.learningDay()).today
    const doc = await this.e.habits.load(habitId)
    const mine = (await this.e.store.habitRepeatsAll()).filter(r => r.habit === habitId)
    return {
      ...doc,
      total_repeats: mine.length,
      streak: habitStreak([...new Set(mine.map(r => r.day))], today),
      curve: automationCurve(mine),
      recent: [...mine].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10),
    }
  }


  /** 自报一次重复（唯一入账来源；无门禁不防作弊）。可选携带自动化自评 1-5
   * （SRBAI 语义的事件级自评，不强制每次）。习惯域零 XP：不写 journal/practice。 */
  async habitRepeat(habitId: string, input: { auto_rating?: number; note?: string }): Promise<HabitRepeatRec> {
    const doc = await this.e.habits.load(habitId)
    const rating = input.auto_rating
    if (rating !== undefined && (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new Error(`[habit-repeat] auto_rating 必须是 1-5 的整数（自动化自评，收到 ${String(rating)}）；省略则只记重复。`)
    }
    const { today } = await this.e.learningDay()
    return this.e.store.appendHabitRepeat({
      ts: nowIso(),
      habit: doc.habit,
      day: today,
      ...(rating !== undefined ? { auto_rating: rating } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    })
  }


  /** 归档/恢复习惯（可逆；archived 只是收纳标签，无到期无截止）。 */
  async habitArchive(habitId: string, archived: boolean): Promise<HabitDoc> {
    if (typeof archived !== 'boolean') throw new Error('[habit-archive] archived 必须显式给出（true 归档 / false 恢复）。')
    return this.e.habits.setStatus(habitId, archived ? 'archived' : 'active')
  }
}
