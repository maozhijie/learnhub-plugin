/**
 * learnhub 学习引擎插件（Host 侧，bundle 形态）—— v3 纯 TS 引擎。
 *
 * Python 引擎已退役：原 `spawn python -m learnhub` 的全部命令面由
 * src/engine/（TS）同进程承载，本文件只做三件事：
 * - agent 工具面：57 个 defineTool 直调 engine（学习/数据体检/图谱/生成/题库/笔记源/学习者产出/项目/Anki 互通）
 * - HTTP 路由 /learnhub/api/*：面板后端，直调 engine
 * - /learnhub 独立面板页（伺服 web/dist Vite SPA）+ /file 媒体路由
 *
 * 跨机器部署：vault/中心路径不硬编码，由 cordis 行 config 提供
 * （config.vault 必填；centerRel 缺省「学习中心」），机器差异写在
 * profile 的 cordis.patch.yml，仓库内不含任何机器路径。
 *
 * 纪律：
 * - D14（v3）：一切数据访问收口 engine/ 模块；工具/路由/UI 不得绕过 engine 直写数据文件。
 * - D15：评分只经工作单 → settle 入库；UI 自动写回也只写工作单评分行。
 * - 每次工具/路由调用追加 state/运行日志.md（LOG_LIMIT 截断）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { readFile, unlink, writeFile, appendFile, mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LearnhubEngine } from './engine/index.ts'
import { Content } from './engine/content.ts'
import { ANKI_ENDPOINT, AnkiConnectClient } from './engine/anki.ts'
import { TIER_LABELS, tierIdxOf, genericQuizTarget } from './engine/complexity.ts'
import { applyId, bandPref, questionCount, rejectId, requireSkipDirection } from './tool-contracts.ts'
import {
  contentFailureStatus,
  generationJobRetentionMs,
  nextQueuedJob,
  quizFailureOutcome,
  quizSuccessOutcome,
  type GenJobStatus,
} from './generation-jobs.ts'

export const name = 'dsh-learnhub'
export const inject = ['tools', 'webServer', 'llm']

/** apply 时的行 config：部署路径与 AI 路由，均可在 profile patch 覆盖。 */
export interface LearnhubConfig {
  /** vault 根目录绝对路径（必填，各机器不同）。 */
  vault?: string
  /** 学习中心相对 vault 的路径（缺省「学习中心」）。 */
  centerRel?: string
  /** AI 生成/判卷的 llm seam provider。 */
  provider?: string
  /** AI 生成/判卷的模型名。 */
  model?: string
  /** 大纲/节正文等机械调用的思考档（缺省 off 提速；路由不支持该档位时自动降级为部署默认）。 */
  fastEffort?: 'off' | 'low'
  /** 高复杂度节点（难度≥4/深节点）的大纲与修复轮的思考档（缺省 low；P4 分层 effort）。 */
  deepEffort?: 'off' | 'low'
}

/** AI 调用的 provider/model/快速档/高档（cordis 行 config 可覆盖，apply 时写入）。 */
const llmCfg = {
  provider: 'deepseek-official', model: 'deepseek-v4-flash',
  fastEffort: 'off' as 'off' | 'low',
  deepEffort: 'low' as 'off' | 'low',
}

/** P4 分层 effort：机械调用统一走 fastEffort；高复杂度节点的大纲/修复轮升 deepEffort。
 * 调用点以此替代散落的 { effort: llmCfg.fastEffort }，档位只在任务级决定。 */
function contentEffort(highTier: boolean): 'off' | 'low' {
  return highTier ? llmCfg.deepEffort : llmCfg.fastEffort
}

/** 课程生成任务注册表（course/node 键）：面板「生成」页签的状态源，
 * 页面刷新后从这里恢复（allo 同语义：服务端注册表是事实来源）；
 * 状态每次变更全量落盘 state/生成任务.json，host 重启后读入并把遗留 running 标为失败。 */
interface GenJob {
  course: string
  node: string
  startedAt: string
  status: GenJobStatus
  /** 组合管线的当前阶段：大纲（outline）→ 逐节正文（sections）→ 自动出题（quiz）。 */
  phase?: 'outline' | 'sections' | 'quiz'
  /** 逐节进度：done=已就绪节数 total=总节数 current=正在生成的节标题。 */
  progress?: { done: number; total: number; current?: string }
  message?: string
  /** 节生成提示词风格变体（缺省默认「课程节生成」）。 */
  style?: string
  /** 节点复杂度档位（低/中/高；生成入口算好写入，面板进度与弹性评估可读）。 */
  tier?: '低' | '中' | '高'
}
const genJobs = new Map<string, GenJob>()

/** 注册表落盘（fire-and-forget；D14：文件 IO 收口 engine）。 */
function persistGenJobs(): void {
  void engine.saveGenJobs([...genJobs.values()].map(j => ({ ...j })))
    .catch(() => { /* 落盘失败不影响内存态（下次变更重试） */ })
}

let VAULT = ''
let CENTER_REL = '学习中心'
let engine: LearnhubEngine

/** 单条运行日志输出截断上限（与 OB 插件同源）。 */
const LOG_LIMIT = 1500
/** 客户端面板的 HTTP 路由前缀。 */
const API = '/learnhub/api'
/** 独立面板页面路由（伺服 web/dist）。 */
const PAGE = '/learnhub'
/** 面板 SPA 构建产物目录（ui/ 经 vite build 产出；每次请求现读，改 UI 无需重启）。 */
const PAGE_DIST = fileURLToPath(new URL('../web/dist/', import.meta.url))
/** vendored 库目录（交互件沙箱 CSP 放开 'self' 后的唯一取库途径；build.mjs copyVendor 落盘）。 */
const VENDOR_DIST = fileURLToPath(new URL('../web/vendor/', import.meta.url))
/** /file 路由允许伺服的二进制媒体扩展名 → MIME（课程插图等）。 */
const FILE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

/** 面板 SPA 资产扩展名 → MIME。 */
const ASSET_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
}

/** 运行日志：每次引擎调用的记录（工具名 + 输出摘要）。 */
async function runLog(tool: string, output: string): Promise<void> {
  const path = `${engine.paths.centerStateDir}/运行日志.md`
  try {
    if (!existsSync(path)) {
      await mkdir(engine.paths.centerStateDir, { recursive: true })
      await appendFile(path, '# 运行日志\n\n> 插件调用 learnhub 引擎的记录。引擎自动产出，勿手工改。\n', 'utf8')
    }
    const ts = new Date().toLocaleString('sv-SE')
    const clip = output.length > LOG_LIMIT ? output.slice(0, LOG_LIMIT) + '\n…（已截断）' : output
    await appendFile(path, `\n## ${ts} · ${tool}\n\n\`\`\`\n${clip.trim() || '（无输出）'}\n\`\`\`\n`, 'utf8')
  } catch {
    // 日志失败不影响主流程
  }
}

/** D14 v3 唯一出口：engine 调用 + 运行日志。 */
async function run(tool: string, fn: () => Promise<string>): Promise<string> {
  const out = await fn()
  await runLog(tool, out)
  return out
}

/** 面板路由出口：引擎返回对象原样透传（sendJson 统一序列化一次），
 * 日志记录序列化摘要。绝不在路由里手动 stringify 对象——会双编码。 */
async function apiRun<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  const out = await fn()
  await runLog(tool, typeof out === 'string' ? out : JSON.stringify(out))
  return out
}

/** dsh llm 一次性调用：收集 text-delta；终止块非 success 即抛错。
 * opts.effort 指定思考档（如 'off' 快速路径）；路由不支持该档位时
 * （UNSUPPORTED_REASONING_EFFORT）自动降级为部署默认重试一次。 */
async function llmComplete(ctx: Context, prompt: string, system?: string, opts?: { effort?: 'off' | 'low' }): Promise<string> {
  if (opts?.effort === undefined) return llmStreamOnce(ctx, prompt, system)
  try {
    return await llmStreamOnce(ctx, prompt, system, opts.effort)
  } catch (err) {
    if (!(err instanceof Error && (err as { code?: string }).code === 'UNSUPPORTED_REASONING_EFFORT')) throw err
    return llmStreamOnce(ctx, prompt, system)
  }
}

/** llmComplete 的单次流式执行；effort 非空时显式指定思考档。 */
async function llmStreamOnce(ctx: Context, prompt: string, system?: string, effort?: 'off' | 'low'): Promise<string> {
  const msg = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: prompt }],
  })
  let text = ''
  let truncated = false
  const stream = ctx.llm.stream({
    provider: llmCfg.provider, model: llmCfg.model, messages: [msg],
    ...system === undefined ? {} : { system },
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error')) {
      if (chunk.reason.kind === 'aborted') throw new Error('模型调用被取消')
      // failure.code 是稳定错误码（NO_ADAPTER/MISSING_CREDENTIAL/AUTH/RATE_LIMIT/...），一眼定位配置问题
      const f = chunk.reason.failure
      const status = f.status ? `/${f.status}` : ''
      const e: Error & { code?: string } = new Error(`模型调用失败[${f.code}${status}]：${String(f.message)}`)
      e.code = f.code
      throw e
    }
    if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') truncated = true
  }
  if (!text.trim()) throw new Error('模型没有返回内容')
  if (truncated) console.warn('[learnhub] 警告：模型输出被 max-tokens 截断，正文可能不完整')
  return text.trim()
}

/** 剥掉模型可能包住的整段 markdown 代码围栏：限 markdown/yaml/json 等数据类标签——
 * 正文类标签（svg/plot 等）本身是内容的一部分，剥掉会毁掉 ```svg/```plot 引用块。 */
function stripFences(body: string): string {
  const m = body.match(/^```(?:markdown|md|yaml|yml|json)?\s*\n([\s\S]*?)\n```\s*$/)
  return m ? m[1] : body
}

/** AI 出题管线：节点正文 → 出题提示词 → llm → validateBank 门禁逐题落盘。
 * opts 透传节标注清单/综合题模式（逐节管线的出题段）。 */
async function generateQuiz(ctx: Context, course: string, node: string, count: number, opts?: { sections?: Array<{ id: string; title: string }>; generic?: boolean }) {
  return engine.questionGenerate(course, node, count, async prompt => stripFences(await llmComplete(ctx, prompt)), opts)
}

/** 节生成提示词拼装：模板 + 本节任务（id/标题/类型）+ 上下文包。 */
function sectionPrompt(tpl: string, pack: string, s: { id: string; title: string; type: string }): string {
  return `${tpl}\n\n## 本节任务\n\n- 节 id：${s.id}\n- 节标题：${s.title}\n- 节类型：${s.type}\n\n---\n\n${pack}`
}

/** 逐节生成共用出口：模型产出 → sectionApply；质检门未过时把门禁清单回灌模型修复一轮
 * （仅一轮，防循环；修复轮仍未过则带说明抛出）。fast 档模型偶发违反硬约束
 * （### 子标题/超长正文/非 JSON plot），一次盲跑定生死会让管线反复卡在同一节。
 * P4：正文初跑恒 fastEffort；修复轮按 highTier 升 deepEffort（复杂节点值得多思考一轮）。
 * isCancelled 在每次模型产出后检查，取消即丢结果。 */
async function applySectionWithRepair(
  ctx: Context, course: string, node: string,
  s: { id: string; title: string; type: string }, tpl: string, pack: string,
  opts?: { isCancelled?: () => boolean; highTier?: boolean },
): Promise<{ version: number; title: string; hints: string[] }> {
  const cancelled = () => opts?.isCancelled?.() ?? false
  const first = stripFences(await llmComplete(ctx, sectionPrompt(tpl, pack, s), undefined, { effort: llmCfg.fastEffort }))
  if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
  let gateReport = ''
  try {
    return await engine.contentSection(course, node, s.id, first)
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    if (code !== 'GATE_FAILED') throw err
    gateReport = err.message
  }
  const repaired = stripFences(await llmComplete(
    ctx,
    Content.sectionRepairPrompt(sectionPrompt(tpl, pack, s), first, gateReport),
    undefined, { effort: contentEffort(opts?.highTier === true) },
  ))
  if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
  try {
    return await engine.contentSection(course, node, s.id, repaired)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${msg}\n（已按门禁清单自动修复重试一轮，仍未通过——可对单节重写或在面板人工修正后 learnhub_content_check）`)
  }
}

// ---- 全局生成队列：任意入口入队（面板/agent/整课链），同一时刻只执行一个节点管线 ----

/** 重启恢复后暂停旗标：遗留排队任务不自动开跑（避免静默烧 token），生成页一键恢复。 */
let genQueuePaused = false
/** 队列执行器是否正占有一个管线槽位（全局单并发闸）。 */
let genPumping = false

/** 入队一个节点的生成任务（FIFO；重复入队幂等）。同一节点 running/cancelling 时拒绝。 */
function enqueueGeneration(ctx: Context, course: string, node: string, style?: string): { message: string; queued: boolean } {
  const key = `${course}/${node}`
  const existing = genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」正在生成中，请稍候。`)
  }
  if (existing?.status === 'queued') {
    const ahead = [...genJobs.values()].filter(j => j.status === 'queued' && j.startedAt < existing.startedAt).length
    return { message: `「${node}」已在队列中（前面还有 ${ahead} 个任务）。`, queued: true }
  }
  genJobs.set(key, {
    course, node, startedAt: new Date().toISOString(), status: 'queued',
    ...(style ? { style } : {}),
    message: '排队等待生成…',
  })
  persistGenJobs()
  pumpGeneration(ctx)
  return { message: `「${node}」已入队，将在后台按序生成（进度见生成页）。`, queued: true }
}

