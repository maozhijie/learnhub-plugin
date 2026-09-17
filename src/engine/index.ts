/**
 * TS 学习引擎门面（learnhub-plugin/src/engine）。
 *
 * 职责边界（D14 修订版）：一切数据访问收口本门面背后的 engine/ 模块；工具、
 * HTTP 路由、UI 不得绕过 engine 直写数据文件。
 *
 * 数据主权（v3）：课程笔记 frontmatter = 调度状态唯一事实源；data/*.yaml =
 * 图结构唯一事实源；state/ 只承载追加型流水（journal/practice/review-log JSONL）与
 * 人审产物（proposals.json / snapshots/）。无 SQLite，无投影回写。
 */
import { graphHealthScore } from './graph/health.ts'
import type { VaultFs } from './infra/io.ts'
/** vault 存储端口（#175 阶段②）：类型随门面出，实现住 host/vault-fs.ts。 */
export type { VaultFs } from './infra/io.ts'
import { Paths } from './infra/paths.ts'
import { Registry } from './vault/registry.ts'
import { ConceptRegistry } from './concepts/concepts.ts'
import { Store } from './store.ts'
import { GraphStore, Graph, writeReadyList } from './graph/graph.ts'
import { GraphSubsystem } from './graph/graph-subsystem.ts'
import { stateMap, loadNote, saveNote, defaultFrontmatter, asFm, validateNoteFrontmatter } from './vault/notes.ts'
import type { BrokenNote } from './vault/notes.ts'
import { getScheduler, masteryOfFm } from './sched/srs.ts'
import { ErrorCards } from './content/error-cards.ts'
import { YAML } from './infra/yaml.ts'
import { dataCheck } from './data-check.ts'
import { readDayCutoff } from './sched/xp.ts'
import { SchedSubsystem } from './sched/sched-subsystem.ts'
import { GrowthSubsystem } from './coach/growth-subsystem.ts'
import type { FSRS } from 'ts-fsrs'
import { LabSubsystem } from './coach/nof1.ts'
import { sectionEntryOf } from './sched/attribution.ts'
import { diagnosticView } from './sched/attribution.ts'
import { runAudit } from './graph/audit.ts'
import { Content } from './content/content.ts'
import { ContentSubsystem } from './content/content-subsystem.ts'
import { GraphProposals } from './coach/proposals.ts'
import type { ApplyAudit } from './coach/proposals.ts'
import type { Clock, Rng } from './infra/clock.ts'
import type { Logger } from './infra/logger.ts'

import { Projects, ProjectSubsystem } from './practice/projects.ts'
import { endpointNames, readAnchors, foldCompletion } from './coach/seed.ts'
import type { CompletionFold } from './coach/seed.ts'

/** 宿主取型走门面（D14：host 不深导入引擎子模块）；纯类型 re-export 门。
 *
 * **这条约定的边界**（#237 / ADR-0075 补）：R1 实际只执法 `src/index.ts` 这一个入口文件的
 * 边（`tests/import-rules.test.ts` 的 R1 迭代 `HOST = src/index.ts`），`src/host/**` 不在
 * 受控面内；且既存先例 `host/handlers.ts` 已深导入 `engine/types.ts`（纯类型面）。因此
 * 允许 host 深导入的只有**纯声明面**——纯类型，与纯字符串常量（`engine/prompts/*.ts` 的
 * 提示词文本）。判据是「有行为吗」：纯声明面没有运行期语义，深导入不会把宿主焊到引擎内部
 * 装配上；**带行为的引擎子模块仍只准走门面**。 */
export type { CoachTrigger, CoachPromptFamily, CoachCheck, CoachGrowthSegment, GrowthPlanHandover } from './coach/coach-round.ts';
export type { GateVerdict } from './infra/agent.ts'
import { QuestionBank, validateBank, BankSubsystem } from './content/question-bank.ts'
import { NoteSourceManifest, ChannelsSubsystem } from './vault/note-source.ts'
import { LearnerCards, LearnerSubsystem } from './learner/learner-cards.ts'
import { Skills } from './practice/skills.ts'
import { Habits } from './practice/habits.ts'
import { AnkiMirror } from './vault/anki.ts'
import { Sessions } from './sched/sessions.ts'
import { todayStr, fmtCutoff } from './infra/dates.ts'
import { atomicWrite } from './infra/io.ts'
import { assertSchemaVersion } from './infra/schema.ts'
import type { SchemaBlock } from './infra/schema.ts'
import { revealAnswer, pctOf } from './infra/grading.ts'
import { auditQuestion } from './content/question-hygiene.ts'
import type { QuestionAuditReport } from './content/question-hygiene.ts'
import type { CourseEntry, Fm } from './types.ts'
import type { DataCheckReport } from './data-check.ts'
import type { RecommendDoc, StatusDoc } from './views.ts'

/** 宿主取值走门面（D14 收口，#152 刀 1 / ADR-0042）：re-export 门只供应纯函数、
 * 常量与缝型——数据访问仍只走门面方法，门不是数据旁路。 */
export { Content } from './content/content.ts'
export { ANKI_ENDPOINT, AnkiConnectClient } from './vault/anki.ts'
export { TIER_LABELS, tierIdxOf, genericQuizTarget } from './content/complexity.ts'
/** 正文就绪判定（#160 宿主种子链消费的纯函数：起点「正文未生成」口径与生长批一致）。 */
export { hasReadyContent } from './vault/notes.ts'
/** 宿主侧实验工具（#215 冒烟复跑契约门 / #216 spike 题面去重）经门面消费的两个纯函数：
 * R1「host 的 engine 导入只走门面」的直接后果——原实现从宿主直引子模块（越层），
 * 由 code-review 两轴审查抓出并收口到门面。 */
export { contractOf, validateByContract } from './content/output-contracts.ts'
export { normalizeStem } from './content/question-dedup.ts'
export { endpointNames, readAnchors } from './coach/seed.ts'
/** 卡点自报（#248 / ADR-0077）：注入块渲染随门面出——宿主在途合并缝（generateGrowthJob）消费。 */
export { stuckReportInject } from './coach/stuck-report.ts'
export { CURRENT_SCHEMA_VERSION } from './infra/schema.ts'
export type { LlmCallKind, LlmComplete, LlmEffort, LlmStream, LlmTokenUsage, LlmLoopTurn, LlmToolCall, LlmToolSpec } from './infra/llm.ts'
/** 时钟/随机端口（#175 阶段①）：类型随门面出（宿主经 R1 门取型，实现住 host/clock.ts）。 */
export type { Clock, Rng } from './infra/clock.ts'
/** 调试日志端口（#253 / ADR-0080）：类型与 noop 实现随门面出——宿主取型走门面（R1），
 * **仓库脚本**只消费 `lib/engine.js`，故 `noopLogger` 必须住引擎产物里（宿主实现
 * `host/log-file.ts` 不在其中，见 `engine/infra/logger.ts` 的说明）。 */
