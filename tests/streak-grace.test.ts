/**
 * XP streak 宽容机制（C-4 #83）：漏天不归零、可恢复；账本口径不变。
 *
 * - 纯函数：streakFrom 宽容口径（≤ graceDays 连续漏天跳过不断链、超窗截断、
 *   today 未学不罚也不耗宽容）。
 * - 行为（vault seam）：流水播种 → xpStatus 派生——漏一天 streak 仍累计，
 *   且 streak_grace_days 随视图暴露（day_cutoff 先例的可见性）。
 * - 红线：账本口径不变——today_xp 仍按流水 xp 字段结算，宽容只改 streak 这一个读法。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { streakFrom } from '../src/engine/xp.ts'
import { XP_STREAK_GRACE_DAYS } from '../src/engine/params.ts'
import { localDay, withVault } from './helpers/vault.ts'

// 学习日种子走本地日历日（helpers.localDay）：UTC 日在本地 0 点后与引擎「今天」错位一天
const T = localDay

const byDayOf = (days: string[]): Record<string, { total: number }> =>
  Object.fromEntries(days.map(d => [d, { total: 1 }]))

// ---- 纯函数：宽容口径 ----

test('宽容 streak：漏 1 天不断链（Lally 漏一天无碍）', () => {
  // 昨天学了、前天漏、大前天学了 → 2（旧口径只有 1）
  assert.equal(streakFrom(byDayOf([T(-1), T(-3)]), T(0)), 2)
  // 全连着 → 不变
  assert.equal(streakFrom(byDayOf([T(-1), T(-2), T(-3)]), T(0)), 3)
})

test('宽容 streak：空窗超过容忍度截断；容忍度可调', () => {
  // 漏 2 天（T(-2)、T(-3)）> 默认容忍 1 → 截断，久置历史不算进当前 streak
  assert.equal(streakFrom(byDayOf([T(-1), T(-4)]), T(0)), 1)
  assert.equal(streakFrom(byDayOf([T(-1), T(-30)]), T(0)), 1)
  // 容忍度 2 → 同一形状接上
  assert.equal(streakFrom(byDayOf([T(-1), T(-4)]), T(0), 2), 2)
  // 显式传 0 = 旧严格口径
  assert.equal(streakFrom(byDayOf([T(-1), T(-3)]), T(0), 0), 1)
})

test('宽容 streak：today 未学不罚也不耗宽容；全空 = 0', () => {
  // 今天还没学：起点回退昨天，昨天学了 → 1（宽容没有被今天提前吃掉）
  assert.equal(streakFrom(byDayOf([T(-1)]), T(0)), 1)
  // 今天没学 + 昨天也漏（在容忍内）→ 大前天仍计入
  assert.equal(streakFrom(byDayOf([T(-2)]), T(0)), 1)
  assert.equal(streakFrom({}, T(0)), 0)
  // 非法 today
  assert.equal(streakFrom(byDayOf([T(-1)]), 'not-a-day'), 0)
})

test('宽容 streak 参数来源：params 常量 = 1（漏一天无碍的证据口径）', () => {
  assert.equal(XP_STREAK_GRACE_DAYS, 1)
})

// ---- 行为：流水播种 → xpStatus 派生 ----

test('xpStatus：漏一天后 streak 仍累计；grace 随视图暴露；账本口径不变', async () => {
  await withVault({ tag: 'streak-grace-', registry: null, graph: null }, async h => {
    const row = (offset: number, xp: number) => h.store.appendPractice({
      ts: `${T(offset)}T12:00:00`, course: '数学', node: '入门', ex: 1,
      answer: '对', correct: true, judge: 'auto', xp,
    })
    await row(-2, 5)
    await row(0, 7)   // 今天学了；昨天漏（容忍内）→ streak = 2
    // journal 行同样计入按日行为（行为流水即事实）
    await h.store.appendJournal({
      ts: `${T(0)}T13:00:00`, course: '数学', node: '入门', rating: null,
      kind: 'xp_bonus', elapsed_days: 0, xp: 2,
    })

    const xp = await h.engine.sched2.xpStatus()
    assert.equal(xp.streak, 2)
    assert.equal(xp.streak_grace_days, XP_STREAK_GRACE_DAYS)
    // 红线：账本口径不变——today_xp 仍 = 该学习日流水 xp 之和（7 + 2），宽容不动账
    assert.equal(xp.today_xp, 9)
  })
})
