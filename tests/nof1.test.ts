import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { ReviewRec } from '../src/engine/types.ts'
import {
  NOF1_TEMPLATES, NOF1_VARIABLE_WHITELIST, NOF1_PER_ARM_MIN,
  shuffleAssign, nof1ArmForDay, interleaveBySource, analyzeNof1, nof1Outcomes, mulberry32,
} from '../src/engine/nof1.ts'
import type { ExperimentDef, Nof1OutcomeRec } from '../src/engine/nof1.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tfQuestion, withVault } from './helpers/vault.ts'
import { addDays } from '../src/engine/dates.ts'

const BATCH_DEF: ExperimentDef = {
  id: 1, template: 'band_default_std_vs_hard', variable: 'band_default',
  title: '难度带默认：标准 vs 挑战', question: '?', outcome: 'true_retention',
  arms: ['standard', 'hard'], arm_labels: { standard: '默认标准带', hard: '默认挑战带' },
  unit: 'batch', scope_course: null,
  assignment: { kind: 'batch', start_day: '2026-09-01', order: ['standard', 'hard'] },
  per_arm_min: 20, started_day: '2026-09-01', started_ts: '2026-09-01T08:00:00',
  status: 'running', proposal: 1,
}

// ---- 纯函数：分臂与交替 ----

test('纯函数：卡级分臂播种确定、臂间均衡、全覆盖', () => {
  const pool = Array.from({ length: 41 }, (_, i) => `数学/入门/q${i}`)
  const a = shuffleAssign(pool, ['x', 'y'], mulberry32(7))
  const b = shuffleAssign(pool, ['x', 'y'], mulberry32(7))
  assert.deepEqual(a, b, '同种子同结果（可复现、可审计）')
  assert.equal(Object.keys(a).length, pool.length, '全部入臂')
  const counts = Object.values(a).reduce<Record<string, number>>((m, arm) => ({ ...m, [arm]: (m[arm] ?? 0) + 1 }), {})
  assert.equal(counts.x, 21, '余数给前臂')
  assert.equal(counts.y, 20)
})

test('纯函数：批次交替按学习日序数轮臂，卡级实验没有批次臂', () => {
  assert.equal(nof1ArmForDay(BATCH_DEF, '2026-09-01'), 'standard')
  assert.equal(nof1ArmForDay(BATCH_DEF, '2026-09-02'), 'hard')
  assert.equal(nof1ArmForDay(BATCH_DEF, '2026-09-03'), 'standard', '隔日回摆')
  assert.equal(nof1ArmForDay(BATCH_DEF, '2026-08-31'), 'standard', '起始日前防御性归第一臂')
  assert.throws(() => nof1ArmForDay({ ...BATCH_DEF, assignment: { kind: 'card', map: {} } }, '2026-09-01'), /卡级分臂/)
})

