/** 提案页：agent 图构建的 edit/enrich 提案（gen/seed 已退役，存量留痕仍可读），人审后
 * 应用或拒绝（全留痕）。列表常驻新鲜（8s 轮询 + 手动刷新）——起草完成后提案才出现，
 * 人审队列不能是死数据。
 * #156 应用闭环：应用成功触发全局课程树刷新（frame.reload——不刷新浏览器即可见，
 * 跨页流经 learnhub:reload 补拉），并给「查看结果」按钮按提案类型分流（编辑→图页、
 * 富化→题库、反编译/项目→项目页）；不强制跳页、可连续处理。 */
import { Alert, Button, Card, Empty, Message, Modal, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useState } from 'react'
import { api } from '../api'
import { usePolling } from '../hooks/usePolling'
import type { AppFrame } from '../App'
import type { ViewKey } from '../lib/router'
import type { PropItem } from '../types'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

/** 提案 kind → 人读标签（gen/seed 仅存量留痕展示）。 */
const KIND_LABELS: Record<string, { label: string; color: string }> = {
  gen: { label: '建课（退役）', color: 'gray' },
  seed: { label: '种子（退役）', color: 'gray' },
  edit: { label: '编辑', color: 'orange' },
  enrich: { label: '富化', color: 'cyan' },
  project_plan: { label: '项目计划', color: 'purple' },
  project_milestone: { label: '里程碑', color: 'purple' },
  experiment: { label: '实验开跑', color: 'green' },
}
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? { label: kind, color: 'orange' }

/** 「查看结果」按提案类型分流（#156；落点接 #209 新结构）：编辑批→工作台图、
 * 富化→工作台题库分栏、项目域（计划/里程碑）→项目页、实验→洞察。
 * 返回视图键 + 需要预置的课程名。 */
function resultTarget(p: PropItem): { tab: ViewKey | 'wb.graph' | 'wb.bank'; course?: string } {
  if (p.kind === 'enrich') return { tab: 'wb.bank', course: p.course }
  if (p.kind === 'project_plan' || p.kind === 'project_milestone') return { tab: 'projects' }
  if (p.kind === 'experiment') return { tab: 'insight' }
  return { tab: 'wb.graph', course: p.course }
}

export default function ProposalsPage({ frame, course }: { frame?: AppFrame; course?: string }) {
  const [items, setItems] = useState<PropItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** 本次会话内最近应用的提案（「查看结果」按钮挂它身上；不强制跳页）。 */
  const [applied, setApplied] = useState<PropItem | null>(null)
  // 切片形态（#209）：单课工作台的提案分栏——同一收件箱按课过滤，人审动作同一处
  const sliced = course !== undefined

  const load = useCallback(async () => {
    try {
      const all = await api.proposals()
      setItems(sliced ? all.filter(p => p.course === course) : all)
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }, [sliced, course])

  // 挂载即取 + 8s 轮询（页签保活：非激活跳过取数、切回即补）——起草任务完成、
  // 教练回合产批后提案自动浮现；切片挂在工作台视图下，轮询门认 'courses.course'
  usePolling(load, { tab: sliced ? 'courses.course' : 'courses.proposals', intervalMs: 8000 })

  /** 应用成功后的全局刷新（#156）：App 的状态面 + 课程树重拉（学习页课程卡、图页
   * 课程切换器即时可见新课程）；已挂载页的页内流（推荐/统计）经 learnhub:reload 补拉。 */
  const refreshAll = async () => {
    await Promise.all([load(), frame?.reload() ?? Promise.resolve()])
    window.dispatchEvent(new Event('learnhub:reload'))
  }

  const apply = async (p: PropItem) => {
    Modal.confirm({
      title: `应用提案 #${p.id}（${kindLabel(p.kind).label}）？`,
      content: <Text type='secondary'>{p.summary}</Text>,
      className: 'lh-w-620',
      onOk: async () => {
        setBusy(true)
        try {
          await api.proposalApply(p.kind, p.id)
          Message.success(`提案 #${p.id} 已应用`)
          setApplied(p)
          await refreshAll()
        } catch (err) {
          Message.error(errorMessage(err))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  const reject = async (p: PropItem) => {
    setBusy(true)
    try {
      await api.proposalReject(p.id, '面板拒绝')
      Message.success(`提案 #${p.id} 已拒绝留痕`)
      await refreshAll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const gotoResult = (p: PropItem) => {
    const t = resultTarget(p)
    if (t.tab === 'wb.graph' || t.tab === 'wb.bank') {
      // openCourse 内部即含 setCourse，落工作台对应分栏
      frame?.openCourse(t.course ?? p.course, t.tab === 'wb.graph' ? 'graph' : 'bank')
      return
    }
    if (t.course) frame?.setCourse(t.course)
    frame?.goto(t.tab)
  }

  return (
    <Space direction='vertical' className='lh-full' size={14}>
      <Alert type='info' content='面板下发的富化/反编译/项目草案与教练回合的生长批提案都汇集在这里人审 → 应用后图结构与 Obsidian 笔记联动落盘（生长批过受理门即自动应用，不在此排队——ADR-0003）。' />
      <Card size='small' title='提案列表' className='lh-card'
        extra={<Button size='mini' onClick={() => void load()}>刷新</Button>}>
        {items === null ? null : items.length === 0 ? (
          <Empty description='没有提案：学习图页教练台可下发建课/回填/反编译，项目页可起草计划与里程碑；生长批随教练回合自动产生并直接应用' />
        ) : (
          <Table size='small' data={items} rowKey={p => p.id} pagination={{ pageSize: 15, showTotal: true }}
            columns={[
              { title: '#', dataIndex: 'id', width: 54 },
              { title: '类型', width: 96, render: (_, p) => {
                const { label, color } = kindLabel(p.kind)
                return <Tag size='small' color={color}>{label}</Tag>
              } },
              { title: '课程', dataIndex: 'course', width: 130 },
              { title: '摘要', dataIndex: 'summary', ellipsis: true },
              { title: '状态', width: 90, render: (_, p) => {
                const color = p.status === 'pending' ? 'blue' : p.status === 'applied' ? 'green' : 'gray'
                const label = p.status === 'pending' ? '待审' : p.status === 'applied' ? '已应用' : '已拒绝'
                return <Tag size='small' color={color}>{label}</Tag>
              } },
              { title: '创建', dataIndex: 'created', width: 150, render: v => new Date(v).toLocaleString() },
              { title: '操作', width: 150, render: (_, p) => p.status === 'pending' ? (
                <Space size={4}>
                  <Button size='mini' type='primary' disabled={busy} onClick={() => void apply(p)}>应用</Button>
                  <Button size='mini' type='text' status='danger' disabled={busy} onClick={() => void reject(p)}>拒绝</Button>
                </Space>
              ) : applied?.id === p.id ? (
                /* 应用闭环的落点（#156）：按类型分流，点击才跳——不强制离页、可连续处理 */
                <Button size='mini' type='outline' onClick={() => gotoResult(p)}>查看结果</Button>
              ) : null },
            ]} />
        )}
      </Card>
    </Space>
  )
}
