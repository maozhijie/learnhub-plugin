import test from 'node:test'
import assert from 'node:assert/strict'
import { calibrationBins, dueReviewFirstPushes, forecast, forgettingCurve, stateHistograms, trueRetention } from '../src/engine/memory.ts'
import { todayStr } from '../src/engine/dates.ts'
import type { ReviewRec } from '../src/engine/types.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

// ---- 纯聚合（接缝 S26）----

test('forecast：逾期存量 + 未来 N 天逐日到期量（窗口外远期不摊入）', () => {
  const today = '2026-09-08'
  const r = forecast(['2026-09-01', '2026-09-07', today, '2026-09-09', '2026-09-09', '2099-01-01'], today, 3)
  assert.equal(r.overdue, 2)
  assert.deepEqual(r.per_day, [
    { d: '2026-09-08', count: 1 },
    { d: '2026-09-09', count: 2 },
    { d: '2026-09-10', count: 0 },
  ])
})

test('stateHistograms：stability 数量级分桶、difficulty/R 十分位', () => {
  const h = stateHistograms([
    { stability: 0.5, difficulty: 2, r: 0.95 },
    { stability: 45, difficulty: 6, r: 0.55 },
    { stability: 400, difficulty: 9, r: 0.05 },
  ])
  assert.equal(h.stability.find(b => b.label === '<1')!.count, 1)
  assert.equal(h.stability.find(b => b.label === '30–90')!.count, 1)
  assert.equal(h.stability.find(b => b.label === '≥365')!.count, 1)
  assert.equal(h.difficulty.find(b => b.label === '1–3 易')!.count, 1)
  assert.equal(h.difficulty.find(b => b.label === '5–7 中')!.count, 1)
  assert.equal(h.difficulty.find(b => b.label === '9–10 难')!.count, 1)
  assert.equal(h.retrievability.find(b => b.label === '90–100%')!.count, 1)
  assert.equal(h.retrievability.find(b => b.label === '50–60%')!.count, 1)
})

const rec = (over: Partial<ReviewRec>): ReviewRec => ({
  ts: '2026-09-08T10:00:00', course: '数学', node: '入门', qid: 'a1',
  rating: 3, rating_source: 'auto', elapsed_days: 5,
  stability_before: 3, difficulty_before: 5, r_pred: 0.8,
  ...over,
})

test('真实保留率口径：排除 synthetic 与首学推进，每卡每天取第一条，rating≥2 记成功', () => {
  const logs = [
    rec({ qid: 'a1', rating: 1, r_pred: 0.8 }), // 计：答错 = 失败
    rec({ qid: 'a1', rating: 3, r_pred: 0.8 }), // 同卡同日第二条：防御性去重不计
    rec({ qid: 'a2', rating: 3, rating_source: 'self', elapsed_days: 2, stability_before: 5, r_pred: 0.7 }), // 计：自评通过
    rec({ qid: 'a3', rating: 3, rating_source: 'synthetic', stability_before: null, difficulty_before: null, r_pred: null }), // 合成首复习：排除
    rec({ qid: 'a4', rating: 3, stability_before: null, difficulty_before: null, r_pred: 1 }), // 首学推进：不是到期复习
  ]
  const due = dueReviewFirstPushes(logs)
  assert.deepEqual(due.map(r => r.qid).sort(), ['a1', 'a2'])
  const r = trueRetention(due)
  assert.deepEqual({ pass: r.pass, fail: r.fail, real: r.real }, { pass: 1, fail: 1, real: 2 })
  assert.equal(r.rate, 0.5)
  assert.equal(trueRetention([]).rate, null, '无数据 → rate=null（空态，不造假数据）')
})

test('校准分箱与遗忘曲线：按 r_pred / elapsed_days 分桶的通过率', () => {
  const due = [
    rec({ qid: 'a1', rating: 1, elapsed_days: 5, r_pred: 0.8 }),
    rec({ qid: 'a2', rating: 3, rating_source: 'self', elapsed_days: 2, stability_before: 5, r_pred: 0.7 }),
  ]
  const cal = calibrationBins(due)
  assert.deepEqual(cal.filter(b => b.n > 0).map(b => ({ label: b.label, n: b.n, actual: b.actual })), [
    { label: '70–80%', n: 1, actual: 1 },
    { label: '80–90%', n: 1, actual: 0 },
  ])
  const curve = forgettingCurve(due)
  assert.deepEqual(curve.filter(b => b.n > 0).map(b => ({ label: b.label, n: b.n, rate: b.rate })), [
    { label: '≤2 天', n: 1, rate: 1 },
    { label: '3–5 天', n: 1, rate: 0 },
  ], '间隔越长保留率下降的曲线原料')
})

