import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { retentionBand, bandDistribution, execRatingDistribution, thermostatSuggestions } from '../src/engine/thermostat.ts'
import type { BandRec } from '../src/engine/coach.ts'
import type { ReviewRec } from '../src/engine/types.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

const TODAY = '2026-09-09'
const day = (back: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10)

const bandRec = (band: BandRec['band'], back: number, answered = 5, correct = 5): BandRec =>
  ({ date: day(back), course: '数学', node: '入门', band, answered, correct })

const BULK_EASY: BandRec[] = Array.from({ length: 8 }, (_, i) => bandRec('easy', i % 30))
const HIGH_RETENTION = { rate: 0.97, real: 40 }
const NO_SUGGEST = { bands: { sessions: 8, answered: 40, shares: { easy: 0.9, standard: 0.1, hard: 0 } }, retention: HIGH_RETENTION, defaultBand: null }

test('纯函数：保留率带与选择分布、执行评级分布（U 区未落地为合法空态）', () => {
  assert.deepEqual(retentionBand(null), { label: '无数据', level: 'empty' })
  assert.equal(retentionBand(0.97).level, 'high')
  assert.equal(retentionBand(0.5).level, 'low')

  const dist = bandDistribution([...BULK_EASY, bandRec('hard', 60)], TODAY)
  assert.equal(dist.sessions, 8, '窗口外（60 天前）不计')
  assert.equal(dist.shares.easy, 1)
  assert.deepEqual(bandDistribution([], TODAY), { sessions: 0, answered: 0, shares: { easy: 0, standard: 0, hard: 0 } })

  assert.deepEqual(execRatingDistribution([], TODAY), { count: 0, by_rating: {} }, 'U 区未落地 = 合法空态')
  // 执行事件行（rating_source='execution'，U 区落地后的形态）宽松读入聚合
  const logs = [
    { ts: `${day(1)}T10:00:00`, course: '数学', node: '入门', qid: 'e1', rating: 3, rating_source: 'execution' },
    { ts: `${day(2)}T10:00:00`, course: '数学', node: '入门', qid: 'e2', rating: 2, rating_source: 'execution' },
    { ts: `${day(2)}T10:00:00`, course: '数学', node: '入门', qid: 'a1', rating: 3, rating_source: 'auto' },
  ] as unknown as ReviewRec[]
  const exec = execRatingDistribution(logs, TODAY)
  assert.equal(exec.count, 2)
  assert.deepEqual(exec.by_rating, { 3: 1, 2: 1 })
})

test('纯函数：建议触发口径——长期择易×高保留→抬标准；长期择难×低保留→回标准；其余静默', () => {
  // 择易 + 高保留 + 默认非标准 → 建议抬
  const up = thermostatSuggestions(NO_SUGGEST)
  assert.equal(up.length, 1)
  assert.equal(up[0]!.id, 'band_default:standard')
  assert.equal(up[0]!.knob, 'band_default')
  assert.match(up[0]!.text, /标准/)
  assert.match(up[0]!.text, /保留率/)
  // 已是标准默认 → 不重复建议（同向沉默）
  assert.deepEqual(thermostatSuggestions({ ...NO_SUGGEST, defaultBand: 'standard' }), [])
  // 择难 + 低保留 → 建议回落
  const down = thermostatSuggestions({
    bands: { sessions: 8, answered: 40, shares: { easy: 0, standard: 0, hard: 1 } },
    retention: { rate: 0.5, real: 40 },
    defaultBand: null,
  })
  assert.equal(down.length, 1)
  assert.equal(down[0]!.apply.value, 'standard')
  // 混选 / 数据不足 / 无保留数据 → 静默
  assert.deepEqual(thermostatSuggestions({
    bands: { sessions: 8, answered: 40, shares: { easy: 0.5, standard: 0.3, hard: 0.2 } },
    retention: HIGH_RETENTION, defaultBand: null,
  }), [], '混选静默')
  assert.deepEqual(thermostatSuggestions({
    bands: { sessions: 2, answered: 8, shares: { easy: 1, standard: 0, hard: 0 } },
    retention: HIGH_RETENTION, defaultBand: null,
  }), [], '低数据静默')
  assert.deepEqual(thermostatSuggestions({
    bands: { sessions: 8, answered: 40, shares: { easy: 1, standard: 0, hard: 0 } },
    retention: { rate: null, real: 3 }, defaultBand: null,
  }), [], '保留样本不足静默')
})

// ---- 行为：仪表可读 + 建议逐条显式确认 ----

const DUE_BANK = { 入门: [tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } })] }

