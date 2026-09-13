/**
 * spike 语料复算（#216）：从「一调用一文件」的语料目录**离线**重建指标读数。
 *
 *   node --experimental-transform-types scripts/spike-recompute.mts <corpusDir> [--out <path>]
 *
 * 为什么需要它：装置的格式轴与成本轴是**运行时读数**（语料 frontmatter 逐格落盘：
 * 命中/交付/schema/token/耗时），而内容与多样性轴可由语料**确定性复算**（#230 注记：
 * 指标是确定性纯函数，不必在跑臂时另存日志）。于是即便响应链路出问题（#216 首轮实测
 * 被 fetch 的 300s 头超时掐断），数据仍可从语料拿回；也便于换口径重读历史语料。
 *
 * 口径声明（复算 vs 运行时，二者必须分清）：
 * - 交付/命中/schema/token：**运行时**读数（引擎受理门当场判定，落 frontmatter）；
 * - 节清单/题型分布/多样性/题面去重/invokes 覆盖：**复算**读数——解析该格原始应答
 *   得到的题集（回复面），未经受理门过滤（对照臂的 YAML 与工具臂的 JSON 走同一解析器：
 *   `YAML.parseModel`，JSON ⊂ YAML）。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Content } from '../src/engine/index.ts'
import { YAML } from '../src/engine/yaml.ts'
import { diversityMetricsOf, diversityQuestionOf } from '../src/engine/question-diversity.ts'
import { normalizeStem } from '../src/engine/question-dedup.ts'

const corpusDir = process.argv[2]
if (!corpusDir) {
  console.error('usage: node --experimental-transform-types scripts/spike-recompute.mts <corpusDir> [--out <path>]')
  process.exit(1)
}
const outIdx = process.argv.indexOf('--out')
const out = outIdx > 0 ? process.argv[outIdx + 1] : join(corpusDir, 'recomputed.json')

/** 语料 frontmatter（--- 围栏内键值）。 */
function frontmatter(body: string): Record<string, string> {
  const lines = body.split('\n')
  const end = lines.indexOf('---', 1)
  const fm: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(': ')
    if (i > 0) fm[line.slice(0, i)] = line.slice(i + 2)
  }
  return fm
}

