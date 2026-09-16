/**
 * 观测面扩展 T3（#291 / ADR-0091）宿主侧补遗：coach_growth.stuck_* 两条与
 * content.queue.line_skipped（整课链终点行跳过）——内存假 logger 断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { enqueueGrowthBatch, resetCourseChain } from '../src/host/jobs.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

const HALT_PLAN = 'course: 数学\noperator: 停摆\nreason: 就绪缺口由内容生成跟上\ntarget_endpoints: []\nsteps: []\n'

function fakeCtx(responses: string[]): Context {
  const queue = [...responses]
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: queue.length ? queue.shift() : '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

function makeRt(log: ReturnType<typeof memLogger>, responses: string[]): HostRuntime {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-obshost-'))
  mkdirSync(join(vault, '学习中心', 'state'), { recursive: true })
  writeFileSync(join(vault, '学习中心', 'state', 'learnhub.json'),
    JSON.stringify({ schema: { version: 4, formats: {} } }, null, 1) + '\n', 'utf8')
  return createHostRuntime(fakeCtx(responses), { vault, centerRel: '学习中心', logger: log })
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const at = Date.now()
  while (!cond()) {
    if (Date.now() - at > timeoutMs) throw new Error('等待超时：条件未在时限内成立')
    await new Promise(r => setTimeout(r, 10))
  }
}

test('coach_growth.stuck_read_failed：卡点自报读取失败不挡回合且留痕（WARN）', async () => {
  const log = memLogger()
  const rt = makeRt(log, [HALT_PLAN])
  await draftCourse(rt.engine, CAPABILITY_DRAFT)
  rt.engine.growth2.stuckPending = async () => { throw new Error('流水坏了') }
  enqueueGrowthBatch(rt, fakeCtx([HALT_PLAN]), '数学', '测试触发')
  await until(() => log.count('coach_growth.stuck_read_failed') === 1)
  const e = log.nth('coach_growth.stuck_read_failed')!
  assert.equal(e.level, 'warn')
  assert.equal(e.fields.course, '数学')
})

test('coach_growth.stuck_consume_failed：消费标记失败留账且留痕（WARN + targets）', async () => {
  const log = memLogger()
  const rt = makeRt(log, [HALT_PLAN])
  await draftCourse(rt.engine, CAPABILITY_DRAFT)
  await rt.engine.store.appendStuckReport({ course: '数学', node: '认识变化率', text: '卡住了' })
  rt.engine.growth2.stuckMarkConsumed = async () => { throw new Error('落盘失败') }
  enqueueGrowthBatch(rt, fakeCtx([HALT_PLAN]), '数学', '测试触发')
  await until(() => log.count('coach_growth.stuck_consume_failed') === 1)
  const e = log.nth('coach_growth.stuck_consume_failed')!
  assert.equal(e.level, 'warn')
  assert.equal(e.fields.course, '数学')
  assert.equal(e.fields.targets, 1)
})

test('content.queue.line_skipped：整课链跳过终点行留痕（INFO）', async () => {
  const log = memLogger()
  const rt = makeRt(log, [])
  await draftCourse(rt.engine, CAPABILITY_DRAFT)
  const r = await resetCourseChain(rt, fakeCtx([]), '数学')
  assert.ok(r.queued >= 1)
  await until(() => log.count('content.queue.line_skipped') >= 1)
  const e = log.nth('content.queue.line_skipped')!
  assert.equal(e.level, 'info')
  assert.equal(e.fields.course, '数学')
  assert.ok(['导数方向', '用导数解决优化问题'].includes(String(e.fields.node)), '跳过的应是终点节点')
})