test('纯函数：混排把非题卡均匀摊进题卡序列，两列各自保序', () => {
  const cards = [
    { id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' },
    { id: 'l1', source: 'learner' }, { id: 'l2', source: 'learner' },
  ]
  const out = interleaveBySource(cards)
  assert.equal(out.length, cards.length)
  assert.equal(out.filter(c => c.id.startsWith('q')).map(c => c.id).join(','), 'q1,q2,q3,q4', '题卡内部保序')
  assert.equal(out.filter(c => c.id.startsWith('l')).map(c => c.id).join(','), 'l1,l2', '我的卡内部保序')
  assert.equal(out.findIndex(c => c.id === 'l1'), 2, '摊入中段而非堆在一端')
  assert.deepEqual(interleaveBySource([{ id: 'q1' }]), [{ id: 'q1' }], '无非题卡原样')
  assert.deepEqual(interleaveBySource([{ id: 'l1', source: 'learner' }]), [{ id: 'l1', source: 'learner' }], '无题卡原样')
})

// ---- 纯函数：统计口径 ----

const rec = (arm: string, pass: boolean): Nof1OutcomeRec => ({ arm, pass })
const bulk = (arm: string, n: number, passes: number): Nof1OutcomeRec[] =>
  Array.from({ length: n }, (_, i) => rec(arm, i < passes))

test('纯函数：大效应——置换检验显著、区间不含零、直白话带个体效应声明', () => {
  const recs = [...bulk('standard', 30, 6), ...bulk('hard', 30, 24)]
  const a = analyzeNof1(recs, BATCH_DEF, 42)
  assert.equal(a.ready, true)
  assert.equal(a.diff, 0.6)
  assert.ok(a.p! < 0.01, `p=${a.p}`)
  assert.ok(a.ci95![0]! > 0, '区间整体在正侧')
  assert.match(a.message, /高 60 个百分点/)
  assert.match(a.message, /个体效应（N-of-1）/)
  assert.match(a.message, /不是人群结论/)
  const b = analyzeNof1(recs, BATCH_DEF, 42)
  assert.deepEqual(a, b, '同种子同报告')
})

test('纯函数：零效应——差异≈0、报告如实说持平；未达观察窗只报进度不给判断', () => {
  const zero = analyzeNof1([...bulk('standard', 30, 15), ...bulk('hard', 30, 15)], BATCH_DEF, 7)
  assert.equal(zero.diff, 0)
  assert.match(zero.message, /基本持平/)
  const interim = analyzeNof1([...bulk('standard', 5, 4), ...bulk('hard', 3, 1)], BATCH_DEF, 7)
  assert.equal(interim.ready, false)
  assert.equal(interim.diff, null, '未达窗不出效应数字')
  assert.match(interim.message, /还在积累数据/)
  assert.match(interim.message, /5\/20/)
})

test('纯函数：结局提取——只取 auto/self 到期首推、按 exp id 归臂、synthetic 与首学不入局', () => {
  const log: ReviewRec[] = [
    { ts: '2026-09-08T10:00:00', course: '数学', node: '入门', qid: 'a1', rating: 3, rating_source: 'auto', elapsed_days: 2, stability_before: 4, difficulty_before: 5, r_pred: 0.8, exp: { id: 1, arm: 'standard' } },
    { ts: '2026-09-08T11:00:00', course: '数学', node: '入门', qid: 'a2', rating: 2, rating_source: 'self', elapsed_days: 1, stability_before: 3, difficulty_before: 5, r_pred: 0.7, exp: { id: 1, arm: 'hard' } },
    { ts: '2026-09-08T12:00:00', course: '数学', node: '入门', qid: 'a3', rating: 3, rating_source: 'synthetic', elapsed_days: 0, stability_before: null, difficulty_before: null, r_pred: null, exp: { id: 1, arm: 'standard' } },
    { ts: '2026-09-08T13:00:00', course: '数学', node: '入门', qid: 'a4', rating: 3, rating_source: 'auto', elapsed_days: 0, stability_before: null, difficulty_before: null, r_pred: 1, exp: { id: 1, arm: 'standard' } },
    { ts: '2026-09-08T14:00:00', course: '数学', node: '入门', qid: 'a5', rating: 1, rating_source: 'auto', elapsed_days: 2, stability_before: 4, difficulty_before: 5, r_pred: 0.8 },
    { ts: '2026-09-08T15:00:00', course: '数学', node: '入门', qid: 'a6', rating: 3, rating_source: 'auto', elapsed_days: 2, stability_before: 4, difficulty_before: 5, r_pred: 0.8, exp: { id: 2, arm: 'standard' } },
    { ts: '2026-09-08T16:00:00', course: '数学', node: '入门', qid: 'a1', rating: 1, rating_source: 'auto', elapsed_days: 1, stability_before: 4, difficulty_before: 5, r_pred: 0.8, exp: { id: 1, arm: 'standard' } },
  ]
  const out = nof1Outcomes(log, 1)
  assert.deepEqual(out, [
    { arm: 'standard', pass: true },
    { arm: 'hard', pass: true },
  ], 'synthetic/首学/无标注/他实验排除；同卡同日只取第一次')
})

test('纯函数：白名单与模板库口径——调度核心不入白名单，v1 只解锁已上线参数', () => {
  assert.deepEqual([...NOF1_VARIABLE_WHITELIST], [
    'band_default', 'session_composition', 'ps_i_order', 'retrieval_point', 'ci_orchestration',
  ])
  for (const bad of ['fsrs_weights', 'desired_retention', 'advance_gate', 'xp_rates']) {
    assert.ok(!NOF1_VARIABLE_WHITELIST.includes(bad as never), `调度核心参数 ${bad} 不在白名单`)
  }
  for (const t of NOF1_TEMPLATES) {
    assert.ok(NOF1_VARIABLE_WHITELIST.includes(t.variable), `模板 ${t.id} 的变量必须在白名单`)
  }
  assert.deepEqual(
    NOF1_TEMPLATES.filter(t => t.unlocked).map(t => t.variable).sort(),
    ['band_default', 'session_composition'],
    'v1 模板只收已上线参数（难度带默认、会话组成）',
  )
  assert.equal(NOF1_PER_ARM_MIN, 20)
})

// ---- 行为：提案-确认制全链路 ----

test('全链路：模板发起→确认→分臂→推进带臂标注→报告；白名单外/未解锁 fail loud', async () => {
  await withVault({
    banks: {
      入门: [
        tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } }),
        tfQuestion('a2'),
      ],
    },
  }, async ({ engine }) => {
    // 白名单外参数结构上无法配置：propose 只收模板 id
    await assert.rejects(() => engine.lab.experimentPropose('fsrs_weights'), /白名单外|没有模板/)
    await assert.rejects(() => engine.lab.experimentPropose('ps_i_order'), /未解锁/, '锁定模板可见不可发起')

    const prop = await engine.lab.experimentPropose('band_default_std_vs_hard')
    assert.ok(prop.proposal >= 1)
    assert.equal(prop.pool, 1, '池 = 已调度未归档题卡（a1 已调度、a2 未调度）')
    const props = await engine.store.loadProposals()
    assert.equal(props.at(-1)?.kind, 'experiment', '提案走统一提案存储')
    assert.equal(props.at(-1)?.status, 'pending')

    // 二连提案拒绝：v1 单实验（apply 前看 pending 也拦——running 判定在 apply，
    // 但 propose 不挡 pending：两个 pending 可并存，确认时才互斥）
    const started = await engine.graph.proposalApply('experiment', prop.proposal)
    assert.equal(started.arm_today, 'standard', '开跑日 = 批次第一臂')

    const list = await engine.store.loadExperiments()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.status, 'running')
    assert.equal(list[0]!.assignment.kind, 'batch')
    assert.deepEqual(list[0]!.assignment.order, ['standard', 'hard'])

    // 在跑时再开一个：propose 直接拦（v1 单实验）；apply 无 pending 报提案错误
    await assert.rejects(() => engine.lab.experimentPropose('session_composition_facet_vs_mixed'), /还在跑/)
    await assert.rejects(() => engine.lab.experimentApply(), /没有 pending/)

    // 推进一张卡 → 复习日志带臂标注；报告未达窗只报进度
    await engine.content2.questionAnswer(async () => JSON.stringify({ score: 1, feedback: '' }), '数学', '入门', 'a1', 'true', 30)
    const recs = await engine.store.reviewLogAll()
    assert.equal(recs.length, 1)
    assert.deepEqual(recs[0]!.exp, { id: 1, arm: 'standard' }, '臂标注进复习日志')

    const report = await engine.lab.experimentReport()
    assert.equal(report.experiment.id, 1)
    assert.equal(report.analysis.ready, false)
    assert.match(report.analysis.message, /还在积累数据/)
    assert.equal(report.analysis.per_arm[0]!.n, 1, '刚才那次推进计入了今日臂')

    // 停止后报告定稿、标注停
    const stopped = await engine.lab.experimentStop()
    assert.equal(stopped.status, 'stopped')
    assert.ok(stopped.stopped_day)
    await assert.rejects(() => engine.lab.experimentStop(), /没有可停的实验/)
  })
})

