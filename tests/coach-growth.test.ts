/**
 * coachGrowthBatch 站外壳行为（#273 后的两站编排外壳）：停机转译与 force 豁免、
 * 注入即显式重裁、任务取消传导。
 *
 * 门序列与产物面测试已随两站拆分归位：
 * - 思路官计划门 / 两族模板 / 回灌重裁恰一次 / 停摆计划不拉执行官 → tests/coach-plan.test.ts；
 * - 执行官补丁/审计/finish 与受理门序列（断边/巩固门/审计 ERROR/拒收零落盘）→
 *   tests/growth-draft.test.ts（门同源：草稿通过 = 门通过，ADR-0088）。
 * 旧单发三段式（轻量/全量/双沙盘仲裁、route 随批重写）随 #273 退场不留开关。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSeam } from '../src/engine/agent.ts'
import { systemClock } from '../src/host/clock.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

const SEED = { registry: null, graph: null }

function haltPlan(): string {
  return [
    'course: 数学',
    'operator: 停摆',
    'reason: 就绪缺口由内容生成跟上',
    'target_endpoints: []',
    'steps: []',
  ].join('\n') + '\n'
}

test('force 豁免：就绪深度已满足也不短路——思路官被拉起产计划（停摆计划合法落地）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const seen: string[] = []
    const agent = new AgentSeam({
      logger: memLogger(),
      complete: async prompt => { seen.push(prompt); return haltPlan() },
      stream: async () => { throw new Error('停摆计划不应拉起执行官') },
    }, systemClock)
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent, { force: true })
    assert.equal(r.state, 'idle', '停摆计划 = 合法停摆')
    assert.equal(seen.length, 1, '思路官恰一次单发')
  })
})

test('#149 注入即显式重裁：check.ok 不再短路，注入块随包进思路官提示词', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const seen: string[] = []
    const agent = new AgentSeam({
      logger: memLogger(),
      complete: async prompt => { seen.push(prompt); return haltPlan() },
      stream: async () => { throw new Error('停摆计划不应拉起执行官') },
    }, systemClock)
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent, {
      inject: '## 卡点自报（学习者原话）\n「卡在变化率上不会算」',
    })
    assert.equal(r.state, 'idle')
    assert.match(seen[0]!, /外部注入（待裁决的请求材料）/, '注入块随包进思路官回合')
    assert.match(seen[0]!, /卡在变化率上不会算/, '注入材料原文携带')
  })
})

test('#163 任务取消传导（站点级）：开局取消零调用', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    let calls = 0
    const cancelledFake = new AgentSeam({
      logger: memLogger(),
      complete: async () => { calls++; return '' },
      stream: async () => { calls++; return { text: '', toolCalls: [] } },
    }, systemClock)
    await assert.rejects(
      () => h.engine.growth2.coachGrowthBatch('数学', cancelledFake, { isCancelled: () => true }),
      /已取消/,
    )
    assert.equal(calls, 0, '开局取消零调用')
  })
})
