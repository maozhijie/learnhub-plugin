import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph, GraphStore } from '../src/engine/graph.ts'
import { runAudit } from '../src/engine/audit.ts'
import { graphHealthScore } from '../src/engine/health.ts'
import { renderGrowthGraphView, renderNodeCard } from '../src/engine/coach-tools.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { withVault } from './helpers/vault.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'

// 终点感知面与统计口径（#200 / ADR-0055+0056；#239 / ADR-0076 多终点化）：
// - isEndpoint 读侧派生：分析载荷与 GraphDoc 节点带 isEndpoint，一切消费面读锚集合现算；
// - 口径豁免：stats.leaves / 空降建议 / 健康分 floats 分母 / 审计 R1 剔**每个**终点；
//   max_depth 保留终点并正名主线深度；
// - 教练面恒标：图面与节点卡带逐终点行（轻量段同吃图面），轻量上下文包带每行终点；
// - 伪终点措辞废除：contextPack「无后继即终点」启发式改读锚集合。

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

/** 锚容器原文：每条 = 一条锚（逐条缺省 = capability + 起草留痕；#239 多终点化）。 */
function anchorDoc(...endpoints: string[]): string {
  const list = endpoints.length ? endpoints : ['终点']
  const anchors = list.map(endpoint => ({
    endpoint,
    goal_type: 'capability',
    declared: '2026-09-01',
    origin_proposal: 1,
    seed_nodes: [endpoint === '终点' ? '起点一' : endpoint === '第二终点' ? '起点二' : '起点', endpoint],
    start_basis: { [endpoint === '终点' ? '起点一' : endpoint === '第二终点' ? '起点二' : '起点']: 'baseline' },
  }))
  return JSON.stringify({ version: 2, anchors }, null, 1) + '\n'
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
      endpoints: string[]
      stats: { leaves: number; max_depth: number | null }
      nodes: Array<{ data: { id: string; isEndpoint: boolean } }>
    }
    assert.deepEqual(doc.endpoints, ['终点'])
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
    const aware = graphHealthScore(graph, { endpoints: new Set(['终点']) })
    assert.equal(aware.breakdown.pre_completeness, 10)
  })
})

test('#200 审计：R1 豁免终点（对照旁支叶子照告）；基线叶子剔终点、深度读数正名图深度（ADR-0076 多终点无单一主线）', async () => {
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
    assert.equal(result.baseline['图深度'], 1, '图深度保留终点（原「主线深度」正名——ADR-0076：多终点下没有单一主线可指，口径不变 = 全图最长路径）')
  })
})

test('#200 教练图面与节点卡恒标终点（facade 取图）：头部终点行、细节行 ⚑、方向标记措辞', async () => {
  await withVault({
    graph: ANOMALY_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
  }, async ({ engine }) => {
    const graph = await graphOf(engine)
    const view = renderGrowthGraphView(graph, {}, new Set(['终点']))
    assert.ok(view.includes('⚑ 终点：终点（方向标记'), '图面头部恒带终点行')
    assert.ok(view.includes('不可 del/rename'), '终点行带锚保护语义')
    assert.ok(!view.includes('（零终点'), '有锚不给零终点行')
    const bare = renderGrowthGraphView(graph, {})
    assert.ok(bare.includes('（零终点——空锚是合法空态'), '零终点给合法空态行')

    const card = renderNodeCard(graph, {}, '终点', new Set(['终点']))
    assert.ok(card.includes('⚑ 终点（方向标记）'), '终点卡标题带标记')
    assert.ok(card.includes('不被学习调度'), '终点卡带方向标记语义（ADR-0056）')
    const plain = renderNodeCard(graph, {}, '旁支叶子', new Set(['终点']))
    assert.ok(!plain.includes('方向标记'), '普通节点卡不带终点标记')
  })
})

