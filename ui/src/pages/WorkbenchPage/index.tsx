/** 单课工作台（#209 / ADR-0058 T5；ADR-0052「参数段」预留位的兑现）：课程区钻入层
 * ——`#/course/<id>/<wb>` 参数段路由，罗盘+图首屏，分栏依次：教练台（建课唯一入口/
 * 生长一步/就绪深度/恒温器/回填/复诊）、生长与队列（本课切片）、提案（本课切片）、
 * 题库（本课切片）。工作台整体共享 'courses.course' 一个保活视图键，分栏切换走
 * frame.openCourse 写完整 hash——前进后退在分栏间穿梭、分栏可深链。
 * 未知/已删课程的深链回落显式空态（返回我的课程），不伪装成课程内容。 */
import { Button, Result, Space, Tabs, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { onRouteChange, parseHash, readHash } from '../../lib/router'
import { usePolling } from '../../hooks/usePolling'
import type { AppFrame } from '../../App'
import type { GenJobItem } from '../../types'
import type { WorkbenchSub } from '../../lib/router'
import GeneratePage from '../GeneratePage'
import ProposalsPage from '../ProposalsPage'
import BankColumn from './BankColumn'
import CoachColumn from './CoachColumn'
import GraphScreen from './GraphScreen'

const { Text } = Typography

/** 工作台分栏项（顺序 = 可见序；字面量表由 tests/ui-router.test.ts 三表门对账）。 */
export const WORKBENCH_ITEMS: Array<{ key: WorkbenchSub; title: string }> = [
  { key: 'graph', title: '罗盘与图' },
  { key: 'coach', title: '教练台' },
  { key: 'queue', title: '生长与队列' },
  { key: 'proposals', title: '提案' },
  { key: 'bank', title: '题库' },
]

/** 图域任务 phase 全集（与 useCoachToasts 同口径）：教练台在途条的消费面。 */
const GRAPH_PHASES = new Set(['seed', 'growth', 'compass', 'decompile', 'plan', 'milestone'])

export default function WorkbenchPage({ frame, courseId }: { frame: AppFrame; courseId: string | null }) {
  const [wb, setWb] = useState<WorkbenchSub>(() => parseHash(readHash()).wb)
  // 前进/后退/手改 hash 时的分栏回灌：只在工作台路由上采纳（别的视图不改分栏）
  useEffect(() => onRouteChange(() => {
    const r = parseHash(readHash())
    if (r.zone === 'courses' && r.courseId !== null) setWb(r.wb)
  }), [])

  // 生成任务注册表的唯一轮询拍（全部分栏共用，避免各分栏重复打 /generate/status）：
  // 图相任务喂教练台在途条；全部任务喂首屏（genStates 投影与终态边沿在 GraphScreen 内）。
  const [allJobs, setAllJobs] = useState<GenJobItem[]>([])
  usePolling(async () => {
    try {
      const st = await api.generateStatus()
      setAllJobs(st.jobs)
    } catch {
      setAllJobs([])
    }
  }, { tab: 'courses.course', intervalMs: 5000 })
  const graphJobs = allJobs.filter(j => GRAPH_PHASES.has(j.phase ?? '') && j.course === courseId)

  if (courseId === null || !(frame.tree?.courses.some(c => c.name === courseId) ?? false)) {
    return (
      <Result
        status='warning'
        title={courseId ? `课程「${courseId}」不存在或已删除` : '还没有打开任何课程'}
        subTitle='从「我的课程」进入一门课，或检查深链里的课程 id。'
        extra={<Button type='primary' onClick={() => frame.goto('courses.home')}>返回我的课程</Button>}
      />
    )
  }
  const course = courseId
  return (
    <Space direction='vertical' style={{ width: '100%' }} size={12}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Typography.Title heading={4} style={{ margin: 0 }}>{course} · 单课工作台</Typography.Title>
        <Button size='small' type='text' onClick={() => frame.goto('courses.home')}>← 我的课程</Button>
        <Text type='secondary' style={{ fontSize: 12 }}>
          首屏是罗盘与图（这门课走到哪、还剩多远）；机器仪表住在教练台分栏。
        </Text>
      </div>
      <Tabs activeTab={wb} type='capsule' size='small' onChange={k => frame.openCourse(course, k as WorkbenchSub)}>
        {WORKBENCH_ITEMS.map(item => <Tabs.TabPane key={item.key} title={item.title} />)}
      </Tabs>
      {wb === 'graph' && <GraphScreen frame={frame} course={course} jobs={allJobs} />}
      {wb === 'coach' && <CoachColumn frame={frame} course={course} jobs={graphJobs} />}
      {wb === 'queue' && <GeneratePage frame={frame} course={course} />}
      {wb === 'proposals' && <ProposalsPage frame={frame} course={course} />}
      {wb === 'bank' && <BankColumn frame={frame} course={course} />}
    </Space>
  )
}
