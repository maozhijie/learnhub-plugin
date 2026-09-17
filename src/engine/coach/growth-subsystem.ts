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
import { COACH_PLAN_FEEDBACK_BLOCK, COACH_INJECT_BLOCK, COACH_FIRST_RUNG_CRITERIA } from '../prompts/projects.ts'
import type { Content } from '../content/content.ts'
import type { BankDoc } from '../content/question-bank.ts'
import { Graph, GraphStore } from '../graph/graph.ts'
import type { BrokenNote } from '../vault/notes.ts'
import type { Fm, CourseEntry, GNode, ProposalRec, StuckReportFolded, StuckReportRec } from '../types.ts'
import type { FSRS } from 'ts-fsrs'
import type { CoachCheck } from './coach-round.ts'
import type { CompassEta, CompassEtaRow, RouteReconcile } from './compass.ts'
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
   * `coach.round.enter｜round.result`、思路官三段 `coach.plan.enter｜plan.exit｜plan.reinject`、
   * 执行官站 `coach.draft.*`，**门拒绝统一走 `coach.gate.reject`**（#313 B6：#146 当年的
   * 初版登记点名的 `coach.repair.trigger`／`coach.segment.*`／`coach.round.apply_fail`
   * 全仓零发出点，按文档 grep 会得到「没跑过重裁」的假否定——现在两个站的门拒绝都从这一条
   * 落地，station/gate 两字段区分「哪一站、哪个门」）。 */
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
  /** 已应用提案列表（#273 窄面注入）：显式重裁族「上次裁决摘要」的取材——只读、按 status/kind 过滤。 */
  graphProposals(status?: string, kind?: string): Promise<ProposalRec[]>
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
import type { CoachGrowthSegment, CoachTrigger, GrowthPlanHandover } from './coach-round.ts'
import { COACH_PLAN_PROMPT_KEYS, behaviorDigest, coachPromptFamily, readyDepthCheck, renderBehaviorDigest, renderSedimentForCoach, validatePlanHandover } from './coach-round.ts'
import { coachToolExecutor, coachToolset, renderGrowthGraphView } from './coach-tools.ts'
import type { CoachToolDeps } from './coach-tools.ts'
import type { CompassEtaProbe } from './compass.ts'
import { COMPASS_ETA_PROBE_WEEKS, COMPASS_STATION, ETA_PENDING, ROUTE_PENDING, SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, compassPaintContext, compassScaffold, etaMarkerOf, hasLearnerAnnotations, hasPaintedRoute, parseCompass, reconcileRoute, renderEtaBody, sectionBody, stripWrappingFence, validateRouteBody, withSectionText } from './compass.ts'
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
import { appendProbationEntry, foldProbation, growthGate, growthRates, learningDaysOf, readProbationLedger, recheckDue, recheckPreregOf, recheckVerdict, RECHECK_METRICS } from './probation.ts'
import type { RecheckPrereg } from './probation.ts'
import { addNodeCountOf, applyOpsToNodes, editGateErrors, editProposalGateErrors, EDIT_OPS, replayDraft, sealedDecisionOf, validateEditProposal } from './proposals.ts'
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

/** 思路官站的语料站标签（#301：host STATIONS.growthPlan 引本常量对齐；站名是受控词表）。
 * 此前这一站名是散在调用点的字面量 + host 侧一张写死的 `growth: '教练思路'` 映射。 */
export const COACH_PLAN_STATION = '教练思路'

/** 三件写工具 → 轮志 kind 的单源映射（#302 ②：写件崩溃补轮志的归属判据，与各工具自己
 * 记账时用的 kind 同表——两处各写一份必然有一天漂移成「崩溃记为另一类轮」）。 */
const DRAFT_TOOL_ROUND_KIND: Record<string, GrowthDraftRound['kind']> = {
  draft_patch: 'patch', draft_audit: 'audit', draft_finish: 'finish', draft_revert: 'revert',
}

/** 写件崩溃轮的措辞前缀（轮志 summary = `<前缀>（<错误首行>）`；`finish` 与既有
 * 「finish 被拒」同款留空格，其余按中文连写）。 */
const DRAFT_ROUND_CRASH_LABEL: Record<GrowthDraftRound['kind'], string> = {
  patch: '补丁崩溃', audit: '审计崩溃', finish: 'finish 崩溃', note: 'note 崩溃', revert: '撤销崩溃',
}

/** 崩溃轮 summary 里的错误首行上界（引擎侧的摘要口径；宿主侧的 `LOG_SUMMARY_HEAD` 是
 * 另一个面——引擎不 import 宿主，两个数字各自为政不共享）。 */
const DRAFT_ROUND_HEAD_LIMIT = 200