test('#200 教练上下文包：轻量段恒带一行终点；全量包终点锚区块带方向标记', async () => {
  await withVault({
    graph: ANOMALY_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc() }],
  }, async ({ engine }) => {
    const today = '2026-09-13'
    const light = await engine.growth2.coachContextPack('数学', { today, lightweight: true })
    assert.ok(light.includes('⚑ 终点：终点（方向标记'), '轻量段也带终点行（一行名字的 token 换裁决不盲）')
    assert.ok(!light.includes('## 终点锚'), '轻量段仍不带终点锚区块（恰两件不变）')
    const full = await engine.growth2.coachContextPack('数学', { today })
    assert.ok(full.includes('⚑ 终点：终点（方向标记'), '包头终点行恒在')
    assert.ok(full.includes('终点节点：终点（方向标记，不可 del/rename'), '终点锚区块带方向标记')
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
    const endpointPack = engine.content.contextPack(graph, {}, '终点', '数学', { endpoints: new Set(['终点']) })
    assert.ok(endpointPack.includes('本节点是锚集合锚定的终点'), '真终点才获终点措辞')
  })
})

// ---- #239 多终点化：锚集合的逐终点判定（票面验收） ----

/** 两终点形态：起点一→终点甲（陈旧接线），起点二→终点乙；旁支叶子作 R1 对照。 */
const TWO_ENDPOINT_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 起步块',
  '    nodes:',
  '      - { name: 起点一, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 起点二, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 终点甲, pre: [起点一], opt: false, note: "" }',
  '      - { name: 终点乙, pre: [起点二], opt: false, note: "" }',
  '      - { name: 旁支叶子, pre: [起点一], opt: false, note: "", est: 10 }',
].join('\n')

test('#239 两终点：图面/分析载荷/审计/健康分逐终点判定（一个都不漏）', async () => {
  await withVault({
    graph: TWO_ENDPOINT_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc('终点甲', '终点乙') }],
    notes: { 起点一: { stage: 'review' }, 起点二: { stage: 'review' } },
  }, async ({ engine }) => {
    const graph = await graphOf(engine)
    // 图面：两个终点各一行、各带 ⚑；节点卡逐个认领
    const doc = await engine.graph.graphAnalyze('数学') as {
      endpoints: string[]
      stats: { leaves: number }
      nodes: Array<{ data: { id: string; isEndpoint: boolean } }>
    }
    assert.deepEqual(doc.endpoints.slice().sort(), ['终点乙', '终点甲'], '图面载荷带全部终点')
    assert.deepEqual(doc.nodes.filter(n => n.data.isEndpoint).map(n => n.data.id).sort(), ['终点乙', '终点甲'], '两个终点都带 isEndpoint')
    // 图叶子 = 两个终点 + 旁支叶子；剔两个终点后只剩旁支叶子
    assert.equal(doc.stats.leaves, 1, 'stats.leaves 剔全部终点')
    // 审计 R1：两个终点都不告警（旁支叶子照告）
    const result = await runAudit(engine.paths, 'math', '数学', graph, graph.regions, '2026-09-13', nodeVaultFs)
    const r1 = result.warns.filter(w => w.startsWith('R1 '))
    assert.ok(r1.some(w => w.includes('旁支叶子')), '普通浅叶子照常告警（对照）')
    assert.ok(!r1.some(w => w.includes('终点甲') || w.includes('终点乙')), 'R1 对两个终点都不告警')
    assert.equal(result.baseline['叶子（无后继，不含终点）'], 1, '基线叶子剔全部终点')
    // 基线端点行逐终点列出（不是只报第一个）
    assert.match(String(result.baseline['终点锚']), /终点甲.*终点乙/, '基线终点锚行列出全部终点')
    // 健康分：两个终点都不入空降清单不计分母（图内无空降 → 满分）
    assert.equal(graphHealthScore(graph, { endpoints: new Set(doc.endpoints) }).breakdown.pre_completeness, 20)
    // 教练图面：两行终点
    const view = renderGrowthGraphView(graph, {}, new Set(doc.endpoints))
    assert.ok(view.includes('⚑ 终点：终点甲') && view.includes('⚑ 终点：终点乙'), '图面逐终点标记')
  })
})

