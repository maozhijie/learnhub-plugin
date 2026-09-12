/** 极简 hash 路由缝（U3 / #189 / ADR-0052）：location.hash 是导航状态的唯一权威——
 * 刷新停留在当前页签、前进后退在页签历史间穿梭、`#/projects` 式深链直达。
 *
 * URL 文法：`#/` + 页签键 [+ `/` 参数段]。参数段**留形不实现**——course/node 类定位
 * 参数是将来嵌套路由的扩展位，v1 只取首段、多余段忽略；非法/缺省回落 DEFAULT_TAB。
 * URL 方案即扩展契约（ADR-0052）：将来膨胀换真 router 库时，URL 不变、消费方不变
 * （页签跳转全部经 AppFrame 三缝，页签组件零改动），本文件是唯一改动点。
 *
 * lib 层身份（ADR-0052）：parseHash 是零 DOM 纯解析核；navigate/syncHash/onRouteChange
 * 是贴着 window 的薄绑定（~10 行），与 settle-context 同为 lib 的登记例外，
 * node:test 以 window 桩直测（tests/ui-router.test.ts）。
 */

/** 页签键：全 ui 唯一出处（键字面量表单源派生）。页签表（TAB_KEYS）对齐 App 的
 * TabPane 用户可见序，App 的 TabPane 键、TabBody 保活分支、本表三方对账由
 * tests/ui-router.test.ts 执法（Exhibit A：#158 漏键表致修复从未生效）。 */
export const TAB_KEYS = [
  'learn', 'graph', 'bank', 'stats', 'generate',
  'proposals', 'practice', 'projects', 'lab', 'guide',
] as const

export type TabKey = (typeof TAB_KEYS)[number]

export const DEFAULT_TAB: TabKey = 'learn'

const hashOf = (tab: TabKey): string => `#/${tab}`

/** 读当前 hash（无 window 环境安全回落空串：L2 冒烟与单测桩外的导入路径）。 */
export function readHash(): string {
  return typeof window !== 'undefined' && window.location ? window.location.hash : ''
}

/** hash → 页签：合法键取首段，非法/缺省回落默认页签。 */
export function parseHash(hash: string): TabKey {
  const seg = hash.replace(/^#\/?/, '').split('/')[0] ?? ''
  return (TAB_KEYS as readonly string[]).includes(seg) ? (seg as TabKey) : DEFAULT_TAB
}

/** 程序化跳转：写 URL 权威。同值赋值浏览器不产生事件与历史条目，幂等。 */
export function navigate(tab: TabKey): void {
  window.location.hash = hashOf(tab)
}

/** URL 规范化到当前页签：仅在 hash 与页签漂移时 replaceState（无历史条目、无事件）——
 * 初始空 hash 与手改非法 hash 收敛成规范形；前进/后退由浏览器写入，天然一致不触发。 */
export function syncHash(tab: TabKey): void {
  if (readHash() !== hashOf(tab)) window.history.replaceState(null, '', hashOf(tab))
}

/** 订阅路由变化（hashchange 的页签投影）：回调收到解析后的页签。返回退订函数。 */
export function onRouteChange(fn: (tab: TabKey) => void): () => void {
  const h = () => { fn(parseHash(readHash())) }
  window.addEventListener('hashchange', h)
  return () => { window.removeEventListener('hashchange', h) }
}
