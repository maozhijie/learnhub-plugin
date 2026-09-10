/**
 * D-3 沙盘（#112 / ADR-0025）：用现有 FSRS+mastery 模型对学习计划做蒙特卡洛推演
 * 的只读视图。不叫「预测」——JOL 预测与 FSRS 预测保留率已占坑；输出措辞锁死
 * 「模型推演，非承诺」。
 *
 * ADR-0025 红线：
 * 1. 模型与调度同源——R 用 srs.retrievabilityBlock，推进用 srs.applyRatingBlock，
 *    mastery 派生用 srs.masteryValue（与全端同一入口）；不引入任何新记忆模型。
 *    沙盘的诚实度上限就是现有模型，模型错了沙盘跟着错，这是特性。
 * 2. 抽样 = 可提取性 R 的伯努利（过 → Good、败 → Again），蒙特卡洛 SANDBOX_RUNS 次
 *    （约 200），RNG 播种确定。
 * 3. 零写侧——不进门禁、不进调度、不改账本；输出是分布不是承诺，支持计划谈判，
 *    不给可行性判定。
 *
 * 模拟口径（诚实假设，随输出返回）：
 * - 每次复习计 REVIEW_MIN 分钟（粗化）；预算耗尽后剩余到期卡顺延（R 继续衰减——
 *   与真实欠账一致）。
 * - 新节点按课程图序在预算内引入（est 分钟摊日），学成记一次合成 Good（与
 *   「完成学习」的合成初始化同语义），其休眠题同日入场。
 * - 练习证据（EMA/正确率）冻结为当前值——沙盘只模拟「记」的维持，不模拟「练」的进步。
 * - 节点代表卡与题目卡同为模拟卡：代表卡跟随本节点当日首次推进结果。
 *
 * 抽样与聚合为零依赖纯函数（依赖仅 ts-fsrs 的调度器闭包，由调用方注入）。
 */
import { applyRatingBlock, retrievabilityBlock, masteryValue } from './srs.ts'
import type { FSRS } from 'ts-fsrs'
import type { FsrsBlock } from './types.ts'
import { parseDay, fmtDay } from './dates.ts'

/** 单次复习的成本（分钟；粗化常数）。 */
export const REVIEW_MIN = 1
/** 蒙特卡洛次数（ADR-0025：约 200 次）。 */
export const SANDBOX_RUNS = 200
/** 输出措辞（锁死口径，ADR-0025）。 */
export const SANDBOX_WORDING = '模型推演，非承诺'
/** 默认推演时长（周）。 */
export const SANDBOX_DEFAULT_WEEKS = 6

/** 沙盘计划输入。 */
export interface SandboxPlan {
  /** 每日学习分钟目标。 */
  minutesPerDay: number
  /** 推演时长（周；默认 6）。 */
  weeks: number
}

/** 一张模拟卡（题目卡或节点代表卡）。fs=null = 未调度（随节点入场）。 */
export interface SandboxCard {
  key: string
  course: string
  node: string
  kind: 'question' | 'node'
  fs: FsrsBlock | null
}

/** 一个模拟节点（introduction 顺序由调用方按课程图序给定）。 */
export interface SandboxNode {
  course: string
  node: string
  /** 标称学习时长（分钟）；未标注按 15 计。 */
  est: number
  practice: { attempts: number; correct: number }
  ema?: number
  /** 起点已有调度状态（reps>0）→ 不再引入，只参与复习。 */
  started: boolean
  skipped: boolean
}

const dayShift = (today: string, days: number): string => {
  const t = parseDay(today)!
  return fmtDay(new Date(t.getTime() + days * 86400000))
}

/** 单次推演（纯函数）：返回各节点终局 mastery 与逐周总掌握值。
 * totalMastery = 范围内全部节点 mastery 的均值（每周记一个点）。
 * deps.schedFor 按课程注入各课自己的调度器实例（与调度同源：R 参数跟课走）。 */
