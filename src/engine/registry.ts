/**
 * 课程注册表（吸收自 Python registry.py）。
 *
 * 学习中心/课程注册表.yaml 是中心级唯一课程清单：
 *   courses:
 *     - id: math-01 / name: 数学 / root: 数学 / enabled: true
 *
 * 契约（ADR-0004 / #6）：注册表缺失是合法空状态；文件存在但 YAML 或条目
 * 不合契约时必须 fail loud，不能被读成空课程列表或静默过滤坏条目。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import { YAML } from './yaml.ts'
import type { CourseEntry, NoteSourceEntry } from './types.ts'
import { validateNoteSourceEntries } from './note-source.ts'
import type { Paths } from './paths.ts'

/** 注册表契约校验（数据体检与 Registry 读侧共用同一口径）。
 * 合法条目：name/root 非空且各自唯一；可选 id（出现则非空且唯一）、enabled（布尔）、tags（字符串列表）。
 * 可选 note_sources 域（C1 #59 笔记源注册身份）：id/path 非空且各自唯一、enabled 布尔、created 非空。 */
export function validateRegistry(raw: unknown): { errors: string[]; courses: CourseEntry[]; noteSources: NoteSourceEntry[] } {
  const errors: string[] = []
  const courses: CourseEntry[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { errors: ['(顶层): 必须是映射（courses）'], courses, noteSources: [] }
  }
  const doc = raw as Record<string, unknown>
  if (!Array.isArray(doc.courses)) return { errors: ['courses: 必须是列表'], courses, noteSources: [] }

  const names = new Set<string>()
  const roots = new Set<string>()
  const ids = new Set<string>()
  doc.courses.forEach((item, index) => {
    const where = `courses.${index + 1}`
    if (typeof item !== 'object' || item === null) {
      errors.push(`${where}: 必须是映射`)
      return
    }
    const entry = item as Record<string, unknown>
    const name = entry.name
    const root = entry.root
    if (typeof name !== 'string' || !name.trim()) errors.push(`${where}.name: 不能为空`)
    if (typeof root !== 'string' || !root.trim()) errors.push(`${where}.root: 不能为空`)
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      errors.push(`${where}.enabled: 必须是布尔值`)
    }
    if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some(tag => typeof tag !== 'string'))) {
      errors.push(`${where}.tags: 必须是字符串列表`)
    }
    const id = entry.id
    if (id !== undefined) {
      if (typeof id !== 'string' || !id.trim()) errors.push(`${where}.id: 不能为空`)
      else if (ids.has(id)) errors.push(`${where}.id: 与其他课程重复`)
      else ids.add(id)
    }
    if (typeof name === 'string' && name.trim()) {
      if (names.has(name)) errors.push(`${where}.name: 与其他课程重复`)
      else names.add(name)
    }
    if (typeof root === 'string' && root.trim()) {
      if (roots.has(root)) errors.push(`${where}.root: 与其他课程重复`)
      else roots.add(root)
    }
    courses.push({
      ...(typeof id === 'string' && id.trim() ? { id: id.trim() } : {}),
      name: typeof name === 'string' ? name.trim() : '',
      root: typeof root === 'string' ? root.trim() : '',
      ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
      ...(Array.isArray(entry.tags) ? { tags: entry.tags.map(String) } : {}),
    })
  })
  const notes = validateNoteSourceEntries(doc.note_sources)
  errors.push(...notes.errors)
  return { errors, courses, noteSources: notes.entries }
}

export class Registry {
  constructor(private paths: Paths, private fs: VaultFs) {}

  /** 读注册表 → {courses, noteSources}（保序）。文件缺失返回两空表；已存在但 Broken 抛错。 */
  private async loadDoc(): Promise<{ courses: CourseEntry[]; noteSources: NoteSourceEntry[] }> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.registryPath)
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return { courses: [], noteSources: [] }
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`[registry] 课程注册表 Broken（无法读取）: ${this.paths.registryPath}\n  ✗ ${message}`)
    }
    let doc: unknown
    try {
      doc = YAML.parse(raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`[registry] 课程注册表 Broken（YAML 无法解析）: ${this.paths.registryPath}\n  ✗ ${message}`)
    }
    const checked = validateRegistry(doc)
    if (checked.errors.length) {
      throw new Error(`[registry] 课程注册表 Broken（契约校验失败）: ${this.paths.registryPath}\n${checked.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    return { courses: checked.courses, noteSources: checked.noteSources }
  }

  /** 读注册表 → 课程条目列表（保序）。文件缺失返回 []；已存在但 Broken 抛错。 */
  async load(): Promise<CourseEntry[]> {
    return (await this.loadDoc()).courses
  }

  /** 笔记源注册身份（note_sources 域；域缺失 = 合法空）。与课程同一契约门。 */
  async loadNoteSources(): Promise<NoteSourceEntry[]> {
    return (await this.loadDoc()).noteSources
  }

  /** 全量写注册表。noteSources 省略时保留盘上现值——既有课程写方（courseDelete 等）
   * 不需要知道笔记源域的存在，也不能被它们无声抹掉；盘上注册表 Broken 时此处同样抛错
   * （不静默降级为空域覆写）。 */
  async save(courses: CourseEntry[], noteSources?: NoteSourceEntry[]): Promise<void> {
    const sources = noteSources ?? (await this.loadDoc()).noteSources
    const doc: Record<string, unknown> = { courses }
    if (sources.length) doc.note_sources = sources
    await atomicWrite(this.paths.registryPath, YAML.stringify(doc), this.fs)
  }

  /** 按 name 或 id 精确匹配；未找到返回 null。 */
  async get(key: string): Promise<CourseEntry | null> {
    for (const c of await this.load()) {
      if (key === c.name || key === c.id) return c
    }
    return null
  }

  /** 全部启用中的课程（保序）。 */
  async enabled(): Promise<CourseEntry[]> {
    return (await this.load()).filter(c => c.enabled !== false)
  }

  /** CLI 课程选择语义：显式指定 → 精确匹配；未指定 → 唯一启用课程。 */
  async resolve(key?: string): Promise<CourseEntry> {
    if (key) {
      const c = await this.get(key)
      if (!c) {
        const known = (await this.load()).map(x => `${x.name}(${x.id ?? '?'})`).join('、')
        throw new Error(`[learnhub] 注册表中没有课程「${key}」。现有：${known || '（空）'}`)
      }
      if (c.enabled === false) throw new Error(`[learnhub] 课程「${c.name}」已停用。`)
      return c
    }
    const en = await this.enabled()
    if (en.length === 1) return en[0]
    if (!en.length) throw new Error('[learnhub] 没有启用中的课程。')
    throw new Error(`[learnhub] 多门课程启用中，请用 --course 指定：${en.map(c => c.name).join('、')}`)
  }
}
