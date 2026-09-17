/**
 * 图提案受理结果类型（#142/#140 提案通道；#152 刀 6 自 views.ts/proposals.ts
 * 归位为叶子视图文件——窄面直引它，不经 views barrel 环回提案域）。
 */
export interface GraphEditProposalResult {
  id: number
  kind: 'edit'
  course: string
  ops: number
  /** 生长批的去重算子列表（#327 逐条目化：批内 add_node 的 operator 去重，条目出现序）。 */
  operators?: string[]
  disagreement?: boolean
  warns?: string[]
}

export interface GraphEnrichProposalResult {
  id: number
  kind: 'enrich'
  course: string
  fields: number
  files: number
}

export type GraphProposeResult = GraphEditProposalResult | GraphEnrichProposalResult

/** 概念层治理域提案的确认结果（#265 / ADR-0084）：合并（不可逆：只并入、不拆分）与
 * 易混对候选入册（只写提案声明的方向——单向是待复核态）。两者都只从面板
 * /proposals/apply 可达（确认门是人的动作）。 */
export type ConceptApplyResult =
  | { kind: 'concept_merge'; course: string; from: string; into: string; names: string[] }
  | { kind: 'confusable_pair'; course: string; a: string; b: string; changed: boolean }
