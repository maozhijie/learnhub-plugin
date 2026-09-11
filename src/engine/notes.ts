/**
 * 课程笔记 frontmatter 读写（吸收自 Python courses.py）。
 *
 * TS 引擎的数据主权升级：frontmatter 不再是「SQLite 的投影」，而是调度状态唯一
 * 事实源——state_map 直接扫 课程/ 目录得到；每次状态变更就地回写同一份 frontmatter。
 * 键序固定 node/stage/fsrs/mastery/practice_ema/content/practice，其余键保序追加；
 * mastery 位仅为旧文件键序稳定保留，新文件不再写入该键（ADR-0007）。
 */
import { readFile, readdir } from 'node:fs/promises'
import { atomicWrite } from './io.ts'
import { join } from 'node:path'
import { YAML } from './yaml.ts'
import type { Fm, FsrsBlock, Stage } from './types.ts'
import { STAGES } from './types.ts'

export const CONTENT_STATUS = ['draft', 'reviewed', 'flagged'] as const

/** 新课程文件的初始 frontmatter（内容尚未生成时 version=0）。
 * mastery 不再写入（ADR-0007：掌握度纯派生，不落盘）。 */
export function defaultFrontmatter(nodeName: string): Fm {
  return {
    node: nodeName,
    stage: 'ready',
    fsrs: null,
    content: { version: 0, generated_at: null, status: 'draft' },
    practice: { attempts: 0, correct: 0 },
  }
}

/** 节点是否已生成可读正文：节清单里至少一节 ready（部分完成的中断产物也算——
 * 「点开有东西读」的列表/图三态标识数据源；Missing 无节 = 合法空状态）。 */
export function hasReadyContent(fm: Fm | undefined | null): boolean {
  const sections = fm?.content?.sections
  return Array.isArray(sections) && sections.some(s => s?.status === 'ready')
}

/** 拆分 Markdown 为 (frontmatter | null, 正文)。读侧宽容（与 split_frontmatter 同语义）。
 * CRLF 兼容：frontmatter 部分剥掉 \r（yaml 会把「0\r」当字符串而非数字）；正文统一为 LF。 */
export function splitFrontmatter(text: string): { fm: Record<string, unknown> | null; body: string } {
  if (!text.startsWith('---')) return { fm: null, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { fm: null, body: text }
  const raw = text.slice(3, end).replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/\r/g, '')
  const body = text.slice(end + 4).replace(/^[\r\n]+/, '').replace(/\r\n/g, '\n')
  let fm: unknown = null
  try {
    fm = YAML.parse(raw)
  } catch {
    fm = null
  }
  const okFm = typeof fm === 'object' && fm !== null ? fm as Record<string, unknown> : null
  return { fm: okFm, body: okFm ? body : text }
}

const FM_ORDER = ['node', 'stage', 'fsrs', 'mastery', 'practice_ema', 'content', 'practice']

/** frontmatter → YAML 文本（保持 schema 键序，其余键保序追加）。 */
export function renderFrontmatter(fm: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {}
  for (const k of FM_ORDER) if (k in fm) ordered[k] = fm[k]
  for (const [k, v] of Object.entries(fm)) if (!(k in ordered)) ordered[k] = v
  return YAML.stringify(ordered).replace(/\n$/, '')
}

/** 读课程文件 → (fm, body)。文件不存在返回 (null, '')。 */
export async function loadNote(path: string): Promise<{ fm: Record<string, unknown> | null; body: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { fm: null, body: '' }
  }
  return splitFrontmatter(raw)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 课程笔记 frontmatter 的核心契约校验（#7；Data Check 与 stateMap 共用）。
 *
 * 合法输入只收核心调度状态；未知顶层键是用户元数据，不在校验范围。
 * practice_ema 与 fsrs 允许缺省归一（无练习证据 / 无调度记录）；一旦给出
 * 值就必须合法。mastery 已退役（ADR-0007）：缺省合法，给出仍须 0–1
 * （存量文件不报 Broken）；掌握度一律由 masteryOfFm 派生，不再落盘。
 * 缺省默认对象（content/practice）不算非法——但它们实际由
 * defaultFrontmatter 写入，读侧不据此伪造进度。 */
