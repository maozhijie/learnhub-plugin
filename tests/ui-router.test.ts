/** 极简 hash 路由缝单测（L1，#189 / ADR-0052；#205 / ADR-0058 两级路由）：
 * parseHash／navigate／syncHash／onRouteChange 的口径（区键 + 课程子路由两级文法、
 * 非法/缺省/旧键回落默认视图）、active-tab 轮询门与路由的桥接（初始值从路由解析
 * ——#189 票面取舍）、**路由表完整性门**（Exhibit A：#158 漏键表致修复从未生效
 * ——区页签表／课程子导航项／保活分支表与路由三表对账，带 ADR-0047 自检）。
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
  COURSE_SUBS, DEFAULT_COURSE_SUB, DEFAULT_VIEW, DEFAULT_ZONE, VIEW_KEYS, ZONE_KEYS,
  navigate, onRouteChange, parseHash, readHash, routeOfView, syncHash, viewOfRoute, zoneOfView,
} = router

// ---- parseHash：两级 URL 文法 ----

test('parseHash：五区键解析；courses 带子路由段；非法/缺省/旧键回落默认视图', () => {
  for (const z of ZONE_KEYS) {
    assert.deepEqual(parseHash(`#/${z}`), { zone: z, sub: z === 'courses' ? DEFAULT_COURSE_SUB : null },
      `#/${z} 应解析为 ${z} 区`)
  }
  for (const s of COURSE_SUBS) {
    assert.deepEqual(parseHash(`#/courses/${s}`), { zone: 'courses', sub: s }, `#/courses/${s} 应解析出子路由 ${s}`)
  }
  for (const bad of ['', '#', '#/', '#/nope', '#/learn', '#/graph', '#/stats', '#/generate']) {
    assert.deepEqual(parseHash(bad), { zone: DEFAULT_ZONE, sub: null },
      `旧键/非法 hash「${bad || '(空)'}」应回落默认视图（ADR-0058 登记的已知断裂）`)
  }
  assert.deepEqual(parseHash('#/courses/nope'), { zone: 'courses', sub: DEFAULT_COURSE_SUB },
    'courses 非法子路由回落默认子路由')
  assert.deepEqual(parseHash('#/courses/queue/extra'), { zone: 'courses', sub: 'queue' },
    '多余段忽略（参数段之后的扩展位仍留形不实现）')
  assert.deepEqual(parseHash('#projects'), { zone: 'projects', sub: null }, '宽容无斜杠形')
})

test('DEFAULT_VIEW/DEFAULT_ZONE 在表内；视图↔路由↔区三向投影恒等', () => {
  assert.ok(VIEW_KEYS.includes(DEFAULT_VIEW))
  assert.ok(ZONE_KEYS.includes(DEFAULT_ZONE))
  for (const v of VIEW_KEYS) {
    const r = routeOfView(v)
    assert.equal(viewOfRoute(r), v, `视图键 ${v} 经路由往返应恒等`)
    assert.ok(ZONE_KEYS.includes(zoneOfView(v)), `${v} 的区必须在区表内`)
    const h = `#/${v.replace('.', '/')}`
    assert.deepEqual(parseHash(h), r, `hash ${h} 解析应与 routeOfView 一致`)
  }
  const zonesCovered = new Set(VIEW_KEYS.map(zoneOfView))
  for (const z of ZONE_KEYS) assert.ok(zonesCovered.has(z), `区 ${z} 没有任何视图键（不可达区）`)
})

// ---- navigate / onRouteChange / syncHash：薄绑定 ----

test('navigate 写 URL 权威；全视图往返恒等（URL 方案 = 扩展契约）', () => {
  for (const v of VIEW_KEYS) {
    navigate(v)
    assert.equal(readHash(), `#/${v.replace('.', '/')}`)
    assert.deepEqual(parseHash(readHash()), routeOfView(v))
  }
})

test('onRouteChange：hashchange 回灌解析后的视图；退订后不再回调', () => {
  const seen: string[] = []
  const off = onRouteChange(v => { seen.push(v) })
  hash = '#/insight'; fire('hashchange')
  assert.deepEqual(seen, ['insight'])
  hash = '#/courses/bank'; fire('hashchange')
  assert.deepEqual(seen, ['insight', 'courses.bank'])
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
})

// ---- active-tab 桥接（#189 票面取舍：桥接，初始值从路由解析）----

test('active-tab 桥接：初始激活值从路由解析——深链视图首挂载 beat 不落假窗', async () => {
  hash = '#/courses/graph'
  const at = await import('../ui/src/active-tab.ts')
  assert.equal(at.isActiveTab('courses.graph'), true, '模块初始值须等于路由解析结果（否则深链首次取数被门拦掉）')
  assert.equal(at.isActiveTab('today'), false)
  // App 镜像写同值：守卫拦住不广播；写真变化：广播 learnhub:tab，onTabActive 命中才触发
  const fired: string[] = []
  at.onTabActive('today', () => { fired.push('today') })
  at.setActiveTab('courses.graph')
  assert.deepEqual(fired, [], '同值镜像不得广播（否则挂载期多余重取）')
  at.setActiveTab('today')
  assert.deepEqual(fired, ['today'])
})

// ---- 路由表完整性门（Exhibit A；#205 按五区+两级路由重建）----

export interface RouteTables {
  zoneKeys: readonly string[]
  viewKeys: readonly string[]
  courseSubs: readonly string[]
  /** 壳顶栏的区页签键（ShellTopBar 字面量 TabPane）。 */
  zonePanes: string[]
  /** 课程区子导航项键（ShellTopBar 字面量项表，顺序 = 可见序）。 */
  subItems: string[]
  /** 保活容器的视图分支键（ZoneBody 字面量分支）。 */
  branches: string[]
}