/** 队列执行泵：空闲且未暂停时取队首排队任务跑管线；跑完（含失败）继续泵下一个。 */
function pumpGeneration(ctx: Context): void {
  if (genPumping || genQueuePaused) return
  const next = nextQueuedJob([...genJobs.values()])
  if (!next) return
  genPumping = true
  void generateContent(ctx, next.course, next.node, next.style)
    .catch(() => { /* generateContent 已置 failed 留注册表可重试 */ })
    .finally(() => {
      genPumping = false
      pumpGeneration(ctx)
    })
}

/** 课程生成管线（逐节）：大纲（AI 自行判断节的划分/顺序/类型，不设固定结构）
 * → 逐节正文（每节一次模型调用；已 ready 节跳过 = 断点续跑）
 * → 逐节出题 + 综合出题。style 只替换节生成模板（课程节生成-<style>），
 * 大纲、断点续跑与门禁与默认管线同一路径；未知 style 在 loadPrompt fail loud。
 * 出题失败不回滚正文：任务标记 partial 并在 message 里说明，练习页可单独重试出题。
 * 由队列执行泵驱动（pumpGeneration）；直接调用仅限已有 running 归属的路径。 */
async function generateContent(ctx: Context, course: string, node: string, style?: string): Promise<string> {
  const key = `${course}/${node}`
  const existing = genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」正在生成中，请稍候。`)
  }
  // 排队任务出队执行：沿用入队时间（FIFO 序与面板展示），覆盖为 running
  const job: GenJob = existing?.status === 'queued'
    ? { ...existing, status: 'running', phase: 'outline' }
    : { course, node, startedAt: new Date().toISOString(), status: 'running', phase: 'outline', ...(style ? { style } : {}) }
  genJobs.set(key, job)
  persistGenJobs()
  try {
    const pack = await engine.contentPack(course, node)
    // 档位元数据（GenJob 记录；quiz 量分发与后续弹性评估用）
    try {
      job.tier = TIER_LABELS[await engine.contentTierOf(course, node)]
    } catch {
      // 档位缺失不阻塞生成（difficulty/bloom 全缺时折叠兜底中档，引擎侧不抛）
    }
    // 节模板提前 load：风格名写错在这里 fail loud，不浪费大纲调用
    const sectionTpl = await engine.loadPrompt(style ? `课程节生成-${style}` : '课程节生成')
    const highTier = job.tier === '高'

    // —— 大纲：节清单落盘。已有 ready 节（断点续跑）沿用既有清单，否则重跑覆盖 ——
    let views = await engine.contentSectionsView(course, node)
    if (!views.some(s => s.status === 'ready')) {
      const outlineTpl = await engine.loadPrompt('课程大纲')
      // P4：高复杂度节点的大纲轮升思考档（deepEffort）
      const outlineEffort = contentEffort(highTier)
      // 大纲护栏未过（OUTLINE_BUDGET）时重跑一次并回灌节数与预期区间，仍失败才置 failed
      let outlineYaml = stripFences(await llmComplete(ctx, `${outlineTpl}\n\n---\n\n${pack}`, undefined, { effort: outlineEffort }))
      if (job.status === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
      try {
        await engine.contentOutline(course, node, outlineYaml)
      } catch (err) {
        if (job.status === 'cancelling' || (err instanceof Error && (err as Error & { code?: string }).code !== 'OUTLINE_BUDGET')) throw err
        outlineYaml = stripFences(await llmComplete(ctx, `${outlineTpl}\n\n---\n\n${pack}\n\n## 大纲护栏反馈\n\n上一次大纲未过护栏（节数与本节点复杂度不匹配）：\n${err instanceof Error ? err.message : String(err)}\n\n请按上下文包 §9 复杂度档案的节段数区间重新规划。`, undefined, { effort: outlineEffort }))
        if (job.status === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
        await engine.contentOutline(course, node, outlineYaml)
      }
      views = await engine.contentSectionsView(course, node)
      if (!views.length) throw new Error('[generate] 大纲没有产出任何节。')
    }
    job.phase = 'sections'
    job.progress = { done: views.filter(s => s.status === 'ready').length, total: views.length }
    persistGenJobs()

    // —— 逐节正文：每节一次模型调用（门禁未过自动修复一轮）；取消置旗标后丢结果 ——
    for (const s of views) {
      if (s.status === 'ready') continue
      job.progress = { ...job.progress!, current: s.title }
      persistGenJobs()
      await applySectionWithRepair(ctx, course, node, s, sectionTpl, pack, { isCancelled: () => job.status === 'cancelling', highTier })
      job.progress = { done: job.progress!.done + 1, total: job.progress!.total }
      persistGenJobs()
    }
    return await finishWithQuiz(ctx, job, `「${node}」正文完成（${job.progress!.total} 节）`)
  } catch (err) {
    job.status = contentFailureStatus(job.status)
    job.message = err instanceof Error ? err.message : String(err)
    persistGenJobs()
    throw err
  } finally {
    // 终态保留：失败/取消/部分完成留 24h 供排查与重试，成功留 30 分钟；之后清出注册表
    const keep = generationJobRetentionMs(job.status)
    setTimeout(() => {
      const cur = genJobs.get(key)
      if (cur && cur.status !== 'running' && cur.status !== 'cancelling') genJobs.delete(key)
      persistGenJobs()
    }, keep).unref()
  }
}

/** 管线收尾：逐节出题（每内容节按档位目标题量，绑节 id）+ 综合题（通用随档位），汇总任务终态。 */
async function finishWithQuiz(ctx: Context, job: GenJob, contentMsg: string): Promise<string> {
  job.phase = 'quiz'
  job.message = `${contentMsg}；自动出题中…`
  persistGenJobs()
  try {
    const per = await engine.questionGenerateSections(job.course, job.node, async prompt => stripFences(await llmComplete(ctx, prompt)))
    const quiz = await generateQuiz(ctx, job.course, job.node, genericQuizTarget(tierIdxOf(job.tier)), { generic: true })
    const outcome = quizSuccessOutcome(contentMsg, per.added, quiz.added, quiz.total)
    job.status = outcome.status
    job.message = outcome.message
  } catch (quizErr) {
    const outcome = quizFailureOutcome(contentMsg, quizErr)
    job.status = outcome.status
    job.message = outcome.message
  }
  persistGenJobs()
  return job.message
}

/** 单节重写：节任务上下文 → 模型 → sectionApply（与管线共用同一拼装、门禁与修复回路）。 */
async function generateSection(ctx: Context, course: string, node: string, sectionId: string): Promise<string> {
  const pack = await engine.contentPack(course, node)
  const views = await engine.contentSectionsView(course, node)
  const s = views.find(v => v.id === sectionId)
  if (!s) throw new Error(`「${node}」没有节「${sectionId}」——先运行大纲。`)
  const sectionTpl = await engine.loadPrompt('课程节生成')
  const highTier = TIER_LABELS[await engine.contentTierOf(course, node)] === '高'
  const r = await applySectionWithRepair(ctx, course, node, s, sectionTpl, pack, { highTier })
  return `[section] 「${r.title}」v${r.version} 落盘。`
}

/** 项目里程碑计划生成（P 区 #92）：计划提示词包 → 模型 → 提案受理（人审后 apply 带快照生效）。 */
async function generateProjectPlan(ctx: Context, id: string): Promise<string> {
  const prompt = await engine.projectPlanPack(id)
  const yaml = stripFences(await llmComplete(ctx, prompt, undefined, { effort: llmCfg.fastEffort }))
  const prop = await engine.projectPlanPropose(id, yaml)
  return `[project-plan] 提案 #${prop.id} 已受理（${prop.initial ? '初次规划' : '计划修订'}：${prop.milestones} 个里程碑）——人审后 learnhub_project_apply 生效（apply 带旧计划快照）。`
}

/** 项目里程碑产物生成：任务卡提示词包 → 模型 → 轻量结构门（未过回灌修复一轮）
 * → 首生直落 / 已生成自动转重生成提案（带快照，不静默覆盖）。 */
async function generateProjectMilestone(ctx: Context, id: string, milestoneId: string): Promise<string> {
  const prompt = await engine.projectMilestonePack(id, milestoneId)
  const write = (md: string) => engine.projectMilestoneWrite(id, milestoneId, md)
  let md = stripFences(await llmComplete(ctx, prompt, undefined, { effort: llmCfg.fastEffort }))
  let out: Awaited<ReturnType<typeof write>>
  try {
    out = await write(md)
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    if (code !== 'MILESTONE_GATE_FAILED') throw err
    md = stripFences(await llmComplete(
      ctx,
      Content.sectionRepairPrompt(prompt, md, err instanceof Error ? err.message : String(err)),
      undefined, { effort: llmCfg.deepEffort },
    ))
    out = await write(md)
  }
  return 'written' in out
    ? `[project-milestone] 「${out.written}」已落盘（档位 ${out.tier}）。`
    : `[project-milestone] 「${out.file}」已生成过——按档重生成走提案 #${out.proposed}，人审后 learnhub_project_apply 生效（旧文带快照）。`
}

/** 整课重置 + 拓扑序串行重跑生成链（HTTP 与 agent 工具共用）：
 * contentReset 备份旧产物并重写 draft → 清掉该课程遗留任务（含排队）→ 按拓扑序逐节点入队全局队列。
 * 立即返回 { reset, queued }；进度由任务注册表展示。课程有 running 任务时拒绝。 */
async function resetCourseChain(ctx: Context, courseKey: string): Promise<{ reset: Awaited<ReturnType<LearnhubEngine['contentReset']>>; queued: number }> {
  const running = [...genJobs.values()].filter(j => j.course === courseKey && (j.status === 'running' || j.status === 'cancelling'))
  if (running.length) throw new Error(`课程「${courseKey}」有 ${running.length} 个生成任务进行中，先取消或等完成再重生成。`)
  const c = await engine.resolveCourse(courseKey)
  const { graph } = await engine.loadView(c)
  const reset = await engine.contentReset(c.name)
  for (const [key, j] of genJobs.entries()) if (j.course === c.name) genJobs.delete(key)
  persistGenJobs()
  // 整课重生成是显式意图：解除重启暂停，让链条立即开跑
  genQueuePaused = false
  let queued = 0
  for (const node of graph.order.length ? graph.order : graph.names) {
    enqueueGeneration(ctx, c.name, node)
    queued++
  }
  return { reset, queued }
}

/** 任务注册表视图（附各任务节点的内容版本：面板据此做增量刷新）+ 全局队列状态。 */
async function generationStatus(): Promise<{
  jobs: Array<GenJob & { key: string; contentVersion?: number }>
  queuePaused: boolean
  queuedCount: number
}> {
  const jobs: Array<GenJob & { key: string; contentVersion?: number }> = []
  for (const [key, j] of genJobs.entries()) {
    let contentVersion: number | undefined
    try {
      contentVersion = await engine.contentVersion(j.course, j.node)
    } catch {
      // 节点/课程缺失等：版本缺省，面板走全量刷新
    }
    jobs.push({ key, ...j, contentVersion })
  }
  return {
    jobs,
    queuePaused: genQueuePaused,
    queuedCount: jobs.filter(j => j.status === 'queued').length,
  }
}

function cancelGeneration(course: string, node: string): { cancelled: boolean; status?: string } {
  const job = genJobs.get(`${course}/${node}`)
  if (!job) return { cancelled: false }
  // 排队任务取消 = 直接移出队列（还没开跑，无需取消旗标）
  if (job.status === 'queued') {
    genJobs.delete(`${course}/${node}`)
    persistGenJobs()
    return { cancelled: true, status: 'queued' }
  }
  if (job.status === 'running') job.status = 'cancelling'
  return { cancelled: true, status: job.status }
}

/** 面板内轻量答疑：节点上下文 system + 前端携带的对话历史（拼成单条 user 消息）→ llm。
 * 与 dsh 会话分层：这里只答不写，深度讨论/修订走「与 AI 讨论本课」开的会话。 */
async function tutorChat(ctx: Context, course: string, node: string, history: unknown[]): Promise<string> {
  const pack = await engine.discussionPack(course, node)
  const turns = history
    .map(h => h as { role?: unknown; content?: unknown })
    .filter(h => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-12)
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    throw new Error('tutor 对话历史必须以学习者的提问结尾。')
  }
  const transcript = turns
    .map(h => `${h.role === 'assistant' ? '[AI 老师]' : '[学习者]'} ${h.content}`)
    .join('\n\n')
  const system = `你是 learnhub 的 AI 老师，正在辅导学习者攻克一个课程节点。只依据下面的课程上下文与本课范围回答；超出范围的追问给一句概括并建议回到课程主线。回答用 Markdown，简洁直接，公式用 KaTeX（$...$）。\n\n若页面上有交互模拟件且演示能帮助理解，可在回答末尾附一个 learnhub-teacher 动作块（普通回答不要输出）：\n\`\`\`learnhub-teacher\n{ "action": "highlight|setState|reveal|annotate", "selector": "#元素CSS选择器", "state": {"变量名": 值}, "text": "批注文字" }\n\`\`\`\n面板会把块转成「在交互件上演示」按钮并广播给本页全部交互件；highlight/reveal 需 selector，annotate 需 text，setState 需 state（变量名与交互件滑杆一致）。\n\n${pack}`
  return llmComplete(ctx, `${transcript}\n\n（请回答上面最后一条学习者的提问。）`, system)
}

