/**
 * 缝出口调用记录捕获（#330 / ADR-0103，取代 #213 缝出口单记）。
 *
 * - 适配器捕获：假 ctx.llm.stream（脚本 chunk 流）驱动 llmSeam/llmStreamSeam——
 *   请求 JSON（语义级 messages/system/语义档/maxTokens）与响应 JSON（text/工具调用
 *   含 id/真实结束原因/usage 含缓存与总 token）随节入档；调用级失败记 failed+稳定码
 *   + 部分响应后原样上抛；工厂闭包站名与端口 opts.station 两级站标签（调用点优先）。
 * - 重试逐次：捕获点在重试环内——截断重试两条记录（attempt 1/2，第二轮带
 *   maxTokens=8192）；档位降级同理逐次可见。
 * - AgentSeam 贯通：站/形态沿端口 opts 下行进调用记录，usage 沿 usageSink 回程上浮进
 *   AgentCallRecord（观测面 token 计量，缓存与总 token 恢复随行）。
 * - 任务身份：stampCorpusSink 盖章的捕获缝——course/node/source 随节落组文件。
 * - runtime 装配：createHostRuntime 接好 rt.corpus 与双缝——无 llm 的假 ctx 走到
 *   适配器即抛错，failed 捕获落盘（state/调用记录/_离线/<站>.md）。
 */
import { memLogger } from './helpers/logger.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import type { AgentCallRecord } from '../src/engine/infra/agent.ts'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { llmSeam, llmStreamSeam, LLM_TRUNCATION_RETRY_TOKENS } from '../src/host/llm.ts'
import { createCorpusCapture, stampCorpusSink } from '../src/host/corpus.ts'
import { parseCallRecordFile, readCallRecords } from '../src/host/corpus-read.ts'
import type { CorpusCapture } from '../src/host/corpus.ts'
import { systemClock } from '../src/host/clock.ts'

/** 假 dsh ctx：llm.stream 按脚本逐个 yield chunk（真实形状的子集）。 */
function fakeLlmCtx(chunks: Array<Record<string, unknown>>): Context {
  return {
    llm: {
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          for (const c of chunks) yield c
        },
      }),
    },
  } as unknown as Context
}

const OK_STREAM = [
  { type: 'text-delta', index: 0, text: '模型输出正文' },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15, cacheReadTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 临时中心目录 + 捕获器（root 一并交还，测试收尾删）。 */
function makeCap(): { cap: CorpusCapture; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'learnhub-capture-'))
  return { cap: createCorpusCapture(join(root, 'state', '调用记录')), root }
}

function flushParse(cap: CorpusCapture, root: string, course: string, node: string) {
  return parseCallRecordFile(readFileSync(join(root, 'state', '调用记录', course, `${node}.md`), 'utf8'))
}

