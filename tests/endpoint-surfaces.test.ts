import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph, GraphStore } from '../src/engine/graph.ts'
import { runAudit } from '../src/engine/audit.ts'
import { graphHealthScore } from '../src/engine/health.ts'
import { renderGrowthGraphView, renderNodeCard } from '../src/engine/coach-tools.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { withVault } from './helpers/vault.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'

// 终点感知面与统计口径（#200 / ADR-0055+0056）：
// - isEndpoint 读侧派生：分析载荷与 GraphDoc 节点带 isEndpoint，一切消费面读锚现算；
// - 口径豁免：stats.leaves / 空降建议 / 健康分 floats 分母 / 审计 R1 剔终点；
//   max_depth 保留终点并正名主线深度；
// - 教练面恒标：图面与节点卡带终点行（轻量段同吃图面），轻量上下文包带一行终点；
// - 伪终点措辞废除：contextPack「无后继即终点」启发式改读锚。

/** 异常态形态（ADR-0055 实机「数学」课同构）：终点.pre 仍是种子起点（陈旧接线、
 * 深度 1）、生长 1 节点未汇入终点闭包；旁支叶子作 R1 对照（该告警的、与不该告警的）。 */
const ANOMALY_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 起步块',
  '    nodes:',
  '      - { name: 起点一, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 起点二, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 终点, pre: [起点一, 起点二], opt: false, note: "" }',
  '  - name: 生长块',
  '    nodes:',
  '      - { name: 生长台阶, pre: [起点一], opt: false, note: "", est: 15 }',
  '      - { name: 旁支叶子, pre: [起点二], opt: false, note: "", est: 10 }',
].join('\n')

/** 已接线形态：终点接在生长台阶之后（深度 2、全图最深）——主线深度保留终点的判据场景。 */
const WIRED_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 起步块',
  '    nodes:',
  '      - { name: 起点一, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 起点二, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 终点, pre: [生长台阶], opt: false, note: "" }',
  '  - name: 生长块',
  '    nodes:',
  '      - { name: 生长台阶, pre: [起点一], opt: false, note: "", est: 15 }',
  '      - { name: 旁支叶子, pre: [起点二], opt: false, note: "", est: 10 }',
].join('\n')

/** 双区图（两文件）：region 序靠后的「终点」与「空降节点」都无 pre——健康分 floats 豁免的判据场景。 */
const FLOAT_GRAPH = [
  'region: 一',
  'color: blue',
  'blocks:',
  '  - name: 起点块',
  '    nodes:',
  '      - { name: 起点, pre: [], opt: false, note: "", est: 20 }',
].join('\n')
const FLOAT_GRAPH_REGION2 = [
  'region: 二',
  'color: red',
  'blocks:',
  '  - name: 后区',
  '    nodes:',
  '      - { name: 终点, pre: [], opt: false, note: "" }',
  '      - { name: 空降节点, pre: [], opt: false, note: "", est: 15 }',
].join('\n')

function anchorDoc(endpoint = '终点'): string {
  return JSON.stringify({
    version: 1,
    endpoint,
    goal_type: 'capability',
    declared: '2026-09-01',
    origin_proposal: 1,
    seed_nodes: [endpoint === '终点' ? '起点一' : '起点', endpoint],
    start_basis: { [endpoint === '终点' ? '起点一' : '起点']: 'baseline' },
  }, null, 1) + '\n'
}

async function graphOf(engine: LearnhubEngine): Promise<Graph> {
  const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('math'), nodeVaultFs).load()
  return new Graph(regions)
}

test('#200 分析载荷：isEndpoint 读锚派生；stats.leaves 剔终点、主线深度保留终点', async () => {
  await withVault({
    graph: WIRED_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
  }, async ({ engine }) => {
    const doc = await engine.graph.graphAnalyze('数学') as {
      endpoint: string | null
      stats: { leaves: number; max_depth: number }
      nodes: Array<{ data: { id: string; isEndpoint: boolean } }>
    }
    assert.equal(doc.endpoint, '终点')
    const marks = doc.nodes.filter(n => n.data.isEndpoint).map(n => n.data.id)
    assert.deepEqual(marks, ['终点'], '只有锚定的终点带 isEndpoint')
    // 图叶子 = 终点 + 旁支叶子；剔终点后只剩旁支叶子
    assert.equal(doc.stats.leaves, 1, 'stats.leaves 剔终点')
    // 终点（depth 2）是全图最深节点——主线深度保留终点
    assert.equal(doc.stats.max_depth, 2, '主线深度保留终点（课程长到哪里的进度读数）')
  })
})

