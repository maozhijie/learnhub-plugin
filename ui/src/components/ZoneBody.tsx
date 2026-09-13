/** 视图保活容器（页签保活 ADR-0027，#205 五区化）：首访后常驻、非激活隐藏——
 * 练习会话等页内状态跨视图存续；隐藏视图的后台轮询由 active-tab 视图键信号自行
 * 跳过。洞察区 = 统计页 + 实验室页并列同显（T6 再拆），共享 'insight' 一个视图键。
 * 分支键表（VIEW_KEYS）住 lib/router，与路由表的对账由 tests/ui-router.test.ts
 * 三表门执法（Exhibit A：#158 漏键表致修复从未生效）。 */
import { useEffect, useState } from 'react'
import { VIEW_KEYS } from '../lib/router'
import type { ViewKey } from '../lib/router'
import type { AppFrame } from '../App'
import BankPage from '../pages/BankPage'
import GeneratePage from '../pages/GeneratePage'
import GraphPage from '../pages/GraphPage'
import LabPage from '../pages/LabPage'
import LearnPage from '../pages/LearnPage'
import PracticePage from '../pages/PracticePage'
import ProjectsPage from '../pages/ProjectsPage'
import ProposalsPage from '../pages/ProposalsPage'
import StatsPage from '../pages/StatsPage'

export function ZoneBody({ view, frame }: { view: ViewKey; frame: AppFrame }) {
  const [visited, setVisited] = useState<Set<ViewKey>>(() => new Set([view]))
  useEffect(() => {
    setVisited(v => (v.has(view) ? v : new Set(v).add(view)))
  }, [view])
  return (
    <>
      {VIEW_KEYS.filter(k => visited.has(k)).map(k => (
        <div key={k} className={`zone-view${k === view ? ' zone-view-active' : ''}`}>
          {k === 'today' && <LearnPage frame={frame} />}
          {k === 'courses.graph' && <GraphPage frame={frame} />}
          {k === 'courses.queue' && <GeneratePage frame={frame} />}
          {k === 'courses.proposals' && <ProposalsPage frame={frame} />}
          {k === 'courses.bank' && <BankPage frame={frame} />}
          {k === 'insight' && (
            <>
              <StatsPage frame={frame} />
              <LabPage frame={frame} />
            </>
          )}
          {k === 'projects' && <ProjectsPage />}
          {k === 'practice' && <PracticePage />}
        </div>
      ))}
    </>
  )
}