// ---- #150 结局落沉淀正典：停 = 定稿 ----

test('#150 结局落沉淀：停=定稿——结局分析出生即写 nof1_outcome 正典、档案投影重建；同 id 不重复追加', async () => {
  await withVault({
    banks: {
      入门: [
        tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } }),
      ],
    },
  }, async ({ engine, paths }) => {
    const prop = await engine.lab.experimentPropose('band_default_std_vs_hard')
    await engine.graph.proposalApply('experiment', prop.proposal)
    // 一次真实推进（臂标注在案）→ 未达观察窗就停：正典如实落进度态，不造假结论
    await engine.content2.questionAnswer(async () => JSON.stringify({ score: 1, feedback: '' }), '数学', '入门', 'a1', 'true', 30)

    const stopped = await engine.lab.experimentStop()
    assert.equal(stopped.status, 'stopped')

    const fold = await engine.sched2.sedimentFold()
    const events = fold.events.filter(e => e.kind === 'nof1_outcome')
    assert.equal(events.length, 1, '结局事件恰一条（出生即写）')
    assert.equal(events[0]!.tier, 'immediate', '点结论 = 最新态语义')
    const payload = events[0]!.payload as Record<string, unknown>
    assert.equal(payload.experiment, stopped.id)
    assert.equal(payload.variable, 'band_default')
    assert.equal(payload.template, 'band_default_std_vs_hard')
    assert.deepEqual(payload.arms, ['standard', 'hard'])
    assert.equal(payload.outcome, 'true_retention')
    assert.equal(payload.ready, false, '未达观察窗如实落 ready=false')
    assert.ok(String(payload.message).includes('还在积累数据'))
    assert.deepEqual(payload.per_arm, [
      { arm: 'standard', label: '默认标准带', n: 1, rate: 1 },
      { arm: 'hard', label: '默认挑战带', n: 0, rate: 0 },
    ], '臂级读数随事件留痕')

    // 学习者档案投影重建：第七类标题与结局载荷可见
    const profile = await readFile(join(paths.sedimentDir, '学习者档案.md'), 'utf8')
    assert.match(profile, /## 实验结局（N-of-1）/)
    assert.match(profile, /"experiment":1/)

    // 幂等护栏：同实验 id 已有结局事件则不重复追加（停标志丢失后重停的收敛路径）
    const list = await engine.store.loadExperiments()
    list[0]!.status = 'running'
    await engine.store.saveExperiments(list)
    await engine.lab.experimentStop()
    const fold2 = await engine.sched2.sedimentFold()
    assert.equal(fold2.events.filter(e => e.kind === 'nof1_outcome').length, 1, '同 id 结局事件不重复')
  })
})

