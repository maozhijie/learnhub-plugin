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
import { validateConceptRegistry } from './concepts.ts'
import { validateAnchor } from './seed.ts'
import { classifySource, fingerprintOf, validateNoteSourceManifest } from './note-source.ts'
import { validateLearnerCards } from './learner-cards.ts'
import { validateErrorCards } from './error-cards.ts'
import { validateNoteFrontmatter } from './notes.ts'
import { YAML } from './yaml.ts'
import { parseSchemaBlock } from './schema.ts'
import { readProbationLedger, foldProbation, recheckDue, learningDaysOf } from './probation.ts'
import { readDayCutoff } from './xp.ts'
import { readJsonlLines } from './io.ts'
import { dayOfTs, todayStr } from './dates.ts'
import type { CourseEntry, PracticeRec, ReviewRec } from './types.ts'
import { safeFilename } from './paths.ts'
import type { Paths } from './paths.ts'

export type DataCheckArea = 'registry' | 'graph' | 'note' | 'question_bank' | 'note_source' | 'learner_cards' | 'error_cards' | 'concept_registry' | 'endpoint_anchor' | 'archive' | 'probation_ledger'

export type DataCheckFindingLevel = 'missing' | 'broken' | 'archived' | 'hint'

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
  | 'note_source_bank_yaml_parse'
  | 'note_source_bank_schema'
  | 'learner_card_yaml_parse'
  | 'learner_card_schema'
  | 'error_card_yaml_parse'
  | 'error_card_schema'
  | 'concept_registry_unreadable'
  | 'concept_registry_yaml_parse'
  | 'concept_registry_schema'
  | 'endpoint_anchor_unreadable'
  | 'endpoint_anchor_json_parse'
  | 'endpoint_anchor_schema'
  | 'endpoint_anchor_dangling'
  | 'pre_v2_archive'
  | 'pre_v2_artifact'
  | 'probation_overdue'

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
  counts: { missing: number; broken: number; archived: number; hint: number }
  byArea: Record<DataCheckArea, { missing: number; broken: number; archived: number; hint: number }>
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
    /** 断裂存档区盘点（#138 / ADR-0034）：present = 存档区在盘；files = 区内文件总数
     *（不校验内容——存档只增不删、引擎读侧永不读取，数文件即盘点）。 */
    archive: { present: boolean; files: number }
    /** 概念登记表盘点（#141）：present = 在盘课程数；entries = 条目总数（跨断裂
     * 存活的档案坐标系，与存档区互斥——登记表永不入存档清单）。 */
    conceptRegistries: { present: number; entries: number }
    /** 终点锚盘点（#142）：present = 已播种课程数（锚在盘；缺席 = 未播种 Missing 合法）。 */
    endpointAnchors: { present: number }
    /** 边实验账本盘点（#146）：present = 在册课程数；entries/inFlight/overdue = 账本
     * 行数、在途复诊与到期未决（overdue 是 hint 提示类，不进 status）。 */
    probationLedgers: { present: number; entries: number; inFlight: number; overdue: number }
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
 * classifySource 同口径），计数进 inventory（inconsistent = 指纹无法核对：清单缺条目
 * 或文件不可读）；源文件缺失另报 Missing 级 finding（合法状态、卡池挂起，但盘点必须
 * 显式可见——ADR-0004 不静默）。 */
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
    } catch {
      // 用户笔记不可读（权限/同步锁）不是 Broken（它不是引擎契约对象，永不判
      // Broken）；按「指纹无法核对」归 inconsistent 计数——不静默，读路径
      // （noteSourceList）会以异常显式浮出
      files.inconsistent++
      continue
    }
    const status = classifySource(true, itemsById.get(e.id)!.fingerprint === fingerprintOf(raw))
    files[status]++
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

/** 错误对比卡域体检（C-3/#82）：课程根/错误卡/<节点>.yaml 存在但坏 = Broken
 * （队列/生成/清单侧跳过不阻塞其他卡，这里负责把损坏显式报出——学习者数据
 * 不得无声降级）。 */
