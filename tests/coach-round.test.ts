import test from 'node:test'
import assert from 'node:assert/strict'
import {
  behaviorWindow, behaviorDigest, renderBehaviorDigest,
  readyDepthCheck, renderSedimentForCoach,
  COACH_LOOKAHEAD_DEFAULT, COACH_LOOKAHEAD_MIN, COACH_LOOKAHEAD_MAX,
  COACH_COLD_START_DAYS, COACH_COLD_START_EST_MULT,
} from '../src/engine/coach-round.ts'
import type { DigestInput } from '../src/engine/coach-round.ts'
import { foldSediment, renderLearnerProfile } from '../src/engine/sediment.ts'
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
    const c = readyDepthCheck({ ready: 5, declared: null, today: TODAY, depth })
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
  const cold = readyDepthCheck({ ready: 4, declared: '2026-09-07', today: TODAY }) // 第 4 天
  assert.equal(cold.cold_start, true)
  assert.equal(cold.depth, 3)
  assert.equal(cold.required, 5) // ceil(3×1.5)
  assert.equal(cold.ok, false)
  assert.ok(cold.warnings[0]!.includes('冷启动首周 ×1.5'))
  const weekOut = readyDepthCheck({ ready: 3, declared: '2026-09-03', today: TODAY }) // 整 7 天
  assert.equal(weekOut.cold_start, false)
  assert.equal(weekOut.required, 3)
  assert.equal(weekOut.ok, true)
})

test('就绪深度：ready=0 只告警不阻塞；低于前瞻一行告警；满足即静默', () => {
  const zero = readyDepthCheck({ ready: 0, declared: null, today: TODAY })
  assert.equal(zero.ok, false)
  assert.equal(zero.warnings.length, 1)
  assert.ok(zero.warnings[0]!.includes('ready=0'))
  assert.ok(zero.warnings[0]!.includes('只告警不阻塞'))
  const low = readyDepthCheck({ ready: 2, declared: null, today: TODAY })
  assert.equal(low.ok, false)
  assert.equal(low.warnings.length, 1)
  assert.ok(low.warnings[0]!.includes('低于前瞻需求 3'))
  const ok = readyDepthCheck({ ready: 3, declared: null, today: TODAY })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.warnings, [])
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
  const profile = renderLearnerProfile(foldSediment(events))
  assert.ok(profile.includes('## 复诊结局'))
  assert.ok(!profile.includes('undefined'))
})

// ---- 门面：六区块上下文包 / 检查点接线（vault 工厂，facade 测试缝） ----

import { withVault, localDay } from './helpers/vault.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'

const CAPABILITY_SEED = `course: 数学
mode: new
reason: 常识基线起步的能力锚定课程
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
`

async function seedApplied(engine: LearnhubEngine): Promise<void> {
  const r = await engine.graphPropose('seed', CAPABILITY_SEED) as { id: number }
  await engine.graphApply('seed', r.id)
}

const READY_SECTIONS = ['    - { id: s1, title: 第一节, type: 讲授, status: ready, version: 1 }']

/** 三节点链：起点（review+有正文）/ 中继（ready+有正文）/ 高阶（ready、无正文）。 */
const CHAIN_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 链块',
  '    nodes:',
  '      - { name: 起点, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 中继, pre: [起点], opt: false, note: "", est: 25 }',
  '      - { name: 高阶, pre: [中继], opt: false, note: "", est: 30 }',
].join('\n')

