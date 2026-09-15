import test from 'node:test'
import assert from 'node:assert/strict'
import { applyId, questionCount, rejectId, requireSkipDirection } from '../src/tool-contracts.ts'
import { withVault } from './helpers/vault.ts'

const REGION_A = [
  'region: 甲区',
  'color: red',
  'blocks:',
  '  - name: 同名块',
  '    nodes:',
  '      - { name: 甲一, pre: [], opt: false, note: "" }',
  '  - name: 甲独有块',
  '    nodes:',
  '      - { name: 甲二, pre: [甲一], opt: false, note: "" }',
].join('\n')

const REGION_B = [
  'region: 乙区',
  'color: blue',
  'blocks:',
  '  - name: 同名块',
  '    nodes:',
  '      - { name: 乙一, pre: [], opt: false, note: "" }',
  '  - name: 唯一块',
  '    nodes:',
  '      - { name: 乙二, pre: [乙一], opt: false, note: "" }',
].join('\n')

const NOTE = [
  '---',
  'node: 甲一',
  'stage: ready',
  'fsrs: null',
  'mastery: 0',
  'content:',
  '  version: 0',
  '  generated_at: null',
  '  status: draft',
  'practice:',
  '  attempts: 0',
  '  correct: 0',
  '---',
  '',
  '# 甲一',
  '',
  '本节点正文用于出题冒烟，足够长。',
].join('\n')

/** 甲区图走 graph/graphFile；乙区图用 files 逃生口补第二张区图（factory 单 graph 槽）。 */
const CONTRACT_VAULT = {
  graph: REGION_A,
  graphFile: '甲区.yaml',
  notes: { 甲一: `${NOTE}\n` },
  files: [{ path: '学习中心/math/data/乙区.yaml', content: `${REGION_B}\n` }],
}

function sixQuestions(): string {
  const questions = Array.from({ length: 6 }, (_, i) => `  - { id: q${i + 1}, kind: true_false, q: 第${i + 1}题成立。, answer: true }`)
  return `node: 甲一\nquestions:\n${questions.join('\n')}\n`
}

test('#12 skip direction must be explicit at the tool boundary', () => {
  assert.equal(requireSkipDirection(true), true)
  assert.equal(requireSkipDirection(false), false)
  for (const missing of [undefined, null, 1, 'true', 'false']) {
    assert.throws(() => requireSkipDirection(missing), /skipped 参数必填.*显式 true.*false/s)
  }
})

test('#12 question count: omitted uses default; supplied zero/negative/fraction/non-number fail', () => {
  assert.equal(questionCount(undefined), 6)
  assert.equal(questionCount(2), 2)
  for (const bad of [0, -1, 2.5, Number.NaN, '6', null]) {
    assert.throws(() => questionCount(bad), /count 必须是正整数/, String(bad))
  }
})

test('#12 engine facade rejects invalid question counts before invoking the model', async () => {
  await withVault(CONTRACT_VAULT, async ({ engine }) => {
    const llm = async (): Promise<string> => { throw new Error('model must not be called') }
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await assert.rejects(() => engine.bank2.questionGenerate('数学', '甲一', bad, llm), /count 必须是正整数/, String(bad))
    }
    const r = await engine.bank2.questionGenerate('数学', '甲一', undefined, async () => sixQuestions())
    assert.equal(r.added, 6, 'omitted count must keep the existing default of 6')
    assert.equal(r.total, 6)
  })
})

test('#12 graph browsing by grouping axis: groups returned, filter + fail loud (#281)', async () => {
  await withVault(CONTRACT_VAULT, async ({ engine }) => {
    // depth 轴（缺省）：跨区图折叠成深度段；节点详情随组携带
    const doc = await engine.graph.graphBrowse('数学') as { axis: string; total: number; groups: Array<{ label: string; nodes: Array<{ node: string }> }> }
    assert.equal(doc.axis, 'depth')
    assert.deepEqual(doc.groups.map(g => g.label), ['L0', 'L1'])
    assert.equal(doc.groups[0]!.nodes.length, 2)
    assert.equal(doc.total, 4)

    // group 过滤：只留所选组；重叠轴下同一节点详情随组重复（多重位置可见）
    const one = await engine.graph.graphBrowse('数学', 'depth', 'L1') as { total: number; groups: Array<{ label: string; nodes: unknown[] }> }
    assert.equal(one.groups.length, 1)
    assert.equal(one.total, 2)

    // 坏组名 fail loud（列出可用组）；坏轴名 fail loud
    await assert.rejects(
      () => engine.graph.graphBrowse('数学', 'depth', '不存在组'),
      (err: unknown) => (err as Error).message.includes('没有组「不存在组」')
        && (err as Error).message.includes('可用'),
    )
    await assert.rejects(
      () => engine.graph.graphBrowse('数学', 'region' as never),
      (err: unknown) => (err as Error).message.includes('非法分组轴'),
    )
  })
})

test('#12 apply/reject id boundaries are strict', () => {
  assert.equal(applyId(undefined), undefined)
  assert.equal(applyId(7), 7)
  for (const bad of [0, -1, 1.5, Number.NaN, '1']) {
    assert.throws(() => applyId(bad), /提案 id 必须是正整数/, `apply ${String(bad)}`)
    assert.throws(() => rejectId(bad), /提案 id 必须是正整数/, `reject ${String(bad)}`)
  }
  assert.equal(rejectId(7), 7)
})
