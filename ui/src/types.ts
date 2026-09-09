/** 面板类型：引擎读视图统一 re-export 自引擎侧命名类型（src/engine/views.ts，
 * 引擎形状 = 事实源，消灭手工镜像漂移）；本文件只保留 UI 本地词汇与宿主侧形状。 */

// ---- UI 本地词汇 ----

export type Stage = 'unseen' | 'ready' | 'learning' | 'review' | 'mastered' | 'skipped'
export type ContentStatus = 'draft' | 'reviewed' | 'flagged'

// ---- 引擎读视图（src/engine/views.ts 命名导出）----

export type {
  AdviceItem, AnkiStatusDoc, AnswerResult, BankEntry, CalibrationAdvice, CalibrationProfileDoc,
  CalibrationSourceProfile, DiagnosticEntry,
  DifficultyAdviceDoc, DifficultyAdviceNode, DoctorDoc, EtaItem, FadingTier, GraphApplyResult, GraphBrowseDoc,
  GraphDoc, GraphElementsDoc, GraphEncBackfillResult, GraphPathResult, GraphProposeResult,
  HabitCurvePoint, HabitListItem, HabitShowDoc, HabitsListDoc, HistogramBin, LearnerArchiveResult,
  LearnerCardItem, LearnerCardKind, LearnerForgetResult,
  LearnerQueueDoc, LearnerRateResult, LessonDoc, LessonSection, MemoryHealthDoc as MemoryHealth,
  NoteSourceDoc, NoteSourceItem, NoteSourceRegisterResult, ProposalRec as PropItem,
  ProjectCrossDoc, ProjectExecRec, ProjectExecResult, ProjectLifecycle,
  QuestionForgetResult, QuestionGetDoc, QuestionItem, QuestionKind, QuestionRateResult,
  QuestionsAllDoc, QuestionsDoc, QueueItem, RecEvent, RecEventType, RecommendDoc, ReviewCard,
  ReviewQueueDoc, SectionManifest as SectionManifestItem, SkillLaneItem, SkillsListDoc, StatusCourse,
  StatusDoc, TooEasyAdvice,
  TreeBlock, TreeCourse, TreeDoc, TreeRegion, TreeNode, XpStatus,
} from '../../src/engine/views'

// ---- 项目域（P 区）档案轻量镜像（GET /projects 返回 projects.ProjectFm[];
// projects.ts 带值依赖不进 views.ts，这里按引擎 schema 镜像，与 validateProjectFm 同步）----

export interface ProjectPlanItem {
  id: string
  name: string
  task_class: string
  acceptance_hints: string
  est?: number
  nodes?: string[]
}

export interface ProjectFm {
  id: string
  name: string
  lifecycle: ProjectLifecycle
  tier: FadingTier
  goal: string
  plan: ProjectPlanItem[]
  created: string
  updated: string
}

import type { FadingTier, LearnerCardKind, ProjectLifecycle } from '../../src/engine/views'

// ---- 宿主侧形状（src/index.ts generation-jobs；非引擎门面读视图）----

export interface GenJobItem {
  key: string
  course: string
  node: string
  startedAt: string
  status: 'queued' | 'running' | 'cancelling' | 'done' | 'partial' | 'failed' | 'cancelled'
  /** 组合管线阶段：outline（大纲）→ sections（逐节正文）→ quiz（自动出题）；queued 无阶段。 */
  phase?: 'outline' | 'sections' | 'quiz'
  /** 逐节进度：done=已就绪节数 total=总节数 current=正在生成的节标题。 */
  progress?: { done: number; total: number; current?: string }
  message?: string
  /** 课程生成提示词风格（风格变体任务整节点一次成篇）。 */
  style?: string
  /** 该任务节点的内容版本（增量刷新依据；旧引擎响应无此字段）。 */
  contentVersion?: number
}

/** /generate/status 响应：任务注册表 + 全局队列状态（重启恢复后暂停待恢复）。 */
export interface GenStatusDoc {
  jobs: GenJobItem[]
  queuePaused: boolean
  queuedCount: number
}

// ---- 引擎内联类型的轻量镜像（引擎侧已是命名返回，非 Record 裸返回；保持 UI 名）----

/** JOL 抽查配置（GET/PUT /jol）。 */
export interface JolConfig { enabled: boolean; rate: number }

