import test from 'node:test'
import assert from 'node:assert/strict'
import { graphHealthScore, estSpreadNote } from '../src/engine/health.ts'

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

// ---- S3.5 est 分布压缩提示（advisor-only；不改健康分，est 重标注属图生成专题） ----

function spreadGraph(allNames: string[], estOf: Record<string, number>): Parameters<typeof estSpreadNote>[0] {
  return { names: allNames, estOf } as never
}

test('S3.5: est 挤在窄区间（p10-p90 ≤10min）→ 提示分布压缩', () => {
  const names: string[] = []
  const estOf: Record<string, number> = {}
  // 280 节点挤在 20-25（audit 实证形态）
  for (let i = 0; i < 140; i++) { names.push(`n${i}`, `m${i}`); estOf[`n${i}`] = 20; estOf[`m${i}`] = 25 }
  const note = estSpreadNote(spreadGraph(names, estOf))
  assert.ok(note, '压缩分布应返回提示')
  assert.match(note!, /est/)
})

test('S3.5: est 分布拉开（p10-p90 宽）→ 无提示', () => {
  const names: string[] = []
  const estOf: Record<string, number> = {}
  for (let i = 0; i < 300; i++) { names.push(`n${i}`); estOf[`n${i}`] = 5 + Math.floor(i / 6) } // 5..54 均匀铺开
  assert.equal(estSpreadNote(spreadGraph(names, estOf)), null)
})

test('S3.5: est 覆盖率过低或无 est 不提示（欠标注 ≠ 压缩）', () => {
  assert.equal(estSpreadNote(spreadGraph([], {})), null)
  const names: string[] = []
  const partial: Record<string, number> = {}
  // 300 节点仅 60 个有 est → 覆盖率 20%：欠标注，不判压缩
  for (let i = 0; i < 300; i++) names.push(`n${i}`)
  for (let i = 0; i < 60; i++) partial[`e${i}`] = 20
  assert.equal(estSpreadNote(spreadGraph(names, partial)), null)
})
