/**
 * 面板路由表（#168 / ADR-0045／ADR-0048）：数据化后的表、分发纪律与**行为不变量**。
 *
 * 三件事：
 *   ① **对账清单**：代码里的表项集合必须与重构前（if 链）实测的清单逐条一致
 *      （tests/fixtures/host-routes-baseline.json，125 条 = GET 46 + POST 73 + PUT 6）。
 *   ② **行为快照**：464 条探针（每条路由 × 空参／全参／逐个缺参，外加分发纪律样本）
 *      逐字复现重构前捕获的 `{status, res, 引擎调用}`（tests/fixtures/host-routes-snapshot.json）。
 *      这是「120 条路由的方法／路径／响应形状逐字不变」与「参数守卫错误消息逐字不变」
 *      的证据，不是通读一遍代码后的相信。
 *   ③ **守卫收口**：`typeof body.x` 手写守卫与内联 `missing required field:` 清零
 *      （语义都进 params.ts），sendJson 状态码分布保持 200×122／404×4／500×1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API, handleApi, matchRoute, routes } from '../src/host/api.ts'
import { cleanupProbeVault, runProbes } from './helpers/routes-probe.ts'
import type { ProbeSpec } from './helpers/routes-probe.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const json = <T>(rel: string) => JSON.parse(read(rel)) as T

const BASELINE = json<Array<{ method: string; route: string; prefix?: boolean; keys: string[] }>>('tests/fixtures/host-routes-baseline.json')
const SNAPSHOT = json<Array<ProbeSpec & { status: number; res: unknown; calls: string[] }>>('tests/fixtures/host-routes-snapshot.json')

/** 宿主技术层里承载路由面的文件（状态码分布与守卫收口的扫描面）。 */
const HOST_DIR = 'src/host'
const hostFiles = () => readdirSync(join(ROOT, HOST_DIR)).filter(f => f.endsWith('.ts')).sort()

// ---------------------------------------------------------------- ① 表与对账清单

test('路由表：125 条表项 / 120 条不同精确路径，方法三段齐备（GET 46+POST 73+PUT 6）', () => {
  assert.equal(routes.length, 125)
  assert.equal(new Set(routes.map(r => `${r.method} ${r.route}`)).size, 125, '表项 (method, route) 必须唯一')
  assert.equal(new Set(routes.filter(r => !r.prefix).map(r => r.route)).size, 120,
    '不同精确路径 120 条（/jol、/sleep、/calibration/hints、/project/log 四个路径各挂两条方法）')
  assert.deepEqual(
    routes.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.method]: (acc[r.method] ?? 0) + 1 }), {}),
    { GET: 46, POST: 73, PUT: 6 })
  assert.equal(routes.filter(r => r.prefix).length, 1, '前缀路由今天恰一条（GET /vendor/）')
})

