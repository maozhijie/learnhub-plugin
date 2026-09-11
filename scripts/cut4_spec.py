# 刀 4 规格：learner 十节 → LearnerSubsystem 住 learner-cards.ts
lord_file = 'src/engine/learner-cards.ts'
class_name = 'LearnerSubsystem'
deps_name = 'LearnerDeps'
field_name = 'learner'

sections = [
    ('E3pin', '  // ---- 「今天学它」pin', '  // ---- doctor'),
    ('E4jol', '  // ---- E4 JOL 抽查配置', '  // ---- D1 N-of-1'),
    ('U4kata', '  // ---- U4 周复盘 Weekly Kata', '  // ---- D2 挑战点恒温器'),
    ('E5coach', '  // ---- E5 可用的困难教练', '  // ---- E2「讲给我听」'),
    ('E2explain', '  // ---- E2「讲给我听」', '  // ---- E1「我的卡」'),
    ('E1cards', '  // ---- E1「我的卡」复习', '  // ---- C-3 错误对比卡'),
    ('SC', '  // ---- Self-Calibration 自评校准画像', '  // ---- D4 睡眠耦合'),
    ('Uskill', '  // ---- U 区·技能条目与执行事件通道', '  // ---- U 区·回执反馈环'),
    ('Ureceipt', '  // ---- U 区·回执反馈环', '  // ---- U 区·习惯一等公民'),
    ('Uhabit', '  // ---- U 区·习惯一等公民', '  // ---- FSRS 参数优化器'),
]

fwd_notes = {
    'E3pin': '以下 E3pin/E4jol/U4kata/E5coach/E2explain/E1cards/SC/Uskill/Ureceipt/Uhabit 十节方法体住 LearnerSubsystem（learner-cards.ts，#152 刀 4 聚合+转发）',
}

lord_header = """
// ---- Learner 子系统（#152 刀 4 / ADR-0043）：学习者输出与自管理域——E3 pin、
// E4 JOL、U4 周复盘、E5 教练、E2 讲解、E1 我的卡、Self-Calibration、U 区技能/回执/
// 习惯。住领主文件 learner-cards.ts（聚合+转发）；跨子系统依赖经结构化窄面
// LearnerDeps 由门面注入（运行时回引门面，类型面零门面导入——R6）。"""

deps_text = """/** Learner 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
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
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  loadPrompt(kind: string): Promise<string>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }>
  saveNodeNote(path: string, fm: Fm, body: string): Promise<void>
  sedimentSettle(): Promise<{ week: string | null; wrote: SedimentKind[]; skipped: Array<{ kind: SedimentKind; reason: string }>; profile: string }>
  compassEtaRefresh(courseKey?: string, opts?: { today?: string; force?: boolean }): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta }>>
  experimentPropose(templateId: string, course?: string): Promise<{ proposal: number; template: string; title: string; pool: number; scope_course: string | null }>
  refreshSourceFingerprints(absPaths: string[]): Promise<void>
}"""

lord_replaces = [
    ("""import { YAML } from './yaml.ts'
import type { FsrsBlock } from './types.ts'
import type { Paths } from './paths.ts'
import { safeFilename } from './paths.ts'""",
     """import { YAML } from './yaml.ts'
import type { FsrsBlock, Fm, CourseEntry, EArchiveRec } from './types.ts'
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
import { readLearnhubConfig, writeLearnhubConfig } from './io.ts'
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
import { kataMonday } from './kata.ts'
import type { LlmComplete } from './llm.ts'
import { calibrationBins } from './memory.ts'
import { FSRS_DIFFICULTY_MID } from './params.ts'
import type { ReceiptKind, ReceiptLogRec, ReceiptSubmitResult } from './receipts.ts'
import { RECEIPT_KIND_LABEL, receiptsUntilNextFull, submitReceipt } from './receipts.ts'
import { Sessions } from './sessions.ts'
import { assertNoBrokenNotes, withinStruggleWindow, STRUGGLE_WINDOW_DAYS } from './sessions.ts'
import type { NodeStat, WindowStat } from './sessions.ts'
import type { SedimentKind } from './sediment.ts'
import type { CompassEta } from './compass.ts'
import { readDayCutoff, xpForAnswer } from './xp.ts'"""),
    ("import { mkdir, readFile, writeFile } from 'node:fs/promises'",
     "import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises'"),
]

facade_replaces = [
    ("""import { LearnerCards, LEARNER_CARD_KINDS } from './learner-cards.ts'""",
     """import { LearnerCards, LEARNER_CARD_KINDS, LearnerSubsystem } from './learner-cards.ts'"""),
    ("""  /** Channels 子系统（通道域，#152 刀 3）：窄面注入构造，见 constructor 尾部。 */
  private channels: ChannelsSubsystem""",
     """  /** Channels 子系统（通道域，#152 刀 3）：窄面注入构造，见 constructor 尾部。 */
  private channels: ChannelsSubsystem
  /** Learner 子系统（学习者输出域，#152 刀 4）：窄面注入构造，见 constructor 尾部。 */
  private learner: LearnerSubsystem"""),
    ("""      refreshRepCard: (c, graph, node) => this.refreshRepCard(c, graph, node),
    })""",
     """      refreshRepCard: (c, graph, node) => this.refreshRepCard(c, graph, node),
    })
    this.learner = new LearnerSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, projects: this.projects, habits: this.habits,
      skills: this.skills, learnerCards: this.learnerCards, noteManifest: this.noteManifest,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      loadPrompt: kind => this.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      sedimentSettle: () => this.sedimentSettle(),
      compassEtaRefresh: (courseKey, opts) => this.compassEtaRefresh(courseKey, opts),
      experimentPropose: (templateId, course) => this.experimentPropose(templateId, course),
      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
    })"""),
]
