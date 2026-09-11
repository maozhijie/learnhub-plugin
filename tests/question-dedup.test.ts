import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  normalizeStem,
  trigramSimilarity,
  findDuplicateStem,
  existingStemsPromptBlock,
  DUPLICATE_SIMILARITY_THRESHOLD,
} from '../src/engine/question-dedup.ts'
import { withVault } from './helpers/vault.ts'

// ---- 纯函数：归一化 / trigram 相似度 / 查重 ----

test('normalizeStem：去空白/标点、casefold——只留内容字符', () => {
  assert.equal(normalizeStem('  什么是 大三度？ '), '什么是大三度')
  assert.equal(normalizeStem('What is a Major Third?'), 'whatisamajorthird')
  assert.equal(normalizeStem('大三度（4 个半音）。'), '大三度4个半音')
})

test('trigramSimilarity：同串 = 1，近串 ≥ 0.8，异串低于阈值；空串 = 0', () => {
  assert.equal(trigramSimilarity('什么是大三度', '什么是大三度'), 1)
  assert.ok(trigramSimilarity('什么是大三度呢', '什么是大三度') >= DUPLICATE_SIMILARITY_THRESHOLD,
    '仅加语气词的近串应达到阈值')
  assert.ok(trigramSimilarity('小三度有几个半音', '什么是大三度') < DUPLICATE_SIMILARITY_THRESHOLD,
    '不同考点的串应低于阈值')
  assert.equal(trigramSimilarity('', '什么是大三度'), 0)
  assert.equal(trigramSimilarity('。。', '。。'), 0, '纯标点归一化为空，不与任何题相似')
})

test('findDuplicateStem：精确归一化命中返回对方原题面；无命中返回 null', () => {
  const existing = [{ q: '什么是大三度？' }, { q: '小三度 = 几个半音？' }]
  assert.equal(findDuplicateStem('什么是大三度?', existing), '什么是大三度？', '标点差异经归一化后精确命中')
  assert.ok(findDuplicateStem('什么是大三度呢？？？', existing) !== null, '近重复（trigram）命中')
  assert.equal(findDuplicateStem('完全另一道题：FSRS 的 S 是什么', existing), null)
  assert.equal(findDuplicateStem('什么是大三度？', []), null)
})

test('existingStemsPromptBlock：清单只含题面/题型/难度（不含答案），超量截尾', () => {
  const block = existingStemsPromptBlock([
    { q: '什么是大三度？', kind: 'single_choice', difficulty: 1 },
    { q: '小三度 = 几个半音？', kind: 'numeric', difficulty: 2 },
  ])
  assert.match(block, /题库已有题目/)
  assert.match(block, /什么是大三度/)
  assert.match(block, /single_choice/)
  assert.match(block, /难度1/)
  assert.doesNotMatch(block, /answer|答案[:：]/, '清单不带答案')

  const many = Array.from({ length: 20 }, (_, i) => ({ q: `题面${i}`, kind: 'true_false' as const }))
  const lines = existingStemsPromptBlock(many).split('\n').filter(l => /^\d+\./.test(l))
  assert.equal(lines.length, 15, '最多注入 15 条')
  assert.match(lines[lines.length - 1]!, /题面19/, '截尾保留最近的题')
})

// ---- 引擎集成：出题路径注入 + 程序化查重拦截与报告 ----

