/**
 * 反编译双提案联合 apply 的面板路由行为（#156）：
 *   - pairJointTarget 纯函数：pair 检测的全部裁决分支（单边守卫的精确拒收语义不改写）；
 *   - 路由级：POST /proposals/apply 检测到 pair 自动走联合入口 projectDecompileApply，
 *     联合结果的 plan 半区触发换线/补支生长批入队（triggerPlanGrowth 消费 planPart）；
 *     无 pair / 另一半已拒时走单边路径，引擎调用序列与既有语义一致。
 * 引擎方法实例属性影子化（host-runtime.test.ts 同款），不依赖真实提案数据。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { handleApi } from '../src/host/api.ts'
import { pairJointTarget } from '../src/host/handlers.ts'

// ---------------------------------------------------------------- 纯函数：pair 检测

const pairList = [
  { id: 1, kind: 'project_plan', status: 'pending', pair: 2 },
  { id: 2, kind: 'seed', status: 'pending', pair: 1 },
]

test('pairJointTarget：seed 带 pending 计划半区 → 联合入口（计划在前种子在后）', () => {
  assert.deepEqual(pairJointTarget(pairList, 'seed', 2), { planPid: 1, seedPid: 2 })
  assert.deepEqual(pairJointTarget(pairList, 'project_plan', 1), { planPid: 1, seedPid: 2 }, '从计划半区进入同一对')
})

test('pairJointTarget：另一半已 applied = 崩溃续段，仍走联合入口（联合入口跳过已应用半区）', () => {
  const applied = [{ id: 1, kind: 'project_plan', status: 'applied', pair: 2 }, pairList[1]]
  assert.deepEqual(pairJointTarget(applied, 'seed', 2), { planPid: 1, seedPid: 2 })
})

test('pairJointTarget：另一半已拒 / pair 缺失 / kind 不符 / 目标已决 → null（单边路径保留原语义）', () => {
  const rejected = [{ id: 1, kind: 'project_plan', status: 'rejected', pair: 2 }, pairList[1]]
  assert.equal(pairJointTarget(rejected, 'seed', 2), null, '另一半已拒：单边守卫的「同退」拒收文案要原样透出')
  assert.equal(pairJointTarget([{ id: 2, kind: 'seed', status: 'pending' }], 'seed', 2), null, '无 pair 的普通种子')
  assert.equal(pairJointTarget(pairList, 'edit', 1), null, '只有 seed/project_plan 参与反编译对')
  assert.equal(pairJointTarget(pairList, 'seed', 99), null, 'id 不存在 → null，交给 takePending 报「提案不存在」')
  const appliedTarget = [{ id: 2, kind: 'seed', status: 'applied', pair: 1 }, pairList[0]]
  assert.equal(pairJointTarget(appliedTarget, 'seed', 2), null, '目标已 applied → null，保留 takePending 的「已 applied」拒收')
})

test('pairJointTarget：省 id = 该 kind 最新 pending（与 takePending 的缺省选取同语义）', () => {
  const list = [
    { id: 1, kind: 'seed', status: 'applied', pair: undefined },
    { id: 5, kind: 'project_plan', status: 'pending', pair: 6 },
    { id: 6, kind: 'seed', status: 'pending', pair: 5 },
  ]
  assert.deepEqual(pairJointTarget(list, 'seed'), { planPid: 5, seedPid: 6 })
})

// ---------------------------------------------------------------- 路由级：自动联合入口

const tmpVaults: string[] = []

function fakeCtx(): Context {
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
  } as unknown as Context
}

function makeRuntime(): HostRuntime {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-joint-'))
  tmpVaults.push(vault)
  mkdirSync(join(vault, '学习中心'))
  return createHostRuntime(fakeCtx(), { vault, centerRel: '学习中心' })
}

/** POST /proposals/apply 一发：返回 {status, res}（引擎桩由用例自备）。 */
async function postApply(rt: HostRuntime, body: Record<string, unknown>): Promise<{ status: number; res: unknown }> {
  const out = { status: 0, res: undefined as unknown }
  const res = {
    writeHead: (code: number) => { out.status = code },
    end: (data?: unknown) => {
      const text = data === undefined ? '' : String(data)
      try { out.res = text ? JSON.parse(text) : null } catch { out.res = text }
    },
  } as unknown as ServerResponse
  const req = {
    method: 'POST', url: '/learnhub/api/proposals/apply',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  } as unknown as IncomingMessage
  await handleApi(rt, fakeCtx(), req, res)
  return out
}

