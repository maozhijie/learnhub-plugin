/**
 * 出题第二意见门（#223 / ADR-0063）剧本测试：
 *
 * - 键错样本被拦：独立解与键不一致 → 恰一次回灌修复 → 修复仍不一致 → 弃题不阻塞整批。
 * - 修复轮改好：修复题原位替换后再审计，一致才入库。
 * - 等价表述不误拒：填空可接受答案数组白名单（normBlank 归一）与 numeric/tol 容差。
 * - 逃生门：解题应答不可解析 = 审计失败保守放行（unresolved），不等于键错。
 * - 抽样与成本可见：报告带 rate/eligible/sampled/inconsistent/repaired/discarded/solverCalls。
 * - 抽样确定性：等距 + 高难度（difficulty 3）恒入样；rate 缺席/0 = 关门；非法值 fail loud。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { LlmComplete } from '../src/engine/llm.ts'
import { sampleAuditIndices, parseSolverReply, solverPromptFor } from '../src/engine/question-audit.ts'
import { withVault } from './helpers/vault.ts'

/** 脚本化假实现：按调用序逐个回放应答（记录全部 prompt 供断言）。 */
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
  '      - { name: 乙, pre: [], opt: false, note: "", est: 10 }',
].join('\n')

const NOTE_乙 = {
  stage: 'ready',
  content: { version: 1, generatedAt: '2026-09-01', status: 'draft' },
  body: ['# 乙', '', '质数（prime）是大于 1 且只能被 1 和自身整除的自然数，1 不是质数，100 以内有 25 个质数。'],
}

const VAULT = { graph: GRAPH, notes: { 乙: NOTE_乙 } }

const SOLVE_TRUE = '{"answer": true, "steps": "定义如此"}'
const SOLVE = (v: string, steps = '我自己解的') => `{"answer": ${v}, "steps": "${steps}"}`

/** 四题金样本：q1 判断、q2 填空（可接受答案数组 = 同义白名单）、q3 数值（difficulty 3）、
 * q4 反思（AI 判卷题型，不在审计面）。无 teaches → invokes 门不激活，不产生补标调用。
 * 抽样推导（rate 0.25）：eligible=3（q1/q2/q3），k=round(0.75)=1 → 等距取 q1；
 * q3 difficulty 3 恒入样 → 样本 = [q1, q3]，q2 不入样。 */
const GOLD4 = [
  'node: 乙',
  'questions:',
  '  - id: q1',
  '    kind: true_false',
  '    q: 质数只能被 1 和自身整除。',
  '    answer: true',
  '    difficulty: 1',
  '  - id: q2',
  '    kind: fill_in_blank',
  '    q: 只能被 1 和自身整除的大于 1 的自然数叫____。',
  "    answer: ['质数', '素数']",
  '    difficulty: 1',
  '  - id: q3',
  '    kind: numeric',
  '    q: 100 以内质数的个数是多少？',
  "    answer: '25'",
  '    tol: 0.01',
  '    difficulty: 3',
  '  - id: q4',
  '    kind: reflection',
  '    q: 谈谈质数在密码学里的作用。',
  '    answer: 评分要点',
].join('\n')

const QUIZ_ONE = [
  'node: 乙',
  'questions:',
  '  - id: q1',
  '    kind: numeric',
  '    q: 100 以内质数的个数是多少？',
  "    answer: '25'",
  '    tol: 0.01',
  '    difficulty: 3',
].join('\n')

const REPAIR_Q3 = [
  'questions:',
  '  - kind: numeric',
  '    q: 100 以内质数的个数是多少？',
  "    answer: '25'",
  '    tol: 0.01',
  '    difficulty: 3',
].join('\n')

