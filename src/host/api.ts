/**
 * 宿主技术层·面板 HTTP 路由（#167 自 src/index.ts 分装；ADR-0048）：
 * /learnhub/api/* 的分发链与面板内 LLM 会话（tutor / 讲给我听）。
 * 全部状态经 HostRuntime 读写；伺服类路由（file/vendor/interactive/面板页）在 static.ts。
 * 本票不改路由表结构（if 链原样搬入；数据化是下一票）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ANKI_ENDPOINT, AnkiConnectClient } from '../engine/index.ts'
import { applyId, bandPref, questionCount, rejectId, requireSkipDirection } from '../tool-contracts.ts'
import { need, readJson, sendJson } from './http.ts'
import { llmComplete, llmSeam, llmView } from './llm.ts'
import { apiRun, runLog, stripFences } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import { serveInteractive, serveVaultFile, serveVendor } from './static.ts'
import { AGENT_GUIDE } from './tools.ts'
import {
  cancelGeneration,
  coachTriggerDetached,
  enqueueGeneration,
  enqueueGraphJob,
  enqueueGrowthBatch,
  enqueueQuizGeneration,
  generateSection,
  generationStatus,
  resetCourseChain,
  resumeQueue,
  sessionStartCheckpoint,
  sweepGenJobs,
  triggerPlanGrowth,
} from './jobs.ts'

/** 客户端面板的 HTTP 路由前缀。 */
export const API = '/learnhub/api'

/** 面板内轻量答疑：节点上下文 system + 前端携带的对话历史（拼成单条 user 消息）→ llm。
 * 与 dsh 会话分层：这里只答不写，深度讨论/修订走「与 AI 讨论本课」开的会话。 */
