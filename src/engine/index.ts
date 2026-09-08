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
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { Paths, safeFilename } from './paths.ts'
import { Registry } from './registry.ts'
import { Store } from './store.ts'
import { GraphStore, Graph, writeReadyList } from './graph.ts'
import { stateMap, loadNote, saveNote, defaultFrontmatter, asFm, validateNoteFrontmatter, hasReadyContent } from './notes.ts'
import type { BrokenNote } from './notes.ts'
import { getScheduler, applyRatingBlock, masteryOfFm, previewDue, retrievabilityBlock } from './srs.ts'
import { bandOffset, combinedDifficulty, startBand, sessionOrder } from './adaptive.ts'
import type { BandPref } from './adaptive.ts'
import { JOL_PREDICTIONS, JOL_SAMPLE_RATE, jolCalibration, jolDeviatedKeys, pickJolTargets } from './jol.ts'
import type { JolPrediction } from './jol.ts'
import { coachFeedback, COACH_DUE_HARD_R, COACH_HARD_D, withinCoachWindow } from './coach.ts'
import type { BandRec } from './coach.ts'
import { calibrationAdvice, tooEasyAdvice } from './bank-advice.ts'
import { bindingImpl, defaultParams, OPTIMIZE_MIN_REVIEWS, FSRS6_PARAM_COUNT, sequenceReviews, trainingSequences } from './optimize.ts'
import type { OptimizerImpl } from './optimize.ts'
import { sectionEntryOf } from './attribution.ts'
import { DIAGNOSTIC_SCORE, diagnosticView, evaluateSectionSignals, formatSignalDetail, parseRewriteDetail, parseSignalDetail } from './attribution.ts'
import type { DiagnosticItem, RewriteFact, SignalSnapshot } from './attribution.ts'
import { FORECAST_DAYS, calibrationBins, dueReviewFirstPushes, forecast, forgettingCurve, stateHistograms, trueRetention } from './memory.ts'
import { runAudit, effectiveStage } from './audit.ts'
import { analyzeGraph } from './analysis.ts'
import type { ScaleTarget } from './quality.ts'
import { graphHealthScore } from './health.ts'
import { Content } from './content.ts'
import { nodeTierOf, perSectionQuizTarget, genericQuizTarget } from './complexity.ts'
import type { ComplexityTier } from './complexity.ts'
import { GraphProposals } from './gengraph.ts'
import type { ApplyAudit, EditOp } from './gengraph.ts'
import { QuestionBank } from './question-bank.ts'
import type { BankDoc, BankQuestion } from './question-bank.ts'
import { NoteSourceManifest, NOTE_SOURCE_COURSE, classifySource, collectNoteFiles, fingerprintOf, normalizeSourcePath, sourceHint, stripFrontmatter, titleOfBody } from './note-source.ts'
import type { NoteSourceManifestItem, NoteSourceStatus } from './note-source.ts'
import { LearnerCards, LEARNER_CARD_KINDS } from './learner-cards.ts'
import type { LearnerCard, LearnerCardDoc } from './learner-cards.ts'
import { selfNoteFeedbackPrompt, selfNoteFeedbackSystem, selfNotePromptOf } from './self-note.ts'
import { AnkiMirror, ankiAddNote, ankiCardPayload, ankiCardReviews, ankiCardsInfo, ankiCreateDeck, ankiCreateModel, ankiDeckNames, ankiDeleteNotes, ankiFindNotes, ankiModelNames, ankiNotesInfo, ankiUpdateNoteFields, deckNameOf, isAnkiNoteMissing, isoFromMs, mapAnkiEase, parseSourceKey, planMirrorSync, sameDayAdvanced, ANKI_MODEL, ANKI_TAG } from './anki.ts'
import type { AnkiMirrorEntry, AnkiNotePayload, AnkiTransport } from './anki.ts'
import { explainBackPack, explainFeedbackSystem, explainFeedbackPrompt, parseExplainVerdict } from './explain.ts'
import type { ExplainPoint, ExplainTag, ExplainVerdict } from './explain.ts'
import { YAML } from './yaml.ts'
import { Sessions, assertNoBrokenNotes, withinStruggleWindow } from './sessions.ts'
import type { NodeStat, WindowStat } from './sessions.ts'
import { todayStr, nowIso } from './dates.ts'
import { atomicWrite } from './store.ts'
import { REFLECTION_GRADING_SYSTEM, parseReflectionGrading, OPEN_QUESTION_GRADING_SYSTEM, parseOpenGrading, evaluateAllo, PASS_SCORE, applyPracticeEvidence } from './grading.ts'
import { xpForAnswer, readDailyGoal, writeDailyGoal, sumXp, streakFrom, nominalBudget, difficultyCalibration } from './xp.ts'
import { XP_GUESS_SECONDS, XP_PERFECT_BONUS } from './params.ts'
import type { CourseEntry, EArchiveRec, Fm, FsrsBlock, GNode, NoteSourceEntry, ReviewRec, SectionManifest, Stage } from './types.ts'
import type { AlloKind } from './grading.ts'
import { dataCheck } from './data-check.ts'
import type { DataCheckReport } from './data-check.ts'

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
  readonly bank: QuestionBank
  readonly learnerCards: LearnerCards
  readonly sessions: Sessions
  /** vault 根目录（笔记源注册路径归一用；posix 规范形态）。 */
  readonly vaultRoot: string
  /** JOL 抽查的随机源（#66 E4）：可注入播种（测试确定性；运行时 Math.random）。 */
  jolRng: () => number = Math.random

  constructor(config: EngineConfig) {
    const centerRel = (config.centerRel ?? '学习中心').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const vault = config.vault.replace(/\\/g, '/').replace(/\/+$/, '')
    const centerRoot = `${vault}/${centerRel}`
    this.vaultRoot = vault
    this.paths = new Paths(centerRoot)
    this.registry = new Registry(this.paths)
    this.store = new Store(this.paths)
    this.content = new Content(this.paths)
    this.bank = new QuestionBank(this.paths)
    this.learnerCards = new LearnerCards(this.paths)
    this.noteManifest = new NoteSourceManifest(this.paths)
    this.ankiMirror = new AnkiMirror(this.paths)
    this.proposals = new GraphProposals(this.paths, this.store, this.registry, centerRoot)
    this.sessions = new Sessions(this.paths, async course => this.loadView(course))
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

  async statusJson(): Promise<Record<string, unknown>> {
    const [stats, diagnostics] = await Promise.all([this.bankSnapshot(), this.diagnosticsAdvice()])
    const doc = await this.sessions.statusJson(await this.enabledCourses(), stats)
    // 内容诊断建议项（#69 B1）：每课程附 diagnostics（信号/理由/证据 + 重写与讲解直达入口）
    for (const course of doc.courses as Array<Record<string, unknown>>) {
      const items = diagnostics.filter(d => d.course === course.name)
      if (items.length) course.diagnostics = items.map(d => diagnosticView(d))
    }
    return doc
  }

  async recommend(limit = 5): Promise<Record<string, unknown>> {
    const [stats, window, diagnostics, pins] = await Promise.all([
      this.bankSnapshot(), this.struggleWindow(), this.diagnosticsAdvice(), this.store.loadPins(),
    ])
    const events = await this.sessions.recommendEvents(await this.enabledCourses(), stats, todayStr(), limit, window, diagnostics, pins)
    return { date: todayStr(), events }
  }

  // ---- 「今天学它」pin（E3 #67 / ADR-0009 Learner Output）----

  /** pin 节点为今日推荐榜首：只改推荐读侧排序（课程内置顶、跨课按全局语义），
   * 保留就绪提示——未就绪节点不拒绝，软闸建议随事件带出。仅作用当日，次日自动
   * 失效；同一课程可叠加多个 pin（按 pin 序依次置顶）。节点不在图内 fail loud；
   * 写入时顺带清理过期条目。零调度副作用（不碰 canonical/XP/掌握度）。 */
  async pinToday(courseKey: string | undefined, node: string, today = todayStr()): Promise<{ course: string; node: string; date: string }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[pin] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.assertNoteOk(c, graph, broken, node, 'pin')
    const rest = (await this.store.loadPins())
      .filter(p => p.date === today && !(p.course === c.name && p.node === node))
    await this.store.savePins([...rest, { course: c.name, node, date: today }])
    return { course: c.name, node, date: today }
  }

  /** 取消 pin：移除该课程+节点的全部 pin（含过期条目），写入时顺带清理过期清单。 */
  async unpinToday(courseKey: string | undefined, node: string, today = todayStr()): Promise<{ course: string; node: string; pinned: false }> {
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
  async diagnosticsAdvice(today = todayStr()): Promise<DiagnosticItem[]> {
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
          list.push({ ...snap, day: r.ts.slice(0, 10) })
          signalsByNode.set(r.node, list)
        } else if (r.kind === 'content_section') {
          // detail 历史上只有节标题没有节 id（content.ts 契约）——按清单标题回退对齐
          const title = parseRewriteDetail(r.detail)
          if (!title) continue
          const list = rewritesByNode.get(r.node) ?? []
          list.push({ title, day: r.ts.slice(0, 10) })
          rewritesByNode.set(r.node, list)
        }
      }
      await this.scanCourseBanks(c, async (node, bank) => {
        const manifest = state[node]?.content.sections
        if (!manifest?.length) return // 无清单旧节点：节归因不适用（标题匹配不出的节不产建议）
        const attempts = practice
          .filter(r => r.course === c.name && r.node === node)
          .map(r => ({ qid: r.qid ?? '', day: r.ts.slice(0, 10), correct: r.correct }))
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
  private async struggleWindow(): Promise<Map<string, Map<string, WindowStat>>> {
    const today = todayStr()
    const out = new Map<string, Map<string, WindowStat>>()
    for (const r of await this.store.practiceAll()) {
      if (typeof r.correct !== 'boolean' || !withinStruggleWindow(r.ts, today)) continue
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
  private async bankSnapshot(): Promise<Map<string, NodeStat[]>> {
    const out = new Map<string, NodeStat[]>()
    const today = todayStr()
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

  async doctor(): Promise<Record<string, unknown>> {
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
      const audit = await runAudit(this.paths, c.root, c.name, graph, regions)
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
    courseKey?: string, elementsOnly = false, scaleTarget?: ScaleTarget | null,
  ): Promise<Record<string, unknown>> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state } = await this.loadView(c)
    const doc = await analyzeGraph(c.name, graph, state, this.store, scaleTarget)
    if (elementsOnly) return { nodes: doc.nodes, edges: doc.edges }
    return doc
  }

  // ---- 图探索（agent 逐步查询，不拉全图）----

  /** 单节点图详情：schema 字段值 + 直接邻域（succ）+ enc 边（含 note）+ 前置传递闭包。 */
  async graphNode(courseKey: string | undefined, node: string): Promise<Record<string, unknown>> {
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
      note: graph.noteOf[node],
      stage: effectiveStage(state, node),
      mastery: masteryOfFm(fm),
      content: fm?.content ? { version: fm.content.version, status: fm.content.status } : undefined,
      prereq_closure: closure,
    }
  }

  /** 区/块浏览：按区名/块名过滤的节点清单（探索某区域的结构与内容状态）。 */
  async graphBrowse(courseKey: string | undefined, region?: string, block?: string): Promise<Record<string, unknown>> {
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
  async graphPath(courseKey: string | undefined, from: string, to: string): Promise<Record<string, unknown>> {
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

  async graphPropose(kind: 'gen' | 'edit', yamlText: string): Promise<Record<string, unknown>> {
    if (kind !== 'gen' && kind !== 'edit') throw new Error(`[propose] 非法 kind: ${String(kind)}（只允许 gen/edit——拼错会被静默当成 gen 处理，已加防呆）`)
    return kind === 'edit' ? this.proposals.proposeEdit(yamlText) : this.proposals.proposeGen(yamlText)
  }

  async graphApply(kind: 'gen' | 'edit', pid?: number): Promise<Record<string, unknown>> {
    if (kind !== 'gen' && kind !== 'edit') throw new Error(`[apply] 非法 kind: ${String(kind)}（只允许 gen/edit）`)
    // audit 门禁：目标课程存在 ERROR 时拒绝 apply；warns 摘要 + 健康分随 findings 返回
    const pending = await this.store.takePending(kind, pid)
    const course = await this.registry.get(pending.course)
    let audit: ApplyAudit = { ok: true, warns: [], health: 0 }
    if (course) {
      const { graph } = await this.loadView(course)
      const result = await runAudit(this.paths, course.root, course.name, graph, graph.regions)
      audit = { ok: !result.failed, warns: result.warns.slice(0, 8), health: graphHealthScore(graph).score }
    }
    return kind === 'edit' ? this.proposals.applyEdit(pid, audit) : this.proposals.applyGen(pid, audit)
  }

  async graphReject(pid: number, note = ''): Promise<Record<string, unknown>> {
    return this.proposals.reject(pid, note)
  }

  // ---- enc 存量回填（ADR-0008 / #53；A3 启用试点课程时跑）----

  /** enc 存量回填入口：对试点课程里已有 Ready 内容、正文反哺候选非空、且候选尚未全落
   * enc 的非 practice 节点，批量生成一个 pending edit 提案（每节点一条 set_enc 整体替换：
   * 既有声明 enc 原样保留 + 补闭包内提升边，权重取调用强度）。可重入——已全覆盖节点不产生
   * op，重跑不会重复膨胀、不与已声明 enc 冲突；practice 节点维持合法空 enc 不动。
   * 提案走人审（ADR-0003 修订变更语义）：过审计后由 graphApply 生效，留痕可回溯。 */
  async graphEncBackfill(courseKey?: string): Promise<Record<string, unknown>> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    assertNoBrokenNotes('enc-backfill', broken)
    // 既有声明 enc 的原始形态在 region 节点上（图视图 encOf 丢 note）；一次性建表避免每节点线性扫
    const encOfNode = new Map(
      graph.regions.flatMap(r => r.blocks.flatMap(b => b.nodes)).map(n => [n.name, n.enc]),
    )
    const ops: EditOp[] = []
    let scanned = 0
    for (const node of graph.order) {
      const fm = state[node]
      if (!fm || !hasReadyContent(fm)) continue
      if (graph.typeOf[node] === 'practice') continue // practice 节点无题，enc: [] 合法空态
      const [, regionName] = graph.blockOf[node]
      const { body } = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
      if (!Content.candidateCallSites(body).size) continue
      scanned++
      const declared = encOfNode.get(node) ?? []
      const declaredName = new Set(declared.map(e => e.node))
      const target = [...declared]
      for (const p of Content.encPromotion(graph, node, body)) {
        if (declaredName.has(p.node)) continue
        target.push(p)
      }
      if (target.length === declared.length) continue // 候选已全落 enc → 无变更
      ops.push({ op: 'set_enc', node, enc: target })
    }
    if (!ops.length) {
      return { course: c.name, scanned, ops: 0, proposal: null, message: '没有需要回填的节点：候选已全落 enc，或没有可提升的反哺候选。' }
    }
    const yamlText = YAML.stringify({
      course: c.name,
      reason: `enc 反哺回填（ADR-0008 / #53）：${ops.length} 个节点按既有 Ready 内容补成分技能边`,
      ops,
    })
    const prop = await this.graphPropose('edit', yamlText)
    return {
      course: c.name, scanned, ops: ops.length, proposal: prop,
      message: `已为 ${ops.length} 个节点生成 pending edit 提案 #${String((prop as { id?: unknown }).id)}——过审后 learnhub_graph_apply(kind=edit) 生效（可重入，无遗漏则返回 ops=0）`,
    }
  }

  async graphProposals(status?: string, kind?: string): Promise<Record<string, unknown>[]> {
    return this.proposals.list(status, kind)
  }

  // ---- 内容管线 ----

  async contentPack(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[pack] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'pack')
    return this.content.contextPack(graph, state, node, c.name)
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
    const fixed = Content.fixRichBlocks(split.body)
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
  async contentReset(courseKey: string | undefined): Promise<{ course: string; nodes: string[]; trashed: string[] }> {
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
    return { course: c.name, nodes, trashed }
  }

  /** 单节正文落盘：门禁通过后按清单重组正文，该节置 ready/version+1；hints = enc 候选反哺提醒。 */
  async contentSection(courseKey: string | undefined, node: string, sectionId: string, md: string): Promise<{ version: number; title: string; hints: string[] }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[section] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'section')
    return this.content.sectionApply(c.root, graph, node, sectionId, md, rec => this.store.appendJournal({ ...rec, course: c.name }))
  }

  /** 节清单视图：manifest + 每节现正文（面板节进度/单节重写入口用；
   * 无清单旧节点回退为整篇重导出，全部 ready）。 */
  async contentSectionsView(courseKey: string | undefined, node: string): Promise<Array<SectionManifest & { md: string | null }>> {
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
    return manifest.map(s => ({ ...s, md: mdByTitle.get(s.title) ?? null }))
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

  async queueItemsAll(): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    for (const c of await this.enabledCourses()) {
      for (const it of await this.content.queueItems(c.root)) {
        out.push({ ...it, course: c.name })
      }
    }
    return out
  }

  async lesson(courseKey: string | undefined, node: string): Promise<Record<string, unknown>> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[lesson] 课程「${c.name}」中没有节点「${node}」。`)
    this.assertNoteOk(c, graph, broken, node, 'lesson')
    const lesson = await this.sessions.lesson(c.name, c.root, graph, state, node)
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
  async coursesTree(courseKey?: string): Promise<Record<string, unknown>> {
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

  /** 题目 → 作答视图（questions 与 reviewQueue 共用；matching 右列打乱防泄题）。 */
  private questionView(q: BankQuestion, i: number): Record<string, unknown> {
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
      lastCorrect: q.stats?.attempts ? (q.stats.correct / q.stats.attempts) >= 0.6 : null,
    }
  }

  /** 某节点题库题目列表（不含答案/评分要点；带到期日与作答统计——刷卡视图）。
   * mastery 与学习页/图/树同口径（masteryOfFm 派生），前端头部读数即此。
   * 笔记源卡（course=「笔记源」伪课程）同通道只读列出：漂移提示的「归档旧题」
   * 管理动作需要逐题清单（questionGet/questionArchive 同一伪课程路由约定）；
   * ADR-0010 v1 不套掌握度模型，响应不带 mastery。 */
  async questions(courseKey: string | undefined, node: string): Promise<Record<string, unknown>> {
    if (await this.isNoteSourceCourse(courseKey)) {
      const bank = await this.bank.load(this.paths.noteSourceDir, node)
      return {
        course: NOTE_SOURCE_COURSE, node,
        questions: bank.questions.filter(q => q.archived !== true)
          .map((q, i) => this.questionView(q, i)),
      }
    }
    const c = await this.registry.resolve(courseKey)
    const { state } = await this.loadView(c)
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    return {
      course: c.name, node,
      mastery: masteryOfFm(state[node]),
      questions: bank.questions.filter(q => q.archived !== true)
        .map((q, i) => this.questionView(q, i)),
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
   * 节点不在范围内任何课程的图内时 fail loud——拼错的直达入口不该静默空队列。 */
  async reviewQueue(
    courseKey?: string, node?: string, today = todayStr(), bandPref?: BandPref,
  ): Promise<Record<string, unknown>> {
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
      const sched = await getScheduler(this.paths, courseRoot)
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
    // 「课程/节点/题id」复合键对齐（qid 只在节点题库内唯一）。
    const jol = await this.jolConfig()
    if (jol.enabled && cards.length) {
      const deviated = jolDeviatedKeys(await this.store.practiceAll())
      const candidates = cards.map(c => ({
        key: `${c.course}/${c.node}/${String(c.id)}`,
        r: c.r as number,
        difficulty: c.difficulty as number | undefined,
      }))
      const marks = pickJolTargets(candidates, this.jolRng, { rate: jol.rate, deviated })
      cards.forEach((c, i) => {
        if (marks.has(candidates[i]!.key)) c.jol = true
      })
    }
    // 单节点「已调度题」会话（#57 A1 + #65 E5 带权偏好）：起点先验 = 节点 Mastery
    // → 目标难度带，再叠加显式带偏移（挑战抬高/简单放宽）；初始顺序按距先验带
    // 距离升序（会话内流式调整由会话方以纯规则驱动）。
    if (node !== undefined) {
      const band = Math.min(1, Math.max(0, startBand(mastery) + bandOffset(bandPref)))
      return { date: today, total: cards.length, band: Math.round(band * 1000) / 1000,
        cards: sessionOrder(cards as Array<Record<string, unknown> & { d: number }>, band) }
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
    return { date: today, total: cards.length, cards,
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
    llmComplete: (prompt: string, system?: string) => Promise<string>,
    courseKey: string | undefined, node: string, qid: string, answer: string,
    elapsedS?: number | null,
    opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null },
  ): Promise<Record<string, unknown>> {
    // 笔记源卡路由（C1 #59）：course=「笔记源」伪课程（与真实课程重名时课程优先），
    // node = 源 id——同复习自评语义，但无节点证据/XP/practice 流水。
    if (await this.isNoteSourceCourse(courseKey)) {
      return this.noteSourceAnswer(llmComplete, node, qid, answer, opts)
    }
    const predicted = this.jolPredicted(opts?.predicted)
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[question] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'question')
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    const idx = bank.questions.findIndex(q => q.id === qid)
    if (idx < 0) throw new Error(`[question] ${node} 的题库没有 ${qid}。`)
    const q = bank.questions[idx]
    const { score, feedback } = await this.judgeBankAnswer(llmComplete, q, answer)
    const correct = score >= PASS_SCORE
    // XP 时间账本：同日重复作答不记账（防刷）；乱猜（耗时过短且答错）负 XP。
    // 乱猜作答同时不推进 FSRS——难度证据（k 校准）只由认真作答驱动，防乱猜推高节点定价。
    const today = todayStr()
    const guessed = !correct && elapsedS !== null && elapsedS < XP_GUESS_SECONDS
    const repeated = (q.stats?.last === today && Boolean(q.fsrs?.reps)) || guessed
    const settle = xpForAnswer(q.kind, q.difficulty ?? 1, correct, elapsedS ?? null, !repeated)
    await this.store.appendPractice({
      course: c.name, node, ex: idx + 1, answer,
      correct, judge: q.kind, qid,
      feedback: feedback || undefined,
      elapsed_s: elapsedS ?? undefined,
      xp: settle.xp,
      ...(predicted ? { predicted } : {}),
    })
    // frontmatter 计数 + 练习证据 EMA（口径 B 的练习项；mastery 本身纯派生不落盘）
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    let next: Fm | null = null
    if (fm) {
      next = applyPracticeEvidence(fm, correct ? 1.0 : 0.0)
      // 刷卡模型：首答把节点从 ready/unseen 推进 learning（后续调度由题目聚合驱动）
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await saveNote(path, next as unknown as Record<string, unknown>, body)
      if (next.stage !== fm.stage) {
        const { state: stateNow } = await this.loadView(c)
        await this.content.onStageChange(c.root, graph, stateNow, node, next.stage)
      }
    }
    // 题目级 FSRS：作答对错映射 rating（对=3、错=1）推进该题调度并写回题库。
    // 每题每天至多推进一次：同日重复作答（「再做一次」）只记练习统计，
    // 不再碰调度卡——避免反复刷同一题把 reps/stability/due 推到失真位置。
    // 乱猜作答同样不碰卡（含首答）：难度证据（XP 预算的 k 校准）只由认真作答驱动。
    // 复习刷卡流（deferSchedule）答对时调度挂起：背面自评档位经 questionRate 落盘，
    // 挂起以 stats.pending_rating 标记（rate 的前置、forget 的互斥条件）。
    let fs: FsrsBlock | null
    let pendingRating = false
    let advanced = false
    // 复习日志（#60 ADR-0012）：只有真实推进才落一条；记录复习前 R/S/D 快照
    let reviewRec: Omit<ReviewRec, 'ts'> | null = null
    let previews: { hard: string; good: string; easy: string } | undefined
    if (guessed || (repeated && q.fsrs)) {
      fs = q.fsrs ?? null
    } else if (opts?.deferSchedule === true && correct) {
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
      pendingRating = true
      previews = {
        hard: previewDue(sched, q.fsrs ?? null, 2, today),
        good: previewDue(sched, q.fsrs ?? null, 3, today),
        easy: previewDue(sched, q.fsrs ?? null, 4, today),
      }
      fs = q.fsrs ?? null
    } else {
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
      const rating = correct ? 3 : 1
      const rPred = retrievabilityBlock(sched, q.fsrs, today)
      const pushed = applyRatingBlock(q.fsrs ?? null, rating, today, sched)
      fs = pushed.fs
      advanced = true
      reviewRec = {
        rating, rating_source: 'auto', elapsed_days: pushed.elapsed_days,
        stability_before: q.fsrs?.stability ?? null,
        difficulty_before: q.fsrs?.difficulty ?? null,
        r_pred: rPred,
      }
    }
    const stats = {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: (q.stats?.correct ?? 0) + (correct ? 1 : 0),
      last: today,
      ...(pendingRating ? { pending_rating: true } : {}),
    }
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { fsrs: fs, stats })
    if (reviewRec) await this.store.appendReview({ course: c.name, node, qid, ...reviewRec })
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
      // XP 时间账本：本次作答的结算结果
      xp: settle.xp,
      xp_reason: settle.reason,
    }
  }

  /** 题库题判卷（题库作答与笔记源作答共用）：reflection/open_question 走 AI 判卷
   * 通道（显式禁止规则判卷降级），其余 evaluateAllo 规则判卷。AI 输出不可解析时
   * 抛错——本次作答在边界失败，不写任何分数/卡/证据（#9 / ADR-0004 事务性）。 */
  private async judgeBankAnswer(
    llmComplete: (prompt: string, system?: string) => Promise<string>,
    q: BankQuestion, answer: string, op = 'question',
  ): Promise<{ score: number; feedback: string }> {
    if (q.kind === 'reflection' || q.kind === 'open_question') {
      const isOpen = q.kind === 'open_question'
      const prompt = isOpen
        ? `Lesson question (综合应用):\n${q.q}\n\nLearner's answer:\n${answer}`
          + (String(q.answer).trim() ? `\n\nReference points (参考要点):\n${String(q.answer)}` : '')
        : `Exercise prompt:\n${q.q}\n\nLearner's answer:\n${answer}\n\nGrading rubric (评分要点):\n${String(q.answer)}`
      const raw = await llmComplete(prompt, isOpen ? OPEN_QUESTION_GRADING_SYSTEM : REFLECTION_GRADING_SYSTEM)
      try {
        const v = isOpen ? parseOpenGrading(raw) : parseReflectionGrading(raw)
        return { score: isOpen ? v.score / 10 : v.score, feedback: v.feedback }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`[${op}] AI 判卷输出不可用，本次作答未记录（请重试，或核对题目/模型输出）：${message}`)
      }
    }
    const r = evaluateAllo(q, answer)
    return { score: r.score, feedback: r.feedback }
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

  /** 复习刷卡流：答对后的自评结算（Hard/Good/Easy → FSRS 2/3/4）。
   * 前置 = 该题今天已由 deferSchedule 作答记账且调度仍挂起（stats.pending_rating）。
   * 只推卡：不记流水、不动 stats 计数、不给 XP（XP 在作答时已结算）；
   * 推完回刷节点聚合代表卡（refreshRepCard）。 */
  async questionRate(
    courseKey: string | undefined, node: string, qid: string, rating: number,
  ): Promise<Record<string, unknown>> {
    const r = Math.round(rating)
    if (r < 2 || r > 4) throw new Error(`[question-rate] 自评档位只能是 2/3/4（收到 ${String(rating)}）。`)
    // 笔记源卡路由（C1 #59）：自评结算进镜像题库，无代表卡回刷（笔记源无节点）。
    if (await this.isNoteSourceCourse(courseKey)) return this.noteSourceRate(node, qid, r)
    const { c, graph, q } = await this.questionContext(courseKey, node, qid, 'question-rate')
    const today = todayStr()
    if (q.stats?.last !== today || !q.stats?.pending_rating) {
      // 挂起标记是唯一准入：练习流作答与「完成学习」当日初始化（last_review=今天）都不产生挂起
      throw new Error(`[question-rate] ${node}/${qid} 今天没有待结算的自评（未作答或非挂起路径）。`)
    }
    const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
    const rPred = retrievabilityBlock(sched, q.fsrs, today)
    const pushed = applyRatingBlock(q.fsrs ?? null, r, today, sched)
    const fs = pushed.fs
    const { pending_rating: _drop, ...statsRest } = q.stats
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { fsrs: fs, stats: { ...statsRest } })
    await this.store.appendReview({
      course: c.name, node, qid,
      rating: r as ReviewRec['rating'], rating_source: 'self', elapsed_days: pushed.elapsed_days,
      stability_before: q.fsrs?.stability ?? null, difficulty_before: q.fsrs?.difficulty ?? null, r_pred: rPred,
    })
    // 自评落盘后回刷代表卡；mastery 与全端同口径（口径 B 派生），自评本身不额外改证据
    const fmNow = await this.refreshRepCard(c, graph, node)
    return {
      course: c.name, node, qid, rating: r,
      due: fs.due,
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
  ): Promise<Record<string, unknown>> {
    // 笔记源卡路由（C1 #59）：忘记申报进镜像题库，无节点证据（笔记源无 frontmatter）。
    if (await this.isNoteSourceCourse(courseKey)) return this.noteSourceForget(node, qid)
    const { c, graph, q, idx } = await this.questionContext(courseKey, node, qid, 'question-forget')
    const pred = this.jolPredicted(predicted)
    const today = todayStr()
    if (q.stats?.last === today) {
      throw new Error(`[question-forget] ${node}/${qid} 今天已有作答记录，忘记只用于本日首次刷卡。`)
    }
    const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
    const rPred = retrievabilityBlock(sched, q.fsrs, today)
    const pushed = applyRatingBlock(q.fsrs ?? null, 1, today, sched)
    const fs = pushed.fs
    await this.store.appendPractice({
      course: c.name, node, ex: idx + 1, answer: '',
      correct: false, judge: 'forget', qid,
      elapsed_s: elapsedS ?? undefined,
      xp: 0,
      ...(pred ? { predicted: pred } : {}),
    })
    // 节点侧证据：忘记 = 0 分（EMA 衰减 + 计一次未过），stage 推进与作答路径一致
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    let next: Fm | null = null
    if (fm) {
      next = applyPracticeEvidence(fm, 0.0)
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await saveNote(path, next as unknown as Record<string, unknown>, body)
      if (next.stage !== fm.stage) {
        const { state: stateNow } = await this.loadView(c)
        await this.content.onStageChange(c.root, graph, stateNow, node, next.stage)
      }
    }
    const stats = {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: q.stats?.correct ?? 0,
      last: today,
    }
    await this.bank.updateQuestionEvidence(this.paths.courseRoot(c.root), node, qid, { fsrs: fs, stats })
    await this.store.appendReview({
      course: c.name, node, qid,
      rating: 1, rating_source: 'auto', elapsed_days: pushed.elapsed_days,
      stability_before: q.fsrs?.stability ?? null, difficulty_before: q.fsrs?.difficulty ?? null, r_pred: rPred,
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
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(c.root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (!fm) return null
    if (!rep) return fm
    const cur = fm.fsrs
    if (cur && cur.stability === rep.stability && cur.difficulty === rep.difficulty && cur.due === rep.due
      && cur.last_review === rep.last_review && cur.reps === rep.reps && cur.lapses === rep.lapses) return fm
    const next: Fm = { ...fm, fsrs: rep }
    await saveNote(path, next as unknown as Record<string, unknown>, body)
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
   * 文件夹批量登记时逐文件归一；学习中心内部的 .md（如注册 vault 根）跳过不失败。 */
  async noteSourceRegister(
    input: string, today = todayStr(),
  ): Promise<{ date: string; registered: number; updated: number; skipped: number; sources: Array<Record<string, unknown>> }> {
    const rel0 = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, input)
    const files = await collectNoteFiles(`${this.vaultRoot}/${rel0}`)
    if (!files.length) throw new Error('[note-source] 该路径下没有 .md 笔记。')
    const entries = await this.registry.loadNoteSources()
    const manifest = await this.noteManifest.load()
    const byPath = new Map(entries.map(e => [e.path, e]))
    let registered = 0
    let updated = 0
    let skipped = 0
    for (const f of files) {
      let rel: string
      try {
        rel = normalizeSourcePath(this.vaultRoot, this.paths.centerRoot, f.abs)
      } catch (err) {
        if (!(err instanceof Error) || !/学习中心内部/.test(err.message)) throw err
        skipped++ // 文件夹批量登记扫到引擎管理区文件：跳过（不收编、不让整批失败）
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
    return { date: today, registered, updated, skipped, sources: view.sources }
  }

  /** 笔记源清单：注册身份（注册表）× 指纹状态（源清单 + 现读文件）× 卡池概况。
   * 用户笔记永不判 Broken：文件缺失 = missing、指纹不符 = drifted、清单条目缺失 =
   * inconsistent（镜像不一致，data-check 同步报出），状态与提示随条目带出。 */
  async noteSourceList(today = todayStr()): Promise<{ date: string; total: number; sources: Array<Record<string, unknown>> }> {
    const entries = await this.registry.loadNoteSources()
    const manifest = await this.noteManifest.load()
    const itemById = new Map(manifest.sources.map(s => [s.id, s]))
    const out: Array<Record<string, unknown>> = []
    for (const e of entries) {
      const { status, title } = await this.sourceStatusOf(e, itemById.get(e.id))
      let cards = 0
      let due = 0
      let bankBroken: string | undefined
      if (existsSync(this.bank.bankPath(this.paths.noteSourceDir, e.id))) {
        try {
          const bank = await this.bank.load(this.paths.noteSourceDir, e.id)
          for (const q of bank.questions) {
            if (q.archived) continue
            cards++
            if (q.fsrs?.reps && q.fsrs.due <= today) due++
          }
        } catch (err) {
          bankBroken = err instanceof Error ? err.message.split('\n')[0] : String(err)
        }
      }
      const hint = bankBroken ? `题库镜像 Broken：${bankBroken}` : sourceHint(status)
      out.push({
        id: e.id, path: e.path, title, enabled: e.enabled !== false, created: e.created,
        status, cards, due,
        ...(hint ? { hint } : {}),
        ...(bankBroken ? { broken: true } : {}),
      })
    }
    return { date: today, total: out.length, sources: out }
  }

  /** 解除注册：注册表条目 + 源清单条目 + 镜像题库一并清除；用户笔记文件不动。 */
  async noteSourceUnregister(id: string): Promise<{ removed: string; path: string }> {
    const { entry } = await this.requireSource(id)
    await this.registry.save(await this.registry.load(), (await this.registry.loadNoteSources()).filter(e => e.id !== id))
    const manifest = await this.noteManifest.load()
    await this.noteManifest.save({ sources: manifest.sources.filter(s => s.id !== id) })
    const bankPath = this.bank.bankPath(this.paths.noteSourceDir, id)
    if (existsSync(bankPath)) await unlink(bankPath)
    return { removed: id, path: entry.path }
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

  /** 笔记源出题：读笔记正文（只读）→ 笔记出题 prompt + llm → validateBank 门禁逐题
   * 落镜像题库（学习中心/笔记源/题库/<源id>.yaml）→ 新卡初始化 FSRS（同完成学习的
   * 合成首复习语义，明天起刷，rating_source=synthetic 落复习日志）→ 源清单指纹刷新
   * （出题读的是当前内容，漂移就此确认；旧卡不自动归档，归档是独立动作）。 */
  async noteSourceGenerate(
    id: string, count: number | undefined,
    llm: (prompt: string) => Promise<string>,
    today = todayStr(),
  ): Promise<{ id: string; added: number; skipped: number; total: number }> {
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
    const rawOut = await llm(`${tpl}\n\n## 题目数量\n\n${requested} 道\n\n---\n\n${body}`)
    const doc = YAML.parseModel(rawOut) as { questions?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions) || !doc.questions.length) {
      throw new Error('[note-quiz] 模型没有产出可用题目（questions 为空）。')
    }
    let added = 0
    let skipped = 0
    for (const rawQ of doc.questions.slice(0, requested)) {
      const q = { ...((rawQ ?? {}) as Record<string, unknown>) }
      delete q.id // id 由 addQuestion 按现有卡数自动编号
      try {
        await this.bank.addQuestion(this.paths.noteSourceDir, id, q)
        added++
      } catch {
        skipped++ // 单题非法（如超纲题型）不毁整批
      }
    }
    if (!added) throw new Error('[note-quiz] 模型产出的题目全部未过校验门（题型/答案格式不符），一道都没入库。')
    // 新卡合成首复习初始化（同 nodeComplete 语义：明天起刷）
    const sched = await getScheduler(this.paths, null)
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
    return { id, added, skipped, total: bank.questions.length }
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
    const sched = await getScheduler(this.paths, null)
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
          title: item?.title ?? title, r: Math.round(r * 1000) / 1000,
          d: Math.round(combinedDifficulty(q.difficulty, q.fsrs) * 1000) / 1000,
          ...card,
        })
      })
    }
    return { cards, drifted, suspended }
  }

  /** 笔记源卡一次评分推进（作答/自评/忘记三通道共用）：推镜像题库卡 + 落复习日志
   * （course=笔记源；调度器用默认参数——笔记源不挂课程个人参数）。返回新 fsrs 块。 */
  private async pushNoteCard(
    sourceId: string, q: BankQuestion, fsOld: FsrsBlock | null,
    rating: 1 | 2 | 3 | 4, ratingSource: 'auto' | 'self', today: string,
    stats: BankQuestion['stats'],
  ): Promise<FsrsBlock> {
    const sched = await getScheduler(this.paths, null)
    const rPred = retrievabilityBlock(sched, fsOld, today)
    const pushed = applyRatingBlock(fsOld, rating, today, sched)
    await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, sourceId, q.id, { fsrs: pushed.fs, stats })
    await this.store.appendReview({
      course: NOTE_SOURCE_COURSE, node: sourceId, qid: q.id,
      rating, rating_source: ratingSource, elapsed_days: pushed.elapsed_days,
      stability_before: fsOld?.stability ?? null, difficulty_before: fsOld?.difficulty ?? null, r_pred: rPred,
    })
    return pushed.fs
  }

  /** 笔记源作答（C1 #59）：判卷同题库通道；推进只有题目级 FSRS + 复习日志
   * （course=笔记源）——无节点证据、无 practice 流水、无节点定价/settle（同复习
   * 自评语义，ADR-0010）、无代表卡（笔记源没有节点）。 */
  private async noteSourceAnswer(
    llmComplete: (prompt: string, system?: string) => Promise<string>,
    sourceId: string, qid: string, answer: string,
    opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null },
  ): Promise<Record<string, unknown>> {
    const bank = await this.bank.load(this.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { score, feedback } = await this.judgeBankAnswer(llmComplete, q, answer)
    const correct = score >= PASS_SCORE
    const today = todayStr()
    const repeated = q.stats?.last === today && Boolean(q.fsrs?.reps)
    let fs: FsrsBlock | null
    let pendingRating = false
    let advanced = false
    let previews: { hard: string; good: string; easy: string } | undefined
    const stats = {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: (q.stats?.correct ?? 0) + (correct ? 1 : 0),
      last: today,
    }
    if (repeated) {
      fs = q.fsrs ?? null
      await this.bank.updateQuestionEvidence(this.paths.noteSourceDir, sourceId, qid, { fsrs: fs, stats })
    } else if (opts?.deferSchedule === true && correct) {
      const sched = await getScheduler(this.paths, null)
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
      xp: 0, // 复习自评语义不含 XP（笔记源无节点定价与 settle）
    }
  }

  /** 笔记源自评结算：挂起标记唯一准入，推卡 + 复习日志（self），无代表卡回刷。 */
  private async noteSourceRate(sourceId: string, qid: string, r: number): Promise<Record<string, unknown>> {
    const bank = await this.bank.load(this.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-rate] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const today = todayStr()
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
    const today = todayStr()
    if (q.stats?.last === today) {
      throw new Error(`[question-forget] 笔记源 ${sourceId}/${qid} 今天已有推进记录，忘记只用于本日首次。`)
    }
    const fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, 1, 'auto', today, {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: q.stats?.correct ?? 0,
      last: today,
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
   * 来源字段 = 课程/节点/题id，回写归属与清单丢失自愈的依据。 */
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
    return out
  }

  /** 导出推送：按 vault 到期集校准/重建镜象卡组——新增缺卡、更新改题（fp 变化）、
   * 移除已归档/已重生成/已被 vault 消费的旧卡；镜象与 vault 不一致时以 vault 为
   * 准，Anki 侧排期输出不作数（ADR-0011）。Anki 侧手动删过的笔记自动重建。 */
  async ankiExportPush(transport: AnkiTransport, today = todayStr()): Promise<{
    date: string; added: number; updated: number; removed: number; total: number; decks: string[]
  }> {
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
    // 课程上下文缓存：registry/loadView/scheduler 每课程一次
    type AnkiCourseCtx = { c: CourseEntry; graph: Graph; sched: Awaited<ReturnType<typeof getScheduler>> } | null
    const ctxCache = new Map<string, AnkiCourseCtx>()
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
      let ctx = ctxCache.get(loc.course)
      if (ctx === undefined) {
        const c = await this.registry.get(loc.course)
        if (!c) ctx = null
        else {
          const { graph } = await this.loadView(c)
          ctx = { c, graph, sched: await getScheduler(this.paths, this.paths.courseRoot(c.root)) }
        }
        ctxCache.set(loc.course, ctx)
      }
      if (!ctx) { noteUnknown('课程不在注册表'); continue }
      const courseRoot = this.paths.courseRoot(ctx.c.root)
      const bank = await this.bank.load(courseRoot, loc.node)
      const idx = bank.questions.findIndex(x => x.id === loc.qid)
      const q = idx >= 0 ? bank.questions[idx] : undefined
      if (!q || q.archived) { noteUnknown('题目已归档或重生成'); continue }
      let map: ReturnType<typeof mapAnkiEase>
      try {
        map = mapAnkiEase(ev.button)
      } catch {
        result.skipped_unknown++
        continue
      }
      const iso = isoFromMs(ev.ts)
      const day = iso.slice(0, 10)
      const practiceBase = {
        course: ctx.c.name, node: loc.node, ex: idx + 1, answer: '',
        correct: map.correct, judge: 'review', qid: loc.qid,
        ...(ev.timeMs > 0 ? { elapsed_s: ev.timeMs / 1000 } : {}),
        xp: 0,
      }
      if (sameDayAdvanced(q, day)) {
        // 当日已推进：跳过调度只留档（fsrs/stats/复习日志零写入）
        await this.store.appendPractice({ ...practiceBase, ts: iso })
        result.skipped_same_day++
        continue
      }
      const rPred = retrievabilityBlock(ctx.sched, q.fsrs, day)
      const pushed = applyRatingBlock(q.fsrs ?? null, map.rating, day, ctx.sched)
      const stats = {
        attempts: (q.stats?.attempts ?? 0) + 1,
        correct: (q.stats?.correct ?? 0) + (map.correct ? 1 : 0),
        last: day,
      }
      await this.bank.updateQuestionEvidence(courseRoot, loc.node, loc.qid, { fsrs: pushed.fs, stats })
      await this.store.appendPractice({ ...practiceBase, ts: iso })
      await this.store.appendReview({
        course: ctx.c.name, node: loc.node, qid: loc.qid,
        rating: map.rating, rating_source: map.ratingSource, elapsed_days: pushed.elapsed_days,
        stability_before: q.fsrs?.stability ?? null, difficulty_before: q.fsrs?.difficulty ?? null, r_pred: rPred,
      })
      // 代表卡随真实推进回刷（口径 B 稳定度分量随复习前进；与站内复习同一语义）
      await this.refreshRepCard(ctx.c, ctx.graph, loc.node)
      q.fsrs = pushed.fs // 后续同日事件在内存里立即可见（不变量判定不重读盘）
      q.stats = stats
      result.advanced++
    }
    mirror.last_import_ms = lastMs
    await this.ankiMirror.save(mirror)
    return result
  }

  /** Anki 通道状态：镜象规模/最近推送与导入/当前到期分布 + AnkiConnect 可达性。 */
  async ankiStatus(transport?: AnkiTransport, today = todayStr()): Promise<Record<string, unknown>> {
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

  /** 跳过（已有基础）：stage 置 skipped，调度视同已通过；取消跳过回 ready。 */
  async nodeSkip(courseKey: string | undefined, node: string, skipped: boolean): Promise<{ course: string; node: string; stage: Stage }> {
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
    return { course: c.name, node, stage }
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
    const sched = await getScheduler(this.paths, courseRoot)
    const today = todayStr()
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
    return { accepted: true, accuracy, course: c.name, node, stage: 'review', initialized, due }
  }

  // ---- XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注） ----

  /** XP 视图：今日 XP / streak / 每日目标 / 每课程 ETA。
   * ETA 预算制：剩余工作量 = Σ(未完成节点 N₀×k)——est 内容定价 × FSRS 难度校准，
   * 随作答证据积累自动校准；days = 剩余预算 ÷ 每日目标。 */
  async xpStatus(): Promise<Record<string, unknown>> {
    const today = todayStr()
    const [practice, journal, activity, goal] = await Promise.all([
      this.store.practiceAll(),
      this.store.journalTail(null, Number.MAX_SAFE_INTEGER),
      this.store.activityCounts(),
      readDailyGoal(this.paths),
    ])
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
    return { date: today, today_xp: sumXp(practice, journal, today), goal, streak: streakFrom(activity, today), eta }
  }

  /** 调整每日 XP 目标（state/learnhub.json）。 */
  async setDailyGoal(goal: number): Promise<{ goal: number }> {
    return { goal: await writeDailyGoal(this.paths, goal) }
  }

  // ---- 记忆健康仪表盘（#61 A2 / ADR-0012）----

  /** 统计页四面板聚合（xpStatus 的姊妹方法，只读）：每日负载预报（扫全部启用课程
   * 题库 q.fsrs.due，Anki Forecast 语义）、记忆状态分布（Stability/Difficulty/当前
   * 可回忆度直方图；R 复用 reviewQueue 的 retrievabilityBlock 口径按各课程参数现算）、
   * 真实保留率 + 预测对照 + 遗忘曲线（#60 review-log：只计 auto+self 的到期复习，
   * synthetic 与首学推进不计入）。无数据给空态（rate=null / 计数 0），不造假数据。 */
  async memoryHealth(today = todayStr()): Promise<Record<string, unknown>> {
    const dues: string[] = []
    const samples: Array<{ stability: number | null; difficulty: number | null; r: number }> = []
    for (const c of await this.enabledCourses()) {
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
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
    const dueReviews = dueReviewFirstPushes(await this.store.reviewLogAll())
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
    try {
      const doc = JSON.parse(await readFile(this.paths.learnhubConfigPath, 'utf8')) as {
        jol?: { enabled?: boolean; rate?: number }
      }
      const enabled = doc.jol?.enabled !== false
      const rate = typeof doc.jol?.rate === 'number' && doc.jol.rate > 0 && doc.jol.rate <= 1
        ? doc.jol.rate : JOL_SAMPLE_RATE
      return { enabled, rate }
    } catch {
      return { enabled: true, rate: JOL_SAMPLE_RATE }
    }
  }

  /** 写 JOL 抽查配置（原子替换，保留配置文件其他字段）。 */
  async setJolConfig(patch: { enabled?: boolean; rate?: number }): Promise<{ enabled: boolean; rate: number }> {
    let prev: Record<string, unknown> = {}
    try {
      prev = JSON.parse(await readFile(this.paths.learnhubConfigPath, 'utf8')) as Record<string, unknown>
    } catch {
      // 无配置文件/损坏 → 全新写入
    }
    const cur = await this.jolConfig()
    const next = { enabled: patch.enabled ?? cur.enabled, rate: patch.rate ?? cur.rate }
    await atomicWrite(this.paths.learnhubConfigPath, JSON.stringify({ ...prev, jol: next }, null, 1) + '\n')
    return next
  }

  /** JOL 预测值的显式契约：三档之外拒绝（参数错误），null/undefined 放行为无预测。 */
  private jolPredicted(p: JolPrediction | null | undefined): JolPrediction | null {
    if (p === null || p === undefined) return null
    if (!JOL_PREDICTIONS.includes(p)) {
      throw new Error(`[jol] 预测只能是「${JOL_PREDICTIONS.join('」「')}」之一（收到 ${String(p)}）。`)
    }
    return p
  }

  // ---- E5 可用的困难教练（#65；只读信息性反馈，无门禁无判分）----

  /** 难度带会话记录（会话结束反馈点调用，ReviewSession 收尾时带上当次带选择与
   * 作答结算）：append-only 落 state/难度带.jsonl。零调度副作用——只是教练的
   * 长期选择分布数据源（Learner Output）。 */
  async logBandSession(rec: { course: string; node: string; band: BandPref; answered: number; correct: number }, today = todayStr()): Promise<BandRec> {
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
  async coachAdvice(today = todayStr()): Promise<{ messages: string[]; due_hard: number }> {
    const courses = await this.enabledCourses()
    let dueHard = 0
    for (const c of courses) {
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
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
    llm: (prompt: string, system?: string) => Promise<string>,
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
   * 默认）与挖空重述（cloze_rewrite，content 须带 {{…}} 挖空）。入「我的卡」独立
   * 域隔离自调度；判词与卡都属 Learner Output，canonical 零写入。 */
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

  /** E 池到期队列：全部启用课程的「我的卡」，到期卡按 due 升序在前，从未调度的新卡
   * 随后（首推入口）。自评语义 = 先重述再翻面对照（Hard/Good/Easy + 忘记）；
   * 隔离自调度——不进全局复习队列、不产生 XP、不写复习日志（canonical 零掺入）。 */
  async learnerQueue(courseKey?: string, today = todayStr()): Promise<{
    date: string; total: number; due_count: number
    cards: Array<Record<string, unknown>>
  }> {
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

  /** E 卡自评结算（2/3/4）：新卡在此首推，老卡按档推进；一卡一天一次推进
   * （stats.last 把守）。只动卡自身的隔离调度块，canonical/日志/XP 零写入。 */
  async learnerCardRate(
    courseKey: string | undefined, node: string, cardId: string, rating: number,
  ): Promise<Record<string, unknown>> {
    const r = Math.round(rating)
    if (r < 2 || r > 4) throw new Error(`[learner-rate] 自评档位只能是 2/3/4（收到 ${String(rating)}）；忘记走 learner-forget。`)
    const { c, card } = await this.learnerCardContext(courseKey, node, cardId, 'learner-rate')
    const today = todayStr()
    if (card.stats?.last === today) {
      throw new Error(`[learner-rate] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    }
    const sched = await getScheduler(this.paths, null)
    const pushed = applyRatingBlock(card.fsrs ?? null, r, today, sched)
    const stats = {
      attempts: (card.stats?.attempts ?? 0) + 1,
      correct: (card.stats?.correct ?? 0) + 1,
      last: today,
    }
    await this.learnerCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats })
    return { course: c.name, node, id: cardId, rating: r, due: pushed.fs.due, scheduled: true }
  }

  /** E 卡忘记申报（rating=1）：不作答直接翻面，一卡一天一次，0 XP 零 canonical。 */
  async learnerCardForget(
    courseKey: string | undefined, node: string, cardId: string,
  ): Promise<Record<string, unknown>> {
    const { c, card } = await this.learnerCardContext(courseKey, node, cardId, 'learner-forget')
    const today = todayStr()
    if (card.stats?.last === today) {
      throw new Error(`[learner-forget] ${node}/${cardId} 今天已推进过（一卡一天一次）。`)
    }
    const sched = await getScheduler(this.paths, null)
    const pushed = applyRatingBlock(card.fsrs ?? null, 1, today, sched)
    const stats = {
      attempts: (card.stats?.attempts ?? 0) + 1,
      correct: card.stats?.correct ?? 0,
      last: today,
    }
    await this.learnerCards.updateCardEvidence(c.root, node, cardId, { fsrs: pushed.fs, stats })
    return { course: c.name, node, id: cardId, rating: 1, due: pushed.fs.due, scheduled: true, xp: 0 }
  }

  /** E1「加我的理解」节级入口（#70）：学习者用自己的话写一句解释/例子/助记
   * （锚点 = 节 id/标题），AI 对照该节已教要点给 是非 + 定位（含糊/跳跃/说错）
   * + 可怎么补——判词入 E 档案（kind=self_note），产出成独立域 LearnerCard。
   * ADR-0009 边界：零 XP、不写掌握度/FSRS/canonical；AI 判词不可解析时抛错，
   * 卡与判词零落盘（ADR-0004 事务性）。 */
  async learnerNoteAdd(
    courseKey: string | undefined, node: string,
    opts: { content: string; kind?: LearnerCard['kind']; prompt?: string; section?: string },
    llm: (prompt: string, system?: string) => Promise<string>,
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
    const raw = await llm(selfNoteFeedbackPrompt(points, sectionTitle, content), selfNoteFeedbackSystem())
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
  ): Promise<{ course: string; node: string; id: string; archived: boolean }> {
    const c = await this.registry.resolve(courseKey)
    await this.learnerCards.archiveCard(c.root, node, cardId, archived)
    return { course: c.name, node, id: cardId, archived }
  }

  // ---- FSRS 参数优化器（#62 A2 / ADR-0012）----

  /** 手动触发 FSRS-6 个人参数重训：数据 = 中心级跨课程复习日志的真实推进（排除
   * synthetic、每卡每天第一条）；门禁 = 真实条数 ≥400（官方口径）且训练后评估
   * （in-sample logLoss，新参/基线同协议对照）优于现参或默认参数，否则不写并返回
   * 跳过原因。参数是学习者级一套：写回每个启用课程的 fsrs参数.json（含元数据可
   * 追溯），getScheduler 读法零改动。impl 接缝供测试注入假优化器。 */
  async optimizeFsrsParams(
    impl: OptimizerImpl = bindingImpl,
  ): Promise<{
    status: 'written' | 'skipped'
    reason?: string
    written?: string[]
    meta?: Record<string, unknown>
  }> {
    const seqs = trainingSequences(await this.store.reviewLogAll())
    const count = sequenceReviews(seqs)
    if (count < OPTIMIZE_MIN_REVIEWS) {
      return { status: 'skipped', reason: `真实复习日志 ${count} 条，不足 ${OPTIMIZE_MIN_REVIEWS} 条——保持现参不训练（synthetic 已排除，每卡每天只计第一条）` }
    }
    const courses = await this.enabledCourses()
    if (!courses.length) return { status: 'skipped', reason: '没有启用课程，参数无处写回' }
    // 基线 = 现参（学习者级一套，任一启用课程文件里的就是同一套）；无文件 → 官方默认。
    // 参数文件损坏时与 getScheduler 同语义：忽略坏文件按默认参数对照（调度此刻实际生效
    // 的就是默认参数，对照基线必须与之同一），不因基线读取阻塞训练。
    let baselineParams = defaultParams()
    let baselineSource: 'previous' | 'default' = 'default'
    for (const c of courses) {
      try {
        const doc = JSON.parse(await readFile(this.paths.fsrsParamsPath(c.root), 'utf8')) as { parameters?: number[] }
        if (Array.isArray(doc.parameters) && doc.parameters.length === FSRS6_PARAM_COUNT) {
          baselineParams = doc.parameters
          baselineSource = 'previous'
          break
        }
      } catch {
        // 该课程无参数文件：继续找下一门（同为学习者级一套，任一命中即可）
      }
    }
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
      return { status: 'skipped', reason: `评估未优于${baselineSource === 'previous' ? '现' : '默认'}参数（logLoss ${round4(newEval.logLoss)} ≥ 基线 ${round4(baselineEval.logLoss)}）——不写回`, meta }
    }
    const written: string[] = []
    for (const c of courses) {
      await atomicWrite(this.paths.fsrsParamsPath(c.root), JSON.stringify({ parameters, meta }, null, 1) + '\n')
      written.push(c.name)
    }
    return { status: 'written', written, meta }
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
  async questionsAll(courseKey?: string): Promise<{ total: number; questions: Array<Record<string, unknown>> }> {
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
            archived: q.archived === true, hasExplanation: Boolean(q.explanation),
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

  /** 节点级只读检测：扫题库 stats（bank per-qid）+ masteryOfFm + 作答量门槛 →
   * {低掌握校准建议, 全对归档建议} 清单，供 orchestrator/harness 在出题与题目管理
   * 动作前消费。建议先行不自动改库——再生成走既有 question_generate/question_save
   * 与单节重写通道，归档走题目管理的独立归档操作；practice 节点无题库天然静默；
   * Broken 笔记 fail loud（与 status/recommend 同一门前置）。 */
  async difficultyAdvice(courseKey?: string): Promise<{ date: string; nodes: Array<Record<string, unknown>> }> {
    const courses = courseKey ? [await this.registry.resolve(courseKey)] : await this.enabledCourses()
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
        const tooEasy = tooEasyAdvice(qs)
        if (!calibration && !tooEasy.length) return
        nodes.push({
          course: c.name, node,
          ...(calibration ? { calibration } : {}),
          ...(tooEasy.length ? { too_easy: tooEasy } : {}),
        })
      })
    }
    return { date: todayStr(), nodes }
  }

  async questionAdd(courseKey: string, node: string, question: Record<string, unknown>): Promise<{ course: string; node: string; id: string; count: number }> {
    const c = await this.registry.resolve(courseKey)
    const r = await this.bank.addQuestion(this.paths.courseRoot(c.root), node, question)
    return { course: c.name, node, ...r }
  }

  /** 单题全量读取（含 answer/explanation）：修订/审题用——questionList 不带答案（作答流防泄题），改题前用这个看原题。
   * 笔记源卡（course=「笔记源」伪课程）同通道可读：漂移后审旧题用。 */
  async questionGet(courseKey: string | undefined, node: string, qid: string): Promise<Record<string, unknown>> {
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
   * 「归档旧题」直达动作走这里（学习中心/笔记源 镜像题库）。 */
  async questionArchive(courseKey: string, node: string, qid: string, archived: boolean): Promise<{ course: string; node: string; qid: string; archived: boolean }> {
    if (await this.isNoteSourceCourse(courseKey)) {
      await this.bank.archiveQuestion(this.paths.noteSourceDir, node, qid, archived)
      return { course: NOTE_SOURCE_COURSE, node, qid, archived }
    }
    const c = await this.registry.resolve(courseKey)
    await this.bank.archiveQuestion(this.paths.courseRoot(c.root), node, qid, archived)
    return { course: c.name, node, qid, archived }
  }

  /** AI 出题：节点正文 → 出题提示词 + llm → 产出的题库 YAML 逐题过 validateBank 门禁追加落盘。
   * llm 由 host 注入（输出可能带 markdown 围栏，解析侧 parseModel 统一剥离）。骨架节点（无正文）直接报错。
   * count 缺省 = 既有默认 6；一旦给出必须是正整数，非法值不改写成默认（#12）。
   * opts.sections = 节标注清单（逐节管线）：模型照抄清单节 id 进 section 字段；
   * opts.generic = 只出跨节综合题（section 强制「通用」，逐节管线收尾用）。 */
  async questionGenerate(
    courseKey: string | undefined, node: string, count?: number,
    llm: (prompt: string) => Promise<string>,
    opts?: { sections?: Array<{ id: string; title: string }>; generic?: boolean },
  ): Promise<{ course: string; node: string; added: number; skipped: number; total: number }> {
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
      throw new Error(`[quiz] count 必须是正整数（收到 ${String(count)}）；省略才使用默认 6。`)
    }
    const requested = count ?? 6
    const c = await this.registry.resolve(courseKey)
    const { graph, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[quiz] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'quiz')
    const [, regionName] = graph.blockOf[node]
    const note = await loadNote(this.paths.courseNotePath(c.root, regionName, node))
    const body = note.body.replace(/^>\s*内容待生成。\s*$/m, '').trim()
    if (!body) throw new Error(`[quiz] 「${node}」还没有正文——先「生成正文」再出题。`)
    const tpl = await this.loadPrompt('题目生成')
    const tier = nodeTierOf(graph, node)
    const listing = opts?.sections?.length
      ? `\n\n## 节标注清单\n\nsection 字段必须精确取自下列节 id（跨节综合题写「通用」）：\n${opts.sections.map(s => `- ${s.id} ｜ ${s.title}`).join('\n')}`
      : ''
    const difficultyAnchor = tier === 1
      ? '本节点为低复杂度：题目难度集中在 1-2，不出 difficulty: 3 的收尾难题。'
      : tier === 3
        ? '本节点为高复杂度：收尾可出 1-2 道 difficulty: 3 的综合/易错题。'
        : '本节点为中复杂度：难度递进到 2，收尾至多 1 道 difficulty: 3。'
    const raw = await llm(`${tpl}${listing}\n\n## 题目数量\n\n${requested} 道\n\n## 难度锚定\n\n${difficultyAnchor}\n\n---\n\n${body}`)
    const doc = YAML.parseModel(raw) as { node?: unknown; questions?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions) || !doc.questions.length) {
      throw new Error('[quiz] 模型没有产出可用题目（questions 为空）。')
    }
    // doc.node 只是模型对节点的复述（常自创短名），落盘位置由入参决定，不作硬校验
    let added = 0
    let skipped = 0
    for (const raw of doc.questions.slice(0, requested)) {
      const q = { ...(raw as Record<string, unknown>) }
      delete q.id // id 由 addQuestion 按现有题数自动编号，避免与既有 q1 冲突
      if (opts?.generic) q.section = '通用' // 综合题不绑节（轮装配时统一收尾）
      try {
        await this.bank.addQuestion(this.paths.courseRoot(c.root), node, q)
        added++
      } catch {
        skipped++ // 单题非法（如模型超纲出题型）不毁整批，好题照常入库
      }
    }
    if (!added) throw new Error('[quiz] 模型产出的题目全部未过校验门（题型/答案格式不符），一道都没入库。')
    const bank = await this.bank.load(this.paths.courseRoot(c.root), node)
    return { course: c.name, node, added, skipped, total: bank.questions.length }
  }

  /** 逐节出题（逐节管线第 2 段）：每个内容节一次模型调用（出题量随档位锚点：
   * 低/中/高档内容节目标 1/2/3 道，含练习节时 -1），section 服务端强制为该节 id；
   * 练习/交互节跳过，正文未生成的节（断点续跑）跳过。 */
  async questionGenerateSections(
    courseKey: string | undefined, node: string,
    llm: (prompt: string) => Promise<string>,
  ): Promise<{ course: string; node: string; added: number; sections: number }> {
    const c = await this.registry.resolve(courseKey)
    const { graph, state, broken } = await this.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[quiz] 节点「${node}」不在图内。`)
    this.assertNoteOk(c, graph, broken, node, 'quiz')
    const manifest = state[node]?.content.sections
    if (!manifest?.length) throw new Error(`[quiz] 「${node}」没有节清单——先运行大纲。`)
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
    // 出题量弹性（P3，复杂度档案锚点）：每档给内容节目标题量；大纲含练习节时内容节 −1
    // （集中练习模式：读读读→集中练，综合题数随档位而非恒定 3）。
    const hasPracticeSection = manifest.some(s => s.type === '练习')
    const perSection = perSectionQuizTarget(tier, hasPracticeSection)
    let added = 0
    let sections = 0
    for (const s of manifest) {
      if (s.type === '练习' || s.type === '交互') continue
      const sectionMd = mdByTitle.get(s.title)
      if (!sectionMd) continue
      if (perSection <= 0) continue // 该档位不要求本内容节单独出题（综合题兼底）
      sections++
      const difficultyAnchor = tier === 1
        ? '本节属低复杂度节点：题目难度 1 为主（至多 1 道 2），不出 difficulty: 3。'
        : tier === 3
          ? '本节属高复杂度节点：允许 1-2 道 difficulty: 3 的易错/综合题。'
          : '本节属中复杂度节点：难度递进到 2 即可。'
      const raw = await llm(`${tpl}\n\n## 节标注清单\n\nsection 字段必须精确写「${s.id}」（本批全部题目都属于这一节）。\n\n## 题目数量\n\n${perSection} 道\n\n## 难度锚定\n\n${difficultyAnchor}\n\n---\n\n## ${s.title}\n\n${sectionMd}`)
      let doc: { questions?: unknown } | null = null
      try {
        doc = YAML.parseModel(raw) as { questions?: unknown } | null
      } catch {
        continue // 该节模型输出非法 YAML：跳过，综合调用兼底
      }
      if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions)) continue
      for (const rawQ of doc.questions) {
        const q = { ...((rawQ ?? {}) as Record<string, unknown>), section: s.id }
        delete q.id
        try {
          await this.bank.addQuestion(this.paths.courseRoot(c.root), node, q)
          added++
        } catch {
          // 单题非法不毁整批
        }
      }
    }
    return { course: c.name, node, added, sections }
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
    const today = todayStr()
    const played = (await this.store.practiceAll()).some(r =>
      r.course === c.name && r.node === node && r.judge === 'interactive' && r.qid === qid
      && r.ts.startsWith(today))
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
      next = applyPracticeEvidence(fm, clamped)
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await saveNote(path, next as unknown as Record<string, unknown>, body)
    }
    return { settled: true, mastery: masteryOfFm(next) }
  }

  /** 删除课程：注册表移除 + 课程目录移入 学习中心/.trash/（不真删，可手工找回）。 */
  async courseDelete(courseKey: string): Promise<{ removed: string; trash: string }> {
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
    return { removed: c.name, trash }
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
