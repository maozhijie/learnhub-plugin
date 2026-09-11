/** 生成任务状态与保留期的单一契约：host 状态机与测试共用，避免字面量散落。 */

/** 生成任务状态：queued 为排队待跑（非活动、非终态）；running/cancelling 为活动态，其余为终态。 */
export type GenJobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'partial' | 'failed' | 'cancelled'

/** 生成队列 phase 全集（#131 §5 / #140 + 面板下发扩展）：
 * - 节点内容管线（course/node 键）：outline 大纲 → sections 逐节正文 → quiz 自动出题（quiz 亦为纯出题任务的入队形态）。
 * - 图域任务（course 键）：种子（建课/换终点起草，引擎 seedPropose）/ 生长（教练回合生长批，#145）/
 *   富化（覆盖层回填）/ 罗盘（罗盘初画重画）/ 反编译（目标反编译双提案）/
 *   计划（里程碑计划草案）/ 里程碑（里程碑任务卡草案）。 */
export const GEN_JOB_PHASES = ['outline', 'sections', 'quiz', '种子', '生长', '富化', '罗盘', '反编译', '计划', '里程碑'] as const
export type GenJobPhase = (typeof GEN_JOB_PHASES)[number]

/** 全局生成队列的 FIFO 选取：startedAt（入队时间）最早者先跑；无排队任务返回 null。
 * 纯函数——host 队列执行器与测试共用，保证「同时只跑一个」的选取语义单一。 */
export function nextQueuedJob<J extends { status: GenJobStatus; startedAt: string }>(jobs: J[]): J | null {
  let hit: J | null = null
  for (const j of jobs) {
    if (j.status !== 'queued') continue
    if (!hit || j.startedAt < hit.startedAt) hit = j
  }
  return hit
}

/** 排查/重试类终态（含 partial）与 failed/cancelled 一样保留 24h。 */
const DEBUG_KEEP_MS = 24 * 60 * 60_000
/** 无问题成功结果只短暂展示。 */
const SUCCESS_KEEP_MS = 30 * 60_000

/** 终态在任务注册表中的保留时长：partial 可回练习页重试出题，也按 24h 保留。 */
export function generationJobRetentionMs(status: GenJobStatus): number {
  return status === 'done' ? SUCCESS_KEEP_MS : DEBUG_KEEP_MS
}

/** 终态判定（queued 非终态、running/cancelling 活动态）：保留期清扫只作用于终态记录。 */
export function isGenJobTerminal(status: GenJobStatus): boolean {
  return status === 'done' || status === 'partial' || status === 'failed' || status === 'cancelled'
}

/** 内容锚定 phase：任务键是真实节点（内容管线三值 + 排队中尚未标注 phase 的内容任务）。
 * 图域任务（种子/生长/富化/罗盘/反编译/计划/里程碑）是课程级任务，node 槽是标签
 * （「生长批」「罗盘」…），不参与节点悬空判定。 */
export function isNodeAnchoredPhase(phase: GenJobPhase | undefined): boolean {
  return phase === undefined || phase === 'outline' || phase === 'sections' || phase === 'quiz'
}

/** 任务记录悬空判定的存在性输入（宿主用引擎的注册表与图解析结果喂入）。 */
export interface GenJobExistence {
  /** 课程已删（注册表精确匹配不到 name/id；停用不算缺失）。 */
  courseMissing: boolean
  /** 图上无此节点（已删/改名）；课程缺失时该值无意义。 */
  nodeMissing: boolean
}

/** 单条任务记录的清扫裁决（纯函数，重启恢复与写侧联动共用，ADR-0039）：
 * - 悬空（课程已删；或内容锚定任务的节点已删/改名）→ 'dangling'：唯一处置是清除、
 *   不做墓碑——已删内容的讨论、重试与进度没有任何消费方；
 * - 终态超保留期 → 'expired'：起算点 finishedAt（旧档无戳回退 startedAt），
 *   保留期跨重启仍生效；
 * - 其余（活动记录、窗口内终态）→ 'keep'。 */
export function genJobSweepVerdict(
  j: { status: GenJobStatus; startedAt: string; finishedAt?: string; phase?: GenJobPhase },
  existence: GenJobExistence,
  now: number,
): 'dangling' | 'expired' | 'keep' {
  if (existence.courseMissing) return 'dangling'
  if (existence.nodeMissing && isNodeAnchoredPhase(j.phase)) return 'dangling'
  if (isGenJobTerminal(j.status)) {
    const ageMs = now - Date.parse(j.finishedAt ?? j.startedAt)
    if (Number.isFinite(ageMs) && ageMs >= generationJobRetentionMs(j.status)) return 'expired'
  }
  return 'keep'
}

/** 终态记录的保留期剩余时长（重启恢复补挂定时器用）；已超期或时间戳不可解析返回 0。 */
export function genJobRetentionRemainingMs(
  j: { status: GenJobStatus; startedAt: string; finishedAt?: string },
  now: number,
): number {
  const ageMs = now - Date.parse(j.finishedAt ?? j.startedAt)
  return Math.max(0, generationJobRetentionMs(j.status) - (Number.isFinite(ageMs) ? ageMs : 0))
}

/** 内容管线异常 → 终态；取消旗标优先，其余正文失败不掩盖为 partial/done。
 * queued 不是可失败态：排队任务尚未开始执行。 */
export function contentFailureStatus(jobStatus: GenJobStatus): Exclude<GenJobStatus, 'running' | 'cancelling' | 'queued'> {
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
