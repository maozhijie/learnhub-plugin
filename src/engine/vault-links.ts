/**
 * Vault 链接先验（V-2 / #91）：扫描全库个人笔记的 [[wikilink]]，产出去噪后的
 * 无向关联对（w ∈ [0,1]，复用 enc 边权重约定）缓存到 state/vault链接.json，
 * 供 graph_analyze 的 suggestions 自由段 vault_link_candidates 展示与
 * graph_link_backfill 单提案人审回填（enc_backfill 先例）。
 *
 * 管线五段（调研 docs/research/2026-09-vault-link-graph-prior.md §4）：
 * 扫描排除区 → 单正则解析（alias/锚点/嵌入）→ 噪声过滤（带命中率审计——
 * ADR-0004 不静默：每条规则各拦多少随报告带出）→ basename 索引解析 →
 * 置信度打分。方向语义诚实：wikilink 是联想不是依赖，只出**无向对**；
 * pre/enc 归类与方向由人审裁决（backfill 只在 pre 闭包内成 enc 边，
 * 其余降级为 blocked_no_pre 信号）。
 *
 * v1 打分与映射口径（调研 §4.4/§5 降级格的收窄子集，升级项显式留白）：
 * 置信度 = 次数 + 独立源文件 + 双向加成（源区类型权重留待宿主升级——目录
 * 分区高度个人化，硬编码反成噪声）；节点映射 = 归一化精确匹配（别名表与
 * 包含关系随宿主嵌入能力一并升级——短 CJK 名的包含匹配假边率不可接受）。
 * alias 解析后留显示（§4.2），不参与匹配。
 *
 * ADR-0010 只读纪律：个人笔记零写入——产物只落引擎 state 区；缓存带源文件
 * 指纹（与笔记源指纹同法），漂移可见、可重扫。纯文件扫描，不依赖宿主检索 API。
 */
import { readdir, readFile } from 'node:fs/promises'
import { fingerprintOf, stripFrontmatter } from './note-source.ts'

/** 一条候选关联对（无向：a/b 为字典序较小的路径在前）。 */
export interface VaultLinkEdge {
  a: string
  b: string
  /** 链接出现次数（跨全部扫描文件）。 */
  count: number
  /** 独立源文件数（跨文件重复比单文件重复信号强）。 */
  files: number
  /** 贡献源文件（去重截断，明细供人审溯源）。 */
  sources: string[]
  /** 目标方向也存在反向链接（双向互链加成）。 */
  bidirectional: boolean
  /** 置信度 ∈ [0,1]（linkScore；分层：≥0.7 进提案、0.4–0.7 进 analyze 待裁决、<0.4 只落报告）。 */
  w: number
}

/** 扫描缓存文档（state/vault链接.json）。 */
export interface VaultLinksDoc {
  version: 1
  generated_at: string
  scanned_files: number
  /** 文件数达上限被截断（maxFiles）——ADR-0004：截断必须显式可见，不静默。 */
  truncated: boolean
  /** 全部 wikilink 命中数（含被过滤的——审计分母）。 */
  links_seen: number
  edges: VaultLinkEdge[]
  /** 解析不到扫描索引内现存文件的链接数（供人补笔记/改名参考）。 */
  unresolved: number
  /** 命中率审计：各过滤规则各拦多少（防静默误杀/漏杀）。 */
  audit: {
    embed: number
    non_md: number
    date_target: number
    self_link: number
    ambiguous_basenames: number
  }
  /** 源文件指纹（路径 → sha256 前 16 位）：缓存新鲜度与漂移重扫依据。 */
  fingerprints: Record<string, string>
}

/** 内置目录排除（vault 任意层级的目录段名；`过时*` 为段前缀模式）。
 * learnhub.json 的 vault_link_excludes 给出列表时**整体替换**本清单；
 * 学习中心/点目录/用户 note_source_excludes 永远生效，不受替换影响。 */
export const VAULT_LINK_DEFAULT_DIR_EXCLUDES = ['99附件', '05ob自定义', '00类型', '03属性', '过时*']

/** 读扫描目录排除配置（缺省/形状不符回落内置清单——同 learnhub.json 配置口径：
 * 容错的是配置笔误，不是学习者数据）。 */
