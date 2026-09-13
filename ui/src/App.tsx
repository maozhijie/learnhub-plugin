import { Button, Empty, Result, Spin } from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { setActiveTab } from './active-tab'
import { errorMessage } from './hooks/useCommand'
import { HelpDrawer } from './components/HelpDrawer'
import { ShellTopBar } from './components/ShellTopBar'
import { ZoneBody } from './components/ZoneBody'
import { navigate, navigateCourse, onRouteChange, parseHash, readHash, syncHash, viewOfRoute, zoneOfView } from './lib/router'
import type { CourseSub, ViewKey, WorkbenchSub, ZoneKey } from './lib/router'
import type { StatusWithLlm, TreeDoc } from './types'
import { useCoachToasts } from './useCoachToasts'

/** 打开中的节点学习视图（学习页二级视图）；focusNode = 图页定位高亮目标。 */
export interface LessonRef { course: string; node: string }

/** 全局共享态：状态总览 + 课程树 + 当前课程 + 视图/学习视图跳转。 */
export interface AppFrame {
  status: StatusWithLlm | null
  tree: TreeDoc | null
  course: string | null
  lesson: LessonRef | null
  focusNode: string | null
  focusJob: string | null
  /** 生成视图定位目标（任务注册表 key）：教练台在途任务条点击后的落点（#155）。 */
  setCourse: (c: string) => void
  goto: (view: ViewKey) => void
  /** 进单课工作台（#209 参数段路由）：写 `#/course/<id>/<wb>` 并预置当前课程。 */
  openCourse: (course: string, wb?: WorkbenchSub) => void
  openLesson: (course: string, node: string) => void
  closeLesson: () => void
  /** 跳到单课工作台的学习图分栏并高亮定位某节点。 */
  locateInGraph: (node: string) => void
  /** 跳到生成队列（全局面）并定位某任务（教练台在途任务条点击）。 */
  locateJob: (jobKey: string) => void
  reload: () => Promise<void>
  loading: boolean
}

/** 空课程守卫只拦「纯消费」视图：提案/生成是建课回路的一半（种子起草 → 生成看
 * 进度 → 提案人审 → 才有课程），我的课程自带建课入口（教练台空课形态）、实践/
 * 项目/今日自带空态入口，一律放行——否则死锁：建课要靠提案页人审，提案页却被
 * 「没有课程」拦住。 */
const NO_COURSE_BLOCKED: ViewKey[] = ['insight']

/** 视图键 → 课程区子导航高亮：三入口各归各；工作台是钻入层，高亮「我的课程」。 */
const courseSubOfView = (v: ViewKey): CourseSub => {
  if (!v.startsWith('courses.')) return 'home'
  const rest = v.slice('courses.'.length)
  return rest === 'course' ? 'home' : rest as CourseSub
}

