import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { BAND_STEP_UP, combinedDifficulty, nextBand, pickNext, sessionOrder, startBand } from '../src/engine/adaptive.ts'

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

/** 节点笔记：fsrs/practice 可播种——masteryOfFm 的先验来源。 */
function note(opts: { stage: string; fsrs: Record<string, string | number> | null; attempts: number; correct: number; ema?: number }): string {
  return [
    '---',
    'node: 入门',
    `stage: ${opts.stage}`,
    ...(opts.fsrs
      ? ['fsrs:', ...Object.entries(opts.fsrs).map(([k, v]) => `  ${k}: ${v}`)]
      : ['fsrs: null']),
    'content:',
    '  version: 0',
    '  generated_at: null',
    '  status: draft',
    'practice:',
    `  attempts: ${opts.attempts}`,
    `  correct: ${opts.correct}`,
    ...(opts.ema !== undefined ? [`practice_ema: ${opts.ema}`] : []),
    '---',
    '',
    '# 入门',
  ].join('\n')
}

/** true_false 题目：fsrs 全部同种子（R 同档），只让静态题面难度拉开合用难度 d。 */
function tfQuestion(id: string, difficulty: number, seedDue: string): string[] {
  return [
    `  - id: ${id}`,
    '    kind: true_false',
    `    q: ${id} 题干：说法是否成立。`,
    '    answer: true',
    `    difficulty: ${difficulty}`,
    '    fsrs:',
    '      stability: 5',
    '      difficulty: 5',
    `      due: ${seedDue}`,
    `      last_review: ${seedDue}`,
    '      reps: 2',
    '      lapses: 0',
  ]
}

const PAST = '2024-01-01'

