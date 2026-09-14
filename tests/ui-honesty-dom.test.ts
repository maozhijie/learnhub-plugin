/**
 * L3 交互测试：#155 面板硬 bug 与交互诚实性 + #156 提案应用闭环（ui-dom 同款缝）。
 * 只测外部行为：禁用态可见、点击回调拿到正确落点、拒绝语义弹非成功提示、
 * 应用后出现按类型分流的「查看结果」；arco Modal.confirm 用实例级替身自动确认
 * （人点「确定」的等价物，顺带捕获确认框内容）。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, act, cleanup, waitFor, routes, stubCalls, importUi, uiImport, arco, spyFrame } from './helpers/ui-dom.ts'

afterEach(() => {
  cleanup()
  arco.Message.clear()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const M = (arco as any).Modal
  if (M.__origConfirm) { M.confirm = M.__origConfirm; delete M.__origConfirm }
})

const React = (await uiImport('react')).default
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const arcoAny = arco as any

// ProposalsPage 的取数经 usePolling 的页签激活门（active-tab 模块态在首次 import 时
// 从路由 hash 初始化）：预置 hash 到提案页签，激活门才放行首拍取数
window.location.hash = '#/courses/proposals'

const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el) }) }

/** Modal.confirm 替身：记录确认框并自动「确定」（调用 onOk）。 */
function autoConfirm(): Array<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = []
  arcoAny.__origConfirm = arcoAny.Modal.confirm
  arcoAny.Modal.confirm = (cfg: Record<string, unknown>) => {
    captured.push(cfg)
    void (cfg.onOk as () => Promise<void>)()
  }
  return captured
}

const JOB_FIXTURE = {
  key: '数学/种子起草', course: '数学', node: '种子起草', status: 'running',
  startedAt: '2026-09-12T00:00:00Z', phase: 'seed',
}

// ---- CoachCockpit（#155/#240）：零终点禁用生长/罗盘重画 + 任务条点击定位 ----

test('CoachCockpit：零终点课程「生长一步」「罗盘重画」禁用并说明先到图屏加终点', async () => {
  const { default: CoachCockpit } = await importUi('components/CoachCockpit.tsx')
  render(React.createElement(CoachCockpit, { course: '数学', jobs: [], coach: null, endpointCount: 0, onOpenJob: () => undefined }))
  const growth = screen.getByText('生长一步').closest('button')
  assert.ok(growth, '生长一步按钮存在')
  assert.equal(growth!.hasAttribute('disabled'), true, '零终点 = 必然失败的操作（教练回合要有一个方向才能裁决），按钮禁用')
  assert.equal(screen.getByText('罗盘重画').closest('button')!.hasAttribute('disabled'), true, '罗盘重画同禁：零终点没有可裁决的方向')
  assert.ok(document.body.textContent!.includes('还没有终点'), '禁用说明可见')
  assert.ok(document.body.textContent!.includes('添加终点'), '说明指向先到图屏「添加终点」给课程方向')
})

test('CoachCockpit：有终点的课程「生长一步」可点', async () => {
  const { default: CoachCockpit } = await importUi('components/CoachCockpit.tsx')
  render(React.createElement(CoachCockpit, { course: '数学', jobs: [], coach: null, endpointCount: 2, onOpenJob: () => undefined }))
  const growth = screen.getByText('生长一步').closest('button')
  assert.equal(growth!.hasAttribute('disabled'), false, '有终点不禁用')
  assert.equal(document.body.textContent!.includes('还没有终点'), false, '不渲染零终点说明')
})

test('CoachCockpit：在途任务条点击 → onOpenJob 带任务 key（落生成页定位该任务）', async () => {
  const { default: CoachCockpit } = await importUi('components/CoachCockpit.tsx')
  const seen: string[] = []
  render(React.createElement(CoachCockpit, {
    course: '数学', jobs: [JOB_FIXTURE], coach: null, endpointCount: 2,
    onOpenJob: (j: { key: string }) => seen.push(j.key),
  }))
  assert.ok(screen.getByText(/看全程/), '在途条可见')
  await click(screen.getByText(/种子起草（数学）/))
  assert.deepEqual(seen, ['数学/种子起草'], '点击回调带任务注册表 key')
})

// ---- SeedFormModal（#155/#240）：建课表单只收一个课程名，按引擎真实返回着色 ----

/** 填名提交（ADR-0076：建课 = 名称即空图——没有目标描述/类型/工作表字段）。
 * registered=true 登记成功路由；false 不登记，借桩的 404 通道模拟服务端拒绝
 * （重名等校验失败 → ApiError → 错误提示、表单不收起）。 */
async function fillAndSubmit(registered: boolean): Promise<{ cancelled: number[] }> {
  const { default: SeedFormModal } = await importUi('components/SeedFormModal.tsx')
  const cancelled: number[] = []
  routes(registered ? { 'POST /course/create': { name: '线性代数', root: '线性代数' } } : {})
  render(React.createElement(SeedFormModal, {
    visible: true, course: null,
    onCancel: () => { cancelled.push(1) },
  }))
  // 表单字段就绪（Modal 弹层异步挂载）：名字输入框出现后再填
  const nameInput = await screen.findByPlaceholderText(/课程名（如/)
  await act(async () => { fireEvent.change(nameInput, { target: { value: '线性代数' } }) })
  await click(screen.getByText('建课'))
  await waitFor(() => { assert.ok(stubCalls().some(c => c.path === '/course/create'), '提交已发出') }, { timeout: 3000 })
  return { cancelled }
}

