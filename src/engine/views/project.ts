/**
 * 项目域视图类型（P 区 / ADR-0015 2×2 交叉视图；#152 刀 5 自 views.ts 归档）。
 */

// ---- 项目域（P 区 / ADR-0015）：2×2 交叉视图（P-7 #98）----
// 自包含形状：不引 projects.ts / project-exec.ts——二者带 node 侧值依赖（fs/store），
// 被 ui tsc 程序解析会整片报 TS5097/TS2307（views.ts 既有纪律：只依赖无值导入的
// 类型模块）。字面量联合与 projects.FadingTier / project-exec.ProjectExecRec 同步维护。

export type ProjectLifecycle = 'active' | 'paused' | 'delivered' | 'archived'
export type FadingTier = '骨架' | '补全' | '独立'

/** 项目执行事件（projects/<id>/exec.jsonl 逐行的视图镜像）。 */
export interface ProjectExecRec {
  ts: string
  day: string
  rating: number
  source: string
  nodes: string[]
  tier: FadingTier
  note?: string
}

/** 单个节点的练习证据回流回执（projectExecLog；#149 行使即回流——节点级单向复制进
 * 练习证据通道；粗 pre 占位边不是回流通道，行使记录只留 exec 流水）。 */
export interface ProjectExecBackflow {
  course: string
  node: string
  ema_before: number
  ema_after: number
  mastery_after: number
}

/** 一次项目执行事件的落流结果（projectExecLog；零 XP/零 canonical）。 */
export interface ProjectExecResult {
  project: string
  day: string
  rating: number
  source: string
  /** 评级映射后的 0-1 分数（回流写入节点 practice_ema 的分值）。 */
  score: number
  nodes: string[]
  /** 被行使的既有 enc 边数（两端都在事件 nodes 内；enc 面观测——回流已改节点级）。 */
  edges: number
  backflow: ProjectExecBackflow[]
  /** 行使节点笔记缺失/不可用时的跳过清单（Missing 合法空态）。 */
  skipped: Array<{ course: string; node: string; reason: string }>
}

/** 项目 2×2 交叉视图（projectCrossView；项目面板核心视图，只读）。 */
export interface ProjectCrossDoc {
  project: string
  name: string
  lifecycle: ProjectLifecycle
  tier: FadingTier
  /** X 轴：陈述性掌握（关联节点 masteryOfFm 均值；无关联节点 = null）。 */
  x: { value: number | null; caliber: string }
  /** Y 轴：项目执行证据（事件分 EMA 0.7/0.3；无事件 = null）。 */
  y: { value: number | null; caliber: string }
  quadrant: { key: string; label: string; hint: string }
  linked_nodes: Array<{ course: string; node: string; mastery: number }>
  exec: { count: number; ema: number | null; avg: number | null }
  /** 只读入档推荐（challenge point：引擎提议学习者可改，永不写状态、永不门禁）。 */
  recommendation: { current: FadingTier; recommended: FadingTier; action: 'promote' | 'demote' | 'hold'; reasons: string[] }
  /** 最近事件（尾部 20 条，新→旧）。 */
  events: ProjectExecRec[]
  thresholds: { axis: number; promote_min_events: number; promote_score: number; demote_score: number }
}
