/**
 * learnhub 学习引擎插件（Host 侧，bundle 形态）—— v3 纯 TS 引擎。
 *
 * Python 引擎已退役：原 `spawn python -m learnhub` 的全部命令面由
 * src/engine/（TS）同进程承载，本文件只做三件事：
 * - agent 工具面：111 个 defineTool 直调 engine（学习/数据体检/图谱/生成/题库/笔记源/学习者产出/项目/实验室/无界实践/Anki 互通）
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
import type { Context} from '@deepseek-ai/cordis'
import { defineTool} from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, writeFileSync} from 'node:fs'
import { readFile, appendFile, mkdir} from 'node:fs/promises'
import type { IncomingMessage, ServerResponse} from 'node:http'
import { join, resolve as resolvePath, sep} from 'node:path'
import { ANKI_ENDPOINT, AnkiConnectClient, Content, LearnhubEngine, TIER_LABELS, genericQuizTarget, tierIdxOf} from './engine/index.ts'
import type { CoachTrigger, LlmComplete, SeedDraftRequest} from './engine/index.ts'
import { contentEffort, llmComplete, llmSeam, llmStreamOnce, llmView } from './host/llm.ts'
import { ASSET_MIME, FILE_MIME, PAGE_DIST, VENDOR_DIST, injectKatexIfMathed, need, readJson, sendJson } from './host/http.ts'
import { applyId, bandPref, graphKind, questionCount, rejectId, requireSkipDirection} from './tool-contracts.ts'
import {
  contentFailureStatus,
  genJobRetentionRemainingMs,
  genJobSweepVerdict,
  generationJobRetentionMs,
  isGenJobTerminal,
  nextQueuedJob,
  quizFailureOutcome,
  quizSuccessOutcome,
  type GenJobPhase,
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
const AGENT_GUIDE: Array<{ tool: string; page: string; text: string; prompt?: string }> = [
  { tool: 'learnhub_pin_today', page: 'learn', text: '「今天学它」：把节点置顶为今日推荐榜首（可挂执行意图），只影响今天、次日自动失效。',
    prompt: '用 learnhub_pin_today 把「<节点>」设为今天的学习目标' },
  { tool: 'learnhub_unpin', page: 'learn', text: '取消今天的「今天学它」置顶。', prompt: '取消「<节点>」的今日置顶' },
  { tool: 'learnhub_goal_intention', page: 'learn', text: '在今日 pin 上写/清「在【线索】之后就【行动】」的执行意图（随 pin 当日过期）。',
    prompt: '给今天「<节点>」的 pin 挂一个执行意图：晚饭后就在书桌前学完它' },
  { tool: 'learnhub_note_source_exclude', page: 'learn', text: '把个人笔记文件/目录加入排除清单（未来不再被自动注册为复习源）。',
    prompt: '把「<笔记路径>」加入笔记源排除清单' },
  { tool: 'learnhub_note_source_unexclude', page: 'learn', text: '从笔记源排除清单移除（恢复可注册资格）。',
    prompt: '把「<笔记路径>」移出笔记源排除清单' },
  { tool: 'learnhub_graph_node', page: 'graph', text: '单节点深查：前置/后继/enc 边/生成状态/健康问题一次看全。',
    prompt: '用 learnhub_graph_node 深查「<节点>」' },
  { tool: 'learnhub_graph_browse', page: 'graph', text: '按区/块浏览课程图结构。', prompt: '按区块浏览「<课程>」的图结构' },
  { tool: 'learnhub_graph_path', page: 'graph', text: '查询两节点之间的先修链（学 B 之前要过哪些节点）。',
    prompt: '查一下从「<节点A>」到「<节点B>」的先修链' },
  { tool: 'learnhub_question_audit', page: 'bank', text: '题库契约只读体检：表达式/数字填空、记法违规、转义损坏、超长解析——只盘点不修复。',
    prompt: '跑一次题库体检，把违规存量题列给我' },
  { tool: 'learnhub_question_get', page: 'bank', text: '读单题全文（含答案与解析）——改题/审题前先看原题。',
    prompt: '把「<节点>」题库里 q1 的完整题目读给我看' },
  { tool: 'learnhub_bank_cleanup', page: 'bank', text: '一键清理题库：跳过节点的全部未归档题 + 已完成节点的休眠题（从未调度），预览确认后归档（可逆，不删除）。',
    prompt: '预览一下题库清理会归档哪些题，我确认后再执行' },
  { tool: 'learnhub_content_check', page: 'generate', text: '只跑正文质检门不落盘——在 vault 手改笔记后自检违规。',
    prompt: '对「<节点>」跑一次正文质检' },
  { tool: 'learnhub_data_check', page: 'global', text: '只读数据体检：盘点注册表/图/笔记/题库的 Missing 与 Broken，不修复不写入。',
    prompt: '跑一次数据体检，告诉我有没有 Broken' },
  { tool: 'learnhub_rebuild', page: 'global', text: '重建就绪清单等派生文件（过审计门；数据文件坏了后的修复入口）。',
    prompt: '重建一遍就绪清单' },
  { tool: 'learnhub_note_resolve', page: 'global', text: '把 vault 笔记路径解析到所属课程/节点（查归属用）。',
    prompt: '「<笔记路径>」属于哪个课程节点？' },
  { tool: 'learnhub_skill_create', page: 'practice', text: '创建技能条目（乐器/运动/编程等持续技能的调度 lane 载体）。',
    prompt: '创建技能条目「<技能名>」' },
  { tool: 'learnhub_execution_log', page: 'practice', text: '记一条技能执行事件（表现评级 1-4 + 真实专注时长；入 XP 账本与 streak）。',
    prompt: '记一条执行事件：今天练了「<技能>」40 分钟，自评 3 分' },
  { tool: 'learnhub_receipt_submit', page: 'practice', text: '提交外部练习回执（描述/图片/导出皆可；AI 量表评审，零 XP、不推调度）。',
    prompt: '提交一份回执：<练习内容描述>' },
  { tool: 'learnhub_receipt_list', page: 'practice', text: '查看已提交的回执清单。', prompt: '列出我提交过的回执' },
  { tool: 'learnhub_project_milestone_pass', page: 'projects', text: '里程碑显式通过结算：按 est 定价锁定 XP（对账动作，不是删除）。',
    prompt: '「<项目>」的里程碑 m1 通过了，帮我结算' },
  { tool: 'learnhub_project_milestone_recall', page: 'projects', text: '里程碑回溯会话：过点前对关联节点抽题+自述（检索点练习）。',
    prompt: '为「<项目>」的里程碑 m1 发起回溯会话' },
  { tool: 'learnhub_project_enc_candidates', page: 'projects', text: '从项目执行行为推断成分技能边候选，生成待人审图提案（面板回填按钮走的是作答记录推断，这是项目执行流推断——两条通道）。',
    prompt: '从「<项目>」的执行记录里找成分技能边候选' },
]

/** 课程生成任务注册表（course/node 键）：面板「生成」页签的状态源，
 * 页面刷新后从这里恢复（allo 同语义：服务端注册表是事实来源）；
 * 状态每次变更全量落盘 state/生成任务.json，host 重启后读入并把遗留 running 标为失败。 */
