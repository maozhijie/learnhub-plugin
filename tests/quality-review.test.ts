/**
 * 离线批量评审器·引擎面（#222 / ADR-0070）：抽样 / 两段式提示词 / 应答解析 / 证据定位核对 /
 * 聚合读数 / 人读报告——逐条钉住票面验收：
 *
 * - 「对样例语料跑出报告」：夹具语料（tests/fixtures/quality-corpus/）经宿主读侧投影后可直接
 *   进抽样与报告（本文件用真夹具跑一遍池/抽样/版本提取）。
 * - 「同输入两次评审稳定性可观测」：`stabilityOf` 对两次同判给 100% 一致、对改动给档差。
 * - 「报告每条分数能指到具体语料文件与原文证据」：报告渲染里 ref 与证据引文都在；
 *   引文**逐条确定性核对**（找不到即 unlocated，报告显式列出）。
 * - 「无总分」：报告不出现任何跨维度合成分数（结构性断言：无 `总分: <数字>` 形态）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SAMPLE_QUOTA,
  QUALITY_REVIEW_SYSTEM,
  REVIEW_SCORE_LABELS,
  dimensionNameOf,
  equidistantIndices,
  evidenceLocated,
  finalScores,
  isScoreable,
  lowScoreItems,
  parseDimensionScores,
  renderQualityReviewReport,
  reviewBlindPrompt,
  reviewReconcilePrompt,
  rubricForStation,
  rubricStations,
  sampleQualitySamples,
  scoreStats,
  stabilityOf,
  templateVersionOf,
  versionComparison,
  QUALITY_RUBRICS,
} from '../src/engine/index.ts'
import type { DimensionScore, QualityReviewReport, ReviewSample, SampleReview } from '../src/engine/index.ts'
import { readCorpusSamples } from '../src/host/quality-review.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS = join(ROOT, 'tests', 'fixtures', 'quality-corpus')

/** 桩样本：只填评审机械用得到的字段（站/ref/版本/提示词/产物）。 */
function sample(over: Partial<ReviewSample> = {}): ReviewSample {
  return {
    ref: '教练生长/ok-桩.md',
    station: '教练生长',
    ts: '2026-09-13T00:00:00.000Z',
    kind: 'loop',
    effort: 'fast',
    outcome: 'ok',
    templateVersion: 5,
    prompt: '<!-- learnhub:prompt/v5 -->\n# 教练回合提示词\n生成提示词暗号：只有对账才看得到这句',
    output: 'note:\n  operator: 前进\n  reason: 补最靠近前沿的一级台阶\nops:\n  - add_node: 把一个数字存进变量并打印出来\n',
    ...over,
  }
}

/** 桩应答：按维度给分的 JSON（evidence 可注入「引文不实」样本）。 */
function replyJson(scores: Record<string, number | null>, evidence: Record<string, string[]> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dimensions: Object.entries(scores).map(([id, score]) => ({ id, score, evidence: evidence[id] ?? [], notes: `${id} 的判分理由` })),
    ...extra,
  })
}

const COACH = QUALITY_RUBRICS.find(r => r.id === '教练回合')!
const COACH_DIMS = COACH.dimensions.map(d => d.id)

// ---------------------------------------------------------------- 版本提取与可评分性

test('模板版本提取：提示词中段的版本标记可认（拼装后的提示词首段即模板）；无标记 = null（不冒充 v0）', () => {
  assert.equal(templateVersionOf('【任务】\n<!-- learnhub:prompt/v5 -->\n# 教练回合提示词'), 5)
  assert.equal(templateVersionOf('<!-- learnhub:prompt/v11 -->\n# 课程大纲'), 11)
  assert.equal(templateVersionOf('没有版本标记的提示词'), null)
  assert.equal(templateVersionOf(''), null)
})