/** 过信轻提示配置（GET/PUT /calibration/hints，ADR-0022 #104）。 */
export interface CalibrationHintsConfig { hints_enabled: boolean }

/** 可用的困难教练（GET /coach，#65 E5）：只读信息性反馈。 */
export interface CoachDoc { messages: string[]; due_hard: number }

/** 导出到 Anki（POST /anki/export）：vault 到期集校准/重建镜象卡组的结果。 */
export interface AnkiExportResult { date: string; added: number; updated: number; removed: number; total: number; decks: string[] }
/** Anki 回写导入（POST /anki/import）：原始作答证据按 vault 调度重算的结果。 */
export interface AnkiImportResult { imported: number; advanced: number; skipped_same_day: number; skipped_unknown: number; unknown: string[] }

/** FSRS 参数优化器（A2 #62，POST /optimize-params）：门禁不满足/评估未更优时不写回。 */
export interface OptimizeResult {
  status: 'written' | 'skipped'
  reason?: string
  written?: string[]
  meta?: {
    trained_at: string
    reviews: number
    cards: number
    baseline_source: 'previous' | 'default'
    baseline_log_loss: number
    log_loss: number
    rmse_bins: number
    split_log_loss: number | null
    split_rmse_bins: number | null
  }
}

/** 「加我的理解」（E1 #70）：写注当下的 AI 定位反馈结果（判词入 E 档案，零 canonical）。 */
export interface UnderstandingResult {
  course: string
  node: string
  card: { id: string; kind: LearnerCardKind; count: number }
  verdict: { verdict: '对' | '部分对' | '错'; tags: string[]; advice?: string }
  reply: string
}

// ---- D 区个人实验室（#85/#110/#111/#112；引擎 views.ts/nof1.ts/sandbox.ts/thermostat.ts 形状镜像）----

export interface SleepConfig { enabled: boolean }

export interface ThermostatSuggestion {
  id: string
  knob: string
  title: string
  text: string
  apply: { config: string; value: string }
}

export interface ThermostatDoc {
  date: string
  course_region: {
    retention: { pass: number; fail: number; rate: number | null; real: number }
    retention_band: { label: string; level: string }
    band_choices: { sessions: number; answered: number; shares: Record<string, number> }
  }
  unbounded_region: {
    execution_ratings: { count: number; by_rating: Record<string, number> }
    note: string
  }
  project_region: {
    status: string
    note: string
    projects: Array<{ id: string; name: string; tier: string }>
  }
  knobs: Array<{ knob: string; title: string; status: string; current?: string | null }>
  suggestions: ThermostatSuggestion[]
}

export interface Nof1Template {
  id: string
  variable: string
  title: string
  question: string
  arms: string[]
  arm_labels: Record<string, string>
  unit: 'card' | 'batch'
  outcome: string
  description: string
  unlocked: boolean
  unlock_note?: string
}

export interface ExperimentDef {
  id: number
  template: string
  variable: string
  title: string
  question: string
  outcome: string
  arms: string[]
  arm_labels: Record<string, string>
  unit: 'card' | 'batch'
  scope_course: string | null
  assignment: { kind: 'card'; map: Record<string, string> } | { kind: 'batch'; start_day: string; order: string[] }
  per_arm_min: number
  started_day: string
  started_ts: string
  status: 'running' | 'stopped'
  stopped_day?: string
  proposal: number
}

export interface Nof1Analysis {
  ready: boolean
  per_arm: Array<{ arm: string; label: string; n: number; rate: number }>
  need_per_arm: number
  diff: number | null
  ci95: [number, number] | null
  p: number | null
  message: string
}

export interface ExperimentsDoc {
  templates: Nof1Template[]
  experiments: ExperimentDef[]
  report: { experiment: ExperimentDef; analysis: Nof1Analysis } | null
}

export interface SandboxDoc {
  wording: string
  date: string
  plan: { minutesPerDay: number; weeks: number }
  runs: number
  scope: { courses: string[]; nodes: number }
  curve: Array<{ week: number; p50: number; p80: number }>
  map: Array<{ node: string; p50: number; p80: number }>
  assumptions: string[]
}

// ---- U4 周复盘 Weekly Kata（#114 / ADR-0026）----

export interface KataDoc {
  date: string
  week_start: string
  week_end: string
  path: string
  created: boolean
  reality: string
  sections: Record<string, string>
  answered: boolean
  list: Array<{ week_start: string; answered: boolean }>
}
