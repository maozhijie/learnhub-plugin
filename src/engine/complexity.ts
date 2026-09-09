/**
 * 复杂度档位（Complexity Tier）：把节点难度/认知层级/前置规模折叠成低中高三档，
 * 内容生成据此推导节段数、篇幅与题量预算。est 只作容量上界、不参与分档（ADR-0005）。
 *
 * 纯静态模块：折叠、锚点与护栏全部是 graph 无关的纯函数，可直接单测。
 * 图谱侧的 pre 闭包规模与 p75 由调用方（engine）算好传入。
 */
import { BLOOM_LEVELS, type BloomLevel } from './types.ts'

/** 复杂度档位：1=低、2=中、3=高。 */
export type ComplexityTier = 1 | 2 | 3

/** 档位标签（CONTEXT.md Complexity Tier；prompt/日志/面板展示用）。 */
export const TIER_LABELS: Record<ComplexityTier, string> = { 1: '低', 2: '中', 3: '高' }

/** 档位标签 → 序号（GenJob/manifest 存中文标签时转回）；未知回退中档。 */
export const TIER_LABEL_TO_IDX: Record<string, ComplexityTier> = { 低: 1, 中: 2, 高: 3 }
export function tierIdxOf(label: string | undefined): ComplexityTier {
  return (label !== undefined && TIER_LABEL_TO_IDX[label] !== undefined) ? TIER_LABEL_TO_IDX[label]! : 2
}

/** 折叠输入：全部可选，函数对缺省做兜底（bloom 缺失不提档；est 仅 difficulty 缺失时回退）。 */
export interface TierSignals {
  difficulty?: number
  bloom?: BloomLevel | string
  est?: number
  /** pre 传递闭包规模（前置总数）。 */
  preClosureSize?: number
  /** 本课程 pre 闭包规模的 p75 阈值：≥ 即视为"深节点"，提一档。 */
  preClosureP75?: number
}

/** bloom 高阶层（提档条件）：分析/评价/创造。 */
const BLOOM_PROMOTE: ReadonlySet<string> = new Set(BLOOM_LEVELS.slice(3))

/** difficulty 缺失时按 est 回退 → 基档。 */
function baseByEst(est: number): ComplexityTier {
  if (est <= 15) return 1
  if (est <= 25) return 2
  return 3
}

/**
 * 折叠函数：基档 = difficulty（1-2→低 / 3→中 / 4-5→高）；difficulty 缺失按 est 回退，
 * 都缺失兜底中档。bloom ∈ {分析,评价,创造} 提一档、pre 闭包规模 ≥ p75 提一档，封顶高档。
 * est 在场且 difficulty 在场时完全忽略（只作容量上界）。
 * 深度提档需 p75 > 0：全课程无 pre 链（p75=0）时任何节点都不该因"深度"提档。
 */
export function complexityTier(s: TierSignals): ComplexityTier {
  let base: ComplexityTier
  if (s.difficulty !== undefined) {
    base = s.difficulty <= 2 ? 1 : s.difficulty === 3 ? 2 : 3
  } else if (s.est !== undefined) {
    base = baseByEst(s.est)
  } else {
    base = 2
  }
  let tier = base
  if (s.bloom !== undefined && BLOOM_PROMOTE.has(s.bloom)) tier = Math.min(3, tier + 1) as ComplexityTier
  const deep = s.preClosureSize !== undefined && s.preClosureP75 !== undefined
    && s.preClosureP75 > 0 && s.preClosureSize >= s.preClosureP75
  if (deep) tier = Math.min(3, tier + 1) as ComplexityTier
  return tier
}

// ---- 图谱侧派生（pre 闭包规模 / p75 / 节点档位） ----

/** complexityTier 所需的图派生输入的最小形状（Graph 结构兼容；便于零依赖构造测试）。 */
export interface GraphSignalsSource {
  names: string[]
  /** name → 直接前置列表。 */
  pred: Record<string, string[]>
  difficultyOf: Record<string, number>
  bloomOf: Record<string, string>
  estOf: Record<string, number>
}

