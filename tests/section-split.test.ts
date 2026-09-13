import test from 'node:test'
import assert from 'node:assert/strict'
import { Content } from '../src/engine/content.ts'
import { MAX_SECTIONS } from '../src/engine/complexity.ts'
import type { SectionManifest } from '../src/engine/types.ts'
import { isSectionOverflow, sectionFailure } from '../src/generation-jobs.ts'

// ---------------------------------------------------------------- 拆节纯函数（ADR-0054）

const SPLIT_YAML = [
  'sections:',
  '  - title: 演示：苹果倍数（上）',
  '    type: 演示',
  '  - title: 演示：苹果倍数（下）',
  '    type: 演示',
].join('\n')

function manifest(specs: Array<[id: string, status: 'pending' | 'ready']>): SectionManifest[] {
  return specs.map(([id, status]) => ({ id, title: `节${id}`, type: '概念', status, version: status === 'ready' ? 1 : 0 }))
}

test('拆节 YAML 解析：模型 id 忽略、引擎派生子节 id、数量锁 2–3', () => {
  const subs = Content.parseSplitOutline(SPLIT_YAML, 's3')
  assert.equal(subs.length, 2)
  assert.deepEqual(subs.map(s => s.id), ['s3-1', 's3-2'])
  assert.ok(subs.every(s => s.status === 'pending' && s.version === 0))
  // 模型自带的 id 一律忽略（防撞名）——引擎派生值独占
  const withIds = Content.parseSplitOutline(
    'sections:\n  - id: s9\n    title: 演示：苹果倍数（上）\n    type: 演示\n  - title: 演示：苹果倍数（下）\n    type: 演示\n', 's3')
  assert.deepEqual(withIds.map(s => s.id), ['s3-1', 's3-2'])
})

test('拆节 YAML 解析：数量 1 或 4 拒收', () => {
  assert.throws(() => Content.parseSplitOutline('sections:\n  - title: 只有一步\n    type: 演示\n', 's1'), /2–3 个子节/)
  const four = ['sections:', ...[1, 2, 3, 4].map(i => `  - title: 子节${i}\n    type: 演示`)].join('\n')
  assert.throws(() => Content.parseSplitOutline(four, 's1'), /2–3 个子节/)
  // 数量违规是 schema 形状错：挂 OUTLINE_SHAPE 稳定码（与大纲站修复轮同一分流词汇）
  try {
    Content.parseSplitOutline('sections:\n  - title: 只有一步\n    type: 演示\n', 's1')
    assert.fail('应当抛出')
  } catch (err) {
    assert.equal((err as Error & { code?: string }).code, 'OUTLINE_SHAPE')
  }
})

test('拆节 YAML 解析：onTolerated 透传（机器块串味救回留痕到拆节 journal）', () => {
  const notes: string[] = []
  const polluted = SPLIT_YAML + '\n<!-- enc_candidates: [] -->\n'
  const subs = Content.parseSplitOutline(polluted, 's3', n => { notes.push(n) })
  assert.deepEqual(subs.map(s => s.id), ['s3-1', 's3-2'])
  assert.equal(notes.length, 1)
})

test('拆节清单替换：原位替换、pending 校验、上限护栏、id 冲突护栏', () => {
  const sections = manifest([['s1', 'ready'], ['s2', 'pending'], ['s3', 'pending']])
  const subs = Content.parseSplitOutline(SPLIT_YAML, 's2')
  const next = Content.applySplit(sections, 's2', subs, MAX_SECTIONS)
  assert.deepEqual(next.map(s => s.id), ['s1', 's2-1', 's2-2', 's3'], '原位替换、其余节原样')

  assert.throws(() => Content.applySplit(sections, 's1', subs, MAX_SECTIONS), /已是 ready/, 'ready 节有已落盘正文，拆节会孤儿化内容')
  assert.throws(() => Content.applySplit(sections, 's9', subs, MAX_SECTIONS), /没有「s9」/)
  // 拆后总节数越上限：8 节再拆一节 = 9 > 8
  const full = manifest([['a', 'pending'], ['b', 'pending'], ['c', 'pending'], ['d', 'pending'], ['e', 'pending'], ['f', 'pending'], ['g', 'pending'], ['h', 'pending']])
  assert.throws(() => Content.applySplit(full, 'a', subs, MAX_SECTIONS), /超过上限 8/)
  // 子节 id 与既有节冲突（大纲模型用过派生名）fail loud
  const collision = manifest([['s2-1', 'pending'], ['s2', 'pending']])
  assert.throws(() => Content.applySplit(collision, 's2', subs, MAX_SECTIONS), /冲突/)
})

// ---------------------------------------------------------------- 溢出判定与结构化失败（ADR-0054）

function gateError(message: string): Error & { code?: string } {
  const e: Error & { code?: string } = new Error(message)
  e.code = 'GATE_FAILED'
  return e
}

