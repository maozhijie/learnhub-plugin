/**
 * XP 时间账本（Math Academy 语义：1 XP ≈ 1 分钟有效专注）。
 *
 * XP 是 ETA 的度量基础，账本必须诚实：
 * - 答对 +题型权重×难度；答错 0；乱猜（耗时 < XP_GUESS_SECONDS 且答错）负 XP；
 *   同日重复作答（该题今日已推进调度）0——防刷。
 * - 存储：practice 流水的 xp/elapsed_s 字段 + journal 的 xp 字段（kind='xp_bonus'）。
 *   行为流水即事实，汇总全部派生，零新增数据文件。
 * - 每日目标：state/learnhub.json 的 daily_xp_goal；streak/ETA 从流水派生。
 * - 预算制：节点预算 = 标称 N₀（est 内容定价，回落题目权重和）× 客观难度校准 k
 *   （FSRS difficulty 加权，无人工干预）；完成时 settle 对账锁定定价。
 */
import { readFile } from 'node:fs/promises'
import { XP_BASE, XP_GUESS_SECONDS, XP_GUESS_PENALTY, XP_PER_NODE_DEFAULT, XP_PER_MILESTONE_DEFAULT, DAILY_XP_GOAL_DEFAULT, DAY_CUTOFF_DEFAULT, XP_STREAK_GRACE_DAYS, FSRS_DIFFICULTY_MID } from './params.ts'
import { parseDay, fmtDay, dayOfTs, parseCutoff, fmtCutoff } from './dates.ts'
import { atomicWrite } from './store.ts'
import type { PracticeRec, JournalRec } from './types.ts'
import type { Paths } from './paths.ts'

/** 一次作答的 XP 结算。 */
export interface XpSettle { xp: number; reason: 'correct' | 'wrong' | 'guess' | 'repeat' }

/** 作答 → XP:对=权重×难度、错=0、乱猜=负、同日重复=0。
 * 乱猜判定优先于重复:负分过程惩罚必须照记(即使该题今日已推进过),
 * 否则「先答对再乱刷」可绕开惩罚;乱猜的调度隔离由调用方保证(repeated 含 guessed)。 */
export function xpForAnswer(
  kind: string, difficulty: number, correct: boolean, elapsedS: number | null, scheduled: boolean,
): XpSettle {
  if (!correct && elapsedS !== null && elapsedS < XP_GUESS_SECONDS) return { xp: XP_GUESS_PENALTY, reason: 'guess' }
  if (!scheduled) return { xp: 0, reason: 'repeat' }
  if (!correct) return { xp: 0, reason: 'wrong' }
  const w = XP_BASE[kind] ?? 1
  return { xp: Math.max(1, Math.round(w * Math.max(1, difficulty))), reason: 'correct' }
}

// ---- XP 预算制（节点预算 = 标称 N₀ × 客观难度校准 k；完成后定价锁定）----

/** 参与预算计算的题目侧最小形状。 */
export interface BudgetQuestion {
  kind: string
  difficulty?: number
  fsrs?: { difficulty: number } | null
}

/** 标称预算 N₀（分钟）：节点 est（内容定价）优先；缺省回落 Σ题(权重×难度)；再缺省每节点常量。 */
export function nominalBudget(est: number | undefined, questions: BudgetQuestion[]): number {
  if (est !== undefined && est > 0) return est
  const sum = questions.reduce((s, q) => s + (XP_BASE[q.kind] ?? 1) * Math.max(1, q.difficulty ?? 1), 0)
  return sum > 0 ? sum : XP_PER_NODE_DEFAULT
}

/** 难度校准因子 k：FSRS difficulty（1–10，中性 5）按题目权重加权平均，clamp [0.5, 3]。
 * 无作答记录的题取中性因子 1 —— k 完全由认真作答的证据驱动（乱猜作答不推进调度，
 * 不产生 FSRS difficulty 证据），零人工干预地跟随节点实际难度。 */
