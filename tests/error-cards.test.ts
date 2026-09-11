/**
 * 错误对比卡域（C-3 / #82）：错误库→对比案例卡。
 *
 * - 挖矿纯函数：practice 流水 → 高频错误模式候选（同一题 ≥2 次实质答错；
 *   忘记申报不是错法证据；wrongs 去重最近在前；lapses 降序）。
 * - schema 门禁：恰好 3 个互异选项、answer/mine 必在其中且相异。
 * - 外部行为（withVault，ADR-0013）：生成 → 落盘错误 deck → 汇入复习队列
 *   （source='error'）→ 自动判分推进（一卡一天一次）→ 无绑定 XP、复习日志/
 *   practice/节点 frontmatter 零掺入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mineErrorPatterns, isMinableWrong, validateErrorCards, ErrorCards } from '../src/engine/error-cards.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import type { PracticeRec } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'

// ---- 挖矿纯函数 ----

const rec = (over: Partial<PracticeRec>): PracticeRec => ({
  ts: '2026-09-08T10:00:00', course: '数学', node: '入门', ex: 1,
  answer: 'B', correct: false, judge: 'single_choice', qid: 'q1', ...over,
})

test('挖矿：同一题 ≥2 次实质答错入围；lapses 计全部次数、wrongs 去重最近在前', () => {
  const cands = mineErrorPatterns([
    rec({ ts: '2026-09-01T10:00:00', ex: 1, answer: 'B' }),
    rec({ ts: '2026-09-02T10:00:00', ex: 2, answer: 'C', correct: true }),
    rec({ ts: '2026-09-03T10:00:00', ex: 3, answer: 'C' }),
    rec({ ts: '2026-09-04T10:00:00', ex: 4, answer: 'C' }),
  ])
  assert.equal(cands.length, 1)
  assert.equal(cands[0]!.lapses, 3) // 同一错法反复犯也是 3 次高频
  assert.deepEqual(cands[0]!.wrongs, ['C', 'B'])
  assert.equal(cands[0]!.last_wrong, '2026-09-04T10:00:00')
})

test('挖矿：忘记申报/空作答/无 qid 不计；单次答错不入围', () => {
  const recs = [
    rec({ judge: 'forget', answer: '' }),
    rec({ answer: '' }),
    rec({ qid: undefined }),
    rec({ correct: true }),
    rec({ qid: 'q2' }),
  ]
  assert.equal(recs.filter(isMinableWrong).length, 1)
  assert.equal(mineErrorPatterns(recs).length, 0)
})

test('挖矿：课程/节点过滤与 lapses 降序排序', () => {
  const cands = mineErrorPatterns([
    rec({ course: '物理', qid: 'q9' }),
    rec({ course: '物理', qid: 'q9' }),
    rec({ node: '进阶', qid: 'q3' }),
    rec({ node: '进阶', qid: 'q3' }),
    rec({ node: '进阶', qid: 'q3' }),
    rec({ qid: 'q1' }), rec({ qid: 'q1' }),
  ], { course: '数学' })
  assert.deepEqual(cands.map(c => `${c.node}/${c.qid}#${c.lapses}`), ['进阶/q3#3', '入门/q1#2'])
  assert.equal(mineErrorPatterns(recs_物理()).length, 1)
  function recs_物理() {
    return [rec({ course: '物理', qid: 'q9' }), rec({ course: '物理', qid: 'q9' })]
  }
})

// ---- schema 门禁 ----

const goodCard = {
  kind: 'contrast' as const, q: '下面哪个做法是对的？',
  options: ['先验算边界', '直接套公式', '先化简再代人'],
  answer: '先验算边界', mine: '直接套公式', explanation: '边界先行。',
  source_node: '入门', source_q: 'q1',
}

test('schema：合法卡通过；选项数量/重复/answer∉options/mine=answer 逐项拒绝', () => {
  assert.ok(!validateErrorCards({ node: '入门', cards: [goodCard] }).errors)
  const bad = (over: Record<string, unknown>) =>
    validateErrorCards({ node: '入门', cards: [{ ...goodCard, ...over }] }).errors
  assert.ok(bad({ options: ['a', 'b'] })?.some(e => e.includes('options')))
  assert.ok(bad({ options: ['a', 'a', 'b'] })?.some(e => e.includes('互不相同')))
  assert.ok(bad({ answer: '没有的项' })?.some(e => e.includes('answer')))
  assert.ok(bad({ mine: '先验算边界' })?.some(e => e.includes('mine')))
  assert.ok(validateErrorCards({ node: '别的节点', cards: [goodCard] }, '入门')?.errors?.length)
})

// ---- 外部行为（withVault）----

const BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: single_choice',
  '    q: 直角三角形两直角边为 3 和 4，斜边长为？',
  '    options: ["5", "6", "7", "8"]',
  '    answer: A',
  '    explanation: 勾股定理。',
  '    section: s1',
  '  - id: q2',
  '    kind: true_false',
  '    q: 直角边可以为负数。',
  '    answer: false',
  '    section: s1',
].join('\n')

async function seedWrongAttempts(h: Awaited<ReturnType<typeof withVault>>) {
  await h.store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: 'B', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-07T10:00:00' })
  await h.store.appendPractice({ course: '数学', node: '入门', ex: 2, answer: 'C', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-08T10:00:00' })
}

/** 合法模型产出：q1 选项含学习者错答「6」+「7」，q2 忽略（每候选一卡）。 */
const VALID_YAML = [
  'cards:',
  '  - node: 入门',
  '    source_q: q1',
  '    q: 求直角三角形斜边时，第一步该做什么？',
  '    options: ["用勾股定理求斜边", "把两直角边相加", "两直角边平方再开方"]',
  '    answer: 用勾股定理求斜边',
  '    mine: 把两直角边相加',
  '    explanation: 斜边平方 = 两直角边平方之和；相加不是平方和。',
].join('\n')

