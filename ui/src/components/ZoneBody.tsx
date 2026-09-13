/** 视图保活容器（页签保活 ADR-0027，#205 五区化；#209 三入口+参数段工作台；
 * #210 洞察区成型）：首访后常驻、非激活隐藏——练习会话等页内状态跨视图存续；
 * 隐藏视图的后台轮询由 active-tab 视图键信号自行跳过。单课工作台整体共享
 * 'courses.course' 一个视图键（保活/轮询门的单位），工作台内部分栏切换不改视图键。
 * 洞察区 = 洞察页一页（统计/周复盘/沙盘/N-of-1/睡眠/Anki 通道/运行环境；实验室页
 * 随 T6 退役）。分支键表（VIEW_KEYS）住 lib/router，与路由表的对账由
 * tests/ui-router.test.ts 三表门执法（Exhibit A：#158 漏键表致修复从未生效）。 */
import { useEffect, useState } from 'react'
import { VIEW_KEYS } from '../lib/router'
import type { ViewKey } from '../lib/router'
import type { AppFrame } from '../App'
import CoursesPage from '../pages/CoursesPage'
import GeneratePage from '../pages/GeneratePage'
import InsightPage from '../pages/InsightPage'
import PracticePage from '../pages/PracticePage'
import ProjectsPage from '../pages/ProjectsPage'
import ProposalsPage from '../pages/ProposalsPage'
import TodayPage from '../pages/TodayPage'
import WorkbenchPage from '../pages/WorkbenchPage'

export function ZoneBody({ view, courseId, frame }: { view: ViewKey; courseId: string | null; frame: AppFrame }) {
  const [visited, setVisited] = useState<Set<ViewKey>>(() => new Set([view]))
  useEffect(() => {
    setVisited(v => (v.has(view) ? v : new Set(v).add(view)))
  }, [view])
  return (
    <>
      {VIEW_KEYS.filter(k => visited.has(k)).map(k => (
        <div key={k} className={`zone-view${k === view ? ' zone-view-active' : ''}`}>
          {k === 'today' && <TodayPage frame={frame} />}
          {k === 'courses.home' && <CoursesPage frame={frame} />}
          {k === 'courses.queue' && <GeneratePage frame={frame} />}
          {k === 'courses.proposals' && <ProposalsPage frame={frame} />}
          {k === 'courses.course' && <WorkbenchPage frame={frame} courseId={courseId} />}
          {k === 'insight' && <InsightPage frame={frame} />}
          {k === 'projects' && <ProjectsPage />}
          {k === 'practice' && <PracticePage />}
        </div>
      ))}
    </>
  )
}