test('可评分性：空输出不可评（零模型调用，审计价值在失败本身）；有输出即可评', () => {
  assert.equal(isScoreable(sample({ output: '（空）' })), true)
  assert.equal(isScoreable(sample({ output: '' })), false)
  assert.equal(isScoreable(sample({ output: '   \n  ' })), false)
})

// ---------------------------------------------------------------- 抽样

test('抽样：等距无随机数（同输入同抽样）、越界收敛、k=0 为空', () => {
  assert.deepEqual(equidistantIndices(1, 1), [0])
  assert.deepEqual(equidistantIndices(3, 3), [0, 1, 2])
  assert.deepEqual(equidistantIndices(10, 4), [0, 2, 5, 7])
  assert.deepEqual(equidistantIndices(10, 0), [])
  assert.deepEqual(equidistantIndices(10, 99), equidistantIndices(10, 10))
})

test('抽样：失败/容忍件优先（bad 桶定额），成功件等距补足；逐站独立、返回时间序', () => {
  const pool: ReviewSample[] = [
    ...Array.from({ length: 6 }, (_, i) => sample({
      ref: `教练生长/ok-2026-09-13T00-00-0${i}-000${i}.md`,
      outcome: 'ok',
    })),
    sample({ ref: '教练生长/bad-2026-09-13T00-01-00-090Z-0007.md', outcome: 'failed' }),
    sample({ ref: '教练生长/bad-2026-09-13T00-02-00-100Z-0008.md', outcome: 'tolerated' }),
    sample({ ref: '教练生长/bad-2026-09-13T00-03-00-110Z-0009.md', outcome: 'failed' }),
    sample({ ref: '种子起草/ok-2026-09-13T00-04-00-120Z-0001.md', station: '种子起草' }),
  ]
  const picked = sampleQualitySamples(pool, { bad: 2, ok: 2 })
  const byStation = (s: string) => picked.filter(x => x.station === s).map(x => x.ref)
  const coach = byStation('教练生长')
  // bad 桶取最新两件（环形池新→旧），ok 桶等距两件，整体按 ref 升序（时间序）
  assert.deepEqual(coach.filter(r => r.includes('/bad-')), [
    '教练生长/bad-2026-09-13T00-02-00-100Z-0008.md',
    '教练生长/bad-2026-09-13T00-03-00-110Z-0009.md',
  ])
  assert.equal(coach.filter(r => r.includes('/ok-')).length, 2)
  assert.deepEqual(coach, [...coach].sort(), '返回按 ref 升序（人读与 diff 稳定）')
  assert.deepEqual(byStation('种子起草'), ['种子起草/ok-2026-09-13T00-04-00-120Z-0001.md'])
  assert.deepEqual(sampleQualitySamples(pool, { bad: 2, ok: 2 }), picked, '同输入同抽样')
  assert.equal(sampleQualitySamples(pool, { bad: 0, ok: 0 }).length, 0, '配额为 0 = 不抽')
})

test('抽样：缺省配额 = 失败件优先档（起步低，成本可控）', () => {
  assert.deepEqual(DEFAULT_SAMPLE_QUOTA, { bad: 3, ok: 2 })
})

// ---------------------------------------------------------------- 语料读侧（夹具）

test('夹具语料：宿主读侧投影出站/版本/outcome/空输出，可直接进抽样与评审', () => {
  const samples = readCorpusSamples(CORPUS, ['教练生长', '种子起草'])
  assert.equal(samples.length, 4, '夹具四件（教练生长三件 + 种子起草一件）')
  const bad = samples.find(s => s.ref.endsWith('0004.md'))!
  assert.equal(bad.outcome, 'failed')
  assert.equal(bad.code, 'ERROR')
  assert.equal(isScoreable(bad), false, '空输出 = 未评分件（（空输出）占位还原为空串）')
  const ok = samples.find(s => s.ref.endsWith('0001.md') && s.station === '教练生长')!
  assert.equal(ok.outcome, 'ok')
  assert.equal(ok.templateVersion, 5)
  assert.ok(ok.prompt.includes('教练回合提示词'), '提示词原文进样本（二期对账材料）')
  assert.ok(ok.output.includes('add_node'), '原始输出原文进样本（一期受评对象）')
  const seed = samples.find(s => s.station === '种子起草')!
  assert.equal(seed.templateVersion, 3, '种子提案自带版本线 v3')
  const picked = sampleQualitySamples(samples, DEFAULT_SAMPLE_QUOTA)
  assert.ok(picked.some(s => s.outcome === 'tolerated'), '容忍命中件进样本（失败件优先）')
})

