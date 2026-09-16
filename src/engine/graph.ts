/**
 * 概念图模型 + data/图.yaml 加载 + 结构检查 + 快照（吸收自 Python graphstore.py）。
 *
 * data/图.yaml 是图结构最终事实源（一课程一文件，#284 存储塌缩：人可读、git 可审、
 * agent 经提案修改）；
 * schema 级错误抛 SchemaError 直接中断；语义级问题（重名/断边/环）由 audit 报告。
 * Graph 构造不因重名/断边/环崩溃：派生邻接表、拓扑序（环检测）、深度、可达集、
 * 传递约简边、连通分量、就绪判定，语义与 Python 版逐项对齐。
 */
import type { VaultFs } from './io.ts'
import { join } from 'node:path'
import { YAML } from './yaml.ts'
import { atomicWrite } from './io.ts'
import { safeFilename } from './paths.ts'
import type { ConceptEntry } from './concepts.ts'
import { resolveConcept } from './concepts.ts'
import type { GNode, EncEdge, ConceptTier, Misconception } from './types.ts'
import { BLOOM_LEVELS, CONCEPT_TIERS } from './types.ts'
import type { Paths } from './paths.ts'

const NODE_KEYS = new Set(['name', 'pre', 'opt', 'note', 'enc', 'est', 'type', 'bloom', 'difficulty',
  'teaches', 'assumes', 'misconceptions'])
const NODE_TYPES = new Set(['practice'])

/** 边轻纪律（#127）：这些键是生长机制的边元数据，图 YAML 永不存储——给出指向性拒收文案。 */
const RETIRED_EDGE_KEYS: Record<string, string> = {
  origin: '边轻纪律：origin 从提案 journal 派生，图 YAML 不存储',
  status: '边轻纪律：复诊状态落 state/边实验.jsonl（边实验账本），图 YAML 零边字段',
  probation: '边轻纪律：复诊状态落 state/边实验.jsonl（边实验账本），图 YAML 零边字段',
}

/** 防复活门（#281 / Epic #275）：节点条目上的结构坐标键 fail loud 拒收——分组是读侧
 * 派生（depth/概念/终点），不落盘；Region/Block 不借尸还魂（照 origin/status 先例）。 */
const RETIRED_NODE_KEYS: Record<string, string> = {
  region: 'Region/Block 已退役（#275/#281）：节点不接受 region 键——分组由读侧按轴派生，零落盘',
  block: 'Region/Block 已退役（#275/#281）：节点不接受 block 键——分组由读侧按轴派生，零落盘',
}

export class SchemaError extends Error {}

function fail(path: string, msg: string): never {
  throw new SchemaError(`${path.replace(/[/\\]/g, '/').split('/').pop()}: ${msg}`)
}

/** enc 列表解析（图 YAML / 提案 / 覆盖层条目共用：字符串=权重 1，映射带可选 w/note）。 */
export function parseEnc(raw: unknown, path: string, where: string, name: string): EncEdge[] {
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

/** 概念名→档位映射的共用读取（teaches/assumes 同构：键=非空概念名、值=中文档枚举）。 */
function readTierMap(
  raw: unknown, path: string, where: string, name: string, field: string,
): Record<string, ConceptTier> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(path, `${where}[${name}] ${field} 必须是映射（概念名 → 档位）`)
  }
  const tiers: Record<string, ConceptTier> = {}
  for (const [concept, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof concept !== 'string' || !concept.trim()) fail(path, `${where}[${name}] ${field} 概念名不能为空`)
    if (!(CONCEPT_TIERS as readonly string[]).includes(String(tier))) {
      fail(path, `${where}[${name}] ${field}[${concept}] 档位非法 ${JSON.stringify(String(tier))}（允许 ${CONCEPT_TIERS.join('/')}）`)
    }
    tiers[concept.trim()] = tier as ConceptTier
  }
  return tiers
}

