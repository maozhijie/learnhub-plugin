/**
 * 宿主→引擎 LLM 补全注入缝（#137）。
 *
 * - 金样本回放：固定回放假实现（带围栏的金样本 YAML）驱动 questionGenerate 全链
 *   （提示词拼装 → 补全 → validateBank 门禁 → 逐题落盘），两个同种子 vault 的
 *   产物字节级一致、报告 deep-equal——回放确定性可断言，不依赖真实模型。
 * - 脚本化应答：按调用序回放不同应答，驱动判卷通道的「解析失败自动重问一次」
 *   （engine 内在重试语义），并断言默认档不传 effort（部署默认档保持不变）。
 * - 档位可观测：引擎内在档位（learnerNoteAdd=fast、receiptSubmit=deep）沿缝声明，
 *   注入侧按 opts.effort 观测；宿主适配器把它翻译成部署的 fastEffort/deepEffort。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LlmComplete, LlmEffort } from '../src/engine/llm.ts'
import { withVault } from './helpers/vault.ts'

/** 录制型假实现：记 prompt/system/语义档，固定回放同一应答。 */
function replayFake(reply: string) {
  const calls: Array<{ prompt: string; system?: string; effort?: LlmEffort }> = []
  const fn: LlmComplete = async (prompt, system, opts) => {
    calls.push({ prompt, system, effort: opts?.effort })
    return reply
  }
  return Object.assign(fn, { calls })
}

/** 脚本化假实现：按调用序逐个回放应答。 */
function scriptFake(replies: string[]) {
  const calls: Array<{ prompt: string; system?: string; effort?: LlmEffort }> = []
  const fn: LlmComplete = async (prompt, system, opts) => {
    calls.push({ prompt, system, effort: opts?.effort })
    if (!replies.length) throw new Error('脚本化假实现：应答已耗尽')
    return replies.shift()!
  }
  return Object.assign(fn, { calls })
}

/** 金样本：模型会包整段 markdown 围栏的题库 YAML（解析侧 parseModel 统一剥离）。 */
const GOLD_BANK = [
  '```yaml',
  'node: 入门',
  'questions:',
  '  - kind: true_false',
  '    q: 金样本题一：自然数从 0 开始计数。',
  '    answer: true',
  '    difficulty: 1',
  '    section: 通用',
  '  - kind: true_false',
  '    q: 金样本题二：1 是质数。',
  '    answer: false',
  '    difficulty: 2',
  '    section: 通用',
  '```',
].join('\n')

const NOTE_WITH_BODY = [
  '---',
  'node: 入门',
  'stage: ready',
  'fsrs: null',
  'content:',
  '  version: 1',
  '  generated_at: "2026-09-01"',
  '  status: draft',
  'practice:',
  '  attempts: 0',
  '  correct: 0',
  '---',
  '',
  '# 入门',
  '',
  '自然数（natural number）是计数的基本对象；0 是否算入依约定，本课程采用含 0 的约定。',
  '质数（prime）是大于 1 且只能被 1 和自身整除的自然数，1 不是质数。',
].join('\n')

