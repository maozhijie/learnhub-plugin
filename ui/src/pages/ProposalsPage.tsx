/** 提案页：agent 图构建的 gen/edit 提案，人审后应用或拒绝（全留痕）。 */
import { Alert, Button, Card, Empty, Message, Modal, Space, Table, Tag } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { PropItem } from '../types'

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

  const apply = (p: PropItem) => {
    Modal.confirm({
      title: `应用提案 #${p.id}（${p.kind === 'gen' ? '建课' : '编辑'}）？`,
      content: p.summary,
      style: { width: 620 },
      onOk: async () => {
        setBusy(true)
        try {
          await api.proposalApply(p.kind, p.id)
          Message.success(`提案 #${p.id} 已应用（rename/del/题库随迁联动完成）`)
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
      <Alert type='info' content='agent 在 dsh 对话里构建课程图（多轮 gen/edit 提案）→ 这里人审 → 应用后图结构与 Obsidian 笔记联动落盘。' />
      <Card size='small' title='提案列表' style={{ borderRadius: 10 }}>
        {items === null ? null : items.length === 0 ? (
          <Empty description='没有提案：在 dsh 对话里让 agent 生成课程（learnhub-graph-generate 技能）' />
        ) : (
          <Table size='small' data={items} rowKey={p => p.id} pagination={{ pageSize: 15, showTotal: true }}
            columns={[
              { title: '#', dataIndex: 'id', width: 54 },
              { title: '类型', width: 70, render: (_, p) => (
                <Tag size='small' color={p.kind === 'gen' ? 'arcoblue' : 'orange'}>{p.kind === 'gen' ? '建课' : '编辑'}</Tag>
              ) },
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
