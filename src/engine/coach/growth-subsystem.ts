/**
 * Growth 子系统（#152 刀 11 / ADR-0043）：滚动教练域——罗盘、教练回合感知面、
 * 生长批受理、边实验账本与复诊。
 *
 * 同域新文件：compass.ts 与 proposals.ts 互相引用（罗盘段常量/提案产物），把子系统
 * 放进领主 compass.ts 会合拢成环；本文件只被门面引用。
 */

// ---- Growth 子系统（#152 刀 11 / ADR-0043）：滚动教练域——罗盘、教练回合感知面、
// 生长批受理、边实验账本与复诊。住同域新文件（compass.ts 与 proposals.ts 互相引用，
// 放进领主即成环）；本文件只被门面引用，跨子系统调用经窄面注入回引门面。

import type { VaultFs } from '../infra/io.ts'
import type { Store } from '../store.ts'
import type { Paths } from '../infra/paths.ts'
import type { Registry } from '../vault/registry.ts'
import type { ConceptRegistry } from '../concepts/concepts.ts'
import { withContractLast } from '../infra/prompt-assembly.ts'
import { render } from '../infra/prompt-render.ts'
import { COACH_INJECT_BLOCK, COACH_FIRST_RUNG_CRITERIA } from '../prompts/projects.ts'
import {
  EA_GOAL_CAPABILITY, EA_GOAL_COVERAGE,
  TOOL_BANK_OVERVIEW_DESC, TOOL_BEHAVIOR_DIGEST_DESC, TOOL_COMPASS_READ_DESC,
  TOOL_CONCEPT_FOOTPRINT_DESC_DRAFT, TOOL_ENDPOINT_ANCHOR_DESC_DRAFT, TOOL_GRAPH_VIEW_DESC_DRAFT,
  TOOL_NODE_CARD_DESC_DRAFT, TOOL_PARAM_NODE_DESC, TOOL_PARAM_NODE_DESC_BARE,
  TOOL_PARAM_QUERY_DESC_DRAFT, TOOL_SUBGRAPH_DESC_DRAFT, TOOL_UPSTREAM_DAG_DESC_DRAFT,
} from '../prompts/coach-tools.ts'
import {
  PACK_ANCHOR_CLOSURE, PACK_ANCHOR_DECLARED, PACK_ANCHOR_GOAL_TYPE, PACK_ANCHOR_LAST_STEPS,
  PACK_ANCHOR_LAST_STEP_JUNCTION, PACK_ANCHOR_LAST_STEPS_EMPTY, PACK_ANCHOR_NODE, PACK_ANCHOR_NOTE,
  PACK_ANCHOR_STATUS, PACK_ANCHOR_STATUS_REACHED, PACK_ANCHOR_STATUS_UNSEALED, PACK_ANCHOR_STATUS_UNWIRED,
  PACK_ANCHOR_STRUCT, PACK_ANCHOR_STRUCT_UNLEARNED, PACK_ANCHOR_WORKSHEET, PACK_ANCHOR_ZERO_BODY,
  PACK_BLOCK_ANCHOR_TITLE, PACK_BLOCK_COMPASS_TAIL_TITLE, PACK_BLOCK_DIGEST_TITLE,
  PACK_BLOCK_MISCONCEPTIONS_TITLE, PACK_BLOCK_REGISTRY_TITLE, PACK_BLOCK_V2_TITLE,
  PACK_COMPASS_EMPTY, PACK_COMPASS_HEADING, PACK_ENDPOINT_CLOSURE, PACK_ENDPOINT_LINE,
  PACK_ENDPOINT_NOTE, PACK_HEADING, PACK_JUNCTION_DISCIPLINE, PACK_LABEL_FULL, PACK_LABEL_LIGHT,
  PACK_MISCONCEPTION_LINE, PACK_MISCONCEPTIONS_EMPTY, PACK_REGISTRY_ACTIVE, PACK_REGISTRY_ASSUMES,
  PACK_REGISTRY_ASSUMES_EMPTY, PACK_REGISTRY_LINE, PACK_REGISTRY_MISSING, PACK_REGISTRY_RETIRED,
  PACK_REGISTRY_TEACHES, PACK_REGISTRY_TEACHES_EMPTY, PACK_REGISTRY_TIERS,
  PACK_SEDIMENT_HEADING, PACK_STATUS_DANGLING, PACK_STATUS_REACHED, PACK_STATUS_SEALED,
  PACK_STATUS_UNWIRED, PACK_STRUCT_COMPLETE, PACK_STRUCT_INCOMPLETE, PACK_STRUCT_SEALED,
  PACK_STRUCT_UNSEALED, PACK_TAIL_ANNOTATIONS_HEADING, PACK_TAIL_REPAINT_DUE, PACK_TAIL_ROUTE_HEADING,
  PACK_V2_BODY, PACK_ZERO_ENDPOINTS,
} from '../prompts/coach-pack.ts'
import {
  ERR_ARC_EMPTY, ERR_DRAFT_BUDGET_EXHAUSTED, ERR_DRAFT_COURSE_MISMATCH, ERR_DRAFT_UNFINISHED, ERR_EXEC_WHITELIST,
  ERR_FINISH_APPLY, ERR_FINISH_DRIFT_EXCEPTION, ERR_FINISH_EMPTY,
  ERR_FINISH_GATE, ERR_FINISH_NO_NOTE, ERR_FINISH_PROPOSE, ERR_NOTE_NO_REASON, ERR_PATCH_BUDGET,
  ERR_PATCH_EMPTY_OPS, ERR_PATCH_GATE, ERR_PATCH_MAX_OPS,
  ERR_PATCH_SHAPE, ERR_REPAINT_NOTE, ERR_REPAINT_REASON, ERR_REVERT_COUNT_INT, ERR_REVERT_COUNT_MAX,
  ERR_REVERT_NOTHING, ERR_SERVES_ARC_SHAPE,
  EXEC_CONFUSABLE_CANDIDATE, EXEC_CONFUSABLE_FAIL, EXEC_CRASH_ARC, EXEC_CRASH_AUDIT, EXEC_CRASH_FINISH, EXEC_CRASH_NOTE,
  EXEC_CRASH_PATCH, EXEC_CRASH_REVERT, EXEC_CRASH_SUMMARY, EXEC_DIFF_ADDED_EDGES, EXEC_DIFF_ADDED_EDGE_ITEM,
  EXEC_DIFF_ADDED_NODES, EXEC_DIFF_EMPTY_SET, EXEC_DIFF_NONE, EXEC_DIFF_REMOVED_NODES, EXEC_DIFF_RENAMED,
  EXEC_DIFF_RENAMED_ITEM, EXEC_DIFF_REWIRED, EXEC_DIFF_REWIRED_ITEM, EXEC_DOMAIN_CONCEPTS,
  EXEC_DOMAIN_CONCEPTS_EMPTY, EXEC_DOMAIN_NODES, EXEC_DOMAIN_NODES_MORE, EXEC_DOMAIN_OPS, EXEC_DOMAIN_TIERS,
  EXEC_ERR_ITEM, EXEC_FINDING_ITEM, EXEC_NORM_ITEM,
  EXEC_OP_FIELD_ASSUMES, EXEC_OP_FIELD_BLOOM, EXEC_OP_FIELD_DIFFICULTY, EXEC_OP_FIELD_ENC,
  EXEC_OP_FIELD_EST, EXEC_OP_FIELD_INTO, EXEC_OP_FIELD_MISCONCEPTIONS, EXEC_OP_FIELD_NAME,
  EXEC_OP_FIELD_NEW, EXEC_OP_FIELD_NODE, EXEC_OP_FIELD_NOTE, EXEC_OP_FIELD_OP, EXEC_OP_FIELD_OPERATOR,
  EXEC_OP_FIELD_PRE, EXEC_OP_FIELD_RECHECK, EXEC_OP_FIELD_TEACHES, EXEC_OP_FIELD_WITH,
  EXEC_PARAM_CHAIN_DESC, EXEC_PARAM_CONCEPTS_DESC, EXEC_PARAM_DAYS_DESC, EXEC_PARAM_HALT_REASON_DESC,
  EXEC_PARAM_METRIC_DESC, EXEC_PARAM_NOTE_REASON_DESC,
  EXEC_PARAM_NOTE_TARGET_ENDPOINTS_DESC, EXEC_PARAM_OPS_DESC,
  EXEC_PARAM_REPAINT_DESC, EXEC_PARAM_REPAINT_NOTE_DESC, EXEC_PARAM_SERVES_ARC_DESC,
  EXEC_ROUND_ARC, EXEC_ROUND_ARC_REPAINT, EXEC_ROUND_ARC_SERVES,
  EXEC_ROUND_AUDIT_EMPTY, EXEC_ROUND_AUDIT_ERRORS, EXEC_ROUND_AUDIT_FINDINGS, EXEC_ROUND_AUDIT_OK,
  EXEC_ROUND_FINISH_APPLY_FAIL, EXEC_ROUND_FINISH_CONFUSABLE, EXEC_ROUND_FINISH_OK,
  EXEC_ROUND_FINISH_PROPOSE_REJECT, EXEC_ROUND_FINISH_REJECT, EXEC_ROUND_FINISH_SEALED, EXEC_ROUND_NOTE,
  EXEC_ROUND_PATCH_BUDGET, EXEC_ROUND_PATCH_OK, EXEC_ROUND_PATCH_OK_NORM,
  EXEC_ROUND_PATCH_REJECTED, EXEC_ROUND_PATCH_SHAPE, EXEC_ROUND_REVERT, EXEC_STATUS_COUNTS,
  EXEC_STATUS_HEADING, EXEC_STATUS_NEW, EXEC_STATUS_NOTE, EXEC_STATUS_RESUMED,
  EXEC_STATUS_ROUND_ERRORS, EXEC_STATUS_ROUND_LINE, EXEC_STATUS_ROUNDS_HEADING,
  EXEC_TOOL_DRAFT_ARC_DESC, EXEC_TOOL_DRAFT_AUDIT_DESC, EXEC_TOOL_DRAFT_FINISH_DESC, EXEC_TOOL_DRAFT_NOTE_DESC,
  EXEC_TOOL_DRAFT_PATCH_DESC, EXEC_TOOL_DRAFT_REVERT_COUNT_DESC, EXEC_TOOL_DRAFT_REVERT_DESC,
  RECEIPT_ARC, RECEIPT_AUDIT_EMPTY, RECEIPT_AUDIT_FAIL, RECEIPT_AUDIT_FINDINGS, RECEIPT_AUDIT_FINDINGS_NONE,
  RECEIPT_AUDIT_NEXT_NONE, RECEIPT_AUDIT_NEXT_READY, RECEIPT_AUDIT_OK, RECEIPT_FINISH,
  RECEIPT_FINISH_SEALED, RECEIPT_NOTE, RECEIPT_PATCH, RECEIPT_PATCH_NORM, RECEIPT_REVERT,
  RECEIPT_REVERT_NEXT_CLEAR,
  RECEIPT_REVERT_NEXT_RESUME, RECEIPT_REVERT_RESIDUAL, RECEIPT_REVERT_RESIDUAL_OK,
  RECEIPT_REVERT_WATERMARK, REJECT_FINISH_APPLY,
} from '../prompts/coach-exec.ts'
import type { Content } from '../content/content.ts'
import type { BankDoc } from '../content/question-bank.ts'
import { Graph, GraphStore } from '../graph/graph.ts'
import type { BrokenNote } from '../vault/notes.ts'
import type { Fm, CourseEntry, GNode, ProposalRec, StuckReportFolded, StuckReportRec } from '../types.ts'
import type { FSRS } from 'ts-fsrs'
import type { CoachCheck } from './coach-round.ts'
import type { CompassEta, CompassEtaRow, RouteWeeklyReview } from './compass.ts'
import type { GraphApplyResult } from '../views/graph.ts'
import type { GraphProposeResult } from '../views/proposals.ts'
import type { SedimentFold } from '../sched/sediment.ts'
import type { SandboxCard, SandboxCurvePoint, SandboxNode, SandboxPlan } from '../sched/sandbox.ts'
import type { ProbationCourseView, ProbationEntry, ProbationFold, ProbationOutcome, RecheckMetric, GrowthBatchTally } from './probation.ts'

/** Growth 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */
export interface GrowthDeps {
  /** 时钟端口（#175 阶段①）：复诊结算 decidedAt 戳。 */
  clock: Clock
  /** vault 存储端口（#175 阶段②）。 */
  fs: VaultFs
  /** 调试日志端口（#253 / ADR-0080）：教练回合的事件由本子系统发——进出/结果走
   * `coach.round.enter｜round.result`、草稿回路 `coach.draft.*`，**门拒绝统一走
   * `coach.gate.reject`**（#313 B6：#146 当年的初版登记点名的 `coach.repair.trigger`／
   * `coach.segment.*`／`coach.round.apply_fail` 全仓零发出点，按文档 grep 会得到「没跑过重裁」
   * 的假否定——现在单站回路的每一处门拒绝都从这一条落地，station/gate 两字段区分「哪一站、
   * 哪个门」）。 */
  logger: Logger
  store: Store
  paths: Paths
  registry: Registry
  concepts: ConceptRegistry
  content: Content
  /** 罗盘 ETA 折叠记忆（同一学习日同锚复用）。 */
  enabledCourses(): Promise<CourseEntry[]>
  graphApply(kind: 'edit' | 'enrich', pid?: number): Promise<GraphApplyResult>
  graphPropose(kind: 'edit' | 'enrich', yamlText: string): Promise<GraphProposeResult>
  graphReject(pid: number, note?: string): Promise<ProposalRec>
  /** 混淆对候选提案（#272 窄面注入）：草稿 finish 发布成功后展开 suggest_confusable 用
   * ——只暴露这一个入口，不引入第二套候选语义（同样人审一次一条，不自动入册）。 */
  proposeConfusableCandidate(courseKey: string, pair: { a: string; b: string; evidence: string[] }): Promise<{ id: number; a: string; b: string; weight: number }>
  learningDay(): Promise<{ today: string; cutoff: number }>
  /** 审计门的受理面（#313 B5）：按课程名返回审计 ERROR 行（只算不落盘）。草稿试算与
   * propose 共用同一判据——「审计通过」与「apply 被拒」不再能在同一帧共存。 */
  auditGateErrors(course: string): Promise<string[]>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  mcAggregate(plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string, scheds: Map<string, FSRS>, fallbackCourse: string): { curve: SandboxCurvePoint[]; map: Array<{ node: string; p50: number; p80: number }> }
  sandboxPopulation(courses: CourseEntry[], nodeFilter: Set<string> | null): Promise<{ cards: SandboxCard[]; nodes: SandboxNode[]; scheds: Map<string, FSRS> }>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  sedimentFold(): Promise<SedimentFold>
  sedimentRebuildProfile(): Promise<string>
}
import { effectiveStage } from '../graph/audit.ts'
import type { CoachTrigger } from './coach-round.ts'
import { behaviorDigest, readyDepthCheck, renderBehaviorDigest, renderSedimentForCoach } from './coach-round.ts'
import { coachToolExecutor, coachToolset, renderGrowthGraphView } from './coach-tools.ts'
import type { CoachToolDeps } from './coach-tools.ts'
import type { CompassEtaProbe } from './compass.ts'
import { COMPASS_ETA_PROBE_WEEKS, COMPASS_STATION, ETA_PENDING, ROUTE_PENDING, SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, compassPaintContext, compassScaffold, etaMarkerOf, hasLearnerAnnotations, hasPaintedRoute, parseCompass, parseRouteSections, renderEtaBody, repaintDueOf, routeBodyWarns, routeWeeklyReview, sectionBody, stageAnchorsOf, stripWrappingFence, validateRouteBody, withSectionText } from './compass.ts'
import { activeEntries, deprecatedNames, resolveConcept } from '../concepts/concepts.ts'
import type { ConceptEntry } from '../concepts/concepts.ts'
import { dayOfTs, nowIsoOf, weekStartOf } from '../infra/dates.ts'
import { foldStuckReports, stuckReportGate } from './stuck-report.ts'
import type { Clock } from '../infra/clock.ts'
import type { Logger } from '../infra/logger.ts'
import { netPracticeRecs } from '../infra/grading.ts'
import { atomicWrite } from '../infra/io.ts'
import type { JolPrediction } from '../sched/jol.ts'
import { JOL_PREDICTIONS } from '../sched/jol.ts'
import type { AgentSeam, GateVerdict } from '../infra/agent.ts'
import type { LlmToolCall, LlmToolSpec } from '../infra/llm.ts'
import { hasReadyContent } from '../vault/notes.ts'
import { appendProbationEntry, foldProbation, growthGate, growthRates, learningDaysOf, readProbationLedger, recheckDue, recheckVerdict, RECHECK_METRICS } from './probation.ts'
import type { RecheckPrereg } from './probation.ts'
import { addNodeCountOf, applyOpsToNodes, conceptEntryDetailOf, editGateErrors, editProposalGateErrors, EDIT_OPS, growthOperatorsOf, operatorFoldOf, replayDraft, sealedDecisionOf, validateEditProposal } from './proposals.ts'
import type { DraftDiff, EditGateCtx, EditOp, EditProposalSpec, GrowthNote } from './proposals.ts'
import {
  GROWTH_DRAFT_MARKER, deleteDraft, draftDirOf, draftFindings, draftPathOf, expandPatchOps, findActiveDraft, saveDraft,
  GROWTH_DRAFT_STATION, PATCH_SHAPE_CHEATSHEET, normalizePatchShape,
} from './growth-draft.ts'
import type { EditProposalNoteLite, GrowthDraftDoc, GrowthDraftRound } from './growth-draft.ts'
import { GROWTH_DRAFT_MAX_OPS_PER_BATCH, GROWTH_DRAFT_MAX_ROUNDS, RECHECK_DAYS_DEFAULT, RECHECK_DAYS_MAX, RECHECK_DAYS_MIN } from '../infra/params.ts'
import { SANDBOX_DEFAULT_WEEKS, SANDBOX_WORDING } from '../sched/sandbox.ts'
import { appendSedimentEvent } from '../sched/sediment.ts'
import { runWriteUnit } from '../infra/write-unit.ts'
import { COMPLETION_MASTERY_THRESHOLD, endpointNames, foldCompletion, junctionServes, readAnchors, structureReadingsOf } from './seed.ts'
import { doneSet, learningSet, readySet } from '../sched/sessions.ts'
import { masteryOfFm } from '../sched/srs.ts'
import type { ConceptTier } from '../types.ts'
import { CONCEPT_TIERS, GROWTH_OPERATORS } from '../types.ts'
import type { GraphApplyEditResult } from '../views/graph.ts'
import type { GraphEditProposalResult } from '../views/proposals.ts'
import { readDailyGoal } from '../sched/xp.ts'
import { YAML } from '../infra/yaml.ts'

