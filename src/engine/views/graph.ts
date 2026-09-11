/**
 * graph 域视图类型（#152 刀归档；叶子文件，只引类型层）。
 */
import type { ContentStatus, EncEdge, GrowthOperator, Stage } from '../types.ts'
import type { GraphProposeResult } from './proposals.ts'

/** 富化提案受理（proposeEnrich，覆盖层通道）：files = 指纹锚定的正典文件数。 */

export interface GraphApplyEditResult {
  course: string
  ops: number
  snapshot: number
  created_blocks: string[]
  /** rename 联动：旧名 → 新名。 */
  renames: Record<string, string>
  deleted: string[]
  /** 生长批字段（#145 note 区在场时随行）：算子标签 + 理由 + 分歧声明 + 罗盘同事务重写。 */
  operator?: GrowthOperator
  coach_reason?: string
  disagreement?: boolean
  compass_rewritten?: boolean
  findings: string[]
}

/** 富化提案 apply（指纹复核通过后写正典）：files = 被重写的区文件。 */
export interface GraphApplyEnrichResult {
  course: string
  fields: number
  snapshot: number
  files: string[]
  findings: string[]
}

export type GraphApplyResult = GraphApplyEditResult | GraphApplySeedResult | GraphApplyEnrichResult

/** 种子提案 apply（#142）：终点锚落盘 + 起点/终点/占位边落图。
 * seedPhase 豁免生效时 findings 不带健康分提示（种子图健康分不设阈值）。
 * compass = 罗盘常驻随 apply 就位（#143）：scaffold 新建待初画 / reseed 批注区保留。 */
export interface GraphApplySeedResult {
  course: string
  mode: 'new' | 'reseed'
  goal_type: 'capability' | 'coverage'
  endpoint: string
  starts: string[]
  declared: string
  worksheet_items?: number
  regions: string[]
  snapshot: number
  created_blocks: string[]
  compass: { state: 'scaffold' | 'reseeded'; annotations_preserved: boolean }
  prior_feed: { unresponded: number }
  findings: string[]
}

export interface GraphBrowseBlock { name: string; nodes: GraphBrowseNode[] }

export interface GraphBrowseDoc {
  course: string
  total: number
  regions: GraphBrowseRegion[]
  /** Broken 状态显式暴露，不伪装成 unseen/draft。 */
  broken_notes: Array<{ path: string; node?: string; reason: string }>
}

/** 区/块浏览（graphBrowse）：按区名/块名过滤的节点清单。 */
export interface GraphBrowseNode {
  node: string
  depth: number
  stage: Stage
  est?: number
  difficulty?: number
  type?: string
  content_status: ContentStatus
}

export interface GraphBrowseRegion { name: string; blocks: GraphBrowseBlock[] }

/** 图分析全量视图（analysis.GraphAnalysis 的视图镜像；React Flow elements 格式）。 */
export interface GraphDoc {
  stats: {
    nodes: number
    edges: number
    enc_edges: number
    roots: number
    leaves: number
    max_depth: number
    components: number
    has_cycle: boolean
  }
  unreachable: string[]
  bottlenecks: Array<{ node: string; successors: number; unlocks: number }>
  lapse_hotspots: Array<{ node: string; lapses: number }>
  /** 图谱健康分（0-100；结束条件锚点）。est_note：est 分布压缩的 advisor 提示（null = 无）。 */
  health: { score: number; breakdown: Record<string, number>; est_note: string | null }
  /** 分批构建建议（图谱 designer 逐批展开时规划下一批的输入，全部可行动）。 */
  suggestions: {
    /** 节点数 <5 的块（浅块优先）——往哪扩。 */
    expand_blocks: Array<{ region: string; block: string; nodes: number }>
    /** 空降节点（region 序靠后且 pre 为空）——先补谁。 */
    missing_pre: string[]
    /** 平均 pre 数 <1.5 的块——哪里连接过少。 */
    unconverged: Array<{ region: string; block: string; avg_pre: number }>
    /** 认知跨步候选——每条必须 verdict：认可或修。 */
    jump_candidates: GraphJumpCandidate[]
    /** 跨步候选总数（截断前）——结束条件要求清零。 */
    jump_total: number
    /** 节点数 <3 的块（合并比展开更划算时）。 */
    merge_blocks: Array<{ region: string; block: string; nodes: number }>
  }
  nodes: Array<{ data: {
    id: string
    region: string
    block: string
    depth: number
    stage: Stage
    opt: boolean
    /** 掌握度 0-1（口径 B 派生值；底色深浅按它插值）。 */
    mastery: number
    /** 已生成可读正文（列表/图三态标识：点开有东西读）。 */
    hasContent: boolean
    /** practice = 交互实践节点（「练」角标）。 */
    type?: string
  } }>
  edges: Array<{ data: { id: string; source: string; target: string; kind: string; w?: number } }>
  schema: Record<string, GraphNodeSchema>
}

