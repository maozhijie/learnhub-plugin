/**
 * 工具/路由共用的显式参数解析（#12）。
 *
 * 原则：可省略的可选参数（question count、apply id）只允许“缺省”与“合法值”
 * 两种形态，绝不把非法输入静默改写成另一个请求；必须显式的参数（skip 方向、
 * reject id）缺失即是参数错误。
 */

export const DEFAULT_QUESTION_COUNT = 6

export function requireSkipDirection(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('[learnhub_skip] skipped 参数必填：显式 true 表示跳过、false 表示取消跳过；省略会被拒绝。')
  }
  return value
}

/** 题目数量：缺省用既有默认；一旦给出必须是正整数。 */
export function questionCount(value: unknown, defaultValue = DEFAULT_QUESTION_COUNT): number {
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`[question-generate] count 必须是正整数（收到 ${String(value)}）；省略才使用默认 ${defaultValue}。`)
  }
  return value
}

/** apply 的提案 id：省略 = 最新 pending；给出则必须为正整数。 */
export function applyId(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`[apply] 提案 id 必须是正整数（收到 ${String(value)}）；省略 id 才表示该 kind 最新 pending。`)
  }
  return value
}

/** 图提案/应用工具的 kind：只受理 edit/seed/enrich，其余值当场拒绝（未知 kind 统一拒收）。 */
export function graphKind(value: unknown): 'edit' | 'seed' | 'enrich' {
  if (value === 'edit' || value === 'seed' || value === 'enrich') return value
  throw new Error(`[graph] 非法 kind: ${String(value)}（允许 edit/seed/enrich）`)
}

/** reject 的提案 id：拒绝无省略语义，必须显式正整数。 */
export function rejectId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`[reject] 提案 id 必须是正整数（收到 ${String(value)}）。`)
  }
  return value
}

/** E5 难度带偏好（#65）：easy/standard/hard；缺省/非法 = undefined（纯 A1，不偏移）。 */
export function bandPref(value: unknown): 'easy' | 'standard' | 'hard' | undefined {
  if (value === 'easy' || value === 'standard' || value === 'hard') return value
  return undefined
}
