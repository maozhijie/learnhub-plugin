import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

/** 单个 true_false 题目的 YAML 行（可选种子 fsrs 块 / 归档标记）。 */
function tfQuestion(id: string, opts: { fsrs?: Record<string, string | number>; archived?: boolean } = {}): string[] {
  return [
    `  - id: ${id}`,
    '    kind: true_false',
    `    q: ${id} 题干：说法是否成立。`,
    '    answer: true',
    ...(opts.fsrs ? ['    fsrs:', ...Object.entries(opts.fsrs).map(([k, v]) => `      ${k}: ${v}`)] : []),
    ...(opts.archived ? ['    archived: true'] : []),
  ]
}

const PAST = '2024-01-01'
const FUTURE = '2099-01-01'

async function withVault(
  questions: string[][],
  run: (engine: LearnhubEngine, paths: { bank: string; note: string; center: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-review-'))
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
    await writeFile(bank, ['node: 入门', 'questions:', ...questions.flat()].join('\n') + '\n', 'utf8')
    await run(new LearnhubEngine({ vault: root }), { bank, note, center })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const answer = (
  engine: LearnhubEngine,
  qid: string, response: string,
  opts?: { deferSchedule?: boolean },
) => engine.questionAnswer(
  async () => 'unused', '数学', '入门', qid, response, 30,
  opts?.deferSchedule ? { deferSchedule: true } : undefined,
)

const loadQ = async (engine: LearnhubEngine, qid: string) => {
  const bank = await engine.bank.load(engine.paths.courseRoot('math'), '入门')
  return bank.questions.find(x => x.id === qid)!
}

test('defer 答对：调度挂起 + 三档到期预览，questionRate 落盘并清挂起标记', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    const r = await answer(engine, 'a1', 'true', { deferSchedule: true }) as Record<string, unknown>
    assert.equal(r.correct, true)
    assert.equal(r.pendingRating, true, 'correct + defer → 自评挂起')
    assert.equal(r.scheduled, false, '挂起期间不推卡')
    const previews = r.previews as { hard: string; good: string; easy: string }
    const iso = /^\d{4}-\d{2}-\d{2}$/
    assert.match(previews.hard, iso)
    assert.match(previews.good, iso)
    assert.match(previews.easy, iso)
    assert.ok(previews.hard <= previews.good && previews.good <= previews.easy, '预览随档位单调不减')

    let q = await loadQ(engine, 'a1')
    assert.equal(q.fsrs, undefined, '挂起期间卡未推进')
    assert.equal(q.stats?.attempts, 1)
    assert.equal(q.stats?.pending_rating, true)

    const rated = await engine.questionRate('数学', '入门', 'a1', 2) as Record<string, unknown>
    assert.equal(rated.due, previews.hard, 'rate 按选中档位推进')
    assert.equal(rated.scheduled, true)

    q = await loadQ(engine, 'a1')
    assert.equal(q.fsrs?.reps, 1)
    assert.equal(q.fsrs?.due, previews.hard)
    assert.equal(q.stats?.pending_rating, undefined, '结算后清挂起标记')

    await assert.rejects(
      () => engine.questionRate('数学', '入门', 'a1', 3),
      /没有待结算|已推进/,
      '重复 rate 拒绝',
    )
  })
})

test('defer 答错：立即按 Again 推进，不出自评；事后 rate 拒绝', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    const r = await answer(engine, 'a1', 'false', { deferSchedule: true }) as Record<string, unknown>
    assert.equal(r.correct, false)
    assert.notEqual(r.pendingRating, true, '答错无自评')
    assert.equal(r.scheduled, true, '答错立即 Again')
    const q = await loadQ(engine, 'a1')
    assert.equal(q.fsrs?.reps, 1)
    assert.equal(q.stats?.pending_rating, undefined)
    await assert.rejects(() => engine.questionRate('数学', '入门', 'a1', 3), /没有待结算/)
  })
})

test('rate 无当日挂起作答 → 拒绝（含从未作答与练习流作答两条路径）', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    await assert.rejects(() => engine.questionRate('数学', '入门', 'a1', 3), /没有待结算/, '从未作答')
    await answer(engine, 'a1', 'true') // 练习流：自动 Good，无挂起
    await assert.rejects(() => engine.questionRate('数学', '入门', 'a1', 4), /没有待结算/, '练习流作答不产生挂起')
  })
})

test('rate 档位只能 2/3/4', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    await answer(engine, 'a1', 'true', { deferSchedule: true })
    await assert.rejects(() => engine.questionRate('数学', '入门', 'a1', 1), /2\/3\/4/)
    await assert.rejects(() => engine.questionRate('数学', '入门', 'a1', 5), /2\/3\/4/)
  })
})

