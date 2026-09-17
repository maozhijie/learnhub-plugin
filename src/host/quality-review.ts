/**
 * 离线批量评审运行器（#222 / ADR-0070）：契约、提示词与报告机械全在引擎（engine/content/quality-review.ts
 * / engine/content/quality-audit.ts），本文件是**宿主适配**——读盘（调用记录抽样池）、调模型（真
 * provider 只在宿主 ctx）、写盘（人读报告）。三件事都只能住宿主：引擎侧零 fs 零时钟（G8）、
 * 模型端口也只有宿主 ctx 上有。
 *
 * 调用形态一条链：`scripts/quality-review.mjs` → `POST /learnhub/api/quality-review`
 * → 本文件 → 引擎纯函数 + llmSeam。**手动触发**（票面规格），不进任何生产管线——评审是
 * 离线测量，不阻塞也不参与生成。
 *
 * 三条纪律：
 * - **评审调用本身进语料**（票面规格）：站标签 `STATIONS.qualityReview`，经 rt.corpus 捕获
 *   ——评审器也要能被评（判读稳定性、换模型时的判读漂移）。
 * - **temperature 固定**（`REVIEW_TEMPERATURE`，票 7 端口；默认值不动）：判定要可复算，
 *   跨版本/跨轮次的差异应是内容差异；温度固定下的残余波动即模型/供应商漂移信号。
 * - **报告不进 canonical**：写 `<中心>/state/质量评审/<ts>-<scope>.md`（单文件原子写、无跨文件
 *   事务——G9 判据：单文件观测写不入 runWriteUnit 站点表）；沉淀层「内容质量结论」事件另行
 *   落地（event schema 随 ADR）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  AUDIT_AXES,
  DEFAULT_SAMPLE_QUOTA,
  artifactTextOf,
  auditCriteriaOf,
  QUALITY_RUBRICS,
  QUALITY_REVIEW_STATION,
  REVIEW_EFFORT,
  REVIEW_TEMPERATURE,
  RUBRIC_COURTS,
  auditScopeLines,
  isScoreable,
  lowScoreItems,
  parseDimensionScores,
  renderQualityReviewReport,
  reviewBlindPrompt,
  reviewReconcilePrompt,
  rubricForStation,
  sampleQualitySamples,
  scoreStats,
  stabilityOf,
  systemicCandidates,
  templateVersionOf,
  versionComparison,
} from '../engine/index.ts'
import type { QualityReviewReport, ReviewSample, SampleQuota, SampleReview, QualityRubric } from '../engine/index.ts'
import { llmSeam } from './llm.ts'
import { stampCorpusSink } from './corpus.ts'
import { corpusLayoutOf, parseCorpusFile, readCallRecords } from './corpus-read.ts'
import type { HostRuntime } from './runtime.ts'

/** 运行入参（路由可覆盖；缺省 = 全部有量规的站、配额 3 失败件 + 2 成功件、重复 2 次）。 */
export interface QualityReviewRequest {
  /** 语料目录（缺省 = 本 vault 的 state/调用记录；指向历史 state/生成语料/ 走旧读侧，
   * 供 fixture/历史语料回放——旧档冻结不迁移，ADR-0103）。 */
  corpusDir?: string
  /** 只看这些站（缺省 = 量规在册且语料目录里存在的站）。 */
  stations?: string[]
  /** 失败/容忍件取样上限（缺省 3）。 */
  badQuota?: number
  /** 成功件取样上限（缺省 2）。 */
  okQuota?: number
  /** 每件重复评审次数（缺省 2——稳定性读数要两次才可观测；1 = 关稳定性读数）。 */
  repeats?: number
  /** 报告写盘目录覆盖（缺省 = 本 vault 的 state/质量评审）。 */
  outDir?: string
  /** 系统性发现候选阈值覆盖（#224；缺省见 quality-audit 的预注册线）。 */
  systemic?: { minSamples?: number; lowRate?: number }
}

/** 运行结果：结构化报告 + 渲染后的 markdown + 落盘路径（驱动脚本三样都用）。 */
export interface QualityReviewRunResult {
  report: QualityReviewReport
  markdown: string
  reportPath: string
}

/** 语料目录 → 样本清单。**双形态读侧**（#330）：新目录（`调用记录/`，按任务成组）走
 * 按调用读侧 readCallRecords；旧 `state/生成语料/` 目录（冻结，不迁移）走旧读侧
 * parseCorpusFile——历史语料回放是 corpusDir 参数存在的意义。坏档/非本格式文件按
 * 空串走，不中断整轮——一件坏档不该让整轮评审失败，它会以「未评分件」现身报告。 */
