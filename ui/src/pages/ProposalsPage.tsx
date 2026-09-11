/** 提案页：agent 图构建的 seed/edit/enrich 提案（gen 已退役），人审后应用或拒绝（全留痕）。
 * 列表常驻新鲜（8s 轮询 + 手动刷新）——起草完成后提案才出现，人审队列不能是死数据。 */
import { Alert, Button, Card, Empty, Message, Modal, Space, Table, Tag } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { isActiveTab } from '../active-tab'
import type { PropItem } from '../types'

/** 提案 kind → 人读标签（gen 仅存量留痕展示）。 */
const KIND_LABELS: Record<string, { label: string; color: string }> = {
  gen: { label: '建课（退役）', color: 'gray' },
  seed: { label: '种子', color: 'lime' },
  edit: { label: '编辑', color: 'orange' },
  enrich: { label: '富化', color: 'cyan' },
  project_plan: { label: '项目计划', color: 'purple' },
  project_milestone: { label: '里程碑', color: 'purple' },
  experiment: { label: '实验开跑', color: 'green' },
}
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? { label: kind, color: 'orange' }

export default function ProposalsPage() {
  const [items, setItems] = useState<PropItem[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems(await api.proposals())
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 8s 轮询（页签保活纪律：非激活跳过取数）——起草任务完成、教练回合产批后提案自动浮现
  useEffect(() => {
    const timer = setInterval(() => { if (isActiveTab('proposals')) void load() }, 8000)
    return () => clearInterval(timer)
  }, [load])

  const apply = (p: PropItem) => {
    Modal.confirm({
      title: `应用提案 #${p.id}（${kindLabel(p.kind).label}）？`,
      content: p.summary,
      style: { width: 620 },
      onOk: async () => {
        setBusy(true)
        try {
          await api.proposalApply(p.kind, p.id)
          Message.success(`提案 #${p.id} 已应用`)
          await load()
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
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
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <Alert type='info' content='面板下发的种子/富化/反编译/项目草案与教练回合的生长批提案都汇集在这里人审 → 应用后图结构与 Obsidian 笔记联动落盘（生长批过受理门即自动应用，不在此排队——ADR-0003）。' />
      <Card size='small' title='提案列表' style={{ borderRadius: 10 }}
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
              { title: '操作', width: 140, render: (_, p) => p.status === 'pending' ? (
                <Space size={4}>
                  <Button size='mini' type='primary' disabled={busy} onClick={() => apply(p)}>应用</Button>
                  <Button size='mini' type='text' status='danger' disabled={busy} onClick={() => void reject(p)}>拒绝</Button>
                </Space>
              ) : null },
            ]} />
        )}
      </Card>
    </Space>
  )
}
