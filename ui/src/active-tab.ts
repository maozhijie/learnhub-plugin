/** 当前激活页签信号（页签保活 ADR-0027 的配套）：App 写，各页定时器读——
 * 组件常驻不卸载，隐藏页签的轮询据此跳过取数，只保留定时节拍。 */
import type { TabKey } from './App'

let current: TabKey = 'learn'

export function setActiveTab(t: TabKey): void {
  if (t === current) return
  current = t
  // 广播激活事件：keep-alive 下组件不重挂，「进入页面即取数」的语义由各页的
  // 切回钩子补（尤其 LessonView 的完成边沿——隐藏期间错过的生成收尾在切回时补判）
  window.dispatchEvent(new CustomEvent('learnhub:tab', { detail: t }))
}

export function isActiveTab(t: TabKey): boolean {
  return current === t
}
