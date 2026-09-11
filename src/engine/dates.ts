/**
 * 日期工具：引擎内全部日期以本地日（YYYY-MM-DD）为粒度（旧引擎 date.today() 语义）。
 * 与 ts-fsrs 交互时统一转 UTC 当日零点（旧引擎 _utc 的等价物），保证日粒度计算稳定。
 *
 * 学习日/日界（ADR-0020）：调度、结算与「今日」视图的日界是可配置的本地时刻
 * （默认 02:00），凌晨落在日界之前的时间归属前一学习日。cutoffMin 参数 = 日界的
 * 当日分钟数；cutoffMin=0 恒等旧午夜口径（回归基线）。出处戳（generated_at 等）
 * 不属于学习口径，继续用日历日。
 */

/** 日毫秒数（UTC 日算术常量；原 11 处字面量 86400000 的唯一出处）。 */
export const DAY_MS = 86400000

/** ISO 时间戳 → 日历日 'YYYY-MM-DD'（取前 10 位；出处戳/统计窗口径——不是学习日，
 * 学习口径用 dayOfTs 过日界。原 5 处散落的 `slice(0, 10)` 收敛于此单点）。 */
export function calendarDayOf(ts: string): string {
  return ts.slice(0, 10)
}

/** 本地今日 → 'YYYY-MM-DD'（学习日口径：减去日界后取本地日分量）。now 必填
 * （#175 阶段①：读「当前时刻」是适配器关注点——时钟经 Clock 端口注入后由调用方
 * 把时间戳换成 Date；本模块只做纯日历运算，不读时钟）。 */
export function todayStr(now: Date, cutoffMin = 0): string {
  const t = cutoffMin ? new Date(now.getTime() - cutoffMin * 60000) : now
  const y = t.getFullYear()
  const m = String(t.getMonth() + 1).padStart(2, '0')
  const d = String(t.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 本地 ISO 时间戳（nowIso 形态）→ 学习日 'YYYY-MM-DD'。cutoffMin=0 恒等 ts 前 10 位。 */
export function dayOfTs(ts: string, cutoffMin = 0): string {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return calendarDayOf(ts) // 非 nowIso 形态：退化为日历日切片
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
    return Number.isNaN(t) ? null : new Date(Math.floor(t / DAY_MS) * DAY_MS)
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
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

/** 'YYYY-MM-DD' + n 天 → 'YYYY-MM-DD'（维持节拍帽等日粒度推移；不可解析输入返回 null）。 */
export function addDays(s: string | null | undefined, n: number): string | null {
  const d = parseDay(s)
  if (!d) return null
  return fmtDay(new Date(d.getTime() + n * DAY_MS))
}

/** ISO 时间戳（秒精度，journal/practice 流水用）——从注入的时间戳渲染（#175 阶段①：
 * 读时钟收口到 Clock 端口，本函数是纯格式化，引擎内零时钟直读）。 */
export function nowIsoOf(ms: number): string {
  const d = new Date(ms)
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
  return fmtDay(new Date(d.getTime() - shift * DAY_MS))
}

/** 周一 → 周日（+6 天）。 */
export function weekEndOf(weekStart: string): string | null {
  const d = parseDay(weekStart)
  return d ? fmtDay(new Date(d.getTime() + 6 * DAY_MS)) : null
}

/** 相对 today 的上一完整学习周周一（today 所在周的周一往前推 7 天）。 */
export function prevWeekStartOf(today: string): string | null {
  const cur = weekStartOf(today)
  if (!cur) return null
  const d = parseDay(cur)!
  return fmtDay(new Date(d.getTime() - 7 * DAY_MS))
}

/** 学习日是否落在 [weekStart, weekEnd]（字符串字典序即日序）。 */
export function inWeek(day: string, weekStart: string, weekEnd: string): boolean {
  return day >= weekStart && day <= weekEnd
}
