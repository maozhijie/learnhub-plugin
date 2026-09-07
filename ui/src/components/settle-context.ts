/** 交互件成绩结算上下文：PracticeFlow 在交互节轮提供（course/node/sectionId），
 * InteractiveBlock（renderers）消费——沙箱 iframe 上报 LEARNHUB_COMPLETE 时
 * 据此调 /interactive/settle。无 Provider（如整课正文自由阅读）时只亮徽标不结算。 */
import { createContext } from 'react'

export interface SettleContextValue { course: string; node: string; sectionId: string }

export const SettleContext = createContext<SettleContextValue | null>(null)
