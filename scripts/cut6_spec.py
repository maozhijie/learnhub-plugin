# 刀 6 规格：bank 五节 → BankSubsystem 住 question-bank.ts
lord_file = 'src/engine/question-bank.ts'
class_name = 'BankSubsystem'
deps_name = 'BankDeps'
field_name = 'bank2'

sections = [
    ('C3', '  // ---- C-3 错误对比卡', '  // ---- U 区·技能条目'),
    ('panel', '  // ---- 学习面板扩展（题目管理/课程删除）', '  // ---- B2 难度感知回流'),
    ('B2', '  // ---- B2 难度感知回流', '  // ---- 题库一键清理'),
    ('cleanup', '  // ---- 题库一键清理', '  // ---- 瑕疵题勘误与判罚冲正'),
    ('erratum', '  // ---- 瑕疵题勘误与判罚冲正', '  // ---- utils'),
]

fwd_notes = {
    'C3': '以下 错误对比卡/学习面板题目管理/B2 回流/一键清理/勘误冲正 五节方法体住 BankSubsystem（question-bank.ts，#152 刀 6 聚合+转发）',
}

lord_header = """
// ---- Bank 子系统（#152 刀 6 / ADR-0043）：题库域——C-3 错误对比卡、面板题目管理、
// B2 难度感知回流、题库一键清理、瑕疵题勘误与判罚冲正。住领主文件 question-bank.ts
// （聚合+转发）；跨子系统依赖经结构化窄面 BankDeps 由门面注入（运行时回引门面，
// 类型面零门面导入——R6）。"""

deps_text = """/** Bank 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface BankDeps {
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
  content: typeof Content
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
  questionContext(courseKey: string | undefined, node: string, qid: string, op: string): Promise<Record<string, unknown>>
  exerciseGated(c: CourseEntry, node: string): Promise<boolean>
  repairInvokesOnce(llm: LlmComplete, items: unknown[], scope: string[]): Promise<number>
  admitQuestion(root: string, node: string, q: Record<string, unknown>, stem: string, existingStems: Array<{ q: string; kind?: string; difficulty?: number }>): Promise<{ verdict: 'added' } | { verdict: 'duplicate'; against: string } | { verdict: 'invalid' }>
  explainPoints(c: CourseEntry, graph: Graph, node: string): Promise<ExplainPoint[]>
  isNoteSourceCourse(courseKey: string | undefined): Promise<boolean>
}"""

lord_replaces = [
    ("""import type { Paths } from './paths.ts'""",
     """import type { Paths } from './paths.ts'
import type { ErrorCards } from './error-cards.ts'
import type { ConceptRegistry } from './concepts.ts'
import { Content } from './content.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import { asFm, loadNote, saveNote } from './notes.ts'
import type { FSRS } from 'ts-fsrs'
import type { EncEdge, ErratumRec, Fm, CourseEntry, JournalRec, PracticeRec, AdviceDismissRec, NoteSourceEntry, GRegion } from './types.ts'
import type { LlmComplete } from './llm.ts'
import type { ExplainPoint } from './explain.ts'
import { advanceStrict } from './advance.ts'
import { sectionEntryOf } from './attribution.ts'
import { nodeTierOf, perSectionQuizTarget, sectionTierLabel } from './complexity.ts'
import { invokesTagged, invokesUnregistered, namesOf } from './concepts.ts'
import { dayOfTs, nowIso } from './dates.ts'
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
import { NOTE_SOURCE_COURSE } from './note-source.ts'
import { bankStemList, existingStemsPromptBlock, findDuplicateStem } from './question-dedup.ts'
import { questionViolation, repairQuestionStrings, auditQuestion } from './question-hygiene.ts'
import type {
  CleanupGroup, CleanupPreviewDoc, DifficultyAdviceDoc, DisputeApplyResult, DisputeReviewResult,
  ErrorAnswerResult, ErrorArchiveResult, ErrorCardItem, ErrorGenerateResult, ErrorMineDoc, ErrorQueueDoc,
  QuestionGetDoc, QuestionsAllDoc,
} from './views.ts'"""),
]

facade_replaces = [
    ("""import { QuestionBank, questionAnswerShapeError, validateBank } from './question-bank.ts'""",
     """import { QuestionBank, questionAnswerShapeError, validateBank, BankSubsystem } from './question-bank.ts'"""),
    ("""  /** Project 子系统（项目域，#152 刀 5）：窄面注入构造，见 constructor 尾部。 */
  private project: ProjectSubsystem""",
     """  /** Project 子系统（项目域，#152 刀 5）：窄面注入构造，见 constructor 尾部。 */
  private project: ProjectSubsystem
  /** Bank 子系统（题库域，#152 刀 6）：窄面注入构造，见 constructor 尾部。 */
  private bank2: BankSubsystem"""),
    ("""      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
    })
  }""",
     """      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
    })
    this.bank2 = new BankSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, errorCards: this.errorCards, concepts: this.concepts,
      proposals: this.proposals, content: Content, schedCache: this.schedCache,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      loadPrompt: kind => this.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      vaultPriorFor: (graph, node) => this.vaultPriorFor(graph, node),
      logGradingFailure: rec => this.logGradingFailure(rec),
      questionContext: (courseKey, node, qid, op) => this.questionContext(courseKey, node, qid, op),
      exerciseGated: (c, node) => this.exerciseGated(c, node),
      repairInvokesOnce: (llm, items, scope) => this.repairInvokesOnce(llm, items, scope),
      admitQuestion: (root, node, q, stem, existingStems) => this.admitQuestion(root, node, q, stem, existingStems),
      explainPoints: (c, graph, node) => this.explainPoints(c, graph, node),
      isNoteSourceCourse: courseKey => this.isNoteSourceCourse(courseKey),
    })
  }"""),
]
