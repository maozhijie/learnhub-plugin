# 刀 9 规格：sched 五节 → SchedSubsystem 住 sched-subsystem.ts（同域新文件，枢纽领主）
lord_file = 'src/engine/sched-subsystem.ts'
class_name = 'SchedSubsystem'
deps_name = 'SchedDeps'
field_name = 'sched2'

sections = [
    ('skip', '  // ---- 节点跳过 / 完成确认', '  // ---- XP 时间账本'),
    ('xp', '  // ---- XP 时间账本', '  // ---- 记忆健康仪表盘'),
    ('mem', '  // ---- 记忆健康仪表盘', '  // ---- E4 JOL 抽查配置'),
    ('opt', '  // ---- FSRS 参数优化器', '  // ---- 沉淀层'),
    ('sed', '  // ---- 沉淀层', '  // ---- 生成任务持久化'),
]

fwd_notes = {
    'skip': '以下 跳过/完成确认、XP 账本、记忆健康、优化器、沉淀层 五节方法体住 SchedSubsystem（sched-subsystem.ts，#152 刀 9 聚合+转发）',
}

lord_header = """
// ---- Sched 子系统（#152 刀 9 / ADR-0043）：调度域——节点跳过/完成确认、XP 时间账本、
// 记忆健康仪表盘、FSRS 参数优化器、沉淀层。住同域新文件（srs.ts 被 13 模块引用，
// 枢纽领主例外）；本文件只被门面引用，跨子系统调用经窄面注入回引门面。"""

deps_text = """/** Sched 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */
export interface SchedDeps {
  store: Store
  paths: Paths
  registry: Registry
  bank: QuestionBank
  content: Content
  /** 课程调度器实例缓存（参数写回后失效）。 */
  schedCache: Map<string | null, FSRS>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  coachCheckFor(c: CourseEntry, today: string): Promise<CoachCheck>
  enabledCourses(): Promise<CourseEntry[]>
  ensureNote(root: string, graph: Graph, node: string): Promise<Fm>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  sched(courseRoot: string | null): Promise<FSRS>
  sedimentAppend(kind: SedimentKind, tier: SedimentTier, payload: Record<string, unknown>, concept?: string): Promise<SedimentEvent>
  sedimentFold(): Promise<SedimentFold>
  sedimentRebuildProfile(): Promise<string>
}"""

lord_replaces = [
    ("""/** Sched 域对门面的窄面""",
     """import type { Store } from './store.ts'
import type { Paths } from './paths.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank, BankDoc } from './question-bank.ts'
import type { Content } from './content.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { Fm, CourseEntry } from './types.ts'
import type { FSRS } from 'ts-fsrs'
import type { CoachCheck } from './coach-round.ts'
import type { SedimentEvent, SedimentFold, SedimentKind, SedimentTier } from './sediment.ts'

/** Sched 域对门面的窄面"""),
]

facade_replaces = [
    ("""import { getScheduler, applyRatingBlock, masteryOfFm, previewDue, retrievabilityBlock, resolveFsrsParams } from './srs.ts'""",
     """import { getScheduler, applyRatingBlock, masteryOfFm, previewDue, retrievabilityBlock, resolveFsrsParams } from './srs.ts'
import { SchedSubsystem } from './sched-subsystem.ts'"""),
    ("""  /** Content 子系统（内容管线域，#152 刀 8）：窄面注入构造，见 constructor 尾部。 */
  private content2: ContentSubsystem""",
     """  /** Content 子系统（内容管线域，#152 刀 8）：窄面注入构造，见 constructor 尾部。 */
  private content2: ContentSubsystem
  /** Sched 子系统（调度域，#152 刀 9）：窄面注入构造，见 constructor 尾部。 */
  private sched2: SchedSubsystem"""),
    ("""      vaultPriorFor: (graph, node) => this.vaultPriorFor(graph, node),
    })
  }""",
     """      vaultPriorFor: (graph, node) => this.vaultPriorFor(graph, node),
    })
    this.sched2 = new SchedSubsystem({
      store: this.store, paths: this.paths, registry: this.registry, bank: this.bank,
      content: this.content, schedCache: this.schedCache,
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      coachCheckFor: (c, today) => this.coachCheckFor(c, today),
      enabledCourses: () => this.enabledCourses(),
      ensureNote: (root, graph, node) => this.ensureNote(root, graph, node),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      sched: courseRoot => this.sched(courseRoot),
      sedimentAppend: (kind, tier, payload, concept) => this.sedimentAppend(kind, tier, payload, concept),
      sedimentFold: () => this.sedimentFold(),
      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })
  }"""),
]