test('生成→落盘→复习队列汇入：指定课程产出错误对比卡并在队列出现（source=error）', async () => {
  await withVault({ tag: 'learnhub-error-gen-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    // 挖矿预览：候选可人工抽查（q2 只答错一次，不够 MIN_ERROR_LAPSES 门槛）
    const mine = await h.engine.errorCardMine('数学')
    assert.equal(mine.candidates.length, 1)
    assert.equal(mine.candidates[0]!.qid, 'q1')

    const result = await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    assert.equal(result.generated.length, 1)
    assert.deepEqual(result.generated[0]!.ids, ['c1'])
    const cardPath = join(h.paths.errorCardsDir('math'), '入门.yaml')
    assert.ok(existsSync(cardPath))
    assert.match(readFileSync(cardPath, 'utf8'), /把两直角边相加/)

    // 未调度新卡：进复习队列队尾（due=null，source=error，卡面不带答案）
    const q = await h.engine.reviewQueue()
    const hit = q.cards.find(c => c.source === 'error')
    assert.ok(hit)
    assert.equal(hit!.node, '入门')
    assert.equal(hit!.due, null)
    const face = hit!.error!
    assert.equal(face.q, '求直角三角形斜边时，第一步该做什么？')
    assert.deepEqual(face.options, ['用勾股定理求斜边', '把两直角边相加', '两直角边平方再开方'])
    assert.equal((hit! as Record<string, unknown>).answer, undefined)
    assert.equal((hit! as Record<string, unknown>).mine, undefined)
  })
})

test('生成去重与证据不足：已建卡的题不再重复出卡；无候选时明确报错', async () => {
  await withVault({ tag: 'learnhub-error-dup-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    await assert.rejects(
      () => h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML),
      /没有可挖的新错误模式/,
    )
    // 空流水课程同样明确报错（而非静默空产出）
    await withVault({ tag: 'learnhub-error-empty-' }, async h2 => {
      await assert.rejects(
        () => h2.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML),
        /没有可挖的新错误模式/,
      )
    })
  })
})

test('生成事务性：模型产出 (node,source_q) 不在候选清单 → 零落盘', async () => {
  await withVault({ tag: 'learnhub-error-tx-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    const forged = VALID_YAML.replace('source_q: q1', 'source_q: q99')
    await assert.rejects(
      () => h.engine.errorCardGenerate('数学', undefined, async () => forged),
      /候选对照门/,
    )
    assert.ok(!existsSync(h.paths.errorCardsDir('math')))
  })
})

