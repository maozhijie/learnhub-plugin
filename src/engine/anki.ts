/**
 * C2 Anki 双向通道（#63 / ADR-0011：Anki 是纯作答通道，vault 唯一调度者）。
 *
 * 跨界的只有原始作答事件：Anki 的 Again/Hard/Good/Easy → 答错/复习自评档，
 * 调度永远由 learnhub 的 ts-fsrs 在 vault 重算——Anki 侧排期输出不作数。
 * Anki 卡组是可丢弃镜象：不一致时以 vault 校准/重建（含已归档题的移除），
 * 镜象清单坏档静默重建、永不判 Broken（镜象非事实源）。
 *
 * 纯函数接缝（tests/README 登记口径）：事件映射（mapAnkiEase）、同日已推进
 * 判定（sameDayAdvanced）、镜象 diff（planMirrorSync）、来源键编解码
 * （sourceKeyOf / parseSourceKey）。AnkiConnect 走可注入 transport（测试用
 * 假 Anki，运行时 fetch 到 http://127.0.0.1:8765）。
 */
import { readFile } from 'node:fs/promises'
import { atomicWrite } from './io.ts'
import { alreadyScheduledOn } from './advance.ts'
import type { Paths } from './paths.ts'
import type { FsrsBlock } from './types.ts'
import type { AlloKind } from './grading.ts'

/** AnkiConnect 默认端点（桌面 Anki + AnkiConnect 插件）。 */
export const ANKI_ENDPOINT = 'http://127.0.0.1:8765'
/** 镜象笔记模型与顶层牌组（每课程一张子牌组 learnhub::<课程名>）。 */
export const ANKI_MODEL = 'learnhub'
export const ANKI_DECK_BASE = 'learnhub'
/** 归属标签：所有镜象笔记都带 learnhub 标签，便于 Anki 侧搜索与人工清理。 */
export const ANKI_TAG = 'learnhub'

// ---- 纯函数缝：事件映射与同日去重 ----

/** Anki 作答按钮 → vault 语义（ADR-0011）：Again 覆盖答错与忘记（Anki 无 5 秒
 * 门控，映射为近似，rating 1 / auto）；Hard/Good/Easy = 复习自评档（2/3/4 / self，
 * 答对记成功）。非法按钮抛错（事件契约外的输入不静默吞）。 */
export function mapAnkiEase(ease: number): { rating: 1 | 2 | 3 | 4; correct: boolean; ratingSource: 'auto' | 'self' } {
  const r = Math.round(ease)
  if (r === 1) return { rating: 1, correct: false, ratingSource: 'auto' }
  if (r === 2 || r === 3 || r === 4) return { rating: r, correct: true, ratingSource: 'self' }
  throw new Error(`[anki] Anki 作答按钮只能是 1–4（Again/Hard/Good/Easy），收到 ${String(ease)}`)
}

/** 「一题一天只推进一次」跨端不变量的当日判定：vault 侧该题当日已有调度动作
 * （stats.last 或 fsrs.last_review 命中事件日，含合成初始化）→ 该 Anki 事件跳过
 * 调度只留档。ADR-0014 起为 advance.ts::alreadyScheduledOn 的回放通道别名。 */
export function sameDayAdvanced(
  q: { fsrs?: FsrsBlock | null; stats?: { last?: string } | null }, day: string,
): boolean {
  return alreadyScheduledOn(q, day)
}

// ---- 纯函数缝：来源键（回写归属）----

/** learnhub 卡 id → 来源键 `课程/节点/题id`（解析时课程取第一个 /、题 id 取最后一个
 * /——节点名允许含 /，题 id 是机器生成的安全段）。 */
export function sourceKeyOf(course: string, node: string, qid: string): string {
  return `${course}/${node}/${qid}`
}

export function parseSourceKey(key: string): { course: string; node: string; qid: string } | null {
  const i = key.indexOf('/')
  const j = key.lastIndexOf('/')
  if (i <= 0 || j <= i) return null
  const qid = key.slice(j + 1)
  return qid ? { course: key.slice(0, i), node: key.slice(i + 1, j), qid } : null
}

// ---- 纯函数缝：导出负载与镜象 diff ----

/** 导出卡负载：fields 直接对齐 Anki 模型（题目/答案/来源），fp = 内容指纹
 * （下次推送判定 update 用）。front/back 传引擎已排版好的文本（题面带选项、
 * 答案带解析），此处只做 HTML 转义与换行处理——Anki 字段是 HTML。 */
export interface AnkiNotePayload {
  key: string
  deckName: string
  fields: { 题目: string; 答案: string; 来源: string }
  fp: string
}

export interface AnkiCardSource {
  id: string
  kind: AlloKind
  q: string
  options?: string[]
}

