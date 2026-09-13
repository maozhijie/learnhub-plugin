/** 洞察区·记忆健康区块（页内子组件；#210 随统计页入洞察）：横向直方图/逐日负载/保留率曲线三件纯展示图元
 * + FSRS 参数优化器 + 记忆健康四面板（#61 A2：每日负载预报/记忆状态分布/真实保留率/
 * 遗忘曲线，另带 #66 E4 预测校准与 JOL/过信提示开关）。数据经 props 注入（缝在 index.tsx）。 */
import { Button, InputNumber, Message, Space, Switch, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import type { CalibrationHintsConfig, HistogramBin, JolConfig, MemoryHealth, OptimizeResult } from '../../types'

const { Text } = Typography

export const EMPTY_HINT = '暂无足够复习数据，继续学习将自动填充'

/** 横向直方图（纯 div 条形，无图表库依赖）：label + 比例条 + 计数。 */
export function HBars({ bins }: { bins: HistogramBin[] }) {
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

/** FSRS 参数优化（A2 #62，#72 UI 挂接）：像 Anki 一样只手动触发——从真实复习日志
 * 重训个人参数；门禁（真实推进 ≥400 条且评估更优）不满足时不写回，
 * status/skip 原因/评估指标就地展示（门禁状态透明）。 */
function OptimizerSection() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<OptimizeResult | null>(null)
  const run = async () => {
    setBusy(true)
    try {
      setResult(await api.optimizeParams())
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <Space size={8} wrap style={{ marginBottom: result ? 6 : 0 }}>
        <Text style={{ fontWeight: 600 }}>FSRS 参数优化（A2）</Text>
        <Button size='mini' type='primary' loading={busy} onClick={() => void run()}
          title='从真实复习日志重训 21 个调度参数（评估更优才写回）'>
          优化参数
        </Button>
        <Text type='secondary' style={{ fontSize: 12 }}>
          从你的真实复习记录重训个人调度参数；点击时检测门禁——真实推进不足 400 条或评估未更优则不写回并明示原因，绝不自动触发
        </Text>
      </Space>
      {result && (
        <div style={{ background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '8px 10px' }}>
          {result.status === 'written' ? (
            <>
              <Space size={8} wrap>
                <Tag size='small' color='green'>已写回</Tag>
                <Text type='secondary' style={{ fontSize: 12 }}>{(result.written ?? []).join('、')}</Text>
              </Space>
              {result.meta && (
                <Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  门禁通过：真实复习 {result.meta.reviews} 条（{result.meta.cards} 张卡）·
                  {' '}logLoss {result.meta.baseline_log_loss} → {result.meta.log_loss}
                  （RMSE(bins) {result.meta.rmse_bins}）
                  {result.meta.split_log_loss !== null && <>· 时序切分 logLoss {result.meta.split_log_loss}</>}
                </Text>
              )}
            </>
          ) : (
            <Space size={8} wrap>
              <Tag size='small' color='gray'>未写回</Tag>
              <Text type='secondary' style={{ fontSize: 12 }}>{result.reason}</Text>
            </Space>
          )}
        </div>
      )}
    </div>
  )
}

/** 记忆健康面板主体（mem 已由缝保证非空）。
 * jol 全局开关 + 抽样率（#66 E4，#72 补 rate 输入）与面板同区：关闭后复习流
 * 完全不弹预测，已攒的校准数据保留。hints = 过信轻提示全局开关（ADR-0022 #104），
 * 放 JOL 开关旁：关闭后队列不再带轻提示、抽查密度不再加强。 */
export function MemoryHealthBody({ mem, jol, hints, onToggleJol, onRateJol, onToggleHints }: {
  mem: MemoryHealth
  jol: JolConfig | null
  hints: CalibrationHintsConfig | null
  onToggleJol: (enabled: boolean) => void
  onRateJol: (rate: number) => void
  onToggleHints: (enabled: boolean) => void
}) {
  const noCards = mem.state.scheduled === 0
  const calibration = mem.calibration.filter(b => b.n > 0)
  return (
    <Space direction='vertical' style={{ width: '100%' }} size={16}>
      {noCards ? (
        <Text type='secondary'>{EMPTY_HINT}</Text>
      ) : (<>
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
                {/* E4 抽样率（#72）：每次复习被抽中弹预测的概率（0.05–1），即时保存 */}
                <Tooltip content='抽查抽样率：每次复习被抽中弹预测的概率（0.05–1）'>
                  <InputNumber size='mini' mode='button' min={0.05} max={1} step={0.05}
                    value={jol.rate} onChange={v => onRateJol(Number(v))} style={{ width: 100 }}
                    disabled={!jol.enabled} />
                </Tooltip>
                <Text type='secondary' style={{ fontSize: 12 }}>约每 {Math.round(1 / Math.max(0.01, jol.rate))} 张 1 张</Text>
                {/* 过信轻提示全局开关（ADR-0022 #104）：检出系统性过信时在预测出口
                    轻提醒 + 抽查密度自动加强（1/3→1/2）；关掉后两者都消失 */}
                {hints && (
                  <Tooltip content='过信轻提示：「会」预测的实际正确率持续偏低时，在预测出口给一句保守预测提醒，并自动加强抽查密度（可全局关）'>
                    <Space size={4} style={{ marginLeft: 8 }}>
                      <Text type='secondary' style={{ fontSize: 12 }}>过信提示</Text>
                      <Switch size='small' checked={hints.hints_enabled} onChange={onToggleHints} />
                    </Space>
                  </Tooltip>
                )}
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
      </>)}
      {/* A2 FSRS 参数优化（#62，#72 UI 挂接）：手动触发 + 门禁状态就地展示 */}
      <OptimizerSection />
    </Space>
  )
}
