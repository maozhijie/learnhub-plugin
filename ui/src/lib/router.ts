/** 极简 hash 路由缝（U3 / #189 / ADR-0052；#205 / ADR-0058 兑现「参数段」两级化）：
 * location.hash 是导航状态的唯一权威——刷新停留在当前视图、前进后退在历史间穿梭、
 * `#/projects` 式深链直达。
 *
 * URL 文法（两级）：`#/` + 区键 [+ `/` 课程子路由]。五区 = today/courses/insight/
 * projects/practice；只有 courses 有子路由段（graph/queue/proposals/bank，#205 的
 * 四入口；T5 成型为我的课程 + `#/course/<id>/…` 工作台与其余全局面时在此演化）。
 * 视图键（VIEW_KEY）= 区键或 `courses.<sub>`，是保活/轮询门/程序化跳转的口径——
 * courses 四个子视图互斥可见、各页轮询门各认各的；无子区的视图键 = 区键。
 *
 * 旧键深链（`#/learn` 等平铺页签键）回落默认区——ADR-0058 登记的自用工具可接受
 * 已知断裂；`#/projects`、`#/practice` 两键新旧同形天然延续。
 *
 * lib 层身份（ADR-0052）：parseHash 是零 DOM 纯解析核；navigate/syncHash/onRouteChange
 * 是贴着 window 的薄绑定，与 settle-context 同为 lib 的登记例外，
 * node:test 以 window 桩直测（tests/ui-router.test.ts）。
 */

/** 区键：五区页签，全 ui 唯一出处。区表（ZONE_KEYS）与壳顶栏页签、保活视图分支
 * 对账由 tests/ui-router.test.ts 执法（Exhibit A 纪律延续）。区名的另外两份同构投影
 * ——宿主 AGENT_GUIDE 的 page 词表（src/host/llm.ts 头注释）与面板页面词表
 * （components/AgentHints.tsx GUIDE_PAGE_LABEL）——增删区键须三处同步。 */
export const ZONE_KEYS = ['today', 'courses', 'insight', 'projects', 'practice'] as const

export type ZoneKey = (typeof ZONE_KEYS)[number]

export const DEFAULT_ZONE: ZoneKey = 'today'

/** 课程区子路由：T1 四入口（图/队列/提案/题库），三入口形态在 T5 成型。 */
export const COURSE_SUBS = ['graph', 'queue', 'proposals', 'bank'] as const

export type CourseSub = (typeof COURSE_SUBS)[number]

export const DEFAULT_COURSE_SUB: CourseSub = 'graph'

/** 视图键 = 路由的保活/轮询口径：courses 区展开为四个互斥子视图，其余区 = 区键。 */
export const VIEW_KEYS = [
  'today', 'courses.graph', 'courses.queue', 'courses.proposals', 'courses.bank',
  'insight', 'projects', 'practice',
] as const

export type ViewKey = (typeof VIEW_KEYS)[number]

export const DEFAULT_VIEW: ViewKey = 'today'

/** 解析后的路由：区 + 子路由（非 courses 区恒 null）。 */
export interface Route { zone: ZoneKey; sub: CourseSub | null }

/** 读当前 hash（无 window 环境安全回落空串：L2 冒烟与单测桩外的导入路径）。 */
export function readHash(): string {
  return typeof window !== 'undefined' && window.location ? window.location.hash : ''
}

/** hash → 路由：首段必须命中区键否则回落默认区；courses 的次段命中子路由表
 * 否则回落默认子路由；旧键（learn/graph/stats…）不在区表 = 回落默认区。 */
export function parseHash(hash: string): Route {
  const segs = hash.replace(/^#\/?/, '').split('/')
  const zone = (ZONE_KEYS as readonly string[]).includes(segs[0] ?? '')
    ? segs[0] as ZoneKey
    : DEFAULT_ZONE
  if (zone !== 'courses') return { zone, sub: null }
  const sub = (COURSE_SUBS as readonly string[]).includes(segs[1] ?? '')
    ? segs[1] as CourseSub
    : DEFAULT_COURSE_SUB
  return { zone, sub }
}

/** 路由 → 视图键（保活/轮询门/active-tab 信号的口径）。 */
export function viewOfRoute(r: Route): ViewKey {
  return r.zone === 'courses' ? `courses.${r.sub}` as ViewKey : r.zone
}

/** 视图键 → 路由。 */
export function routeOfView(v: ViewKey): Route {
  if (v.startsWith('courses.')) return { zone: 'courses', sub: v.slice('courses.'.length) as CourseSub }
  return { zone: v as ZoneKey, sub: null }
}

/** 视图键 → 所属区（顶栏页签高亮口径）。 */
export function zoneOfView(v: ViewKey): ZoneKey {
  return routeOfView(v).zone
}

const hashOfView = (v: ViewKey): string => `#/${v.replace('.', '/')}`

/** 程序化跳转：写 URL 权威。同值赋值浏览器不产生事件与历史条目，幂等。 */
export function navigate(view: ViewKey): void {
  window.location.hash = hashOfView(view)
}

/** URL 规范化到当前视图：仅在 hash 与视图漂移时 replaceState（无历史条目、无事件）——
 * 初始空 hash、手改非法 hash、旧键深链都收敛成规范形；前进/后退由浏览器写入，天然一致。 */
export function syncHash(view: ViewKey): void {
  if (readHash() !== hashOfView(view)) window.history.replaceState(null, '', hashOfView(view))
}

/** 订阅路由变化（hashchange 的视图投影）：回调收到解析后的视图键。返回退订函数。 */
export function onRouteChange(fn: (view: ViewKey) => void): () => void {
  const h = () => { fn(viewOfRoute(parseHash(readHash()))) }
  window.addEventListener('hashchange', h)
  return () => { window.removeEventListener('hashchange', h) }
}
