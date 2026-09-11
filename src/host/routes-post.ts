/**
 * 面板路由表·POST 子表（#168：if 链的 POST 段 73 个内嵌分支拆为子表）。
 *
 * 逐条自 `handleApi` 的 POST 段搬入，方法／路径／响应形状与**守卫次序**逐字不变
 * （守卫先于 `apiRun` 的几条——archive 类布尔、pin 的 pinned、question-add 的 question、
 * 申诉的 resolution——都显式提到 handler 首行：改成传参会让「先报哪个缺参」变样）。
 * `/tutor` 与 `/explain-back` 的面板会话 helper 随本段同文件（只服务这两条路由）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { ANKI_ENDPOINT, AnkiConnectClient } from '../engine/index.ts'
import { applyId, questionCount, rejectId, requireSkipDirection } from '../tool-contracts.ts'
import { sendJson } from './http.ts'
import {
  need, optFinite, optList, optNumber, optObject, optRaw, optString, optText, optTrimmed, optTrue, pick,
  requireBoolean, requireNumber, requireObject, requireOneOf,
} from './params.ts'
import { apiRun, runLog, stripFences } from './runtime.ts'
import { llmComplete, llmSeam } from './llm.ts'
import type { HostRuntime } from './runtime.ts'
import { post } from './route-table.ts'
import type { RouteSpec } from './route-table.ts'
import {
  cancelGeneration,
  coachTriggerDetached,
  enqueueGeneration,
  enqueueGraphJob,
  enqueueGrowthBatch,
  enqueueQuizGeneration,
  generateSection,
  resetCourseChain,
  resumeQueue,
  sweepGenJobs,
  triggerPlanGrowth,
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

export const postRoutes: RouteSpec[] = [
  post('/habits/create', async ({ rt, body, res }) => {
    // 习惯创建（#90）：意图两字段（线索/行动）由引擎 fail loud 校验
    sendJson(res, 200, await apiRun(rt, 'api/habits/create', () => rt.engine.habitCreate({
      name: need(body, 'name'), cue: need(body, 'cue'), action: need(body, 'action'),
    })))
  }),
  post('/habits/repeat', async ({ rt, body, res }) => {
    // 自报重复（#90）：唯一计数来源，无门禁；可选自动化自评 1-5
    sendJson(res, 200, await apiRun(rt, 'api/habits/repeat', () => rt.engine.habitRepeat(need(body, 'habit'), {
      ...pick('auto_rating', optNumber(body, 'auto_rating')),
      ...pick('note', optText(body, 'note')),
    })))
  }),
  post('/habits/archive', async ({ rt, body, res }) => {
    const archived = requireBoolean(body, 'archived')
    sendJson(res, 200, await apiRun(rt, 'api/habits/archive', () =>
      rt.engine.habitArchive(need(body, 'habit'), archived)))
  }),
  post('/skills/archive', async ({ rt, body, res }) => {
    const archived = requireBoolean(body, 'archived')
    sendJson(res, 200, await apiRun(rt, 'api/skills/archive', () =>
      rt.engine.skillArchive(need(body, 'skill'), archived)))
  }),
  post('/skills/maintenance', async ({ rt, body, res }) => {
    // 维持节拍帽（#89）：天数或 null（关闭）
    sendJson(res, 200, await apiRun(rt, 'api/skills/maintenance', () =>
      rt.engine.skillSetMaintenance(need(body, 'skill'), body.days ?? null)))
  }),
  post('/rebuild', async ({ rt, res }) => {
    sendJson(res, 200, { message: (await rt.engine.rebuild()).message })
  }),
  post('/node/skip', async ({ rt, ctx, body, res }) => {
    // 跳过 = 显式重新裁决（词条「教练回合」五点之一）：force 豁免停摆/暂不产结构
    // 阻尼——跳过改了症状与路线，上一次停摆裁决不再代表现状；路由返回后 fire-and-forget
    const skipped = await apiRun(rt, 'api/node/skip', () =>
      rt.engine.nodeSkip(need(body, 'course'), need(body, 'node'), requireSkipDirection(body.skipped)))
    coachTriggerDetached(rt, ctx, 'node_skip', need(body, 'course'), { force: true })
    sendJson(res, 200, skipped)
  }),
  post('/node/pin', async ({ rt, body, res }) => {
    // 「今天学它」pin（E3 #67）：显式方向——pinned=true 置顶当日推荐榜首（只改
    // 排序、保留就绪提示、次日自动失效），false 取消。
    const pinned = requireBoolean(body, 'pinned')
    sendJson(res, 200, await apiRun(rt, 'api/node/pin', () =>
      pinned
        ? rt.engine.pinToday(need(body, 'course'), need(body, 'node'))
        : rt.engine.unpinToday(need(body, 'course'), need(body, 'node'))))
  }),
  post('/node/complete', async ({ rt, ctx, body, res }) => {
    // 完成 = 教练回合触发点之一（五点接线）：自动触点走阻尼；路由返回后 fire-and-forget
    const done = await apiRun(rt, 'api/node/complete', () =>
      rt.engine.nodeComplete(need(body, 'course'), need(body, 'node'), optTrue(body, 'force')))
    coachTriggerDetached(rt, ctx, 'node_complete', need(body, 'course'))
    sendJson(res, 200, done)
  }),
  post('/feedback', async ({ rt, body, res }) => {
    sendJson(res, 200, { message: await rt.engine.submitFeedback(rt.vault, rt.centerRel, need(body, 'path')) })
  }),
  post('/proposals/apply', async ({ rt, ctx, body, res }) => {
    // 提案统一 apply（图谱域 edit/seed/enrich + 项目域 project_plan/project_milestone）：
    // kind 必须显式照抄提案记录，未知 kind 引擎报错；
    // 计划修订触发的换线/补支生长批随后入队（#149）
    const applied = await rt.engine.proposalApply(need(body, 'kind'), applyId(body.id))
    // 编辑批可含 del_node/rename（ADR-0039 写侧联动）：apply 出口同步清扫注册表
    await sweepGenJobs(rt)
    triggerPlanGrowth(rt, ctx, applied as { kind?: string })
    sendJson(res, 200, applied)
  }),
  post('/proposals/reject', async ({ rt, body, res }) => {
    const id = rejectId(body.id)
    await rt.engine.graphReject(id, optString(body, 'note').trim())
    sendJson(res, 200, { message: `[reject] 提案 #${id} 已拒绝留痕。` })
  }),
  post('/thermostat/apply', async ({ rt, body, res }) => {
    // D-2 恒温器建议的逐条显式确认（#111 ADR-0024）：只受理当前清单内 id
    sendJson(res, 200, await apiRun(rt, 'api/thermostat/apply', () =>
      rt.engine.thermostatApply(need(body, 'suggestion'))))
  }),
  post('/experiments/propose', async ({ rt, body, res }) => {
    // D-1 实验提案（#110）：模板发起 → pending 提案
    const course = optTrimmed(body, 'course')
    sendJson(res, 200, await apiRun(rt, 'api/experiments/propose', () =>
      rt.engine.experimentPropose(need(body, 'template'), course)))
  }),
  post('/experiments/apply', async ({ rt, body, res }) => {
    // D-1 实验确认开跑（#110 提案-确认制第二步）
    sendJson(res, 200, await apiRun(rt, 'api/experiments/apply', () =>
      rt.engine.experimentApply(applyId(body.id))))
  }),
  post('/experiments/stop', async ({ rt, body, res }) => {
    // D-1 实验手动停止（开停手动，ADR-0023）
    const id = body.id === undefined || body.id === null ? undefined : applyId(body.id)
    sendJson(res, 200, await apiRun(rt, 'api/experiments/stop', () => rt.engine.experimentStop(id)))
  }),
  post('/sandbox/run', async ({ rt, body, res }) => {
    // D-3 沙盘（#112 ADR-0025）：只读蒙特卡洛推演，零写侧
    const minutes = requireNumber(body, 'minutes_per_day')
    const weeks = body.weeks === undefined ? undefined : Number(body.weeks)
    const course = optTrimmed(body, 'course')
    const nodes = optList(body, 'nodes')?.filter((n): n is string => typeof n === 'string')
    sendJson(res, 200, await apiRun(rt, 'api/sandbox/run', () => rt.engine.sandboxRun({
      minutesPerDay: minutes,
      ...pick('weeks', weeks !== undefined && Number.isFinite(weeks) ? weeks : undefined),
      ...pick('course', course),
      ...(nodes?.length ? { nodes } : {}),
    })))
  }),
  post('/generate', async ({ rt, ctx, body, res }) => {
    // 入队即返回：全局串行队列后台按序执行（大纲 → 逐节正文 → 自动出题，数分钟/节点）
    const style = optTrimmed(body, 'style')
    sendJson(res, 200, await apiRun(rt, 'api/generate', async () =>
      enqueueGeneration(rt, ctx, need(body, 'course'), need(body, 'node'), style)))
  }),
  post('/generate/resume', async ({ rt, ctx, res }) => {
    // 恢复重启后暂停的队列（遗留排队任务不自动开跑，防静默烧 token）
    sendJson(res, 200, await apiRun(rt, 'api/generate/resume', async () => resumeQueue(rt, ctx)))
  }),
  post('/generate/section', async ({ rt, ctx, body, res }) => {
    // 单节重写：指定节 id 重新生成并过门（LessonView 节重写入口）
    sendJson(res, 200, await apiRun(rt, 'api/generate/section', async () => ({
      message: await generateSection(rt, ctx, need(body, 'course'), need(body, 'node'), need(body, 'section')),
    })))
  }),
  post('/course/reset', async ({ rt, ctx, body, res }) => {
    // 整课重新生成：重置（旧内容备份进 .trash）→ 按拓扑序串行重跑生成管线。
    // 重生成链后台执行，HTTP 立即返回；进度由任务注册表展示（面板 5s 轮询）。
    sendJson(res, 200, await apiRun(rt, 'api/course/reset', async () =>
      resetCourseChain(rt, ctx, need(body, 'course'))))
  }),
  post('/interactive/settle', async ({ rt, body, res }) => {
    // 交互件成绩结算（LEARNHUB_COMPLETE 上报；同节同日一次，防刷）
    const score = Number(body.score)
    sendJson(res, 200, await apiRun(rt, 'api/interactive/settle', () => rt.engine.interactiveSettle(
      need(body, 'course'), need(body, 'node'), need(body, 'section'),
      Number.isFinite(score) ? score : 0,
      optRaw(body, 'detail'))))
  }),
  post('/tutor', async ({ rt, ctx, body, res }) => {
    // 面板内轻量答疑：前端持有对话历史全量携带（最后一条必须是学习者提问）
    const history = optList(body, 'messages') ?? []
    sendJson(res, 200, await apiRun(rt, 'api/tutor', async () => ({
      answer: await tutorChat(rt, ctx, need(body, 'course'), need(body, 'node'), history),
    })))
  }),
  post('/explain-back', async ({ rt, ctx, body, res }) => {
    // E2「讲给我听」（#68）：初学者人设追问会话——包做 system，前端全量携带对话历史
    const history = optList(body, 'messages') ?? []
    sendJson(res, 200, await apiRun(rt, 'api/explain-back', async () => ({
      answer: await explainBackTurn(rt, ctx, need(body, 'course'), need(body, 'node'), history),
    })))
  }),
  post('/explain-feedback', async ({ rt, ctx, body, res }) => {
    // E2 定位反馈回合（#68）：对照要点给是非+定位+怎么补；判词只入 E 档案
    sendJson(res, 200, await apiRun(rt, 'api/explain-feedback', () => rt.engine.explainBackFeedback(
      need(body, 'course'), need(body, 'node'), optString(body, 'transcript'), llmSeam(ctx))))
  }),
  post('/explain-archive', async ({ rt, body, res }) => {
    // E2 存档（#68）：把这版讲稿存成 E1 自注卡（再讲一遍/挖空重述两档）
    sendJson(res, 200, await apiRun(rt, 'api/explain-archive', () => rt.engine.explainArchiveCard(
      need(body, 'course'), need(body, 'node'), {
        content: optString(body, 'content'),
        ...pick('kind', optRaw(body, 'kind') as 'recall_cue' | 'cloze_rewrite' | undefined),
        ...pick('prompt', optText(body, 'prompt')),
        ...pick('section', optText(body, 'section')),
      })))
  }),
  post('/note-source/register', async ({ rt, body, res }) => {
    // C1 笔记源注册（#59）：单篇 .md 或文件夹（批量登记其下全部 .md）；用户笔记零写入
    sendJson(res, 200, await apiRun(rt, 'api/note-source/register', () =>
      rt.engine.noteSourceRegister(need(body, 'path'))))
  }),
  post('/note-source/unregister', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/note-source/unregister', () =>
      rt.engine.noteSourceUnregister(need(body, 'id'))))
  }),
  post('/note-source/exclude', async ({ rt, body, res }) => {
    // 用户排除清单（V-1 #86）：面板/agent 同一引擎通道；清单随 GET /note-sources 带出
    sendJson(res, 200, await apiRun(rt, 'api/note-source/exclude', () =>
      rt.engine.noteSourceExclude(need(body, 'path'))))
  }),
  post('/note-source/unexclude', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/note-source/unexclude', () =>
      rt.engine.noteSourceUnexclude(need(body, 'path'))))
  }),
  post('/note-source/relink', async ({ rt, body, res }) => {
    // 漂移治理 relink（V-6 #109）：改名/移动后把既有源重连到新路径（卡池与调度保留）
    sendJson(res, 200, await apiRun(rt, 'api/note-source/relink', () =>
      rt.engine.noteSourceRelink(need(body, 'id'), need(body, 'path'))))
  }),
  post('/note-source/generate', async ({ rt, ctx, body, res }) => {
    // 笔记源出题（#59）：读笔记正文 → 笔记出题 prompt → validateBank 门禁落镜像
    sendJson(res, 200, await apiRun(rt, 'api/note-source/generate', () => rt.engine.noteSourceGenerate(
      need(body, 'id'), questionCount(body.count),
      async prompt => stripFences(await llmSeam(ctx)(prompt)))))
  }),
  post('/anki/export', async ({ rt, res }) => {
    // 导出到 Anki（C2 #63，#72 UI 挂接）：与 learnhub_anki_export 同一引擎通道
    // ——按 vault 到期集校准/重建镜象卡组（Anki 未开时 fail loud 带指引）
    sendJson(res, 200, await apiRun(rt, 'api/anki/export', () =>
      rt.engine.ankiExportPush(new AnkiConnectClient(ANKI_ENDPOINT))))
  }),
  post('/anki/import', async ({ rt, res }) => {
    // Anki 作答回写（C2 #63，#72 UI 挂接）：拉上次导入水位以来的复习事件，
    // 按 vault 自己的 ts-fsrs 重算调度（Anki 侧排期输出不作数）
    sendJson(res, 200, await apiRun(rt, 'api/anki/import', () =>
      rt.engine.ankiImportEvents(new AnkiConnectClient(ANKI_ENDPOINT))))
  }),
  post('/optimize-params', async ({ rt, res }) => {
    // FSRS 参数优化器手动触发（A2 #62，#72 UI 挂接）：门禁不满足/评估未更优
    // 时不写回，status=skipped + 原因随响应带出（统计页面板展示）
    sendJson(res, 200, await apiRun(rt, 'api/optimize-params', () => rt.engine.optimizeFsrsParams()))
  }),
  post('/learner-rate', async ({ rt, body, res }) => {
    // 「我的卡」自评结算（E1/#68）：一卡一天一次推进，隔离自调度
    sendJson(res, 200, await apiRun(rt, 'api/learner-rate', () => rt.engine.learnerCardRate(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), Number(body.rating))))
  }),
  post('/learner-forget', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/learner-forget', () => rt.engine.learnerCardForget(
      need(body, 'course'), need(body, 'node'), need(body, 'card'))))
  }),
  post('/error-answer', async ({ rt, body, res }) => {
    // 「错误对比卡」作答（C-3/#82）：三选一自动判分，一卡一天一次，无绑定 XP
    sendJson(res, 200, await apiRun(rt, 'api/error-answer', () => rt.engine.errorCardAnswer(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), String(body.choice ?? ''))))
  }),
  post('/error-generate', async ({ rt, ctx, body, res }) => {
    // 「错误对比卡」生成（C-3/#82）：挖矿 → 模型出卡 → schema 门禁落盘
    sendJson(res, 200, await apiRun(rt, 'api/error-generate', () => rt.engine.errorCardGenerate(
      need(body, 'course'),
      {
        ...pick('node', optText(body, 'node')),
        ...(body.max !== undefined ? { max: Number(body.max) } : {}),
      },
      async prompt => stripFences(await llmSeam(ctx)(prompt)))))
  }),
  post('/error-archive', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/error-archive', () => rt.engine.errorCardArchive(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), Boolean(body.archived))))
  }),
  post('/learner-add', async ({ rt, ctx, body, res }) => {
    // E1「加我的理解」（#70）：写注当下 AI 对照该节要点给是非+定位反馈；判词入 E 档案
    sendJson(res, 200, await apiRun(rt, 'api/learner-add', () => rt.engine.learnerNoteAdd(
      need(body, 'course'), need(body, 'node'), {
        content: optString(body, 'content'),
        ...pick('kind', optText(body, 'kind') as never),
        ...pick('prompt', optText(body, 'prompt')),
        ...pick('section', optText(body, 'section')),
      }, llmSeam(ctx))))
  }),
  post('/learner-archive', async ({ rt, body, res }) => {
    const archived = requireBoolean(body, 'archived')
    sendJson(res, 200, await apiRun(rt, 'api/learner-archive', () => rt.engine.learnerCardArchive(
      need(body, 'course'), need(body, 'node'), need(body, 'card'), archived)))
  }),
  post('/question-generate', async ({ rt, ctx, body, res }) => {
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
  }),
  post('/review', async ({ rt, body, res }) => {
    sendJson(res, 200, { message: await rt.engine.contentReview(need(body, 'course'), need(body, 'node')) })
  }),
  post('/question-save', async ({ rt, body, res }) => {
    sendJson(res, 200, await rt.engine.questionSave(need(body, 'course'), need(body, 'node'), need(body, 'yaml')))
  }),
  post('/question-answer', async ({ rt, ctx, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/question-answer', () => rt.engine.questionAnswer(
      llmSeam(ctx),
      need(body, 'course'), need(body, 'node'), need(body, 'qid'),
      optString(body, 'answer'),
      optFinite(body, 'elapsed_s') ?? null,
      {
        ...(optTrue(body, 'defer_schedule') ? { deferSchedule: true } : {}),
        // 翻面前的 JOL 预测（#66 E4）：缺省/非法由引擎显式契约拒绝
        ...pick('predicted', optRaw(body, 'predicted') as never),
      })))
  }),
  post('/question-rate', async ({ rt, body, res }) => {
    // 复习刷卡流：答对后的自评难度结算（2/3/4 → FSRS Hard/Good/Easy）
    sendJson(res, 200, await apiRun(rt, 'api/question-rate', () => rt.engine.questionRate(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'), Number(body.rating))))
  }),
  post('/question-forget', async ({ rt, body, res }) => {
    // 复习刷卡流：「忘记」申报（不作答翻面，按答错记证据、0 XP）
    sendJson(res, 200, await apiRun(rt, 'api/question-forget', () => rt.engine.questionForget(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'),
      optFinite(body, 'elapsed_s') ?? null,
      (optRaw(body, 'predicted') ?? null) as never)))
  }),
  post('/question-dispute/review', async ({ rt, ctx, body, res }) => {
    // 瑕疵题申诉复核（ADR-0031）：LLM 两阶段复核三态裁定，只读不落盘
    sendJson(res, 200, await apiRun(rt, 'api/question-dispute/review', () => rt.engine.questionDisputeReview(
      llmSeam(ctx),
      need(body, 'course'), need(body, 'node'), need(body, 'qid'))))
  }),
  post('/question-dispute/apply', async ({ rt, body, res }) => {
    // 申诉结算：rekey（改键重判可改判对）/ void（瑕疵题作废）/ overridden（强制豁免，不得分）
    // 守卫留在 apiRun 回调内（今天就在这里）：失败时运行日志留痕的语义随之不变
    sendJson(res, 200, await apiRun(rt, 'api/question-dispute/apply', () => {
      const resolution = requireOneOf(body, 'resolution', ['rekey', 'void', 'overridden'] as const)
      const rawRevision = body.revision as { answer?: unknown; explanation?: unknown } | undefined
      return rt.engine.questionDisputeApply(
        need(body, 'course'), need(body, 'node'), need(body, 'qid'), resolution, {
          ...pick('targetTs', optRaw(body, 'target_ts')),
          ...(typeof rawRevision === 'object' && rawRevision !== null
            ? { revision: { answer: rawRevision.answer, ...(typeof rawRevision.explanation === 'string' ? { explanation: rawRevision.explanation } : {}) } } : {}),
          ...pick('reason', optRaw(body, 'reason')),
        })
    }))
  }),
  post('/band-session', async ({ rt, body, res }) => {
    // 难度带会话日志（E5 #65）：会话结束反馈点落一条带选择与作答结算（教练数据源）
    sendJson(res, 200, await apiRun(rt, 'api/band-session', () => rt.engine.logBandSession({
      course: need(body, 'course'), node: need(body, 'node'),
      band: (optRaw(body, 'band') ?? 'standard') as never,
      answered: Number(body.answered ?? 0), correct: Number(body.correct ?? 0),
    })))
  }),
  post('/question-add', async ({ rt, body, res }) => {
    const q = requireObject(body, 'question')
    sendJson(res, 200, await rt.engine.questionAdd(
      need(body, 'course'), need(body, 'node'), q))
  }),
  post('/question-archive', async ({ rt, body, res }) => {
    // reason = 归档原因（ADR-0032：too_easy=建议确认 / manual=人工等），可逆恢复时清除
    sendJson(res, 200, await rt.engine.questionArchive(
      need(body, 'course'), need(body, 'node'), need(body, 'qid'),
      optTrue(body, 'archived'), optRaw(body, 'reason')))
  }),
  post('/difficulty-advice-dismiss', async ({ rt, body, res }) => {
    // B2 建议忽略/恢复：误判的持久忽略（undo 恢复单条，all 清空全部；
    // all=true 时 course/node/qid 均不需要）
    sendJson(res, 200, await apiRun(rt, 'api/difficulty-advice-dismiss', () =>
      rt.engine.adviceDismiss(
        optString(body, 'course'),
        optString(body, 'node'),
        optRaw(body, 'qid'),
        optTrue(body, 'undo'), optTrue(body, 'all'))))
  }),
  post('/bank-cleanup/apply', async ({ rt, body, res }) => {
    // 题库一键清理应用（ADR-0032）：按当前预览规则现算候选并归档（reason=cleanup，可逆）
    sendJson(res, 200, await apiRun(rt, 'api/bank-cleanup/apply', () =>
      rt.engine.bankCleanupApply(optRaw(body, 'course'))))
  }),
  post('/course/delete', async ({ rt, body, res }) => {
    const r = await rt.engine.courseDelete(need(body, 'course'))
    // 写侧联动（ADR-0039）：课程没了，注册表里它的任务记录（含排队/在途）随即出册
    await sweepGenJobs(rt)
    sendJson(res, 200, r)
  }),
  post('/generate/cancel', async ({ rt, body, res }) => {
    sendJson(res, 200, cancelGeneration(rt, need(body, 'course'), need(body, 'node')))
  }),
  post('/coach/growth', async ({ rt, ctx, body, res }) => {
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
  }),
  post('/coach/compass', async ({ rt, ctx, body, res }) => {
    // 罗盘初画/重画（#143 透明度装置）：LLM 一次调用进串行队列，不占请求
    sendJson(res, 200, await apiRun(rt, 'api/coach/compass', async () =>
      enqueueGraphJob(rt, ctx, { course: need(body, 'course'), node: '罗盘', phase: '罗盘' })))
  }),
  post('/graph/backfill', async ({ rt, body, res }) => {
    // 成分技能边回填（确定性推断，零 LLM）：同步受理，产物 = 富化提案待人审
    sendJson(res, 200, await apiRun(rt, 'api/graph/backfill', () =>
      rt.engine.graphEncBackfill(optText(body, 'course'))))
  }),
  post('/seed/propose', async ({ rt, ctx, body, res }) => {
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
        course: seedCourse, node: '种子起草', phase: '种子',
        seedPayload: {
          goal,
          mode: body.mode === 'reseed' ? 'reseed' : 'new',
          goalType: body.goalType === 'coverage' ? 'coverage' : 'capability',
          useVaultPrior: optTrue(body, 'useVaultPrior'),
          worksheet,
        },
      })))
  }),
  post('/probation/settle', async ({ rt, res }) => {
    // 复诊结算手动触发（#146 零人审自动行为的手动面，无确认步）：到期插入边
    // proven｜自动剪除
    sendJson(res, 200, await apiRun(rt, 'api/probation/settle', () => rt.engine.settleRechecks()))
  }),
  post('/project/create', async ({ rt, body, res }) => {
    // 项目创建（P 区 #92）：Project 是 Course 姊妹实体，零调度零 XP
    sendJson(res, 200, await apiRun(rt, 'api/project/create', () => rt.engine.projectCreate({
      name: need(body, 'name'),
      goal: need(body, 'goal'),
      ...pick('tier', optTrimmed(body, 'tier') as never),
    })))
  }),
  post('/project/lifecycle', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/project/lifecycle', () =>
      rt.engine.projectSetLifecycle(need(body, 'id'), need(body, 'lifecycle'))))
  }),
  post('/project/tier', async ({ rt, body, res }) => {
    sendJson(res, 200, await apiRun(rt, 'api/project/tier', () =>
      rt.engine.projectSetTier(need(body, 'id'), need(body, 'tier'))))
  }),
  post('/project/plan/generate', async ({ rt, ctx, body, res }) => {
    // 计划草案任务化（面板下发）：LLM 起草进串行队列，不占请求
    const project = need(body, 'id')
    sendJson(res, 200, await apiRun(rt, 'api/project/plan/generate', async () =>
      enqueueGraphJob(rt, ctx, { course: project, node: '计划草案', phase: '计划', planPayload: { project } })))
  }),
  post('/project/milestone/generate', async ({ rt, ctx, body, res }) => {
    // 里程碑任务卡任务化（面板下发）
    const project = need(body, 'id')
    const milestone = need(body, 'milestone')
    sendJson(res, 200, await apiRun(rt, 'api/project/milestone/generate', async () =>
      enqueueGraphJob(rt, ctx, {
        course: project, node: `里程碑草案(${milestone})`, phase: '里程碑',
        milestonePayload: { project, milestone },
      })))
  }),
  post('/project/decompile', async ({ rt, ctx, body, res }) => {
    // 目标反编译（P-5 #95）任务化（面板下发）：计划+种子双提案进串行队列，提案页联合人审；
    // goal/notes 透传给引擎（缺省读项目档案目标 + 全部注册笔记，契约与 agent 工具一致）
    const project = need(body, 'id')
    sendJson(res, 200, await apiRun(rt, 'api/project/decompile', async () =>
      enqueueGraphJob(rt, ctx, {
        course: project, node: '反编译', phase: '反编译',
        decompilePayload: {
          project,
          ...pick('goal', optText(body, 'goal')),
          ...pick('course', optTrimmed(body, 'course')),
          ...pick('notes', optList(body, 'notes')?.filter((n): n is string => typeof n === 'string' && !!n.trim())),
        },
      })))
  }),
  post('/project/exec', async ({ rt, body, res }) => {
    // 项目执行事件落流（P-7 #98）：评级 1-4 + 来源；nodes = 本次行使的关联节点
    // （被行使 enc 边两端节点各回流一次练习证据）。零 XP、零调度写入。
    // evidence（auto 来源的可观测证据）与 nodes 原样透传——校验收口在门面
    // validateExecEvent/ratingFromEvidence（fail loud），路由不做静默变形。
    const evidence = optObject(body, 'evidence')
    sendJson(res, 200, await apiRun(rt, 'api/project/exec', () => rt.engine.projectExecLog(need(body, 'id'), {
      source: need(body, 'source'),
      ...pick('rating', optNumber(body, 'rating')),
      ...pick('evidence', evidence),
      ...pick('nodes', optList(body, 'nodes')),
      ...pick('note', optTrimmed(body, 'note')),
    })))
  }),
  post('/project/log', async ({ rt, body, res }) => {
    // 项目日志追加（V-5 #113）：学习者自由条目，学习日归属引擎定
    sendJson(res, 200, await apiRun(rt, 'api/project/log', () =>
      rt.engine.projectLogAppend(need(body, 'id'), need(body, 'text'))))
  }),
  post('/kata/save', async ({ rt, body, res }) => {
    // 周复盘四问保存（U-4 #114）：patch 语义，现状引擎段不可写
    const answers = optObject(body, 'answers') ?? {}
    sendJson(res, 200, await apiRun(rt, 'api/kata/save', () =>
      rt.engine.kataSave(need(body, 'week_start'), answers as never)))
  }),
  post('/kata/convert/experiment', async ({ rt, body, res }) => {
    // 「下一实验」一键转 N-of-1 提案（U-4↔D-1）
    const course = optTrimmed(body, 'course')
    sendJson(res, 200, await apiRun(rt, 'api/kata/convert/experiment', () =>
      rt.engine.kataToExperiment(need(body, 'week_start'), need(body, 'template'), course)))
  }),
  post('/kata/convert/intention', async ({ rt, body, res }) => {
    // 「下一实验」一键转执行意图挂今日目标偏好（U-4↔C-5）
    sendJson(res, 200, await apiRun(rt, 'api/kata/convert/intention', () =>
      rt.engine.kataToIntention(need(body, 'week_start'), {
        course: need(body, 'course'), node: need(body, 'node'),
        cue: need(body, 'cue'), action: need(body, 'action'),
      })))
  }),
]
