/**
 * 课程注册表（吸收自 Python registry.py）。
 *
 * 学习中心/课程注册表.yaml 是中心级唯一课程清单：
 *   courses:
 *     - id: math-01 / name: 数学 / root: 数学 / enabled: true
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import type { CourseEntry } from './types.ts'
import type { Paths } from './paths.ts'

export class Registry {
  constructor(private paths: Paths) {}

  /** 读注册表 → 课程条目列表（保序）。文件缺失返回 []。 */
  async load(): Promise<CourseEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.registryPath, 'utf8')
    } catch {
      return []
    }
    const doc = YAML.parse(raw) as { courses?: unknown } | null
    const courses = doc?.courses
    if (!Array.isArray(courses)) return []
    return courses.filter((c): c is CourseEntry =>
      typeof c === 'object' && c !== null && typeof (c as CourseEntry).name === 'string')
  }

  async save(courses: CourseEntry[]): Promise<void> {
    await mkdir(this.paths.centerRoot, { recursive: true })
    await writeFile(this.paths.registryPath, YAML.stringify({ courses }), 'utf8')
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
