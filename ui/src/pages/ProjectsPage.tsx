/** 项目页（P 区·有界项目区）：项目清单 + 2×2 Mastery 交叉诊断（P-7 / ADR-0015 §4/§8）。
 *
 * 2×2 是项目面板核心视图：X = 关联节点 masteryOfFm 均值（陈述性掌握），Y = 执行事件分
 * EMA（项目执行证据），阈值 0.6 两轴同口径；证据缺失按该轴低侧处理。四象限只读可读。
 * 入档推荐（challenge point）只读展示——引擎提议、学习者显式改档；推荐永不参与任何
 * 门禁。执行事件记录：评级/来源/行使节点/一句话备注；auto 来源（可观测证据确定性
 * 映射）走 agent 工具 learnhub_project_exec_log。执行事件零 XP、零调度写入。
 */
import { Alert, Button, Card, Empty, Input, Message, Select, Space, Table, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { FadingTier, ProjectCrossDoc, ProjectFm } from '../types'
import AgentHints from '../components/AgentHints'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

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
      <span className='lh-text-2'>
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
  // 目标反编译（面板下发，ADR-0038）：新建项目并起草「里程碑计划 + 知识种子簇」双提案
  const [dcName, setDcName] = useState('')
  const [dcGoal, setDcGoal] = useState('')
  const [dcBusy, setDcBusy] = useState(false)
  // 选中项目的 AI 起草（计划草案 / 里程碑任务卡，均为队列任务 + 提案人审）
  const [draftBusy, setDraftBusy] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    try {
      const list = await api.projects()
      setProjects(list)
      setSelected(prev => (prev && list.some(p => p.id === prev) ? prev : list[0]?.id ?? null))
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }, [])

  const loadCross = useCallback(async (id: string) => {
    try {
      setCross(await api.projectCross(id))
    } catch (err) {
      setCross(null)
      Message.error(errorMessage(err))
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
      Message.error(errorMessage(err))
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
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 新建项目 + 目标反编译：项目落地后入队双提案起草（计划半区 + 种子半区，同进同退）。 */
  const createAndDecompile = async () => {
    if (!dcName.trim()) { Message.warning('给项目起个名'); return }
    if (!dcGoal.trim()) { Message.warning('描述一下目标——反编译只认目标描述'); return }
    setDcBusy(true)
    try {
      const created = await api.projectCreate(dcName.trim(), dcGoal.trim())
      const id = String((created as { id?: unknown }).id ?? '')
      if (!id) throw new Error('项目创建返回缺少 id')
      const r = await api.projectDecompile(id)
      Message.success(`${r.message}（生成队列看进度，提案收件箱联合人审）`)
      setDcName('')
      setDcGoal('')
      await loadList()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setDcBusy(false)
    }
  }

  /** 既有项目的反编译/起草动作：全部队列任务化，产物走提案人审。 */
  const draft = async (kind: 'decompile' | 'plan' | `milestone:${string}`) => {
    if (!selected) return
    setDraftBusy(kind)
    try {
      const r = kind === 'decompile' ? await api.projectDecompile(selected)
        : kind === 'plan' ? await api.projectPlanGenerate(selected)
          : await api.projectMilestoneGenerate(selected, kind.slice('milestone:'.length))
      Message.success(`${r.message}（生成队列看进度）`)
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setDraftBusy(null)
    }
  }

  return (
    <Space direction='vertical' className='lh-full' size={14}>
      <Alert type='info' content='项目区（Course 的姊妹实体，以周/月计的真实实践）：这里看每个项目的 2×2 掌握交叉诊断——左边陈述性掌握（关联节点），下边项目执行证据。执行事件零 XP、零调度写入；入档推荐只是提议，改档是你的显式动作，推荐永不参与任何门禁。' />

      <Card size='small' title='目标反编译（建课引导）' className='lh-card'>
        <Space direction='vertical' size={8} className='lh-full'>
          <Text type='secondary' className='lh-t-12'>
            从「目标项目描述」反推学习资产：里程碑计划草案 + 知识种子簇双提案（同进同退，提案页联合人审）；
            显式目标课程时只产计划半区。知识子图检索只读 Vault 先验，apply 前零写入。
          </Text>
          <Space size={8} wrap>
            <Input className='lh-w-200' placeholder='项目名（如：三个月弹会小曲）' value={dcName} onChange={setDcName} />
            <Input className='lh-w-360' placeholder='目标描述：做出什么、给谁、什么算成' value={dcGoal} onChange={setDcGoal} />
            <Button type='primary' size='small' loading={dcBusy} onClick={() => void createAndDecompile()}>
              创建项目并反编译
            </Button>
          </Space>
        </Space>
      </Card>

      <AgentHints page='projects' />

      <Card size='small' title='项目' className='lh-card'>
        {projects === null ? null : projects.length === 0 ? (
          <Empty description='还没有项目：上面「目标反编译」建一个（真实在做的实践，如「三个月弹会小曲」）' />
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
              { title: '目标', render: (_, p) => <span className='lh-muted'>{p.goal}</span> },
            ]}
          />
        )}
      </Card>

      {selected && (
        <Card size='small' title='AI 起草（提案-人审通道）' className='lh-card'>
          <Space size={8} wrap>
            <Button size='small' loading={draftBusy === 'decompile'} onClick={() => void draft('decompile')}>目标反编译（双提案）</Button>
            <Button size='small' loading={draftBusy === 'plan'} onClick={() => void draft('plan')}>里程碑计划草案</Button>
            {(projects?.find(p => p.id === selected)?.plan ?? []).map(m => (
              <Button key={m.id} size='small' loading={draftBusy === `milestone:${m.id}`}
                onClick={() => void draft(`milestone:${m.id}`)}>
                任务卡：{m.name || m.id}
              </Button>
            ))}
          </Space>
          <div className='lh-mt-6 lh-muted lh-t-12'>
            全部入队即返回（生成页看进度）；产物走提案页人审——计划 apply 带旧计划快照，里程碑已生成过则自动转重生成提案。
          </div>
        </Card>
      )}

      {selected && cross && (
        <>
          <Card
            size='small'
            title={`2×2 诊断：${cross.name}`}
            extra={
              <Space size={16}>
                <AxisValue label='X 陈述性掌握' value={cross.x.value} caliber={cross.x.caliber} />
                <AxisValue label='Y 项目执行证据' value={cross.y.value} caliber={cross.y.caliber} />
                <span className='lh-muted'>高低分界 {Math.round(cross.thresholds.axis * 100)}%</span>
              </Space>
            }
            className='lh-card'
          >
            <div className='lh-grid-2'>
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
                      <span className='lh-muted lh-t-12'>掌握{cell.x} × 执行{cell.y}</span>
                      {active && <Tag size='small' color='arcoblue'>当前落位</Tag>}
                    </Space>
                    <div className='lh-mt-6 lh-text-2 lh-t-13 lh-lh-1p5'>
                      {hint || '——'}
                    </div>
                  </div>
                )
              })}
            </div>
            {cross.linked_nodes.length > 0 && (
              <div className='lh-mt-10 lh-flex lh-wrap lh-gap-6'>
                {cross.linked_nodes.map(n => (
                  <Tag key={`${n.course}/${n.node}`} size='small' color='gray'>
                    {n.node}（{Math.round(n.mastery * 100)}%）
                  </Tag>
                ))}
              </div>
            )}
          </Card>

          <Card size='small' title='入档推荐（challenge point，只读）' className='lh-card'>
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
              <Select size='mini' className='lh-w-120' value={cross.tier} disabled={busy}
                onChange={v => adoptTier(v as FadingTier)}
                options={TIER_OPTIONS.map(t => ({ label: `改为 ${t}`, value: t }))} />
            </Space>
            <ul className='lh-m-8px-0-0 lh-pl-20 lh-text-2 lh-t-13 lh-lh-1p7'>
              {cross.recommendation.reasons.map((r, i) => <li key={i}>{r}</li>)}
              <li className='lh-muted'>
                判据：档内 ≥{cross.thresholds.promote_min_events} 次均分 ≥{Math.round(cross.thresholds.promote_score * 100)}%
                升 / &lt;{Math.round(cross.thresholds.demote_score * 100)}% 降，且知识底座 ≥{Math.round(cross.thresholds.axis * 100)}%
                ——引擎只提议，永不做门禁
              </li>
            </ul>
          </Card>

          <Card size='small' title='记一次执行事件' className='lh-card'>
            <Space size={8} wrap>
              <Select size='small' className='lh-w-110' value={source} onChange={v => setSource(v as 'self' | 'ai')}
                options={[{ label: '自评（self）', value: 'self' }, { label: 'AI 评（ai）', value: 'ai' }]} />
              <Select size='small' className='lh-w-130' value={rating} onChange={v => setRating(Number(v))}
                options={[4, 3, 2, 1].map(r => ({ label: `${r}（${RATING_LABEL[r]}）`, value: r }))} />
              <Input size='small' className='lh-w-240' placeholder='行使的关联节点，逗号分隔（可空）'
                value={nodesText} onChange={v => setNodesText(v)} />
              <Input size='small' className='lh-w-200' placeholder='一句话备注（可空）'
                value={note} onChange={v => setNote(v)} />
              <Button size='small' type='primary' disabled={busy} onClick={submitExec}>落流</Button>
            </Space>
            <div className='lh-mt-6 lh-muted lh-t-12'>
              nodes 里给出关联节点时，两端都在其中的既有 enc 边算被行使——练习证据单向回流到边两端节点（零 XP、零调度写入）；
              自动证据来源（source=auto）需要可观测判据，走 agent 工具 learnhub_project_exec_log。
            </div>
          </Card>

          <Card size='small' title={`执行事件（${cross.exec.count} 条）`} className='lh-card'>
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
                  { title: '行使节点', render: (_, e) => e.nodes.length ? e.nodes.join('、') : <span className='lh-muted'>—</span> },
                  { title: '备注', render: (_, e) => <span className='lh-muted'>{e.note ?? ''}</span> },
                ]}
              />
            )}
          </Card>
        </>
      )}
    </Space>
  )
}
