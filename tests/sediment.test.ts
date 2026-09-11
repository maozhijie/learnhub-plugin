/**
 * 沉淀层（#139 / ADR-0034）：第四存储域的追加正典、读侧折叠与档案投影。
 *
 * - 纯函数面：折叠确定性（两次折叠同输入同输出）、latest/weekly/byConcept 三读法、
 *   投影渲染稳定。
 * - 写侧：出生即写入口的校验、legacy 分区随首写落盘且零消费路径（正典折叠永不读它）。
 * - FSRS 参数正典化：优化即结算（正典事件 + 缓存镜像 + 投影重建）；删缓存后
 *   getScheduler 从沉淀取回（删缓存不丢事实）。
 * - 断裂不变性：清空内容层后，合成初始化仍取到沉淀先验（先验连续、实例记忆不连续）。
 * - 重置波及面单独确认项：contentReset / courseDelete 显式带沉淀层不受影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fsrs, generatorParameters } from 'ts-fsrs'
import { foldSediment, readSedimentCanon, renderLearnerProfile, latestFsrsParams } from '../src/engine/sediment.ts'
import type { SedimentEvent } from '../src/engine/sediment.ts'
import { getScheduler, previewDue } from '../src/engine/srs.ts'
import { DESIRED_RETENTION } from '../src/engine/params.ts'
import { defaultParams, FSRS6_PARAM_COUNT, OPTIMIZE_MIN_REVIEWS } from '../src/engine/optimize.ts'
import type { OptimizerImpl, TrainingSequence } from '../src/engine/optimize.ts'
import { prevWeekStartOf } from '../src/engine/kata.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { localDay, tfQuestion, withVault } from './helpers/vault.ts'

// ---- 折叠（纯函数：同输入同输出） ----

const EVENTS: SedimentEvent[] = [
  { ts: '2026-09-01T10:00:00', kind: 'fsrs_params', tier: 'immediate', payload: { parameters: [1, 2] } },
  { ts: '2026-09-08T10:00:00', kind: 'fsrs_params', tier: 'immediate', payload: { parameters: [3, 4] } },
  { ts: '2026-09-09T10:00:00', kind: 'recheck_outcome', tier: 'immediate', payload: { outcome: 'proven' }, concept: '概率' },
  { ts: '2026-09-02T10:00:00', kind: 'calibration', tier: 'weekly', payload: { pairs: 3 } },
  { ts: '2026-09-03T10:00:00', kind: 'calibration', tier: 'weekly', payload: { pairs: 5 } },
]

/** 测试内联的周一折叠（与 kata.weekStartOf 同口径，避免循环断言）。 */
function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  const shift = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - shift * 86400000).toISOString().slice(0, 10)
}

test('折叠确定性：两次折叠同输入同输出；events 稳定升序', () => {
  const a = foldSediment(EVENTS)
  const b = foldSediment([...EVENTS].reverse()) // 同一集合不同追加序 → 同一折叠
  assert.deepEqual(a, b)
  assert.deepEqual(a.events.map(e => e.ts), [...a.events.map(e => e.ts)].sort())
})

test('#150 第七类 nof1_outcome：合法 kind 进折叠与档案投影（「实验结局（N-of-1）」标题）', () => {
  const fold = foldSediment([
    { ts: '2026-09-10T10:00:00', kind: 'nof1_outcome', tier: 'immediate', payload: { experiment: 1, ready: true, diff: 0.12 } },
  ])
  assert.equal(fold.counts.nof1_outcome, 1)
  assert.equal(fold.latest.nof1_outcome?.payload.experiment, 1)
  const profile = renderLearnerProfile(fold, Date.now())
  assert.ok(profile.includes('## 实验结局（N-of-1）'))
  assert.ok(profile.includes('"experiment":1'))
})