export function readCorpusSamples(corpusDir: string, stations: readonly string[]): ReviewSample[] {
  if (corpusLayoutOf(corpusDir) === '生成语料') return readLegacyCorpusSamples(corpusDir, stations)
  const out: ReviewSample[] = []
  for (const call of readCallRecords(corpusDir, { stations })) {
    out.push({
      ref: call.ref,
      station: call.station,
      ts: call.ts,
      kind: call.kind,
      ...(call.effort !== undefined ? { effort: call.effort } : {}),
      outcome: call.outcome,
      ...(call.code ? { code: call.code } : {}),
      ...(call.truncated ? { truncated: true } : {}),
      templateVersion: templateVersionOf(call.prompt),
      prompt: call.prompt,
      output: call.output,
      ...(call.toolCalls.length ? { toolCalls: call.toolCalls } : {}),
    })
  }
  return out
}

/** 旧生成语料目录（冻结格式）的样本清单：`<dir>/<站>/*.md` 一调用一文件。 */
function readLegacyCorpusSamples(corpusDir: string, stations: readonly string[]): ReviewSample[] {
  const out: ReviewSample[] = []
  for (const station of stations) {
    const dir = join(corpusDir, station)
    let files: string[]
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      const parsed = parseCorpusFile(readFileSync(join(dir, file), 'utf8'))
      const fm = parsed.frontmatter
      const outcome = fm.outcome === 'failed' || fm.outcome === 'tolerated' ? fm.outcome : 'ok'
      out.push({
        ref: `${station}/${file}`,
        station,
        ts: fm.ts ?? '',
        kind: fm.kind ?? 'complete',
        ...(fm.effort && fm.effort !== '默认' ? { effort: fm.effort } : {}),
        outcome,
        ...(fm.code ? { code: fm.code } : {}),
        ...(fm.truncated === 'true' ? { truncated: true } : {}),
        templateVersion: templateVersionOf(parsed.prompt),
        prompt: parsed.prompt,
        output: parsed.output,
        ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      })
    }
  }
  return out
}

/** 语料目录里现有站 + 量规在册站的交集（评审范围的口径单源：没有量规的站不评——
 * 判定标准先于判定器）。双形态：新目录盘点按调用读侧的站集合，旧目录按子目录名。 */
