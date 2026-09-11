# 刀 11 规格：growth 四节 → GrowthSubsystem 住 growth-subsystem.ts（同域新文件）
lord_file = 'src/engine/growth-subsystem.ts'
class_name = 'GrowthSubsystem'
deps_name = 'GrowthDeps'
field_name = 'growth2'

sections = [
    ('compass', '  // ---- 罗盘（#143', '  // ---- 教练回合感知面'),
    ('coach', '  // ---- 教练回合感知面', '  // ---- 生长批受理'),
    ('growth', '  // ---- 生长批受理', '  // ---- 边实验账本与复诊'),
    ('recheck', '  // ---- 边实验账本与复诊', '  // ---- Self-Calibration 自评校准画像'),
]

fwd_notes = {
    'compass': '以下 罗盘/教练回合/生长批受理/复诊 四节方法体住 GrowthSubsystem（growth-subsystem.ts，#152 刀 11 聚合+转发）',
}

lord_header = """
// ---- Growth 子系统（#152 刀 11 / ADR-0043）：滚动教练域——罗盘、教练回合感知面、
// 生长批受理、边实验账本与复诊。住同域新文件（compass.ts 与 proposals.ts 互相引用，
// 放进领主即成环）；本文件只被门面引用，跨子系统调用经窄面注入回引门面。"""

deps_text = """/** Growth 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */
export interface GrowthDeps {
  store: Store
  paths: Paths
  registry: Registry
  concepts: ConceptRegistry
  content: Content
  coachCheckFor(c: CourseEntry, today: string): Promise<CoachCheck>
  coachContextPack(courseKey?: string, opts?: { lightweight?: boolean; today?: string; packLabel?: string }): Promise<string>
  coachFrontier(graph: Graph, state: Record<string, Fm>): string[]
  compassEtaFold(c: CourseEntry, anchor: { endpoint: string }, today: string, weekStart: string): Promise<CompassEta>
  compassRead(courseKey?: string): Promise<CompassDoc>
  compassTail(courseKey: string): Promise<string>
  enabledCourses(): Promise<CourseEntry[]>
  graphApply(kind: 'edit' | 'seed' | 'enrich', pid?: number): Promise<GraphApplyResult>
  graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult>
  graphReject(pid: number, note?: string): Promise<ProposalRec>
  growthGraphView(graph: Graph, state: Record<string, Fm>): string
  growthTallies(proposals: ProposalRec[], cutoff: number): Promise<GrowthBatchTally[]>
  invokesResolver(c: CourseEntry): Promise<(qid: string) => string | null>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  mcAggregate(plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string, scheds: Map<string, FSRS>, fallbackCourse: string): { curve: SandboxCurvePoint[]; map: Array<{ node: string; p50: number; p80: number }> }
  parseGrowthVerdict(raw: string): { spec: EditProposalSpec; yaml: string; note: GrowthNote }
  probationFrame(c: CourseEntry, today: string, cutoff: number): Promise<{ courses: ProbationCourseView[]; ledger: ProbationFold }>
  probationViewFor(c: CourseEntry, today: string, cutoff: number): Promise<ProbationCourseView>
  pruneProbationNode(c: CourseEntry, graph: Graph, entry: ProbationEntry, metric: RecheckMetric, detail: string): Promise<number | null>
  recheckMetricOf(c: CourseEntry, proposals: ProposalRec[], entry: ProbationEntry): Promise<RecheckMetric | null>
  recordRecheckOutcome(c: CourseEntry, entry: ProbationEntry & { outcome: ProbationOutcome }, ctx: { metric: RecheckMetric; detail: string; settlePid?: number; graph: Graph; coarsePre: string[] }): Promise<void>
  sandboxPopulation(courses: CourseEntry[], nodeFilter: Set<string> | null): Promise<{ cards: SandboxCard[]; nodes: SandboxNode[]; scheds: Map<string, FSRS> }>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  sedimentFold(): Promise<SedimentFold>
  sedimentRebuildProfile(): Promise<string>
}"""

lord_replaces = [
    ("""/** Growth 域对门面的窄面""",
     """import type { Store } from './store.ts'
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
import type { CompassDoc, CompassEta } from './compass.ts'
import type { GraphApplyResult } from './views/graph.ts'
import type { GraphProposeResult } from './views/proposals.ts'
import type { EditProposalSpec, GrowthNote } from './proposals.ts'
import type { SedimentFold } from './sediment.ts'
import type { SandboxCard, SandboxCurvePoint, SandboxNode, SandboxPlan } from './sandbox.ts'
import type { ProbationCourseView, ProbationEntry, ProbationFold, ProbationOutcome, RecheckMetric, GrowthBatchTally } from './probation.ts'

/** Growth 域对门面的窄面"""),
]

facade_replaces = [
    ("""import { SchedSubsystem } from './sched-subsystem.ts'""",
     """import { SchedSubsystem } from './sched-subsystem.ts'
import { GrowthSubsystem } from './growth-subsystem.ts'"""),
    ("""  /** Sched 子系统（调度域，#152 刀 9）：窄面注入构造，见 constructor 尾部。 */
  private sched2: SchedSubsystem""",
     """  /** Sched 子系统（调度域，#152 刀 9）：窄面注入构造，见 constructor 尾部。 */
  private sched2: SchedSubsystem
  /** Growth 子系统（滚动教练域，#152 刀 11）：窄面注入构造，见 constructor 尾部。 */
  private growth2: GrowthSubsystem"""),
    ("""      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })
  }""",
     """      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })
    this.growth2 = new GrowthSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      concepts: this.concepts, content: this.content,
      coachCheckFor: (c, today) => this.coachCheckFor(c, today),
      coachContextPack: (courseKey, opts) => this.coachContextPack(courseKey, opts),
      coachFrontier: (graph, state) => this.coachFrontier(graph, state),
      compassEtaFold: (c, anchor, today, weekStart) => this.compassEtaFold(c, anchor, today, weekStart),
      compassRead: courseKey => this.compassRead(courseKey),
      compassTail: courseKey => this.compassTail(courseKey),
      enabledCourses: () => this.enabledCourses(),
      graphApply: (kind, pid) => this.graphApply(kind, pid),
      graphPropose: (kind, yamlText) => this.graphPropose(kind, yamlText),
      graphReject: (pid, note) => this.graphReject(pid, note),
      growthGraphView: (graph, state) => this.growthGraphView(graph, state),
      growthTallies: (proposals, cutoff) => this.growthTallies(proposals, cutoff),
      invokesResolver: c => this.invokesResolver(c),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      mcAggregate: (plan, cards, nodes, today, scheds, fallbackCourse) => this.mcAggregate(plan, cards, nodes, today, scheds, fallbackCourse),
      parseGrowthVerdict: raw => this.parseGrowthVerdict(raw),
      probationFrame: (c, today, cutoff) => this.probationFrame(c, today, cutoff),
      probationViewFor: (c, today, cutoff) => this.probationViewFor(c, today, cutoff),
      pruneProbationNode: (c, graph, entry, metric, detail) => this.pruneProbationNode(c, graph, entry, metric, detail),
      recheckMetricOf: (c, proposals, entry) => this.recheckMetricOf(c, proposals, entry),
      recordRecheckOutcome: (c, entry, ctx) => this.recordRecheckOutcome(c, entry, ctx),
      sandboxPopulation: (courses, nodeFilter) => this.sandboxPopulation(courses, nodeFilter),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      sedimentFold: () => this.sedimentFold(),
      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })
  }"""),
]
