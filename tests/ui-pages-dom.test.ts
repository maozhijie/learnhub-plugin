/**
 * L3 三大页关键交互测试（#188 / #187 决议·Testing Decisions）：TodayPage（#208 前身 LearnPage）/
 * InsightPage（#210 前身 StatsPage）/ LessonView 各至少一条用户可见交互。只测外部行为：
 * 点击后出现什么、调了哪个端点；不断言内部状态。取数走 fetch 桩（api.ts 全链路真实，
 * 网络是假的），未登记端点 404 → 次要数据按缝级三态显式失败——不翻页正是该缝的承诺。
 * 页签表完整性（Exhibit A，#187 曾列为 U2 必测项）由 tests/ui-router.test.ts 的
 * 三表对账门独家执法（#189 落地后 TAB_KEYS 唯一出处 = lib/router.ts，该门直接
 * 消费权威导出且断言面是超集；本文件的初版同门已收敛退役，留两道=双份漂移税）。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, act, cleanup, waitFor, routes, stubCalls, importUi, uiImport, arco, spyFrame } from './helpers/ui-dom.ts'
import { lockCopy } from './helpers/copy-lock.ts'

afterEach(() => {
  cleanup()
  arco.Message.clear()
  localStorage.clear() // #196 失败横幅「关闭」是持久视图状态（按任务记录记忆），跨测试必须清
})

const React = (await uiImport('react')).default

// ---- 共享夹具 ----

const XP_FIXTURE = {
  date: '2026-09-12', day_cutoff: '05:00', today_xp: 42, goal: 30,
  streak: 3, streak_grace_days: 1,
  eta: [{ course: '数学', remaining: 5, done: 2, per_node: 10, days: 3 }],
}

const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el) }) }

// ---- TodayPage（#208 前身 LearnPage）：推荐流主数据三态 + 点卡进学习视图 ----

test('TodayPage：推荐卡点「去学习」→ frame.openLesson 打开该节点', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [{
      type: 'new', course: '数学', node: '入门', region: '', score: 1, why: '起点', path: null, hasContent: true,
    }] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 2, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /anki/status': { anki: null, due: { total: 0 }, mirror: {} },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
    'GET /proposals': [],
    'GET /learner-queue': { cards: [] },
  })
  const { frame, calls } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  assert.ok(await screen.findByText(/接下来/), '推荐流加载后出现「接下来」卡')
  assert.ok(screen.getByText('入门'), '推荐事件按节点名渲染')
  await click(screen.getByText(/去学习/))
  assert.deepEqual(calls.openLesson, [['数学', '入门']], '点开直接进该节点的学习视图')
})

test('TodayPage：主数据失败 = 整页失败态，重试可点；页头资产菜单不受影响', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({ 'GET /xp': XP_FIXTURE }) // /recommend 未登记 → 404：主数据失败
  const { frame } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  assert.ok(await screen.findByText(/加载失败/), '推荐流失败进 page 变体失败态')
  assert.ok(screen.getByText('重试'))
  assert.equal(screen.queryByText(/接下来/), null, '失败态不渲染主数据区')
  assert.ok(screen.getByText('我的资产'), '页头资产菜单在失败态仍可达（#208 横幅裸入口退役后的家）')
})

test('TodayPage：生成中节点的推荐卡显示逐节进度态（#160），而非只会说在队列', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [{
      type: 'new', course: '数学', node: '入门', region: '', score: 1, why: '起点', path: null, hasContent: false,
    }] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 0, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /anki/status': { anki: null, due: { total: 0 }, mirror: {} },
    // 该节点正文生成中、已好 3/7 节：卡片进度态来自任务注册表
    'GET /generate/status': {
      jobs: [{ key: '数学/入门', course: '数学', node: '入门', startedAt: '2026-09-12T10:00:00Z', status: 'running', phase: 'sections', progress: { done: 3, total: 7, current: '第二节' } }],
      queuedCount: 0,
    },
    'GET /proposals': [],
    'GET /learner-queue': { cards: [] },
  })
  const { frame } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  assert.ok(await screen.findByText(/接下来/), '推荐流加载后出现「接下来」卡')
  const progress = await screen.findAllByText(/生成中/)
  assert.ok(progress.length >= 1 && document.body.textContent!.includes('3/7'),
    '生成中节点带逐节进度（Tag 与按钮同一读数；锚词+读数，不锁整句）')
  assert.equal(screen.queryByText('生成正文'), null, '生成中不渲染「生成正文」按钮（动作诚实锁，见门册登记）')
  assert.ok(document.body.textContent!.includes('在酿 1'), '供给卡同一拍显示在酿数（与推荐卡进度同源，#208）')
})

// ---- 今日供给卡 + 闸门计数（#208 / ADR-0058 今日页唯一新功能件） ----

test('今日供给卡：重启停摆显中性原因，「恢复队列」走 /generate/resume', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 0, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /anki/status': { anki: null, due: { total: 0 }, mirror: {} },
    'GET /generate/status': { jobs: [], queuedCount: 3, queuePaused: true },
    'GET /proposals': [],
    'GET /learner-queue': { cards: [] },
    'POST /generate/resume': { paused: false, resumed: 3 },
  })
  const { frame } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  assert.ok(await screen.findByText(/队列暂停/), '停摆态显中性原因（重启后的保护态，不是故障）')
  assert.ok(document.body.textContent!.includes('3 个任务在排队'), '停摆原因带排队实数')
  await click(screen.getByText('恢复队列'))
  await waitFor(() => {
    const resume = stubCalls().find(c => c.method === 'POST' && c.path === '/generate/resume')
    assert.ok(resume, '恢复队列与生成页同一路由')
  })
})

test('今日供给卡：失败任务就地重试——内容断点续跑、生长批重新裁决（与生成页同路由）', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 0, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /anki/status': { anki: null, due: { total: 0 }, mirror: {} },
    'GET /generate/status': {
      jobs: [
        { key: '数学/入门', course: '数学', node: '入门', startedAt: '2026-09-12T10:00:00Z', status: 'failed', phase: 'sections', message: '质检门未过' },
        { key: '数学/生长批', course: '数学', node: '生长批', startedAt: '2026-09-12T10:01:00Z', status: 'failed', phase: 'growth', message: '受理门未过' },
      ],
      queuedCount: 0,
    },
    'GET /proposals': [],
    'GET /learner-queue': { cards: [] },
    'POST /generate': { message: '「入门」已入队，将从断点续跑', queued: true },
    'POST /coach/growth': { message: '生长一步已入队', queued: true },
  })
  const { frame } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  assert.ok((await screen.findAllByText(/上次任务未完成/)).length === 2, '失败行可见')
  const retries = screen.getAllByText('重试')
  assert.equal(retries.length, 2, '两条失败行各带重试')
  await click(retries[0]!) // sections → POST /generate（断点续跑）
  await waitFor(() => {
    const gen = stubCalls().find(c => c.method === 'POST' && c.path === '/generate')
    assert.ok(gen && (gen.body as { course?: string }).course === '数学', '内容任务重试走 /generate')
  })
  await click(retries[1]!) // growth → POST /coach/growth（显式重新裁决）
  await waitFor(() => {
    const growth = stubCalls().find(c => c.method === 'POST' && c.path === '/coach/growth')
    assert.ok(growth, '生长批失败重试走 /coach/growth（豁免失败阻尼语义在服务端）')
  })
})

test('今日闸门计数：待审提案实数一致，点击深链提案收件箱（#204 用户故事 4）', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 0, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /anki/status': { anki: null, due: { total: 0 }, mirror: {} },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
    'GET /proposals': [
      { id: 1, kind: 'seed', course: '数学', status: 'pending', summary: 's', artifact: '', created: '2026-09-12T00:00:00Z' },
      { id: 2, kind: 'enrich', course: '数学', status: 'applied', summary: 's', artifact: '', created: '2026-09-12T00:00:00Z' },
      { id: 3, kind: 'edit', course: '数学', status: 'rejected', summary: 's', artifact: '', created: '2026-09-12T00:00:00Z' },
    ],
    'GET /learner-queue': { cards: [] },
  })
  const { frame, calls } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  assert.ok(await screen.findByText('待审提案'), '闸门计数卡可见')
  await screen.findByText('1', { selector: '.today-supply-num' })
  await click(screen.getByText('去收件箱'))
  assert.deepEqual(calls.goto, [['courses.proposals']], '深链落提案收件箱')
})

test('我的资产菜单：Anki 出口已归洞察通道卡（#210），菜单只剩笔记源/我的卡', async () => {
  const { default: TodayPage } = await importUi('pages/TodayPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 0, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
    'GET /proposals': [],
    'GET /learner-queue': { cards: [] },
  })
  const { frame } = spyFrame()
  render(React.createElement(TodayPage, { frame }))
  await click(await screen.findByText('我的资产'))
  assert.ok(await screen.findByText(/笔记源管理/), '笔记源入口在资产菜单')
  assert.ok(screen.getByText(/我的卡管理/), '我的卡入口在资产菜单')
  assert.equal(screen.queryByText(/导出到 Anki/), null, '今日不再留 Anki 过渡入口（通道卡是唯一出口，#210）')
})

// ---- InsightPage（#210 前身 StatsPage）：XP 账本 + 每日目标保存 + 洞察六件可达 ----

test('InsightPage：今日 XP 上账，保存每日目标 → PUT /daily-goal + 成功轻提示', async () => {
  const { default: StatsPage } = await importUi('pages/InsightPage/index.tsx')
  routes({
    'GET /xp': XP_FIXTURE,
    'PUT /daily-goal': { goal: 30, ok: true },
  })
  const { frame } = spyFrame({ tree: { courses: [{ name: '数学' }] } })
  render(React.createElement(StatsPage, { frame }))
  assert.ok(await screen.findByText('42'), '今日 XP 数字上账')
  await click(screen.getByText('保存'))
  await waitFor(() => {
    const goal = stubCalls().find(c => c.method === 'PUT' && c.path === '/daily-goal')
    assert.ok(goal, '保存发出 PUT /daily-goal')
    assert.deepEqual(goal.body, { goal: 30 }, '回传当前目标值')
  })
  assert.ok(document.body.textContent!.includes('每日目标') && document.body.textContent!.includes('30'),
    '成功轻提示可见（锚词+数值，不锁整句措辞）')
})

// ---- LessonView：无题引导 + AI 出题 + 返回 ----

const LESSON_FIXTURE = {
  course: '数学', node: '入门', region: '', stage: 'learning', mastery: 0.4,
  sections: [{ id: 's1', title: '第一节', md: '引言段落。' }],
  manifest: null, prereqs: [], suggest_next: [],
}

test('LessonView：有正文无题 = 空态引导，点「AI 出题」入队任务', async () => {
  const { default: LessonView } = await importUi('components/LessonView.tsx')
  routes({
    'GET /lesson': LESSON_FIXTURE,
    'GET /questions': { course: '数学', node: '入门', mastery: 0.4, questions: [] },
    'GET /learner-queue': { cards: [] },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
    'POST /question-generate': { key: 'k1', message: '出题任务已入队', queued: true },
  })
  const { frame, calls } = spyFrame()
  render(React.createElement(LessonView, { course: '数学', node: '入门', frame }))
  assert.ok(await screen.findByText(/进行中/), '节点状态标签可见')
  assert.ok(screen.getByText(/整课正文/), '正文折叠卡可见（内容懒渲染）')
  assert.ok(screen.getByText(/还没有题目/), '无题空态引导可见')
  await click(screen.getByText(/展开完整正文/))
  assert.ok(await screen.findByText('第一节'), '折叠展开后按节渲染正文')
  await click(screen.getByRole('button', { name: /AI 出题/ }))
  await waitFor(() => {
    const gen = stubCalls().find(c => c.method === 'POST' && c.path === '/question-generate')
    assert.ok(gen, '出题任务化入队')
    assert.deepEqual(gen.body, { course: '数学', node: '入门', count: 6 })
  })
  assert.ok(document.body.textContent!.includes('入队'), '入队轻提示可见（锚词）')
  await click(screen.getByRole('button', { name: /返回/ }))
  assert.equal(calls.closeLesson!.length, 1, '返回收起学习视图')
})

test('LessonView：失败横幅动作（#196 / ADR-0054）——定点重写、重试续跑、关闭', async () => {
  const { default: LessonView } = await importUi('components/LessonView.tsx')
  routes({
    'GET /lesson': LESSON_FIXTURE,
    'GET /questions': { course: '数学', node: '入门', mastery: 0.4, questions: [] },
    'GET /learner-queue': { cards: [] },
    'GET /generate/status': {
      jobs: [{
        key: '数学/入门', course: '数学', node: '入门', startedAt: '2026-09-12T10:00:00Z',
        status: 'failed', phase: 'sections', tier: '中',
        message: '[section] 「演示：溢出节」质检门未过：\n  ✗ 节「演示：溢出节」正文过长（约 906 字 > 拒收线 800 字 = 单节预算 400×2）\n（已按门禁清单自动修复重试一轮仍未通过——可在失败提示中「重试续跑」或「重写这一节」，也可转 AI 修复）',
        failures: [{
          code: 'GATE_FAILED', sectionId: 's2', sectionTitle: '演示：溢出节',
          finding: '节「演示：溢出节」正文过长（约 906 字 > 拒收线 800 字 = 单节预算 400×2）',
        }],
      }],
      queuedCount: 0,
    },
    'POST /generate': { message: '「入门」已入队，将在后台按序生成', queued: true },
    'POST /generate/section': { message: '[section] 「演示：溢出节」v2 落盘。' },
  })
  const { frame } = spyFrame()
  render(React.createElement(LessonView, { course: '数学', node: '入门', frame }))
  assert.ok(await screen.findByText(/上次生成失败/), '失败横幅可见（不再是一句话死横幅）')
  assert.ok(screen.getByText(/✗ 演示：溢出节：/), '结构化失败清单：节标题 + 死因')

  await click(screen.getByRole('button', { name: /重写/ }))
  await waitFor(() => {
    const rw = stubCalls().find(c => c.method === 'POST' && c.path === '/generate/section')
    assert.ok(rw, '定点重写失败节（失败节在大纲里从未消失）')
    assert.deepEqual(rw.body, { course: '数学', node: '入门', section: 's2' })
  })

  await click(screen.getByRole('button', { name: /续跑/ }))
  await waitFor(() => {
    const gen = stubCalls().find(c => c.method === 'POST' && c.path === '/generate')
    assert.ok(gen, '重试续跑 = 重新入队（断点续跑语义在服务端）')
    assert.deepEqual(gen.body, { course: '数学', node: '入门' })
  })

  await click(screen.getByRole('button', { name: /关闭/ }))
  assert.equal(screen.queryByText(/上次生成失败/), null, '关闭隐藏横幅（视图状态，存 UI 本地）')
})

test('LessonView：失败横幅「转 AI 修复」（#196 / ADR-0054）——预填失败原文开讨论弹窗', async () => {
  const { default: LessonView } = await importUi('components/LessonView.tsx')
  routes({
    'GET /lesson': LESSON_FIXTURE,
    'GET /questions': { course: '数学', node: '入门', mastery: 0.4, questions: [] },
    'GET /learner-queue': { cards: [] },
    'GET /generate/status': {
      jobs: [{
        key: '数学/入门', course: '数学', node: '入门', startedAt: '2026-09-12T10:00:00Z',
        status: 'failed', phase: 'sections', tier: '中',
        message: '[section] 「演示：溢出节」质检门未过：正文过长示例',
        failures: [{
          code: 'GATE_FAILED', sectionId: 's2', sectionTitle: '演示：溢出节',
          finding: '节「演示：溢出节」正文过长（约 906 字 > 拒收线 800 字 = 单节预算 400×2）',
        }],
      }],
      queuedCount: 0,
    },
  })
  const { frame } = spyFrame()
  render(React.createElement(LessonView, { course: '数学', node: '入门', frame }))
  assert.ok(await screen.findByText(/上次生成失败/), '失败横幅可见')
  await click(screen.getByRole('button', { name: /AI 修复/ }))
  assert.ok(await screen.findByText(/与 AI 讨论本课/), '预填讨论弹窗打开')
  const textarea = document.querySelector('.arco-modal textarea') as HTMLTextAreaElement | null
  assert.ok(textarea && textarea.value.includes('失败'), '意图已预填失败原文')
  // 关掉弹窗收尾（意图已预填，「开始讨论」交还给用户决定）
  const closeBtn = document.querySelector('.arco-modal-close-icon')
  assert.ok(closeBtn, '弹窗可关闭')
  await click(closeBtn as HTMLElement)
})

// ---- 洞察区成型（#210 / ADR-0058 T6）：六件同住洞察、待确认实验提案直达收件箱 ----

const KATA_FIXTURE = {
  date: '2026-09-13', week_start: '2026-09-07', week_end: '2026-09-13', path: 'x', created: false,
  reality: '现状段', sections: {}, answered: false, list: [{ week_start: '2026-09-07', answered: false }],
}

/** 洞察区六件取数的完整桩表（Kata/记忆健康/校准画像/沙盘/N-of-1/睡眠/Anki 通道/XP）。 */
const INSIGHT_ROUTES = (extra: Record<string, unknown> = {}) => ({
  'GET /kata': KATA_FIXTURE,
  'GET /memory': {
    date: '2026-09-13', forecast: { horizon_days: 14, overdue: 0, per_day: [] },
    state: { scheduled: 0, stability: [], difficulty: [], retrievability: [] },
    retention: { pass: 0, fail: 0, rate: null, real: 0 },
    calibration: [], forgetting: [], jol: null,
  },
  'GET /jol': { enabled: true, rate: 0.1 },
  'GET /calibration/hints': { hints_enabled: true },
  'GET /calibration/profile': { sources: [{ source: 'jol', first_ts: null, last_pair_ts: null, calibration: null, overconfidence: { overconfident: false, evidence: null } }], global: { calibration: null, warning: '' } },
  'GET /coach': { messages: [], due_hard: 0 },
  'GET /xp': XP_FIXTURE,
  'GET /experiments': { templates: [], experiments: [], report: null },
  'GET /sleep': { enabled: true },
  'GET /anki/status': { anki: null, due: { total: 0, by_deck: [] }, mirror: { entries: 0, decks: [], last_push: null, last_import: null } },
  'GET /proposals': [],
  ...extra,
})

