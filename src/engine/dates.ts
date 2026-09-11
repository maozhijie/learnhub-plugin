/**
 * 日期工具：引擎内全部日期以本地日（YYYY-MM-DD）为粒度（旧引擎 date.today() 语义）。
 * 与 ts-fsrs 交互时统一转 UTC 当日零点（旧引擎 _utc 的等价物），保证日粒度计算稳定。
 *
 * 学习日/日界（ADR-0020）：调度、结算与「今日」视图的日界是可配置的本地时刻
 * （默认 02:00），凌晨落在日界之前的时间归属前一学习日。cutoffMin 参数 = 日界的
 * 当日分钟数；cutoffMin=0 恒等旧午夜口径（回归基线）。出处戳（generated_at 等）
 * 不属于学习口径，继续用日历日。
 */

/** 本地今日 → 'YYYY-MM-DD'（学习日口径：减去日界后取本地日分量）。 */
export function todayStr(now: Date = new Date(), cutoffMin = 0): string {
  const t = cutoffMin ? new Date(now.getTime() - cutoffMin * 60000) : now
  const y = t.getFullYear()
  const m = String(t.getMonth() + 1).padStart(2, '0')
  const d = String(t.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 本地 ISO 时间戳（nowIso 形态）→ 学习日 'YYYY-MM-DD'。cutoffMin=0 恒等 ts 前 10 位。 */
export function dayOfTs(ts: string, cutoffMin = 0): string {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return ts.slice(0, 10) // 非 nowIso 形态：退化为日历日切片
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - cutoffMin * 60000)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${day}`
}

/** 'HH:mm' → 当日分钟数（00:00–23:59 全开）；非法返回 null，回落策略归配置层。 */
export function parseCutoff(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h > 23 || min > 59 ? null : h * 60 + min
}

/** 分钟数 → 'HH:mm'（views 暴露生效日界用）。 */
export function fmtCutoff(cutoffMin: number): string {
  const h = String(Math.floor(cutoffMin / 60)).padStart(2, '0')
  const m = String(cutoffMin % 60).padStart(2, '0')
  return `${h}:${m}`
}

/** 'YYYY-MM-DD' → Date（UTC 当日零点；不可解析返回 null）。 */
export function parseDay(s: string | null | undefined): Date | null {
  if (!s || typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) {
    const t = Date.parse(s.trim())
    return Number.isNaN(t) ? null : new Date(Math.floor(t / 86400000) * 86400000)
  }
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
}

/** Date → 'YYYY-MM-DD'（取 UTC 日分量；输入应来自 parseDay 或 ts-fsrs 的日边界）。 */
export function fmtDay(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** a - b 的天数（两侧均按 UTC 日零点语义）。 */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000)
}

/** 'YYYY-MM-DD' + n 天 → 'YYYY-MM-DD'（维持节拍帽等日粒度推移；不可解析输入返回 null）。 */
export function addDays(s: string | null | undefined, n: number): string | null {
  const d = parseDay(s)
  if (!d) return null
  return fmtDay(new Date(d.getTime() + n * 86400000))
}

/** ISO 时间戳（秒精度，journal/practice 流水用）。 */
export function nowIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ---- 学习周折叠（ADR-0026 裁决 2：日历周按学习日折叠；#152 刀 1 自 kata.ts 归位
// ——纯日历语义住日历模块，sediment 等消费方回引此处不构成对复盘层的反向依赖）----

/** 'YYYY-MM-DD' → 所在日历周的周一（UTC 日算术；解析失败 null）。 */
export function weekStartOf(day: string): string | null {
  const d = parseDay(day)
  if (!d) return null
  const shift = (d.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  return fmtDay(new Date(d.getTime() - shift * 86400000))
}

/** 周一 → 周日（+6 天）。 */
export function weekEndOf(weekStart: string): string | null {
  const d = parseDay(weekStart)
  return d ? fmtDay(new Date(d.getTime() + 6 * 86400000)) : null
}

/** 相对 today 的上一完整学习周周一（today 所在周的周一往前推 7 天）。 */
export function prevWeekStartOf(today: string): string | null {
  const cur = weekStartOf(today)
  if (!cur) return null
  const d = parseDay(cur)!
  return fmtDay(new Date(d.getTime() - 7 * 86400000))
}

/** 学习日是否落在 [weekStart, weekEnd]（字符串字典序即日序）。 */
export function inWeek(day: string, weekStart: string, weekEnd: string): boolean {
  return day >= weekStart && day <= weekEnd
}
