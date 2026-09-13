/**
 * 面板路由·手写 handler 例外登记（#169；ADR-0045 裁定 2）。
 *
 * 只放**走不了生成路径**的命令（实测 76/125 条），四种原因（脚本实测分布见提交信息）：
 * 形状要加工（`{message: …}`／直调 host 函数／结果要算）／无单一入口（按参分派、队列受理、无引擎）／
 * 实参不可绑（领域负载、applyId 类换算、rt.vault）／面板独有键不在声明里（工具面 schema 权威，
 * 面板独有键不进 args）。其余 49 条由注册表声明驱动（`args` 校验 + `engine`/`bind` 直调）。
 *
 * 键是**路由**（method + path）：handler 是路由级事实（`/jol`、`/sleep` 各有一条通道走生成路径、
 * 另一条要 handler），命令级的 id 会让同命令的两条通道互相覆盖。门④ 断言本表键集合恰等于
 * 注册表里**没有 bind 的 panel 通道**集合。
 */
import type { Context } from '@deepseek-ai/cordis'
import { ANKI_ENDPOINT, AnkiConnectClient } from '../engine/index.ts'
import type { ProposalRec } from '../engine/types.ts'
import { applyId, bandPref, questionCount, rejectId, requireSkipDirection } from '../tool-contracts.ts'
import { sendJson } from './http.ts'
import {
  need, needQuery, optBoolean, optFinite, optList, optNumber, optObject, optQuery, optRaw, optString, optText, optTrimmed,
  optTrue, pick, requireBoolean, requireNumber, requireObject, requireOneOf, requireString,
} from './params.ts'
import { apiRun, runLog } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import type { RouteHandler } from './route-table.ts'
import { llmComplete, llmSeam, llmSeamStripped, llmView } from './llm.ts'
import { AGENT_GUIDE } from './tools.ts'
import { serveInteractive, serveVaultFile, serveVendor } from './static.ts'
import {
  afterGraphApply, cancelGeneration, coachTriggerDetached, enqueueGeneration, enqueueGraphJob,
  enqueueGrowthBatch, enqueueQuizGeneration, generateSection, generationStatus, resetCourseChain,
  resumeQueue, sessionStartCheckpoint, sweepGenJobs, triggerPlanGrowth,
} from './jobs.ts'

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
  return llmComplete(ctx, `${transcript}\n\n（请回答上面最后一条学习者的提问。）`, system,
    { capture: rt.corpus.record, station: '老师辅导' })
}

/** E2「讲给我听」（#68）：初学者人设讲解会话——explainBackPack（要点+图位置+人设
 * 指令）做 system，前端携带多轮对话历史（学习者的讲稿/回答 + AI 追问）。与 /tutor
 * 同层：只对话不落盘，判词存档只在显式的 /explain-feedback 收尾回合发生。 */
async function explainBackTurn(rt: HostRuntime, ctx: Context, course: string, node: string, history: unknown[]): Promise<string> {
  const system = await rt.engine.learner.explainBackPack(course, node)
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
  return llmComplete(ctx, `${transcript}\n\n（继续按你的角色追问或收尾。）`, system,
    { capture: rt.corpus.record, station: '讲给我听' })
}

/** 反编译双提案的联合 apply 目标（#156）：kind 命中 seed/project_plan、目标提案带 pair
 * 联动且仍 pending、另一半在 pending/applied（同进同退或崩溃续段）时返回联合入口的
 * 两半 id；其余返回 null 走统一 apply 单边路径——无 pair 的普通提案、目标已决
 * （takePending 的「已 applied」拒收语义要原样保留）、另一半已拒/缺失（单边守卫的
 * 精确拒收文案不改写）都不拦。 */
export function pairJointTarget(
  proposals: ReadonlyArray<Pick<ProposalRec, 'id' | 'kind' | 'status' | 'pair'>>,
  kind: string, pid?: number,
): { planPid: number; seedPid: number } | null {
  if (kind !== 'seed' && kind !== 'project_plan') return null
  const target = pid !== undefined
    ? proposals.find(p => p.id === pid)
    : [...proposals].reverse().find(p => p.status === 'pending' && p.kind === kind)
  if (!target || target.status !== 'pending' || !target.pair) return null
  const sibling = proposals.find(p => p.id === target.pair)
  if (!sibling || (sibling.status !== 'pending' && sibling.status !== 'applied')) return null
  const plan = target.kind === 'project_plan' ? target : sibling
  const seed = target.kind === 'seed' ? target : sibling
  if (plan.kind !== 'project_plan' || seed.kind !== 'seed') return null
  return { planPid: plan.id, seedPid: seed.id }
}

