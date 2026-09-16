import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Graph, GraphStore, loadGraphDoc } from '../src/engine/graph.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import type { GNode } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'

// 图加载的两类缺失拆开报（#61 排查误导教训）：「目录不存在」（建课前/课程被挪走）
// 与「目录在但缺 data/图.yaml」（真异常，#284 存储塌缩后一课程一文件）曾是同一句
// 「为空或不存在」——排查方向直接被带偏（现场第一反应是 vault 挪了位置）。

test('GraphStore.load：data 目录不存在与缺图文件分别报因，不再合并成一句', async () => {
  const base = await mkdtemp(join(tmpdir(), 'learnhub-graphload-'))
  try {
    const missing = new GraphStore(null as never, join(base, '没有课程'), nodeVaultFs)
    await assert.rejects(() => missing.load(), (err: Error) => {
      assert.match(err.message, /数据目录不存在: /)
      assert.doesNotMatch(err.message, /为空/, '旧合并文案必须退役')
      return true
    })

    const emptyRoot = join(base, '空课程')
    await mkdir(join(emptyRoot, 'data'), { recursive: true })
    const empty = new GraphStore(null as never, emptyRoot, nodeVaultFs)
    await assert.rejects(() => empty.load(), /图文件不存在（应有 data\/图\.yaml）: /)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// 防复活门文档级半边（ADR-0090 裁决 1）：旧 v3 分区文件顶层混着 regions/color/blocks
// 不得被静默忽略着带 nodes 过关——节点级的 RETIRED_NODE_KEYS 之外还有这一层。
test('loadGraphDoc：顶层历史结构键（regions/color/blocks）fail loud 拒收', () => {
  assert.throws(() => loadGraphDoc({ regions: [{ name: '一', blocks: [] }], nodes: [] }, 'x/图.yaml'),
    /顶层不接受 regions.*请删除重建/)
  assert.throws(() => loadGraphDoc({ color: { 一: 'blue' }, nodes: [{ name: '甲', pre: [], opt: false, note: '', enc: [] }] }, 'x/图.yaml'),
    /顶层不接受 color/)
  assert.throws(() => loadGraphDoc({ blocks: {}, nodes: [] }, 'x/图.yaml'), /顶层不接受 blocks/)
  assert.doesNotThrow(() => loadGraphDoc({ nodes: [] }, 'x/图.yaml'))
})

// ---- #270：概念反向映射 / upstreamClosure 悬空守卫 / 环语义裁定 ----

function gnode(partial: Partial<GNode> & { name: string }): GNode {
  return { pre: [], opt: false, note: '', enc: [], ...partial }
}

function graphOf(nodes: GNode[]): Graph {
  return new Graph(nodes)
}

test('Graph 构造期反向映射 taughtByOf/assumedByOf：与 names 序扫折叠逐字一致（#270 单一出处）', () => {
  const graph = graphOf([
    gnode({ name: '乙', teaches: { 概念1: '会用' }, assumes: { 概念2: '知道' } }),
    gnode({ name: '甲', teaches: { 概念1: '知道', 概念3: '能教' } }),
    gnode({ name: '丙', assumes: { 概念1: '会用' } }),
  ])
  // 手工折叠（renderConceptFootprint 旧实现同款：names 序扫）
  const teachers: Record<string, string[]> = {}
  const assumers: Record<string, string[]> = {}
  for (const n of graph.names) {
    for (const c of Object.keys(graph.teachesOf[n] ?? {})) (teachers[c] ??= []).push(n)
    for (const c of Object.keys(graph.assumesOf[n] ?? {})) (assumers[c] ??= []).push(n)
  }
  assert.deepEqual(graph.taughtByOf, teachers)
  assert.deepEqual(graph.assumedByOf, assumers)
  assert.deepEqual(graph.taughtByOf['概念1'], ['乙', '甲'], '节点序 = names 序（乙 先于 甲）')
})

test('upstreamClosure 悬空前置不炸（#270 先补守卫）：断边名不入闭包，悬空名入参退化 {自身}', () => {
  // ADR-0085 给定构造：names=[A,C]、preOf={A:[X],C:[A]}、X 悬空 → 旧实现 TypeError
  const graph = graphOf([gnode({ name: 'A', pre: ['X'] }), gnode({ name: 'C', pre: ['A'] })])
  assert.deepEqual([...graph.upstreamClosure('C')].sort(), ['A', 'C'], 'X 悬空不入闭包')
  assert.deepEqual([...graph.upstreamClosure('A')], ['A'])
  assert.deepEqual([...graph.upstreamClosure('X')], ['X'], '悬空名入参 → {自身}')
})

test('环语义裁定（ADR-0085 选项 a，#270）：isAncestor 与 upstreamClosure 环上同口径', () => {
  const graph = graphOf([
    gnode({ name: 'A', pre: ['C'] }),
    gnode({ name: 'B', pre: ['A'] }),
    gnode({ name: 'C', pre: ['B'] }),
  ])
  assert.ok(graph.hasCycle)
  for (const a of graph.names) {
    for (const n of graph.names) {
      assert.equal(
        graph.isAncestor(a, n),
        a !== n && graph.upstreamClosure(n).has(a),
        `isAncestor(${a}, ${n}) 与 upstreamClosure 同口径`,
      )
    }
  }
  assert.ok(graph.isAncestor('A', 'B'), '环上真可达（旧实现 reach 空 → 恒 false）')
})

test('作废署名（#270）：环上 depth/edges 空 + hasCycle 显式旗标；reach 真实非空', () => {
  const graph = graphOf([
    gnode({ name: 'A', pre: ['C'] }),
    gnode({ name: 'B', pre: ['A'] }),
    gnode({ name: 'C', pre: ['B'] }),
  ])
  assert.deepEqual(graph.depth, {}, 'depth 环上作废（空表，hasCycle 区分「算不出」与「真的没有」）')
  assert.deepEqual(graph.edges, [], 'edges 环上作废')
  assert.ok(graph.reach['A'] instanceof Set && graph.reach['A']!.size > 0, 'reach 环上也算得出真可达')
})

// ---- graphPath 悬空容错（#270 第五处）：parent 回溯 BFS 与 upstreamClosure 同一口径 ----

test('graphPath：悬空前置不入链不炸，真实前置链照常返回（#270）', async () => {
  await withVault({
    graph: [
      'nodes:',
      '  - { name: 甲, pre: [幽灵], opt: false, note: "", est: 10 }',
      '  - { name: 乙, pre: [甲], opt: false, note: "", est: 10 }',
    ].join('\n'),
  }, async ({ engine }) => {
    const r = await engine.graph.graphPath('数学', '甲', '乙') as {
      related: boolean; chain: string[]; direct: boolean
    }
    assert.equal(r.related, true, '甲是乙的直接前置——悬空邻居不影响真实链')
    assert.equal(r.direct, true)
    assert.deepEqual(r.chain, ['甲', '乙'], '幽灵不入链（它不是可学的节点；旧实现在我 preOf[幽灵] 处 TypeError）')
  })
})
