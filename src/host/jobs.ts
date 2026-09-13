/**
 * 宿主技术层·生成队列与任务注册表（#167 自 src/index.ts 分装；ADR-0048）：
 * 入队（内容管线 / 纯出题 / 生长批 / 图域任务）、执行泵（全局单并发 FIFO）、
 * 终态保留期与清扫、job runner、教练触点与重启恢复。状态全部经 HostRuntime
 * 读写，本文件零模块级可变状态；队列语义零改动（FIFO、可取消、重启可恢复、阻尼）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Content, TIER_LABELS, genericQuizTarget, hasReadyContent, readAnchor, tierIdxOf } from '../engine/index.ts'
import type { CoachTrigger, GateVerdict, LearnhubEngine, LlmComplete, LlmEffort, QuestionDiversityReport } from '../engine/index.ts'
import {
  contentFailureStatus,
  genJobRetentionRemainingMs,
  genJobSweepVerdict,
  generationJobRetentionMs,
  graphJobPayloadGap,
  isGenJobTerminal,
  isSectionOverflow,
  nextQueuedJob,
  normalizeGenJobPhase,
  outlineRepairFeedback,
  quizFailureOutcome,
  quizSuccessOutcome,
  sectionFailure,
  type GenJobFailure,
  type GenJobPhase,
  type GenJobStatus,
} from '../generation-jobs.ts'
import { contentEffort, llmCfg, llmSeam, llmSeamStripped } from './llm.ts'
import { runLog } from './runtime.ts'
import type { GenJob, HostRuntime } from './runtime.ts'
import { STATIONS } from './corpus.ts'

/** 稳定失败码提取（#213 语料补标口径）：有 code 用 code，其余归 ERROR。 */
function errorCodeOf(err: unknown): string {
  return err instanceof Error ? (err as Error & { code?: string }).code ?? 'ERROR' : 'ERROR'
}

/** 语料补标（#213）：站最近一条捕获改判 failed+失败码，返回任务失败详情的语料引用
 * （无捕获 = undefined——引用只在真有语料文件时带出）。站内对齐语义：队列泵单并发 +
 * catch 紧随该站调用，「最近一条」即死因样本（ADR-0060）。 */
function failCorpus(rt: HostRuntime, station: string, err: unknown): string | undefined {
  return rt.corpus.annotateLast(station, { outcome: 'failed', code: errorCodeOf(err) })
}

/** 出题站的补全缝转发闭包（generateQuiz/finishWithQuiz 共用，#223）：调用级
 * station/kind/effort 沿 callOpts 贯通（第二意见的解题调用标「独立解题」站、修复
 * 调用标 repair——语料站标正确），缺省钉题目生成站与管线声明的语义档。 */
function quizSeam(complete: LlmComplete, fallbackEffort: LlmEffort | undefined): LlmComplete {
  return (prompt, _system, callOpts) => complete(prompt, undefined, {
    effort: callOpts?.effort ?? fallbackEffort,
    station: callOpts?.station ?? STATIONS.quiz,
    ...(callOpts?.kind !== undefined ? { kind: callOpts.kind } : {}),
  })
}

/** AI 出题管线：节点正文 → 出题提示词 → llm → validateBank 门禁逐题落盘。
 * complete 为注入的补全缝（#137）。opts 透传节标注清单/综合题模式（逐节管线的出题段）、
 * 定向补节与生成指令（#117/#120）、语义档（#228：出题站显式声明 effort，不留部署默认）。
 * 第二意见门抽样率随 rt.quizAuditRate 传入（#223；0 = 关门），门禁失败经语料补标
 * （题目生成站，#213）。 */
async function generateQuiz(rt: HostRuntime, complete: LlmComplete, course: string, node: string, count: number | undefined, opts?: {
  sections?: Array<{ id: string; title: string }>
  generic?: boolean
  section?: { id: string; title: string }
  instruction?: string
  isCancelled?: () => boolean
  effort?: LlmEffort
}) {
  try {
    return await rt.engine.bank2.questionGenerate(course, node, count, quizSeam(complete, opts?.effort), {
      ...opts,
      ...(rt.quizAuditRate > 0 ? { secondOpinion: { rate: rt.quizAuditRate } } : {}),
    })
  } catch (err) {
    failCorpus(rt, STATIONS.quiz, err)
    throw err
  }
}

/** 出题管线的第二意见注记（#223：抽样率与成本在任务消息可见）。 */
function auditNoteOf(r: { secondOpinion?: { sampled: number; discarded: number; repaired: number } }): string {
  const a = r.secondOpinion
  return a && a.sampled > 0 ? `；第二意见抽样 ${a.sampled}（拦 ${a.discarded} 修 ${a.repaired}）` : ''
}

/** 出题多样性注记（#230 / ADR-0064）：三指标 + 各自的样本量。
 * 数字取「题库累计」范围（含本批）——批内读数在批小时退化（1 道题报不出 self-BLEU），
 * 题库读数是同轴可比的那一份；每项带样本量，避免把 2 道题算出来的 0.4 读成 30 道题的值。
 * 指标缺席（无测量对象）如实写「无样本」，不用 0 冒充（0 是「测到了、确实趋同」）。 */
function diversityNoteOf(r: { diversity?: QuestionDiversityReport }): string {
  const d = r.diversity?.bank
  if (!d || !d.sample) return ''
  const bits = (v: number | undefined, sample: number, digits: number) =>
    v === undefined ? '无样本' : `${v.toFixed(digits)}（n=${sample}）`
  return `；多样性 熵 ${bits(d.entropy.value, d.entropy.sample, 2)} / 干扰项距离 `
    + `${bits(d.distractor?.value, d.distractor?.sample ?? 0, 1)} / self-BLEU ${bits(d.selfBleu?.value, d.selfBleu?.sample ?? 0, 2)}`
}

/** 前节尾部窗口（#227）：相邻前节末尾约 300 字，截窗对齐行首（残半行不入窗）。
 * 前节尚无正文（首节/断点续跑前节未生成）返回 undefined——注入面整体缺席，不报错。 */
function sectionTailOf(md: string | null | undefined, chars = 300): string | undefined {
  if (!md?.trim()) return undefined
  const body = md.replace(/\s+$/, '')
  if (body.length <= chars) return body
  const window = body.slice(-chars)
  const nl = window.indexOf('\n')
  return (nl >= 0 && nl < window.length - 1 ? window.slice(nl + 1) : window).trim() || undefined
}

/** 节间连贯注入数据（#227）：完整节清单（节清单块按它标 i/N）+ 前节尾部窗口
 * （首节/前节未生成时缺席）。 */
interface SectionCoherence {
  sections: Array<{ id: string; title: string; type: string; points?: string }>
  prevTail?: string
}

/** 节生成提示词拼装：模板 + 本节任务（id/标题/类型/节段难度档）+ 节间连贯注入（#227：
 * 完整节清单标 i/N + 非首节的前节尾部窗口）+ 上下文包。tierLabel 来自节清单视图
 * （清单 tier 在场用清单值，缺席按节位置+节点难度推导，#147）；节清单与前节尾部由
 * 调用方从节清单视图取——前节正文缺席（首节/断点续跑前节未生成）时窗口段整体省略。
 * 修复回灌复用本函数（同一拼装），连贯注入在修复轮同构在场。 */
function sectionPrompt(
  tpl: string, pack: string,
  s: { id: string; title: string; type: string; tierLabel?: string },
  coherence?: SectionCoherence,
): string {
  const list = coherence?.sections
  const idx = list ? list.findIndex(x => x.id === s.id) : -1
  const listBlock = list && idx >= 0
    ? `\n\n## 节清单（本课共 ${list.length} 节，本节为第 ${idx + 1} 节）\n\n${list.map((x, i) =>
      `- ${i + 1}. ${x.id} ｜ ${x.title} ｜ ${x.type}${x.points ? ` ｜ ${x.points}` : ''}${i === idx ? '（本节）' : ''}`).join('\n')}`
    : ''
  const tail = coherence?.prevTail?.trim()
  const tailBlock = tail ? `\n\n## 前节结尾（仅供衔接参考，不复述前节内容）\n\n${tail}` : ''
  return `${tpl}\n\n## 本节任务\n\n- 节 id：${s.id}\n- 节标题：${s.title}\n- 节类型：${s.type}${s.tierLabel ? `\n- 节段难度档：${s.tierLabel}` : ''}${listBlock}${tailBlock}\n\n---\n\n${pack}`
}

/** 逐节生成共用出口（ADR-0054 修复阶梯）：初跑档随节点难度声明（#228：高复杂度 deep、
 * 否则 fast——正文是最长产出，固定 fast 对高难节点不足）→ 门禁失败先试块级局部修补
 * （#147：清单 ✗ 全部定位到具体违规块时只回灌这些块、只收替换块；正文过长不是块级
 * finding，天然落到整节修复）→ 整节压缩修复一轮（deep 档升一档——用与失败同档的
 * 配置盲试是已知死法；回灌块级修补**合并后**的原文防定位错位；长度 finding 附显式
 * 压缩目标与计数口径，「拆节」的出路归管线不劝模型）→ 压缩仍溢出且允许拆节时原样
 * 抛溢出错误（调用方跑大纲拆节阶梯），其余失败带说明抛出。complete 为注入的补全缝
 * （#137）。isCancelled 在每次模型产出后检查，取消即丢结果。coherence 为节间连贯
 * 注入数据（#227，透传给两处 sectionPrompt 拼装）；md = 过门落盘的正文原文（引擎
 * 落盘还会做别名等确定性微修，回灌给下一节当前节尾部足够同构），调用方据此刷新
 * 节清单视图的后节前节窗口。 */
