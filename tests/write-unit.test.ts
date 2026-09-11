/**
 * 写入单元原语（#176 / ADR-0046）：只做三件事——按声明顺序执行、强制声明了的幂等
 * （done=true 即续段）、末尾追加一条 journal。失败上抛中止、不回滚、失败不写 journal
 * （与既有「同事务」注释的今天语义逐条对齐）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runWriteUnit } from '../src/engine/write-unit.ts'
import type { WriteStep } from '../src/engine/write-unit.ts'
import { nowIsoOf } from '../src/engine/dates.ts'
import type { JournalRec } from '../src/engine/types.ts'
import type { Clock } from '../src/engine/index.ts'

const FIXED: Clock = { nowMs: () => 1_760_000_000_000 }

/** 收集器 harness：记录执行序列与 journal 条目。 */
function harness(steps: WriteStep[]) {
  const order: string[] = []
  const journal: JournalRec[] = []
  const wrapped = steps.map(s => ({
    ...s,
    run: async () => { order.push(`run:${s.name}`); await s.run() },
    ...(s.done ? { done: async () => { order.push(`done:${s.name}`); return await s.done!() } } : {}),
  }))
  const run = () => runWriteUnit('testOp', {
    course: '数学',
    clock: FIXED,
    journal: async rec => { journal.push(rec) },
    steps: wrapped,
  })
  return { run, order, journal }
}

test('声明顺序 == 执行顺序：打乱声明会导致不同执行序列（原语只强制声明，不接管排序）', async () => {
  const mark = (name: string): WriteStep => ({ name, run: async () => undefined })
  const a = harness([mark('first'), mark('second'), mark('third')])
  await a.run()
  assert.deepEqual(a.order, ['run:first', 'run:second', 'run:third'], '执行序列 = 声明序列')

  const b = harness([mark('third'), mark('first'), mark('second')])
  await b.run()
  assert.deepEqual(b.order, ['run:third', 'run:first', 'run:second'], '打乱声明 → 打乱执行——顺序是领域的声明，不是原语推导的')
})

test('幂等契约：done=true 续段跳过（run 不调用），done=false 照常执行；无 done 的步骤每次都执行', async () => {
  const h = harness([
    { name: '已存在步骤', run: async () => assert.fail('续段步骤不该 run'), done: async () => true },
    { name: '未存在步骤', run: async () => undefined, done: async () => false },
    { name: '追加型步骤', run: async () => undefined },
  ])
  const report = await h.run()
  assert.deepEqual(h.order, ['done:已存在步骤', 'done:未存在步骤', 'run:未存在步骤', 'run:追加型步骤'])
  assert.deepEqual(report.steps, [
    { name: '已存在步骤', status: 'skipped' },
    { name: '未存在步骤', status: 'done' },
    { name: '追加型步骤', status: 'done' },
  ])
})

test('失败行为：步骤 k 抛错 → 上抛中止，此前已写留在盘上，后续步骤不执行，journal 不写（不回滚不续跑）', async () => {
  const h = harness([
    { name: '第一笔', run: async () => undefined },
    { name: '会炸的一笔', run: async () => { throw new Error('盘满') } },
    { name: '不该执行', run: async () => assert.fail('中止后不得续跑') },
  ])
  await assert.rejects(h.run(), /盘满/)
  assert.deepEqual(h.order, ['run:第一笔', 'run:会炸的一笔'], '失败前的步骤已执行（部分态 = 今天语义），失败后的不执行')
  assert.equal(h.journal.length, 0, '失败不写 journal（恢复走 dataCheck/doctor/rebuild）')
})

test('journal：末尾恰一条，走既有 journal.jsonl 形状（kind=write_unit、node=op、ts 经 Clock 端口）', async () => {
  const h = harness([
    { name: '登记表', run: async () => undefined, done: async () => true },
    { name: '图YAML', run: async () => undefined },
  ])
  await h.run()
  assert.equal(h.journal.length, 1)
  const rec = h.journal[0]!
  assert.equal(rec.kind, 'write_unit')
  assert.equal(rec.node, 'testOp')
  assert.equal(rec.course, '数学')
  assert.equal(rec.ts, nowIsoOf(FIXED.nowMs()), 'ts 来自注入的时钟端口')
  assert.equal(rec.rating, null, 'write_unit 不是作答/XP 条目（sumXp 的 xp??0 与 kind 过滤消费方不受影响）')
  assert.match(rec.detail!, /steps=登记表:skipped,图YAML:done/)
  assert.match(rec.detail!, /落 1 笔、跳过 1 步/, 'journal 可读：能回答落了几笔、顺序如何')
})
