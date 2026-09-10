/**
 * agent 产出（图/变更）的门禁与落盘 + 提案生命周期（吸收自 Python gen.py）。
 *
 * 流程铁律：agent 产出 YAML → schema 校验 → 结构检查（断边/环/冲突）→
 * 提案落盘 pending（产物文件全留痕）→ 人审 → apply 过 audit 门禁生效 → journal + 快照。
 * 拒绝同样留痕（status=rejected）。
 */
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { YAML } from './yaml.ts'
import { atomicWrite } from './store.ts'
import { Graph, GraphStore, parseNode, snapshotDoc } from './graph.ts'
import { saveNote, defaultFrontmatter } from './notes.ts'
import type { GRegion, GBlock, GNode, BloomLevel, EncEdge } from './types.ts'
import { BLOOM_LEVELS, PROPOSAL_KINDS } from './types.ts'
import type { Paths } from './paths.ts'
import type { Store } from './store.ts'
import type { CourseEntry } from './types.ts'

/** apply 门禁的审计快照（facade 层跑 audit 后传入；findings 由 warns + 健康分组成）。 */
export interface ApplyAudit { ok: boolean; warns: string[]; health: number }

export interface GenProposalSpec {
  course: string
  mode: 'new' | 'append'
  regions: Array<{ region: string; color?: string; blocks: Array<{ name: string; nodes: GNode[] }> }>
}

export interface EditOp {
  op: 'add_node' | 'del_node' | 'set_pre' | 'set_enc' | 'rename' | 'move' | 'set_note'
  node?: string
  new?: string
  region?: string
  block?: string
  pre?: string[]
  /** set_enc 整体替换的成分技能边（与图 YAML 同形态：字符串=权重 1，映射带可选 w/note）；add_node 可选携带。 */
  enc?: Array<string | { node: string; w?: number; note?: string }>
  opt?: boolean
  note?: string
  est?: number
  type?: 'practice'
  bloom?: string
  difficulty?: number
}

export interface EditProposalSpec {
  course: string
  reason?: string
  ops: EditOp[]
}

const EDIT_OPS = ['add_node', 'del_node', 'set_pre', 'set_enc', 'rename', 'move', 'set_note'] as const

/** gen 骨架提案退役（#138 cutover / ADR-0033 生长式图）：受理门统一拒收，新课程
 * 入口由种子提案接管（#142），反编译子图入口随种子票重接（#149）。 */
export function genRetiredError(what: string): Error {
  return new Error(
    `[${what}] kind=gen 骨架提案已退役（#138 cutover / ADR-0033 生长式图）——`
    + '新课程入口由种子提案接管（#142），课程结构变更用 kind=edit；'
    + '存量 pending gen 提案不再受理 apply（reject 留痕）。')
}

/** EditOp 的 enc 载荷 → EncEdge[]（字符串=权重 1，映射带可选 w/note；与图 YAML parseEnc 同形态）。 */
function normalizeOpEnc(raw: EditOp['enc']): EncEdge[] {
  return (raw ?? []).map(item => typeof item === 'string'
    ? { node: item, w: 1.0 }
    : { node: item.node, w: item.w ?? 1.0, ...(item.note ? { note: item.note } : {}) })
}

