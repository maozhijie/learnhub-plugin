# 刀 7 规格：graph 五节 → GraphSubsystem 住 graph-subsystem.ts（同域新文件，枢纽领主例外）
lord_file = 'src/engine/graph-subsystem.ts'
class_name = 'GraphSubsystem'
deps_name = 'GraphDeps'
field_name = 'graph'

sections = [
    ('analyze', '  // ---- graph analyze', '  // ---- Vault 链接先验'),
    ('V2', '  // ---- Vault 链接先验', '  // ---- 图探索'),
    ('explore', '  // ---- 图探索', '  // ---- 提案门禁包装'),
    ('gate', '  // ---- 提案门禁包装', '  // ---- enc 覆盖层回填'),
    ('enc', '  // ---- enc 覆盖层回填', '  // ---- 项目域（P 区'),
]

fwd_notes = {
    'analyze': '以下 graph analyze/Vault 链接先验/图探索/提案门禁包装/enc 回填 五节方法体住 GraphSubsystem（graph-subsystem.ts，#152 刀 7 聚合+转发）',
}

lord_header = """
// ---- Graph 子系统（#152 刀 7 / ADR-0043）：图域五节。本文件只被门面引用，可自由
// import 领域模块（枢纽领主 graph.ts 不被反向依赖）。"""

deps_text = """/** Graph 域对门面的窄面（门面构造时传 this）：领域类与纯函数直接 import，
 * 这里只列门面私有方法/字段——它们无法从模块导入。 */
export interface GraphDeps {
  store: Store
  paths: Paths
  projects: Projects
  proposals: GraphProposals
  concepts: ConceptRegistry
  registry: Registry
  bank: QuestionBank
  noteManifest: NoteSourceManifest
  vaultRoot: string
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  loadPrompt(kind: string): Promise<string>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  seedAuditFor(courseName: string, today: string): Promise<ApplyAudit>
  applyProjectPlanProposal(pid?: number, opts?: { pairApply?: boolean }): Promise<ProjectApplyResult>
  experimentApply(pid?: number): Promise<{ id: number; title: string; arm_today: string }>
}"""

lord_replaces = [
    ("""/** Graph 域对门面的窄面""",
     """import type { Store } from './store.ts'
import type { Paths } from './paths.ts'
import type { Projects, ProjectApplyResult } from './projects.ts'
import type { GraphProposals, ApplyAudit } from './proposals.ts'
import type { ConceptRegistry } from './concepts.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank } from './question-bank.ts'
import type { NoteSourceManifest } from './note-source.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { Fm } from './types.ts'

/** Graph 域对门面的窄面"""),
]

facade_replaces = [
    ("""import { GraphStore, Graph, writeReadyList, declaredEncOf } from './graph.ts'""",
     """import { GraphStore, Graph, writeReadyList, declaredEncOf } from './graph.ts'
import { GraphSubsystem } from './graph-subsystem.ts'"""),
    ("""  /** Bank 子系统（题库域，#152 刀 6）：窄面注入构造，见 constructor 尾部。 */
  private bank2: BankSubsystem""",
     """  /** Bank 子系统（题库域，#152 刀 6）：窄面注入构造，见 constructor 尾部。 */
  private bank2: BankSubsystem
  /** Graph 子系统（图域，#152 刀 7）：窄面注入构造，见 constructor 尾部。 */
  private graph: GraphSubsystem"""),
    ("""      isNoteSourceCourse: courseKey => this.isNoteSourceCourse(courseKey),
    })""",
     """      isNoteSourceCourse: courseKey => this.isNoteSourceCourse(courseKey),
    })
    this.graph = new GraphSubsystem({
      store: this.store, paths: this.paths, projects: this.projects, proposals: this.proposals,
      concepts: this.concepts, registry: this.registry, bank: this.bank,
      noteManifest: this.noteManifest, vaultRoot: this.vaultRoot,
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      loadPrompt: kind => this.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      seedAuditFor: (courseName, today) => this.seedAuditFor(courseName, today),
      applyProjectPlanProposal: (pid, opts) => this.applyProjectPlanProposal(pid, opts),
      experimentApply: pid => this.experimentApply(pid),
    })"""),
]
