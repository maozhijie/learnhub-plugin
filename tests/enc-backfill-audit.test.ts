import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Content } from '../src/engine/content.ts'
import { todayStr } from '../src/engine/dates.ts'
import { Graph, GraphStore } from '../src/engine/graph.ts'
import { runAudit } from '../src/engine/audit.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import type { GNode, GRegion } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 甲, pre: [], opt: false, note: "", est: 10 }',
  '      - { name: 乙, pre: [甲], opt: false, note: "", est: 20 }',
  '      - { name: 丙, pre: [], opt: false, note: "", est: 10 }',
].join('\n')

/** 乙：已有 Ready 内容（sections.ready）+ 正文声明 enc_candidates（反哺候选源）。 */
const NOTE_乙 = [
  '---',
  'node: 乙',
  'stage: review',
  'fsrs:',
  '  stability: 5',
  '  difficulty: 5',
  '  due: 2099-01-01',
  '  last_review: 2099-01-01',
  '  reps: 1',
  '  lapses: 0',
  'content:',
  '  version: 3',
  '  generated_at: 2026-09-01',
  '  status: reviewed',
  '  sections:',
  '    - { id: s1, title: 概念：乙, type: 概念, status: ready, version: 2 }',
  'practice:',
  '  attempts: 1',
  '  correct: 1',
  '---',
  '',
  '# 乙',
  '',
  '乙正文讲解。',
  '',
  '<!-- enc_candidates: [甲] -->',
].join('\n')

/** 甲乙丙三节点课程（图文件名 00_基础.yaml）；乙用原始笔记，甲丙用共享工厂缺省笔记。 */
const ENC_VAULT = {
  graph: GRAPH,
  graphFile: '00_基础.yaml',
  notes: { 甲: {}, 乙: `${NOTE_乙}\n`, 丙: {} },
}

async function auditOf(engine: LearnhubEngine) {
  const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('math')).load()
  const graph = new Graph(regions)
  return runAudit(engine.paths, 'math', '数学', graph, regions, todayStr(new Date()))
}

// ---- 纯函数：候选收集 / 提升 / 反哺 hints / 内容级审计 ----

function node(partial: Partial<GNode> & { name: string }): GNode {
  return { pre: [], opt: false, note: '', enc: [], ...partial }
}

function graphOf(nodes: GNode[]): Graph {
  const regions: GRegion[] = [{ name: '基础', color: 'blue', blocks: [{ name: '块', nodes }] }]
  return new Graph(regions)
}

test('candidateCallSites：enc_candidates 块 + 练习 uses 各计一站并去重', () => {
  const body = [
    '正文。',
    '<!-- ex:1 | uses: [甲, 乙] | answer: x -->',
    '<!-- ex:2 | uses: [甲] | answer: y -->',
    '<!-- enc_candidates: [甲, 丙] -->',
  ].join('\n')
  const sites = Content.candidateCallSites(body)
  assert.equal(sites.get('甲'), 3, '块 1 站 + 两道练习 2 站')
  assert.equal(sites.get('乙'), 1)
  assert.equal(sites.get('丙'), 1)
})

test('encPromotion：只提升图内且在 pre 闭包内的候选；权重取 invokes 投影、无投影落缺省 1（#148 阶梯退役）', () => {
  const graph = graphOf([
    node({ name: '甲' }),
    node({ name: '丙' }),
    node({ name: '乙', pre: ['甲'] }),
  ])
  const body = '<!-- enc_candidates: [甲, 丙, 不存在] -->\n<!-- ex:1 | uses: [甲] | answer: x -->'
  const promo = Content.encPromotion(graph, '乙', body)
  assert.deepEqual(promo, [{ node: '甲', w: 1 }], '丙不在闭包、不存在不在图内 → 只提升甲；无 invokes 数据 → schema 缺省权重 1')
  const projW = new Map([['甲', { w: 0.67, note: 'invokes 投影 2/3' }]])
  assert.deepEqual(
    Content.encPromotion(graph, '乙', body, projW),
    [{ node: '甲', w: 0.67, note: 'invokes 投影 2/3' }],
    '有 invokes 投影 → 出生权重随带投影 note',
  )
})

