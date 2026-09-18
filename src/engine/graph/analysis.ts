/**
 * 图分析（吸收自 Python analysis.py 的核心口径；networkx → Graph 派生结构直算）。
 * 输出：结构统计、不可达节点、瓶颈（高扇出枢纽）、逾期热点（journal 驱动）、
 * cytoscape 渲染元素（面板 DAG 视图消费）。
 */
import type { Graph } from './graph.ts'
import type { Fm, Stage } from '../types.ts'
import type { Store } from '../store.ts'
import type { ConceptEntry } from '../concepts/concepts.ts'
import { resolveConcept } from '../concepts/concepts.ts'
import { effectiveStage } from './audit.ts'
import { graphHealthScore, estSpreadNote, widthNote } from './health.ts'
import { jumpCandidates } from './quality.ts'
import type { JumpCandidate } from './quality.ts'
import { parseDay, daysBetween } from '../infra/dates.ts'
import { masteryOfFm } from '../sched/srs.ts'
import { hasReadyContent } from '../vault/notes.ts'
import type { VaultLinkCandidateView } from '../vault/vault-links.ts'

/** analyze 进来的 Vault 链接先验段（engine 侧从 state/vault链接.json 映射，analysis 保持无 IO）。 */
export interface VaultLinkPrior {
  scanned_at: string | null
  /** 映射到本课程图的候选总数（截断前）。 */
  mapped_total: number
  candidates: VaultLinkCandidateView[]
}

/** concept_growth 表的供料（#281）：analysis 保持无 IO——概念登记表、题目 invokes 折叠、
 * 卡点自报节点计数由调用方（GraphSubsystem.graphAnalyze）折好后传入。 */
export interface ConceptGrowthInput {
  /** 概念登记表条目：别名经 resolveConcept 归并到 canonical，防一个概念裂成多行。 */
  conceptEntries: ConceptEntry[]
  /** canonical 概念 → 节点 → 在库现役题数（growth-subsystem 同源口径，排除归档题）。 */
  conceptInvokes: Map<string, Map<string, number>>
  /** 节点 → 卡点自报条数（stuck 流水折出计数；原文永不进图分析——#248 纪律）。 */
  stuckByNode: Map<string, number>
}

export interface GraphAnalysis {
  stats: {
    nodes: number
    edges: number
    enc_edges: number
    roots: number
    leaves: number
    /** 环上作废为 null（#270 作废署名）：0 会伪装成「全部根级」。 */
    max_depth: number | null
    components: number
    has_cycle: boolean
  }
  /** 环上作废为 null（#270 作废署名）：[] 会伪装成「全部可达」。 */
  unreachable: string[] | null
  bottlenecks: Array<{ node: string; successors: number; unlocks: number }>
  lapse_hotspots: Array<{ node: string; lapses: number }>
  /** 图谱健康分（0-100；结束条件锚点，公式与语义见 health.ts）。
   * est_note：est 分布压缩的 advisor 提示（null = 无；不改分，est 重标注属图生成专题）。 */
  health: { score: number; breakdown: Record<string, number>; est_note: string | null; topology_void?: string[] }
  /** 分批构建建议（图谱 designer 逐批展开时规划下一批的输入，全部可行动）。
   * concept_growth（#281，grill 定稿 2026-09-15）：失衡排序表——零机械阈值，排序
   * 暴露相对严重度，判读归教练。悬空依赖（supply 空）恒在最前；其余按行为证据
   * （stuck+skipped 降序）→ 结构失衡度（demand−supply）降序。 */
  suggestions: {
    concept_growth: Array<{
      concept: string
      supply: string[]
      demand: { assumed: number; invoked: number; endpoints: string[] }
      depth_spread: Record<string, number>
      evidence: { skipped: number; stuck: number }
    }>
    /** 空降节点（pre 为空，剔终点；种子期豁免）。 */
    missing_pre: string[]
    /** 认知跨步候选（合成口径见 quality.ts）——每条必须 verdict：认可或修。 */
    jump_candidates: JumpCandidate[]
    /** 跨步候选总数（截断前）——结束条件要求清零。 */
    jump_total: number
    /** 种子图豁免（#142）：true = 图仍是种子本身（终点锚种子节点全集）——
     * missing_pre 豁免、健康分不设阈值；生长批进入后翻转 false。自由 JSON 段字段。 */
    seed_phase?: boolean
    /** Vault 链接先验候选（V-2 #91）：个人笔记 wikilink 映射到本课程图的无向关联对
     * （w ≥ 0.4；tier=proposal 的走 learnhub_graph_link_backfill 单提案人审、review 的
     * 逐条人工裁决）。自由 JSON 段——suggestions 非校验 schema，加段零 schema 破坏。 */
    vault_link_candidates: VaultLinkCandidateView[]
  }
  /** Vault 链接扫描元信息：未扫描时 scanned_at=null（带 hint 指路扫描工具）。 */
  vault_links: { scanned_at: string | null; mapped_total: number; hint?: string }
  nodes: Array<{ data: { id: string; depth: number; stage: Stage; opt: boolean; mastery: number; hasContent: boolean; isEndpoint: boolean; type?: string; serves?: string[] } }>
  edges: Array<{ data: { id: string; source: string; target: string; kind: string; w?: number } }>
  /** 节点 schema 全量（pre/enc/est/bloom/difficulty/teaches/assumes/misconceptions/note…）
   * ——编辑规划与边级自查的数据依据；elementsOnly 模式不含。 */
  schema: Record<string, {
    pre: string[]
    enc: Array<{ node: string; w: number }>
    opt: boolean
    est?: number
    type?: string
    bloom?: string
    difficulty?: number
    teaches?: Record<string, string>
    assumes?: Record<string, string>
    misconceptions?: Array<{ concept: string; model: string }>
    note?: string
  }>
}