/** 导出负载组装：正面 = 题面 + 选项（不泄答案），背面 = 答案 + 解析。 */
export function ankiCardPayload(
  course: string, node: string, q: AnkiCardSource, backAnswer: string,
): AnkiNotePayload {
  const front = [q.q, ...(q.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)].join('\n')
  const key = sourceKeyOf(course, node, q.id)
  return {
    key,
    deckName: deckNameOf(course),
    fields: { 题目: toAnkiHtml(front), 答案: toAnkiHtml(backAnswer), 来源: key },
    fp: fingerprintOf(`${q.kind}\u001f${front}\u001f${backAnswer}`),
  }
}

/** Anki 字段 HTML：转义后换行转 <br>（题面/答案都是纯文本排版）。 */
function toAnkiHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

/** 内容指纹（FNV-1a 32 位 hex）：只作「内容变没变」的 diff 依据，非安全哈希。 */
export function fingerprintOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 镜象清单条目：key ↔ Anki noteId + 内容指纹。清单本身可丢弃（坏档重建后
 * 靠 Anki 侧来源字段回补归属，见 engine.ankiImportEvents）。 */
export interface AnkiMirrorEntry { key: string; note_id: number; fp: string; deck: string }

export interface AnkiMirrorDoc {
  last_push: string | null
  last_import_ms: number
  notes: AnkiMirrorEntry[]
}

export function emptyMirror(): AnkiMirrorDoc {
  return { last_push: null, last_import_ms: 0, notes: [] }
}

/** 镜象 diff：vault 到期集 vs 现有镜象 → {新增, 内容变化更新, 移除}。移除 =
 * 已不在 vault 到期集（归档/重生成/已被 vault 消费）——镜象与 vault 不一致时
 * 以 vault 为准（ADR-0011）。 */
export interface MirrorPlan {
  add: AnkiNotePayload[]
  update: Array<{ payload: AnkiNotePayload; noteId: number }>
  removeNoteIds: number[]
}

export function planMirrorSync(payloads: AnkiNotePayload[], entries: AnkiMirrorEntry[]): MirrorPlan {
  const byKey = new Map(entries.map(e => [e.key, e]))
  const seen = new Set<string>()
  const plan: MirrorPlan = { add: [], update: [], removeNoteIds: [] }
  for (const p of payloads) {
    seen.add(p.key)
    const e = byKey.get(p.key)
    if (!e) plan.add.push(p)
    else if (e.fp !== p.fp) plan.update.push({ payload: p, noteId: e.note_id })
  }
  for (const e of entries) {
    if (!seen.has(e.key)) plan.removeNoteIds.push(e.note_id)
  }
  return plan
}

// ---- 镜象清单落盘 ----

export class AnkiMirror {
  constructor(private paths: Paths) {}

  path(): string {
    return this.paths.ankiMirrorPath
  }

  /** 读镜象清单。Missing = 空清单（合法）；存在但坏 = 静默重建空清单——镜象是
   * 可丢弃的派生状态，不判 Broken（ADR-0011；Anki 侧孤儿笔记靠来源字段回补）。 */
  async load(): Promise<AnkiMirrorDoc> {
    let raw: string
    try {
      raw = await readFile(this.path(), 'utf8')
    } catch {
      return emptyMirror()
    }
    try {
      const doc = JSON.parse(raw) as Record<string, unknown>
      const notes = Array.isArray(doc.notes)
        ? doc.notes.filter((n): n is AnkiMirrorEntry => {
          const e = n as AnkiMirrorEntry
          return typeof e?.key === 'string' && Number.isFinite(e?.note_id) && typeof e?.fp === 'string'
        })
        : []
      return {
        last_push: typeof doc.last_push === 'string' ? doc.last_push : null,
        last_import_ms: typeof doc.last_import_ms === 'number' ? doc.last_import_ms : 0,
        notes,
      }
    } catch {
      return emptyMirror()
    }
  }

  async save(doc: AnkiMirrorDoc): Promise<void> {
    await atomicWrite(this.path(), JSON.stringify(doc, null, 1) + '\n')
  }
}

// ---- AnkiConnect 客户端（可注入 transport）----

/** AnkiConnect 传输缝：测试注假 Anki，运行时 AnkiConnectClient（HTTP POST JSON）。 */
export interface AnkiTransport {
  invoke(action: string, params?: Record<string, unknown>): Promise<unknown>
}

export class AnkiConnectClient implements AnkiTransport {
  constructor(readonly endpoint: string = ANKI_ENDPOINT, private fetchImpl: typeof fetch = fetch) {}

