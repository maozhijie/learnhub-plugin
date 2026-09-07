/**
 * FSRS-6 调度内核（吸收自 Python srs.py；py-fsrs → ts-fsrs 等价替换）。
 *
 * - 日粒度单遍会话：enable_short_term=false（关闭分钟级 learning/relearning 步），无 fuzz。
 * - 个人参数 state/fsrs参数.json（重训落盘，21 参数数组）继续可用。
 * - frontmatter fsrs 块 ⇔ ts-fsrs Card 的双向转换在此集中。
 * - 阶段机与评分落盘原语在此；settle/grade 是唯二调用方（D15）。
 */
import { readFile } from 'node:fs/promises'
import { fsrs, createEmptyCard, Rating, State, generatorParameters } from 'ts-fsrs'
import type { FSRS, Card } from 'ts-fsrs'
import type { FsrsBlock, Fm } from './types.ts'
import { parseDay, fmtDay, daysBetween } from './dates.ts'
import { DESIRED_RETENTION, S_MASTER } from './params.ts'
import type { Paths } from './paths.ts'

const RATING_BY_NUM: Record<number, Rating> = {
  1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy,
}
export const RATING_NAME: Record<number, string> = {
  1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy',
}

/** 构造调度器（日粒度、无 fuzz；个人参数文件优先）。 */
export async function getScheduler(paths: Paths, courseRoot: string | null = null): Promise<FSRS> {
  let w: number[] | undefined
  if (courseRoot) {
    try {
      const doc = JSON.parse(await readFile(paths.fsrsParamsPath(courseRoot), 'utf8')) as { parameters?: number[] }
      if (Array.isArray(doc.parameters) && doc.parameters.length) w = doc.parameters
    } catch {
      // 无个人参数 → 用官方默认
    }
  }
  return fsrs(generatorParameters({
    request_retention: DESIRED_RETENTION,
    enable_fuzz: false,
    enable_short_term: false,
    ...(w ? { w } : {}),
  }))
}

/** 状态 dict → ts-fsrs Card。无复习记录（fsrs 空或 reps=0）返回新卡。 */
export function cardFromFm(fm: Fm | null): Card {
  const fs = fm?.fsrs
  if (!fs || !fs.reps) return createEmptyCard()
  return {
    due: parseDay(fs.due) ?? new Date(),
    stability: fs.stability,
    difficulty: fs.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: fs.reps,
    lapses: fs.lapses,
    state: State.Review,
    last_review: parseDay(fs.last_review) ?? undefined,
  }
}

/** Card → fsrs 块（保留 reps/lapses 累计，由调用方更新）。 */
export function fmFromCard(card: Card, fsOld: FsrsBlock | null, today: string): FsrsBlock {
  const fs: FsrsBlock = {
    ...(fsOld ?? { reps: 0, lapses: 0 }),
    stability: Math.round(card.stability * 100) / 100,
    difficulty: Math.round(card.difficulty * 100) / 100,
    due: fmtDay(card.due),
    last_review: today,
  }
  return fs
}

/** 当前可提取性 R；无复习记录视为 1.0（刚学/未衰减）。 */
export function retrievability(sched: FSRS, fm: Fm | null | undefined, today: string): number {
  const fs = fm?.fsrs
  if (!fs || !fs.reps) return 1.0
  const now = parseDay(today) ?? new Date()
  return sched.get_retrievability(cardFromFm(fm ?? null), now, false)
}

