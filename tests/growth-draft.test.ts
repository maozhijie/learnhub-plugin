import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../src/engine/graph.ts'
import { replayDraft, sealedDecisionOf, editGateErrors, simulateOps } from '../src/engine/index.ts'
import type { EditGateCtx } from '../src/engine/index.ts'
import type { EditOp, EditProposalSpec, GRegion } from '../src/engine/index.ts'
import type { ConceptEntry, EndpointAnchor } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import { AgentSeam } from '../src/engine/agent.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

// 生长草稿内核与执行官站（#271 / ADR-0088）：
// - 门同源：replayDraft 与 simulateOps 同一套结构重放；editGateErrors 收拢受理门全序列。
// - sealed 谓词单一出处：seal（零 add_node 纯 set_pre）/ reopen（含 add_node 接线）/ 夹带不动。
// - 站级：脚本化假 agent 灌工具调用轨迹——过门 / 按批 finish 走真实提案管线 / 拒收零落盘 /
//   续建恢复认知 / 禁止空手结束。

// ---- 纯函数测试夹具：单区单块图 3 节点（甲→乙→丙）----
function fixture(): { regions: GRegion[]; graph: Graph } {
  const regions: GRegion[] = [{
    name: '基础', color: '',
    blocks: [{
      name: '基础块',
      nodes: [
        { name: '甲', pre: [], opt: false, note: '', enc: [] },
        { name: '乙', pre: ['甲'], opt: false, note: '', enc: [] },
        { name: '丙', pre: ['乙'], opt: false, note: '', enc: [] },
        { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
      ],
    }],
  }]
  return { regions, graph: new Graph(regions) }
}

test('replayDraft：草稿差异（新增/接线改写/新增边）与错误累积，simulateOps 同源', () => {
  const { regions, graph } = fixture()
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['丙'] },
    { op: 'set_pre', node: '丙', pre: ['乙', '丁'] },
    { op: 'del_node', node: '不存在' }, // 错误累积不中断
  ]
  const r = replayDraft(regions, graph, ops)
  assert.deepEqual(r.errors, ['del_node 节点不存在: 不存在'])
  assert.deepEqual(r.diff.added_nodes, ['丁'])
  const rewire = r.diff.rewired.find(w => w.node === '丙')!
  assert.deepEqual(rewire.pres_before, ['乙'])
  assert.deepEqual(rewire.pres_after, ['乙', '丁'])
  assert.deepEqual(r.diff.added_edges, [{ node: '丙', pre: '丁' }])
  // 门同源：simulateOps 内部改调 replayDraft，错误逐字一致
  assert.deepEqual(simulateOps(regions, graph, ops), r.errors)
})

test('sealedDecisionOf：零 add_node 纯 set_pre 批 = seal；含 add_node 接线 = reopen；夹带零新增批不动', () => {
  const anchors: EndpointAnchor[] = [{
    endpoint: '终点甲', goal_type: 'capability', declared: '2026-09-16',
    worksheet: [], seed_nodes: [], start_basis: {},
  }]
  const seal = sealedDecisionOf([{ op: 'set_pre', node: '终点甲', pre: ['丙'] }], anchors)
  assert.equal(seal.sealing, true)
  assert.deepEqual(seal.effects, [{ endpoint: '终点甲', action: 'seal' }])
  const reopen = sealedDecisionOf([
    { op: 'add_node', name: '丁', pre: [] },
    { op: 'set_pre', node: '终点甲', pre: ['丁'] },
  ], anchors)
  assert.deepEqual(reopen.effects, [{ endpoint: '终点甲', action: 'reopen' }])
  const untouched = sealedDecisionOf([
    { op: 'set_note', node: '甲', note: 'x' },
    { op: 'set_pre', node: '终点甲', pre: ['丙'] },
  ], anchors)
  assert.equal(untouched.sealing, false)
  assert.deepEqual(untouched.effects, [])
})

