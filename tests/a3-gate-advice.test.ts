import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../src/engine/graph.ts'
import {
  gateAdvice, isStruggle, withinStruggleWindow, encRemedialAdvice,
  STRUGGLE_MIN_ATTEMPTS, STRUGGLE_WINDOW_DAYS,
} from '../src/engine/sessions.ts'
import type { EncEdge, Fm, GNode, GRegion } from '../src/engine/types.ts'

const gnode = (name: string, pre: string[] = [], enc: EncEdge[] = []): GNode =>
  ({ name, pre, opt: false, note: '', enc })

function buildGraph(...nodes: GNode[]): Graph {
  const regions: GRegion[] = [{ name: '区', color: '', blocks: [{ name: '块', nodes }] }]
  return new Graph(regions)
}

const fm = (stage: Fm['stage']): Fm => ({
  node: '', stage, fsrs: null,
  content: { version: 0, generated_at: null, status: 'draft' },
  practice: { attempts: 0, correct: 0 },
})

test('gateAdvice：R 衰减的 done 前置 → 可执行建议项 {node, r, due}；R 达标或硬阻塞不产建议', () => {
  const graph = buildGraph(
    gnode('前置A'), gnode('前置B'), gnode('目标', ['前置A', '前置B']), gnode('独立'),
  )
  const state = { 前置A: fm('review'), 前置B: fm('review'), 目标: fm('ready'), 独立: fm('ready') }
  const dueCount = (n: string) => (n === '前置A' ? 3 : 0)

  const decayed = gateAdvice(graph, state, n => (n === '前置A' ? 0.5 : 0.9), 0.85, dueCount)
  assert.deepEqual(decayed['目标'], [{ node: '前置A', r: 0.5, due: 3 }], '只有衰减前置进入建议')
  assert.equal(decayed['独立'], undefined, '未被拦下的候选无建议')

  const healthy = gateAdvice(graph, state, () => 0.9, 0.85, dueCount)
  assert.deepEqual(healthy['目标'], undefined, '前置 R 达标 → 无建议')

  const hardBlocked = buildGraph(gnode('前置A'), gnode('目标', ['前置A']))
  const hardState = { 目标: fm('ready') } as Record<string, Fm>
  assert.deepEqual(gateAdvice(hardBlocked, hardState, () => 0.5, 0.85, () => 0)['目标'], undefined,
    '前置未完成是硬阻塞，不是软闸建议的语义来源')
})

test('gateAdvice：多个弱前置按 R 升序（最衰减的排最前）', () => {
  const graph = buildGraph(gnode('A'), gnode('B'), gnode('目标', ['A', 'B']))
  const state = { A: fm('review'), B: fm('review'), 目标: fm('ready') }
  const advice = gateAdvice(graph, state, n => (n === 'A' ? 0.5 : n === 'B' ? 0.3 : 1), 0.85, () => 1)
  assert.deepEqual(advice['目标']!.map(a => a.node), ['B', 'A'])
})

test('isStruggle：作答量门槛低数据静默，正确率 <0.6 才算', () => {
  assert.equal(isStruggle(STRUGGLE_MIN_ATTEMPTS - 1, 0), false, '作答量不足 → 静默')
  assert.equal(isStruggle(3, 1), true, '3 次对 1 次（0.33）→ struggle')
  assert.equal(isStruggle(3, 2), false, '3 次对 2 次（0.67）→ 不算')
  assert.equal(isStruggle(10, 5), true, '10 次对一半 → struggle')
})

test('withinStruggleWindow：近期窗口按本地日，未来时间戳不算', () => {
  const today = '2026-09-08'
  assert.equal(withinStruggleWindow('2026-09-08T09:00:00', today), true, '当天')
  assert.equal(withinStruggleWindow('2026-08-26T00:00:00', today), true, '13 天前（窗口内）')
  assert.equal(withinStruggleWindow('2026-08-25T23:59:00', today), false, '14 天前（窗口外）')
  assert.equal(withinStruggleWindow('2026-09-09T00:00:00', today), false, '未来时间戳')
  assert.equal(withinStruggleWindow('2026-09-08T09:00:00', today, 1), true, '自定义窗口：当天仍在内')
  assert.equal(withinStruggleWindow('2026-09-07T09:00:00', today, 1), false, '自定义窗口：1 天前已出窗')
  assert.ok(STRUGGLE_WINDOW_DAYS >= 7, '窗口宽度常量存在且为周级别以上')
})

test('encRemedialAdvice：按 w×(1−R) 降序，图外技能边跳过，limit 截头部，enc 空静默', () => {
  const graph = buildGraph(
    gnode('N', [], [
      { node: 'E1', w: 0.9 },
      { node: 'E2', w: 0.4 },
      { node: 'E3', w: 0.6 },
      { node: '幽灵', w: 0.99 },
    ]),
    gnode('E1'), gnode('E2'), gnode('E3'),
  )
  const rValue = (n: string) => (n === 'E1' ? 0.9 : n === 'E2' ? 0.5 : 0.2)
  const dueCount = (n: string) => (n === 'E3' ? 5 : 0)

  const advice = encRemedialAdvice(graph, 'N', rValue, dueCount)
  // rank：E3 = 0.6×0.8 = 0.48 > E2 = 0.4×0.5 = 0.2 > E1 = 0.9×0.1 = 0.09
  assert.deepEqual(advice.map(a => a.node), ['E3', 'E2', 'E1'], 'w×(1−R) 降序')
  assert.deepEqual(advice[0], { node: 'E3', w: 0.6, r: 0.2, due: 5 }, '带权重/R/到期题数')

  assert.deepEqual(encRemedialAdvice(graph, 'N', rValue, dueCount, 2).map(a => a.node), ['E3', 'E2'],
    'limit 截头部若干')

  const bare = buildGraph(gnode('N', [], []), gnode('E1'))
  assert.deepEqual(encRemedialAdvice(bare, 'N', rValue, dueCount), [], 'enc 为空 → 静默返回 []')
})
