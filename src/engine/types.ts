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
  /** 已退役的旧掌握度键（ADR-0007）：只作存量兼容保留，不再写入；
   * 掌握度唯一 canonical = srs.masteryOfFm 纯派生（口径 B），不落盘。 */
  mastery?: number
  /** 练习证据的 EMA（allo 判卷流：首证取分，之后旧值×0.7 + 本次分×0.3）；无证据为 0。
   * 是口径 B Mastery 的练习项（约 30% 权重），本身不是 Mastery。 */
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

/** 概念档位（schema v2 字段契约 #127：teaches/assumes 的档值，中文锁定）。
 * 刻意不叫 Mastery*——词条里 Mastery 是 0–1 掌握度量（读侧派生、不落盘），这里是
 * 教学深度档（知道/会用/能教），档位不进门禁不进调度（既裁），只作概念级生成注入
 * 与教练登记表档位视野的感知面。 */
export const CONCEPT_TIERS = ['知道', '会用', '能教'] as const
export type ConceptTier = (typeof CONCEPT_TIERS)[number]

/** 误解条目（节点 misconceptions 列表项）：错误模型文字承载典型错答与坑位用途；
 * 判据签名不设机器字段（#124 裁决）。同一概念全课程跨节点封顶 2–3 条（受理门计数）。 */
export interface Misconception { concept: string; model: string }

/** 图节点（graphstore.Node）。est = 标称学习时长（分钟，XP 内容定价）；type = practice 交互实践节点；
 * bloom/difficulty = 认知维度（可选，渐进采纳；认知跨步检测 R13 消费）；
 * teaches/assumes/misconceptions = 概念字段组（schema v2 #127，出生层随内容生长批写入，
 * 概念名 = 登记表在册名字；缺席全合法）。 */
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
  /** 本节点教到的概念 → 教学档位（在场 1–8：1–2 条 WARN 窄节点提示、>8 ERROR）。 */
  teaches?: Record<string, ConceptTier>
  /** 本节点假设学习者已具备的概念 → 所需档位（缺席合法；在场 1–2 WARN、>10 ERROR）。 */
  assumes?: Record<string, ConceptTier>
  /** 本节点的误解先验（缺席合法；每概念全课程封顶 3 条，越界 ERROR）。 */
  misconceptions?: Misconception[]
}

/** 图块（graphstore.Block）。 */
export interface GBlock { name: string; nodes: GNode[] }

/** 图区（graphstore.Region，即 data/*.yaml 单文件）。 */
export interface GRegion { name: string; color: string; blocks: GBlock[] }

/** 课程注册表条目（registry.load 同构）。 */
export interface CourseEntry { id?: string; name: string; root: string; enabled?: boolean; tags?: string[] }

/** 笔记源注册条目（课程注册表 note_sources 域；C1 #59 / ADR-0010）。
 * path 为 vault 相对路径；引擎对它只读，派生物落 学习中心/笔记源/ 镜像区。 */
export interface NoteSourceEntry { id: string; path: string; enabled?: boolean; created: string }

/** E 档案条目（ADR-0009 Learner Output 判词存档；#68 E2 讲解反馈，#70 E1 自注反馈复用）。
 * 判词只入档案：不产生 XP、不写掌握度/题库/FSRS canonical。 */
export interface EArchiveRec {
  ts: string
  course: string
  node: string
  kind: 'explain_back' | 'self_note'
  verdict: '对' | '部分对' | '错'
  /** 偏离定位标签（含糊/跳跃/说错的子集）。 */
  tags: string[]
  /** 「可怎么补」一句。 */
  advice?: string
  /** 学习者产出摘录（讲稿/自注，截断存储）。 */
  excerpt?: string
}

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
  /** 作答前的一档三点预测（E4 #66 JOL，Learner Output 元标注）：题面出示后、
   * 翻面前抽查命中时由学习者作答。老记录缺省（读侧视同 null，不报旧流水）；
   * 只作校准展示原料，不喂 canonical。 */
  predicted?: '会' | '不会' | '没把握' | null
}

/** 逐次复习日志条目（state/review-log.jsonl，ADR-0012）：调度事件流——只在真实
 * 推进 FSRS 卡时落一条，与 practice 流水（作答证据）和 journal（XP/内容账目）
 * 刻意分开；消费方 = 记忆健康仪表盘与 FSRS 参数优化器（#61/#62）。 */
