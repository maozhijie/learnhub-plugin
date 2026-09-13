/**
 * 缝出口生成语料捕获（#213 / ADR-0060）。
 *
 * - 适配器捕获：假 ctx.llm.stream（脚本 chunk 流）驱动 llmSeam/llmStreamSeam——
 *   ok 记录带站/档/usage/truncated，调用级失败记 failed+稳定码后原样上抛；
 *   工厂闭包站名与端口 opts.station 两级站标签（调用点优先）。
 * - AgentSeam 贯通：站/形态沿端口 opts 下行进语料，usage 沿 usageSink 回程上浮进
 *   AgentCallRecord（观测面 token 计量）。
 * - runtime 装配：createHostRuntime 接好 rt.corpus 与双缝——无 llm 的假 ctx 走到
 *   适配器即抛错，failed 捕获落盘（state/生成语料/<站>/bad-*.md）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AgentSeam } from '../src/engine/agent.ts'
import type { AgentCallRecord } from '../src/engine/agent.ts'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { llmSeam, llmStreamSeam } from '../src/host/llm.ts'
import { createCorpusCapture } from '../src/host/corpus.ts'
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
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 临时中心目录 + 捕获器（root 一并交还，测试收尾删）。 */
function makeCap(): { cap: CorpusCapture; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'learnhub-capture-'))
  return { cap: createCorpusCapture(root), root }
}

function corpusBody(root: string, station: string): string {
  const dir = join(root, 'state', '生成语料', station)
  return readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
}

test('捕获：llmSeam ok 记录带闭包站名/语义档/usage；opts.station 优先于闭包', async () => {
  const { cap, root } = makeCap()
  try {
    const seam = llmSeam(fakeLlmCtx(OK_STREAM), cap.record, '笔记出题')
    const out = await seam('渲染后提示词', undefined, { effort: 'fast' })
    assert.equal(out, '模型输出正文')
    assert.match(cap.lastRef('笔记出题') ?? '', /^笔记出题\/ok-/)
    await cap.flush()
    const body = corpusBody(root, '笔记出题')
    assert.match(body, /station: 笔记出题/)
    assert.match(body, /kind: complete/)
    assert.match(body, /effort: fast/)
    assert.match(body, /outcome: ok/)
    assert.match(body, /usage: \{ input_tokens: 10, output_tokens: 5, reasoning_tokens: 2 \}/)
    assert.match(body, /truncated: false/)
    assert.match(body, /渲染后提示词/)

    const seam2 = llmSeam(fakeLlmCtx(OK_STREAM), cap.record, '闭包站')
    await seam2('p', undefined, { station: '调用点站' })
    await cap.flush()
    assert.match(cap.lastRef('调用点站') ?? '', /^调用点站\/ok-/)
    assert.equal(cap.lastRef('闭包站'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('捕获：调用级失败记 failed+稳定码，错误原样上抛', async () => {
  const { cap, root } = makeCap()
  try {
    const seam = llmSeam(fakeLlmCtx([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '密钥无效' } } },
    ]), cap.record, '判卷')
    await assert.rejects(() => seam('p'), /AUTH/)
    await cap.flush()
    const dir = join(root, 'state', '生成语料', '判卷')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    const body = readFileSync(join(dir, files[0]), 'utf8')
    assert.match(body, /outcome: failed/)
    assert.match(body, /code: AUTH/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('贯通：AgentSeam 站/形态/语义档下行进语料，usage 沿 usageSink 回程进 AgentCallRecord', async () => {
  const { cap, root } = makeCap()
  const records: AgentCallRecord[] = []
  const agent = new AgentSeam({
    complete: llmSeam(fakeLlmCtx(OK_STREAM), cap.record),
    onCall: r => records.push(r),
  }, systemClock)
  try {
    await agent.complete('种子起草', '提示词正文', { effort: 'deep' })
    await cap.flush()
    assert.equal(records.length, 1)
    assert.equal(records[0].station, '种子起草')
    assert.deepEqual(records[0].usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 })
    const body = corpusBody(root, '种子起草')
    assert.match(body, /station: 种子起草/)
    assert.match(body, /kind: complete/)
    assert.match(body, /effort: deep/)
    // repair 形态标签
    await agent.repair('种子起草', '回灌提示词', { effort: 'deep' })
    await cap.flush()
    const dir = join(root, 'state', '生成语料', '种子起草')
    const bodies = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8'))
    assert.ok(bodies.some(b => /kind: repair/.test(b)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('捕获：agentLoop 回路调用进语料（station 沿请求、kind=loop、提示词可读渲染）', async () => {
  const { cap, root } = makeCap()
  const records: AgentCallRecord[] = []
  const agent = new AgentSeam({
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
    const body = corpusBody(root, '罗盘')
    assert.match(body, /station: 罗盘/)
    assert.match(body, /kind: loop/)
    assert.match(body, /【任务】\n回路任务指令/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('装配：createHostRuntime 接好 rt.corpus 与双缝——无 llm 假 ctx 走到适配器抛错并落 failed 语料', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'learnhub-capture-rt-'))
  mkdirSync(join(vault, '学习中心'), { recursive: true })
  try {
    const rt: HostRuntime = createHostRuntime({ tools: { register: () => () => undefined } } as unknown as Context,
      { vault, centerRel: '学习中心' })
    assert.ok(rt.corpus)
    assert.equal(rt.corpus.lastRef('不存在站'), undefined)
    await assert.rejects(() => rt.agent.complete('种子起草', 'p', { effort: 'fast' }))
    await rt.corpus.flush()
    const dir = join(vault, '学习中心', 'state', '生成语料', '种子起草')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^bad-/)
    const body = readFileSync(join(dir, files[0]), 'utf8')
    assert.match(body, /outcome: failed/)
    assert.match(body, /code: LLM_ERROR/)
    assert.equal(rt.corpus.lastRef('种子起草'), `种子起草/${files[0]}`)
  } finally {
    rmSync(vault, { recursive: true, force: true })
  }
})
