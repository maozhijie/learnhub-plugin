/**
 * 错误对比卡域（C-3 / #82：错误库→对比案例卡）。
 *
 * 从作答流水挖高频错误模式（同一题 ≥2 次实质答错），AI 据此生成「三选一、其中
 * 一项是学习者的错法」辨别卡，入独立错误 deck 走 FSRS（错误管理训练：错法本身
 * 成为复习对象）。独立卡域：课程根/错误卡/<节点>.yaml，独立 schema + 独立门禁，
 **不入**题库九题型、不进 Mastery/作答正确率/完成门禁/节点调度面（与我的卡同一
 * 结构性隔离）；每卡自带 fsrs 调度块（默认参数）+ stats.last「一卡一学习日一次
 * 推进」门禁；调度内核复用 srs.applyRatingBlock，srs.ts 零改动。复习呈现并入
 * 复习队列、复习入账走无绑定 XP（ADR-0021 同款）。
 *
 * 判分走自动判定（三选一答案唯一：选对=rating 3、选错=rating 1），不走复习自评
 * ——辨别对错是客观事实，不交自评。
 *
 * Missing/Broken 纪律沿用 ADR-0004：文件缺失 = 合法空卡组；存在但坏 = 抛 Broken。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import type { FsrsBlock, PracticeRec } from './types.ts'
import type { Paths } from './paths.ts'
import { safeFilename } from './paths.ts'

export type ErrorCardKind = 'contrast'
export const ERROR_CARD_KINDS: ErrorCardKind[] = ['contrast']

/** 错误对比卡：q = 情境题面（三选一）；answer = 正确做法项；mine = 学习者自己的错法项。 */
export interface ErrorCard {
  id: string
  kind: ErrorCardKind
  q: string
  /** 恰好 3 项（正确做法 / 学习者错法 / 干扰项），互不相同。 */
  options: string[]
  answer: string
  mine: string
  explanation: string
  /** 关联节点与来源题（软引用；悬空按 Missing 展示标注，不 Broken）。 */
  source_node: string
  source_q: string
  source_section?: string
  archived?: boolean
  /** 卡自身的隔离调度状态（错误 deck；永不写回题库/节点 frontmatter）。 */
  fsrs?: FsrsBlock
  /** last = 「一卡一天一次推进」门禁。 */
  stats?: { attempts: number; correct: number; last?: string }
}

export interface ErrorCardDoc { node: string; cards: ErrorCard[] }

// ---- 挖矿（纯函数：practice 流水 → 高频错误模式候选）----

/** 高频门槛：同一题 ≥2 次实质答错（忘记申报不是错法证据，不计）。 */
export const MIN_ERROR_LAPSES = 2
/** 单题错答样本上限（喂生成的原料截断；防老题流水撑爆提示词）。 */
export const MAX_WRONG_SAMPLES = 4
/** 单次生成的卡数上限（一批只挖前 N 个高频候选；错误 deck 缓慢累积防批量注水）。 */
export const ERROR_CARD_BATCH_MAX = 5

/** 挖出的高频错误模式候选：lapses = 实质答错次数，wrongs = 学习者的错答（最近在前、去重）。 */
export interface ErrorPatternCandidate {
  course: string
  node: string
  qid: string
  lapses: number
  wrongs: string[]
  last_wrong: string
}

/** 实质答错 = correct=false 且给出了作答且不是忘记申报——忘记是「想不起来」，
 * 没有错法内容可挖；空作答同理。 */
export function isMinableWrong(rec: PracticeRec): boolean {
  return rec.correct === false
    && rec.judge !== 'forget'
    && typeof rec.qid === 'string' && rec.qid.trim() !== ''
    && typeof rec.answer === 'string' && rec.answer.trim() !== ''
}

/** practice 流水 → 高频错误模式候选（按 课程/节点/题 聚合；lapses 降序、同数按位次稳定）。
 * lapses 计全部实质答错次数（同一错法反复犯同样高频），wrongs 是去重后的错答样本。 */
