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
 * `import type` 引用，strip 模式下整句擦除；因此这里用无扩展名导入即可（宿主
 * node 运行时不会解析它们；ui 的 tsc/vite 按 bundler 语义解析）。依赖只取
 * node 内建无关的模块，保证 ui typecheck 能把本模块拉进程序。
 */
import type {
  ContentStatus, EncEdge, FsrsBlock, SectionManifest, Stage,
} from './types'
import type { AlloKind } from './grading'
import type { JolBin } from './jol'

/** 提案记录（store/proposals 持久化条目）与节清单（frontmatter content.sections）
 * 的转发导出：graphReject/graphProposals 的返回与 LessonDoc.manifest 引用，
 * ui 侧经此统一 re-export。 */
export type { ProposalRec, SectionManifest } from './types'

// ---- 共享词汇 ----

/** 题型（allo 题库 schema；grading.AlloKind 的视图名）。 */
export type QuestionKind = AlloKind

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

/** 认知跨步候选（quality.JumpCandidate 镜像）。 */
export interface GraphJumpCandidate {
  pre: string
  node: string
  /** 难度差；任一端未标注时为 null（此时只剩 depth 口径）。 */
  difficultyGap: number | null
  depthSpan: number
  reasons: Array<'difficulty' | 'depth'>
}

/** 规模底线对照（quality.ScaleReport 镜像；ADR-0002：绝对规模走独立门槛，不进健康分）。 */
export interface GraphScaleReport {
  nodes: number
  target: { min: number; max: number } | null
  /** null = 未宣布目标，不作判定；超上限不拦（宁愿节点过多不要过少）。 */
  ok: boolean | null
  shortfall: number
}

/** 节点 schema 全量条目（pre/enc/est/bloom/difficulty/note…；elementsOnly 模式不含）。 */
export interface GraphNodeSchema {
  pre: string[]
  enc: EncEdge[]
  opt: boolean
  est?: number
  type?: string
  bloom?: string
  difficulty?: number
  note?: string
}

/** 图分析全量视图（analysis.GraphAnalysis 的视图镜像；React Flow elements 格式）。 */
export interface GraphDoc {
  stats: {
    nodes: number
    edges: number
    enc_edges: number
    roots: number
    leaves: number
    max_depth: number
    components: number
    has_cycle: boolean
  }
  unreachable: string[]
  bottlenecks: Array<{ node: string; successors: number; unlocks: number }>
  lapse_hotspots: Array<{ node: string; lapses: number }>
  /** 图谱健康分（0-100；结束条件锚点）。est_note：est 分布压缩的 advisor 提示（null = 无）。 */
  health: { score: number; breakdown: Record<string, number>; est_note: string | null }
  /** 分批构建建议（图谱 designer 逐批展开时规划下一批的输入，全部可行动）。 */
  suggestions: {
    /** 节点数 <5 的块（浅块优先）——往哪扩。 */
    expand_blocks: Array<{ region: string; block: string; nodes: number }>
    /** 空降节点（region 序靠后且 pre 为空）——先补谁。 */
    missing_pre: string[]
    /** 平均 pre 数 <1.5 的块——哪里连接过少。 */
    unconverged: Array<{ region: string; block: string; avg_pre: number }>
    /** 认知跨步候选——每条必须 verdict：认可或修。 */
    jump_candidates: GraphJumpCandidate[]
    /** 跨步候选总数（截断前）——结束条件要求清零。 */
    jump_total: number
    /** 节点数 <3 的块（合并比展开更划算时）。 */
    merge_blocks: Array<{ region: string; block: string; nodes: number }>
  }
  scale: GraphScaleReport
  nodes: Array<{ data: {
    id: string
    region: string
    block: string
    depth: number
    stage: Stage
    opt: boolean
    /** 掌握度 0-1（口径 B 派生值；底色深浅按它插值）。 */
    mastery: number
    /** 已生成可读正文（列表/图三态标识：点开有东西读）。 */
    hasContent: boolean
    /** practice = 交互实践节点（「练」角标）。 */
    type?: string
  } }>
  edges: Array<{ data: { id: string; source: string; target: string; kind: string; w?: number } }>
  schema: Record<string, GraphNodeSchema>
}

