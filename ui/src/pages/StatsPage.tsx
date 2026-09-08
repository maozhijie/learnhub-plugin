/** 统计页：各课程阶段统计（未学 = unseen+ready；复习到期 = 有到期题目的节点）
 * + XP 时间账本（今日 XP / streak / 每日目标编辑）+ 每课程预计完成天数
 * （剩余节点 × 每节点 XP ÷ 每日目标，Math Academy 语义）
 * + 记忆健康仪表盘（#61 A2 四面板：每日负载预报 / 记忆状态分布 / 真实保留率 /
 * 遗忘曲线；随复习日志积累填充，无数据给空态引导，不造假数据）
 * + 预测校准（#66 E4：学习者 JOL 预测 vs 实际，抽查样本口径）与抽查全局开关
 * + 可用的困难教练（#65 E5：只读信息性反馈，低数据静默）。 */
import { Alert, Button, Card, InputNumber, Message, Space, Switch, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { toastError } from '../App'
import type { AppFrame } from '../App'
import type { CoachDoc, HistogramBin, JolConfig, MemoryHealth, XpStatus } from '../types'

const { Text } = Typography

const EMPTY_HINT = '暂无足够复习数据，继续学习将自动填充'

/** 横向直方图（纯 div 条形，无图表库依赖）：label + 比例条 + 计数。 */
function HBars({ bins }: { bins: HistogramBin[] }) {
  const max = Math.max(1, ...bins.map(b => b.count))
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      {bins.map(b => (
        <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text type='secondary' style={{ fontSize: 11, width: 58, flexShrink: 0 }}>{b.label}</Text>
          <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(b.count / max) * 100}%`, height: '100%', background: 'var(--color-primary-light-3,#bedaff)' }} />
          </div>
          <Text style={{ fontSize: 11, width: 28, textAlign: 'right' }}>{b.count}</Text>
        </div>
      ))}
    </div>
  )
}

/** 逐日负载条形（Anki Forecast 式竖条，hover 看日期）。 */
function DayBars({ perDay }: { perDay: Array<{ d: string; count: number }> }) {
  const max = Math.max(1, ...perDay.map(p => p.count))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 84 }}>
      {perDay.map(p => (
        <div key={p.d} title={`${p.d}：${p.count} 道到期`}
          style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', minWidth: 3 }}>
          <div style={{
            width: '100%', height: `${Math.max(p.count ? 4 : 1, (p.count / max) * 100)}%`,
            background: p.count ? 'var(--color-primary-4,#4080ff)' : 'var(--color-fill-2,#f2f3f5)',
            borderRadius: 2,
          }} />
        </div>
      ))}
    </div>
  )
}

/** 保留率曲线（横向条形，按保留率比例着色）。 */
function RateBars({ rows }: { rows: Array<{ label: string; n: number; rate: number | null }> }) {
  const hasData = rows.some(r => r.rate !== null)
  if (!hasData) return <Text type='secondary' style={{ fontSize: 12 }}>{EMPTY_HINT}</Text>
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      {rows.map(r => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text type='secondary' style={{ fontSize: 11, width: 64, flexShrink: 0 }}>{r.label}</Text>
          <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              width: `${(r.rate ?? 0) * 100}%`, height: '100%',
              background: (r.rate ?? 0) >= 0.8 ? 'var(--color-success-3,#00b42a)'
                : (r.rate ?? 0) >= 0.6 ? 'var(--color-warning-3,#ff7d00)' : 'var(--color-danger-3,#f53f3f)',
            }} />
          </div>
          <Text style={{ fontSize: 11, width: 64, textAlign: 'right' }}>
            {r.rate === null ? '—' : `${Math.round(r.rate * 100)}%（${r.n} 次）`}
          </Text>
        </div>
      ))}
    </div>
  )
}

/** 记忆健康仪表盘（面板；数据源 GET /memory，聚合口径见 engine/memory.ts）。
 * jol 全局开关（#66 E4）与面板同区：关闭后复习流完全不弹预测，已攒的校准数据保留。 */
function MemoryHealthCard({ mem, jol, onToggleJol }: {
  mem: MemoryHealth | null
  jol: JolConfig | null
  onToggleJol: (enabled: boolean) => void
}) {
  if (mem === null) {
    return (
      <Card size='small' title='记忆健康' style={{ borderRadius: 10 }}>
        <Text type='secondary'>加载中…</Text>
      </Card>
    )
  }
  const noCards = mem.state.scheduled === 0
  const calibration = mem.calibration.filter(b => b.n > 0)
  return (
    <Card size='small' title='记忆健康' style={{ borderRadius: 10 }}
      extra={<Text type='secondary' style={{ fontSize: 12 }}>真实作答口径——合成首复习不计入</Text>}>
      {noCards ? (
        <Text type='secondary'>{EMPTY_HINT}</Text>
      ) : (
        <Space direction='vertical' style={{ width: '100%' }} size={16}>
          {/* 1 · 每日负载预报 */}
          <div>
            <Space size={8} style={{ marginBottom: 6 }}>
              <Text style={{ fontWeight: 600 }}>每日负载预报</Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                未来 {mem.forecast.horizon_days} 天（假设不再学新卡且不遗忘）
              </Text>
              {mem.forecast.overdue > 0 && <Tag size='small' color='red'>逾期 {mem.forecast.overdue}</Tag>}
            </Space>
            <DayBars perDay={mem.forecast.per_day} />
          </div>
          {/* 2 · 记忆状态分布 */}
          <div>
            <Text style={{ fontWeight: 600 }}>记忆状态分布</Text>
            <Text type='secondary' style={{ fontSize: 12 }}>（{mem.state.scheduled} 张已调度题卡，跨课程聚合）</Text>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginTop: 8 }}>
              <div>
                <Text type='secondary' style={{ fontSize: 12 }}>记忆强度（Stability，天）</Text>
                <HBars bins={mem.state.stability} />
              </div>
              <div>
                <Text type='secondary' style={{ fontSize: 12 }}>题目难度（FSRS Difficulty）</Text>
                <HBars bins={mem.state.difficulty} />
              </div>
              <div>
                <Text type='secondary' style={{ fontSize: 12 }}>当前可回忆度（R）</Text>
                <HBars bins={mem.state.retrievability} />
              </div>
            </div>
          </div>
          {/* 3 · 真实保留率 + 预测 vs 真实 */}
          <div>
            <Space size={8} style={{ marginBottom: 6 }}>
              <Text style={{ fontWeight: 600 }}>真实保留率</Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                到期复习（每卡每天取第一次推进）实际答对的比例；只统计真实作答
              </Text>
            </Space>
            {mem.retention.real === 0 ? (
              <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>{EMPTY_HINT}</Text>
            ) : (
              <Space size={24} wrap style={{ marginBottom: 8 }}>
                <div>
                  <Text style={{ fontWeight: 600, fontSize: 18 }}>{Math.round((mem.retention.rate ?? 0) * 100)}%</Text>
                  <Text type='secondary' style={{ fontSize: 12 }}> 真实保留率</Text>
                </div>
                <div>
                  <Text style={{ fontWeight: 600, fontSize: 18 }}>{mem.retention.pass}</Text>
                  <Text type='secondary' style={{ fontSize: 12 }}> 答对</Text>
                </div>
                <div>
                  <Text style={{ fontWeight: 600, fontSize: 18 }}>{mem.retention.fail}</Text>
                  <Text type='secondary' style={{ fontSize: 12 }}> 答错/忘记</Text>
                </div>
              </Space>
            )}
            {calibration.length > 0 && (
              <div>
                <Text type='secondary' style={{ fontSize: 12 }}>预测 vs 真实（按 FSRS 自预测保留率分箱）</Text>
                <div style={{ display: 'grid', gap: 3, marginTop: 4 }}>
                  {calibration.map(b => (
                    <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text type='secondary' style={{ fontSize: 11, width: 70, flexShrink: 0 }}>预测 {b.label}</Text>
                      <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          width: `${(b.actual ?? 0) * 100}%`, height: '100%',
                          background: 'var(--color-primary-4,#4080ff)',
                        }} />
                      </div>
                      <Text style={{ fontSize: 11, width: 64, textAlign: 'right' }}>
                        实际 {Math.round((b.actual ?? 0) * 100)}%（{b.n} 次）
                      </Text>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* 4 · 按时点遗忘曲线 */}
          <div>
            <Text style={{ fontWeight: 600 }}>按时点遗忘曲线</Text>
            <Text type='secondary' style={{ fontSize: 12 }}>（到期复习按间隔分桶的实际保留率）</Text>
            <div style={{ marginTop: 8 }}>
              <RateBars rows={mem.forgetting} />
            </div>
          </div>
          {/* 5 · 预测校准（#66 E4）：学习者 JOL vs 实际——抽查样本口径，只展示不喂任何度量 */}
          <div>
            <Space size={8} style={{ marginBottom: 4 }}>
              <Text style={{ fontWeight: 600 }}>预测校准（你的直觉 vs 实际）</Text>
              {jol && (
                <Space size={6}>
                  <Text type='secondary' style={{ fontSize: 12 }}>翻面前抽查预测</Text>
                  <Switch size='small' checked={jol.enabled} onChange={onToggleJol} />
                </Space>
              )}
            </Space>
            {mem.jol ? (
              <>
                <Text type='secondary' style={{ fontSize: 12 }}>
                  （复习翻面前抽查预测「会/不会/没把握」与实际对错的对照，共 {mem.jol.pairs} 条；
                  只统计被抽到的卡——约 1/3 复习卡、优先将忘未忘与难度中段，不代表全部复习）
                </Text>
                <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                  {mem.jol.bins.filter(b => b.n > 0).map(b => (
                    <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Text type='secondary' style={{ fontSize: 11, width: 70, flexShrink: 0 }}>预测 {b.label}</Text>
                      <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          width: `${(b.accuracy ?? 0) * 100}%`, height: '100%',
                          background: 'var(--color-warning-4,#ffb65d)',
                        }} />
                      </div>
                      <Text style={{ fontSize: 11, width: 84, textAlign: 'right' }}>
                        实际 {b.accuracy === null ? '—' : `${Math.round(b.accuracy * 100)}%`}（{b.n} 条{b.forgot ? ` · 忘 ${b.forgot}` : ''}）
                      </Text>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                {EMPTY_HINT}（预测配对攒够后显示）
              </Text>
            )}
          </div>
        </Space>
      )}
    </Card>
  )
}

export default function StatsPage({ frame }: { frame: AppFrame }) {
  const [xp, setXp] = useState<XpStatus | null>(null)
  const [mem, setMem] = useState<MemoryHealth | null>(null)
  const [goal, setGoal] = useState<number>(30)
  const [saving, setSaving] = useState(false)
  const [jol, setJol] = useState<JolConfig | null>(null)
  const [coach, setCoach] = useState<CoachDoc | null>(null)

  const load = useCallback(async () => {
    const doc = await api.xp().catch(() => null)
    setXp(doc)
    if (doc) setGoal(doc.goal)
    setMem(await api.memory().catch(() => null))
    setJol(await api.jol().catch(() => null))
    setCoach(await api.coach().catch(() => null))
  }, [])

  useEffect(() => { void load() }, [load])
  // 作答/完成后回到本页能看到最新账本
  useEffect(() => {
    const h = () => void load()
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [load])

  const toggleJol = async (enabled: boolean) => {
    try {
      const r = await api.setJol({ enabled })
      setJol(r)
      Message.success(enabled
        ? `预测抽查已开启（约每 ${Math.round(1 / Math.max(0.01, r.rate))} 张复习卡 1 张）`
        : '预测抽查已关闭：复习流不再弹预测')
    } catch (err) {
      toastError(err)
    }
  }

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
      {/* 可用的困难教练（#65 E5）：只读信息性反馈——低数据静默，触发才显示 */}
      {coach && coach.messages.length > 0 && (
        <Alert type='info' content={coach.messages.map(m => <div key={m}>{m}</div>)} />
      )}
      <MemoryHealthCard mem={mem} jol={jol} onToggleJol={enabled => void toggleJol(enabled)} />

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
