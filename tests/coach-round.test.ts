import test from 'node:test'
import assert from 'node:assert/strict'
import {
  behaviorWindow, behaviorDigest, renderBehaviorDigest,
  readyDepthCheck, renderSedimentForCoach,
  COACH_LOOKAHEAD_DEFAULT, COACH_LOOKAHEAD_MIN, COACH_LOOKAHEAD_MAX,
  COACH_COLD_START_DAYS, COACH_COLD_START_EST_MULT,
} from '../src/engine/coach/coach-round.ts'
import type { DigestInput } from '../src/engine/coach/coach-round.ts'
import type { SandboxCard, SandboxNode } from '../src/engine/sched/sandbox.ts'
import { foldSediment, renderLearnerProfile } from '../src/engine/sched/sediment.ts'
import type { PracticeRec, ReviewRec, SedimentEvent } from '../src/engine/types.ts'

// 教练回合感知面（#144）纯函数层：行为摘要五件套（读侧折叠、同输入同输出）、
// 就绪深度检查（默认 3 / clamp [2,5] / 冷启动首周 ×1.5 / ready=0 只告警）、
// 沉淀折叠的教练投影。全部注入式构造——确定性期望值。

const TODAY = '2026-09-10'

const pr = (ts: string, node: string, correct: boolean | null, opts: Partial<PracticeRec> = {}): PracticeRec => ({
  ts, course: '数学', node, ex: 1, answer: 'x', correct, judge: 'true_false', ...opts,
})

const rr = (ts: string, qid: string, rating: 1 | 2 | 3 | 4, opts: Partial<ReviewRec> = {}): ReviewRec => ({
  ts, course: '数学', node: '入门', qid, rating,
  rating_source: 'auto', elapsed_days: 1,
  stability_before: 1.0, difficulty_before: 5.0, r_pred: 0.9, ...opts,
})

const digestOf = (over: Partial<DigestInput> & { practice?: PracticeRec[] }): ReturnType<typeof behaviorDigest> =>
  behaviorDigest({
    course: '数学', practice: [], reviews: [],
    invokesOf: () => null, estOf: {}, misconceptionsOf: {}, masteryOf: {},
    today: TODAY, cutoffMin: 0, ...over,
  })

// ---- 窗口：最近 7 学习日或 10 节取大 ----

test('窗口：7 学习日内已有 ≥10 节 → 取 7 日基窗，窗外与未来日排除', () => {
  const recs: PracticeRec[] = []
  const nodes = 'ABCDEFGHIJKLMNOPQR'
  // 09-04..09-10 每天 2 节（14 节 ≥ 10）；更早的 09-01 与未来的 09-11 都不入窗
  for (let i = 0; i < 7; i++) {
    const day = new Date(Date.UTC(2026, 8, 4 + i)).toISOString().slice(0, 10) + 'T10:00:00'
    recs.push(pr(day, nodes[i]!, true), pr(day, nodes[7 + i]!, true))
  }
  recs.push(pr('2026-09-01T10:00:00', 'Z', true), pr('2026-09-11T10:00:00', 'Y', true))
  const w = behaviorWindow(recs, TODAY)
  assert.equal(w.days.length, 7)
  assert.deepEqual([w.days[0], w.days.at(-1)], ['2026-09-04', TODAY])
  assert.equal(w.nodes.length, 14)
  assert.ok(!w.nodes.includes('Z') && !w.nodes.includes('Y'))
  assert.equal(w.extended, false)
})

test('窗口：7 日内不足 10 节 → 逐日外扩凑满 10 节（extended 标记）', () => {
  const recs: PracticeRec[] = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(2026, 8, 10 - i))
    recs.push(pr(d.toISOString().slice(0, 10) + 'T10:00:00', `节点${i + 1}`, true))
  }
  const w = behaviorWindow(recs, TODAY)
  // 基窗 7 日只有 7 节 → 外扩到 10 节（09-01..09-10）
  assert.equal(w.nodes.length, 10)
  assert.equal(w.days.length, 10)
  assert.deepEqual([w.days[0], w.days.at(-1)], ['2026-09-01', TODAY])
  assert.equal(w.extended, true)
})

test('窗口：空流水 = 空窗（合法空态）', () => {
  assert.deepEqual(behaviorWindow([], TODAY), { days: [], nodes: [], extended: false })
})

