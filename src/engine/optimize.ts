/**
 * FSRS 参数优化器（#62 A2 / ADR-0012）：从真实复习日志重训 FSRS-6（21 参数）。
 *
 * ts-fsrs 无优化器导出；fsrs-rs 优化器经官方 `@open-spaced-repetition/binding`
 * （napi 原生 + WASI 双形态，public beta——API 可能变）接入。对 binding 的全部
 * 引用隔离在本文件：类型变了只改这里，门禁与写回逻辑不动。
 *
 * 数据契约：输入 = state/review-log.jsonl 的真实推进（auto/self；synthetic 是调度
 * 初始化不是作答，一律排除）；每卡每天只取第一条（官方口径，引擎不变量的防御性
 * 归一）；首复习 delta_t=0（binding 契约）。binding 训练集形状 = 「每次复习一个
 * item、带完整前缀」（FSRSItem 的语义，与 Anki revlog 转换一致），由 expand 前缀
 * 展开产出。
 *
 * 门禁（评估不优于现参/默认不写回）：训练目标本身是最小化 logLoss，in-sample
 * 对照必须同协议才公平——binding 的时序切分评估（evaluateWithTimeSeriesSplits）
 * 只评「刚训出的模型」，不能对给定参数做切分评估；因此写回判定用 FSRSBinding
 * 的 in-sample evaluate 对新参/基线各评一次（同一协议），时序切分指标作为泛化
 * 估计随元数据落盘（小数据下 binding 会 NotEnoughData，缺失时记 null）。
 */
import { generatorParameters } from 'ts-fsrs'
import { daysBetween, parseDay, dayOfTs } from './dates.ts'
import { sourceKeyOf } from './types.ts'
import type { ReviewRec } from './types.ts'

/** 写回门禁：真实复习日志条数下限（官方口径：Anki 24.04 要求 ≥400，月频重训足够）。 */
export const OPTIMIZE_MIN_REVIEWS = 400
/** 执行事件混训门（ADR-0018 裁决 4）：review-log 里 rating_source='execution' 的条数
 * 达到该门后，执行事件放行进训练序列与题目事件混训；此前保持排除——两套数据起步
 * 各自都难过门禁，起步即混训等于让题目侧小样本被异质事件稀释（冷启动双盲）。 */
export const EXECUTION_TRAINING_GATE = 400
/** FSRS-6 参数向量长度；binding 返回非此长度视为契约破裂，拒绝写回。 */
export const FSRS6_PARAM_COUNT = 21

/** 一张卡的训练序列：rating 1-4（按时间序），首条 delta_t=0，其后为距上次的间隔天数。 */
export interface TrainingSequence {
  /** 卡标识（course/node/qid），诊断与测试消费。 */
  key: string
  reviews: Array<{ rating: number; delta_t: number }>
}

/** 评估指标（binding ModelEvaluation 的同形快照）。 */
export interface OptimizerMetrics { logLoss: number; rmseBins: number }

/** 真实推进 → 每卡训练序列（纯函数，接缝 S27）：排除 synthetic 与未过混训门的
 * execution、每卡每天取第一条、delta_t 链首条 0；序列按 key 排序保证确定序。
 * 「天」= 学习日（ADR-0020）。 */