test('洞察区六件同住一页可达：周复盘/记忆健康/校准画像/沙盘/N-of-1 实验/睡眠/Anki 通道/运行环境', async () => {
  const { default: InsightPage } = await importUi('pages/InsightPage/index.tsx')
  routes(INSIGHT_ROUTES())
  const { frame } = spyFrame()
  render(React.createElement(InsightPage, { frame }))
  // 六件 + 运行环境（实验室页退役后模型透明的家）：锚词逐件断言，不锁整句
  assert.ok(await screen.findByText(/周复盘/), 'Kata 周复盘在册')
  assert.ok(screen.getByText('记忆健康'), '记忆健康在册')
  assert.ok(screen.getByText('自评校准画像'), '校准画像在册')
  assert.ok(screen.getByText('沙盘 · 计划推演'), '沙盘在册')
  assert.ok(screen.getByText(/N-of-1 实验/), 'N-of-1 实验在册')
  assert.ok(screen.getByText('睡眠耦合排程建议'), '睡眠开关在册')
  assert.ok(screen.getByText('Anki 通道'), 'Anki 通道卡在册')
  assert.ok(screen.getByText('运行环境'), '运行环境（模型透明）随区安家')
  assert.equal(screen.queryByText(/实验室/), null, '实验室页签形态零残留')
})

