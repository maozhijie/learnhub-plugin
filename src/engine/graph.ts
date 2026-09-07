/**
 * 概念图模型 + data/*.yaml 加载 + 结构检查 + 快照（吸收自 Python graphstore.py）。
 *
 * data/*.yaml 是图结构最终事实源（人可读、git 可审、agent 经提案修改）；
 * schema 级错误抛 SchemaError 直接中断；语义级问题（重名/断边/环）由 audit 报告。
 * Graph 构造不因重名/断边/环崩溃：派生邻接表、拓扑序（环检测）、深度、可达集、
 * 传递约简边、连通分量、就绪判定，语义与 Python 版逐项对齐。
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { YAML } from './yaml.ts'
import { atomicWrite } from './store.ts'
import { safeFilename } from './paths.ts'
import type { GBlock, GNode, GRegion, EncEdge } from './types.ts'
import { BLOOM_LEVELS } from './types.ts'
import type { Paths } from './paths.ts'

const NODE_KEYS = new Set(['name', 'pre', 'opt', 'note', 'enc', 'est', 'type', 'bloom', 'difficulty'])
const NODE_TYPES = new Set(['practice'])

export class SchemaError extends Error {}

function fail(path: string, msg: string): never {
  throw new SchemaError(`${path.replace(/[/\\]/g, '/').split('/').pop()}: ${msg}`)
}

function parseEnc(raw: unknown, path: string, where: string, name: string): EncEdge[] {
  if (!Array.isArray(raw)) fail(path, `${where}[${name}] enc 必须是列表`)
  const out: EncEdge[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ node: item, w: 1.0 })
    } else if (typeof item === 'object' && item !== null) {
      const e = item as Record<string, unknown>
      const t = e.node
      if (typeof t !== 'string' || !t.trim()) fail(path, `${where}[${name}] enc 条目缺 node`)
      const w = e.w ?? 1.0
      if (typeof w !== 'number' || !(w >= 0 && w <= 1)) fail(path, `${where}[${name}] enc 权重 w 必须是 0–1 的数`)
      const entry: EncEdge = { node: t, w }
      if (e.note !== undefined) {
        if (typeof e.note !== 'string') fail(path, `${where}[${name}] enc note 必须是字符串`)
        entry.note = e.note
      }
      const unknown = Object.keys(e).filter(k => !['node', 'w', 'note'].includes(k))
      if (unknown.length) fail(path, `${where}[${name}] enc 条目含未知字段 ${JSON.stringify(unknown)}`)
      out.push(entry)
    } else {
      fail(path, `${where}[${name}] enc 条目必须是字符串或映射`)
    }
  }
  return out
}

/** 持久图与 gen 提案共用的节点 schema 解析：gen 在受理前收集同一套错误。 */
export function parseNode(raw: unknown, path: string, where: string): GNode {
  if (typeof raw !== 'object' || raw === null) fail(path, `${where} 节点必须是映射`)
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter(k => !NODE_KEYS.has(k))
  if (unknown.length) fail(path, `${where} 含未知字段 ${JSON.stringify(unknown)}（只允许 ${[...NODE_KEYS].join('/')}）`)
  const name = r.name
  if (typeof name !== 'string' || !name.trim()) fail(path, `${where} 节点 name 缺失或为空`)
  const pre = r.pre ?? []
  if (!Array.isArray(pre) || pre.some(p => typeof p !== 'string')) fail(path, `${where}[${name}] pre 必须是字符串列表`)
  const opt = r.opt ?? false
  if (typeof opt !== 'boolean') fail(path, `${where}[${name}] opt 必须是布尔值`)
  const note = r.note ?? ''
  if (typeof note !== 'string') fail(path, `${where}[${name}] note 必须是字符串`)
  const enc = parseEnc(r.enc ?? [], path, where, name)
  const node: GNode = { name: name.trim(), pre: pre as string[], opt, note, enc }
  if (r.est !== undefined) {
    const est = Number(r.est)
    if (!Number.isFinite(est) || est <= 0) fail(path, `${where}[${node.name}] est 必须是正数（分钟）`)
    node.est = Math.round(est)
  }
  if (r.type !== undefined) {
    const type = String(r.type)
    if (!NODE_TYPES.has(type)) fail(path, `${where}[${node.name}] type 只允许 practice`)
    node.type = type as GNode['type']
  }
  if (r.bloom !== undefined) {
    if (!(BLOOM_LEVELS as readonly string[]).includes(String(r.bloom))) {
      fail(path, `${where}[${node.name}] bloom 非法（允许 ${BLOOM_LEVELS.join('/')}）`)
    }
    node.bloom = r.bloom as GNode['bloom']
  }
  if (r.difficulty !== undefined) {
    const difficulty = Number(r.difficulty)
    if (![1, 2, 3, 4, 5].includes(difficulty)) fail(path, `${where}[${node.name}] difficulty 必须是 1-5`)
    node.difficulty = difficulty as GNode['difficulty']
  }
  return node
}

