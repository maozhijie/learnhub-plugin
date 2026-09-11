# 刀 3 规格：channels 五节 → ChannelsSubsystem 住 note-source.ts
lord_file = 'src/engine/note-source.ts'
class_name = 'ChannelsSubsystem'
deps_name = 'ChannelsDeps'
field_name = 'channels'

sections = [
    ('C1', '  // ---- C1 笔记复习源', '  // ---- 卡池镜像'),
    ('V4', '  // ---- 卡池镜像', '  // ---- 漂移治理'),
    ('V6', '  // ---- 漂移治理', '  // ---- 用户排除清单'),
    ('V1', '  // ---- 用户排除清单', '  // ---- C2 Anki 通道'),
    ('C2', '  // ---- C2 Anki 通道', '  // ---- 节点跳过 / 完成确认'),
]

fwd_notes = {
    'C1': '以下 C1/卡池镜像/漂移治理/排除清单/Anki 通道的方法体住 ChannelsSubsystem（note-source.ts，#152 刀 3 聚合+转发）',
}

lord_header = """
// ---- Channels 子系统（#152 刀 3 / ADR-0043）：通道域——C1 笔记复习源、卡池镜像、
// 漂移治理、用户排除清单、C2 Anki 通道。住领主文件 note-source.ts（聚合+转发）；
// 跨子系统依赖经结构化窄面 ChannelsDeps 由门面注入（运行时回引门面，类型面零门面
// 导入——R6）。registry 成员须就地结构化：registry.ts 值依赖本域
// validateNoteSourceEntries，引 Registry 类型即成环。"""

deps_text = """/** Channels 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface ChannelsDeps {
  /** store 结构化窄面：本域是低层模块（registry/vault-links 等反向依赖它），引 Store
   * 类型会把存储层拖成下游，成环（R7 实测 store→…→vault-links→note-source→store）。 */
  store: {
    appendJournal(rec: Omit<JournalRec, 'ts'> & { ts?: string }): Promise<JournalRec>
    appendPractice(rec: Omit<PracticeRec, 'ts'> & { ts?: string }): Promise<PracticeRec>
    appendReview(rec: Omit<ReviewRec, 'ts'> & { ts?: string }): Promise<ReviewRec>
  }
  paths: Paths
  /** registry 结构化窄面：registry 值依赖本域 validateNoteSourceEntries，引 Registry 类型即成环（R7）。 */
  registry: {
    load(): Promise<CourseEntry[]>
    loadNoteSources(): Promise<NoteSourceEntry[]>
    save(courses: CourseEntry[], noteSources?: NoteSourceEntry[]): Promise<void>
    get(key: string): Promise<CourseEntry | null>
  }
  bank: Pick<QuestionBank, 'addQuestion' | 'bankPath' | 'load' | 'updateQuestionEvidence'>
  ankiMirror: Pick<AnkiMirror, 'load' | 'save'>
  noteManifest: Pick<NoteSourceManifest, 'load' | 'save'>
  /** vault 根目录（笔记源注册路径归一用）。 */
  vaultRoot: string
  sched(courseRoot: string | null): Promise<FSRS>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  loadPrompt(kind: string): Promise<string>
  questionView(q: BankQuestion, i: number, opts?: { today?: string }): Record<string, unknown>
  judgeBankAnswer(llmComplete: LlmComplete, q: BankQuestion, answer: string, op?: string, ref?: { course: string; node: string; qid: string }): Promise<{ score: number; feedback: string }>
  refreshRepCard(c: CourseEntry, graph: Graph, node: string): Promise<Fm | null>
}"""

lord_replaces = [
    ("""import type { NoteSourceEntry } from './types.ts'
import type { Paths } from './paths.ts'""",
     """import type { NoteSourceEntry, Fm, CourseEntry, FsrsBlock, JournalRec, PracticeRec, ReviewRec } from './types.ts'
import type { Paths } from './paths.ts'
import type { AnkiMirror, AnkiMirrorEntry, AnkiNotePayload, AnkiTransport } from './anki.ts'
import { ANKI_MODEL, ANKI_TAG, ankiAddNote, ankiCardPayload, ankiCardReviews, ankiCardsInfo, ankiCreateDeck, ankiCreateModel, ankiDeckNames, ankiDeleteNotes, ankiFindNotes, ankiModelNames, ankiNotesInfo, ankiUpdateNoteFields, deckNameOf, isAnkiNoteMissing, isoFromMs, mapAnkiEase, parseSourceKey, planMirrorSync } from './anki.ts'
import { advance, advancePending, alreadyAdvanced } from './advance.ts'
import { applyRatingBlock, getScheduler, previewDue, retrievabilityBlock } from './srs.ts'
import { combinedDifficulty } from './adaptive.ts'
import { invokesTagged } from './concepts.ts'
import { PASS_SCORE } from './grading.ts'
import type { LlmComplete } from './llm.ts'
import type { JolPrediction } from './jol.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { QuestionBank, BankDoc, BankQuestion } from './question-bank.ts'
import type { FSRS } from 'ts-fsrs'
import { dayOfTs, nowIso } from './dates.ts'
import { readDayCutoff, xpForAnswer } from './xp.ts'"""),
    ("import { readLearnhubConfig, writeLearnhubConfig } from './io.ts'",
     "import { atomicWrite, readLearnhubConfig, writeLearnhubConfig } from './io.ts'"),
    ("import { PASS_SCORE } from './grading.ts'",
     "import { PASS_SCORE } from './grading.ts'\nimport { findDuplicateStem, existingStemsPromptBlock, bankStemList } from './question-dedup.ts'"),
]

facade_replaces = [
    ("""readNoteSourceExcludes, sourceHint, stripFrontmatter, titleOfBody, writeNoteSourceExcludes } from './note-source.ts'""",
     """readNoteSourceExcludes, sourceHint, stripFrontmatter, titleOfBody, writeNoteSourceExcludes, ChannelsSubsystem } from './note-source.ts'"""),
    ("""  /** Lab 子系统（D 系列实验台，#152 刀 2）：窄面注入构造，见 constructor 尾部。 */
  private lab: LabSubsystem""",
     """  /** Lab 子系统（D 系列实验台，#152 刀 2）：窄面注入构造，见 constructor 尾部。 */
  private lab: LabSubsystem
  /** Channels 子系统（通道域，#152 刀 3）：窄面注入构造，见 constructor 尾部。 */
  private channels: ChannelsSubsystem"""),
    ("""      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })""",
     """      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })
    this.channels = new ChannelsSubsystem({
      store: this.store, paths: this.paths, bank: this.bank,
      ankiMirror: this.ankiMirror, noteManifest: this.noteManifest, vaultRoot: this.vaultRoot,
      registry: {
        load: () => this.registry.load(),
        loadNoteSources: () => this.registry.loadNoteSources(),
        save: (courses, noteSources) => this.registry.save(courses, noteSources),
        get: key => this.registry.get(key),
      },
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      loadPrompt: kind => this.loadPrompt(kind),
      questionView: (q, i, opts) => this.questionView(q, i, opts),
      judgeBankAnswer: (llmComplete, q, answer, op, ref) => this.judgeBankAnswer(llmComplete, q, answer, op, ref),
      refreshRepCard: (c, graph, node) => this.refreshRepCard(c, graph, node),
    })"""),
]
