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
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, unlink, writeFile, appendFile } from 'node:fs/promises'
import { Paths, safeFilename } from './paths.ts'
import { Registry } from './registry.ts'
import { ConceptRegistry, invokesTagged, invokesUnregistered, namesOf, resolveConcept } from './concepts.ts'
import { Store, netPracticeRecs } from './store.ts'
import { GraphStore, Graph, writeReadyList, declaredEncOf } from './graph.ts'
import { GraphSubsystem } from './graph-subsystem.ts'
import { stateMap, loadNote, saveNote, defaultFrontmatter, asFm, validateNoteFrontmatter, hasReadyContent } from './notes.ts'
import type { BrokenNote } from './notes.ts'
import { getScheduler, applyRatingBlock, masteryOfFm, previewDue, retrievabilityBlock, resolveFsrsParams } from './srs.ts'
import { SchedSubsystem } from './sched-subsystem.ts'
import { GrowthSubsystem } from './growth-subsystem.ts'
import { advance, advancePending, advanceStrict, alreadyAdvanced } from './advance.ts'
import type { FSRS } from 'ts-fsrs'
import { bandOffset, combinedDifficulty, startBand, sessionOrder } from './adaptive.ts'
import type { BandPref } from './adaptive.ts'
import { JOL_PREDICTIONS, JOL_SAMPLE_RATE, jolCalibration, jolDeviatedKeys, pickJolTargets } from './jol.ts'
import type { JolPrediction } from './jol.ts'
import { CALIBRATION_BOOST_SAMPLE_RATE, RECHECK_DAYS_DEFAULT } from './params.ts'
import { calibrationHintText, calibrationProfileView, overconfidenceOf } from './calibration.ts'
import { normalizeSleepAdvice } from './sleep.ts'
import { NOF1_TEMPLATES, NOF1_PER_ARM_MIN, NOF1_VARIABLE_WHITELIST, nof1Template, nof1ArmForDay, nof1Outcomes, analyzeNof1, shuffleAssign, interleaveBySource, mulberry32, LabSubsystem } from './nof1.ts'
import type { Nof1Template, Nof1Variable, ExperimentDef, Nof1Analysis } from './nof1.ts'
import { retentionBand, bandDistribution, execRatingDistribution, thermostatSuggestions } from './thermostat.ts'
import type { ThermostatDoc, ThermostatSuggestion } from './thermostat.ts'
import { SANDBOX_RUNS, SANDBOX_DEFAULT_WEEKS, SANDBOX_WORDING, SANDBOX_NODE_EST_DEFAULT, simulateRun, aggregateRuns } from './sandbox.ts'
import type { SandboxDoc, SandboxCard, SandboxCurvePoint, SandboxNode, SandboxPlan } from './sandbox.ts'
import {
  KATA_KIND, KATA_EMPTY, KATA_LEARNER_QUESTIONS, weekStartOf, weekEndOf, prevWeekStartOf,
  buildKataReality, renderKataReality, assembleKataDoc, parseKataBody, kataAnswered, kataEtaSummary,
} from './kata.ts'
import type { KataAnswer, KataQuestion } from './kata.ts'
import { writeOutputArtifact, obsidianLink } from './output.ts'
import { coachFeedback, COACH_DUE_HARD_R, COACH_HARD_D, withinCoachWindow } from './coach.ts'
import type { BandRec } from './coach.ts'
import { calibrationAdvice, tooEasyAdvice, adviceDismissKey } from './bank-advice.ts'
import type { AdviceDismissRec } from './bank-advice.ts'
import { cleanupCandidatesForNode } from './bank-cleanup.ts'
import type { CleanupReason } from './bank-cleanup.ts'
import { bindingImpl, defaultParams, OPTIMIZE_MIN_REVIEWS, FSRS6_PARAM_COUNT, sequenceReviews, trainingSequences } from './optimize.ts'
import type { OptimizerImpl } from './optimize.ts'
import { sectionEntryOf } from './attribution.ts'
import { DIAGNOSTIC_SCORE, diagnosticView, evaluateSectionSignals, formatSignalDetail, parseRewriteDetail, parseSignalDetail } from './attribution.ts'
import type { DiagnosticItem, RewriteFact, SignalSnapshot } from './attribution.ts'
import { FORECAST_DAYS, calibrationBins, dueReviewFirstPushes, forecast, forgettingCurve, stateHistograms, trueRetention } from './memory.ts'
import { runAudit, effectiveStage } from './audit.ts'
import { analyzeGraph } from './analysis.ts'
import { graphHealthScore } from './health.ts'
import { Content } from './content.ts'
import { ContentSubsystem } from './content-subsystem.ts'
import { nodeTierOf, perSectionQuizTarget, genericQuizTarget, sectionTierLabel } from './complexity.ts'
import type { ComplexityTier } from './complexity.ts'
import { GraphProposals, validateEditProposal, addNodeCountOf } from './proposals.ts'
import type { ApplyAudit, EditProposalSpec, EnrichFieldEntry, GrowthNote } from './proposals.ts'
import type { LlmComplete } from './llm.ts'
import { Projects, PROJECT_LIFECYCLES, FADING_TIERS, isProjectLifecycle, isFadingTier, planRevisionDiff, ProjectSubsystem } from './projects.ts'
import type { PlanRevisionDiff, PlanGrowthTrigger } from './projects.ts'
import { decompileGoalOf, decompileTerms, splitDecompileDoc, decompileRepairPrompt, reconcilePlanNodes, splitNodeSpec } from './project-decompile.ts'
import type { DecompileDoc } from './project-decompile.ts'
import type { ProjectFm, ProjectView, FadingTier, ProjectApplyResult, PlanItem } from './projects.ts'
import { drawRecallQuestions, appendRecallRec, recallRecsAll } from './project-recall.ts'
import type { RecallQuestion, RecallRec } from './project-recall.ts'
import { cooccurrencePairs, orientCandidate, coWeight } from './project-enc.ts'
import { mapEdgesToNodes, orientLinkPair, readVaultLinkDirExcludes, readVaultLinksCache, scanVaultLinks, scoreTier } from './vault-links.ts'
import type { VaultLinksDoc, VaultLinkCandidateView } from './vault-links.ts'
import { readAnchor, foldCompletion, isSeedGraph, COMPLETION_MASTERY_THRESHOLD, validateSeedProposal, seedRepairPrompt } from './seed.ts'
import type { CompletionFold, SeedProposalSpec, SeedDraftRequest } from './seed.ts'
import {
  SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, ROUTE_PENDING, ETA_PENDING,
  COMPASS_ETA_PROBE_WEEKS, compassScaffold, parseCompass, sectionBody, withSectionText,
  validateRouteBody, stripWrappingFence, etaMarkerOf, renderEtaBody, compassPaintContext,
  hasLearnerAnnotations,
} from './compass.ts'
import type { CompassEta, CompassEtaProbe } from './compass.ts'
import { behaviorDigest, readyDepthCheck, renderBehaviorDigest, renderSedimentForCoach, arbitrationPopulations, renderArbitrationEvidence } from './coach-round.ts'
import type { CoachCheck, CoachGrowthSegment, CoachTrigger } from './coach-round.ts'