test('键错样本被拦：独立解不一致 → 恰一次修复 → 修复产出不可用 → 弃题不阻塞整批', async () => {
  await withVault(VAULT, async ({ engine }) => {
    // 脚本序：主调用 → q1 解题（一致）→ q3 解题（错答 17）→ 修复轮（不可解析 = 修复失败，弃题）
    const fake = scriptFake([GOLD4, SOLVE_TRUE, SOLVE('17'), '我改不了这道题'])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 0.25 } })
    assert.equal(fake.calls.length, 4, '主调用 + 解题×2 + 修复×1（修复不可用不再重审）')
    assert.equal(r.added, 3, 'q1/q2/q4 照常入库——弃题不阻塞整批')
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0]!.reason, /第二意见/)
    assert.match(r.rejected[0]!.reason, /修复轮未产出可用修正/)
    assert.deepEqual(r.secondOpinion, {
      rate: 0.25, eligible: 3, sampled: 2, inconsistent: 1, repaired: 0, discarded: 1, unresolved: 0, solverCalls: 2,
    }, '报告可见：抽样率/抽样数/不一致/弃题/成本（解题调用数）')
  })
})

test('修复轮改好：修复题原位替换后再审计，一致才入库', async () => {
  await withVault(VAULT, async ({ engine }) => {
    // 单数值题 difficulty 3 恒入样；主调用 → 解题错（99）→ 修复轮改键为 25 → 重审一致
    const fake = scriptFake([QUIZ_ONE, SOLVE('99'), REPAIR_Q3, SOLVE('25', '容差内')])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 0.25 } })
    assert.equal(r.added, 1, '修复后的键与独立解一致 → 入库')
    assert.equal(r.secondOpinion!.repaired, 1)
    assert.equal(r.secondOpinion!.discarded, 0)
    assert.equal(r.secondOpinion!.solverCalls, 2, '首轮解题 + 修复后再审计')
    assert.match(fake.calls[2]!.prompt, /答案键不一致/, '修复调用回灌不一致原因')
    assert.match(fake.calls[2]!.prompt, /独立解题的答案/, '修复调用带独立解对照')
  })
})

test('等价表述不误拒：填空白名单（同义写法）与 numeric/tol 容差一致即放行', async () => {
  await withVault(VAULT, async ({ engine }) => {
    // rate 1 → 全部客观题入样（q1/q2/q3，反思题不在审计面）；
    // 主调用 → q2 独立解「二」（白名单第二形态）→ q3 独立解 25.001（tol 内）
    const fake = scriptFake([GOLD4, SOLVE_TRUE, SOLVE('"素数"', '同义写法'), SOLVE('25.001')])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 1 } })
    assert.equal(r.added, 4, '全部入库——等价写法与容差都不误拒')
    assert.equal(r.secondOpinion!.inconsistent, 0)
    assert.equal(r.secondOpinion!.sampled, 3)
    assert.equal(r.secondOpinion!.solverCalls, 3)
  })
})

test('逃生门：解题应答不可解析 = 审计失败保守放行（unresolved），不弃题', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const fake = scriptFake([QUIZ_ONE, '我觉得这道题没法答成 JSON'])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 1 } })
    assert.equal(r.added, 1, '审计失败不杀人')
    assert.equal(r.secondOpinion!.unresolved, 1)
    assert.equal(r.secondOpinion!.discarded, 0)
    assert.equal(r.secondOpinion!.solverCalls, 1, '不重试解题调用')
  })
})

test('反思题不在审计面；rate 缺席 = 关门；非法率 fail loud', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const onlyReflection = [
      'node: 乙', 'questions:',
      '  - id: q1', '    kind: reflection', '    q: 谈谈质数。', '    answer: 评分要点',
    ].join('\n')
    const fake = scriptFake([onlyReflection])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 1 } })
    assert.equal(fake.calls.length, 1, '无可对账客观题 → 零解题调用')
    assert.equal(r.added, 1)
    assert.equal(r.secondOpinion!.sampled, 0)
  })
  await withVault(VAULT, async ({ engine }) => {
    const fake = scriptFake([GOLD4])
    const r = await engine.bank2.questionGenerate('数学', '乙', undefined, fake)
    assert.equal(fake.calls.length, 1, 'secondOpinion 缺席 = 门未开（引擎级显式 opt-in）')
    assert.equal(r.secondOpinion, undefined)
  })
  await withVault(VAULT, async ({ engine }) => {
    const fake = scriptFake([GOLD4])
    await assert.rejects(
      () => engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 1.5 } }),
      /抽样率/,
      '抽样率 >1 fail loud，不静默改写',
    )
  })
})

