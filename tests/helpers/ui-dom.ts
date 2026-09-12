/**
 * L3 组件交互测试的环境缝（#188 / #187 决议·ADR-0051 第二层许可）：
 * happy-dom 模拟 DOM + @testing-library/react 渲染与查询，挂在既有 node:test
 * runner 上——不引第二个 runner、不建第二套配置面，DOM 环境在本模块（被测试
 * 文件导入）内注册 global，全 ui 面共享一份注册逻辑。
 *
 * 实例一致性（关键约束）：react / react-dom / @testing-library/* 一律经
 * `createRequire(ui/package.json)` 取自 ui 依赖树——hooks 的 dispatcher 对
 * react 实例敏感，被测组件与测试工具必须同实例（L2 同款做法）。
 * .tsx 加载复用 tests/helpers/tsx-loader.mjs（L2 同款内存转译，零构建步骤）。
 *
 * fetch 桩：ui/src/api.ts 调用全局 fetch（相对路径 `/learnhub/api/*`），本模块
 * 把它拦到测试自备的路由表——页面 → api.ts → fetch 全链路真实，只有网络是假的。
 * 未登记路由返回 404（ApiError），页面按缝级三态显式失败——次要数据失败不翻页
 * 正是该缝的承诺，桩不需要为每个次要端点备数据。
 *
 * RTL 自动清理依赖全局 afterEach（node:test 没有全局钩子），清理由测试文件用
 * `t.after(cleanup)` 显式做。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// .tsx 内存转译（L2 同款）——必须在任何 ui/src 动态导入之前 register
register(new URL('./tsx-loader.mjs', import.meta.url))

// ---- DOM 环境（happy-dom，实例 = ui devDep） ----
// happy-dom 的 Window 自带 matchMedia/localStorage/requestAnimationFrame，
// 只把测试面需要的 global 抄到 globalThis（不整体替换——保留 Node 的
// fetch/console/timers 等；fetch 随后被桩接管）。
const uiRequire = createRequire(new URL('../../ui/package.json', import.meta.url))
export { uiRequire }
/** ui 依赖树里的包动态导入（react/arco/@testing-library 一律走这里——同实例约束）。 */
export const uiImport = async (name: string): Promise<AnyRecord> =>
  import(new URL('file://' + uiRequire.resolve(name).replaceAll('\\', '/')).href)
const { Window } = uiRequire('happy-dom')
const win = new Window({ url: 'http://localhost/' })

const g = globalThis as unknown as Record<string, unknown>
g.window = win
g.document = win.document
// Node ≥21 自带只读 getter 的 navigator，须 defineProperty 覆写
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
for (const k of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'SVGElement',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'InputEvent', 'UIEvent',
  'AnimationEvent', 'TransitionEvent', 'MutationObserver', 'getComputedStyle'] as const) {
  g[k] = (win as unknown as Record<string, unknown>)[k]
}
g.getComputedStyle = (win as unknown as { getComputedStyle: unknown }).getComputedStyle.bind(win)
// React 18 act 环境标志：RTL 的 act 包装会设，这里显式置真免依赖其内部行为
g.IS_REACT_ACT_ENVIRONMENT = true

// ---- 工具（ui 依赖树同一实例，动态导入在 global 就绪之后） ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>
const rtl = await uiImport('@testing-library/react') as {
  render: AnyRecord; screen: AnyRecord; fireEvent: AnyRecord; act: AnyRecord
  cleanup: () => void; waitFor: AnyRecord; within: AnyRecord
}
export const render = rtl.render as (ui: unknown, opts?: unknown) => AnyRecord
export const screen = rtl.screen as AnyRecord
export const fireEvent = rtl.fireEvent as AnyRecord
export const act = rtl.act as (fn: () => unknown) => Promise<void>
export const waitFor = rtl.waitFor as (fn: () => void, opts?: unknown) => Promise<void>
export const cleanup = rtl.cleanup as () => void

/** arco Message/Modal 的全局单例（轻提示清理用；页面 import 的是同一实例）。 */
export const arco = uiRequire('@arco-design/web-react') as { Message: { clear: () => void } }

/** ui/src 模块动态导入（tsx-loader 已 register；须带文件扩展名）。 */
export const importUi = async (rel: string): Promise<AnyRecord> =>
  import(new URL(`../../ui/src/${rel}`, import.meta.url).href)

// ---- fetch 桩（api.ts 的全局 fetch → 测试路由表） ----

export interface StubCall { method: string; path: string; body: unknown }

const stubState: { routes: Map<string, { status: number; json: unknown }>; calls: StubCall[] } = {
  routes: new Map(), calls: [],
}

/** 登记本测试的路由表：键 = `'GET /xp'`，值 = 响应 JSON。每次调用整体替换。 */
export function routes(table: Record<string, unknown>): void {
  stubState.routes = new Map(Object.entries(table).map(([k, json]) => [k, { status: 200, json }]))
  stubState.calls = []
}

/** 本测试内被桩接住的请求（按到达序）。 */
export function stubCalls(): StubCall[] {
  return stubState.calls
}

const stubFetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
  const method = (init?.method ?? 'GET').toUpperCase()
  const path = url.match(/\/learnhub\/api([^?]*)/)?.[1] ?? url
  let body: unknown = undefined
  if (typeof init?.body === 'string') { try { body = JSON.parse(init.body) } catch { body = init.body } }
  stubState.calls.push({ method, path, body })
  const hit = stubState.routes.get(`${method} ${path}`)
  const status = hit?.status ?? 404
  const json = hit?.json ?? { error: `测试桩未登记路由：${method} ${path}` }
  return { ok: status >= 200 && status < 300, status, json: async () => json } as Response
}) as typeof fetch
globalThis.fetch = stubFetch

// ---- AppFrame 替身：记录跳转调用（行为断言面） ----

export function spyFrame(opts: { tree?: unknown } = {}) {
  const calls: Record<string, unknown[][]> = {}
  const rec = (k: string) => (...args: unknown[]) => { (calls[k] ??= []).push(args) }
  return {
    frame: {
      status: null, tree: opts.tree ?? null, course: null, lesson: null, focusNode: null,
      setCourse: rec('setCourse'), goto: rec('goto'), openLesson: rec('openLesson'),
      closeLesson: rec('closeLesson'), locateInGraph: rec('locateInGraph'),
      reload: async () => {}, loading: false,
    },
    calls,
  }
}
