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
import { Store } from './store.ts'
import { GraphStore, Graph, writeReadyList, declaredEncOf } from './graph.ts'
import { stateMap, loadNote, saveNote, defaultFrontmatter, asFm, validateNoteFrontmatter, hasReadyContent } from './notes.ts'
import type { BrokenNote } from './notes.ts'
import { getScheduler, applyRatingBlock, masteryOfFm, previewDue, retrievabilityBlock, resolveFsrsParams } from './srs.ts'
import { advance, advancePending, advanceStrict, alreadyAdvanced } from './advance.ts'
import type { FSRS } from 'ts-fsrs'
import { bandOffset, combinedDifficulty, startBand, sessionOrder } from './adaptive.ts'
import type { BandPref } from './adaptive.ts'
import { JOL_PREDICTIONS, JOL_SAMPLE_RATE, jolCalibration, jolDeviatedKeys, pickJolTargets } from './jol.ts'
import type { JolPrediction } from './jol.ts'
import { CALIBRATION_BOOST_SAMPLE_RATE, RECHECK_DAYS_DEFAULT } from './params.ts'
import { calibrationHintText, calibrationProfileView, overconfidenceOf } from './calibration.ts'
import { normalizeSleepAdvice } from './sleep.ts'
import { NOF1_TEMPLATES, NOF1_PER_ARM_MIN, NOF1_VARIABLE_WHITELIST, nof1Template, nof1ArmForDay, nof1Outcomes, analyzeNof1, shuffleAssign, interleaveBySource, mulberry32 } from './nof1.ts'
import type { Nof1Template, Nof1Variable, ExperimentDef, Nof1Analysis } from './nof1.ts'
import { retentionBand, bandDistribution, execRatingDistribution, thermostatSuggestions } from './thermostat.ts'
import type { ThermostatDoc, ThermostatSuggestion } from './thermostat.ts'
import { SANDBOX_RUNS, SANDBOX_DEFAULT_WEEKS, SANDBOX_WORDING, simulateRun, aggregateRuns } from './sandbox.ts'
import type { SandboxDoc, SandboxCard, SandboxNode, SandboxPlan } from './sandbox.ts'
import {
  KATA_KIND, KATA_EMPTY, KATA_LEARNER_QUESTIONS, weekStartOf, weekEndOf, prevWeekStartOf,
  buildKataReality, renderKataReality, assembleKataDoc, parseKataBody, kataAnswered,
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
import { nodeTierOf, perSectionQuizTarget, genericQuizTarget, sectionTierLabel } from './complexity.ts'
import type { ComplexityTier } from './complexity.ts'
import { GraphProposals, validateEditProposal, addNodeCountOf } from './proposals.ts'
import type { ApplyAudit, EditProposalSpec, EnrichFieldEntry, GrowthNote } from './proposals.ts'
import type { LlmComplete } from './llm.ts'
import { Projects, PROJECT_LIFECYCLES, FADING_TIERS, isProjectLifecycle, isFadingTier, planRevisionDiff } from './projects.ts'
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
import { behaviorDigest, readyDepthCheck, renderBehaviorDigest, renderSedimentForCoach } from './coach-round.ts'
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
import { QuestionBank, questionAnswerShapeError, validateBank } from './question-bank.ts'
import type { BankDoc, BankQuestion } from './question-bank.ts'
import { NoteSourceManifest, NOTE_SOURCE_COURSE, classifySource, collectNoteFiles, fingerprintOf, isExcludedPath, normalizeSourcePath, poolMirrorBody, readNoteSourceExcludes, sourceHint, stripFrontmatter, titleOfBody, writeNoteSourceExcludes } from './note-source.ts'
import type { NoteSourceManifestItem, NoteSourceStatus } from './note-source.ts'
import { LearnerCards, LEARNER_CARD_KINDS } from './learner-cards.ts'
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
import { atomicWrite, netPracticeRecs, readLearnhubConfig, writeLearnhubConfig } from './store.ts'
import { assertSchemaVersion } from './schema.ts'
import type { SchemaBlock } from './schema.ts'
import { appendSedimentEvent, readSedimentCanon, foldSediment, rebuildLearnerProfile } from './sediment.ts'
import type { SedimentEvent, SedimentFold, SedimentKind, SedimentTier } from './sediment.ts'
import { REFLECTION_GRADING_SYSTEM, parseReflectionGrading, OPEN_QUESTION_GRADING_SYSTEM, parseOpenGrading, evaluateAllo, PASS_SCORE, applyPracticeEvidence, answerDiff, DISPUTE_REVIEW_SYSTEM, parseDisputeReview } from './grading.ts'
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

/** Fisher–Yates 洗牌（返回新数组；matching 右列候选防按序泄题）。 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 评估指标等小数的 4 位舍入（落盘元数据与文案共用）。 */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
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

/** 从节点正文提取一节的 markdown：先精确标题匹配，再按归一化标题回退；
 * 找不到返回 null（定向补题时 fail loud，不静默附全文）。 */
function sectionMdOf(body: string, title: string): string | null {
  const parts = body.split(/^## /m).slice(1)
  const wanted = normSectionKey(title)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const t = (nl >= 0 ? part.slice(0, nl) : part).trim()
    if (t === title) return (nl >= 0 ? part.slice(nl + 1) : '').trim()
  }
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const t = (nl >= 0 ? part.slice(0, nl) : part).trim()
    if (t && normSectionKey(t) === wanted) return (nl >= 0 ? part.slice(nl + 1) : '').trim()
  }
  return null
}

/** 误解先验注入段（#147 误解目录消费；节点无误解时返回 ''，Missing 合法空态）。
 * 生成期先验——真实错误检测归作答流水挖矿与申诉复核，有真实数据后先验让位，
 * 让位语义由各消费方模板措辞声明（干扰项以生成指令为准、错误卡 mine 以真实错答为准）。 */
function misconceptionPromptBlock(mis: Array<{ concept: string; model: string }> | undefined, use: string): string {
  if (!mis?.length) return ''
  return `\n\n## 误解先验（${use}）\n\n- 本节点登记在册的误解先验（概念：错误模型）：\n${mis.map(m => `- ${m.concept}：${m.model}`).join('\n')}`
}

/** 错题公布答案的题型化展示（多选字母并排、排序箭头链、匹配左→右）。 */
export function revealAnswer(q: { kind: AlloKind; answer: string | boolean | string[]; options?: string[] }): string {
  switch (q.kind) {
    case 'multi_choice': return Array.isArray(q.answer) ? q.answer.join('') : String(q.answer)
    case 'ordering': return Array.isArray(q.answer) ? q.answer.join(' → ') : String(q.answer)
    case 'matching': return Array.isArray(q.answer) && q.options?.length
      ? q.options.map((o, i) => `${o} → ${q.answer[i] ?? '?'}`).join('；')
      : Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer)
    case 'fill_in_blank': return Array.isArray(q.answer) ? q.answer.join(' / ') : String(q.answer)
    default: return String(q.answer)
  }
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

  /** pin 节点为今日推荐榜首：只改推荐读侧排序（课程内置顶、跨课按全局语义），
   * 保留就绪提示——未就绪节点不拒绝，软闸建议随事件带出。仅作用当日，次日自动
   * 失效；同一课程可叠加多个 pin（按 pin 序依次置顶）。节点不在图内 fail loud；
   * 写入时顺带清理过期条目。零调度副作用（不碰 canonical/XP/掌握度）。
   * intention（C-5 #84）：可选挂载执行意图（if-then 计划），随 pin 当日过期
   * （ADR-0017 裁决 6），格式锁死校验走 normalizeGoalIntention。 */
  async pinToday(courseKey: string | undefined, node: string, today?: string, intention?: GoalIntentionInput): Promise<{ course: string; node: string; date: string; intention?: ExecutionIntention }> {
    today ??= (await this.learningDay()).today
    const plan = normalizeGoalIntention(intention?.cue, intention?.action)
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[pin] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'pin')
    const rest = (await this.store.loadPins())
      .filter(p => p.date === today && !(p.course === c.name && p.node === node))
    const rec: PinRec = { course: c.name, node, date: today, ...(plan ? { intention: plan } : {}) }
    await this.store.savePins([...rest, rec])
    return { course: c.name, node, date: today, ...(plan ? { intention: plan } : {}) }
  }

  /** 在今日 pin 上写入/清除执行意图（C-5 #84）：if-then 计划挂载在「今天学它」的
   * 目标偏好上，只覆盖推荐读侧（随 pin 当日过期，ADR-0017 裁决 6）。cue/action
   * 都传 = 写入（格式锁死：稳定线索 + 单一具体行动），都不传 = 清除；当日无该
   * 节点的 pin = Missing fail loud——意图没有独立生命周期，载体缺失就不能悬空写。
   * 写入时顺带清理过期条目（pinToday/unpin 同款卫生步骤）。Learner Output：零调度副作用。 */
  async setGoalIntention(courseKey: string | undefined, node: string, intention: GoalIntentionInput | null, today?: string): Promise<{ course: string; node: string; intention: ExecutionIntention | null }> {
    today ??= (await this.learningDay()).today
    const plan = intention ? normalizeGoalIntention(intention.cue, intention.action) : undefined
    const c = await this.registry.resolve(courseKey)
    const pins = (await this.store.loadPins()).filter(p => p.date === today)
    const hit = pins.find(p => p.course === c.name && p.node === node)
    if (!hit) throw new Error(`[goal-intention] 「${c.name}/${node}」今天没有 pin：执行意图挂在「今天学它」的目标偏好上，先 learnhub_pin_today。`)
    const next = pins.map(p => p === hit
      ? (plan ? { ...p, intention: plan } : { course: p.course, node: p.node, date: p.date })
      : p)
    await this.store.savePins(next)
    return { course: c.name, node, intention: plan ?? null }
  }

  /** 取消 pin：移除该课程+节点的全部 pin（含过期条目），写入时顺带清理过期清单。 */
  async unpinToday(courseKey: string | undefined, node: string, today?: string): Promise<{ course: string; node: string; pinned: false }> {
    today ??= (await this.learningDay()).today
    const c = await this.registry.resolve(courseKey)
    const rest = (await this.store.loadPins())
      .filter(p => p.date === today && !(p.course === c.name && p.node === node))
    await this.store.savePins(rest)
    return { course: c.name, node, pinned: false }
  }

  /** B1 内容诊断（#69，信号层建议先行）：逐启用课程逐节评估 R1（单题 lapses≥3）/
   * R2（自节 version 锚点以来按（题,日）去重 ≥4 次且正确率 <0.5）。零新增文件——
   * 触发留痕写 journal（kind=section_regen_signal，detail 人类可读且机器可回读），
   * 它同时是 7 天冷却与 R1 二次升级的判定依据；条件命中期间建议项保持可见（met），
   * 冷却与快照守门只约束新触发（fresh）。v1 只重写既有节、确认后才触发（不自动动库）。 */
  async diagnosticsAdvice(today?: string): Promise<DiagnosticItem[]> {
    const { today: learningToday, cutoff } = await this.learningDay()
    today ??= learningToday
    const out: DiagnosticItem[] = []
    const practice = await this.store.practiceAll()
    for (const c of await this.enabledCourses()) {
      const { state, broken } = await this.loadView(c)
      assertNoBrokenNotes('diagnostics', broken)
      const journal = await this.store.journalTail(c.name, Number.MAX_SAFE_INTEGER)
      const signalsByNode = new Map<string, Array<SignalSnapshot & { day: string }>>()
      const rewritesByNode = new Map<string, RewriteFact[]>()
      for (const r of journal) {
        if (r.kind === 'section_regen_signal') {
          const snap = parseSignalDetail(r.detail)
          if (!snap) continue
          const list = signalsByNode.get(r.node) ?? []
          list.push({ ...snap, day: dayOfTs(r.ts, cutoff) })
          signalsByNode.set(r.node, list)
        } else if (r.kind === 'content_section') {
          // detail 历史上只有节标题没有节 id（content.ts 契约）——按清单标题回退对齐
          const title = parseRewriteDetail(r.detail)
          if (!title) continue
          const list = rewritesByNode.get(r.node) ?? []
          list.push({ title, day: dayOfTs(r.ts, cutoff) })
          rewritesByNode.set(r.node, list)
        }
      }
      await this.scanCourseBanks(c, async (node, bank) => {
        const manifest = state[node]?.content.sections
        if (!manifest?.length) return // 无清单旧节点：节归因不适用（标题匹配不出的节不产建议）
        const attempts = practice
          .filter(r => r.course === c.name && r.node === node)
          .map(r => ({ qid: r.qid ?? '', day: dayOfTs(r.ts, cutoff), correct: r.correct }))
        for (const v of evaluateSectionSignals({
          manifest,
          questions: bank.questions.filter(q => !q.archived).map(q => ({ id: q.id, section: q.section, fsrs: q.fsrs })),
          attempts,
          prevSignals: signalsByNode.get(node) ?? [],
          rewrites: rewritesByNode.get(node) ?? [],
          today,
        })) {
          if (v.fresh) {
            const ev = v.signal === 'R1'
              ? `qid=${v.evidence.qid} lapses=${v.evidence.lapses}`
              : `attempts=${v.evidence.attempts} correct=${v.evidence.correct} acc=${v.evidence.accuracy}`
            await this.store.appendJournal({
              course: c.name, node, rating: null, kind: 'section_regen_signal', elapsed_days: 0,
              detail: formatSignalDetail(
                { sectionId: v.sectionId, signal: v.signal, base: Number(v.signal === 'R1' ? v.evidence.lapses : v.evidence.attempts) },
                v.sectionTitle, ev),
            })
          }
          out.push({ course: c.name, node, ...v })
        }
      })
    }
    return out
  }

  /** struggle 近期窗口统计（#55 F 半）：作答流水按 (course,node) 聚合，只留窗口内的
   * 真实作答证据（含交互件结算与忘记申报）。recommendEvents 消费；与累计的题库
   * stats 分开——复习中节点的 struggle 只看近期窗口，老账不翻。 */
  private async struggleWindow(today: string): Promise<Map<string, Map<string, WindowStat>>> {
    const out = new Map<string, Map<string, WindowStat>>()
    const cutoff = await readDayCutoff(this.paths)
    for (const r of await this.store.practiceAll()) {
      if (typeof r.correct !== 'boolean' || !withinStruggleWindow(r.ts, today, STRUGGLE_WINDOW_DAYS, cutoff)) continue
      const byNode = out.get(r.course) ?? new Map<string, WindowStat>()
      const agg = byNode.get(r.node) ?? { attempts: 0, correct: 0 }
      agg.attempts++
      if (r.correct) agg.correct++
      byNode.set(r.node, agg)
      out.set(r.course, byNode)
    }
    return out
  }

  /** 单课程题库文件的共用遍历（bankSnapshot / difficultyAdvice / memoryHealth 消费）：
   * 对课程根题库目录下每个 <节点>.yaml 回调 (node, bank)；无题库目录的课程静默跳过。 */
  private async scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void> {
    let files: string[] = []
    try {
      files = await readdir(this.paths.bankDir(c.root))
    } catch {
      return
    }
    const courseRoot = this.paths.courseRoot(c.root)
    for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
      const node = f.replace(/\.yaml$/, '')
      await fn(node, await this.bank.load(courseRoot, node))
    }
  }

  /** 全部启用课程的题库聚合（一次遍历）：每节点 due/count/accuracy/attempts。
   * 复习队列（due/count）与 struggle 提示（accuracy）共用；未做题节点也入表
   * （accuracy=null），供推荐流判定 struggle 与面板通用轮组装。 */
  private async bankSnapshot(today: string): Promise<Map<string, NodeStat[]>> {
    const out = new Map<string, NodeStat[]>()
    for (const c of await this.enabledCourses()) {
      const items: NodeStat[] = []
      out.set(c.name, items)
      await this.scanCourseBanks(c, async (node, bank) => {
        const qs = bank.questions.filter(q => !q.archived)
        if (!qs.length) return
        let attempts = 0
        let correct = 0
        const dues: string[] = []
        for (const q of qs) {
          attempts += q.stats?.attempts ?? 0
          correct += q.stats?.correct ?? 0
          if (q.fsrs?.reps && q.fsrs.due <= today) dues.push(q.fsrs.due)
        }
        items.push({
          node,
          due: dues.sort()[0] ?? null,
          count: dues.length,
          accuracy: attempts ? Math.round((correct / attempts) * 100) / 100 : null,
          attempts,
        })
      })
    }
    return out
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

  async graphAnalyze(
    courseKey?: string, elementsOnly = false,
  ): Promise<GraphDoc | GraphElementsDoc> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state } = await this.loadView(c)
    const vaultLinks = await this.loadVaultLinkPrior(graph)
    // 种子图豁免（#142）：图仍 = 终点锚种子节点全集时，Float（missing_pre）建议豁免
    const anchor = await readAnchor(this.paths.anchorPath(c.root))
    const seedPhase = isSeedGraph(anchor, graph)
    const doc = await analyzeGraph(c.name, graph, state, this.store, (await this.learningDay()).today, vaultLinks, seedPhase)
    if (elementsOnly) return { nodes: doc.nodes, edges: doc.edges }
    return doc
  }

  // ---- Vault 链接先验（V-2 #91：wikilink → 无向关联对 → analyze 展示 + 单提案人审）----

  /** 读链接先验缓存（Missing = null 合法空态；坏档 fail loud——它是引擎 state 契约文件）。 */
  private async readVaultLinksCache(): Promise<VaultLinksDoc | null> {
    return readVaultLinksCache(this.paths.vaultLinksPath)
  }

  /** analyze 的先验段：缓存映射到本课程图的候选（w ≥ 0.4，proposal/review 分层 +
     行动指引）；未扫描返回空段（带 hint）。 */
  private async loadVaultLinkPrior(graph: Graph): Promise<VaultLinkPrior> {
    const cache = await this.readVaultLinksCache()
    if (!cache) return { scanned_at: null, mapped_total: 0, candidates: [] }
    const mapped = mapEdgesToNodes(
      cache.edges.filter(e => e.w >= 0.4),
      graph.names,
    )
    const candidates: VaultLinkCandidateView[] = mapped.map(({ edge, aNode, bNode }) => {
      const tier = scoreTier(edge.w) === 'proposal' ? 'proposal' as const : 'review' as const
      return {
        a: aNode,
        b: bNode,
        a_note: edge.a,
        b_note: edge.b,
        w: edge.w,
        count: edge.count,
        files: edge.files,
        bidirectional: edge.bidirectional,
        tier,
        suggestion: tier === 'proposal'
          ? 'learnhub_graph_link_backfill 可生成 set_enc 提案（单提案人审）'
          : '置信度居中——人工裁决后 learnhub_graph_propose 显式主张（pre 从严）',
      }
    })
    return { scanned_at: cache.generated_at, mapped_total: candidates.length, candidates }
  }

  /** 全库 wikilink 扫描（learnhub_vault_links_scan）：学习中心/点目录/内置目录排除/
   * 用户排除清单之外的全部 .md → 解析 → 过滤（带命中率审计）→ 无向关联对。
   * 产物落 state/vault链接.json（引擎 state 区），个人笔记零写入（ADR-0010）。 */
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
    const dirExcludes = await readVaultLinkDirExcludes(this.paths.learnhubConfigPath)
    const doc = await scanVaultLinks({
      vaultRoot: this.vaultRoot,
      centerRel: this.paths.centerRoot.slice(this.vaultRoot.length + 1),
      dirExcludes,
      pathExcludes: await readNoteSourceExcludes(this.paths),
    })
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await atomicWrite(this.paths.vaultLinksPath, JSON.stringify(doc, null, 1) + '\n')
    const tiers = { proposal: 0, review: 0, report: 0 }
    for (const e of doc.edges) tiers[scoreTier(e.w)]++
    return {
      generated_at: doc.generated_at,
      scanned_files: doc.scanned_files,
      truncated: doc.truncated,
      links_seen: doc.links_seen,
      unresolved: doc.unresolved,
      audit: doc.audit,
      tiers,
      edges: doc.edges.slice(0, 50).map(e => ({
        a: e.a, b: e.b, count: e.count, files: e.files, w: e.w, tier: scoreTier(e.w),
      })),
      cache: this.paths.vaultLinksPath,
    }
  }

  /** 链接先验回填（learnhub_graph_link_backfill）：映射到本课程图、w ≥ 0.7 的候选对，
   * pre 闭包内定向成 set_enc op（既有声明 enc 原样保留——整体替换语义），汇总为
   * 单个 pending edit 提案走人审（enc_backfill 先例）；无 pre 关系的对不硬提，降级
   * blocked_no_pre 信号（带 why，供人审/补 pre 参考）。可重入：已声明边不重复提名。 */
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
    const c = await this.registry.resolve(courseKey)
    const cache = await this.readVaultLinksCache()
    if (!cache) {
      throw new Error('[link-backfill] 没有链接先验缓存——先跑 learnhub_vault_links_scan。')
    }
    const { graph } = await this.loadView(c)
    const proposalTier = mapEdgesToNodes(cache.edges.filter(e => scoreTier(e.w) === 'proposal'), graph.names)
    const declared = declaredEncOf(graph)
    const fields: EnrichFieldEntry[] = []
    const candidates: Array<{ holder: string; skill: string; w: number }> = []
    const blockedNoPre: Array<{ a: string; b: string; w: number; why: string }> = []
    let skippedDeclared = 0
    for (const { edge, aNode, bNode } of proposalTier) {
      const dir = orientLinkPair(aNode, bNode, (from, to) => graph.nset.has(from) && graph.nset.has(to) && graph.isAncestor(from, to))
      if (!dir.ok) {
        blockedNoPre.push({ a: aNode, b: bNode, w: edge.w, why: dir.why })
        continue
      }
      const existing = declared.get(dir.holder) ?? []
      if (existing.some(e => e.node === dir.skill)) {
        skippedDeclared++
        continue
      }
      fields.push({
        node: dir.holder,
        enc: [...existing, {
          node: dir.skill, w: edge.w,
          note: `vault 链接先验（#91）：${edge.a.split('/').pop()} ↔ ${edge.b.split('/').pop()}（${edge.count} 次/${edge.files} 源${edge.bidirectional ? '/双向' : ''}）`,
        }],
      })
      candidates.push({ holder: dir.holder, skill: dir.skill, w: edge.w })
    }
    if (!fields.length) {
      return {
        course: c.name, scanned_edges: cache.edges.length, mapped: proposalTier.length, ops: 0,
        proposal: null, blocked_no_pre: blockedNoPre, skipped_declared: skippedDeclared,
        message: '没有可回填的边：映射候选为空、已在 pre 闭包外（见 blocked_no_pre）或已声明。',
      }
    }
    const yamlText = YAML.stringify({
      course: c.name,
      reason: `Vault 链接先验回填（覆盖层通道，V-2 #91）：${fields.length} 个节点的个人笔记关联对成 enc 边（w ≥ 0.7、pre 闭包内）`,
      fields,
    })
    const prop = await this.graphPropose('enrich', yamlText)
    return {
      course: c.name, scanned_edges: cache.edges.length, mapped: proposalTier.length, ops: fields.length,
      proposal: { id: (prop as { id: number }).id }, blocked_no_pre: blockedNoPre,
      skipped_declared: skippedDeclared,
      message: `已生成 pending enrich 提案 #${(prop as { id: number }).id}（覆盖层通道）——过审后 learnhub_graph_apply(kind=enrich) 生效（可重入，已声明边不重复提名）`,
    }
  }

  // ---- 图探索（agent 逐步查询，不拉全图）----

  /** 单节点图详情：schema 字段值 + 直接邻域（succ）+ enc 边（含 note）+ 前置传递闭包。 */
  async graphNode(courseKey: string | undefined, node: string): Promise<GraphNodeDoc> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[graph-node] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'graph-node')
    let gnode: GNode | undefined
    for (const r of graph.regions) for (const b of r.blocks) {
      const hit = b.nodes.find(n => n.name === node)
      if (hit) { gnode = hit; break }
    }
    // 前置传递闭包（沿 pred BFS；不含自身），按深度降序=先学在前
    const seen = new Set<string>([node])
    const queue = [node]
    while (queue.length) {
      const u = queue.shift()!
      for (const p of graph.preOf[u]) if (!seen.has(p)) { seen.add(p); queue.push(p) }
    }
    const closure = [...seen].filter(n => n !== node)
      .sort((a, b) => (graph.depth[b] ?? 0) - (graph.depth[a] ?? 0))
    const fm = state[node]
    return {
      course: c.name,
      node,
      region: graph.blockOf[node][1],
      block: graph.blockOf[node][2],
      depth: graph.depth[node] ?? 0,
      opt: graph.opt.has(node),
      pre: graph.preOf[node],
      succ: graph.succ[node] ?? [],
      enc: gnode?.enc ?? [],
      est: graph.estOf[node],
      type: graph.typeOf[node],
      bloom: graph.bloomOf[node],
      difficulty: graph.difficultyOf[node],
      ...(gnode?.teaches ? { teaches: gnode.teaches } : {}),
      ...(gnode?.assumes ? { assumes: gnode.assumes } : {}),
      ...(gnode?.misconceptions?.length ? { misconceptions: gnode.misconceptions } : {}),
      note: graph.noteOf[node],
      stage: effectiveStage(state, node),
      mastery: masteryOfFm(fm),
      content: fm?.content ? { version: fm.content.version, status: fm.content.status } : undefined,
      prereq_closure: closure,
    }
  }

  /** 区/块浏览：按区名/块名过滤的节点清单（探索某区域的结构与内容状态）。 */
  async graphBrowse(courseKey: string | undefined, region?: string, block?: string): Promise<GraphBrowseDoc> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    const blockNames = [...new Set(graph.regions.flatMap(r => r.blocks.map(b => b.name)))]
    let regionName = region
    if (!regionName && block) {
      const hits = graph.regions.map(r => ({
        region: r.name,
        count: r.blocks.filter(b => b.name === block).length,
      })).filter(h => h.count > 0)
      if (!hits.length) {
        throw new Error(`[graph-browse] 只按块浏览时块「${block}」不存在（可用块：${blockNames.join('、') || '（无）'}）`)
      }
      if (hits.length > 1 || hits[0]!.count > 1) {
        const where = hits.map(h => `${h.region}（${h.count} 处）`).join('、')
        throw new Error(`[graph-browse] 块「${block}」不唯一（${where}）——请加 region 限定后再浏览。`)
      }
      regionName = hits[0]!.region
    }
    if (regionName && !graph.regions.some(r => r.name === regionName)) {
      throw new Error(`[graph-browse] 区「${regionName}」不存在（可用：${graph.regions.map(r => r.name).join('、')}）`)
    }
    if (regionName && block && !graph.regions.find(r => r.name === regionName)?.blocks.some(b => b.name === block)) {
      const regionBlocks = [...new Set(graph.regions.find(r => r.name === regionName)!.blocks.map(b => b.name))]
      throw new Error(`[graph-browse] 区「${regionName}」中没有块「${block}」（可用：${regionBlocks.join('、') || '（空）'}）`)
    }
    const regions = graph.regions
      .filter(r => !regionName || r.name === regionName)
      .map(r => ({
        name: r.name,
        blocks: r.blocks
          .filter(b => !block || b.name === block)
          .map(b => ({
            name: b.name,
            nodes: b.nodes.map(n => ({
              node: n.name,
              depth: graph.depth[n.name] ?? 0,
              stage: effectiveStage(state, n.name),
              est: graph.estOf[n.name],
              difficulty: graph.difficultyOf[n.name],
              type: graph.typeOf[n.name],
              content_status: state[n.name]?.content.status ?? 'draft',
            })),
          })),
      }))
    const total = regions.reduce((s, r) => s + r.blocks.reduce((t, b) => t + b.nodes.length, 0), 0)
    return {
      course: c.name,
      total,
      regions,
      // 纯结构浏览继续可用，但 Broken 状态必须显式暴露，不伪装成 unseen/draft
      broken_notes: broken.map(b => ({
        path: b.path,
        ...(b.node ? { node: b.node } : {}),
        reason: b.reason,
      })),
    }
  }

  /** 前置路径查询：from 是否（以及经哪条链）是 to 的前置。 */
  async graphPath(courseKey: string | undefined, from: string, to: string): Promise<GraphPathResult> {
    const c = await this.registry.resolve(courseKey)
    const { graph } = await this.loadView(c)
    if (!graph.nset.has(from)) throw new Error(`[graph-path] from 节点「${from}」不在课程「${c.name}」的图内。`)
    if (!graph.nset.has(to)) throw new Error(`[graph-path] to 节点「${to}」不在课程「${c.name}」的图内。`)
    const seen = new Set<string>([to])
    const parent: Record<string, string> = {}
    const queue = [to]
    while (queue.length) {
      const u = queue.shift()!
      for (const p of graph.preOf[u]) if (!seen.has(p)) { seen.add(p); parent[p] = u; queue.push(p) }
    }
    if (!seen.has(from)) {
      return { course: c.name, from, to, related: false, message: `「${from}」不在「${to}」的前置闭包内。` }
    }
    const chain = [from]
    let cur = from
    while (cur !== to) { cur = parent[cur]; chain.push(cur) }
    return {
      course: c.name,
      from,
      to,
      related: true,
      direct: graph.preOf[to].includes(from),
      closure_size: seen.size - 1,
      chain,
      depth_span: (graph.depth[to] ?? 0) - (graph.depth[from] ?? 0),
    }
  }

  // ---- 提案门禁包装（apply 前 audit 拦截） ----

  async graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult> {
    if (kind !== 'edit' && kind !== 'seed' && kind !== 'enrich') {
      throw new Error(`[propose] 非法 kind: ${String(kind)}（图谱域只受理 edit/seed/enrich）`)
    }
    if (kind === 'seed') return this.proposals.proposeSeed(yamlText)
    return kind === 'edit' ? this.proposals.proposeEdit(yamlText) : this.proposals.proposeEnrich(yamlText)
  }

  async graphApply(kind: 'edit' | 'seed' | 'enrich', pid?: number): Promise<GraphApplyResult> {
    if (kind !== 'edit' && kind !== 'seed' && kind !== 'enrich') {
      throw new Error(`[apply] 非法 kind: ${String(kind)}（图谱域只受理 edit/seed/enrich）`)
    }
    // audit 门禁：目标课程存在 ERROR 时拒绝 apply；warns 摘要 + 健康分随 findings 返回
    // （mode=new 的种子提案课程尚未建 data 目录，audit 空跑——种子图豁免在 runAudit/applySeed 内按锚判）
    const pending = await this.store.takePending(kind, pid)
    const today = (await this.learningDay()).today
    const audit = await this.seedAuditFor(pending.course, today)
    if (kind === 'seed') return this.proposals.applySeed(pid, audit, today)
    return kind === 'edit' ? this.proposals.applyEdit(pid, audit) : this.proposals.applyEnrich(pid, audit)
  }

  async graphReject(pid: number, note = ''): Promise<ProposalRec> {
    return this.proposals.reject(pid, note)
  }

  /** 面板下发的种子起草（学习图页建课/换终点表单入口）：目标描述 + 模式 + 目标类型
   * （coverage 附块工作表）→「种子提案」提示词组装（vault 先验选配——熟悉边界定位）→
   * llm → 种子 YAML 干跑校验门（validateSeedProposal 直跑，未过回灌修复一轮）→
   * proposeSeed 权威受理（schema/注册表对账/结构/概念对表在受理侧重跑全量），一次人审
   * 即开工。课程名/模式/目标类型/工作表是表单绑定字段——以输入为准，不信模型照抄。
   * llm 为注入缝（#137）。 */
  async seedPropose(
    input: SeedDraftRequest,
    llm: LlmComplete,
  ): Promise<{ id: number; course: string; mode: 'new' | 'reseed'; goal_type: string; endpoint: string; starts: number; prior_hits: number; repaired: boolean }> {
    const course = input.course.trim()
    const goal = input.goal.trim()
    if (!course) throw new Error('[seed-propose] 课程名必填（mode=new 自拟新名，mode=reseed 选既有课程）。')
    if (!goal) throw new Error('[seed-propose] 目标描述必填——种子起草只认学习者的目标，不猜。')
    const mode = input.mode ?? 'new'
    const goalType = input.goalType ?? 'capability'
    const worksheet = goalType === 'coverage' ? (input.worksheet ?? []).filter(w => typeof w.block === 'string' && w.block.trim()) : []
    if (goalType === 'coverage' && !worksheet.length) {
      throw new Error('[seed-propose] 覆盖锚定必须携带非空块工作表（{block, note?} 列表）；能力锚定不需要。')
    }
    // vault 先验选配（只读检索）：注册清单 Missing = 零命中合法，退化常识基线
    let prior = ''
    let priorHits = 0
    if (input.useVaultPrior === true) {
      const manifest = await this.noteManifest.load()
      const titles = manifest.sources.map(s => s.title ?? s.path.split('/').pop()!.replace(/\.md$/i, ''))
      const terms = decompileTerms(goal, titles)
      const centerRel = this.paths.centerRoot.slice(this.vaultRoot.length + 1)
      const hits = terms.length ? await searchVaultPrior(this.vaultRoot, centerRel, terms) : []
      priorHits = hits.length
      if (hits.length) {
        const items = hits.map(h => `- 《${h.title}》（${h.path}）\n  > ${h.excerpt.replaceAll('\n', '\n  > ')}`).join('\n')
        prior = `## 学习者已有理解（Vault 先验）\n\n以下是学习者个人 Vault 里与目标相关的笔记摘录（只读检索所得）：\n\n${items}\n\n起点定位要求：把起点放在熟悉边界——笔记已稳定覆盖的内容不作起点（那是可快速略过的地形，在 reason 里点一句）；摘录只是他记过的东西，只读，永不改写。`
      }
    }
    const tpl = await this.loadPrompt('种子提案')
    const pack = `${tpl}\n\n---\n\n## 目标描述（学习者原文）\n\n${goal}\n\n## 模式与绑定（照抄，不自拟）\n\n- 课程名：${course}\n- 模式：${mode}\n- 目标类型：${goalType}`
      + (goalType === 'coverage' ? `\n- 块工作表（照抄块名）：\n${worksheet.map(w => `  - block: ${w.block}`).join('\n')}` : '')
      + (prior ? `\n\n---\n\n${prior}` : '')
    const gateOnce = (raw: string): { errors: string[]; spec: SeedProposalSpec | null } => {
      let doc: unknown
      try {
        doc = YAML.parseModel(raw)
      } catch (err) {
        return { errors: [`YAML 解析失败：${err instanceof Error ? err.message : String(err)}`], spec: null }
      }
      const v = validateSeedProposal(doc)
      return { errors: v.errors ?? [], spec: v.spec ?? null }
    }
    let raw = await llm(pack)
    let gate = gateOnce(raw)
    let repaired = false
    if (gate.errors.length) {
      repaired = true
      raw = await llm(seedRepairPrompt(pack, raw, gate.errors.map(x => `  ✗ ${x}`)))
      gate = gateOnce(raw)
    }
    if (gate.errors.length || !gate.spec) {
      const e: Error & { code?: string } = new Error(
        `[seed-propose] 模型产出未过种子校验门（已自动修复重试一轮，提案未受理）：\n${gate.errors.map(x => `  ✗ ${x}`).join('\n')}`)
      e.code = 'SEED_GATE_FAILED'
      throw e
    }
    const spec = gate.spec
    spec.course = course
    spec.mode = mode
    spec.goal_type = goalType
    if (goalType === 'coverage') spec.worksheet = worksheet
    else delete spec.worksheet
    const r = await this.graphPropose('seed', YAML.stringify(spec)) as { id: number; endpoint: string; starts: number }
    return { id: r.id, course, mode, goal_type: goalType, endpoint: r.endpoint, starts: r.starts, prior_hits: priorHits, repaired }
  }

  /** 概念并入（#141 条目禁删只并入；human 领域判断的执行面）：from 整条并入 into，
   * 名字并集，旧地址经别名续解析；journal 留痕。 */
  async conceptMerge(courseKey: string, from: string, into: string): Promise<{ course: string; into: string; names: string[] }> {
    const c = await this.registry.resolve(courseKey)
    const r = await this.concepts.merge(c.root, from, into)
    await this.store.appendJournal({
      course: c.name, node: '*', rating: null, kind: 'concept_merge', elapsed_days: 0,
      detail: `概念「${from}」并入「${r.into}」（名字并集：${r.names.join('、')}）`,
    })
    return { course: c.name, ...r }
  }

  // ---- enc 覆盖层回填（kind=enrich，#140：出生/覆盖层分家；原 edit 通道随分家转富化）----

  /** enc 覆盖层回填入口（#148 权重新语义）：对课程里已有 Ready 内容、且反哺候选或
   * 题目 invokes 投影尚有未落 enc 边的非 practice 节点，批量生成一个 pending enrich
   * 提案（每节点一条字段条目：既有声明 enc 原样保留 + 补闭包内提升边）。权重 =
   * invokes 覆盖率投影（该前置被 invokes 的题数份额，调用站阶梯已退役）；候选边无
   * invokes 数据时落 schema 缺省权重 1，投影-only 边带投影 note。sha256 指纹锚定正典
   * 版本。可重入——已全覆盖节点不产生条目，重跑不会重复膨胀、不与已声明 enc 冲突；
   * practice 节点维持合法空 enc 不动。提案走人审（ADR-0003 修订变更语义）：过审计后由
   * graphApply(kind=enrich) 生效，留痕可回溯（state/覆盖层.jsonl）。 */
  async graphEncBackfill(courseKey?: string): Promise<GraphEncBackfillResult> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    assertNoBrokenNotes('enc-backfill', broken)
    // 既有声明 enc 的原始形态在 region 节点上（图视图 encOf 丢 note）；declaredEncOf 一次建表
    const encOfNode = declaredEncOf(graph)
    const fields: EnrichFieldEntry[] = []
    let scanned = 0
    for (const node of graph.order) {
      const fm = state[node]
      if (!fm || !hasReadyContent(fm)) continue
      if (graph.typeOf[node] === 'practice') continue // practice 节点无题，enc: [] 合法空态
      const [, regionName] = graph.blockOf[node]
      const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
      // 投影（#148）：节点在库题目的 invokes 覆盖率 → 前置节点的出生 w（候选边同享此权重）
      const proj = Content.invokesProjection(graph, node, (await this.bank.load(this.paths.courseRoot(c.root), node)).questions)
      const projW = new Map(proj.map(e => [e.node, { w: e.w, note: e.note }]))
      if (!Content.candidateCallSites(body).size && !proj.length) continue
      scanned++
      const declared = encOfNode.get(node) ?? []
      const declaredName = new Set(declared.map(e => e.node))
      const target = [...declared]
      for (const p of Content.encPromotion(graph, node, body, projW)) {
        if (declaredName.has(p.node)) continue
        target.push(p)
        declaredName.add(p.node)
      }
      for (const e of proj) {
        if (declaredName.has(e.node)) continue // 已声明/候选已补 → 保留在先形态
        target.push(e)
        declaredName.add(e.node)
      }
      if (target.length === declared.length) continue // 候选已全落 enc → 无变更
      fields.push({ node, enc: target })
    }
    if (!fields.length) {
      return { course: c.name, scanned, ops: 0, proposal: null, message: '没有需要回填的节点：候选已全落 enc，或没有可提升的反哺候选与 invokes 投影。' }
    }
    const yamlText = YAML.stringify({
      course: c.name,
      reason: `enc 反哺回填（覆盖层通道，ADR-0008 / #148 权重=invokes 覆盖率投影）：${fields.length} 个节点按既有 Ready 内容与在库题目补成分技能边`,
      fields,
    })
    const prop = await this.graphPropose('enrich', yamlText)
    return {
      course: c.name, scanned, ops: fields.length, proposal: prop,
      message: `已为 ${fields.length} 个节点生成 pending enrich 提案 #${String((prop as { id?: unknown }).id)}（覆盖层通道，sha256 指纹锚定正典）——过审后 learnhub_graph_apply(kind=enrich) 生效（可重入，无遗漏则返回 ops=0）`,
    }
  }

  async graphProposals(status?: string, kind?: string): Promise<ProposalRec[]> {
    return this.proposals.list(status, kind)
  }

  /** 提案统一 apply 入口（图谱域 + 项目域 + 实验域；面板 /proposals/apply 消费）。
   * kind 显式照抄提案记录——未知 kind 报错，绝不静默归一成 gen。图谱域走 audit 门禁，
   * 项目域无图审计（takePending 各自在 apply 内做）；project_plan 走引擎包装
   * （修订快照 diff + 换线/补支触发随结果带出，#149）。 */
  async proposalApply(
    kind: string, pid?: number,
  ): Promise<GraphApplyResult | ProjectApplyResult | ExperimentStartResult> {
    if (kind === 'experiment') return this.experimentApply(pid)
    if (kind === 'project_plan') return this.applyProjectPlanProposal(pid)
    if (kind === 'project_milestone') return this.projects.applyMilestone(pid)
    if (kind === 'edit' || kind === 'seed' || kind === 'enrich') return this.graphApply(kind, pid)
    throw new Error(`[apply] 非法 kind: ${String(kind)}（允许 ${PROPOSAL_KINDS.join('/')}）`)
  }

  /** 提案按 id apply（项目域工具入口）：记录自证 kind，pending 项目提案才受理。 */
  async projectApply(pid: number): Promise<ProjectApplyResult> {
    const list = await this.store.loadProposals()
    const prop = list.find(p => p.id === pid)
    if (!prop || prop.status !== 'pending') throw new Error(`[project-apply] 提案 #${pid} 不存在或已决。`)
    if (prop.kind === 'project_plan') return this.applyProjectPlanProposal(pid)
    if (prop.kind === 'project_milestone') return this.projects.applyMilestone(pid)
    throw new Error(`[project-apply] 提案 #${pid} 是 ${prop.kind} 提案——图谱域走 learnhub_graph_apply。`)
  }

  // ---- 项目域（P 区 / ADR-0015；#92）----

  async projectCreate(input: { name: string; goal: string; tier?: FadingTier; id?: string }): Promise<ProjectFm> {
    return this.projects.create(input)
  }

  async projectList(): Promise<ProjectFm[]> {
    return this.projects.list()
  }

  async projectShow(id: string): Promise<ProjectView> {
    return this.projects.view(id)
  }

  /** 追加一条项目日志（V-5 #113）：学习者自由记录；日志可经笔记源注册通道注册为
   * 复习源，引擎写入后顺带刷新已注册指纹（自己的写不算漂移）。 */
  async projectLogAppend(id: string, text: string, today?: string): Promise<{ project: string; path: string; day: string }> {
    const { today: day } = await this.learningDay()
    today ??= day
    const p = await this.projects.appendLog(id, text, today)
    await this.refreshSourceFingerprints([p])
    return { project: id, path: p, day: today }
  }

  /** 读项目日志全文（未写过 = null 合法空态，不建空文件）。 */
  async projectLog(id: string): Promise<{ project: string; path: string; log: string | null }> {
    return { project: id, path: this.paths.projectLogPath(id), log: await this.projects.readLog(id) }
  }

  /** 引擎写「注册豁免区」文件（我的产出/、项目日志）后刷新已注册源指纹（#107/#113）：
   * 引擎自己的写不算内容漂移——漂移语义只留给引擎之外的手改。该路径未注册或文件
   * 缺失时静默跳过（刷新是写侧卫生步骤，不是独立动作）。 */
  private async refreshSourceFingerprints(absPaths: string[]): Promise<void> {
    if (!absPaths.length) return
    const rels = absPaths.map(p => p.replace(/\\/g, '/').slice(this.vaultRoot.length + 1))
    const manifest = await this.noteManifest.load()
    let changed = false
    for (const item of manifest.sources) {
      if (!rels.includes(item.path)) continue
      const abs = `${this.vaultRoot}/${item.path}`
      if (!existsSync(abs)) continue
      const fp = fingerprintOf(await readFile(abs, 'utf8'))
      if (fp !== item.fingerprint) {
        item.fingerprint = fp
        changed = true
      }
    }
    if (changed) await this.noteManifest.save(manifest)
  }

  /** 生命周期变更（ADR-0015：无不可逆转移，任意状态可重开回 active）。 */
  async projectSetLifecycle(id: string, lifecycle: string): Promise<ProjectFm> {
    if (!isProjectLifecycle(lifecycle)) {
      throw new Error(`[project-lifecycle] 非法生命周期: ${lifecycle}（允许 ${PROJECT_LIFECYCLES.join('/')}）`)
    }
    const fm = await this.projects.load(id)
    const next = { ...fm, lifecycle }
    await this.projects.saveFm(id, next)
    return next
  }

  /** 渐退档变更（ADR-0015：档位移动判据归执行事件流，v1 学习者/agent 显式设定；
   * 已生成产物不回溯——新档只作用于后续生成）。 */
  async projectSetTier(id: string, tier: string): Promise<ProjectFm> {
    if (!isFadingTier(tier)) {
      throw new Error(`[project-tier] 非法档位: ${tier}（允许 ${FADING_TIERS.join('/')}）`)
    }
    const fm = await this.projects.load(id)
    const next = { ...fm, tier }
    await this.projects.saveFm(id, next)
    return next
  }

  /** 计划生成提示词：模板 + 项目档案 + 现状计划（修订时对照）。 */
  async projectPlanPack(id: string): Promise<string> {
    const fm = await this.projects.load(id)
    const tpl = await this.loadPrompt('项目里程碑计划')
    const current = fm.plan.length
      ? YAML.stringify({ plan: fm.plan })
      : '（空——本项目还没有里程碑计划，本次为初次规划）'
    return `${tpl}\n\n---\n\n## 项目档案\n\n- 项目 id：${fm.id}\n- 项目名：${fm.name}\n- 生命周期：${fm.lifecycle}\n- 渐退档：${fm.tier}\n- 目标描述：\n\n${fm.goal}\n\n## 现状计划（修订时给出完整新版本，不保守微调）\n\n${current}`
  }

  async projectPlanPropose(id: string, yamlText: string) {
    return this.projects.proposePlan(id, yamlText)
  }

  /** 里程碑产物生成提示词：模板 + 项目档案 + 计划全景 + 本里程碑任务与档位。 */
  async projectMilestonePack(id: string, milestoneId: string): Promise<string> {
    const view = await this.projects.view(id)
    const fm = view.fm
    const hit = view.milestones.find(m => m.id === milestoneId)
    if (!hit) {
      throw new Error(`[project-milestone-pack] 项目「${id}」的计划里没有里程碑「${milestoneId}」。`)
    }
    const tpl = await this.loadPrompt('项目里程碑产物')
    const planTable = view.milestones
      .map((m, i) => `${i + 1}. ${m.id}｜${m.name}｜任务类：${m.task_class}${m.generated ? '｜已生成' : ''}`)
      .join('\n')
    return `${tpl}\n\n---\n\n## 项目档案\n\n- 项目 id：${fm.id}\n- 项目名：${fm.name}\n- 生命周期：${fm.lifecycle}\n- 目标描述：\n\n${fm.goal}\n\n## 里程碑计划（本里程碑的位置）\n\n${planTable}\n\n## 本里程碑任务\n\n- 里程碑 id：${hit.id}\n- 名称：${hit.name}\n- 任务类：${hit.task_class}\n- 验收要点草案：${hit.acceptance_hints}\n- 当前档位：${fm.tier}（产物按此档生成，只写这一档）\n${hit.generated ? `- 注意：该里程碑已有产物，本次是按档重生成——将走提案通道，apply 前旧文有快照。\n` : ''}`
  }

  /** 里程碑产物落盘分发：未生成 = 直落（首生）；已生成 = 自动转重生成提案（带快照覆盖）。 */
  async projectMilestoneWrite(id: string, milestoneId: string, md: string): Promise<
    { written: string; tier: FadingTier } | { proposed: number; kind: 'project_milestone'; file: string }
  > {
    return this.projects.writeMilestone(id, milestoneId, md)
  }

  // ---- 过点对账 / 检索点 / 行为推断 enc（P-3/P-4/P-6；#94/#93/#96）----

  /** 项目关联节点解析（计划声明 ∪ 调用补充；ADR-0015 裁决 6：关联可显式声明，永不门禁）。
   * 定位失败 fail loud 并点名——悬空关联先修计划，不在消费面静默降级。 */
  private async resolveProjectNodes(specs: string[]): Promise<Array<{ course: CourseEntry; node: string }>> {
    const out: Array<{ course: CourseEntry; node: string }> = []
    const seen = new Set<string>()
    for (const spec of specs) {
      const hit = await this.locateNode(spec)
      const key = `${hit.course.name}/${hit.node}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(hit)
    }
    return out
  }

  private planItemOf(fm: ProjectFm, milestoneId: string, tool: string): PlanItem {
    const item = fm.plan.find(m => m.id === milestoneId)
    if (!item) {
      throw new Error(`[${tool}] 项目「${fm.id}」的计划里没有里程碑「${milestoneId}」（先修订计划）。`)
    }
    return item
  }

  /** 关联节点的活跃题池（pass 定价校准与检索点抽题共用）：逐节点读题库、滤归档。
   * course/node 与题目一起返回，消费方各取所需。 */
  private async loadActivePools(linked: Array<{ course: CourseEntry; node: string }>): Promise<Array<{ course: CourseEntry; node: string; questions: BankQuestion[] }>> {
    const pools: Array<{ course: CourseEntry; node: string; questions: BankQuestion[] }> = []
    for (const { course, node } of linked) {
      const bank = await this.bank.load(this.paths.courseRoot(course.root), node)
      const active = bank.questions.filter(q => !q.archived)
      if (active.length) pools.push({ course, node, questions: active })
    }
    return pools
  }

  /** 显式过点（#94 / 设计 §5）：里程碑完成 = 学习者显式动作，无清单门禁、无题目门禁。
   * 定价 = milestonePrice（计划 est 申报 × 关联节点题池 FSRS 难度校准；无申报/无证据
   * 回落缺省/中性）——校准池锁定为计划条目 nodes 声明，调用方不能临时加池（过点即
   * 锁定，事后注水＝账本不诚实）。对账流水 journal kind='milestone_settle' 一次性入账
   * 并锁定（重复过点被守卫拒绝）。这是项目域唯一获准写 journal 的动作：真实投入的
   * 显式陈述，进账本汇总与 streak 口径（ADR-0015 裁决 5 的 Settle 新粒度；
   * 计划/产物/检索点仍零 journal 写入）。 */
  async projectMilestonePass(
    id: string, milestoneId: string,
  ): Promise<{ project: string; milestone: string; name: string; xp: number; detail: string }> {
    const fm = await this.projects.load(id)
    const item = this.planItemOf(fm, milestoneId, 'project-pass')
    const linked = await this.resolveProjectNodes(item.nodes ?? [])
    const pools = await this.loadActivePools(linked)
    const pool = pools.flatMap(p => p.questions)
    const calibration = pool.length ? difficultyCalibration(pool) : 1
    const price = milestonePrice(item.est, calibration)
    const detail = `N₀=${item.est ?? XP_PER_MILESTONE_DEFAULT}${item.est ? '（est 申报）' : '（缺省，无 est 申报）'}`
      + ` × k=${calibration.toFixed(2)}（${pool.length ? `${linked.length} 个关联节点题池校准` : '无关联题池证据，取中性'}）= ${price}，定价锁定`
    const r = await this.projects.passMilestone(id, milestoneId, { xp: price, detail })
    return { project: r.project, milestone: r.milestone, name: r.name, xp: r.xp, detail }
  }

  /** 发起里程碑检索点会话（#93）：产物已生成（交付物在手）才受理；从关联节点题池
   * 抽题（跨池轮转、未作答优先、due 最早优先），抽题流水落 projects/<id>/recall.jsonl。
   * 零 XP、零 FSRS、零 journal——检索点只服务知识底座，不作项目验收标准。 */
  async projectMilestoneRecall(
    id: string, milestoneId: string, opts: { nodes?: string[]; limit?: number } = {},
  ): Promise<{ project: string; milestone: string; file: string; questions: Array<RecallQuestion & { answer: BankQuestion['answer']; options?: string[]; explanation?: string }> }> {
    const delivered = await this.projects.isMilestoneDelivered(id, milestoneId)
    if (!delivered.delivered) {
      throw new Error(`[project-recall] 里程碑「${milestoneId}」的产物尚未生成——检索点在交付物在手时发起（先 learnhub_project_milestone_generate）。`)
    }
    const fm = await this.projects.load(id)
    const item = this.planItemOf(fm, milestoneId, 'project-recall')
    const specs = [...new Set([...(item.nodes ?? []), ...(opts.nodes ?? [])])]
    if (!specs.length) {
      throw new Error('[project-recall] 该里程碑没有关联节点：计划条目 nodes 或调用参数 nodes 至少给一个（节点名或「课程/节点」）。')
    }
    const linked = await this.resolveProjectNodes(specs)
    const pools = await this.loadActivePools(linked)
    const byKey = new Map<string, BankQuestion>()
    for (const p of pools) {
      for (const q of p.questions) byKey.set(`${p.course.name}\u0000${p.node}\u0000${q.id}`, q)
    }
    if (!pools.length) {
      throw new Error('[project-recall] 关联节点都没有可用题目（题库为空或全归档）——先出题，或修订计划的 nodes 关联。')
    }
    const drawn = drawRecallQuestions(pools.map(p => ({ course: p.course.name, node: p.node, questions: p.questions })), opts.limit ?? 5, this.jolRng)
    await appendRecallRec(this.paths, id, {
      ts: nowIso(), kind: 'draw', milestone: milestoneId, file: delivered.file,
      nodes: specs, questions: drawn,
    })
    const questions = drawn.map(d => {
      const q = byKey.get(`${d.course}\u0000${d.node}\u0000${d.qid}`)!
      return { ...d, answer: q.answer, ...(q.options ? { options: q.options } : {}), ...(q.explanation ? { explanation: q.explanation } : {}) }
    })
    return { project: id, milestone: milestoneId, file: delivered.file, questions }
  }

  /** 检索点自述落档（#93）：学习者口述「到目前为止的关键决策」，追加进 recall.jsonl。
   * 判词不评、canonical 不碰——自述是给复盘看的，不是给调度喂的。 */
  async projectRecallReflect(id: string, milestoneId: string, narration: string): Promise<{ project: string; milestone: string; recorded: true }> {
    const trimmed = narration?.trim()
    if (!trimmed) throw new Error('[project-recall] 自述不能为空（关键决策口述原文）。')
    const fm = await this.projects.load(id)
    this.planItemOf(fm, milestoneId, 'project-recall')
    await appendRecallRec(this.paths, id, { ts: nowIso(), kind: 'reflect', milestone: milestoneId, narration: trimmed })
    return { project: id, milestone: milestoneId, recorded: true }
  }

  /** 检索点流水读取（#93；面板/复盘消费）。 */
  async projectRecallLog(id: string): Promise<RecallRec[]> {
    await this.projects.load(id)
    return recallRecsAll(this.paths, id)
  }

  // ---- 执行事件流 / Mastery 交叉 2×2（P-7 / #98 / ADR-0015 §3/§4/§8）----

  /** 记一条项目执行事件（P-7 #98；#149 stub 回流修订；#146 复诊闸）：项目自己的事件流
   * （projects/<id>/exec.jsonl，与节点练习证据通道是两条流，ADR-0015 §4）。评级 1-4
   * 整数 + 来源 auto/self/ai——auto 必须带可观测证据走确定性映射（ratingFromEvidence，
   * skills 先例）；自评/ai 照收（ADR-0016 自报即可信）。
   * 上行回流 = **行使即回流（节点级，#149）**：事件 nodes 解析到图上的每个节点（含种子簇
   * stub——有笔记有身份）各回流一次练习证据（applyPracticeEvidence 单向复制，同节点
   * 去重）；粗 pre 占位边不是回流通道（行使记录留在 exec 流水，边零证据写入——
   * 「粗 pre 只记流不回流」）；probation 在途的插入节点不回流（#146 复诊闸，只记流，
   * proven 后恢复）；被行使的既有 enc 边数随结果带出（enc 面观测，回流不再以 enc 边
   * 为门）。零 XP、零 journal、零 review-log、零 sessions/srs（ADR-0015 §7）。 */
  async projectExecLog(
    id: string,
    input: { source: string; rating?: number; evidence?: ExecutionEvidence; nodes?: string[]; note?: string },
  ): Promise<ProjectExecResult> {
    const fm = await this.projects.load(id)
    const source = input.source
    if (!(source === 'auto' || source === 'self' || source === 'ai')) {
      throw new Error(`[project-exec] source 只能是 auto/self/ai（收到 ${String(source)}）。`)
    }
    let rating: unknown = input.rating
    if (source === 'auto') {
      if (!input.evidence) {
        throw new Error("[project-exec] source='auto' 需要可观测证据（evidence.accuracy/self_help）——确定性映射是自动来源的唯一入口；无可观测判据时改用自评档（source='self' + rating）。")
      }
      rating = ratingFromEvidence(input.evidence)
    }
    const v = validateExecEvent(rating, source, input.nodes ?? [], input.note, 'project-exec')
    const { today } = await this.learningDay()
    const score = execRatingScore(v.rating)

    // 行使判定与节点级回流：逐课程载图（enc 边归节点域、不可跨图），每节点至多回流一次
    const linked = v.nodes.length ? await this.resolveProjectNodes(v.nodes) : []
    const byCourse = new Map<string, string[]>()
    for (const { course, node } of linked) {
      const list = byCourse.get(course.name) ?? []
      list.push(node)
      byCourse.set(course.name, list)
    }
    const backflow: ProjectExecBackflow[] = []
    const skipped: Array<{ course: string; node: string; reason: string }> = []
    let edges = 0
    for (const [courseName, nodes] of byCourse) {
      const c = await this.registry.get(courseName)
      if (!c) continue
      const { graph } = await this.loadView(c)
      // probation 在途行使闸（#146）：实验中的插入节点不回流练习证据（行使照落 exec 流水）。
      const gated = foldProbation(await readProbationLedger(this.paths, c.root))
      const gatedNodes = new Set(gated.inFlight.map(e => e.node))
      // enc 面观测：被行使的既有 enc 边数（两端都在 nodes 内）；回流已改节点级，边数只作观测
      edges += exercisedEncEdges(nodes, holder => (graph.encOf[holder] ?? []).map(e => e[0])).length
      for (const node of nodes) {
        if (gatedNodes.has(node)) {
          skipped.push({
            course: courseName, node,
            reason: 'probation 在途（实验中的插入节点）——行使只记流不回流练习证据，proven 后恢复',
          })
          continue
        }
        const note = await this.nodeNote(c, graph, node)
        if (!note.fm) {
          skipped.push({
            course: courseName, node,
            reason: '节点笔记缺失或 frontmatter 不可用——练习证据无处落，跳过（Missing 合法空态）',
          })
          continue
        }
        const before = note.fm.practice_ema ?? 0
        const next = applyPracticeEvidence(note.fm, score)
        await this.saveNodeNote(note.path, next, note.body)
        backflow.push({
          course: courseName, node,
          ema_before: before, ema_after: next.practice_ema ?? 0, mastery_after: masteryOfFm(next),
        })
      }
    }

    await appendExecRec(this.paths, id, {
      ts: nowIso(), day: today, rating: v.rating, source: v.source,
      nodes: v.nodes, tier: fm.tier, ...(v.note ? { note: v.note } : {}),
    })
    backflow.sort((a, b) => a.course.localeCompare(b.course) || a.node.localeCompare(b.node))
    return {
      project: id, day: today, rating: v.rating, source: v.source, score,
      nodes: v.nodes, edges, backflow, skipped,
    }
  }

  /** 项目 2×2 交叉视图（P-7 #98；项目面板核心视图，只读）：X = 关联节点 masteryOfFm
   * 均值（陈述性掌握），Y = 执行事件分 EMA 0.7/0.3（项目执行证据），阈值统一
   * CROSS_AXIS_THRESHOLD；四象限 = 会而不会用 / 会用而不牢 / 健康 / 补底。附只读
   * 入档推荐（challenge point：升档判据 = 档内表现 + 知识底座；引擎提议学习者经
   * projectSetTier 改档——不写任何状态、不参与 gateMilestone/passMilestone/门禁）。 */
  async projectCrossView(id: string): Promise<ProjectCrossDoc> {
    const fm = await this.projects.load(id)
    const specs = [...new Set(fm.plan.flatMap(m => m.nodes ?? []))]
    const linked = specs.length ? await this.resolveProjectNodes(specs) : []
    const linkedNodes: Array<{ course: string; node: string; mastery: number }> = []
    const masteryList: number[] = []
    const viewCache = new Map<string, Awaited<ReturnType<LearnhubEngine['loadView']>>>()
    for (const { course, node } of linked) {
      let v = viewCache.get(course.name)
      if (!v) {
        v = await this.loadView(course)
        viewCache.set(course.name, v)
      }
      const m = masteryOfFm(v.state[node] ?? null)
      linkedNodes.push({ course: course.name, node, mastery: m })
      masteryList.push(m)
    }
    const x = masteryAggregate(masteryList)
    const recs = await execRecsAll(this.paths, id)
    const y = execEvidenceScore(recs)
    const avg = (list: ProjectExecRec[]) => list.length
      ? Math.round(list.reduce((a, r) => a + execRatingScore(r.rating), 0) / list.length * 1000) / 1000
      : null
    // 档内表现：事件带的 tier 快照 = 当前档才计入（改档后旧档事件不冒充新档表现）
    const inTierRecs = recs.filter(r => r.tier === fm.tier)
    return {
      project: fm.id, name: fm.name, lifecycle: fm.lifecycle, tier: fm.tier,
      x: { value: x, caliber: `关联节点 masteryOfFm 均值（${masteryList.length} 个${specs.length ? '' : '；计划未关联节点'}）` },
      y: { value: y, caliber: `执行事件分（评级映射 0-1）EMA 0.7/0.3（${recs.length} 条事件）` },
      quadrant: classifyCross(x, y),
      linked_nodes: linkedNodes,
      exec: { count: recs.length, ema: y, avg: avg(recs) },
      recommendation: recommendTier(fm.tier, { count: inTierRecs.length, avg: avg(inTierRecs) }, x),
      events: recs.slice(-20).reverse(),
      thresholds: {
        axis: CROSS_AXIS_THRESHOLD,
        promote_min_events: TIER_REC_MIN_EVENTS,
        promote_score: TIER_REC_PROMOTE_SCORE,
        demote_score: TIER_REC_DEMOTE_SCORE,
      },
    }
  }

  /** 行为推断 enc 候选边（#96 / ADR-0015 裁决 3/6）：项目窗口内的翻卡/回看共现 →
   * 带置信度候选边 → 每课程单个 pending edit 提案走人审（enc_backfill「单提案人审」
   * 先例；set_enc 整体替换、既有声明 enc 原样保留，零 schema 破坏）。窗口终点 =
   * 指定里程碑的过点时刻（省略则现在）；事件源 = review-log（synthetic 除外）+ practice，
   * 只取关联节点。边只在 pre 闭包内落（CONTEXT Enc 契约 / 审计 E7）——跨无关节点对
   * 不硬提边，降级为 blocked_no_pre 信号（带方向提示，供未来补 pre 边参考）；
   * 已声明边不重复提名。 */
  async projectEncCandidates(
    id: string, opts: { milestone?: string; nodes?: string[]; window_days?: number; min_co?: number } = {},
  ): Promise<{
    project: string; window: { start: string; end: string; days: number }
    events: number; candidates: Array<{ course: string; holder: string; skill: string; co: number; w: number }>
    blocked_no_pre: Array<{ course: string; a: string; b: string; co: number; hint_skill: string; why: string }>
    proposals: Array<{ course: string; id: number; ops: number }>; skipped_declared: number
  }> {
    const fm = await this.projects.load(id)
    const days = Math.min(90, Math.max(1, Math.round(opts.window_days ?? 14)))
    const minCo = Math.max(1, Math.round(opts.min_co ?? 2))
    let endMs = Date.now()
    if (opts.milestone !== undefined) {
      const rec = await this.projects.milestoneSettleRec(id, opts.milestone)
      if (!rec) {
        throw new Error(`[project-enc] 里程碑「${opts.milestone}」没有过点记录——共现窗口没有锚点（先过点，或省略 milestone 以现在为终点）。`)
      }
      endMs = Date.parse(rec.ts)
    }
    const startMs = endMs - days * 86_400_000
    const specs = [...new Set([...fm.plan.flatMap(m => m.nodes ?? []), ...(opts.nodes ?? [])])]
    if (!specs.length) {
      throw new Error('[project-enc] 项目没有关联节点：计划条目 nodes 或调用参数 nodes 至少给一个（行为扫描只在关联节点间成对）。')
    }
    const linked = await this.resolveProjectNodes(specs)
    const byCourse = new Map<string, Set<string>>()
    for (const { course, node } of linked) {
      let set = byCourse.get(course.name)
      if (!set) byCourse.set(course.name, set = new Set())
      set.add(node)
    }
    const { cutoff } = await this.learningDay()
    const inWindow = (ts: string) => {
      const ms = Date.parse(ts)
      return ms >= startMs && ms <= endMs
    }
    const [reviews, practices] = await Promise.all([
      this.store.reviewLogAll(), this.store.practiceAll(),
    ])
    let events = 0
    const firstDayByCourse = new Map<string, Map<string, string>>()
    const eventsByCourse = new Map<string, Array<{ node: string; day: string }>>()
    const bump = (course: string, node: string, ts: string) => {
      if (!byCourse.get(course)?.has(node)) return
      if (!inWindow(ts)) return
      const day = dayOfTs(ts, cutoff)
      events++
      const list = eventsByCourse.get(course) ?? []
      list.push({ node, day })
      eventsByCourse.set(course, list)
      const firstDays = firstDayByCourse.get(course) ?? new Map<string, string>()
      const prev = firstDays.get(node)
      if (prev === undefined || day < prev) firstDays.set(node, day)
      firstDayByCourse.set(course, firstDays)
    }
    for (const r of reviews) if (r.rating_source !== 'synthetic') bump(r.course, r.node, r.ts)
    for (const r of practices) bump(r.course, r.node, r.ts)

    const candidates: Array<{ course: string; holder: string; skill: string; co: number; w: number }> = []
    const blockedNoPre: Array<{ course: string; a: string; b: string; co: number; hint_skill: string; why: string }> = []
    const proposals: Array<{ course: string; id: number; ops: number }> = []
    let skippedDeclared = 0
    for (const [courseName, nodes] of byCourse) {
      const pairs = cooccurrencePairs(eventsByCourse.get(courseName) ?? [], minCo)
      if (!pairs.length) continue
      const c = await this.registry.get(courseName)
      if (!c) continue
      const { graph } = await this.loadView(c)
      const declared = declaredEncOf(graph)
      const fields: EnrichFieldEntry[] = []
      for (const pair of pairs.slice(0, 12)) {
        const dir = orientCandidate(
          pair.a, pair.b,
          (from, to) => graph.nset.has(from) && graph.nset.has(to) && graph.isAncestor(from, to),
          node => firstDayByCourse.get(courseName)?.get(node),
        )
        if (!dir.ok) {
          blockedNoPre.push({ course: courseName, a: pair.a, b: pair.b, co: pair.co, hint_skill: dir.hint_skill, why: dir.why })
          continue
        }
        if (!nodes.has(dir.holder) || !nodes.has(dir.skill)) continue
        const existing = declared.get(dir.holder) ?? []
        if (existing.some(e => e.node === dir.skill)) {
          skippedDeclared++
          continue
        }
        const w = coWeight(pair.co)
        fields.push({
          node: dir.holder,
          enc: [...existing, { node: dir.skill, w, note: `行为推断（P-6 #96）：${days} 天窗口内共现 ${pair.co} 天（pre 闭包方向）` }],
        })
        candidates.push({ course: courseName, holder: dir.holder, skill: dir.skill, co: pair.co, w })
      }
      if (!fields.length) continue
      const yamlText = YAML.stringify({
        course: courseName,
        reason: `行为推断 enc 边（覆盖层通道，P-6 #96）：项目「${fm.name}」${days} 天窗口内翻卡/回看共现 ≥${minCo} 天的关联节点对`,
        fields,
      })
      const prop = await this.graphPropose('enrich', yamlText)
      proposals.push({ course: courseName, id: (prop as { id: number }).id, ops: fields.length })
    }
    return {
      project: id,
      window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), days },
      events, candidates, blocked_no_pre: blockedNoPre, proposals, skipped_declared: skippedDeclared,
    }
  }

  // ---- 目标反编译（P-5 / #95：逆向设计 + PjBL；v8 种子簇形态 #149）----

  /** 目标反编译（P-5，v8 #149）：一次模型调用产出**双提案**——里程碑计划草案
   * （project_plan）与知识子图种子簇（kind=seed，子图簇直通新课程的种子起点，
   * 起点 basis 铸 project）。同源同进同退：
   * - 受理侧门禁全部过完才落任何提案：双半区 schema 门 + 名字对账门（plan.nodes ⊆
   *   种子簇 ∪ 既有图节点名）+ 种子落点/结构预检——任一失败回灌修复一轮，仍败则
   *   DECOMPILE_GATE_FAILED 零提案（同退的静态半）；
   * - 两提案 pair 互相指认：apply 只走 projectDecompileApply 联合入口（种子先落图、
   *   计划后落盘），单边 apply 被守卫拒、单边 reject 联动拒另一半（同退的动态半）。
   * 显式目标课程 = 已播种课程的新计划半区（nodes 引用既有节点名，对账门收紧到既有
   * 图；新知识需要走计划修订驱动的教练补支）；省略 course = 种子簇充当新课程种子。
   * 检索面复用 Vault 先验（只读）；apply 前零 canonical 写入（ADR-0015 裁决 6）。 */
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
    const fm = await this.projects.load(id)
    const goal = decompileGoalOf(opts.goal, fm.goal)
    // 注册笔记（V-1 manifest 只读）：显式 notes 按 id/path 解析，缺省 = 全部注册源
    const manifest = await this.noteManifest.load()
    const baseOf = (path: string): string => path.split('/').pop()!.replace(/\.md$/i, '')
    const picked: Array<{ id: string; path: string; title: string }> = []
    if (opts.notes?.length) {
      const byKey = new Map(manifest.sources.flatMap(s => [[s.id, s], [s.path.replace(/\\/g, '/'), s]] as const))
      for (const spec of opts.notes) {
        const hit = byKey.get(spec.replace(/\\/g, '/'))
        if (!hit) {
          throw new Error(`[project-decompile] 笔记「${spec}」不在注册清单（先 learnhub_note_source_register，或省略 notes 取全部注册源）。`)
        }
        picked.push({ id: hit.id, path: hit.path, title: hit.title ?? baseOf(hit.path) })
      }
    } else {
      for (const s of manifest.sources) {
        picked.push({ id: s.id, path: s.path, title: s.title ?? baseOf(s.path) })
      }
    }
    // 落点裁决（受理前）：显式课程必须在册并取其既有节点名（对账域）；未给 = 种子簇
    // 充当新课程种子（mode=new）
    const explicitCourse = opts.course?.trim()
    let target: CourseEntry | null = null
    if (explicitCourse) {
      target = await this.registry.get(explicitCourse)
      if (!target) throw new Error(`[project-decompile] 注册表中没有课程「${explicitCourse}」（显式目标课程须先建课播种；省略 course 参数可让种子簇充当新课程）。`)
    }
    // Vault 先验（只读检索）注入反编译上下文
    const terms = decompileTerms(goal, picked.map(p => p.title))
    const centerRel = this.paths.centerRoot.slice(this.vaultRoot.length + 1)
    const hits = terms.length ? await searchVaultPrior(this.vaultRoot, centerRel, terms) : []
    const prior = priorSection(hits)
    // 子图落点上下文：显式课程给现有结构（对账取值域）；未给 → seed 半区必出
    let courseBlock: string
    if (target) {
      const { graph } = await this.loadView(target)
      const names = graph.names.slice().sort()
      courseBlock = `- 目标课程：${target.name}（已播种/既有课程——**不产 seed 半区**，只给 plan）\n- 现有结构（plan.nodes 只能引用这些节点名，写「${target.name}/节点名」全形）：\n${names.map(n => `  - ${n}`).join('\n') || '  -（空图）'}`
    } else {
      courseBlock = '- 未指定目标课程：seed 半区必出（自拟新课程名写进 seed.course，子图簇 = 该新课程的种子：1–3 起点 + 终点）；plan.nodes 引用种子簇节点名（写「课程名/节点名」全形）'
    }
    const tpl = await this.loadPrompt('项目目标反编译')
    const notesList = picked.length ? picked.map(p => `- 《${p.title}》（${p.path}）`).join('\n') : '-（无注册笔记）'
    const current = fm.plan.length
      ? YAML.stringify({ plan: fm.plan })
      : '（空——本项目还没有里程碑计划，本次为初次规划）'
    const pack = `${tpl}\n\n---\n\n## 目标项目档案\n\n- 项目 id：${fm.id}\n- 项目名：${fm.name}\n- 渐退档：${fm.tier}\n- 目标描述（目标项目描述原文）：\n\n${goal}\n\n## 现状计划（给出完整新版本，不保守微调）\n\n${current}\n\n## 注册笔记（Vault 先验的检索来源）\n\n${notesList}\n\n## 知识子图落点\n\n${courseBlock}${prior ? `\n\n---\n\n${prior}` : ''}`
    // 模型产出 → 双产物校验门 + 名字对账门（未过回灌修复一轮，对齐「生成→门禁→修复
    // 一轮」机械）。对账域 = 种子簇 ∪ 全部启用课程的图节点名（与消费面 locateNode 的
    // 跨课解析同域——裸名歧义/悬空在受理前拦下，不留到消费面才炸）。
    const reconcileErrors = async (doc: DecompileDoc | undefined): Promise<string[]> => {
      if (!doc) return []
      const existingByCourse = new Map<string, Set<string>>()
      const ensureNames = async (courseName: string): Promise<void> => {
        if (existingByCourse.has(courseName)) return
        const c = await this.registry.get(courseName)
        if (!c) return
        const { graph } = await this.loadView(c)
        existingByCourse.set(courseName, new Set(graph.names))
      }
      for (const c of await this.enabledCourses()) await ensureNames(c.name)
      const seedCourseNames = new Set<string>()
      const extra: string[] = []
      if (doc.seed) {
        for (const n of [doc.seed.endpoint.name, ...doc.seed.starts.map(s => s.name)]) seedCourseNames.add(n)
        if (await this.registry.get(doc.seed.course)) {
          extra.push(`seed.course「${doc.seed.course}」已在注册表（mode=new 新课程入口撞名）——自拟一个新课程名，或显式 course 参数指向既有课程`)
        }
      }
      return [...extra, ...reconcilePlanNodes(doc.plan, {
        ...(doc.seed ? { seed: { course: doc.seed.course, nodeNames: seedCourseNames } } : {}),
        existingByCourse,
      })]
    }
    let raw = await llm(pack)
    let gate = splitDecompileDoc(YAML.parseModel(raw), fm.id, { expectSeed: !target })
    let reconcile = await reconcileErrors(gate.result)
    let repaired = false
    if (gate.errors.length || reconcile.length) {
      repaired = true
      raw = await llm(decompileRepairPrompt(pack, raw, [...gate.errors, ...reconcile].map(e => `  ✗ ${e}`)))
      gate = splitDecompileDoc(YAML.parseModel(raw), fm.id, { expectSeed: !target })
      reconcile = await reconcileErrors(gate.result)
    }
    if (gate.errors.length || reconcile.length || !gate.result) {
      const e: Error & { code?: string } = new Error(
        `[project-decompile] 模型产出未过双产物校验门（已自动修复重试一轮，提案未受理）：\n`
        + [...gate.errors, ...reconcile].map(x => `  ✗ ${x}`).join('\n'))
      e.code = 'DECOMPILE_GATE_FAILED'
      throw e
    }
    const doc: DecompileDoc = gate.result
    // 名字对账门已在修复环内跑过（reconcile 为空 = 通过）——此处直接受理。
    // 双提案受理（先种子后计划）：种子提案先落（重门已预检通过）；计划提案**出生即带
    // pair**（联动守卫从落盘那一刻生效——任一时刻崩溃都不会留下可单边 apply 的无守卫
    // 计划半区）；最后补种子半区的 pair 指认（此窗口内计划已被守卫保护，种子半区单边
    // apply 无害——计划未落盘就无悬空引用可言）。概念引用在 proposeSeed 受理门对
    // 登记表（铸名随种子 apply 同事务落盘）。
    let seedId: number | null = null
    let planProposal: Awaited<ReturnType<LearnhubEngine['projects']['proposePlan']>> | null = null
    try {
      if (doc.seed) {
        seedId = ((await this.graphPropose('seed', YAML.stringify(doc.seed))) as { id: number }).id
      }
      planProposal = await this.projects.proposePlan(fm.id, YAML.stringify({ project: fm.id, plan: doc.plan }), seedId !== null ? { pair: seedId } : {})
      if (seedId !== null) await this.store.updateProposal(seedId, { pair: planProposal.id })
    } catch (err) {
      // 计划半区受理失败：种子半区联动退回（不留孤儿 pending），原样抛错
      if (seedId !== null) {
        await this.proposals.reject(seedId, `同源双提案受理失败联动退回：${err instanceof Error ? err.message : String(err)}`).catch(() => undefined)
      }
      throw err
    }
    const seedProposal = doc.seed
      ? { id: seedId!, kind: 'seed' as const, course: doc.seed.course, endpoint: doc.seed.endpoint.name, starts: doc.seed.starts.length }
      : null
    return {
      project: fm.id,
      prior_hits: hits.length,
      notes: picked.map(p => p.path),
      repaired,
      plan_proposal: planProposal!,
      seed_proposal: seedProposal,
      pair: { plan: planProposal!.id, seed: seedProposal?.id ?? null },
    }
  }

  /** 反编译双提案联合 apply（#149 同进同退的动态半）：两提案 pair 互指才受理；
   * 种子先落图（簇节点 + 终点锚 + 笔记脚手架——计划引用先有图可解析）、计划后落盘。
   * 任一半区已是 applied = 崩溃恢复续段（跳过重放该半区）；rejected = 拒绝复活
   * （重新反编译产生新对）。 */
  async projectDecompileApply(planPid: number, seedPid: number): Promise<{
    project: string
    seed: Record<string, unknown> | null
    plan: ProjectApplyResult | null
  }> {
    const list = await this.store.loadProposals()
    const plan = list.find(p => p.id === planPid)
    const seed = list.find(p => p.id === seedPid)
    const bad = (why: string): Error => new Error(`[project-decompile-apply] ${why}`)
    if (!plan || (plan.status !== 'pending' && plan.status !== 'applied')) {
      throw bad(`计划提案 #${planPid} 不存在或已决（pending/applied 之外不受理）。`)
    }
    if (!seed || (seed.status !== 'pending' && seed.status !== 'applied')) {
      throw bad(`种子提案 #${seedPid} 不存在或已决（pending/applied 之外不受理）。`)
    }
    if (plan.kind !== 'project_plan' || seed.kind !== 'seed') {
      throw bad(`提案 kind 不对（#${planPid}=${plan.kind}，#${seedPid}=${seed.kind}）——联合 apply 只收 反编译对（project_plan + seed）。`)
    }
    if (plan.pair !== seedPid || seed.pair !== planPid) {
      throw bad(`提案 #${planPid} 与 #${seedPid} 不是同一反编译对（pair 联动缺失或互指不符）——反编译对只走本联合入口；独立提案（无 pair）才走 learnhub_project_apply / learnhub_graph_apply 单独生效。`)
    }
    const today = (await this.learningDay()).today
    // 种子先落图：簇节点 + 终点锚 + ensureNotesFor 笔记脚手架——计划引用先有图可解析
    const seedResult = seed.status === 'pending'
      ? await this.proposals.applySeed(seedPid, await this.seedAuditFor(seed.course, today), today, { pairApply: true })
      : null
    const planResult = plan.status === 'pending'
      ? await this.applyProjectPlanProposal(planPid, { pairApply: true })
      : null
    return { project: (planResult as { project?: string })?.project ?? plan.course, seed: seedResult, plan: planResult }
  }

  /** 种子 apply 的 audit 门预计算（graphApply 同款；mode=new 课程无 data 目录时空跑）。
   * 联合 apply 直调 proposals.applySeed 时复用，不经过 graphApply 的 takePending。 */
  private async seedAuditFor(courseName: string, today: string): Promise<ApplyAudit> {
    const course = await this.registry.get(courseName)
    let audit: ApplyAudit = { ok: true, warns: [], health: 0 }
    if (course && existsSync(this.paths.dataDir(course.root))) {
      const { graph } = await this.loadView(course)
      const result = await runAudit(this.paths, course.root, course.name, graph, graph.regions, today)
      audit = { ok: !result.failed, warns: result.warns.slice(0, 8), health: graphHealthScore(graph).score }
    }
    return audit
  }

  /** 计划提案 apply 的引擎包装（#149 修订驱动生长）：apply 前捕旧计划，apply 后派生
   * 快照 diff（id 为身份锚）并解析换线/补支触发（按锚定课程聚合，宿主入队生长批）；
   * 已过点里程碑被移除/改名出显式警告（不拒绝）。单边守卫在 projects.applyPlan 内。 */
  async applyProjectPlanProposal(
    pid?: number, opts: { pairApply?: boolean } = {},
  ): Promise<ProjectApplyResult> {
    let before: ProjectFm | null = null
    const proposals = await this.store.loadProposals()
    const targetPid = pid ?? [...proposals].reverse().find(p => p.status === 'pending' && p.kind === 'project_plan')?.id
    if (targetPid !== undefined) {
      const prop = proposals.find(p => p.id === targetPid)
      if (prop?.kind === 'project_plan') {
        before = await this.projects.load(prop.course).catch(() => null)
      }
    }
    const result = await this.projects.applyPlan(pid, opts)
    if (result.kind !== 'project_plan') return result
    const after = await this.projects.load(result.project)
    const diff = planRevisionDiff(before?.plan ?? [], after.plan)
    const { triggers, warnings } = await this.planGrowthTriggers(result.project, before, after, diff)
    return {
      ...result,
      plan_diff: diff,
      ...(warnings.length ? { plan_diff_warnings: warnings } : {}),
      ...(triggers.length ? { growth: triggers } : {}),
    }
  }

  /** 换线/补支触发解析（读侧派生，#126 接口输入）：added/retargeted 条目的每个
   * nodes 引用——图上已存在 = 换线（stub 激活：内容生成/接入路线）；图上不存在 =
   * 补支（朝新里程碑长粗分支）。路由目标：显式「课程/」前缀照抄；裸名按其余计划
   * 条目的锚定课程集收敛（恰一门 → 路由，否则落警告不强路由）。已过点里程碑被
   * 移除/改名（同 id）出显式警告——账本事实不改写，但「终点消失/漂移」要可见。 */
  private async planGrowthTriggers(
    projectId: string, before: ProjectFm | null, after: ProjectFm, diff: PlanRevisionDiff,
  ): Promise<{ triggers: PlanGrowthTrigger[]; warnings: string[] }> {
    const warnings: string[] = []
    for (const m of diff.removed) {
      if (await this.projects.milestoneSettleRec(projectId, m.id)) {
        warnings.push(`里程碑「${m.name}」（${m.id}）已过点对账却被本次修订移除——账本事实不改写，但「终点消失」请知悉。`)
      }
    }
    if (before) {
      const afterById = new Map(after.plan.map(m => [m.id, m]))
      for (const old of before.plan) {
        const now = afterById.get(old.id)
        if (!now || now.name === old.name) continue
        if (await this.projects.milestoneSettleRec(projectId, old.id)) {
          warnings.push(`里程碑「${old.name}」（${old.id}）已过点对账却被本次修订改名为「${now.name}」——产物文件名随计划漂移（orphans 提示可见）。`)
        }
      }
    }
    type Candidate = { milestone: string; name: string; kind: '换线' | '补支'; node: string; course: string | null }
    const candidates: Candidate[] = []
    const items = [...diff.added, ...diff.retargeted.map(r => after.plan.find(m => m.id === r.id)!)]
    for (const item of items) {
      for (const spec of item.nodes ?? []) {
        const { course: specCourse, node } = splitNodeSpec(spec)
        let course: string | null = null
        let exists = false
        if (specCourse !== undefined) {
          const c = await this.registry.get(specCourse)
          if (!c) {
            warnings.push(`里程碑「${item.name}」（${item.id}）引用课程「${specCourse}」不在注册表——该行不入生长触发。`)
            continue
          }
          const { graph } = await this.loadView(c)
          course = c.name
          exists = graph.nset.has(node)
        } else {
          try {
            const hit = await this.locateNode(node)
            course = hit.course.name
            exists = true
          } catch {
            exists = false
          }
        }
        candidates.push({
          milestone: item.id, name: item.name,
          kind: exists ? '换线' : '补支',
          node: spec,
          course, // 显式「课程/」前缀恒路由；裸名未解析的补支走锚定课程集收敛
        })
      }
    }
    // 裸名补支的路由：锚定课程集 = 计划其余条目 nodes 解析到的课程（恰一门才强路由）
    const anchored = new Set<string>()
    for (const m of after.plan) {
      for (const spec of m.nodes ?? []) {
        try {
          anchored.add((await this.locateNode(spec)).course.name)
        } catch { /* 未解析的引用不参与锚定 */ }
      }
    }
    const byCourse = new Map<string, string[]>()
    for (const c of candidates) {
      let target = c.course
      if (!target && !c.node.includes('/') && anchored.size === 1) target = [...anchored][0]
      if (!target) {
        warnings.push(`里程碑「${c.name}」（${c.milestone}）的补支引用「${c.node}」无法确定锚定课程（多门或无锚定）——未入生长触发，请显式写「课程/节点」或人工在生成页拉批。`)
        continue
      }
      const lines = byCourse.get(target) ?? []
      lines.push(c.kind === '换线'
        ? `- 换线：里程碑 ${c.milestone}「${c.name}」关联「${c.node}」已在图上——激活它（内容生成/接入路线），不长重复结构`
        : `- 补支：里程碑 ${c.milestone}「${c.name}」关联「${c.node}」图上尚无——沿足迹朝它长最小必要分支（粗节点+粗 pre，经生长批受理门）`)
      byCourse.set(target, lines)
    }
    const triggers: PlanGrowthTrigger[] = [...byCourse.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([course, lines]) => ({ course, lines }))
    return { triggers, warnings }
  }

  // ---- 内容管线 ----

  /** Vault 先验注入段（V-2 / #106；生成面共用，零命中返回 ''）：检索词 = 节点名 +
   * 直接前置名，纯扫描 vault 个人笔记（排除学习中心；ADR-0010 只读纪律——检索
   * 永不写个人笔记）。宿主无检索/嵌入 API（探测结论见 vault-prior.ts 头注），走
   * #78 推荐的纯扫描降级路径。 */
  private async vaultPriorFor(graph: Graph, node: string): Promise<string> {
    const terms = priorTerms([node, ...(graph.preOf[node] ?? [])])
    if (!terms.length) return ''
    const centerRel = this.paths.centerRoot.slice(this.vaultRoot.length + 1)
    const hits = await searchVaultPrior(this.vaultRoot, centerRel, terms)
    return priorSection(hits)
  }

  async contentPack(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[pack] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'pack')
    const prior = await this.vaultPriorFor(graph, node)
    const pack = this.content.contextPack(graph, state, node, c.name)
    return prior ? `${pack}\n\n---\n\n${prior}` : pack
  }

  async loadPrompt(kind: string): Promise<string> {
    return this.content.loadPrompt(kind)
  }

  /** 可用提示词类型（内置 + 自建变体）。 */
  async promptKinds(): Promise<string[]> {
    return this.content.promptKinds()
  }

  /** 节点内容版本（frontmatter content.version；面板增量刷新依据）。 */
  async contentVersion(courseKey: string | undefined, node: string): Promise<number> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[version] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'version')
    return state[node]?.content.version ?? 0
  }

  /** 节点复杂度档位（difficulty/bloom/pre 闭包折叠；生成管线与面板共用，见 complexity.ts）。 */
  async contentTierOf(courseKey: string | undefined, node: string): Promise<ComplexityTier> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[tier] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'tier')
    return nodeTierOf(graph, node)
  }

  /** 对现有课程笔记跑质检门（agent 手改正文后的校验入口；只读，不落盘不改状态）。 */
  async contentCheck(courseKey: string | undefined, node: string): Promise<{ passed: boolean; findings: string[]; warns: string[] }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[check] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'check')
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
    return this.content.gateReport(graph, c.root, node, body)
  }

  /** 生成落盘门：gate_report → applyGeneration（version+1, draft）。
   * 节点笔记不存在时先建骨架（allo on-demand 语义：大纲即时、正文按需落盘）。
   * learnhub-interactive 标记块先拆出 HTML 落盘为交互件文件，再以引用块进质检门——
   * 门禁检查「interactive 引用文件存在」时文件必须已就位。 */
  async contentApply(courseKey: string | undefined, node: string, body: string): Promise<{ version: number; message: string; hints: string[] }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[apply] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'apply')
    if (!state[node]) await this.ensureNote(c.root, graph, node)
    const split = Content.extractInteractive(body, c.root)
    if (split.invalid.length) {
      throw new Error(`[apply] learnhub-interactive 标记块路径非法（只允许课程根内相对 .html 路径，无 ..）: ${split.invalid.join('、')}`)
    }
    const courseRoot = this.paths.courseRoot(c.root)
    for (const f of split.files) {
      const target = `${courseRoot}/${f.rel}`
      await mkdir(target.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
      await writeFile(target, f.html, 'utf8')
    }
    const fixed = Content.fixRichBlocks((await this.content.fixAliases(c.root, split.body)).body)
    const gate = await this.content.gateReport(graph, c.root, node, fixed)
    const html = Content.checkInteractiveHtml(split.files)
    if (!gate.passed || html.findings.length) {
      throw new Error(`[apply] 质检门未过：\n${[...gate.findings, ...html.findings].map(e => `  ✗ ${e}`).join('\n')}\n${[...gate.warns, ...html.warns].map(w => `  ⚠ ${w}`).join('\n')}`)
    }
    const normalized = this.content.normalizePractice(fixed)
    const version = await this.content.applyGeneration(
      c.root, graph, node, normalized.body,
      n => state[n],
      rec => this.store.appendJournal({ ...rec, course: c.name }),
    )
    await this.content.queueDone(c.root, node)
    const interactiveNote = split.files.length ? `；交互件 ${split.files.length} 个落盘 交互/` : ''
    const hints = Content.encBackfeedHints(graph, node, fixed)
    const hintNote = hints.length ? `；图/enc 反哺提醒 ${hints.length} 条` : ''
    return { version, message: `[apply] ${node} 正文 v${version} 落盘（status=draft，待人审）${interactiveNote}${hintNote}`, hints }
  }

  /** 大纲落盘：节清单 YAML → 校验 → frontmatter content.sections（全 pending），正文不动。
   * 骨架节点先建占位文件（allo on-demand：大纲即时）。 */
  async contentOutline(courseKey: string | undefined, node: string, yamlText: string): Promise<SectionManifest[]> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[outline] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'outline')
    if (!state[node]) await this.ensureNote(c.root, graph, node)
    return this.content.outlineApply(c.root, graph, node, yamlText, rec => this.store.appendJournal({ ...rec, course: c.name }))
  }

  /** 整课重置（「重新生成整课」第一步）：全部节点笔记备份进 .trash 后重写为未生成骨架
   * （content=draft/sections 清空、正文清空）；题库/交互/课程图三个生成产物目录移入同一
   * trash 备份目录（rename，可恢复）。图谱（data/）、注册表、学习进度（state/）、
   * 提示词快照、生成队列.md 均不动；重新生成由调用方按拓扑序串行跑生成管线。 */
  async contentReset(courseKey: string | undefined): Promise<{ course: string; nodes: string[]; trashed: string[]; sediment: string }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (broken.length) {
      throw new Error(`[reset] 课程存在 Broken 笔记，拒绝整课重置（先修复或确认）:\n${broken.map(b => `  ✗ ${b.path} — ${b.reason}`).join('\n')}`)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashBase = `${this.paths.trashDir}/regenerate-${stamp}`
    const nodes: string[] = []
    for (const node of graph.order.length ? graph.order : graph.names) {
      if (!state[node]) continue // 无笔记文件：大纲步骤会建占位，无需重置
      const [, regionName] = graph.blockOf[node]
      const path = this.paths.courseNotePath(c.root, regionName, node)
      const backup = `${trashBase}/${c.root}/课程/${safeFilename(regionName)}/${safeFilename(node)}.md`
      await mkdir(backup.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
      await writeFile(backup, await readFile(path, 'utf8'), 'utf8')
      const { fm } = await loadNote(path)
      await saveNote(path, {
        ...((fm ?? {}) as Record<string, unknown>),
        content: { version: 0, generated_at: null, status: 'draft', sections: [] },
      }, '> 内容待生成。\n')
      nodes.push(node)
    }
    const trashed: string[] = []
    for (const dir of ['题库', '交互', '课程图']) {
      const src = `${this.paths.courseRoot(c.root)}/${dir}`
      if (!existsSync(src)) continue
      await mkdir(trashBase, { recursive: true })
      await rename(src, `${trashBase}/${dir}`)
      trashed.push(dir)
    }
    await this.store.appendJournal({
      course: c.name, node: '*', rating: null, kind: 'content_reset', elapsed_days: 0,
      detail: `整课重置：${nodes.length} 节点笔记回 draft；移入 .trash：${trashed.join('、') || '（无）'}`,
    })
    return {
      course: c.name, nodes, trashed,
      // 重置波及面单独确认项（#139）：模型状态在沉淀层，永不随内容层重置清除
      sediment: '沉淀层不受影响：FSRS 参数/校准画像等模型状态永不自动删除（ADR-0034）',
    }
  }

  /** 单节正文落盘：门禁通过后按清单重组正文，该节置 ready/version+1；hints = enc 候选反哺提醒。 */
  async contentSection(courseKey: string | undefined, node: string, sectionId: string, md: string): Promise<{ version: number; title: string; hints: string[] }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[section] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'section')
    return this.content.sectionApply(c.root, graph, node, sectionId, md, rec => this.store.appendJournal({ ...rec, course: c.name }))
  }

  /** 节清单视图：manifest + 每节现正文 + 解析后的节段难度档 tierLabel（清单 tier 在场用
   * 清单值，缺席按节位置+节点难度推导——不回填清单；面板节进度/单节重写/生成管线的
   * 本节任务注入共用；无清单旧节点回退为整篇重导出，全部 ready）。 */
  async contentSectionsView(courseKey: string | undefined, node: string): Promise<Array<SectionManifest & { md: string | null; tierLabel: string }>> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[sections] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'sections')
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
    const mdByTitle = new Map<string, string>()
    for (const part of body.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      if (title) mdByTitle.set(title, (nl >= 0 ? part.slice(nl + 1) : '').trim())
    }
    const manifest = state[node]?.content.sections ?? Content.manifestFromBody(body, 0)
    return manifest.map((s, i) => ({
      ...s,
      md: mdByTitle.get(s.title) ?? null,
      tierLabel: sectionTierLabel(s.tier, graph.difficultyOf[node], graph.estOf[node], i + 1, manifest.length),
    }))
  }

  async contentFeedback(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[feedback] 未知节点: ${node}`)
    this.assertNoteOk(c, graph, broken, node, 'feedback')
    return this.content.feedback(c.root, graph, node, n => state[n], async (n, fm) => {
      const path = this.paths.courseNotePath(c.root, graph.blockOf[n][1], n)
      await this.updateNoteFm(path, fm)
    })
  }

  async contentReview(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[review] 未知节点: ${node}`)
    this.assertNoteOk(c, graph, broken, node, 'review')
    return this.content.review(c.root, graph, node, n => state[n], async (n, fm) => {
      const path = this.paths.courseNotePath(c.root, graph.blockOf[n][1], n)
      await this.updateNoteFm(path, fm)
    })
  }

  async contentQueue(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    return this.content.queueManual(c.root, node)
  }

  async queueItemsAll(): Promise<QueueItem[]> {
    const out: Array<Record<string, unknown>> = []
    for (const c of await this.enabledCourses()) {
      for (const it of await this.content.queueItems(c.root)) {
        out.push({ ...it, course: c.name })
      }
    }
    return out
  }

  async lesson(courseKey: string | undefined, node: string): Promise<LessonDoc> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[lesson] 课程「${c.name}」中没有节点「${node}」。`)
    this.assertNoteOk(c, graph, broken, node, 'lesson')
    const { today } = await this.learningDay()
    const lesson = await this.sessions.lesson(c.name, c.root, graph, state, node, today)
    const view = lesson as Record<string, unknown>
    // mastery 由 sessions.lesson 按口径 B 派生（masteryOfFm），此处不再覆盖。
    // 节清单（逐节生成）：manifest 原样下发（前端按节 id 绑题、按 type 装配轮次），
    // 并给同名 sections 补 id/type；旧节点无清单，前端回退标题匹配。
    const manifest = state[node]?.content.sections ?? null
    view.manifest = manifest
    if (manifest?.length) {
      const byTitle = new Map(manifest.map(s => [s.title, s]))
      for (const s of (view.sections ?? []) as Array<{ title: string; id?: string; type?: string }>) {
        const hit = byTitle.get(s.title)
        if (hit) { s.id = hit.id; s.type = hit.type }
      }
    }
    return lesson
  }

  // ---- note resolve / 反馈区读取 ----

  /** 解析笔记 → { path, node, course }，任一环节缺失即抛错。 */
  async resolveNote(vaultRoot: string, input: string, centerRel: string): Promise<{ path: string; node: string; course: string }> {
    const p = input.replace(/\\/g, '/')
    const rel = p.startsWith(`${vaultRoot}/`) ? p.slice(vaultRoot.length + 1) : p.replace(/^\/+/, '')
    const abs = `${vaultRoot}/${rel}`
    const raw = await readFile(abs, 'utf8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const node = m ? (m[1].match(/^node:\s*(.+)$/m)?.[1] ?? '').trim() : ''
    if (!node) throw new Error(`${rel} 的 frontmatter 缺少 node 字段，不是课程文件。`)
    if (!rel.startsWith(`${centerRel}/`)) throw new Error(`${rel} 不在学习中心内。`)
    const seg = rel.slice(centerRel.length + 1).split('/')[0]
    const reg = await this.registry.load()
    const hit = reg.find(c => c.root === seg && c.enabled !== false)
    if (!hit) throw new Error('无法从注册表定位当前笔记对应的课程。')
    return { path: rel, node, course: hit.name }
  }

  /** 提取笔记「内容反馈」区正文；仅占位符或为空返回 null。 */
  async feedbackBody(absPath: string): Promise<string | null> {
    const raw = await readFile(absPath, 'utf8')
    const sec = raw.match(/## 内容反馈\n([\s\S]*?)(?=\n## |<!-- enc_candidates|$)/)
    const body = (sec?.[1] ?? '').replace(/在此写下你对本课内容的问题与建议.*$/m, '').trim()
    return body || null
  }

  /** 提交内容反馈（feedback 工具/路由共用）。 */
  async submitFeedback(vaultRoot: string, centerRel: string, input: string): Promise<string> {
    const { path, node, course } = await this.resolveNote(vaultRoot, input, centerRel)
    const body = await this.feedbackBody(`${vaultRoot}/${path}`)
    if (!body) throw new Error('请先在笔记「内容反馈」区写下你的问题与建议，再提交。')
    return this.contentFeedback(course, node)
  }

  // ---- P4：课程工作区（树形）与题库 ----

  /** 课程工作区树：course → region → block → node（stage/mastery/笔记/题库状态）。 */
  async coursesTree(courseKey?: string): Promise<TreeDoc> {
    const targets = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const courses = []
    for (const c of targets) {
      const { graph, state } = await this.loadView(c)
      const regions = graph.regions.map(r => ({
        name: r.name, color: r.color,
        blocks: r.blocks.map(b => ({
          name: b.name,
          nodes: b.nodes.map(n => ({
            node: n.name, opt: n.opt,
            stage: effectiveStage(state, n.name),
            mastery: masteryOfFm(state[n.name]),
            contentVersion: state[n.name]?.content.version ?? 0,
            contentStatus: state[n.name]?.content.status ?? 'draft',
            path: this.sessions.notePath(c.root, graph, n.name),
            hasBank: existsSync(this.bank.bankPath(this.paths.courseRoot(c.root), n.name)),
          })),
        })),
      }))
      courses.push({ name: c.name, id: c.id, regions })
    }
    return { courses }
  }

  /** 题目 → 作答视图（questions 与 reviewQueue 共用；matching 右列打乱防泄题）。
   * opts.today（questions 通道专属）= 当前学习日：本学习日已推进的题带出答案/解析
   * ——直通卡披露与作答响应同一披露边界（都发生在「当日额度已用掉」之后）；
   * 复习队列是主动回忆面，不传 today，永不带答案。 */
  private questionView(q: BankQuestion, i: number, opts?: { today?: string }): Record<string, unknown> {
    const advancedToday = opts?.today !== undefined && alreadyAdvanced(q, opts.today)
    return {
      id: q.id, kind: q.kind, q: q.q, no: i + 1,
      difficulty: q.difficulty ?? 1,
      section: q.section ?? null,
      ...(q.options?.length ? { options: q.options } : {}),
      ...(q.kind === 'matching' && Array.isArray(q.answer)
        ? { pairOptions: shuffled([...new Set(q.answer as string[])]) } : {}),
      hasExplanation: Boolean(q.explanation),
      due: q.fsrs?.reps ? q.fsrs.due : null,
      attempts: q.stats?.attempts ?? 0,
      // 最近一次作答对错（stats.last_correct；旧数据无此字段 = null）
      lastCorrect: q.stats?.last_correct ?? null,
      ...(advancedToday
        ? { advancedToday: true, answer: revealAnswer(q), explanation: q.explanation ?? '' }
        : {}),
    }
  }

  /** 某节点题库题目列表（不含答案/评分要点；带到期日与作答统计——刷卡视图）。
   * mastery 与学习页/图/树同口径（masteryOfFm 派生），前端头部读数即此。
   * 笔记源卡（course=「笔记源」伪课程）同通道只读列出：漂移提示的「归档旧题」
   * 管理动作需要逐题清单（questionGet/questionArchive 同一伪课程路由约定）；
   * ADR-0010 v1 不套掌握度模型，响应不带 mastery。 */
  async questions(courseKey: string | undefined, node: string): Promise<QuestionsDoc> {
    const { today } = await this.learningDay()
    if (await this.isNoteSourceCourse(courseKey)) {
      const bank = await this.bank.load(this.paths.noteSourceDir, node)
      return {
        course: NOTE_SOURCE_COURSE, node,
        questions: bank.questions.filter(q => q.archived !== true)
          .map((q, i) => this.questionView(q, i, { today })),
      }
    }
    const c = await this.registry.resolve(courseKey)
    const { state } = await this.loadView(c)
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    return {
      course: c.name, node,
      mastery: masteryOfFm(state[node]),
      questions: bank.questions.filter(q => q.archived !== true)
        .map((q, i) => this.questionView(q, i, { today })),
    }
  }

  /** 复习刷卡队列（Anki 式）：全部启用课程中「到期未刷」的未归档题，扁平按
   * 「预测遗忘风险 R 升序」为主排序（R 最低 = 最可能忘，先刷；#56 A1），同 R 档
   * 内难度由易到难渐进，再按 due/节点/题序稳定排序；不含从未调度的新题
   * （due=null，入口在学习流）。R 在各课程自己的调度器参数下现算并随卡带出
   * （r 字段，供面板显示预测回忆率）。Broken 笔记 fail loud——与
   * status/recommend 同一门前置。
   * node 过滤（#54 A3 R 半）= 定向复习直达入口：软闸/enc 回退建议项携带的目标
   * 节点，用它拉出「该节点到期题」子队列（作答复用 questionAnswer/自评流）。
   * 单节点会话改走 A1 作答期难度微调（#57）：不走全局 R 排序，按节点 Mastery
   * 先验带（band 字段随响应带出）摆开场顺序，卡片带合用难度标量 d——会话方
   * 按即时表现以 adaptive.pickNext/nextBand 流式选下一题（连续对升档、错/忘降档）。
   * bandPref（#65 E5）：显式难度带选择作为 A1 的带权偏好——挑战抬高当次目标带、
   * 简单放宽、标准/不选与 #57 默认完全一致；偏移作用于起点先验带（防挫回落点），
   * 连对升档/错忘降档语义不变。只对单节点会话生效（A1 边界）。
   * JOL 抽查（#66 E4）：按抽样率（默认约 1/3，可全局关闭）标记本批应弹预测的卡
   * （jol 字段）——选卡优先到期边界/难度中段/曾有预测偏差，UI 据此只在选中卡上
   * 问一档三点；预测本身随作答/忘记经 questionAnswer/questionForget 落流水。
   * 节点不在范围内任何课程的图内时 fail loud——拼错的直达入口不该静默空队列。
   * 我的卡（E1，ADR-0021）：汇入本队列（source='learner'，卡面数据在 learner 字段），
   * 同一 R 风险排序与单节点定向入口；测量面不扩——JOL 抽查、复习日志、Anki 导出
   * 均不含我卡，复习入账走无绑定 XP（learnerCardRate/Forget）。
   * 错误对比卡（C-3 #82，ADR-0032）：同款汇入（source='error'，卡面在 error 字段，
   * 自动判分走 errorCardAnswer）；JOL 抽查与复习日志同样零掺入，复习入账走无绑定
   * XP（xp_error 行）。 */
  async reviewQueue(
    courseKey?: string, node?: string, today?: string, bandPref?: BandPref,
  ): Promise<ReviewQueueDoc> {
    today ??= (await this.learningDay()).today
    // N-of-1 实验当日生效臂（#110 ADR-0023，批次交替）：band_default 在未显式选带时
    // 决定默认带；session_composition 决定全局队列呈现顺序。显式学习者选择优先。
    const expEffect = await this.nof1QueueEffect(today)
    // A1 目标难度带默认值（#111 恒温器旋钮；配置层缺省 = 纯 A1）。
    const defaultBand = await this.bandDefault()
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const cards: Array<Record<string, unknown>> = []
    let nodeFound = false
    let mastery = 0
    for (const c of courses) {
      const { graph, state, broken } = await this.loadView(c)
      assertNoBrokenNotes('review-queue', broken)
      if (node !== undefined) {
        if (!graph.nset.has(node)) continue // 该课程没有此节点：跨课程口径下属正常，最后统一判空
        // 跨课程重名节点取首个命中课程的 Mastery 作先验（定向入口正常都携带 course）
        if (!nodeFound) mastery = masteryOfFm(state[node])
        nodeFound = true
      }
      const courseRoot = this.paths.courseRoot(c.root)
      const sched = await this.sched(courseRoot)
      // 我的卡（E1，ADR-0021 汇入）：同队列同会话；FSRS 走默认参数（与笔记源同一
      // sched(null) 通道，参数优化器不训它）。R/d 按卡自身调度块现算；未调度新卡
      // （首推入口，别无来处）due 为空、R 满档 1.0 落队尾。只进队列与无绑定 XP——
      // 节点证据/门禁/复习日志零掺入（ADR-0021 裁决 2）。Broken 卡组不阻塞队列。
      const learnerSched = await this.sched(null)
      let learnerFiles: string[] = []
      try {
        learnerFiles = await readdir(this.paths.learnerCardsDir(c.root))
      } catch {
        learnerFiles = [] // 该课程还没有任何我的卡：合法空态
      }
      for (const f of learnerFiles.filter(f => f.endsWith('.yaml')).sort()) {
        const lNode = f.replace(/\.yaml$/, '')
        if (node !== undefined && lNode !== node) continue
        let doc: LearnerCardDoc
        try {
          doc = await this.learnerCards.load(c.root, lNode)
        } catch {
          continue
        }
        for (const card of doc.cards) {
          if (card.archived) continue
          const due = card.fsrs?.reps ? card.fsrs.due : null
          if (due && String(due) > today) continue
          const r = retrievabilityBlock(learnerSched, card.fsrs ?? null, today)
          const diff = card.fsrs?.difficulty && card.fsrs.difficulty > 0 ? card.fsrs.difficulty : FSRS_DIFFICULTY_MID
          cards.push({
            course: c.name, node: lNode, source: 'learner',
            id: card.id, due,
            r: Math.round(r * 1000) / 1000, d: diff, difficulty: diff,
            attempts: card.stats?.attempts ?? 0,
            learner: { course: c.name, node: lNode, id: card.id, kind: card.kind,
              prompt: card.prompt, content: card.content,
              source_section: card.source_section ?? null, due,
              attempts: card.stats?.attempts ?? 0 },
          })
        }
      }
      // 错误对比卡（C-3 #82）：并入本队列（source='error'，id 加 err: 前缀防与
      // 我的卡/题号撞键）。同我的卡 ADR-0021 同款隔离调度（sched(null)，优化器不训），
      // 只进队列与无绑定 XP——节点证据/门禁/复习日志零掺入；自动判分（三选一答案
      // 唯一，选对=3/选错=1，走 errorCardAnswer）。Broken 卡组不阻塞队列。
      const errorSched = await this.sched(null)
      for await (const { course: eCourse, node: eNode, card } of this.errorCardTriples([c], node)) {
        const due = card.fsrs?.reps ? card.fsrs.due : null
        if (due && String(due) > today) continue
        const r = retrievabilityBlock(errorSched, card.fsrs ?? null, today)
        const diff = card.fsrs?.difficulty && card.fsrs.difficulty > 0 ? card.fsrs.difficulty : FSRS_DIFFICULTY_MID
        cards.push({
          course: eCourse, node: eNode, source: 'error',
          id: `err:${card.id}`, due,
          r: Math.round(r * 1000) / 1000, d: diff, difficulty: diff,
          attempts: card.stats?.attempts ?? 0,
          // 队列卡面只带题面与选项——answer/mine/explanation 是作答后揭晓面，
          // 经 errorCardAnswer 随判分返回（同 questionView 不带答案的泄露纪律）。
          error: { course: eCourse, node: eNode, id: card.id, q: card.q, options: card.options,
            source_q: card.source_q, source_section: card.source_section ?? null, due,
            attempts: card.stats?.attempts ?? 0 },
        })
      }
      let files: string[] = []
      try {
        files = await readdir(this.paths.bankDir(c.root))
      } catch {
        continue
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const qNode = f.replace(/\.yaml$/, '')
        if (node !== undefined && qNode !== node) continue
        const bank = await this.bank.load(courseRoot, qNode)
        bank.questions.forEach((q, i) => {
          if (q.archived) return
          const card = this.questionView(q, i)
          if (!card.due || String(card.due) > today) return
          const r = retrievabilityBlock(sched, q.fsrs, today)
          // 合用难度标量 d（#57）：静态题面难度 + FSRS difficulty，会话内选档消费
          cards.push({ course: c.name, node: qNode, r: Math.round(r * 1000) / 1000,
            d: Math.round(combinedDifficulty(q.difficulty, q.fsrs) * 1000) / 1000, ...card })
        })
      }
    }
    if (node !== undefined && !nodeFound) {
      const scope = courseKey ? `课程「${courses[0]!.name}」` : '任何启用课程'
      throw new Error(`[review-queue] 节点「${node}」不在${scope}的图内。`)
    }
    // JOL 抽查标记（#66 E4）：全局开关关闭或空队列时静默；否则按抽样率选卡、
    // 随卡带 jol 标记（UI 只在选中卡的翻面前弹一档三点，可忽略）。偏差重探按
    // 「课程/节点/题id」复合键对齐（qid 只在节点题库内唯一）。我的卡不参与
    // （ADR-0021：测量面不扩；自评卡无作答判分可配对）。
    // Self-Calibration 显式提示（ADR-0022 #104）：源内「会」档系统性过信且提示开
    // → JOL 抽查密度加强（1/3→1/2）+ 队列载荷带轻提示（UI 在预测出口非阻断展示，
    // 可全局关 calibration.hints）。呈现层参数——canonical 零改动（红线）。
    const jol = await this.jolConfig()
    // 我的卡/错误对比卡不参与（测量面不扩：自评卡无作答判分可配对；对比卡的
    // 判分已随推进落自身 stats，不再叠 JOL 抽查）。
    const jolEligible = cards.filter(c => c.source !== 'learner' && c.source !== 'error')
    let calibrationHint: string | null = null
    if (jol.enabled && jolEligible.length) {
      const practice = await this.store.practiceAll()
      const verdict = overconfidenceOf(practice)
      const hints = await this.calibrationHintsConfig()
      const hintOn = hints.hints_enabled && verdict.overconfident
      if (hintOn) calibrationHint = calibrationHintText(verdict)
      const deviated = jolDeviatedKeys(practice)
      const candidates = jolEligible.map(c => ({
        key: `${c.course}/${c.node}/${String(c.id)}`,
        r: c.r as number,
        difficulty: c.difficulty as number | undefined,
      }))
      const marks = pickJolTargets(candidates, this.jolRng, {
        rate: hintOn ? Math.max(jol.rate, CALIBRATION_BOOST_SAMPLE_RATE) : jol.rate,
        deviated,
      })
      jolEligible.forEach((c, i) => {
        if (marks.has(candidates[i]!.key)) c.jol = true
      })
    }
    // 单节点「已调度题」会话（#57 A1 + #65 E5 带权偏好）：起点先验 = 节点 Mastery
    // → 目标难度带，再叠加显式带偏移（挑战抬高/简单放宽）；初始顺序按距先验带
    // 距离升序（会话内流式调整由会话方以纯规则驱动）。
    if (node !== undefined) {
      const band = Math.min(1, Math.max(0,
        startBand(mastery) + bandOffset(bandPref
          ?? (expEffect?.variable === 'band_default' ? expEffect.arm as BandPref : undefined)
          ?? defaultBand)))
      return { date: today, total: cards.length, band: Math.round(band * 1000) / 1000,
        cards: sessionOrder(cards as Array<Record<string, unknown> & { d: number }>, band),
        ...(calibrationHint ? { calibration_hint: calibrationHint } : {}) }
    }
    // 笔记源卡池（C1 #59）：并入全局队列（带 source:'note' 标记，course=「笔记源」
    // 伪课程）。不参与 JOL 抽查（E4 预测落点按课程卡设计，笔记源 v1 不抽查）；
    // Missing/镜像 Broken 的源卡池挂起并随响应带出，不阻塞其他源；漂移不挂起
    // （旧卡继续复习，随响应提示可重出/归档）。
    const noteSources = await this.collectNoteSourceCards(today)
    cards.push(...noteSources.cards)
    // 组合排序：主键 = R 分档升序，档宽 5 个百分点——到期卡 R 集中在 (0, 0.9]，
    // 档太窄则难度几乎永远排不上号，太宽则风险明显不同的卡被难度插队；档内
    // 难度由易到难（同风险下先易后难热身），再 due/节点/题序兜底保证稳定。
    const band = (r: number) => Math.floor(r / 0.05)
    cards.sort((a, b) =>
      band(a.r as number) - band(b.r as number)
      || (a.difficulty as number) - (b.difficulty as number)
      || String(a.due).localeCompare(String(b.due))
      || String(a.node).localeCompare(String(b.node))
      || String(a.id).localeCompare(String(b.id)))
    // 会组成实验「混排」臂（#110 ADR-0023）：把我的卡/笔记源卡均匀摊进题卡序列；
    // 「分面」臂 = 现行排序原样。只改呈现顺序，不改到期与调度。
    const ordered = expEffect?.variable === 'session_composition' && expEffect.arm === 'mixed'
      ? interleaveBySource(cards)
      : cards
    return { date: today, total: cards.length, cards: ordered,
      ...(expEffect ? { exp: { id: expEffect.id, arm: expEffect.arm } } : {}),
      ...(calibrationHint ? { calibration_hint: calibrationHint } : {}),
      ...(noteSources.drifted.length ? { note_drifted: noteSources.drifted } : {}),
      ...(noteSources.suspended.length ? { note_suspended: noteSources.suspended } : {}) }
  }

  /** 题库写入（LLM 产出过 schema 门禁后落盘）。 */
  async questionSave(courseKey: string | undefined, node: string, yamlText: string): Promise<{ node: string; count: number; path: string }> {
    const c = await this.registry.resolve(courseKey)
    return this.bank.save(this.paths.courseRoot(c.root), yamlText, node)
  }

  /** allo 作答流：答题 → 自动判卷（reflection 走 AI）→ practice 流水 + 计数/EMA。
   * 调度不在此触碰（D15：评分仍经工作单 settle / grade 通道）。
   * elapsedS = 前端计时（题目渲染到提交的秒数）：记入流水并用于乱猜判定。
   * opts.deferSchedule = 复习刷卡流的答对路径：调度挂起（不推卡），背面自评
   * Hard/Good/Easy 后经 questionRate 结算；答错/乱猜/当日已推进不受其影响。
   * opts.predicted = 翻面前的一档 JOL 预测（#66 E4，Learner Output 元标注）：
   * 只随作答落流水供校准配对，非法值显式拒绝、null/缺省不落字段。 */
  async questionAnswer(
    llmComplete: LlmComplete,
    courseKey: string | undefined, node: string, qid: string, answer: string,
    elapsedS?: number | null,
    opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null },
  ): Promise<AnswerResult> {
    // 笔记源卡路由（C1 #59）：course=「笔记源」伪课程（与真实课程重名时课程优先），
    // node = 源 id——同复习自评语义，但无节点证据/practice 流水（XP 走无绑定行，ADR-0021）。
    if (await this.isNoteSourceCourse(courseKey)) {
      return this.noteSourceAnswer(llmComplete, node, qid, answer, { ...opts, elapsed_s: elapsedS ?? null })
    }
    const predicted = this.jolPredicted(opts?.predicted)
    const { c, graph, q, idx } = await this.questionContext(courseKey, node, qid, 'question')
    const { score, feedback } = await this.judgeBankAnswer(llmComplete, q, answer, 'question',
      { course: c.name, node, qid })
    const correct = score >= PASS_SCORE
    // XP 时间账本：同日重复作答不记账（防刷）；乱猜（耗时过短且答错）负 XP。
    // 乱猜作答同时不推进 FSRS——难度证据（k 校准）只由认真作答驱动，防乱猜推高节点定价。
    const { today } = await this.learningDay()
    const guessed = !correct && elapsedS !== null && elapsedS < XP_GUESS_SECONDS
    // 同日重复判定（ADR-0014 真实推进口径）：挂起作答（deferSchedule 只记账不推卡）
    // 之后的当日再作答也算重复——旧口径会绕过重复判定再推卡并静默丢弃 pending 标记。
    const repeated = guessed || alreadyAdvanced(q, today)
    const settle = xpForAnswer(q.kind, q.difficulty ?? 1, correct, elapsedS ?? null, !repeated)
    await this.store.appendPractice({
      course: c.name, node, ex: idx + 1, answer,
      correct, judge: q.kind, qid,
      feedback: feedback || undefined,
      elapsed_s: elapsedS ?? undefined,
      xp: settle.xp,
      ...(predicted ? { predicted } : {}),
    })
    // frontmatter 计数 + 练习证据 EMA（口径 B 的练习项；mastery 本身纯派生不落盘）。
    // probation 在途行使闸（#146）：实验中的插入节点只记流不回流——流水已落上面，
    // EMA/计数在此跳过（proven 后恢复；普通前进/旁支节点不受闸）。
    const evidenceGated = await this.exerciseGated(c, node)
    const note = await this.nodeNote(c, graph, node)
    let next: Fm | null = null
    if (note.fm) {
      next = evidenceGated ? note.fm : applyPracticeEvidence(note.fm, correct ? 1.0 : 0.0)
      // 刷卡模型：首答把节点从 ready/unseen 推进 learning（后续调度由题目聚合驱动）
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await this.saveNodeNote(note.path, next, note.body)
      if (next.stage !== note.fm.stage) {
        const { state: stateNow } = await this.loadView(c)
        await this.content.onStageChange(c.root, graph, stateNow, node, next.stage)
      }
    }
    // 题目级 FSRS：作答对错映射 rating（对=3、错=1）推进该题调度并写回题库。
    // 每题每天至多推进一次（ADR-0014 advance 守门）；复习刷卡流（deferSchedule）
    // 答对时调度挂起：背面自评档位经 questionRate 落盘（stats.pending_rating 标记）。
    let fs: FsrsBlock | null
    let pendingRating = false
    let advanced = false
    // 复习日志（#60 ADR-0012）：只有真实推进才落一条；记录复习前 R/S/D 快照
    let reviewRec: Omit<ReviewRec, 'ts'> | null = null
    let previews: { hard: string; good: string; easy: string } | undefined
    if (repeated) {
      fs = q.fsrs ?? null
    } else if (opts?.deferSchedule === true && correct) {
      const sched = await this.sched(this.paths.courseRoot(c.root))
      pendingRating = true
      previews = {
        hard: previewDue(sched, q.fsrs ?? null, 2, today),
        good: previewDue(sched, q.fsrs ?? null, 3, today),
        easy: previewDue(sched, q.fsrs ?? null, 4, today),
      }
      fs = q.fsrs ?? null
    } else {
      const sched = await this.sched(this.paths.courseRoot(c.root))
      const r = advanceStrict(sched, q, correct ? 3 : 1, today,
        `[question] ${node}/${qid} 今天已推进过（应为不可达分支：同日重复已分流）。`)
      fs = r.fs
      advanced = true
      reviewRec = { rating: correct ? 3 : 1, rating_source: 'auto', ...r.log }
    }
    const stats = {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: (q.stats?.correct ?? 0) + (correct ? 1 : 0),
      last: today,
      last_correct: correct,
      // 同日重复作答不丢今日已挂起的自评（ADR-0014：pending 态保持完整，rate 仍可达）
      ...(pendingRating || (q.stats?.pending_rating && q.stats?.last === today) ? { pending_rating: true } : {}),
    }
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { fsrs: fs, stats })
    if (reviewRec) {
      // N-of-1 臂标注（#110 ADR-0023）：真实推进发生时的实验归因，只添字段不改推进
      const exp = await this.expTag(c.name, node, qid, today)
      await this.store.appendReview({ course: c.name, node, qid, ...reviewRec, ...(exp ? { exp } : {}) })
    }
    // 代表卡回刷（ADR-0007 前提）：只有真实推进才重算——挂起/同日重复没动卡，代表卡不变。
    // mastery 从回刷后的 frontmatter 派生，稳定度分量才随复习前进。
    const fmNow = advanced ? await this.refreshRepCard(c, graph, node) : next
    const mastery = masteryOfFm(fmNow)
    return {
      correct, score: Math.round(score * 100), feedback,
      explanation: q.explanation ?? '',
      // 错题公布答案（allo answer_review 语义；reflection 的 rubric 与开放题的参考要点也回显供对照）
      answer: revealAnswer(q),
      kind: q.kind,
      due: fs?.due ?? null,
      mastery,
      // 本次作答是否推进了该题 FSRS 调度（每题每天至多一次；自评挂起视为未推进）
      scheduled: advanced,
      pendingRating,
      ...(previews ? { previews } : {}),
      // 判错差异摘要（勘误申诉前置）：规则题点名「漏选/多选/第几项」——判错反馈
      // 必须让学习者能对上自己的作答，否则只能从解析反推键（ADR-0031 的误诊根源）
      ...(correct ? {} : { diff: answerDiff(q, answer) ?? undefined }),
      // XP 时间账本：本次作答的结算结果
      xp: settle.xp,
      xp_reason: settle.reason,
      // probation 在途行使闸（#146）：只记流不回流的实验节点标记（面板可提示）
      ...(evidenceGated ? { evidence_gated: true as const } : {}),
    }
  }

  /** 题库题判卷（题库作答与笔记源作答共用）：reflection/open_question 走 AI 判卷
   * 通道（显式禁止规则判卷降级），其余 evaluateAllo 规则判卷。AI 输出不可解析时
   * 自动重问一次（纠偏提示「只输出 JSON」；max-tokens 截断的提额重试在 host 侧
   * llmComplete 内），仍失败则抛错——本次作答在边界失败，不写任何分数/卡/证据
   * （#9 / ADR-0004 事务性）。每次解析失败把原始模型输出截断留痕到
   * state/判卷失败.jsonl（#116），ref 提供课程/节点/题目定位。 */
  private async judgeBankAnswer(
    llmComplete: LlmComplete,
    q: BankQuestion, answer: string, op = 'question',
    ref: { course: string; node: string; qid: string },
  ): Promise<{ score: number; feedback: string }> {
    if (q.kind === 'reflection' || q.kind === 'open_question') {
      const isOpen = q.kind === 'open_question'
      const system = isOpen ? OPEN_QUESTION_GRADING_SYSTEM : REFLECTION_GRADING_SYSTEM
      const prompt = isOpen
        ? `Lesson question (综合应用):\n${q.q}\n\nLearner's answer:\n${answer}`
          + (String(q.answer).trim() ? `\n\nReference points (参考要点):\n${String(q.answer)}` : '')
        : `Exercise prompt:\n${q.q}\n\nLearner's answer:\n${answer}\n\nGrading rubric (评分要点):\n${String(q.answer)}`
      let lastError = ''
      for (let attempt = 1; attempt <= 2; attempt++) {
        const ask = attempt === 1
          ? prompt
          : `${prompt}\n\n[重判要求] 上一次输出无法解析为判卷结果。这一次只输出一个 JSON 对象（shape 见系统提示），不要任何其他文字、解释或代码围栏。`
        const raw = await llmComplete(ask, system)
        try {
          const v = isOpen ? parseOpenGrading(raw) : parseReflectionGrading(raw)
          return { score: isOpen ? v.score / 10 : v.score, feedback: v.feedback }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          await this.logGradingFailure({ ...ref, kind: q.kind, attempt, error: lastError, raw })
        }
      }
      throw new Error(`[${op}] AI 判卷输出不可用，本次作答未记录（请重试，或核对题目/模型输出）：${lastError}`)
    }
    const r = evaluateAllo(q, answer)
    return { score: r.score, feedback: r.feedback }
  }

  /** 判卷失败留痕（#116）：原始模型输出截断到 2000 字符附题目定位落 JSONL；
   * 留痕失败静默——debug 通道不能反过来弄垮作答主流程。 */
  private async logGradingFailure(rec: {
    course: string; node: string; qid: string; kind: string; attempt: number; error: string; raw: string
  }): Promise<void> {
    try {
      await mkdir(this.paths.centerStateDir, { recursive: true })
      const line = JSON.stringify({ ts: new Date().toISOString(), ...rec, raw: rec.raw.slice(0, 2000) })
      await appendFile(this.paths.gradingFailurePath, `${line}\n`, 'utf8')
    } catch {
      // 留痕失败不影响主流程
    }
  }

  /** 作答 / 忘记 / 自评共用的前置：课程解析、笔记体检、题库定位。 */
  private async questionContext(courseKey: string | undefined, node: string, qid: string, op: string) {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[${op}] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, op)
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    const idx = bank.questions.findIndex(q => q.id === qid)
    if (idx < 0) throw new Error(`[${op}] ${node} 的题库没有 ${qid}。`)
    return { c, graph, q: bank.questions[idx], idx }
  }

  /** 节点笔记读写便道（ADR-0014 附带）：blockOf → courseNotePath → loadNote → asFm
   * 四步舞收口；写回经 saveNodeNote（saveNote 的双强转收在门面一处）。 */
  private async nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }> {
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    return { path, fm: asFm(rawFm), body }
  }

  private async saveNodeNote(path: string, fm: Fm, body: string): Promise<void> {
    await saveNote(path, fm as unknown as Record<string, unknown>, body)
  }

  /** 复习刷卡流：答对后的自评结算（Hard/Good/Easy → FSRS 2/3/4）。
   * 前置 = 该题今天已由 deferSchedule 作答记账且调度仍挂起（stats.pending_rating）。
   * 只推卡：不记流水、不动 stats 计数、不给 XP（XP 在作答时已结算）；
   * 推完回刷节点聚合代表卡（refreshRepCard）。 */
  async questionRate(
    courseKey: string | undefined, node: string, qid: string, rating: number,
  ): Promise<QuestionRateResult> {
    const r = Math.round(rating)
    if (r < 2 || r > 4) throw new Error(`[question-rate] 自评档位只能是 2/3/4（收到 ${String(rating)}）。`)
    // 笔记源卡路由（C1 #59）：自评结算进镜像题库，无代表卡回刷（笔记源无节点）。
    if (await this.isNoteSourceCourse(courseKey)) return this.noteSourceRate(node, qid, r)
    const { c, graph, q } = await this.questionContext(courseKey, node, qid, 'question-rate')
    const { today } = await this.learningDay()
    if (q.stats?.last !== today || !q.stats?.pending_rating) {
      // 挂起标记是唯一准入：练习流作答与「完成学习」当日初始化（last_review=今天）都不产生挂起
      throw new Error(`[question-rate] ${node}/${qid} 今天没有待结算的自评（未作答或非挂起路径）。`)
    }
    // 挂起结算 = 当日预留推进的执行（ADR-0014 advancePending）：准入是上面的
    // pending 旗标，不走 guard——可达态里 deferred 作答不碰 fsrs，双门必不命中。
    const sched = await this.sched(this.paths.courseRoot(c.root))
    const pushed = advancePending(sched, q, r as 1 | 2 | 3 | 4, today)
    const { pending_rating: _drop, ...statsRest } = q.stats
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { fsrs: pushed.fs, stats: { ...statsRest } })
    const rateExp = await this.expTag(c.name, node, qid, today)
    await this.store.appendReview({
      course: c.name, node, qid,
      rating: r as ReviewRec['rating'], rating_source: 'self', ...pushed.log,
      ...(rateExp ? { exp: rateExp } : {}),
    })
    // 自评落盘后回刷代表卡；mastery 与全端同口径（口径 B 派生），自评本身不额外改证据
    const fmNow = await this.refreshRepCard(c, graph, node)
    return {
      course: c.name, node, qid, rating: r,
      due: pushed.fs.due,
      mastery: masteryOfFm(fmNow),
      scheduled: true,
    }
  }

  /** 复习刷卡流：「忘记」申报——不作答直接翻面，调度与统计均按答错记，0 XP。
   * 5 秒主动回忆门控是前端交互；引擎只负责如实记账。当日已作答（含挂起自评）
   * 的题拒绝重复申报；「完成学习」当日初始化的卡允许覆推 Again（与练习流同日首答一致）。
   * predicted = 翻面前的 JOL 预测（#66 E4）：忘记也是翻面，预测同样落流水配对。 */
  async questionForget(
    courseKey: string | undefined, node: string, qid: string,
    elapsedS?: number | null, predicted?: JolPrediction | null,
  ): Promise<QuestionForgetResult> {
    // 笔记源卡路由（C1 #59）：忘记申报进镜像题库，无节点证据（笔记源无 frontmatter）。
    if (await this.isNoteSourceCourse(courseKey)) return this.noteSourceForget(node, qid)
    const { c, graph, q, idx } = await this.questionContext(courseKey, node, qid, 'question-forget')
    const pred = this.jolPredicted(predicted)
    const { today } = await this.learningDay()
    // 推进与守门一体（ADR-0014 advanceStrict）：同日已真实推进（stats.last）即拒绝，
    // 合成初始化（只写 fsrs 不占当日额度）后的覆推 Again 照旧允许。
    const sched = await this.sched(this.paths.courseRoot(c.root))
    const pushed = advanceStrict(sched, q, 1, today,
      `[question-forget] ${node}/${qid} 今天已有作答记录，忘记只用于本日首次刷卡。`)
    const fs = pushed.fs
    await this.store.appendPractice({
      course: c.name, node, ex: idx + 1, answer: '',
      correct: false, judge: 'forget', qid,
      elapsed_s: elapsedS ?? undefined,
      xp: 0,
      ...(pred ? { predicted: pred } : {}),
    })
    // 节点侧证据：忘记 = 0 分（EMA 衰减 + 计一次未过），stage 推进与作答路径一致。
    // probation 在途行使闸（#146）：实验中的插入节点只记流不回流。
    const evidenceGated = await this.exerciseGated(c, node)
    const note = await this.nodeNote(c, graph, node)
    let next: Fm | null = null
    if (note.fm) {
      next = evidenceGated ? note.fm : applyPracticeEvidence(note.fm, 0.0)
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await this.saveNodeNote(note.path, next, note.body)
      if (next.stage !== note.fm.stage) {
        const { state: stateNow } = await this.loadView(c)
        await this.content.onStageChange(c.root, graph, stateNow, node, next.stage)
      }
    }
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { fsrs: pushed.fs, stats: pushed.stats })
    const forgetExp = await this.expTag(c.name, node, qid, today)
    await this.store.appendReview({
      course: c.name, node, qid,
      rating: 1, rating_source: 'auto', ...pushed.log,
      ...(forgetExp ? { exp: forgetExp } : {}),
    })
    // 忘记把被忘卡的 due 拉到最近 → 代表卡拉回（最早 due 换成它）→ mastery 回落
    const fmNow = await this.refreshRepCard(c, graph, node)
    return {
      correct: false,
      judge: 'forget',
      feedback: q.explanation ?? '',
      answer: revealAnswer(q),
      explanation: q.explanation ?? '',
      kind: q.kind,
      due: fs.due,
      mastery: masteryOfFm(fmNow),
      scheduled: true,
      xp: 0,
      ...(evidenceGated ? { evidence_gated: true as const } : {}),
    }
  }

  /** 复习推进后回刷节点聚合代表卡：fm.fsrs = 全部未归档题里 due 最早那张的快照。
   * 口径 B 的稳定度分量（权重 0.7）从 fm.fsrs 读，不回刷则掌握度停在完成时刻
   * （ADR-0007 成立的前提）。节点文件仍是调度状态事实源——coursesTree / graphNode /
   * 图着色继续只读 fm；这只是快照回写，不是新的调度入口，「每题每天一次推进」
   * 不变量仍由题卡侧把守。代表卡没变（推的不是代表题）时不重写文件。 */
  private async refreshRepCard(c: CourseEntry, graph: Graph, node: string): Promise<Fm | null> {
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    let rep: FsrsBlock | null = null
    for (const q of bank.questions) {
      if (q.archived || !q.fsrs?.reps || !q.fsrs.due) continue
      if (!rep || q.fsrs.due < rep.due) rep = q.fsrs
    }
    const note = await this.nodeNote(c, graph, node)
    if (!note.fm) return null
    if (!rep) return note.fm
    const cur = note.fm.fsrs
    if (cur && cur.stability === rep.stability && cur.difficulty === rep.difficulty && cur.due === rep.due
      && cur.last_review === rep.last_review && cur.reps === rep.reps && cur.lapses === rep.lapses) return note.fm
    const next: Fm = { ...note.fm, fsrs: rep }
    await this.saveNodeNote(note.path, next, note.body)
    return next
  }

  // ---- C1 笔记复习源（#59 / ADR-0010：只出题不动文，派生物落镜像区）----

  private noteManifest: NoteSourceManifest

  /** 笔记源路由判定：course=「笔记源」伪课程（真实课程同名时课程优先，不触发路由）。 */
  private async isNoteSourceCourse(courseKey: string | undefined): Promise<boolean> {
    if (courseKey !== NOTE_SOURCE_COURSE) return false
    return (await this.registry.get(NOTE_SOURCE_COURSE)) === null
  }

  /** 笔记源注册：路径（vault 相对/绝对）为文件时单篇、为文件夹时批量登记其下全部
   * .md（递归，跳过点目录）。每次注册重算指纹并启用——对已注册路径是恢复语义
   * （Missing 后重注册）；学习中心内部路径拒绝（引擎管理区不收编）。用户笔记零写入
   * ——只读文件算指纹与标题。 */
  /** 注册身份落盘带显式 enabled（#59 契约：{id, 路径, enabled, created}），
   * 文件夹批量登记时逐文件归一；学习中心内部的 .md（如注册 vault 根）跳过不失败。
   * 用户排除清单（V-1 #86）在注册入口强制执行：输入路径命中清单 fail loud（先
   * unexclude 再注册），批量登记扫到清单内子树跳过（skipped 计数 + skipped_paths）。 */
  async noteSourceRegister(
    input: string, today?: string,
  ): Promise<NoteSourceRegisterResult> {
    today ??= (await this.learningDay()).today
    const rel0 = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, input)
    const relOf = (abs: string): string => abs.slice(this.vaultRoot.length + 1)
    const excludes = await readNoteSourceExcludes(this.paths)
    if (isExcludedPath(rel0, excludes)) {
      throw new Error(`[note-source] 路径在用户排除清单内，不注册（先 learnhub_note_source_unexclude 解除）：${rel0}`)
    }
    const skippedPaths: string[] = []
    const files = await collectNoteFiles(`${this.vaultRoot}/${rel0}`, abs => {
      if (!isExcludedPath(relOf(abs), excludes)) return false
      skippedPaths.push(relOf(abs))
      return true
    })
    if (!files.length) {
      if (skippedPaths.length) {
        throw new Error(`[note-source] 该路径下的 .md 全部命中排除清单，没有可注册的笔记（learnhub_note_source_unexclude 可解除）：${skippedPaths.join('、')}`)
      }
      throw new Error('[note-source] 该路径下没有 .md 笔记。')
    }
    const entries = await this.registry.loadNoteSources()
    const manifest = await this.noteManifest.load()
    const byPath = new Map(entries.map(e => [e.path, e]))
    let registered = 0
    let updated = 0
    let skipped = skippedPaths.length
    for (const f of files) {
      let rel: string
      try {
        rel = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, f.abs)
      } catch (err) {
        if (!(err instanceof Error) || !/学习中心内部/.test(err.message)) throw err
        skipped++ // 文件夹批量登记扫到引擎管理区文件：跳过（不收编、不让整批失败）
        skippedPaths.push(relOf(f.abs))
        continue
      }
      const raw = await readFile(f.abs, 'utf8')
      let entry = byPath.get(rel)
      if (entry) {
        entry.enabled = true
        updated++
      } else {
        const n = entries.reduce((m, e) => Math.max(m, Number(/^note-(\d+)$/.exec(e.id)?.[1] ?? 0)), 0) + 1
        entry = { id: `note-${n}`, path: rel, enabled: true, created: today }
        entries.push(entry)
        registered++
      }
      const item: NoteSourceManifestItem = {
        id: entry.id, path: rel, fingerprint: fingerprintOf(raw),
        title: titleOfBody(stripFrontmatter(raw), f.filename), enabled: true,
      }
      const idx = manifest.sources.findIndex(s => s.id === item.id)
      if (idx >= 0) manifest.sources[idx] = item
      else manifest.sources.push(item)
    }
    await this.registry.save(await this.registry.load(), entries)
    await this.noteManifest.save(manifest)
    const view = await this.noteSourceList(today)
    return {
      date: today, registered, updated, skipped, sources: view.sources,
      ...(skippedPaths.length ? { skipped_paths: skippedPaths } : {}),
    }
  }

  /** 源卡池计数（列表与卡池镜像共用）：未归档卡数 + 当期到期数；镜像 Broken 时
   * 带原因（列表据此挂起该源、镜像据此写状态行）。未出题 = 合法空池零计数。 */
  private async noteSourcePoolStats(
    id: string, today: string,
  ): Promise<{ cards: number; due: number; broken?: string }> {
    if (!existsSync(this.bank.bankPath(this.paths.noteSourceDir, id))) return { cards: 0, due: 0 }
    try {
      const bank = await this.bank.load(this.paths.noteSourceDir, id)
      let cards = 0
      let due = 0
      for (const q of bank.questions) {
        if (q.archived) continue
        cards++
        if (q.fsrs?.reps && q.fsrs.due <= today) due++
      }
      return { cards, due }
    } catch (err) {
      return { cards: 0, due: 0, broken: err instanceof Error ? err.message.split('\n')[0] : String(err) }
    }
  }

  /** 笔记源清单：注册身份（注册表）× 指纹状态（源清单 + 现读文件）× 卡池概况。
   * 用户笔记永不判 Broken：文件缺失 = missing、指纹不符 = drifted、清单条目缺失 =
   * inconsistent（镜像不一致，data-check 同步报出），状态与提示随条目带出。
   * excludes = 用户排除清单（V-1 #86），只影响未来的注册入口，不挂起已注册源。 */
  async noteSourceList(today?: string): Promise<NoteSourceDoc> {
    today ??= (await this.learningDay()).today
    const excludes = await readNoteSourceExcludes(this.paths)
    const entries = await this.registry.loadNoteSources()
    const manifest = await this.noteManifest.load()
    const itemById = new Map(manifest.sources.map(s => [s.id, s]))
    const out: Array<Record<string, unknown>> = []
    for (const e of entries) {
      const { status, title } = await this.sourceStatusOf(e, itemById.get(e.id))
      const pool = await this.noteSourcePoolStats(e.id, today)
      const hint = pool.broken ? `题库镜像 Broken：${pool.broken}` : sourceHint(status)
      out.push({
        id: e.id, path: e.path, title, enabled: e.enabled !== false, created: e.created,
        status, cards: pool.cards, due: pool.due,
        ...(hint ? { hint } : {}),
        ...(pool.broken ? { broken: true } : {}),
      })
    }
    return { date: today, total: out.length, excludes, sources: out }
  }

  /** 解除注册：注册表条目 + 源清单条目 + 镜像题库一并清除；用户笔记文件不动。 */
  async noteSourceUnregister(id: string): Promise<{ removed: string; path: string }> {
    const { entry } = await this.requireSource(id)
    await this.registry.save(await this.registry.load(), (await this.registry.loadNoteSources()).filter(e => e.id !== id))
    const manifest = await this.noteManifest.load()
    await this.noteManifest.save({ sources: manifest.sources.filter(s => s.id !== id) })
    const bankPath = this.bank.bankPath(this.paths.noteSourceDir, id)
    if (existsSync(bankPath)) await unlink(bankPath)
    const poolPath = this.paths.noteSourcePoolPath(id)
    if (existsSync(poolPath)) await unlink(poolPath) // 卡池镜像随源清除（V-4 #108）
    return { removed: id, path: entry.path }
  }

  // ---- 卡池镜像（V-4 #108：Obsidian backlink 通道）----

  /** 写卡池镜像（出题/重连后调用）：带 [[个人笔记]] 链接的 md 落镜像区（引擎地盘，
   * 个人笔记零写入）——Obsidian 的 backlink 面板让个人笔记侧看到关联卡池状态。
   * 计数与状态是写入时刻的快照（截至日标注在文内），实时状态以 noteSourceList 为准。 */
  private async writePoolMirror(id: string, today: string): Promise<void> {
    const { entry, item } = await this.requireSource(id)
    const { status, title } = await this.sourceStatusOf(entry, item)
    const pool = await this.noteSourcePoolStats(id, today)
    await mkdir(this.paths.noteSourcePoolDir, { recursive: true })
    await atomicWrite(this.paths.noteSourcePoolPath(id), poolMirrorBody({
      notePath: entry.path, title, cards: pool.cards, due: pool.due, today,
      ...(sourceHint(status) || pool.broken
        ? { statusHint: sourceHint(status) ?? `题库镜像异常：${pool.broken}` }
        : {}),
    }))
  }

  // ---- 漂移治理全量化（V-6 #109：改名/移动 → relink 或 Missing）----

  /** 笔记源 relink：把既有源重连到新路径——注册身份（id）与镜像题库/卡池原样保留
   * （这正是它与「解除后重注册」的区别：旧卡调度不丢）。四类漂移的确定行为收口：
   * 改名/移动 → Missing（既有语义）+ 本动作重连；删除 → 卡池挂起；编辑 → 提示重出。
   * 新路径过注册同款卫生（normalizeSourcePath + 用户排除清单），目标文件必须现存
   * （relink 是恢复动作，目标不可读即 fail loud），已被其他源占用的路径拒绝；
   * 原路径缺失不阻塞——那正是 relink 的使用场景。 */
  async noteSourceRelink(id: string, input: string, today?: string): Promise<{ id: string; from: string; to: string }> {
    today ??= (await this.learningDay()).today
    const rel = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, input)
    const { entry } = await this.requireSource(id)
    if (entry.path === rel) {
      throw new Error(`[note-source] 「${id}」已注册在路径 ${rel}（relink 请给改名/移动后的新路径）。`)
    }
    const excludes = await readNoteSourceExcludes(this.paths)
    if (isExcludedPath(rel, excludes)) {
      throw new Error(`[note-source] 目标路径在用户排除清单内，不重连（先 learnhub_note_source_unexclude 解除）：${rel}`)
    }
    const others = (await this.registry.loadNoteSources()).filter(e => e.id !== id)
    const taken = others.find(e => e.path === rel)
    if (taken) {
      throw new Error(`[note-source] 目标路径已是笔记源「${taken.id}」的注册路径：${rel}（先解除它再重连）。`)
    }
    const abs = `${this.vaultRoot}/${rel}`
    if (!existsSync(abs)) {
      throw new Error(`[note-source] relink 目标文件不存在：${rel}（重连的是现存文件；整体挪走目录后给出新路径）。`)
    }
    const raw = await readFile(abs, 'utf8')
    const from = entry.path
    const entries = await this.registry.loadNoteSources()
    const target = entries.find(e => e.id === id)!
    target.path = rel
    await this.registry.save(await this.registry.load(), entries)
    const manifest = await this.noteManifest.load()
    const idx = manifest.sources.findIndex(s => s.id === id)
    if (idx >= 0) {
      manifest.sources[idx] = {
        ...manifest.sources[idx]!,
        path: rel,
        fingerprint: fingerprintOf(raw),
        title: titleOfBody(stripFrontmatter(raw), rel.split('/').pop() ?? id),
        enabled: true,
      }
      await this.noteManifest.save(manifest)
    }
    await this.writePoolMirror(id, today) // 卡池镜像的 [[链接]] 跟到新路径
    return { id, from, to: rel }
  }

  // ---- 用户排除清单（V-1 #86：state/learnhub.json 的 note_source_excludes）----

  /** 读排除清单（noteSourceList 同款视图；只影响未来注册，不摘除已注册源）。 */
  async noteSourceExcludes(): Promise<{ excludes: string[] }> {
    return { excludes: await readNoteSourceExcludes(this.paths) }
  }

  /** 加一条排除（vault 相对/绝对路径，文件或文件夹均可；归一去重排序落盘）。
   * 已在清单 = 幂等返回；路径不要求现存（可先排除后建文件）。 */
  async noteSourceExclude(input: string): Promise<{ excludes: string[] }> {
    const cur = await readNoteSourceExcludes(this.paths)
    const rel = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, input)
    const next = [...new Set([...cur, rel])].sort()
    await writeNoteSourceExcludes(this.paths, next)
    return { excludes: next }
  }

  /** 解除一条排除：不在清单 fail loud（提示现清单——显式动作要对得上号）。 */
  async noteSourceUnexclude(input: string): Promise<{ excludes: string[] }> {
    const cur = await readNoteSourceExcludes(this.paths)
    const rel = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, input)
    if (!cur.includes(rel)) {
      throw new Error(`[note-source] 排除清单没有「${rel}」（noteSourceList 的 excludes 查看现清单）。`)
    }
    const next = cur.filter(e => e !== rel)
    await writeNoteSourceExcludes(this.paths, next)
    return { excludes: next }
  }

  /** 笔记源定位（注册身份 + 源清单条目齐备才合法；单边缺失是镜像不一致，fail loud）。 */
  private async requireSource(id: string): Promise<{ entry: NoteSourceEntry; item: NoteSourceManifestItem }> {
    const entries = await this.registry.loadNoteSources()
    const entry = entries.find(e => e.id === id)
    if (!entry) throw new Error(`[note-source] 没有笔记源「${id}」（learnhub_note_source_list 查看已注册源）。`)
    const manifest = await this.noteManifest.load()
    const item = manifest.sources.find(s => s.id === id)
    if (!item) {
      throw new Error(`[note-source] 笔记源「${id}」缺源清单条目（镜像不一致）——跑 learnhub_data_check 定位，或解除后重新注册。`)
    }
    return { entry, item }
  }

  /** 单源现读状态（列表与复习队列共用）：文件存在性 → Missing、清单指纹比对 → 漂移；
   * 清单条目缺失 → inconsistent（无法核对指纹，卡不挂起，data-check 报镜像不一致）。 */
  private async sourceStatusOf(
    e: NoteSourceEntry, item: NoteSourceManifestItem | undefined,
  ): Promise<{ status: NoteSourceStatus; title: string }> {
    const abs = `${this.vaultRoot}/${e.path}`
    const fallbackTitle = e.path.split('/').pop() ?? e.path
    if (!existsSync(abs)) return { status: 'missing', title: item?.title ?? fallbackTitle }
    const raw = await readFile(abs, 'utf8')
    const title = titleOfBody(stripFrontmatter(raw), fallbackTitle)
    if (!item) return { status: 'inconsistent', title }
    return { status: classifySource(true, item.fingerprint === fingerprintOf(raw)), title }
  }

  /** 收题公步（#119 防相似：笔记出题/节点出题/逐节出题三处同缝）：程序化查重命中
   * → duplicate（附对方题面供报告）；入库成功把题面登记进查重基线（批内互查）；
   * 单题非法（超纲题型等）→ invalid，不毁整批。 */
  private async admitQuestion(
    root: string, node: string, q: Record<string, unknown>, stem: string,
    existingStems: Array<{ q: string; kind?: string; difficulty?: number }>,
  ): Promise<{ verdict: 'added' } | { verdict: 'duplicate'; against: string } | { verdict: 'invalid' }> {
    const dup = findDuplicateStem(stem, existingStems)
    if (dup) return { verdict: 'duplicate', against: dup }
    try {
      await this.bank.addQuestion(root, node, q)
    } catch {
      return { verdict: 'invalid' }
    }
    existingStems.push({ q: stem, kind: typeof q.kind === 'string' ? q.kind : undefined, difficulty: undefined })
    return { verdict: 'added' }
  }

  /** 出生打标修复轮（#148）：概念清单在场且有题缺 invokes 时的一次补标调用——按题目
   * 序号回填清单内名字；清单缺席直接跳过（出生打标门不激活，invokes 恒合法 Missing）。
   * 修复恰好一次：补不齐不重试，仍空的题由受理门拒收/弃置（负路径在受理门侧收口）。
   * 返回实际回填的题数（留痕用）。 */
  private async repairInvokesOnce(
    llm: LlmComplete,
    items: unknown[],
    scope: string[],
  ): Promise<number> {
    if (!scope.length) return 0
    const missing = items.filter((x): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && !invokesTagged(x as Record<string, unknown>))
    if (!missing.length) return 0
    const prompt = [
      '## 任务：为下列题目各补一枚 invokes 概念标注',
      '',
      '从概念清单中为每道题选**恰一枚**本题最主要考察的概念，名字精确照抄清单（一字不差）。只输出一个 YAML 映射（不要代码围栏、不要任何解释），键为题目序号、值为概念名：',
      '',
      '1: 概念名',
      '2: 概念名',
      '',
      '## 概念清单',
      '',
      ...scope.map(c => `- ${c}`),
      '',
      '## 题目（按序号）',
      '',
      ...missing.map((it, i) => {
        const stem = typeof it.q === 'string' ? it.q : ''
        return `${i + 1}. ${stem ? stem.slice(0, 80) : '（无题干）'}`
      }),
    ].join('\n')
    let doc: unknown
    try {
      doc = YAML.parseModel(await llm(prompt))
    } catch {
      return 0 // 补标应答不可解析 = 修复失败，仍空交受理门拒收
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 0
    const map = doc as Record<string, unknown>
    let filled = 0
    missing.forEach((it, i) => {
      const v = map[String(i + 1)] ?? map[i + 1]
      if (typeof v === 'string' && v.trim()) {
        it.invokes = v.trim()
        filled++
      }
    })
    return filled
  }

  /** 笔记源出题：读笔记正文（只读）→ 笔记出题 prompt + llm → validateBank 门禁逐题
   * 落镜像题库（学习中心/笔记源/题库/<源id>.yaml）→ 新卡初始化 FSRS（同完成学习的
   * 合成首复习语义，明天起刷，rating_source=synthetic 落复习日志）→ 源清单指纹刷新
   * （出题读的是当前内容，漂移就此确认；旧卡不自动归档，归档是独立动作）。
   * 防相似（#119）：提示词注入镜像题库已有题面 ≤15 条，生成后逐题查重，命中的丢弃。 */
  async noteSourceGenerate(
    id: string, count: number | undefined,
    llm: LlmComplete,
    today?: string,
  ): Promise<{ id: string; added: number; skipped: number; total: number; duplicates: Array<{ q: string; against: string }> }> {
    today ??= (await this.learningDay()).today
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
      throw new Error(`[note-quiz] count 必须是正整数（收到 ${String(count)}）；省略才使用默认 6。`)
    }
    const requested = count ?? 6
    const { entry } = await this.requireSource(id)
    const abs = `${this.vaultRoot}/${entry.path}`
    if (!existsSync(abs)) {
      throw new Error(`[note-quiz] 源文件缺失（Missing）：${entry.path}——重新注册（同路径）可恢复后再生题。`)
    }
    const raw = await readFile(abs, 'utf8')
    const body = stripFrontmatter(raw)
    if (!body) throw new Error(`[note-quiz] 笔记正文为空，无可出题内容：${entry.path}`)
    const tpl = await this.loadPrompt('笔记出题')
    const bankBefore = await this.bank.load(this.paths.noteSourceDir, id)
    const existingStems = bankStemList(bankBefore)
    const rawOut = await llm(`${tpl}${existingStemsPromptBlock(existingStems)}\n\n## 题目数量\n\n${requested} 道\n\n---\n\n${body}`)
    const doc = YAML.parseModel(rawOut) as { questions?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions) || !doc.questions.length) {
      throw new Error('[note-quiz] 模型没有产出可用题目（questions 为空）。')
    }
    let added = 0
    let skipped = 0
    const duplicates: Array<{ q: string; against: string }> = []
    for (const rawQ of doc.questions.slice(0, requested)) {
      const q = { ...((rawQ ?? {}) as Record<string, unknown>) }
      delete q.id // id 由 addQuestion 按现有卡数自动编号
      const stem = typeof q.q === 'string' ? q.q : ''
      const verdict = await this.admitQuestion(this.paths.noteSourceDir, id, q, stem, existingStems)
      if (verdict.verdict === 'duplicate') {
        duplicates.push({ q: stem.slice(0, 80), against: verdict.against.slice(0, 80) })
      } else if (verdict.verdict === 'added') {
        added++
      } else {
        skipped++ // 单题非法（如超纲题型）不毁整批
      }
    }
    if (!added) throw new Error('[note-quiz] 模型产出的题目全部未过校验门（题型/答案格式不符/重复），一道都没入库。')
    // 新卡合成首复习初始化（同 nodeComplete 语义：明天起刷）
    const sched = await this.sched(null)
    const bank = await this.bank.load(this.paths.noteSourceDir, id)
    for (const q of bank.questions) {
      if (q.archived || q.fsrs?.reps) continue
      const { fs } = applyRatingBlock(null, 3, today, sched)
      await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, id, q.id, { fsrs: fs })
      await this.store.appendReview({
        course: NOTE_SOURCE_COURSE, node: id, qid: q.id,
        rating: 3, rating_source: 'synthetic', elapsed_days: 0,
        stability_before: null, difficulty_before: null, r_pred: null,
      })
    }
    // 指纹刷新 + 标题同步（出题即确认当前内容；重出/归档建议就此清除）
    const manifest = await this.noteManifest.load()
    const idx = manifest.sources.findIndex(s => s.id === id)
    if (idx >= 0) {
      manifest.sources[idx] = {
        ...manifest.sources[idx]!,
        fingerprint: fingerprintOf(raw),
        title: titleOfBody(body, entry.path.split('/').pop() ?? id),
      }
      await this.noteManifest.save(manifest)
    }
    await this.writePoolMirror(id, today) // 卡池镜像（V-4 #108）：[[个人笔记]] backlink + 池概况
    return { id, added, skipped, total: bank.questions.length, duplicates }
  }

  /** 笔记源卡池合并进全局复习队列（reviewQueue 专用）：Missing → 卡池挂起（不出卡，
   * 状态随响应带出）；题库镜像 Broken → 该源卡挂起并带原因（镜像契约文件才 fail
   * loud，且不阻塞其他源）；漂移不挂起（旧卡继续复习，提示可重出/归档）。
   * inconsistent（清单条目缺失）无法核对指纹：卡照常出，状态随响应带出。 */
  private async collectNoteSourceCards(
    today: string,
  ): Promise<{ cards: Array<Record<string, unknown>>; drifted: Array<Record<string, unknown>>; suspended: Array<Record<string, unknown>> }> {
    const cards: Array<Record<string, unknown>> = []
    const drifted: Array<Record<string, unknown>> = []
    const suspended: Array<Record<string, unknown>> = []
    const entries = await this.registry.loadNoteSources()
    if (!entries.length) return { cards, drifted, suspended }
    const manifest = await this.noteManifest.load()
    const itemById = new Map(manifest.sources.map(s => [s.id, s]))
    const sched = await this.sched(null)
    for (const e of entries) {
      if (e.enabled === false) continue
      const item = itemById.get(e.id)
      const { status, title } = await this.sourceStatusOf(e, item)
      if (status === 'missing') {
        suspended.push({ id: e.id, path: e.path, reason: sourceHint('missing') })
        continue
      }
      if (status === 'drifted') {
        drifted.push({ id: e.id, path: e.path, hint: sourceHint('drifted') })
      }
      if (status === 'inconsistent') {
        drifted.push({ id: e.id, path: e.path, hint: sourceHint('inconsistent') })
      }
      const bankPath = this.bank.bankPath(this.paths.noteSourceDir, e.id)
      if (!existsSync(bankPath)) continue // 尚未出题：合法空卡池
      let bank: BankDoc
      try {
        bank = await this.bank.load(this.paths.noteSourceDir, e.id)
      } catch (err) {
        suspended.push({ id: e.id, path: e.path, reason: `题库镜像 Broken：${err instanceof Error ? err.message.split('\n')[0] : String(err)}` })
        continue
      }
      bank.questions.forEach((q, i) => {
        if (q.archived) return
        const card = this.questionView(q, i)
        if (!card.due || String(card.due) > today) return
        const r = retrievabilityBlock(sched, q.fsrs, today)
        cards.push({
          course: NOTE_SOURCE_COURSE, node: e.id, source: 'note',
          title: item?.title ?? title,
          // 来源笔记可跳转（V-4 #108）：vault 相对路径 + 绝对路径（面板拼 obsidian:// 用）
          source_path: e.path, source_abs: `${this.vaultRoot}/${e.path}`,
          r: Math.round(r * 1000) / 1000,
          d: Math.round(combinedDifficulty(q.difficulty, q.fsrs) * 1000) / 1000,
          ...card,
        })
      })
    }
    return { cards, drifted, suspended }
  }

  /** 笔记源卡一次评分推进（作答/自评/忘记三通道共用）：推镜像题库卡 + 落复习日志
   * （course=笔记源；调度器用默认参数——笔记源不挂课程个人参数）。返回新 fsrs 块。
   * 无守门（ADR-0014 advancePending）：三个调用方各自持准入（repeated/pending/stats.last）。 */
  private async pushNoteCard(
    sourceId: string, q: BankQuestion, fsOld: FsrsBlock | null,
    rating: 1 | 2 | 3 | 4, ratingSource: 'auto' | 'self', today: string,
    stats: BankQuestion['stats'],
  ): Promise<FsrsBlock> {
    const sched = await this.sched(null)
    const pushed = advancePending(sched, { fsrs: fsOld }, rating, today)
    await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, sourceId, q.id, { fsrs: pushed.fs, stats })
    await this.store.appendReview({
      course: NOTE_SOURCE_COURSE, node: sourceId, qid: q.id,
      rating, rating_source: ratingSource, ...pushed.log,
    })
    return pushed.fs
  }

  /** 笔记源作答（C1 #59）：判卷同题库通道；推进只有题目级 FSRS + 复习日志
   * （course=笔记源）——无节点证据、无 practice 流水、无节点定价/settle（同复习
   * 自评语义，ADR-0010）、无代表卡（笔记源没有节点）。XP 走无绑定行（ADR-0021）：
   * 与题卡同公式结算（含乱猜负 XP），作答时即落（挂起路径同题卡 practice 同时点）。 */
  private async noteSourceAnswer(
    llmComplete: LlmComplete,
    sourceId: string, qid: string, answer: string,
    opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null; elapsed_s?: number | null },
  ): Promise<Record<string, unknown>> {
    const bank = await this.bank.load(this.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { score, feedback } = await this.judgeBankAnswer(llmComplete, q, answer, 'question',
      { course: NOTE_SOURCE_COURSE, node: sourceId, qid })
    const correct = score >= PASS_SCORE
    const { today } = await this.learningDay()
    const repeated = alreadyAdvanced(q, today)
    const settle = xpForAnswer(q.kind, q.difficulty ?? 1, correct, opts?.elapsed_s ?? null, !repeated)
    if (!repeated) {
      await this.store.appendJournal({
        course: '*', node: '*', rating: null, kind: 'xp_notesource', elapsed_days: 0,
        xp: settle.xp, detail: `笔记源 ${sourceId}#${q.id}（${settle.reason}）`,
      })
    }
    let fs: FsrsBlock | null
    let pendingRating = false
    let advanced = false
    let previews: { hard: string; good: string; easy: string } | undefined
    const stats = {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: (q.stats?.correct ?? 0) + (correct ? 1 : 0),
      last: today,
      last_correct: correct,
      // 同日重复作答不丢今日已挂起的自评（ADR-0014：pending 态保持完整）
      ...(q.stats?.pending_rating && q.stats?.last === today ? { pending_rating: true } : {}),
    }
    if (repeated) {
      fs = q.fsrs ?? null
      await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, sourceId, qid, { fsrs: fs, stats })
    } else if (opts?.deferSchedule === true && correct) {
      const sched = await this.sched(null)
      pendingRating = true
      previews = {
        hard: previewDue(sched, q.fsrs ?? null, 2, today),
        good: previewDue(sched, q.fsrs ?? null, 3, today),
        easy: previewDue(sched, q.fsrs ?? null, 4, today),
      }
      fs = q.fsrs ?? null
      await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, sourceId, qid, {
        fsrs: fs, stats: { ...stats, pending_rating: true },
      })
    } else {
      fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, correct ? 3 : 1, 'auto', today, stats)
      advanced = true
    }
    return {
      correct, score: Math.round(score * 100), feedback,
      answer: revealAnswer(q), kind: q.kind,
      due: fs?.due ?? null,
      scheduled: advanced, pendingRating,
      ...(previews ? { previews } : {}),
      xp: settle.xp, // 无绑定 XP（ADR-0021）：不入节点/practice 账，journal 行已落
    }
  }

  /** 笔记源自评结算：挂起标记唯一准入，推卡 + 复习日志（self），无代表卡回刷。 */
  private async noteSourceRate(sourceId: string, qid: string, r: number): Promise<Record<string, unknown>> {
    const bank = await this.bank.load(this.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-rate] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { today } = await this.learningDay()
    if (q.stats?.last !== today || !q.stats?.pending_rating) {
      throw new Error(`[question-rate] 笔记源 ${sourceId}/${qid} 今天没有待结算的自评（未作答或非挂起路径）。`)
    }
    const { pending_rating: _drop, ...statsRest } = q.stats
    const fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, r as 1 | 2 | 3 | 4, 'self', today, { ...statsRest })
    return { course: NOTE_SOURCE_COURSE, node: sourceId, qid, rating: r, due: fs.due, scheduled: true }
  }

  /** 笔记源忘记申报：rating=1 推卡 + 复习日志（auto），当日已推进拒绝。 */
  private async noteSourceForget(sourceId: string, qid: string): Promise<Record<string, unknown>> {
    const bank = await this.bank.load(this.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-forget] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { today } = await this.learningDay()
    if (q.stats?.last === today) {
      throw new Error(`[question-forget] 笔记源 ${sourceId}/${qid} 今天已有推进记录，忘记只用于本日首次。`)
    }
    const fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, 1, 'auto', today, {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: q.stats?.correct ?? 0,
      last: today,
      last_correct: false,
    })
    // 忘记也是真实推进：落 0 XP 无绑定行，streak 口径与题卡忘记申报一致（ADR-0021）
    await this.store.appendJournal({
      course: '*', node: '*', rating: 1, kind: 'xp_notesource', elapsed_days: 0,
      xp: 0, detail: `笔记源 ${sourceId}#${q.id}（forget）`,
    })
    return {
      correct: false, judge: 'forget',
      feedback: q.explanation ?? '', answer: revealAnswer(q), explanation: q.explanation ?? '',
      kind: q.kind, due: fs.due, scheduled: true, xp: 0,
    }
  }

  // ---- C2 Anki 通道（#63 / ADR-0011：Anki 纯作答通道，vault 唯一调度者）----

  private ankiMirror: AnkiMirror

  /** 到期卡导出负载：全部启用课程「未归档且 due ≤ 今日」的已调度题（复用
   * reviewQueue 的到期语义与 questionView 的题面视图；答案/解析上背面）。
   * 来源字段 = 课程/节点/题id，回写归属与清单丢失自愈的依据。
   * 笔记源到期卡并入（V-4 #108 / ADR-0011 衔接）：deck learnhub::笔记源，来源键
   * 笔记源/<源id>/题id——Missing/镜像 Broken 的源与复习队列同口径挂起不导出、
   * 不阻塞其他源；导入侧按同一来源键路由回镜像题库。 */
  private async collectAnkiDuePayloads(today: string): Promise<AnkiNotePayload[]> {
    const out: AnkiNotePayload[] = []
    for (const c of await this.enabledCourses()) {
      await this.scanCourseBanks(c, async (node, bank) => {
        for (const q of bank.questions) {
          if (q.archived || !q.fsrs?.reps || q.fsrs.due > today) continue
          const back = revealAnswer(q) + (q.explanation ? `\n\n解析：${q.explanation}` : '')
          out.push(ankiCardPayload(c.name, node, q, back))
        }
      })
    }
    for (const e of await this.registry.loadNoteSources()) {
      if (e.enabled === false) continue
      if (!existsSync(`${this.vaultRoot}/${e.path}`)) continue // Missing：卡池挂起
      const bankPath = this.bank.bankPath(this.paths.noteSourceDir, e.id)
      if (!existsSync(bankPath)) continue // 尚未出题：合法空卡池
      let bank: BankDoc
      try {
        bank = await this.bank.load(this.paths.noteSourceDir, e.id)
      } catch {
        continue // 镜像 Broken：该源挂起（data-check 显式报出），不阻塞其他源
      }
      for (const q of bank.questions) {
        if (q.archived || !q.fsrs?.reps || q.fsrs.due > today) continue
        const back = revealAnswer(q) + (q.explanation ? `\n\n解析：${q.explanation}` : '')
        out.push(ankiCardPayload(NOTE_SOURCE_COURSE, e.id, q, back))
      }
    }
    return out
  }

  /** 导出推送：按 vault 到期集校准/重建镜象卡组——新增缺卡、更新改题（fp 变化）、
   * 移除已归档/已重生成/已被 vault 消费的旧卡；镜象与 vault 不一致时以 vault 为
   * 准，Anki 侧排期输出不作数（ADR-0011）。Anki 侧手动删过的笔记自动重建。 */
  async ankiExportPush(transport: AnkiTransport, today?: string): Promise<{
    date: string; added: number; updated: number; removed: number; total: number; decks: string[]
  }> {
    today ??= (await this.learningDay()).today
    const payloads = await this.collectAnkiDuePayloads(today)
    const mirror = await this.ankiMirror.load()
    const plan = planMirrorSync(payloads, mirror.notes)
    const decks = [...new Set(payloads.map(p => p.deckName))]
    if (payloads.length) {
      const models = await ankiModelNames(transport)
      if (!models.includes(ANKI_MODEL)) await ankiCreateModel(transport)
      const have = new Set(await ankiDeckNames(transport))
      for (const d of decks) {
        if (!have.has(d)) await ankiCreateDeck(transport, d)
      }
    }
    const kept = new Map<string, AnkiMirrorEntry>()
    for (const e of mirror.notes) {
      if (!plan.removeNoteIds.includes(e.note_id)) kept.set(e.key, e)
    }
    for (const u of plan.update) {
      let noteId = u.noteId
      try {
        await ankiUpdateNoteFields(transport, noteId, u.payload.fields)
      } catch (err) {
        if (!isAnkiNoteMissing(err)) throw err
        noteId = await this.ankiUpsert(transport, u.payload) // Anki 侧笔记被手动删：重建
      }
      kept.set(u.payload.key, { key: u.payload.key, note_id: noteId, fp: u.payload.fp, deck: u.payload.deckName })
    }
    for (const p of plan.add) {
      const noteId = await this.ankiUpsert(transport, p)
      kept.set(p.key, { key: p.key, note_id: noteId, fp: p.fp, deck: p.deckName })
    }
    await ankiDeleteNotes(transport, plan.removeNoteIds)
    await this.ankiMirror.save({ last_push: nowIso(), last_import_ms: mirror.last_import_ms, notes: [...kept.values()] })
    return { date: today, added: plan.add.length, updated: plan.update.length, removed: plan.removeNoteIds.length, total: payloads.length, decks }
  }

  /** addNote，重复拒绝时按来源字段检索回补归属（清单丢失自愈；Anki 侧旧卡内容
   * 就地校准到 vault 当前版本）。找不到同源旧卡才抛错。 */
  private async ankiUpsert(transport: AnkiTransport, p: AnkiNotePayload): Promise<number> {
    const noteId = await ankiAddNote(transport, { deckName: p.deckName, fields: p.fields, tags: [ANKI_TAG] })
    if (noteId !== null) return noteId
    const found = await ankiFindNotes(transport, `deck:"${p.deckName}" tag:${ANKI_TAG}`)
    const infos = await ankiNotesInfo(transport, found)
    const hit = infos.find(n => (n.fields['来源'] ?? '').trim() === p.key)
    if (!hit) throw new Error(`[anki] 卡写入 Anki 失败且找不到同源旧卡：${p.key}`)
    await ankiUpdateNoteFields(transport, hit.noteId, p.fields)
    return hit.noteId
  }

  /** 导入回写：拉 Anki 复习日志事件（自上次导入水位起），逐事件映射为原始作答
   * 证据并按 vault 自己的 ts-fsrs 重算——Again → 答错（rating 1/auto）、
   * Hard/Good/Easy → 复习自评档（2/3/4/self，答对）；Anki 侧排期输出不作数
   * （ADR-0011）。「一题一天只推进一次」跨端守住：vault 当日已推进的题，其当日
   * Anki 事件跳过调度只留档（practice 流水）。事件落 practice 流水（judge=review，
   * ts 回溯到 Anki 作答时刻），真实推进另落复习日志（A2 数据回流）。归属 =
   * 镜象清单 noteId→key，清单丢失时按 Anki 来源字段回补；无法归属/题目已归档
   * 重生成的事件只计数不落盘（旧卡下次推送按 vault 校准移除）。nowMs 可注入
   * （测试播种；水位上界 = 调用时刻）。 */
  async ankiImportEvents(transport: AnkiTransport, opts?: { nowMs?: number }): Promise<{
    imported: number; advanced: number; skipped_same_day: number; skipped_unknown: number; unknown: string[]
  }> {
    const mirror = await this.ankiMirror.load()
    // 事件的学习日按 vault 自己的日界推（ADR-0020 裁决 5：不对齐 Anki rollover）
    const cutoff = await readDayCutoff(this.paths)
    const rows = await ankiCardReviews(transport, mirror.last_import_ms, (opts?.nowMs ?? Date.now()) + 60_000)
    const events = rows
      .map(r => ({ ts: Number(r[0]), cardId: Number(r[1]), button: Number(r[3]), timeMs: Number(r[7]) }))
      .filter(e => Number.isFinite(e.ts) && Number.isFinite(e.cardId) && Number.isFinite(e.button))
      .sort((a, b) => a.ts - b.ts)
    const result = { imported: events.length, advanced: 0, skipped_same_day: 0, skipped_unknown: 0, unknown: [] as string[] }
    if (!events.length) return result
    // cardId → noteId（一次批量）；noteId → 来源键（清单优先，缺的按来源字段回补）
    const noteOfCard = new Map<number, number>()
    for (const c of await ankiCardsInfo(transport, [...new Set(events.map(e => e.cardId))])) {
      noteOfCard.set(c.cardId, c.noteId)
    }
    const keyOfNote = new Map(mirror.notes.map(n => [n.note_id, n.key]))
    const missing = [...new Set([...noteOfCard.values()].filter(id => !keyOfNote.has(id)))]
    for (const info of await ankiNotesInfo(transport, missing)) {
      const key = (info.fields['来源'] ?? '').trim()
      const loc = parseSourceKey(key)
      if (loc) {
        keyOfNote.set(info.noteId, key)
        mirror.notes.push({ key, note_id: info.noteId, fp: '', deck: deckNameOf(loc.course) })
      }
    }
    // 课程上下文缓存：registry/loadView/scheduler 每课程一次；笔记源伪课程判定同样缓存
    type AnkiCourseCtx = { c: CourseEntry; graph: Graph; sched: Awaited<ReturnType<typeof getScheduler>> } | null
    const ctxCache = new Map<string, AnkiCourseCtx>()
    const noteCourseCache = new Map<string, boolean>()
    const isNoteCourse = async (name: string): Promise<boolean> => {
      let v = noteCourseCache.get(name)
      if (v === undefined) {
        v = await this.isNoteSourceCourse(name)
        noteCourseCache.set(name, v)
      }
      return v
    }
    let lastMs = mirror.last_import_ms
    for (const ev of events) {
      lastMs = Math.max(lastMs, ev.ts)
      const noteId = noteOfCard.get(ev.cardId)
      const key = noteId !== undefined ? keyOfNote.get(noteId) : undefined
      const loc = key ? parseSourceKey(key) : null
      const noteUnknown = (why: string) => {
        result.skipped_unknown++
        if (result.unknown.length < 5) result.unknown.push(`${key ?? `card#${ev.cardId}`}（${why}）`)
      }
      if (!loc) { noteUnknown('来源无法归属'); continue }
      let map: ReturnType<typeof mapAnkiEase>
      try {
        map = mapAnkiEase(ev.button)
      } catch {
        result.skipped_unknown++
        continue
      }
      const iso = isoFromMs(ev.ts)
      const day = dayOfTs(iso, cutoff)
      if (await isNoteCourse(loc.course)) {
        // 笔记源伪课程通道（V-4 #108 / ADR-0011 衔接）：回写镜像题库 + 默认参数
        // 调度器（与复习自评 pushNoteCard 同语义）——无节点证据、无代表卡、无课程参数
        let bank: BankDoc
        try {
          bank = await this.bank.load(this.paths.noteSourceDir, loc.node)
        } catch {
          noteUnknown('笔记源镜像题库不可读')
          continue
        }
        const idx = bank.questions.findIndex(x => x.id === loc.qid)
        const q = idx >= 0 ? bank.questions[idx] : undefined
        if (!q || q.archived) { noteUnknown('题目已归档或重生成'); continue }
        const r = advance(await this.sched(null), q, map.rating, day, 'anki')
        await this.store.appendPractice({
          course: NOTE_SOURCE_COURSE, node: loc.node, ex: idx + 1, answer: '',
          correct: map.correct, judge: 'review', qid: loc.qid,
          ...(ev.timeMs > 0 ? { elapsed_s: ev.timeMs / 1000 } : {}),
          xp: 0, ts: iso,
        })
        if (!r.advanced) { result.skipped_same_day++; continue }
        await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, loc.node, loc.qid, { fsrs: r.fs, stats: r.stats })
        await this.store.appendReview({
          course: NOTE_SOURCE_COURSE, node: loc.node, qid: loc.qid,
          rating: map.rating, rating_source: map.ratingSource, ...r.log,
        })
        q.fsrs = r.fs
        q.stats = r.stats
        result.advanced++
        continue
      }
      let ctx = ctxCache.get(loc.course)
      if (ctx === undefined) {
        const c = await this.registry.get(loc.course)
        if (!c) ctx = null
        else {
          const { graph } = await this.loadView(c)
          ctx = { c, graph, sched: await this.sched(this.paths.courseRoot(c.root)) }
        }
        ctxCache.set(loc.course, ctx)
      }
      if (!ctx) { noteUnknown('课程不在注册表'); continue }
      const courseRoot = this.paths.courseRoot(ctx.c.root)
      const bank = await this.bank.load(courseRoot, loc.node)
      const idx = bank.questions.findIndex(x => x.id === loc.qid)
      const q = idx >= 0 ? bank.questions[idx] : undefined
      if (!q || q.archived) { noteUnknown('题目已归档或重生成'); continue }
      const practiceBase = {
        course: ctx.c.name, node: loc.node, ex: idx + 1, answer: '',
        correct: map.correct, judge: 'review', qid: loc.qid,
        ...(ev.timeMs > 0 ? { elapsed_s: ev.timeMs / 1000 } : {}),
        xp: 0,
      }
      // 回放守门（ADR-0014 anki 通道 = vault 调度动作判定）：当日已推进过
      // （含合成初始化）→ 跳过调度只留档（fsrs/stats/复习日志零写入）
      const r = advance(ctx.sched, q, map.rating, day, 'anki')
      await this.store.appendPractice({ ...practiceBase, ts: iso })
      if (!r.advanced) {
        result.skipped_same_day++
        continue
      }
      await this.bank.updateQuestionEvidence(courseRoot, loc.node, loc.qid, { fsrs: r.fs, stats: r.stats })
      await this.store.appendReview({
        course: ctx.c.name, node: loc.node, qid: loc.qid,
        rating: map.rating, rating_source: map.ratingSource, ...r.log,
      })
      // 代表卡随真实推进回刷（口径 B 稳定度分量随复习前进；与站内复习同一语义）
      await this.refreshRepCard(ctx.c, ctx.graph, loc.node)
      q.fsrs = r.fs // 后续同日事件在内存里立即可见（不变量判定不重读盘）
      q.stats = r.stats
      result.advanced++
    }
    mirror.last_import_ms = lastMs
    await this.ankiMirror.save(mirror)
    return result
  }

  /** Anki 通道状态：镜象规模/最近推送与导入/当前到期分布 + AnkiConnect 可达性。 */
  async ankiStatus(transport?: AnkiTransport, today?: string): Promise<AnkiStatusDoc> {
    today ??= (await this.learningDay()).today
    const mirror = await this.ankiMirror.load()
    const payloads = await this.collectAnkiDuePayloads(today)
    const byDeck = new Map<string, number>()
    for (const p of payloads) byDeck.set(p.deckName, (byDeck.get(p.deckName) ?? 0) + 1)
    let anki: Record<string, unknown> | undefined
    if (transport) {
      try {
        await transport.invoke('version')
        anki = { connected: true }
      } catch (err) {
        anki = { connected: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
      }
    }
    return {
      date: today,
      mirror: {
        entries: mirror.notes.length,
        last_push: mirror.last_push,
        last_import: mirror.last_import_ms > 0 ? isoFromMs(mirror.last_import_ms) : null,
        decks: [...new Set(mirror.notes.map(n => n.deck))].filter(Boolean),
      },
      due: { total: payloads.length, by_deck: [...byDeck].map(([deck, count]) => ({ deck, count })) },
      ...(anki ? { anki } : {}),
    }
  }

  // ---- 节点跳过 / 完成确认 ----

  /** 跳过（已有基础）：stage 置 skipped，调度视同已通过；取消跳过回 ready。
   * 跳过即归档（ADR-0032）：该节点全部未归档题记原因 skip 后归档——跳过的语义是
   * 「视同已通过、退出推荐与阻塞」，其题库随之整体退场（休眠题不再占软上限额度、
   * 已调度题不再制造题库噪音）；取消跳过不自动恢复，恢复是显式动作
   * （题库管理面按原因 skip 筛出恢复）。 */
  async nodeSkip(courseKey: string | undefined, node: string, skipped: boolean): Promise<{ course: string; node: string; stage: Stage; archived?: number }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[skip] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'skip')
    if (!state[node]) await this.ensureNote(c.root, graph, node)
    const stage: Stage = skipped ? 'skipped' : 'ready'
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (fm) await saveNote(path, { ...fm, stage } as unknown as Record<string, unknown>, body)
    let archived: number | undefined
    if (skipped) {
      const courseRoot = this.paths.courseRoot(c.root)
      const bank = await this.bank.load(courseRoot, node)
      const n = await this.bank.archiveQuestions(
        courseRoot, node,
        bank.questions.filter(q => !q.archived).map(q => q.id),
        true, 'skip')
      archived = n || undefined
    }
    return { course: c.name, node, stage, ...(archived !== undefined ? { archived } : {}) }
  }

  /** 完成确认（Math Academy 语义的 lesson 通过判定）：
   * 正确率（题库 stats 聚合）< 及格线且作答次数足够时默认拒绝——不推进 stage、
   * 不初始化复习卡，返回 accepted=false 供前端引导复习（force=true 旁路）。
   * 通过时：全部未归档题目纳入复习循环（已作答的按各自 FSRS 调度到期复习，
   * 没作答的初始化为明天起刷），节点 stage→review；全部做过且全对 → 满分
   * bonus XP（journal 流水）。节点 frontmatter 同步写一份「聚合代表」fsrs
   * （全部题里到期最早的那张卡）：审计 E5 要求 review 有 fsrs，且 R_gate 的
   * 可提取性仍从节点状态读。 */
  async nodeComplete(courseKey: string | undefined, node: string, force = false): Promise<{
    accepted: boolean; accuracy: number | null; course: string; node: string
    stage?: Stage; initialized?: number; due?: string | null; reason?: string
    coach?: CoachCheck
  }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[complete] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'complete')
    if (!state[node]) await this.ensureNote(c.root, graph, node)
    const courseRoot = this.paths.courseRoot(c.root)
    const bank = await this.bank.load(courseRoot, node)
    let attempts = 0
    let correct = 0
    for (const q of bank.questions) {
      if (q.archived) continue
      attempts += q.stats?.attempts ?? 0
      correct += q.stats?.correct ?? 0
    }
    const accuracy = attempts ? Math.round((correct / attempts) * 100) / 100 : null
    if (state[node]?.stage === 'mastered' || state[node]?.stage === 'skipped') {
      return { accepted: true, accuracy, course: c.name, node, stage: state[node].stage, initialized: 0, due: null }
    }
    if (!force && attempts >= 3 && accuracy !== null && accuracy < PASS_SCORE) {
      return {
        accepted: false, accuracy, course: c.name, node,
        reason: `正确率 ${Math.round(accuracy * 100)}% 低于及格线（${PASS_SCORE}），建议明天再来或先复习前置概念。`,
      }
    }
    const sched = await this.sched(courseRoot)
    const { today } = await this.learningDay()
    let initialized = 0
    let due: string | null = null
    let repCard: FsrsBlock | null = null
    for (const q of bank.questions) {
      if (q.archived) continue
      if (q.fsrs?.reps) {
        const d = q.fsrs.due
        if (d && (!due || d < due)) { due = d; repCard = q.fsrs }
        continue
      }
      const { fs } = applyRatingBlock(null, 3, today, sched)
      await this.bank.updateQuestionEvidence(courseRoot, node, q.id, { fsrs: fs })
      // 复习日志：合成首复习是调度初始化不是真实作答 → rating_source='synthetic'、
      // 无「复习前」状态（快照三字段 null），诚实度统计（#61）不算它。
      await this.store.appendReview({
        course: c.name, node, qid: q.id,
        rating: 3, rating_source: 'synthetic', elapsed_days: 0,
        stability_before: null, difficulty_before: null, r_pred: null,
      })
      initialized++
      if (!due || fs.due < due) { due = fs.due; repCard = fs }
    }
    // 满分 bonus：本节点全部题都做过且全对 → 额外 XP（journal 流水，kind='xp_bonus'）。
    // 预算制下它是过程信号——下面的 xp_settle 对账会把它吸收进完成定价。
    if (attempts > 0 && correct === attempts) {
      await this.store.appendJournal({
        course: c.name, node, rating: null, kind: 'xp_bonus', elapsed_days: 0,
        xp: XP_PERFECT_BONUS, detail: `满分完成 +${XP_PERFECT_BONUS} XP`,
      })
    }
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (fm && fm.stage !== 'review') {
      const next: Fm = { ...fm, stage: 'review' }
      if (repCard) next.fsrs = repCard
      await saveNote(path, next as unknown as Record<string, unknown>, body)
      const { state: stateNow } = await this.loadView(c)
      await this.content.onStageChange(c.root, graph, stateNow, node, 'review')
      // XP 预算制完成对账：净 XP 收敛到完成时刻的 N = N₀ × k（est 内容定价 × FSRS 难度校准），
      // 并就此锁定（重复完成与后续复习作答不再改定价；乱猜/满分 bonus 等过程信号被对账吸收）。
      const activeQs = bank.questions.filter(q => !q.archived)
      const budget = Math.round(nominalBudget(graph.estOf[node], activeQs) * difficultyCalibration(activeQs))
      let earned = 0
      for (const rec of await this.store.practiceAll()) {
        if (rec.course === c.name && rec.node === node) earned += rec.xp ?? 0
      }
      for (const rec of await this.store.journalTail(c.name, Number.MAX_SAFE_INTEGER)) {
        if (rec.node === node) earned += rec.xp ?? 0
      }
      const delta = budget - earned
      if (delta !== 0) {
        await this.store.appendJournal({
          course: c.name, node, rating: null, kind: 'xp_settle', elapsed_days: 0,
          xp: delta,
          detail: `XP 预算对账：N₀=${nominalBudget(graph.estOf[node], activeQs)} × k=${difficultyCalibration(activeQs).toFixed(2)} = ${budget}，过程净 ${earned}`,
        })
      }
    }
    // 教练回合触发点·节点完成（#144）：完成落定后拉起就绪深度检查，随完成结果带出
    // （读侧感知，零写副作用；生长批裁决归 #145）。
    const coach = await this.coachCheckFor(c, today)
    return { accepted: true, accuracy, course: c.name, node, stage: 'review', initialized, due, coach }
  }

  // ---- XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注） ----

  /** XP 视图：今日 XP / streak / 每日目标 / 每课程 ETA。
   * ETA 预算制：剩余工作量 = Σ(未完成节点 N₀×k)——est 内容定价 × FSRS 难度校准，
   * 随作答证据积累自动校准；days = 剩余预算 ÷ 每日目标。 */
  async xpStatus(): Promise<XpStatus> {
    const { today, cutoff } = await this.learningDay()
    const [rawPractice, journal, activity, goal] = await Promise.all([
      this.store.practiceAll(),
      this.store.journalTail(null, Number.MAX_SAFE_INTEGER),
      this.store.activityCounts(cutoff),
      readDailyGoal(this.paths),
    ])
    // 勘误冲正按净值入 XP 账（ADR-0031）：streak 口径不变（行为条数，原流水仍在），
    // XP 值按冲正后的净值替换（作废归零、改判按对题补记）
    const practice = netPracticeRecs(rawPractice, await this.store.erratumAll())
    const eta: Array<{ course: string; remaining: number; done: number; per_node: number; days: number }> = []
    for (const c of await this.enabledCourses()) {
      const { graph, state, broken } = await this.loadView(c)
      assertNoBrokenNotes('eta', broken)
      const counts = { unseen: 0, ready: 0, learning: 0, review: 0, mastered: 0, skipped: 0 } as Record<Stage, number>
      for (const n of graph.names) counts[effectiveStage(state, n)]++
      const remaining = counts.unseen + counts.ready + counts.learning
      const done = counts.review + counts.mastered + counts.skipped
      let remainingXp = 0
      for (const n of graph.names) {
        const st = effectiveStage(state, n)
        if (st !== 'unseen' && st !== 'ready' && st !== 'learning') continue
        const bankDoc = await this.bank.load(this.paths.courseRoot(c.root), n)
        const activeQs = bankDoc.questions.filter(q => !q.archived)
        remainingXp += nominalBudget(graph.estOf[n], activeQs) * difficultyCalibration(activeQs)
      }
      const per = remaining ? Math.max(1, Math.round(remainingXp / remaining)) : 0
      eta.push({
        course: c.name, remaining, done, per_node: per,
        days: remainingXp > 0 ? Math.ceil(remainingXp / Math.max(1, goal)) : 0,
      })
    }
    return { date: today, day_cutoff: fmtCutoff(cutoff), today_xp: sumXp(practice, journal, today, cutoff), goal, streak: streakFrom(activity, today), streak_grace_days: XP_STREAK_GRACE_DAYS, eta }
  }

  /** 调整每日 XP 目标（state/learnhub.json）。 */
  async setDailyGoal(goal: number): Promise<{ goal: number }> {
    return { goal: await writeDailyGoal(this.paths, goal) }
  }

  /** 调整日界（state/learnhub.json 的 day_cutoff；ADR-0020）→ 生效 'HH:mm'。 */
  async setDayCutoff(value: string): Promise<{ day_cutoff: string }> {
    return { day_cutoff: await writeDayCutoff(this.paths, value) }
  }

  // ---- 记忆健康仪表盘（#61 A2 / ADR-0012）----

  /** 统计页四面板聚合（xpStatus 的姊妹方法，只读）：每日负载预报（扫全部启用课程
   * 题库 q.fsrs.due，Anki Forecast 语义）、记忆状态分布（Stability/Difficulty/当前
   * 可回忆度直方图；R 复用 reviewQueue 的 retrievabilityBlock 口径按各课程参数现算）、
   * 真实保留率 + 预测对照 + 遗忘曲线（#60 review-log：只计 auto+self 的到期复习，
   * synthetic 与首学推进不计入）。无数据给空态（rate=null / 计数 0），不造假数据。 */
  async memoryHealth(today?: string): Promise<MemoryHealthDoc> {
    const { today: learningToday, cutoff } = await this.learningDay()
    today ??= learningToday
    const dues: string[] = []
    const samples: Array<{ stability: number | null; difficulty: number | null; r: number }> = []
    for (const c of await this.enabledCourses()) {
      const sched = await this.sched(this.paths.courseRoot(c.root))
      await this.scanCourseBanks(c, async (_node, bank) => {
        for (const q of bank.questions) {
          if (q.archived || !q.fsrs?.reps || !q.fsrs.due) continue
          dues.push(q.fsrs.due)
          samples.push({
            stability: q.fsrs.stability,
            difficulty: q.fsrs.difficulty,
            r: retrievabilityBlock(sched, q.fsrs, today),
          })
        }
      })
    }
    const dueReviews = dueReviewFirstPushes(await this.store.reviewLogAll(), cutoff)
    return {
      date: today,
      forecast: { horizon_days: FORECAST_DAYS, ...forecast(dues, today) },
      state: { scheduled: samples.length, ...stateHistograms(samples) },
      retention: trueRetention(dueReviews),
      calibration: calibrationBins(dueReviews),
      forgetting: forgettingCurve(dueReviews),
      // 预测-校准（#66 E4）：学习者 JOL vs 实际——与 FSRS 自预测校准（calibration）正交；
      // 配对数不足门槛时为 null（不显示）。只展示，不喂 canonical。
      jol: jolCalibration(await this.store.practiceAll()),
    }
  }

  // ---- E4 JOL 抽查配置（state/learnhub.json 的 jol 字段；默认开、约 1/3）----

  /** 读 JOL 抽查配置：enabled=false 全局关闭（复习流完全不弹预测）；rate 抽样率。 */
  async jolConfig(): Promise<{ enabled: boolean; rate: number }> {
    const doc = await readLearnhubConfig(this.paths.learnhubConfigPath) as {
      jol?: { enabled?: boolean; rate?: number }
    }
    const enabled = doc.jol?.enabled !== false
    const rate = typeof doc.jol?.rate === 'number' && doc.jol.rate > 0 && doc.jol.rate <= 1
      ? doc.jol.rate : JOL_SAMPLE_RATE
    return { enabled, rate }
  }

  /** 写 JOL 抽查配置（原子替换，保留配置文件其他字段）。 */
  async setJolConfig(patch: { enabled?: boolean; rate?: number }): Promise<{ enabled: boolean; rate: number }> {
    const prev = await readLearnhubConfig(this.paths.learnhubConfigPath)
    const cur = await this.jolConfig()
    const next = { enabled: patch.enabled ?? cur.enabled, rate: patch.rate ?? cur.rate }
    await writeLearnhubConfig(this.paths.learnhubConfigPath, { ...prev, jol: next })
    return next
  }

  // ---- D1 N-of-1 实验引擎（#110 / ADR-0023：提案-确认制、白名单、批次交替/卡级分臂）----

  /** 实验模板库（含未解锁项——可见不可发起；白名单外参数结构上无法配置：propose
   * 只收模板 id，模板只从白名单登记）。 */
  async experimentTemplates(): Promise<Nof1Template[]> {
    return NOF1_TEMPLATES
  }

  async experimentList(): Promise<ExperimentDef[]> {
    return this.store.loadExperiments()
  }

  /** 当前在跑的实验（v1 一次一个；开停手动）。 */
  private async nof1Active(): Promise<ExperimentDef | null> {
    const list = await this.store.loadExperiments()
    return list.find(e => e.status === 'running') ?? null
  }

  /** 实验对复习队列的当日生效臂（批次交替，ADR-0023 裁决 2）。 */
  private async nof1QueueEffect(
    today: string,
  ): Promise<{ id: number; variable: Nof1Variable; arm: string } | null> {
    const exp = await this.nof1Active()
    if (!exp || exp.assignment.kind !== 'batch') return null
    return { id: exp.id, variable: exp.variable, arm: nof1ArmForDay(exp, today) }
  }

  /** 推进落复习日志时的臂标注（ADR-0023 裁决 5）：batch = 当日臂（范围内课程）；
   * card = 卡级分臂 map。只是归因留痕——不改变推进、XP、Mastery；优化器混训不特判。 */
  private async expTag(
    courseName: string, node: string, qid: string, today: string,
  ): Promise<{ id: number; arm: string } | null> {
    const exp = await this.nof1Active()
    if (!exp) return null
    if (exp.scope_course && exp.scope_course !== courseName) return null
    if (exp.assignment.kind === 'card') {
      const arm = exp.assignment.map[`${courseName}/${node}/${qid}`]
      return arm ? { id: exp.id, arm } : null
    }
    return { id: exp.id, arm: nof1ArmForDay(exp, today) }
  }

  /** 合格卡池（已调度未归档题卡，范围过滤）：卡级随机化的分臂对象与提案预览口径。 */
  private async nof1PoolKeys(scopeCourse: string | null): Promise<string[]> {
    const keys: string[] = []
    for (const c of await this.enabledCourses()) {
      if (scopeCourse && c.name !== scopeCourse) continue
      await this.scanCourseBanks(c, async (node, bank) => {
        for (const q of bank.questions) {
          if (!q.archived && q.fsrs?.reps) keys.push(`${c.name}/${node}/${q.id}`)
        }
      })
    }
    return keys
  }

  /** 提案-确认制第一步：模板发起 → pending experiment 提案（参数与合格卡池随提案
   * 给学习者过目）。白名单外/未解锁模板 fail loud；已有实验在跑拒绝（v1 单实验）。 */
  async experimentPropose(
    templateId: string, course?: string,
  ): Promise<{ proposal: number; template: string; title: string; pool: number; scope_course: string | null }> {
    const tpl = nof1Template(templateId)
    if (!tpl) {
      throw new Error(`[nof1] 没有模板「${templateId}」（可用：${NOF1_TEMPLATES.map(t => t.id).join('、')}）。白名单外参数无法配置为实验变量（ADR-0023）。`)
    }
    if (!tpl.unlocked) {
      throw new Error(`[nof1] 模板「${tpl.title}」未解锁：${tpl.unlock_note ?? '参数未上线'}。`)
    }
    if (course) await this.registry.resolve(course)
    const running = await this.nof1Active()
    if (running) {
      throw new Error(`[nof1] 实验 #${running.id}（${running.title}）还在跑——v1 一次一个实验，先 learnhub_experiment_stop 再开新的。`)
    }
    const pool = (await this.nof1PoolKeys(course ?? null)).length
    const armText = tpl.arms.map(a => tpl.arm_labels[a] ?? a).join(' / ')
    const summary = `${tpl.title}（N-of-1 提案）：主结局=真实保留率；臂 ${armText}；${tpl.unit === 'batch' ? '按学习日轮臂（批次交替）' : '卡级随机分臂'}；合格卡池 ${pool} 张；最短观察窗每臂 ${NOF1_PER_ARM_MIN} 次真实推进。确认后开跑。`
    const doc = {
      template: tpl.id, variable: tpl.variable, title: tpl.title, question: tpl.question,
      outcome: tpl.outcome, arms: tpl.arms, arm_labels: tpl.arm_labels, unit: tpl.unit,
      scope_course: course ?? null, per_arm_min: NOF1_PER_ARM_MIN, pool,
    }
    const scope = course ?? '全部课程'
    const pid = await this.store.createProposal('experiment', scope, summary, '')
    const path = this.paths.proposalArtifactPath(pid, 'experiment', scope)
    await mkdir(this.paths.proposalDir, { recursive: true })
    await writeFile(path, YAML.stringify(doc), 'utf8')
    await this.store.updateProposal(pid, { artifact: path })
    return { proposal: pid, template: tpl.id, title: tpl.title, pool, scope_course: course ?? null }
  }

  /** 确认开跑（提案 apply）：重新校验产物 → 生成实验定义与分臂（batch 起始日=今天；
   * card 播种自提案 id 的确定性均分）→ 写 state/实验.json。提案产物失效 fail loud。 */
  async experimentApply(pid?: number): Promise<{ id: number; title: string; arm_today: string }> {
    const prop = await this.store.takePending('experiment', pid)
    if (await this.nof1Active()) {
      throw new Error(`[nof1-apply] 已有实验在跑——v1 一次一个，先 stop 再开。`)
    }
    let doc: {
      template?: string; variable?: string; title?: string; question?: string
      outcome?: string; arms?: string[]; arm_labels?: Record<string, string>
      unit?: string; scope_course?: string | null; per_arm_min?: number
    }
    try {
      doc = YAML.parse(await readFile(prop.artifact, 'utf8')) as typeof doc
    } catch (err) {
      throw new Error(`[nof1-apply] 提案产物无法解析（${prop.artifact}）：${err instanceof Error ? err.message : String(err)}`)
    }
    const tpl = doc.template ? nof1Template(doc.template) : null
    if (!tpl || tpl.variable !== doc.variable || !NOF1_VARIABLE_WHITELIST.includes(doc.variable as Nof1Variable)
      || (doc.outcome !== 'true_retention' && doc.outcome !== 'practice_ema')
      || doc.unit !== tpl.unit
      || !Array.isArray(doc.arms) || doc.arms.length !== 2 || doc.arms[0] !== tpl.arms[0] || doc.arms[1] !== tpl.arms[1]
      || !doc.title) {
      throw new Error(`[nof1-apply] 提案产物与模板不一致或白名单校验失败（template=${String(doc.template)} variable=${String(doc.variable)}）。`)
    }
    const { today } = await this.learningDay()
    const list = await this.store.loadExperiments()
    const def: ExperimentDef = {
      id: list.reduce((m, e) => Math.max(m, e.id), 0) + 1,
      template: tpl.id, variable: tpl.variable, title: doc.title,
      question: doc.question ?? tpl.question,
      outcome: doc.outcome,
      arms: [doc.arms[0]!, doc.arms[1]!], arm_labels: doc.arm_labels ?? tpl.arm_labels,
      unit: tpl.unit, scope_course: doc.scope_course ?? null,
      assignment: tpl.unit === 'card'
        ? { kind: 'card', map: shuffleAssign(await this.nof1PoolKeys(doc.scope_course ?? null), doc.arms, mulberry32(1000 + prop.id)) }
        : { kind: 'batch', start_day: today, order: [doc.arms[0]!, doc.arms[1]!] },
      per_arm_min: doc.per_arm_min ?? NOF1_PER_ARM_MIN,
      started_day: today, started_ts: nowIso(), status: 'running', proposal: prop.id,
    }
    list.push(def)
    await this.store.saveExperiments(list)
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date().toISOString(),
      decision_note: `实验 #${def.id} 开跑（今日臂 ${nof1ArmForDay(def, today)}）`,
    })
    return { id: def.id, title: def.title, arm_today: nof1ArmForDay(def, today) }
  }

  /** 手动停（ADR-0023：实验开停手动）。停后不再标注、报告定稿。 */
  async experimentStop(id?: number): Promise<ExperimentDef> {
    const list = await this.store.loadExperiments()
    const hit = id !== undefined ? list.find(e => e.id === id) : list.find(e => e.status === 'running')
    if (!hit) throw new Error(`[nof1-stop] 没有可停的实验${id !== undefined ? `（实验 #${id} 不存在）` : ''}。`)
    if (hit.status !== 'running') throw new Error(`[nof1-stop] 实验 #${hit.id} 已是 ${hit.status}。`)
    const { today } = await this.learningDay()
    hit.status = 'stopped'
    hit.stopped_day = today
    await this.store.saveExperiments(list)
    return hit
  }

  /** 直白话报告（臂间比较+置换检验+效应量区间；ADR-0023 裁决 3）。未达最短观察窗
   * 只报进度不做效应判断；running = 期中读数，stopped = 定稿。练习侧结局（EMA）
   * 的证据通道已上线（#88/#89），登记在案但 v1 分析器只支持调度侧二元结局。 */
  async experimentReport(id?: number): Promise<{ experiment: ExperimentDef; analysis: Nof1Analysis }> {
    const list = await this.store.loadExperiments()
    const hit = id !== undefined
      ? list.find(e => e.id === id)
      : list.find(e => e.status === 'running') ?? list[list.length - 1]
    if (!hit) throw new Error('[nof1-report] 还没有实验——先从模板库发起（learnhub_experiment_propose）。')
    if (hit.outcome !== 'true_retention') {
      return {
        experiment: hit,
        analysis: {
          ready: false, per_arm: [], need_per_arm: hit.per_arm_min,
          diff: null, ci95: null, p: null,
          message: '该实验预登记了练习侧结局（EMA）：证据通道已上线（回执/执行事件），EMA 分析器与练习侧模板登记待后票落地；臂标注已在积累。',
        },
      }
    }
    const recs = nof1Outcomes(await this.store.reviewLogAll(), hit.id)
    const analysis = analyzeNof1(recs, hit, 9000 + hit.id)
    return { experiment: hit, analysis }
  }

  // ---- U4 周复盘 Weekly Kata（#114 / ADR-0026：Learner Output，零 XP 零 canonical）----

  /** 周复盘记录定位（<输出区>/周复盘/<周一>.md）。 */
  private kataPath(weekStart: string): string {
    return `${this.paths.outputKindDir('周复盘')}/${weekStart}.md`
  }

  /** 读复盘记录 → frontmatter + 五问各问（读侧收口，三个写点共用）。 */
  private async kataReadDoc(path: string): Promise<{ fm: Record<string, unknown>; sections: Record<KataQuestion, string> }> {
    const { fm, body } = await loadNote(path)
    return { fm, sections: parseKataBody(body) }
  }

  /** 落盘复盘记录 + 刷新已注册源指纹（写侧收口：引擎自己的写不算漂移）。 */
  private async kataPersist(
    path: string, weekStart: string, reality: string,
    sections: Record<KataQuestion, string>, created: string,
  ): Promise<void> {
    await this.kataWriteDoc(path, weekStart, weekEndOf(weekStart)!, reality, sections, created)
    await this.refreshSourceFingerprints([path])
  }

  /** 打开/发起周复盘：复盘对象 = 上一完整学习周（可显式指定更早的完整周补记）。
   * 打开即沉淀结算点（#139）：校准画像/速度韧性周档出生即写、档案投影重建（同周幂等）。
   * 罗盘每周挂载沙盘 ETA（#143：挂周复盘；标记周幂等，单课失败不挡复盘）。
   * 现状 = 引擎用该学习周真实数据现算重填（引擎段）；四问保留学习者已写内容。
   * 文件缺失即建（入口常驻、无推送、缺勤不罚）。weekStart 必须是周一且不晚于
   * 上一完整周——复盘只向后看，不预填未来。零 XP、零 canonical 写入。 */
  async kataOpen(weekStart?: string): Promise<KataDoc> {
    const { today, cutoff } = await this.learningDay()
    // 沉淀结算随周复盘走（#139）：开复盘 = 上一完整学习周的一次结算点——校准画像/
    // 速度韧性周档出生即写、学习者档案投影重建（同周幂等，重复打开不重写）
    await this.sedimentSettle()
    const target = kataMonday(weekStart ?? prevWeekStartOf(today) ?? '')
    const prev = prevWeekStartOf(today)!
    if (target > prev) {
      throw new Error(`[kata] 复盘对象是已完整结束的学习周：${prev} 起的那一周是最近的完整周。`)
    }
    // 罗盘每周挂载（#143）：ETA 段每周一刷（标记周判重），透明度装置失败不挡复盘
    await this.compassEtaRefresh(undefined, { today }).catch(() => undefined)
    const weekEnd = weekEndOf(target)!
    const reality = renderKataReality(await this.kataRealityFor(target, weekEnd, cutoff))
    const path = this.kataPath(target)
    let sections: Record<KataQuestion, string>
    let created: boolean
    if (existsSync(path)) {
      const { fm, sections: existing } = await this.kataReadDoc(path)
      existing['现状'] = reality // 引擎段随开随新；四问原样保留
      sections = existing
      created = false
      await this.kataPersist(path, target, reality, sections, String(fm.created ?? today))
    } else {
      sections = parseKataBody(assembleKataDoc({ weekStart: target, weekEnd, created: today, reality, answers: {} }))
      created = true
      await this.kataPersist(path, target, reality, sections, today)
    }
    return {
      date: today, week_start: target, week_end: weekEnd, path, created,
      reality, sections, answered: kataAnswered(sections),
      list: await this.kataList(),
    }
  }

  /** 保存四问作答（patch 语义：给出的键才写；值 trim 后空 = 退回占位）。「现状」是
   * 引擎段，不接受学习者改写——要改数据事实，去补做学习行为。 */
  async kataSave(weekStart: string, answers: Partial<Record<KataAnswer, string>>): Promise<KataDoc> {
    const { today } = await this.learningDay()
    const target = kataMonday(weekStart)
    const path = this.kataPath(target)
    if (!existsSync(path)) {
      throw new Error(`[kata] 该周还没有复盘记录（${path}）——先 learnhub_kata_open 发起。`)
    }
    const sections = (await this.kataReadDoc(path)).sections
    const reality = sections['现状']
    for (const q of KATA_LEARNER_QUESTIONS) {
      if (answers[q] === undefined) continue
      sections[q] = answers[q]!.trim() || KATA_EMPTY
    }
    await this.kataPersist(path, target, reality, sections, today)
    return {
      date: today, week_start: target, week_end: weekEndOf(target)!, path, created: false,
      reality, sections, answered: kataAnswered(sections), list: await this.kataList(),
    }
  }

  /** 「下一实验」一键转 N-of-1 实验提案（ADR-0023 的自然入口）：走 experimentPropose
   * 提案-确认制（确认仍要显式 apply）；提案号留痕写回复盘记录。 */
  async kataToExperiment(weekStart: string, templateId: string, course?: string): Promise<{ proposal: number; title: string; week_start: string }> {
    const target = kataMonday(weekStart)
    const path = this.kataPath(target)
    if (!existsSync(path)) throw new Error('[kata] 该周还没有复盘记录——先 learnhub_kata_open 发起。')
    const prop = await this.experimentPropose(templateId, course)
    await this.stampKata(path, target, `- 已转 N-of-1 实验提案 #${prop.proposal}（${prop.title}）——确认开跑走实验 apply 通道。`)
    return { proposal: prop.proposal, title: prop.title, week_start: target }
  }

  /** 「下一实验」一键转执行意图挂今日目标偏好（C-5 既有机制）：pin 节点为今日榜首
   * 并挂 if-then 意图（随 pin 当日过期）；留痕写回复盘记录。零 XP 零 canonical。 */
  async kataToIntention(
    weekStart: string, input: { course: string; node: string; cue: string; action: string },
  ): Promise<{ course: string; node: string; week_start: string }> {
    const target = kataMonday(weekStart)
    const path = this.kataPath(target)
    if (!existsSync(path)) throw new Error('[kata] 该周还没有复盘记录——先 learnhub_kata_open 发起。')
    await this.pinToday(input.course, input.node, undefined, { cue: input.cue, action: input.action })
    await this.stampKata(path, target, `- 已挂今日执行意图（${input.node}：「${input.cue.trim()}」之后 ${input.action.trim()}）。`)
    return { course: input.course, node: input.node, week_start: target }
  }

  /** 已有复盘清单（周一起排序；answered 现读现判——入口常驻的清单面）。 */
  async kataList(): Promise<Array<{ week_start: string; answered: boolean }>> {
    const dir = this.paths.outputKindDir('周复盘')
    if (!existsSync(dir)) return []
    const out: Array<{ week_start: string; answered: boolean }> = []
    for (const f of (await readdir(dir)).filter(f => f.endsWith('.md')).sort()) {
      try {
        const { body } = await loadNote(`${dir}/${f}`)
        const sections = parseKataBody(body)
        const fmWeek = /^#\s*周复盘\s+(\d{4}-\d{2}-\d{2})/.exec(body)?.[1]
        out.push({ week_start: fmWeek ?? f.replace(/\.md$/, ''), answered: kataAnswered(sections) })
      } catch {
        // 坏记录不阻塞清单（它是文档不是契约文件）；open 单独打开时会 fail loud
      }
    }
    return out
  }

  /** 上一学习周的真实数据聚合（现状引擎段的原料；全部只读）。 */
  private async kataRealityFor(weekStart: string, weekEnd: string, cutoff: number) {
    const [practice, journal, reviewLog, habitRepeats] = await Promise.all([
      this.store.practiceAll(),
      this.store.journalTail(null, Number.MAX_SAFE_INTEGER),
      this.store.reviewLogAll(),
      this.store.habitRepeatsAll(),
    ])
    const projects = (await this.projects.list()).filter(p => p.lifecycle === 'active')
    const projectExec: Record<string, ProjectExecRec[]> = {}
    for (const p of projects) projectExec[p.id] = await execRecsAll(this.paths, p.id)
    const noteSources: Record<string, { path: string; title?: string }> = {}
    for (const s of (await this.noteManifest.load()).sources) {
      noteSources[s.id] = { path: s.path, ...(s.title ? { title: s.title } : {}) }
    }
    const habitNames: Record<string, string> = {}
    for (const h of (await this.habits.list()).habits) habitNames[h.habit] = h.name
    const skillNames: Record<string, string> = {}
    for (const s of (await this.skills.list()).skills) skillNames[s.skill] = s.name
    return buildKataReality({
      weekStart, weekEnd, cutoffMin: cutoff,
      practice, journal, reviewLog, habitRepeats, projects, projectExec, noteSources, habitNames, skillNames,
    })
  }

  /** 落盘一份五问记录（我的产出/周复盘/<周一>.md；created/updated 出处戳用日历日）。 */
  private async kataWriteDoc(
    path: string, weekStart: string, weekEnd: string,
    reality: string, sections: Record<KataQuestion, string>, created: string,
  ): Promise<void> {
    const body = assembleKataDoc({ weekStart, weekEnd, created, reality, answers: sections })
    await writeOutputArtifact(this.paths, {
      kind: '周复盘', file: `${weekStart}.md`,
      fm: { kind: KATA_KIND, week_start: weekStart, week_end: weekEnd, created, updated: todayStr() },
      body,
    })
  }

  /** 「下一实验」出口留痕：目标小节追加一行转换记录（其余内容不动）。 */
  private async stampKata(path: string, weekStart: string, line: string): Promise<void> {
    const { fm, sections } = await this.kataReadDoc(path)
    const reality = sections['现状']
    sections['下一实验'] = `${sections['下一实验'].trim()}\n\n${line}`.trim()
    await this.kataPersist(path, weekStart, reality, sections, String(fm.created ?? todayStr()))
  }

  // ---- D2 挑战点恒温器（#111 / ADR-0024：跨区观测聚合 + 只读建议，非自动控制器）----

  /** A1 目标难度带默认值（state/learnhub.json 的 band_default；null = 纯 A1 自动）。
   * 消费链：会话显式选带 > 实验当日臂 > 此默认值 > 纯 A1。 */
  async bandDefault(): Promise<BandPref | null> {
    const doc = await readLearnhubConfig(this.paths.learnhubConfigPath) as {
      band_default?: string
    }
    return ['easy', 'standard', 'hard'].includes(doc.band_default ?? '')
      ? doc.band_default as BandPref : null
  }

  /** 写默认带（既有配置入口——恒温器建议显式确认后落到这里；null = 清除回纯 A1）。 */
  async setBandDefault(band: string | null): Promise<{ band_default: BandPref | null }> {
    if (band !== null && !['easy', 'standard', 'hard'].includes(band)) {
      throw new Error(`[band-default] band 只能是 easy/standard/hard 或 null（收到 ${String(band)}）。`)
    }
    const prev = await readLearnhubConfig(this.paths.learnhubConfigPath)
    const next = { ...prev, band_default: band }
    if (band === null) delete next.band_default
    await writeLearnhubConfig(this.paths.learnhubConfigPath, next)
    return { band_default: band as BandPref | null }
  }

  /** 跨区挑战点仪表（只读聚合，零新度量；ADR-0024）。 */
  async thermostatView(today?: string): Promise<ThermostatDoc> {
    const { today: learningToday, cutoff } = await this.learningDay()
    today ??= learningToday
    const logs = await this.store.reviewLogAll()
    const retention = trueRetention(dueReviewFirstPushes(logs, cutoff))
    const bands = bandDistribution(await this.store.bandRecsAll(), today)
    const defaultBand = await this.bandDefault()
    const suggestions = thermostatSuggestions({
      retention: { rate: retention.rate, real: retention.real },
      bands, defaultBand,
    })
    const projects = await this.projects.list()
    return {
      date: today,
      course_region: {
        retention,
        retention_band: retentionBand(retention.rate),
        band_choices: bands,
      },
      unbounded_region: {
        execution_ratings: execRatingDistribution(logs, today),
        note: '执行事件评级分布——数据源随 U 区执行事件通道（#89）落地；落地前为合法空态。',
      },
      project_region: {
        status: 'deferred',
        note: '项目区观测（Mastery 交叉 2×2 + 档内表现）随 P-7（#96）后补，不阻塞 v1；下表只聚合展示各项目当前渐退档。',
        projects: projects.map(p => ({ id: p.id, name: p.name, tier: p.tier })),
      },
      knobs: [
        { knob: 'band_default', title: 'A1 目标难度带默认值', status: '可确认生效（既有配置入口）', current: defaultBand },
        { knob: 'retrieval_density', title: '检索点密度', status: '未上线（随 #93 检索点会话落地解锁）' },
        { knob: 'fading_tier', title: '渐退档移动提议', status: '聚合展示：档位移动走项目域显式入口（projectSetTier），v1 无待决移动提议对象，此处只汇总各项目当前档', current: projects.map(p => `${p.name}:${p.tier}`).join('、') || null },
      ],
      suggestions,
    }
  }

  /** 建议的显式确认入口（ADR-0024：建议采用走既有入口、逐条显式确认）。只受理
   * 当前仪表正在给出的建议 id——陈旧/伪造 id 拒绝；引擎内无任何自动调用路径。 */
  async thermostatApply(suggestionId: string): Promise<{ applied: string; band_default: BandPref | null }> {
    const view = await this.thermostatView()
    const hit = view.suggestions.find(s => s.id === suggestionId)
    if (!hit) {
      throw new Error(`[thermostat] 建议「${suggestionId}」不在当前建议清单里（可能已过期或从未给出）——恒温器只逐条确认当前建议，不受理任意参数写入。`)
    }
    await this.setBandDefault(hit.apply.value)
    return { applied: hit.id, band_default: hit.apply.value }
  }

  // ---- D3 沙盘（#112 / ADR-0025：现有模型的蒙特卡洛计划推演，只读、零写侧）----

  /** 按计划推演：现有 FSRS 的 R 作伯努利抽样推进 + mastery 派生原样复用，
   * SANDBOX_RUNS 次蒙特卡洛。输出分布（50/80% 分位带）；措辞锁「模型推演，
   * 非承诺」。零写侧——不进门禁、不进调度、不改账本，不给可行性判定。 */
  async sandboxRun(input: {
    minutesPerDay: number
    weeks?: number
    course?: string
    nodes?: string[]
  }): Promise<SandboxDoc> {
    if (!Number.isFinite(input.minutesPerDay) || input.minutesPerDay <= 0) {
      throw new Error(`[sandbox] minutesPerDay 必须是正数（收到 ${String(input.minutesPerDay)}）。`)
    }
    const weeks = Math.min(26, Math.max(1, Math.round(input.weeks ?? SANDBOX_DEFAULT_WEEKS)))
    const plan: SandboxPlan = { minutesPerDay: Math.round(input.minutesPerDay), weeks }
    const { today } = await this.learningDay()
    const courses = input.course ? [await this.registry.resolve(input.course)] : await this.enabledCourses()
    const nodeFilter = input.nodes?.length ? new Set(input.nodes) : null
    const { cards, nodes, scheds } = await this.sandboxPopulation(courses, nodeFilter)
    // 蒙特卡洛：播种确定（同输入同分布）；每门课注入自己的调度器实例（与调度同源，
    // R 参数跟课走——与 reviewQueue/memoryHealth 同一 sched 通道）。
    const runs = this.mcRuns(plan, cards, nodes, today, scheds, courses[0]!.name)
    const { curve, map } = aggregateRuns(runs, nodes.map(n => `${n.course}/${n.node}`), weeks)
    return {
      wording: SANDBOX_WORDING,
      date: today,
      plan,
      runs: SANDBOX_RUNS,
      scope: { courses: courses.map(c => c.name), nodes: nodes.length },
      curve,
      map,
      assumptions: [
        `每次复习计 1 分钟；每日预算 ${plan.minutesPerDay} 分钟，耗尽后剩余到期卡顺延（与真实欠账一致）。`,
        '复习通过率 = 当前 FSRS 模型的可提取性 R 伯努利抽样：过记 Good、败记 Again；推进与调度同一套函数（各课程用自己的调度器参数）。',
        '新节点按课程图序在预算内引入（est 分钟摊日），学成记一次合成 Good；休眠题随学成入场。',
        '练习证据（EMA/正确率）冻结为当前值——沙盘只模拟「记」的维持，不模拟「练」的进步。',
      ],
    }
  }

  /** 沙盘推演的总体采集（sandboxRun 与罗盘 ETA 挂载共用，#143）：模拟卡 + 模拟节点
   * + 各课调度器实例。skipped（学习者自报已会）不进推演范围；未开始节点带 null 代表
   * 卡随引入学成创建；题库缺失 = 合法空态。 */  private async sandboxPopulation(
    courses: CourseEntry[], nodeFilter: Set<string> | null,
  ): Promise<{
    cards: SandboxCard[]
    nodes: SandboxNode[]
    scheds: Map<string, FSRS>
  }> {
    const cards: SandboxCard[] = []
    const nodes: SandboxNode[] = []
    const scheds = new Map<string, FSRS>()
    for (const c of courses) {
      scheds.set(c.name, await this.sched(this.paths.courseRoot(c.root)))
      const { graph, state } = await this.loadView(c)
      for (const name of graph.order) {
        if (nodeFilter && !nodeFilter.has(name)) continue
        const fm = state[name]
        // skipped = 学习者自报已会：不在推演范围（与推荐口径一致）
        if (effectiveStage(state, name) === 'skipped') continue
        const started = Boolean(fm?.fsrs?.reps)
        nodes.push({
          course: c.name, node: name,
          est: graph.estOf[name] ?? 15,
          practice: fm?.practice ?? { attempts: 0, correct: 0 },
          ema: fm?.practice_ema,
          started, skipped: false,
        })
        // 节点代表卡（有起点状态带 fs；未开始 = null，随引入学成创建）
        cards.push({
          key: `node:${c.name}/${name}`, course: c.name, node: name, kind: 'node',
          fs: started ? fm!.fsrs! : null,
        })
        try {
          const bank = await this.bank.load(this.paths.courseRoot(c.root), name)
          for (const q of bank.questions) {
            if (q.archived) continue
            cards.push({ key: `${c.name}/${name}/${q.id}`, course: c.name, node: name, kind: 'question', fs: q.fsrs ?? null })
          }
        } catch {
          // 该节点还没有题库：合法空态（practice 节点常态）
        }
      }
    }
    return { cards, nodes, scheds }
  }

  /** 蒙特卡洛循环（sandboxRun 与罗盘 ETA 挂载共用，#143）：SANDBOX_RUNS 次、播种
   * 约定 7000+i·7919（同输入同分布）；无该课调度器时回退 fallbackCourse 的实例。 */
  private mcRuns(
    plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string,
    scheds: Map<string, FSRS>, fallbackCourse: string,
  ): Array<{ endByNode: number[]; curve: number[] }> {
    const runs: Array<{ endByNode: number[]; curve: number[] }> = []
    for (let i = 0; i < SANDBOX_RUNS; i++) {
      runs.push(simulateRun(plan, cards, nodes, today, {
        schedFor: course => scheds.get(course) ?? scheds.get(fallbackCourse)!,
        rng: mulberry32(7000 + i * 7919),
      }))
    }
    return runs
  }

  // ---- 罗盘（#143 / ADR-0033 透明度装置：常驻非承诺路线草图）----

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
    const c = await this.registry.resolve(courseKey)
    const path = this.paths.compassPath(c.root)
    const anchor = await readAnchor(this.paths.anchorPath(c.root))
    if (!existsSync(path)) {
      return {
        course: c.name, path,
        endpoint: anchor?.endpoint ?? null, goal_type: anchor?.goal_type ?? null,
        missing: true, route: null, annotations: null, eta: null, eta_week: null,
      }
    }
    const doc = parseCompass(await readFile(path, 'utf8'))
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
   * 金样本回放闸：调用数恒 1、无修复轮（首过率对照在测试锚定）。 */
  async compassPaint(courseKey: string | undefined, llm: LlmComplete): Promise<{
    course: string; path: string; route_lines: number; annotations_preserved: boolean; repainted: boolean
  }> {
    const c = await this.registry.resolve(courseKey)
    const root = c.root
    const anchor = await readAnchor(this.paths.anchorPath(root))
    if (!anchor) {
      throw new Error(`[compass] 课程「${c.name}」未播种（终点锚 Missing）——罗盘初画锚在终点上，先走种子提案（kind=seed）。`)
    }
    const { graph } = await this.loadView(c)
    const path = this.paths.compassPath(root)
    const existing = existsSync(path) ? await readFile(path, 'utf8') : null
    const doc = existing ? parseCompass(existing) : null
    const annotations = hasLearnerAnnotations(doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null)
      ? sectionBody(doc!, SECTION_ANNOTATIONS)
      : null
    const template = await this.content.loadPrompt('罗盘初画')
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
    const raw = await llm(prompt, undefined, { effort: 'deep' })
    const body = stripWrappingFence(raw)
    const errors = validateRouteBody(body)
    if (errors.length) {
      throw new Error(`[compass] 初画产物未过路线门（原样落盘会破坏罗盘结构），罗盘未改动：\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const next = withSectionText(
      withSectionText(existing ?? compassScaffold(c.name), SECTION_ROUTE, body),
      SECTION_ETA, ETA_PENDING,
    )
    await atomicWrite(path, next)
    // repainted = 罗盘上曾有已画路线（占位/缺席不算）；重写不覆盖的语义由段级合并保证
    const priorRoute = doc ? sectionBody(doc, SECTION_ROUTE)?.trim() ?? '' : ''
    const routeLines = body.split('\n').filter(l => l.trim()).length
    await this.store.appendJournal({
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
   * 与图 apply 同事务、journal 由调用方挂提案 id，此处零 journal）：批注区与 ETA 字节
   * 保留；学习者手编的路线在下一次重写处被覆盖——手编不产生权威变更。路线门同初画。 */
  async compassRewrite(
    courseKey: string, routeMd: string,
  ): Promise<{ course: string; path: string; route_lines: number }> {
    const c = await this.registry.resolve(courseKey)
    const anchor = await readAnchor(this.paths.anchorPath(c.root))
    if (!anchor) {
      throw new Error(`[compass] 课程「${c.name}」未播种（终点锚 Missing）——罗盘重写锚在终点上，先走种子提案（kind=seed）。`)
    }
    const body = stripWrappingFence(routeMd)
    const errors = validateRouteBody(body)
    if (errors.length) {
      throw new Error(`[compass] 重写产物未过路线门，罗盘未改动：\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const path = this.paths.compassPath(c.root)
    const base = existsSync(path) ? await readFile(path, 'utf8') : compassScaffold(c.name)
    await atomicWrite(path, withSectionText(base, SECTION_ROUTE, body))
    return { course: c.name, path, route_lines: body.split('\n').filter(l => l.trim()).length }
  }

  /** 罗盘每周挂载沙盘 ETA（挂周复盘——kataOpen 触发；标记周幂等，force 可重算）：
   * 逐启用课程——未播种跳过、罗盘缺席先落脚手架、当前周已挂 current、否则探测带
   * 折叠后重写「沙盘 ETA」段（措辞锁死「模型推演，非承诺」）。透明度装置：单课失败
   * 不挡其他课，更不挡周复盘。 */
  async compassEtaRefresh(
    courseKey?: string, opts: { today?: string; force?: boolean } = {},
  ): Promise<Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string }>> {
    const { today: learningToday } = await this.learningDay()
    const today = opts.today ?? learningToday
    const weekStart = weekStartOf(today)
    if (!weekStart) throw new Error(`[compass] today 不是合法日期：${String(today)}`)
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const out: Array<{ course: string; state: 'refreshed' | 'current' | 'skipped'; detail?: string }> = []
    for (const c of courses) {
      try {
        const anchor = await readAnchor(this.paths.anchorPath(c.root))
        if (!anchor) {
          out.push({ course: c.name, state: 'skipped', detail: '未播种（终点锚 Missing）' })
          continue
        }
        const path = this.paths.compassPath(c.root)
        const existing = existsSync(path) ? await readFile(path, 'utf8') : compassScaffold(c.name)
        if (!opts.force && etaMarkerOf(sectionBody(parseCompass(existing), SECTION_ETA)) === weekStart) {
          out.push({ course: c.name, state: 'current' })
          continue
        }
        const eta = await this.compassEtaFold(c, anchor, today, weekStart)
        await atomicWrite(path, withSectionText(existing, SECTION_ETA, renderEtaBody(eta)))
        out.push({ course: c.name, state: 'refreshed' })
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
    const minutesPerDay = await readDailyGoal(this.paths)
    const { cards, nodes, scheds } = await this.sandboxPopulation([c], null)
    const endpointKey = `${c.name}/${anchor.endpoint}`
    const probes: CompassEtaProbe[] = []
    let p50Week: CompassEta['p50_week'] = null
    let p80Week: CompassEta['p80_week'] = null
    for (const weeks of COMPASS_ETA_PROBE_WEEKS) {
      const plan: SandboxPlan = { minutesPerDay, weeks }
      const runs = this.mcRuns(plan, cards, nodes, today, scheds, c.name)
      const { map } = aggregateRuns(runs, nodes.map(n => `${n.course}/${n.node}`), weeks)
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

  // ---- 教练回合感知面（#144 / ADR-0033 滚动教练：触发三点 × 就绪深度 × 六区块上下文包）----

  /** 就绪前沿：未开始（非 opt 前置全部达成）的节点——R 软闸不改变可学性，故不带门。 */
  private coachFrontier(graph: Graph, state: Record<string, Fm>): string[] {
    return readySet(graph, state, () => 1)
  }

  /** 单课程就绪深度检查（coachCheckpoint 与 statusJson 共用核）：终点锚缺失 = 未播种
   * （不判冷启动，合法空态）；锚 Broken fail loud（与 courseCompletion 同口径）。
   * 就绪存量与前瞻需求都不计终点（词条「前瞻深度」：终点是锚点不是课程节点）——
   * 课程尾段前沿只剩终点时判据永不可满足会让教练永不停摆；除终点外前沿清空 =
   * exhausted，判据自然通过、零告警。 */
  private async coachCheckFor(c: CourseEntry, today: string): Promise<CoachCheck> {
    const { graph, state } = await this.loadView(c)
    const anchor = await readAnchor(this.paths.anchorPath(c.root))
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
    const entries = await this.concepts.load(c.root)
    const map = new Map<string, string>()
    await this.scanCourseBanks(c, async (_node, bank) => {
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
    const { today: learningToday } = await this.learningDay()
    const today = opts.today ?? learningToday
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
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
    courseKey?: string, opts: { lightweight?: boolean; today?: string } = {},
  ): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state } = await this.loadView(c)
    const { today: learningToday, cutoff } = await this.learningDay()
    const today = opts.today ?? learningToday
    const lightweight = opts.lightweight === true
    const anchor = await readAnchor(this.paths.anchorPath(c.root))
    const active = [...this.coachFrontier(graph, state), ...graph.names.filter(n => effectiveStage(state, n) === 'learning')]

    const out: string[] = [
      `# 教练回合上下文包：${c.name}（${lightweight ? '轻量段——只带行为摘要与罗盘' : '全量六区块'}）`,
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
    const entries = await this.concepts.load(c.root)
    const invokesOfQ = await this.invokesResolver(c)
    const masteryOf: Record<string, number> = {}
    for (const n of graph.names) masteryOf[n] = masteryOfFm(state[n])
    const digest = behaviorDigest({
      course: c.name,
      practice: netPracticeRecs(await this.store.practiceAll(), await this.store.erratumAll()),
      reviews: await this.store.reviewLogAll(),
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
      parts.push('', '### 沉淀折叠', '', renderSedimentForCoach(await this.sedimentFold()))
    }
    block('罗盘尾段', parts.join('\n'))

    if (!lightweight) {
      // ⑥ V-2 接缝（先验上下文注入——预留占位，Out of Scope：宿主检索面依赖）
      block('V-2 接缝（先验上下文注入——预留）',
        '（v1 未接线：vault 链接先验注入教练回合依赖宿主检索面——本区块为六区块定序占位，接线后由此注入。）')
    }

    return out.join('\n') + '\n'
  }

  // ---- 生长批受理（#145 / ADR-0033 滚动教练：教练回合裁决 → edit 提案 → 同事务罗盘）----

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
      const shown = rest.slice(0, LearnhubEngine.GROWTH_GRAPH_NAMES_CAP)
      lines.push('', `### 其余节点（全部名单，供 pre 引用；共 ${rest.length} 个）`, '',
        shown.join('、') + (rest.length > shown.length ? `……（超出预览上限 ${LearnhubEngine.GROWTH_GRAPH_NAMES_CAP}，余 ${rest.length - shown.length} 个）` : ''))
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

  /** 生长批受理（#145 裁决产物面）：两段式教练回合——轻量段（fast 档：行为摘要+罗盘
   * +图面）先裁；note.disagreement 声明真分歧时升级全量段（deep 档：六区块包+图面）重裁并
   * 以全量段结论为准（显然步免仲裁税，升级路径随 segments 可观测）。最终裁决照 kind=edit
   * 既有受理门（schema/结构/概念对表/锚保护/巩固门）propose→apply：罗盘重写与图 apply
   * 同事务（提案被拒罗盘不落盘）、journal 挂提案 id、不新增提案 kind。
   * 停机转译：就绪深度满足（check.ok）时不拉回合直接停摆——判据满足的自然结果，不是
   * 新状态（force 供测试/手动排障越过）。opts.inject = 里程碑计划修订的换线/补支注入
   * （#149 项目消费拉动的生长请求）：注入块随包进回合，且注入本身是显式的重新裁决
   * 请求——check.ok 不再短路停摆（裁决仍可能产出零操作批）。金样本回放闸锚调用数
   * 基线：显然步恒 1 次调用、分歧升级恒 2 次。 */
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
    const c = await this.registry.resolve(courseKey)
    const anchor = await readAnchor(this.paths.anchorPath(c.root))
    if (!anchor) {
      throw new Error(`[coach-growth] 课程「${c.name}」未播种（终点锚 Missing）——教练回合锚在终点上，先走种子提案（kind=seed）。`)
    }
    const today = opts.today ?? (await this.learningDay()).today
    const check = await this.coachCheckFor(c, today)
    if (check.ok && !opts.force && opts.inject === undefined) {
      return { course: c.name, state: 'idle', check, segments: [], proposal: null, applied: null }
    }
    const { graph, state } = await this.loadView(c)
    const view = this.growthGraphView(graph, state)
    const template = await this.content.loadPrompt('教练回合')
    const segments: CoachGrowthSegment[] = []
    const runSegment = async (tier: 'light' | 'full'): Promise<{ spec: EditProposalSpec; yaml: string; note: GrowthNote }> => {
      const pack = await this.coachContextPack(c.name, { lightweight: tier === 'light', today })
      const prompt = `${template.trimEnd()}\n\n---\n\n${pack.trimEnd()}`
        + (opts.inject !== undefined ? `\n\n---\n\n## 里程碑计划修订注入（项目消费拉动的生长请求）\n\n${opts.inject.trimEnd()}\n\n换线 = 激活图上已有节点（内容生成/接入路线），补支 = 朝新里程碑长最小必要分支；你的裁决仍走五算子与既定纪律，判断注入与就绪深度后照常产出（含零操作批）。` : '')
        + `\n\n---\n\n${view.trimEnd()}\n`
      const raw = await llm(prompt, undefined, { effort: tier === 'light' ? 'fast' : 'deep' })
      const verdict = this.parseGrowthVerdict(raw)
      segments.push({ tier, effort: tier === 'light' ? 'fast' : 'deep', operator: verdict.note.operator, disagreement: Boolean(verdict.note.disagreement) })
      return verdict
    }

    let final = await runSegment('light')
    if (final.note.disagreement) final = await runSegment('full')

    const prop = await this.graphPropose('edit', final.yaml) as GraphEditProposalResult
    let applied: GraphApplyEditResult
    try {
      applied = await this.graphApply('edit', prop.id) as GraphApplyEditResult
    } catch (err) {
      // 受理过门但 apply 失败（审计 ERROR/图已变化等竞态）：机器裁决不留 pending——
      // 自清后原样抛错（教练回合是每步重算的函数，下一触发重新裁决即可）
      await this.graphReject(prop.id, `生长批自动 apply 失败：${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined)
      throw err
    }
    // 内容链补给（宿主消费）：本批新建节点中「前置已达成且正文未生成」者即就绪缺口——
    // 宿主据此入队正文生成（生长-内容交替，FIFO 不插队）。
    const created = final.spec.ops.filter(o => o.op === 'add_node').map(o => o.name!)
    let readyUnbuilt: string[] = []
    if (created.length) {
      const after = await this.loadView(c)
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

  // ---- 边实验账本与复诊（#146 / 插入提案生命周期：预注册→登记→到期结算→proven｜自动剪除）----

  /** 生长闸门（注入 GraphProposals 的回调，propose/apply 双门消费）：只对生长批的
   * 插入/旁支生效——三率超限或复诊通过率触底时闸停（低数据静默），普通 edit 提案与
   * 结算自动提案（无 note）恒放行。插入积极性调速器，参数唯一出处 params.ts。 */
  private async growthGateErrors(spec: EditProposalSpec): Promise<string[]> {
    if (!spec.note || (spec.note.operator !== '插入' && spec.note.operator !== '旁支')) return []
    const adds = addNodeCountOf(spec.ops)
    if (!adds) return []
    const c = await this.registry.get(spec.course)
    if (!c) return []
    const { today, cutoff } = await this.learningDay()
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
    const fold = foldProbation(await readProbationLedger(this.paths, c.root))
    const practice = netPracticeRecs(await this.store.practiceAll(), await this.store.erratumAll())
    const reviews = await this.store.reviewLogAll()
    const learningDays = learningDaysOf(practice, reviews, c.name, cutoff, today)
    const proposals = await this.store.loadProposals()
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
        const doc = YAML.parse(await readFile(this.paths.proposalArtifactPath(p.id, 'edit', p.course), 'utf8')) as {
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
  private async probationViewFor(c: CourseEntry, today: string, cutoff: number): Promise<ProbationCourseView> {
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
    const { today, cutoff } = await this.learningDay()
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const out: Array<{ course: string } & ProbationCourseView> = []
    for (const c of courses) out.push({ course: c.name, ...(await this.probationViewFor(c, today, cutoff)) })
    return { date: today, courses: out }
  }

  /** probation 在途行使闸（#146）：实验中的插入节点——行使只记流不回流练习证据
   * （EMA/计数不动，proven 后恢复；普通前进/旁支节点不受闸）。questionAnswer/
   * questionForget/interactiveSettle/项目回流四处消费。 */
  private async exerciseGated(c: CourseEntry, node: string): Promise<boolean> {
    const fold = foldProbation(await readProbationLedger(this.paths, c.root))
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
    const { today: learningToday, cutoff } = await this.learningDay()
    const today = opts.today ?? learningToday
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const out: Array<{ course: string; settled: Array<{ node: string; outcome: ProbationOutcome; metric?: RecheckMetric; detail?: string; proposal?: number }>; skipped: Array<{ node: string; reason: string }> }> = []
    for (const c of courses) {
      const settled: Array<{ node: string; outcome: ProbationOutcome; metric?: RecheckMetric; detail?: string; proposal?: number }> = []
      const skipped: Array<{ node: string; reason: string }> = []
      const frame = await this.probationFrame(c, today, cutoff)
      if (frame.inFlightWithDay.length) {
        const proposals = await this.store.loadProposals()
        const { graph } = await this.loadView(c)
        const invokesOf = await this.invokesResolver(c)
        const practice = netPracticeRecs(await this.store.practiceAll(), await this.store.erratumAll())
        const reviews = await this.store.reviewLogAll()
        for (const { entry, day } of frame.inFlightWithDay) {
          if (!day) {
            skipped.push({ node: entry.node, reason: `提案 #${entry.proposal} 缺失或未决——登记日无从判定，到期检查挂起` })
            continue
          }
          const due = recheckDue(frame.learningDays, day, entry.due)
          if (!due.due) {
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
          const decidedAt = nowIso()
          await appendProbationEntry(this.paths, c.root, {
            ...entry, outcome, decided_at: decidedAt,
          })
          await this.recordRecheckOutcome(c, { ...entry, outcome, decided_at: decidedAt }, {
            metric, detail, settlePid, graph, coarsePre,
          })
          settled.push({ node: entry.node, outcome, metric, detail, ...(settlePid ? { proposal: settlePid } : {}) })
        }
      }
      if (settled.length) await this.sedimentRebuildProfile()
      out.push({ course: c.name, settled, skipped })
    }
    return { date: today, courses: out }
  }

  /** 从提案 artifact 回读预注册 metric（账本只存 proposal id 的对账；缺失返回 null）。 */
  private async recheckMetricOf(c: CourseEntry, proposals: ProposalRec[], entry: ProbationEntry): Promise<RecheckMetric | null> {
    const rec = proposals.find(p => p.id === entry.proposal)
    if (!rec) return null
    try {
      const doc = YAML.parse(await readFile(this.paths.proposalArtifactPath(entry.proposal, 'edit', rec.course), 'utf8')) as {
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
      const prop = await this.graphPropose('edit', yaml) as { id: number }
      try {
        await this.graphApply('edit', prop.id)
        return prop.id
      } catch (err) {
        await this.graphReject(prop.id, `复诊剪除 apply 失败：${err instanceof Error ? err.message : String(err)}`)
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
    const entries = await this.concepts.load(c.root)
    const canonicalOf = (name: string): string => resolveConcept(entries, name)?.canonical ?? name
    const payload: Record<string, unknown> = {
      course: c.name, node: entry.node, outcome: entry.outcome,
      metric: ctx.metric, detail: ctx.detail, proposal: entry.proposal,
      period_days: entry.due,
      ...(ctx.settlePid ? { settlement_proposal: ctx.settlePid } : {}),
    }
    if (taught.length) {
      for (const concept of taught) {
        await appendSedimentEvent(this.paths, {
          kind: 'recheck_outcome', tier: 'immediate', concept: canonicalOf(concept), payload: { ...payload },
        })
      }
    } else {
      await appendSedimentEvent(this.paths, { kind: 'recheck_outcome', tier: 'immediate', payload })
    }
    if (entry.outcome === '剪除' && ctx.settlePid) {
      await appendSedimentEvent(this.paths, {
        kind: 'graph_repair', tier: 'immediate',
        payload: {
          ...payload,
          action: 'recheck_prune',
          restored: (graph.succ[entry.node] ?? []).map(consumer => `${consumer} ← ${ctx.coarsePre.join('、')}`),
          concepts: taught.map(canonicalOf),
        },
      })
    }
    await this.store.appendJournal({
      course: c.name, node: entry.node, rating: null, kind: 'probation_settle', elapsed_days: 0,
      session: String(entry.proposal),
      detail: `复诊${entry.outcome === 'proven' ? '达标（proven）' : '未达标（剪除）'}｜${ctx.metric}：${ctx.detail}`
        + (ctx.settlePid ? `；剪除提案 #${ctx.settlePid}` : ''),
    })
  }

  /** JOL 预测值的显式契约：三档之外拒绝（参数错误），null/undefined 放行为无预测。 */
  private jolPredicted(p: JolPrediction | null | undefined): JolPrediction | null {
    if (p === null || p === undefined) return null
    if (!JOL_PREDICTIONS.includes(p)) {
      throw new Error(`[jol] 预测只能是「${JOL_PREDICTIONS.join('」「')}」之一（收到 ${String(p)}）。`)
    }
    return p
  }

  // ---- Self-Calibration 自评校准画像（ADR-0022 #104；分源自省面 + 显式呈现层提示）----

  /** 自评校准画像：分源切片（主视图）+ 全局参考视图（带域特异警戒）。
   * practice 流水配对的只读派生——零落盘、零 canonical 写入（ADR-0022 红线）；
   * 与 memory.ts 的 FSRS 自校准（calibrationBins，模型体检）正交，永不混入。 */
  async calibrationProfile(): Promise<CalibrationProfileDoc> {
    return calibrationProfileView(await this.store.practiceAll())
  }

  /** 读显式过信提示开关（state/learnhub.json 的 calibration.hints 字段；缺省开——
   * 「可全局关」）。关闭后复习队列不带轻提示、抽查密度不再加强（JOL 抽查本身
   * 仍由 jol.enabled 独立控制）。 */
  async calibrationHintsConfig(): Promise<{ hints_enabled: boolean }> {
    const doc = await readLearnhubConfig(this.paths.learnhubConfigPath) as {
      calibration?: { hints_enabled?: boolean }
    }
    return { hints_enabled: doc.calibration?.hints_enabled !== false }
  }

  /** 写显式过信提示开关（原子替换，保留配置文件其他字段；照 jolConfig 先例）。 */
  async setCalibrationHints(hints_enabled: boolean): Promise<{ hints_enabled: boolean }> {
    const prev = await readLearnhubConfig(this.paths.learnhubConfigPath)
    await writeLearnhubConfig(this.paths.learnhubConfigPath,
      { ...prev, calibration: { hints_enabled } })
    return { hints_enabled }
  }

  // ---- D4 睡眠耦合建议配置（state/learnhub.json 的 sleep 字段；#85，默认开）----

  /** 读睡眠耦合建议配置：enabled=false 时推荐里不再出现「睡前练、醒后验」建议层。 */
  async sleepAdviceConfig(): Promise<{ enabled: boolean }> {
    const doc = await readLearnhubConfig(this.paths.learnhubConfigPath) as {
      sleep?: { enabled?: boolean }
    }
    return normalizeSleepAdvice(doc.sleep)
  }

  /** 写睡眠耦合建议配置（原子替换，保留配置文件其他字段）。 */
  async setSleepAdviceConfig(patch: { enabled?: boolean }): Promise<{ enabled: boolean }> {
    const prev = await readLearnhubConfig(this.paths.learnhubConfigPath)
    const next = await this.sleepAdviceConfig().then(cur => ({ enabled: patch.enabled ?? cur.enabled }))
    await writeLearnhubConfig(this.paths.learnhubConfigPath, { ...prev, sleep: next })
    return next
  }

  // ---- E5 可用的困难教练（#65；只读信息性反馈，无门禁无判分）----

  /** 难度带会话记录（会话结束反馈点调用，ReviewSession 收尾时带上当次带选择与
   * 作答结算）：append-only 落 state/难度带.jsonl。零调度副作用——只是教练的
   * 长期选择分布数据源（Learner Output）。 */
  async logBandSession(rec: { course: string; node: string; band: BandPref; answered: number; correct: number }, today?: string): Promise<BandRec> {
    today ??= (await this.learningDay()).today
    if (!['easy', 'standard', 'hard'].includes(rec.band)) {
      throw new Error(`[band] band 只能是 easy/standard/hard（收到 ${String(rec.band)}）。`)
    }
    const full: BandRec = { date: today, ...rec }
    await this.store.appendBandRec(full)
    return full
  }

  /** 教练反馈（低打扰）：7 天窗口内按选择分布与带内表现生成温和提示（0–2 条），
   * 到期难题数 = 全部启用课程中 due ≤ today、R ≥ COACH_DUE_HARD_R（按状态该会）
   * 且合用难度 ≥ COACH_HARD_D（难）的到期题。无触发返回空数组；低数据静默。 */
  async coachAdvice(today?: string): Promise<{ messages: string[]; due_hard: number }> {
    today ??= (await this.learningDay()).today
    const courses = await this.enabledCourses()
    let dueHard = 0
    for (const c of courses) {
      const sched = await this.sched(this.paths.courseRoot(c.root))
      await this.scanCourseBanks(c, async (_node, bank) => {
        for (const q of bank.questions) {
          if (q.archived || !q.fsrs?.reps || !q.fsrs.due || q.fsrs.due > today) continue
          if (retrievabilityBlock(sched, q.fsrs, today) < COACH_DUE_HARD_R) continue
          if (combinedDifficulty(q.difficulty, q.fsrs) < COACH_HARD_D) continue
          dueHard++
        }
      })
    }
    const recs = (await this.store.bandRecsAll()).filter(r => withinCoachWindow(r.date, today))
    return { messages: coachFeedback(recs, dueHard, today), due_hard: dueHard }
  }

  // ---- E2「讲给我听」（#68 / ADR-0009 Learner Output：判词只入 E 档案，零 XP）----

  /** 讲解会话的正文要点（s1–s3 型）：lessonSections 切分（练习/反馈排除），
   * 封顶 8 节防包体失控（讲解包是会话 system，不是全文导出）。 */
  private async explainPoints(c: CourseEntry, graph: Graph, node: string): Promise<ExplainPoint[]> {
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
    return Sessions.lessonSections(body).slice(0, 8)
  }

  /** 讲解会话包：{正文要点 + 图位置 + 初学者人设指令}——面板「讲给我听」会话的
   * system / 宿主会话的首条消息（同 Arc D 上下文包通道）。自愿入口：本方法只读，
   * 会话存续与否、何时收尾全由学习者掌握。 */
  async explainBackPack(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[explain-back] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'explain-back')
    const sections = await this.explainPoints(c, graph, node)
    return explainBackPack(c.name, node, sections, graph.preOf[node], graph.succ[node] ?? [])
  }

  /** 定位反馈回合：对照该节点要点给 对/错/部分对 + 定位标签（含糊/跳跃/说错）+
   * 「可怎么补」。判词解析失败时抛错（零副作用，不入档案）；成功只写 E 档案
   * （appendEArchive）——不产生 XP、不写 canonical 任何字段（#33 三不进）。 */
  async explainBackFeedback(
    courseKey: string | undefined, node: string, transcript: string,
    llm: LlmComplete,
  ): Promise<EArchiveRec & { reply: string }> {
    if (!transcript.trim()) throw new Error('[explain-feedback] 讲解对话记录为空，无从反馈。')
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[explain-feedback] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'explain-feedback')
    const sections = await this.explainPoints(c, graph, node)
    const raw = await llm(explainFeedbackPrompt(sections, transcript), explainFeedbackSystem())
    const v = parseExplainVerdict(raw)
    const rec = await this.store.appendEArchive({
      course: c.name, node, kind: 'explain_back',
      verdict: v.verdict, tags: [...v.tags] as ExplainTag[],
      ...(v.advice ? { advice: v.advice } : {}),
      excerpt: transcript.trim().slice(-800),
    })
    return { ...rec, reply: v.reply }
  }

  /** 把一版讲解存档为 E1 自注卡（#68 存档目标）：卡面两档——再讲一遍（recall_cue，
   * 默认）与挖空重述（cloze_rewrite，content 须带 {{…}} 挖空）。入「我的卡」独立域
   * （复习呈现已并入复习队列、复习走无绑定 XP，ADR-0021）；判词与卡都属 Learner
   * Output，创建零 XP、节点调度面零写入。 */
  async explainArchiveCard(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: 'recall_cue' | 'cloze_rewrite'; prompt?: string; section?: string },
  ): Promise<{ course: string; node: string; id: string; kind: LearnerCard['kind']; count: number }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[explain-archive] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'explain-archive')
    const kind = opts.kind ?? 'recall_cue'
    if (kind !== 'recall_cue' && kind !== 'cloze_rewrite') {
      throw new Error(`[explain-archive] 讲解存档卡面只能是 recall_cue（再讲一遍）/ cloze_rewrite（挖空重述）之一（收到 ${String(kind)}）。`)
    }
    const content = opts.content?.trim()
    if (!content) throw new Error('[explain-archive] 讲稿内容为空，无可存档。')
    const sectionTitle = opts.section
      ? state[node]?.content.sections?.find(s => s.id === opts.section)?.title ?? opts.section
      : undefined
    const prompt = opts.prompt?.trim()
      || (kind === 'cloze_rewrite'
        ? `补全你自己的讲法：${sectionTitle ?? node}`
        : `再讲一遍：用你的话讲清「${sectionTitle ?? node}」`)
    const r = await this.learnerCards.addCard(c.root, node, {
      kind, prompt, content, ...(sectionTitle ? { source_section: sectionTitle } : {}),
    })
    return { course: c.name, node, id: r.id, kind, count: r.count }
  }

  // ---- E1「我的卡」复习（#45 schema / #68 存档目标；#70 落节级入口与管理面）----

  /** 「我的卡」全量清单（管理面 / agent 清点用）：到期卡按 due 升序在前，从未调度的
   * 新卡随后。复习呈现已并入 reviewQueue（ADR-0021）——本清单不再承担复习入口，
   * 只做全量盘点（队列只出到期+新卡，这里还能看到未到期卡）。 */
  async learnerQueue(courseKey?: string, today?: string): Promise<LearnerQueueDoc> {
    today ??= (await this.learningDay()).today
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const cards: Array<Record<string, unknown>> = []
    for (const c of courses) {
      const dir = this.paths.learnerCardsDir(c.root)
      let files: string[] = []
      try {
        files = await readdir(dir)
      } catch {
        continue // 该课程还没有任何我的卡：合法空态
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const node = f.replace(/\.yaml$/, '')
        let doc: LearnerCardDoc
        try {
          doc = await this.learnerCards.load(c.root, node)
        } catch {
          continue // Broken 卡组不阻塞 E 池其他卡（data-check 体检面报出）
        }
        for (const card of doc.cards) {
          if (card.archived) continue
          cards.push(this.learnerCardView(c.name, node, card))
        }
      }
    }
    const due = cards.filter(c => c.due !== null && String(c.due) <= today)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || String(a.id).localeCompare(String(b.id)))
    const fresh = cards.filter(c => c.due === null)
      .sort((a, b) => String(a.node).localeCompare(String(b.node)) || String(a.id).localeCompare(String(b.id)))
    return { date: today, total: cards.length, due_count: due.length, cards: [...due, ...fresh] }
  }

  /** E 卡的作答视图：正面 = prompt（提示重述/挖空/自注主题），背面 = content（学习者
   * 自己的话）。content 随卡带出但 UI 在翻面前不展示——泄露面是学习者自己，且无判分。 */
  private learnerCardView(course: string, node: string, card: LearnerCard): Record<string, unknown> {
    return {
      course, node, id: card.id, kind: card.kind,
      prompt: card.prompt, content: card.content,
      source_section: card.source_section ?? null,
      due: card.fsrs?.reps ? card.fsrs.due : null,
      attempts: card.stats?.attempts ?? 0,
    }
  }

  private async learnerCardContext(courseKey: string | undefined, node: string, cardId: string, op: string): Promise<{
    c: CourseEntry; card: LearnerCard
  }> {
    const c = await this.registry.resolve(courseKey)
    const doc = await this.learnerCards.load(c.root, node)
    const card = doc.cards.find(x => x.id === cardId)
    if (!card) throw new Error(`[${op}] 「${node}」的我的卡没有 ${cardId}。`)
    return { c, card }
  }

  /** E 卡自评结算（2/3/4）：新卡在此首推，老卡按档推进；一卡一学习日一次推进
   * （stats.last 把守）。复习呈现已并入复习队列（ADR-0021）：入账走无绑定 XP
   * （与题卡同公式、权重 1，难度取卡自身 FSRS difficulty、未调度取中性 5）；
   * 复习日志/practice/节点调度面零写入（ADR-0021 裁决 2）。 */
  async learnerCardRate(
    courseKey: string | undefined, node: string, cardId: string, rating: number,
  ): Promise<LearnerRateResult> {
    const r = Math.round(rating)
    if (r < 2 || r > 4) throw new Error(`[learner-rate] 自评档位只能是 2/3/4（收到 ${String(rating)}）；忘记走 learner-forget。`)
    const { c, card } = await this.learnerCardContext(courseKey, node, cardId, 'learner-rate')
    const { today } = await this.learningDay()
    // ADR-0014 advanceStrict：守门即原 stats.last 检查（一卡一天一次），文案是测试契约
    const pushed = advanceStrict(await this.sched(null), card, r, today,
      `[learner-rate] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    await this.learnerCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats: pushed.stats })
    const diff = card.fsrs?.difficulty && card.fsrs.difficulty > 0 ? card.fsrs.difficulty : FSRS_DIFFICULTY_MID
    const settle = xpForAnswer(card.kind, diff, true, null, true)
    await this.store.appendJournal({
      course: '*', node: '*', rating: r, kind: 'xp_learner', elapsed_days: 0,
      xp: settle.xp, detail: `我的卡 ${c.name}/${node}#${cardId}（self ${r}）`,
    })
    return { course: c.name, node, id: cardId, rating: r, due: pushed.fs.due, scheduled: true, xp: settle.xp }
  }

  /** E 卡忘记申报（rating=1）：不作答直接翻面，一卡一学习日一次；0 XP 无绑定行，
   * 节点调度面零写入。 */
  async learnerCardForget(
    courseKey: string | undefined, node: string, cardId: string,
  ): Promise<LearnerForgetResult> {
    const { c, card } = await this.learnerCardContext(courseKey, node, cardId, 'learner-forget')
    const { today } = await this.learningDay()
    const pushed = advanceStrict(await this.sched(null), card, 1, today,
      `[learner-forget] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    await this.learnerCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats: pushed.stats })
    await this.store.appendJournal({
      course: '*', node: '*', rating: 1, kind: 'xp_learner', elapsed_days: 0,
      xp: 0, detail: `我的卡 ${c.name}/${node}#${cardId}（forget）`,
    })
    return { course: c.name, node, id: cardId, rating: 1, due: pushed.fs.due, scheduled: true, xp: 0 }
  }

  /** E1「加我的理解」节级入口（#70）：学习者用自己的话写一句解释/例子/助记
   * （锚点 = 节 id/标题），AI 对照该节已教要点给 是非 + 定位（含糊/跳跃/说错）
   * + 可怎么补——判词入 E 档案（kind=self_note），产出成独立域 LearnerCard。
   * ADR-0009/0021 边界：创建零 XP、不写掌握度/节点调度面；卡汇入复习队列、
   * 复习走无绑定 XP。AI 判词不可解析时抛错，卡与判词零落盘（ADR-0004 事务性）。 */
  async learnerNoteAdd(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: LearnerCard['kind']; prompt?: string; section?: string },
    llm: LlmComplete,
  ): Promise<{
    course: string; node: string
    card: { id: string; kind: LearnerCard['kind']; count: number }
    verdict: EArchiveRec; reply: string
  }> {
    const content = opts.content?.trim()
    if (!content) throw new Error('[understanding] 自注内容为空——「加我的理解」存的是学习者自己的话。')
    const kind = opts.kind ?? 'recall_cue'
    if (!LEARNER_CARD_KINDS.includes(kind)) {
      throw new Error(`[understanding] 卡面只能是 ${LEARNER_CARD_KINDS.join('/')}（收到 ${String(opts.kind)}）。`)
    }
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[understanding] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'understanding')
    // 对照面 = 节锚点（清单 id/标题 → 该节正文）；锚点给了但该节还没有正文时，
    // 对照面为空并随反馈明示——不静默退化为全节要点（锚点语义必须可预期）
    const sections = await this.explainPoints(c, graph, node)
    let sectionTitle: string | undefined
    if (opts.section?.trim()) {
      const raw = opts.section.trim()
      sectionTitle = state[node]?.content.sections?.find(s => s.id === raw || s.title === raw)?.title ?? raw
    }
    const points = sectionTitle ? sections.filter(s => s.title === sectionTitle) : sections
    // 机械反馈调用恒走 fast 档（#137：档位沿缝声明，宿主适配器翻译成部署思考档）
    const raw = await llm(selfNoteFeedbackPrompt(points, sectionTitle, content), selfNoteFeedbackSystem(), { effort: 'fast' })
    const v = parseExplainVerdict(raw) // 不可解析抛错 → 卡与判词零落盘
    const card = await this.learnerCards.addCard(c.root, node, {
      kind,
      prompt: opts.prompt?.trim() || selfNotePromptOf(kind, sectionTitle ?? node),
      content,
      ...(sectionTitle ? { source_section: sectionTitle } : {}),
    })
    const verdict = await this.store.appendEArchive({
      course: c.name, node, kind: 'self_note',
      verdict: v.verdict, tags: [...v.tags] as ExplainTag[],
      ...(v.advice ? { advice: v.advice } : {}),
      excerpt: content.slice(-800),
    })
    return { course: c.name, node, card: { id: card.id, kind, count: card.count }, verdict, reply: v.reply }
  }

  /** 归档/恢复一张我的卡（管理面）：E 池内部动作，canonical 零写入。 */
  async learnerCardArchive(
    courseKey: string | undefined, node: string, cardId: string, archived: boolean,
  ): Promise<LearnerArchiveResult> {
    const c = await this.registry.resolve(courseKey)
    await this.learnerCards.archiveCard(c.root, node, cardId, archived)
    return { course: c.name, node, id: cardId, archived }
  }

  // ---- C-3 错误对比卡（#82：错误库→对比案例卡）----

  /** 挖矿预览（只读）：当前流水中的高频错误模式候选（同一题 ≥MIN_ERROR_LAPSES 次
   * 实质答错；忘记申报不是错法证据）。人工抽查入口——生成走 errorCardGenerate，
   * 本方法零写入。 */
  async errorCardMine(courseKey: string | undefined, node?: string): Promise<ErrorMineDoc> {
    const c = await this.registry.resolve(courseKey)
    const candidates = mineErrorPatterns(await this.store.practiceAll(),
      { course: c.name, ...(node ? { node } : {}) })
    return { course: c.name, candidates }
  }

  /** 在册错误卡全展开（(course, node, card) 三元组，文件名序稳定）：空目录 = 合法
   * 空态、Broken 卡组跳过不阻塞（体检面报出）。复习队列、全量清单、生成去重三处同缝。 */
  private async *errorCardTriples(
    courses: ReadonlyArray<{ name: string; root: string }>, nodeFilter?: string,
  ): AsyncGenerator<{ course: string; node: string; card: ErrorCard }> {
    for (const c of courses) {
      let files: string[] = []
      try {
        files = await readdir(this.paths.errorCardsDir(c.root))
      } catch {
        continue // 该课程还没有任何错误卡：合法空态
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const node = f.replace(/\.yaml$/, '')
        if (nodeFilter !== undefined && node !== nodeFilter) continue
        try {
          const doc = await this.errorCards.load(c.root, node)
          for (const card of doc.cards) {
            if (!card.archived) yield { course: c.name, node, card }
          }
        } catch {
          continue // Broken 卡组不阻塞其他卡（data-check 体检面报出）
        }
      }
    }
  }

  /** 全课程活跃错误卡已覆盖的 (node,qid) 集合（生成去重；Broken 文件跳过不阻塞）。 */
  private async errorCardCovered(course: { name: string; root: string }): Promise<Set<string>> {
    const covered = new Set<string>()
    for await (const { node, card } of this.errorCardTriples([course])) {
      covered.add(`${node}\n${card.source_q}`)
    }
    return covered
  }

  /** 生成错误对比卡（C-3）：挖矿 → 取前 ERROR_CARD_BATCH_MAX 个未覆盖候选 →
   * 原题材料（题干/答案/解析/学习者错答/节正文节选）喂「错误对比卡」提示词 →
   * 模型 YAML 过 schema 门禁（含 (node,source_q) 必须命中候选）逐节点落盘。
   * 归 learner-cards 同款事务性：模型产出不可解析/未过门禁时抛错零落盘。
   * 创建零 XP、零 canonical 写入——卡入错误 deck，复习时才走无绑定 XP。 */
  async errorCardGenerate(
    courseKey: string | undefined, opts: { node?: string; max?: number } | undefined,
    llm: LlmComplete,
  ): Promise<ErrorGenerateResult> {
    const c = await this.registry.resolve(courseKey)
    const candidates = mineErrorPatterns(await this.store.practiceAll(),
      { course: c.name, ...(opts?.node ? { node: opts.node } : {}) })
    const covered = await this.errorCardCovered(c)
    const fresh = candidates.filter(x => !covered.has(`${x.node}\n${x.qid}`))
    if (!fresh.length) {
      throw new Error('[error-card-generate] 没有可挖的新错误模式（判定线：同一题 ≥2 次实质答错且尚未建卡）；候选已被覆盖或证据不足。')
    }
    // max 只是下调旋钮（批上限硬帽 ERROR_CARD_BATCH_MAX 防注水；工具面宣称的 cap 在此强制）
    const max = Math.max(1, Math.min(opts?.max ?? ERROR_CARD_BATCH_MAX, ERROR_CARD_BATCH_MAX, fresh.length))
    // 图视图加载一次（fail loud——图 Broken 不能被静默读成先验缺席，Missing/Broken 两态
    // 不混同）；节误解先验（#147 出生期候选错法）取材于此，先验缺席仍合法。
    const { graph, state } = await this.loadView(c)
    const skipped: string[] = []
    interface Mat { node: string; qid: string; section: string | null; sectionBody: string | null }
    const mats: Array<Mat & { material: string }> = []
    for (const x of fresh.slice(0, max)) {
      let q: BankQuestion | undefined
      try {
        const bank = await this.bank.load(this.paths.courseRoot(c.root), x.node)
        q = bank.questions.find(q => q.id === x.qid && !q.archived)
      } catch {
        q = undefined
      }
      if (!q) {
        skipped.push(`${x.node}/${x.qid}（原题缺失或已归档，无法对照出卡）`)
        continue
      }
      // 节正文节选（答案对照面）：来源节命中该节正文，否则整课节选兜底（同 errorExplainPack 定位语义）
      let sectionTitle: string | null = null
      let sectionBody: string | null = null
      try {
        const manifest = state[x.node]?.content.sections
        const entry = sectionEntryOf(q.section, manifest)
        const sections = await this.explainPoints(c, graph, x.node)
        const hit = entry ? sections.find(s => s.title === entry.title) : null
        const point = hit ?? sections[0]
        if (point) {
          sectionTitle = entry?.title ?? point.title
          sectionBody = point.md.slice(0, 800)
        }
      } catch {
        // 正文缺失不阻塞生成：原题解析已足够对照
      }
      const wrongs = x.wrongs.map(w => `「${w}」`).join('、')
      const mis = graph.misconceptionsOf[x.node] ?? []
      mats.push({
        node: x.node, qid: x.qid, section: q.section ?? sectionTitle,
        sectionBody,
        material: [
          `### 候选：节点「${x.node}」 qid=${x.qid}（实质答错 ${x.lapses} 次）`,
          `- 题型：${q.kind}`,
          `- 原题题干：${q.q}`,
          ...(q.options?.length ? [`- 原题选项：${q.options.join(' | ')}`] : []),
          `- 原题正确答案：${typeof q.answer === 'boolean' ? (q.answer ? '对' : '错') : String(q.answer)}`,
          ...(q.explanation ? [`- 原题解析：${q.explanation}`] : []),
          `- 学习者的错答（去重，最近在前）：${wrongs}`,
          ...(mis.length ? [`- 误解先验（出生期候选错法；「干扰做法」项可从中改编，mine 仍以学习者错答为准）：${mis.map(m => `${m.concept}（${m.model}）`).join('；')}`] : []),
          ...(sectionBody ? [`- 来源节「${sectionTitle}」正文节选：${sectionBody}`] : []),
        ].join('\n'),
      })
    }
    if (!mats.length) {
      throw new Error(`[error-card-generate] 候选的原题全部缺失/归档，无法生成：${skipped.join('；')}`)
    }
    const tpl = await this.loadPrompt('错误对比卡')
    const prompt = `${tpl}\n\n## 挖出的错误模式（${mats.length} 个候选，每个候选出一张卡）\n\n${mats.map(m => m.material).join('\n\n')}`
    // 机械出卡调用恒走 fast 档（#137：档位沿缝声明，宿主适配器翻译成部署思考档）
    const raw = await llm(prompt, undefined, { effort: 'fast' })
    const doc = YAML.parseModel(raw) as { cards?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.cards) || !doc.cards.length) {
      throw new Error('[error-card-generate] 模型没有产出可用卡清单（cards 为空或不可解析），零落盘。')
    }
    const offered = new Set(mats.map(m => `${m.node}\n${m.qid}`))
    const byNode = new Map<string, Array<Record<string, unknown>>>()
    const errors: string[] = []
    const cardsRaw = doc.cards as Array<Record<string, unknown>>
    cardsRaw.forEach((e, i) => {
      const n = i + 1
      const node = typeof e.node === 'string' ? e.node.trim() : ''
      const qid = typeof e.source_q === 'string' ? e.source_q.trim() : ''
      if (!offered.has(`${node}\n${qid}`)) {
        errors.push(`cards.${n}: (node, source_q)=(${node || '空'}, ${qid || '空'}) 不在候选清单内（必须照抄系统给出的候选）`)
        return
      }
      const list = byNode.get(node) ?? []
      list.push({ ...e, kind: 'contrast', source_node: node, source_q: qid })
      byNode.set(node, list)
    })
    if (errors.length) {
      throw new Error(`[error-card-generate] 模型产出未过候选对照门，零落盘。\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const generated: Array<{ node: string; ids: string[]; count: number }> = []
    for (const [node, cards] of byNode) {
      const v = validateErrorCards({ node, cards })
      if (v.errors) {
        throw new Error(`[error-card-generate] 「${node}」的卡未过 schema 门禁，零落盘。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
      }
      const r = await this.errorCards.addCards(c.root, node,
        v.spec!.cards.map(({ kind: _kind, id: _id, source_node: _sn, archived: _a, fsrs: _f, stats: _st, ...rest }) => rest))
      generated.push({ node, ids: r.ids, count: r.count })
    }
    return { course: c.name, generated, ...(skipped.length ? { skipped } : {}) }
  }

  /** 错误卡作答结算（自动判分）：三选一答案唯一——选对=rating 3、选错=rating 1，
   * 一卡一学习日一次推进（stats.last 把守）。只推卡自身 FSRS（sched(null) 默认参数）；
   * 选对入无绑定 XP（xp_error 行，只计总账/目标/streak），选错 0 XP 同样留净行；
   * 复习日志/practice/节点调度面零写入。 */
  async errorCardAnswer(
    courseKey: string | undefined, node: string, cardId: string, choice: string,
  ): Promise<ErrorAnswerResult> {
    const pick = String(choice ?? '').trim()
    const c = await this.registry.resolve(courseKey)
    const doc = await this.errorCards.load(c.root, node)
    const card = doc.cards.find(x => x.id === cardId && !x.archived)
    if (!card) throw new Error(`[error-answer] 「${node}」的错误卡没有 ${cardId}（或已归档）。`)
    if (!card.options.includes(pick)) {
      throw new Error(`[error-answer] 所选选项不在本题三个选项内（收到「${pick.slice(0, 60)}」）。`)
    }
    const correct = pick === card.answer
    const rating = correct ? 3 : 1
    const { today } = await this.learningDay()
    // ADR-0014 advanceStrict：守门即原 stats.last 检查（一卡一天一次），文案是测试契约
    const pushed = advanceStrict(await this.sched(null), card, rating, today,
      `[error-answer] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    await this.errorCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats: pushed.stats })
    const diff = card.fsrs?.difficulty && card.fsrs.difficulty > 0 ? card.fsrs.difficulty : FSRS_DIFFICULTY_MID
    const xp = correct ? xpForAnswer(card.kind, diff, true, null, true).xp : 0
    await this.store.appendJournal({
      course: '*', node: '*', rating, kind: 'xp_error', elapsed_days: 0, xp,
      detail: `错误对比卡 ${c.name}/${node}#${cardId}（${correct ? 'correct 3' : 'wrong 1'}）`,
    })
    return {
      course: c.name, node, id: cardId, correct, rating,
      answer: card.answer, mine: card.mine, explanation: card.explanation,
      due: pushed.fs.due, scheduled: true, xp,
    }
  }

  /** 「错误卡」全量清单（管理面/agent 清点用）：到期卡按 due 升序在前，从未调度的
   * 新卡随后。复习呈现已并入 reviewQueue（C-3）——本清单只做全量盘点（含答案与
   * 错法标注，供人工抽查「错误模式合理」验收）。 */
  async errorCardQueue(courseKey?: string, today?: string): Promise<ErrorQueueDoc> {
    today ??= (await this.learningDay()).today
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const cards: ErrorCardItem[] = []
    for await (const { course, node, card } of this.errorCardTriples(courses)) {
      cards.push({
        course, node, id: card.id, q: card.q, options: card.options,
        answer: card.answer, mine: card.mine, explanation: card.explanation,
        source_q: card.source_q, source_section: card.source_section ?? null,
        due: card.fsrs?.reps ? card.fsrs.due : null,
        attempts: card.stats?.attempts ?? 0,
      })
    }
    const due = cards.filter(c => c.due !== null && String(c.due) <= today)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)) || `${a.node}/${a.id}`.localeCompare(`${b.node}/${b.id}`))
    const fresh = cards.filter(c => c.due === null)
      .sort((a, b) => `${a.node}/${a.id}`.localeCompare(`${b.node}/${b.id}`))
    return { date: today, total: cards.length, due_count: due.length, cards: [...due, ...fresh] }
  }

  /** 归档/恢复一张错误卡（管理面）：错误 deck 内部动作，canonical 零写入。 */
  async errorCardArchive(
    courseKey: string | undefined, node: string, cardId: string, archived: boolean,
  ): Promise<ErrorArchiveResult> {
    const c = await this.registry.resolve(courseKey)
    await this.errorCards.archiveCard(c.root, node, cardId, archived)
    return { course: c.name, node, id: cardId, archived }
  }

  // ---- U 区·技能条目与执行事件通道（#89 / ADR-0018 + ADR-0019）----

  /** 建技能条目（执行事件调度 lane 的载体）：与题目 FSRS 并行，不复用题目卡、
   * 不进复习队列、无 mastery。 */
  async skillCreate(name: string, opts?: { id?: string; maintenance_days?: number | null }): Promise<SkillDoc> {
    return this.skills.create({ name, ...opts })
  }

  /** 技能清单 + lane 生效到期（维持节拍帽已折算）：可排期视图——due ≤ 今日即到期，
   * due_kind 标明这次是习得（acquisition）还是维持复活（maintenance/迷你重做+回放）。 */
  async skillList(today?: string): Promise<SkillsListDoc> {
    today ??= (await this.learningDay()).today
    const { skills, broken } = await this.skills.list()
    return {
      date: today,
      skills: skills.map(s => {
        const due = laneDue(s.fsrs ?? null, s.maintenance_days)
        return {
          id: s.skill, name: s.name, status: s.status,
          maintenance_days: s.maintenance_days,
          due,
          /** 到期种类（仅在已到期时有意义；fresh = null 表示从未执行、无到期语义）。 */
          due_kind: due !== null && due <= today ? laneEventKind(s.fsrs ?? null, s.maintenance_days, today) : null,
          attempts: s.stats?.attempts ?? 0,
        }
      }),
      broken,
    }
  }

  /** 调维持节拍上限（天；null 关）。纯实体属性：不影响既有 FSRS 状态。 */
  async skillSetMaintenance(id: string, days: number | null): Promise<SkillDoc> {
    const doc = await this.skills.load(id)
    doc.maintenance_days = clampMaintenanceDays(days, 'skill-maintenance')
    await this.skills.save(id, doc)
    return doc
  }

  /** 归档/恢复技能条目（可逆）。archived 只是收纳标签：归档后拒绝再记执行事件。 */
  async skillArchive(id: string, archived: boolean): Promise<SkillDoc> {
    if (typeof archived !== 'boolean') throw new Error('[skill-archive] archived 必须显式给出（true 归档 / false 恢复）。')
    return this.skills.setStatus(id, archived ? 'archived' : 'active')
  }

  /** 执行事件落账（通道核心）：表现评级（1-4 整数 + 来源 auto/self/ai）推进技能条目
   * 的 lane（复用推进内核，一 lane 一学习日一次）；事件行进复习日志
   * （rating_source='execution' + event_kind 维持/习得区分，不复用题目卡）；
   * XP 按原生专注时长入账（journal kind='xp_execution'，1 XP ≈ 1 分钟，进 streak
   * 口径；时长来源 = 学习者申报，不设反作弊门，ADR-0019）。auto 来源必须携带可观测
   * 证据走确定性映射；self/ai 走显式评级。 */
  async executionLog(
    skillId: string,
    input: { source: ExecutionSource; minutes: number; rating?: number; evidence?: ExecutionEvidence; note?: string },
  ): Promise<ExecutionLogResult> {
    const doc = await this.skills.load(skillId)
    if (doc.status !== 'active') {
      throw new Error(`[execution-log] 技能「${skillId}」已归档——先 learnhub_skill_archive 恢复，再记执行事件。`)
    }
    const source = input.source
    if (!(source === 'auto' || source === 'self' || source === 'ai')) {
      throw new Error(`[execution-log] source 只能是 auto/self/ai（收到 ${String(source)}）。`)
    }
    let rating: 1 | 2 | 3 | 4
    if (source === 'auto') {
      if (!input.evidence) throw new Error("[execution-log] source='auto' 需要可观测证据（evidence.accuracy/self_help）——确定性映射是自动来源的唯一入口；无可观测判据时改用自评档（source='self' + rating）。")
      rating = ratingFromEvidence(input.evidence)
    } else {
      // 1-4 整数硬校验（ADR-0018 入口契约）：小数静默取整会让 FSRS 丢乘子，不收
      const r = input.rating
      if (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 4) {
        throw new Error(`[execution-log] ${source === 'self' ? '自评' : 'AI'} 评级必须是 1-4 的整数（收到 ${String(r)}）。`)
      }
      rating = r
    }
    const minutes = input.minutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error(`[execution-log] minutes 必须是 1–1440 的整数（本次专注分钟数，收到 ${String(minutes)}）。`)
    }
    const { today } = await this.learningDay()
    // 事件种类在推进前判定（帽/因判定读的是旧状态）
    const kind = laneEventKind(doc.fsrs ?? null, doc.maintenance_days, today)
    const pushed = advanceStrict(await this.sched(null), doc, rating, today,
      `[execution-log] 技能「${skillId}」今天已记过执行事件（一 lane 一学习日一次）。`)
    await this.skills.updateEvidence(skillId, { fsrs: pushed.fs, stats: pushed.stats })
    await this.store.appendReview({
      ...executionRowIdentity(doc.skill),
      rating, rating_source: 'execution', event_kind: kind, exec_source: source,
      elapsed_days: pushed.log.elapsed_days,
      stability_before: pushed.log.stability_before,
      difficulty_before: pushed.log.difficulty_before,
      r_pred: pushed.log.r_pred,
    })
    // XP：原生专注时长直入（1 XP ≈ 1 分钟），无绑定行进总账/每日目标/streak（ADR-0019）
    await this.store.appendJournal({
      course: '*', node: '*', rating, kind: 'xp_execution', elapsed_days: 0,
      xp: minutes, duration_s: minutes * 60,
      detail: executionXpDetail({ skill: doc.skill, source, kind, rating, minutes })
        + (input.note?.trim() ? `；${input.note.trim()}` : ''),
    })
    return {
      skill: doc.skill, rating, source, kind,
      due: laneDue(pushed.fs, doc.maintenance_days) ?? pushed.fs.due,
      xp: minutes, minutes, attempts: pushed.stats.attempts,
    }
  }

  // ---- U 区·回执反馈环（#88 / ADR-0016）----

  /** 回执提交全链：材料 → AI 量表评审（rubric = 实践节点内容要点）→ 评审分同权进
   * practice_ema；渐退反馈 per 主体（完整评审位置 = wantsFullReview 曲线，学习者可
   * force_full 越过）。零 XP、不推进任何 FSRS 卡；v1 只挂实践节点（type=practice）。 */
  async receiptSubmit(
    courseKey: string | undefined, node: string,
    input: { kind: ReceiptKind; material: string; force_full?: boolean },
    llm: LlmComplete,
  ): Promise<ReceiptSubmitResult> {
    const kind = input.kind
    if (!RECEIPT_KIND_LABEL[kind]) {
      throw new Error(`[receipt-submit] kind 只能是 ${Object.keys(RECEIPT_KIND_LABEL).join('/')}（收到 ${String(kind)}）；其它形态用 text 一句话描述（链接/路径写进 material）。`)
    }
    const material = input.material?.trim()
    if (!material) throw new Error('[receipt-submit] material 不能为空——回执是练习证据（描述/图片路径/导出/签核皆可）。')
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[receipt-submit] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'receipt-submit')
    if (graph.typeOf[node] !== 'practice') {
      throw new Error(`[receipt-submit] 「${node}」不是实践节点（type=practice）——v1 回执只挂实践节点（ADR-0016：机制按通用实践主体建模，项目/技能条目载体后续接入）。`)
    }
    const note = await this.nodeNote(c, graph, node)
    if (!note.fm) throw new Error('[receipt-submit] 节点笔记缺 frontmatter，无法入练习证据 EMA。')
    const points = await this.explainPoints(c, graph, node)
    const { today } = await this.learningDay()
    const result = await submitReceipt({
      store: this.store,
      course: c.name, node,
      kind, material,
      points,
      today,
      forceFull: input.force_full === true,
      fm: note.fm,
      saveFm: async fm => { await this.saveNodeNote(note.path, fm, note.body) },
      llm,
      template: await this.loadPrompt('回执评审'),
    })
    // 回执的项目工作区镜像（V-5 #113）：里程碑计划关联了本节点（nodes 命中节点名
    // 或「课程/节点」）的项目各得一份可读副本；canonical 流水仍是中心回执.jsonl，
    // 镜像只是「无界项目也有家」的文档面。零 XP/EMA 语义不受影响。
    const mirrored = await this.mirrorReceiptToProjects(c.name, node, result.receipt, material)
    return { ...result, ...(mirrored.length ? { mirrored_projects: mirrored } : {}) }
  }

  /** 关联节点回执 → 项目工作区可读副本（V-5 #113）：返回镜像到的项目 id 列表。 */
  private async mirrorReceiptToProjects(
    courseName: string, node: string, rec: ReceiptLogRec, material: string,
  ): Promise<string[]> {
    const specs = new Set([node, `${courseName}/${node}`])
    const out: string[] = []
    for (const p of await this.projects.list()) {
      if (!p.plan.some(m => (m.nodes ?? []).some(n => specs.has(n)))) continue
      const dir = this.paths.projectReceiptDir(p.id)
      await mkdir(dir, { recursive: true })
      const file = `${safeFilename(courseName)}-${safeFilename(node)}-${safeFilename(rec.id)}.md`
      const lines = [
        '---',
        `kind: receipt`,
        `subject: ${courseName}/${node}`,
        `receipt: ${rec.id}`,
        `day: ${rec.day}`,
        `score: ${rec.score}`,
        `review_mode: ${rec.review_mode}`,
        '---',
        '',
        '## 回执材料',
        '',
        material,
        '',
        '## 评审',
        '',
        rec.verdict,
      ]
      for (const e of rec.errors ?? []) {
        lines.push(`- **${e.point}**：${e.issue} → ${e.advice}`)
      }
      await writeFile(`${dir}/${file}`, lines.join('\n').trimEnd() + '\n', 'utf8')
      out.push(p.id)
    }
    return out
  }

  /** 回执历史 + 渐退计划状态（per 实践主体）。 */
  async receiptList(courseKey: string | undefined, node: string): Promise<{
    course: string; node: string
    receipts: ReceiptLogRec[]
    total: number
    next_full_in: number | null
  }> {
    const c = await this.registry.resolve(courseKey)
    const all = await this.store.receiptsAll()
    const receipts = all.filter(r => r.course === c.name && r.node === node)
    return {
      course: c.name, node, receipts,
      total: receipts.length,
      // 空态 = 1：首份回执即完整评审（与纯函数 receiptsUntilNextFull 同一口径）
      next_full_in: receiptsUntilNextFull(receipts.length),
    }
  }

  // ---- U 区·习惯一等公民（#90 / ADR-0017：零 FSRS 语义、零 canonical 写入）----

  /** 建习惯（执行意图 = 稳定线索 + 单一具体行动，格式锁死）。 */
  async habitCreate(input: { name: string; cue: string; action: string; id?: string }): Promise<HabitDoc> {
    return this.habits.create(input)
  }

  /** 习惯清单 + 派生面（累计重复 / 宽容 streak / 自动化曲线摘要）。曲线与 streak 只
   * 展示给学习者：这里返回的数字永不进 Mastery/XP/任何 canonical 度量。 */
  async habitList(today?: string): Promise<HabitsListDoc> {
    today ??= (await this.learningDay()).today
    const { habits, broken } = await this.habits.list()
    const repeats = await this.store.habitRepeatsAll()
    return {
      date: today,
      habits: habits.map(h => {
        const mine = repeats.filter(r => r.habit === h.habit)
        const curve = automationCurve(mine)
        return {
          id: h.habit, name: h.name, status: h.status,
          intention: h.intention,
          total_repeats: mine.length,
          streak: habitStreak([...new Set(mine.map(r => r.day))], today),
          latest_rating: curve.length ? curve[curve.length - 1].rating : null,
        }
      }),
      broken,
    }
  }

  /** 单个习惯详情：意图 + 完整自动化曲线（x=累计重复次数，y=自评 1-5）+ 近期重复。 */
  async habitShow(habitId: string, today?: string): Promise<HabitShowDoc> {
    today ??= (await this.learningDay()).today
    const doc = await this.habits.load(habitId)
    const mine = (await this.store.habitRepeatsAll()).filter(r => r.habit === habitId)
    return {
      ...doc,
      total_repeats: mine.length,
      streak: habitStreak([...new Set(mine.map(r => r.day))], today),
      curve: automationCurve(mine),
      recent: [...mine].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10),
    }
  }

  /** 自报一次重复（唯一入账来源；无门禁不防作弊）。可选携带自动化自评 1-5
   * （SRBAI 语义的事件级自评，不强制每次）。习惯域零 XP：不写 journal/practice。 */
  async habitRepeat(habitId: string, input: { auto_rating?: number; note?: string }): Promise<HabitRepeatRec> {
    const doc = await this.habits.load(habitId)
    const rating = input.auto_rating
    if (rating !== undefined && (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
      throw new Error(`[habit-repeat] auto_rating 必须是 1-5 的整数（自动化自评，收到 ${String(rating)}）；省略则只记重复。`)
    }
    const { today } = await this.learningDay()
    return this.store.appendHabitRepeat({
      ts: nowIso(),
      habit: doc.habit,
      day: today,
      ...(rating !== undefined ? { auto_rating: rating } : {}),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    })
  }

  /** 归档/恢复习惯（可逆；archived 只是收纳标签，无到期无截止）。 */
  async habitArchive(habitId: string, archived: boolean): Promise<HabitDoc> {
    if (typeof archived !== 'boolean') throw new Error('[habit-archive] archived 必须显式给出（true 归档 / false 恢复）。')
    return this.habits.setStatus(habitId, archived ? 'archived' : 'active')
  }

  // ---- FSRS 参数优化器（#62 A2 / ADR-0012）----

  /** 手动触发 FSRS-6 个人参数重训：数据 = 中心级跨课程复习日志的真实推进（排除
   * synthetic、每卡每天第一条）；门禁 = 真实条数 ≥400（官方口径）且训练后评估
   * （in-sample logLoss，新参/基线同协议对照）优于现参或默认参数，否则不写并返回
   * 跳过原因。参数是学习者级一套：正典写沉淀（fsrs_params 事件，出生即写）+ 每个
   * 启用课程的 fsrs参数.json 作缓存写回（#139 降级：删缓存不丢事实，getScheduler
   * 落沉淀折叠取回）。impl 接缝供测试注入假优化器。本优化即一次结算：写正典后
   * 重建学习者档案投影。 */
  async optimizeFsrsParams(
    impl: OptimizerImpl = bindingImpl,
  ): Promise<{
    status: 'written' | 'skipped'
    reason?: string
    written?: string[]
    meta?: Record<string, unknown>
  }> {
    const seqs = trainingSequences(await this.store.reviewLogAll(), await readDayCutoff(this.paths))
    const count = sequenceReviews(seqs)
    if (count < OPTIMIZE_MIN_REVIEWS) {
      return { status: 'skipped', reason: `真实复习日志 ${count} 条，不足 ${OPTIMIZE_MIN_REVIEWS} 条——保持现参不训练（synthetic 已排除，每卡每天只计第一条）` }
    }
    const courses = await this.enabledCourses()
    if (!courses.length) return { status: 'skipped', reason: '没有启用课程，参数无处写回' }
    // 基线 = 现参（学习者级一套），走 resolveFsrsParams 唯一口径：沉淀正典（事实源）
    // → 任一启用课程的参数缓存 → 官方默认。对照基线必须与调度此刻实际生效的同一套，
    // 不因基线读取阻塞训练。
    const baseline = await resolveFsrsParams(this.paths, courses.map(c => c.root))
    let baselineParams = baseline.parameters ?? defaultParams()
    const baselineSource = baseline.source
    const baselineEval = await impl.evaluate(baselineParams, seqs)
    const { parameters, splitEval } = await impl.train(seqs)
    if (parameters.length !== FSRS6_PARAM_COUNT) {
      return { status: 'skipped', reason: `训练产出 ${parameters.length} 个参数，不是 FSRS-6 的 ${FSRS6_PARAM_COUNT} 个——拒绝写回` }
    }
    const newEval = await impl.evaluate(parameters, seqs)
    const meta = {
      trained_at: todayStr(),
      params_version: 'FSRS-6',
      source: 'review-log',
      reviews: count,
      cards: seqs.length,
      baseline_source: baselineSource,
      baseline_log_loss: round4(baselineEval.logLoss),
      log_loss: round4(newEval.logLoss),
      rmse_bins: round4(newEval.rmseBins),
      split_log_loss: splitEval ? round4(splitEval.logLoss) : null,
      split_rmse_bins: splitEval ? round4(splitEval.rmseBins) : null,
    }
    if (!(newEval.logLoss < baselineEval.logLoss)) {
      const baselineLabel = baselineSource === 'default' ? '默认' : '现'
      return { status: 'skipped', reason: `评估未优于${baselineLabel}参数（logLoss ${round4(newEval.logLoss)} ≥ 基线 ${round4(baselineEval.logLoss)}）——不写回`, meta }
    }
    // 正典在沉淀（出生即写），课程文件只作缓存镜像；随后本结算重建学习者档案投影。
    await appendSedimentEvent(this.paths, { kind: 'fsrs_params', tier: 'immediate', payload: { parameters, meta } })
    const written: string[] = []
    for (const c of courses) {
      await atomicWrite(this.paths.fsrsParamsPath(c.root), JSON.stringify({ parameters, meta }, null, 1) + '\n')
      written.push(c.name)
    }
    this.schedCache.clear() // 参数唯一写者在此：缓存调度器全部失效，后续推进用新参数
    await rebuildLearnerProfile(this.paths, foldSediment(await readSedimentCanon(this.paths)))
    return { status: 'written', written, meta }
  }

  // ---- 沉淀层（#139 / ADR-0034：学习模型状态第四存储域）----

  /** 出生即写：追加一条沉淀事件（六类事件骨架的唯一写入口；校验在 sediment 模块）。
   * 永不自动删除——内容层任何不可逆操作不写这里。 */
  async sedimentAppend(kind: SedimentKind, tier: SedimentTier, payload: Record<string, unknown>, concept?: string): Promise<SedimentEvent> {
    return appendSedimentEvent(this.paths, { kind, tier, payload, ...(concept !== undefined ? { concept } : {}) })
  }

  /** 读侧单向的唯一消费口径：读正典 → 折叠（两次折叠同输入同输出）。教练折叠
   * （#144）等后续消费方一律从这里取，禁止再读内容层旧居所。 */
  async sedimentFold(): Promise<SedimentFold> {
    return foldSediment(await readSedimentCanon(this.paths))
  }

  /** 重建学习者档案投影（学习中心/沉淀/学习者档案.md；纯派生，手编必被覆盖）。 */
  async sedimentRebuildProfile(): Promise<string> {
    return rebuildLearnerProfile(this.paths, await this.sedimentFold())
  }

  /** 沉淀结算：从行为流水蒸馏校准画像与速度韧性的周档事件（出生即写；窗口 =
   * 上一完整学习周，与周复盘同口径）→ 重建学习者档案投影。数据不足门槛的 kind
   * 静默跳过（不造假数据）；复诊结局/图修复史/内容质量结论的生产者由后续票接线
   * （#146 边实验结算、#145 生长批）。 */
  async sedimentSettle(): Promise<{
    week: string | null
    wrote: SedimentKind[]
    skipped: Array<{ kind: SedimentKind; reason: string }>
    profile: string
  }> {
    const { today, cutoff } = await this.learningDay()
    const weekStart = prevWeekStartOf(today)
    const weekEnd = weekStart ? weekEndOf(weekStart) : null
    const wrote: SedimentKind[] = []
    const skipped: Array<{ kind: SedimentKind; reason: string }> = []
    if (weekStart && weekEnd) {
      // 同周幂等：该学习周已有同 kind 周档 → 不重写（追加正典不吃重复结算）
      const fold = await this.sedimentFold()
      const settled = (kind: SedimentKind): boolean =>
        (fold.weekly[kind] ?? []).some(g => g.week === weekStart)
      const inWeek = (ts: string | undefined): boolean => {
        const d = ts ? dayOfTs(ts, cutoff) : null
        return d !== null && d >= weekStart && d <= weekEnd
      }
      const practice = await this.store.practiceAll()
      const weekPractice = practice.filter(r => inWeek(r.ts))

      // 校准画像：JOL 预测配对样本（predicted 字段）；无配对静默
      const paired = weekPractice.filter(r => r.predicted != null && typeof r.correct === 'boolean')
      if (settled('calibration')) {
        skipped.push({ kind: 'calibration', reason: `学习周 ${weekStart} 已结算` })
      } else if (paired.length) {
        const view = calibrationProfileView(weekPractice)
        await this.sedimentAppend('calibration', 'weekly', {
          week: weekStart,
          pairs: paired.length,
          view,
        })
        wrote.push('calibration')
      } else {
        skipped.push({ kind: 'calibration', reason: '上一学习周无 JOL 预测配对样本' })
      }

      // 速度韧性：作答耗时（est vs 实际的节奏面）+ 到期复习真实保留率
      const elapsed = weekPractice.map(r => r.elapsed_s).filter((s): s is number => typeof s === 'number' && s > 0)
      const dueReviews = dueReviewFirstPushes(await this.store.reviewLogAll(), cutoff)
        .filter(r => inWeek(r.ts))
      const retention = trueRetention(dueReviews)
      if (settled('speed_resilience')) {
        skipped.push({ kind: 'speed_resilience', reason: `学习周 ${weekStart} 已结算` })
      } else if (elapsed.length || dueReviews.length) {
        elapsed.sort((a, b) => a - b)
        const mid = Math.floor(elapsed.length / 2)
        const median = elapsed.length % 2
          ? elapsed[mid]!
          : Math.round(((elapsed[mid - 1]! + elapsed[mid]!) / 2) * 10) / 10
        await this.sedimentAppend('speed_resilience', 'weekly', {
          week: weekStart,
          answers: weekPractice.length,
          median_elapsed_s: elapsed.length ? median : null,
          due_reviews: dueReviews.length,
          true_retention: retention.rate,
          lapses: retention.fail,
        })
        wrote.push('speed_resilience')
      } else {
        skipped.push({ kind: 'speed_resilience', reason: '上一学习周无作答耗时与到期复习记录' })
      }
    } else {
      skipped.push({ kind: 'calibration', reason: '学习日不可解析' })
      skipped.push({ kind: 'speed_resilience', reason: '学习日不可解析' })
    }
    const profile = await this.sedimentRebuildProfile()
    return { week: weekStart, wrote, skipped, profile }
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

  /** 全部题库条目（题目管理列表；不含答案，带到期与统计）。 */
  async questionsAll(courseKey?: string): Promise<QuestionsAllDoc> {
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.registry.enabled()
    const out: Array<Record<string, unknown>> = []
    for (const c of courses) {
      let files: string[] = []
      try {
        files = await readdir(this.paths.bankDir(c.root))
      } catch {
        continue
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const node = f.replace(/\.yaml$/, '')
        const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
        bank.questions.forEach((q, i) => {
          out.push({
            course: c.name, node, qid: q.id, no: i + 1, kind: q.kind, q: q.q,
            difficulty: q.difficulty ?? 1, tags: q.tags ?? [],
            archived: q.archived === true,
            ...(q.archived_reason ? { archivedReason: q.archived_reason } : {}),
            hasExplanation: Boolean(q.explanation),
            // 调度字段（题目管理页「到期」列消费；未进调度的题为 null）
            due: q.fsrs?.reps ? q.fsrs.due : null,
            lastReview: q.fsrs?.reps ? q.fsrs.last_review : null,
            ...(q.options?.length ? { options: q.options } : {}),
            ...(q.kind === 'matching' && Array.isArray(q.answer)
              ? { pairOptions: [...new Set(q.answer as string[])] } : {}),
          })
        })
      }
    }
    return { total: out.length, questions: out }
  }

  // ---- B2 难度感知回流（决议 #41 / #58）----

  /** 节点级只读检测：扫题库 stats/fsrs（bank per-qid）+ masteryOfFm + 门槛 →
   * {低掌握校准建议, 全对归档建议} 清单，供 orchestrator/harness 在出题与题目管理
   * 动作前消费。建议先行不自动改库——再生成走既有 question_generate/question_save
   * 与单节重写通道，归档走题目管理的独立归档操作；practice 节点无题库天然静默；
   * Broken 笔记 fail loud（与 status/recommend 同一门前置）。
   * 被忽略的建议（adviceDismiss）不进 nodes，只以 dismissed 计数带出（恢复入口消费）。 */
  async difficultyAdvice(courseKey?: string): Promise<DifficultyAdviceDoc> {
    const { today } = await this.learningDay()
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const dismissedKeys = new Set((await this.store.loadAdviceDismissals()).map(d => adviceDismissKey(d.course, d.node, d.qid)))
    let dismissed = 0
    const nodes: Array<Record<string, unknown>> = []
    for (const c of courses) {
      const { graph, state, broken } = await this.loadView(c)
      assertNoBrokenNotes('difficulty-advice', broken)
      await this.scanCourseBanks(c, async (node, bank) => {
        const fm = state[node]
        if (!fm || graph.typeOf[node] === 'practice') return // practice 节点无题库，合法空态
        const qs = bank.questions.filter(q => !q.archived)
        let attempts = 0
        let correct = 0
        for (const q of qs) {
          attempts += q.stats?.attempts ?? 0
          correct += q.stats?.correct ?? 0
        }
        const calibration = calibrationAdvice({
          stage: effectiveStage(state, node),
          attempts,
          accuracy: attempts ? correct / attempts : null,
          mastery: masteryOfFm(fm),
          bloom: graph.bloomOf[node],
        })
        const tooEasy = tooEasyAdvice(qs).filter(t => {
          if (dismissedKeys.has(adviceDismissKey(c.name, node, t.qid))) {
            dismissed++
            return false
          }
          return true
        })
        if (!calibration && !tooEasy.length) return
        nodes.push({
          course: c.name, node,
          ...(calibration ? { calibration } : {}),
          ...(tooEasy.length ? { too_easy: tooEasy } : {}),
        })
      })
    }
    return { date: today, nodes, dismissed }
  }

  /** 忽略/恢复一条「过于简单」建议（持久忽略清单，学习中心 state/难度建议忽略.json）：
   * undo=false 追加（幂等），true 移除；all=true 清空恢复。误判的恢复成本为零——
   * 与「建议先行、不自动移除」同一立场（ADR-0032 同期）。 */
  async adviceDismiss(course: string, node: string, qid: string | undefined, undo = false, all = false): Promise<{ dismissed: AdviceDismissRec[] }> {
    let list = await this.store.loadAdviceDismissals()
    if (all) {
      list = []
    } else if (undo) {
      list = list.filter(d => !(d.course === course && d.node === node && d.qid === qid))
    } else {
      if (!qid) throw new Error('[advice-dismiss] 忽略必须带 qid（恢复可用 all=true 清空）。')
      const key = adviceDismissKey(course, node, qid)
      if (!list.some(d => adviceDismissKey(d.course, d.node, d.qid) === key)) {
        list = [...list, { course, node, qid, date: (await this.learningDay()).today }]
      }
    }
    await this.store.saveAdviceDismissals(list)
    return { dismissed: list }
  }

  async questionAdd(courseKey: string, node: string, question: Record<string, unknown>): Promise<{ course: string; node: string; id: string; count: number }> {
    const c = await this.registry.resolve(courseKey)
    const r = await this.bank.addQuestion(this.paths.courseRoot(c.root), node, question)
    return { course: c.name, node, ...r }
  }

  /** 单题全量读取（含 answer/explanation）：修订/审题用——questionList 不带答案（作答流防泄题），改题前用这个看原题。
   * 笔记源卡（course=「笔记源」伪课程）同通道可读：漂移后审旧题用。 */
  async questionGet(courseKey: string | undefined, node: string, qid: string): Promise<QuestionGetDoc> {
    if (await this.isNoteSourceCourse(courseKey)) {
      const bank = await this.bank.load(this.paths.noteSourceDir, node)
      const q = bank.questions.find(x => x.id === qid)
      if (!q) throw new Error(`[question-get] 笔记源「${node}」的题库没有 ${qid}（共 ${bank.questions.length} 题）。`)
      return { course: NOTE_SOURCE_COURSE, node, question: q }
    }
    const c = await this.registry.resolve(courseKey)
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-get] 「${node}」的题库没有 ${qid}（共 ${bank.questions.length} 题）。`)
    return { course: c.name, node, question: q }
  }

  async questionUpdate(courseKey: string, node: string, qid: string, patch: Record<string, unknown>): Promise<{ course: string; node: string; qid: string }> {
    const c = await this.registry.resolve(courseKey)
    await this.bank.updateQuestion(this.paths.courseRoot(c.root), node, qid, patch)
    return { course: c.name, node, qid }
  }

  /** 归档/取消归档单题。笔记源卡（course=「笔记源」伪课程）同通道：漂移提示的
   * 「归档旧题」直达动作走这里（学习中心/笔记源 镜像题库）。reason 记入
   * archived_reason（ADR-0032：too_easy=建议确认、manual=人工等），恢复时清除。 */
  async questionArchive(courseKey: string, node: string, qid: string, archived: boolean, reason?: string): Promise<{ course: string; node: string; qid: string; archived: boolean }> {
    if (await this.isNoteSourceCourse(courseKey)) {
      await this.bank.archiveQuestion(this.paths.noteSourceDir, node, qid, archived, reason)
      return { course: NOTE_SOURCE_COURSE, node, qid, archived }
    }
    const c = await this.registry.resolve(courseKey)
    await this.bank.archiveQuestion(this.paths.courseRoot(c.root), node, qid, archived, reason)
    return { course: c.name, node, qid, archived }
  }

  // ---- 题库一键清理（ADR-0032）----

  /** 清理预览（只读）：两条规则扫全部启用课程——跳过节点全部未归档题 +
   * 已完成节点的休眠题。按课程/节点分组带题面样本，确认后才 apply。 */
  async bankCleanupPreview(courseKey?: string): Promise<CleanupPreviewDoc> {
    const { today } = await this.learningDay()
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const groups: CleanupGroup[] = []
    let total = 0
    for (const c of courses) {
      const { state } = await this.loadView(c)
      await this.scanCourseBanks(c, async (node, bank) => {
        const stage = state[node]?.stage
        const cands = cleanupCandidatesForNode(stage, bank.questions)
        if (!cands.length) return
        const reasons: Record<CleanupReason, number> = { skipped_node: 0, dormant_after_complete: 0 }
        for (const x of cands) reasons[x.reason]++
        const byId = new Map(bank.questions.map(q => [q.id, q]))
        total += cands.length
        groups.push({
          course: c.name, node, stage: stage ?? 'ready', count: cands.length, reasons,
          stems: cands.slice(0, 3).map(x => (byId.get(x.qid)?.q ?? '').slice(0, 80)),
        })
      })
    }
    return { date: today, total, groups }
  }

  /** 清理应用：按当前预览逐题归档（reason=cleanup，可逆；恢复走题库管理面）。
   * 预览与应用之间库可能变化——apply 现算一遍候选，不做两阶段锁。 */
  async bankCleanupApply(courseKey?: string): Promise<{ course: string; node: string; archived: number }[]> {
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
    const done: Array<{ course: string; node: string; archived: number }> = []
    for (const c of courses) {
      const { state } = await this.loadView(c)
      const courseRoot = this.paths.courseRoot(c.root)
      await this.scanCourseBanks(c, async (node, bank) => {
        const cands = cleanupCandidatesForNode(state[node]?.stage, bank.questions)
        if (cands.length) {
          await this.bank.archiveQuestions(courseRoot, node, cands.map(x => x.qid), true, 'cleanup')
          done.push({ course: c.name, node, archived: cands.length })
        }
      })
    }
    return done
  }

  // ---- 瑕疵题勘误与判罚冲正（ADR-0031）----

  /** 被申诉作答的定位与准入：该题最近一条判错的 practice 记录，未被冲正过。
   * 目标 = 最近一条（练习会话的即时申诉与直通卡/复习流的「最近一次答错」一致）。
   * AI 判卷题型（reflection/open_question）不在申诉范围（Q8 裁定）：评分异议走
   * 既有「讲解这道题」通道，判卷故障已有 #116 逃生门。 */
  private async disputeTarget(courseKey: string | undefined, node: string, qid: string, op: string) {
    const { c, graph, q } = await this.questionContext(courseKey, node, qid, op)
    if (q.kind === 'reflection' || q.kind === 'open_question') {
      throw new Error(`[${op}] AI 判卷题型（reflection/open_question）不走申诉：评分异议用「讲解这道题」，判卷故障有逃生门。`)
    }
    const rec = (await this.store.practiceAll())
      .filter(r => r.course === c.name && r.node === node && r.qid === qid && r.correct === false)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .at(-1)
    if (!rec) throw new Error(`[${op}] ${node}/${qid} 没有可申诉的判错作答记录（申诉只针对判错的作答）。`)
    const errata = await this.store.erratumAll()
    if (errata.some(e => e.target_ts === rec.ts && e.qid === qid)) {
      throw new Error(`[${op}] ${node}/${qid} 最近一条判错作答（${rec.ts}）已被冲正过，同一条作答至多申诉一次。`)
    }
    return { c, graph, q, rec }
  }

  /** 申诉复核（只读，不落盘）：LLM 两阶段复核——先独立解题再对账，三态裁定。
   * 解析失败自动重问一次，仍失败抛「AI 复核输出不可用」（UI 据此放行跳过复核的
   * 直接豁免降级入口）；原始输出照 #116 惯例留痕判卷失败.jsonl。 */
  async questionDisputeReview(
    llmComplete: LlmComplete,
    courseKey: string | undefined, node: string, qid: string,
  ): Promise<DisputeReviewResult> {
    const { c, graph, q, rec } = await this.disputeTarget(courseKey, node, qid, 'dispute')
    const note = await this.nodeNote(c, graph, node)
    const entry = sectionEntryOf(q.section, note.fm?.content.sections)
    const sectionMd = entry
      ? Sessions.lessonSections(note.body).find(s => s.title === entry.title)?.md ?? null
      : null
    const forgot = rec.judge === 'forget'
    const prompt = [
      '# 复核一道练习题的申诉', '',
      '学习者作答被判错并申诉「题目错了」。请严格按两阶段复核：',
      '1. **独立解题**：只看题面自己完整解一遍（此阶段忽略下面给出的存储答案键），写出过程与你的答案；',
      '2. **对账**：把你的独立结果与存储答案键/解析、以及学习者作答逐一比对；',
      '3. 按系统提示的三态规则给出裁定。', '',
      '## 题目', q.q,
      ...(q.options?.length ? q.options.map((o, i) => `- ${String.fromCharCode(65 + i)}. ${o}`) : []),
      '', `存储的答案键：${revealAnswer(q)}`,
      ...(q.explanation ? ['', `存储的解析：${q.explanation}`] : []),
      '', '## 学习者的作答',
      forgot ? '（空——学习者按「忘记」翻面，未作答）' : (rec.answer || '（空作答）'),
      '', '## 对应节正文（超纲判定依据）',
      ...(entry && sectionMd
        ? [`（来自节「${entry.title}」）`, '', sectionMd.slice(0, 4000)]
        : ['（未能定位到具体节——以下为整课节选）', '', note.body.replace(/^>\s*内容待生成。\s*$/m, '').trim().slice(0, 2500)]),
    ].join('\n')
    let lastError = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ask = attempt === 1
        ? prompt
        : `${prompt}\n\n[重判要求] 上一次输出无法解析为复核结果。这一次只输出一个 JSON 对象（shape 见系统提示），不要任何其他文字、解释或代码围栏。`
      const raw = await llmComplete(ask, DISPUTE_REVIEW_SYSTEM)
      try {
        const v = parseDisputeReview(raw)
        return {
          course: c.name, node, qid,
          target_ts: rec.ts,
          verdict: v.verdict,
          reasoning: v.reasoning,
          current_answer: revealAnswer(q),
          ...(v.suggested_answer !== undefined
            ? { suggested_answer: v.suggested_answer as DisputeReviewResult['suggested_answer'] } : {}),
          ...(v.suggested_explanation ? { suggested_explanation: v.suggested_explanation } : {}),
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        await this.logGradingFailure({ course: c.name, node, qid, kind: 'dispute-review', attempt, error: lastError, raw })
      }
    }
    throw new Error(`[dispute] AI 复核输出不可用，未做任何改动（可重试，或跳过复核直接豁免本题）：${lastError}`)
  }

  /** 申诉结算（落盘）：resolution 三选一。
   * - rekey：按 revision 修订题目（改键/解析，questionUpdate 作者门禁+形态门禁），
   *   用新键重判原作答——原作答符合新键则改判为对（XP 按对题补记、frontmatter
   *   correct+1、EMA 补 0.3 步）；不符合则只修键，判罚维持。
   * - void / overridden：本次作答作废（判卷逃生门口径）——XP 净值归零（乱猜罚随减）、
   *   attempts−1、EMA 逆向一步；void 语义 = 题是瑕疵题，归档随结算原子落盘（重出走
   *   生成队列、可重试）；overridden = 复核判题没问题但学习者坚持豁免（题保留在调度里）。
   * 共同边界（ADR-0031）：FSRS 不回滚、review-log 不抹；冲正走 勘误.jsonl 追加 +
   * 聚合账净额重算（practice.jsonl 永不改写）。EMA/frontmatter 计数是增量聚合，
   * 逆向调整在「争议条为该节点最新证据」时精确，否则为可接受的近似（派生读侧）；
   * rekey 且原作答与新键仍不符 = 净零变动（只修键，证据不动）。 */
  async questionDisputeApply(
    courseKey: string | undefined, node: string, qid: string,
    resolution: 'rekey' | 'void' | 'overridden',
    opts?: { targetTs?: string; revision?: { answer?: unknown; explanation?: string }; reason?: string },
  ): Promise<DisputeApplyResult> {
    if (resolution !== 'rekey' && resolution !== 'void' && resolution !== 'overridden') {
      throw new Error(`[dispute-apply] resolution 必须是 rekey/void/overridden（收到 ${String(resolution)}）。`)
    }
    const { c, graph, rec } = await this.disputeTarget(courseKey, node, qid, 'dispute-apply')
    if (opts?.targetTs && opts.targetTs !== rec.ts) {
      throw new Error(`[dispute-apply] targetTs 与该题最近判错记录不一致（${opts.targetTs} ≠ ${rec.ts}）——复核后题目状态可能已变化，请重新申诉。`)
    }
    const { cutoff } = await this.learningDay()
    let verdict: ErratumRec['verdict']
    let xpNet = rec.xp ?? 0
    let correctNow: boolean | null = false

    if (resolution === 'rekey') {
      const answer = opts?.revision?.answer
      if (answer === undefined || answer === null || (typeof answer === 'string' && !answer.trim())) {
        throw new Error('[dispute-apply] rekey 需要 revision.answer（新答案键）。')
      }
      const patch: Record<string, unknown> = { answer }
      if (typeof opts?.revision?.explanation === 'string' && opts.revision.explanation.trim()) {
        patch.explanation = opts.revision.explanation
      }
      await this.bank.updateQuestion(this.paths.courseRoot(c.root), node, qid, patch)
      const fresh = (await this.bank.load(this.paths.courseRoot(c.root), node)).questions.find(x => x.id === qid)
      if (!fresh) throw new Error(`[dispute-apply] ${node}/${qid} 改键后读取失败。`)
      // 重判原作答：空作答（忘记翻面）必然不符，且 evaluateAllo 对空作答按题型抛错——直接判不符
      const r = rec.answer && rec.judge !== 'forget'
        ? (() => { try { return evaluateAllo(fresh, rec.answer) } catch { return { score: 0 } } })()
        : { score: 0 }
      correctNow = r.score >= PASS_SCORE
      verdict = 'key_error'
      if (correctNow) {
        // 改判对：对题 XP 补记（豁免永不产生得分，改判只来自键修改后的重判）；乱猜罚随键纠正一并消失
        xpNet = xpForAnswer(fresh.kind, fresh.difficulty ?? 1, true, null, true).xp
      }
    } else {
      verdict = resolution === 'void' ? 'defective' : 'overridden'
      xpNet = 0 // 作废：本次作答 XP 净值归零（乱猜 −1 罚随之返还）
    }

    // 题目 stats 从净流水重算（作废剔除该条；改判按新对错计；rekey 维持 = 原样重写）；
    // FSRS 块不动
    const errata = await this.store.erratumAll()
    const pending: ErratumRec = {
      ts: nowIso(), course: c.name, node, qid, target_ts: rec.ts,
      verdict, xp: xpNet,
      ...(correctNow === true ? { correct: true } : {}),
      ...(resolution === 'rekey' ? { revision: opts?.revision ?? {} } : {}),
      ...(opts?.reason?.trim() ? { reason: opts.reason.trim().slice(0, 500) } : {}),
    }
    const net = netPracticeRecs(
      (await this.store.practiceAll()).filter(r => r.course === c.name && r.node === node && r.qid === qid),
      [...errata, pending],
    )
    const latest = [...net].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)
    const stats = {
      attempts: net.length,
      correct: net.filter(r => r.correct === true).length,
      ...(latest ? { last: dayOfTs(latest.ts, cutoff), last_correct: latest.correct === true } : {}),
    }
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { stats })

    // 节点 frontmatter 逆向调整：作废 = 撤 0 分步（attempts−1、EMA ÷0.7）；改判对 =
    // 撤 0 分步再补 1 分步（净 +0.3）；rekey 且判罚维持 = 净零变动（证据不动，只修键）。
    const evidenceChange = resolution !== 'rekey' || correctNow === true
    const note = await this.nodeNote(c, graph, node)
    let fmAfter = note.fm
    if (note.fm && evidenceChange) {
      const round3 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000
      const practice = {
        attempts: Math.max(0, note.fm.practice.attempts + (resolution === 'rekey' ? 0 : -1)),
        correct: Math.max(0, note.fm.practice.correct + (correctNow ? 1 : 0)),
      }
      const ema = note.fm.practice_ema
      const practice_ema = correctNow
        ? (ema === undefined ? 1 : round3(ema + 0.3))
        : (ema === undefined ? undefined : round3(ema / 0.7))
      fmAfter = {
        ...note.fm, practice,
        ...(practice_ema !== undefined ? { practice_ema } : {}),
      }
      await this.saveNodeNote(note.path, fmAfter, note.body)
    }
    await this.store.appendErratum(pending)
    if (resolution === 'void') {
      // 瑕疵题的归档随作废结算原子落盘（ADR-0031）：重出走生成队列（可重试），
      // 不再由 UI 两段拼接留下「已作废未归档」的悬空态。归档原因 erratum（ADR-0032）。
      await this.bank.archiveQuestion(this.paths.courseRoot(c.root), node, qid, true, 'erratum')
    }
    return {
      course: c.name, node, qid, resolution,
      verdict,
      correct_now: resolution === 'rekey' ? correctNow : null,
      xp: xpNet,
      ...(resolution === 'void' ? { archived: true } : {}),
      ...(fmAfter ? { mastery: masteryOfFm(fmAfter) } : {}),
    }
  }

  /** AI 出题：节点正文 → 出题提示词 + llm → 产出的题库 YAML 逐题过 validateBank 门禁追加落盘。
   * llm 由 host 注入（输出可能带 markdown 围栏，解析侧 parseModel 统一剥离）。骨架节点（无正文）直接报错。
   * count 缺省 = 既有默认 6（定向补生成 = 3）；一旦给出必须是正整数，非法值不改写成默认（#12）。
   * opts.sections = 节标注清单（逐节管线）：模型照抄清单节 id 进 section 字段；
   * opts.generic = 只出跨节综合题（section 强制「通用」，逐节管线收尾用）；
   * opts.section = 定向补生成（#117）：只为本节补题——提示词只附该节正文、产物强制
   *   section: s.id，与清单不符的先按标题归一化（剥「类型：」前缀+去空白，同会话口径）
   *   回填，仍无法归类的题拒收并在返回结果中报告（fail loud，不兜底挂「通用」）；
   * opts.instruction = 生成指令（#120 提意见重生成的学习者意见），原样注入提示词；
   * 防相似（#119）：提示词注入题库已有题面 ≤15 条（只题面/题型/难度），生成后逐题
   *   程序化查重（归一化精确 + trigram ≥0.8），命中的丢弃不入库并在 duplicates 报告。
   * 出生打标（#148）：概念清单（本节 teaches ∪ 前置闭包 teaches）在场时逐题必须恰一枚
   *   invokes——缺席先走一次补标调用（修复一次），仍空拒收并报告；清单缺席（存量/手编
   *   图）invokes 恒合法 Missing。返回的 enc = 题目 invokes 覆盖率投影（出生 w 作回退
   *   初值，随生长批经 set_enc 写入）。
   * opts.isCancelled = 逐题检查的取消旗标（GenJob 取消语义，#118）。 */
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
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
      throw new Error(`[quiz] count 必须是正整数（收到 ${String(count)}）；省略才使用默认。`)
    }
    const requested = count ?? (opts?.section ? 3 : 6)
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[quiz] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'quiz')
    // invokes 概念引用对表基线（#141）：登记表在册名字集，出题受理门逐题对照
    const conceptNames = namesOf(await this.concepts.load(c.root))
    const [, regionName] = graph.blockOf[node]
    const note = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
    const body = note.body.replace(/^>\s*内容待生成。\s*$/m, '').trim()
    if (!body) throw new Error(`[quiz] 「${node}」还没有正文——先「生成正文」再出题。`)
    const tpl = await this.loadPrompt('题目生成')
    const tier = nodeTierOf(graph, node)
    const prior = await this.vaultPriorFor(graph, node)
    // 已有题面（#119）：注入提示词 + 查重基线（归档题不参与——归档旧题后按意见重出同题面是合法意图）
    const bankBefore = await this.bank.load(this.paths.courseRoot(c.root), node)
    const existingStems = bankStemList(bankBefore)

    // 定向补生成：只附该节正文（找不到该节 fail loud），节标注 = 单节强绑指令
    let contentBody = body
    let listing: string
    if (opts?.section) {
      const s = opts.section
      const md = sectionMdOf(body, s.title)
      if (md === null) throw new Error(`[quiz] 正文里找不到节「${s.title}」——定向补题需要该节正文，请先确认节标题。`)
      contentBody = `## ${s.title}\n\n${md}`
      listing = `\n\n## 节标注清单\n\n本批全部题目都属于这一节：section 字段必须精确写「${s.id}」（节标题：${s.title}），不要写「通用」或其他节。`
    } else if (opts?.sections?.length) {
      listing = `\n\n## 节标注清单\n\nsection 字段必须精确取自下列节 id（跨节综合题写「通用」）：\n${opts.sections.map(s => `- ${s.id} ｜ ${s.title}`).join('\n')}`
    } else {
      listing = ''
    }
    const instruction = opts?.instruction?.trim()
      ? `\n\n## 生成指令（学习者意见，优先遵循）\n\n${opts.instruction.trim()}`
      : ''
    const difficultyAnchor = tier === 1
      ? '本节点为低复杂度：题目难度集中在 1-2，不出 difficulty: 3 的收尾难题。'
      : tier === 3
        ? '本节点为高复杂度：收尾可出 1-2 道 difficulty: 3 的综合/易错题。'
        : '本节点为中复杂度：难度递进到 2，收尾至多 1 道 difficulty: 3。'
    const misBlock = misconceptionPromptBlock(graph.misconceptionsOf[node], '干扰项材料')
    // 出生打标（#148）：概念清单 = 本节 teaches ∪ 前置闭包 teaches；空清单 = 门不激活
    const conceptScope = Content.conceptScopeOf(graph, node)
    const conceptBlock = Content.conceptListBlock(conceptScope)
    const raw = await llm(`${tpl}${existingStemsPromptBlock(existingStems)}${listing}${instruction}\n\n## 题目数量\n\n${requested} 道\n\n## 难度锚定\n\n${difficultyAnchor}${misBlock}${conceptBlock}\n\n---\n\n${contentBody}${prior ? `\n\n---\n\n${prior}` : ''}`)
    const doc = YAML.parseModel(raw) as { node?: unknown; questions?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions) || !doc.questions.length) {
      throw new Error('[quiz] 模型没有产出可用题目（questions 为空）。')
    }
    // 出生打标修复轮（#148）：清单在场且有题缺 invokes → 恰一次补标调用；仍空由下方受理门拒收
    if (conceptScope.length) {
      if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
      await this.repairInvokesOnce(llm, doc.questions.slice(0, requested), conceptScope)
    }
    // doc.node 只是模型对节点的复述（常自创短名），落盘位置由入参决定，不作硬校验
    let added = 0
    let skipped = 0
    let escapesRepaired = 0
    const duplicates: Array<{ q: string; against: string }> = []
    const rejected: Array<{ q: string; reason: string }> = []
    for (const item of doc.questions.slice(0, requested)) {
      if (opts?.isCancelled?.()) throw new Error('生成已取消，结果已丢弃。')
      const q = { ...(item as Record<string, unknown>) }
      delete q.id // id 由 addQuestion 按现有题数自动编号，避免与既有 q1 冲突
      if (opts?.generic) q.section = '通用' // 综合题不绑节（轮装配时统一收尾）
      // 题目卫生（ADR-0029/0030）：先确定性修复转义损坏（计数留痕），修不好或记法/边界违规的题拒收
      const hygiene = repairQuestionStrings(q)
      escapesRepaired += hygiene.repaired
      const stem = typeof q.q === 'string' ? q.q : ''
      const violation = hygiene.unrepairable
        ? '题面含无法修复的转义损坏（控制字符）——YAML 双引号吃掉了 LaTeX 转义'
        : questionViolation(q)
      if (violation) {
        rejected.push({ q: stem.slice(0, 80), reason: violation })
        continue
      }
      // 定向补生成强校验（#117）：不符先按标题归一化回填，仍无法归类拒收并报告
      if (opts?.section) {
        const sec = typeof q.section === 'string' ? q.section : ''
        if (sec !== opts.section.id) {
          if (sec && normSectionKey(sec) === normSectionKey(opts.section.title)) {
            q.section = opts.section.id
          } else {
            rejected.push({ q: stem.slice(0, 80), reason: sec ? `section「${sec}」无法归类到节「${opts.section.title}」` : '缺少 section 标注' })
            continue
          }
        }
      }
      // 写入侧答案形态门禁（多选 ≥2 正确项，prompt 约束 9 的服务端兜底）：
      // 拒收并报告（与 #117 同款 fail loud），不静默降级成 skipped
      const shapeErr = questionAnswerShapeError(q)
      if (shapeErr) {
        rejected.push({ q: stem.slice(0, 80), reason: shapeErr })
        continue
      }
      // invokes 概念引用在册校验（#141 受理门对表）：未在册名字拒收并报告
      const invokesErr = invokesUnregistered(q, conceptNames)
      if (invokesErr) {
        rejected.push({ q: stem.slice(0, 80), reason: invokesErr })
        continue
      }
      // 出生打标门（#148）：清单在场时新题必须带恰一枚 invokes；修复一次仍不合格拒收
      if (conceptScope.length && !invokesTagged(q)) {
        rejected.push({ q: stem.slice(0, 80), reason: 'invokes 未标注恰一枚概念（出生打标；修复一次仍不合格，拒收）' })
        continue
      }
      // 程序化查重（#119）：与已有题、本批已收题比对，命中丢弃并报告
      const verdict = await this.admitQuestion(this.paths.courseRoot(c.root), node, q, stem, existingStems)
      if (verdict.verdict === 'duplicate') {
        duplicates.push({ q: stem.slice(0, 80), against: verdict.against.slice(0, 80) })
      } else if (verdict.verdict === 'added') {
        added++
      } else {
        skipped++ // 单题非法（如模型超纲出题型）不毁整批，好题照常入库
      }
    }
    if (!added) throw new Error('[quiz] 模型产出的题目全部未过校验门（题型/答案格式不符/记法违规/重复/无法归节/invokes 缺失），一道都没入库。')
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    return { course: c.name, node, added, skipped, total: bank.questions.length, duplicates, rejected, escapesRepaired, enc: Content.invokesProjection(graph, node, bank.questions) }
  }

  /** 逐节出题（逐节管线第 2 段）：每个内容节一次模型调用（出题量随档位锚点：
   * 低/中/高档内容节目标 1/2/3 道，含练习节时 -1），section 服务端强制为该节 id；
   * 练习/交互节跳过，正文未生成的节（断点续跑）跳过。防相似（#119）：提示词注入
   * 节点已有题面 ≤15 条，生成后逐题查重，命中的丢弃并计入 duplicates。
   * 出生打标（#148）：与 questionGenerate 同一门——概念清单在场逐题恰一枚 invokes，
   * 缺席修复一次仍空即弃（不入库）；返回 enc = invokes 覆盖率投影（出生 w 作回退初值）。 */
  async questionGenerateSections(
    courseKey: string | undefined, node: string,
    llm: LlmComplete,
  ): Promise<{ course: string; node: string; added: number; sections: number; duplicates: number; escapesRepaired: number; enc: EncEdge[] }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[quiz] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'quiz')
    const manifest = state[node]?.content.sections
    if (!manifest?.length) throw new Error(`[quiz] 「${node}」没有节清单——先运行大纲。`)
    // invokes 概念引用对表基线（#141）：与 questionGenerate 同一受理门
    const conceptNames = namesOf(await this.concepts.load(c.root))
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
    const mdByTitle = new Map<string, string>()
    for (const part of body.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      if (title) mdByTitle.set(title, (nl >= 0 ? part.slice(nl + 1) : '').trim())
    }
    const tpl = await this.loadPrompt('题目生成')
    const tier = nodeTierOf(graph, node)
    const prior = await this.vaultPriorFor(graph, node)
    const priorBlock = prior ? `\n\n---\n\n${prior}` : ''
    // 已有题面（#119）：注入 + 查重基线（本批新收题也进基线，批内互查）
    const bankBefore = await this.bank.load(this.paths.courseRoot(c.root), node)
    const existingStems = bankStemList(bankBefore)
    const stemBlock = existingStemsPromptBlock(existingStems)
    // 出题量弹性（P3，复杂度档案锚点）：每档给内容节目标题量；大纲含练习节时内容节 −1
    // （集中练习模式：读读读→集中练，综合题数随档位而非恒定 3）。
    const hasPracticeSection = manifest.some(s => s.type === '练习')
    const perSection = perSectionQuizTarget(tier, hasPracticeSection)
    const misBlock = misconceptionPromptBlock(graph.misconceptionsOf[node], '干扰项材料')
    // 出生打标（#148）：概念清单整课一次组装，逐节提示词与补标调用共用
    const conceptScope = Content.conceptScopeOf(graph, node)
    const conceptBlock = Content.conceptListBlock(conceptScope)
    let added = 0
    let sections = 0
    let duplicates = 0
    let escapesRepaired = 0
    for (const [si, s] of manifest.entries()) {
      if (s.type === '练习' || s.type === '交互') continue
      const sectionMd = mdByTitle.get(s.title)
      if (!sectionMd) continue
      if (perSection <= 0) continue // 该档位不要求本内容节单独出题（综合题兼底）
      sections++
      // 难度递进锚（#147）：逐节出题按节段难度档走（清单 tier 在场用清单值，缺席按
      // 节位置+节点难度推导）——替换写死的开头 d1/中间 d2/收尾 d3 模板口径。
      const tierLabel = sectionTierLabel(s.tier, graph.difficultyOf[node], graph.estOf[node], si + 1, manifest.length)
      const difficultyAnchor = tierLabel === '低'
        ? '本节难度档：低——题目难度 1 为主（至多 1 道 2），不出 difficulty: 3。'
        : tierLabel === '高'
          ? '本节难度档：高——允许 1-2 道 difficulty: 3 的易错/综合题。'
          : '本节难度档：中——难度递进到 2 即可（收尾至多 1 道 difficulty: 3）。'
      const raw = await llm(`${tpl}${stemBlock}\n\n## 节标注清单\n\nsection 字段必须精确写「${s.id}」（本批全部题目都属于这一节）。\n\n## 题目数量\n\n${perSection} 道\n\n## 难度锚定\n\n${difficultyAnchor}${misBlock}${conceptBlock}\n\n---\n\n## ${s.title}\n\n${sectionMd}${priorBlock}`)
      let doc: { questions?: unknown } | null = null
      try {
        doc = YAML.parseModel(raw) as { questions?: unknown } | null
      } catch {
        continue // 该节模型输出非法 YAML：跳过，综合调用兼底
      }
      if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions)) continue
      // 出生打标修复轮（#148）：清单在场且有题缺 invokes → 恰一次补标调用，仍空由下方门弃
      if (conceptScope.length) await this.repairInvokesOnce(llm, doc.questions, conceptScope)
      for (const rawQ of doc.questions) {
        const q: Record<string, unknown> = { ...((rawQ ?? {}) as Record<string, unknown>), section: s.id }
        delete q.id
        // 题目卫生（ADR-0029/0030）：转义修复留痕，修不好或记法/边界违规的题丢弃；
        // invokes 未在册同罪（#141 受理门对表，与 questionGenerate 同口径）；
        // 出生打标门（#148）：清单在场缺 invokes（修复一次仍空）同弃
        const hygiene = repairQuestionStrings(q)
        escapesRepaired += hygiene.repaired
        const stem = typeof q.q === 'string' ? q.q : ''
        if (hygiene.unrepairable || questionViolation(q) || invokesUnregistered(q, conceptNames)) continue
        if (conceptScope.length && !invokesTagged(q)) continue
        const verdict = await this.admitQuestion(this.paths.courseRoot(c.root), node, q, stem, existingStems)
        if (verdict.verdict === 'duplicate') duplicates++
        else if (verdict.verdict === 'added') added++ // 单题非法（invalid）不毁整批
      }
    }
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    return { course: c.name, node, added, sections, duplicates, escapesRepaired, enc: Content.invokesProjection(graph, node, bank.questions) }
  }

  /** 交互件成绩结算：面板 sandbox iframe 上报 LEARNHUB_COMPLETE → practice 流水 +
   * 练习证据 EMA（复用题库作答链路；judge='interactive'、qid='interactive:<节id>'）。
   * 同一节同日只记一次（防刷）；不碰题目 FSRS（交互件不是题库题），
   * 节点掌握度为口径 B 派生值（masteryOfFm），随练习证据 EMA 变化并即时回传。 */
  async interactiveSettle(
    courseKey: string | undefined, node: string, sectionId: string, score: number, detail?: string,
  ): Promise<{ settled: boolean; mastery: number }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[interactive] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'interactive')
    if (!Number.isFinite(score)) throw new Error('[interactive] score 必须是数字。')
    const clamped = Math.min(1, Math.max(0, score))
    const qid = `interactive:${sectionId}`
    const { today, cutoff } = await this.learningDay()
    const played = (await this.store.practiceAll()).some(r =>
      r.course === c.name && r.node === node && r.judge === 'interactive' && r.qid === qid
      && dayOfTs(r.ts, cutoff) === today)
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (played) return { settled: false, mastery: masteryOfFm(fm) }
    await this.store.appendPractice({
      course: c.name, node, ex: 0, answer: detail ?? '',
      correct: clamped >= PASS_SCORE, judge: 'interactive', qid,
      ...(detail ? { feedback: detail } : {}),
    })
    let next: Fm | null = null
    if (fm) {
      // probation 在途行使闸（#146）：实验中的插入节点只记流不回流。
      const evidenceGated = await this.exerciseGated(c, node)
      next = evidenceGated ? fm : applyPracticeEvidence(fm, clamped)
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await saveNote(path, next as unknown as Record<string, unknown>, body)
    }
    return { settled: true, mastery: masteryOfFm(next) }
  }

  /** 删除课程：注册表移除 + 课程目录移入 学习中心/.trash/（不真删，可手工找回）。 */
  async courseDelete(courseKey: string): Promise<{ removed: string; trash: string; sediment: string }> {
    const c = await this.registry.get(courseKey)
    if (!c) throw new Error(`[learnhub] 注册表中没有课程「${courseKey}」。`)
    const rest = (await this.registry.load()).filter(x => x.name !== c.name && x.id !== c.id)
    await this.registry.save(rest)
    const src = this.paths.courseRoot(c.root)
    const trash = `${this.paths.trashDir}/${c.root}-${Date.now()}`
    if (existsSync(src)) {
      await mkdir(this.paths.trashDir, { recursive: true })
      await rename(src, trash)
    }
    this.schedCache.delete(this.paths.courseRoot(c.root)) // 缓存键是 courseRoot 路径，逐课失效须同键
    return {
      removed: c.name, trash,
      // 删除波及面单独确认项（#139）：卡级实例记忆随课进 .trash，沉淀层模型状态保留
      sediment: '沉淀层不受影响：泛用模型状态跨课程删除存活（先验连续，ADR-0034）',
    }
  }

  /** 为课程缺笔记的节点补骨架文件（幂等；存量课程修复/维护用）。 */
  async ensureAllNotes(courseKey?: string): Promise<{ courses: Array<{ course: string; created: number }> }> {
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.registry.enabled()
    const out: Array<{ course: string; created: number }> = []
    for (const c of courses) {
      const { graph } = await this.loadView(c)
      const created = await this.proposals.ensureNotesFor(c.root, graph.regions)
      out.push({ course: c.name, created })
    }
    return { courses: out }
  }

  // ---- utils ----

  private async updateNoteFm(path: string, fm: Fm): Promise<void> {
    const { body } = await loadNote(path)
    await saveNote(path, fm as unknown as Record<string, unknown>, body)
  }

  /** 写一条 journal（运行日志等由插件层做）。 */
  journal() { return this.store }
}
