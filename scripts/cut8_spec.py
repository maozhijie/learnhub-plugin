# 刀 8 规格：content 三节 → ContentSubsystem 住 content-subsystem.ts（同域新文件）
lord_file = 'src/engine/content-subsystem.ts'
class_name = 'ContentSubsystem'
deps_name = 'ContentDeps'
field_name = 'content2'

sections = [
    ('pipeline', '  // ---- 内容管线', '  // ---- note resolve'),
    ('resolve', '  // ---- note resolve', '  // ---- P4：课程工作区'),
    ('tree', '  // ---- P4：课程工作区', '  // ---- C1 笔记复习源'),
]

fwd_notes = {
    'pipeline': '以下 内容管线/note resolve/课程工作区 三节方法体住 ContentSubsystem（content-subsystem.ts，#152 刀 8 聚合+转发）',
}

lord_header = """
// ---- Content 子系统（#152 刀 8 / ADR-0043）：内容管线、笔记 resolve/反馈区、课程
// 工作区与题库树。本文件只被门面引用，可自由 import 领域模块；跨子系统调用（队列
// 装配要摸通道域/题库域/学习者域）经窄面注入回引门面。"""

deps_text = """/** Content 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */
export interface ContentDeps {
  store: Store
  paths: Paths
  registry: Registry
  bank: QuestionBank
  content: Content
  sessions: Sessions
  learnerCards: LearnerCards
  vaultRoot: string
  /** JOL 抽查随机源（可注入播种）。 */
  jolRng: () => number
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  bandDefault(): Promise<BandPref | null>
  calibrationHintsConfig(): Promise<{ hints_enabled: boolean }>
  collectNoteSourceCards(today: string): Promise<{ cards: Array<Record<string, unknown>>; drifted: Array<Record<string, unknown>>; suspended: Array<Record<string, unknown>> }>
  enabledCourses(): Promise<CourseEntry[]>
  ensureNote(root: string, graph: Graph, node: string): Promise<Fm>
  errorCardTriples(courses: ReadonlyArray<{ name: string; root: string }>, nodeFilter?: string): AsyncGenerator<{ course: string; node: string; card: ErrorCard }>
  exerciseGated(c: CourseEntry, node: string): Promise<boolean>
  expTag(courseName: string, node: string, qid: string, today: string): Promise<{ id: number; arm: string } | null>
  isNoteSourceCourse(courseKey: string | undefined): Promise<boolean>
  jolConfig(): Promise<{ enabled: boolean; rate: number }>
  jolPredicted(p: JolPrediction | null | undefined): JolPrediction | null
  judgeBankAnswer(llmComplete: LlmComplete, q: BankQuestion, answer: string, op: string, ref: { course: string; node: string; qid: string }): Promise<{ score: number; feedback: string }>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  logGradingFailure(rec: { course: string; node: string; qid: string; kind: string; attempt: number; error: string; raw: string }): Promise<void>
  nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }>
  nof1QueueEffect(today: string): Promise<{ id: number; variable: Nof1Variable; arm: string } | null>
  noteSourceAnswer(llmComplete: LlmComplete, sourceId: string, qid: string, answer: string, opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null; elapsed_s?: number | null }): Promise<Record<string, unknown>>
  noteSourceForget(sourceId: string, qid: string): Promise<Record<string, unknown>>
  noteSourceRate(sourceId: string, qid: string, r: number): Promise<Record<string, unknown>>
  questionContext(courseKey: string | undefined, node: string, qid: string, op: string): Promise<Record<string, unknown>>
  questionView(q: BankQuestion, i: number, opts?: { today?: string }): Record<string, unknown>
  refreshRepCard(c: CourseEntry, graph: Graph, node: string): Promise<Fm | null>
  resolveNote(vaultRoot: string, input: string, centerRel: string): Promise<{ path: string; node: string; course: string }>
  saveNodeNote(path: string, fm: Fm, body: string): Promise<void>
  sched(courseRoot: string | null): Promise<FSRS>
  updateNoteFm(path: string, fm: Fm): Promise<void>
  vaultPriorFor(graph: Graph, node: string): Promise<string>
}"""