export function simulateRun(
  plan: SandboxPlan,
  cards: SandboxCard[],
  nodes: SandboxNode[],
  today: string,
  deps: { schedFor: (course: string) => FSRS; rng: () => number },
): { endByNode: number[]; curve: number[] } {
  const { schedFor, rng } = deps
  const totalDays = plan.weeks * 7
  // 卡状态工作副本；节点代表卡 key = `node:${course}/${node}`
  const fs = new Map<string, FsrsBlock | null>()
  for (const c of cards) fs.set(c.key, c.fs)
  const cardsByNode = new Map<string, SandboxCard[]>()
  for (const c of cards) {
    const list = cardsByNode.get(`${c.course}/${c.node}`) ?? []
    list.push(c)
    cardsByNode.set(`${c.course}/${c.node}`, list)
  }
  // 节点代表卡（调用方保证每个非 skipped 节点一张：有起点状态带 fs，否则 null 随引入创建）
  const nodeCards = new Map<string, SandboxCard>()
  for (const n of nodes) {
    const rep = cards.find(c => c.kind === 'node' && c.course === n.course && c.node === n.node)
    if (rep) nodeCards.set(`${n.course}/${n.node}`, rep)
  }
  const introSpent = new Map<string, number>()

  const nodeMastery = (n: SandboxNode, atFs: FsrsBlock | null): number =>
    masteryValue(atFs, n.practice, n.ema)
  const totalMastery = (getFs: (key: string) => FsrsBlock | null): number => {
    const active = nodes.filter(n => !n.skipped)
    if (!active.length) return 0
    let sum = 0
    for (const n of active) {
      const rep = nodeCards.get(`${n.course}/${n.node}`)
      sum += nodeMastery(n, rep ? getFs(rep.key) : null)
    }
    return sum / active.length
  }

  const curve: number[] = []
  for (let d = 0; d < totalDays; d++) {
    const day = dayShift(today, d)
    let budget = plan.minutesPerDay
    // 引入阶段：未开始未跳过的节点按图序消耗预算；学成 = 代表卡合成 Good + 休眠题入场
    for (const n of nodes) {
      if (budget < REVIEW_MIN) break
      if (n.skipped || n.started) continue
      const nk = `${n.course}/${n.node}`
      const spent = introSpent.get(nk) ?? 0
      if (spent >= n.est) continue
      const take = Math.min(n.est - spent, budget)
      introSpent.set(nk, spent + take)
      budget -= take
      if (spent + take >= n.est) {
        const rep = nodeCards.get(nk)
        if (rep && !fs.get(rep.key)) fs.set(rep.key, applyRatingBlock(null, 3, day, schedFor(n.course)).fs)
        for (const c of cardsByNode.get(nk) ?? []) {
          if (c.kind === 'question' && !fs.get(c.key)) fs.set(c.key, applyRatingBlock(null, 3, day, schedFor(n.course)).fs)
        }
      }
    }
    // 复习阶段：全部到期卡（题目卡 + 节点代表卡）按 due 升序，预算内逐张 R 伯努利推进
    const due: Array<{ card: SandboxCard; fs: FsrsBlock }> = []
    for (const c of cards) {
      const cur = fs.get(c.key)
      if (cur && cur.reps && cur.due <= day) due.push({ card: c, fs: cur })
    }
    due.sort((a, b) => a.fs.due.localeCompare(b.fs.due) || a.card.key.localeCompare(b.card.key))
    for (const { card, fs: cur } of due) {
      if (budget < REVIEW_MIN) break
      const r = retrievabilityBlock(schedFor(card.course), cur, day)
      const pass = rng() < r
      const next = applyRatingBlock(cur, pass ? 3 : 1, day, schedFor(card.course)).fs
      fs.set(card.key, next)
      budget -= REVIEW_MIN
      // 节点代表卡跟随本节点当日首次推进结果（同过同败）
      if (card.kind === 'question') {
        const rep = nodeCards.get(`${card.course}/${card.node}`)
        if (rep) {
          const repFs = fs.get(rep.key)
          if (repFs && repFs.reps) fs.set(rep.key, applyRatingBlock(repFs, pass ? 3 : 1, day, schedFor(card.course)).fs)
        }
      }
    }
    if ((d + 1) % 7 === 0) curve.push(totalMastery(key => fs.get(key) ?? null))
  }
  const endByNode = nodes.map(n => {
    if (n.skipped) return 0
    const rep = nodeCards.get(`${n.course}/${n.node}`)
    return nodeMastery(n, rep ? fs.get(rep.key) ?? null : null)
  })
  return { endByNode, curve }
}

/** 分位数（线性插值；输入未排序也会先排序）。 */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0
  const v = [...values].sort((a, b) => a - b)
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? v[lo]! : Math.round((v[lo]! + (v[hi]! - v[lo]!) * (pos - lo)) * 1000) / 1000
}

/** 聚合口径（沙盘输出的分布层）：节点图 = 终局 mastery 的 p50/p80；曲线 = 逐周
 * 总掌握值的 p50/p80。 */
export function aggregateRuns(
  runs: Array<{ endByNode: number[]; curve: number[] }>,
  nodeKeys: string[],
  weeks: number,
): {
  curve: Array<{ week: number; p50: number; p80: number }>
  map: Array<{ node: string; p50: number; p80: number }>
} {
  const curve = Array.from({ length: weeks }, (_, w) => ({
    week: w + 1,
    p50: quantile(runs.map(r => r.curve[w] ?? 0), 0.5),
    p80: quantile(runs.map(r => r.curve[w] ?? 0), 0.8),
  }))
  const map = nodeKeys.map((node, i) => ({
    node,
    p50: quantile(runs.map(r => r.endByNode[i] ?? 0), 0.5),
    p80: quantile(runs.map(r => r.endByNode[i] ?? 0), 0.8),
  }))
  return { curve, map }
}

/** 沙盘输出文档（只读；措辞与假设随输出走）。 */
export interface SandboxDoc {
  wording: string
  date: string
  plan: SandboxPlan
  runs: number
  scope: { courses: string[]; nodes: number }
  curve: Array<{ week: number; p50: number; p80: number }>
  map: Array<{ node: string; p50: number; p80: number }>
  assumptions: string[]
}
