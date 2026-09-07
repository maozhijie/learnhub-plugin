/** 统计页：各课程阶段统计（未学 = unseen+ready；复习到期 = 有到期题目的节点）
 * + XP 时间账本（今日 XP / streak / 每日目标编辑）+ 每课程预计完成天数
 * （剩余节点 × 每节点 XP ÷ 每日目标，Math Academy 语义）。 */
import { Button, Card, InputNumber, Message, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { toastError } from '../App'
import type { AppFrame } from '../App'
import type { XpStatus } from '../types'

const { Text } = Typography

export default function StatsPage({ frame }: { frame: AppFrame }) {
  const [xp, setXp] = useState<XpStatus | null>(null)
  const [goal, setGoal] = useState<number>(30)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const doc = await api.xp().catch(() => null)
    setXp(doc)
    if (doc) setGoal(doc.goal)
  }, [])

  useEffect(() => { void load() }, [load])
  // 作答/完成后回到本页能看到最新账本
  useEffect(() => {
    const h = () => void load()
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [load])

  const saveGoal = async () => {
    setSaving(true)
    try {
      const r = await api.setDailyGoal(goal)
      Message.success(`每日目标已调整为 ${r.goal} XP（约等于每天 ${r.goal} 分钟专注）`)
      await load()
    } catch (err) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <Card size='small' title='XP 时间账本' style={{ borderRadius: 10 }}
        extra={xp && (
          <Space size={8}>
            <Text type='secondary' style={{ fontSize: 12 }}>每日目标</Text>
            <InputNumber size='mini' mode='button' min={5} max={1000} step={5}
              value={goal} onChange={v => setGoal(Number(v) ?? 30)} style={{ width: 110 }} />
            <Button size='mini' type='primary' loading={saving} onClick={() => void saveGoal()}>保存</Button>
          </Space>
        )}>
        {xp === null ? <Text type='secondary'>加载中…</Text> : (
          <Space size={24} wrap>
            <div>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{xp.today_xp}</Text>
              <Text type='secondary' style={{ fontSize: 12 }}>今日 XP（≈ 分钟专注）</Text>
            </div>
            <div>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{xp.streak}</Text>
              <Text type='secondary' style={{ fontSize: 12 }}>连续学习天数</Text>
            </div>
            <div>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{xp.goal}</Text>
              <Text type='secondary' style={{ fontSize: 12 }}>每日目标 XP</Text>
            </div>
          </Space>
        )}
      </Card>

      <Card size='small' title='课程状态总览' style={{ borderRadius: 10 }}>
        <Table size='small' data={frame.status?.courses ?? []} rowKey={c => c.id} pagination={false}
          columns={[
            { title: '课程', dataIndex: 'name' },
            { title: '总节点', dataIndex: 'total', width: 80 },
            { title: '未学', width: 70, render: (_, c) => <Tag size='small'>{c.counts.unseen + c.counts.ready}</Tag> },
            { title: '进行', width: 70, render: (_, c) => <Tag size='small' color='arcoblue'>{c.counts.learning}</Tag> },
            { title: '复习', width: 70, render: (_, c) => <Tag size='small' color='green'>{c.counts.review}</Tag> },
            { title: '掌握', width: 70, render: (_, c) => <Tag size='small' color='green'>{c.counts.mastered}</Tag> },
            { title: '已跳过', width: 80, render: (_, c) => c.counts.skipped > 0
              ? <Tag size='small' color='purple'>{c.counts.skipped}</Tag>
              : <Tag size='small' color='gray'>0</Tag> },
            { title: '今日到期', width: 90, render: (_, c) => c.due_today > 0
              ? <Tag size='small' color='red'>{c.due_today}</Tag>
              : <Tag size='small' color='gray'>0</Tag> },
          ]} />
      </Card>

      <Card size='small' title='预计完成（按当前每日目标外推）' style={{ borderRadius: 10 }}>
        {xp === null || xp.eta.length === 0 ? <Text type='secondary'>暂无启用课程。</Text> : (
          <Table size='small' data={xp.eta} rowKey={e => e.course} pagination={false}
            columns={[
              { title: '课程', dataIndex: 'course' },
              { title: '剩余节点', dataIndex: 'remaining', width: 100 },
              { title: '已完成', dataIndex: 'done', width: 90 },
              { title: '每节点 XP（历史估算）', dataIndex: 'per_node', width: 170 },
              { title: '预计天数', width: 100, render: (_, e) => (
                e.days > 0 ? <Tag size='small' color='arcoblue'>≈ {e.days} 天</Tag> : <Tag size='small' color='green'>已完成</Tag>
              ) },
            ]} />
        )}
        <Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          ETA = 剩余节点 × 每节点 XP（该课程历史 XP / 已完成节点数，无历史按 12 XP 估） ÷ 每日目标。
          XP 记入作答流水：答对得题型权重 × 难度，提交过快且答错按乱猜扣分，同日重复作答不记账。
        </Text>
      </Card>
    </Space>
  )
}
