import test from 'node:test'
import assert from 'node:assert/strict'
import { jolCalibration, jolDeviatedKeys, pickJolTargets } from '../src/engine/jol.ts'
import type { PracticeRec } from '../src/engine/types.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

// E4 预测-校准 JOL（决议 #49 修订 / 实施工单 #66）：复习流作答前一档三点预测
// （抽查 ~1/3、可忽略、可全局关）+ 校准曲线（只展示、不喂 canonical）。

/** 到期 true_false 题（R 低：老 last_review + 小 stability → 全部 0 分候选，随机补齐可断言）。 */
const DUE_TF = {
  difficulty: 1,
  fsrs: { stability: 0.5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 2, lapses: 0 },
}

const rec = (p: Partial<PracticeRec>): PracticeRec => ({
  ts: '2026-09-08T10:00:00+08:00', course: '数学', node: '入门', ex: 1,
  answer: '', correct: true, judge: 'true_false', ...p,
})

// ---- 纯规则（接缝 S30）----

test('pickJolTargets：抽查率向上取整、信息价值优先（偏差 > R 边界 > 难度中段 > 随机）', () => {
  const cards = [
    { key: 'a', r: 0.6, difficulty: 2 }, // s=3：R 边界 + 难度中段
    { key: 'b', r: 0.9, difficulty: 1 }, // s=0
    { key: 'c', r: 0.6, difficulty: 1 }, // s=2
    { key: 'd', r: 0.95, difficulty: 2 }, // s=1
    { key: 'e', r: 0.1, difficulty: 3 }, // s=0
    { key: 'f', r: 0.99, difficulty: 1 }, // s=0
  ]
  const hit = pickJolTargets(cards, () => 0.5)
  assert.equal(hit.size, 2, '6 张 × 1/3 向上取整 = 2')
  assert.ok(hit.has('a'), 'R 边界 + 难度中段最优先')
  assert.ok(hit.has('c'), 'R 边界次优先')

  // 曾有预测−结果偏差的卡优先重探（+3 压过一切）
  const revisit = pickJolTargets(cards, () => 0.5, { deviated: new Set(['f']) })
  assert.ok(revisit.has('f'), '偏差卡跳队')

  // 全 0 分候选：随机抖动补齐（种子确定），数量仍守抽样率
  const flat = [{ key: 'x', r: 0.1 }, { key: 'y', r: 0.2 }, { key: 'z', r: 0.3 }]
  assert.equal(pickJolTargets(flat, () => 0.1).size, 1)
  assert.deepEqual([...pickJolTargets(flat, () => 0.1)], ['x'], '同分取抖动小者（确定性）')
})

test('jolDeviatedKeys：高估（会却错/忘）与低估（不会却对）算偏差，没把握不算；复合键防跨节点撞名', () => {
  const dev = jolDeviatedKeys([
    rec({ qid: 'q1', predicted: '会', correct: false }),
    rec({ qid: 'q2', predicted: '不会', correct: true }),
    rec({ qid: 'q3', predicted: '会', correct: true }),
    rec({ qid: 'q4', predicted: '没把握', correct: false }),
    rec({ qid: 'q5', predicted: '不会', correct: false }),
    rec({ course: '物理', node: '力学', qid: 'q1', predicted: '会', correct: false }),
    rec({ predicted: '会', correct: false }), // 无 qid：跳过
  ])
  assert.deepEqual([...dev].sort(),
    ['数学/入门/q1', '数学/入门/q2', '物理/力学/q1'], '键 = course/node/qid')
})

test('jolCalibration：(predicted, 实际) 逐条配对聚合；门槛前 null（不显示）', () => {
  const ten = Array.from({ length: 10 }, (_, i) => rec({
    qid: `q${i}`, predicted: i < 6 ? '会' : i < 8 ? '不会' : '没把握',
    correct: i % 2 === 0, judge: i === 1 ? 'forget' : 'true_false',
  }))
  assert.equal(jolCalibration(ten.slice(0, 9)), null, '9 条配对不足门槛')
  const cal = jolCalibration(ten)!
  assert.equal(cal.pairs, 10)
  const hui = cal.bins.find(b => b.label === '会')!
  assert.equal(hui.n, 6)
  assert.equal(hui.accuracy, 0.5)
  assert.equal(hui.forgot, 1, '忘记按 judge 计数')
  const mei = cal.bins.find(b => b.label === '没把握')!
  assert.equal(mei.n, 2)
  assert.equal(mei.accuracy, 0.5)
})

