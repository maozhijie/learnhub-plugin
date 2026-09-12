/**
 * L3 三大页关键交互测试（#188 / #187 决议·Testing Decisions）：LearnPage /
 * StatsPage / LessonView 各至少一条用户可见交互 + 页签表完整性必测项（Exhibit A：
 * #158 的项目页签修复漏了 TAB_KEYS 键项，按钮在、键表缺，点击渲染空白——三层
 * 验收全未拦截，本门自此锁死该缺陷类）。只测外部行为：点击后出现什么、调了哪个
 * 端点；不断言内部状态。取数走 fetch 桩（api.ts 全链路真实，网络是假的），
 * 未登记端点 404 → 次要数据按缝级三态显式失败——不翻页正是该缝的承诺。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, fireEvent, act, cleanup, waitFor, routes, stubCalls, importUi, uiImport, arco, spyFrame } from './helpers/ui-dom.ts'

afterEach(() => {
  cleanup()
  arco.Message.clear()
})

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const React = (await uiImport('react')).default

// ---- 页签表完整性（Exhibit A 必测项）：三张表互为镜像 ----
// 三张表的宿主文件不写死（#189 会把 TAB_KEYS/路由表挪进 lib/router）：在 ui/src
// 全树扫描各自唯一的定义处——表残缺、改名未同步、抽取面塌掉，任一发生即红。

test('页签表完整性：TabPane 键、TAB_KEYS、TabBody 分支三表一致（Exhibit A 锁死）', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
  const sources = walk(join(ROOT, 'ui', 'src')).map(p => [p, readFileSync(p, 'utf8')] as const)
  const pick = (pattern: RegExp, what: string): { file: string; src: string } => {
    const hits = sources.filter(([, src]) => pattern.test(src))
    assert.equal(hits.length, 1, `${what} 的定义处应恰有一个文件，实得 ${hits.length}（表被挪动后未同步本门）：${hits.map(([f]) => f).join(', ') || '零'}`)
    return { file: hits[0]![0]!, src: hits[0]![1]! }
  }
  const pane = pick(/TabPane key='/, 'TabPane 键表（页签按钮）')
  const keys = pick(/const TAB_KEYS[^=]*= \[/, 'TAB_KEYS 键表（页签保活）')
  const body = pick(/TAB_KEYS\.filter/, 'TabBody 分支表（按键挂载）')

  const paneKeys = [...pane.src.matchAll(/TabPane key='([^']+)'/g)].map(m => m[1]!)
  const tabKeys = (keys.src.match(/const TAB_KEYS[^=]*= \[([^\]]*)\]/)?.[1] ?? '')
    .split(',').map(s => s.trim().replaceAll("'", '')).filter(Boolean)
  const branchKeys = [...body.src.matchAll(/k === '([^']+)'/g)].map(m => m[1]!)
  assert.ok(paneKeys.length > 0 && tabKeys.length > 0 && branchKeys.length > 0,
    '三表任一为空 = 抽取面塌了（表形状改变后未同步本门）')
  assert.deepEqual(
    paneKeys.filter(k => !tabKeys.includes(k)), [],
    `TabPane 有按钮而 TAB_KEYS 缺键 = 点击渲染空白（a6fea08 之前的缺陷形状，本门禁止复活；TabPane 在 ${pane.file}，TAB_KEYS 在 ${keys.file}）`)
  assert.deepEqual(
    tabKeys.filter(k => !paneKeys.includes(k)), [],
    'TAB_KEYS 有键而 TabPane 无按钮 = 不可见的幽灵保活页签')
  assert.deepEqual(
    branchKeys.filter(k => !tabKeys.includes(k)), [],
    'TabBody 有渲染分支而 TAB_KEYS 缺键 = 分支永挂载（keep-alive 表残缺）')
  assert.deepEqual(
    tabKeys.filter(k => !branchKeys.includes(k)), [],
    'TAB_KEYS 有键而 TabBody 无分支 = 页签切过去是白屏')
})

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