test('门面：全量包六区块定序稳定；轻量包恰两件（行为摘要+罗盘）', async () => {
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await seedApplied(engine)
    const today = localDay(0)
    const pack = await engine.coachContextPack('数学', { today })
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

    const light = await engine.coachContextPack('数学', { today, lightweight: true })
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

test('门面：登记表档位/误解目录取前沿视野（可学∪在学），未播种锚为合法空态行', async () => {
  await withVault({
    graph: [
      'region: 基础',
      'color: blue',
      'blocks:',
      '  - name: 链块',
      '    nodes:',
      '      - { name: 起点, pre: [], opt: false, note: "", est: 20, teaches: { "极限": "能教" }, misconceptions: [{ concept: "极限", model: "把极限当成一个值" }] }',
      '      - { name: 中继, pre: [起点], opt: false, note: "", est: 25, teaches: { "极限": "会用" }, assumes: { "极限": "会用" } }',
    ].join('\n'),
    notes: {
      起点: { stage: 'review', content: { sections: READY_SECTIONS } },
      中继: { stage: 'ready', content: { sections: READY_SECTIONS } },
    },
  }, async ({ engine }) => {
    const pack = await engine.coachContextPack('数学', { today: localDay(0) })
    assert.ok(pack.includes('（未播种——终点锚 Missing 是合法空态'), '无锚课程照常组装')
    assert.ok(pack.includes('概念登记表：Missing（合法空态'), '登记表 Missing 合法空态')
    assert.ok(pack.includes('可学/在学节点 1 个'), 'review 中的起点不在前沿视野')
    assert.ok(pack.includes('前沿 teaches：极限 会用'), '同概念取视野内节点（中继）档位')
    assert.ok(pack.includes('前沿 assumes：极限 会用'))
    assert.ok(pack.includes('误解目录空'), '视野内节点无误解 → 合法空态')
  })
})

test('门面：coachCheckpoint 三个触发点同核——就绪存量只数「未开始且有正文」', async () => {
  await withVault({
    graph: CHAIN_GRAPH,
    notes: {
      起点: { stage: 'review', content: { sections: READY_SECTIONS } },
      中继: { stage: 'ready', content: { sections: READY_SECTIONS } },
      高阶: { stage: 'ready' }, // 无正文：不入就绪存量
    },
  }, async ({ engine }) => {
    for (const trigger of ['node_complete', 'session_start', 'queue_idle'] as const) {
      const r = await engine.coachCheckpoint(trigger)
      assert.equal(r.trigger, trigger)
      assert.equal(r.courses.length, 1)
      const check = r.courses[0]!
      assert.equal(check.course, '数学')
      assert.equal(check.ready, 1, '只有中继（前置达成且有正文）入存量')
      assert.equal(check.depth, 3)
      assert.equal(check.required, 3)
      assert.equal(check.cold_start, false)
      assert.equal(check.ok, false)
      assert.equal(check.warnings.length, 1)
      assert.ok(check.warnings[0]!.includes('低于前瞻需求 3'))
    }
  })
})

test('门面：种子 apply 后冷启动生效（锚声明日 = 学习日）；种子图无正文 → ready=0 告警', async () => {
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    await seedApplied(engine)
    const r = await engine.coachCheckpoint('session_start', '数学')
    const check = r.courses[0]!
    assert.equal(check.cold_start, true)
    assert.equal(check.required, 5)
    assert.equal(check.ready, 0)
    assert.ok(check.warnings[0]!.includes('ready=0'))
    assert.ok(check.warnings[0]!.includes('只告警不阻塞'))
  })
})

test('门面：nodeComplete 结果携带 coach 字段；statusJson 附会话开始检查', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', content: { sections: READY_SECTIONS } } },
  }, async ({ engine }) => {
    const done = await engine.nodeComplete('数学', '入门') as { accepted: boolean; coach?: { ready: number; course: string } }
    assert.equal(done.accepted, true)
    assert.equal(done.coach?.course, '数学')
    assert.equal(done.coach?.ready, 0, '完成后节点进入 review，存量清零')
    const doc = await engine.statusJson() as { courses: Array<{ name: string; coach?: { ready: number } }> }
    assert.equal(doc.courses[0]!.name, '数学')
    assert.equal(typeof doc.courses[0]!.coach?.ready, 'number')
  })
})
