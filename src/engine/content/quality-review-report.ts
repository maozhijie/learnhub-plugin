/**
 * 质量评审报告·形态与渲染（#222 / ADR-0070）：结构化报告类型 + 人读 markdown 渲染。
 *
 * 为什么与 `quality-review.ts` 分开住：那是评审器的**测量面**（抽样 / 提示词 / 解析 / 聚合
 * ——口径一旦定下就稳定），这里是**交付面**（人读排版——随读法演化）。两者变的原因不同，
 * 混在一个文件里会让「加一个读数」和「调一行排版」挤同一处 diff；报告类型由宿主与驱动脚本
 * 消费（--out 的机器可读面），渲染只有这一处实现（审计面声明由调用方以 headerExtras 拼入，
 * 不复制渲染逻辑）。
 *
 * 读法纪律（票面验收的直接兑现）：
 * - 报告先讲人话：**哪一站哪一维度出问题、哪几件、证据是什么**（低分件清单在分布表之后立刻给），
 *   逐件明细放附录——「每条分数能指到具体语料文件与原文证据」由这两处共同兑现。
 * - **无总分**：只给逐维度分布与低分件，不合成、不加权、不排序产物优劣（量规无总分档）。
 * - 评审失败件与未评分件（空输出）单列：**评审失败 ≠ 产物差**，不可混进分数分布。
 */
import { RUBRIC_COURTS } from './quality-rubrics.ts'
import {
  REVIEW_SCORE_LABELS, canonicalReviews, finalScores,
  type DimensionStat, type LowScoreItem, type SampleReview, type SampleQuota, type StabilityStat, type VersionStat,
} from './quality-review.ts'

/** 系统性发现候选（#224 图质量面）：某站某维度低分件占比越过阈值即入候选——「某算子被
 * 系统性误用」这类结论的候选形态。阈值是预注册线（quality-audit 里声明）。 */
export interface SystemicCandidate {
  station: string
  dimension: string
  /** 已判档件数。 */
  scored: number
  low: number
  /** 低分率（低分件 / 已判档件）。 */
  lowRate: number
  /** 低分件的语料引用（贴票用）。 */
  refs: string[]
  /** 本维度判据清单（`source` 是出处，改量规/开新票时的定位锚）。 */
  criteria: Array<{ id: string; source: string }>
}

/** 一次评审运行的结构化报告（宿主写盘 + 驱动脚本 --out 的机器可读面）。 */
export interface QualityReviewReport {
  startedAt: string
  durationMs: number
  /** 固定采样温度（可比性：跨版本/跨轮次差异应是内容差异）。 */
  temperature: number
  /** 每件重复评审次数（>1 时报告带稳定性读数）。 */
  repeats: number
  /** 本次消费的量规（逐站命中）。 */
  rubricIds: string[]
  sampling: {
    corpusDir: string
    stations: string[]
    /** 语料池件数（抽样前）。 */
    pool: number
    /** 选中件数。 */
    selected: number
    quota: SampleQuota
  }
  reviews: SampleReview[]
  /** 空输出的未评分件（零模型调用——审计价值在失败本身）。 */
  unscoreable: Array<{ ref: string; station: string; outcome: 'ok' | 'tolerated' | 'failed'; code?: string }>
  stats: DimensionStat[]
  lowScores: LowScoreItem[]
  versions: VersionStat[]
  stability: StabilityStat[]
  cost: { calls: number; inputTokens: number; outputTokens: number }
  /** 图质量面审计的系统性发现候选（#224；评审器只提议、人审终审）。 */
  systemic?: SystemicCandidate[]
  /** 报告写盘路径（宿主填；人读入口）。 */
  reportPath?: string
  /** 分层法庭元数据（判读分层随报告走）。 */
  court: typeof RUBRIC_COURTS
}

/** 渲染选项：`headerExtras` 是插入在判读分层块之后的额外块（#224 审计面声明由宿主按
 * quality-audit.AUDIT_AXES 拼出——报告渲染只有一处，框架块由调用方拼、不复制渲染逻辑）。 */
export interface ReportRenderOptions {
  headerExtras?: string[]
}

function pct(n: number, d: number): string {
  return d ? `${(n / d * 100).toFixed(0)}%` : '—'
}

/** 分布表一行：各档件数 + 不可判 + 已判 + 低分 + 评审面自身的异常（引文未定位/无证据判分）。 */
function histogram(line: DimensionStat): string {
  const cells = ([1, 2, 3, 4] as const).map(s => `${s}:${line.counts[s - 1]}`).join(' ')
  const bad = [line.unlocated ? `引文未定位 ${line.unlocated}` : '', line.noEvidence ? `无证据 ${line.noEvidence}` : ''].filter(Boolean)
  return `| ${line.dimensionName}（${line.dimension}） | ${cells} | ${line.na} | ${line.scored} | ${line.low} | ${bad.join('；') || '—'} |`
}

