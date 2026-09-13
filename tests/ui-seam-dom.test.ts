/**
 * L3 数据获取缝交互测试（#188 / ADR-0051 第二层）：useCommand / CommandBoundary /
 * usePolling 挂在真实 DOM 上按用户可见行为断言——加载/失败/空三态、命令重取、
 * 竞态 latest-wins、失败不翻转。不断言 hook 内部状态（#187 Testing Decisions），
 * 渲染探针把缝供给的三态印成文本，断言的就是「使用者看见什么」。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, act, cleanup, waitFor, routes, stubCalls, importUi, uiImport, arco } from './helpers/ui-dom.ts'

afterEach(() => {
  cleanup()
  arco.Message.clear()
})

const React = (await uiImport('react')).default
const { useCommand, errorMessage } = await importUi('hooks/useCommand.ts')
const { CommandBoundary } = await importUi('components/CommandBoundary.tsx')
const { usePolling } = await importUi('hooks/usePolling.ts')
const { ApiError } = await importUi('api.ts')

function deferred<T = unknown>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 缝的呈现探针：把 Command 三态印成一行文本 + 一个「重取」按钮。 */
let latestCmd: { set: (v: unknown) => void } | null = null
function CmdProbe(props: { fn: () => Promise<unknown>; deps?: unknown[] }) {
  const cmd = useCommand(props.fn, props.deps)
  latestCmd = cmd
  const text = `d=${cmd.data === null ? 'null' : JSON.stringify(cmd.data)} e=${cmd.error ?? '-'} l=${cmd.loading ? 1 : 0}`
  return React.createElement('div', null,
    React.createElement('span', null, text),
    React.createElement('button', { onClick: () => void cmd.reload() }, '重取'))
}

test('useCommand：首载 loading → 数据到达', async () => {
  const gate = deferred<string>()
  render(React.createElement(CmdProbe, { fn: () => gate.promise }))
  assert.ok(screen.getByText(/^d=null e=- l=1$/), '首载必须是 loading 态')
  await act(async () => { gate.resolve('v1') })
  assert.ok(screen.getByText(/^d="v1" e=- l=0$/))
})

test('useCommand：失败只写 error，ApiError 消息经 errorMessage 单点透出', async () => {
  const gate = deferred()
  render(React.createElement(CmdProbe, { fn: () => gate.promise }))
  await act(async () => { gate.reject(new ApiError(500, '课程不存在')) })
  assert.ok(screen.getByText(/^d=null e=课程不存在 l=0$/), '失败不翻转：首载前 data 保持 null')
  assert.equal(errorMessage(new Error('boom')), 'boom')
})

test('useCommand：已有数据后的刷新失败保持旧数据不翻转', async () => {
  const gates = [deferred<string>(), deferred()]
  let n = 0
  render(React.createElement(CmdProbe, { fn: () => gates[n++]!.promise }))
  await act(async () => { gates[0]!.resolve('v1') })
  await act(async () => { fireEvent.click(screen.getByText('重取')) })
  await act(async () => { gates[1]!.reject(new Error('宿主暂不可达')) })
  assert.ok(screen.getByText(/^d="v1" e=宿主暂不可达 l=0$/),
    '旧数据保持、错误可见——#158「刷新失败不伪装」的缝级语义')
})

test('useCommand：命令重取——点击后真实再发一次请求', async () => {
  let n = 0
  render(React.createElement(CmdProbe, { fn: async () => `第${++n}次` }))
  await screen.findByText(/d="第1次"/)
  await act(async () => { fireEvent.click(screen.getByText('重取')) })
  await screen.findByText(/d="第2次"/)
  assert.equal(n, 2)
})

test('useCommand：latest-wins——迟到的旧响应整体丢弃', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  const queue = [first.promise, second.promise]
  let n = 0
  render(React.createElement(CmdProbe, { fn: () => queue[n++]! }))
  await act(async () => {
    fireEvent.click(screen.getByText('重取')) // 首载（first）在途时用户重取
    second.resolve('新') // 重取的响应先落定
  })
  await act(async () => { first.resolve('旧') }) // 迟到的旧响应后到
  assert.ok(screen.getByText(/^d="新" e=- l=0$/), 'seq 守卫丢掉旧响应，数据停在新值')
})

test('useCommand：set 本地写入绕过取数；deps 变化即重取', async () => {
  let n = 0
  const { rerender } = render(React.createElement(CmdProbe, { fn: async () => `r${++n}`, deps: ['a'] }))
  await screen.findByText(/d="r1"/)
  await act(async () => { latestCmd!.set('手动回填') })
  assert.ok(screen.getByText(/d="手动回填"/), '乐观更新/动作回填的直接写入')
  assert.equal(n, 1, 'set 不发请求')
  rerender(React.createElement(CmdProbe, { fn: async () => `r${++n}`, deps: ['b'] }))
  await screen.findByText(/d="r2"/)
})

