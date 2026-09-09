import test from 'node:test'
import assert from 'node:assert/strict'
import { withVault } from './helpers/vault.ts'
import type { NoteSeed } from './helpers/vault.ts'

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 前置概念, pre: [], opt: false, note: "", est: 15 }',
  '      - { name: 入门, pre: [前置概念], opt: false, note: "", est: 20 }',
].join('\n')

/** 带 manifest（s1/s2 两节）与正文的入门笔记种子（noteText 逐字生成原 NOTE 常量）。 */
const NOTE: NoteSeed = {
  stage: 'review',
  content: {
    version: 2,
    generatedAt: '2026-09-01',
    sections: [
      '    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }',
      '    - { id: s2, title: "例题：应用", type: 例题, status: ready, version: 0 }',
    ],
  },
  practice: { attempts: 3, correct: 1 },
  body: [
    '# 入门',
    '',
    '## 概念：定义',
    '',
    'S1 勾股定理说的是直角三角形两直角边与斜边的平方关系。',
    '',
    '## 例题：应用',
    '',
    'S2 已知两直角边求斜边的完整例题演示。',
    '',
    '## 练习',
    '',
    '（练习占位）',
  ],
}

const BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: single_choice',
  '    q: 直角三角形两直角边为 3 和 4，斜边长为？',
  '    options: ["5", "6", "7", "8"]',
  '    answer: A',
  '    explanation: 勾股定理 √(3²+4²)=5。',
  '    section: s1',
  '  - id: q2',
  '    kind: fill_in_blank',
  '    q: 判断斜边长度的定理叫____。',
  '    answer: ["勾股定理"]',
  '    section: 例题：应用',
  '  - id: q3',
  '    kind: true_false',
  '    q: 直角边可以为负数。',
  '    answer: false',
  '    section: 已删除的节',
].join('\n')

/** 讲解包 vault：两节点图 + manifest 笔记 + 混合题型题库。 */
const explainVault = () => ({
  tag: 'learnhub-explain-',
  graph: GRAPH,
  notes: { 入门: NOTE },
  banks: { 入门: BANK },
})

test('讲解包：答错场景含题面/答案/解析/本次作答/判语/对应节正文/渐退教法指令', async () => {
  await withVault(explainVault(), async ({ engine }) => {
    await engine.store.appendPractice({
      course: '数学', node: '入门', ex: 1, answer: 'B',
      correct: false, judge: 'single_choice', qid: 'q1',
      feedback: '勾股定理用错了：斜边平方 = 两直角边平方之和。',
      ts: '2026-09-08T10:00:00',
    })
    const pack = await engine.errorExplainPack('数学', '入门', 'q1')
    // 题目与答案（questionView 不带答案，讲解包必须带全）
    assert.match(pack, /直角三角形两直角边为 3 和 4/)
    assert.match(pack, /A\. 5/)
    assert.match(pack, /正确答案\*\*：A/)
    assert.match(pack, /勾股定理 √\(3²\+4²\)=5/)
    // 本次作答与判语
    assert.match(pack, /学习者的作答：B/)
    assert.match(pack, /判卷：答错（single_choice）/)
    assert.match(pack, /判卷反馈：勾股定理用错了/)
    // 节定位命中 s1（题绑节 id）→ 该节正文而非整课
    assert.match(pack, /来自节「概念：定义」/)
    assert.match(pack, /S1 勾股定理说的是/)
    assert.doesNotMatch(pack, /S2 已知两直角边/)
    // 渐退教法指令与图位置
    assert.match(pack, /完整解法/)
    assert.match(pack, /半成品/)
    assert.match(pack, /独立重做/)
    assert.match(pack, /不要泛泛重讲整课/)
    assert.match(pack, /前置：前置概念/)
  })
})

test('讲解包：忘记申报场景带忘记标记；旧题按节标题回退定位', async () => {
  await withVault(explainVault(), async ({ engine }) => {
    await engine.store.appendPractice({
      course: '数学', node: '入门', ex: 2, answer: '',
      correct: false, judge: 'forget', qid: 'q2', ts: '2026-09-08T11:00:00',
    })
    const pack = await engine.errorExplainPack('数学', '入门', 'q2')
    assert.match(pack, /申报了\*\*忘记\*\*/)
    assert.match(pack, /讲解要从头建立/)
    // q2.section = 「例题：应用」（标题原文，旧题形态）→ 标题精确命中 s2
    assert.match(pack, /来自节「例题：应用」/)
    assert.match(pack, /S2 已知两直角边/)
  })
})

test('讲解包：节映射失败退化为整课节选并明示，不崩', async () => {
  await withVault(explainVault(), async ({ engine }) => {
    const pack = await engine.errorExplainPack('数学', '入门', 'q3')
    assert.match(pack, /未能把这道题精确定位到某一节/)
    assert.match(pack, /S1 勾股定理说的是/) // 整课节选兜底
    assert.match(pack, /## 讲解要求（渐退教法）/) // 指令仍然完整
  })
})

test('讲解包：无流水记录时如实说明（按主动求助理解）', async () => {
  await withVault(explainVault(), async ({ engine }) => {
    const pack = await engine.errorExplainPack('数学', '入门', 'q1')
    assert.match(pack, /流水里没有本次作答记录/)
  })
})
