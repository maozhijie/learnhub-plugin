import test from 'node:test'
import assert from 'node:assert/strict'
import {
  complexityTier,
  checkOutlineBudget,
  TIER_ANCHORS,
  TIER_LABELS,
  preClosureSizes,
  preClosureP75,
  nodeTierOf,
  outlineBudgetForNode,
  type TierSignals,
  type GraphSignalsSource,
} from '../src/engine/complexity.ts'

// ---- 折叠：difficulty 基档 ----

test('P0: difficulty 1-2 → 低档、3 → 中档、4-5 → 高档（无 bloom/深度信号时）', () => {
  assert.equal(complexityTier({ difficulty: 1 }), 1)
  assert.equal(complexityTier({ difficulty: 2 }), 1)
  assert.equal(complexityTier({ difficulty: 3 }), 2)
  assert.equal(complexityTier({ difficulty: 4 }), 3)
  assert.equal(complexityTier({ difficulty: 5 }), 3)
})

// ---- 折叠：bloom / pre 闭包提档（封顶高） ----

test('P0: bloom 高阶（分析/评价/创造）提一档', () => {
  assert.equal(complexityTier({ difficulty: 3, bloom: '应用' }), 2) // 低阶不提
  assert.equal(complexityTier({ difficulty: 3, bloom: '分析' }), 3)
  assert.equal(complexityTier({ difficulty: 3, bloom: '评价' }), 3)
  assert.equal(complexityTier({ difficulty: 2, bloom: '创造' }), 2) // 低→中
})

test('P0: pre 闭包规模 ≥ p75 提一档', () => {
  assert.equal(complexityTier({ difficulty: 3, preClosureSize: 6, preClosureP75: 8 }), 2)
  assert.equal(complexityTier({ difficulty: 3, preClosureSize: 9, preClosureP75: 8 }), 3)
})

test('P0: 提档封顶高档，不越界', () => {
  assert.equal(complexityTier({ difficulty: 5, bloom: '创造', preClosureSize: 99, preClosureP75: 8 }), 3)
  assert.equal(complexityTier({ difficulty: 1, bloom: '创造', preClosureSize: 99, preClosureP75: 8 }), 3)
})

// ---- 折叠：est 只在 difficulty 缺失时作回退 ----

test('P0: difficulty 缺失时按 est 回退（≤15 低、≤25 中、>25 高）', () => {
  assert.equal(complexityTier({ est: 10 }), 1)
  assert.equal(complexityTier({ est: 15 }), 1)
  assert.equal(complexityTier({ est: 20 }), 2)
  assert.equal(complexityTier({ est: 25 }), 2)
  assert.equal(complexityTier({ est: 30 }), 3)
})

test('P0: difficulty 在场时 est 不参与分档（est 只作容量上界）', () => {
  assert.equal(complexityTier({ difficulty: 4, est: 10 }), 3)
  assert.equal(complexityTier({ difficulty: 2, est: 35 }), 1)
})

test('P0: difficulty 与 est 都缺失 → 中档兜底', () => {
  assert.equal(complexityTier({}), 2)
  assert.equal(complexityTier({ bloom: '创造' }), 3) // 兜底中 + bloom 提档
})

// ---- 护栏：方向性极端才拦 ----

test('P0: 低档 >7 节拦（spec：difficulty≤2 产出 8 节）', () => {
  assert.deepEqual(checkOutlineBudget(1, 7), [])
  assert.ok(checkOutlineBudget(1, 8).some(f => f.includes('过多')))
})

test('P0: 高档 ≤2 节拦（复杂节点被压扁）', () => {
  assert.deepEqual(checkOutlineBudget(3, 3), [])
  assert.ok(checkOutlineBudget(3, 2).some(f => f.includes('过少')))
})

test('P0: 任意档 >8 节拦（总上限）', () => {
  assert.deepEqual(checkOutlineBudget(2, 8), [])
  assert.ok(checkOutlineBudget(2, 9).some(f => f.includes('超过')))
})

test('P0: 合法弹性放行（高档 6 节、中档 5 节、低档 3 节）', () => {
  assert.deepEqual(checkOutlineBudget(3, 6), [])
  assert.deepEqual(checkOutlineBudget(2, 5), [])
  assert.deepEqual(checkOutlineBudget(1, 3), [])
})

// ---- 锚点表 ----

