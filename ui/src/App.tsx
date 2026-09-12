import { Button, Empty, Result, Spin, Tabs } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { setActiveTab } from './active-tab'
import { errorMessage } from './hooks/useCommand'
import { navigate, onRouteChange, parseHash, readHash, syncHash, TAB_KEYS } from './lib/router'
import type { TabKey } from './lib/router'
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

/** 打开中的节点学习视图（学习页二级视图）；focusNode = 图页定位高亮目标。 */
export interface LessonRef { course: string; node: string }

/** 全局共享态：状态总览 + 课程树 + 当前课程 + 页签/学习视图跳转。 */
export interface AppFrame {
  status: StatusWithLlm | null
  tree: TreeDoc | null
  course: string | null
  lesson: LessonRef | null
  focusNode: string | null
  /** 生成页定位目标（任务注册表 key）：教练台在途任务条点击后的落点（#155）。 */
  focusJob: string | null
  setCourse: (c: string) => void
  goto: (tab: TabKey) => void
  openLesson: (course: string, node: string) => void
  closeLesson: () => void
  /** 跳到图页并高亮定位某节点。 */
  locateInGraph: (node: string) => void
  /** 跳到生成页并定位某任务（教练台在途任务条点击）。 */
  locateJob: (jobKey: string) => void
  reload: () => Promise<void>
  loading: boolean
}

export default function App() {
  // 路由状态（#189 / ADR-0052）：location.hash 是导航权威，渲染态是它的投影——
  // 初始从 hash 解析（刷新/深链直达），跳转经 go() 同步写两侧，hashchange 回灌外部导航
  //（前进/后退/手改 hash）。
  const [tab, setTab] = useState<TabKey>(() => parseHash(readHash()))
  const [status, setStatus] = useState<StatusWithLlm | null>(null)
  const [tree, setTree] = useState<TreeDoc | null>(null)
  const [course, setCourse] = useState<string | null>(null)
  const [lesson, setLesson] = useState<LessonRef | null>(null)
  const [focusNode, setFocusNode] = useState<string | null>(null)
  const [focusJob, setFocusJob] = useState<string | null>(null)
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
      setFatal(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  /** 一切页签跳转的唯一写点：渲染态立即翻转（保持既有同步语义——openLesson 等同批
   * 多重更新一次成形）+ 写 URL 权威；hashchange 回灌对同值 setTab 是无操作。 */
  const go = useCallback((t: TabKey) => { setTab(t); navigate(t) }, [])

  // 教练通知（ADR-0038）：图域任务生命周期 + 复诊结算的 App 级轻轮询弹条（10s/60s）；
  // 完成通知按钮按任务性质分流（提案产物→提案页，过程→生成页）。早退分支之前调用（hooks 顺序恒定）。
  useCoachToasts({ generate: () => go('generate'), proposals: () => go('proposals') })

  // 外部导航（前进/后退/手改 hash）→ 路由事件回灌渲染态；同步把漂移的 hash 规范化
  //（回落默认页签时 URL 不留非法形——setTab 同值被 React 跳过也不影响规范化）
  useEffect(() => onRouteChange(t => { setTab(t); syncHash(t) }), [])
  // 渲染态 → URL 规范化：初始空 hash、手改非法 hash 收敛规范形（replaceState 无历史条目）
  useEffect(() => { syncHash(tab) }, [tab])
  // 页签保活（ADR-0027）：路由变化桥接给各页轮询——隐藏页签据此跳过取数（桥接取舍见 active-tab.ts）
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
    status, tree, course, lesson, focusNode, focusJob,
    setCourse: c => setCourse(c),
    goto: go,
    openLesson: (lcourse, lnode) => { setLesson({ course: lcourse, node: lnode }); go('learn') },
    closeLesson: () => setLesson(null),
    locateInGraph: node => { setFocusNode(node); go('graph') },
    locateJob: key => { setFocusJob(key); go('generate') },
    reload,
    loading,
  }
  const noCourse = !tree || tree.courses.length === 0

  return (
    <div className='app-shell'>
      <div style={{ display: 'flex', alignItems: 'flex-start', borderBottom: '1px solid var(--color-border-2,#e5e6eb)' }}>
        <Tabs activeTab={tab} onChange={k => go(k as TabKey)} type='capsule' size='small'
          style={{ flex: 1, padding: '8px 12px 0' }}>
          <Tabs.TabPane key='learn' title='学习' />
          <Tabs.TabPane key='graph' title='学习图' />
          <Tabs.TabPane key='bank' title='题目管理' />
          <Tabs.TabPane key='stats' title='统计' />
          <Tabs.TabPane key='lab' title='实验室' />
          <Tabs.TabPane key='generate' title='生成' />
          <Tabs.TabPane key='proposals' title='提案' />
          <Tabs.TabPane key='practice' title='无界实践区' />
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
            <Empty description='还没有课程：到「学习图」页教练台新建课程——种子起草后在「提案」页人审开工，等待时可在「生成」页看进度' />
            <Button type='primary' onClick={() => go('graph')}>去学习图页建课</Button>
          </div>
        ) : (
          <TabBody tab={tab} frame={frame} />
        )}
      </div>
    </div>
  )
}

/** 页签保活（ADR-0027）：首访后常驻、非激活隐藏——练习会话等页内状态跨页签存续；
 * 隐藏页签的后台轮询由 active-tab 信号自行跳过。键表住 lib/router（TAB_KEYS，
 * 与 TabPane 键/路由解析三表对账由 tests/ui-router.test.ts 执法）。 */

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
          {k === 'proposals' && <ProposalsPage frame={frame} />}
          {k === 'practice' && <PracticePage />}
          {k === 'projects' && <ProjectsPage />}
          {k === 'guide' && <GuidePage />}
        </div>
      ))}
    </>
  )}