test('invokesProjection：invokes 覆盖率投影——份额、自教不投影、归档不进分母（#148）', () => {
  const graph = graphOf([
    node({ name: '甲', teaches: { 自然数: '知道' } }),
    node({ name: '丁', teaches: { 集合: '知道' } }),
    node({ name: '乙', pre: ['甲', '丁'], teaches: { 质数: '会用' } }),
  ])
  const qs = [
    { invokes: '自然数' },
    { invokes: '自然数' },
    { invokes: '质数' }, // 自教概念 → 不投影
    { invokes: '集合' },
    { invokes: '自然数', archived: true }, // 归档 → 不进分母
    {}, // 缺 invokes → 不进分母
  ]
  assert.deepEqual(
    Content.invokesProjection(graph, '乙', qs),
    [{ node: '丁', w: 0.25, note: 'invokes 投影 1/4' }, { node: '甲', w: 0.5, note: 'invokes 投影 2/4' }],
    '分母 = 全部带 invokes 的在库题（4，自教概念也进分母——自教稀释前置覆盖）；丁 1/4、甲 2/4，按节点名排序',
  )
})

test('invokesProjection：同概念多节点教 → 取闭包内最近的前置（depth 最大）', () => {
  const graph = graphOf([
    node({ name: '根', teaches: { 自然数: '知道' } }),
    node({ name: '甲', pre: ['根'], teaches: { 自然数: '会用' } }),
    node({ name: '乙', pre: ['甲'], teaches: { 质数: '会用' } }),
  ])
  assert.deepEqual(
    Content.invokesProjection(graph, '乙', [{ invokes: '自然数' }]),
    [{ node: '甲', w: 1, note: 'invokes 投影 1/1' }],
    '螺旋图上根与甲都教自然数 → 投影到离乙最近的甲',
  )
})

test('invokesProjection：零 invokes / 概念无闭包内前置教 → 零投影（合法空态）', () => {
  const graph = graphOf([
    node({ name: '甲' }),
    node({ name: '乙', pre: ['甲'], teaches: { 质数: '会用' } }),
  ])
  assert.deepEqual(Content.invokesProjection(graph, '乙', [{}, { invokes: '' }]), [], '零 invokes → 零投影')
  assert.deepEqual(
    Content.invokesProjection(graph, '乙', [{ invokes: '集合' }]),
    [],
    '概念没有任何闭包内前置教 → 不投影',
  )
})

test('conceptScopeOf：本节 teaches 在前、祖先按深度浅→深（#148 出生打标候选集）', () => {
  const graph = graphOf([
    node({ name: '根', teaches: { 算术: '知道' } }),
    node({ name: '甲', pre: ['根'], teaches: { 自然数: '知道' } }),
    node({ name: '丁', pre: ['甲'], teaches: { 集合: '知道' } }),
    node({ name: '乙', pre: ['丁'], teaches: { 质数: '会用', 素性: '会用' } }),
  ])
  assert.deepEqual(
    Content.conceptScopeOf(graph, '乙'),
    ['质数', '素性', '算术', '自然数', '集合'],
    '本节在前（teaches 键序）；祖先按深度浅→深：根(0) → 甲(1) → 丁(2)；传递祖先也在闭包内',
  )
})

test('encBackfeedHints：闭包内未落 enc → set_enc 建议；闭包外 → set_pre 建议', () => {
  const graph = graphOf([
    node({ name: '甲' }),
    node({ name: '丙' }),
    node({ name: '乙', pre: ['甲'] }),
  ])
  const hints = Content.encBackfeedHints(graph, '乙', '<!-- enc_candidates: [甲, 丙] -->')
  assert.equal(hints.length, 2)
  assert.ok(hints.some(h => h.includes('set_enc') && h.includes('甲')), '闭包内 → set_enc 提升')
  assert.ok(hints.some(h => h.includes('set_pre') && h.includes('丙')), '闭包外 → set_pre 补边')
})

