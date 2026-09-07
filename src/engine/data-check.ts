/**
 * Data Check（数据体检）：只读盘点学习者数据。
 *
 * 职责边界（ADR-0004）：Missing 是合法空状态，Broken 是对象存在但无法解析或
 * 未通过契约；本模块只读文件并汇总分类，不修复、不清理、不写入 Vault。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SchemaError, loadRegionDoc } from './graph.ts'
import { validateBank } from './question-bank.ts'
import { validateRegistry } from './registry.ts'
import { YAML } from './yaml.ts'
import { STAGES } from './types.ts'
import type { CourseEntry } from './types.ts'
import { safeFilename } from './paths.ts'
import type { Paths } from './paths.ts'

export type DataCheckArea = 'registry' | 'graph' | 'note' | 'question_bank'

export type DataCheckFindingLevel = 'missing' | 'broken'

export type DataCheckReason =
  | 'registry_missing'
  | 'registry_unreadable'
  | 'registry_yaml_parse'
  | 'registry_schema'
  | 'graph_missing'
  | 'graph_unreadable'
  | 'graph_yaml_parse'
  | 'graph_schema'
  | 'note_unreadable'
  | 'note_frontmatter_missing'
  | 'note_yaml_parse'
  | 'note_schema'
  | 'note_missing'
  | 'question_bank_unreadable'
  | 'question_bank_yaml_parse'
  | 'question_bank_schema'
  | 'question_bank_missing'

export interface DataCheckFinding {
  area: DataCheckArea
  level: DataCheckFindingLevel
  /** 稳定机读原因；UI/agent 不应解析 detail 文案。 */
  reason: DataCheckReason
  /** 人类可读定位，包含数据角色与绝对路径。 */
  location: string
  /** 人类可读补充信息；只用于展示，不作为程序分支依据。 */
  detail?: string
}

export interface DataCheckReport {
  status: 'ok' | 'missing' | 'broken'
  counts: { missing: number; broken: number }
  byArea: Record<DataCheckArea, { missing: number; broken: number }>
  inventory: {
    registryPresent: boolean
    courses: number
    graphFiles: number
    notes: number
    questionBanks: number
  }
  findings: DataCheckFinding[]
}

interface GraphNodeLike {
  name: string
  region: string
}

const CONTENT_STATUS_VALUES = ['draft', 'reviewed', 'flagged']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function push(
  findings: DataCheckFinding[],
  area: DataCheckArea,
  level: DataCheckFindingLevel,
  reason: DataCheckReason,
  location: string,
  detail?: string,
): void {
  findings.push({ area, level, reason, location, ...(detail ? { detail } : {}) })
}

function validateNoteContract(fm: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(fm)) return ['frontmatter 必须是映射']
  if (typeof fm.node !== 'string' || !fm.node.trim()) errors.push('node: 不能为空')
  if (fm.stage !== undefined && !(STAGES as readonly string[]).includes(String(fm.stage))) {
    errors.push(`stage: 非法状态（允许 ${STAGES.join('/')}）`)
  }
  if (fm.mastery !== undefined && (typeof fm.mastery !== 'number' || !Number.isFinite(fm.mastery))) {
    errors.push('mastery: 必须是数')
  }
  if (fm.practice_ema !== undefined && (typeof fm.practice_ema !== 'number' || !Number.isFinite(fm.practice_ema))) {
    errors.push('practice_ema: 必须是数')
  }
  if (fm.fsrs !== undefined && fm.fsrs !== null) {
    const fsrs = fm.fsrs
    if (!isRecord(fsrs)) {
      errors.push('fsrs: 必须是映射或 null')
    } else {
      for (const key of ['stability', 'difficulty'] as const) {
        if (typeof fsrs[key] !== 'number' || !Number.isFinite(fsrs[key])) errors.push(`fsrs.${key}: 必须是数`)
      }
      for (const key of ['due', 'last_review'] as const) {
        if (typeof fsrs[key] !== 'string' || !fsrs[key]) errors.push(`fsrs.${key}: 必须是日期文本`)
      }
      for (const key of ['reps', 'lapses'] as const) {
        if (typeof fsrs[key] !== 'number' || !Number.isInteger(fsrs[key]) || fsrs[key] < 0) {
          errors.push(`fsrs.${key}: 必须是非负整数`)
        }
      }
    }
  }
  if (fm.content !== undefined) {
    const content = fm.content
    if (!isRecord(content)) {
      errors.push('content: 必须是映射')
    } else {
      if (typeof content.version !== 'number' || !Number.isInteger(content.version) || content.version < 0) {
        errors.push('content.version: 必须是非负整数')
      }
      if (content.generated_at !== undefined && content.generated_at !== null && typeof content.generated_at !== 'string') {
        errors.push('content.generated_at: 必须是时间文本或 null')
      }
      if (!CONTENT_STATUS_VALUES.includes(String(content.status))) {
        errors.push(`content.status: 非法状态（允许 ${CONTENT_STATUS_VALUES.join('/')}）`)
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
              if (typeof section[key] !== 'string' || !section[key]) errors.push(`${where}.${key}: 不能为空`)
            }
            if (!['pending', 'ready'].includes(String(section.status))) errors.push(`${where}.status: 只允许 pending/ready`)
            if (typeof section.version !== 'number' || !Number.isInteger(section.version) || section.version < 0) {
              errors.push(`${where}.version: 必须是非负整数`)
            }
          })
        }
      }
    }
  }
  if (fm.practice !== undefined) {
    const practice = fm.practice
    if (!isRecord(practice)) {
      errors.push('practice: 必须是映射')
    } else {
      for (const key of ['attempts', 'correct'] as const) {
        if (typeof practice[key] !== 'number' || !Number.isInteger(practice[key]) || practice[key] < 0) {
          errors.push(`practice.${key}: 必须是非负整数`)
        }
      }
    }
  }
  return errors
}