/** elementsOnly 模式（learnhub_graph_analyze elementsOnly=true）：只回渲染元素。 */
export interface GraphElementsDoc {
  nodes: GraphDoc['nodes']
  edges: GraphDoc['edges']
}

// ---- 图探索（graphNode / graphBrowse / graphPath）----

/** 单节点图详情（graphNode）：schema 字段值 + 直接邻域 + 前置传递闭包。 */
export interface GraphNodeDoc {
  course: string
  node: string
  region: string
  block: string
  depth: number
  opt: boolean
  pre: string[]
  succ: string[]
  enc: EncEdge[]
  /** 标称学习时长（分钟；未标注缺省）。 */
  est?: number
  type?: string
  bloom?: string
  difficulty?: number
  note?: string
  stage: Stage
  mastery: number
  /** 内容版本/状态（无 frontmatter content 块时缺省）。 */
  content?: { version: number; status: ContentStatus }
  /** 前置传递闭包（不含自身；按深度降序 = 先学在前）。 */
  prereq_closure: string[]
}

/** 区/块浏览（graphBrowse）：按区名/块名过滤的节点清单。 */
export interface GraphBrowseNode {
  node: string
  depth: number
  stage: Stage
  est?: number
  difficulty?: number
  type?: string
  content_status: ContentStatus
}

export interface GraphBrowseBlock { name: string; nodes: GraphBrowseNode[] }
export interface GraphBrowseRegion { name: string; blocks: GraphBrowseBlock[] }

export interface GraphBrowseDoc {
  course: string
  total: number
  regions: GraphBrowseRegion[]
  /** Broken 状态显式暴露，不伪装成 unseen/draft。 */
  broken_notes: Array<{ path: string; node?: string; reason: string }>
}

/** 前置路径查询（graphPath）：from 不在 to 的前置闭包内。 */
export interface GraphPathUnrelatedResult {
  course: string
  from: string
  to: string
  related: false
  message: string
}

/** from 在 to 的前置闭包内：链路与跨度。 */
export interface GraphPathRelatedResult {
  course: string
  from: string
  to: string
  related: true
  /** 直接前置（一步可达）。 */
  direct: boolean
  /** 闭包大小（不含 to 自身）。 */
  closure_size: number
  /** from → to 的前置链（先学在前）。 */
  chain: string[]
  depth_span: number
}

export type GraphPathResult = GraphPathUnrelatedResult | GraphPathRelatedResult

// ---- 提案门禁（graphPropose / graphApply / graphEncBackfill；gengraph.GraphProposals）----

/** 生成提案受理（proposeGen）。 */
export interface GraphGenProposalResult {
  id: number
  kind: 'gen'
  course: string
  mode: 'new' | 'append'
  regions: number
  nodes: number
}

/** 变更提案受理（proposeEdit）。 */
export interface GraphEditProposalResult {
  id: number
  kind: 'edit'
  course: string
  ops: number
}

export type GraphProposeResult = GraphGenProposalResult | GraphEditProposalResult

/** apply 门禁 findings：audit warns 摘要 + 健康分不足提示（引擎不设阈值）。 */
export interface GraphApplyGenResult {
  course: string
  /** 本次写入的区名。 */
  regions: string[]
  snapshot: number
  nodes: number
  created_blocks: string[]
  findings: string[]
}

export interface GraphApplyEditResult {
  course: string
  ops: number
  snapshot: number
  created_blocks: string[]
  /** rename 联动：旧名 → 新名。 */
  renames: Record<string, string>
  deleted: string[]
  findings: string[]
}

export type GraphApplyResult = GraphApplyGenResult | GraphApplyEditResult

/** enc 存量回填（ADR-0008 / #53）：没有需要回填的节点（候选已全落 enc，可重入）。 */
export interface GraphEncBackfillNoneResult {
  course: string
  scanned: number
  ops: 0
  proposal: null
  message: string
}

/** enc 存量回填：已生成 pending edit 提案（过审后 learnhub_graph_apply(kind=edit) 生效）。 */
export interface GraphEncBackfillProposedResult {
  course: string
  scanned: number
  ops: number
  proposal: GraphProposeResult
  message: string
}

