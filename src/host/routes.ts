/**
 * 面板路由表·GET 段与 PUT 段（#168：if 链 → 数据表）。
 *
 * GET 46 条（含前缀路由 `/vendor/`）＋ PUT 6 条，逐条自 `handleApi` 的 if 链搬入，
 * **方法／路径／响应形状逐字不变**（证据：tests/host-routes.test.ts 全量重放 464 条探针，
 * 与重构前捕获的快照逐字比对）。参数守卫一律经 params.ts 的唯一语义；
 * POST 段是子表（src/host/routes-post.ts），分发在 api.ts。
 */
import { ANKI_ENDPOINT, AnkiConnectClient } from '../engine/index.ts'
import { bandPref } from '../tool-contracts.ts'
import { sendJson } from './http.ts'
import {
  need, needQuery, optBoolean, optFinite, optObject, optQuery, pick,
  requireBoolean, requireNumber, requireString,
} from './params.ts'
import { apiRun } from './runtime.ts'
import { serveInteractive, serveVaultFile, serveVendor } from './static.ts'
import { AGENT_GUIDE } from './tools.ts'
import { llmView } from './llm.ts'
import { generationStatus, sessionStartCheckpoint } from './jobs.ts'
import { get, getPrefix, put } from './route-table.ts'
import type { RouteSpec } from './route-table.ts'

