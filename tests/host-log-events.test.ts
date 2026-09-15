/**
 * 宿主侧留痕事件（#253 / ADR-0080）：闭集里**只住宿主**的那几条，逐条断言真的发得出。
 *
 * 为什么单开一文件：本票的立意是「修复写了也要能证明它跑过」——`coach.*`／`agent.gate.*`
 * 有引擎侧测试兜着，`engine.call`／`engine.call.fail`／`agent.call`／`host.gen_jobs.*`
 * 是宿主技术层发的，没有覆盖就等于「接线断了也没人知道」。断言走内存假 logger，
 * 盘面形态（按天/保留期/上限）归 `tests/file-log.test.ts`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apiRun, createHostRuntime, run } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { restoreGenJobs } from '../src/host/jobs.ts'
import { memLogger } from './helpers/logger.ts'

/** 假宿主 ctx：llm.stream 按脚本回放（agent.call 要真的走完一次底层调用才发得出）。 */
function fakeCtx(responses: string[] = []): Context {
  const queue = [...responses]
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: queue.shift() ?? '' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

/** 独立 runtime（临时 vault + 假 ctx + 内存 logger）。 */
function makeRt(log: ReturnType<typeof memLogger>, responses: string[] = []): HostRuntime {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-logev-'))
  mkdirSync(join(vault, '学习中心', 'state'), { recursive: true })
  writeFileSync(join(vault, '学习中心', 'state', 'learnhub.json'),
    JSON.stringify({ schema: { version: 3, formats: {} } }, null, 1) + '\n', 'utf8')
  return createHostRuntime(fakeCtx(responses), { vault, centerRel: '学习中心', logger: log })
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const at = Date.now()
  while (!cond()) {
    if (Date.now() - at > timeoutMs) throw new Error('等待超时：条件未在时限内成立')
    await new Promise(r => setTimeout(r, 10))
  }
}

test('agent.call：底层调用观测沿缝落成事件（前身 llm_call），缺 usage 不造 tokens 字段', async () => {
  const log = memLogger()
  const rt = makeRt(log, ['好好好'])
  await rt.agent.complete('种子起草', '提示词', { effort: 'fast' })
  await until(() => log.count('agent.call') === 1)
  const e = log.nth('agent.call')!
  assert.equal(e.level, 'info')
  assert.equal(e.fields.station, '种子起草')
  assert.equal(e.fields.mode, 'complete')
  assert.equal(e.fields.call_no, 1)
  assert.equal(e.fields.effort, 'fast')
  assert.equal(e.fields.prompt_chars, 3)
  assert.equal(e.fields.reply_chars, 3)
  assert.equal(typeof e.fields.ms, 'number')
  assert.equal('tokens' in e.fields, false, '脚本化端口不上报 usage → 省略该字段')
})

test('engine.call / engine.call.fail：run 与 apiRun 出口留痕（失败也留痕且原样抛出）', async () => {
  const log = memLogger()
  const rt = makeRt(log)

  assert.equal(await run(rt, 'smoke', async () => '第一行\n第二行'), '第一行\n第二行')
  const ok = log.nth('engine.call')!
  assert.equal(ok.level, 'info')
  assert.equal(ok.fields.tool, 'smoke')
  assert.equal(ok.fields.chars, '第一行\n第二行'.length)
  assert.deepEqual(ok.fields.detail, ['第一行…（共 2 行）'], '不落原文：首行截断 + 行数索引')

  await assert.rejects(() => apiRun(rt, 'api/boom', async () => { throw new Error('后端炸了') }), /后端炸了/)
  const bad = log.nth('engine.call.fail')!
  assert.equal(bad.level, 'error')
  assert.equal(bad.fields.tool, 'api/boom')
  assert.equal(bad.fields.error, '后端炸了')
  assert.equal(log.count('engine.call'), 1, '失败不冒充成功留痕（两事件各管一段）')
})

test('host.gen_jobs.restore_failed（WARN）与 host.gen_jobs.restored（INFO）：重启恢复两条路径都留痕', async () => {
  // ① 档损坏 → broken 态 + WARN
  const broken = memLogger()
  const rtA = makeRt(broken)
  writeFileSync(rtA.engine.paths.genJobsPath, '{oops', 'utf8')
  restoreGenJobs(rtA)
  await until(() => broken.count('host.gen_jobs.restore_failed') === 1)
  assert.equal(broken.nth('host.gen_jobs.restore_failed')!.level, 'warn')
  assert.match(String(broken.nth('host.gen_jobs.restore_failed')!.fields.error), /生成任务档/)

  // ② 档正常（含一条重启前 running 的中断任务）→ INFO 统计行（此前只有 console）
  const ok = memLogger()
  const rtB = makeRt(ok)
  writeFileSync(rtB.engine.paths.genJobsPath, JSON.stringify([
    { course: '数学', node: '入门', startedAt: '2026-09-14T00:00:00.000Z', status: 'running', phase: 'sections' },
  ]), 'utf8')
  restoreGenJobs(rtB)
  await until(() => ok.count('host.gen_jobs.restored') === 1)
  const e = ok.nth('host.gen_jobs.restored')!
  assert.equal(e.level, 'info')
  assert.equal(typeof e.fields.stale, 'number')
  assert.equal(typeof e.fields.swept, 'number')
  assert.equal(typeof e.fields.queued_paused, 'number')
  assert.equal(rtB.flags.genQueueBroken, null, '正常档不置 broken')
})