/** 每节点 pre 传递闭包规模（前置总数；环安全，只按 pred 走）。 */
function computePreClosureSizes(g: GraphSignalsSource): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of g.names) {
    const seen = new Set<string>()
    const stack = [...(g.pred[n] ?? [])]
    while (stack.length) {
      const u = stack.pop()!
      if (seen.has(u)) continue
      seen.add(u)
      for (const p of g.pred[u] ?? []) if (!seen.has(p)) stack.push(p)
    }
    out[n] = seen.size
  }
  return out
}

const cache = new WeakMap<object, Record<string, number>>()

/** 本课程各节点 pre 闭包规模（同一 graph 对象只算一次）。 */
export function preClosureSizes(g: GraphSignalsSource): Record<string, number> {
  let sizes = cache.get(g)
  if (!sizes) {
    sizes = computePreClosureSizes(g)
    cache.set(g, sizes)
  }
  return sizes
}

/** 本课程 pre 闭包规模 p75 阈值（nodes 的 75 分位；<p75 视为普通深度）。 */
export function preClosureP75(g: GraphSignalsSource): number {
  const sizes = preClosureSizes(g)
  const values = g.names.map(n => sizes[n] ?? 0).sort((a, b) => a - b)
  if (!values.length) return 0
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.75))]
}

/** 节点复杂度档位（difficulty/bloom/est 缺省语义与复杂度折叠一致，见 complexityTier）。 */
export function nodeTierOf(g: GraphSignalsSource, node: string): ComplexityTier {
  const p75 = preClosureP75(g)
  return complexityTier({
    difficulty: g.difficultyOf[node],
    bloom: g.bloomOf[node],
    est: g.estOf[node],
    preClosureSize: preClosureSizes(g)[node],
    preClosureP75: p75,
  })
}

// ---- PS-I 先做后教路由（#81 C-2） ----

/**
 * PS-I（先挑战题→再正文）适用判据：bloom 高阶层（分析/评价/创造）或 difficulty ≥ 4
 * 的节点，生成大纲按「先挑战题→再正文」顺序规划（Sinha & Kapur 2021 元分析 g=0.36；
 * 幼龄反向效应 → 成人自学是适用区）。与样例效应按节点难度分流：中低难节点照旧
 * 「先教后练」，非全局反转。刻意不沿用复杂度档位折叠做判据——pre 闭包规模是内容
 * 规模信号，不是认知挑战信号。
 */
export function problemFirstOf(s: Pick<TierSignals, 'difficulty' | 'bloom'>): boolean {
  if (s.bloom !== undefined && BLOOM_PROMOTE.has(s.bloom)) return true
  return s.difficulty !== undefined && s.difficulty >= 4
}

/** 节点 PS-I 适用判据（图派生；difficulty/bloom 缺省 = 不启用，与折叠缺省语义一致）。 */
export function nodeProblemFirstOf(g: GraphSignalsSource, node: string): boolean {
  return problemFirstOf({ difficulty: g.difficultyOf[node], bloom: g.bloomOf[node] })
}

/** 节点大纲护栏：按节点档位查节段数是否方向性极端。空 = 放行。 */
export function outlineBudgetForNode(g: GraphSignalsSource, node: string, sectionCount: number): string[] {
  return checkOutlineBudget(nodeTierOf(g, node), sectionCount)
}

/** 每内容节段目标题量（validateBank 只管形状；有练习节时内容节减 1 题，练习集中在练习节）。 */
export function perSectionQuizTarget(tier: ComplexityTier, hasPracticeSection: boolean): number {
  const base = TIER_ANCHORS[tier].perSectionQuestions
  return Math.max(0, base - (hasPracticeSection ? 1 : 0))
}

