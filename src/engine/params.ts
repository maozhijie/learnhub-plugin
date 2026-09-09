/**
 * 可调参数集中表（吸收自 Python params.py，唯一出处；调整只改这里）。
 */
export const DESIRED_RETENTION = 0.9     // FSRS 期望保留率
export const R_GATE = 0.85               // 前置解锁的可提取性门槛
export const S_MASTER = 30.0             // mastered 标记的稳定性阈值（天）
export const REVIEW_RATIO = 0.6          // 任务包中复习时间占比
export const MIN_PER_REVIEW = 3          // 单个复习任务估时（分钟）
export const MIN_PER_NEW = 12            // 新节点首学预算（分钟）
export const DAILY_CAPACITY = 20         // 日均处理能力（防过载基准，个）
export const OVERLOAD_FACTOR = 2         // 复习债 > 日均×该倍数 → 停推新课
export const SOFT_RESTART_GAP = 3        // 空窗 ≥ N 天进入软重启（天）
export const RECOVERY_CLEAR_RATIO = 0.7  // 恢复模式清偿率达该值后恢复新课
export const QUIZ_ITEMS_PER_CANDIDATE = 2 // 前置抽测每候选最多题数
export const SCAN_INIT_S = 7.0           // scan 粗估初始稳定性（天）
export const SCAN_INIT_D = 5.0           // scan 粗估初始难度
export const FSRS_DIFFICULTY_MID = 5.0   // FSRS difficulty 的中性值（k 校准：difficulty/该值 = 难度因子）

// ---- XP 时间账本（1 XP ≈ 1 分钟有效专注；ETA = 剩余估算 XP ÷ 每日目标）----
export const XP_BASE: Record<string, number> = {
  single_choice: 1, true_false: 1, fill_in_blank: 2, reflection: 3,
  multi_choice: 1, numeric: 2, ordering: 2, matching: 2, open_question: 3,
}
export const XP_GUESS_SECONDS = 5        // 作答耗时低于该值且答错 → 乱猜
export const XP_GUESS_PENALTY = -1       // 乱猜负 XP（保持时间账本诚实）
export const XP_PERFECT_BONUS = 2        // 节点满分完成的 bonus XP
export const XP_PER_NODE_DEFAULT = 12    // 无课程历史时每节点 XP 估算
export const XP_PER_MILESTONE_DEFAULT = 120 // 里程碑无 est 申报时的过点定价缺省（1–2 周粒度的保守投入，#94）
export const DAILY_XP_GOAL_DEFAULT = 30  // 每日 XP 目标缺省（state/learnhub.json 可覆盖）
export const DAY_CUTOFF_DEFAULT = '02:00' // 日界缺省（ADR-0020；state/learnhub.json 的 day_cutoff 可覆盖）

// ---- Self-Calibration 自评校准画像（ADR-0022 #104；呈现层参数，零 canonical）----
export const CALIBRATION_OVERCONF_THRESHOLD = 0.6 // 「会」档系统性过信显著阈值：该档 ≥JOL_CALIBRATION_MIN 条配对且实际正确率低于此值即检出（宣称「会」≈接近确知；真伪题瞎猜基线 0.5，持续低于 0.6 = 预测几乎不带信息）
export const CALIBRATION_BOOST_SAMPLE_RATE = 1 / 2 // 过信检出且提示开时的 JOL 抽查加强密度（默认 1/3 → 1/2；只影响抽查频率，不改任何 canonical 写入）