test('路由级：pair 提案 apply 自动走联合入口，plan 半区的生长触发随后入队（#156）', async () => {
  const rt = makeRuntime()
  const engine = rt.engine as unknown as Record<string, unknown>
  const graph = engine.graph as Record<string, unknown>
  const project = engine.project as Record<string, unknown>
  // #160 种子链出口的取数桩（registry.resolve / loadView 在真实引擎上会读空 vault 文件）
  const registry = engine.registry as Record<string, unknown>
  registry.resolve = async () => ({ name: '数学', root: '数学' })
  registry.get = async () => ({ name: '数学' })
  engine.loadView = async () => ({ graph: { nset: new Set(['起点A']) }, state: { 起点A: {} } })
  const calls: string[] = []
  graph.graphProposals = async () => pairList
  graph.proposalApply = async () => { calls.push('proposalApply'); return [] }
  // 联合入口替身：plan 半区带换线触发（triggerPlanGrowth 的消费形状，#149）；
  // seed 半区带 course/starts（#160 路由出口对联合结果的种子半区触发起点正文入队）
  project.projectDecompileApply = async (...args: unknown[]) => {
    calls.push(`joint(${args.join(',')})`)
    return { project: '反编译项目', seed: { course: '数学', starts: [] }, plan: { kind: 'project_plan', growth: [{ course: '线性代数', lines: ['补支'] }] } }
  }
  const out = await postApply(rt, { kind: 'seed', id: 2 })
  assert.equal(out.status, 200, '面板 apply 双提案不再被单边守卫拒收')
  assert.deepEqual(calls, ['joint(1,2)'], '走联合入口且只走联合入口（proposalApply 不被调）')
  assert.ok(rt.jobs.genJobs.get('线性代数/生长批'), '联合结果 plan 半区的换线触发入队生长批')
  assert.equal(rt.jobs.genJobs.get('线性代数/生长批')?.growthInject, '补支', '注入块随生长批任务携带')
})

test('路由级：无 pair 的提案 apply 走单边路径（引擎调用序列不变）', async () => {
  const rt = makeRuntime()
  const engine = rt.engine as unknown as Record<string, unknown>
  const graph = engine.graph as Record<string, unknown>
  const project = engine.project as Record<string, unknown>
  // #160 种子链出口的取数桩（同上）
  const registry = engine.registry as Record<string, unknown>
  registry.resolve = async () => ({ name: '数学', root: '数学' })
  registry.get = async () => ({ name: '数学' })
  engine.loadView = async () => ({ graph: { nset: new Set(['起点A']) }, state: { 起点A: {} } })
  const calls: string[] = []
  graph.graphProposals = async () => [{ id: 2, kind: 'seed', status: 'pending' }]
  graph.proposalApply = async (...args: unknown[]) => { calls.push(`apply(${args.join(',')})`); return { kind: 'seed', course: '数学', starts: [] } }
  project.projectDecompileApply = async () => { calls.push('joint'); return {} }
  const out = await postApply(rt, { kind: 'seed', id: 2 })
  assert.equal(out.status, 200)
  assert.deepEqual(calls, ['apply(seed,2)'], '普通种子走统一 apply 单边路径')
})

test('路由级：另一半已拒的 pair apply 仍走单边路径（同退语义的拒收由引擎单边守卫给出）', async () => {
  const rt = makeRuntime()
  const engine = rt.engine as unknown as Record<string, unknown>
  const graph = engine.graph as Record<string, unknown>
  const project = engine.project as Record<string, unknown>
  // #160 种子链出口的取数桩（同上）
  const registry = engine.registry as Record<string, unknown>
  registry.resolve = async () => ({ name: '数学', root: '数学' })
  registry.get = async () => ({ name: '数学' })
  engine.loadView = async () => ({ graph: { nset: new Set(['起点A']) }, state: { 起点A: {} } })
  const calls: string[] = []
  graph.graphProposals = async () => [{ id: 1, kind: 'project_plan', status: 'rejected', pair: 2 }, pairList[1]]
  graph.proposalApply = async (...args: unknown[]) => { calls.push(`apply(${args.join(',')})`); return { kind: 'seed', course: '数学', starts: [] } }
  project.projectDecompileApply = async () => { calls.push('joint'); return {} }
  const out = await postApply(rt, { kind: 'seed', id: 2 })
  assert.equal(out.status, 200)
  assert.deepEqual(calls, ['apply(seed,2)'], '另一半已拒 → 不联合，拒绝侧联动语义的报错路径不被绕过')
})

test('路由级：联合入口抛错 = 500 且错误原样透传（面板 apply 的失败语义不静默变形）', async () => {
  const rt = makeRuntime()
  const engine = rt.engine as unknown as Record<string, unknown>
  const graph = engine.graph as Record<string, unknown>
  const project = engine.project as Record<string, unknown>
  graph.graphProposals = async () => pairList
  graph.proposalApply = async () => []
  project.projectDecompileApply = async () => { throw new Error('[project-decompile-apply] 提案 kind 不对（桩注入）') }
  const out = await postApply(rt, { kind: 'project_plan', id: 1 })
  assert.equal(out.status, 500)
  assert.match((out.res as { error: string }).error, /project-decompile-apply/)
})

after(() => {
  for (const v of tmpVaults) rmSync(v, { recursive: true, force: true })
})