// ---- 五件套①掌握轨迹 ----

test('掌握轨迹：逐日正确率、前后半趋势、活跃节点掌握度', () => {
  const d = digestOf({
    practice: [
      pr('2026-09-08T10:00:00', '入门', true),
      pr('2026-09-08T11:00:00', '入门', true),
      pr('2026-09-09T10:00:00', '入门', false),
      pr('2026-09-09T11:00:00', '入门', false),
    ],
    masteryOf: { 入门: 0.42 },
  })
  assert.deepEqual(d.trajectory.days, [
    { day: '2026-09-08', attempts: 2, accuracy: 1 },
    { day: '2026-09-09', attempts: 2, accuracy: 0 },
  ])
  assert.equal(d.trajectory.trend, 'down')
  assert.deepEqual(d.trajectory.mastery, [{ node: '入门', mastery: 0.42 }])
})

test('掌握轨迹：不足 2 个有作答日不置趋势；±0.05 内为平', () => {
  const one = digestOf({ practice: [pr('2026-09-09T10:00:00', '入门', true)] })
  assert.equal(one.trajectory.trend, null)
  const flat = digestOf({
    practice: [
      pr('2026-09-08T10:00:00', '入门', true),
      pr('2026-09-08T11:00:00', '入门', true),
      pr('2026-09-09T10:00:00', '入门', true),
      pr('2026-09-09T11:00:00', '入门', true),
    ],
  })
  assert.equal(flat.trajectory.trend, 'flat')
})

// ---- 五件套②卡点集中度（invokes 聚合 + 停滞天数） ----

test('卡点集中度：错误按 invokes 概念聚合、未标注落 null 桶、停滞天数按最近答对折算', () => {
  const d = digestOf({
    practice: [
      pr('2026-09-06T10:00:00', '入门', true), // 最近答对 09-06 → 停滞 4 天
      pr('2026-09-08T10:00:00', '入门', false, { qid: 'q1' }), // invokes 极限
      pr('2026-09-09T10:00:00', '进阶', false, { qid: 'q2' }), // invokes 极限
      pr('2026-09-09T11:00:00', '进阶', false), // 无 qid → 未标注
    ],
    invokesOf: qid => (qid === 'q1' || qid === 'q2' ? '极限' : null),
  })
  assert.equal(d.blockers.errors, 3)
  assert.deepEqual(d.blockers.by_concept, [{ concept: '极限', count: 2 }, { concept: null, count: 1 }])
  assert.equal(d.blockers.concentration, 0.6667)
  assert.deepEqual(d.blockers.stalls, [
    { node: '入门', days: 4, last_correct: '2026-09-06' },
    { node: '进阶', days: 1, last_correct: null }, // 从未答对 → 自首次作答（窗口内唯一错误日）起 1 天
  ])
})

// ---- 五件套③速度校准（est vs 实际 + JOL 过信率） ----

test('速度校准：窗口实际耗时 ÷ 触达节点 est 预算；JOL「会」档过信率', () => {
  const d = digestOf({
    practice: [
      pr('2026-09-08T10:00:00', '入门', true, { elapsed_s: 900, predicted: '会' }),
      pr('2026-09-08T11:00:00', '入门', false, { elapsed_s: 600, predicted: '会' }),
      pr('2026-09-09T10:00:00', '入门', true, { predicted: '不会' }),
      pr('2026-09-09T11:00:00', '入门', false), // 无耗时无预测：两口径都不贡献
    ],
    estOf: { 入门: 30 },
  })
  assert.equal(d.speed.est_ratio, 0.8333) // 1500s ÷ (30min×60) = 0.8333
  assert.equal(d.speed.actual_minutes, 25)
  assert.equal(d.speed.est_minutes, 30)
  assert.deepEqual(d.speed.jol, { count: 2, wrong: 1, rate: 0.5 })
})

test('速度校准：est 缺席或无耗时数据时 est_ratio 为 null（不造假）；「会」档 0 次 rate 为 null', () => {
  const noEst = digestOf({ practice: [pr('2026-09-09T10:00:00', '入门', true, { elapsed_s: 600 })] })
  assert.equal(noEst.speed.est_ratio, null)
  const noElapsed = digestOf({
    practice: [pr('2026-09-09T10:00:00', '入门', true)],
    estOf: { 入门: 30 },
  })
  assert.equal(noElapsed.speed.est_ratio, null)
  assert.deepEqual(noElapsed.speed.jol, { count: 0, wrong: 0, rate: null })
})

