/**
 * 宿主日志实现单测（#253 / ADR-0080）：`host/log-file.ts` 的形态契约逐条。
 *
 * 测的是**盘面行为**（按天切分 / 行格式 / 多行形态 / 级别过滤 / 保留期清扫 /
 * 单日上限 / 写盘失败静默 + 失败计数）——引擎侧的事件断言不在这里，那用
 * `tests/helpers/logger.ts` 的内存假实现（引擎侧确定性、零盘面噪声）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileLogger, LOG_DAILY_LIMIT_BYTES, LOG_ENTRY_LIMIT, LOG_RETENTION_DAYS, MULTILINE_EVENTS } from '../src/host/log-file.ts'

/** 固定时刻构造（本地时区；测试断言行内时间与文件名都用它）。 */
const at = (y: number, mo: number, d: number, h = 13, mi = 4, s = 5, ms = 7): number =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime()

/** 换行常量：本文件里**不写字面行切分**（那道 JSONL 门只管 `src/`，但保持同一纪律免得被抄走）。 */
const NL = String.fromCharCode(10)

function tempDir(tag: string): string {
  return join(mkdtempSync(join(tmpdir(), `learnhub-log-${tag}-`)), 'logs')
}

/** 当日文件正文（按行切返回，便于逐行断言）。 */
function linesOf(dir: string, day: string): string[] {
  return readFileSync(join(dir, `${day}.log`), 'utf8').split(NL).filter(Boolean)
}

test('落点与行格式：state/logs/<本地日历日>.log，行内不带日期（文件名担）', () => {
  const dir = tempDir('format')
  const log = createFileLogger({ dir, now: () => at(2026, 9, 15), level: 'debug' })
  log.info('coach.round.enter', { course: '数学', today: '2026-09-15' })
  assert.deepEqual(readdirSync(dir), ['2026-09-15.log'], '文件名 = 本地日历日')
  assert.deepEqual(linesOf(dir, '2026-09-15'), ['[13:04:05.007] [INFO] coach.round.enter course=数学 today=2026-09-15'])
  rmSync(dir, { recursive: true, force: true })
})

test('按天切分：固定时钟跨日 → 两个文件，各写各的（不新建不追加错档）', () => {
  const dir = tempDir('split')
  let now = at(2026, 9, 15, 23, 59, 59)
  const log = createFileLogger({ dir, now: () => now })
  log.info('coach.round.enter', { course: '数学', today: '2026-09-15' })
  now = at(2026, 9, 16, 0, 0, 1)
  log.info('coach.round.enter', { course: '数学', today: '2026-09-16' })
  assert.deepEqual(readdirSync(dir).sort(), ['2026-09-15.log', '2026-09-16.log'])
  assert.equal(linesOf(dir, '2026-09-15').length, 1)
  assert.equal(linesOf(dir, '2026-09-16').length, 1)
  assert.match(linesOf(dir, '2026-09-15')[0]!, /^\[23:59:59\.007\]/)
  assert.match(linesOf(dir, '2026-09-16')[0]!, /^\[00:00:01\.007\]/)
  rmSync(dir, { recursive: true, force: true })
})

