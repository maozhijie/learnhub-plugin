import test from 'node:test'
import assert from 'node:assert/strict'
import { newLessonRationale, normalizeGoalIntention, pinHeadScore, todayPins } from '../src/engine/goals.ts'
import type { PinRec } from '../src/engine/goals.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'
import type { NoteSeed } from './helpers/vault.ts'

// E3 目标所有权（决议 #48 / 实施工单 #67）：「今天学它」pin 覆盖层 + 推荐 rationale。

/** 极限(review, 前置衰减源) → 导数/积分(ready, 被软闸拦)；几何(ready, 无前置) → 几何进阶(unseen)；已会(mastered, 无题库)。 */
const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 极限, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 导数, pre: [极限], opt: false, note: "", est: 20 }',
  '      - { name: 积分, pre: [极限], opt: false, note: "", est: 20 }',
  '      - { name: 几何, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 几何进阶, pre: [几何], opt: false, note: "", est: 20 }',
  '      - { name: 已会, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

const PAST = '2024-01-01'
const FUTURE = '2099-01-01'

/** 六节点笔记种子：极限代表卡衰减、已会代表卡超稳，其余 ready/unseen 无 fsrs。 */
const NOTES: Record<string, NoteSeed> = {
  极限: { stage: 'review', fsrs: { stability: 30, difficulty: 5, due: PAST, last_review: PAST, reps: 8, lapses: 0 } },
  导数: { stage: 'ready' },
  积分: { stage: 'ready' },
  几何: { stage: 'ready' },
  几何进阶: { stage: 'unseen' },
  已会: { stage: 'mastered', fsrs: { stability: 90, difficulty: 5, due: FUTURE, last_review: PAST, reps: 9, lapses: 0 } },
}

/** 极限的题库：全部到期 → review/overdue 事件，且节点代表卡 R 衰减（软闸判据）。 */
const goalsVault = () => ({
  tag: 'learnhub-goals-',
  graph: GRAPH,
  notes: NOTES,
  banks: {
    极限: [tfQuestion('q1', {
      difficulty: 1,
      fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 2, lapses: 0 },
    })],
  },
})

type Ev = Record<string, unknown>

// ---- 纯规则（接缝 S29）----

test('todayPins：只保留当日条目，过期自动失效', () => {
  const pins: PinRec[] = [
    { course: '数学', node: '导数', date: '2026-09-07' },
    { course: '数学', node: '几何', date: '2026-09-08' },
    { course: '物理', node: '力学', date: '2026-09-08' },
  ]
  const hit = todayPins(pins, '2026-09-08')
  assert.deepEqual(hit.map(p => `${p.course}/${p.node}`), ['数学/几何', '物理/力学'])
})

test('pinHeadScore：课程内最高分 + 1（置顶课程内、不无限跨课跳）', () => {
  const events = [
    { course: '数学', score: 92 }, { course: '数学', score: 40 },
    { course: '物理', score: 99 },
  ]
  assert.equal(pinHeadScore(events, '数学'), 93)
  assert.equal(pinHeadScore([], '数学'), 1)
})

test('newLessonRationale：解锁数与区轮转拼成一句自然语句', () => {
  const s = newLessonRationale(2, '基础', true)
  assert.ok(s.startsWith('为什么先学它：'), s)
  assert.ok(s.includes('解锁 2 个后继'), s)
  assert.ok(s.includes('「基础」区最久没学'), s)
  assert.ok(!newLessonRationale(0, '进阶', false).includes('解锁'), '无解锁时不提后继')
})

// ---- 门面：pin 覆盖层 / 就绪提示保留 / 过期失效 / 合成事件 ----

