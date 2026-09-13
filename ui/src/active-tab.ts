/** 当前激活视图信号（页签保活 ADR-0027 的配套）：App 写，各页定时器读——
 * 组件常驻不卸载，隐藏视图的轮询据此跳过取数，只保留定时节拍。
 * 信号口径 = 路由视图键（#205 / ADR-0058）：courses 区的四个子视图互斥可见，
 * 各认各的键；insight 区一页一视图键（#210 洞察区成型后实验室页不再并列）。
 *
 * #189 与路由的关系——**桥接**（备选「isActiveTab 改为即时解析路由」被否）：
 * 初始值从路由解析（深链/刷新直达视图时，子组件先于 App effect 挂载，首拍 beat
 * 不再落默认视图假窗而错失首次取数）；此后 App 在路由变化时经 setActiveTab 镜像。
 * isActiveTab 门与 learnhub:tab 切回事件语义零变化，消费方只随视图键改名。
 * 否决理由：即时解析每次轮询碰 DOM 且时序反而更松（hashchange 异步于 React 提交），
 * 换不来删掉这 10 行模块态。 */
import { parseHash, readHash, viewOfRoute } from './lib/router'
import type { ViewKey } from './lib/router'

let current: ViewKey = viewOfRoute(parseHash(readHash()))

export function setActiveTab(t: ViewKey): void {
  if (t === current) return
  current = t
  // 广播激活事件：keep-alive 下组件不重挂，「进入页面即取数」的语义由各页的
  // 切回钩子补（尤其 LessonView 的完成边沿——隐藏期间错过的生成收尾在切回时补判）
  window.dispatchEvent(new CustomEvent('learnhub:tab', { detail: t }))
}

export function isActiveTab(t: ViewKey): boolean {
  return current === t
}

/** 页签激活钩子（页签保活 ADR-0027 配套）：keep-alive 下组件不重挂，「切回该视图」
 * 的取数语义（激活重取/完成边沿补判）统一挂这里——回调只在 detail 命中时触发。 */
export function onTabActive(t: ViewKey, fn: () => void): () => void {
  const h = (e: Event) => {
    if ((e as CustomEvent).detail === t) fn()
  }
  window.addEventListener('learnhub:tab', h)
  return () => { window.removeEventListener('learnhub:tab', h) }
}