/** elementsOnly 模式（learnhub_graph_analyze elementsOnly=true）：只回渲染元素。 */
export interface GraphElementsDoc {
  nodes: GraphDoc['nodes']
  edges: GraphDoc['edges']
}

/** enc 覆盖层回填：没有需要回填的节点（候选已全落 enc，可重入）。 */
export interface GraphEncBackfillNoneResult {
  course: string
  scanned: number
  ops: 0
  proposal: null
  message: string
}

/** enc 覆盖层回填：已生成 pending enrich 提案（过审后 learnhub_graph_apply(kind=enrich) 生效）。 */
export interface GraphEncBackfillProposedResult {
  course: string
  scanned: number
  ops: number
  proposal: GraphProposeResult
  message: string
}

export type GraphEncBackfillResult = GraphEncBackfillNoneResult | GraphEncBackfillProposedResult

/** 认知跨步候选（quality.JumpCandidate 镜像）。 */
export interface GraphJumpCandidate {
  pre: string
  node: string
  /** 难度差；任一端未标注时为 null（此时只剩 depth 口径）。 */
  difficultyGap: number | null
  depthSpan: number
  reasons: Array<'difficulty' | 'depth'>
}

/** 单节点图详情（graphNode）：schema 字段值 + 直接邻域 + 前置传递闭包。 */
export interface GraphNodeDoc {
  course: string
  node: string
  region: string
  block: string
  depth: number
  opt: boolean
  pre: string[]
  succ: string[]
  enc: EncEdge[]
  /** 标称学习时长（分钟；未标注缺省）。 */
  est?: number
  type?: string
  bloom?: string
  difficulty?: number
  /** 概念字段组（schema v2；缺席缺省）。 */
  teaches?: Record<string, string>
  assumes?: Record<string, string>
  misconceptions?: Array<{ concept: string; model: string }>
  note?: string
  stage: Stage
  mastery: number
  /** 内容版本/状态（无 frontmatter content 块时缺省）。 */
  content?: { version: number; status: ContentStatus }
  /** 前置传递闭包（不含自身；按深度降序 = 先学在前）。 */
  prereq_closure: string[]
}

/** 节点 schema 全量条目（pre/enc/est/bloom/difficulty/note…；elementsOnly 模式不含）。 */
export interface GraphNodeSchema {
  pre: string[]
  enc: EncEdge[]
  opt: boolean
  est?: number
  type?: string
  bloom?: string
  difficulty?: number
  note?: string
}

/** from 在 to 的前置闭包内：链路与跨度。 */
export interface GraphPathRelatedResult {
  course: string
  from: string
  to: string
  related: true
  /** 直接前置（一步可达）。 */
  direct: boolean
  /** 闭包大小（不含 to 自身）。 */
  closure_size: number
  /** from → to 的前置链（先学在前）。 */
  chain: string[]
  depth_span: number
}

export type GraphPathResult = GraphPathUnrelatedResult | GraphPathRelatedResult

/** 前置路径查询（graphPath）：from 不在 to 的前置闭包内。 */
export interface GraphPathUnrelatedResult {
  course: string
  from: string
  to: string
  related: false
  message: string
}