/** 解析单个区 YAML 文件为 Region。 */
export function loadRegionDoc(doc: unknown, path: string): GRegion {
  if (typeof doc !== 'object' || doc === null) fail(path, '顶层必须是映射（region/color/blocks）')
  const d = doc as Record<string, unknown>
  const region = d.region
  if (typeof region !== 'string' || !region.trim()) fail(path, 'region 缺失或为空')
  const color = typeof d.color === 'string' ? d.color : ''
  if (typeof d.color === 'undefined') { /* color 缺省允许 */ }
  if (!Array.isArray(d.blocks)) fail(path, 'blocks 必须是列表')
  const blocks: GBlock[] = d.blocks.map((braw, bi) => {
    const where = `块#${bi + 1}`
    if (typeof braw !== 'object' || braw === null || typeof (braw as Record<string, unknown>).name !== 'string') {
      fail(path, `${where} 缺少 name`)
    }
    const b = braw as Record<string, unknown>
    const bname = (b.name as string).trim()
    if (!Array.isArray(b.nodes)) fail(path, `块[${bname}] nodes 必须是列表`)
    const nodes = (b.nodes as unknown[]).map(nraw => parseNode(nraw, path, `块[${bname}]`))
    return { name: bname, nodes }
  })
  return { name: region.trim(), color, blocks }
}

export class GraphStore {
  constructor(private paths: Paths, private courseRoot: string) {}

  private get dataDir(): string { return join(this.courseRoot, 'data') }

  /** 按文件名顺序加载 data 目录全部 .yaml → Region 列表。 */
  async load(): Promise<GRegion[]> {
    const files = await this.regionFilePaths()
    if (!files.length) throw new SchemaError(`数据目录为空或不存在: ${this.dataDir}`)
    const out: GRegion[] = []
    for (const p of files) {
      out.push(loadRegionDoc(YAML.parse(await readFile(p, 'utf8')), p))
    }
    return out
  }

  async regionFilePaths(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.dataDir)
    } catch {
      return []
    }
    return entries.filter(f => f.endsWith('.yaml')).sort()
      .map(f => join(this.dataDir, f))
  }

  /** 区名 → yaml 文件路径（gen 的 append/编辑用）。 */
  async regionFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const p of await this.regionFilePaths()) {
      const r = loadRegionDoc(YAML.parse(await readFile(p, 'utf8')), p)
      out[r.name] = p
    }
    return out
  }

  /** Region → YAML 文本（节点字段按 name/pre/opt/note/est/type/bloom/difficulty/enc 顺序，省空值）。 */
  regionDoc(region: GRegion, color?: string): Record<string, unknown> {
    return {
      region: region.name,
      color: color !== undefined ? color : region.color,
      blocks: region.blocks.map(b => ({
        name: b.name,
        nodes: b.nodes.map(n => {
          const doc: Record<string, unknown> = { name: n.name }
          if (n.pre.length) doc.pre = [...n.pre]
          if (n.opt) doc.opt = true
          if (n.note) doc.note = n.note
          if (n.est !== undefined) doc.est = n.est
          if (n.type) doc.type = n.type
          if (n.bloom) doc.bloom = n.bloom
          if (n.difficulty !== undefined) doc.difficulty = n.difficulty
          if (n.enc.length) doc.enc = n.enc.map(e => {
            const edge: Record<string, unknown> = { node: e.node, w: e.w }
            if (e.note) edge.note = e.note
            return edge
          })
          return doc
        }),
      })),
    }
  }

  async writeRegionDoc(path: string, region: GRegion): Promise<void> {
    await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
    await writeFile(path, YAML.stringify(this.regionDoc(region)), 'utf8')
  }
}

