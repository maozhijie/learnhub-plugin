import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fsrs, generatorParameters } from 'ts-fsrs'
import { simulateRun, aggregateRuns, quantile, SANDBOX_RUNS, SANDBOX_WORDING, SANDBOX_DEFAULT_WEEKS } from '../src/engine/sandbox.ts'
import type { SandboxCard, SandboxNode } from '../src/engine/sandbox.ts'
import { mulberry32 } from '../src/engine/nof1.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

const TODAY = '2026-09-09'
const SCHED = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }))

const PAST_FS = { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 }

const mkNodes = (count: number, started: boolean): SandboxNode[] =>
  Array.from({ length: count }, (_, i) => ({
    course: '数学', node: `节点${i}`, est: 15,
    practice: { attempts: 0, correct: 0 }, started, skipped: false,
  }))

const mkCards = (nodes: SandboxNode[], withBank: boolean): SandboxCard[] => {
  const cards: SandboxCard[] = nodes.map(n => ({
    key: `node:数学/${n.node}`, course: '数学', node: n.node, kind: 'node',
    fs: n.started ? { ...PAST_FS } : null,
  }))
  if (withBank) {
    for (const n of nodes) {
      cards.push({ key: `数学/${n.node}/q1`, course: '数学', node: n.node, kind: 'question', fs: null })
    }
  }
  return cards
}

test('纯函数：分位数与聚合口径（p50/p80；空集 0）', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([3, 1, 2], 0.5), 2)
  assert.equal(quantile([], 0.5), 0)
  const agg = aggregateRuns(
    [{ endByNode: [0.5, 0.5], curve: [0.5] }, { endByNode: [0.5, 0.5], curve: [0.5] }],
    ['a', 'b'], 1,
  )
  assert.deepEqual(agg.map, [{ node: 'a', p50: 0.5, p80: 0.5 }, { node: 'b', p50: 0.5, p80: 0.5 }])
  assert.deepEqual(agg.curve, [{ week: 1, p50: 0.5, p80: 0.5 }])
})

test('纯函数：推演确定性——同种子同结果；曲线长度 = 周数', () => {
  const nodes = mkNodes(3, true)
  const cards = mkCards(nodes, false)
  const plan = { minutesPerDay: 60, weeks: 2 }
  const a = simulateRun(plan, cards, nodes, TODAY, { sched: SCHED, rng: mulberry32(1) })
  const b = simulateRun(plan, cards, nodes, TODAY, { sched: SCHED, rng: mulberry32(1) })
  assert.deepEqual(a, b, '播种确定')
  assert.equal(a.curve.length, 2)
  const c = simulateRun(plan, cards, nodes, TODAY, { sched: SCHED, rng: mulberry32(2) })
  assert.notDeepEqual(a, c, '不同种子是不同抽样')
})

test('纯函数：预算决定引入——预算充足学到手（mastery > 0），预算枯竭停在原地（= 0）', () => {
  const nodes = mkNodes(2, false)
  const cards = mkCards(nodes, true)
  const rich = simulateRun({ minutesPerDay: 120, weeks: 1 }, cards, nodes, TODAY, { sched: SCHED, rng: mulberry32(5) })
  assert.ok(rich.endByNode.every(m => m > 0), `预算充足应全部引入（${rich.endByNode}）`)
  const poor = simulateRun({ minutesPerDay: 1, weeks: 1 }, cards, nodes, TODAY, { sched: SCHED, rng: mulberry32(5) })
  assert.ok(poor.endByNode.every(m => m === 0), `每分钟预算连一个节点都学不完（${poor.endByNode}）`)
})

test('纯函数：到期卡在预算内被复习推进；跳过节点不计入总掌握', () => {
  const nodes = mkNodes(1, true)
  nodes[0]!.skipped = true
  const cards = mkCards(nodes, false)
  const r = simulateRun({ minutesPerDay: 60, weeks: 1 }, cards, nodes, TODAY, { sched: SCHED, rng: mulberry32(3) })
  assert.equal(r.curve[0], 0, '唯一节点被跳过 → 总掌握均值 0（skipped 不在推演范围）')
  assert.equal(r.endByNode[0], 0)
})

// ---- 行为：全链路只读 ----

test('行为：给定计划可出分布推演视图；全路径零 canonical 写入；同输入同输出', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('a1', { fsrs: PAST_FS }), tfQuestion('a2')] },
  }, async ({ engine }) => {
    const snap = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
    const before = {
      note: snap(engine.paths.courseNotePath('math', '基础', '入门')),
      bank: snap(engine.paths.courseRoot('math') + '/题库/入门.yaml'),
      journal: snap(engine.paths.journalPath),
      review: snap(engine.paths.reviewLogPath),
      practice: snap(engine.paths.practicePath),
    }
    const doc = await engine.sandboxRun({ minutesPerDay: 60, weeks: 6 })
    assert.equal(doc.wording, SANDBOX_WORDING, '措辞锁死口径随输出走')
    assert.equal(doc.runs, SANDBOX_RUNS)
    assert.equal(doc.plan.weeks, SANDBOX_DEFAULT_WEEKS)
    assert.equal(doc.curve.length, 6, '逐周曲线点数 = 周数')
    assert.deepEqual(doc.scope, { courses: ['数学'], nodes: 1 })
    assert.equal(doc.map.length, 1)
    assert.equal(doc.map[0]!.node, '数学/入门')
    for (const pt of doc.curve) {
      assert.ok(pt.p50 <= pt.p80 + 1e-9, `p50 ≤ p80（week ${pt.week}）`)
      assert.ok(pt.p80 <= 1.0001)
    }
    assert.ok(doc.assumptions.some(a => /1 分钟/.test(a)), '诚实假设清单随输出')
    // 同输入同输出（播种确定）
    const again = await engine.sandboxRun({ minutesPerDay: 60, weeks: 6 })
    assert.deepEqual(again, doc)
    // 节点子集过滤
    const scoped = await engine.sandboxRun({ minutesPerDay: 60, weeks: 2, nodes: ['入门'] })
    assert.deepEqual(scoped.scope.nodes, 1)
    await assert.rejects(() => engine.sandboxRun({ minutesPerDay: 0 }), /正数/)

    // 零写侧：推演前后 canonical 全部逐字节不变
    assert.equal(snap(engine.paths.courseNotePath('math', '基础', '入门')), before.note, '课程笔记不动')
    assert.equal(snap(engine.paths.courseRoot('math') + '/题库/入门.yaml'), before.bank, '题库不动')
    assert.equal(snap(engine.paths.journalPath), before.journal, '账本不动')
    assert.equal(snap(engine.paths.reviewLogPath), before.review, '复习日志不动')
    assert.equal(snap(engine.paths.practicePath), before.practice, '作答流水不动')
  })
})