test('实验不改推进语义：同流程在有/无实验两 vault 间账本一致（只多 exp 标注）', async () => {
  const stripTs = (jsonl: string): string =>
    jsonl.trim() ? jsonl.trim().split('\n').map(l => {
      const { ts: _t, ...rest } = JSON.parse(l) as Record<string, unknown>
      return JSON.stringify(rest)
    }).join('\n') : ''
  const flow = async (engine: import('../src/engine/index.ts').LearnhubEngine) => {
    await engine.content2.questionAnswer(async () => JSON.stringify({ score: 1, feedback: '' }), '数学', '入门', 'a1', 'true', 30)
    await engine.content2.questionForget('数学', '入门', 'a2', 8)
    const note = readFileSync(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    const practice = stripTs(existsSync(engine.paths.practicePath) ? readFileSync(engine.paths.practicePath, 'utf8') : '')
    const journal = stripTs(existsSync(engine.paths.journalPath) ? readFileSync(engine.paths.journalPath, 'utf8') : '')
    const rlog = readFileSync(engine.paths.reviewLogPath, 'utf8').trim().split('\n').map(l => JSON.parse(l) as ReviewRec)
    return { note, practice, journal, rlog }
  }
  const BANKS = { 入门: [tfQuestion('a1'), tfQuestion('a2', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } })] }
  const SEED = { notes: { 入门: { stage: 'review' } }, banks: BANKS }
  const base = await withVault(SEED, async ({ engine }) => flow(engine))
  await withVault(SEED, async ({ engine }) => {
    const prop = await engine.lab.experimentPropose('band_default_std_vs_hard')
    await engine.lab.experimentApply(prop.proposal)
    const got = await flow(engine)
    assert.equal(got.note, base.note, '课程笔记（调度事实源）零改动')
    assert.equal(got.practice, base.practice, '作答流水零改动')
    assert.equal(got.journal, base.journal, 'journal/账本零改动')
    assert.equal(got.rlog.length, base.rlog.length, '推进次数一致——实验只重排条件，不新增推进')
    got.rlog.forEach((r, i) => {
      const b = base.rlog[i]!
      const { exp: _e, ts: _t, ...rest } = r
      const { exp: _b, ts: _tb, ...restB } = b
      assert.deepEqual(rest, restB, '日志条目除 exp 标注与时间戳外逐字段一致')
    })
    assert.ok(got.rlog.some(r => r.exp), '实验下推进带臂标注')
  })
})