// ---------------------------------------------------------------- 两段式提示词（防锚定）

test('一期盲评：给量规判据与产物原文，不给生成提示词（防锚定）；二期对账才给提示词与元数据', () => {
  const s = sample()
  const blind = reviewBlindPrompt(COACH, s)
  assert.ok(blind.includes('# 质量评审·一期（盲评）'))
  assert.ok(blind.includes(COACH.dimensions[0]!.criteria[0]!.criterion), '判据原文来自量规表（判定标准先于判定器）')
  assert.ok(blind.includes(s.output.trim()), '产物原文进一期')
  assert.ok(!blind.includes('生成提示词暗号'), '一期不得出现生成提示词内容')
  assert.ok(!blind.includes('v5'), '一期不得给出模板版本等元数据（盲）')
  assert.ok(blind.includes('"score": 1|2|3|4|null'), '输出契约给出判分档位')
  const recon = reviewReconcilePrompt(COACH, s, COACH_DIMS.map(id => ({ id, score: 3, evidence: [], notes: 'n', unlocated: [] })))
  assert.ok(recon.includes('# 质量评审·二期（对账）'))
  assert.ok(recon.includes('生成提示词暗号'), '二期给生成提示词')
  assert.ok(recon.includes('模板版本：v5'), '二期给元数据（版本/站/档/outcome）')
  assert.ok(recon.includes('"revised"'), '二期的修正标记进输出契约')
})

test('评审员系统提示词：判读纪律逐条在册（提议/证据必须原文/引不到判不可判/无总分/JSON only）', () => {
  for (const anchor of ['提议', '原文里的原句', '"score": null', '不合成跨维度总分', 'JSON only']) {
    assert.ok(QUALITY_REVIEW_SYSTEM.includes(anchor), `系统提示词缺判读纪律锚点「${anchor}」`)
  }
})

// ---------------------------------------------------------------- 应答解析与证据核对

test('应答解析：全维度齐备是硬要求（缺一个 = 评审失败，不当低分）', () => {
  const s = sample()
  const good = replyJson(Object.fromEntries(COACH_DIMS.map((d, i) => [d, i === 0 ? 2 : 4])))
  const parsed = parseDimensionScores(good, COACH, s.output)
  assert.deepEqual(parsed.scores.map(x => x.id), COACH_DIMS)
  assert.equal(parsed.scores[0]!.score, 2)
  const missing = replyJson(Object.fromEntries(COACH_DIMS.slice(1).map(d => [d, 4])))
  assert.throws(() => parseDimensionScores(missing, COACH, s.output), /缺维度/)
  const unknown = JSON.stringify({ dimensions: [{ id: '不存在的维度', score: 4 }] })
  assert.throws(() => parseDimensionScores(unknown, COACH, s.output), /量规外的维度/)
  const dup = replyJson({ [COACH_DIMS[0]!]: 3, [COACH_DIMS[1]!]: 3, [COACH_DIMS[2]!]: 3 })
  assert.doesNotThrow(() => parseDimensionScores(dup, COACH, s.output))
})

