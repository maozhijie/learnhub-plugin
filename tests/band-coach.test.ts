import test from 'node:test'
import assert from 'node:assert/strict'
import { bandOffset, BAND_PREF_OFFSET } from '../src/engine/adaptive.ts'
import { coachFeedback, COACH_DUE_HARD_R, COACH_HARD_D, COACH_MIN_ANSWERED, COACH_MIN_SESSIONS, withinCoachWindow } from '../src/engine/coach.ts'
import type { BandRec } from '../src/engine/coach.ts'
import { todayStr } from '../src/engine/dates.ts'
import { tfQuestion, withVault, localDay } from './helpers/vault.ts'

// E5 自选难度 + 可用的困难教练（决议 #50 / 实施工单 #65）：显式带选择作为 A1 的
// 带权偏好（防挫回落保留）；教练 = 只读信息性反馈，低数据静默，无门禁无判分。

const YESTERDAY = localDay(-1)

const HIGH_MASTERY_FSRS = { stability: 40, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 6, lapses: 0 }

/** 高掌握节点：standard 带 >0.6（开场难题），easy 偏移后应回落到基础题。 */
const NOTE = {
  stage: 'review',
  fsrs: HIGH_MASTERY_FSRS,
  practice: { attempts: 3, correct: 3, ema: 1.0 },
}

const DUE_TF = { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 2, lapses: 0 }

type QueueDoc = { band?: number; cards: Array<{ id: string; d: number }> }

// ---- 纯规则（接缝 S31 + adaptive 扩展）----

test('bandOffset：挑战抬高、简单放宽、标准/不选 = 纯 A1（偏移 0）', () => {
  assert.equal(bandOffset('easy'), -BAND_PREF_OFFSET)
  assert.equal(bandOffset('hard'), BAND_PREF_OFFSET)
  assert.equal(bandOffset('standard'), 0)
  assert.equal(bandOffset(undefined), 0, '不选时行为与 #57 默认一致')
})

test('withinCoachWindow：7 天窗口（按本地日，未来与过期都算窗外）', () => {
  const today = '2026-09-08'
  assert.ok(withinCoachWindow('2026-09-08', today), '今天在窗内')
  assert.ok(withinCoachWindow('2026-09-02', today), '6 天前在窗内')
  assert.ok(!withinCoachWindow('2026-09-01', today), '7 天前出窗')
  assert.ok(!withinCoachWindow('2026-09-09', today), '未来不算')
})

test('coachFeedback：全简单 + 有该会的到期难题 → 温和点出；全挑战反复失败 → 回前置/成分技能；低数据静默', () => {
  const today = todayStr(new Date())
  const easy: BandRec[] = Array.from({ length: COACH_MIN_SESSIONS }, () =>
    ({ date: today, course: '数学', node: '入门', band: 'easy', answered: 4, correct: 4 }))
  // 触发 ①：总选简单 + 有该会的到期难题
  const easyMsgs = coachFeedback(easy, 2, today)
  assert.equal(easyMsgs.length, 1, '只出简单带提醒')
  assert.ok(easyMsgs[0]!.includes('2 道到期题'), easyMsgs[0]!)
  assert.ok(easyMsgs[0]!.includes('标准带'), easyMsgs[0]!)
  // 无该会的到期难题 → 静默
  assert.deepEqual(coachFeedback(easy, 0, today), [])

  // 触发 ②：总在挑战且反复失败（正确率 < 0.6）
  const hard: BandRec[] = Array.from({ length: COACH_MIN_SESSIONS }, () =>
    ({ date: today, course: '数学', node: '入门', band: 'hard', answered: 4, correct: 1 }))
  const hardMsgs = coachFeedback(hard, 0, today)
  assert.equal(hardMsgs.length, 1)
  assert.ok(hardMsgs[0]!.includes('前置'), hardMsgs[0]!)
  assert.ok(hardMsgs[0]!.includes('成分技能'), hardMsgs[0]!)
  // 挑战但成功率尚可 → 静默
  const hardOk = hard.map(r => ({ ...r, correct: 4 }))
  assert.deepEqual(coachFeedback(hardOk, 0, today), [])

  // 低数据静默：会话不足 / 作答量不足 / 混选
  assert.deepEqual(coachFeedback(easy.slice(0, COACH_MIN_SESSIONS - 1), 3, today), [], '会话不足')
  const thin = easy.map(r => ({ ...r, answered: 1 }))
  assert.deepEqual(coachFeedback(thin, 3, today), [], `作答量不足 ${COACH_MIN_ANSWERED}`)
  const mixed = [...easy.slice(0, 2), { date: today, course: '数学', node: '入门', band: 'standard' as const, answered: 4, correct: 4 }]
  assert.deepEqual(coachFeedback(mixed, 3, today), [], '混选不触发「总选」语义')
  // 窗外老账不算
  const stale = easy.map(r => ({ ...r, date: '2020-01-01' }))
  assert.deepEqual(coachFeedback(stale, 3, today), [])
  // 教练是无门禁的只读反馈：触发出文字，不出「禁止」语义
  for (const m of [...easyMsgs, ...hardMsgs]) {
    assert.ok(!m.includes('不能') && !m.includes('禁止'), m)
  }
})