async function applySectionWithRepair(
  rt: HostRuntime, complete: LlmComplete, course: string, node: string,
  s: { id: string; title: string; type: string; tierLabel?: string }, tpl: string, pack: string,
  opts?: {
    isCancelled?: () => boolean
    highTier?: boolean
    allowSplit?: boolean
    coherence?: SectionCoherence,
  },
): Promise<{ version: number; title: string; hints: string[]; md: string }> {
  const cancelled = () => opts?.isCancelled?.() ?? false
  const first = await complete(sectionPrompt(tpl, pack, s, opts?.coherence), undefined, { effort: contentEffort(opts?.highTier === true), station: STATIONS.section })
  if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
  let gateReport = ''
  let current = first
  let wordBudget: number | undefined
  const readGate = (err: unknown): string => {
    const e = err as Error & { wordBudget?: number }
    if (typeof e.wordBudget === 'number') wordBudget = e.wordBudget
    return e.message
  }
  try {
    return { ...(await rt.engine.content2.contentSection(course, node, s.id, first)), md: first }
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    if (code !== 'GATE_FAILED') throw err
    gateReport = readGate(err)
  }
  // 块级局部修补：全部 ✗ 都能定位到具体违规块才走（混入任何非块级 finding 时
  // fail-safe 回整节修复）；替换块数量对不上或拼接失败同样回退。
  const plan = Content.blockPatchPlan(first, gateReport)
  if (plan) {
    const patched = await complete(Content.blockPatchPrompt(plan), undefined, { effort: contentEffort(opts?.highTier === true), station: STATIONS.section, kind: 'repair' })
    if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
    const merged = Content.applyBlockPatch(first, plan, Content.extractFencedBlocks(patched))
    if (merged !== null) {
      current = merged
      try {
        return { ...(await rt.engine.content2.contentSection(course, node, s.id, merged)), md: merged }
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
        if (code !== 'GATE_FAILED') throw err
        gateReport = readGate(err) // 带最新清单回退整节修复
      }
    }
  }
  // 整节压缩修复一轮：deep 档（升一档）；回灌 current（块级修补合并后的原文——回灌
  // 初跑原文会与合并清单的定位错位）；长度 finding 由 sectionRepairPrompt 附压缩目标。
  const repaired = await complete(
    Content.sectionRepairPrompt(sectionPrompt(tpl, pack, s, opts?.coherence), current, gateReport, { wordBudget }),
    undefined, { effort: 'deep', station: STATIONS.section, kind: 'repair' },
  )
  if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
  try {
    return { ...(await rt.engine.content2.contentSection(course, node, s.id, repaired)), md: repaired }
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    if (code !== 'GATE_FAILED') throw err
    if (isSectionOverflow(err) && opts?.allowSplit !== false) throw err // 交调用方跑拆节阶梯
    const src = err as Error & { sectionId?: string; sectionTitle?: string }
    const msg = err instanceof Error ? err.message : String(err)
    const e: Error & { code?: string; sectionId?: string; sectionTitle?: string } = new Error(
      `${msg}\n（已按门禁清单自动修复重试一轮仍未通过——可在失败提示中「重试续跑」或「重写这一节」，也可转 AI 修复）`)
    e.code = 'GATE_FAILED'
    e.sectionId = src.sectionId
    e.sectionTitle = src.sectionTitle
    throw e
  }
}

/** 大纲拆节（ADR-0054 阶梯末级）：待拆节任务 + 裁剪上下文包 → 拆分 YAML（deep 档）→
 * 引擎把该节原位替换为 2–3 个子节，返回子节清单（管线逐子节照常生成）。
 * 包自取且无 §8 交付要求——拆节输出是 YAML，机器块指令不得混入（同大纲站，理由见
 * content.ts contextPack）；断点续跑时大纲块被跳过，自取保证裁剪包在此必然在场。 */
async function splitOverflowSection(
  rt: HostRuntime, complete: LlmComplete, course: string, node: string,
  s: { id: string; title: string; type: string },
): Promise<void> {
  const tpl = await rt.engine.content2.loadPrompt('课程节拆分')
  const pack = await rt.engine.content2.contentPack(course, node, { omitDeliverables: true })
  const yaml = await complete(
    `${tpl}\n\n## 待拆分的节\n\n- 节 id：${s.id}\n- 节标题：${s.title}\n- 节类型：${s.type}\n\n---\n\n${pack}`,
    undefined, { effort: 'deep', station: STATIONS.split },
  )
  const r = await rt.engine.content2.contentSplit(course, node, s.id, yaml)
  // 拆分 YAML 解析容忍命中（#213）：拆节站当次捕获补标 tolerated（必存语义）
  if (r.tolerated.length) rt.corpus.annotateLast(STATIONS.split, { outcome: 'tolerated' })
}

// ---- 全局生成队列：任意入口入队（面板/agent/整课链），同一时刻只执行一个节点管线 ----

/** 队列写回闸（#194 / ADR-0053）：任务档 Broken 期间拒绝一切会改动并全量落盘注册表
 * 的交互路径（入队/整课重置/恢复队列）——否则下一次入队会把坏档全量覆盖（静默销毁
 * 现场）。文案自带 broken 原因（含路径与修复指引）。 */
function assertQueueWritable(rt: HostRuntime): void {
  if (rt.flags.genQueueBroken) {
    throw new Error(`生成任务档损坏，队列处于 broken 态，已拒绝该操作——${rt.flags.genQueueBroken}`)
  }
}

/** 注册表落盘（fire-and-forget；D14：文件 IO 收口 engine）。写回闸兜底：broken 期间
 * 一律跳过（坏档字节原样保留），交互路径的拒绝由 assertQueueWritable 在入口给出。 */
function persistGenJobs(rt: HostRuntime): void {
  if (rt.flags.genQueueBroken) return
  void rt.engine.saveGenJobs([...rt.jobs.genJobs.values()].map(j => ({ ...j })))
    .catch(() => { /* 落盘失败不影响内存态（下次变更重试） */ })
}

/** 入队一个节点的生成任务（FIFO；重复入队幂等）。同一节点 running/cancelling 时拒绝。
 * 终点恒拒（#199 / ADR-0055 生成门，经 ADR-0056 修订）：终点是承诺标记不被学习调度，
 * 不看就绪状态、手动与自动通道同认这道门；拒绝带 ENDPOINT_GENERATION_FORBIDDEN 码，
 * 整课重生成链据此跳过终点（不靠错误文案判别）。 */
export async function enqueueGeneration(rt: HostRuntime, ctx: Context, course: string, node: string, style?: string): Promise<{ message: string; queued: boolean }> {
  assertQueueWritable(rt)
  const c = await rt.engine.registry.get(course)
  if (c?.root) {
    const anchor = await readAnchor(rt.engine.paths.anchorPath(c.root), rt.engine.fs)
    if (anchor && anchor.endpoint === node) {
      throw Object.assign(
        new Error(`「${node}」是课程「${course}」的终点——终点是承诺标记，不被学习调度（生成门恒拒，不看就绪状态）：终点零正文零题库，完成判据折叠自它的最后台阶（终点.pre 集）。`),
        { code: 'ENDPOINT_GENERATION_FORBIDDEN' },
      )
    }
  }
  const key = `${course}/${node}`
  const existing = rt.jobs.genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」正在生成中，请稍候。`)
  }
  if (existing?.status === 'queued') {
    const ahead = [...rt.jobs.genJobs.values()].filter(j => j.status === 'queued' && j.startedAt < existing.startedAt).length
    return { message: `「${node}」已在队列中（前面还有 ${ahead} 个任务）。`, queued: true }
  }
  rt.jobs.genJobs.set(key, {
    course, node, startedAt: new Date().toISOString(), status: 'queued',
    ...(style ? { style } : {}),
    model: llmCfg.model,
    message: '排队等待生成…',
  })
  persistGenJobs(rt)
  pumpGeneration(rt, ctx)
  return { message: `「${node}」已入队，将在后台按序生成（进度见生成队列）。`, queued: true }
}

/** 入队一个纯出题任务（#118 补生成任务化）：复用全局队列与 GenJob 记录（phase=quiz），
 * 与节点管线互斥（同节点已有 queued/running 任务一律 fail loud 拒绝——题库写互斥）。 */
export function enqueueQuizGeneration(
  rt: HostRuntime, ctx: Context, course: string, node: string,
  opts?: { count?: number; section?: { id: string; title: string }; instruction?: string },
): { key: string; message: string; queued: boolean } {
  assertQueueWritable(rt)
  const key = `${course}/${node}`
  const existing = rt.jobs.genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」已有生成任务进行中（${existing.phase === 'quiz' ? '出题' : '生成正文'}），请等它完成后再出题。`)
  }
  if (existing?.status === 'queued') {
    throw new Error(`「${node}」已在生成队列中，请等当前任务完成后再出题。`)
  }
  rt.jobs.genJobs.set(key, {
    course, node, startedAt: new Date().toISOString(), status: 'queued', phase: 'quiz',
    ...(opts?.count !== undefined ? { count: opts.count } : {}),
    ...(opts?.section ? { section: opts.section } : {}),
    ...(opts?.instruction ? { instruction: opts.instruction } : {}),
    model: llmCfg.model,
    message: '排队等待出题…',
  })
  persistGenJobs(rt)
  pumpGeneration(rt, ctx)
  return { key, message: `「${node}」出题任务已入队，将在后台按序生成（进度见生成队列）。`, queued: true }
}


