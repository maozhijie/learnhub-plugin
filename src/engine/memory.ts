/**
 * 记忆健康聚合（#61 A2 / ADR-0012）：统计页四面板的纯聚合口径——每日负载预报、
 * 记忆状态分布、真实保留率（True Retention，含预测 vs 真实对照）、按时点遗忘曲线。
 *
 * 数据源：跨课程题库 q.fsrs 快照（预报与状态分布）+ state/review-log.jsonl（保留率/
 * 校准/遗忘曲线）。诚实度不变量：合成首复习（synthetic）不是真实作答，一律排除；
 * 首学推进（无旧卡，stability_before 为空）不是「到期复习」，也不进保留率口径
 * （True Retention = 到期复习中实际答对的比例）。零依赖纯函数（接缝 S26）。
 */
import type { ReviewRec } from './types.ts'
import { DAY_MS, dayOfTs, fmtDay } from './dates.ts'
import { sourceKeyOf } from './types.ts'

/** 负载预报的时间窗（未来 N 日，Anki Forecast 语义；假设不再学新卡且不遗忘）。 */
export const FORECAST_DAYS = 30

/** 每日负载预报：逾期存量 + 未来 N 天逐日到期量（窗口外的远期 due 不计入逐日条）。 */
export function forecast(
  dues: string[], today: string, days = FORECAST_DAYS,
): { overdue: number; per_day: Array<{ d: string; count: number }> } {
  let overdue = 0
  const perDay = new Map<string, number>()
  for (const due of dues) {
    if (due < today) { overdue++; continue }
    perDay.set(due, (perDay.get(due) ?? 0) + 1)
  }
  const per_day: Array<{ d: string; count: number }> = []
  const base = new Date(`${today}T00:00:00Z`)
  for (let i = 0; i < days; i++) {
    const d = fmtDay(new Date(base.getTime() + i * DAY_MS)) // 逐日桶标签：日历日
    per_day.push({ d, count: perDay.get(d) ?? 0 })
  }
  return { overdue, per_day }
}

/** 状态分布直方图（跨课程已调度题聚合）：stability 按数量级分桶、difficulty 十分位刻、
 * retrievability 十分位。samples 由调用方用各课程自己的调度器现算（口径与 reviewQueue 一致）。 */
export function stateHistograms(samples: Array<{ stability: number | null; difficulty: number | null; r: number }>): {
  stability: Array<{ label: string; count: number }>
  difficulty: Array<{ label: string; count: number }>
  retrievability: Array<{ label: string; count: number }>
} {
  const stabBuckets: Array<[number, number, string]> = [
    [0, 1, '<1'], [1, 3, '1–3'], [3, 7, '3–7'], [7, 16, '7–16'], [16, 30, '16–30'],
    [30, 90, '30–90'], [90, 365, '90–365'], [365, Number.POSITIVE_INFINITY, '≥365'],
  ]
  const hist = (buckets: Array<[number, number, string]>, pick: (s: { stability: number | null; difficulty: number | null; r: number }) => number | null) =>
    buckets.map(([low, high, label]) => ({
      label,
      count: samples.filter(s => { const v = pick(s); return v !== null && v >= low && v < high }).length,
    }))
  return {
    stability: hist(stabBuckets, s => s.stability),
    difficulty: hist([[1, 3, '1–3 易'], [3, 5, '3–5 偏易'], [5, 7, '5–7 中'], [7, 9, '7–9 偏难'], [9, 11, '9–10 难']], s => s.difficulty),
    retrievability: hist([[0, 0.1, '0–10%'], [0.1, 0.2, '10–20%'], [0.2, 0.3, '20–30%'], [0.3, 0.4, '30–40%'], [0.4, 0.5, '40–50%'],
      [0.5, 0.6, '50–60%'], [0.6, 0.7, '60–70%'], [0.7, 0.8, '70–80%'], [0.8, 0.9, '80–90%'], [0.9, 1.01, '90–100%']], s => s.r),
  }
}

/** 保留率口径的复习日志过滤：只计真实作答（auto/self，排除 synthetic）且确有旧卡
 * （到期复习；首学推进排除）的记录，且每卡每天只取第一次推进（Anki 口径，防御性
 * 归一——引擎不变量本就一题一天至多推进一次）。「天」= 学习日（ADR-0020）。 */
export function dueReviewFirstPushes(logs: ReviewRec[], cutoffMin = 0): ReviewRec[] {
  const seen = new Set<string>()
  const out: ReviewRec[] = []
  for (const rec of logs) {
    if (rec.rating_source !== 'auto' && rec.rating_source !== 'self') continue
    if (rec.stability_before === null || rec.stability_before === undefined) continue
    const day = typeof rec.ts === 'string' ? dayOfTs(rec.ts, cutoffMin) : ''
    if (!day) continue
    const key = `${sourceKeyOf(rec.course, rec.node, rec.qid)}/${day}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rec)
  }
  return out
}

const round4 = (x: number) => Math.round(x * 10000) / 10000

/** 分桶通过率：rating≥2（答对含自评通过）记成功；空桶 null（空态，不造假数据）。 */
const passRate = (bin: ReviewRec[]): number | null =>
  bin.length ? round4(bin.filter(r => r.rating >= 2).length / bin.length) : null

/** 真实保留率（True Retention）：到期复习中实际答对的比例——答错与忘记（rating=1）
 * 记失败，答对含自评通过（rating≥2）记成功。无数据 rate=null（空态，不造假数据）。 */
export function trueRetention(dueReviews: ReviewRec[]): { pass: number; fail: number; rate: number | null; real: number } {
  let pass = 0
  for (const rec of dueReviews) if (rec.rating >= 2) pass++
  const real = dueReviews.length
  return { pass, fail: real - pass, rate: real ? round4(pass / real) : null, real }
}

/** 预测 vs 真实对照（校准曲线）：按复习时 FSRS 自预测 r_pred 分箱，对照箱内实际
 * 通过率。pred = 箱中点代表值（开尾箱取半程）。 */
export function calibrationBins(dueReviews: ReviewRec[]): Array<{ label: string; pred: number; actual: number | null; n: number }> {
  const edges: Array<[number, number, string]> = [
    [0, 0.5, '<50%'], [0.5, 0.6, '50–60%'], [0.6, 0.7, '60–70%'], [0.7, 0.8, '70–80%'],
    [0.8, 0.9, '80–90%'], [0.9, 1.01, '90–100%'],
  ]
  return edges.map(([low, high, label]) => {
    const bin = dueReviews.filter(r => r.r_pred !== null && r.r_pred !== undefined && r.r_pred >= low && r.r_pred < high)
    return { label, pred: round4((low + Math.min(high, 1)) / 2), actual: passRate(bin), n: bin.length }
  })
}

/** 按时点遗忘曲线：到期复习按间隔（elapsed_days，距上次推进的天数）分桶的保留率
 * 下降曲线。首桶含 0（同日推进的防御性兜底）。 */
export function forgettingCurve(dueReviews: ReviewRec[]): Array<{ label: string; n: number; rate: number | null }> {
  const edges: Array<[number, number, string]> = [
    [0, 3, '≤2 天'], [3, 6, '3–5 天'], [6, 10, '6–9 天'], [10, 15, '10–14 天'],
    [15, 31, '15–30 天'], [31, 61, '31–60 天'], [61, Number.POSITIVE_INFINITY, '>60 天'],
  ]
  return edges.map(([low, high, label]) => {
    const bin = dueReviews.filter(r => r.elapsed_days >= low && r.elapsed_days < high)
    return { label, n: bin.length, rate: passRate(bin) }
  })
}