lord_replaces = [
    ("""/** Content 域对门面的窄面""",
     """import type { Store } from './store.ts'
import type { Paths } from './paths.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank, BankQuestion } from './question-bank.ts'
import type { Content } from './content.ts'
import type { Sessions } from './sessions.ts'
import type { LearnerCards } from './learner-cards.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { Fm, CourseEntry } from './types.ts'
import type { LlmComplete } from './llm.ts'
import type { JolPrediction } from './jol.ts'
import type { Nof1Variable } from './types.ts'
import type { BandPref } from './adaptive.ts'
import type { ErrorCard } from './error-cards.ts'
import type { FSRS } from 'ts-fsrs'

/** Content 域对门面的窄面"""),
]

facade_replaces = [
    ("""import { Content } from './content.ts'""",
     """import { Content } from './content.ts'
import { ContentSubsystem } from './content-subsystem.ts'"""),
    ("""  /** Graph 子系统（图域，#152 刀 7）：窄面注入构造，见 constructor 尾部。 */
  private graph: GraphSubsystem""",
     """  /** Graph 子系统（图域，#152 刀 7）：窄面注入构造，见 constructor 尾部。 */
  private graph: GraphSubsystem
  /** Content 子系统（内容管线域，#152 刀 8）：窄面注入构造，见 constructor 尾部。 */
  private content2: ContentSubsystem"""),
    ("""      experimentApply: pid => this.experimentApply(pid),
    })
  }""",
     """      experimentApply: pid => this.experimentApply(pid),
    })
    this.content2 = new ContentSubsystem({
      store: this.store, paths: this.paths, registry: this.registry, bank: this.bank,
      content: this.content, sessions: this.sessions, learnerCards: this.learnerCards,
      vaultRoot: this.vaultRoot, jolRng: () => this.jolRng,
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      bandDefault: () => this.bandDefault(),
      calibrationHintsConfig: () => this.calibrationHintsConfig(),
      collectNoteSourceCards: today => this.collectNoteSourceCards(today),
      enabledCourses: () => this.enabledCourses(),
      ensureNote: (root, graph, node) => this.ensureNote(root, graph, node),
      errorCardTriples: (courses, nodeFilter) => this.errorCardTriples(courses, nodeFilter),
      exerciseGated: (c, node) => this.exerciseGated(c, node),
      expTag: (courseName, node, qid, today) => this.expTag(courseName, node, qid, today),
      isNoteSourceCourse: courseKey => this.isNoteSourceCourse(courseKey),
      jolConfig: () => this.jolConfig(),
      jolPredicted: p => this.jolPredicted(p),
      judgeBankAnswer: (llmComplete, q, answer, op, ref) => this.judgeBankAnswer(llmComplete, q, answer, op, ref),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      logGradingFailure: rec => this.logGradingFailure(rec),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      nof1QueueEffect: today => this.nof1QueueEffect(today),
      noteSourceAnswer: (llmComplete, sourceId, qid, answer, opts) => this.noteSourceAnswer(llmComplete, sourceId, qid, answer, opts),
      noteSourceForget: (sourceId, qid) => this.noteSourceForget(sourceId, qid),
      noteSourceRate: (sourceId, qid, r) => this.noteSourceRate(sourceId, qid, r),
      questionContext: (courseKey, node, qid, op) => this.questionContext(courseKey, node, qid, op),
      questionView: (q, i, opts) => this.questionView(q, i, opts),
      refreshRepCard: (c, graph, node) => this.refreshRepCard(c, graph, node),
      resolveNote: (vaultRoot, input, centerRel) => this.resolveNote(vaultRoot, input, centerRel),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      sched: courseRoot => this.sched(courseRoot),
      updateNoteFm: (path, fm) => this.updateNoteFm(path, fm),
      vaultPriorFor: (graph, node) => this.vaultPriorFor(graph, node),
    })
  }"""),
]
