/**
 * 日期工具：引擎内全部日期以本地日（YYYY-MM-DD）为粒度（旧引擎 date.today() 语义）。
 * 与 ts-fsrs 交互时统一转 UTC 当日零点（旧引擎 _utc 的等价物），保证日粒度计算稳定。
 */

/** 本地今日 → 'YYYY-MM-DD'。 */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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

/** ISO 时间戳（秒精度，journal/practice 流水用）。 */
export function nowIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
