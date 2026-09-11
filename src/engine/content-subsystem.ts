import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { atomicWrite } from './io.ts'
/**
 * Content 子系统（#152 刀 8 / ADR-0043）：内容管线、笔记 resolve/反馈区、课程工作区
 * 与题库树。
 *
 * 同域新文件：内容管线是跨域装配最重的一节（队列装配要摸通道域/题库域/学习者域），
 * 放进领主 content.ts 会让它反向依赖 audit/question-bank/graph-subsystem 等下游；
 * 本文件只被门面引用，故可自由 import，跨子系统调用经窄面回引门面。
 */

// ---- Content 子系统（#152 刀 8 / ADR-0043）：内容管线、笔记 resolve/反馈区、课程
// 工作区与题库树。本文件只被门面引用，可自由 import 领域模块；跨子系统调用（队列
// 装配要摸通道域/题库域/学习者域）经窄面注入回引门面。

import type { Store } from './store.ts'
import type { Paths } from './paths.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank, BankQuestion } from './question-bank.ts'
import { Content } from './content.ts'
import { shuffled } from './shuffle.ts'
import type { Sessions } from './sessions.ts'
import type { LearnerCards } from './learner-cards.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { Fm, CourseEntry } from './types.ts'
import type { LlmComplete } from './llm.ts'
import type { JolPrediction } from './jol.ts'
import type { Nof1Variable } from './types.ts'
import type { BandPref } from './adaptive.ts'
import type { ErrorCard } from './error-cards.ts'
import type { FSRS } from 'ts-fsrs'

/** Content 域对门面的窄面：领域实例直接 import 类型，跨子系统方法走本面注入。 */
export interface ContentDeps {
  store: Store
  paths: Paths
  registry: Registry
  bank: QuestionBank
  content: Content
  sessions: Sessions
  learnerCards: LearnerCards
  vaultRoot: string
  /** JOL 抽查随机源（可注入播种）。 */
  jolRng: () => number
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  bandDefault(): Promise<BandPref | null>
  calibrationHintsConfig(): Promise<{ hints_enabled: boolean }>
  collectNoteSourceCards(today: string): Promise<{ cards: Array<Record<string, unknown>>; drifted: Array<Record<string, unknown>>; suspended: Array<Record<string, unknown>> }>
  enabledCourses(): Promise<CourseEntry[]>
  ensureNote(root: string, graph: Graph, node: string): Promise<Fm>
  errorCardTriples(courses: ReadonlyArray<{ name: string; root: string }>, nodeFilter?: string): AsyncGenerator<{ course: string; node: string; card: ErrorCard }>
  exerciseGated(c: CourseEntry, node: string): Promise<boolean>
  expTag(courseName: string, node: string, qid: string, today: string): Promise<{ id: number; arm: string } | null>
  isNoteSourceCourse(courseKey: string | undefined): Promise<boolean>
  jolConfig(): Promise<{ enabled: boolean; rate: number }>
  jolPredicted(p: JolPrediction | null | undefined): JolPrediction | null
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  nof1QueueEffect(today: string): Promise<{ id: number; variable: Nof1Variable; arm: string } | null>
  noteSourceAnswer(llmComplete: LlmComplete, sourceId: string, qid: string, answer: string, opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null; elapsed_s?: number | null }): Promise<Record<string, unknown>>
  noteSourceForget(sourceId: string, qid: string): Promise<Record<string, unknown>>
  noteSourceRate(sourceId: string, qid: string, r: number): Promise<Record<string, unknown>>
  sched(courseRoot: string | null): Promise<FSRS>
  updateNoteFm(path: string, fm: Fm): Promise<void>
}
import { bandOffset, combinedDifficulty, nextBand, sessionOrder, startBand } from './adaptive.ts'
import { advance, advancePending, advanceStrict, alreadyAdvanced } from './advance.ts'
import { effectiveStage } from './audit.ts'
import { calibrationHintText, overconfidenceOf } from './calibration.ts'
import type { ComplexityTier } from './complexity.ts'
import { nodeTierOf, sectionTierLabel } from './complexity.ts'
import { OPEN_QUESTION_GRADING_SYSTEM, PASS_SCORE, REFLECTION_GRADING_SYSTEM, answerDiff, applyPracticeEvidence, clamp01, evaluateAllo, parseOpenGrading, parseReflectionGrading, revealAnswer } from './grading.ts'
import { safeFilename } from './graph.ts'
import { jolDeviatedKeys, pickJolTargets } from './jol.ts'
import type { LearnerCardDoc } from './learner-cards.ts'
import { interleaveBySource } from './nof1.ts'
import { NOTE_SOURCE_COURSE } from './note-source.ts'
import { asFm, loadNote, saveNote } from './notes.ts'
import { CALIBRATION_BOOST_SAMPLE_RATE, FSRS_DIFFICULTY_MID, XP_GUESS_SECONDS } from './params.ts'
import { assertNoBrokenNotes } from './sessions.ts'
import { masteryOfFm, previewDue, retrievabilityBlock } from './srs.ts'
import { sourceKeyOf } from './types.ts'
import type { FsrsBlock, ReviewRec, SectionManifest } from './types.ts'
import { priorSection, priorTerms, searchVaultPrior } from './vault-prior.ts'
import type { AnswerResult, LessonDoc, QuestionForgetResult, QuestionRateResult, QuestionsDoc, QueueItem, ReviewQueueDoc, TreeDoc } from './views/content.ts'
import { xpForAnswer } from './xp.ts'
import { YAML } from './yaml.ts'
export class ContentSubsystem {
  constructor(private e: ContentDeps) {}

// ---- 门面原分节：pipeline ----
// ---- 门面原分节：resolve ----
// ---- 门面原分节：tree ----


