/** 实践页（U 区·无界实践区）：习惯一等公民独立视图（#90 / ADR-0017）+ 技能条目 lane 摘要（#89 / ADR-0018）。
 *
 * 习惯域纪律：零 FSRS 语义、无到期——引擎不提醒，重复靠自报；曲线与 streak 只展示给
 * 学习者。技能 lane 与题目调度并行：这里只读到期概览，执行事件落账走 agent 工具
 * （learnhub_execution_log，评级与时长申报需要对话语境）。
 */
import { Alert, Badge, Button, Card, Empty, Input, Message, Modal, Space, Table, Tag, Tooltip } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { HabitCurvePoint, HabitListItem, SkillLaneItem } from '../types'
import AgentHints from '../components/AgentHints'

/** 自动化自评 1-5 的文案（SRBAI 语义：这个行为有多「自动」）。 */
const RATING_LABEL: Record<number, string> = {
  1: '很刻意', 2: '偏刻意', 3: '一般', 4: '较自动', 5: '不假思索',
}

/** 自动化曲线迷你条形（x=累计重复次数，y=自评 1-5；无图表库，CSS 高度即分值）。 */
function CurveBars({ curve }: { curve: HabitCurvePoint[] }) {
  const shown = curve.slice(-24)
  if (!shown.length) return <span style={{ color: 'var(--color-text-3)' }}>还没有自评点</span>
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 40 }}>
      {shown.map((p, i) => (
        <Tooltip key={i} content={`第 ${p.repeats} 次 · ${RATING_LABEL[p.rating]}（${p.rating}/5）`}>
          <div style={{
            width: 8, height: `${(p.rating / 5) * 100}%`, minHeight: 4,
            background: 'var(--color-primary-light-4, rgb(var(--arcoblue-3)))',
            borderRadius: 2,
          }} />
        </Tooltip>
      ))}
    </div>
  )
}

