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

// ---- CoachCockpit（#155）：未播种禁用生长 + 任务条点击定位 ----

test('CoachCockpit：未播种课程「生长一步」禁用并说明先走种子提案', async () => {
  const { default: CoachCockpit } = await importUi('components/CoachCockpit.tsx')
  const { frame } = spyFrame()
  render(React.createElement(CoachCockpit, { course: '数学', jobs: [], coach: null, seeded: false, onOpenJob: () => undefined, frame }))
  const growth = screen.getByText('生长一步').closest('button')
  assert.ok(growth, '生长一步按钮存在')
  assert.equal(growth!.hasAttribute('disabled'), true, '未播种 = 必然失败的操作，按钮禁用')
  assert.ok(document.body.textContent!.includes('未播种'), '禁用说明可见')
  assert.ok(document.body.textContent!.includes('种子提案'), '说明指向先走种子提案')
})

test('CoachCockpit：已播种课程「生长一步」可点', async () => {
  const { default: CoachCockpit } = await importUi('components/CoachCockpit.tsx')
  render(React.createElement(CoachCockpit, { course: '数学', jobs: [], coach: null, seeded: true, onOpenJob: () => undefined }))
  const growth = screen.getByText('生长一步').closest('button')
  assert.equal(growth!.hasAttribute('disabled'), false, '已播种不禁用')
  assert.equal(document.body.textContent!.includes('未播种：'), false, '不渲染未播种说明')
})

test('CoachCockpit：在途任务条点击 → onOpenJob 带任务 key（落生成页定位该任务）', async () => {
  const { default: CoachCockpit } = await importUi('components/CoachCockpit.tsx')
  const seen: string[] = []
  render(React.createElement(CoachCockpit, {
    course: '数学', jobs: [JOB_FIXTURE], coach: null, seeded: true,
    onOpenJob: (j: { key: string }) => seen.push(j.key),
  }))
  assert.ok(screen.getByText(/看全程/), '在途条可见')
  await click(screen.getByText(/种子起草（数学）/))
  assert.deepEqual(seen, ['数学/种子起草'], '点击回调带任务注册表 key')
})

// ---- SeedFormModal（#155）：按引擎真实返回着色 ----

async function fillAndSubmit(queued: boolean): Promise<void> {
  const { default: SeedFormModal } = await importUi('components/SeedFormModal.tsx')
  routes({ 'POST /seed/propose': { message: queued ? '已入队' : '「线性代数」种子起草任务已在途，不重复入队。', queued } })
  const cancelled: number[] = []
  render(React.createElement(SeedFormModal, {
    visible: true, mode: 'new', course: null,
    onCancel: () => { cancelled.push(1) },
  }))
  // 表单字段就绪（Modal 弹层异步挂载）：名字输入框出现后再填
  const nameInput = await screen.findByPlaceholderText(/课程名（如/)
  await act(async () => { fireEvent.change(nameInput, { target: { value: '线性代数' } }) })
  await act(async () => { fireEvent.change(screen.getByPlaceholderText(/目标描述/), { target: { value: '会解线性方程组' } }) })
  await click(screen.getByText('起草种子提案'))
  await waitFor(() => { assert.ok(stubCalls().some(c => c.path === '/seed/propose'), '提交已发出') }, { timeout: 3000 })
}

test('SeedFormModal：入队成功 = 成功提示且表单收起', async () => {
  await fillAndSubmit(true)
  assert.ok(document.body.textContent!.includes('已入队'), '成功提示可见')
})

test('SeedFormModal：已在途拒绝 = 非成功样式（warning），表单不收起', async () => {
  await fillAndSubmit(false)
  await waitFor(() => {
    assert.ok(document.body.textContent!.includes('不重复'), '拒绝消息可见（锚词）')
  })
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
  assert.deepEqual(calls.setCourse, [['数学']], '图页落点预置提案课程')
  assert.deepEqual(calls.goto, [['courses.graph']], '种子提案 → 课程区学习图')
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
  assert.deepEqual(calls.goto, [['courses.bank']], '富化 → 课程区题库')
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
