/**
 * B2 难度感知回流（决议 #41 / 实施工单 #58）：节点级只读检测——
 * (i) 低掌握（已进复习/掌握期 + 作答量达门槛 + masteryOfFm 低迷 + 答错证据）
 *     → 「题面难度与目标带失衡」难度带校准再生成建议（difficulty/bloom 调制目标带）；
 * (ii) 全对（单题作答正确率 100% 且作答量达门槛）→ 「过于简单」归档标注建议。
 *
 * 两极都建议先行、不自动改库——执行复用既有单节出题/单节重写端点与 validateBank
 * 门禁；归档动作保留给作者/题目管理面（q.archived 已存在），不静默移除。难度轴用
 * 现有 1-3 档 + bloom + A1 per-question FSRS difficulty，不新增 schema 字段。
 * 零依赖纯函数（接缝 S25）；低数据一律静默。
 */

/** 「答错证据」口径与 A3 struggle 同源：作答正确率低于 sessions.STRUGGLE_ACCURACY。 */
import { STRUGGLE_ACCURACY } from './sessions.ts'

/** 校准建议（低掌握半边）：节点 Mastery 低于该值才算「低迷」。
 * 复习/掌握期的节点防饱和后仍应明显高于此；新学的正常低值由 stage 守门排除。 */
export const B2_MASTERY_LOW = 0.5
/** 校准建议的节点累计作答量门槛（低于此低数据静默）。 */
export const B2_NODE_MIN_ATTEMPTS = 6
/** 「过于简单」标注的单题作答量门槛（对齐 B1 R2 的作答量口径）。 */
export const B2_EASY_MIN_ATTEMPTS = 4

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
  attempts: number
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

/** 全对「过于简单」判定（(ii)）：单题累计作答达门槛且全部答对（作答正确率 100%）
 * → 归档标注建议。已归档题跳过；作答量不足静默。 */
export function tooEasyAdvice(qs: Array<{
  id: string
  archived?: boolean
  stats?: { attempts: number; correct: number }
}>): TooEasyAdvice[] {
  const out: TooEasyAdvice[] = []
  for (const q of qs) {
    if (q.archived) continue
    const attempts = q.stats?.attempts ?? 0
    if (attempts < B2_EASY_MIN_ATTEMPTS) continue
    if ((q.stats?.correct ?? 0) < attempts) continue
    out.push({
      kind: 'too_easy',
      qid: q.id,
      attempts,
      reason: `该题累计 ${attempts} 次作答全部答对——「过于简单」，建议归档（供作者/题目管理确认，不自动移除）。`,
    })
  }
  return out
}
