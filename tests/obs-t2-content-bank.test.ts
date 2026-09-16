/**
 * 观测面扩展 T2（#290 / ADR-0091）：content/bank 族日志点接线——每个观测点至少一条
 * 内存假 logger 事件断言。事件名与级别以附录 ADR（0091）登记为准，接线不得漂移改名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { withVault, tfQuestion } from './helpers/vault.ts'
import { MAX_SECTIONS } from '../src/engine/complexity.ts'

const manifestLine = (id: string, title: string, type = '概念'): string =>
  `    - { id: ${id}, title: ${title}, type: ${type}, status: pending, version: 0 }`

test('content.gate.alias_missing / content.repair.rich_blocks / content.gate.section_reject：节路径三事件', async () => {
  await withVault({
    notes: {
      入门: {
        content: { version: 1, sections: [manifestLine('s1', '思维节', '思维')] },
      },
    },
  }, async ({ engine, logger }) => {
    // 无 理念与规范.md → 别名门失活；脏 plot 块（尾随逗号）→ 程序性修复；
    // 思维节无预测门 → 拒收（GATE_FAILED）
    const dirty = ['```plot', '{ "a": 1, }', '```', '', '太短的正文。'].join('\n')
    await assert.rejects(
      () => engine.content2.contentSection('数学', '入门', 's1', dirty),
      /质检门未过/,
    )
    assert.equal(logger.count('content.gate.alias_missing'), 1)
    assert.equal(logger.nth('content.gate.alias_missing')!.level, 'info')
    assert.equal(logger.nth('content.gate.alias_missing')!.fields.section, 's1')
    assert.equal(logger.count('content.repair.rich_blocks'), 1)
    assert.equal(logger.nth('content.repair.rich_blocks')!.fields.blocks, 1)
    assert.equal(logger.nth('content.repair.rich_blocks')!.fields.langs, 1)
    assert.equal(logger.count('content.gate.section_reject'), 1)
    assert.equal(logger.nth('content.gate.section_reject')!.level, 'debug')
    assert.equal(typeof logger.nth('content.gate.section_reject')!.fields.errors, 'number')
  })
})

test('content.gate.lenient：满编放行的引擎内视图（WARN + over_by）', async () => {
  const sections = Array.from({ length: MAX_SECTIONS }, (_, i) => manifestLine(`s${i + 1}`, `第${i + 1}节`))
  await withVault({
    notes: { 入门: { content: { version: 1, sections } } },
  }, async ({ engine, logger }) => {
    const long = '正文'.repeat(6000) // 远超拒收线的纯文本（无其他违规）
    const r = await engine.content2.contentSection('数学', '入门', 's1', long)
    assert.ok(r.lenient, '满编节点长正文应降级放行')
    assert.equal(logger.count('content.gate.lenient'), 1)
    const e = logger.nth('content.gate.lenient')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.node, '入门')
    assert.equal(e.fields.section, 's1')
    assert.ok(Number(e.fields.over_by) > 0, 'over_by 应为正数')
  })
})

test('content.pack.registry_broken：概念登记表 Broken 降级留痕（INFO）', async () => {
  await withVault({}, async ({ engine, logger, paths }) => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(paths.courseRoot('math'), { recursive: true })
    await writeFile(paths.conceptRegistryPath('math'), '{oops', 'utf8')
    await engine.content2.contentPack('数学', '入门')
    assert.equal(logger.count('content.pack.registry_broken'), 1)
    assert.equal(logger.nth('content.pack.registry_broken')!.level, 'info')
    assert.equal(logger.nth('content.pack.registry_broken')!.fields.course, '数学')
  })
})

test('content.review_queue.fallback：题库目录 Missing 分流留痕（DEBUG why=missing）', async () => {
  await withVault({}, async ({ engine, logger, paths }) => {
    await rm(paths.bankDir('math'), { recursive: true, force: true })
    await engine.content2.reviewQueue()
    assert.equal(logger.count('content.review_queue.fallback'), 1)
    const e = logger.nth('content.review_queue.fallback')!
    assert.equal(e.level, 'debug')
    assert.equal(e.fields.why, 'missing')
  })
})

test('bank.quiz.grading_retry：AI 判卷解析重试指针（DEBUG，明细在 logGradingFailure）', async () => {
  await withVault({}, async ({ engine, logger }) => {
    const q = { id: 'q1', kind: 'reflection' as const, q: '题干', answer: '要点' }
    await assert.rejects(() => engine.content2.judgeBankAnswer(
      async () => '不是 JSON', q, '我的作答', 'question', { course: '数学', node: '入门', qid: 'q1' },
    ))
    assert.equal(logger.count('bank.quiz.grading_retry'), 2, '恰两次尝试各一条指针')
    assert.equal(logger.nth('bank.quiz.grading_retry')!.level, 'debug')
    assert.equal(logger.nth('bank.quiz.grading_retry')!.fields.kind, 'reflection')
  })
})

test('bank.quiz.cancelled：取消旗标留痕（WARN + added_so_far）', async () => {
  await withVault({
    notes: { 入门: {} },
    banks: { 入门: [tfQuestion('q1')] },
  }, async ({ engine, logger }) => {
    const llm = async () => 'node: 入门\nquestions:\n  - { id: q1, kind: true_false, q: 新题干, answer: true }\n'
    await assert.rejects(() => engine.bank2.questionGenerate('数学', '入门', 1, llm, {
      isCancelled: () => true,
    }), /取消/)
    assert.equal(logger.count('bank.quiz.cancelled'), 1)
    const e = logger.nth('bank.quiz.cancelled')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.course, '数学')
    assert.equal(e.fields.added_so_far, 0)
  })
})

test('bank.quiz.admit_fail：admitQuestion 失败（单题非法）留痕（WARN，过渡期事件）', async () => {
  await withVault({
    notes: { 入门: {} },
    banks: { 入门: [tfQuestion('q1')] },
  }, async ({ engine, logger }) => {
    // single_choice 缺 options：过前置卫生门、被 addQuestion 的 schema 门拒 → invalid
    const llm = async () => 'node: 入门\nquestions:\n  - { id: q2, kind: single_choice, q: 缺选项的题, answer: "A" }\n'
    await assert.rejects(() => engine.bank2.questionGenerate('数学', '入门', 1, llm), /全部未过校验门/)
    assert.equal(logger.count('bank.quiz.admit_fail'), 1)
    const e = logger.nth('bank.quiz.admit_fail')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.node, '入门')
    assert.ok(String(e.fields.qid).length > 0)
  })
})

test('bank.quiz.section_parse_fail：逐节出题 YAML 解析失败留痕（WARN）', async () => {
  await withVault({
    notes: {
      入门: {
        content: { version: 1, sections: [manifestLine('s1', '概念节')] },
        body: ['# 入门', '', '## 概念节', '', '节正文。'],
      },
    },
  }, async ({ engine, logger }) => {
    const llm = async () => '::: 不是 YAML :::'
    const r = await engine.bank2.questionGenerateSections('数学', '入门', llm)
    assert.equal(r.sections, 1)
    assert.equal(r.added, 0, '解析失败的节不入库（综合调用兼底）')
    assert.equal(logger.count('bank.quiz.section_parse_fail'), 1)
    const e = logger.nth('bank.quiz.section_parse_fail')!
    assert.equal(e.level, 'warn')
    assert.equal(e.fields.node, '入门')
  })
})

test('bank.gate.registry_broken：错误卡候选面登记表降级留痕（WARN）', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('q1')] },
  }, async ({ engine, logger, store }) => {
    for (let i = 0; i < 2; i++) {
      await store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: `错答${i}`, correct: false, judge: 'true_false', qid: 'q1' })
    }
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(engine.paths.courseRoot('math'), { recursive: true })
    await writeFile(engine.paths.conceptRegistryPath('math'), '{oops', 'utf8')
    await assert.rejects(() => engine.bank2.errorCardGenerate('数学', {}, async () => {
      throw new Error('脚本化端口：不该走到模型调用')
    }), /没有可挖|全部缺失|脚本化端口/)
    assert.equal(logger.count('bank.gate.registry_broken'), 1)
    assert.equal(logger.nth('bank.gate.registry_broken')!.level, 'warn')
    assert.equal(logger.nth('bank.gate.registry_broken')!.fields.course, '数学')
  })
})

test('bank.card.bank_broken：候选面题库 Broken 排除留痕（WARN）', async () => {
  await withVault({
    notes: { 坏节点: '# 坏节点' },
    files: [{ path: '学习中心/math/题库/坏节点.yaml', content: '{oops' }],
  }, async ({ engine, logger, store }) => {
    for (let i = 0; i < 2; i++) {
      await store.appendPractice({ course: '数学', node: '坏节点', ex: 1, answer: `错答${i}`, correct: false, judge: 'true_false', qid: 'q1' })
    }
    await assert.rejects(() => engine.bank2.errorCardGenerate('数学', {}, async () => {
      throw new Error('脚本化端口')
    }), /全部缺失|脚本化端口/)
    assert.equal(logger.count('bank.card.bank_broken'), 1)
    assert.equal(logger.nth('bank.card.bank_broken')!.fields.node, '坏节点')
  })
})

test('bank.card.skip_broken / bank.card.broken_seen：Broken 卡组与共用遍历的指针', async () => {
  await withVault({}, async ({ engine, logger, paths }) => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    // skip_broken：错误卡目录里的 Broken 卡组
    await mkdir(paths.errorCardsDir('math'), { recursive: true })
    await writeFile(`${paths.errorCardsDir('math')}/入门.yaml`, '{oops', 'utf8')
    for await (const _ of engine.bank2.errorCardTriples([{ name: '数学', root: 'math' }])) { /* 空消费 */ }
    assert.equal(logger.count('bank.card.skip_broken'), 1)
    assert.equal(logger.nth('bank.card.skip_broken')!.level, 'debug')
    // broken_seen：共用题库遍历见闻 Broken（照旧上抛，消费方各自分流）
    logger.clear()
    await writeFile(`${paths.bankDir('math')}/入门.yaml`, '{oops', 'utf8')
    await assert.rejects(() => engine.learner.scanCourseBanks(
      { id: 'math-01', name: '数学', root: 'math', enabled: true },
      async () => undefined,
    ))
    assert.equal(logger.count('bank.card.broken_seen'), 1)
    assert.equal(logger.nth('bank.card.broken_seen')!.level, 'debug')
    assert.equal(logger.nth('bank.card.broken_seen')!.fields.node, '入门')
  })
})
