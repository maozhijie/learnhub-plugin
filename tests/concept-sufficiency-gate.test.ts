import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../src/engine/graph/graph.ts'
import { conceptSufficiencyGateErrors, editGateErrors } from '../src/engine/coach/proposals.ts'
import type { EditOp, EditProposalSpec } from '../src/engine/coach/proposals.ts'
import type { ConceptEntry, GNode } from '../src/engine/types.ts'
import type { EndpointAnchor } from '../src/engine/coach/seed.ts'

// ---- 概念充分性门（#336）：teaches/assumes 升格为写侧门禁输入 ----
//
// 判据（增量）：只裁本批 add_node 新增的 assumes，不追溯存量。
// 三条出口：闭包内被教 → 过；本课图内被教但不在闭包 → 拒（漏连 pre）；本课图内没人教 → 放行。
// 档位：祖先 teaches 档 ≥ assumes 档（知道 < 会用 < 能教）；任一侧缺档不判。
// 归一：复用 canonicalizerOf（别名命中即命中）。

// 夹具：基图 甲→乙→丙 + 终点锚
function fixture(): { nodes: GNode[]; graph: Graph; entries: ConceptEntry[] } {
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [], teaches: { 分数: '知道' } },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [], teaches: { 分式: '会用' } },
    { name: '丙', pre: ['乙'], opt: false, note: '', enc: [] },
    { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
  ]
  const graph = new Graph(nodes)
  const entries: ConceptEntry[] = [
    { canonical: '分数', aliases: ['fraction'] },
    { canonical: '分式', aliases: ['algebraic fraction'] },
    { canonical: '一元二次方程', aliases: ['quadratic'] },
    { canonical: '幂', aliases: ['power'] },
  ]
  return { nodes, graph, entries }
}

const anchors: EndpointAnchor[] = [{
  endpoint: '终点甲', goal_type: 'capability', declared: '2026-09-18',
  worksheet: [], seed_nodes: [], start_basis: {},
}]

// ---- 出口 1：闭包内被教 → 过 ----

test('conceptSufficiencyGateErrors：assumes 概念在祖先闭包内被教且档位足够 → 放行', () => {
  const { nodes, graph, entries } = fixture()
  // 丁 pre=[乙]，祖先闭包 = {乙, 甲}；乙 teaches 分式:会用，assumes 分式:会用 → 过
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['乙'], assumes: { 分式: '会用' }, operator: '新增' },
  ]
  const errs = conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors)
  assert.deepEqual(errs, [])
})

test('conceptSufficiencyGateErrors：assumes 档位低于祖先 teaches → 放行', () => {
  const { nodes, graph, entries } = fixture()
  // 乙 teaches 分式:会用 > 知道 → 过
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['乙'], assumes: { 分式: '知道' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 出口 2：本课图内被教但不在闭包 → 拒（漏连 pre） ----

test('conceptSufficiencyGateErrors：概念在图内被教但不在祖先闭包 → 拒（漏连 pre）', () => {
  const { nodes, graph, entries } = fixture()
  // 丁 pre=[甲]，祖先闭包 = {甲}；甲 teaches 分数:知道，但不 teaches 分式
  // 分式在图内被乙教过，但乙不在丁的祖先闭包内 → 拒
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], assumes: { 分式: '会用' }, operator: '新增' },
  ]
  const errs = conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors)
  assert.equal(errs.length, 1)
  assert.match(errs[0]!, /漏连 pre/)
  assert.match(errs[0]!, /set_pre/)
})

// ---- 越档拒收 ----

test('conceptSufficiencyGateErrors：祖先 teaches 档 < assumes 档 → 拒收', () => {
  const { nodes, graph, entries } = fixture()
  // 甲 teaches 分数:知道 < 会用 → 越档
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], assumes: { 分数: '会用' }, operator: '新增' },
  ]
  const errs = conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors)
  assert.equal(errs.length, 1)
  assert.match(errs[0]!, /档位不足/)
})

// ---- 出口 3：本课图内没人教 → 放行（跨课首引） ----