test('pin「今天学它」：事件当日置顶课程内榜首，附「你选了它」标识、原理由与软闸建议', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.pinToday('数学', '导数')
    const rec = await engine.recommend(20) as { events: Ev[] }
    const head = rec.events[0] as Ev
    assert.equal(head.node, '导数', '被 pin 节点居榜首')
    assert.equal(head.pinned, true)
    assert.equal(head.type, 'new', '保留原事件类型与理由')
    assert.ok(String(head.why).startsWith('你选了它 · '), head.why as string)
    assert.ok(String(head.why).includes('前置 极限 保持率已衰减'), '未就绪 pin 保留前置软闸提示（仍可直接学）')
    assert.ok(Array.isArray(head.advice), '软闸建议项随事件带出')
    assert.ok(typeof head.path === 'string' && head.path.length > 0, '节点仍可打开（path 在）')
  })
})

test('pin 未就绪语义不拒绝、且落盘清单只保留当日有效条目', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    // 预置一条过期 pin（直接写清单），再 pin 新节点 → 过期条目被清理
    await engine.store.savePins([{ course: '数学', node: '已会', date: '2020-01-01' }])
    const r = await engine.pinToday('数学', '几何', '2026-09-08') as Ev
    assert.equal(r.node, '几何')
    const pins = await engine.store.loadPins()
    assert.deepEqual(pins, [{ course: '数学', node: '几何', date: '2026-09-08' }], '过期条目写入时清理')
  })
})

test('次日 pin 失效：过期清单不影响推荐（回落默认排序、无 pinned 标识）', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.store.savePins([{ course: '数学', node: '导数', date: '2020-01-01' }])
    const rec = await engine.recommend(20) as { events: Ev[] }
    assert.ok(rec.events.every(e => !e.pinned), '无任何 pinned 标识')
    assert.ok(rec.events.every(e => e.type !== 'pin'), '无合成 pin 事件')
    assert.notEqual((rec.events[0] as Ev).node, '导数', '榜首回落默认排序（极限 overdue 最优先）')
  })
})

test('pin 无事件的节点（已掌握、无到期题）：合成 pin 事件置顶，类型 pin、可打开', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.pinToday('数学', '已会')
    const rec = await engine.recommend(20) as { events: Ev[] }
    const head = rec.events[0] as Ev
    assert.equal(head.node, '已会')
    assert.equal(head.type, 'pin')
    assert.equal(head.pinned, true)
    assert.equal(head.hasContent, false)
    assert.ok(String(head.why).includes('巩固已学'), head.why as string)
    assert.equal(head.advice, undefined, '无软闸时不带建议项')
  })
})

test('取消 pin：清单清空、推荐回落默认排序', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.pinToday('数学', '导数')
    await engine.unpinToday('数学', '导数')
    assert.deepEqual(await engine.store.loadPins(), [])
    const rec = await engine.recommend(20) as { events: Ev[] }
    assert.ok(rec.events.every(e => !e.pinned))
  })
})

test('rationale：未 pin 的榜首新课 why 是一句自然语句（解锁数 + 区轮转）', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    const rec = await engine.recommend(20) as { events: Ev[] }
    const geo = rec.events.find(e => e.node === '几何') as Ev | undefined
    assert.ok(geo, '几何（无前置 ready）出 new 事件')
    assert.equal(geo!.type, 'new')
    const why = String(geo!.why)
    assert.ok(why.startsWith('为什么先学它：'), why)
    assert.ok(why.includes('解锁 1 个后继'), `几何进阶唯一卡在几何 → 解锁 1（${why}）`)
    assert.ok(why.includes('轮转'), why)
    const gated = rec.events.find(e => e.node === '导数') as Ev | undefined
    assert.ok(gated && String(gated.why).includes('保持率已衰减'), '被软闸拦下的新课保留就绪提示原文（rationale 并入语义不变）')
  })
})

// ---- 执行意图挂载目标偏好（C-5 #84 / ADR-0017 裁决 6：共享类型、各归其主）----

test('normalizeGoalIntention：成对必填、trim 归一、都缺 = 清除', () => {
  assert.deepEqual(normalizeGoalIntention(' 早上刷完牙后 ', '打开吉他弹一段音阶 '), { cue: '早上刷完牙后', action: '打开吉他弹一段音阶' })
  assert.equal(normalizeGoalIntention(undefined, undefined), undefined)
  assert.equal(normalizeGoalIntention('', '  '), undefined)
  assert.throws(() => normalizeGoalIntention(undefined, '行动'), /cue/)
  assert.throws(() => normalizeGoalIntention('线索', undefined), /action/)
})

