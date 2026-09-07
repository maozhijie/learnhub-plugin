import test from 'node:test'
import assert from 'node:assert/strict'
import { graphHealthScore } from '../src/engine/health.ts'

/** graphHealthScore 所需的最小图形状（只给 health 实际读取的字段）。 */
function healthGraph({ regionCount, floatIdx }: { regionCount: number; floatIdx: number }) {
  const names = ['入口', '后段裸奔']
  return {
    names,
    nset: new Set(names),
    preOf: { 入口: [], 后段裸奔: [] },
    estOf: {},
    depth: { 入口: 0, 后段裸奔: 0 },
    hasCycle: false,
    components: [names],
    roots: ['入口'],
    regionIdxOf: { 入口: 0, 后段裸奔: floatIdx },
    regions: Array.from({ length: regionCount }, (_, i) => ({ name: `r${i}` })),
  }
}

test('S3: 后段空降节点拉低前置完备分（不再恒满分）', () => {
  const { breakdown } = graphHealthScore(healthGraph({ regionCount: 4, floatIdx: 3 }) as never)
  assert.equal(breakdown.pre_completeness, 10)
})

test('S3: 入口 region 的无 pre 节点是正常起点，前置完备满分', () => {
  const { breakdown } = graphHealthScore(healthGraph({ regionCount: 8, floatIdx: 0 }) as never)
  assert.equal(breakdown.pre_completeness, 20)
})
