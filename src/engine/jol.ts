/**
 * E4 预测-校准 JOL（决议 #49 修订 / 实施工单 #66）：复习流作答前一档三点预测
 * （会/不会/没把握）+ 校准曲线。抽查抽样不逐卡——默认约 1/3 复习卡弹预测，选卡
 * 优先「有信息价值」（到期边界 R∈[0.5,0.85]、难度中段 ≈2、曾有预测−结果偏差），
 * 其余随机补齐；预测可忽略、可全局关闭。判定只入作答流水的元标注（Learner
 * Output，ADR-0009）——不喂 canonical、不进掌握度/XP。零依赖纯函数（接缝 S30）。
 */
import type { PracticeRec } from './types.ts'
import { sourceKeyOf } from './types.ts'

/** 一档三点预测（题面出示后、翻面前作答）。 */
export type JolPrediction = '会' | '不会' | '没把握'
export const JOL_PREDICTIONS: JolPrediction[] = ['会', '不会', '没把握']

/** 抽样率：默认约 1/3 复习卡（可配、可关）。 */
export const JOL_SAMPLE_RATE = 1 / 3

/** 校准曲线的数据门槛：配对数不足不显示（低数据静默，不造假曲线）。 */
export const JOL_CALIBRATION_MIN = 10

/** 抽查候选卡（reviewQueue 的卡片投影：key = 「课程/节点/题id」复合键 + 当前 R + 静态难度）。 */
export interface JolCandidate { key: string; r: number; difficulty?: number }

/** 抽查选卡：返回本批要弹预测的卡 key 集合（约 ⌈rate × 总数⌉ 张）。
 * 优先「有信息价值」：曾有预测−结果偏差 +3（优先重探）、到期边界 R∈[0.5,0.85]
 * （将忘未忘、翻车高发）+2、静态难度中段 ≈2（非送分非绝望）+1；同分按注入的
 * rng 抖动随机补齐，保证抽样覆盖不同 R/难度段。 */
export function pickJolTargets(
  cards: JolCandidate[], rng: () => number,
  opts?: { rate?: number; deviated?: Set<string> },
): Set<string> {
  const rate = opts?.rate ?? JOL_SAMPLE_RATE
  const deviated = opts?.deviated ?? new Set<string>()
  if (!cards.length) return new Set()
  const scored = cards.map((c, i) => {
    let s = 0
    if (deviated.has(c.key)) s += 3
    if (c.r >= 0.5 && c.r <= 0.85) s += 2
    if (c.difficulty === 2) s += 1
    return { key: c.key, s, jitter: rng(), i }
  })
  scored.sort((a, b) => b.s - a.s || a.jitter - b.jitter || a.i - b.i)
  const n = Math.min(cards.length, Math.max(1, Math.ceil(cards.length * rate)))
  return new Set(scored.slice(0, n).map(x => x.key))
}

/** 曾出现预测−结果偏差的题（高估：预测「会」却错/忘记；低估：预测「不会」却答对）
 * ——校准最该重探的位置；「没把握」预测无论结果都不算偏差。
 * 键 = 「course/node/qid」复合键（qid 只在节点题库内唯一，跨节点会撞名）。 */
export function jolDeviatedKeys(recs: PracticeRec[]): Set<string> {
  const out = new Set<string>()
  for (const r of recs) {
    if (!r.qid || !r.predicted || typeof r.correct !== 'boolean') continue
    if ((r.predicted === '会') !== r.correct) out.add(sourceKeyOf(r.course, r.node, r.qid))
  }
  return out
}

export interface JolBin { label: JolPrediction; n: number; accuracy: number | null; forgot: number }

/** 预测-校准曲线：由 (predicted, 实际对/错/忘记) 逐条配对聚合——每个预测档内的
 * 实际答对率与忘记数。配对数不足门槛返回 null（不显示）。只展示给学习者、
 * 不喂 canonical；曲线反映被抽查的卡片群体（UI 注明）。 */
export function jolCalibration(recs: PracticeRec[]): { pairs: number; bins: JolBin[] } | null {
  const hit = recs.filter(r => r.predicted != null && typeof r.correct === 'boolean')
  if (hit.length < JOL_CALIBRATION_MIN) return null
  const round3 = (x: number) => Math.round(x * 1000) / 1000
  const bins: JolBin[] = JOL_PREDICTIONS.map(label => {
    const bin = hit.filter(r => r.predicted === label)
    return {
      label,
      n: bin.length,
      accuracy: bin.length ? round3(bin.filter(r => r.correct === true).length / bin.length) : null,
      forgot: bin.filter(r => r.judge === 'forget').length,
    }
  })
  return { pairs: hit.length, bins }
}