export type GraphEncBackfillResult = GraphEncBackfillNoneResult | GraphEncBackfillProposedResult

// ---- 内容管线（queueItemsAll / lesson / coursesTree）----

/** 生成队列条目（queueItemsAll；content.queueItems + 课程名）。 */
export interface QueueItem { course: string; node: string; kind: string; reason: string; priority: string }

/** 课程学习分节（lesson 响应；manifest 存在时补 id/type 供练习轮装配）。 */
export interface LessonSection { title: string; md: string; id?: string; type?: string }

/** 单节点课程学习包（lesson）：分节正文 + 节清单 + 前置 + 推荐下一步。 */
export interface LessonDoc {
  course: string
  node: string
  region: string
  stage: Stage
  mastery: number
  sections: LessonSection[]
  /** 节清单（frontmatter content.sections；旧节点无清单 = null，前端回退标题匹配）。 */
  manifest: SectionManifest[] | null
  prereqs: string[]
  suggest_next: string[]
}

// ---- 课程工作区树（coursesTree；course → region → block → node）----

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
export interface TreeCourse { name: string; id?: string; regions: TreeRegion[] }
export interface TreeDoc { courses: TreeCourse[] }

// ---- 题目作答视图（questions / reviewQueue 共用；questionView 产出）----

export interface QuestionItem {
  id: string
  kind: QuestionKind
  q: string
  no: number
  difficulty: number
  /** 绑定节：节清单 id（如 s2）优先，旧题为正文节标题（null = 通用收尾轮）。 */
  section: string | null
  options?: string[]
  /** matching 专属：右列候选（服务端打乱顺序，防按序泄题）。 */
  pairOptions?: string[]
  hasExplanation: boolean
  /** 题目级 FSRS 下次到期日（未进入调度的题 = null）。 */
  due: string | null
  attempts: number
  lastCorrect: boolean | null
}

/** 节点题库题目列表（questions；刷卡视图，不含答案）。 */
export interface QuestionsDoc {
  course: string
  node: string
  /** 节点聚合掌握度（口径 B；笔记源伪课程无节点，缺省——ADR-0010 v1 不套掌握度模型）。 */
  mastery?: number
  questions: QuestionItem[]
}

// ---- 复习刷卡（reviewQueue / questionAnswer / questionRate / questionForget）----

/** 复习刷卡队列条目（跨课程到期题扁平队列；QuestionItem 的超集）。
 * r = 预测回忆率 R（各课程自己的调度器参数下现算）；d = 合用难度标量（#57 会话内选档消费）。 */
export interface ReviewCard extends QuestionItem {
  course: string
  node: string
  r: number
  d: number
  /** JOL 抽查命中（#66 E4）：翻面前弹一档三点预测，可忽略。 */
  jol?: boolean
  /** 笔记源卡（C1 #59）：source='note'，title=笔记标题；course 恒为「笔记源」伪课程。 */
  source?: 'note' | 'learner'
  title?: string
  /** 我的卡（E1，ADR-0021 汇入）：source='learner' 时携带——卡面渲染与
   * learner-rate/learner-forget 结算走此通道；调度/入账语义见 ADR-0021。 */
  learner?: LearnerCardItem
}

/** 复习刷卡队列（reviewQueue）：全局跨课程队列（可带笔记源状态）；node 过滤时为
 * 单节点会话队列（带起点难度带 band，#57/#65）。 */
export interface ReviewQueueDoc {
  date: string
  total: number
  cards: ReviewCard[]
  /** 单节点定向复习会话的起点难度带（节点 Mastery 先验 + 显式带偏移）；仅 node 过滤时存在。 */
  band?: number
  /** N-of-1 实验当日生效臂（#110 ADR-0023，批次交替）：队列呈现正受实验影响时带出
   * （会组成实验的混排/分组臂、难度带默认实验的当日带），供呈现层如实标注。 */
  exp?: { id: number; arm: string }
  /** 笔记源漂移提示（C1 #59）：可重出/归档旧题；仅全局队列带出。 */
  note_drifted?: Array<{ id: string; path: string; hint: string }>
  /** 笔记源挂起原因（Missing / 镜像 Broken）；挂起卡的源不出卡。 */
  note_suspended?: Array<{ id: string; path: string; reason: string }>
}