// ---- 五件套④误解活跃度 ----

test('误解活跃度：invokes 概念命中该节点在册误解才算活跃，缺席不硬猜归属', () => {
  const d = digestOf({
    practice: [
      pr('2026-09-09T10:00:00', '入门', false, { qid: 'q1' }), // 极限 → 命中
      pr('2026-09-09T11:00:00', '入门', false, { qid: 'q2' }), // 连续 → 未登记
      pr('2026-09-09T12:00:00', '入门', false), // 无 qid → 不归属
      pr('2026-09-09T13:00:00', '进阶', false, { qid: 'q3' }), // 别的节点同概念 → 该节点无此条目
    ],
    invokesOf: q => ({ q1: '极限', q2: '连续', q3: '极限' })[q] ?? null,
    misconceptionsOf: { 入门: [{ concept: '极限', model: '把极限当成一个值' }] },
  })
  assert.equal(d.misconceptions.active, 1)
  assert.deepEqual(d.misconceptions.by_concept, [{ concept: '极限', count: 1 }])
})

// ---- 五件套⑤保留率概况 ----

test('保留率概况：到期复习（auto/self、有旧卡、每卡每日第一条）窗内真实保留率', () => {
  const d = digestOf({
    practice: [pr('2026-09-08T10:00:00', '入门', true), pr('2026-09-09T10:00:00', '入门', true)],
    reviews: [
      rr('2026-09-08T10:00:00', 'r1', 3), // 入窗、通过
      rr('2026-09-08T11:00:00', 'r2', 1), // 入窗、失手
      rr('2026-09-08T12:00:00', 'r3', 3, { rating_source: 'synthetic', stability_before: null }), // 合成排除
      rr('2026-09-08T13:00:00', 'r4', 3, { stability_before: null }), // 首学推进排除
      rr('2026-08-01T10:00:00', 'r5', 1), // 窗外
      rr('2026-09-09T10:00:00', 'r1', 2), // 同卡次日再推 → 计
    ],
  })
  assert.deepEqual(d.retention, { pass: 2, fail: 1, rate: 0.6667 })
})

// ---- 就绪深度检查 ----

test('就绪深度：默认 3、clamp [2,5]、非法值回落默认', () => {
  for (const [depth, want] of [[undefined, 3], [null, 3], [1, 2], [2, 2], [5, 5], [9, 5]] as const) {
    const c = readyDepthCheck({ ready: 5, unstarted: 5, declared: null, today: TODAY, depth })
    assert.equal(c.depth, want)
    assert.equal(c.required, want)
    assert.equal(c.ok, true)
    assert.deepEqual(c.warnings, [])
  }
  assert.equal(COACH_LOOKAHEAD_DEFAULT, 3)
  assert.equal(COACH_LOOKAHEAD_MIN, 2)
  assert.equal(COACH_LOOKAHEAD_MAX, 5)
})

test('就绪深度：冷启动首周（锚声明起 7 天内）需求 ×1.5 后 ceil；第 7 天起恢复', () => {
  assert.equal(COACH_COLD_START_DAYS, 7)
  assert.equal(COACH_COLD_START_EST_MULT, 1.5)
  const cold = readyDepthCheck({ ready: 4, unstarted: 4, declared: '2026-09-07', today: TODAY }) // 第 4 天
  assert.equal(cold.cold_start, true)
  assert.equal(cold.depth, 3)
  assert.equal(cold.required, 5) // ceil(3×1.5)
  assert.equal(cold.ok, false)
  assert.ok(cold.warnings[0]!.includes('冷启动首周 ×1.5'))
  const weekOut = readyDepthCheck({ ready: 3, unstarted: 3, declared: '2026-09-03', today: TODAY }) // 整 7 天
  assert.equal(weekOut.cold_start, false)
  assert.equal(weekOut.required, 3)
  assert.equal(weekOut.ok, true)
})