/** 门本体：区页签表／子导航项表／保活分支表与路由表（区/视图/子路由）对账 +
 * 跨表投影（每区至少一个视图、子路由 ↔ courses.* 视图一一对应）。返回违约清单，空 = 绿。 */
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
    if (!t.viewKeys.includes(`courses.${s}`)) v.push(`子路由 ${s} 没有对应视图分支（点击渲染空白——Exhibit A 形态）`)
  }
  for (const s of t.subItems) {
    if (!t.courseSubs.includes(s)) v.push(`子导航项 '${s}' 不在子路由表（URL 无法直达该入口）`)
  }
  if (t.subItems.length === t.courseSubs.length
    && t.subItems.some((s, i) => s !== t.courseSubs[i])) {
    v.push('子导航项顺序与子路由表不一致（可见序漂移）')
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
  return {
    zoneKeys: ZONE_KEYS,
    viewKeys: VIEW_KEYS,
    courseSubs: COURSE_SUBS,
    zonePanes: [...topBar.matchAll(/<Tabs\.TabPane key='([a-z]+)'/g)].map(m => m[1]!),
    subItems: [...topBar.matchAll(/key: '([a-z]+)', title: '/g)].map(m => m[1]!),
    branches: [...zoneBody.matchAll(/k === '([a-z.]+)'/g)].map(m => m[1]!),
  }
}

test('路由表完整性门：区页签 / 子导航项 / 保活分支与路由三表一致', () => {
  assert.deepEqual(routeTableViolations(realTables()), [])
})

test('门自检：缺区键 / 幽灵页签 / 缺保活分支 / 缺子导航项都必须被抓到（ADR-0047）', () => {
  const base = realTables()
  // 提取正则失效 = 门恒过：真实文件提取的三个面必须与路由表等长
  assert.ok(base.zonePanes.length === ZONE_KEYS.length, '区页签提取数与区表不符——提取正则可能已失效')
  assert.ok(base.branches.length === VIEW_KEYS.length, '分支提取数与视图表不符——提取正则可能已失效')
  assert.ok(base.subItems.length === COURSE_SUBS.length, '子导航项提取数与子路由表不符——提取正则可能已失效')
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
  const noSub = routeTableViolations({ ...base, subItems: base.subItems.filter(s => s !== 'bank') })
  assert.ok(noSub.some(x => x.includes('bank') && x.includes('子导航')), '缺子导航项未被抓到')
  const reordered = routeTableViolations({ ...base, subItems: [...base.subItems].reverse() })
  assert.ok(reordered.some(x => x.includes('顺序')), '子导航顺序漂移未被抓到')
})
