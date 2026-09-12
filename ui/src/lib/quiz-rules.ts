/** 练习轮过关规则（PracticeFlow 消费）——零依赖独立模块，node:test 可直接消费。
 * 连对目标随组内实际题量收缩：出题侧按复杂度档位给每节出题（低档仅 1 题），
 * 固定「连对 2」在 1 题的轮里数学上不可达，会把学习者永久卡在 struggle 分支。 */

/** 连对即过该节的基准目标（MA 式）。 */
export const PASS_STREAK = 2

/** 每节至多作答题目数（超过未达标 → struggle，引导重读或 AI 再出题）。 */
export const MAX_ASK_PER_ROUND = 5

/** 本轮连对目标：min(基准, 组内题量)，下限 1——题不够时目标随之降档。 */
export function passStreakFor(roundLen: number): number {
  return Math.max(1, Math.min(PASS_STREAK, roundLen))
}

/** 节点未归档题软上限（#117）：到达后出题入口需显式确认才能继续（按钮级确认，
 * 非服务端硬闸——BankPage 校准重出与 agent 工具不受限）。 */
export const QUIZ_SOFT_CAP = 40