test('就绪深度：未开始存量 0 只告警不阻塞；低于前瞻一行告警；满足即静默', () => {
  const zero = readyDepthCheck({ ready: 0, unstarted: 0, declared: null, today: TODAY })
  assert.equal(zero.ok, false)
  assert.equal(zero.warnings.length, 1)
  assert.ok(zero.warnings[0]!.includes('未开始存量 0'))
  assert.ok(zero.warnings[0]!.includes('只告警不阻塞'))
  const low = readyDepthCheck({ ready: 2, unstarted: 2, declared: null, today: TODAY })
  assert.equal(low.ok, false)
  assert.equal(low.warnings.length, 1)
  assert.ok(low.warnings[0]!.includes('未开始存量 2 低于前瞻需求 3'))
  const ok = readyDepthCheck({ ready: 3, unstarted: 3, declared: null, today: TODAY })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.warnings, [])
})

test('就绪深度：判据量纲 = 未开始存量（#312 B1）——正文存量不参与达标，缺口单独一行', () => {
  // 事故形态：生长批只落结构（ADR-0078）→ 结构够深而正文一条没有。判据挂正文存量时
  // 「落盘成功 → 队列空 → 检查点 → ready=0 < required → 再入队」自激、无人值守烧额度。
  const structureOnly = readyDepthCheck({ ready: 0, unstarted: 3, declared: null, today: TODAY })
  assert.equal(structureOnly.ok, true, '结构达标即停摆：生长批涨的是未开始存量，不是正文存量')
  assert.equal(structureOnly.ready, 0)
  assert.equal(structureOnly.unstarted, 3)
  assert.equal(structureOnly.warnings.length, 1, '不静默：结构达标 ≠ 学习者有正文可读')
  assert.ok(structureOnly.warnings[0]!.includes('正文就绪 0'))
  assert.ok(structureOnly.warnings[0]!.includes('显式下发'))
  // 正文存量高于需求但结构不足：判据按结构判（正文由显式下发产生，与生长时机无关）
  const thinStructure = readyDepthCheck({ ready: 9, unstarted: 2, declared: null, today: TODAY })
  assert.equal(thinStructure.ok, false, '正文再多也不改判据——动作只能动结构')
  assert.ok(thinStructure.warnings[0]!.includes('未开始存量 2 低于前瞻需求 3'))
})

test('就绪深度：exhausted（除终点外前沿清空）判据自然通过——尾段合法停摆零告警', () => {
  const tail = readyDepthCheck({ ready: 0, unstarted: 0, declared: null, today: TODAY, exhausted: true })
  assert.equal(tail.ok, true)
  assert.equal(tail.exhausted, true, 'exhausted 出册（#161）：UI 据此区分「尾段合法停摆」与「刚播种的合法空态」')
  assert.deepEqual(tail.warnings, [])
  const coldTail = readyDepthCheck({ ready: 2, unstarted: 2, declared: '2026-09-07', today: TODAY, exhausted: true })
  assert.equal(coldTail.ok, true, '冷启动放大也不复活已清空的前沿')
  assert.equal(coldTail.exhausted, true)
  assert.deepEqual(coldTail.warnings, [])
  const normal = readyDepthCheck({ ready: 0, unstarted: 0, declared: null, today: TODAY })
  assert.equal(normal.exhausted, false, '非尾段（含刚播种的未开始存量 0 空态）不标 exhausted')
})

// ---- 渲染：行为摘要区块体 / 沉淀折叠教练投影 ----

test('行为摘要渲染：空窗 = 合法空态一行；有数据时五件各有区块且数字可读', () => {
  const empty = renderBehaviorDigest(digestOf({}))
  assert.ok(empty.startsWith('（窗口内无行为流水'))
  const d = digestOf({
    practice: [
      pr('2026-09-06T10:00:00', '入门', true),
      pr('2026-09-08T10:00:00', '入门', false, { qid: 'q1', elapsed_s: 600, predicted: '会' }),
      pr('2026-09-09T10:00:00', '进阶', false, { qid: 'q2' }),
    ],
    invokesOf: q => ({ q1: '极限', q2: '极限' })[q] ?? null,
    estOf: { 入门: 30 },
    misconceptionsOf: { 入门: [{ concept: '极限', model: 'x' }] },
    masteryOf: { 入门: 0.3, 进阶: 0.1 },
    reviews: [rr('2026-09-08T10:00:00', 'r1', 1)],
  })
  const text = renderBehaviorDigest(d)
  for (const frag of ['### 窗口', '### 掌握轨迹', '### 卡点集中度', '极限 ×2', '集中度（最大概念份额）：100%',
    '停滞：入门', '### 速度校准', '### 误解活跃度', '踩中在册误解 1 处', '### 保留率概况', '真实保留率 0%']) {
    assert.ok(text.includes(frag), `应包含「${frag}」\n---\n${text}`)
  }
})