test('#119 questionGenerate：注入已有题面；精确与近重复丢弃入库并报告', async () => {
  await withVault({
    notes: {
      入门: {
        body: ['# 入门', '', '## 概念：大三度', '', '大三度 = 4 个半音，口诀「大=宽」。'],
      },
    },
    banks: {
      入门: [
        'node: 入门',
        'questions:',
        '  - id: q1',
        '    kind: single_choice',
        '    q: 什么是大三度？',
        '    options: ["4 个半音", "3 个半音", "5 个半音", "2 个半音"]',
        '    answer: A',
        '    difficulty: 1',
      ].join('\n'),
    },
  }, async ({ engine, paths }) => {
    const prompts: string[] = []
    const r = await engine.questionGenerate('数学', '入门', 3, async prompt => {
      prompts.push(prompt)
      return [
        'node: 入门',
        'questions:',
        '  - kind: single_choice', // 与既有 q1 精确重复（标点差异）
        '    q: 什么是大三度?',
        '    options: ["4 个半音", "3 个半音", "5 个半音", "2 个半音"]',
        '    answer: A',
        '  - kind: true_false', // 近重复（仅加语气词）
        '    q: 什么是大三度呢？',
        '    answer: true',
        '  - kind: true_false', // 全新考点，应入库
        '    q: 小三度有几个半音？',
        '    answer: true',
      ].join('\n')
    })
    assert.equal(r.added, 1, '只有全新考点入库')
    assert.equal(r.duplicates.length, 2, '精确 + 近重复各拦一道')
    assert.match(r.duplicates[0]!.against, /什么是大三度？/, '报告命中对方原题面')
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.equal(bank.questions.length, 2, '题库 = 既有 1 + 新增 1')
    assert.match(prompts[0], /题库已有题目/)
    assert.match(prompts[0], /什么是大三度？/)
    assert.doesNotMatch(prompts[0], /4 个半音.*选项/, '注入清单不含答案内容')
  })
})

test('#119 questionGenerateSections：逐节路径同款查重', async () => {
  await withVault({
    notes: {
      入门: {
        content: { sections: ['    - id: s1', '      title: 概念：大三度', '      type: 概念', '      status: ready', '      version: 1'] },
        body: ['# 入门', '', '## 概念：大三度', '', '大三度 = 4 个半音。'],
      },
    },
    banks: {
      入门: [
        'node: 入门',
        'questions:',
        '  - id: q1',
        '    kind: true_false',
        '    q: 大三度有 4 个半音。',
        '    answer: true',
      ].join('\n'),
    },
  }, async ({ engine }) => {
    const r = await engine.bank2.questionGenerateSections('数学', '入门', async () => [
      'questions:',
      '  - kind: true_false',
      '    q: 大三度有 4 个半音。', // 精确重复 → 丢弃
      '    answer: true',
      '  - kind: fill_in_blank',
      '    q: 大三度和小三度由____数区分。',
      '    answer: ["半音"]', // 新题 → 入库（答案为唯一写法术语，ADR-0029）
    ].join('\n'))
    assert.equal(r.added, 1)
    assert.equal(r.duplicates, 1)
    assert.equal(r.sections, 1)
  })
})

test('#119 noteSourceGenerate：镜像题库同款注入与查重，指纹与初始化照常', async () => {
  await withVault({
    files: [{ path: '我的笔记/费曼技巧.md', content: '# 费曼技巧\n\n费曼技巧 = 把概念讲给完全不懂的人听。\n' }],
  }, async ({ engine, paths }) => {
    await engine.channels.noteSourceRegister('我的笔记/费曼技巧.md')
    const first = await engine.channels.noteSourceGenerate('note-1', undefined, async () => [
      'node: note-1',
      'questions:',
      '  - kind: true_false',
      '    q: 费曼技巧的核心是把概念讲给外行听。',
      '    answer: true',
    ].join('\n'))
    assert.equal(first.added, 1)
    assert.equal(first.duplicates.length, 0)

    // 第二次：一道精确重复（丢弃）+ 一道新题（入库）
    const second = await engine.channels.noteSourceGenerate('note-1', 2, async () => [
      'node: note-1',
      'questions:',
      '  - kind: true_false',
      '    q: 费曼技巧的核心是把概念讲给外行听。',
      '    answer: true',
      '  - kind: fill_in_blank',
      '    q: 费曼技巧里卡壳处说明该处____。',
      '    answer: ["没懂"]',
    ].join('\n'))
    assert.equal(second.added, 1)
    assert.equal(second.duplicates.length, 1)
    assert.match(second.duplicates[0]!.against, /讲给外行听/, '报告命中对方原题面')
    assert.equal(second.total, 2)

    const log = await readFile(join(paths.noteSourceDir, '题库', 'note-1.yaml'), 'utf8')
    assert.match(log, /卡壳处/)
  })
})