export { noopLogger } from './infra/logger.ts'
export type { Logger, LogLevel, LogFields, LogFieldValue } from './infra/logger.ts'
/** 统一 agent 缝（#162 / ADR-0041/0044）：类随门面出（宿主构造注入），类型随缝出。 */
export { AgentSeam, AGENT_LOOP_MAX_TOOL_ROUNDS, stripFences } from './infra/agent.ts'
export type { AgentCallRecord, AgentCallMode, AgentSeamPorts, GateRepairSpec } from './infra/agent.ts'
/** 出题第二意见门（#223）：站标签与缺省抽样率随门面出（宿主 STATIONS/配置对齐用）。 */
export { QUIZ_SOLVER_STATION, DEFAULT_QUIZ_AUDIT_RATE } from './content/question-audit.ts'
/** 思路官站标签（#301 缺陷③）：宿主 STATIONS.growthPlan 引本常量对齐——失败补标按真实
 * 失败站落盘，站名常量的单一出处从此在引擎侧（此前 host 侧一张写死的遗留映射
 * `growth: '教练思路'`）。 */
export { COACH_PLAN_STATION } from './coach/growth-subsystem.ts'
// 站名是受控词表（host STATIONS）成员：引擎侧单一出处经门面出（#313 D19——两侧各写字面量
// 时改名即静默分裂成两个语料目录）
export { COMPASS_STATION } from './coach/compass.ts'
export { DECOMPILE_STATION } from './practice/projects.ts'
/** 生长草稿内核（#271 / ADR-0088）：站标签/草稿差异与门同调纯函数随门面出（宿主与测试消费）。 */
export { GROWTH_DRAFT_STATION, expandPatchOps, draftFindings, normalizePatchShape } from './coach/growth-draft.ts'
export type { PatchSuggestion, PatchShapeNormalization } from './coach/growth-draft.ts'
/** 生长失败站标签的读侧（#301 缺陷③）：宿主按真实失败站补标语料，读法经门面走（不 cast 字段）。 */
export { stationOfError } from './coach/growth-subsystem.ts'
export { editGateErrors, replayDraft, sealedDecisionOf, simulateOps } from './coach/proposals.ts'
export type { DraftDiff, DraftReplay, SealedDecision, EditGateCtx } from './coach/proposals.ts'
export type { SecondOpinionReport, SecondOpinionOptions } from './content/question-audit.ts'
/** 出题多样性仪表（#230 / ADR-0064）：报告类型随门面出（宿主任务消息、工具面、基线脚本消费）。 */
export type { QuestionDiversityReport, DiversityMetrics, DiversityReading, DistractorReading } from './content/question-diversity.ts'
/** Vault 先验检索审计（#229 / ADR-0071）：检索核的审计类型随门面出（宿主在生成入口的
 * onPrior 注记回调里消费，R1：host 的 engine 导入只走门面）。审计**形状**住中立词汇层
 * types.ts（分居理由见那里：形状若住检索核会与 question-bank/note-source 成环，R7）。 */
export type { VaultPriorHit, VaultPriorSearch, PriorQueryTerm } from './vault/vault-prior.ts'
export type { VaultPriorAudit } from './types.ts'
/** 质量量规注册表（#221 / ADR-0062）：量规随门面出——离线评审运行器（#222）按站取量规、
 * 报告带分层法庭元数据，评审器不重写判据（判定标准先于判定器）。 */
export { QUALITY_RUBRICS, RUBRIC_COURTS, rubricOf, allCriteria } from './content/quality-rubrics.ts'
export type { QualityRubric, RubricDimension, RubricCriterion } from './content/quality-rubrics.ts'
/** 离线批量评审器（#222 / ADR-0070）：站标签 + 固定温度 + 抽样/提示词/解析/聚合/渲染
 * 全部随门面出——宿主运行器（host/quality-review.ts）只经门面消费（R1：host 的
 * engine 导入只走门面）。 */
export {
  QUALITY_REVIEW_STATION, REVIEW_TEMPERATURE, REVIEW_EFFORT, REVIEW_SCORE_LABELS, LOW_SCORE_THRESHOLD,
  DEFAULT_SAMPLE_QUOTA, QUALITY_REVIEW_SYSTEM, templateVersionOf, isScoreable, equidistantIndices,
  sampleQualitySamples, rubricForStation, rubricStations, dimensionNameOf, reviewBlindPrompt,
  reviewReconcilePrompt, parseReviewDoc, parseDimensionScores, evidenceLocated, finalScores,
  scoreStats, lowScoreItems, versionComparison, stabilityOf, canonicalReviews, artifactTextOf,
} from './content/quality-review.ts'
export type {
  ReviewSample, SampleQuota, ReviewScore, DimensionScore, SampleReview, DimensionStat, LowScoreItem,
  VersionStat, StabilityStat,
} from './content/quality-review.ts'
/** 报告形态与渲染（#222）：与测量面分开住——交付面（人读排版）与测量面（口径）变的原因不同。 */
export { renderQualityReviewReport } from './content/quality-review-report.ts'
export type { QualityReviewReport, SystemicCandidate, ReportRenderOptions } from './content/quality-review-report.ts'
/** 图质量面审计抽样（#224 / ADR-0070）：审计面清单 + 系统性发现候选随门面出。 */
export { AUDIT_AXES, SYSTEMIC_MIN_SAMPLES, SYSTEMIC_LOW_RATE, auditCriteriaOf, auditScopeLines, systemicCandidates } from './content/quality-audit.ts'
export type { AuditAxis, CriterionRef } from './content/quality-audit.ts'





export interface EngineConfig {
  /** vault 根目录绝对路径（必填）。 */
  vault: string
  /** 学习中心相对 vault 的路径（缺省「学习中心」）。 */
  centerRel?: string
  /** 时钟端口（#175 阶段① / ADR-0044）：读「当前时刻」属适配器关注点，必填注入、
   * 引擎内零回退直读——宿主给 systemClock，测试给固定时钟得「同一输入同一输出」。 */
  clock: Clock
  /** 随机源端口（#175 阶段①）：JOL 抽查（jolRng 的上游）与抽题洗牌共用；注入定长
   * 随机流即可断言确定性。宿主给 mathRng。 */
  rng: Rng
  /** vault 存储端口（#175 阶段② / ADR-0044）：engine 侧一切读盘落盘的唯一通道。
   * 实现住 host/vault-fs.ts（nodeVaultFs）；R2 自此是应用→适配器的存储边界。 */
  fs: VaultFs
  /** 调试日志端口（#253 / ADR-0080）：端口形状住引擎（`engine/infra/logger.ts`）、实现住
   * 适配器（`host/log-file.ts`）、装配住这里。**必填而非可选缺省 noop**——可选会让
   * 「忘了接线 = 日志静默消失」，恰是本票要治的病；代价是构造点显式接线（宿主 1 处 +
   * 仓库脚本 5 处 + 测试工厂）。deps 面只给**真正打日志的子系统**接 `logger` 槽
   * （当前 = GrowthSubsystem；`agent.gate.*` 由宿主构造的 AgentSeam 自持）。 */
  logger: Logger
}