/** E2「讲给我听」（#68）：初学者人设讲解会话——explainBackPack（要点+图位置+人设
 * 指令）做 system，前端携带多轮对话历史（学习者的讲稿/回答 + AI 追问）。与 /tutor
 * 同层：只对话不落盘，判词存档只在显式的 /explain-feedback 收尾回合发生。 */
async function explainBackTurn(ctx: Context, course: string, node: string, history: unknown[]): Promise<string> {
  const system = await engine.explainBackPack(course, node)
  const turns = history
    .map(h => h as { role?: unknown; content?: unknown })
    .filter(h => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-16)
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    throw new Error('讲解对话历史必须以学习者的讲稿/回答结尾。')
  }
  const transcript = turns
    .map(h => `${h.role === 'assistant' ? '[初学者]' : '[学习者]'} ${h.content}`)
    .join('\n\n')
  return llmComplete(ctx, `${transcript}\n\n（继续按你的角色追问或收尾。）`, system)
}

/** 发送 JSON 响应（no-store：状态类接口禁止浏览器缓存，保证评分后即时刷新）。 */
function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 读取并解析 POST JSON 请求体。 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** 字符串参数取值；缺失即抛 400 语义错误。 */
function need(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`missing required field: ${key}`)
  return v.trim()
}

/** 交互件伺服时注入 vendored KaTeX 自动渲染（检测到公式定界符且未自带 katex 才注入；
 * 存量交互件免重生成即获得公式渲染）。定界符与正文一致：$…$/$$…$$。 */
