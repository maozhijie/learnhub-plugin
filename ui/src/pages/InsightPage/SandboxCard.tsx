/** 洞察区·沙盘卡（D-3 #112 / ADR-0025；#210 自实验室页迁入）：现有 FSRS+mastery
 * 模型蒙特卡洛推演，分布输出，措辞锁「模型推演，非承诺」（语义锁见
 * tests/ui-pages-dom.test.ts）；零写侧——推演不进门禁、不进调度。 */
import { Button, Card, InputNumber, Message, Select, Space, Table, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import type { SandboxDoc } from '../../types'

const { Text } = Typography

/** 逐周掌握曲线（纯 div 条形：浅色 = p80，实色 = p50）。 */
function CurveBars({ curve }: { curve: Array<{ week: number; p50: number; p80: number }> }) {
  return (
    <div className='lh-grid lh-gap-4'>
      {curve.map(pt => (
        <div key={pt.week} className='lh-row lh-gap-6'>
          <Text type='secondary' className='lh-t-11 lh-w-44 lh-noshrink'>第 {pt.week} 周</Text>
          <div className='lh-flex-1 lh-h-10 lh-surface-2 lh-r-5 lh-clip'>
            <div style={{ position: 'relative', width: `${Math.min(100, pt.p80 * 100)}%`, height: '100%', background: 'var(--color-primary-light-3,#bedaff)' }}>
              <div style={{ width: `${pt.p80 ? Math.min(100, (pt.p50 / pt.p80) * 100) : 0}%`, height: '100%', background: 'var(--color-primary-4,#4080ff)' }} />
            </div>
          </div>
          <Text className='lh-t-11 lh-w-96 lh-right'>
            p50 {Math.round(pt.p50 * 100)}% · p80 {Math.round(pt.p80 * 100)}%
          </Text>
        </div>
      ))}
    </div>
  )
}

export default function SandboxCard({ courseNames }: { courseNames: string[] }) {
  const [sandbox, setSandbox] = useState<SandboxDoc | null>(null)
  const [busy, setBusy] = useState(false)
  const [minutes, setMinutes] = useState(45)
  const [weeks, setWeeks] = useState(6)
  const [course, setCourse] = useState<string | undefined>(undefined)

  const runSandbox = async () => {
    setBusy(true)
    try {
      setSandbox(await api.sandboxRun(minutes, weeks, course))
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title='沙盘 · 计划推演' className='lh-card' extra={<Text type='secondary'>模型推演，非承诺</Text>}>
      <Space wrap className='lh-mb-12'>
        <Text>每日</Text>
        <InputNumber mode='button' min={5} max={600} value={minutes} onChange={v => setMinutes(Number(v) || 45)} className='lh-w-110' />
        <Text>分钟 ×</Text>
        <InputNumber mode='button' min={1} max={26} value={weeks} onChange={v => setWeeks(Number(v) || 6)} className='lh-w-110' />
        <Text>周</Text>
        <Select placeholder='全部课程' value={course} onChange={setCourse} className='lh-w-160' allowClear>
          {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
        </Select>
        <Button type='primary' loading={busy} onClick={() => void runSandbox()}>推演</Button>
      </Space>
      {sandbox ? (
        <div className='lh-grid lh-gap-10'>
          <Text type='secondary' className='lh-t-12'>
            {sandbox.runs} 次蒙特卡洛 · 范围 {sandbox.scope.courses.join('、')}（{sandbox.scope.nodes} 节点）· 输出是分布不是承诺
          </Text>
          <CurveBars curve={sandbox.curve} />
          <Table
            size='mini' pagination={false}
            data={sandbox.map}
            columns={[
              { title: '节点', dataIndex: 'node' },
              { title: '推演终点掌握度 p50', dataIndex: 'p50', render: (v: number) => `${Math.round(v * 100)}%` },
              { title: 'p80', dataIndex: 'p80', render: (v: number) => `${Math.round(v * 100)}%` },
            ]}
          />
          <div className='lh-grid lh-gap-2'>
            {sandbox.assumptions.map((a, i) => (
              <Text key={i} type='secondary' className='lh-t-11'>· {a}</Text>
            ))}
          </div>
        </div>
      ) : (
        <Text type='secondary' className='lh-t-12'>输入计划点「推演」：用与调度同一套 FSRS+掌握度模型，蒙特卡洛 200 次出掌握度地图与分位带。零写入——推演不进门禁、不进调度。</Text>
      )}
    </Card>
  )
}
