/**
 * D 区个人实验室视图类型（#85/#110/#111/#112；#152 刀 2 自 views.ts 归档）。
 * nof1.ts / sandbox.ts 为零依赖纯函数模块，视图层直接复用其类型。
 */
export type { Nof1Template, ExperimentDef, Nof1Analysis, Nof1ArmStats } from '../nof1.ts'
export type { SandboxDoc } from '../sandbox.ts'

/** 实验提案受理结果（experimentPropose：提案-确认制第一步）。 */
export interface ExperimentProposeResult {
  proposal: number
  template: string
  title: string
  /** 合格卡池张数（已调度未归档题卡，范围过滤）。 */
  pool: number
  scope_course: string | null
}

/** 实验开跑结果（experimentApply = 提案确认）。 */
export interface ExperimentStartResult {
  id: number
  title: string
  /** 开跑当日（学习日）的生效臂。 */
  arm_today: string
}