/** 给错误打上站标签（#301 缺陷③）：宿主失败补标按**真实失败站**落盘——此前生长任务失败
 * 一律补标到 `STATIONS.growth`（'教练思路'），于是执行官站的失败被标到思路官站最近一条
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
   * 就位读侧）：剩余路线 + 批注区（软输入、提议非指令标注）。Missing = ''（合法空态，
   * 整段省略由组装方裁决）。 */
  async compassTail(courseKey: string): Promise<string> {
    const v = await this.compassRead(courseKey)
    if (v.missing) return ''
    const lines: string[] = []
    if (v.route?.trim() && v.route.trim() !== ROUTE_PENDING) {
      lines.push('### 罗盘 · 剩余路线（非承诺草图——方向感，不是承诺）', '', v.route.trim())
    }
    if (hasLearnerAnnotations(v.annotations)) {
      lines.push('### 罗盘 · 学习者批注（软输入——提议非指令）', '', v.annotations!.trim())
    }
    return lines.join('\n\n')
  }


  /** 罗盘初画/重画（learnhub_compass_paint；「罗盘初画」模板 v1，deep 档工具回路）：
   * 终点锚缺失 fail loud（初画锚在终点上）；路线门（非空/无标题/限长）首过即落盘——
   * 只重写「剩余路线」段，批注区字节保留，ETA 重置待刷新（旧带是旧结构的推演）。
   * 金样本回放闸：回路会话数恒 1、无修复轮（首过率对照在测试锚定）。调用经统一
   * agent 缝（#162：剥围栏/语义档/调用日志在缝里内建）；#163 起经只读工具回路——
   * 教练重画路线前可查图自证节点名、对表登记表（既有门零放松：路线门照旧首过即落）。
   * isCancelled（#163 任务取消传导）：队列任务的取消旗标沿缝传入回路。 */
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
    const annotations = hasLearnerAnnotations(doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null)
      ? sectionBody(doc!, SECTION_ANNOTATIONS)
      : null
    const template = await this.e.content.loadPrompt('罗盘初画')
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
    const next = withSectionText(
      withSectionText(existing ?? compassScaffold(c.name), SECTION_ROUTE, body),
      SECTION_ETA, ETA_PENDING,
    )
    await atomicWrite(path, next, this.e.fs)
    // repainted = 罗盘上曾有已画路线（占位/缺席不算）；重写不覆盖的语义由段级合并保证
    const priorRoute = doc ? sectionBody(doc, SECTION_ROUTE)?.trim() ?? '' : ''
    const routeLines = body.split('\n').filter(l => l.trim()).length
    await this.e.store.appendJournal({
      course: c.name, node: '*', rating: null, kind: 'compass_paint', elapsed_days: 0,
      detail: `罗盘初画/重画：路线 ${routeLines} 行${annotations ? '（批注区软输入已附）' : ''}`,
    })
    return {
      course: c.name, path,
      route_lines: routeLines,
      annotations_preserved: Boolean(annotations),
      repainted: Boolean(priorRoute) && priorRoute !== ROUTE_PENDING,
      trajectory: loop.trajectory,
    }
  }


  /** 罗盘重写——「剩余路线」的唯一写权接口（词条「罗盘」；调用方 = 生长批受理票 #145，
   * 在图 apply 的写入单元内、journal 由调用方挂提案 id，此处零 journal）：批注区与 ETA 字节
   * 保留；学习者手编的路线在下一次重写处被覆盖——手编不产生权威变更。路线门同初画。 */
  async compassRewrite(
    courseKey: string, routeMd: string,
  ): Promise<{ course: string; path: string; route_lines: number }> {
    const c = await this.e.registry.resolve(courseKey)
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    if (!anchors.length) {
      throw new Error(`[compass] 课程「${c.name}」零终点（空锚是合法空态）——罗盘重写锚在终点上，先加一个终点。`)
    }
    const body = stripWrappingFence(routeMd)
    const errors = validateRouteBody(body)
    if (errors.length) {
      throw new Error(`[compass] 重写产物未过路线门，罗盘未改动：\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const path = this.e.paths.compassPath(c.root)
    const base = this.e.fs.exists(path) ? await this.e.fs.readFile(path) : compassScaffold(c.name)
    await atomicWrite(path, withSectionText(base, SECTION_ROUTE, body), this.e.fs)
    return { course: c.name, path, route_lines: body.split('\n').filter(l => l.trim()).length }
  }


  /** 周内 ETA 备忘（进程级读侧缓存）：kataOpen 是面板常开入口，同一学习周重复打开
   * 不重复蒙特卡洛；键=课程名，周翻转即重算，force 绕过（罗盘写侧仍按标记幂等）。 */
  private etaMemo = new Map<string, { week: string; eta: CompassEta }>()

  /** 罗盘每周挂载沙盘 ETA（挂周复盘——kataOpen 触发；标记周幂等，force 可重算）：
   * 逐启用课程——零终点跳过、罗盘缺席先落脚手架、当前周已挂 current、否则探测带
   * 折叠后重写「沙盘 ETA」段（措辞锁死「模型推演，非承诺」）。透明度装置：单课失败
   * 不挡其他课，更不挡周复盘。折叠每课都算（周频成本，同周进程内走备忘）：结果随行
   * 携带 eta——周复盘现状区的 ETA 旁挂（#150）取同一份数据，不二次蒙特卡洛。
   * 顺带做**路线对账**（#231 / ADR-0074）：同一挂载点、同一份已读的罗盘文本，把
   * 「剩余路线」条目与图面节点名做零模型粗 diff，结果随行携带 reconcile——周复盘现状区
   * 只以结论呈现。**非权威**：不改罗盘（写权仍唯一，见 #313 D18）、不进门禁、不触发重画；
   * 未画路线（待初画占位）没有对账对象，不出结论。 */
  async compassEtaRefresh(
    courseKey?: string, opts: { today?: string; force?: boolean } = {},
  ): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta; reconcile?: RouteReconcile }>> {
    const { today: learningToday } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const weekStart = weekStartOf(today)
    if (!weekStart) throw new Error(`[compass] today 不是合法日期：${String(today)}`)
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta; reconcile?: RouteReconcile }> = []
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
        // 对账在 ETA 早退之前算（与标记周无关——路线什么时候漂移都要看得见）；
        // 只按名字粗比、只读图面，图面加载失败由外层 catch 归 skipped（不挡 ETA）。
        // #310 起路线随方向批（前进/换向）重写，本对账才真正看到「本批之后的路线」——
        // 此前该段长期冻结在最后一次初画，漂移读数恒定失真。
        const routeBody = sectionBody(doc, SECTION_ROUTE)
        const reconcile = hasPaintedRoute(routeBody)
          ? reconcileRoute(routeBody!, [...(await this.e.loadView(c)).graph.nset])
          : undefined
        const memoed = this.etaMemo.get(c.name)
        const eta = !opts.force && memoed?.week === weekStart
          ? memoed.eta
          : await this.compassEtaFold(c, anchors, today, weekStart)
        this.etaMemo.set(c.name, { week: weekStart, eta })
        if (!opts.force && etaMarkerOf(sectionBody(doc, SECTION_ETA)) === weekStart) {
          out.push({ course: c.name, state: 'current', eta, ...(reconcile ? { reconcile } : {}) })
          continue
        }
        await atomicWrite(path, withSectionText(existing, SECTION_ETA, renderEtaBody(eta)), this.e.fs)
        out.push({ course: c.name, state: 'refreshed', eta, ...(reconcile ? { reconcile } : {}) })
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
    const entries = await this.e.concepts.load(c.root)
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
    // 思路官计划门与执行官收束判据引的都是这一行读数，不再各站各猜「还需不需要生长」。
    const folds = anchors.length ? foldCompletion(graph, state, anchors) : []
    const structureOf = new Map(structureReadingsOf(graph, state, anchors).map(r => [r.endpoint, r]))
    const foldOf = new Map(folds.map(f => [f.endpoint, f]))
    const serves = junctionServes(graph, anchors)

    const out: string[] = [
      `# 教练回合上下文包：${c.name}（${opts.packLabel ?? (lightweight ? '轻量段——只带行为摘要与罗盘' : '全量六区块')}）`,
    ]
    // 终点恒标（#200 / ADR-0055 裁决 3；#239 多终点化：逐终点一行；#240 逐终点状态）：
    // 轻量段不注入终点锚区块，但每行终点名的 token 代价换裁决不盲——轻量/全量都在
    // 包头带终点行（状态三档内联）；终点标记的完整语义随图面进每段。
    const statusLabel = (f: (typeof folds)[number] | undefined): string =>
      f === undefined ? '悬空锚（终点不在图内）'
        : f.status === 'unwired' ? '未接线'
        : f.status === 'reached' ? '已达成'
        : '已铺通（未达成）'
    out.push('', ...(anchors.length
      ? anchors.map(a => {
          const f = foldOf.get(a.endpoint)
          return `- ⚑ 终点：${a.endpoint}（方向标记——朝该方向的生长须汇入它；零正文零题库不被调度）`
            + `${a.goal_note ? `｜目标描述：${a.goal_note}` : ''}｜状态：${statusLabel(f)}`
            + (f ? `｜闭包已学 ${f.closure.learned}/${f.closure.total}` : '')
        })
      : ['- （零终点——空锚是合法空态，先加一个终点：教练回合无从裁决方向）']))
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
            `- 终点节点：${anchor.endpoint}（方向标记，不可 del/rename；接线 = 该主线批 set_pre 到它）`,
            `  - 目标类型：${anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定（完成=块工作表+终点）' : 'capability 能力锚定（完成=终点掌握）'}`,
            `  - 声明日期：${anchor.declared}`,
            `  - 状态：${f === undefined ? '悬空锚（终点不在图内）'
              : f.status === 'reached' ? '已达成（已铺通且最后台阶全掌握）'
              : f.status === 'sealed' ? '已铺通（未达成）'
              : f.criteria.last_steps.length > 0 ? '未铺通（pre 非空、未收尾宣告）'
              : '未接线（pre 空）——朝它长就要接线'}`,
          )
          if (f) {
            lines.push(`  - 闭包学习进度：已学 ${f.closure.learned} / 共 ${f.closure.total}`)
            const st = structureOf.get(anchor.endpoint)
            if (st) {
              lines.push(`  - 结构读数：${st.sealed ? '已收尾' : '未收尾'}｜闭包真已学 ${st.learned}/${st.total}`
                + (st.unlearned.length ? `（未学：${st.unlearned.join('、')}）` : '')
                + `｜${st.complete ? '结构已铺完（该终点不再需要生长——计划门与收束判据同用本读数）' : '结构未铺完'}`)
            }
            const lastSteps = f.criteria.last_steps.map(s => {
              const other = serves.get(s.node)?.filter(e => e !== anchor.endpoint) ?? []
              return other.length ? `${s.node}（同时服务：${other.join('、')}——交汇）` : s.node
            })
            lines.push(`  - 最后台阶：${lastSteps.length ? lastSteps.join('、') : '（pre 空——未接线）'}`)
          }
          if (anchor.goal_note) lines.push(`  - 目标描述：${anchor.goal_note}`)
          if (anchor.worksheet.length) {
            lines.push(`  - 块工作表：${anchor.worksheet.filter(w => w.done).length}/${anchor.worksheet.length} 已核销`)
          }
        }
        lines.push('- 裁决纪律：优先选能同时推进多个未达成终点的台阶（交汇优先）')
        // 首级判据材料（#303 / ADR-0092；#310 补绑终点）：前沿为空 = 这次裁决铺的是坡道
        // 第一级——课程名与终点锚作占位符注入，判据才绑得回既有输入（ADR-0033「视角由
        // 目标携带」），否则上界约束可被域外解满足。单源住 `prompts/projects.ts`，与上行
        // 同域；两族思路官与执行官经同一上下文包自动共享（模板文件零改动）。
        if (frontierEmpty) {
          lines.push(render(COACH_FIRST_RUNG_CRITERIA, {
            course: c.name, endpoints: anchors.map(a => a.endpoint).join('、'),
          }))
        }
        block('终点锚', lines.join('\n'))
      } else {
        block('终点锚', '（零终点——空锚是合法空态，但教练回合无从裁决方向；先加一个终点。）')
      }
    }

    // ② 行为摘要五件套（读侧折叠即算即用；轻量包两件之一）
    block('行为摘要（窗=最近 7 学习日或 10 节取大；即算即用不落盘）',
      renderBehaviorDigest(await this.behaviorDigestOf(c, graph, state, today, cutoff)))

    if (!lightweight) {
      // ③ 登记表档位（前沿视野 = 可学 ∪ 在学节点的概念档位折叠；同概念取最高档）
      // 废弃条目从生成注入面退出（#262）：在册计数只算活跃条目，前沿档位折叠剔除废弃概念
      const entries = await this.e.concepts.load(c.root)
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
      block('登记表档位（前沿概念的教学档位视野）', [
        `- 概念登记表：${entries.length ? `${live.length} 条在册${retiredCount ? `（另有 ${retiredCount} 条已废弃——地址仍解析，仅退出生成注入与候选面）` : ''}` : 'Missing（合法空态——铸名随生长批提案落盘）'}`,
        // 档位取值域**无条件**给（#309 缺陷③）：此前只在「前沿有档位」时经示例间接暴露，
        // 空课/空态批下模型看不到取值域、自造「初识」，直到 propose 拒绝文案里才第一次见合法值。
        `- teaches / assumes 的档位取值域：${CONCEPT_TIERS.join(' / ')}（写别的值会被受理门拒收）`,
        `- 可学/在学节点 ${active.length} 个`,
        `- 前沿 teaches：${teaches.length ? fmtTiers(teaches) : '（前沿节点无 teaches 字段）'}`,
        `- 前沿 assumes：${assumes.length ? fmtTiers(assumes) : '（前沿节点无 assumes 字段）'}`,
      ].join('\n'))

      // ④ 误解目录（前沿节点的误解先验；判据签名不设机器字段，#124）
      const misLines = active.slice().sort().flatMap(n =>
        (graph.misconceptionsOf[n] ?? []).map(m => `- ${n} · ${m.concept}：${m.model}`))
      block('误解目录（前沿节点的误解先验）', misLines.length
        ? misLines.join('\n')
        : '（误解目录空——合法空态：误解先验随生长批写入；真实错误检测归作答流水挖矿与申诉复核）')
    }

    // ⑤ 罗盘尾段（罗盘+沉淀折叠；轻量包只带罗盘半区）
    const tail = await this.compassTail(c.name)
    // 罗盘缺席/未画的占位行（#310 改口径）：此前指向 `learnhub_compass_paint` 初画——但
    // 这行是喂给**裁决站**的（思路官零工具），指示它去跑一个它没有的工具是错的；#310 起
    // 「剩余路线」随方向批（前进/换向）由计划携带写出，初画不是必经步骤。
    const parts = ['### 罗盘', '', tail || '（罗盘缺席或尚无已画路线——合法空态：方向批（前进/换向）会随计划写出「剩余路线」；锚在终点上，零终点先加一个终点。）']
    if (!lightweight) {
      parts.push('', '### 沉淀折叠', '', renderSedimentForCoach(await this.e.sedimentFold()))
    }
    block('罗盘尾段', parts.join('\n'))

    if (!lightweight) {
      // ⑥ V-2 接缝（先验上下文注入——预留占位，Out of Scope：宿主检索面依赖）
      block('V-2 接缝（先验上下文注入——预留）',
        '（v1 未接线：vault 链接先验注入教练回合依赖宿主检索面——本区块为六区块定序占位，接线后由此注入。）')
    }

    return out.join('\n') + '\n'
  }

  /** 教练只读工具面（#163 / ADR-0041 形状；#249 / ADR-0077 八件）：图视图/节点卡/概念足迹/
   * 上游图摘要/题库概况/罗盘/终点锚实现走 coach-tools 的通用执行器（deps 结构化注入，本
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
    const entries = await this.e.concepts.load(c.root)
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


  /** 生长批两站编排（#273 思路官/执行官拆分；旧单发三段式退场不留开关）：
   * ① **思路官**（单轮、零工具、单发）：消费常驻上下文 coachContextPack（全量包）+
   * renderGrowthGraphView 全图摘要 + 外部注入块（#149/#248 同通道），产**交接计划**
   * {operator, target_endpoints, reason, steps[intent/teaches_concept/est_hint], recheck?}
   * ——零节点名、零图上引用（粒度变焦归执行官）；计划 schema 门拒收 → 门错误 + 被拒
   * 计划原文回灌重裁**恰一次**（agent.repair，站名「教练思路」；两轮死因 fail loud，
   * 零写盘）。提示词两族随触发点折叠（coachPromptFamily）：常规生长族
   * （node_complete/session_start/queue_idle）走「思路官回合」，显式重裁族
   * （node_skip/panel_dispatch）走「思路官重裁」并注入上次裁决摘要——摘要取本课程
   * 最近一次生长批的 outcome 留痕（无留痕则省略块）。停摆计划（operator=停摆或
   * steps 空）= 合法停摆，不拉执行官。
   * ② **执行官**（#271 既有草稿回路原样）：计划经「思路官交接」块注入 coachDraft
   * 提示词（ advisory 方向——补丁纪律与门序列不因计划放松），轨迹/发布全程走草稿站。
   * 返回形状：proposal/applied 取最后成功 finish 批的读数（route/罗盘重写随旧路径
   * 退场，compass_rewritten 字段移除）；segments 观测 plan/plan_repair/executor 三段。
   * 停机转译：就绪深度满足（check.ok）时不拉任何站直接停摆（force/inject 豁免照旧）。
   * opts.trigger = 触发点（宿主入队侧随任务携带；缺省 session_start 按常规族）。 */
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
    segments: CoachGrowthSegment[]
    trajectory: string[]
    proposal: { id: number; ops: number; operator: string; reason: string; disagreement: boolean } | null
    applied: { ops: number; snapshot: number; created: string[] } | null
    /** 停摆裁决的理由（#313 E24；仅在 state='idle' 且思路官给了停摆计划时在场）。 */
    halt_reason?: string
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    if (!anchors.length) {
      throw new Error(`[coach-growth] 课程「${c.name}」零终点（空锚是合法空态）——教练回合要有一个方向才能裁决：先加一个终点。`)
    }
    const today = opts.today ?? (await this.e.learningDay()).today
    const check = await this.coachCheckFor(c, today)
    if (check.ok && !opts.force && opts.inject === undefined) {
      return { course: c.name, state: 'idle', check, segments: [], trajectory: [], proposal: null, applied: null }
    }
    // 回合进入（#253 / ADR-0080）：只记真正跑起来的回合——停摆短路（上一行）不算回合。
    const log = this.e.logger
    log.info('coach.round.enter', { course: c.name, today, trigger: opts.trigger ?? 'session_start' })
    const { graph, state } = await this.e.loadView(c)
    const endpoints = endpointNames(anchors)
    const view = renderGrowthGraphView(graph, state, endpoints, { today, conceptEntries: await this.e.concepts.load(c.root) })
    // 首裁口径（#310 / ADR-0092 §修订）：就绪前沿排除终点锚后为空 = 这次裁决铺的是坡道
    // 第一级。同一判据两用——coachContextPack 内注首级判据块，此处定档位（下行）。
    const frontierEmpty = this.frontierEmptyOf(this.coachFrontier(graph, state), endpoints)
    const segments: CoachGrowthSegment[] = []
    const assertAlive = (): void => {
      if (opts.isCancelled?.() === true) {
        throw new Error(`[coach-growth] 「${c.name}」生长批任务已取消——回合中止（已产计划丢弃）。`)
      }
    }

    // —— ① 思路官：两族模板 + 常驻材料 + 注入/上次裁决摘要，单发产交接计划 ——
    // 首裁不是重裁（#310）：重裁族的叙述（沿用/推翻上次裁决）与它引用的「上次裁决摘要」
    // 块是一体的——空课取不到该块，模型只能自己绕过（实测 reason 里写「无从沿袭上次裁决」）。
    // 故族选择从「只看触发点」改为「触发点 + 材料在场」：**上次裁决摘要取不到就走常规族**
    // （其叙述与「从零决定第一级台阶」同构），取得到才按触发点折叠。判据是引擎一步可判的
    // 事实（ADR-0092 自己的论据，此前只用来判「注不注判据块」）；判据与结果都在日志里
    // （`coach.plan.enter` 带 family、`coach.plan.summary_miss` 带缺席原因），不静默。
    const lastSummaryOfHistory = await this.lastGrowthSummaryOf(c)
    const family = lastSummaryOfHistory === undefined ? 'routine' : coachPromptFamily(opts.trigger ?? 'session_start')
    const template = await this.e.content.loadPrompt(COACH_PLAN_PROMPT_KEYS[family])
    const pack = await this.coachContextPack(c.name, { today })
    const lastSummary = family === 'recheck' ? lastSummaryOfHistory : undefined
    const planPrompt = withContractLast(template, [
      pack,
      opts.inject !== undefined ? render(COACH_INJECT_BLOCK, { inject: opts.inject.trimEnd() }) : undefined,
      lastSummary,
      view,
    ].filter((b): b is string => Boolean(b?.trim())).map(b => b.trim()).join('\n\n---\n\n'))
    type PlanVerdict = { plan: GrowthPlanHandover; yaml: string; _schemaErrors?: string[] }
    const parsePlan = (raw: string): PlanVerdict => {
      const yaml = stripWrappingFence(raw)
      const errors = validatePlanHandover(YAML.parseModel(yaml), c.name)
      if (errors.length) return { plan: { operator: '停摆', reason: '', target_endpoints: [], steps: [] }, yaml, _schemaErrors: errors }
      const doc = YAML.parseModel(yaml) as GrowthPlanHandover & { course: string }
      return { plan: doc, yaml }
    }
    // 档位随语义浓度（#310）：首裁是「从零决定往哪儿长」，而两站拆分（#273）后算子、朝向、
    // 台阶意图全压在思路官侧——它错的代价由恒 deep 的执行官成倍 token 支付。故首裁抬 deep，
    // 其余回合维持 fast（边界见 ADR-0092 §修订：插入算子的高语义同样值得 deep，但算子是
    // 模型输出、调用前无从派发，不在此处假装能判）。
    const planEffort = frontierEmpty ? 'deep' : 'fast'
    const runPlan = (mode: 'complete' | 'repair', feedbackYaml?: string, schemaErrors?: readonly string[]): Promise<PlanVerdict> =>
      // 本段任何抛出（取消传导 / 缝故障 / 解析器故障）都算「思路官站失败」——宿主失败补标
      // 据此落站（#301 缺陷③）
      stationTagged(COACH_PLAN_STATION, async () => {
        assertAlive()
        // #296：首轮 schema 错误清单进回灌块（修复轮不再盲修——此前 feedbackYaml 同时充
        // 当 feedback 与 previousYaml，清单只活在拒绝事件里，模型只能对着原文猜）
        const prompt = feedbackYaml === undefined ? planPrompt : planPrompt + '\n\n---\n\n'
          + render(COACH_PLAN_FEEDBACK_BLOCK, {
            feedback: feedbackYaml ?? '', previousYaml: feedbackYaml ?? '',
            schemaErrors: (schemaErrors ?? []).map(e => `- ${e}`).join('\n') || '（无清单，按模板逐项自查）',
          })
        if (mode === 'repair') {
          log.debug('coach.plan.reinject', { course: c.name, family, schema_errors: (schemaErrors ?? []).length })
        }
        log.info('coach.plan.enter', { course: c.name, family, mode })
        const raw = mode === 'complete'
          ? await agent.complete(COACH_PLAN_STATION, prompt, { effort: planEffort })
          : await agent.repair(COACH_PLAN_STATION, prompt, { effort: planEffort })
        const verdict = parsePlan(raw)
        log.info('coach.plan.exit', {
          course: c.name, family, mode,
          operator: verdict._schemaErrors ? undefined : verdict.plan.operator,
          ...(verdict._schemaErrors ? { schema: 'reject', detail: verdict._schemaErrors } : { schema: 'ok' }),
        })
        return verdict
      })
    let planVerdict = await runPlan('complete')
    segments.push({
      tier: 'plan', effort: planEffort, operator: planVerdict._schemaErrors ? '' : planVerdict.plan.operator,
      disagreement: planVerdict._schemaErrors ? false : planVerdict.plan.operator === '插入' && Boolean(planVerdict.plan.recheck),
    })
    if (planVerdict._schemaErrors) {
      // 计划门拒收 → 回灌重裁恰一次（两轮死因 fail loud，零写盘）。留痕事件是
      // `coach.gate.reject`（#313 B6：族里此前发的是 `coach.plan.recheck`，而排查手册
      // 与门册点名的主验收物是 `coach.gate.reject`——「按文档 grep 会得到假否定」）。
      log.warn('coach.gate.reject', {
        course: c.name, station: COACH_PLAN_STATION, gate: 'plan_schema', round: 1,
        errors: planVerdict._schemaErrors.length, detail: planVerdict._schemaErrors,
      })
      const repaired = await runPlan('repair', planVerdict.yaml, planVerdict._schemaErrors)
      if (repaired._schemaErrors) {
        log.warn('coach.gate.reject', {
          course: c.name, station: COACH_PLAN_STATION, gate: 'plan_schema', round: 2, fatal: true,
          errors: repaired._schemaErrors.length, detail: repaired._schemaErrors,
        })
        throw tagErrorWithStation(new Error(`[coach-growth] 思路官计划未过 schema 门（回灌重裁一轮仍未过——零写盘）。\n【首轮】${planVerdict._schemaErrors.join('\n')}\n【重裁】${repaired._schemaErrors.join('\n')}`), COACH_PLAN_STATION)
      }
      segments.push({ tier: 'plan_repair', effort: planEffort, operator: repaired.plan.operator, disagreement: false })
      planVerdict = repaired
    }
    const plan = planVerdict.plan
    if (plan.operator === '停摆' || !plan.steps.length) {
      log.info('coach.round.result', { course: c.name, operator: plan.operator, halt: true, reason: plan.reason })
      // 停摆理由随结果带出（#313 E24）：面板此前只显示固定文案「教练判断暂不需长新内容」——
      // 用户既不知为何也不知下一步（reason 只活在语料的 LLM 交换里）。
      return { course: c.name, state: 'idle', check, segments, trajectory: [], proposal: null, applied: null, halt_reason: plan.reason }
    }

    // —— ② 执行官：#271 草稿回路原样，计划作交接块注入（advisory——门不放松） ——
    log.info('coach.draft.handover', { course: c.name, operator: plan.operator, steps: plan.steps.length })
    // 草稿段任何抛出（回路预算耗尽 / 形状与门拒收 / 禁止空手结束）都算「执行官站失败」——
    // 宿主失败补标据此落站（#301 缺陷③）
    const draft = await stationTagged(GROWTH_DRAFT_STATION, () => this.coachDraft(courseKey, agent, {
      today,
      ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
      ...(opts.onTolerated ? { onTolerated: opts.onTolerated } : {}),
      plan: {
        operator: plan.operator, reason: plan.reason,
        target_endpoints: plan.target_endpoints, steps: plan.steps,
        ...(plan.recheck ? { recheck: plan.recheck } : {}),
        // 罗盘「剩余路线」（#310）：随计划进执行官站的批规格，不落草稿字段（避免续建把
        // 旧稿当本批产物带回来）；缺省 = 不改写、保留旧稿。
        ...(plan.route !== undefined ? { route: plan.route } : {}),
      },
    }))
    const lastFinish = draft.finishes.at(-1)
    if (lastFinish) {
      segments.push({ tier: 'executor', effort: 'deep', operator: lastFinish.operator, disagreement: false })
    }
    log.info('coach.round.result', {
      course: c.name,
      segments: segments.map(s => s.tier).join(','),
      repaired: segments.some(s => s.tier === 'plan_repair'),
      ...(lastFinish ? { proposal: lastFinish.proposal_id, ops: lastFinish.ops } : { halt: true }),
    })
    return {
      course: c.name,
      state: lastFinish ? 'applied' : 'idle',
      check,
      segments,
      trajectory: draft.trajectory,
      proposal: lastFinish ? {
        id: lastFinish.proposal_id, ops: lastFinish.ops,
        operator: lastFinish.operator, reason: lastFinish.reason,
        disagreement: false,
      } : null,
      applied: lastFinish ? {
        ops: lastFinish.ops, snapshot: lastFinish.snapshot,
        created: lastFinish.created,
      } : null,
    }
  }

  /** 上次裁决摘要（#273 显式重裁族材料）：读本课程最近一次生长批 outcome 留痕，
   * 折叠为「上次裁决摘要」块；无留痕返回 undefined（块整体省略，不硬造）。 */
  private async lastGrowthSummaryOf(c: CourseEntry): Promise<string | undefined> {
    try {
      const props = await this.e.graphProposals('applied', 'edit')
      const mine = props.filter(p => p.course === c.name)
      const last = mine.at(-1)
      if (!last) {
        this.e.logger.debug('coach.plan.summary_miss', { course: c.name })
        return undefined
      }
      // #303 顺带修正：`ProposalRec.artifact` 是**落盘路径**（proposals 子系统按它 loadArtifact），
      // 不是产物原文——旧实现直接 `YAML.parseModel(last.artifact)` 拿到的是路径字符串，
      // `note` 恒 undefined，于是重裁族的摘要块**从来没注入过**（`coach.plan.summary_miss`
      // 一路 DEBUG 静默）。这里按路径读盘。
      const note = (this.e.fs.exists(last.artifact)
        ? YAML.parse(await this.e.fs.readFile(last.artifact)) as { note?: { operator?: string; reason?: string } }
        : undefined)?.note
      if (!note?.operator) {
        this.e.logger.debug('coach.plan.summary_miss', { course: c.name })
        return undefined
      }
      return [
        '## 上次裁决摘要（上一次生长批的方向留痕——可沿用可推翻）', '',
        `- 算子：${note.operator}`,
        `- 理由：${note.reason ?? '（未留痕）'}`,
        `- 提案：#${last.id}（已应用）`,
      ].join('\n')
    } catch {
      this.e.logger.debug('coach.plan.summary_miss', { course: c.name })
      return undefined
    }
  }

  // ---- 生长草稿·执行官站（#271 / ADR-0088：草稿内核 + 批量补丁 + 按批 finish）----

  /** 执行官站的只读工具面（读件五件，#271）：复用 coach-tools 渲染函数（同源不漂移）、
   * 新建注册面——description 面向补丁语境；旧 coachToolset 八件与 compassPaint 不动
   * （coachToolsetFor 仅 2 消费方）。写件三工具 draft_patch / draft_audit / draft_finish
   * 的规格也在此登记（产物以工具调用承载的站，OutputFormat='tool-calls'）。 */
  static draftToolSpecs(): LlmToolSpec[] {
    const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
      type: 'object', properties, required, additionalProperties: false,
    })
    const opFields = (): Record<string, unknown> => ({
      op: { type: 'string', description: '原子操作：add_node / del_node / set_pre / set_enc / rename / set_note；糖算子 insert_prereq_chain / split_node / suggest_confusable（见下）' },
      into: { type: 'array', items: { type: 'string' }, description: 'split_node 的拆分新名（≥2 个，轮廓继承被拆节点；终点不可拆）' },
      with: { type: 'string', description: 'suggest_confusable 的易混对端（须是在册概念或随批铸名）' },
      name: { type: 'string', description: 'add_node 的新节点名' },
      node: { type: 'string', description: '引用既有节点的名字（add_node 以外的 op 用）' },
      pre: { type: 'array', items: { type: 'string' }, description: '前置节点名列表（add_node / set_pre；set_pre 是整体替换语义）' },
      enc: { type: 'array', description: 'set_enc 整体替换的成分技能边' },
      new: { type: 'string', description: 'rename 的新名' },
      note: { type: 'string', description: '节点一句话说明' },
      est: { type: 'number', description: '预估分钟（add_node）' },
      bloom: { type: 'string', description: '认知层级（add_node）' },
      difficulty: { type: 'number', description: '难度 1–5（add_node）' },
      teaches: { type: 'object', description: `概念→档（add_node 出生层；概念必须逐字在册或随批铸名。**档位取值域：${CONCEPT_TIERS.join(' / ')}**）` },
      assumes: { type: 'object', description: `概念→档（add_node 出生层。**档位取值域：${CONCEPT_TIERS.join(' / ')}**）` },
      misconceptions: { type: 'array', description: '误解条目（add_node 出生层）' },
    })
    return [
      { name: 'graph_view', description: '当前草稿图面（基图 + 草稿增量已叠加）：全部节点名单 + 细节行。patch 的节点名与 pre 引用的取值域——出补丁前先来这里对表。', parameters: obj({}) },
      { name: 'node_card', description: '单节点结构档（草稿图口径）：阶段、pre/teaches/assumes、下游消费、误解先验。', parameters: obj({ node: { type: 'string', description: '节点名（逐字，来自 graph_view）' } }, ['node']) },
      { name: 'concept_footprint', description: '概念足迹：teaches/assumes/误解 引用对表的唯一权威（写侧恒精确——引用必须逐字命中在册名字或随批 concepts 铸名）。query 是子串发现不是存在性判定：空 ≠ 不存在。', parameters: obj({ query: { type: 'string', description: '可选子串；省略 = 读全表' } }) },
      { name: 'upstream_dag', description: '上游图摘要：给定节点的前置传递闭包全拓扑 + 闭包内 pre 邻接。接线定位与深链诊断用。', parameters: obj({ node: { type: 'string', description: '节点名（逐字）' } }, ['node']) },
      { name: 'endpoint_anchor', description: '终点锚集合：逐终点的目标类型/声明日/收尾宣告。set_pre 接线的靶在这里对表（终点只可被 set_pre 接线，禁出现在 add_node 的 pre）。', parameters: obj({}) },
      {
        name: 'draft_patch', description: '批量补丁（写件）：把一组 EditOp 原子操作追加进生长草稿（每批 ≤24 条未发布增量；失败整批回滚并回灌 errors + 合法取值域）。糖算子——insert_prereq_chain：chain 按序展开成线性 add_node 链；split_node：把既有节点拆成 into 多个（轮廓继承 + 消费方 set_pre 重排 + 删原节点；终点不可拆）；suggest_confusable：给随批铸名的新概念顺手登记易混指向（不是图 op；finish 发布成功后展开为混淆对候选提案，人审后才入册）。op 词汇不含 move 与 region/block（已退役 #275）。', parameters: obj({
          ops: { type: 'array', description: `补丁操作列表。${PATCH_SHAPE_CHEATSHEET}（第一次调用前即可见——形状不合法整批拒收，别拿调用去试。）`, items: { type: 'object', properties: { ...opFields(), chain: { type: 'array', description: 'insert_prereq_chain 的链条目（按序线性串联）' } } } },
          concepts: { type: 'array', description: '随批铸名（本批新引入的概念；已能用就不铸）' },
          note_operator: { type: 'string', description: '本批生长算子（前进/插入/巩固/旁支/换向；下次 finish 硬化为 note）' },
          note_reason: { type: 'string', description: '本批理由一句话' },
          note_target_endpoints: { type: 'array', items: { type: 'string' }, description: '前进/换向批的朝向声明（朝哪些终点长；与接线义务配套）' },
          note_recheck: {
            type: 'object',
            description: `插入批的复诊预注册（**operator=插入 且本批有 add_node 时必填**，其余算子不得携带）：{metric, days?}——插入边的到期结算零人审，没有预注册就没有结算判据。metric 取值域：${RECHECK_METRICS.join(' / ')}（思路官交接块里给的那一枚照抄）；days 缺省 ${RECHECK_DAYS_DEFAULT} 学习日、clamp [${RECHECK_DAYS_MIN},${RECHECK_DAYS_MAX}]。`,
            properties: {
              metric: { type: 'string', description: `可机判结局指标：${RECHECK_METRICS.join(' / ')}` },
              days: { type: 'number', description: `复诊期学习日数（缺省 ${RECHECK_DAYS_DEFAULT}，越界 clamp 到 [${RECHECK_DAYS_MIN},${RECHECK_DAYS_MAX}]）` },
            },
            required: ['metric'],
          },
        }, ['ops']),
      },
      {
        name: 'draft_audit', description: '审计（写件，只读效果）：对草稿图 + 未发布增量跑与受理门同一套校验（草稿通过 = 门通过），返回门错误与草稿差异；另附非阻 findings（限本会话新铸概念的孤立/悬空/近似名撞车 + 终点收尾提示——不拦 finish，但该修的照修）。finish 前先 audit。', parameters: obj({}),
      },
      {
        name: 'draft_finish', description: '按批发布（写件）：把自上次发布以来的未发布增量硬化为生长批提案 → 受理门 → apply。基图漂移（外部改了图）或门复验未过 = 拒收零落盘、错误回灌继续修。收尾（终点坡道铺通）须以零 add_node 的纯 set_pre 独立批 finish。', parameters: obj({}),
      },
      {
        name: 'draft_revert', description: '撤销（写件）：丢弃最近 N 条未发布增量（省略 count = 丢弃本批全部未发布增量，回到水位）。给「草稿里卡着修不掉的坏增量」留一条路——追加式草稿删不掉已入草稿的 op，del_node 重铸也改不动它；撤销后本批作废（连本批 note / 铸名 / confusable 建议一并清），已发布段（水位以下）不可动。', parameters: obj({
          count: { type: 'number', description: '丢弃最近多少条未发布增量（正整数；省略 = 全部丢弃）' },
        }),
      },
    ]
  }

  /** 生长草稿·执行官最小回路（#271 / ADR-0088）：输入自足（coachContextPack + 图面 +
   * 草稿状态），三段式外壳保留、note.disagreement 语义不动（route 归 #273）；站登记
   * growthDraft='教练执行' + OutputFormat 'tool-calls' + 模板键「执行官回合」+
   * REPAIR_MECHANISMS.draftAuditRepair（finish 拒收错误原文回灌 loop 继续修、不进
   * gateRepairRound——门错修复轮保留为旧路径的最后兜底）。禁止空手结束：回路自然收束
   * 且未成功 finish 且草稿仍有未发布增量 → fail loud（草稿保留可续建）。会话在途草稿
   * 默认续建（注入轮次日志恢复认知）；预算常量单源 engine/infra/params.ts。 */
  async coachDraft(
    courseKey: string, agent: AgentSeam,
    opts: {
      today?: string; isCancelled?: () => boolean; plan?: GrowthPlanHandover
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
    /** 成功 finish 批读数（#273 两站编排）：coachGrowthBatch 取最后一批折算 proposal/applied。 */
    finishes: Array<{ proposal_id: number; ops: number; snapshot: number; operator: string; reason: string; target_endpoints: string[]; created: string[] }>
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
      throw new Error(`[coach-draft] 在途草稿属于课程「${doc.course}」，与「${c.name}」不符——同课程单份在途，先取消或完成它。`)
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
    // 计划换代即清上一批的 note（#313 C11）：新计划进场时，草稿里残留的 doc.note 只可能属于
    // **上一批**（本批的 note 由本轮 draft_patch 声明）——不清掉它，续建会话会带着上一批的
    // 算子/理由/朝向把本批发出去（提案记账与三率 tally 记的是错的算子），而思路官这一轮的
    // 方向只活在提示词里。清掉即强制本批显式声明；插入批的复诊预注册由计划兜底（不丢）。
    if (opts.plan && doc.note) doc.note = undefined
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
    const finishes: Array<{ proposal_id: number; ops: number; snapshot: number; operator: string; reason: string; target_endpoints: string[]; created: string[] }> = []

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
    //    规格表收紧为读件五件 + 写件三具；白名单外调用照旧 fail loud。 ——
    const readExecutor = coachToolExecutor(this.e, c, {
      behaviorDigestText: async () => '',
      conceptInvokes: () => this.conceptInvokesOf(c),
    })
    const entriesOf = async (): Promise<ConceptEntry[]> => this.e.concepts.load(root)

    /** 本批生效的复诊预注册（#312 B2）：草稿 note 里显式写的优先；没写且本批是插入批
     * （operator=插入 且有 add_node——受理门要求携带它的正是这一形态）时，用思路官交接
     * 计划里的那一枚兜底（交接块已把它明写给执行官）。计划是 advisory，故只兜底、不覆盖。
     * 两个来源都过同一道 `recheckPreregOf`（取值域/clamp 单源，不因来路不同而放宽）。 */
    const recheckOf = (noteLite: EditProposalNoteLite | undefined, ops: EditOp[]): RecheckPrereg | undefined => {
      if (noteLite?.recheck) {
        const v = recheckPreregOf(noteLite.recheck)
        if (!v.prereg) {
          // 显式值非法只可能来自手改的草稿文件（draft_patch 侧同门拦在前面）：不静默改用
          // 计划那一枚（那会悄悄换掉判据），让它以「缺预注册」的形态在门里炸出来。
          return undefined
        }
        return v.prereg
      }
      const insertBatch = noteLite?.operator === '插入' && ops.some(op => op.op === 'add_node')
      return insertBatch && opts.plan?.recheck ? recheckPreregOf(opts.plan.recheck).prereg : undefined
    }
    /** 本批硬化后的**提案形态**（#309 缺陷①）：`draft_patch` 试算 / `draft_audit` /
     * `draft_finish` **三处同一份**——「草稿通过 = 门通过」要求三处喂给门的是同一个对象，
     * 不是三处各拼一份（拼装漂移正是「审计通过而 finish 被拒」那类事故的温床）。
     * `noteIn` / `conceptsIn` 供试算传「本补丁**将要**声明的 note 与铸名」——补丁的
     * note_operator 与 concepts 在试算时尚未写回 doc，拿旧值试算 = 试算的是另一批。
     * 复诊预注册（#312 B2）在这里落一次：三处同调因此天然一致——试算带上它、发布也带上它。 */
    const batchSpecOf = (
      ops: EditOp[], over: { note?: EditProposalNoteLite; concepts?: ConceptEntry[] } = {},
    ): EditProposalSpec => {
      const noteLite = over.note === undefined ? doc.note : over.note
      const concepts = over.concepts ?? doc.concepts
      const recheck = recheckOf(noteLite, ops)
      return {
        course: c.name,
        reason: noteLite?.reason ?? '',
        ops,
        ...(concepts.length ? { concepts } : {}),
        // 罗盘批内重写（#310）：路线随计划来，且只在**生长批**（note 区在场）上携带——
        // 受理门的 route 规则如此（普通 edit 提案携带即拒收）。正文由受理与 apply 两侧
        // 的路线门验（与计划门同一个 validateRouteBody）；缺省 = 不带该字段 = 不改写旧稿。
        ...(noteLite && opts.plan?.route !== undefined ? { route: opts.plan.route } : {}),
        ...(noteLite
          ? {
              note: {
                operator: noteLite.operator as GrowthNote['operator'],
                reason: noteLite.reason,
                ...(noteLite.target_endpoints?.length ? { target_endpoints: noteLite.target_endpoints } : {}),
                ...(noteLite.disagreement ? { disagreement: noteLite.disagreement } : {}),
                ...(recheck ? { recheck } : {}),
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
      return {
        nodes, graph,
        ctx: {
          nodes, graph, entries: await entriesOf(),
          anchors: await readAnchors(this.e.paths.anchorPath(root), this.e.fs),
          mints,
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
        `档位取值域（teaches / assumes 的值）：${CONCEPT_TIERS.join(' / ')}`,
        `op 词汇：${EDIT_OPS.join(' / ')}（糖算子 insert_prereq_chain / split_node / suggest_confusable；move 与 region/block 已退役）`,
        `节点取值域（草稿图逐字）：${[...graph.names].slice(0, 80).join('、')}${graph.names.length > 80 ? ' …' : ''}`,
        `概念取值域（在册 canonical）：${(await entriesOf()).map(e => e.canonical).slice(0, 60).join('、') || '（空册——随批 concepts 铸名）'}`,
      ].join('\n  · ')
    }

    const renderDiff = (diff: DraftDiff): string => [
      `新增节点 ${diff.added_nodes.length}：${diff.added_nodes.join('、') || '（无）'}`,
      `删除节点 ${diff.removed_nodes.length}：${diff.removed_nodes.join('、') || '（无）'}`,
      `改名 ${diff.renamed.length}：${diff.renamed.map(r => `${r.from}→${r.to}`).join('、') || '（无）'}`,
      `新增边 ${diff.added_edges.length}：${diff.added_edges.map(e => `${e.node} ← ${e.pre}`).join('、') || '（无）'}`,
      `接线改写 ${diff.rewired.length}：${diff.rewired.map(w => `${w.node}（${w.pres_before.join('、') || '∅'} → ${w.pres_after.join('、') || '∅'}）`).join('；') || '（无）'}`,
    ].join('\n')

    // —— 写件三工具 ——
    const writeTool = async (call: LlmToolCall): Promise<string> => {
      const args = JSON.parse(call.arguments.trim() || '{}') as Record<string, unknown>
      if (call.name === 'draft_patch') {
        // 轮次预算耗尽后只放行收束动作（#312 B4）：追加补丁被拒，并给出真实存在的两条出路
        // （发布已备好的那批；或取消本会话草稿重开——此前这条「取消」只在文案里存在）。
        if (budgetExhausted()) {
          await logRound('patch', `补丁被拒（轮次预算耗尽，${doc.rounds.length}/${GROWTH_DRAFT_MAX_ROUNDS}）`)
          throw new Error(`[draft_patch] 本会话轮次预算耗尽（${doc.rounds.length}/${GROWTH_DRAFT_MAX_ROUNDS} 轮）——不再接受追加；本批已有 ${doc.ops.length - doc.published} 条未发布增量：可 draft_audit 后 draft_finish 发布它们、draft_revert 撤掉卡住的增量，或取消本会话草稿重开一批（agent 工具 learnhub_coach_draft_cancel / 宿主 API POST /coach/draft/cancel）。`)
        }
        const rawOps = Array.isArray(args.ops) ? args.ops as Array<Record<string, unknown>> : []
        if (!rawOps.length) throw new Error('[draft_patch] ops 不能为空——不产结构就不要调本工具。')
        // 形状门「收下即归一」（#301 缺陷① / ADR-0088 §修订）：可修的形状当场归一为发布
        // 形态（回执注明归一动作、语料补标 tolerated），修不了的整批拒收回灌合法形态——
        // 毒形状永不随草稿过夜（此前原样入 doc.ops/doc.concepts，直到 finish 才在权威门炸）
        const shape = normalizePatchShape(rawOps, args.concepts)
        if (shape.errors.length) {
          await logRound('patch', `补丁被拒（形状不合法 ${shape.errors.length} 处；整批回滚）`, shape.errors)
          throw new Error(`[draft_patch] 形状未过（整批回滚，零落草稿）：\n${shape.errors.map(e => `  ✗ ${e}`).join('\n')}\n${PATCH_SHAPE_CHEATSHEET}`)
        }
        // 糖算子展开（#272 统一入口）：insert_prereq_chain / split_node → 原子 EditOp；
        // suggest_confusable → confusable 建议（不是图 op，finish 发布成功后展开为候选提案）
        const { nodes, graph } = await draftNodesOf()
        const { ops: expanded, confusables: suggestions } = expandPatchOps(shape.ops, nodes, graph, endpointNames(anchors))
        const unpublishedCount = doc.ops.length - doc.published + expanded.length
        if (unpublishedCount > GROWTH_DRAFT_MAX_OPS_PER_BATCH) {
          throw new Error(`[draft_patch] 每批未发布增量 ≤${GROWTH_DRAFT_MAX_OPS_PER_BATCH} 条（本补丁后将为 ${unpublishedCount}）——先 draft_finish 发布再开新批。`)
        }
        const mints = shape.concepts
        // 本补丁**将要**声明的 note 与铸名：试算必须按「补丁生效后的本批形态」跑——拿旧 note
        // 试算等于试算另一批（前进/换向的接线义务、note.recheck 的跨字段规则都挂在 note 上）。
        // 复诊预注册的写入面（#312 B2）：draft_patch 增 note_recheck。此前它没有任何写入面
        // （无参数、lite 型无字段、finish 也不透传），而受理门要求「operator=插入 且有
        // add_node」必须携带它、交接块还反向承诺「插入批落地时随批携带」——思路官一裁
        // 「插入」，执行官就没有任何合法写法能发布。校验先于任何变更（拒收即整批回滚）、
        // 且走与提案侧同一个 `recheckPreregOf`（取值域/未知键/clamp 同一份口径）。
        let declaredNote: EditProposalNoteLite | undefined
        if (typeof args.note_operator === 'string' && args.note_operator.trim()) {
          declaredNote = {
            operator: args.note_operator.trim(),
            reason: typeof args.note_reason === 'string' ? args.note_reason.trim() : '',
            ...(Array.isArray(args.note_target_endpoints) && args.note_target_endpoints.length
              ? { target_endpoints: (args.note_target_endpoints as unknown[]).map(String) }
              : {}),
          }
        }
        if (args.note_recheck !== undefined) {
          const v = recheckPreregOf(args.note_recheck)
          if (v.errors.length || !v.prereg) {
            await logRound('patch', `补丁被拒（note_recheck 未过预注册门；整批回滚）`, v.errors)
            throw new Error(`[draft_patch] note_recheck 未过复诊预注册门（与提案受理门同一套校验；拒收即整批回滚）：\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}\n合法取值域：metric ∈ ${RECHECK_METRICS.join('/')}；days 缺省 ${RECHECK_DAYS_DEFAULT}、clamp [${RECHECK_DAYS_MIN},${RECHECK_DAYS_MAX}]`)
          }
          const base = declaredNote ?? doc.note
          if (!base) {
            throw new Error('[draft_patch] note_recheck 随本批 note 携带——本次补丁缺 note_operator/note_reason、草稿里也还没有本批 note：复诊预注册是本批声明的字段，不是独立追加项。')
          }
          declaredNote = { ...base, recheck: v.prereg }
        }
        const declared: EditProposalNoteLite | undefined = declaredNote ?? doc.note
        const nextMints = mints.length ? [...doc.concepts, ...mints] : doc.concepts
        // 试算：**未发布段 + 本补丁**过完整门（schema 纯校验 + 门序列）才落草稿——#309 缺陷①：
        // 此前试算只跑 replayDraft（门的结构子集），`move` 这类非法 op 与 `初识` 这类非法档位
        // 一路落进草稿、直到 finish 才在 propose 的 schema 门炸，而那时 op 已无法清除（缺陷②）。
        const trial = [...unpublishedOf(), ...expanded]
        // 插入批的预注册若草稿侧没写，就地**落进 doc.note**（来源见 recheckOf：本轮的交接计划）：
        // 只靠 finish 时读当时的计划兜底，会让跨轮续建的批次被**后一轮**的计划换掉判据（甚至
        // 换没）。把它在补丁期固化，这一批的判据从此只由本批 note 决定。
        const planRecheck = declared && !declared.recheck ? recheckOf(declared, trial) : undefined
        const nextNote: EditProposalNoteLite | undefined = planRecheck && declared ? { ...declared, recheck: planRecheck } : declared
        const trialSpec = batchSpecOf(trial, { note: nextNote, concepts: nextMints })
        const { ctx: trialCtx } = await gateCtxOf({ nodes, graph }, nextMints)
        const trialErrors = (await editProposalGateErrors(trialSpec, trialCtx)).errors
        if (trialErrors.length) {
          await logRound('patch', `补丁被拒（${expanded.length} 条）`, trialErrors)
          throw new Error(`[draft_patch] 补丁未过受理门同一套校验（整批回滚，零草稿）：\n`
            + `${trialErrors.map(e => `  ✗ ${e}`).join('\n')}\n合法取值域：\n  · ${await domainsHint()}`)

        }
        doc.ops.push(...expanded)
        if (mints.length) doc.concepts.push(...mints)
        if (suggestions.length) doc.confusables = [...(doc.confusables ?? []), ...suggestions]
        if (nextNote !== doc.note) doc.note = nextNote
        await logRound('patch', `补丁 ${expanded.length} 条（未发布 ${doc.ops.length - doc.published}）${shape.normalized.length ? `；形状归一 ${shape.normalized.length} 处` : ''}`)
        // 归一命中 → 宿主给当次捕获补标 tolerated（此刻最近一条捕获就是本轮；批次结束后
        // 再补标只会落到最后一轮——#301 缺陷③ 同款的「标对件」纪律）
        if (shape.normalized.length) opts.onTolerated?.('patch_shape_normalized')
        const normLines = shape.normalized.length
          ? `\n形状归一 ${shape.normalized.length} 处（已按发布形态收下）：\n${shape.normalized.map(s => `  · ${s}`).join('\n')}`
          : ''
        return `已入草稿：本补丁 ${expanded.length} 条；未发布增量 ${doc.ops.length - doc.published} 条（水位 ${doc.published}/${doc.ops.length}）。${normLines}\n先 draft_audit 再 draft_finish。`
      }
      if (call.name === 'draft_audit') {
        // 空草稿 audit（#315 B4）：零未发布增量 = 本会话无事可做，不跑门、不报门错误——
        // 此前空草稿会吃到「ops: 提案没有操作条目」的门错误，模型要烧几十轮才明白该停。
        if (!unpublishedOf().length) {
          await logRound('audit', '审计：空草稿（零未发布增量）——无事可做')
          return '没有未发布增量——本会话无事可做（可直接收束：已发布段无需 audit/finish；要长新内容就 draft_patch 开新批）。'
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
        await logRound('audit', errors.length ? `审计：${errors.length} 个门错误` : findings.length ? `审计：通过（${findings.length} 条 findings）` : '审计：通过')
        if (errors.length) {
          return `审计未过（与受理门同一套校验，草稿通过 = 门通过）：\n${errors.map(e => `  ✗ ${e}`).join('\n')}`
            + `\n合法取值域：\n  · ${await domainsHint()}\n草稿差异：\n${renderDiff(diff)}`
        }
        return `审计通过（草稿通过 = 门通过）。草稿差异：\n${renderDiff(diff)}`
          + (findings.length ? `\n审计 findings（非阻 ${findings.length} 条；不拦 finish，该修的照修）：\n${findings.map(f => `  ⚠ ${f}`).join('\n')}` : '\n审计 findings：无')
          + (doc.ops.length - doc.published
            ? `\n未发布增量 ${doc.ops.length - doc.published} 条——可 draft_finish。`
            : '\n未发布增量 0 条——不可 finish，先用 draft_patch 补一批。')
      }
      if (call.name === 'draft_revert') {
        // 逃生口（#309 缺陷②）：草稿只能追加，被门拒的 op 永久卡在未发布段且每次 finish 重投
        // 都带着它（事故里 `ops[0..2]` 的非法档位与 `ops[11]` 的退役 op 因此不可清，模型的
        // del+add 重铸在原理上无效）——「模型永远有一步可走」的兜底就是这一具。
        const unpublished = unpublishedOf()
        if (!unpublished.length) {
          throw new Error('[draft_revert] 没有未发布增量可撤——已发布段（水位以下）不可动。')
        }
        const raw = args.count
        let count = unpublished.length
        if (raw !== undefined) {
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
            throw new Error(`[draft_revert] count 必须是正整数（省略 = 丢弃全部未发布增量；收到 ${JSON.stringify(raw)}）。`)
          }
          if (raw > unpublished.length) {
            throw new Error(`[draft_revert] count=${raw} 超过未发布增量 ${unpublished.length} 条（省略 count 即全部丢弃）。`)
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
        await logRound('revert', `撤销 ${dropped.length} 条未发布增量（余 ${unpublishedOf().length} 条）`)
        return `已撤销 ${dropped.length} 条未发布增量：${dropped.map(o => `${o.op}(${o.op === 'add_node' ? o.name : o.node})`).join('、')}。`
          + `\n水位 ${doc.published}/${doc.ops.length}；未发布增量 ${unpublishedOf().length} 条。`
          + (unpublishedOf().length ? `\n剩余未发布段重放：${residual.length ? `\n${residual.map(e => `  ✗ ${e}`).join('\n')}` : '通过（结构面）'}` : '')
          + (unpublishedOf().length ? '\n可继续 draft_patch 或 draft_audit。' : '\n本批已清空——用 draft_patch 重开一批。')
      }
      if (call.name === 'draft_finish') {
        const unpublished = unpublishedOf()
        const noteLite = doc.note
        if (!noteLite || !noteLite.operator || !noteLite.reason) {
          throw new Error('[draft_finish] 缺本批 note（operator/reason）——先用 draft_patch 的 note_operator/note_reason 声明本批算子与理由。')
        }
        if (!(GROWTH_OPERATORS as readonly string[]).includes(noteLite.operator)) {
          throw new Error(`[draft_finish] note.operator 非法：${noteLite.operator}（允许 ${GROWTH_OPERATORS.join('/')}）`)
        }
        // 提案形态由 batchSpecOf 单点装配（含本批生效的复诊预注册，见该函数）——试算/审计/
        // 发布三处喂给门的因此是同一份对象，不会出现「试算带上计划的 recheck、发布丢了它」。
        const spec: EditProposalSpec = batchSpecOf(unpublished)
        // 零增量 finish 无意义（空手结束由入口 fail loud 执法）
        if (!unpublished.length) {
          throw new Error('[draft_finish] 没有未发布增量——先 draft_patch 再 finish。')
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
          driftErrors = [`门复验内部异常（非门拒绝——本批 ops/概念块含引擎无法解析的字段形状）：${msg}\n${PATCH_SHAPE_CHEATSHEET}`]
        }
        if (driftErrors.length) {
          await logRound('finish', `finish 被拒（${driftErrors.length} 个门错误；零落盘）`, driftErrors)
          throw new Error(`[draft_finish] 门复验未过（拒收零落盘，草稿保留——修正后重试）：\n${driftErrors.map(e => `  ✗ ${e}`).join('\n')}`)
        }
        // 真实受理门 → apply（propose 自带 schema 门 + 全门序列；拒收零落盘）
        let prop: GraphEditProposalResult
        try {
          prop = await this.e.graphPropose('edit', YAML.stringify(spec)) as GraphEditProposalResult
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await logRound('finish', `propose 被拒（零落盘）`, [msg])
          throw new Error(`[draft_finish] 受理门拒收（零落盘，草稿保留）：\n${msg}`)
        }
        let applied: GraphApplyEditResult
        try {
          applied = await this.e.graphApply('edit', prop.id) as GraphApplyEditResult
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await this.e.graphReject(prop.id, `生长草稿 finish 自动 apply 失败：${msg}`)
            .catch(rejErr => this.rejectCompensateFail(prop.id, `生长草稿 finish 自动 apply 失败：${msg}`, rejErr))
          await logRound('finish', `apply 失败（提案 #${prop.id} 已自清）`, [msg])
          throw new Error(`[draft_finish] apply 失败（提案已拒绝清场，草稿保留）：\n${msg}`)
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
              evidence: [`生长批提案 #${prop.id} 铸名建议（${noteLite.operator}——${noteLite.reason}）`],
            })
            confusableLines.push(`confusable 候选提案 #${p.id}：「${p.a}」→「${p.b}」待人审`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            confusableLines.push(`confusable 建议未展开（「${s.concept}」↔「${s.with}」）：${msg.split('\n')[0]}`)
          }
        }
        doc.confusables = []
        const created = unpublished.filter(o => o.op === 'add_node').map(o => String(o.name ?? ''))
        finishes.push({
          proposal_id: prop.id, ops: unpublished.length, snapshot: applied.snapshot,
          operator: noteLite.operator, reason: noteLite.reason,
          target_endpoints: noteLite.target_endpoints ?? [], created,
        })
        await logRound('finish', `发布成功：提案 #${prop.id}，快照 v${applied.snapshot}，ops ${unpublished.length}${sealed.effects.length ? `；sealed：${sealed.effects.map(e => `${e.endpoint}=${e.action}`).join('、')}` : ''}${confusableLines.length ? `；${confusableLines.length} 条 confusable 建议` : ''}`)
        if (doc.published === doc.ops.length) await deleteDraft(this.e.fs, draftPath)
        return `发布成功：提案 #${prop.id} 已 apply（快照 v${applied.snapshot}）；水位前移至 ${doc.published}/${doc.ops.length}。${sealed.effects.length ? `收尾宣告：${sealed.effects.map(e => `${e.endpoint}=${e.action}`).join('、')}。` : ''}${confusableLines.length ? `\n${confusableLines.join('\n')}` : ''}`
      }
      throw new Error(`白名单外工具「${call.name}」被拒：执行官写件只有 draft_patch / draft_audit / draft_finish / draft_revert。`)
    }

    // —— 回路 ——
    const { graph, state } = await this.e.loadView(c)
    const anchors = await readAnchors(this.e.paths.anchorPath(root), this.e.fs)
    const view = renderGrowthGraphView(graph, state, endpointNames(anchors), { today, conceptEntries: await entriesOf() })
    const template = await this.e.content.loadPrompt('执行官回合')
    const pack = await this.coachContextPack(c.name, { today, packLabel: '执行官——草稿会话上下文' })
    const draftStatus = [
      `## 草稿状态（会话 ${doc.session_id}${resumed ? '，续建' : '，新建'}；水位 ${doc.published}/${doc.ops.length}）`, '',
      `- 未发布增量 ${doc.ops.length - doc.published} 条；铸名缓存 ${doc.concepts.length} 条`,
      ...(doc.note ? [`- 本批 note：${doc.note.operator}——${doc.note.reason}`] : []),
      ...(doc.rounds.length ? [`- 轮次日志（尾部 8 条）：`, ...doc.rounds.slice(-8).map(r => `  - [${r.kind}] ${r.summary}${r.errors ? `（✗ ${r.errors.length} 个错误）` : ''}`)] : []),
    ].join('\n')
    // 思路官交接块（#273）：方向裁决 advisory 随包——补丁纪律与门序列不因计划放松；
    // 零名字契约与计划同构：执行官仍须对草稿图逐字对表后才落 op。
    const handover = opts.plan ? [
      '## 思路官交接（方向裁决——advisory，不是补丁）', '',
      `- 算子：${opts.plan.operator}；朝向：${opts.plan.target_endpoints.join('、') || '（未声明）'}`,
      `- 理由：${opts.plan.reason}`,
      ...opts.plan.steps.map((s, i) => `- 台阶 ${i + 1}：${s.intent}${s.teaches_concept ? `（概念面：${s.teaches_concept}）` : ''}${s.est_hint ? `（约 ${s.est_hint} 分钟）` : ''}`),
      ...(opts.plan.recheck ? [`- 预注册复诊：${opts.plan.recheck.metric}（${opts.plan.recheck.days ?? RECHECK_DAYS_DEFAULT} 学习日）——插入批随批携带：用 draft_patch 的 note_recheck 写这一枚（metrics 取值域见该参数说明；草稿侧缺席时按本计划兜底）。`] : []),
      // 罗盘路线（#310）：让执行官看得见「本批还会改写罗盘」，但不给它活干——写入由引擎
      // 从本计划取（batchSpecOf），执行官零 op。缺省（route 未携带）= 不改写、保留旧稿。
      ...(opts.plan.route !== undefined ? ['- 罗盘路线：「剩余路线」段本次随批重画（正文由引擎从本计划携带写入，你无需为它写任何 op）；路线是草图不是承诺。'] : []),
      '',
      '计划是方向不是操作：节点名与补丁仍须你对草稿图逐字对表后用 draft_patch 落地；与图面事实冲突时以图面为准，偏离计划时在 note_reason 里说一句。',
    ].join('\n') : undefined
    const prompt = withContractLast(template, [pack, view, draftStatus, handover]
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
            await logRound(kind, `${DRAFT_ROUND_CRASH_LABEL[kind]}（${(msg.split('\n')[0] ?? '').slice(0, DRAFT_ROUND_HEAD_LIMIT)}）`, [msg])
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
        ? `[coach-draft] 轮次预算已耗尽（${doc.rounds.length}/${GROWTH_DRAFT_MAX_ROUNDS} 轮）、本批仍有 ${doc.ops.length - doc.published} 条未发布增量未发布成功——真出口：修好门错误后 finish、draft_revert 撤掉卡住的增量重开一批，或取消本会话草稿（agent 工具 learnhub_coach_draft_cancel / 宿主 API POST /coach/draft/cancel）。`
        : `[coach-draft] 回路收束但草稿仍有 ${doc.ops.length - doc.published} 条未发布增量且未成功 finish（禁止空手结束）——草稿已保留（会话 ${doc.session_id}），续建或显式取消（agent 工具 learnhub_coach_draft_cancel / 宿主 API POST /coach/draft/cancel）。`)
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
   * 插入/旁支生效——三率超限或复诊通过率触底时闸停（低数据静默），普通 edit 提案与
   * 结算自动提案（无 note）恒放行。插入积极性调速器，参数唯一出处 params.ts。 */
  async growthGateErrors(spec: EditProposalSpec): Promise<string[]> {
    if (!spec.note || (spec.note.operator !== '插入' && spec.note.operator !== '旁支')) return []
    const adds = addNodeCountOf(spec.ops)
    if (!adds) return []
    const c = await this.e.registry.get(spec.course)
    if (!c) return []
    const { today, cutoff } = await this.e.learningDay()
    const { rates } = await this.probationFrame(c, today, cutoff)
    return growthGate(rates, { operator: spec.note.operator, adds }).blocks
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
   * 从 artifact 读 note.operator 与 add_node 数（账本只持有插入，前进/旁支出材从提案
   * 留痕折叠）。artifact 缺失/损坏的批次不计入（留痕缺失是审计问题，不炸读侧）。 */
  private async growthTallies(proposals: ProposalRec[], cutoff: number): Promise<GrowthBatchTally[]> {
    const tallies: GrowthBatchTally[] = []
    for (const p of proposals) {
      if (p.kind !== 'edit' || p.status !== 'applied' || !p.decided) continue
      if (!p.summary.startsWith('生长批（')) continue
      try {
        const doc = YAML.parse(await this.e.fs.readFile(this.e.paths.proposalArtifactPath(p.id, 'edit', p.course))) as {
          note?: { operator?: unknown }
          ops?: Array<{ op?: unknown }>
        }
        const operator = typeof doc.note?.operator === 'string' ? doc.note.operator : ''
        const added = addNodeCountOf(doc.ops)
        if (!operator || !added) continue
        tallies.push({ operator, added, day: dayOfTs(p.decided, cutoff) })
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


  /** 从提案 artifact 回读预注册 metric（账本只存 proposal id 的对账；缺失返回 null）。 */
  private async recheckMetricOf(_c: CourseEntry, proposals: ProposalRec[], entry: ProbationEntry): Promise<RecheckMetric | null> {
    const rec = proposals.find(p => p.id === entry.proposal)
    if (!rec) return null
    try {
      const doc = YAML.parse(await this.e.fs.readFile(this.e.paths.proposalArtifactPath(entry.proposal, 'edit', rec.course))) as {
        note?: { recheck?: { metric?: unknown } }
      }
      const metric = doc.note?.recheck?.metric
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
      reason: `复诊未达标自动剪除（#146）：插入节点「${node}」未过预注册复诊（${metric}：${detail}）——恢复原粗边并归档`,
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
    const entries = await this.e.concepts.load(c.root)
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
