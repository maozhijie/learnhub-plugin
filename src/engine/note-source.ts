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
import type { VaultFs } from './io.ts'
import { createHash } from 'node:crypto'
import { YAML } from './yaml.ts'
import { atomicWrite, readLearnhubConfig, writeLearnhubConfig } from './io.ts'
import { isRegistrableCenterRel } from './output.ts'
import type { NoteSourceEntry, Fm, CourseEntry, FsrsBlock, JournalRec, PracticeRec, ReviewRec } from './types.ts'
import type { Paths } from './paths.ts'
import type { AnkiMirror, AnkiMirrorEntry, AnkiNotePayload, AnkiTransport } from './anki.ts'
import { ANKI_MODEL, ANKI_TAG, ankiAddNote, ankiCardPayload, ankiCardReviews, ankiCardsInfo, ankiCreateDeck, ankiCreateModel, ankiDeckNames, ankiDeleteNotes, ankiFindNotes, ankiModelNames, ankiNotesInfo, ankiUpdateNoteFields, deckNameOf, isAnkiNoteMissing, isoFromMs, mapAnkiEase, parseSourceKey, planMirrorSync } from './anki.ts'
import { advance, advancePending, alreadyAdvanced } from './advance.ts'
import { applyRatingBlock, getScheduler, previewDue, retrievabilityBlock } from './srs.ts'
import { combinedDifficulty } from './adaptive.ts'
import { invokesTagged } from './concepts.ts'
import { PASS_SCORE, revealAnswer } from './grading.ts'
import { findDuplicateStem, existingStemsPromptBlock, bankStemList } from './question-dedup.ts'
import type { LlmComplete } from './llm.ts'
import type { JolPrediction } from './jol.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { QuestionBank, BankDoc, BankQuestion } from './question-bank.ts'
import type { FSRS } from 'ts-fsrs'
import type { AnkiStatusDoc, NoteSourceDoc, NoteSourceRegisterResult } from './views/channels.ts'
import { dayOfTs, nowIsoOf } from './dates.ts'
import type { Clock } from './clock.ts'
import { readDayCutoff, xpForAnswer } from './xp.ts'

/** 复习队列里笔记源卡的伪课程名（questionAnswer/Rate/Forget 以它路由到镜像题库；
 * 与真实课程重名时真实课程优先——同名课程存在则不触发笔记源路由）。 */
// NOTE_SOURCE_COURSE 住 types.ts（中立层，#152 刀 6）；原路径 re-export。
export { NOTE_SOURCE_COURSE } from './types.ts'
import { NOTE_SOURCE_COURSE } from './types.ts'

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

// ---- 卡池镜像（V-4 #108：Obsidian backlink 通道）----

/** 卡池镜像 md 正文（纯函数）：镜像文件落在 学习中心/笔记源/卡池/<源id>.md（vault 内），
 * 正文带指向个人笔记的 [[wikilink]]——Obsidian 的 backlink 面板让个人笔记侧直接看到
 * 关联卡池的存在与状态（V-4「双向链接」首版）；个人笔记本体零写入（ADR-0010）。
 * 镜像是出题/重连时的快照（计数截至标注日），实时状态以 learnhub_note_source_list 为准。 */
