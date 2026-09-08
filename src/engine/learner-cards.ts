/**
 * 学习者产出卡（E1 / ADR-0009 Learner Output；schema 依据 #45 调研报告）。
 *
 * 独立卡域：课程根/我的卡/<节点>.yaml，独立 schema + 独立门禁，**不入**题库九题型
 * AlloKind、不进 nodeMastery/完成门禁/XP 定价的任何消费面（独立目录 = 结构性隔离）。
 * 每卡自带 fsrs 调度块（隔离自调度，复习对象是卡自身）+ stats.last「一卡一天一次
 * 推进」门禁；调度内核复用 srs.applyRatingBlock，srs.ts 零改动。
 *
 * 三种卡面：recall_cue 提示重述 / cloze_rewrite 挖空重述 / self_explain 自注讲解。
 * 判分一律走复习自评语义（Hard/Good/Easy + 忘记），不走 evaluateAllo、不做 AI 判分
 * 入账——AI 只在创建时给非控制性反馈（判词入 E 档案）。
 *
 * Missing/Broken 纪律沿用 ADR-0004：文件缺失 = 合法空卡组；存在但坏 = 抛 Broken。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import type { FsrsBlock } from './types.ts'
import type { Paths } from './paths.ts'
import { safeFilename } from './paths.ts'

export type LearnerCardKind = 'recall_cue' | 'cloze_rewrite' | 'self_explain'
export const LEARNER_CARD_KINDS: LearnerCardKind[] = ['recall_cue', 'cloze_rewrite', 'self_explain']

/** 学习者产出卡。prompt = 卡面正面提示；content = 学习者自己的表述（翻面对照）。 */
export interface LearnerCard {
  id: string
  kind: LearnerCardKind
  prompt: string
  content: string
  /** 关联节点（软引用；节点重生成/改名后悬空按 Missing 展示标注，不 Broken）。 */
  source_node: string
  source_section?: string
  archived?: boolean
  /** 卡自身的隔离调度状态（E 池；永不写回节点 frontmatter / 题库）。 */
  fsrs?: FsrsBlock
  /** last = 「一卡一天一次推进」门禁；E 卡无 defer 挂起流（自评直推），无 pending 标记。 */
  stats?: { attempts: number; correct: number; last?: string }
}

export interface LearnerCardDoc { node: string; cards: LearnerCard[] }

/** 卫生约束（#45 §5）：防「整课粘贴成一张卡」与单文件膨胀拖慢每日全库扫描。 */
export const LEARNER_PROMPT_MAX = 500
export const LEARNER_CONTENT_MAX = 2000

/** 控制字符（除换行/制表）拒绝；渲染面与题干同链不放宽。 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** 挖空标记：{{…}} 且挖空段非空。 */
const CLOZE_MARK = /\{\{[^{}]+\}\}/

function cardError(op: string, path: string, detail: string): Error {
  return new Error(`[${op}] 我的卡 Broken（位置：${path}）\n  ✗ ${detail}`)
}

/** 我的卡 schema 校验（手写，错误行风格与引擎其余门禁一致）。 */
export function validateLearnerCards(doc: unknown, expectedNode?: string): { errors?: string[]; spec?: LearnerCardDoc } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (typeof d.node !== 'string' || !d.node.trim()) errors.push('node: 不能为空')
  if (!Array.isArray(d.cards) || !d.cards.length) errors.push('cards: 卡组为空')
  const cards: LearnerCard[] = []
  if (Array.isArray(d.cards)) {
    d.cards.forEach((raw, i) => {
      const n = i + 1
      if (typeof raw !== 'object' || raw === null) {
        errors.push(`cards.${n}: 必须是映射`)
        return
      }
      const e = raw as Record<string, unknown>
      const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `c${n}`
      if (!LEARNER_CARD_KINDS.includes(e.kind as LearnerCardKind)) {
        errors.push(`cards.${n}.kind: 非法卡面 ${String(e.kind)}（允许 ${LEARNER_CARD_KINDS.join('/')}）`)
        return
      }
      if (typeof e.prompt !== 'string' || !e.prompt.trim()) {
        errors.push(`cards.${n}.prompt: 正面提示不能为空`)
        return
      }
      if (e.prompt.length > LEARNER_PROMPT_MAX) {
        errors.push(`cards.${n}.prompt: 超过 ${LEARNER_PROMPT_MAX} 字符上限`)
        return
      }
      if (typeof e.content !== 'string' || !e.content.trim()) {
        errors.push(`cards.${n}.content: 自注内容不能为空`)
        return
      }
      if (e.content.length > LEARNER_CONTENT_MAX) {
        errors.push(`cards.${n}.content: 超过 ${LEARNER_CONTENT_MAX} 字符上限`)
        return
      }
      if (CONTROL_CHARS.test(e.prompt) || CONTROL_CHARS.test(e.content)) {
        errors.push(`cards.${n}: 含控制字符（只允许换行/制表）`)
        return
      }
      if (e.kind === 'cloze_rewrite' && !CLOZE_MARK.test(e.content)) {
        errors.push(`cards.${n}.content: 挖空重述必须含至少一个非空挖空标记 {{…}}`)
        return
      }
      if (typeof e.source_node !== 'string' || !e.source_node.trim()) {
        errors.push(`cards.${n}.source_node: 关联节点不能为空`)
        return
      }
      cards.push({
        id,
        kind: e.kind as LearnerCardKind,
        prompt: e.prompt.trim(),
        content: e.content.trim(),
        source_node: e.source_node.trim(),
        ...(typeof e.source_section === 'string' && e.source_section.trim() ? { source_section: e.source_section.trim() } : {}),
        ...(e.archived === true ? { archived: true } : {}),
        // 调度/统计块由作答侧写入，schema 只透传不做内部校验
        ...(e.fsrs && typeof e.fsrs === 'object' ? { fsrs: e.fsrs as FsrsBlock } : {}),
        ...(e.stats && typeof e.stats === 'object' ? { stats: e.stats as LearnerCard['stats'] } : {}),
      })
    })
  }
  if (errors.length) return { errors }
  const spec: LearnerCardDoc = { node: (d.node as string).trim(), cards }
  if (expectedNode && spec.node !== expectedNode) {
    return { errors: [`node「${spec.node}」与节点「${expectedNode}」不一致`] }
  }
  return { spec }
}