function injectKatexIfMathed(html: string): string {
  if (!/\$\$|\\\(|\\\[/.test(html) || /katex/i.test(html)) return html
  const inject = [
    '<link rel="stylesheet" href="/learnhub/api/vendor/katex/katex.min.css">',
    '<script src="/learnhub/api/vendor/katex/katex.min.js"></script>',
    '<script src="/learnhub/api/vendor/katex/contrib/auto-render.min.js"></script>',
    '<script>document.addEventListener("DOMContentLoaded",function(){window.renderMathInElement(document.body,{delimiters:[{left:"$$",right:"$$",display:true},{left:"$",right:"$",display:false}],throwOnError:false})})</script>',
  ].join('\n')
  const head = html.toLowerCase().indexOf('</head>')
  return head === -1 ? html + inject : html.slice(0, head) + inject + '\n' + html.slice(head)
}

/** /learnhub/api/* 路由分发：客户端面板的全部后端入口（响应形状与 v2 一致）。 */
async function handleApi(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API.length)
  try {
    if (req.method === 'GET' && route === '/status') {
      sendJson(res, 200, await apiRun('api/status', () => engine.statusJson()))
      return
    }
    if (req.method === 'GET' && route === '/courses') {
      const list = (await engine.enabledCourses()).map(c => ({
        name: c.name, root: c.root, enabled: String(c.enabled !== false),
      }))
      sendJson(res, 200, list)
      return
    }
    if (req.method === 'GET' && route === '/lesson') {
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/lesson', () => engine.lesson(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/recommend') {
      const limit = Number(url.searchParams.get('limit') ?? '5')
      sendJson(res, 200, await apiRun('api/recommend', () => engine.recommend(Number.isFinite(limit) ? limit : 5)))
      return
    }
    if (req.method === 'GET' && route === '/queue') {
      sendJson(res, 200, await apiRun('api/queue', () => engine.queueItemsAll()))
      return
    }
    if (req.method === 'GET' && route === '/courses/tree') {
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/courses/tree', () => engine.coursesTree(course)))
      return
    }
    if (req.method === 'GET' && route === '/questions') {
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/questions', () => engine.questions(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/file') {
      // 伺服 vault 内媒体文件（课程插图）；路径必须是 vault 相对且白名单扩展名
      const p = url.searchParams.get('path')
      if (!p) throw new Error('missing required field: path')
      const rel = p.replace(/\\/g, '/').replace(/^\/+/, '')
      if (rel.includes('..')) throw new Error('path traversal rejected')
      const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
      const mime = FILE_MIME[ext]
      if (!mime) throw new Error(`unsupported file type: ${ext || '(none)'}`)
      let buf: Buffer
      try {
        buf = await readFile(`${VAULT}/${rel}`)
      } catch {
        sendJson(res, 404, { error: `file not found: ${rel}` })
        return
      }
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' })
      res.end(buf)
      return
    }
    if (req.method === 'GET' && route.startsWith('/vendor/')) {
      // vendored 库同源伺服（katex/three）；路径限制在 web/vendor 内，MIME 白名单复用面板资产表
      const rel = decodeURIComponent(route.slice('/vendor/'.length)).replace(/\\/g, '/')
      if (!rel || rel.includes('..')) throw new Error('path traversal rejected')
      const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
      const mime = ASSET_MIME[ext]
      if (!mime) throw new Error(`unsupported vendor file type: ${ext || '(none)'}`)
      const file = resolvePath(VENDOR_DIST, rel)
      if (!(file + sep).startsWith(VENDOR_DIST)) throw new Error('path traversal rejected')
      let buf: Buffer
      try {
        buf = await readFile(file)
      } catch {
        sendJson(res, 404, { error: `vendor file not found: ${rel}` })
        return
      }
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=86400' })
      res.end(buf)
      return
    }
    if (req.method === 'GET' && route === '/interactive') {
      // 交互件伺服：限启用课程根内 .html；CSP 禁外联（connect-src 由 default-src 'none' 封死），
      // 放开 'self' 后可从 /vendor 取 vendored katex/three、经 /file 引 vault 图片
      const p = url.searchParams.get('path')
      if (!p) throw new Error('missing required field: path')
      const raw = p.replace(/\\/g, '/').replace(/^\/+/, '')
      if (raw.includes('..')) throw new Error('path traversal rejected')
      // 引用块存「学习中心相对路径」（<课程根>/交互/x.html），兼容 vault 相对（学习中心/…）——归一后再校验
      const rel = raw.startsWith(`${CENTER_REL}/`) ? raw : `${CENTER_REL}/${raw}`
      const courseRoot = rel.slice(CENTER_REL.length + 1).split('/')[0]
      if (!(await engine.enabledCourses()).some(c => c.root === courseRoot)) {
        throw new Error(`interactive 不在任何启用课程的根内: ${courseRoot}`)
      }
      if (!rel.toLowerCase().endsWith('.html')) throw new Error('interactive 只允许 .html')
      let buf: Buffer
      try {
        buf = await readFile(`${VAULT}/${rel}`)
      } catch {
        sendJson(res, 404, { error: `file not found: ${rel}` })
        return
      }
      // CSP 放开 'self'：交互件可从 /vendor 取库、经 /file 引图；connect-src 仍封死，外联面不变
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src data: blob: 'self'; font-src data: 'self'",
        'cache-control': 'no-store',
      })
      res.end(injectKatexIfMathed(buf.toString('utf8')))
      return
    }
    if (req.method === 'GET' && route === '/note') {
      const path = url.searchParams.get('path')
      if (!path) throw new Error('missing required field: path')
      sendJson(res, 200, await engine.resolveNote(VAULT, path, CENTER_REL))
      return
    }
    if (req.method === 'GET' && route === '/graph') {
      const course = url.searchParams.get('course') ?? undefined
      const elementsOnly = url.searchParams.get('elements') === '1'
      sendJson(res, 200, await apiRun('api/graph', () => engine.graphAnalyze(course, elementsOnly)))
      return
    }
    if (req.method === 'GET' && route === '/proposals') {
      sendJson(res, 200, await apiRun('api/proposals', () => engine.graphProposals()))
      return
    }
    if (req.method === 'GET' && route === '/doctor') {
      sendJson(res, 200, await apiRun('api/doctor', () => engine.doctor()))
      return
    }
    if (req.method === 'GET' && route === '/questions-all') {
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/questions-all', () => engine.questionsAll(course)))
      return
    }
    if (req.method === 'GET' && route === '/review-queue') {
      // 复习刷卡队列：跨课程到期题扁平队列，按预测遗忘风险 R 升序为主（r 字段随卡带出，#56）；
      // node 过滤 = 定向复习直达入口（A3 软闸/enc 回退建议项指向的目标节点，#54/#55），
      // 单节点会话按 Mastery 先验带自适应排序（band + 每卡 d，#57 A1）；
      // band 查询参数 = 显式难度带偏好（#65 E5：easy/hard 偏移目标带，standard/缺省 = 纯 A1）；
      // 卡片带 jol 标记（#66 E4）：抽查命中翻面前弹一档预测，可忽略
      const course = url.searchParams.get('course') ?? undefined
      const node = url.searchParams.get('node') ?? undefined
      sendJson(res, 200, await apiRun('api/review-queue', () =>
        engine.reviewQueue(course, node, undefined, bandPref(url.searchParams.get('band')))))
      return
    }
    if (req.method === 'GET' && route === '/xp') {
      sendJson(res, 200, await apiRun('api/xp', () => engine.xpStatus()))
      return
    }
    if (req.method === 'GET' && route === '/memory') {
      // 记忆健康仪表盘（#61）：负载预报/状态分布/真实保留率/遗忘曲线四面板聚合
      // （jol 字段 = 预测-校准曲线 #66 E4，配对数足门槛才有值）
      sendJson(res, 200, await apiRun('api/memory', () => engine.memoryHealth()))
      return
    }
    if (req.method === 'GET' && route === '/jol') {
      // JOL 抽查配置（#66 E4）：默认开、约 1/3；全局开关关闭后复习流完全不弹预测
      sendJson(res, 200, await apiRun('api/jol', () => engine.jolConfig()))
      return
    }
    if (req.method === 'GET' && route === '/coach') {
      // 可用的困难教练（#65 E5）：只读信息性反馈，无触发为空数组
      sendJson(res, 200, await apiRun('api/coach', () => engine.coachAdvice()))
      return
    }
    if (req.method === 'GET' && route === '/generate/status') {
      sendJson(res, 200, await apiRun('api/generate/status', () => generationStatus()))
      return
    }
    if (req.method === 'GET' && route === '/prompts') {
      sendJson(res, 200, await apiRun('api/prompts', () => engine.promptKinds()))
      return
    }
    if (req.method === 'GET' && route === '/discuss-pack') {
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/discuss-pack', () => engine.discussionPack(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/explain-pack') {
      // 错误当下「讲解这道题」逐题包（Arc D #64）：客户端桥注入宿主会话的首条消息原料
      const node = url.searchParams.get('node')
      const qid = url.searchParams.get('qid')
      if (!node || !qid) throw new Error('missing required field: node/qid')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/explain-pack', () => engine.errorExplainPack(course, node, qid)))
      return
    }
    if (req.method === 'GET' && route === '/explain-back-pack') {
      // E2「讲给我听」会话包（#68）：初学者人设指令 + 正文要点 + 图位置（面板会话 system）
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/explain-back-pack', () => engine.explainBackPack(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/note-sources') {
      // 笔记源清单（C1 #59）：注册身份 × Missing/漂移状态 × 卡池概况
      sendJson(res, 200, await apiRun('api/note-sources', () => engine.noteSourceList()))
      return
    }
    if (req.method === 'GET' && route === '/anki/status') {
      // Anki 通道状态（C2 #63，#72 UI 挂接）：镜象/最近推送与回写/当前到期分布
      // + AnkiConnect 可达性（连接失败不抛，status.anki.connected=false 带原因）
      sendJson(res, 200, await apiRun('api/anki/status', () =>
        engine.ankiStatus(new AnkiConnectClient(ANKI_ENDPOINT))))
      return
    }
    if (req.method === 'GET' && route === '/difficulty-advice') {
      // B2 难度失衡/过于简单只读建议（#58，#72 UI 挂接）：题目管理页建议区消费
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/difficulty-advice', () => engine.difficultyAdvice(course)))
      return
    }
    if (req.method === 'GET' && route === '/learner-queue') {
      // 「我的卡」E 池队列（E1/#68）：到期在前、新卡随后，隔离自调度
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/learner-queue', () => engine.learnerQueue(course)))
      return
    }
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (route === '/rebuild') {
        sendJson(res, 200, { message: (await engine.rebuild()).message })
        return
      }
      if (route === '/node/skip') {
        sendJson(res, 200, await apiRun('api/node/skip', () =>
          engine.nodeSkip(need(body, 'course'), need(body, 'node'), requireSkipDirection(body.skipped))))
        return
      }
      if (route === '/node/pin') {
        // 「今天学它」pin（E3 #67）：显式方向——pinned=true 置顶当日推荐榜首（只改
        // 排序、保留就绪提示、次日自动失效），false 取消。
        if (typeof body.pinned !== 'boolean') throw new Error('missing required field: pinned')
        sendJson(res, 200, await apiRun('api/node/pin', () =>
          body.pinned
            ? engine.pinToday(need(body, 'course'), need(body, 'node'))
            : engine.unpinToday(need(body, 'course'), need(body, 'node'))))
        return
      }
      if (route === '/node/complete') {
        sendJson(res, 200, await apiRun('api/node/complete', () =>
          engine.nodeComplete(need(body, 'course'), need(body, 'node'), body.force === true)))
        return
      }
      if (route === '/feedback') {
        sendJson(res, 200, { message: await engine.submitFeedback(VAULT, CENTER_REL, need(body, 'path')) })
        return
      }
      if (route === '/proposals/apply') {
        // 提案统一 apply（图谱域 gen/edit + 项目域 project_plan/project_milestone）：
        // kind 必须显式照抄提案记录，未知 kind 引擎报错——不再静默归一成 gen
        sendJson(res, 200, await engine.proposalApply(need(body, 'kind'), applyId(body.id)))
        return
      }
      if (route === '/proposals/reject') {
        const id = rejectId(body.id)
        await engine.graphReject(id, typeof body.note === 'string' ? body.note.trim() : '')
        sendJson(res, 200, { message: `[reject] 提案 #${id} 已拒绝留痕。` })
        return
      }
      if (route === '/generate') {
        // 入队即返回：全局串行队列后台按序执行（大纲 → 逐节正文 → 自动出题，数分钟/节点）
        const style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : undefined
        sendJson(res, 200, await apiRun('api/generate', async () =>
          enqueueGeneration(ctx, need(body, 'course'), need(body, 'node'), style)))
        return
      }
      if (route === '/generate/resume') {
        // 恢复重启后暂停的队列（遗留排队任务不自动开跑，防静默烧 token）
        sendJson(res, 200, await apiRun('api/generate/resume', async () => {
          const resumed = [...genJobs.values()].filter(j => j.status === 'queued').length
          genQueuePaused = false
          pumpGeneration(ctx)
          return { paused: false, resumed }
        }))
        return
      }
      if (route === '/generate/section') {
        // 单节重写：指定节 id 重新生成并过门（LessonView 节重写入口）
        sendJson(res, 200, await apiRun('api/generate/section', async () => ({
          message: await generateSection(ctx, need(body, 'course'), need(body, 'node'), need(body, 'section')),
        })))
        return
      }
      if (route === '/course/reset') {
        // 整课重新生成：重置（旧内容备份进 .trash）→ 按拓扑序串行重跑生成管线。
        // 重生成链后台执行，HTTP 立即返回；进度由任务注册表展示（面板 5s 轮询）。
        sendJson(res, 200, await apiRun('api/course/reset', async () =>
          resetCourseChain(ctx, need(body, 'course'))))
        return
      }
      if (route === '/interactive/settle') {
        // 交互件成绩结算（LEARNHUB_COMPLETE 上报；同节同日一次，防刷）
        const score = Number(body.score)
        sendJson(res, 200, await apiRun('api/interactive/settle', () => engine.interactiveSettle(
          need(body, 'course'), need(body, 'node'), need(body, 'section'),
          Number.isFinite(score) ? score : 0,
          typeof body.detail === 'string' ? body.detail : undefined)))
        return
      }
      if (route === '/tutor') {
        // 面板内轻量答疑：前端持有对话历史全量携带（最后一条必须是学习者提问）
        const history = Array.isArray(body.messages) ? body.messages : []
        sendJson(res, 200, await apiRun('api/tutor', async () => ({
          answer: await tutorChat(ctx, need(body, 'course'), need(body, 'node'), history),
        })))
        return
      }
      if (route === '/explain-back') {
        // E2「讲给我听」（#68）：初学者人设追问会话——包做 system，前端全量携带对话历史
        const history = Array.isArray(body.messages) ? body.messages : []
        sendJson(res, 200, await apiRun('api/explain-back', async () => ({
          answer: await explainBackTurn(ctx, need(body, 'course'), need(body, 'node'), history),
        })))
        return
      }
      if (route === '/explain-feedback') {
        // E2 定位反馈回合（#68）：对照要点给是非+定位+怎么补；判词只入 E 档案
        sendJson(res, 200, await apiRun('api/explain-feedback', () => engine.explainBackFeedback(
          need(body, 'course'), need(body, 'node'),
          typeof body.transcript === 'string' ? body.transcript : '',
          (prompt, system) => llmComplete(ctx, prompt, system))))
        return
      }
      if (route === '/explain-archive') {
        // E2 存档（#68）：把这版讲稿存成 E1 自注卡（再讲一遍/挖空重述两档）
        sendJson(res, 200, await apiRun('api/explain-archive', () => engine.explainArchiveCard(
          need(body, 'course'), need(body, 'node'), {
            content: typeof body.content === 'string' ? body.content : '',
            ...(typeof body.kind === 'string' ? { kind: body.kind as 'recall_cue' | 'cloze_rewrite' } : {}),
            ...(typeof body.prompt === 'string' && body.prompt.trim() ? { prompt: body.prompt } : {}),
            ...(typeof body.section === 'string' && body.section.trim() ? { section: body.section } : {}),
          })))
        return
      }
      if (route === '/note-source/register') {
        // C1 笔记源注册（#59）：单篇 .md 或文件夹（批量登记其下全部 .md）；用户笔记零写入
        sendJson(res, 200, await apiRun('api/note-source/register', () =>
          engine.noteSourceRegister(need(body, 'path'))))
        return
      }
      if (route === '/note-source/unregister') {
        sendJson(res, 200, await apiRun('api/note-source/unregister', () =>
          engine.noteSourceUnregister(need(body, 'id'))))
        return
      }
      if (route === '/note-source/generate') {
        // 笔记源出题（#59）：读笔记正文 → 笔记出题 prompt → validateBank 门禁落镜像
        sendJson(res, 200, await apiRun('api/note-source/generate', () => engine.noteSourceGenerate(
          need(body, 'id'), questionCount(body.count),
          async prompt => stripFences(await llmComplete(ctx, prompt)))))
        return
      }
      if (route === '/anki/export') {
        // 导出到 Anki（C2 #63，#72 UI 挂接）：与 learnhub_anki_export 同一引擎通道
        // ——按 vault 到期集校准/重建镜象卡组（Anki 未开时 fail loud 带指引）
        sendJson(res, 200, await apiRun('api/anki/export', () =>
          engine.ankiExportPush(new AnkiConnectClient(ANKI_ENDPOINT))))
        return
      }
      if (route === '/anki/import') {
        // Anki 作答回写（C2 #63，#72 UI 挂接）：拉上次导入水位以来的复习事件，
        // 按 vault 自己的 ts-fsrs 重算调度（Anki 侧排期输出不作数）
        sendJson(res, 200, await apiRun('api/anki/import', () =>
          engine.ankiImportEvents(new AnkiConnectClient(ANKI_ENDPOINT))))
        return
      }
      if (route === '/optimize-params') {
        // FSRS 参数优化器手动触发（A2 #62，#72 UI 挂接）：门禁不满足/评估未更优
        // 时不写回，status=skipped + 原因随响应带出（统计页面板展示）
        sendJson(res, 200, await apiRun('api/optimize-params', () => engine.optimizeFsrsParams()))
        return
      }
      if (route === '/learner-rate') {
        // 「我的卡」自评结算（E1/#68）：一卡一天一次推进，隔离自调度
        sendJson(res, 200, await apiRun('api/learner-rate', () => engine.learnerCardRate(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), Number(body.rating))))
        return
      }
      if (route === '/learner-forget') {
        sendJson(res, 200, await apiRun('api/learner-forget', () => engine.learnerCardForget(
          need(body, 'course'), need(body, 'node'), need(body, 'card'))))
        return
      }
      if (route === '/learner-add') {
        // E1「加我的理解」（#70）：写注当下 AI 对照该节要点给是非+定位反馈；判词入 E 档案
        sendJson(res, 200, await apiRun('api/learner-add', () => engine.learnerNoteAdd(
          need(body, 'course'), need(body, 'node'), {
            content: typeof body.content === 'string' ? body.content : '',
            ...(typeof body.kind === 'string' && body.kind.trim() ? { kind: body.kind as never } : {}),
            ...(typeof body.prompt === 'string' && body.prompt.trim() ? { prompt: body.prompt } : {}),
            ...(typeof body.section === 'string' && body.section.trim() ? { section: body.section } : {}),
          }, (prompt, system) => llmComplete(ctx, prompt, system, { effort: llmCfg.fastEffort }))))
        return
      }
      if (route === '/learner-archive') {
        if (typeof body.archived !== 'boolean') throw new Error('missing required field: archived')
        sendJson(res, 200, await apiRun('api/learner-archive', () => engine.learnerCardArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), body.archived)))
        return
      }
      if (route === '/question-generate') {
        sendJson(res, 200, await apiRun('api/question-generate', () =>
          generateQuiz(ctx, need(body, 'course'), need(body, 'node'), questionCount(body.count))))
        return
      }
      if (route === '/review') {
        sendJson(res, 200, { message: await engine.contentReview(need(body, 'course'), need(body, 'node')) })
        return
      }
      if (route === '/question-save') {
        sendJson(res, 200, await engine.questionSave(need(body, 'course'), need(body, 'node'), need(body, 'yaml')))
        return
      }
      if (route === '/question-answer') {
        sendJson(res, 200, await apiRun('api/question-answer', () => engine.questionAnswer(
          prompt => llmComplete(ctx, prompt),
          need(body, 'course'), need(body, 'node'), need(body, 'qid'),
          typeof body.answer === 'string' ? body.answer : '',
          typeof body.elapsed_s === 'number' && Number.isFinite(body.elapsed_s) ? body.elapsed_s : null,
          {
            ...(body.defer_schedule === true ? { deferSchedule: true } : {}),
            // 翻面前的 JOL 预测（#66 E4）：缺省/非法由引擎显式契约拒绝
            ...(typeof body.predicted === 'string' ? { predicted: body.predicted as never } : {}),
          })))
        return
      }
      if (route === '/question-rate') {
        // 复习刷卡流：答对后的自评难度结算（2/3/4 → FSRS Hard/Good/Easy）
        sendJson(res, 200, await apiRun('api/question-rate', () => engine.questionRate(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'), Number(body.rating))))
        return
      }
      if (route === '/question-forget') {
        // 复习刷卡流：「忘记」申报（不作答翻面，按答错记证据、0 XP）
        sendJson(res, 200, await apiRun('api/question-forget', () => engine.questionForget(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'),
          typeof body.elapsed_s === 'number' && Number.isFinite(body.elapsed_s) ? body.elapsed_s : null,
          typeof body.predicted === 'string' ? body.predicted as never : null)))
        return
      }
      if (route === '/band-session') {
        // 难度带会话日志（E5 #65）：会话结束反馈点落一条带选择与作答结算（教练数据源）
        sendJson(res, 200, await apiRun('api/band-session', () => engine.logBandSession({
          course: need(body, 'course'), node: need(body, 'node'),
          band: typeof body.band === 'string' ? body.band as never : 'standard',
          answered: Number(body.answered ?? 0), correct: Number(body.correct ?? 0),
        })))
        return
      }
      if (route === '/question-add') {
        const q = body.question
        if (typeof q !== 'object' || q === null) throw new Error('missing required field: question')
        sendJson(res, 200, await engine.questionAdd(
          need(body, 'course'), need(body, 'node'), q as Record<string, unknown>))
        return
      }
      if (route === '/question-archive') {
        sendJson(res, 200, await engine.questionArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'),
          body.archived === true))
        return
      }
      if (route === '/course/delete') {
        sendJson(res, 200, await engine.courseDelete(need(body, 'course')))
        return
      }
      if (route === '/generate/cancel') {
        sendJson(res, 200, cancelGeneration(need(body, 'course'), need(body, 'node')))
        return
      }
      if (route === '/project/create') {
        // 项目创建（P 区 #92）：Project 是 Course 姊妹实体，零调度零 XP
        sendJson(res, 200, await apiRun('api/project/create', () => engine.projectCreate({
          name: need(body, 'name'),
          goal: need(body, 'goal'),
          ...(typeof body.tier === 'string' && body.tier.trim() ? { tier: body.tier.trim() as never } : {}),
        })))
        return
      }
      if (route === '/project/lifecycle') {
        sendJson(res, 200, await apiRun('api/project/lifecycle', () =>
          engine.projectSetLifecycle(need(body, 'id'), need(body, 'lifecycle'))))
        return
      }
      if (route === '/project/tier') {
        sendJson(res, 200, await apiRun('api/project/tier', () =>
          engine.projectSetTier(need(body, 'id'), need(body, 'tier'))))
        return
      }
      if (route === '/project/plan/generate') {
        sendJson(res, 200, await apiRun('api/project/plan/generate', async () => ({
          message: await generateProjectPlan(ctx, need(body, 'id')),
        })))
        return
      }
      if (route === '/project/milestone/generate') {
        sendJson(res, 200, await apiRun('api/project/milestone/generate', async () => ({
          message: await generateProjectMilestone(ctx, need(body, 'id'), need(body, 'milestone')),
        })))
        return
      }
    }
    if (req.method === 'PUT') {
      const body = await readJson(req)
      if (route === '/daily-goal') {
        const goal = Number(body.goal)
        if (!Number.isFinite(goal)) throw new Error('missing required field: goal')
        sendJson(res, 200, await apiRun('api/daily-goal', () => engine.setDailyGoal(goal)))
        return
      }
      if (route === '/day-cutoff') {
        // 日界（ADR-0020）：学习日切换的本地时刻 'HH:mm'（非法值引擎 fail loud）
        if (typeof body.value !== 'string') throw new Error('missing required field: value')
        sendJson(res, 200, await apiRun('api/day-cutoff', () => engine.setDayCutoff(body.value)))
        return
      }
      if (route === '/jol') {
        // JOL 抽查配置（#66 E4）：enabled 全局开关 + rate 抽样率（0<r≤1）
        sendJson(res, 200, await apiRun('api/jol', () => engine.setJolConfig({
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(typeof body.rate === 'number' && Number.isFinite(body.rate) ? { rate: body.rate } : {}),
        })))
        return
      }
      if (route === '/question-update') {
        const patch = typeof body.patch === 'object' && body.patch !== null
          ? body.patch as Record<string, unknown> : {}
        sendJson(res, 200, await engine.questionUpdate(need(body, 'course'), need(body, 'node'), need(body, 'qid'), patch))
        return
      }
    }
    sendJson(res, 404, { error: `unknown route: ${req.method} ${route}` })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

export function apply(ctx: Context, config?: LearnhubConfig) {
  // —— 部署路径（机器级 config，缺失/不存在直接失败，不做静默兜底）——
  const vault = typeof config?.vault === 'string' ? config.vault.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (!vault) {
    throw new Error(
      '[learnhub] config.vault 缺失：在该机器的 profile patch（~/.dsh/profiles/web/cordis.patch.yml）'
      + '为 id: learnhub 行配置 vault（vault 根目录绝对路径）。')
  }
  if (!existsSync(vault)) throw new Error(`[learnhub] config.vault 目录不存在：${vault}`)
  CENTER_REL = (config?.centerRel ?? '学习中心').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const center = `${vault}/${CENTER_REL}`
  if (!existsSync(center)) throw new Error(`[learnhub] 学习中心目录不存在：${center}`)
  VAULT = vault
  engine = new LearnhubEngine({ vault, centerRel: CENTER_REL })

  // 生成任务注册表恢复：running/cancelling 随进程消失标失败；queued 保留但队列置为
  // 暂停（不自动开跑——重启后静默烧 token 是惊吓，生成页一键恢复）
  void engine.loadGenJobs().then(stale => {
    let restoredQueued = 0
    for (const raw of stale) {
      const j = raw as Partial<GenJob>
      if (typeof j.course !== 'string' || typeof j.node !== 'string') continue
      const key = `${j.course}/${j.node}`
      const interrupted = j.status === 'running' || j.status === 'cancelling'
      if (j.status === 'queued') restoredQueued++
      genJobs.set(key, {
        course: j.course, node: j.node,
        startedAt: typeof j.startedAt === 'string' ? j.startedAt : new Date().toISOString(),
        status: interrupted ? 'failed' : (j.status ?? 'failed'),
        ...(j.phase ? { phase: j.phase } : {}),
        ...(j.progress ? { progress: j.progress } : {}),
        ...(j.style ? { style: j.style } : {}),
        message: interrupted ? '进程重启，任务中断——可重试' : (typeof j.message === 'string' ? j.message : undefined),
      })
    }
    if (restoredQueued > 0) genQueuePaused = true
    persistGenJobs()
    if (stale.length) {
      console.log(`[learnhub] gen-jobs restored: ${stale.length} (interrupted marked failed${restoredQueued ? `, ${restoredQueued} queued paused` : ''})`)
    }
  })

  // provider/model/快速档来自行 config（缺省用当前默认模型与 off 快速档）
  if (config?.provider) llmCfg.provider = config.provider
  if (config?.model) llmCfg.model = config.model
  if (config?.fastEffort) llmCfg.fastEffort = config.fastEffort
  if (config?.deepEffort) llmCfg.deepEffort = config.deepEffort

  // —— agent 工具面 ——
  const textOutput = {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
  }
  const tool = (name: string, description: string, parameters: Record<string, unknown>, fn: (args: never) => Promise<string>) =>
    ctx.tools.register(defineTool({
      name, description, parameters,
      output: textOutput,
      execute: fn as never,
    }) as never)

  tool('learnhub_status',
    'Return the learning center status (center summary + per-course detail) as JSON. blocked entries are executable soft-gate advice: a candidate blocked only by a decayed prerequisite carries {pre, r, due, entry} — review the prerequisite\'s due questions first (direct entry) or still learn the candidate directly. Courses may also carry diagnostics (B1 content-diagnostic suggestions): a section with concentrated wrong answers (R1 single-question lapses or R2 section accuracy <0.5 over ≥4 deduped answers) with reason, evidence, and a rewrite direct action — surface it to the learner and rewrite via learnhub_section_rewrite ONLY after they confirm (advice-first, never automatic). Evaluating diagnostics appends a trigger record to the journal when a signal fires fresh (that ledger drives the 7-day cooldown and R1 escalation); nothing else is written.',
    {}, () => run('learnhub_status', async () => JSON.stringify(await engine.statusJson())))
  tool('learnhub_data_check',
    'Run a read-only Data Check across the registry, graph YAML, course notes/frontmatter, and question banks. Return JSON findings that distinguish Missing (legal absence) from Broken (present but invalid); it never repairs or writes vault data.',
    {}, () => run('learnhub_data_check', async () => JSON.stringify(await engine.dataCheck())))
  tool('learnhub_skip',
    'Mark a node as skipped (learner already knows it) or un-skip. Skipped nodes count as passed: they leave the recommendation queue and no longer block successors.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      skipped: { type: 'boolean', required: true, description: 'Explicit direction: true to skip, false to un-skip (omission is an argument error)' },
    },
    (args: { course: string; node: string; skipped?: boolean }) => run('learnhub_skip', async () =>
      JSON.stringify(await engine.nodeSkip(args.course, args.node, requireSkipDirection(args.skipped)))))
  tool('learnhub_complete',
    'Confirm a node has been learned this round. Accuracy below the passing line (0.6, with enough attempts) is rejected with accepted=false — review prerequisites or retry with force. On acceptance: unanswered bank questions get their FSRS card initialized (due tomorrow), the node stage moves to review, and a perfect-score completion earns bonus XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      force: { type: 'boolean', description: 'true to bypass the accuracy gate' },
    },
    (args: { course: string; node: string; force?: boolean }) => run('learnhub_complete', async () =>
      JSON.stringify(await engine.nodeComplete(args.course, args.node, args.force === true))))
  tool('learnhub_lesson',
    "Fetch one node's lesson pack as JSON: course body split into teaching sections (练习/反馈 excluded, 答案 merged into 例题), prereqs, and suggested next nodes. Use this to teach a node step by step.",
    {
      node: { type: 'string', required: true, description: 'Node name' },
      course: { type: 'string', required: true, description: 'Course name' },
    },
    (args: { node: string; course: string }) => run('learnhub_lesson', async () => JSON.stringify(await engine.lesson(args.course, args.node))))
  tool('learnhub_recommend',
    'Get the dynamic cross-course recommendation queue as JSON: next events (review/learning/new/struggle/diagnostic/pin) ranked by priority (overdue reviews first by days overdue and retention decay, then half-finished lessons, then new lessons by unlock count and region rotation). Each event has type/course/node/score/why. Events the learner pinned as「今天学它」carry pinned=true and lead their course for today only (tomorrow they fall back to the default order); a pinned node with no other event appears as a standalone pin event — a not-ready pinned node keeps its soft-gate hint but stays openable. Events may carry an `advice` array of executable review suggestions {node, r, due, w?}: soft-gate advice on new lessons when a prerequisite\'s retention decayed below the R gate (review that prereq\'s due questions first — you may still learn the lesson directly), and remedial advice when a node keeps struggling (review its weighted component-skill ancestors first, ranked by w×(1−R); silent when the node has no enc edges or too few recent answers). Execute an advice item with learnhub_review_queue on {course, node: advice[].node}, then learnhub_question_answer. Events may also carry a `diagnostics` array (B1 content diagnostics, standalone events typed diagnostic): a section whose content keeps failing the learner (R1 single-question repeated lapses, or R2 answer accuracy <0.5 over ≥4 deduped answers since the section was last rewritten) with reason, evidence, and a rewrite direct action {course, node, section} — after the learner confirms, execute it with learnhub_section_rewrite (gated single-section rewrite; the question bank is untouched); the Arc D per-question explain entry lives in the panel\'s error state. Fetch the next batch after finishing one.',
    { limit: { type: 'number', description: 'Max events to return (default 5)' } },
    (args: { limit?: number }) => run('learnhub_recommend', async () =>
      JSON.stringify(await engine.recommend(args.limit === undefined ? 5 : args.limit))))
  tool('learnhub_pin_today',
    'Pin a node as「今天学它」(E3 goal ownership): for TODAY only it is raised to the top of its course in learnhub_recommend with a「你选了它」marker and its normal reason — a read-side ordering overlay, never a gate; pinning a not-ready node keeps the prerequisite soft-gate hint and the node stays openable. Pins expire automatically tomorrow. Learner Output: zero effect on scheduling, mastery, or XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must exist in the course graph)' },
    },
    (args: { course: string; node: string }) => run('learnhub_pin_today', async () =>
      JSON.stringify(await engine.pinToday(args.course, args.node))))
  tool('learnhub_unpin',
    'Cancel a「今天学它」pin: the node returns to the default recommendation order immediately.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run('learnhub_unpin', async () =>
      JSON.stringify(await engine.unpinToday(args.course, args.node))))
  tool('learnhub_review_queue',
    'List the cross-course due review cards as JSON (Anki-style; answers omitted — answer with learnhub_question_answer, self-rate Hard/Good/Easy after correct replies). Omit filters for the whole queue: cards sort by predicted recall risk R ascending (r carried per card). Note-source cards (C1) ride the same queue with source:"note" and course=笔记源 (node = source id) — answer/rate/forget them through the SAME learnhub_question_answer / learnhub_question_rate / learnhub_question_forget calls; note_drifted (content changed — offer regenerate/archival) and note_suspended (missing source or broken mirror) summaries ride the response; suspended cards never block course cards. Pass course and/or node for TARGETED review — the direct entry that recommendation/status advice items point to (A3 soft-gate prerequisite review and enc component-skill remediation): {course, node} returns exactly that node\'s due questions. A single-node session is ADAPTIVELY ordered (A1 difficulty tuning): cards carry a combined difficulty scalar d and the response carries the node-mastery start band — present cards nearest that band first; during the session shift the band up one step after every second consecutive correct answer and drop it back toward the base after a wrong/forgot, re-picking the nearest-d remaining card each time. band_pref (E5) is the learner\'s explicit difficulty choice as a weighted preference on that start band: hard raises it, easy relaxes it, omit for pure A1 — the anti-frustration drop-back still applies. Cards flagged jol=true are the sampled JOL probe (E4): before revealing the answer you may ask the learner for a one-tap prediction (会/不会/没把握) and pass it back as the predicted field on learnhub_question_answer / learnhub_question_forget — skippable, never blocking. Unknown node names fail loud.',
    {
      course: { type: 'string', description: 'Course name; omit for all enabled courses' },
      node: { type: 'string', description: 'Node name filter — targeted review of this node\'s due questions (A3 advice direct entry; adaptive difficulty order)' },
      band_pref: { type: 'string', description: 'Learner\'s explicit difficulty band (E5): easy/standard/hard as a weighted preference on the A1 start band' },
    },
    (args: { course?: string; node?: string; band_pref?: string }) => run('learnhub_review_queue', async () =>
      JSON.stringify(await engine.reviewQueue(args.course, args.node, undefined, bandPref(args.band_pref)))))
  tool('learnhub_coach',
    'Get the「可用的困难」coach feedback (E5, read-only informational, no gates or scoring): checks the last 7 days of the learner\'s difficulty-band session choices and in-band performance. All-easy streak with due questions their FSRS state says they should know → a gentle nudge to try the standard band; consistent challenge-band struggle (accuracy below 0.6) → a pointer back to prerequisite/component-skill review. Low data stays silent. Surface messages verbatim when present; never force anything.',
    {},
    () => run('learnhub_coach', async () => JSON.stringify(await engine.coachAdvice())))
  tool('learnhub_rebuild',
    'Run audit gate + ready-list regeneration for all enabled courses, or one course.',
    { course: { type: 'string', description: 'Course name; omit to rebuild all enabled courses' } },
    (args: { course?: string }) => run('learnhub_rebuild', async () =>
      (await engine.rebuild(args.course)).message))
  tool('learnhub_feedback',
    'Submit content feedback of a course note: reads the note「内容反馈」section and marks the node flagged + regeneration queue.',
    { path: { type: 'string', required: true, description: 'Note path, vault-relative or absolute' } },
    (args: { path: string }) => run('learnhub_feedback', () => engine.submitFeedback(VAULT, CENTER_REL, args.path)))
  tool('learnhub_note_resolve',
    'Resolve a course note: read its frontmatter node and map the path to its enabled course via 课程注册表.yaml.',
    { path: { type: 'string', required: true, description: 'Note path, vault-relative or absolute' } },
    (args: { path: string }) => run('learnhub_note_resolve', async () =>
      JSON.stringify(await engine.resolveNote(VAULT, args.path, CENTER_REL))))
  tool('learnhub_graph_analyze',
    'Analyze a course knowledge graph: structural stats, unreachable nodes, bottlenecks, lapse hotspots, graph health score (0-100, see health), next-batch suggestions (suggestions.expand_blocks/missing_pre/unconverged, plus jump_candidates + jump_total — cognitive-jump edges needing a verdict each — and merge_blocks), the scale-floor report (scale; pass targetMin/targetMax declared in scope analysis), the full per-node schema (schema: pre/enc/est/bloom/difficulty/note per node — the data basis for edge-level self-checks), plus cytoscape render elements. Returns JSON. Run before planning each batch of graph edits; the next-batch plan must cite concrete entries from health/suggestions/scale.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      elementsOnly: { type: 'boolean', description: 'Only output cytoscape render elements (nodes/edges)' },
      targetMin: { type: 'number', description: 'Scale-floor target node count min (declared in scope analysis); provide together with targetMax, omit both when not declared' },
      targetMax: { type: 'number', description: 'Scale-floor target node count max (advisory upper bound, never blocking); provide together with targetMin' },
    },
    (args: { course?: string; elementsOnly?: boolean; targetMin?: number; targetMax?: number }) => run('learnhub_graph_analyze', async () => {
      if ((args.targetMin !== undefined) !== (args.targetMax !== undefined)) {
        throw new Error('[graph-analyze] targetMin 与 targetMax 必须成对提供（只给一个会被忽略）')
      }
      return JSON.stringify(await engine.graphAnalyze(
        args.course,
        args.elementsOnly,
        args.targetMin !== undefined && args.targetMax !== undefined ? { min: args.targetMin, max: args.targetMax } : null,
      ))
    }))
  tool('learnhub_graph_node',
    'Inspect one graph node in depth: schema field values (pre/est/type/bloom/difficulty/note), direct successors, enc component-skill edges with weights and notes, block placement, learning stage/content status, and the full transitive prerequisite closure (sorted deepest-first). Use to drill into a single node without pulling the whole graph.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course?: string; node: string }) => run('learnhub_graph_node', async () =>
      JSON.stringify(await engine.graphNode(args.course, args.node))))
  tool('learnhub_graph_browse',
    'Browse a course graph by region and/or block: node listings with depth/stage/est/difficulty/type/content status. Omit both filters to list every region (structure overview); give region (and optionally block) to explore one area. A block without a region succeeds only when exactly one block with that name exists; zero matches or ambiguity across regions fails with the matching region list so you can add the region filter. Unknown regions/blocks fail loud with valid names.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      region: { type: 'string', description: 'Region name filter' },
      block: { type: 'string', description: 'Block name filter (requires region when ambiguous)' },
    },
    (args: { course?: string; region?: string; block?: string }) => run('learnhub_graph_browse', async () =>
      JSON.stringify(await engine.graphBrowse(args.course, args.region, args.block))))
  tool('learnhub_graph_path',
    'Ask whether one node is a (transitive) prerequisite of another and via which chain: returns related, direct, the BFS shortest chain from→…→to, the full prerequisite-closure size of `to`, and the depth span. Use for teaching-path planning and for explaining why something is locked.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      from: { type: 'string', required: true, description: 'Candidate prerequisite node' },
      to: { type: 'string', required: true, description: 'Target node' },
    },
    (args: { course?: string; from: string; to: string }) => run('learnhub_graph_path', async () =>
      JSON.stringify(await engine.graphPath(args.course, args.from, args.to))))
  tool('learnhub_graph_propose',
    'Submit a graph proposal. Schema quick reference — write YAML strictly to this, wrong key names are rejected. kind=gen (skeleton, once) top-level keys: course; mode (REQUIRED; only "new" or "append" — new course vs append-to-existing); regions[] where each region entry is {region: 区名, color?, blocks: [{name: 块名, nodes: [...]}]} — the region-entry key is `region`, NOT name; each gen node is {name: 节点名, pre: [前置], opt?, note?, enc?, est? (minutes, positive), bloom? (记忆/理解/应用/分析/评价/创造), difficulty? (1-5)} — gen nodes use key `name`. kind=edit (per batch) top-level keys: course; reason?; ops[] — every op targets its node via key `node` (NOT name, opposite of gen nodes): add_node{node, region, block, pre, est? (minutes, positive), bloom? (记忆/理解/应用/分析/评价/创造), difficulty? (1-5), type?: practice, note?, enc?}; set_pre{node, pre} replaces the whole pre set (pre is required, [] to clear); set_enc{node, enc} replaces the whole enc list ([skill] or [{node, w, note}]; enc is required, [] to clear); del_node{node}; rename{node, new}; move{node, region, block}; set_note{node, note}. Batch `pre` may only reference existing nodes or nodes created earlier in the same batch. Keep pre-edge cognitive jumps (difficulty gap >= 2 or depth span >= 3) off the graph or expect R13 jump-candidate warnings. Schema + structure gates reject bad YAML with actionable errors (including dangling enc edges). In graph-generation batches apply immediately after gates pass (anchor-review model, ADR-0003); revision changes stay pending for human review.',
    {
      kind: { type: 'string', required: true, description: '"gen" (new/append course graph) or "edit" (change ops)' },
      yaml: { type: 'string', required: true, description: 'Full proposal YAML text (GenProposal or EditProposal schema)' },
    },
    (args: { kind: string; yaml: string }) => run('learnhub_graph_propose', async () =>
      JSON.stringify(await engine.graphPropose(args.kind === 'edit' ? 'edit' : 'gen', args.yaml))))
  tool('learnhub_graph_proposals',
    'List graph proposals (gen/edit) by status — use status=pending to see what awaits human review in the panel, with the proposal id, course, reason, and op summary. After the user decides in the panel, apply with learnhub_graph_apply using that id.',
    {
      status: { type: 'string', description: 'Filter by status (default pending; e.g. applied/rejected)' },
      kind: { type: 'string', description: 'Filter by kind: gen or edit' },
    },
    (args: { status?: string; kind?: string }) => run('learnhub_graph_proposals', async () =>
      JSON.stringify(await engine.graphProposals(args.status, args.kind))))
  tool('learnhub_graph_enc_backfill',
    'Backfill enc (component-skill) edges for a course from existing ready content (ADR-0008): every non-practice node whose note body / exercise metadata declares enc_candidates or uses inside its prereq closure that are not yet declared as enc becomes one set_enc whole-replace op, queued as a SINGLE pending edit proposal. Nothing changed returns ops=0. Re-runnable — already-covered nodes produce no ops; practice nodes keep legal empty enc. Use for the A3 pilot when enabling that course, then review/apply with learnhub_graph_apply(kind=edit).',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run('learnhub_graph_enc_backfill', async () =>
      JSON.stringify(await engine.graphEncBackfill(args.course))))
  tool('learnhub_graph_apply',
    'Decide a pending graph proposal: apply (audit-gated, writes data/*.yaml with rename linkage + journal + snapshot) or reject (kept on record). In graph-generation batches the agent applies directly after gates pass; revision changes wait for human review first (ADR-0003). The apply result carries findings: audit warns plus a health-score hint when below the skill exit threshold — address them in the next batch.',
    {
      kind: { type: 'string', required: true, description: '"gen" or "edit"' },
      id: { type: 'number', description: 'Proposal id as a positive integer; omit only for the latest pending of this kind' },
      reject: { type: 'boolean', description: 'true to reject instead of apply' },
      note: { type: 'string', description: 'Rejection reason (recorded)' },
    },
    async (args: { kind: string; id?: number; reject?: boolean; note?: string }) =>
      run('learnhub_graph_apply', async () => {
        if (args.reject) {
          const id = rejectId(args.id)
          await engine.graphReject(id, args.note ?? '')
          return `[reject] 提案 #${id} 已拒绝留痕。`
        }
        return JSON.stringify(await engine.graphApply(args.kind === 'edit' ? 'edit' : 'gen', applyId(args.id)))
      }))
  tool('learnhub_generate',
    'Queue one course note for generation via the global serial queue: outline first (the model decides section split, order, and types from the content, topic, and style — no fixed structure), then one model call per section through the quality gates as a draft (ready sections are skipped, so retrying resumes the pipeline), then per-section + synthesis quiz questions. Returns immediately with a queue position; at most one node pipeline runs at a time (check the gen-jobs registry tool or panel generate tab for progress). The context pack (prereqs, domain boundary, forbidden concepts) and user-editable prompt templates (state/提示词/课程大纲.md, 课程节生成.md) drive the calls. Missing notes are scaffolded first (on-demand lesson semantics). style selects a per-section prompt variant (课程节生成-<style>, e.g. 苏格拉底/费曼) applied to every section call; the outline and gates stay on the default path.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name to generate' },
      style: { type: 'string', description: 'Prompt style variant; omit for the default template' },
    },
    (args: { course: string; node: string; style?: string }) => run('learnhub_generate', () =>
      enqueueGeneration(ctx, args.course, args.node, args.style)))
  tool('learnhub_section_rewrite',
    'Rewrite ONE section of a node through the model — the same gated pipeline as the panel section-rewrite: section task context → model → quality gates → one repair round on gate failure → surgical reassembly of that section (section version +1, node content back to draft; the question bank, FSRS cards, and schedules are untouched). This is the direct action for B1 content-diagnostic suggestions (learnhub_recommend/status diagnostics: R1 single-question repeated failure, R2 section answer-accuracy collapse). Diagnostics are advisory — confirm with the learner before calling; never rewrite a section nobody asked about. Synchronous: a section typically takes tens of seconds.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      section: { type: 'string', required: true, description: 'Section id from the node manifest (e.g. "s2") — exactly what diagnostics[].rewrite.section carries' },
    },
    (args: { course: string; node: string; section: string }) => run('learnhub_section_rewrite', async () =>
      generateSection(ctx, args.course, args.node, args.section)))
  tool('learnhub_course_reset',
    'Reset one course for full regeneration: all node notes are backed up into .trash/regenerate-<ts>/ and rewritten as ungenerated skeletons; the question bank, interactive artifacts, and generated-image dirs move into the same backup. The graph, learning progress, and prompt snapshots are kept. Regeneration then runs as a background chain over all nodes in graph topological order (each node: outline → sections → quiz) and this call returns immediately with the queued count; progress shows in the panel generate tab. Refuses while generation tasks are running. Destructive but recoverable — confirm with the user before calling.',
    { course: { type: 'string', required: true, description: 'Course name' } },
    (args: { course: string }) => run('learnhub_course_reset', async () => {
      const r = await resetCourseChain(ctx, args.course)
      return JSON.stringify({ message: `已重置「${args.course}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成（后台链，进度看任务注册表）`, reset: r.reset, queued: r.queued })
    }))
  tool('learnhub_course_delete',
    'Delete one course: remove it from the course registry and move the whole course directory into 学习中心/.trash/ (recoverable by hand). Learning progress lives inside the course directory, so it goes too. Destructive — confirm with the user before calling; for a content-only redo prefer learnhub_course_reset (keeps the graph and progress).',
    { course: { type: 'string', required: true, description: 'Course name' } },
    (args: { course: string }) => run('learnhub_course_delete', async () =>
      JSON.stringify(await engine.courseDelete(args.course))))
  tool('learnhub_difficulty_advice',
    'Detect difficulty-mismatch advice across question banks (B2, read-only, advice-first — nothing is written): nodes in review/mastered with low derived mastery + struggling answer accuracy + enough answer volume get a "difficulty band miscalibrated, regenerate" suggestion carrying a difficulty/bloom target-band instruction (feed it to learnhub_question_generate or the section-rewrite flow, validateBank gate applies); individual questions answered 100% correctly enough times get a "too easy, archivable" annotation suggestion (archiving is the author/panel decision via learnhub_question_update archived patch — never silent removal). Low data stays silent.',
    { course: { type: 'string', description: 'Course name; omit to scan all enabled courses' } },
    (args: { course?: string }) => run('learnhub_difficulty_advice', async () =>
      JSON.stringify(await engine.difficultyAdvice(args.course))))
  tool('learnhub_optimize_params',
    'Manually trigger FSRS-6 personal parameter optimization (A2, never automatic — like Anki): retrains the 21 scheduling parameters from the learner\'s real review log (synthetic initializations excluded, first push per card per day) across all enabled courses. Gates: at least 400 real review pushes are required, and the trained parameters must evaluate strictly better than the current/default parameters (same-protocol logLoss comparison) — otherwise nothing is written and the skip reason is returned with the metrics. On success the one learner-level parameter set is written to every enabled course\'s fsrs参数.json with full training metadata (count/date/metrics); the scheduler picks it up with zero changes. Expect ~a few seconds of training.',
    {},
    () => run('learnhub_optimize_params', async () =>
      JSON.stringify(await engine.optimizeFsrsParams())))
  tool('learnhub_question_generate',
    'Generate quiz questions for a node via the model — the same pipeline as the auto-quiz: node body → question prompt → llm → validateBank gate appends every question to the bank. Use when a node has no/too few questions.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must have generated content)' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { course: string; node: string; count?: number }) => run('learnhub_question_generate', async () => {
      const n = questionCount(args.count)
      return JSON.stringify(await generateQuiz(ctx, args.course, args.node, n))
    }))
  tool('learnhub_question_update',
    'Update one bank question: patch merges into the stored question with a strict authoring whitelist (q/options/answer/explanation/difficulty/section/uses/tags/tol) and the whole bank re-validates before writing. Empty patches, unknown fields, and id/kind/node/fsrs/stats/archived keys are rejected. Archiving is a separate operation: send the patch {archived:true|false} as the only key to route to the archive endpoint; mixing archive with content edits fails instead of partially applying. learnhub_question_list omits answers — take corrections from the user or the note content, not from thin air.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
      patch: { type: 'object', additionalProperties: true, required: true, description: 'Authoring fields to merge ({"answer":"A",...}), or {"archived":true} alone for archive' },
    },
    (args: { course: string; node: string; qid: string; patch: Record<string, unknown> }) => run('learnhub_question_update', async () => {
      if ('archived' in args.patch) {
        const archived = args.patch.archived
        if (typeof archived !== 'boolean') {
          throw new Error('[question-update] archived 必须是布尔值（archive/restore 独立操作）')
        }
        if (Object.keys(args.patch).length !== 1) {
          throw new Error('[question-update] 归档与内容修订是两条独立操作，混合 patch 会被整体拒绝（先归档，或先改内容再单独归档）')
        }
        await engine.questionArchive(args.course, args.node, args.qid, args.patch.archived)
        return JSON.stringify({ course: args.course, node: args.node, qid: args.qid, archived: args.patch.archived })
      }
      return JSON.stringify(await engine.questionUpdate(args.course, args.node, args.qid, args.patch))
    }))
  tool('learnhub_question_get',
    'Read one bank question in full, including answer, explanation, difficulty, section, and uses — the revision/authoring companion to learnhub_question_list (which omits answers on purpose for the answering flow). Read the original before correcting a question with learnhub_question_update.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
    },
    (args: { course?: string; node: string; qid: string }) => run('learnhub_question_get', async () =>
      JSON.stringify(await engine.questionGet(args.course, args.node, args.qid))))
  tool('learnhub_content_check',
    'Run the automated content quality gates (out-of-scope references, alias consistency, unregistered code-block languages, interactive file existence) on an existing course note without applying anything. Run this after manually editing a course note in the vault; fix every reported finding.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run('learnhub_content_check', async () =>
      JSON.stringify(await engine.contentCheck(args.course, args.node))))
  tool('learnhub_question_list',
    'List the question-bank questions of a node as JSON (no answers). Bank files live at <课程根>/题库/<节点>.yaml; kinds: single_choice / true_false / fill_in_blank / multi_choice / numeric / ordering / matching / reflection / open_question.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run('learnhub_question_list', async () =>
      JSON.stringify(await engine.questions(args.course, args.node))))
  tool('learnhub_question_save',
    'Save a question bank for a node: validates the Bank YAML (node/kind/q/answer per kind: single_choice needs options + letter answer; multi_choice options + letter array; true_false boolean; fill_in_blank accepted answers; numeric numeric answer + optional tol; ordering options + ordered answer items; matching left-column options + paired right-column answers; reflection grading rubric; open_question reference points) then writes <课程根>/题库/<节点>.yaml.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must match the node field inside the YAML)' },
      yaml: { type: 'string', required: true, description: 'Bank YAML text (node/questions[id,kind,q,answer,options?,explanation?,difficulty?,uses?])' },
    },
    (args: { course: string; node: string; yaml: string }) => run('learnhub_question_save', async () =>
      JSON.stringify(await engine.questionSave(args.course, args.node, args.yaml))))
  tool('learnhub_question_answer',
    'Answer one bank question (flashcard model): auto-judged 1.0/0.0 (reflection graded by AI against its rubric); the result drives THAT question\'s FSRS schedule (correct=Good, wrong=Again). Node mastery is purely derived (masteryOfFm: 0.7 x memory-stability progress + 0.3 x practice-evidence EMA); per-question answer stats only feed the completion gate, not mastery. predicted (E4 JOL) records the learner\'s pre-answer one-tap prediction (会/不会/没把握) from a jol-flagged probe card — omit when not asked.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
      answer: { type: 'string', required: true, description: 'User answer (choice: letter, multi_choice: comma-joined letters; true_false: 对/错; fill_in_blank: text; numeric: number; ordering/matching: newline-joined item texts in submitted order; reflection/open_question: free text)' },
      predicted: { type: 'string', description: 'Learner\'s pre-answer JOL prediction (E4): 会 / 不会 / 没把握' },
    },
    (args: { course: string; node: string; qid: string; answer: string; predicted?: string }) => run('learnhub_question_answer', async () =>
      JSON.stringify(await engine.questionAnswer(
        prompt => llmComplete(ctx, prompt), args.course, args.node, args.qid, args.answer,
        null, { ...(args.predicted !== undefined ? { predicted: args.predicted as never } : {}) }))))

  tool('learnhub_note_source_register',
    'Register a personal vault note (or a folder — batch-registers every .md under it, recursively, dot-dirs skipped) as a Note Source (C1): the engine reads it ONLY to generate review questions; the note file is never written (zero bytes change, never judged Broken). Derivatives (fingerprint manifest + per-source question bank) live in the 学习中心/笔记源 mirror. Re-registering a missing source by the same path restores it. Question generation is a separate explicit step (learnhub_note_source_generate).',
    { path: { type: 'string', required: true, description: 'Note or folder path, vault-relative or absolute; must be outside the learning center' } },
    (args: { path: string }) => run('learnhub_note_source_register', async () =>
      JSON.stringify(await engine.noteSourceRegister(args.path))))
  tool('learnhub_note_source_list',
    'List registered Note Sources (C1) with pool status: ok / missing (note deleted or renamed — pool suspended, re-register or unregister) / drifted (note edited since question generation — regenerate or archive old questions, never automatic). Cards enter the global review queue automatically when due (course field = 笔记源).',
    {},
    () => run('learnhub_note_source_list', async () =>
      JSON.stringify(await engine.noteSourceList())))
  tool('learnhub_note_source_unregister',
    'Unregister a Note Source (C1): removes the registry entry, the mirror manifest item, and the mirror question bank. The user\'s note file is untouched. Use the id from learnhub_note_source_list.',
    { id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' } },
    (args: { id: string }) => run('learnhub_note_source_unregister', async () =>
      JSON.stringify(await engine.noteSourceUnregister(args.id))))
  tool('learnhub_note_source_generate',
    'Generate review questions for a Note Source (C1): reads the note body (read-only) → 笔记出题 prompt → model → validateBank gate appends each question to the mirror bank (学习中心/笔记源/题库/<id>.yaml) → new cards get their FSRS card initialized (due tomorrow, synthetic init like course completion). The manifest fingerprint refreshes to the current content (drift acknowledged); old questions are NOT auto-archived — offer the learner to archive them explicitly. Fails loud when the source file is missing (re-register first).',
    {
      id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { id: string; count?: number }) => run('learnhub_note_source_generate', async () => {
      const n = questionCount(args.count)
      return JSON.stringify(await engine.noteSourceGenerate(args.id, n, async prompt => stripFences(await llmComplete(ctx, prompt))))
    }))
  tool('learnhub_anki_export',
    'Push today\'s due cards to desktop Anki over AnkiConnect (C2 #63, ADR-0011 — Anki is a pure ANSWERING conduit, the vault stays the ONLY scheduler): recalibrates the mirror deck(s) learnhub::<课程> on every call — adds missing due cards (model「learnhub」, fields 题目/答案/来源, the 来源 field carries 课程/节点/题id for write-back attribution), updates reworded ones, and DELETES mirror cards that are archived, regenerated, or no longer due in the vault (the deck is a disposable mirror — never judged Broken, vault wins on any mismatch; Anki-side scheduling output is discarded). Requires Anki running with the AnkiConnect add-on. After the learner answers in Anki (Again/Hard/Good/Easy), bring the answers home with learnhub_anki_import — import BEFORE the next export so freshly answered cards are not re-pushed.',
    { endpoint: { type: 'string', description: 'AnkiConnect endpoint; default http://127.0.0.1:8765' } },
    (args: { endpoint?: string }) => run('learnhub_anki_export', async () =>
      JSON.stringify(await engine.ankiExportPush(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))))
  tool('learnhub_anki_import',
    'Pull Anki review events since the last import and write them back as RAW ANSWERING EVIDENCE — the vault re-schedules every affected card with its own ts-fsrs, so the conclusion is identical no matter where the learner answered (ADR-0011: vault is the only scheduler). Mapping: Again → 答错 (rating 1, auto), Hard/Good/Easy → 复习自评档 (2/3/4, self, counted as recalled). The「one push per card per day」invariant holds across devices: a card the vault already advanced that day keeps its schedule untouched — the event is archived in the practice stream only. Imported events land in the practice stream (judge=review, timestamped at the Anki answer time, zero XP) and real advances also land in the review log, so memory-health stats and the FSRS parameter optimizer see Anki answers. Events that cannot be attributed (mirror lost → recovered via the 来源 field; question archived/regenerated) are counted and skipped, never guessed.',
    { endpoint: { type: 'string', description: 'AnkiConnect endpoint; default http://127.0.0.1:8765' } },
    (args: { endpoint?: string }) => run('learnhub_anki_import', async () =>
      JSON.stringify(await engine.ankiImportEvents(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))))
  tool('learnhub_anki_status',
    'Show the Anki channel status (C2): mirror size and deck names, last push/import timestamps, the current vault due-card distribution the next export would push, and AnkiConnect reachability. Use it to check the channel before exporting or importing.',
    { endpoint: { type: 'string', description: 'AnkiConnect endpoint; default http://127.0.0.1:8765' } },
    (args: { endpoint?: string }) => run('learnhub_anki_status', async () =>
      JSON.stringify(await engine.ankiStatus(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))))
  tool('learnhub_explain_back_pack',
    'Open the「讲给我听」Feynman session for a node (E2, learner output — the learner explains to YOU): returns the session pack = section-by-section content points + graph position + your role instructions. Your role in this and following turns: a COMPLETE NOVICE who knows nothing about the topic — ask questions ONLY from the content points, one question at a time, probing ambiguity/vagueness, skipped steps, and wrong statements in the learner\'s words; never grade, never praise, never go beyond the points, never give answers; if the learner says「换一种问」re-ask the unclear point from a different angle; wrap up briefly in-character once everything is covered. After the session ends, call learnhub_explain_feedback with the full transcript.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run('learnhub_explain_back_pack', () =>
      engine.explainBackPack(args.course, args.node)))
  tool('learnhub_explain_feedback',
    'Close a「讲给我听」session (E2) with located feedback: sends the full transcript to the grading model against the node\'s content points and returns verdict (对/部分对/错) + deviation tags (含糊/跳跃/说错) + a "how to fill the gap" advice + the full markdown feedback for the learner. The verdict is archived ONLY in the E archive — zero XP, zero canonical writes (Learner Output boundary); fails loud with zero side effects if the model output is unparseable.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      transcript: { type: 'string', required: true, description: 'Full explain-back dialogue (learner explanations + your novice questions)' },
    },
    (args: { course: string; node: string; transcript: string }) => run('learnhub_explain_feedback', async () =>
      JSON.stringify(await engine.explainBackFeedback(args.course, args.node, args.transcript, (prompt, system) => llmComplete(ctx, prompt, system)))))
  tool('learnhub_learner_card_add',
    'Archive the learner\'s own wording as a LearnerCard (E1「我的卡」, the archive target of E2 explain-back): kind recall_cue (再讲一遍 — default; front asks them to re-explain in their own words) or cloze_rewrite (挖空重述; content must contain at least one non-empty {{…}} cloze). The card lives in the「我的卡」E domain (ADR-0021: its reviews ride the merged cross-course review queue and earn unbound XP — totals/daily goal/streak only, never per-course or per-node ledgers; one push per card per day via learnhub_learner_rate / learnhub_learner_forget). Creating the card is zero XP and writes nothing to mastery or node scheduling. Duplicate content on the same node is rejected.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Source node the card attaches to' },
      content: { type: 'string', required: true, description: 'The learner\'s own wording (the archived explanation/note)' },
      kind: { type: 'string', description: 'recall_cue (default) or cloze_rewrite' },
      prompt: { type: 'string', description: 'Front prompt; a default is generated per kind when omitted' },
      section: { type: 'string', description: 'Section id to anchor the card to a specific section' },
    },
    (args: { course: string; node: string; content: string; kind?: string; prompt?: string; section?: string }) => run('learnhub_learner_card_add', async () => {
      if (!args.content?.trim()) throw new Error('[learner-card-add] content 必填——存的是学习者自己的话。')
      return JSON.stringify(await engine.explainArchiveCard(args.course, args.node, {
        content: args.content,
        ...(args.kind !== undefined ? { kind: args.kind as 'recall_cue' | 'cloze_rewrite' } : {}),
        ...(args.prompt !== undefined && args.prompt.trim() ? { prompt: args.prompt } : {}),
        ...(args.section !== undefined && args.section.trim() ? { section: args.section } : {}),
      }))
    }))
  tool('learnhub_understanding_add',
    'Add the learner\'s「我的理解」as a section-anchored self-note (E1「加我的理解」entry): the learner writes ONE explanation/example/mnemonic in their OWN words for a section they just learned; the model compares it against that section\'s taught points and returns verdict (对/部分对/错) + located deviations (含糊/跳跃/说错) + a "how to fill the gap" advice + the full markdown feedback. The verdict is archived ONLY in the E archive and the wording becomes a LearnerCard in the「我的卡」E domain (ADR-0021: reviews ride the merged review queue and earn unbound XP — totals only, never per-course ledgers) — Learner Output boundary: creating is zero XP, zero mastery/node-scheduling writes. Unparseable model feedback fails loud with zero side effects (nothing is archived, no card is created). kind: recall_cue 提示重述 (default) / cloze_rewrite 挖空重述 (content must contain a non-empty {{…}} cloze) / self_explain 自注讲解.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      content: { type: 'string', required: true, description: 'The learner\'s own wording (their understanding, in their words)' },
      section: { type: 'string', description: 'Section id or title to anchor the note to (the feedback then compares against that section only)' },
      kind: { type: 'string', description: 'Card face: recall_cue (default) / cloze_rewrite / self_explain' },
      prompt: { type: 'string', description: 'Front prompt; a default is generated per kind when omitted' },
    },
    (args: { course: string; node: string; content: string; section?: string; kind?: string; prompt?: string }) => run('learnhub_understanding_add', async () => {
      if (!args.content?.trim()) throw new Error('[understanding] content 必填——存的是学习者自己的话。')
      return JSON.stringify(await engine.learnerNoteAdd(args.course, args.node, {
        content: args.content,
        ...(args.section !== undefined && args.section.trim() ? { section: args.section } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as never } : {}),
        ...(args.prompt !== undefined && args.prompt.trim() ? { prompt: args.prompt } : {}),
      }, (prompt, system) => llmComplete(ctx, prompt, system, { effort: llmCfg.fastEffort })))
    }))
  tool('learnhub_learner_queue',
    'List ALL「我的卡」E-domain cards (E1) for inventory/management: due cards first (due ascending), never-scheduled cards after. Each card carries prompt (front: what to restate) and content (back: the learner\'s own wording), source_node/source_section anchors, and attempts. Review happens in the merged cross-course review queue (ADR-0021) or directly via learnhub_learner_rate (Hard/Good/Easy 2/3/4) / learnhub_learner_forget — one push per card per day. Rating earns unbound XP: counted in totals/daily goal/streak only, never in per-course/per-node ledgers, never in mastery.',
    { course: { type: 'string', description: 'Course name; omit for all enabled courses' } },
    (args: { course?: string }) => run('learnhub_learner_queue', async () =>
      JSON.stringify(await engine.learnerQueue(args.course))))
  tool('learnhub_learner_rate',
    'Settle one「我的卡」self-note card with the learner\'s self-rating after they restated and compared (2=Hard 3=Good 4=Easy). One push per card per day (a second same-day rating is rejected). Only the card\'s own FSRS block moves; the rating earns unbound XP (ADR-0021) — counted in totals/daily goal/streak only, never in per-course/per-node ledgers or mastery.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to (source_node)' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      rating: { type: 'number', required: true, description: 'Self-rating: 2 Hard / 3 Good / 4 Easy' },
    },
    (args: { course: string; node: string; card: string; rating: number }) => run('learnhub_learner_rate', async () =>
      JSON.stringify(await engine.learnerCardRate(args.course, args.node, args.card, args.rating))))
  tool('learnhub_learner_forget',
    'Declare「忘记」on a「我的卡」self-note card — the learner could not restate it, so the card is pushed with rating 1 (again tomorrow). One push per card per day; zero XP (a 0-XP unbound journal row keeps the streak ledger honest, ADR-0021), no mastery or node-scheduling writes.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to (source_node)' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
    },
    (args: { course: string; node: string; card: string }) => run('learnhub_learner_forget', async () =>
      JSON.stringify(await engine.learnerCardForget(args.course, args.node, args.card))))
  tool('learnhub_learner_card_archive',
    'Archive or restore one「我的卡」self-note card (E1 management). Archived cards leave the learner queue but keep their history in the card file. E-domain internal action: zero canonical writes.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to (source_node)' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { course: string; node: string; card: string; archived?: boolean }) => run('learnhub_learner_card_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[learner-card-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await engine.learnerCardArchive(args.course, args.node, args.card, args.archived))
    }))

  // —— 项目域（P 区 / ADR-0015；#92）：Project 是 Course 姊妹实体，零 XP、零 FSRS、不进 sessions/srs ——

  tool('learnhub_project_create',
    'Create a project (P-area first-class entity, Course\'s SISTER not a node): a real-world practice the learner is actually doing, measured in weeks/months. Writes 学习中心/projects/<id>/项目.md (frontmatter: lifecycle=active, fading tier 骨架/补全/独立 default 补全, goal prose, empty plan). Projects carry ZERO XP, ZERO FSRS, never enter sessions/srs/review queue — node consumers are untouched. After creating, draft the milestone plan with learnhub_project_plan_generate.',
    {
      name: { type: 'string', required: true, description: 'Project name (also becomes the workspace id)' },
      goal: { type: 'string', required: true, description: 'Learner\'s goal description prose (plan drafting input)' },
      tier: { type: 'string', description: 'Fading tier: 骨架/补全/独立 (default 补全)' },
    },
    (args: { name: string; goal: string; tier?: string }) => run('learnhub_project_create', async () =>
      JSON.stringify(await engine.projectCreate({
        name: args.name, goal: args.goal,
        ...(args.tier !== undefined ? { tier: args.tier as never } : {}),
      }))))
  tool('learnhub_project_list',
    'List all projects as JSON (id/name/lifecycle/tier/plan size). Projects are the bounded project area: real practice with milestone plans, separate from course nodes.',
    {},
    () => run('learnhub_project_list', async () => JSON.stringify(await engine.projectList())))
  tool('learnhub_project_show',
    'Show one project in full: frontmatter (lifecycle/tier/goal/plan) plus per-milestone artifact status (generated or not, file name) and orphan files left by past plan revisions.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run('learnhub_project_show', async () =>
      JSON.stringify(await engine.projectShow(args.id))))
  tool('learnhub_project_lifecycle',
    'Set a project\'s lifecycle: active/paused/delivered/archived. No irreversible transitions (ADR-0015) — delivered/archived projects can reopen to active; a no-deadline project may legally stay active forever. Pure status change: no XP settle, no scheduling effect.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      lifecycle: { type: 'string', required: true, description: 'active/paused/delivered/archived' },
    },
    (args: { id: string; lifecycle: string }) => run('learnhub_project_lifecycle', async () =>
      JSON.stringify(await engine.projectSetLifecycle(args.id, args.lifecycle))))
  tool('learnhub_project_tier',
    'Set a project\'s fading tier (骨架/补全/独立): how much support NEW milestone artifacts get (near-complete demonstration → partial product with gaps → situation only). Already-generated artifacts keep their tier (no retroactive rewrite — regenerating them at the new tier goes through the proposal channel). Tier movement criteria (performance within tier) belong to the execution-event stream; v1 sets it explicitly with the learner.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      tier: { type: 'string', required: true, description: '骨架/补全/独立' },
    },
    (args: { id: string; tier: string }) => run('learnhub_project_tier', async () =>
      JSON.stringify(await engine.projectSetTier(args.id, args.tier))))
  tool('learnhub_project_plan_generate',
    'Draft the milestone plan for a project through the model and file it as a PENDING project_plan proposal (human review in the panel; apply with learnhub_project_apply): an ordered 3–8 item plan of 1–2-week deliverable checkpoints, simple→complex task classes, each with acceptance hints. Revising an existing plan is the same channel — applying the proposal snapshots the replaced plan YAML (no silent overwrite). The plan lands in the project\'s 项目.md frontmatter; milestone ARTIFACTS are generated separately per milestone.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run('learnhub_project_plan_generate', () => generateProjectPlan(ctx, args.id)))
  tool('learnhub_project_milestone_generate',
    'Generate ONE milestone artifact (a four-block task card 给定/待办/验收清单/支持) through the model at the project\'s current fading tier: 骨架 = near-complete demonstration, 补全 = partial product with【待补全】gaps, 独立 = situation and starting point only. Output passes a lightweight structural gate (one repair round on failure). FIRST generation lands directly; if the artifact already exists the same call files a PENDING project_milestone REGENERATION proposal instead — apply with learnhub_project_apply (old text is snapshotted, never silently overwritten). Zero XP, zero FSRS.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id from the plan (e.g. m1)' },
    },
    (args: { id: string; milestone: string }) => run('learnhub_project_milestone_generate', () =>
      generateProjectMilestone(ctx, args.id, args.milestone)))
  tool('learnhub_project_apply',
    'Apply a pending PROJECT proposal by id (kind read from the record: project_plan = write the revised milestone plan into 项目.md with the old plan snapshotted; project_milestone = overwrite the milestone artifact with the old text snapshotted). Graph proposals (gen/edit) go through learnhub_graph_apply instead. Nothing applies without this explicit step — review pending proposals with the learner first.',
    { id: { type: 'number', required: true, description: 'Pending proposal id' } },
    (args: { id: number }) => run('learnhub_project_apply', async () =>
      JSON.stringify(await engine.projectApply(args.id))))
  tool('learnhub_project_milestone_pass',
    'Record the learner\'s EXPLICIT milestone pass (P-4 settlement): the learner declares a milestone checkpoint reached — no checklist gate and no question gate (Kulik 1990: strict gates hurt completion). One journal settlement row lands (kind=milestone_settle, aligned with the node xp_settle precedent): XP price = the plan\'s est declaration × FSRS difficulty calibration over the DECLARED linked nodes\' question pools (defaults when undeclared; the calibration basis is locked to the plan — it cannot be extended at pass time), locked once — a second pass of the same milestone id is rejected, so revising a plan must use fresh milestone ids. This is the ONLY journal write the project domain ever makes; it counts toward the ledger and streak like real focused work does.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id from the plan' },
    },
    (args: { id: string; milestone: string }) => run('learnhub_project_milestone_pass', async () =>
      JSON.stringify(await engine.projectMilestonePass(args.id, args.milestone))))
  tool('learnhub_project_milestone_recall',
    'Start a MILESTONE RECALL session (P-3): draw a few questions from the linked course nodes\' question banks so the knowledge base stays connected to the real project — retrieval points serve the knowledge base only, they are NOT project acceptance criteria (the gate is only that the milestone artifact exists). Zero XP, zero FSRS, zero scheduling writes: the drawn questions are archived to projects/<id>/recall.jsonl and returned WITH answers for you to run verbally — ask, hear the learner out, compare; never call learnhub_question_answer for these. Then archive the learner\'s spoken key-decision narration with learnhub_project_recall_reflect.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id from the plan (artifact must be generated)' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Extra linked course nodes (merged with the plan\'s declared nodes)' },
      limit: { type: 'number', description: 'Questions to draw (default 5)' },
    },
    (args: { id: string; milestone: string; nodes?: string[]; limit?: number }) => run('learnhub_project_milestone_recall', async () =>
      JSON.stringify(await engine.projectMilestoneRecall(args.id, args.milestone, { nodes: args.nodes, limit: args.limit }))))
  tool('learnhub_project_recall_reflect',
    'Archive the learner\'s key-decision narration from a milestone recall session (P-3): their spoken「到目前为止的关键决策」goes verbatim into projects/<id>/recall.jsonl for later retrospection. No verdict, no scoring, no canonical writes — the narration is for looking back on, not for feeding the scheduler.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id' },
      narration: { type: 'string', required: true, description: 'Learner\'s key-decision narration (verbatim, non-empty)' },
    },
    (args: { id: string; milestone: string; narration: string }) => run('learnhub_project_recall_reflect', async () =>
      JSON.stringify(await engine.projectRecallReflect(args.id, args.milestone, args.narration))))
  tool('learnhub_project_recall_log',
    'Read a project\'s recall-session ledger (P-3): the draw records (which questions were drawn at which milestone) and reflect records (key-decision narrations). Read-only.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run('learnhub_project_recall_log', async () =>
      JSON.stringify(await engine.projectRecallLog(args.id))))
  tool('learnhub_project_enc_candidates',
    'Mine BEHAVIORALLY-INFERRED enc candidate edges (P-6): scan the learner\'s real card flips/answer activity on the project\'s linked course nodes inside a window (default the 14 days before the named milestone\'s pass, else before now); node pairs co-active on ≥ min_co days (default 2) become enc candidates with confidence-weighted edges (≥3 days 1.0 / 2 days 0.8 / 1 day 0.6; direction from the pre-closure when the graph knows it, first-activity heuristic otherwise). Files ONE pending edit proposal per course (set_enc whole-replace ops, declared edges preserved — zero schema break; single-proposal human review like enc_backfill); the panel/learnhub_graph_apply decides. Cross-course pairs are dropped, already-declared edges are skipped. This is how the all-zero enc graph starts growing from doing, not declaring.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', description: 'Milestone id anchoring the window end at its pass time (must have a pass record); omit to anchor at now' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Extra linked course nodes (merged with the plan\'s declared nodes)' },
      window_days: { type: 'number', description: 'Window length in days, 1-90 (default 14)' },
      min_co: { type: 'number', description: 'Minimum co-active days per pair (default 2)' },
    },
    (args: { id: string; milestone?: string; nodes?: string[]; window_days?: number; min_co?: number }) => run('learnhub_project_enc_candidates', async () =>
      JSON.stringify(await engine.projectEncCandidates(args.id, { milestone: args.milestone, nodes: args.nodes, window_days: args.window_days, min_co: args.min_co }))))

  // —— 客户端面板 HTTP 路由 ——
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API, handler: (req, res) => handleApi(ctx, req, res) }),
    'learnhub: client panel API routes',
  )

  // —— 独立面板页面（Vite SPA：web/dist/index.html + assets/*，子路径全部伺服）——
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: PAGE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          // 无尾斜杠的 /learnhub 会把 base './' 的资产解析到根路径（/assets/* 404）→ 统一重定向
          if (url.pathname === PAGE) {
            res.writeHead(301, { location: `${PAGE}/` })
            res.end()
            return
          }
          const rel = decodeURIComponent(url.pathname.slice(PAGE.length).replace(/^\/+/, '')) || 'index.html'
          // 子路径限制在 dist 目录内（防 ../ 逃逸）；命中失败回落 index.html（SPA 语义）
          let file = resolvePath(PAGE_DIST, rel)
          if (!(file + sep).startsWith(PAGE_DIST)) file = join(PAGE_DIST, 'index.html')
          let data: Buffer
          try {
            data = await readFile(file)
          } catch {
            file = join(PAGE_DIST, 'index.html')
            data = await readFile(file)
          }
          const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
          const mime = ASSET_MIME[ext] ?? 'application/octet-stream'
          // assets 带 hash 可永久缓存；index.html no-store 保证发布后刷新即生效
          const immutable = rel.startsWith('assets/')
          res.writeHead(200, {
            'content-type': mime,
            'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
          })
          res.end(data)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`learnhub panel missing (build ui/ first: npm run build): ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    }),
    'learnhub: panel SPA (web/dist)',
  )

  console.log(`[learnhub] plugin loaded: vault=${VAULT}, center=${VAULT}/${CENTER_REL}, 61 tools registered (pure TS engine), page at ${PAGE}, API at ${API}/*`)

  // 加载自检：不依赖模型直接跑一次 status，验证引擎通路。
  void engine.statusJson()
    .then(doc => console.log(`[learnhub] self-check status OK (${JSON.stringify(doc).length} bytes)`))
    .catch(err => console.error(`[learnhub] self-check FAILED: ${err instanceof Error ? err.message : String(err)}`))
}
