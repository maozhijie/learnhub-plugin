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

import type { VaultFs } from './io.ts'
import type { Store } from './store.ts'
import type { Paths } from './paths.ts'
import type { Registry } from './registry.ts'
import type { ConceptRegistry } from './concepts.ts'
import type { Content } from './content.ts'
import type { BankDoc } from './question-bank.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { Fm, CourseEntry, ProposalRec } from './types.ts'
import type { FSRS } from 'ts-fsrs'
import type { CoachCheck } from './coach-round.ts'
import type { CompassEta } from './compass.ts'
import type { GraphApplyResult } from './views/graph.ts'
import type { GraphProposeResult } from './views/proposals.ts'
import type { EditProposalSpec, GrowthNote } from './proposals.ts'
import type { SedimentFold } from './sediment.ts'
import type { SandboxCard, SandboxCurvePoint, SandboxNode, SandboxPlan } from './sandbox.ts'
import type { ProbationCourseView, ProbationEntry, ProbationFold, ProbationOutcome, RecheckMetric, GrowthBatchTally } from './probation.ts'

/** Growth 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */
export interface GrowthDeps {
  /** 时钟端口（#175 阶段①）：复诊结算 decidedAt 戳。 */
  clock: Clock
  /** vault 存储端口（#175 阶段②）。 */
  fs: VaultFs
  store: Store
  paths: Paths
  registry: Registry
  concepts: ConceptRegistry
  content: Content
  /** 罗盘 ETA 折叠记忆（同一学习日同锚复用）。 */
  enabledCourses(): Promise<CourseEntry[]>
  graphApply(kind: 'edit' | 'seed' | 'enrich', pid?: number): Promise<GraphApplyResult>
  graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult>
  graphReject(pid: number, note?: string): Promise<ProposalRec>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  mcAggregate(plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string, scheds: Map<string, FSRS>, fallbackCourse: string): { curve: SandboxCurvePoint[]; map: Array<{ node: string; p50: number; p80: number }> }
  sandboxPopulation(courses: CourseEntry[], nodeFilter: Set<string> | null): Promise<{ cards: SandboxCard[]; nodes: SandboxNode[]; scheds: Map<string, FSRS> }>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  sedimentFold(): Promise<SedimentFold>
  sedimentRebuildProfile(): Promise<string>
}
import { effectiveStage } from './audit.ts'
import type { CoachGrowthSegment, CoachTrigger } from './coach-round.ts'
import { arbitrationPopulations, behaviorDigest, readyDepthCheck, renderArbitrationEvidence, renderBehaviorDigest, renderSedimentForCoach } from './coach-round.ts'
import type { CompassEtaProbe } from './compass.ts'
import { COMPASS_ETA_PROBE_WEEKS, ETA_PENDING, ROUTE_PENDING, SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, compassPaintContext, compassScaffold, etaMarkerOf, hasLearnerAnnotations, parseCompass, renderEtaBody, sectionBody, stripWrappingFence, validateRouteBody, withSectionText } from './compass.ts'
import { resolveConcept } from './concepts.ts'
import { dayOfTs, nowIsoOf, weekStartOf } from './dates.ts'
import type { Clock } from './clock.ts'
import { netPracticeRecs } from './grading.ts'
import { atomicWrite } from './io.ts'
import type { JolPrediction } from './jol.ts'
import { JOL_PREDICTIONS } from './jol.ts'
import type { AgentSeam, GateVerdict } from './agent.ts'
import { hasReadyContent } from './notes.ts'
import { appendProbationEntry, foldProbation, growthGate, growthRates, learningDaysOf, readProbationLedger, recheckDue, recheckVerdict } from './probation.ts'
import { addNodeCountOf, validateEditProposal } from './proposals.ts'
import { SANDBOX_DEFAULT_WEEKS, SANDBOX_WORDING } from './sandbox.ts'
import { appendSedimentEvent } from './sediment.ts'
import { runWriteUnit } from './write-unit.ts'
import { COMPLETION_MASTERY_THRESHOLD, readAnchor } from './seed.ts'
import { readySet } from './sessions.ts'
import { masteryOfFm } from './srs.ts'
import type { ConceptTier } from './types.ts'
import { CONCEPT_TIERS } from './types.ts'
import type { GraphApplyEditResult } from './views/graph.ts'
import type { GraphEditProposalResult } from './views/proposals.ts'
import { readDailyGoal } from './xp.ts'
import { YAML } from './yaml.ts'
export class GrowthSubsystem {
  constructor(private e: GrowthDeps) {}

// ---- 门面原分节：compass ----
// ---- 门面原分节：coach ----
// ---- 门面原分节：growth ----
// ---- 门面原分节：recheck ----