/** 语料正文里的「逐轮实测 N 字符」与逐轮应答（### 第 N 轮 分段）。 */
function roundsOf(body: string): { promptChars: number; replies: string[] } {
  const promptChars = Number(/逐轮实测 (\d+) 字符/.exec(body)?.[1] ?? 0)
  const replies = body.split(/^### 第 \d+ 轮$/m).slice(1).map(s => s.trim())
  return { promptChars, replies }
}

interface Row {
  station: string
  arm: string
  variant: string
  run: number
  toolCalled: boolean
  delivered: boolean
  schemaOk: boolean
  inputTokens: number
  outputTokens: number
  durationMs: number
  promptChars: number
  quoteRounds: number
  extract: Record<string, unknown>
}

/** 站级复算：大纲 → 节清单；出题 → 题集 + 多样性 + 去重 + invokes 覆盖。 */
function recompute(station: string, replies: string[]): { extract: Record<string, unknown>; parsed: boolean } {
  const first = replies[0] ?? ''
  try {
    if (station === '课程大纲') {
      const sections = Content.parseOutline(first)
      return {
        parsed: true,
        extract: {
          sections: sections.length,
          types: sections.map(s => s.type),
          ids: sections.map(s => s.id),
          titles: sections.map(s => s.title),
        },
      }
    }
    const doc = YAML.parseModel(first) as { questions?: unknown } | null
    const questions = Array.isArray(doc?.questions) ? doc!.questions as Array<Record<string, unknown>> : []
    const stems = questions.map(q => (typeof q.q === 'string' ? q.q : '')).filter(Boolean)
    const metrics = diversityMetricsOf(questions.map(diversityQuestionOf))
    const invokes = questions.map(q => (typeof q.invokes === 'string' ? q.invokes : '')).filter(Boolean)
    return {
      parsed: questions.length > 0,
      extract: {
        questions: questions.length,
        // 注意：回复面计数（未经受理门）；受理面的 added/skipped 见报告 JSON 的 extract

        kinds: metrics.kinds,
        entropy: metrics.entropy.value,
        distractor: metrics.distractor ? metrics.distractor.value : null,
        selfBleu: metrics.selfBleu ? metrics.selfBleu.value : null,
        stemSimilarity: metrics.stemSimilarity ? metrics.stemSimilarity.value : null,
        distinctStems: new Set(stems.map(normalizeStem)).size,
        invokesTagged: invokes.length,
        invokesDistinct: new Set(invokes).size,
      },
    }
  } catch {
    return { parsed: false, extract: {} }
  }
}

const rows: Row[] = []
for (const station of readdirSync(corpusDir)) {
  let files: string[]
  try {
    files = readdirSync(join(corpusDir, station)).filter(f => f.endsWith('.md'))
  } catch {
    continue
  }
  for (const f of files) {
    const body = readFileSync(join(corpusDir, station, f), 'utf8')
    const fm = frontmatter(body)
    const { promptChars, replies } = roundsOf(body)
    const { extract } = recompute(station, replies)
    rows.push({
      station, arm: fm.arm ?? '?', variant: fm.variant ?? '?', run: Number(fm.run ?? 0),
      toolCalled: fm.tool_called === 'true', delivered: fm.delivered === 'true', schemaOk: fm.schema_ok === 'true',
      inputTokens: Number(fm.input_tokens ?? 0), outputTokens: Number(fm.output_tokens ?? 0),
      durationMs: Number(fm.duration_ms ?? 0), promptChars, quoteRounds: replies.length, extract,
    })
  }
}
rows.sort((a, b) => a.station.localeCompare(b.station, 'zh') || a.arm.localeCompare(b.arm) || a.variant.localeCompare(b.variant, 'zh') || a.run - b.run)

const pct = (a: number, b: number): number => (b ? a / b : 0)
const mean = (xs: number[]): number | null => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)) : null)
const varOf = (xs: number[]): number => {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
}
const cells = [...new Set(rows.map(r => `${r.station}|${r.arm}|${r.variant}`))].map(key => {
  const [station, arm, variant] = key.split('|') as [string, string, string]
  const rs = rows.filter(r => r.station === station && r.arm === arm && r.variant === variant)
  const num = (k: string): number[] => rs.map(r => Number(r.extract[k])).filter(Number.isFinite)
  return {
    station, arm, variant, runs: rs.length,
    delivered: rs.filter(r => r.delivered).length,
    deliveryRate: pct(rs.filter(r => r.delivered).length, rs.length),
    toolHits: rs.filter(r => r.toolCalled).length,
    hitRate: arm === 'tool' ? pct(rs.filter(r => r.toolCalled).length, rs.length) : null,
    schemaRate: pct(rs.filter(r => r.schemaOk).length, rs.length),
    inputTokens: rs.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rs.reduce((n, r) => n + r.outputTokens, 0),
    promptChars: rs.reduce((n, r) => n + r.promptChars, 0),
    meanDurationMs: Math.round(rs.reduce((n, r) => n + r.durationMs, 0) / Math.max(1, rs.length)),
    quality: {
      sections: mean(num('sections')),
      questions: mean(num('questions')),
      entropy: mean(num('entropy')),
      distractor: mean(num('distractor')),
      selfBleu: mean(num('selfBleu')),
      stemSimilarity: mean(num('stemSimilarity')),
      distinctStems: mean(num('distinctStems')),
      invokesTagged: mean(num('invokesTagged')),
      invokesDistinct: mean(num('invokesDistinct')),
    },
  }
})

