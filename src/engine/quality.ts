/**
 * 图结构质量检测器：认知跨步（Jump）/ 空降节点（Float）/ 规模底线（Scale Floor）。
 *
 * 纯函数、零依赖（Graph 只以 Pick/类型形式出现），供三处消费：
 * - audit.ts：R13 跨步候选 WARN
 * - analysis.ts：suggestions.jump_candidates / merge_blocks、scale 对照
 * - health.ts：前置完备项的空降口径
 * 术语口径见 CONTEXT.md「Jump / Float / Scale Floor」；规模独立门槛的决策见 ADR-0002。
 */
import type { Graph } from './graph.ts'

/** 难度跳跃门槛：|difficulty(n) - difficulty(p)| >= 2（两端都标注才参与）。 */
export const JUMP_DIFFICULTY_GAP = 2
/** 铺垫断层门槛：depth(n) - depth(p) >= 3（pre 派生深度，中间至少空两层台阶）。 */
export const JUMP_DEPTH_SPAN = 3
/** 空降阈值：region 序前 1/4 是合法起点区；小图（region <4 个）至少豁免首区。 */
export const FLOAT_REGION_THRESHOLD = 0.25

export type JumpReason = 'difficulty' | 'depth'

export interface JumpCandidate {
  pre: string
  node: string
  /** 难度差；任一端未标注时为 null（此时只剩 depth 口径）。 */
  difficultyGap: number | null
  depthSpan: number
  reasons: JumpReason[]
}

/** 认知跨步候选：|Δdifficulty| >= 2 或 depth 跨度 >= 3，任一命中（合成口径，两者可并存）。 */
export function jumpCandidates(
  graph: Pick<Graph, 'names' | 'preOf' | 'depth' | 'difficultyOf'>,
): JumpCandidate[] {
  const out: JumpCandidate[] = []
  for (const n of graph.names) {
    for (const p of graph.preOf[n]) {
      const dn = graph.difficultyOf[n]
      const dp = graph.difficultyOf[p]
      const gap = dn !== undefined && dp !== undefined ? Math.abs(dn - dp) : null
      const span = (graph.depth[n] ?? 0) - (graph.depth[p] ?? 0)
      const reasons: JumpReason[] = []
      if (gap !== null && gap >= JUMP_DIFFICULTY_GAP) reasons.push('difficulty')
      if (span >= JUMP_DEPTH_SPAN) reasons.push('depth')
      if (reasons.length) out.push({ pre: p, node: n, difficultyGap: gap, depthSpan: span, reasons })
    }
  }
  return out.sort((a, b) => b.depthSpan - a.depthSpan || a.node.localeCompare(b.node) || a.pre.localeCompare(b.pre))
}

/** 空降节点：region 序靠后（前 1/4 之外）且 pre 为空——内容凭空拔高的结构信号。 */
export function floatNodes(
  graph: Pick<Graph, 'names' | 'preOf' | 'regionIdxOf' | 'regions'>,
): string[] {
  const total = graph.regions.length
  if (!total) return []
  const exempt = Math.max(1, Math.ceil(total * FLOAT_REGION_THRESHOLD))
  return graph.names
    .filter(n => graph.preOf[n].length === 0 && graph.regionIdxOf[n] >= exempt)
    .sort()
}

export interface ScaleTarget { min: number; max: number }

export interface ScaleReport {
  nodes: number
  target: ScaleTarget | null
  /** null = 未宣布目标，不作判定；超上限不拦（宁愿节点过多不要过少）。 */
  ok: boolean | null
  shortfall: number
}

/** 规模底线对照：节点数是否达到宣布的目标下限，缺口多少。 */
export function scaleReport(nodes: number, target?: ScaleTarget | null): ScaleReport {
  if (!target) return { nodes, target: null, ok: null, shortfall: 0 }
  return { nodes, target, ok: nodes >= target.min, shortfall: Math.max(0, target.min - nodes) }
}
