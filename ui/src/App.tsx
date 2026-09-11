import { Button, Empty, Message, Result, Spin, Tabs } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { setActiveTab } from './active-tab'
import BankPage from './pages/BankPage'
import GeneratePage from './pages/GeneratePage'
import GraphPage from './pages/GraphPage'
import GuidePage from './pages/GuidePage'
import LabPage from './pages/LabPage'
import LearnPage from './pages/LearnPage'
import PracticePage from './pages/PracticePage'
import ProjectsPage from './pages/ProjectsPage'
import ProposalsPage from './pages/ProposalsPage'
import StatsPage from './pages/StatsPage'
import type { StatusWithLlm, TreeDoc } from './types'
import { useCoachToasts } from './useCoachToasts'

export type TabKey = 'learn' | 'graph' | 'bank' | 'stats' | 'generate' | 'proposals' | 'practice' | 'projects' | 'lab' | 'guide'

/** 打开中的节点学习视图（学习页二级视图）；focusNode = 图页定位高亮目标。 */
export interface LessonRef { course: string; node: string }

/** 全局共享态：状态总览 + 课程树 + 当前课程 + 页签/学习视图跳转。 */
export interface AppFrame {
  status: StatusWithLlm | null
  tree: TreeDoc | null
  course: string | null
  lesson: LessonRef | null
  focusNode: string | null
  setCourse: (c: string) => void
  goto: (tab: TabKey) => void
  openLesson: (course: string, node: string) => void
  closeLesson: () => void
  /** 跳到图页并高亮定位某节点。 */
  locateInGraph: (node: string) => void
  reload: () => Promise<void>
  loading: boolean
}

