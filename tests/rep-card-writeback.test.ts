import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { todayStr } from '../src/engine/dates.ts'
import type { FsrsBlock } from '../src/engine/types.ts'

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

/** 处于 review 期的节点笔记（fm.fsrs = 聚合代表卡，ADR-0007 口径 B 的稳定度分量来源）。 */
function reviewNote(fsrs: FsrsBlock): string {
  return [
    '---',
    'node: 入门',
    'stage: review',
    'fsrs:',
    `  stability: ${fsrs.stability}`,
    `  difficulty: ${fsrs.difficulty}`,
    `  due: ${fsrs.due}`,
    `  last_review: ${fsrs.last_review}`,
    `  reps: ${fsrs.reps}`,
    `  lapses: ${fsrs.lapses}`,
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
}

/** 单个 true_false 题目的 YAML 行（带种子 fsrs 块 = 已入复习循环的题卡）。 */
function tfQuestion(id: string, fsrs: FsrsBlock): string[] {
  return [
    `  - id: ${id}`,
    '    kind: true_false',
    `    q: ${id} 题干：说法是否成立。`,
    '    answer: true',
    '    fsrs:',
    `      stability: ${fsrs.stability}`,
    `      difficulty: ${fsrs.difficulty}`,
    `      due: ${fsrs.due}`,
    `      last_review: ${fsrs.last_review}`,
    `      reps: ${fsrs.reps}`,
    `      lapses: ${fsrs.lapses}`,
  ]
}

const PAST = '2024-01-01'
const FUTURE = '2099-01-01'

const staleRep: FsrsBlock = { stability: 1, difficulty: 5, due: PAST, last_review: PAST, reps: 1, lapses: 0 }
const qCard: FsrsBlock = { stability: 10, difficulty: 5, due: FUTURE, last_review: PAST, reps: 5, lapses: 0 }

async function withVault(
  noteFsrs: FsrsBlock,
  questions: string[][],
  run: (engine: LearnhubEngine, paths: { note: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-repcard-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    const note = join(course, '课程', '基础', '入门.md')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(note, `${reviewNote(noteFsrs)}\n`, 'utf8')
    await writeFile(
      join(course, '题库', '入门.yaml'),
      ['node: 入门', 'questions:', ...questions.flat()].join('\n') + '\n',
      'utf8',
    )
    await run(new LearnhubEngine({ vault: root }), { note })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 读节点笔记 frontmatter 的 fsrs 块（按写入顺序逐字段抓取）。 */
async function noteFsrs(notePath: string): Promise<Record<string, string>> {
  const text = await readFile(notePath, 'utf8')
  const fm = text.split(/^---$/m)[1] ?? ''
  const keys = ['stability', 'difficulty', 'due', 'last_review', 'reps', 'lapses']
  const out: Record<string, string> = {}
  for (const k of keys) {
    const m = fm.match(new RegExp(`^\\s+${k}: (.+)$`, 'm'))
    if (m) out[k] = m[1].trim()
  }
  return out
}

const answer = (
  engine: LearnhubEngine,
  qid: string, response: string,
  opts?: { deferSchedule?: boolean },
) => engine.questionAnswer(
  async () => 'unused', '数学', '入门', qid, response, 30,
  opts?.deferSchedule ? { deferSchedule: true } : undefined,
)

test('练习流答对推进后：fm.fsrs 回刷为该题新卡，稳定度分量随复习前进（mastery > 纯 EMA 的 0.3）', async () => {
  await withVault(staleRep, [tfQuestion('a1', qCard)], async (engine, { note }) => {
    const r = await answer(engine, 'a1', 'true') as Record<string, unknown>
    assert.equal(r.scheduled, true)
    assert.ok((r.mastery as number) > 0.3, `稳定度分量应参与 mastery（得到 ${r.mastery}）`)

    const fs = await noteFsrs(note)
    assert.equal(fs.reps, '6', '代表卡回刷为该题推进后的新卡')
    assert.equal(fs.due, r.due, '回刷 due 与题目新卡一致')
    assert.ok(Number(fs.stability) > qCard.stability, 'Good 推进后稳定度增长')
    assert.equal(fs.last_review, todayStr(), '回刷 last_review 为本次推进日')
  })
})

test('自评挂起期间代表卡不动，questionRate 落盘后回刷', async () => {
  await withVault(staleRep, [tfQuestion('a1', qCard)], async (engine, { note }) => {
    const r = await answer(engine, 'a1', 'true', { deferSchedule: true }) as Record<string, unknown>
    assert.equal(r.pendingRating, true)
    const before = await noteFsrs(note)
    assert.equal(before.reps, '1', '挂起期间卡没动，代表卡保持完成时刻快照')

    const rated = await engine.questionRate('数学', '入门', 'a1', 3) as Record<string, unknown>
    const after = await noteFsrs(note)
    assert.equal(after.reps, '6', 'rate 落盘后回刷代表卡')
    assert.equal(after.due, rated.due)
    assert.ok((rated.mastery as number) > 0.3)
  })
})

test('忘记把代表卡拉回：due 变近、稳定度回落 → mastery 回落', async () => {
  const rep = qCard
  await withVault(rep, [tfQuestion('a1', rep)], async (engine, { note }) => {
    // 种子态：代表卡 = 该题卡，mastery = 0.7 × min(1, 20/60) = 0.33（无练习证据）
    const r = await engine.questionForget('数学', '入门', 'a1', 7) as Record<string, unknown>
    assert.equal(r.scheduled, true)
    assert.ok((r.mastery as number) < 0.33, `忘记后 mastery 应回落（得到 ${r.mastery}）`)

    const fs = await noteFsrs(note)
    assert.equal(fs.reps, '6')
    assert.equal(fs.due, r.due, '代表卡拉回为忘记后的新卡（最早 due）')
    assert.ok(Number(fs.stability) < rep.stability, 'Again 后稳定度收缩')
    assert.ok(fs.due! < FUTURE, '忘记把到期拉回近处')
    // 响应 mastery 必须与落盘后的代表卡同源（无练习证据时 = 稳定度项单独）
    const expected = Math.round(Math.min(1, Number(fs.stability) / 60) * 100) / 100
    assert.equal(r.mastery, expected, '响应 mastery 从回刷后的 fm 派生')
  })
})

test('推的不是代表题：代表卡不变（practice 证据照常更新，fsrs 块不动）', async () => {
  const repCard: FsrsBlock = { stability: 15, difficulty: 5, due: PAST, last_review: PAST, reps: 3, lapses: 0 }
  await withVault(repCard, [tfQuestion('a1', repCard), tfQuestion('a2', qCard)], async (engine, { note }) => {
    const fsBefore = await noteFsrs(note)
    const r = await answer(engine, 'a2', 'true') as Record<string, unknown>
    assert.equal(r.scheduled, true, 'a2 真实推进')

    const fsAfter = await noteFsrs(note)
    assert.deepEqual(fsAfter, fsBefore, '代表卡仍是 a1（更早 due），fsrs 块不重写')
  })
})

test('同日重复作答不推卡，也不回刷代表卡（每题每天一次推进不变量）', async () => {
  await withVault(staleRep, [tfQuestion('a1', qCard)], async (engine, { note }) => {
    const first = await answer(engine, 'a1', 'true') as Record<string, unknown>
    assert.equal(first.scheduled, true)
    const afterFirst = await noteFsrs(note)
    assert.equal(afterFirst.reps, '6')

    const second = await answer(engine, 'a1', 'true') as Record<string, unknown>
    assert.equal(second.scheduled, false, '同日重复只记练习，不推卡')
    const afterSecond = await noteFsrs(note)
    assert.equal(afterSecond.reps, '6', '代表卡未被重复作答再推')
    assert.equal(afterSecond.due, afterFirst.due)
  })
})
