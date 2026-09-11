/**
 * Clock／Rng 端口注入缝（#175 阶段① / ADR-0044 归属）：形状住 engine/clock.ts、
 * 实现住 host/clock.ts、装配住 EngineConfig。本文件断言外移的收益——注入固定时钟
 * 与定长随机流后，「同一输入同一输出」可断言，而不是靠碰运气。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { withVault } from './helpers/vault.ts'
import { nowIsoOf } from '../src/engine/dates.ts'
import type { Clock, Rng } from '../src/engine/index.ts'

/** 固定时钟（任意常量时刻；与真实现在相距足够远，可断言缺省注入确实不同）。 */
const FIXED: Clock = { nowMs: () => 1_760_000_000_000 }

/** 定长随机流（LCG：同种子同序列；[0,1) 与 Math.random 同约）。 */
function seededRng(seed: number): Rng {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

/** matching 题：content-subsystem 的题目视图会按 jolRng 洗 pairOptions（防按序泄题）。 */
const MATCHING_BANK = [
  'node: 入门',
  'questions:',
  '  - id: m1',
  '    kind: matching',
  '    q: 连线',
  '    options: ["甲", "乙", "丙"]',
  '    answer: ["一", "二", "三"]',
].join('\n')

test('时钟端口：固定时钟下 doctor.generated_at 确定（同输入同输出），与缺省真实时钟可区分', async () => {
  const run = (clock?: Clock) =>
    withVault({ ...(clock ? { clock } : {}) }, async ({ engine }) => (await engine.doctor()).generated_at)
  assert.equal(await run(FIXED), nowIsoOf(FIXED.nowMs()), '生成时刻 = 注入时刻的本地 ISO 渲染')
  assert.equal(await run(FIXED), await run(FIXED), '两个固定时钟引擎同输出（同一输入同一输出）')
  assert.notEqual(await run(), await run(FIXED), '缺省注入 = 真实系统时钟（systemClock），与固定时刻可区分')
})

test('随机端口：同种子定长流下 pairOptions 洗牌确定（同输入同输出），且值集合不漂移', async () => {
  const run = async (rng: Rng) =>
    withVault({ banks: { 入门: MATCHING_BANK }, rng }, async ({ engine }) => {
      const doc = await engine.questions('数学', '入门') as { questions: Array<{ pairOptions?: string[] }> }
      return doc.questions[0].pairOptions
    })
  const a = await run(seededRng(42))
  const b = await run(seededRng(42))
  assert.deepEqual(a, b, '同种子两个引擎产出同一洗牌序')
  assert.deepEqual([...(a ?? [])].sort(), [...['一', '二', '三']].sort(), '洗牌只动顺序不改内容')
})

test('jolRng 先例兼容：配置的 rng 是 jolRng 的缺省上游，测试仍可直接换 jolRng 播种', async () => {
  await withVault({ rng: seededRng(7) }, async ({ engine }) => {
    const ref = seededRng(7) // 参考流：与引擎同种子，逐元素对齐
    assert.equal(engine.jolRng(), ref(), 'jolRng 缺省与 rng 端口同源（推进同一条流）')
    assert.equal(engine.rng(), ref(), '下一次 rng 调用 = 流的下一个元素')
    engine.jolRng = () => 0.5
    assert.equal(engine.jolRng(), 0.5, 'public jolRng 属性播种通道保持（#66 E4 先例）')
    assert.equal(engine.rng(), ref(), '换 jolRng 不影响 rng 端口本体')
  })
})