// ---- D 区个人实验室（#85/#110/#111/#112；nof1.ts 为零依赖纯函数模块，视图层直接复用其类型）----

export type { Nof1Template, ExperimentDef, Nof1Analysis, Nof1ArmStats } from './nof1.ts'
export type { SandboxDoc } from './sandbox.ts'

/** 实验提案受理结果（experimentPropose：提案-确认制第一步）。 */
export interface ExperimentProposeResult {
  proposal: number
  template: string
  title: string
  /** 合格卡池张数（已调度未归档题卡，范围过滤）。 */
  pool: number
  scope_course: string | null
}

/** 实验开跑结果（experimentApply = 提案确认）。 */
export interface ExperimentStartResult {
  id: number
  title: string
  /** 开跑当日（学习日）的生效臂。 */
  arm_today: string
}

/** 作答结算（questionAnswer）。课程题库通道与笔记源卡通道共用：
 * explanation/mastery/xp_reason 仅课程题库通道返回（笔记源无节点证据与 settle）。 */
export interface AnswerResult {
  correct: boolean
  /** 判卷分（0-100 整数）。 */
  score: number
  feedback: string
  /** 错题公布答案（allo answer_review 语义的题型化展示）。 */
  answer: string
  kind: QuestionKind
  /** 该题新到期日（挂起/同日重复 = 原值）。 */
  due: string | null
  /** 本次作答是否推进了该题 FSRS 调度（每题每天至多一次；自评挂起视为未推进）。 */
  scheduled: boolean
  /** 复习刷卡流答对挂起（deferSchedule）：previews 给出三档自评的下次到期预览。 */
  pendingRating: boolean
  previews?: { hard: string; good: string; easy: string }
  /** XP 时间账本结算（笔记源卡恒 0——复习自评语义不含 XP）。 */
  xp: number
  explanation?: string
  /** 节点聚合掌握度（口径 B；笔记源无节点，缺省）。 */
  mastery?: number
  xp_reason?: 'correct' | 'wrong' | 'guess' | 'repeat'
}

/** 自评结算（questionRate）：复习刷卡流答对后的 Hard/Good/Easy 推卡。 */
export interface QuestionRateResult {
  course: string
  node: string
  qid: string
  rating: number
  /** 推卡后的新到期日。 */
  due: string
  scheduled: true
  /** 节点聚合掌握度（课程题库通道；笔记源无节点，缺省）。 */
  mastery?: number
}

/** 忘记申报（questionForget）：不作答直接翻面，调度与统计按答错记，0 XP。 */
export interface QuestionForgetResult {
  correct: false
  judge: 'forget'
  feedback: string
  answer: string
  explanation: string
  kind: QuestionKind
  due: string
  scheduled: true
  /** 节点聚合掌握度（课程题库通道；笔记源无节点，缺省）。 */
  mastery?: number
  xp: 0
}

// ---- Anki 通道（C2 #63 / ADR-0011；ankiStatus）----

/** Anki 通道状态：镜象规模/最近推送与导入/当前到期分布 + AnkiConnect 可达性。 */
export interface AnkiStatusDoc {
  date: string
  mirror: { entries: number; last_push: string | null; last_import: string | null; decks: string[] }
  due: { total: number; by_deck: Array<{ deck: string; count: number }> }
  /** AnkiConnect 可达性（仅传入 transport 时探测）。 */
  anki?: { connected: boolean; error?: string }
}

// ---- XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注；xpStatus）----

/** 每课程 ETA（剩余节点 × 每节点 XP ÷ 每日目标）。 */
export interface EtaItem { course: string; remaining: number; done: number; per_node: number; days: number }

export interface XpStatus {
  /** 当前学习日（ADR-0020）。 */
  date: string
  /** 生效日界 'HH:mm'（ADR-0020 配置三件套静默回落时的可见性补偿）。 */
  day_cutoff: string
  today_xp: number
  goal: number
  streak: number
  eta: EtaItem[]
}

// ---- 记忆健康仪表盘（#61 A2 / ADR-0012；memoryHealth）----

export interface HistogramBin { label: string; count: number }