/** 结构性重画建议的合法事由枚举（结构性事由；读数信号不构成重画理由）：draft_note /
 * draft_patch 的 repaint_suggest.reason_class 取值域单源（门与工具面同表）。 */
const REPAINT_REASONS = ['前沿枯竭', '弧段走完', '终点变更']
/** 三件写工具 → 轮志 kind 的单源映射（#302 ②：写件崩溃补轮志的归属判据，与各工具自己
 * 记账时用的 kind 同表——两处各写一份必然有一天漂移成「崩溃记为另一类轮」）。 */
const DRAFT_TOOL_ROUND_KIND: Record<string, GrowthDraftRound['kind']> = {
  draft_patch: 'patch', draft_audit: 'audit', draft_finish: 'finish', draft_note: 'note', draft_revert: 'revert', draft_arc: 'arc',
}

/** 写件崩溃轮的措辞前缀（轮志 summary = `<前缀>（<错误首行>）`；`finish` 与既有
 * 「finish 被拒」同款留空格，其余按中文连写）。 */
const DRAFT_ROUND_CRASH_LABEL: Record<GrowthDraftRound['kind'], string> = {
  patch: render(EXEC_CRASH_PATCH, {}), audit: render(EXEC_CRASH_AUDIT, {}), finish: render(EXEC_CRASH_FINISH, {}),
  note: render(EXEC_CRASH_NOTE, {}), revert: render(EXEC_CRASH_REVERT, {}), arc: render(EXEC_CRASH_ARC, {}),
}

/** 崩溃轮 summary 里的错误首行上界（引擎侧的摘要口径；宿主侧的 `LOG_SUMMARY_HEAD` 是
 * 另一个面——引擎不 import 宿主，两个数字各自为政不共享）。 */
const DRAFT_ROUND_HEAD_LIMIT = 200

/** 给错误打上站标签（#301 缺陷③）：宿主失败补标按**真实失败站**落盘——此前生长任务失败
 * 一律补标到一个固定站（旧 `STATIONS.growth`），于是真实失败站的错误被标到别站最近一条
 * 捕获上（常是一次成功件：被改成 `failed` + `bad-` 前缀），死因还把排查者指向错的语料
 * 目录。站名 = 语料受控词表成员（引擎常量与 host STATIONS 同源）。 */
function tagErrorWithStation(err: unknown, station: string): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  ;(e as Error & { station?: string }).station = station
  return e
}

/** 读错误携带的站标签（跨层契约的**唯一读侧**：宿主经门面消费，别自己 cast 字段——
 * 键名一旦改动，这一处与打标签处同源可比，不会静默失联）。undefined = 无标签。 */
export function stationOfError(err: unknown): string | undefined {
  const station = (err as { station?: unknown } | null)?.station
  return typeof station === 'string' && station.trim() ? station : undefined
}

/** 一段站点工作的异常兜底：该段内任何抛出都带上本段站点标签（宿主据此补标）。 */
async function stationTagged<T>(station: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw tagErrorWithStation(err, station)
  }
}

export class GrowthSubsystem {
  constructor(private e: GrowthDeps) {}

  /** 连续 serves_arc 指认不出的升级告警阈值（软门：不拒收、不门拒，只发告警事件）。 */
  static ARC_ALIGN_STREAK_WARN = 3
  /** 连续 serves_arc 指认不出计数（进程内存）：命中即清零；锚点空位/未携带不计不清
   * ——重启丢失只是告警晚几批出现（软门不为它加重持久化面）。 */
  private arcMissStreak = new Map<string, number>()

// ---- 门面原分节：compass ----
// ---- 门面原分节：coach ----
// ---- 门面原分节：growth ----
// ---- 门面原分节：recheck ----