test('encContentHints：Ready 内容 + 闭包内候选未落 enc → R14，只点名闭包内候选', () => {
  const graph = graphOf([
    node({ name: '甲' }),
    node({ name: '丙' }),
    node({ name: '乙', pre: ['甲'] }),
  ])
  const body = '<!-- enc_candidates: [甲, 丙] -->'
  const r = Content.encContentHints(graph, '乙', body, true)
  const r14 = r.warns.filter(w => w.includes('R14'))
  assert.equal(r14.length, 1)
  assert.match(r14[0]!, /甲/)
  assert.doesNotMatch(r14[0]!, /丙/, '丙不在闭包 → 不报 enc 缺口')
})

test('encContentHints：已声明 enc 与候选零交集 → R15；声明边不在候选 → R15 info', () => {
  const graphB = graphOf([
    node({ name: '甲' }),
    node({ name: '丁' }),
    node({ name: '戊' }),
    node({ name: '乙', pre: ['甲'], enc: [{ node: '甲', w: 0.9 }] }),
  ])
  const body = '<!-- enc_candidates: [丁, 戊] -->'
  const r = Content.encContentHints(graphB, '乙', body, true)
  assert.ok(r.warns.some(w => /R15 .*零交集/.test(w)), '候选全在 enc 之外 → R15 不一致')
  assert.ok(r.infos.some(i => i.includes('R15') && i.includes('甲')), '声明边甲不在当前候选 → R15 info')
})

test('encContentHints：≥2 条 enc 全同权重 → R16 无区分度', () => {
  const graph = graphOf([
    node({ name: '丁' }),
    node({ name: '甲', pre: ['丁'] }),
    node({ name: '乙', pre: ['甲'], enc: [{ node: '丁', w: 1 }, { node: '甲', w: 1 }] }),
  ])
  const r = Content.encContentHints(graph, '乙', '<!-- enc_candidates: [丁, 甲] -->', true)
  assert.ok(r.warns.some(w => /R16 .*全为 w=1/.test(w)))
  assert.equal(r.warns.filter(w => w.includes('R14')).length, 0, '候选已全落 enc')
})

test('encContentHints：practice 节点合法空 enc 不报缺口；非 Ready 内容不背书', () => {
  const g = graphOf([
    node({ name: '甲' }),
    node({ name: '乙', pre: ['甲'], type: 'practice' }),
  ])
  assert.equal(Content.encContentHints(g, '乙', '<!-- enc_candidates: [甲] -->', true).warns.length, 0, 'practice 空 enc 合法')
  const g2 = graphOf([
    node({ name: '甲' }),
    node({ name: '乙', pre: ['甲'] }),
  ])
  assert.equal(Content.encContentHints(g2, '乙', '<!-- enc_candidates: [甲] -->', false).warns.length, 0, '无 Ready 内容不背书')
})

// ---- 集成：存量回填 → 提案 → apply → 可重入；审计 R14 随覆盖销号 ----

test('graphEncBackfill：Ready 节点补 enc 提案，apply 后覆盖销号，重跑 ops=0', async () => {
  await withVault(ENC_VAULT, async ({ engine }) => {
    // 初始审计：乙有 Ready 内容 + 候选但未落 enc → R14 覆盖缺口
    const before = await auditOf(engine)
    assert.ok(before.warns.some(w => /R14 enc 覆盖缺口.*乙/.test(w)), '审计报出覆盖缺口')

    const r = await engine.graphEncBackfill('数学') as Record<string, unknown>
    assert.equal(r.scanned, 1, '只有乙有 Ready 内容 + 候选')
    assert.equal(r.ops, 1)
    const prop = r.proposal as { id: number; kind: string }
    assert.equal(prop.kind, 'enrich', 'enc 回填走富化覆盖层通道（#140 出生/覆盖层分家）')

    // apply 走 audit 门禁（R14 是 warn 不阻断）
    const applied = await engine.graphApply('enrich', prop.id) as Record<string, unknown>
    assert.equal(applied.course, '数学')

    // apply 后审计不再报 R14（覆盖已销号）
    const after = await auditOf(engine)
    assert.ok(!after.warns.some(w => /R14 enc 覆盖缺口.*乙/.test(w)), '补 enc 后覆盖缺口销号')

    // 可重入：重跑不再产生 op
    const again = await engine.graphEncBackfill('数学') as Record<string, unknown>
    assert.equal(again.ops, 0)
  })
})

