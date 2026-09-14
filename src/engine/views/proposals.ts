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
  goal_type: 'capability' | 'coverage'
  endpoint: string
  starts: number
  worksheet?: number
  prior_feed_unresponded: number
  warns?: string[]
}

/** 种子提案影响预览（#159）：起草应用确认框的知识前置——知情后再确认（ADR-0076：
 * 课程必须已注册，建课分支已删）。只读现势计算（提案产物 + 当前图 + 现锚），预览必须
 * 说的是引擎真会做的事：新增哪些节点、什么全保留。 */
export interface SeedImpactDoc {
  course: string
  /** 提案将新建的图节点（起点 + 终点中名字还不在当前图上的）。 */
  new_nodes: string[]
  /** 与当前图重名的提案节点：重名会被受理门拒收（提案已不适用当前图）——
   * 非空即应用必败的漂移信号，预览据此提前示警。 */
  existing_nodes: string[]
  /** 当前图节点总数（起草全保留：学习进度、题库与调度不动）。 */
  graph_nodes: number
  /** 现终点锚集合（起草不覆盖既有锚——同名终点已在受理门拒绝；零终点 = 空数组）。 */
  current_anchors: Array<{ endpoint: string; declared: string; origin_proposal?: number }>
  /** 罗盘不在场 = 随本提案脚手架初建；在场 = 原样保留（重置路径已随 ADR-0076 退役）。 */
  compass_reset: boolean
  worksheet_items?: number
}
