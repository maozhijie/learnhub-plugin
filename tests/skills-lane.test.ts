/**
 * 技能条目与执行事件调度通道（U-2 #89 / ADR-0018 + ADR-0019）。
 *
 * - 纯函数（#105 指定接缝）：维持节拍帽 clamp、lane 生效到期、事件种类判定、
 *   可观测证据 → 1-4 确定性映射、优化器 ≥400 执行事件混训门。
 * - 行为（经 store/engine seam，ADR-0013）：execution_log 全链——复习日志行
 *   （rating_source='execution' + event_kind）+ journal XP 行（时长入账、进 streak）+
 *   一 lane 一学习日一次门 + XP 账本终态。
 * - 红线机检：执行事件通道不复用题目卡、不进复习队列、不写节点 frontmatter。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampMaintenanceDays, laneDue, laneEventKind, ratingFromEvidence,
  MAINTENANCE_DEFAULT_DAYS, executionXpDetail,
} from '../src/engine/skills.ts'
import { EXECUTION_TRAINING_GATE, trainingSequences } from '../src/engine/optimize.ts'
import type { FsrsBlock, ReviewRec } from '../src/engine/types.ts'
import { localDay, withVault } from './helpers/vault.ts'
import { addDays } from '../src/engine/dates.ts'

// ---- 纯函数：维持节拍帽 ----

test('维持帽 clamp：缺省 30、null/0 关、7–365 之外 fail loud', () => {
  assert.equal(clampMaintenanceDays(undefined), MAINTENANCE_DEFAULT_DAYS)
  assert.equal(clampMaintenanceDays(null), null)
  assert.equal(clampMaintenanceDays(0), null)
  assert.equal(clampMaintenanceDays(30), 30)
  assert.equal(clampMaintenanceDays(7), 7)
  assert.equal(clampMaintenanceDays(365), 365)
  assert.throws(() => clampMaintenanceDays(3), /7–365/)
  assert.throws(() => clampMaintenanceDays(366), /7–365/)
  assert.throws(() => clampMaintenanceDays('四十' as never), /天数或 null/)
})

// ---- 纯函数：lane 生效到期与事件种类（#105 唯一新接缝）----

function fsBlock(over: Partial<FsrsBlock>): FsrsBlock {
  return {
    stability: 10, difficulty: 5, due: '2026-09-20', last_review: '2026-09-01',
    reps: 5, lapses: 0, ...over,
  }
}
const TODAY = localDay()

test('laneDue：fresh=null；FSRS due 与「上次事件+维持帽」取较早；帽关则纯 due', () => {
  assert.equal(laneDue(null, 30), null)
  assert.equal(laneDue(fsBlock({}), null), '2026-09-20') // 帽关 → 纯 FSRS due
  // 帽日 09-08（09-01 + 7）< due 09-20 → 生效到期提前到帽日
  assert.equal(laneDue(fsBlock({}), 7), '2026-09-08')
  // 帽日 10-01（09-01 + 30）> due 09-20 → FSRS due 先到
  assert.equal(laneDue(fsBlock({}), 30), '2026-09-20')
  // 同日 → FSRS due 优先（帽只有严格更早才改变生效到期）
  assert.equal(laneDue(fsBlock({ due: '2026-09-08' }), 7), '2026-09-08')
})

test('laneEventKind：帽严格更早且已到 = maintenance；fresh/未到期/FSRS 先到 = acquisition', () => {
  const fs = fsBlock({}) // 帽日 09-08、due 09-20
  assert.equal(laneEventKind(fs, 7, '2026-09-08'), 'maintenance')
  assert.equal(laneEventKind(fs, 7, '2026-09-15'), 'maintenance')
  assert.equal(laneEventKind(fs, 7, '2026-09-07'), 'acquisition') // 未到帽
  assert.equal(laneEventKind(null, 30, TODAY), 'acquisition') // fresh 首练是习得
  // FSRS due 更早：先到的是习得复查不是维持
  const fsEarly = fsBlock({ due: '2026-09-05' })
  assert.equal(laneEventKind(fsEarly, 7, '2026-09-09'), 'acquisition')
  // 同日双双到期 → acquisition（帽不是因）
  assert.equal(laneEventKind(fsBlock({ due: '2026-09-08' }), 7, '2026-09-08'), 'acquisition')
  // 帽关 → 永远 acquisition
  assert.equal(laneEventKind(fs, null, '2026-09-20'), 'acquisition')
})

// ---- 纯函数：可观测证据 → 评级映射（ADR-0018 裁决 3 的仓库推荐默认）----

test('证据映射：准确率分带、自主求助超 1 次降档、无 accuracy 拒绝（分数直喂禁止）', () => {
  assert.equal(ratingFromEvidence({ accuracy: 0.95 }), 4)
  assert.equal(ratingFromEvidence({ accuracy: 0.9 }), 4)
  assert.equal(ratingFromEvidence({ accuracy: 0.75 }), 3)
  assert.equal(ratingFromEvidence({ accuracy: 0.5 }), 2)
  assert.equal(ratingFromEvidence({ accuracy: 0.2 }), 1)
  assert.equal(ratingFromEvidence({ accuracy: 0.95, self_help: 2 }), 3)
  assert.equal(ratingFromEvidence({ accuracy: 0.95, self_help: 4 }), 1)
  assert.equal(ratingFromEvidence({ accuracy: 0.95, self_help: 0 }), 4) // 0 次求助不降档
  assert.throws(() => ratingFromEvidence({ accuracy: 1.5 }), /0–1/)
  assert.throws(() => ratingFromEvidence({ self_help: 1 }), /自评档/)
})

// ---- 纯函数：优化器混训门（ADR-0018 裁决 4）----

function execRow(day: string, rating: 1 | 2 | 3 | 4, skill = '吉他'): ReviewRec {
  return {
    ts: `${day}T10:00:00`, course: '*', node: skill, qid: 'exec',
    rating, rating_source: 'execution', elapsed_days: 3,
    stability_before: 5, difficulty_before: 5, r_pred: 0.9,
  }
}
function autoRow(day: string): ReviewRec {
  return { ts: `${day}T10:00:00`, course: '数学', node: '入门', qid: 'q1', rating: 3, rating_source: 'auto', elapsed_days: 1, stability_before: 5, difficulty_before: 5, r_pred: 0.9 }
}

test('优化器混训门：执行事件 <400 排除、≥400 与题目事件混训', () => {
  const exec = Array.from({ length: EXECUTION_TRAINING_GATE }, (_, i) => execRow(`2026-08-${String(i % 28 + 1).padStart(2, '0')}`, 3))
  const auto = [autoRow('2026-09-01'), autoRow('2026-09-02')]
  const below = trainingSequences([...exec.slice(0, EXECUTION_TRAINING_GATE - 1), ...auto])
  assert.equal(below.length, 1)
  assert.equal(below[0].key, '数学/入门/q1') // 执行事件全被排除
  const mixed = trainingSequences([...exec, ...auto])
  assert.equal(mixed.length, 2)
  assert.ok(mixed.some(s => s.key === '*/吉他/exec')) // 过门后进入混训
  // synthetic 与 execution 同等待遇：门内也永不进序列
  const synth = trainingSequences([{ ...execRow('2026-09-01', 3), rating_source: 'synthetic' as never }])
  assert.equal(synth.length, 0)
})