export default function PracticePage() {
  const [habits, setHabits] = useState<HabitListItem[] | null>(null)
  const [skills, setSkills] = useState<SkillLaneItem[] | null>(null)
  const [curve, setCurve] = useState<{ habit: string; curve: HabitCurvePoint[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([api.habits(), api.skills()])
      setHabits(h.habits)
      setSkills(s.skills)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const repeat = (h: HabitListItem) => {
    Modal.confirm({
      title: `自报重复：${h.name}`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>意图：{h.intention.cue} → {h.intention.action}</div>
          <div style={{ color: 'var(--color-text-3)' }}>自报即入账（无门禁）——这次做了就报。可选带一个「自动化程度」自评：</div>
          <Input
            id='habit-auto-rating'
            placeholder='自动化自评 1-5（可留空）：1=很刻意 … 5=不假思索'
          />
        </div>
      ),
      onOk: async () => {
        const raw = (document.getElementById('habit-auto-rating') as HTMLInputElement | null)?.value?.trim()
        setBusy(true)
        try {
          const rating = raw && /^[1-5]$/.test(raw) ? Number(raw) : undefined
          await api.habitRepeat(h.id, rating)
          Message.success(`「${h.name}」+1（${rating ? RATING_LABEL[rating] : '仅记重复'}）`)
          await load()
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  const create = () => {
    let name = ''
    let cue = ''
    let action = ''
    Modal.confirm({
      title: '立一个习惯（执行意图：稳定线索 + 单一具体行动）',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input placeholder='习惯名（如：晨间音阶）' onChange={v => { name = v }} />
          <Input placeholder='稳定线索（时间/地点锚，如：早上刷完牙后）' onChange={v => { cue = v }} />
          <Input placeholder='单一具体行动（如：打开吉他弹一段音阶）' onChange={v => { action = v }} />
          <div style={{ color: 'var(--color-text-3)' }}>无到期、无提醒——引擎只收自报、记重复、画曲线。</div>
        </div>
      ),
      style: { width: 560 },
      onOk: async () => {
        setBusy(true)
        try {
          await api.habitCreate(name, cue, action)
          Message.success('习惯已立（去 agent 对话或这里自报重复）')
          await load()
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  const showCurve = async (h: HabitListItem) => {
    setBusy(true)
    try {
      const doc = await api.habit(h.id)
      setCurve({ habit: h.name, curve: doc.curve })
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const archive = (h: HabitListItem) => {
    Modal.confirm({
      title: `归档「${h.name}」？`,
      content: '归档可逆（只是收纳标签）；无到期无截止，历史保留。',
      onOk: async () => {
        setBusy(true)
        try {
          await api.habitArchive(h.id, true)
          await load()
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <Alert type='info' content='无界实践区：习惯（零到期、零 FSRS——自报重复、画曲线、宽容 streak）与技能条目（执行事件驱动调度 lane，与题目复习并行）。习惯重复永不进 XP 或掌握度；执行事件的评级与时长申报走 agent 对话（learnhub_execution_log）。' />

      <Card
        size='small'
        title='习惯'
        extra={<Button size='mini' type='primary' disabled={busy} onClick={create}>立一个习惯</Button>}
        style={{ borderRadius: 10 }}
      >
        {habits === null ? null : habits.length === 0 ? (
          <Empty description='还没有习惯：线索 + 单一行动，比如「早上刷完牙后 → 打开吉他弹一段音阶」' />
        ) : (
          <Table
            size='small'
            data={habits}
            rowKey={h => h.id}
            pagination={false}
            columns={[
              { title: '习惯', dataIndex: 'name', width: 150 },
              { title: '执行意图', width: 300, render: (_, h) => (
                <span style={{ color: 'var(--color-text-2)' }}>{h.intention.cue} → {h.intention.action}</span>
              ) },
              { title: '累计', dataIndex: 'total_repeats', width: 70, render: v => `${v} 次` },
              { title: '宽容streak', width: 100, render: (_, h) => (
                <Tooltip content='漏天 ≤2 天不断链；与 XP streak 各算各的'>
                  <Badge count={h.streak} maxCount={999} color='arcoblue' text={` ${h.streak} 天`} />
                </Tooltip>
              ) },
              { title: '自动化', width: 110, render: (_, h) => h.latest_rating
                ? <Tag size='small' color='green'>{RATING_LABEL[h.latest_rating]}（{h.latest_rating}/5）</Tag>
                : <span style={{ color: 'var(--color-text-3)' }}>—</span> },
              { title: '', width: 230, render: (_, h) => (
                <Space size={4}>
                  <Button size='mini' type='primary' disabled={busy} onClick={() => repeat(h)}>今天做了</Button>
                  <Button size='mini' disabled={busy} onClick={() => showCurve(h)}>曲线</Button>
                  <Button size='mini' status='warning' disabled={busy} onClick={() => archive(h)}>归档</Button>
                </Space>
              ) },
            ]}
          />
        )}
      </Card>

      <Card size='small' title='技能条目（执行事件 lane）' style={{ borderRadius: 10 }}>
        {skills === null ? null : skills.length === 0 ? (
          <Empty description='还没有技能条目：在 agent 对话里 learnhub_skill_create（如吉他/游泳），执行事件驱动排期' />
        ) : (
          <Table
            size='small'
            data={skills}
            rowKey={s => s.id}
            pagination={false}
            columns={[
              { title: '技能', dataIndex: 'name', width: 150 },
              { title: 'lane 到期', width: 130, render: (_, s) => s.due
                ? <Tag size='small' color={s.due_kind === 'maintenance' ? 'orange' : 'arcoblue'}>{s.due}</Tag>
                : <span style={{ color: 'var(--color-text-3)' }}>未首练</span> },
              { title: '本次形态', width: 150, render: (_, s) => s.due_kind === 'maintenance'
                ? <Tooltip content='维持节拍帽到期：迷你重做+回放，久置技能低频回血'><span>维持复活</span></Tooltip>
                : s.due_kind === 'acquisition' ? '习得推进' : '—' },
              { title: '维持节拍', width: 100, render: (_, s) => s.maintenance_days ? `${s.maintenance_days} 天` : '关' },
              { title: '执行次数', dataIndex: 'attempts', width: 90 },
              { title: '状态', width: 80, render: (_, s) => s.status === 'archived'
                ? <Tag size='small'>已归档</Tag>
                : <Tag size='small' color='green'>active</Tag> },
            ]}
          />
        )}
      </Card>

      <Modal
        title={curve ? `自动化曲线：${curve.habit}` : ''}
        visible={!!curve}
        footer={null}
        onCancel={() => setCurve(null)}
        style={{ width: 560 }}
      >
        {curve && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ color: 'var(--color-text-3)' }}>
              横轴 = 累计重复次数，纵轴 = 自动化自评（1-5）。渐近增长、中断不衰减——漏几天曲线不会掉。
            </div>
            <CurveBars curve={curve.curve} />
            <div style={{ color: 'var(--color-text-3)' }}>只展示给你自己：曲线与 streak 永不进掌握度、XP 或任何调度面。</div>
          </div>
        )}
      </Modal>
      <AgentHints page='practice' />
    </Space>
  )
}
