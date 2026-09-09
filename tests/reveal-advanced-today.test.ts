import test from 'node:test'
import assert from 'node:assert/strict'
import { LearnhubEngine } from '../src/engine/index.ts'
import { answer, tfQuestion, withVault } from './helpers/vault.ts'

const loadQs = async (engine: LearnhubEngine): Promise<Array<Record<string, unknown>>> => {
  const r = await engine.questions('数学', '入门') as unknown as { questions: Array<Record<string, unknown>> }
  return r.questions
}

test('作答后同学习日：questions 通道披露 advancedToday + answer（直通卡边界）', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: [tfQuestion('a1'), tfQuestion('a2')] },
  }, async ({ engine }) => {
    await answer(engine, 'a1', 'true')
    const qs = await loadQs(engine)
    const a1 = qs.find(q => q.id === 'a1')!
    const a2 = qs.find(q => q.id === 'a2')!
    assert.equal(a1.advancedToday, true, '当日已真实推进 → 直通')
    assert.ok(typeof a1.answer === 'string' && a1.answer.length > 0, '已推进题带出答案')
    assert.equal(a1.lastCorrect, true, '最近一次作答对错落 stats.last_correct')
    assert.equal(a1.explanation, '', '无解析时为空串（UI 隐藏解析块）')
    assert.equal(a2.advancedToday, undefined, '未推进题不标直通')
    assert.equal('answer' in a2, false, '未推进题不带答案（防泄题边界）')
  })
})

test('跨学习日不再直通：stats.last 是昨日 → 无 advancedToday/answer', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: [tfQuestion('old', { stats: { attempts: 1, correct: 1, last: '2000-01-01' } })] },
  }, async ({ engine }) => {
    const qs = await loadQs(engine)
    const old = qs.find(q => q.id === 'old')!
    assert.equal(old.advancedToday, undefined, '昨日推进不算今日直通（一卡一学习日）')
    assert.equal('answer' in old, false, '跨日不披露答案')
    assert.equal(old.lastCorrect, null, '旧数据无 last_correct 字段 → null')
  })
})

test('答错如实记 last_correct=false；reviewQueue 通道永不带答案', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: [
      tfQuestion('a1'),
      tfQuestion('due', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } }),
    ] },
  }, async ({ engine }) => {
    await answer(engine, 'a1', 'false')
    const qs = await loadQs(engine)
    assert.equal(qs.find(q => q.id === 'a1')!.lastCorrect, false, '答错如实落 last_correct')

    const r = await engine.reviewQueue('数学') as unknown as { cards: Array<Record<string, unknown>> }
    const card = r.cards.find(c => c.id === 'due')!
    assert.ok(card, '到期卡入队')
    assert.equal('answer' in card, false, '复习队列是主动回忆面，不带答案')
    assert.equal('advancedToday' in card, false, '复习队列不带直通标记')
  })
})
