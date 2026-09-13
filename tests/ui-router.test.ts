/** 极简 hash 路由缝单测（L1，#189 / ADR-0052；#205 两级路由；#209 参数段工作台）：
 * parseHash／navigate／navigateCourse／syncHash／onRouteChange 的口径（区键 + 课程
 * 三入口 + `#/course/<id>/<wb>` 参数段文法、非法/缺省/旧键回落、旧子路由键 graph/bank
 * 回落我的课程——ADR-0058 登记的已知断裂）、active-tab 轮询门与路由的桥接（初始值从
 * 路由解析——#189 票面取舍）、**路由表完整性门**（Exhibit A：#158 漏键表致修复从未
 * 生效——区页签表／课程子导航项表／工作台分栏项表／保活分支表与路由各表对账，带
 * ADR-0047 自检）。
 *
 * window 桩先于被测模块导入：hash 可写、事件可手动派发、replaceState 可观测；
 * active-tab 的模块初始值吃桩里的 hash，故它在本文件内动态导入（每测试文件独立进程，
 * 与 ui-smoke 的全局桩互不污染）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ui/src 按 vite bundler 风格写相对导入（不带扩展名）——挂 tsx-loader 的 resolve 钩子补后缀
//（.ts 本体走 --experimental-transform-types 默认链，与 ui-smoke 同一钩子）
register(new URL('./helpers/tsx-loader.mjs', import.meta.url))

// ---- window 桩（先于任何 ui 模块导入）----
let hash = ''
const listeners = new Map<string, Array<(e: unknown) => void>>()
const replaceCalls: string[] = []
const g = globalThis as unknown as Record<string, unknown>
class FakeEvent {
  type: string
  detail: unknown
  constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail }
}
g.CustomEvent ??= FakeEvent
g.window = {
  location: { get hash() { return hash }, set hash(v: string) { hash = v } },
  history: { replaceState(_s: unknown, _t: unknown, url: string) { replaceCalls.push(url); hash = url } },
  addEventListener(type: string, fn: (e: unknown) => void) { listeners.set(type, [...listeners.get(type) ?? [], fn]) },
  removeEventListener(type: string, fn: (e: unknown) => void) { listeners.set(type, (listeners.get(type) ?? []).filter(f => f !== fn)) },
  dispatchEvent(e: { type: string }): boolean {
    for (const fn of listeners.get(e.type) ?? []) fn(e)
    return true
  },
}

const fire = (type: string): void => { g.window.dispatchEvent(new (g.CustomEvent as typeof FakeEvent)(type)) }
const router = await import('../ui/src/lib/router.ts')
const {
  COURSE_SUBS, DEFAULT_COURSE_SUB, DEFAULT_VIEW, DEFAULT_ZONE, DEFAULT_WORKBENCH_SUB,
  VIEW_KEYS, WORKBENCH_SUBS, ZONE_KEYS,
  navigate, navigateCourse, onRouteChange, parseHash, readHash, routeOfView, syncHash, viewOfRoute, zoneOfView,
} = router

// ---- parseHash：两级 URL 文法 + 参数段 ----

test('parseHash：五区键解析；courses 三入口；#/queue、#/proposals 全局面规范形', () => {
  for (const z of ZONE_KEYS) {
    assert.equal(parseHash(`#/${z}`).zone, z, `#/${z} 应解析为 ${z} 区`)
  }
  assert.deepEqual(parseHash('#/courses'), { zone: 'courses', sub: 'home', courseId: null, wb: DEFAULT_WORKBENCH_SUB },
    '#/courses = 我的课程（缺省子路由）')
  for (const s of COURSE_SUBS) {
    assert.deepEqual(parseHash(`#/courses/${s}`), { zone: 'courses', sub: s, courseId: null, wb: DEFAULT_WORKBENCH_SUB },
      `#/courses/${s} 应解析出子路由 ${s}`)
    if (s !== 'home') {
      assert.equal(viewOfRoute(parseHash(`#/${s}`)), `courses.${s}`, `#/${s} 规范形直达全局面 ${s}`)
    }
  }
  for (const bad of ['', '#', '#/', '#/nope', '#/learn', '#/graph', '#/stats', '#/generate']) {
    assert.deepEqual(parseHash(bad), { zone: DEFAULT_ZONE, sub: null, courseId: null, wb: DEFAULT_WORKBENCH_SUB },
      `旧键/非法 hash「${bad || '(空)'}」应回落默认视图（ADR-0058 登记的已知断裂）`)
  }
  assert.deepEqual(parseHash('#/courses/nope'), { zone: 'courses', sub: DEFAULT_COURSE_SUB, courseId: null, wb: DEFAULT_WORKBENCH_SUB },
    'courses 非法子路由回落我的课程')
  // T1 时代子路由键（graph/bank）退役：深链回落我的课程（登记的已知断裂）
  assert.equal(viewOfRoute(parseHash('#/courses/graph')), 'courses.home')
  assert.equal(viewOfRoute(parseHash('#/courses/bank')), 'courses.home')
})

test('parseHash：#/course/<id>/<wb> 参数段工作台（ADR-0052 预留位兑现）', () => {
  for (const wb of WORKBENCH_SUBS) {
    assert.deepEqual(parseHash(`#/course/数学/${wb}`), { zone: 'courses', sub: null, courseId: '数学', wb },
      `#/course/数学/${wb} 应解析出分栏 ${wb}`)
  }
  assert.equal(viewOfRoute(parseHash('#/course/数学')), 'courses.course', '无分栏段回落首屏罗盘与图')
  assert.equal(parseHash('#/course/数学').wb, DEFAULT_WORKBENCH_SUB)
  assert.equal(viewOfRoute(parseHash('#/course/%E6%95%B0%E5%AD%A6/graph')), 'courses.course', '百分号编码 id 可解码')
  assert.equal(parseHash('#/course/%E6%95%B0%E5%AD%A6/graph').courseId, '数学', '解码后的课程 id')
  assert.deepEqual(parseHash('#/course'), { zone: 'courses', sub: 'home', courseId: null, wb: DEFAULT_WORKBENCH_SUB },
    '无 id 的 #/course 回落我的课程（无参不成工作台）')
  assert.equal(parseHash('#/course/数学/nope').wb, DEFAULT_WORKBENCH_SUB, '非法分栏回落首屏')
  assert.equal(parseHash('#/course/数学/queue/extra').wb, 'queue', '多余段忽略（参数段之后的扩展位仍留形不实现）')
  assert.deepEqual(parseHash('#projects'), { zone: 'projects', sub: null, courseId: null, wb: DEFAULT_WORKBENCH_SUB }, '宽容无斜杠形')
})

test('DEFAULT_VIEW/DEFAULT_ZONE 在表内；视图↔路由↔区三向投影恒等（工作台视图键免 hash 往返）', () => {
  assert.ok(VIEW_KEYS.includes(DEFAULT_VIEW))
  assert.ok(ZONE_KEYS.includes(DEFAULT_ZONE))
  for (const v of VIEW_KEYS) {
    const r = routeOfView(v)
    assert.equal(viewOfRoute(r), v, `视图键 ${v} 经路由往返应恒等`)
    assert.ok(ZONE_KEYS.includes(zoneOfView(v)), `${v} 的区必须在区表内`)
    if (v !== 'courses.course') {
      // 参数化工作台视图键没有单一 hash 形（#/course/<id>/<wb>），免 hash 往返；
      // 其余视图键 hash 解析应与 routeOfView 一致
      const h = `#/${v.replace('.', '/')}`
      assert.deepEqual(parseHash(h), r, `hash ${h} 解析应与 routeOfView 一致`)
    }
  }
  const zonesCovered = new Set(VIEW_KEYS.map(zoneOfView))
  for (const z of ZONE_KEYS) assert.ok(zonesCovered.has(z), `区 ${z} 没有任何视图键（不可达区）`)
})

// ---- navigate / navigateCourse / onRouteChange / syncHash：薄绑定 ----

test('navigate 写 URL 权威；全非参数化视图往返恒等（URL 方案 = 扩展契约）', () => {
  for (const v of VIEW_KEYS) {
    if (v === 'courses.course') continue // 参数段视图走 navigateCourse
    navigate(v)
    assert.equal(viewOfRoute(parseHash(readHash())), v, `navigate(${v}) 后解析应回到同视图`)
  }
})

test('navigateCourse 写完整参数段；hashchange 回灌视图与分栏', () => {
  const seen: string[] = []
  const off = onRouteChange(v => { seen.push(v) })
  navigateCourse('数学', 'coach')
  assert.equal(readHash(), '#/course/%E6%95%B0%E5%AD%A6/coach', 'id 经 encodeURIComponent')
  fire('hashchange')
  assert.deepEqual(seen, ['courses.course'], '工作台视图键回灌')
  hash = '#/course/数学/bank'; fire('hashchange')
  assert.deepEqual(seen, ['courses.course', 'courses.course'], '分栏切换仍是同一视图键（保活口径）')
  hash = '#/insight'; fire('hashchange')
  assert.deepEqual(seen, ['courses.course', 'courses.course', 'insight'])
  off()
  hash = '#/projects'; fire('hashchange')
  assert.equal(seen.length, 3, '退订后仍回调 = 泄漏')
})

test('onRouteChange：hashchange 回灌解析后的视图；退订后不再回调', () => {
  const seen: string[] = []
  const off = onRouteChange(v => { seen.push(v) })
  hash = '#/insight'; fire('hashchange')
  assert.deepEqual(seen, ['insight'])
  hash = '#/proposals'; fire('hashchange')
  assert.deepEqual(seen, ['insight', 'courses.proposals'], '#/proposals 全局面规范形回灌')
  off()
  hash = '#/projects'; fire('hashchange')
  assert.equal(seen.length, 2, '退订后仍回调 = 泄漏')
})

test('syncHash：一致不写；漂移/空 hash/旧键经 replaceState 规范化（无历史条目路径）', () => {
  hash = '#/insight'
  replaceCalls.length = 0
  syncHash('insight')
  assert.equal(replaceCalls.length, 0, 'hash 与视图一致时不得写 URL')
  syncHash('courses.queue')
  assert.deepEqual(replaceCalls, ['#/courses/queue'])
  assert.equal(readHash(), '#/courses/queue')
  hash = '#/learn'
  syncHash(DEFAULT_VIEW)
  assert.deepEqual(replaceCalls, ['#/courses/queue', `#/${DEFAULT_VIEW}`],
    '旧键 hash 应规范化成默认视图规范形（URL 不留非法形）')
  // 工作台视图键按解析后的视图口径比对：参数段 hash 不是漂移
  hash = '#/course/数学/graph'
  replaceCalls.length = 0
  syncHash('courses.course')
  assert.equal(replaceCalls.length, 0, '参数段 hash 与工作台视图一致时不写 URL（参数段保留）')
})

// ---- active-tab 桥接（#189 票面取舍：桥接，初始值从路由解析）----

test('active-tab 桥接：初始激活值从路由解析——深链视图首挂载 beat 不落假窗', async () => {
  hash = '#/course/数学/graph'
  const at = await import('../ui/src/active-tab.ts')
  assert.equal(at.isActiveTab('courses.course'), true, '模块初始值须等于路由解析结果（否则深链首次取数被门拦掉）')
  assert.equal(at.isActiveTab('today'), false)
  // App 镜像写同值：守卫拦住不广播；写真变化：广播 learnhub:tab，onTabActive 命中才触发
  const fired: string[] = []
  at.onTabActive('today', () => { fired.push('today') })
  at.setActiveTab('courses.course')
  assert.deepEqual(fired, [], '同值镜像不得广播（否则挂载期多余重取）')
  at.setActiveTab('today')
  assert.deepEqual(fired, ['today'])
})

// ---- 路由表完整性门（Exhibit A；#209 按三入口+参数段工作台重建）----

export interface RouteTables {
  zoneKeys: readonly string[]
  viewKeys: readonly string[]
  courseSubs: readonly string[]
  workbenchSubs: readonly string[]
  /** 壳顶栏的区页签键（ShellTopBar 字面量 TabPane）。 */
  zonePanes: string[]
  /** 课程区子导航项键（ShellTopBar 字面量项表，顺序 = 可见序）。 */
  subItems: string[]
  /** 工作台分栏项键（WorkbenchPage 字面量项表，顺序 = 可见序）。 */
  workbenchItems: string[]
  /** 保活容器的视图分支键（ZoneBody 字面量分支）。 */
  branches: string[]
}