export function difficultyCalibration(questions: BudgetQuestion[]): number {
  let weighted = 0
  let weights = 0
  for (const q of questions) {
    const w = (XP_BASE[q.kind] ?? 1) * Math.max(1, q.difficulty ?? 1)
    weights += w
    const d = q.fsrs && typeof q.fsrs.difficulty === 'number' && q.fsrs.difficulty > 0
      ? q.fsrs.difficulty / FSRS_DIFFICULTY_MID
      : 1
    weighted += w * d
  }
  if (!weights) return 1
  return Math.min(3, Math.max(0.5, weighted / weights))
}

/** 里程碑过点定价（#94 票内敲定口径，对齐节点公式 N = N₀ × k）：
 * N₀ = 计划条目 est 申报（分钟，规划时按 1–2 周粒度估的真实投入），缺省回落常量；
 * k = 关联节点题池的 FSRS 难度校准（复用 difficultyCalibration），无关联或无证据 = 1
 * （里程碑自己没有题，校准只能借它挂靠的知识底座——没有就不虚造假精度）。
 * 过点一次性入账并锁定；重复过点不再入账（守卫在调用方）。 */
export function milestonePrice(est: number | undefined, calibration: number): number {
  const n0 = est !== undefined && est > 0 ? est : XP_PER_MILESTONE_DEFAULT
  const k = Number.isFinite(calibration) && calibration > 0 ? Math.min(3, Math.max(0.5, calibration)) : 1
  return Math.max(1, Math.round(n0 * k))
}

// ---- 每日目标（state/learnhub.json） ----

interface LearnhubConfigFile { daily_xp_goal?: number; day_cutoff?: string }

/** 读每日 XP 目标（缺失/非法回落默认）。 */
export async function readDailyGoal(paths: Paths): Promise<number> {
  try {
    const doc = JSON.parse(await readFile(paths.learnhubConfigPath, 'utf8')) as LearnhubConfigFile
    return clampGoal(doc.daily_xp_goal ?? DAILY_XP_GOAL_DEFAULT)
  } catch {
    return DAILY_XP_GOAL_DEFAULT
  }
}

/** 写每日 XP 目标（原子替换）→ clamp 后的值。 */
export async function writeDailyGoal(paths: Paths, goal: number): Promise<number> {
  const clamped = clampGoal(goal)
  let prev: LearnhubConfigFile = {}
  try {
    prev = JSON.parse(await readFile(paths.learnhubConfigPath, 'utf8')) as LearnhubConfigFile
  } catch {
    // 无配置文件/损坏 → 全新写入
  }
  await atomicWrite(paths.learnhubConfigPath, JSON.stringify({ ...prev, daily_xp_goal: clamped }, null, 1) + '\n')
  return clamped
}

function clampGoal(n: number): number {
  return Number.isFinite(n) ? Math.min(1000, Math.max(5, Math.round(n))) : DAILY_XP_GOAL_DEFAULT
}

// ---- 日界（state/learnhub.json 的 day_cutoff；ADR-0020）----

/** 读日界 → 当日分钟数。缺失/非法静默回落默认（learnhub.json 配置三件套同款；
 * ADR-0004 的 fail loud 针对用户数据损坏，不是配置笔误），生效值由 views 暴露可见。 */
export async function readDayCutoff(paths: Paths): Promise<number> {
  try {
    const doc = JSON.parse(await readFile(paths.learnhubConfigPath, 'utf8')) as LearnhubConfigFile
    return parseCutoff(doc.day_cutoff ?? DAY_CUTOFF_DEFAULT) ?? parseCutoff(DAY_CUTOFF_DEFAULT)!
  } catch {
    return parseCutoff(DAY_CUTOFF_DEFAULT)!
  }
}