test('路由表：表项形状齐备（method/route/handler + 预留注册表字段位）', () => {
  for (const r of routes) {
    assert.ok(['GET', 'POST', 'PUT'].includes(r.method), `${r.route} 的方法非法：${r.method}`)
    assert.ok(r.route.startsWith('/'), `${r.route} 路径必须以 / 开头`)
    assert.equal(typeof r.handler, 'function', `${r.method} ${r.route} 缺 handler`)
    assert.ok(!r.route.includes('?') && !/\s/.test(r.route), `${r.route} 路径里不该有查询串或空白`)
    assert.deepEqual(Object.keys(r).filter(k => !['method', 'route', 'handler', 'prefix'].includes(k)), [],
      `${r.method} ${r.route} 带了计划外的表项字段（注册表字段位是类型层的位，填值在 #169）`)
  }
  // 注册表字段位是**类型层**的位（可选字段不进运行时对象）：断言形状真的在类型里声明着
  const table = read(`${HOST_DIR}/route-table.ts`)
  assert.match(table, /export interface RegistrySlots \{/, 'route-table.ts 缺注册表字段位的形状')
  for (const slot of ['id', 'summary', 'args', 'engine', 'output', 'channels']) {
    assert.match(table, new RegExp(`^\\s+${slot}\\??:`, 'm'), `RegistrySlots 缺字段位 ${slot}`)
  }
  assert.match(table, /export interface RouteSpec extends RegistrySlots \{/, 'RouteSpec 必须承接字段位')
})

test('对账清单：表项与重构前实测的 125 条逐条一致（无增删改名改方法）', () => {
  const shape = (r: { method: string; route: string; prefix?: boolean }) => `${r.method} ${r.route}${r.prefix ? '（前缀）' : ''}`
  assert.deepEqual(routes.map(shape), BASELINE.map(shape), '表项清单漂移')
})

test('对账清单：每条路由都被快照探针覆盖（快照漏了哪条路由要当场知道）', () => {
  const probed = SNAPSHOT.filter(s => !s.id.includes('方法不匹配') && !s.id.includes('未命中') && !s.id.includes('非三方法'))
    .map(s => `${s.method} ${new URL(s.url, 'http://localhost').pathname.slice(API.length)}`)
  const covered = (e: { method: string; route: string; prefix?: boolean }) =>
    probed.some(p => e.prefix ? p.startsWith(`${e.method} ${e.route}`) : p === `${e.method} ${e.route}`)
  const missing = BASELINE.filter(e => !covered(e)).map(e => `${e.method} ${e.route}`)
  assert.deepEqual(missing, [], '这些路由没有任何探针覆盖')
  // 反向：探针里的每条路由都在清单里（防止清单漏记一条真实路由）
  const known = BASELINE.map(e => `${e.method} ${e.route}`)
  const extra = [...new Set(probed)].filter(p => !known.some(k => p === k || p.startsWith(k)))
  assert.deepEqual(extra, [], '探针里有清单未登记的路由')
})

// ---------------------------------------------------------------- ② 行为快照（逐字不变）

test('行为快照：464 条探针的状态码／响应体／引擎调用序列与重构前逐字一致', async () => {
  const specs: ProbeSpec[] = SNAPSHOT.map(s => ({ id: s.id, method: s.method, url: s.url, ...(s.body ? { body: s.body } : {}) }))
  const got = await runProbes(specs)
  const diffs: string[] = []
  for (let i = 0; i < specs.length; i++) {
    const want = SNAPSHOT[i]
    const now = got[i]
    if (now.status !== want.status || JSON.stringify(now.res) !== JSON.stringify(want.res)
      || JSON.stringify(now.calls) !== JSON.stringify(want.calls)) {
      diffs.push(`  · ${want.id}\n    期望 ${want.status} ${JSON.stringify(want.res).slice(0, 160)} calls=${JSON.stringify(want.calls)}`
        + `\n    实得 ${now.status} ${JSON.stringify(now.res).slice(0, 160)} calls=${JSON.stringify(now.calls)}`)
    }
  }
  assert.deepEqual(diffs, [], `路由行为相对重构前漂移（${diffs.length} 条）：\n${diffs.join('\n')}`)
})

test('行为快照：状态码分布保持 200×222／404×6／500×236（探针口径）', () => {
  const dist = SNAPSHOT.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {})
  assert.deepEqual(dist, { 200: 222, 404: 6, 500: 236 })
})

// ---------------------------------------------------------------- ③ 分发纪律

test('分发纪律：未命中回落 404（方法与剥前缀后的路由名逐字带出）', async () => {
  assert.equal(matchRoute('GET', '/nope'), undefined)
  assert.equal(matchRoute('POST', '/nope'), undefined)
  for (const s of SNAPSHOT.filter(x => x.id.includes('未命中') || x.id.includes('非三方法'))) {
    assert.equal(s.status, 404, `${s.id} 应回落 404`)
    assert.deepEqual(s.res, { error: `unknown route: ${s.method} ${new URL(s.url, 'http://localhost').pathname.slice(API.length)}` })
  }
})

test('分发纪律：方法不匹配 = 404（GET 路由不接 POST/PUT，POST 路由不接 GET）', () => {
  assert.equal(matchRoute('POST', '/status'), undefined, 'GET 路由不被 POST 命中')
  assert.equal(matchRoute('PUT', '/node/pin'), undefined, 'POST 路由不被 PUT 命中')
  assert.equal(matchRoute('GET', '/node/pin'), undefined, 'POST 路由不被 GET 命中')
  // 同路径两条方法的四条路由各自独立命中（/jol、/sleep、/calibration/hints、/project/log）
  assert.equal(matchRoute('GET', '/jol')?.method, 'GET')
  assert.equal(matchRoute('PUT', '/jol')?.method, 'PUT')
  assert.equal(matchRoute('GET', '/project/log')?.method, 'GET')
  assert.equal(matchRoute('POST', '/project/log')?.method, 'POST')
})

test('分发纪律：前缀路由按前缀命中，且 GET 段不读请求体', () => {
  assert.equal(matchRoute('GET', '/vendor/')?.prefix, true)
  assert.equal(matchRoute('GET', '/vendor/katex/katex.min.css')?.prefix, true)
  assert.equal(matchRoute('POST', '/vendor/x')?.prefix, undefined, '前缀项只认声明的方法')
})

test('分发纪律：POST 未命中也要先读体（非法 JSON 是 500 而非 404，与拆分前同序）', async () => {
  // if 链顶部的 readJson 在路由匹配之前执行——顺序搬过来，不趁重构顺手改
  const broken = {
    method: 'POST', url: `${API}/nope`,
    async *[Symbol.asyncIterator]() { yield Buffer.from('{ not json') },
  }
  const rt = { engine: {}, vault: '', centerRel: '', jobs: { genJobs: new Map(), quizJobResults: new Map() }, flags: {} }
  const out = { status: 0, res: undefined as unknown }
  const res = {
    writeHead: (code: number) => { out.status = code },
    end: (data?: unknown) => { out.res = JSON.parse(String(data)) },
  }
  await handleApi(rt as never, {} as never, broken as never, res as never)
  assert.equal(out.status, 500, '读体失败走统一 catch（与拆分前的 500 一致）')
})

// ---------------------------------------------------------------- ④ 守卫收口与状态码分布

test('守卫收口：手写 `typeof body.x` 与内联 `missing required field:` 在宿主面清零', () => {
  const typeofs: string[] = []
  const inlines: string[] = []
  for (const f of hostFiles()) {
    if (f === 'params.ts') continue // params.ts 是守卫语义的家（它当然在用 typeof 与消息模板）
    const rel = `${HOST_DIR}/${f}`
    const text = read(rel)
    const at = (i: number) => `${rel}:${text.slice(0, i).split('\n').length}`
    for (const m of text.matchAll(/typeof body\./g)) typeofs.push(at(m.index))
    for (const m of text.matchAll(/missing(?: required|\/invalid)/g)) inlines.push(at(m.index))
  }
  assert.deepEqual(typeofs, [], '手写 typeof body.x 守卫（语义应收口到 params.ts）')
  assert.deepEqual(inlines, [], '内联守卫消息（应只在 params.ts 里成形）')
  // 语义的唯一出处确实在（不是把守卫删了了事）
  const params = read(`${HOST_DIR}/params.ts`)
  for (const fn of ['need', 'needQuery', 'requireBoolean', 'requireNumber', 'requireString', 'requireObject', 'requireOneOf',
    'optText', 'optTrimmed', 'optRaw', 'optString', 'optNumber', 'optFinite', 'optBoolean', 'optTrue', 'optObject', 'optList', 'pick']) {
    assert.match(params, new RegExp(`export function ${fn}[<(]`), `params.ts 缺 guard ${fn}`)
  }
})

test('守卫收口：必填守卫的消息形状逐字不变（`missing required field: <key>`）', () => {
  const params = read(`${HOST_DIR}/params.ts`)
  assert.match(params, /throw new Error\(`missing required field: \$\{key\}`\)/, '单键消息')
  assert.match(params, /missing required field: \$\{keys\.join\('\/'\)\}/, '多键合并消息（node/qid）')
  assert.match(params, /missing\/invalid required field: \$\{key\}（\$\{allowed\.join\('\|'\)\}）/, '枚举消息（resolution）')
  // 必填守卫的调用点：21 处内联清零后，全部经这几个入口（快照 ③ 已逐字钉住每条消息）
  const routesText = [read(`${HOST_DIR}/routes.ts`), read(`${HOST_DIR}/routes-post.ts`)].join('\n')
  assert.equal([...routesText.matchAll(/missing required field/g)].length, 0, '路由面不得再内联守卫消息')
})

test('状态码分布：sendJson 的 200×122／404×4／500×1 逐字保持', () => {
  const counts: Record<string, number> = {}
  for (const f of hostFiles()) {
    for (const m of read(`${HOST_DIR}/${f}`).matchAll(/sendJson\(res, (\d+)/g)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1
    }
  }
  assert.deepEqual(counts, { 200: 122, 404: 4, 500: 1 }, '状态码分布漂移（404 三处来自 static.ts 的伺服未命中，均经 api.ts 的分发）')
})

test.after(() => { cleanupProbeVault() })