/** 等待一个生成任务到终态（agent 工具同步语义：入队 + 等完成 + 返回结果）。
 * 罗盘重画的 agent 路径同样经此等待（#163：回路只在生成队列任务内运行）。 */
export function waitForGenJob(rt: HostRuntime, key: string, timeoutMs = 15 * 60_000): Promise<GenJob> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      const job = rt.jobs.genJobs.get(key)
      if (!job) {
        reject(new Error('生成任务已从注册表消失（可能刚被清理），请重试。'))
        return
      }
      if (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling') {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('等待生成任务超时——任务仍在后台执行，可稍后在生成队列查看结果。'))
          return
        }
        setTimeout(tick, 1000)
        return
      }
      resolve(job)
    }
    tick()
  })
}

/** 任务终态保留期满后清出注册表（失败/取消留 24h 供排查与重试，成功留 30 分钟）。
 * 终态进入时盖 finishedAt 戳（保留期起算点落盘，ADR-0039）；delayMs 供重启恢复按
 * 剩余时长补挂——进程内 setTimeout 随进程消失，恢复侧必须自己结算。 */
export function scheduleJobRetention(rt: HostRuntime, key: string, status: GenJobStatus, delayMs?: number): void {
  const job = rt.jobs.genJobs.get(key)
  if (job && isGenJobTerminal(status) && !job.finishedAt) {
    job.finishedAt = new Date().toISOString()
    persistGenJobs(rt)
  }
  setTimeout(() => {
    const cur = rt.jobs.genJobs.get(key)
    if (cur && cur.status !== 'running' && cur.status !== 'cancelling') rt.jobs.genJobs.delete(key)
    persistGenJobs(rt)
  }, delayMs ?? generationJobRetentionMs(status)).unref()
}

/** 注册表清扫（ADR-0039 写侧联动出口）：课程已删，或内容锚定任务的节点已删/改名 →
 * 记录悬空，唯一处置是清除（不做墓碑）；终态超保留期（finishedAt 起算）一并出册。
 * running 记录先置取消旗标再出册——runner 持同一对象，下个检查点中止，而落盘序列化
 * 取自 Map，已删条目的终态不会复活。存在性 = 注册表精确匹配 + 图节点名集；课程在而
 * 图读不动（Broken）按存在性未知保守保留。courseDelete、删/改名节点的各 apply 出口
 * 与重启恢复共用。返回清扫条数。broken 态（#194）跳过：清扫会触发注册表全量落盘，
 * 写回闸拒绝——宿主其余功能（含各 apply 出口）不受任务档损坏牵连，清扫延后到修档重启。 */
export async function sweepGenJobs(rt: HostRuntime, now = Date.now()): Promise<number> {
  if (rt.flags.genQueueBroken) {
    // 写回闸拒绝（#194）：清扫会触发注册表全量落盘——跳过并留痕（不抛：apply 出口
    // 等调用方不被任务档损坏牵连，清扫延后到修档重启）
    const why = rt.flags.genQueueBroken
    void runLog(rt, 'gen_jobs_sweep', `任务档 broken，清扫跳过（修档重启后恢复）：${why}`).catch(() => undefined)
    return 0
  }
  const perCourse = new Map<string, Promise<Set<string> | null | undefined>>()
  const nodeNamesOf = (course: string): Promise<Set<string> | null | undefined> => {
    let p = perCourse.get(course)
    if (!p) {
      p = (async (): Promise<Set<string> | null | undefined> => {
        try {
          const c = await rt.engine.registry.get(course)
          if (!c) return null
          return (await rt.engine.loadView(c)).graph.nset
        } catch {
          return undefined
        }
      })()
      perCourse.set(course, p)
    }
    return p
  }
  let swept = 0
  for (const [key, j] of [...rt.jobs.genJobs.entries()]) {
    const names = await nodeNamesOf(j.course)
    const verdict = genJobSweepVerdict(j, { courseMissing: names === null, nodeMissing: !!names && !names.has(j.node) }, now)
    if (verdict === 'keep') continue
    if (j.status === 'running') j.status = 'cancelling'
    rt.jobs.genJobs.delete(key)
    swept++
  }
  if (swept) persistGenJobs(rt)
  return swept
}

/** 生长批任务键（课程级任务，node 槽放「生长批」标签；队列 phase=生长，#145）。 */
const GROWTH_JOB_NODE = '生长批'

/** 入队一个生长批任务（#145）：教练回合裁决 → kind=edit 提案 → 罗盘随批写入单元重写。
 * 阻尼防泵循环（否则「失败→排空→检查点→入队」立即成环）：同课已有生长批在途不重入；
 * 上一批失败/取消不自动重试——从生成页人工重试，或终态保留期（24h）过后自然恢复；
 * 上一批以 idle/no_structure 收尾也不重拉——教练停摆与「暂不产结构」都是裁决，
 * 重拉要等新的队列活动带来新内容。自动拉批只在队列空闲检查点接线（另两点=感知面）。
 * inject（#149）= 计划修订的换线/补支注入：显式的重新裁决请求，豁免 idle/no_structure
 * 阻尼（计划改了目标，上一次停摆裁决不再代表现状）；在途/失败阻尼照旧。
 * force（面板下发）= 同 inject 的显式豁免（学习者点了「生长一步」/失败通知「重试」
 * 就是重新裁决的意图，#157）：豁免停摆/暂不产结构与**失败**阻尼（终态记录覆盖重新
 * 入队）；在途防重入与已取消（明确的中止意图）照旧。 */
export function enqueueGrowthBatch(rt: HostRuntime, ctx: Context, course: string, why: string, inject?: string, opts: { force?: boolean } = {}): { message: string; queued: boolean } {
  assertQueueWritable(rt)
  const key = `${course}/${GROWTH_JOB_NODE}`
  const last = rt.jobs.genJobs.get(key)
  if (last && (last.status === 'queued' || last.status === 'running' || last.status === 'cancelling')) {
    return { message: `「${course}」已有生长批任务在途，不重复入队。`, queued: false }
  }
  if (last?.status === 'cancelled') {
    return { message: `「${course}」上一生长批已取消（${last.message ?? ''}），不重拉——取消是明确的中止意图，可等下一次触发。`, queued: false }
  }
  if (last?.status === 'failed' && opts.force !== true) {
    return { message: `「${course}」上一生长批失败（${last.message ?? ''}），不自动重试——可从生成队列或失败通知重试，或等下一次触发。`, queued: false }
  }
  if (!inject && opts.force !== true && last && last.status === 'done' && last.growthOutcome !== 'applied') {
    return { message: `「${course}」上一生长批裁决为 ${last.growthOutcome === 'idle' ? '停摆' : '暂不产结构'}，不重拉。`, queued: false }
  }
  rt.jobs.genJobs.set(key, {
    course, node: GROWTH_JOB_NODE, startedAt: new Date().toISOString(), status: 'queued', phase: 'growth',
    model: llmCfg.model, message: `排队等待教练回合（${why}）…`,
    ...(inject ? { growthInject: inject } : {}),
  })
  persistGenJobs(rt)
  pumpGeneration(rt, ctx)
  return { message: `「${course}」生长批已入队（${why}）。`, queued: true }
}

/** 计划修订驱动的生长批入队（#149）：apply 结果携带换线/补支触发时逐课程入队
 * （注入块随任务走）。 */