/** 概念图（graphstore.Graph 同构派生结构）。 */
export class Graph {
  names: string[] = []
  preOf: Record<string, string[]> = {}
  opt = new Set<string>()
  noteOf: Record<string, string> = {}
  /** name → 标称学习时长（分钟；未标注的节点不在表内）。 */
  estOf: Record<string, number> = {}
  /** name → 节点类型（practice 交互实践；普通节点不在表内）。 */
  typeOf: Record<string, 'practice'> = {}
  /** name → Bloom 认知层级（可选字段；未标注的节点不在表内）。 */
  bloomOf: Record<string, string> = {}
  /** name → 难度 1-5（可选字段；未标注的节点不在表内）。 */
  difficultyOf: Record<string, number> = {}
  regionIdxOf: Record<string, number> = {}
  /** name → [区序号, 区名, 块名]。 */
  blockOf: Record<string, [number, string, string]> = {}
  encOf: Record<string, [string, number][]> = {}
  count: Record<string, number> = {}
  succ: Record<string, string[]> = {}
  pred: Record<string, string[]> = {}
  nset = new Set<string>()
  order: string[] = []
  hasCycle = false
  cycleNodes: string[] = []
  depth: Record<string, number> = {}
  reach: Record<string, Set<string>> = {}
  leaves: string[] = []
  roots: string[] = []
  /** 渲染用边 = 传递约简后的边（[u, v] 升序）。 */
  edges: [string, string][] = []
  components: string[][] = []

  constructor(readonly regions: GRegion[]) {
    for (const n of this.regions.flatMap(r => r.blocks.flatMap(b => b.nodes))) {
      this.names.push(n.name)
      this.count[n.name] = (this.count[n.name] ?? 0) + 1
      this.preOf[n.name] = [...n.pre]
    }
    for (const [ridx, region] of this.regions.entries()) {
      for (const block of region.blocks) {
        for (const node of block.nodes) {
          const n = node.name
          this.regionIdxOf[n] = ridx
          this.blockOf[n] = [ridx, region.name, block.name]
          this.encOf[n] = node.enc.map(e => [e.node, e.w])
          if (node.opt) this.opt.add(n)
          if (node.note) this.noteOf[n] = node.note
          if (node.est !== undefined) this.estOf[n] = node.est
          if (node.type) this.typeOf[n] = node.type
          if (node.bloom) this.bloomOf[n] = node.bloom
          if (node.difficulty !== undefined) this.difficultyOf[n] = node.difficulty
        }
      }
    }
    this.nset = new Set(this.names)
    for (const n of this.names) {
      this.succ[n] = []
      this.pred[n] = []
    }
    for (const n of this.names) {
      for (const p of this.preOf[n]) {
        if (this.nset.has(p)) {
          this.succ[p].push(n)
          this.pred[n].push(p)
        }
      }
    }
    // 拓扑序（Kahn）+ 环检测
    const indeg: Record<string, number> = {}
    for (const n of this.names) indeg[n] = this.pred[n].length
    const queue = this.names.filter(n => indeg[n] === 0)
    while (queue.length) {
      const u = queue.shift()!
      this.order.push(u)
      for (const v of this.succ[u]) {
        if (--indeg[v] === 0) queue.push(v)
      }
    }
    this.hasCycle = this.order.length !== this.names.length
    this.cycleNodes = this.names.filter(n => indeg[n] > 0)

    if (!this.hasCycle) {
      for (const u of this.order) {
        this.depth[u] = Math.max(-1, ...this.pred[u].map(p => this.depth[p] ?? -1)) + 1
      }
      for (const u of [...this.order].reverse()) {
        const s = new Set<string>()
        for (const v of this.succ[u]) {
          s.add(v)
          for (const w of this.reach[v] ?? []) s.add(w)
        }
        this.reach[u] = s
      }
    }

    this.leaves = this.names.filter(n => !this.succ[n].length)
    this.roots = this.names.filter(n => !this.pred[n].length)

    if (!this.hasCycle) {
      const keep = new Set<string>()
      for (const u of this.names) {
        for (const v of this.succ[u]) {
          const redundant = this.succ[u].some(w => w !== v && (this.reach[w]?.has(v)))
          if (!redundant) keep.add(`${u}\u0000${v}`)
        }
      }
      this.edges = [...keep].map(s => s.split('\u0000') as [string, string]).sort()
    }
    this.buildComponents()
  }