function splitFrontmatterForCheck(text: string): { raw: string | null; malformed: boolean } {
  if (!text.startsWith('---')) return { raw: null, malformed: false }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { raw: null, malformed: true }
  const after = text.slice(end + 4)
  if (after && !after.startsWith('\n') && !after.startsWith('\r')) return { raw: null, malformed: true }
  return { raw: text.slice(3, end), malformed: false }
}

async function readYamlDoc(path: string): Promise<{ text?: string; doc?: unknown; readError?: string; parseError?: string }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return { readError: errorText(err) }
  }
  try {
    return { text, doc: YAML.parse(text) }
  } catch (err) {
    return { text, parseError: errorText(err) }
  }
}

async function listFiles(path: string, ext: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter(e => e.isFile() && e.name.endsWith(ext)).sort((a, b) => a.name.localeCompare(b.name))
    .map(e => join(path, e.name))
}

async function listMarkdown(path: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child)
    }
  }
  await walk(path)
  return out
}

async function scanNotes(
  findings: DataCheckFinding[],
  courseName: string,
  courseDir: string,
): Promise<string[]> {
  const files = await listMarkdown(courseDir)
  for (const path of files) {
    const where = `课程「${courseName}」笔记 ${path}`
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      push(findings, 'note', 'broken', 'note_unreadable', where, errorText(err))
      continue
    }
    const { raw, malformed } = splitFrontmatterForCheck(text)
    if (raw === null) {
      push(findings, 'note', 'broken', 'note_frontmatter_missing', where,
        malformed ? 'frontmatter 没有闭合的 ---。' : 'Markdown 开头没有 frontmatter。')
      continue
    }
    let doc: unknown
    try {
      doc = YAML.parse(raw)
    } catch (err) {
      push(findings, 'note', 'broken', 'note_yaml_parse', where, errorText(err))
      continue
    }
    const errors = validateNoteContract(doc)
    if (errors.length) push(findings, 'note', 'broken', 'note_schema', where, errors.join('；'))
  }
  return files
}

async function scanBanks(
  findings: DataCheckFinding[],
  courseName: string,
  bankDir: string,
  nodes: GraphNodeLike[],
): Promise<number> {
  const files = await listFiles(bankDir, '.yaml')
  const byPath = new Map(files.map(path => [resolve(path).toLowerCase(), path]))
  const checked = new Set<string>()

  const validateOne = async (path: string, expectedNode?: string): Promise<void> => {
    const where = `课程「${courseName}」题库 ${path}`
    const result = await readYamlDoc(path)
    if (result.readError) {
      push(findings, 'question_bank', 'broken', 'question_bank_unreadable', where, result.readError)
      return
    }
    if (result.parseError) {
      push(findings, 'question_bank', 'broken', 'question_bank_yaml_parse', where, result.parseError)
      return
    }
    const result2 = validateBank(result.doc, expectedNode)
    if (result2.errors) {
      push(findings, 'question_bank', 'broken', 'question_bank_schema', where, result2.errors.join('；'))
    }
  }

  for (const node of nodes) {
    const expectedPath = join(bankDir, `${safeFilename(node.name)}.yaml`)
    const key = resolve(expectedPath).toLowerCase()
    const actual = byPath.get(key)
    if (!actual) {
      push(
        findings,
        'question_bank',
        'missing',
        'question_bank_missing',
        `课程「${courseName}」节点「${node.name}」题库 ${expectedPath}`,
      )
      continue
    }
    checked.add(key)
    await validateOne(actual, node.name)
  }
  for (const [key, path] of byPath) {
    if (!checked.has(key)) await validateOne(path)
  }
  return files.length
}