export class LearnhubEngine {
  readonly paths: Paths
  readonly registry: Registry
  readonly store: Store
  readonly content: Content
  readonly proposals: GraphProposals
  readonly projects: Projects
  readonly bank: QuestionBank
  /** 概念登记表（#141）：每课程受控词表，沉淀层档案坐标系与概念引用校准基底。 */
  readonly concepts: ConceptRegistry
  readonly learnerCards: LearnerCards
  readonly errorCards: ErrorCards
  readonly skills: Skills
  readonly habits: Habits
  /** 笔记源清单（C1 通道）与 Anki 镜象：赋值在 constructor；字段声明曾在抽离中丢失。 */
  private noteManifest: NoteSourceManifest
  private ankiMirror: AnkiMirror
  readonly sessions: Sessions
  /** Lab 子系统（D 系列实验台，#152 刀 2）：窄面注入构造，见 constructor 尾部。 */
  readonly lab: LabSubsystem
  /** Channels 子系统（通道域，#152 刀 3）：窄面注入构造，见 constructor 尾部。 */
  readonly channels: ChannelsSubsystem
  /** Learner 子系统（学习者输出域，#152 刀 4）：窄面注入构造，见 constructor 尾部。 */
  readonly learner: LearnerSubsystem
  /** Project 子系统（项目域，#152 刀 5）：窄面注入构造，见 constructor 尾部。 */
  readonly project: ProjectSubsystem
  /** Bank 子系统（题库域，#152 刀 6）：窄面注入构造，见 constructor 尾部。 */
  readonly bank2: BankSubsystem
  /** Graph 子系统（图域，#152 刀 7）：窄面注入构造，见 constructor 尾部。 */
  readonly graph: GraphSubsystem
  /** Content 子系统（内容管线域，#152 刀 8）：窄面注入构造，见 constructor 尾部。 */
  readonly content2: ContentSubsystem
  /** Sched 子系统（调度域，#152 刀 9）：窄面注入构造，见 constructor 尾部。 */
  readonly sched2: SchedSubsystem
  /** Growth 子系统（滚动教练域，#152 刀 11）：窄面注入构造，见 constructor 尾部。 */
  readonly growth2: GrowthSubsystem
  /** vault 根目录（笔记源注册路径归一用；posix 规范形态）。 */
  readonly vaultRoot: string
  /** schema 版本块（#138 启动硬门的解析产物；breaks 断裂史为纯档案，引擎零消费）。 */
  readonly schema: SchemaBlock
  /** 时钟/随机端口（#175 阶段①）：宿主装配注入；引擎内零直读（门棘轮）。
   * jolRng 是 JOL 抽查的专用随机源（#66 E4 先例，public 可换——测试直接播种），缺省
   * 随配置的 rng 走。 */
  readonly clock: Clock
  readonly rng: Rng
  /** vault 存储端口（#175 阶段②）：域类与子系统经构造注入共享同一实例。 */
  readonly fs: VaultFs
  /** 调试日志端口（#253 / ADR-0080）：经 constructor 注入，只接线给真正打日志的子系统。 */
  readonly logger: Logger
  jolRng: () => number

  /** 课程调度器实例缓存（ADR-0014 附带）：参数文件唯一写者是 optimizeFsrsParams
   * （写回后显式失效）——每答一题重建 FSRS 并读一次参数盘是白付成本。
   * 键 = courseRoot（null = 默认参数，笔记源/我的卡用）。 */
  private schedCache = new Map<string | null, FSRS>()

  private async sched(courseRoot: string | null): Promise<FSRS> {
    let s = this.schedCache.get(courseRoot)
    if (!s) {
      s = await getScheduler(this.paths, courseRoot, this.fs, this.logger)
      this.schedCache.set(courseRoot, s)
    }
    return s
  }

