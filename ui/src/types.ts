/** 引擎 API 返回形状（与 learnhub-plugin 引擎输出一一对应）。 */

export type Stage = 'unseen' | 'ready' | 'learning' | 'review' | 'mastered' | 'skipped'
export type ContentStatus = 'draft' | 'reviewed' | 'flagged'

export interface StatusCourse {
  id: string
  name: string
  total: number
  counts: { unseen: number; ready: number; learning: number; review: number; mastered: number; skipped: number }
  due_today: number
  overdue: Array<{ node: string; since: string; count: number; path: string | null }>
  ready: Array<{ node: string; path: string | null }>
  gated: Array<{ node: string; path: string | null }>
  blocked: Record<string, string[]>
}

export interface StatusDoc { date: string; courses: StatusCourse[] }

export interface TreeNode {
  node: string
  opt: boolean
  stage: Stage
  mastery: number
  contentVersion: number
  contentStatus: ContentStatus
  path: string | null
  hasBank: boolean
}
export interface TreeBlock { name: string; nodes: TreeNode[] }
export interface TreeRegion { name: string; color: string; blocks: TreeBlock[] }
export interface TreeCourse { name: string; id: string; regions: TreeRegion[] }
export interface TreeDoc { courses: TreeCourse[] }

/** graphAnalyze 输出：React Flow elements 格式（host 直接可喂 <ReactFlow>）。 */
export interface GraphNodeData {
  id: string
  region: string
  block: string
  depth: number
  stage: Stage
  opt: boolean
  /** 掌握度 0-1（派生值 = 0.7·完成卡稳定度完成度 + 0.3·练习 EMA，随复习增长、不因一次全对饱和）；底色深浅按它插值。 */
  mastery?: number
  /** practice = 交互实践节点（「练」角标）。 */
  type?: string
  /** 已生成可读正文（点开有东西读；列表/图三态标识数据源）。 */
  hasContent?: boolean
}
export interface GraphEdgeData { id: string; source: string; target: string; kind: string }
export interface GraphDoc {
  stats?: Record<string, unknown>
  unreachable?: string[]
  bottlenecks?: string[]
  lapse_hotspots?: string[]
  nodes: Array<{ data: GraphNodeData }>
  edges: Array<{ data: GraphEdgeData }>
}

export type RecEventType = 'new' | 'ready' | 'review' | 'overdue' | 'learning' | string
/** 内容诊断建议项（B1 #69：节级答错集中/单题反复失败的信号 + 重写直达动作）。 */
export interface DiagnosticEntry {
  section: string
  sectionTitle: string
  signal: 'R1' | 'R2'
  escalate: boolean
  reason: string
  rewrite: { course: string; node: string; section: string }
  explain: { course: string; node: string }
}
export interface RecEvent {
  type: RecEventType
  course: string
  node: string
  region?: string
  score: number
  why: string
  path?: string | null
  /** 已生成可读正文（点开有东西读；列表三态标识数据源）。 */
  hasContent?: boolean
  /** 内容诊断建议项（附着在学习事件上，或独立 diagnostic 事件）。 */
  diagnostics?: DiagnosticEntry[]
}
export interface RecommendDoc { date: string; events: RecEvent[] }

export type QuestionKind =
  | 'single_choice' | 'fill_in_blank' | 'true_false' | 'reflection'
  | 'multi_choice' | 'numeric' | 'ordering' | 'matching' | 'open_question'

/** 作答列表条目（不含答案；带刷卡调度状态）。 */
export interface QuestionItem {
  id: string
  kind: QuestionKind
  q: string
  no: number
  difficulty: number
  /** 绑定节：节清单 id（如 s2）优先，旧题为正文节标题或「通用」（null/缺省 = 通用收尾轮）。 */
  section?: string | null
  options?: string[]
  /** matching 专属：右列候选（服务端打乱顺序，防按序泄题）。 */
  pairOptions?: string[]
  /** 题目级 FSRS 下次到期日（未进入调度的题 = null）。 */
  due: string | null
  attempts: number
  lastCorrect: boolean | null
}

