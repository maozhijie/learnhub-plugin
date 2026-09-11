/**
 * 习惯一等公民对象（U-3 #90 / ADR-0017）。
 *
 * 一条 Habit = Execution Intention（线索-行动规格，格式锁死「稳定线索 + 单一具体行动」）
 * + SRBAI 式自动化进度曲线（自评、渐近，自变量 = 重复次数，中断不衰减）+ 宽容 streak
 * （漏天无损）。**零 FSRS 语义**：无 FSRS 卡、无 mastery、无到期——调度者 = 情境与日历，
 * 引擎不推送不提醒；重复由学习者自报，无门禁、不防作弊（自测不是考试）。
 *
 * 三边界（ADR-0017 裁决 7）：①习惯 ≠ 掌握度——曲线与 streak 只展示给学习者，永不进
 * Mastery/练习证据/XP/任何 canonical 度量；②习惯 streak ≠ XP streak——两个对象各算各的
 * （自变量不同：XP 按日账、习惯按自报重复），不复用 XP 的按日账函数；③习惯重复 ≠
 * 执行事件——不进执行事件通道（U-2），intention 可指向练习行为但引用不构成数据回流。
 *
 * 生命周期 active/archived 两态可逆（archived 只是收纳标签）；无到期无截止。
 * 落盘：学习中心/习惯/<id>.yaml（实体）+ state/习惯重复.jsonl（重复流，行为流水即事实，
 * 曲线/streak 全派生）。施测节奏（本票定）：自动化自评随重复自报**可选携带**（1–5，
 * 事件级、不强制每次）——SRBAI 语义的单条自评，曲线取有评份的点。
 *
 * Missing/Broken 纪律沿用 ADR-0004：实体文件缺失 = 合法空态；存在但坏 = Broken 抛出。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { atomicWrite } from './io.ts'
import { YAML } from './yaml.ts'
import { todayStr, parseDay, fmtDay } from './dates.ts'
import type { Paths } from './paths.ts'

export type HabitStatus = 'active' | 'archived'
export const HABIT_STATUSES: HabitStatus[] = ['active', 'archived']

/** 执行意图（共享类型各归其主：习惯的意图是实体身份的一部分，持久）。
 * 格式锁死：稳定线索（时间/地点锚）+ 单一具体行动——多行为链、模糊线索掉出证据范围。 */
export interface ExecutionIntention {
  /** 稳定线索：时间/地点锚（「早上刷完牙后」「到工位坐下后」）。 */
  cue: string
  /** 单一具体行动（动词开头、可一次完成）。 */
  action: string
}

/** 习惯实体（习惯/<id>.yaml frontmatter 同构）。 */
export interface HabitDoc {
  /** id = 安全文件名（唯一）。 */
  habit: string
  name: string
  status: HabitStatus
  intention: ExecutionIntention
  created: string
  updated: string
}

/** 一条重复自报（state/习惯重复.jsonl 行）。 */
export interface HabitRepeatRec {
  ts: string
  habit: string
  /** 学习日（YYYY-MM-DD，过日界口径由 facade 归一后传入）。 */
  day: string
  /** SRBAI 式自动化自评 1–5（可选携带；不强制每次）。 */
  auto_rating?: number
  note?: string
}

/** 宽容 streak 的漏天容忍度（漏 ≤ 该天数不断链；ADR-0017「漏天无损」的 v1 参数化）。 */
export const HABIT_GRACE_DAYS = 2

/** 宽容 streak（纯函数；与 XP streak 独立派生，不复用按日账）：从 today 往回数，
 * 有自报的日子 +1；≤ graceDays 的连续漏天跳过（不计数也不断链）；空窗超过 graceDays
 * 截断——小漏天无损，久置自然有界（历史不归零，best 由全部历史另算）。
 * today 当天没报不打断（同 XP streak「今天还没学」语义，grace 天然覆盖）。 */
