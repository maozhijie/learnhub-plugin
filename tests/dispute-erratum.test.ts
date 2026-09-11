/**
 * 瑕疵题勘误与判罚冲正（ADR-0031）：
 * - 申诉复核（LLM 两阶段三态）只读不落盘；解析失败 fail loud 留豁免降级口
 * - rekey：改键 + 新键重判原作答，改判对补 XP/对错/EMA；判罚维持只修键
 * - void/overridden：作答作废（XP 归零、attempts−1、EMA 逆步），复核说没问题也可强制豁免
 * - 冲正走 勘误.jsonl 追加，practice.jsonl 不改写；XP/attemptStats 读侧净额
 * - FSRS 不回滚；同一条作答至多冲正一次
 * - 出题写入侧多选 ≥2 正确项门禁（prompt 约束的服务端兜底），生成路径拒收报告
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { withVault } from './helpers/vault.ts'

const MC_BANK = [
  'node: 入门',
  'questions:',
  '  - id: q13',
  '    kind: multi_choice',
  '    q: 对多项式，下列说法正确的有（　）',
  '    options: ["甲", "乙", "丙", "丁"]',
  '    answer: ["A", "C"]',
  '    explanation: 存储解析。',
  '    difficulty: 1',
].join('\n')

/** 复核回复：verdict + 建议键。 */
function reviewReply(verdict: string, suggested: unknown, reasoning = '独立解题过程……对账……'): string {
  return JSON.stringify({
    verdict, reasoning,
    ...(suggested !== undefined ? { suggested_answer: suggested } : {}),
    ...(verdict === 'key_error' ? { suggested_explanation: '新解析。' } : {}),
  })
}

test('rekey：新键重判原作答 → 改判对，XP 补记、对错/EMA 修正、勘误留痕', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', practice: { attempts: 0, correct: 0, ema: 0.7 } } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    const wrong = await engine.questionAnswer(async () => 'unused', '数学', '入门', 'q13', 'A,B', 30)
    assert.equal(wrong.correct, false)
    assert.equal(wrong.diff, '漏选了 C，多选了 B')

    const review = await engine.bank2.questionDisputeReview(async () => reviewReply('key_error', ['A', 'B']), '数学', '入门', 'q13')
    assert.equal(review.verdict, 'key_error')
    assert.ok(review.target_ts, '复核返回被冲正作答的 ts')

    const r = await engine.questionDisputeApply('数学', '入门', 'q13', 'rekey', {
      targetTs: review.target_ts,
      revision: { answer: ['A', 'B'], explanation: '新解析。' },
    })
    assert.equal(r.resolution, 'rekey')
    assert.equal(r.correct_now, true)
    assert.ok((r.xp ?? 0) >= 1, '改判对按对题补记 XP')

    // 题库：键已改；stats 按净流水重算（该条按对计）
    const q = (await engine.bank.load(engine.paths.courseRoot('math'), '入门')).questions[0]
    assert.deepEqual(q.answer, ['A', 'B'])
    assert.equal(q.explanation, '新解析。')
    assert.equal(q.stats?.attempts, 1)
    assert.equal(q.stats?.correct, 1)
    assert.equal(q.stats?.last_correct, true)

    // 节点 frontmatter：correct+1、EMA 撤 0 分步补 1 分步（0.49+0.3=0.79）；attempts 不变
    const note = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    assert.match(note, /correct: 1/)
    assert.match(note, /practice_ema: 0\.79/)

    // XP 读侧净额：原 0 分替换为对题 XP
    const xp = await engine.sched2.xpStatus()
    assert.equal(xp.today_xp, r.xp)

    // 勘误流水留痕；原 practice 流水不改写（仍含原判错行）
    const errata = await engine.store.erratumAll()
    assert.equal(errata.length, 1)
    assert.equal(errata[0].verdict, 'key_error')
    assert.equal(errata[0].correct, true)
    const practiceRaw = await readFile(engine.paths.practicePath, 'utf8')
    assert.match(practiceRaw, /"correct":false/)

    // 同一条作答不能二次申诉
    await assert.rejects(
      () => engine.bank2.questionDisputeReview(async () => reviewReply('ok'), '数学', '入门', 'q13'),
      /至多申诉一次/,
    )
  })
})

