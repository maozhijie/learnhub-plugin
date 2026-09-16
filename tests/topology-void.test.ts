import test from 'node:test'
import assert from 'node:assert/strict'
import { todayStr } from '../src/engine/dates.ts'
import { runAudit } from '../src/engine/graph/audit.ts'
import { graphHealthScore } from '../src/engine/graph/health.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { withVault } from './helpers/vault.ts'

// 作废署名（#270 / ADR-0085 §环语义裁定）：拓扑序类读数（max_depth / unreachable /
// 收敛度）环上「算不出」必须与「真的没有」可区分——null 与 topology_void 显式署名，
// 不再伪装成 0 / []。可达类读数（闭包）不在此列：环上也算得出真实可达集。

/** A→B→C→A 三角环 vault（Graph 构造期 hasCycle=true；环上 depth 空、reach 逐点闭包）。 */
const CYCLE_VAULT = {
  graph: [
    'nodes:',
    '  - { name: A, pre: [C], opt: false, note: "", est: 10 }',
    '  - { name: B, pre: [A], opt: false, note: "", est: 10 }',
    '  - { name: C, pre: [B], opt: false, note: "", est: 10 }',
  ].join('\n'),
  notes: { A: {}, B: {}, C: {} },
}

/** 对照 DAG：根 → 中 → 叶（拓扑序读数全部算得出）。 */
const DAG_VAULT = {
  graph: [
    'nodes:',
    '  - { name: 根, pre: [], opt: false, note: "", est: 10 }',
    '  - { name: 中, pre: [根], opt: false, note: "", est: 10 }',
    '  - { name: 叶, pre: [中], opt: false, note: "", est: 10 }',
  ].join('\n'),
  notes: { 根: {}, 中: {}, 叶: {} },
}

async function analyzeOf(engine: LearnhubEngine) {
  return engine.graph.graphAnalyze('数学') as {
    stats: { max_depth: number | null }
    unreachable: string[] | null
    health: { topology_void?: string[] }
  }
}

async function auditOf(engine: LearnhubEngine) {
  const { Graph, GraphStore } = await import('../src/engine/graph/graph.ts')
  const nodes = await new GraphStore(engine.paths, engine.paths.courseRoot('math'), nodeVaultFs).load()
  const graph = new Graph(nodes)
  return runAudit(engine.paths, 'math', '数学', graph, todayStr(new Date()), nodeVaultFs)
}

// ---- analysis：max_depth / unreachable / health.topology_void ----

test('analysis 环图：max_depth/unreachable 作废为 null、健康分署名 topology_void（#270）', async () => {
  await withVault(CYCLE_VAULT, async ({ engine }) => {
    const doc = await analyzeOf(engine)
    assert.equal(doc.stats.max_depth, null, '环上深度读数作废——不是 0（0 会伪装成「全部根级」）')
    assert.equal(doc.unreachable, null, '环上不可达集作废——不是 []（[] 会伪装成「全部可达」）')
    assert.deepEqual(doc.health.topology_void, ['convergence'], '收敛度环上置 0 的原因显式披露')
  })
})

test('analysis DAG 对照：拓扑序读数照常出数、无 topology_void 字段', async () => {
  await withVault(DAG_VAULT, async ({ engine }) => {
    const doc = await analyzeOf(engine)
    assert.equal(doc.stats.max_depth, 2, '根(0) → 中(1) → 叶(2)')
    assert.deepEqual(doc.unreachable, [])
    assert.ok(!('topology_void' in doc.health), '无环时不得携带作废署名（签名只给环）')
  })
})

// ---- audit：环上 R1/R2/R6 静默空 → INFO 披露 ----

test('audit 环图：拓扑读数作废的 INFO 披露在场（R1/R6 静默空不再无解释）', async () => {
  await withVault(CYCLE_VAULT, async ({ engine }) => {
    const r = await auditOf(engine)
    assert.ok(
      r.infos.some(i => i.includes('拓扑读数作废')),
      `环图审计必须解释为什么 R1/R2/R6 没有读数；实际 infos: ${JSON.stringify(r.infos)}`,
    )
  })
})

test('audit DAG 对照：无作废披露', async () => {
  await withVault(DAG_VAULT, async ({ engine }) => {
    const r = await auditOf(engine)
    assert.ok(!r.infos.some(i => i.includes('拓扑读数作废')))
  })
})

// ---- health 纯函数：topology_void 只随 hasCycle ----

test('graphHealthScore：环图返回 topology_void，无环图不带该键（#270）', () => {
  const names = ['A', 'B', 'C']
  const base = {
    names,
    nset: new Set(names),
    estOf: {},
    components: [names],
    roots: [],
    nodes: names.map(n => ({ name: n })),
  }
  const cyclic = graphHealthScore({
    ...base,
    preOf: { A: ['C'], B: ['A'], C: ['B'] },
    depth: {},
    hasCycle: true,
  } as never)
  assert.deepEqual(cyclic.topology_void, ['convergence'])
  const acyclic = graphHealthScore({
    ...base,
    preOf: { A: [], B: ['A'], C: ['B'] },
    depth: { A: 0, B: 1, C: 2 },
    hasCycle: false,
  } as never)
  assert.ok(!('topology_void' in acyclic), '签名只给环：无环图不带作废署名')
})