test('应答解析：宽容度可用但判据不放松（name 当 id、围栏、尾逗号；分数越界/非整数照拒）', () => {
  const s = sample()
  const byName = JSON.stringify({
    dimensions: COACH.dimensions.map(d => ({ id: d.name, score: 3, evidence: [], notes: '' })),
  })
  assert.deepEqual(parseDimensionScores(byName, COACH, s.output).scores.map(x => x.id), COACH_DIMS, 'name 兜底归一')
  const fenced = '```json\n' + replyJson(Object.fromEntries(COACH_DIMS.map(d => [d, 3]))) + '\n```'
  assert.equal(parseDimensionScores(fenced, COACH, s.output).scores.length, 3, '剥围栏')
  const trailing = '{"dimensions": [' + COACH_DIMS.map(d => `{"id": "${d}", "score": 3, "evidence": [], "notes": ""},`).join('') + '],}'
  assert.equal(parseDimensionScores(trailing, COACH, s.output).scores.length, 3, '去尾逗号')
  assert.throws(() => parseDimensionScores(replyJson(Object.fromEntries(COACH_DIMS.map(d => [d, 4]))).replace('"score":4', '"score":5'), COACH, s.output), /判分非法/)
  assert.throws(() => parseDimensionScores(JSON.stringify({ dimensions: COACH_DIMS.map(d => ({ id: d, score: 2.5 })) }), COACH, s.output), /判分非法/)
  assert.throws(() => parseDimensionScores('这里没有 JSON', COACH, s.output), /找不到 JSON/)
})

test('应答解析：不可判（score=null）合法；无证据判分被记录（评审面自身的读数）', () => {
  const s = sample()
  const raw = JSON.stringify({
    dimensions: COACH_DIMS.map((d, i) => ({ id: d, score: i === 0 ? null : 3, evidence: [], notes: i === 0 ? '产物无法判该维度' : '' })),
    contract_note: '契约解释了 ops 计数',
  })
  const parsed = parseDimensionScores(raw, COACH, s.output)
  assert.equal(parsed.scores[0]!.score, null)
  assert.equal(parsed.contractNote, '契约解释了 ops 计数')
})

test('证据定位核对：引文必须能在产物原文里找到（空白不敏感、长引文≥12 字前缀兜底、找不到记 unlocated）', () => {
  const artifact = 'note:\n  operator: 前进\n  reason: 补最靠近前沿的一级台阶\n'
  assert.equal(evidenceLocated('operator: 前进', artifact), true)
  assert.equal(evidenceLocated('operator:\n  前进', artifact), true, '空白不敏感')
  assert.equal(evidenceLocated('reason: 补最靠近前沿的一级台阶（模型尾部改写过）', artifact), true, '≥12 字前缀命中')
  assert.equal(evidenceLocated('凭空编的一句证据', artifact), false)
  assert.equal(evidenceLocated('', artifact), false)
  const raw = JSON.stringify({
    dimensions: COACH_DIMS.map((d, i) => ({
      id: d, score: 3, notes: '', evidence: i === 0 ? ['reason: 补最靠近前沿的一级台阶'] : ['这句话原文里没有'],
    })),
  })
  const parsed = parseDimensionScores(raw, COACH, artifact)
  assert.deepEqual(parsed.scores[0]!.unlocated, [])
  assert.deepEqual(parsed.scores[1]!.unlocated, ['这句话原文里没有'], '引文不实逐条留痕，不静默放过')
})

// ---------------------------------------------------------------- 聚合读数与报告

/** 一件评审记录（默认两期同判；可注入一期/二期分歧）。 */
function review(over: Partial<SampleReview> = {}): SampleReview {
  const blind: DimensionScore[] = COACH_DIMS.map((id, i) => ({ id, score: i === 0 ? 2 : 4, evidence: ['operator: 前进'], notes: 'n', unlocated: [] }))
  return {
    ref: '教练生长/ok-桩.md', station: '教练生长', run: 1, templateVersion: 5, outcome: 'ok',
    blind, reconciled: blind.map(d => ({ ...d })), calls: 2, inputTokens: 100, outputTokens: 50, durationMs: 1000,
    ...over,
  }
}