// ---- 行为：execution_log 全链（vault seam）----

test('执行事件全链：lane 推进 + 复习日志行 + journal XP 行 + streak 口径', async () => {
  await withVault({ tag: 'exec-log' }, async h => {
    await h.engine.skillCreate('吉他')
    const r = await h.engine.executionLog('吉他', { source: 'self', rating: 3, minutes: 25 })
    assert.equal(r.rating, 3)
    assert.equal(r.kind, 'acquisition') // fresh 首练
    assert.equal(r.xp, 25)
    assert.equal(r.attempts, 1)

    // 复习日志：execution 行（维持/习得 + 来源枚举可区分、不复用题目卡身份）
    const log = await h.store.reviewLogAll()
    assert.equal(log.length, 1)
    assert.equal(log[0].rating_source, 'execution')
    assert.equal(log[0].event_kind, 'acquisition')
    assert.equal(log[0].exec_source, 'self')
    assert.equal(log[0].course, '*')
    assert.equal(log[0].node, '吉他')
    assert.equal(log[0].qid, 'exec')

    // journal XP 行：时长直入（1 XP ≈ 1 分钟）+ duration_s 留档
    const journal = await h.store.journalTail()
    assert.equal(journal.length, 1)
    assert.equal(journal[0].kind, 'xp_execution')
    assert.equal(journal[0].xp, 25)
    assert.equal(journal[0].duration_s, 1500)
    assert.match(journal[0].detail ?? '', /执行事件 吉他（self 3·acquisition·25 分钟）/)
    assert.equal(executionXpDetail({ skill: '吉他', source: 'self', kind: 'acquisition', rating: 3, minutes: 25 }), journal[0].detail)

    // XP 账本终态：today_xp 含执行 XP、streak 命中（ADR-0019 同账同权）
    const xp = await h.engine.xpStatus()
    assert.equal(xp.today_xp, 25)
    assert.equal(xp.streak, 1)

    // 一 lane 一学习日一次
    await assert.rejects(
      () => h.engine.executionLog('吉他', { source: 'self', rating: 4, minutes: 10 }),
      /一 lane 一学习日一次/,
    )

    // auto 来源：证据映射；auto 无证据拒绝
    // （换技能绕开当日守门）
    await h.engine.skillCreate('游泳')
    const auto = await h.engine.executionLog('游泳', {
      source: 'auto', minutes: 40, evidence: { accuracy: 0.92, self_help: 2 }, note: '自由泳 25 米 × 8',
    })
    assert.equal(auto.rating, 3) // 4 带 -1（求助 2 次）
    const journal2 = await h.store.journalTail()
    assert.match(journal2[0].detail ?? '', /自由泳 25 米 × 8/) // note 随 XP 行留档
    await assert.rejects(
      () => h.engine.executionLog('吉他', { source: 'auto', minutes: 10 }),
      /可观测证据/,
    )
    await assert.rejects(
      () => h.engine.executionLog('吉他', { source: 'self', minutes: 10 }), // 缺 rating
      /1-4/,
    )
    // 小数评级静默取整会让 FSRS 丢乘子（ADR-0018 分数直喂禁止的近邻）：拒收
    await assert.rejects(
      () => h.engine.executionLog('游泳', { source: 'self', rating: 2.5, minutes: 10 }),
      /整数/,
    )
    // minutes 校验：0 / 超 24h / 小数
    await assert.rejects(() => h.engine.executionLog('游泳', { source: 'self', rating: 3, minutes: 0 }), /1–1440/)
    await assert.rejects(() => h.engine.executionLog('游泳', { source: 'self', rating: 3, minutes: 1441 }), /1–1440/)
    await assert.rejects(() => h.engine.executionLog('游泳', { source: 'self', rating: 3, minutes: 12.5 }), /1–1440/)
  })
})