interface GenJob {
  course: string
  node: string
  startedAt: string
  /** 终态时刻（保留期起算点，随注册表落盘）：恢复清扫据此让保留期跨重启仍生效；
   * 旧档无戳回退 startedAt（ADR-0039）。 */
  finishedAt?: string
  status: GenJobStatus
  /** 组合管线的当前阶段：大纲（outline）→ 逐节正文（sections）→ 自动出题（quiz）；
   * 图域任务用 种子/生长/富化（#131 §5 / #140）。phase=quiz 且直接入队 = 纯出题任务
   * （#118 补生成任务化：/question-generate）。 */
  phase?: GenJobPhase
  /** 逐节进度：done=已就绪节数 total=总节数 current=正在生成的节标题。 */
  progress?: { done: number; total: number; current?: string }
  message?: string
  /** 节生成提示词风格变体（缺省默认「课程节生成」）。 */
  style?: string
  /** 节点复杂度档位（低/中/高；生成入口算好写入，面板进度与弹性评估可读）。 */
  tier?: '低' | '中' | '高'
  /** 纯出题任务的参数（#118）：题量上限 / 定向补节（#117）/ 学习者生成指令（#120）。 */
  count?: number
  section?: { id: string; title: string }
  instruction?: string
  /** 入队时实际使用的模型名（模型透明：任务注册表与面板可审计每次生成用的是什么）。 */
  model?: string
  /** 生长批任务的裁决结果（#145，phase=生长；队列空闲自动拉批的重拉判据读它）：
   * idle=就绪深度满足未拉回合 / no_structure=教练裁决暂不产结构 / applied=已应用。 */
  growthOutcome?: 'idle' | 'no_structure' | 'applied'
  /** 里程碑计划修订注入（#149）：换线/补支注入块随任务携带进教练回合（注入即显式
   * 重新裁决请求——就绪深度满足也不短路停摆，见 coachGrowthBatch）。 */
  growthInject?: string
  /** 图域任务负载（面板下发，phase 决定形状）：种子=建课/换终点表单（SeedDraftRequest
   * 去 course——course 是任务键槽）；反编译=项目目标反编译；计划/里程碑=项目草案
   * （course 槽放项目 id）。 */
  seedPayload?: Omit<SeedDraftRequest, 'course'>
  decompilePayload?: { project: string; course?: string; goal?: string; notes?: string[] }
  planPayload?: { project: string }
  milestonePayload?: { project: string; milestone: string }
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
 * 日志记录序列化摘要；调用失败也留痕（#116：运行日志支持失败记录），随后原样抛出。
 * 绝不在路由里手动 stringify 对象——会双编码。 */
async function apiRun<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  let out: T
  try {
    out = await fn()
  } catch (err) {
    await runLog(tool, `调用失败：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
  await runLog(tool, typeof out === 'string' ? out : JSON.stringify(out))
  return out
}

/** LLM 空闲超时（#118）：连续无新输出 chunk 超过该时长即 abort 本次调用——
 * 流挂起不再永久等待（占死单并发闸）。判卷、出题、生成管线全部调用受益。 */
/** 剥掉模型可能包住的整段 markdown 代码围栏：限 markdown/yaml/json 等数据类标签——
 * 正文类标签（svg/plot 等）本身是内容的一部分，剥掉会毁掉 ```svg/```plot 引用块。 */
function stripFences(body: string): string {
  const m = body.match(/^```(?:markdown|md|yaml|yml|json)?\s*\n([\s\S]*?)\n```\s*$/)
  return m ? m[1] : body
}

/** AI 出题管线：节点正文 → 出题提示词 → llm → validateBank 门禁逐题落盘。
 * complete 为注入的补全缝（#137）。opts 透传节标注清单/综合题模式（逐节管线的出题段）、
 * 定向补节与生成指令（#117/#120）。 */
async function generateQuiz(complete: LlmComplete, course: string, node: string, count: number | undefined, opts?: {
  sections?: Array<{ id: string; title: string }>
  generic?: boolean
  section?: { id: string; title: string }
  instruction?: string
  isCancelled?: () => boolean
}) {
  return engine.questionGenerate(course, node, count, async prompt => stripFences(await complete(prompt)), opts)
}

/** 节生成提示词拼装：模板 + 本节任务（id/标题/类型/节段难度档）+ 上下文包。
 * tierLabel 来自节清单视图（清单 tier 在场用清单值，缺席按节位置+节点难度推导，#147）。 */
function sectionPrompt(tpl: string, pack: string, s: { id: string; title: string; type: string; tierLabel?: string }): string {
  return `${tpl}\n\n## 本节任务\n\n- 节 id：${s.id}\n- 节标题：${s.title}\n- 节类型：${s.type}${s.tierLabel ? `\n- 节段难度档：${s.tierLabel}` : ''}\n\n---\n\n${pack}`
}

/** 逐节生成共用出口：模型产出 → sectionApply；质检门未过时先试块级局部修补
 * （#147：清单 ✗ 全部定位到具体违规块时只回灌这些块、只收替换块，其余内容零重跑），
 * 块级不可定位/修补产出不可拼接/修补后仍未过 → 回退整节修复一轮；仍未过则带说明抛出。
 * fast 档模型偶发违反硬约束（### 子标题/超长正文/非 JSON plot），一次盲跑定生死会让
 * 管线反复卡在同一节。P4：正文初跑恒 fast 档；修补/修复轮按 highTier 升 deep 档
 * （复杂节点值得多思考一轮）。complete 为注入的补全缝（#137）。isCancelled 在每次
 * 模型产出后检查，取消即丢结果。 */
async function applySectionWithRepair(
  complete: LlmComplete, course: string, node: string,
  s: { id: string; title: string; type: string; tierLabel?: string }, tpl: string, pack: string,
  opts?: { isCancelled?: () => boolean; highTier?: boolean },
): Promise<{ version: number; title: string; hints: string[] }> {
  const cancelled = () => opts?.isCancelled?.() ?? false
  const first = stripFences(await complete(sectionPrompt(tpl, pack, s), undefined, { effort: 'fast' }))
  if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
  let gateReport = ''
  try {
    return await engine.contentSection(course, node, s.id, first)
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    if (code !== 'GATE_FAILED') throw err
    gateReport = err.message
  }
  const repairEffort = { effort: contentEffort(opts?.highTier === true) }
  // 块级局部修补：全部 ✗ 都能定位到具体违规块才走（混入任何非块级 finding 时
  // fail-safe 回整节修复）；替换块数量对不上或拼接失败同样回退。
  const plan = Content.blockPatchPlan(first, gateReport)
  if (plan) {
    const patched = stripFences(await complete(Content.blockPatchPrompt(plan), undefined, repairEffort))
    if (cancelled()) throw new Error('生成已取消，结果已丢弃。')
    const merged = Content.applyBlockPatch(first, plan, Content.extractFencedBlocks(patched))
    if (merged !== null) {
      try {
        return await engine.contentSection(course, node, s.id, merged)
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
        if (code !== 'GATE_FAILED') throw err
        gateReport = err.message // 带最新清单回退整节修复
      }
    }
  }
  const repaired = stripFences(await complete(
    Content.sectionRepairPrompt(sectionPrompt(tpl, pack, s), first, gateReport),
    undefined, repairEffort,
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
    model: llmCfg.model,
    message: '排队等待生成…',
  })
  persistGenJobs()
  pumpGeneration(ctx)
  return { message: `「${node}」已入队，将在后台按序生成（进度见生成页）。`, queued: true }
}

/** 入队一个纯出题任务（#118 补生成任务化）：复用全局队列与 GenJob 记录（phase=quiz），
 * 与节点管线互斥（同节点已有 queued/running 任务一律 fail loud 拒绝——题库写互斥）。 */
function enqueueQuizGeneration(
  ctx: Context, course: string, node: string,
  opts?: { count?: number; section?: { id: string; title: string }; instruction?: string },
): { key: string; message: string; queued: boolean } {
  const key = `${course}/${node}`
  const existing = genJobs.get(key)
  if (existing && (existing.status === 'running' || existing.status === 'cancelling')) {
    throw new Error(`「${node}」已有生成任务进行中（${existing.phase === 'quiz' ? '出题' : '生成正文'}），请等它完成后再出题。`)
  }
  if (existing?.status === 'queued') {
    throw new Error(`「${node}」已在生成队列中，请等当前任务完成后再出题。`)
  }
  genJobs.set(key, {
    course, node, startedAt: new Date().toISOString(), status: 'queued', phase: 'quiz',
    ...(opts?.count !== undefined ? { count: opts.count } : {}),
    ...(opts?.section ? { section: opts.section } : {}),
    ...(opts?.instruction ? { instruction: opts.instruction } : {}),
    model: llmCfg.model,
    message: '排队等待出题…',
  })
  persistGenJobs()
  pumpGeneration(ctx)
  return { key, message: `「${node}」出题任务已入队，将在后台按序生成（进度见生成页）。`, queued: true }
}

/** 纯出题任务的完整结果（内存暂存，agent 工具等待完成后读取；不进持久化注册表）。 */
const quizJobResults = new Map<string, Awaited<ReturnType<LearnhubEngine['questionGenerate']>>>()

/** 等待一个出题任务到终态（agent 工具同步语义：入队 + 等完成 + 返回结果）。 */
function waitForQuizJob(key: string, timeoutMs = 15 * 60_000): Promise<GenJob> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = () => {
      const job = genJobs.get(key)
      if (!job) {
        reject(new Error('出题任务已从注册表消失（可能刚被清理），请重试。'))
        return
      }
      if (job.status === 'queued' || job.status === 'running' || job.status === 'cancelling') {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('等待出题任务超时——任务仍在后台执行，可稍后在生成页查看结果。'))
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
function scheduleJobRetention(key: string, status: GenJobStatus, delayMs?: number): void {
  const job = genJobs.get(key)
  if (job && isGenJobTerminal(status) && !job.finishedAt) {
    job.finishedAt = new Date().toISOString()
    persistGenJobs()
  }
  setTimeout(() => {
    const cur = genJobs.get(key)
    if (cur && cur.status !== 'running' && cur.status !== 'cancelling') genJobs.delete(key)
    persistGenJobs()
  }, delayMs ?? generationJobRetentionMs(status)).unref()
}

/** 注册表清扫（ADR-0039 写侧联动出口）：课程已删，或内容锚定任务的节点已删/改名 →
 * 记录悬空，唯一处置是清除（不做墓碑）；终态超保留期（finishedAt 起算）一并出册。
 * running 记录先置取消旗标再出册——runner 持同一对象，下个检查点中止，而落盘序列化
 * 取自 Map，已删条目的终态不会复活。存在性 = 注册表精确匹配 + 图节点名集；课程在而
 * 图读不动（Broken）按存在性未知保守保留。courseDelete、删/改名节点的各 apply 出口
 * 与重启恢复共用。返回清扫条数。 */
async function sweepGenJobs(now = Date.now()): Promise<number> {
  const perCourse = new Map<string, Promise<Set<string> | null | undefined>>()
  const nodeNamesOf = (course: string): Promise<Set<string> | null | undefined> => {
    let p = perCourse.get(course)
    if (!p) {
      p = (async (): Promise<Set<string> | null | undefined> => {
        try {
          const c = await engine.courseByKey(course)
          if (!c) return null
          return (await engine.loadView(c)).graph.nset
        } catch {
          return undefined
        }
      })()
      perCourse.set(course, p)
    }
    return p
  }
  let swept = 0
  for (const [key, j] of [...genJobs.entries()]) {
    const names = await nodeNamesOf(j.course)
    const verdict = genJobSweepVerdict(j, { courseMissing: names === null, nodeMissing: !!names && !names.has(j.node) }, now)
    if (verdict === 'keep') continue
    if (j.status === 'running') j.status = 'cancelling'
    genJobs.delete(key)
    swept++
  }
  if (swept) persistGenJobs()
  return swept
}

/** 生长批任务键（课程级任务，node 槽放「生长批」标签；队列 phase=生长，#145）。 */
const GROWTH_JOB_NODE = '生长批'

/** 入队一个生长批任务（#145）：教练回合裁决 → kind=edit 提案 → 同事务罗盘重写。
 * 阻尼防泵循环（否则「失败→排空→检查点→入队」立即成环）：同课已有生长批在途不重入；
 * 上一批失败/取消不自动重试——从生成页人工重试，或终态保留期（24h）过后自然恢复；
 * 上一批以 idle/no_structure 收尾也不重拉——教练停摆与「暂不产结构」都是裁决，
 * 重拉要等新的队列活动带来新内容。自动拉批只在队列空闲检查点接线（另两点=感知面）。
 * inject（#149）= 计划修订的换线/补支注入：显式的重新裁决请求，豁免 idle/no_structure
 * 阻尼（计划改了目标，上一次停摆裁决不再代表现状）；在途/失败阻尼照旧。
 * force（面板下发）= 同 inject 的显式豁免（学习者点了「生长一步」就是重新裁决的意图）；
 * 在途/失败阻尼照旧——在途防重入，失败走生成页重试。 */
function enqueueGrowthBatch(ctx: Context, course: string, why: string, inject?: string, opts: { force?: boolean } = {}): { message: string; queued: boolean } {
  const key = `${course}/${GROWTH_JOB_NODE}`
  const last = genJobs.get(key)
  if (last && (last.status === 'queued' || last.status === 'running' || last.status === 'cancelling')) {
    return { message: `「${course}」已有生长批任务在途，不重复入队。`, queued: false }
  }
  if (last && (last.status === 'failed' || last.status === 'cancelled')) {
    return { message: `「${course}」上一生长批${last.status === 'failed' ? '失败' : '已取消'}（${last.message ?? ''}），不自动重试——可从生成页重试或等下一次触发。`, queued: false }
  }
  if (!inject && opts.force !== true && last && last.status === 'done' && last.growthOutcome !== 'applied') {
    return { message: `「${course}」上一生长批裁决为 ${last.growthOutcome === 'idle' ? '停摆' : '暂不产结构'}，不重拉。`, queued: false }
  }
  genJobs.set(key, {
    course, node: GROWTH_JOB_NODE, startedAt: new Date().toISOString(), status: 'queued', phase: '生长',
    model: llmCfg.model, message: `排队等待教练回合（${why}）…`,
    ...(inject ? { growthInject: inject } : {}),
  })
  persistGenJobs()
  pumpGeneration(ctx)
  return { message: `「${course}」生长批已入队（${why}）。`, queued: true }
}

/** 计划修订驱动的生长批入队（#149）：apply 结果携带换线/补支触发时逐课程入队
 * （注入块随任务走）。 */
function triggerPlanGrowth(ctx: Context, result: { kind?: string; growth?: Array<{ course: string; lines: string[] }> }): void {
  if (result.kind !== 'project_plan' || !result.growth?.length) return
  for (const t of result.growth) {
    try {
      const r = enqueueGrowthBatch(ctx, t.course, '里程碑计划修订（换线/补支）', t.lines.join('\n'))
      void runLog('coach_growth', r.message).catch(() => undefined)
    } catch (err) {
      void runLog('coach_growth', `「${t.course}」计划修订生长批入队失败：${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined)
    }
  }
}

/** 教练回合触发统一出口（五点接线，词条「教练回合」）：就绪深度检查 → 低于前瞻的课程
 * 入队生长批（自动触点走阻尼；显式触点 force 豁免停摆/暂不产结构——显式重新裁决）→
 * 运行日志。触发点：node_complete / node_skip（各自路由）、session_start（节流）、
 * queue_idle（生成泵排空）、panel_dispatch（「生长一步」按钮直达入队，不走本函数的检查）。
 * 返回人读摘要（调用方留痕）。 */
async function coachTrigger(ctx: Context, trigger: CoachTrigger, courseKey?: string, opts: { force?: boolean } = {}): Promise<string> {
  const r = await engine.coachCheckpoint(trigger, courseKey)
  const lines: string[] = []
  for (const chk of r.courses) {
    lines.push(`${chk.course}：ready=${chk.ready}/${chk.required}${chk.ok ? '' : '（低于前瞻，已告警）'}`)
    if (chk.ok) continue
    try {
      const enq = enqueueGrowthBatch(ctx, chk.course, `${trigger} 触发（就绪深度 ${chk.ready}/${chk.required}）`, undefined, opts)
      lines.push(enq.message)
    } catch (err) {
      lines.push(`「${chk.course}」生长批入队失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const summary = lines.join('；')
  await runLog(`coach_checkpoint(${trigger})`, summary).catch(() => undefined)
  return summary
}

/** 会话开始检查点的节流窗（检查点是逐课程读侧 loadView，不能跟着 5s 轮询跑）。 */
const SESSION_START_THROTTLE_MS = 30 * 60_000
let lastSessionStartAt = 0

/** 教练触点的 fire-and-forget 包装（路由/状态入口侧）：失败只留运行日志，不挡原动作。 */
function coachTriggerDetached(ctx: Context, trigger: CoachTrigger, courseKey?: string, opts: { force?: boolean } = {}): void {
  void coachTrigger(ctx, trigger, courseKey, opts)
    .catch(err => runLog(`coach_checkpoint(${trigger})`, `调用失败：${err instanceof Error ? err.message : String(err)}`).catch(() => undefined))
}

/** 会话开始触点（节流 30 分钟）：面板打开（GET /status）与 agent 会话开工
 * （learnhub_status）共用入口，fire-and-forget——失败只留运行日志。 */
function sessionStartCheckpoint(ctx: Context): void {
  const now = Date.now()
  if (now - lastSessionStartAt < SESSION_START_THROTTLE_MS) return
  lastSessionStartAt = now
  coachTriggerDetached(ctx, 'session_start')
}

/** 图域任务入队（面板下发共用）：键 = course/node 标签；同键在途不重入，终态即覆盖
 * （单发起草，重按 = 重来）。返回消息给路由留痕。 */
function enqueueGraphJob(ctx: Context, j: { course: string; node: string; phase: GenJobPhase } & Partial<Pick<GenJob, 'seedPayload' | 'decompilePayload' | 'planPayload' | 'milestonePayload'>>): { message: string } {
  const key = `${j.course}/${j.node}`
  const last = genJobs.get(key)
  if (last && (last.status === 'queued' || last.status === 'running' || last.status === 'cancelling')) {
    return { message: `「${j.course}」${j.node}任务已在途，不重复入队。` }
  }
  genJobs.set(key, {
    course: j.course, node: j.node, startedAt: new Date().toISOString(),
    status: 'queued', phase: j.phase, model: llmCfg.model, message: '排队等待生成队列…',
    ...(j.seedPayload ? { seedPayload: j.seedPayload } : {}),
    ...(j.decompilePayload ? { decompilePayload: j.decompilePayload } : {}),
    ...(j.planPayload ? { planPayload: j.planPayload } : {}),
    ...(j.milestonePayload ? { milestonePayload: j.milestonePayload } : {}),
  })
  persistGenJobs()
  pumpGeneration(ctx)
  return { message: `「${j.course}」${j.node}已入队（生成队列 FIFO）。` }
}

/** 图域任务执行（面板下发）：种子/罗盘/反编译/计划/里程碑——引擎 LLM 方法一次受理，
 * 产物一律走提案人审通道（种子一次人审、反编译联合人审、计划 apply 带快照），任务
 * 只留受理摘要；失败落 failed 可从生成页重试。 */
async function generateGraphJob(ctx: Context, job: GenJob): Promise<void> {
  job.status = 'running'
  persistGenJobs()
  try {
    if (job.phase === '种子' && job.seedPayload) {
      job.message = '种子起草中（目标描述 → 模型）…'
      persistGenJobs()
      const r = await engine.seedPropose({
        course: job.course, goal: job.seedPayload.goal, mode: job.seedPayload.mode,
        goalType: job.seedPayload.goalType, useVaultPrior: job.seedPayload.useVaultPrior,
        worksheet: job.seedPayload.worksheet,
      }, llmSeam(ctx))
      job.status = 'done'
      job.message = `种子提案 #${r.id} 待人审：${r.starts} 起点 → 终点「${r.endpoint}」`
        + `${r.prior_hits ? `；先验命中 ${r.prior_hits}` : ''}${r.repaired ? '；修复轮一次' : ''}——提案页一次人审即开工`
    } else if (job.phase === '罗盘') {
      job.message = '罗盘初画中（deep 档一次调用）…'
      persistGenJobs()
      const r = await engine.compassPaint(job.course, llmSeam(ctx))
      job.status = 'done'
      job.message = `罗盘已重画：${r.route_lines} 条路线${r.annotations_preserved ? '（学习者批注原样保留）' : ''}`
    } else if (job.phase === '反编译' && job.decompilePayload) {
      job.message = '目标反编译中（计划 + 种子双提案）…'
      persistGenJobs()
      const p = job.decompilePayload
      const r = await engine.projectDecompile(p.project, {
        ...(p.goal ? { goal: p.goal } : {}),
        ...(p.course ? { course: p.course } : {}),
        ...(p.notes?.length ? { notes: p.notes } : {}),
      }, llmSeam(ctx))
      job.status = 'done'
      job.message = `反编译双提案待联合人审：计划 #${r.pair.plan}${r.pair.seed ? ` + 种子 #${r.pair.seed}` : ''}（先验命中 ${r.prior_hits}）——提案页同进同退`
    } else if (job.phase === '计划' && job.planPayload) {
      job.message = '里程碑计划草案生成中…'
      persistGenJobs()
      job.message = await generateProjectPlan(ctx, job.planPayload.project)
      job.status = 'done'
    } else if (job.phase === '里程碑' && job.milestonePayload) {
      job.message = '里程碑任务卡生成中…'
      persistGenJobs()
      job.message = await generateProjectMilestone(ctx, job.milestonePayload.project, job.milestonePayload.milestone)
      job.status = 'done'
    } else {
      throw new Error(`图域任务负载缺失或 phase 未知：${String(job.phase)}`)
    }
  } catch (err) {
    job.status = contentFailureStatus(job.status)
    job.message = err instanceof Error ? err.message : String(err)
  } finally {
    persistGenJobs()
    scheduleJobRetention(`${job.course}/${job.node}`, job.status)
    void runLog(`graph_job(${job.phase})`, `「${job.course}」${job.message}`).catch(() => undefined)
  }
}

/** 生长批任务执行（#145）：coachGrowthBatch 两段式回合 + 受理接线；应用成功后对
 * 「新建且正文未生成」的就绪缺口节点入队正文生成（生长-内容交替，永远 FIFO 不插队
 * ——生长批只在检查点之后入队，内容任务在它完成之后排队）。 */
async function generateGrowthJob(ctx: Context, job: GenJob): Promise<void> {
  const key = `${job.course}/${GROWTH_JOB_NODE}`
  job.status = 'running'
  job.message = '教练回合裁决中（轻量段）…'
  persistGenJobs()
  try {
    const r = await engine.coachGrowthBatch(job.course, llmSeam(ctx), job.growthInject ? { inject: job.growthInject } : {})
    if (r.state === 'idle') {
      job.growthOutcome = 'idle'
      job.status = 'done'
      job.message = `就绪深度满足（ready ${r.check.ready}/${r.check.required}）——教练停摆，无批可产。`
    } else {
      const p = r.proposal!
      const a = r.applied!
      job.growthOutcome = a.ops > 0 ? 'applied' : 'no_structure'
      job.status = 'done'
      const tierNote = r.segments
        .map(s => `${{ light: '轻', full: '全', arbitration: '双沙盘仲裁' }[s.tier] ?? s.tier}${s.disagreement ? '↑分歧升级' : ''}(${s.operator})`)
        .join('→')
      job.message = `生长批（${p.operator}）提案 #${p.id}${a.ops > 0 ? `：${a.ops} 条操作，快照 v${a.snapshot}` : '：零操作，裁决留痕'}`
        + `${a.compass_rewritten ? '；罗盘已同事务重写' : ''}｜${tierNote}｜理由：${p.reason}`
      // 受理批可含 del_node/rename（ADR-0039 写侧联动）：先清扫悬空任务记录再入队正文
      if (a.ops > 0) await sweepGenJobs()
      // 生长→内容链：新建节点里的就绪缺口入队正文生成（T2 同款理由口径）
      for (const node of a.ready_unbuilt) {
        try {
          enqueueGeneration(ctx, job.course, node)
        } catch { /* 同节点已在队列（去重），跳过 */ }
      }
      if (a.ready_unbuilt.length) job.message += `；正文生成已入队 ${a.ready_unbuilt.length} 节`
    }
  } catch (err) {
    job.status = contentFailureStatus(job.status)
    job.message = err instanceof Error ? err.message : String(err)
  } finally {
    persistGenJobs()
    scheduleJobRetention(key, job.status)
    void runLog('coach_growth', `「${job.course}」生长批：${job.message}`)
  }
}

/** 队列执行泵：空闲且未暂停时取队首排队任务跑管线；跑完（含失败）继续泵下一个。
 * phase=quiz 的纯出题任务走 generateQuizJob、phase=生长走 generateGrowthJob（#145）、
 * 图域任务（种子/罗盘/反编译/计划/里程碑）走 generateGraphJob（面板下发），其余按节点
 * 管线执行（#118）。 */
const GRAPH_JOB_PHASES: ReadonlySet<GenJobPhase> = new Set<GenJobPhase>(['种子', '罗盘', '反编译', '计划', '里程碑'])

function pumpGeneration(ctx: Context): void {
  if (genPumping || genQueuePaused) return
  const next = nextQueuedJob([...genJobs.values()])
  if (!next) return
  genPumping = true
  const task = next.phase === 'quiz'
    ? generateQuizJob(ctx, next)
    : next.phase === '生长'
      ? generateGrowthJob(ctx, next)
      : GRAPH_JOB_PHASES.has(next.phase)
        ? generateGraphJob(ctx, next)
        : generateContent(ctx, next.course, next.node, next.style)
  void task
    .catch(() => { /* 执行器已置 failed 留注册表可重试 */ })
    .finally(() => {
      genPumping = false
      // 队列空闲触发点（#144 → 五点接线）：生成队列排空 → 教练回合就绪深度检查，
      // 低于前瞻的课程随后入队生长批（#145：自动拉批只在检查点之后入队——FIFO 不插队，
      // 重拉阻尼见 enqueueGrowthBatch）。失败只留运行日志，不挡生成泵。
      if (!nextQueuedJob([...genJobs.values()])) {
        void coachTrigger(ctx, 'queue_idle')
          .then(() =>
            // 复诊结算钩子（#146）：队列空闲时自动结算到期插入边（零人审：proven｜
            // 自动剪除）；失败只留运行日志，不挡泵——到期未决由 data-check 提示类可见。
            engine.settleRechecks())
          .then(r => {
            if (!r) return
            let settledAny = false
            for (const c of r.courses) {
              if (!c.settled.length) continue
              settledAny = true
              runLog('probation_settle', `「${c.course}」复诊结算：${c.settled.map(s =>
                `${s.node}→${s.outcome}${s.metric ? `（${s.metric}）` : ''}`).join('；')}`)
                .catch(() => undefined)
            }
            // 复诊不达标自动剪除会删节点（无人审 del_node，ADR-0039 写侧联动）
            if (settledAny) return sweepGenJobs()
          })
          .catch(err => runLog('coach_checkpoint(queue_idle)', `调用失败：${err instanceof Error ? err.message : String(err)}`))
      }
      pumpGeneration(ctx)
    })
}

/** 纯出题任务执行（#118）：单次 questionGenerate（定向补节/指令/题量随任务携带），
 * 取消旗标逐题生效；终态与保留期与节点管线同语义。 */
async function generateQuizJob(ctx: Context, job: GenJob): Promise<void> {
  const key = `${job.course}/${job.node}`
  job.status = 'running'
  job.message = job.section
    ? `正在为节「${job.section.title}」定向补题…`
    : job.instruction
      ? '正在按学习者意见重出新题…'
      : '正在出题…'
  persistGenJobs()
  try {
    const r = await generateQuiz(llmSeam(ctx), job.course, job.node, job.count, {
      ...(job.section ? { section: job.section } : {}),
      ...(job.instruction ? { instruction: job.instruction } : {}),
      isCancelled: () => (job.status as GenJobStatus) === 'cancelling',
    })
    if ((job.status as GenJobStatus) === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
    quizJobResults.set(key, r)
    const dupNote = r.duplicates.length ? `；判重丢弃 ${r.duplicates.length} 道` : ''
    const rejNote = r.rejected.length ? `；无法归节拒收 ${r.rejected.length} 道` : ''
    job.status = 'done'
    job.message = `出题完成：新增 ${r.added} 道（题库共 ${r.total}）${dupNote}${rejNote}`
  } catch (err) {
    job.status = contentFailureStatus(job.status)
    job.message = err instanceof Error ? err.message : String(err)
  } finally {
    persistGenJobs()
    scheduleJobRetention(key, job.status)
    // 结果暂存（agent 工具读取用）随终态保留期一并清理
    setTimeout(() => quizJobResults.delete(key), generationJobRetentionMs(job.status)).unref()
  }
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
  const complete = llmSeam(ctx)
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
      // P4：高复杂度节点的大纲轮升 deep 档
      const outlineEffort = contentEffort(highTier)
      // 大纲护栏未过（OUTLINE_BUDGET）时重跑一次并回灌节数与预期区间，仍失败才置 failed
      let outlineYaml = stripFences(await complete(`${outlineTpl}\n\n---\n\n${pack}`, undefined, { effort: outlineEffort }))
      if (job.status === 'cancelling') throw new Error('生成已取消，结果已丢弃。')
      try {
        await engine.contentOutline(course, node, outlineYaml)
      } catch (err) {
        if (job.status === 'cancelling' || (err instanceof Error && (err as Error & { code?: string }).code !== 'OUTLINE_BUDGET')) throw err
        outlineYaml = stripFences(await complete(`${outlineTpl}\n\n---\n\n${pack}\n\n## 大纲护栏反馈\n\n上一次大纲未过护栏（节数与本节点复杂度不匹配）：\n${err instanceof Error ? err.message : String(err)}\n\n请按上下文包 §9 复杂度档案的节段数区间重新规划。`, undefined, { effort: outlineEffort }))
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
      await applySectionWithRepair(complete, course, node, s, sectionTpl, pack, { isCancelled: () => job.status === 'cancelling', highTier })
      job.progress = { done: job.progress!.done + 1, total: job.progress!.total }
      persistGenJobs()
    }
    return await finishWithQuiz(complete, job, `「${node}」正文完成（${job.progress!.total} 节）`)
  } catch (err) {
    job.status = contentFailureStatus(job.status)
    job.message = err instanceof Error ? err.message : String(err)
    persistGenJobs()
    throw err
  } finally {
    // 终态保留：失败/取消/部分完成留 24h 供排查与重试，成功留 30 分钟；之后清出注册表
    scheduleJobRetention(key, job.status)
  }
}

/** 管线收尾：逐节出题（每内容节按档位目标题量，绑节 id）+ 综合题（通用随档位），汇总任务终态。 */
async function finishWithQuiz(complete: LlmComplete, job: GenJob, contentMsg: string): Promise<string> {
  job.phase = 'quiz'
  job.message = `${contentMsg}；自动出题中…`
  persistGenJobs()
  try {
    const per = await engine.questionGenerateSections(job.course, job.node, async prompt => stripFences(await complete(prompt)))
    const quiz = await generateQuiz(complete, job.course, job.node, genericQuizTarget(tierIdxOf(job.tier)), { generic: true })
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
  const r = await applySectionWithRepair(llmSeam(ctx), course, node, s, sectionTpl, pack, { highTier })
  return `[section] 「${r.title}」v${r.version} 落盘。`
}

/** 项目里程碑计划生成（P 区 #92）：计划提示词包 → 模型 → 提案受理（人审后 apply 带快照生效）。 */
async function generateProjectPlan(ctx: Context, id: string): Promise<string> {
  const prompt = await engine.projectPlanPack(id)
  const yaml = stripFences(await llmSeam(ctx)(prompt, undefined, { effort: 'fast' }))
  const prop = await engine.projectPlanPropose(id, yaml)
  return `[project-plan] 提案 #${prop.id} 已受理（${prop.initial ? '初次规划' : '计划修订'}：${prop.milestones} 个里程碑）——人审后 learnhub_project_apply 生效（apply 带旧计划快照）。`
}

/** 项目里程碑产物生成：任务卡提示词包 → 模型 → 轻量结构门（未过回灌修复一轮）
 * → 首生直落 / 已生成自动转重生成提案（带快照，不静默覆盖）。 */
async function generateProjectMilestone(ctx: Context, id: string, milestoneId: string): Promise<string> {
  const complete = llmSeam(ctx)
  const prompt = await engine.projectMilestonePack(id, milestoneId)
  const write = (md: string) => engine.projectMilestoneWrite(id, milestoneId, md)
  let md = stripFences(await complete(prompt, undefined, { effort: 'fast' }))
  let out: Awaited<ReturnType<typeof write>>
  try {
    out = await write(md)
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    if (code !== 'MILESTONE_GATE_FAILED') throw err
    md = stripFences(await complete(
      Content.sectionRepairPrompt(prompt, md, err instanceof Error ? err.message : String(err)),
      undefined, { effort: 'deep' },
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
/** /learnhub/api/* 路由分发：客户端面板的全部后端入口（响应形状与 v2 一致）。 */
async function handleApi(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API.length)
  try {
    if (req.method === 'GET' && route === '/status') {
      // 模型透明：status 附带当前 LLM 配置（provider/model/思考档，面板只读展示）。
      // 会话开始触点（五点接线，30 分钟节流）：面板打开/轮询共用入口，fire-and-forget。
      sessionStartCheckpoint(ctx)
      sendJson(res, 200, await apiRun('api/status', async () => ({ ...(await engine.statusJson()), llm: llmView() })))
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
    if (req.method === 'GET' && route === '/probation') {
      // 插入实验面（#146）：在途插入节点（「实验中」标记取数）、到期未决、三率
      // （滚动 30 学习日）与韧性闸门现势；course 缺省 = 全部启用课程
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/probation', () => engine.probationStatus(course)))
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
    if (req.method === 'GET' && route === '/calibration/profile') {
      // 自评校准画像（ADR-0022 #104）：分源切片为主视图 + 全局参考视图（带域特异
      // 警戒）。practice 流水配对的只读派生——零落盘、零 canonical 写入。
      sendJson(res, 200, await apiRun('api/calibration/profile', () => engine.calibrationProfile()))
      return
    }
    if (req.method === 'GET' && route === '/calibration/hints') {
      // 过信轻提示全局开关（ADR-0022 #104）：缺省开，可全局关
      sendJson(res, 200, await apiRun('api/calibration/hints', () => engine.calibrationHintsConfig()))
      return
    }
    if (req.method === 'GET' && route === '/coach') {
      // 可用的困难教练（#65 E5）：只读信息性反馈，无触发为空数组
      sendJson(res, 200, await apiRun('api/coach', () => engine.coachAdvice()))
      return
    }
    if (req.method === 'GET' && route === '/sleep') {
      // D-4 睡眠耦合建议层开关（#85）：默认开
      sendJson(res, 200, await apiRun('api/sleep', () => engine.sleepAdviceConfig()))
      return
    }
    if (req.method === 'GET' && route === '/thermostat') {
      // D-2 挑战点恒温器（#111 ADR-0024）：跨区观测聚合 + 只读建议（非自动控制器）
      sendJson(res, 200, await apiRun('api/thermostat', () => engine.thermostatView()))
      return
    }
    if (req.method === 'GET' && route === '/experiments') {
      // D-1 N-of-1 实验（#110 ADR-0023）：模板库 + 实验清单 + 报告（无实验时 report=null）
      sendJson(res, 200, await apiRun('api/experiments', async () => {
        const experiments = await engine.experimentList()
        let report = null
        if (experiments.length) {
          try {
            report = await engine.experimentReport()
          } catch {
            report = null
          }
        }
        return { templates: await engine.experimentTemplates(), experiments, report }
      }))
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
    if (req.method === 'GET' && route === '/agent-guide') {
      // 能力指南：agent 独有工具的面板说明锚点（AGENT_GUIDE 单一事实源）
      sendJson(res, 200, AGENT_GUIDE)
      return
    }
    if (req.method === 'GET' && route === '/question-audit') {
      // 题库契约只读体检（ADR-0029/0030）：题库维护区消费
      sendJson(res, 200, await apiRun('api/question-audit', () => engine.questionAudit()))
      return
    }
    if (req.method === 'GET' && route === '/bank-cleanup') {
      // 题库一键清理预览（ADR-0032，只读）：跳过节点全部未归档题 + 已完成节点休眠题
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/bank-cleanup', () => engine.bankCleanupPreview(course)))
      return
    }
    if (req.method === 'GET' && route === '/learner-queue') {
      // 「我的卡」E 池队列（E1/#68）：到期在前、新卡随后，隔离自调度
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/learner-queue', () => engine.learnerQueue(course)))
      return
    }
    if (req.method === 'GET' && route === '/error-queue') {
      // 「错误对比卡」清单（C-3/#82）：到期在前、新卡随后（全卡面，管理/抽查用）
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun('api/error-queue', () => engine.errorCardQueue(course)))
      return
    }
    if (req.method === 'GET' && route === '/skills') {
      // 技能条目 lane（#89）：生效到期已折算维持节拍帽（读侧）
      sendJson(res, 200, await apiRun('api/skills', () => engine.skillList()))
      return
    }
    if (req.method === 'GET' && route === '/habits') {
      // 习惯（#90）：清单 + 宽容 streak + 自动化曲线摘要（只展示给学习者）
      sendJson(res, 200, await apiRun('api/habits', () => engine.habitList()))
      return
    }
    if (req.method === 'GET' && route === '/habit') {
      // 单个习惯详情（#90）：意图 + 完整自动化曲线 + 近期重复
      const habit = url.searchParams.get('habit')
      if (!habit) throw new Error('missing required field: habit')
      sendJson(res, 200, await apiRun('api/habit', () => engine.habitShow(habit)))
      return
    }
    if (req.method === 'GET' && route === '/projects') {
      // 项目清单（P 区 #92）：Project 是 Course 姊妹实体（面板尚无项目页签前的读面）
      sendJson(res, 200, await apiRun('api/projects', () => engine.projectList()))
      return
    }
    if (req.method === 'GET' && route === '/project/cross') {
      // 项目 2×2 交叉视图（P-7 #98）：面板核心视图（只读，含入档推荐）
      const id = url.searchParams.get('id')
      if (!id) throw new Error('missing required field: id')
      sendJson(res, 200, await apiRun('api/project/cross', () => engine.projectCrossView(id)))
      return
    }
    if (req.method === 'GET' && route === '/project/log') {
      // 项目日志读面（V-5 #113）：未写过 = null 合法空态
      const id = url.searchParams.get('id')
      if (!id) throw new Error('missing required field: id')
      sendJson(res, 200, await apiRun('api/project/log', () => engine.projectLog(id)))
      return
    }
    if (req.method === 'GET' && route === '/kata') {
      // 周复盘打开/发起（U-4 #114）：缺省 = 上一完整学习周；现状引擎现算重填，四问保留
      const week = url.searchParams.get('week_start') ?? undefined
      sendJson(res, 200, await apiRun('api/kata', () => engine.kataOpen(week)))
      return
    }
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (route === '/habits/create') {
        // 习惯创建（#90）：意图两字段（线索/行动）由引擎 fail loud 校验
        sendJson(res, 200, await apiRun('api/habits/create', () => engine.habitCreate({
          name: need(body, 'name'), cue: need(body, 'cue'), action: need(body, 'action'),
        })))
        return
      }
      if (route === '/habits/repeat') {
        // 自报重复（#90）：唯一计数来源，无门禁；可选自动化自评 1-5
        sendJson(res, 200, await apiRun('api/habits/repeat', () => engine.habitRepeat(need(body, 'habit'), {
          ...(typeof body.auto_rating === 'number' ? { auto_rating: body.auto_rating } : {}),
          ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note } : {}),
        })))
        return
      }
      if (route === '/habits/archive') {
        if (typeof body.archived !== 'boolean') throw new Error('missing required field: archived')
        sendJson(res, 200, await apiRun('api/habits/archive', () =>
          engine.habitArchive(need(body, 'habit'), body.archived)))
        return
      }
      if (route === '/skills/archive') {
        if (typeof body.archived !== 'boolean') throw new Error('missing required field: archived')
        sendJson(res, 200, await apiRun('api/skills/archive', () =>
          engine.skillArchive(need(body, 'skill'), body.archived)))
        return
      }
      if (route === '/skills/maintenance') {
        // 维持节拍帽（#89）：天数或 null（关闭）
        sendJson(res, 200, await apiRun('api/skills/maintenance', () =>
          engine.skillSetMaintenance(need(body, 'skill'), body.days ?? null)))
        return
      }
      if (route === '/rebuild') {
        sendJson(res, 200, { message: (await engine.rebuild()).message })
        return
      }
      if (route === '/node/skip') {
        // 跳过 = 显式重新裁决（词条「教练回合」五点之一）：force 豁免停摆/暂不产结构
        // 阻尼——跳过改了症状与路线，上一次停摆裁决不再代表现状；路由返回后 fire-and-forget
        const skipped = await apiRun('api/node/skip', () =>
          engine.nodeSkip(need(body, 'course'), need(body, 'node'), requireSkipDirection(body.skipped)))
        coachTriggerDetached(ctx, 'node_skip', need(body, 'course'), { force: true })
        sendJson(res, 200, skipped)
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
        // 完成 = 教练回合触发点之一（五点接线）：自动触点走阻尼；路由返回后 fire-and-forget
        const done = await apiRun('api/node/complete', () =>
          engine.nodeComplete(need(body, 'course'), need(body, 'node'), body.force === true))
        coachTriggerDetached(ctx, 'node_complete', need(body, 'course'))
        sendJson(res, 200, done)
        return
      }
      if (route === '/feedback') {
        sendJson(res, 200, { message: await engine.submitFeedback(VAULT, CENTER_REL, need(body, 'path')) })
        return
      }
      if (route === '/proposals/apply') {
        // 提案统一 apply（图谱域 edit/seed/enrich + 项目域 project_plan/project_milestone）：
        // kind 必须显式照抄提案记录，未知 kind 引擎报错；
        // 计划修订触发的换线/补支生长批随后入队（#149）
        const applied = await engine.proposalApply(need(body, 'kind'), applyId(body.id))
        // 编辑批可含 del_node/rename（ADR-0039 写侧联动）：apply 出口同步清扫注册表
        await sweepGenJobs()
        triggerPlanGrowth(ctx, applied as { kind?: string })
        sendJson(res, 200, applied)
        return
      }
      if (route === '/proposals/reject') {
        const id = rejectId(body.id)
        await engine.graphReject(id, typeof body.note === 'string' ? body.note.trim() : '')
        sendJson(res, 200, { message: `[reject] 提案 #${id} 已拒绝留痕。` })
        return
      }
      if (route === '/thermostat/apply') {
        // D-2 恒温器建议的逐条显式确认（#111 ADR-0024）：只受理当前清单内 id
        sendJson(res, 200, await apiRun('api/thermostat/apply', () =>
          engine.thermostatApply(need(body, 'suggestion'))))
        return
      }
      if (route === '/experiments/propose') {
        // D-1 实验提案（#110）：模板发起 → pending 提案
        const course = typeof body.course === 'string' && body.course.trim() ? body.course.trim() : undefined
        sendJson(res, 200, await apiRun('api/experiments/propose', () =>
          engine.experimentPropose(need(body, 'template'), course)))
        return
      }
      if (route === '/experiments/apply') {
        // D-1 实验确认开跑（#110 提案-确认制第二步）
        sendJson(res, 200, await apiRun('api/experiments/apply', () =>
          engine.experimentApply(applyId(body.id))))
        return
      }
      if (route === '/experiments/stop') {
        // D-1 实验手动停止（开停手动，ADR-0023）
        const id = body.id === undefined || body.id === null ? undefined : applyId(body.id)
        sendJson(res, 200, await apiRun('api/experiments/stop', () => engine.experimentStop(id)))
        return
      }
      if (route === '/sandbox/run') {
        // D-3 沙盘（#112 ADR-0025）：只读蒙特卡洛推演，零写侧
        const minutes = Number(body.minutes_per_day)
        if (!Number.isFinite(minutes)) throw new Error('missing required field: minutes_per_day')
        const weeks = body.weeks === undefined ? undefined : Number(body.weeks)
        const course = typeof body.course === 'string' && body.course.trim() ? body.course.trim() : undefined
        const nodes = Array.isArray(body.nodes) ? body.nodes.filter((n): n is string => typeof n === 'string') : undefined
        sendJson(res, 200, await apiRun('api/sandbox/run', () =>
          engine.sandboxRun({ minutesPerDay: minutes, ...(weeks !== undefined && Number.isFinite(weeks) ? { weeks } : {}), ...(course ? { course } : {}), ...(nodes?.length ? { nodes } : {}) })))
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
          llmSeam(ctx))))
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
      if (route === '/note-source/exclude') {
        // 用户排除清单（V-1 #86）：面板/agent 同一引擎通道；清单随 GET /note-sources 带出
        sendJson(res, 200, await apiRun('api/note-source/exclude', () =>
          engine.noteSourceExclude(need(body, 'path'))))
        return
      }
      if (route === '/note-source/unexclude') {
        sendJson(res, 200, await apiRun('api/note-source/unexclude', () =>
          engine.noteSourceUnexclude(need(body, 'path'))))
        return
      }
      if (route === '/note-source/relink') {
        // 漂移治理 relink（V-6 #109）：改名/移动后把既有源重连到新路径（卡池与调度保留）
        sendJson(res, 200, await apiRun('api/note-source/relink', () =>
          engine.noteSourceRelink(need(body, 'id'), need(body, 'path'))))
        return
      }
      if (route === '/note-source/generate') {
        // 笔记源出题（#59）：读笔记正文 → 笔记出题 prompt → validateBank 门禁落镜像
        sendJson(res, 200, await apiRun('api/note-source/generate', () => engine.noteSourceGenerate(
          need(body, 'id'), questionCount(body.count),
          async prompt => stripFences(await llmSeam(ctx)(prompt)))))
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
      if (route === '/error-answer') {
        // 「错误对比卡」作答（C-3/#82）：三选一自动判分，一卡一天一次，无绑定 XP
        sendJson(res, 200, await apiRun('api/error-answer', () => engine.errorCardAnswer(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), String(body.choice ?? ''))))
        return
      }
      if (route === '/error-generate') {
        // 「错误对比卡」生成（C-3/#82）：挖矿 → 模型出卡 → schema 门禁落盘
        sendJson(res, 200, await apiRun('api/error-generate', () => engine.errorCardGenerate(
          need(body, 'course'),
          {
            ...(typeof body.node === 'string' && body.node.trim() ? { node: body.node } : {}),
            ...(body.max !== undefined ? { max: Number(body.max) } : {}),
          },
          async prompt => stripFences(await llmSeam(ctx)(prompt)))))
        return
      }
      if (route === '/error-archive') {
        sendJson(res, 200, await apiRun('api/error-archive', () => engine.errorCardArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), Boolean(body.archived))))
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
          }, llmSeam(ctx))))
        return
      }
      if (route === '/learner-archive') {
        if (typeof body.archived !== 'boolean') throw new Error('missing required field: archived')
        sendJson(res, 200, await apiRun('api/learner-archive', () => engine.learnerCardArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), body.archived)))
        return
      }
      if (route === '/question-generate') {
        // 出题任务化（#118）：入队即返回（phase=quiz 走全局队列），可取消、重启可恢复、
        // 与节点管线互斥；section = 定向补节（#117，count 缺省 3），instruction = 学习者
        // 意见生成指令（#120 提意见重生成）。
        sendJson(res, 200, await apiRun('api/question-generate', async () => {
          const course = need(body, 'course')
          const node = need(body, 'node')
          const rawSection = body.section as { id?: unknown; title?: unknown } | undefined
          let section: { id: string; title: string } | undefined
          if (rawSection !== undefined) {
            if (typeof rawSection !== 'object' || rawSection === null
              || typeof rawSection.id !== 'string' || !rawSection.id.trim()
              || typeof rawSection.title !== 'string' || !rawSection.title.trim()) {
              throw new Error('[question-generate] section 必须是 { id, title }（节 id 与标题均非空字符串）。')
            }
            section = { id: rawSection.id.trim(), title: rawSection.title.trim() }
          }
          const instruction = typeof body.instruction === 'string' && body.instruction.trim()
            ? body.instruction.trim() : undefined
          return enqueueQuizGeneration(ctx, course, node, {
            // count 缺省由引擎按模式取（定向补节 3、整节点 6）；给出时只做合法值校验
            ...(body.count !== undefined ? { count: questionCount(body.count) } : {}),
            ...(section ? { section } : {}),
            ...(instruction ? { instruction } : {}),
          })
        }))
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
          llmSeam(ctx),
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
      if (route === '/question-dispute/review') {
        // 瑕疵题申诉复核（ADR-0031）：LLM 两阶段复核三态裁定，只读不落盘
        sendJson(res, 200, await apiRun('api/question-dispute/review', () => engine.questionDisputeReview(
          llmSeam(ctx),
          need(body, 'course'), need(body, 'node'), need(body, 'qid'))))
        return
      }
      if (route === '/question-dispute/apply') {
        // 申诉结算：rekey（改键重判可改判对）/ void（瑕疵题作废）/ overridden（强制豁免，不得分）
        sendJson(res, 200, await apiRun('api/question-dispute/apply', () => {
          const resolution = body.resolution
          if (resolution !== 'rekey' && resolution !== 'void' && resolution !== 'overridden') {
            throw new Error('missing/invalid required field: resolution（rekey|void|overridden）')
          }
          const rawRevision = body.revision as { answer?: unknown; explanation?: unknown } | undefined
          return engine.questionDisputeApply(
            need(body, 'course'), need(body, 'node'), need(body, 'qid'), resolution, {
              ...(typeof body.target_ts === 'string' ? { targetTs: body.target_ts } : {}),
              ...(typeof rawRevision === 'object' && rawRevision !== null
                ? { revision: { answer: rawRevision.answer, ...(typeof rawRevision.explanation === 'string' ? { explanation: rawRevision.explanation } : {}) } } : {}),
              ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
            })
        }))
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
        // reason = 归档原因（ADR-0032：too_easy=建议确认 / manual=人工等），可逆恢复时清除
        sendJson(res, 200, await engine.questionArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'),
          body.archived === true, typeof body.reason === 'string' ? body.reason : undefined))
        return
      }
      if (route === '/difficulty-advice-dismiss') {
        // B2 建议忽略/恢复：误判的持久忽略（undo 恢复单条，all 清空全部；
        // all=true 时 course/node/qid 均不需要）
        sendJson(res, 200, await apiRun('api/difficulty-advice-dismiss', () =>
          engine.adviceDismiss(
            typeof body.course === 'string' ? body.course : '',
            typeof body.node === 'string' ? body.node : '',
            typeof body.qid === 'string' ? body.qid : undefined,
            body.undo === true, body.all === true)))
        return
      }
      if (route === '/bank-cleanup/apply') {
        // 题库一键清理应用（ADR-0032）：按当前预览规则现算候选并归档（reason=cleanup，可逆）
        sendJson(res, 200, await apiRun('api/bank-cleanup/apply', () =>
          engine.bankCleanupApply(typeof body.course === 'string' ? body.course : undefined)))
        return
      }
      if (route === '/course/delete') {
        const r = await engine.courseDelete(need(body, 'course'))
        // 写侧联动（ADR-0039）：课程没了，注册表里它的任务记录（含排队/在途）随即出册
        await sweepGenJobs()
        sendJson(res, 200, r)
        return
      }
      if (route === '/generate/cancel') {
        sendJson(res, 200, cancelGeneration(need(body, 'course'), need(body, 'node')))
        return
      }
      if (route === '/coach/growth') {
        // 生长一步（面板下发 = 显式重新裁决，词条「生长批」）：即时入队、追加队尾、
        // 豁免停摆/暂不产结构阻尼；被拒时 message 带原因（在途/失败）。
        // 触发五点的检查点观测（读侧感知留运行日志）——入队本身不受检查结果闸：
        // 显式请求恒产一轮，就绪满足由教练回合停机转译为 idle。
        const growthCourse = need(body, 'course')
        void engine.coachCheckpoint('panel_dispatch', growthCourse)
          .then(r => runLog('coach_checkpoint(panel_dispatch)',
            r.courses.map(x => `${x.course}：ready=${x.ready}/${x.required}`).join('；')))
          .catch(() => undefined)
        sendJson(res, 200, await apiRun('api/coach/growth', async () =>
          enqueueGrowthBatch(ctx, growthCourse, '面板下发（显式重新裁决）', undefined, { force: true })))
        return
      }
      if (route === '/coach/compass') {
        // 罗盘初画/重画（#143 透明度装置）：LLM 一次调用进串行队列，不占请求
        sendJson(res, 200, await apiRun('api/coach/compass', async () =>
          enqueueGraphJob(ctx, { course: need(body, 'course'), node: '罗盘', phase: '罗盘' })))
        return
      }
      if (route === '/graph/backfill') {
        // 成分技能边回填（确定性推断，零 LLM）：同步受理，产物 = 富化提案待人审
        sendJson(res, 200, await apiRun('api/graph/backfill', () =>
          engine.graphEncBackfill(typeof body.course === 'string' && body.course.trim() ? body.course : undefined)))
        return
      }
      if (route === '/seed/propose') {
        // 建课/换终点起草（面板下发，phase=种子）：表单绑定字段随任务携带进引擎
        const seedCourse = need(body, 'course')
        const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
        if (!goal) throw new Error('missing required field: goal')
        const worksheet = Array.isArray(body.worksheet)
          ? body.worksheet
            .filter((w: unknown): w is { block?: unknown; note?: unknown } => typeof w === 'object' && w !== null)
            .map((w: { block?: unknown; note?: unknown }) => ({
              block: typeof w.block === 'string' ? w.block : '',
              ...(typeof w.note === 'string' && w.note.trim() ? { note: w.note } : {}),
            }))
            .filter(w => w.block.trim())
          : []
        sendJson(res, 200, await apiRun('api/seed/propose', async () =>
          enqueueGraphJob(ctx, {
            course: seedCourse, node: '种子起草', phase: '种子',
            seedPayload: {
              goal,
              mode: body.mode === 'reseed' ? 'reseed' : 'new',
              goalType: body.goalType === 'coverage' ? 'coverage' : 'capability',
              useVaultPrior: body.useVaultPrior === true,
              worksheet,
            },
          })))
        return
      }
      if (route === '/probation/settle') {
        // 复诊结算手动触发（#146 零人审自动行为的手动面，无确认步）：到期插入边
        // proven｜自动剪除
        sendJson(res, 200, await apiRun('api/probation/settle', () => engine.settleRechecks()))
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
        // 计划草案任务化（面板下发）：LLM 起草进串行队列，不占请求
        const project = need(body, 'id')
        sendJson(res, 200, await apiRun('api/project/plan/generate', async () =>
          enqueueGraphJob(ctx, { course: project, node: '计划草案', phase: '计划', planPayload: { project } })))
        return
      }
      if (route === '/project/milestone/generate') {
        // 里程碑任务卡任务化（面板下发）
        const project = need(body, 'id')
        const milestone = need(body, 'milestone')
        sendJson(res, 200, await apiRun('api/project/milestone/generate', async () =>
          enqueueGraphJob(ctx, {
            course: project, node: `里程碑草案(${milestone})`, phase: '里程碑',
            milestonePayload: { project, milestone },
          })))
        return
      }
      if (route === '/project/decompile') {
        // 目标反编译（P-5 #95）任务化（面板下发）：计划+种子双提案进串行队列，提案页联合人审；
        // goal/notes 透传给引擎（缺省读项目档案目标 + 全部注册笔记，契约与 agent 工具一致）
        const project = need(body, 'id')
        sendJson(res, 200, await apiRun('api/project/decompile', async () =>
          enqueueGraphJob(ctx, {
            course: project, node: '反编译', phase: '反编译',
            decompilePayload: {
              project,
              ...(typeof body.goal === 'string' && body.goal.trim() ? { goal: body.goal } : {}),
              ...(typeof body.course === 'string' && body.course.trim() ? { course: body.course.trim() } : {}),
              ...(Array.isArray(body.notes)
                ? { notes: body.notes.filter((n: unknown): n is string => typeof n === 'string' && !!n.trim()) }
                : {}),
            },
          })))
        return
      }
      if (route === '/project/exec') {
        // 项目执行事件落流（P-7 #98）：评级 1-4 + 来源；nodes = 本次行使的关联节点
        // （被行使 enc 边两端节点各回流一次练习证据）。零 XP、零调度写入。
        // evidence（auto 来源的可观测证据）与 nodes 原样透传——校验收口在门面
        // validateExecEvent/ratingFromEvidence（fail loud），路由不做静默变形。
        const evidence = typeof body.evidence === 'object' && body.evidence !== null
          ? body.evidence as Record<string, unknown>
          : undefined
        sendJson(res, 200, await apiRun('api/project/exec', () => engine.projectExecLog(need(body, 'id'), {
          source: need(body, 'source'),
          ...(typeof body.rating === 'number' ? { rating: body.rating } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
          ...(Array.isArray(body.nodes) ? { nodes: body.nodes } : {}),
          ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
        })))
        return
      }
      if (route === '/project/log') {
        // 项目日志追加（V-5 #113）：学习者自由条目，学习日归属引擎定
        sendJson(res, 200, await apiRun('api/project/log', () =>
          engine.projectLogAppend(need(body, 'id'), need(body, 'text'))))
        return
      }
      if (route === '/kata/save') {
        // 周复盘四问保存（U-4 #114）：patch 语义，现状引擎段不可写
        const answers = typeof body.answers === 'object' && body.answers !== null
          ? body.answers as Record<string, string> : {}
        sendJson(res, 200, await apiRun('api/kata/save', () =>
          engine.kataSave(need(body, 'week_start'), answers as never)))
        return
      }
      if (route === '/kata/convert/experiment') {
        // 「下一实验」一键转 N-of-1 提案（U-4↔D-1）
        const course = typeof body.course === 'string' && body.course.trim() ? body.course.trim() : undefined
        sendJson(res, 200, await apiRun('api/kata/convert/experiment', () =>
          engine.kataToExperiment(need(body, 'week_start'), need(body, 'template'), course)))
        return
      }
      if (route === '/kata/convert/intention') {
        // 「下一实验」一键转执行意图挂今日目标偏好（U-4↔C-5）
        sendJson(res, 200, await apiRun('api/kata/convert/intention', () =>
          engine.kataToIntention(need(body, 'week_start'), {
            course: need(body, 'course'), node: need(body, 'node'),
            cue: need(body, 'cue'), action: need(body, 'action'),
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
      if (route === '/calibration/hints') {
        // 过信轻提示全局开关（ADR-0022 #104）：显式布尔，缺省报错（fail loud）
        if (typeof body.hints_enabled !== 'boolean') throw new Error('missing required field: hints_enabled')
        sendJson(res, 200, await apiRun('api/calibration/hints', () => engine.setCalibrationHints(body.hints_enabled)))
        return
      }
      if (route === '/sleep') {
        // D-4 睡眠耦合建议层开关（#85）：enabled=false 全层静默
        sendJson(res, 200, await apiRun('api/sleep', () => engine.setSleepAdviceConfig({
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
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
  // 新鲜库出生盖戳（#138）：learnhub.json 与课程注册表都还不存在的全新 vault 直接
  // 盖 v2（免跑已退役的迁移脚本）；任何 v1 痕迹（两者之一在）都交版本硬门判定——
  // 盖戳只发生在真正的一无所有，不掩盖任何旧库。
  const freshConfigPath = `${center}/state/learnhub.json`
  if (!existsSync(freshConfigPath) && !existsSync(`${center}/课程注册表.yaml`)) {
    mkdirSync(`${center}/state`, { recursive: true })
    writeFileSync(freshConfigPath, JSON.stringify({ schema: { version: 2, formats: {} } }, null, 1) + '\n', 'utf8')
  }
  VAULT = vault
  engine = new LearnhubEngine({ vault, centerRel: CENTER_REL })

  // 生成任务注册表恢复：running/cancelling 随进程消失标失败；queued 保留但队列置为
  // 暂停（不自动开跑——重启后静默烧 token 是惊吓，生成页一键恢复）
  void engine.loadGenJobs().then(async stale => {
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
        // 纯出题任务参数随注册表持久化，恢复后按原样重跑/继续（#118）
        ...(typeof j.count === 'number' ? { count: j.count } : {}),
        ...(j.section && typeof j.section === 'object'
          && typeof (j.section as { id?: unknown }).id === 'string'
          && typeof (j.section as { title?: unknown }).title === 'string'
          ? { section: { id: (j.section as { id: string }).id, title: (j.section as { title: string }).title } } : {}),
        ...(typeof j.instruction === 'string' ? { instruction: j.instruction } : {}),
        ...(typeof j.model === 'string' ? { model: j.model } : {}),
        message: interrupted ? '进程重启，任务中断——可重试' : (typeof j.message === 'string' ? j.message : undefined),
        // 终态时刻随档恢复（保留期跨重启的起算点）；中断标失败的从恢复当下起算
        ...(interrupted
          ? { finishedAt: new Date().toISOString() }
          : (typeof j.finishedAt === 'string' ? { finishedAt: j.finishedAt } : {})),
      })
    }
    // 恢复清扫（ADR-0039）：内容已删的悬空记录清除（不做墓碑），终态超保留期一并出册
    // ——重启前挂的保留期定时器已随进程消失，跨重启只能靠时间戳在这里结算
    const swept = await sweepGenJobs()
    // 幸存终态按剩余保留期补挂定时器
    for (const [key, j] of genJobs) {
      if (!isGenJobTerminal(j.status)) continue
      scheduleJobRetention(key, j.status, genJobRetentionRemainingMs(j, Date.now()))
    }
    const aliveQueued = [...genJobs.values()].filter(j => j.status === 'queued').length
    if (aliveQueued > 0) genQueuePaused = true
    persistGenJobs()
    if (stale.length) {
      console.log(`[learnhub] gen-jobs restored: ${stale.length} (swept ${swept} dangling/expired${aliveQueued ? `, ${aliveQueued} queued paused` : ''})`)
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
    {}, () => run('learnhub_status', async () => {
      sessionStartCheckpoint(ctx) // 会话开始触点（agent 会话开工 = 同一面板打开语义，节流共用）
      return JSON.stringify({ ...(await engine.statusJson()), llm: llmView() })
    }))
  tool('learnhub_data_check',
    'Run a read-only Data Check across the registry, graph YAML, course notes/frontmatter, and question banks. Return JSON findings that distinguish Missing (legal absence) from Broken (present but invalid); it never repairs or writes vault data.',
    {}, () => run('learnhub_data_check', async () => JSON.stringify(await engine.dataCheck())))
  tool('learnhub_probation',
    'Insertion-edge probation (recheck) status and settlement, #146. action=status (default): per-course view of insertion edges under probation (nodes the panel marks 实验中/under experiment), overdue-but-undecided entries, the three throttle rates over the rolling 30 learning days (insertion rate / prune rate / recheck pass rate) and the resilience gate state (side-branch cap 20%→30% when resilient; insertion batches are rejected at the gate when the pass rate bottoms out). action=settle: run the settlement hook now — due entries are auto-adjudicated with zero human review: metric met → proven (insertion becomes permanent); not met → the engine proposes and auto-applies del_node with coarse-edge restoration (settleRechecks). Settlement also writes recheck_outcome / graph_repair events to the sediment canon.',
    { action: { type: 'string', enum: ['status', 'settle'], description: 'default status' }, course: { type: 'string', description: 'course name; default all enabled courses' } },
    (args: { action?: 'status' | 'settle'; course?: string }) => run('learnhub_probation', async () => {
      const a = (args ?? {}) as { action?: 'status' | 'settle'; course?: string }
      if (a.action === 'settle') return JSON.stringify(await engine.settleRechecks(a.course))
      return JSON.stringify(await engine.probationStatus(a.course))
    }))
  tool('learnhub_question_audit',
    'Read-only content audit of all question banks (course banks + note-source mirror). Flags legacy questions that violate current contracts: fill_in_blank answers that look numeric or algebraic (ADR-0029 unique-answer blanks), notation violations in stem/options/explanation (bare ^ or _ outside $...$, LaTeX commands without $ delimiters), YAML double-quote escape corruption (control characters), and over-long explanations. Returns a JSON findings list; never repairs or writes.',
    {}, () => run('learnhub_question_audit', async () => JSON.stringify(await engine.questionAudit())))
  tool('learnhub_skip',
    'Mark a node as skipped (learner already knows it) or un-skip. Skipped nodes count as passed: they leave the recommendation queue and no longer block successors. Skipping also archives every non-archived question of the node (reason=skip, ADR-0032) — reversible per question from the bank panel; un-skipping does NOT auto-restore them (restoring is the learner\'s explicit action).',
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
    'Get the dynamic cross-course recommendation queue as JSON: next events (review/learning/new/struggle/diagnostic/pin) ranked by priority (overdue reviews first by days overdue and retention decay, then half-finished lessons, then new lessons by unlock count and region rotation). Each event has type/course/node/score/why. Events the learner pinned as「今天学它」carry pinned=true and lead their course for today only (tomorrow they fall back to the default order); a pinned node with no other event appears as a standalone pin event — a not-ready pinned node keeps its soft-gate hint but stays openable. Events may carry an `advice` array of executable review suggestions {node, r, due, w?}: soft-gate advice on new lessons when a prerequisite\'s retention decayed below the R gate (review that prereq\'s due questions first — you may still learn the lesson directly), and remedial advice when a node keeps struggling (review its weighted component-skill ancestors first, ranked by w×(1−R); silent when the node has no enc edges or too few recent answers). Execute an advice item with learnhub_review_queue on {course, node: advice[].node}, then learnhub_question_answer. Events may also carry a `diagnostics` array (B1 content diagnostics, standalone events typed diagnostic): a section whose content keeps failing the learner (R1 single-question repeated lapses, or R2 answer accuracy <0.5 over ≥4 deduped answers since the section was last rewritten) with reason, evidence, and a rewrite direct action {course, node, section} — after the learner confirms, execute it with learnhub_section_rewrite (gated single-section rewrite; the question bank is untouched); the Arc D per-question explain entry lives in the panel\'s error state. Practice/interaction nodes (reconsolidation-typed, D-4) may appear as type:"sleep" events or carry a sleep field {text, rehearsal}: a「睡前练、醒后验」timing suggestion with an optional mental-rehearsal note (evidence-weighted wording) — surface it with the node, never treat it as a due change; the whole layer is switchable via learnhub_sleep_config. Fetch the next batch after finishing one.',
    { limit: { type: 'number', description: 'Max events to return (default 5)' } },
    (args: { limit?: number }) => run('learnhub_recommend', async () =>
      JSON.stringify(await engine.recommend(args.limit === undefined ? 5 : args.limit))))
  tool('learnhub_pin_today',
    'Pin a node as「今天学它」(E3 goal ownership): for TODAY only it is raised to the top of its course in learnhub_recommend with a「你选了它」marker and its normal reason — a read-side ordering overlay, never a gate; pinning a not-ready node keeps the prerequisite soft-gate hint and the node stays openable. Pins expire automatically tomorrow. Optionally mount an execution intention (C-5): pass cue AND action to attach an if-then plan「在【时间/地点锚】之后【单一具体行动】」— the format is locked to a stable cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence; Gollwitzer & Sheeran 2006). The intention rides the pinned recommend event and the panel, and expires with the pin. Learner Output: zero effect on scheduling, mastery, or XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must exist in the course graph)' },
      cue: { type: 'string', description: 'Execution-intention cue (stable time/place anchor, e.g. 早上刷完牙后) — required together with action' },
      action: { type: 'string', description: 'Execution-intention action (ONE concrete action, verb-first) — required together with cue' },
    },
    (args: { course: string; node: string; cue?: string; action?: string }) => run('learnhub_pin_today', async () =>
      JSON.stringify(await engine.pinToday(args.course, args.node, undefined, { cue: args.cue, action: args.action }))))
  tool('learnhub_goal_intention',
    'Set or clear an execution intention (C-5 if-then plan) on TODAY\'s「今天学它」pin for a node: pass cue AND action to write「在【时间/地点锚】之后【单一具体行动】」— format locked to a stable time/place cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence); pass neither to clear it. The intention lives on the pin (goal preference), covers the recommendation read side only, and expires with the pin tomorrow — it has no life of its own. Surface it from learnhub_recommend events (pinned events carry an intention {cue, action}). Fails loud if the node has no pin today. Learner Output: zero effect on scheduling, mastery, or XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must have a pin today)' },
      cue: { type: 'string', description: 'Execution-intention cue (stable time/place anchor) — omit cue AND action to clear' },
      action: { type: 'string', description: 'Execution-intention action (ONE concrete action, verb-first) — omit cue AND action to clear' },
    },
    (args: { course: string; node: string; cue?: string; action?: string }) => run('learnhub_goal_intention', async () =>
      JSON.stringify(await engine.setGoalIntention(args.course, args.node, { cue: args.cue, action: args.action }))))
  tool('learnhub_unpin',
    'Cancel a「今天学它」pin: the node returns to the default recommendation order immediately.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run('learnhub_unpin', async () =>
      JSON.stringify(await engine.unpinToday(args.course, args.node))))
  tool('learnhub_review_queue',
    'List the cross-course due review cards as JSON (Anki-style; answers omitted — answer with learnhub_question_answer, self-rate Hard/Good/Easy after correct replies). Omit filters for the whole queue: cards sort by predicted recall risk R ascending (r carried per card). Note-source cards (C1) ride the same queue with source:"note" and course=笔记源 (node = source id) — answer/rate/forget them through the SAME learnhub_question_answer / learnhub_question_rate / learnhub_question_forget calls; note_drifted (content changed — offer regenerate/archival) and note_suspended (missing source or broken mirror) summaries ride the response; suspended cards never block course cards. Pass course and/or node for TARGETED review — the direct entry that recommendation/status advice items point to (A3 soft-gate prerequisite review and enc component-skill remediation): {course, node} returns exactly that node\'s due questions. A single-node session is ADAPTIVELY ordered (A1 difficulty tuning): cards carry a combined difficulty scalar d and the response carries the node-mastery start band — present cards nearest that band first; during the session shift the band up one step after every second consecutive correct answer and drop it back toward the base after a wrong/forgot, re-picking the nearest-d remaining card each time. band_pref (E5) is the learner\'s explicit difficulty choice as a weighted preference on that start band: hard raises it, easy relaxes it, omit for pure A1 — the anti-frustration drop-back still applies. Cards flagged jol=true are the sampled JOL probe (E4): before revealing the answer you may ask the learner for a one-tap prediction (会/不会/没把握) and pass it back as the predicted field on learnhub_question_answer / learnhub_question_forget — skippable, never blocking. A `calibration_hint` string riding the response (Self-Calibration, ADR-0022) means the learner\'s「会」predictions have run systematically low on actual accuracy: surface it verbatim next to the JOL probe as a gentle, non-blocking expectation-management nudge — never turn it into a score or a gate (the learner can disable it globally). Unknown node names fail loud.',
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
  tool('learnhub_calibration_profile',
    'Get the Self-Calibration profile (ADR-0022, #104) as JSON: per-source slices of learner self-assessment × objective outcome pairs (v1 source "jol" = JOL prediction × actual answer; more sources land via the pairing contract). Each source carries calibration bins (per-prediction actual accuracy, shown only at >=10 sampled pairs — below the gate it is null, never fabricated) and an overconfidence verdict with evidence (the「会」bin\'s n / actual accuracy / threshold). `global` merges sources as a REFERENCE view only — domain-specific components are significant, so always present it together with its warning and treat the per-source slices as authoritative. When a source is overconfident and hints are enabled, review-queue responses ride a `calibration_hint` string: surface it verbatim at the self-assessment exit as a gentle nudge (see learnhub_review_queue); JOL probe density is then boosted (1/3 → 1/2) automatically. Read-only derivation: this NEVER discounts learner self-assessment driving canonical state — FSRS ratings pass through untouched and nothing feeds Mastery/XP. Never present it as a personality trait or a score.',
    {},
    () => run('learnhub_calibration_profile', async () => JSON.stringify(await engine.calibrationProfile())))
  tool('learnhub_sleep_config',
    'Get or set the sleep-coupled scheduling advice layer (D-4). When enabled (default), recommendations for reconsolidation-type nodes (practice/interaction nodes, e.g. instrument or sport practice) carry a「睡前练、醒后验」timing suggestion — practice briefly before sleep, verify retention right after waking (Walker 2002/2005) — plus an optional mental-rehearsal note (small effect r≈0.13, expectation-managed wording). Read-side advice only: it never changes scheduling semantics, due dates, mastery, or XP. Omit enabled to read the current config.',
    { enabled: { type: 'boolean', description: 'true/false to turn the sleep advice layer on/off; omit to read current config' } },
    (args: { enabled?: boolean }) => run('learnhub_sleep_config', async () =>
      JSON.stringify(args.enabled === undefined
        ? await engine.sleepAdviceConfig()
        : await engine.setSleepAdviceConfig({ enabled: args.enabled }))))
  tool('learnhub_experiment_templates',
    'List the N-of-1 experiment template library (D-1, ADR-0023): preset self-experiments on engine-controlled content/design parameters only (scheduling core is NEVER an experiment variable). Each template carries id/title/question/arms/unit/description and an unlocked flag — unlocked=false templates are visible but cannot be started yet. Zero XP, never touches Mastery; arm labels go into the review log for attribution. Propose with learnhub_experiment_propose, the learner confirms, then learnhub_experiment_apply.',
    {}, () => run('learnhub_experiment_templates', async () =>
      JSON.stringify(await engine.experimentTemplates())))
  tool('learnhub_experiment_propose',
    'Propose an N-of-1 experiment from a preset template (D-1, proposal-confirmation flow, step 1): validates the template is unlocked and no experiment is running (v1 runs one at a time), previews the eligible card pool (scheduled, non-archived bank questions), and files a pending experiment proposal for the learner to confirm. Whitelist enforcement is structural: only template ids resolve; unknown ids and non-whitelist parameters fail loud. Never starts anything by itself.',
    {
      template: { type: 'string', required: true, description: 'Template id from learnhub_experiment_templates' },
      course: { type: 'string', description: 'Scope the experiment to one course; omit for all enabled courses' },
    },
    (args: { template: string; course?: string }) => run('learnhub_experiment_propose', async () =>
      JSON.stringify(await engine.experimentPropose(args.template, args.course))))
  tool('learnhub_experiment_apply',
    'Confirm and start a pending N-of-1 experiment proposal (D-1, proposal-confirmation flow, step 2): re-validates the artifact against the template whitelist, builds the assignment (batch templates alternate arms by learning day starting today; card-level templates get a seeded deterministic split), writes the experiment definition, and reports today\'s arm. Fails loud if another experiment is already running or the artifact fails re-validation.',
    { id: { type: 'number', description: 'Proposal id; omit for the newest pending experiment proposal' } },
    (args: { id?: number }) => run('learnhub_experiment_apply', async () =>
      JSON.stringify(await engine.experimentApply(applyId(args.id)))))
  tool('learnhub_experiment_stop',
    'Stop a running N-of-1 experiment (start/stop is always manual, ADR-0023): annotations cease, the report becomes final. Omit id to stop the currently running experiment.',
    { id: { type: 'number', description: 'Experiment id; omit for the running one' } },
    (args: { id?: number }) => run('learnhub_experiment_stop', async () =>
      JSON.stringify(await engine.experimentStop(args.id))))
  tool('learnhub_experiment_report',
    'Get the plain-language N-of-1 report (D-1, ADR-0023): arm-by-arm true retention, arm difference, 95% bootstrap interval, and a permutation test — phrased as an individual effect, never a population claim. Below the minimum observation window (per-arm real-advance minimum) it reports progress only and refuses to judge. running = interim reading; stopped = final.',
    { id: { type: 'number', description: 'Experiment id; omit for the running (or latest) one' } },
    (args: { id?: number }) => run('learnhub_experiment_report', async () =>
      JSON.stringify(await engine.experimentReport(args.id))))
  tool('learnhub_kata_open',
    'Open the Weekly Kata (U-4, ADR-0026 — the global once-per-week five-question debrief where the bounded area [course overview + one section per active project] meets the unbounded area [habits + skill entries]): the review target is the LAST COMPLETE learning week (calendar week folded by learning days; early-morning sessions roll back over the day cutoff). The「现状」section is auto-filled by the engine from that week\'s REAL data (XP, answers/accuracy, true retention, per-project milestone passes and exec events, habit repeats, skill executions, note-source reviews with [[links]] back to the personal notes); the other four questions (目标条件/障碍/下一实验/预期所学) are the LEARNER\'S to answer — ask them, never answer for them. The record lands in 学习中心/我的产出/周复盘/<Monday>.md (V-3 output zone; registrable as a Note Source). Learner Output domain: zero XP, no Mastery, no FSRS card, zero canonical writes; no reminders, missing a week is never penalized.',
    { week_start: { type: 'string', description: 'Monday YYYY-MM-DD of the week to review; omit for the most recent complete week' } },
    (args: { week_start?: string }) => run('learnhub_kata_open', async () =>
      JSON.stringify(await engine.kataOpen(args.week_start))))
  tool('learnhub_kata_save',
    'Save the learner\'s answers to the four learner questions of a Weekly Kata record (现状 is engine-owned and cannot be written here — facts come from behavior). Patch semantics: only provided keys are written; empty string resets a question to unanswered. Use this after the learner answers out loud, or point them at the panel/obsidian file to write directly.',
    {
      week_start: { type: 'string', required: true, description: 'Monday YYYY-MM-DD of the record' },
      answers: { type: 'object', additionalProperties: true, required: true, description: 'Partial map: 目标条件/障碍/下一实验/预期所学 → learner\'s own words' },
    },
    (args: { week_start: string; answers: Record<string, string> }) => run('learnhub_kata_save', async () =>
      JSON.stringify(await engine.kataSave(args.week_start, args.answers as never))))
  tool('learnhub_kata_convert_experiment',
    'One-click exit from the Kata\'s「下一实验」to an N-of-1 experiment proposal (U-4↔D-1 interface): files the SAME proposal-confirm flow as learnhub_experiment_propose (nothing starts by itself) and stamps the proposal number into the Kata record. Requires the week\'s record to exist (learnhub_kata_open first).',
    {
      week_start: { type: 'string', required: true, description: 'Monday YYYY-MM-DD of the record' },
      template: { type: 'string', required: true, description: 'Template id from learnhub_experiment_templates' },
      course: { type: 'string', description: 'Scope to one course; omit for all enabled courses' },
    },
    (args: { week_start: string; template: string; course?: string }) => run('learnhub_kata_convert_experiment', async () =>
      JSON.stringify(await engine.kataToExperiment(args.week_start, args.template, args.course))))
  tool('learnhub_kata_convert_intention',
    'One-click exit from the Kata\'s「下一实验」to an Execution Intention pinned to TODAY\'S goal preference (U-4↔C-5 interface): pins the chosen node to the top of today\'s recommendations carrying the if-then plan (cue = stable time/place anchor, action = ONE concrete act; format is locked and validated) and stamps the record. The pin expires with the day — the intention lives on today\'s read-side only.',
    {
      week_start: { type: 'string', required: true, description: 'Monday YYYY-MM-DD of the record' },
      course: { type: 'string', required: true, description: 'Course name of the target node' },
      node: { type: 'string', required: true, description: 'Node to pin today' },
      cue: { type: 'string', required: true, description: 'Stable cue (time/place anchor), e.g. 早上刷完牙后' },
      action: { type: 'string', required: true, description: 'Single concrete action, e.g. 做 5 道到期复习' },
    },
    (args: { week_start: string; course: string; node: string; cue: string; action: string }) => run('learnhub_kata_convert_intention', async () =>
      JSON.stringify(await engine.kataToIntention(args.week_start,
        { course: args.course, node: args.node, cue: args.cue, action: args.action }))))
  tool('learnhub_thermostat',
    'Get the challenge-point thermostat dashboard (D-2, ADR-0024): cross-region observation aggregate + READ-ONLY suggestions — the thermostat is NOT an auto-controller. Course region: true-retention band + long-term difficulty-band choice distribution. Unbounded region: execution-event rating distribution (empty until the U-area execution channel lands). Project region: deferred to P-7, tier list only. Three knobs max (A1 target difficulty-band default, retrieval-point density [not yet available], fading-tier move aggregation); at most three suggestions, low-data-silent. To ACT on a suggestion, show it to the learner and after their explicit confirmation call learnhub_thermostat_apply with the suggestion id — never apply without confirmation; there is no engine-side auto adjustment.',
    {},
    () => run('learnhub_thermostat', async () => JSON.stringify(await engine.thermostatView())))
  tool('learnhub_thermostat_apply',
    'Apply ONE thermostat suggestion AFTER the learner explicitly confirms it (D-2, ADR-0024): only ids currently offered by learnhub_thermostat are accepted (stale or invented ids fail loud) — this is the single confirmation gate. Confirmed band-default suggestions write the A1 default difficulty band via the existing config entry; the learner\'s explicit per-session band choice still overrides it.',
    { suggestion: { type: 'string', required: true, description: 'Suggestion id exactly as offered by learnhub_thermostat (e.g. band_default:standard)' } },
    (args: { suggestion: string }) => run('learnhub_thermostat_apply', async () =>
      JSON.stringify(await engine.thermostatApply(args.suggestion))))
  tool('learnhub_sandbox',
    'Run the plan sandbox (D-3, ADR-0025): Monte-Carlo projection of the learner\'s study plan using the SAME FSRS+mastery models as the scheduler (~200 seeded runs). Input = daily minutes goal x horizon in weeks (default 6) x intended course/nodes. Output = end-of-horizon mastery map (per node p50/p80) + total-mastery curve with 50/80 percentile bands + the honest assumption list (1 min per review, practice evidence frozen, new nodes introduced in course order). READ-ONLY: zero canonical writes, no gating, no scheduling side effects. The wording is locked to「模型推演，非承诺」— present the distribution as a distribution, never as a promise, and never as a feasibility verdict; the learner negotiates their own plan with it.',
    {
      minutes_per_day: { type: 'number', required: true, description: 'Daily learning-minutes goal of the plan' },
      weeks: { type: 'number', description: 'Horizon in weeks (default 6, max 26)' },
      course: { type: 'string', description: 'Scope to one course; omit for all enabled courses' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Intended node subset; omit for whole course(s)' },
    },
    (args: { minutes_per_day: number; weeks?: number; course?: string; nodes?: string[] }) =>
      run('learnhub_sandbox', async () =>
        JSON.stringify(await engine.sandboxRun({
          minutesPerDay: args.minutes_per_day, weeks: args.weeks, course: args.course, nodes: args.nodes,
        }))))
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
    'Analyze a course knowledge graph: structural stats, unreachable nodes, bottlenecks, lapse hotspots, graph health score (0-100, see health), next-batch suggestions (suggestions.expand_blocks/missing_pre/unconverged, plus jump_candidates + jump_total — cognitive-jump edges needing a verdict each — and merge_blocks), the full per-node schema (schema: pre/enc/est/bloom/difficulty/note per node — the data basis for edge-level self-checks), plus cytoscape render elements. Returns JSON. Run before planning each batch of graph edits; the next-batch plan must cite concrete entries from health/suggestions.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      elementsOnly: { type: 'boolean', description: 'Only output cytoscape render elements (nodes/edges)' },
    },
    (args: { course?: string; elementsOnly?: boolean }) => run('learnhub_graph_analyze', async () =>
      JSON.stringify(await engine.graphAnalyze(args.course, args.elementsOnly))))
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

    'Submit a graph proposal. Schema quick reference — write YAML strictly to this, wrong key names are rejected. kind=seed (#142) is the NEW-COURSE ENTRY: 1-3 start nodes + one endpoint node — starts must be SINGLE-BEHAVIOR units a zero-basis learner can step onto from common knowledge, with ZERO compound/blanket concepts (「Python 基础语法」-style blanket names fail as starts; compound content belongs to the growth path, ADR-0040); the engine lands coarse placeholder edges (endpoint.pre = starts), one human review then the course starts. Seed nodes carry ZERO enc and ZERO est (rejected if declared); goal_type defaults to capability (completion = endpoint mastery + closure health) — coverage must be explicit AND carry a non-empty worksheet list ({block, note?, done?}; capability+worksheet is rejected). mode=new requires the course NOT be registered (the engine scaffolds the registry entry + dirs on apply); mode=reseed requires it — endpoint change / worksheet update of an existing course, the ONLY anchor-edit channel (no direct anchor writes; the endpoint-anchored node is also guarded: del_node/rename via kind=edit are rejected). Start entries may declare basis: baseline (common knowledge start) / vault (prior familiarity boundary) / project (decompiled cluster; goal decompilation #149 stamps it automatically on the starts it files). Seed node keys: name/region/block/note?/bloom?/difficulty?/teaches?/assumes?/misconceptions?. kind=edit (per batch) top-level keys: course; reason?; concepts? ([{canonical, aliases?, definition?}] — concept-registry minting block, #141: names land in 课程根/概念登记表.yaml with the SAME apply transaction, nothing written while the proposal is pending/rejected); ops[] — add_node defines a new node via key `name` (unified with graph YAML in schema v2; the old `node` key is rejected): add_node{name, region, block, pre, est? (minutes, positive), bloom? (记忆/理解/应用/分析/评价/创造), difficulty? (1-5), type?: practice, note?, enc?, teaches? ({concept: 知道|会用|能教}, 1-8), assumes? ({concept: tier}, 3-10 when present), misconceptions? ([{concept, model}], ≤3 per concept course-wide)}; every other op targets an existing node via key `node`: set_pre{node, pre} replaces the whole pre set (pre is required, [] to clear); set_enc{node, enc} replaces the whole enc list ([skill] or [{node, w, note}]; enc is required, [] to clear); del_node{node}; rename{node, new}; move{node, region, block}; set_note{node, note}. Generation-time discipline the gates cannot check (ADR-0040): each add_node is ONE independent learning act — self-question whether a zero-basis learner could pick it up from its pre within 30 minutes, else split or add a prerequisite first; most names are action sentences (解/求/推导…, no「理解导数」-style level-unclear near-duplicates, no blanket compounds); pre is the COMPLETE direct-prerequisite set (no transitive padding); give every new pre edge a necessity verdict (delete-the-edge test: no concrete failure point = redundant, drop it). Edge-light rule: graph YAML carries ZERO edge metadata — candidate edges stay in the proposal, insertion origin derives from the proposal journal, probation lives in state/边实验.jsonl (fields like origin/status/probation are rejected). Growth-batch note region (#145/#146): note{operator: 前进|插入|巩固|旁支|换向, reason, disagreement?, recheck?} marks the batch as a coach-round verdict; an insertion batch (operator=插入 with add_node ops) MUST preregister its recheck — note.recheck{metric: 前进恢复|卡点集中度降幅|保留率恢复 (exactly one, same source as the symptom), days? (learning days, default 10, clamped to [5,20] with a warn)} — the engine auto-adjudicates at expiry (proven, or auto-prune via del_node + coarse-edge restore, zero human review); recheck on non-insertion batches is rejected, and insertion batches are gate-throttled when the recheck pass rate bottoms out or the insertion/side-branch share exceeds its cap. Batch `pre` may only reference existing nodes or nodes created earlier in the same batch. Concept-reference gate (#141): every concept named in teaches/assumes/misconceptions must be registered in the course concept registry (canonical or alias, exact match) OR minted in the same proposal\'s concepts block — unregistered names are rejected with the missing list; minting a name that already exists is rejected too (reference the entry, or merge via learnhub_concept_merge after human confirmation). Prior feed (#142): vault-link candidates with w≥0.7 mapped to the proposal\'s nodes that the structure does NOT explicitly answer (no pre/enc edge between the pair) come back in warns (non-blocking) — answer them with real edges, or let a vault rescan drop them; zero priors is a legal normal path. Keep pre-edge cognitive jumps (difficulty gap >= 2 or depth span >= 3) off the graph or expect R13 jump-candidate warnings. Schema + structure gates reject bad YAML with actionable errors (including dangling enc edges and misconception cap breaches). In growth batches apply edit proposals immediately after gates pass (anchor-review model, ADR-0003); seed proposals wait for the one human review.',

    {
      kind: { type: 'string', required: true, description: '"seed" (new-course entry or endpoint change — one human review) or "edit" (change ops) or "enrich" (overlay backfill)' },
      yaml: { type: 'string', required: true, description: 'Full proposal YAML text (SeedProposal / EditProposal / EnrichProposal schema)' },
    },
    (args: { kind: string; yaml: string }) => run('learnhub_graph_propose', async () =>
      JSON.stringify(await engine.graphPropose(graphKind(args.kind), args.yaml))))
  tool('learnhub_graph_proposals',
    'List graph proposals by status — use status=pending to see what awaits human review in the panel, with the proposal id, course, reason, and op summary. After the user decides in the panel, apply with learnhub_graph_apply using that id.',
    {
      status: { type: 'string', description: 'Filter by status (default pending; e.g. applied/rejected)' },
      kind: { type: 'string', description: 'Filter by kind: edit / seed / enrich / project_plan / project_milestone / experiment' },
    },
    (args: { status?: string; kind?: string }) => run('learnhub_graph_proposals', async () =>
      JSON.stringify(await engine.graphProposals(args.status, args.kind))))
  tool('learnhub_graph_enc_backfill',
    'Backfill enc (component-skill) edges for a course via the enrichment-overlay channel (#140, weight semantics #148): every non-practice node with ready content whose note body / exercise metadata declares enc_candidates or whose bank questions invoke prereq-taught concepts (invokes-coverage projection) that are not yet declared as enc becomes one field entry (whole-replace enc). Weights = the invokes-coverage projection (share of the node\'s questions invoking concepts taught by that prereq; candidate edges without invokes data land the schema-default weight 1 — the old call-site ladder is retired). Queued as a SINGLE pending enrich proposal with sha256 fingerprints of the canonical region files. Nothing changed returns ops=0. Re-runnable — already-covered nodes produce no entries; practice nodes keep legal empty enc. Use for the A3 pilot when enabling that course, then review/apply with learnhub_graph_apply(kind=enrich).',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run('learnhub_graph_enc_backfill', async () =>
      JSON.stringify(await engine.graphEncBackfill(args.course))))
  tool('learnhub_vault_links_scan',
    'Scan the WHOLE vault (outside the learning center; dot-dirs, built-in attachment/archive dirs 99附件/05ob自定义/00类型/03属性/过时*, and the user note-source exclusion list skipped — the built-in list can be replaced via vault_link_excludes in learnhub.json) for [[wikilinks]] between personal notes and produce de-noised UNDIRECTED association pairs with confidence w∈[0,1] (enc-edge weight convention): embeds ![[…]], non-.md targets (.base/.png/…), diary date targets, unresolved targets, self-links and code-fence examples are filtered, each with a hit-count audit (nothing silently dropped). READ-ONLY on personal notes — the cache lands in the engine state dir (state/vault链接.json with per-file fingerprints for drift/rescan); pure file scanning, no host search API. Pair confidence tiers: w≥0.7 proposal-ready (learnhub_graph_link_backfill), 0.4–0.7 shown in learnhub_graph_analyze suggestions.vault_link_candidates for human adjudication, <0.4 report-only. Run before graph analysis to surface vault link priors.',
    {},
    () => run('learnhub_vault_links_scan', async () =>
      JSON.stringify(await engine.vaultLinksScan())))
  tool('learnhub_graph_link_backfill',
    'Turn vault link priors into enc candidate edges (V-2 #91) via the enrichment-overlay channel (#140): mapped pairs with w ≥ 0.7 whose direction resolves INSIDE the pre-transitive-closure become field entries (whole-replace enc; declared enc preserved, new edges noted with the source link evidence for traceability), queued as a SINGLE pending enrich proposal per course with sha256 fingerprints of the canonical region files. Pairs without a pre relation are NOT forced (enc contract/E7: enc target must sit in the holder\'s prereq closure) — they come back as blocked_no_pre with a why, for you to add pre edges explicitly or drop. Re-runnable; already-declared edges are skipped. Requires learnhub_vault_links_scan to have run (fails loud with a pointer otherwise). Review/apply with learnhub_graph_apply(kind=enrich).',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run('learnhub_graph_link_backfill', async () =>
      JSON.stringify(await engine.graphLinkBackfill(args.course))))
  tool('learnhub_graph_apply',
    'Decide a pending graph proposal: apply (audit-gated, writes data/*.yaml with rename linkage + journal + snapshot; kind=enrich re-checks the sha256 content fingerprints and refuses stale proposals; kind=seed lands the endpoint anchor state/终点锚.json + start/endpoint nodes with coarse placeholder edges, seed graphs get the shape-warning & health-threshold exemption) or reject (kept on record). Seed proposals (kind=seed) are the new-course entry and the ONLY endpoint-change channel — they always wait for the one human review. In edit batches the agent applies directly after gates pass; revision changes wait for human review first (ADR-0003). The apply result carries findings: audit warns plus a health-score hint when below the quality baseline (suppressed while the graph is still just the seed) — address them in the next batch.',
    {
      kind: { type: 'string', required: true, description: '"seed" (course entry / endpoint change) or "edit" (change ops) or "enrich" (overlay backfill)' },
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
        const r = await engine.graphApply(graphKind(args.kind), applyId(args.id))
        // 编辑批可含 del_node/rename（ADR-0039 写侧联动）：apply 出口同步清扫注册表
        await sweepGenJobs()
        return JSON.stringify(r)
      }))
  tool('learnhub_concept_merge',
    'Merge one concept-registry entry into another (概念登记表 #141, human-decision surface): the absorbed entry disappears and ALL of its names (canonical + aliases) become aliases of the surviving entry, so every historical address keeps resolving — entries are never deleted, only merged. Use when the same concept was minted twice under different names (same meaning, confirmed by the learner); deepening a concept to a higher tier REUSES the same entry and is NOT a merge. Journal-tracked; the registry file is 课程根/概念登记表.yaml.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      from: { type: 'string', required: true, description: 'Name (canonical or alias) of the entry to absorb' },
      into: { type: 'string', required: true, description: 'Name (canonical or alias) of the surviving entry' },
    },
    (args: { course: string; from: string; into: string }) => run('learnhub_concept_merge', async () =>
      JSON.stringify(await engine.conceptMerge(args.course, args.from, args.into))))
  tool('learnhub_compass',
    'Read a course compass (罗盘, ADR-0033 transparency device #143): the resident non-commitment route sketch at the course root — current 剩余路线 (route, coach-owned, rewritten per growth batch), the learner annotation area (软输入: read it before planning growth batches; proposals, never orders), and the weekly sandbox ETA (quantile bands, 模型推演非承诺). Missing file = legal empty state (course not seeded yet). This file NEVER enters completion criteria or any authority — do not treat hand-edited routes as structure changes.',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run('learnhub_compass', async () =>
      JSON.stringify(await engine.compassRead(args.course))))
  tool('learnhub_compass_paint',
    'Paint (or repaint) the compass initial route (罗盘初画 #143): ONE deep-effort model call with the 罗盘初画 prompt template — endpoint anchor, seed graph, worksheet (coverage) and existing learner annotations (soft input) go in; ONLY the 剩余路线 section is rewritten (annotations preserved byte-for-byte, ETA reset for the weekly refresh). The route is a non-commitment sketch: stages toward the endpoint, candidate steps marked (候选), no time promises. Run right after a seed apply (the apply lands the scaffold with a 待初画 placeholder) and after a reseed; a route failing the format gate (non-empty, no ## headings, length cap) leaves the compass untouched. Completion criteria never read this file.',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run('learnhub_compass_paint', async () =>
      JSON.stringify(await engine.compassPaint(args.course, llmSeam(ctx)))))
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
    'Reset one course for full regeneration: all node notes are backed up into .trash/regenerate-<ts>/ and rewritten as ungenerated skeletons; the question bank, interactive artifacts, and generated-image dirs move into the same backup. The graph, learning progress, and prompt snapshots are kept. Regeneration then runs as a background chain over all nodes in graph topological order (each node: outline → sections → quiz) and this call returns immediately with the queued count; progress shows in the panel generate tab. Refuses while generation tasks are running. Destructive but recoverable — confirm with the user before calling. The sediment layer (learner-model state: FSRS params, calibration profile) is NEVER touched — surface that as its own separate confirmation item (#139).',
    { course: { type: 'string', required: true, description: 'Course name' } },
    (args: { course: string }) => run('learnhub_course_reset', async () => {
      const r = await resetCourseChain(ctx, args.course)
      return JSON.stringify({ message: `已重置「${args.course}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成（后台链，进度看任务注册表）。沉淀层波及：${r.reset.sediment}`, reset: r.reset, queued: r.queued })
    }))
  tool('learnhub_course_delete',
    'Delete one course: remove it from the course registry and move the whole course directory into 学习中心/.trash/ (recoverable by hand). Learning progress lives inside the course directory, so it goes too. Destructive — confirm with the user before calling; for a content-only redo prefer learnhub_course_reset (keeps the graph and progress).',
    { course: { type: 'string', required: true, description: 'Course name' } },
    (args: { course: string }) => run('learnhub_course_delete', async () => {
      const r = await engine.courseDelete(args.course)
      await sweepGenJobs() // 写侧联动（ADR-0039）：任务记录随课程删除出册
      return JSON.stringify({ message: `已删除「${r.removed}」（整课目录移入 .trash，可手工恢复）。沉淀层波及：${r.sediment}`, ...r })
    }))
  tool('learnhub_difficulty_advice',
    'Detect difficulty-mismatch advice across question banks (B2, read-only, advice-first — nothing is written): nodes in review/mastered with low derived mastery + struggling answer accuracy + enough answer volume get a "difficulty band miscalibrated, regenerate" suggestion carrying a difficulty/bloom target-band instruction (feed it to learnhub_question_generate or the section-rewrite flow, validateBank gate applies); individual questions whose scheduling evidence says "too easy" (enough FSRS advances with zero lapses and an interval grown past the threshold — same-day repeats never count) get a "too easy, archivable" annotation (archiving is the author/panel decision via learnhub_question_update archived patch — never silent removal). Responses already dismissed by the learner are filtered out (dismissed count returned). Low data stays silent.',
    { course: { type: 'string', description: 'Course name; omit to scan all enabled courses' } },
    (args: { course?: string }) => run('learnhub_difficulty_advice', async () =>
      JSON.stringify(await engine.difficultyAdvice(args.course))))
  tool('learnhub_bank_cleanup',
    'One-click question-bank housekeeping (ADR-0032, archive-only — never deletes). Preview (default): per node, every non-archived question of skipped nodes plus every dormant question (in bank, never scheduled) of completed review/mastered nodes, grouped with counts and stem excerpts. With apply=true: archives exactly those candidates with reason=cleanup — reversible from the bank panel (restore filter). Always run the preview first and tell the learner what will be archived before applying.',
    {
      course: { type: 'string', description: 'Course name; omit to scan all enabled courses' },
      apply: { type: 'boolean', description: 'omit/false = read-only preview; true = archive the candidates (reason=cleanup)' },
    },
    (args: { course?: string; apply?: boolean }) => run('learnhub_bank_cleanup', async () =>
      JSON.stringify(args.apply === true
        ? { applied: await engine.bankCleanupApply(args.course) }
        : await engine.bankCleanupPreview(args.course))))
  tool('learnhub_optimize_params',
    'Manually trigger FSRS-6 personal parameter optimization (A2, never automatic — like Anki): retrains the 21 scheduling parameters from the learner\'s real review log (synthetic initializations excluded, first push per card per day) across all enabled courses. Gates: at least 400 real review pushes are required, and the trained parameters must evaluate strictly better than the current/default parameters (same-protocol logLoss comparison) — otherwise nothing is written and the skip reason is returned with the metrics. On success the one learner-level parameter set is written to every enabled course\'s fsrs参数.json with full training metadata (count/date/metrics); the scheduler picks it up with zero changes. Expect ~a few seconds of training.',
    {},
    () => run('learnhub_optimize_params', async () =>
      JSON.stringify(await engine.optimizeFsrsParams())))
  tool('learnhub_question_generate',
    'Generate quiz questions for a node via the model — queued as a quiz job on the global serial generation queue (mutually exclusive with the node content pipeline, so bank writes never interleave) and this call WAITS for the job to finish, then returns the result: node body → question prompt → llm → validateBank gate appends every question to the bank. The prompt lists the node\'s existing question stems and the engine drops generated questions that duplicate or closely resemble them (reported as duplicates). Birth tagging (#148): when the course concept registry scope (node teaches ∪ prereq-closure teaches) is non-empty every question must carry exactly ONE invokes concept — a missing tag gets one repair pass, still-empty questions are rejected and reported; the result\'s `enc` field carries the invokes-coverage projection (birth weights over prereq nodes, share of questions invoking each) — carry those into the next growth batch via set_enc whole-replace. Use when a node has no/too few questions. Progress is visible in the gen-jobs registry / panel generate tab while it waits.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must have generated content)' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { course: string; node: string; count?: number }) => run('learnhub_question_generate', async () => {
      const n = questionCount(args.count)
      const { key } = enqueueQuizGeneration(ctx, args.course, args.node, { count: n })
      const job = await waitForQuizJob(key)
      if (job.status === 'cancelled') return JSON.stringify({ status: 'cancelled', message: job.message })
      if (job.status !== 'done') throw new Error(job.message || `出题任务终态 ${job.status}`)
      const r = quizJobResults.get(key)
      quizJobResults.delete(key)
      return JSON.stringify({
        status: job.status, message: job.message,
        ...(r ? {
          course: r.course, node: r.node, added: r.added, skipped: r.skipped, total: r.total,
          duplicates: r.duplicates, rejected: r.rejected, enc: r.enc,
        } : {}),
      })
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
        const rest = Object.keys(args.patch).filter(k => k !== 'archived')
        if (rest.some(k => k !== 'reason')) {
          throw new Error('[question-update] 归档与内容修订是两条独立操作，混合 patch 会被整体拒绝（先归档，或先改内容再单独归档）')
        }
        const reason = typeof args.patch.reason === 'string' ? args.patch.reason : undefined
        await engine.questionArchive(args.course, args.node, args.qid, archived, reason)
        return JSON.stringify({ course: args.course, node: args.node, qid: args.qid, archived })
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
        llmSeam(ctx), args.course, args.node, args.qid, args.answer,
        null, { ...(args.predicted !== undefined ? { predicted: args.predicted as never } : {}) }))))

