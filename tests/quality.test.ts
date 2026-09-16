import test from 'node:test'
import assert from 'node:assert/strict'
import { jumpCandidates, floatNodes } from '../src/engine/graph/quality.ts'
import type { GNode } from '../src/engine/types.ts'

/** 最小 GNode 工厂：必填字段补默认值。 */
const gnode = (name: string, pre: string[] = []): GNode => ({ name, pre, opt: false, note: '', enc: [] })

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

test('S2: 声明序靠后且 pre 为空 = 空降节点', () => {
  const g = {
    names: ['入口', '后段裸奔'],
    preOf: { 入口: [], 后段裸奔: [] },
    nodes: [gnode('入口'), gnode('后段裸奔')],
  }
  // total=2 → exempt = max(1, ceil(2/4)) = 1：入口 idx0 在豁免带，后段裸奔 idx1 靠后
  assert.deepEqual(floatNodes(g), ['后段裸奔'])
})

test('S2: 声明序豁免带（首 ceil(total/4) 个）内的无 pre 入口不算空降', () => {
  const g = {
    names: ['入口', '基础', '进阶', '高阶'],
    preOf: { 入口: [], 基础: ['入口'], 进阶: ['基础'], 高阶: ['进阶'] },
    nodes: [gnode('入口'), gnode('基础', ['入口']), gnode('进阶', ['基础']), gnode('高阶', ['进阶'])],
  }
  // total=4 → exempt = 1：入口 idx0 在豁免带，其余节点都有 pre
  assert.deepEqual(floatNodes(g), [])
})

test('S2: 有 pre 的节点永不算空降', () => {
  const g = {
    names: ['后段有前置'],
    preOf: { 后段有前置: ['别的'] },
    nodes: [gnode('垫底'), gnode('后段有前置', ['别的'])],
  }
  // idx1 靠后但 pre 非空 → 不空降
  assert.deepEqual(floatNodes(g), [])
})

test('S2: 节点总数 <4 时至少豁免首个声明（首入口不误判）', () => {
  const g = {
    names: ['入口甲', '入口乙'],
    preOf: { 入口甲: [], 入口乙: [] },
    nodes: [gnode('入口甲'), gnode('入口乙')],
  }
  // total=2 → exempt = max(1, ceil(2/4)) = 1：入口甲 idx0 豁免，入口乙 idx1 空降
  assert.deepEqual(floatNodes(g), ['入口乙'])
})



