/**
 * 出题多样性基线测量（#230 / ADR-0064）：对 `tests/fixtures/bank-corpus/` 的题库 YAML
 * 快照复算三指标，输出基线 JSON（`tests/fixtures/diversity-baseline.json`）。
 *
 * 一条口径、两个消费者：本脚本与 `tests/question-diversity.test.ts` 都调
 * `src/engine/question-diversity.ts` 的**同一函数**——基线的数字不可能与出题运行时
 * 读数用两套算法（那是基线最没有意义的一种死法）。所以脚本只负责「读文件 → 测 → 落
 * JSON」，不含任何公式。
 *
 * 口径（与模块头注释逐条对齐）：
 * - 每份题库文件 = 一个「批」（文件是节点级产物，是语料能给出的最小生成单位；
 *   同一节点多次调用的边界在语料里已不可辨，如实登记为「文件级」）；
 * - 全语料聚合 = 「题库累计」读数（出题时报的 bank 范围同口径，可直接对照）；
 * - 归档题排除、无选项题型不进干扰项轴、<2 道题面不进题面轴——缺席即缺席，不填 0。
 *
 * 用法（在仓库根跑，Node ≥ 24 直接跑 TS 类型剥离）：
 *   node scripts/diversity-baseline.mts            # 打印到 stdout（人读）
 *   node scripts/diversity-baseline.mts --write    # 重写基线 JSON（diff 必须逐条人审）
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { YAML } from '../src/engine/yaml.ts'
import { diversityMetricsOf } from '../src/engine/question-diversity.ts'
import type { DiversityMetrics, DiversityQuestion } from '../src/engine/question-diversity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const corpusDir = join(repo, 'tests/fixtures/bank-corpus')
const outPath = join(repo, 'tests/fixtures/diversity-baseline.json')

/** 一份题库文件 → 题目清单（非归档、形状合格的题；文件不可解析即抛，基线不接受「跳过」）。 */
function questionsOf(path: string): DiversityQuestion[] {
  const doc = YAML.parse(readFileSync(path, 'utf8')) as { node?: unknown; questions?: unknown } | null
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.questions)) {
    throw new Error(`${relative(repo, path)}：不是题库文档（缺 questions 数组）`)
  }
  return doc.questions
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
    .filter(q => q.archived !== true)
    .map(q => ({
      kind: typeof q.kind === 'string' ? q.kind : undefined,
      q: typeof q.q === 'string' ? q.q : undefined,
      options: q.options,
    }))
}

/** 读数 → 定长截断的展示串（人读用；JSON 里保留全精度）。 */
function fmt(m: DiversityMetrics): string {
  const n = (v: number | undefined, digits: number) => (v === undefined ? '—' : v.toFixed(digits))
  const kinds = Object.entries(m.kinds).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}×${c}`).join(' ')
  return `n=${m.sample} 熵=${n(m.entropy.value, 2)} 干扰项=${n(m.distractor?.value, 1)}`
    + ` self-BLEU=${n(m.selfBleu?.value, 3)} 相似度=${n(m.stemSimilarity?.value, 3)}｜${kinds}`
}

const names = readdirSync(corpusDir).filter(f => f.endsWith('.yaml')).sort()
const perBatch: Record<string, DiversityMetrics> = {}
const all: DiversityQuestion[] = []
for (const name of names) {
  const qs = questionsOf(join(corpusDir, name))
  all.push(...qs)
  perBatch[name] = diversityMetricsOf(qs)
}
const baseline = {
  note: '出题多样性基线（#230 / ADR-0064）：批 = 语料文件、bank = 全语料聚合；数字由 scripts/diversity-baseline.mts 用 src/engine/question-diversity.ts 同一函数复算，手改必被 tests/question-diversity.test.ts 打回',
  corpus: names.map(name => `tests/fixtures/bank-corpus/${name}`),
  total: all.length,
  aggregate: diversityMetricsOf(all),
  perBatch,
}
if (process.argv.includes('--write')) {
  writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n')
  console.log(`写入 ${relative(repo, outPath)}`)
}
console.log(`题库语料：${names.length} 个文件 / ${all.length} 道题（归档题已排除）`)
for (const name of names) console.log(`  ${name.replace(/\.yaml$/, '')}｜${fmt(perBatch[name]!)}`)
console.log(`  全语料聚合｜${fmt(baseline.aggregate)}`)
