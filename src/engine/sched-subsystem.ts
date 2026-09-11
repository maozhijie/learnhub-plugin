/**
 * Sched 子系统（#152 刀 9 / ADR-0043）：调度域——节点跳过/完成确认、XP 时间账本、
 * 记忆健康仪表盘、FSRS 参数优化器、沉淀层。
 *
 * 同域新文件：srs.ts 被 13 个 engine 模块引用（枢纽领主例外）；本文件只被门面引用。
 */

// ---- Sched 子系统（#152 刀 9 / ADR-0043）：调度域——节点跳过/完成确认、XP 时间账本、
// 记忆健康仪表盘、FSRS 参数优化器、沉淀层。住同域新文件（srs.ts 被 13 模块引用，
// 枢纽领主例外）；本文件只被门面引用，跨子系统调用经窄面注入回引门面。

import type { Store } from './store.ts'
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

/** Sched 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */

/** FSRS 参数优化器写回的元数据（#169：从 `Record<string, unknown>` 收成真实形状——
 * UI 的 StatsPage 要读这些字段，松类型等于把形状藏起来不给消费方）。 */
export interface OptimizeMeta {
  trained_at: string
  params_version: string
  source: string
  reviews: number
  cards: number
  baseline_source: 'sediment' | 'cache' | 'default'
  baseline_log_loss: number
  log_loss: number
  rmse_bins: number
  split_log_loss: number | null
  split_rmse_bins: number | null
}

export interface SchedDeps {
  /** 时钟端口（#175 阶段①）：参数写回 trained_at 戳。 */
  clock: Clock
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
}
import { effectiveStage } from './audit.ts'
import { calibrationProfileView } from './calibration.ts'
import { dayOfTs, fmtCutoff, inWeek, prevWeekStartOf, todayStr, weekEndOf } from './dates.ts'
import type { Clock } from './clock.ts'
import { PASS_SCORE, netPracticeRecs, round2 } from './grading.ts'
import { atomicWrite } from './io.ts'
import { jolCalibration } from './jol.ts'
import { FORECAST_DAYS, calibrationBins, dueReviewFirstPushes, forecast, forgettingCurve, stateHistograms, trueRetention } from './memory.ts'
import { asFm, loadNote, saveNote } from './notes.ts'
import type { OptimizerImpl } from './optimize.ts'
import { FSRS6_PARAM_COUNT, OPTIMIZE_MIN_REVIEWS, bindingImpl, defaultParams, sequenceReviews, trainingSequences } from './optimize.ts'
import { XP_PERFECT_BONUS, XP_STREAK_GRACE_DAYS } from './params.ts'
import { appendSedimentEvent, foldSediment, readSedimentCanon, rebuildLearnerProfile } from './sediment.ts'
import { runWriteUnit } from './write-unit.ts'
import { assertNoBrokenNotes } from './sessions.ts'
import { applyRatingBlock, getScheduler, resolveFsrsParams, retrievabilityBlock } from './srs.ts'
import type { FsrsBlock, Stage } from './types.ts'
import type { MemoryHealthDoc, XpStatus } from './views/sched.ts'
import { difficultyCalibration, nominalBudget, readDailyGoal, readDayCutoff, streakFrom, sumXp, writeDailyGoal, writeDayCutoff } from './xp.ts'
export class SchedSubsystem {
  constructor(private e: SchedDeps) {}

// ---- 门面原分节：skip ----
// ---- 门面原分节：xp ----
// ---- 门面原分节：mem ----
// ---- 门面原分节：opt ----
// ---- 门面原分节：sed ----


