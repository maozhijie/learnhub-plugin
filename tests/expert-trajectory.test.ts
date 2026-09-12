/**
 * 专家思维轨迹节段（P-8 / #97）：新节类型「思维」+ 预测门机器块。
 *
 * - shared 单一事实源：SECTION_TYPES 增「思维」；parsePredictBlock/splitPredictSegments
 *   为引擎质检门与 UI 阅读流门共用解析器（纯函数）。
 * - 生成注入：高 bloom/difficulty 节点的上下文包注入 §11 专家思维轨迹指令
 *   （与 PS-I §10 同一触发面）；平易节点不注入。
 * - 质检门：learnhub-predict 块全节结构校验；思维节必须至少一处预测门；
 *   完成门禁与调度语义零改动（节类型不参与任何调度判定）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SECTION_TYPES, parsePredictBlock, splitPredictSegments, parseSectionTitle } from '../shared/content-renderers.ts'
import { Content } from '../src/engine/content.ts'
import { withVault } from './helpers/vault.ts'

// ---- shared：节类型与预测门解析 ----

test('节类型菜单含「思维」，标题解析回推思维轨迹', () => {
  assert.ok(SECTION_TYPES.some(t => t.prefix === '思维'))
  const parsed = parseSectionTitle('思维：专家怎么想')
  assert.equal(parsed.type.prefix, '思维')
  assert.equal(parsed.type.label, '思维轨迹')
  assert.equal(parsed.clean, '专家怎么想')
  assert.ok(Content.parseOutline('node: x\nsections:\n  - { id: s1, title: 思维：专家怎么想, type: 思维 }').length === 1)
})

const GOOD_BLOCK = 'q: 接下来先做什么？\noptions: ["先验算边界", "直接展开"]\nanswer: 先验算边界\nwhy: 边界先行。'

test('parsePredictBlock：合法块解析；缺字段/选项越界/重复项/answer 不在 options 逐项拒绝', () => {
  assert.deepEqual(parsePredictBlock(GOOD_BLOCK), { q: '接下来先做什么？', options: ['先验算边界', '直接展开'], answer: '先验算边界', why: '边界先行。' })
  // 无 why 合法
  assert.ok(!('error' in parsePredictBlock('q: q\noptions: ["a", "b"]\nanswer: a')))
  const bad = (text: string) => (parsePredictBlock(text) as { error: string }).error
  assert.match(bad('options: ["a", "b"]\nanswer: a'), /缺少 q/)
  assert.match(bad('q: q\nanswer: a'), /缺少 options/)
  assert.match(bad('q: q\noptions: 不是数组\nanswer: a'), /数组/)
  assert.match(bad('q: q\noptions: ["a"]\nanswer: a'), /2–4 项/)
  assert.match(bad('q: q\noptions: ["a", "a"]\nanswer: a'), /互不相同/)
  assert.match(bad('q: q\noptions: ["a", "b"]\nanswer: c'), /answer 必须是 options/)
})

test('splitPredictSegments：md/predict 分段，predict 段携带块后内容', () => {
  const md = `前文。\n\n\`\`\`learnhub-predict\n${GOOD_BLOCK}\n\`\`\`\n\n后文。`
  const segs = splitPredictSegments(md)
  assert.deepEqual(segs.map(s => s.type), ['md', 'predict', 'md'])
  assert.match(segs[0]!.type === 'md' ? segs[0].md : '', /前文/)
  assert.equal(segs[1]!.type === 'predict' ? segs[1].after : '', '\n\n后文。')
  assert.ok(segs[1]!.type === 'predict' && !('error' in segs[1].parsed))
  // 无块：不分段
  assert.deepEqual(splitPredictSegments('只有正文').map(s => s.type), ['md'])
})

// ---- 质检门纯函数 ----

test('checkPredictBlocks：结构合法零 findings，坏块给出定位', () => {
  assert.deepEqual(Content.checkPredictBlocks(`\`\`\`learnhub-predict\n${GOOD_BLOCK}\n\`\`\``), [])
  const findings = Content.checkPredictBlocks('```learnhub-predict\nq: q\noptions: ["a", "b"]\nanswer: 坏的\n```')
  assert.equal(findings.length, 1)
  assert.match(findings[0]!, /第 1 块不合法/)
  // learnhub- 前缀机器块不进「未注册语言」警告
  assert.deepEqual(Content.checkRendererLangs('```learnhub-predict\nx\n```'), [])
})

// ---- 生成注入：高难节点 §11 ----

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 高难节点, pre: [], opt: false, note: "", difficulty: 4 }',
  '      - { name: 高bloom节点, pre: [], opt: false, note: "", bloom: 评价 }',
  '      - { name: 平易节点, pre: [], opt: false, note: "", difficulty: 2 }',
].join('\n')

test('上下文包：高难节点注入 §11 专家思维轨迹（含预测门格式），平易节点不注入', async () => {
  await withVault({ tag: 'learnhub-expert-pack-', graph: GRAPH }, async ({ engine }) => {
    const high = await engine.content2.contentPack('数学', '高难节点')
    assert.match(high, /## 11\. 专家思维轨迹/)
    assert.match(high, /「思维」节/)
    assert.match(high, /learnhub-predict/)
    assert.match(high, /故意踩一次坑/)
    assert.match(high, /元策略/)

    // bloom 高阶层单独即触发（#97 验收口径「高 bloom 节点可生成」）
    const bloom = await engine.content2.contentPack('数学', '高bloom节点')
    assert.match(bloom, /## 11\. 专家思维轨迹/)

    const easy = await engine.content2.contentPack('数学', '平易节点')
    assert.doesNotMatch(easy, /专家思维轨迹/)
    assert.doesNotMatch(easy, /learnhub-predict/)
  })
})

// ---- 上下文包裁剪：大纲消费不带 §8 交付要求 ----

test('上下文包裁剪：omitDeliverables 剥掉 §8（机器块指令不进大纲调用），其余段保留', async () => {
  await withVault({ tag: 'learnhub-expert-pack-', graph: GRAPH }, async ({ engine }) => {
    const outline = await engine.content2.contentPack('数学', '平易节点', { omitDeliverables: true })
    assert.doesNotMatch(outline, /## 8\. 交付要求/)
    assert.doesNotMatch(outline, /enc_candidates/, '机器块指令是节正文契约，与大纲「只输出一个 YAML」冲突')
    assert.match(outline, /## 5\. 禁止使用的概念/, '前置边界保留（大纲规划需要）')
    assert.match(outline, /## 9\. 复杂度档案/, '节数/篇幅预算锚保留')
    const full = await engine.content2.contentPack('数学', '平易节点')
    assert.match(full, /## 8\. 交付要求/, '默认包不动（节正文照常带机器块指令）')
  })
})

// ---- sectionApply 集成：思维节预测门必备 ----

const NOTE_SECTIONS = [
  '    - { id: s1, title: 思维：专家怎么想, type: 思维, status: pending, version: 0 }',
]

const VALID_SECTION_MD = [
  '## 思维：专家怎么想',
  '',
  '拿到题我先扫了一眼条件，直觉是直接套公式。',
  '',
  '> **元评论**：等等，这里我差点跳过适用条件——什么信号暴露了它？',
  '',
  '```learnhub-predict',
  'q: 接下来专家先做什么？',
  'options: ["先验算边界条件", "直接套公式展开"]',
  'answer: 先验算边界条件',
  'why: 边界先行是这类题的通用第一步。',
  '```',
  '',
  '先验算边界：确认条件满足后，展开推导一气呵成。',
  '',
  '**元策略**：先看适用边界，再动手展开。',
].join('\n')

async function applySection(h: Awaited<ReturnType<typeof withVault>>, node: string, md: string) {
  return h.engine.content2.contentSection('数学', node, 's1', md)
}

test('sectionApply：思维节带合法预测门 → 落盘 ready；块结构随正文入库', async () => {
  await withVault({
    tag: 'learnhub-expert-apply-',
    graph: GRAPH,
    notes: {
      高难节点: {
        content: { version: 0, status: 'draft', sections: NOTE_SECTIONS },
        body: ['# 高难节点', '', '## 思维：专家怎么想', '', '（待生成）'],
      },
    },
  }, async h => {
    const r = await applySection(h, '高难节点', VALID_SECTION_MD)
    assert.equal(r.title, '思维：专家怎么想')
    const view = await h.engine.content2.contentSectionsView('数学', '高难节点')
    assert.equal(view[0]!.status, 'ready')
    assert.match(view[0]!.md ?? '', /learnhub-predict/)
  })
})

test('sectionApply：思维节缺预测门 → GATE_FAILED；坏块（answer 不在 options）→ GATE_FAILED', async () => {
  await withVault({
    tag: 'learnhub-expert-gate-',
    graph: GRAPH,
    notes: {
      高难节点: {
        content: { version: 0, status: 'draft', sections: NOTE_SECTIONS },
        body: ['# 高难节点', '', '## 思维：专家怎么想', '', '（待生成）'],
      },
    },
  }, async h => {
    const noGate = VALID_SECTION_MD.replace(/```learnhub-predict[\s\S]*?```/, '（这里本该有预测门）')
    await assert.rejects(
      () => applySection(h, '高难节点', noGate),
      (err: Error) => {
        assert.match(err.message, /至少设一处 ` learnhub-predict 预测门|至少设一处 .*预测门|GATE_FAILED/)
        assert.equal((err as Error & { code?: string }).code, 'GATE_FAILED')
        return true
      },
    )
    const badBlock = VALID_SECTION_MD.replace('answer: 先验算边界条件', 'answer: 查表先')
    await assert.rejects(
      () => applySection(h, '高难节点', badBlock),
      (err: Error) => {
        assert.match(err.message, /answer 必须是 options/)
        assert.equal((err as Error & { code?: string }).code, 'GATE_FAILED')
        return true
      },
    )
  })
})

test('sectionApply：概念节不带预测门照常通过（必备门只约束思维节）', async () => {
  await withVault({
    tag: 'learnhub-expert-concept-',
    graph: GRAPH,
    notes: {
      高难节点: {
        content: { version: 0, status: 'draft', sections: ['    - { id: s1, title: 概念：背景铺垫, type: 概念, status: pending, version: 0 }'] },
        body: ['# 高难节点', '', '## 概念：背景铺垫', '', '（待生成）'],
      },
    },
  }, async h => {
    const r = await h.engine.content2.contentSection('数学', '高难节点', 's1', '## 概念：背景铺垫\n\n一个平实的概念节，没有预测门。')
    assert.equal(r.title, '概念：背景铺垫')
  })
})