export function trainingSequences(logs: ReviewRec[], cutoffMin = 0): TrainingSequence[] {
  let executionRows = 0
  for (const rec of logs) if (rec.rating_source === 'execution') executionRows++
  const allowExecution = executionRows >= EXECUTION_TRAINING_GATE
  const byCard = new Map<string, ReviewRec[]>()
  for (const rec of logs) {
    const ok = rec.rating_source === 'auto' || rec.rating_source === 'self'
      || (allowExecution && rec.rating_source === 'execution')
    if (!ok) continue
    const key = sourceKeyOf(rec.course, rec.node, rec.qid)
    const list = byCard.get(key) ?? []
    list.push(rec)
    byCard.set(key, list)
  }
  const out: TrainingSequence[] = []
  for (const [key, list] of byCard) {
    list.sort((a, b) => a.ts.localeCompare(b.ts))
    const reviews: Array<{ rating: number; delta_t: number }> = []
    let lastDay: string | null = null
    for (const rec of list) {
      const day = dayOfTs(rec.ts, cutoffMin)
      if (!day) continue
      if (day === lastDay) continue // 每卡每天只算第一条（防御性归一；引擎不变量本就至多一次）
      const delta = lastDay === null ? 0
        : Math.max(0, daysBetween(parseDay(day)!, parseDay(lastDay)!)) // day/lastDay 已过 dayOfTs 守卫（上方 !day continue）
      reviews.push({ rating: rec.rating, delta_t: delta })
      lastDay = day
    }
    if (reviews.length) out.push({ key, reviews })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** 训练序列总条数（写回门禁的计数口径）。 */
export function sequenceReviews(seqs: TrainingSequence[]): number {
  return seqs.reduce((s, x) => s + x.reviews.length, 0)
}

// ---- binding 封装（本文件唯一的动态 import 点；native 模块不可打包，构建侧 external）----

type BindingModule = typeof import('@open-spaced-repetition/binding')

let bindingPromise: Promise<BindingModule> | null = null
function loadBinding(): Promise<BindingModule> {
  bindingPromise ??= import('@open-spaced-repetition/binding')
  return bindingPromise
}

/** 前缀展开：每卡的复习序列 → 「每次复习一个 item、带完整前缀」的 binding 训练集。
 * 首复习（delta_t=0）只作前缀不作样本（enableShortTerm=false 时它本就不参与训练）。 */
async function expandToBindingItems(seqs: TrainingSequence[]): Promise<Array<InstanceType<BindingModule['FSRSBindingItem']>>> {
  const binding = await loadBinding()
  const items: Array<InstanceType<BindingModule['FSRSBindingItem']>> = []
  for (const seq of seqs) {
    const reviews = seq.reviews.map(r => new binding.FSRSBindingReview(r.rating, r.delta_t))
    for (let i = 1; i < reviews.length; i++) items.push(new binding.FSRSBindingItem(reviews.slice(0, i + 1)))
  }
  return items
}

/** 给定参数的 in-sample 评估（写回门禁的对照口径：新参/基线各评一次，同协议）。 */
export async function evaluateParams(parameters: number[], seqs: TrainingSequence[]): Promise<OptimizerMetrics> {
  const binding = await loadBinding()
  return { ...new binding.FSRSBinding(parameters).evaluate(await expandToBindingItems(seqs)) }
}

/** 训练 + 评估：computeParameters（对齐 srs.ts 日粒度语义）→ 时序切分指标
 * （泛化估计；binding 对小数据抛 NotEnoughData → 记 null，不阻塞门禁）。 */
export async function trainAndEvaluate(seqs: TrainingSequence[]): Promise<{ parameters: number[]; splitEval: OptimizerMetrics | null }> {
  const binding = await loadBinding()
  const items = await expandToBindingItems(seqs)
  const parameters = await binding.computeParameters(items, { enableShortTerm: false, numRelearningSteps: 0 })
  let splitEval: OptimizerMetrics | null = null
  try {
    splitEval = { ...await binding.evaluateWithTimeSeriesSplits(items, { enableShortTerm: false, numRelearningSteps: 0 }) }
  } catch {
    splitEval = null // 小数据下时序切分不可用：门禁退回 in-sample 对照，元数据如实记 null
  }
  return { parameters, splitEval }
}

/** FSRS-6 官方默认参数（无现参文件的对照基线）。 */
export function defaultParams(): number[] {
  return [...generatorParameters({}).w]
}

/** 优化器实现接缝：facade 门禁/写回逻辑用它跑训练与对照评估，测试注入假实现。 */
export interface OptimizerImpl {
  train: (seqs: TrainingSequence[]) => Promise<{ parameters: number[]; splitEval: OptimizerMetrics | null }>
  evaluate: (parameters: number[], seqs: TrainingSequence[]) => Promise<OptimizerMetrics>
}

/** 默认实现 = binding 封装。 */
export const bindingImpl: OptimizerImpl = { train: trainAndEvaluate, evaluate: evaluateParams }