export const HANDLERS: Record<string, RouteHandler> = {
  'GET /status': async ({ rt, ctx, res }) => {
    // 模型透明：status 附带当前 LLM 配置（provider/model/思考档，面板只读展示）。
    // 会话开始触点（五点接线，30 分钟节流）：面板打开/轮询共用入口，fire-and-forget。
    sessionStartCheckpoint(rt, ctx)
    sendJson(res, 200, await apiRun(rt, 'api/status', async () => ({ ...(await rt.engine.statusJson()), llm: llmView() })))
  },
  'GET /courses': async ({ rt, res }) => {
    const list = (await rt.engine.registry.enabled()).map(c => ({
      name: c.name, root: c.root, enabled: String(c.enabled !== false),
    }))
    sendJson(res, 200, list)
  },
  'GET /recommend': async ({ rt, url, res }) => {
    const limit = Number(url.searchParams.get('limit') ?? '5')
    sendJson(res, 200, await apiRun(rt, 'api/recommend', () => rt.engine.recommend(Number.isFinite(limit) ? limit : 5)))
  },
  'GET /file': async ({ rt, url, res }) => {
    // 伺服 vault 内媒体文件（课程插图）；路径必须是 vault 相对且白名单扩展名（体在 static.ts）
    await serveVaultFile(rt, url, res)
  },
  'GET /vendor/': async ({ route, res }) => {
    // vendored 库同源伺服（katex/three）；路径限制在 web/vendor 内，MIME 白名单复用面板资产表（体在 static.ts）
    await serveVendor(res, route)
  },
  'GET /interactive': async ({ rt, url, res }) => {
    // 交互件伺服：限启用课程根内 .html；CSP 禁外联（体在 static.ts）
    await serveInteractive(rt, url, res)
  },
  'GET /note': async ({ rt, url, res }) => {
    const [path] = needQuery(url, 'path')
    sendJson(res, 200, await rt.engine.content2.resolveNote(rt.vault, path, rt.centerRel))
  },
  'GET /graph': async ({ rt, url, res }) => {
    const elementsOnly = url.searchParams.get('elements') === '1'
    sendJson(res, 200, await apiRun(rt, 'api/graph', () => rt.engine.graph.graphAnalyze(optQuery(url, 'course'), elementsOnly)))
  },
  'GET /review-queue': async ({ rt, url, res }) => {
    // 复习刷卡队列：跨课程到期题扁平队列，按预测遗忘风险 R 升序为主（r 字段随卡带出，#56）；
    // node 过滤 = 定向复习直达入口（A3 软闸/enc 回退建议项指向的目标节点，#54/#55），
    // 单节点会话按 Mastery 先验带自适应排序（band + 每卡 d，#57 A1）；
    // band 查询参数 = 显式难度带偏好（#65 E5：easy/hard 偏移目标带，standard/缺省 = 纯 A1）；
    // 卡片带 jol 标记（#66 E4）：抽查命中翻面前弹一档预测，可忽略
    sendJson(res, 200, await apiRun(rt, 'api/review-queue', () => rt.engine.content2.reviewQueue(
      optQuery(url, 'course'), optQuery(url, 'node'), undefined, bandPref(url.searchParams.get('band')))))
  },
  'GET /probation': async ({ rt, url, res }) => {
    // 插入实验面（#146）：在途插入节点（「实验中」标记取数）、到期未决、三率
    // （滚动 30 学习日）与韧性闸门现势；course 缺省 = 全部启用课程
    sendJson(res, 200, await apiRun(rt, 'api/probation', () => rt.engine.growth2.probationStatus(optQuery(url, 'course'))))
  },
  'GET /experiments': async ({ rt, res }) => {
    // D-1 N-of-1 实验（#110 ADR-0023）：模板库 + 实验清单 + 报告（无实验时 report=null）
    sendJson(res, 200, await apiRun(rt, 'api/experiments', async () => {
      const experiments = await rt.engine.lab.experimentList()
      let report = null
      if (experiments.length) {
        try {
          report = await rt.engine.lab.experimentReport()
        } catch {
          report = null
        }
      }
      return { templates: await rt.engine.lab.experimentTemplates(), experiments, report }
    }))
  },
  'GET /generate/status': async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/generate/status', () => generationStatus(rt)))
  },
  'GET /explain-pack': async ({ rt, url, res }) => {
    // 错误当下「讲解这道题」逐题包（Arc D #64）：客户端桥注入宿主会话的首条消息原料
    const [node, qid] = needQuery(url, 'node', 'qid')
    sendJson(res, 200, await apiRun(rt, 'api/explain-pack', () => rt.engine.errorExplainPack(optQuery(url, 'course'), node, qid)))
  },
  'GET /anki/status': async ({ rt, res }) => {
    // Anki 通道状态（C2 #63，#72 UI 挂接）：镜象/最近推送与回写/当前到期分布
    // + AnkiConnect 可达性（连接失败不抛，status.anki.connected=false 带原因）
    sendJson(res, 200, await apiRun(rt, 'api/anki/status', () =>
      rt.engine.channels.ankiStatus(new AnkiConnectClient(ANKI_ENDPOINT))))
  },
  'GET /agent-guide': async ({ res }) => {
    // 能力指南：agent 独有工具的面板说明锚点（AGENT_GUIDE 单一事实源）
    sendJson(res, 200, AGENT_GUIDE)
  },
  'GET /bank-cleanup': async ({ rt, url, res }) => {
    // 题库一键清理预览（ADR-0032，只读）：跳过节点全部未归档题 + 已完成节点休眠题
    sendJson(res, 200, await apiRun(rt, 'api/bank-cleanup', () => rt.engine.bank2.bankCleanupPreview(optQuery(url, 'course'))))
  },
  'PUT /jol': async ({ rt, body, res }) => {
    // JOL 抽查配置（#66 E4）：enabled 全局开关 + rate 抽样率（0<r≤1）
    sendJson(res, 200, await apiRun(rt, 'api/jol', () => rt.engine.learner.setJolConfig({
      ...pick('enabled', optBoolean(body, 'enabled')),
      ...pick('rate', optFinite(body, 'rate')),
    })))
  },
  'PUT /calibration/hints': async ({ rt, body, res }) => {
    // 过信轻提示全局开关（ADR-0022 #104）：显式布尔，缺省报错（fail loud）
    sendJson(res, 200, await apiRun(rt, 'api/calibration/hints',
      () => rt.engine.learner.setCalibrationHints(requireBoolean(body, 'hints_enabled'))))
  },
  'PUT /sleep': async ({ rt, body, res }) => {
    // D-4 睡眠耦合建议层开关（#85）：enabled=false 全层静默
    sendJson(res, 200, await apiRun(rt, 'api/sleep', () => rt.engine.lab.setSleepAdviceConfig({
      ...pick('enabled', optBoolean(body, 'enabled')),
    })))
  },
  'PUT /question-update': async ({ rt, body, res }) => {
    sendJson(res, 200, await rt.engine.bank2.questionUpdate(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'), optObject(body, 'patch') ?? {}))
  },
  'POST /habits/create': async ({ rt, body, res }) => {
    // 习惯创建（#90）：意图两字段（线索/行动）由引擎 fail loud 校验
    sendJson(res, 200, await apiRun(rt, 'api/habits/create', () => rt.engine.learner.habitCreate({
      name: need(body, 'name'), cue: need(body, 'cue'), action: need(body, 'action'),
    })))
  },
  'POST /habits/repeat': async ({ rt, body, res }) => {
    // 自报重复（#90）：唯一计数来源，无门禁；可选自动化自评 1-5
    sendJson(res, 200, await apiRun(rt, 'api/habits/repeat', () => rt.engine.learner.habitRepeat(need(body, 'habit'), {
      ...pick('auto_rating', optNumber(body, 'auto_rating')),
      ...pick('note', optText(body, 'note')),
    })))
  },
  'POST /habits/archive': async ({ rt, body, res }) => {
    const archived = requireBoolean(body, 'archived')
    sendJson(res, 200, await apiRun(rt, 'api/habits/archive', () =>
      rt.engine.learner.habitArchive(need(body, 'habit'), archived)))
  },
  'POST /skills/archive': async ({ rt, body, res }) => {
    const archived = requireBoolean(body, 'archived')
    sendJson(res, 200, await apiRun(rt, 'api/skills/archive', () =>
      rt.engine.learner.skillArchive(need(body, 'skill'), archived)))
  },
  'POST /skills/maintenance': async ({ rt, body, res }) => {
    // 维持节拍帽（#89）：天数或 null（关闭）
    sendJson(res, 200, await apiRun(rt, 'api/skills/maintenance', () =>
      rt.engine.learner.skillSetMaintenance(need(body, 'skill'), body.days == null ? null : requireNumber(body, 'days'))))
  },
  'POST /rebuild': async ({ rt, res }) => {
    sendJson(res, 200, { message: (await rt.engine.rebuild()).message })
  },
  'POST /node/skip': async ({ rt, ctx, body, res }) => {
    // 跳过 = 显式重新裁决（词条「教练回合」五点之一）：force 豁免停摆/暂不产结构
    // 阻尼——跳过改了症状与路线，上一次停摆裁决不再代表现状；路由返回后 fire-and-forget
    const skipped = await apiRun(rt, 'api/node/skip', () =>
      rt.engine.sched2.nodeSkip(need(body, 'course'), need(body, 'node'), requireSkipDirection(body.skipped)))
    coachTriggerDetached(rt, ctx, 'node_skip', need(body, 'course'), { force: true })
    sendJson(res, 200, skipped)
  },
  'POST /node/pin': async ({ rt, body, res }) => {
    // 「今天学它」pin（E3 #67）：显式方向——pinned=true 置顶当日推荐榜首（只改
    // 排序、保留就绪提示、次日自动失效），false 取消。
    const pinned = requireBoolean(body, 'pinned')
    const out = pinned
      ? await rt.engine.learner.pinToday(need(body, 'course'), need(body, 'node'))
      : await rt.engine.learner.unpinToday(need(body, 'course'), need(body, 'node'))
    sendJson(res, 200, await apiRun(rt, 'api/node/pin', async () => out))
  },
  'POST /node/complete': async ({ rt, ctx, body, res }) => {
    // 完成 = 教练回合触发点之一（五点接线）：自动触点走阻尼；路由返回后 fire-and-forget
    const done = await apiRun(rt, 'api/node/complete', () =>
      rt.engine.sched2.nodeComplete(need(body, 'course'), need(body, 'node'), optTrue(body, 'force')))
    coachTriggerDetached(rt, ctx, 'node_complete', need(body, 'course'))
    sendJson(res, 200, done)
  },
  'POST /feedback': async ({ rt, body, res }) => {
    sendJson(res, 200, { message: await rt.engine.content2.submitFeedback(rt.vault, rt.centerRel, need(body, 'path')) })
  },
  'POST /proposals/apply': async ({ rt, ctx, body, res }) => {
    // 提案统一 apply（图谱域 edit/seed/enrich + 项目域 project_plan/project_milestone）：
    // kind 必须显式照抄提案记录，未知 kind 引擎报错；
    // 反编译双提案（pair 联动）检测到即自动走联合入口（#156）——纯面板用户不再被
    // 「用 learnhub_project_decompile_apply」的拒收文案指向 agent 会话（ADR-0038 补完）；
    // 计划修订触发的换线/补支生长批随后入队（#149；联合结果从 plan 半区取触发）；
    // 种子应用后起点正文自动入队（#160：提案一过、内容就在酿，生成页可见——
    // 联合入口的种子半区同样触发）
    const kind = need(body, 'kind')
    const id = applyId(body.id)
    // pair 检测只对参与反编译对的 kind 取提案列表（其余 kind 不多打一次引擎）
    const joint = kind === 'seed' || kind === 'project_plan'
      ? pairJointTarget(await rt.engine.graph.graphProposals(), kind, id)
      : null
    const applied = joint
      ? await rt.engine.project.projectDecompileApply(joint.planPid, joint.seedPid)
      : await rt.engine.graph.proposalApply(kind, id)
    const planPart = applied as { plan?: { kind?: string; growth?: Array<{ course: string; lines: string[] }> } }
    triggerPlanGrowth(rt, ctx, planPart.plan ?? (applied as { kind?: string }))
    // 种子链（#160）：单发种子 = applied 本身；联合入口 = 种子半区（仅计划半区受理时为 null）
    const seedHalf = joint
      ? (applied as { seed?: { course: string; starts: string[] } | null }).seed ?? null
      : kind === 'seed' ? applied as { course: string; starts: string[] } : null
    await afterGraphApply(rt, ctx, seedHalf)
    sendJson(res, 200, applied)
  },
  'POST /proposals/reject': async ({ rt, body, res }) => {
    const id = rejectId(body.id)
    await rt.engine.graph.graphReject(id, optString(body, 'note').trim())
    sendJson(res, 200, { message: `[reject] 提案 #${id} 已拒绝留痕。` })
  },
  'POST /experiments/apply': async ({ rt, body, res }) => {
    // D-1 实验确认开跑（#110 提案-确认制第二步）
    sendJson(res, 200, await apiRun(rt, 'api/experiments/apply', () =>
      rt.engine.lab.experimentApply(applyId(body.id))))
  },
  'POST /experiments/stop': async ({ rt, body, res }) => {
    // D-1 实验手动停止（开停手动，ADR-0023）
    const id = body.id === undefined || body.id === null ? undefined : applyId(body.id)
    sendJson(res, 200, await apiRun(rt, 'api/experiments/stop', () => rt.engine.lab.experimentStop(id)))
  },
  'POST /sandbox/run': async ({ rt, body, res }) => {
    // D-3 沙盘（#112 ADR-0025）：只读蒙特卡洛推演，零写侧
    const minutes = requireNumber(body, 'minutes_per_day')
    const weeks = body.weeks === undefined ? undefined : Number(body.weeks)
    const course = optTrimmed(body, 'course')
    const nodes = optList(body, 'nodes')?.filter((n): n is string => typeof n === 'string')
    sendJson(res, 200, await apiRun(rt, 'api/sandbox/run', () => rt.engine.lab.sandboxRun({
      minutesPerDay: minutes,
      ...pick('weeks', weeks !== undefined && Number.isFinite(weeks) ? weeks : undefined),
      ...pick('course', course),
      ...(nodes?.length ? { nodes } : {}),
    })))
  },
  'POST /generate': async ({ rt, ctx, body, res }) => {
    // 入队即返回：全局串行队列后台按序执行（大纲 → 逐节正文 → 自动出题，数分钟/节点）
    const style = optTrimmed(body, 'style')
    sendJson(res, 200, await apiRun(rt, 'api/generate', async () =>
      enqueueGeneration(rt, ctx, need(body, 'course'), need(body, 'node'), style)))
  },
  'POST /generate/resume': async ({ rt, ctx, res }) => {
    // 恢复重启后暂停的队列（遗留排队任务不自动开跑，防静默烧 token）
    sendJson(res, 200, await apiRun(rt, 'api/generate/resume', async () => resumeQueue(rt, ctx)))
  },
  'POST /generate/section': async ({ rt, ctx, body, res }) => {
    // 单节重写：指定节 id 重新生成并过门（LessonView 节重写入口）
    sendJson(res, 200, await apiRun(rt, 'api/generate/section', async () => ({
      message: await generateSection(rt, ctx, need(body, 'course'), need(body, 'node'), need(body, 'section')),
    })))
  },
  'POST /course/reset': async ({ rt, ctx, body, res }) => {
    // 整课重新生成：重置（旧内容备份进 .trash）→ 按拓扑序串行重跑生成管线。
    // 重生成链后台执行，HTTP 立即返回；进度由任务注册表展示（面板 5s 轮询）。
    sendJson(res, 200, await apiRun(rt, 'api/course/reset', async () =>
      resetCourseChain(rt, ctx, need(body, 'course'))))
  },
  'POST /interactive/settle': async ({ rt, body, res }) => {
    // 交互件成绩结算（LEARNHUB_COMPLETE 上报；同节同日一次，防刷）
    const score = Number(body.score)
    sendJson(res, 200, await apiRun(rt, 'api/interactive/settle', () => rt.engine.bank2.interactiveSettle(
      need(body, 'course'), need(body, 'node'), need(body, 'section'),
      Number.isFinite(score) ? score : 0,
      optRaw(body, 'detail'))))
  },
  'POST /tutor': async ({ rt, ctx, body, res }) => {
    // 面板内轻量答疑：前端持有对话历史全量携带（最后一条必须是学习者提问）
    const history = optList(body, 'messages') ?? []
    sendJson(res, 200, await apiRun(rt, 'api/tutor', async () => ({
      answer: await tutorChat(rt, ctx, need(body, 'course'), need(body, 'node'), history),
    })))
  },
  'POST /explain-back': async ({ rt, ctx, body, res }) => {
    // E2「讲给我听」（#68）：初学者人设追问会话——包做 system，前端全量携带对话历史
    const history = optList(body, 'messages') ?? []
    sendJson(res, 200, await apiRun(rt, 'api/explain-back', async () => ({
      answer: await explainBackTurn(rt, ctx, need(body, 'course'), need(body, 'node'), history),
    })))
  },
  'POST /explain-feedback': async ({ rt, ctx, body, res }) => {
    // E2 定位反馈回合（#68）：对照要点给是非+定位+怎么补；判词只入 E 档案
    sendJson(res, 200, await apiRun(rt, 'api/explain-feedback', () => rt.engine.learner.explainBackFeedback(
      need(body, 'course'), need(body, 'node'), optString(body, 'transcript'), llmSeam(ctx, rt.corpus.record, '讲解反馈'))))
  },
  'POST /explain-archive': async ({ rt, body, res }) => {
    // E2 存档（#68）：把这版讲稿存成 E1 自注卡（再讲一遍/挖空重述两档）
    sendJson(res, 200, await apiRun(rt, 'api/explain-archive', () => rt.engine.learner.explainArchiveCard(
      need(body, 'course'), need(body, 'node'), {
        content: optString(body, 'content'),
        ...pick('kind', optRaw(body, 'kind') as 'recall_cue' | 'cloze_rewrite' | undefined),
        ...pick('prompt', optText(body, 'prompt')),
        ...pick('section', optText(body, 'section')),
      })))
  },
  'POST /note-source/generate': async ({ rt, ctx, body, res }) => {
    // 笔记源出题（#59）：读笔记正文 → 笔记出题 prompt → validateBank 门禁落镜像
    sendJson(res, 200, await apiRun(rt, 'api/note-source/generate', () => rt.engine.channels.noteSourceGenerate(
      need(body, 'id'), questionCount(body.count),
      llmSeamStripped(ctx, rt.corpus.record, '笔记出题'))))
  },
  'POST /anki/export': async ({ rt, res }) => {
    // 导出到 Anki（C2 #63，#72 UI 挂接）：与 learnhub_anki_export 同一引擎通道
    // ——按 vault 到期集校准/重建镜象卡组（Anki 未开时 fail loud 带指引）
    sendJson(res, 200, await apiRun(rt, 'api/anki/export', () =>
      rt.engine.channels.ankiExportPush(new AnkiConnectClient(ANKI_ENDPOINT))))
  },
  'POST /anki/import': async ({ rt, res }) => {
    // Anki 作答回写（C2 #63，#72 UI 挂接）：拉上次导入水位以来的复习事件，
    // 按 vault 自己的 ts-fsrs 重算调度（Anki 侧排期输出不作数）
    sendJson(res, 200, await apiRun(rt, 'api/anki/import', () =>
      rt.engine.channels.ankiImportEvents(new AnkiConnectClient(ANKI_ENDPOINT))))
  },
  'POST /learner-rate': async ({ rt, body, res }) => {
    // 「我的卡」自评结算（E1/#68）：一卡一天一次推进，隔离自调度
    sendJson(res, 200, await apiRun(rt, 'api/learner-rate', () => rt.engine.learner.learnerCardRate(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), Number(body.rating))))
  },
  'POST /error-answer': async ({ rt, body, res }) => {
    // 「错误对比卡」作答（C-3/#82）：三选一自动判分，一卡一天一次，无绑定 XP
    sendJson(res, 200, await apiRun(rt, 'api/error-answer', () => rt.engine.bank2.errorCardAnswer(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), String(body.choice ?? ''))))
  },
  'POST /error-generate': async ({ rt, ctx, body, res }) => {
    // 「错误对比卡」生成（C-3/#82）：挖矿 → 模型出卡 → schema 门禁落盘
    sendJson(res, 200, await apiRun(rt, 'api/error-generate', () => rt.engine.bank2.errorCardGenerate(
      need(body, 'course'),
      {
        ...pick('node', optText(body, 'node')),
        ...(body.max !== undefined ? { max: Number(body.max) } : {}),
      },
      llmSeamStripped(ctx, rt.corpus.record, '错误对比卡'))))
  },
  'POST /error-archive': async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/error-archive', () => rt.engine.bank2.errorCardArchive(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), Boolean(body.archived))))
  },
  'POST /learner-add': async ({ rt, ctx, body, res }) => {
    // E1「加我的理解」（#70）：写注当下 AI 对照该节要点给是非+定位反馈；判词入 E 档案
    sendJson(res, 200, await apiRun(rt, 'api/learner-add', () => rt.engine.learner.learnerNoteAdd(
      need(body, 'course'), need(body, 'node'), {
        content: optString(body, 'content'),
        ...pick('kind', optText(body, 'kind') as never),
        ...pick('prompt', optText(body, 'prompt')),
        ...pick('section', optText(body, 'section')),
      }, llmSeam(ctx, rt.corpus.record, '自注反馈'))))
  },
  'POST /learner-archive': async ({ rt, body, res }) => {
    const archived = requireBoolean(body, 'archived')
    sendJson(res, 200, await apiRun(rt, 'api/learner-archive', () => rt.engine.learner.learnerCardArchive(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), archived)))
  },
  'POST /question-generate': async ({ rt, ctx, body, res }) => {
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
      const instruction = optTrimmed(body, 'instruction')
      return enqueueQuizGeneration(rt, ctx, course, node, {
        // count 缺省由引擎按模式取（定向补节 3、整节点 6）；给出时只做合法值校验
        ...(body.count !== undefined ? { count: questionCount(body.count) } : {}),
        ...(section ? { section } : {}),
        ...(instruction ? { instruction } : {}),
      })
    }))
  },
  'POST /review': async ({ rt, body, res }) => {
    sendJson(res, 200, { message: await rt.engine.content2.contentReview(need(body, 'course'), need(body, 'node')) })
  },
  'POST /question-answer': async ({ rt, ctx, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/question-answer', () => rt.engine.content2.questionAnswer(
      llmSeam(ctx, rt.corpus.record, '判卷'),
      need(body, 'course'), need(body, 'node'), need(body, 'qid'),
      optString(body, 'answer'),
      optFinite(body, 'elapsed_s') ?? null,
      {
        ...(optTrue(body, 'defer_schedule') ? { deferSchedule: true } : {}),
        // 翻面前的 JOL 预测（#66 E4）：缺省/非法由引擎显式契约拒绝
        ...pick('predicted', optRaw(body, 'predicted') as never),
      })))
  },
  'POST /question-rate': async ({ rt, body, res }) => {
    // 复习刷卡流：答对后的自评难度结算（2/3/4 → FSRS Hard/Good/Easy）
    sendJson(res, 200, await apiRun(rt, 'api/question-rate', () => rt.engine.content2.questionRate(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'), Number(body.rating))))
  },
  'POST /question-forget': async ({ rt, body, res }) => {
    // 复习刷卡流：「忘记」申报（不作答翻面，按答错记证据、0 XP）
    sendJson(res, 200, await apiRun(rt, 'api/question-forget', () => rt.engine.content2.questionForget(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'),
      optFinite(body, 'elapsed_s') ?? null,
      (optRaw(body, 'predicted') ?? null) as never)))
  },
  'POST /question-dispute/review': async ({ rt, ctx, body, res }) => {
    // 瑕疵题申诉复核（ADR-0031）：LLM 两阶段复核三态裁定，只读不落盘
    sendJson(res, 200, await apiRun(rt, 'api/question-dispute/review', () => rt.engine.bank2.questionDisputeReview(
      llmSeam(ctx, rt.corpus.record, '申诉判卷'),
      need(body, 'course'), need(body, 'node'), need(body, 'qid'))))
  },
  'POST /question-dispute/apply': async ({ rt, body, res }) => {
    // 申诉结算：rekey（改键重判可改判对）/ void（瑕疵题作废）/ overridden（强制豁免，不得分）
    // 守卫留在 apiRun 回调内（今天就在这里）：失败时运行日志留痕的语义随之不变
    sendJson(res, 200, await apiRun(rt, 'api/question-dispute/apply', () => {
      const resolution = requireOneOf(body, 'resolution', ['rekey', 'void', 'overridden'] as const)
      const rawRevision = body.revision as { answer?: unknown; explanation?: unknown } | undefined
      return rt.engine.bank2.questionDisputeApply(
        need(body, 'course'), need(body, 'node'), need(body, 'qid'), resolution, {
          ...pick('targetTs', optRaw(body, 'target_ts')),
          ...(typeof rawRevision === 'object' && rawRevision !== null
            ? { revision: { answer: rawRevision.answer, ...(typeof rawRevision.explanation === 'string' ? { explanation: rawRevision.explanation } : {}) } } : {}),
          ...pick('reason', optRaw(body, 'reason')),
        })
    }))
  },
  'POST /band-session': async ({ rt, body, res }) => {
    // 难度带会话日志（E5 #65）：会话结束反馈点落一条带选择与作答结算（教练数据源）
    sendJson(res, 200, await apiRun(rt, 'api/band-session', () => rt.engine.learner.logBandSession({
      course: need(body, 'course'), node: need(body, 'node'),
      band: (optRaw(body, 'band') ?? 'standard') as never,
      answered: Number(body.answered ?? 0), correct: Number(body.correct ?? 0),
    })))
  },
  'POST /question-add': async ({ rt, body, res }) => {
    const q = requireObject(body, 'question')
    sendJson(res, 200, await rt.engine.bank2.questionAdd(
      need(body, 'course'), need(body, 'node'), q))
  },
  'POST /question-archive': async ({ rt, body, res }) => {
    // reason = 归档原因（ADR-0032：too_easy=建议确认 / manual=人工等），可逆恢复时清除
    sendJson(res, 200, await rt.engine.bank2.questionArchive(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'),
      optTrue(body, 'archived'), optRaw(body, 'reason')))
  },
  'POST /difficulty-advice-dismiss': async ({ rt, body, res }) => {
    // B2 建议忽略/恢复：误判的持久忽略（undo 恢复单条，all 清空全部；
    // all=true 时 course/node/qid 均不需要）
    sendJson(res, 200, await apiRun(rt, 'api/difficulty-advice-dismiss', () =>
      rt.engine.bank2.adviceDismiss(
        optString(body, 'course'),
        optString(body, 'node'),
        optRaw(body, 'qid'),
        optTrue(body, 'undo'), optTrue(body, 'all'))))
  },
  'POST /course/delete': async ({ rt, body, res }) => {
    const r = await rt.engine.bank2.courseDelete(need(body, 'course'))
    // 写侧联动（ADR-0039）：课程没了，注册表里它的任务记录（含排队/在途）随即出册
    await sweepGenJobs(rt)
    sendJson(res, 200, r)
  },
  'POST /generate/cancel': async ({ rt, body, res }) => {
    sendJson(res, 200, cancelGeneration(rt, need(body, 'course'), need(body, 'node')))
  },
  'POST /coach/growth': async ({ rt, ctx, body, res }) => {
    // 生长一步 / 失败重试（面板下发 = 显式重新裁决，词条「生长批」）：即时入队、追加队尾、
    // 豁免停摆/暂不产结构与失败阻尼（#157：失败通知与生成页的「重试」走同一路由）；
    // 被拒时 message 带原因（在途/已取消）。
    // 触发五点的检查点观测（读侧感知留运行日志）——入队本身不受检查结果闸：
    // 显式请求恒产一轮，就绪满足由教练回合停机转译为 idle。
    const growthCourse = need(body, 'course')
    void rt.engine.growth2.coachCheckpoint('panel_dispatch', growthCourse)
      .then(r => runLog(rt, 'coach_checkpoint(panel_dispatch)',
        r.courses.map(x => `${x.course}：ready=${x.ready}/${x.required}`).join('；')))
      .catch(() => undefined)
    sendJson(res, 200, await apiRun(rt, 'api/coach/growth', async () =>
      enqueueGrowthBatch(rt, ctx, growthCourse, '面板下发（显式重新裁决）', undefined, { force: true })))
  },
  'POST /coach/compass': async ({ rt, ctx, body, res }) => {
    // 罗盘初画/重画（#143 透明度装置）：LLM 一次调用进串行队列，不占请求
    sendJson(res, 200, await apiRun(rt, 'api/coach/compass', async () =>
      enqueueGraphJob(rt, ctx, { course: need(body, 'course'), node: '罗盘', phase: 'compass' })))
  },
  'POST /seed/propose': async ({ rt, ctx, body, res }) => {
    // 建课/换终点起草（面板下发，phase=种子）：表单绑定字段随任务携带进引擎
    const seedCourse = need(body, 'course')
    const goal = need(body, 'goal')
    const worksheet = optList(body, 'worksheet')
      ?.filter((w): w is { block?: unknown; note?: unknown } => typeof w === 'object' && w !== null)
      .map(w => ({
        block: typeof w.block === 'string' ? w.block : '',
        ...(typeof w.note === 'string' && w.note.trim() ? { note: w.note } : {}),
      }))
      .filter(w => w.block.trim()) ?? []
    sendJson(res, 200, await apiRun(rt, 'api/seed/propose', async () =>
      enqueueGraphJob(rt, ctx, {
        course: seedCourse, node: '种子起草', phase: 'seed',
        seedPayload: {
          goal,
          mode: body.mode === 'reseed' ? 'reseed' : 'new',
          goalType: body.goalType === 'coverage' ? 'coverage' : 'capability',
          useVaultPrior: optTrue(body, 'useVaultPrior'),
          worksheet,
        },
      })))
  },
  'POST /project/create': async ({ rt, body, res }) => {
    // 项目创建（P 区 #92）：Project 是 Course 姊妹实体，零调度零 XP
    sendJson(res, 200, await apiRun(rt, 'api/project/create', () => rt.engine.project.projectCreate({
      name: need(body, 'name'),
      goal: need(body, 'goal'),
      ...pick('tier', optTrimmed(body, 'tier') as never),
    })))
  },
  'POST /project/plan/generate': async ({ rt, ctx, body, res }) => {
    // 计划草案任务化（面板下发）：LLM 起草进串行队列，不占请求
    const project = need(body, 'id')
    sendJson(res, 200, await apiRun(rt, 'api/project/plan/generate', async () =>
      enqueueGraphJob(rt, ctx, { course: project, node: '计划草案', phase: 'plan', planPayload: { project } })))
  },
  'POST /project/milestone/generate': async ({ rt, ctx, body, res }) => {
    // 里程碑任务卡任务化（面板下发）
    const project = need(body, 'id')
    const milestone = need(body, 'milestone')
    sendJson(res, 200, await apiRun(rt, 'api/project/milestone/generate', async () =>
      enqueueGraphJob(rt, ctx, {
        course: project, node: `里程碑草案(${milestone})`, phase: 'milestone',
        milestonePayload: { project, milestone },
      })))
  },
  'POST /project/decompile': async ({ rt, ctx, body, res }) => {
    // 目标反编译（P-5 #95）任务化（面板下发）：计划+种子双提案进串行队列，提案页联合人审；
    // goal/notes 透传给引擎（缺省读项目档案目标 + 全部注册笔记，契约与 agent 工具一致）
    const project = need(body, 'id')
    sendJson(res, 200, await apiRun(rt, 'api/project/decompile', async () =>
      enqueueGraphJob(rt, ctx, {
        course: project, node: '反编译', phase: 'decompile',
        decompilePayload: {
          project,
          ...pick('goal', optText(body, 'goal')),
          ...pick('course', optTrimmed(body, 'course')),
          ...pick('notes', optList(body, 'notes')?.filter((n): n is string => typeof n === 'string' && !!n.trim())),
        },
      })))
  },
  'POST /project/exec': async ({ rt, body, res }) => {
    // 项目执行事件落流（P-7 #98）：评级 1-4 + 来源；nodes = 本次行使的关联节点
    // （被行使 enc 边两端节点各回流一次练习证据）。零 XP、零调度写入。
    // evidence（auto 来源的可观测证据）与 nodes 原样透传——校验收口在门面
    // validateExecEvent/ratingFromEvidence（fail loud），路由不做静默变形。
    const evidence = optObject(body, 'evidence')
    sendJson(res, 200, await apiRun(rt, 'api/project/exec', () => rt.engine.project.projectExecLog(need(body, 'id'), {
      source: need(body, 'source'),
      ...pick('rating', optNumber(body, 'rating')),
      ...pick('evidence', evidence),
      ...pick('nodes', optList(body, 'nodes')),
      ...pick('note', optTrimmed(body, 'note')),
    })))
  },
  'POST /kata/save': async ({ rt, body, res }) => {
    // 周复盘四问保存（U-4 #114）：patch 语义，现状引擎段不可写
    const answers = optObject(body, 'answers') ?? {}
    sendJson(res, 200, await apiRun(rt, 'api/kata/save', () =>
      rt.engine.learner.kataSave(need(body, 'week_start'), answers as never)))
  },
  'POST /kata/convert/intention': async ({ rt, body, res }) => {
    // 「下一实验」一键转执行意图挂今日目标偏好（U-4↔C-5）
    sendJson(res, 200, await apiRun(rt, 'api/kata/convert/intention', () =>
      rt.engine.learner.kataToIntention(need(body, 'week_start'), {
        course: need(body, 'course'), node: need(body, 'node'),
        cue: need(body, 'cue'), action: need(body, 'action'),
      })))
  },
}
