/** 项目页（P 区·有界项目区）：项目清单 + 2×2 Mastery 交叉诊断（P-7 / ADR-0015 §4/§8）。
 *
 * 2×2 是项目面板核心视图：X = 关联节点 masteryOfFm 均值（陈述性掌握），Y = 执行事件分
 * EMA（项目执行证据），阈值 0.6 两轴同口径；证据缺失按该轴低侧处理。四象限只读可读。
 * 入档推荐（challenge point）只读展示——引擎提议、学习者显式改档；推荐永不参与任何
 * 门禁。执行事件记录：评级/来源/行使节点/一句话备注；auto 来源（可观测证据确定性
 * 映射）走 agent 工具 learnhub_project_exec_log。执行事件零 XP、零调度写入。
 */
import { Alert, Button, Card, Empty, Input, Message, Select, Space, Table, Tag, Tooltip } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { FadingTier, ProjectCrossDoc, ProjectFm } from '../types'
import AgentHints from '../components/AgentHints'

const LIFECYCLE_LABEL: Record<string, string> = {
  active: '进行中', paused: '暂停', delivered: '已交付', archived: '已归档',
}
const RATING_LABEL: Record<number, string> = { 4: '很强', 3: '顺利', 2: '吃力', 1: '受挫' }
const SOURCE_LABEL: Record<string, string> = { auto: '自动证据', self: '自评', ai: 'AI 评' }
const ACTION_LABEL: Record<string, { text: string; color: string }> = {
  promote: { text: '建议升档', color: 'green' },
  demote: { text: '建议降档', color: 'orange' },
  hold: { text: '维持现状', color: 'gray' },
}
const TIER_OPTIONS: FadingTier[] = ['骨架', '补全', '独立']

/** 2×2 四格（网格顺序：上行 Y=高，下行 Y=低；左列 X=低，右列 X=高）。 */
const QUADRANT_CELLS: Array<{ key: string; x: '低' | '高'; y: '高' | '低'; color: string }> = [
  { key: 'applied_shaky', x: '低', y: '高', color: 'orange' },
  { key: 'healthy', x: '高', y: '高', color: 'green' },
  { key: 'foundation', x: '低', y: '低', color: 'red' },
  { key: 'knowledge_idle', x: '高', y: '低', color: 'purple' },
]