export async function readVaultLinkDirExcludes(configPath: string): Promise<string[]> {
  try {
    const doc = JSON.parse(await readFile(configPath, 'utf8')) as { vault_link_excludes?: unknown }
    if (!Array.isArray(doc.vault_link_excludes)) return VAULT_LINK_DEFAULT_DIR_EXCLUDES
    const list = doc.vault_link_excludes
      .filter((e): e is string => typeof e === 'string' && !!e.trim())
      .map(e => e.replace(/\\/g, '/').replace(/\/+$/, '').trim())
      .filter(e => !!e)
    return list.length ? list : VAULT_LINK_DEFAULT_DIR_EXCLUDES
  } catch {
    return VAULT_LINK_DEFAULT_DIR_EXCLUDES
  }
}

/** 目录段排除命中：`x*` = 段前缀；其余 = 段全等。 */
export function dirExcluded(rel: string, dirExcludes: string[]): boolean {
  return rel.split('/').some(seg => dirExcludes.some(pat =>
    pat.endsWith('*') ? seg.startsWith(pat.slice(0, -1)) : seg === pat))
}

// ---- 纯函数缝：wikilink 解析与噪声过滤 ----

/** 单一正则覆盖实测全部形态：`(!?)[[target(#anchor)?(|alias)?]]`。
 * 嵌入 ![[...]] 是附件引用不是知识边；锚点弃（目标剥 # 后段）；alias 留显示不参与解析。 */