export function habitStreak(days: string[], today: string, graceDays = HABIT_GRACE_DAYS): number {
  const set = new Set(days)
  const t = parseDay(today)
  if (!t) return 0
  let streak = 0
  let gap = 0
  const cursor = new Date(t.getTime())
  for (let i = 0; i < 3650; i++) {
    const key = fmtDay(cursor)
    if (set.has(key)) {
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

/** 自动化进度曲线（纯函数）：x = 该次自报时的累计重复次数（含当次），y = 自动化自评
 * （1–5）；只取带自评的点（无评份不造假插值），渐近无衰减——中断不衰减是域语义，
 * 曲线不做任何时间衰减折扣。 */
export function automationCurve(recs: HabitRepeatRec[]): Array<{ repeats: number; rating: number }> {
  const sorted = [...recs].sort((a, b) => a.ts.localeCompare(b.ts))
  const out: Array<{ repeats: number; rating: number }> = []
  let n = 0
  for (const r of sorted) {
    n++
    if (typeof r.auto_rating === 'number' && r.auto_rating >= 1 && r.auto_rating <= 5) {
      out.push({ repeats: n, rating: r.auto_rating })
    }
  }
  return out
}

/** 习惯文档契约校验（读侧与写侧共用；意图两字段都不能为空——格式锁死的落地点）。 */
export function validateHabitDoc(raw: unknown, path: string): HabitDoc {
  const bad = (detail: string): Error =>
    new Error(`[habits] 习惯 Broken（位置：${path}）\n  ✗ ${detail}`)
  if (typeof raw !== 'object' || raw === null) throw bad('frontmatter 必须是映射')
  const d = raw as Record<string, unknown>
  const habit = typeof d.habit === 'string' ? d.habit.trim() : ''
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (!habit) throw bad('habit: 不能为空')
  if (!name) throw bad('name: 不能为空')
  if (!(HABIT_STATUSES as string[]).includes(String(d.status))) {
    throw bad(`status: 非法值 ${String(d.status)}（允许 ${HABIT_STATUSES.join('/')}）`)
  }
  const it = d.intention
  if (typeof it !== 'object' || it === null) throw bad('intention: 缺执行意图（线索-行动规格）')
  const cue = typeof (it as Record<string, unknown>).cue === 'string' ? ((it as Record<string, unknown>).cue as string).trim() : ''
  const action = typeof (it as Record<string, unknown>).action === 'string' ? ((it as Record<string, unknown>).action as string).trim() : ''
  if (!cue) throw bad('intention.cue: 不能为空（稳定线索：时间/地点锚）')
  if (!action) throw bad('intention.action: 不能为空（单一具体行动）')
  if (typeof d.created !== 'string' || !d.created) throw bad('created: 不能为空')
  if (typeof d.updated !== 'string' || !d.updated) throw bad('updated: 不能为空')
  return { habit, name, status: d.status as HabitStatus, intention: { cue, action }, created: d.created, updated: d.updated }
}

export class Habits {
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  /** 全部习惯（按 id 序）。坏档跳过并在 broken 报出（不阻塞清单）。 */
  async list(): Promise<{ habits: HabitDoc[]; broken: Array<{ id: string; path: string; reason: string }> }> {
    const out: HabitDoc[] = []
    const broken: Array<{ id: string; path: string; reason: string }> = []
    if (!existsSync(this.paths.habitsDir)) return { habits: out, broken }
    for (const f of (await readdir(this.paths.habitsDir)).filter(f => f.endsWith('.yaml')).sort()) {
      const p = `${this.paths.habitsDir}/${f}`
      try {
        out.push(validateHabitDoc(YAML.parse(await readFile(p, 'utf8')), p))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        broken.push({ id: f.replace(/\.yaml$/, ''), path: p, reason: reason.includes('Broken') ? reason : `习惯 Broken：${reason}` })
      }
    }
    return { habits: out, broken }
  }

  /** 读单个习惯；不存在 = Missing 报错；存在但坏（含 YAML 解析失败）= Broken。 */
  async load(id: string): Promise<HabitDoc> {
    const p = this.paths.habitPath(id)
    if (!existsSync(p)) throw new Error(`[habits] 习惯「${id}」不存在（Missing）：先 learnhub_habit_create。`)
    let raw: unknown
    try {
      raw = YAML.parse(await readFile(p, 'utf8'))
    } catch (err) {
      throw new Error(`[habits] 习惯 Broken（位置：${p}）\n  ✗ YAML 无法解析：${err instanceof Error ? err.message : String(err)}`)
    }
    return validateHabitDoc(raw, p)
  }

  /** 建习惯：意图两字段必填（格式锁死「稳定线索 + 单一具体行动」）；同名已存在即拒绝。 */
  async create(input: { name: string; cue: string; action: string; id?: string }): Promise<HabitDoc> {
    const name = input.name.trim()
    const cue = input.cue.trim()
    const action = input.action.trim()
    if (!name) throw new Error('[habit-create] name 不能为空。')
    if (!cue) throw new Error('[habit-create] cue 不能为空——执行意图要挂在稳定线索上（时间/地点锚，如「早上刷完牙后」）。')
    if (!action) throw new Error('[habit-create] action 不能为空——执行意图是单一具体行动（多行为链掉出证据范围）。')
    const id = (input.id ?? name).trim()
    if (!id || id.includes('..')) throw new Error(`[habit-create] id 非法：${id}`)
    const p = this.paths.habitPath(id)
    if (existsSync(p)) throw new Error(`[habit-create] 习惯「${id}」已存在（${p}）。`)
    const today = todayStr()
    const doc: HabitDoc = { habit: id, name, status: 'active', intention: { cue, action }, created: today, updated: today }
    await atomicWrite(p, YAML.stringify(doc))
    return doc
  }

  /** 全量写回（updated 随写随戳）。 */
  async save(id: string, doc: HabitDoc): Promise<void> {
    const p = this.paths.habitPath(id)
    if (!existsSync(p)) throw new Error(`[habits] 习惯「${id}」不存在（Missing）。`)
    await atomicWrite(p, YAML.stringify({ ...doc, updated: todayStr() }))
  }

  /** 归档/恢复（可逆；无到期，archived 只是收纳标签）。 */
  async setStatus(id: string, status: HabitStatus): Promise<HabitDoc> {
    const doc = await this.load(id)
    doc.status = status
    await this.save(id, doc)
    return doc
  }
}
