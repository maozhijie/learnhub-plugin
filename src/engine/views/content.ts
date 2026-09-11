/**
 * content 域视图类型（#152 刀归档；叶子文件，只引类型层）。
 */
import type { ContentStatus, SectionManifest, Stage } from '../types.ts'
import type { QuestionKind } from './bank.ts'
import type { LearnerCardItem } from './learner.ts'

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
  /** 最近一次作答对错（stats.last_correct；旧数据无此字段 = null）。 */
  lastCorrect: boolean | null
  /** 本学习日已真实推进（一卡一学习日口径）：练习会话据此渲染直通卡（ADR-0027）。 */
  advancedToday?: boolean
  /** 直通卡披露：仅 questions 通道对本学习日已推进的题带出（与作答响应同一披露
   * 边界）；复习队列是主动回忆面，同视图产出不带答案。 */
  answer?: string
  explanation?: string
}

/** 节点题库题目列表（questions；刷卡视图，不含答案）。 */
export interface QuestionsDoc {
  course: string
  node: string
  /** 节点聚合掌握度（口径 B；笔记源伪课程无节点，缺省——ADR-0010 v1 不套掌握度模型）。 */
  mastery?: number
  questions: QuestionItem[]
}

/** 复习刷卡队列条目（跨课程到期题扁平队列；QuestionItem 的超集）。
 * r = 预测回忆率 R（各课程自己的调度器参数下现算）；d = 合用难度标量（#57 会话内选档消费）。 */
export interface ReviewCard extends QuestionItem {
  course: string
  node: string
  r: number
  d: number
  /** JOL 抽查命中（#66 E4）：翻面前弹一档三点预测，可忽略。 */
  jol?: boolean
  /** 笔记源卡（C1 #59）：source='note'，title=笔记标题；course 恒为「笔记源」伪课程。
   * source_path/source_abs = 来源笔记的 vault 相对/绝对路径（V-4 #108）——面板显示
   * 来源笔记并经 obsidian://open?path= 跳转（绝对路径由 Obsidian 自解析所属 vault）。 */
  source?: 'note' | 'learner' | 'error'
  title?: string
  source_path?: string
  source_abs?: string
  /** 我的卡（E1，ADR-0021 汇入）：source='learner' 时携带——卡面渲染与
   * learner-rate/learner-forget 结算走此通道；调度/入账语义见 ADR-0021。 */
  learner?: LearnerCardItem
  /** 错误对比卡（C-3 #82 汇入）：source='error' 时携带（id 为 err: 前缀的队列键，
   * error.id 才是结算用的卡 id）——三选一卡面渲染与 errorCardAnswer 判分走此通道；
   * 卡面只带题面与选项，答案/错法/解析随判分揭晓。 */
  error?: ErrorCardFace
}

/** 错误对比卡的复习队列卡面（C-3 #82）：只带题面与选项的泄露纪律子集。 */
export interface ErrorCardFace {
  course: string
  node: string
  id: string
  q: string
  options: string[]
  source_q: string
  source_section: string | null
  due: string | null
  attempts: number
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
  /** Self-Calibration 过信轻提示（ADR-0022 #104）：源内「会」档系统性过信且提示开时
   * 携带——呈现层文案（UI 在 JOL 预测出口非阻断展示），可全局关（calibration.hints）；
   * 关闭或未检出时不带。 */
  calibration_hint?: string
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
  /** 判错差异摘要（规则题判错时携带）：点名「漏选了 A / 多选了 C / 从第 2 项起顺序不对」，
   * 让判错反馈能对上学习者的作答（ADR-0031）。 */
  diff?: string
  /** probation 在途行使闸（#146）：实验中的插入节点——作答只记流不回流练习证据。 */
  evidence_gated?: true
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
  /** probation 在途行使闸（#146）：实验中的插入节点——忘记只记流不回流练习证据。 */
  evidence_gated?: true
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
