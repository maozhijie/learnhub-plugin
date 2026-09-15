/**
 * 图质量面审计抽样（#224 / ADR-0070 §图质量面）：教练回合裁决质量（算子选择 + 理由 vs
 * 图面）的抽样审计——走 #222 评审器形态，量规用 #221 的「教练回合」，样本来自生成语料
 * （教练生长）。
 *
 * #256：种子链整体退役——「种子/终点资格」审计轴与「种子·终点」量规一并删除。
 *
 * 本模块只加审计特有的三件事，评分与报告机械全在 quality-review.ts（一条口径、一个实现）：
 *
 * 1. **审计面清单**（`AUDIT_AXES`）：每类审计的名字、量规、样本站与要看的维度——
 *    报告开头照它声明「这一轮审了什么、没审什么」，防「跑过一轮」被读成「全面覆盖」。
 * 2. **系统性发现候选**（`systemicCandidates`）：逐（站 × 维度）算低分率，越预注册线即
 *    入候选（票面「某算子被系统性误用」这类结论的候选形态）。
 *    候选是**提议**：蒸馏成票、改量规、开新票都在人审（分层法庭），本模块不下结论。
 * 3. **候选渲染**（`renderAuditSection`）：候选 + 低分件引用 + 判据出处，直接可贴回票面。
 *
 * 纯函数、零副作用（同 quality-review.ts 的纪律）。审计的「发现回流」是人在票上做
 * （低分件 + 证据贴票、系统性候选蒸馏新票），本模块只保证这两样在报告里是现成的。
 */
import { rubricForStation } from './quality-review.ts'
import type { DimensionStat, LowScoreItem } from './quality-review.ts'
import type { SystemicCandidate, QualityReviewReport } from './quality-review-report.ts'
import { QUALITY_RUBRICS } from './quality-rubrics.ts'

/** 判据引用（判据 id + 出处）：系统性候选与报告贴票行共用的一小片形状——四处各写一遍
 * 匿名结构（引擎/宿主/两处测试）是 code-review 点名的 Data Clumps，收敛到这里一个名字。 */
export interface CriterionRef {
  id: string
  source: string
}

/** 站 × 维度 → 本维度判据清单（贴票/改量规/开新票的定位锚）。候选与报告都走这一处，
 * 不在宿主或测试里各自再查一遍量规表。 */
export function auditCriteriaOf(station: string, dimension: string): CriterionRef[] {
  const rubric = rubricForStation(station, QUALITY_RUBRICS)
  const dim = rubric?.dimensions.find(d => d.id === dimension)
  return (dim?.criteria ?? []).map(c => ({ id: c.id, source: c.source }))
}

/** 图质量面的一类审计：样本站 + 量规 + 要看的维度（票面两类审计的机器可读形态）。 */
export interface AuditAxis {
  id: string
  name: string
  /** 从哪几个站的语料抽样本（与量规 `stations` 对齐；实跑时取其交集）。 */
  stations: string[]
  /** 量规 id（#221 注册表条目）。 */
  rubric: string
  /** 本轴审计的维度 id 及其看点（人读报告的开场声明）。 */
  dimensions: Array<{ id: string; focus: string }>
}

/** 图质量面审计轴（#224 规格；#256 种子轴退役后仅存教练回合轴）。 */
export const AUDIT_AXES: readonly AuditAxis[] = [
  {
    id: 'coach-turn',
    name: '教练回合裁决质量（算子选择 + 理由 vs 图面）',
    stations: ['教练生长'],
    rubric: '教练回合',
    dimensions: [
      { id: '生长纪律', focus: '新节点粒度/命名/依赖/边级自查是否兑现生成时纪律' },
      { id: '算子语义', focus: '算子方向、接线义务、插入预注册、批规模是否守住算子语义' },
      { id: '裁决与路线', focus: '分歧纪律与路线重写是否守非承诺措辞、停机转译是否得当' },
    ],
  },
]

/** 系统性候选的预注册线：至少这么多已判档件、且低分率不低于此值才入候选。 */
export const SYSTEMIC_MIN_SAMPLES = 2
export const SYSTEMIC_LOW_RATE = 0.5

/** 审计面声明行（报告开头；逐轴对照，未抽到样本的轴也照实列出「本轮无样本」）。 */
export function auditScopeLines(report: Pick<QualityReviewReport, 'sampling' | 'stats' | 'rubricIds'>): string[] {
  const L: string[] = []
  L.push(`> **审计面声明**（#224）：本轮抽样 ${report.sampling.selected} 件，量规 ${report.rubricIds.join('、') || '（无）'}。逐轴对照：`)
  for (const axis of AUDIT_AXES) {
    const inScope = axis.stations.filter(s => report.sampling.stations.includes(s))
    const scored = report.stats.filter(s => inScope.includes(s.station) && axis.dimensions.some(d => d.id === s.dimension))
      .reduce((n, s) => n + s.scored, 0)
    L.push(`> - ${axis.name}｜量规「${axis.rubric}」｜样本站：${axis.stations.join('、')}`
      + `${inScope.length ? `（本轮在册：${inScope.join('、')}，已判 ${scored} 件次）` : '（本轮无该轴语料样本）'}`)
    for (const d of axis.dimensions) L.push(`>   - 维度「${d.id}」：${d.focus}`)
  }
  L.push('')
  return L
}

/** 系统性发现候选：逐（站 × 维度）低分率越线即入候选。候选 = 「可能成系统性问题」的
 * 提议，须人审（样本量小时尤其：2/2 低分与 8/16 低分的证据强度不是一个量级，low/scored
 * 与 refs 随候选带出就是为了让人审看得见这件事）。`criteriaOf` 供候选带出判据出处
 * （哪个站的哪条判据被系统性违反——改量规/改提示词的定位锚）。 */
export function systemicCandidates(
  stats: readonly DimensionStat[],
  lowScores: readonly LowScoreItem[],
  criteriaOf: (station: string, dimension: string) => CriterionRef[] = auditCriteriaOf,
  opts?: { minSamples?: number; lowRate?: number },
): SystemicCandidate[] {
  const minSamples = opts?.minSamples ?? SYSTEMIC_MIN_SAMPLES
  const lowRate = opts?.lowRate ?? SYSTEMIC_LOW_RATE
  return stats
    .filter(s => s.scored >= minSamples && s.low / s.scored >= lowRate)
    .map(s => ({
      station: s.station,
      dimension: s.dimension,
      scored: s.scored,
      low: s.low,
      lowRate: s.low / s.scored,
      refs: lowScores.filter(x => x.station === s.station && x.dimension === s.dimension).map(x => x.ref),
      criteria: criteriaOf(s.station, s.dimension),
    }))
    .sort((a, b) => b.lowRate - a.lowRate || a.station.localeCompare(b.station) || a.dimension.localeCompare(b.dimension))
}

/** 候选渲染的格式住 quality-review.ts（报告是一份，渲染只有一处）——本模块只管
 * 候选的计算与审计面声明。 */