test('isSectionOverflow：GATE_FAILED 且清单含「正文过长」才拆节；其余 finding 不拆', () => {
  const overflow = gateError('[section] 「演示」质检门未过：\n  ✗ 节「演示」正文过长（约 606 字 > 拒收线 500 字）\n')
  assert.equal(isSectionOverflow(overflow), true)
  assert.equal(isSectionOverflow(gateError('[section] 「演示」质检门未过：\n  ✗ ```plot 第 1 块不是合法 JSON\n')), false)
  assert.equal(isSectionOverflow(new Error('正文过长但没有门禁码')), false, '非门禁错误不触发拆节')
})

test('sectionFailure：GATE_FAILED 取首条 ✗ 与错误自带节信息；普通错误整段入 finding', () => {
  const e: Error & { code?: string; sectionId?: string; sectionTitle?: string } = gateError(
    '[section] 「演示」质检门未过：\n  ✗ 节「演示」正文过长（约 606 字）\n  ✗ 第二条\n  ⚠ 警告不进 finding\n')
  e.sectionId = 's2'
  e.sectionTitle = '演示'
  assert.deepEqual(sectionFailure(e), {
    code: 'GATE_FAILED', sectionId: 's2', sectionTitle: '演示',
    finding: '节「演示」正文过长（约 606 字）',
  })
  assert.deepEqual(sectionFailure(new Error('模型调用失败[NO_ADAPTER]'), { id: 'x1', title: '节X' }), {
    code: 'ERROR', sectionId: 'x1', sectionTitle: '节X', finding: '模型调用失败[NO_ADAPTER]',
  }, '无码错误归 ERROR，调用方传入的当前节补位（定点重写不因错误形态缺席）')
})

// ---------------------------------------------------------------- 修复轮提示词（ADR-0054：显式压缩目标）

const BASE = '课程节生成提示词'
/** 节生成模板原文（#218：sectionRepairPrompt 收模板与材料两半，契约段在模板里）。 */
const TPL = Content.PROMPT_KINDS['课程节生成']!
const OVERFLOW_REPORT = '质检清单：\n  ✗ 节「演示」正文过长（约 606 字 > 拒收线 500 字）\n'
const BLOCK_REPORT = '质检清单：\n  ✗ ```plot 第 1 块不是合法 JSON\n'

test('修复轮提示词：长度 finding 附显式压缩目标与计数口径，拆节归管线', () => {
  const p = Content.sectionRepairPrompt(TPL, BASE, '上次输出', OVERFLOW_REPORT, { wordBudget: 400 })
  assert.match(p, /压缩到 ≤ 400 字/)
  assert.match(p, /纯文字数/, '计数口径直说：去空白/公式/可视化块后计')
  assert.match(p, /拆成多个节由生成管线自动处理/, '不再劝模型在节内拆节（不可执行）')
  assert.match(p, /压缩文字/, '标题行不再要求「其余内容原样保留」（与压缩矛盾）')
})

test('修复轮提示词：非长度 finding 保持局部重写纪律，不附压缩目标', () => {
  const p = Content.sectionRepairPrompt(TPL, BASE, '上次输出', BLOCK_REPORT)
  assert.match(p, /只重写下列 ✗ 项定位到的违规局部/)
  assert.doesNotMatch(p, /压缩到 ≤/)
})

test('#218 契约后置：修复轮里契约段仍是最终 prompt 的末段（反馈是材料不是交付契约）', () => {
  const p = Content.sectionRepairPrompt(TPL, BASE, '上次输出', OVERFLOW_REPORT, { wordBudget: 400 })
  const at = (s: string): number => p.indexOf(s)
  assert.ok(at('只输出本节正文') > at('质检清单：'), '契约句在质检清单之后')
  assert.ok(at('只输出本节正文') > at('压缩目标'), '契约句在压缩目标之后')
  assert.equal(p.trimEnd().endsWith('只输出本节正文（## 标题 + 内容），不要附加解释。'), true, '契约段是最后一节')
})

// ---------------------------------------------------------------- 计数口径（交互件行数永不计入篇幅）

test('S5: 交互/预测机器块行数再多不占文字预算；finding 自带计数口径说明', () => {
  const widgetLines = Array.from({ length: 60 }, (_, i) => `<div id="row-${i}">row</div>`).join('\n')
  const body = `## 交互：玩\n\n引导一句。\n\n\`\`\`learnhub-interactive:交互/a.html\n<!DOCTYPE html>\n${widgetLines}\n\`\`\`\n\n\`\`\`learnhub-predict\nq: 下一步？\noptions: ["甲", "乙"]\nanswer: 甲\n\`\`\`\n`
  const r = Content.checkSectionShape(body, 250)
  assert.equal(r.findings.length, 0, '围栏机块整块剥离——60 行交互件不占 250 字预算')
  // 超线时 finding 说明口径（模型与质检用同一个数）
  const over = `## 概念：长\n\n${'字'.repeat(501)}\n`
  const rf = Content.checkSectionShape(over, 250)
  assert.equal(rf.findings.length, 1)
  assert.match(rf.findings[0]!, /字数按去空白、去公式与可视化\/交互块后的正文字数计/)
})
