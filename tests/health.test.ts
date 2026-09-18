import test from 'node:test'
import assert from 'node:assert/strict'
import { Graph } from '../src/engine/graph/graph.ts'
import { graphHealthScore, estSpreadNote, widthNote } from '../src/engine/graph/health.ts'
import type { GNode } from '../src/engine/types.ts'

/** 最小 GNode 工厂：必填字段补默认值（存储塌缩后图 = GNode 声明序数组）。 */
const gnode = (name: string, pre: string[] = []): GNode => ({ name, pre, opt: false, note: '', enc: [] })

test('S3: 后段空降节点拉低前置完备分（不再恒满分）', () => {
  // 声明序：total=2 → exempt = max(1, ceil(2/4)) = 1；入口 idx0 在豁免带，
  // 「后段裸奔」idx1 靠后且 pre 为空 → 空降 1/2 → (1 - 1/2) * 20 = 10
  const { breakdown } = graphHealthScore(new Graph([gnode('入口'), gnode('后段裸奔')]))
  assert.equal(breakdown.pre_completeness, 10)
})

test('S3: 声明序豁免带内的无 pre 入口是正常起点，前置完备满分', () => {
  // total=4 → exempt = 1：入口 idx0 在豁免带，其余节点都有 pre → 0 空降 → 20
  const { breakdown } = graphHealthScore(new Graph([
    gnode('入口'),
    gnode('基础', ['入口']),
    gnode('进阶', ['基础']),
    gnode('高阶', ['进阶']),
  ]))
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

// ---- S77 图宽度读数（#335 刀③；advisor-only，与 estSpreadNote 同族） ----

function widthGraph(total: number, depthOf: (i: number) => number): Parameters<typeof widthNote>[0] {
  const names: string[] = []
  const depth: Record<string, number> = {}
  for (let i = 0; i < total; i++) { names.push(`n${i}`); depth[`n${i}`] = depthOf(i) }
  return { names, depth } as never
}

test('S77: 单链图（同层并行度 ≤2 且深度占比 ≥0.8）→ 提示宽度不足', () => {
  // 15 节点纯单链：maxWidth=1，depth 占比 14/15 ≈ 93%
  const note = widthNote(widthGraph(15, i => i))
  assert.ok(note, '单链图应返回提示')
  assert.match(note!, /宽度不足/)
})

test('S77: 有并行分叉（同层 ≥3 且深度占比 <0.8）→ 无提示', () => {
  // 15 节点分 5 层、每层 3 节点：maxWidth=3，占比 33%
  assert.equal(widthNote(widthGraph(15, i => Math.floor(i / 3))), null)
})

test('S77: 节点过少不判（小图天然窄）；空图不判', () => {
  assert.equal(widthNote(widthGraph(6, i => i)), null)
  assert.equal(widthNote(widthGraph(0, () => 0)), null)
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