test('多行形态是闭集：声明的事件带续行（缩进两格），未声明的数组字段内联', () => {
  const dir = tempDir('multiline')
  const log = createFileLogger({ dir, now: () => at(2026, 9, 15) })
  // 声明可续行的（agent.gate.first）
  log.info('agent.gate.first', { station: '教练生长', verdict: 'reject', errors: 2, detail: ['  ✗ 甲', '  ✗ 乙'] })
  // 声明可续行、但 coach.segment.exit 只在 schema=reject 时带
  log.info('coach.segment.exit', { course: '数学', tier: 'repair', schema: 'reject', detail: ['  ✗ 丙'] })
  log.info('coach.segment.exit', { course: '数学', tier: 'light', schema: 'ok', detail: ['不该成续行'] })
  // 未声明的事件：数组内联（谁都能塞数组、但只有闭集里的会长成多行）
  log.info('coach.round.result', { course: '数学', segments: ['light', 'repair'] })
  const body = linesOf(dir, '2026-09-15')
  assert.deepEqual(body, [
    '[13:04:05.007] [INFO] agent.gate.first station=教练生长 verdict=reject errors=2',
    '    ✗ 甲',
    '    ✗ 乙',
    '[13:04:05.007] [INFO] coach.segment.exit course=数学 tier=repair schema=reject',
    '    ✗ 丙',
    '[13:04:05.007] [INFO] coach.segment.exit course=数学 tier=light schema=ok detail=不该成续行',
    '[13:04:05.007] [INFO] coach.round.result course=数学 segments=light | repair',
  ])
  assert.ok(MULTILINE_EVENTS.includes('engine.call') && MULTILINE_EVENTS.includes('agent.gate.death')
    && MULTILINE_EVENTS.includes('coach.gate.reject'), '闭集成员：engine.call / agent.gate.death / coach.gate.reject')
  rmSync(dir, { recursive: true, force: true })
})

test('字段纪律：undefined/null 不造字段、空数组不造续行；单条超上界标注截断', () => {
  const dir = tempDir('fields')
  const log = createFileLogger({ dir, now: () => at(2026, 9, 15) })
  log.info('agent.call', { station: '教练生长', tokens: undefined, effort: null, detail: [] })
  log.info('engine.call', { tool: 'statusJson', chars: LOG_ENTRY_LIMIT * 2, detail: ['x'.repeat(LOG_ENTRY_LIMIT * 2)] })
  const body = linesOf(dir, '2026-09-15')
  assert.equal(body[0], '[13:04:05.007] [INFO] agent.call station=教练生长', '缺值不造字段（缺 tokens/effort、空数组不续行）')
  // 截断作用在**整条**（首行 + 续行）：标记落在条目末尾，即最后一行
  const entry = readFileSync(join(dir, '2026-09-15.log'), 'utf8').trimEnd().split(NL).slice(1).join(NL)
  assert.ok(entry.endsWith('…（已截断）'), '超限显式标注，不静默丢尾巴')
  assert.ok(entry.length <= LOG_ENTRY_LIMIT + '…（已截断）'.length, '截到上界就不再长')
  rmSync(dir, { recursive: true, force: true })
})

test('级别门：默认 INFO 挡 debug；env LEARNHUB_LOG_LEVEL 可调（引擎侧不读环境）', () => {
  const dir = tempDir('level')
  const info = createFileLogger({ dir, now: () => at(2026, 9, 15) })
  info.debug('x.debug', { a: 1 })
  info.info('x.info', { a: 1 })
  info.warn('x.warn', { a: 1 })
  assert.deepEqual(linesOf(dir, '2026-09-15'), [
    '[13:04:05.007] [INFO] x.info a=1',
    '[13:04:05.007] [WARN] x.warn a=1',
  ], '默认 INFO：debug 被挡、info 起放行')

  const prev = process.env.LEARNHUB_LOG_LEVEL
  try {
    process.env.LEARNHUB_LOG_LEVEL = 'debug'
    const dbg = createFileLogger({ dir, now: () => at(2026, 9, 15) })
    dbg.debug('x.debug', { a: 1 })
    assert.ok(linesOf(dir, '2026-09-15').some(l => l.includes('[DEBUG] x.debug')), 'env 抬档生效')
    process.env.LEARNHUB_LOG_LEVEL = '不存在的档'
    const bad = createFileLogger({ dir, now: () => at(2026, 9, 15) })
    bad.debug('x.debug2', { a: 1 })
    assert.ok(!linesOf(dir, '2026-09-15').some(l => l.includes('x.debug2')), '非法值回退缺省 INFO，不抛错')
  } finally {
    if (prev === undefined) delete process.env.LEARNHUB_LOG_LEVEL
    else process.env.LEARNHUB_LOG_LEVEL = prev
  }
  rmSync(dir, { recursive: true, force: true })
})

