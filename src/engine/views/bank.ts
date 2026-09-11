/**
 * 题库域视图类型（C-3 错误卡 / 题目管理 / B2 回流 / 一键清理 / 勘误冲正；#152 刀 6 自 views.ts 归档）。
 */
import type { AlloKind } from '../grading.ts'
import type { FsrsBlock } from '../types.ts'

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
  /** 归档原因（ADR-0032：skip/cleanup/too_easy/erratum/manual）；未归档为 undefined。 */
  archivedReason?: string
  hasExplanation: boolean
  /** 题目级 FSRS 调度（未进调度 = null）。lastReview 供到期列 hover 展示。 */
  due: string | null
  lastReview: string | null
  options?: string[]
  /** matching 专属：右列候选（去重后原序）。 */
  pairOptions?: string[]
}

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

/** 难度带校准再生成建议（低掌握半边；bank-advice.CalibrationAdvice 的视图镜像）。 */
export interface CalibrationAdvice {
  kind: 'difficulty_calibration'
  reason: string
  instruction: string
}

/** 预览分组：一个节点的候选集（确认前只读，零写入）。 */
export interface CleanupGroup {
  course: string
  node: string
  stage: string
  count: number
  reasons: Record<CleanupReason, number>
  /** 题面摘录样本（至多 3 条，供确认前辨认）。 */
  stems: string[]
}

export interface CleanupPreviewDoc {
  date: string
  /** 候选总数（= 各组 count 之和）。 */
  total: number
  groups: CleanupGroup[]
}

/** 清理规则标签（bank-cleanup.CleanupReason 的视图镜像）。 */
export type CleanupReason = 'skipped_node' | 'dormant_after_complete'

export interface DifficultyAdviceDoc {
  date: string
  nodes: DifficultyAdviceNode[]
  /** 被持久忽略的建议条数（清理忽略清单后过滤的就是这些；「恢复」入口消费）。 */
  dismissed: number
}

export interface DifficultyAdviceNode {
  course: string
  node: string
  calibration?: CalibrationAdvice
  too_easy?: TooEasyAdvice[]
}

/** 申诉结算结果（questionDisputeApply）。 */
export interface DisputeApplyResult {
  course: string
  node: string
  qid: string
  resolution: 'rekey' | 'void' | 'overridden'
  /** 落盘的冲正裁定（勘误流水 verdict，与复核三态同拼写）。 */
  verdict: 'key_error' | 'defective' | 'overridden'
  /** rekey 时 = 原作答按新键重判的结果；void/overridden = null（作答作废，无对错）。 */
  correct_now: boolean | null
  /** 该作答冲正后的 XP 净值（读侧按此替换原记录）。 */
  xp: number
  /** void 时 = 瑕疵题已随结算原子归档（重出走生成队列）。 */
  archived?: boolean
  /** 冲正后的节点掌握度（口径 B 派生；无 frontmatter 时缺省）。 */
  mastery?: number
}

/** 申诉复核结论（questionDisputeReview，只读不落盘）。 */
export interface DisputeReviewResult {
  course: string
  node: string
  qid: string
  /** 被复核的判错作答流水 ts（结算时回传校验）。 */
  target_ts: string
  verdict: 'key_error' | 'defective' | 'ok'
  /** 复核论证（先独立解题、再对账），Markdown。 */
  reasoning: string
  /** 当前答案键的展示形态。 */
  current_answer: string
  /** verdict=key_error 时的建议新答案（与题目 answer 字段同构）。 */
  suggested_answer?: string | number | boolean | string[]
  suggested_explanation?: string
}

/** 错误卡作答结算（errorCardAnswer，自动判分）：选对=3、选错=1；揭晓面随判分返回。 */
export interface ErrorAnswerResult {
  course: string
  node: string
  id: string
  correct: boolean
  rating: 3 | 1
  /** 正确做法项（= options 之一）。 */
  answer: string
  /** 学习者的错法项（= options 之一）。 */
  mine: string
  explanation: string
  due: string
  scheduled: true
  /** 选对的无绑定 XP（xp_error 行）；选错 0。 */
  xp: number
}

/** 归档/恢复一张错误卡（errorCardArchive；管理面，canonical 零写入）。 */
export interface ErrorArchiveResult {
  course: string
  node: string
  id: string
  archived: boolean
}

/** 错误对比卡条目（管理面清单/复习队列卡面共用形状）。队列卡面（reviewQueue 的
 * error 字段）只带 q/options——answer/mine/explanation 是作答后揭晓面，随
 * errorCardAnswer 判分返回；本条目（errorCardQueue 管理面）全量带出供人工抽查。 */
export interface ErrorCardItem {
  course: string
  node: string
  id: string
  q: string
  options: string[]
  answer: string
  /** 学习者的错法项（options 之一）。 */
  mine: string
  explanation: string
  source_q: string
  source_section: string | null
  due: string | null
  attempts: number
}

/** 生成结果（errorCardGenerate）：按节点分组的新卡 id。 */
export interface ErrorGenerateResult {
  course: string
  generated: Array<{ node: string; ids: string[]; count: number }>
  /** 因原题缺失/归档被跳过的候选（node/qid + 原因）。 */
  skipped?: string[]
}

/** 挖矿预览（errorCardMine）。 */
export interface ErrorMineDoc {
  course: string
  candidates: ErrorPatternItem[]
}

/** 高频错误模式候选（errorCardMine，只读挖矿预览——「错误模式人工抽查合理」的验收面）。 */
export interface ErrorPatternItem {
  course: string
  node: string
  qid: string
  /** 实质答错次数（忘记申报不计）。 */
  lapses: number
  /** 学习者的错答样本（去重，最近在前）。 */
  wrongs: string[]
  last_wrong: string
}

/** 错误卡全量清单（errorCardQueue）：到期在前、新卡随后；管理面/agent 清点用。 */
export interface ErrorQueueDoc {
  date: string
  total: number
  due_count: number
  cards: ErrorCardItem[]
}

/** 单题全量读取（questionGet）：修订/审题用——questions/reviewQueue 不带答案（防泄题）。 */
export interface QuestionGetDoc {
  course: string
  node: string
  question: BankQuestionView
}

/** 题型（allo 题库 schema；grading.AlloKind 的视图名）。 */
export type QuestionKind = AlloKind

export interface QuestionsAllDoc { total: number; questions: BankEntry[] }

/** 「过于简单」归档标注建议（bank-advice.TooEasyAdvice 的视图镜像；归档由管理面确认）。
 * 调度证据口径：≥门槛次数推进零遗忘 + 间隔拉长到门槛天数；stem 供面板条目直接认题。 */
export interface TooEasyAdvice {
  kind: 'too_easy'
  qid: string
  stem: string
  reps: number
  interval_days: number
  reason: string
}
