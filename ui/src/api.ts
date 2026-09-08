/** 面板 → 引擎 API 客户端。全部走 /learnhub/api/*（host 伺服同源）。 */

const BASE = '/learnhub/api'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let doc: unknown = null
  try {
    doc = await res.json()
  } catch {
    // 非 JSON 响应按错误处理
  }
  if (!res.ok) {
    const msg = doc && typeof doc === 'object' && 'error' in doc
      ? String((doc as { error: unknown }).error)
      : `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return doc as T
}

const q = (params: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export const api = {
  status: () => http<import('./types').StatusDoc>('GET', '/status'),
  coursesTree: () => http<import('./types').TreeDoc>('GET', '/courses/tree'),
  graph: (course?: string) => http<import('./types').GraphDoc>('GET', `/graph${q({ course })}`),
  recommend: (limit = 8) => http<import('./types').RecommendDoc>('GET', `/recommend?limit=${limit}`),
  queue: () => http<import('./types').QueueItem[]>('GET', '/queue'),
  lesson: (node: string, course?: string) =>
    http<{ course: string; node: string; region: string; stage: string; mastery: number; sections: import('./types').LessonSection[]; manifest: import('./types').SectionManifestItem[] | null; prereqs: string[]; suggest_next: string[] }>('GET', `/lesson${q({ node, course })}`),
  questions: (course: string, node: string) =>
    http<{ course: string; node: string; mastery: number; questions: import('./types').QuestionItem[] }>('GET', `/questions${q({ course, node })}`),
  questionAnswer: (course: string, node: string, qid: string, answer: string, elapsedS?: number,
    opts?: { deferSchedule?: boolean; predicted?: string }) =>
    http<import('./types').AnswerResult>('POST', '/question-answer',
      { course, node, qid, answer, elapsed_s: elapsedS,
        ...(opts?.deferSchedule ? { defer_schedule: true } : {}),
        ...(opts?.predicted ? { predicted: opts.predicted } : {}) }),
  /** 复习刷卡流：答对后的自评结算（2=Hard 3=Good 4=Easy）。 */
  questionRate: (course: string, node: string, qid: string, rating: 2 | 3 | 4) =>
    http<import('./types').AnswerResult>('POST', '/question-rate', { course, node, qid, rating }),
  /** 复习刷卡流：「忘记」申报（不作答翻面，按答错记证据、0 XP）。predicted = 翻面前的 JOL 预测。 */
  questionForget: (course: string, node: string, qid: string, elapsedS?: number, predicted?: string) =>
    http<import('./types').AnswerResult>('POST', '/question-forget', { course, node, qid, elapsed_s: elapsedS, ...(predicted ? { predicted } : {}) }),
  /** 复习刷卡队列：跨课程到期题扁平队列；node 过滤 = 单节点定向复习（响应带 Mastery 先验带 band，#57）；
   * band = 显式难度带偏好（#65 E5）；卡片带 jol 抽查标记（#66 E4）。 */
  reviewQueue: (course?: string, node?: string, band?: 'easy' | 'standard' | 'hard') =>
    http<import('./types').ReviewQueueDoc>('GET', `/review-queue${q({ course, node, band })}`),
  /** JOL 抽查配置（#66 E4）：全局开关 + 抽样率。 */
  jol: () => http<import('./types').JolConfig>('GET', '/jol'),
  setJol: (patch: { enabled?: boolean; rate?: number }) =>
    http<import('./types').JolConfig>('PUT', '/jol', patch),
  /** 难度带会话日志（#65 E5）：会话结束落一条带选择与作答结算（教练数据源）。 */
  bandSession: (course: string, node: string, band: 'easy' | 'standard' | 'hard', answered: number, correct: number) =>
    http<{ course: string; node: string; band: string; date: string }>('POST', '/band-session', { course, node, band, answered, correct }),
  /** 可用的困难教练（#65 E5）：只读信息性反馈，无触发为空数组。 */
  coach: () => http<import('./types').CoachDoc>('GET', '/coach'),
  nodeSkip: (course: string, node: string, skipped = true) =>
    http<{ course: string; node: string; stage: string }>('POST', '/node/skip', { course, node, skipped }),
  /** 「今天学它」pin（E3 #67）：pinned=true 置顶当日推荐榜首（次日自动失效），false 取消。 */
  pinNode: (course: string, node: string, pinned = true) =>
    http<{ course: string; node: string; date?: string }>('POST', '/node/pin', { course, node, pinned }),
  nodeComplete: (course: string, node: string, force = false) =>
    http<{ accepted: boolean; accuracy: number | null; course: string; node: string; stage?: string; initialized?: number; due?: string | null; reason?: string }>('POST', '/node/complete', { course, node, force }),
  /** 入队即返回：全局串行队列后台按序生成（同一时刻只跑一个节点管线）。 */
  generate: (course: string, node: string, style?: string) =>
    http<{ message: string; queued: boolean }>('POST', '/generate', { course, node, ...(style ? { style } : {}) }),
  prompts: () => http<string[]>('GET', '/prompts'),
  tutor: (course: string, node: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    http<{ answer: string }>('POST', '/tutor', { course, node, messages }),
  /** E2「讲给我听」（#68）：初学者人设追问会话——前端全量携带多轮对话历史。 */
  explainBack: (course: string, node: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    http<{ answer: string }>('POST', '/explain-back', { course, node, messages }),
  /** E2 定位反馈回合（#68）：对照要点给是非+定位+怎么补；判词只入 E 档案。 */
  explainFeedback: (course: string, node: string, transcript: string) =>
    http<{ verdict: string; tags: string[]; advice: string; reply: string }>('POST', '/explain-feedback', { course, node, transcript }),
  /** E2 存档（#68）：把这版讲稿存成 E1 自注卡（recall_cue 再讲一遍 / cloze_rewrite 挖空重述）。 */
  explainArchive: (course: string, node: string, content: string, opts?: { kind?: 'recall_cue' | 'cloze_rewrite'; prompt?: string; section?: string }) =>
    http<{ course: string; node: string; id: string; kind: string; count: number }>('POST', '/explain-archive',
      { course, node, content, ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.prompt ? { prompt: opts.prompt } : {}), ...(opts?.section ? { section: opts.section } : {}) }),
  /** 「我的卡」E 池队列（E1 #70）：到期在前、新卡随后，隔离自调度。 */
  learnerQueue: (course?: string) =>
    http<import('./types').LearnerQueueDoc>('GET', `/learner-queue${q({ course })}`),
  /** 「我的卡」自评结算（E1 #70）：一卡一天一次推进，隔离自调度。 */
  learnerRate: (course: string, node: string, card: string, rating: 2 | 3 | 4) =>
    http<Record<string, unknown>>('POST', '/learner-rate', { course, node, card, rating }),
  /** 「我的卡」忘记申报（E1 #70）：rating=1 推卡，0 XP。 */
  learnerForget: (course: string, node: string, card: string) =>
    http<Record<string, unknown>>('POST', '/learner-forget', { course, node, card }),
  /** 「加我的理解」（E1 #70）：写注当下 AI 对照该节要点给是非+定位反馈；判词入 E 档案 + 成卡。 */
  understandingAdd: (course: string, node: string, content: string, opts?: { kind?: string; prompt?: string; section?: string }) =>
    http<import('./types').UnderstandingResult>('POST', '/learner-add',
      { course, node, content, ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.prompt ? { prompt: opts.prompt } : {}), ...(opts?.section ? { section: opts.section } : {}) }),
  /** 「我的卡」归档/恢复（E1 管理面）。 */
  learnerArchive: (course: string, node: string, card: string, archived: boolean) =>
    http<Record<string, unknown>>('POST', '/learner-archive', { course, node, card, archived }),
  questionGenerate: (course: string, node: string, count = 6) =>
    http<{ course: string; node: string; added: number; skipped: number; total: number }>('POST', '/question-generate', { course, node, count }),
  generateStatus: () => http<import('./types').GenStatusDoc>('GET', '/generate/status'),
  generateCancel: (course: string, node: string) =>
    http<{ cancelled: boolean; status?: string }>('POST', '/generate/cancel', { course, node }),
  /** 恢复重启后暂停的生成队列（遗留排队任务不自动开跑）。 */
  generateResume: () =>
    http<{ paused: boolean; resumed: number }>('POST', '/generate/resume'),
  /** 单节重写（LessonView 节重写入口；请求挂起至该节生成完成）。 */
  sectionRewrite: (course: string, node: string, section: string) =>
    http<{ message: string }>('POST', '/generate/section', { course, node, section }),
  /** 交互件成绩结算（LEARNHUB_COMPLETE；同节同日一次）。 */
  interactiveSettle: (course: string, node: string, section: string, score: number, detail?: string) =>
    http<{ settled: boolean; mastery: number }>('POST', '/interactive/settle', { course, node, section, score, detail }),
  xp: () => http<import('./types').XpStatus>('GET', '/xp'),
  /** 记忆健康仪表盘（#61）：负载预报/状态分布/真实保留率/遗忘曲线四面板。 */
  memory: () => http<import('./types').MemoryHealth>('GET', '/memory'),
  setDailyGoal: (goal: number) => http<{ goal: number }>('PUT', '/daily-goal', { goal }),
  review: (course: string, node: string) => http<{ message: string }>('POST', '/review', { course, node }),
  feedback: (path: string) => http<{ message: string }>('POST', '/feedback', { path }),
  proposals: () => http<import('./types').PropItem[]>('GET', '/proposals'),
  proposalApply: (kind: 'gen' | 'edit', id?: number) =>
    http<Record<string, unknown>>('POST', '/proposals/apply', { kind, id }),
  proposalReject: (id: number, note = '') => http<{ message: string }>('POST', '/proposals/reject', { id, note }),
  doctor: () => http<import('./types').DoctorDoc>('GET', '/doctor'),
  questionsAll: (course?: string) =>
    http<{ total: number; questions: import('./types').BankEntry[] }>('GET', `/questions-all${q({ course })}`),
  questionAdd: (course: string, node: string, question: Record<string, unknown>) =>
    http<{ course: string; node: string; id: string; count: number }>('POST', '/question-add', { course, node, question }),
  questionUpdate: (course: string, node: string, qid: string, patch: Record<string, unknown>) =>
    http<{ course: string; node: string; qid: string }>('PUT', '/question-update', { course, node, qid, patch }),
  questionArchive: (course: string, node: string, qid: string, archived: boolean) =>
    http<{ course: string; node: string; qid: string; archived: boolean }>('POST', '/question-archive', { course, node, qid, archived }),
  courseDelete: (course: string) => http<{ removed: string; trash: string }>('POST', '/course/delete', { course }),
  /** 整课重新生成：旧正文/题目/交互件/生成图片备份进 .trash 后按拓扑序串行重跑生成管线（后台执行）。 */
  resetCourse: (course: string) =>
    http<{ reset: { course: string; nodes: string[]; trashed: string[] }; queued: number }>('POST', '/course/reset', { course }),
}

/** 请求宿主新开 dsh 会话讨论本课（client 侧 learnhub:discuss 桥消费）。
 * 宿主形态二选一：应用内 iframe 发 parent（历史形态）；独立标签页发 window.opener。 */
export function discussInHost(course: string, node: string, intent: string): void {
  const message = { type: 'learnhub:discuss', course, node, intent }
  if (window.parent !== window) window.parent.postMessage(message, '*')
  else window.opener?.postMessage(message, '*')
}

/** 错误当下的「讲解这道题」（Arc D）：答错/忘记错误态动作——逐题错误上下文包
 * 注入宿主新会话的首条消息（learnhub:explain 桥消费）。 */
export function explainInHost(course: string, node: string, qid: string): void {
  const message = { type: 'learnhub:explain', course, node, qid }
  if (window.parent !== window) window.parent.postMessage(message, '*')
  else window.opener?.postMessage(message, '*')
}