async function scanErrorCards(
  findings: DataCheckFinding[],
  paths: Paths,
  courses: Array<{ name: string; root: string }>,
): Promise<void> {
  for (const course of courses) {
    const dir = paths.errorCardsDir(String(course.root))
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 该课程还没有任何错误卡：合法空态
    }
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.yaml')).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const where = `课程「${String(course.name)}」错误卡 ${path}`
      const result = await readYamlDoc(path)
      if (result.readError) {
        push(findings, 'error_cards', 'broken', 'error_card_yaml_parse', where, result.readError)
        continue
      }
      if (result.parseError) {
        push(findings, 'error_cards', 'broken', 'error_card_yaml_parse', where, result.parseError)
        continue
      }
      const v = validateErrorCards(result.doc)
      if (v.errors) {
        push(findings, 'error_cards', 'broken', 'error_card_schema', where, v.errors.join('；'))
      }
    }
  }
}

/** 概念登记表体检（#141 / #122 契约 v0.1）：课程根/概念登记表.yaml——文件缺失 =
 * 合法空态（选填域，与我的卡/错误卡同款：缺席零 finding，inventory 计数即盘点可见）；
 * 存在但不可读/YAML 坏/契约违约（名字联合唯一等）= Broken。登记表跨宣告式断裂存活，
 * 永不入存档清单。 */
async function scanConceptRegistry(
  findings: DataCheckFinding[],
  courseName: string,
  path: string,
): Promise<{ present: boolean; entries: number }> {
  const where = `课程「${courseName}」概念登记表 ${path}`
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT') return { present: false, entries: 0 } // 合法空态：跟随生长批铸名后出现
    push(findings, 'concept_registry', 'broken', 'concept_registry_unreadable', where, errorText(err))
    return { present: true, entries: 0 }
  }
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch (err) {
    push(findings, 'concept_registry', 'broken', 'concept_registry_yaml_parse', where, errorText(err))
    return { present: true, entries: 0 }
  }
  const checked = validateConceptRegistry(doc)
  if (checked.errors.length) {
    push(findings, 'concept_registry', 'broken', 'concept_registry_schema', where, checked.errors.join('；'))
    return { present: true, entries: 0 }
  }
  return { present: true, entries: checked.entries.length }
}

/** 终点锚体检（#142 / ADR-0033）：课程根/state/终点锚.json——文件缺失 = 未播种
 * （Missing 合法空态，零 finding，inventory 计数即盘点可见）；存在但不可读/JSON 坏/
 * 契约违约/锚悬空（终点节点不在图内——edit 直改被受理门拒绝后的残余形态）= Broken。
 * 锚无直改通道：换终点只走重新种子提案（kind=seed, mode=reseed）。 */
async function scanEndpointAnchor(
  findings: DataCheckFinding[],
  courseName: string,
  path: string,
  nodeNames: Set<string>,
): Promise<{ present: boolean }> {
  const where = `课程「${courseName}」终点锚 ${path}`
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT') return { present: false } // 合法空态：种子提案 apply 后出现
    push(findings, 'endpoint_anchor', 'broken', 'endpoint_anchor_unreadable', where, errorText(err))
    return { present: true }
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    push(findings, 'endpoint_anchor', 'broken', 'endpoint_anchor_json_parse', where,
      `${errorText(err)}——锚无直改通道，换终点走重新种子提案（kind=seed, mode=reseed）`)
    return { present: true }
  }
  const checked = validateAnchor(doc)
  if (checked.errors.length) {
    push(findings, 'endpoint_anchor', 'broken', 'endpoint_anchor_schema', where,
      `${checked.errors.join('；')}——锚无直改通道，换终点走重新种子提案（kind=seed, mode=reseed）`)
    return { present: true }
  }
  const anchor = checked.anchor!
  if (!nodeNames.has(anchor.endpoint)) {
    push(findings, 'endpoint_anchor', 'broken', 'endpoint_anchor_dangling', where,
      `终点节点「${anchor.endpoint}」不在图内——锚悬空；换终点走重新种子提案（kind=seed, mode=reseed），锚不直改`)
  }
  return { present: true }
}

/** 断裂存档区盘点（#138 / ADR-0034）：archived 是显式的第三类——既非 Missing 也非
 * Broken，不进 status、不校验内容，只数文件数并对照 learnhub.json 的断裂史。
 * - pre_v2_archive：存档区在盘 → 信息级盘点一条（文件总数 + 断裂日期）。
 * - pre_v2_artifact：断裂史（schema.breaks）在档但存档区缺失——记录与实物对不上，
 *   提示级浮出（不判损坏：存档可能被学习者手工挪动，引擎读侧永不读取）。 */