test('折叠三读法：latest 最新态 / weekly 按学习周分组 / byConcept 概念地址寻址', () => {
  const fold = foldSediment(EVENTS)
  assert.deepEqual(fold.latest.fsrs_params?.payload.parameters, [3, 4], 'immediate = 最新态')
  assert.equal(fold.counts.fsrs_params, 2)
  assert.equal(fold.weekly.calibration?.length, 1, '同一学习周并桶')
  assert.equal(fold.weekly.calibration?.[0]?.week, weekOf('2026-09-02'))
  assert.equal(fold.weekly.calibration?.[0]?.events.length, 2)
  assert.equal(fold.byConcept.recheck_outcome?.['概率']?.payload.outcome, 'proven')
})

// ---- 写侧：出生即写入口 + legacy 分区 ----

test('追加写：kind/tier/payload 校验 fail loud；正典落 jsonl；legacy 分区随首写落盘', async () => {
  await withVault({}, async ({ engine }) => {
    await assert.rejects(engine.sedimentAppend('bogus' as never, 'immediate', {}), /非法 kind/)
    await assert.rejects(engine.sedimentAppend('calibration', 'daily' as never, {}), /非法 tier/)
    await assert.rejects(engine.sedimentAppend('calibration', 'weekly', 'nope' as never), /payload/)
    await engine.sedimentAppend('fsrs_params', 'immediate', { parameters: [1, 2, 3] }, ' 概率 ')
    const canon = await readSedimentCanon(engine.paths)
    assert.equal(canon.length, 1)
    assert.equal(canon[0]!.concept, '概率', '概念地址 trim 后落盘')
    assert.ok(existsSync(engine.paths.sedimentLegacyDir), 'legacy 分区存在性保证')
  })
})

test('legacy 零消费路径：legacy/ 里的事件永不进折叠', async () => {
  await withVault({}, async ({ engine }) => {
    await engine.sedimentAppend('fsrs_params', 'immediate', { parameters: [1, 2, 3] })
    await mkdir(engine.paths.sedimentLegacyDir, { recursive: true })
    const legacyLine = JSON.stringify({ ts: '2020-01-01T00:00:00', kind: 'fsrs_params', tier: 'immediate', payload: { parameters: [9, 9, 9] } })
    await writeFile(join(engine.paths.sedimentLegacyDir, '史前.jsonl'), legacyLine + '\n', 'utf8')
    const canon = await readSedimentCanon(engine.paths)
    assert.equal(canon.length, 1, '读正典不读 legacy')
    assert.deepEqual(await latestFsrsParams(engine.paths), [1, 2, 3])
  })
})

// ---- FSRS 参数正典化：优化即结算，缓存降级 ----

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

function rec(ts: string, qid: string) {
  return { ts, course: '数学', node: '入门', qid, rating: 3, rating_source: 'auto' as const, elapsed_days: 0 }
}

/** 440 条真实推进（≥400 门禁）。 */
async function seedRealLogs(engine: LearnhubEngine): Promise<void> {
  let written = 0
  for (let card = 0; card < 40 && written < OPTIMIZE_MIN_REVIEWS; card++) {
    for (let push = 0; push < 11 && written < OPTIMIZE_MIN_REVIEWS; push++) {
      const day = `2026-${String(1 + Math.floor(push / 2)).padStart(2, '0')}-${String(1 + (push % 2) * 10 + (card % 5)).padStart(2, '0')}`
      await engine.store.appendReview({ ...rec(`${day}T10:00:00`, `q${card + 1}`), elapsed_days: push * 2 })
      written++
    }
  }
}

function fakeImpl(parameters: number[]): OptimizerImpl & { trainedWith: TrainingSequence[] | null } {
  const state: { trainedWith: TrainingSequence[] | null } = { trainedWith: null }
  return {
    get trainedWith() { return state.trainedWith },
    train: async seqs => {
      state.trainedWith = seqs
      return { parameters, splitEval: { logLoss: 0.1, rmseBins: 0.1 } }
    },
    evaluate: async params => (params === parameters ? { logLoss: 0.1, rmseBins: 0.1 } : { logLoss: 0.7, rmseBins: 0.3 }),
  }
}

const TRAINED = Array.from({ length: FSRS6_PARAM_COUNT }, (_, i) => 1.5 + i * 0.01)