test('金样本回放：固定回放假实现驱动出题全链，同种子 vault 产物确定性一致', async () => {
  const run = () => withVault({ tag: 'llm-seam-gold', notes: { 入门: NOTE_WITH_BODY } }, async ({ engine, paths }) => {
    const fake = replayFake(GOLD_BANK)
    const r = await engine.questionGenerate('数学', '入门', undefined, fake)
    // 拼装证据：提示词带内置模板、节点正文与难度锚定段——组装确实发生且可断言
    assert.equal(fake.calls.length, 1)
    assert.match(fake.calls[0].prompt, /金样本题一|自然数/)
    assert.match(fake.calls[0].prompt, /## 难度锚定/)
    // 默认档：出题通道不传 effort（部署默认档保持不变）
    assert.equal(fake.calls[0].effort, undefined)
    const bankPath = join(paths.courseRoot('math'), '题库', '入门.yaml')
    return { r, bank: await readFile(bankPath, 'utf8') }
  })
  const a = await run()
  const b = await run()
  assert.deepEqual(a.r, b.r, '同种子同金样本 → 报告完全一致')
  assert.equal(a.r.added, 2)
  assert.equal(a.r.rejected.length, 0)
  assert.deepEqual(a.r.duplicates, [])
  assert.equal(a.bank, b.bank, '题库落盘字节级一致（含引擎自动编号 q1/q2）')
  assert.match(a.bank, /id: q1/)
  assert.match(a.bank, /id: q2/)
})

test('脚本化应答：判卷解析失败自动重问一次走同一缝，第二答定局', async () => {
  await withVault({
    tag: 'llm-seam-script',
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: [
      'node: 入门',
      'questions:',
      '  - id: a1',
      '    kind: reflection',
      '    q: 用自己的话解释质数。',
      '    answer: 评分要点：大于 1、只有 1 和自身两个因数。',
    ].join('\n') },
  }, async ({ engine }) => {
    const fake = scriptFake([
      '（模型这次答非所问，完全不是 JSON）',
      JSON.stringify({ score: 0.8, feedback: '要点都答到了；举例再具体些。' }),
    ])
    const r = await engine.questionAnswer(fake, '数学', '入门', 'a1', '质数就是只能被 1 和自己整除的数，比如 2、3。', 30)
    assert.equal(fake.calls.length, 2, '解析失败恰好重问一次')
    assert.match(fake.calls[1].prompt, /重判要求/, '重问带纠偏指令')
    assert.equal(r.score, 80, '第二答应答定局（0.8 → 100 分制 80）')
    // 判卷通道恒走部署默认档：缝上不声明语义档
    assert.deepEqual(fake.calls.map(c => c.effort), [undefined, undefined])
  })
})

test('档位沿缝可观测：加我的理解恒 fast 档、回执评审恒 deep 档', async () => {
  const NOTE_SECTIONS = [
    '---',
    'node: 入门',
    'stage: review',
    'fsrs: null',
    'content:',
    '  version: 2',
    '  generated_at: "2026-09-01"',
    '  status: draft',
    '  sections:',
    '    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }',
    'practice:',
    '  attempts: 0',
    '  correct: 0',
    '---',
    '',
    '# 入门',
    '',
    '## 概念：定义',
    '',
    'S1 质数 = 大于 1 且只能被 1 和自身整除的自然数。',
  ].join('\n')
  await withVault({ tag: 'llm-seam-fast', notes: { 入门: NOTE_SECTIONS } }, async ({ engine }) => {
    const fake = replayFake(JSON.stringify({
      verdict: '对',
      tags: [],
      advice: '可再举一个非质数的反例（如 4 = 2×2）对照。',
      reply: '**对**：定义准确。',
    }))
    await engine.learnerNoteAdd('数学', '入门', { content: '质数是只有两个因数的数。', kind: 'recall_cue' }, fake)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].effort, 'fast', '自注反馈 = 机械调用，缝上声明 fast 档')
  })
  const GRAPH_PRACTICE = [
    'region: 基础',
    'color: blue',
    'blocks:',
    '  - name: 入门块',
    '    nodes:',
    '      - { name: 练耳, pre: [], opt: false, note: "", est: 20, type: practice }',
  ].join('\n')
  await withVault({ tag: 'llm-seam-deep', graph: GRAPH_PRACTICE, notes: { 练耳: {} } }, async ({ engine }) => {
    const fake = replayFake(JSON.stringify({
      score: 0.9,
      verdict: '节奏稳',
      errors: [{ point: '要点A', issue: '音程听反', advice: '先定基准音' }],
    }))
    await engine.receiptSubmit('数学', '练耳', { kind: 'text', material: '今天练了 30 分钟音程听辨' }, fake)
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].effort, 'deep', '回执评审带逐条拆解，缝上声明 deep 档')
  })
})