export function mineErrorPatterns(
  recs: PracticeRec[],
  opts: { minLapses?: number; course?: string; node?: string } = {},
): ErrorPatternCandidate[] {
  const minLapses = opts.minLapses ?? MIN_ERROR_LAPSES
  const grouped = new Map<string, { c: PracticeRec; lapses: number; wrongs: string[] }>()
  for (const r of recs) {
    if (opts.course !== undefined && r.course !== opts.course) continue
    if (opts.node !== undefined && r.node !== opts.node) continue
    if (!isMinableWrong(r)) continue
    const key = `${r.course}\n${r.node}\n${r.qid}`
    const hit = grouped.get(key)
    if (hit) {
      hit.c = r
      hit.lapses++
      if (!hit.wrongs.includes(r.answer)) hit.wrongs.push(r.answer)
    } else {
      grouped.set(key, { c: r, lapses: 1, wrongs: [r.answer] })
    }
  }
  const out: ErrorPatternCandidate[] = []
  for (const { c, lapses, wrongs } of grouped.values()) {
    if (lapses < minLapses) continue
    out.push({
      course: c.course, node: c.node, qid: c.qid!,
      lapses,
      wrongs: wrongs.slice(-MAX_WRONG_SAMPLES).reverse(),
      last_wrong: c.ts,
    })
  }
  return out.sort((a, b) =>
    b.lapses - a.lapses
    || a.course.localeCompare(b.course)
    || a.node.localeCompare(b.node)
    || a.qid.localeCompare(b.qid))
}

// ---- schema 门禁 ----

/** 卫生约束：防「整课粘贴成一张卡」与单文件膨胀拖慢每日全库扫描。 */
export const ERROR_Q_MAX = 400
export const ERROR_OPTION_MAX = 200
export const ERROR_EXPL_MAX = 800

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

function cardError(op: string, path: string, detail: string): Error {
  return new Error(`[${op}] 错误卡 Broken（位置：${path}）\n  ✗ ${detail}`)
}

