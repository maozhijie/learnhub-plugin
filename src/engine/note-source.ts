/**
 * 笔记复习源（C1 #59 / ADR-0010）：把 vault 个人笔记注册为复习源，只出题不动文。
 *
 * 数据主权：对注册的个人笔记**零写入**（正文与 frontmatter 都不动，永不判 Broken
 * ——它不是引擎契约对象）；派生物（源清单正文指纹 + per-source 题库）全部落
 * 学习中心/笔记源/ 镜像区，解除注册即清除镜像。
 *
 * 演变语义与课程节点刻意不同：
 * - 删除/改名 → 源链接 Missing（合法空态、卡池挂起、可重注册/解除恢复）；
 * - 正文编辑 → 内容漂移（指纹不符 → 提示重出/归档，不自动改题）。
 *
 * 注册身份落在课程注册表 note_sources 域（{id, path, enabled, created}）；镜像区
 * 源清单.yaml 持 {id, path, fingerprint, title}（指纹每读比较 → Missing/漂移）。
 * 用户排除清单（V-1 #86）的配置 IO 也归本模块：learnhub.json 的 note_source_excludes，
 * 注册入口强制执行（清单内路径不收编），只管未来注册、不摘已注册源。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import { atomicWrite } from './store.ts'
import { isRegistrableCenterRel } from './output.ts'
import type { NoteSourceEntry } from './types.ts'
import type { Paths } from './paths.ts'

/** 复习队列里笔记源卡的伪课程名（questionAnswer/Rate/Forget 以它路由到镜像题库；
 * 与真实课程重名时真实课程优先——同名课程存在则不触发笔记源路由）。 */
export const NOTE_SOURCE_COURSE = '笔记源'

/** 源清单条目（镜像区 working set；enabled 语义以注册表为准，写入时同步）。 */
export interface NoteSourceManifestItem {
  id: string
  path: string
  fingerprint: string
  title?: string
  enabled?: boolean
}

export interface NoteSourceManifestDoc { sources: NoteSourceManifestItem[] }

/** 源状态（纯判定；每读比较路径存在性 → Missing、正文指纹 → 漂移；
 * 清单条目缺失 = 镜像不一致——不是漂移也不是缺文件，data-check 同步报出）。 */
export type NoteSourceStatus = 'ok' | 'missing' | 'drifted' | 'inconsistent'

export function classifySource(fileExists: boolean, fingerprintMatch: boolean): NoteSourceStatus {
  if (!fileExists) return 'missing'
  return fingerprintMatch ? 'ok' : 'drifted'
}

/** 状态对应的学习面提示（列表与复习面共用文案）。 */
export function sourceHint(status: NoteSourceStatus): string | undefined {
  if (status === 'missing') return '源文件缺失，卡池挂起（可重新注册恢复，或解除注册）'
  if (status === 'drifted') return '内容已变，可重新出题或归档旧题（旧卡不自动改）'
  if (status === 'inconsistent') return '源清单条目缺失（镜像不一致）——解除后重新注册可修复'
  return undefined
}

/** 正文指纹（sha256 前 16 位 hex；漂移检测专用，非安全摘要）。 */
export function fingerprintOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 笔记标题：正文首个 `# ` 标题，缺省用文件名。 */
export function titleOfBody(body: string, filename: string): string {
  const m = /^#\s+(.+)$/m.exec(body)
  return (m?.[1] ?? filename).trim() || filename
}

/** 剥掉笔记 frontmatter（--- 围栏块），正文出题只看正文。 */
export function stripFrontmatter(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return (m ? raw.slice(m[0].length) : raw).trim()
}

/** 注册表 note_sources 域契约（validateRegistry 同口径）：id 唯一非空、path 非空唯一、
 * enabled 布尔、created 非空字符串。合法空（域缺失）= 无笔记源。 */
