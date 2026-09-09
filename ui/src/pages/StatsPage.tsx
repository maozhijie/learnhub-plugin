/** 统计页：各课程阶段统计（未学 = unseen+ready；复习到期 = 有到期题目的节点）
 * + XP 时间账本（今日 XP / streak / 每日目标编辑）+ 每课程预计完成天数
 * （剩余节点 × 每节点 XP ÷ 每日目标，Math Academy 语义）
 * + 记忆健康仪表盘（#61 A2 四面板：每日负载预报 / 记忆状态分布 / 真实保留率 /
 * 遗忘曲线；随复习日志积累填充，无数据给空态引导，不造假数据）
 * + FSRS 参数优化（#62 A2，#72 UI 挂接：手动触发 + 门禁状态展示）
 * + 预测校准（#66 E4：学习者 JOL 预测 vs 实际）与抽查全局开关/抽样率
 * + 自评校准画像（ADR-0022 #104：分源自省面为主视图、全局聚合折叠为参考视图，
 *   过信轻提示全局开关在记忆健康卡的 JOL 开关旁）
 * + Anki 通道区块（#63 C2，#72 UI 挂接：上次导出/回写、镜象卡组概况、
 *   AnkiConnect 可达性；导出/回写动作面板内直达。用词遵守 CONTEXT：不叫「同步」）
 * + 可用的困难教练（#65 E5：只读信息性反馈，低数据静默）
 * + 周复盘 Weekly Kata（#114 U4 / ADR-0026：入口常驻、无推送、缺勤不罚——
 *   现状引擎自动填，四问学习者作答；「下一实验」一键转 N-of-1 提案或执行意图）。 */
