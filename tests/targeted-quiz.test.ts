import test from 'node:test'
import assert from 'node:assert/strict'
import { withVault } from './helpers/vault.ts'

/** 带两节正文的节点：s1 概念：大三度 / s2 概念：小三度。 */
const SECTION_BODY = [
  '# 入门', '',
  '## 概念：大三度', '',
  '大三度 = 4 个半音，口诀「大=宽」。', '',
  '## 概念：小三度', '',
  '小三度 = 3 个半音，口诀「小=窄」。',
].join('\n')

test('#117 定向补题：产物强制绑节 id、提示词只附该节正文、count 缺省 3', async () => {
  await withVault({
    notes: { 入门: { body: SECTION_BODY.split('\n') } },
  }, async ({ engine }) => {
    const prompts: string[] = []
    const r = await engine.questionGenerate('数学', '入门', undefined, async prompt => {
      prompts.push(prompt)
      // 模型照抄节 id
      return [
        'node: 入门',
        'questions:',
        '  - kind: true_false',
        '    q: 大三度是 4 个半音吗？',
        '    answer: true',
        '    section: s1',
      ].join('\n')
    }, { section: { id: 's1', title: '概念：大三度' } })
    assert.equal(r.added, 1)
    assert.equal(r.rejected.length, 0)
    // 提示词：单节强绑指令 + 只附该节正文（另一节内容不出现）
    assert.match(prompts[0], /section 字段必须精确写「s1」/)
    assert.match(prompts[0], /大三度 = 4 个半音/)
    assert.doesNotMatch(prompts[0], /小=窄/, '定向补题不附其他节正文')
    // count 缺省 3（定向补题），整节点缺省仍为 6
    assert.match(prompts[0], /3 道/)
  })
})

test('#117 section 归一化回填：模型写节标题（带/不带类型前缀）都归一到节 id', async () => {
  await withVault({
    notes: { 入门: { body: SECTION_BODY.split('\n') } },
  }, async ({ engine, paths }) => {
    const r = await engine.questionGenerate('数学', '入门', 1, async () => [
      'node: 入门',
      'questions:',
      // 模型照抄了正文标题原文（带类型前缀）→ 归一化回填 s1
      '  - kind: true_false',
      '    q: 大三度是 4 个半音吗？',
      '    answer: true',
      '    section: 概念：大三度',
    ].join('\n'), { section: { id: 's1', title: '概念：大三度' } })
    assert.equal(r.added, 1)
    assert.equal(r.rejected.length, 0)
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.equal(bank.questions[0]!.section, 's1', '落库 section 已回填为节 id')
  })
})

test('#117 无法归类的题拒收并报告：不入库、fail loud 不兜底「通用」', async () => {
  await withVault({
    notes: { 入门: { body: SECTION_BODY.split('\n') } },
  }, async ({ engine, paths }) => {
    const r = await engine.questionGenerate('数学', '入门', 3, async () => [
      'node: 入门',
      'questions:',
      '  - kind: true_false',
      '    q: 完全无关的一题。',
      '    answer: true',
      '    section: s9',
      '  - kind: true_false',
      '    q: 没有节标注的一题。',
      '    answer: true',
      '  - kind: true_false',
      '    q: 正确绑节的一题。',
      '    answer: true',
      '    section: s2',
    ].join('\n'), { section: { id: 's2', title: '概念：小三度' } })
    assert.equal(r.added, 1)
    assert.equal(r.rejected.length, 2, '错节与缺节各拒收一道并报告')
    assert.match(r.rejected[0]!.reason, /s9.*无法归类|无法归类/)
    assert.match(r.rejected[1]!.reason, /缺少 section 标注/)
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.equal(bank.questions.length, 1)
    assert.equal(bank.questions[0]!.section, 's2')
    assert.match(bank.questions[0]!.q, /正确绑节/)
  })
})

test('#117 找不到节正文 fail loud，不静默附全文', async () => {
  await withVault({
    notes: { 入门: { body: SECTION_BODY.split('\n') } },
  }, async ({ engine }) => {
    await assert.rejects(
      () => engine.questionGenerate('数学', '入门', undefined, async () => 'node: 入门\nquestions: []',
        { section: { id: 's9', title: '不存在的节' } }),
      /找不到节「不存在的节」/,
    )
  })
})

test('#117 取消旗标逐题生效：取消后停止入库并抛取消', async () => {
  await withVault({
    notes: { 入门: { body: SECTION_BODY.split('\n') } },
  }, async ({ engine, paths }) => {
    let cancelled = false
    await assert.rejects(
      () => engine.questionGenerate('数学', '入门', 3, async () => {
        cancelled = true // 模型产出落定后、逐题入库前取消生效
        return [
          'node: 入门',
          'questions:',
          '  - kind: true_false',
          '    q: 第一题。',
          '    answer: true',
          '  - kind: true_false',
          '    q: 第二题。',
          '    answer: true',
        ].join('\n')
      }, { isCancelled: () => cancelled }),
      /生成已取消/,
    )
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.equal(bank.questions.length, 0, '取消后的批次零入库（首题前即取消）')
  })
})