test('沉淀折叠教练投影：空正典 = 合法空态；有事件时投影计数与最新值', () => {
  assert.ok(renderSedimentForCoach(foldSediment([])).includes('沉淀正典空'))
  const events: SedimentEvent[] = [
    { ts: '2026-09-08T10:00:00', kind: 'calibration', tier: 'weekly', payload: { week: '2026-09-07', pairs: 3 } },
    { ts: '2026-09-09T10:00:00', kind: 'recheck_outcome', tier: 'immediate', payload: { verdict: 'proven' }, concept: '极限' },
  ]
  const text = renderSedimentForCoach(foldSediment(events))
  assert.ok(text.includes('正典 2 条'))
  assert.ok(text.includes('calibration=1'))
  assert.ok(text.includes('校准画像最新（2026-09-08T10:00:00）'))
  assert.ok(text.includes('复诊结局涉及概念（登记表地址，最新一条）：极限（2026-09-09T10:00:00）'))
})

test('沉淀档案投影回归：「复诊结局」标题按正典 kind 渲染（不再出现 undefined）', () => {
  const events: SedimentEvent[] = [
    { ts: '2026-09-09T10:00:00', kind: 'recheck_outcome', tier: 'immediate', payload: { verdict: 'proven' }, concept: '极限' },
  ]
  const profile = renderLearnerProfile(foldSediment(events), Date.now())
  assert.ok(profile.includes('## 复诊结局'))
  assert.ok(!profile.includes('undefined'))
})

// ---- 门面：六区块上下文包 / 检查点接线（vault 工厂，facade 测试缝） ----

import { withVault, localDay } from './helpers/vault.ts'
import { draftCourse } from './helpers/drafted.ts'
import type { DraftSpec } from './helpers/drafted.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'

/** 起草夹具（无概念铸名）：起点「认识变化率」+ 终点「用导数解决优化问题」。 */
const CAPABILITY_DRAFT: DraftSpec = {
  starts: [{ name: '认识变化率', basis: 'baseline' }],
  endpoint: { name: '用导数解决优化问题' },
}

async function seedApplied(engine: LearnhubEngine): Promise<void> {
  // #256 种子通道退役：起草夹具直接落盘
  await draftCourse(engine, CAPABILITY_DRAFT)
}

const READY_SECTIONS = ['    - { id: s1, title: 第一节, type: 讲授, status: ready, version: 1 }']

/** 三节点链：起点（review+有正文）/ 中继（ready+有正文）/ 高阶（ready、无正文）。 */
const CHAIN_GRAPH = [
  'nodes:',
  '  - { name: 起点, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 中继, pre: [起点], opt: false, note: "", est: 25 }',
  '  - { name: 高阶, pre: [中继], opt: false, note: "", est: 30 }',
].join('\n')