test('editGateErrors：概念未铸名/终点接线义务被拦；全过则空', async () => {
  const { regions, graph } = fixture()
  const anchors: EndpointAnchor[] = [{
    endpoint: '终点甲', goal_type: 'capability', declared: '2026-09-16',
    worksheet: [], seed_nodes: [], start_basis: {},
  }]
  const entries: ConceptEntry[] = []
  const base = { regions, graph, entries, anchors }
  const bad: EditProposalSpec = {
    course: '数学',
    ops: [{ op: 'add_node', name: '丁', pre: [], teaches: { 未铸名: '会用' } }],
    note: { operator: '旁支', reason: 'r' },
  }
  const errors = await editGateErrors(bad, base satisfies EditGateCtx)
  assert.ok(errors.some(e => e.includes('未铸名') || e.includes('在册')), errors.join('\n'))
  const noWire: EditProposalSpec = {
    course: '数学',
    ops: [{ op: 'add_node', name: '丁', pre: [] }],
    note: { operator: '前进', reason: 'r', target_endpoints: ['终点甲'] },
  }
  const errors2 = await editGateErrors(noWire, base satisfies EditGateCtx)
  assert.ok(errors2.some(e => e.includes('未接线')), errors2.join('\n'))
  const good: EditProposalSpec = {
    course: '数学',
    ops: [
      { op: 'add_node', name: '丁', pre: [], teaches: { 新概念: '会用' } },
      { op: 'set_pre', node: '终点甲', pre: ['丁'] },
    ],
    note: { operator: '前进', reason: 'r', target_endpoints: ['终点甲'] },
  }
  const ok = await editGateErrors(good, { ...base, mints: [{ canonical: '新概念' }] })
  assert.deepEqual(ok, [])
})

// ---- 站级：脚本化假 agent ----
type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
function scriptFake(sessions: Array<string | LoopTurn[]>) {
  const queue = sessions.map(s => [...(typeof s === 'string' ? [{ text: s }] : s)] as LoopTurn[])
  let current: LoopTurn[] = []
  const seam = new AgentSeam({
    logger: memLogger(),
    complete: async () => { throw new Error('脚本化补全端口：不应调用') },
    stream: async req => {
      void req
      if (!current.length) {
        current = queue.shift()
        if (!current) throw new Error('脚本化回路端口：会话脚本已耗尽')
      }
      const next = current.shift()!
      return { text: next.text, toolCalls: next.toolCalls ?? [] }
    },
  }, systemClock)
  return seam
}

const SEED = { registry: null, graph: null }

async function seeded(h: Awaited<ReturnType<typeof withVault>>): Promise<void> {
  await draftCourse(h.engine, CAPABILITY_DRAFT)
}

test('执行官站：patch→finish 走真实提案管线并落 sealed；草稿清场；水位前移', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const agent = scriptFake([[
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({
          ops: [
            { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15 },
            { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
          ],
          note_operator: '前进',
          note_reason: '前沿缺下一台阶',
          note_target_endpoints: ['用导数解决优化问题'],
        }),
      }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'draft_finish', arguments: '{}' }] },
      { text: '本批已发布，收束。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', agent)
    assert.equal(r.finished, true)
    assert.equal(r.unpublished_ops, 0)
    assert.equal(r.published_batches, 1)
    // 走的是真实提案管线：journal 有 graph_edit、快照已推进
    const applied = await h.engine.graph.graphProposals('applied', 'edit')
    assert.ok(applied.length >= 1, '提案已 applied')
    // 发布成功草稿已清场（显式取消拿不到在途草稿）
    assert.deepEqual(await h.engine.growth2.coachDraftCancel('数学'), { cancelled: false })
  })
})

test('执行官站：拒收回灌 loop（坏补丁回滚）+ 禁止空手结束（有增量未 finish 即 fail loud）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    // 第一批：坏补丁（引用不存在节点）被回滚后，好补丁入草稿；随后回路收束不 finish → fail loud
    const agent = scriptFake([[
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({ ops: [{ op: 'add_node', name: '平均变化率', pre: ['不存在的节点'] }], note_operator: '巩固', note_reason: 'r' }),
      }] },
      { text: '', toolCalls: [{
        id: 'c2', name: 'draft_patch',
        arguments: JSON.stringify({ ops: [{ op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, teaches: { 变化率: '会用' } }], note_operator: '巩固', note_reason: '综合收束' }),
      }] },
      { text: '收束（故意不 finish）。' },
    ]])
    await assert.rejects(
      () => h.engine.growth2.coachDraft('数学', agent),
      /未发布增量.*禁止空手结束|禁止空手结束/,
    )
    // 拒收零落草稿：坏补丁的「不存在的节点」不在草稿里；草稿保留可续建
    const r2 = await h.engine.growth2.coachDraft('数学', scriptFake([[
      { text: '', toolCalls: [{ id: 'c3', name: 'draft_audit', arguments: '{}' }] },
      { text: '', toolCalls: [{
        id: 'c4', name: 'draft_finish', arguments: '{}',
      }] },
      { text: '续建发布完成。' },
    ]]))
    assert.equal(r2.resumed, true, '在途草稿默认续建')
    assert.equal(r2.finished, true)
  })
})