export class LearnerCards {
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  cardPath(courseRoot: string, node: string): string {
    return `${this.paths.learnerCardsDir(courseRoot)}/${safeFilename(node)}.yaml`
  }

  /** 读某节点卡组；文件缺失返回空卡组（合法 Missing）；存在但坏则抛 Broken。 */
  async load(courseRoot: string, node: string): Promise<LearnerCardDoc> {
    const p = this.cardPath(courseRoot, node)
    if (!existsSync(p)) return { node, cards: [] }
    const doc = await this.readDoc(p)
    const v = validateLearnerCards(doc, node)
    if (v.errors) throw cardError('learner-card-load', p, v.errors.join('；'))
    return v.spec!
  }

  private async readDoc(p: string): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw cardError('learner-card-load', p, `无法读取: ${message}`)
    }
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw cardError('learner-card-load', p, `YAML 无法解析: ${message}`)
    }
    if (typeof doc !== 'object' || doc === null) {
      throw cardError('learner-card-load', p, '顶层必须是映射（node/cards）')
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
    const v = validateLearnerCards(doc, node)
    if (v.errors) throw cardError(op, p, v.errors.join('；'))
    return doc
  }

  /** 追加一张卡 → 新卡 id。同节点同内容（trim 后全等）的活跃卡拒绝（防连点重复建卡）。 */
  async addCard(courseRoot: string, node: string, card: {
    kind: LearnerCardKind
    prompt: string
    content: string
    source_section?: string
  }): Promise<{ id: string; count: number }> {
    const doc = await this.loadChecked(courseRoot, node, 'learner-card-add')
      ?? { node, cards: [] as Array<Record<string, unknown>> }
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const content = String(card.content).trim()
    if (list.some(c =>
      (c as { archived?: unknown }).archived !== true
      && String((c as { content?: unknown }).content ?? '').trim() === content)) {
      throw new Error(`[learner-card-add] 同内容卡已存在（去重防连点；先归档旧卡再存新版本）。`)
    }
    const id = `c${list.length + 1}`
    if (list.some(c => (c as { id?: unknown }).id === id)) {
      throw new Error(`[learner-card-add] 卡 id「${id}」已存在。`)
    }
    const next = [...list, {
      kind: card.kind, prompt: card.prompt, content,
      source_node: node,
      ...(card.source_section ? { source_section: card.source_section } : {}),
      id,
    }]
    const v = validateLearnerCards({ ...doc, cards: next }, node)
    if (v.errors) throw new Error(`[learner-card-add] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: next })
    return { id, count: next.length }
  }

  /** 作答侧写回：fsrs/stats 只能整体替换（派生证据，不经作者白名单）。 */
  async updateCardEvidence(
    courseRoot: string, node: string, cardId: string,
    patch: { fsrs?: FsrsBlock | null; stats?: LearnerCard['stats'] },
  ): Promise<void> {
    const doc = await this.loadChecked(courseRoot, node, 'learner-card-evidence')
    if (!doc) throw new Error(`[learner-card-evidence] 「${node}」没有我的卡文件。`)
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const idx = list.findIndex(c => (c as { id?: unknown }).id === cardId)
    if (idx < 0) throw new Error(`[learner-card-evidence] 「${node}」的卡组没有 ${cardId}。`)
    const next = [...list]
    const current = { ...next[idx] }
    if (patch.fsrs !== undefined) {
      if (patch.fsrs === null) delete current.fsrs
      else current.fsrs = patch.fsrs
    }
    if (patch.stats !== undefined) current.stats = patch.stats
    next[idx] = current
    const v = validateLearnerCards({ ...doc, cards: next }, node)
    if (v.errors) throw new Error(`[learner-card-evidence] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: next })
  }

  /** 归档/恢复单卡（修订用白名单见 LEARNER_AUTHORING_FIELDS）。 */
  async archiveCard(courseRoot: string, node: string, cardId: string, archived: boolean): Promise<void> {
    const doc = await this.loadChecked(courseRoot, node, 'learner-card-archive')
    if (!doc) throw new Error(`[learner-card-archive] 「${node}」没有我的卡文件。`)
    const list = Array.isArray(doc.cards) ? doc.cards as Array<Record<string, unknown>> : []
    const hit = list.find(c => (c as { id?: unknown }).id === cardId)
    if (!hit) throw new Error(`[learner-card-archive] 「${node}」的卡组没有 ${cardId}。`)
    if (archived) (hit as { archived?: boolean }).archived = true
    else delete (hit as { archived?: boolean }).archived
    const v = validateLearnerCards({ ...doc, cards: list }, node)
    if (v.errors) throw new Error(`[learner-card-archive] 校验失败，未写入。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    await this.writeDoc(courseRoot, node, { ...doc, cards: list })
  }
}