  private buildComponents(): void {
    const parent: Record<string, string> = {}
    for (const n of this.names) parent[n] = n
    const find = (a: string): string => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]]
        a = parent[a]
      }
      return a
    }
    for (const n of this.names) {
      for (const p of this.pred[n]) {
        const ra = find(n)
        const rb = find(p)
        if (ra !== rb) parent[ra] = rb
      }
    }
    const comp: Record<string, string[]> = {}
    for (const n of this.names) {
      const r = find(n)
      ;(comp[r] ??= []).push(n)
    }
    this.components = Object.values(comp)
  }

  /** 就绪 = 全部前置已完成或为可选概念。 */
  isReady(n: string, done: Set<string>): boolean {
    return this.preOf[n].every(p => done.has(p) || this.opt.has(p))
  }

  /** a 是否为 n 的祖先（pre 传递闭包内，不含自身）。 */
  isAncestor(a: string, n: string): boolean {
    return a !== n && (this.reach[a]?.has(n) ?? false)
  }

  readySet(done: Set<string>, doing: Set<string>): string[] {
    return this.names
      .filter(n => !done.has(n) && !doing.has(n) && this.isReady(n, done))
      .sort()
  }

  edgeCount(): number {
    return Object.values(this.succ).reduce((s, v) => s + v.length, 0)
  }
}

/** 合并结构检查：重名 / 断边 / 环 → 错误列表（空 = 通过）（gen._structure_check 同语义）。 */
export function structureCheck(existing: Graph | null, newRegions: GRegion[], label: string): string[] {
  const errors: string[] = []
  const mergedNames = existing ? [...existing.names] : []
  const newNodes = newRegions.flatMap(r => r.blocks.flatMap(b => b.nodes))
  const seen = new Set(mergedNames)
  for (const n of newNodes) {
    if (seen.has(n.name)) errors.push(`${label}重名节点: ${n.name}`)
    seen.add(n.name)
  }
  for (const n of newNodes) {
    for (const p of n.pre) {
      if (!seen.has(p)) errors.push(`${label}断边: ${n.name} -> ${p}（未定义的前置）`)
    }
    for (const e of n.enc) {
      if (!seen.has(e.node)) errors.push(`${label}enc 断边: ${n.name} -> ${e.node}`)
    }
  }
  if (!errors.length) {
    const merged = new Graph([...(existing?.regions ?? []), ...newRegions])
    if (merged.hasCycle) errors.push(`${label}引入环：涉及 ${merged.cycleNodes.slice(0, 5).join('、')}`)
  }
  return errors
}

/** 整图快照文档（data/*.yaml 的文档序列 JSON 化，save_snapshot 同构）。 */
export function snapshotDoc(store: GraphStore, regions: GRegion[]): unknown {
  return regions.map(r => store.regionDoc(r))
}

/** 就绪清单构建（build 产物：按区/块列未学条目）。 */
export async function writeReadyList(paths: Paths, root: string, graph: Graph, done: Set<string>): Promise<void> {
  const lines: string[] = ['# 就绪清单', '', '> 引擎自动生成：当前就绪（前置达标）的未学节点，按区/块分组。', '']
  const ready = graph.readySet(done, new Set())
  const byRegion: Record<string, string[]> = {}
  for (const n of ready) {
    const region = graph.blockOf[n][1]
    ;(byRegion[region] ??= []).push(n)
  }
  for (const region of graph.regions) {
    const items = byRegion[region.name]
    if (!items?.length) continue
    lines.push(`## ${region.name}`, '')
    for (const n of items) lines.push(`- ${n}（块：${graph.blockOf[n][2]}）`)
    lines.push('')
  }
  await atomicWrite(paths.readyPath(root), lines.join('\n'))
}

export { safeFilename }
