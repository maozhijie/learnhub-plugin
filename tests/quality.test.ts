import test from 'node:test'
import assert from 'node:assert/strict'
import { jumpCandidates, floatNodes } from '../src/engine/quality.ts'

/** 构造 jumpCandidates / floatNodes 所需的最小图形状（两个函数都是 Pick 接口）。 */
function jumpGraph(nodes: Record<string, { pre: string[]; d?: number; depth: number }>) {
  const names = Object.keys(nodes)
  return {
    names,
    preOf: Object.fromEntries(names.map(n => [n, nodes[n]!.pre])),
    depth: Object.fromEntries(names.map(n => [n, nodes[n]!.depth])),
    difficultyOf: Object.fromEntries(names.filter(n => nodes[n]!.d !== undefined).map(n => [n, nodes[n]!.d])) as Record<string, number>,
  }
}

test('S1: 难度差 >=2 的 pre 边是认知跨步候选', () => {
  const g = jumpGraph({ 基础: { pre: [], d: 1, depth: 0 }, 进阶: { pre: ['基础'], d: 3, depth: 1 } })
  const jumps = jumpCandidates(g)
  assert.equal(jumps.length, 1)
  assert.equal(jumps[0]!.pre, '基础')
  assert.equal(jumps[0]!.node, '进阶')
  assert.deepEqual(jumps[0]!.reasons, ['difficulty'])
  assert.equal(jumps[0]!.difficultyGap, 2)
})

test('S1: depth 跨度 >=3 也是候选（难度未标注时仍命中）', () => {
  const g = jumpGraph({
    远: { pre: [], depth: 2 },
    高: { pre: ['远'], depth: 6 },
  })
  const jumps = jumpCandidates(g)
  assert.equal(jumps.length, 1)
  assert.equal(jumps[0]!.depthSpan, 4)
  assert.deepEqual(jumps[0]!.reasons, ['depth'])
  assert.equal(jumps[0]!.difficultyGap, null)
})

test('S1: 难度差 <2 且跨度 <3 不是候选', () => {
  const g = jumpGraph({ a: { pre: [], d: 2, depth: 0 }, b: { pre: ['a'], d: 3, depth: 1 } })
  assert.equal(jumpCandidates(g).length, 0)
})

test('S1: 难度只标一端时难度口径不参与，靠 depth 口径兜底', () => {
  const g = jumpGraph({ a: { pre: [], d: 1, depth: 0 }, b: { pre: ['a'], depth: 4 } })
  const jumps = jumpCandidates(g)
  assert.equal(jumps.length, 1)
  assert.deepEqual(jumps[0]!.reasons, ['depth'])
})

test('S2: region 序靠后且 pre 为空 = 空降节点', () => {
  const g = {
    names: ['入口', '后段裸奔'],
    preOf: { 入口: [], 后段裸奔: [] },
    regionIdxOf: { 入口: 0, 后段裸奔: 3 },
    regions: [{ name: 'r0' }, { name: 'r1' }, { name: 'r2' }, { name: 'r3' }],
  }
  assert.deepEqual(floatNodes(g), ['后段裸奔'])
})

test('S2: 首 1/4 region 的无 pre 入口不算空降', () => {
  const g = {
    names: ['入口'],
    preOf: { 入口: [] },
    regionIdxOf: { 入口: 1 },
    regions: Array.from({ length: 8 }, (_, i) => ({ name: `r${i}` })),
  }
  assert.deepEqual(floatNodes(g), [])
})

test('S2: 有 pre 的节点永不算空降', () => {
  const g = {
    names: ['后段有前置'],
    preOf: { 后段有前置: ['别的'] },
    regionIdxOf: { 后段有前置: 3 },
    regions: Array.from({ length: 4 }, (_, i) => ({ name: `r${i}` })),
  }
  assert.deepEqual(floatNodes(g), [])
})

test('S2: region 总数 <4 时至少豁免首区（首区入口不误判）', () => {
  const g = {
    names: ['首区入口', '次区入口'],
    preOf: { 首区入口: [], 次区入口: [] },
    regionIdxOf: { 首区入口: 0, 次区入口: 1 },
    regions: [{ name: 'r0' }, { name: 'r1' }],
  }
  assert.deepEqual(floatNodes(g), ['次区入口'])
})



