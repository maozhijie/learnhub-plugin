/**
 * Self-Calibration 自评校准画像（ADR-0022，#104）：跨源「学习者自评档 × 同事件客观
 * 结果」配对画像——分源自省面（域特异成分显著），全局聚合只作参考视图并标注域特异
 * 警戒（ADR-0022 裁决 2）。
 *
 * 配对契约（裁决 1）：凡同一事件同时携带自评档与客观判分，即落一条配对（附源枚举
 * 与时间戳）。v1 单条配对不另落盘——自评档/客观分/时间戳的底数就是 practice 流水的
 * predicted/correct/ts 字段，源枚举在画像层标注；画像 v1 以聚合视图按源透出配对
 * 区间（first_ts/last_pair_ts），单条 ts 不在画像层展开。v1 吸收侧只有 jol（JOL 预测
 * × 实际作答）：机械上就是 practice 流水里
 * predicted != null 且有对错判分的记录——聚合直接调用 jol.ts 的 jolCalibration
 * （不 fork 数学），JOL_CALIBRATION_MIN 数据门槛静默沿用；后续源（执行事件随 #89、
 * 回执候选随 #88）按契约在此登记新源枚举与各自切片。
 *
 * 红线（裁决 5）：画像只读派生——永不折扣学习者自评对 canonical 的驱动（复习自评档
 * 原样推 FSRS）、不进 Mastery/XP、引擎不因画像静默改任何 canonical 写入。名词边界：
 * memory.ts 的 calibrationBins（FSRS r_pred × 实际保留率）是模型预测质量体检
 * （主体=引擎），不是画像域成员，永不混入。零依赖纯函数（接缝 S37）。
 */
import { JOL_CALIBRATION_MIN, jolCalibration } from './jol.ts'
import type { JolBin, JolPrediction } from './jol.ts'
import type { PracticeRec } from './types.ts'
import { CALIBRATION_OVERCONF_THRESHOLD } from './params.ts'

/** 配对源枚举（v1 只有 jol；#88/#89 扩展）。 */
export type CalibrationSource = 'jol'
export const CALIBRATION_SOURCES: readonly CalibrationSource[] = ['jol']

/** 源内系统性过信的证据快照（透出门槛 = 该档配对数 ≥JOL_CALIBRATION_MIN）。 */
export interface OverconfidenceEvidence {
  source: CalibrationSource
  /** 判定档位（v1 恒「会」——宣称接近确知而实际正确率持续偏低的档）。 */
  self: JolPrediction
  /** 该档配对数。 */
  n: number
  /** 该档实际正确率（jol 口径，3 位小数）。 */
  accuracy: number
  /** 判定阈值（CALIBRATION_OVERCONF_THRESHOLD；透出供面板说明口径）。 */
  threshold: number
}

export interface OverconfidenceVerdict {
  overconfident: boolean
  /** 数据足门槛时给出证据快照（无论检出与否）；不足门槛为 null（静默，不造假判定）。 */
  evidence: OverconfidenceEvidence | null
}

/** 域特异警戒文案（全局参考视图必须随视图带出；ADR-0022 裁决 2）。 */
export const CALIBRATION_GLOBAL_WARNING = '跨源聚合仅供参考：自评校准的域特异成分显著，以分源切片为准。'

/** 源内过信判定：「会」档在 ≥JOL_CALIBRATION_MIN 条配对下实际正确率持续低于显著
 * 阈值（v1 口径 = 该档聚合正确率，非滑动窗口）。数据不足门槛 → 静默（不检出、无证据）。 */
export function overconfidenceOf(recs: PracticeRec[]): OverconfidenceVerdict {
  const cal = jolCalibration(recs)
  if (!cal) return { overconfident: false, evidence: null }
  const bin = cal.bins.find(b => b.label === '会')
  if (!bin || bin.n < JOL_CALIBRATION_MIN || bin.accuracy === null) {
    return { overconfident: false, evidence: null }
  }
  return {
    overconfident: bin.accuracy < CALIBRATION_OVERCONF_THRESHOLD,
    evidence: {
      source: 'jol', self: '会', n: bin.n,
      accuracy: bin.accuracy, threshold: CALIBRATION_OVERCONF_THRESHOLD,
    },
  }
}

/** 画像聚合（分源切片 + 全局参考；只读派生，零落盘零 canonical 写入）。
 * 每源透出配对区间时间戳（first_ts/last_pair_ts = 该源配对集合最早/最晚一条的
 * PracticeRec.ts，ISO 字符串序取极值；零配对为 null）——schema 的时间戳元素在
 * 聚合层成立，单条配对 ts 不在此展开。v1 全局 = 单源合并的平凡情形；后续源接入后
 * 在此按 source 过滤各自配对再合并。 */
export function calibrationProfileView(recs: PracticeRec[]): {
  sources: Array<{
    source: CalibrationSource
    first_ts: string | null
    last_pair_ts: string | null
    calibration: { pairs: number; bins: JolBin[] } | null
    overconfidence: OverconfidenceVerdict
  }>
  global: { calibration: { pairs: number; bins: JolBin[] } | null; warning: string }
} {
  const sources = CALIBRATION_SOURCES.map(source => {
    // 配对集合的 ts 极值（只认同时携带自评档与客观判分的记录；字符串序即时间序，
    // practice 流水 ts 为同一 nowIso 产出）
    const tss = recs
      .filter(r => r.predicted != null && typeof r.correct === 'boolean')
      .map(r => r.ts)
    return {
      source,
      first_ts: tss.length ? tss.reduce((a, b) => (b < a ? b : a)) : null,
      last_pair_ts: tss.length ? tss.reduce((a, b) => (b > a ? b : a)) : null,
      // 机械复用 jol.ts 口径（配对元标注、聚合、JOL_CALIBRATION_MIN 门槛静默），不 fork 数学
      calibration: jolCalibration(recs),
      overconfidence: overconfidenceOf(recs),
    }
  })
  return {
    sources,
    global: { calibration: jolCalibration(recs), warning: CALIBRATION_GLOBAL_WARNING },
  }
}

/** 显式轻提示文案（呈现层出口消费；预期管理语气、非阻断）：过信检出才给，否则 null。 */
export function calibrationHintText(verdict: OverconfidenceVerdict): string | null {
  if (!verdict.overconfident || !verdict.evidence) return null
  const e = verdict.evidence
  return `你的「会」预测最近实际只对 ${Math.round(e.accuracy * 100)}%（${e.n} 条抽查）——翻面前不妨更保守一点，「没把握」也是正常预测；预测只是练习，会越用越准。`
}
