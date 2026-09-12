/**
 * L3 三大页关键交互测试（#188 / #187 决议·Testing Decisions）：LearnPage /
 * StatsPage / LessonView 各至少一条用户可见交互。只测外部行为：点击后出现什么、
 * 调了哪个端点；不断言内部状态。取数走 fetch 桩（api.ts 全链路真实，网络是假的），
 * 未登记端点 404 → 次要数据按缝级三态显式失败——不翻页正是该缝的承诺。
 * 页签表完整性（Exhibit A，#187 曾列为 U2 必测项）由 tests/ui-router.test.ts 的
 * 三表对账门独家执法（#189 落地后 TAB_KEYS 唯一出处 = lib/router.ts，该门直接
 * 消费权威导出且断言面是超集；本文件的初版同门已收敛退役，留两道=双份漂移税）。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, act, cleanup, waitFor, routes, stubCalls, importUi, uiImport, arco, spyFrame } from './helpers/ui-dom.ts'

afterEach(() => {
  cleanup()
  arco.Message.clear()
})

const React = (await uiImport('react')).default

// ---- 共享夹具 ----

const XP_FIXTURE = {
  date: '2026-09-12', day_cutoff: '05:00', today_xp: 42, goal: 30,
  streak: 3, streak_grace_days: 1,
  eta: [{ course: '数学', remaining: 5, done: 2, per_node: 10, days: 3 }],
}

const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el) }) }

// ---- LearnPage：推荐流主数据三态 + 点卡进学习视图 ----

test('LearnPage：推荐卡点「去学习」→ frame.openLesson 打开该节点', async () => {
  const { default: LearnPage } = await importUi('pages/LearnPage/index.tsx')
  routes({
    'GET /recommend': { date: '2026-09-12', events: [{
      type: 'new', course: '数学', node: '入门', region: '', score: 1, why: '起点', path: null, hasContent: true,
    }] },
    'GET /xp': XP_FIXTURE,
    'GET /review-queue': { total: 2, cards: [], calibration_hint: null, note_drifted: [], note_suspended: [] },
    'GET /anki/status': { anki: null, due: { total: 0 }, mirror: {} },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
    'GET /learner-queue': { cards: [] },
  })
  const { frame, calls } = spyFrame()
  render(React.createElement(LearnPage, { frame }))
  assert.ok(await screen.findByText('接下来'), '推荐流加载后出现「接下来」卡')
  assert.ok(screen.getByText('入门'), '推荐事件按节点名渲染')
  await click(screen.getByText('去学习'))
  assert.deepEqual(calls.openLesson, [['数学', '入门']], '点开直接进该节点的学习视图')
})

test('LearnPage：主数据失败 = 整页失败态（次要不翻页），重试可点', async () => {
  const { default: LearnPage } = await importUi('pages/LearnPage/index.tsx')
  routes({ 'GET /xp': XP_FIXTURE }) // /recommend 未登记 → 404：主数据失败
  const { frame } = spyFrame()
  render(React.createElement(LearnPage, { frame }))
  assert.ok(await screen.findByText('学习页加载失败'), '推荐流失败进 page 变体失败态')
  assert.ok(screen.getByText('重试'))
  assert.equal(screen.queryByText('接下来'), null, '失败态不渲染主数据区')
  assert.ok(await screen.findByText('我的课程'), '次要区（课程卡）不受主数据失败影响')
})

test('LearnPage：生成中节点的推荐卡显示逐节进度态（#160），而非只会说在队列', async () => {
  const { default: LearnPage } = await importUi('pages/LearnPage/index.tsx')
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
    'GET /learner-queue': { cards: [] },
  })
  const { frame } = spyFrame()
  render(React.createElement(LearnPage, { frame }))
  assert.ok(await screen.findByText('接下来'), '推荐流加载后出现「接下来」卡')
  const progress = await screen.findAllByText('生成中 3/7')
  assert.ok(progress.length >= 1, '生成中节点带逐节进度（Tag 与按钮同一读数）')
  assert.equal(screen.queryByText('生成正文'), null, '生成中不渲染「生成正文」按钮（动作诚实）')
})

// ---- StatsPage：XP 账本 + 每日目标保存 ----

test('StatsPage：今日 XP 上账，保存每日目标 → PUT /daily-goal + 成功轻提示', async () => {
  const { default: StatsPage } = await importUi('pages/StatsPage/index.tsx')
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
  assert.ok(document.body.textContent!.includes('每日目标已调整为 30 XP'), '成功轻提示可见')
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
  assert.ok(await screen.findByText('进行中'), '节点状态标签可见')
  assert.ok(screen.getByText('整课正文（自由阅读）'), '正文折叠卡可见（内容懒渲染）')
  assert.ok(screen.getByText(/还没有题目/), '无题空态引导可见')
  await click(screen.getByText('展开完整正文'))
  assert.ok(await screen.findByText('第一节'), '折叠展开后按节渲染正文')
  await click(screen.getByText('AI 出题（6 道混合题型）'))
  await waitFor(() => {
    const gen = stubCalls().find(c => c.method === 'POST' && c.path === '/question-generate')
    assert.ok(gen, '出题任务化入队')
    assert.deepEqual(gen.body, { course: '数学', node: '入门', count: 6 })
  })
  assert.ok(document.body.textContent!.includes('出题任务已入队'), '入队轻提示可见')
  await click(screen.getByText('← 返回'))
  assert.equal(calls.closeLesson!.length, 1, '返回收起学习视图')
})
