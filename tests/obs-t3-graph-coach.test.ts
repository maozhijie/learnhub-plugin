/**
 * 观测面扩展 T3（#291 / ADR-0091）：graph/coach 族日志点接线——每个观测点至少一条
 * 内存假 logger 事件断言。事件名与级别以附录 ADR（0091）登记为准，接线不得漂移改名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import { COACH_PLAN_STATION } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

const SEED = { registry: null, graph: null }

/** 思路官脚本化端口（complete 依次回放计划；停摆计划不拉执行官）。 */
function planFake(plans: string[]): AgentSeam {
  let i = 0
  return new AgentSeam({
    logger: memLogger(),
    complete: async () => plans[i++] ?? (() => { throw new Error('计划脚本已耗尽') })(),
  }, systemClock)
}

const haltPlan = 'course: 数学\noperator: 停摆\nreason: 就绪缺口由内容生成跟上\ntarget_endpoints: []\nsteps: []\n'
const badPlan = 'course: 数学\noperator: 瞎蒙\nreason: 非法算子\ntarget_endpoints: []\nsteps: []\n'

test('coach.plan.summary_miss：重裁族无上次裁决留痕（DEBUG）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = planFake([haltPlan])
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent, { trigger: 'node_skip' })
    assert.equal(r.state, 'idle')
    assert.equal(h.logger.count('coach.plan.summary_miss'), 1)
    const e = h.logger.nth('coach.plan.summary_miss')!
    assert.equal(e.level, 'debug')
    assert.equal(e.fields.course, '数学')
  })
})

test('coach.plan.reinject：计划门拒收后的修复轮回灌观测（DEBUG mode=repair）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = planFake([badPlan, haltPlan])
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent, { trigger: 'panel_dispatch' })
    assert.equal(r.state, 'idle')
    assert.equal(h.logger.count('coach.plan.reinject'), 1)
    const e = h.logger.nth('coach.plan.reinject')!
    assert.equal(e.level, 'debug')
    assert.equal(e.fields.family, 'routine', '#296 后事件带族别与清单计数（字段面以门册为准）；#310 起首裁不是重裁——本课程无生长批历史，panel_dispatch 也走常规族')
    assert.equal(e.fields.schema_errors, 1)
  })
})

test('#313 B6：门拒绝落调试日志——coach.gate.reject 两轮各一条（幽灵事件接线兑现）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = planFake([badPlan, badPlan])
    await assert.rejects(
      () => h.engine.growth2.coachGrowthBatch('数学', agent, { trigger: 'panel_dispatch' }),
      /未过 schema 门/,
    )
    // 此前这条事件只活在 ADR-0080 的闭集里（全仓零发出点）：排查者按文档 grep 日志
    // 会得到「没跑过重裁」的假否定。现在两个站的每一处门拒绝都从这里落地。
    assert.equal(h.logger.count('coach.gate.reject'), 2, '首轮 + 回灌重裁各一条')
    const first = h.logger.nth('coach.gate.reject', 1)!
    assert.equal(first.level, 'warn')
    assert.equal(first.fields.station, COACH_PLAN_STATION)
    assert.equal(first.fields.gate, 'plan_schema')
    assert.equal(first.fields.round, 1)
    assert.ok(Array.isArray(first.fields.detail), '明细进续行（MULTILINE_EVENTS 成员）')
    assert.equal(h.logger.nth('coach.gate.reject', 2)!.fields.fatal, true, '两轮死因那条带 fatal')
  })
})

test('coach.checkpoint.fail：检查点检查失败留痕（WARN），宿主失败面不变', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    await writeFile(h.engine.paths.anchorPath('数学'), '{oops', 'utf8')
    await assert.rejects(() => h.engine.growth2.coachCheckpoint('panel_dispatch', '数学'))
    assert.equal(h.logger.count('coach.checkpoint.fail'), 1)
    const e = h.logger.nth('coach.checkpoint.fail')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.trigger, 'panel_dispatch')
    assert.equal(e.fields.course, '数学')
  })
})

test('growth.draft.corrupt：草稿档损坏视为无在途 + WARN 指针', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const dir = `${h.engine.paths.courseStateDir('数学')}/草稿`
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/draft-broken.json`, '{oops', 'utf8')
    const seam = new AgentSeam({ logger: memLogger(), stream: async () => ({ text: '', toolCalls: [] }) } as never, systemClock)
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.resumed, false, '坏档不续建')
    assert.equal(h.logger.count('growth.draft.corrupt'), 1)
    const e = h.logger.nth('growth.draft.corrupt')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.session, 'draft-broken')
  })
})

test('graph.mine.bank_skip：挖矿面题库 Broken 排除留痕（WARN）', async () => {
  await withVault({
    files: [{ path: '学习中心/math/题库/入门.yaml', content: '{oops' }],
  }, async ({ engine, logger }) => {
    const r = await engine.graph.conceptConfusableCandidates('数学')
    assert.equal(r.scanned, 0, 'Broken 节点不入候选面，其余照常（本课仅一节点）')
    assert.equal(logger.count('graph.mine.bank_skip'), 1)
    const e = logger.nth('graph.mine.bank_skip')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.node, '入门')
  })
})

test('graph.proposal.scan_skip：去重扫描遇产物损坏的旧提案留痕（DEBUG）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    await h.engine.concepts.save('数学', [
      { canonical: '变化率' }, { canonical: '导数' },
    ])
    const pair = { a: '变化率', b: '导数', evidence: ['共现'] }
    const first = await h.engine.proposals.proposeConfusableCandidate('数学', pair)
    // 把产物写坏 → 再次提名时去重扫描跳过坏产物提案（不抛，照常出新提案）
    await writeFile(h.engine.paths.proposalArtifactPath(first.id, 'confusable_pair', '数学'), '{oops', 'utf8')
    h.logger.clear()
    await h.engine.proposals.proposeConfusableCandidate('数学', pair)
    assert.ok(h.logger.count('graph.proposal.scan_skip') >= 1)
    const e = h.logger.nth('graph.proposal.scan_skip')!
    assert.equal(e.level, 'debug')
    assert.equal(e.fields.kind, 'confusable_pair')
    assert.equal(e.fields.id, first.id)
  })
})

test('growth.tally_skip：生长批留痕损坏的三率折损留痕（WARN）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    // 前进批发布（真实提案管线）
    const yaml = [
      'course: 数学',
      'reason: 沿终点推进',
      'ops:',
      '  - { op: add_node, name: 平均变化率, pre: [认识变化率], est: 15, bloom: 理解, difficulty: 2, teaches: { 变化率: 会用 } }',
      '  - { op: set_pre, node: 用导数解决优化问题, pre: [平均变化率] }',
      'note:',
      '  operator: 前进',
      '  reason: 前沿缺下一台阶',
      '  target_endpoints: [用导数解决优化问题]',
    ].join('\n')
    const prop = await h.engine.graph.graphPropose('edit', yaml) as { id: number }
    await h.engine.graph.graphApply('edit', prop.id)
    // 产物写坏 → 三率折叠时该批不计入 + WARN
    await writeFile(h.engine.paths.proposalArtifactPath(prop.id, 'edit', '数学'), '{oops', 'utf8')
    h.logger.clear()
    await h.engine.growth2.probationStatus()
    assert.equal(h.logger.count('growth.tally_skip'), 1)
    const e = h.logger.nth('growth.tally_skip')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.course, '数学')
  })
})
