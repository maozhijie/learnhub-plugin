import { Button, Empty, Message, Result, Spin, Tabs } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import BankPage from './pages/BankPage'
import GeneratePage from './pages/GeneratePage'
import GraphPage from './pages/GraphPage'
import LearnPage from './pages/LearnPage'
import PracticePage from './pages/PracticePage'
import ProjectsPage from './pages/ProjectsPage'
import ProposalsPage from './pages/ProposalsPage'
import StatsPage from './pages/StatsPage'
import type { StatusDoc, TreeDoc } from './types'

export type TabKey = 'learn' | 'graph' | 'bank' | 'stats' | 'generate' | 'proposals' | 'practice' | 'projects'

/** 打开中的节点学习视图（学习页二级视图）；focusNode = 图页定位高亮目标。 */
export interface LessonRef { course: string; node: string }

/** 全局共享态：状态总览 + 课程树 + 当前课程 + 页签/学习视图跳转。 */
export interface AppFrame {
  status: StatusDoc | null
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
  const [status, setStatus] = useState<StatusDoc | null>(null)
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
          <Tabs.TabPane key='generate' title='生成' />
          <Tabs.TabPane key='proposals' title='提案' />
          <Tabs.TabPane key='practice' title='实践' />
          <Tabs.TabPane key='projects' title='项目' />
        </Tabs>
        <Button size='mini' type='text' style={{ margin: '10px 12px 0 0', flexShrink: 0 }}
          onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? '切到亮色' : '切到暗色'}>
          {theme === 'dark' ? '☀ 亮色' : '☾ 暗色'}
        </Button>
      </div>
      <div className={`app-body${tab === 'graph' ? ' no-pad' : ''}`}>
        {tab !== 'learn' && tab !== 'practice' && tab !== 'projects' && noCourse ? (
          <div style={{ paddingTop: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <Empty description='还没有课程：先在 dsh 里让 agent 按 learnhub-graph-generate 技能多轮生成课程图' />
            <Button type='primary' onClick={() => setTab('learn')}>回到学习页</Button>
          </div>
        ) : (
          <TabBody tab={tab} frame={frame} />
        )}
      </div>
    </div>
  )
}

function TabBody({ tab, frame }: { tab: TabKey; frame: AppFrame }) {
  switch (tab) {
    case 'learn': return <LearnPage frame={frame} />
    case 'graph': return <GraphPage frame={frame} />
    case 'bank': return <BankPage frame={frame} />
    case 'stats': return <StatsPage frame={frame} />
    case 'generate': return <GeneratePage frame={frame} />
    case 'proposals': return <ProposalsPage />
    case 'practice': return <PracticePage />
    case 'projects': return <ProjectsPage />
    default: return null
  }
}

export function toastError(err: unknown) {
  Message.error(err instanceof Error ? err.message : String(err))
}