// ---- 门面：bandPref 传导（带权偏好而非过滤）+ 防挫回落不变 ----

test('reviewQueue bandPref：挑战抬高目标带、简单放宽（同一节点上偏移 ±0.2）', async () => {
  await withVault({
    notes: { 入门: NOTE },
    banks: { 入门: [tfQuestion('easy1', { difficulty: 1, fsrs: DUE_TF }), tfQuestion('hard1', { difficulty: 3, fsrs: DUE_TF })] },
  }, async ({ engine }) => {
    const std = await engine.content2.reviewQueue('数学', '入门') as QueueDoc
    const hard = await engine.content2.reviewQueue('数学', '入门', undefined, 'hard') as QueueDoc
    const easy = await engine.content2.reviewQueue('数学', '入门', undefined, 'easy') as QueueDoc
    assert.ok(hard.band! > std.band!, '挑战抬高')
    assert.ok(easy.band! < std.band!, '简单放宽')
    assert.ok(Math.abs((hard.band! - std.band!) - BAND_PREF_OFFSET) < 1e-6)
    assert.ok(Math.abs((std.band! - easy.band!) - BAND_PREF_OFFSET) < 1e-6)
    // 高掌握 standard 开场难题；放宽到简单带后开场回到基础题（带权偏好重排，非过滤）
    assert.equal(std.cards[0]!.id, 'hard1')
    assert.equal(easy.cards[0]!.id, 'easy1')
    assert.equal(hard.cards.length, 2, '不建独立过滤通道：全部到期题仍在队列')
  })
})

test('难度带会话日志 + 教练反馈（门面）：全简单日志 + 到期难题 → 教练出声', async () => {
  await withVault({
    notes: { 入门: NOTE },
    // 到期难题卡：R 高（昨天刚复习、stability 30）+ 合用难度高（静态 3 + FSRS 8）→ 教练的「该会的到期难题」
    banks: { 入门: [
      tfQuestion('h1', { difficulty: 3, fsrs: { stability: 30, difficulty: 8, due: YESTERDAY, last_review: YESTERDAY, reps: 4, lapses: 0 } }),
      tfQuestion('easy1', { difficulty: 1, fsrs: DUE_TF }),
    ] },
  }, async ({ engine }) => {
    const empty = await engine.coachAdvice() as { messages: string[]; due_hard: number }
    assert.ok(empty.due_hard >= 1, 'fixture 有 R 高且难的到期题')
    assert.deepEqual(empty.messages, [], '无会话数据静默')

    for (let i = 0; i < 3; i++) {
      await engine.logBandSession({ course: '数学', node: '入门', band: 'easy', answered: 4, correct: 4 })
    }
    const coach = await engine.coachAdvice() as { messages: string[]; due_hard: number }
    assert.equal(coach.messages.length, 1, coach.messages.join('；'))
    assert.ok(coach.messages[0]!.includes('标准带'))

    // 日志落盘可回读
    const recs = await engine.store.bandRecsAll()
    assert.equal(recs.length, 3)
    assert.equal(recs[0]!.band, 'easy')
    assert.ok(recs[0]!.date.length === 10)
    await assert.rejects(
      () => engine.logBandSession({ course: '数学', node: '入门', band: '变态' as never, answered: 1, correct: 1 }),
      /band 只能是/,
    )
  })
})

test('教练口径常量：「该会的到期难题」= R 高 + 合用难度中档以上', () => {
  assert.ok(COACH_DUE_HARD_R > 0.5 && COACH_DUE_HARD_R < 1)
  assert.ok(COACH_HARD_D >= 0.4 && COACH_HARD_D <= 0.6, COACH_HARD_D as unknown as string)
})