/** Wilson 95% 区间（与装置同口径）。 */
function wilson(successes: number, n: number): [number, number] {
  if (n <= 0) return [0, 1]
  const z = 1.96
  const p = successes / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

/** 臂级读数（交付/命中带 Wilson CI，token 求和）。 */
function armStats(station: string, arm: string) {
  const rs = rows.filter(r => r.station === station && r.arm === arm)
  const delivered = rs.filter(r => r.delivered).length
  const hits = rs.filter(r => r.toolCalled).length
  return {
    station, arm, runs: rs.length,
    delivered, deliveryRate: pct(delivered, rs.length), deliveryCi: wilson(delivered, rs.length),
    hitRate: arm === 'tool' ? pct(hits, rs.length) : null,
    hitCi: arm === 'tool' ? wilson(hits, rs.length) : null,
    inputTokens: rs.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rs.reduce((n, r) => n + r.outputTokens, 0),
  }
}

/** 两臂差（工具 − 对照；Welch 95% 区间：区间含 0 = 小样本区分不开）。 */
function welch(station: string, metric: string) {
  const pick = (arm: string) => rows.filter(r => r.station === station && r.arm === arm)
    .map(r => Number(r.extract[metric])).filter(Number.isFinite)
  const a = pick('control')
  const b = pick('tool')
  const ma = mean(a)
  const mb = mean(b)
  if (ma === null || mb === null || a.length < 2 || b.length < 2) {
    return { station, metric, control: ma, tool: mb, diff: null as number | null, ci: null as [number, number] | null, n: [a.length, b.length] as [number, number] }
  }
  const se = Math.sqrt(varOf(a) / a.length + varOf(b) / b.length)
  const diff = Number((mb - ma).toFixed(4))
  return { station, metric, control: ma, tool: mb, diff, ci: [Number((diff - 1.96 * se).toFixed(4)), Number((diff + 1.96 * se).toFixed(4))] as [number, number], n: [a.length, b.length] as [number, number] }
}

const stations = [...new Set(rows.map(r => r.station))]
const armSummary = stations.flatMap(station => ['control', 'tool'].map(arm => armStats(station, arm)))
const qualityDiffs = stations.flatMap(station => (station === '课程大纲'
  ? ['sections']
  : ['questions', 'entropy', 'distractor', 'selfBleu', 'stemSimilarity', 'distinctStems', 'invokesTagged', 'invokesDistinct']
).map(m => welch(station, m)))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({
  reconstructedFrom: corpusDir,
  caveat: '格式/成本轴为运行时读数（frontmatter）；内容/多样性轴为语料复算（回复面，未经受理门过滤）',
  rows,
  cells,
  armSummary,
  qualityDiffs,
  totals: {
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
  },
}, null, 1) + '\n', 'utf8')

console.log(`复算完成：${rows.length} 行 → ${out}`)
console.log('站｜臂｜变体｜次数｜交付率｜命中率｜入/出 token｜质量读数')
for (const c of cells) {
  const q = c.quality
  const parts = Object.entries(q).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`${c.station}｜${c.arm}｜${c.variant}｜${c.runs}｜${(c.deliveryRate * 100).toFixed(1)}%｜${c.hitRate === null ? '—' : `${(c.hitRate * 100).toFixed(1)}%`}｜${c.inputTokens}/${c.outputTokens}｜${parts}`)
}
console.log(`合计 token：入 ${rows.reduce((n, r) => n + r.inputTokens, 0)} / 出 ${rows.reduce((n, r) => n + r.outputTokens, 0)}`)
console.log('')
console.log('臂级（交付/命中带 Wilson 95% CI）：')
for (const a of armSummary) {
  console.log(`${a.station}｜${a.arm}：交付 ${(a.deliveryRate * 100).toFixed(1)}%（CI ${(a.deliveryCi[0] * 100).toFixed(0)}–${(a.deliveryCi[1] * 100).toFixed(0)}%）`
    + `｜命中 ${a.hitRate === null ? '—' : `${(a.hitRate * 100).toFixed(1)}%（CI ${(a.hitCi![0] * 100).toFixed(0)}–${(a.hitCi![1] * 100).toFixed(0)}%）`}`
    + `｜token 入 ${a.inputTokens} / 出 ${a.outputTokens}`)
}
console.log('')
console.log('质量轴两臂差（工具 − 对照；Welch 95% 区间含 0 = 小样本区分不开）：')
for (const q of qualityDiffs) {
  console.log(`${q.station}｜${q.metric}：对照 ${q.control ?? '—'} vs 工具 ${q.tool ?? '—'}｜差 ${q.diff ?? '—'}（CI ${q.ci ? `${q.ci[0]}–${q.ci[1]}` : '—'}，n=${q.n[0]}/${q.n[1]}）`)
}