test('#239 两终点：生成门对两个终点都恒拒（学习者面剔全部终点）', async () => {
  await withVault({
    graph: TWO_ENDPOINT_GRAPH,
    files: [{ path: '学习中心/math/state/终点锚.json', content: anchorDoc('终点甲', '终点乙') }],
  }, async ({ engine }) => {
    for (const endpoint of ['终点甲', '终点乙']) {
      await assert.rejects(() => engine.content2.contentPack('数学', endpoint), /终点是方向标记，不被学习调度/, `${endpoint} 生成门恒拒`)
    }
    // 非终点照常组装
    const pack = await engine.content2.contentPack('数学', '旁支叶子')
    assert.match(pack, /生成上下文包：旁支叶子/)
    // 学习者面：就绪清单与推荐都不含两个终点
    const status = await engine.statusJson()
    const course = status.courses.find(c => c.name === '数学')!
    const listed = [...course.ready.map(r => r.node), ...course.gated.map(g => g.node)]
    assert.ok(!listed.includes('终点甲') && !listed.includes('终点乙'), '就绪/软闸清单剔全部终点')
    const rec = await engine.recommend(30)
    const nodes = rec.events.filter(e => e.course === '数学').map(e => e.node)
    assert.ok(!nodes.includes('终点甲') && !nodes.includes('终点乙'), '推荐面剔全部终点')
  })
})

test('#239 零终点（空锚）：读侧一切面不炸，教练回合与罗盘给出明确失败', async () => {
  await withVault({
    graph: TWO_ENDPOINT_GRAPH,
    files: [{
      path: '学习中心/math/state/终点锚.json',
      content: JSON.stringify({ version: 2, anchors: [] }, null, 1) + '\n',
    }],
  }, async ({ engine }) => {
    // 读侧：分析载荷零终点、审计/健康分/上下文包/状态全不炸
    const doc = await engine.graph.graphAnalyze('数学') as { endpoints: string[] }
    assert.deepEqual(doc.endpoints, [])
    const full = await engine.growth2.coachContextPack('数学')
    assert.ok(full.includes('零终点——空锚是合法空态'), '上下文包给零终点明确行')
    const check = await engine.growth2.coachCheckFor({ id: 'math-01', name: '数学', root: 'math', enabled: true }, '2026-09-13')
    assert.equal(check.cold_start, false, '零终点不判冷启动')
    assert.equal(check.exhausted, false, '零终点不算课程尾段')
    assert.deepEqual(await engine.courseCompletion({ name: '数学', root: 'math' }), [])
    // 教练回合 / 罗盘初画 / 罗盘重写：明确失败（不是「未播种」也不是静默空转）
    await assert.rejects(
      () => engine.growth2.coachGrowthBatch('数学', {} as never, { force: true }),
      /零终点（空锚是合法空态）——教练回合要有一个方向才能裁决/,
    )
    await assert.rejects(() => engine.growth2.compassPaint('数学', {} as never), /零终点（空锚是合法空态）——罗盘初画锚在终点上/)
    await assert.rejects(() => engine.growth2.compassRewrite('数学', '- 条目'), /零终点（空锚是合法空态）——罗盘重写锚在终点上/)
    // 空锚课程的罗盘读数：零终点（合法空态）
    const compass = await engine.growth2.compassRead('数学')
    assert.deepEqual(compass.anchors, [])
  })
})

test('#240 零节点闸：名称建课的空图判停摆（不入自动触发点）——判据自然通过零告警', async () => {
  await withVault({}, async ({ engine }) => {
    const created = await engine.graph.createCourse('物理')
    assert.deepEqual(created, { id: '物理-01', name: '物理', root: '物理', enabled: true }, '建课返回注册表条目')
    const check = await engine.growth2.coachCheckFor(created, '2026-09-14')
    assert.equal(check.exhausted, true, '零节点图同判停摆（零节点闸）——刚建课不入任何自动触发点')
    assert.equal(check.ok, true, '停摆是判据满足的自然结果，不是故障')
    assert.equal(check.cold_start, false, '零终点不判冷启动')
    assert.deepEqual(check.warnings, [], '合法空态零告警（ready=0 不告警：exhausted 短路在前）')
    // 脚手架齐活：空锚是合法空态（零终点、零悬空——体检口径的 Broken 不存在）
    const book = JSON.parse(await nodeVaultFs.readFile(engine.paths.anchorPath('物理'), 'utf8')) as { anchors: unknown[] }
    assert.deepEqual(book.anchors, [])
  })
})
