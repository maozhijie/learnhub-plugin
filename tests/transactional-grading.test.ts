import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

const NOTE = [
  '---',
  'node: 入门',
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
  '# 入门',
].join('\n')

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

async function withVault(kind: string, answer: string, run: (engine: LearnhubEngine, paths: { bank: string; note: string; center: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-grading-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    const bank = join(course, '题库', '入门.yaml')
    const note = join(course, '课程', '基础', '入门.md')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(note, `${NOTE}\n`, 'utf8')
    await writeFile(bank, `${bankText(kind, answer)}\n`, 'utf8')
    await run(new LearnhubEngine({ vault: root }), { bank, note, center })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function evidenceSnapshot(paths: { bank: string; note: string; center: string }): Promise<Record<string, string | null>> {
  const read = async (p: string): Promise<string | null> => {
    try {
      return await readFile(p, 'utf8')
    } catch {
      return null
    }
  }
  return {
    bank: await read(paths.bank),
    note: await read(paths.note),
    practice: await read(join(paths.center, 'state', 'practice.jsonl')),
    journal: await read(join(paths.center, 'state', 'journal.jsonl')),
  }
}

test('#9 reflection: unparseable AI grading output fails before any learning side effect', async () => {
  await withVault('reflection', '评分要点：概念准确、举例恰当。', async (engine, paths) => {
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
  await withVault('reflection', '要点', async (engine, paths) => {
    const before = await evidenceSnapshot(paths)
    for (const raw of ['', '{"feedback":"只有反馈"}', '{"score":99,"feedback":"x"}']) {
      await assert.rejects(() => engine.questionAnswer(async () => raw, '数学', '入门', 'a1', '非空回答', 30))
    }
    const after = await evidenceSnapshot(paths)
    assert.deepEqual(after, before)
  })
})

test('#9 open_question: unparseable 0-10 grading output is transactional', async () => {
  await withVault('open_question', '参考要点', async (engine, paths) => {
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
  await withVault('reflection', '要点', async (engine, paths) => {
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
    assert.equal(existsSync(join(paths.center, 'state', 'practice.jsonl')), true)
  })
})