test('洞察区·待确认实验提案：卡上可见并直达提案收件箱（「下一实验」→收件箱动线）', async () => {
  const { default: InsightPage } = await importUi('pages/InsightPage/index.tsx')
  routes(INSIGHT_ROUTES({
    'GET /proposals': [{
      id: 7, kind: 'experiment', course: '全部课程', status: 'pending',
      summary: '检索点位置与密度（N-of-1 提案）', artifact: 'x', created: '2026-09-13T00:00:00Z',
    }],
  }))
  const { frame, calls } = spyFrame()
  render(React.createElement(InsightPage, { frame }))
  assert.ok(await screen.findByText(/待确认/), '待确认提案在洞察区 N-of-1 卡上可见（与收件箱同源 /proposals）')
  await click(screen.getByText('去提案收件箱确认'))
  assert.deepEqual(calls.goto, [['courses.proposals']], '直达收件箱——人审动作只在收件箱')
})

test('周复盘「下一实验」：转出提案后留回执并直达提案收件箱（#210 动线第一跳）', async () => {
  const { default: KataCard } = await importUi('pages/InsightPage/KataCard.tsx')
  routes({
    'GET /kata': KATA_FIXTURE,
    'GET /experiments': {
      templates: [{ id: 'retrieval', title: '检索点位置与密度', question: '检索点放哪更划算？', description: '说明', unlocked: true }],
      experiments: [], report: null,
    },
    'POST /kata/convert/experiment': { proposal: 7, title: '检索点位置与密度', week_start: '2026-09-07' },
  })
  let inboxOpened = 0
  render(React.createElement(KataCard, { courseNames: ['数学'], onOpenInbox: () => { inboxOpened += 1 } }))
  const next = await screen.findByPlaceholderText('下周试一个小改变')
  await act(async () => { fireEvent.change(next, { target: { value: '把检索点挪到节首试试' } }) })
  await click(screen.getByText('转 N-of-1 提案'))
  assert.ok(await screen.findByText(/到提案收件箱确认后才开跑/), '弹窗指路收件箱（不再指实验室页）')
  // Arco Select：点开下拉再选模板（模板解锁态才可选；弹窗里的那个 select，不是卡片头的选周）
  await act(async () => { fireEvent.click(document.querySelector('.arco-modal .arco-select-view') as Element) })
  await click(await screen.findByText('检索点位置与密度'))
  await click(screen.getByText('发起提案'))
  await waitFor(() => {
    const c = stubCalls().find(x => x.method === 'POST' && x.path === '/kata/convert/experiment')
    assert.ok(c, '转实验提案走 /kata/convert/experiment')
    assert.deepEqual(c.body, { week_start: '2026-09-07', template: 'retrieval' }, '周与模板照传')
  })
  assert.ok(await screen.findByText(/确认开跑在提案收件箱/), '卡上留常驻回执（含提案号）')
  await click(screen.getByText('去提案收件箱确认'))
  assert.equal(inboxOpened, 1, '回执按钮直达收件箱')
})