  /** 读罗盘（learnhub_compass / 教练上下文消费）：文件 Missing = null（合法空态——
   * 未落盘）；终点锚集合随行携带（coach 的目标视野，逐终点一条），锚 Broken fail loud
   * （锚损坏必须显式浮出，不静默折成零终点）。 */
  async compassRead(courseKey?: string): Promise<{
    course: string
    path: string
    /** 锚定的终点（逐终点一行；零终点 = 空数组，合法空态）。 */
    anchors: Array<{ endpoint: string; goal_type: 'capability' | 'coverage' }>
    missing: boolean
    route: string | null
    annotations: string | null
    eta: string | null
    eta_week: string | null
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const path = this.e.paths.compassPath(c.root)
    const anchors = (await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs))
      .map(a => ({ endpoint: a.endpoint, goal_type: a.goal_type }))
    if (!this.e.fs.exists(path)) {
      return {
        course: c.name, path,
        anchors,
        missing: true, route: null, annotations: null, eta: null, eta_week: null,
      }
    }
    const doc = parseCompass(await this.e.fs.readFile(path))
    const eta = sectionBody(doc, SECTION_ETA)
    return {
      course: c.name, path,
      anchors,
      missing: false,
      route: sectionBody(doc, SECTION_ROUTE),
      annotations: sectionBody(doc, SECTION_ANNOTATIONS),
      eta,
      eta_week: etaMarkerOf(eta),
    }
  }


  /** 就绪前沿为空（#303 口径：排除终点锚后未开始节点数为零；「仅终点」是其特例）。
   * #310 起两用——注入首级判据块与首裁档位判定——收成单点，防两处判据各自漂移。 */
  private frontierEmptyOf(frontier: readonly string[], endpoints: ReadonlySet<string>): boolean {
    return frontier.every(n => endpoints.has(n))
  }

  /** 罗盘尾段（#144 教练回合上下文包「罗盘+沉淀折叠」区块的罗盘半区消费缝；本票只
   * 就位读侧）：剩余路线 + 批注区（软输入、提议非指令标注）+ 重画待办提示（#316：
   * 教练对弧只有建议权——把「弧该重估了」的信号措辞留在建议位）。Missing = ''。 */
  async compassTail(courseKey: string): Promise<string> {
    const v = await this.compassRead(courseKey)
    if (v.missing) return ''
    const lines: string[] = []
    if (v.route?.trim() && v.route.trim() !== ROUTE_PENDING) {
      const due = repaintDueOf(v.route)
      lines.push(render(PACK_TAIL_ROUTE_HEADING, {}), '',
        ...(due ? [render(PACK_TAIL_REPAINT_DUE, { due })] : []),
        v.route.trim())
    }
    if (hasLearnerAnnotations(v.annotations)) {
      lines.push(render(PACK_TAIL_ANNOTATIONS_HEADING, {}), '', v.annotations!.trim())
    }
    return lines.join('\n\n')
  }


  /** 软对齐对表（#319）：回路声明的 serves_arc（#320 起走 draft_arc）与当前弧的阶段标题锚点对表——命中即过
   * （info 留痕 + 连击清零）；找不到**不拒收**，warn 留痕（宁多勿缺），连续
   * ARC_ALIGN_STREAK_WARN 批指认不出升级告警事件（`coach.arc.align_streak`）。
   * 锚点空位（弧未画/无标题）= 软对齐退化为纯软注入：缺席不推定，不计连击。
   * 重画建议（repaint_suggest）全量留痕后原样带出，由宿主去抖入队罗盘站。 */
  private async arcSoftAlign(
    courseKey: string, courseName: string,
    decl: { serves_arc?: string; repaint_suggest?: { reason_class: string; note?: string } },
  ): Promise<{ reason_class: string; note?: string } | undefined> {
    const log = this.e.logger
    let repaint_suggest: { reason_class: string; note?: string } | undefined
    if (decl.repaint_suggest) {
      repaint_suggest = {
        reason_class: decl.repaint_suggest.reason_class,
        ...(decl.repaint_suggest.note?.trim() ? { note: decl.repaint_suggest.note!.trim() } : {}),
      }
      log.info('coach.repaint.suggest', {
        course: courseName, reason_class: repaint_suggest.reason_class,
        ...(repaint_suggest.note ? { note: repaint_suggest.note } : {}),
      })
    }
    if (decl.serves_arc === undefined) return repaint_suggest
    let anchors: ReturnType<typeof stageAnchorsOf>
    try {
      anchors = stageAnchorsOf((await this.compassRead(courseKey)).route)
    } catch (err) {
      log.warn('coach.arc.align_degenerate', { course: courseName, reason: 'read-failed', serves_arc: decl.serves_arc, error: err instanceof Error ? err.message : String(err) })
      return repaint_suggest
    }
    if (anchors.empty) {
      log.info('coach.arc.align_degenerate', { course: courseName, reason: anchors.reason, serves_arc: decl.serves_arc })
      return repaint_suggest
    }
    const serves = decl.serves_arc.trim()
    if (anchors.stages.some(s => s.stage === serves)) {
      this.arcMissStreak.delete(courseName)
      log.info('coach.arc.align', { course: courseName, serves_arc: serves })
      return repaint_suggest
    }
    const streak = (this.arcMissStreak.get(courseName) ?? 0) + 1
    this.arcMissStreak.set(courseName, streak)
    log.warn('coach.arc.align_miss', { course: courseName, serves_arc: serves, streak, streak_warn_at: GrowthSubsystem.ARC_ALIGN_STREAK_WARN })
    if (streak >= GrowthSubsystem.ARC_ALIGN_STREAK_WARN) {
      log.warn('coach.arc.align_streak', {
        course: courseName, streak,
        note: `连续 ${streak} 批 serves_arc 指认不出当前弧的阶段标题——软对齐可能失效（弧已重画而教练未跟进，或教练在编造标题），人审兜底。`,
      })
    }
    return repaint_suggest
  }


  /** 罗盘初画/重画（learnhub_compass_paint；「罗盘初画/罗盘重画」两族，deep 档工具回路）：
   * 终点锚缺失 fail loud（初画锚在终点上）；族按「路线段是否已画」折（未画 = 初画族、
   * 已画 = 重画族——重估语境，ADR-0099 罗盘站两族）。路线门（非空/无标题/限长）首过即
   * 落盘——只重写「剩余路线」段，批注区字节保留，ETA 重置待刷新，重画待办标记随新正文
   * 自然清除；WARN 级倾向性提示（routeBodyWarns）落日志不拒收（人审兜底）。
   * 金样本回放闸：回路会话数恒 1、无修复轮。调用经统一 agent 缝；#163 起经只读工具
   * 回路。isCancelled：队列任务的取消旗标沿缝传入回路。 */
  async compassPaint(courseKey: string | undefined, agent: AgentSeam, opts: { isCancelled?: () => boolean } = {}): Promise<{
    course: string; path: string; route_lines: number; annotations_preserved: boolean; repainted: boolean; trajectory: string[]
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const root = c.root
    const anchors = await readAnchors(this.e.paths.anchorPath(root), this.e.fs)
    if (!anchors.length) {
      throw new Error(`[compass] 课程「${c.name}」零终点（空锚是合法空态）——罗盘初画锚在终点上，先加一个终点。`)
    }
    const { graph } = await this.e.loadView(c)
    const path = this.e.paths.compassPath(root)
    const existing = this.e.fs.exists(path) ? await this.e.fs.readFile(path) : null
    const doc = existing ? parseCompass(existing) : null
    const priorBody = doc ? sectionBody(doc, SECTION_ROUTE) : null
    const repainted = hasPaintedRoute(priorBody)
    const annotations = hasLearnerAnnotations(doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null)
      ? sectionBody(doc!, SECTION_ANNOTATIONS)
      : null
    const template = await this.e.content.loadPrompt(repainted ? '罗盘重画' : '罗盘初画')
    const endpoints = endpointNames(anchors)
    const prompt = withContractLast(template, compassPaintContext({
      courseName: c.name,
      anchors,
      starts: [...new Set(anchors.flatMap(a => a.seed_nodes))].filter(n => !endpoints.has(n)).map(n => ({
        name: n,
        note: graph.noteOf[n] ?? '',
      })),
      graphNames: graph.names,
      annotations,
    }))
    const toolset = this.coachToolsetFor(c)
    const loop = await agent.agentLoop({
      station: COMPASS_STATION, prompt, effort: 'deep',
      tools: toolset.tools, runTool: toolset.runTool,
      ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
    })
    const body = stripWrappingFence(loop.text)
    const errors = validateRouteBody(body)
    if (errors.length) {
      throw new Error(`[compass] 初画产物未过路线门（原样落盘会破坏罗盘结构），罗盘未改动：\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // WARN 级倾向性提示（#316：深度档/程度指向）——只落日志不拒收，人审兜底
    const warns = routeBodyWarns(body)
    if (warns.length) this.e.logger.warn('compass.route.warns', { course: c.name, warns })
    const next = withSectionText(
      withSectionText(existing ?? compassScaffold(c.name), SECTION_ROUTE, body),
      SECTION_ETA, ETA_PENDING,
    )
    await atomicWrite(path, next, this.e.fs)
    const routeLines = body.split('\n').filter(l => l.trim()).length
    await this.e.store.appendJournal({
      course: c.name, node: '*', rating: null, kind: 'compass_paint', elapsed_days: 0,
      detail: `${repainted ? '罗盘重画（重估）' : '罗盘初画'}：路线 ${routeLines} 行${annotations ? '（批注区软输入已附）' : ''}${warns.length ? `；WARN ${warns.length} 条` : ''}`,
    })
    return {
      course: c.name, path,
      route_lines: routeLines,
      annotations_preserved: Boolean(annotations),
      repainted,
      trajectory: loop.trajectory,
    }
  }


  /** 周内 ETA 备忘（进程级读侧缓存）：kataOpen 是面板常开入口，同一学习周重复打开
   * 不重复蒙特卡洛；键=课程名，周翻转即重算，force 绕过（罗盘写侧仍按标记幂等）。 */
  private etaMemo = new Map<string, { week: string; eta: CompassEta }>()

  /** 罗盘每周挂载沙盘 ETA（挂周复盘——kataOpen 触发；标记周幂等，force 可重算）：
   * 逐启用课程——零终点跳过、罗盘缺席先落脚手架、当前周已挂 current、否则探测带
   * 折叠后重写「沙盘 ETA」段（措辞锁死「模型推演，非承诺」）。透明度装置：单课失败
   * 不挡其他课，更不挡周复盘。折叠每课都算（周频成本，同周进程内走备忘）：结果随行
   * 携带 eta——周复盘现状区的 ETA 旁挂（#150）取同一份数据，不二次蒙特卡洛。
   * 顺带做**周检讨读数**（#316 §修订四；取代 ADR-0074「无锚即漂移」对账——对账方向
   * 从「地图追进度」反转为「给地图叠进度」）：覆盖缺口/深度差/配比差三类零模型读数，
   * 结果随行携带 review——周复盘现状区只以读数呈现。**非权威**：不改罗盘（写权归
   * 罗盘站）、不进门禁、不触发重画；未画路线（待初画占位）没有检讨对象，不出读数。 */
  async compassEtaRefresh(
    courseKey?: string, opts: { today?: string; force?: boolean } = {},
  ): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta; review?: RouteWeeklyReview[] }>> {
    const { today: learningToday } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const weekStart = weekStartOf(today)
    if (!weekStart) throw new Error(`[compass] today 不是合法日期：${String(today)}`)
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta; review?: RouteWeeklyReview[] }> = []
    for (const c of courses) {
      try {
        const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
        if (!anchors.length) {
          out.push({ course: c.name, state: 'skipped', detail: '零终点（空锚是合法空态——没有方向就没有「还要多久」）' })
          continue
        }
        const path = this.e.paths.compassPath(c.root)
        const existing = this.e.fs.exists(path) ? await this.e.fs.readFile(path) : compassScaffold(c.name)
        const doc = parseCompass(existing)
        // 周检讨在 ETA 早退之前算（与标记周无关——偏差什么时候都要看得见）；
        // 只按名字粗比、只读图面，图面加载失败由外层 catch 归 skipped（不挡 ETA）。
        const routeBody = sectionBody(doc, SECTION_ROUTE)
        let review: RouteWeeklyReview[] | undefined
        if (hasPaintedRoute(routeBody)) {
          const { graph } = await this.e.loadView(c)
          // 现状档：节点 teaches 概念折叠取最高档（与教练包登记表档位同款口径；无 teaches = null，不推定）
          const tierOfNode = (n: string): ConceptTier | null => {
            const tiers = Object.values(graph.teachesOf[n] ?? {})
            return tiers.length ? CONCEPT_TIERS[Math.max(...tiers.map(t => CONCEPT_TIERS.indexOf(t)))]! : null
          }
          review = parseRouteSections(routeBody!).map(s => routeWeeklyReview(s, graph.names, tierOfNode))
        }
        const memoed = this.etaMemo.get(c.name)
        const eta = !opts.force && memoed?.week === weekStart
          ? memoed.eta
          : await this.compassEtaFold(c, anchors, today, weekStart)
        this.etaMemo.set(c.name, { week: weekStart, eta })
        if (!opts.force && etaMarkerOf(sectionBody(doc, SECTION_ETA)) === weekStart) {
          out.push({ course: c.name, state: 'current', eta, ...(review ? { review } : {}) })
          continue
        }
        await atomicWrite(path, withSectionText(existing, SECTION_ETA, renderEtaBody(eta)), this.e.fs)
        out.push({ course: c.name, state: 'refreshed', eta, ...(review ? { review } : {}) })
      } catch (err) {
        // ETA 挂载跳过原因留痕（#291 / ADR-0091）：单课失败不挡其他课，WARN 指针随行
        const detail = err instanceof Error ? err.message : String(err)
        this.e.logger.warn('compass.eta.skip_fail', { course: c.name, detail })
        out.push({ course: c.name, state: 'skipped', detail })
      }
    }
    return out
  }


  /** 沙盘 ETA 折叠（罗盘 weekly；读侧即算即用，落盘的只有渲染段）：按每日 XP 目标
   * 分钟数取探测地平线逐档跑沙盘，读终点掌握度的 p50/p80 分位带；两口径首次越阈的
   * 档 = 「还要多久」的诚实参照（阈值与完成判据同一常量）。逐终点独立探测（ADR-0076
   * 罗盘多终点分节：越阈即提前停，各终点互不影响），调用方保证 ≥1 终点。 */
  private async compassEtaFold(
    c: CourseEntry, anchors: Array<{ endpoint: string }>, today: string, weekStart: string,
  ): Promise<CompassEta> {
    const minutesPerDay = await readDailyGoal(this.e.paths, this.e.fs)
    const { cards, nodes, scheds } = await this.e.sandboxPopulation([c], null)
    const rows: CompassEtaRow[] = []
    for (const anchor of anchors) {
      const endpointKey = `${c.name}/${anchor.endpoint}`
      const probes: CompassEtaProbe[] = []
      let p50Week: CompassEtaRow['p50_week'] = null
      let p80Week: CompassEtaRow['p80_week'] = null
      for (const weeks of COMPASS_ETA_PROBE_WEEKS) {
        const plan: SandboxPlan = { minutesPerDay, weeks }
        const { map } = this.e.mcAggregate(plan, cards, nodes, today, scheds, c.name)
        const hit = map.find(m => m.node === endpointKey)
        const p50 = hit?.p50 ?? 0
        const p80 = hit?.p80 ?? 0
        probes.push({ weeks, p50, p80 })
        const from = probes.length > 1 ? COMPASS_ETA_PROBE_WEEKS[probes.length - 2]! : null
        if (!p50Week && p50 >= COMPLETION_MASTERY_THRESHOLD) p50Week = { at: weeks, from }
        if (!p80Week && p80 >= COMPLETION_MASTERY_THRESHOLD) p80Week = { at: weeks, from }
        if (p50Week && p80Week) break
      }
      rows.push({ endpoint: anchor.endpoint, probes, p50_week: p50Week, p80_week: p80Week })
    }
    return {
      week_start: weekStart,
      minutes_per_day: minutesPerDay,
      threshold: COMPLETION_MASTERY_THRESHOLD,
      rows,
      wording: SANDBOX_WORDING,
    }
  }

  /** 就绪前沿：未开始（非 opt 前置全部达成）的节点——R 软闸不改变可学性，故不带门。 */
  private coachFrontier(graph: Graph, state: Record<string, Fm>): string[] {
    return readySet(graph, state, () => 1)
  }


  /** 单课程就绪深度检查（coachCheckpoint 与 statusJson 共用核）：零终点 = 不判冷启动
   * （合法空态）；锚 Broken fail loud（与 courseCompletion 同口径）。
   * 两个存量与前瞻需求都不计终点（词条「前瞻深度」：终点是锚点不是课程节点；#239
   * 多终点化：逐个终点剔除）——课程尾段前沿只剩终点时判据永不可满足会让教练永不停摆。
   * 冷启动周从**最早**的终点声明日起算。
   * 停摆判据（ADR-0076）= 未开始存量达标（除终点外没有未开始的节点）或 所有终点已达成
   * （逐终点「已铺通 + 最后台阶全掌握」，foldCompletion 同一口径）；**零节点图**（刚建
   * 的空课）同判停摆——不入任何自动触发点（第一次生长由学习者显式下发/加终点）。
   * 判据量纲 = **未开始存量**（#312 B1 / ADR-0096）：生长批只落结构（ADR-0078），正文存量
   * 归显式下发侧；而「可立刻开学」的节点数（就绪前沿）要学习者推进才变——追加在身后的
   * 台阶不涨它，挂它上就仍然是「判据与动作两个量纲」的自激（实测 35k token 零产出）。 */
  async coachCheckFor(c: CourseEntry, today: string): Promise<CoachCheck> {
    const { graph, state } = await this.e.loadView(c)
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    const endpoints = endpointNames(anchors)
    const live = this.coachFrontier(graph, state).filter(n => !endpoints.has(n))
    // 未开始 = 未进 doneSet 也未在学（stage ∉ {learning, review, mastered, skipped}）——与
    // readySet 同一把「开始」尺子，故「已开始的节点」与「就绪前沿」的补集一致。
    const started = new Set([...doneSet(graph, state), ...learningSet(graph, state)])
    const unstarted = graph.names.filter(n => !started.has(n) && !endpoints.has(n)).length
    const declared = anchors.map(a => a.declared).sort()[0] ?? null
    // 停摆判据（ADR-0076）：存量达标（就绪前沿除终点外清空）或 所有终点已达成；
    // 零节点图同判停摆（零节点闸）。零终点但有节点的课程不判停摆——没方向就要先加终点。
    const folds = anchors.length ? foldCompletion(graph, state, anchors) : []
    const allReached = anchors.length > 0 && folds.every(f => f.status === 'reached')
    return {
      course: c.name,
      ...readyDepthCheck({
        ready: live.filter(n => hasReadyContent(state[n])).length,
        unstarted,
        declared,
        today,
        exhausted: graph.names.length === 0 || allReached || (anchors.length > 0 && live.length === 0),
      }),
    }
  }

  /** 卡点自报落账（#248 / ADR-0077）：原话逐字落 practice 流水独立 kind（零结构化、
   * 零 XP、零 canonical 写入——唯一写点）。节点必须在图上（自报挂学习者正在读的
   * 节点，名字是教练归因的取值域）；频控（同节点每学习日 + 全课程日总量，params）
   * 不过即 fail loud——拒绝带原因，被拒的自报不落账也不触发回合。 */
  async stuckReportAppend(courseKey: string, node: string, text: string): Promise<StuckReportRec> {
    const c = await this.e.registry.resolve(courseKey)
    const trimmed = text.trim()
    if (!trimmed) throw new Error('[stuck-report] 自报原文为空——写点什么再提交。')
    const { graph } = await this.e.loadView(c)
    if (!graph.nset.has(node)) {
      throw new Error(`[stuck-report] 节点「${node}」不在课程「${c.name}」的图上——卡点自报挂在学习者正在读的节点。`)
    }
    const { today, cutoff } = await this.e.learningDay()
    const prior = (await this.e.store.stuckStreamAll())
      .filter((r): r is StuckReportRec => r.kind === 'stuck_report' && r.course === c.name)
      .map(r => ({ day: dayOfTs(r.ts, cutoff), node: r.node }))
    const gate = stuckReportGate(prior, node, today)
    if (!gate.ok) throw new Error(`[stuck-report] ${gate.reason}`)
    return this.e.store.appendStuckReport({ course: c.name, node, text: trimmed })
  }

  /** 待消费自报（教练回合执行起点取数，#248 在途合并缝）：消费标记折叠后滤已消费。 */
  async stuckPending(courseKey: string): Promise<StuckReportFolded[]> {
    const c = await this.e.registry.resolve(courseKey)
    return foldStuckReports(await this.e.store.stuckStreamAll())
      .filter(r => r.course === c.name && !r.consumed)
  }

  /** 落消费标记（回合成功后的冲正）：只标仍待消费的自报行 id（幂等——重复标记无害），
   * 返回实标条数。标记失败留账不拒：下一回合重复消费，无害。 */
  async stuckMarkConsumed(courseKey: string, targets: string[]): Promise<number> {
    const c = await this.e.registry.resolve(courseKey)
    const pending = new Set((await this.stuckPending(courseKey)).map(r => r.id))
    const fresh = [...new Set(targets)].filter(t => pending.has(t))
    if (!fresh.length) return 0
    await this.e.store.appendStuckConsumption({ course: c.name, targets: fresh })
    return fresh.length
  }


  /** 题目 id → invokes 概念（登记表 canonical 解析后；未标注返回 null）。行为摘要
   * （卡点集中度聚合）与复诊结算共用同一取数口径——聚合不因消费方分叉。 */
  private async invokesResolver(c: CourseEntry): Promise<(qid: string) => string | null> {
    const entries = await this.e.concepts.load()
    const map = new Map<string, string>()
    await this.e.scanCourseBanks(c, async (_node, bank) => {
      for (const q of bank.questions) {
        const inv = typeof q.invokes === 'string' ? q.invokes.trim() : ''
        if (!inv) continue
        map.set(q.id, resolveConcept(entries, inv)?.canonical ?? inv)
      }
    })
    return qid => map.get(qid) ?? null
  }


  /** 教练回合检查点（#144 触发五点：节点完成/节点跳过/会话开始/队列空闲/面板下发）。
   * 逐课程拉起就绪深度检查——纯读侧感知，零写副作用、零 LLM 调用（裁决与生长批生产
   * 归受理票 #145，入队阻尼语义归宿主）；未开始存量为空只告警，生长永不挡当前学习动作
   * （FIFO 不插队靠检查点前置：自动拉批只在检查点之后入队，不越过任何已排队任务）。 */
  async coachCheckpoint(
    trigger: CoachTrigger, courseKey?: string, opts: { today?: string } = {},
  ): Promise<{ trigger: CoachTrigger; courses: CoachCheck[] }> {
    const { today: learningToday } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: CoachCheck[] = []
    for (const c of courses) {
      try {
        out.push(await this.coachCheckFor(c, today))
      } catch (err) {
        // 检查点检查失败留痕（#291 / ADR-0091，触发五点）：照旧上抛（宿主失败面不变），
        // 日志补「哪门课、为什么」的指针
        this.e.logger.warn('coach.checkpoint.fail', {
          trigger, course: c.name,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }
    return { trigger, courses: out }
  }


  /** 教练回合上下文包（#144 六区块定序：终点锚→行为摘要→登记表档位→误解目录→
   * 罗盘尾段（罗盘+沉淀折叠）→V-2 接缝；轻量包恰两件 = 行为摘要+罗盘，不带锚/
   * 登记表/误解目录与沉淀半区）。纯组装零写副作用：行为摘要即算即用（读侧折叠，
   * 不落盘）；沉淀折叠从 sedimentFold 读侧单向取（Missing 合法空态）；V-2 接缝 =
   * vault 链接先验注入教练回合的定序占位（宿主检索面依赖 Out of Scope，接线前恒为
   * 占位行）。缺失数据一律合法空态行；终点锚 Broken fail loud。消费方 = 教练回合
   * 模板（#145），此处只保证定序稳定与可观测。 */
  async coachContextPack(
    courseKey?: string, opts: { lightweight?: boolean; today?: string; packLabel?: string } = {},
  ): Promise<string> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state } = await this.e.loadView(c)
    const { today: learningToday, cutoff } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const lightweight = opts.lightweight === true
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    const active = [...this.coachFrontier(graph, state), ...graph.names.filter(n => effectiveStage(state, n) === 'learning')]
    // 前沿为空（#303 / ADR-0092）：口径是**就绪前沿**（`coachFrontier` = 前置全达成且未开始）
    // 排除终点锚后为空——「仅终点」是它的特例，删空/学完普通节点的怪态也命中（按「节点数 ≤1」
    // 的字面判断会漏掉后者）。判据看的是**未开始的就绪存量**，不是图的历史规模。
    const endpoints = endpointNames(anchors)
    const frontierEmpty = this.frontierEmptyOf(this.coachFrontier(graph, state), endpoints)
    // 逐终点状态（ADR-0076：未接线/已铺通/已达成 + 闭包进度）与交汇读侧派生；
    // #315 B5：结构读数（sealed ∧ 闭包真已学）与逐终点状态**同一份函数**折叠——
    // 上下文包与收束判据引的都是这一行读数，不自各猜「还需不需要生长」。
    const folds = anchors.length ? foldCompletion(graph, state, anchors) : []
    const structureOf = new Map(structureReadingsOf(graph, state, anchors).map(r => [r.endpoint, r]))
    const foldOf = new Map(folds.map(f => [f.endpoint, f]))
    const serves = junctionServes(graph, anchors)

    const out: string[] = [
      render(PACK_HEADING, {
        course: c.name,
        label: opts.packLabel ?? (lightweight ? render(PACK_LABEL_LIGHT, {}) : render(PACK_LABEL_FULL, {})),
      }),
    ]
    // 终点恒标（#200 / ADR-0055 裁决 3；#239 多终点化：逐终点一行；#240 逐终点状态）：
    // 轻量段不注入终点锚区块，但每行终点名的 token 代价换裁决不盲——轻量/全量都在
    // 包头带终点行（状态三档内联）；终点标记的完整语义随图面进每段。
    const statusLabel = (f: (typeof folds)[number] | undefined): string =>
      f === undefined ? render(PACK_STATUS_DANGLING, {})
        : f.status === 'unwired' ? render(PACK_STATUS_UNWIRED, {})
        : f.status === 'reached' ? render(PACK_STATUS_REACHED, {})
        : render(PACK_STATUS_SEALED, {})
    out.push('', ...(anchors.length
      ? anchors.map(a => {
          const f = foldOf.get(a.endpoint)
          return render(PACK_ENDPOINT_LINE, {
            endpoint: a.endpoint,
            note: a.goal_note ? render(PACK_ENDPOINT_NOTE, { note: a.goal_note }) : '',
            status: statusLabel(f),
            closure: f ? render(PACK_ENDPOINT_CLOSURE, { learned: f.closure.learned, total: f.closure.total }) : '',
          })
        })
      : [render(PACK_ZERO_ENDPOINTS, {})]))
    const block = (title: string, body: string): void => {
      out.push('', `## ${title}`, '', body)
    }

    if (!lightweight) {
      // ① 终点锚集合（教练回合的方向视野——逐终点一条：状态三档 + 闭包进度 + 交汇）
      if (anchors.length) {
        const lines: string[] = []
        for (const anchor of anchors) {
          const f = foldOf.get(anchor.endpoint)
          lines.push(
            render(PACK_ANCHOR_NODE, { endpoint: anchor.endpoint }),
            render(PACK_ANCHOR_GOAL_TYPE, { type: anchor.goal_type === 'coverage' ? render(EA_GOAL_COVERAGE, {}) : render(EA_GOAL_CAPABILITY, {}) }),
            render(PACK_ANCHOR_DECLARED, { declared: anchor.declared }),
            render(PACK_ANCHOR_STATUS, {
              status: f === undefined ? render(PACK_STATUS_DANGLING, {})
                : f.status === 'reached' ? render(PACK_ANCHOR_STATUS_REACHED, {})
                : f.status === 'sealed' ? render(PACK_STATUS_SEALED, {})
                : f.criteria.last_steps.length > 0 ? render(PACK_ANCHOR_STATUS_UNSEALED, {})
                : render(PACK_ANCHOR_STATUS_UNWIRED, {}),
            }),
          )
          if (f) {
            lines.push(render(PACK_ANCHOR_CLOSURE, { learned: f.closure.learned, total: f.closure.total }))
            const st = structureOf.get(anchor.endpoint)
            if (st) {
              lines.push(render(PACK_ANCHOR_STRUCT, {
                sealed: st.sealed ? render(PACK_STRUCT_SEALED, {}) : render(PACK_STRUCT_UNSEALED, {}),
                learned: st.learned,
                total: st.total,
                unlearned: st.unlearned.length ? render(PACK_ANCHOR_STRUCT_UNLEARNED, { list: st.unlearned.join('、') }) : '',
                complete: st.complete ? render(PACK_STRUCT_COMPLETE, {}) : render(PACK_STRUCT_INCOMPLETE, {}),
              }))
            }
            const lastSteps = f.criteria.last_steps.map(s => {
              const other = serves.get(s.node)?.filter(e => e !== anchor.endpoint) ?? []
              return other.length
                ? render(PACK_ANCHOR_LAST_STEP_JUNCTION, { node: s.node, others: other.join('、') })
                : s.node
            })
            lines.push(render(PACK_ANCHOR_LAST_STEPS, { steps: lastSteps.length ? lastSteps.join('、') : render(PACK_ANCHOR_LAST_STEPS_EMPTY, {}) }))
          }
          if (anchor.goal_note) lines.push(render(PACK_ANCHOR_NOTE, { note: anchor.goal_note }))
          if (anchor.worksheet.length) {
            lines.push(render(PACK_ANCHOR_WORKSHEET, {
              done: anchor.worksheet.filter(w => w.done).length, total: anchor.worksheet.length,
            }))
          }
        }
        lines.push(render(PACK_JUNCTION_DISCIPLINE, {}))
        // 首级判据材料（#303 / ADR-0092；#310 补绑终点）：前沿为空 = 这次裁决铺的是坡道
        // 第一级——课程名与终点锚作占位符注入，判据才绑得回既有输入（ADR-0033「视角由
        // 目标携带」），否则上界约束可被域外解满足。单源住 `prompts/projects.ts`，与上行
        // 同域；单站回路与上下文包经同一出处自动共享（模板文件零改动）。
        if (frontierEmpty) {
          lines.push(render(COACH_FIRST_RUNG_CRITERIA, {
            course: c.name, endpoints: anchors.map(a => a.endpoint).join('、'),
          }))
        }
        block(render(PACK_BLOCK_ANCHOR_TITLE, {}), lines.join('\n'))
      } else {
        block(render(PACK_BLOCK_ANCHOR_TITLE, {}), render(PACK_ANCHOR_ZERO_BODY, {}))
      }
    }

    // ② 行为摘要五件套（读侧折叠即算即用；轻量包两件之一）
    block(render(PACK_BLOCK_DIGEST_TITLE, {}),
      renderBehaviorDigest(await this.behaviorDigestOf(c, graph, state, today, cutoff)))

    if (!lightweight) {
      // ③ 登记表档位（前沿视野 = 可学 ∪ 在学节点的概念档位折叠；同概念取最高档）
      // 废弃条目从生成注入面退出（#262）：在册计数只算活跃条目，前沿档位折叠剔除废弃概念
      const entries = await this.e.concepts.load()
      const retired = deprecatedNames(entries)
      const live = activeEntries(entries)
      const tierRank = (t: ConceptTier): number => CONCEPT_TIERS.indexOf(t)
      const foldTiers = (pick: (n: string) => Record<string, ConceptTier> | undefined): Array<[string, ConceptTier]> => {
        const best = new Map<string, ConceptTier>()
        for (const n of active) {
          for (const [concept, tier] of Object.entries(pick(n) ?? {})) {
            if (retired.has(concept)) continue
            const cur = best.get(concept)
            if (!cur || tierRank(tier) > tierRank(cur)) best.set(concept, tier)
          }
        }
        return [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      }
      const fmtTiers = (xs: Array<[string, ConceptTier]>): string => xs.map(([k, t]) => `${k} ${t}`).join('、')
      const teaches = foldTiers(n => graph.teachesOf[n])
      const assumes = foldTiers(n => graph.assumesOf[n])
      const retiredCount = entries.length - live.length
      block(render(PACK_BLOCK_REGISTRY_TITLE, {}), [
        entries.length
          ? render(PACK_REGISTRY_LINE, {
              count: live.length,
              retired: retiredCount ? render(PACK_REGISTRY_RETIRED, { count: retiredCount }) : '',
            })
          : render(PACK_REGISTRY_MISSING, {}),
        // 档位取值域**无条件**给（#309 缺陷③）：此前只在「前沿有档位」时经示例间接暴露，
        // 空课/空态批下模型看不到取值域、自造「初识」，直到 propose 拒绝文案里才第一次见合法值。
        render(PACK_REGISTRY_TIERS, { tiers: CONCEPT_TIERS.join(' / ') }),
        render(PACK_REGISTRY_ACTIVE, { count: active.length }),
        render(PACK_REGISTRY_TEACHES, { list: teaches.length ? fmtTiers(teaches) : render(PACK_REGISTRY_TEACHES_EMPTY, {}) }),
        render(PACK_REGISTRY_ASSUMES, { list: assumes.length ? fmtTiers(assumes) : render(PACK_REGISTRY_ASSUMES_EMPTY, {}) }),
      ].join('\n'))

      // ④ 误解目录（前沿节点的误解先验；判据签名不设机器字段，#124）
      const misLines = active.slice().sort().flatMap(n =>
        (graph.misconceptionsOf[n] ?? []).map(m => render(PACK_MISCONCEPTION_LINE, { node: n, concept: m.concept, model: m.model })))
      block(render(PACK_BLOCK_MISCONCEPTIONS_TITLE, {}), misLines.length
        ? misLines.join('\n')
        : render(PACK_MISCONCEPTIONS_EMPTY, {}))
    }

    // ⑤ 罗盘尾段（罗盘+沉淀折叠；轻量包只带罗盘半区）
    const tail = await this.compassTail(c.name)
    // 罗盘缺席/未画的占位行（#310 改口径）：此前指向 `learnhub_compass_paint` 初画——但
    // 这行是喂给**裁决站**的（思路官零工具），指示它去跑一个它没有的工具是错的；#310 起
    // 「剩余路线」随方向批（前进/换向）由计划携带写出，初画不是必经步骤。
    const parts = [render(PACK_COMPASS_HEADING, {}), '', tail || render(PACK_COMPASS_EMPTY, {})]
    if (!lightweight) {
      parts.push('', render(PACK_SEDIMENT_HEADING, {}), '', renderSedimentForCoach(await this.e.sedimentFold()))
    }
    block(render(PACK_BLOCK_COMPASS_TAIL_TITLE, {}), parts.join('\n'))

    if (!lightweight) {
      // ⑥ V-2 接缝（先验上下文注入——预留占位，Out of Scope：宿主检索面依赖）
      block(render(PACK_BLOCK_V2_TITLE, {}), render(PACK_V2_BODY, {}))
    }

    return out.join('\n') + '\n'
  }

  /** 教练只读工具面（#163 / ADR-0041 形状；#249 / ADR-0077 八件；#326 九件）：图视图/节点卡/概念足迹/
   * 上游图摘要/下游子图/题库概况/罗盘/终点锚实现走 coach-tools 的通用执行器（deps 结构化注入，本
   * 子系统天然满足）；行为摘要的取材口径（invokes 解析/掌握度折叠）是本子系统的私有折叠，
   * 经 providers 注入复用（单一出处）。工具面零写侧、零队列触点。 */
  private coachToolsetFor(c: CourseEntry): { tools: LlmToolSpec[]; runTool: (call: LlmToolCall) => Promise<string> } {
    const deps: CoachToolDeps = this.e
    return coachToolset(deps, c, {
      behaviorDigestText: async () => {
        const { today, cutoff } = await this.e.learningDay()
        const { graph, state } = await this.e.loadView(c)
        return renderBehaviorDigest(await this.behaviorDigestOf(c, graph, state, today, cutoff))
      },
      conceptInvokes: () => this.conceptInvokesOf(c),
    })
  }

  /** 概念 → 节点 → 在库题数（concept_footprint 的足迹取材，与 invokesResolver 同源扫描；
   * #281 起 graph_analyze 的 concept_growth.demand.invoked 也取这里——invokes 折叠口径
   * 单一出处不漂移）。唯一 的口径差异写在**这里**（不是散在两个文件里各写一份）：本口径只数**现役池**
   * （排除归档题——足迹问的是「这个概念还能被哪些题行使」，归档题已不在出题池）；而
   * invokesResolver 服务行为摘要的窗口聚合，归档与否由下游窗口按 practice 流水过滤，
   * 故它不在这里排除。 */
  async conceptInvokesOf(c: CourseEntry): Promise<Map<string, Map<string, number>>> {
    const entries = await this.e.concepts.load()
    const out = new Map<string, Map<string, number>>()
    await this.e.scanCourseBanks(c, async (node, bank) => {
      for (const q of bank.questions) {
        if (q.archived === true) continue
        const inv = typeof q.invokes === 'string' ? q.invokes.trim() : ''
        if (!inv) continue
        const concept = resolveConcept(entries, inv)?.canonical ?? inv
        let byNode = out.get(concept)
        if (!byNode) out.set(concept, byNode = new Map())
        byNode.set(node, (byNode.get(node) ?? 0) + 1)
      }
    })
    return out
  }

  /** 行为摘要折叠（coachContextPack 与教练工具面 behavior_digest 共用的单次取材）：
   * 登记表 canonical 解析后的 invokes 聚合 + masteryOfFm 折叠的掌握度。 */
  private async behaviorDigestOf(
    c: CourseEntry, graph: Graph, state: Record<string, Fm>, today: string, cutoff: number,
  ): Promise<ReturnType<typeof behaviorDigest>> {
    const invokesOfQ = await this.invokesResolver(c)
    const masteryOf: Record<string, number> = {}
    for (const n of graph.names) masteryOf[n] = masteryOfFm(state[n])
    return behaviorDigest({
      course: c.name,
      practice: netPracticeRecs(await this.e.store.practiceAll(), await this.e.store.erratumAll()),
      reviews: await this.e.store.reviewLogAll(),
      invokesOf: invokesOfQ,
      estOf: graph.estOf,
      misconceptionsOf: graph.misconceptionsOf,
      masteryOf,
      today,
      cutoffMin: cutoff,
    })
  }


  /** 生长批单站回路（#320 / ADR-0101；两站编排退场）：教练去集中后的**单站**——「方向裁决」
   * 与「落地」在同一站完成。① 就绪深度检查 check.ok 短路（force/inject 豁免照旧，不拉回路）；
   * ② 其余一律拉 `coachDraft` 只读工具回路：读上下文包/图面/草稿状态，经只读工具自查后，
   * 既定本回合的生长算子与朝向，又以批量补丁把结构写进草稿并按批发布（finish）；本回合不长
   * 结构则用 `draft_note` 零操作收束并给理由。停摆不再是「思路官计划的 operator」——回路零
   * 操作收束即停摆，理由随 `draft_note` 带出（halt_reason）。
   * 声明面归回路（#320）：recheck（插入批复诊预注册）随 draft_patch 批量硬化进提案 note
   * （batchSpecOf）；serves_arc / repaint_suggest（弧对齐指认与结构性重画建议）走独立写件
   * draft_arc，回路收束后由 arcSoftAlign 对表留痕并原样带出（去抖入队归宿主）——引擎消费口不变。
   * 返回形状：proposal/applied 取最后成功 finish 批的读数；halt_reason 取 draft_note 的零操作声明。 */
  async coachGrowthBatch(
    courseKey: string, agent: AgentSeam,
    opts: {
      force?: boolean; today?: string; inject?: string; trigger?: CoachTrigger; isCancelled?: () => boolean
      /** 形状容忍回调（#301 缺陷①）：本批有补丁形状被归一（「收下即归一」命中）时随行
       * 通知——宿主据此给该站**当次**捕获补标 tolerated（补标要落在命中那一轮的语料件上，
       * 批次结束后 annotateLast 只会标到最后一轮）。调用点缺省 = 不补标。 */
      onTolerated?: (code: string) => void
    } = {},
  ): Promise<{
    course: string
    state: 'idle' | 'applied'
    check: CoachCheck
    trajectory: string[]
    proposal: { id: number; ops: number; operators: string[]; reason: string; disagreement: boolean } | null
    applied: { ops: number; snapshot: number; created: string[] } | null
    /** 停摆收束的理由（#320：回路以 draft_note 零操作收束时在场；state='idle'）。 */
    halt_reason?: string
    /** 结构性重画建议（#319/#320；draft_arc 声明时原样带出，去抖与入队归宿主）。 */
    repaint_suggest?: { reason_class: string; note?: string }
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    if (!anchors.length) {
      throw new Error(`[coach-growth] 课程「${c.name}」零终点（空锚是合法空态）——教练回合要有一个方向才能裁决：先加一个终点。`)
    }
    const today = opts.today ?? (await this.e.learningDay()).today
    const check = await this.coachCheckFor(c, today)
    // 停机转译（#320）：就绪深度满足 + 非 force + 非注入 → 不拉回路直接停摆。
    if (check.ok && !opts.force && opts.inject === undefined) {
      return { course: c.name, state: 'idle', check, trajectory: [], proposal: null, applied: null }
    }
    // 回合进入（#253 / ADR-0080）：只记真正跑起来的回合——停摆短路（上一行）不算回合。
    const log = this.e.logger
    log.info('coach.round.enter', { course: c.name, today, trigger: opts.trigger ?? 'session_start' })
    // —— 单站只读工具回路（#271 草稿内核承担「方向裁决 + 落地」）——
    // 回路段任何抛出（取消传导 / 回路预算耗尽 / 形状与门拒收 / 禁止空手结束）都算本站失败——
    // 宿主失败补标据此落站（#301 缺陷③）。
    const draft = await stationTagged(GROWTH_DRAFT_STATION, () => this.coachDraft(courseKey, agent, {
      today,
      ...(opts.inject !== undefined ? { inject: opts.inject } : {}),
      ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
      ...(opts.onTolerated ? { onTolerated: opts.onTolerated } : {}),
    }))
    // —— 软对齐对表 + 重画建议留痕（回路声明走 draft_arc；建议与对齐随行带出，宿主侧去抖入队）——
    const repaint_suggest = await this.arcSoftAlign(courseKey, c.name, {
      ...(draft.serves_arc !== undefined ? { serves_arc: draft.serves_arc } : {}),
      ...(draft.repaint_suggest !== undefined ? { repaint_suggest: draft.repaint_suggest } : {}),
    })
    const lastFinish = draft.finishes.at(-1)
    log.info('coach.round.result', {
      course: c.name,
      ...(lastFinish ? { proposal: lastFinish.proposal_id, ops: lastFinish.ops } : { halt: true, reason: draft.halt_reason }),
    })
    return {
      course: c.name,
      state: lastFinish ? 'applied' : 'idle',
      check,
      trajectory: draft.trajectory,
      proposal: lastFinish ? {
        id: lastFinish.proposal_id, ops: lastFinish.ops,
        operators: lastFinish.operators, reason: lastFinish.reason,
        disagreement: false,
      } : null,
      applied: lastFinish ? {
        ops: lastFinish.ops, snapshot: lastFinish.snapshot,
        created: lastFinish.created,
      } : null,
      ...(draft.halt_reason !== undefined ? { halt_reason: draft.halt_reason } : {}),
      ...(repaint_suggest ? { repaint_suggest } : {}),
    }
  }

  // ---- 生长草稿·教练执行站（#271 / ADR-0088：草稿内核 + 批量补丁 + 按批 finish）----

  /** 单站回路的工具面（#320 / ADR-0101）：读件**九件**（#320 还回 behavior_digest /
   * bank_overview / compass_read 三件——此前桩成空串被静默砍掉；#326 增 subgraph 下游
   * 子图）+ 写件六具（draft_patch / draft_audit / draft_finish / draft_revert / draft_note /
   * draft_arc）。复用 coach-tools 渲染函数（同源不漂移）；旧 coachToolset 九件与
   * compassPaint 不动。产物以工具调用承载（OutputFormat='tool-calls'）。 */
  static draftToolSpecs(): LlmToolSpec[] {
    const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
      type: 'object', properties, required, additionalProperties: false,
    })
    const opFields = (): Record<string, unknown> => ({
      op: { type: 'string', description: render(EXEC_OP_FIELD_OP, {}) },
      into: { type: 'array', items: { type: 'string' }, description: render(EXEC_OP_FIELD_INTO, {}) },
      with: { type: 'string', description: render(EXEC_OP_FIELD_WITH, {}) },
      name: { type: 'string', description: render(EXEC_OP_FIELD_NAME, {}) },
      node: { type: 'string', description: render(EXEC_OP_FIELD_NODE, {}) },
      pre: { type: 'array', items: { type: 'string' }, description: render(EXEC_OP_FIELD_PRE, {}) },
      enc: { type: 'array', description: render(EXEC_OP_FIELD_ENC, {}) },
      new: { type: 'string', description: render(EXEC_OP_FIELD_NEW, {}) },
      note: { type: 'string', description: render(EXEC_OP_FIELD_NOTE, {}) },
      est: { type: 'number', description: render(EXEC_OP_FIELD_EST, {}) },
      bloom: { type: 'string', description: render(EXEC_OP_FIELD_BLOOM, {}) },
      difficulty: { type: 'number', description: render(EXEC_OP_FIELD_DIFFICULTY, {}) },
      teaches: { type: 'object', description: render(EXEC_OP_FIELD_TEACHES, { tiers: CONCEPT_TIERS.join(' / ') }) },
      assumes: { type: 'object', description: render(EXEC_OP_FIELD_ASSUMES, { tiers: CONCEPT_TIERS.join(' / ') }) },
      misconceptions: { type: 'array', description: render(EXEC_OP_FIELD_MISCONCEPTIONS, {}) },
      operator: { type: 'string', description: render(EXEC_OP_FIELD_OPERATOR, { ops: GROWTH_OPERATORS.join('/') }) },
      recheck: {
        type: 'object',
        description: render(EXEC_OP_FIELD_RECHECK, {}),
        properties: {
          metric: { type: 'string', description: render(EXEC_PARAM_METRIC_DESC, { metrics: RECHECK_METRICS.join(' / ') }) },
          days: { type: 'number', description: render(EXEC_PARAM_DAYS_DESC, { default: RECHECK_DAYS_DEFAULT, min: RECHECK_DAYS_MIN, max: RECHECK_DAYS_MAX }) },
        },
        required: ['metric'],
      },
    })
    return [
      { name: 'graph_view', description: render(TOOL_GRAPH_VIEW_DESC_DRAFT, {}), parameters: obj({}) },
      { name: 'node_card', description: render(TOOL_NODE_CARD_DESC_DRAFT, {}), parameters: obj({ node: { type: 'string', description: render(TOOL_PARAM_NODE_DESC, {}) } }, ['node']) },
      { name: 'concept_footprint', description: render(TOOL_CONCEPT_FOOTPRINT_DESC_DRAFT, {}), parameters: obj({ query: { type: 'string', description: render(TOOL_PARAM_QUERY_DESC_DRAFT, {}) } }) },
      { name: 'behavior_digest', description: render(TOOL_BEHAVIOR_DIGEST_DESC, {}), parameters: obj({}) },
      { name: 'bank_overview', description: render(TOOL_BANK_OVERVIEW_DESC, {}), parameters: obj({}) },
      { name: 'compass_read', description: render(TOOL_COMPASS_READ_DESC, {}), parameters: obj({}) },
      { name: 'upstream_dag', description: render(TOOL_UPSTREAM_DAG_DESC_DRAFT, {}), parameters: obj({ node: { type: 'string', description: render(TOOL_PARAM_NODE_DESC_BARE, {}) } }, ['node']) },
      { name: 'subgraph', description: render(TOOL_SUBGRAPH_DESC_DRAFT, {}), parameters: obj({ node: { type: 'string', description: render(TOOL_PARAM_NODE_DESC_BARE, {}) } }, ['node']) },
      { name: 'endpoint_anchor', description: render(TOOL_ENDPOINT_ANCHOR_DESC_DRAFT, {}), parameters: obj({}) },
      {
        name: 'draft_patch', description: render(EXEC_TOOL_DRAFT_PATCH_DESC, {}), parameters: obj({
          ops: { type: 'array', description: render(EXEC_PARAM_OPS_DESC, { cheatsheet: render(PATCH_SHAPE_CHEATSHEET, {}) }), items: { type: 'object', properties: { ...opFields(), chain: { type: 'array', description: render(EXEC_PARAM_CHAIN_DESC, {}) } } } },
          concepts: { type: 'array', description: render(EXEC_PARAM_CONCEPTS_DESC, {}) },
          note_reason: { type: 'string', description: render(EXEC_PARAM_NOTE_REASON_DESC, {}) },
          note_target_endpoints: { type: 'array', items: { type: 'string' }, description: render(EXEC_PARAM_NOTE_TARGET_ENDPOINTS_DESC, {}) },
        }, ['ops']),
      },
      {
        name: 'draft_audit', description: render(EXEC_TOOL_DRAFT_AUDIT_DESC, {}), parameters: obj({}),
      },
      {
        name: 'draft_finish', description: render(EXEC_TOOL_DRAFT_FINISH_DESC, {}), parameters: obj({}),
      },
      {
        name: 'draft_note', description: render(EXEC_TOOL_DRAFT_NOTE_DESC, {}), parameters: obj({
          halt_reason: { type: 'string', description: render(EXEC_PARAM_HALT_REASON_DESC, {}) },
        }, ['halt_reason']),
      },
      {
        name: 'draft_arc', description: render(EXEC_TOOL_DRAFT_ARC_DESC, {}), parameters: obj({
          serves_arc: { type: 'string', description: render(EXEC_PARAM_SERVES_ARC_DESC, {}) },
          repaint_suggest: {
            type: 'object',
            description: render(EXEC_PARAM_REPAINT_DESC, { reasons: REPAINT_REASONS.join(' / ') }),
            properties: {
              reason_class: { type: 'string', description: render(EXEC_PARAM_REPAINT_DESC, { reasons: REPAINT_REASONS.join(' / ') }) },
              note: { type: 'string', description: render(EXEC_PARAM_REPAINT_NOTE_DESC, {}) },
            },
            required: ['reason_class'],
          },
        }),
      },
      {
        name: 'draft_revert', description: render(EXEC_TOOL_DRAFT_REVERT_DESC, {}), parameters: obj({
          count: { type: 'number', description: render(EXEC_TOOL_DRAFT_REVERT_COUNT_DESC, {}) },
        }),
      },
    ]
  }

  /** 生长草稿·单站回路（#271 / ADR-0088；#320 / ADR-0101 两站退场后为**唯一**教练站）：
   * 输入自足（coachContextPack + 图面 + 草稿状态 + 外部注入块），一站到底——既做方向裁决
   * （算子与朝向在站内定），又以批量补丁把结构写进草稿并按批发布；不长结构则用 draft_note
   * 零操作收束。站登记 growthDraft='教练执行' + OutputFormat 'tool-calls' + 模板键「教练执行」+
   * REPAIR_MECHANISMS.draftAuditRepair（写件拒收错误原文回灌 loop 继续修、不进
   * gateRepairRound——门错修复轮保留为旧路径的最后兜底）。禁止空手结束：回路自然收束
   * 且未成功 finish 且草稿仍有未发布增量、又没声明停摆 → fail loud（草稿保留可续建）。
   * 会话在途草稿默认续建（注入轮次日志恢复认知）；预算常量单源 engine/infra/params.ts。 */
  async coachDraft(
    courseKey: string, agent: AgentSeam,
    opts: {
      today?: string; isCancelled?: () => boolean
      /** 外部注入块（待裁决的请求材料；#149/#248 同通道）：非空即随包进回路提示词。 */
      inject?: string
      /** 形状容忍回调（#301 缺陷①）：见 coachGrowthBatch 同名字段——补丁形状被归一时
       * 随当次工具调用同步通知（此刻「最近一条捕获」正是命中那一轮）。 */
      onTolerated?: (code: string) => void
    } = {},
  ): Promise<{
    course: string
    session_id: string
    resumed: boolean
    finished: boolean
    published_batches: number
    unpublished_ops: number
    trajectory: string[]
    rounds: Array<{ kind: string; summary: string }>
    /** 成功 finish 批读数：coachGrowthBatch 取最后一批折算 proposal/applied。 */
    finishes: Array<{ proposal_id: number; ops: number; snapshot: number; operators: string[]; reason: string; target_endpoints: string[]; created: string[] }>
    /** 停摆收束理由（#320：本轮以 draft_note 零操作声明时在场）。 */
    halt_reason?: string
    /** 本批服务弧的阶段标题（#320：draft_arc 声明，供软对齐对表）。 */
    serves_arc?: string
    /** 本批结构性重画建议（#320：draft_arc 声明，供宿主去抖入队罗盘站）。 */
    repaint_suggest?: { reason_class: string; note?: string }
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const root = c.root
    const today = opts.today ?? (await this.e.learningDay()).today
    // —— 草稿会话：在途续建（注入轮次日志）或新建 ——
    const existing = await findActiveDraft(this.e.fs, this.e.paths, root, file => {
      // 生长草稿档损坏留痕（#291 / ADR-0091）：坏档不炸读侧（照旧视为无在途），WARN 指针随行
      this.e.logger.warn('growth.draft.corrupt', { course: c.name, session: file.replace(/\.json$/, '') })
    })
    const resumed = existing !== null
    const doc: GrowthDraftDoc = existing ?? {
      marker: GROWTH_DRAFT_MARKER, version: 1,
      course: c.name, session_id: `draft-${nowIsoOf(this.e.clock.nowMs()).replace(/[:.]/g, '-')}`,
      ops: [], published: 0, concepts: [], rounds: [],
      created_at: nowIsoOf(this.e.clock.nowMs()), updated_at: nowIsoOf(this.e.clock.nowMs()),
    }
    if (doc.course !== c.name) {
      throw new Error(render(ERR_DRAFT_COURSE_MISMATCH, { draftCourse: doc.course, course: c.name }))
    }
    // 轮次预算（#312 B4）：耗尽不再在**入口**抛（那让每次触发先烧完思路官两轮、再当场
    // 失败——课程就此砖化，而文案指向的「显式取消」当时没有任何生产接面）。改为把预算
    // 挪进回路：本会话此后的写件只放行收束动作（发布/撤销），追加补丁被拒并说明出路。
    // 判据每次**现读**（不是入口快照）：本轮自己的轮志也在累加，进站时 15/16 的会话照样
    // 会在第 16 轮前后被拦——快照会让「本轮再多写几轮」绕过预算。
    const budgetExhausted = (): boolean => doc.rounds.length >= GROWTH_DRAFT_MAX_ROUNDS
    if (budgetExhausted()) {
      this.e.logger.warn('growth.draft.round_budget_exhausted', {
        course: c.name, session: doc.session_id, rounds: doc.rounds.length,
        unpublished: doc.ops.length - doc.published,
      })
    }
    const draftPath = draftPathOf(this.e.paths, root, doc.session_id)
    const persist = async (): Promise<void> => {
      doc.updated_at = nowIsoOf(this.e.clock.nowMs())
      await this.e.fs.mkdir(draftDirOf(this.e.paths, root))
      await saveDraft(this.e.fs, draftPath, doc)
    }
    const logRound = async (kind: GrowthDraftRound['kind'], summary: string, errors?: string[]): Promise<void> => {
      doc.rounds.push({ at: nowIsoOf(this.e.clock.nowMs()), kind, summary, ...(errors ? { errors } : {}) })
      await persist()
    }
    const finishes: Array<{ proposal_id: number; ops: number; snapshot: number; operators: string[]; reason: string; target_endpoints: string[]; created: string[] }> = []

    // —— 草稿图的现势折叠：**真实基图（已含历次 finish 落盘的已发布段）+ 未发布增量** ——
    // 水位处的「草稿图」就是真实基图：`applyEdit` 把已发布段写进了 `data/图.yaml`，再叠一次就是
    // 双重应用（#309：旧实现在此对基图**重放已发布段**，于是第一批发布成功后第二次 `draft_patch`
    // 必以「add_node 重名」炸——会话在第一批之后事实上已死，而唯一的出路只有取消会话）。
    // 增量一律只取 `ops.slice(published)`；基图漂移由 finish 的门复验对真实基图再跑一遍兜住。
    const draftNodesOf = async (): Promise<{ nodes: Awaited<ReturnType<GraphStore['load']>>; graph: Graph }> => {
      const store = new GraphStore(this.e.paths, this.e.paths.courseRoot(root), this.e.fs)
      const base = await store.load()
      return { nodes: base, graph: new Graph(base) }
    }

    /** 未发布增量（水位之后的 ops）：试算 / 审计 / 发布三处**同一段**。 */
    const unpublishedOf = (): EditOp[] => doc.ops.slice(doc.published)

    // —— 读件执行器：复用 coachToolset 的通用执行器（deps 结构化注入），白名单由本站
    //    规格表收紧为读件九件 + 写件六具（#326 起）；白名单外调用照旧 fail loud。 ——
    //    behavior_digest 的取材口径（invokes 解析/掌握度折叠）是本子系统私有折叠（#320 还回
    //    三件之一），经 providers 注入复用单一出处——此前桩成空串，读件三件被静默砍掉。
    const readExecutor = coachToolExecutor(this.e, c, {
      behaviorDigestText: async () => {
        const { cutoff } = await this.e.learningDay()
        const { graph, state } = await this.e.loadView(c)
        return renderBehaviorDigest(await this.behaviorDigestOf(c, graph, state, today, cutoff))
      },
      conceptInvokes: () => this.conceptInvokesOf(c),
    })
    const entriesOf = async (): Promise<ConceptEntry[]> => this.e.concepts.load()

    /** 结构性重画建议的形状门（#320；draft_arc 专用）：reason_class 枚举收窄为
     * 结构性事由——读数信号不构成重画战略的理由。 */
    const repaintSuggestionOf = (raw: unknown): { reason_class: string; note?: string } => {
      const rs = (raw ?? {}) as Record<string, unknown>
      if (!REPAINT_REASONS.includes(String(rs.reason_class))) {
        throw new Error(render(ERR_REPAINT_REASON, { value: String(rs.reason_class), reasons: REPAINT_REASONS.join('/') }))
      }
      if (rs.note !== undefined && (typeof rs.note !== 'string' || !rs.note.trim())) {
        throw new Error(render(ERR_REPAINT_NOTE, {}))
      }
      return {
        reason_class: String(rs.reason_class),
        ...(typeof rs.note === 'string' && rs.note.trim() ? { note: rs.note.trim() } : {}),
      }
    }
    /** 本批硬化后的**提案形态**（#309 缺陷①）：`draft_patch` 试算 / `draft_audit` /
     * `draft_finish` **三处同一份**——「草稿通过 = 门通过」要求三处喂给门的是同一个对象，
     * 不是三处各拼一份（拼装漂移正是「审计通过而 finish 被拒」那类事故的温床）。
     * `noteIn` / `conceptsIn` 供试算传「本补丁**将要**声明的 note 与铸名」——补丁的
     * note_reason 与 concepts 在试算时尚未写回 doc，拿旧值试算 = 试算的是另一批。
     * 复诊预注册与算子随 ops 条目走（#327 逐条目化），天然随 ops 一同硬化，无批级件。 */
    const batchSpecOf = (
      ops: EditOp[], over: { note?: EditProposalNoteLite; concepts?: ConceptEntry[] } = {},
    ): EditProposalSpec => {
      const noteLite = over.note === undefined ? doc.note : over.note
      const concepts = over.concepts ?? doc.concepts
      return {
        course: c.name,
        reason: noteLite?.reason ?? '',
        ops,
        ...(concepts.length ? { concepts } : {}),
        ...(noteLite
          ? {
              note: {
                reason: noteLite.reason,
                ...(noteLite.target_endpoints?.length ? { target_endpoints: noteLite.target_endpoints } : {}),
                ...(noteLite.disagreement ? { disagreement: noteLite.disagreement } : {}),
              },
            }
          : {}),
      }
    }

    /** 门序列的上下文装载（试算 / 审计 / 发布三处同源）：基图（= 水位处的草稿图）+ 登记表
     * + 现行锚 + 生长闸门；mints = 本批铸名缓存。`pre` = 调用方已装载的同一份底图（补丁试算
     * 要的是「展开糖算子时看到的那张图」，不重新读一遍）。 */
    const gateCtxOf = async (
      pre?: { nodes: Awaited<ReturnType<GraphStore['load']>>; graph: Graph },
      mints: ConceptEntry[] = doc.concepts,
    ): Promise<{ nodes: Awaited<ReturnType<GraphStore['load']>>; graph: Graph; ctx: EditGateCtx }> => {
      const { nodes, graph } = pre ?? await draftNodesOf()
      const gateEntries = await entriesOf()
      return {
        nodes, graph,
        ctx: {
          nodes, graph, entries: gateEntries,
          anchors: await readAnchors(this.e.paths.anchorPath(root), this.e.fs),
          mints,
          entryDetailOf: conceptEntryDetailOf(gateEntries, graph),
          growthGate: async s => this.growthGateErrors(s),
          auditGate: () => this.e.auditGateErrors(c.name),
        },
      }
    }

    /** 合法取值域回灌（#309 缺陷①③）：门错误拒收时随行给全取值域——档位枚举此前**不在写作面**
     * （模型自造「初识」直到 propose 拒绝文案里才第一次看到合法取值），这里无条件带上。 */
    const domainsHint = async (): Promise<string> => {
      const { graph } = await draftNodesOf()
      return [
        render(EXEC_DOMAIN_TIERS, { tiers: CONCEPT_TIERS.join(' / ') }),
        render(EXEC_DOMAIN_OPS, { ops: EDIT_OPS.join(' / ') }),
        render(EXEC_DOMAIN_NODES, {
          names: [...graph.names].slice(0, 80).join('、'),
          more: graph.names.length > 80 ? render(EXEC_DOMAIN_NODES_MORE, {}) : '',
        }),
        render(EXEC_DOMAIN_CONCEPTS, {
          list: (await entriesOf()).map(e => e.canonical).slice(0, 60).join('、') || render(EXEC_DOMAIN_CONCEPTS_EMPTY, {}),
        }),
      ].join('\n  · ')
    }

    const renderDiff = (diff: DraftDiff): string => [
      render(EXEC_DIFF_ADDED_NODES, { count: diff.added_nodes.length, list: diff.added_nodes.join('、') || render(EXEC_DIFF_NONE, {}) }),
      render(EXEC_DIFF_REMOVED_NODES, { count: diff.removed_nodes.length, list: diff.removed_nodes.join('、') || render(EXEC_DIFF_NONE, {}) }),
      render(EXEC_DIFF_RENAMED, { count: diff.renamed.length, list: diff.renamed.map(r => render(EXEC_DIFF_RENAMED_ITEM, { from: r.from, to: r.to })).join('、') || render(EXEC_DIFF_NONE, {}) }),
      render(EXEC_DIFF_ADDED_EDGES, { count: diff.added_edges.length, list: diff.added_edges.map(e => render(EXEC_DIFF_ADDED_EDGE_ITEM, { node: e.node, pre: e.pre })).join('、') || render(EXEC_DIFF_NONE, {}) }),
      render(EXEC_DIFF_REWIRED, {
        count: diff.rewired.length,
        list: diff.rewired.map(w => render(EXEC_DIFF_REWIRED_ITEM, {
          node: w.node,
          before: w.pres_before.join('、') || render(EXEC_DIFF_EMPTY_SET, {}),
          after: w.pres_after.join('、') || render(EXEC_DIFF_EMPTY_SET, {}),
        })).join('；') || render(EXEC_DIFF_NONE, {}),
      }),
    ].join('\n')

    // —— 回路的零操作声明（#320）：停摆走 draft_note（halt_reason）、弧建议走 draft_arc
    //    （serves_arc / repaint_suggest）；回路收束后随 coachDraft 返回——消费口不变。 ——
    let declaredHaltReason: string | undefined
    let declaredServesArc: string | undefined
    let declaredRepaint: { reason_class: string; note?: string } | undefined

    // —— 写件工具 ——
    const writeTool = async (call: LlmToolCall): Promise<string> => {
      const args = JSON.parse(call.arguments.trim() || '{}') as Record<string, unknown>
      if (call.name === 'draft_patch') {
        // 轮次预算耗尽后只放行收束动作（#312 B4）：追加补丁被拒，并给出真实存在的两条出路
        // （发布已备好的那批；或取消本会话草稿重开——此前这条「取消」只在文案里存在）。
        if (budgetExhausted()) {
          await logRound('patch', render(EXEC_ROUND_PATCH_BUDGET, { rounds: doc.rounds.length, max: GROWTH_DRAFT_MAX_ROUNDS }))
          throw new Error(render(ERR_PATCH_BUDGET, {
            rounds: doc.rounds.length, max: GROWTH_DRAFT_MAX_ROUNDS,
            unpublished: doc.ops.length - doc.published,
          }))
        }
        const rawOps = Array.isArray(args.ops) ? args.ops as Array<Record<string, unknown>> : []
        if (!rawOps.length) throw new Error(render(ERR_PATCH_EMPTY_OPS, {}))
        // 形状门「收下即归一」（#301 缺陷① / ADR-0088 §修订）：可修的形状当场归一为发布
        // 形态（回执注明归一动作、语料补标 tolerated），修不了的整批拒收回灌合法形态——
        // 毒形状永不随草稿过夜（此前原样入 doc.ops/doc.concepts，直到 finish 才在权威门炸）
        const shape = normalizePatchShape(rawOps, args.concepts)
        if (shape.errors.length) {
          await logRound('patch', render(EXEC_ROUND_PATCH_SHAPE, { count: shape.errors.length }), shape.errors)
          throw new Error(render(ERR_PATCH_SHAPE, {
            errors: shape.errors.map(e => render(EXEC_ERR_ITEM, { error: e })).join('\n'),
            cheatsheet: render(PATCH_SHAPE_CHEATSHEET, {}),
          }))
        }
        // 糖算子展开（#272 统一入口）：insert_prereq_chain / split_node → 原子 EditOp；
        // suggest_confusable → confusable 建议（不是图 op，finish 发布成功后展开为候选提案）
        const { nodes, graph } = await draftNodesOf()
        const { ops: expanded, confusables: suggestions } = expandPatchOps(shape.ops, nodes, graph, endpointNames(anchors))
        const unpublishedCount = doc.ops.length - doc.published + expanded.length
        if (unpublishedCount > GROWTH_DRAFT_MAX_OPS_PER_BATCH) {
          throw new Error(render(ERR_PATCH_MAX_OPS, { max: GROWTH_DRAFT_MAX_OPS_PER_BATCH, count: unpublishedCount }))
        }
        const mints = shape.concepts
        // 本补丁**将要**声明的 note 与铸名：试算必须按「补丁生效后的本批形态」跑——拿旧 note
        // 试算等于试算另一批（前进/换向条目的接线义务挂在 note.target_endpoints 上）。
        // 批级 note 只载理由/朝向（#327 逐条目化：算子与复诊预注册随 ops 条目走，
        // op.operator / op.recheck 已随条目进 expanded，schema 门逐条裁）。
        const declaredReason = typeof args.note_reason === 'string' ? args.note_reason.trim() : ''
        const declaredEndpoints = Array.isArray(args.note_target_endpoints) && args.note_target_endpoints.length
          ? (args.note_target_endpoints as unknown[]).map(String)
          : []
        const declaredNote: EditProposalNoteLite | undefined = declaredReason || declaredEndpoints.length
          ? {
            reason: declaredReason,
            ...(declaredEndpoints.length ? { target_endpoints: declaredEndpoints } : {}),
          }
          : undefined
        const nextMints = mints.length ? [...doc.concepts, ...mints] : doc.concepts
        // 试算：**未发布段 + 本补丁**过完整门（schema 纯校验 + 门序列）才落草稿——#309 缺陷①：
        // 此前试算只跑 replayDraft（门的结构子集），`move` 这类非法 op 与 `初识` 这类非法档位
        // 一路落进草稿、直到 finish 才在 propose 的 schema 门炸，而那时 op 已无法清除（缺陷②）。
        const trial = [...unpublishedOf(), ...expanded]
        const trialSpec = batchSpecOf(trial, { note: declaredNote, concepts: nextMints })
        const { ctx: trialCtx } = await gateCtxOf({ nodes, graph }, nextMints)
        const trialErrors = (await editProposalGateErrors(trialSpec, trialCtx)).errors
        if (trialErrors.length) {
          await logRound('patch', render(EXEC_ROUND_PATCH_REJECTED, { count: expanded.length }), trialErrors)
          throw new Error(render(ERR_PATCH_GATE, {
            errors: trialErrors.map(e => render(EXEC_ERR_ITEM, { error: e })).join('\n'),
            domains: await domainsHint(),
          }))
        }
        doc.ops.push(...expanded)
        if (mints.length) doc.concepts.push(...mints)
        if (suggestions.length) doc.confusables = [...(doc.confusables ?? []), ...suggestions]
        if (declaredNote !== doc.note) doc.note = declaredNote
        await logRound('patch', render(EXEC_ROUND_PATCH_OK, {
          count: expanded.length, unpublished: doc.ops.length - doc.published,
          norm: shape.normalized.length ? render(EXEC_ROUND_PATCH_OK_NORM, { count: shape.normalized.length }) : '',
        }))
        // 归一命中 → 宿主给当次捕获补标 tolerated（此刻最近一条捕获就是本轮；批次结束后
        // 再补标只会落到最后一轮——#301 缺陷③ 同款的「标对件」纪律）
        if (shape.normalized.length) opts.onTolerated?.('patch_shape_normalized')
        const normLines = shape.normalized.length
          ? render(RECEIPT_PATCH_NORM, {
            count: shape.normalized.length,
            lines: shape.normalized.map(s => render(EXEC_NORM_ITEM, { norm: s })).join('\n'),
          })
          : ''
        return render(RECEIPT_PATCH, {
          count: expanded.length, unpublished: doc.ops.length - doc.published,
          published: doc.published, total: doc.ops.length, norm: normLines,
        })
      }
      if (call.name === 'draft_note') {
        // 停摆收束（#320 / ADR-0101）：本回合不长结构的唯一合法出口——零操作 + 给理由，草稿形状
        // 不变（不产 op、不改水位）。弧建议不在本工具上（#320：提成 draft_arc 独立一具）。
        const reason = typeof args.halt_reason === 'string' ? args.halt_reason.trim() : ''
        if (!reason) throw new Error(render(ERR_NOTE_NO_REASON, {}))
        declaredHaltReason = reason
        await logRound('note', render(EXEC_ROUND_NOTE, { reason }))
        return render(RECEIPT_NOTE, { reason })
      }
      if (call.name === 'draft_arc') {
        // 弧建议（#320 / ADR-0101）：serves_arc（弧对齐指认）与 repaint_suggest（结构性重画建议）
        // 提成独立写件——零操作，只把声明交给回路收束后的 arcSoftAlign（对表留痕 + 原样带出）。
        if (args.serves_arc === undefined && args.repaint_suggest === undefined) {
          throw new Error(render(ERR_ARC_EMPTY, {}))
        }
        if (args.serves_arc !== undefined) {
          if (typeof args.serves_arc !== 'string' || !args.serves_arc.trim()) {
            throw new Error(render(ERR_SERVES_ARC_SHAPE, {}))
          }
          declaredServesArc = args.serves_arc.trim()
        }
        if (args.repaint_suggest !== undefined) declaredRepaint = repaintSuggestionOf(args.repaint_suggest)
        const summary = [
          declaredServesArc !== undefined ? render(EXEC_ROUND_ARC_SERVES, { value: declaredServesArc }) : '',
          declaredRepaint !== undefined ? render(EXEC_ROUND_ARC_REPAINT, { value: declaredRepaint.reason_class }) : '',
        ].filter(Boolean).join('；')
        await logRound('arc', render(EXEC_ROUND_ARC, { summary }))
        return render(RECEIPT_ARC, { summary })
      }
      if (call.name === 'draft_audit') {
        // 空草稿 audit（#315 B4）：零未发布增量 = 本会话无事可做，不跑门、不报门错误——
        // 此前空草稿会吃到「ops: 提案没有操作条目」的门错误，模型要烧几十轮才明白该停。
        if (!unpublishedOf().length) {
          await logRound('audit', render(EXEC_ROUND_AUDIT_EMPTY, {}))
          return render(RECEIPT_AUDIT_EMPTY, {})
        }
        // 审计 = **把 finish 要提交的那一份**喂给受理门的完整序列（#309 缺陷①：此前只跑
        // replayDraft——门的结构子集，schema 门缺席，于是「审计通过」与「finish 被拒」可以同帧
        // 共存，模型据此以为可以发布）。试算走同一个 batchSpecOf / editProposalGateErrors。
        const { nodes, graph } = await draftNodesOf()
        const { ctx } = await gateCtxOf({ nodes, graph })
        const errors = (await editProposalGateErrors(batchSpecOf(unpublishedOf()), ctx)).errors
        const diff = replayDraft(nodes, graph, unpublishedOf()).diff
        // findings（#272）：非阻、与门错误分列；门错误在场时不折草稿图（重放不完整，
        // findings 的图读数会失真——先把门错误修完再看 findings）
        let findings: string[] = []
        if (!errors.length) {
          const sim: GNode[] = JSON.parse(JSON.stringify(nodes))
          applyOpsToNodes(sim, unpublishedOf())
          findings = draftFindings({
            mints: doc.concepts, entries: await entriesOf(), graph: new Graph(sim),
            invokes: await this.conceptInvokesOf(c),
            confusables: doc.confusables ?? [], anchors,
          })
        }
        await logRound('audit', errors.length
          ? render(EXEC_ROUND_AUDIT_ERRORS, { count: errors.length })
          : findings.length ? render(EXEC_ROUND_AUDIT_FINDINGS, { count: findings.length }) : render(EXEC_ROUND_AUDIT_OK, {}))
        if (errors.length) {
          return render(RECEIPT_AUDIT_FAIL, {
            errors: errors.map(e => render(EXEC_ERR_ITEM, { error: e })).join('\n'),
            domains: await domainsHint(),
            diff: renderDiff(diff),
          })
        }
        return render(RECEIPT_AUDIT_OK, { diff: renderDiff(diff) })
          + (findings.length
            ? render(RECEIPT_AUDIT_FINDINGS, {
              count: findings.length,
              lines: findings.map(f => render(EXEC_FINDING_ITEM, { finding: f })).join('\n'),
            })
            : render(RECEIPT_AUDIT_FINDINGS_NONE, {}))
          + (doc.ops.length - doc.published
            ? render(RECEIPT_AUDIT_NEXT_READY, { count: doc.ops.length - doc.published })
            : render(RECEIPT_AUDIT_NEXT_NONE, {}))
      }
      if (call.name === 'draft_revert') {
        // 逃生口（#309 缺陷②）：草稿只能追加，被门拒的 op 永久卡在未发布段且每次 finish 重投
        // 都带着它（事故里 `ops[0..2]` 的非法档位与 `ops[11]` 的退役 op 因此不可清，模型的
        // del+add 重铸在原理上无效）——「模型永远有一步可走」的兜底就是这一具。
        const unpublished = unpublishedOf()
        if (!unpublished.length) {
          throw new Error(render(ERR_REVERT_NOTHING, {}))
        }
        const raw = args.count
        let count = unpublished.length
        if (raw !== undefined) {
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
            throw new Error(render(ERR_REVERT_COUNT_INT, { value: JSON.stringify(raw) }))
          }
          if (raw > unpublished.length) {
            throw new Error(render(ERR_REVERT_COUNT_MAX, { count: raw, total: unpublished.length }))
          }
          count = raw
        }
        const dropped = doc.ops.splice(doc.ops.length - count, count)
        // 回到水位 = 本批作废：note / 铸名缓存 / confusable 建议一并清（它们都是**批级**状态，
        // 留着会让下一批带着上一批的理由与铸名发布）。部分撤销保留它们（本批仍在建）。
        if (!unpublishedOf().length) {
          doc.note = undefined
          doc.concepts = []
          doc.confusables = []
        }
        const { nodes, graph } = await draftNodesOf()
        const residual = replayDraft(nodes, graph, unpublishedOf()).errors
        await logRound('revert', render(EXEC_ROUND_REVERT, { count: dropped.length, rest: unpublishedOf().length }))
        return render(RECEIPT_REVERT, {
          count: dropped.length,
          list: dropped.map(o => `${o.op}(${o.op === 'add_node' ? o.name : o.node})`).join('、'),
        })
          + render(RECEIPT_REVERT_WATERMARK, {
            published: doc.published, total: doc.ops.length, unpublished: unpublishedOf().length,
          })
          + (unpublishedOf().length ? render(RECEIPT_REVERT_RESIDUAL, {
            body: residual.length
              ? `\n${residual.map(e => render(EXEC_ERR_ITEM, { error: e })).join('\n')}`
              : render(RECEIPT_REVERT_RESIDUAL_OK, {}),
          }) : '')
          + (unpublishedOf().length ? render(RECEIPT_REVERT_NEXT_RESUME, {}) : render(RECEIPT_REVERT_NEXT_CLEAR, {}))
      }
      if (call.name === 'draft_finish') {
        const unpublished = unpublishedOf()
        const noteLite = doc.note
        if (!noteLite || !noteLite.reason) {
          throw new Error(render(ERR_FINISH_NO_NOTE, {}))
        }
        // 提案形态由 batchSpecOf 单点装配（含本批生效的复诊预注册，见该函数）——试算/审计/
        // 发布三处喂给门的因此是同一份对象，不会出现「试算带上计划的 recheck、发布丢了它」。
        const spec: EditProposalSpec = batchSpecOf(unpublished)
        // 零增量 finish 无意义（空手结束由入口 fail loud 执法）
        if (!unpublished.length) {
          throw new Error(render(ERR_FINISH_EMPTY, {}))
        }
        // 门复验对**真实基图**再跑一遍（水位模型：基图漂移 = 拒收零落盘、草稿保留）。走的是
        // draft_audit 同一入口（#309 缺陷①）——审计通过而此处被拒只可能源于门之间的状态变化
        // （基图/登记表/锚被外部改动、生长闸门状态变了），不再源于两侧各跑一套校验。
        let driftErrors: string[]
        try {
          const { ctx } = await gateCtxOf()
          driftErrors = (await editProposalGateErrors(spec, ctx)).errors
        } catch (err) {
          // 门复验**异常**转门错误（#301 缺陷②）：异常穿透会让 logRound('finish') 一次都
          // 不执行、finish 轮次在草稿里零痕迹、回灌给模型的只有一行裸异常（不可诊断、每次
          // 重试原样再失败）。保险丝：形状归一（缺陷①）落地后权威门恒见合法形态，本分支
          // 只该由「读侧不自愈的存量毒草稿」这类情形触发。
          const msg = err instanceof Error ? err.message : String(err)
          driftErrors = [render(ERR_FINISH_DRIFT_EXCEPTION, { msg, cheatsheet: render(PATCH_SHAPE_CHEATSHEET, {}) })]
        }
        if (driftErrors.length) {
          await logRound('finish', render(EXEC_ROUND_FINISH_REJECT, { count: driftErrors.length }), driftErrors)
          throw new Error(render(ERR_FINISH_GATE, {
            errors: driftErrors.map(e => render(EXEC_ERR_ITEM, { error: e })).join('\n'),
          }))
        }
        // 真实受理门 → apply（propose 自带 schema 门 + 全门序列；拒收零落盘）
        let prop: GraphEditProposalResult
        try {
          prop = await this.e.graphPropose('edit', YAML.stringify(spec)) as GraphEditProposalResult
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await logRound('finish', render(EXEC_ROUND_FINISH_PROPOSE_REJECT, {}), [msg])
          throw new Error(render(ERR_FINISH_PROPOSE, { msg }))
        }
        let applied: GraphApplyEditResult
        try {
          applied = await this.e.graphApply('edit', prop.id) as GraphApplyEditResult
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const rejectReason = render(REJECT_FINISH_APPLY, { msg })
          await this.e.graphReject(prop.id, rejectReason)
            .catch(rejErr => this.rejectCompensateFail(prop.id, rejectReason, rejErr))
          await logRound('finish', render(EXEC_ROUND_FINISH_APPLY_FAIL, { id: prop.id }), [msg])
          throw new Error(render(ERR_FINISH_APPLY, { msg }))
        }
        // sealed 谓词要的是**现行锚**（本批 set_pre 接线是否构成收尾宣告）——只读锚文件，
        // 不为它再装载一遍图与登记表（门复验刚刚跑过，那两次装载在 gateCtxOf 里）。
        // #315 B2：闭包真已学读数看**本批接线后**的闭包（apply 已成功，重读真实基图即含本批）；
        // 与 apply 侧同一判据（门同调），降级只影响本站回执文案（锚写入在 apply 侧执法）。
        const { nodes: postNodes } = await draftNodesOf()
        const postReadings = structureReadingsOf(new Graph(postNodes), state, anchors)
        const sealed = sealedDecisionOf(unpublished, await readAnchors(this.e.paths.anchorPath(root), this.e.fs),
          (ep: string) => {
            const r = postReadings.find(x => x.endpoint === ep)
            return { total: r?.total ?? 0, unlearned: r?.unlearned ?? [ep] }
          })
        doc.published = doc.ops.length
        doc.note = undefined
        doc.concepts = []
        // confusable 建议（#272）：发布成功后展开为混淆对候选提案（人审一次一条，
        // 不自动入册）——铸名此刻已在册；对端不在册/已声明过等不拦 finish，逐条记行
        const confusableLines: string[] = []
        for (const s of doc.confusables ?? []) {
          try {
            const p = await this.e.proposeConfusableCandidate(c.name, {
              a: s.concept, b: s.with,
              evidence: [`生长批提案 #${prop.id} 铸名建议（${operatorFoldOf(unpublished) || '生长'}——${noteLite.reason}）`],
            })
            confusableLines.push(render(EXEC_CONFUSABLE_CANDIDATE, { id: p.id, a: p.a, b: p.b }))
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            confusableLines.push(render(EXEC_CONFUSABLE_FAIL, { concept: s.concept, with: s.with, msg: msg.split('\n')[0] }))
          }
        }
        doc.confusables = []
        const created = unpublished.filter(o => o.op === 'add_node').map(o => String(o.name ?? ''))
        finishes.push({
          proposal_id: prop.id, ops: unpublished.length, snapshot: applied.snapshot,
          operators: growthOperatorsOf(unpublished), reason: noteLite.reason,
          target_endpoints: noteLite.target_endpoints ?? [], created,
        })
        await logRound('finish', render(EXEC_ROUND_FINISH_OK, {
          id: prop.id, snapshot: applied.snapshot, ops: unpublished.length,
          sealed: sealed.effects.length ? render(EXEC_ROUND_FINISH_SEALED, { effects: sealed.effects.map(e => `${e.endpoint}=${e.action}`).join('、') }) : '',
          confusable: confusableLines.length ? render(EXEC_ROUND_FINISH_CONFUSABLE, { count: confusableLines.length }) : '',
        }))
        if (doc.published === doc.ops.length) await deleteDraft(this.e.fs, draftPath)
        return render(RECEIPT_FINISH, {
          id: prop.id, snapshot: applied.snapshot, published: doc.published, total: doc.ops.length,
          sealed: sealed.effects.length ? render(RECEIPT_FINISH_SEALED, { effects: sealed.effects.map(e => `${e.endpoint}=${e.action}`).join('、') }) : '',
          confusable: confusableLines.length ? `\n${confusableLines.join('\n')}` : '',
        })
      }
      throw new Error(render(ERR_EXEC_WHITELIST, { name: call.name }))
    }

    // —— 回路 ——
    const { graph, state } = await this.e.loadView(c)
    const anchors = await readAnchors(this.e.paths.anchorPath(root), this.e.fs)
    const view = renderGrowthGraphView(graph, state, endpointNames(anchors), { today, conceptEntries: await entriesOf() })
    const template = await this.e.content.loadPrompt(GROWTH_DRAFT_STATION)
    const pack = await this.coachContextPack(c.name, { today, packLabel: '教练执行——草稿会话上下文' })
    const draftStatus = [
      render(EXEC_STATUS_HEADING, {
        session: doc.session_id,
        resumed: resumed ? render(EXEC_STATUS_RESUMED, {}) : render(EXEC_STATUS_NEW, {}),
        published: doc.published, total: doc.ops.length,
      }), '',
      render(EXEC_STATUS_COUNTS, {
        unpublished: doc.ops.length - doc.published,
        // 腐坏草稿（concepts 存成字典而非列表）下不能崩：本块是诊断面，读数取舍不栏后续门折叠
        mints: Array.isArray(doc.concepts) ? doc.concepts.length : 0,
      }),
      ...(doc.note ? [render(EXEC_STATUS_NOTE, { reason: doc.note.reason })] : []),
      ...(doc.rounds.length ? [
        render(EXEC_STATUS_ROUNDS_HEADING, {}),
        ...doc.rounds.slice(-8).map(r => render(EXEC_STATUS_ROUND_LINE, {
          kind: r.kind, summary: r.summary,
          errors: r.errors ? render(EXEC_STATUS_ROUND_ERRORS, { count: r.errors.length }) : '',
        })),
      ] : []),
    ].join('\n')
    // 外部注入块（#149/#248 同通道）：显式重新裁决的请求材料随包进回路提示词（#320 单站）。
    const inject = opts.inject !== undefined
      ? render(COACH_INJECT_BLOCK, { inject: opts.inject.trimEnd() })
      : undefined
    const prompt = withContractLast(template, [pack, view, draftStatus, inject]
      .map(b => b?.trim()).filter((b): b is string => Boolean(b)).join('\n\n---\n\n'))
    const runTool = async (call: LlmToolCall): Promise<string> => {
      // 写件崩溃补轮志（#302 ②）：三件写工具此前只有**被受理门拒绝**的那几条路径写轮志，
      // 其余抛出（缺 note / 非法算子 / 零增量 / op 超量 / 门复验未预期异常）在草稿里零痕迹
      // ——事故里 4 次 finish 崩溃因此不可考古（只能靠语料逐文件还原是谁、为什么死的）。
      // 判据 = 本次调用是否已经记过同 kind 的轮（记过就不重复记——被拒轮次自己写了细节）。
      const kind = DRAFT_TOOL_ROUND_KIND[call.name]
      const before = doc.rounds.length
      try {
        if (call.name.startsWith('draft_')) return await writeTool(call)
        return await readExecutor(call)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const logged = doc.rounds.length > before && doc.rounds.at(-1)?.kind === kind
        if (kind && !logged) {
          // 补记**尽力而为**：轮志落盘失败（IO）不得顶替掉原始错误——排查面第一优先是
          // 「这个工具为什么抛」，不是「日志为什么没写上」。
          try {
            await logRound(kind, render(EXEC_CRASH_SUMMARY, {
              label: DRAFT_ROUND_CRASH_LABEL[kind],
              head: (msg.split('\n')[0] ?? '').slice(0, DRAFT_ROUND_HEAD_LIMIT),
            }), [msg])
          } catch {
            this.e.logger.warn('growth.draft.round_write_failed', { course: c.name, session: doc.session_id, kind })
          }
        }
        // 门拒收留痕（#313 B6）：草稿侧的每一次门拒绝此前只活在**草稿档的轮志**里
        // （模型看得到、人翻日志看不到）——`coach.gate.reject` 是文档点名的主验收物，
        // 这里让它真的发得出来：`gate` = 被拒的工具，明细进续行（MULTILINE_EVENTS 已登记）。
        this.e.logger.warn('coach.gate.reject', {
          course: c.name, station: GROWTH_DRAFT_STATION, gate: call.name,
          errors: 1, detail: [msg.split('\n')[0] ?? ''],
        })
        throw err
      }
    }
    const log = this.e.logger
    log.info('coach.draft.enter', { course: c.name, session: doc.session_id, resumed })
    const loop = await agent.agentLoop({
      station: GROWTH_DRAFT_STATION, prompt, effort: 'deep',
      tools: GrowthSubsystem.draftToolSpecs(), runTool,
      // 进展世代 = 已发布水位（#309 缺陷④）：发布成功即前移 → 熔断游标清零，正常节奏不误杀；
      // 一路不发布（事故形态）则同错误行按工具累计，第三次止血而不是烧到 K≤20 顶。
      progressEpoch: () => doc.published,
      ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
    })
    const finished = doc.rounds.some(r => r.kind === 'finish' && r.summary.startsWith('发布成功'))
      && doc.published === doc.ops.length && doc.ops.length > 0
    // 禁止空手结束（ADR-0088 裁决 8）：自然收束且未成功 finish 且有未发布增量 → fail loud
    if (!finished && doc.ops.length > doc.published) {
      await persist()
      log.warn('coach.draft.unfinished', { course: c.name, session: doc.session_id, unpublished: doc.ops.length - doc.published })
      throw new Error(budgetExhausted()
        ? render(ERR_DRAFT_BUDGET_EXHAUSTED, {
          rounds: doc.rounds.length, max: GROWTH_DRAFT_MAX_ROUNDS,
          unpublished: doc.ops.length - doc.published,
        })
        : render(ERR_DRAFT_UNFINISHED, {
          unpublished: doc.ops.length - doc.published, session: doc.session_id,
        }))
    }
    if (doc.published === doc.ops.length && finished) await deleteDraft(this.e.fs, draftPath)
    else if (doc.ops.length === 0 && !doc.rounds.some(r => r.kind === 'patch' || r.kind === 'finish')) {
      // 僵尸草稿清场（#315 B6）：从未装载过任何内容（零增量、零 patch/finish 轮——只剩
      // 空审计）却收场的草稿即删，不留给下次生长续建。draft_revert 清空后的草稿不算
      //（它装载过内容，模型可能回炉重开一批，保留可续建是既有语义）。
      this.e.logger.warn('growth.draft.empty_cleared', { course: c.name, session: doc.session_id, rounds: doc.rounds.length })
      await deleteDraft(this.e.fs, draftPath)
    }
    log.info('coach.draft.exit', { course: c.name, session: doc.session_id, finished })
    return {
      course: c.name,
      session_id: doc.session_id,
      resumed,
      finished,
      published_batches: doc.rounds.filter(r => r.kind === 'finish' && r.summary.startsWith('发布成功')).length,
      unpublished_ops: doc.ops.length - doc.published,
      trajectory: loop.trajectory,
      rounds: doc.rounds.map(r => ({ kind: r.kind, summary: r.summary })),
      finishes,
      ...(declaredHaltReason !== undefined ? { halt_reason: declaredHaltReason } : {}),
      ...(declaredServesArc !== undefined ? { serves_arc: declaredServesArc } : {}),
      ...(declaredRepaint !== undefined ? { repaint_suggest: declaredRepaint } : {}),
    }
  }

  /** 生长草稿·显式取消（#312 B4 起有生产接面：agent 工具 `learnhub_coach_draft_cancel` +
   * 面板路由 `POST /coach/draft/cancel` + 教练台「取消草稿」）：删除在途草稿快照——只丢
   * **未发布**增量，已发布的批次已随历次 finish 落进图里。没有在途草稿是合法空态
   * （`cancelled: false`），不是错误。 */
  async coachDraftCancel(courseKey: string): Promise<{ cancelled: boolean }> {
    const c = await this.e.registry.resolve(courseKey)
    const doc = await findActiveDraft(this.e.fs, this.e.paths, c.root)
    if (!doc) return { cancelled: false }
    await deleteDraft(this.e.fs, draftPathOf(this.e.paths, c.root, doc.session_id))
    return { cancelled: true }
  }

  /** 生长闸门（注入 GraphProposals 的回调，propose/apply 双门消费）：只对生长批的
   * 插入/旁支**条目**生效（#327 逐条目化——按 op.operator 分组计数，混算子批各裁各的），
   * 三率超限或复诊通过率触底时闸停（低数据静默），普通 edit 提案与结算自动提案
   * （无 note）恒放行。插入积极性调速器，参数唯一出处 params.ts。 */
  async growthGateErrors(spec: EditProposalSpec): Promise<string[]> {
    if (!spec.note) return []
    const addsByOperator = new Map<string, number>()
    for (const op of spec.ops) {
      if (op.op !== 'add_node' || (op.operator !== '插入' && op.operator !== '旁支')) continue
      addsByOperator.set(op.operator, (addsByOperator.get(op.operator) ?? 0) + 1)
    }
    if (!addsByOperator.size) return []
    const c = await this.e.registry.get(spec.course)
    if (!c) return []
    const { today, cutoff } = await this.e.learningDay()
    const { rates } = await this.probationFrame(c, today, cutoff)
    const blocks: string[] = []
    for (const [operator, adds] of addsByOperator) {
      blocks.push(...growthGate(rates, { operator, adds }).blocks)
    }
    return blocks
  }


  /** 课程复诊面的一次性取材（结算/状态/闸门共用）：账本折叠 + 课程学习日序列 + 三率。
   * 登记日/决定日都从提案记录派生（账本只存 proposal id——与 origin 从 journal 派生
   * 同款纪律）；生长批出材从已决生长批提案 artifact 折叠。 */
  private async probationFrame(c: CourseEntry, today: string, cutoff: number): Promise<{
    fold: ProbationFold
    learningDays: string[]
    registrations: Array<{ entry: ProbationEntry; day: string | null }>
    /** 在途复诊（折叠后每 (proposal,node) 最新行；结算遍历的唯一口径——遍历原始行会
     * 把已决条目的裁决前行复读重裁，proven 可被翻案剪除）。 */
    inFlightWithDay: Array<{ entry: ProbationEntry; day: string | null }>
    decisions: Array<{ entry: ProbationEntry & { outcome: ProbationOutcome }; day: string | null }>
    tallies: GrowthBatchTally[]
    rates: ReturnType<typeof growthRates>
  }> {
    const fold = foldProbation(await readProbationLedger(this.e.paths, c.root, this.e.fs))
    const practice = netPracticeRecs(await this.e.store.practiceAll(), await this.e.store.erratumAll())
    const reviews = await this.e.store.reviewLogAll()
    const learningDays = learningDaysOf(practice, reviews, c.name, cutoff, today)
    const proposals = await this.e.store.loadProposals()
    const regDay = new Map<number, string | null>()
    for (const p of proposals) regDay.set(p.id, p.decided ? dayOfTs(p.decided, cutoff) : null)
    const registrations = fold.entries.map(entry => ({ entry, day: regDay.get(entry.proposal) ?? null }))
    const inFlight = new Set(fold.inFlight)
    const inFlightWithDay = registrations.filter(r => inFlight.has(r.entry))
    const decisions = fold.decided.map(entry => ({
      entry,
      day: entry.decided_at ? dayOfTs(entry.decided_at, cutoff) : null,
    }))
    const tallies = await this.growthTallies(proposals, cutoff)
    const rates = growthRates(registrations, decisions, tallies, learningDays)
    return { fold, learningDays, registrations, inFlightWithDay, decisions, tallies, rates }
  }


  /** 生长批出材折叠（三率的生长分母）：已决 edit 提案中的生长批（summary 前缀）——
   * 从 artifact 读逐条目算子并按算子分组计数（#327 逐条目化，混算子批一组一条 tally；
   * 账本只持有插入，前进/旁支出材从提案留痕折叠）。artifact 缺失/损坏的批次不计入
   * （留痕缺失是审计问题，不炸读侧）；逐条目算子全缺的旧档（#327 前的 note.operator
   * 形态）回退按批级算子记一条——窗内历史不因 schema 迁移被清零。 */
  private async growthTallies(proposals: ProposalRec[], cutoff: number): Promise<GrowthBatchTally[]> {
    const tallies: GrowthBatchTally[] = []
    for (const p of proposals) {
      if (p.kind !== 'edit' || p.status !== 'applied' || !p.decided) continue
      if (!p.summary.startsWith('生长批（')) continue
      try {
        const doc = YAML.parse(await this.e.fs.readFile(this.e.paths.proposalArtifactPath(p.id, 'edit', p.course))) as {
          note?: { operator?: unknown }
          ops?: Array<{ op?: unknown; operator?: unknown }>
        }
        const ops = Array.isArray(doc.ops) ? doc.ops : []
        const byOperator = new Map<string, number>()
        for (const op of ops) {
          if (op.op !== 'add_node' || typeof op.operator !== 'string') continue
          byOperator.set(op.operator, (byOperator.get(op.operator) ?? 0) + 1)
        }
        if (byOperator.size) {
          const day = dayOfTs(p.decided, cutoff)
          for (const [operator, added] of byOperator) tallies.push({ operator, added, day })
        } else if (typeof doc.note?.operator === 'string' && addNodeCountOf(ops)) {
          // #327 前的旧档：批级一枚算子，整批记它
          tallies.push({ operator: doc.note.operator, added: addNodeCountOf(ops), day: dayOfTs(p.decided, cutoff) })
        }
      } catch {
        // 三率 tally 折损留痕（#291）：留痕缺失不炸读侧，WARN 指针随行
        this.e.logger.warn('growth.tally_skip', { course: p.course })
      }
    }
    return tallies
  }


  /** 单课程复诊/实验状态视图（statusJson 附带、/api/probation、learnhub_probation 共用
   * 核）：在途插入节点（面板「实验中」标记的取数）、到期未决、三率（滚动 30 学习日）
   * 与韧性闸门现势（含「下一个最小插入批」的standing 判定——调速器对教练的现势语义）。 */
  async probationViewFor(c: CourseEntry, today: string, cutoff: number): Promise<ProbationCourseView> {
    const frame = await this.probationFrame(c, today, cutoff)
    const standing = growthGate(frame.rates, { operator: '插入', adds: 0 })
    const nextInsert = growthGate(frame.rates, { operator: '插入', adds: 1 })
    const overdue: string[] = []
    for (const { entry, day } of frame.inFlightWithDay) {
      if (!day) continue
      if (recheckDue(frame.learningDays, day, entry.due).due) overdue.push(entry.node)
    }
    return {
      in_flight: frame.fold.inFlight.map(e => e.node).sort(),
      overdue: overdue.sort(),
      rates: frame.rates,
      gate: {
        resilient: standing.resilient,
        sidebranch_cap: standing.sidebranch_cap,
        insert_blocked: nextInsert.blocks.length > 0,
        insert_blocks: nextInsert.blocks,
      },
    }
  }


  /** 插入实验面（面板/agent 共用入口）：全启用课程或单课程的复诊状态视图。 */
  async probationStatus(courseKey?: string): Promise<{
    date: string
    courses: Array<{ course: string } & ProbationCourseView>
  }> {
    const { today, cutoff } = await this.e.learningDay()
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: Array<{ course: string } & ProbationCourseView> = []
    for (const c of courses) out.push({ course: c.name, ...(await this.probationViewFor(c, today, cutoff)) })
    return { date: today, courses: out }
  }


  /** probation 在途行使闸（#146）：实验中的插入节点——行使只记流不回流练习证据
   * （EMA/计数不动，proven 后恢复；普通前进/旁支节点不受闸）。questionAnswer/
   * questionForget/interactiveSettle/项目回流四处消费。 */
  async exerciseGated(c: CourseEntry, node: string): Promise<boolean> {
    const fold = foldProbation(await readProbationLedger(this.e.paths, c.root, this.e.fs))
    const hit = fold.byNode.get(node)
    return hit !== undefined && !hit.outcome
  }


  /** 复诊结算钩子（#146 零人审自动裁决）：到期（课程学习日推进满预注册复诊期）的在途
   * 插入边逐条结算——达标 proven（插入转正），不达标自动剪（set_pre 恢复原粗边 +
   * del_node 归档，走既有提案受理门 apply，零人审；审计 ERROR 时提案自清、条目留待
   * 下次重试）。复诊结局与图修复事件出生即写沉淀正典（概念地址书写），journal 留痕，
   * 学习者档案投影随结算重建。触发面 = 队列空闲检查点（宿主）/ learnhub_probation
   * settle（手动）。 metric 预注册不可读或提案记录缺失的到期条目跳过不决——到期未决
   * 由 data-check 提示类消费，不造假裁决。 */
  async settleRechecks(courseKey?: string, opts: { today?: string } = {}): Promise<{
    date: string
    courses: Array<{
      course: string
      settled: Array<{ node: string; outcome: ProbationOutcome; metric?: RecheckMetric; detail?: string; proposal?: number }>
      skipped: Array<{ node: string; reason: string }>
    }>
  }> {
    const { today: learningToday, cutoff } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: Array<{ course: string; settled: Array<{ node: string; outcome: ProbationOutcome; metric?: RecheckMetric; detail?: string; proposal?: number }>; skipped: Array<{ node: string; reason: string }> }> = []
    for (const c of courses) {
      const settled: Array<{ node: string; outcome: ProbationOutcome; metric?: RecheckMetric; detail?: string; proposal?: number }> = []
      const skipped: Array<{ node: string; reason: string }> = []
      const frame = await this.probationFrame(c, today, cutoff)
      if (frame.inFlightWithDay.length) {
        const proposals = await this.e.store.loadProposals()
        const { graph } = await this.e.loadView(c)
        const invokesOf = await this.invokesResolver(c)
        const practice = netPracticeRecs(await this.e.store.practiceAll(), await this.e.store.erratumAll())
        const reviews = await this.e.store.reviewLogAll()
        for (const { entry, day } of frame.inFlightWithDay) {
          if (!day) {
            skipped.push({ node: entry.node, reason: `提案 #${entry.proposal} 缺失或未决——登记日无从判定，到期检查挂起` })
            continue
          }
          const due = recheckDue(frame.learningDays, day, entry.due)
          if (due.due === false) {
            skipped.push({ node: entry.node, reason: `复诊期推进中（${due.elapsed}/${entry.due} 学习日）` })
            continue
          }
          const metric = await this.recheckMetricOf(c, proposals, entry)
          if (!metric) {
            skipped.push({ node: entry.node, reason: `预注册不可读（提案 #${entry.proposal} artifact 缺失/损坏）——留待人工核对` })
            continue
          }
          // 结局判定（读侧折叠；节点已先行移除 = 插入未证，按剪除收口不重开提案）
          const coarsePre = graph.preOf[entry.node] ?? []
          let outcome: ProbationOutcome
          let detail: string
          let settlePid: number | undefined
          if (!graph.nset.has(entry.node)) {
            outcome = '剪除'
            detail = '节点已不在图（被先行移除）——插入未证，按剪除收口'
          } else {
            const verdict = recheckVerdict({
              metric, practice, reviews, course: c.name, cutoff,
              entryDay: day, today, period: entry.due,
              consumers: graph.succ[entry.node] ?? [],
              invokesOf,
            })
            outcome = verdict.met ? 'proven' : '剪除'
            detail = verdict.detail
            if (!verdict.met) {
              const pid = await this.pruneProbationNode(c, graph, entry, metric, detail)
              if (pid === null) {
                skipped.push({ node: entry.node, reason: '剪除提案被受理门/审计拒绝——条目保持在途，待结构修复后重试' })
                continue
              }
              settlePid = pid
            }
          }
          // 写入单元（#176）：每条目的落盘写序照今天的声明——「账本结局行 → 结局落账
          // （沉淀事件 + probation_settle journal）」。剪除管线（pruneProbationNode：
          // propose→apply，内部自带 reject 补偿）已在其前面完成并被拒时整条目跳过
          // （上方 continue）——与今天一致。失败上抛中止，不回滚不续跑，失败不写 journal；
          // 「账本已决、沉淀未落」的部分态窗口照旧（恢复 = data-check 提示 + 重提）。
          const decidedAt = nowIsoOf(this.e.clock.nowMs())
          const settledEntry = { ...entry, outcome, decided_at: decidedAt }
          await runWriteUnit('settleRechecks', {
            clock: this.e.clock,
            journal: rec => this.e.store.appendJournal(rec),
            steps: [
              {
                // 账本追加只增，折叠口径每 (proposal, node) 取最后一行（读侧幂等）
                name: `账本结局行#${entry.proposal}:${entry.node}`,
                run: async () => {
                  await appendProbationEntry(this.e.paths, c.root, settledEntry, this.e.fs)
                },
              },
              {
                name: `结局落账#${entry.proposal}:${entry.node}`,
                run: async () => {
                  await this.recordRecheckOutcome(c, settledEntry, {
                    metric, detail, settlePid, graph, coarsePre,
                  })
                },
              },
            ],
          })
          settled.push({ node: entry.node, outcome, metric, detail, ...(settlePid ? { proposal: settlePid } : {}) })
        }
      }
      if (settled.length) await this.e.sedimentRebuildProfile()
      out.push({ course: c.name, settled, skipped })
    }
    return { date: today, courses: out }
  }


  /** 从提案 artifact 回读预注册 metric（账本只存 proposal id 的对账；缺失返回 null）。
   * #327 起预注册随条目走：按登记节点名找它的 add_node 条目读 op.recheck.metric；
   * 旧档（note.recheck 形态）回退读批级字段——窗内登记不因 schema 迁移丢判据。 */
  private async recheckMetricOf(_c: CourseEntry, proposals: ProposalRec[], entry: ProbationEntry): Promise<RecheckMetric | null> {
    const rec = proposals.find(p => p.id === entry.proposal)
    if (!rec) return null
    try {
      const doc = YAML.parse(await this.e.fs.readFile(this.e.paths.proposalArtifactPath(entry.proposal, 'edit', rec.course))) as {
        note?: { recheck?: { metric?: unknown } }
        ops?: Array<{ op?: unknown; name?: unknown; recheck?: { metric?: unknown } }>
      }
      const own = (Array.isArray(doc.ops) ? doc.ops : [])
        .find(o => o.op === 'add_node' && o.name === entry.node && o.recheck !== undefined)
      const metric = own?.recheck?.metric ?? doc.note?.recheck?.metric
      return typeof metric === 'string' ? (metric as RecheckMetric) : null
    } catch {
      return null
    }
  }


  /** 补偿失败兜底（#296）：graphReject 补偿失败时留痕 + 把提案置显式 rejected——
   * 半途提案滞留 pending 会被 takePending 缺省「最新」误中（apply 错靶）。登记表
   * 本身写不动时只余留痕（那是 #194 式损坏面，不在此兜）。 */
  private async rejectCompensateFail(propId: number, reason: string, rejErr: unknown): Promise<void> {
    const msg = rejErr instanceof Error ? rejErr.message : String(rejErr)
    this.e.logger.error('graph.reject_compensate_fail', { proposal: propId, error: msg })
    try {
      await this.e.store.updateProposal(propId, {
        status: 'rejected',
        decided: new Date(this.e.clock.nowMs()).toISOString(),
        decision_note: `${reason}｜拒绝补偿失败兜底置显式状态：${msg}`,
      })
    } catch (err2) {
      this.e.logger.error('graph.reject_compensate_fail', {
        proposal: propId,
        error: `置显式状态也失败：${err2 instanceof Error ? err2.message : String(err2)}`,
      })
    }
  }


  /** 自动剪除（不达标结算的执行半）：set_pre 把插入节点的现行 pre 还给每个下游消费
   * 节点（原粗边恢复）+ del_node 归档（课程笔记与题库随 apply 的既有归档语义进
   * state/archive）。走 propose→apply 完整受理门（结构/锚保护/审计零豁免）；任一门
   * 拒绝即返回 null（条目保持 in-flight，留待重试）。 */
  private async pruneProbationNode(
    c: CourseEntry, graph: Graph, entry: ProbationEntry, metric: RecheckMetric, detail: string,
  ): Promise<number | null> {
    const node = entry.node
    const coarse = graph.preOf[node] ?? []
    const ops: Array<Record<string, unknown>> = []
    for (const consumer of graph.succ[node] ?? []) {
      const restored = [...new Set(graph.preOf[consumer].flatMap(p => p === node ? coarse : [p]))]
      ops.push({ op: 'set_pre', node: consumer, pre: restored })
    }
    ops.push({ op: 'del_node', node })
    const yaml = YAML.stringify({
      course: c.name,
      reason: `复诊未达标自动剪除：插入节点「${node}」未过预注册复诊（${metric}：${detail}）——恢复原粗边并归档`,
      ops,
    })
    try {
      const prop = await this.e.graphPropose('edit', yaml) as { id: number }
      try {
        await this.e.graphApply('edit', prop.id)
        return prop.id
      } catch (err) {
        await this.e.graphReject(prop.id, `复诊剪除 apply 失败：${err instanceof Error ? err.message : String(err)}`)
          .catch(rejErr => this.rejectCompensateFail(
            prop.id, `复诊剪除 apply 失败：${err instanceof Error ? err.message : String(err)}`, rejErr))
        return null
      }
    } catch {
      // 受理门拒绝（结构不可恢复等）：条目保持 in-flight
      return null
    }
  }


  /** 复诊结局落账（出生即写沉淀正典 + journal 留痕）：recheck_outcome 按插入节点
   * teaches 的概念地址逐条书写（无 teaches = 单条无概念地址，缺席合法）；剪除附一条
   * 图修复事件（结构级，概念清单进 payload）。图与 taught 一律取结算起点的快照——
   * 剪除落盘后再查现图，插入节点已删，概念与粗边会静默蒸发。 */
  private async recordRecheckOutcome(
    c: CourseEntry,
    entry: ProbationEntry & { outcome: ProbationOutcome },
    ctx: { metric: RecheckMetric; detail: string; settlePid?: number; graph: Graph; coarsePre: string[] },
  ): Promise<void> {
    const graph = ctx.graph
    const taught = graph.nset.has(entry.node)
      ? Object.keys(graph.teachesOf[entry.node] ?? {})
      : []
    const entries = await this.e.concepts.load()
    const canonicalOf = (name: string): string => resolveConcept(entries, name)?.canonical ?? name
    const payload: Record<string, unknown> = {
      course: c.name, node: entry.node, outcome: entry.outcome,
      metric: ctx.metric, detail: ctx.detail, proposal: entry.proposal,
      period_days: entry.due,
      ...(ctx.settlePid ? { settlement_proposal: ctx.settlePid } : {}),
    }
    if (taught.length) {
      for (const concept of taught) {
        await appendSedimentEvent(this.e.paths, {
          kind: 'recheck_outcome', tier: 'immediate', concept: canonicalOf(concept), payload: { ...payload },
        }, this.e.clock.nowMs(), this.e.fs)
      }
    } else {
      await appendSedimentEvent(this.e.paths, { kind: 'recheck_outcome', tier: 'immediate', payload }, this.e.clock.nowMs(), this.e.fs)
    }
    if (entry.outcome === '剪除' && ctx.settlePid) {
      await appendSedimentEvent(this.e.paths, {
        kind: 'graph_repair', tier: 'immediate',
        payload: {
          ...payload,
          action: 'recheck_prune',
          restored: (graph.succ[entry.node] ?? []).map(consumer => `${consumer} ← ${ctx.coarsePre.join('、')}`),
          concepts: taught.map(canonicalOf),
        },
      }, this.e.clock.nowMs(), this.e.fs)
    }
    await this.e.store.appendJournal({
      course: c.name, node: entry.node, rating: null, kind: 'probation_settle', elapsed_days: 0,
      session: String(entry.proposal),
      detail: `复诊${entry.outcome === 'proven' ? '达标（proven）' : '未达标（剪除）'}｜${ctx.metric}：${ctx.detail}`
        + (ctx.settlePid ? `；剪除提案 #${ctx.settlePid}` : ''),
    })
  }


  /** JOL 预测值的显式契约：三档之外拒绝（参数错误），null/undefined 放行为无预测。 */
  jolPredicted(p: JolPrediction | null | undefined): JolPrediction | null {
    if (p === null || p === undefined) return null
    if (!JOL_PREDICTIONS.includes(p)) {
      throw new Error(`[jol] 预测只能是「${JOL_PREDICTIONS.join('」「')}」之一（收到 ${String(p)}）。`)
    }
    return p
  }
}
