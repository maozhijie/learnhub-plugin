import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from '../src/engine/paths.ts'
import { withVault } from './helpers/vault.ts'

/** ready 节点 + 存量 `mastery: 0` 键（旧文件兼容形态，顶层键）。 */
const READY_NOTE = { stage: 'ready', fmExtra: ['mastery: 0'] }

/** 非 true_false 题型的原始题库 YAML（reflection/open_question 专用题型，工厂 tfQuestion 表达不了）。 */
function bankText(kind: string, answer: string): string {
  return [
    'node: 入门',
    'questions:',
    `  - id: a1`,
    `    kind: ${kind}`,
    '    q: 用自己的话解释这个概念。',
    `    answer: ${answer}`,
  ].join('\n')
}

async function evidenceSnapshot(paths: Paths): Promise<Record<string, string | null>> {
  const read = async (p: string): Promise<string | null> => {
    try {
      return await readFile(p, 'utf8')
    } catch {
      return null
    }
  }
  return {
    bank: await read(join(paths.courseRoot('math'), '题库', '入门.yaml')),
    note: await read(join(paths.courseRoot('math'), '课程', '基础', '入门.md')),
    practice: await read(join(paths.centerStateDir, 'practice.jsonl')),
    journal: await read(join(paths.centerStateDir, 'journal.jsonl')),
  }
}

test('#9 reflection: unparseable AI grading output fails before any learning side effect', async () => {
  await withVault({
    notes: { 入门: READY_NOTE },
    banks: { 入门: `${bankText('reflection', '评分要点：概念准确、举例恰当。')}\n` },
  }, async ({ engine, paths }) => {
    const before = await evidenceSnapshot(paths)
    await assert.rejects(
      () => engine.questionAnswer(async () => '这不是 JSON', '数学', '入门', 'a1', '我的完整回答', 30),
      /AI 判卷输出不可用.*未记录/s,
    )
    const after = await evidenceSnapshot(paths)
    assert.deepEqual(after, before, 'grading failure must leave bank/note/practice/journal untouched')
    const bank = await engine.bank.load(engine.paths.courseRoot('math'), '入门')
    const q = bank.questions[0]
    assert.equal(q.fsrs, undefined, 'no FSRS card on failed grading')
    assert.equal(q.stats, undefined, 'no stats on failed grading')
  })
})

test('#9 reflection: empty AI output and malformed score also fail without fallback 0.5', async () => {
  await withVault({
    notes: { 入门: READY_NOTE },
    banks: { 入门: `${bankText('reflection', '要点')}\n` },
  }, async ({ engine, paths }) => {
    const before = await evidenceSnapshot(paths)
    for (const raw of ['', '{"feedback":"只有反馈"}', '{"score":99,"feedback":"x"}']) {
      await assert.rejects(() => engine.questionAnswer(async () => raw, '数学', '入门', 'a1', '非空回答', 30))
    }
    const after = await evidenceSnapshot(paths)
    assert.deepEqual(after, before)
  })
})

test('#9 open_question: unparseable 0-10 grading output is transactional', async () => {
  await withVault({
    notes: { 入门: READY_NOTE },
    banks: { 入门: `${bankText('open_question', '参考要点')}\n` },
  }, async ({ engine, paths }) => {
    const before = await evidenceSnapshot(paths)
    await assert.rejects(
      () => engine.questionAnswer(async () => '{"score":"high","feedback":"x"}', '数学', '入门', 'a1', '回答', 30),
      /AI 判卷输出不可用/,
    )
    const after = await evidenceSnapshot(paths)
    assert.deepEqual(after, before)
  })
})

test('#9 a later valid grading proceeds normally and writes the same evidence channels once', async () => {
  await withVault({
    notes: { 入门: READY_NOTE },
    banks: { 入门: `${bankText('reflection', '要点')}\n` },
  }, async ({ engine, paths }) => {
    await assert.rejects(() => engine.questionAnswer(async () => 'bad', '数学', '入门', 'a1', '第一次尝试', 30))
    const ok = await engine.questionAnswer(
      async () => JSON.stringify({ score: 0.8, feedback: '覆盖了核心概念，建议再给一个反例。' }),
      '数学', '入门', 'a1', '第二次尝试', 30,
    )
    assert.equal(ok.correct, true)
    assert.equal(ok.score, 80)
    const bank = await engine.bank.load(engine.paths.courseRoot('math'), '入门')
    const q = bank.questions[0]
    assert.equal(q.fsrs?.reps, 1)
    assert.equal(q.stats?.attempts, 1)
    assert.equal(existsSync(join(paths.centerStateDir, 'practice.jsonl')), true)
  })
})
