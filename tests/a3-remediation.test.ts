import test from 'node:test'
import assert from 'node:assert/strict'
import { answer, tfQuestion, withVault } from './helpers/vault.ts'

/** 基石 → 入门 → 进阶；enc 边按测试开关挂在入门（→基石）或进阶（→入门）上。 */
function graphYaml(encOn入门: boolean, encOn进阶 = false): string {
  return [
    'region: 基础',
    'color: blue',
    'blocks:',
    '  - name: 入门块',
    '    nodes:',
    '      - { name: 基石, pre: [] }',
    '      - { name: 入门, pre: [基石]' + (encOn入门 ? ', enc: [{node: 基石, w: 0.9}]' : '') + ' }',
    '      - { name: 进阶, pre: [入门]' + (encOn进阶 ? ', enc: [{node: 入门, w: 0.8}]' : '') + ' }',
  ].join('\n')
}

const PAST = '2024-01-01'
const FUTURE = '2099-01-01'

/** 衰减卡：R 掉到远低于软闸门槛（稳定度 1 + 两年前复习）。 */
const DECAYED = { stability: 1, difficulty: 5, due: PAST, last_review: PAST, reps: 2, lapses: 0 }
/** 超稳定卡：R≈1，绝不触发弱前置。 */
const SOLID = { stability: 100000, difficulty: 5, due: FUTURE, last_review: PAST, reps: 6, lapses: 0 }

/** 已入调度（到期）的题卡 fsrs 种子。 */
const dueSeed = (due: string) => ({ stability: 5, difficulty: 5, due, last_review: due, reps: 1, lapses: 0 })

const findEvent = (events: Array<Record<string, unknown>>, node: string) =>
  events.find(e => e.node === node)

test('A3 软闸：衰减前置 → 进阶 new 事件带可执行建议；直刷入门到期题后建议消退、进阶回到 gated', async () => {
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(false),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review', fsrs: DECAYED },
      进阶: { stage: 'ready' },
    },
    banks: {
      入门: [tfQuestion('a1', { fsrs: dueSeed(PAST) }), tfQuestion('a2', { fsrs: dueSeed(PAST) })],
      基石: [tfQuestion('b1')],
    },
  }, async ({ engine }) => {
    const before = await engine.statusJson() as { courses: Array<Record<string, unknown>> }
    const st0 = before.courses[0] as Record<string, unknown>
    const blocked0 = (st0.blocked as Record<string, Array<Record<string, unknown>>>)['进阶']
    assert.equal(blocked0?.length, 1, '进阶被衰减前置拦下')
    assert.equal(blocked0[0].pre, '入门')
    assert.ok((blocked0[0].r as number) < 0.85)
    assert.equal(blocked0[0].due, 2, '建议携带前置的到期题数')
    assert.deepEqual(blocked0[0].entry, { course: '数学', node: '入门' }, '直达入口')

    const rec0 = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    const gateEvent = findEvent(rec0.events, '进阶')
    assert.equal(gateEvent?.type, 'new', '软闸：仍是 new 事件（可直接学）')
    const advice = gateEvent?.advice as Array<Record<string, unknown>>
    assert.deepEqual(advice?.map(a => a.node), ['入门'], '建议项指向衰减前置')
    assert.equal(advice[0].due, 2)
    assert.match(gateEvent!.why as string, /先复习它的 2 道到期题/)
    assert.match(gateEvent!.why as string, /仍可直接学/, '文案明示软闸语义')

    // 直达入口：刷完入门的 2 道到期题（真实作答推进 → R 回升）
    for (const qid of ['a1', 'a2']) {
      const r = await answer(engine, qid, 'true', { node: '入门' }) as Record<string, unknown>
      assert.equal(r.scheduled, true)
    }
    const after = await engine.statusJson() as { courses: Array<Record<string, unknown>> }
    const st1 = after.courses[0] as Record<string, unknown>
    const blocked1 = st1.blocked as Record<string, unknown[]>
    assert.equal(blocked1['进阶'], undefined, 'R 回升后建议项消失')
    assert.ok(((st1.gated as Array<{ node: string }>).some(g => g.node === '进阶')), '进阶自然进入 gated')

    const rec1 = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    const newEvent = findEvent(rec1.events, '进阶')
    assert.equal(newEvent?.type, 'new')
    assert.equal(newEvent?.advice, undefined, '推荐事件上的建议已消退')
  })
})

test('reviewQueue node 过滤：定向复习直达入口（存在性 fail loud，合法空队列为空）', async () => {
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(false),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review', fsrs: DECAYED },
      进阶: { stage: 'ready' },
    },
    banks: {
      入门: [tfQuestion('a1', { fsrs: dueSeed(PAST) }), tfQuestion('a2', { fsrs: dueSeed(PAST) })],
    },
  }, async ({ engine }) => {
    const scoped = await engine.content2.reviewQueue('数学', '入门') as { total: number; cards: Array<Record<string, unknown>> }
    assert.equal(scoped.total, 2)
    assert.ok(scoped.cards.every(c => c.node === '入门' && c.course === '数学'))

    const cross = await engine.content2.reviewQueue(undefined, '入门') as { total: number }
    assert.equal(cross.total, 2, '跨课程口径一致')

    const empty = await engine.content2.reviewQueue('数学', '进阶') as { total: number }
    assert.equal(empty.total, 0, '节点在图内但无到期题 → 合法空队列')

    const whole = await engine.content2.reviewQueue('数学') as { total: number }
    assert.equal(whole.total, 2, '不带 node 过滤维持原全局口径')

    await assert.rejects(() => engine.content2.reviewQueue('数学', '幽灵'), /不在.*图内/, '拼错的直达入口 fail loud')
    await assert.rejects(() => engine.content2.reviewQueue(undefined, '幽灵'), /不在任何启用课程/, '跨课程同样 fail loud')
  })
})

