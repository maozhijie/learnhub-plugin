/**
 * dsh-learnhub 客户端：侧边栏底栏「学习中心」入口 + learnhub:discuss 宿主桥。
 * 入口在新标签页打开 /learnhub SPA（命名窗口复用，重复点击聚焦既有 tab）——
 * 独立浏览器窗口替代旧的右侧分屏 iframe：分屏挤压会话区、露出的部分又无法
 * 同时对话，没有存在价值；独立窗口可全屏沉浸，双显示器用户可拖到第二屏
 * 实现真正的「边学边聊」。
 * 页面本体改动无需重建客户端（host 每次请求现读 web/dist）。
 * 架构参照 dsh-worktable：slots 座位注入 + ModuleLoader 单文件 bundle。
 */

/** 学习中心标签页的命名窗口：复用同一 tab，避免每次点击堆新窗口。 */
const PANEL_WINDOW = 'dsh-learnhub'

/** 侧边栏底栏入口：新标签页打开学习中心。 */
function LearnhubSection() {
  return (
    <div className="dsh-lh_section">
      <button
        type="button"
        className="dsh-lh_btn"
        title="在新标签页打开学习中心"
        onClick={() => { window.open('/learnhub', PANEL_WINDOW)?.focus() }}
      >
        <span className="dsh-lh_icon">📚</span>
        <span>学习中心</span>
      </button>
    </div>
  )
}

/** 「与 AI 讨论本课」：取课程上下文 → 新开 dsh 会话注入首条消息 → 应用窗口尽力切回前台。
 * 学习中心标签页保持打开（不打断学习者当前进度，讨论完自行切回或关掉）。 */
async function discussInDsh(sessions: {
  list: { getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> } }
  create(opts?: { cwd?: string }): Promise<string>
  open(id: string): void
  binding(id: string): { session: { prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue'): Promise<unknown> } } | undefined
}, course: string, node: string, intent: string): Promise<void> {
  let pack = ''
  try {
    const res = await fetch(`/learnhub/api/discuss-pack?course=${encodeURIComponent(course)}&node=${encodeURIComponent(node)}`)
    if (res.ok) {
      const doc: unknown = await res.json()
      if (typeof doc === 'string') pack = doc
    }
  } catch { /* 上下文拿不到也能讨论（agent 可用 learnhub 工具自取） */ }
  let cwd: string | undefined
  try {
    const snap = sessions.list.getSnapshot()
    cwd = snap.current ? snap.byId[snap.current]?.cwd : undefined
  } catch { /* 无当前会话时让 host 自行解析目录 */ }
  const sessionId = await sessions.create(cwd ? { cwd } : {})
  sessions.open(sessionId)
  const text = [
    '（本条消息来自学习中心「与 AI 讨论本课」。请先读课程上下文，再回应学习者的请求；'
    + '涉及数据修改时遵守 learnhub 技能 SOP：题库/图/状态走 learnhub_* 工具，正文修订后跑 learnhub_content_check。）',
    pack,
    `[学习者的请求] ${intent}`,
  ].filter(Boolean).join('\n\n---\n\n')
  const binding = sessions.binding(sessionId)
  await binding?.session.prompt([{ type: 'text', text }], 'queue')
  window.focus()
}

const css = `
.dsh-lh_section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 0;
}
.dsh-lh_btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-normal, #d4d4d4);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.dsh-lh_btn:hover { background: var(--background-modifier-hover, rgba(255,255,255,.07)); }
.dsh-lh_icon { font-size: 15px; line-height: 1; }
`

export const inject = ['slots', 'sessions']

export function apply(ctx: any) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-dsh-plugin', 'dsh-learnhub')
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-learnhub: styles')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-learnhub',
    order: 30,
  }, LearnhubSection), 'dsh-learnhub: sidebar entry')

  // 学习中心 tab → 宿主桥：独立 tab 经 window.opener.postMessage 发讨论请求 →
  // 新开 dsh 会话注入首条消息。必须常驻监听——旧面板形态下请求只可能来自
  // 开着的 iframe，新形态下学习中心 tab 随时会发。
  ctx.effect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; course?: unknown; node?: unknown; intent?: unknown } | null
      if (!data || typeof data !== 'object' || data.type !== 'learnhub:discuss') return
      const course = typeof data.course === 'string' ? data.course : ''
      const node = typeof data.node === 'string' ? data.node : ''
      const intent = typeof data.intent === 'string' && data.intent.trim() ? data.intent.trim() : '请带我过一遍本节内容，指出我可能卡住的地方。'
      if (!node) return
      void discussInDsh(ctx.sessions, course, node, intent)
        .catch(err => console.error('[dsh-learnhub] discuss failed:', err))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, 'dsh-learnhub: discuss bridge')
}