test('忘记：按答错记全部证据、0 XP、推进 Again；重复忘记拒绝', async () => {
  await withVault([tfQuestion('a1')], async engine => {
    const r = await engine.questionForget('数学', '入门', 'a1', 7) as Record<string, unknown>
    assert.equal(r.correct, false)
    assert.equal(r.judge, 'forget')
    assert.equal(r.xp, 0)
    assert.equal(r.scheduled, true)
    assert.ok(String(r.answer).length > 0, '翻面公布答案')

    const practice = await readFile(join(engine.paths.centerStateDir, 'practice.jsonl'), 'utf8')
    const rec = JSON.parse(practice.trim().split('\n').pop()!) as Record<string, unknown>
    assert.equal(rec.judge, 'forget')
    assert.equal(rec.correct, false)
    assert.equal(rec.xp, 0)
    assert.equal(rec.elapsed_s, 7)

    const q = await loadQ(engine, 'a1')
    assert.equal(q.fsrs?.reps, 1, '忘记推进调度')
    assert.equal(q.stats?.attempts, 1)
    assert.equal(q.stats?.correct, 0, '忘记不计正确')

    const note = await readFile(join(engine.paths.courseRoot('math'), '课程', '基础', '入门.md'), 'utf8')
    assert.match(note, /stage: learning/, '忘记与作答同样推进节点 stage')
    assert.match(note, /attempts: 1/)
    assert.match(note, /correct: 0/)

    await assert.rejects(() => engine.questionForget('数学', '入门', 'a1', 7), /已有作答记录/)
  })
})

test('忘记与作答互斥：当天已作答（含挂起自评）再忘记 → 拒绝', async () => {
  await withVault([tfQuestion('a1'), tfQuestion('a2')], async engine => {
    await answer(engine, 'a1', 'true', { deferSchedule: true })
    await assert.rejects(() => engine.questionForget('数学', '入门', 'a1', 7), /已有作答记录/, '挂起自评后不可忘记')
    await answer(engine, 'a2', 'true')
    await assert.rejects(() => engine.questionForget('数学', '入门', 'a2', 7), /已有作答记录/, '自动作答后不可忘记')
  })
})

test('错误降低掌握度（口径 B）：答对推高练习证据 EMA，忘记后回落', async () => {
  await withVault([tfQuestion('a1'), tfQuestion('a2')], async engine => {
    const ok = await answer(engine, 'a1', 'true') as Record<string, unknown>
    // 无节点卡（未完成学习）→ 稳定度项为 0；mastery = 0.3 × EMA(1.0) = 0.3
    assert.equal(ok.mastery, 0.3)
    const forgot = await engine.questionForget('数学', '入门', 'a2', 7) as Record<string, unknown>
    // 忘记后 EMA = 1.0×0.7 = 0.7 → mastery = 0.3 × 0.7 = 0.21
    assert.equal(forgot.mastery, 0.21)
    assert.ok((forgot.mastery as number) < (ok.mastery as number))
  })
})

test('reviewQueue：只含到期未归档卡，按 due 升序、同日按题序稳定排序', async () => {
  await withVault([
    tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 3, lapses: 0 } }),
    tfQuestion('a2', { fsrs: { stability: 5, difficulty: 5, due: FUTURE, last_review: PAST, reps: 1, lapses: 0 } }),
    tfQuestion('a3', { fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 1, lapses: 0 } }),
    tfQuestion('a4', { fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 1, lapses: 0 }, archived: true }),
  ], async engine => {
    const r = await engine.reviewQueue('数学') as Record<string, unknown>
    assert.equal(r.total, 2, '未调度新题与未来到期卡不入队')
    const cards = r.cards as Array<Record<string, unknown>>
    assert.deepEqual(cards.map(c => c.id), ['a1', 'a3'])
    assert.equal(cards[0].course, '数学')
    assert.equal(cards[0].node, '入门')
    assert.equal(cards[0].due, PAST)
    assert.equal(cards[0].kind, 'true_false')
    const all = await engine.reviewQueue() as Record<string, unknown>
    assert.equal(all.total, 2, '全课程口径一致')
  })
})

test('questionsAll 下发 due/lastReview（未调度新题为 null）', async () => {
  await withVault([
    tfQuestion('a1', { fsrs: { stability: 5, difficulty: 5, due: PAST, last_review: PAST, reps: 3, lapses: 0 } }),
    tfQuestion('a2'),
  ], async engine => {
    const r = await engine.questionsAll('数学') as { questions: Array<Record<string, unknown>> }
    const byId = Object.fromEntries(r.questions.map(x => [x.qid, x]))
    assert.equal(byId.a1.due, PAST)
    assert.equal(byId.a1.lastReview, PAST)
    assert.equal(byId.a2.due, null)
    assert.equal(byId.a2.lastReview, null)
  })
})
