/** 当前激活页签信号（页签保活 ADR-0027 的配套）：App 写，各页定时器读——
 * 组件常驻不卸载，隐藏页签的轮询据此跳过取数，只保留定时节拍。 */
import type { TabKey } from './App'

let current: TabKey = 'learn'

export function setActiveTab(t: TabKey): void {
  current = t
}

export function isActiveTab(t: TabKey): boolean {
  return current === t
}