export interface MemoryHealthDoc {
  date: string
  /** 每日负载预报（Anki Forecast 语义）。 */
  forecast: { horizon_days: number; overdue: number; per_day: Array<{ d: string; count: number }> }
  /** 记忆状态分布（Stability/Difficulty/当前可回忆度直方图）。 */
  state: { scheduled: number; stability: HistogramBin[]; difficulty: HistogramBin[]; retrievability: HistogramBin[] }
  /** 真实保留率（True Retention）：只计 auto+self 的到期复习；real=0 时 rate 为 null（空态）。 */
  retention: { pass: number; fail: number; rate: number | null; real: number }
  /** FSRS 自预测 vs 实际对照（按 r_pred 分箱；空桶 actual=null）。 */
  calibration: Array<{ label: string; pred: number; actual: number | null; n: number }>
  /** 按时点遗忘曲线（按间隔分桶的保留率）。 */
  forgetting: Array<{ label: string; n: number; rate: number | null }>
  /** 预测-校准（#66 E4）：学习者 JOL vs 实际——配对数足门槛才有值，null = 不显示。 */
  jol: { pairs: number; bins: JolBin[] } | null
}

// ---- E1「我的卡」（#45 / #68 / #70；learnerQueue / learnerCardRate / learnerCardForget）----

/** 「我的卡」卡面（E1 #70）：提示重述 / 挖空重述 / 自注讲解。
 * learner-cards.LearnerCardKind 的视图镜像（learner-cards 依赖 node:fs，ui 侧无法拉入）。 */
export type LearnerCardKind = 'recall_cue' | 'cloze_rewrite' | 'self_explain'

/** 「我的卡」条目（E1）：prompt = 正面提示，content = 学习者自己的表述（翻面对照）。
 * 复习呈现已并入 Review Queue（ADR-0021）；本条目同时是 learner 字段与
 * learnerQueue（管理面/agent 清点）的视图形状。 */
export interface LearnerCardItem {
  course: string
  node: string
  id: string
  kind: LearnerCardKind
  prompt: string
  content: string
  source_section: string | null
  due: string | null
  attempts: number
}

/** 「我的卡」全量清单（learnerQueue）：到期在前、新卡随后；管理面/agent 清点用
 * （复习入口已并入 Review Queue，ADR-0021）。 */
export interface LearnerQueueDoc {
  date: string
  total: number
  due_count: number
  cards: LearnerCardItem[]
}

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

/** 题库题全量（questionGet 单题读取，含 answer/explanation）。
 * question-bank.BankQuestion 的视图镜像（question-bank 依赖 node:fs，ui 侧无法拉入）。 */
export interface BankQuestionView {
  id: string
  kind: QuestionKind
  q: string
  answer: string | boolean | string[]
  options?: string[]
  explanation?: string
  difficulty?: number
  uses?: string[]
  tags?: string[]
  /** numeric 题的数值容差（缺省 0）。 */
  tol?: number
  /** 来源正文节（节清单 id 或节标题）。 */
  section?: string
  archived?: boolean
  /** 题目级 FSRS 调度（每题一张卡）。 */
  fsrs?: FsrsBlock
  stats?: { attempts: number; correct: number; last?: string; pending_rating?: boolean }
}

/** 单题全量读取（questionGet）：修订/审题用——questions/reviewQueue 不带答案（防泄题）。 */
export interface QuestionGetDoc {
  course: string
  node: string
  question: BankQuestionView
}

/** 题库条目（questionsAll 的 questions 列表项；题目管理列表，不含答案）。 */
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
  lastReview: string | null
  options?: string[]
  /** matching 专属：右列候选（去重后原序）。 */
  pairOptions?: string[]
}

export interface QuestionsAllDoc { total: number; questions: BankEntry[] }

// ---- B2 难度感知回流（决议 #41 / #58；difficultyAdvice）----

/** 难度带校准再生成建议（低掌握半边；bank-advice.CalibrationAdvice 的视图镜像）。 */
export interface CalibrationAdvice {
  kind: 'difficulty_calibration'
  reason: string
  instruction: string
}