export function triggerPlanGrowth(rt: HostRuntime, ctx: Context, result: { kind?: string; growth?: Array<{ course: string; lines: string[] }> }): void {
  if (result.kind !== 'project_plan' || !result.growth?.length) return
  for (const t of result.growth) {
    try {
      const r = enqueueGrowthBatch(rt, ctx, t.course, '里程碑计划修订（换线/补支）', t.lines.join('\n'))
      void runLog(rt, 'coach_growth', r.message).catch(() => undefined)
    } catch (err) {
      void runLog(rt, 'coach_growth', `「${t.course}」计划修订生长批入队失败：${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined)
    }
  }
}

/** 种子应用 → 起点正文自动入队（#160，镜像生长批「就绪缺口入队」语义）：种子提案
 * apply 后对起点节点中「正文未生成」者逐个入队全局串行队列（FIFO、可取消、生成页
 * 可见）——提案一过、内容就在酿，学习者不必逐节点手点生成再各等数分钟。幂等语义：
 * enqueueGeneration 对排队任务去重（重复触发不产生重复任务），running/cancelling 的
 * 同名任务拒绝时逐个跳过留痕、不挡其余起点。队列重启暂停语义不回归：入队只触发泵，
 * queuePaused 旗标挡泵——暂停时起点任务安静排队，恢复队列才开跑。返回实入队节点数。 */
export async function triggerSeedContent(rt: HostRuntime, ctx: Context, applied: { course: string; starts: string[] }): Promise<number> {
  const c = await rt.engine.registry.resolve(applied.course)
  const { state } = await rt.engine.loadView(c)
  const unbuilt = applied.starts.filter(n => !hasReadyContent(state[n]))
  let enqueued = 0
  for (const node of unbuilt) {
    try {
      await enqueueGeneration(rt, ctx, c.name, node)
      enqueued++
    } catch (err) {
      void runLog(rt, 'seed_apply_enqueue', `「${c.name}」起点「${node}」自动入队跳过：${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined)
    }
  }
  await runLog(rt, 'seed_apply_enqueue', `「${c.name}」种子应用：${unbuilt.length
    ? `起点正文自动入队 ${enqueued}/${unbuilt.length} 节（${unbuilt.join('、')}）`
    : '全部起点正文已就绪，无需入队'}`).catch(() => undefined)
  return enqueued
}

/** 图 apply 出口的注册表联动（面板路由与 agent 工具共用，#160 收口一处防漂移）：
 * 编辑批可含 del_node/rename（ADR-0039 写侧联动）→ 清扫悬空任务记录；种子应用
 * （单发种子，或反编译联合入口的种子半区，#156）后起点正文自动入队——seed 为
 * null = 本批无种子半区，零种子动作。 */
export async function afterGraphApply(rt: HostRuntime, ctx: Context, seed: { course: string; starts: string[] } | null): Promise<void> {
  await sweepGenJobs(rt)
  if (seed) await triggerSeedContent(rt, ctx, seed)
}

/** 教练回合触发统一出口（五点接线，词条「教练回合」）：就绪深度检查 → 低于前瞻的课程
 * 入队生长批（自动触点走阻尼；显式触点 force 豁免停摆/暂不产结构——显式重新裁决）→
 * 运行日志。触发点：node_complete / node_skip（各自路由）、session_start（节流）、
 * queue_idle（生成泵排空）、panel_dispatch（「生长一步」按钮直达入队，不走本函数的检查）。
 * 返回人读摘要（调用方留痕）。 */
async function coachTrigger(rt: HostRuntime, ctx: Context, trigger: CoachTrigger, courseKey?: string, opts: { force?: boolean } = {}): Promise<string> {
  const r = await rt.engine.growth2.coachCheckpoint(trigger, courseKey)
  const lines: string[] = []
  for (const chk of r.courses) {
    lines.push(`${chk.course}：ready=${chk.ready}/${chk.required}${chk.ok ? '' : '（低于前瞻，已告警）'}`)
    if (chk.ok) continue
    try {
      const enq = enqueueGrowthBatch(rt, ctx, chk.course, `${trigger} 触发（就绪深度 ${chk.ready}/${chk.required}）`, undefined, opts)
      lines.push(enq.message)
    } catch (err) {
      lines.push(`「${chk.course}」生长批入队失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const summary = lines.join('；')
  await runLog(rt, `coach_checkpoint(${trigger})`, summary).catch(() => undefined)
  return summary
}

/** 会话开始检查点的节流窗（检查点是逐课程读侧 loadView，不能跟着 5s 轮询跑）。 */
const SESSION_START_THROTTLE_MS = 30 * 60_000

/** 教练触点的 fire-and-forget 包装（路由/状态入口侧）：失败只留运行日志，不挡原动作。 */
export function coachTriggerDetached(rt: HostRuntime, ctx: Context, trigger: CoachTrigger, courseKey?: string, opts: { force?: boolean } = {}): void {
  void coachTrigger(rt, ctx, trigger, courseKey, opts)
    .catch(err => runLog(rt, `coach_checkpoint(${trigger})`, `调用失败：${err instanceof Error ? err.message : String(err)}`).catch(() => undefined))
}

/** 会话开始触点（节流 30 分钟）：面板打开（GET /status）与 agent 会话开工
 * （learnhub_status）共用入口，fire-and-forget——失败只留运行日志。 */
export function sessionStartCheckpoint(rt: HostRuntime, ctx: Context): void {
  const now = Date.now()
  if (now - rt.flags.lastSessionStartAt < SESSION_START_THROTTLE_MS) return
  rt.flags.lastSessionStartAt = now
  coachTriggerDetached(rt, ctx, 'session_start')
}

/** 图域任务入队（面板下发共用）：键 = course/node 标签；同键在途不重入，终态即覆盖
 * （单发起草，重按 = 重来）。返回 queued 旗标 + 消息给路由留痕——拒绝重复入队是
 * 非成功语义，面板按旗标着色、不得弹成功样式（#155 交互诚实性）。 */
export function enqueueGraphJob(rt: HostRuntime, ctx: Context, j: { course: string; node: string; phase: GenJobPhase } & Partial<Pick<GenJob, 'seedPayload' | 'decompilePayload' | 'planPayload' | 'milestonePayload'>>): { message: string; queued: boolean } {
  assertQueueWritable(rt)
  const key = `${j.course}/${j.node}`
  const last = rt.jobs.genJobs.get(key)
  if (last && (last.status === 'queued' || last.status === 'running' || last.status === 'cancelling')) {
    return { message: `「${j.course}」${j.node}任务已在途，不重复入队。`, queued: false }
  }
  rt.jobs.genJobs.set(key, {
    course: j.course, node: j.node, startedAt: new Date().toISOString(),
    status: 'queued', phase: j.phase, model: llmCfg.model, message: '排队等待生成队列…',
    ...(j.seedPayload ? { seedPayload: j.seedPayload } : {}),
    ...(j.decompilePayload ? { decompilePayload: j.decompilePayload } : {}),
    ...(j.planPayload ? { planPayload: j.planPayload } : {}),
    ...(j.milestonePayload ? { milestonePayload: j.milestonePayload } : {}),
  })
  persistGenJobs(rt)
  pumpGeneration(rt, ctx)
  return { message: `「${j.course}」${j.node}已入队（生成队列 FIFO）。`, queued: true }
}

/** 图域任务 phase → 语料站名（#213 失败补标映射；growth 在 generateGrowthJob 单列）。 */
const GRAPH_JOB_STATIONS: Partial<Record<GenJobPhase, string>> = {
  seed: STATIONS.seed, compass: STATIONS.compass, decompile: STATIONS.decompile,
  plan: STATIONS.plan, milestone: STATIONS.milestone,
}

/** 图域任务执行（面板下发）：seed/compass/decompile/plan/milestone——引擎 LLM 方法一次受理，
 * 产物一律走提案人审通道（种子一次人审、反编译联合人审、计划 apply 带快照），任务
 * 只留受理摘要；失败落 failed 可从生成页重试。失败经语料补标（phase → 站，#213）。 */
async function generateGraphJob(rt: HostRuntime, _ctx: Context, job: GenJob): Promise<void> {
  job.status = 'running'
  persistGenJobs(rt)
  try {
    if (job.phase === 'seed' && job.seedPayload) {
      job.message = '种子起草中（目标描述 → 模型）…'
      persistGenJobs(rt)
      const r = await rt.engine.graph.seedPropose({
        course: job.course, goal: job.seedPayload.goal, mode: job.seedPayload.mode,
        goalType: job.seedPayload.goalType, useVaultPrior: job.seedPayload.useVaultPrior,
        worksheet: job.seedPayload.worksheet,
      }, rt.agent)
      job.status = 'done'
      job.message = `种子提案 #${r.id} 待人审：${r.starts} 起点 → 终点「${r.endpoint}」`
        + `${r.prior_hits ? `；先验命中 ${r.prior_hits}` : ''}${r.repaired ? '；修复轮一次' : ''}——提案收件箱一次人审即开工`
    } else if (job.phase === 'compass') {
      // 初画/重画共用一条队列通道（repainted 由引擎结果区分），措辞不预设哪一种
      job.message = '罗盘路线绘制中（deep 档工具回路）…'
      persistGenJobs(rt)
      const r = await rt.engine.growth2.compassPaint(job.course, rt.agent, {
        isCancelled: () => (job.status as GenJobStatus) === 'cancelling',
      })
      job.status = 'done'
      job.message = `罗盘已重画：${r.route_lines} 条路线${r.annotations_preserved ? '（学习者批注原样保留）' : ''}`
      // 回路轨迹（#163）：重画前查了哪些只读视图，生成页逐条可查
      if (r.trajectory?.length) job.message += `｜回路轨迹：${r.trajectory.join('；')}`
    } else if (job.phase === 'decompile' && job.decompilePayload) {
      job.message = '目标反编译中（计划 + 种子双提案）…'
      persistGenJobs(rt)
      const p = job.decompilePayload
      const r = await rt.engine.project.projectDecompile(p.project, {
        ...(p.goal ? { goal: p.goal } : {}),
        ...(p.course ? { course: p.course } : {}),
        ...(p.notes?.length ? { notes: p.notes } : {}),
      }, rt.agent)
      job.status = 'done'
      job.message = `反编译双提案待联合人审：计划 #${r.pair.plan}${r.pair.seed ? ` + 种子 #${r.pair.seed}` : ''}（先验命中 ${r.prior_hits}）——提案收件箱同进同退`
    } else if (job.phase === 'plan' && job.planPayload) {
      job.message = '里程碑计划草案生成中…'
      persistGenJobs(rt)
      job.message = await generateProjectPlan(rt, job.planPayload.project)
      job.status = 'done'
    } else if (job.phase === 'milestone' && job.milestonePayload) {
      job.message = '里程碑任务卡生成中…'
      persistGenJobs(rt)
      job.message = await generateProjectMilestone(rt, job.milestonePayload.project, job.milestonePayload.milestone)
      job.status = 'done'
    } else {
      throw new Error(`图域任务负载缺失或 phase 未知：${String(job.phase)}`)
    }
  } catch (err) {
    const station = job.phase ? GRAPH_JOB_STATIONS[job.phase] : undefined
    const corpusRef = station ? failCorpus(rt, station, err) : undefined
    job.status = contentFailureStatus(job.status)
    job.message = (err instanceof Error ? err.message : String(err)) + (corpusRef ? `｜语料 生成语料/${corpusRef}` : '')
  } finally {
    persistGenJobs(rt)
    scheduleJobRetention(rt, `${job.course}/${job.node}`, job.status)
    void runLog(rt, `graph_job(${job.phase})`, `「${job.course}」${job.message}`).catch(() => undefined)
  }
}

/** 生长批任务执行（#145）：coachGrowthBatch 工具回路回合 + 受理接线；应用成功后对
 * 「新建且正文未生成」的就绪缺口节点入队正文生成（生长-内容交替，永远 FIFO 不插队
 * ——生长批只在检查点之后入队，内容任务在它完成之后排队）。取消旗标沿回合传入
 * （#163 任务取消传导：回路每轮检查，取消即中止）；回路轨迹进任务消息（生成页可查）。 */
async function generateGrowthJob(rt: HostRuntime, ctx: Context, job: GenJob): Promise<void> {
  const key = `${job.course}/${GROWTH_JOB_NODE}`
  job.status = 'running'
  job.message = '教练回合裁决中（轻量段）…'
  persistGenJobs(rt)
  try {
    const r = await rt.engine.growth2.coachGrowthBatch(job.course, rt.agent, {
      ...(job.growthInject ? { inject: job.growthInject } : {}),
      isCancelled: () => (job.status as GenJobStatus) === 'cancelling',
    })
    if (r.state === 'idle') {
      job.growthOutcome = 'idle'
      job.status = 'done'
      // 停摆是判据满足的自然结果，不是成就（#161）：中性说明文案，面板通知与生成页共用
      job.message = `教练判断暂不需长新内容（就绪 ${r.check.ready}/${r.check.required}）。`
    } else {
      const p = r.proposal!
      const a = r.applied!
      job.growthOutcome = a.ops > 0 ? 'applied' : 'no_structure'
      job.status = 'done'
      const tierNote = r.segments
        .map(s => `${{ light: '轻', full: '全', arbitration: '双沙盘仲裁', repair: '回灌重裁' }[s.tier] ?? s.tier}${s.disagreement ? '↑分歧升级' : ''}(${s.operator})`)
        .join('→')
      job.message = `生长批（${p.operator}）提案 #${p.id}${a.ops > 0 ? `：${a.ops} 条操作，快照 v${a.snapshot}` : '：零操作，裁决留痕'}`
        + `${a.compass_rewritten ? '；罗盘已随批重写' : ''}｜${tierNote}｜理由：${p.reason}`
      // 回路轨迹（#163）：裁决前查了哪些只读视图，生成页逐条可查
      if (r.trajectory?.length) job.message += `｜回路轨迹：${r.trajectory.join('；')}`
      // 受理批可含 del_node/rename（ADR-0039 写侧联动）：先清扫悬空任务记录再入队正文
      if (a.ops > 0) await sweepGenJobs(rt)
      // 生长→内容链：新建节点里的就绪缺口入队正文生成（T2 同款理由口径）
      for (const node of a.ready_unbuilt) {
        try {
          await enqueueGeneration(rt, ctx, job.course, node)
        } catch { /* 同节点已在队列（去重），跳过 */ }
      }
      if (a.ready_unbuilt.length) job.message += `；正文生成已入队 ${a.ready_unbuilt.length} 节`
    }
  } catch (err) {
    const corpusRef = failCorpus(rt, STATIONS.growth, err)
    job.status = contentFailureStatus(job.status)
    job.message = (err instanceof Error ? err.message : String(err)) + (corpusRef ? `｜语料 生成语料/${corpusRef}` : '')
  } finally {
    persistGenJobs(rt)
    scheduleJobRetention(rt, key, job.status)
    void runLog(rt, 'coach_growth', `「${job.course}」生长批：${job.message}`)
  }
}

/** 队列执行泵：空闲且未暂停时取队首排队任务跑管线；跑完（含失败）继续泵下一个。
 * phase=quiz 的纯出题任务走 generateQuizJob、phase=growth 走 generateGrowthJob（#145）、
 * 图域任务（seed/compass/decompile/plan/milestone）走 generateGraphJob（面板下发），其余按节点
 * 管线执行（#118）。 */
const GRAPH_JOB_PHASES: ReadonlySet<GenJobPhase> = new Set<GenJobPhase>(['seed', 'compass', 'decompile', 'plan', 'milestone'])

export function pumpGeneration(rt: HostRuntime, ctx: Context): void {
  // broken 态不开跑（#194）：任务执行会反复全量落盘注册表——写回闸拒绝（静默，与
  // queuePaused 同款泵闸；交互入口的拒绝文案由 assertQueueWritable 给出）
  if (rt.flags.pumping || rt.flags.queuePaused || rt.flags.genQueueBroken) return
  const next = nextQueuedJob([...rt.jobs.genJobs.values()])
  if (!next) return
  rt.flags.pumping = true
  const task = next.phase === 'quiz'
    ? generateQuizJob(rt, ctx, next)
    : next.phase === 'growth'
      ? generateGrowthJob(rt, ctx, next)
      : next.phase !== undefined && GRAPH_JOB_PHASES.has(next.phase)
        ? generateGraphJob(rt, ctx, next)
        : generateContent(rt, ctx, next.course, next.node, next.style)
  void task
    .catch(() => { /* 执行器已置 failed 留注册表可重试 */ })
    .finally(() => {
      rt.flags.pumping = false
      // 队列空闲触发点（#144 → 五点接线）：生成队列排空 → 教练回合就绪深度检查，
      // 低于前瞻的课程随后入队生长批（#145：自动拉批只在检查点之后入队——FIFO 不插队，
      // 重拉阻尼见 enqueueGrowthBatch）。失败只留运行日志，不挡生成泵。
      if (!nextQueuedJob([...rt.jobs.genJobs.values()])) {
        void coachTrigger(rt, ctx, 'queue_idle')
          .then(() =>
            // 复诊结算钩子（#146）：队列空闲时自动结算到期插入边（零人审：proven｜
            // 自动剪除）；失败只留运行日志，不挡泵——到期未决由 data-check 提示类可见。
            rt.engine.growth2.settleRechecks())
          .then(r => {
            if (!r) return
            let settledAny = false
            for (const c of r.courses) {
              if (!c.settled.length) continue
              settledAny = true
              runLog(rt, 'probation_settle', `「${c.course}」复诊结算：${c.settled.map(s =>
                `${s.node}→${s.outcome}${s.metric ? `（${s.metric}）` : ''}`).join('；')}`)
                .catch(() => undefined)
            }
            // 复诊不达标自动剪除会删节点（无人审 del_node，ADR-0039 写侧联动）
            if (settledAny) return sweepGenJobs(rt)
          })
          .catch(err => runLog(rt, 'coach_checkpoint(queue_idle)', `调用失败：${err instanceof Error ? err.message : String(err)}`))
      }
      pumpGeneration(rt, ctx)
    })
}

/** 纯出题任务执行（#118）：单次 questionGenerate（定向补节/指令/题量随任务携带），
 * 取消旗标逐题生效；终态与保留期与节点管线同语义。出题档位显式声明（#228）：
 * 随节点难度 contentEffort（高复杂度 deep、否则 fast），不再走部署默认；档位缺失
 * 折叠 fast（同管线兜底口径），运行日志留档位记录供成本对照。 */
async function generateQuizJob(rt: HostRuntime, ctx: Context, job: GenJob): Promise<void> {
  const key = `${job.course}/${job.node}`
  job.status = 'running'
  job.message = job.section
    ? `正在为节「${job.section.title}」定向补题…`
    : job.instruction
      ? '正在按学习者意见重出新题…'
      : '正在出题…'
  persistGenJobs(rt)
  let quizEffort: LlmEffort = 'fast'
  try {
    job.tier = TIER_LABELS[await rt.engine.content2.contentTierOf(job.course, job.node)]
    quizEffort = contentEffort(job.tier === '高')
  } catch {
    // 档位缺失不阻塞出题（difficulty/bloom 全缺时折叠兜底中档=非高，同管线口径）
  }
  try {
    const r = await generateQuiz(rt, llmSeam(ctx, rt.corpus.record), job.course, job.node, job.count, {
      ...(job.section ? { section: job.section } : {}),
      ...(job.instruction ? { instruction: job.instruction } : {}),
      isCancelled: () => (job.status as GenJobStatus) === 'cancelling',
      effort: quizEffort,
    })
    if ((job.status as GenJobStatus) === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
    rt.jobs.quizJobResults.set(key, r)
    const dupNote = r.duplicates.length ? `；判重丢弃 ${r.duplicates.length} 道` : ''
    const rejNote = r.rejected.length ? `；无法归节拒收 ${r.rejected.length} 道` : ''
    job.status = 'done'
    job.message = `出题完成：新增 ${r.added} 道（题库共 ${r.total}）${dupNote}${rejNote}${auditNoteOf(r)}${diversityNoteOf(r)}`
  } catch (err) {
    const corpusRef = failCorpus(rt, STATIONS.quiz, err)  // generateQuiz 内已补标，此处取 ref 进失败详情
    job.status = contentFailureStatus(job.status)
    job.message = (err instanceof Error ? err.message : String(err)) + (corpusRef ? `｜语料 生成语料/${corpusRef}` : '')
  } finally {
    persistGenJobs(rt)
    scheduleJobRetention(rt, key, job.status)
    void runLog(rt, 'quiz_job', `「${job.course}/${job.node}」${job.message}（节点档位 ${job.tier ?? '?'}；出题 effort=${quizEffort}）`).catch(() => undefined)
    // 结果暂存（agent 工具读取用）随终态保留期一并清理
    setTimeout(() => rt.jobs.quizJobResults.delete(key), generationJobRetentionMs(job.status)).unref()
  }
}

/** 课程生成管线（逐节）：大纲（AI 自行判断节的划分/顺序/类型，不设固定结构）
 * → 逐节正文（每节一次模型调用；已 ready 节跳过 = 断点续跑）
 * → 逐节出题 + 综合出题。style 只替换节生成模板（课程节生成-<style>），
 * 大纲、断点续跑与门禁与默认管线同一路径；未知 style 在 loadPrompt fail loud。
 * 单节终局失败不中止余节（ADR-0054 continue→partial）：溢出节走「压缩修复→大纲拆节」
 * 阶梯（深度一层、总节数不越上限），其余失败记入结构化失败清单；有失败节时终态
 * partial、出题只对就绪节做出题循环自然跳过无内容节，练习页/失败提示可续跑。
 * 由队列执行泵驱动（pumpGeneration）；直接调用仅限已有 running 归属的路径。 */
async function generateContent(rt: HostRuntime, ctx: Context, course: string, node: string, style?: string): Promise<string> {
  const key = `${course}/${node}`
  const existing = rt.jobs.genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」正在生成中，请稍候。`)
  }
  // 排队任务出队执行：沿用入队时间（FIFO 序与面板展示），覆盖为 running；清掉上一轮
  // 失败清单（续跑语义——本轮终态重新累积，ADR-0054）
  const job: GenJob = existing?.status === 'queued'
    ? { ...existing, status: 'running', phase: 'outline', failures: undefined }
    : { course, node, startedAt: new Date().toISOString(), status: 'running', phase: 'outline', ...(style ? { style } : {}) }
  rt.jobs.genJobs.set(key, job)
  persistGenJobs(rt)
  const complete = llmSeamStripped(ctx, rt.corpus.record)
  const failures: GenJobFailure[] = []
  try {
    const pack = await rt.engine.content2.contentPack(course, node)
    // 档位元数据（GenJob 记录；quiz 量分发与后续弹性评估用）
    try {
      job.tier = TIER_LABELS[await rt.engine.content2.contentTierOf(course, node)]
    } catch {
      // 档位缺失不阻塞生成（difficulty/bloom 全缺时折叠兜底中档，引擎侧不抛）
    }
    // 节模板提前 load：风格名写错在这里 fail loud，不浪费大纲调用
    const sectionTpl = await rt.engine.content2.loadPrompt(style ? `课程节生成-${style}` : '课程节生成')
    const highTier = job.tier === '高'

    // —— 大纲：节清单落盘。已有 ready 节（断点续跑）沿用既有清单，否则重跑覆盖 ——
    let views = await rt.engine.content2.contentSectionsView(course, node)
    if (!views.some(s => s.status === 'ready')) {
      const outlineTpl = await rt.engine.content2.loadPrompt('课程大纲')
      // P4：高复杂度节点的大纲轮升 deep 档
      const outlineEffort = contentEffort(highTier)
      // 大纲用裁剪包（无 §8 交付要求，与逐节正文的全量包分开取）——机器块指令不进
      // YAML 输出调用，完整理由见 content.ts contextPack
      const packOutline = await rt.engine.content2.contentPack(course, node, { omitDeliverables: true })
      // 大纲失败恰一轮回灌重产（outlineRepairFeedback 裁决：护栏/形状/解析可修，其余
      // 原样上抛）；重产仍败直接冒泡置 failed。两轮解析失败都补标语料（大纲站，#213），
      // 容忍命中（剥注释重试过解析）补标 tolerated——失败/容忍样本必存。
      let outlineYaml = await complete(`${outlineTpl}\n\n---\n\n${packOutline}`, undefined, { effort: outlineEffort, station: STATIONS.outline })
      if ((job.status as GenJobStatus) === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
      const applyOutline = async (yaml: string) => {
        const applied = await rt.engine.content2.contentOutline(course, node, yaml)
        if (applied.tolerated.length) rt.corpus.annotateLast(STATIONS.outline, { outcome: 'tolerated' })
      }
      try {
        await applyOutline(outlineYaml)
      } catch (err) {
        if (job.status === 'cancelling') throw err
        const feedback = outlineRepairFeedback(err)
        const outlineRef = failCorpus(rt, STATIONS.outline, err)
        if (!feedback) {
          if (outlineRef && err instanceof Error) err.message += `｜语料 生成语料/${outlineRef}`
          throw err
        }
        outlineYaml = await complete(`${outlineTpl}\n\n---\n\n${packOutline}\n\n${feedback}`, undefined, { effort: outlineEffort, station: STATIONS.outline, kind: 'repair' })
        if ((job.status as GenJobStatus) === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
        try {
          await applyOutline(outlineYaml)
        } catch (repairErr) {
          const outlineRef = failCorpus(rt, STATIONS.outline, repairErr)
          if (outlineRef && repairErr instanceof Error) repairErr.message += `｜语料 生成语料/${outlineRef}`
          throw repairErr
        }
      }
      views = await rt.engine.content2.contentSectionsView(course, node)
      if (!views.length) throw new Error('[generate] 大纲没有产出任何节。')
    }
    job.phase = 'sections'
    job.progress = { done: views.filter(s => s.status === 'ready').length, total: views.length }
    persistGenJobs(rt)

    // —— 逐节正文：每节一次模型调用；单节终局失败不中止余节（continue→partial）——
    // 节间连贯注入（#227）：完整节清单标 i/N + 相邻前节尾部窗口；前节在本轮落盘后
    // 就地刷新视图 md，后节窗口即取到刚生成的结尾（拆节后 freshViews 同口径，前节
    // = 父内前子节或更早的已就绪节）。
    const coherenceOf = (list: typeof views, id: string): SectionCoherence => {
      const i = list.findIndex(v => v.id === id)
      return { sections: list, prevTail: i > 0 ? sectionTailOf(list[i - 1]?.md) : undefined }
    }
    for (const [vi, s] of views.entries()) {
      if (s.status === 'ready') continue
      job.progress = { ...job.progress!, current: s.title }
      persistGenJobs(rt)
      try {
        const r = await applySectionWithRepair(rt, complete, course, node, s, sectionTpl, pack, { isCancelled: () => job.status === 'cancelling', highTier, coherence: coherenceOf(views, s.id) })
        views[vi] = { ...s, md: r.md }
        job.progress = { ...job.progress!, done: job.progress!.done + 1 }
      } catch (err) {
        if (job.status === 'cancelling') throw err
        if (isSectionOverflow(err)) {
          // 溢出阶梯末级：大纲拆节（深度一层——子节生成带 allowSplit:false 不再拆）
          try {
            await splitOverflowSection(rt, complete, course, node, s)
            const freshViews = await rt.engine.content2.contentSectionsView(course, node)
            const subViews = freshViews.filter(v => v.id.startsWith(`${s.id}-`))
            job.progress = {
              done: freshViews.filter(v => v.status === 'ready').length,
              total: freshViews.length,
              current: s.title,
            }
            for (const sub of subViews) {
              if ((job.status as GenJobStatus) === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
              job.progress = { ...job.progress!, current: sub.title }
              persistGenJobs(rt)
              try {
                const r = await applySectionWithRepair(rt, complete, course, node, sub, sectionTpl, pack, { isCancelled: () => job.status === 'cancelling', highTier, allowSplit: false, coherence: coherenceOf(freshViews, sub.id) })
                freshViews[freshViews.findIndex(v => v.id === sub.id)] = { ...sub, md: r.md }
                job.progress = { ...job.progress!, done: job.progress!.done + 1 }
              } catch (subErr) {
                if ((job.status as GenJobStatus) === 'cancelling') throw subErr
                const corpusRef = failCorpus(rt, STATIONS.section, subErr)
                failures.push({ ...sectionFailure(subErr, sub), ...(corpusRef ? { corpusRef } : {}) })
              }
            }
          } catch (splitErr) {
            if ((job.status as GenJobStatus) === 'cancelling') throw splitErr
            const corpusRef = failCorpus(rt, STATIONS.split, splitErr)
            failures.push({ ...sectionFailure(splitErr, s), ...(corpusRef ? { corpusRef } : {}) })
          }
        } else {
          const corpusRef = failCorpus(rt, STATIONS.section, err)
          failures.push({ ...sectionFailure(err, s), ...(corpusRef ? { corpusRef } : {}) })
        }
      }
      persistGenJobs(rt)
    }
    const done = job.progress!.total - failures.length
    const failedTitles = failures.map(f => `「${f.sectionTitle ?? f.sectionId ?? '?'}」`).join('、')
    const contentMsg = failures.length
      ? `「${node}」正文部分完成（${done}/${job.progress!.total} 节；未完成：${failedTitles}——失败提示可「重试续跑」或定点重写）`
      : `「${node}」正文完成（${job.progress!.total} 节）`
    const msg = await finishWithQuiz(rt, complete, job, contentMsg)
    if (failures.length) {
      // 出题成功也不掩盖节失败：partial = 未完成全部必需阶段（Partial 词条语义）
      job.status = 'partial'
      job.message = msg
      job.failures = failures
      persistGenJobs(rt)
    }
    return msg
  } catch (err) {
    job.status = contentFailureStatus(job.status)
    job.message = err instanceof Error ? err.message : String(err)
    if (failures.length) job.failures = failures
    persistGenJobs(rt)
    throw err
  } finally {
    // 终态保留：失败/取消/部分完成留 24h 供排查与重试，成功留 30 分钟；之后清出注册表
    scheduleJobRetention(rt, key, job.status)
    // 档位记录（#228）：正文初跑与两路出题的 effort 都随节点难度声明，运行日志留痕供成本对照
    void runLog(rt, 'content_job', `「${course}/${node}」${job.message ?? ''}（节点档位 ${job.tier ?? '?'}；正文/出题 effort=${contentEffort(job.tier === '高')}）`).catch(() => undefined)
  }
}

/** 管线收尾：逐节出题（每内容节按档位目标题量，绑节 id）+ 综合题（通用随档位），汇总任务终态。
 * 两路出题都显式声明语义档（#228）：随节点难度 contentEffort（高复杂度 deep、否则 fast）。 */
async function finishWithQuiz(rt: HostRuntime, complete: LlmComplete, job: GenJob, contentMsg: string): Promise<string> {
  job.phase = 'quiz'
  job.message = `${contentMsg}；自动出题中…`
  persistGenJobs(rt)
  const quizEffort = contentEffort(job.tier === '高')
  try {
    const per = await rt.engine.bank2.questionGenerateSections(job.course, job.node, quizSeam(complete, quizEffort),
      rt.quizAuditRate > 0 ? { secondOpinion: { rate: rt.quizAuditRate } } : undefined)
    const quiz = await generateQuiz(rt, complete, job.course, job.node, genericQuizTarget(tierIdxOf(job.tier)), { generic: true, effort: quizEffort })
    const outcome = quizSuccessOutcome(contentMsg, per.added, quiz.added, quiz.total)
    job.status = outcome.status
    job.message = outcome.message
      + (auditNoteOf(per) + auditNoteOf(quiz) || '')
      // 多样性读数取综合出题那一次（题库累计含逐节批，两路共用一个题库）
      + diversityNoteOf(quiz)
  } catch (quizErr) {
    const outcome = quizFailureOutcome(contentMsg, quizErr)
    job.status = outcome.status
    job.message = outcome.message
  }
  persistGenJobs(rt)
  return job.message
}

/** 单节重写：节任务上下文 → 模型 → sectionApply（与管线共用同一拼装、门禁与修复回路；
 * 剥围栏缝同管线；allowSplit:false——重写不改大纲结构，溢出如实报错）。 */
export async function generateSection(rt: HostRuntime, ctx: Context, course: string, node: string, sectionId: string): Promise<string> {
  const pack = await rt.engine.content2.contentPack(course, node)
  const views = await rt.engine.content2.contentSectionsView(course, node)
  const s = views.find(v => v.id === sectionId)
  if (!s) throw new Error(`「${node}」没有节「${sectionId}」——先运行大纲。`)
  const sectionTpl = await rt.engine.content2.loadPrompt('课程节生成')
  const highTier = TIER_LABELS[await rt.engine.content2.contentTierOf(course, node)] === '高'
  // 节间连贯注入与管线同构（#227）：views 刚读、前节 md 在场；重写中节的清单位次照旧
  const sIdx = views.findIndex(v => v.id === sectionId)
  const coherence: SectionCoherence = { sections: views, prevTail: sIdx > 0 ? sectionTailOf(views[sIdx - 1]?.md) : undefined }
  // 与管线同款剥围栏缝（管线产出口对 ``` 围栏容忍，重写通道此前裸缝更脆，ADR-0054）；
  // allowSplit:false——「重写这一节」的意图是重写本节，不自动改大纲结构（溢出即如实报错）
  const r = await applySectionWithRepair(rt, llmSeamStripped(ctx, rt.corpus.record), course, node, s, sectionTpl, pack, { highTier, allowSplit: false, coherence })
  return `[section] 「${r.title}」v${r.version} 落盘。`
}

/** 项目里程碑计划生成（P 区 #92）：计划提示词包 → 缝 complete（fast 档，#162 计划站
 * 迁入缝）→ 提案受理（人审后 apply 带快照生效）。受理门在 projectPlanPropose——
 * 计划草案一次成型、无修复轮（修订走提案快照的人审语义，草案不自动重试）。 */
export async function generateProjectPlan(rt: HostRuntime, id: string): Promise<string> {
  const prompt = await rt.engine.project.projectPlanPack(id)
  const yaml = await rt.agent.complete('计划草案', prompt, { effort: 'fast' })
  const prop = await rt.engine.project.projectPlanPropose(id, yaml)
  return `[project-plan] 提案 #${prop.id} 已受理（${prop.initial ? '初次规划' : '计划修订'}：${prop.milestones} 个里程碑）——人审后 learnhub_project_apply 生效（apply 带旧计划快照）。`
}

/** 项目里程碑产物生成：任务卡提示词包 → 缝 complete（fast 档）→ 轻量结构门（未过经
 * 缝的门错修复轮回灌重产恰一次，deep 档）→ 首生直落 / 已生成自动转重生成提案（带快照，
 * 不静默覆盖）。写盘是受理式门：过门即落产物，经 GateVerdict.result 随行交还。 */
export async function generateProjectMilestone(rt: HostRuntime, id: string, milestoneId: string): Promise<string> {
  const agent = rt.agent
  const prompt = await rt.engine.project.projectMilestonePack(id, milestoneId)
  const write = (md: string) => rt.engine.project.projectMilestoneWrite(id, milestoneId, md)
  type MilestoneWriteResult = Awaited<ReturnType<typeof write>>
  const round = await agent.gateRepairRound<string, MilestoneWriteResult>('里程碑草案', {
    first: () => agent.complete('里程碑草案', prompt, { effort: 'fast' }),
    gate: async (md): Promise<GateVerdict<MilestoneWriteResult>> => {
      try {
        return { errors: [], result: await write(md) }
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
        if (code !== 'MILESTONE_GATE_FAILED') throw err
        return { errors: [err instanceof Error ? err.message : String(err)] }
      }
    },
    repair: (gateErrors, rejected) =>
      agent.repair('里程碑草案', Content.sectionRepairPrompt(prompt, rejected, gateErrors.join('\n')), { effort: 'deep' }),
    // 修复轮仍败：原样以门错误抛出（与旧直抛形态同文案同码，零提案落盘语义不变）
    fatal: (_firstErrors, repairErrors) => Object.assign(new Error(repairErrors.join('\n')), { code: 'MILESTONE_GATE_FAILED' }),
  })
  const out = round.result
  return 'written' in out
    ? `[project-milestone] 「${out.written}」已落盘（档位 ${out.tier}）。`
    : `[project-milestone] 「${out.file}」已生成过——按档重生成走提案 #${out.proposed}，人审后 learnhub_project_apply 生效（旧文带快照）。`
}

/** 整课重置 + 拓扑序串行重跑生成链（HTTP 与 agent 工具共用）：
 * contentReset 备份旧产物并重写 draft → 清掉该课程遗留任务（含排队）→ 按拓扑序逐节点入队全局队列。
 * 立即返回 { reset, queued }；进度由任务注册表展示。课程有 running 任务时拒绝。 */
export async function resetCourseChain(rt: HostRuntime, ctx: Context, courseKey: string): Promise<{ reset: Awaited<ReturnType<LearnhubEngine['content2']['contentReset']>>; queued: number }> {
  assertQueueWritable(rt)
  const running = [...rt.jobs.genJobs.values()].filter(j => j.course === courseKey && (j.status === 'running' || j.status === 'cancelling'))
  if (running.length) throw new Error(`课程「${courseKey}」有 ${running.length} 个生成任务进行中，先取消或等完成再重生成。`)
  const c = await rt.engine.registry.resolve(courseKey)
  const { graph } = await rt.engine.loadView(c)
  const reset = await rt.engine.content2.contentReset(c.name)
  for (const [key, j] of rt.jobs.genJobs.entries()) if (j.course === c.name) rt.jobs.genJobs.delete(key)
  persistGenJobs(rt)
  // 整课重生成是显式意图：解除重启暂停，让链条立即开跑
  rt.flags.queuePaused = false
  let queued = 0
  for (const node of graph.order.length ? graph.order : graph.names) {
    try {
      await enqueueGeneration(rt, ctx, c.name, node)
      queued++
    } catch (err) {
      // 终点不进链（#199 生成门）：跳过；其余入队错误照常上抛
      if ((err as { code?: unknown }).code !== 'ENDPOINT_GENERATION_FORBIDDEN') throw err
    }
  }
  return { reset, queued }
}

/** 任务注册表视图（附各任务节点的内容版本：面板据此做增量刷新）+ 全局队列状态。
 * broken = 生成任务档损坏文案（#194：生成页显式报错 + 修复指引）。 */
export async function generationStatus(rt: HostRuntime): Promise<{
  jobs: Array<GenJob & { key: string; contentVersion?: number }>
  queuePaused: boolean
  queuedCount: number
  broken: string | null
}> {
  const jobs: Array<GenJob & { key: string; contentVersion?: number }> = []
  for (const [key, j] of rt.jobs.genJobs.entries()) {
    let contentVersion: number | undefined
    try {
      contentVersion = await rt.engine.content2.contentVersion(j.course, j.node)
    } catch {
      // 节点/课程缺失等：版本缺省，面板走全量刷新
    }
    jobs.push({ key, ...j, contentVersion })
  }
  return {
    jobs,
    queuePaused: rt.flags.queuePaused,
    queuedCount: jobs.filter(j => j.status === 'queued').length,
    broken: rt.flags.genQueueBroken,
  }
}

export function cancelGeneration(rt: HostRuntime, course: string, node: string): { cancelled: boolean; status?: string } {
  const job = rt.jobs.genJobs.get(`${course}/${node}`)
  if (!job) return { cancelled: false }
  // 排队任务取消 = 直接移出队列（还没开跑，无需取消旗标）
  if (job.status === 'queued') {
    rt.jobs.genJobs.delete(`${course}/${node}`)
    persistGenJobs(rt)
    return { cancelled: true, status: 'queued' }
  }
  if (job.status === 'running') job.status = 'cancelling'
  return { cancelled: true, status: job.status }
}

/** 恢复重启后暂停的队列（/generate/resume 出口）：清暂停旗标并复泵；返回恢复时在队任务数。
 * broken 态（#194）拒绝：队列不可开跑（写回闸），先修复任务档再重启宿主。 */
export function resumeQueue(rt: HostRuntime, ctx: Context): { paused: boolean; resumed: number } {
  assertQueueWritable(rt)
  const resumed = [...rt.jobs.genJobs.values()].filter(j => j.status === 'queued').length
  rt.flags.queuePaused = false
  pumpGeneration(rt, ctx)
  return { paused: false, resumed }
}


/** 生成任务注册表恢复（apply 装配步，fire-and-forget）：running/cancelling 随进程消失标失败；
 * queued 保留但队列置为暂停（不自动开跑——重启后静默烧 token 是惊吓，生成页一键恢复）；
 * 图域任务负载随档恢复（#157：种子/反编译/计划/里程碑的 payload 与生长批 inject/裁决
 * 面板下发时随任务落盘，恢复缺失即无法执行——负载要求的 queued 任务在恢复处明确标
 * 失败可重试，不拖到执行器抛「负载缺失或 phase 未知」）；恢复清扫与幸存终态按剩余
 * 保留期补挂定时器（跨重启只能靠时间戳结算，ADR-0039）。任务档 Broken（#194 / 
 * ADR-0053）：队列置 broken 态——生成页显式报错 + 修复指引，写回闸拒绝一切落盘，
 * 宿主其余功能不受影响。 */
export function restoreGenJobs(rt: HostRuntime): void {
  void rt.engine.loadGenJobs()
    .catch(err => {
      // 任务档 Broken（#194 / ADR-0053）：注册表不是学习事实源，不升格宿主硬失败
      // ——队列置 broken 态：生成页显式报错 + 修复指引，写回闸拒绝一切落盘（坏档字节
      // 原样保留，防下一次入队全量覆盖）。顺带补上此前缺失的拒绝处理（一抛即 unhandled）。
      // 只罩读档：broken 语义 = 任务档损坏；恢复内环的意外错误归链尾 catch，不误锁写回闸。
      rt.flags.genQueueBroken = err instanceof Error ? err.message : String(err)
      console.error(`[learnhub] gen-jobs restore failed: ${rt.flags.genQueueBroken}`)
      void runLog(rt, 'gen_jobs_restore', `生成任务档恢复失败，队列置 broken 态：${rt.flags.genQueueBroken}`).catch(() => undefined)
      return null
    })
    .then(async stale => {
      if (!stale) return
      for (const raw of stale) {
        const j = raw as Partial<GenJob>
        if (typeof j.course !== 'string' || typeof j.node !== 'string') continue
        const key = `${j.course}/${j.node}`
        const interrupted = j.status === 'running' || j.status === 'cancelling'
        const restored: GenJob = {
          course: j.course, node: j.node,
          startedAt: typeof j.startedAt === 'string' ? j.startedAt : new Date().toISOString(),
          status: interrupted ? 'failed' : (j.status ?? 'failed'),
          ...(j.phase ? { phase: normalizeGenJobPhase(j.phase as string) } : {}),
          ...(j.progress ? { progress: j.progress } : {}),
          ...(j.style ? { style: j.style } : {}),
          // 纯出题任务参数随注册表持久化，恢复后按原样重跑/继续（#118）
          ...(typeof j.count === 'number' ? { count: j.count } : {}),
          ...(j.section && typeof j.section === 'object'
            && typeof (j.section as { id?: unknown }).id === 'string'
            && typeof (j.section as { title?: unknown }).title === 'string'
            ? { section: { id: (j.section as { id: string }).id, title: (j.section as { title: string }).title } } : {}),
          ...(typeof j.instruction === 'string' ? { instruction: j.instruction } : {}),
          ...(typeof j.model === 'string' ? { model: j.model } : {}),
          // 生长批裁决面随档恢复（#157）：inject 是排队任务的执行负载，outcome 是
          // 重拉阻尼的判据（恢复丢失会让「上批停摆/暂不产结构」的裁决被无声抹掉）
          ...(typeof j.growthInject === 'string' ? { growthInject: j.growthInject } : {}),
          ...(j.growthOutcome === 'idle' || j.growthOutcome === 'no_structure' || j.growthOutcome === 'applied'
            ? { growthOutcome: j.growthOutcome } : {}),
          // 图域任务负载随档恢复（#157）：形状由写入侧（面板下发）保证，这里只做
          // 「非空对象」闸——损坏负载进执行器由引擎契约 fail loud，不做静默兜底
          ...(j.seedPayload && typeof j.seedPayload === 'object' ? { seedPayload: j.seedPayload } : {}),
          ...(j.decompilePayload && typeof j.decompilePayload === 'object' ? { decompilePayload: j.decompilePayload } : {}),
          ...(j.planPayload && typeof j.planPayload === 'object' ? { planPayload: j.planPayload } : {}),
          ...(j.milestonePayload && typeof j.milestonePayload === 'object' ? { milestonePayload: j.milestonePayload } : {}),
          message: interrupted ? '进程重启，任务中断——可重试' : (typeof j.message === 'string' ? j.message : undefined),
          // 终态时刻随档恢复（保留期跨重启的起算点）；中断标失败的从恢复当下起算
          ...(interrupted
            ? { finishedAt: new Date().toISOString() }
            : (typeof j.finishedAt === 'string' ? { finishedAt: j.finishedAt } : {})),
        }
        // 负载要求的排队图域任务恢复后缺负载（旧档案/未完整落盘）：明确标失败可重试，
        // 不留 queued 假象——恢复队列一键开跑时才炸出「负载缺失或 phase 未知」是静默变形
        if (restored.status === 'queued' && graphJobPayloadGap(restored.phase, restored) === 'payload_missing') {
          restored.status = 'failed'
          restored.message = '任务负载缺失（重启前未完整落盘），无法恢复执行——请从面板重新下发（可重试）。'
          restored.finishedAt = new Date().toISOString()
        }
        rt.jobs.genJobs.set(key, restored)
      }
      // 恢复清扫（ADR-0039）：内容已删的悬空记录清除（不做墓碑），终态超保留期一并出册
      // ——重启前挂的保留期定时器已随进程消失，跨重启只能靠时间戳在这里结算
      const swept = await sweepGenJobs(rt)
      // 幸存终态按剩余保留期补挂定时器
      for (const [key, j] of rt.jobs.genJobs) {
        if (!isGenJobTerminal(j.status)) continue
        scheduleJobRetention(rt, key, j.status, genJobRetentionRemainingMs(j, Date.now()))
      }
      const aliveQueued = [...rt.jobs.genJobs.values()].filter(j => j.status === 'queued').length
      if (aliveQueued > 0) rt.flags.queuePaused = true
      persistGenJobs(rt)
      if (stale.length) {
        console.log(`[learnhub] gen-jobs restored: ${stale.length} (swept ${swept} dangling/expired${aliveQueued ? `, ${aliveQueued} queued paused` : ''})`)
      }
    })
    .catch(err => {
      // 恢复内环意外失败（清扫/补挂等）：留痕不置 broken——broken 语义 = 任务档损坏，
      // 内环错误与档无关，误标会把写回闸锁在非损坏态上
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[learnhub] gen-jobs restore error: ${msg}`)
      void runLog(rt, 'gen_jobs_restore', `生成任务恢复内环失败：${msg}`).catch(() => undefined)
    })
}