test('维持复活：帽到期事件记 maintenance，推完后生效到期 = 新帽日', async () => {
  await withVault({ tag: 'exec-maint' }, async h => {
    await h.engine.skillCreate('吉他', { maintenance_days: 7 })
    // 手工摆 lane 状态：上次事件 10 天前、FSRS due 还远（间隔增长淹没不了维持帽）
    const doc = await h.engine.skills.load('吉他')
    await h.engine.skills.save('吉他', { ...doc, fsrs: fsBlock({ due: addDays(TODAY, 90)!, last_review: addDays(TODAY, -10)! }) })
    const list = await h.engine.learner.skillList()
    assert.equal(list.skills[0].due, addDays(TODAY, -3)) // (今天-10) + 7 维持帽
    assert.equal(list.skills[0].due_kind, 'maintenance')

    const r = await h.engine.executionLog('吉他', { source: 'self', rating: 2, minutes: 15 })
    assert.equal(r.kind, 'maintenance')
    const log = await h.store.reviewLogAll()
    assert.equal(log[0].event_kind, 'maintenance')
    // 推完后新帽日 = 今天 + 7 ≤ 新 FSRS due（帽不被间隔增长淹没）
    assert.equal(r.due, addDays(TODAY, 7))
  })
})

test('红线：执行事件不复用题目卡、不进复习队列、不写练习流水；归档拒绝', async () => {
  await withVault({ tag: 'exec-redline' }, async h => {
    await h.engine.skillCreate('吉他')
    await h.engine.executionLog('吉他', { source: 'self', rating: 3, minutes: 20 })
    await h.engine.learner.skillArchive('吉他', true)
    await assert.rejects(
      () => h.engine.executionLog('吉他', { source: 'self', rating: 3, minutes: 20 }),
      /已归档/,
    )
    // 恢复后同日守门仍然生效（归档不能绕过一 lane 一日一次）
    await h.engine.learner.skillArchive('吉他', false)
    await assert.rejects(
      () => h.engine.executionLog('吉他', { source: 'self', rating: 4, minutes: 5 }),
      /一 lane 一学习日一次/,
    )

    // 复习队列为空（技能 lane 不汇入）；练习作答流水零写入
    const q = await h.engine.reviewQueue()
    assert.equal(q.cards.length, 0)
    const journal = await h.store.journalTail()
    assert.ok(journal.every(r => r.kind === 'xp_execution')) // journal 只有执行 XP 行
    const practice = await h.store.practiceAll()
    assert.equal(practice.length, 0) // 练习作答流水零写入
  })
})

test('技能清单：Missing/Broken 语义 + 维持帽设置', async () => {
  await withVault({ tag: 'exec-list' }, async h => {
    await assert.rejects(() => h.engine.skills.load('不存在'), /Missing/)
    await h.engine.skillCreate('吉他')
    await h.engine.learner.skillSetMaintenance('吉他', 14)
    assert.equal((await h.engine.skills.load('吉他')).maintenance_days, 14)
    await h.engine.learner.skillSetMaintenance('吉他', null)
    assert.equal((await h.engine.skills.load('吉他')).maintenance_days, null)
    await assert.rejects(() => h.engine.learner.skillSetMaintenance('吉他', 3), /7–365/)
    // 坏档 = Broken 报出，不阻塞清单其他技能
    await h.engine.skillCreate('钢琴')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(h.paths.skillPath('烂档'), 'skill: [broken\n', 'utf8')
    const { skills, broken } = await h.engine.skills.list()
    assert.equal(skills.length, 2)
    assert.equal(broken.length, 1)
    assert.match(broken[0].reason, /Broken/)
    await assert.rejects(() => h.engine.skills.load('烂档'), /Broken/)
  })
})