export const getRoutes: RouteSpec[] = [
  get('/status', async ({ rt, ctx, res }) => {
    // 模型透明：status 附带当前 LLM 配置（provider/model/思考档，面板只读展示）。
    // 会话开始触点（五点接线，30 分钟节流）：面板打开/轮询共用入口，fire-and-forget。
    sessionStartCheckpoint(rt, ctx)
    sendJson(res, 200, await apiRun(rt, 'api/status', async () => ({ ...(await rt.engine.statusJson()), llm: llmView() })))
  }),
  get('/courses', async ({ rt, res }) => {
    const list = (await rt.engine.enabledCourses()).map(c => ({
      name: c.name, root: c.root, enabled: String(c.enabled !== false),
    }))
    sendJson(res, 200, list)
  }),
  get('/lesson', async ({ rt, url, res }) => {
    const [node] = needQuery(url, 'node')
    sendJson(res, 200, await apiRun(rt, 'api/lesson', () => rt.engine.lesson(optQuery(url, 'course'), node)))
  }),
  get('/recommend', async ({ rt, url, res }) => {
    const limit = Number(url.searchParams.get('limit') ?? '5')
    sendJson(res, 200, await apiRun(rt, 'api/recommend', () => rt.engine.recommend(Number.isFinite(limit) ? limit : 5)))
  }),
  get('/queue', async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/queue', () => rt.engine.queueItemsAll()))
  }),
  get('/courses/tree', async ({ rt, url, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/courses/tree', () => rt.engine.coursesTree(optQuery(url, 'course'))))
  }),
  get('/questions', async ({ rt, url, res }) => {
    const [node] = needQuery(url, 'node')
    sendJson(res, 200, await apiRun(rt, 'api/questions', () => rt.engine.questions(optQuery(url, 'course'), node)))
  }),
  get('/file', async ({ rt, url, res }) => {
    // 伺服 vault 内媒体文件（课程插图）；路径必须是 vault 相对且白名单扩展名（体在 static.ts）
    await serveVaultFile(rt, url, res)
  }),
  getPrefix('/vendor/', async ({ route, res }) => {
    // vendored 库同源伺服（katex/three）；路径限制在 web/vendor 内，MIME 白名单复用面板资产表（体在 static.ts）
    await serveVendor(res, route)
  }),
  get('/interactive', async ({ rt, url, res }) => {
    // 交互件伺服：限启用课程根内 .html；CSP 禁外联（体在 static.ts）
    await serveInteractive(rt, url, res)
  }),
  get('/note', async ({ rt, url, res }) => {
    const [path] = needQuery(url, 'path')
    sendJson(res, 200, await rt.engine.resolveNote(rt.vault, path, rt.centerRel))
  }),
  get('/graph', async ({ rt, url, res }) => {
    const elementsOnly = url.searchParams.get('elements') === '1'
    sendJson(res, 200, await apiRun(rt, 'api/graph', () => rt.engine.graphAnalyze(optQuery(url, 'course'), elementsOnly)))
  }),
  get('/proposals', async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/proposals', () => rt.engine.graphProposals()))
  }),
  get('/doctor', async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/doctor', () => rt.engine.doctor()))
  }),
  get('/questions-all', async ({ rt, url, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/questions-all', () => rt.engine.questionsAll(optQuery(url, 'course'))))
  }),
  get('/review-queue', async ({ rt, url, res }) => {
    // 复习刷卡队列：跨课程到期题扁平队列，按预测遗忘风险 R 升序为主（r 字段随卡带出，#56）；
    // node 过滤 = 定向复习直达入口（A3 软闸/enc 回退建议项指向的目标节点，#54/#55），
    // 单节点会话按 Mastery 先验带自适应排序（band + 每卡 d，#57 A1）；
    // band 查询参数 = 显式难度带偏好（#65 E5：easy/hard 偏移目标带，standard/缺省 = 纯 A1）；
    // 卡片带 jol 标记（#66 E4）：抽查命中翻面前弹一档预测，可忽略
    sendJson(res, 200, await apiRun(rt, 'api/review-queue', () => rt.engine.reviewQueue(
      optQuery(url, 'course'), optQuery(url, 'node'), undefined, bandPref(url.searchParams.get('band')))))
  }),
  get('/xp', async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/xp', () => rt.engine.xpStatus()))
  }),
  get('/probation', async ({ rt, url, res }) => {
    // 插入实验面（#146）：在途插入节点（「实验中」标记取数）、到期未决、三率
    // （滚动 30 学习日）与韧性闸门现势；course 缺省 = 全部启用课程
    sendJson(res, 200, await apiRun(rt, 'api/probation', () => rt.engine.probationStatus(optQuery(url, 'course'))))
  }),
  get('/memory', async ({ rt, res }) => {
    // 记忆健康仪表盘（#61）：负载预报/状态分布/真实保留率/遗忘曲线四面板聚合
    // （jol 字段 = 预测-校准曲线 #66 E4，配对数足门槛才有值）
    sendJson(res, 200, await apiRun(rt, 'api/memory', () => rt.engine.memoryHealth()))
  }),
  get('/jol', async ({ rt, res }) => {
    // JOL 抽查配置（#66 E4）：默认开、约 1/3；全局开关关闭后复习流完全不弹预测
    sendJson(res, 200, await apiRun(rt, 'api/jol', () => rt.engine.jolConfig()))
  }),
  get('/calibration/profile', async ({ rt, res }) => {
    // 自评校准画像（ADR-0022 #104）：分源切片为主视图 + 全局参考视图（带域特异
    // 警戒）。practice 流水配对的只读派生——零落盘、零 canonical 写入。
    sendJson(res, 200, await apiRun(rt, 'api/calibration/profile', () => rt.engine.calibrationProfile()))
  }),
  get('/calibration/hints', async ({ rt, res }) => {
    // 过信轻提示全局开关（ADR-0022 #104）：缺省开，可全局关
    sendJson(res, 200, await apiRun(rt, 'api/calibration/hints', () => rt.engine.calibrationHintsConfig()))
  }),
  get('/coach', async ({ rt, res }) => {
    // 可用的困难教练（#65 E5）：只读信息性反馈，无触发为空数组
    sendJson(res, 200, await apiRun(rt, 'api/coach', () => rt.engine.coachAdvice()))
  }),
  get('/sleep', async ({ rt, res }) => {
    // D-4 睡眠耦合建议层开关（#85）：默认开
    sendJson(res, 200, await apiRun(rt, 'api/sleep', () => rt.engine.sleepAdviceConfig()))
  }),
  get('/thermostat', async ({ rt, res }) => {
    // D-2 挑战点恒温器（#111 ADR-0024）：跨区观测聚合 + 只读建议（非自动控制器）
    sendJson(res, 200, await apiRun(rt, 'api/thermostat', () => rt.engine.thermostatView()))
  }),
  get('/experiments', async ({ rt, res }) => {
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
  }),
  get('/generate/status', async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/generate/status', () => generationStatus(rt)))
  }),
  get('/prompts', async ({ rt, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/prompts', () => rt.engine.promptKinds()))
  }),
  get('/discuss-pack', async ({ rt, url, res }) => {
    const [node] = needQuery(url, 'node')
    sendJson(res, 200, await apiRun(rt, 'api/discuss-pack', () => rt.engine.discussionPack(optQuery(url, 'course'), node)))
  }),
  get('/explain-pack', async ({ rt, url, res }) => {
    // 错误当下「讲解这道题」逐题包（Arc D #64）：客户端桥注入宿主会话的首条消息原料
    const [node, qid] = needQuery(url, 'node', 'qid')
    sendJson(res, 200, await apiRun(rt, 'api/explain-pack', () => rt.engine.errorExplainPack(optQuery(url, 'course'), node, qid)))
  }),
  get('/explain-back-pack', async ({ rt, url, res }) => {
    // E2「讲给我听」会话包（#68）：初学者人设指令 + 正文要点 + 图位置（面板会话 system）
    const [node] = needQuery(url, 'node')
    sendJson(res, 200, await apiRun(rt, 'api/explain-back-pack', () => rt.engine.explainBackPack(optQuery(url, 'course'), node)))
  }),
  get('/note-sources', async ({ rt, res }) => {
    // 笔记源清单（C1 #59）：注册身份 × Missing/漂移状态 × 卡池概况
    sendJson(res, 200, await apiRun(rt, 'api/note-sources', () => rt.engine.noteSourceList()))
  }),
  get('/anki/status', async ({ rt, res }) => {
    // Anki 通道状态（C2 #63，#72 UI 挂接）：镜象/最近推送与回写/当前到期分布
    // + AnkiConnect 可达性（连接失败不抛，status.anki.connected=false 带原因）
    sendJson(res, 200, await apiRun(rt, 'api/anki/status', () =>
      rt.engine.ankiStatus(new AnkiConnectClient(ANKI_ENDPOINT))))
  }),
  get('/difficulty-advice', async ({ rt, url, res }) => {
    // B2 难度失衡/过于简单只读建议（#58，#72 UI 挂接）：题目管理页建议区消费
    sendJson(res, 200, await apiRun(rt, 'api/difficulty-advice', () => rt.engine.difficultyAdvice(optQuery(url, 'course'))))
  }),
  get('/agent-guide', async ({ res }) => {
    // 能力指南：agent 独有工具的面板说明锚点（AGENT_GUIDE 单一事实源）
    sendJson(res, 200, AGENT_GUIDE)
  }),
  get('/question-audit', async ({ rt, res }) => {
    // 题库契约只读体检（ADR-0029/0030）：题库维护区消费
    sendJson(res, 200, await apiRun(rt, 'api/question-audit', () => rt.engine.questionAudit()))
  }),
  get('/bank-cleanup', async ({ rt, url, res }) => {
    // 题库一键清理预览（ADR-0032，只读）：跳过节点全部未归档题 + 已完成节点休眠题
    sendJson(res, 200, await apiRun(rt, 'api/bank-cleanup', () => rt.engine.bankCleanupPreview(optQuery(url, 'course'))))
  }),
  get('/learner-queue', async ({ rt, url, res }) => {
    // 「我的卡」E 池队列（E1/#68）：到期在前、新卡随后，隔离自调度
    sendJson(res, 200, await apiRun(rt, 'api/learner-queue', () => rt.engine.learnerQueue(optQuery(url, 'course'))))
  }),
  get('/error-queue', async ({ rt, url, res }) => {
    // 「错误对比卡」清单（C-3/#82）：到期在前、新卡随后（全卡面，管理/抽查用）
    sendJson(res, 200, await apiRun(rt, 'api/error-queue', () => rt.engine.errorCardQueue(optQuery(url, 'course'))))
  }),
  get('/skills', async ({ rt, res }) => {
    // 技能条目 lane（#89）：生效到期已折算维持节拍帽（读侧）
    sendJson(res, 200, await apiRun(rt, 'api/skills', () => rt.engine.skillList()))
  }),
  get('/habits', async ({ rt, res }) => {
    // 习惯（#90）：清单 + 宽容 streak + 自动化曲线摘要（只展示给学习者）
    sendJson(res, 200, await apiRun(rt, 'api/habits', () => rt.engine.habitList()))
  }),
  get('/habit', async ({ rt, url, res }) => {
    // 单个习惯详情（#90）：意图 + 完整自动化曲线 + 近期重复
    const [habit] = needQuery(url, 'habit')
    sendJson(res, 200, await apiRun(rt, 'api/habit', () => rt.engine.habitShow(habit)))
  }),
  get('/projects', async ({ rt, res }) => {
    // 项目清单（P 区 #92）：Project 是 Course 姊妹实体（面板尚无项目页签前的读面）
    sendJson(res, 200, await apiRun(rt, 'api/projects', () => rt.engine.projectList()))
  }),
  get('/project/cross', async ({ rt, url, res }) => {
    // 项目 2×2 交叉视图（P-7 #98）：面板核心视图（只读，含入档推荐）
    const [id] = needQuery(url, 'id')
    sendJson(res, 200, await apiRun(rt, 'api/project/cross', () => rt.engine.projectCrossView(id)))
  }),
  get('/project/log', async ({ rt, url, res }) => {
    // 项目日志读面（V-5 #113）：未写过 = null 合法空态
    const [id] = needQuery(url, 'id')
    sendJson(res, 200, await apiRun(rt, 'api/project/log', () => rt.engine.projectLog(id)))
  }),
  get('/kata', async ({ rt, url, res }) => {
    // 周复盘打开/发起（U-4 #114）：缺省 = 上一完整学习周；现状引擎现算重填，四问保留
    sendJson(res, 200, await apiRun(rt, 'api/kata', () => rt.engine.kataOpen(optQuery(url, 'week_start'))))
  }),
]

