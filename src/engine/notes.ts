/**
 * 课程笔记 frontmatter 读写（吸收自 Python courses.py）。
 *
 * TS 引擎的数据主权升级：frontmatter 不再是「SQLite 的投影」，而是调度状态唯一
 * 事实源——state_map 直接扫 课程/ 目录得到；每次状态变更就地回写同一份 frontmatter。
 * 键序固定 node/stage/fsrs/mastery/practice_ema/content/practice，其余键保序追加。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAML } from './yaml.ts'
import type { Fm, Stage } from './types.ts'

export const CONTENT_STATUS = ['draft', 'reviewed', 'flagged'] as const

/** 新课程文件的初始 frontmatter（内容尚未生成时 version=0）。 */
export function defaultFrontmatter(nodeName: string): Fm {
  return {
    node: nodeName,
    stage: 'ready',
    fsrs: null,
    mastery: 0.0,
    content: { version: 0, generated_at: null, status: 'draft' },
    practice: { attempts: 0, correct: 0 },
  }
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

/** 校验 frontmatter 是否为合法 Fm（宽容读侧的收窄）。 */
export function asFm(fm: Record<string, unknown> | null): Fm | null {
  if (!fm || typeof fm.node !== 'string') return null
  const stage = (fm.stage as Stage) ?? 'unseen'
  const content = (fm.content as Fm['content']) ?? { version: 0, generated_at: null, status: 'draft' }
  const practice = (fm.practice as Fm['practice']) ?? { attempts: 0, correct: 0 }
  return {
    node: fm.node,
    stage,
    fsrs: (fm.fsrs as Fm['fsrs']) ?? null,
    mastery: typeof fm.mastery === 'number' ? fm.mastery : 0,
    practice_ema: typeof fm.practice_ema === 'number' ? fm.practice_ema : undefined,
    content,
    practice,
  }
}

/** 写课程文件（frontmatter + 正文），自动建目录。 */
export async function saveNote(path: string, fm: Record<string, unknown>, body: string): Promise<void> {
  await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
  const head = `---\n${renderFrontmatter(fm)}\n---\n\n`
  await writeFile(path, head + (body.startsWith('#') || !body.trim() ? body : body), 'utf8')
}

/** 就地更新 frontmatter 顶层键（patch 合并），正文不动。 */
export async function updateNote(path: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { fm, body } = await loadNote(path)
  if (!fm) throw new Error(`无有效 frontmatter: ${path}`)
  const next = { ...fm, ...patch }
  await saveNote(path, next, body)
  return next
}

/** 遍历 课程/ 目录 → { found: {节点名: {path, fm}}, broken: [路径] }（scan_all 同语义）。 */
export async function scanAll(courseDir: string): Promise<{
  found: Record<string, { path: string; fm: Record<string, unknown> }>
  broken: string[]
}> {
  const found: Record<string, { path: string; fm: Record<string, unknown> }> = {}
  const broken: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.name.endsWith('.md')) {
        const { fm } = await loadNote(p)
        const node = fm && typeof fm.node === 'string' ? fm.node : null
        if (!node) {
          broken.push(p)
          continue
        }
        found[node] = { path: p, fm: fm! }
      }
    }
  }
  await walk(courseDir)
  return { found, broken }
}

/** frontmatter 状态视图：{节点名: fm} + 损坏文件列表。 */
export async function stateMap(courseDir: string): Promise<{ state: Record<string, Fm>; broken: string[] }> {
  const { found, broken } = await scanAll(courseDir)
  const state: Record<string, Fm> = {}
  for (const [node, { fm }] of Object.entries(found)) {
    const f = asFm(fm)
    if (f) state[node] = f
  }
  return { state, broken }
}