async function scanArchive(
  findings: DataCheckFinding[],
  paths: Paths,
  breaks: Array<{ date?: string; archived?: string[] }>,
): Promise<{ present: boolean; files: number }> {
  let files = 0
  let present = false
  try {
    const entries = await readdir(paths.archiveDir, { withFileTypes: true })
    present = true
    const count = async (dir: string): Promise<number> => {
      let n = 0
      let children
      try {
        children = await readdir(dir, { withFileTypes: true })
      } catch {
        return 0
      }
      for (const child of children) {
        if (child.isDirectory()) n += await count(join(dir, child.name))
        else if (child.isFile()) n++
      }
      return n
    }
    for (const entry of entries) {
      if (entry.isDirectory()) files += await count(join(paths.archiveDir, entry.name))
      else if (entry.isFile()) files++
    }
  } catch {
    present = false
  }
  if (present) {
    const dates = [...new Set(breaks.map(b => b.date).filter(Boolean))].join('、')
    push(findings, 'archive', 'archived', 'pre_v2_archive', `存档区 ${paths.archiveDir}`,
      `pre-v2 存档 ${files} 个文件（只增不删、读侧永不读取）${dates ? `；断裂史：${dates}` : ''}`)
  } else if (breaks.length) {
    push(findings, 'archive', 'archived', 'pre_v2_artifact', `存档区 ${paths.archiveDir}`,
      'learnhub.json 记有断裂史但存档区不在盘上（可能被手工挪动；引擎读侧永不读取，仅提示对账）。')
  }
  return { present, files }
}

/** 边实验账本盘点（#146 / 词条「边实验账本」「复诊」）：到期未决是提示级（hint，
 * 第四类 level——既非 Missing 也非 Broken 也非 archived，不进 status）：结算钩子是
 * 幂等重试（队列空闲检查点/手动触发），「该决未决」只说明结算未跑到或剪除提案被拒，
 * 让它可见即体检的本分，不判损坏。学习日序列与结算钩子同口径（practice ∪ 到期
 * 复习首推，按日界折叠），保证提示与结算的到期判定不分叉。 */
async function scanProbationLedger(
  findings: DataCheckFinding[],
  courseName: string,
  paths: Paths,
  root: string,
  cutoff: number,
  today: string,
): Promise<{ present: boolean; entries: number; inFlight: number; overdue: number }> {
  const ledger = await readProbationLedger(paths, root)
  if (!ledger.length) return { present: false, entries: 0, inFlight: 0, overdue: 0 }
  const fold = foldProbation(ledger)
  const practice = await readJsonlLines<PracticeRec>(paths.practicePath)
  const reviews = await readJsonlLines<ReviewRec>(paths.reviewLogPath)
  const learningDays = learningDaysOf(practice, reviews, courseName, cutoff, today)
  let proposals: Array<{ id?: unknown; decided?: unknown }> = []
  try {
    const doc = JSON.parse(await readFile(paths.proposalsPath, 'utf8'))
    if (Array.isArray(doc)) proposals = doc
  } catch {
    // proposals 缺失/损坏：登记日无从对账，overdue 静默（提案盘点自身另有 finding）
  }
  const regDay = new Map<number, string>()
  for (const p of proposals) {
    if (typeof p.id === 'number' && typeof p.decided === 'string') regDay.set(p.id, p.decided)
  }
  let overdue = 0
  for (const entry of fold.inFlight) {
    const decided = regDay.get(entry.proposal)
    if (!decided) continue
    if (!recheckDue(learningDays, dayOfTs(decided, cutoff), entry.due).due) continue
    overdue++
    push(findings, 'probation_ledger', 'hint', 'probation_overdue',
      `课程「${courseName}」边实验账本 ${paths.probationLedgerPath(root)}：节点「${entry.node}」（提案 #${entry.proposal}，复诊期 ${entry.due} 学习日）`,
      '复诊期已满仍未决——结算钩子未跑到或剪除提案被拒（自动重试于下一次结算触发；可用 learnhub_probation settle 手动结算）。')
  }
  return { present: true, entries: ledger.length, inFlight: fold.inFlight.length, overdue }
}