// ---- 门面：跨课程聚合 + 与 reviewQueue 扫描口径一致 + 空态 ----

const PAST = '2024-01-01'

/** fsrs 种子：due 可指定（负载预报与状态分布的原料）。 */
const seeded = (due: string) => ({ stability: 5, difficulty: 5, due, last_review: due, reps: 2, lapses: 0 })

test('memoryHealth：预报/分布立刻有数且与 reviewQueue 扫描口径一致；保留率只计真实到期复习', async () => {
  const today = todayStr(new Date())
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
  await withVault({
    notes: { 入门: { stage: 'review' } },
    banks: { 入门: [
      tfQuestion('a1', { fsrs: seeded(PAST) }),         // 逾期
      tfQuestion('a2', { fsrs: seeded(today) }),        // 今日到期
      tfQuestion('a3', { fsrs: seeded(day(2)) }),       // 后天
      tfQuestion('a4', { fsrs: seeded('2099-01-01') }), // 远期：状态分布计入，预报逐日不计
      tfQuestion('a5'),                                 // 未调度：不入任何面板
    ] },
    reviewLog: [
      rec({ ts: '2026-09-01T10:00:00', qid: 'a1', rating: 1, elapsed_days: 5, r_pred: 0.8 }),
      rec({ ts: '2026-09-02T10:00:00', qid: 'a2', rating: 3, rating_source: 'self', elapsed_days: 2, stability_before: 5, r_pred: 0.7 }),
      rec({ ts: '2026-09-03T10:00:00', qid: 'a3', rating: 3, rating_source: 'synthetic', stability_before: null, difficulty_before: null, r_pred: null }),
    ].map(l => JSON.stringify(l)),
  }, async ({ engine }) => {
    const m = await engine.sched2.memoryHealth() as {
      forecast: { overdue: number; per_day: Array<{ d: string; count: number }> }
      state: { scheduled: number; stability: Array<{ label: string; count: number }> }
      retention: { pass: number; fail: number; rate: number | null; real: number }
      calibration: Array<{ label: string; n: number; actual: number | null }>
      forgetting: Array<{ label: string; n: number; rate: number | null }>
    }

    assert.equal(m.forecast.overdue, 1)
    assert.equal(m.forecast.per_day[0].count, 1, '今日到期在 day 0')
    assert.equal(m.forecast.per_day[2].count, 1, '后天到期在 day 2')
    assert.equal(m.forecast.per_day.reduce((s, p) => s + p.count, 0), 2, '远期卡不摊入预报窗口')

    assert.equal(m.state.scheduled, 4, '已调度题卡计数（未调度/归档不入）')
    assert.equal(m.state.stability.find(b => b.label === '3–7')!.count, 4, '全部种子卡 stability=5')

    assert.deepEqual(
      { pass: m.retention.pass, fail: m.retention.fail, rate: m.retention.rate, real: m.retention.real },
      { pass: 1, fail: 1, rate: 0.5, real: 2 }, 'synthetic 不计入真实保留率',
    )
    assert.deepEqual(m.calibration.filter(b => b.n > 0).map(b => [b.label, b.actual]), [
      ['70–80%', 1], ['80–90%', 0],
    ])
    assert.deepEqual(m.forgetting.filter(b => b.n > 0).map(b => [b.label, b.rate]), [
      ['≤2 天', 1], ['3–5 天', 0],
    ])

    // 与 reviewQueue 的扫描口径一致：到期队列 = 逾期 + 今日（PAST + today）
    const q = await engine.content2.reviewQueue() as { total: number }
    assert.equal(q.total, m.forecast.overdue + m.forecast.per_day[0].count)
  })
})

test('memoryHealth 空态：无题库无日志 → 全零计数与 rate=null，不造假数据', async () => {
  await withVault({ notes: { 入门: { stage: 'review' } } }, async ({ engine }) => {
    const m = await engine.sched2.memoryHealth() as {
      state: { scheduled: number }
      retention: { real: number; rate: number | null }
      calibration: Array<{ n: number; actual: number | null }>
      forgetting: Array<{ n: number; rate: number | null }>
    }
    assert.equal(m.state.scheduled, 0)
    assert.equal(m.retention.real, 0)
    assert.equal(m.retention.rate, null)
    assert.ok(m.calibration.every(b => b.n === 0 && b.actual === null))
    assert.ok(m.forgetting.every(b => b.n === 0 && b.rate === null))
  })
})