/** 门本体：区页签表／子导航项表／工作台分栏项表／保活分支表与路由表对账 +
 * 跨表投影（每区至少一个视图、子导航 ↔ courses.* 三入口一一对应、分栏项 ↔
 * WORKBENCH_SUBS 一一对应）。返回违约清单，空 = 绿。 */
export function routeTableViolations(t: RouteTables): string[] {
  const v: string[] = []
  for (const z of t.zoneKeys) {
    if (!t.zonePanes.includes(z)) v.push(`区键 ${z} 没有对应顶栏页签（区不可见）`)
    if (!t.viewKeys.some(k => (k.split('.')[0] ?? k) === z)) v.push(`区键 ${z} 没有任何视图分支（点击渲染空白——Exhibit A 形态）`)
  }
  for (const p of t.zonePanes) {
    if (!t.zoneKeys.includes(p)) v.push(`顶栏页签 key='${p}' 不在区表（URL 无法直达该区）`)
  }
  for (const s of t.courseSubs) {
    if (!t.subItems.includes(s)) v.push(`子路由 ${s} 没有对应子导航项（入口不可见）`)
    if (s !== 'home' && !t.viewKeys.includes(`courses.${s}`)) v.push(`子路由 ${s} 没有对应视图分支（点击渲染空白——Exhibit A 形态）`)
  }
  for (const s of t.subItems) {
    if (!t.courseSubs.includes(s)) v.push(`子导航项 '${s}' 不在子路由表（URL 无法直达该入口）`)
  }
  if (t.subItems.length === t.courseSubs.length
    && t.subItems.some((s, i) => s !== t.courseSubs[i])) {
    v.push('子导航项顺序与子路由表不一致（可见序漂移）')
  }
  for (const s of t.workbenchSubs) {
    if (!t.workbenchItems.includes(s)) v.push(`工作台分栏 ${s} 没有对应分栏项（入口不可见）`)
  }
  for (const s of t.workbenchItems) {
    if (!t.workbenchSubs.includes(s)) v.push(`工作台分栏项 '${s}' 不在分栏表（URL 无法直达该入口）`)
  }
  if (t.workbenchItems.length === t.workbenchSubs.length
    && t.workbenchItems.some((s, i) => s !== t.workbenchSubs[i])) {
    v.push('工作台分栏项顺序与分栏表不一致（可见序漂移）')
  }
  for (const k of t.viewKeys) {
    if (!t.branches.includes(k)) v.push(`视图键 ${k} 没有对应保活分支（点击渲染空白——Exhibit A 形态）`)
  }
  for (const b of t.branches) {
    if (!t.viewKeys.includes(b)) v.push(`保活分支 '${b}' 不在视图表（不可达渲染）`)
  }
  const dup = t.branches.filter((b, i) => t.branches.indexOf(b) !== i)
  if (dup.length) v.push(`保活分支重复：${dup.join(', ')}`)
  return v
}