export interface ReviewRec {
  ts: string
  course: string
  node: string
  qid: string
  /** 本次推进的 FSRS 评分（1=Again 2=Hard 3=Good 4=Easy）。 */
  rating: 1 | 2 | 3 | 4
  /** auto = 练习流自动映射 / 忘记申报；self = 复习流答对后自评；synthetic = 完成学习时的调度初始化（非真实作答，诚实度统计须过滤）；
   * execution = 执行事件（技能条目 lane，ADR-0018：与题目 FSRS 并行、不复用题目卡、不进复习队列；
   * 保留率/优化器等题目侧统计按 auto/self 过滤天然排除，优化器 ≥400 条混训门见 optimize.ts）。 */
  rating_source: 'auto' | 'self' | 'synthetic' | 'execution'
  /** 执行事件种类（仅 rating_source='execution' 时落，ADR-0018 裁决 6 #89 验收项）：
   * acquisition 习得（FSRS due 驱动）/ maintenance 维持（维持节拍帽到期的迷你重做+回放）。 */
  event_kind?: 'acquisition' | 'maintenance'
  /** 执行事件的评级来源枚举（仅 rating_source='execution' 时落，ADR-0018 入口契约：
   * 事件须携带来源；auto=可观测证据确定性映射 / self=学习者自评档 / ai=AI 评级）。 */
  exec_source?: 'auto' | 'self' | 'ai'
  /** 距该卡上次复习的天数（首学 0；synthetic 恒 0）。 */
  elapsed_days: number
  /** 复习前快照。synthetic 无「复习前」状态 → 三字段全 null；首学无旧卡 →
   * 前 2 字段 null、r_pred 取 FSRS 对新卡的自预测 1.0（仅 FSRS 自预测，学习者 JOL 属 E4）。
   * 三字段永远落盘（无则写 null，不省略字段——消费方无需区分「缺省」与「无前态」）。 */
  stability_before: number | null
  difficulty_before: number | null
  r_pred: number | null
  /** 实验臂标注（D-1 #110 / ADR-0023）：本次推进发生时正在运行的 N-of-1 实验与
   * 所属臂（batch = 当日臂；card = 卡级分臂）。只是归因留痕——不改变推进本身；
   * 优化器默认混训不特判。无实验时字段缺省。 */
  exp?: { id: number; arm: string }
}

/** 提案 kind 全集（P-2 泛化：图谱域 edit + 项目域 project_plan/project_milestone
 * + 实验域 experiment（D-1 #110 / ADR-0023 提案-确认制）+ 覆盖域 enrich（schema v2
 * 出生/覆盖层分家，#127/#131：回填通道，sha256 内容指纹，只补写图谱可对照字段））。
 * gen（骨架提案）已随 #138 cutover 退役（ADR-0033 生长式图）——存量流水里的 gen
 * 记录只读展示（loadProposals 不校验 kind），不再是可创建/受理的 kind。 */
export const PROPOSAL_KINDS = ['edit', 'enrich', 'project_plan', 'project_milestone', 'experiment'] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

/** 提案记录（db.proposals 行同构；产物 YAML 另存 state/proposals/）。
 * course 语义随 kind：图谱域 = 课程名；项目域 = 项目 id。 */
export interface ProposalRec {
  id: number
  kind: ProposalKind
  course: string
  status: 'pending' | 'applied' | 'rejected'
  summary: string
  artifact: string
  created: string
  decided?: string | null
  decision_note?: string
}

/** 勘误冲正流水条目（state/勘误.jsonl，ADR-0031）：对一条已落盘作答判罚的抵消记录。
 * 聚合账读侧按净值读（netPracticeRecs）；FSRS 调度不冲正、review-log 不抹除。
 * verdict 与申诉复核三态同拼写：key_error = 键错已改并按新键重判 / defective = 瑕疵题
 * 作废（归档随结算落盘）/ overridden = 复核判题没问题但学习者坚持豁免（永不得分）。 */
export interface ErratumRec {
  ts: string
  course: string
  node: string
  qid: string
  /** 被冲正作答的 practice 流水 ts（精确到条；同一条作答至多冲正一次）。 */
  target_ts: string
  verdict: 'key_error' | 'defective' | 'overridden'
  /** 净值替换：该作答记录冲正后的 XP（读侧以此替换原记录的 xp）。 */
  xp: number
  /** 净值替换：冲正后的对错（key_error 改判对时为 true；缺省 = 维持原判）。 */
  correct?: boolean
  /** key_error 时的题目修订内容（已写入题库，此处留痕）。 */
  revision?: { answer?: unknown; explanation?: string }
  /** 复核结论/申诉理由摘要。 */
  reason?: string
}