test('分数分布：1–4 各档 + 不可判 + 低分 + 无证据/未定位四类读数齐备（缺席即缺席，不填 0）', () => {
  const reviews: SampleReview[] = [
    review(),
    review({
      ref: '教练生长/ok-桩2.md',
      reconciled: COACH_DIMS.map((id, i) => ({
        id, score: i === 0 ? null : 3, evidence: [], notes: '',
        unlocated: i === 1 ? ['瞎引的证据'] : [],
      })),
    }),
  ]
  const stats = scoreStats(reviews, QUALITY_RUBRICS)
  const first = stats.find(s => s.dimension === COACH_DIMS[0])!
  assert.deepEqual(first.counts, [0, 1, 0, 0], '一件判 2 分')
  assert.equal(first.na, 1, '一件不可判（同一维度）')
  assert.equal(first.scored, 1)
  assert.equal(first.low, 1)
  assert.equal(first.dimensionName, COACH.dimensions[0]!.name, '维度显示名来自量规')
  const second = stats.find(s => s.dimension === COACH_DIMS[1])!
  assert.equal(second.counts[3], 1, '终判取二期')
  assert.equal(second.noEvidence, 1)
  assert.equal(second.unlocated, 1)
  assert.equal(stats.every(s => s.station === '教练生长'), true)
})

test('低分件清单 + 报告渲染：每条分数带语料 ref 与证据引文；报告不出现跨维度总分', () => {
  const reviews = [review(), review({ ref: '种子起草/ok-桩.md', station: '种子起草', templateVersion: 3, blind: [{ id: '起点资格', score: 1, evidence: ['starts: Python 基础语法'], notes: '复合泛称', unlocated: [] }], reconciled: [{ id: '起点资格', score: 1, evidence: ['starts: Python 基础语法'], notes: '复合泛称', unlocated: [] }] })]
  const low = lowScoreItems(reviews, QUALITY_RUBRICS)
  assert.equal(low.length, 2, '两件低分：教练回合 1 个维度 + 种子 1 个维度')
  assert.ok(low.every(x => x.ref && x.evidence.length), '低分件必带 ref 与证据')
  const report: QualityReviewReport = {
    startedAt: '2026-09-13T00:00:00.000Z', durationMs: 2000, temperature: 0, repeats: 2,
    rubricIds: ['教练回合', '种子·终点'],
    sampling: { corpusDir: 'C:/桩/生成语料', stations: ['教练生长', '种子起草'], pool: 4, selected: 3, quota: { bad: 3, ok: 2 } },
    reviews,
    unscoreable: [{ ref: '教练生长/bad-桩.md', station: '教练生长', outcome: 'failed', code: 'ERROR' }],
    stats: scoreStats(reviews, QUALITY_RUBRICS),
    lowScores: low,
    versions: versionComparison(reviews),
    stability: stabilityOf(reviews),
    cost: { calls: 6, inputTokens: 300, outputTokens: 150 },
    court: QUALITY_RUBRICS[0]!.court,
  }
  const md = renderQualityReviewReport(report)
  assert.ok(md.includes('# 质量评审报告'))
  assert.ok(md.includes('教练生长/ok-桩.md'), '报告指到具体语料文件')
  assert.ok(md.includes('「operator: 前进」'), '报告带原文证据引文')
  assert.ok(md.includes('「starts: Python 基础语法」'))
  assert.ok(md.includes('未评分件'), '空输出件单列')
  assert.ok(md.includes('起点资格'), '维度显示名进报告')
  assert.ok(md.includes('模板版本对照视图'))
  assert.ok(md.includes('稳定性读数'))
  assert.ok(md.includes('人审是终审'), '分层法庭随报告带出')
  assert.doesNotMatch(md, /总分[:：]\s*\d/, '不得出现跨维度总分（量规无总分档）')
})