/** 综合题数（随档位，替换原固定 3）。 */
export function genericQuizTarget(tier: ComplexityTier): number {
  return TIER_ANCHORS[tier].genericQuizCount
}

/** 复杂度档案注入文本（上下文包新区块：档位 + 节段数区间 + 篇幅 + 题量锚点）。 */
export function profileBlockLines(tier: ComplexityTier): string[] {
  const a = TIER_ANCHORS[tier]
  const [lo, hi] = a.sections
  return [
    `- 复杂度档位：${TIER_LABELS[tier]}（difficulty/bloom/前置规模折叠，est 只作容量上界）`,
    `- 目标节段数：${lo}-${hi} 节（按内容自然增减，方向性极端会被拦截重跑）`,
    `- 篇幅预算：单节辅助文字 ≤${a.sectionWordBudget} 字，可视化为主、文字为辅`,
    `- 出题目标：每内容节段约 ${a.perSectionQuestions} 道（含练习节时减 1），综合题 ${a.genericQuizCount} 道`,
  ]
}

/** 节点复杂度档案文本（上下文包注入用：给定图与节点直接得整块）。 */
export function nodeProfileLines(g: GraphSignalsSource, node: string): string[] {
  return profileBlockLines(nodeTierOf(g, node))
}

/** 单档锚点（收敛记录 2026-09-07；初值实现时可按实测校准，测试只锁方向与上下限形状）。 */
export interface TierAnchors {
  /** 节段数目标区间 [min, max]（prompt 锚定，非硬校验）。 */
  sections: [number, number]
  /** 单节辅助文字上限（可视化为主、文字为辅的篇幅预算）。 */
  sectionWordBudget: number
  /** 每内容节段目标题量（无练习节时；有练习节 -1，练习/交互节段 0）。
   * 地板 2：题量随档位增（复杂多、简单少），但简单课程不压到 1——节段数才是档位的主伸缩轴，
   * 且面板过关规则（连对基准 2）在 1 题的节上不可达。 */
  perSectionQuestions: number
  /** 综合题数（替换原固定 3）。 */
  genericQuizCount: number
}

export const TIER_ANCHORS: Record<ComplexityTier, TierAnchors> = {
  1: { sections: [1, 3], sectionWordBudget: 150, perSectionQuestions: 2, genericQuizCount: 2 },
  2: { sections: [3, 5], sectionWordBudget: 250, perSectionQuestions: 3, genericQuizCount: 3 },
  3: { sections: [4, 6], sectionWordBudget: 400, perSectionQuestions: 4, genericQuizCount: 4 },
}

/** 节段数总上限（任意档 >8 即拦；与旧"通常 3–8 节"口径一致）。 */
export const MAX_SECTIONS = 8

/**
 * 大纲护栏：只拦方向性极端（低档 >7 节、高档 ≤2 节、任意 >8 节），
 * 区间内的模型自由选择一律放行。返回 findings（空 = 通过）。
 */
export function checkOutlineBudget(tier: ComplexityTier, sectionCount: number): string[] {
  const findings: string[] = []
  const [lo, hi] = TIER_ANCHORS[tier].sections
  if (sectionCount > MAX_SECTIONS) {
    findings.push(`节段数 ${sectionCount} 超过总上限 ${MAX_SECTIONS}：过长课程会稀释每节质量，请压缩合并`)
  } else if (tier === 1 && sectionCount > 7) {
    findings.push(`低复杂度节点（档位：${TIER_LABELS[tier]}）规划 ${sectionCount} 节过多（本档目标 ${lo}-${hi} 节）：内容被注水拆分，请合并相关节段`)
  } else if (tier === 3 && sectionCount <= 2) {
    findings.push(`高复杂度节点（档位：${TIER_LABELS[tier]}）仅 ${sectionCount} 节过少（本档目标 ${lo}-${hi} 节）：复杂主题没有展开空间，请拆分`)
  }
  return findings
}
