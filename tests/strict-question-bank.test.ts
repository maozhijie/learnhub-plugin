import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withVault } from './helpers/vault.ts'

/** 节点笔记：ready 缺省 + 存量 mastery: 0（fmExtra 行）。 */
const NOTE = { fmExtra: ['mastery: 0'] }

const BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: single_choice',
  '    q: 1+1=？',
  '    options: ["A. 2", "B. 3"]',
  '    answer: A',
  '    difficulty: 1',
  '  - id: q2',
  '    kind: true_false',
  '    q: 2 是质数。',
  '    answer: true',
].join('\n')

test('#8 missing bank remains a legal empty bank', async () => {
  await withVault({ notes: { 入门: NOTE } }, async ({ engine }) => {
    assert.deepEqual(await engine.bank.load(engine.paths.courseRoot('math'), '入门'), { node: '入门', questions: [] })
    const list = await engine.content2.questions('数学', '入门')
    assert.equal(list.questions.length, 0)
    const report = await engine.dataCheck()
    assert.equal(report.byArea.question_bank.missing, 1)
    assert.equal(report.byArea.question_bank.broken, 0)
  })
})

test('#8 present malformed bank blocks load/list and reports Broken without mutating', async () => {
  const corrupt = BANK.replace('true_false', 'impossible')
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: `${corrupt}\n` } }, async ({ engine }) => {
    const courseRoot = engine.paths.courseRoot('math')
    await assert.rejects(() => engine.bank.load(courseRoot, '入门'), /题库 Broken.*入门\.yaml[\s\S]*impossible/s)
    await assert.rejects(() => engine.content2.questions('数学', '入门'), /题库 Broken/s)
    await assert.rejects(() => engine.bank2.questionGet('数学', '入门', 'q1'), /题库 Broken/s)
    await assert.rejects(() => engine.bank2.questionUpdate('数学', '入门', 'q1', { q: '改写题干' }), /题库 Broken/s)
    await assert.rejects(() => engine.bank2.questionAdd('数学', '入门', { kind: 'true_false', q: 'x', answer: true }), /题库 Broken/s)
    const report = await engine.dataCheck()
    assert.equal(report.byArea.question_bank.broken, 1)
    const before = await readFile(join(engine.paths.courseRoot('math'), '题库', '入门.yaml'), 'utf8')
    assert.ok(before.includes('impossible'), 'corrupt bank was overwritten')
  })
})

test('#8 YAML parse failure is Broken, not an empty bank', async () => {
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: 'node: 入门\nquestions:\n  - { kind: true_false, q: "x\n' } }, async ({ engine }) => {
    await assert.rejects(() => engine.content2.questions('数学', '入门'), /题库 Broken.*YAML 无法解析/s)
  })
})

test('#8 question revision rejects empty, unknown, identity, scheduler, statistics, and archive fields', async () => {
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: `${BANK}\n` } }, async ({ engine }) => {
    const rejected: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /patch 不能为空/],
      [{ bogus: 1 }, /不允许的字段/],
      [{ id: 'q9' }, /不允许的字段/],
      [{ kind: 'true_false' }, /不允许的字段/],
      [{ node: '别人' }, /不允许的字段/],
      [{ fsrs: { reps: 9 } }, /不允许的字段/],
      [{ stats: { attempts: 1 } }, /不允许的字段/],
      [{ archived: true }, /不允许的字段/],
      [{ q: '新题干', archived: true }, /不允许的字段/],
    ]
    for (const [patch, pattern] of rejected) {
      await assert.rejects(() => engine.bank2.questionUpdate('数学', '入门', 'q1', patch), pattern, JSON.stringify(patch))
    }
  })
})

test('#8 authoring fields remain editable and the whole bank revalidates', async () => {
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: `${BANK}\n` } }, async ({ engine }) => {
    await engine.bank2.questionUpdate('数学', '入门', 'q1', {
      q: '1+2=？',
      answer: 'B',
      options: ['A. 2', 'B. 3', 'C. 4'],
      explanation: '1+2=3',
      difficulty: 2,
      uses: ['加法'],
      tags: ['基础'],
      section: '通用',
    })
    const got = await engine.bank2.questionGet('数学', '入门', 'q1')
    assert.equal(got.question.q, '1+2=？')
    assert.equal(got.question.answer, 'B')
    assert.deepEqual(got.question.uses, ['加法'])

    await assert.rejects(
      () => engine.bank2.questionUpdate('数学', '入门', 'q1', { answer: 'Z' }),
      /校验失败/,
      'answer outside options must fail whole-bank validation',
    )
  })
})

test('#8 archive is a separate operation and both normal and archive paths preserve valid state', async () => {
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: `${BANK}\n` } }, async ({ engine }) => {
    await engine.bank2.questionArchive('数学', '入门', 'q2', true)
    const list = await engine.content2.questions('数学', '入门')
    assert.ok(list.questions.every(q => q.id !== 'q2'))
    await engine.bank2.questionArchive('数学', '入门', 'q2', false)
    const again = await engine.content2.questions('数学', '入门')
    assert.equal(again.questions.length, 2)
  })
})

test('#8 evidence writes from answering still go through the derived-state channel', async () => {
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: `${BANK}\n` } }, async ({ engine }) => {
    const r = await engine.questionAnswer(async () => { throw new Error('objective question must not call AI') }, '数学', '入门', 'q1', 'A')
    assert.equal(r.correct, true)
    const bank = await engine.bank.load(engine.paths.courseRoot('math'), '入门')
    const q1 = bank.questions.find(q => q.id === 'q1')
    assert.equal(q1?.stats?.attempts, 1)
    assert.equal(q1?.fsrs?.reps, 1)
  })
})