async function tutorChat(rt: HostRuntime, ctx: Context, course: string, node: string, history: unknown[]): Promise<string> {
  const pack = await rt.engine.discussionPack(course, node)
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
async function explainBackTurn(rt: HostRuntime, ctx: Context, course: string, node: string, history: unknown[]): Promise<string> {
  const system = await rt.engine.explainBackPack(course, node)
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
/** /learnhub/api/* 路由分发：客户端面板的全部后端入口（响应形状与 v2 一致）。 */
export async function handleApi(rt: HostRuntime, ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API.length)
  try {
    if (req.method === 'GET' && route === '/status') {
      // 模型透明：status 附带当前 LLM 配置（provider/model/思考档，面板只读展示）。
      // 会话开始触点（五点接线，30 分钟节流）：面板打开/轮询共用入口，fire-and-forget。
      sessionStartCheckpoint(rt, ctx)
      sendJson(res, 200, await apiRun(rt, 'api/status', async () => ({ ...(await rt.engine.statusJson()), llm: llmView() })))
      return
    }
    if (req.method === 'GET' && route === '/courses') {
      const list = (await rt.engine.enabledCourses()).map(c => ({
        name: c.name, root: c.root, enabled: String(c.enabled !== false),
      }))
      sendJson(res, 200, list)
      return
    }
    if (req.method === 'GET' && route === '/lesson') {
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/lesson', () => rt.engine.lesson(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/recommend') {
      const limit = Number(url.searchParams.get('limit') ?? '5')
      sendJson(res, 200, await apiRun(rt, 'api/recommend', () => rt.engine.recommend(Number.isFinite(limit) ? limit : 5)))
      return
    }
    if (req.method === 'GET' && route === '/queue') {
      sendJson(res, 200, await apiRun(rt, 'api/queue', () => rt.engine.queueItemsAll()))
      return
    }
    if (req.method === 'GET' && route === '/courses/tree') {
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/courses/tree', () => rt.engine.coursesTree(course)))
      return
    }
    if (req.method === 'GET' && route === '/questions') {
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/questions', () => rt.engine.questions(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/file') {
      // 伺服 vault 内媒体文件（课程插图）；路径必须是 vault 相对且白名单扩展名（体在 static.ts）
      await serveVaultFile(rt, url, res)
      return
    }
    if (req.method === 'GET' && route.startsWith('/vendor/')) {
      // vendored 库同源伺服（katex/three）；路径限制在 web/vendor 内，MIME 白名单复用面板资产表（体在 static.ts）
      await serveVendor(res, route)
      return
    }
    if (req.method === 'GET' && route === '/interactive') {
      // 交互件伺服：限启用课程根内 .html；CSP 禁外联（体在 static.ts）
      await serveInteractive(rt, url, res)
      return
    }
    if (req.method === 'GET' && route === '/note') {
      const path = url.searchParams.get('path')
      if (!path) throw new Error('missing required field: path')
      sendJson(res, 200, await rt.engine.resolveNote(rt.vault, path, rt.centerRel))
      return
    }
    if (req.method === 'GET' && route === '/graph') {
      const course = url.searchParams.get('course') ?? undefined
      const elementsOnly = url.searchParams.get('elements') === '1'
      sendJson(res, 200, await apiRun(rt, 'api/graph', () => rt.engine.graphAnalyze(course, elementsOnly)))
      return
    }
    if (req.method === 'GET' && route === '/proposals') {
      sendJson(res, 200, await apiRun(rt, 'api/proposals', () => rt.engine.graphProposals()))
      return
    }
    if (req.method === 'GET' && route === '/doctor') {
      sendJson(res, 200, await apiRun(rt, 'api/doctor', () => rt.engine.doctor()))
      return
    }
    if (req.method === 'GET' && route === '/questions-all') {
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/questions-all', () => rt.engine.questionsAll(course)))
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
      sendJson(res, 200, await apiRun(rt, 'api/review-queue', () =>
        rt.engine.reviewQueue(course, node, undefined, bandPref(url.searchParams.get('band')))))
      return
    }
    if (req.method === 'GET' && route === '/xp') {
      sendJson(res, 200, await apiRun(rt, 'api/xp', () => rt.engine.xpStatus()))
      return
    }
    if (req.method === 'GET' && route === '/probation') {
      // 插入实验面（#146）：在途插入节点（「实验中」标记取数）、到期未决、三率
      // （滚动 30 学习日）与韧性闸门现势；course 缺省 = 全部启用课程
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/probation', () => rt.engine.probationStatus(course)))
      return
    }
    if (req.method === 'GET' && route === '/memory') {
      // 记忆健康仪表盘（#61）：负载预报/状态分布/真实保留率/遗忘曲线四面板聚合
      // （jol 字段 = 预测-校准曲线 #66 E4，配对数足门槛才有值）
      sendJson(res, 200, await apiRun(rt, 'api/memory', () => rt.engine.memoryHealth()))
      return
    }
    if (req.method === 'GET' && route === '/jol') {
      // JOL 抽查配置（#66 E4）：默认开、约 1/3；全局开关关闭后复习流完全不弹预测
      sendJson(res, 200, await apiRun(rt, 'api/jol', () => rt.engine.jolConfig()))
      return
    }
    if (req.method === 'GET' && route === '/calibration/profile') {
      // 自评校准画像（ADR-0022 #104）：分源切片为主视图 + 全局参考视图（带域特异
      // 警戒）。practice 流水配对的只读派生——零落盘、零 canonical 写入。
      sendJson(res, 200, await apiRun(rt, 'api/calibration/profile', () => rt.engine.calibrationProfile()))
      return
    }
    if (req.method === 'GET' && route === '/calibration/hints') {
      // 过信轻提示全局开关（ADR-0022 #104）：缺省开，可全局关
      sendJson(res, 200, await apiRun(rt, 'api/calibration/hints', () => rt.engine.calibrationHintsConfig()))
      return
    }
    if (req.method === 'GET' && route === '/coach') {
      // 可用的困难教练（#65 E5）：只读信息性反馈，无触发为空数组
      sendJson(res, 200, await apiRun(rt, 'api/coach', () => rt.engine.coachAdvice()))
      return
    }
    if (req.method === 'GET' && route === '/sleep') {
      // D-4 睡眠耦合建议层开关（#85）：默认开
      sendJson(res, 200, await apiRun(rt, 'api/sleep', () => rt.engine.sleepAdviceConfig()))
      return
    }
    if (req.method === 'GET' && route === '/thermostat') {
      // D-2 挑战点恒温器（#111 ADR-0024）：跨区观测聚合 + 只读建议（非自动控制器）
      sendJson(res, 200, await apiRun(rt, 'api/thermostat', () => rt.engine.thermostatView()))
      return
    }
    if (req.method === 'GET' && route === '/experiments') {
      // D-1 N-of-1 实验（#110 ADR-0023）：模板库 + 实验清单 + 报告（无实验时 report=null）
      sendJson(res, 200, await apiRun(rt, 'api/experiments', async () => {
        const experiments = await rt.engine.experimentList()
        let report = null
        if (experiments.length) {
          try {
            report = await rt.engine.experimentReport()
          } catch {
            report = null
          }
        }
        return { templates: await rt.engine.experimentTemplates(), experiments, report }
      }))
      return
    }
    if (req.method === 'GET' && route === '/generate/status') {
      sendJson(res, 200, await apiRun(rt, 'api/generate/status', () => generationStatus(rt)))
      return
    }
    if (req.method === 'GET' && route === '/prompts') {
      sendJson(res, 200, await apiRun(rt, 'api/prompts', () => rt.engine.promptKinds()))
      return
    }
    if (req.method === 'GET' && route === '/discuss-pack') {
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/discuss-pack', () => rt.engine.discussionPack(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/explain-pack') {
      // 错误当下「讲解这道题」逐题包（Arc D #64）：客户端桥注入宿主会话的首条消息原料
      const node = url.searchParams.get('node')
      const qid = url.searchParams.get('qid')
      if (!node || !qid) throw new Error('missing required field: node/qid')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/explain-pack', () => rt.engine.errorExplainPack(course, node, qid)))
      return
    }
    if (req.method === 'GET' && route === '/explain-back-pack') {
      // E2「讲给我听」会话包（#68）：初学者人设指令 + 正文要点 + 图位置（面板会话 system）
      const node = url.searchParams.get('node')
      if (!node) throw new Error('missing required field: node')
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/explain-back-pack', () => rt.engine.explainBackPack(course, node)))
      return
    }
    if (req.method === 'GET' && route === '/note-sources') {
      // 笔记源清单（C1 #59）：注册身份 × Missing/漂移状态 × 卡池概况
      sendJson(res, 200, await apiRun(rt, 'api/note-sources', () => rt.engine.noteSourceList()))
      return
    }
    if (req.method === 'GET' && route === '/anki/status') {
      // Anki 通道状态（C2 #63，#72 UI 挂接）：镜象/最近推送与回写/当前到期分布
      // + AnkiConnect 可达性（连接失败不抛，status.anki.connected=false 带原因）
      sendJson(res, 200, await apiRun(rt, 'api/anki/status', () =>
        rt.engine.ankiStatus(new AnkiConnectClient(ANKI_ENDPOINT))))
      return
    }
    if (req.method === 'GET' && route === '/difficulty-advice') {
      // B2 难度失衡/过于简单只读建议（#58，#72 UI 挂接）：题目管理页建议区消费
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/difficulty-advice', () => rt.engine.difficultyAdvice(course)))
      return
    }
    if (req.method === 'GET' && route === '/agent-guide') {
      // 能力指南：agent 独有工具的面板说明锚点（AGENT_GUIDE 单一事实源）
      sendJson(res, 200, AGENT_GUIDE)
      return
    }
    if (req.method === 'GET' && route === '/question-audit') {
      // 题库契约只读体检（ADR-0029/0030）：题库维护区消费
      sendJson(res, 200, await apiRun(rt, 'api/question-audit', () => rt.engine.questionAudit()))
      return
    }
    if (req.method === 'GET' && route === '/bank-cleanup') {
      // 题库一键清理预览（ADR-0032，只读）：跳过节点全部未归档题 + 已完成节点休眠题
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/bank-cleanup', () => rt.engine.bankCleanupPreview(course)))
      return
    }
    if (req.method === 'GET' && route === '/learner-queue') {
      // 「我的卡」E 池队列（E1/#68）：到期在前、新卡随后，隔离自调度
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/learner-queue', () => rt.engine.learnerQueue(course)))
      return
    }
    if (req.method === 'GET' && route === '/error-queue') {
      // 「错误对比卡」清单（C-3/#82）：到期在前、新卡随后（全卡面，管理/抽查用）
      const course = url.searchParams.get('course') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/error-queue', () => rt.engine.errorCardQueue(course)))
      return
    }
    if (req.method === 'GET' && route === '/skills') {
      // 技能条目 lane（#89）：生效到期已折算维持节拍帽（读侧）
      sendJson(res, 200, await apiRun(rt, 'api/skills', () => rt.engine.skillList()))
      return
    }
    if (req.method === 'GET' && route === '/habits') {
      // 习惯（#90）：清单 + 宽容 streak + 自动化曲线摘要（只展示给学习者）
      sendJson(res, 200, await apiRun(rt, 'api/habits', () => rt.engine.habitList()))
      return
    }
    if (req.method === 'GET' && route === '/habit') {
      // 单个习惯详情（#90）：意图 + 完整自动化曲线 + 近期重复
      const habit = url.searchParams.get('habit')
      if (!habit) throw new Error('missing required field: habit')
      sendJson(res, 200, await apiRun(rt, 'api/habit', () => rt.engine.habitShow(habit)))
      return
    }
    if (req.method === 'GET' && route === '/projects') {
      // 项目清单（P 区 #92）：Project 是 Course 姊妹实体（面板尚无项目页签前的读面）
      sendJson(res, 200, await apiRun(rt, 'api/projects', () => rt.engine.projectList()))
      return
    }
    if (req.method === 'GET' && route === '/project/cross') {
      // 项目 2×2 交叉视图（P-7 #98）：面板核心视图（只读，含入档推荐）
      const id = url.searchParams.get('id')
      if (!id) throw new Error('missing required field: id')
      sendJson(res, 200, await apiRun(rt, 'api/project/cross', () => rt.engine.projectCrossView(id)))
      return
    }
    if (req.method === 'GET' && route === '/project/log') {
      // 项目日志读面（V-5 #113）：未写过 = null 合法空态
      const id = url.searchParams.get('id')
      if (!id) throw new Error('missing required field: id')
      sendJson(res, 200, await apiRun(rt, 'api/project/log', () => rt.engine.projectLog(id)))
      return
    }
    if (req.method === 'GET' && route === '/kata') {
      // 周复盘打开/发起（U-4 #114）：缺省 = 上一完整学习周；现状引擎现算重填，四问保留
      const week = url.searchParams.get('week_start') ?? undefined
      sendJson(res, 200, await apiRun(rt, 'api/kata', () => rt.engine.kataOpen(week)))
      return
    }
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (route === '/habits/create') {
        // 习惯创建（#90）：意图两字段（线索/行动）由引擎 fail loud 校验
        sendJson(res, 200, await apiRun(rt, 'api/habits/create', () => rt.engine.habitCreate({
          name: need(body, 'name'), cue: need(body, 'cue'), action: need(body, 'action'),
        })))
        return
      }
      if (route === '/habits/repeat') {
        // 自报重复（#90）：唯一计数来源，无门禁；可选自动化自评 1-5
        sendJson(res, 200, await apiRun(rt, 'api/habits/repeat', () => rt.engine.habitRepeat(need(body, 'habit'), {
          ...(typeof body.auto_rating === 'number' ? { auto_rating: body.auto_rating } : {}),
          ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note } : {}),
        })))
        return
      }
      if (route === '/habits/archive') {
        if (typeof body.archived !== 'boolean') throw new Error('missing required field: archived')
        sendJson(res, 200, await apiRun(rt, 'api/habits/archive', () =>
          rt.engine.habitArchive(need(body, 'habit'), body.archived)))
        return
      }
      if (route === '/skills/archive') {
        if (typeof body.archived !== 'boolean') throw new Error('missing required field: archived')
        sendJson(res, 200, await apiRun(rt, 'api/skills/archive', () =>
          rt.engine.skillArchive(need(body, 'skill'), body.archived)))
        return
      }
      if (route === '/skills/maintenance') {
        // 维持节拍帽（#89）：天数或 null（关闭）
        sendJson(res, 200, await apiRun(rt, 'api/skills/maintenance', () =>
          rt.engine.skillSetMaintenance(need(body, 'skill'), body.days ?? null)))
        return
      }
      if (route === '/rebuild') {
        sendJson(res, 200, { message: (await rt.engine.rebuild()).message })
        return
      }
      if (route === '/node/skip') {
        // 跳过 = 显式重新裁决（词条「教练回合」五点之一）：force 豁免停摆/暂不产结构
        // 阻尼——跳过改了症状与路线，上一次停摆裁决不再代表现状；路由返回后 fire-and-forget
        const skipped = await apiRun(rt, 'api/node/skip', () =>
          rt.engine.nodeSkip(need(body, 'course'), need(body, 'node'), requireSkipDirection(body.skipped)))
        coachTriggerDetached(rt, ctx, 'node_skip', need(body, 'course'), { force: true })
        sendJson(res, 200, skipped)
        return
      }
      if (route === '/node/pin') {
        // 「今天学它」pin（E3 #67）：显式方向——pinned=true 置顶当日推荐榜首（只改
        // 排序、保留就绪提示、次日自动失效），false 取消。
        if (typeof body.pinned !== 'boolean') throw new Error('missing required field: pinned')
        sendJson(res, 200, await apiRun(rt, 'api/node/pin', () =>
          body.pinned
            ? rt.engine.pinToday(need(body, 'course'), need(body, 'node'))
            : rt.engine.unpinToday(need(body, 'course'), need(body, 'node'))))
        return
      }
      if (route === '/node/complete') {
        // 完成 = 教练回合触发点之一（五点接线）：自动触点走阻尼；路由返回后 fire-and-forget
        const done = await apiRun(rt, 'api/node/complete', () =>
          rt.engine.nodeComplete(need(body, 'course'), need(body, 'node'), body.force === true))
        coachTriggerDetached(rt, ctx, 'node_complete', need(body, 'course'))
        sendJson(res, 200, done)
        return
      }
      if (route === '/feedback') {
        sendJson(res, 200, { message: await rt.engine.submitFeedback(rt.vault, rt.centerRel, need(body, 'path')) })
        return
      }
      if (route === '/proposals/apply') {
        // 提案统一 apply（图谱域 edit/seed/enrich + 项目域 project_plan/project_milestone）：
        // kind 必须显式照抄提案记录，未知 kind 引擎报错；
        // 计划修订触发的换线/补支生长批随后入队（#149）
        const applied = await rt.engine.proposalApply(need(body, 'kind'), applyId(body.id))
        // 编辑批可含 del_node/rename（ADR-0039 写侧联动）：apply 出口同步清扫注册表
        await sweepGenJobs(rt)
        triggerPlanGrowth(rt, ctx, applied as { kind?: string })
        sendJson(res, 200, applied)
        return
      }
      if (route === '/proposals/reject') {
        const id = rejectId(body.id)
        await rt.engine.graphReject(id, typeof body.note === 'string' ? body.note.trim() : '')
        sendJson(res, 200, { message: `[reject] 提案 #${id} 已拒绝留痕。` })
        return
      }
      if (route === '/thermostat/apply') {
        // D-2 恒温器建议的逐条显式确认（#111 ADR-0024）：只受理当前清单内 id
        sendJson(res, 200, await apiRun(rt, 'api/thermostat/apply', () =>
          rt.engine.thermostatApply(need(body, 'suggestion'))))
        return
      }
      if (route === '/experiments/propose') {
        // D-1 实验提案（#110）：模板发起 → pending 提案
        const course = typeof body.course === 'string' && body.course.trim() ? body.course.trim() : undefined
        sendJson(res, 200, await apiRun(rt, 'api/experiments/propose', () =>
          rt.engine.experimentPropose(need(body, 'template'), course)))
        return
      }
      if (route === '/experiments/apply') {
        // D-1 实验确认开跑（#110 提案-确认制第二步）
        sendJson(res, 200, await apiRun(rt, 'api/experiments/apply', () =>
          rt.engine.experimentApply(applyId(body.id))))
        return
      }
      if (route === '/experiments/stop') {
        // D-1 实验手动停止（开停手动，ADR-0023）
        const id = body.id === undefined || body.id === null ? undefined : applyId(body.id)
        sendJson(res, 200, await apiRun(rt, 'api/experiments/stop', () => rt.engine.experimentStop(id)))
        return
      }
      if (route === '/sandbox/run') {
        // D-3 沙盘（#112 ADR-0025）：只读蒙特卡洛推演，零写侧
        const minutes = Number(body.minutes_per_day)
        if (!Number.isFinite(minutes)) throw new Error('missing required field: minutes_per_day')
        const weeks = body.weeks === undefined ? undefined : Number(body.weeks)
        const course = typeof body.course === 'string' && body.course.trim() ? body.course.trim() : undefined
        const nodes = Array.isArray(body.nodes) ? body.nodes.filter((n): n is string => typeof n === 'string') : undefined
        sendJson(res, 200, await apiRun(rt, 'api/sandbox/run', () =>
          rt.engine.sandboxRun({ minutesPerDay: minutes, ...(weeks !== undefined && Number.isFinite(weeks) ? { weeks } : {}), ...(course ? { course } : {}), ...(nodes?.length ? { nodes } : {}) })))
        return
      }
      if (route === '/generate') {
        // 入队即返回：全局串行队列后台按序执行（大纲 → 逐节正文 → 自动出题，数分钟/节点）
        const style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : undefined
        sendJson(res, 200, await apiRun(rt, 'api/generate', async () =>
          enqueueGeneration(rt, ctx, need(body, 'course'), need(body, 'node'), style)))
        return
      }
      if (route === '/generate/resume') {
        // 恢复重启后暂停的队列（遗留排队任务不自动开跑，防静默烧 token）
        sendJson(res, 200, await apiRun(rt, 'api/generate/resume', async () => resumeQueue(rt, ctx)))
        return
      }
      if (route === '/generate/section') {
        // 单节重写：指定节 id 重新生成并过门（LessonView 节重写入口）
        sendJson(res, 200, await apiRun(rt, 'api/generate/section', async () => ({
          message: await generateSection(rt, ctx, need(body, 'course'), need(body, 'node'), need(body, 'section')),
        })))
        return
      }
      if (route === '/course/reset') {
        // 整课重新生成：重置（旧内容备份进 .trash）→ 按拓扑序串行重跑生成管线。
        // 重生成链后台执行，HTTP 立即返回；进度由任务注册表展示（面板 5s 轮询）。
        sendJson(res, 200, await apiRun(rt, 'api/course/reset', async () =>
          resetCourseChain(rt, ctx, need(body, 'course'))))
        return
      }
      if (route === '/interactive/settle') {
        // 交互件成绩结算（LEARNHUB_COMPLETE 上报；同节同日一次，防刷）
        const score = Number(body.score)
        sendJson(res, 200, await apiRun(rt, 'api/interactive/settle', () => rt.engine.interactiveSettle(
          need(body, 'course'), need(body, 'node'), need(body, 'section'),
          Number.isFinite(score) ? score : 0,
          typeof body.detail === 'string' ? body.detail : undefined)))
        return
      }
      if (route === '/tutor') {
        // 面板内轻量答疑：前端持有对话历史全量携带（最后一条必须是学习者提问）
        const history = Array.isArray(body.messages) ? body.messages : []
        sendJson(res, 200, await apiRun(rt, 'api/tutor', async () => ({
          answer: await tutorChat(rt, ctx, need(body, 'course'), need(body, 'node'), history),
        })))
        return
      }
      if (route === '/explain-back') {
        // E2「讲给我听」（#68）：初学者人设追问会话——包做 system，前端全量携带对话历史
        const history = Array.isArray(body.messages) ? body.messages : []
        sendJson(res, 200, await apiRun(rt, 'api/explain-back', async () => ({
          answer: await explainBackTurn(rt, ctx, need(body, 'course'), need(body, 'node'), history),
        })))
        return
      }
      if (route === '/explain-feedback') {
        // E2 定位反馈回合（#68）：对照要点给是非+定位+怎么补；判词只入 E 档案
        sendJson(res, 200, await apiRun(rt, 'api/explain-feedback', () => rt.engine.explainBackFeedback(
          need(body, 'course'), need(body, 'node'),
          typeof body.transcript === 'string' ? body.transcript : '',
          llmSeam(ctx))))
        return
      }
      if (route === '/explain-archive') {
        // E2 存档（#68）：把这版讲稿存成 E1 自注卡（再讲一遍/挖空重述两档）
        sendJson(res, 200, await apiRun(rt, 'api/explain-archive', () => rt.engine.explainArchiveCard(
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
        sendJson(res, 200, await apiRun(rt, 'api/note-source/register', () =>
          rt.engine.noteSourceRegister(need(body, 'path'))))
        return
      }
      if (route === '/note-source/unregister') {
        sendJson(res, 200, await apiRun(rt, 'api/note-source/unregister', () =>
          rt.engine.noteSourceUnregister(need(body, 'id'))))
        return
      }
      if (route === '/note-source/exclude') {
        // 用户排除清单（V-1 #86）：面板/agent 同一引擎通道；清单随 GET /note-sources 带出
        sendJson(res, 200, await apiRun(rt, 'api/note-source/exclude', () =>
          rt.engine.noteSourceExclude(need(body, 'path'))))
        return
      }
      if (route === '/note-source/unexclude') {
        sendJson(res, 200, await apiRun(rt, 'api/note-source/unexclude', () =>
          rt.engine.noteSourceUnexclude(need(body, 'path'))))
        return
      }
      if (route === '/note-source/relink') {
        // 漂移治理 relink（V-6 #109）：改名/移动后把既有源重连到新路径（卡池与调度保留）
        sendJson(res, 200, await apiRun(rt, 'api/note-source/relink', () =>
          rt.engine.noteSourceRelink(need(body, 'id'), need(body, 'path'))))
        return
      }
      if (route === '/note-source/generate') {
        // 笔记源出题（#59）：读笔记正文 → 笔记出题 prompt → validateBank 门禁落镜像
        sendJson(res, 200, await apiRun(rt, 'api/note-source/generate', () => rt.engine.noteSourceGenerate(
          need(body, 'id'), questionCount(body.count),
          async prompt => stripFences(await llmSeam(ctx)(prompt)))))
        return
      }
      if (route === '/anki/export') {
        // 导出到 Anki（C2 #63，#72 UI 挂接）：与 learnhub_anki_export 同一引擎通道
        // ——按 vault 到期集校准/重建镜象卡组（Anki 未开时 fail loud 带指引）
        sendJson(res, 200, await apiRun(rt, 'api/anki/export', () =>
          rt.engine.ankiExportPush(new AnkiConnectClient(ANKI_ENDPOINT))))
        return
      }
      if (route === '/anki/import') {
        // Anki 作答回写（C2 #63，#72 UI 挂接）：拉上次导入水位以来的复习事件，
        // 按 vault 自己的 ts-fsrs 重算调度（Anki 侧排期输出不作数）
        sendJson(res, 200, await apiRun(rt, 'api/anki/import', () =>
          rt.engine.ankiImportEvents(new AnkiConnectClient(ANKI_ENDPOINT))))
        return
      }
      if (route === '/optimize-params') {
        // FSRS 参数优化器手动触发（A2 #62，#72 UI 挂接）：门禁不满足/评估未更优
        // 时不写回，status=skipped + 原因随响应带出（统计页面板展示）
        sendJson(res, 200, await apiRun(rt, 'api/optimize-params', () => rt.engine.optimizeFsrsParams()))
        return
      }
      if (route === '/learner-rate') {
        // 「我的卡」自评结算（E1/#68）：一卡一天一次推进，隔离自调度
        sendJson(res, 200, await apiRun(rt, 'api/learner-rate', () => rt.engine.learnerCardRate(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), Number(body.rating))))
        return
      }
      if (route === '/learner-forget') {
        sendJson(res, 200, await apiRun(rt, 'api/learner-forget', () => rt.engine.learnerCardForget(
          need(body, 'course'), need(body, 'node'), need(body, 'card'))))
        return
      }
      if (route === '/error-answer') {
        // 「错误对比卡」作答（C-3/#82）：三选一自动判分，一卡一天一次，无绑定 XP
        sendJson(res, 200, await apiRun(rt, 'api/error-answer', () => rt.engine.errorCardAnswer(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), String(body.choice ?? ''))))
        return
      }
      if (route === '/error-generate') {
        // 「错误对比卡」生成（C-3/#82）：挖矿 → 模型出卡 → schema 门禁落盘
        sendJson(res, 200, await apiRun(rt, 'api/error-generate', () => rt.engine.errorCardGenerate(
          need(body, 'course'),
          {
            ...(typeof body.node === 'string' && body.node.trim() ? { node: body.node } : {}),
            ...(body.max !== undefined ? { max: Number(body.max) } : {}),
          },
          async prompt => stripFences(await llmSeam(ctx)(prompt)))))
        return
      }
      if (route === '/error-archive') {
        sendJson(res, 200, await apiRun(rt, 'api/error-archive', () => rt.engine.errorCardArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), Boolean(body.archived))))
        return
      }
      if (route === '/learner-add') {
        // E1「加我的理解」（#70）：写注当下 AI 对照该节要点给是非+定位反馈；判词入 E 档案
        sendJson(res, 200, await apiRun(rt, 'api/learner-add', () => rt.engine.learnerNoteAdd(
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
        sendJson(res, 200, await apiRun(rt, 'api/learner-archive', () => rt.engine.learnerCardArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'card'), body.archived)))
        return
      }
      if (route === '/question-generate') {
        // 出题任务化（#118）：入队即返回（phase=quiz 走全局队列），可取消、重启可恢复、
        // 与节点管线互斥；section = 定向补节（#117，count 缺省 3），instruction = 学习者
        // 意见生成指令（#120 提意见重生成）。
        sendJson(res, 200, await apiRun(rt, 'api/question-generate', async () => {
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
          return enqueueQuizGeneration(rt, ctx, course, node, {
            // count 缺省由引擎按模式取（定向补节 3、整节点 6）；给出时只做合法值校验
            ...(body.count !== undefined ? { count: questionCount(body.count) } : {}),
            ...(section ? { section } : {}),
            ...(instruction ? { instruction } : {}),
          })
        }))
        return
      }
      if (route === '/review') {
        sendJson(res, 200, { message: await rt.engine.contentReview(need(body, 'course'), need(body, 'node')) })
        return
      }
      if (route === '/question-save') {
        sendJson(res, 200, await rt.engine.questionSave(need(body, 'course'), need(body, 'node'), need(body, 'yaml')))
        return
      }
      if (route === '/question-answer') {
        sendJson(res, 200, await apiRun(rt, 'api/question-answer', () => rt.engine.questionAnswer(
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
        sendJson(res, 200, await apiRun(rt, 'api/question-rate', () => rt.engine.questionRate(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'), Number(body.rating))))
        return
      }
      if (route === '/question-forget') {
        // 复习刷卡流：「忘记」申报（不作答翻面，按答错记证据、0 XP）
        sendJson(res, 200, await apiRun(rt, 'api/question-forget', () => rt.engine.questionForget(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'),
          typeof body.elapsed_s === 'number' && Number.isFinite(body.elapsed_s) ? body.elapsed_s : null,
          typeof body.predicted === 'string' ? body.predicted as never : null)))
        return
      }
      if (route === '/question-dispute/review') {
        // 瑕疵题申诉复核（ADR-0031）：LLM 两阶段复核三态裁定，只读不落盘
        sendJson(res, 200, await apiRun(rt, 'api/question-dispute/review', () => rt.engine.questionDisputeReview(
          llmSeam(ctx),
          need(body, 'course'), need(body, 'node'), need(body, 'qid'))))
        return
      }
      if (route === '/question-dispute/apply') {
        // 申诉结算：rekey（改键重判可改判对）/ void（瑕疵题作废）/ overridden（强制豁免，不得分）
        sendJson(res, 200, await apiRun(rt, 'api/question-dispute/apply', () => {
          const resolution = body.resolution
          if (resolution !== 'rekey' && resolution !== 'void' && resolution !== 'overridden') {
            throw new Error('missing/invalid required field: resolution（rekey|void|overridden）')
          }
          const rawRevision = body.revision as { answer?: unknown; explanation?: unknown } | undefined
          return rt.engine.questionDisputeApply(
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
        sendJson(res, 200, await apiRun(rt, 'api/band-session', () => rt.engine.logBandSession({
          course: need(body, 'course'), node: need(body, 'node'),
          band: typeof body.band === 'string' ? body.band as never : 'standard',
          answered: Number(body.answered ?? 0), correct: Number(body.correct ?? 0),
        })))
        return
      }
      if (route === '/question-add') {
        const q = body.question
        if (typeof q !== 'object' || q === null) throw new Error('missing required field: question')
        sendJson(res, 200, await rt.engine.questionAdd(
          need(body, 'course'), need(body, 'node'), q as Record<string, unknown>))
        return
      }
      if (route === '/question-archive') {
        // reason = 归档原因（ADR-0032：too_easy=建议确认 / manual=人工等），可逆恢复时清除
        sendJson(res, 200, await rt.engine.questionArchive(
          need(body, 'course'), need(body, 'node'), need(body, 'qid'),
          body.archived === true, typeof body.reason === 'string' ? body.reason : undefined))
        return
      }
      if (route === '/difficulty-advice-dismiss') {
        // B2 建议忽略/恢复：误判的持久忽略（undo 恢复单条，all 清空全部；
        // all=true 时 course/node/qid 均不需要）
        sendJson(res, 200, await apiRun(rt, 'api/difficulty-advice-dismiss', () =>
          rt.engine.adviceDismiss(
            typeof body.course === 'string' ? body.course : '',
            typeof body.node === 'string' ? body.node : '',
            typeof body.qid === 'string' ? body.qid : undefined,
            body.undo === true, body.all === true)))
        return
      }
      if (route === '/bank-cleanup/apply') {
        // 题库一键清理应用（ADR-0032）：按当前预览规则现算候选并归档（reason=cleanup，可逆）
        sendJson(res, 200, await apiRun(rt, 'api/bank-cleanup/apply', () =>
          rt.engine.bankCleanupApply(typeof body.course === 'string' ? body.course : undefined)))
        return
      }
      if (route === '/course/delete') {
        const r = await rt.engine.courseDelete(need(body, 'course'))
        // 写侧联动（ADR-0039）：课程没了，注册表里它的任务记录（含排队/在途）随即出册
        await sweepGenJobs(rt)
        sendJson(res, 200, r)
        return
      }
      if (route === '/generate/cancel') {
        sendJson(res, 200, cancelGeneration(rt, need(body, 'course'), need(body, 'node')))
        return
      }
      if (route === '/coach/growth') {
        // 生长一步（面板下发 = 显式重新裁决，词条「生长批」）：即时入队、追加队尾、
        // 豁免停摆/暂不产结构阻尼；被拒时 message 带原因（在途/失败）。
        // 触发五点的检查点观测（读侧感知留运行日志）——入队本身不受检查结果闸：
        // 显式请求恒产一轮，就绪满足由教练回合停机转译为 idle。
        const growthCourse = need(body, 'course')
        void rt.engine.coachCheckpoint('panel_dispatch', growthCourse)
          .then(r => runLog(rt, 'coach_checkpoint(panel_dispatch)',
            r.courses.map(x => `${x.course}：ready=${x.ready}/${x.required}`).join('；')))
          .catch(() => undefined)
        sendJson(res, 200, await apiRun(rt, 'api/coach/growth', async () =>
          enqueueGrowthBatch(rt, ctx, growthCourse, '面板下发（显式重新裁决）', undefined, { force: true })))
        return
      }
      if (route === '/coach/compass') {
        // 罗盘初画/重画（#143 透明度装置）：LLM 一次调用进串行队列，不占请求
        sendJson(res, 200, await apiRun(rt, 'api/coach/compass', async () =>
          enqueueGraphJob(rt, ctx, { course: need(body, 'course'), node: '罗盘', phase: '罗盘' })))
        return
      }
      if (route === '/graph/backfill') {
        // 成分技能边回填（确定性推断，零 LLM）：同步受理，产物 = 富化提案待人审
        sendJson(res, 200, await apiRun(rt, 'api/graph/backfill', () =>
          rt.engine.graphEncBackfill(typeof body.course === 'string' && body.course.trim() ? body.course : undefined)))
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
        sendJson(res, 200, await apiRun(rt, 'api/seed/propose', async () =>
          enqueueGraphJob(rt, ctx, {
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
        sendJson(res, 200, await apiRun(rt, 'api/probation/settle', () => rt.engine.settleRechecks()))
        return
      }
      if (route === '/project/create') {
        // 项目创建（P 区 #92）：Project 是 Course 姊妹实体，零调度零 XP
        sendJson(res, 200, await apiRun(rt, 'api/project/create', () => rt.engine.projectCreate({
          name: need(body, 'name'),
          goal: need(body, 'goal'),
          ...(typeof body.tier === 'string' && body.tier.trim() ? { tier: body.tier.trim() as never } : {}),
        })))
        return
      }
      if (route === '/project/lifecycle') {
        sendJson(res, 200, await apiRun(rt, 'api/project/lifecycle', () =>
          rt.engine.projectSetLifecycle(need(body, 'id'), need(body, 'lifecycle'))))
        return
      }
      if (route === '/project/tier') {
        sendJson(res, 200, await apiRun(rt, 'api/project/tier', () =>
          rt.engine.projectSetTier(need(body, 'id'), need(body, 'tier'))))
        return
      }
      if (route === '/project/plan/generate') {
        // 计划草案任务化（面板下发）：LLM 起草进串行队列，不占请求
        const project = need(body, 'id')
        sendJson(res, 200, await apiRun(rt, 'api/project/plan/generate', async () =>
          enqueueGraphJob(rt, ctx, { course: project, node: '计划草案', phase: '计划', planPayload: { project } })))
        return
      }
      if (route === '/project/milestone/generate') {
        // 里程碑任务卡任务化（面板下发）
        const project = need(body, 'id')
        const milestone = need(body, 'milestone')
        sendJson(res, 200, await apiRun(rt, 'api/project/milestone/generate', async () =>
          enqueueGraphJob(rt, ctx, {
            course: project, node: `里程碑草案(${milestone})`, phase: '里程碑',
            milestonePayload: { project, milestone },
          })))
        return
      }
      if (route === '/project/decompile') {
        // 目标反编译（P-5 #95）任务化（面板下发）：计划+种子双提案进串行队列，提案页联合人审；
        // goal/notes 透传给引擎（缺省读项目档案目标 + 全部注册笔记，契约与 agent 工具一致）
        const project = need(body, 'id')
        sendJson(res, 200, await apiRun(rt, 'api/project/decompile', async () =>
          enqueueGraphJob(rt, ctx, {
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
        sendJson(res, 200, await apiRun(rt, 'api/project/exec', () => rt.engine.projectExecLog(need(body, 'id'), {
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
        sendJson(res, 200, await apiRun(rt, 'api/project/log', () =>
          rt.engine.projectLogAppend(need(body, 'id'), need(body, 'text'))))
        return
      }
      if (route === '/kata/save') {
        // 周复盘四问保存（U-4 #114）：patch 语义，现状引擎段不可写
        const answers = typeof body.answers === 'object' && body.answers !== null
          ? body.answers as Record<string, string> : {}
        sendJson(res, 200, await apiRun(rt, 'api/kata/save', () =>
          rt.engine.kataSave(need(body, 'week_start'), answers as never)))
        return
      }
      if (route === '/kata/convert/experiment') {
        // 「下一实验」一键转 N-of-1 提案（U-4↔D-1）
        const course = typeof body.course === 'string' && body.course.trim() ? body.course.trim() : undefined
        sendJson(res, 200, await apiRun(rt, 'api/kata/convert/experiment', () =>
          rt.engine.kataToExperiment(need(body, 'week_start'), need(body, 'template'), course)))
        return
      }
      if (route === '/kata/convert/intention') {
        // 「下一实验」一键转执行意图挂今日目标偏好（U-4↔C-5）
        sendJson(res, 200, await apiRun(rt, 'api/kata/convert/intention', () =>
          rt.engine.kataToIntention(need(body, 'week_start'), {
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
        sendJson(res, 200, await apiRun(rt, 'api/daily-goal', () => rt.engine.setDailyGoal(goal)))
        return
      }
      if (route === '/day-cutoff') {
        // 日界（ADR-0020）：学习日切换的本地时刻 'HH:mm'（非法值引擎 fail loud）
        if (typeof body.value !== 'string') throw new Error('missing required field: value')
        sendJson(res, 200, await apiRun(rt, 'api/day-cutoff', () => rt.engine.setDayCutoff(body.value)))
        return
      }
      if (route === '/jol') {
        // JOL 抽查配置（#66 E4）：enabled 全局开关 + rate 抽样率（0<r≤1）
        sendJson(res, 200, await apiRun(rt, 'api/jol', () => rt.engine.setJolConfig({
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(typeof body.rate === 'number' && Number.isFinite(body.rate) ? { rate: body.rate } : {}),
        })))
        return
      }
      if (route === '/calibration/hints') {
        // 过信轻提示全局开关（ADR-0022 #104）：显式布尔，缺省报错（fail loud）
        if (typeof body.hints_enabled !== 'boolean') throw new Error('missing required field: hints_enabled')
        sendJson(res, 200, await apiRun(rt, 'api/calibration/hints', () => rt.engine.setCalibrationHints(body.hints_enabled)))
        return
      }
      if (route === '/sleep') {
        // D-4 睡眠耦合建议层开关（#85）：enabled=false 全层静默
        sendJson(res, 200, await apiRun(rt, 'api/sleep', () => rt.engine.setSleepAdviceConfig({
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        })))
        return
      }
      if (route === '/question-update') {
        const patch = typeof body.patch === 'object' && body.patch !== null
          ? body.patch as Record<string, unknown> : {}
        sendJson(res, 200, await rt.engine.questionUpdate(need(body, 'course'), need(body, 'node'), need(body, 'qid'), patch))
        return
      }
    }
    sendJson(res, 404, { error: `unknown route: ${req.method} ${route}` })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}