export interface BankEntry {
  course: string
  node: string
  qid: string
  no: number
  kind: QuestionKind
  q: string
  difficulty: number
  tags: string[]
  archived: boolean
  hasExplanation: boolean
  /** 题目级 FSRS 调度（未进调度 = null）。lastReview 供到期列 hover 展示。 */
  due: string | null
  lastReview?: string | null
  options?: string[]
}

export interface PropItem {
  id: number
  kind: 'gen' | 'edit'
  course: string
  status: 'pending' | 'applied' | 'rejected'
  summary: string
  artifact: string
  created: string
  decided?: string | null
  decision_note?: string
}

/** 节清单条目（frontmatter content.sections；逐节生成管线的进度事实源）。 */
export interface SectionManifestItem {
  id: string
  title: string
  /** 节类型前缀（概念/例题/演示/类比/练习/交互…）。 */
  type: string
  status: 'pending' | 'ready'
  version: number
}

/** 课程学习分节（lesson 响应；manifest 存在时带 id/type 供练习轮装配）。 */
export interface LessonSection { title: string; md: string; id?: string; type?: string }

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

export interface QueueItem { course: string; node: string; kind: string; reason: string; priority: string }
export interface DoctorDoc { problems: Array<{ level: string; message: string }> }

/** 作答判卷结果（question-answer / question-forget；含该题新到期日与节点聚合掌握度）。
 * scheduled=false 表示该题今日已推进过调度，本次仅记录练习统计。
 * pendingRating=true（复习刷卡流答对挂起）时 previews 给出三档自评的下次到期预览。
 * xp/xp_reason = XP 时间账本结算（对=+权重×难度、乱猜=-1、同日重复=0）。 */
export interface AnswerResult {
  correct?: boolean | null
  judge: string
  feedback?: string
  message?: string
  answer?: string
  explanation?: string
  kind?: QuestionKind
  due?: string | null
  mastery?: number
  scheduled?: boolean
  pendingRating?: boolean
  previews?: { hard: string; good: string; easy: string }
  xp?: number
  xp_reason?: 'correct' | 'wrong' | 'guess' | 'repeat'
}

/** 复习刷卡队列条目（跨课程到期题扁平队列；QuestionItem 的超集）。
 * d = 合用难度标量（静态题面难度 + FSRS difficulty，0-1；#57 会话内选档消费）。 */
export interface ReviewCard extends QuestionItem {
  course: string
  node: string
  r?: number
  d: number
}
export interface ReviewQueueDoc {
  date: string
  total: number
  cards: ReviewCard[]
  /** 单节点定向复习会话的起点难度带（节点 Mastery 先验；#57 A1）。 */
  band?: number
}

/** 每课程 ETA（剩余节点 × 每节点 XP ÷ 每日目标）。 */
export interface EtaItem { course: string; remaining: number; done: number; per_node: number; days: number }

/** XP 时间账本视图（GET /xp）。 */
export interface XpStatus {
  date: string
  today_xp: number
  goal: number
  streak: number
  eta: EtaItem[]
}

/** 记忆健康仪表盘（GET /memory，#61 A2）。 */
export interface HistogramBin { label: string; count: number }
export interface MemoryHealth {
  date: string
  forecast: { horizon_days: number; overdue: number; per_day: Array<{ d: string; count: number }> }
  state: {
    scheduled: number
    stability: HistogramBin[]
    difficulty: HistogramBin[]
    retrievability: HistogramBin[]
  }
  /** 真实保留率（True Retention）：只计 auto+self 的到期复习；real=0 时 rate 为 null（空态）。 */
  retention: { pass: number; fail: number; rate: number | null; real: number }
  calibration: Array<{ label: string; pred: number; actual: number | null; n: number }>
  forgetting: Array<{ label: string; n: number; rate: number | null }>
}
