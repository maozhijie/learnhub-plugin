/** 教练台分栏（#209 / ADR-0058）：机器仪表的家——建课（名称即空图）、生长一步、
 * 罗盘重画、enc 回填、复诊、就绪深度（CoachCockpit 既有语义原样）+ 挑战点恒温器
 * （D-2，自实验室页迁入：观测面跨区，建议逐条显式确认后生效，ADR-0024）。 */
import { Card, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import CoachCockpit from '../../components/CoachCockpit'
import ThermostatCard from './ThermostatCard'
import { api } from '../../api'
import type { AppFrame } from '../../App'
import type { GenJobItem } from '../../types'

const { Text } = Typography

export default function CoachColumn({ frame, course, jobs }: {
  frame: AppFrame
  course: string
  jobs: GenJobItem[]
}) {
  /** 终点数探针（ADR-0076：零终点时生长/初画禁用——教练回合要有一个方向才能裁决）。
   * 轻探针只取图 doc 的终点清单；失败按零终点处理（按钮禁用是安全侧）。 */
  const [endpointCount, setEndpointCount] = useState<number>(0)
  useEffect(() => {
    let alive = true
    const probe = () => {
      void api.graph(course)
        .then(g => { if (alive) setEndpointCount(g.endpoints.length) })
        .catch(() => { if (alive) setEndpointCount(0) })
    }
    probe()
    const h = () => probe()
    window.addEventListener('learnhub:reload', h)
    return () => { alive = false; window.removeEventListener('learnhub:reload', h) }
  }, [course])

  const coach = frame.status?.courses.find(c => c.name === course)?.coach ?? null
  return (
    <Card size='small' title='教练台' className='lh-card'>
      <Text type='secondary' className='lh-t-12 lh-block lh-mb-8'>
        建课/生长的机器仪表：命令下发后进度在「生长与队列」分栏与全局生成队列可见。
      </Text>
      <CoachCockpit
        course={course} jobs={jobs} coach={coach} endpointCount={endpointCount}
        onOpenJob={j => frame.locateJob(j.key)} />
      <ThermostatCard />
    </Card>
  )
}