test('#200 健康分：前置完备项的空降清单与分母剔终点', async () => {
  await withVault({
    graph: FLOAT_GRAPH,
    graphFile: '00_一.yaml',
    files: [
      { path: '学习中心/math/data/01_二.yaml', content: FLOAT_GRAPH_REGION2 },
      { path: '学习中心/math/state/终点锚.json', content: anchorDoc('终点') },
    ],
  }, async ({ engine }) => {
    const graph = await graphOf(engine)
    // 旧口径：floats = [终点, 空降节点] 两条 / 3 节点 → 6.7
    const blind = graphHealthScore(graph)
    assert.equal(blind.breakdown.pre_completeness, 6.7)
    // 新口径：终点不入空降清单不计分母 → floats = [空降节点] 一条 / 2 节点 → 10
    const aware = graphHealthScore(graph, { endpoint: '终点' })
    assert.equal(aware.breakdown.pre_completeness, 10)
  })
})

test('#200 审计：R1 豁免终点（对照旁支叶子照告）；基线叶子剔终点、最大深度正名主线深度', async () => {
  await withVault({
    graph: ANOMALY_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
  }, async ({ engine }) => {
    const graph = await graphOf(engine)
    const result = await runAudit(engine.paths, 'math', '数学', graph, graph.regions, '2026-09-13', nodeVaultFs)
    const r1 = result.warns.filter(w => w.startsWith('R1 '))
    assert.ok(r1.length > 0, '浅叶子告警在（非种子图）')
    assert.ok(r1.every(w => !w.includes('终点')), 'R1 不再对终点告警')
    assert.ok(r1.some(w => w.includes('旁支叶子')), '普通浅叶子照常告警（对照）')
    assert.equal(result.baseline['叶子（无后继，不含终点）'], 2, '基线叶子剔终点（终点/旁支叶子/生长台阶 − 终点）')
    assert.equal(result.baseline['主线深度'], 1, '主线深度保留终点（陈旧接线下恒 1，正是异常态读数）')
  })
})

test('#200 教练图面与节点卡恒标终点（facade 取图）：头部终点行、细节行 ⚑、承诺标记措辞', async () => {
  await withVault({
    graph: ANOMALY_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
  }, async ({ engine }) => {
    const graph = await graphOf(engine)
    const view = renderGrowthGraphView(graph, {}, '终点')
    assert.ok(view.includes('⚑ 终点：终点（承诺标记'), '图面头部恒带终点行')
    assert.ok(view.includes('不可 del/rename'), '终点行带锚保护语义')
    assert.ok(!view.includes('（未播种'), '已播种不给未播种行')
    const bare = renderGrowthGraphView(graph, {})
    assert.ok(bare.includes('（未播种——终点锚 Missing'), '未传终点（未播种形态）给合法空态行')

    const card = renderNodeCard(graph, {}, '终点', '终点')
    assert.ok(card.includes('⚑ 终点（承诺标记）'), '终点卡标题带标记')
    assert.ok(card.includes('不被学习调度'), '终点卡带承诺标记语义（ADR-0056）')
    const plain = renderNodeCard(graph, {}, '旁支叶子', '终点')
    assert.ok(!plain.includes('承诺标记'), '普通节点卡不带终点标记')
  })
})

test('#200 教练上下文包：轻量段恒带一行终点；全量包终点锚区块带承诺标记', async () => {
  await withVault({
    graph: ANOMALY_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
  }, async ({ engine }) => {
    const today = '2026-09-13'
    const light = await engine.growth2.coachContextPack('数学', { today, lightweight: true })
    assert.ok(light.includes('⚑ 终点：终点（承诺标记'), '轻量段也带终点行（一行名字的 token 换裁决不盲）')
    assert.ok(!light.includes('## 终点锚'), '轻量段仍不带终点锚区块（恰两件不变）')
    const full = await engine.growth2.coachContextPack('数学', { today })
    assert.ok(full.includes('⚑ 终点：终点（承诺标记'), '包头终点行恒在')
    assert.ok(full.includes('终点节点：终点（承诺标记，不可 del/rename'), '终点锚区块带承诺标记')
  })
})

test('#200 伪终点措辞废除：普通叶子（无后继）不再误标终点；终点措辞只随锚走', async () => {
  await withVault({
    graph: ANOMALY_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
    notes: { 起点一: {}, 起点二: {}, 终点: {}, 生长台阶: {}, 旁支叶子: {} },
  }, async ({ engine }) => {
    const graph = await graphOf(engine)
    // 旧口径对任何无后继节点写「（无后继，终点节点）」——旁支叶子被误标
    const pack = await engine.content2.contentPack('数学', '旁支叶子')
    assert.ok(pack.includes('（无后继）'), '普通前沿叶子给中性措辞')
    assert.ok(!pack.includes('终点节点'), '不再误标终点')
    // 终点措辞只随锚走（生成门恒拒终点，此分支是 contextPack 直调时的防御性诚实措辞）
    const endpointPack = engine.content.contextPack(graph, {}, '终点', '数学', { endpoint: '终点' })
    assert.ok(endpointPack.includes('本节点是终点锚锚定的终点'), '真终点才获终点措辞')
  })
})