const WIKILINK_RE = /(!?)\[\[([^\[\]#|]+)(#[^\[\]|]+)?(\|[^\[\]]*)?\]\]/g

export interface ParsedWikilink {
  embed: boolean
  /** 归一后的目标名：trim、剥尾 .md、折叠空白（不含锚点段）。 */
  target: string
  alias?: string
}

/** 剥代码围栏（``` 围栏块）：教程笔记里贴的 `[[示例]]` 文档代码不进先验。 */
export function stripCodeFences(body: string): string {
  return body.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
}

/** 正文 → wikilink 列表（target 已归一；解析不了的空目标跳过）。 */
export function parseWikilinks(body: string): ParsedWikilink[] {
  const out: ParsedWikilink[] = []
  const clean = stripCodeFences(body)
  for (const m of clean.matchAll(WIKILINK_RE)) {
    const target = (m[2] ?? '').replace(/\.md$/i, '').replace(/\s+/g, ' ').trim()
    if (!target) continue
    const alias = m[4]?.slice(1).trim()
    out.push({ embed: m[1] === '!', target, ...(alias ? { alias } : {}) })
  }
  return out
}

/** 日期目标（日记导航链接）：`2026-04-28 …` 型。 */
export function isDateTarget(target: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(target)
}

/** 已知非 md 资产扩展名（实测 .base/.canvas/图片/音视频等——Obsidian 里资产链接
 * 永远带扩展名）。白名单制而非「见点就当扩展名」：`[[Node.js 入门]]` 这类含点
 * 标题是正经常的笔记名，不能静默滤进 non_md 桶。 */
const ASSET_EXTENSIONS = new Set([
  'base', 'canvas', 'excalidraw', 'drawio',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic',
  'pdf', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
])

/** 非知识资产目标：basename 扩展名命中资产白名单（大小写不敏感）。 */
export function isNonMdTarget(target: string): boolean {
  const base = target.split('/').pop() ?? target
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return ASSET_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

/** 名字归一（节点映射用）：NFKC 折叠全半角、去空白、小写——「入门 Node」与
 * 「入门node」互认；映射只用归一化精确匹配（模糊/嵌入相似度是宿主升级项）。 */
export function normalizeLinkName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** 路径 → 链接名（basename 剥 .md——Obsidian 缺省按 basename 解析链接）。 */
export function linkNameOfPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

/** basename 索引：归一名 → 扫描内路径。同名撞车取最短路径（Obsidian 缺省解析规则），
 * 撞车数记入审计（ambiguous_basenames）。 */
export function buildNameIndex(paths: string[]): { index: Map<string, string>; ambiguous: number } {
  const byName = new Map<string, string[]>()
  for (const p of paths) {
    const key = normalizeLinkName(linkNameOfPath(p))
    const list = byName.get(key)
    if (list) list.push(p)
    else byName.set(key, [p])
  }
  const index = new Map<string, string>()
  let ambiguous = 0
  for (const [key, list] of byName) {
    if (list.length > 1) {
      ambiguous++
      index.set(key, [...list].sort((x, y) => x.length - y.length || x.localeCompare(y))[0]!)
    } else {
      index.set(key, list[0]!)
    }
  }
  return { index, ambiguous }
}

// ---- 纯函数缝：置信度打分 ----

/** 置信度 w ∈ [0,1]（可解释加法模型，封顶 1）：
 * - 出现次数：min(count,5)/5 × 0.5（5 次饱和）；
 * - 独立源文件：min(files,3)/3 × 0.3（3 个源饱和）；
 * - 双向互链：+0.2。
 * 单文件单次 = 0.2（只落报告）；2 文件各 1 次 = 0.4（进 analyze 待裁决）；
 * 4 文件 4 次 = 0.7（提案门槛）；双向互链可再抬一档。 */
export function linkScore(count: number, files: number, bidirectional: boolean): number {
  const w = Math.min(count, 5) / 5 * 0.5
    + Math.min(files, 3) / 3 * 0.3
    + (bidirectional ? 0.2 : 0)
  return Math.round(Math.min(1, w) * 1000) / 1000
}

/** 分层：≥0.7 进提案；0.4–0.7 进 analyze 建议段待裁决；<0.4 只落扫描报告。 */
export function scoreTier(w: number): 'proposal' | 'review' | 'report' {
  return w >= 0.7 ? 'proposal' : w >= 0.4 ? 'review' : 'report'
}

// ---- 纯函数缝：无向对累积 ----

const PAIR_SEP = '\u0000'
export function edgeKeyOf(a: string, b: string): string {
  return a < b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`
}

// ---- 扫描（模块内唯一 IO；调用方负责缓存落盘）----

export interface VaultLinkScanOptions {
  vaultRoot: string
  /** 学习中心相对段（整体排除——引擎管理区不是先验来源）。 */
  centerRel: string
  /** 目录段排除（内置清单或 learnhub.json vault_link_excludes 替换后的清单）。 */
  dirExcludes: string[]
  /** 用户排除清单（注册排除同源；路径前缀语义，永远生效）。 */
  pathExcludes: string[]
  /** 最多扫描文件数（超大 vault 防护；触顶即显式标记 truncated，不静默截断）。 */
  maxFiles?: number
}

/** 全库 wikilink 扫描：vault 根下全部 .md（学习中心、点目录、目录排除、用户排除除外）
 * → 解析 → 过滤 → 无向对累积。只读——不写任何文件。 */
export async function scanVaultLinks(opts: VaultLinkScanOptions): Promise<VaultLinksDoc> {
  const maxFiles = opts.maxFiles ?? 5000
  const centerPrefix = `${opts.vaultRoot}/${opts.centerRel}`
  const isPathExcluded = (rel: string) =>
    opts.pathExcludes.some(e => rel === e || rel.startsWith(`${e}/`))
  const files: Array<{ abs: string; rel: string }> = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录不可读：跳过（与 vault-prior 同口径，扫描是尽力而为的增益）
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) return
      const child = `${dir}/${ent.name}`
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue
        if (child === centerPrefix || child.startsWith(`${centerPrefix}/`)) continue
        const rel = child.slice(opts.vaultRoot.length + 1)
        if (dirExcluded(rel, opts.dirExcludes) || isPathExcluded(rel)) continue
        await walk(child)
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        const rel = child.slice(opts.vaultRoot.length + 1)
        if (isPathExcluded(rel)) continue
        files.push({ abs: child, rel })
      }
    }
  }
  await walk(opts.vaultRoot)

  const doc: VaultLinksDoc = {
    version: 1,
    generated_at: new Date().toISOString(),
    scanned_files: files.length,
    truncated: files.length >= maxFiles,
    links_seen: 0,
    edges: [],
    unresolved: 0,
    audit: { embed: 0, non_md: 0, date_target: 0, self_link: 0, ambiguous_basenames: 0 },
    fingerprints: {},
  }

  interface Acc { count: number; sources: Set<string> }
  const acc = new Map<string, Acc>()
  /** 有序出现（源→目标）：无向对累积会折叠方向，双向互链判定靠它。 */
  const directed = new Set<string>()
  const { index, ambiguous } = buildNameIndex(files.map(f => f.rel))
  doc.audit.ambiguous_basenames = ambiguous

  for (const f of files) {
    let raw: string
    try {
      raw = await readFile(f.abs, 'utf8')
    } catch {
      continue // 不可读：跳过并保持指纹缺席（缓存可见该文件未被纳入本轮边累积）
    }
    doc.fingerprints[f.rel] = fingerprintOf(raw)
    const body = stripFrontmatter(raw)
    const links = parseWikilinks(body)
    doc.links_seen += links.length
    for (const link of links) {
      if (link.embed) { doc.audit.embed++; continue }
      if (isNonMdTarget(link.target)) { doc.audit.non_md++; continue }
      if (isDateTarget(link.target)) { doc.audit.date_target++; continue }
      const targetRel = index.get(normalizeLinkName(link.target))
      if (!targetRel) { doc.unresolved++; continue }
      if (targetRel === f.rel) { doc.audit.self_link++; continue }
      directed.add(`${f.rel}${PAIR_SEP}${targetRel}`)
      const key = edgeKeyOf(f.rel, targetRel)
      const cur = acc.get(key)
      if (cur) {
        cur.count++
        cur.sources.add(f.rel)
      } else {
        acc.set(key, { count: 1, sources: new Set([f.rel]) })
      }
    }
  }

  doc.edges = [...acc.entries()].map(([key, v]) => {
    const [a, b] = key.split(PAIR_SEP)
    return {
      a: a!, b: b!, count: v.count, files: v.sources.size,
      sources: [...v.sources].sort().slice(0, 5),
      bidirectional: false, w: 0,
    }
  })
  // 双向判定：两个方向都真实出现过（A→B 与 B→A 各至少一条链接）
  for (const e of doc.edges) {
    e.bidirectional = directed.has(`${e.a}${PAIR_SEP}${e.b}`) && directed.has(`${e.b}${PAIR_SEP}${e.a}`)
    e.w = linkScore(e.count, e.files, e.bidirectional)
  }
  doc.edges.sort((x, y) => y.w - x.w || y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  return doc
}

// ---- 纯函数缝：候选边 → 图节点映射（analyze 展示与 backfill 提案共用）----

/** analyze suggestions.vault_link_candidates 段的条目视图（映射成图节点名 + 行动指引）。 */
export interface VaultLinkCandidateView {
  /** 图节点名。 */
  a: string
  b: string
  /** 来源笔记的 vault 相对路径。 */
  a_note: string
  b_note: string
  w: number
  count: number
  files: number
  bidirectional: boolean
  /** proposal = 走 learnhub_graph_link_backfill 单提案人审；review = 人工逐条裁决。 */
  tier: 'proposal' | 'review'
  suggestion: string
}

/** 一条映射到具体图节点的候选边。 */
export interface MappedLinkEdge {
  edge: VaultLinkEdge
  aNode: string
  bNode: string
}

/** 候选边映射到课程图节点：两端都精确命中（归一化）且不是同一节点才成对；
 * 跨课程/未映射对留在扫描报告里（analyze 是按课程的视图）。 */
export function mapEdgesToNodes(edges: VaultLinkEdge[], nodeNames: string[]): MappedLinkEdge[] {
  const byName = new Map<string, string>()
  for (const n of nodeNames) {
    const key = normalizeLinkName(n)
    if (!byName.has(key)) byName.set(key, n)
  }
  const out: MappedLinkEdge[] = []
  for (const edge of edges) {
    const aNode = byName.get(normalizeLinkName(linkNameOfPath(edge.a)))
    const bNode = byName.get(normalizeLinkName(linkNameOfPath(edge.b)))
    if (!aNode || !bNode || aNode === bNode) continue
    out.push({ edge, aNode, bNode })
  }
  return out
}

// ---- 纯函数缝：方向裁决（链接上下文的诚实文案）----

/** enc 边方向：skill 挂在 holder 上（CONTEXT Enc 契约 / 审计 E7：enc 目标必须在
 * holder 的 pre 传递闭包内）。两向都无 pre 关系时没有可落的边——降级为 blocked
 * 信号，绝不硬提（误加 pre 会锁学习路径，方向交人审裁决）。 */
export function orientLinkPair(
  a: string, b: string,
  isAncestor: (from: string, to: string) => boolean,
): { ok: true; skill: string; holder: string } | { ok: false; why: string } {
  if (isAncestor(a, b)) return { ok: true, skill: a, holder: b }
  if (isAncestor(b, a)) return { ok: true, skill: b, holder: a }
  return { ok: false, why: '两节点无 pre 关系（enc 契约/E7 要求闭包内）——先补 pre 边或放弃；链接先验只提示关联，不代裁决' }
}