function nonempty(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} 不能为空`)
  return v.trim()
}

/** GenProposal schema 校验（手写，错误行格式与旧引擎一致）。 */
export function validateGenProposal(doc: unknown): { errors?: string[]; spec?: GenProposalSpec } {
  const errors: string[] = []
  const d = doc as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return { errors: ['(顶层): 必须是映射'] }
  try {
    nonempty(d.course, 'course')
  } catch (e) { errors.push((e as Error).message) }
  if (d.mode === undefined) errors.push('mode: 缺失（必填，只允许 new/append：新增课程写 new，向已有课程追加写 append）')
  else if (d.mode !== 'new' && d.mode !== 'append') errors.push('mode: 只允许 new/append（新增课程写 new；向已有课程追加写 append）')
  const regions: GenProposalSpec['regions'] = []
  if (!Array.isArray(d.regions) || !d.regions.length) {
    errors.push('regions: 不能为空')
  } else {
    d.regions.forEach((rr: unknown, i: number) => {
      const r = rr as Record<string, unknown> | null
      const where = `regions.${i}`
      if (typeof r !== 'object' || r === null) {
        errors.push(`${where}: 必须是映射`)
        return
      }
      if (typeof r.region !== 'string' || !r.region.trim()) {
        const hint = typeof r.name === 'string' && r.name.trim()
          ? `（区条目的键是 region，不是 name——你写了 name: ${r.name.trim()}）`
          : ''
        errors.push(`${where}.region 不能为空${hint}`)
      }
      const blocks: GenProposalSpec['regions'][number]['blocks'] = []
      if (!Array.isArray(r.blocks) || !r.blocks.length) {
        errors.push(`${where}.blocks: 块[${String(r.region)}] 没有节点`)
      } else {
        r.blocks.forEach((br: unknown, bi: number) => {
          const b = br as Record<string, unknown> | null
          if (typeof b !== 'object' || b === null || typeof b.name !== 'string' || !b.name.trim()) {
            errors.push(`${where}.blocks.${bi}: 块 name 不能为空`)
            return
          }
          if (!Array.isArray(b.nodes)) {
            errors.push(`${where}.blocks.${bi}: 块[${b.name}] nodes 必须是列表`)
            return
          }
          const rawNodes = b.nodes
          const nodes: GNode[] = []
          if (!rawNodes.length) {
            errors.push(`${where}.blocks.${bi}: 块[${b.name}] 没有节点`)
            return
          }
          // 受理前复用持久图节点解析，避免 gen 专用宽松解析把坏数据留到 apply 时才暴露。
          rawNodes.forEach((rawNode: unknown, ni: number) => {
            try {
              nodes.push(parseNode(rawNode, '生成提案', `${where}.blocks.${bi}.nodes.${ni}`))
            } catch (e) {
              errors.push((e as Error).message)
            }
          })
          blocks.push({ name: b.name.trim(), nodes })
        })
      }
      regions.push({ region: typeof r.region === 'string' ? r.region.trim() : '', color: typeof r.color === 'string' ? r.color : '', blocks })
    })
  }
  if (errors.length) return { errors }
  return { spec: { course: (d!.course as string).trim(), mode: (d!.mode as 'new' | 'append') ?? 'append', regions } }
}

/** EditOp / EditProposal schema 校验。 */
export function validateEditProposal(doc: unknown): { errors?: string[]; spec?: EditProposalSpec } {
  const errors: string[] = []
  const d = doc as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return { errors: ['(顶层): 必须是映射'] }
  try {
    nonempty(d.course, 'course')
  } catch (e) { errors.push((e as Error).message) }
  const ops: EditOp[] = []
  if (!Array.isArray(d.ops) || !d.ops.length) {
    errors.push('ops: 提案没有操作条目')
  } else {
    d.ops.forEach((raw: unknown, i: number) => {
      const o = raw as Record<string, unknown> | null
      const where = `ops.${i}`
      if (typeof o !== 'object' || o === null) {
        errors.push(`${where}: 必须是映射`)
        return
      }
      const op = o.op
      if (typeof op !== 'string' || !(EDIT_OPS as readonly string[]).includes(op)) {
        errors.push(`${where}.op: 非法操作 ${String(op)}（允许 ${EDIT_OPS.join('/')}）`)
        return
      }
      // 历史口径：gen 提案节点键是 name（对齐图 YAML），edit 的 add_node 用 node——刻意不统一
      // （统一是 breaking 改动，影响技能文档/校验/存量提案），由速查表 + 报错键名对照兜底。
      // 统一计划与影响面：https://github.com/maozhijie/learnhub-plugin/issues/1
      if (!(o.node && String(o.node).trim())) {
        const hint = op === 'add_node' && typeof o.name === 'string' && o.name.trim()
          ? `（add_node 的节点字段名是 node，不是 name——你写了 name: ${o.name.trim()}）`
          : ''
        errors.push(`${where}: op=${op} 需要 node${hint}`)
      }
      if (op === 'rename' && !(o.new && String(o.new).trim())) errors.push(`${where}: rename 需要 new（rename 成对字段：node=旧名，new=新名）`)
      if ((op === 'add_node' || op === 'move') && !(o.region && o.block)) errors.push(`${where}: op=${op} 需要 region 与 block（分区定位：区名 + 块名）`)
      // 整体替换语义防呆：缺 pre/enc 数组会被当成空集静默清掉已有边，这里直接拒绝（显式清空写 pre: [] / enc: []）
      if (op === 'set_pre' && !Array.isArray(o.pre)) errors.push(`${where}: set_pre 需要 pre 列表（整体替换语义，缺省会被当成清空全部前置；显式清空写 pre: []）`)
      if (op === 'set_enc' && !Array.isArray(o.enc)) errors.push(`${where}: set_enc 需要 enc 列表（整体替换语义，缺省会被当成清空全部成分技能边；显式清空写 enc: []）`)
      // 认知维度可选字段（schema 从严：给了就必合法）
      if (o.bloom !== undefined && o.bloom !== '' && !(BLOOM_LEVELS as readonly string[]).includes(String(o.bloom))) {
        errors.push(`${where}.bloom: 非法认知层级 ${String(o.bloom)}（允许 ${BLOOM_LEVELS.join('/')}）`)
      }
      if (o.difficulty !== undefined && o.difficulty !== '' && ![1, 2, 3, 4, 5].includes(Number(o.difficulty))) {
        errors.push(`${where}.difficulty: 非法难度 ${String(o.difficulty)}（允许 1-5）`)
      }
      if (o.est !== undefined && o.est !== '' && !(Number.isFinite(Number(o.est)) && Number(o.est) > 0)) {
        errors.push(`${where}.est: 非法时长 ${String(o.est)}（分钟，正数）`)
      }
      if (o.type !== undefined && o.type !== '' && o.type !== 'practice') {
        errors.push(`${where}.type: 非法节点类型 ${String(o.type)}（只允许 practice）`)
      }
      if (o.enc !== undefined) {
        if (!Array.isArray(o.enc)) {
          errors.push(`${where}.enc: 必须是列表`)
        } else o.enc.forEach((e: unknown, j: number) => {
          const item = e as Record<string, unknown> | string | null
          const t = typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.node
          if (typeof t !== 'string' || !t.trim()) errors.push(`${where}.enc.${j}: 缺 node`)
          const w = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).w : undefined
          if (w !== undefined && (typeof w !== 'number' || w < 0 || w > 1)) errors.push(`${where}.enc.${j}: w 必须是 0–1 的数`)
        })
      }
      ops.push({
        op: op as EditOp['op'],
        node: typeof o.node === 'string' ? o.node.trim() : undefined,
        new: typeof o.new === 'string' ? o.new.trim() : undefined,
        region: typeof o.region === 'string' ? o.region.trim() : undefined,
        block: typeof o.block === 'string' ? o.block.trim() : undefined,
        pre: Array.isArray(o.pre) ? o.pre.map(String) : [],
        ...(Array.isArray(o.enc) ? { enc: o.enc as EditOp['enc'] } : {}),
        opt: Boolean(o.opt),
        note: typeof o.note === 'string' ? o.note : undefined,
        ...(Number.isFinite(Number(o.est)) && Number(o.est) > 0 ? { est: Math.round(Number(o.est)) } : {}),
        ...(o.type === 'practice' ? { type: 'practice' as const } : {}),
        ...(typeof o.bloom === 'string' && (BLOOM_LEVELS as readonly string[]).includes(o.bloom)
          ? { bloom: o.bloom as BloomLevel } : {}),
        ...([1, 2, 3, 4, 5].includes(Number(o.difficulty))
          ? { difficulty: Number(o.difficulty) as 1 | 2 | 3 | 4 | 5 } : {}),
      })
    })
  }
  if (errors.length) return { errors }
  return { spec: { course: (d!.course as string).trim(), reason: typeof d!.reason === 'string' ? d!.reason : '', ops } }
}

/** apply 返回的 findings：audit warns 摘要 + 健康分不足提示（引擎不设阈值，
 * 结束条件「≥ 80」归 learnhub-graph-generate 技能的 agent 纪律）。 */
function applyFindings(audit: ApplyAudit): string[] {
  const findings = audit.warns.map(w => `⚠ ${w}`)
  if (audit.ok && audit.health > 0 && audit.health < 80) {
    findings.push(`⚠ 图谱健康分 ${audit.health} < 80：结束条件未满足，继续分批构建（learnhub_graph_analyze 的 health/suggestions 给出方向）`)
  }
  return findings
}

export class GraphProposals {
  constructor(
    private paths: Paths,
    private store: Store,
    private registry: { get(key: string): Promise<CourseEntry | null>; load(): Promise<CourseEntry[]>; save(c: CourseEntry[]): Promise<void> },
    private centerRoot: string,
  ) {}

  /** 为图中缺笔记的节点补骨架文件（幂等）：gen/edit apply 落图后调用。
   * 节点存在于图就该有 frontmatter 文件——vault 笔记是调度状态的事实源。 */
  async ensureNotesFor(root: string, regions: GRegion[]): Promise<number> {
    let created = 0
    for (const r of regions) {
      for (const b of r.blocks) {
        for (const n of b.nodes) {
          const path = this.paths.courseNotePath(root, r.name, n.name)
          if (existsSync(path)) continue
          await saveNote(path, defaultFrontmatter(n.name) as unknown as Record<string, unknown>, '> 内容待生成。\n')
          created++
        }
      }
    }
    return created
  }

  /** 提案产物 YAML 落盘（全留痕）→ artifact 路径。 */
  private async saveArtifact(kind: string, course: string, doc: unknown): Promise<{ pid: number; path: string }> {
    const pid = await this.store.createProposal(kind as 'gen' | 'edit', course, '', '')
    const path = this.paths.proposalArtifactPath(pid, kind, course)
    await mkdir(this.paths.proposalDir, { recursive: true })
    await writeFile(path, YAML.stringify(doc), 'utf8')
    await this.store.updateProposal(pid, { artifact: path })
    return { pid, path }
  }

  private async loadArtifact(path: string): Promise<unknown> {
    if (!existsSync(path)) throw new Error(`[gen] 文件不存在: ${path}`)
    return YAML.parse(await readFile(path, 'utf8'))
  }

  /** graph propose-gen：已退役（#138 cutover / ADR-0033 生长式图）。
   * validateGenProposal/specToRegions 保留——反编译子图半区（project-decompile）
   * 仍以它们做静态形态门；gen 作为提案 kind 不再受理。 */
  async proposeGen(_yamlText?: string): Promise<Record<string, unknown>> {
    throw genRetiredError('propose-gen')
  }

  /** graph apply-gen：已退役（同上）；存量 pending gen 提案只能 reject 留痕。 */
  async applyGen(_pid?: number, _audit?: ApplyAudit): Promise<Record<string, unknown>> {
    throw genRetiredError('apply-gen')
  }

  /** graph propose-edit：在内存图上模拟执行 → pending。 */
  async proposeEdit(yamlText: string): Promise<Record<string, unknown>> {
    const v = validateEditProposal(YAML.parseModel(yamlText))
    if (v.errors) throw new Error(`[propose-edit] schema 校验失败，提案未受理。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[propose-edit] 注册表中没有课程「${spec.course}」。`)
    const regions = await new GraphStore(this.paths, this.paths.courseRoot(course.root)).load()
    const graph = new Graph(regions)
    const errors = simulateOps(regions, graph, spec.ops)
    if (errors.length) throw new Error(`[propose-edit] 模拟执行失败，提案未受理（修正后重提）。\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const { pid } = await this.saveArtifact('edit', spec.course, YAML.parseModel(yamlText))
    await this.store.updateProposal(pid, { summary: `${spec.ops.length} 条操作：${spec.ops.map(o => o.op).join('、')}` })
    return { id: pid, kind: 'edit', course: spec.course, ops: spec.ops.length }
  }

  /** graph apply-edit：执行变更 + 改名/移动/删除联动课程笔记 + 快照。 */
  async applyEdit(pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }): Promise<Record<string, unknown>> {
    if (!audit.ok) throw new Error('[apply-edit] 审计存在 ERROR，拒绝写入——先处理 审计报告.md。')
    const prop = await this.store.takePending('edit', pid)
    const v = validateEditProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[apply-edit] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[apply-edit] 注册表中没有课程「${spec.course}」。`)
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root))
    const regions = await store.load()
    const graph = new Graph(regions)
    const errors = simulateOps(regions, graph, spec.ops) // 二次校验
    if (errors.length) throw new Error('[apply-edit] 提案已不适用当前图（被拒绝，可重提）。')

    const createdBlocks = new Set<string>()
    for (const op of spec.ops) {
      if (op.op !== 'add_node') continue
      const region = regions.find(r => r.name === op.region)
      if (region && !region.blocks.some(b => b.name === op.block)) createdBlocks.add(op.block!)
    }

    const renames: Record<string, string> = {}
    const moves: Array<[string, string, string]> = []
    const dels: string[] = []
    for (const op of spec.ops) {
      if (op.op === 'rename') renames[op.node!] = op.new!
      else if (op.op === 'move') moves.push([op.node!, op.region!, op.block!])
      else if (op.op === 'del_node') dels.push(op.node!)
    }

    // 1. data/*.yaml 重写
    applyOpsToRegions(regions, spec.ops)
    const files = await store.regionFiles()
    for (const region of regions) {
      if (region.name in files) await store.writeRegionDoc(files[region.name], region)
    }

    // 2. 改名/移动/删除联动课程笔记（用 ops 应用前的图定位旧文件位置；
    //    graphAfter 里旧名已不存在/位置已变，会让联动静默失效）
    for (const [oldName, newName] of Object.entries(renames)) await this.relocateNote(root, graph, oldName, newName, undefined)
    for (const [node, regionName] of moves) await this.relocateNote(root, graph, node, undefined, regionName)
    for (const node of dels) await this.archiveNote(root, graph, node, prop.id)

    const regions2 = await store.load()
    const version = (await this.store.latestSnapshotVersion(course.name)) + 1
    await this.store.saveSnapshot(course.name, version, snapshotDoc(store, regions2))
    await this.ensureNotesFor(root, regions2)
    await this.store.appendJournal({
      course: course.name, node: '*', rating: null, kind: 'graph_edit', elapsed_days: 0,
      session: String(prop.id), detail: spec.ops.map(o => `${o.op}(${o.node})`).join('；'),
    })
    await this.store.updateProposal(prop.id, { status: 'applied', decided: new Date().toISOString(), decision_note: `快照 v${version}` })
    return {
      course: course.name,
      ops: spec.ops.length,
      snapshot: version,
      created_blocks: [...createdBlocks],
      renames,
      deleted: dels,
      findings: applyFindings(audit),
    }
  }

  /** 改名/移动联动课程笔记：搬文件 + 更新 fm.node + 题库随迁；无笔记静默跳过。 */
  private async relocateNote(root: string, graph: Graph, node: string, newName?: string, newRegion?: string): Promise<void> {
    if (!graph.blockOf[node]) return
    const region = graph.blockOf[node][1]
    const oldPath = this.paths.courseNotePath(root, region, node)
    const targetName = newName ?? node
    const targetRegion = newRegion ?? region
    if (existsSync(oldPath)) {
      const { loadNote, saveNote } = await import('./notes.ts')
      const { fm, body } = await loadNote(oldPath)
      const newPath = this.paths.courseNotePath(root, targetRegion, targetName)
      await saveNote(newPath, { ...(fm ?? {}), node: targetName }, body)
      if (oldPath.toLowerCase() !== newPath.toLowerCase()) {
        // 新内容（fm.node=新名）已写入 newPath；摘除旧文件。
        // 不能 rename(oldPath, newPath)——会把旧 frontmatter 覆盖回新路径。
        await unlink(oldPath).catch(async () => {
          await writeFile(oldPath, '').catch(() => undefined)
        })
      }
    }
    // 题库随迁（改名时；无题库静默跳过）
    if (newName) {
      const { safeFilename } = await import('./paths.ts')
      const bankDir = this.paths.courseRoot(root)
      const oldBank = `${bankDir}/题库/${safeFilename(node)}.yaml`
      if (existsSync(oldBank)) {
        await rename(oldBank, `${bankDir}/题库/${safeFilename(targetName)}.yaml`).catch(() => undefined)
      }
    }
  }

  /** del_node：课程笔记与题库移入 state/archive（不丢用户内容）。 */
  private async archiveNote(root: string, graph: Graph, node: string, pid: number): Promise<void> {
    if (!graph.blockOf[node]) return
    const region = graph.blockOf[node][1]
    const oldPath = this.paths.courseNotePath(root, region, node)
    const archiveDir = `${this.paths.courseStateDir(root)}/archive`
    const { safeFilename } = await import('./paths.ts')
    if (existsSync(oldPath)) {
      await mkdir(archiveDir, { recursive: true })
      await rename(oldPath, `${archiveDir}/del-${pid}-${safeFilename(node)}.md`)
    }
    const oldBank = `${this.paths.courseRoot(root)}/题库/${safeFilename(node)}.yaml`
    if (existsSync(oldBank)) {
      await mkdir(archiveDir, { recursive: true })
      await rename(oldBank, `${archiveDir}/del-${pid}-${safeFilename(node)}.yaml`)
    }
  }

  /** graph reject。 */
  async reject(pid: number, note = ''): Promise<Record<string, unknown>> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`[reject] 提案 id 必须是正整数（收到 ${String(pid)}）；拒绝不能省略 id。`)
    }
    const list = await this.store.loadProposals()
    const prop = list.find(p => p.id === pid)
    if (!prop || prop.status !== 'pending') throw new Error(`[reject] 提案 #${pid} 不存在或已决。`)
    await this.store.updateProposal(pid, { status: 'rejected', decided: new Date().toISOString(), decision_note: note })
    return prop
  }

  /** 提案清单（status/kind 过滤可选）。kind 全集见 types PROPOSAL_KINDS（图谱域 + 项目域）。 */
  async list(status?: string, kind?: string, limit = 100): Promise<Record<string, unknown>[]> {
    let list = await this.store.loadProposals()
    if (status) {
      if (!['pending', 'applied', 'rejected'].includes(status)) throw new Error(`[proposals] 非法 status: ${status}（允许 pending/applied/rejected）`)
      list = list.filter(p => p.status === status)
    }
    if (kind) {
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`[proposals] 非法 kind: ${kind}（允许 ${PROPOSAL_KINDS.join('/')}）`)
      }
      list = list.filter(p => p.kind === kind)
    }
    return list.slice(-limit).reverse() as unknown as Record<string, unknown>[]
  }
}