test('P0: 三档锚点齐备且单调递增', () => {
  const order: TierSignals['difficulty'][] = []
  assert.deepEqual(Object.keys(TIER_ANCHORS), ['1', '2', '3'])
  assert.deepEqual(TIER_LABELS, { 1: '低', 2: '中', 3: '高' })
  for (const tier of [1, 2, 3] as const) {
    const a = TIER_ANCHORS[tier]
    assert.ok(a.sections[0] <= a.sections[1], `档 ${tier} 节段区间应升序`)
    assert.ok(a.sections[1] >= 1)
  }
  assert.ok(TIER_ANCHORS[3].sectionWordBudget > TIER_ANCHORS[1].sectionWordBudget)
  assert.ok(TIER_ANCHORS[3].perSectionQuestions >= TIER_ANCHORS[2].perSectionQuestions)
  assert.ok(TIER_ANCHORS[3].genericQuizCount > TIER_ANCHORS[1].genericQuizCount)
})

test('P0: 锚点初值符合收敛记录（低 1-3/中 3-5/高 4-6，题量随档位）', () => {
  assert.deepEqual(TIER_ANCHORS[1].sections, [1, 3])
  assert.deepEqual(TIER_ANCHORS[2].sections, [3, 5])
  assert.deepEqual(TIER_ANCHORS[3].sections, [4, 6])
  assert.equal(TIER_ANCHORS[1].genericQuizCount, 2)
  assert.equal(TIER_ANCHORS[2].genericQuizCount, 3)
  assert.equal(TIER_ANCHORS[3].genericQuizCount, 4)
  assert.equal(TIER_ANCHORS[1].perSectionQuestions, 1)
  assert.equal(TIER_ANCHORS[3].perSectionQuestions, 3)
})

// ---- 图谱侧派生（pre 闭包规模 / p75 / 节点档位 / 节点护栏） ----

/** 最小图信号源：链 A→B→C，D 孤立。 */
function chainGraph(): GraphSignalsSource {
  return {
    names: ['A', 'B', 'C', 'D'],
    pred: { A: [], B: ['A'], C: ['B'], D: [] },
    difficultyOf: { A: 2, B: 3, C: 4, D: 1 },
    bloomOf: { A: '记忆', B: '应用', C: '分析' },
    estOf: { A: 15, B: 20, C: 30 },
  }
}

test('P0: pre 闭包规模 = 传递前置总数（不含自身），孤立节点为 0', () => {
  const sizes = preClosureSizes(chainGraph())
  assert.equal(sizes['A'], 0)
  assert.equal(sizes['B'], 1)
  assert.equal(sizes['C'], 2)
  assert.equal(sizes['D'], 0)
})

test('P0: p75 取规模分布 75 分位', () => {
  const g = chainGraph()
  // 规模 [0,0,1,2] → 排序后 75 分位下标 = floor(4*0.75)=3 → 值 2
  assert.equal(preClosureP75(g), 2)
})

test('P0: 节点档位 = 折叠函数 + 图内 p75 深度提档', () => {
  const g = chainGraph()
  assert.equal(nodeTierOf(g, 'A'), 1) // difficulty2,规模0,p75=2 不提
  assert.equal(nodeTierOf(g, 'B'), 2) // difficulty3,规模1<p75 不提
  assert.equal(nodeTierOf(g, 'C'), 3) // difficulty4 → 高
  assert.equal(nodeTierOf(g, 'D'), 1) // difficulty1
})

test('P0: 深节点（规模≥p75）对中档节点提档', () => {
  // 星形：中心 M(difficulty3) 有 3 个前置叶 → 闭包规模 3 = p75 → 提档到高
  const star: GraphSignalsSource = {
    names: ['L1', 'L2', 'L3', 'M'],
    pred: { L1: [], L2: [], L3: [], M: ['L1', 'L2', 'L3'] },
    difficultyOf: { L1: 1, L2: 1, L3: 1, M: 3 },
    bloomOf: {},
    estOf: {},
  }
  // 规模分布 [0,0,0,3] → 75 分位下标 floor(4*.75)=3 → 值 3；M 规模 3 ≥ 3 → 提档高
  assert.equal(preClosureP75(star), 3)
  assert.equal(nodeTierOf(star, 'M'), 3)
  assert.equal(nodeTierOf(star, 'L1'), 1)
})

test('P0: outlineBudgetForNode 按节点档位拦方向性极端', () => {
  const g = chainGraph()
  // A 低档：8 节拦、7 节放行
  assert.ok(outlineBudgetForNode(g, 'A', 8).length > 0)
  assert.deepEqual(outlineBudgetForNode(g, 'A', 7), [])
  // C 高档：2 节拦、3 节放行
  assert.ok(outlineBudgetForNode(g, 'C', 2).length > 0)
  assert.deepEqual(outlineBudgetForNode(g, 'C', 3), [])
})

test('P0: preClosureSizes 同一 graph 对象缓存、跨调用稳定', () => {
  const g = chainGraph()
  assert.deepEqual(preClosureSizes(g), preClosureSizes(g))
})