import { Alert, Button, Card, Collapse, Input, InputNumber, Message, Modal, Select, Space, Switch, Table, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { toastError } from '../App'
import type { AppFrame } from '../App'
import type {
  AnkiExportResult, AnkiImportResult, AnkiStatusDoc, CalibrationHintsConfig, CalibrationProfileDoc,
  CoachDoc, ExperimentsDoc, HistogramBin, JolConfig, KataDoc,
  MemoryHealth, OptimizeResult, XpStatus,
} from '../types'

const { Text } = Typography
/** 学习者作答的四问（引擎常量 KATA_QUESTIONS 含「现状」，此处只列作答面；值须与引擎一致）。 */
const KATA_ANSWER_KEYS = ['目标条件', '障碍', '下一实验', '预期所学'] as const
const KATA_PLACEHOLDER = '（待答）'

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
      toastError(err)
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

/** Anki 通道区块（C2 #63，#72 UI 挂接）：通道状态（镜象规模/上次导出与回写/到期
 * 分布/AnkiConnect 可达性）+ 导出/回写按钮——C2 全流程面板内可达，无需进 dsh 会话。
 * 用词遵守 CONTEXT 词条 Anki Mirror（镜象）：这是单向推送 + 作答回写，不是「同步」。 */
function AnkiChannelCard() {
  const [st, setSt] = useState<AnkiStatusDoc | null>(null)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [lastImport, setLastImport] = useState<AnkiImportResult | null>(null)

  const load = useCallback(async () => {
    setSt(await api.ankiStatus().catch(() => null))
  }, [])
  useEffect(() => { void load() }, [load])

  const doExport = async () => {
    setBusy('export')
    try {
      const r: AnkiExportResult = await api.ankiExport()
      Message.success(`已推送到 Anki：新增 ${r.added} · 更新 ${r.updated} · 移除 ${r.removed}（到期 ${r.total} 张）`)
      await load()
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    setBusy('import')
    try {
      const r = await api.ankiImport()
      setLastImport(r)
      Message.success(`回写完成：导入 ${r.imported} 条事件，推进调度 ${r.advanced} 题（同日已推进跳过 ${r.skipped_same_day} · 无法归属 ${r.skipped_unknown}）`)
      await load()
    } catch (err) {
      toastError(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card size='small' title='Anki 通道' style={{ borderRadius: 10 }}
      extra={st?.anki && (
        <Tooltip content={st.anki.connected ? 'AnkiConnect 已连通（桌面 Anki 在线）' : st.anki.error}>
          <Tag size='small' color={st.anki.connected ? 'green' : 'red'}>
            {st.anki.connected ? 'Anki 已连接' : 'Anki 未连接'}
          </Tag>
        </Tooltip>
      )}>
      {st === null ? <Text type='secondary'>加载中…</Text> : (
        <Space direction='vertical' style={{ width: '100%' }} size={10}>
          <Space size={24} wrap>
            <div>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{st.mirror.entries}</Text>
              <Text type='secondary' style={{ fontSize: 12 }}> 张镜象卡（Anki 侧 learnhub 卡组）</Text>
            </div>
            <div>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{st.due.total}</Text>
              <Text type='secondary' style={{ fontSize: 12 }}> 张 vault 到期卡待推送</Text>
            </div>
          </Space>
          <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
            上次导出：{st.mirror.last_push ?? '从未'} · 上次回写：{st.mirror.last_import ?? '从未'}
            {st.mirror.decks.length > 0 && <> · 镜象卡组：{st.mirror.decks.join('、')}</>}
          </Text>
          {st.due.by_deck.length > 0 && (
            <Space size={4} wrap>
              {st.due.by_deck.map(d => <Tag key={d.deck} size='small' color='orange'>{d.deck} · 到期 {d.count}</Tag>)}
            </Space>
          )}
          <Space size={8} wrap>
            <Button type='primary' size='small' loading={busy === 'export'} onClick={() => void doExport()}>导出到 Anki</Button>
            <Button size='small' loading={busy === 'import'} onClick={() => void doImport()}>导入回写</Button>
            <Button size='small' type='text' onClick={() => void load()}>刷新</Button>
          </Space>
          {lastImport && lastImport.unknown.length > 0 && (
            <Alert type='warning' style={{ fontSize: 12 }}
              content={`有 ${lastImport.skipped_unknown} 条事件无法归属（已跳过不猜）：${lastImport.unknown.join('；')}`} />
          )}
          <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
            Anki 是纯作答通道：先「导出到 Anki」把到期卡推进镜象卡组，在 Anki 里作答后再「导入回写」——vault 按自己的调度器重算（回写先于下次导出，刚答过的卡不会被重复推送）。
          </Text>
        </Space>
      )}
    </Card>
  )
}

/** 记忆健康仪表盘（面板；数据源 GET /memory，聚合口径见 engine/memory.ts）。
 * jol 全局开关 + 抽样率（#66 E4，#72 补 rate 输入）与面板同区：关闭后复习流
 * 完全不弹预测，已攒的校准数据保留。hints = 过信轻提示全局开关（ADR-0022 #104），
 * 放 JOL 开关旁：关闭后队列不再带轻提示、抽查密度不再加强。 */
function MemoryHealthCard({ mem, jol, hints, onToggleJol, onRateJol, onToggleHints }: {
  mem: MemoryHealth | null
  jol: JolConfig | null
  hints: CalibrationHintsConfig | null
  onToggleJol: (enabled: boolean) => void
  onRateJol: (rate: number) => void
  onToggleHints: (enabled: boolean) => void
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
    </Card>
  )
}

/** 自评校准画像卡（ADR-0022 #104；数据源 GET /calibration/profile）：
 * 分源视图为主（v1 源 = JOL 预测 × 实际作答；构念效度：域特异成分显著），
 * 全局聚合折叠为参考视图并带「域特异」警戒标注；过信检出时给证据说明。
 * 画像只展示给学习者——不进 Mastery/XP，永不折扣自评对调度的驱动（红线）。 */
function CalibrationProfileCard({ profile }: { profile: CalibrationProfileDoc | null }) {
  if (profile === null) {
    return (
      <Card size='small' title='自评校准画像' style={{ borderRadius: 10 }}>
        <Text type='secondary'>加载中…</Text>
      </Card>
    )
  }
  const SOURCE_LABEL: Record<string, string> = { jol: '源：JOL 预测 × 实际作答' }
  return (
    <Card size='small' title='自评校准画像' style={{ borderRadius: 10 }}
      extra={<Text type='secondary' style={{ fontSize: 12 }}>分源自省面——只展示给你的画像，不进任何成绩度量</Text>}>
      <Space direction='vertical' style={{ width: '100%' }} size={14}>
        {profile.sources.map(s => (
          <div key={s.source}>
            <Space size={8} style={{ marginBottom: 4 }}>
              <Text style={{ fontWeight: 600 }}>{SOURCE_LABEL[s.source] ?? `源：${s.source}`}</Text>
              {s.overconfidence.overconfident && s.overconfidence.evidence && (
                <Tag size='small' color='orange'>系统性过信</Tag>
              )}
            </Space>
            {s.calibration ? (
              <>
                <Text type='secondary' style={{ fontSize: 12 }}>
                  （翻面前抽查预测「会/不会/没把握」与实际对错的对照，共 {s.calibration.pairs} 条配对；
                  只统计被抽到的卡，不代表全部复习）
                </Text>
                <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                  {s.calibration.bins.filter(b => b.n > 0).map(b => (
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
                {s.overconfidence.overconfident && s.overconfidence.evidence && (
                  <Alert type='warning' style={{ fontSize: 12, marginTop: 6 }}
                    content={`「会」档实际正确率 ${Math.round(s.overconfidence.evidence.accuracy * 100)}%（${s.overconfidence.evidence.n} 条抽查），低于显著阈值 ${Math.round(s.overconfidence.evidence.threshold * 100)}%——预测偏乐观：复习时不妨按「没把握」处理这些卡，预测出口也会轻提醒你。`} />
                )}
              </>
            ) : (
              <Text type='secondary' style={{ fontSize: 12, display: 'block' }}>
                {EMPTY_HINT}（该源的预测配对攒够 10 条后显示，低数据不造假曲线）
              </Text>
            )}
          </div>
        ))}
        {/* 全局聚合 = 参考视图：折叠次要展示，警戒标注必须随视图带出（ADR-0022 裁决 2） */}
        <Collapse bordered={false}>
          <Collapse.Item name='global' header={
            <Space size={6}>
              <Text type='secondary' style={{ fontSize: 12 }}>全局聚合（参考视图）</Text>
              <Tag size='small' color='gray'>域特异，仅供参考</Tag>
            </Space>
          }>
            <Text type='secondary' style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{profile.global.warning}</Text>
            {profile.global.calibration ? (
              <div style={{ display: 'grid', gap: 3 }}>
                {profile.global.calibration.bins.filter(b => b.n > 0).map(b => (
                  <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text type='secondary' style={{ fontSize: 11, width: 70, flexShrink: 0 }}>预测 {b.label}</Text>
                    <div style={{ flex: 1, height: 8, background: 'var(--color-fill-2,#f2f3f5)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{
                        width: `${(b.accuracy ?? 0) * 100}%`, height: '100%',
                        background: 'var(--color-fill-3,#e5e6eb)',
                      }} />
                    </div>
                    <Text style={{ fontSize: 11, width: 84, textAlign: 'right' }}>
                      实际 {b.accuracy === null ? '—' : `${Math.round(b.accuracy * 100)}%`}（{b.n} 条）
                    </Text>
                  </div>
                ))}
              </div>
            ) : (
              <Text type='secondary' style={{ fontSize: 12 }}>{EMPTY_HINT}</Text>
            )}
          </Collapse.Item>
        </Collapse>
      </Space>
    </Card>
  )
}

/** 周复盘 Weekly Kata（#114 U4 / ADR-0026）：全局每周一张的五问复盘。入口常驻
 * （统计页 = 周视图家），无推送、缺勤不罚；现状引擎自动填（只读渲染），四问
 * 学习者作答；「下一实验」一键转 N-of-1 提案（提案-确认制）或执行意图挂今日偏好。
 * Learner Output 域：零 XP、不进掌握度、不做 FSRS 卡。 */
function KataCard({ courseNames }: { courseNames: string[] }) {
  const [kata, setKata] = useState<KataDoc | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [exp, setExp] = useState<ExperimentsDoc | null>(null)
  const [expTpl, setExpTpl] = useState<string | undefined>()
  const [expCourse, setExpCourse] = useState<string | undefined>()
  const [expModal, setExpModal] = useState(false)
  const [intModal, setIntModal] = useState(false)
  const [iCourse, setICourse] = useState<string | undefined>()
  const [iNode, setINode] = useState('')
  const [iCue, setICue] = useState('')
  const [iAct, setIAct] = useState('')

  const load = useCallback(async (week?: string) => {
    try {
      const doc = await api.kataOpen(week)
      setKata(doc)
      setAnswers(Object.fromEntries(KATA_ANSWER_KEYS.map(q => [q, doc.sections[q] === KATA_PLACEHOLDER ? '' : doc.sections[q] ?? ''])))
    } catch (err) {
      toastError(err)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!kata) return
    setSaving(true)
    try {
      const doc = await api.kataSave(kata.week_start, answers)
      setKata(doc)
      Message.success(doc.answered ? '四问已齐——本周复盘完成' : '已保存（还有未答的问）')
    } catch (err) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const convertExperiment = async () => {
    if (!kata || !expTpl) return
    try {
      const r = await api.kataConvertExperiment(kata.week_start, expTpl, expCourse)
      Message.success(`实验提案 #${r.proposal} 已发起——到实验室页确认后开跑`)
      setExpModal(false)
      await load(kata.week_start)
    } catch (err) {
      toastError(err)
    }
  }

  const convertIntention = async () => {
    if (!kata || !iCourse || !iNode.trim() || !iCue.trim() || !iAct.trim()) return
    try {
      await api.kataConvertIntention(kata.week_start, iCourse, iNode.trim(), iCue.trim(), iAct.trim())
      Message.success('执行意图已挂上今天的目标偏好（学习日日界后过期）')
      setIntModal(false)
      await load(kata.week_start)
    } catch (err) {
      toastError(err)
    }
  }

  return (
    <Card
      size='small' title='周复盘 · 五问' style={{ borderRadius: 10 }}
      extra={kata && (
        <Space size={8}>
          <Select size='mini' value={kata.week_start} onChange={v => void load(v)} style={{ width: 130 }}
            placeholder='选择周'>
            {(kata.list.map(x => x.week_start).includes(kata.week_start)
              ? kata.list.map(x => x.week_start)
              : [kata.week_start, ...kata.list.map(x => x.week_start)]
            ).map(w => <Select.Option key={w} value={w}>{w} 那周</Select.Option>)}
          </Select>
          <Tag color={kata.answered ? 'green' : 'gray'} size='small'>{kata.answered ? '四问已齐' : '待作答'}</Tag>
        </Space>
      )}>
      {kata === null ? <Text type='secondary'>加载中…</Text> : (
        <div style={{ display: 'grid', gap: 10 }}>
          <Text type='secondary' style={{ fontSize: 12 }}>
            复盘对象：{kata.week_start} ~ {kata.week_end}（上一完整学习周，凌晨学习日按日界归属）·
            记录落「我的产出/周复盘」，零 XP、可注册为复习源；无推送、缺勤不罚。
          </Text>
          <Collapse bordered={false} defaultActiveKey={['status']}>
            <Collapse.Item name='status' header='现状（引擎自动填）'>
              <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{kata.reality}</pre>
            </Collapse.Item>
          </Collapse>
          {KATA_ANSWER_KEYS.map(q => (
            <div key={q} style={{ display: 'grid', gap: 4 }}>
              <Text style={{ fontSize: 12, fontWeight: 600 }}>
                {q}{q === '下一实验' && <Text type='secondary' style={{ fontSize: 11 }}>（自由文本；可一键转实验提案或执行意图）</Text>}
              </Text>
              <Input.TextArea
                value={answers[q] ?? ''}
                placeholder={q === '目标条件' ? '上一周你想要达成什么？' : q === '障碍' ? '什么挡住了你？' : q === '下一实验' ? '下周试一个小改变' : '如果实验有效，你会看到什么？'}
                onChange={v => setAnswers(a => ({ ...a, [q]: v }))}
                autoSize={{ minRows: 2, maxRows: 6 }}
              />
            </div>
          ))}
          <Space size={8} wrap>
            <Button size='small' type='primary' loading={saving} onClick={() => void save()}>保存四问</Button>
            <Button size='small' disabled={!answers['下一实验']?.trim()} onClick={() => { void api.experiments().then(setExp).catch(() => setExp(null)); setExpModal(true) }}>转 N-of-1 提案</Button>
            <Button size='small' disabled={!answers['下一实验']?.trim()} onClick={() => setIntModal(true)}>转执行意图</Button>
          </Space>
        </div>
      )}
      <Modal
        title='「下一实验」转 N-of-1 实验提案' visible={expModal}
        onCancel={() => setExpModal(false)}
        footer={null}>
        <div style={{ display: 'grid', gap: 10 }}>
          <Text type='secondary' style={{ fontSize: 12 }}>
            发起的是待确认提案（提案-确认制）：到实验室页确认后才开跑。实验变量只允许引擎可控的内容参数。
          </Text>
          <Select placeholder='选择实验模板' value={expTpl} onChange={setExpTpl} style={{ width: '100%' }}>
            {(exp?.templates ?? []).filter(t => t.unlocked).map(t => (
              <Select.Option key={t.id} value={t.id}>{t.title}</Select.Option>
            ))}
          </Select>
          <Select placeholder='范围：全部课程' value={expCourse} onChange={setExpCourse} allowClear style={{ width: '100%' }}>
            {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Button type='primary' disabled={!expTpl} onClick={() => void convertExperiment()}>发起提案</Button>
        </div>
      </Modal>
      <Modal
        title='「下一实验」转执行意图' visible={intModal}
        onCancel={() => setIntModal(false)}
        footer={null}>
        <div style={{ display: 'grid', gap: 10 }}>
          <Text type='secondary' style={{ fontSize: 12 }}>
            「在【稳定线索】之后做【单一具体行动】」——挂上今天的目标偏好（推荐榜首），随当前学习日过期（日界后失效）。
          </Text>
          <Select placeholder='课程' value={iCourse} onChange={setICourse} style={{ width: '100%' }}>
            {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Input placeholder='节点名（如：入门）' value={iNode} onChange={setINode} />
          <Input placeholder='线索（时间/地点锚，如：早上刷完牙后）' value={iCue} onChange={setICue} />
          <Input placeholder='单一具体行动（如：做 5 道到期复习）' value={iAct} onChange={setIAct} />
          <Button type='primary' disabled={!iCourse || !iNode.trim() || !iCue.trim() || !iAct.trim()} onClick={() => void convertIntention()}>挂今日执行意图</Button>
        </div>
      </Modal>
    </Card>
  )
}

export default function StatsPage({ frame }: { frame: AppFrame }) {
  const [xp, setXp] = useState<XpStatus | null>(null)
  const [mem, setMem] = useState<MemoryHealth | null>(null)
  const [goal, setGoal] = useState<number>(30)
  const [saving, setSaving] = useState(false)
  const [jol, setJol] = useState<JolConfig | null>(null)
  const [hints, setHints] = useState<CalibrationHintsConfig | null>(null)
  const [profile, setProfile] = useState<CalibrationProfileDoc | null>(null)
  const [coach, setCoach] = useState<CoachDoc | null>(null)

  const load = useCallback(async () => {
    const doc = await api.xp().catch(() => null)
    setXp(doc)
    if (doc) setGoal(doc.goal)
    setMem(await api.memory().catch(() => null))
    setJol(await api.jol().catch(() => null))
    setHints(await api.calibrationHints().catch(() => null))
    setProfile(await api.calibrationProfile().catch(() => null))
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

  // E4 抽样率（#72）：0<r≤1，即时保存（InputNumber 步进点击逐次触发）
  const rateJol = async (rate: number) => {
    if (!Number.isFinite(rate) || rate <= 0) return
    try {
      setJol(await api.setJol({ rate }))
    } catch (err) {
      toastError(err)
    }
  }

  // 过信轻提示全局开关（ADR-0022 #104）：关掉后预测出口不再轻提醒、抽查密度不再加强
  const toggleHints = async (enabled: boolean) => {
    try {
      setHints(await api.setCalibrationHints(enabled))
      Message.success(enabled ? '过信轻提示已开启' : '过信轻提示已关闭：预测出口不再提醒，抽查密度恢复默认')
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
      <KataCard courseNames={frame.tree?.courses.map(c => c.name) ?? []} />
      <MemoryHealthCard mem={mem} jol={jol} hints={hints}
        onToggleJol={enabled => void toggleJol(enabled)}
        onRateJol={rate => void rateJol(rate)}
        onToggleHints={enabled => void toggleHints(enabled)} />
      <CalibrationProfileCard profile={profile} />
      <AnkiChannelCard />

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
              <Text type='secondary' style={{ fontSize: 12 }}>连续学习天数（漏 {xp.streak_grace_days} 天不断）</Text>
            </div>
            <div>
              <Text style={{ fontWeight: 600, fontSize: 18 }}>{xp.goal}</Text>
              <Text type='secondary' style={{ fontSize: 12 }}>每日目标 XP</Text>
            </div>
          </Space>
        )}
      </Card>

      <Card size='small' title='课程状态总览' style={{ borderRadius: 10 }}>
        <Table size='small' data={frame.status?.courses ?? []} rowKey={c => c.id ?? c.name} pagination={false}
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
