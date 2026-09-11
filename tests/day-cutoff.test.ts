/**
 * 学习日/日界（ADR-0020 / #101）：日界原语（parseCutoff/fmtCutoff/todayStr/dayOfTs）、
 * day_cutoff 配置三件套、按日聚合与守门的跨日界归属。
 * 回归基线：cutoff=0（'00:00'）恒等旧午夜口径——withVault 测试工厂固定按它落基线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dayOfTs, todayStr, parseCutoff, fmtCutoff, parseDay, fmtDay } from '../src/engine/dates.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { readDayCutoff, writeDayCutoff, sumXp } from '../src/engine/xp.ts'
import { DAY_CUTOFF_DEFAULT } from '../src/engine/params.ts'
import type { PracticeRec } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'

/** files 逃生口用：中心级 learnhub.json 覆盖（盖过工厂的 00:00 基线）。 */
const cfg = (v: Record<string, unknown>) => [
  { path: '学习中心/state/learnhub.json', content: JSON.stringify(v) },
]

const nextDay = (date: string): string => fmtDay(new Date(parseDay(date)!.getTime() + 86400000))

const practice = (ts: string, xp: number, extra: Partial<PracticeRec> = {}): PracticeRec =>
  ({ ts, course: '数学', node: '入门', ex: 1, answer: '', correct: true, judge: 'true_false', xp, ...extra }) as PracticeRec

// ---- 原语 ----

test('parseCutoff/fmtCutoff：HH:mm ↔ 分钟数往返，非法返回 null', () => {
  assert.equal(parseCutoff('02:00'), 120)
  assert.equal(parseCutoff('00:00'), 0)
  assert.equal(parseCutoff('23:59'), 1439)
  assert.equal(parseCutoff('2:05'), 125)
  assert.equal(parseCutoff('24:00'), null)
  assert.equal(parseCutoff('01:60'), null)
  assert.equal(parseCutoff('0200'), null)
  assert.equal(parseCutoff('abc'), null)
  assert.equal(parseCutoff(120), null)
  assert.equal(fmtCutoff(120), '02:00')
  assert.equal(fmtCutoff(0), '00:00')
  assert.equal(fmtCutoff(1439), '23:59')
})

test('todayStr：日界（02:00）之前的凌晨归属前一学习日', () => {
  const at = (h: number, m: number) => new Date(2026, 2, 10, h, m) // 本地 2026-03-10
  assert.equal(todayStr(at(1, 30), 120), '2026-03-09')
  assert.equal(todayStr(at(1, 59), 120), '2026-03-09')
  assert.equal(todayStr(at(2, 0), 120), '2026-03-10')
  assert.equal(todayStr(at(23, 59), 120), '2026-03-10')
  assert.equal(todayStr(at(0, 30), 0), '2026-03-10') // cutoff=0 = 日历日
})

test('dayOfTs：本地 ISO ts → 学习日；跨月/跨年正确；cutoff=0 恒等前 10 位（回归基线）', () => {
  assert.equal(dayOfTs('2026-03-10T01:30:00', 120), '2026-03-09')
  assert.equal(dayOfTs('2026-03-10T01:59:59', 120), '2026-03-09')
  assert.equal(dayOfTs('2026-03-10T02:00:00', 120), '2026-03-10')
  assert.equal(dayOfTs('2026-03-10T00:00:00', 120), '2026-03-09') // 整点午夜也在日界前
  assert.equal(dayOfTs('2026-03-01T00:30:00', 120), '2026-02-28')
  assert.equal(dayOfTs('2026-01-01T00:30:00', 120), '2025-12-31')
  for (const ts of ['2026-03-10T00:00:00', '2026-03-10T23:59:59', '2026-03-10T12:00:00']) {
    assert.equal(dayOfTs(ts, 0), ts.slice(0, 10))
  }
})

// ---- day_cutoff 配置三件套 ----

test('readDayCutoff：缺失回落默认 02:00，非法同样回落，00:00 合法为 0', async () => {
  assert.equal(DAY_CUTOFF_DEFAULT, '02:00')
  await withVault({ tag: 'cutoff-missing-', files: cfg({ daily_xp_goal: 42 }) }, async ({ engine }) => {
    assert.equal(await readDayCutoff(engine.paths, nodeVaultFs), 120)
  })
  await withVault({ tag: 'cutoff-zero-', files: cfg({ day_cutoff: '00:00' }) }, async ({ engine }) => {
    assert.equal(await readDayCutoff(engine.paths, nodeVaultFs), 0)
  })
  await withVault({ tag: 'cutoff-bad-', files: cfg({ day_cutoff: '25:00' }) }, async ({ engine }) => {
    assert.equal(await readDayCutoff(engine.paths, nodeVaultFs), 120)
  })
})

test('writeDayCutoff：归一化落盘、合并保留其他字段、非法 fail loud', async () => {
  await withVault({ tag: 'cutoff-write-', files: cfg({ daily_xp_goal: 42 }) }, async ({ engine }) => {
    assert.equal(await writeDayCutoff(engine.paths, '4:30', nodeVaultFs), '04:30')
    assert.equal(await readDayCutoff(engine.paths, nodeVaultFs), 270)
    const doc = JSON.parse(await readFile(engine.paths.learnhubConfigPath, 'utf8')) as Record<string, unknown>
    assert.equal(doc.daily_xp_goal, 42)
    assert.equal(doc.day_cutoff, '04:30')
    await assert.rejects(() => writeDayCutoff(engine.paths, '99:00', nodeVaultFs), /HH:mm/)
  })
})

