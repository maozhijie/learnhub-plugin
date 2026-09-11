/** 面板类型：**三处出处，零手工镜像**（#169 / ADR-0045 裁定 7）。
 *
 * 1. 引擎读视图 → 统一 re-export 自 `src/engine/views.ts`（纯类型模块，引擎形状是事实源）；
 * 2. 引擎**内联返回形状** → 从命令注册表的 `output` 派生（`CommandOutput<id>` = 该命令引擎入口
 *    的返回类型）——「响应类型从 output 派生」在这里落地，19 处手工镜像随之消失；
 * 3. 宿主侧形状 → 从宿主模块派生（`generationStatus` 的返回类型）或本地词汇（UI 专有）。
 *
 * 纪律：本文件不再出现「按引擎 schema 手抄一遍」的 interface。新增形状先问它属于哪一类：
 * 引擎返回 → 注册表；宿主返回 → 宿主模块；UI 专有 → 本地词汇。
 */
import type { StatusDoc } from '../../src/engine/views'
import type { QuestionAuditReport } from '../../src/engine/question-hygiene'
import type { CommandOutput } from '../../src/commands/index'
import type { generationStatus } from '../../src/host/jobs'
import type { LearnhubEngine } from '../../src/engine/index'

export type { QuestionAuditReport }

// ---- UI 本地词汇（面板专有，非引擎形状） ----

export type Stage = 'unseen' | 'ready' | 'learning' | 'review' | 'mastered' | 'skipped'
export type ContentStatus = 'draft' | 'reviewed' | 'flagged'

/** 当前 LLM 配置（宿主路由层附加在 /status 上；模型透明只读展示）。 */
export interface LlmView { provider: string; model: string; fast_effort: string; deep_effort: string }
/** /status 响应 = 引擎 StatusDoc + 宿主侧 llm 配置。 */
export type StatusWithLlm = StatusDoc & { llm?: LlmView }

/** 能力指南条目（GET /agent-guide；宿主 `src/host/tools.ts` 的 AGENT_GUIDE 单一事实源）。 */
export interface AgentGuideItem { tool: string; page: string; text: string; prompt?: string }

// ---- 引擎读视图（src/engine/views.ts 命名导出）----

export type {
  AdviceItem, AnkiStatusDoc, AnswerResult, BankEntry, CalibrationAdvice, CalibrationProfileDoc,
  CalibrationSourceProfile, CleanupGroup, CleanupPreviewDoc, DiagnosticEntry,
  DifficultyAdviceDoc, DifficultyAdviceNode, DisputeApplyResult, DisputeReviewResult, DoctorDoc, ErrorAnswerResult,
  ErrorArchiveResult, ErrorCardFace, ErrorCardItem, ErrorGenerateResult, ErrorQueueDoc,
  EtaItem, FadingTier, GraphApplyResult, GraphBrowseDoc,
  GraphDoc, GraphElementsDoc, GraphEncBackfillResult, GraphPathResult, GraphProposeResult,
  HabitCurvePoint, HabitListItem, HabitShowDoc, HabitsListDoc, HistogramBin, LearnerArchiveResult,
  LearnerCardItem, LearnerCardKind, LearnerForgetResult,
  LearnerQueueDoc, LearnerRateResult, LessonDoc, LessonSection, MemoryHealthDoc as MemoryHealth,
  NoteSourceDoc, NoteSourceItem, NoteSourceRegisterResult, ProposalRec as PropItem,
  ProjectCrossDoc, ProjectExecRec, ProjectExecResult, ProjectLifecycle,
  QuestionForgetResult, QuestionGetDoc, QuestionItem, QuestionKind, QuestionRateResult,
  QuestionsAllDoc, QuestionsDoc, QueueCard, QueueItem, RecEvent, RecEventType, RecommendDoc, ReviewCard,
  ReviewQueueDoc, SectionManifest as SectionManifestItem, SkillLaneItem, SkillsListDoc, StatusCourse,
  StatusDoc, TooEasyAdvice,
  TreeBlock, TreeCourse, TreeDoc, TreeRegion, TreeNode, XpStatus,
} from '../../src/engine/views'

// ---- 宿主侧形状：从宿主模块派生（不镜像） ----

/** /generate/status 响应 = 宿主 `generationStatus` 的返回类型（任务注册表 + 队列状态）。 */
export type GenStatusDoc = Awaited<ReturnType<typeof generationStatus>>
/** 单条生成任务记录（key 与内容版本由宿主附加）。 */
export type GenJobItem = GenStatusDoc['jobs'][number]

// ---- 引擎内联返回形状：从命令注册表的 output 派生（注册表是唯一出处） ----

export type JolConfig = CommandOutput<'jol'>
export type CalibrationHintsConfig = CommandOutput<'calibration-hints'>
export type CoachDoc = CommandOutput<'coach'>
export type AnkiExportResult = CommandOutput<'anki-export'>
export type AnkiImportResult = CommandOutput<'anki-import'>
export type OptimizeResult = CommandOutput<'optimize-params'>
export type UnderstandingResult = CommandOutput<'understanding-add'>
export type SleepConfig = CommandOutput<'sleep'>
export type ThermostatDoc = CommandOutput<'thermostat'>
export type ThermostatSuggestion = ThermostatDoc['suggestions'][number]
export type SandboxDoc = CommandOutput<'sandbox'>
export type KataDoc = CommandOutput<'kata-open'>
// 同类例外（多入口命令）：`/probation` 与工具面合并后没有单一 `output`（settleRechecks|probationStatus），
// 故从引擎入口直接派生——出处仍是引擎，只是不经注册表的 output。
export type ProbationDoc = Awaited<ReturnType<LearnhubEngine['probationStatus']>>
export type ProjectFm = CommandOutput<'project-list'>[number]
export type ProjectPlanItem = ProjectFm['plan'][number]

// 一处例外（有理由的）：`/experiments` 是**多入口命令**（一次读 templates + list + report 三处），
// 没有单一 `output` 可派——它的**组成**仍从引擎入口派生，只有复合本身是本文件写的三行。
export type Nof1Template = Awaited<ReturnType<LearnhubEngine['experimentTemplates']>>[number]
export type ExperimentDef = Awaited<ReturnType<LearnhubEngine['experimentList']>>[number]
export type Nof1Analysis = NonNullable<Awaited<ReturnType<LearnhubEngine['experimentReport']>>>['analysis']
export interface ExperimentsDoc {
  templates: Nof1Template[]
  experiments: ExperimentDef[]
  report: { experiment: ExperimentDef; analysis: Nof1Analysis } | null
}
