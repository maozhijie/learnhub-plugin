/**
 * Learner 域视图类型（E3/E1/校准画像/技能 lane/习惯/U4 周复盘；#152 刀 4 自 views.ts 归档）。
 */
import type { JolBin, JolPrediction } from '../jol.ts'

// ---- U4 周复盘 Weekly Kata（#114 / ADR-0026：Learner Output，零 XP 零 canonical）

/** 周复盘打开/保存的返回（五问结构 + 已有记录清单；sections 含引擎填的现状）。 */
export interface KataDoc {
  date: string
  /** 复盘对象学习周（周一–周日，学习日折叠口径）。 */
  week_start: string
  week_end: string
  /** 记录文件绝对路径（我的产出/周复盘/<周一>.md）。 */
  path: string
  /** 本次是否新建（false = 打开已有记录，四问保留）。 */
  created: boolean
  /** 引擎现算的现状段正文（渲染后的 markdown）。 */
  reality: string
  /** 五问各问正文（含占位）。 */
  sections: Record<string, string>
  /** 四问是否都已作答。 */
  answered: boolean
  /** 已有复盘清单（常驻入口面）。 */
  list: Array<{ week_start: string; answered: boolean }>
}

// ---- 习惯（U 区 #90 / ADR-0017：habitList / habitShow，GET /api/habits、/api/habit）

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

// ---- 技能条目 lane（U 区 #89 / ADR-0018：skillList，GET /api/skills、learnhub_skill_list）

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

// ---- E1「我的卡」（#45 / #68 / #70；learnerQueue / learnerCardRate / learnerCardForget）

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

// ---- 自评校准画像（calibrationProfile；ADR-0022 #104 分源自省面）----
// 类型在本文件内联定义（照 MemoryHealthDoc 先例：视图形状就地声明，不 import 运行时
// 模块——calibration.ts 带 .ts 扩展的 value import，进 ui tsc 程序会 TS5097）。

/** 单源自省切片：校准聚合（复用 jol 口径：档位 × 实际正确率）+ 源内系统性过信判定。
 * 配对不足门槛时 calibration 为 null（静默不显示）。source 枚举 = calibration.ts
 * 的 CalibrationSource（v1 恒 'jol'；#88/#89 扩展）。 */
export interface CalibrationSourceProfile {
  source: 'jol'
  /** 配对区间时间戳（ADR-0022 配对契约的 ts 元素）：该源配对集合最早/最晚一条的
   * PracticeRec.ts（单条配对 ts 底数在 practice 流水，画像只透出聚合区间）；零配对为 null。 */
  first_ts: string | null
  last_pair_ts: string | null
  calibration: { pairs: number; bins: JolBin[] } | null
  overconfidence: {
    overconfident: boolean
    /** 数据足门槛时的证据快照（该档 n / 实际正确率 / 阈值）；不足门槛为 null。 */
    evidence: { source: 'jol'; self: JolPrediction; n: number; accuracy: number; threshold: number } | null
  }
}

/** 自评校准画像（ADR-0022 #104）：分源切片为主视图（构念效度：域特异成分显著），
 * global 只是各源合并的参考视图、必须连同 warning 域特异警戒一起展示。
 * 只读派生（practice 流水配对），零落盘、零 canonical 写入。 */
export interface CalibrationProfileDoc {
  sources: CalibrationSourceProfile[]
  global: { calibration: { pairs: number; bins: JolBin[] } | null; warning: string }
}
