# 刀 5 规格：project 四节 → ProjectSubsystem 住 projects.ts
lord_file = 'src/engine/projects.ts'
class_name = 'ProjectSubsystem'
deps_name = 'ProjectDeps'
field_name = 'project'

sections = [
    ('P', '  // ---- 项目域（P 区', '  // ---- 过点对账'),
    ('P346', '  // ---- 过点对账 / 检索点 / 行为推断 enc', '  // ---- 执行事件流'),
    ('P7', '  // ---- 执行事件流 / Mastery 交叉', '  // ---- 目标反编译'),
    ('P5', '  // ---- 目标反编译', '  // ---- 内容管线'),
]

fwd_notes = {
    'P': '以下 项目域/过点对账/执行事件流/目标反编译 四节方法体住 ProjectSubsystem（projects.ts，#152 刀 5 聚合+转发）',
}

lord_header = """
// ---- Project 子系统（#152 刀 5 / ADR-0043）：项目域——P 区项目生命周期、过点对账/
// 检索点/行为推断 enc、执行事件流 2×2、目标反编译。住领主文件 projects.ts（聚合+转发）；
// 跨子系统依赖经结构化窄面 ProjectDeps 由门面注入（运行时回引门面，类型面零门面导入——R6）。"""

deps_text = """/** Project 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface ProjectDeps {
  store: Pick<Store, 'loadProposals' | 'practiceAll' | 'reviewLogAll' | 'updateProposal'>
  paths: Paths
  registry: Pick<Registry, 'get'>
  bank: Pick<QuestionBank, 'load'>
  proposals: Pick<GraphProposals, 'applySeed' | 'reject'>
  projects: Projects
  noteManifest: Pick<NoteSourceManifest, 'load'>
  /** vault 根目录。 */
  vaultRoot: string
  /** JOL 抽查的随机源（可注入播种）。 */
  jolRng: () => number
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  loadPrompt(kind: string): Promise<string>
  locateNode(nodeSpec: string): Promise<{ course: CourseEntry; node: string }>
  graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult>
  nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }>
  saveNodeNote(path: string, fm: Fm, body: string): Promise<void>
  refreshSourceFingerprints(absPaths: string[]): Promise<void>
}"""

lord_replaces = [
    ("""import type { Paths } from './paths.ts'""",
     """import type { Paths } from './paths.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank } from './question-bank.ts'
import type { GraphProposals, ApplyAudit, EnrichFieldEntry } from './proposals.ts'
import type { NoteSourceManifest } from './note-source.ts'
import type { Graph } from './graph.ts'
import { declaredEncOf } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { CourseEntry, Fm } from './types.ts'
import type { LlmComplete } from './llm.ts'
import type { GraphProposeResult } from './views.ts'
import { runAudit } from './audit.ts'
import { graphHealthScore } from './health.ts'
import { applyPracticeEvidence } from './grading.ts'
import { masteryOfFm } from './srs.ts'
import type { ExecutionEvidence } from './skills.ts'
import { ratingFromEvidence } from './skills.ts'
import type { SkillDoc } from './skills.ts'
import { difficultyCalibration, milestonePrice } from './xp.ts'
import { dayOfTs, nowIso } from './dates.ts'"""),
    ("import { todayStr } from './dates.ts'",
     "import { todayStr } from './dates.ts'\nimport { appendProbationEntry, readProbationLedger, foldProbation, recheckVerdict, recheckDue, learningDaysOf, growthRates, growthGate } from './probation.ts'"),
    ("import { dayOfTs, nowIso } from './dates.ts'",
     "import { dayOfTs, nowIso } from './dates.ts'\nimport { CROSS_AXIS_THRESHOLD, TIER_REC_DEMOTE_SCORE, TIER_REC_MIN_EVENTS, TIER_REC_PROMOTE_SCORE, XP_PER_MILESTONE_DEFAULT } from './params.ts'\nimport { execRatingScore, exercisedEncEdges, classifyCross, masteryAggregate, execEvidenceScore, recommendTier, validateExecEvent, appendExecRec, execRecsAll } from './project-exec.ts'\nimport type { ProjectExecRec } from './project-exec.ts'\nimport { searchVaultPrior, priorTerms, priorSection } from './vault-prior.ts'\nimport { mapEdgesToNodes, orientLinkPair, readVaultLinkDirExcludes, readVaultLinksCache, scanVaultLinks, scoreTier } from './vault-links.ts'\nimport { decompileGoalOf, decompileTerms, splitDecompileDoc, decompileRepairPrompt, reconcilePlanNodes, splitNodeSpec } from './project-decompile.ts'\nimport type { DecompileDoc } from './project-decompile.ts'\nimport { drawRecallQuestions, appendRecallRec, recallRecsAll } from './project-recall.ts'\nimport type { RecallQuestion, RecallRec } from './project-recall.ts'\nimport { cooccurrencePairs, orientCandidate, coWeight } from './project-enc.ts'\nimport { fingerprintOf, stripFrontmatter } from './note-source.ts'"),
]

facade_replaces = [
    ("""import { Projects, PROJECT_LIFECYCLES, FADING_TIERS, isProjectLifecycle, isFadingTier, planRevisionDiff } from './projects.ts'""",
     """import { Projects, PROJECT_LIFECYCLES, FADING_TIERS, isProjectLifecycle, isFadingTier, planRevisionDiff, ProjectSubsystem } from './projects.ts'"""),
    ("""  /** Learner 子系统（学习者输出域，#152 刀 4）：窄面注入构造，见 constructor 尾部。 */
  private learner: LearnerSubsystem""",
     """  /** Learner 子系统（学习者输出域，#152 刀 4）：窄面注入构造，见 constructor 尾部。 */
  private learner: LearnerSubsystem
  /** Project 子系统（项目域，#152 刀 5）：窄面注入构造，见 constructor 尾部。 */
  private project: ProjectSubsystem"""),
    ("""      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
    })""",
     """      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
    })
    this.project = new ProjectSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, proposals: this.proposals, projects: this.projects, noteManifest: this.noteManifest,
      vaultRoot: this.vaultRoot, jolRng: () => this.jolRng,
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      loadPrompt: kind => this.loadPrompt(kind),
      locateNode: nodeSpec => this.locateNode(nodeSpec),
      graphPropose: (kind, yamlText) => this.graphPropose(kind, yamlText),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
    })"""),
]