export function validateNoteFrontmatter(doc: unknown): { errors: string[]; fm?: Fm } {
  const errors: string[] = []
  if (!isRecord(doc)) return { errors: ['frontmatter 必须是映射'] }

  if (!isNonEmptyString(doc.node)) errors.push('node: 不能为空')
  const stage = doc.stage
  if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
    errors.push(`stage: 非法状态（允许 ${STAGES.join('/')}）`)
  }
  if (doc.mastery !== undefined) {
    const mastery = doc.mastery
    if (typeof mastery !== 'number' || !Number.isFinite(mastery) || mastery < 0 || mastery > 1) {
      errors.push('mastery: 必须是 0–1 的数')
    }
  }
  if (doc.practice_ema !== undefined) {
    const ema = doc.practice_ema
    if (typeof ema !== 'number' || !Number.isFinite(ema) || ema < 0 || ema > 1) {
      errors.push('practice_ema: 必须是 0–1 的数')
    }
  }

  let fsrs: FsrsBlock | null = null
  if (doc.fsrs !== undefined && doc.fsrs !== null) {
    if (!isRecord(doc.fsrs)) {
      errors.push('fsrs: 必须是映射或 null')
    } else {
      const f = doc.fsrs as Record<string, unknown>
      for (const key of ['stability', 'difficulty'] as const) {
        if (typeof f[key] !== 'number' || !Number.isFinite(f[key])) errors.push(`fsrs.${key}: 必须是数`)
      }
      for (const key of ['due', 'last_review'] as const) {
        if (!isNonEmptyString(f[key])) errors.push(`fsrs.${key}: 必须是日期文本`)
      }
      for (const key of ['reps', 'lapses'] as const) {
        if (!isNonNegativeInt(f[key])) errors.push(`fsrs.${key}: 必须是非负整数`)
      }
      if (!errors.some(e => e.startsWith('fsrs.'))) {
        fsrs = {
          stability: f.stability as number,
          difficulty: f.difficulty as number,
          due: f.due as string,
          last_review: f.last_review as string,
          reps: f.reps as number,
          lapses: f.lapses as number,
        }
      }
    }
  }

  const content = doc.content
  if (!isRecord(content)) {
    errors.push('content: 必须是映射')
  } else {
    const version = content.version
    if (!isNonNegativeInt(version)) errors.push('content.version: 必须是非负整数')
    if (content.generated_at !== null && !isNonEmptyString(content.generated_at)) {
      errors.push('content.generated_at: 必须是时间文本或 null')
    }
    if (typeof content.status !== 'string' || !CONTENT_STATUS.includes(content.status as never)) {
      errors.push(`content.status: 非法状态（允许 ${CONTENT_STATUS.join('/')}）`)
    }
    if (content.sections !== undefined) {
      if (!Array.isArray(content.sections)) {
        errors.push('content.sections: 必须是列表')
      } else {
        content.sections.forEach((section, index) => {
          const where = `content.sections.${index + 1}`
          if (!isRecord(section)) {
            errors.push(`${where}: 必须是映射`)
            return
          }
          for (const key of ['id', 'title', 'type'] as const) {
            if (!isNonEmptyString(section[key])) errors.push(`${where}.${key}: 不能为空`)
          }
          if (section.status !== 'pending' && section.status !== 'ready') {
            errors.push(`${where}.status: 只允许 pending/ready`)
          }
          if (!isNonNegativeInt(section.version)) errors.push(`${where}.version: 必须是非负整数`)
        })
      }
    }
    if (content.tier !== undefined && !['低', '中', '高'].includes(content.tier as string)) {
      errors.push('content.tier: 只允许 低/中/高（复杂度档位记录）')
    }
  }

  const practice = doc.practice
  if (!isRecord(practice)) {
    errors.push('practice: 必须是映射')
  } else {
    for (const key of ['attempts', 'correct'] as const) {
      if (!isNonNegativeInt(practice[key])) errors.push(`practice.${key}: 必须是非负整数`)
    }
  }

  if (errors.length) return { errors }

  // 返回规范化核心状态，并保留全部未知顶层键（用户元数据，写回不丢失）
  const out: Record<string, unknown> = {
    node: String(doc.node).trim(),
    stage: stage as Stage,
    fsrs,
    ...(doc.mastery !== undefined ? { mastery: doc.mastery } : {}),
    ...(doc.practice_ema !== undefined ? { practice_ema: doc.practice_ema } : {}),
    content: {
      version: (content as Record<string, unknown>).version,
      generated_at: (content as Record<string, unknown>).generated_at ?? null,
      status: (content as Record<string, unknown>).status,
      ...((content as Record<string, unknown>).sections !== undefined
        ? { sections: (content as Record<string, unknown>).sections } : {}),
      ...((content as Record<string, unknown>).tier !== undefined
        ? { tier: (content as Record<string, unknown>).tier } : {}),
    },
    practice: {
      attempts: (practice as Record<string, unknown>).attempts,
      correct: (practice as Record<string, unknown>).correct,
    },
  }
  for (const [key, value] of Object.entries(doc)) {
    if (!(key in out)) out[key] = value
  }
  return { errors, fm: out as unknown as Fm }
}

