import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import type { ReviewRec } from '../src/engine/types.ts'

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

/** 单个 true_false 题目的 YAML 行（可选种子 fsrs 块 = 已入复习循环的题卡）。 */
function tfQuestion(id: string, opts: { fsrs?: Record<string, string | number> } = {}): string[] {
  return [
    `  - id: ${id}`,
    '    kind: true_false',
    `    q: ${id} 题干：说法是否成立。`,
    '    answer: true',
    ...(opts.fsrs ? ['    fsrs:', ...Object.entries(opts.fsrs).map(([k, v]) => `      ${k}: ${v}`)] : []),
  ]
}

const PAST = '2024-01-01'

async function withVault(
  questions: string[][],
  run: (engine: LearnhubEngine) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-revlog-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    const note = join(course, '课程', '基础', '入门.md')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(note, `${NOTE}\n`, 'utf8')
    await writeFile(
      join(course, '题库', '入门.yaml'),
      ['node: 入门', 'questions:', ...questions.flat()].join('\n') + '\n',
      'utf8',
    )
    await run(new LearnhubEngine({ vault: root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const answer = (
  engine: LearnhubEngine,
  qid: string, response: string, elapsedS: number,
  opts?: { deferSchedule?: boolean },
) => engine.questionAnswer(
  async () => 'unused', '数学', '入门', qid, response, elapsedS,
  opts?.deferSchedule ? { deferSchedule: true } : undefined,
)

test('练习流答对：auto/Good 落一条，首学无旧卡 → 快照 null、r_pred=1.0', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    await answer(engine, 'a1', 'true', 30)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1, '一次真实推进恰好一条')
    const rec = recs[0]
    assert.equal(rec.course, '数学')
    assert.equal(rec.node, '入门')
    assert.equal(rec.qid, 'a1')
    assert.equal(rec.rating, 3)
    assert.equal(rec.rating_source, 'auto')
    assert.equal(rec.elapsed_days, 0, '首学 elapsed=0')
    assert.equal(rec.stability_before, null)
    assert.equal(rec.difficulty_before, null)
    assert.equal(rec.r_pred, 1, 'FSRS 对新卡的自预测 = 1.0')
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/)
  })
})

test('忘记申报：auto/Again + 复习前快照（种子卡 elapsed>0、S/D 取旧值、R 已衰减）', async () => {
  await withVault([tfQuestion('a1', {
    fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 3, lapses: 0 },
  })], async engine => {
    await engine.questionForget('数学', '入门', 'a1', 7)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1)
    const rec = recs[0]
    assert.equal(rec.rating, 1)
    assert.equal(rec.rating_source, 'auto', '忘记与答错同口径：auto')
    assert.ok(rec.elapsed_days > 0, `elapsed = 距上次复习天数，得到 ${rec.elapsed_days}`)
    assert.equal(rec.stability_before, 5)
    assert.equal(rec.difficulty_before, 5)
    assert.ok(rec.r_pred !== null && rec.r_pred < 0.9, `旧卡长期未刷 → R 明显衰减，得到 ${rec.r_pred}`)
  })
})

test('复习流自评：挂起作答不落日志，questionRate(Hard) 落 self/2', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    await answer(engine, 'a1', 'true', 30, { deferSchedule: true })
    assert.deepEqual(await engine.store.reviewLogAll(), [], '挂起=未推进，不落日志')
    await engine.questionRate('数学', '入门', 'a1', 2)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1)
    const rec = recs[0]
    assert.equal(rec.rating, 2)
    assert.equal(rec.rating_source, 'self')
    assert.equal(rec.r_pred, 1, '首学自评：r_pred 仍取 FSRS 新卡自预测')
    assert.equal(rec.stability_before, null)
  })
})

test('完成学习合成初始化：synthetic/3、elapsed=0、快照三字段 null；重复完成不重复落', async () => {
  await withVault([tfQuestion('a1'), tfQuestion('a2')], async engine => {
    const done = await engine.nodeComplete('数学', '入门') as Record<string, unknown>
    assert.equal(done.accepted, true)
    assert.equal(done.initialized, 2)
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 2, '两张未作答的题各落一条合成首复习')
    for (const rec of recs) {
      assert.equal(rec.rating, 3)
      assert.equal(rec.rating_source, 'synthetic')
      assert.equal(rec.elapsed_days, 0)
      assert.equal(rec.stability_before, null, 'synthetic 无「复习前」状态')
      assert.equal(rec.difficulty_before, null)
      assert.equal(rec.r_pred, null)
    }
    assert.deepEqual(recs.map(r => r.qid).sort(), ['a1', 'a2'])

    await engine.nodeComplete('数学', '入门')
    assert.equal((await engine.store.reviewLogAll()).length, 2, '重复完成不再初始化、不再落日志')
  })
})

test('同日重复作答与 5s 内乱猜都不推进、不落日志', async () => {
  await withVault([tfQuestion('a1'), tfQuestion('a2')], async engine => {
    await answer(engine, 'a1', 'true', 30)
    await answer(engine, 'a1', 'true', 30)
    await answer(engine, 'a2', 'false', 2) // 耗时 2s < 5s 且答错 → 乱猜
    const recs = await engine.store.reviewLogAll() as ReviewRec[]
    assert.equal(recs.length, 1, '只有首次认真作答落了日志')
    assert.equal(recs[0].qid, 'a1')
  })
})

test('读取契约：文件缺失 = 合法空态；逐行损坏 = Broken 报出不静默吞', async () => {
  await withVault([], async engine => {
    assert.deepEqual(await engine.store.reviewLogAll(), [], 'Missing 合法空态')
    const dir = engine.paths.centerStateDir
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'review-log.jsonl'), '{"ts":"2026-09-08T00:00:00"}\n{oops\n', 'utf8')
    await assert.rejects(
      () => engine.store.reviewLogAll(),
      /review-log.*第 2 行|Broken/,
      '坏行要报出行号，不能静默跳过',
    )
  })
})