test('SeedFormModal：建课成功 = 成功提示且表单收起', async () => {
  const { cancelled } = await fillAndSubmit(true)
  assert.ok(document.body.textContent!.includes('已创建'), '成功提示可见（锚词）')
  assert.ok(cancelled.length > 0, '表单收起（onCancel 已被调）')
})

test('SeedFormModal：建课被拒 = 非成功样式（error），表单不收起', async () => {
  await fillAndSubmit(false)
  await waitFor(() => {
    assert.ok(document.body.textContent!.includes('未登记路由'), '拒绝消息可见（桩 404 通道的 ApiError 文案）')
  })
  assert.ok(screen.getByPlaceholderText(/课程名（如/), '表单不收起：输入框仍在')
})

// ---- ProposalsPage（#156）：应用全局刷新 + 查看结果按类型分流 ----

/** 可变提案夹具：apply 后翻转 status（服务端事实翻转的替身），列表重取即读新态。 */
const proposalFix: Array<Record<string, unknown>> = []

function resetProposals(): void {
  proposalFix.splice(0, proposalFix.length, {
    id: 7, kind: 'seed', course: '数学', status: 'pending', pair: undefined,
    summary: '1–3 起点 + 终点', artifact: '', created: '2026-09-12T00:00:00Z',
  })
  routes({ 'GET /proposals': proposalFix, 'POST /proposals/apply': { message: '已应用' } })
}

/** 应用后重取列表：status 翻转后以**新数组引用**重注册路由（同引用会被 React 的
 * setItems bailout 吞掉），再走页签激活事件这条真缝触发重取。 */
async function refetchProposals(): Promise<void> {
  routes({ 'GET /proposals': [...proposalFix], 'POST /proposals/apply': { message: '已应用' } })
  await act(async () => {
    await new Promise(r => setTimeout(r, 50))
    window.dispatchEvent(new CustomEvent('learnhub:tab', { detail: 'courses.proposals' }))
    await new Promise(r => setTimeout(r, 50))
  })
}

test('ProposalsPage：应用成功出现「查看结果」，种子提案点击落图页并预置课程', async () => {
  autoConfirm()
  const { default: ProposalsPage } = await importUi('pages/ProposalsPage.tsx')
  resetProposals()
  const { frame, calls } = spyFrame()
  render(React.createElement(ProposalsPage, { frame }))
  assert.ok(await screen.findByText('待审'), '提案列表加载')
  await click(screen.getByText('应用'))
  await waitFor(() => { assert.ok(stubCalls().some(c => c.path === '/proposals/apply'), 'apply 已发出') })
  proposalFix[0]!.status = 'applied'
  await refetchProposals()
  await click(await screen.findByText('查看结果'))
  assert.deepEqual(calls.openCourse, [['数学', 'graph']], '种子提案 → 单课工作台罗盘与图，openCourse 自带课程预置（#209）')
})

test('ProposalsPage：富化提案「查看结果」落题库，反编译对（pair）落项目页', async () => {
  autoConfirm()
  const { default: ProposalsPage } = await importUi('pages/ProposalsPage.tsx')
  resetProposals()
  // 本用例只放两行：富化在前、反编译种子半区（pair=4）在后
  proposalFix.splice(0, 1,
    { id: 8, kind: 'enrich', course: '数学', status: 'pending', pair: undefined, summary: 's', artifact: '', created: '2026-09-12T00:00:00Z' },
    { id: 9, kind: 'seed', course: '数学', status: 'pending', pair: 4, summary: '反编译种子半区', artifact: '', created: '2026-09-12T00:00:00Z' },
  )
  const { frame, calls } = spyFrame()
  render(React.createElement(ProposalsPage, { frame }))
  assert.ok((await screen.findAllByText('待审')).length === 2, '两条提案待审')
  // 应用富化 #8 → 查看结果 → bank
  await click(screen.getAllByText('应用')[0])
  await waitFor(() => { assert.ok(stubCalls().filter(c => c.path === '/proposals/apply').length === 1) })
  proposalFix[0]!.status = 'applied'
  await refetchProposals()
  await click(await screen.findByText('查看结果'))
  assert.deepEqual(calls.openCourse, [['数学', 'bank']], '富化 → 单课工作台题库分栏（#209）')
  // 应用反编译种子半区 #9 → 查看结果 → projects（routes() 重注册清空调用记录，按 body.id 断言）
  await click(screen.getAllByText('应用')[0])
  await waitFor(() => {
    assert.ok(stubCalls().some(c => c.method === 'POST' && c.path === '/proposals/apply'
      && (c.body as { id?: number }).id === 9), '#9 的 apply 已发出')
  })
  proposalFix[1]!.status = 'applied'
  await refetchProposals()
  const views = await screen.findAllByText('查看结果')
  await click(views[views.length - 1])
  assert.ok(calls.goto.some(g => g[0] === 'projects'), '反编译对 → 项目页')
})
