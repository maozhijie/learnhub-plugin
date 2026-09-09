/**
 * D-2 挑战点恒温器（#111 / ADR-0024）：跨区挑战点观测聚合 + 只读建议。
 *
 * ADR-0024 红线：恒温器 ≠ 自动控制器，写侧零自动调整——建议的采用走既有入口、
 * 逐条显式确认（apply 由学习者显式调用，引擎内没有任何自动执行路径）。观测量
 * 零新度量：课程区 = 真实保留率带 + 难度带长期选择分布（难度带.jsonl）；无界区 =
 * 执行事件评级分布（复习日志 rating_source='execution'，U 区落地前为合法空态）；
 * 项目区 = Mastery 交叉 2×2 + 档内表现，随 P-7（#96）后补、不阻塞 v1。旋钮 v1
 * 封顶三个：A1 目标难度带默认值（可确认生效）、检索点密度（随 #93 未上线）、
 * 渐退档移动提议聚合展示。不造综合「挑战分」。
 *
 * 零依赖纯函数（接口数据由门面注入）；阈值全部低数据静默。
 */
import type { BandPref } from './adaptive.ts'
import type { BandRec } from './coach.ts'
import type { ReviewRec } from './types.ts'

/** 长期观测窗口（天）：难度带选择分布与执行事件评级分布的回看窗。 */
export const THERMOSTAT_WINDOW_DAYS = 30

/** 建议触发的低数据门槛：窗口内带会话数 / 作答量、保留率真实推进量。 */
export const THERMOSTAT_MIN_SESSIONS = 6
export const THERMOSTAT_MIN_ANSWERED = 20
export const THERMOSTAT_MIN_RETENTION_N = 20

/** 保留率带口径（只读仪表展示）：与期望保留率 0.9 对照的三段式。 */
export function retentionBand(rate: number | null): { label: string; level: 'low' | 'mid' | 'high' | 'empty' } {
  if (rate === null) return { label: '无数据', level: 'empty' }
  if (rate >= 0.95) return { label: `很高（${Math.round(rate * 100)}%）——难度余量大`, level: 'high' }
  if (rate >= 0.75) return { label: `适中（${Math.round(rate * 100)}%）`, level: 'mid' }
  return { label: `偏低（${Math.round(rate * 100)}%）——当心的困难变成了受伤的困难`, level: 'low' }
}

