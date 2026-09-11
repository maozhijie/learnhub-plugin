/**
 * 引擎门面读视图的命名类型（learnhub-plugin/src/engine/views）。
 *
 * 背景：门面（index.ts）的读方法历史上以 `Record<string, unknown>` 裸返回，UI 侧
 * （ui/src/types.ts）手工镜像形状并逐渐漂移。本模块把这些返回形状收口为命名类型：
 * index.ts 的方法签名引用这里的名字，UI 通过 re-export 消费同一名词（引擎形状 =
 * 事实源，本文件逐处注释产出方法）。
 *
 * 诚实可选：字段按引擎实际返回标注——条件展开（`...(x ? {y} : {})`）一律 `y?: T`；
 * 双分支返回（课程通道 / 笔记源伪课程通道）形状不同处，公共字段必填、独有字段可选。
 *
 * 注意：本模块是纯类型模块（全部 `import type`），运行时永不加载——index.ts 以
 * `import type` 引用，strip 模式下整句擦除。说明符一律带 `.ts` 扩展名（与其余 engine
 * 文件一致）：宿主根 tsconfig 走 nodenext（#170 类型门），无扩展名的相对说明符在那里
 * 直接是错；ui 的 tsc/vite 按 bundler 语义同样解析 `.ts`（allowImportingTsExtensions）。
 * 依赖只取 node 内建无关的模块，保证 ui typecheck 能把本模块拉进程序。
 */
import type {
  ContentStatus, EncEdge, FsrsBlock, GrowthOperator, SectionManifest, Stage,
} from './types.ts'
import type { AlloKind } from './grading.ts'
import type { JolBin, JolPrediction } from './jol.ts'
import type { CompletionFold } from './seed.ts'
import type { ProbationCourseView } from './probation.ts'

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
  ErrorCardFace, LessonDoc, LessonSection, QuestionItem, QuestionsDoc, QueueItem, ReviewCard, ReviewQueueDoc, TreeBlock, TreeCourse, TreeDoc, TreeNode, TreeRegion,
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

/** 内容诊断建议项（B1 #69；attribution.diagnosticView 的产出，status/recommend 附带）。 */
export interface DiagnosticEntry {
  node: string
  section: string
  sectionTitle: string
  signal: 'R1' | 'R2'
  escalate: boolean
  fresh: boolean
  reason: string
  evidence: Record<string, number | string>
  /** 重写此节的直达动作定位。 */
  rewrite: { course: string; node: string; section: string }
  /** 讲解此节的直达动作定位。 */
  explain: { course: string; node: string }
}

/** 软闸建议项（#54 R 半）：被 R-gate 拦下的候选节点 → 衰减前置清单（含直达复习入口）。 */
export interface StatusGateAdvice {
  /** 衰减前置节点名。 */
  pre: string
  /** 该前置当前可回忆度 R。 */
  r: number
  /** 该前置当前到期题数。 */
  due: number
  /** 直达复习入口（review-queue 的 node 过滤）。 */
  entry: { course: string; node: string }
}

export interface StatusCourse {
  /** 注册表 id（旧注册表条目可缺省）。 */
  id?: string
  name: string
  total: number
  counts: Record<Stage, number>
  due_today: number
  overdue: Array<{ node: string; since: string; count: number; path: string | null }>
  ready: Array<{ node: string; path: string | null }>
  gated: Array<{ node: string; path: string | null }>
  blocked: Record<string, StatusGateAdvice[]>
  /** 内容诊断建议项（#69 B1）：该课程命中时附带（facade 逐课程过滤 diagnosticsAdvice）。 */
  diagnostics?: DiagnosticEntry[]
  /** 完成宣告（#142 雾区条款上半，读侧折叠零写副作用）：有终点锚的课程附带——
   * 能力锚定 = 终点 mastery≥阈值且闭包健康；覆盖锚定 = 块工作表+终点。零写侧状态。 */
  completion?: CompletionFold
  /** 插入实验面（#146）：在途插入节点（「实验中」标记取数）、到期未决、三率
   * （滚动 30 学习日）与韧性闸门现势——插入积极性对学习者透明。 */
  probation?: ProbationCourseView
}

export interface StatusDoc {
  /** 当前学习日（ADR-0020；日界可配置，非必为日历日）。 */
  date: string
  /** 生效日界 'HH:mm'（配置三件套静默回落时的可见性补偿）。 */
  day_cutoff: string
  courses: StatusCourse[]
}

// ---- recommend（GET /api/recommend、learnhub_recommend；recommend → sessions.recommendEvents）----

export type RecEventType = 'new' | 'review' | 'overdue' | 'learning' | 'struggle' | 'diagnostic' | 'pin' | 'sleep'

/** A3 复习建议项（#54/#55；sessions.AdviceItem 的视图镜像——sessions 依赖 node:fs，
 * ui 侧 tsc 无法拉入该模块，故按其形状在本模块声明，改动需两处同步）。 */
export interface AdviceItem { node: string; w?: number; r: number; due: number }

export interface RecEvent {
  type: RecEventType
  course: string
  node: string
  region: string
  score: number
  why: string
  /** 节点课程笔记的 vault 相对路径（无笔记 = null）。 */
  path: string | null
  /** 已生成可读正文（点开有东西读；列表三态标识数据源）。 */
  hasContent: boolean
  /** A3 定向复习建议项（#54/#55）：软闸/enc 回退——先复习建议节点的到期题。 */
  advice?: AdviceItem[]
  /** 内容诊断建议项（B1 #69）：附着在学习事件上或独立 diagnostic 事件。 */
  diagnostics?: DiagnosticEntry[]
  /** 「今天学它」pin 标识（E3 #67）：当日课程内置顶，次日自动失效。 */
  pinned?: true
  /** 挂载的执行意图（C-5 #84）：if-then 计划（稳定线索 + 单一具体行动），随 pin 当日过期。
   * habits.ExecutionIntention 的视图镜像（habits.ts 依赖 node:fs，ui 侧无法拉入）。 */
  intention?: { cue: string; action: string }
  /** D-4 睡眠耦合建议（#85）：重巩固型节点的「睡前练、醒后验」时段建议（可关）。 */
  sleep?: SleepSuggestionEntry
}

/** 睡眠耦合建议条目（sleep.ts SleepSuggestion 的视图镜像）。 */
export interface SleepSuggestionEntry {
  /** 主建议：睡前练、醒后验（Walker 2002/2005 措辞）。 */
  text: string
  /** 可选心理演练附注（r≈0.13 小效应，预期管理措辞）。 */
  rehearsal: string
}

export interface RecommendDoc { date: string; events: RecEvent[] }

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