  /** 读罗盘（learnhub_compass / 教练上下文消费）：文件 Missing = null（合法空态——
   * 未播种或未落盘）；终点锚随行携带（coach 的目标视野），锚 Broken fail loud
   * （承诺物损坏必须显式浮出，不静默折成未播种）。 */
  async compassRead(courseKey?: string): Promise<{
    course: string
    path: string
    endpoint: string | null
    goal_type: 'capability' | 'coverage' | null
    missing: boolean
    route: string | null
    annotations: string | null
    eta: string | null
    eta_week: string | null
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const path = this.e.paths.compassPath(c.root)
    const anchor = await readAnchor(this.e.paths.anchorPath(c.root), this.e.fs)
    if (!this.e.fs.exists(path)) {
      return {
        course: c.name, path,
        endpoint: anchor?.endpoint ?? null, goal_type: anchor?.goal_type ?? null,
        missing: true, route: null, annotations: null, eta: null, eta_week: null,
      }
    }
    const doc = parseCompass(await this.e.fs.readFile(path))
    const eta = sectionBody(doc, SECTION_ETA)
    return {
      course: c.name, path,
      endpoint: anchor?.endpoint ?? null, goal_type: anchor?.goal_type ?? null,
      missing: false,
      route: sectionBody(doc, SECTION_ROUTE),
      annotations: sectionBody(doc, SECTION_ANNOTATIONS),
      eta,
      eta_week: etaMarkerOf(eta),
    }
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


  /** 罗盘初画/重画（learnhub_compass_paint；「罗盘初画」模板 v1，deep 档一次调用）：
   * 终点锚缺失 fail loud（初画锚在终点上）；路线门（非空/无标题/限长）首过即落盘——
   * 只重写「剩余路线」段，批注区字节保留，ETA 重置待刷新（旧带是旧结构的推演）。
   * 金样本回放闸：调用数恒 1、无修复轮（首过率对照在测试锚定）。调用经统一 agent 缝
   * （#162：剥围栏/语义档/调用日志在缝里内建）。 */
  async compassPaint(courseKey: string | undefined, agent: AgentSeam): Promise<{
    course: string; path: string; route_lines: number; annotations_preserved: boolean; repainted: boolean
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const root = c.root
    const anchor = await readAnchor(this.e.paths.anchorPath(root), this.e.fs)
    if (!anchor) {
      throw new Error(`[compass] 课程「${c.name}」未播种（终点锚 Missing）——罗盘初画锚在终点上，先走种子提案（kind=seed）。`)
    }
    const { graph } = await this.e.loadView(c)
    const path = this.e.paths.compassPath(root)
    const existing = this.e.fs.exists(path) ? await this.e.fs.readFile(path) : null
    const doc = existing ? parseCompass(existing) : null
    const annotations = hasLearnerAnnotations(doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null)
      ? sectionBody(doc!, SECTION_ANNOTATIONS)
      : null
    const template = await this.e.content.loadPrompt('罗盘初画')
    const prompt = template + compassPaintContext({
      courseName: c.name,
      anchor,
      starts: anchor.seed_nodes.filter(n => n !== anchor.endpoint).map(n => ({
        name: n,
        note: graph.noteOf[n] ?? '',
      })),
      graphNames: graph.names,
      annotations,
    })
    const raw = await agent.complete('罗盘', prompt, { effort: 'deep' })
    const body = stripWrappingFence(raw)
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
    }
  }