function scopeOf(corpusDir: string, requested?: readonly string[]): string[] {
  const registry = [...new Set(QUALITY_RUBRICS.flatMap(r => r.stations))]
  const available = corpusLayoutOf(corpusDir) === '生成语料'
    ? new Set(existsSync(corpusDir)
      ? readdirSync(corpusDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : [])
    : new Set(readCallRecords(corpusDir).map(c => c.station))
  const wanted = requested?.length ? requested.filter(s => registry.includes(s)) : registry
  return wanted.filter(s => available.has(s)).sort()
}

/** 跑一轮离线评审：抽样 → 逐件两段式评审（盲评 → 对账）→ 聚合 → 人读报告落盘。
 * 同步阻塞整轮（分钟级），驱动脚本按长超时调用（与冒烟/spike 同形态）。 */
export async function runQualityReview(
  ctx: Context,
  rt: HostRuntime,
  opts?: QualityReviewRequest,
): Promise<QualityReviewRunResult> {
  if (!ctx.llm) {
    throw new Error('[quality-review] 宿主 ctx 没有 llm——离线评审必须在宿主进程内跑（真 provider 只在宿主）。'
      + '先在仓库根 npm run build，再 npx @deepseek-ai/dsh web 起宿主。')
  }
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const quota: SampleQuota = {
    bad: opts?.badQuota ?? DEFAULT_SAMPLE_QUOTA.bad,
    ok: opts?.okQuota ?? DEFAULT_SAMPLE_QUOTA.ok,
  }
  const repeats = Math.max(1, Math.floor(opts?.repeats ?? 2))
  const corpusDir = (opts?.corpusDir ?? rt.engine.paths.corpusDir).replace(/\\/g, '/')
  const registry = [...new Set(QUALITY_RUBRICS.flatMap(r => r.stations))]
  const wanted = scopeOf(corpusDir, opts?.stations)
  if (!wanted.length) {
    throw new Error(`[quality-review] 语料目录里没有「有量规的站」样本：${corpusDir}（量规在册站：${registry.join('、')}）。`
      + '先跑一轮生成（或 npm run smoke）让语料落库，再用 --stations 指定要看的站。')
  }

  const pool = readCorpusSamples(corpusDir, wanted)
  const picked = sampleQualitySamples(pool, quota)
  const llm = llmSeam(ctx, stampCorpusSink(rt.corpus, { source: '离线' }))
  const reviews: SampleReview[] = []
  const unscoreable: QualityReviewReport['unscoreable'] = []
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const sample of picked) {
    const rubric = rubricForStation(sample.station, QUALITY_RUBRICS)
    if (!rubric) continue
    if (!isScoreable(sample)) {
      unscoreable.push({
        ref: sample.ref, station: sample.station, outcome: sample.outcome,
        ...(sample.code ? { code: sample.code } : {}),
      })
      continue
    }
    for (let run = 1; run <= repeats; run++) {
      const t = Date.now()
      const cost = { calls: 0, inputTokens: 0, outputTokens: 0 }
      const usageSink = (u: { inputTokens: number; outputTokens: number }): void => {
        cost.calls++
        cost.inputTokens += u.inputTokens
        cost.outputTokens += u.outputTokens
      }
      const record: SampleReview = {
        ref: sample.ref, station: sample.station, run, templateVersion: sample.templateVersion,
        outcome: sample.outcome, calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0,
      }
      try {
        // 一期：盲评（只给量规与产物原文；生成提示词与元数据一律不给——防锚定）
        const blindRaw = await llm(reviewBlindPrompt(rubric, sample), undefined, {
          effort: REVIEW_EFFORT, station: QUALITY_REVIEW_STATION, kind: 'complete',
          temperature: REVIEW_TEMPERATURE, usageSink,
        })
        const blind = parseDimensionScores(blindRaw, rubric, artifactTextOf(sample))
        record.blind = blind.scores
        // 二期：对账（给生成提示词 + 元数据，逐维度确认或修正）
        const reconRaw = await llm(reviewReconcilePrompt(rubric, sample, blind.scores), undefined, {
          effort: REVIEW_EFFORT, station: QUALITY_REVIEW_STATION, kind: 'complete',
          temperature: REVIEW_TEMPERATURE, usageSink,
        })
        const reconciled = parseDimensionScores(reconRaw, rubric, artifactTextOf(sample))
        record.reconciled = reconciled.scores
        if (reconciled.contractNote) record.contractNote = reconciled.contractNote
      } catch (err) {
        // 评审失败（应答不可解析/维度缺失）：**评审失败 ≠ 产物差**——报告单列，不当低分
        record.failure = err instanceof Error ? err.message : String(err)
      }
      record.calls = cost.calls
      record.inputTokens = cost.inputTokens
      record.outputTokens = cost.outputTokens
      record.durationMs = Date.now() - t
      calls += cost.calls
      inputTokens += cost.inputTokens
      outputTokens += cost.outputTokens
      reviews.push(record)
    }
  }

  const stats = scoreStats(reviews, QUALITY_RUBRICS)
  const lowScores = lowScoreItems(reviews, QUALITY_RUBRICS)
  const report: QualityReviewReport = {
    startedAt,
    durationMs: Date.now() - t0,
    temperature: REVIEW_TEMPERATURE,
    repeats,
    rubricIds: [...new Set(wanted.map(s => rubricForStation(s, QUALITY_RUBRICS)?.id).filter((x): x is QualityRubric['id'] => !!x))].sort(),
    sampling: { corpusDir, stations: wanted, pool: pool.length, selected: picked.length, quota },
    reviews,
    unscoreable,
    stats,
    lowScores,
    versions: versionComparison(reviews),
    stability: repeats > 1 ? stabilityOf(reviews) : [],
    cost: { calls, inputTokens, outputTokens },
    court: RUBRIC_COURTS,
  }
  // 图质量面审计（#224）：范围含审计面站时算系统性候选——候选是提议，报告单列由人审裁决
  const auditStations = AUDIT_AXES.flatMap(a => a.stations)
  const inAuditScope = wanted.some(s => auditStations.includes(s))
  if (inAuditScope) report.systemic = systemicCandidates(stats, lowScores, auditCriteriaOf, opts?.systemic)

  const markdown = renderQualityReviewReport(report, { headerExtras: inAuditScope ? auditScopeLines(report) : [] })
  const outDir = (opts?.outDir ?? rt.engine.paths.qualityReviewDir).replace(/\\/g, '/')
  const reportPath = reportFileOf(outDir, wanted, startedAt)
  mkdirSync(outDir, { recursive: true })
  atomicPut(reportPath, markdown)
  report.reportPath = reportPath
  return { report, markdown, reportPath }
}

/** 报告文件名：`<ts>-<站>.md`（ts 紧凑到秒；站名是受控词表、无斜杠）。同秒同范围重跑 = 同名
 * 原子覆盖（报告是不可变读数，追加只会让人读到半新半旧的两轮）。 */
function reportFileOf(outDir: string, stations: readonly string[], ts: string): string {
  return `${outDir}/${ts.replace(/[:.]/g, '-')}-${stations.join('-') || '全部'}.md`
}

/** tmp + rename 原子写（与语料捕获/引擎 atomicWrite 同语义；单文件观测写，不入 runWriteUnit）。 */
function atomicPut(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, path)
}
