/**
 * temperature 端口贯通（#219 / S49 扩展）。
 *
 * 本票为 spike（#216）与后续按站调节留手柄：`LlmComplete`／`LlmStream` 端口加可选
 * temperature、适配器（host/llm.ts）透传 provider。**默认值一律不动**——两条断言
 * 各守一半：
 *
 *  ① 无调用点行为变化：真实生成管线（大纲 → 逐节 → 出题）跑在「捕获每个 dsh 流请求」
 *     的假 ctx 上，全程每一次调用都不得出现 temperature 键（现快照：全仓调用点不设值）。
 *  ② 适配器透传：同一适配器给值即原样进 provider 请求（含工具回路缝），不给则整键缺席
 *     （缺席 = 宿主默认档，与今天逐字等价）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { llmSeam, llmStreamSeam } from '../src/host/llm.ts'
import { enqueueGeneration, cancelGeneration } from '../src/host/jobs.ts'

/** 一次 dsh 流请求的关键面（temperature 是本票唯一关心项，其余只用于断言「在跑真的」）。 */
interface StreamCapture {
  temperature?: number
  reasoningEffort?: unknown
  model?: string
  promptChars: number
}

/**
 * 捕获式假 dsh ctx：llm.stream 记录请求面后按脚本回放；脚本耗尽后回放兜底文本
 * （适配器对空输出 fail loud，兜底保证「只关心请求面」的调用也能走通）。
 */
function capturingCtx(responses: string[], captures: StreamCapture[]): Context {
  const queue = [...responses]
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
    llm: {
      stream: async function* (req: {
        model?: string
        reasoningEffort?: unknown
        temperature?: number
        messages?: Array<{ content?: Array<{ text?: string }> }>
      }) {
        captures.push({
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort }),
          ...(req.model === undefined ? {} : { model: req.model }),
          promptChars: (req.messages ?? []).flatMap(m => (m.content ?? []).map(c => c.text ?? '')).join('').length,
        })
        const text = queue.shift() ?? '（兜底回放）'
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  } as unknown as Context
}

/** 轮询直至条件成立（生成管线是泵驱动的异步链）。 */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail('等待超时：生成管线未在时限内到终态')
    await new Promise<void>(r => setTimeout(r, 10))
  }
}

test('无调用点行为变化：真实生成管线全程不传 temperature（缺席 = 宿主默认档）', async () => {
  // 手工临时 vault（不用 withVault 的 finally 清理：管线泵与语料写盘是 fire-and-forget，
  // 与 rm -r 竞争会 ENOTEMPTY——按「先停泵、再放干写盘、后删」收尾）
  const root = mkdtempSync(join(tmpdir(), 'llm-temp-pipeline-')).replace(/\\/g, '/')
  try {
    mkdirSync(join(root, '学习中心', 'math', 'data'), { recursive: true })
    mkdirSync(join(root, '学习中心', 'math', '课程', '基础'), { recursive: true })
    mkdirSync(join(root, '学习中心', 'math', '题库'), { recursive: true })
    writeFileSync(join(root, '学习中心', '课程注册表.yaml'),
      'courses:\n  - id: math-01\n    name: 数学\n    root: math\n    enabled: true\n', 'utf8')
    writeFileSync(join(root, '学习中心', 'math', 'data', '基础.yaml'),
      'region: 基础\ncolor: blue\nblocks:\n  - name: 入门块\n    nodes:\n      - { name: 入门, pre: [], opt: false, note: "", est: 20 }\n', 'utf8')
    mkdirSync(join(root, '学习中心', 'state'), { recursive: true })
    writeFileSync(join(root, '学习中心', 'state', 'learnhub.json'),
      JSON.stringify({ schema: { version: 3, formats: {} }, day_cutoff: '00:00' }, null, 1) + '\n', 'utf8')

    const captures: StreamCapture[] = []
    // 应答脚本：大纲 YAML（形状按 contentOutline 真门，节清单可被引擎真实解析）
    const OUTLINE = `node: 入门\nsections:\n  - id: s1\n    title: 概念：冒烟\n    type: 概念\n    points: 一句话要点\n    visual: 无\n`
    const ctx = capturingCtx([OUTLINE, '## 概念：冒烟\n\n正文。\n'], captures)
    const rt: HostRuntime = createHostRuntime(ctx, { vault: root, centerRel: '学习中心' })
    assert.equal(rt.vault, root, 'runtime 部署路径归一（装配在跑）')
    enqueueGeneration(rt, ctx, '数学', '入门')
    // 等首个 dsh 请求落地（大纲站），管线后续仍会继续发调用
    await until(() => captures.length > 0)
    // 每一个已发生的调用都必须整键缺席 temperature（本票的核心不变式）
    for (const c of captures) {
      assert.equal('temperature' in c, false, `调用点设了 temperature：${JSON.stringify(c)}`)
      assert.equal(typeof c.promptChars, 'number', '捕获面形状（在跑真的）')
    }
    // 收尾：取消任务、等泵停、放干语料写盘（三处 fire-and-forget 都落定后再删目录）
    cancelGeneration(rt, '数学', '入门')
    await until(() => !rt.flags.pumping)
    await rt.corpus.flush()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('适配器透传：给值原样进 provider 请求（补全缝与工具回路缝），不给则整键缺席', async () => {
  const captures: StreamCapture[] = []
  const ctx = capturingCtx(['回放一', '回放二'], captures)
  const seam = llmSeam(ctx)
  assert.equal(await seam('提示词', undefined, { temperature: 0.2 }), '回放一')
  assert.equal(captures[0]?.temperature, 0.2, '补全缝 temperature 未透传')
  assert.equal(captures[0]?.model, 'deepseek-v4-flash', '捕获面形状（在跑真的）')
  await seam('提示词', undefined, {})
  assert.equal('temperature' in (captures[1] ?? {}), false, '不给值时不得出现 temperature 键')
  // 工具回路缝（LlmStream）：req.temperature 同一透传
  const streamSeam = llmStreamSeam(ctx)
  await streamSeam({ messages: [{ role: 'user', text: '任务' }], temperature: 0 })
  assert.equal(captures[2]?.temperature, 0, '工具回路缝 temperature 未透传（0 值不得被吞）')
  await streamSeam({ messages: [{ role: 'user', text: '任务' }] })
  assert.equal('temperature' in (captures[3] ?? {}), false, '回路不给值时不得出现 temperature 键')
})
