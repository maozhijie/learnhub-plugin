/**
 * 路由探针驱动（#168：路由表数据化的回归网）。
 *
 * 把「表项清单 + 每条路由触达的参数键」变成确定性的 HTTP 探针，跑一遍 handleApi，
 * 记录 {status, res, 引擎调用}。快照由**重构前**（if 链实现）捕获
 * （tests/fixtures/host-routes-snapshot.json），重构后必须逐字复现——这就是
 * 「120 条路由的方法／路径／响应形状逐字不变」与「参数守卫错误消息逐字不变」的证据，
 * 而不是靠通读一遍代码相信它没变。
 *
 * 确定性来自三处：
 *   ① 每次探针一个**全新 runtime**（HostRuntime 显式对象的直接收益，ADR-0048）——
 *      探针之间零状态污染、零时序耦合；共享一个 vault 目录只为省 mkdtemp，引擎方法
 *      全被影子化，vault 内容不参与任何判定。
 *   ② 引擎方法影子化为「记录调用 + 返回空数组哨兵」的 Promise；假 ctx 不带 llm，
 *      LLM 路径因此 fail loud 成确定性的 500——不碰网络、不碰真实模型。
 *   ③ 响应写出（`res.end`）即冻结：之后的 fire-and-forget（教练触点、队列泵）不入快照
 *      （它们由 jobs 侧测试覆盖；这里只要「响应前的调用序列」这一份确定性切片）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { LearnhubEngine } from '../../src/engine/index.ts'
import { createHostRuntime } from '../../src/host/runtime.ts'
import type { HostRuntime } from '../../src/host/runtime.ts'
import { handleApi } from '../../src/host/api.ts'

/** 对账清单里的一条路由：方法 + 前缀后的路径 + 该路由触达的参数键（由重构前源码实测）。 */
export interface RouteEntry {
  method: 'GET' | 'POST' | 'PUT'
  route: string
  /** true = 前缀路由（今天唯一一条：GET /vendor/）。 */
  prefix?: boolean
  /** 该路由读过的参数键（body.x / need(body,'x') / searchParams.get('x')），顺序即源码顺序。 */
  keys: string[]
}

/** 一条探针请求：id 是快照的身份（method + path + 变体名）。 */
export interface ProbeSpec {
  id: string
  method: string
  /** 含查询串的完整 URL（含 /learnhub/api 前缀）。 */
  url: string
  /** POST/PUT 的 JSON 体；GET 无体。 */
  body?: Record<string, unknown>
}

export interface ProbeResult {
  status: number
  res: unknown
  /** 响应写出前的引擎调用序列（`方法(JSON.stringify 后的实参)`）。 */
  calls: string[]
}

/** 引擎哨兵：空数组——`.map/.filter/.length` 可当列表用、`JSON.stringify` 稳定。 */
const SENTINEL: unknown[] = []

let sharedVault: string | undefined

/** 探针共用的临时 vault（省掉每条探针一次 mkdtemp；引擎不读它，见头注释 ①）。 */
function probeVault(): string {
  if (!sharedVault) {
    sharedVault = mkdtempSync(join(tmpdir(), 'learnhub-route-probe-')).replace(/\\/g, '/')
    mkdirSync(join(sharedVault, '学习中心'), { recursive: true })
  }
  return sharedVault
}

/** 探针结束后的清理（临时 vault 只有 runLog 写过，整目录删掉即可）。 */
export function cleanupProbeVault(): void {
  if (sharedVault) rmSync(sharedVault, { recursive: true, force: true })
  sharedVault = undefined
}

/**
 * 把录制到的调用摘成**可复现**的形状：临时 vault 路径与 ISO 时刻都是进程级噪音
 * （mkdtemp 随机后缀、`new Date()`），换成占位符——快照只该钉行为，不该钉机器与时钟。
 */
function scrub(call: string): string {
  return call.split(probeVault()).join('«vault»').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, '«ts»')
}

/** 假宿主 ctx（与 host-runtime.test.ts 同款）：无 llm —— LLM 路径确定性 fail loud。 */
function fakeCtx(): Context {
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
  } as unknown as Context
}

/**
 * 把引擎门面的全部原型方法影子化为录制替身（存取器与子系统句柄原样保留：
 * `paths.centerStateDir` 被 runLog 读、必须是真的路径）。
 * 返回的 `stop()` 之后不再记录——响应写出即冻结（头注释 ③）。
 */
function shadowEngine(rt: HostRuntime): { calls: string[]; stop: () => void } {
  const calls: string[] = []
  let recording = true
  const record = (label: string, args: unknown[]) => {
    if (recording) {
      calls.push(scrub(`${label}(${args.map(a => JSON.stringify(a) ?? String(a)).join(',')})`))
    }
    return Promise.resolve(SENTINEL)
  }
  // hub 装配域方法（裸名）：覆盖在门面实例上
  const proto = LearnhubEngine.prototype as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (typeof desc?.value !== 'function') continue
    ;(rt.engine as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => record(name, args)
  }
  // 子系统方法（C 形态，ADR-0049）：覆盖在子系统实例上，探针记名走 <子系统>.<方法>
  const engine = rt.engine as unknown as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(engine)) {
    const sub = engine[key]
    if (sub === null || typeof sub !== 'object') continue
    const subProto = Object.getPrototypeOf(sub) as Record<string, unknown> | null
    if (!subProto || subProto === Object.prototype) continue
    for (const name of Object.getOwnPropertyNames(subProto)) {
      if (name === 'constructor') continue
      const desc = Object.getOwnPropertyDescriptor(subProto, name)
      if (typeof desc?.value !== 'function') continue
      ;(sub as Record<string, unknown>)[name] = (...args: unknown[]) => record(`${key}.${name}`, args)
    }
  }
  return { calls, stop: () => { recording = false } }
}

/** 假 req：GET 只需 method/url；POST/PUT 需异步可迭代体（readJson 消费）。 */
function fakeReq(spec: ProbeSpec): IncomingMessage {
  if (spec.method === 'GET') return { method: 'GET', url: spec.url } as unknown as IncomingMessage
  return {
    method: spec.method, url: spec.url,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(spec.body ?? {})) },
  } as unknown as IncomingMessage
}

/** 跑一条探针：全新 runtime + 录制式引擎 + 假 req/res。 */
export async function runProbe(spec: ProbeSpec): Promise<ProbeResult> {
  const rt = createHostRuntime(fakeCtx(), { vault: probeVault(), centerRel: '学习中心' })
  const recorder = shadowEngine(rt)
  const out = { status: 0, res: undefined as unknown }
  const res = {
    writeHead: (code: number) => { out.status = code },
    end: (data?: unknown) => {
      recorder.stop()
      const text = data === undefined ? '' : String(data)
      try { out.res = text ? JSON.parse(text) : null } catch { out.res = text }
    },
  } as unknown as ServerResponse
  await handleApi(rt, fakeCtx(), fakeReq(spec), res)
  return { status: out.status, res: out.res, calls: recorder.calls }
}

/** 顺序跑一批探针（保持顺序：探针之间本无耦合，但顺序固定让快照 diff 可读）。 */
export async function runProbes(specs: ProbeSpec[]): Promise<ProbeResult[]> {
  const out: ProbeResult[] = []
  for (const spec of specs) out.push(await runProbe(spec))
  return out
}