export default function App() {
  const [tab, setTab] = useState<TabKey>('learn')
  const [status, setStatus] = useState<StatusWithLlm | null>(null)
  const [tree, setTree] = useState<TreeDoc | null>(null)
  const [course, setCourse] = useState<string | null>(null)
  const [lesson, setLesson] = useState<LessonRef | null>(null)
  const [focusNode, setFocusNode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.status(), api.coursesTree()])
      setStatus(s)
      setTree(t)
      // 当前课程被删/停用时回落到第一门启用课程
      setCourse(prev => {
        const names = t.courses.map(c => c.name)
        if (prev && names.includes(prev)) return prev
        return names[0] ?? null
      })
      setFatal(null)
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // 教练通知（ADR-0038）：图域任务生命周期 + 复诊结算的 App 级轻轮询弹条（10s/60s）；
  // 完成通知按钮按任务性质分流（提案产物→提案页，过程→生成页）。早退分支之前调用（hooks 顺序恒定）。
  useCoachToasts({ generate: () => setTab('generate'), proposals: () => setTab('proposals') })

  // 页签保活（ADR-0027）：把当前页签广播给各页轮询——隐藏页签据此跳过取数
  useEffect(() => { setActiveTab(tab) }, [tab])

  // 夜间模式：arco-theme 切换（跟随系统默认，手动选择存 localStorage）
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('learnhub-theme')
    if (saved === 'dark' || saved === 'light') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.body.setAttribute('arco-theme', theme)
    localStorage.setItem('learnhub-theme', theme)
  }, [theme])

  if (loading && !status) {
    return <div className='app-shell'><div style={{ margin: 'auto' }}><Spin dot /></div></div>
  }
  if (fatal && !status) {
    return (
      <div className='app-shell' style={{ justifyContent: 'center' }}>
        <Result status='error' title='面板加载失败' subTitle={fatal}
          extra={<Button type='primary' onClick={() => { setLoading(true); void reload() }}>重试</Button>} />
      </div>
    )
  }

  const frame: AppFrame = {
    status, tree, course, lesson, focusNode,
    setCourse: c => setCourse(c),
    goto: t => setTab(t),
    openLesson: (lcourse, lnode) => { setLesson({ course: lcourse, node: lnode }); setTab('learn') },
    closeLesson: () => setLesson(null),
    locateInGraph: node => { setFocusNode(node); setTab('graph') },
    reload,
    loading,
  }
  const noCourse = !tree || tree.courses.length === 0

  return (
    <div className='app-shell'>
      <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--color-border-2,#e5e6eb)' }}>
        <Tabs activeTab={tab} onChange={k => setTab(k as TabKey)} type='capsule' size='small'
          style={{ flex: 1, padding: '8px 12px 0' }}>
          <Tabs.TabPane key='learn' title='学习' />
          <Tabs.TabPane key='graph' title='学习图' />
          <Tabs.TabPane key='bank' title='题目管理' />
          <Tabs.TabPane key='stats' title='统计' />
          <Tabs.TabPane key='lab' title='实验室' />
          <Tabs.TabPane key='generate' title='生成' />
          <Tabs.TabPane key='proposals' title='提案' />
          <Tabs.TabPane key='practice' title='实践' />
          <Tabs.TabPane key='projects' title='项目' />
          <Tabs.TabPane key='guide' title='指南' />
        </Tabs>
        <Button size='mini' type='text' style={{ margin: '10px 12px 0 0', flexShrink: 0 }}
          onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? '切到亮色' : '切到暗色'}>
          {theme === 'dark' ? '☀ 亮色' : '☾ 暗色'}
        </Button>
      </div>
      <div className={`app-body${tab === 'graph' ? ' no-pad' : ''}`}>
        {/* 空课程守卫只拦「纯消费」页签：提案/生成是建课回路的一半（种子起草 → 生成页看进度
         * → 提案页人审 → 才有课程），学习图/实践/项目自带空态入口，一律放行——否则死锁：
         * 建课要靠提案页人审，提案页却被「没有课程」拦住。 */}
        {tab !== 'learn' && tab !== 'practice' && tab !== 'projects' && tab !== 'graph'
          && tab !== 'proposals' && tab !== 'generate' && noCourse ? (
          <div style={{ paddingTop: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <Empty description='还没有课程：到「学习图」页新建课程——种子起草后在「提案」页人审开工，等待时可在「生成」页看进度' />
            <Button type='primary' onClick={() => setTab('graph')}>去学习图页建课</Button>
          </div>
        ) : (
          <TabBody tab={tab} frame={frame} />
        )}
      </div>
    </div>
  )
}

/** 页签保活（ADR-0027）：首访后常驻、非激活隐藏——练习会话等页内状态跨页签存续；
 * 隐藏页签的后台轮询由 active-tab 信号自行跳过。 */
const TAB_KEYS: TabKey[] = ['learn', 'graph', 'bank', 'stats', 'lab', 'generate', 'proposals', 'practice', 'guide']

function TabBody({ tab, frame }: { tab: TabKey; frame: AppFrame }) {
  const [visited, setVisited] = useState<Set<TabKey>>(() => new Set([tab]))
  useEffect(() => {
    setVisited(v => (v.has(tab) ? v : new Set(v).add(tab)))
  }, [tab])
  return (
    <>
      {TAB_KEYS.filter(k => visited.has(k)).map(k => (
        <div key={k} style={{ display: k === tab ? undefined : 'none' }}>
          {k === 'learn' && <LearnPage frame={frame} />}
          {k === 'graph' && <GraphPage frame={frame} />}
          {k === 'bank' && <BankPage frame={frame} />}
          {k === 'stats' && <StatsPage frame={frame} />}
          {k === 'lab' && <LabPage frame={frame} />}
          {k === 'generate' && <GeneratePage frame={frame} />}
          {k === 'proposals' && <ProposalsPage />}
          {k === 'practice' && <PracticePage />}
          {k === 'projects' && <ProjectsPage />}
          {k === 'guide' && <GuidePage />}
        </div>
      ))}
    </>
  )}

export function toastError(err: unknown) {
  Message.error(err instanceof Error ? err.message : String(err))
}