/** 一次只读体检。注册表损坏时无法安全展开课程，因此只报告注册表本身。 */
export async function dataCheck(paths: Paths, nowMs: number): Promise<DataCheckReport> {
  const findings: DataCheckFinding[] = []
  const inventory: DataCheckReport['inventory'] = {
    registryPresent: false, courses: 0, graphFiles: 0, notes: 0, questionBanks: 0, noteSourceBanks: 0,
    noteSourceFiles: { total: 0, ok: 0, missing: 0, drifted: 0, inconsistent: 0 },
    archive: { present: false, files: 0 },
    conceptRegistries: { present: 0, entries: 0 },
    endpointAnchors: { present: 0 },
    probationLedgers: { present: 0, entries: 0, inFlight: 0, overdue: 0 },
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
    // 概念登记表（#141）：缺席 = 合法空态零 finding（inventory 计数即盘点可见）；在盘 = 盘点条目数
    const regScan = await scanConceptRegistry(findings, courseName, paths.conceptRegistryPath(String(course.root)))
    if (regScan.present) {
      inventory.conceptRegistries.present++
      inventory.conceptRegistries.entries += regScan.entries
    }
    // 终点锚（#142）：缺席 = 未播种 Missing 合法空态零 finding；在盘 = 校验形状与悬空
    const anchorScan = await scanEndpointAnchor(
      findings,
      courseName,
      paths.anchorPath(String(course.root)),
      new Set(result.nodes.map(n => n.name)),
    )
    if (anchorScan.present) inventory.endpointAnchors.present++
    // 边实验账本（#146）：缺席 = 无插入实验合法空态零 finding；在盘 = 盘点在途与到期未决（hint）
    const cutoff = await readDayCutoff(paths)
    const probationScan = await scanProbationLedger(
      findings, courseName, paths, String(course.root), cutoff, todayStr(new Date(nowMs), cutoff),
    )
    if (probationScan.present) {
      inventory.probationLedgers.present++
      inventory.probationLedgers.entries += probationScan.entries
      inventory.probationLedgers.inFlight += probationScan.inFlight
      inventory.probationLedgers.overdue += probationScan.overdue
    }
  }

  const noteSourceScan = await scanNoteSources(findings, paths, noteSources)
  inventory.noteSourceBanks = noteSourceScan.banks
  inventory.noteSourceFiles = noteSourceScan.files
  await scanLearnerCards(findings, paths, courses)
  await scanErrorCards(findings, paths, courses)

  // 断裂存档区（#138）：archived 信息级，与断裂史（learnhub.json schema.breaks）对账
  let breaks: Array<{ date?: string; archived?: string[] }> = []
  try {
    const schema = parseSchemaBlock(await readFile(paths.learnhubConfigPath, 'utf8'))
    if (Array.isArray(schema?.breaks)) breaks = schema!.breaks!
  } catch {
    // learnhub.json 缺失/损坏：版本硬门已在引擎构造期拒载；体检侧按无断裂史盘点
  }
  inventory.archive = await scanArchive(findings, paths, breaks)

  const emptyArea = () => ({ missing: 0, broken: 0, archived: 0, hint: 0 })
  const byArea: DataCheckReport['byArea'] = {
    registry: emptyArea(),
    graph: emptyArea(),
    note: emptyArea(),
    question_bank: emptyArea(),
    note_source: emptyArea(),
    learner_cards: emptyArea(),
    error_cards: emptyArea(),
    concept_registry: emptyArea(),
    endpoint_anchor: emptyArea(),
    archive: emptyArea(),
    probation_ledger: emptyArea(),
  }
  for (const finding of findings) {
    byArea[finding.area][finding.level]++
  }
  const archived = findings.filter(f => f.level === 'archived').length
  const hint = findings.filter(f => f.level === 'hint').length
  const missing = findings.filter(f => f.level === 'missing').length
  const broken = findings.filter(f => f.level === 'broken').length
  return {
    // archived 是显式第三类、hint 是提示类：都不进 status（既非 Missing 也非 Broken）
    status: broken ? 'broken' : missing ? 'missing' : 'ok',
    counts: { missing, broken, archived, hint },
    byArea,
    inventory,
    findings,
  }
}