export default function App() {
  // 路由状态（#189 / ADR-0052；#205 / ADR-0058 两级化）：location.hash 是导航权威，
  // 渲染态是它的投影——初始从 hash 解析（刷新/深链直达），跳转经 go() 同步写两侧，
  // hashchange 回灌外部导航（前进/后退/手改 hash）。
  const [view, setView] = useState<ViewKey>(() => viewOfRoute(parseHash(readHash())))
  const [status, setStatus] = useState<StatusWithLlm | null>(null)
  const [tree, setTree] = useState<TreeDoc | null>(null)
  const [course, setCourse] = useState<string | null>(null)
  const [lesson, setLesson] = useState<LessonRef | null>(null)
  const [focusNode, setFocusNode] = useState<string | null>(null)
  const [focusJob, setFocusJob] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

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

  // 区页签点击 = 回该区最近访问的视图（课程区记住子入口，其余区即区视图）
  const lastViewByZone = useRef<Partial<Record<ZoneKey, ViewKey>>>({})
  useEffect(() => { lastViewByZone.current[zoneOfView(view)] = view }, [view])
  const go = useCallback((v: ViewKey) => { setView(v); navigate(v) }, [])
  const goZone = useCallback((z: ZoneKey) => {
    go(lastViewByZone.current[z] ?? (z === 'courses' ? 'courses.home' : z))
  }, [go])
  const goCourseSub = useCallback((s: CourseSub) => { go(`courses.${s}` as ViewKey) }, [go])
  // 单课工作台（#209）：完整参数段路由——分栏切换也写 hash（前进后退在分栏间穿梭）
  const openCourse = useCallback((c: string, wb: WorkbenchSub = 'graph') => {
    setCourse(c)
    setView('courses.course')
    navigateCourse(c, wb)
  }, [])

  // 教练通知（ADR-0038）：图域任务生命周期 + 复诊结算的 App 级轻轮询弹条（10s/60s）；
  // 完成通知按钮按任务性质分流（提案产物→提案收件箱，过程→生成队列）。早退分支之前调用（hooks 顺序恒定）。
  useCoachToasts({ generate: () => go('courses.queue'), proposals: () => go('courses.proposals') })

  // 外部导航（前进/后退/手改 hash/旧键深链）→ 路由事件回灌渲染态；同步把漂移的 hash
  // 规范化（回落默认视图时 URL 不留非法形——setView 同值被 React 跳过也不影响规范化）。
  // 工作台参数段（courseId）随 hash 回灌——深链 `#/course/<id>/<wb>` 刷新直达。
  const [courseId, setCourseId] = useState<string | null>(() => {
    const r = parseHash(readHash())
    return r.zone === 'courses' ? r.courseId : null
  })
  useEffect(() => onRouteChange(v => {
    setView(v); syncHash(v)
    const r = parseHash(readHash())
    setCourseId(r.zone === 'courses' ? r.courseId : null)
  }), [])
  // 渲染态 → URL 规范化：初始空 hash、手改非法 hash 收敛规范形（replaceState 无历史条目）
  useEffect(() => { syncHash(view) }, [view])
  // 视图保活（ADR-0027）：路由变化桥接给各页轮询——隐藏视图据此跳过取数（桥接取舍见 active-tab.ts）
  useEffect(() => { setActiveTab(view) }, [view])

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
    return <div className='app-shell'><div className='app-loading'><Spin dot /></div></div>
  }
  if (fatal && !status) {
    return (
      <div className='app-shell app-fatal'>
        <Result status='error' title='面板加载失败' subTitle={fatal}
          extra={<Button type='primary' onClick={() => { setLoading(true); void reload() }}>重试</Button>} />
      </div>
    )
  }

  const frame: AppFrame = {
    status, tree, course, lesson, focusNode, focusJob,
    setCourse: c => setCourse(c),
    goto: go,
    openCourse,
    openLesson: (lcourse, lnode) => { setLesson({ course: lcourse, node: lnode }); go('today') },
    closeLesson: () => setLesson(null),
    locateInGraph: node => {
      setFocusNode(node)
      const c = course ?? tree?.courses[0]?.name
      if (c) openCourse(c, 'graph')
    },
    locateJob: key => { setFocusJob(key); go('courses.queue') },
    reload,
    loading,
  }
  const noCourse = !tree || tree.courses.length === 0

  return (
    <div className='app-shell'>
      <ShellTopBar zone={zoneOfView(view)} courseSub={courseSubOfView(view)}
        theme={theme} onZone={goZone} onCourseSub={goCourseSub}
        onToggleTheme={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
        onOpenHelp={() => setHelpOpen(true)} />
      <HelpDrawer visible={helpOpen} onClose={() => setHelpOpen(false)} />
      <div className={`app-body${view === 'courses.course' ? ' no-pad' : ''}`}>
        {NO_COURSE_BLOCKED.includes(view) && noCourse ? (
          <div className='app-empty-hint'>
            <Empty description='还没有课程：到「课程」区「我的课程」的教练台新建课程——种子起草后在「提案收件箱」人审开工，等待时可在「生成队列」看进度' />
            <Button type='primary' onClick={() => go('courses.home')}>去课程区建课</Button>
          </div>
        ) : (
          <ZoneBody view={view} courseId={courseId} frame={frame} />
        )}
      </div>
    </div>
  )
}
