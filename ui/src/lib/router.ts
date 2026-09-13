/** 极简 hash 路由缝（U3 / #189 / ADR-0052；#205 / ADR-0058 两级化；#209 / ADR-0058
 * 参数段兑现：单课工作台 `#/course/<id>/<sub>`）：location.hash 是导航状态的唯一
 * 权威——刷新停留在当前视图、前进后退在历史间穿梭、深链直达。
 *
 * URL 文法：`#/` + 区键，其中 courses 区展开为三入口 + 参数段工作台：
 * - `#/courses`（我的课程，缺省）与 `#/courses/queue`、`#/courses/proposals`（全局面，
 *   兼容 T1/T4 深链），规范形 `#/queue`、`#/proposals`；
 * - `#/course/<id>/<sub>` 单课工作台（ADR-0052「参数段」预留位的兑现），sub ∈
 *   graph/coach/queue/proposals/bank，缺省 graph；`<id>` 经 encodeURIComponent。
 * 视图键（VIEW_KEY）= 区键或 `courses.<sub>`，是保活/轮询门/程序化跳转的口径；
 * 工作台整体共享 `courses.course` 一个视图键（保活与轮询门的单位），工作台内部分栏
 * 切换走 navigateCourse 写完整 hash——前进后退在分栏间穿梭。工作台视图键不可由
 * navigate 直达（无参不成 URL），程序化入口是 navigateCourse。
 *
 * 旧键深链（`#/learn`、`#/courses/graph`、`#/courses/bank` 等平铺/子路由旧键）回落
 * 我的课程——ADR-0058 登记的自用工具可接受已知断裂；`#/projects`、`#/practice` 两键
 * 新旧同形天然延续。
 *
 * lib 层身份（ADR-0052）：parseHash 是零 DOM 纯解析核；navigate/navigateCourse/
 * syncHash/onRouteChange 是贴着 window 的薄绑定，与 settle-context 同为 lib 的登记
 * 例外，node:test 以 window 桩直测（tests/ui-router.test.ts）。
 */

/** 区键：五区页签，全 ui 唯一出处。区表（ZONE_KEYS）与壳顶栏页签、保活视图分支
 * 对账由 tests/ui-router.test.ts 执法（Exhibit A 纪律延续）。区名的另外两份同构投影
 * ——宿主 AGENT_GUIDE 的 page 词表（src/host/llm.ts 头注释）与面板页面词表
 * （components/AgentHints.tsx GUIDE_PAGE_LABEL）——增删区键须三处同步。 */
export const ZONE_KEYS = ['today', 'courses', 'insight', 'projects', 'practice'] as const

export type ZoneKey = (typeof ZONE_KEYS)[number]

export const DEFAULT_ZONE: ZoneKey = 'today'

/** 课程区子路由：三入口（#209 / ADR-0058）——我的课程 + 全局生成队列 + 全局提案收件箱。 */
export const COURSE_SUBS = ['home', 'queue', 'proposals'] as const

export type CourseSub = (typeof COURSE_SUBS)[number]

export const DEFAULT_COURSE_SUB: CourseSub = 'home'

/** 单课工作台分栏（#209）：首屏罗盘+图 → 教练台 → 生长与队列（本课切片）→
 * 提案（本课切片）→ 题库（本课切片）。 */
export const WORKBENCH_SUBS = ['graph', 'coach', 'queue', 'proposals', 'bank'] as const

export type WorkbenchSub = (typeof WORKBENCH_SUBS)[number]

export const DEFAULT_WORKBENCH_SUB: WorkbenchSub = 'graph'

/** 视图键 = 路由的保活/轮询口径：courses 区展开为三入口视图 + 参数化工作台视图
 * （工作台整体一个视图键，分栏切换不改视图键）。 */
export const VIEW_KEYS = [
  'today', 'courses.home', 'courses.queue', 'courses.proposals', 'courses.course',
  'insight', 'projects', 'practice',
] as const

export type ViewKey = (typeof VIEW_KEYS)[number]

export const DEFAULT_VIEW: ViewKey = 'today'

/** 解析后的路由：区 + 子路由（非 courses 区恒 null）+ 工作台参数段（仅 workbench）。 */
export interface Route {
  zone: ZoneKey
  sub: CourseSub | null
  /** 单课工作台的课程 id（`#/course/<id>/…`）；非工作台路由恒 null。 */
  courseId: string | null
  /** 工作台分栏（courseId 非空时有效，缺省 graph）。 */
  wb: WorkbenchSub
}

const EMPTY_ROUTE = (zone: ZoneKey): Route => ({ zone, sub: zone === 'courses' ? DEFAULT_COURSE_SUB : null, courseId: null, wb: DEFAULT_WORKBENCH_SUB })

/** 读当前 hash（无 window 环境安全回落空串：L2 冒烟与单测桩外的导入路径）。 */
export function readHash(): string {
  return typeof window !== 'undefined' && window.location ? window.location.hash : ''
}

