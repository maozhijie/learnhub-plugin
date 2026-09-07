/**
 * learnhub 学习引擎插件（Host 侧，bundle 形态）—— v3 纯 TS 引擎。
 *
 * Python 引擎已退役：原 `spawn python -m learnhub` 的全部命令面由
 * src/engine/（TS）同进程承载，本文件只做三件事：
 * - agent 工具面：26 个 defineTool 直调 engine（学习/数据体检/图谱/生成/题库四面）
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
import {
  contentFailureStatus,
  generationJobRetentionMs,
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
}

/** AI 调用的 provider/model/快速档（cordis 行 config 可覆盖，apply 时写入）。 */
const llmCfg = { provider: 'deepseek-official', model: 'deepseek-v4-flash', fastEffort: 'off' as 'off' | 'low' }

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
 * isCancelled 在每次模型产出后检查，取消即丢结果。 */
async function applySectionWithRepair(
  ctx: Context, course: string, node: string,
  s: { id: string; title: string; type: string }, tpl: string, pack: string,
  isCancelled?: () => boolean,
): Promise<{ version: number; title: string; hints: string[] }> {
  const cancelled = () => isCancelled?.() ?? false
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
    `${sectionPrompt(tpl, pack, s)}\n\n## 上一次输出未过质检门（修正下列全部 ✗ 项后重新输出本节正文）\n\n上次输出：\n\n${first}\n\n质检门清单：\n\n${gateReport}\n`,
    undefined, { effort: llmCfg.fastEffort },
  ))
  if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
  try {
    return await engine.contentSection(course, node, s.id, repaired)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${msg}\n（已按门禁清单自动修复重试一轮，仍未通过——可对单节重写或在面板人工修正后 learnhub_content_check）`)
  }
}

/** 课程生成管线（逐节）：大纲（AI 自行判断节的划分/顺序/类型，不设固定结构）
 * → 逐节正文（每节一次模型调用；已 ready 节跳过 = 断点续跑）
 * → 逐节出题 + 综合出题。style 只替换节生成模板（课程节生成-<style>），
 * 大纲、断点续跑与门禁与默认管线同一路径；未知 style 在 loadPrompt fail loud。
 * 出题失败不回滚正文：任务标记 partial 并在 message 里说明，练习页可单独重试出题。 */
async function generateContent(ctx: Context, course: string, node: string, style?: string): Promise<string> {
  const key = `${course}/${node}`
  const existing = genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」正在生成中，请稍候。`)
  }
  const job: GenJob = { course, node, startedAt: new Date().toISOString(), status: 'running', phase: 'outline', ...(style ? { style } : {}) }
  genJobs.set(key, job)
  persistGenJobs()
  try {
    const pack = await engine.contentPack(course, node)
    // 节模板提前 load：风格名写错在这里 fail loud，不浪费大纲调用
    const sectionTpl = await engine.loadPrompt(style ? `课程节生成-${style}` : '课程节生成')

    // —— 大纲：节清单落盘。已有 ready 节（断点续跑）沿用既有清单，否则重跑覆盖 ——
    let views = await engine.contentSectionsView(course, node)
    if (!views.some(s => s.status === 'ready')) {
      const outlineTpl = await engine.loadPrompt('课程大纲')
      const outlineYaml = stripFences(await llmComplete(ctx, `${outlineTpl}\n\n---\n\n${pack}`, undefined, { effort: llmCfg.fastEffort }))
      if (job.status === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
      await engine.contentOutline(course, node, outlineYaml)
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
      await applySectionWithRepair(ctx, course, node, s, sectionTpl, pack, () => job.status === 'cancelling')
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

/** 管线收尾：逐节出题（每内容节 2 道，绑节 id）+ 综合题（通用），汇总任务终态。 */
async function finishWithQuiz(ctx: Context, job: GenJob, contentMsg: string): Promise<string> {
  job.phase = 'quiz'
  job.message = `${contentMsg}；自动出题中…`
  persistGenJobs()
  try {
    const per = await engine.questionGenerateSections(job.course, job.node, async prompt => stripFences(await llmComplete(ctx, prompt)))
    const quiz = await generateQuiz(ctx, job.course, job.node, 3, { generic: true })
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
  const r = await applySectionWithRepair(ctx, course, node, s, sectionTpl, pack)
  return `[section] 「${r.title}」v${r.version} 落盘。`
}

/** 整课重置 + 拓扑序串行重跑生成链（HTTP 与 agent 工具共用）：
 * contentReset 备份旧产物并重写 draft → 清掉该课程遗留任务 → 后台链逐节点 generateContent。
 * 立即返回 { reset, queued }；进度由任务注册表展示。运行中有任务时拒绝。 */
async function resetCourseChain(ctx: Context, courseKey: string): Promise<{ reset: Awaited<ReturnType<LearnhubEngine['contentReset']>>; queued: number }> {
  const running = [...genJobs.values()].filter(j => j.course === courseKey && (j.status === 'running' || j.status === 'cancelling'))
  if (running.length) throw new Error(`课程「${courseKey}」有 ${running.length} 个生成任务进行中，先取消或等完成再重生成。`)
  const c = await engine.resolveCourse(courseKey)
  const { graph } = await engine.loadView(c)
  const reset = await engine.contentReset(c.name)
  for (const [key, j] of genJobs.entries()) if (j.course === c.name) genJobs.delete(key)
  persistGenJobs()
  let chain: Promise<unknown> = Promise.resolve()
  let queued = 0
  for (const node of graph.order.length ? graph.order : graph.names) {
    queued++
    chain = chain.then(() => generateContent(ctx, c.name, node).catch(() => {
      // 单节点失败不阻塞后续（generateContent 已置 failed 留注册表可重试）
    }))
  }
  void chain
  return { reset, queued }
}

/** 任务注册表视图（附各任务节点的内容版本：面板据此做增量刷新）。 */
async function generationStatus(): Promise<Array<GenJob & { key: string; contentVersion?: number }>> {
  const out: Array<GenJob & { key: string; contentVersion?: number }> = []
  for (const [key, j] of genJobs.entries()) {
    let contentVersion: number | undefined
    try {
      contentVersion = await engine.contentVersion(j.course, j.node)
    } catch {
      // 节点/课程缺失等：版本缺省，面板走全量刷新
    }
    out.push({ key, ...j, contentVersion })
  }
  return out
}

function cancelGeneration(course: string, node: string): { cancelled: boolean; status?: string } {
  const job = genJobs.get(`${course}/${node}`)
  if (!job) return { cancelled: false }
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
    if (req.method === 'GET' && route === '/xp') {
      sendJson(res, 200, await apiRun('api/xp', () => engine.xpStatus()))
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
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (route === '/rebuild') {
        sendJson(res, 200, { message: (await engine.rebuild()).message })
        return
      }
      if (route === '/node/skip') {
        sendJson(res, 200, await apiRun('api/node/skip', () =>
          engine.nodeSkip(need(body, 'course'), need(body, 'node'), body.skipped !== false)))
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
        const kind = need(body, 'kind') === 'edit' ? 'edit' : 'gen'
        sendJson(res, 200, await engine.graphApply(kind, body.id !== undefined ? Number(body.id) : undefined))
        return
      }
      if (route === '/proposals/reject') {
        const id = Number(body.id)
        if (!Number.isInteger(id)) throw new Error('missing required field: id')
        await engine.graphReject(id, typeof body.note === 'string' ? body.note.trim() : '')
        sendJson(res, 200, { message: `[reject] 提案 #${id} 已拒绝留痕。` })
        return
      }
      if (route === '/generate') {
        // 单次非流式：大纲 → 逐节正文 → 自动出题（数分钟），请求挂起直到完成；style = 节生成风格变体（如 苏格拉底）
        const style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : undefined
        sendJson(res, 200, await apiRun('api/generate', async () => ({
          message: await generateContent(ctx, need(body, 'course'), need(body, 'node'), style),
        })))
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
      if (route === '/question-generate') {
        const count = Number(body.count)
        sendJson(res, 200, await apiRun('api/question-generate', () =>
          generateQuiz(ctx, need(body, 'course'), need(body, 'node'), Number.isInteger(count) && count > 0 ? count : 6)))
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
          typeof body.elapsed_s === 'number' && Number.isFinite(body.elapsed_s) ? body.elapsed_s : null)))
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
    }
    if (req.method === 'PUT') {
      const body = await readJson(req)
      if (route === '/daily-goal') {
        const goal = Number(body.goal)
        if (!Number.isFinite(goal)) throw new Error('missing required field: goal')
        sendJson(res, 200, await apiRun('api/daily-goal', () => engine.setDailyGoal(goal)))
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

  // 生成任务注册表恢复：上次进程遗留的 running/cancelling 标为失败（LLM 调用随进程消失）
  void engine.loadGenJobs().then(stale => {
    for (const raw of stale) {
      const j = raw as Partial<GenJob>
      if (typeof j.course !== 'string' || typeof j.node !== 'string') continue
      const key = `${j.course}/${j.node}`
      const interrupted = j.status === 'running' || j.status === 'cancelling'
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
    persistGenJobs()
    if (stale.length) console.log(`[learnhub] gen-jobs restored: ${stale.length} (interrupted marked failed)`)
  })

  // provider/model/快速档来自行 config（缺省用当前默认模型与 off 快速档）
  if (config?.provider) llmCfg.provider = config.provider
  if (config?.model) llmCfg.model = config.model
  if (config?.fastEffort) llmCfg.fastEffort = config.fastEffort

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
    'Return the learning center status (center summary + per-course detail) as JSON.',
    {}, () => run('learnhub_status', async () => JSON.stringify(await engine.statusJson())))
  tool('learnhub_data_check',
    'Run a read-only Data Check across the registry, graph YAML, course notes/frontmatter, and question banks. Return JSON findings that distinguish Missing (legal absence) from Broken (present but invalid); it never repairs or writes vault data.',
    {}, () => run('learnhub_data_check', async () => JSON.stringify(await engine.dataCheck())))
  tool('learnhub_skip',
    'Mark a node as skipped (learner already knows it) or un-skip. Skipped nodes count as passed: they leave the recommendation queue and no longer block successors.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      skipped: { type: 'boolean', description: 'true to skip (default), false to un-skip' },
    },
    (args: { course: string; node: string; skipped?: boolean }) => run('learnhub_skip', async () =>
      JSON.stringify(await engine.nodeSkip(args.course, args.node, args.skipped !== false))))
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
    'Get the dynamic cross-course recommendation queue as JSON: next events (review/learning/new lesson) ranked by the priority rule (overdue reviews first by days overdue and retention decay, then half-finished lessons, then new lessons by unlock count and region rotation). Each event has type/course/node/score/why. Fetch the next batch after finishing one.',
    { limit: { type: 'number', description: 'Max events to return (default 5)' } },
    (args: { limit?: number }) => run('learnhub_recommend', async () =>
      JSON.stringify(await engine.recommend(args.limit === undefined ? 5 : args.limit))))
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
    'Browse a course graph by region and/or block: node listings with depth/stage/est/difficulty/type/content status. Omit both filters to list every region (structure overview); give region (and optionally block) to explore one area. Unknown region names fail loud with the valid list.',
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
  tool('learnhub_graph_apply',
    'Decide a pending graph proposal: apply (audit-gated, writes data/*.yaml with rename linkage + journal + snapshot) or reject (kept on record). In graph-generation batches the agent applies directly after gates pass; revision changes wait for human review first (ADR-0003). The apply result carries findings: audit warns plus a health-score hint when below the skill exit threshold — address them in the next batch.',
    {
      kind: { type: 'string', required: true, description: '"gen" or "edit"' },
      id: { type: 'number', description: 'Proposal id; omit for the latest pending of this kind' },
      reject: { type: 'boolean', description: 'true to reject instead of apply' },
      note: { type: 'string', description: 'Rejection reason (recorded)' },
    },
    async (args: { kind: string; id?: number; reject?: boolean; note?: string }) =>
      run('learnhub_graph_apply', async () => {
        if (args.reject) {
          if (!args.id) throw new Error('reject requires the proposal id')
          await engine.graphReject(args.id, args.note ?? '')
          return `[reject] 提案 #${args.id} 已拒绝留痕。`
        }
        return JSON.stringify(await engine.graphApply(args.kind === 'edit' ? 'edit' : 'gen', args.id))
      }))
  tool('learnhub_generate',
    'Generate one course note via the model: outline first (the model decides section split, order, and types from the content, topic, and style — no fixed structure), then one model call per section through the quality gates as a draft (ready sections are skipped, so retrying resumes the pipeline), then per-section + synthesis quiz questions. The context pack (prereqs, domain boundary, forbidden concepts) and user-editable prompt templates (state/提示词/课程大纲.md, 课程节生成.md) drive the calls. Missing notes are scaffolded first (on-demand lesson semantics). style selects a per-section prompt variant (课程节生成-<style>, e.g. 苏格拉底/费曼) applied to every section call; the outline and gates stay on the default path.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name to generate' },
      style: { type: 'string', description: 'Prompt style variant; omit for the default template' },
    },
    (args: { course: string; node: string; style?: string }) => run('learnhub_generate', () =>
      generateContent(ctx, args.course, args.node, args.style)))
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
  tool('learnhub_question_generate',
    'Generate quiz questions for a node via the model — the same pipeline as the auto-quiz: node body → question prompt → llm → validateBank gate appends every question to the bank. Use when a node has no/too few questions.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must have generated content)' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { course: string; node: string; count?: number }) => run('learnhub_question_generate', async () => {
      const n = Number.isInteger(args.count) && (args.count as number) > 0 ? args.count as number : 6
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
    'Answer one bank question (flashcard model): auto-judged 1.0/0.0 (reflection graded by AI against its rubric); the result drives THAT question\'s FSRS schedule (correct=Good, wrong=Again) and the node mastery aggregates per-question stats.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
      answer: { type: 'string', required: true, description: 'User answer (choice: letter, multi_choice: comma-joined letters; true_false: 对/错; fill_in_blank: text; numeric: number; ordering/matching: newline-joined item texts in submitted order; reflection/open_question: free text)' },
    },
    (args: { course: string; node: string; qid: string; answer: string }) => run('learnhub_question_answer', async () =>
      JSON.stringify(await engine.questionAnswer(prompt => llmComplete(ctx, prompt), args.course, args.node, args.qid, args.answer))))

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

  console.log(`[learnhub] plugin loaded: vault=${VAULT}, center=${VAULT}/${CENTER_REL}, 26 tools registered (pure TS engine), page at ${PAGE}, API at ${API}/*`)

  // 加载自检：不依赖模型直接跑一次 status，验证引擎通路。
  void engine.statusJson()
    .then(doc => console.log(`[learnhub] self-check status OK (${JSON.stringify(doc).length} bytes)`))
    .catch(err => console.error(`[learnhub] self-check FAILED: ${err instanceof Error ? err.message : String(err)}`))
}