// ---- CommandBoundary（共享三态呈现组件） ----

const cmdOf = (partial: Record<string, unknown>) => ({
  data: null, loading: false, error: null, reload: async () => {}, set: () => {}, ...partial,
})

test('CommandBoundary：加载/失败/内容三态一个长相，重试入口可点', async () => {
  const reloadCalls: unknown[][] = []
  const children = (d: unknown) => React.createElement('div', null, `内容:${JSON.stringify(d)}`)
  const { rerender } = render(React.createElement(CommandBoundary, { cmd: cmdOf({ loading: true }), children }))
  assert.ok(screen.getByText(/加载中/), 'card 变体缺省加载文案')

  rerender(React.createElement(CommandBoundary, {
    cmd: cmdOf({ error: '宿主暂不可达', reload: () => { reloadCalls.push([]); return Promise.resolve() } }),
    children,
  }))
  assert.ok(screen.getByText(/宿主暂不可达/), 'card 变体失败态内联提示')
  await act(async () => { fireEvent.click(screen.getByText('重试')) })
  assert.equal(reloadCalls.length, 1, '缺省重试入口 = cmd.reload')

  rerender(React.createElement(CommandBoundary, { cmd: cmdOf({ data: { v: 1 } }), children }))
  assert.ok(screen.getByText('内容:{"v":1}'), 'children(data) 渲染')
  assert.equal(screen.queryByText('重试'), null, '内容态不再有重试')
})

test('CommandBoundary：page 变体整页失败 + 空态由调用方派生', () => {
  render(React.createElement('div', null,
    React.createElement(CommandBoundary, {
      cmd: cmdOf({ error: '引擎不在' }), variant: 'page', title: '学习页加载失败',
      children: () => React.createElement('div', null, '不该出现'),
    }),
    React.createElement(CommandBoundary, {
      cmd: cmdOf({ data: [] }),
      children: (xs: unknown[]) => React.createElement('div', null, xs.length === 0 ? '暂无推荐' : '有内容'),
    })))
  assert.ok(screen.getByText('学习页加载失败'), 'page 变体 = 整页 Result 标题')
  assert.ok(screen.getByText('重试'))
  assert.ok(screen.getByText('暂无推荐'), '空数组交给调用方派生空态——缝不越权')
})

test('CommandBoundary：真实缝端到端——失败后点重试成功，内容出现', async () => {
  routes({ 'GET /things': { items: ['a'] } })
  let fail = true
  const Probe = () => {
    const cmd = useCommand<{ items: string[] }>(async () => {
      if (fail) throw new ApiError(500, '引擎不在')
      return await fetch('/learnhub/api/things').then(r => r.json()) as { items: string[] }
    })
    return React.createElement(CommandBoundary, { cmd, children: (d: { items: string[] }) =>
      React.createElement('div', null, d.items.join(',')) })
  }
  render(React.createElement(Probe))
  assert.ok(await screen.findByText(/引擎不在/), '首载失败显式可见')
  fail = false
  await act(async () => { fireEvent.click(screen.getByText('重试')) })
  assert.ok(await screen.findByText('a'), '重试走真实缝再发请求并渲染内容')
  assert.equal(stubCalls().length, 1, 'fetch 桩接住重取请求（首载失败发生在取数之前）')
})

test('usePolling：挂载即取数；learnhub:tab 命中本页签立即补取，非本页签不动', async () => {
  const { setActiveTab } = await importUi('active-tab.ts')
  setActiveTab('today')
  let ticks = 0
  function PollProbe() {
    usePolling(async () => { ticks++ }, { tab: 'today', intervalMs: 60_000 })
    return null
  }
  render(React.createElement(PollProbe))
  await waitFor(() => assert.equal(ticks, 1, '挂载即取数（keep-alive 首次进入页签必激活）'))
  const win = globalThis.window as unknown as { dispatchEvent: (e: unknown) => boolean }
  const CustomEventCtor = globalThis.CustomEvent as unknown as new (t: string, init: { detail: string }) => unknown
  await act(async () => { win.dispatchEvent(new CustomEventCtor('learnhub:tab', { detail: 'courses.graph' })) })
  assert.equal(ticks, 1, '非本页签的切回事件不触发')
  await act(async () => { win.dispatchEvent(new CustomEventCtor('learnhub:tab', { detail: 'today' })) })
  assert.equal(ticks, 2, '切回本页签立即补取数')
})
