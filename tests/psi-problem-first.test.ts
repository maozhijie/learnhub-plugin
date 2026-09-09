/**
 * PS-I 先做后教顺序选项（#81 C-2）：高 bloom/difficulty 节点的生成管线顺序变体。
 *
 * - 路由纯函数：difficulty ≥ 4 或 bloom ∈ {分析,评价,创造} 启用；中低难不反转
 *   （与样例效应按节点难度分流，非全局反转）。
 * - 行为：上下文包注入 §10 挑战节指令（大纲与逐节生成共用同一包）；
 *   大纲落盘 journal 留痕。完成门禁与调度语义零改动（不改 complete/quiz/调度）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { problemFirstOf, nodeProblemFirstOf } from '../src/engine/complexity.ts'
import { withVault } from './helpers/vault.ts'

const PSI_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 高难节点, pre: [], opt: false, note: "", difficulty: 4 }',
  '      - { name: 高bloom节点, pre: [], opt: false, note: "", bloom: 分析 }',
  '      - { name: 平易节点, pre: [], opt: false, note: "", difficulty: 2, bloom: 理解 }',
].join('\n')

test('PS-I 路由真值表：difficulty ≥ 4 或 bloom 高阶层启用，中低难不反转', () => {
  assert.equal(problemFirstOf({ difficulty: 4 }), true)
  assert.equal(problemFirstOf({ difficulty: 5 }), true)
  assert.equal(problemFirstOf({ difficulty: 3 }), false)
  assert.equal(problemFirstOf({ difficulty: 1 }), false)
  assert.equal(problemFirstOf({ bloom: '分析' }), true)
  assert.equal(problemFirstOf({ bloom: '评价' }), true)
  assert.equal(problemFirstOf({ bloom: '创造' }), true)
  assert.equal(problemFirstOf({ bloom: '应用' }), false)
  assert.equal(problemFirstOf({ bloom: '记忆' }), false)
  assert.equal(problemFirstOf({ difficulty: 2, bloom: '理解' }), false)
  assert.equal(problemFirstOf({}), false)
  // difficulty 缺失但 bloom 高阶：仍启用（bloom 单独即可）；反之亦然
  assert.equal(problemFirstOf({ difficulty: 5, bloom: '记忆' }), true)
})

test('PS-I 路由图派生：difficulty/bloom 缺省不启用', () => {
  const g = {
    names: ['甲', '乙'],
    pred: { 甲: [], 乙: [] },
    difficultyOf: { 甲: 5 },
    bloomOf: { 乙: '评价' },
    estOf: {},
  }
  assert.equal(nodeProblemFirstOf(g, '甲'), true)
  assert.equal(nodeProblemFirstOf(g, '乙'), true)
  assert.equal(nodeProblemFirstOf(g, '不存在'), false)
})

test('上下文包：高难节点注入 §10 先做后教指令，平易节点不注入', async () => {
  await withVault({ graph: PSI_GRAPH }, async ({ engine }) => {
    const high = await engine.contentPack('数学', '高难节点')
    assert.match(high, /## 10\. 先做后教（PS-I 顺序变体/)
    assert.match(high, /第一节必须是挑战节/)
    assert.match(high, /标题以「挑战：」开头/)
    assert.match(high, /本节不给解答步骤与答案/)

    const bloom = await engine.contentPack('数学', '高bloom节点')
    assert.match(bloom, /## 10\. 先做后教/)

    const easy = await engine.contentPack('数学', '平易节点')
    assert.doesNotMatch(easy, /先做后教/)
    assert.doesNotMatch(easy, /挑战节/)
  })
})

test('大纲落盘 journal：PS-I 节点留痕「先做后教」，平易节点不留', async () => {
  await withVault({ graph: PSI_GRAPH }, async ({ engine, store }) => {
    const outline = [
      'node: 高难节点',
      'sections:',
      '  - { id: s1, title: 挑战：背包装谁, type: 例题, points: 先自己尝试 }',
      '  - { id: s2, title: 概念：贪心策略, type: 概念, points: 展开解法 }',
      '  - { id: s3, title: 概念：反例与修正, type: 概念, points: 回扣挑战 }',
    ].join('\n')
    await engine.contentOutline('数学', '高难节点', outline)
    const recs = await store.journalTail('数学', 5)
    const outlineRec = recs.find(r => r.kind === 'content_outline')
    assert.ok(outlineRec)
    assert.match(outlineRec.detail, /PS-I 先做后教/)

    const easyOutline = [
      'node: 平易节点',
      'sections:',
      '  - { id: s1, title: 概念：直白讲法, type: 概念, points: 先教后练 }',
    ].join('\n')
    await engine.contentOutline('数学', '平易节点', easyOutline)
    const recs2 = await store.journalTail('数学', 5)
    const easyRec = recs2.find(r => r.node === '平易节点' && r.kind === 'content_outline')
    assert.ok(easyRec)
    assert.doesNotMatch(easyRec.detail, /PS-I/)
  })
})