export async function analyzeGraph(
  courseName: string, graph: Graph, state: Record<string, Fm>, store: Store,
  today: string,
  vaultLinks: VaultLinkPrior = { scanned_at: null, mapped_total: 0, candidates: [] },
  /** 种子图豁免（#142）：图仍 = 终点锚种子节点全集时，Float（missing_pre）建议豁免
   * ——种子本来就只有起点+终点几张节点（facade 按锚判定传入，analysis 保持无 IO）。 */
  seedPhase = false,
  /** 终点节点名集（ADR-0055 读侧单源派生，#200；#239 多终点化）：节点载荷据此标
   * isEndpoint，stats.leaves 与 missing_pre（空降建议）剔终点——终点是方向标记不是课程节点。 */
  endpoints: ReadonlySet<string> = new Set<string>(),
  /** concept_growth 供料（#281，见 ConceptGrowthInput）；缺席 = 空供料（测试/纯结构调用）。 */
  growth?: ConceptGrowthInput,
): Promise<GraphAnalysis> {
  void parseDay(today)

  // 不可达 = 从任一根出发 BFS 达不到的节点。环上作废为 null（#270 作废署名）：
  // 「算不出」≠「没有」——空数组会伪装成全部可达。
  const unreachable: string[] | null = graph.hasCycle ? null : (() => {
    const seen = new Set<string>()
    const queue = graph.roots.slice()
    while (queue.length) {
      const u = queue.shift()!
      if (seen.has(u)) continue
      seen.add(u)
      for (const v of graph.succ[u]) if (!seen.has(v)) queue.push(v)
    }
    return graph.names.filter(n => !seen.has(n)).sort()
  })()

  // 瓶颈：后继数 top（解锁口径 = succ 中未学者数）
  const bottlenecks = graph.names
    .map(n => ({ node: n, successors: graph.succ[n].length, unlocks: graph.succ[n].filter(x => effectiveStage(state, x) === 'unseen' || effectiveStage(state, x) === 'ready').length }))
    .filter(b => b.successors >= 3)
    .sort((a, b) => b.unlocks - a.unlocks || b.successors - a.successors)
    .slice(0, 10)

  // 逾期热点：journal 聚合 lapse/relearn 次数
  const lapses: Record<string, number> = {}
  for (const rec of await store.journalTail(courseName, 500)) {
    if (rec.kind === 'relearn' || (rec.rating === 1)) {
      lapses[rec.node] = (lapses[rec.node] ?? 0) + 1
    }
  }
  const lapseHotspots = Object.entries(lapses)
    .map(([node, n]) => ({ node, lapses: n }))
    .filter(h => h.lapses >= 2)
    .sort((a, b) => b.lapses - a.lapses)
    .slice(0, 10)

  // cytoscape 元素：渲染用边 = 传递约简后的 pre 边 + enc 成分技能边（kind 区分）
  // 节点掌握度 = 派生展示值（稳定度完成度 + 练习 EMA；作答与复习实时反映，不因一次全对饱和）
  // isEndpoint = 读锚现算的终点标记（#200 / ADR-0055：特殊性不存储，恒标全部终点）
  const nodes = graph.names.map(n => {
    const fm = state[n]
    return {
      data: {
        id: n,
        depth: graph.depth[n] ?? 0,
        stage: effectiveStage(state, n),
        opt: graph.opt.has(n),
        mastery: masteryOfFm(fm),
        /** 已生成可读正文（列表/图三态标识：点开有东西读）。 */
        hasContent: hasReadyContent(fm),
        isEndpoint: endpoints.has(n),
        ...(graph.typeOf[n] ? { type: graph.typeOf[n] } : {}),
      },
    }
  })
  const edges = [
    ...graph.edges.map(([u, v]) => ({ data: { id: `${u}->${v}`, source: u, target: v, kind: 'pre' } })),
    ...Object.entries(graph.encOf).flatMap(([u, list]) =>
      list.map(([v, w]) => ({ data: { id: `${u}~enc~${v}`, source: u, target: v, kind: 'enc', w } }))),
  ]

  // 节点 schema 全量：编辑规划/边级自查需要每个节点的字段值（cytoscape data 只带展示字段）
  const schema = Object.fromEntries(graph.names.map(n => [n, {
    pre: graph.preOf[n],
    enc: (graph.encOf[n] ?? []).map(([node, w]) => ({ node, w })),
    opt: graph.opt.has(n),
    ...(graph.estOf[n] !== undefined ? { est: graph.estOf[n] } : {}),
    ...(graph.typeOf[n] ? { type: graph.typeOf[n] } : {}),
    ...(graph.bloomOf[n] ? { bloom: graph.bloomOf[n] } : {}),
    ...(graph.difficultyOf[n] !== undefined ? { difficulty: graph.difficultyOf[n] } : {}),
    ...(graph.teachesOf[n] ? { teaches: graph.teachesOf[n] } : {}),
    ...(graph.assumesOf[n] ? { assumes: graph.assumesOf[n] } : {}),
    ...(graph.misconceptionsOf[n] ? { misconceptions: graph.misconceptionsOf[n].map(m => ({ ...m })) } : {}),
    ...(graph.noteOf[n] ? { note: graph.noteOf[n] } : {}),
  }]))

  // concept_growth 失衡排序表（#281，grill 定稿）：成员 = taughtByOf ∪ assumedByOf（别名
  // 经 resolveConcept 归并到 canonical）；demand = assumes 计数 + 题目 invokes 计数 + 服务
  // 的终点；evidence = skipped 节点数 + stuck 自报条数（只聚合计数，原文不进图分析）。
  // 排序零机械阈值：悬空依赖（supply 空）恒在最前 → 行为证据降序 → 结构失衡度降序。
  const growthInput = growth ?? { conceptEntries: [], conceptInvokes: new Map<string, Map<string, number>>(), stuckByNode: new Map<string, number>() }
  const canonicalOf = (raw: string): string => resolveConcept(growthInput.conceptEntries, raw)?.canonical ?? raw
  const footprint = new Map<string, { supply: Set<string>; assumed: Set<string> }>()
  for (const raw of new Set([...Object.keys(graph.taughtByOf), ...Object.keys(graph.assumedByOf)])) {
    const label = canonicalOf(raw)
    const slot = footprint.get(label) ?? footprint.set(label, { supply: new Set(), assumed: new Set() }).get(label)!
    for (const n of graph.taughtByOf[raw] ?? []) slot.supply.add(n)
    for (const n of graph.assumedByOf[raw] ?? []) slot.assumed.add(n)
  }
  for (const c of growthInput.conceptEntries) {
    if (!footprint.has(c.canonical)) footprint.set(c.canonical, { supply: new Set(), assumed: new Set() })
  }
  // 终点前置闭包预折（demand.endpoints：成员落在哪个终点闭包内 = 该概念服务哪个终点）
  const endpointClosures = [...endpoints].filter(e => graph.nset.has(e))
    .map(e => ({ e, closure: graph.upstreamClosure(e) }))
  const conceptGrowth = [...footprint.entries()].map(([concept, fp]) => {
    const members = new Set([...fp.supply, ...fp.assumed])
    const invoked = growthInput.conceptInvokes.get(concept)
    const invokedTotal = invoked ? [...invoked.values()].reduce((s, v) => s + v, 0) : 0
    const depthSpread: Record<string, number> = {}
    for (const n of members) {
      const k = `L${graph.depth[n] ?? 0}`
      depthSpread[k] = (depthSpread[k] ?? 0) + 1
    }
    let skipped = 0
    let stuck = 0
    for (const n of members) {
      if (effectiveStage(state, n) === 'skipped') skipped++
      stuck += growthInput.stuckByNode.get(n) ?? 0
    }
    return {
      concept,
      supply: graph.names.filter(n => fp.supply.has(n)),
      demand: {
        assumed: fp.assumed.size,
        invoked: invokedTotal,
        endpoints: endpointClosures.filter(({ closure }) => [...members].some(n => closure.has(n))).map(({ e }) => e),
      },
      depth_spread: depthSpread,
      evidence: { skipped, stuck },
    }
  })
  // 「未标概念」兑底组显式在列（不静默缺席）但不构成失衡信号——恒排在表尾；
  // 真有概念叫「未标概念」时合并进那一行（同 groupView 的「合并不顶替」纪律）
  const covered = new Set([...footprint.values()].flatMap(fp => [...fp.supply, ...fp.assumed]))
  const untagged = graph.names.filter(n => !covered.has(n))
  const untaggedSpread: Record<string, number> = {}
  for (const n of untagged) {
    const k = `L${graph.depth[n] ?? 0}`
    untaggedSpread[k] = (untaggedSpread[k] ?? 0) + 1
  }
  const untaggedEvidence = {
    skipped: untagged.filter(n => effectiveStage(state, n) === 'skipped').length,
    stuck: untagged.reduce((s, n) => s + (growthInput.stuckByNode.get(n) ?? 0), 0),
  }
  const existingUntitled = conceptGrowth.find(r => r.concept === '未标概念')
  if (untagged.length && existingUntitled) {
    for (const [k, v] of Object.entries(untaggedSpread)) existingUntitled.depth_spread[k] = (existingUntitled.depth_spread[k] ?? 0) + v
    existingUntitled.evidence.skipped += untaggedEvidence.skipped
    existingUntitled.evidence.stuck += untaggedEvidence.stuck
  } else if (untagged.length) {
    conceptGrowth.push({
      concept: '未标概念',
      supply: [],
      demand: { assumed: 0, invoked: 0, endpoints: [] },
      depth_spread: untaggedSpread,
      evidence: untaggedEvidence,
    })
  }
  const rankedGrowth = [...conceptGrowth]
    .slice(0, conceptGrowth.length - (untagged.length && !existingUntitled ? 1 : 0))
    .sort((a, b) => {
      const dangling = (r: typeof a): number => (r.supply.length === 0 && (r.demand.assumed + r.demand.invoked) > 0) ? 0 : 1
      const evidenceOf = (r: typeof a): number => -(r.evidence.stuck + r.evidence.skipped)
      const imbalanceOf = (r: typeof a): number => -(r.demand.assumed + r.demand.invoked - r.supply.length)
      return dangling(a) - dangling(b) || evidenceOf(a) - evidenceOf(b) || imbalanceOf(a) - imbalanceOf(b) || a.concept.localeCompare(b.concept)
    })
  if (untagged.length && !existingUntitled) rankedGrowth.push(conceptGrowth[conceptGrowth.length - 1]!)
  
  // 空降建议：pre 为空（剔终点 #200：接线待完成不是空降缺陷；种子期豁免 #142）。
  // 「根级豁免」不能用 depth>0 表达——pre 派生深度下无 pre 必为 0（health.ts 同款教训），
  // 那是死条件；根级起点即无 pre 的节点本身，豁免只靠种子期开关。
  const sugCap = Math.min(16, Math.max(8, Math.ceil(graph.names.length / 25)))
  const missingPre = seedPhase ? [] : graph.names
    .filter(n => !endpoints.has(n) && !graph.preOf[n].length)
    .slice(0, sugCap)
  const jumps = jumpCandidates(graph)

  return {
    stats: {
      nodes: graph.names.length,
      edges: graph.edgeCount(),
      enc_edges: Object.values(graph.encOf).reduce((s, v) => s + v.length, 0),
      roots: graph.roots.length,
      // 口径豁免（#200 / ADR-0055）：leaves 剔终点——设计上的收敛点是方向标记，不是缺陷叶子
      leaves: graph.leaves.filter(n => !endpoints.has(n)).length,
      // 主线深度（原 max_depth，正名不改字段名）：终点计入——课程长到哪里的进度读数。
      // 环上作废为 null（#270 作废署名）：depth 空，0 会伪装成「全部根级」。
      max_depth: graph.hasCycle
        ? null
        : Object.keys(graph.depth).length ? Math.max(...Object.values(graph.depth)) : 0,
      components: graph.components.length,
      has_cycle: graph.hasCycle,
    },
    unreachable,
    bottlenecks,
    lapse_hotspots: lapseHotspots,
    health: { ...graphHealthScore(graph, { endpoints }), est_note: estSpreadNote(graph), width_note: widthNote(graph) },
    suggestions: {
      concept_growth: rankedGrowth,
      missing_pre: missingPre,
      jump_candidates: jumps.slice(0, sugCap),
      jump_total: jumps.length,
      ...(seedPhase ? { seed_phase: true } : {}),
      vault_link_candidates: vaultLinks.candidates.slice(0, sugCap),
    },
    vault_links: {
      scanned_at: vaultLinks.scanned_at,
      mapped_total: vaultLinks.mapped_total,
      ...(vaultLinks.scanned_at === null
        ? { hint: '还没有 Vault 链接扫描缓存——跑 learnhub_vault_links_scan 后这里出现个人笔记的关联候选' }
        : {}),
    },
    schema,
    nodes,
    edges,
  }
}

/** 逾期天数（状态视图用）。 */
export function overdueDays(due: string, today: string): number {
  const d = parseDay(due)
  const t = parseDay(today)
  return d && t ? Math.max(0, daysBetween(t, d)) : 0
}