/** 两轴读数（null = 无证据，按低侧落位）。 */
function AxisValue({ label, value, caliber }: { label: string; value: number | null; caliber: string }) {
  return (
    <Tooltip content={caliber}>
      <span style={{ color: 'var(--color-text-2)' }}>
        {label}：<b>{value === null ? '无证据' : Math.round(value * 100) + '%'}</b>
      </span>
    </Tooltip>
  )
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectFm[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [cross, setCross] = useState<ProjectCrossDoc | null>(null)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<'self' | 'ai'>('self')
  const [rating, setRating] = useState(3)
  const [nodesText, setNodesText] = useState('')
  const [note, setNote] = useState('')

  const loadList = useCallback(async () => {
    try {
      const list = await api.projects()
      setProjects(list)
      setSelected(prev => (prev && list.some(p => p.id === prev) ? prev : list[0]?.id ?? null))
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadCross = useCallback(async (id: string) => {
    try {
      setCross(await api.projectCross(id))
    } catch (err) {
      setCross(null)
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { if (selected) void loadCross(selected) }, [selected, loadCross])

  const submitExec = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const nodes = nodesText.split(/[,，]/).map(s => s.trim()).filter(Boolean)
      const r = await api.projectExec(selected, {
        source, rating,
        ...(nodes.length ? { nodes } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      const flowed = r.backflow.length
        ? `，证据回流 ${r.backflow.map(b => b.node).join('、')}`
        : '，无被行使 enc 边（只落项目流）'
      Message.success(`执行事件已记录（评级 ${r.rating}·${r.score}）${flowed}`)
      setNote('')
      setNodesText('')
      await loadCross(selected)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const adoptTier = async (tier: FadingTier) => {
    if (!selected) return
    setBusy(true)
    try {
      await api.projectSetTier(selected, tier)
      Message.success(`渐退档已改为「${tier}」（你的显式动作——引擎推荐只是提议）`)
      await loadCross(selected)
      await loadList()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <Alert type='info' content='项目区（Course 的姊妹实体，以周/月计的真实实践）：这里看每个项目的 2×2 掌握交叉诊断——左边陈述性掌握（关联节点），下边项目执行证据。执行事件零 XP、零调度写入；入档推荐只是提议，改档是你的显式动作，推荐永不参与任何门禁。' />
      <AgentHints page='projects' />

      <Card size='small' title='项目' style={{ borderRadius: 10 }}>
        {projects === null ? null : projects.length === 0 ? (
          <Empty description='还没有项目：在 agent 对话里 learnhub_project_create（真实在做的实践，如「三个月弹会小曲」）' />
        ) : (
          <Table
            size='small'
            data={projects}
            rowKey={p => p.id}
            pagination={false}
            rowSelection={{
              type: 'radio',
              selectedRowKeys: selected ? [selected] : [],
              onChange: (keys: unknown[]) => setSelected(String(keys[0])),
            }}
            columns={[
              { title: '项目', dataIndex: 'name', width: 180 },
              { title: '生命周期', width: 100, render: (_, p) => <Tag size='small'>{LIFECYCLE_LABEL[p.lifecycle] ?? p.lifecycle}</Tag> },
              { title: '渐退档', dataIndex: 'tier', width: 90, render: v => <Tag size='small' color='arcoblue'>{v}</Tag> },
              { title: '里程碑', width: 80, render: (_, p) => `${p.plan.length} 个` },
              { title: '目标', render: (_, p) => <span style={{ color: 'var(--color-text-3)' }}>{p.goal}</span> },
            ]}
          />
        )}
      </Card>

      {selected && cross && (
        <>
          <Card
            size='small'
            title={`2×2 诊断：${cross.name}`}
            extra={
              <Space size={16}>
                <AxisValue label='X 陈述性掌握' value={cross.x.value} caliber={cross.x.caliber} />
                <AxisValue label='Y 项目执行证据' value={cross.y.value} caliber={cross.y.caliber} />
                <span style={{ color: 'var(--color-text-3)' }}>高低分界 {Math.round(cross.thresholds.axis * 100)}%</span>
              </Space>
            }
            style={{ borderRadius: 10 }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {QUADRANT_CELLS.map(cell => {
                const active = cross.quadrant.key === cell.key
                const label = active ? cross.quadrant.label : cell.key === 'applied_shaky' ? '会用而不牢'
                  : cell.key === 'healthy' ? '健康' : cell.key === 'foundation' ? '补底' : '会而不会用'
                const hint = active ? cross.quadrant.hint : ''
                return (
                  <div key={cell.key} style={{
                    border: `1px solid ${active ? 'rgb(var(--arcoblue-6))' : 'var(--color-border-2,#e5e6eb)'}`,
                    borderRadius: 8, padding: '10px 12px', minHeight: 92,
                    background: active ? 'var(--color-primary-light-1, rgba(var(--arcoblue-1), 0.5))' : 'transparent',
                  }}>
                    <Space size={8}>
                      <Tag size='small' color={cell.color}>{label}</Tag>
                      <span style={{ color: 'var(--color-text-3)', fontSize: 12 }}>掌握{cell.x} × 执行{cell.y}</span>
                      {active && <Tag size='small' color='arcoblue'>当前落位</Tag>}
                    </Space>
                    <div style={{ marginTop: 6, color: 'var(--color-text-2)', fontSize: 13, lineHeight: 1.5 }}>
                      {hint || '——'}
                    </div>
                  </div>
                )
              })}
            </div>
            {cross.linked_nodes.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {cross.linked_nodes.map(n => (
                  <Tag key={`${n.course}/${n.node}`} size='small' color='gray'>
                    {n.node}（{Math.round(n.mastery * 100)}%）
                  </Tag>
                ))}
              </div>
            )}
          </Card>

          <Card size='small' title='入档推荐（challenge point，只读）' style={{ borderRadius: 10 }}>
            <Space size={10} wrap>
              <Tag size='small' color={ACTION_LABEL[cross.recommendation.action]?.color}>
                {ACTION_LABEL[cross.recommendation.action]?.text}
              </Tag>
              <span>
                当前档「{cross.recommendation.current}」
                {cross.recommendation.recommended !== cross.recommendation.current &&
                  <> → 建议「{cross.recommendation.recommended}」</>}
              </span>
              {cross.recommendation.recommended !== cross.recommendation.current && (
                <Button size='mini' type='primary' disabled={busy}
                  onClick={() => adoptTier(cross.recommendation.recommended)}>
                  改成「{cross.recommendation.recommended}」
                </Button>
              )}
              <Select size='mini' style={{ width: 120 }} value={cross.tier} disabled={busy}
                onChange={v => adoptTier(v as FadingTier)}
                options={TIER_OPTIONS.map(t => ({ label: `改为 ${t}`, value: t }))} />
            </Space>
            <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: 'var(--color-text-2)', fontSize: 13, lineHeight: 1.7 }}>
              {cross.recommendation.reasons.map((r, i) => <li key={i}>{r}</li>)}
              <li style={{ color: 'var(--color-text-3)' }}>
                判据：档内 ≥{cross.thresholds.promote_min_events} 次均分 ≥{Math.round(cross.thresholds.promote_score * 100)}%
                升 / &lt;{Math.round(cross.thresholds.demote_score * 100)}% 降，且知识底座 ≥{Math.round(cross.thresholds.axis * 100)}%
                ——引擎只提议，永不做门禁
              </li>
            </ul>
          </Card>

          <Card size='small' title='记一次执行事件' style={{ borderRadius: 10 }}>
            <Space size={8} wrap>
              <Select size='small' style={{ width: 110 }} value={source} onChange={v => setSource(v as 'self' | 'ai')}
                options={[{ label: '自评（self）', value: 'self' }, { label: 'AI 评（ai）', value: 'ai' }]} />
              <Select size='small' style={{ width: 130 }} value={rating} onChange={v => setRating(Number(v))}
                options={[4, 3, 2, 1].map(r => ({ label: `${r}（${RATING_LABEL[r]}）`, value: r }))} />
              <Input size='small' style={{ width: 240 }} placeholder='行使的关联节点，逗号分隔（可空）'
                value={nodesText} onChange={v => setNodesText(v)} />
              <Input size='small' style={{ width: 200 }} placeholder='一句话备注（可空）'
                value={note} onChange={v => setNote(v)} />
              <Button size='small' type='primary' disabled={busy} onClick={submitExec}>落流</Button>
            </Space>
            <div style={{ marginTop: 6, color: 'var(--color-text-3)', fontSize: 12 }}>
              nodes 里给出关联节点时，两端都在其中的既有 enc 边算被行使——练习证据单向回流到边两端节点（零 XP、零调度写入）；
              自动证据来源（source=auto）需要可观测判据，走 agent 工具 learnhub_project_exec_log。
            </div>
          </Card>

          <Card size='small' title={`执行事件（${cross.exec.count} 条）`} style={{ borderRadius: 10 }}>
            {cross.events.length === 0 ? (
              <Empty description='还没有执行事件：做完一次真活儿就记一条（评级 1-4 + 来源）' />
            ) : (
              <Table
                size='small'
                data={cross.events.map((e, i) => ({ ...e, _key: `${e.ts}-${i}` }))}
                rowKey={e => (e as typeof cross.events[number] & { _key: string })._key}
                pagination={false}
                columns={[
                  { title: '学习日', dataIndex: 'day', width: 110 },
                  { title: '档位', dataIndex: 'tier', width: 80 },
                  { title: '评级', width: 100, render: (_, e) => <Tag size='small' color={e.rating >= 3 ? 'green' : 'orange'}>{e.rating}（{RATING_LABEL[e.rating]}）</Tag> },
                  { title: '来源', width: 90, render: (_, e) => SOURCE_LABEL[e.source] ?? e.source },
                  { title: '行使节点', render: (_, e) => e.nodes.length ? e.nodes.join('、') : <span style={{ color: 'var(--color-text-3)' }}>—</span> },
                  { title: '备注', render: (_, e) => <span style={{ color: 'var(--color-text-3)' }}>{e.note ?? ''}</span> },
                ]}
              />
            )}
          </Card>
        </>
      )}
    </Space>
  )
}
