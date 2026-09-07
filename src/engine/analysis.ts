/**
 * 图分析（吸收自 Python analysis.py 的核心口径；networkx → Graph 派生结构直算）。
 * 输出：结构统计、不可达节点、瓶颈（高扇出枢纽）、逾期热点（journal 驱动）、
 * cytoscape 渲染元素（面板 DAG 视图消费）。
 */
import type { Graph } from './graph.ts'
import type { Fm } from './types.ts'
import type { Store } from './store.ts'
import { effectiveStage } from './audit.ts'
import { graphHealthScore, estSpreadNote } from './health.ts'
import { floatNodes, jumpCandidates, scaleReport } from './quality.ts'
import type { JumpCandidate, ScaleReport, ScaleTarget } from './quality.ts'
import { parseDay, todayStr, daysBetween } from './dates.ts'
import { masteryOfFm } from './srs.ts'
import { hasReadyContent } from './notes.ts'

export interface GraphAnalysis {
  stats: {
    nodes: number
    edges: number
    enc_edges: number
    roots: number
    leaves: number
    max_depth: number
    components: number
    has_cycle: boolean
  }
  unreachable: string[]
  bottlenecks: Array<{ node: string; successors: number; unlocks: number }>
  lapse_hotspots: Array<{ node: string; lapses: number }>
  /** 图谱健康分（0-100；结束条件锚点，公式与语义见 health.ts）。
   * est_note：est 分布压缩的 advisor 提示（null = 无；不改分，est 重标注属图生成专题）。 */
  health: { score: number; breakdown: Record<string, number>; est_note: string | null }
  /** 分批构建建议（图谱 designer 逐批展开时规划下一批的输入，全部可行动）。 */
  suggestions: {
    /** 节点数 <5 的块（浅块优先，最多 8 个）——往哪扩。 */
    expand_blocks: Array<{ region: string; block: string; nodes: number }>
    /** 空降节点（region 序靠后且 pre 为空，最多 sugCap 个）——先补谁。 */
    missing_pre: string[]
    /** 平均 pre 数 <1.5 的块（最多 8 个）——哪里连接过少。 */
    unconverged: Array<{ region: string; block: string; avg_pre: number }>
    /** 认知跨步候选（合成口径见 quality.ts；最多 sugCap 条）——每条必须 verdict：认可或修。 */
    jump_candidates: JumpCandidate[]
    /** 跨步候选总数（截断前）——结束条件要求清零。 */
    jump_total: number
    /** 节点数 <3 的块（合并比展开更划算时）。 */
    merge_blocks: Array<{ region: string; block: string; nodes: number }>
  }
  /** 规模底线对照（ADR-0002：绝对规模走独立门槛，不进健康分）。 */
  scale: ScaleReport
  nodes: Array<{ data: { id: string; region: string; block: string; depth: number; stage: string; opt: boolean; mastery: number; type?: string } }>
  edges: Array<{ data: { id: string; source: string; target: string; kind: string; w?: number } }>
  /** 节点 schema 全量（pre/enc/est/bloom/difficulty/note…）——编辑规划与边级自查的数据依据；
   * elementsOnly 模式不含。 */
  schema: Record<string, {
    pre: string[]
    enc: Array<{ node: string; w: number }>
    opt: boolean
    est?: number
    type?: string
    bloom?: string
    difficulty?: number
    note?: string
  }>
}