/** 概念字段组解析（schema v2 #127 §1/§7）：teaches/assumes 为概念名→档位映射，
 * misconceptions 为 {concept, model} 列表。尺寸带：teaches 在场 1–8（1–2 条 WARN 窄节点
 * 提示）、assumes 缺席合法在场 3–10（1–2 条 WARN）、越界 ERROR；误解每概念封顶 3 条。
 * 抛 SchemaError=拒收；WARN 不阻，写入调用方给的 warns 槽（持久图加载时不收集）。 */
export function parseConceptFields(
  r: Record<string, unknown>, path: string, where: string, name: string, warns?: string[],
): { teaches?: Record<string, ConceptTier>; assumes?: Record<string, ConceptTier>; misconceptions?: Misconception[] } {
  const out: { teaches?: Record<string, ConceptTier>; assumes?: Record<string, ConceptTier>; misconceptions?: Misconception[] } = {}
  if (r.teaches !== undefined) {
    const tiers = readTierMap(r.teaches, path, where, name, 'teaches')
    const n = Object.keys(tiers).length
    if (n > 8) fail(path, `${where}[${name}] teaches 有 ${n} 条（上限 8）——概念密度过高，拆节点或收敛到本节点真正教的`)
    if (n >= 1 && n <= 2) warns?.push(`${where}[${name}] teaches 仅 ${n} 条（窄节点提示：中继/旁支/巩固的窄节点是常态，非错误）`)
    out.teaches = tiers
  }
  if (r.assumes !== undefined) {
    const tiers = readTierMap(r.assumes, path, where, name, 'assumes')
    const n = Object.keys(tiers).length
    if (n > 10) fail(path, `${where}[${name}] assumes 有 ${n} 条（上限 10）——前置面过宽，节点切入面太大`)
    if (n >= 1 && n <= 2) warns?.push(`${where}[${name}] assumes 仅 ${n} 条（提示：常规节点假设 3–10 条前置概念；1–2 条常见于入口/窄节点，非错误）`)
    out.assumes = tiers
  }
  if (r.misconceptions !== undefined) {
    if (!Array.isArray(r.misconceptions)) fail(path, `${where}[${name}] misconceptions 必须是列表`)
    const items: Misconception[] = []
    for (const raw of r.misconceptions) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        fail(path, `${where}[${name}] misconceptions 条目必须是映射（{concept, model}）`)
      }
      const m = raw as Record<string, unknown>
      const unknown = Object.keys(m).filter(k => !['concept', 'model'].includes(k))
      if (unknown.length) {
        fail(path, `${where}[${name}] misconceptions 条目含未知字段 ${JSON.stringify(unknown)}（判据签名不设机器字段，典型错答写进 model 文字；只允许 concept/model）`)
      }
      if (typeof m.concept !== 'string' || !m.concept.trim()) fail(path, `${where}[${name}] misconceptions 条目缺 concept（登记表在册概念名）`)
      if (typeof m.model !== 'string' || !m.model.trim()) fail(path, `${where}[${name}] misconceptions[${m.concept}] 缺 model（错误模型文字：典型错答、坑位用途）`)
      items.push({ concept: m.concept.trim(), model: m.model })
    }
    const byConcept = new Map<string, number>()
    for (const m of items) byConcept.set(m.concept, (byConcept.get(m.concept) ?? 0) + 1)
    for (const [concept, n] of byConcept) {
      if (n > 3) fail(path, `${where}[${name}] misconceptions[${concept}] 有 ${n} 条（同一概念全课程封顶 3 条）`)
    }
    out.misconceptions = items
  }
  return out
}

/** 持久图与提案共用的节点 schema 解析：受理门在受理前收集同一套错误。
 * warns 槽可选：受理门传入以收集概念字段组的非阻提示（窄节点等），持久图加载省略。 */
export function parseNode(raw: unknown, path: string, where: string, warns?: string[]): GNode {
  if (typeof raw !== 'object' || raw === null) fail(path, `${where} 节点必须是映射`)
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter(k => !NODE_KEYS.has(k))
  if (unknown.length) {
    const edgeHints = unknown.map(k => RETIRED_EDGE_KEYS[k]).filter(Boolean)
    const nodeHints = unknown.map(k => RETIRED_NODE_KEYS[k]).filter(Boolean)
    fail(path, `${where} 含未知字段 ${JSON.stringify(unknown)}（只允许 ${[...NODE_KEYS].join('/')}）`
      + (edgeHints.length ? `；${edgeHints.join('；')}` : '')
      + (nodeHints.length ? `；${nodeHints.join('；')}` : ''))
  }
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
  Object.assign(node, parseConceptFields(r, path, where, node.name, warns))
  return node
}

