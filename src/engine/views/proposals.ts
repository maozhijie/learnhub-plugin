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
