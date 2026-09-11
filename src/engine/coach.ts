/**
 * E5 可用的困难教练（决议 #50 / 实施工单 #65）：只读信息性反馈——监视学习者的
 * 长期难度带选择分布与带内表现，触发时给温和提示。无门禁、无判分、不碰任何
 * canonical 调度；低数据静默（选择少或作答量不足时一律不打扰）。
 *
 * 数据源：state/难度带.jsonl（会话结束落一条 {date,course,node,band,answered,
 * correct}）+ 题库到期难题计数（facade 注入）。零依赖纯函数（接缝 S31）。
 */

/** 难度带偏好（E5）：简单 = 放宽 A1 目标带，挑战 = 抬高；标准/不选 = 纯 A1。 */
import { DAY_MS } from './dates.ts'
import type { BandPref } from './adaptive.ts'

/** 一条难度带会话记录（会话结束落盘；band 是该次会话学习者选的带）。 */
export interface BandRec {
  date: string
  course: string
  node: string
  band: BandPref
  answered: number
  correct: number
}

/** 教练触发门槛：7 天窗口内的最少会话数 / 最少作答量（低数据静默）。 */
export const COACH_WINDOW_DAYS = 7
export const COACH_MIN_SESSIONS = 3
export const COACH_MIN_ANSWERED = 10
/** 「该会的到期难题」口径：到期且 R 仍高（按 FSRS 状态该会）+ 合用难度中档以上（难）。 */
export const COACH_DUE_HARD_R = 0.6
export const COACH_HARD_D = 0.5
/** 挑战带反复失败的作答正确率线（与 struggle 同阈值语义）。 */
export const COACH_STRUGGLE_ACCURACY = 0.6

/** 记录是否落在教练的近期窗口内（按本地日）。 */
export function withinCoachWindow(date: string, today: string, days = COACH_WINDOW_DAYS): boolean {
  return today >= date && (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS < days
}

/** 教练反馈（#65）：7 天窗口内全部会话都在同一非标准带且作答量足够时触发——
 * ① 总选简单且有按 FSRS 状态该会的到期难题 → 温和点出「该会了」；
 * ② 总在挑战且反复失败（正确率低于 struggle 线）→ 提示回前置/成分技能复习。
 * 只读信息性：无门禁无判分；低数据（会话少/作答少）或混选时静默。 */
export function coachFeedback(recs: BandRec[], dueHard: number, today: string): string[] {
  const win = recs.filter(r => withinCoachWindow(r.date, today))
  const answered = win.reduce((s, r) => s + r.answered, 0)
  if (win.length < COACH_MIN_SESSIONS || answered < COACH_MIN_ANSWERED) return []
  const out: string[] = []
  if (win.every(r => r.band === 'easy') && dueHard > 0) {
    out.push(`最近 ${COACH_WINDOW_DAYS} 天的复习会话你都选了简单带。有 ${dueHard} 道到期题按你现在的记忆状态其实该会了——下次要不要试一次标准带？`)
  }
  const hard = win.filter(r => r.band === 'hard')
  if (hard.length >= COACH_MIN_SESSIONS && win.every(r => r.band === 'hard')) {
    const correct = hard.reduce((s, r) => s + r.correct, 0)
    const acc = answered ? correct / answered : 0
    if (acc < COACH_STRUGGLE_ACCURACY) {
      // 复用 A3（#54/#55）建议语义：回补前置/成分技能的到期复习（学习页有直达入口），不设门禁
      out.push(`挑战带最近连续受挫（正确率 ${Math.round(acc * 100)}%）。先回补前置与成分技能的到期复习（学习页有直达入口），再回来挑战会更稳。`)
    }
  }
  return out
}