// ---- 门面：抽查标记 / predicted 落流水 / 全局开关 / 校准入口 ----

test('reviewQueue：抽查约 1/3 弹预测标记，关闭后完全消失', async () => {
  await withVault({
    notes: { 入门: { stage: 'review' } },
    banks: { 入门: [tfQuestion('q1', DUE_TF), tfQuestion('q2', DUE_TF), tfQuestion('q3', DUE_TF)] },
  }, async ({ engine }) => {
    engine.jolRng = () => 0.5
    const r = await engine.content2.reviewQueue('数学') as { cards: Array<{ id: string; jol?: boolean }> }
    const marked = r.cards.filter(c => c.jol)
    assert.equal(marked.length, 1, '3 张 × 1/3 向上取整 = 1（非逐卡）')

    await engine.learner.setJolConfig({ enabled: false })
    const r2 = await engine.content2.reviewQueue('数学') as { cards: Array<{ jol?: boolean }> }
    assert.ok(r2.cards.every(c => !c.jol), '全局关闭后完全不打扰')
    assert.deepEqual(await engine.learner.jolConfig(), { enabled: false, rate: 1 / 3 })

    await engine.learner.setJolConfig({ enabled: true, rate: 1 })
    const r3 = await engine.content2.reviewQueue('数学') as { cards: Array<{ jol?: boolean }> }
    assert.equal(r3.cards.filter(c => c.jol).length, 3, '抽样率可配')
    await engine.learner.setJolConfig({ rate: 1 / 3 })
  })
})

test('作答/忘记携带预测落流水（逐条配对成立）；非法预测显式拒绝', async () => {
  await withVault({
    notes: { 入门: { stage: 'review' } },
    banks: { 入门: [tfQuestion('q1', DUE_TF), tfQuestion('q2', DUE_TF), tfQuestion('q3', DUE_TF)] },
  }, async ({ engine }) => {
    const llm = async () => { throw new Error('不应调用 LLM') }
    // 复习流答对（挂起）+ 预测「会」
    await engine.questionAnswer(llm, '数学', '入门', 'q1', 'true', null,
      { deferSchedule: true, predicted: '会' })
    // 忘记申报 + 预测「不会」
    await engine.content2.questionForget('数学', '入门', 'q2', null, '不会')
    const recs = await engine.store.practiceAll()
    assert.equal(recs.find(r => r.qid === 'q1')?.predicted, '会')
    assert.equal(recs.find(r => r.qid === 'q2')?.predicted, '不会')
    assert.equal(recs.find(r => r.qid === 'q2')?.judge, 'forget')
    // 无预测的老路径不落字段（缺省 null，data check 不报旧流水）
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 4, answer: '', correct: true, judge: 'true_false' })
    const after = await engine.store.practiceAll()
    assert.equal(after.some(r => r.ex === 4 && r.predicted === undefined), true, '无预测不落 predicted 字段')
    await assert.rejects(
      () => engine.questionAnswer(llm, '数学', '入门', 'q3', 'true', null, { predicted: '猜' as never }),
      /预测只能是/,
    )
  })
})

test('memoryHealth：校准配对足门槛后呈现（jol 字段），不足为 null', async () => {
  await withVault({
    notes: { 入门: { stage: 'review' } },
    banks: { 入门: [tfQuestion('q1', DUE_TF), tfQuestion('q2', DUE_TF), tfQuestion('q3', DUE_TF)] },
  }, async ({ engine }) => {
    const empty = await engine.sched2.memoryHealth() as { jol: unknown }
    assert.equal(empty.jol, null, '无配对不显示（空态不造假）')
    for (let i = 0; i < 10; i++) {
      await engine.store.appendPractice({
        course: '数学', node: '入门', ex: 1, answer: '', correct: i % 2 === 0,
        judge: 'true_false', qid: 'q1', predicted: i < 5 ? '会' : '不会',
      })
    }
    const full = await engine.sched2.memoryHealth() as { jol: { pairs: number; bins: Array<{ label: string; n: number }> } | null }
    assert.ok(full.jol, '10 条配对后呈现')
    assert.equal(full.jol!.pairs, 10)
    assert.equal(full.jol!.bins.length, 3)
  })
})