// ---- 按日聚合与守门的跨日界归属 ----

test('sumXp：跨日界流水按学习日归属（02:00 前算前一天）', () => {
  const recs = [
    practice('2026-03-10T23:30:00', 5),
    practice('2026-03-11T00:30:00', 7), // 日界 02:00 → 属 03-10
    practice('2026-03-11T10:00:00', 9),
  ]
  assert.equal(sumXp(recs, [], '2026-03-10', 120), 12)
  assert.equal(sumXp(recs, [], '2026-03-11', 120), 9)
  assert.equal(sumXp(recs, [], '2026-03-10', 0), 5) // cutoff=0 回归基线
})

test('store.activityCounts：凌晨流水重键到前一学习日', async () => {
  await withVault({ tag: 'cutoff-activity-' }, async ({ engine }) => {
    const { centerStateDir } = engine.paths
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(centerStateDir, { recursive: true })
    const lines = [
      practice('2026-03-10T23:30:00', 1),
      practice('2026-03-11T00:30:00', 1),
      practice('2026-03-11T10:00:00', 1),
    ].map(r => JSON.stringify(r)).join('\n')
    await writeFile(`${centerStateDir}/practice.jsonl`, lines + '\n', 'utf8')
    const shifted = await engine.store.activityCounts(120)
    assert.equal(shifted['2026-03-10']?.total, 2)
    assert.equal(shifted['2026-03-11']?.total, 1)
    const baseline = await engine.store.activityCounts(0)
    assert.equal(baseline['2026-03-11']?.total, 2)
  })
})

test('xpStatus：date=学习日、today_xp/streak 只算学习日内流水、day_cutoff 生效值随载荷带出', async () => {
  await withVault({ tag: 'cutoff-xp-', files: cfg({ day_cutoff: '02:00' }) }, async ({ engine }) => {
    const { date } = await engine.sched2.xpStatus()
    const next = nextDay(date)
    const prev = fmtDay(new Date(parseDay(date)!.getTime() - 86400000))
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: '', correct: true, judge: 'true_false', xp: 6, ts: `${date}T10:00:00` })
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 2, answer: '', correct: true, judge: 'true_false', xp: 3, ts: `${date}T00:30:00` }) // 学习日上一天
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 3, answer: '', correct: true, judge: 'true_false', xp: 4, ts: `${next}T00:30:00` }) // 学习日本日
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 4, answer: '', correct: true, judge: 'true_false', xp: 1, ts: `${prev}T15:00:00` }) // 前一学习日有行为 → streak 连上
    const xp = await engine.sched2.xpStatus()
    assert.equal(xp.date, date)
    assert.equal(xp.today_xp, 10)
    assert.equal(xp.streak, 2) // 当前学习日 + 前一学习日（次日 00:30 那条已归当日）
    assert.equal(xp.day_cutoff, '02:00')
  })
})

test('interactiveSettle：同节同学习日一次（凌晨过界仍算当日）', async () => {
  await withVault({ tag: 'cutoff-interactive-', files: cfg({ day_cutoff: '02:00' }) }, async ({ engine }) => {
    const { date } = await engine.sched2.xpStatus()
    const next = nextDay(date)
    await engine.store.appendPractice({
      course: '数学', node: '入门', ex: 0, answer: '', correct: true,
      judge: 'interactive', qid: 'interactive:s1', ts: `${next}T00:30:00`,
    })
    const blocked = await engine.interactiveSettle('数学', '入门', 's1', 0.9)
    assert.equal(blocked.settled, false) // 凌晨过界那条属当前学习日 → 防刷命中
    const fresh = await engine.interactiveSettle('数学', '入门', 's2', 0.9)
    assert.equal(fresh.settled, true) // 无记录的节照常结算
  })
})

test('interactiveSettle：日界之前的凌晨记录属上一学习日，不挡当日结算', async () => {
  await withVault({ tag: 'cutoff-interactive2-', files: cfg({ day_cutoff: '02:00' }) }, async ({ engine }) => {
    const { date } = await engine.sched2.xpStatus()
    await engine.store.appendPractice({
      course: '数学', node: '入门', ex: 0, answer: '', correct: true,
      judge: 'interactive', qid: 'interactive:s1', ts: `${date}T00:30:00`, // 属学习日前一天
    })
    const r = await engine.interactiveSettle('数学', '入门', 's1', 0.9)
    assert.equal(r.settled, true)
  })
})

test('statusJson：date=学习日、day_cutoff 生效值随载荷带出', async () => {
  await withVault({ tag: 'cutoff-status-', files: cfg({ day_cutoff: '02:00' }) }, async ({ engine }) => {
    const doc = await engine.statusJson()
    assert.equal(doc.day_cutoff, '02:00')
    assert.match(doc.date, /^\d{4}-\d{2}-\d{2}$/)
  })
})

test('reviewQueue：date=学习日（与到期判定同口径）', async () => {
  await withVault({ tag: 'cutoff-queue-', files: cfg({ day_cutoff: '02:00' }) }, async ({ engine }) => {
    const { date } = await engine.sched2.xpStatus()
    const q = await engine.content2.reviewQueue()
    assert.equal(q.date, date)
  })
})
