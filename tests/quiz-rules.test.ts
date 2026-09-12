import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ASK_PER_ROUND, PASS_STREAK, passStreakFor } from '../ui/src/lib/quiz-rules.ts'

// ---- passStreakFor：连对目标随轮内题量收缩 ----
// 回归背景：面板曾固定 PASS_STREAK=2，而出题侧锚点调整前的低档节点每节仅 1 题，
// 1 题的轮永远无法连对 2 → 卡死在 struggle 分支。现锚点地板已提至 2/节，
// 此自适应仍是防线：任何来源的题量收缩（含练习节 -1、节重写少题）都不再卡死。

test('passStreakFor: 1 题的轮目标降为 1（答对即过，不再数学上不可达）', () => {
  assert.equal(passStreakFor(1), 1)
})

test('passStreakFor: 题量充足时维持基准连对 2', () => {
  assert.equal(PASS_STREAK, 2)
  assert.equal(passStreakFor(2), 2)
  assert.equal(passStreakFor(5), 2)
})

test('passStreakFor: 退化输入（0/负）下限为 1，不产生 0 目标', () => {
  assert.equal(passStreakFor(0), 1)
  assert.equal(passStreakFor(-3), 1)
})

test('MAX_ASK_PER_ROUND: 每轮作答上限为 5（struggle 阈值，防无限刷题）', () => {
  assert.equal(MAX_ASK_PER_ROUND, 5)
})