/** hash → 路由：首段命中区键否则回落默认区；courses 的次段命中子路由表否则回落
 * 我的课程（旧子路由键 graph/bank 的深链回落是登记的已知断裂）；`course` 首段 =
 * 参数段工作台：次段是课程 id（decodeURIComponent，容忍旧编码），第三段命中分栏表
 * 否则缺省 graph；无 id 的 `#/course` 回落我的课程。 */
export function parseHash(hash: string): Route {
  const segs = hash.replace(/^#\/?/, '').split('/')
  if (segs[0] === 'course') {
    const id = segs[1] ?? ''
    if (!id) return EMPTY_ROUTE('courses')
    let courseId = id
    try { courseId = decodeURIComponent(id) } catch { /* 旧链接未编码的 id 原样用 */ }
    const wb = (WORKBENCH_SUBS as readonly string[]).includes(segs[2] ?? '')
      ? segs[2] as WorkbenchSub
      : DEFAULT_WORKBENCH_SUB
    return { zone: 'courses', sub: null, courseId, wb }
  }
  if (segs[0] === 'queue' || segs[0] === 'proposals') {
    return { zone: 'courses', sub: segs[0] as CourseSub, courseId: null, wb: DEFAULT_WORKBENCH_SUB }
  }
  const zone = (ZONE_KEYS as readonly string[]).includes(segs[0] ?? '')
    ? segs[0] as ZoneKey
    : DEFAULT_ZONE
  if (zone !== 'courses') return EMPTY_ROUTE(zone)
  const sub = (COURSE_SUBS as readonly string[]).includes(segs[1] ?? '')
    ? segs[1] as CourseSub
    : DEFAULT_COURSE_SUB
  return { zone, sub, courseId: null, wb: DEFAULT_WORKBENCH_SUB }
}

/** 路由 → 视图键（保活/轮询门/active-tab 信号的口径）：参数段工作台共享一个视图键。 */
export function viewOfRoute(r: Route): ViewKey {
  if (r.zone === 'courses') {
    if (r.courseId !== null) return 'courses.course'
    return `courses.${r.sub ?? DEFAULT_COURSE_SUB}` as ViewKey
  }
  return r.zone
}

/** 视图键 → 路由。工作台视图键没有可回写的参数段（courseId 空串占位）——它不可经
 * navigate 直达，程序化入口是 navigateCourse。 */
export function routeOfView(v: ViewKey): Route {
  if (v === 'courses.course') return { zone: 'courses', sub: null, courseId: '', wb: DEFAULT_WORKBENCH_SUB }
  if (v.startsWith('courses.')) return { zone: 'courses', sub: v.slice('courses.'.length) as CourseSub, courseId: null, wb: DEFAULT_WORKBENCH_SUB }
  return EMPTY_ROUTE(v as ZoneKey)
}

/** 视图键 → 所属区（顶栏页签高亮口径）。 */
export function zoneOfView(v: ViewKey): ZoneKey {
  return routeOfView(v).zone
}

const hashOfView = (v: ViewKey): string => {
  if (v === 'courses.course') return '#/courses' // 参数段不成view键形：回落课程区首屏（navigate 不应到达此处）
  if (v === 'courses.home') return '#/courses' // 规范形不带 home 段（#/courses/home 也能解析到同视图）
  return `#/${v.replace('.', '/')}`
}

/** 程序化跳转：写 URL 权威。同值赋值浏览器不产生事件与历史条目，幂等。
 * 仅用于非参数化视图；工作台跳转走 navigateCourse。 */
export function navigate(view: ViewKey): void {
  window.location.hash = hashOfView(view)
}

/** 程序化跳转·单课工作台：写完整参数段 hash（`#/course/<id>/<wb>`），id 编码。 */
export function navigateCourse(courseId: string, wb: WorkbenchSub): void {
  window.location.hash = `#/course/${encodeURIComponent(courseId)}/${wb}`
}

/** URL 规范化到当前视图：仅在 hash 与视图漂移时 replaceState（无历史条目、无事件）
 * ——初始空 hash、手改非法 hash、旧键深链都收敛成规范形。工作台视图键特殊：hash
 * 已是参数段形（#/course/…）即一致（分栏/id 不是漂移面），否则规范到课程区首屏。
 * 前进/后退由浏览器写入，天然一致。 */
export function syncHash(view: ViewKey): void {
  const current = readHash()
  if (view === 'courses.course') {
    if (!current.startsWith('#/course/')) window.history.replaceState(null, '', hashOfView(view))
    return
  }
  if (current !== hashOfView(view)) window.history.replaceState(null, '', hashOfView(view))
}

/** 订阅路由变化（hashchange 的视图投影）：回调收到解析后的视图键。返回退订函数。 */
export function onRouteChange(fn: (view: ViewKey) => void): () => void {
  const h = () => { fn(viewOfRoute(parseHash(readHash()))) }
  window.addEventListener('hashchange', h)
  return () => { window.removeEventListener('hashchange', h) }
}
