import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { applyId, questionCount, rejectId, requireSkipDirection } from '../src/tool-contracts.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

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

async function withGraphVault(run: (engine: LearnhubEngine) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-contracts-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '甲区'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '甲区.yaml'), `${REGION_A}\n`, 'utf8')
    await writeFile(join(course, 'data', '乙区.yaml'), `${REGION_B}\n`, 'utf8')
    await writeFile(join(course, '课程', '甲区', '甲一.md'), `${NOTE}\n`, 'utf8')
    await run(new LearnhubEngine({ vault: root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
  await withGraphVault(async engine => {
    const llm = async (): Promise<string> => { throw new Error('model must not be called') }
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await assert.rejects(() => engine.questionGenerate('数学', '甲一', bad, llm), /count 必须是正整数/, String(bad))
    }
    const r = await engine.questionGenerate('数学', '甲一', undefined, async () => sixQuestions())
    assert.equal(r.added, 6, 'omitted count must keep the existing default of 6')
    assert.equal(r.total, 6)
  })
})

test('#12 block-only graph browsing: unambiguous succeeds, zero-match and ambiguous fail with context', async () => {
  await withGraphVault(async engine => {
    const ok = await engine.graphBrowse('数学', undefined, '唯一块') as { total: number; regions: Array<{ name: string }> }
    assert.equal(ok.total, 1)
    assert.deepEqual(ok.regions.map(r => r.name), ['乙区'])

    await assert.rejects(
      () => engine.graphBrowse('数学', undefined, '不存在块'),
      (err: unknown) => (err as Error).message.includes('块「不存在块」不存在')
        && (err as Error).message.includes('可用块'),
    )
    await assert.rejects(
      () => engine.graphBrowse('数学', undefined, '同名块'),
      (err: unknown) => (err as Error).message.includes('块「同名块」不唯一')
        && (err as Error).message.includes('甲区') && (err as Error).message.includes('乙区'),
    )
    await assert.rejects(
      () => engine.graphBrowse('数学', '甲区', '唯一块'),
      (err: unknown) => (err as Error).message.includes('区「甲区」中没有块「唯一块」'),
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
