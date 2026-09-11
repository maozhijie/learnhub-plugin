/**
 * 习惯一等公民对象（U-3 #90 / ADR-0017）。
 *
 * - 纯函数：宽容 streak（漏天无损、久置有界、不归零历史）、自动化曲线
 *   （自变量 = 重复次数、中断不衰减、无评份不造假）、意图 schema 校验。
 * - 行为（vault seam）：建/报/归档全链 + 清单派生面（#90 验收：习惯有独立视图，
 *   面板即 PracticePage 消费同一读视图）。
 * - 红线机检：习惯域全路径零 canonical 写入——journal/practice/review-log 零行、
 *   实体零 FSRS 语义（无到期、无卡）、重复不进执行事件通道。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { habitStreak, automationCurve, validateHabitDoc } from '../src/engine/habits.ts'
import { localDay, withVault } from './helpers/vault.ts'

// 学习日口径 = 本地日历日（helpers.localDay），不用 UTC 日算术
const T = localDay

// ---- 纯函数：宽容 streak ----

test('宽容 streak：漏天 ≤2 不断链；today 未报不打断；久置自然有界', () => {
  // 昨天与前天都报了，今天还没报：streak=2（今天不罚）
  assert.equal(habitStreak([T(-1), T(-2)], T(0)), 2)
  // 中间漏一天（≤2）不断链
  assert.equal(habitStreak([T(-1), T(-3), T(-4)], T(0)), 3)
  // 刚好漏 2 天仍接上：今天-1 报、-2/-3 漏、-4 报 → 1 + 1 + 今天未报(1 gap)
  assert.equal(habitStreak([T(-1), T(-4)], T(0)), 2)
  // 空窗 >2 截断：30 天前有历史也不算进当前 streak（有界，不归零历史数字本身）
  assert.equal(habitStreak([T(-1), T(-30)], T(0)), 1)
  // 全没报：streak=0
  assert.equal(habitStreak([], T(0)), 0)
  // 容忍度可调
  assert.equal(habitStreak([T(-1), T(-4)], T(0), 3), 2)
  // 同一天多条自报只算一天
  assert.equal(habitStreak([T(-1), T(-1), T(-2)], T(0)), 2)
})

// ---- 纯函数：自动化曲线（SRBAI 式，自变量 = 重复次数）----

test('自动化曲线：x=累计重复（含未评份）、y=自评点；中断不衰减', () => {
  const recs = [
    { ts: `${T(-4)}T08:00:00`, habit: 'h', day: T(-4), auto_rating: 2 },
    { ts: `${T(-3)}T08:00:00`, habit: 'h', day: T(-3) },              // 未评：计次不出点
    { ts: `${T(-2)}T08:00:00`, habit: 'h', day: T(-2), auto_rating: 4 },
    { ts: `${T(-2)}T20:00:00`, habit: 'h', day: T(-2), auto_rating: 4 }, // 同日第二条
  ]
  const curve = automationCurve(recs)
  assert.deepEqual(curve, [
    { repeats: 1, rating: 2 },
    { repeats: 3, rating: 4 },
    { repeats: 4, rating: 4 },
  ])
  // 空流水 → 空曲线
  assert.deepEqual(automationCurve([]), [])
  // 非法自评值不进曲线
  assert.deepEqual(automationCurve([{ ts: 't', habit: 'h', day: 'd', auto_rating: 9 as never }]), [])
})

// ---- 纯函数：意图 schema ----

test('意图 schema：线索与单一行动都必填（格式锁死）；缺即 Broken 行', () => {
  const ok = validateHabitDoc({
    habit: '晨间音阶', name: '晨间音阶', status: 'active',
    intention: { cue: '早上刷完牙后', action: '打开吉他弹一段音阶' },
    created: '2026-09-01', updated: '2026-09-01',
  }, 'p')
  assert.equal(ok.intention.cue, '早上刷完牙后')
  assert.throws(() => validateHabitDoc({
    habit: 'x', name: 'x', status: 'active', intention: { cue: '', action: 'y' },
    created: 'd', updated: 'd',
  }, 'p'), /cue/)
  assert.throws(() => validateHabitDoc({
    habit: 'x', name: 'x', status: 'paused', intention: { cue: 'c', action: 'a' },
    created: 'd', updated: 'd',
  }, 'p'), /status/)
})

// ---- 行为：建 / 报 / 归档 / 清单 ----

test('习惯全链：建档 → 自报重复（可选自评）→ 清单派生面', async () => {
  await withVault({ tag: 'habit-chain', registry: null, graph: null }, async h => {
    const doc = await h.engine.habitCreate({ name: '晨间音阶', cue: '早上刷完牙后', action: '打开吉他弹一段音阶' })
    assert.equal(doc.status, 'active')
    assert.equal(existsSync(h.paths.habitPath('晨间音阶')), true)
    // 同名拒绝；意图缺字段 fail loud
    await assert.rejects(() => h.engine.habitCreate({ name: '晨间音阶', cue: 'a', action: 'b' }), /已存在/)
    await assert.rejects(() => h.engine.habitCreate({ name: 'x', cue: '', action: 'b' }), /cue 不能为空/)
    await assert.rejects(() => h.engine.habitCreate({ name: 'x', cue: 'c', action: '' }), /action 不能为空/)

    await h.engine.habitRepeat('晨间音阶', { auto_rating: 2 })
    await h.engine.habitRepeat('晨间音阶', {})
    await h.engine.habitRepeat('晨间音阶', { auto_rating: 4, note: '今天很顺' })
    // 自评枚举守门
    await assert.rejects(() => h.engine.habitRepeat('晨间音阶', { auto_rating: 6 }), /1-5/)
    await assert.rejects(() => h.engine.habitRepeat('不存在', {}), /Missing/)

    const list = await h.engine.learner.habitList()
    assert.equal(list.habits.length, 1)
    const view = list.habits[0]
    assert.equal(view.total_repeats, 3)
    assert.equal(view.streak, 1) // 三报都在今天（重复流同日多报只算一天）
    assert.equal(view.latest_rating, 4)
    assert.equal(view.intention.cue, '早上刷完牙后')

    const show = await h.engine.learner.habitShow('晨间音阶')
    assert.equal(show.curve.length, 2) // 只取带自评的点
    assert.equal(show.curve[1].repeats, 3)
    assert.equal(show.recent.length, 3)
    assert.ok(show.recent[0].note === '今天很顺' || show.recent.some(r => r.note === '今天很顺'))
  })
})

test('归档可逆；无到期语义——引擎侧没有任何催办字段', async () => {
  await withVault({ tag: 'habit-arch', registry: null, graph: null }, async h => {
    await h.engine.habitCreate({ name: '散步', cue: '午饭后', action: '出门走十分钟' })
    await h.engine.learner.habitArchive('散步', true)
    assert.equal((await h.engine.habits.load('散步')).status, 'archived')
    // 归档只是收纳标签：仍可自报（无门禁），也可恢复
    await h.engine.habitRepeat('散步', {})
    await h.engine.learner.habitArchive('散步', false)
    assert.equal((await h.engine.habits.load('散步')).status, 'active')
    // 归档参数必须显式
    await assert.rejects(() => h.engine.learner.habitArchive('散步', undefined as never), /显式/)
  })
})

test('红线：习惯域全路径零 canonical 写入（journal/practice/review-log 零行）', async () => {
  await withVault({ tag: 'habit-redline', registry: null, graph: null }, async h => {
    await h.engine.habitCreate({ name: '冥想', cue: '到工位坐下后', action: '闭眼呼吸三分钟' })
    await h.engine.habitRepeat('冥想', { auto_rating: 3 })
    await h.engine.habitRepeat('冥想', { auto_rating: 3 })
    await h.engine.learner.habitArchive('冥想', true)
    // 学习账本零触碰：习惯重复不进 XP、不进 streak、不进任何调度面（ADR-0017 三边界）
    assert.equal((await h.store.journalTail()).length, 0)
    assert.equal((await h.store.practiceAll()).length, 0)
    assert.equal((await h.store.reviewLogAll()).length, 0)
    const xp = await h.engine.xpStatus()
    assert.equal(xp.today_xp, 0)
    assert.equal(xp.streak, 0)
    // 实体零 FSRS 语义：习惯 YAML 无 fsrs/stats 字段（错配表：R/S/D 在习惯域无定义）
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(h.paths.habitPath('冥想'), 'utf8')
    assert.equal(text.includes('fsrs'), false)
    assert.equal(text.includes('due'), false)
  })
})

test('Missing/Broken：缺失合法空态；坏档 load 抛 Broken、清单跳过并报出', async () => {
  await withVault({ tag: 'habit-broken', registry: null, graph: null }, async h => {
    await assert.rejects(() => h.engine.habits.load('不存在'), /Missing/)
    assert.equal(existsSync(h.paths.habitRepeatLogPath), false)
    assert.deepEqual(await h.store.habitRepeatsAll(), [])
    await h.engine.habitCreate({ name: '好的', cue: 'c', action: 'a' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(h.paths.habitPath('坏的'), 'habit: [broken\n', 'utf8')
    await assert.rejects(() => h.engine.habits.load('坏的'), /Broken/)
    const { habits, broken } = await h.engine.habits.list()
    assert.equal(habits.length, 1)
    assert.equal(broken.length, 1)
    assert.match(broken[0].reason, /Broken/)
  })
})
