/** 提案页：agent 图构建的 seed/edit/enrich 提案（gen 已退役），人审后应用或拒绝（全留痕）。
 * 列表常驻新鲜（8s 轮询 + 手动刷新）——起草完成后提案才出现，人审队列不能是死数据。
 * #159：种子提案应用前先取影响预览（将新建什么、覆盖什么、什么保留），知情后再确认。 */
import { Alert, Button, Card, Empty, Message, Modal, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useState } from 'react'
import { api } from '../api'
import { usePolling } from '../hooks/usePolling'
import type { PropItem, SeedImpactDoc } from '../types'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

/** 种子提案影响预览（人话）：只说引擎真会做的事——新建节点、覆盖锚、罗盘重置、全保留项。 */
function SeedImpactPreview({ impact }: { impact: SeedImpactDoc }) {
  const reseed = impact.mode === 'reseed'
  return (
    <Alert type={reseed ? 'warning' : 'info'} style={{ marginBottom: 8 }} content={
      <Space direction='vertical' size={2}>
        {reseed && impact.current_anchor && (
          <Text>
            现终点「{impact.current_anchor.endpoint}」（提案 #{impact.current_anchor.origin_proposal} · {impact.current_anchor.declared} 声明）将被新终点覆盖。
          </Text>
        )}
        {impact.new_nodes.length > 0 && (
          <Text>将新建 {impact.new_nodes.length} 个节点：{impact.new_nodes.join('、')}。</Text>
        )}
        {impact.existing_nodes.length > 0 && (
          <Text type='warning'>
            「{impact.existing_nodes.join('、')}」与现有图重名：应用会被拒（提案已不适用当前图）——建议拒绝后重提。
          </Text>
        )}
        {impact.compass_reset && <Text>罗盘路线与预计耗时将重置为待初画（你的批注保留）。</Text>}
        {impact.graph_nodes > 0 && (
          <Text type='secondary'>
            现有图 {impact.graph_nodes} 个节点连同学习进度、题库与调度全部保留——本轮不删除、不作废任何已有内容。
          </Text>
        )}
      </Space>
    } />
  )
}

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
      Message.error(errorMessage(err))
    }
  }, [])

  // 挂载即取 + 8s 轮询（页签保活：非激活跳过取数、切回即补）——起草任务完成、
  // 教练回合产批后提案自动浮现
  usePolling(load, { tab: 'proposals', intervalMs: 8000 })

  const apply = async (p: PropItem) => {
    // 种子提案先取影响预览（#159）：知情后再确认；预览取不到不拦人审，
    // 但在确认框里明说（面板说真话——不静默退回摘要）
    let impact: SeedImpactDoc | null = null
    let impactError: string | null = null
    if (p.kind === 'seed') {
      try {
        impact = await api.proposalImpact('seed', p.id)
      } catch (err) {
        impactError = errorMessage(err)
      }
    }
    Modal.confirm({
      title: `应用提案 #${p.id}（${kindLabel(p.kind).label}）？`,
      content: (
        <Space direction='vertical' size={4} style={{ width: '100%' }}>
          {impact && <SeedImpactPreview impact={impact} />}
          {impactError && (
            <Alert type='warning' style={{ marginBottom: 8 }}
              content={`影响预览取不到：${impactError}——应用前建议先刷新提案列表确认提案仍然有效。`} />
          )}
          <Text type='secondary'>{p.summary}</Text>
        </Space>
      ),
      style: { width: 620 },
      onOk: async () => {
        setBusy(true)
        try {
          await api.proposalApply(p.kind, p.id)
          Message.success(`提案 #${p.id} 已应用`)
          await load()
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
      await load()
    } catch (err) {
      Message.error(errorMessage(err))
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
                  <Button size='mini' type='primary' disabled={busy} onClick={() => void apply(p)}>应用</Button>
                  <Button size='mini' type='text' status='danger' disabled={busy} onClick={() => void reject(p)}>拒绝</Button>
                </Space>
              ) : null },
            ]} />
        )}
      </Card>
    </Space>
  )
}