  async invoke(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }),
      })
    } catch (err) {
      throw new Error(`[anki] 连不上 AnkiConnect（${this.endpoint}）——确认桌面 Anki 已打开且装了 AnkiConnect 插件：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(`[anki] AnkiConnect ${action} HTTP ${res.status}`)
    const body = await res.json() as { result?: unknown; error: string | null }
    if (body.error) throw new Error(`[anki] AnkiConnect ${action} 失败：${body.error}`)
    return body.result
  }
}

/** Anki 卡组名（每课程一张子牌组）。 */
export function deckNameOf(course: string): string {
  return `${ANKI_DECK_BASE}::${course}`
}

export async function ankiDeckNames(t: AnkiTransport): Promise<string[]> {
  const r = await t.invoke('deckNames')
  return Array.isArray(r) ? r as string[] : []
}

export async function ankiCreateDeck(t: AnkiTransport, deck: string): Promise<void> {
  await t.invoke('createDeck', { deck })
}

export async function ankiModelNames(t: AnkiTransport): Promise<string[]> {
  const r = await t.invoke('modelNames')
  return Array.isArray(r) ? r as string[] : []
}

export async function ankiCreateModel(t: AnkiTransport): Promise<void> {
  await t.invoke('createModel', {
    modelName: ANKI_MODEL,
    inOrderFields: ['题目', '答案', '来源'],
    isCloze: false,
    cardTemplates: [{
      Name: 'learnhub',
      Front: '{{题目}}',
      Back: '{{frontside}}<hr id="answer">{{答案}}',
    }],
  })
}

export interface AnkiNoteInput {
  deckName: string
  fields: Record<string, string>
  tags?: string[]
}

/** addNote：成功 → noteId；重复（allowDuplicate=false）→ null（调用方走来源字段
 * 检索回补归属）。其他错误照常抛出。 */
export async function ankiAddNote(t: AnkiTransport, note: AnkiNoteInput): Promise<number | null> {
  try {
    const r = await t.invoke('addNote', {
      note: { deckName: note.deckName, modelName: ANKI_MODEL, fields: note.fields, tags: note.tags ?? [ANKI_TAG], options: { allowDuplicate: false } },
    })
    return typeof r === 'number' ? r : null
  } catch (err) {
    if (/duplicate/i.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  }
}

export async function ankiUpdateNoteFields(t: AnkiTransport, noteId: number, fields: Record<string, string>): Promise<void> {
  await t.invoke('updateNoteFields', { note: { id: noteId, fields } })
}

export async function ankiDeleteNotes(t: AnkiTransport, noteIds: number[]): Promise<void> {
  if (noteIds.length) await t.invoke('deleteNotes', { notes: noteIds })
}

/** Anki 侧笔记不存在（手动删除过的镜象卡）：更新失败时可安全走重建。 */
export function isAnkiNoteMissing(err: unknown): boolean {
  return /not found|不存在|is deleted|No note with/i.test(err instanceof Error ? err.message : String(err))
}

export async function ankiFindNotes(t: AnkiTransport, query: string): Promise<number[]> {
  const r = await t.invoke('findNotes', { query })
  return Array.isArray(r) ? r as number[] : []
}

export interface AnkiNoteInfo { noteId: number; fields: Record<string, string> }

export async function ankiNotesInfo(t: AnkiTransport, noteIds: number[]): Promise<AnkiNoteInfo[]> {
  if (!noteIds.length) return []
  const r = await t.invoke('notesInfo', { notes: noteIds })
  if (!Array.isArray(r)) return []
  return (r as Array<Record<string, unknown>>).map(n => {
    const fields: Record<string, string> = {}
    for (const [k, v] of Object.entries((n.fields ?? {}) as Record<string, unknown>)) {
      fields[k] = typeof v === 'object' && v !== null ? String((v as { value?: unknown }).value ?? '') : String(v)
    }
    return { noteId: Number(n.noteId), fields }
  })
}

export interface AnkiCardInfo { cardId: number; noteId: number }

export async function ankiCardsInfo(t: AnkiTransport, cardIds: number[]): Promise<AnkiCardInfo[]> {
  if (!cardIds.length) return []
  const r = await t.invoke('cardsInfo', { cards: cardIds })
  if (!Array.isArray(r)) return []
  return (r as Array<Record<string, unknown>>).map(c => ({
    cardId: Number(c.cardId),
    noteId: Number(c.note),
  }))
}

/** cardReviews：Anki 复习日志行 [复习时刻ms, cardId, usn, 按钮(1-4), 新间隔,
 * 旧间隔, ease, 耗时ms, 类型]。区间 [mmin, mmax] 毫秒。 */
export async function ankiCardReviews(t: AnkiTransport, mmin: number, mmax: number): Promise<number[][]> {
  const r = await t.invoke('cardReviews', { mmin, mmax })
  return Array.isArray(r) ? r as number[][] : []
}

/** 毫秒时间戳 → 本地 ISO（秒精度；Anki 事件回写 practice 流水的 ts 语义）。 */
export function isoFromMs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
