/**
 * 题目 invokes 出生打标全链（#148）：
 *
 * - 概念清单注入：节点 teaches ∪ 前置闭包 teaches 进提示词（清单缺席 = 门不激活）。
 * - 出生打标受理门：清单在场逐题必须恰一枚 invokes；缺席修复一次（恰一次补标调用），
 *   仍空拒收（负路径）；未在册名字拒收（#141 同门）。
 * - enc 投影：入库后按 invokes 覆盖率投影返回出生 w（随生长批 set_enc 写入）。
 * - 金样本回放闸：固定回放假实现驱动全链，不依赖真实模型（#137 缝）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { LlmComplete, LlmEffort } from '../src/engine/llm.ts'
import { withVault } from './helpers/vault.ts'

/** 录制型假实现：记 prompt，固定回放同一应答。 */
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
  const calls: Array<{ prompt: string }> = []
  const fn: LlmComplete = async prompt => {
    calls.push({ prompt })
    if (!replies.length) throw new Error('脚本化假实现：应答已耗尽')
    return replies.shift()!
  }
  return Object.assign(fn, { calls })
}

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 甲, pre: [], opt: false, note: "", est: 10, teaches: { 自然数: 知道 } }',
  '      - { name: 乙, pre: [甲], opt: false, note: "", est: 20, teaches: { 质数: 会用 } }',
].join('\n')

const REGISTRY = 'concepts:\n  - canonical: 自然数\n  - canonical: 质数\n'

const NOTE_乙 = {
  stage: 'ready',
  content: { version: 1, generatedAt: '2026-09-01', status: 'draft' },
  body: ['# 乙', '', '质数（prime）是大于 1 且只能被 1 和自身整除的自然数，1 不是质数。'],
}

const VAULT = {
  graph: GRAPH,
  notes: { 乙: NOTE_乙 },
  files: [{ path: '学习中心/math/概念登记表.yaml', content: REGISTRY }],
}

/** 金样本：两题各带一枚 invokes（自然数=前置甲教、质数=本节自教）。 */
const GOLD = [
  'node: 乙',
  'questions:',
  '  - id: q1',
  '    kind: true_false',
  '    q: 质数只能被 1 和自身整除。',
  '    answer: true',
  '    invokes: 自然数',
  '  - id: q2',
  '    kind: true_false',
  '    q: 1 是质数。',
  '    answer: false',
  '    invokes: 质数',
].join('\n')

/** 缺 invokes 的金样本（q1 没标）。 */
const GOLD_MISSING = GOLD.replace('\n    invokes: 自然数', '')

test('金样本回放：概念清单注入 + 出生打标入库 + invokes 覆盖率投影（出生 w）', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const fake = replayFake(GOLD)
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake)
    // 拼装证据：提示词附概念清单（本节 teaches ∪ 前置闭包 teaches）
    assert.equal(fake.calls.length, 1, '全部题目已带 invokes → 不触发补标调用')
    assert.match(fake.calls[0].prompt, /## 概念清单/)
    assert.match(fake.calls[0].prompt, /- 自然数/)
    assert.match(fake.calls[0].prompt, /- 质数/)
    // 出生打标入库
    assert.equal(r.added, 2)
    assert.deepEqual(r.rejected, [])
    // 投影：自然数 1/2 → 甲（w=0.5）；质数自教不投影
    assert.deepEqual(r.enc, [{ node: '甲', w: 0.5, note: 'invokes 投影 1/2' }])
  })
})

test('修复一次：缺 invokes 的题经恰一次补标调用回填后入库', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const fake = scriptFake([GOLD_MISSING, '1: 自然数'])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake)
    assert.equal(fake.calls.length, 2, '主调用 + 恰一次补标调用')
    assert.match(fake.calls[1].prompt, /恰一枚/)
    assert.match(fake.calls[1].prompt, /概念清单/)
    assert.match(fake.calls[1].prompt, /质数只能被 1 和自身整除/, '补标调用带缺标题面')
    assert.equal(r.added, 2, '补标成功 → 全部入库')
    assert.deepEqual(r.rejected, [])
    // 分母 = 带 invokes 的全部题（q1 补标自然数 + q2 质数），甲份额 1/2
    assert.deepEqual(r.enc, [{ node: '甲', w: 0.5, note: 'invokes 投影 1/2' }])
  })
})

test('负路径：修复一次仍空 → 拒收并报告；全军仍空 → 整批拒绝入库', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const fake = scriptFake([GOLD_MISSING, '我标注不了'])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake)
    assert.equal(fake.calls.length, 2, '修复恰好一次，不重试')
    assert.equal(r.added, 1, '已带 invokes 的题照常入库')
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0]!.reason, /invokes 未标注恰一枚概念/)
    assert.match(r.rejected[0]!.reason, /修复一次仍不合格/)
  })
  await withVault(VAULT, async ({ engine }) => {
    const allMissing = GOLD.replace('\n    invokes: 自然数', '').replace('\n    invokes: 质数', '')
    const fake = scriptFake([allMissing, '~'])
    await assert.rejects(
      () => engine.bank2.questionGenerate('数学', '乙', undefined, fake),
      /全部未过校验门/,
      '全军缺 invokes 且修复失败 → 一道都没入库',
    )
  })
})

test('invokes 未在册 → 拒收（#141 同门）；清单缺席（无 teaches）→ 门不激活、缺席合法', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const unregistered = GOLD.replace('invokes: 自然数', 'invokes: 集合')
    const fake = replayFake(unregistered)
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake)
    assert.equal(r.added, 1, '在册的质数照常入库')
    assert.ok(r.rejected.some(x => /invokes 概念「集合」未在概念登记表在册/.test(x.reason)))
  })
  await withVault({
    graph: 'region: 基础\ncolor: blue\nblocks:\n  - name: 入门块\n    nodes:\n      - { name: 乙, pre: [], opt: false, note: "", est: 10 }',
    notes: { 乙: NOTE_乙 },
  }, async ({ engine }) => {
    const noInvokes = GOLD.replace(/\n    invokes: \S+/g, '')
    const fake = replayFake(noInvokes)
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake)
    assert.doesNotMatch(fake.calls[0].prompt, /## 概念清单（invokes 只能从这里选/, '无 teaches → 清单缺席 → 门不激活')
    assert.equal(r.added, 2, '清单缺席时 invokes 缺席合法（Missing），不拒收')
    assert.deepEqual(r.enc, [], '零 invokes → 零投影（合法空态）')
  })
})

test('逐节出题同门：清单注入、出生打标入库、投影返回', async () => {
  const NOTE_乙_SECTIONS = {
    stage: 'ready',
    content: {
      version: 1,
      generatedAt: '2026-09-01',
      status: 'draft',
      sections: ['    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }'],
    },
    body: ['# 乙', '', '## 概念：定义', '', '质数（prime）是大于 1 且只能被 1 和自身整除的自然数。'],
  }
  await withVault({ ...VAULT, notes: { 乙: NOTE_乙_SECTIONS } }, async ({ engine }) => {
    const fake = replayFake(GOLD)
    const r = await engine.bank2.questionGenerateSections('数学', '乙', fake)
    assert.match(fake.calls[0].prompt, /## 概念清单/)
    assert.match(fake.calls[0].prompt, /section 字段必须精确写「s1」/)
    assert.equal(r.added, 2)
    assert.deepEqual(r.enc, [{ node: '甲', w: 0.5, note: 'invokes 投影 1/2' }])
  })
})