test('行为：跨区仪表可读（课程区有数、无界区空态、项目区后补占位）；零写侧', async () => {
  await withVault({
    banks: DUE_BANK,
    reviewLog: Array.from({ length: 20 }, (_, i) => JSON.stringify({
      ts: `${day(i % 20)}T10:00:00`, course: '数学', node: '入门', qid: `r${i}`,
      rating: 3, rating_source: 'auto', elapsed_days: 2,
      stability_before: 4, difficulty_before: 5, r_pred: 0.8,
    })),
    files: [{ path: '学习中心/state/难度带.jsonl', content: BULK_EASY.map(b => JSON.stringify(b)).join('\n') + '\n' }],
  }, async ({ engine }) => {
    const before = readFileSync(engine.paths.learnhubConfigPath, 'utf8')
    const view = await engine.thermostatView()
    assert.equal(view.course_region.retention.real, 20)
    assert.equal(view.course_region.retention_band.level, 'high', '20 次全对 → 保留率很高')
    assert.equal(view.course_region.band_choices.sessions, 8)
    assert.deepEqual(view.unbounded_region.execution_ratings, { count: 0, by_rating: {} }, 'U 区落地前合法空态')
    assert.equal(view.project_region.status, 'deferred')
    assert.ok(view.knobs.some(k => k.knob === 'band_default'))
    assert.ok(view.knobs.some(k => k.knob === 'retrieval_density' && /未上线/.test(k.status)), '检索点密度如实报未上线')
    assert.ok(view.knobs.some(k => k.knob === 'fading_tier'), '渐退档聚合展示位在')
    assert.equal(view.suggestions.length, 1, '择易×高保留触发一条建议')
    // 只读：仪表不写任何东西（含配置）
    assert.equal(readFileSync(engine.paths.learnhubConfigPath, 'utf8'), before, '恒温器视图零写入')
    assert.ok(!existsSync(engine.paths.journalPath))
  })
})

test('行为：建议逐条显式确认后生效——确认写默认带、复习队列消费；陈旧/伪造 id 拒绝', async () => {
  await withVault({ banks: DUE_BANK, notes: { 入门: { stage: 'review', fsrs: null } } }, async ({ engine }) => {
    // 先造出触发面：预置带日志与高保留日志
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(engine.paths.centerStateDir, { recursive: true })
    await writeFile(engine.paths.bandLogPath, BULK_EASY.map(b => JSON.stringify(b)).join('\n') + '\n', 'utf8')
    await writeFile(engine.paths.reviewLogPath, Array.from({ length: 20 }, (_, i) => JSON.stringify({
      ts: `${day(i % 20)}T10:00:00`, course: '数学', node: '入门', qid: `r${i}`,
      rating: 3, rating_source: 'auto', elapsed_days: 2,
      stability_before: 4, difficulty_before: 5, r_pred: 0.8,
    })).join('\n') + '\n', 'utf8')

    const view = await engine.thermostatView()
    assert.equal(view.suggestions[0]!.id, 'band_default:standard')

    // 确认前默认带为 null；显式确认后写入并被队列消费（standard 偏移 0 = 纯 A1，带值不变）
    assert.equal(await engine.bandDefault(), null)
    const plainBand = (await engine.reviewQueue('数学', '入门')).band
    const applied = await engine.thermostatApply('band_default:standard')
    assert.equal(applied.band_default, 'standard')
    assert.equal(await engine.bandDefault(), 'standard')
    assert.equal((await engine.reviewQueue('数学', '入门')).band, plainBand, '默认 standard = 纯 A1 语义（偏移 0）')

    // 建议已消化（同向沉默）→ 再确认同一 id 拒绝；伪造 id 拒绝
    const after = await engine.thermostatView()
    assert.deepEqual(after.suggestions, [], '当前默认已是目标值，不再重复建议')
    await assert.rejects(() => engine.thermostatApply('band_default:standard'), /不在当前建议清单/)
    await assert.rejects(() => engine.thermostatApply('retrieval_density:5'), /不在当前建议清单/, '不存在引擎侧参数调整路径')

    // 消费链同源验证：默认 hard 抬带、显式 easy 覆盖默认
    await engine.setBandDefault('hard')
    const q = await engine.reviewQueue('数学', '入门')
    assert.ok(Math.abs((q.band ?? 0) - 0.4) < 1e-6, `默认 hard 抬高起点先验（band=${q.band}）`)
    const explicit = await engine.reviewQueue('数学', '入门', undefined, 'easy')
    assert.ok(Math.abs((explicit.band ?? 0) - 0) < 1e-6, '显式选带覆盖默认（学习者选择优先）')
  })
})
