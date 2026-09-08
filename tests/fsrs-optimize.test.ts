import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { defaultParams, FSRS6_PARAM_COUNT, OPTIMIZE_MIN_REVIEWS, sequenceReviews, trainingSequences } from '../src/engine/optimize.ts'
import type { OptimizerImpl, TrainingSequence } from '../src/engine/optimize.ts'
import type { ReviewRec } from '../src/engine/types.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
  '  - id: phys-01',
  '    name: 物理',
  '    root: phys',
  '    enabled: true',
].join('\n')

async function withVault(run: (engine: LearnhubEngine, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-optimize-'))
  try {
    const center = join(root, '学习中心')
    await mkdir(join(center, 'state'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    const engine = new LearnhubEngine({ vault: root })
    await run(engine, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 造一条复习日志（默认真实 auto 源；ts 用日序稳定的 ISO）。 */
function rec(overrides: Partial<ReviewRec> & { day: string; qid: string }): Omit<ReviewRec, 'ts'> & { ts: string } {
  return {
    ts: `${overrides.day}T10:00:00`,
    course: '数学', node: '入门', qid: overrides.qid,
    rating: overrides.rating ?? 3,
    rating_source: overrides.rating_source ?? 'auto',
    elapsed_days: overrides.elapsed_days ?? 0,
    stability_before: overrides.stability_before ?? null,
    difficulty_before: overrides.difficulty_before ?? null,
    r_pred: overrides.r_pred ?? null,
  }
}

/** 40 卡 × 11 次真实推进 = 440 条（≥400 门禁），日期逐次后移。 */
async function seedRealLogs(engine: LearnhubEngine, opts: { total?: number } = {}): Promise<void> {
  const total = opts.total ?? 440
  let written = 0
  for (let card = 0; card < 40 && written < total; card++) {
    for (let push = 0; push < 11 && written < total; push++) {
      const day = `2026-${String(1 + Math.floor(push / 2)).padStart(2, '0')}-${String(1 + (push % 2) * 10 + (card % 5)).padStart(2, '0')}`
      const r = rec({ day, qid: `q${card + 1}` })
      await engine.store.appendReview({ ...r, elapsed_days: push * 2 })
      written++
    }
  }
}

// ---- 纯函数接缝 S27：trainingSequences ----

test('trainingSequences: synthetic 排除、每卡每天取第一条、delta_t 链首条 0', () => {
  const logs: ReviewRec[] = [
    { ...rec({ day: '2026-01-01', qid: 'q1', rating: 3, rating_source: 'synthetic' }), stability_before: null } as ReviewRec,
    rec({ day: '2026-01-02', qid: 'q1', rating: 3 }) as ReviewRec,
    rec({ day: '2026-01-02', qid: 'q1', rating: 1 }) as ReviewRec, // 同日第二条：不计
    rec({ day: '2026-01-06', qid: 'q1', rating: 2, rating_source: 'self' }) as ReviewRec,
    rec({ day: '2026-01-03', qid: 'q2', rating: 1 }) as ReviewRec,
  ]
  const seqs = trainingSequences(logs)
  assert.deepEqual(seqs.map(s => s.key), ['数学/入门/q1', '数学/入门/q2'])
  const q1 = seqs[0]!
  // synthetic 不进序列；同日重复丢弃；delta_t = 0, 4（01-02 → 01-06）
  assert.deepEqual(q1.reviews, [
    { rating: 3, delta_t: 0 },
    { rating: 2, delta_t: 4 },
  ])
  assert.equal(sequenceReviews(seqs), 3)
})

test('trainingSequences: 空日志 → 空序列', () => {
  assert.deepEqual(trainingSequences([]), [])
})

// ---- 门禁与写回（facade + 假优化器）----

function fakeImpl(opts: {
  parameters: number[]
  trainedMetrics?: { logLoss: number; rmseBins: number }
  baselineMetrics?: { logLoss: number; rmseBins: number }
}): OptimizerImpl & { trainedWith: TrainingSequence[] | null } {
  const state: { trainedWith: TrainingSequence[] | null } = { trainedWith: null }
  return {
    get trainedWith() { return state.trainedWith },
    train: async seqs => {
      state.trainedWith = seqs
      return { parameters: opts.parameters, splitEval: opts.trainedMetrics ?? { logLoss: 0.5, rmseBins: 0.2 } }
    },
    evaluate: async params => (params === opts.parameters
      ? opts.trainedMetrics ?? { logLoss: 0.5, rmseBins: 0.2 }
      : opts.baselineMetrics ?? { logLoss: 0.7, rmseBins: 0.3 }),
  }
}

test('优化器：<400 条真实日志 → 不训练不写回，返回原因', async () => {
  await withVault(async engine => {
    await seedRealLogs(engine, { total: OPTIMIZE_MIN_REVIEWS - 1 })
    let trained = 0
    const impl = fakeImpl({ parameters: defaultParams() })
    const spy: OptimizerImpl = { train: async s => { trained++; return impl.train(s) }, evaluate: impl.evaluate }
    const r = await engine.optimizeFsrsParams(spy)
    assert.equal(r.status, 'skipped')
    assert.match(r.reason ?? '', /不足 400 条/)
    assert.equal(trained, 0)
  })
})

test('优化器：评估优于默认参数 → 学习者级一套写回全部启用课程（含元数据）', async () => {
  await withVault(async engine => {
    await seedRealLogs(engine)
    const trained = Array.from({ length: FSRS6_PARAM_COUNT }, (_, i) => 1 + i * 0.1)
    const impl = fakeImpl({ parameters: trained })
    const r = await engine.optimizeFsrsParams(impl)
    assert.equal(r.status, 'written')
    assert.deepEqual(r.written, ['数学', '物理'])
    for (const root of ['math', 'phys']) {
      const doc = JSON.parse(await readFile(engine.paths.fsrsParamsPath(root), 'utf8')) as {
        parameters: number[]
        meta: Record<string, unknown>
      }
      assert.deepEqual(doc.parameters, trained)
      assert.equal(doc.meta.reviews, 440)
      assert.equal(doc.meta.baseline_source, 'default')
      assert.equal(doc.meta.params_version, 'FSRS-6')
      assert.ok(doc.meta.trained_at)
    }
    assert.equal(impl.trainedWith?.length, 40) // 40 张卡的序列进了训练
  })
})

test('优化器：评估劣于现参 → 不写回（现参文件保持不动），返回跳过原因', async () => {
  await withVault(async engine => {
    await seedRealLogs(engine)
    const previous = Array.from({ length: FSRS6_PARAM_COUNT }, (_, i) => 0.5 + i)
    for (const root of ['math', 'phys']) {
      const dir = engine.paths.courseStateDir(root)
      await mkdir(dir, { recursive: true })
      await writeFile(engine.paths.fsrsParamsPath(root), JSON.stringify({ parameters: previous }), 'utf8')
    }
    // 新参评 0.9、基线（现参）评 0.7 → 更差
    const impl = fakeImpl({ parameters: defaultParams(), trainedMetrics: { logLoss: 0.9, rmseBins: 0.3 }, baselineMetrics: { logLoss: 0.7, rmseBins: 0.25 } })
    const before = await readFile(engine.paths.fsrsParamsPath('math'), 'utf8')
    const r = await engine.optimizeFsrsParams(impl)
    assert.equal(r.status, 'skipped')
    assert.match(r.reason ?? '', /未优于现参数/)
    assert.equal(await readFile(engine.paths.fsrsParamsPath('math'), 'utf8'), before)
    assert.equal(r.meta?.baseline_source, 'previous')
  })
})

test('优化器：训练产出长度不是 21 → 拒绝写回', async () => {
  await withVault(async engine => {
    await seedRealLogs(engine)
    const impl = fakeImpl({ parameters: [1, 2, 3] })
    const r = await engine.optimizeFsrsParams(impl)
    assert.equal(r.status, 'skipped')
    assert.match(r.reason ?? '', /不是 FSRS-6 的 21 个/)
  })
})

// ---- binding 真集成（native 依赖冒烟：训练产出 21 参 + 指标形状）----

test('binding 冒烟：真实训练器产出 FSRS-6 参数向量与时序切分指标（或小数据 null）', async () => {
  const { trainAndEvaluate } = await import('../src/engine/optimize.ts')
  const seqs: TrainingSequence[] = Array.from({ length: 40 }, (_, c) => ({
    key: `c${c}`,
    reviews: Array.from({ length: 12 }, (_, i) => ({
      rating: i === 0 ? 3 : ([2, 3, 3, 4, 1, 3, 3, 2, 3, 3][i % 10] as 1 | 2 | 3 | 4),
      delta_t: i === 0 ? 0 : 1 + ((i * 7 + c) % 30),
    })),
  }))
  const { parameters, splitEval } = await trainAndEvaluate(seqs)
  assert.equal(parameters.length, FSRS6_PARAM_COUNT)
  assert.ok(parameters.every(Number.isFinite))
  if (splitEval) {
    assert.ok(Number.isFinite(splitEval.logLoss) && splitEval.logLoss > 0)
    assert.ok(Number.isFinite(splitEval.rmseBins))
  }
})