const readUiSrc = (...segs: string[]): string => readFileSync(join(ROOT, 'ui', 'src', ...segs), 'utf8')

const realTables = (): RouteTables => {
  const topBar = readUiSrc('components', 'ShellTopBar.tsx')
  const zoneBody = readUiSrc('components', 'ZoneBody.tsx')
  const workbench = readUiSrc('pages', 'WorkbenchPage', 'index.tsx')
  return {
    zoneKeys: ZONE_KEYS,
    viewKeys: VIEW_KEYS,
    courseSubs: COURSE_SUBS,
    workbenchSubs: WORKBENCH_SUBS,
    zonePanes: [...topBar.matchAll(/<Tabs\.TabPane key='([a-z]+)'/g)].map(m => m[1]!),
    subItems: [...topBar.matchAll(/key: '([a-z]+)', title: '/g)].map(m => m[1]!),
    workbenchItems: [...workbench.matchAll(/key: '([a-z]+)', title: '/g)].map(m => m[1]!),
    branches: [...zoneBody.matchAll(/k === '([a-z.]+)'/g)].map(m => m[1]!),
  }
}

test('路由表完整性门：区页签 / 子导航项 / 工作台分栏项 / 保活分支与路由各表一致', () => {
  assert.deepEqual(routeTableViolations(realTables()), [])
})

test('门自检：缺区键 / 幽灵页签 / 缺保活分支 / 缺子导航项 / 缺分栏项都必须被抓到（ADR-0047）', () => {
  const base = realTables()
  // 提取正则失效 = 门恒过：真实文件提取的四个面必须与路由表等长
  assert.ok(base.zonePanes.length === ZONE_KEYS.length, '区页签提取数与区表不符——提取正则可能已失效')
  assert.ok(base.branches.length === VIEW_KEYS.length, '分支提取数与视图表不符——提取正则可能已失效')
  assert.ok(base.subItems.length === COURSE_SUBS.length, '子导航项提取数与子路由表不符——提取正则可能已失效')
  assert.ok(base.workbenchItems.length === WORKBENCH_SUBS.length, '工作台分栏项提取数与分栏表不符——提取正则可能已失效')
  // Exhibit A 实态回放：区表缺一项（页签与分支都在）→ 违约
  const missingZone = routeTableViolations({ ...base, zoneKeys: ZONE_KEYS.filter(z => z !== 'projects') })
  assert.ok(missingZone.some(x => x.includes('projects') && x.includes('不在区表')), `缺区键表项未被抓到：${missingZone}`)
  // 幽灵顶栏页签：键在 pane 表、不在区表
  const ghost = routeTableViolations({ ...base, zonePanes: base.zonePanes.map(p => (p === 'today' ? 'ghost' : p)) })
  assert.ok(ghost.some(x => x.includes('ghost')), '幽灵页签未被抓到')
  // 缺保活分支：分支表删一项
  const noBranch = routeTableViolations({ ...base, branches: base.branches.filter(b => b !== 'insight') })
  assert.ok(noBranch.some(x => x.includes('insight') && x.includes('分支')), '缺保活分支未被抓到')
  // 缺子导航项 + 顺序漂移
  const noSub = routeTableViolations({ ...base, subItems: base.subItems.filter(s => s !== 'queue') })
  assert.ok(noSub.some(x => x.includes('queue') && x.includes('子导航')), '缺子导航项未被抓到')
  const reordered = routeTableViolations({ ...base, subItems: [...base.subItems].reverse() })
  assert.ok(reordered.some(x => x.includes('顺序')), '子导航顺序漂移未被抓到')
  // 缺工作台分栏项
  const noWb = routeTableViolations({ ...base, workbenchItems: base.workbenchItems.filter(s => s !== 'coach') })
  assert.ok(noWb.some(x => x.includes('coach') && x.includes('分栏')), '缺工作台分栏项未被抓到')
})