test('批次生效：band_default 实验决定未显式选带时的会话默认带；显式选择优先', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } })] },
    notes: { 入门: { stage: 'review', fsrs: null } },
  }, async ({ engine }) => {
    const plain = await engine.content2.reviewQueue('数学', '入门')
    assert.ok(Math.abs((plain.band ?? 0) - 0.2) < 1e-6, '无实验：Mastery 0 先验带 0.2')

    const prop = await engine.lab.experimentPropose('band_default_std_vs_hard')
    await engine.lab.experimentApply(prop.proposal)
    // 批次起点拨回昨天 → 今日轮到第二臂（hard）；起点必须从引擎学习日现推，
    // 硬编码日期会让臂序随真实日历奇偶隔天翻面
    const today = (await engine.content2.reviewQueue('数学', '入门')).date
    const list = await engine.store.loadExperiments()
    list[0]!.assignment = { kind: 'batch', start_day: addDays(today, -1)!, order: ['standard', 'hard'] }
    await engine.store.saveExperiments(list)
    const q = await engine.content2.reviewQueue('数学', '入门')
    assert.equal(nof1ArmForDay(list[0]!, today), 'hard')
    assert.ok(Math.abs((q.band ?? 0) - 0.4) < 1e-6, `实验默认挑战带生效（band=${q.band}）`)
    const explicit = await engine.content2.reviewQueue('数学', '入门', undefined, 'easy')
    assert.ok(Math.abs((explicit.band ?? 0) - 0) < 1e-6, '显式选带覆盖实验默认（学习者选择优先）')
  })
})

test('会组成实验：混排臂在全局队列带出 exp 标注；报告从预置日志出定稿结论', async () => {
  const seeded = [
    ...Array.from({ length: 20 }, (_, i) => JSON.stringify({
      ts: `2026-09-0${(i % 8) + 1}T10:00:00`, course: '数学', node: '入门', qid: `f${i}`,
      rating: i < 15 ? 3 : 1, rating_source: 'auto', elapsed_days: 2,
      stability_before: 4, difficulty_before: 5, r_pred: 0.8, exp: { id: 1, arm: 'faceted' },
    })),
    ...Array.from({ length: 20 }, (_, i) => JSON.stringify({
      ts: `2026-09-0${(i % 8) + 1}T11:00:00`, course: '数学', node: '入门', qid: `m${i}`,
      rating: i < 5 ? 3 : 1, rating_source: 'auto', elapsed_days: 2,
      stability_before: 4, difficulty_before: 5, r_pred: 0.8, exp: { id: 1, arm: 'mixed' },
    })),
  ]
  await withVault({
    banks: { 入门: [tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: '2024-01-01', last_review: '2024-01-01', reps: 3, lapses: 0 } })] },
    reviewLog: seeded,
  }, async ({ engine }) => {
    const prop = await engine.lab.experimentPropose('session_composition_facet_vs_mixed')
    await engine.lab.experimentApply(prop.proposal)
    const today = (await engine.content2.reviewQueue()).date
    const list = await engine.store.loadExperiments()
    list[0]!.assignment = { kind: 'batch', start_day: addDays(today, -1)!, order: ['faceted', 'mixed'] }
    await engine.store.saveExperiments(list)
    const q = await engine.content2.reviewQueue()
    assert.deepEqual(q.exp, { id: 1, arm: 'mixed' }, '队列如实标注当日实验臂')

    const report = await engine.lab.experimentReport()
    assert.equal(report.analysis.ready, true, '每臂 20 次推进达观察窗')
    assert.equal(report.analysis.diff, -0.5, 'mixed 臂 0.25 − faceted 臂 0.75')
    assert.match(report.analysis.message, /低 50 个百分点/)
  })
})

test('存储契约：实验文件条目不满足定义形状 → Broken 报出不静默；练习侧结局登记后报告如实说未解锁', async () => {
  await withVault({}, async ({ engine }) => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(engine.paths.centerStateDir, { recursive: true })
    await writeFile(engine.paths.experimentsPath, JSON.stringify([{ id: 'oops' }]), 'utf8')
    await assert.rejects(() => engine.lab.experimentList(), /不满足实验定义契约|Broken/, '形状损坏不是合法空态')

    // 练习侧结局（EMA）：预登记在案，分析器未实现——报告不假装能算
    await writeFile(engine.paths.experimentsPath, JSON.stringify([{
      ...BATCH_DEF, outcome: 'practice_ema', status: 'stopped', stopped_day: '2026-09-09',
    }]), 'utf8')
    const report = await engine.lab.experimentReport(1)
    assert.equal(report.experiment.outcome, 'practice_ema')
    assert.equal(report.analysis.ready, false)
    assert.match(report.analysis.message, /练习侧结局（EMA）|#88\/#89/)
  })
})