/** 兼容轻量读取：校验不过返回 null（调用方负责 fail loud；契约细节看 validateNoteFrontmatter）。 */
export function asFm(fm: Record<string, unknown> | null): Fm | null {
  if (!fm) return null
  return validateNoteFrontmatter(fm).fm ?? null
}

/** 损坏课程文件（Broken）：位置 + 可识别节点 + 稳定人类可读原因。 */
export interface BrokenNote {
  path: string
  node?: string
  reason: string
}

/** 单个 Markdown 文件 frontmatter 解析结果（Data Check / stateMap 共用）。 */
function parseFmBlock(text: string): { ok: true; doc: unknown; raw: string } | { ok: false; reason: string } {
  if (!text.startsWith('---')) return { ok: false, reason: 'Markdown 开头没有 frontmatter。' }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { ok: false, reason: 'frontmatter 没有闭合的 ---。' }
  const raw = text.slice(3, end).replace(/^[\r\n]+|[\r\n]+$/g, '').replace(/\r/g, '')
  try {
    return { ok: true, doc: YAML.parse(raw), raw }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 遍历 课程/ 目录，把每个 Markdown 分类为合法状态 / Broken（带原因）。
 * 无 node 字段的非课程文件也按 Broken 暴露，避免状态扫描静默忽略。 */
export async function scanCourseNotes(courseDir: string): Promise<{
  state: Record<string, Fm>
  raw: Record<string, { path: string; fm: Record<string, unknown> }>
  broken: BrokenNote[]
}> {
  const state: Record<string, Fm> = {}
  const raw: Record<string, { path: string; fm: Record<string, unknown> }> = {}
  const broken: BrokenNote[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (err) {
        broken.push({ path, reason: `无法读取: ${err instanceof Error ? err.message : String(err)}` })
        continue
      }
      const parsed = parseFmBlock(text)
      if (!parsed.ok) {
        broken.push({ path, reason: parsed.reason })
        continue
      }
      if (!isRecord(parsed.doc)) {
        broken.push({ path, reason: 'frontmatter 必须是映射。' })
        continue
      }
      const node = isNonEmptyString(parsed.doc.node) ? String(parsed.doc.node).trim() : undefined
      if (!node) {
        broken.push({ path, reason: 'node: 不能为空（不是可纳管课程文件）' })
        continue
      }
      const checked = validateNoteFrontmatter(parsed.doc)
      if (!checked.fm) {
        broken.push({ path, node, reason: checked.errors.join('；') })
        continue
      }
      state[node] = checked.fm
      raw[node] = { path, fm: parsed.doc as Record<string, unknown> }
    }
  }
  await walk(courseDir)
  return { state, raw, broken }
}

/** 旧签名兼容包装：合法 raw 映射 + BrokenNote 列表（audit 等调用方已按此结构读取）。 */
export async function scanAll(courseDir: string): Promise<{
  found: Record<string, { path: string; fm: Record<string, unknown> }>
  broken: BrokenNote[]
}> {
  const scan = await scanCourseNotes(courseDir)
  return { found: scan.raw, broken: scan.broken }
}

/** 写课程文件（frontmatter + 正文），自动建目录。 */
export async function saveNote(path: string, fm: Record<string, unknown>, body: string): Promise<void> {
  const head = `---\n${renderFrontmatter(fm)}\n---\n\n`
  await atomicWrite(path, head + (body.startsWith('#') || !body.trim() ? body : body)) // 调度事实源必须原子（ADR-0046）
}

/** 就地更新 frontmatter 顶层键（patch 合并），正文不动。 */
export async function updateNote(path: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { fm, body } = await loadNote(path)
  if (!fm) throw new Error(`无有效 frontmatter: ${path}`)
  const next = { ...fm, ...patch }
  await saveNote(path, next, body)
  return next
}

/** frontmatter 状态视图：{节点名: Fm} + BrokenNote（带位置与原因）。 */
export async function stateMap(courseDir: string): Promise<{ state: Record<string, Fm>; broken: BrokenNote[] }> {
  const scan = await scanCourseNotes(courseDir)
  return { state: scan.state, broken: scan.broken }
}