/** 错误卡 schema 校验（手写，错误行风格与引擎其余门禁一致）。 */
export function validateErrorCards(doc: unknown, expectedNode?: string): { errors?: string[]; spec?: ErrorCardDoc } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (typeof d.node !== 'string' || !d.node.trim()) errors.push('node: 不能为空')
  if (!Array.isArray(d.cards) || !d.cards.length) errors.push('cards: 卡组为空')
  const cards: ErrorCard[] = []
  if (Array.isArray(d.cards)) {
    d.cards.forEach((raw, i) => {
      const n = i + 1
      if (typeof raw !== 'object' || raw === null) {
        errors.push(`cards.${n}: 必须是映射`)
        return
      }
      const e = raw as Record<string, unknown>
      const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `c${n}`
      if (!ERROR_CARD_KINDS.includes(e.kind as ErrorCardKind)) {
        errors.push(`cards.${n}.kind: 非法卡面 ${String(e.kind)}（允许 ${ERROR_CARD_KINDS.join('/')}）`)
        return
      }
      const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
      if (!str(e.q) || String(e.q).length > ERROR_Q_MAX) {
        errors.push(`cards.${n}.q: 题面不能为空且 ≤${ERROR_Q_MAX} 字符`)
        return
      }
      if (!Array.isArray(e.options) || e.options.length !== 3
        || !e.options.every((o: unknown) => str(o) && String(o).length <= ERROR_OPTION_MAX)) {
        errors.push(`cards.${n}.options: 必须恰好 3 项（每项非空且 ≤${ERROR_OPTION_MAX} 字符）`)
        return
      }
      const options = (e.options as string[]).map(o => o.trim())
      if (new Set(options).size !== 3) {
        errors.push(`cards.${n}.options: 三项必须互不相同`)
        return
      }
      if (!str(e.answer) || !options.includes(String(e.answer).trim())) {
        errors.push(`cards.${n}.answer: 必须是三个选项之一的原文`)
        return
      }
      if (!str(e.mine) || !options.includes(String(e.mine).trim())) {
        errors.push(`cards.${n}.mine: 必须是三个选项之一的原文（学习者的错法项）`)
        return
      }
      if (String(e.answer).trim() === String(e.mine).trim()) {
        errors.push(`cards.${n}.mine: 错法项不能与正确项相同`)
        return
      }
      if (!str(e.explanation) || String(e.explanation).length > ERROR_EXPL_MAX) {
        errors.push(`cards.${n}.explanation: 解析不能为空且 ≤${ERROR_EXPL_MAX} 字符`)
        return
      }
      if (!str(e.source_node)) {
        errors.push(`cards.${n}.source_node: 关联节点不能为空`)
        return
      }
      if (!str(e.source_q)) {
        errors.push(`cards.${n}.source_q: 来源题 id 不能为空`)
        return
      }
      if (CONTROL_CHARS.test(e.q) || CONTROL_CHARS.test(e.explanation)
        || options.some(o => CONTROL_CHARS.test(o))) {
        errors.push(`cards.${n}: 含控制字符（只允许换行/制表）`)
        return
      }
      cards.push({
        id,
        kind: e.kind as ErrorCardKind,
        q: String(e.q).trim(),
        options,
        answer: String(e.answer).trim(),
        mine: String(e.mine).trim(),
        explanation: String(e.explanation).trim(),
        source_node: String(e.source_node).trim(),
        source_q: String(e.source_q).trim(),
        ...(typeof e.source_section === 'string' && e.source_section.trim() ? { source_section: e.source_section.trim() } : {}),
        ...(e.archived === true ? { archived: true } : {}),
        // 调度/统计块由作答侧写入，schema 只透传不做内部校验
        ...(e.fsrs && typeof e.fsrs === 'object' ? { fsrs: e.fsrs as FsrsBlock } : {}),
        ...(e.stats && typeof e.stats === 'object' ? { stats: e.stats as ErrorCard['stats'] } : {}),
      })
    })
  }
  if (errors.length) return { errors }
  const spec: ErrorCardDoc = { node: (d.node as string).trim(), cards }
  if (expectedNode && spec.node !== expectedNode) {
    return { errors: [`node「${spec.node}」与节点「${expectedNode}」不一致`] }
  }
  return { spec }
}

// ---- 存储（同构 LearnerCards：load / addCards / updateEvidence / archive）----

export class ErrorCards {
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  cardPath(courseRoot: string, node: string): string {
    return `${this.paths.errorCardsDir(courseRoot)}/${safeFilename(node)}.yaml`
  }

  /** 读某节点卡组；文件缺失返回空卡组（合法 Missing）；存在但坏则抛 Broken。 */
  async load(courseRoot: string, node: string): Promise<ErrorCardDoc> {
    const p = this.cardPath(courseRoot, node)
    if (!existsSync(p)) return { node, cards: [] }
    const doc = await this.readDoc(p)
    const v = validateErrorCards(doc, node)
    if (v.errors) throw cardError('error-card-load', p, v.errors.join('；'))
    return v.spec!
  }