// ---- 文案语义锁（#207 / ADR-0058 门册判据修订）：正断言 canonical 词条词 +
// Avoid 词反断言，词表唯一出处 = CONTEXT.md（判据与自检见 tests/copy-lock.test.ts
// 与门册「L3 文案语义锁」段）。三条样例常驻：沙盘非承诺 / 掌握度语境 / 休眠题列名。 ----

test('文案语义锁·沙盘：非承诺措辞必现，Avoid 词（预测沙盘/可行性判定）不得出现', async () => {
  // #210：沙盘随实验室页退役进洞察区——锁的作用域随页面搬家，判据不变
  const { default: InsightPage } = await importUi('pages/InsightPage/index.tsx')
  routes(INSIGHT_ROUTES())
  const { frame } = spyFrame()
  render(React.createElement(InsightPage, { frame }))
  await act(async () => { await new Promise(r => setTimeout(r, 20)) })
  lockCopy(document.body.textContent ?? '', { canonical: ['沙盘', '非承诺'], glossary: '沙盘（Sandbox）' })
})

test('文案语义锁·掌握度语境：呈现区不得出现 Avoid 词（熟练度/正确率等）', async () => {
  const { default: LessonView } = await importUi('components/LessonView.tsx')
  routes({
    'GET /lesson': LESSON_FIXTURE,
    'GET /questions': { course: '数学', node: '入门', mastery: 0.4, questions: [] },
    'GET /learner-queue': { cards: [] },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
  })
  const { frame } = spyFrame()
  const { container } = render(React.createElement(LessonView, { course: '数学', node: '入门', frame }))
  assert.ok(await screen.findByText(/掌握度/), '掌握度呈现区渲染')
  lockCopy(container.textContent ?? '', { canonical: ['掌握度'], glossary: 'Mastery（掌握度）' })
})

test('文案语义锁·休眠题：列名「未调度」词条明文许可，Avoid 词（死题/未调度题）不得出现', async () => {
  const { default: BankColumn } = await importUi('pages/WorkbenchPage/BankColumn.tsx')
  routes({
    'GET /questions-all': { total: 2, questions: [
      { course: '数学', node: '入门', qid: 'q1', kind: 'true_false', q: '1+1=?', due: null },
      { course: '数学', node: '入门', qid: 'q2', kind: 'true_false', q: '2+2=?', due: '2026-09-20' },
    ] },
    'GET /difficulty-advice': { nodes: [], date: '2026-09-13', dismissed: 0 },
  })
  const { frame } = spyFrame()
  render(React.createElement(BankColumn, { frame, course: '数学' }))
  assert.ok(await screen.findByText('未调度'), '休眠题的到期列名「未调度」渲染（词条明文许可）')
  lockCopy(document.body.textContent ?? '', { canonical: ['休眠题'], glossary: '休眠题（Dormant Question）' })
})