test('捕获：llmSeam ok 记录带请求/响应 JSON 与闭包站名；opts.station 优先于闭包', async () => {
  const { cap, root } = makeCap()
  try {
    const seam = llmSeam(fakeLlmCtx(OK_STREAM), cap.record, '笔记出题')
    const out = await seam('渲染后提示词', '判卷约束', { effort: 'fast' })
    assert.equal(out, '模型输出正文')
    assert.match(cap.lastRef('笔记出题') ?? '', /^_离线\/笔记出题#1$/, 'ref = <组label>#<序号>（无身份 → 离线组）')
    await cap.flush()
    const calls = flushParse(cap, root, '_离线', '笔记出题')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].station, '笔记出题')
    assert.equal(calls[0].kind, 'complete')
    assert.equal(calls[0].effort, 'fast')
    assert.equal(calls[0].output, '模型输出正文')
    assert.equal(calls[0].prompt, '渲染后提示词')
    assert.deepEqual(calls[0].request.system, '判卷约束', 'system 恢复入档')
    assert.deepEqual(calls[0].request.messages, [{ role: 'user', text: '渲染后提示词' }])
    assert.deepEqual(calls[0].usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15, cacheReadTokens: 3 },
      '缓存与总 token 恢复入档')
    assert.equal(calls[0].response.finish, 'stop', '真实结束原因入档')
    assert.equal(calls[0].attempt, 1)

    const seam2 = llmSeam(fakeLlmCtx(OK_STREAM), cap.record, '闭包站')
    await seam2('p', undefined, { station: '调用点站' })
    await cap.flush()
    assert.match(cap.lastRef('调用点站') ?? '', /^_离线\/调用点站#1$/)
    assert.equal(cap.lastRef('闭包站'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('捕获：调用级失败记 failed+稳定码+部分响应，错误原样上抛', async () => {
  const { cap, root } = makeCap()
  try {
    const seam = llmSeam(fakeLlmCtx([
      { type: 'text-delta', index: 0, text: '错误前写了一半' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '密钥无效' } } },
    ]), cap.record, '判卷')
    await assert.rejects(() => seam('p'), /AUTH/)
    await cap.flush()
    const calls = flushParse(cap, root, '_离线', '判卷')
    assert.equal(calls[0].outcome, 'failed')
    assert.equal(calls[0].code, 'AUTH')
    assert.equal(calls[0].response.text, '错误前写了一半', '失败尝试的部分响应不丢')
    assert.equal(calls[0].response.finish, 'error')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#330 重试逐次：首轮截断记 truncated+finish=max-tokens，重试轮带 maxTokens=8192，attempt 递增', async () => {
  const { cap, root } = makeCap()
  try {
    let call = 0
    const truncatedThenOk = {
      llm: {
        stream: () => ({
          [Symbol.asyncIterator]: async function* () {
            call++
            if (call === 1) {
              yield { type: 'text-delta', index: 0, text: '被截断的输出' }
              yield { type: 'finish', reason: { kind: 'max-tokens' } }
            } else {
              yield { type: 'text-delta', index: 0, text: '提高上限后的完整输出' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            }
          },
        }),
      },
    } as unknown as Context
    const seam = llmSeam(truncatedThenOk, cap.record, '课程节生成')
    const out = await seam('写一节正文')
    assert.equal(out, '提高上限后的完整输出')
    await cap.flush()
    const calls = flushParse(cap, root, '_离线', '课程节生成')
    assert.equal(calls.length, 2, '重试逐次各记一条（捕获点在环内）')
    assert.equal(calls[0].attempt, 1)
    assert.equal(calls[0].response.finish, 'max-tokens', '首轮截断证据随节')
    assert.equal(calls[0].truncated, true)
    assert.equal(calls[1].attempt, 2)
    assert.equal(calls[1].response.finish, 'stop')
    assert.equal(calls[1].request.maxTokens, LLM_TRUNCATION_RETRY_TOKENS, '重试轮的显式输出上限入档')
    assert.equal(calls[0].request.maxTokens, undefined, '首轮无显式上限（部署默认）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('贯通：AgentSeam 站/形态/语义档下行进调用记录，usage 沿 usageSink 回程进 AgentCallRecord', async () => {
  const { cap, root } = makeCap()
  const records: AgentCallRecord[] = []
  const agent = new AgentSeam({ logger: memLogger(),
    complete: llmSeam(fakeLlmCtx(OK_STREAM), cap.record),
    onCall: r => records.push(r),
  }, systemClock)
  try {
    await agent.complete('种子起草', '提示词正文', { effort: 'deep' })
    await cap.flush()
    assert.equal(records.length, 1)
    assert.equal(records[0].station, '种子起草')
    assert.deepEqual(records[0].usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15, cacheReadTokens: 3 })
    const calls = flushParse(cap, root, '_离线', '种子起草')
    assert.equal(calls[0].station, '种子起草')
    assert.equal(calls[0].kind, 'complete')
    assert.equal(calls[0].effort, 'deep')
    // repair 形态标签
    await agent.repair('种子起草', '回灌提示词', { effort: 'deep' })
    await cap.flush()
    const calls2 = flushParse(cap, root, '_离线', '种子起草')
    assert.equal(calls2.length, 2)
    assert.equal(calls2[1].kind, 'repair')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('捕获：agentLoop 回路调用进调用记录（station 沿请求、kind=loop、请求 JSON 记结构化回路历史）', async () => {
  const { cap, root } = makeCap()
  const records: AgentCallRecord[] = []
  const agent = new AgentSeam({ logger: memLogger(),
    complete: llmSeam(fakeLlmCtx(OK_STREAM), cap.record),
    stream: llmStreamSeam(fakeLlmCtx(OK_STREAM), cap.record),
    onCall: r => records.push(r),
  }, systemClock)
  try {
    const r = await agent.agentLoop({
      station: '罗盘', prompt: '回路任务指令', effort: 'deep', tools: [],
      runTool: async () => '',
    })
    assert.equal(r.text, '模型输出正文')
    assert.equal(records[0].station, '罗盘')
    assert.equal(records[0].mode, 'loop')
    await cap.flush()
    const calls = flushParse(cap, root, '_离线', '罗盘')
    assert.equal(calls[0].kind, 'loop')
    assert.deepEqual(calls[0].request.messages, [{ role: 'user', text: '回路任务指令' }], '回路历史结构化入档')
    assert.equal(calls[0].request.effort, 'deep')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('装配：createHostRuntime 接好 rt.corpus 与双缝——无 llm 假 ctx 走到适配器抛错并落 failed 记录', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-capture-rt-'))
  mkdirSync(join(vault, '学习中心'), { recursive: true })
  try {
    const rt: HostRuntime = createHostRuntime({ tools: { register: () => () => undefined } } as unknown as Context,
      { vault, centerRel: '学习中心', logger: memLogger() })
    assert.ok(rt.corpus)
    assert.equal(rt.corpus.lastRef('不存在站'), undefined)
    await assert.rejects(() => rt.agent.complete('种子起草', 'p', { effort: 'fast' }))
    await rt.corpus.flush()
    const dir = join(vault, '学习中心', 'state', '调用记录', '_离线', '种子起草.md')
    const calls = parseCallRecordFile(readFileSync(dir, 'utf8'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].outcome, 'failed')
    assert.equal(calls[0].code, 'LLM_ERROR')
    assert.equal(rt.corpus.lastRef('种子起草'), '_离线/种子起草#1')
  } finally {
    rmSync(vault, { recursive: true, force: true })
  }
})

// ---- 工具调用载荷（#236 沿袭）：回路轮的产物常常整个在 arguments 里 ----

const TOOL_CALL_STREAM = [
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'submit_batch', arguments: '{"note":{"operator":"前进"}}' } },
  { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('回路轮：文本为空而工具调用在场 → 载荷（含 id）进响应 JSON，端口返回形状不变', async () => {
  const { cap, root } = makeCap()
  try {
    const seam = llmStreamSeam(fakeLlmCtx(TOOL_CALL_STREAM), cap.record)
    const r = await seam({ messages: [{ role: 'user', text: '回路任务' }], station: '教练生长', effort: 'deep', tools: [] })
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'submit_batch', arguments: '{"note":{"operator":"前进"}}' }],
      '端口返回形状不变（id 是回路回灌所需）')
    await cap.flush()
    const calls = flushParse(cap, root, '_离线', '教练生长')
    assert.equal(calls[0].output, '', '文本侧确实为空')
    assert.deepEqual(calls[0].response.toolCalls,
      [{ id: 'call_1', name: 'submit_batch', arguments: '{"note":{"operator":"前进"}}' }], '载荷原文（含 id）落档')
    assert.deepEqual(calls[0].toolCalls, [{ name: 'submit_batch', arguments: '{"note":{"operator":"前进"}}' }], '读侧便捷投影可取回载荷')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('任务身份：stampCorpusSink 盖章捕获缝——course/node/source 随节落任务组文件（离线归档相区分）', async () => {
  const { cap, root } = makeCap()
  try {
    const seam = llmSeam(fakeLlmCtx(OK_STREAM), stampCorpusSink(cap, { course: '数学', node: '变量', source: '面板' }), '判卷')
    await seam('p')
    await cap.flush()
    const calls = flushParse(cap, root, '数学', '变量')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].source, '面板')
    assert.equal(cap.lastRef('判卷'), '数学/变量#1', 'ref 指向任务组')
    const all = readCallRecords(join(root, 'state', '调用记录'))
    assert.deepEqual(all.map(x => x.ref), ['数学/变量#1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
