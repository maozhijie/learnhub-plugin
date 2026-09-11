export type { DiagnosticEntry } from './attribution.ts'
export type {
  AdviceItem, RecommendDoc, RecEvent, RecEventType, SleepSuggestionEntry,
  StatusCourse, StatusDoc, StatusGateAdvice,
} from './sessions.ts'

/** 提案记录（store/proposals 持久化条目）与节清单（frontmatter content.sections）
 * 的转发导出：graphReject/graphProposals 的返回与 LessonDoc.manifest 引用，
 * ui 侧经此统一 re-export。 */
export type { ProposalRec, SectionManifest } from './types.ts'

// ---- 共享词汇 ----

// sched 域视图类型归档 views/sched.ts（#152）：叶子文件——领主直引它，不经本 barrel 牵进重模块（R7）。
export type {
  EtaItem, HistogramBin, MemoryHealthDoc, XpStatus,
} from './views/sched.ts'


// content 域视图类型归档 views/content.ts（#152）：叶子文件——领主直引它，不经本 barrel 牵进重模块（R7）。
export type {
  AnswerResult, QuestionForgetResult, QuestionRateResult,
} from './views/content.ts'


// content 域视图类型归档 views/content.ts（#152）：叶子文件——领主直引它，不经本 barrel 牵进重模块（R7）。
export type {
  ErrorCardFace, LessonDoc, LessonSection, QuestionItem, QuestionsDoc, QueueItem, QueueCard, ReviewCard, ReviewQueueDoc, TreeBlock, TreeCourse, TreeDoc, TreeNode, TreeRegion,
} from './views/content.ts'


// graph 域视图类型归档 views/graph.ts（#152）：叶子文件——领主直引它，不经本 barrel 牵进重模块（R7）。
export type {
  GraphApplyEditResult, GraphApplyEnrichResult, GraphApplyResult, GraphApplySeedResult, GraphBrowseBlock, GraphBrowseDoc, GraphBrowseNode, GraphBrowseRegion, GraphDoc, GraphElementsDoc, GraphEncBackfillNoneResult, GraphEncBackfillProposedResult, GraphEncBackfillResult, GraphJumpCandidate, GraphNodeDoc, GraphNodeSchema, GraphPathRelatedResult, GraphPathResult, GraphPathUnrelatedResult,
} from './views/graph.ts'


// 题库域视图类型归档 views/bank.ts（#152 刀 6）：叶子文件——领主 question-bank
// 直引它，不经本 barrel 牵进重模块（R7）。
export type {
  BankEntry, BankQuestionView, CalibrationAdvice, CleanupGroup, CleanupPreviewDoc, CleanupReason, DifficultyAdviceDoc, DifficultyAdviceNode, DisputeApplyResult, DisputeReviewResult, ErrorAnswerResult, ErrorArchiveResult, ErrorCardItem, ErrorGenerateResult, ErrorMineDoc, ErrorPatternItem, ErrorQueueDoc, QuestionGetDoc, QuestionKind, QuestionsAllDoc, TooEasyAdvice,
} from './views/bank.ts'



// ---- status（GET /api/status、learnhub_status；statusJson）----





// ---- recommend（GET /api/recommend、learnhub_recommend；recommend → sessions.recommendEvents）----





// ---- doctor（GET /api/doctor；fm schema 对账，doctor）----

export interface DoctorBrokenNote { path: string; node?: string; reason: string }

export interface DoctorCourseReport {
  course: string
  total: number
  notes: number
  broken: DoctorBrokenNote[]
  missing: string[]
  unknown: string[]
}

export interface DoctorDoc { generated_at: string; courses: DoctorCourseReport[] }

// ---- graph analyze（GET /api/graph、learnhub_graph_analyze；graphAnalyze → analysis.analyzeGraph）----
// analysis.ts 依赖 node:fs 闭包，ui 侧 tsc 无法拉入——此处在视图层镜像 GraphAnalysis
// 形状（改动需与 analysis.ts 同步）。





// ---- 图探索（graphNode / graphBrowse / graphPath）----








// ---- 提案门禁（graphPropose / graphApply / graphEncBackfill；proposals.GraphProposals）----
// Graph*ProposalResult 四型住 proposals.ts（提案域词汇，#152 刀 5 归位——projects 的
// 窄面引用它们，经 views barrel 会绕出类型环）。
export type {
  GraphEditProposalResult, GraphSeedProposalResult, GraphEnrichProposalResult, GraphProposeResult,
} from './views/proposals.ts'
// 图谱域：edit（变更）、seed（种子，#142）与 enrich（富化覆盖层，#140）。