/** 写日界（原子替换，保留其他字段）→ 归一化 'HH:mm'；非法值 fail loud（显式设置动作）。 */
export async function writeDayCutoff(paths: Paths, value: string): Promise<string> {
  const minutes = parseCutoff(value)
  if (minutes === null) throw new Error(`[config] day_cutoff 必须是 00:00–23:59 的 'HH:mm'（收到 ${String(value)}）。`)
  let prev: LearnhubConfigFile = {}
  try {
    prev = JSON.parse(await readFile(paths.learnhubConfigPath, 'utf8')) as LearnhubConfigFile
  } catch {
    // 无配置文件/损坏 → 全新写入
  }
  const normalized = fmtCutoff(minutes)
  await atomicWrite(paths.learnhubConfigPath, JSON.stringify({ ...prev, day_cutoff: normalized }, null, 1) + '\n')
  return normalized
}

// ---- 流水派生 ----

/** 流水的 XP 计：作答（practice.xp）+ 非作答入账（journal.xp，如满分 bonus）。
 * day 给定时只计该学习日（ts 过日界推学习日，ADR-0020）。 */
function recXp(r: { xp?: number }): number { return r.xp ?? 0 }

/** 流水总 XP；day 给定时只计该本地日（ts 的前 10 位）。 */
export function sumXp(practice: PracticeRec[], journal: JournalRec[], day?: string, cutoffMin = 0): number {
  const hit = (ts: string) => !day || dayOfTs(ts, cutoffMin) === day
  return practice.filter(r => hit(r.ts)).reduce((s, r) => s + recXp(r), 0)
    + journal.filter(r => hit(r.ts)).reduce((s, r) => s + recXp(r), 0)
}

/** 按课程聚合流水 XP（ETA 每节点历史估算用）。 */
export function sumXpByCourse(practice: PracticeRec[], journal: JournalRec[]): Record<string, number> {
  const out: Record<string, number> = {}
  const bump = (course: string | undefined, r: { xp?: number }) => {
    if (!course) return
    out[course] = (out[course] ?? 0) + recXp(r)
  }
  for (const r of practice) bump(r.course, r)
  for (const r of journal) bump(r.course, r)
  return out
}

/** streak：按日行为聚合（total>0 的天）从 today 往回数，宽容口径（C-4 #83）：
 * ≤ graceDays 的连续漏天跳过（不计数也不断链——Lally「漏一天无碍」、Duolingo
 * streak freeze 同型），空窗超过容忍度截断（历史不抹除，恢复后重新累积）。
 * today 当天没学不罚也不耗宽容（起点回退到昨天）。仍是纯派生：行为流水即事实，
 * 账本口径零改动，变的只是 streak 这一个读法。 */
export function streakFrom(byDay: Record<string, { total: number }>, today: string, graceDays = XP_STREAK_GRACE_DAYS): number {
  const cursor = parseDay(today)
  if (!cursor) return 0
  // 今天还没学不打断 streak：起点回退到昨天
  if (!(byDay[fmtDay(cursor)]?.total > 0)) cursor.setUTCDate(cursor.getUTCDate() - 1)
  let streak = 0
  let gap = 0
  for (let i = 0; i < 3650; i++) {
    if (byDay[fmtDay(cursor)]?.total > 0) {
      streak++
      gap = 0
    } else {
      gap++
      if (gap > graceDays) break
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return streak
}

/** ETA 天数 = 剩余节点 × 每节点 XP ÷ 每日目标，向上取整。 */
export function etaDays(remaining: number, perNode: number, goal: number): number {
  if (remaining <= 0 || goal <= 0) return 0
  return Math.ceil((remaining * Math.max(1, perNode)) / goal)
}

/** 每节点 XP 的历史估算：课程累计 XP ÷ 已完成节点数；无历史用默认。 */
export function perNodeXp(courseXp: number, doneNodes: number): number {
  if (doneNodes <= 0 || courseXp <= 0) return XP_PER_NODE_DEFAULT
  return Math.max(1, Math.round(courseXp / doneNodes))
}