async function scanCourse(
  findings: DataCheckFinding[],
  courseName: string,
  courseRoot: string,
  dataDir: string,
  courseDir: string,
  bankDir: string,
): Promise<{ graphFiles: number; notes: number; banks: number; nodes: GraphNodeLike[] }> {
  const graphFiles = await listFiles(dataDir, '.yaml')
  const nodes: GraphNodeLike[] = []
  if (!graphFiles.length) {
    push(
      findings,
      'graph',
      'missing',
      'graph_missing',
      `课程「${courseName}」图目录 ${dataDir}`,
      '没有可加载的 data/*.yaml。',
    )
  }

  const regionNames = new Set<string>()
  const nodeNames = new Set<string>()
  const noteFiles = new Set((await listMarkdown(courseDir)).map(path => resolve(path).toLowerCase()))
  for (const path of graphFiles) {
    const where = `课程「${courseName}」图文件 ${path}`
    const result = await readYamlDoc(path)
    if (result.readError) {
      push(findings, 'graph', 'broken', 'graph_unreadable', where, result.readError)
      continue
    }
    if (result.parseError) {
      push(findings, 'graph', 'broken', 'graph_yaml_parse', where, result.parseError)
      continue
    }
    try {
      const region = loadRegionDoc(result.doc, path)
      if (regionNames.has(region.name)) {
        push(findings, 'graph', 'broken', 'graph_schema', where, `区「${region.name}」与其他文件重复。`)
      } else {
        regionNames.add(region.name)
      }
      for (const block of region.blocks) {
        for (const node of block.nodes) {
          if (nodeNames.has(node.name)) {
            push(findings, 'graph', 'broken', 'graph_schema', where, `节点「${node.name}」与其他文件重复。`)
          } else {
            nodeNames.add(node.name)
            nodes.push({ name: node.name, region: region.name })
          }
        }
      }
    } catch (err) {
      const level = err instanceof SchemaError ? 'graph_schema' : 'graph_yaml_parse'
      push(findings, 'graph', 'broken', level, where, errorText(err))
    }
  }

  for (const node of nodes) {
    const notePath = join(courseDir, safeFilename(node.region), `${safeFilename(node.name)}.md`)
    if (!noteFiles.has(resolve(notePath).toLowerCase())) {
      push(
        findings,
        'note',
        'missing',
        'note_missing',
        `课程「${courseName}」节点「${node.name}」笔记 ${notePath}`,
      )
    }
  }

  const noteFilesList = await scanNotes(findings, courseName, courseDir)
  const bankCount = await scanBanks(findings, courseName, bankDir, nodes)
  return { graphFiles: graphFiles.length, notes: noteFilesList.length, banks: bankCount, nodes }
}

/** 一次只读体检。注册表损坏时无法安全展开课程，因此只报告注册表本身。 */
export async function dataCheck(paths: Paths): Promise<DataCheckReport> {
  const findings: DataCheckFinding[] = []
  const inventory = { registryPresent: false, courses: 0, graphFiles: 0, notes: 0, questionBanks: 0 }
  const registryWhere = `课程注册表 ${paths.registryPath}`

  let registryRaw: unknown
  try {
    const text = await readFile(paths.registryPath, 'utf8')
    inventory.registryPresent = true
    try {
      registryRaw = YAML.parse(text)
    } catch (err) {
      push(findings, 'registry', 'broken', 'registry_yaml_parse', registryWhere, errorText(err))
    }
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT') {
      push(findings, 'registry', 'missing', 'registry_missing', registryWhere)
    } else {
      push(findings, 'registry', 'broken', 'registry_unreadable', registryWhere, errorText(err))
    }
  }

  let courses: CourseEntry[] = []
  if (inventory.registryPresent && registryRaw !== undefined) {
    const checked = validateRegistry(registryRaw)
    if (checked.errors.length) {
      push(findings, 'registry', 'broken', 'registry_schema', registryWhere, checked.errors.join('；'))
    } else {
      courses = checked.courses
      inventory.courses = courses.length
    }
  }

  for (const course of courses) {
    const courseName = String(course.name)
    const courseRoot = paths.courseRoot(String(course.root))
    const result = await scanCourse(
      findings,
      courseName,
      courseRoot,
      paths.dataDir(String(course.root)),
      paths.courseDir(String(course.root)),
      paths.bankDir(String(course.root)),
    )
    inventory.graphFiles += result.graphFiles
    inventory.notes += result.notes
    inventory.questionBanks += result.banks
  }

  const byArea: DataCheckReport['byArea'] = {
    registry: { missing: 0, broken: 0 },
    graph: { missing: 0, broken: 0 },
    note: { missing: 0, broken: 0 },
    question_bank: { missing: 0, broken: 0 },
  }
  for (const finding of findings) {
    byArea[finding.area][finding.level]++
  }
  const missing = findings.filter(f => f.level === 'missing').length
  const broken = findings.filter(f => f.level === 'broken').length
  return {
    status: broken ? 'broken' : missing ? 'missing' : 'ok',
    counts: { missing, broken },
    byArea,
    inventory,
    findings,
  }
}