function schedWith(w: number[]) {
  return fsrs(generatorParameters({ request_retention: DESIRED_RETENTION, enable_fuzz: false, enable_short_term: false, w }))
}

test('FSRS 正典化：优化写沉淀正典 + 缓存镜像 + 档案投影；删缓存后 getScheduler 从沉淀取回', async () => {
  await withVault({ registry: REGISTRY, graph: null }, async ({ engine }) => {
    await seedRealLogs(engine)
    const trained2 = TRAINED.map(x => x + 0.005)
    const r1 = await engine.optimizeFsrsParams(fakeImpl(TRAINED))
    assert.equal(r1.status, 'written')
    assert.equal(r1.meta?.baseline_source, 'default', '首训无沉淀无缓存：基线 = 默认')
    // 二训：沉淀已有正典 → 基线取沉淀（先验连续的证据链）
    const r = await engine.optimizeFsrsParams(fakeImpl(trained2))
    assert.equal(r.status, 'written')
    assert.equal(r.meta?.baseline_source, 'sediment')

    // 正典事件在沉淀（含 meta 可追溯）
    const fold = await engine.sedimentFold()
    assert.equal(fold.counts.fsrs_params, 2)
    assert.deepEqual(await latestFsrsParams(engine.paths), trained2)

    // 投影随结算重建
    const profile = await readFile(engine.paths.learnerProfilePath, 'utf8')
    assert.match(profile, /# 学习者档案/)
    assert.match(profile, /FSRS 参数/)

    // 删缓存不丢事实：getScheduler 落沉淀取回同一套参数
    await rm(engine.paths.fsrsParamsPath('math'))
    const today = localDay()
    const sched = await getScheduler(engine.paths, 'math')
    assert.equal(previewDue(sched, null, 3, today), previewDue(schedWith(trained2), null, 3, today), '与显式用沉淀参数构造的调度器同推演')
    assert.notEqual(previewDue(sched, null, 3, today), previewDue(schedWith(defaultParams()), null, 3, today), '确实不是默认参数')
  })
})

test('断裂不变性：清空内容层后合成初始化仍取到沉淀先验（先验连续，实例记忆不连续）', async () => {
  await withVault({
    registry: REGISTRY,
    notes: { 入门: {} },
    banks: { 入门: [tfQuestion('q1', {})] },
  }, async ({ engine, root }) => {
    // ① 先练出先验：优化一次（正典在沉淀）
    await seedRealLogs(engine)
    const r = await engine.optimizeFsrsParams(fakeImpl(TRAINED))
    assert.equal(r.status, 'written')
    // ② 断裂：课程树整树清空（内容层 + 卡级实例记忆 + 参数缓存全灭），注册表清空
    await rm(join(root, '学习中心', 'math'), { recursive: true, force: true })
    await writeFile(engine.paths.registryPath, 'courses: []\n', 'utf8')
    // ③ 新课程重生（同 root 新骨架：注册表 + 图 + ready 笔记 + 新题库，与旧卡零共享）
    await writeFile(engine.paths.registryPath, [
      'courses:',
      '  - id: math-01',
      '    name: 数学',
      '    root: math',
      '    enabled: true',
    ].join('\n') + '\n', 'utf8')
    const course = join(root, '学习中心', 'math')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    const graph = [
      'region: 基础',
      'color: blue',
      'blocks:',
      '  - name: 入门块',
      '    nodes:',
      '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
    ].join('\n') + '\n'
    await writeFile(join(course, 'data', '基础.yaml'), graph, 'utf8')
    const note = [
      '---',
      'node: 入门',
      'stage: ready',
      'fsrs: null',
      'content:',
      '  version: 0',
      '  generated_at: null',
      '  status: draft',
      'practice:',
      '  attempts: 0',
      '  correct: 0',
      '---',
      '',
      '# 入门',
    ].join('\n') + '\n'
    await writeFile(join(course, '课程', '基础', '入门.md'), note, 'utf8')
    const bank = ['node: 入门', 'questions:', ...tfQuestion('q1', {})].join('\n') + '\n'
    await writeFile(join(course, '题库', '入门.yaml'), bank, 'utf8')
    // ④ 合成初始化：先验从沉淀折叠取回，不因内容层清空回落默认
    const done = await engine.nodeComplete('数学', '入门', true)
    assert.equal(done.accepted, true)
    assert.equal(done.initialized, 1)
    const due = done.due
    assert.ok(due)
    const today = localDay()
    assert.equal(due, previewDue(schedWith(TRAINED), null, 3, today), '合成首复习按沉淀先验推进')
    assert.notEqual(due, previewDue(schedWith(defaultParams()), null, 3, today), '不是默认参数（先验确实来自沉淀）')
  })
})

// ---- 档案投影：手编必被覆盖 ----

test('学习者档案：纯派生投影，手编被重建覆盖', async () => {
  await withVault({}, async ({ engine }) => {
    await engine.sedimentAppend('calibration', 'weekly', { week: '2026-09-01', pairs: 2 })
    const md1 = await engine.sedimentRebuildProfile()
    assert.match(md1, /校准画像/)
    const fold = await engine.sedimentFold()
    assert.equal(md1, renderLearnerProfile(fold, Date.now()), '投影 = 折叠的纯渲染')

    await writeFile(engine.paths.learnerProfilePath, '手编内容', 'utf8')
    const md2 = await engine.sedimentRebuildProfile()
    assert.equal(md2, md1, '重建覆盖手编')
  })
})

// ---- 结算：周档出生即写 ----

test('sedimentSettle：上一完整学习周的校准与速度韧性出生即写，投影随之重建', async () => {
  await withVault({}, async ({ engine }) => {
    const week = prevWeekStartOf(localDay())
    assert.ok(week)
    // 上周作答：带 JOL 预测（校准配对）与耗时（速度）
    await engine.store.appendPractice({
      ts: `${week}T10:00:00`, course: '数学', node: '入门', ex: 'q', answer: 'a',
      correct: true, judge: 'quiz', predicted: '会', elapsed_s: 25,
    })
    await engine.store.appendPractice({
      ts: `${week}T11:00:00`, course: '数学', node: '入门', ex: 'q', answer: 'b',
      correct: false, judge: 'quiz', predicted: '不会', elapsed_s: 40,
    })
    const r = await engine.sedimentSettle()
    assert.deepEqual(r.wrote.sort(), ['calibration', 'speed_resilience'])
    const fold = await engine.sedimentFold()
    assert.equal(fold.weekly.calibration?.[0]?.week, weekOf(week))
    const speed = fold.weekly.speed_resilience?.[0]?.events[0]?.payload as { median_elapsed_s?: number }
    assert.equal(speed.median_elapsed_s, 32.5)
    assert.match(r.profile, /速度韧性/)

    // 同周幂等：重复结算不重写正典（kataOpen 每次打开都会触发结算）
    const before = (await engine.sedimentFold()).counts
    const r2 = await engine.sedimentSettle()
    assert.deepEqual(r2.wrote, [])
    assert.ok(r2.skipped.every(x => /已结算/.test(x.reason)))
    const after = await engine.sedimentFold()
    assert.deepEqual(after.counts, before)
  })
})

// ---- 重置波及面单独确认项 ----

test('重置与删课：沉淀层波及作为单独确认项显式返回（永不自动删除）', async () => {
  await withVault({ notes: { 入门: {} }, banks: { 入门: [tfQuestion('q1', {})] } }, async ({ engine }) => {
    await engine.sedimentAppend('fsrs_params', 'immediate', { parameters: [1] })
    const reset = await engine.contentReset('数学')
    assert.match(reset.sediment, /沉淀层不受影响/)
    const fold1 = await engine.sedimentFold()
    assert.equal(fold1.counts.fsrs_params, 1, '重置不伤沉淀')

    const del = await engine.courseDelete('数学')
    assert.match(del.sediment, /沉淀层不受影响|存活/)
    const fold2 = await engine.sedimentFold()
    assert.equal(fold2.counts.fsrs_params, 1, '删课不伤沉淀')
  })
})
