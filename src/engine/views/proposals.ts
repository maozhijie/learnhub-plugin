/**
 * 图提案受理结果类型（#142/#140 提案通道；#152 刀 6 自 views.ts/proposals.ts
 * 归位为叶子视图文件——窄面直引它，不经 views barrel 环回提案域）。
 */
import type { GrowthOperator } from '../types.ts'

export interface GraphEditProposalResult {
  id: number
  kind: 'edit'
  course: string
  ops: number
  operator?: GrowthOperator
  disagreement?: boolean
  compass_rewrite?: boolean
  warns?: string[]
}

export interface GraphEnrichProposalResult {
  id: number
  kind: 'enrich'
  course: string
  fields: number
  files: number
}

export type GraphProposeResult = GraphEditProposalResult | GraphSeedProposalResult | GraphEnrichProposalResult

export interface GraphSeedProposalResult {
  id: number
  kind: 'seed'
  course: string
  mode: 'new' | 'reseed'
  goal_type: 'capability' | 'coverage'
  endpoint: string
  starts: number
  worksheet?: number
  prior_feed_unresponded: number
  warns?: string[]
}

/** 种子提案影响预览（#159）：reseed/建课应用确认框的知识前置——知情后再确认。
 * 只读现势计算（提案产物 + 当前图 + 现锚），引擎 reseed 语义不动，预览必须说的是
 * 引擎真会做的事：新增哪些节点、覆盖什么锚、罗盘怎么重置、什么保留。 */
export interface SeedImpactDoc {
  course: string
  mode: 'new' | 'reseed'
  /** 提案将新建的图节点（起点 + 终点中名字还不在当前图上的）。 */
  new_nodes: string[]
  /** 与当前图重名的提案节点：重名会被受理门拒收（提案已不适用当前图）——
   * 非空即应用必败的漂移信号，预览据此提前示警。 */
  existing_nodes: string[]
  /** 当前图节点总数（reseed 全保留：学习进度、题库与调度不动）。 */
  graph_nodes: number
  /** 现终点锚（reseed 时将被新锚整份覆盖；未播种为 null）。 */
  current_anchor: { endpoint: string; declared: string; origin_proposal: number } | null
  /** 罗盘影响：reseed = 路线与 ETA 重置为待初画（批注区保留）；new = 脚手架初建。 */
  compass_reset: boolean
  worksheet_items?: number
}