/** 一次评分 → (新 fsrs 块, 日志元信息)。不写存储，由 settleRating 落盘。 */
export function applyRating(
  fm: Fm, ratingNum: number, today: string, sched: FSRS,
): { fs: FsrsBlock; meta: { kind: 'learn' | 'review' | 'relearn'; elapsed_days: number } } {
  const card = cardFromFm(fm)
  const wasReview = Boolean(fm.fsrs?.reps) && (fm.stage === 'review' || fm.stage === 'mastered')
  const fsOld = fm.fsrs
  let elapsed = 0
  if (fsOld?.last_review) {
    const lr = parseDay(fsOld.last_review)
    const t = parseDay(today)
    if (lr && t) elapsed = Math.max(0, daysBetween(t, lr))
  }
  const rating = RATING_BY_NUM[Math.round(ratingNum)] ?? Rating.Good
  const now = parseDay(today) ?? new Date()
  const { card: newCard } = sched.next(card, now, rating)
  const fs = fmFromCard(newCard, fsOld ?? null, today)
  fs.reps = (fsOld?.reps ?? 0) + 1
  let kind: 'learn' | 'review' | 'relearn' = 'learn'
  if (ratingNum === 1 && wasReview) {
    fs.lapses = (fsOld?.lapses ?? 0) + 1
    kind = 'relearn'
  } else if (fsOld?.reps) {
    kind = 'review'
  }
  return { fs, meta: { kind, elapsed_days: elapsed } }
}

/** 阶段机：由本次评分结果推新 stage。 */
export function stageAfter(newFs: FsrsBlock, rating: number, firstLearn: boolean): 'review' | 'learning' | 'mastered' {
  const s = newFs.stability
  if (firstLearn) return rating >= 3 ? 'review' : 'learning'
  if (s >= S_MASTER) return 'mastered'
  return 'review'
}

/** 题目级（刷卡模型）一次评分 → 新 fsrs 块。题卡没有节点 stage，只有 fsrs 块本身。 */
export function applyRatingBlock(
  fsOld: FsrsBlock | null, ratingNum: number, today: string, sched: FSRS,
): { fs: FsrsBlock; kind: 'learn' | 'review' | 'relearn' } {
  const pseudo = {
    node: '', stage: fsOld?.reps ? 'review' : 'ready', fsrs: fsOld, mastery: 0,
    content: { version: 0, generated_at: null, status: 'draft' }, practice: { attempts: 0, correct: 0 },
  } as unknown as Fm
  const { fs, meta } = applyRating(pseudo, ratingNum, today, sched)
  return { fs, kind: meta.kind }
}

/** 预览某评分后的下次到期日（不落盘）：复习自评按钮的到期预览。 */
export function previewDue(sched: FSRS, fsOld: FsrsBlock | null, ratingNum: number, today: string): string {
  const card = cardFromFm({ fsrs: fsOld } as unknown as Fm)
  const rating = RATING_BY_NUM[Math.round(ratingNum)] ?? Rating.Good
  const now = parseDay(today) ?? new Date()
  const { card: next } = sched.next(card, now, rating)
  return fmtDay(next.due)
}

/** 派生展示值 mastery = 0.7·稳定度完成度 + 0.3·练习证据；调度不读它。
 * 稳定度项 = min(1, S/(2·S_MASTER))：复习把 S 推向 2·S_MASTER 才渐近满分，
 * 一次全对的会话只到三成左右；无卡（未完成学习）时稳定度项为 0，只剩练习证据。 */
export function masteryValue(fs: FsrsBlock | null, practice: { attempts: number; correct: number }, ema: number | undefined): number {
  const sComp = fs && fs.reps ? Math.min(1.0, fs.stability / (S_MASTER * 2)) : 0
  if (practice.attempts >= 1 && ema && ema > 0) {
    return Math.round((0.7 * sComp + 0.3 * ema) * 100) / 100
  }
  if (practice.attempts >= 3) {
    const acc = practice.correct / practice.attempts
    return Math.round((0.7 * sComp + 0.3 * acc) * 100) / 100
  }
  return Math.round(sComp * 100) / 100
}

/** 节点掌握度口径的唯一入口（图/树/学习包共用）：frontmatter → masteryValue。 */
export function masteryOfFm(fm: Fm | null | undefined): number {
  return masteryValue(fm?.fsrs ?? null, fm?.practice ?? { attempts: 0, correct: 0 }, fm?.practice_ema)
}
