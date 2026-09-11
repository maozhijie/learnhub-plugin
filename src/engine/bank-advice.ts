/**
 * B2 难度感知回流（决议 #41 / 实施工单 #58）：节点级只读检测——
 * (i) 低掌握（已进复习/掌握期 + 作答量达门槛 + masteryOfFm 低迷 + 答错证据）
 *     → 「题面难度与目标带失衡」难度带校准再生成建议（difficulty/bloom 调制目标带）；
 * (ii) 全对（调度证据零遗忘且间隔拉长）→ 「过于简单」归档标注建议。
 *
 * 两极都建议先行、不自动改库——执行复用既有单节出题/单节重写端点与 validateBank
 * 门禁；归档动作保留给作者/题目管理面（q.archived 已存在），不静默移除。难度轴用
 * 现有 1-3 档 + bloom + A1 per-question FSRS difficulty，不新增 schema 字段。
 * 零依赖纯函数（接缝 S25；日期换算用 dates 纯函数）；低数据一律静默。
 *
 * 「忽略此条」（dismiss）：误判的建议可持久忽略（学习中心 state/难度建议忽略.json），
 * 恢复成本为零，与「供确认、不自动移除」的立场一致。
 */

/** 「答错证据」口径与 A3 struggle 同源：作答正确率低于 sessions.STRUGGLE_ACCURACY。 */
import { STRUGGLE_ACCURACY } from './sessions.ts'
import { sourceKeyOf } from './types.ts'
import { daysBetween, parseDay } from './dates.ts'

/** 校准建议（低掌握半边）：节点 Mastery 低于该值才算「低迷」。
 * 复习/掌握期的节点防饱和后仍应明显高于此；新学的正常低值由 stage 守门排除。 */
export const B2_MASTERY_LOW = 0.5
/** 校准建议的节点累计作答量门槛（低于此低数据静默）。 */
export const B2_NODE_MIN_ATTEMPTS = 6
/** 「过于简单」标注的调度推进次数门槛。FSRS reps 含合成初始化（nodeComplete 批量
 * 建卡 rating=3）——reps≥6 即 ≥5 次真实推进全对；首答直接建卡的题多算一次，宁严勿松。 */
export const B2_EASY_MIN_REPS = 6
/** 「过于简单」标注的调度间隔门槛（天）：间隔是调度器对「简单」的投票，
 * 5 次推进全对但间隔尚短的题（如连续多日刷出来的）不由本建议标注。 */
export const B2_EASY_MIN_INTERVAL_DAYS = 21

/** 难度带校准再生成建议：带理由与「difficulty/bloom 调制目标带」的再生成指令，
 * 指令供既有单节出题/单节重写端点消费。 */
export interface CalibrationAdvice {
  kind: 'difficulty_calibration'
  reason: string
  instruction: string
}

/** 「过于简单」归档标注建议：归档由作者/管理面确认，引擎只标注不执行。 */
export interface TooEasyAdvice {
  kind: 'too_easy'
  qid: string
  /** 题面摘录（面板条目直接可读——qid 是节点内编号，光看它认不出是哪道题）。 */
  stem: string
  /** 调度推进次数（含合成初始化）。 */
  reps: number
  /** 当前调度间隔（天，due − last_review）。 */
  interval_days: number
  reason: string
}

/** 低掌握校准判定（(i)）：stage 守门（只认 review/mastered，排除新学防饱和低值）→
 * 作答量门槛 → Mastery 阈值 → 答错证据，四关全过才出建议；任一不满足返回 null 静默。 */
export function calibrationAdvice(input: {
  stage: string
  attempts: number
  accuracy: number | null
  mastery: number
  bloom?: string
}): CalibrationAdvice | null {
  const { stage, attempts, accuracy, mastery, bloom } = input
  if (stage !== 'review' && stage !== 'mastered') return null
  if (attempts < B2_NODE_MIN_ATTEMPTS) return null
  if (mastery >= B2_MASTERY_LOW) return null
  if (accuracy === null || accuracy >= STRUGGLE_ACCURACY) return null
  const pct = Math.round(accuracy * 100)
  return {
    kind: 'difficulty_calibration',
    reason: `该节点已进复习期但掌握度低迷（Mastery ${mastery}）且作答正确率仅 ${pct}%（${attempts} 次作答）——题面难度与目标带失衡，建议校准重出。`,
    instruction: `再生成指令：对该节点按目标带调制出题——difficulty 以 1-2 档为主（低掌握期先降一档再渐进），bloom 对准「${bloom || '理解'}」及以下层级；走既有单节出题/重写端点，过 validateBank 门禁落库。`,
  }
}

/** 全对「过于简单」判定（(ii)）：调度证据口径——FSRS 卡 ≥ 门槛次数推进零遗忘
 * （lapses=0）且当前间隔拉长到门槛天数，叠加终身作答统计全对兜底（同日重复
 * 不推 FSRS 但记 stats，此处只作「从未答错」的复核）。已归档/未调度/数据不足
 * 一律静默——建议出得晚一点，但几乎不误报。 */
export function tooEasyAdvice(qs: Array<{
  id: string
  q: string
  archived?: boolean
  fsrs?: { reps: number; lapses: number; due: string; last_review: string } | null
  stats?: { attempts: number; correct: number }
}>): TooEasyAdvice[] {
  const out: TooEasyAdvice[] = []
  for (const q of qs) {
    if (q.archived) continue
    const fsrs = q.fsrs
    if (!fsrs?.reps || fsrs.reps < B2_EASY_MIN_REPS) continue
    if (fsrs.lapses !== 0) continue
    const due = parseDay(fsrs.due)
    const last = parseDay(fsrs.last_review)
    if (!due || !last) continue
    const interval = daysBetween(due, last)
    if (interval < B2_EASY_MIN_INTERVAL_DAYS) continue
    const attempts = q.stats?.attempts ?? 0
    if (attempts === 0 || (q.stats?.correct ?? 0) < attempts) continue
    out.push({
      kind: 'too_easy',
      qid: q.id,
      stem: q.q.slice(0, 80),
      reps: fsrs.reps,
      interval_days: interval,
      reason: `该题已 ${fsrs.reps} 次调度推进全部答对、零遗忘，当前调度间隔 ${interval} 天——「过于简单」，建议归档（供作者/题目管理确认，不自动移除）。`,
    })
  }
  return out
}

/** 忽略清单条目：被持久忽略的「过于简单」建议定位。 */
export interface AdviceDismissRec { course: string; node: string; qid: string; date: string }

export function adviceDismissKey(course: string, node: string, qid: string): string {
  return sourceKeyOf(course, node, qid)
}