test('solver 提示词不泄键：零答案零解析；rate 0 = 关门', async () => {
  await withVault(VAULT, async ({ engine }) => {
    const fake = scriptFake([GOLD4])
    await engine.bank2.questionGenerate('数学', '乙', undefined, fake, { secondOpinion: { rate: 0 } })
    assert.equal(fake.calls.length, 1, 'rate 0 = 关门，无解题调用')
  })
  const prompt = solverPromptFor({
    kind: 'fill_in_blank', q: '大于 1 的最小质数是____。', answer: ['2', '二'], explanation: '2 是唯一的偶质数。',
  })
  assert.ok(prompt.includes('大于 1 的最小质数'))
  assert.ok(!prompt.includes("'2'") && !prompt.includes('偶质数'), '答案键与解析不得进解题提示词')
})

test('逐节出题同门：修复仍不一致 → 弃题（单题批零入库不抛整批错误）', async () => {
  await withVault({
    ...VAULT,
    notes: {
      乙: {
        stage: 'ready',
        content: {
          version: 1,
          generatedAt: '2026-09-01',
          status: 'draft',
          sections: ['    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }'],
        },
        body: ['# 乙', '', '## 概念：定义', '', '100 以内有 25 个质数。'],
      },
    },
  }, async ({ engine }) => {
    // 脚本序：逐节出题主调用（difficulty 3 恒入样）→ 解题（错）→ 修复轮（键原样）→ 重审（仍错）
    const fake = scriptFake([QUIZ_ONE, SOLVE('17'), REPAIR_Q3, SOLVE('17')])
    const r = await engine.bank2.questionGenerateSections('数学', '乙', fake, { secondOpinion: { rate: 0.25 } })
    assert.equal(r.added, 0)
    assert.equal(r.secondOpinion!.discarded, 1, '修复一轮仍不一致 → 弃题')
    assert.equal(r.secondOpinion!.repaired, 0)
    assert.equal(r.secondOpinion!.solverCalls, 2)
  })
})

// ---- 纯函数：抽样确定性与应答容错解析 ----

test('抽样：等距确定性 + 高难度恒入样 + rate 0/极小批语义', () => {
  // 6 题 rate 1/4 → k=round(1.5)=2：等距取 0、3
  assert.deepEqual(sampleAuditIndices(6, 0.25, [1, 1, 1, 1, 1, 1]), [0, 3])
  // difficulty 3 加权：不在等距样内也恒入样
  assert.deepEqual(sampleAuditIndices(6, 0.25, [1, 3, 1, 1, 1, 1]), [0, 1, 3])
  // 小批取整：n=1 rate 0.25 → k=0 不抽（小批成本保护）；difficulty 3 仍恒入样
  assert.deepEqual(sampleAuditIndices(1, 0.25, [1]), [])
  assert.deepEqual(sampleAuditIndices(1, 0.25, [3]), [0])
  // rate 1 = 全样
  assert.deepEqual(sampleAuditIndices(3, 1, [1, 1, 1]), [0, 1, 2])
})

test('解题应答容错解析：围栏/尾逗号/缺 answer 拒绝', () => {
  assert.deepEqual(parseSolverReply('{"answer": "A", "steps": "排除法"}'), { answer: 'A', steps: '排除法' })
  assert.deepEqual(parseSolverReply('```json\n{"answer": ["A","C"],}\n```'), { answer: ['A', 'C'] })
  assert.deepEqual(parseSolverReply('前置说明 {"answer": true} 后置说明'), { answer: true })
  assert.throws(() => parseSolverReply('没有对象'), /JSON 对象/)
  assert.throws(() => parseSolverReply('{"steps": "没答"}'), /answer/)
})
