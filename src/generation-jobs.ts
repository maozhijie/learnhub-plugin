/** 生成任务状态与保留期的单一契约：host 状态机与测试共用，避免字面量散落。 */

/** 生成任务状态：running/cancelling 为活动态，其余为终态。 */
export type GenJobStatus = 'running' | 'cancelling' | 'done' | 'partial' | 'failed' | 'cancelled'

/** 排查/重试类终态（含 partial）与 failed/cancelled 一样保留 24h。 */
const DEBUG_KEEP_MS = 24 * 60 * 60_000
/** 无问题成功结果只短暂展示。 */
const SUCCESS_KEEP_MS = 30 * 60_000

/** 终态在任务注册表中的保留时长：partial 可回练习页重试出题，也按 24h 保留。 */
export function generationJobRetentionMs(status: GenJobStatus): number {
  return status === 'done' ? SUCCESS_KEEP_MS : DEBUG_KEEP_MS
}

/** 内容管线异常 → 终态；取消旗标优先，其余正文失败不掩盖为 partial/done。 */
export function contentFailureStatus(jobStatus: GenJobStatus): Exclude<GenJobStatus, 'running' | 'cancelling'> {
  return jobStatus === 'cancelling' ? 'cancelled' : 'failed'
}

/** 自动出题终态：成功才 done；失败是 partial，但必须保留可读错误与重试指引。 */
export interface QuizOutcome {
  status: 'done' | 'partial'
  message: string
}

/** 组装正文与自动出题都成功的终态。 */
export function quizSuccessOutcome(
  contentMsg: string,
  sectionAdded: number,
  genericAdded: number,
  bankTotal: number,
): QuizOutcome {
  const added = sectionAdded + genericAdded
  return {
    status: 'done',
    message: `${contentMsg}；出题 ${added} 道（节绑 ${sectionAdded} + 综合 ${genericAdded}，题库共 ${bankTotal}）`,
  }
}

/** 组装正文成功但自动出题失败的终态（不改写错误信息，保留练习页重试路径）。 */
export function quizFailureOutcome(contentMsg: string, error: unknown): QuizOutcome {
  return {
    status: 'partial',
    message: `${contentMsg}；自动出题失败（${error instanceof Error ? error.message : String(error)}）——可在练习页单独重试`,
  }
}
