/** 当前激活页签信号（页签保活 ADR-0027 的配套）：App 写，各页定时器读——
 * 组件常驻不卸载，隐藏页签的轮询据此跳过取数，只保留定时节拍。
 *
 * #189 与路由的关系——**桥接**（备选「isActiveTab 改为即时解析路由」被否）：
 * 初始值从路由解析（深链/刷新直达页签时，子组件先于 App effect 挂载，首拍 beat
 * 不再落 'learn' 假窗而错失首次取数）；此后 App 在路由变化时经 setActiveTab 镜像。
 * isActiveTab 门与 learnhub:tab 切回事件语义零变化，六处 usePolling 消费方零改动。
 * 否决理由：即时解析每次轮询碰 DOM 且时序反而更松（hashchange 异步于 React 提交），
 * 换不来删掉这 10 行模块态。 */
import { parseHash, readHash } from './lib/router'
import type { TabKey } from './lib/router'

let current: TabKey = parseHash(readHash())

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

/** 页签激活钩子（页签保活 ADR-0027 配套）：keep-alive 下组件不重挂，「切回该页签」
 * 的取数语义（激活重取/完成边沿补判）统一挂这里——回调只在 detail 命中时触发。 */
export function onTabActive(t: TabKey, fn: () => void): () => void {
  const h = (e: Event) => {
    if ((e as CustomEvent).detail === t) fn()
  }
  window.addEventListener('learnhub:tab', h)
  return () => window.removeEventListener('learnhub:tab', h)
}
