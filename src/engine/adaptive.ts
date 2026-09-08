/**
 * A1 作答期难度微调（决议 #34 / 实施工单 #57）：已调度题「单节点会话」（复习该节点
 * 到期题 / Forgot 后重学 / 节点二刷补做）内的流式难度自适应选序。
 *
 * 边界（决议钉死）：只作用于已调度题会话——首学新题顺序不动；不建全局 learner×item
 * 模型；不触碰 reviewQueue 的全局 R 排序（那是工单 #56）；起点先验与节点 Mastery
 * （masteryOfFm）薄联动。零依赖纯函数，会话状态（目标难度带/连对数）由会话方持有，
 * 引擎不落盘、无全局状态。
 *
 * 难度合用口径：每题难度取静态题面难度 difficulty（1–3，出题管线锚定）与 FSRS
 * difficulty（q.fsrs.difficulty，1–10，只存在于已调度卡）的等权合成，各自归一到
 * 0–1 刻度后取半——静态项表达作者意图，FSRS 项表达该学习者在该题上的实测吃力度；
 * 未调度卡只有静态项（FSRS 项缺失不虚拟）。
 */

/** 标量难度（0–1）：静态题面难度（1–3）与 FSRS difficulty（1–10）等权合成；
 * 未调度卡（fsrs 缺失或 reps=0）只有静态项。 */
export function combinedDifficulty(difficulty: number | undefined, fsrs: { difficulty: number; reps: number } | null | undefined): number {
  const staticN = (Math.min(3, Math.max(1, difficulty ?? 1)) - 1) / 2
  const scheduled = Boolean(fsrs?.reps)
  if (!scheduled) return staticN
  const fsrsN = (Math.min(10, Math.max(1, fsrs!.difficulty)) - 1) / 9
  return 0.5 * staticN + 0.5 * fsrsN
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** 起点先验：目标难度带（0–1）随节点 Mastery 单调上行——掌握越好，开场可越难；
 * Mastery 0 → 0.2（从基础题起），Mastery 1 → 0.8（不上顶，留升档空间）。 */
export function startBand(mastery: number): number {
  return 0.2 + 0.6 * clamp01(mastery)
}

/** 显式难度带偏好（E5 #65）：学习者在会话开始时选的带，作为 A1 自动选题的带权
 * 偏好——选挑战抬高当次目标带、选简单放宽、标准/不选 = 纯 A1 自动（偏移 0）。 */
export type BandPref = 'easy' | 'standard' | 'hard'

/** 带权偏移量：作用于起点先验带（它同时也是答错/忘记的防挫回落点）——合意困难
 * 仍可成功完成；A1 的连对升档 / 错忘降档语义在偏移后的带上原样生效。 */
export const BAND_PREF_OFFSET = 0.2

export function bandOffset(pref?: BandPref): number {
  if (pref === 'easy') return -BAND_PREF_OFFSET
  if (pref === 'hard') return BAND_PREF_OFFSET
  return 0
}

/** 连对升档的台阶（0–1 刻度）。 */
export const BAND_STEP_UP = 0.2

/** 会话难度状态一次演进：连续答对 ≥2 次升一档；答错/忘记一步降回基础带（base =
 * 会话起点先验带，「降档回基础题」语义），并把连对清零。correct=false 覆盖答错与
 * 忘记（忘记按答错记，Forgot 语义）。 */
export function nextBand(band: number, correct: boolean, streak: number, base: number): { band: number; streak: number } {
  if (!correct) return { band: Math.max(0, Math.min(band, base)), streak: 0 }
  const s = streak + 1
  return { band: s >= 2 ? Math.min(1, band + BAND_STEP_UP) : band, streak: s }
}

/** 从候选里选「最贴近当前目标带」的下一题：|d − band| 最小者，平局取靠前者（稳定序）。 */
export function pickNext<T extends { d: number }>(cards: T[], band: number): T | null {
  let best: T | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const c of cards) {
    const gap = Math.abs(c.d - band)
    if (gap < bestGap) {
      best = c
      bestGap = gap
    }
  }
  return best
}

/** 会话初始顺序（尚无作答信息）：按「距起点先验带的距离」升序、稳定排序——
 * 会话方拿到即是按先验带摆好的开场；随后的流式选题用 pickNext + nextBand 驱动。 */
export function sessionOrder<T extends { d: number }>(cards: T[], band: number): T[] {
  return cards
    .map((c, i) => ({ c, i, gap: Math.abs(c.d - band) }))
    .sort((a, b) => a.gap - b.gap || a.i - b.i)
    .map(x => x.c)
}