export async function analyzeGraph(
  courseName: string, graph: Graph, state: Record<string, Fm>, store: Store,
  scaleTarget?: ScaleTarget | null,
): Promise<GraphAnalysis> {
  const today = todayStr()
  const t = parseDay(today)!

  // 不可达 = 从任一根出发 BFS 达不到的节点（有环时跳过）
  const unreachable: string[] = []
  if (!graph.hasCycle) {
    const seen = new Set<string>()
    const queue = graph.roots.slice()
    while (queue.length) {
      const u = queue.shift()!
      if (seen.has(u)) continue
      seen.add(u)
      for (const v of graph.succ[u]) if (!seen.has(v)) queue.push(v)
    }
    unreachable.push(...graph.names.filter(n => !seen.has(n)).sort())
  }

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
  const nodes = graph.names.map(n => {
    const fm = state[n]
    return {
      data: {
        id: n,
        region: graph.blockOf[n][1],
        block: graph.blockOf[n][2],
        depth: graph.depth[n] ?? 0,
        stage: effectiveStage(state, n),
        opt: graph.opt.has(n),
        mastery: masteryOfFm(fm),
        /** 已生成可读正文（列表/图三态标识：点开有东西读）。 */
        hasContent: hasReadyContent(fm),
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
    ...(graph.noteOf[n] ? { note: graph.noteOf[n] } : {}),
  }]))

  // 分批构建建议：块节点数（expand_blocks）、空降节点（missing_pre）、块平均前置数（unconverged）
  const blockStats = new Map<string, { region: string; block: string; nodes: number; preSum: number }>()
  for (const n of graph.names) {
    const [, region, block] = graph.blockOf[n]
    const key = `${region}\n${block}`
    const s = blockStats.get(key) ?? { region, block, nodes: 0, preSum: 0 }
    s.nodes++
    s.preSum += graph.preOf[n].length
    blockStats.set(key, s)
  }
  const blocks = [...blockStats.values()]
  // 建议条目上限随图规模伸缩：数百节点的大图浅块/空降节点成倍出现，固定 top-N 看不全
  const sugCap = Math.min(16, Math.max(8, Math.ceil(graph.names.length / 25)))
  const topBlocks = (
    items: typeof blocks, keep: (b: { nodes: number }) => boolean, cap: number,
  ) => items
    .filter(keep)
    .sort((a, b) => a.nodes - b.nodes || a.region.localeCompare(b.region))
    .slice(0, cap)
    .map(({ region, block, nodes }) => ({ region, block, nodes }))
  const expandBlocks = topBlocks(blocks, b => b.nodes < 5, sugCap)
  const missingPre = floatNodes(graph).slice(0, sugCap)
  const jumps = jumpCandidates(graph)
  const mergeBlocks = topBlocks(blocks, b => b.nodes < 3, sugCap)
  const unconverged = blocks
    .map(b => ({ ...b, avg_pre: Math.round((b.preSum / b.nodes) * 100) / 100 }))
    .filter(b => b.avg_pre < 1.5)
    .sort((a, b) => a.avg_pre - b.avg_pre)
    .slice(0, sugCap)
    .map(({ region, block, avg_pre }) => ({ region, block, avg_pre }))

  return {
    stats: {
      nodes: graph.names.length,
      edges: graph.edgeCount(),
      enc_edges: Object.values(graph.encOf).reduce((s, v) => s + v.length, 0),
      roots: graph.roots.length,
      leaves: graph.leaves.length,
      max_depth: Object.keys(graph.depth).length ? Math.max(...Object.values(graph.depth)) : 0,
      components: graph.components.length,
      has_cycle: graph.hasCycle,
    },
    unreachable,
    bottlenecks,
    lapse_hotspots: lapseHotspots,
    health: { ...graphHealthScore(graph), est_note: estSpreadNote(graph) },
    suggestions: {
      expand_blocks: expandBlocks,
      missing_pre: missingPre,
      unconverged,
      jump_candidates: jumps.slice(0, sugCap),
      jump_total: jumps.length,
      merge_blocks: mergeBlocks,
    },
    scale: scaleReport(graph.names.length, scaleTarget),
    schema,
    nodes,
    edges,
  }
}

/** 逾期天数（状态视图用）。 */
export function overdueDays(due: string, today = todayStr()): number {
  const d = parseDay(due)
  const t = parseDay(today)
  return d && t ? Math.max(0, daysBetween(t, d)) : 0
}
