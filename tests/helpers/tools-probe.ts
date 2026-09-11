/**
 * 工具面探针驱动（#169：注册表切的回归网）。
 *
 * 把 111 个工具变成确定性的调用探针：造 runtime + 影子化引擎（记录调用、返回哨兵），
 * 按工具自己的 `parameters` 造一组参数（全参／逐个缺必填），调用 `execute`，记录
 * `{text, 引擎调用}`。快照由**注册表切面之前**的实现捕获
 * （tests/fixtures/host-tools-behavior.json），切面后必须逐字复现。
 *
 * 确定性同 routes-probe：每次探针一个全新 runtime、录制式引擎替身、vault 与时刻换占位符；
 * 队列型工具（mode=queued）的「响应后」调用序列不入快照（fire-and-forget 的时序噪音），
 * 只比文本——路由面那份快照也做过同样的取舍。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LearnhubEngine } from '../../src/engine/index.ts'
import { createHostRuntime } from '../../src/host/runtime.ts'
import type { HostRuntime } from '../../src/host/runtime.ts'
import { registerTools } from '../../src/host/tools.ts'

/** 一条工具探针：工具名 + 变体（全参／缺某必填）+ 参数。 */
export interface ToolProbe {
  id: string
  tool: string
  args: Record<string, unknown>
  /** 队列型：只比文本（调用序列在响应之后，不钉） */
  queued: boolean
}

export interface ToolResult {
  text: string
  error?: string
  calls: string[]
}

const SENTINEL: unknown[] = []
let sharedVault: string | undefined

function probeVault(): string {
  if (!sharedVault) {
    sharedVault = mkdtempSync(join(tmpdir(), 'learnhub-tool-probe-')).replace(/\\/g, '/')
    mkdirSync(join(sharedVault, '学习中心'), { recursive: true })
  }
  return sharedVault
}

export function cleanupToolProbeVault(): void {
  if (sharedVault) rmSync(sharedVault, { recursive: true, force: true })
  sharedVault = undefined
}

function fakeCtx(captured: unknown[]): Context {
  return {
    tools: { register: (t: unknown) => { captured.push(t); return () => undefined } },
    effect: () => undefined,
    webServer: { register: () => undefined },
  } as unknown as Context
}

function scrub(call: string): string {
  return call.split(probeVault()).join('«vault»').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, '«ts»')
}

function shadowEngine(rt: HostRuntime): { calls: string[]; stop: () => void } {
  const calls: string[] = []
  let recording = true
  const proto = LearnhubEngine.prototype as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (typeof desc?.value !== 'function') continue
    ;(rt.engine as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (recording) calls.push(scrub(`${name}(${args.map(a => JSON.stringify(a) ?? String(a)).join(',')})`))
      return Promise.resolve(SENTINEL)
    }
  }
  return { calls, stop: () => { recording = false } }
}

/** 工具表项的 SDK 形状（只取 adapter 需要的名字；参数 schema 与 output 不参与本探针）。 */
interface CapturedTool {
  name: string
  parameters?: { properties?: Record<string, { type?: string; required?: boolean }>; required?: string[] }
  execute: (args: never) => Promise<unknown>
}

/** 按 `parameters` 造一组参数：必填一律给「非空白字符串」（`need` 与 `Number('1')` 都吃），
 * 数组/对象/布尔/数字按声明类型给合法值。 */
export function argsFor(tool: CapturedTool, drop?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = tool.parameters?.properties ?? {}
  for (const [k, p] of Object.entries(props)) {
    if (k === drop) continue
    switch (p?.type) {
      case 'number': out[k] = 1; break
      case 'boolean': out[k] = true; break
      case 'array': out[k] = ['1']; break
      case 'object': out[k] = { answer: '1' }; break
      default: out[k] = '1'
    }
  }
  return out
}

/** 跑一条工具探针。 */
export async function runToolProbe(probe: ToolProbe): Promise<ToolResult> {
  const captured: CapturedTool[] = []
  const rt = createHostRuntime(fakeCtx([]), { vault: probeVault(), centerRel: '学习中心' })
  registerTools(fakeCtx(captured), rt)
  const tool = captured.find(t => t.name === probe.tool)
  if (!tool) return { text: '', error: `未知工具 ${probe.tool}`, calls: [] }
  const recorder = shadowEngine(rt)
  try {
    const out = await tool.execute(probe.args as never)
    recorder.stop()
    return { text: typeof out === 'string' ? out : JSON.stringify(out), calls: probe.queued ? [] : recorder.calls }
  } catch (err) {
    recorder.stop()
    return { text: '', error: err instanceof Error ? err.message : String(err), calls: [] }
  }
}

export async function runToolProbes(probes: ToolProbe[]): Promise<ToolResult[]> {
  const out: ToolResult[] = []
  for (const p of probes) out.push(await runToolProbe(p))
  return out
}

/** 探测面前提：工具名与 declared 必填键（生成探针要用）。 */
export function toolInventory(): CapturedTool[] {
  const captured: CapturedTool[] = []
  const rt = createHostRuntime(fakeCtx([]), { vault: probeVault(), centerRel: '学习中心' })
  registerTools(fakeCtx(captured as unknown[]), rt)
  return captured
}