/** 防复活门（ADR-0090 裁决 1）：文档顶层的历史结构键 fail loud 拒收——旧 v3 分区文件
 * 不得静默忽略顶层键过关（节点级的见 RETIRED_NODE_KEYS）。 */
const RETIRED_DOC_KEYS: Record<string, string> = {
  regions: 'Region/Block 已退役（#275/#284）：图是一课程一文件 data/图.yaml（扁平 nodes[]），顶层不接受 regions——旧 v3 分区文件请删除重建',
  blocks: 'Region/Block 已退役（#275/#284）：图是一课程一文件 data/图.yaml（扁平 nodes[]），顶层不接受 blocks——旧 v3 分区文件请删除重建',
  color: 'Region/Block 已退役（#275/#284）：region 着色随分区退役，顶层不接受 color——旧 v3 分区文件请删除重建',
}

/** 解析单文件图 YAML（data/图.yaml，#284 存储塌缩：一课程一文件）为节点列表。 */
export function loadGraphDoc(doc: unknown, path: string): GNode[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) fail(path, '顶层必须是映射（nodes）')
  const d = doc as Record<string, unknown>
  const retired = Object.keys(d).filter(k => RETIRED_DOC_KEYS[k])
  if (retired.length) fail(path, retired.map(k => RETIRED_DOC_KEYS[k]).join('；'))
  if (!Array.isArray(d.nodes)) fail(path, 'nodes 必须是列表')
  return d.nodes.map(nraw => parseNode(nraw, path, '节点'))
}

export class GraphStore {
  constructor(_paths: Paths, private courseRoot: string, private fs: VaultFs) {}

  private get dataDir(): string { return join(this.courseRoot, 'data') }

  /** 单文件图路径（data/图.yaml，#284 存储塌缩）。 */
  graphPath(): string { return join(this.dataDir, '图.yaml') }

  /** 加载单文件图 → 节点列表。 */
  async load(): Promise<GNode[]> {
    const path = this.graphPath()
    if (!this.fs.exists(path)) {
      // 两类缺失分开报（#61 教训：合并成「为空或不存在」把排查带偏）——建课前目录
      // 不存在是正常态（建课提案预览按此分流），目录在但缺 图.yaml 才是真异常
      const missing = !this.fs.exists(this.dataDir)
      throw new SchemaError(missing
        ? `数据目录不存在: ${this.dataDir}`
        : `图文件不存在（应有 data/图.yaml）: ${this.dataDir}`)
    }
    return loadGraphDoc(YAML.parse(await this.fs.readFile(path)), path)
  }

  /** 节点列表 → YAML 文本（节点字段按 name/pre/opt/note/est/type/bloom/difficulty/teaches/
   * assumes/misconceptions/enc 顺序，省空值）。 */
  graphDoc(nodes: GNode[]): Record<string, unknown> {
    return {
      nodes: nodes.map(n => {
        const doc: Record<string, unknown> = { name: n.name }
        if (n.pre.length) doc.pre = [...n.pre]
        if (n.opt) doc.opt = true
        if (n.note) doc.note = n.note
        if (n.est !== undefined) doc.est = n.est
        if (n.type) doc.type = n.type
        if (n.bloom) doc.bloom = n.bloom
        if (n.difficulty !== undefined) doc.difficulty = n.difficulty
        if (n.teaches && Object.keys(n.teaches).length) doc.teaches = { ...n.teaches }
        if (n.assumes && Object.keys(n.assumes).length) doc.assumes = { ...n.assumes }
        if (n.misconceptions?.length) doc.misconceptions = n.misconceptions.map(m => ({ ...m }))
        if (n.enc.length) doc.enc = n.enc.map(e => {
          const edge: Record<string, unknown> = { node: e.node, w: e.w }
          if (e.note) edge.note = e.note
          return edge
        })
        return doc
      }),
    }
  }