test('作答判分：选对=3 推进+无绑定 XP；选错=1 且 0 XP；复习日志与 practice 零掺入', async () => {
  await withVault({ tag: 'learnhub-error-answer-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    const reviewLogBefore = (await h.store.reviewLogAll()).length
    const practiceBefore = (await h.store.practiceAll()).length

    const wrong = await h.engine.errorCardAnswer('数学', '入门', 'c1', '两直角边平方再开方')
    assert.equal(wrong.correct, false)
    assert.equal(wrong.rating, 1)
    assert.equal(wrong.xp, 0)
    assert.equal(wrong.mine, '把两直角边相加')
    assert.equal(wrong.answer, '用勾股定理求斜边')

    const journal1 = (await h.store.journalTail(null, 5)).at(-1)
    assert.equal(journal1!.kind, 'xp_error')
    assert.equal(journal1!.course, '*')
    assert.equal(journal1!.xp, 0)

    // 同一天第二次推进被拒（一卡一天一次）
    await assert.rejects(
      () => h.engine.errorCardAnswer('数学', '入门', 'c1', '用勾股定理求斜边'),
      /一卡一天一次/,
    )

    // 测量面零掺入：review-log / practice 全程未增
    assert.equal((await h.store.reviewLogAll()).length, reviewLogBefore)
    assert.equal((await h.store.practiceAll()).length, practiceBefore)
  })
})

test('选对路径：昨日已推进的卡今日再答选对 → rating 3 + 无绑定 XP', async () => {
  await withVault({
    tag: 'learnhub-error-right-',
    banks: { 入门: BANK },
    files: [{
      path: '学习中心/math/错误卡/入门.yaml',
      content: [
        'node: 入门',
        'cards:',
        '  - id: c1',
        '    kind: contrast',
        '    q: 求直角三角形斜边时，第一步该做什么？',
        '    options: ["用勾股定理求斜边", "把两直角边相加", "两直角边平方再开方"]',
        '    answer: 用勾股定理求斜边',
        '    mine: 把两直角边相加',
        '    explanation: 斜边平方 = 两直角边平方之和。',
        '    source_node: 入门',
        '    source_q: q1',
        '    fsrs:',
        '      due: 2026-09-08',
        '      stability: 1.0',
        '      difficulty: 5.0',
        '      elapsed_days: 0',
        '      scheduling_lapses: 0',
        '      reps: 1',
        '      state: 2',
        '      last_review: 2026-09-08',
        '    stats: { attempts: 1, correct: 0, last: "2026-09-08" }',
      ].join('\n') + '\n',
    }],
  }, async h => {
    const right = await h.engine.errorCardAnswer('数学', '入门', 'c1', '用勾股定理求斜边')
    assert.equal(right.correct, true)
    assert.equal(right.rating, 3)
    assert.ok(right.xp >= 1)
    assert.ok(right.due > '2026-09-08')
    const row = (await h.store.journalTail(null, 5)).find(r => r.kind === 'xp_error')
    assert.ok(row)
    assert.equal(row!.course, '*')
    assert.equal(row!.xp, right.xp)
    // 队列里旧到期快照不再出现（已推进，新 due 在未来）
    const q = await h.engine.reviewQueue()
    assert.ok(!q.cards.some(c => c.source === 'error' && c.id === 'err:c1'))
  })
})

test('队列排除归档卡；errorCardQueue 管理面带全卡面供人工抽查', async () => {
  await withVault({ tag: 'learnhub-error-arch-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    await h.engine.errorCardArchive('数学', '入门', 'c1', true)
    const q = await h.engine.reviewQueue()
    assert.ok(!q.cards.some(c => c.source === 'error'))
    const list = await h.engine.errorCardQueue('数学')
    assert.equal(list.total, 0)
    await h.engine.errorCardArchive('数学', '入门', 'c1', false)
    const list2 = await h.engine.errorCardQueue('数学')
    assert.equal(list2.total, 1)
    assert.equal(list2.cards[0]!.answer, '用勾股定理求斜边')
    assert.equal(list2.cards[0]!.mine, '把两直角边相加')
  })
})

test('归档后原题重新可挖（covered 只算活跃卡）', async () => {
  await withVault({ tag: 'learnhub-error-remining-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    await h.engine.errorCardArchive('数学', '入门', 'c1', true)
    const result = await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    assert.equal(result.generated[0]!.ids[0], 'c2')
    const doc = await new ErrorCards(h.paths, nodeVaultFs).load('math', '入门')
    assert.equal(doc.cards.length, 2)
  })
})

test('单节点定向复习入口：node 过滤命中错误卡；跨课程拼错节点照旧 fail loud', async () => {
  await withVault({ tag: 'learnhub-error-node-', banks: { 入门: BANK } }, async h => {
    await seedWrongAttempts(h)
    await h.engine.errorCardGenerate('数学', undefined, async () => VALID_YAML)
    const q = await h.engine.reviewQueue('数学', '入门')
    assert.equal(q.cards.filter(c => c.source === 'error').length, 1)
    await assert.rejects(() => h.engine.reviewQueue('数学', '不存在'), /不在/)
  })
})