/** 「过于简单」归档标注建议（bank-advice.TooEasyAdvice 的视图镜像；归档由管理面确认）。 */
export interface TooEasyAdvice {
  kind: 'too_easy'
  qid: string
  attempts: number
  reason: string
}

export interface DifficultyAdviceNode {
  course: string
  node: string
  calibration?: CalibrationAdvice
  too_easy?: TooEasyAdvice[]
}

export interface DifficultyAdviceDoc { date: string; nodes: DifficultyAdviceNode[] }

// ---- C1 笔记复习源（#59 / ADR-0010；noteSourceList / noteSourceRegister）----

/** 笔记源状态（note-source.NoteSourceStatus 的视图镜像）。 */
export type NoteSourceStatus = 'ok' | 'missing' | 'drifted' | 'inconsistent'

/** 笔记源清单条目（C1 #59）：注册身份 × 指纹状态 × 卡池概况。 */
export interface NoteSourceItem {
  id: string
  path: string
  title: string
  enabled: boolean
  created: string
  /** ok 正常 / drifted 漂移（可重出或归档旧题）/ missing 缺失（重注册或解除）/ inconsistent 镜象不一致。 */
  status: NoteSourceStatus
  cards: number
  due: number
  hint?: string
  /** 题库镜像 Broken 时为 true（hint 带原因）。 */
  broken?: true
}

/** 笔记源清单（noteSourceList）。excludes = 用户排除清单（V-1 #86，只管未来注册）。 */
export interface NoteSourceDoc {
  date: string
  total: number
  excludes: string[]
  sources: NoteSourceItem[]
}

/** 笔记源注册（noteSourceRegister）：单篇 .md 或文件夹批量登记；随响应带回最新清单。
 * skipped = 被跳过条目数（排除清单命中 + 学习中心内部文件）；skipped_paths 仅在有
 * 跳过时带回（vault 相对，混合两类）。 */
export interface NoteSourceRegisterResult {
  date: string
  registered: number
  updated: number
  skipped: number
  sources: NoteSourceItem[]
  skipped_paths?: string[]
}

// ---- 技能条目 lane（U 区 #89 / ADR-0018：skillList，GET /api/skills、learnhub_skill_list）----

/** 技能条目 lane 清单项：生效到期已折算维持节拍帽（帽先到 = maintenance 维持复活）。 */
export interface SkillLaneItem {
  id: string
  name: string
  status: 'active' | 'archived'
  /** 维持节拍上限（天；null = 关）。 */
  maintenance_days: number | null
  /** lane 生效到期（从未执行 = null，无到期语义）。 */
  due: string | null
  /** 到期种类（已到期才有意义）：acquisition 习得 / maintenance 维持（迷你重做+回放）。 */
  due_kind: 'acquisition' | 'maintenance' | null
  attempts: number
}

/** 技能清单（skillList）。 */
export interface SkillsListDoc {
  date: string
  skills: SkillLaneItem[]
  broken: Array<{ id: string; path: string; reason: string }>
}

// ---- 习惯（U 区 #90 / ADR-0017：habitList / habitShow，GET /api/habits、/api/habit）----

/** 习惯清单项：派生面（streak/曲线摘要）只展示给学习者，永不进 canonical。 */
export interface HabitListItem {
  id: string
  name: string
  status: 'active' | 'archived'
  intention: { cue: string; action: string }
  total_repeats: number
  /** 宽容 streak（漏天无损；与 XP streak 各算各的）。 */
  streak: number
  latest_rating: number | null
}

/** 习惯清单（habitList）。 */
export interface HabitsListDoc {
  date: string
  habits: HabitListItem[]
  broken: Array<{ id: string; path: string; reason: string }>
}

/** 自动化曲线点：x = 该次自报时的累计重复次数，y = 自动化自评 1-5（中断不衰减）。 */
export interface HabitCurvePoint { repeats: number; rating: number }

/** 习惯详情（habitShow）。 */
export interface HabitShowDoc {
  habit: string
  name: string
  status: 'active' | 'archived'
  intention: { cue: string; action: string }
  created: string
  updated: string
  total_repeats: number
  streak: number
  curve: HabitCurvePoint[]
  recent: Array<{ ts: string; habit: string; day: string; auto_rating?: number; note?: string }>
}