/** 宿主取型走门面（D14：host 不深导入引擎子模块）；纯类型 re-export 门。 */
export type { CoachTrigger, CoachCheck, CoachGrowthSegment } from './coach-round.ts'
export type { SeedDraftRequest } from './seed.ts'
import {
  appendProbationEntry, readProbationLedger, foldProbation, recheckVerdict, recheckDue,
  learningDaysOf, growthRates, growthGate,
} from './probation.ts'
import type { ProbationEntry, ProbationOutcome, ProbationFold, ProbationCourseView, RecheckMetric, GrowthBatchTally } from './probation.ts'
import type { VaultLinkPrior } from './analysis.ts'
import { execRatingScore, exercisedEncEdges, classifyCross, masteryAggregate, execEvidenceScore, recommendTier, validateExecEvent, appendExecRec, execRecsAll } from './project-exec.ts'
import type { ProjectExecRec } from './project-exec.ts'
import { searchVaultPrior, priorTerms, priorSection } from './vault-prior.ts'
import { QuestionBank, questionAnswerShapeError, validateBank, BankSubsystem } from './question-bank.ts'
import type { BankDoc, BankQuestion } from './question-bank.ts'
import { NoteSourceManifest, NOTE_SOURCE_COURSE, classifySource, collectNoteFiles, fingerprintOf, isExcludedPath, normalizeSourcePath, poolMirrorBody, readNoteSourceExcludes, sourceHint, stripFrontmatter, titleOfBody, writeNoteSourceExcludes, ChannelsSubsystem } from './note-source.ts'
import type { NoteSourceManifestItem, NoteSourceStatus } from './note-source.ts'
import { LearnerCards, LEARNER_CARD_KINDS, LearnerSubsystem } from './learner-cards.ts'
import type { LearnerCard, LearnerCardDoc } from './learner-cards.ts'
import { ErrorCards, mineErrorPatterns, validateErrorCards, ERROR_CARD_BATCH_MAX } from './error-cards.ts'
import type { ErrorCard, ErrorPatternCandidate } from './error-cards.ts'
import { Skills, laneDue, laneEventKind, ratingFromEvidence, clampMaintenanceDays, executionRowIdentity, executionXpDetail } from './skills.ts'
import type { SkillDoc, ExecutionSource, ExecutionEventKind, ExecutionEvidence, ExecutionLogResult } from './skills.ts'
import { Habits, habitStreak, automationCurve } from './habits.ts'
import type { HabitDoc, HabitRepeatRec, ExecutionIntention } from './habits.ts'
import { normalizeGoalIntention } from './goals.ts'
import type { PinRec, GoalIntentionInput } from './goals.ts'
import { submitReceipt, receiptsUntilNextFull, RECEIPT_KIND_LABEL } from './receipts.ts'
import type { ReceiptLogRec, ReceiptKind, ReceiptSubmitResult } from './receipts.ts'
import { selfNoteFeedbackPrompt, selfNoteFeedbackSystem, selfNotePromptOf } from './self-note.ts'
import { AnkiMirror, ankiAddNote, ankiCardPayload, ankiCardReviews, ankiCardsInfo, ankiCreateDeck, ankiCreateModel, ankiDeckNames, ankiDeleteNotes, ankiFindNotes, ankiModelNames, ankiNotesInfo, ankiUpdateNoteFields, deckNameOf, isAnkiNoteMissing, isoFromMs, mapAnkiEase, parseSourceKey, planMirrorSync, ANKI_MODEL, ANKI_TAG } from './anki.ts'
import type { AnkiMirrorEntry, AnkiNotePayload, AnkiTransport } from './anki.ts'
import { explainBackPack, explainFeedbackSystem, explainFeedbackPrompt, parseExplainVerdict } from './explain.ts'
import type { ExplainPoint, ExplainTag, ExplainVerdict } from './explain.ts'
import { YAML } from './yaml.ts'
import { Sessions, assertNoBrokenNotes, readySet, withinStruggleWindow, STRUGGLE_WINDOW_DAYS } from './sessions.ts'
import type { NodeStat, WindowStat } from './sessions.ts'
import { todayStr, nowIso, dayOfTs, fmtCutoff } from './dates.ts'
import { atomicWrite, readLearnhubConfig, writeLearnhubConfig } from './io.ts'
import { assertSchemaVersion } from './schema.ts'
import type { SchemaBlock } from './schema.ts'
import { appendSedimentEvent, readSedimentCanon, foldSediment, rebuildLearnerProfile } from './sediment.ts'
import type { SedimentEvent, SedimentFold, SedimentKind, SedimentTier } from './sediment.ts'
import { REFLECTION_GRADING_SYSTEM, parseReflectionGrading, OPEN_QUESTION_GRADING_SYSTEM, parseOpenGrading, evaluateAllo, PASS_SCORE, applyPracticeEvidence, answerDiff, DISPUTE_REVIEW_SYSTEM, parseDisputeReview, revealAnswer } from './grading.ts'
import type { DisputeVerdict } from './grading.ts'
import { findDuplicateStem, existingStemsPromptBlock, bankStemList } from './question-dedup.ts'
import { repairQuestionStrings, questionViolation, auditQuestion } from './question-hygiene.ts'
import type { QuestionAuditReport } from './question-hygiene.ts'
import { parseSectionTitle } from '../../shared/content-renderers.ts'
import { xpForAnswer, readDailyGoal, writeDailyGoal, readDayCutoff, writeDayCutoff, sumXp, streakFrom, nominalBudget, difficultyCalibration, milestonePrice } from './xp.ts'
import { XP_STREAK_GRACE_DAYS, XP_GUESS_SECONDS, XP_PERFECT_BONUS, XP_PER_MILESTONE_DEFAULT, FSRS_DIFFICULTY_MID, CROSS_AXIS_THRESHOLD, TIER_REC_MIN_EVENTS, TIER_REC_PROMOTE_SCORE, TIER_REC_DEMOTE_SCORE } from './params.ts'
import type { CourseEntry, EArchiveRec, EncEdge, ErratumRec, Fm, FsrsBlock, GNode, NoteSourceEntry, ReviewRec, SectionManifest, Stage } from './types.ts'
import type { AlloKind } from './grading.ts'
import { dataCheck } from './data-check.ts'
import type { DataCheckReport } from './data-check.ts'
import type { ProposalRec } from './types.ts'
import { PROPOSAL_KINDS, CONCEPT_TIERS } from './types.ts'
import type { ConceptTier } from './types.ts'
import type {
  AnkiStatusDoc, AnswerResult, DifficultyAdviceDoc, DisputeApplyResult, DisputeReviewResult, DoctorDoc, ExperimentProposeResult,
  ExperimentStartResult, GraphApplyEditResult, GraphApplyResult, GraphBrowseDoc,
  GraphDoc, GraphElementsDoc, GraphEncBackfillResult, GraphEditProposalResult, GraphNodeDoc, GraphPathResult,
  GraphProposeResult, CalibrationProfileDoc, LearnerArchiveResult, LearnerCardItem, LearnerForgetResult, LearnerQueueDoc,
  LearnerRateResult, LessonDoc, MemoryHealthDoc, NoteSourceDoc, NoteSourceItem,
  ErrorArchiveResult, ErrorCardItem, ErrorGenerateResult, ErrorMineDoc, ErrorQueueDoc, ErrorAnswerResult,
  NoteSourceRegisterResult, QuestionForgetResult, QuestionGetDoc, QuestionRateResult,
  QuestionsAllDoc, QuestionsDoc, QueueItem, RecommendDoc, ReviewQueueDoc, SkillsListDoc, StatusDoc, TreeDoc,
  XpStatus, HabitsListDoc, HabitShowDoc, ProjectCrossDoc, ProjectExecResult, ProjectExecBackflow,
  KataDoc, CleanupGroup, CleanupPreviewDoc,
} from './views.ts'

/** 宿主取值走门面（D14 收口，#152 刀 1 / ADR-0042）：re-export 门只供应纯函数、
 * 常量与缝型——数据访问仍只走门面方法，门不是数据旁路。 */
export { Content } from './content.ts'
export { ANKI_ENDPOINT, AnkiConnectClient } from './anki.ts'
export { TIER_LABELS, tierIdxOf, genericQuizTarget } from './complexity.ts'
export type { LlmComplete, LlmEffort } from './llm.ts'

/** Fisher–Yates 洗牌（返回新数组；matching 右列候选防按序泄题）。 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}


/** 周复盘的周参数校验（周一锚定；非法 fail loud）。 */
function kataMonday(weekStart: string): string {
  if (typeof weekStart !== 'string' || weekStartOf(weekStart) !== weekStart) {
    throw new Error(`[kata] weekStart 必须是某周的周一 'YYYY-MM-DD'（收到 ${String(weekStart)}）。`)
  }
  return weekStart
}

/** 节标题归一化（#117 定向补题的归类口径，与前端会话 normSection 同款）：
 * 剥「类型：」前缀 + 去全部空白——模型 section 标注与前缀/空白差异据此吸收。 */
function normSectionKey(s: string): string {
  return parseSectionTitle(s).clean.replace(/\s+/g, '')
}



export interface EngineConfig {
  /** vault 根目录绝对路径（必填）。 */
  vault: string
  /** 学习中心相对 vault 的路径（缺省「学习中心」）。 */
  centerRel?: string
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
  readonly sessions: Sessions
  /** Lab 子系统（D 系列实验台，#152 刀 2）：窄面注入构造，见 constructor 尾部。 */
  private lab: LabSubsystem
  /** Channels 子系统（通道域，#152 刀 3）：窄面注入构造，见 constructor 尾部。 */
  private channels: ChannelsSubsystem
  /** Learner 子系统（学习者输出域，#152 刀 4）：窄面注入构造，见 constructor 尾部。 */
  private learner: LearnerSubsystem
  /** Project 子系统（项目域，#152 刀 5）：窄面注入构造，见 constructor 尾部。 */
  private project: ProjectSubsystem
  /** Bank 子系统（题库域，#152 刀 6）：窄面注入构造，见 constructor 尾部。 */
  private bank2: BankSubsystem
  /** Graph 子系统（图域，#152 刀 7）：窄面注入构造，见 constructor 尾部。 */
  private graph: GraphSubsystem
  /** Content 子系统（内容管线域，#152 刀 8）：窄面注入构造，见 constructor 尾部。 */
  private content2: ContentSubsystem
  /** Sched 子系统（调度域，#152 刀 9）：窄面注入构造，见 constructor 尾部。 */
  private sched2: SchedSubsystem
  /** Growth 子系统（滚动教练域，#152 刀 11）：窄面注入构造，见 constructor 尾部。 */
  private growth2: GrowthSubsystem
  /** vault 根目录（笔记源注册路径归一用；posix 规范形态）。 */
  readonly vaultRoot: string
  /** schema 版本块（#138 启动硬门的解析产物；breaks 断裂史为纯档案，引擎零消费）。 */
  readonly schema: SchemaBlock
  /** JOL 抽查的随机源（#66 E4）：可注入播种（测试确定性；运行时 Math.random）。 */
  jolRng: () => number = Math.random

  /** 课程调度器实例缓存（ADR-0014 附带）：参数文件唯一写者是 optimizeFsrsParams
   * （写回后显式失效）——每答一题重建 FSRS 并读一次参数盘是白付成本。
   * 键 = courseRoot（null = 默认参数，笔记源/我的卡用）。 */
  private schedCache = new Map<string | null, FSRS>()

  private async sched(courseRoot: string | null): Promise<FSRS> {
    let s = this.schedCache.get(courseRoot)
    if (!s) {
      s = await getScheduler(this.paths, courseRoot)
      this.schedCache.set(courseRoot, s)
    }
    return s
  }