test('门面：全量包六区块定序稳定；轻量包恰两件（行为摘要+罗盘）', async () => {
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await seedApplied(engine)
    const today = localDay(0)
    const pack = await engine.growth2.coachContextPack('数学', { today })
    const titles = [...pack.matchAll(/^## (.+)$/gm)].map(m => m[1])
    assert.deepEqual(titles, [
      '终点锚',
      '行为摘要（窗=最近 7 学习日或 10 节取大；即算即用不落盘）',
      '登记表档位（前沿概念的教学档位视野）',
      '误解目录（前沿节点的误解先验）',
      '罗盘尾段',
      'V-2 接缝（先验上下文注入——预留）',
    ])
    assert.ok(pack.includes('用导数解决优化问题'), '终点锚区块应携带终点节点')
    assert.ok(pack.includes('沉淀正典空'), '沉淀 Missing 折叠合法空态')
    assert.ok(pack.includes('罗盘缺席或尚无已画路线'), '罗盘未初画 = 合法空态')
    assert.ok(pack.includes('轻量段') === false)

    const light = await engine.growth2.coachContextPack('数学', { today, lightweight: true })
    const lightTitles = [...light.matchAll(/^## (.+)$/gm)].map(m => m[1])
    assert.deepEqual(lightTitles, [
      '行为摘要（窗=最近 7 学习日或 10 节取大；即算即用不落盘）',
      '罗盘尾段',
    ])
    assert.ok(light.includes('轻量段——只带行为摘要与罗盘'))
    assert.ok(!light.includes('## 终点锚'))
    assert.ok(!light.includes('沉淀折叠'), '轻量包不带沉淀半区')
  })
})

test('门面：登记表档位/误解目录取前沿视野（可学∪在学），零终点锚为合法空态行', async () => {
  await withVault({
    graph: [
      'nodes:',
      '  - { name: 起点, pre: [], opt: false, note: "", est: 20, teaches: { "极限": "能教" }, misconceptions: [{ concept: "极限", model: "把极限当成一个值" }] }',
      '  - { name: 中继, pre: [起点], opt: false, note: "", est: 25, teaches: { "极限": "会用" }, assumes: { "极限": "会用" } }',
    ].join('\n'),
    notes: {
      起点: { stage: 'review', content: { sections: READY_SECTIONS } },
      中继: { stage: 'ready', content: { sections: READY_SECTIONS } },
    },
  }, async ({ engine }) => {
    const pack = await engine.growth2.coachContextPack('数学', { today: localDay(0) })
    assert.ok(pack.includes('（零终点——空锚是合法空态'), '无锚课程照常组装')
    assert.ok(pack.includes('概念登记表：Missing（合法空态'), '登记表 Missing 合法空态')
    assert.ok(pack.includes('可学/在学节点 1 个'), 'review 中的起点不在前沿视野')
    assert.ok(pack.includes('前沿 teaches：极限 会用'), '同概念取视野内节点（中继）档位')
    assert.ok(pack.includes('前沿 assumes：极限 会用'))
    assert.ok(pack.includes('误解目录空'), '视野内节点无误解 → 合法空态')
  })
})

test('#262 废弃条目退出登记表档位注入面：在册计数只算活跃、前沿档位剔除废弃概念', async () => {
  await withVault({
    graph: [
      'nodes:',
      '  - { name: 起点, pre: [], opt: false, note: "", est: 20, teaches: { "因式分解": "知道", "配方法": "会用" }, assumes: { "因式分解": "会用" } }',
    ].join('\n'),
    notes: { 起点: { stage: 'ready', content: { sections: READY_SECTIONS } } },
    files: [{
      path: '学习中心/math/概念登记表.yaml',
      content: [
        'concepts:',
        '  - canonical: 因式分解',
        '    aliases: [十字相乘法]',
        '    deprecated: true',
        '  - canonical: 配方法',
      ].join('\n') + '\n',
    }],
  }, async ({ engine }) => {
    const pack = await engine.growth2.coachContextPack('数学', { today: localDay(0) })
    assert.ok(pack.includes('1 条在册（另有 1 条已废弃'), '在册计数只算活跃条目')
    assert.ok(pack.includes('前沿 teaches：配方法 会用'), '活跃概念仍在前沿档位')
    assert.ok(pack.includes('前沿 assumes：（前沿节点无 assumes 字段）'), '废弃概念退出前沿 assumes')
    assert.ok(!pack.includes('因式分解') && !pack.includes('十字相乘法'), '废弃概念与其别名不出现在档位注入面')
  })
})

test('门面：coachCheckpoint 三个触发点同核——判据量纲 = 未开始存量，正文存量单列', async () => {
  await withVault({
    graph: CHAIN_GRAPH,
    notes: {
      起点: { stage: 'review', content: { sections: READY_SECTIONS } },
      中继: { stage: 'ready', content: { sections: READY_SECTIONS } },
      高阶: { stage: 'ready' }, // 无正文：入未开始存量、不入正文存量
    },
  }, async ({ engine }) => {
    for (const trigger of ['node_complete', 'session_start', 'queue_idle'] as const) {
      const r = await engine.growth2.coachCheckpoint(trigger)
      assert.equal(r.trigger, trigger)
      assert.equal(r.courses.length, 1)
      const check = r.courses[0]!
      assert.equal(check.course, '数学')
      assert.equal(check.unstarted, 2, '未开始存量 = 图上还没开始的节点（中继 + 高阶）——判据量纲（#312 B1）')
      assert.equal(check.ready, 1, '正文存量只数「就绪前沿里已有正文」的（中继；判据不读它）')
      assert.equal(check.depth, 3)
      assert.equal(check.required, 3)
      assert.equal(check.cold_start, false)
      assert.equal(check.ok, false)
      assert.equal(check.warnings.length, 1)
      assert.ok(check.warnings[0]!.includes('未开始存量 2 低于前瞻需求 3'))
    }
  })
})

const WIDE_GRAPH = [
  'nodes:',
  '  - { name: 台阶甲, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 台阶乙, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 台阶丙, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 台阶丁, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

test('门面：#312 B1 事故形态——结构够深、正文为零 → 判停摆（不再自激重拉），缺口单独告警', async () => {
  // 生长批只落结构（ADR-0078）：判据挂正文存量时，「落盘成功 → 队列空 → queue_idle →
  // 正文仍为 0 → 再入队」无人值守地无限循环（实测 35k token 零产出）。判据换成就绪前沿
  // 后同一局面判停摆——宿主据此不再自动拉批（`if (chk.ok) continue`）。
  await withVault({ graph: WIDE_GRAPH }, async ({ engine }) => {
    const r = await engine.growth2.coachCheckpoint('queue_idle')
    const check = r.courses[0]!
    assert.equal(check.unstarted, 4, '四个节点都还没开始（追加结构必然涨这个数）')
    assert.equal(check.ready, 0, '一条正文都没有')
    assert.equal(check.ok, true, '结构达标即停摆（此前 ok=false → 每次队列排空都再拉一轮）')
    assert.equal(check.warnings.length, 1, '不静默：正文缺口照说')
    assert.ok(check.warnings[0]!.includes('正文就绪 0'))
    assert.ok(check.warnings[0]!.includes('显式下发'))
  })
})

const TAIL_GRAPH = [
  'nodes:',
  '  - { name: 起点, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 中继, pre: [起点], opt: false, note: "", est: 25 }',
  '  - { name: 终点, pre: [中继], opt: false, note: "", est: 30 }',
].join('\n')

test('门面：就绪核算逐个剔除终点——尾段非终点前沿清空判据通过；终点正文不虚增存量', async () => {
  await withVault({
    graph: TAIL_GRAPH,
    notes: {
      起点: { stage: 'skipped' },
      中继: { stage: 'skipped' },
      终点: { stage: 'ready', content: { sections: READY_SECTIONS } },
    },
    files: [{
      path: '学习中心/math/state/终点锚.json',
      content: JSON.stringify({
        version: 2,
        anchors: [{
          endpoint: '终点', goal_type: 'capability', declared: localDay(-30),
          origin_proposal: 1, seed_nodes: ['起点', '中继', '终点'], start_basis: { 起点: 'baseline' },
        }],
      }),
    }],
  }, async ({ engine }) => {
    const r = await engine.growth2.coachCheckpoint('queue_idle', '数学')
    const check = r.courses[0]!
    assert.equal(check.ready, 0, '终点有正文也不入就绪存量（锚点不是课程节点）')
    assert.equal(check.ok, true, '除终点外前沿清空 → 判据自然通过')
    assert.deepEqual(check.warnings, [])
  })
})

test('门面：起草后冷启动生效（锚声明日 = 学习日）；起草图无正文 → 存量不足告警（正文存量单列）', async () => {
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await seedApplied(engine)
    const r = await engine.growth2.coachCheckpoint('session_start', '数学')
    const check = r.courses[0]!
    assert.equal(check.cold_start, true)
    assert.equal(check.required, 5)
    assert.equal(check.ready, 0, '起草图节点均无正文：正文就绪 0（学习面读数）')
    assert.ok(check.unstarted > 0, '判据量纲 = 未开始存量（#312 B1）：结构在图上，正文另算')
    assert.ok(check.warnings[0]!.includes('未开始存量'))
    assert.ok(check.warnings[0]!.includes('低于前瞻需求 5'))
  })
})

test('门面：nodeComplete 结果携带 coach 字段；statusJson 附会话开始检查', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', content: { sections: READY_SECTIONS } } },
  }, async ({ engine }) => {
    const done = await engine.sched2.nodeComplete('数学', '入门') as { accepted: boolean; coach?: { ready: number; course: string } }
    assert.equal(done.accepted, true)
    assert.equal(done.coach?.course, '数学')
    assert.equal(done.coach?.ready, 0, '完成后节点进入 review，存量清零')
    const doc = await engine.statusJson() as { courses: Array<{ name: string; coach?: { ready: number } }> }
    assert.equal(doc.courses[0]!.name, '数学')
    assert.equal(typeof doc.courses[0]!.coach?.ready, 'number')
  })
})