/** 难度带长期选择分布（窗口内）：会话数、作答量、各带占比。 */
export function bandDistribution(
  recs: BandRec[], today: string, days = THERMOSTAT_WINDOW_DAYS,
): { sessions: number; answered: number; shares: Record<BandPref, number> } {
  const inWin = recs.filter(r => today >= r.date
    && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.date}T00:00:00Z`)) / 86400000 < days)
  const answered = inWin.reduce((s, r) => s + r.answered, 0)
  const count: Record<BandPref, number> = { easy: 0, standard: 0, hard: 0 }
  for (const r of inWin) count[r.band]++
  const n = inWin.length
  const shares: Record<BandPref, number> = {
    easy: n ? Math.round((count.easy / n) * 100) / 100 : 0,
    standard: n ? Math.round((count.standard / n) * 100) / 100 : 0,
    hard: n ? Math.round((count.hard / n) * 100) / 100 : 0,
  }
  return { sessions: n, answered, shares }
}

/** 无界区观测：执行事件评级分布（rating_source='execution'；U 区 #89 落地前恒空）。
 * 宽松读入——主分支的 rating_source 联合类型尚未含 'execution'，这里按字符串比对。 */
export function execRatingDistribution(logs: ReviewRec[], today: string, days = THERMOSTAT_WINDOW_DAYS): {
  count: number; by_rating: Record<number, number>
} {
  const by: Record<number, number> = {}
  let count = 0
  for (const rec of logs) {
    if ((rec.rating_source as string) !== 'execution') continue
    const day = rec.ts.slice(0, 10)
    if (today >= day && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000 >= days) continue
    count++
    by[rec.rating] = (by[rec.rating] ?? 0) + 1
  }
  return { count, by_rating: by }
}

/** 一条恒温器建议（只读；确认入口见 id 约定）。 */
export interface ThermostatSuggestion {
  /** 确认 id（learnhub_thermostat_apply 的入参）：'<knob>:<value>'。 */
  id: string
  knob: 'band_default'
  title: string
  /** 建议内容（给学习者读的话）。 */
  text: string
  /** 显式确认后的生效动作（既有配置入口；不确认永不生效）。 */
  apply: { config: 'band_default'; value: BandPref }
}

/** 恒温器建议（≤3 条；v1 唯一可确认旋钮 = A1 目标难度带默认值）。
 * 触发保守：低数据静默；同向不重复建议（当前默认已是目标值则沉默）。
 * 检索点密度 / 渐退档旋钮在 v1 无可确认参数，不出建议（仪表如实报状态）。 */
export function thermostatSuggestions(input: {
  retention: { rate: number | null; real: number }
  bands: { sessions: number; answered: number; shares: Record<BandPref, number> }
  defaultBand: BandPref | null
}): ThermostatSuggestion[] {
  const { retention, bands, defaultBand } = input
  if (retention.real < THERMOSTAT_MIN_RETENTION_N) return []
  if (bands.sessions < THERMOSTAT_MIN_SESSIONS || bands.answered < THERMOSTAT_MIN_ANSWERED) return []
  if (retention.rate === null) return []
  const out: ThermostatSuggestion[] = []
  // 长期择易 + 保留率很高 → 挑战带余量没被用上：建议默认带抬到标准。
  if (bands.shares.easy >= 0.8 && retention.rate >= 0.95 && defaultBand !== 'standard') {
    out.push({
      id: 'band_default:standard',
      knob: 'band_default',
      title: '目标难度带默认值',
      text: `最近 ${THERMOSTAT_WINDOW_DAYS} 天你的复习会话 ${Math.round(bands.shares.easy * 100)}% 都选了简单带，而到期复习的真实保留率高达 ${Math.round(retention.rate * 100)}%——「可用的困难」还有余量。要不要把会话的默认难度带设为「标准」？你随时可以在会话里显式选带覆盖默认。`,
      apply: { config: 'band_default', value: 'standard' },
    })
  }
  // 长期择难 + 保留率偏低 → 当心的困难在变成受伤的困难：建议默认带回落到标准。
  if (bands.shares.hard >= 0.8 && retention.rate < 0.75 && defaultBand !== 'standard') {
    out.push({
      id: 'band_default:standard',
      knob: 'band_default',
      title: '目标难度带默认值',
      text: `最近 ${THERMOSTAT_WINDOW_DAYS} 天你的复习会话 ${Math.round(bands.shares.hard * 100)}% 都在挑战带，但到期复习的真实保留率只有 ${Math.round(retention.rate * 100)}%——当心的困难正在变成受伤的困难。要不要把会话的默认难度带回落到「标准」？先回补前置与成分技能的到期复习也会有帮助。`,
      apply: { config: 'band_default', value: 'standard' },
    })
  }
  return out
}

/** 仪表（views 消费）：三区观测 + 三旋钮状态 + 建议清单。 */
export interface ThermostatDoc {
  date: string
  course_region: {
    retention: { pass: number; fail: number; rate: number | null; real: number }
    retention_band: { label: string; level: string }
    band_choices: { sessions: number; answered: number; shares: Record<BandPref, number> }
  }
  unbounded_region: {
    execution_ratings: { count: number; by_rating: Record<number, number> }
    note: string
  }
  project_region: {
    status: 'deferred'
    note: string
    projects: Array<{ id: string; name: string; tier: string }>
  }
  knobs: Array<{ knob: string; title: string; status: string; current?: string | null }>
  suggestions: ThermostatSuggestion[]
}