test('graphEncBackfill：无反哺候选 → ops=0 且不产生提案', async () => {
  await withVault(ENC_VAULT, async ({ engine }) => {
    // 擦掉乙的 enc_candidates 机器块 → 候选为空 → 无回填
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(engine.paths.courseRoot('math'), '课程', '基础', '乙.md'),
      NOTE_乙.replace('<!-- enc_candidates: [甲] -->', ''),
      'utf8',
    )
    const r = await engine.graphEncBackfill('数学') as Record<string, unknown>
    assert.equal(r.ops, 0)
    assert.equal(r.proposal, null)
  })
})

test('graphEncBackfill：invokes 投影出生权重随 enrich 提案回填（#148 权重新语义）', async () => {
  const GRAPH_TEACHES = [
    'region: 基础',
    'color: blue',
    'blocks:',
    '  - name: 入门块',
    '    nodes:',
    '      - { name: 甲, pre: [], opt: false, note: "", est: 10, teaches: { 自然数: 知道 } }',
    '      - { name: 乙, pre: [甲], opt: false, note: "", est: 20 }',
    '      - { name: 丙, pre: [], opt: false, note: "", est: 10 }',
  ].join('\n')
  const NOTE_乙_NO_CAND = NOTE_乙.replace('\n<!-- enc_candidates: [甲] -->', '')
  const BANK_乙 = [
    'node: 乙',
    'questions:',
    '  - id: q1',
    '    kind: true_false',
    '    q: 乙题一：说法是否成立。',
    '    answer: true',
    '    invokes: 自然数',
    '  - id: q2',
    '    kind: true_false',
    '    q: 乙题二：说法是否成立。',
    '    answer: false',
  ].join('\n')
  await withVault({
    graph: GRAPH_TEACHES,
    graphFile: '00_基础.yaml',
    notes: { 甲: {}, 乙: `${NOTE_乙_NO_CAND}\n`, 丙: {} },
    banks: { 乙: BANK_乙 },
  }, async ({ engine }) => {
    // 无正文候选、有 invokes 投影 → 仍产生回填条目（投影是独立生产者）
    const r = await engine.graphEncBackfill('数学') as Record<string, unknown>
    assert.equal(r.scanned, 1)
    assert.equal(r.ops, 1)
    const prop = r.proposal as { id: number; kind: string }
    assert.equal(prop.kind, 'enrich', '覆盖层通道（指纹、读侧只读正典，#140 已建通道照用）')

    const applied = await engine.graphApply('enrich', prop.id) as Record<string, unknown>
    assert.equal(applied.course, '数学')

    // 正典生效：甲 w = 1/1（唯一带 invokes 的题），投影 note 留痕
    const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('math')).load()
    const graph = new Graph(regions)
    assert.deepEqual(graph.encOf['乙'], [['甲', 1]])
    const edge = regions[0]!.blocks[0]!.nodes.find(n => n.name === '乙')!.enc[0]!
    assert.equal(edge.node, '甲')
    assert.equal(edge.w, 1)
    assert.equal(edge.note, 'invokes 投影 1/1')

    // 可重入：已声明 → ops=0
    const again = await engine.graphEncBackfill('数学') as Record<string, unknown>
    assert.equal(again.ops, 0)
  })
})
