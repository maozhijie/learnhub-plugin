/**
 * 推进内核（ADR-0014 / CONTEXT「推进 Advance」）：一卡一日的调度推进机械收口。
 *
 * 只拥有机械——「当日已推进」判定、FSRS 当日重算、复习日志快照束（elapsed_days +
 * S/D 前快照 + r_pred）、作答统计合并。评分语义（自动判定 / 复习自评 / 合成初始化）
 * 与账本组合是 ADR-0006 保护的语义面，留在调用方。纯函数：不读钟、不碰存储，
 * scheduler 注入；day 参数化（Anki 回填按事件日）。
 *
 * guard 是两个有名概念（ADR-0014）：真实推进判定 `alreadyAdvanced`（stats.last，
 * 合成初始化不占当日额度）守学习者通道；vault 调度动作判定 `alreadyScheduledOn`
 * （stats.last || fsrs.last_review）守 Anki 回放通道。
 */
import type { FSRS } from 'ts-fsrs'
import type { FsrsBlock } from './types.ts'
import { applyRatingBlock, retrievabilityBlock } from './srs.ts'

/** 任何自带 FSRS 隔离调度块的卡的最小投影：题卡 / 笔记源镜像卡 / 我的卡 / Anki 内存卡同构。 */
export interface AdvanceCard {
  fsrs?: FsrsBlock | null
  stats?: { attempts?: number; correct?: number; last?: string } | null
}

/** 真实推进判定：当日已有真实互动（作答/忘记/自评结算/回填）。合成初始化不算。 */
export function alreadyAdvanced(card: AdvanceCard, day: string): boolean {
  return card.stats?.last === day
}

/** vault 当日已有调度动作（真实推进或合成初始化）：Anki 回放通道的守门。 */
export function alreadyScheduledOn(card: AdvanceCard, day: string): boolean {
  return card.stats?.last === day || card.fsrs?.last_review === day
}

/** 复习日志的调度侧快照束：身份（course/node/qid）、rating、rating_source、ts 由调用方补。 */
export interface AdvanceLog {
  elapsed_days: number
  stability_before: number | null
  difficulty_before: number | null
  r_pred: number
}

interface PushedResult {
  fs: FsrsBlock
  stats: { attempts: number; correct: number; last: string }
  log: AdvanceLog
}

export type AdvanceResult =
  | ({ advanced: true } & PushedResult)
  | { advanced: false; reason: 'already-advanced'; stats: PushedResult['stats'] }

/** 推进通道：learner = 学习者真实互动（真实推进判定把守）；anki = 镜象回放（vault 调度动作判定把守）。 */
export type AdvanceChannel = 'learner' | 'anki'

/** 统计合并由 rating 推导（correct = rating > 1）——与题卡/我的卡/回填事件全部现有口径一致。 */
function mergedStats(card: AdvanceCard, rating: 1 | 2 | 3 | 4, day: string): PushedResult['stats'] {
  return {
    attempts: (card.stats?.attempts ?? 0) + 1,
    correct: (card.stats?.correct ?? 0) + (rating > 1 ? 1 : 0),
    last: day,
  }
}

/** 守门推进：guard 命中 → 不碰卡（stats 合并照给——练习流同日重复作答仍只记统计不推卡）；
 * 否则按 rating 推进 FSRS 并返回新卡状态与快照束。永不 throw。 */
export function advance(
  sched: FSRS, card: AdvanceCard, rating: 1 | 2 | 3 | 4, day: string,
  channel: AdvanceChannel = 'learner',
): AdvanceResult {
  const blocked = channel === 'anki' ? alreadyScheduledOn(card, day) : alreadyAdvanced(card, day)
  if (blocked) return { advanced: false, reason: 'already-advanced', stats: mergedStats(card, rating, day) }
  return { advanced: true, ...pushCard(sched, card, rating, day) }
}

/** 交互单发形态：guard 冲突即抛调用方给的文案（各入口的报错措辞是测试契约）。 */
export function advanceStrict(
  sched: FSRS, card: AdvanceCard, rating: 1 | 2 | 3 | 4, day: string,
  message: string, channel: AdvanceChannel = 'learner',
): PushedResult {
  const r = advance(sched, card, rating, day, channel)
  if (!r.advanced) throw new Error(message)
  return r
}

/** 挂起结算形态：无守门——准入是调用方的 pending_rating 旗标（同日合法的预留二次推进），
 * 只复习流自评结算使用。 */
export function advancePending(sched: FSRS, card: AdvanceCard, rating: 1 | 2 | 3 | 4, day: string): PushedResult {
  return pushCard(sched, card, rating, day)
}

/** 无条件推进原语：快照束取推卡前状态，stats 合并由 rating 推导。 */
function pushCard(sched: FSRS, card: AdvanceCard, rating: 1 | 2 | 3 | 4, day: string): PushedResult {
  const rPred = retrievabilityBlock(sched, card.fsrs ?? null, day)
  const pushed = applyRatingBlock(card.fsrs ?? null, rating, day, sched)
  return {
    fs: pushed.fs,
    log: {
      elapsed_days: pushed.elapsed_days,
      stability_before: card.fsrs?.stability ?? null,
      difficulty_before: card.fsrs?.difficulty ?? null,
      r_pred: rPred,
    },
    stats: mergedStats(card, rating, day),
  }
}
