// 糖算子补全 + 审计 findings（#272，接 #271 草稿内核）：
// - 糖展开等价性：expandPatchOps（insert_prereq_chain / split_node / suggest_confusable）
//   展开后的 ops 序列与手写原子 ops 逐字等价（确定性回放）；展开面 fail loud（终点不可拆、
//   into 不足、悬空引用）。
// - findings：draftFindings 纯函数逐类断言（孤立新铸 / 悬空指向 / 近似名撞车 / 收尾提示），
//   以及站级脚本化假 agent 场景下审计回合携带 findings 读数、suggest_confusable 在 finish
//   发布成功后展开为混淆对候选提案（人审一次一条，不自动入册）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../src/engine/graph/graph.ts'
import { replayDraft } from '../src/engine/index.ts'
import { expandPatchOps, draftFindings } from '../src/engine/index.ts'
import type { EditOp, GNode } from '../src/engine/index.ts'
import type { ConceptEntry, EndpointAnchor } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

// ---- 纯函数夹具：单文件图（甲→乙→丙 + 终点甲；乙带轮廓，#284 nodes 平铺）----
function fixture(): { nodes: GNode[]; graph: Graph } {
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [] },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [], est: 15, teaches: { 变化率: '会用' } },
    { name: '丙', pre: ['乙'], opt: false, note: '', enc: [] },
    { name: '终点甲', pre: ['乙'], opt: false, note: '', enc: [] },
  ]
  return { nodes, graph: new Graph(nodes) }
}

test('split_node 展开：与手写原子 ops 逐字等价（轮廓继承 + 消费方重排 + 删原节点）', () => {
  const { nodes, graph } = fixture()
  const { ops, confusables } = expandPatchOps(
    [{ op: 'split_node', node: '乙', into: ['乙一', '乙二'] }] as Array<Record<string, unknown>>,
    nodes, graph, new Set(['终点甲']),
  )
  assert.deepEqual(confusables, [])
  const hand: EditOp[] = [
    { op: 'add_node', name: '乙一', pre: ['甲'], est: 15, teaches: { 变化率: '会用' } },
    { op: 'add_node', name: '乙二', pre: ['甲'], est: 15, teaches: { 变化率: '会用' } },
    { op: 'set_pre', node: '丙', pre: ['乙一', '乙二'] },
    { op: 'set_pre', node: '终点甲', pre: ['乙一', '乙二'] },
    { op: 'del_node', node: '乙' },
  ]
  assert.deepEqual(ops, hand)
  // 确定性回放：展开序列与手写序列在 replayDraft 下错误/差异一致且全过
  const a = replayDraft(nodes, graph, ops)
  const b = replayDraft(nodes, graph, hand)
  assert.deepEqual(a, b)
  assert.deepEqual(a.errors, [])
})

test('insert_prereq_chain 展开与 suggest_confusable 收集（建议不是图 op）', () => {
  const { nodes, graph } = fixture()
  const { ops, confusables } = expandPatchOps([
    { op: 'insert_prereq_chain', pre: ['甲'], chain: [{ name: '丁' }, { name: '戊' }] },
    { op: 'suggest_confusable', name: '导数', with: '变化率' },
  ] as Array<Record<string, unknown>>, nodes, graph, new Set(['终点甲']))
  assert.deepEqual(ops, [
    { op: 'add_node', name: '丁', pre: ['甲'] },
    { op: 'add_node', name: '戊', pre: ['丁'] },
  ])
  assert.deepEqual(confusables, [{ concept: '导数', with: '变化率' }])
})

test('展开面 fail loud：终点不可拆 / into 不足 / 节点不存在 / 同名建议 / 链过短', () => {
  const { nodes, graph } = fixture()
  const eps = new Set(['终点甲'])
  const split = (raw: Record<string, unknown>): unknown[] =>
    expandPatchOps([raw], nodes, graph, eps).ops
  assert.throws(() => split({ op: 'split_node', node: '终点甲', into: ['a', 'b'] }), /终点不可拆/)
  assert.throws(() => split({ op: 'split_node', node: '乙', into: ['只有一份'] }), /至少 2 个新名/)
  assert.throws(() => split({ op: 'split_node', node: '不存在', into: ['a', 'b'] }), /不存在/)
  assert.throws(() => split({ op: 'split_node', node: '乙', into: ['a', 'a'] }), /含重名/)
  assert.throws(() => split({ op: 'suggest_confusable', name: '同名', with: '同名' }), /两个不同概念/)
  assert.throws(() => split({ op: 'suggest_confusable', name: '' , with: 'b' }), /两个字段/)
  assert.throws(() => split({ op: 'insert_prereq_chain', chain: [{ name: '单' }] }), /至少 2 条/)
})