  constructor(config: EngineConfig) {
    const centerRel = (config.centerRel ?? '学习中心').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const vault = config.vault.replace(/\\/g, '/').replace(/\/+$/, '')
    const centerRoot = `${vault}/${centerRel}`
    this.vaultRoot = vault
    this.paths = new Paths(centerRoot)
    // schema 版本硬门（#138 / ADR-0034）：非当前主版本拒载，封死一切取用引擎的路径。
    // 同步读（构造函数无 await），先于任何惰性读盘——v1 库在第一次方法调用前就拒载。
    this.schema = assertSchemaVersion(this.paths.learnhubConfigPath)
    this.registry = new Registry(this.paths)
    this.store = new Store(this.paths)
    this.content = new Content(this.paths)
    this.bank = new QuestionBank(this.paths)
    this.concepts = new ConceptRegistry(this.paths)
    this.learnerCards = new LearnerCards(this.paths)
    this.errorCards = new ErrorCards(this.paths)
    this.skills = new Skills(this.paths)
    this.habits = new Habits(this.paths)
    this.noteManifest = new NoteSourceManifest(this.paths)
    this.ankiMirror = new AnkiMirror(this.paths)
    // 生长闸门注入（#146 插入/旁支调速）：三率流水在门面（账本/提案/练习），受理与
    // apply 双门经此回调消费同一份闸门判定。
    this.proposals = new GraphProposals(this.paths, this.store, this.registry, centerRoot,
      spec => this.growthGateErrors(spec))
    this.projects = new Projects(this.paths, this.store)
    this.sessions = new Sessions(this.paths, async course => this.loadView(course))
    this.lab = new LabSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      projects: this.projects, bank: this.bank,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      sedimentAppend: (kind, tier, payload, concept) => this.sedimentAppend(kind, tier, payload, concept),
      sedimentFold: () => this.sedimentFold(),
      sedimentRebuildProfile: () => this.sedimentRebuildProfile(),
    })
    this.channels = new ChannelsSubsystem({
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
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      loadPrompt: kind => this.loadPrompt(kind),
      questionView: (q, i, opts) => this.questionView(q, i, opts),
      judgeBankAnswer: (llmComplete, q, answer, op, ref) => this.judgeBankAnswer(llmComplete, q, answer, op, ref),
      refreshRepCard: (c, graph, node) => this.refreshRepCard(c, graph, node),
    })
    this.learner = new LearnerSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, projects: this.projects, habits: this.habits,
      skills: this.skills, learnerCards: this.learnerCards, noteManifest: this.noteManifest,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      loadPrompt: kind => this.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      sedimentSettle: () => this.sedimentSettle(),
      compassEtaRefresh: (courseKey, opts) => this.compassEtaRefresh(courseKey, opts),
      experimentPropose: (templateId, course) => this.experimentPropose(templateId, course),
      refreshSourceFingerprints: absPaths => this.refreshSourceFingerprints(absPaths),
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
    })
    this.bank2 = new BankSubsystem({
      store: this.store, paths: this.paths, registry: this.registry,
      bank: this.bank, errorCards: this.errorCards, concepts: this.concepts,
      proposals: this.proposals, content: Content, schedCache: this.schedCache,
      sched: courseRoot => this.sched(courseRoot),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      enabledCourses: () => this.enabledCourses(),
      scanCourseBanks: (c, fn) => this.scanCourseBanks(c, fn),
      loadPrompt: kind => this.loadPrompt(kind),
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      vaultPriorFor: (graph, node) => this.vaultPriorFor(graph, node),
      logGradingFailure: rec => this.logGradingFailure(rec),
      questionContext: (courseKey, node, qid, op) => this.questionContext(courseKey, node, qid, op),
      exerciseGated: (c, node) => this.exerciseGated(c, node),
      repairInvokesOnce: (llm, items, scope) => this.repairInvokesOnce(llm, items, scope),
      admitQuestion: (root, node, q, stem, existingStems) => this.admitQuestion(root, node, q, stem, existingStems),
      explainPoints: (c, graph, node) => this.explainPoints(c, graph, node),
      isNoteSourceCourse: courseKey => this.isNoteSourceCourse(courseKey),
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
    })
    this.content2 = new ContentSubsystem({
      store: this.store, paths: this.paths, registry: this.registry, bank: this.bank,
      content: this.content, sessions: this.sessions, learnerCards: this.learnerCards,
      vaultRoot: this.vaultRoot, jolRng: () => this.jolRng,
      assertNoteOk: (course, graph, broken, node, tool) => this.assertNoteOk(course, graph, broken, node, tool),
      bandDefault: () => this.bandDefault(),
      calibrationHintsConfig: () => this.calibrationHintsConfig(),
      collectNoteSourceCards: today => this.collectNoteSourceCards(today),
      enabledCourses: () => this.enabledCourses(),
      ensureNote: (root, graph, node) => this.ensureNote(root, graph, node),
      errorCardTriples: (courses, nodeFilter) => this.errorCardTriples(courses, nodeFilter),
      exerciseGated: (c, node) => this.exerciseGated(c, node),
      expTag: (courseName, node, qid, today) => this.expTag(courseName, node, qid, today),
      isNoteSourceCourse: courseKey => this.isNoteSourceCourse(courseKey),
      jolConfig: () => this.jolConfig(),
      jolPredicted: p => this.jolPredicted(p),
      judgeBankAnswer: (llmComplete, q, answer, op, ref) => this.judgeBankAnswer(llmComplete, q, answer, op, ref),
      learningDay: () => this.learningDay(),
      loadView: course => this.loadView(course),
      logGradingFailure: rec => this.logGradingFailure(rec),
      nodeNote: (c, graph, node) => this.nodeNote(c, graph, node),
      nof1QueueEffect: today => this.nof1QueueEffect(today),
      noteSourceAnswer: (llmComplete, sourceId, qid, answer, opts) => this.noteSourceAnswer(llmComplete, sourceId, qid, answer, opts),
      noteSourceForget: (sourceId, qid) => this.noteSourceForget(sourceId, qid),
      noteSourceRate: (sourceId, qid, r) => this.noteSourceRate(sourceId, qid, r),
      questionContext: (courseKey, node, qid, op) => this.questionContext(courseKey, node, qid, op),
      questionView: (q, i, opts) => this.questionView(q, i, opts),
      refreshRepCard: (c, graph, node) => this.refreshRepCard(c, graph, node),
      resolveNote: (vaultRoot, input, centerRel) => this.resolveNote(vaultRoot, input, centerRel),
      saveNodeNote: (path, fm, body) => this.saveNodeNote(path, fm, body),
      sched: courseRoot => this.sched(courseRoot),
      updateNoteFm: (path, fm) => this.updateNoteFm(path, fm),
      vaultPriorFor: (graph, node) => this.vaultPriorFor(graph, node),
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
  }

  /** 当前学习日与生效日界（ADR-0020）：learnhub.json 现读（与 jol 同款每次现读），
   * 一切调度/结算/「今日」视图的学习日单点——出处戳（generated_at/trained_at 等）
   * 不属于学习口径，不经这里。 */
  private async learningDay(): Promise<{ today: string; cutoff: number }> {
    const cutoff = await readDayCutoff(this.paths)
    return { today: todayStr(new Date(), cutoff), cutoff }
  }

  // ---- 加载与解析 ----

  /** 单课完整视图：图 + frontmatter 状态（每次现读，文件量小，天然最新）。 */
  async loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }> {
    const store = new GraphStore(this.paths, this.paths.courseRoot(course.root))
    const regions = await store.load()
    const graph = new Graph(regions)
    const { state, broken } = await stateMap(this.paths.courseDir(course.root))
    return { graph, state, broken }
  }

  async enabledCourses(): Promise<CourseEntry[]> {
    return this.registry.enabled()
  }

  async resolveCourse(key?: string): Promise<CourseEntry> {
    return this.registry.resolve(key)
  }

  /** 课程条目精确查找（name 或 id）：不存在返回 null，不抛——注册表清扫等存在性判定用
   * （区别于 resolveCourse 的 fail loud）；停用课程不算缺失，内容仍在。 */
  async courseByKey(key: string): Promise<CourseEntry | null> {
    return this.registry.get(key)
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
    for (const c of await this.enabledCourses()) {
      const { graph } = await this.loadView(c)
      if (graph.nset.has(nodeSpec)) hits.push(c)
    }
    if (!hits.length) throw new Error(`[learnhub] 启用课程中找不到节点「${nodeSpec}」。`)
    if (hits.length > 1) throw new Error(`[learnhub] 节点「${nodeSpec}」在多门课程中存在，请用「课程/节点」指定：${hits.map(h => h.name).join('、')}`)
    return { course: hits[0], node: nodeSpec }
  }

  /** Broken 笔记的路径定位（按规范路径精确匹配，不按 node 名猜）。 */
  private findBrokenNote(root: string, graph: Graph, node: string, broken: BrokenNote[]): BrokenNote | undefined {
    const expected = this.paths.courseNotePath(root, graph.blockOf[node]?.[1], node)
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
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    if (existsSync(path)) {
      const { fm: rawFm } = await loadNote(path)
      const checked = validateNoteFrontmatter(rawFm)
      const detail = checked.errors.length ? checked.errors.join('；') : '状态未通过 frontmatter 契约（可运行 learnhub_data_check 定位）'
      throw new Error(`[learnhub] 笔记文件已存在但 Broken，拒绝覆盖（位置：${path}）\n  ✗ ${detail}`)
    }
    const fm = defaultFrontmatter(node)
    await saveNote(path, fm as unknown as Record<string, unknown>, '> 内容待生成。\n')
    return fm
  }

  // ---- status / recommend ----

  /** 只读数据体检：盘点 Missing/Broken，不做任何修复或清理。 */
  async dataCheck(): Promise<DataCheckReport> {
    return dataCheck(this.paths)
  }
  /** 题库内容体检（ADR-0029/0030 存量盘点）：只读扫描全部课程题库与笔记源镜像题库，
   * 按现行契约标出违规存量题——表达式/数字填空、记法违规（裸 ^/_/LaTeX 命令）、
   * 转义损坏、超长解析。零写入零修复，清单供人工决定走归档重生成/定向补题。 */
  async questionAudit(): Promise<QuestionAuditReport> {
    const report: QuestionAuditReport = { banks: 0, questions: 0, flagged: 0, findings: [] }
    const scanBankFile = async (courseName: string, path: string): Promise<void> => {
      let text: string
      try {
        text = await readFile(path, 'utf8')
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
        files = (await readdir(dir)).filter(f => f.endsWith('.yaml'))
      } catch {
        continue // 课程还没有题库 = 合法空
      }
      for (const f of files) await scanBankFile(entry.name, `${dir}/${f}`)
    }
    const nsDir = `${this.paths.noteSourceDir}/题库`
    try {
      for (const f of (await readdir(nsDir)).filter(f => f.endsWith('.yaml'))) {
        await scanBankFile('（笔记源镜像）', `${nsDir}/${f}`)
      }
    } catch {
      // 无笔记源镜像 = 合法空
    }
    return report
  }


  /** 完成宣告折叠（#142 雾区条款上半，读侧零写副作用）：终点锚缺失 = null
   * （未播种，无从宣告）；锚 Broken fail loud——锚无直改通道，手改损坏必须显式浮出。 */
  async courseCompletion(course: { name: string; root: string }): Promise<CompletionFold | null> {
    const anchor = await readAnchor(this.paths.anchorPath(course.root))
    if (!anchor) return null
    const { graph, state } = await this.loadView(course)
    return foldCompletion(graph, state, anchor)
  }

  async statusJson(): Promise<StatusDoc> {
    const { today, cutoff } = await this.learningDay()
    const [stats, diagnostics] = await Promise.all([this.bankSnapshot(today), this.diagnosticsAdvice(today)])
    const courses = await this.enabledCourses()
    const doc = await this.sessions.statusJson(courses, stats, today, fmtCutoff(cutoff))
    // 内容诊断建议项（#69 B1）：每课程附 diagnostics（信号/理由/证据 + 重写与讲解直达入口）
    for (const course of doc.courses as Array<Record<string, unknown>>) {
      const items = diagnostics.filter(d => d.course === course.name)
      if (items.length) course.diagnostics = items.map(d => diagnosticView(d))
    }
    // 完成宣告（#142 雾区条款上半）：完成判据读侧折叠（能力=终点 mastery≥阈值且闭包健康；
    // 覆盖=块工作表+终点），面板宣告——零写侧状态、零专门停机代码
    for (const entry of courses) {
      const course = (doc.courses as Array<Record<string, unknown>>).find(c => c.name === entry.name)
      if (!course) continue
      const completion = await this.courseCompletion(entry)
      if (completion) course.completion = completion
      // 教练回合触发点·会话开始（#144）：learnhub_status / 面板 /api/status 是会话开工
      // 的汇总入口——逐课程附就绪深度检查（读侧感知，ready=0 只告警不阻塞）
      course.coach = await this.coachCheckFor(entry, today)
      // 插入实验面（#146）：在途插入节点（面板「实验中」标记取数）、到期未决、
      // 三率（滚动 30 学习日）与韧性闸门现势——插入积极性对学习者透明
      course.probation = await this.probationViewFor(entry, today, cutoff)
    }
    return doc
  }

  async recommend(limit = 5): Promise<RecommendDoc> {
    const { today } = await this.learningDay()
    const [stats, window, diagnostics, pins, sleep] = await Promise.all([
      this.bankSnapshot(today), this.struggleWindow(today), this.diagnosticsAdvice(today), this.store.loadPins(),
      this.sleepAdviceConfig(),
    ])
    const events = await this.sessions.recommendEvents(await this.enabledCourses(), stats, today, limit, window, diagnostics, pins, sleep.enabled)
    return { date: today, events }
  }

  // ---- 「今天学它」pin（E3 #67 / ADR-0009 Learner Output）----

  // 以下 E3pin/E4jol/U4kata/E5coach/E2explain/E1cards/SC/Uskill/Ureceipt/Uhabit 十节方法体住 LearnerSubsystem（learner-cards.ts，#152 刀 4 聚合+转发）

  async pinToday(courseKey: string | undefined, node: string, today?: string, intention?: GoalIntentionInput): Promise<{ course: string; node: string; date: string; intention?: ExecutionIntention }> {
    return this.learner.pinToday(courseKey, node, today, intention)
  }

  async setGoalIntention(courseKey: string | undefined, node: string, intention: GoalIntentionInput | null, today?: string): Promise<{ course: string; node: string; intention: ExecutionIntention | null }> {
    return this.learner.setGoalIntention(courseKey, node, intention, today)
  }

  async unpinToday(courseKey: string | undefined, node: string, today?: string): Promise<{ course: string; node: string; pinned: false }> {
    return this.learner.unpinToday(courseKey, node, today)
  }

  async diagnosticsAdvice(today?: string): Promise<DiagnosticItem[]> {
    return this.learner.diagnosticsAdvice(today)
  }

  private async struggleWindow(today: string): Promise<Map<string, Map<string, WindowStat>>> {
    return this.learner.struggleWindow(today)
  }

  private async scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void> {
    await this.learner.scanCourseBanks(c, fn)
  }

  private async bankSnapshot(today: string): Promise<Map<string, NodeStat[]>> {
    return this.learner.bankSnapshot(today)
  }
  // ---- doctor（fm schema 对账） ----

  async doctor(): Promise<DoctorDoc> {
    const courses = []
    for (const c of await this.enabledCourses()) {
      const { graph, state, broken } = await this.loadView(c)
      const missing = graph.names.filter(n => !state[n])
      const unknown = Object.keys(state).filter(n => !graph.nset.has(n))
      courses.push({
        course: c.name,
        total: graph.names.length,
        notes: Object.keys(state).length,
        broken: broken.map(b => ({ path: b.path, ...(b.node ? { node: b.node } : {}), reason: b.reason })),
        missing,
        unknown,
      })
    }
    return { generated_at: nowIso(), courses }
  }

  // ---- rebuild（audit + 就绪清单） ----

  async rebuild(courseKey?: string): Promise<{ message: string }> {
    const targets = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const lines: string[] = []
    let failed = false
    for (const c of targets) {
      const { graph, state } = await this.loadView(c)
      const regions = graph.regions
      const audit = await runAudit(this.paths, c.root, c.name, graph, regions, (await this.learningDay()).today)
      if (audit.failed) failed = true
      lines.push(`[${c.name}] 审计：ERROR ${audit.errors.length} | WARN ${audit.warns.length} | INFO ${audit.infos.length}${audit.failed ? '（阻断）' : ''}`)
      const done = new Set(Object.entries(state).filter(([, f]) => ['review', 'mastered', 'skipped'].includes(f.stage)).map(([n]) => n))
      await writeReadyList(this.paths, c.root, graph, done)
    }
    if (failed) throw new Error(`[rebuild] 审计存在 ERROR：\n${lines.join('\n')}`)
    return { message: `[rebuild] 完成：\n${lines.join('\n')}` }
  }

  // ---- graph analyze ----

  // 以下 graph analyze/Vault 链接先验/图探索/提案门禁包装/enc 回填 五节方法体住 GraphSubsystem（graph-subsystem.ts，#152 刀 7 聚合+转发）

  async graphAnalyze(
    courseKey?: string, elementsOnly = false,
  ): Promise<GraphDoc | GraphElementsDoc> {
    return this.graph.graphAnalyze(courseKey, elementsOnly)
  }
  // ---- Vault 链接先验（V-2 #91：wikilink → 无向关联对 → analyze 展示 + 单提案人审）----

  async vaultLinksScan(): Promise<{
    generated_at: string
    scanned_files: number
    truncated: boolean
    links_seen: number
    unresolved: number
    audit: VaultLinksDoc['audit']
    tiers: { proposal: number; review: number; report: number }
    edges: Array<{ a: string; b: string; count: number; files: number; w: number; tier: string }>
    cache: string
  }> {
    return this.graph.vaultLinksScan()
  }

  async graphLinkBackfill(courseKey?: string): Promise<{
    course: string
    scanned_edges: number
    mapped: number
    ops: number
    proposal: { id: number } | null
    blocked_no_pre: Array<{ a: string; b: string; w: number; why: string }>
    skipped_declared: number
    message: string
  }> {
    return this.graph.graphLinkBackfill(courseKey)
  }
  // ---- 图探索（agent 逐步查询，不拉全图）----

  async graphNode(courseKey: string | undefined, node: string): Promise<GraphNodeDoc> {
    return this.graph.graphNode(courseKey, node)
  }

  async graphBrowse(courseKey: string | undefined, region?: string, block?: string): Promise<GraphBrowseDoc> {
    return this.graph.graphBrowse(courseKey, region, block)
  }

  async graphPath(courseKey: string | undefined, from: string, to: string): Promise<GraphPathResult> {
    return this.graph.graphPath(courseKey, from, to)
  }
  // ---- 提案门禁包装（apply 前 audit 拦截） ----

  async graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult> {
    return this.graph.graphPropose(kind, yamlText)
  }

  async graphApply(kind: 'edit' | 'seed' | 'enrich', pid?: number): Promise<GraphApplyResult> {
    return this.graph.graphApply(kind, pid)
  }

  async graphReject(pid: number, note = ''): Promise<ProposalRec> {
    return this.graph.graphReject(pid, note)
  }

  async seedPropose(
    input: SeedDraftRequest,
    llm: LlmComplete,
  ): Promise<{ id: number; course: string; mode: 'new' | 'reseed'; goal_type: string; endpoint: string; starts: number; prior_hits: number; repaired: boolean }> {
    return this.graph.seedPropose(input, llm)
  }

  async conceptMerge(courseKey: string, from: string, into: string): Promise<{ course: string; into: string; names: string[] }> {
    return this.graph.conceptMerge(courseKey, from, into)
  }
  // ---- enc 覆盖层回填（kind=enrich，#140：出生/覆盖层分家；原 edit 通道随分家转富化）----

  async graphEncBackfill(courseKey?: string): Promise<GraphEncBackfillResult> {
    return this.graph.graphEncBackfill(courseKey)
  }

  async graphProposals(status?: string, kind?: string): Promise<ProposalRec[]> {
    return this.graph.graphProposals(status, kind)
  }

  async proposalApply(
    kind: string, pid?: number,
  ): Promise<GraphApplyResult | ProjectApplyResult | ExperimentStartResult> {
    return this.graph.proposalApply(kind, pid)
  }

  async projectApply(pid: number): Promise<ProjectApplyResult> {
    return this.graph.projectApply(pid)
  }
  // ---- 项目域（P 区 / ADR-0015；#92）----

  // 以下 项目域/过点对账/执行事件流/目标反编译 四节方法体住 ProjectSubsystem（projects.ts，#152 刀 5 聚合+转发）

  async projectCreate(input: { name: string; goal: string; tier?: FadingTier; id?: string }): Promise<ProjectFm> {
    return this.project.projectCreate(input)
  }

  async projectList(): Promise<ProjectFm[]> {
    return this.project.projectList()
  }

  async projectShow(id: string): Promise<ProjectView> {
    return this.project.projectShow(id)
  }

  async projectLogAppend(id: string, text: string, today?: string): Promise<{ project: string; path: string; day: string }> {
    return this.project.projectLogAppend(id, text, today)
  }

  async projectLog(id: string): Promise<{ project: string; path: string; log: string | null }> {
    return this.project.projectLog(id)
  }

  private async refreshSourceFingerprints(absPaths: string[]): Promise<void> {
    await this.project.refreshSourceFingerprints(absPaths)
  }

  async projectSetLifecycle(id: string, lifecycle: string): Promise<ProjectFm> {
    return this.project.projectSetLifecycle(id, lifecycle)
  }

  async projectSetTier(id: string, tier: string): Promise<ProjectFm> {
    return this.project.projectSetTier(id, tier)
  }

  async projectPlanPack(id: string): Promise<string> {
    return this.project.projectPlanPack(id)
  }

  async projectPlanPropose(id: string, yamlText: string) {
    return this.project.projectPlanPropose(id, yamlText)
  }

  async projectMilestonePack(id: string, milestoneId: string): Promise<string> {
    return this.project.projectMilestonePack(id, milestoneId)
  }

  async projectMilestoneWrite(id: string, milestoneId: string, md: string): Promise<
    { written: string; tier: FadingTier } | { proposed: number; kind: 'project_milestone'; file: string }
  > {
    return this.project.projectMilestoneWrite(id, milestoneId, md)
  }
  // ---- 过点对账 / 检索点 / 行为推断 enc（P-3/P-4/P-6；#94/#93/#96）----

  async projectMilestonePass(
    id: string, milestoneId: string,
  ): Promise<{ project: string; milestone: string; name: string; xp: number; detail: string }> {
    return this.project.projectMilestonePass(id, milestoneId)
  }

  async projectMilestoneRecall(
    id: string, milestoneId: string, opts: { nodes?: string[]; limit?: number } = {},
  ): Promise<{ project: string; milestone: string; file: string; questions: Array<RecallQuestion & { answer: BankQuestion['answer']; options?: string[]; explanation?: string }> }> {
    return this.project.projectMilestoneRecall(id, milestoneId, opts)
  }

  async projectRecallReflect(id: string, milestoneId: string, narration: string): Promise<{ project: string; milestone: string; recorded: true }> {
    return this.project.projectRecallReflect(id, milestoneId, narration)
  }

  async projectRecallLog(id: string): Promise<RecallRec[]> {
    return this.project.projectRecallLog(id)
  }
  // ---- 执行事件流 / Mastery 交叉 2×2（P-7 / #98 / ADR-0015 §3/§4/§8）----

  async projectExecLog(
    id: string,
    input: { source: string; rating?: number; evidence?: ExecutionEvidence; nodes?: string[]; note?: string },
  ): Promise<ProjectExecResult> {
    return this.project.projectExecLog(id, input)
  }

  async projectCrossView(id: string): Promise<ProjectCrossDoc> {
    return this.project.projectCrossView(id)
  }

  async projectEncCandidates(
    id: string, opts: { milestone?: string; nodes?: string[]; window_days?: number; min_co?: number } = {},
  ): Promise<{
    project: string; window: { start: string; end: string; days: number }
    events: number; candidates: Array<{ course: string; holder: string; skill: string; co: number; w: number }>
    blocked_no_pre: Array<{ course: string; a: string; b: string; co: number; hint_skill: string; why: string }>
    proposals: Array<{ course: string; id: number; ops: number }>; skipped_declared: number
  }> {
    return this.project.projectEncCandidates(id, opts)
  }
  // ---- 目标反编译（P-5 / #95：逆向设计 + PjBL；v8 种子簇形态 #149）----

  async projectDecompile(
    id: string,
    opts: { goal?: string; course?: string; notes?: string[] } = {},
    llm: LlmComplete,
  ): Promise<{
    project: string
    prior_hits: number
    notes: string[]
    repaired: boolean
    plan_proposal: { id: number; kind: 'project_plan'; project: string; milestones: number; initial: boolean }
    seed_proposal: { id: number; kind: 'seed'; course: string; endpoint: string; starts: number } | null
    pair: { plan: number; seed: number | null }
  }> {
    return this.project.projectDecompile(id, opts, llm)
  }

  async projectDecompileApply(planPid: number, seedPid: number): Promise<{
    project: string
    seed: Record<string, unknown> | null
    plan: ProjectApplyResult | null
  }> {
    return this.project.projectDecompileApply(planPid, seedPid)
  }

  private async seedAuditFor(courseName: string, today: string): Promise<ApplyAudit> {
    return this.project.seedAuditFor(courseName, today)
  }

  async applyProjectPlanProposal(
    pid?: number, opts: { pairApply?: boolean } = {},
  ): Promise<ProjectApplyResult> {
    return this.project.applyProjectPlanProposal(pid, opts)
  }
  // ---- 内容管线 ----

  // 以下 内容管线/note resolve/课程工作区 三节方法体住 ContentSubsystem（content-subsystem.ts，#152 刀 8 聚合+转发）

  private async vaultPriorFor(graph: Graph, node: string): Promise<string> {
    return this.content2.vaultPriorFor(graph, node)
  }

  async contentPack(courseKey: string | undefined, node: string): Promise<string> {
    return this.content2.contentPack(courseKey, node)
  }

  async loadPrompt(kind: string): Promise<string> {
    return this.content2.loadPrompt(kind)
  }

  async promptKinds(): Promise<string[]> {
    return this.content2.promptKinds()
  }

  async contentVersion(courseKey: string | undefined, node: string): Promise<number> {
    return this.content2.contentVersion(courseKey, node)
  }

  async contentTierOf(courseKey: string | undefined, node: string): Promise<ComplexityTier> {
    return this.content2.contentTierOf(courseKey, node)
  }

  async contentCheck(courseKey: string | undefined, node: string): Promise<{ passed: boolean; findings: string[]; warns: string[] }> {
    return this.content2.contentCheck(courseKey, node)
  }

  async contentApply(courseKey: string | undefined, node: string, body: string): Promise<{ version: number; message: string; hints: string[] }> {
    return this.content2.contentApply(courseKey, node, body)
  }

  async contentOutline(courseKey: string | undefined, node: string, yamlText: string): Promise<SectionManifest[]> {
    return this.content2.contentOutline(courseKey, node, yamlText)
  }

  async contentReset(courseKey: string | undefined): Promise<{ course: string; nodes: string[]; trashed: string[]; sediment: string }> {
    return this.content2.contentReset(courseKey)
  }

  async contentSection(courseKey: string | undefined, node: string, sectionId: string, md: string): Promise<{ version: number; title: string; hints: string[] }> {
    return this.content2.contentSection(courseKey, node, sectionId, md)
  }

  async contentSectionsView(courseKey: string | undefined, node: string): Promise<Array<SectionManifest & { md: string | null; tierLabel: string }>> {
    return this.content2.contentSectionsView(courseKey, node)
  }

  async contentFeedback(courseKey: string | undefined, node: string): Promise<string> {
    return this.content2.contentFeedback(courseKey, node)
  }

  async contentReview(courseKey: string | undefined, node: string): Promise<string> {
    return this.content2.contentReview(courseKey, node)
  }

  async contentQueue(courseKey: string | undefined, node: string): Promise<string> {
    return this.content2.contentQueue(courseKey, node)
  }

  async queueItemsAll(): Promise<QueueItem[]> {
    return this.content2.queueItemsAll()
  }

  async lesson(courseKey: string | undefined, node: string): Promise<LessonDoc> {
    return this.content2.lesson(courseKey, node)
  }
  // ---- note resolve / 反馈区读取 ----

  async resolveNote(vaultRoot: string, input: string, centerRel: string): Promise<{ path: string; node: string; course: string }> {
    return this.content2.resolveNote(vaultRoot, input, centerRel)
  }

  async feedbackBody(absPath: string): Promise<string | null> {
    return this.content2.feedbackBody(absPath)
  }

  async submitFeedback(vaultRoot: string, centerRel: string, input: string): Promise<string> {
    return this.content2.submitFeedback(vaultRoot, centerRel, input)
  }
  // ---- P4：课程工作区（树形）与题库 ----

  async coursesTree(courseKey?: string): Promise<TreeDoc> {
    return this.content2.coursesTree(courseKey)
  }

  private questionView(q: BankQuestion, i: number, opts?: { today?: string }): Record<string, unknown> {
    return this.content2.questionView(q, i, opts)
  }

  async questions(courseKey: string | undefined, node: string): Promise<QuestionsDoc> {
    return this.content2.questions(courseKey, node)
  }

  async reviewQueue(
    courseKey?: string, node?: string, today?: string, bandPref?: BandPref,
  ): Promise<ReviewQueueDoc> {
    return this.content2.reviewQueue(courseKey, node, today, bandPref)
  }

  async questionSave(courseKey: string | undefined, node: string, yamlText: string): Promise<{ node: string; count: number; path: string }> {
    return this.content2.questionSave(courseKey, node, yamlText)
  }

  async questionAnswer(
    llmComplete: LlmComplete,
    courseKey: string | undefined, node: string, qid: string, answer: string,
    elapsedS?: number | null,
    opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null },
  ): Promise<AnswerResult> {
    return this.content2.questionAnswer(llmComplete, courseKey, node, qid, answer, elapsedS, opts)
  }

  private async judgeBankAnswer(
    llmComplete: LlmComplete,
    q: BankQuestion, answer: string, op = 'question',
    ref: { course: string; node: string; qid: string },
  ): Promise<{ score: number; feedback: string }> {
    return this.content2.judgeBankAnswer(llmComplete, q, answer, op, ref)
  }

  private async logGradingFailure(rec: {
    course: string; node: string; qid: string; kind: string; attempt: number; error: string; raw: string
  }): Promise<void> {
    await this.content2.logGradingFailure(rec)
  }

  private async questionContext(courseKey: string | undefined, node: string, qid: string, op: string) {
    return this.content2.questionContext(courseKey, node, qid, op)
  }

  private async nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }> {
    return this.content2.nodeNote(c, graph, node)
  }

  private async saveNodeNote(path: string, fm: Fm, body: string): Promise<void> {
    await this.content2.saveNodeNote(path, fm, body)
  }

  async questionRate(
    courseKey: string | undefined, node: string, qid: string, rating: number,
  ): Promise<QuestionRateResult> {
    return this.content2.questionRate(courseKey, node, qid, rating)
  }

  async questionForget(
    courseKey: string | undefined, node: string, qid: string,
    elapsedS?: number | null, predicted?: JolPrediction | null,
  ): Promise<QuestionForgetResult> {
    return this.content2.questionForget(courseKey, node, qid, elapsedS, predicted)
  }

  private async refreshRepCard(c: CourseEntry, graph: Graph, node: string): Promise<Fm | null> {
    return this.content2.refreshRepCard(c, graph, node)
  }
  // ---- C1 笔记复习源（#59 / ADR-0010：只出题不动文，派生物落镜像区）----

  // 以下 C1/卡池镜像/漂移治理/排除清单/Anki 通道的方法体住 ChannelsSubsystem（note-source.ts，#152 刀 3 聚合+转发）

  private async isNoteSourceCourse(courseKey: string | undefined): Promise<boolean> {
    return this.channels.isNoteSourceCourse(courseKey)
  }

  async noteSourceRegister( input: string, today?: string, ): Promise<NoteSourceRegisterResult> {
    return this.channels.noteSourceRegister(input, today)
  }

  async noteSourceList(today?: string): Promise<NoteSourceDoc> {
    return this.channels.noteSourceList(today)
  }

  async noteSourceUnregister(id: string): Promise<{ removed: string; path: string }> {
    return this.channels.noteSourceUnregister(id)
  }
  // ---- 卡池镜像（V-4 #108：Obsidian backlink 通道）----


  // ---- 漂移治理全量化（V-6 #109：改名/移动 → relink 或 Missing）----

  async noteSourceRelink(id: string, input: string, today?: string): Promise<{ id: string; from: string; to: string }> {
    return this.channels.noteSourceRelink(id, input, today)
  }
  // ---- 用户排除清单（V-1 #86：state/learnhub.json 的 note_source_excludes）----

  async noteSourceExcludes(): Promise<{ excludes: string[] }> {
    return this.channels.noteSourceExcludes()
  }

  async noteSourceExclude(input: string): Promise<{ excludes: string[] }> {
    return this.channels.noteSourceExclude(input)
  }

  async noteSourceUnexclude(input: string): Promise<{ excludes: string[] }> {
    return this.channels.noteSourceUnexclude(input)
  }

  private async admitQuestion( root: string, node: string, q: Record<string, unknown>, stem: string, existingStems: Array<{ q: string; kind?: string; difficulty?: number }>, ): Promise<{ verdict: 'added' } | { verdict: 'duplicate'; against: string } | { verdict: 'invalid' }> {
    return this.channels.admitQuestion(root, node, q, stem, existingStems)
  }

  private async repairInvokesOnce( llm: LlmComplete, items: unknown[], scope: string[], ): Promise<number> {
    return this.channels.repairInvokesOnce(llm, items, scope)
  }

  async noteSourceGenerate( id: string, count: number | undefined, llm: LlmComplete, today?: string, ): Promise<{ id: string; added: number; skipped: number; total: number; duplicates: Array<{ q: string; against: string }> }> {
    return this.channels.noteSourceGenerate(id, count, llm, today)
  }

  private async collectNoteSourceCards( today: string, ): Promise<{ cards: Array<Record<string, unknown>>; drifted: Array<Record<string, unknown>>; suspended: Array<Record<string, unknown>> }> {
    return this.channels.collectNoteSourceCards(today)
  }

  private async noteSourceAnswer( llmComplete: LlmComplete, sourceId: string, qid: string, answer: string, opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null; elapsed_s?: number | null }, ): Promise<Record<string, unknown>> {
    return this.channels.noteSourceAnswer(llmComplete, sourceId, qid, answer, opts)
  }

  private async noteSourceRate(sourceId: string, qid: string, r: number): Promise<Record<string, unknown>> {
    return this.channels.noteSourceRate(sourceId, qid, r)
  }

  private async noteSourceForget(sourceId: string, qid: string): Promise<Record<string, unknown>> {
    return this.channels.noteSourceForget(sourceId, qid)
  }
  // ---- C2 Anki 通道（#63 / ADR-0011：Anki 纯作答通道，vault 唯一调度者）----

  async ankiExportPush(transport: AnkiTransport, today?: string): Promise<{ date: string; added: number; updated: number; removed: number; total: number; decks: string[] }> {
    return this.channels.ankiExportPush(transport, today)
  }

  async ankiImportEvents(transport: AnkiTransport, opts?: { nowMs?: number }): Promise<{ imported: number; advanced: number; skipped_same_day: number; skipped_unknown: number; unknown: string[] }> {
    return this.channels.ankiImportEvents(transport, opts)
  }

  async ankiStatus(transport?: AnkiTransport, today?: string): Promise<AnkiStatusDoc> {
    return this.channels.ankiStatus(transport, today)
  }
  // ---- 节点跳过 / 完成确认 ----

  // 以下 跳过/完成确认、XP 账本、记忆健康、优化器、沉淀层 五节方法体住 SchedSubsystem（sched-subsystem.ts，#152 刀 9 聚合+转发）

  async nodeSkip(courseKey: string | undefined, node: string, skipped: boolean): Promise<{ course: string; node: string; stage: Stage; archived?: number }> {
    return this.sched2.nodeSkip(courseKey, node, skipped)
  }

  async nodeComplete(courseKey: string | undefined, node: string, force = false): Promise<{
    accepted: boolean; accuracy: number | null; course: string; node: string
    stage?: Stage; initialized?: number; due?: string | null; reason?: string
    coach?: CoachCheck
  }> {
    return this.sched2.nodeComplete(courseKey, node, force)
  }
  // ---- XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注） ----

  async xpStatus(): Promise<XpStatus> {
    return this.sched2.xpStatus()
  }

  async setDailyGoal(goal: number): Promise<{ goal: number }> {
    return this.sched2.setDailyGoal(goal)
  }

  async setDayCutoff(value: string): Promise<{ day_cutoff: string }> {
    return this.sched2.setDayCutoff(value)
  }
  // ---- 记忆健康仪表盘（#61 A2 / ADR-0012）----

  async memoryHealth(today?: string): Promise<MemoryHealthDoc> {
    return this.sched2.memoryHealth(today)
  }
  // ---- E4 JOL 抽查配置（state/learnhub.json 的 jol 字段；默认开、约 1/3）----

  async jolConfig(): Promise<{ enabled: boolean; rate: number }> {
    return this.learner.jolConfig()
  }

  async setJolConfig(patch: { enabled?: boolean; rate?: number }): Promise<{ enabled: boolean; rate: number }> {
    return this.learner.setJolConfig(patch)
  }
  // ---- D1 N-of-1 实验引擎（#110 / ADR-0023）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  experimentTemplates(): Promise<Nof1Template[]> {
    return this.lab.experimentTemplates()
  }

  async experimentList(): Promise<ExperimentDef[]> {
    return this.lab.experimentList()
  }

  async experimentPropose(
    templateId: string, course?: string,
  ): Promise<{ proposal: number; template: string; title: string; pool: number; scope_course: string | null }> {
    return this.lab.experimentPropose(templateId, course)
  }

  async experimentApply(pid?: number): Promise<{ id: number; title: string; arm_today: string }> {
    return this.lab.experimentApply(pid)
  }

  async experimentStop(id?: number): Promise<ExperimentDef> {
    return this.lab.experimentStop(id)
  }

  async experimentReport(id?: number): Promise<{ experiment: ExperimentDef; analysis: Nof1Analysis }> {
    return this.lab.experimentReport(id)
  }

  private async nof1QueueEffect(
    today: string,
  ): Promise<{ id: number; variable: Nof1Variable; arm: string } | null> {
    return this.lab.nof1QueueEffect(today)
  }

  private async expTag(
    courseName: string, node: string, qid: string, today: string,
  ): Promise<{ id: number; arm: string } | null> {
    return this.lab.expTag(courseName, node, qid, today)
  }

  // ---- U4 周复盘 Weekly Kata（#114 / ADR-0026：Learner Output，零 XP 零 canonical）----

  async kataOpen(weekStart?: string): Promise<KataDoc> {
    return this.learner.kataOpen(weekStart)
  }

  async kataSave(weekStart: string, answers: Partial<Record<KataAnswer, string>>): Promise<KataDoc> {
    return this.learner.kataSave(weekStart, answers)
  }

  async kataToExperiment(weekStart: string, templateId: string, course?: string): Promise<{ proposal: number; title: string; week_start: string }> {
    return this.learner.kataToExperiment(weekStart, templateId, course)
  }

  async kataToIntention(
    weekStart: string, input: { course: string; node: string; cue: string; action: string },
  ): Promise<{ course: string; node: string; week_start: string }> {
    return this.learner.kataToIntention(weekStart, input)
  }

  /** → LearnerSubsystem（tests 直接消费路径拼装，S45 接缝）。 */
  private kataPath(weekStart: string): string {
    return this.learner.kataPath(weekStart)
  }

  async kataList(): Promise<Array<{ week_start: string; answered: boolean }>> {
    return this.learner.kataList()
  }
  // ---- D2 挑战点恒温器（#111 / ADR-0024）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  async bandDefault(): Promise<BandPref | null> {
    return this.lab.bandDefault()
  }

  async setBandDefault(band: string | null): Promise<{ band_default: BandPref | null }> {
    return this.lab.setBandDefault(band)
  }

  async thermostatView(today?: string): Promise<ThermostatDoc> {
    return this.lab.thermostatView(today)
  }

  async thermostatApply(suggestionId: string): Promise<{ applied: string; band_default: BandPref | null }> {
    return this.lab.thermostatApply(suggestionId)
  }

  // ---- D3 沙盘（#112 / ADR-0025）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  async sandboxRun(input: {
    minutesPerDay: number
    weeks?: number
    course?: string
    nodes?: string[]
  }): Promise<SandboxDoc> {
    return this.lab.sandboxRun(input)
  }

  private sandboxPopulation(
    courses: CourseEntry[], nodeFilter: Set<string> | null,
  ): Promise<{ cards: SandboxCard[]; nodes: SandboxNode[]; scheds: Map<string, FSRS> }> {
    return this.lab.sandboxPopulation(courses, nodeFilter)
  }

  private mcAggregate(
    plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string,
    scheds: Map<string, FSRS>, fallbackCourse: string,
  ): { curve: SandboxCurvePoint[]; map: Array<{ node: string; p50: number; p80: number }> } {
    return this.lab.mcAggregate(plan, cards, nodes, today, scheds, fallbackCourse)
  }

  // ---- 罗盘（#143 / ADR-0033 透明度装置：常驻非承诺路线草图）----

  // 以下 罗盘/教练回合/生长批受理/复诊 四节方法体住 GrowthSubsystem（growth-subsystem.ts，#152 刀 11 聚合+转发）

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
    return this.growth2.compassRead(courseKey)
  }

  async compassTail(courseKey: string): Promise<string> {
    return this.growth2.compassTail(courseKey)
  }

  async compassPaint(courseKey: string | undefined, llm: LlmComplete): Promise<{
    course: string; path: string; route_lines: number; annotations_preserved: boolean; repainted: boolean
  }> {
    return this.growth2.compassPaint(courseKey, llm)
  }

  async compassRewrite(
    courseKey: string, routeMd: string,
  ): Promise<{ course: string; path: string; route_lines: number }> {
    return this.growth2.compassRewrite(courseKey, routeMd)
  }

  async compassEtaRefresh(
    courseKey?: string, opts: { today?: string; force?: boolean } = {},
  ): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string; eta?: CompassEta }>> {
    return this.growth2.compassEtaRefresh(courseKey, opts)
  }
  // ---- 教练回合感知面（#144 / ADR-0033 滚动教练：触发三点 × 就绪深度 × 六区块上下文包）----

  private async coachCheckFor(c: CourseEntry, today: string): Promise<CoachCheck> {
    return this.growth2.coachCheckFor(c, today)
  }

  async coachCheckpoint(
    trigger: CoachTrigger, courseKey?: string, opts: { today?: string } = {},
  ): Promise<{ trigger: CoachTrigger; courses: CoachCheck[] }> {
    return this.growth2.coachCheckpoint(trigger, courseKey, opts)
  }

  async coachContextPack(
    courseKey?: string, opts: { lightweight?: boolean; today?: string; packLabel?: string } = {},
  ): Promise<string> {
    return this.growth2.coachContextPack(courseKey, opts)
  }
  // ---- 生长批受理（#145 / ADR-0033 滚动教练：教练回合裁决 → edit 提案 → 同事务罗盘）----

  async coachGrowthBatch(
    courseKey: string, llm: LlmComplete,
    opts: { force?: boolean; today?: string; inject?: string } = {},
  ): Promise<{
    course: string
    state: 'idle' | 'applied'
    check: CoachCheck
    segments: CoachGrowthSegment[]
    proposal: { id: number; ops: number; operator: string; reason: string; disagreement: boolean } | null
    applied: { ops: number; snapshot: number; compass_rewritten: boolean; created: string[]; ready_unbuilt: string[] } | null
  }> {
    return this.growth2.coachGrowthBatch(courseKey, llm, opts)
  }
  // ---- 边实验账本与复诊（#146 / 插入提案生命周期：预注册→登记→到期结算→proven｜自动剪除）----

  private async growthGateErrors(spec: EditProposalSpec): Promise<string[]> {
    return this.growth2.growthGateErrors(spec)
  }

  private async probationViewFor(c: CourseEntry, today: string, cutoff: number): Promise<ProbationCourseView> {
    return this.growth2.probationViewFor(c, today, cutoff)
  }

  async probationStatus(courseKey?: string): Promise<{
    date: string
    courses: Array<{ course: string } & ProbationCourseView>
  }> {
    return this.growth2.probationStatus(courseKey)
  }

  private async exerciseGated(c: CourseEntry, node: string): Promise<boolean> {
    return this.growth2.exerciseGated(c, node)
  }

  async settleRechecks(courseKey?: string, opts: { today?: string } = {}): Promise<{
    date: string
    courses: Array<{
      course: string
      settled: Array<{ node: string; outcome: ProbationOutcome; metric?: RecheckMetric; detail?: string; proposal?: number }>
      skipped: Array<{ node: string; reason: string }>
    }>
  }> {
    return this.growth2.settleRechecks(courseKey, opts)
  }

  private jolPredicted(p: JolPrediction | null | undefined): JolPrediction | null {
    return this.growth2.jolPredicted(p)
  }
  // ---- Self-Calibration 自评校准画像（ADR-0022 #104；分源自省面 + 显式呈现层提示）----

  async calibrationProfile(): Promise<CalibrationProfileDoc> {
    return this.learner.calibrationProfile()
  }

  async calibrationHintsConfig(): Promise<{ hints_enabled: boolean }> {
    return this.learner.calibrationHintsConfig()
  }

  async setCalibrationHints(hints_enabled: boolean): Promise<{ hints_enabled: boolean }> {
    return this.learner.setCalibrationHints(hints_enabled)
  }
  // ---- D4 睡眠耦合建议配置（#85）——LabSubsystem 住 nof1.ts（#152 刀 2）----

  async sleepAdviceConfig(): Promise<{ enabled: boolean }> {
    return this.lab.sleepAdviceConfig()
  }

  async setSleepAdviceConfig(patch: { enabled?: boolean }): Promise<{ enabled: boolean }> {
    return this.lab.setSleepAdviceConfig(patch)
  }

  // ---- E5 可用的困难教练（#65；只读信息性反馈，无门禁无判分）----

  async logBandSession(rec: { course: string; node: string; band: BandPref; answered: number; correct: number }, today?: string): Promise<BandRec> {
    return this.learner.logBandSession(rec, today)
  }

  async coachAdvice(today?: string): Promise<{ messages: string[]; due_hard: number }> {
    return this.learner.coachAdvice(today)
  }
  // ---- E2「讲给我听」（#68 / ADR-0009 Learner Output：判词只入 E 档案，零 XP）----

  private async explainPoints(c: CourseEntry, graph: Graph, node: string): Promise<ExplainPoint[]> {
    return this.learner.explainPoints(c, graph, node)
  }

  async explainBackPack(courseKey: string | undefined, node: string): Promise<string> {
    return this.learner.explainBackPack(courseKey, node)
  }

  async explainBackFeedback(
    courseKey: string | undefined, node: string, transcript: string,
    llm: LlmComplete,
  ): Promise<EArchiveRec & { reply: string }> {
    return this.learner.explainBackFeedback(courseKey, node, transcript, llm)
  }

  async explainArchiveCard(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: 'recall_cue' | 'cloze_rewrite'; prompt?: string; section?: string },
  ): Promise<{ course: string; node: string; id: string; kind: LearnerCard['kind']; count: number }> {
    return this.learner.explainArchiveCard(courseKey, node, opts)
  }
  // ---- E1「我的卡」复习（#45 schema / #68 存档目标；#70 落节级入口与管理面）----

  async learnerQueue(courseKey?: string, today?: string): Promise<LearnerQueueDoc> {
    return this.learner.learnerQueue(courseKey, today)
  }

  async learnerCardRate(
    courseKey: string | undefined, node: string, cardId: string, rating: number,
  ): Promise<LearnerRateResult> {
    return this.learner.learnerCardRate(courseKey, node, cardId, rating)
  }

  async learnerCardForget(
    courseKey: string | undefined, node: string, cardId: string,
  ): Promise<LearnerForgetResult> {
    return this.learner.learnerCardForget(courseKey, node, cardId)
  }

  async learnerNoteAdd(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: LearnerCard['kind']; prompt?: string; section?: string },
    llm: LlmComplete,
  ): Promise<{
    course: string; node: string
    card: { id: string; kind: LearnerCard['kind']; count: number }
    verdict: EArchiveRec; reply: string
  }> {
    return this.learner.learnerNoteAdd(courseKey, node, opts, llm)
  }

  async learnerCardArchive(
    courseKey: string | undefined, node: string, cardId: string, archived: boolean,
  ): Promise<LearnerArchiveResult> {
    return this.learner.learnerCardArchive(courseKey, node, cardId, archived)
  }
  // ---- C-3 错误对比卡（#82：错误库→对比案例卡）----

  // 以下 错误对比卡/学习面板题目管理/B2 回流/一键清理/勘误冲正 五节方法体住 BankSubsystem（question-bank.ts，#152 刀 6 聚合+转发）

  async errorCardMine(courseKey: string | undefined, node?: string): Promise<ErrorMineDoc> {
    return this.bank2.errorCardMine(courseKey, node)
  }

  private async *errorCardTriples(
    courses: ReadonlyArray<{ name: string; root: string }>, nodeFilter?: string,
  ): AsyncGenerator<{ course: string; node: string; card: ErrorCard }> {
    yield* this.bank2.errorCardTriples(courses, nodeFilter)
  }

  async errorCardGenerate(
    courseKey: string | undefined, opts: { node?: string; max?: number } | undefined,
    llm: LlmComplete,
  ): Promise<ErrorGenerateResult> {
    return this.bank2.errorCardGenerate(courseKey, opts, llm)
  }

  async errorCardAnswer(
    courseKey: string | undefined, node: string, cardId: string, choice: string,
  ): Promise<ErrorAnswerResult> {
    return this.bank2.errorCardAnswer(courseKey, node, cardId, choice)
  }

  async errorCardQueue(courseKey?: string, today?: string): Promise<ErrorQueueDoc> {
    return this.bank2.errorCardQueue(courseKey, today)
  }

  async errorCardArchive(
    courseKey: string | undefined, node: string, cardId: string, archived: boolean,
  ): Promise<ErrorArchiveResult> {
    return this.bank2.errorCardArchive(courseKey, node, cardId, archived)
  }
  // ---- U 区·技能条目与执行事件通道（#89 / ADR-0018 + ADR-0019）----

  async skillCreate(name: string, opts?: { id?: string; maintenance_days?: number | null }): Promise<SkillDoc> {
    return this.learner.skillCreate(name, opts)
  }

  async skillList(today?: string): Promise<SkillsListDoc> {
    return this.learner.skillList(today)
  }

  async skillSetMaintenance(id: string, days: number | null): Promise<SkillDoc> {
    return this.learner.skillSetMaintenance(id, days)
  }

  async skillArchive(id: string, archived: boolean): Promise<SkillDoc> {
    return this.learner.skillArchive(id, archived)
  }

  async executionLog(
    skillId: string,
    input: { source: ExecutionSource; minutes: number; rating?: number; evidence?: ExecutionEvidence; note?: string },
  ): Promise<ExecutionLogResult> {
    return this.learner.executionLog(skillId, input)
  }
  // ---- U 区·回执反馈环（#88 / ADR-0016）----

  async receiptSubmit(
    courseKey: string | undefined, node: string,
    input: { kind: ReceiptKind; material: string; force_full?: boolean },
    llm: LlmComplete,
  ): Promise<ReceiptSubmitResult> {
    return this.learner.receiptSubmit(courseKey, node, input, llm)
  }

  async receiptList(courseKey: string | undefined, node: string): Promise<{
    course: string; node: string
    receipts: ReceiptLogRec[]
    total: number
    next_full_in: number | null
  }> {
    return this.learner.receiptList(courseKey, node)
  }
  // ---- U 区·习惯一等公民（#90 / ADR-0017：零 FSRS 语义、零 canonical 写入）----

  async habitCreate(input: { name: string; cue: string; action: string; id?: string }): Promise<HabitDoc> {
    return this.learner.habitCreate(input)
  }

  async habitList(today?: string): Promise<HabitsListDoc> {
    return this.learner.habitList(today)
  }

  async habitShow(habitId: string, today?: string): Promise<HabitShowDoc> {
    return this.learner.habitShow(habitId, today)
  }

  async habitRepeat(habitId: string, input: { auto_rating?: number; note?: string }): Promise<HabitRepeatRec> {
    return this.learner.habitRepeat(habitId, input)
  }

  async habitArchive(habitId: string, archived: boolean): Promise<HabitDoc> {
    return this.learner.habitArchive(habitId, archived)
  }
  // ---- FSRS 参数优化器（#62 A2 / ADR-0012）----

  async optimizeFsrsParams(
    impl: OptimizerImpl = bindingImpl,
  ): Promise<{
    status: 'written' | 'skipped'
    reason?: string
    written?: string[]
    meta?: Record<string, unknown>
  }> {
    return this.sched2.optimizeFsrsParams(impl)
  }
  // ---- 沉淀层（#139 / ADR-0034：学习模型状态第四存储域）----

  async sedimentAppend(kind: SedimentKind, tier: SedimentTier, payload: Record<string, unknown>, concept?: string): Promise<SedimentEvent> {
    return this.sched2.sedimentAppend(kind, tier, payload, concept)
  }

  async sedimentFold(): Promise<SedimentFold> {
    return this.sched2.sedimentFold()
  }

  async sedimentRebuildProfile(): Promise<string> {
    return this.sched2.sedimentRebuildProfile()
  }

  async sedimentSettle(): Promise<{
    week: string | null
    wrote: SedimentKind[]
    skipped: Array<{ kind: SedimentKind; reason: string }>
    profile: string
  }> {
    return this.sched2.sedimentSettle()
  }
  // ---- 生成任务持久化（host 的 genJobs 内存态落盘出口；D14：文件读写收口 engine）----

  /** 全量写入生成任务注册表（host 在每次任务状态变更时调用）。 */
  async saveGenJobs(jobs: Array<Record<string, unknown>>): Promise<void> {
    await atomicWrite(this.paths.genJobsPath, JSON.stringify(jobs, null, 1) + '\n')
  }

  /** 读入生成任务注册表；文件缺失/损坏返回空表。 */
  async loadGenJobs(): Promise<Array<Record<string, unknown>>> {
    try {
      const doc = JSON.parse(await readFile(this.paths.genJobsPath, 'utf8')) as unknown
      return Array.isArray(doc) ? doc as Array<Record<string, unknown>> : []
    } catch {
      return []
    }
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
    lines.push(`- 区/块：${graph.blockOf[node][1]} · ${graph.blockOf[node][2]}；深度 L${(graph.depth[node] ?? 0) + 1}；阶段：${fm?.stage ?? 'unknown'}；掌握度：${Math.round(mastery * 100)}%`)
    const note = graph.noteOf[node]
    if (note) lines.push(`- note：${note}`)
    const [, regionName] = graph.blockOf[node]
    try {
      const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
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
    const { c, graph, q } = await this.questionContext(courseKey, node, qid, 'explain')
    const [, regionName] = graph.blockOf[node]
    const { fm: rawFm, body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
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

  async questionsAll(courseKey?: string): Promise<QuestionsAllDoc> {
    return this.bank2.questionsAll(courseKey)
  }
  // ---- B2 难度感知回流（决议 #41 / #58）----

  async difficultyAdvice(courseKey?: string): Promise<DifficultyAdviceDoc> {
    return this.bank2.difficultyAdvice(courseKey)
  }

  async adviceDismiss(course: string, node: string, qid: string | undefined, undo = false, all = false): Promise<{ dismissed: AdviceDismissRec[] }> {
    return this.bank2.adviceDismiss(course, node, qid, undo, all)
  }

  async questionAdd(courseKey: string, node: string, question: Record<string, unknown>): Promise<{ course: string; node: string; id: string; count: number }> {
    return this.bank2.questionAdd(courseKey, node, question)
  }

  async questionGet(courseKey: string | undefined, node: string, qid: string): Promise<QuestionGetDoc> {
    return this.bank2.questionGet(courseKey, node, qid)
  }

  async questionUpdate(courseKey: string, node: string, qid: string, patch: Record<string, unknown>): Promise<{ course: string; node: string; qid: string }> {
    return this.bank2.questionUpdate(courseKey, node, qid, patch)
  }

  async questionArchive(courseKey: string, node: string, qid: string, archived: boolean, reason?: string): Promise<{ course: string; node: string; qid: string; archived: boolean }> {
    return this.bank2.questionArchive(courseKey, node, qid, archived, reason)
  }
  // ---- 题库一键清理（ADR-0032）----

  async bankCleanupPreview(courseKey?: string): Promise<CleanupPreviewDoc> {
    return this.bank2.bankCleanupPreview(courseKey)
  }

  async bankCleanupApply(courseKey?: string): Promise<{ course: string; node: string; archived: number }[]> {
    return this.bank2.bankCleanupApply(courseKey)
  }
  // ---- 瑕疵题勘误与判罚冲正（ADR-0031）----

  async questionDisputeReview(
    llmComplete: LlmComplete,
    courseKey: string | undefined, node: string, qid: string,
  ): Promise<DisputeReviewResult> {
    return this.bank2.questionDisputeReview(llmComplete, courseKey, node, qid)
  }

  async questionDisputeApply(
    courseKey: string | undefined, node: string, qid: string,
    resolution: 'rekey' | 'void' | 'overridden',
    opts?: { targetTs?: string; revision?: { answer?: unknown; explanation?: string }; reason?: string },
  ): Promise<DisputeApplyResult> {
    return this.bank2.questionDisputeApply(courseKey, node, qid, resolution, opts)
  }

  async questionGenerate(
    courseKey: string | undefined, node: string, count?: number,
    llm: LlmComplete,
    opts?: {
      sections?: Array<{ id: string; title: string }>
      generic?: boolean
      section?: { id: string; title: string }
      instruction?: string
      isCancelled?: () => boolean
    },
  ): Promise<{
    course: string; node: string; added: number; skipped: number; total: number
    duplicates: Array<{ q: string; against: string }>
    rejected: Array<{ q: string; reason: string }>
    /** 转义损坏修复处数（ADR-0030：确定性修复留痕，不静默）。 */
    escapesRepaired: number
    /** invokes 覆盖率投影（#148）：节点全部在库题目的 enc 边候选（出生 w），随生长批 set_enc 写入。 */
    enc: EncEdge[]
  }> {
    return this.bank2.questionGenerate(courseKey, node, count, llm, opts)
  }

  async questionGenerateSections(
    courseKey: string | undefined, node: string,
    llm: LlmComplete,
  ): Promise<{ course: string; node: string; added: number; sections: number; duplicates: number; escapesRepaired: number; enc: EncEdge[] }> {
    return this.bank2.questionGenerateSections(courseKey, node, llm)
  }

  async interactiveSettle(
    courseKey: string | undefined, node: string, sectionId: string, score: number, detail?: string,
  ): Promise<{ settled: boolean; mastery: number }> {
    return this.bank2.interactiveSettle(courseKey, node, sectionId, score, detail)
  }

  async courseDelete(courseKey: string): Promise<{ removed: string; trash: string; sediment: string }> {
    return this.bank2.courseDelete(courseKey)
  }

  async ensureAllNotes(courseKey?: string): Promise<{ courses: Array<{ course: string; created: number }> }> {
    return this.bank2.ensureAllNotes(courseKey)
  }
  // ---- utils ----

  private async updateNoteFm(path: string, fm: Fm): Promise<void> {
    const { body } = await loadNote(path)
    await saveNote(path, fm as unknown as Record<string, unknown>, body)
  }

  /** 写一条 journal（运行日志等由插件层做）。 */
  journal() { return this.store }
}