  constructor(config: EngineConfig) {
    const centerRel = (config.centerRel ?? '学习中心').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const vault = config.vault.replace(/\\/g, '/').replace(/\/+$/, '')
    const centerRoot = `${vault}/${centerRel}`
    this.clock = config.clock
    this.rng = config.rng
    this.jolRng = config.rng
    this.fs = config.fs
    this.logger = config.logger
    this.vaultRoot = vault
    this.paths = new Paths(centerRoot)
    // schema 版本硬门（#138 / ADR-0034）：非当前主版本拒载，封死一切取用引擎的路径。
    // 同步读（构造函数无 await），先于任何惰性读盘——v1 库在第一次方法调用前就拒载。
    this.schema = assertSchemaVersion(this.paths.learnhubConfigPath, this.fs)
    this.registry = new Registry(this.paths, this.fs)
    this.store = new Store(this.paths, this.clock, this.fs)
    this.content = new Content(this.paths, this.clock, this.fs, this.logger)
    this.bank = new QuestionBank(this.paths, this.fs)
    this.concepts = new ConceptRegistry(this.paths, this.fs)
    this.learnerCards = new LearnerCards(this.paths, this.clock, this.fs)
    this.errorCards = new ErrorCards(this.paths, this.fs)
    this.skills = new Skills(this.paths, this.clock, this.fs)
    this.habits = new Habits(this.paths, this.clock, this.fs)
    this.noteManifest = new NoteSourceManifest(this.paths, this.fs)
    this.ankiMirror = new AnkiMirror(this.paths, this.fs)
    // 生长闸门注入（#146 插入/旁支调速）：三率流水在门面（账本/提案/练习），受理与
    // apply 双门经此回调消费同一份闸门判定。审计门注入（#313 B5）同款：propose 侧也要
    // 看见「课程存在审计 ERROR」——否则同一帧里可以「受理通过」而 apply 每轮拒。
    this.proposals = new GraphProposals(this.paths, this.store, this.registry, centerRoot,
      spec => this.growth2.growthGateErrors(spec),
      course => this.auditGateErrors(course), this.clock, this.fs,
      // #315 B2：收尾前置「闭包真已学」要读调度状态——注入状态读取口（读侧口径同 loadView）
      async root => (await stateMap(this.paths.courseDir(root), this.fs)).state,
      this.logger)
    this.projects = new Projects(this.paths, this.store, this.clock, this.fs)
    this.sessions = new Sessions(this.paths, async course => this.loadView(course), this.fs, this.logger)
    this.lab = new LabSubsystem({
      clock: this.clock, fs: this.fs,
      store: this.store, paths: this.paths, registry: this.registry,
      projects: this.projects, bank: this.bank,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.registry.enabled(),
      scanCourseBanks: (c, fn) => this.learner.scanCourseBanks(c, fn),
      sedimentAppend: (kind, tier, payload, concept) => this.sched2.sedimentAppend(kind, tier, payload, concept),
      sedimentFold: () => this.sched2.sedimentFold(),
      sedimentRebuildProfile: () => this.sched2.sedimentRebuildProfile(),
    })
    this.channels = new ChannelsSubsystem({
      clock: this.clock, fs: this.fs, logger: this.logger,
      store: this.store, paths: this.paths, bank: this.bank,
      ankiMirror: this.ankiMirror, noteManifest: this.noteManifest, vaultRoot: this.vaultRoot,
      registry: {
        load: () => this.registry.load(),
        loadNoteSources: () => this.registry.loadNoteSources(),
        save: (courses, noteSources) => this.registry.save(courses, noteSources),
        get: key => this.registry.get(key),
      },
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.registry.enabled(),
      scanCourseBanks: (c, fn) => this.learner.scanCourseBanks(c, fn),
      loadPrompt: kind => this.content2.loadPrompt(kind),
      questionView: (q, i, opts) => this.content2.questionView(q, i, opts),
      judgeBankAnswer: (llmComplete, q, answer, op, ref) => this.content2.judgeBankAnswer(llmComplete, q, answer, op, ref),
      refreshRepCard: (c, graph, node) => this.content2.refreshRepCard(c, graph, node),
    })
    this.learner = new LearnerSubsystem({
      clock: this.clock, fs: this.fs, logger: this.logger,
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, projects: this.projects, habits: this.habits,
      skills: this.skills, learnerCards: this.learnerCards, noteManifest: this.noteManifest,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.registry.enabled(),
      loadPrompt: kind => this.content2.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      nodeNote: (c, graph, node) => this.content2.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.content2.saveNodeNote(path, fm, body),
      sedimentSettle: () => this.sched2.sedimentSettle(),
      compassEtaRefresh: (courseKey, opts) => this.growth2.compassEtaRefresh(courseKey, opts),
      experimentPropose: (templateId, course) => this.lab.experimentPropose(templateId, course),
      receiptReviewEffect: (input: { today: string; course: string | null }) => this.lab.receiptReviewEffect(input),
      refreshSourceFingerprints: absPaths => this.project.refreshSourceFingerprints(absPaths),
    })
    this.project = new ProjectSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, projects: this.projects, noteManifest: this.noteManifest, concepts: this.concepts,
      vaultRoot: this.vaultRoot, jolRng: () => this.jolRng, clock: this.clock, fs: this.fs,
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.registry.enabled(),
      loadPrompt: kind => this.content2.loadPrompt(kind),
      locateNode: nodeSpec => this.locateNode(nodeSpec),
      graphPropose: (kind, yamlText) => this.graph.graphPropose(kind, yamlText),
      nodeNote: (c, graph, node) => this.content2.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.content2.saveNodeNote(path, fm, body),
    })
    this.bank2 = new BankSubsystem({
      clock: this.clock, fs: this.fs, logger: this.logger,
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, errorCards: this.errorCards, concepts: this.concepts,
      proposals: this.proposals, schedCache: this.schedCache,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.registry.enabled(),
      scanCourseBanks: (c, fn) => this.learner.scanCourseBanks(c, fn),
      loadPrompt: kind => this.content2.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      nodeNote: (c, graph, node) => this.content2.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.content2.saveNodeNote(path, fm, body),
      vaultPriorFor: (c, graph, node) => this.content2.vaultPriorFor(c, graph, node),
      logGradingFailure: rec => this.content2.logGradingFailure(rec),
      questionContext: (courseKey, node, qid, op) => this.content2.questionContext(courseKey, node, qid, op),
      exerciseGated: (c, node) => this.growth2.exerciseGated(c, node),
      repairInvokesOnce: (llm, items, scope) => this.channels.repairInvokesOnce(llm, items, scope),
      admitQuestion: (root, node, q, stem, existingStems) => this.channels.admitQuestion(root, node, q, stem, existingStems),
      explainPoints: (c, graph, node) => this.learner.explainPoints(c, graph, node),
      isNoteSourceCourse: courseKey => this.channels.isNoteSourceCourse(courseKey),
    })
    this.graph = new GraphSubsystem({
      clock: this.clock, fs: this.fs, logger: this.logger,
      store: this.store, paths: this.paths, projects: this.projects, proposals: this.proposals,
      concepts: this.concepts, registry: this.registry, bank: this.bank,
      vaultRoot: this.vaultRoot,
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      seedAuditFor: (courseName, today) => this.seedAuditFor(courseName, today),
      conceptInvokesOf: c => this.growth2.conceptInvokesOf(c),
      applyProjectPlanProposal: pid => this.project.applyProjectPlanProposal(pid),
      experimentApply: pid => this.lab.experimentApply(pid),
    })
    this.content2 = new ContentSubsystem({
      logger: this.logger,
      store: this.store, paths: this.paths, registry: this.registry, concepts: this.concepts, bank: this.bank,
      content: this.content, sessions: this.sessions, learnerCards: this.learnerCards,
      vaultRoot: this.vaultRoot, jolRng: () => this.jolRng, clock: this.clock, fs: this.fs,
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      bandDefault: () => this.lab.bandDefault(),
      calibrationHintsConfig: () => this.learner.calibrationHintsConfig(),
      collectNoteSourceCards: today => this.channels.collectNoteSourceCards(today),
      enabledCourses: () => this.registry.enabled(),
      ensureNote: (root, graph, node) => this.ensureNote(root, graph, node),
      errorCardTriples: (courses, nodeFilter) => this.bank2.errorCardTriples(courses, nodeFilter),
      exerciseGated: (c, node) => this.growth2.exerciseGated(c, node),
      expTag: (courseName, node, qid, today) => this.lab.expTag(courseName, node, qid, today),
      isNoteSourceCourse: courseKey => this.channels.isNoteSourceCourse(courseKey),
      jolConfig: () => this.learner.jolConfig(),
      jolPredicted: p => this.growth2.jolPredicted(p),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      nof1QueueEffect: today => this.lab.nof1QueueEffect(today),
      noteSourceAnswer: (llmComplete, sourceId, qid, answer, opts) => this.channels.noteSourceAnswer(llmComplete, sourceId, qid, answer, opts),
      noteSourceForget: (sourceId, qid) => this.channels.noteSourceForget(sourceId, qid),
      noteSourceRate: (sourceId, qid, r) => this.channels.noteSourceRate(sourceId, qid, r),
      sched: courseRoot => this.sched(courseRoot),
      updateNoteFm: (path, fm) => this.updateNoteFm(path, fm),
    })
    this.sched2 = new SchedSubsystem({
      clock: this.clock, fs: this.fs, logger: this.logger,
      store: this.store, paths: this.paths, registry: this.registry, bank: this.bank,
      content: this.content, schedCache: this.schedCache,
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      coachCheckFor: (c, today) => this.growth2.coachCheckFor(c, today),
      enabledCourses: () => this.registry.enabled(),
      ensureNote: (root, graph, node) => this.ensureNote(root, graph, node),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      scanCourseBanks: (c, fn) => this.learner.scanCourseBanks(c, fn),
      sched: courseRoot => this.sched(courseRoot),
    })
    this.growth2 = new GrowthSubsystem({
      clock: this.clock, fs: this.fs, logger: this.logger,
      store: this.store, paths: this.paths, registry: this.registry,
      concepts: this.concepts, content: this.content,
      enabledCourses: () => this.registry.enabled(),
      graphApply: (kind, pid) => this.graph.graphApply(kind, pid),
      graphPropose: (kind, yamlText) => this.graph.graphPropose(kind, yamlText),
      graphReject: (pid, note) => this.graph.graphReject(pid, note),
      graphProposals: (status, kind) => this.graph.graphProposals(status, kind),
      proposeConfusableCandidate: (courseKey, pair) => this.proposals.proposeConfusableCandidate(courseKey, pair),
      auditGateErrors: course => this.auditGateErrors(course),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      mcAggregate: (plan, cards, nodes, today, scheds, fallbackCourse) => this.lab.mcAggregate(plan, cards, nodes, today, scheds, fallbackCourse),
      sandboxPopulation: (courses, nodeFilter) => this.lab.sandboxPopulation(courses, nodeFilter),
      scanCourseBanks: (c, fn) => this.learner.scanCourseBanks(c, fn),
      sedimentFold: () => this.sched2.sedimentFold(),
      sedimentRebuildProfile: () => this.sched2.sedimentRebuildProfile(),
    })
  }

  /** 当前学习日与生效日界（ADR-0020）：learnhub.json 现读（与 jol 同款每次现读），
   * 一切调度/结算/「今日」视图的学习日单点——出处戳（generated_at/trained_at 等）
   * 不属于学习口径，不经这里。 */
  private async learningDay(): Promise<{ today: string; cutoff: number }> {
    const cutoff = await readDayCutoff(this.paths, this.fs)
    return { today: todayStr(new Date(this.clock.nowMs()), cutoff), cutoff }
  }

  // ---- 加载与解析 ----

  /** 单课完整视图：图 + frontmatter 状态（每次现读，文件量小，天然最新）。 */
  async loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }> {
    const store = new GraphStore(this.paths, this.paths.courseRoot(course.root), this.fs)
    const nodes = await store.load()
    const graph = new Graph(nodes)
    const { state, broken } = await stateMap(this.paths.courseDir(course.root), this.fs)
    return { graph, state, broken }
  }

  /** 跨课定位节点：「课程/节点」直接命中；否则在启用课程中搜唯一命中。 */
  async locateNode(nodeSpec: string): Promise<{ course: CourseEntry; node: string }> {
    if (nodeSpec.includes('/')) {
      const [cname, node] = nodeSpec.split('/', 2)
      const c = await this.registry.get(cname.trim())
      if (!c) throw new Error(`[learnhub] 注册表中没有课程「${cname.trim()}」。`)
      return { course: c, node: node.trim() }
    }
    const hits: CourseEntry[] = []
    for (const c of await this.registry.enabled()) {
      const { graph } = await this.loadView(c)
      if (graph.nset.has(nodeSpec)) hits.push(c)
    }
    if (!hits.length) throw new Error(`[learnhub] 启用课程中找不到节点「${nodeSpec}」。`)
    if (hits.length > 1) throw new Error(`[learnhub] 节点「${nodeSpec}」在多门课程中存在，请用「课程/节点」指定：${hits.map(h => h.name).join('、')}`)
    return { course: hits[0], node: nodeSpec }
  }

  /** Broken 笔记的路径定位（按规范路径精确匹配，不按 node 名猜）。 */
  private findBrokenNote(root: string, graph: Graph, node: string, broken: BrokenNote[]): BrokenNote | undefined {
    const expected = this.paths.courseNotePath(root, node)
    const key = expected.replace(/\\/g, '/').toLowerCase()
    return broken.find(b => b.path.replace(/\\/g, '/').toLowerCase() === key)
  }

  /** 定向节点操作的前置门：目标笔记 Broken 时携带位置与原因抛错。 */
  private assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void {
    const hit = this.findBrokenNote(course.root, graph, node, broken)
    if (hit) throw new Error(`[${tool}] 节点笔记 Broken（位置：${hit.path}）\n  ✗ ${hit.reason}`)
  }

  /** 无笔记节点补占位文件（保证 frontmatter 始终可查）。文件已存在但状态不可用时不覆盖。 */
  private async ensureNote(root: string, graph: Graph, node: string): Promise<Fm> {
    const path = this.paths.courseNotePath(root, node)
    if (this.fs.exists(path)) {
      const { fm: rawFm } = await loadNote(path, this.fs)
      const checked = validateNoteFrontmatter(rawFm)
      const detail = checked.errors.length ? checked.errors.join('；') : '状态未通过 frontmatter 契约（可运行 learnhub_data_check 定位）'
      throw new Error(`[learnhub] 笔记文件已存在但 Broken，拒绝覆盖（位置：${path}）\n  ✗ ${detail}`)
    }
    const fm = defaultFrontmatter(node)
    await saveNote(path, fm as unknown as Record<string, unknown>, '> 内容待生成。\n', this.fs)
    return fm
  }

  // ---- status / recommend ----

  /** 只读数据体检：盘点 Missing/Broken，不做任何修复或清理。 */
  async dataCheck(): Promise<DataCheckReport> {
    return dataCheck(this.paths, this.clock.nowMs(), this.fs)
  }
  /** 题库内容体检（ADR-0029/0030 存量盘点）：只读扫描全部课程题库与笔记源镜像题库，
   * 按现行契约标出违规存量题——表达式/数字填空、记法违规（裸 ^/_/LaTeX 命令）、
   * 转义损坏、超长解析。零写入零修复，清单供人工决定走归档重生成/定向补题。 */
  async questionAudit(): Promise<QuestionAuditReport> {
    const report: QuestionAuditReport = { banks: 0, questions: 0, flagged: 0, findings: [] }
    const scanBankFile = async (courseName: string, path: string): Promise<void> => {
      let text: string
      try {
        text = await this.fs.readFile(path)
      } catch {
        return // 读不到的损坏档归 dataCheck 管，这里只盘点可解析题库
      }
      let doc: unknown
      try {
        doc = YAML.parse(text)
      } catch {
        return
      }
      const v = validateBank(doc)
      if (v.errors || !v.spec) return
      report.banks++
      for (const q of v.spec.questions) {
        report.questions++
        const issues = auditQuestion(q)
        if (issues.length) {
          report.flagged++
          report.findings.push({ course: courseName, node: v.spec.node, id: q.id, kind: q.kind, q: q.q.slice(0, 80), issues })
        }
      }
    }
    for (const entry of await this.registry.load()) {
      const dir = `${this.paths.courseRoot(entry.root)}/题库`
      let files: string[] = []
      try {
        files = (await this.fs.readdir(dir)).filter(f => f.endsWith('.yaml'))
      } catch {
        continue // 课程还没有题库 = 合法空
      }
      for (const f of files) await scanBankFile(entry.name, `${dir}/${f}`)
    }
    const nsDir = `${this.paths.noteSourceDir}/题库`
    try {
      for (const f of (await this.fs.readdir(nsDir)).filter(f => f.endsWith('.yaml'))) {
        await scanBankFile('（笔记源镜像）', `${nsDir}/${f}`)
      }
    } catch {
      // 无笔记源镜像 = 合法空
    }
    return report
  }


  /** 逐终点完成折叠（#142 雾区条款上半，读侧零写副作用；#202 / ADR-0056 判据折叠自
   * 最后台阶 = 终点.pre 集全部 ≥ 阈值 + 该终点已收尾 sealed；#239 / ADR-0076 多终点化
   * = 逐终点一条读数）：零终点 = 空数组（合法空态，无从宣告）；锚 Broken fail loud——
   * 手改锚损坏必须显式浮出。 */
  async courseCompletion(course: { name: string; root: string }): Promise<CompletionFold[]> {
    const anchors = await readAnchors(this.paths.anchorPath(course.root), this.fs)
    if (!anchors.length) return []
    const { graph, state } = await this.loadView(course)
    return foldCompletion(graph, state, anchors)
  }

  async statusJson(): Promise<StatusDoc> {
    const { today, cutoff } = await this.learningDay()
    const [stats, diagnostics] = await Promise.all([this.learner.bankSnapshot(today), this.learner.diagnosticsAdvice(today)])
    const courses = await this.registry.enabled()
    const doc = await this.sessions.statusJson(courses, stats, today, fmtCutoff(cutoff))
    // 内容诊断建议项（#69 B1）：每课程附 diagnostics（信号/理由/证据 + 重写与讲解直达入口）
    for (const course of doc.courses) {
      const items = diagnostics.filter(d => d.course === course.name)
      if (items.length) course.diagnostics = items.map(d => diagnosticView(d))
    }
    // 逐终点完成读数（#142 雾区条款上半 / #239 多终点化）：判据读侧折叠（能力=终点
    // mastery≥阈值且闭包健康；覆盖=块工作表+终点），逐终点一条——零写侧状态、零专门停机代码
    for (const entry of courses) {
      const course = doc.courses.find(c => c.name === entry.name)
      if (!course) continue
      const completions = await this.courseCompletion(entry)
      if (completions.length) course.completions = completions
      // 教练回合触发点·会话开始（#144）：learnhub_status / 面板 /api/status 是会话开工
      // 的汇总入口——逐课程附就绪深度检查（读侧感知，ready=0 只告警不阻塞）
      course.coach = await this.growth2.coachCheckFor(entry, today)
      // 插入实验面（#146）：在途插入节点（面板「实验中」标记取数）、到期未决、
      // 三率（滚动 30 学习日）与韧性闸门现势——插入积极性对学习者透明
      course.probation = await this.growth2.probationViewFor(entry, today, cutoff)
    }
    return doc
  }

  async recommend(limit = 5): Promise<RecommendDoc> {
    const { today } = await this.learningDay()
    const [stats, window, diagnostics, pins, sleep] = await Promise.all([
      this.learner.bankSnapshot(today), this.learner.struggleWindow(today), this.learner.diagnosticsAdvice(today), this.store.loadPins(),
      this.lab.sleepAdviceConfig(),
    ])
    const events = await this.sessions.recommendEvents(await this.registry.enabled(), stats, today, limit, window, diagnostics, pins, sleep.enabled)
    return { date: today, events }
  }

  // ---- 「今天学它」pin（E3 #67 / ADR-0009 Learner Output）----

  // 以下 E3pin/E4jol/U4kata/E5coach/E2explain/E1cards/SC/Uskill/Ureceipt/Uhabit 十节方法体住 LearnerSubsystem（learner-cards.ts，#152 刀 4 聚合+转发）

  // ---- rebuild（audit + 就绪清单） ----

  async rebuild(courseKey?: string): Promise<{ message: string }> {
    const targets = courseKey ? [await this.registry.resolve(courseKey)] : await this.registry.enabled()
    const lines: string[] = []
    let failed = false
    for (const c of targets) {
      const { graph, state } = await this.loadView(c)
      const audit = await runAudit(this.paths, c.root, c.name, graph, (await this.learningDay()).today, this.fs)
      if (audit.failed) failed = true
      lines.push(`[${c.name}] 审计：ERROR ${audit.errors.length} | WARN ${audit.warns.length} | INFO ${audit.infos.length}${audit.failed ? '（阻断）' : ''}`)
      const done = new Set(Object.entries(state).filter(([, f]) => ['review', 'mastered', 'skipped'].includes(f.stage)).map(([n]) => n))
      await writeReadyList(this.paths, c.root, graph, done, this.fs)
    }
    if (failed) throw new Error(`[rebuild] 审计存在 ERROR：\n${lines.join('\n')}`)
    return { message: `[rebuild] 完成：\n${lines.join('\n')}` }
  }

  // ---- graph analyze ----

  // 以下 graph analyze/Vault 链接先验/图探索/提案门禁包装/enc 回填 五节方法体住 GraphSubsystem（graph-subsystem.ts，#152 刀 7 聚合+转发）

  // ---- Vault 链接先验（V-2 #91：wikilink → 无向关联对 → analyze 展示 + 单提案人审）----

  // ---- 图探索（agent 逐步查询，不拉全图）----

  // ---- 提案门禁包装（apply 前 audit 拦截） ----

  // ---- enc 覆盖层回填（kind=enrich，#140：出生/覆盖层分家；原 edit 通道随分家转富化）----

  // ---- 项目域（P 区 / ADR-0015；#92）----

  // 以下 项目域/过点对账/执行事件流/目标反编译 四节方法体住 ProjectSubsystem（projects.ts，#152 刀 5 聚合+转发）

  // ---- 过点对账 / 检索点 / 行为推断 enc（P-3/P-4/P-6；#94/#93/#96）----

  // ---- 执行事件流 / Mastery 交叉 2×2（P-7 / #98 / ADR-0015 §3/§4/§8）----

  // ---- 目标反编译（P-5 / #95：逆向设计 + PjBL；v8 种子簇形态 #149）----

  private async seedAuditFor(courseName: string, today: string): Promise<ApplyAudit> {
    const course = await this.registry.get(courseName)
    let audit: ApplyAudit = { ok: true, warns: [], health: 0 }
    if (course && this.fs.exists(this.paths.dataDir(course.root))) {
      const { graph } = await this.loadView(course)
      const result = await runAudit(this.paths, course.root, course.name, graph, today, this.fs)
      // 健康分与审计同口径剔终点（#200 / ADR-0055；#239 多终点化）：读锚现算，起草 apply 落的锚即刻生效
      const endpoints = endpointNames(await readAnchors(this.paths.anchorPath(course.root), this.fs))
      // errors 随行（#313 B5）：apply 的拒收文案要带上明细——模型只看到「先处理 审计报告.md」
      // 时，手上没有任何可执行信息（草稿会话连文件都读不到）
      audit = {
        ok: !result.failed, warns: result.warns.slice(0, 8),
        health: graphHealthScore(graph, { endpoints }).score,
        errors: result.errors.slice(0, 12),
      }
    }
    return audit
  }

  /** 审计门的**受理面**（#313 B5）：propose 与草稿试算消费同一判据（`editGateErrors.auditGate`），
   * 但只算不落盘——报告落盘仍归 apply 侧那次真跑，门不该在拒绝路径上写文件。 */
  private async auditGateErrors(courseName: string): Promise<string[]> {
    const course = await this.registry.get(courseName)
    if (!course || !this.fs.exists(this.paths.dataDir(course.root))) return []
    const { graph } = await this.loadView(course)
    const result = await runAudit(this.paths, course.root, course.name, graph,
      (await this.learningDay()).today, this.fs, { report: false })
    return result.errors.slice(0, 12)
  }

  // ---- 内容管线 ----

  // 以下 内容管线/note resolve/课程工作区 三节方法体住 ContentSubsystem（content-subsystem.ts，#152 刀 8 聚合+转发）

  // ---- note resolve / 反馈区读取 ----

  // ---- P4：课程工作区（树形）与题库 ----

  // ---- C1 笔记复习源（#59 / ADR-0010：只出题不动文，派生物落镜像区）----

  // 以下 C1/卡池镜像/漂移治理/排除清单/Anki 通道的方法体住 ChannelsSubsystem（note-source.ts，#152 刀 3 聚合+转发）

  // ---- 卡池镜像（V-4 #108：Obsidian backlink 通道）----


  // ---- 漂移治理全量化（V-6 #109：改名/移动 → relink 或 Missing）----

  // ---- 用户排除清单（V-1 #86：state/learnhub.json 的 note_source_excludes）----

  // ---- C2 Anki 通道（#63 / ADR-0011：Anki 纯作答通道，vault 唯一调度者）----

  // ---- 节点跳过 / 完成确认 ----

  // 以下 跳过/完成确认、XP 账本、记忆健康、优化器、沉淀层 五节方法体住 SchedSubsystem（sched-subsystem.ts，#152 刀 9 聚合+转发）

  // ---- XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注） ----

  // ---- 记忆健康仪表盘（#61 A2 / ADR-0012）----

  // ---- E4 JOL 抽查配置（state/learnhub.json 的 jol 字段；默认开、约 1/3）----

  // ---- D1 N-of-1 实验引擎（#110 / ADR-0023）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  // ---- U4 周复盘 Weekly Kata（#114 / ADR-0026：Learner Output，零 XP 零 canonical）----

  // ---- D2 挑战点恒温器（#111 / ADR-0024）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  // ---- D3 沙盘（#112 / ADR-0025）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  // ---- 罗盘（#143 / ADR-0033 透明度装置：常驻非承诺路线草图）----

  // 以下 罗盘/教练回合/生长批受理/复诊 四节方法体住 GrowthSubsystem（growth-subsystem.ts，#152 刀 11 聚合+转发）

  // ---- 教练回合感知面（#144 / ADR-0033 滚动教练：触发三点 × 就绪深度 × 六区块上下文包）----

  // ---- 生长批受理（#145 / ADR-0033 滚动教练：教练回合裁决 → edit 提案 → 罗盘随批写入单元）----

  // ---- 边实验账本与复诊（#146 / 插入提案生命周期：预注册→登记→到期结算→proven｜自动剪除）----

  // ---- Self-Calibration 自评校准画像（ADR-0022 #104；分源自省面 + 显式呈现层提示）----

  // ---- D4 睡眠耦合建议配置（#85）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  // ---- E5 可用的困难教练（#65；只读信息性反馈，无门禁无判分）----

  // ---- E2「讲给我听」（#68 / ADR-0009 Learner Output：判词只入 E 档案，零 XP）----

  // ---- E1「我的卡」复习（#45 schema / #68 存档目标；#70 落节级入口与管理面）----

  // ---- C-3 错误对比卡（#82：错误库→对比案例卡）----

  // 以下 错误对比卡/学习面板题目管理/B2 回流/一键清理/勘误冲正 五节方法体住 BankSubsystem（question-bank.ts，#152 刀 6 聚合+转发）

  // ---- U 区·技能条目与执行事件通道（#89 / ADR-0018 + ADR-0019）----

  // ---- U 区·回执反馈环（#88 / ADR-0016）----

  // ---- U 区·习惯一等公民（#90 / ADR-0017：零 FSRS 语义、零 canonical 写入）----

  // ---- FSRS 参数优化器（#62 A2 / ADR-0012）----

  // ---- 沉淀层（#139 / ADR-0034：学习模型状态第四存储域）----

  // ---- 生成任务持久化（host 的 genJobs 内存态落盘出口；D14：文件读写收口 engine）----

  /** 全量写入生成任务注册表（host 在每次任务状态变更时调用）。 */
  async saveGenJobs(jobs: Array<Record<string, unknown>>): Promise<void> {
    await atomicWrite(this.paths.genJobsPath, JSON.stringify(jobs, null, 1) + '\n', this.fs)
  }

  /** 读入生成任务注册表（ADR-0053）：文件缺失 = Missing 合法空态（[]）；存在但 JSON
   * 损坏 / 非数组 = Broken 抛出——注册表不是学习事实源（任务可重新下发），爆炸半径
   * 收在队列级：host 恢复处捕获置队列 broken 态（生成页显式报错 + 修复指引、broken
   * 期间拒绝一切写回），不升格为宿主硬失败。 */
  async loadGenJobs(): Promise<Array<Record<string, unknown>>> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.genJobsPath)
    } catch (err) {
      // 只认 ENOENT 为 Missing 合法空态——权限/锁等读错误静默回空表会让下一次入队
      // 把原档全量覆盖（静默销毁现场），与 Broken 同口径上抛（#194）
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      throw new Error(`[gen-jobs] ${this.paths.genJobsPath} 不可读（Broken）：${err instanceof Error ? err.message : String(err)}——修复后重启宿主再试。`)
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      throw new Error(`[gen-jobs] ${this.paths.genJobsPath} 不是合法 JSON（Broken）：修复或删除该文件后重启宿主再试。${err instanceof Error ? ` ${err.message}` : ''}`)
    }
    if (!Array.isArray(doc)) {
      throw new Error(`[gen-jobs] ${this.paths.genJobsPath} 不是清单数组（Broken）：修复或删除该文件后重启宿主再试。`)
    }
    return doc as Array<Record<string, unknown>>
  }

  /** 「与 AI 讨论本课」上下文包：节点元信息 + 正文 + 题库摘要 + 图位置（面板 → dsh 会话的首条消息原料）。 */
  async discussionPack(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[discuss] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'discuss')
    const fm = state[node]
    const mastery = masteryOfFm(fm)
    const lines: string[] = []
    lines.push(`# 课程上下文：${c.name} / ${node}`)
    lines.push(`- 深度：${graph.depth[node] ?? 0}（读侧派生）；阶段：${fm?.stage ?? 'unknown'}；掌握度：${pctOf(mastery)}`)
    const note = graph.noteOf[node]
    if (note) lines.push(`- note：${note}`)
    try {
      const { body } = await loadNote(this.paths.courseNotePath(c.root, node), this.fs)
      const cleaned = body.replace(/^>\s*内容待生成。\s*$/m, '').trim()
      lines.push('', '## 节点正文', cleaned ? cleaned.slice(0, 6000) : '（尚未生成正文）')
    } catch {
      lines.push('', '## 节点正文', '（正文文件缺失）')
    }
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    const qs = bank.questions.filter(q => !q.archived)
    if (qs.length) {
      lines.push('', '## 题库摘要', ...qs.map(q => `- [${q.kind}] ${q.q.slice(0, 80)}`))
    }
    lines.push('', '## 图位置',
      `- 前置：${graph.preOf[node].join('、') || '无'}`,
      `- 后继：${(graph.succ[node] ?? []).join('、') || '无'}`)
    return lines.join('\n')
  }

  /** 错误当下的「讲解这道题」逐题上下文包（Arc D #64；区别于整节点讨论包）：
   * {题面/选项/答案/解析、对应节正文、本次作答 answer+judge+feedback、忘记标记、
   * 图位置最小上下文} + 渐退教法引导指令（完整解法 → 同概念半成品/变式 → 独立
   * 重做；不泛泛重讲整课）。节定位 = q.section（清单 id → 标题 → 归一化标题）；
   * 映射失败退化为整课节选并明示，不崩。宿主会话首条消息 = 本包（面板答错/忘记
   * 错误态的「讲解这道题」动作经 explain-pack 路由取用）。 */
  async errorExplainPack(courseKey: string | undefined, node: string, qid: string): Promise<string> {
    const { c, graph, q } = await this.content2.questionContext(courseKey, node, qid, 'explain')
    const { fm: rawFm, body } = await loadNote(this.paths.courseNotePath(c.root, node), this.fs)
    const fm = asFm(rawFm)
    // 本次作答 = practice 流水里该题最近一条（答错作答或忘记申报；动作只从错误态进入）
    const rec = (await this.store.practiceAll())
      .filter(r => r.course === c.name && r.node === node && r.qid === qid)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .at(-1)
    const forgot = rec?.judge === 'forget'
    const entry = sectionEntryOf(q.section, fm?.content.sections)
    const sectionMd = entry
      ? Sessions.lessonSections(body).find(s => s.title === entry.title)?.md ?? null
      : null
    const lines: string[] = []
    lines.push(`# 讲解这道题：${c.name} / ${node}`)
    lines.push('', '## 题目', q.q)
    if (q.options?.length) lines.push(...q.options.map((o, i) => `- ${String.fromCharCode(65 + i)}. ${o}`))
    lines.push('', `**正确答案**：${revealAnswer(q)}`)
    if (q.explanation) lines.push('', `**解析**：${q.explanation}`)
    lines.push('', '## 本次作答')
    if (!rec) lines.push('（流水里没有本次作答记录——按学习者主动求助理解）')
    else if (forgot) lines.push('- 学习者申报了**忘记**（未作答直接翻面）：这条记忆没建立起来，讲解要从头建立，不要假设「只差一点」')
    else {
      lines.push(`- 学习者的作答：${rec.answer || '（空）'}`)
      lines.push(`- 判卷：${rec.correct ? '答对' : '答错'}（${rec.judge}）`)
      if (rec.feedback) lines.push(`- 判卷反馈：${rec.feedback}`)
    }
    lines.push('', '## 对应节正文')
    if (entry && sectionMd) {
      lines.push(`（来自节「${entry.title}」）`, '', sectionMd.slice(0, 4000))
    } else {
      lines.push(`（${entry ? '该节还没有正文' : '未能把这道题精确定位到某一节（题面陈旧或节已调整）'}——以下为整课节选）`, '', body.replace(/^>\s*内容待生成。\s*$/m, '').trim().slice(0, 2500))
    }
    lines.push('', '## 图位置',
      `- 前置：${graph.preOf[node].join('、') || '无'}`,
      `- 后继：${(graph.succ[node] ?? []).join('、') || '无'}`)
    lines.push('', '## 讲解要求（渐退教法）',
      '请围绕这一题组织讲解，不要泛泛重讲整课：',
      '1. 先给**完整解法**：把这一题彻底讲清（只依据上面「对应节正文」讲过的方法，不引入超纲概念）。',
      '2. 再出一道**同概念的半成品/变式**（保留大部分步骤、挖掉关键一步）让学习者补全。',
      '3. 最后让学习者**独立重做**原题（或极近似题），确认能独立完成。',
      '',
      '讲解用 Markdown，公式用 KaTeX（$...$）。现在从第 1 步开始。')
    return lines.join('\n')
  }

  // ---- 学习面板扩展（题目管理/课程删除）----

  // ---- B2 难度感知回流（决议 #41 / #58）----

  // ---- 题库一键清理（ADR-0032）----

  // ---- 瑕疵题勘误与判罚冲正（ADR-0031）----

  // ---- utils ----

  private async updateNoteFm(path: string, fm: Fm): Promise<void> {
    const { body } = await loadNote(path, this.fs)
    await saveNote(path, fm as unknown as Record<string, unknown>, body, this.fs)
  }

  /** 写一条 journal（调试日志由插件层做）。 */
  journal() { return this.store }
}