  async writeGraphDoc(nodes: GNode[]): Promise<void> {
    await atomicWrite(this.graphPath(), YAML.stringify(this.graphDoc(nodes)), this.fs) // 与 applyEnrich 同一原语（ADR-0046：同一正典一种 durability）
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
  /** name → {概念 → 教学档位}（可选字段；缺席的节点不在表内，schema v2 概念字段组）。 */
  teachesOf: Record<string, Record<string, ConceptTier>> = {}
  /** 概念 → 按图序（names 序）教它的节点列表（构造期与 teachesOf 同一趟折出，#270：
   * 概念反向映射单一出处——消费面读这里，不再各自扫全图折叠）。 */
  taughtByOf: Record<string, string[]> = {}
  /** name → {概念 → 所需档位}（可选字段；缺席的节点不在表内）。 */
  assumesOf: Record<string, Record<string, ConceptTier>> = {}
  /** 概念 → 按图序假设它的节点列表（构造期与 assumesOf 同一趟折出，#270）。 */
  assumedByOf: Record<string, string[]> = {}
  /** name → 误解先验列表（可选字段；缺席的节点不在表内）。 */
  misconceptionsOf: Record<string, Misconception[]> = {}
  encOf: Record<string, [string, number][]> = {}
  count: Record<string, number> = {}
  succ: Record<string, string[]> = {}
  pred: Record<string, string[]> = {}
  nset = new Set<string>()
  order: string[] = []
  hasCycle = false
  cycleNodes: string[] = []
  /** 拓扑深度（根=0 向下递增）。**环上作废**：保持空表，`hasCycle` 是显式作废旗标——
   * 消费面不得把「算不出」渲染成「没有/0」（#270 作废署名，ADR-0085 §环语义裁定）。 */
  depth: Record<string, number> = {}
  /** 后代可达集（succ 方向；不含自身，除非自环）。**全图可算**（环上也真——ADR-0085
   * §环语义裁定 #270：isAncestor 与 upstreamClosure 同口径，环上祖先判定「算得出真可达」）；
   * 环图构造退化为逐点 BFS（异常态且规模小，成本可接受）。 */
  reach: Record<string, Set<string>> = {}
  leaves: string[] = []
  roots: string[] = []
  /** 渲染用边 = 传递约简后的边（[u, v] 升序）。**环上作废**（空数组 + hasCycle 旗标，
   * #270 作废署名：空 ≠ 真的没有边）。 */
  edges: [string, string][] = []
  components: string[][] = []

  constructor(readonly nodes: GNode[]) {
    for (const n of this.nodes) {
      const name = n.name
      this.names.push(name)
      this.count[name] = (this.count[name] ?? 0) + 1
      this.preOf[name] = [...n.pre]
      this.encOf[name] = n.enc.map(e => [e.node, e.w])
      if (n.opt) this.opt.add(name)
      if (n.note) this.noteOf[name] = n.note
      if (n.est !== undefined) this.estOf[name] = n.est
      if (n.type) this.typeOf[name] = n.type
      if (n.bloom) this.bloomOf[name] = n.bloom
      if (n.difficulty !== undefined) this.difficultyOf[name] = n.difficulty
      if (n.teaches && Object.keys(n.teaches).length) {
        this.teachesOf[name] = n.teaches
        // 反向映射与正向同一趟折出（#270）：本趟遍历序 = names 序，故 taughtByOf[c]
        // 的节点序与「names 序扫折叠」逐字一致。
        for (const c of Object.keys(n.teaches)) (this.taughtByOf[c] ??= []).push(name)
      }
      if (n.assumes && Object.keys(n.assumes).length) {
        this.assumesOf[name] = n.assumes
        for (const c of Object.keys(n.assumes)) (this.assumedByOf[c] ??= []).push(name)
      }
      if (n.misconceptions?.length) this.misconceptionsOf[name] = n.misconceptions
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
    } else {
      // 环语义裁定（ADR-0085 §环语义裁定 #270，选项 a）：环上 reach 也算得出真可达——
      // isAncestor 与 upstreamClosure 同口径，不得各自为政。作废的只有拓扑序类读数
      // （depth/edges，hasCycle 为显式旗标）。
      for (const u of this.names) {
        const s = new Set<string>()
        const seen = new Set<string>([u])
        const queue = [u]
        while (queue.length) {
          for (const v of this.succ[queue.shift()!]) {
            s.add(v)
            if (!seen.has(v)) { seen.add(v); queue.push(v) }
          }
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

  /** a 是否为 n 的祖先（pre 传递闭包内，不含自身）。环上也成立（reach 全图可算——
   * ADR-0085 §环语义裁定 #270：与 upstreamClosure 同口径）。单点判定是合法用法；
   * names 全扫求祖先集必须走 upstreamClosure（G10 门拦截手写副本）。 */
  isAncestor(a: string, n: string): boolean {
    return a !== n && (this.reach[a]?.has(n) ?? false)
  }

  /** 前置传递闭包（沿 preOf BFS；**含自身**，调用方自行剔除）。悬空 pre 显式容忍：
   * 断边名不入闭包不炸（structureCheck / audit E2 负责报告，派生读数只认图内节点；
   * 悬空名入参退化为 {自身}）。单一出处（#270）：上游图摘要、graph_node 的
   * prereq_closure、终点闭包（seed.closureOf）、概念清单祖先段（content.conceptScopeOf）
   * 共用——手写 BFS 副本曾让「同一个闭包」有多个实现（环/无环口径分叉），就地重写
   * 由 G10 门拦截。 */
  upstreamClosure(n: string): Set<string> {
    const seen = new Set<string>([n])
    const queue = [n]
    while (queue.length) {
      const u = queue.shift()!
      for (const p of this.preOf[u] ?? []) {
        if (this.nset.has(p) && !seen.has(p)) { seen.add(p); queue.push(p) }
      }
    }
    return seen
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

// ---- 读侧分组轴（#278 / Epic #275：分组 = 读侧派生 + 可重叠，零落盘随图重算） ----

export type GroupAxis = 'depth' | 'concept' | 'endpoint'

export interface GroupViewOpts {
  /** 概念登记表条目（concept 轴用）：别名经 resolveConcept 归并到 canonical，防一个概念裂成多组。 */
  conceptEntries?: ConceptEntry[]
  /** 终点名列表（endpoint 轴用，如 state/终点锚.json 的锚集合）：悬空锚不入算。 */
  endpoints?: string[]
}

/** 同一份节点按派生轴切组：`{ label, nodes[] }[]`。纯读侧 fold、零落盘；
 * depth = 单归属（每节点恰一组）；concept / endpoint = 可重叠（每节点可进多组）。
 * 环上 depth 显式作废（照 #270 作废署名纪律：空 ≠ 没有）——返回「无法分层」态而非空数组。 */
export function groupView(
  graph: Graph, axis: GroupAxis, opts: GroupViewOpts = {},
): { label: string; nodes: string[] }[] {
  // 轴校验单一出处（#283 review）：未知轴会静默落到 endpoint 分支，全部入口 fail loud
  if (!['depth', 'concept', 'endpoint'].includes(axis)) {
    throw new Error(`非法分组轴「${String(axis)}」（允许 depth/concept/endpoint）`)
  }
  if (axis === 'depth') {
    if (graph.hasCycle) {
      // 显式「无法分层」态：环上 depth 已作废（hasCycle 是旗标），不静默给空/退化桶
      return [{ label: '图有环——无法分层', nodes: graph.cycleNodes }]
    }
    const byDepth = new Map<number, string[]>()
    for (const n of graph.names) {
      const k = graph.depth[n] ?? 0
      ;(byDepth.get(k) ?? byDepth.set(k, []).get(k)!).push(n)
    }
    return [...byDepth.entries()].sort(([a], [b]) => a - b)
      .map(([k, nodes]) => ({ label: `L${k}`, nodes }))
  }
  if (axis === 'concept') {
    const canonicalOf = (raw: string): string => resolveConcept(opts.conceptEntries ?? [], raw)?.canonical ?? raw
    const groups = new Map<string, Set<string>>()
    for (const raw of new Set([...Object.keys(graph.taughtByOf), ...Object.keys(graph.assumedByOf)])) {
      const label = canonicalOf(raw)
      const members = groups.get(label) ?? groups.set(label, new Set()).get(label)!
      for (const n of graph.taughtByOf[raw] ?? []) members.add(n)
      for (const n of graph.assumedByOf[raw] ?? []) members.add(n)
    }
    const covered = new Set([...groups.values()].flatMap(s => [...s]))
    // 未标概念的节点显式缺席（不是静默丢失）：追加一组让「没进任何概念组」可见
    const untagged = graph.names.filter(n => !covered.has(n))
    if (untagged.length) {
      const g = groups.get('未标概念')
      if (g) for (const n of untagged) g.add(n) // 真有概念叫「未标概念」：合并，不顶掉真实组
      else groups.set('未标概念', new Set(untagged))
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([label, members]) => ({ label, nodes: graph.names.filter(n => members.has(n)) }))
  }
  // endpoint：成员 = 终点前置闭包去自身（upstreamClosure 单一出处）；悬空锚不入算；零终点 = 空
  const out: { label: string; nodes: string[] }[] = []
  for (const e of opts.endpoints ?? []) {
    if (!graph.nset.has(e)) continue
    const closure = graph.upstreamClosure(e)
    out.push({ label: e, nodes: graph.names.filter(n => n !== e && closure.has(n)) })
  }
  return out
}

/** 合并结构检查：重名 / 断边 / 环 → 错误列表（空 = 通过）。 */
export function structureCheck(existing: Graph | null, newNodes: GNode[], label: string): string[] {
  const errors: string[] = []
  const mergedNames = existing ? [...existing.names] : []
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
    const merged = new Graph([...(existing?.nodes ?? []), ...newNodes])
    if (merged.hasCycle) errors.push(`${label}引入环：涉及 ${merged.cycleNodes.slice(0, 5).join('、')}`)
  }
  return errors
}

/** 误解封顶的跨节点计数（#127 §1.3/§7）：同一概念全课程（合并视图）封顶 3 条，
 * 越界 ERROR。受理门在模拟合并后的图上跑——提案新增与存量一起计数，存量已越界时
 * 下一笔提案同样被拒（拒收信息可执行：列出概念与现计数）。 */
export function misconceptionCapErrors(nodes: GNode[]): string[] {
  const count = new Map<string, number>()
  for (const n of nodes) {
    for (const m of n.misconceptions ?? []) count.set(m.concept, (count.get(m.concept) ?? 0) + 1)
  }
  return [...count.entries()].filter(([, n]) => n > 3)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([concept, n]) => `误解封顶越界: 概念「${concept}」全课程已有 ${n} 条误解（同一概念封顶 3 条）——新增前先收敛（并入既有条目文字或换节点承载）`)
}

/** 整图快照文档（data/图.yaml 的文档 JSON 化，save_snapshot 同构）。 */
export function snapshotDoc(store: GraphStore, nodes: GNode[]): unknown {
  return store.graphDoc(nodes)
}

/** 既有声明 enc 原始形态表（节点名 → 边数组）。图视图的 encOf 会丢 note——
 * enc 回填与行为推断提案要「整体替换且既有声明原样保留」，必须走这里。 */
export function declaredEncOf(graph: Graph): Map<string, EncEdge[]> {
  return new Map(graph.nodes.map(n => [n.name, n.enc]))
}

/** 就绪清单构建（build 产物：列未学条目）。#284 存储塌缩后无区/块可分组，改平铺清单。 */
export async function writeReadyList(paths: Paths, root: string, graph: Graph, done: Set<string>, fs: VaultFs): Promise<void> {
  const lines: string[] = ['# 就绪清单', '', '> 引擎自动生成：当前就绪（前置达标）的未学节点。', '']
  for (const n of graph.readySet(done, new Set())) lines.push(`- ${n}`)
  await atomicWrite(paths.readyPath(root), lines.join('\n'), fs)
}

export { safeFilename }