test('rekey：原作答也不符合新键 → 只修键，判罚与证据净零变动', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', practice: { attempts: 0, correct: 0, ema: 0.7 } } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    await engine.questionAnswer(async () => 'unused', '数学', '入门', 'q13', 'A,B', 30)
    const r = await engine.questionDisputeApply('数学', '入门', 'q13', 'rekey', {
      revision: { answer: ['B', 'C'] },
    })
    assert.equal(r.correct_now, false)
    assert.equal(r.xp, 0)
    const q = (await engine.bank.load(engine.paths.courseRoot('math'), '入门')).questions[0]
    assert.deepEqual(q.answer, ['B', 'C'])
    assert.equal(q.stats?.correct, 0, '新键下原作答仍不符，对错维持')
    assert.equal(q.stats?.attempts, 1)
    // 证据净零：判罚维持时 EMA/attempts 不得被逆向调整（审查修复：只修键）
    const note = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    assert.match(note, /attempts: 1/)
    assert.match(note, /practice_ema: 0\.49/, 'EMA 维持答错后的 0.7×0.7，不撤步')
  })
})

test('void：作答作废——XP 净值归零（乱猜罚返还）、attempts−1、EMA 逆步、FSRS 不回滚', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', practice: { attempts: 0, correct: 0, ema: 0.7 } } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    const wrong = await engine.questionAnswer(async () => 'unused', '数学', '入门', 'q13', 'A,B', 30)
    const before = (await engine.bank.load(engine.paths.courseRoot('math'), '入门')).questions[0]
    const fsBefore = before.fsrs

    const r = await engine.questionDisputeApply('数学', '入门', 'q13', 'void', { reason: '题面超纲' })
    assert.equal(r.verdict, 'defective')
    assert.equal(r.correct_now, null)
    assert.equal(r.xp, 0)

    const q = (await engine.bank.load(engine.paths.courseRoot('math'), '入门')).questions[0]
    assert.deepEqual(q.stats, { attempts: 0, correct: 0 }, '作废条从题目统计剔除')
    assert.equal(q.archived, true, '瑕疵题归档随作废结算原子落盘（ADR-0031）')
    assert.deepEqual(q.fsrs, fsBefore, 'FSRS 不回滚（ADR-0031：调度误差自愈，review-log 不抹）')

    const note = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    assert.match(note, /attempts: 0/)
    assert.match(note, /practice_ema: 0\.7/, 'EMA 逆向一步回到 0.49/0.7')

    const xp = await engine.sched2.xpStatus()
    assert.equal(xp.today_xp, 0)
    const stats = await engine.store.attemptStats('数学', '入门')
    assert.equal(stats.attempts, 0, 'attemptStats 读侧按净值剔除')

    assert.equal(wrong.correct, false)
  })
})

test('乱猜判错的 void 返还 −1 XP', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    const guessed = await engine.questionAnswer(async () => 'unused', '数学', '入门', 'q13', 'A,B', 2)
    assert.equal(guessed.xp, -1)
    await engine.questionDisputeApply('数学', '入门', 'q13', 'void', {})
    const xp = await engine.sched2.xpStatus()
    assert.equal(xp.today_xp, 0, '乱猜 −1 随作废返还')
  })
})

test('复核说题没问题仍可强制豁免（overridden），题保留在调度里', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    await engine.questionAnswer(async () => 'unused', '数学', '入门', 'q13', 'A,B', 30)
    const review = await engine.bank2.questionDisputeReview(async () => reviewReply('ok', undefined), '数学', '入门', 'q13')
    assert.equal(review.verdict, 'ok')
    const r = await engine.questionDisputeApply('数学', '入门', 'q13', 'overridden', { reason: '仍不服' })
    assert.equal(r.verdict, 'overridden')
    assert.equal(r.correct_now, null)
    const errata = await engine.store.erratumAll()
    assert.equal(errata[0].verdict, 'overridden')
    const q = (await engine.bank.load(engine.paths.courseRoot('math'), '入门')).questions[0]
    assert.equal(q.archived, undefined, '强制豁免不归档题目')
  })
})