  tool('learnhub_note_source_register',
    'Register a personal vault note (or a folder — batch-registers every .md under it, recursively, dot-dirs skipped) as a Note Source (C1): the engine reads it ONLY to generate review questions; the note file is never written (zero bytes change, never judged Broken). Derivatives (fingerprint manifest + per-source question bank) live in the 学习中心/笔记源 mirror. Re-registering a missing source by the same path restores it. Registrable zones: everything OUTSIDE the learning center, PLUS two learner-document zones inside it (V-3/V-5) — 学习中心/我的产出/** (weekly kata, scripts, error cards) and 学习中心/projects/<id>/日志.md — so learner output can become reviewable too; every other learning-center path is rejected. The user exclusion list (learnhub_note_source_exclude) is enforced at this entry: an excluded input fails loud, and excluded subtrees are batch-skipped — skipped/skipped_paths report everything skipped (excluded entries and any learning-center files; when every .md under the input is skipped the error says so). Question generation is a separate explicit step (learnhub_note_source_generate).',
    { path: { type: 'string', required: true, description: 'Note or folder path, vault-relative or absolute; must be outside the learning center (except the two learner-document zones), not on the user exclusion list, and must exist' } },
    (args: { path: string }) => run('learnhub_note_source_register', async () =>
      JSON.stringify(await engine.noteSourceRegister(args.path))))
  tool('learnhub_note_source_list',
    'List registered Note Sources (C1) with pool status: ok / missing (note deleted or renamed — pool suspended, re-register or unregister) / drifted (note edited since question generation — regenerate or archive old questions, never automatic). Cards enter the global review queue automatically when due (course field = 笔记源). The response also carries excludes — the user exclusion list (paths never auto-registered; governs future registrations only, existing sources stay).',
    {},
    () => run('learnhub_note_source_list', async () =>
      JSON.stringify(await engine.noteSourceList())))
  tool('learnhub_note_source_unregister',
    'Unregister a Note Source (C1): removes the registry entry, the mirror manifest item, the mirror question bank, and the pool-mirror md. The user\'s note file is untouched. Use the id from learnhub_note_source_list.',
    { id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' } },
    (args: { id: string }) => run('learnhub_note_source_unregister', async () =>
      JSON.stringify(await engine.noteSourceUnregister(args.id))))
  tool('learnhub_note_source_relink',
    'Relink a Note Source to a new path (V-6 drift governance): when a registered note was RENAMED or MOVED, the source reads Missing and its card pool suspends — relink re-attaches the SAME source id to the new path, keeping the mirror bank and every card\'s FSRS schedule (unlike unregister+re-register, which orphans the old cards). Fingerprint and title refresh from the new file; the pool-mirror md backlink follows. The new path passes the same hygiene as registration (outside the learning center, not on the user exclusion list, not already taken by another source) and must EXIST — relink is a recovery action. Fails loud on every conflict.',
    {
      id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' },
      path: { type: 'string', required: true, description: 'New note path (after the rename/move), vault-relative or absolute' },
    },
    (args: { id: string; path: string }) => run('learnhub_note_source_relink', async () =>
      JSON.stringify(await engine.noteSourceRelink(args.id, args.path))))
  tool('learnhub_note_source_exclude',
    'Add a path to the user exclusion list (V-1): a note/folder that batch registrations must never absorb (e.g. private journals, sync-noise folders). Vault-relative or absolute, file or folder (folder = the whole subtree), need not exist yet. Governs FUTURE registrations only — already-registered sources stay until learnhub_note_source_unregister. Current list rides learnhub_note_source_list.',
    { path: { type: 'string', required: true, description: 'Note or folder path to exclude, vault-relative or absolute; must be outside the learning center' } },
    (args: { path: string }) => run('learnhub_note_source_exclude', async () =>
      JSON.stringify(await engine.noteSourceExclude(args.path))))
  tool('learnhub_note_source_unexclude',
    'Remove a path from the user exclusion list (must be on it — fails loud otherwise), making it registrable again via learnhub_note_source_register. Does not auto-register.',
    { path: { type: 'string', required: true, description: 'Excluded path to release, vault-relative or absolute' } },
    (args: { path: string }) => run('learnhub_note_source_unexclude', async () =>
      JSON.stringify(await engine.noteSourceUnexclude(args.path))))
  tool('learnhub_note_source_generate',
    'Generate review questions for a Note Source (C1): reads the note body (read-only) → 笔记出题 prompt → model → validateBank gate appends each question to the mirror bank (学习中心/笔记源/题库/<id>.yaml) → new cards get their FSRS card initialized (due tomorrow, synthetic init like course completion). The manifest fingerprint refreshes to the current content (drift acknowledged); old questions are NOT auto-archived — offer the learner to archive them explicitly. Fails loud when the source file is missing (re-register first).',
    {
      id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { id: string; count?: number }) => run('learnhub_note_source_generate', async () => {
      const n = questionCount(args.count)
      return JSON.stringify(await engine.noteSourceGenerate(args.id, n, async prompt => stripFences(await llmSeam(ctx)(prompt))))
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
      JSON.stringify(await engine.explainBackFeedback(args.course, args.node, args.transcript, llmSeam(ctx)))))
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
      }, llmSeam(ctx)))
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

  // —— C-3 错误对比卡（#82）：错法挖矿 → 三选一辨别卡 → 错误 deck 走 FSRS ——

  tool('learnhub_error_card_mine',
    'Mine the answer-attempt stream for high-frequency error patterns (C-3 #82, read-only preview): groups substantive wrong answers (correct=false with an actual wrong answer; forget declarations do not count) by course/node/question and returns candidates with >=2 lapses, each carrying the learner\'s distinct wrong answers (most recent first). This is the human-audit surface for "error patterns are reasonable" — generation is learnhub_error_card_generate; nothing is written here.',
    {
      course: { type: 'string', description: 'Course name; omit for all enabled courses' },
      node: { type: 'string', description: 'Node name to scope the mining' },
    },
    (args: { course?: string; node?: string }) => run('learnhub_error_card_mine', async () =>
      JSON.stringify(await engine.errorCardMine(args.course, args.node))))
  tool('learnhub_error_card_generate',
    'Generate 错误对比卡 discrimination cards from mined error patterns (C-3 #82): picks the top uncovered candidates (same question failed substantively >=2 times, no active card yet, batch cap 5), feeds the model the original question/answer/explanation + the learner\'s own wrong answers + the bound section excerpt, and the model returns three-option cards where ONE option is the learner\'s own wrong approach. Cards pass a schema gate (exactly 3 distinct options; answer and mine must both be among them and differ; (node,source_q) must match an offered candidate) and land in the per-node 错误卡 deck (课程根/错误卡/<节点>.yaml). Creation is zero XP and writes nothing canonical — the deck joins the review queue (source=error) and reviews earn unbound XP via learnhub_error_card_answer. Zero-disk-write on any model/gate failure.',
    {
      course: { type: 'string', description: 'Course name' },
      node: { type: 'string', description: 'Node name to scope mining/generation' },
      max: { type: 'number', description: 'Max cards this run (default 5, cap 5)' },
    },
    (args: { course: string; node?: string; max?: number }) => run('learnhub_error_card_generate', async () =>
      JSON.stringify(await engine.errorCardGenerate(args.course, {
        ...(args.node ? { node: args.node } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
      }, async prompt => stripFences(await llmSeam(ctx)(prompt))))))
  tool('learnhub_error_card_queue',
    'List ALL 错误对比卡 (C-3 #82) for inventory/audit: due cards first (due ascending), never-scheduled cards after. Each card carries the full face (q/options/answer/mine/explanation) plus source_q provenance — use this to spot-check that mined error patterns are faithful to what the learner actually did. Review happens in the merged cross-course review queue (source=error) or directly via learnhub_error_card_answer (auto-graded: pick the correct approach = 3, pick wrong = 1; one push per card per day). Correct picks earn unbound XP (totals/daily goal/streak only).',
    { course: { type: 'string', description: 'Course name; omit for all enabled courses' } },
    (args: { course?: string }) => run('learnhub_error_card_queue', async () =>
      JSON.stringify(await engine.errorCardQueue(args.course))))
  tool('learnhub_error_card_answer',
    'Settle one 错误对比卡 (C-3 #82) with the learner\'s three-way choice: the choice must be one of the card\'s option texts verbatim. Auto-graded — picking the correct approach pushes the card with rating 3, picking wrong with rating 1 (one push per card per day, second same-day answer rejected). Only the card\'s own FSRS block moves (default params, optimizer never trains it); a correct pick earns unbound XP (xp_error journal row — totals/daily goal/streak only, never per-course/per-node ledgers or mastery); wrong picks leave a 0-XP unbound row. The reveal (answer / the learner\'s mine option / explanation) rides the response for the learner to compare.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      choice: { type: 'string', required: true, description: 'The chosen option text (verbatim one of options)' },
    },
    (args: { course: string; node: string; card: string; choice: string }) => run('learnhub_error_card_answer', async () =>
      JSON.stringify(await engine.errorCardAnswer(args.course, args.node, args.card, args.choice))))
  tool('learnhub_error_card_archive',
    'Archive or restore one 错误对比卡 (C-3 #82 management): archived cards leave the review queue but keep their history in the card file; a question with only an archived card becomes minable again on the next generate run. Error-deck internal action: zero canonical writes.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { course: string; node: string; card: string; archived?: boolean }) => run('learnhub_error_card_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[error-card-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await engine.errorCardArchive(args.course, args.node, args.card, args.archived))
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
  tool('learnhub_project_log',
    'Read a project\'s log (V-5): the learner\'s free-form working journal at 学习中心/projects/<id>/日志.md — dated entries of what they did, where they got stuck, what they learned. Null when never written (legal empty state, no file is created by reading). The log may be REGISTERED as a Note Source (learnhub_note_source_register with the log path) so its content becomes reviewable — the engine only ever reads it.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run('learnhub_project_log', async () =>
      JSON.stringify(await engine.projectLog(args.id))))
  tool('learnhub_project_log_append',
    'Append one dated entry to a project\'s log (V-5): the learner\'s own record of real project work — progress, blockers, decisions, learnings. Entries are learner-authored prose; engine bookkeeping (plan revisions, receipts mirror, exec events) lives in its own files and never pollutes the log. The engine refreshes the registered fingerprint after writing (its own writes are not content drift).',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      text: { type: 'string', required: true, description: 'Entry body (non-empty prose; multiple paragraphs/lines fine)' },
    },
    (args: { id: string; text: string }) => run('learnhub_project_log_append', async () =>
      JSON.stringify(await engine.projectLogAppend(args.id, args.text))))
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
    'Apply a pending PROJECT proposal by id (kind read from the record: project_plan = write the revised milestone plan into 项目.md with the old plan snapshotted — a revision diff (milestone identity keyed by id) is returned and switch-line/branch-in growth batches are ENQUEUED for the anchored courses (#149); project_milestone = overwrite the milestone artifact with the old text snapshotted). Decompile-linked plan proposals CANNOT apply alone while their seed half is pending — use learnhub_project_decompile_apply. Graph proposals (edit/seed) go through learnhub_graph_apply instead. Nothing applies without this explicit step — review pending proposals with the learner first.',
    { id: { type: 'number', required: true, description: 'Pending proposal id' } },
    (args: { id: number }) => run('learnhub_project_apply', async () => {
      const result = await engine.projectApply(args.id)
      triggerPlanGrowth(ctx, result)
      return JSON.stringify(result)
    }))
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
  tool('learnhub_project_decompile',
    'GOAL DECOMPILATION, v8 seed-cluster form (#149): one model call produces TWO paired proposals from the goal description + registered notes — a milestone plan draft (project_plan) and a knowledge-subgraph SEED CLUSTER (kind=seed: 1-3 start nodes + endpoint, engine stamps basis=project and lands the coarse placeholder edges). Same-origin in-out: both pass gates before EITHER is filed (plan-seed name-reconciliation gate: every plan.nodes reference must resolve to a seed-cluster node or an existing graph node — dangling references reject the whole run), and the pair is LINKED (apply ONLY via learnhub_project_decompile_apply which lands the seed graph first then the plan; rejecting one auto-rejects the other). With an explicit course param: the course must already exist and NO seed half is produced (the plan references existing nodes only — new knowledge needs are grown later by the coach, driven by plan-revision diffs). Vault priors are mined read-only; nothing canonical is written before apply.',
    {
      id: { type: 'string', required: true, description: 'Project id (the plan-draft proposal targets it)' },
      goal: { type: 'string', description: 'Goal description prose; defaults to the project\'s goal field (empty goal is rejected)' },
      course: { type: 'string', description: 'Existing target course: plan-only run (nodes must reference existing graph nodes); omit → the seed cluster becomes a NEW course seed proposal (pair-linked with the plan)' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Registered note-source ids or vault-relative paths to mine for prior context; omit → all registered sources' },
    },
    (args: { id: string; goal?: string; course?: string; notes?: string[] }) => run('learnhub_project_decompile', async () =>
      JSON.stringify(await engine.projectDecompile(
        args.id,
        {
          ...(args.goal !== undefined ? { goal: args.goal } : {}),
          ...(args.course !== undefined ? { course: args.course } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
        },
        llmSeam(ctx),
      ))))
  tool('learnhub_project_decompile_apply',
    'Apply a DECOMPILED pair TOGETHER (project_plan + seed, #149 same-origin in-out): pass BOTH proposal ids from learnhub_project_decompile; the seed lands first (cluster nodes + endpoint anchor + note scaffolds) so the plan\'s node references resolve, then the plan writes. Single-sided apply of a linked pair is rejected at the guard — use this joint entry (crash recovery: an already-applied half is skipped, a rejected half never revives — re-decompile instead).',
    {
      plan: { type: 'number', required: true, description: 'project_plan proposal id' },
      seed: { type: 'number', required: true, description: 'seed proposal id (pair-linked with the plan)' },
    },
    (args: { plan: number; seed: number }) => run('learnhub_project_decompile_apply', async () =>
      JSON.stringify(await engine.projectDecompileApply(args.plan, args.seed))))
  tool('learnhub_project_exec_log',
    'Log ONE PROJECT execution event (P-7): a real work session on the project with a performance rating (1-4 integer; 4 = strong, 1 = poor) and an honest source (auto REQUIRES observable evidence mapped deterministically; self/ai take the explicit rating — self-report is trusted, ADR-0016). The event lands in the project\'s OWN stream (projects/<id>/exec.jsonl) feeding the fading-tier recommendation and the 2×2 diagnostic. Exercised linked nodes get practice evidence backflow ONE-WAY into each node\'s practice channel (existing applyPracticeEvidence EMA, node-level dedup — seeded stub nodes participate exactly like taught ones); the count of exercised existing enc edges is reported for observability but coarse placeholder pre edges are NOT backflow channels. Zero XP, zero journal, zero FSRS/scheduling writes.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      source: { type: 'string', required: true, description: 'auto (requires evidence) / self / ai' },
      rating: { type: 'number', description: 'Performance rating 1-4 integer (required for self/ai; ignored for auto)' },
      evidence: { type: 'object', additionalProperties: true, description: 'Observable evidence for source=auto: { accuracy: 0-1, self_help?: number }' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Linked course nodes exercised this session (node name or 课程/节点); empty = stream-only, no backflow' },
      note: { type: 'string', description: 'One-line note about this execution' },
    },
    (args: { id: string; source: string; rating?: number; evidence?: { accuracy?: number; self_help?: number }; nodes?: string[]; note?: string }) => run('learnhub_project_exec_log', async () =>
      JSON.stringify(await engine.projectExecLog(args.id, {
        source: args.source,
        ...(args.rating !== undefined ? { rating: args.rating } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
        ...(args.nodes !== undefined ? { nodes: args.nodes } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
      }))))
  tool('learnhub_project_cross_view',
    'Read a project\'s 2×2 MASTERY CROSS diagnostic (P-7, the project panel\'s core view): X = declarative mastery (mean masteryOfFm over the plan\'s linked nodes), Y = project execution evidence (EMA 0.7/0.3 of event scores; both axes threshold 0.6, missing evidence counts as low). Quadrants: 会而不会用 (high mastery × low execution — apply it), 会用而不牢 (low × high — shore up the knowledge base), 健康 (high × high), 补底 (low × low). Also returns the READ-ONLY fading-tier recommendation (challenge point): promotion criteria = performance within the current tier (≥3 events averaging ≥0.8) AND the linked-node mastery holding — the engine only proposes, the learner changes tier explicitly via learnhub_project_tier, and the recommendation NEVER gates milestones or anything else.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run('learnhub_project_cross_view', async () =>
      JSON.stringify(await engine.projectCrossView(args.id))))

  // —— U 区·技能条目与执行事件通道（#89 / ADR-0018 + ADR-0019）：lane 与题目 FSRS 并行，不复用题目卡、不进复习队列 ——

  tool('learnhub_skill_create',
    'Create a skill entry (U-area schedulable practice subject, e.g. guitar/swimming/coding): the carrier of the execution-event scheduling lane. The lane runs PARALLEL to question FSRS (same kernel math, own isolated state) — it never reuses question cards, never enters the review queue, and has no mastery. Optional maintenance beat cap (days, default 30, null = off) guarantees long-dormant skills resurface at low frequency (mini-redo + replay).',
    {
      name: { type: 'string', required: true, description: 'Skill name (also becomes the id)' },
      maintenance_days: { type: 'number', description: 'Maintenance beat cap in days: 7-365, or 0/null to disable (default 30)' },
    },
    (args: { name: string; maintenance_days?: number | null }) => run('learnhub_skill_create', async () =>
      JSON.stringify(await engine.skillCreate(args.name, {
        ...(args.maintenance_days !== undefined ? { maintenance_days: args.maintenance_days } : {}),
      }))))
  tool('learnhub_skill_list',
    'List skill entries with their lane due dates (maintenance cap folded in). due_kind marks what a due lane wants: acquisition (FSRS due drove it) or maintenance (the beat cap brought it back — mini-redo + replay). Fresh skills (never executed) have due=null: no due semantics until the first execution.',
    {}, () => run('learnhub_skill_list', async () => JSON.stringify(await engine.skillList())))
  tool('learnhub_skill_maintenance',
    'Set a skill\'s maintenance beat cap (days 7-365, or null to disable): the lane comes due at most this many days after the last execution, so interval growth can never drown the skill (Arthur 1998: disused motor skills decay hard — low-frequency contact itself has value). Pure entity property: the existing FSRS state is untouched.',
    {
      skill: { type: 'string', required: true, description: 'Skill id' },
      days: { type: 'number', description: 'Cap in days (7-365); omit/null disables the cap' },
    },
    (args: { skill: string; days?: number | null }) => run('learnhub_skill_maintenance', async () =>
      JSON.stringify(await engine.skillSetMaintenance(args.skill, args.days ?? null))))
  tool('learnhub_skill_archive',
    'Archive or restore a skill entry (reversible; archived is a shelving label). Archived skills refuse new execution events until restored.',
    {
      skill: { type: 'string', required: true, description: 'Skill id' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { skill: string; archived?: boolean }) => run('learnhub_skill_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[skill-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await engine.skillArchive(args.skill, args.archived))
    }))
  tool('learnhub_execution_log',
    'Log one execution event on a skill (the lane\'s core input): a real practice + a performance rating (1-4 integer; 4 = strong, 1 = poor) that pushes the skill\'s lane via the same advance kernel (one push per lane per learning day). Source honesty: source=\'auto\' REQUIRES observable evidence (evidence.accuracy 0-1, optional evidence.self_help) mapped deterministically — raw scores are never fed to FSRS; source=\'self\'/\'ai\' take an explicit rating. XP = native focused minutes (minutes 1-1440, 1 XP ≈ 1 min), same ledger and streak as study time (ADR-0019); the event row lands in the review log with rating_source=execution and an event kind (acquisition/maintenance) distinguishing the two flows.',
    {
      skill: { type: 'string', required: true, description: 'Skill id' },
      source: { type: 'string', required: true, description: 'auto (evidence-mapped) / self / ai' },
      minutes: { type: 'number', required: true, description: 'Focused minutes of this execution (1-1440); credited as XP 1:1' },
      rating: { type: 'number', description: 'Performance rating 1-4 (required unless source=auto)' },
      evidence: { type: 'object', additionalProperties: true, description: 'source=auto only: {accuracy: 0-1, self_help?: count}' },
      note: { type: 'string', description: 'Free note (e.g. what was practiced, receipt reference)' },
    },
    (args: { skill: string; source: string; minutes: number; rating?: number; evidence?: { accuracy?: number; self_help?: number }; note?: string }) =>
      run('learnhub_execution_log', async () =>
        JSON.stringify(await engine.executionLog(args.skill, {
          source: args.source as never, minutes: args.minutes,
          ...(args.rating !== undefined ? { rating: args.rating } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
          ...(args.note ? { note: args.note } : {}),
        }))))

  // —— U 区·回执反馈环（#88 / ADR-0016）：回执 → AI 量表评审 → EMA + 渐退反馈 ——

  tool('learnhub_receipt_submit',
    'File an external-practice receipt on a PRACTICE node (v1 carrier) and run the full loop: receipt → AI rubric review (rubric source = the node\'s content points; free-form questions are NOT answered) → the score enters the node\'s practice EMA (same weight, old 0.7/new 0.3). Self-reported = trusted (no anti-cheat gate); material is free-form (text description / image path / export / coach signoff). Receipts never earn XP, never push any FSRS card, and are never Broken. Feedback fades: full error-specific reviews follow a decreasing-frequency curve (receipt #1,2,4,7,11,16,… capped at every 5th); other receipts get score + one-line verdict only. The learner can always force a full review (force_full).',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Practice node name (type=practice)' },
      kind: { type: 'string', required: true, description: 'text / image / export / signoff' },
      material: { type: 'string', required: true, description: 'Receipt material: description, image path, export data, or signoff reference' },
      force_full: { type: 'boolean', description: 'Learner explicitly asks for a full error-specific review now' },
    },
    (args: { course?: string; node: string; kind: string; material: string; force_full?: boolean }) =>
      run('learnhub_receipt_submit', async () => {
        return JSON.stringify(await engine.receiptSubmit(
          args.course, args.node,
          { kind: args.kind as never, material: args.material, ...(args.force_full !== undefined ? { force_full: args.force_full } : {}) },
          llmSeam(ctx),
        ))
      }))
  tool('learnhub_receipt_list',
    'List a practice node\'s receipt history with the fading-feedback state: each receipt\'s material kind, review depth (full/brief), rubric score, and verdict; total count and how many receipts until the next full review. Read-only.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Practice node name' },
    },
    (args: { course?: string; node: string }) => run('learnhub_receipt_list', async () =>
      JSON.stringify(await engine.receiptList(args.course, args.node))))

  // —— U 区·习惯一等公民（#90 / ADR-0017）：零 FSRS 语义、零 canonical 写入 ——

  tool('learnhub_habit_create',
    'Create a habit (U-area first-class object): an execution intention (cue + action, format locked to "stable time/place cue → ONE concrete action") + an automation curve + a forgiving streak. Habits have NO FSRS semantics, no mastery, NO due dates — the scheduler is context and calendar, the engine never reminds. Repetitions are self-reported (no gate, no anti-cheat — self-measurement is not an exam).',
    {
      name: { type: 'string', required: true, description: 'Habit name' },
      cue: { type: 'string', required: true, description: 'Stable cue: time/place anchor (e.g. "after brushing teeth in the morning")' },
      action: { type: 'string', required: true, description: 'ONE concrete action (verb-first); multi-behavior chains fall outside the evidence format' },
    },
    (args: { name: string; cue: string; action: string }) => run('learnhub_habit_create', async () =>
      JSON.stringify(await engine.habitCreate(args))))
  tool('learnhub_habit_list',
    'List habits with their derived surfaces: total self-reported repeats, forgiving streak (small gaps ≤2 days don\'t break it), and latest automation self-rating. Curve and streak are shown to the learner only — they never enter mastery, XP, or any canonical measure.',
    {}, () => run('learnhub_habit_list', async () => JSON.stringify(await engine.habitList())))
  tool('learnhub_habit_show',
    'Show one habit in full: execution intention (cue + action), full automation curve (x = cumulative repeats, y = self-rating 1-5; no decay — interruptions don\'t erode it), streak, and recent repeat log.',
    { habit: { type: 'string', required: true, description: 'Habit id' } },
    (args: { habit: string }) => run('learnhub_habit_show', async () =>
      JSON.stringify(await engine.habitShow(args.habit))))
  tool('learnhub_habit_repeat',
    'Self-report one repetition of a habit (the ONLY counting source; unlimited, no gate). Optionally carry an automation self-rating 1-5 (SRBAI-style, event-level, not required every time). Zero XP, zero scheduling writes — habit repeats never enter the execution-event lane or any ledger.',
    {
      habit: { type: 'string', required: true, description: 'Habit id' },
      auto_rating: { type: 'number', description: 'Optional automation self-rating 1-5 (how automatic did it feel?)' },
      note: { type: 'string', description: 'Free note' },
    },
    (args: { habit: string; auto_rating?: number; note?: string }) => run('learnhub_habit_repeat', async () =>
      JSON.stringify(await engine.habitRepeat(args.habit, {
        ...(args.auto_rating !== undefined ? { auto_rating: args.auto_rating } : {}),
        ...(args.note ? { note: args.note } : {}),
      }))))
  tool('learnhub_habit_archive',
    'Archive or restore a habit (reversible; archived is a shelving label). Habits have no deadlines — staying active forever is legal.',
    {
      habit: { type: 'string', required: true, description: 'Habit id' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { habit: string; archived?: boolean }) => run('learnhub_habit_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[habit-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await engine.habitArchive(args.habit, args.archived))
    }))

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

  console.log(`[learnhub] plugin loaded: vault=${VAULT}, center=${VAULT}/${CENTER_REL}, 106 tools registered (pure TS engine), page at ${PAGE}, API at ${API}/*`)

  // 加载自检：不依赖模型直接跑一次 status，验证引擎通路。
  void engine.statusJson()
    .then(doc => console.log(`[learnhub] self-check status OK (${JSON.stringify(doc).length} bytes)`))
    .catch(err => console.error(`[learnhub] self-check FAILED: ${err instanceof Error ? err.message : String(err)}`))
}