// ---- #303 空图首级判据材料注入（ADR-0092：材料注入，不开第三族模板）----
// ---- #310：判据补绑终点（课程名 + 终点锚作占位符注入；「宁简勿繁」降为同向候选间偏好；
//      域外正反例（Python）删除）----

test('#303 首级判据注入：触发口径是「前沿为空」（排除终点后未开始节点数为零），不是节点数', async () => {
  const CRITERIA = '首级判据'
  // ① 空图（仅终点）——新课加完终点的第一次生长
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await draftCourse(engine, { manualEndpoints: [{ name: '终点A', goalNote: '会用导数' }], notes: false })
    const pack = await engine.growth2.coachContextPack('数学', { today: localDay(0) })
    assert.ok(pack.includes(CRITERIA), '前沿为空 → 注入首级判据')
    assert.ok(pack.includes('零复合概念'), '起点资格四条随行（迁自 ADR-0040 原文）')
    assert.ok(pack.includes('坡道第一级台阶'), '操作化反例警示随行')
    assert.ok(pack.includes('裁决纪律：优先选能同时推进多个未达成终点的台阶'), '与裁决纪律行同域共存')
    // #310 补绑终点：块头点名本节课的两个既有输入（课程名 + 终点锚，不新增输入面）
    assert.ok(pack.includes('本课程：数学'), '块头点名课程名')
    assert.ok(pack.includes('声明终点：终点A'), '块头点名终点锚')
    assert.ok(pack.includes('朝这些终点之一推进了一步'), '「朝终点可辨认」是先决条件')
    assert.ok(pack.includes('同向候选之间取更简的那个'), '「宁简勿繁」降为同向候选间的偏好（去引信）')
    assert.ok(!pack.includes('过简的代价趋近零'), '绝对化表述已删')
    assert.ok(!pack.includes('Python'), '域外正反例已删（不收具体领域 → 无照抄范例）')
  })

  // ② 多终点零普通节点：节点数 2（不是「≤1」），前沿仍为空 → 照注入（口径不是节点数）
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await draftCourse(engine, {
      manualEndpoints: [{ name: '终点A' }, { name: '终点B' }], notes: false,
    })
    const pack = await engine.growth2.coachContextPack('数学', { today: localDay(0) })
    assert.ok(pack.includes(CRITERIA), '未开始存量零 = 注入（两个节点全是终点）')
    assert.ok(pack.includes('声明终点：终点A、终点B'), '多终点逐个点名（与逐终点锚区块同源）')
  })

  // ③ 普通节点已学完（前沿被清空）：同样命中——「删空普通节点」的等价场景
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await draftCourse(engine, {
      starts: [{ name: '起点', basis: 'baseline' }],
      endpoint: { name: '终点A' },
      notes: { 起点: { stage: 'review', content: { sections: READY_SECTIONS } } },
    })
    const pack = await engine.growth2.coachContextPack('数学', { today: localDay(0) })
    assert.ok(pack.includes(CRITERIA), '图上还有普通节点（起点）但已开始 → 未开始存量零，照注入')
  })

  // ④ 前沿非空：包形与现状一致（判据不注入，也不改任何既有区块）
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await draftCourse(engine, CAPABILITY_DRAFT)
    const pack = await engine.growth2.coachContextPack('数学', { today: localDay(0) })
    assert.ok(!pack.includes(CRITERIA), '有未开始的前沿节点 → 不注入（非空图回合不白吃 token）')
    assert.ok(pack.includes('认识变化率'), '前沿节点照旧进包')
  })
})
