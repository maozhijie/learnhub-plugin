/**
 * 交互件消息总线：InteractiveBlock 注册 iframe 发送器，面板侧（「问 AI 老师」的演示按钮）
 * 通过 broadcast 向当前视图内全部交互件广播 LEARNHUB_TEACHER 动作
 * （highlight/setState/reveal/annotate；widget 侧监听契约见引擎 interactiveSpecBlock）。
 * Provider 挂在 LessonView；无 Provider 的视图（如复习刷卡流单独使用时）useWidgetBus
 * 返回 null——交互件照常渲染，仅无 AI 老师广播能力。
 */
import { createContext, useCallback, useContext, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

/** AI 老师动作载荷（与交互件侧监听样板一一对应）。 */
export interface TeacherAction {
  action: 'highlight' | 'setState' | 'reveal' | 'annotate'
  /** highlight/reveal 的目标元素 CSS 选择器。 */
  selector?: string
  /** setState 的变量名 → 值映射。 */
  state?: Record<string, number | string>
  /** annotate 的批注文字。 */
  text?: string
}

type WidgetPost = (msg: unknown) => void

interface WidgetBusValue {
  /** 注册一个交互件发送器；返回注销函数。 */
  register: (post: WidgetPost) => () => void
  broadcast: (msg: TeacherAction) => void
}

const WidgetBusContext = createContext<WidgetBusValue | null>(null)

export function WidgetBusProvider(props: { children: ReactNode }) {
  const widgets = useRef(new Set<WidgetPost>())
  const register = useCallback((post: WidgetPost) => {
    widgets.current.add(post)
    return () => {
      widgets.current.delete(post)
    }
  }, [])
  const broadcast = useCallback((msg: TeacherAction) => {
    for (const post of widgets.current) post({ type: 'LEARNHUB_TEACHER', ...msg })
  }, [])
  const value = useMemo(() => ({ register, broadcast }), [register, broadcast])
  return <WidgetBusContext.Provider value={value}>{props.children}</WidgetBusContext.Provider>
}

export function useWidgetBus(): WidgetBusValue | null {
  return useContext(WidgetBusContext)
}