  /** Vault 先验注入段（V-2 / #106；生成面共用，零命中返回 ''）：检索词 = 节点名 +
   * 直接前置名，纯扫描 vault 个人笔记（排除学习中心；ADR-0010 只读纪律——检索
   * 永不写个人笔记）。宿主无检索/嵌入 API（探测结论见 vault-prior.ts 头注），走
   * #78 推荐的纯扫描降级路径。 */
  private async vaultPriorFor(graph: Graph, node: string): Promise<string> {
    const terms = priorTerms([node, ...(graph.preOf[node] ?? [])])
    if (!terms.length) return ''
    const centerRel = this.e.paths.centerRoot.slice(this.e.vaultRoot.length + 1)
    const hits = await searchVaultPrior(this.e.vaultRoot, centerRel, terms)
    return priorSection(hits)
  }


  async contentPack(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[pack] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'pack')
    const prior = await this.vaultPriorFor(graph, node)
    const pack = this.e.content.contextPack(graph, state, node, c.name)
    return prior ? `${pack}\n\n---\n\n${prior}` : pack
  }


  async loadPrompt(kind: string): Promise<string> {
    return this.e.content.loadPrompt(kind)
  }


  /** 可用提示词类型（内置 + 自建变体）。 */
  async promptKinds(): Promise<string[]> {
    return this.e.content.promptKinds()
  }


  /** 节点内容版本（frontmatter content.version；面板增量刷新依据）。 */
  async contentVersion(courseKey: string | undefined, node: string): Promise<number> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[version] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'version')
    return state[node]?.content.version ?? 0
  }


  /** 节点复杂度档位（difficulty/bloom/pre 闭包折叠；生成管线与面板共用，见 complexity.ts）。 */
  async contentTierOf(courseKey: string | undefined, node: string): Promise<ComplexityTier> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[tier] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'tier')
    return nodeTierOf(graph, node)
  }


  /** 对现有课程笔记跑质检门（agent 手改正文后的校验入口；只读，不落盘不改状态）。 */
  async contentCheck(courseKey: string | undefined, node: string): Promise<{ passed: boolean; findings: string[]; warns: string[] }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[check] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'check')
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.e.paths.courseNotePath(c.root, regionName, node))
    return this.e.content.gateReport(graph, c.root, node, body)
  }


  /** 生成落盘门：gate_report → applyGeneration（version+1, draft）。
   * 节点笔记不存在时先建骨架（allo on-demand 语义：大纲即时、正文按需落盘）。
   * learnhub-interactive 标记块先拆出 HTML 落盘为交互件文件，再以引用块进质检门——
   * 门禁检查「interactive 引用文件存在」时文件必须已就位。 */
  async contentApply(courseKey: string | undefined, node: string, body: string): Promise<{ version: number; message: string; hints: string[] }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[apply] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'apply')
    if (!state[node]) await this.e.ensureNote(c.root, graph, node)
    const split = Content.extractInteractive(body, c.root)
    if (split.invalid.length) {
      throw new Error(`[apply] learnhub-interactive 标记块路径非法（只允许课程根内相对 .html 路径，无 ..）: ${split.invalid.join('、')}`)
    }
    const courseRoot = this.e.paths.courseRoot(c.root)
    for (const f of split.files) {
      const target = `${courseRoot}/${f.rel}`
      await atomicWrite(target, f.html)
    }
    const fixed = Content.fixRichBlocks((await this.e.content.fixAliases(c.root, split.body)).body)
    const gate = await this.e.content.gateReport(graph, c.root, node, fixed)
    const html = Content.checkInteractiveHtml(split.files)
    if (!gate.passed || html.findings.length) {
      throw new Error(`[apply] 质检门未过：\n${[...gate.findings, ...html.findings].map(e => `  ✗ ${e}`).join('\n')}\n${[...gate.warns, ...html.warns].map(w => `  ⚠ ${w}`).join('\n')}`)
    }
    const normalized = this.e.content.normalizePractice(fixed)
    const version = await this.e.content.applyGeneration(
      c.root, graph, node, normalized.body,
      n => state[n],
      rec => this.e.store.appendJournal({ ...rec, course: c.name }),
    )
    await this.e.content.queueDone(c.root, node)
    const interactiveNote = split.files.length ? `；交互件 ${split.files.length} 个落盘 交互/` : ''
    const hints = Content.encBackfeedHints(graph, node, fixed)
    const hintNote = hints.length ? `；图/enc 反哺提醒 ${hints.length} 条` : ''
    return { version, message: `[apply] ${node} 正文 v${version} 落盘（status=draft，待人审）${interactiveNote}${hintNote}`, hints }
  }


  /** 大纲落盘：节清单 YAML → 校验 → frontmatter content.sections（全 pending），正文不动。
   * 骨架节点先建占位文件（allo on-demand：大纲即时）。 */
  async contentOutline(courseKey: string | undefined, node: string, yamlText: string): Promise<SectionManifest[]> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[outline] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'outline')
    if (!state[node]) await this.e.ensureNote(c.root, graph, node)
    return this.e.content.outlineApply(c.root, graph, node, yamlText, rec => this.e.store.appendJournal({ ...rec, course: c.name }))
  }


  /** 整课重置（「重新生成整课」第一步）：全部节点笔记备份进 .trash 后重写为未生成骨架
   * （content=draft/sections 清空、正文清空）；题库/交互/课程图三个生成产物目录移入同一
   * trash 备份目录（rename，可恢复）。图谱（data/）、注册表、学习进度（state/）、
   * 提示词快照、生成队列.md 均不动；重新生成由调用方按拓扑序串行跑生成管线。 */
  async contentReset(courseKey: string | undefined): Promise<{ course: string; nodes: string[]; trashed: string[]; sediment: string }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (broken.length) {
      throw new Error(`[reset] 课程存在 Broken 笔记，拒绝整课重置（先修复或确认）:\n${broken.map(b => `  ✗ ${b.path} — ${b.reason}`).join('\n')}`)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const trashBase = `${this.e.paths.trashDir}/regenerate-${stamp}`
    const nodes: string[] = []
    for (const node of graph.order.length ? graph.order : graph.names) {
      if (!state[node]) continue // 无笔记文件：大纲步骤会建占位，无需重置
      const [, regionName] = graph.blockOf[node]
      const path = this.e.paths.courseNotePath(c.root, regionName, node)
      const backup = `${trashBase}/${c.root}/课程/${safeFilename(regionName)}/${safeFilename(node)}.md`
      await atomicWrite(backup, await readFile(path, 'utf8'))
      const { fm } = await loadNote(path)
      await saveNote(path, {
        ...((fm ?? {}) as Record<string, unknown>),
        content: { version: 0, generated_at: null, status: 'draft', sections: [] },
      }, '> 内容待生成。\n')
      nodes.push(node)
    }
    const trashed: string[] = []
    for (const dir of ['题库', '交互', '课程图']) {
      const src = `${this.e.paths.courseRoot(c.root)}/${dir}`
      if (!existsSync(src)) continue
      await mkdir(trashBase, { recursive: true })
      await rename(src, `${trashBase}/${dir}`)
      trashed.push(dir)
    }
    await this.e.store.appendJournal({
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
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[section] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'section')
    return this.e.content.sectionApply(c.root, graph, node, sectionId, md, rec => this.e.store.appendJournal({ ...rec, course: c.name }))
  }


  /** 节清单视图：manifest + 每节现正文 + 解析后的节段难度档 tierLabel（清单 tier 在场用
   * 清单值，缺席按节位置+节点难度推导——不回填清单；面板节进度/单节重写/生成管线的
   * 本节任务注入共用；无清单旧节点回退为整篇重导出，全部 ready）。 */
  async contentSectionsView(courseKey: string | undefined, node: string): Promise<Array<SectionManifest & { md: string | null; tierLabel: string }>> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[sections] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'sections')
    const [, regionName] = graph.blockOf[node]
    const { body } = await loadNote(this.e.paths.courseNotePath(c.root, regionName, node))
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
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[feedback] 未知节点: ${node}`)
    this.e.assertNoteOk(c, graph, broken, node, 'feedback')
    return this.e.content.feedback(c.root, graph, node, n => state[n], async (n, fm) => {
      const path = this.e.paths.courseNotePath(c.root, graph.blockOf[n][1], n)
      await this.e.updateNoteFm(path, fm)
    })
  }


  async contentReview(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[review] 未知节点: ${node}`)
    this.e.assertNoteOk(c, graph, broken, node, 'review')
    return this.e.content.review(c.root, graph, node, n => state[n], async (n, fm) => {
      const path = this.e.paths.courseNotePath(c.root, graph.blockOf[n][1], n)
      await this.e.updateNoteFm(path, fm)
    })
  }


  async contentQueue(courseKey: string | undefined, node: string): Promise<string> {
    const c = await this.e.registry.resolve(courseKey)
    return this.e.content.queueManual(c.root, node)
  }


  async queueItemsAll(): Promise<QueueItem[]> {
    const out: Array<Record<string, unknown>> = []
    for (const c of await this.e.enabledCourses()) {
      for (const it of await this.e.content.queueItems(c.root)) {
        out.push({ ...it, course: c.name })
      }
    }
    return out
  }


  async lesson(courseKey: string | undefined, node: string): Promise<LessonDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[lesson] 课程「${c.name}」中没有节点「${node}」。`)
    this.e.assertNoteOk(c, graph, broken, node, 'lesson')
    const { today } = await this.e.learningDay()
    const lesson = await this.e.sessions.lesson(c.name, c.root, graph, state, node, today)
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
    const reg = await this.e.registry.load()
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

  /** 课程工作区树：course → region → block → node（stage/mastery/笔记/题库状态）。 */
  async coursesTree(courseKey?: string): Promise<TreeDoc> {
    const targets = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const courses = []
    for (const c of targets) {
      const { graph, state } = await this.e.loadView(c)
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
            path: this.e.sessions.notePath(c.root, graph, n.name),
            hasBank: existsSync(this.e.bank.bankPath(this.e.paths.courseRoot(c.root), n.name)),
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
    const { today } = await this.e.learningDay()
    if (await this.e.isNoteSourceCourse(courseKey)) {
      const bank = await this.e.bank.load(this.e.paths.noteSourceDir, node)
      return {
        course: NOTE_SOURCE_COURSE, node,
        questions: bank.questions.filter(q => q.archived !== true)
          .map((q, i) => this.questionView(q, i, { today })),
      }
    }
    const c = await this.e.registry.resolve(courseKey)
    const { state } = await this.e.loadView(c)
    const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
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
    today ??= (await this.e.learningDay()).today
    // N-of-1 实验当日生效臂（#110 ADR-0023，批次交替）：band_default 在未显式选带时
    // 决定默认带；session_composition 决定全局队列呈现顺序。显式学习者选择优先。
    const expEffect = await this.e.nof1QueueEffect(today)
    // A1 目标难度带默认值（#111 恒温器旋钮；配置层缺省 = 纯 A1）。
    const defaultBand = await this.e.bandDefault()
    const courses = courseKey ? [await this.e.registry.resolve(courseKey)] : await this.e.enabledCourses()
    const cards: Array<Record<string, unknown>> = []
    let nodeFound = false
    let mastery = 0
    for (const c of courses) {
      const { graph, state, broken } = await this.e.loadView(c)
      assertNoBrokenNotes('review-queue', broken)
      if (node !== undefined) {
        if (!graph.nset.has(node)) continue // 该课程没有此节点：跨课程口径下属正常，最后统一判空
        // 跨课程重名节点取首个命中课程的 Mastery 作先验（定向入口正常都携带 course）
        if (!nodeFound) mastery = masteryOfFm(state[node])
        nodeFound = true
      }
      const courseRoot = this.e.paths.courseRoot(c.root)
      const sched = await this.e.sched(courseRoot)
      // 我的卡（E1，ADR-0021 汇入）：同队列同会话；FSRS 走默认参数（与笔记源同一
      // sched(null) 通道，参数优化器不训它）。R/d 按卡自身调度块现算；未调度新卡
      // （首推入口，别无来处）due 为空、R 满档 1.0 落队尾。只进队列与无绑定 XP——
      // 节点证据/门禁/复习日志零掺入（ADR-0021 裁决 2）。Broken 卡组不阻塞队列。
      const learnerSched = await this.e.sched(null)
      let learnerFiles: string[] = []
      try {
        learnerFiles = await readdir(this.e.paths.learnerCardsDir(c.root))
      } catch {
        learnerFiles = [] // 该课程还没有任何我的卡：合法空态
      }
      for (const f of learnerFiles.filter(f => f.endsWith('.yaml')).sort()) {
        const lNode = f.replace(/\.yaml$/, '')
        if (node !== undefined && lNode !== node) continue
        let doc: LearnerCardDoc
        try {
          doc = await this.e.learnerCards.load(c.root, lNode)
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
      const errorSched = await this.e.sched(null)
      for await (const { course: eCourse, node: eNode, card } of this.e.errorCardTriples([c], node)) {
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
        files = await readdir(this.e.paths.bankDir(c.root))
      } catch {
        continue
      }
      for (const f of files.filter(f => f.endsWith('.yaml')).sort()) {
        const qNode = f.replace(/\.yaml$/, '')
        if (node !== undefined && qNode !== node) continue
        const bank = await this.e.bank.load(courseRoot, qNode)
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
    const jol = await this.e.jolConfig()
    // 我的卡/错误对比卡不参与（测量面不扩：自评卡无作答判分可配对；对比卡的
    // 判分已随推进落自身 stats，不再叠 JOL 抽查）。
    const jolEligible = cards.filter(c => c.source !== 'learner' && c.source !== 'error')
    let calibrationHint: string | null = null
    if (jol.enabled && jolEligible.length) {
      const practice = await this.e.store.practiceAll()
      const verdict = overconfidenceOf(practice)
      const hints = await this.e.calibrationHintsConfig()
      const hintOn = hints.hints_enabled && verdict.overconfident
      if (hintOn) calibrationHint = calibrationHintText(verdict)
      const deviated = jolDeviatedKeys(practice)
      const candidates = jolEligible.map(c => ({
        key: sourceKeyOf(String(c.course), String(c.node), String(c.id)),
        r: c.r as number,
        difficulty: c.difficulty as number | undefined,
      }))
      const marks = pickJolTargets(candidates, this.e.jolRng, {
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
      const band = clamp01(
        startBand(mastery) + bandOffset(bandPref
          ?? (expEffect?.variable === 'band_default' ? expEffect.arm as BandPref : undefined)
          ?? defaultBand))
      return { date: today, total: cards.length, band: Math.round(band * 1000) / 1000,
        cards: sessionOrder(cards as Array<Record<string, unknown> & { d: number }>, band),
        ...(calibrationHint ? { calibration_hint: calibrationHint } : {}) }
    }
    // 笔记源卡池（C1 #59）：并入全局队列（带 source:'note' 标记，course=「笔记源」
    // 伪课程）。不参与 JOL 抽查（E4 预测落点按课程卡设计，笔记源 v1 不抽查）；
    // Missing/镜像 Broken 的源卡池挂起并随响应带出，不阻塞其他源；漂移不挂起
    // （旧卡继续复习，随响应提示可重出/归档）。
    const noteSources = await this.e.collectNoteSourceCards(today)
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
    const c = await this.e.registry.resolve(courseKey)
    return this.e.bank.save(this.e.paths.courseRoot(c.root), yamlText, node)
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
    if (await this.e.isNoteSourceCourse(courseKey)) {
      return this.e.noteSourceAnswer(llmComplete, node, qid, answer, { ...opts, elapsed_s: elapsedS ?? null })
    }
    const predicted = this.e.jolPredicted(opts?.predicted)
    const { c, graph, q, idx } = await this.questionContext(courseKey, node, qid, 'question')
    const { score, feedback } = await this.judgeBankAnswer(llmComplete, q, answer, 'question',
      { course: c.name, node, qid })
    const correct = score >= PASS_SCORE
    // XP 时间账本：同日重复作答不记账（防刷）；乱猜（耗时过短且答错）负 XP。
    // 乱猜作答同时不推进 FSRS——难度证据（k 校准）只由认真作答驱动，防乱猜推高节点定价。
    const { today } = await this.e.learningDay()
    const guessed = !correct && elapsedS !== null && elapsedS < XP_GUESS_SECONDS
    // 同日重复判定（ADR-0014 真实推进口径）：挂起作答（deferSchedule 只记账不推卡）
    // 之后的当日再作答也算重复——旧口径会绕过重复判定再推卡并静默丢弃 pending 标记。
    const repeated = guessed || alreadyAdvanced(q, today)
    const settle = xpForAnswer(q.kind, q.difficulty ?? 1, correct, elapsedS ?? null, !repeated)
    await this.e.store.appendPractice({
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
    const evidenceGated = await this.e.exerciseGated(c, node)
    const note = await this.nodeNote(c, graph, node)
    let next: Fm | null = null
    if (note.fm) {
      next = evidenceGated ? note.fm : applyPracticeEvidence(note.fm, correct ? 1.0 : 0.0)
      // 刷卡模型：首答把节点从 ready/unseen 推进 learning（后续调度由题目聚合驱动）
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await this.saveNodeNote(note.path, next, note.body)
      if (next.stage !== note.fm.stage) {
        const { state: stateNow } = await this.e.loadView(c)
        await this.e.content.onStageChange(c.root, graph, stateNow, node, next.stage)
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
      const sched = await this.e.sched(this.e.paths.courseRoot(c.root))
      pendingRating = true
      previews = {
        hard: previewDue(sched, q.fsrs ?? null, 2, today),
        good: previewDue(sched, q.fsrs ?? null, 3, today),
        easy: previewDue(sched, q.fsrs ?? null, 4, today),
      }
      fs = q.fsrs ?? null
    } else {
      const sched = await this.e.sched(this.e.paths.courseRoot(c.root))
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
    await this.e.bank.updateQuestionEvidence(this.e.paths.courseRoot(c.root), node, qid, { fsrs: fs, stats })
    if (reviewRec) {
      // N-of-1 臂标注（#110 ADR-0023）：真实推进发生时的实验归因，只添字段不改推进
      const exp = await this.e.expTag(c.name, node, qid, today)
      await this.e.store.appendReview({ course: c.name, node, qid, ...reviewRec, ...(exp ? { exp } : {}) })
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
      await mkdir(this.e.paths.centerStateDir, { recursive: true })
      const line = JSON.stringify({ ts: new Date().toISOString(), ...rec, raw: rec.raw.slice(0, 2000) })
      await appendFile(this.e.paths.gradingFailurePath, `${line}\n`, 'utf8')
    } catch {
      // 留痕失败不影响主流程
    }
  }


  /** 作答 / 忘记 / 自评共用的前置：课程解析、笔记体检、题库定位。 */
  private async questionContext(courseKey: string | undefined, node: string, qid: string, op: string) {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[${op}] 节点「${node}」不在图内。`)
    this.e.assertNoteOk(c, graph, broken, node, op)
    const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
    const idx = bank.questions.findIndex(q => q.id === qid)
    if (idx < 0) throw new Error(`[${op}] ${node} 的题库没有 ${qid}。`)
    return { c, graph, q: bank.questions[idx], idx }
  }


  /** 节点笔记读写便道（ADR-0014 附带）：blockOf → courseNotePath → loadNote → asFm
   * 四步舞收口；写回经 saveNodeNote（saveNote 的双强转收在门面一处）。 */
  private async nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }> {
    const [, regionName] = graph.blockOf[node]
    const path = this.e.paths.courseNotePath(c.root, regionName, node)
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
    if (await this.e.isNoteSourceCourse(courseKey)) return this.e.noteSourceRate(node, qid, r)
    const { c, graph, q } = await this.questionContext(courseKey, node, qid, 'question-rate')
    const { today } = await this.e.learningDay()
    if (q.stats?.last !== today || !q.stats?.pending_rating) {
      // 挂起标记是唯一准入：练习流作答与「完成学习」当日初始化（last_review=今天）都不产生挂起
      throw new Error(`[question-rate] ${node}/${qid} 今天没有待结算的自评（未作答或非挂起路径）。`)
    }
    // 挂起结算 = 当日预留推进的执行（ADR-0014 advancePending）：准入是上面的
    // pending 旗标，不走 guard——可达态里 deferred 作答不碰 fsrs，双门必不命中。
    const sched = await this.e.sched(this.e.paths.courseRoot(c.root))
    const pushed = advancePending(sched, q, r as 1 | 2 | 3 | 4, today)
    const { pending_rating: _drop, ...statsRest } = q.stats
    await this.e.bank.updateQuestionEvidence(this.e.paths.courseRoot(c.root), node, qid, { fsrs: pushed.fs, stats: { ...statsRest } })
    const rateExp = await this.e.expTag(c.name, node, qid, today)
    await this.e.store.appendReview({
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
    if (await this.e.isNoteSourceCourse(courseKey)) return this.e.noteSourceForget(node, qid)
    const { c, graph, q, idx } = await this.questionContext(courseKey, node, qid, 'question-forget')
    const pred = this.e.jolPredicted(predicted)
    const { today } = await this.e.learningDay()
    // 推进与守门一体（ADR-0014 advanceStrict）：同日已真实推进（stats.last）即拒绝，
    // 合成初始化（只写 fsrs 不占当日额度）后的覆推 Again 照旧允许。
    const sched = await this.e.sched(this.e.paths.courseRoot(c.root))
    const pushed = advanceStrict(sched, q, 1, today,
      `[question-forget] ${node}/${qid} 今天已有作答记录，忘记只用于本日首次刷卡。`)
    const fs = pushed.fs
    await this.e.store.appendPractice({
      course: c.name, node, ex: idx + 1, answer: '',
      correct: false, judge: 'forget', qid,
      elapsed_s: elapsedS ?? undefined,
      xp: 0,
      ...(pred ? { predicted: pred } : {}),
    })
    // 节点侧证据：忘记 = 0 分（EMA 衰减 + 计一次未过），stage 推进与作答路径一致。
    // probation 在途行使闸（#146）：实验中的插入节点只记流不回流。
    const evidenceGated = await this.e.exerciseGated(c, node)
    const note = await this.nodeNote(c, graph, node)
    let next: Fm | null = null
    if (note.fm) {
      next = evidenceGated ? note.fm : applyPracticeEvidence(note.fm, 0.0)
      if (next.stage === 'ready' || next.stage === 'unseen') next.stage = 'learning'
      await this.saveNodeNote(note.path, next, note.body)
      if (next.stage !== note.fm.stage) {
        const { state: stateNow } = await this.e.loadView(c)
        await this.e.content.onStageChange(c.root, graph, stateNow, node, next.stage)
      }
    }
    await this.e.bank.updateQuestionEvidence(this.e.paths.courseRoot(c.root), node, qid, { fsrs: pushed.fs, stats: pushed.stats })
    const forgetExp = await this.e.expTag(c.name, node, qid, today)
    await this.e.store.appendReview({
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
    const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), node)
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
}