  /** 罗盘重写——「剩余路线」的唯一写权接口（词条「罗盘」；调用方 = 生长批受理票 #145，
   * 在图 apply 的写入单元内、journal 由调用方挂提案 id，此处零 journal）：批注区与 ETA 字节
   * 保留；学习者手编的路线在下一次重写处被覆盖——手编不产生权威变更。路线门同初画。 */
  async compassRewrite(
    courseKey: string, routeMd: string,
  ): Promise<{ course: string; path: string; route_lines: number }> {
    const c = await this.e.registry.resolve(courseKey)
    const anchor = await readAnchor(this.e.paths.anchorPath(c.root), this.e.fs)
    if (!anchor) {
      throw new Error(`[compass] 课程「${c.name}」未播种（终点锚 Missing）——罗盘重写锚在终点上，先走种子提案（kind=seed）。`)
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
   * 逐启用课程——未播种跳过、罗盘缺席先落脚手架、当前周已挂 current、否则探测带
   * 折叠后重写「沙盘 ETA」段（措辞锁死「模型推演，非承诺」）。透明度装置：单课失败
   * 不挡其他课，更不挡周复盘。折叠每课都算（周频成本，同周进程内走备忘）：结果随行
   * 携带 eta——周复盘现状区的 ETA 旁挂（#150）取同一份数据，不二次蒙特卡洛。 */
  async compassEtaRefresh(
    courseKey?: string, opts: { today?: string; force?: boolean } = {},
  ): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta }>> {
    const { today: learningToday } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const weekStart = weekStartOf(today)
    if (!weekStart) throw new Error(`[compass] today 不是合法日期：${String(today)}`)
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta }> = []
    for (const c of courses) {
      try {
        const anchor = await readAnchor(this.e.paths.anchorPath(c.root), this.e.fs)
        if (!anchor) {
          out.push({ course: c.name, state: 'skipped', detail: '未播种（终点锚 Missing）' })
          continue
        }
        const path = this.e.paths.compassPath(c.root)
        const existing = this.e.fs.exists(path) ? await this.e.fs.readFile(path) : compassScaffold(c.name)
        const memoed = this.etaMemo.get(c.name)
        const eta = !opts.force && memoed?.week === weekStart
          ? memoed.eta
          : await this.compassEtaFold(c, anchor, today, weekStart)
        this.etaMemo.set(c.name, { week: weekStart, eta })
        if (!opts.force && etaMarkerOf(sectionBody(parseCompass(existing), SECTION_ETA)) === weekStart) {
          out.push({ course: c.name, state: 'current', eta })
          continue
        }
        await atomicWrite(path, withSectionText(existing, SECTION_ETA, renderEtaBody(eta)), this.e.fs)
        out.push({ course: c.name, state: 'refreshed', eta })
      } catch (err) {
        out.push({ course: c.name, state: 'skipped', detail: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }


  /** 沙盘 ETA 折叠（罗盘 weekly；读侧即算即用，落盘的只有渲染段）：按每日 XP 目标
   * 分钟数取探测地平线逐档跑沙盘，读终点掌握度的 p50/p80 分位带；两口径首次越阈的
   * 档 = 「还要多久」的诚实参照（阈值与完成判据同一常量）。 */
  private async compassEtaFold(
    c: CourseEntry, anchor: { endpoint: string }, today: string, weekStart: string,
  ): Promise<CompassEta> {
    const minutesPerDay = await readDailyGoal(this.e.paths, this.e.fs)
    const { cards, nodes, scheds } = await this.e.sandboxPopulation([c], null)
    const endpointKey = `${c.name}/${anchor.endpoint}`
    const probes: CompassEtaProbe[] = []
    let p50Week: CompassEta['p50_week'] = null
    let p80Week: CompassEta['p80_week'] = null
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
    return {
      week_start: weekStart,
      minutes_per_day: minutesPerDay,
      endpoint: anchor.endpoint,
      threshold: COMPLETION_MASTERY_THRESHOLD,
      probes,
      p50_week: p50Week,
      p80_week: p80Week,
      wording: SANDBOX_WORDING,
    }
  }

  /** 就绪前沿：未开始（非 opt 前置全部达成）的节点——R 软闸不改变可学性，故不带门。 */
  private coachFrontier(graph: Graph, state: Record<string, Fm>): string[] {
    return readySet(graph, state, () => 1)
  }


  /** 单课程就绪深度检查（coachCheckpoint 与 statusJson 共用核）：终点锚缺失 = 未播种
   * （不判冷启动，合法空态）；锚 Broken fail loud（与 courseCompletion 同口径）。
   * 就绪存量与前瞻需求都不计终点（词条「前瞻深度」：终点是锚点不是课程节点）——
   * 课程尾段前沿只剩终点时判据永不可满足会让教练永不停摆；除终点外前沿清空 =
   * exhausted，判据自然通过、零告警。 */
  async coachCheckFor(c: CourseEntry, today: string): Promise<CoachCheck> {
    const { graph, state } = await this.e.loadView(c)
    const anchor = await readAnchor(this.e.paths.anchorPath(c.root), this.e.fs)
    const endpoint = anchor?.endpoint ?? null
    const live = this.coachFrontier(graph, state).filter(n => n !== endpoint)
    return {
      course: c.name,
      ...readyDepthCheck({
        ready: live.filter(n => hasReadyContent(state[n])).length,
        declared: anchor?.declared ?? null,
        today,
        exhausted: anchor !== null && live.length === 0,
      }),
    }
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
   * 归受理票 #145，入队阻尼语义归宿主）；ready=0 只告警，生长永不挡当前学习动作
   * （FIFO 不插队靠检查点前置：自动拉批只在检查点之后入队，不越过任何已排队任务）。 */
  async coachCheckpoint(
    trigger: CoachTrigger, courseKey?: string, opts: { today?: string } = {},
  ): Promise<{ trigger: CoachTrigger; courses: CoachCheck[] }> {
    const { today: learningToday } = await this.e.learningDay()
    const today = opts.today ?? learningToday
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const out: CoachCheck[] = []
    for (const c of courses) out.push(await this.coachCheckFor(c, today))
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
    const anchor = await readAnchor(this.e.paths.anchorPath(c.root), this.e.fs)
    const active = [...this.coachFrontier(graph, state), ...graph.names.filter(n => effectiveStage(state, n) === 'learning')]

    const out: string[] = [
      `# 教练回合上下文包：${c.name}（${opts.packLabel ?? (lightweight ? '轻量段——只带行为摘要与罗盘' : '全量六区块')}）`,
    ]
    const block = (title: string, body: string): void => {
      out.push('', `## ${title}`, '', body)
    }

    if (!lightweight) {
      // ① 终点锚（课程唯一结构承诺物——教练回合的目标视野）
      if (anchor) {
        const lines = [
          `- 终点节点：${anchor.endpoint}`,
          `- 目标类型：${anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定（完成=块工作表+终点）' : 'capability 能力锚定（完成=终点掌握）'}`,
          `- 声明日期：${anchor.declared}`,
        ]
        if (anchor.worksheet.length) {
          lines.push(`- 块工作表：${anchor.worksheet.filter(w => w.done).length}/${anchor.worksheet.length} 已核销`)
        }
        block('终点锚', lines.join('\n'))
      } else {
        block('终点锚', '（未播种——终点锚 Missing 是合法空态，但教练回合无从锚定目标；先走种子提案 kind=seed。）')
      }
    }

    // ② 行为摘要五件套（读侧折叠即算即用；轻量包两件之一）
    const entries = await this.e.concepts.load(c.root)
    const invokesOfQ = await this.invokesResolver(c)
    const masteryOf: Record<string, number> = {}
    for (const n of graph.names) masteryOf[n] = masteryOfFm(state[n])
    const digest = behaviorDigest({
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
    block('行为摘要（窗=最近 7 学习日或 10 节取大；即算即用不落盘）', renderBehaviorDigest(digest))

    if (!lightweight) {
      // ③ 登记表档位（前沿视野 = 可学 ∪ 在学节点的概念档位折叠；同概念取最高档）
      const tierRank = (t: ConceptTier): number => CONCEPT_TIERS.indexOf(t)
      const foldTiers = (pick: (n: string) => Record<string, ConceptTier> | undefined): Array<[string, ConceptTier]> => {
        const best = new Map<string, ConceptTier>()
        for (const n of active) {
          for (const [concept, tier] of Object.entries(pick(n) ?? {})) {
            const cur = best.get(concept)
            if (!cur || tierRank(tier) > tierRank(cur)) best.set(concept, tier)
          }
        }
        return [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      }
      const fmtTiers = (xs: Array<[string, ConceptTier]>): string => xs.map(([k, t]) => `${k} ${t}`).join('、')
      const teaches = foldTiers(n => graph.teachesOf[n])
      const assumes = foldTiers(n => graph.assumesOf[n])
      block('登记表档位（前沿概念的教学档位视野）', [
        `- 概念登记表：${entries.length ? `${entries.length} 条在册` : 'Missing（合法空态——铸名随生长批提案落盘）'}`,
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
    const parts = ['### 罗盘', '', tail || '（罗盘缺席或尚无已画路线——合法空态：未播种/未初画时教练无从读路线。）']
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

  /** 图面全名单的预览上限（防生长后教练上下文失控）。比罗盘初画的 GRAPH_NAMES_PREVIEW
   * (80) 宽：初画只需路标感，教练裁决的 pre 引用必须逐字命中既有节点名，名单截断会
   * 直接造成受理门断边拒收——上限只防膨胀，不服务取值域完整性时才收紧。 */
  private static readonly GROWTH_GRAPH_NAMES_CAP = 200

  /** 图面（教练回合装配的第三块，两段共用）：结构事实源——裁决 ops 的节点名与 pre
   * 引用的取值域。前沿与在学节点给细节行（区·块/pre/teaches/est/正文态），其余节点
   * 给全名单（供 set_pre 等引用既有节点）。纯组装零写副作用。 */
  private growthGraphView(graph: Graph, state: Record<string, Fm>): string {
    const active = [...new Set([
      ...this.coachFrontier(graph, state),
      ...graph.names.filter(n => effectiveStage(state, n) === 'learning'),
    ])].sort()
    const activeSet = new Set(active)
    const stageLabel = (n: string): string => {
      const s = effectiveStage(state, n)
      if (s === 'learning') return '在学'
      if (s === 'mastered') return '已掌握'
      if (s === 'review') return '复习中'
      return hasReadyContent(state[n]) ? '未开始·正文已生成' : '未开始·待生成'
    }
    const lines: string[] = [
      '## 当前图面（结构事实源——ops 的节点名与 pre 引用必须逐字来自这里）', '',
      `- 节点共 ${graph.names.length} 个；前沿与在学 ${active.length} 个（带细节行）`,
      '', '### 前沿与在学节点', '',
    ]
    for (const n of active) {
      const [, region, block] = graph.blockOf[n]
      const pres = graph.preOf[n]
      const teaches = Object.entries(graph.teachesOf[n] ?? {}).map(([c, t]) => `${c} ${t}`)
      const est = graph.estOf[n]
      lines.push(`- ${n}（${region}·${block}｜${stageLabel(n)}${est ? `｜est ${est}′` : ''}）`
        + `｜pre: ${pres.length ? pres.join('、') : '（根）'}`
        + (teaches.length ? `｜teaches: ${teaches.join('、')}` : ''))
    }
    const rest = graph.names.filter(n => !activeSet.has(n)).sort()
    if (rest.length) {
      const shown = rest.slice(0, GrowthSubsystem.GROWTH_GRAPH_NAMES_CAP)
      lines.push('', `### 其余节点（全部名单，供 pre 引用；共 ${rest.length} 个）`, '',
        shown.join('、') + (rest.length > shown.length ? `……（超出预览上限 ${GrowthSubsystem.GROWTH_GRAPH_NAMES_CAP}，余 ${rest.length - shown.length} 个）` : ''))
    }
    return lines.join('\n') + '\n'
  }


  /** 裁决产物解析（纯函数语义：零写盘、失败零副作用）：剥围栏 → edit 提案 schema 门
   * （复用 validateEditProposal——生长批与 agent 手写提案同门）→ 生长批必须有 note 区
   * （算子标签+理由；分歧声明可选）。 */
  private parseGrowthVerdict(raw: string): { spec: EditProposalSpec; yaml: string; note: GrowthNote } {
    const yaml = stripWrappingFence(raw)
    const v = validateEditProposal(YAML.parseModel(yaml))
    if (v.errors || !v.spec) {
      throw new Error(`[coach-growth] 教练回合裁决未过 schema 门（零写盘）。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    }
    if (!v.spec.note) {
      throw new Error('[coach-growth] 教练回合裁决缺 note 区——生长批必须携带算子标签与理由（note.operator/note.reason）。')
    }
    return { spec: v.spec, yaml, note: v.spec.note }
  }


  /** 生长批受理（#145/#150 裁决产物面）：三段式教练回合——轻量段（fast 档：行为摘要
   * +罗盘+图面）先裁；note.disagreement 声明真分歧时升级全量段（deep 档：六区块包+图面）
   * 重裁；全量段仍声明真分歧时升级双沙盘仲裁段（deep 档：六区块包+图面+两份沙盘推演
   * 参照——现状照走 vs 含本批照走，同种子配对、零写侧、措辞照旧「模型推演，非承诺」），
   * 仲裁段结论为终审。显然步免仲裁税，升级路径随 segments 可观测。最终裁决照 kind=edit
   * 既有受理门（schema/结构/概念对表/锚保护/巩固门）propose→apply：罗盘重写与图 apply
   * 写入单元纪律（提案被拒罗盘不落盘）、journal 挂提案 id、不新增提案 kind。
   * 停机转译：就绪深度满足（check.ok）时不拉回合直接停摆——判据满足的自然结果，不是
   * 新状态（force 供测试/手动排障越过）。opts.inject = 里程碑计划修订的换线/补支注入
   * （#149 项目消费拉动的生长请求）：注入块随包进回合，且注入本身是显式的重新裁决
   * 请求——check.ok 不再短路停摆（裁决仍可能产出零操作批）。裁决语义在提示词；本
   * 方法只保证组装、schema 与写入单元纪律。金样本回放闸锚调用数基线：显然步恒 1 次、
   * 分歧升级恒 2 次、双沙盘仲裁恒 3 次（沙盘推演是读侧计算，不计调用数）；
   * 受理门拒收加回灌重裁段恰 +1 次（#157）。各段调用经统一 agent 缝（#162：单发走
   * complete、回灌重裁走 repair，语义档与调用日志沿缝贯通可观测）。 */
  async coachGrowthBatch(
    courseKey: string, agent: AgentSeam,
    opts: { force?: boolean; today?: string; inject?: string } = {},
  ): Promise<{
    course: string
    state: 'idle' | 'applied'
    check: CoachCheck
    segments: CoachGrowthSegment[]
    proposal: { id: number; ops: number; operator: string; reason: string; disagreement: boolean } | null
    applied: { ops: number; snapshot: number; compass_rewritten: boolean; created: string[]; ready_unbuilt: string[] } | null
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const anchor = await readAnchor(this.e.paths.anchorPath(c.root), this.e.fs)
    if (!anchor) {
      throw new Error(`[coach-growth] 课程「${c.name}」未播种（终点锚 Missing）——教练回合锚在终点上，先走种子提案（kind=seed）。`)
    }
    const today = opts.today ?? (await this.e.learningDay()).today
    const check = await this.coachCheckFor(c, today)
    if (check.ok && !opts.force && opts.inject === undefined) {
      return { course: c.name, state: 'idle', check, segments: [], proposal: null, applied: null }
    }
    const { graph, state } = await this.e.loadView(c)
    const view = this.growthGraphView(graph, state)
    const template = await this.e.content.loadPrompt('教练回合')
    const segments: CoachGrowthSegment[] = []
    type GrowthVerdict = { spec: EditProposalSpec; yaml: string; note: GrowthNote }
    const runSegment = async (tier: 'light' | 'full'): Promise<GrowthVerdict> => {
      const pack = await this.coachContextPack(c.name, { lightweight: tier === 'light', today })
      const prompt = `${template.trimEnd()}\n\n---\n\n${pack.trimEnd()}`
        + (opts.inject !== undefined ? `\n\n---\n\n## 里程碑计划修订注入（项目消费拉动的生长请求）\n\n${opts.inject.trimEnd()}\n\n换线 = 激活图上已有节点（内容生成/接入路线），补支 = 朝新里程碑长最小必要分支；你的裁决仍走五算子与既定纪律，判断注入与就绪深度后照常产出（含零操作批）。` : '')
        + `\n\n---\n\n${view.trimEnd()}\n`
      const raw = await agent.complete('教练生长', prompt, { effort: tier === 'light' ? 'fast' : 'deep' })
      const verdict = this.parseGrowthVerdict(raw)
      segments.push({ tier, effort: tier === 'light' ? 'fast' : 'deep', operator: verdict.note.operator, disagreement: Boolean(verdict.note.disagreement) })
      return verdict
    }
    // 双沙盘仲裁段（#150）：现状照走 vs 含本批候选节点照走——同种子配对推演（读侧
    // 计算，零写侧），两份分位带并排进终审 prompt；终审结论即最终裁决，不再升级。
    const runArbitration = async (contested: { spec: EditProposalSpec; note: GrowthNote }): Promise<GrowthVerdict> => {
      const added = contested.spec.ops
        .filter(o => o.op === 'add_node' && o.name)
        .map(o => ({ name: o.name!, est: o.est }))
      const minutesPerDay = await readDailyGoal(this.e.paths, this.e.fs)
      const { cards, nodes, scheds } = await this.e.sandboxPopulation([c], null)
      const pops = arbitrationPopulations(nodes, cards, added, c.name)
      const plan: SandboxPlan = { minutesPerDay, weeks: SANDBOX_DEFAULT_WEEKS }
      const curves = (pop: { nodes: SandboxNode[]; cards: SandboxCard[] }): SandboxCurvePoint[] =>
        this.e.mcAggregate(plan, pop.cards, pop.nodes, today, scheds, c.name).curve
      const evidence = renderArbitrationEvidence({
        disagreement: typeof contested.note.disagreement === 'string' ? contested.note.disagreement : '',
        minutes_per_day: minutesPerDay,
        weeks: plan.weeks,
        added: added.map(a => a.name),
        before: curves(pops.before),
        after: curves(pops.after),
      })
      const pack = await this.coachContextPack(c.name, { today, packLabel: '仲裁段——全量包+双沙盘推演参照' })
      const prompt = `${template.trimEnd()}\n\n---\n\n${pack.trimEnd()}\n\n---\n\n${view.trimEnd()}\n\n---\n\n${evidence.trimEnd()}\n`
      const raw = await agent.complete('教练生长', prompt, { effort: 'deep' })
      const verdict = this.parseGrowthVerdict(raw)
      segments.push({ tier: 'arbitration', effort: 'deep', operator: verdict.note.operator, disagreement: Boolean(verdict.note.disagreement) })
      return verdict
    }

    // 回灌重裁段（#157）：受理门拒收后的修复轮——拒绝原因原文 + 被拒裁决原文随全量包
    // 与图面回灌，deep 档重裁一次；重裁结论即终审（分歧声明只作可观测留痕，不再升级
    // 仲裁段——重裁本身已是加深的一轮，「恰一轮」封顶防重试风暴）。
    const runRepair = async (feedback: string, previousYaml: string): Promise<GrowthVerdict> => {
      const pack = await this.coachContextPack(c.name, { today, packLabel: '回灌重裁段——上一版裁决被受理门拒收' })
      const prompt = `${template.trimEnd()}\n\n---\n\n${pack.trimEnd()}\n\n---\n\n${view.trimEnd()}\n\n---\n\n`
        + `## 受理门反馈（上一版裁决未过受理门——被拒批次零落盘，图未改动）\n\n${feedback.trim()}\n\n`
        + `上一版裁决原文：\n\n\`\`\`yaml\n${previousYaml.trim()}\n\`\`\`\n\n`
        + `请对照拒绝原因逐条修正后，按模板重新产出完整裁决（course + note + route + ops）：`
        + `区/块与节点名、pre 引用必须逐字来自上方图面，概念必须已在登记表或本批 concepts 铸名。`
      const raw = await agent.repair('教练生长', prompt, { effort: 'deep' })
      const verdict = this.parseGrowthVerdict(raw)
      segments.push({ tier: 'repair', effort: 'deep', operator: verdict.note.operator, disagreement: Boolean(verdict.note.disagreement) })
      return verdict
    }

    // 回灌止血（#157 的轮形态随缝收口为共享能力，#162）：受理门拒收 = 教练一次产出
    // 畸形（引用不存在的区、概念未铸名、pre 引用不存在的节点…），门错误回灌教练重裁
    // 恰一次（缝的 gateRepairRound；修复轮任何失败带两轮死因抛出）。propose 是受理式
    // 门：过门即落 pending 提案，产物经 GateVerdict.result 随行交还。只包 propose 侧的
    // 门（结构/概念对表/锚保护/巩固门/生长闸门/路线门）；schema 门在 parseGrowthVerdict
    // 已先行（模板钉死产物形状，畸形率低）。
    // apply 失败是竞态非畸形，沿用下方「自清后原样抛错」不重裁。
    const fmt = (e: unknown): string => e instanceof Error ? e.message : String(e)
    const round = await agent.gateRepairRound<GrowthVerdict, GraphEditProposalResult>('教练生长', {
      first: async () => {
        let verdict = await runSegment('light')
        if (verdict.note.disagreement) {
          verdict = await runSegment('full')
          if (verdict.note.disagreement) verdict = await runArbitration(verdict)
        }
        return verdict
      },
      gate: async (verdict): Promise<GateVerdict<GraphEditProposalResult>> => {
        try {
          const prop = await this.e.graphPropose('edit', verdict.yaml) as GraphEditProposalResult
          return { errors: [], result: prop }
        } catch (err) {
          return { errors: [fmt(err)] }
        }
      },
      repair: (gateErrors, rejected) => runRepair(gateErrors.join('\n'), rejected.yaml),
      fatal: (firstErrors, repairDeath) => new Error(
        `[coach-growth] 生长批受理门拒收（回灌重裁一轮仍未通过——零落盘）。\n【首轮】${firstErrors.join('\n')}\n【重裁】${repairDeath.join('\n')}`),
    })
    const final = round.candidate
    const prop = round.result
    let applied: GraphApplyEditResult
    try {
      applied = await this.e.graphApply('edit', prop.id) as GraphApplyEditResult
    } catch (err) {
      // 受理过门但 apply 失败（审计 ERROR/图已变化等竞态）：机器裁决不留 pending——
      // 自清后原样抛错（教练回合是每步重算的函数，下一触发重新裁决即可）
      await this.e.graphReject(prop.id, `生长批自动 apply 失败：${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined)
      throw err
    }
    // 内容链补给（宿主消费）：本批新建节点中「前置已达成且正文未生成」者即就绪缺口——
    // 宿主据此入队正文生成（生长-内容交替，FIFO 不插队）。
    const created = final.spec.ops.filter(o => o.op === 'add_node').map(o => o.name!)
    let readyUnbuilt: string[] = []
    if (created.length) {
      const after = await this.e.loadView(c)
      const frontierAfter = new Set(this.coachFrontier(after.graph, after.state))
      readyUnbuilt = created.filter(n => frontierAfter.has(n) && !hasReadyContent(after.state[n]))
    }
    return {
      course: c.name,
      state: 'applied',
      check,
      segments,
      proposal: {
        id: prop.id, ops: final.spec.ops.length,
        operator: final.note.operator, reason: final.note.reason,
        disagreement: Boolean(final.note.disagreement),
      },
      applied: {
        ops: applied.ops,
        snapshot: applied.snapshot,
        compass_rewritten: applied.compass_rewritten === true,
        created,
        ready_unbuilt: readyUnbuilt,
      },
    }
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
        // 留痕缺失不炸读侧
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
          .catch(() => undefined)
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