export function validateNoteSourceEntries(raw: unknown): { errors: string[]; entries: NoteSourceEntry[] } {
  const errors: string[] = []
  const entries: NoteSourceEntry[] = []
  if (raw === undefined) return { errors, entries }
  if (!Array.isArray(raw)) return { errors: ['note_sources: 必须是列表'], entries }
  const ids = new Set<string>()
  const paths = new Set<string>()
  raw.forEach((item, index) => {
    const where = `note_sources.${index + 1}`
    if (typeof item !== 'object' || item === null) {
      errors.push(`${where}: 必须是映射`)
      return
    }
    const e = item as Record<string, unknown>
    const id = e.id
    const path = e.path
    if (typeof id !== 'string' || !id.trim()) errors.push(`${where}.id: 不能为空`)
    else if (ids.has(id)) errors.push(`${where}.id: 与其他笔记源重复`)
    else ids.add(id)
    if (typeof path !== 'string' || !path.trim()) errors.push(`${where}.path: 不能为空`)
    else if (paths.has(path)) errors.push(`${where}.path: 与其他笔记源重复`)
    else paths.add(path)
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') {
      errors.push(`${where}.enabled: 必须是布尔值`)
    }
    if (typeof e.created !== 'string' || !e.created.trim()) errors.push(`${where}.created: 不能为空`)
    entries.push({
      id: typeof id === 'string' ? id.trim() : '',
      path: typeof path === 'string' ? path.trim() : '',
      ...(typeof e.enabled === 'boolean' ? { enabled: e.enabled } : {}),
      created: typeof e.created === 'string' ? e.created.trim() : '',
    })
  })
  return { errors, entries }
}

/** 源清单契约：sources 列表，id/path/fingerprint 非空且 id 唯一。 */
export function validateNoteSourceManifest(doc: unknown): { errors?: string[]; spec?: NoteSourceManifestDoc } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射（sources）'] }
  const d = doc as Record<string, unknown>
  if (!Array.isArray(d.sources)) return { errors: ['sources: 必须是列表'] }
  const items: NoteSourceManifestItem[] = []
  const ids = new Set<string>()
  d.sources.forEach((raw, index) => {
    const where = `sources.${index + 1}`
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`${where}: 必须是映射`)
      return
    }
    const e = raw as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const path = typeof e.path === 'string' ? e.path.trim() : ''
    const fingerprint = typeof e.fingerprint === 'string' ? e.fingerprint.trim() : ''
    if (!id) errors.push(`${where}.id: 不能为空`)
    else if (ids.has(id)) errors.push(`${where}.id: 与其他条目重复`)
    else ids.add(id)
    if (!path) errors.push(`${where}.path: 不能为空`)
    if (!fingerprint) errors.push(`${where}.fingerprint: 不能为空`)
    items.push({
      id, path, fingerprint,
      ...(typeof e.title === 'string' && e.title.trim() ? { title: e.title.trim() } : {}),
      ...(typeof e.enabled === 'boolean' ? { enabled: e.enabled } : {}),
    })
  })
  if (errors.length) return { errors }
  return { spec: { sources: items } }
}

/** vault 输入路径 → vault 相对 posix 路径。拒绝学习中心内部与越界（..）路径——
 * 引擎管理区不收编为笔记源（课程文件另有通道），用户笔记在中心外。
 * 豁免区（V-3 #107 / V-5 #113）：学习中心内的 我的产出/ 整区与 projects/<id>/日志.md
 * 是学习者可读可编辑的文档区，放行注册（ADR-0026「复盘对象可被调度走既有注册通道」）；
 * 其余中心内路径（课程/状态/项目契约文件）维持拒绝。 */
export function normalizeSourcePath(vaultRoot: string, centerRoot: string, input: string): string {
  const p = input.replace(/\\/g, '/').trim()
  const abs = p.startsWith(`${vaultRoot}/`)
    ? p
    : p.startsWith('/')
      ? `${vaultRoot}${p}`
      : `${vaultRoot}/${p}`
  const norm = abs.replace(/\/{2,}/g, '/')
  if (!norm.startsWith(`${vaultRoot}/`)) throw new Error(`[note-source] 路径不在 vault 内：${input}`)
  const rel = norm.slice(vaultRoot.length + 1).replace(/\/+$/, '')
  if (rel.split('/').some(seg => seg === '..')) throw new Error(`[note-source] 路径不允许 ..（越界拒绝）：${input}`)
  const centerRel = centerRoot.slice(vaultRoot.length + 1)
  if (`${vaultRoot}/${rel}`.replace(/\/{2,}/g, '/') === centerRoot
    || rel === centerRel
    || rel.startsWith(`${centerRel}/`)) {
    if (isRegistrableCenterRel(centerRel, rel)) return rel
    throw new Error(`[note-source] 学习中心内部文件不注册为笔记源（引擎管理区另有通道）：${rel}`)
  }
  return rel
}