/** 变更提案受理（proposeEdit）。warns = 受理门非阻提示（概念字段组窄节点等）。
 * operator/disagreement = 生长批受理时随行（#145 note 区算子标签；disagreement=带分歧声明）。
 * compass_rewrite（受理=意图）与 apply 侧 compass_rewritten（已落盘=事实）分相位命名。 */
/** 种子提案受理（proposeSeed，#142）：课程新入口，一次人审即开工。
 * prior_feed_unresponded = ≥0.7 先验候选未被结构回应的条数（喂料分流，非阻可见）。 */







// ---- 内容管线（queueItemsAll / lesson / coursesTree）----




// ---- 课程工作区树（coursesTree；course → region → block → node）----


// ---- 题目作答视图（questions / reviewQueue 共用；questionView 产出）----



// ---- 复习刷卡（reviewQueue / questionAnswer / questionRate / questionForget）----




// ---- 自评校准画像（calibrationProfile；ADR-0022 #104 分源自省面）——视图类型归档 views/learner.ts（#152 刀 4）----

export type {
  CalibrationSourceProfile, CalibrationProfileDoc,
} from './views/learner.ts'

// ---- D 区个人实验室（#85/#110/#111/#112）——视图类型归档 views/lab.ts（#152 刀 2）----

export type {
  Nof1Template, ExperimentDef, Nof1Analysis, Nof1ArmStats,
  SandboxDoc, ExperimentProposeResult, ExperimentStartResult,
} from './views/lab.ts'






// ---- Anki 通道（C2 #63 / ADR-0011）——视图类型归档 views/channels.ts（#152 刀 3）----

export type { AnkiStatusDoc } from './views/channels.ts'

// ---- XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注；xpStatus）----



// ---- 记忆健康仪表盘（#61 A2 / ADR-0012；memoryHealth）----



// ---- E1「我的卡」（#45 / #68 / #70；learnerQueue / learnerCardRate / learnerCardForget）——视图类型归档 views/learner.ts（#152 刀 4）----

export type {
  LearnerCardKind, LearnerCardItem, LearnerQueueDoc,
} from './views/learner.ts'

// ---- C-3「错误对比卡」（#82；errorCardMine / errorCardGenerate / errorCardQueue / errorCardAnswer）----








/** E 卡自评结算（learnerCardRate）：XP 走无绑定行已落 journal，这里带回执（ADR-0021）。 */
export interface LearnerRateResult {
  course: string
  node: string
  id: string
  rating: number
  /** 推卡后的新到期日。 */
  due: string
  scheduled: true
  /** 本次结算的无绑定 XP（自评通过 = max(1, round(难度))，ADR-0021）。 */
  xp: number
}

/** E 卡忘记申报（learnerCardForget）：rating=1 推卡，0 XP 无绑定行。 */
export interface LearnerForgetResult {
  course: string
  node: string
  id: string
  rating: 1
  due: string
  scheduled: true
  xp: 0
}

/** 归档/恢复一张我的卡（learnerCardArchive；管理面，canonical 零写入）。 */
export interface LearnerArchiveResult {
  course: string
  node: string
  id: string
  archived: boolean
}

// ---- 题目管理（questionGet / questionsAll / difficultyAdvice）----





// ---- B2 难度感知回流（决议 #41 / #58；difficultyAdvice）----





// ---- 题库一键清理（ADR-0032；bankCleanupPreview / bankCleanupApply）----




// ---- C1 笔记复习源（#59 / ADR-0010）——视图类型归档 views/channels.ts（#152 刀 3）----

export type {
  NoteSourceStatus, NoteSourceItem, NoteSourceDoc, NoteSourceRegisterResult,
} from './views/channels.ts'

// ---- 技能条目 lane（U 区 #89 / ADR-0018：skillList，GET /api/skills、learnhub_skill_list）——视图类型归档 views/learner.ts（#152 刀 4）----

export type {
  SkillLaneItem, SkillsListDoc,
} from './views/learner.ts'

// ---- 习惯（U 区 #90 / ADR-0017：habitList / habitShow，GET /api/habits、/api/habit）——视图类型归档 views/learner.ts（#152 刀 4）----

export type {
  HabitListItem, HabitsListDoc, HabitCurvePoint, HabitShowDoc,
} from './views/learner.ts'

// ---- 项目域（P 区 / ADR-0015）：2×2 交叉视图——视图类型归档 views/project.ts（#152 刀 5）----

export type {
  ProjectLifecycle, FadingTier, ProjectExecRec, ProjectExecBackflow, ProjectExecResult, ProjectCrossDoc,
} from './views/project.ts'

// ---- U4 周复盘 Weekly Kata（#114 / ADR-0026：Learner Output，零 XP 零 canonical）——视图类型归档 views/learner.ts（#152 刀 4）----

export type {
  KataDoc,
} from './views/learner.ts'