  /** 跳过（已有基础）：stage 置 skipped，调度视同已通过；取消跳过回 ready。
   * 跳过即归档（ADR-0032）：该节点全部未归档题记原因 skip 后归档——跳过的语义是
   * 「视同已通过、退出推荐与阻塞」，其题库随之整体退场（休眠题不再占软上限额度、
   * 已调度题不再制造题库噪音）；取消跳过不自动恢复，恢复是显式动作
   * （题库管理面按原因 skip 筛出恢复）。 */
  async nodeSkip(courseKey: string | undefined, node: string, skipped: boolean): Promise<{ course: string; node: string; stage: Stage; archived?: number }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[skip] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'skip')
    if (!state[node]) await this.e.ensureNote(c.root, graph, node)
    const stage: Stage = skipped ? 'skipped' : 'ready'
    const [, regionName] = graph.blockOf[node]
    const path = this.e.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (fm) await saveNote(path, { ...fm, stage } as unknown as Record<string, unknown>, body)
    let archived: number | undefined
    if (skipped) {
      const courseRoot = this.e.paths.courseRoot(c.root)
      const bank = await this.e.bank.load(courseRoot, node)
      const n = await this.e.bank.archiveQuestions(
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
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[complete] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'complete')
    if (!state[node]) await this.e.ensureNote(c.root, graph, node)
    const courseRoot = this.e.paths.courseRoot(c.root)
    const bank = await this.e.bank.load(courseRoot, node)
    let attempts = 0
    let correct = 0
    for (const q of bank.questions) {
      if (q.archived) continue
      attempts += q.stats?.attempts ?? 0
      correct += q.stats?.correct ?? 0
    }
    const accuracy = attempts ? round2(correct / attempts) : null
    if (state[node]?.stage === 'mastered' || state[node]?.stage === 'skipped') {
      return { accepted: true, accuracy, course: c.name, node, stage: state[node].stage, initialized: 0, due: null }
    }
    if (!force && attempts >= 3 && accuracy !== null && accuracy < PASS_SCORE) {
      return {
        accepted: false, accuracy, course: c.name, node,
        reason: `正确率 ${Math.round(accuracy * 100)}% 低于及格线（${PASS_SCORE}），建议明天再来或先复习前置概念。`,
      }
    }
    const sched = await this.e.sched(courseRoot)
    const { today } = await this.e.learningDay()
    let initialized = 0
    let due: string | null = null
    let repCard: FsrsBlock | null = null
    const [, regionName] = graph.blockOf[node]
    const path = this.e.paths.courseNotePath(c.root, regionName, node)
    // stage 守卫的幂等判据（声明给三步共用）：frontmatter 已是 review = 该块已落，续段跳过
    const stageAlreadyReview = async () => {
      const { fm: rawFm } = await loadNote(path)
      const f = asFm(rawFm)
      return Boolean(f && f.stage === 'review')
    }
    // 写入单元（#176）：写序照今天的声明——「合成首刷 → 满分 bonus → stage→review
    // → T1/T2 入队 → XP 对账」。后三步共用 stage 幂等判据（今天同款：转 review 后
    // 重放时 4b/4c 被永久跳过，不收敛——照迁并登记）；满分 bonus 今天无存在检查，
    // 重复完成可重复追加（照迁并登记）。失败上抛中止，不回滚不续跑，失败不写 journal。
    await runWriteUnit('nodeComplete', {
      clock: this.e.clock,
      journal: rec => this.e.store.appendJournal(rec),
      steps: [
        {
          // 逐题 fsrs?.reps 内部跳过（幂等在步骤内：合成首刷只发生一次）
          name: '题卡合成首刷',
          run: async () => {
            for (const q of bank.questions) {
              if (q.archived) continue
              if (q.fsrs?.reps) {
                const d = q.fsrs.due
                if (d && (!due || d < due)) { due = d; repCard = q.fsrs }
                continue
              }
              const { fs } = applyRatingBlock(null, 3, today, sched)
              await this.e.bank.updateQuestionEvidence(courseRoot, node, q.id, { fsrs: fs })
              // 复习日志：合成首复习是调度初始化不是真实作答 → rating_source='synthetic'、
              // 无「复习前」状态（快照三字段 null），诚实度统计（#61）不算它。
              await this.e.store.appendReview({
                course: c.name, node, qid: q.id,
                rating: 3, rating_source: 'synthetic', elapsed_days: 0,
                stability_before: null, difficulty_before: null, r_pred: null,
              })
              initialized++
              if (!due || fs.due < due) { due = fs.due; repCard = fs }
            }
          },
        },
        {
          // 满分 bonus：本节点全部题都做过且全对 → 额外 XP（journal 流水，kind='xp_bonus'）。
          // 预算制下它是过程信号——下面的 xp_settle 对账会把它吸收进完成定价。
          name: '满分 bonus journal',
          run: async () => {
            if (attempts > 0 && correct === attempts) {
              await this.e.store.appendJournal({
                course: c.name, node, rating: null, kind: 'xp_bonus', elapsed_days: 0,
                xp: XP_PERFECT_BONUS, detail: `满分完成 +${XP_PERFECT_BONUS} XP`,
              })
            }
          },
        },
        {
          name: '节点 frontmatter stage→review（含聚合代表卡）',
          done: stageAlreadyReview,
          run: async () => {
            const { fm: rawFm, body } = await loadNote(path)
            const fm = asFm(rawFm)
            if (!(fm && fm.stage !== 'review')) return
            const next: Fm = { ...fm, stage: 'review' }
            if (repCard) next.fsrs = repCard
            await saveNote(path, next as unknown as Record<string, unknown>, body)
          },
        },
        {
          name: 'T1/T2 生成队列入队',
          done: stageAlreadyReview,
          run: async () => {
            await this.e.content.onStageChange(c.root, graph, (await this.e.loadView(c)).state, node, 'review')
          },
        },
        {
          // XP 预算制完成对账：净 XP 收敛到完成时刻的 N = N₀ × k（est 内容定价 × FSRS 难度校准），
          // 并就此锁定（重复完成与后续复习作答不再改定价；乱猜/满分 bonus 等过程信号被对账吸收）。
          name: 'XP 预算对账',
          done: stageAlreadyReview,
          run: async () => {
            const activeQs = bank.questions.filter(q => !q.archived)
            const budget = Math.round(nominalBudget(graph.estOf[node], activeQs) * difficultyCalibration(activeQs))
            let earned = 0
            for (const rec of await this.e.store.practiceAll()) {
              if (rec.course === c.name && rec.node === node) earned += rec.xp ?? 0
            }
            for (const rec of await this.e.store.journalTail(c.name, Number.MAX_SAFE_INTEGER)) {
              if (rec.node === node) earned += rec.xp ?? 0
            }
            const delta = budget - earned
            if (delta !== 0) {
              await this.e.store.appendJournal({
                course: c.name, node, rating: null, kind: 'xp_settle', elapsed_days: 0,
                xp: delta,
                detail: `XP 预算对账：N₀=${nominalBudget(graph.estOf[node], activeQs)} × k=${difficultyCalibration(activeQs).toFixed(2)} = ${budget}，过程净 ${earned}`,
              })
            }
          },
        },
      ],
    })
    // 教练回合触发点·节点完成（#144）：完成落定后拉起就绪深度检查，随完成结果带出
    // （读侧感知，零写副作用；生长批裁决归 #145）。
    const coach = await this.e.coachCheckFor(c, today)
    return { accepted: true, accuracy, course: c.name, node, stage: 'review', initialized, due, coach }
  }

  /** XP 视图：今日 XP / streak / 每日目标 / 每课程 ETA。
   * ETA 预算制：剩余工作量 = Σ(未完成节点 N₀×k)——est 内容定价 × FSRS 难度校准，
   * 随作答证据积累自动校准；days = 剩余预算 ÷ 每日目标。 */
  async xpStatus(): Promise<XpStatus> {
    const { today, cutoff } = await this.e.learningDay()
    const [rawPractice, journal, activity, goal] = await Promise.all([
      this.e.store.practiceAll(),
      this.e.store.journalTail(null, Number.MAX_SAFE_INTEGER),
      this.e.store.activityCounts(cutoff),
      readDailyGoal(this.e.paths),
    ])
    // 勘误冲正按净值入 XP 账（ADR-0031）：streak 口径不变（行为条数，原流水仍在），
    // XP 值按冲正后的净值替换（作废归零、改判按对题补记）
    const practice = netPracticeRecs(rawPractice, await this.e.store.erratumAll())
    const eta: Array<{ course: string; remaining: number; done: number; per_node: number; days: number }> = []
    for (const c of await this.e.enabledCourses()) {
      const { graph, state, broken } = await this.e.loadView(c)
      assertNoBrokenNotes('eta', broken)
      const counts = { unseen: 0, ready: 0, learning: 0, review: 0, mastered: 0, skipped: 0 } as Record<Stage, number>
      for (const n of graph.names) counts[effectiveStage(state, n)]++
      const remaining = counts.unseen + counts.ready + counts.learning
      const done = counts.review + counts.mastered + counts.skipped
      let remainingXp = 0
      for (const n of graph.names) {
        const st = effectiveStage(state, n)
        if (st !== 'unseen' && st !== 'ready' && st !== 'learning') continue
        const bankDoc = await this.e.bank.load(this.e.paths.courseRoot(c.root), n)
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
    return { goal: await writeDailyGoal(this.e.paths, goal) }
  }


  /** 调整日界（state/learnhub.json 的 day_cutoff；ADR-0020）→ 生效 'HH:mm'。 */
  async setDayCutoff(value: string): Promise<{ day_cutoff: string }> {
    return { day_cutoff: await writeDayCutoff(this.e.paths, value) }
  }

  /** 统计页四面板聚合（xpStatus 的姊妹方法，只读）：每日负载预报（扫全部启用课程
   * 题库 q.fsrs.due，Anki Forecast 语义）、记忆状态分布（Stability/Difficulty/当前
   * 可回忆度直方图；R 复用 reviewQueue 的 retrievabilityBlock 口径按各课程参数现算）、
   * 真实保留率 + 预测对照 + 遗忘曲线（#60 review-log：只计 auto+self 的到期复习，
   * synthetic 与首学推进不计入）。无数据给空态（rate=null / 计数 0），不造假数据。 */
  async memoryHealth(today?: string): Promise<MemoryHealthDoc> {
    const { today: learningToday, cutoff } = await this.e.learningDay()
    today ??= learningToday
    const dues: string[] = []
    const samples: Array<{ stability: number | null; difficulty: number | null; r: number }> = []
    for (const c of await this.e.enabledCourses()) {
      const sched = await this.e.sched(this.e.paths.courseRoot(c.root))
      await this.e.scanCourseBanks(c, async (_node, bank) => {
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
    const dueReviews = dueReviewFirstPushes(await this.e.store.reviewLogAll(), cutoff)
    return {
      date: today,
      forecast: { horizon_days: FORECAST_DAYS, ...forecast(dues, today) },
      state: { scheduled: samples.length, ...stateHistograms(samples) },
      retention: trueRetention(dueReviews),
      calibration: calibrationBins(dueReviews),
      forgetting: forgettingCurve(dueReviews),
      // 预测-校准（#66 E4）：学习者 JOL vs 实际——与 FSRS 自预测校准（calibration）正交；
      // 配对数不足门槛时为 null（不显示）。只展示，不喂 canonical。
      jol: jolCalibration(await this.e.store.practiceAll()),
    }
  }

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
    meta?: OptimizeMeta
  }> {
    const seqs = trainingSequences(await this.e.store.reviewLogAll(), await readDayCutoff(this.e.paths))
    const count = sequenceReviews(seqs)
    if (count < OPTIMIZE_MIN_REVIEWS) {
      return { status: 'skipped', reason: `真实复习日志 ${count} 条，不足 ${OPTIMIZE_MIN_REVIEWS} 条——保持现参不训练（synthetic 已排除，每卡每天只计第一条）` }
    }
    const courses = await this.e.enabledCourses()
    if (!courses.length) return { status: 'skipped', reason: '没有启用课程，参数无处写回' }
    // 基线 = 现参（学习者级一套），走 resolveFsrsParams 唯一口径：沉淀正典（事实源）
    // → 任一启用课程的参数缓存 → 官方默认。对照基线必须与调度此刻实际生效的同一套，
    // 不因基线读取阻塞训练。
    const baseline = await resolveFsrsParams(this.e.paths, courses.map(c => c.root))
    let baselineParams = baseline.parameters ?? defaultParams()
    const baselineSource = baseline.source
    const baselineEval = await impl.evaluate(baselineParams, seqs)
    const { parameters, splitEval } = await impl.train(seqs)
    if (parameters.length !== FSRS6_PARAM_COUNT) {
      return { status: 'skipped', reason: `训练产出 ${parameters.length} 个参数，不是 FSRS-6 的 ${FSRS6_PARAM_COUNT} 个——拒绝写回` }
    }
    const newEval = await impl.evaluate(parameters, seqs)
    const meta = {
      trained_at: todayStr(new Date(this.e.clock.nowMs())),
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
    // 写入单元（#176）：步骤顺序照今天的声明——「正典 → 逐课程缓存镜像 → 缓存失效
    // → 投影重建」。正典与镜像双写的崩溃窗口是设计内降级（#139：缺缓存回落正典，
    // 收敛）；失败上抛中止，不回滚不续跑。
    const written: string[] = []
    await runWriteUnit('optimizeFsrsParams', {
      clock: this.e.clock,
      journal: rec => this.e.store.appendJournal(rec),
      steps: [
        {
          name: 'fsrs_params 落沉淀正典',
          run: async () => {
            await appendSedimentEvent(this.e.paths, { kind: 'fsrs_params', tier: 'immediate', payload: { parameters, meta } }, this.e.clock.nowMs())
          },
        },
        {
          name: '逐课程参数缓存镜像',
          run: async () => {
            for (const c of courses) {
              await atomicWrite(this.e.paths.fsrsParamsPath(c.root), JSON.stringify({ parameters, meta }, null, 1) + '\n')
              written.push(c.name)
            }
          },
        },
        {
          // 参数唯一写者在此：缓存调度器全部失效，后续推进用新参数
          name: '调度器缓存失效',
          run: async () => { this.e.schedCache.clear() },
        },
        {
          name: '学习者档案投影重建',
          run: async () => {
            await rebuildLearnerProfile(this.e.paths, foldSediment(await readSedimentCanon(this.e.paths)), this.e.clock.nowMs())
          },
        },
      ],
    })
    return { status: 'written', written, meta }
  }

  /** 出生即写：追加一条沉淀事件（六类事件骨架的唯一写入口；校验在 sediment 模块）。
   * 永不自动删除——内容层任何不可逆操作不写这里。 */
  async sedimentAppend(kind: SedimentKind, tier: SedimentTier, payload: Record<string, unknown>, concept?: string): Promise<SedimentEvent> {
    return appendSedimentEvent(this.e.paths, { kind, tier, payload, ...(concept !== undefined ? { concept } : {}) }, this.e.clock.nowMs())
  }


  /** 读侧单向的唯一消费口径：读正典 → 折叠（两次折叠同输入同输出）。教练折叠
   * （#144）等后续消费方一律从这里取，禁止再读内容层旧居所。 */
  async sedimentFold(): Promise<SedimentFold> {
    return foldSediment(await readSedimentCanon(this.e.paths))
  }


  /** 重建学习者档案投影（学习中心/沉淀/学习者档案.md；纯派生，手编必被覆盖）。 */
  async sedimentRebuildProfile(): Promise<string> {
    return rebuildLearnerProfile(this.e.paths, await this.sedimentFold(), this.e.clock.nowMs())
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
    const { today, cutoff } = await this.e.learningDay()
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
      const practice = await this.e.store.practiceAll()
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
      const dueReviews = dueReviewFirstPushes(await this.e.store.reviewLogAll(), cutoff)
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
}

// ---- 门面原模块级 helper（#152 随本域方法一并归位）----

/** 评估指标等小数的 4 位舍入（落盘元数据与文案共用）。 */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}