test('conceptSufficiencyGateErrors：概念在本课图内没人教 → 放行（跨课首引）', () => {
  const { nodes, graph, entries } = fixture()
  // 对数 不在图内任何节点的 teaches → 放行
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], assumes: { 对数: '会用' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 缺席不判 ----

test('conceptSufficiencyGateErrors：祖先 teaches 缺档 → 不判（放行）', () => {
  const { nodes, graph, entries } = fixture()
  // 丙 不 teaches 任何东西，但有 pre=[乙]
  // 丁 pre=[丙]，assumes 分式:会用。丙不教分式，但乙教——乙在闭包内
  // 乙 teaches 分式:会用 = assumes 分式:会用 → 过
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['丙'], assumes: { 分式: '会用' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

test('conceptSufficiencyGateErrors：assumes 侧缺档 → 不判', () => {
  const { nodes, graph, entries } = fixture()
  // assumes 概念名在册但无档位 → 不判（缺席不判口径）
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], assumes: { 分数: '知道' }, operator: '新增' },
  ]
  // 甲 teaches 分数:知道 = assumes 分数:知道 → 过
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 别名归一 ----

test('conceptSufficiencyGateErrors：别名归一后命中 → 放行', () => {
  const { nodes, graph, entries } = fixture()
  // fraction 是 分数 的别名，assumes fraction → 归一到 分数 → 甲 teaches 分数:知道 ≥ 知道 → 过
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], assumes: { fraction: '知道' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

test('conceptSufficiencyGateErrors：图上写别名、op 写 canonical → 归一后命中', () => {
  // 图上某节点 teaches 用别名写，op assumes 用 canonical
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [], teaches: { fraction: '会用' } },
    { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
  ]
  const graph = new Graph(nodes)
  const entries: ConceptEntry[] = [{ canonical: '分数', aliases: ['fraction'] }]
  // assumes 分数 → 归一到 分数 → 图上的 fraction 归一后也是 分数 → 命中
  const ops: EditOp[] = [
    { op: 'add_node', name: '乙', pre: ['甲'], assumes: { 分数: '会用' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 批内闭包判定 ----

test('conceptSufficiencyGateErrors：批内兄弟节点 teaches 的概念在闭包内 → 放行', () => {
  const { nodes, graph, entries } = fixture()
  // 批内新增丁 teaches 幂:知道，戊 pre=[丁] assumes 幂:知道 → 丁在戊闭包内 → 过
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], teaches: { 幂: '知道' }, operator: '新增' },
    { op: 'add_node', name: '戊', pre: ['丁'], assumes: { 幂: '知道' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

test('conceptSufficiencyGateErrors：批内兄弟教的概念不在闭包 → 拒', () => {
  const { nodes, graph, entries } = fixture()
  // 丁 teaches 幂，戊 pre=[甲]（不接丁）assumes 幂 → 幂在图内被丁教但不在戊闭包 → 拒
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], teaches: { 幂: '知道' }, operator: '新增' },
    { op: 'add_node', name: '戊', pre: ['甲'], assumes: { 幂: '知道' }, operator: '新增' },
  ]
  const errs = conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors)
  assert.equal(errs.length, 1)
  assert.match(errs[0]!, /戊/)
  assert.match(errs[0]!, /漏连 pre/)
})

// ---- assumes 缺席合法 ----

test('conceptSufficiencyGateErrors：无 assumes 的节点不受约束', () => {
  const { nodes, graph, entries } = fixture()
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], teaches: { 幂: '知道' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 增量判据：只裁本批新增 ----

test('conceptSufficiencyGateErrors：存量节点的不充分 assumes 不被追溯', () => {
  // 存量节点 丙 已经 assumes 了某概念但该概念没被教——不追溯
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [] },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [], assumes: { 未教概念: '会用' } },
    { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
  ]
  const graph = new Graph(nodes)
  const entries: ConceptEntry[] = [{ canonical: '未教概念' }]
  // 新增丁，不带 assumes → 不应因乙的存量 assumes 报错
  const ops: EditOp[] = [
    { op: 'add_node', name: '丙', pre: ['乙'], teaches: { 分式: '知道' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 门序列同拦 ----

test('conceptSufficiencyGateErrors：通过 editGateErrors 序列覆盖', async () => {
  const { nodes, graph, entries } = fixture()
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['甲'], assumes: { 分数: '会用' }, operator: '新增' },
  ]
  const spec: EditProposalSpec = {
    course: '数学',
    ops,
    note: { reason: 'r', target_endpoints: ['终点甲'] },
  }
  const errs = await editGateErrors(spec, { nodes, graph, entries, anchors })
  assert.ok(errs.some(e => e.includes('档位不足')), `门序列应含充分性门错误，实际：${errs.join('\n')}`)
})

// ---- 多条 assumes 逐条裁决 ----

test('conceptSufficiencyGateErrors：多条 assumes 各自独立裁决', () => {
  const { nodes, graph, entries } = fixture()
  // 丁 pre=[乙]，闭包 = {乙, 甲}
  // 分式: 乙 teaches 分式:会用 ≥ 会用 → 过
  // 分数: 甲 teaches 分数:知道 < 能教 → 越档
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['乙'], assumes: { 分式: '会用', 分数: '能教' }, operator: '新增' },
  ]
  const errs = conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors)
  assert.equal(errs.length, 1)
  assert.match(errs[0]!, /分数/)
  assert.match(errs[0]!, /档位不足/)
})

// ---- 多祖先教同一概念不同档位 → 取最高档 ----

test('conceptSufficiencyGateErrors：多祖先教同一概念不同档 → 取最高档放行', () => {
  // 甲 teaches 分数:知道，乙 pre=[甲] teaches 分数:能教
  // 丁 pre=[乙]，闭包 = {乙, 甲}；分数最高档 = 能教 ≥ 会用 → 放行
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [], teaches: { 分数: '知道' } },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [], teaches: { 分数: '能教' } },
    { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
  ]
  const graph = new Graph(nodes)
  const entries: ConceptEntry[] = [{ canonical: '分数' }]
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['乙'], assumes: { 分数: '会用' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

// ---- 无前置节点 ----

test('conceptSufficiencyGateErrors：无前置节点 + assumes 图内没人教 → 放行', () => {
  const { nodes, graph, entries } = fixture()
  // 丁 pre=[]，闭包 = {}（空）
  // 对数 不在图内 → 放行（跨课首引）
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: [], assumes: { 对数: '会用' }, operator: '新增' },
  ]
  assert.deepEqual(conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors), [])
})

test('conceptSufficiencyGateErrors：无前置节点 + assumes 图内有人教 → 拒（漏连 pre）', () => {
  const { nodes, graph, entries } = fixture()
  // 丁 pre=[]，闭包 = {}（空）
  // 分数 在图内被甲教 → 拒（漏连 pre）
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: [], assumes: { 分数: '知道' }, operator: '新增' },
  ]
  const errs = conceptSufficiencyGateErrors(ops, nodes, graph, entries, anchors)
  assert.equal(errs.length, 1)
  assert.match(errs[0]!, /漏连 pre/)
})