test('复核输出不可解析：重试一次后 fail loud，不改任何数据', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    await engine.questionAnswer(async () => 'unused', '数学', '入门', 'q13', 'A,B', 30)
    let calls = 0
    await assert.rejects(
      () => engine.bank2.questionDisputeReview(async () => { calls++; return '模型胡言乱语' }, '数学', '入门', 'q13'),
      /AI 复核输出不可用/,
    )
    assert.equal(calls, 2, '自动重问一次（#116 同款）')
    assert.equal((await engine.store.erratumAll()).length, 0, '复核只读不落盘')
  })
})

test('没有判错记录的题不可申诉', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    await assert.rejects(
      () => engine.bank2.questionDisputeReview(async () => reviewReply('ok'), '数学', '入门', 'q13'),
      /没有可申诉的判错作答/,
    )
  })
})

test('AI 判卷题型不走申诉（Q8 裁定：评分异议走讲解通道）', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: `${bankTextReflection()}\n` },
  }, async ({ engine }) => {
    // reflection 判错（AI 判卷 0.2 分 < 0.6 及格线）
    await engine.questionAnswer(async () => JSON.stringify({ score: 0.2, feedback: '不完整' }), '数学', '入门', 'a1', '我的回答', 30)
    await assert.rejects(
      () => engine.bank2.questionDisputeReview(async () => reviewReply('ok'), '数学', '入门', 'a1'),
      /不走申诉/,
    )
    await assert.rejects(
      () => engine.questionDisputeApply('数学', '入门', 'a1', 'void', {}),
      /不走申诉/,
    )
    assert.equal((await engine.store.erratumAll()).length, 0)
  })
})

/** reflection 题的题库 YAML（评分要点型 answer）。 */
function bankTextReflection(): string {
  return [
    'node: 入门',
    'questions:',
    '  - id: a1',
    '    kind: reflection',
    '    q: 用自己的话解释这个概念。',
    '    answer: 评分要点：概念准确、举例恰当。',
  ].join('\n')
}

test('写入侧多选 ≥2 正确项门禁：addQuestion 拒收；生成路径拒收并报告；存量库照常可读', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', body: ['# 入门', '', '正文内容，讲一个概念。'].join('\n') } },
    banks: { 入门: MC_BANK },
  }, async ({ engine }) => {
    await assert.rejects(
      () => engine.bank.addQuestion(engine.paths.courseRoot('math'), '入门', {
        kind: 'multi_choice', q: '凑不齐', options: ['甲', '乙'], answer: ['A'],
      }),
      /至少 2 个/,
    )
    // 修订路径同门禁：把存量多选改成单正确项 → 拒绝
    await assert.rejects(
      () => engine.questionUpdate('数学', '入门', 'q13', { answer: ['A'] }),
      /至少 2 个/,
    )
    // 生成路径：坏多选拒收进 rejected，好题照常入库
    const yaml = [
      'node: 入门',
      'questions:',
      '  - id: x1',
      '    kind: true_false',
      '    q: 好题？',
      '    answer: true',
      '    difficulty: 1',
      '  - id: x2',
      '    kind: multi_choice',
      '    q: 坏多选，只有一个正确项。',
      '    options: ["甲", "乙", "丙", "丁"]',
      '    answer: ["A"]',
      '    difficulty: 1',
    ].join('\n')
    const r = await engine.questionGenerate('数学', '入门', 2, async () => yaml)
    assert.equal(r.added, 1)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0].reason, /至少 2 个/)
    // 存量形态宽松：validateBank 不把历史单正确项多选读成 Broken（显式盘点修复，ADR-0004）
    const bank = await engine.bank.load(engine.paths.courseRoot('math'), '入门')
    assert.ok(bank.questions.length >= 2)
  })
})