/** 人读报告渲染（报告 = 交付面：先把「哪一站哪一维度出问题、哪几件、证据是什么」讲清楚，
 * 逐件明细放附录）。 */
export function renderQualityReviewReport(report: QualityReviewReport, opts?: ReportRenderOptions): string {
  const L: string[] = []
  L.push('# 质量评审报告（离线批量评审器 #222）', '')
  L.push(`生成时间：${report.startedAt}｜耗时：${(report.durationMs / 1000).toFixed(1)} 秒｜模型调用：${report.cost.calls} 次`
    + `（入 ${report.cost.inputTokens} / 出 ${report.cost.outputTokens} tok）`)
  L.push(`语料目录：${report.sampling.corpusDir}｜站：${report.sampling.stations.join('、') || '（无）'}`
    + `｜池 ${report.sampling.pool} 件 → 抽样 ${report.sampling.selected} 件（失败/容忍 ≤${report.sampling.quota.bad}、成功 ≤${report.sampling.quota.ok}）`)
  L.push(`采样温度：${report.temperature}（固定值，保证可比性）｜重复评审：${report.repeats} 次/件｜量规：${report.rubricIds.join('、')}`)
  L.push('')
  L.push('> **判读分层**（词条「内容质量」）：本报告的 AI 评分是**提议**，逐条附证据引用；**人审是终审**。')
  L.push(`> 报告不进 canonical、不写沉淀层（「内容质量结论」事件另行落地）。量规无「总分」档：${report.court.ai}。`)
  L.push('')
  if (opts?.headerExtras?.length) L.push(...opts.headerExtras)

  // —— 每站视图 ——
  L.push('## 各站逐维度分数分布', '')
  const stations = [...new Set(report.stats.map(s => s.station))]
  if (!stations.length) L.push('（本次没有可评的样本——语料池为空或全部为未评分件）', '')
  for (const station of stations) {
    const rows = report.stats.filter(s => s.station === station)
    const reviewed = report.reviews.filter(r => r.station === station)
    const scoreable = canonicalReviews(reviewed).filter(r => finalScores(r)).length
    const failed = canonicalReviews(reviewed).filter(r => r.failure).length
    L.push(`### ${station}`, '')
    L.push(`评审件数：${scoreable}（件口径；${report.repeats} 轮/件，共 ${reviewed.length} 次评审）｜评审失败：${failed}`
      + `｜低分件：${report.lowScores.filter(x => x.station === station).length}`)
    L.push('')
    L.push('| 维度 | 1 未兑现 | 2 部分 | 3 基本 | 4 充分 | 不可判 | 已判 | 低分 | 评审面异常 |')
    L.push('|---|---|---|---|---|---|---|---|---|')
    for (const line of rows) L.push(histogram(line))
    L.push('')
  }

  // —— 低分件清单 ——
  L.push('## 低分件清单（≤2 分；每条附证据引用与语料文件锚）', '')
  if (!report.lowScores.length) L.push('（无低分件）', '')
  for (const item of report.lowScores) {
    L.push(`- **${item.ref}**｜${item.station} · ${item.dimensionName}（${item.dimension}）= ${item.score} ${REVIEW_SCORE_LABELS[item.score]}`
      + `${item.templateVersion !== null ? `｜模板 v${item.templateVersion}` : ''}${item.revised ? '｜二期修正过一期' : ''}`)
    if (item.notes) L.push(`  - 判分理由：${item.notes.replace(/\n+/g, ' ')}`)
    for (const q of item.evidence) L.push(`  - 证据：「${q}」`)
    if (!item.evidence.length) L.push('  - 证据：（无——评审未给引文，评审面异常，见上表）')
  }
  L.push('')

  // —— 未评分件与评审失败件 ——
  if (report.unscoreable.length) {
    L.push('## 未评分件（产物为空输出：调用级失败，审计价值在失败本身）', '')
    for (const u of report.unscoreable) L.push(`- ${u.ref}｜${u.station}｜outcome=${u.outcome}${u.code ? `（${u.code}）` : ''}`)
    L.push('')
  }
  const failures = report.reviews.filter(r => r.failure)
  if (failures.length) {
    L.push('## 评审失败件（应答不可解析/维度缺失——**评审失败 ≠ 产物差**，需人工看语料）', '')
    for (const f of failures) L.push(`- ${f.ref}｜第 ${f.run} 轮｜${f.failure}`)
    L.push('')
  }

  // —— 模板版本对照视图 ——
  L.push('## 模板版本对照视图（逐维度低分率）', '')
  L.push('| 站 | 模板版本 | 件数 | 已判 | 逐维度低分率 |')
  L.push('|---|---|---|---|---|')
  if (!report.versions.length) L.push('| （无可评样本） | — | — | — | — |')
  for (const v of report.versions) {
    const rates = Object.entries(v.lowRateByDimension).map(([d, r]) => `${d} ${pct(r, 1)}`).join('；') || '—'
    L.push(`| ${v.station} | ${v.templateVersion === null ? '版本未知' : `v${v.templateVersion}`} | ${v.samples} | ${v.scored} | ${rates} |`)
  }
  L.push('')
  L.push('> 版本间比的是**同一维度**的低分率，不做跨维度合成、不排序版本优劣——样本量与版本混杂都在表里，人审读数。', '')

  // —— 稳定性读数 ——
  if (report.repeats > 1) {
    L.push('## 稳定性读数（同输入重复评审；#222 验收「两次评审稳定性可观测」）', '')
    L.push('| 站 | 维度 | 可对件数 | 完全一致 | 一致率 | 平均档差（轮次极差） |')
    L.push('|---|---|---|---|---|---|')
    if (!report.stability.length) L.push('| （同件多轮都判了档的维度缺席） | — | 0 | — | — | — |')
    for (const s of report.stability) {
      L.push(`| ${s.station} | ${s.dimension} | ${s.pairs} | ${s.agree} | ${pct(s.agree, s.pairs)} | ${s.meanRange.toFixed(2)} |`)
    }
    L.push('')
    L.push(`> 温度固定 ${report.temperature} 下的残余分歧即模型/供应商侧漂移信号；一致率低 = 该维度判读不稳，人审先看它。`, '')
  }

  // —— 系统性发现候选（#224）——
  if (report.systemic) {
    L.push('## 系统性发现候选（图质量面审计 #224；预注册线见上「审计面声明」）', '')
    if (!report.systemic.length) {
      L.push('（无越线维度。**无候选 ≠ 无问题**——样本量小时低分率极不稳定，读数与件数一起看。）', '')
    }
    for (const c of report.systemic) {
      L.push(`- **${c.station} · ${c.dimension}**：低分 ${c.low}/${c.scored}（${pct(c.low, c.scored)}）`)
      L.push(`  - 低分件（证据贴票）：${c.refs.join('、') || '（无）'}`)
      L.push(`  - 判据出处：${c.criteria.length ? c.criteria.map(x => `${x.id}（${x.source}）`).join('；') : '（量规里未命中该维度）'}`)
    }
    if (report.systemic.length) L.push('', '> 候选是**提议**（分层法庭：人审终审）——蒸馏成新票挂总纲票 #212、或改量规/改提示词，都在人审裁决。')
    L.push('')
  }

  // —— 附录：逐件明细 ——
  L.push('## 附录：逐件明细（每条分数 → 语料文件 + 证据）', '')
  for (const r of report.reviews) {
    const scores = finalScores(r)
    L.push(`### ${r.ref}（第 ${r.run} 轮）`, '')
    L.push(`站：${r.station}｜模板版本：${r.templateVersion === null ? '未知' : `v${r.templateVersion}`}｜outcome：${r.outcome}`
      + `｜调用 ${r.calls} 次 / 入 ${r.inputTokens} 出 ${r.outputTokens} tok｜${(r.durationMs / 1000).toFixed(1)}s`)
    if (r.failure) L.push(`**评审失败**：${r.failure}（本期判读未采信，不进任何分布）`)
    if (!scores) {
      for (const d of r.blind ?? []) {
        L.push(`- ${d.id} = ${d.score === null ? '不可判' : `${d.score} ${REVIEW_SCORE_LABELS[d.score]}`}（未采信）`)
      }
      L.push('')
      continue
    }
    if (r.blind && r.reconciled) {
      const deltas = r.blind.filter((b, i) => b.score !== r.reconciled![i]!.score)
      L.push(`一期盲评 → 二期对账：${deltas.length ? `${deltas.length} 个维度被修正（${deltas.map(d => d.id).join('、')}）` : '判读未变'}`
        + `${r.contractNote ? `｜对账注记：${r.contractNote}` : ''}`)
    }
    L.push('')
    for (const d of scores) {
      const blind = r.blind?.find(b => b.id === d.id)
      const moved = blind && blind.score !== d.score ? `（一期 ${blind.score === null ? '不可判' : blind.score}）` : ''
      L.push(`- ${d.id} = ${d.score === null ? '不可判' : `${d.score} ${REVIEW_SCORE_LABELS[d.score]}`}${moved}`
        + `${d.unlocated.length ? `｜引文未定位 ${d.unlocated.length} 条` : ''}`
        + `${d.notes ? `\n  - 理由：${d.notes.replace(/\n+/g, ' ')}` : ''}`)
      for (const q of d.evidence) L.push(`  - 证据：「${q}」${d.unlocated.includes(q) ? '（未能在产物原文定位）' : ''}`)
    }
    L.push('')
  }
  return L.join('\n')
}