test('A3 enc 回退：复习中节点窗口内反复答错 → struggle 事件带 enc 定向建议；作答证据更新后消退', async () => {
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(true),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review' },
    },
    banks: {
      基石: [tfQuestion('b1', { fsrs: dueSeed(PAST) })],
      入门: [tfQuestion('a1'), tfQuestion('a2'), tfQuestion('a3')],
    },
  }, async ({ engine }) => {
    // 窗口内 3 次全错（作答量达下限、正确率 0）→ struggle
    for (const qid of ['a1', 'a2', 'a3']) {
      const r = await answer(engine, qid, 'false', { node: '入门' }) as Record<string, unknown>
      assert.equal(r.correct, false)
    }
    const rec0 = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    const struggle = findEvent(rec0.events, '入门')
    assert.equal(struggle?.type, 'struggle', '复习中节点无今日到期事件 → 独立 struggle 事件')
    const advice = struggle?.advice as Array<Record<string, unknown>>
    assert.deepEqual(advice?.map(a => a.node), ['基石'], '定向到 enc 成分技能')
    assert.equal(advice[0].w, 0.9, '建议携带 enc 权重')
    assert.equal(advice[0].due, 1, '成分技能的到期题数（直达入口）')
    assert.match(struggle!.why as string, /回补成分技能 基石/)

    // 作答证据更新：窗口内补 6 次正确（6/9 = 0.67 ≥ 0.6）→ 建议消退
    for (const qid of ['a1', 'a2', 'a3', 'a1', 'a2', 'a3']) {
      await answer(engine, qid, 'true', { node: '入门' })
    }
    const rec1 = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    assert.equal(findEvent(rec1.events, '入门'), undefined, '正确率回到阈值上 → struggle 事件静默')
  })
})

test('A3 静默：作答量不足或 enc 缺失时不产 struggle 事件', async () => {
  // 作答量不足（2 次 < 下限）
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(true),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review' },
    },
    banks: {
      入门: [tfQuestion('a1'), tfQuestion('a2')],
    },
  }, async ({ engine }) => {
    await answer(engine, 'a1', 'false', { node: '入门' })
    await answer(engine, 'a2', 'false', { node: '入门' })
    const rec = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    assert.equal(findEvent(rec.events, '入门'), undefined, '低数据静默')
  })
  // enc 缺失：struggle 但无处定向
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(false),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review' },
    },
    banks: {
      入门: [tfQuestion('a1'), tfQuestion('a2'), tfQuestion('a3')],
    },
  }, async ({ engine }) => {
    for (const qid of ['a1', 'a2', 'a3']) await answer(engine, qid, 'false', { node: '入门' })
    const rec = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    assert.equal(findEvent(rec.events, '入门'), undefined, 'enc=0 → 静默')
  })
  // 学习中节点累计作答量不足（2 次 < 下限）：事件文案保留旧引导，但不产 enc 建议
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(false, true),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review', fsrs: SOLID },
      进阶: { stage: 'learning' },
    },
    banks: {
      进阶: [tfQuestion('c1'), tfQuestion('c2')],
    },
  }, async ({ engine }) => {
    await answer(engine, 'c1', 'false', { node: '进阶' })
    await answer(engine, 'c2', 'false', { node: '进阶' })
    const rec = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    const learning = findEvent(rec.events, '进阶')
    assert.equal(learning?.type, 'learning')
    assert.equal(learning?.advice, undefined, '作答量不足 → 建议静默')
    assert.match(learning!.why as string, /建议先复习前置概念/, '回退到无建议的旧文案')
  })
})

test('A3 学习中节点 struggle：learning 事件带 enc 定向建议与具体文案', async () => {
  await withVault({
    tag: 'learnhub-a3-',
    graph: graphYaml(false, true),
    notes: {
      基石: { stage: 'review', fsrs: SOLID },
      入门: { stage: 'review', fsrs: SOLID },
      进阶: { stage: 'learning' },
    },
    banks: {
      入门: [tfQuestion('a1', { fsrs: dueSeed(PAST) }), tfQuestion('a2', { fsrs: dueSeed(PAST) })],
      进阶: [tfQuestion('c1'), tfQuestion('c2'), tfQuestion('c3')],
    },
  }, async ({ engine }) => {
    for (const qid of ['c1', 'c2', 'c3']) await answer(engine, qid, 'false', { node: '进阶' })
    const rec = await engine.recommend(20) as { events: Array<Record<string, unknown>> }
    const learning = findEvent(rec.events, '进阶')
    assert.equal(learning?.type, 'learning')
    const advice = learning?.advice as Array<Record<string, unknown>>
    assert.deepEqual(advice?.map(a => a.node), ['入门'], 'enc 祖先作为回补目标')
    assert.equal(advice[0].w, 0.8)
    assert.match(learning!.why as string, /回补成分技能 入门/)
  })
})