  private async readDoc(p: string): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw cardError('error-card-load', p, `无法读取: ${message}`)
    }
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw cardError('error-card-load', p, `YAML 无法解析: ${message}`)
    }
    if (typeof doc !== 'object' || doc === null) {
      throw cardError('error-card-load', p, '顶层必须是映射（node/cards）')
    }
    return doc as Record<string, unknown>
  }

  private async writeDoc(courseRoot: string, node: string, doc: unknown): Promise<void> {
    const p = this.cardPath(courseRoot, node)
    await mkdir(p.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    await writeFile(p, YAML.stringify(doc), 'utf8')
  }

  private async loadChecked(courseRoot: string, node: string, op: string): Promise<Record<string, unknown> | null> {
    const p = this.cardPath(courseRoot, node)
    if (!existsSync(p)) return null
    const doc = await this.readDoc(p)
    const v = validateErrorCards(doc, node)
    if (v.errors) throw cardError(op, p, v.errors.join('；'))
    return doc
  }

  /** 批量追加卡（生成入口一次落同节点的一批）→ 新卡 id 列表。同节点同来源题的
   * 活跃卡拒绝（同一错法不重复建卡；先归档旧卡才可重做）。 */
  async addCards(courseRoot: string, node: string, cards: Array<{
    q: string; options: string[]; answer: string; mine: string; explanation: string; source_q: string; source_section?: string
  }>): Promise<{ ids: string[]; count: number }> {
    if (!cards.length) return { ids: [], count: 0 }
    const doc = await this.loadChecked(courseRoot, node, 'error-card-add')
      ?? { node, cards: [] as Array<Record<string, unknown>> }
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const next = [...list]
    const ids: string[] = []
    for (const card of cards) {
      if (list.some(c =>
        (c as { archived?: unknown }).archived !== true
        && (c as { source_q?: unknown }).source_q === card.source_q)) {
        throw new Error(`[error-card-add] 来源题 ${card.source_q} 已有活跃对比卡（去重；先归档旧卡再重做）。`)
      }
      const id = `c${next.length + 1}`
      if (next.some(c => (c as { id?: unknown }).id === id)) {
        throw new Error(`[error-card-add] 卡 id「${id}」已存在。`)
      }
      next.push({
        kind: 'contrast', q: card.q, options: card.options, answer: card.answer,
        mine: card.mine, explanation: card.explanation,
        source_node: node, source_q: card.source_q,
        ...(card.source_section ? { source_section: card.source_section } : {}),
        id,
      })
      ids.push(id)
    }
    const v = validateErrorCards({ ...doc, cards: next }, node)
    if (v.errors) throw new Error(`[error-card-add] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: next })
    return { ids, count: next.length }
  }

  /** 作答侧写回：fsrs/stats 只能整体替换（派生证据，不经作者白名单）。 */
  async updateCardEvidence(
    courseRoot: string, node: string, cardId: string,
    patch: { fsrs?: FsrsBlock | null; stats?: ErrorCard['stats'] },
  ): Promise<void> {
    const doc = await this.loadChecked(courseRoot, node, 'error-card-evidence')
    if (!doc) throw new Error(`[error-card-evidence] 「${node}」没有错误卡文件。`)
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const idx = list.findIndex(c => (c as { id?: unknown }).id === cardId)
    if (idx < 0) throw new Error(`[error-card-evidence] 「${node}」的错误卡组没有 ${cardId}。`)
    const next = [...list]
    const current = { ...next[idx] }
    if (patch.fsrs !== undefined) {
      if (patch.fsrs === null) delete current.fsrs
      else current.fsrs = patch.fsrs
    }
    if (patch.stats !== undefined) current.stats = patch.stats
    next[idx] = current
    const v = validateErrorCards({ ...doc, cards: next }, node)
    if (v.errors) throw new Error(`[error-card-evidence] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: next })
  }

  /** 归档/恢复单卡（管理面）。 */
  async archiveCard(courseRoot: string, node: string, cardId: string, archived: boolean): Promise<void> {
    const doc = await this.loadChecked(courseRoot, node, 'error-card-archive')
    if (!doc) throw new Error(`[error-card-archive] 「${node}」没有错误卡文件。`)
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const hit = list.find(c => (c as { id?: unknown }).id === cardId)
    if (!hit) throw new Error(`[error-card-archive] 「${node}」的错误卡组没有 ${cardId}。`)
    if (archived) (hit as { archived?: boolean }).archived = true
    else delete (hit as { archived?: boolean }).archived
    const v = validateErrorCards({ ...doc, cards: list }, node)
    if (v.errors) throw new Error(`[error-card-archive] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: list })
  }
}
