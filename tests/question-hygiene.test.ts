/**
 * 题目卫生（ADR-0029/0030）：转义损坏修复、记法契约检测、唯一答案填空边界的
 * 单元与管线集成测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { withVault } from './helpers/vault.ts'
import { YAML } from '../src/engine/yaml.ts'
import {
  repairModelEscapes, hasEscapeCorruption, notationViolation,
  blankAnswerViolation, repairQuestionStrings, questionViolation, auditQuestion,
} from '../src/engine/question-hygiene.ts'

// ---- 转义损坏修复（YAML/JSON 双引号吃掉 LaTeX 反斜杠）----

test('修复：tab+imes 还原为 \\times（用户截图的 3.14<tab>imes57 损坏形态）', () => {
  const corrupted = '3.14\times57' // \t = YAML 双引号吃掉 \times 后的真实制表符
  const r = repairModelEscapes(corrupted)
  assert.equal(r.text, '3.14\\times57')
  assert.equal(r.repaired, 1)
  assert.equal(r.unrepairable, false)
})

test('修复：响铃+lpha → \\alpha、换页+rac → \\frac、换行+abla → \\nabla', () => {
  assert.equal(repairModelEscapes('\x07lpha').text, '\\alpha')
  assert.equal(repairModelEscapes('\x0Crac{1}{2}').text, '\\frac{1}{2}')
  assert.equal(repairModelEscapes('\nabla x').text, '\\nabla x')
})

test('修复：最长命令片段优先（tab+ext → \\text 而非误配）', () => {
  assert.equal(repairModelEscapes('\text{面积}').text, '\\text{面积}')
})

test('修复：合法换行保留不动、修不掉的 tab 判不可修复', () => {
  const legit = '第一段\n第二段'
  const r = repairModelEscapes(legit)
  assert.equal(r.text, legit)
  assert.equal(r.repaired, 0)
  assert.equal(r.unrepairable, false)
  const stuck = repairModelEscapes('a\tb')
  assert.equal(stuck.unrepairable, true, 'tab 后无已知命令片段 → 损坏')
  assert.equal(hasEscapeCorruption('a\tb'), true)
  assert.equal(hasEscapeCorruption('正常中文'), false)
})

test('端到端：YAML 双引号标量解析出控制字符后修复回 LaTeX', () => {
  const doc = YAML.parse('q: "$3.14\\times57$"') as { q: string } // YAML 源里是反斜杠+t
  assert.equal(doc.q, '$3.14\times57$', '复现：\t 被解释成制表符')
  const r = repairModelEscapes(doc.q)
  assert.equal(r.text, '$3.14\\times57$')
})

// ---- 记法契约检测（ADR-0030）----

test('记法：裸 ^、下标 _、裸 LaTeX 命令判违规；$…$ 内的合法记法放行', () => {
  assert.match(notationViolation('多项式 6x^3 y 的公因式是？')!, /ASCII 上标/)
  assert.match(notationViolation('数列 a_1 与 a_2 的关系')!, /ASCII 下标/)
  assert.match(notationViolation('结果是 \\times 表示乘')!, /裸 LaTeX/)
  assert.equal(notationViolation('化简 $6x^3 y$ 与 $a_1$，独立式 $$x^2$$'), null)
  assert.equal(notationViolation('没有任何数学的概念题'), null)
})

test('记法：代码块与行内代码先剥除，不误判（plot/svg 数据里允许 ^）', () => {
  const md = '解析见下图：\n\n```plot\n{ "elements": [{ "type": "fn", "expr": "x^2" }] }\n```\n\n完毕'
  assert.equal(notationViolation(md), null)
  assert.equal(notationViolation('行内代码 `x^2` 不算违规'), null)
})

// ---- 唯一答案填空边界（ADR-0029）----

test('填空边界：数值答案、代数式答案判违规；术语答案放行', () => {
  assert.match(blankAnswerViolation('314')!, /数值.*numeric/)
  assert.match(blankAnswerViolation('0.75')!, /数值/)
  assert.match(blankAnswerViolation('4a^2b^2(3a-2b)')!, /代数式.*single_choice/)
  assert.match(blankAnswerViolation('(x-y+4)/2')!, /代数式/)
  assert.equal(blankAnswerViolation('DNA 聚合酶'), null)
  assert.equal(blankAnswerViolation('勾股定理'), null)
  assert.equal(blankAnswerViolation('3σ原则'), null, '含数字的术语不是数值')
})

// ---- 组合门禁与修复摘要 ----

test('repairQuestionStrings：就地修复题干/选项/答案并计数', () => {
  const q: Record<string, unknown> = {
    kind: 'single_choice',
    q: '计算 3.14\times57',
    options: ['3.14\times100', '314'],
    answer: '3.14\times57',
    explanation: '提取 \tactor 3.14', // tab 后非命令片段 → unrepairable
  }
  const r = repairQuestionStrings(q)
  assert.equal(r.repaired, 3)
  assert.equal(r.unrepairable, true)
  assert.equal(q.q, '计算 3.14\\times57')
  assert.deepEqual(q.options, ['3.14\\times100', '314'])
})

test('questionViolation：记法违规在题干/选项/解析任一处命中；填空边界按题型检查', () => {
  assert.match(questionViolation({ kind: 'single_choice', q: '多项式 6x^3 y 的公因式' })!, /ASCII 上标/)
  assert.match(questionViolation({ kind: 'single_choice', q: '正常题干', options: ['2x^2 y', '2xy'] })!, /ASCII 上标/)
  assert.match(questionViolation({ kind: 'fill_in_blank', q: '正常题干', answer: ['4'] })!, /数值.*numeric/)
  assert.equal(questionViolation({ kind: 'fill_in_blank', q: '正常题干', answer: ['公差'] }), null)
  assert.equal(questionViolation({ kind: 'true_false', q: '正常题干', answer: true }), null)
})

// ---- 管线集成（withVault）----

const NOTE = ['# 入门', '', '## 概念：大三度', '', '大三度 = 4 个半音，口诀「大=宽」。'].join('\n')

test('管线集成：双引号转义损坏在入库前被确定性修复并计数（escapesRepaired 留痕）', async () => {
  await withVault({ notes: { 入门: { body: NOTE.split('\n') } } }, async ({ engine, paths }) => {
    const r = await engine.bank2.questionGenerate('数学', '入门', 1, async () => [
      'node: 入门',
      'questions:',
      '  - kind: single_choice',
      '    q: "计算 $3.14\\times57 + 3.14\\times43$ 的结果"', // 双引号 → \t 被吃成控制字符
      '    options: ["314", "3.14", "3140", "31.4"]',
      '    answer: A',
      '    explanation: "分配律逆用：$3.14\\times(57+43)$"',
    ].join('\n'))
    assert.equal(r.added, 1)
    assert.equal(r.escapesRepaired, 3, '题干两处 \\times + 解析一处')
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.match(bank.questions[0]!.q, /3\.14\\times57/, '入库题面的 LaTeX 已还原')
    assert.match(bank.questions[0]!.explanation!, /\\times\(57\+43\)/)
  })
})

test('管线集成：记法违规与数字填空被拒收并报告原因（ADR-0029/0030 门禁）', async () => {
  await withVault({ notes: { 入门: { body: NOTE.split('\n') } } }, async ({ engine }) => {
    const r = await engine.bank2.questionGenerate('数学', '入门', 3, async () => [
      'node: 入门',
      'questions:',
      '  - kind: single_choice',
      '    q: 多项式 6x^3 y 的公因式是？', // ASCII ^ → 拒收
      '    options: ["2x^2 y", "2xy", "x^2 y", "2x^2 y^2"]',
      '    answer: A',
      '  - kind: fill_in_blank',
      '    q: 提取公因式：12a³b² − 8a²b³ = ____。',
      '    answer: ["4a^2b^2(3a-2b)"]', // 代数式填空 → 拒收
      '  - kind: true_false',
      '    q: 大三度有 4 个半音。',
      '    answer: true', // 合规 → 入库
    ].join('\n'))
    assert.equal(r.added, 1)
    assert.equal(r.rejected.length, 2)
    assert.match(r.rejected[0]!.reason, /ASCII 上标/)
    assert.match(r.rejected[1]!.reason, /代数式.*ADR-0029/)
  })
})

test('管线集成：修不掉的转义损坏拒收（unrepairable）', async () => {
  await withVault({ notes: { 入门: { body: NOTE.split('\n') } } }, async ({ engine }) => {
    const r = await engine.bank2.questionGenerate('数学', '入门', 2, async () => [
      'node: 入门',
      'questions:',
      '  - kind: single_choice',
      '    q: "损坏的\t制表符题干"',
      '    options: ["甲", "乙", "丙", "丁"]',
      '    answer: A',
      '  - kind: true_false',
      '    q: 大三度有 4 个半音。',
      '    answer: true', // 合规 → 入库
    ].join('\n'))
    assert.equal(r.added, 1)
    assert.equal(r.rejected.length, 1)
    assert.match(r.rejected[0]!.reason, /转义损坏/)
  })
})

// ---- 存量体检（只读）----

test('questionAudit：违规存量出清单（表达式填空/ASCII 数学/超长解析），合规题不标', async () => {
  await withVault({
    notes: { 入门: { body: NOTE.split('\n') } },
    banks: {
      入门: [
        'node: 入门',
        'questions:',
        '  - id: q1',
        '    kind: fill_in_blank',
        '    q: 提取公因式：12a³b² − 8a²b³ = ____。',
        '    answer: ["4a^2b^2(3a-2b)"]',
        '  - id: q2',
        '    kind: single_choice',
        '    q: 多项式 6x^3 y 的公因式是？',
        '    options: ["2x^2 y", "2xy", "x^2 y", "2x^2 y^2"]',
        '    answer: A',
        '  - id: q3',
        '    kind: true_false',
        '    q: 大三度有 4 个半音。',
        '    answer: true',
        `  - id: q4`,
        '    kind: reflection',
        '    q: 复述公因式提取的步骤。',
        `    answer: 要点\n    explanation: ${'长'.repeat(401)}`,
      ].join('\n'),
    },
  }, async ({ engine }) => {
    const report = await engine.questionAudit()
    assert.equal(report.banks, 1)
    assert.equal(report.questions, 4)
    assert.equal(report.flagged, 3)
    const byId = new Map(report.findings.map(f => [f.id, f]))
    assert.match(byId.get('q1')!.issues[0]!, /代数式/)
    assert.match(byId.get('q2')!.issues[0]!, /ASCII 上标/)
    assert.match(byId.get('q4')!.issues[0]!, /超过软上限/)
    assert.equal(byId.get('q3'), undefined, '合规题不进清单')
  })
})

test('auditQuestion：转义损坏特征（控制字符）单独报issue', () => {
  const issues = auditQuestion({ id: 'q1', kind: 'numeric', q: '计算 3.14\times57', answer: '314' })
  assert.equal(issues.length, 1)
  assert.match(issues[0]!, /控制字符/)
})