/** 递归收集目录下全部 .md（跳过点开头目录）；文件输入原样返回。
 * skip 谓词（收 abs 路径）命中时：目录不下钻、文件不收（V-1 #86 用户排除清单用）。 */
export async function collectNoteFiles(
  absPath: string, skip?: (abs: string) => boolean,
): Promise<Array<{ abs: string; filename: string }>> {
  let st
  try {
    st = await stat(absPath)
  } catch {
    throw new Error(`[note-source] 路径不存在：${absPath}`)
  }
  if (st.isFile()) {
    if (skip?.(absPath)) return []
    if (!absPath.toLowerCase().endsWith('.md')) {
      throw new Error(`[note-source] 只支持 .md 笔记（收到：${absPath}）`)
    }
    return [{ abs: absPath, filename: absPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? absPath }]
  }
  const out: Array<{ abs: string; filename: string }> = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${dir}/${entry.name}`
      if (skip?.(child)) continue
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(child)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push({ abs: child, filename: entry.name })
      }
    }
  }
  await walk(absPath)
  return out
}

// ---- 用户排除清单（V-1 #86：state/learnhub.json 的 note_source_excludes）----

/** 排除命中判定（纯函数）：精确（文件条目）或目录前缀（文件夹条目含其后代）。 */
export function isExcludedPath(rel: string, excludes: string[]): boolean {
  return excludes.some(e => rel === e || rel.startsWith(`${e}/`))
}

/** 读排除清单。条目做形状归一（反斜杠→posix、剥尾斜杠、滤空）——手编配置的常见
 * 写法不得静默失效（防收编是本清单的存在理由）；缺失/顶层形态不符回落空列表
 * ——learnhub.json 配置同款：ADR-0004 的 fail loud 针对学习者数据损坏，不是配置笔误。 */
export async function readNoteSourceExcludes(paths: Paths): Promise<string[]> {
  try {
    const doc = JSON.parse(await readFile(paths.learnhubConfigPath, 'utf8')) as {
      note_source_excludes?: unknown
    }
    if (!Array.isArray(doc.note_source_excludes)) return []
    return doc.note_source_excludes
      .filter((e): e is string => typeof e === 'string')
      .map(e => e.replace(/\\/g, '/').replace(/\/+$/, '').trim())
      .filter(e => !!e)
  } catch {
    return []
  }
}

/** 写排除清单（原子替换，保留 learnhub.json 其他字段）。入参须是已归一形态。 */
export async function writeNoteSourceExcludes(paths: Paths, excludes: string[]): Promise<void> {
  let prev: Record<string, unknown> = {}
  try {
    prev = JSON.parse(await readFile(paths.learnhubConfigPath, 'utf8')) as Record<string, unknown>
  } catch {
    // 无配置文件/损坏 → 全新写入
  }
  await atomicWrite(
    paths.learnhubConfigPath,
    JSON.stringify({ ...prev, note_source_excludes: excludes }, null, 1) + '\n',
  )
}

/** 镜像区源清单 IO（Missing = 合法空；Broken fail loud——它是镜像区契约文件）。 */
export class NoteSourceManifest {
  private paths: Paths
  constructor(paths: Paths) {
    this.paths = paths
  }

  async load(): Promise<NoteSourceManifestDoc> {
    const p = this.paths.noteSourceManifestPath
    if (!existsSync(p)) return { sources: [] }
    let doc: unknown
    try {
      doc = YAML.parse(await readFile(p, 'utf8'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`[note-source] 源清单 Broken（YAML 无法解析，位置：${p}）\n  ✗ ${message}`)
    }
    const v = validateNoteSourceManifest(doc)
    if (v.errors?.length) {
      throw new Error(`[note-source] 源清单 Broken（契约校验失败，位置：${p}）\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    return v.spec!
  }

  async save(doc: NoteSourceManifestDoc): Promise<void> {
    await mkdir(this.paths.noteSourceDir, { recursive: true })
    await writeFile(this.paths.noteSourceManifestPath, YAML.stringify(doc), 'utf8')
  }
}