/**
 * 卡点自报 UI seam（#248 / ADR-0077）：LessonView 页内入口只测外部行为——
 * 入口展开 → 多行输入 → 提交 → 回执三态（成功「教练回合已启动」/ 在途如实说明 /
 * 服务端拒绝带原因且输入保留）。取数走 fetch 桩（api.ts 全链路真实，网络是假的），
 * 未登记端点 404 = 服务端拒绝通道（先例 ui-honesty-dom）；文案走语义锁
 * （canonical 词条「卡点自报」，Avoid 词在组件作用域内反断言——不圈全页，
 * 页面其他区域有自己的词条语境）。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, act, cleanup, waitFor, routes, stubCalls, importUi, uiImport, arco, spyFrame } from './helpers/ui-dom.ts'
import { lockCopy } from './helpers/copy-lock.ts'

afterEach(() => {
  cleanup()
  arco.Message.clear()
})

const React = (await uiImport('react')).default

const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el) }) }

const LESSON_FIXTURE = {
  course: '数学', node: '入门', region: '', stage: 'learning', mastery: 0.4,
  sections: [{ id: 's1', title: '第一节', md: '引言段落。' }],
  manifest: null, prereqs: [], suggest_next: [],
}

/** LessonView 取数桩（无题空态，最小集）；post 登记 = 自报提交成功态。 */
function lessonRoutes(post?: Record<string, unknown>): Record<string, unknown> {
  return {
    'GET /lesson': LESSON_FIXTURE,
    'GET /questions': { course: '数学', node: '入门', mastery: 0.4, questions: [] },
    'GET /learner-queue': { cards: [] },
    'GET /generate/status': { jobs: [], queuedCount: 0 },
    ...(post ? { 'POST /coach/stuck-report': post } : {}),
  }
}

async function openEntry(post?: Record<string, unknown>): Promise<void> {
  routes(lessonRoutes(post)) // 必须先登记再 render（LessonView 挂载即取数）
  const { default: LessonView } = await importUi('components/LessonView.tsx')
  const { frame } = spyFrame()
  render(React.createElement(LessonView, { course: '数学', node: '入门', frame }))
  assert.ok(await screen.findByText(/进行中/), '学习视图渲染完成')
  await click(screen.getByRole('button', { name: /我卡住了/ }))
  assert.ok(screen.getByText(/卡点自报：/), '入口展开（canonical 词可见）')
  // 语义锁：入口组件作用域内 canonical 词在场、Avoid 词禁用（展开态才有文案）
  lockCopy(screen.getByTestId('stuck-report-entry'), { canonical: ['卡点自报'], glossary: '卡点自报（Stuck Report）' })
}

async function typeAndSubmit(text: string): Promise<void> {
  const area = screen.getByPlaceholderText(/对不上/) as HTMLTextAreaElement
  await act(async () => { fireEvent.change(area, { target: { value: text } }) })
  await click(screen.getByRole('button', { name: /提交给教练/ }))
}

test('卡点自报：提交成功 → POST 原话 + 回执「教练回合已启动」；文案语义锁', async () => {
  await openEntry({ recorded: true, ts: '2026-09-14T09:00:00', queued: true,
    message: '教练回合已启动：你的自报原话会随回合交给教练归因，建议稍后呈现。' })
  await typeAndSubmit('这节的导数和上一节的极限对不上')
  await waitFor(() => {
    assert.ok(screen.getByTestId('stuck-report-receipt'), '回执呈现')
  }, { timeout: 3000 })
  assert.match(screen.getByTestId('stuck-report-receipt').textContent ?? '', /教练回合已启动/)
  const call = stubCalls().find(c => c.path === '/coach/stuck-report')
  assert.ok(call, '提交已发出')
  assert.equal(call!.method, 'POST')
  assert.deepEqual(call!.body, { course: '数学', node: '入门', text: '这节的导数和上一节的极限对不上' })
  assert.match(screen.getByTestId('stuck-report-receipt').className, /lh-callout-ok/, 'queued=true 成功态样式')
  assert.equal(screen.queryByPlaceholderText(/对不上/), null, '成功后输入框收起')
})

test('卡点自报：在途回合 → 回执如实说明不重复入队（queued=false）', async () => {
  await openEntry({ recorded: true, ts: '2026-09-14T09:00:00', queued: false,
    message: '已有生长批任务在途，不重复入队。' })
  await typeAndSubmit('第二报')
  await waitFor(() => {
    assert.ok(screen.getByTestId('stuck-report-receipt'), '回执呈现')
  }, { timeout: 3000 })
  assert.match(screen.getByTestId('stuck-report-receipt').textContent ?? '', /在途/)
  // queued=false 不弹成功框（#155 诚实着色）：留了账但无新回合，警示而非成就
  assert.match(screen.getByTestId('stuck-report-receipt').className, /lh-callout-warn/, '在途态警示样式（非成功绿）')
})

test('卡点自报：服务端拒绝（频控 404 通道）→ 拒绝回执 + 输入保留', async () => {
  await openEntry() // 不登记 POST → 404 拒绝通道（先例 ui-honesty-dom）
  await typeAndSubmit('同节点第二条')
  await waitFor(() => {
    assert.ok(screen.getByTestId('stuck-report-receipt'), '拒绝回执呈现')
  }, { timeout: 3000 })
  const receipt = screen.getByTestId('stuck-report-receipt')
  assert.match(receipt.className, /lh-callout-danger/, '拒绝态样式（非成功态）')
  assert.match(receipt.textContent ?? '', /测试桩未登记路由/, '拒绝原因带服务端原文')
  const area = screen.getByPlaceholderText(/对不上/) as HTMLTextAreaElement
  assert.equal(area.value, '同节点第二条', '失败后输入保留（改改再试）')
})