test('pin 携带执行意图：可录入、持久化、推荐事件带出（验收三条）', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    // today 缺省 = 当前学习日，与 recommend 的「今日」口径一致（意图随 pin 当日有效）
    const r = await engine.pinToday('数学', '导数', undefined, { cue: '早上刷完牙后', action: '学一节导数' }) as Ev
    assert.deepEqual(r.intention, { cue: '早上刷完牙后', action: '学一节导数' })
    // 持久化：意图落在 pin 清单里（无独立文件/无独立生命周期）
    assert.deepEqual((await engine.store.loadPins())[0]!.intention, { cue: '早上刷完牙后', action: '学一节导数' })
    // 面板可见：推荐榜首事件带意图，供面板渲染
    const rec = await engine.recommend(20) as { events: Ev[] }
    const head = rec.events[0] as Ev
    assert.equal(head.node, '导数')
    assert.deepEqual(head.intention, { cue: '早上刷完牙后', action: '学一节导数' })
  })
})

test('setGoalIntention：已 pin 节点写入/清除；当日无 pin = Missing fail loud', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.pinToday('数学', '几何', '2026-09-08')
    const set = await engine.setGoalIntention('数学', '几何', { cue: '到工位坐下后', action: '先做一道几何题' }, '2026-09-08') as Ev
    assert.deepEqual(set.intention, { cue: '到工位坐下后', action: '先做一道几何题' })
    // 只给其一半条意图 → fail loud（格式锁死）
    await assert.rejects(() => engine.setGoalIntention('数学', '几何', { cue: '到工位坐下后' }, '2026-09-08'), /action/)
    // 清除（都不传）→ 事件不再带意图
    const cleared = await engine.setGoalIntention('数学', '几何', null, '2026-09-08') as Ev
    assert.equal(cleared.intention, null)
    assert.equal((await engine.store.loadPins()).find(p => p.node === '几何')!.intention, undefined)
    // 载体缺失不能悬空写：当日无 pin 的节点 fail loud
    await assert.rejects(() => engine.setGoalIntention('数学', '导数', { cue: 'c', action: 'a' }, '2026-09-08'), /没有 pin/)
  })
})

test('意图随 pin 的读侧语义走：重 pin 无意图 = 覆盖清除；过期 = 失效不泄漏', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.pinToday('数学', '导数', '2026-09-08', { cue: 'c', action: 'a' })
    // 同节点重 pin 不带意图 → 旧意图被覆盖清除（pinToday 去重替换语义）
    await engine.pinToday('数学', '导数', '2026-09-08')
    assert.equal((await engine.store.loadPins())[0]!.intention, undefined)
    // 次日：过期 pin（带意图）整体失效，意图不泄漏到任何事件
    await engine.store.savePins([{ course: '数学', node: '导数', date: '2020-01-01', intention: { cue: 'c', action: 'a' } }])
    const rec = await engine.recommend(20) as { events: Ev[] }
    assert.ok(rec.events.every(e => !e.intention), '过期 pin 的意图不出现在任何事件')
  })
})

test('红线：pin/意图写入零 canonical 触碰（Learner Output，ADR-0009）', async () => {
  await withVault(goalsVault(), async ({ engine }) => {
    await engine.pinToday('数学', '导数', '2026-09-08', { cue: 'c', action: 'a' })
    await engine.setGoalIntention('数学', '导数', { cue: 'c2', action: 'a2' }, '2026-09-08')
    await engine.setGoalIntention('数学', '导数', null, '2026-09-08')
    assert.equal((await engine.store.journalTail()).length, 0)
    assert.equal((await engine.store.practiceAll()).length, 0)
    assert.equal((await engine.sched2.xpStatus()).today_xp, 0)
  })
})