export const putRoutes: RouteSpec[] = [
  put('/daily-goal', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/daily-goal', () => rt.engine.setDailyGoal(requireNumber(body, 'goal'))))
  }),
  put('/day-cutoff', async ({ rt, body, res }) => {
    // 日界（ADR-0020）：学习日切换的本地时刻 'HH:mm'（非法值引擎 fail loud）
    sendJson(res, 200, await apiRun(rt, 'api/day-cutoff', () => rt.engine.setDayCutoff(requireString(body, 'value'))))
  }),
  put('/jol', async ({ rt, body, res }) => {
    // JOL 抽查配置（#66 E4）：enabled 全局开关 + rate 抽样率（0<r≤1）
    sendJson(res, 200, await apiRun(rt, 'api/jol', () => rt.engine.setJolConfig({
      ...pick('enabled', optBoolean(body, 'enabled')),
      ...pick('rate', optFinite(body, 'rate')),
    })))
  }),
  put('/calibration/hints', async ({ rt, body, res }) => {
    // 过信轻提示全局开关（ADR-0022 #104）：显式布尔，缺省报错（fail loud）
    sendJson(res, 200, await apiRun(rt, 'api/calibration/hints',
      () => rt.engine.setCalibrationHints(requireBoolean(body, 'hints_enabled'))))
  }),
  put('/sleep', async ({ rt, body, res }) => {
    // D-4 睡眠耦合建议层开关（#85）：enabled=false 全层静默
    sendJson(res, 200, await apiRun(rt, 'api/sleep', () => rt.engine.setSleepAdviceConfig({
      ...pick('enabled', optBoolean(body, 'enabled')),
    })))
  }),
  put('/question-update', async ({ rt, body, res }) => {
    sendJson(res, 200, await rt.engine.questionUpdate(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'), optObject(body, 'patch') ?? {}))
  }),
]