async function withVault(
  noteYaml: string,
  run: (engine: LearnhubEngine) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-adaptive-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(join(course, '课程', '基础', '入门.md'), `${noteYaml}\n`, 'utf8')
    await writeFile(
      join(course, '题库', '入门.yaml'),
      ['node: 入门', 'questions:',
        ...tfQuestion('easy1', 1, PAST), ...tfQuestion('easy2', 1, PAST),
        ...tfQuestion('hard1', 3, PAST), ...tfQuestion('hard2', 3, PAST)].join('\n') + '\n',
      'utf8',
    )
    await run(new LearnhubEngine({ vault: root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---- 纯规则（接缝 S24）----

test('combinedDifficulty：静态 1-3 与 FSRS difficulty 等权合成，未调度卡只有静态项', () => {
  assert.equal(combinedDifficulty(1, null), 0, '未调度：只有静态项')
  assert.equal(combinedDifficulty(3, { difficulty: 5, reps: 0 }), 1, 'reps=0 视为未调度，FSRS 项不虚拟')
  assert.equal(combinedDifficulty(3, { difficulty: 1, reps: 3 }), 0.5, '静态 3（=1.0）+ FSRS 1（=0）各半')
  assert.equal(combinedDifficulty(1, { difficulty: 10, reps: 3 }), 0.5, '静态 1（=0）+ FSRS 10（=1.0）各半')
  assert.ok(Math.abs(combinedDifficulty(undefined, { difficulty: 5, reps: 3 }) - 2 / 9) < 1e-9, '静态缺省 1 档（=0）+ FSRS 中值 5（=4/9）各半')
})

test('startBand：随节点 Mastery 单调上行', () => {
  assert.equal(startBand(0), 0.2, '零掌握从基础题带起')
  assert.equal(startBand(1), 0.8, '满掌握不上顶，留升档空间')
  for (let m = 0; m <= 10; m++) {
    assert.ok(startBand(m / 10) <= startBand(Math.min(1, (m + 1) / 10)), `mastery ${m / 10} 单调`)
  }
})

test('nextBand：连对 ≥2 升档、答错/忘记一步降回基础带（base）并清零连对', () => {
  const base = startBand(0.5) // 0.5
  let s = nextBand(base, true, 0, base)
  assert.equal(s.band, base, '首对不升档')
  assert.equal(s.streak, 1)
  s = nextBand(s.band, true, s.streak, base)
  assert.ok(Math.abs(s.band - (base + BAND_STEP_UP)) < 1e-9, '第二连对升一档')
  s = nextBand(s.band, false, s.streak, base)
  assert.equal(s.band, base, '答错一步降回基础带')
  assert.equal(s.streak, 0, '连对清零')
  assert.equal(nextBand(0.9, false, 3, 0.2).band, 0.2, '高位答错一步回到基础带')
  assert.equal(nextBand(0.1, false, 3, 0.5).band, 0.1, '带已低于基础带时不反向抬高')
  assert.equal(nextBand(0.95, true, 5, base).band, 1, '升档不封过顶')
})

test('pickNext/sessionOrder：距目标带最近者优先，平局稳定', () => {
  const cards = [{ id: 'a', d: 0.1 }, { id: 'b', d: 0.9 }, { id: 'c', d: 0.5 }]
  assert.equal(pickNext(cards, 0.85)!.id, 'b')
  assert.deepEqual(sessionOrder(cards, 0.85).map(c => c.id), ['b', 'c', 'a'])
  const tied = [{ id: 'x', d: 0.4 }, { id: 'y', d: 0.6 }]
  assert.equal(pickNext(tied, 0.5)!.id, 'x', '等距取靠前者')
})

// ---- 门面：单节点会话起点先验 + 首学新题流不动 ----

test('单节点定向队列：起点难度带随节点 Mastery 单调——高掌握先出难题，低掌握先出基础题', async () => {
  const highMastery = note({
    stage: 'review',
    fsrs: { stability: 40, difficulty: 5, due: PAST, last_review: PAST, reps: 6, lapses: 0 },
    attempts: 3, correct: 3, ema: 1.0,
  })
  await withVault(highMastery, async engine => {
    const r = await engine.reviewQueue('数学', '入门') as Record<string, unknown>
    assert.ok((r.band as number) > 0.6, `高掌握起点带在上半区，得到 ${r.band}`)
    const cards = r.cards as Array<Record<string, unknown>>
    assert.equal(cards[0].id, 'hard1', '先验带高 → 开场是高难度档')
  })
  const lowMastery = note({ stage: 'review', fsrs: null, attempts: 3, correct: 0 })
  await withVault(lowMastery, async engine => {
    const r = await engine.reviewQueue('数学', '入门') as Record<string, unknown>
    assert.equal(r.band, 0.2, '零掌握从基础带起')
    const cards = r.cards as Array<Record<string, unknown>>
    assert.equal(cards[0].id, 'easy1', '先验带低 → 开场是基础题')
    assert.ok(typeof cards[0].d === 'number', '卡片带合用难度标量 d（会话内选档消费）')
  })
})

test('全局队列与首学新题流不动：全局维持 R 组合排序，questions 维持题库序', async () => {
  const highMastery = note({
    stage: 'review',
    fsrs: { stability: 40, difficulty: 5, due: PAST, last_review: PAST, reps: 6, lapses: 0 },
    attempts: 3, correct: 3, ema: 1.0,
  })
  await withVault(highMastery, async engine => {
    const r = await engine.reviewQueue('数学') as Record<string, unknown>
    assert.equal(r.band, undefined, '全局队列没有先验带字段（不走 A1 微调）')
    const cards = r.cards as Array<Record<string, unknown>>
    // 全局口径（#56）：同 R 档内按静态难度由易到难——easy1/easy2 在前
    assert.deepEqual(cards.map(c => c.id), ['easy1', 'easy2', 'hard1', 'hard2'])

    const qs = await engine.questions('数学', '入门') as Record<string, unknown>
    assert.deepEqual((qs.questions as Array<{ id: string }>).map(q => q.id),
      ['easy1', 'easy2', 'hard1', 'hard2'], '首学新题列表维持题库原序（首学流不动）')
  })
})

test('会话内流式选档（纯规则模拟）：连续对序列难度上升、答错后回降', () => {
  const pool = [
    { id: 'e1', d: 0 }, { id: 'e2', d: 0 }, // 基础题
    { id: 'm1', d: 0.5 }, // 中档
    { id: 'h1', d: 1 }, { id: 'h2', d: 1 }, // 难题
  ]
  // 低掌握开场：band=0.2 → 先基础题；连对两次升一档 → 中档进射程；再连对 → 难题
  let band = startBand(0)
  let streak = 0
  let remaining = [...pool]
  const seq: string[] = []
  const outcomes: boolean[] = [true, true, true, true]
  for (const ok of outcomes) {
    const card = pickNext(remaining, band)!
    seq.push(card.id)
    remaining = remaining.filter(c => c.id !== card.id)
    const ns = nextBand(band, ok, streak)
    band = ns.band
    streak = ns.streak
  }
  assert.deepEqual(seq, ['e1', 'e2', 'm1', 'h1'], '连续对 → 难度逐级上升')
  const ds = seq.map(id => pool.find(c => c.id === id)!.d)
  assert.ok(ds[0] < ds[2]! && ds[2]! < ds[3]!, '序列难度单调上升')

  // 答错：一步降回基础带（起点先验 0.2），下一题回到最贴近带的剩余卡
  const afterWrong = nextBand(band, false, streak, startBand(0))
  assert.equal(afterWrong.band, 0.2, '错后 band 回到基础带')
  assert.equal(pickNext(remaining, afterWrong.band)!.id, 'h2', '只剩难题时选最贴近带的（防御性兜底）')
})