export function poolMirrorBody(input: {
  /** 源笔记 vault 相对路径（.md 后缀可带可不带，链接目标剥掉）。 */
  notePath: string
  title: string
  cards: number
  due: number
  /** 状态提示文案（sourceHint 产出；ok 为 undefined）。 */
  statusHint?: string
  today: string
}): string {
  const linkTarget = input.notePath.replace(/\.md$/i, '')
  const lines = [
    `# 卡池：${input.title}`,
    '',
    `[[${linkTarget}|${input.title}]] 的复习卡池（learnhub 镜像）。`,
    '',
    `- 卡片 ${input.cards} 张（到期 ${input.due}，截至 ${input.today}）`,
    ...(input.statusHint ? [`- 状态：${input.statusHint}`] : []),
    '- 引擎侧：learnhub_note_source_list 看实时状态；learnhub_note_source_generate 重出题。',
    '',
    '> 本文件由 learnhub 维护（学习中心/笔记源/ 镜像区），手编会在下次出题时被覆盖；',
    '> 你的笔记本体零写入（ADR-0010）。',
    '',
  ]
  return lines.join('\n')
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
  absPath: string, skip: (abs: string) => boolean, fs: VaultFs,
): Promise<Array<{ abs: string; filename: string }>> {
  let isFile: boolean
  try {
    isFile = await fs.statIsFile(absPath)
  } catch {
    throw new Error(`[note-source] 路径不存在：${absPath}`)
  }
  if (isFile) {
    if (skip?.(absPath)) return []
    if (!absPath.toLowerCase().endsWith('.md')) {
      throw new Error(`[note-source] 只支持 .md 笔记（收到：${absPath}）`)
    }
    return [{ abs: absPath, filename: absPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? absPath }]
  }
  const out: Array<{ abs: string; filename: string }> = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdirTypes(dir)
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${dir}/${entry.name}`
      if (skip?.(child)) continue
      if (entry.directory) {
        if (!entry.name.startsWith('.')) await walk(child)
      } else if (!entry.directory && entry.name.toLowerCase().endsWith('.md')) {
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
export async function readNoteSourceExcludes(paths: Paths, fs: VaultFs): Promise<string[]> {
  const doc = await readLearnhubConfig(paths.learnhubConfigPath, fs) as {
    note_source_excludes?: unknown
  }
  if (!Array.isArray(doc.note_source_excludes)) return []
  return doc.note_source_excludes
    .filter((e): e is string => typeof e === 'string')
    .map(e => e.replace(/\\/g, '/').replace(/\/+$/, '').trim())
    .filter(e => !!e)
}

/** 写排除清单（原子替换，保留 learnhub.json 其他字段）。入参须是已归一形态。 */
export async function writeNoteSourceExcludes(paths: Paths, excludes: string[], fs: VaultFs): Promise<void> {
  const prev = await readLearnhubConfig(paths.learnhubConfigPath, fs)
  await writeLearnhubConfig(paths.learnhubConfigPath, { ...prev, note_source_excludes: excludes }, fs)
}

/** 镜像区源清单 IO（Missing = 合法空；Broken fail loud——它是镜像区契约文件）。 */
export class NoteSourceManifest {
  private paths: Paths
  private fs: VaultFs
  constructor(paths: Paths, fs: VaultFs) {
    this.paths = paths
    this.fs = fs
  }

  async load(): Promise<NoteSourceManifestDoc> {
    const p = this.paths.noteSourceManifestPath
    if (!this.fs.exists(p)) return { sources: [] }
    let doc: unknown
    try {
      doc = YAML.parse(await this.fs.readFile(p))
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
    await atomicWrite(this.paths.noteSourceManifestPath, YAML.stringify(doc), this.fs)
  }
}

// ---- Channels 子系统（#152 刀 3 / ADR-0043）：通道域——C1 笔记复习源、卡池镜像、
// 漂移治理、用户排除清单、C2 Anki 通道。住领主文件 note-source.ts（聚合+转发）；
// 跨子系统依赖经结构化窄面 ChannelsDeps 由门面注入（运行时回引门面，类型面零门面
// 导入——R6）。registry 成员须就地结构化：registry.ts 值依赖本域
// validateNoteSourceEntries，引 Registry 类型即成环。

/** Channels 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface ChannelsDeps {
  /** 时钟端口（#175 阶段①）：镜像清单 last_push 戳与 Anki 导入视界。 */
  clock: Clock
  /** vault 存储端口（#175 阶段②）。 */
  fs: VaultFs
  /** store 结构化窄面：本域是低层模块（registry/vault-links 等反向依赖它），引 Store
   * 类型会把存储层拖成下游，成环（R7 实测 store→…→vault-links→note-source→store）。 */
  store: {
    appendJournal(rec: Omit<JournalRec, 'ts'> & { ts?: string }): Promise<JournalRec>
    appendPractice(rec: Omit<PracticeRec, 'ts'> & { ts?: string }): Promise<PracticeRec>
    appendReview(rec: Omit<ReviewRec, 'ts'> & { ts?: string }): Promise<ReviewRec>
  }
  paths: Paths
  /** registry 结构化窄面：registry 值依赖本域 validateNoteSourceEntries，引 Registry 类型即成环（R7）。 */
  registry: {
    load(): Promise<CourseEntry[]>
    loadNoteSources(): Promise<NoteSourceEntry[]>
    save(courses: CourseEntry[], noteSources?: NoteSourceEntry[]): Promise<void>
    get(key: string): Promise<CourseEntry | null>
  }
  bank: Pick<QuestionBank, 'addQuestion' | 'bankPath' | 'load' | 'updateQuestionEvidence'>
  ankiMirror: Pick<AnkiMirror, 'load' | 'save'>
  noteManifest: Pick<NoteSourceManifest, 'load' | 'save'>
  /** vault 根目录（笔记源注册路径归一用）。 */
  vaultRoot: string
  sched(courseRoot: string | null): Promise<FSRS>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  loadPrompt(kind: string): Promise<string>
  questionView(q: BankQuestion, i: number, opts?: { today?: string }): Record<string, unknown>
  judgeBankAnswer(llmComplete: LlmComplete, q: BankQuestion, answer: string, op?: string, ref?: { course: string; node: string; qid: string }): Promise<{ score: number; feedback: string }>
  refreshRepCard(c: CourseEntry, graph: Graph, node: string): Promise<Fm | null>
}

export class ChannelsSubsystem {
  constructor(private e: ChannelsDeps) {}

// ---- 门面原分节：C1 ----
// ---- 门面原分节：V4 ----
// ---- 门面原分节：V6 ----
// ---- 门面原分节：V1 ----
// ---- 门面原分节：C2 ----


  private noteManifest: NoteSourceManifest

  /** 笔记源路由判定：course=「笔记源」伪课程（真实课程同名时课程优先，不触发路由）。 */
  private async isNoteSourceCourse(courseKey: string | undefined): Promise<boolean> {
    if (courseKey !== NOTE_SOURCE_COURSE) return false
    return (await this.e.registry.get(NOTE_SOURCE_COURSE)) === null
  }


  /** 笔记源注册：路径（vault 相对/绝对）为文件时单篇、为文件夹时批量登记其下全部
   * .md（递归，跳过点目录）。每次注册重算指纹并启用——对已注册路径是恢复语义
   * （Missing 后重注册）；学习中心内部路径拒绝（引擎管理区不收编）。用户笔记零写入
   * ——只读文件算指纹与标题。 */
  /** 注册身份落盘带显式 enabled（#59 契约：{id, 路径, enabled, created}），
   * 文件夹批量登记时逐文件归一；学习中心内部的 .md（如注册 vault 根）跳过不失败。
   * 用户排除清单（V-1 #86）在注册入口强制执行：输入路径命中清单 fail loud（先
   * unexclude 再注册），批量登记扫到清单内子树跳过（skipped 计数 + skipped_paths）。 */
  async noteSourceRegister(
    input: string, today?: string,
  ): Promise<NoteSourceRegisterResult> {
    today ??= (await this.e.learningDay()).today
    const rel0 = normalizeSourcePath(this.e.vaultRoot, this.e.paths.centerRoot, input)
    const relOf = (abs: string): string => abs.slice(this.e.vaultRoot.length + 1)
    const excludes = await readNoteSourceExcludes(this.e.paths, this.e.fs)
    if (isExcludedPath(rel0, excludes)) {
      throw new Error(`[note-source] 路径在用户排除清单内，不注册（先 learnhub_note_source_unexclude 解除）：${rel0}`)
    }
    const skippedPaths: string[] = []
    const files = await collectNoteFiles(`${this.e.vaultRoot}/${rel0}`, abs => {
      if (!isExcludedPath(relOf(abs), excludes)) return false
      skippedPaths.push(relOf(abs))
      return true
    }, this.e.fs)
    if (!files.length) {
      if (skippedPaths.length) {
        throw new Error(`[note-source] 该路径下的 .md 全部命中排除清单，没有可注册的笔记（learnhub_note_source_unexclude 可解除）：${skippedPaths.join('、')}`)
      }
      throw new Error('[note-source] 该路径下没有 .md 笔记。')
    }
    const entries = await this.e.registry.loadNoteSources()
    const manifest = await this.e.noteManifest.load()
    const byPath = new Map(entries.map(e => [e.path, e]))
    let registered = 0
    let updated = 0
    let skipped = skippedPaths.length
    for (const f of files) {
      let rel: string
      try {
        rel = normalizeSourcePath(this.e.vaultRoot, this.e.paths.centerRoot, f.abs)
      } catch (err) {
        if (!(err instanceof Error) || !/学习中心内部/.test(err.message)) throw err
        skipped++ // 文件夹批量登记扫到引擎管理区文件：跳过（不收编、不让整批失败）
        skippedPaths.push(relOf(f.abs))
        continue
      }
      const raw = await this.e.fs.readFile(f.abs)
      let entry = byPath.get(rel)
      if (entry) {
        entry.enabled = true
        updated++
      } else {
        const n = entries.reduce((m, e) => Math.max(m, Number(/^note-(\d+)$/.exec(e.id)?.[1] ?? 0)), 0) + 1
        entry = { id: `note-${n}`, path: rel, enabled: true, created: today }
        entries.push(entry)
        registered++
      }
      const item: NoteSourceManifestItem = {
        id: entry.id, path: rel, fingerprint: fingerprintOf(raw),
        title: titleOfBody(stripFrontmatter(raw), f.filename), enabled: true,
      }
      const idx = manifest.sources.findIndex(s => s.id === item.id)
      if (idx >= 0) manifest.sources[idx] = item
      else manifest.sources.push(item)
    }
    await this.e.registry.save(await this.e.registry.load(), entries)
    await this.e.noteManifest.save(manifest)
    const view = await this.noteSourceList(today)
    return {
      date: today, registered, updated, skipped, sources: view.sources,
      ...(skippedPaths.length ? { skipped_paths: skippedPaths } : {}),
    }
  }


  /** 源卡池计数（列表与卡池镜像共用）：未归档卡数 + 当期到期数；镜像 Broken 时
   * 带原因（列表据此挂起该源、镜像据此写状态行）。未出题 = 合法空池零计数。 */
  private async noteSourcePoolStats(
    id: string, today: string,
  ): Promise<{ cards: number; due: number; broken?: string }> {
    if (!this.e.fs.exists(this.e.bank.bankPath(this.e.paths.noteSourceDir, id))) return { cards: 0, due: 0 }
    try {
      const bank = await this.e.bank.load(this.e.paths.noteSourceDir, id)
      let cards = 0
      let due = 0
      for (const q of bank.questions) {
        if (q.archived) continue
        cards++
        if (q.fsrs?.reps && q.fsrs.due <= today) due++
      }
      return { cards, due }
    } catch (err) {
      return { cards: 0, due: 0, broken: err instanceof Error ? err.message.split('\n')[0] : String(err) }
    }
  }


  /** 笔记源清单：注册身份（注册表）× 指纹状态（源清单 + 现读文件）× 卡池概况。
   * 用户笔记永不判 Broken：文件缺失 = missing、指纹不符 = drifted、清单条目缺失 =
   * inconsistent（镜像不一致，data-check 同步报出），状态与提示随条目带出。
   * excludes = 用户排除清单（V-1 #86），只影响未来的注册入口，不挂起已注册源。 */
  async noteSourceList(today?: string): Promise<NoteSourceDoc> {
    today ??= (await this.e.learningDay()).today
    const excludes = await readNoteSourceExcludes(this.e.paths, this.e.fs)
    const entries = await this.e.registry.loadNoteSources()
    const manifest = await this.e.noteManifest.load()
    const itemById = new Map(manifest.sources.map(s => [s.id, s]))
    const out: Array<Record<string, unknown>> = []
    for (const e of entries) {
      const { status, title } = await this.sourceStatusOf(e, itemById.get(e.id))
      const pool = await this.noteSourcePoolStats(e.id, today)
      const hint = pool.broken ? `题库镜像 Broken：${pool.broken}` : sourceHint(status)
      out.push({
        id: e.id, path: e.path, title, enabled: e.enabled !== false, created: e.created,
        status, cards: pool.cards, due: pool.due,
        ...(hint ? { hint } : {}),
        ...(pool.broken ? { broken: true } : {}),
      })
    }
    return { date: today, total: out.length, excludes, sources: out }
  }


  /** 解除注册：注册表条目 + 源清单条目 + 镜像题库一并清除；用户笔记文件不动。 */
  async noteSourceUnregister(id: string): Promise<{ removed: string; path: string }> {
    const { entry } = await this.requireSource(id)
    await this.e.registry.save(await this.e.registry.load(), (await this.e.registry.loadNoteSources()).filter(e => e.id !== id))
    const manifest = await this.e.noteManifest.load()
    await this.e.noteManifest.save({ sources: manifest.sources.filter(s => s.id !== id) })
    const bankPath = this.e.bank.bankPath(this.e.paths.noteSourceDir, id)
    if (this.e.fs.exists(bankPath)) await this.e.fs.unlink(bankPath)
    const poolPath = this.e.paths.noteSourcePoolPath(id)
    if (this.e.fs.exists(poolPath)) await this.e.fs.unlink(poolPath) // 卡池镜像随源清除（V-4 #108）
    return { removed: id, path: entry.path }
  }

  /** 写卡池镜像（出题/重连后调用）：带 [[个人笔记]] 链接的 md 落镜像区（引擎地盘，
   * 个人笔记零写入）——Obsidian 的 backlink 面板让个人笔记侧看到关联卡池状态。
   * 计数与状态是写入时刻的快照（截至日标注在文内），实时状态以 noteSourceList 为准。 */
  private async writePoolMirror(id: string, today: string): Promise<void> {
    const { entry, item } = await this.requireSource(id)
    const { status, title } = await this.sourceStatusOf(entry, item)
    const pool = await this.noteSourcePoolStats(id, today)
    await this.e.fs.mkdir(this.e.paths.noteSourcePoolDir)
    await atomicWrite(this.e.paths.noteSourcePoolPath(id), poolMirrorBody({
      notePath: entry.path, title, cards: pool.cards, due: pool.due, today,
      ...(sourceHint(status) || pool.broken
        ? { statusHint: sourceHint(status) ?? `题库镜像异常：${pool.broken}` }
        : {}),
    }), this.e.fs)
  }

  /** 笔记源 relink：把既有源重连到新路径——注册身份（id）与镜像题库/卡池原样保留
   * （这正是它与「解除后重注册」的区别：旧卡调度不丢）。四类漂移的确定行为收口：
   * 改名/移动 → Missing（既有语义）+ 本动作重连；删除 → 卡池挂起；编辑 → 提示重出。
   * 新路径过注册同款卫生（normalizeSourcePath + 用户排除清单），目标文件必须现存
   * （relink 是恢复动作，目标不可读即 fail loud），已被其他源占用的路径拒绝；
   * 原路径缺失不阻塞——那正是 relink 的使用场景。 */
  async noteSourceRelink(id: string, input: string, today?: string): Promise<{ id: string; from: string; to: string }> {
    today ??= (await this.e.learningDay()).today
    const rel = normalizeSourcePath(this.e.vaultRoot, this.e.paths.centerRoot, input)
    const { entry } = await this.requireSource(id)
    if (entry.path === rel) {
      throw new Error(`[note-source] 「${id}」已注册在路径 ${rel}（relink 请给改名/移动后的新路径）。`)
    }
    const excludes = await readNoteSourceExcludes(this.e.paths, this.e.fs)
    if (isExcludedPath(rel, excludes)) {
      throw new Error(`[note-source] 目标路径在用户排除清单内，不重连（先 learnhub_note_source_unexclude 解除）：${rel}`)
    }
    const others = (await this.e.registry.loadNoteSources()).filter(e => e.id !== id)
    const taken = others.find(e => e.path === rel)
    if (taken) {
      throw new Error(`[note-source] 目标路径已是笔记源「${taken.id}」的注册路径：${rel}（先解除它再重连）。`)
    }
    const abs = `${this.e.vaultRoot}/${rel}`
    if (!this.e.fs.exists(abs)) {
      throw new Error(`[note-source] relink 目标文件不存在：${rel}（重连的是现存文件；整体挪走目录后给出新路径）。`)
    }
    const raw = await this.e.fs.readFile(abs)
    const from = entry.path
    const entries = await this.e.registry.loadNoteSources()
    const target = entries.find(e => e.id === id)!
    target.path = rel
    await this.e.registry.save(await this.e.registry.load(), entries)
    const manifest = await this.e.noteManifest.load()
    const idx = manifest.sources.findIndex(s => s.id === id)
    if (idx >= 0) {
      manifest.sources[idx] = {
        ...manifest.sources[idx]!,
        path: rel,
        fingerprint: fingerprintOf(raw),
        title: titleOfBody(stripFrontmatter(raw), rel.split('/').pop() ?? id),
        enabled: true,
      }
      await this.e.noteManifest.save(manifest)
    }
    await this.writePoolMirror(id, today) // 卡池镜像的 [[链接]] 跟到新路径
    return { id, from, to: rel }
  }

  /** 读排除清单（noteSourceList 同款视图；只影响未来注册，不摘除已注册源）。 */
  async noteSourceExcludes(): Promise<{ excludes: string[] }> {
    return { excludes: await readNoteSourceExcludes(this.e.paths, this.e.fs) }
  }


  /** 加一条排除（vault 相对/绝对路径，文件或文件夹均可；归一去重排序落盘）。
   * 已在清单 = 幂等返回；路径不要求现存（可先排除后建文件）。 */
  async noteSourceExclude(input: string): Promise<{ excludes: string[] }> {
    const cur = await readNoteSourceExcludes(this.e.paths, this.e.fs)
    const rel = normalizeSourcePath(this.e.vaultRoot, this.e.paths.centerRoot, input)
    const next = [...new Set([...cur, rel])].sort()
    await writeNoteSourceExcludes(this.e.paths, next, this.e.fs)
    return { excludes: next }
  }


  /** 解除一条排除：不在清单 fail loud（提示现清单——显式动作要对得上号）。 */
  async noteSourceUnexclude(input: string): Promise<{ excludes: string[] }> {
    const cur = await readNoteSourceExcludes(this.e.paths, this.e.fs)
    const rel = normalizeSourcePath(this.e.vaultRoot, this.e.paths.centerRoot, input)
    if (!cur.includes(rel)) {
      throw new Error(`[note-source] 排除清单没有「${rel}」（noteSourceList 的 excludes 查看现清单）。`)
    }
    const next = cur.filter(e => e !== rel)
    await writeNoteSourceExcludes(this.e.paths, next, this.e.fs)
    return { excludes: next }
  }


  /** 笔记源定位（注册身份 + 源清单条目齐备才合法；单边缺失是镜像不一致，fail loud）。 */
  private async requireSource(id: string): Promise<{ entry: NoteSourceEntry; item: NoteSourceManifestItem }> {
    const entries = await this.e.registry.loadNoteSources()
    const entry = entries.find(e => e.id === id)
    if (!entry) throw new Error(`[note-source] 没有笔记源「${id}」（learnhub_note_source_list 查看已注册源）。`)
    const manifest = await this.e.noteManifest.load()
    const item = manifest.sources.find(s => s.id === id)
    if (!item) {
      throw new Error(`[note-source] 笔记源「${id}」缺源清单条目（镜像不一致）——跑 learnhub_data_check 定位，或解除后重新注册。`)
    }
    return { entry, item }
  }


  /** 单源现读状态（列表与复习队列共用）：文件存在性 → Missing、清单指纹比对 → 漂移；
   * 清单条目缺失 → inconsistent（无法核对指纹，卡不挂起，data-check 报镜像不一致）。 */
  private async sourceStatusOf(
    e: NoteSourceEntry, item: NoteSourceManifestItem | undefined,
  ): Promise<{ status: NoteSourceStatus; title: string }> {
    const abs = `${this.e.vaultRoot}/${e.path}`
    const fallbackTitle = e.path.split('/').pop() ?? e.path
    if (!this.e.fs.exists(abs)) return { status: 'missing', title: item?.title ?? fallbackTitle }
    const raw = await this.e.fs.readFile(abs)
    const title = titleOfBody(stripFrontmatter(raw), fallbackTitle)
    if (!item) return { status: 'inconsistent', title }
    return { status: classifySource(true, item.fingerprint === fingerprintOf(raw)), title }
  }


  /** 收题公步（#119 防相似：笔记出题/节点出题/逐节出题三处同缝）：程序化查重命中
   * → duplicate（附对方题面供报告）；入库成功把题面登记进查重基线（批内互查）；
   * 单题非法（超纲题型等）→ invalid，不毁整批。 */
  private async admitQuestion(
    root: string, node: string, q: Record<string, unknown>, stem: string,
    existingStems: Array<{ q: string; kind?: string; difficulty?: number }>,
  ): Promise<{ verdict: 'added' } | { verdict: 'duplicate'; against: string } | { verdict: 'invalid' }> {
    const dup = findDuplicateStem(stem, existingStems)
    if (dup) return { verdict: 'duplicate', against: dup }
    try {
      await this.e.bank.addQuestion(root, node, q)
    } catch {
      return { verdict: 'invalid' }
    }
    existingStems.push({ q: stem, kind: typeof q.kind === 'string' ? q.kind : undefined, difficulty: undefined })
    return { verdict: 'added' }
  }


  /** 出生打标修复轮（#148）：概念清单在场且有题缺 invokes 时的一次补标调用——按题目
   * 序号回填清单内名字；清单缺席直接跳过（出生打标门不激活，invokes 恒合法 Missing）。
   * 修复恰好一次：补不齐不重试，仍空的题由受理门拒收/弃置（负路径在受理门侧收口）。
   * 返回实际回填的题数（留痕用）。 */
  private async repairInvokesOnce(
    llm: LlmComplete,
    items: unknown[],
    scope: string[],
  ): Promise<number> {
    if (!scope.length) return 0
    const missing = items.filter((x): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && !invokesTagged(x as Record<string, unknown>))
    if (!missing.length) return 0
    const prompt = [
      '## 任务：为下列题目各补一枚 invokes 概念标注',
      '',
      '从概念清单中为每道题选**恰一枚**本题最主要考察的概念，名字精确照抄清单（一字不差）。只输出一个 YAML 映射（不要代码围栏、不要任何解释），键为题目序号、值为概念名：',
      '',
      '1: 概念名',
      '2: 概念名',
      '',
      '## 概念清单',
      '',
      ...scope.map(c => `- ${c}`),
      '',
      '## 题目（按序号）',
      '',
      ...missing.map((it, i) => {
        const stem = typeof it.q === 'string' ? it.q : ''
        return `${i + 1}. ${stem ? stem.slice(0, 80) : '（无题干）'}`
      }),
    ].join('\n')
    let doc: unknown
    try {
      doc = YAML.parseModel(await llm(prompt))
    } catch {
      return 0 // 补标应答不可解析 = 修复失败，仍空交受理门拒收
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 0
    const map = doc as Record<string, unknown>
    let filled = 0
    missing.forEach((it, i) => {
      const v = map[String(i + 1)] ?? map[i + 1]
      if (typeof v === 'string' && v.trim()) {
        it.invokes = v.trim()
        filled++
      }
    })
    return filled
  }


  /** 笔记源出题：读笔记正文（只读）→ 笔记出题 prompt + llm → validateBank 门禁逐题
   * 落镜像题库（学习中心/笔记源/题库/<源id>.yaml）→ 新卡初始化 FSRS（同完成学习的
   * 合成首复习语义，明天起刷，rating_source=synthetic 落复习日志）→ 源清单指纹刷新
   * （出题读的是当前内容，漂移就此确认；旧卡不自动归档，归档是独立动作）。
   * 防相似（#119）：提示词注入镜像题库已有题面 ≤15 条，生成后逐题查重，命中的丢弃。 */
  async noteSourceGenerate(
    id: string, count: number | undefined,
    llm: LlmComplete,
    today?: string,
  ): Promise<{ id: string; added: number; skipped: number; total: number; duplicates: Array<{ q: string; against: string }> }> {
    today ??= (await this.e.learningDay()).today
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
      throw new Error(`[note-quiz] count 必须是正整数（收到 ${String(count)}）；省略才使用默认 6。`)
    }
    const requested = count ?? 6
    const { entry } = await this.requireSource(id)
    const abs = `${this.e.vaultRoot}/${entry.path}`
    if (!this.e.fs.exists(abs)) {
      throw new Error(`[note-quiz] 源文件缺失（Missing）：${entry.path}——重新注册（同路径）可恢复后再生题。`)
    }
    const raw = await this.e.fs.readFile(abs)
    const body = stripFrontmatter(raw)
    if (!body) throw new Error(`[note-quiz] 笔记正文为空，无可出题内容：${entry.path}`)
    const tpl = await this.e.loadPrompt('笔记出题')
    const bankBefore = await this.e.bank.load(this.e.paths.noteSourceDir, id)
    const existingStems = bankStemList(bankBefore)
    const rawOut = await llm(`${tpl}${existingStemsPromptBlock(existingStems)}\n\n## 题目数量\n\n${requested} 道\n\n---\n\n${body}`)
    const doc = YAML.parseModel(rawOut) as { questions?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.questions) || !doc.questions.length) {
      throw new Error('[note-quiz] 模型没有产出可用题目（questions 为空）。')
    }
    let added = 0
    let skipped = 0
    const duplicates: Array<{ q: string; against: string }> = []
    for (const rawQ of doc.questions.slice(0, requested)) {
      const q = { ...((rawQ ?? {}) as Record<string, unknown>) }
      delete q.id // id 由 addQuestion 按现有卡数自动编号
      const stem = typeof q.q === 'string' ? q.q : ''
      const verdict = await this.admitQuestion(this.e.paths.noteSourceDir, id, q, stem, existingStems)
      if (verdict.verdict === 'duplicate') {
        duplicates.push({ q: stem.slice(0, 80), against: verdict.against.slice(0, 80) })
      } else if (verdict.verdict === 'added') {
        added++
      } else {
        skipped++ // 单题非法（如超纲题型）不毁整批
      }
    }
    if (!added) throw new Error('[note-quiz] 模型产出的题目全部未过校验门（题型/答案格式不符/重复），一道都没入库。')
    // 新卡合成首复习初始化（同 nodeComplete 语义：明天起刷）
    const sched = await this.e.sched(null)
    const bank = await this.e.bank.load(this.e.paths.noteSourceDir, id)
    for (const q of bank.questions) {
      if (q.archived || q.fsrs?.reps) continue
      const { fs } = applyRatingBlock(null, 3, today, sched)
      await this.e.bank.updateQuestionEvidence(this.e.paths.noteSourceDir, id, q.id, { fsrs: fs })
      await this.e.store.appendReview({
        course: NOTE_SOURCE_COURSE, node: id, qid: q.id,
        rating: 3, rating_source: 'synthetic', elapsed_days: 0,
        stability_before: null, difficulty_before: null, r_pred: null,
      })
    }
    // 指纹刷新 + 标题同步（出题即确认当前内容；重出/归档建议就此清除）
    const manifest = await this.e.noteManifest.load()
    const idx = manifest.sources.findIndex(s => s.id === id)
    if (idx >= 0) {
      manifest.sources[idx] = {
        ...manifest.sources[idx]!,
        fingerprint: fingerprintOf(raw),
        title: titleOfBody(body, entry.path.split('/').pop() ?? id),
      }
      await this.e.noteManifest.save(manifest)
    }
    await this.writePoolMirror(id, today) // 卡池镜像（V-4 #108）：[[个人笔记]] backlink + 池概况
    return { id, added, skipped, total: bank.questions.length, duplicates }
  }


  /** 笔记源卡池合并进全局复习队列（reviewQueue 专用）：Missing → 卡池挂起（不出卡，
   * 状态随响应带出）；题库镜像 Broken → 该源卡挂起并带原因（镜像契约文件才 fail
   * loud，且不阻塞其他源）；漂移不挂起（旧卡继续复习，提示可重出/归档）。
   * inconsistent（清单条目缺失）无法核对指纹：卡照常出，状态随响应带出。 */
  private async collectNoteSourceCards(
    today: string,
  ): Promise<{ cards: Array<Record<string, unknown>>; drifted: Array<Record<string, unknown>>; suspended: Array<Record<string, unknown>> }> {
    const cards: Array<Record<string, unknown>> = []
    const drifted: Array<Record<string, unknown>> = []
    const suspended: Array<Record<string, unknown>> = []
    const entries = await this.e.registry.loadNoteSources()
    if (!entries.length) return { cards, drifted, suspended }
    const manifest = await this.e.noteManifest.load()
    const itemById = new Map(manifest.sources.map(s => [s.id, s]))
    const sched = await this.e.sched(null)
    for (const e of entries) {
      if (e.enabled === false) continue
      const item = itemById.get(e.id)
      const { status, title } = await this.sourceStatusOf(e, item)
      if (status === 'missing') {
        suspended.push({ id: e.id, path: e.path, reason: sourceHint('missing') })
        continue
      }
      if (status === 'drifted') {
        drifted.push({ id: e.id, path: e.path, hint: sourceHint('drifted') })
      }
      if (status === 'inconsistent') {
        drifted.push({ id: e.id, path: e.path, hint: sourceHint('inconsistent') })
      }
      const bankPath = this.e.bank.bankPath(this.e.paths.noteSourceDir, e.id)
      if (!this.e.fs.exists(bankPath)) continue // 尚未出题：合法空卡池
      let bank: BankDoc
      try {
        bank = await this.e.bank.load(this.e.paths.noteSourceDir, e.id)
      } catch (err) {
        suspended.push({ id: e.id, path: e.path, reason: `题库镜像 Broken：${err instanceof Error ? err.message.split('\n')[0] : String(err)}` })
        continue
      }
      bank.questions.forEach((q, i) => {
        if (q.archived) return
        const card = this.e.questionView(q, i)
        if (!card.due || String(card.due) > today) return
        const r = retrievabilityBlock(sched, q.fsrs, today)
        cards.push({
          course: NOTE_SOURCE_COURSE, node: e.id, source: 'note',
          title: item?.title ?? title,
          // 来源笔记可跳转（V-4 #108）：vault 相对路径 + 绝对路径（面板拼 obsidian:// 用）
          source_path: e.path, source_abs: `${this.e.vaultRoot}/${e.path}`,
          r: Math.round(r * 1000) / 1000,
          d: Math.round(combinedDifficulty(q.difficulty, q.fsrs) * 1000) / 1000,
          ...card,
        })
      })
    }
    return { cards, drifted, suspended }
  }


  /** 笔记源卡一次评分推进（作答/自评/忘记三通道共用）：推镜像题库卡 + 落复习日志
   * （course=笔记源；调度器用默认参数——笔记源不挂课程个人参数）。返回新 fsrs 块。
   * 无守门（ADR-0014 advancePending）：三个调用方各自持准入（repeated/pending/stats.last）。 */
  private async pushNoteCard(
    sourceId: string, q: BankQuestion, fsOld: FsrsBlock | null,
    rating: 1 | 2 | 3 | 4, ratingSource: 'auto' | 'self', today: string,
    stats: BankQuestion['stats'],
  ): Promise<FsrsBlock> {
    const sched = await this.e.sched(null)
    const pushed = advancePending(sched, { fsrs: fsOld }, rating, today)
    await this.e.bank.updateQuestionEvidence(this.e.paths.noteSourceDir, sourceId, q.id, { fsrs: pushed.fs, stats })
    await this.e.store.appendReview({
      course: NOTE_SOURCE_COURSE, node: sourceId, qid: q.id,
      rating, rating_source: ratingSource, ...pushed.log,
    })
    return pushed.fs
  }


  /** 笔记源作答（C1 #59）：判卷同题库通道；推进只有题目级 FSRS + 复习日志
   * （course=笔记源）——无节点证据、无 practice 流水、无节点定价/settle（同复习
   * 自评语义，ADR-0010）、无代表卡（笔记源没有节点）。XP 走无绑定行（ADR-0021）：
   * 与题卡同公式结算（含乱猜负 XP），作答时即落（挂起路径同题卡 practice 同时点）。 */
  private async noteSourceAnswer(
    llmComplete: LlmComplete,
    sourceId: string, qid: string, answer: string,
    opts?: { deferSchedule?: boolean; predicted?: JolPrediction | null; elapsed_s?: number | null },
  ): Promise<Record<string, unknown>> {
    const bank = await this.e.bank.load(this.e.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { score, feedback } = await this.e.judgeBankAnswer(llmComplete, q, answer, 'question',
      { course: NOTE_SOURCE_COURSE, node: sourceId, qid })
    const correct = score >= PASS_SCORE
    const { today } = await this.e.learningDay()
    const repeated = alreadyAdvanced(q, today)
    const settle = xpForAnswer(q.kind, q.difficulty ?? 1, correct, opts?.elapsed_s ?? null, !repeated)
    if (!repeated) {
      await this.e.store.appendJournal({
        course: '*', node: '*', rating: null, kind: 'xp_notesource', elapsed_days: 0,
        xp: settle.xp, detail: `笔记源 ${sourceId}#${q.id}（${settle.reason}）`,
      })
    }
    let fs: FsrsBlock | null
    let pendingRating = false
    let advanced = false
    let previews: { hard: string; good: string; easy: string } | undefined
    const stats = {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: (q.stats?.correct ?? 0) + (correct ? 1 : 0),
      last: today,
      last_correct: correct,
      // 同日重复作答不丢今日已挂起的自评（ADR-0014：pending 态保持完整）
      ...(q.stats?.pending_rating && q.stats?.last === today ? { pending_rating: true } : {}),
    }
    if (repeated) {
      fs = q.fsrs ?? null
      await this.e.bank.updateQuestionEvidence(this.e.paths.noteSourceDir, sourceId, qid, { fsrs: fs, stats })
    } else if (opts?.deferSchedule === true && correct) {
      const sched = await this.e.sched(null)
      pendingRating = true
      previews = {
        hard: previewDue(sched, q.fsrs ?? null, 2, today),
        good: previewDue(sched, q.fsrs ?? null, 3, today),
        easy: previewDue(sched, q.fsrs ?? null, 4, today),
      }
      fs = q.fsrs ?? null
      await this.e.bank.updateQuestionEvidence(this.e.paths.noteSourceDir, sourceId, qid, {
        fsrs: fs, stats: { ...stats, pending_rating: true },
      })
    } else {
      fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, correct ? 3 : 1, 'auto', today, stats)
      advanced = true
    }
    return {
      correct, score: Math.round(score * 100), feedback,
      answer: revealAnswer(q), kind: q.kind,
      due: fs?.due ?? null,
      scheduled: advanced, pendingRating,
      ...(previews ? { previews } : {}),
      xp: settle.xp, // 无绑定 XP（ADR-0021）：不入节点/practice 账，journal 行已落
    }
  }


  /** 笔记源自评结算：挂起标记唯一准入，推卡 + 复习日志（self），无代表卡回刷。 */
  private async noteSourceRate(sourceId: string, qid: string, r: number): Promise<Record<string, unknown>> {
    const bank = await this.e.bank.load(this.e.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-rate] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { today } = await this.e.learningDay()
    if (q.stats?.last !== today || !q.stats?.pending_rating) {
      throw new Error(`[question-rate] 笔记源 ${sourceId}/${qid} 今天没有待结算的自评（未作答或非挂起路径）。`)
    }
    const { pending_rating: _drop, ...statsRest } = q.stats
    const fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, r as 1 | 2 | 3 | 4, 'self', today, { ...statsRest })
    return { course: NOTE_SOURCE_COURSE, node: sourceId, qid, rating: r, due: fs.due, scheduled: true }
  }


  /** 笔记源忘记申报：rating=1 推卡 + 复习日志（auto），当日已推进拒绝。 */
  private async noteSourceForget(sourceId: string, qid: string): Promise<Record<string, unknown>> {
    const bank = await this.e.bank.load(this.e.paths.noteSourceDir, sourceId)
    const q = bank.questions.find(x => x.id === qid)
    if (!q) throw new Error(`[question-forget] 笔记源 ${sourceId} 的题库没有 ${qid}。`)
    const { today } = await this.e.learningDay()
    if (q.stats?.last === today) {
      throw new Error(`[question-forget] 笔记源 ${sourceId}/${qid} 今天已有推进记录，忘记只用于本日首次。`)
    }
    const fs = await this.pushNoteCard(sourceId, q, q.fsrs ?? null, 1, 'auto', today, {
      attempts: (q.stats?.attempts ?? 0) + 1,
      correct: q.stats?.correct ?? 0,
      last: today,
      last_correct: false,
    })
    // 忘记也是真实推进：落 0 XP 无绑定行，streak 口径与题卡忘记申报一致（ADR-0021）
    await this.e.store.appendJournal({
      course: '*', node: '*', rating: 1, kind: 'xp_notesource', elapsed_days: 0,
      xp: 0, detail: `笔记源 ${sourceId}#${q.id}（forget）`,
    })
    return {
      correct: false, judge: 'forget',
      feedback: q.explanation ?? '', answer: revealAnswer(q), explanation: q.explanation ?? '',
      kind: q.kind, due: fs.due, scheduled: true, xp: 0,
    }
  }

  private ankiMirror: AnkiMirror

  /** 到期卡导出负载：全部启用课程「未归档且 due ≤ 今日」的已调度题（复用
   * reviewQueue 的到期语义与 questionView 的题面视图；答案/解析上背面）。
   * 来源字段 = 课程/节点/题id，回写归属与清单丢失自愈的依据。
   * 笔记源到期卡并入（V-4 #108 / ADR-0011 衔接）：deck learnhub::笔记源，来源键
   * 笔记源/<源id>/题id——Missing/镜像 Broken 的源与复习队列同口径挂起不导出、
   * 不阻塞其他源；导入侧按同一来源键路由回镜像题库。 */
  private async collectAnkiDuePayloads(today: string): Promise<AnkiNotePayload[]> {
    const out: AnkiNotePayload[] = []
    for (const c of await this.e.enabledCourses()) {
      await this.e.scanCourseBanks(c, async (node, bank) => {
        for (const q of bank.questions) {
          if (q.archived || !q.fsrs?.reps || q.fsrs.due > today) continue
          const back = revealAnswer(q) + (q.explanation ? `\n\n解析：${q.explanation}` : '')
          out.push(ankiCardPayload(c.name, node, q, back))
        }
      })
    }
    for (const e of await this.e.registry.loadNoteSources()) {
      if (e.enabled === false) continue
      if (!this.e.fs.exists(`${this.e.vaultRoot}/${e.path}`)) continue // Missing：卡池挂起
      const bankPath = this.e.bank.bankPath(this.e.paths.noteSourceDir, e.id)
      if (!this.e.fs.exists(bankPath)) continue // 尚未出题：合法空卡池
      let bank: BankDoc
      try {
        bank = await this.e.bank.load(this.e.paths.noteSourceDir, e.id)
      } catch {
        continue // 镜像 Broken：该源挂起（data-check 显式报出），不阻塞其他源
      }
      for (const q of bank.questions) {
        if (q.archived || !q.fsrs?.reps || q.fsrs.due > today) continue
        const back = revealAnswer(q) + (q.explanation ? `\n\n解析：${q.explanation}` : '')
        out.push(ankiCardPayload(NOTE_SOURCE_COURSE, e.id, q, back))
      }
    }
    return out
  }


  /** 导出推送：按 vault 到期集校准/重建镜象卡组——新增缺卡、更新改题（fp 变化）、
   * 移除已归档/已重生成/已被 vault 消费的旧卡；镜象与 vault 不一致时以 vault 为
   * 准，Anki 侧排期输出不作数（ADR-0011）。Anki 侧手动删过的笔记自动重建。 */
  async ankiExportPush(transport: AnkiTransport, today?: string): Promise<{
    date: string; added: number; updated: number; removed: number; total: number; decks: string[]
  }> {
    today ??= (await this.e.learningDay()).today
    const payloads = await this.collectAnkiDuePayloads(today)
    const mirror = await this.e.ankiMirror.load()
    const plan = planMirrorSync(payloads, mirror.notes)
    const decks = [...new Set(payloads.map(p => p.deckName))]
    if (payloads.length) {
      const models = await ankiModelNames(transport)
      if (!models.includes(ANKI_MODEL)) await ankiCreateModel(transport)
      const have = new Set(await ankiDeckNames(transport))
      for (const d of decks) {
        if (!have.has(d)) await ankiCreateDeck(transport, d)
      }
    }
    const kept = new Map<string, AnkiMirrorEntry>()
    for (const e of mirror.notes) {
      if (!plan.removeNoteIds.includes(e.note_id)) kept.set(e.key, e)
    }
    for (const u of plan.update) {
      let noteId = u.noteId
      try {
        await ankiUpdateNoteFields(transport, noteId, u.payload.fields)
      } catch (err) {
        if (!isAnkiNoteMissing(err)) throw err
        noteId = await this.ankiUpsert(transport, u.payload) // Anki 侧笔记被手动删：重建
      }
      kept.set(u.payload.key, { key: u.payload.key, note_id: noteId, fp: u.payload.fp, deck: u.payload.deckName })
    }
    for (const p of plan.add) {
      const noteId = await this.ankiUpsert(transport, p)
      kept.set(p.key, { key: p.key, note_id: noteId, fp: p.fp, deck: p.deckName })
    }
    await ankiDeleteNotes(transport, plan.removeNoteIds)
    await this.e.ankiMirror.save({ last_push: nowIsoOf(this.e.clock.nowMs()), last_import_ms: mirror.last_import_ms, notes: [...kept.values()] })
    return { date: today, added: plan.add.length, updated: plan.update.length, removed: plan.removeNoteIds.length, total: payloads.length, decks }
  }


  /** addNote，重复拒绝时按来源字段检索回补归属（清单丢失自愈；Anki 侧旧卡内容
   * 就地校准到 vault 当前版本）。找不到同源旧卡才抛错。 */
  private async ankiUpsert(transport: AnkiTransport, p: AnkiNotePayload): Promise<number> {
    const noteId = await ankiAddNote(transport, { deckName: p.deckName, fields: p.fields, tags: [ANKI_TAG] })
    if (noteId !== null) return noteId
    const found = await ankiFindNotes(transport, `deck:"${p.deckName}" tag:${ANKI_TAG}`)
    const infos = await ankiNotesInfo(transport, found)
    const hit = infos.find(n => (n.fields['来源'] ?? '').trim() === p.key)
    if (!hit) throw new Error(`[anki] 卡写入 Anki 失败且找不到同源旧卡：${p.key}`)
    await ankiUpdateNoteFields(transport, hit.noteId, p.fields)
    return hit.noteId
  }


  /** 导入回写：拉 Anki 复习日志事件（自上次导入水位起），逐事件映射为原始作答
   * 证据并按 vault 自己的 ts-fsrs 重算——Again → 答错（rating 1/auto）、
   * Hard/Good/Easy → 复习自评档（2/3/4/self，答对）；Anki 侧排期输出不作数
   * （ADR-0011）。「一题一天只推进一次」跨端守住：vault 当日已推进的题，其当日
   * Anki 事件跳过调度只留档（practice 流水）。事件落 practice 流水（judge=review，
   * ts 回溯到 Anki 作答时刻），真实推进另落复习日志（A2 数据回流）。归属 =
   * 镜象清单 noteId→key，清单丢失时按 Anki 来源字段回补；无法归属/题目已归档
   * 重生成的事件只计数不落盘（旧卡下次推送按 vault 校准移除）。nowMs 可注入
   * （测试播种；水位上界 = 调用时刻）。 */
  async ankiImportEvents(transport: AnkiTransport, opts?: { nowMs?: number }): Promise<{
    imported: number; advanced: number; skipped_same_day: number; skipped_unknown: number; unknown: string[]
  }> {
    const mirror = await this.e.ankiMirror.load()
    // 事件的学习日按 vault 自己的日界推（ADR-0020 裁决 5：不对齐 Anki rollover）
    const cutoff = await readDayCutoff(this.e.paths, this.e.fs)
    const rows = await ankiCardReviews(transport, mirror.last_import_ms, (opts?.nowMs ?? this.e.clock.nowMs()) + 60_000)
    const events = rows
      .map(r => ({ ts: Number(r[0]), cardId: Number(r[1]), button: Number(r[3]), timeMs: Number(r[7]) }))
      .filter(e => Number.isFinite(e.ts) && Number.isFinite(e.cardId) && Number.isFinite(e.button))
      .sort((a, b) => a.ts - b.ts)
    const result = { imported: events.length, advanced: 0, skipped_same_day: 0, skipped_unknown: 0, unknown: [] as string[] }
    if (!events.length) return result
    // cardId → noteId（一次批量）；noteId → 来源键（清单优先，缺的按来源字段回补）
    const noteOfCard = new Map<number, number>()
    for (const c of await ankiCardsInfo(transport, [...new Set(events.map(e => e.cardId))])) {
      noteOfCard.set(c.cardId, c.noteId)
    }
    const keyOfNote = new Map(mirror.notes.map(n => [n.note_id, n.key]))
    const missing = [...new Set([...noteOfCard.values()].filter(id => !keyOfNote.has(id)))]
    for (const info of await ankiNotesInfo(transport, missing)) {
      const key = (info.fields['来源'] ?? '').trim()
      const loc = parseSourceKey(key)
      if (loc) {
        keyOfNote.set(info.noteId, key)
        mirror.notes.push({ key, note_id: info.noteId, fp: '', deck: deckNameOf(loc.course) })
      }
    }
    // 课程上下文缓存：registry/loadView/scheduler 每课程一次；笔记源伪课程判定同样缓存
    type AnkiCourseCtx = { c: CourseEntry; graph: Graph; sched: Awaited<ReturnType<typeof getScheduler>> } | null
    const ctxCache = new Map<string, AnkiCourseCtx>()
    const noteCourseCache = new Map<string, boolean>()
    const isNoteCourse = async (name: string): Promise<boolean> => {
      let v = noteCourseCache.get(name)
      if (v === undefined) {
        v = await this.isNoteSourceCourse(name)
        noteCourseCache.set(name, v)
      }
      return v
    }
    let lastMs = mirror.last_import_ms
    for (const ev of events) {
      lastMs = Math.max(lastMs, ev.ts)
      const noteId = noteOfCard.get(ev.cardId)
      const key = noteId !== undefined ? keyOfNote.get(noteId) : undefined
      const loc = key ? parseSourceKey(key) : null
      const noteUnknown = (why: string) => {
        result.skipped_unknown++
        if (result.unknown.length < 5) result.unknown.push(`${key ?? `card#${ev.cardId}`}（${why}）`)
      }
      if (!loc) { noteUnknown('来源无法归属'); continue }
      let map: ReturnType<typeof mapAnkiEase>
      try {
        map = mapAnkiEase(ev.button)
      } catch {
        result.skipped_unknown++
        continue
      }
      const iso = isoFromMs(ev.ts)
      const day = dayOfTs(iso, cutoff)
      if (await isNoteCourse(loc.course)) {
        // 笔记源伪课程通道（V-4 #108 / ADR-0011 衔接）：回写镜像题库 + 默认参数
        // 调度器（与复习自评 pushNoteCard 同语义）——无节点证据、无代表卡、无课程参数
        let bank: BankDoc
        try {
          bank = await this.e.bank.load(this.e.paths.noteSourceDir, loc.node)
        } catch {
          noteUnknown('笔记源镜像题库不可读')
          continue
        }
        const idx = bank.questions.findIndex(x => x.id === loc.qid)
        const q = idx >= 0 ? bank.questions[idx] : undefined
        if (!q || q.archived) { noteUnknown('题目已归档或重生成'); continue }
        const r = advance(await this.e.sched(null), q, map.rating, day, 'anki')
        await this.e.store.appendPractice({
          course: NOTE_SOURCE_COURSE, node: loc.node, ex: idx + 1, answer: '',
          correct: map.correct, judge: 'review', qid: loc.qid,
          ...(ev.timeMs > 0 ? { elapsed_s: ev.timeMs / 1000 } : {}),
          xp: 0, ts: iso,
        })
        if (!r.advanced) { result.skipped_same_day++; continue }
        await this.e.bank.updateQuestionEvidence(this.e.paths.noteSourceDir, loc.node, loc.qid, { fsrs: r.fs, stats: r.stats })
        await this.e.store.appendReview({
          course: NOTE_SOURCE_COURSE, node: loc.node, qid: loc.qid,
          rating: map.rating, rating_source: map.ratingSource, ...r.log,
        })
        q.fsrs = r.fs
        q.stats = r.stats
        result.advanced++
        continue
      }
      let ctx = ctxCache.get(loc.course)
      if (ctx === undefined) {
        const c = await this.e.registry.get(loc.course)
        if (!c) ctx = null
        else {
          const { graph } = await this.e.loadView(c)
          ctx = { c, graph, sched: await this.e.sched(this.e.paths.courseRoot(c.root)) }
        }
        ctxCache.set(loc.course, ctx)
      }
      if (!ctx) { noteUnknown('课程不在注册表'); continue }
      const courseRoot = this.e.paths.courseRoot(ctx.c.root)
      const bank = await this.e.bank.load(courseRoot, loc.node)
      const idx = bank.questions.findIndex(x => x.id === loc.qid)
      const q = idx >= 0 ? bank.questions[idx] : undefined
      if (!q || q.archived) { noteUnknown('题目已归档或重生成'); continue }
      const practiceBase = {
        course: ctx.c.name, node: loc.node, ex: idx + 1, answer: '',
        correct: map.correct, judge: 'review', qid: loc.qid,
        ...(ev.timeMs > 0 ? { elapsed_s: ev.timeMs / 1000 } : {}),
        xp: 0,
      }
      // 回放守门（ADR-0014 anki 通道 = vault 调度动作判定）：当日已推进过
      // （含合成初始化）→ 跳过调度只留档（fsrs/stats/复习日志零写入）
      const r = advance(ctx.sched, q, map.rating, day, 'anki')
      await this.e.store.appendPractice({ ...practiceBase, ts: iso })
      if (!r.advanced) {
        result.skipped_same_day++
        continue
      }
      await this.e.bank.updateQuestionEvidence(courseRoot, loc.node, loc.qid, { fsrs: r.fs, stats: r.stats })
      await this.e.store.appendReview({
        course: ctx.c.name, node: loc.node, qid: loc.qid,
        rating: map.rating, rating_source: map.ratingSource, ...r.log,
      })
      // 代表卡随真实推进回刷（口径 B 稳定度分量随复习前进；与站内复习同一语义）
      await this.e.refreshRepCard(ctx.c, ctx.graph, loc.node)
      q.fsrs = r.fs // 后续同日事件在内存里立即可见（不变量判定不重读盘）
      q.stats = r.stats
      result.advanced++
    }
    mirror.last_import_ms = lastMs
    await this.e.ankiMirror.save(mirror)
    return result
  }


  /** Anki 通道状态：镜象规模/最近推送与导入/当前到期分布 + AnkiConnect 可达性。 */
  async ankiStatus(transport?: AnkiTransport, today?: string): Promise<AnkiStatusDoc> {
    today ??= (await this.e.learningDay()).today
    const mirror = await this.e.ankiMirror.load()
    const payloads = await this.collectAnkiDuePayloads(today)
    const byDeck = new Map<string, number>()
    for (const p of payloads) byDeck.set(p.deckName, (byDeck.get(p.deckName) ?? 0) + 1)
    let anki: Record<string, unknown> | undefined
    if (transport) {
      try {
        await transport.invoke('version')
        anki = { connected: true }
      } catch (err) {
        anki = { connected: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
      }
    }
    return {
      date: today,
      mirror: {
        entries: mirror.notes.length,
        last_push: mirror.last_push,
        last_import: mirror.last_import_ms > 0 ? isoFromMs(mirror.last_import_ms) : null,
        decks: [...new Set(mirror.notes.map(n => n.deck))].filter(Boolean),
      },
      due: { total: payloads.length, by_deck: [...byDeck].map(([deck, count]) => ({ deck, count })) },
      ...(anki ? { anki } : {}),
    }
  }
}