test('版本对照视图：按（站 × 模板版本）聚合低分率（同维度比，不做跨维度合成）', () => {
  const v5 = review({ ref: '教练生长/ok-v5.md', templateVersion: 5 })
  const v6low = review({
    ref: '教练生长/ok-v6.md', templateVersion: 6,
    reconciled: COACH_DIMS.map(id => ({ id, score: 1, evidence: ['q'], notes: '', unlocated: [] })),
  })
  const versions = versionComparison([v5, v6low])
  assert.deepEqual(versions.map(v => v.templateVersion), [5, 6])
  assert.equal(versions[0]!.lowRateByDimension[COACH_DIMS[0]!], 1, 'v5 该维度 1/1 低分')
  assert.equal(versions[1]!.lowRateByDimension[COACH_DIMS[0]!], 1, 'v6 该维度 1/1 低分')
  const unknown = versionComparison([review({ ref: '教练生长/ok-未知.md', templateVersion: null })])
  assert.equal(unknown[0]!.templateVersion, null, '无版本标记单列（不冒充 v0）')
})

test('稳定性读数：同件两轮同判 = 100% 一致；一轮改判 = 档差可见（同输入两次评审稳定性可观测）', () => {
  const same = stabilityOf([review({ run: 1 }), review({ run: 2 })])
  for (const s of same) {
    assert.equal(s.pairs, 1)
    assert.equal(s.agree, 1)
    assert.equal(s.meanAbsDelta, 0)
  }
  const moved = stabilityOf([
    review({ run: 1 }),
    review({ run: 2, reconciled: COACH_DIMS.map((id, i) => ({ id, score: i === 0 ? 4 : 3, evidence: ['q'], notes: '', unlocated: [] })) }),
  ])
  assert.equal(moved.find(s => s.dimension === COACH_DIMS[1])!.meanAbsDelta, 1, '3 vs 4 = 档差 1')
  assert.equal(moved.find(s => s.dimension === COACH_DIMS[1])!.agree, 0)
  assert.equal(stabilityOf([review({ run: 1 })]).length, 0, '单轮无稳定性读数（缺席）')
})

test('评审失败件不进分数分布（评审失败 ≠ 产物差）；未评分件（空输出）也不进', () => {
  const failed = review({ ref: '教练生长/ok-坏应答.md', blind: undefined, reconciled: undefined, failure: '评审应答缺 dimensions 数组' })
  const stats = scoreStats([failed], QUALITY_RUBRICS)
  assert.deepEqual(stats, [], '失败件不产生分布行')
  assert.equal(finalScores(failed), undefined)
  assert.equal(lowScoreItems([failed], QUALITY_RUBRICS).length, 0)
})

test('站 → 量规映射：多站共享量规逐站命中（题目两站、种子·终点两站）；无量规站不评', () => {
  assert.equal(rubricForStation('教练生长', QUALITY_RUBRICS)?.id, '教练回合')
  assert.equal(rubricForStation('种子起草', QUALITY_RUBRICS)?.id, '种子·终点')
  assert.equal(rubricForStation('目标反编译', QUALITY_RUBRICS)?.id, '种子·终点')
  assert.equal(rubricForStation('判卷', QUALITY_RUBRICS), undefined, '无量规站不评（判定标准先于判定器）')
  assert.ok(rubricStations(QUALITY_RUBRICS).includes('教练生长'))
  assert.equal(dimensionNameOf(QUALITY_RUBRICS, '教练生长', COACH_DIMS[0]!), COACH.dimensions[0]!.name)
  assert.equal(dimensionNameOf(QUALITY_RUBRICS, '教练生长', '不在册维度'), '不在册维度', '未命中退回 id，报告不缺行')
})

test('分数档标签齐全（报告与提示词共用同一份措辞）', () => {
  assert.deepEqual(Object.values(REVIEW_SCORE_LABELS), ['未兑现', '部分兑现', '基本兑现', '充分兑现'])
})