/** GenProposal regions → GRegion（gen._spec_to_regions 同构；YAML 路径直接产 GNode）。 */
export function specToRegions(specRegions: GenProposalSpec['regions']): GRegion[] {
  return specRegions.map(r => ({
    name: r.region,
    color: r.color ?? '',
    blocks: r.blocks.map(b => ({
      name: b.name,
      nodes: b.nodes,
    })),
  }))
}

/** 在 regions 副本上模拟全部操作 → 错误列表（gen._simulate_ops 同语义）。 */
export function simulateOps(regions: GRegion[], graph: Graph, ops: EditOp[]): string[] {
  const sim: GRegion[] = JSON.parse(JSON.stringify(regions))
  const errors: string[] = []
  const names = new Set(graph.names)
  const renameMap: Record<string, string> = {}
  const removed = new Set<string>()

  const regionOf = (name: string) => sim.find(r => r.name === name)

  for (const op of ops) {
    if (op.op === 'add_node') {
      if (names.has(op.node!)) { errors.push(`add_node 重名: ${op.node}`); continue }
      const r = regionOf(op.region!)
      if (!r) { errors.push(`add_node 区不存在: ${op.region}`); continue }
      let blk = r.blocks.find(b => b.name === op.block)
      if (!blk) {
        blk = { name: op.block!, nodes: [] }
        r.blocks.push(blk)
      }
      blk.nodes.push({
              name: op.node!, pre: [...(op.pre ?? [])], opt: Boolean(op.opt), note: op.note ?? '',
              ...(op.enc !== undefined ? { enc: normalizeOpEnc(op.enc) } : { enc: [] }),
              ...(op.est !== undefined ? { est: op.est } : {}),
              ...(op.type ? { type: op.type } : {}),
              ...(op.bloom ? { bloom: op.bloom as BloomLevel } : {}),
              ...(op.difficulty !== undefined ? { difficulty: op.difficulty as GNode['difficulty'] } : {}),
            })
      names.add(op.node!)
    } else if (op.op === 'del_node') {
      if (!names.has(op.node!)) { errors.push(`del_node 节点不存在: ${op.node}`); continue }
      names.delete(op.node!)
      removed.add(op.node!)
    } else if (op.op === 'rename') {
      if (!names.has(op.node!)) errors.push(`rename 旧名不存在: ${op.node}`)
      else if (names.has(op.new!)) errors.push(`rename 新名已占用: ${op.new}`)
      else {
        renameMap[op.node!] = op.new!
        names.delete(op.node!)
        names.add(op.new!)
      }
    } else if (op.op === 'move') {
      if (!names.has(op.node!)) { errors.push(`move 节点不存在: ${op.node}`); continue }
      const dstRegion = regionOf(op.region!)
      if (!dstRegion) errors.push(`move 目标区不存在: ${op.region}`)
      else if (!dstRegion.blocks.some(b => b.name === op.block)) {
        errors.push(`move 目标块不存在（不允许静默建块）: ${op.region}/${op.block}`)
      }
    } else if (op.op === 'set_pre') {
      if (!names.has(op.node!)) { errors.push(`set_pre 节点不存在: ${op.node}`); continue }
      for (const r of sim) for (const b of r.blocks) for (const n of b.nodes) {
        if (n.name === op.node) n.pre = [...(op.pre ?? [])]
      }
    } else if (op.op === 'set_enc') {
      if (!names.has(op.node!)) { errors.push(`set_enc 节点不存在: ${op.node}`); continue }
      for (const r of sim) for (const b of r.blocks) for (const n of b.nodes) {
        if (n.name === op.node) n.enc = normalizeOpEnc(op.enc)
      }
    }
  }

  const mapped = (p: string) => renameMap[p] ?? p
  for (const r of sim) {
    for (const b of r.blocks) {
      for (const n of b.nodes) {
        if (removed.has(n.name)) continue
        n.name = mapped(n.name)
        n.pre = n.pre.map(mapped).filter(p => !removed.has(p))
        n.enc = n.enc.map(e => ({ ...e, node: mapped(e.node) })).filter(e => !removed.has(e.node))
      }
      b.nodes = b.nodes.filter(n => !removed.has(n.name))
    }
  }
  if (!errors.length) {
    const merged = new Graph(sim)
    const dangling = new Set(merged.names.flatMap(n => merged.preOf[n].filter(p => !merged.nset.has(p)).map(p => `${n} -> ${p}`)))
    for (const d of [...dangling].sort()) errors.push(`变更后断边: ${d}`)
    const encDangling = new Set(merged.names.flatMap(n => (merged.encOf[n] ?? []).filter(([p]) => !merged.nset.has(p)).map(([p]) => `${n} ~enc~ ${p}`)))
    for (const d of [...encDangling].sort()) errors.push(`变更后 enc 断边: ${d}`)
    if (merged.hasCycle) errors.push(`变更后引入环：${merged.cycleNodes.slice(0, 5).join('、')}`)
  }
  return errors
}

