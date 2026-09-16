import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph, groupView } from '../src/engine/graph/graph.ts'
import type { GNode } from '../src/engine/types.ts'
import type { ConceptEntry } from '../src/engine/concepts/concepts.ts'

// #278 读侧分组轴（Epic #275 T2）：groupView 纯新增原语。
// 只断言外部行为——哪些节点进哪些组、单归属 vs 重叠、组名来源；不断言内部字段。

function gnode(partial: Partial<GNode> & { name: string }): GNode {
  return { pre: [], opt: false, note: '', enc: [], ...partial }
}

function graphOf(nodes: GNode[]): Graph {
  return new Graph(nodes)
}

const entry = (canonical: string, aliases: string[] = []): ConceptEntry =>
  ({ canonical, aliases }) as ConceptEntry

test('depth 轴：每节点恰一组，组名 L{k} 按深度升序；节点按图序排布', () => {
  const graph = graphOf([
    gnode({ name: '地基' }),
    gnode({ name: '中层', pre: ['地基'] }),
    gnode({ name: '另一地基' }),
    gnode({ name: '高层', pre: ['中层', '另一地基'] }),
  ])
  const groups = groupView(graph, 'depth')
  assert.deepEqual(groups, [
    { label: 'L0', nodes: ['地基', '另一地基'] },
    { label: 'L1', nodes: ['中层'] },
    { label: 'L2', nodes: ['高层'] },
  ])
  // 单归属：节点出现总次数 = 节点数
  const total = groups.reduce((s, g) => s + g.nodes.length, 0)
  assert.equal(total, graph.names.length)
})

test('depth 轴：环图返回显式「无法分层」态，不是空数组（#270 作废署名：空 ≠ 没有）', () => {
  const graph = graphOf([
    gnode({ name: '甲', pre: ['乙'] }),
    gnode({ name: '乙', pre: ['甲'] }),
    gnode({ name: '圈外' }),
  ])
  const groups = groupView(graph, 'depth')
  assert.equal(groups.length, 1)
  assert.match(groups[0]!.label, /无法分层/)
  assert.ok(groups[0]!.nodes.length > 0, '环上节点显式在场')
})

test('concept 轴：成员 = teaches ∪ assumes 该概念的节点；别名归并 canonical；节点可重叠进多组', () => {
  const graph = graphOf([
    gnode({ name: '甲', teaches: { 导数: '会用' } }),
    gnode({ name: '乙', assumes: { 微分: '知道' } }), // 微分 = 导数的别名
    gnode({ name: '丙', teaches: { 函数: '能教' } }),
  ])
  const groups = groupView(graph, 'concept', {
    conceptEntries: [entry('导数', ['微分']), entry('函数')],
  })
  const byLabel = new Map(groups.map(g => [g.label, g.nodes]))
  assert.deepEqual(byLabel.get('导数'), ['甲', '乙'], '别名「微分」归并到 canonical「导数」')
  assert.deepEqual(byLabel.get('函数'), ['丙'])
  // 重叠：乙 若同教函数则进多组——这里用甲换教函数验证
  const graph2 = graphOf([
    gnode({ name: '甲', teaches: { 导数: '会用', 函数: '能教' } }),
  ])
  const groups2 = groupView(graph2, 'concept')
  assert.equal(groups2.length, 2)
  assert.ok(groups2.every(g => g.nodes.includes('甲')), '一个节点可进多组')
})

test('concept 轴：未标概念的节点显式缺席（「未标概念」组在场，不是静默丢失）', () => {
  const graph = graphOf([
    gnode({ name: '标了', teaches: { 导数: '会用' } }),
    gnode({ name: '没标' }),
  ])
  const groups = groupView(graph, 'concept')
  const untagged = groups.find(g => g.label === '未标概念')
  assert.ok(untagged, '未标概念组显式在场')
  assert.deepEqual(untagged!.nodes, ['没标'])
})

test('endpoint 轴：成员 = 终点前置闭包去自身；闭包相交处节点进多组；悬空锚不入算；零终点 = 空', () => {
  const graph = graphOf([
    gnode({ name: '地基' }),
    gnode({ name: '中继', pre: ['地基'] }),
    gnode({ name: '终点甲', pre: ['中继'] }),
    gnode({ name: '终点乙', pre: ['中继', '地基'] }),
  ])
  const groups = groupView(graph, 'endpoint', { endpoints: ['终点甲', '终点乙', '悬空锚'] })
  const byLabel = new Map(groups.map(g => [g.label, g.nodes]))
  assert.deepEqual(byLabel.get('终点甲'), ['地基', '中继'])
  assert.deepEqual(byLabel.get('终点乙'), ['地基', '中继'])
  assert.ok(!byLabel.has('悬空锚'), '悬空锚不入算')
  assert.equal(byLabel.get('终点甲')!.length, 2, '终点自身不在成员内')
  // 重叠：地基/中继 同时服务两个终点（闭包相交）
  const serving = groups.filter(g => g.nodes.includes('中继'))
  assert.equal(serving.length, 2)
  assert.deepEqual(groupView(graph, 'endpoint', { endpoints: [] }), [], '零终点 = 空组列表')
  assert.deepEqual(groupView(graph, 'endpoint'), [], '缺省 endpoints = 空组列表')
})
