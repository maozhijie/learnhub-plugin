/**
 * Data Check（数据体检）：只读盘点学习者数据。
 *
 * 职责边界（ADR-0004）：Missing 是合法空状态，Broken 是对象存在但无法解析或
 * 未通过契约；本模块只读文件并汇总分类，不修复、不清理、不写入 Vault。
 * V-6（#109）起盘点覆盖全库注册源：每个注册表 note_sources 条目都做存在性 +
 * 指纹盘点（Missing/漂移计数进 inventory、源文件缺失报 finding）——用户笔记本身
 * 仍**永不判 Broken**（漂移是状态不是损坏，逐源明细以 noteSourceList 为准）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SchemaError, loadRegionDoc } from './graph.ts'
import { validateBank } from './question-bank.ts'
import { validateRegistry } from './registry.ts'
import { classifySource, fingerprintOf, validateNoteSourceManifest } from './note-source.ts'
import { validateLearnerCards } from './learner-cards.ts'
import { validateNoteFrontmatter } from './notes.ts'
import { YAML } from './yaml.ts'
import type { CourseEntry } from './types.ts'
import { safeFilename } from './paths.ts'
import type { Paths } from './paths.ts'

export type DataCheckArea = 'registry' | 'graph' | 'note' | 'question_bank' | 'note_source' | 'learner_cards'

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
  | 'note_source_manifest_unreadable'
  | 'note_source_manifest_yaml_parse'
  | 'note_source_manifest_schema'
  | 'note_source_mirror_inconsistent'
  | 'note_source_file_missing'
  | 'note_source_file_unreadable'
  | 'note_source_bank_yaml_parse'
  | 'note_source_bank_schema'
  | 'learner_card_yaml_parse'
  | 'learner_card_schema'

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
    /** 已出题的笔记源镜像题库数。 */
    noteSourceBanks: number
    /** 全库注册源漂移盘点（V-6 #109）：注册表条目逐源的存在性 + 指纹状态计数。
     * missing/drifted 是合法状态不是损坏（ADR-0004），逐源明细以 noteSourceList 为准。 */
    noteSourceFiles: { total: number; ok: number; missing: number; drifted: number; inconsistent: number }
  }
  findings: DataCheckFinding[]
}

