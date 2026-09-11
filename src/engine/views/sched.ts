/**
 * sched 域视图类型（#152 刀归档；叶子文件，只引类型层）。
 */
import type { JolBin } from '../jol.ts'

/** 每课程 ETA（剩余节点 × 每节点 XP ÷ 每日目标）。 */
export interface EtaItem { course: string; remaining: number; done: number; per_node: number; days: number }

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

export interface XpStatus {
  /** 当前学习日（ADR-0020）。 */
  date: string
  /** 生效日界 'HH:mm'（ADR-0020 配置三件套静默回落时的可见性补偿）。 */
  day_cutoff: string
  today_xp: number
  goal: number
  streak: number
  /** streak 宽容天数（C-4 #83）：≤ 该天数的连续漏天不断链（生效值可见性，同 day_cutoff 先例）。 */
  streak_grace_days: number
  eta: EtaItem[]
}