/** 把 op 列表实际落到 Region 对象列表（gen._apply_ops_to_regions 同语义）。 */
export function applyOpsToRegions(regions: GRegion[], ops: EditOp[]): void {
  const renameMap: Record<string, string> = {}
  const removed = new Set<string>()
  const regionOf = (name: string) => regions.find(r => r.name === name)
  const findNode = (node: string): { r: GRegion; b: GBlock; n: GNode } | null => {
    for (const r of regions) for (const b of r.blocks) {
      const n = b.nodes.find(x => x.name === node)
      if (n) return { r, b, n }
    }
    return null
  }

  for (const op of ops) {
    if (op.op === 'add_node') {
      const r = regionOf(op.region!)!
      let blk = r.blocks.find(b => b.name === op.block)
      if (!blk) {
        blk = { name: op.block!, nodes: [] }
        r.blocks.push(blk)
      }
      blk.nodes.push({
              name: op.node!, pre: [...(op.pre ?? [])], opt: Boolean(op.opt), note: op.note ?? '',
              ...(op.enc !== undefined ? { enc: normalizeOpEnc(op.enc) } : { enc: [] }),
              ...(op.est !== undefined ? { est: op.est } : {}),
              ...(op.type ? { type: op.type } : {}),
              ...(op.bloom ? { bloom: op.bloom as BloomLevel } : {}),
              ...(op.difficulty !== undefined ? { difficulty: op.difficulty as GNode['difficulty'] } : {}),
            })
    } else if (op.op === 'del_node') {
      removed.add(op.node!)
    } else if (op.op === 'rename') {
      renameMap[op.node!] = op.new!
    } else if (op.op === 'move') {
      const hit = findNode(op.node!)
      if (!hit) continue
      hit.b.nodes = hit.b.nodes.filter(n => n.name !== op.node)
      const dstR = regionOf(op.region!)!
      let dstBlk = dstR.blocks.find(b => b.name === op.block)
      if (!dstBlk) {
        throw new Error(`[apply-edit] move 目标块不存在（不允许静默建块）: ${op.region}/${op.block}`)
      }
      dstBlk.nodes.push(hit.n)
    } else if (op.op === 'set_pre') {
      const hit = findNode(op.node!)
      if (hit) hit.n.pre = [...(op.pre ?? [])]
    } else if (op.op === 'set_enc') {
      const hit = findNode(op.node!)
      if (hit) hit.n.enc = normalizeOpEnc(op.enc)
    } else if (op.op === 'set_note') {
      const hit = findNode(op.node!)
      if (hit) hit.n.note = op.note ?? ''
    }
  }

  const mapped = (p: string) => renameMap[p] ?? p
  for (const r of regions) {
    for (const b of r.blocks) {
      for (const n of b.nodes) {
        n.name = mapped(n.name)
        n.pre = n.pre.map(mapped).filter(p => !removed.has(p))
        n.enc = n.enc.map(e => ({ ...e, node: mapped(e.node) })).filter(e => !removed.has(e.node))
      }
      b.nodes = b.nodes.filter(n => !removed.has(n.name))
    }
    r.blocks = r.blocks.filter(b => b.nodes.length)
  }
}

export { atomicWrite }