interface GraphNodeLike {
  name: string
  region: string
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
    const checked = validateNoteFrontmatter(doc)
    const errors = checked.errors
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

/** 笔记源体检（C1 #59 / ADR-0010）：镜像区契约文件（源清单/题库）按 Missing/Broken
 * 纪律盘点；用户笔记本身**不是** Broken 对象（永不判 Broken——漂移是状态不是损坏）。
 * 注册表条目 × 源清单条目双向对账——单边缺失 = 镜像不一致（Broken 级，说明有人手改
 * 了镜像区）。V-6（#109）起对全库注册源逐源盘点：存在性 + 指纹比对（与引擎读路径
 * classifySource 同口径），计数进 inventory；源文件缺失另报 Missing 级 finding
 * （合法状态、卡池挂起，但盘点必须显式可见——ADR-0004 不静默）。 */
async function scanNoteSources(
  findings: DataCheckFinding[],
  paths: Paths,
  noteSources: Array<{ id: string; path: string }>,
): Promise<{ banks: number; files: DataCheckReport['inventory']['noteSourceFiles'] }> {
  const files: DataCheckReport['inventory']['noteSourceFiles'] = {
    total: noteSources.length, ok: 0, missing: 0, drifted: 0, inconsistent: 0,
  }
  const countAllInconsistent = () => { files.inconsistent = noteSources.length }
  let banks = 0
  const manifestPath = paths.noteSourceManifestPath
  let itemsById = new Map<string, { path: string; fingerprint: string }>()
  if (existsSync(manifestPath)) {
    const where = `笔记源清单 ${manifestPath}`
    let text: string
    try {
      text = await readFile(manifestPath, 'utf8')
    } catch (err) {
      push(findings, 'note_source', 'broken', 'note_source_manifest_unreadable', where, errorText(err))
      countAllInconsistent()
      return { banks, files }
    }
    let doc: unknown
    try {
      doc = YAML.parse(text)
    } catch (err) {
      push(findings, 'note_source', 'broken', 'note_source_manifest_yaml_parse', where, errorText(err))
      countAllInconsistent()
      return { banks, files }
    }
    const v = validateNoteSourceManifest(doc)
    if (v.errors) {
      push(findings, 'note_source', 'broken', 'note_source_manifest_schema', where, v.errors.join('；'))
      countAllInconsistent()
      return { banks, files }
    }
    itemsById = new Map(v.spec!.sources.map(s => [s.id, s]))
    const entryIds = new Set(noteSources.map(e => e.id))
    for (const id of itemsById.keys()) {
      if (!entryIds.has(id)) {
        push(findings, 'note_source', 'broken', 'note_source_mirror_inconsistent', where,
          `源清单条目「${id}」在注册表 note_sources 域没有对应条目（镜像不一致）`)
      }
    }
  } else if (noteSources.length) {
    push(findings, 'note_source', 'broken', 'note_source_mirror_inconsistent', `笔记源清单 ${manifestPath}`,
      `注册表有 ${noteSources.length} 个笔记源但源清单缺失（镜像不一致）`)
    countAllInconsistent()
    return { banks, files }
  }
  const entryIdSet = new Set(itemsById.keys())
  for (const e of noteSources) {
    if (!entryIdSet.has(e.id)) {
      push(findings, 'note_source', 'broken', 'note_source_mirror_inconsistent',
        `笔记源「${e.id}」（${e.path}）`, '注册表条目在源清单中没有对应条目（镜像不一致）')
      files.inconsistent++
    }
    const abs = `${paths.vaultRoot}/${e.path}`
    if (!existsSync(abs)) {
      files.missing++
      push(findings, 'note_source', 'missing', 'note_source_file_missing',
        `笔记源「${e.id}」源文件 ${abs}`,
        '源文件缺失：卡池挂起——改名/移动用 learnhub_note_source_relink 重连，或重新注册/解除。')
      continue
    }
    if (!entryIdSet.has(e.id)) continue // 指纹无从核对（镜像不一致已报）
    let raw: string
    try {
      raw = await readFile(abs, 'utf8')
    } catch (err) {
      files.inconsistent++
      push(findings, 'note_source', 'broken', 'note_source_file_unreadable',
        `笔记源「${e.id}」源文件 ${abs}`, errorText(err))
      continue
    }
    files[classifySource(true, itemsById.get(e.id)!.fingerprint === fingerprintOf(raw))]++
    const bankPath = join(paths.noteSourceDir, '题库', `${safeFilename(e.id)}.yaml`)
    if (!existsSync(bankPath)) continue // 未出题 = 合法空卡池
    banks++
    const where = `笔记源题库 ${bankPath}`
    const result = await readYamlDoc(bankPath)
    if (result.readError) {
      push(findings, 'note_source', 'broken', 'note_source_bank_yaml_parse', where, result.readError)
      continue
    }
    if (result.parseError) {
      push(findings, 'note_source', 'broken', 'note_source_bank_yaml_parse', where, result.parseError)
      continue
    }
    const v = validateBank(result.doc, e.id)
    if (v.errors) {
      push(findings, 'note_source', 'broken', 'note_source_bank_schema', where, v.errors.join('；'))
    }
  }
  return { banks, files }
}

/** 我的卡域体检（E1/#68）：课程根/我的卡/<节点>.yaml 存在但坏 = Broken（队列侧
 * 跳过不阻塞刷卡，这里负责把损坏显式报出——学习者数据不得无声降级）。 */
async function scanLearnerCards(
  findings: DataCheckFinding[],
  paths: Paths,
  courses: Array<{ name: string; root: string }>,
): Promise<void> {
  for (const course of courses) {
    const dir = paths.learnerCardsDir(String(course.root))
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 该课程还没有任何我的卡：合法空态
    }
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.yaml')).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const where = `课程「${String(course.name)}」我的卡 ${path}`
      const result = await readYamlDoc(path)
      if (result.readError) {
        push(findings, 'learner_cards', 'broken', 'learner_card_yaml_parse', where, result.readError)
        continue
      }
      if (result.parseError) {
        push(findings, 'learner_cards', 'broken', 'learner_card_yaml_parse', where, result.parseError)
        continue
      }
      const v = validateLearnerCards(result.doc)
      if (v.errors) {
        push(findings, 'learner_cards', 'broken', 'learner_card_schema', where, v.errors.join('；'))
      }
    }
  }
}

/** 一次只读体检。注册表损坏时无法安全展开课程，因此只报告注册表本身。 */
export async function dataCheck(paths: Paths): Promise<DataCheckReport> {
  const findings: DataCheckFinding[] = []
  const inventory: DataCheckReport['inventory'] = {
    registryPresent: false, courses: 0, graphFiles: 0, notes: 0, questionBanks: 0, noteSourceBanks: 0,
    noteSourceFiles: { total: 0, ok: 0, missing: 0, drifted: 0, inconsistent: 0 },
  }
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
  let noteSources: Array<{ id: string; path: string }> = []
  if (inventory.registryPresent && registryRaw !== undefined) {
    const checked = validateRegistry(registryRaw)
    if (checked.errors.length) {
      push(findings, 'registry', 'broken', 'registry_schema', registryWhere, checked.errors.join('；'))
    } else {
      courses = checked.courses
      noteSources = checked.noteSources
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

  const noteSourceScan = await scanNoteSources(findings, paths, noteSources)
  inventory.noteSourceBanks = noteSourceScan.banks
  inventory.noteSourceFiles = noteSourceScan.files
  await scanLearnerCards(findings, paths, courses)

  const byArea: DataCheckReport['byArea'] = {
    registry: { missing: 0, broken: 0 },
    graph: { missing: 0, broken: 0 },
    note: { missing: 0, broken: 0 },
    question_bank: { missing: 0, broken: 0 },
    note_source: { missing: 0, broken: 0 },
    learner_cards: { missing: 0, broken: 0 },
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
