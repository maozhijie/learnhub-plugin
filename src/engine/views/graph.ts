/**
 * graph 域视图类型（#152 刀归档；叶子文件，只引类型层）。
 */
import type { ContentStatus, EncEdge, GrowthOperator, Stage } from '../types.ts'
import type { GroupAxis } from '../graph.ts'
import type { GraphProposeResult } from './proposals.ts'

/** 富化提案受理（proposeEnrich，覆盖层通道）：files = 指纹锚定的正典文件数。 */

export interface GraphApplyEditResult {
  course: string
  ops: number
  snapshot: number
  /** rename 联动：旧名 → 新名。 */
  renames: Record<string, string>
  deleted: string[]
  /** 生长批字段（#145 note 区在场时随行）：算子标签 + 理由 + 分歧声明 + 罗盘随批写入单元重写。 */
  operator?: GrowthOperator
  coach_reason?: string
  disagreement?: boolean
  compass_rewritten?: boolean
  findings: string[]
}

/** 富化提案 apply（指纹复核通过后写正典）：files = 被重写的正典文件。 */
export interface GraphApplyEnrichResult {
  course: string
  fields: number
  snapshot: number
  files: string[]
  findings: string[]
}

export type GraphApplyResult = GraphApplyEditResult | GraphApplyEnrichResult

/** 组浏览节点载荷（graphBrowse）：轻量结构档，重叠组下同一节点随组重复。 */
export interface GraphBrowseNode {
  node: string
  depth: number
  stage: Stage
  est?: number
  difficulty?: number
  type?: string
  content_status: ContentStatus
}

/** 组浏览视图（graphBrowse，#281）：按分组轴（depth/concept/endpoint）切组的节点清单。
 * depth = 单归属分区；concept / endpoint = 派生可重叠——同一节点的多重位置以
 * 「详情随组重复」直接呈现（不引入共享 map，消费方照组渲染即可）。 */
export interface GraphBrowseDoc {
  course: string
  /** 本文档的分组轴（回显请求值；缺省 depth）。 */
  axis: GroupAxis
  total: number
  groups: Array<{ label: string; nodes: GraphBrowseNode[] }>
  /** Broken 状态显式暴露，不伪装成 unseen/draft。 */
  broken_notes: Array<{ path: string; node?: string; reason: string }>
}

/** 图分析全量视图（analysis.GraphAnalysis 的视图镜像 + 终点锚派生的终点标记；React Flow elements 格式）。 */
export interface GraphDoc {
  /** 锚定终点节点名集（读侧从锚集合派生，#199 / ADR-0055；#239 多终点化：逐个终点）。
   * 消费面据此对终点关生成入口（终点纯标记化 ADR-0056）；零终点 = 空数组。 */
  endpoints: string[]
  /** 逐终点最后台阶（ADR-0076 读侧派生；终点.pre 集）。 UI 终点列表反向展示；
   * 台阶中的交汇节点用 nodes[].data.serves 交叉判定。 */
  endpoint_steps?: Array<{ endpoint: string; last_steps: string[] }>
  stats: {
    nodes: number
    edges: number
    enc_edges: number
    roots: number
    leaves: number
    /** 环上作废为 null（#270 作废署名）：0 会伪装成「全部根级」。 */
    max_depth: number | null
    components: number
    has_cycle: boolean
  }
  /** 环上作废为 null（#270 作废署名）：[] 会伪装成「全部可达」。 */
  unreachable: string[] | null
  bottlenecks: Array<{ node: string; successors: number; unlocks: number }>
  lapse_hotspots: Array<{ node: string; lapses: number }>
  /** 图谱健康分（0-100；结束条件锚点）。est_note：est 分布压缩的 advisor 提示（null = 无）。
   * topology_void（#270 作废署名）：环上置 0 的分项名单（如 convergence）。 */
  health: { score: number; breakdown: Record<string, number>; est_note: string | null; topology_void?: string[] }
  /** 分批构建建议（图谱 designer 逐批展开时规划下一批的输入，全部可行动）。
   * concept_growth（#281，grill 定稿 2026-09-15）：失衡排序表——零机械阈值，排序
   * 暴露相对严重度，判读归教练。悬空依赖（supply 空）恒在最前；其余按行为证据
   * （stuck+skipped 降序）→ 结构失衡度（demand−supply）降序。 */
  suggestions: {
    concept_growth: Array<{
      /** canonical 概念名（读侧经 resolveConcept 归并，别名不裂组）。 */
      concept: string
      /** 教它的节点（taughtByOf，图序）。 */
      supply: string[]
      /** 需求三路现成计数：assumes 它的节点数 / 题目 invokes 计数 / 服务哪些终点。 */
      demand: { assumed: number; invoked: number; endpoints: string[] }
      /** 组内成员的 depth 分布（如 {"L0": 2, "L5": 3}）；跨深是螺旋常态，宽 ≠ 异常。 */
      depth_spread: Record<string, number>
      /** 学习者证据聚合（只聚合计数，原文永不进图分析——ADR-0032 / #248）。 */
      evidence: { skipped: number; stuck: number }
    }>
    /** 空降节点（pre 为空，剔终点）——先补谁；种子期豁免。 */
    missing_pre: string[]
    /** 认知跨步候选——每条必须 verdict：认可或修。 */
    jump_candidates: GraphJumpCandidate[]
    /** 跨步候选总数（截断前）——结束条件要求清零。 */
    jump_total: number
  }
  nodes: Array<{ data: {
    id: string
    depth: number
    stage: Stage
    opt: boolean
    /** 掌握度 0-1（口径 B 派生值；底色深浅按它插值）。 */
    mastery: number
    /** 已生成可读正文（列表/图三态标识：点开有东西读）。 */
    hasContent: boolean
    /** 终点标记（#200 / ADR-0055 读锚现算）：true = 本节点是锚定的终点——方向标记，
     * 不被学习调度不产料（ADR-0056），图上按终点样式 + 图例呈现。 */
    isEndpoint: boolean
    /** 交汇节点读数（ADR-0076 读侧派生，仅交汇节点携带）：本节点服务于哪些终点
     * （落在 ≥2 个终点的前置闭包内）；零写侧字段、不落盘。 */
    serves?: string[]
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

/** 单节点图详情（graphNode）：schema 字段面 + 直接邻域 + 前置传递闭包面。 */
export interface GraphNodeDoc {
  course: string
  node: string
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