test('保留期清扫：跨日新建时惰性清扫 30 天前，只认日期形状的文件名（其余一律不碰）', () => {
  const dir = tempDir('retention')
  mkdirSync(dir, { recursive: true })
  const old = '2026-07-01.log'      // 超期 → 删
  const edge = '2026-08-16.log'     // 恰在 30 天线上 → 留
  const recent = '2026-09-14.log'   // 昨日 → 留
  const foreign = '笔记.log'         // 非日期形状 → 不碰
  const notesDir = join(dir, '归档') // 目录 → 不碰
  for (const f of [old, edge, recent, foreign]) writeFileSync(join(dir, f), 'x\n', 'utf8')
  mkdirSync(notesDir, { recursive: true })
  const log = createFileLogger({ dir, now: () => at(2026, 9, 15) })
  log.info('coach.round.enter', { course: '数学' })
  const left = readdirSync(dir).sort()
  assert.ok(!left.includes(old), `${old} 超 ${LOG_RETENTION_DAYS} 天应被清扫`)
  assert.deepEqual(left, [edge, recent, '2026-09-15.log', foreign, '归档'].sort(), '线内的留、外来文件与目录不碰')
  rmSync(dir, { recursive: true, force: true })
})

test('单日上限：停写 + 文件尾标记行 + 告警一次；次日自动复位', () => {
  const dir = tempDir('cap')
  let now = at(2026, 9, 15)
  const warned: string[] = []
  const log = createFileLogger({ dir, now: () => now, warn: m => warned.push(m) })
  // 每条 ~8KB：够 20MB 需要 ~2600 条；写 3000 条确保越线
  const payload = 'y'.repeat(8000)
  for (let i = 0; i < 3000; i++) log.info('engine.call', { tool: 'statusJson', chars: 8000, detail: [payload] })
  assert.equal(log.cappedDay, '2026-09-15', '当日停写状态可查')
  assert.equal(warned.length, 1, 'console 告警恰一次（绝不静默停止）')
  const body = linesOf(dir, '2026-09-15')
  assert.ok(body.at(-1)!.includes('host.log.daily_cap'), '文件尾有标记行')
  // 上限是**写前**判据：末条照写、下一条撞线才停，故实际量落在「上限 − 一条」到上限之间
  const size = Buffer.byteLength(readFileSync(join(dir, '2026-09-15.log'), 'utf8'), 'utf8')
  assert.ok(size <= LOG_DAILY_LIMIT_BYTES + 200, '没越过上限继续写')
  assert.ok(size >= LOG_DAILY_LIMIT_BYTES - 20000, '一路写到贴线才停（不是提前熔断）')

  const frozen = body.length
  for (let i = 0; i < 20; i++) log.info('engine.call', { tool: 'after-cap' })
  assert.equal(linesOf(dir, '2026-09-15').length, frozen, '停写后当天不再追加')

  now = at(2026, 9, 16)
  log.info('coach.round.enter', { course: '数学' })
  assert.equal(log.cappedDay, null, '次日自动复位')
  assert.deepEqual(linesOf(dir, '2026-09-16'), ['[13:04:05.007] [INFO] coach.round.enter course=数学'])
  rmSync(dir, { recursive: true, force: true })
})

test('写盘失败静默不影响主流程，但失败计数与原因经实例暴露（可测可查）', () => {
  const root = mkdtempSync(join(tmpdir(), 'learnhub-log-fail-'))
  // dir 的父路径是**普通文件** → mkdir 与 append 都失败（模拟权限/锁/路径被占）
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  const dir = join(blocker, 'logs')
  const log = createFileLogger({ dir, now: () => at(2026, 9, 15) })
  assert.doesNotThrow(() => { log.info('coach.round.enter', { course: '数学' }) }, '日志故障不上浮成主流程故障')
  assert.ok(log.failures > 0, '失败计数可见')
  assert.ok(typeof log.lastError === 'string' && log.lastError.length > 0, '失败原因可见')
  rmSync(root, { recursive: true, force: true })
})
