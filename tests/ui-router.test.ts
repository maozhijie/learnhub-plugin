/** 极简 hash 路由缝单测（L1，#189 / ADR-0052）：parseHash／navigate／syncHash／
 * onRouteChange 的口径（含非法 hash 回落默认页签）、active-tab 轮询门与路由的桥接
 * （初始值从路由解析——#189 票面取舍）、页签表完整性门（Exhibit A：#158 漏 TAB_KEYS
 * 键项致修复从未生效——TabPane 键／TabBody 保活分支／路由表三表对账，带 ADR-0047 自检）。
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
const { DEFAULT_TAB, TAB_KEYS, navigate, onRouteChange, parseHash, readHash, syncHash } = router

// ---- parseHash：URL 文法 ----

test('parseHash：合法页签键解析；非法/缺省回落默认页签', () => {
  for (const k of TAB_KEYS) assert.equal(parseHash(`#/${k}`), k, `#/${k} 应解析为 ${k}`)
  assert.equal(parseHash(''), DEFAULT_TAB, '空 hash（首次打开）回落默认页签')
  assert.equal(parseHash('#'), DEFAULT_TAB)
  assert.equal(parseHash('#/'), DEFAULT_TAB)
  assert.equal(parseHash('#/nope'), DEFAULT_TAB, '非法键回落默认页签')
})

test('parseHash：参数段留形不实现（首段取键、多余段忽略）+ 宽容无斜杠形', () => {
  assert.equal(parseHash('#/graph/course/x/node/y'), 'graph', 'course/node 参数段是将来扩展位，v1 忽略')
  assert.equal(parseHash('#graph'), 'graph')
})

test('DEFAULT_TAB 必须在页签表内（路由回落目标可达）', () => {
  assert.ok(TAB_KEYS.includes(DEFAULT_TAB))
})

// ---- navigate / onRouteChange / syncHash：薄绑定 ----

test('navigate 写 URL 权威；全页签往返恒等（URL 方案 = 扩展契约）', () => {
  for (const k of TAB_KEYS) {
    navigate(k)
    assert.equal(readHash(), `#/${k}`)
    assert.equal(parseHash(readHash()), k)
  }
})

test('onRouteChange：hashchange 回灌解析后的页签；退订后不再回调', () => {
  const seen: string[] = []
  const off = onRouteChange(t => { seen.push(t) })
  hash = '#/stats'; fire('hashchange')
  assert.deepEqual(seen, ['stats'])
  off()
  hash = '#/bank'; fire('hashchange')
  assert.equal(seen.length, 1, '退订后仍回调 = 泄漏')
})

test('syncHash：一致不写；漂移/空 hash 经 replaceState 规范化（非 navigate，无历史条目路径）', () => {
  hash = '#/stats'
  replaceCalls.length = 0
  syncHash('stats')
  assert.equal(replaceCalls.length, 0, 'hash 与页签一致时不得写 URL')
  syncHash('graph')
  assert.deepEqual(replaceCalls, ['#/graph'])
  assert.equal(readHash(), '#/graph')
  hash = ''
  syncHash(DEFAULT_TAB)
  assert.deepEqual(replaceCalls, ['#/graph', `#/${DEFAULT_TAB}`], '初始空 hash 应规范化成规范形')
})

// ---- active-tab 桥接（#189 票面取舍：桥接，初始值从路由解析）----

test('active-tab 桥接：初始激活值从路由解析——深链页签首挂载 beat 不落假窗', async () => {
  hash = '#/graph'
  const at = await import('../ui/src/active-tab.ts')
  assert.equal(at.isActiveTab('graph'), true, '模块初始值须等于路由解析结果（否则深链首次取数被门拦掉）')
  assert.equal(at.isActiveTab('learn'), false)
  // App 镜像写同值：守卫拦住不广播；写真变化：广播 learnhub:tab，onTabActive 命中才触发
  const fired: string[] = []
  at.onTabActive('learn', () => { fired.push('learn') })
  at.setActiveTab('graph')
  assert.deepEqual(fired, [], '同值镜像不得广播（否则挂载期多余重取）')
  at.setActiveTab('learn')
  assert.deepEqual(fired, ['learn'])
})

// ---- 页签表完整性门（Exhibit A）----

/** 门本体：TabPane 键（用户可见页签）／TabBody 保活分支（渲染表）／路由 TAB_KEYS（URL
 * 合法键集）三表对账。返回违约清单，空 = 绿。 */
export function tabTableViolations(appText: string, tabKeys: readonly string[]): string[] {
  const panes = [...appText.matchAll(/<Tabs\.TabPane key='([a-z]+)'/g)].map(m => m[1]!)
  const branches = [...appText.matchAll(/k === '([a-z]+)'/g)].map(m => m[1]!)
  const violations: string[] = []
  for (const k of tabKeys) {
    if (!panes.includes(k)) violations.push(`TAB_KEYS 键 ${k} 没有对应 TabPane（页签不可见）`)
    if (!branches.includes(k)) violations.push(`TAB_KEYS 键 ${k} 没有对应 TabBody 分支（点击渲染空白——Exhibit A 形态）`)
  }
  for (const p of panes) {
    if (!tabKeys.includes(p)) violations.push(`TabPane key='${p}' 不在 TAB_KEYS（URL 无法直达该页签）`)
  }
  for (const b of branches) {
    if (!tabKeys.includes(b)) violations.push(`TabBody 分支 '${b}' 不在 TAB_KEYS（不可达渲染）`)
  }
  const dup = branches.filter((b, i) => branches.indexOf(b) !== i)
  if (dup.length) violations.push(`TabBody 分支重复：${dup.join(', ')}`)
  return violations
}

test('页签表完整性门：TabPane 键 / TabBody 分支 / 路由 TAB_KEYS 三表一致', () => {
  const appText = readFileSync(join(ROOT, 'ui', 'src', 'App.tsx'), 'utf8')
  assert.deepEqual(tabTableViolations(appText, TAB_KEYS), [])
})

test('门自检：缺键表项 / 幽灵 TabPane / 缺保活分支都必须被抓到（ADR-0047）', () => {
  const appText = readFileSync(join(ROOT, 'ui', 'src', 'App.tsx'), 'utf8')
  // Exhibit A 实态回放：TabPane 与分支都在、键表缺一项 → 两处违约
  const missingKey = tabTableViolations(appText, TAB_KEYS.filter(k => k !== 'projects'))
  assert.ok(missingKey.filter(v => v.includes('projects')).length === 2, `缺键表项未被抓到：${missingKey}`)
  // 幽灵 TabPane：键在 pane 表、不在 TAB_KEYS
  const ghost = tabTableViolations(appText.replace("key='guide'", "key='ghost'"), TAB_KEYS)
  assert.ok(ghost.some(v => v.includes('ghost')), '幽灵 TabPane 未被抓到')
  // 缺保活分支：TabBody 分支被删
  const noBranch = tabTableViolations(appText.replace("k === 'guide' && <GuidePage />", ''), TAB_KEYS)
  assert.ok(noBranch.some(v => v.includes('guide') && v.includes('分支')), '缺保活分支未被抓到')
})
