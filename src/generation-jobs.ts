/** 生成任务状态与保留期的单一契约：host 状态机与测试共用，避免字面量散落。 */

/** 生成任务状态：queued 为排队待跑（非活动、非终态）；running/cancelling 为活动态，其余为终态。 */
export type GenJobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'partial' | 'failed' | 'cancelled'

/** 生成队列 phase 全集（#131 §5 / #140 + 面板下发扩展；#185 起全表英文小写）：
 * - 节点内容管线（course/node 键）：outline 大纲 → sections 逐节正文 → quiz 自动出题（quiz 亦为纯出题任务的入队形态）。
 * - 图域任务（course 键）：seed 种子（建课/换终点起草）/ growth 生长（教练回合生长批）/ compass 罗盘 /
 *   decompile 反编译（目标反编译双提案）/ plan 计划草案 / milestone 里程碑任务卡。富化不是队列 phase
 *   （#155 剔除）：覆盖层回填只产 pending 提案走人审，从未入队——登记值只会误导执行面。 */
export const GEN_JOB_PHASES = ['outline', 'sections', 'quiz', 'seed', 'growth', 'compass', 'decompile', 'plan', 'milestone'] as const
export type GenJobPhase = (typeof GEN_JOB_PHASES)[number]

/** #185 命名统一的读侧迁移别名：图域六值在 2026-09-12 前以中文持久化在
 * state/生成任务.json（ADR-0045「阶段命名缺口」），恢复读入时映射为现值。
 * 别名表只服务读侧归一——写侧（入队/执行/落盘）一律写现值，永不产生旧值。 */
export const LEGACY_GEN_JOB_PHASES: Readonly<Record<string, GenJobPhase>> = {
  种子: 'seed', 生长: 'growth', 罗盘: 'compass', 反编译: 'decompile', 计划: 'plan', 里程碑: 'milestone',
}

/** 持久化档读入的 phase 归一：现值原样、旧中文值映射为现值；未知值原样透传——
 * 沿用今天的容忍（损坏档不在这里拒载），执行器对不认识的 phase 明确报「phase 未知」。 */
export function normalizeGenJobPhase(v: string): GenJobPhase {
  if ((GEN_JOB_PHASES as readonly string[]).includes(v)) return v as GenJobPhase
  return LEGACY_GEN_JOB_PHASES[v] ?? (v as GenJobPhase)
}

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

/** 图域任务执行所必需的负载键（#157；面板下发入队时随任务写入）：phase → GenJob 上
 * 的负载字段。罗盘与生长零负载（course 键即全部入参，罗盘引擎自取课程、生长批只带
 * 可选 inject）；键缺失的任务在重启恢复处明确标失败可重试，不进执行器才炸。 */
export const GRAPH_JOB_REQUIRED_PAYLOAD: Partial<Record<GenJobPhase, 'seedPayload' | 'decompilePayload' | 'planPayload' | 'milestonePayload'>> = {
  seed: 'seedPayload',
  decompile: 'decompilePayload',
  plan: 'planPayload',
  milestone: 'milestonePayload',
}

/** 图域任务可执行性裁决（纯函数，入队侧保证、重启恢复侧校验共用同一契约）：
 * phase 要求的负载在场 → null（可执行）；要求且缺失 → 'payload_missing'
 * （恢复侧明确标失败可重试，不再拖到执行器抛「负载缺失或 phase 未知」）。 */
export function graphJobPayloadGap(
  phase: GenJobPhase | undefined,
  job: { seedPayload?: unknown; decompilePayload?: unknown; planPayload?: unknown; milestonePayload?: unknown },
): 'payload_missing' | null {
  const need = phase === undefined ? undefined : GRAPH_JOB_REQUIRED_PAYLOAD[phase]
  if (!need) return null
  return job[need] != null ? null : 'payload_missing'
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

/** 单节终局失败的结构化记录（ADR-0054）：失败横幅「定点重写失败节」与失败原因展示的
 * 消费面——sectionId 支撑单节重写（失败节在大纲里从未消失，只是面板按正文 ## 解析
 * 看不到它），finding 给人读的具体死因。corpusRef（#213）是该节死因样本在生成语料区
 * 的相对引用（`生成语料/<站>/<文件>`，回看死因用）；磁盘子格式可选字段：恢复侧对
 * 缺字段旧档案按「无失败信息」读。 */
export interface GenJobFailure {
  code: string
  sectionId?: string
  sectionTitle?: string
  finding?: string
  corpusRef?: string
}

/** 从节级错误构造结构化失败记录：code 取错误的稳定码（无码归 ERROR），finding 取
 * 质检清单第一条 ✗（人读死因；非门禁错误取整段消息）。section 信息优先取错误自带
 * （引擎 GATE_FAILED 附带），缺席回退调用方传入的当前节——逐节循环里失败节永远已知，
 * 「定点重写」按钮不因错误形态而缺席。纯函数，host 与测试共用。 */
export function sectionFailure(err: unknown, section?: { id: string; title: string }): GenJobFailure {
  const e = err as (Error & { code?: string; sectionId?: string; sectionTitle?: string }) | undefined
  const raw = err instanceof Error ? err.message : String(err)
  const finding = (raw.split('\n').find(ln => ln.trim().startsWith('✗')) ?? raw)
    .replace(/^\s*✗\s*/, '').slice(0, 300)
  const sectionId = e?.sectionId ?? section?.id
  const sectionTitle = e?.sectionTitle ?? section?.title
  return {
    code: e?.code ?? 'ERROR',
    ...(sectionId ? { sectionId } : {}),
    ...(sectionTitle ? { sectionTitle } : {}),
    finding,
  }
}

/** 节正文溢出判定（ADR-0054 修复阶梯的分岔条件）：GATE_FAILED 且质检清单含
 * 「正文过长」——压缩修复一轮仍超长时触发大纲拆节；其余 finding 不拆。 */
export function isSectionOverflow(err: unknown): boolean {
  return err instanceof Error
    && (err as Error & { code?: string }).code === 'GATE_FAILED'
    && err.message.includes('正文过长')
}

/** 大纲失败的可回灌裁决（纯函数）：可修复（护栏/形状/解析）返回回灌反馈段文本，
 * 其余（取消、课程文件缺失等基础设施错）返回 null——调用方原样上抛。OUTLINE_BUDGET
 * 回灌节数护栏反馈（既有语义），OUTLINE_SHAPE / MODEL_YAML 回灌解析死因——三类都
 * 恰一轮重产（ADR-0041 门错修复轮在宿主大纲站的形态；解析死因含稳定码人话前缀，
 * 模型据此自我修正，不回灌被拒原文：大纲从零重产的随机性足以越过偶发解析失败）。 */
export function outlineRepairFeedback(err: unknown): string | null {
  const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
  const msg = err instanceof Error ? err.message : String(err)
  if (code === 'OUTLINE_BUDGET') {
    return `## 大纲护栏反馈\n\n上一次大纲未过护栏（节数与本节点复杂度不匹配）：\n${msg}\n\n请按上下文包 §9 复杂度档案的节段数区间重新规划。`
  }
  if (code === 'OUTLINE_SHAPE' || code === 'MODEL_YAML') {
    return `## 解析反馈\n\n上一次大纲输出未通过解析/结构校验：\n${msg}\n\n请重新输出完整 YAML 文档，修正全部问题；不要输出解释。`
  }
  return null
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
