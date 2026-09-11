/**
 * 六策略站经缝（#162）·投递层草案站补遗：计划草案与里程碑草案的调用面在宿主队列
 * 执行器（generateProjectPlan / generateProjectMilestone），引擎层测试（种子/罗盘/
 * 教练生长/反编译）覆盖不到的这两站在这里锁缝语义——
 * - 调用经 rt.agent（脚本化补全端口）：剥围栏在缝里完成（受理收到净 YAML）；
 * - 语义档沿缝贯通：计划草案 fast、里程碑修复轮 deep，注入侧可观测；
 * - 门错修复轮：里程碑轻量结构门未过恰回灌重产一次，仍败带原样门错误与错误码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import { systemClock } from '../src/host/clock.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { generateProjectMilestone, generateProjectPlan } from '../src/host/jobs.ts'
import { AgentSeam } from '../src/engine/index.ts'
import type { LlmComplete, LlmEffort } from '../src/engine/index.ts'

const tmpVaults: string[] = []

function fakeCtx(): Context {
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
  } as unknown as Context
}

function makeRuntime(): HostRuntime {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-seam-station-'))
  tmpVaults.push(vault)
  mkdirSync(join(vault, '学习中心'))
  return createHostRuntime(fakeCtx(), { vault, centerRel: '学习中心' })
}

test.after(() => {
  for (const v of tmpVaults) rmSync(v, { recursive: true, force: true })
})

/** 脚本化补全端口：按调用序回放，记录 prompt/语义档（注入侧可观测的测试形态）。 */
function scriptedSeam(rt: HostRuntime, replies: string[]) {
  const calls: Array<{ prompt: string; effort?: LlmEffort }> = []
  const port: LlmComplete = async (prompt, _system, opts) => {
    calls.push({ prompt, effort: opts?.effort })
    if (!replies.length) throw new Error('脚本化补全端口：应答已耗尽')
    return replies.shift()!
  }
  rt.agent = new AgentSeam({ complete: port }, systemClock)
  return Object.assign(rt.agent, { calls })
}

test('计划草案站经缝：剥围栏在缝里完成（受理拿到净 YAML）、fast 档可观测', async () => {
  const rt = makeRuntime()
  const calls: Array<{ id: string; yaml: string }> = []
  rt.engine.projectPlanPack = async () => '计划提示词包'
  rt.engine.projectPlanPropose = (async (id: string, yaml: string) => {
    calls.push({ id, yaml })
    return { id: 7, initial: true, milestones: 2 }
  }) as never
  // 模型把整段 YAML 包进围栏——缝剥壳后受理（原投递层接线语义，收口后由缝内建）
  const fake = scriptedSeam(rt, ['```yaml\nproject: 练琴计划\nplan: []\n```'])

  const out = await generateProjectPlan(rt, '练琴计划')

  assert.match(out, /提案 #7 已受理（初次规划：2 个里程碑）/)
  assert.equal(fake.calls.length, 1, '计划草案一次成型：恒一次调用（无修复轮）')
  assert.equal(fake.calls[0]!.effort, 'fast', '计划草案声明 fast 档（沿缝可观测）')
  assert.equal(fake.calls[0]!.prompt, '计划提示词包')
  assert.deepEqual(calls, [{ id: '练琴计划', yaml: 'project: 练琴计划\nplan: []' }], '受理拿到的是缝剥壳后的净 YAML')
})

test('里程碑草案站经缝：轻量结构门未过恰回灌重产一次（修复轮 deep）；仍败带原样门错误与错误码', async () => {
  const rt = makeRuntime()
  const writes: string[] = []
  rt.engine.projectMilestonePack = async () => '里程碑任务卡提示词包'
  rt.engine.projectMilestoneWrite = (async (_id: string, _m: string, md: string) => {
    writes.push(md)
    if (writes.length === 1) {
      const e: Error & { code?: string } = new Error('[project-milestone] 轻量结构门未过：缺验收清单')
      e.code = 'MILESTONE_GATE_FAILED'
      throw e
    }
    return { written: 'm1', tier: '低' }
  }) as never
  const fake = scriptedSeam(rt, ['坏产出', '好产出'])

  const out = await generateProjectMilestone(rt, '练琴计划', 'm1')

  assert.match(out, /「m1」已落盘（档位 低）。/)
  assert.equal(fake.calls.length, 2, '恰两轮调用：首产 + 回灌重产一次')
  assert.equal(fake.calls[0]!.effort, 'fast', '首产 fast 档')
  assert.equal(fake.calls[1]!.effort, 'deep', '修复轮 deep 档（回灌重裁值得多思考一轮）')
  assert.match(fake.calls[1]!.prompt, /轻量结构门未过：缺验收清单/, '门错误原文回灌修复提示词')
  assert.match(fake.calls[1]!.prompt, /坏产出/, '被拒原文随行')
  assert.deepEqual(writes, ['坏产出', '好产出'], '重产候选重过同一扇门')
  assert.equal(fake.calls.every(c => c.prompt.startsWith('里程碑任务卡提示词包')), true, '两轮共用同一提示词包')

  // 修复轮仍败：SEED 同款——错误原样抛出（与旧直抛形态同文案同码）
  const rt2 = makeRuntime()
  rt2.engine.projectMilestonePack = async () => '包'
  rt2.engine.projectMilestoneWrite = (async () => {
    const e: Error & { code?: string } = new Error('[project-milestone] 轻量结构门未过：仍缺验收清单')
    e.code = 'MILESTONE_GATE_FAILED'
    throw e
  }) as never
  scriptedSeam(rt2, ['坏一版', '还是坏'])
  await assert.rejects(
    () => generateProjectMilestone(rt2, '练琴计划', 'm1'),
    (err: unknown) => {
      const e = err as Error & { code?: string }
      assert.match(e.message, /仍缺验收清单/)
      assert.equal(e.code, 'MILESTONE_GATE_FAILED')
      return true
    },
  )
})
