/**
 * D-4 睡眠耦合排程建议（#85；Walker 2002/2005 重巩固窗口）：调度建议层——对
 * 重巩固型节点（v1 = type:practice 的交互实践节点，乐器/运动类全任务练习）建议
 * 「睡前练、醒后验」时段，并附可选心理演练一句话（r≈0.13 小效应，预期管理措辞）。
 *
 * 红线：纯读侧建议——不改调度语义、不产生到期、不碰 canonical/XP/掌握度；全局
 * 可关（state/learnhub.json 的 sleep.enabled，默认开）。零依赖纯函数。
 */

/** 一条睡眠耦合建议（文案锁预期管理口径：受益如实、效应量如实、不夸大不担保）。 */
export interface SleepSuggestion {
  /** 主建议：睡前练、醒后验。 */
  text: string
  /** 可选心理演练附注（小效应，锦上添花措辞）。 */
  rehearsal: string
}

/** 重巩固型节点的睡眠耦合建议（#85）：练习记忆的巩固发生在睡眠中——睡前短练、
 * 醒后短验；心理演练单列（小效应，明确说「别替代真练」）。 */
export function reconsolidationAdvice(nodeName: string): SleepSuggestion {
  return {
    text: `「${nodeName}」这类实践技能的巩固发生在睡眠里（Walker 2002/2005）：今晚睡前练一小段，明早醒后先练一次检验保持——两次都短即可，别熬夜加量。`,
    rehearsal: '可选：睡前闭眼在心里把动作/流程过一遍 2 分钟（心理演练）。证据量小（r≈0.13），当锦上添花，别替代真练。',
  }
}

/** 独立睡眠事件的每课程数量帽（附着在既有事件上的不算——不新占推荐位）。 */
export const SLEEP_STANDALONE_MAX = 2

/** 独立睡眠事件的推荐分：低于新课带（30–48），纯信息性不抢正事。 */
export const SLEEP_SCORE = 25

/** sleep 建议层配置（state/learnhub.json 的 sleep 字段）：enabled=false 全层静默。 */
export interface SleepAdviceConfig { enabled: boolean }

export const DEFAULT_SLEEP_ADVICE: SleepAdviceConfig = { enabled: true }

/** 归一读入（缺省/非法字段回默认——建议层配置损坏不影响调度）。 */
export function normalizeSleepAdvice(raw: { enabled?: unknown } | undefined): SleepAdviceConfig {
  return { enabled: raw?.enabled !== false }
}
