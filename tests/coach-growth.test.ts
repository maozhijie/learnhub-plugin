/**
 * coachGrowthBatch 单站回路外壳行为（#320 / ADR-0101：两站回单站后的薄封装）：
 * 停机转译与 force 豁免、注入即显式拉起、任务取消传导、失败站标签。
 *
 * 门序列与产物面测试归位：
 * - 草稿回路（补丁/审计/finish/revert/draft_note 与受理门序列）→ tests/growth-draft.test.ts
 *   （门同源：草稿通过 = 门通过，ADR-0088）；
 * - 两站编排（思路官计划门 / 两族模板 / 回灌重裁恰一次 / segments 观测）随 #320 退场，测试同退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import { GROWTH_DRAFT_STATION } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import { withVault, localDay } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

const SEED = { registry: null, graph: null }

type Turn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }

/** 脚本化回路假 agent：按会话队列吐 stream 轮次，捕获首个 stream 请求（含系统提示词面）。 */
function loopFake(sessions: Turn[][]): { seam: AgentSeam; prompts: string[] } {
  const prompts: string[] = []
  const queue = sessions.map(s => [...s])
  let current: Turn[] = []
  let captured = false
  const seam = new AgentSeam({
    logger: memLogger(),
    complete: async () => { throw new Error('单站回路不应调用 complete 端口') },
    stream: async req => {
      if (!captured) { prompts.push(JSON.stringify(req)); captured = true }
      if (!current.length) {
        current = queue.shift() ?? []
        if (!current.length) throw new Error('脚本化回路端口：会话脚本已耗尽')
      }
      return current.shift()!
    },
  }, systemClock)
  return { seam, prompts }
}

/** 一具 draft_note（零操作收束）调用。 */
function haltTurn(id: string, reason: string): Turn {
  return { text: '', toolCalls: [{ id, name: 'draft_note', arguments: JSON.stringify({ halt_reason: reason }) }] }
}

test('force 豁免：就绪深度已满足也不短路——回路被拉起，draft_note 零操作收束落地停摆理由', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const { seam } = loopFake([[haltTurn('c1', '结构暂无需变化：缺口由内容生成跟上'), { text: '收束。' }]])
    const r = await h.engine.growth2.coachGrowthBatch('数学', seam, { force: true })
    assert.equal(r.state, 'idle')
    assert.equal(r.halt_reason, '结构暂无需变化：缺口由内容生成跟上', '停摆理由随 draft_note 带出')
  })
})

test('#312 B1：结构达标、正文为零 → 停机转译 idle 且零 LLM 调用（自激回路这一半也断掉）', async () => {
  await withVault(SEED, async h => {
    // 事故形态：结构够深（三起点 = 前瞻需求 3）、正文一条没生成（生长批只落结构，ADR-0078）。
    await draftCourse(h.engine, {
      declared: localDay(-30),
      starts: [{ name: '台阶甲' }, { name: '台阶乙' }, { name: '台阶丙' }],
      endpoint: { name: '终点' },
    })
    let calls = 0
    const seam = new AgentSeam({
      logger: memLogger(),
      complete: async () => { calls++; return '' },
      stream: async () => { calls++; return { text: '', toolCalls: [] } },
    }, systemClock)
    const r = await h.engine.growth2.coachGrowthBatch('数学', seam)
    assert.equal(r.state, 'idle', '判据与动作同量纲：结构达标即停摆')
    assert.equal(r.check.unstarted, 3)
    assert.equal(r.check.ready, 0, '正文存量不参与判据（正文走显式下发）')
    assert.equal(calls, 0, '一个模型站都没拉起——这是自激回路烧掉的正是这一笔')
  })
})

test('#149 注入即显式拉起：check.ok 不再短路，注入块随包进单站回路提示词', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const { seam, prompts } = loopFake([[haltTurn('c1', '注入材料不构成结构改动'), { text: '收束。' }]])
    const r = await h.engine.growth2.coachGrowthBatch('数学', seam, {
      inject: '## 卡点自报（学习者原话）\n「卡在变化率上不会算」',
    })
    assert.equal(r.state, 'idle')
    assert.match(prompts[0]!, /外部注入（待裁决的请求材料）/, '注入块随包进回路提示词')
    assert.match(prompts[0]!, /卡在变化率上不会算/, '注入材料原文携带')
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

// ---- #301 缺陷③：失败站标签随错误随行（宿主失败补标据此落站）----

test('#301 失败站标签：回路端口故障带教练执行站标签', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = new AgentSeam({
      logger: memLogger(),
      complete: async () => { throw new Error('单站回路不应调用 complete 端口') },
      stream: async () => { throw new Error('回路端口故障') },
    }, systemClock)
    const err = await h.engine.growth2.coachGrowthBatch('数学', agent)
      .then(() => null, (e: unknown) => e as Error & { station?: string })
    assert.equal(err?.station, GROWTH_DRAFT_STATION, '回路故障 = 教练执行站')
    assert.match(err!.message, /回路端口故障/)
  })
})