// ---- findings 纯函数：逐类一例 + 不误报 ----
function anchorOf(endpoint: string, sealed?: string): EndpointAnchor {
  return {
    endpoint, goal_type: 'capability', declared: '2026-09-16',
    worksheet: [], seed_nodes: [], start_basis: {},
    ...(sealed ? { sealed } : {}),
  } as EndpointAnchor
}

test('draftFindings：孤立新铸 / 悬空指向 / 近似名撞车 / 收尾提示各一例；被引用的概念不误报', () => {
  const { graph } = fixture() // 乙 teaches 变化率（在册且被引用）
  const entries: ConceptEntry[] = [{ canonical: '变化率' }, { canonical: '偏导数的链式法则' }]
  const mints: ConceptEntry[] = [
    { canonical: '孤立概念' }, // 零 teaches/assumes/invokes
    { canonical: '偏导数的链式法则应用' }, // 近似名（trigram 0.75 ≥ 0.6）
    { canonical: '变化率' }, // 精确在册且被引用——不孤立也不近似
  ]
  const findings = draftFindings({
    mints, entries, graph,
    invokes: new Map(),
    confusables: [{ concept: '孤立概念', with: '不在册的概念' }],
    anchors: [anchorOf('终点甲'), anchorOf('已收尾终点', '2026-09-16')],
  })
  assert.ok(findings.some(f => f.includes('孤立新铸概念') && f.includes('孤立概念')), findings.join('\n'))
  assert.ok(findings.some(f => f.includes('悬空指向') && f.includes('不在册的概念')), findings.join('\n'))
  assert.ok(findings.some(f => f.includes('近似名撞车') && f.includes('偏导数的链式法则')), findings.join('\n'))
  assert.ok(findings.some(f => f.includes('终点 终点甲 已铺通待收尾')), findings.join('\n'))
  assert.ok(!findings.some(f => f.includes('已收尾终点')), '已收尾终点不提示')
  assert.ok(!findings.some(f => f.includes('变化率')), '被引用的在册概念不误报')
})

// ---- 站级：脚本化假 agent（audit findings 读数 + suggest_confusable finish 展开）----
type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
function scriptFake(turns: LoopTurn[]): AgentSeam {
  const queue = [...turns]
  const seam = new AgentSeam({
    logger: memLogger(),
    complete: async () => { throw new Error('脚本化补全端口：不应调用') },
    stream: async req => {
      void req
      const next = queue.shift()
      if (!next) throw new Error('脚本化回路端口：会话脚本已耗尽')
      return { text: next.text, toolCalls: next.toolCalls ?? [] }
    },
  }, systemClock)
  return seam
}

test('执行官站：split_node 补丁过重放；draft_audit 回合携带 findings 读数；收尾提示在列', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = scriptFake([
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({ ops: [{ op: 'split_node', node: '认识变化率', into: ['认识变化率上', '认识变化率下'] }], note_operator: '旁支', note_reason: '粒度过粗拆两半' }),
      }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'draft_audit', arguments: '{}' }] },
      { text: '', toolCalls: [{ id: 'c3', name: 'draft_finish', arguments: '{}' }] },
      { text: '拆分批已发布，收束。' },
    ])
    const r = await h.engine.growth2.coachDraft('数学', agent)
    assert.equal(r.finished, true)
    const audit = r.rounds.find(x => x.kind === 'audit')
    assert.ok(audit, '审计回合在列')
    // 收尾提示 finding：终点（用导数解决优化问题）有粗占位 pre、未收尾 → findings 非空
    assert.match(audit!.summary, /findings/)
  })
})

test('执行官站：suggest_confusable 在 finish 发布成功后展开为混淆对候选提案（pending，不自动入册）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = scriptFake([
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({
          ops: [
            { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, teaches: { 导数: '会用' } },
            { op: 'suggest_confusable', name: '导数', with: '变化率' },
            { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
          ],
          concepts: [{ canonical: '导数' }],
          note_operator: '前进',
          note_reason: '前沿缺下一台阶',
          note_target_endpoints: ['用导数解决优化问题'],
        }),
      }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'draft_finish', arguments: '{}' }] },
      { text: '发布完成，收束。' },
    ])
    const r = await h.engine.growth2.coachDraft('数学', agent)
    assert.equal(r.finished, true)
    // 混淆对候选已产出为 pending 提案（人审一次一条；登记表未被自动写入）
    const pending = await h.engine.graph.graphProposals('pending', 'confusable_pair')
    assert.equal(pending.length, 1)
    assert.match(JSON.stringify(pending[0]), /导数/)
  })
})
