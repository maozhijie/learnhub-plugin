/**
 * 引擎共享类型（TS 引擎的数据词汇，吸收自 Python learnhub 的 courses/graphstore/db）。
 *
 * 数据主权：课程笔记 frontmatter 是调度状态唯一事实源；data/*.yaml 是图结构唯一
 * 事实源；state/ 下 JSONL/JSON 只承载追加型流水（日志/作答）与人审产物（提案/快照）。
 */

/** 阶段机（courses.STAGES）。skipped = 用户已有基础跳过（调度视同已通过）。 */
export type Stage = 'unseen' | 'ready' | 'learning' | 'review' | 'mastered' | 'skipped'
export const STAGES: Stage[] = ['unseen', 'ready', 'learning', 'review', 'mastered', 'skipped']

/** 内容状态（courses.CONTENT_STATUS）。 */
export type ContentStatus = 'draft' | 'reviewed' | 'flagged'

/** 节清单条目（frontmatter content.sections；逐节生成管线的进度事实源）。
 * status=ready 表示该节正文已生成并入正文；version 为该节自身的重写次数。 */
export interface SectionManifest {
  id: string
  title: string
  type: string
  status: 'pending' | 'ready'
  version: number
  /** 大纲要点（一句话；contextPack 前置骨架注入用，可选）。 */
  points?: string
}

/** FSRS 状态块（frontmatter fsrs 字段；日期均为 YYYY-MM-DD 本地日）。 */
export interface FsrsBlock {
  stability: number
  difficulty: number
  due: string
  last_review: string
  reps: number
  lapses: number
}

/** 课程笔记 frontmatter（courses.default_frontmatter 同构）。 */
export interface Fm {
  node: string
  stage: Stage
  fsrs: FsrsBlock | null
  mastery: number
  /** 练习证据的 EMA（allo 判卷流：首证取分，之后 mastery*0.7+score*0.3）；无证据为 0。 */
  practice_ema?: number
  content: {
    version: number
    generated_at: string | null
    status: ContentStatus
    /** 节清单（可选；逐节生成管线的节点才有。旧节点缺省 = 标题切分回退）。 */
    sections?: SectionManifest[]
    /** 生成时的复杂度档位记录（低/中/高；可选项，供弹性评估——不驱动调度）。 */
    tier?: '低' | '中' | '高'
  }
  practice: { attempts: number; correct: number }
}

/** 成分技能边（graphstore enc）。 */
export interface EncEdge { node: string; w: number; note?: string }

/** Bloom 认知层级（节点可选字段；生成提示与未来调度消费）。 */
export const BLOOM_LEVELS = ['记忆', '理解', '应用', '分析', '评价', '创造'] as const
export type BloomLevel = (typeof BLOOM_LEVELS)[number]

/** 图节点（graphstore.Node）。est = 标称学习时长（分钟，XP 内容定价）；type = practice 交互实践节点；
 * bloom/difficulty = 认知维度（可选，渐进采纳；认知跨步检测 R13 消费）。 */
export interface GNode {
  name: string
  pre: string[]
  opt: boolean
  note: string
  enc: EncEdge[]
  est?: number
  type?: 'practice'
  bloom?: BloomLevel
  difficulty?: 1 | 2 | 3 | 4 | 5
}

/** 图块（graphstore.Block）。 */
export interface GBlock { name: string; nodes: GNode[] }

/** 图区（graphstore.Region，即 data/*.yaml 单文件）。 */
export interface GRegion { name: string; color: string; blocks: GBlock[] }

/** 课程注册表条目（registry.load 同构）。 */
export interface CourseEntry { id?: string; name: string; root: string; enabled?: boolean; tags?: string[] }

/** journal 流水条目（journal.append 同构）。 */
export interface JournalRec {
  ts: string
  course: string
  node: string
  rating: number | null
  kind: string
  elapsed_days: number
  session?: string | null
  duration_s?: number | null
  detail?: string
  /** XP 账本条目（kind='xp_bonus' 等非作答入账；作答 XP 走 practice 流水）。 */
  xp?: number
}

/** practice 作答流水条目（grading.record_attempt 同构；qid = 题库题目 id，可选）。 */
export interface PracticeRec {
  ts: string
  course: string
  node: string
  ex: number
  answer: string
  correct: boolean | null
  judge: string
  qid?: string
  feedback?: string
  /** 本次作答耗时（秒；前端渲染题目到提交）。乱猜判定与 automaticity 分析用。 */
  elapsed_s?: number
  /** 本次作答结算的 XP（同日重复作答为 0；乱猜为负）。 */
  xp?: number
}

/** 提案记录（db.proposals 行同构；产物 YAML 另存 state/proposals/）。 */
export interface ProposalRec {
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

/** 一门课程在引擎内的完整视图（一次加载，多处消费）。 */
export interface CourseView {
  course: CourseEntry
  graph: import('./graph').Graph
  state: Record<string, Fm>
  broken: import('./notes').BrokenNote[]
}
