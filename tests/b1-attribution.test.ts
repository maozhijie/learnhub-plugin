import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateSectionSignals, formatSignalDetail, normSectionKey, parseSignalDetail, sectionEntryOf } from '../src/engine/attribution.ts'
import type { AttemptFact, RewriteFact, SectionManifest, SectionSignalInput } from '../src/engine/attribution.ts'
import { withVault } from './helpers/vault.ts'
import type { NoteSeed, VaultHandle } from './helpers/vault.ts'

const MANIFEST: SectionManifest[] = [
  { id: 's1', title: '概念：定义', type: '概念', status: 'ready', version: 1 },
  { id: 's2', title: '例题：应用', type: '例题', status: 'ready', version: 0 },
]

function input(over: Partial<SectionSignalInput> & { attempts?: AttemptFact[] }): SectionSignalInput {
  return {
    manifest: MANIFEST,
    questions: [
      { id: 'q1', section: 's1', fsrs: { lapses: 0 } },
      { id: 'q2', section: 's2', fsrs: { lapses: 0 } },
    ],
    attempts: over.attempts ?? [],
    prevSignals: over.prevSignals ?? [],
    rewrites: over.rewrites ?? [],
    today: over.today ?? '2026-03-10',
    ...over,
  }
}

const day = (d: string, qid = 'q1', correct = false): AttemptFact => ({ qid, day: d, correct })

// ---- 节匹配 ----

test('节匹配：id 精确 → 标题精确 → 归一化标题回退；「通用」不归因', () => {
  assert.equal(sectionEntryOf('s1', MANIFEST)?.id, 's1')
  assert.equal(sectionEntryOf('例题：应用', MANIFEST)?.id, 's2')
  // 旧题缺「类型：」前缀/带空白 → 归一化回退
  assert.equal(sectionEntryOf('定义', MANIFEST)?.id, 's1')
  assert.equal(sectionEntryOf('  概念:定义 ', MANIFEST)?.id, 's1')
  assert.equal(sectionEntryOf('通用', MANIFEST), null)
  assert.equal(sectionEntryOf('不存在的节', MANIFEST), null)
  assert.equal(sectionEntryOf(undefined, MANIFEST), null)
  assert.equal(normSectionKey('概念： 定义'), normSectionKey('定义'))
})

// ---- 触发规则（接缝 S28）----

test('R1：单题 lapses≥3 触发；低于阈值不触发；「通用」题不归因', () => {
  const r1 = evaluateSectionSignals(input({
    questions: [{ id: 'q1', section: 's1', fsrs: { lapses: 3 } }],
  }))
  assert.equal(r1.length, 1)
  assert.equal(r1[0]!.signal, 'R1')
  assert.equal(r1[0]!.fresh, true)
  assert.equal(r1[0]!.escalate, false)
  assert.match(r1[0]!.reason, /单题反复失败/)
  assert.equal(r1[0]!.evidence.qid, 'q1')

  const none = evaluateSectionSignals(input({
    questions: [{ id: 'q1', section: 's1', fsrs: { lapses: 2 } }],
  }))
  assert.deepEqual(none, [])

  const generic = evaluateSectionSignals(input({
    questions: [{ id: 'q9', section: '通用', fsrs: { lapses: 9 } }],
  }))
  assert.deepEqual(generic, [])
})

test('R2：（题,日）去重 ≥4 次且正确率 <0.5 触发；文案带正确率与作答数', () => {
  const attempts = [
    day('2026-03-01', 'q1', false),
    day('2026-03-02', 'q1', true),
    day('2026-03-03', 'q1', false),
    day('2026-03-04', 'q1', true),
    day('2026-03-05', 'q1', false),
  ]
  const [r2] = evaluateSectionSignals(input({ attempts }))
  assert.ok(r2)
  assert.equal(r2.signal, 'R2')
  assert.equal(r2.evidence.attempts, 5)
  assert.equal(r2.evidence.correct, 2)
  assert.match(r2.reason, /作答正确率 40%，5 次作答/)
})

test('R2：同日重复作答不进分母；分母 <4 不触发（低数据静默）', () => {
  const attempts = [
    day('2026-03-01'), day('2026-03-01'), day('2026-03-01'), // 同日三条 = 1
    day('2026-03-02'), day('2026-03-03'),
  ]
  assert.deepEqual(evaluateSectionSignals(input({ attempts })), [])
})

test('R2：节重写锚点后窗口归零；交互件成绩计入；归一化标题锚点对齐', () => {
  const attempts = [
    day('2026-03-01', 'q1', false),
    day('2026-03-02', 'q1', false),
    day('2026-03-03', 'q1', false),
    day('2026-03-04', 'q1', false),
    day('2026-03-05', 'interactive:s1', false), // 交互件成绩按节 id 直接归因
  ]
  // 重写落盘（旧 detail 只有标题）在 03-05 → 之前的证据全部出窗，交互件当日证据也被排除（严格大于锚点）
  const rewrites: RewriteFact[] = [{ title: '概念：定义', day: '2026-03-05' }]
  assert.deepEqual(evaluateSectionSignals(input({ attempts, rewrites })), [])
  // 锚点在中间 → 窗口只剩其后两天（<4 不触发）
  const mid: RewriteFact[] = [{ title: '概念：定义', day: '2026-03-03' }]
  assert.deepEqual(evaluateSectionSignals(input({ attempts, rewrites: mid })), [])
})

test('冷却与升级：冷却期内 fresh=false 但建议可见；R1 二次命中升级人工', () => {
  const attempts = [
    day('2026-03-01'), day('2026-03-02'), day('2026-03-03'), day('2026-03-04'),
  ]
  // 昨天刚触发过 → 冷却期内：met 建议保持可见，fresh=false（不再写留痕）
  const [cool] = evaluateSectionSignals(input({
    attempts,
    prevSignals: [{ sectionId: 's1', signal: 'R2', base: 4, day: '2026-03-09' }],
  }))
  assert.ok(cool)
  assert.equal(cool.fresh, false)
  // 冷却已过 + 分母超越快照 → 全新触发
  const [refire] = evaluateSectionSignals(input({
    attempts: [...attempts, day('2026-03-05'), day('2026-03-06')],
    prevSignals: [{ sectionId: 's1', signal: 'R2', base: 4, day: '2026-02-20' }],
  }))
  assert.ok(refire)
  assert.equal(refire.fresh, true)
  // R1 触发过（10 天前，冷却已过）、lapses 又涨 → 升级人工
  const [esc] = evaluateSectionSignals(input({
    questions: [{ id: 'q1', section: 's1', fsrs: { lapses: 4 } }],
    prevSignals: [{ sectionId: 's1', signal: 'R1', base: 3, day: '2026-02-28' }],
  }))
  assert.ok(esc)
  assert.equal(esc.escalate, true)
  assert.match(esc.reason, /转人工处理/)
})

test('R1/R2 快照分账：R2 先触发过，后出现的 R1 仍全新触发（base 不跨类型比较）', () => {
  const [r1] = evaluateSectionSignals(input({
    questions: [{ id: 'q1', section: 's1', fsrs: { lapses: 3 } }],
    prevSignals: [{ sectionId: 's1', signal: 'R2', base: 5, day: '2026-03-01' }],
  }))
  assert.ok(r1)
  assert.equal(r1.signal, 'R1')
  assert.equal(r1.fresh, true) // 若误用 R2 的 base=5 比较，3 > 5 不成立会永不触发
  assert.equal(r1.escalate, false)
})

test('触发留痕 detail 编解码回读（base 快照是重触发与升级的依据）', () => {
  const detail = formatSignalDetail({ sectionId: 's1', signal: 'R1', base: 4 }, '概念：定义', 'qid=q1 lapses=4')
  assert.match(detail, /节「概念：定义」\(s1\) R1 触发：qid=q1 lapses=4 base=4/)
  assert.deepEqual(parseSignalDetail(detail), { sectionId: 's1', signal: 'R1', base: 4 })
  assert.equal(parseSignalDetail('节「x」落盘'), null)
})

// ---- 门面集成：status/recommend 出建议项、留痕、冷却、重写窗口归零 ----

/** 入门笔记种子（noteText 逐字生成原 NOTE 常量：s1 节 manifest + 节正文 + 练习证据）。 */
const NOTE: NoteSeed = {
  stage: 'review',
  content: {
    version: 1,
    generatedAt: '2026-01-01',
    sections: ['    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }'],
  },
  practice: { attempts: 5, correct: 2 },
  body: ['# 入门', '', '## 概念：定义', '', '正文内容。'],
}

/** 单题题库（fsrs.lapses 可选种子；section 绑节 id）。 */
function bank(lapses: number): string {
  return [
    'node: 入门',
    'questions:',
    '  - id: q1',
    '    kind: true_false',
    '    q: 说法是否成立。',
    '    answer: true',
    '    section: s1',
    ...(lapses > 0 ? [
      '    fsrs:',
      '      stability: 3.5',
      '      difficulty: 6.5',
      '      due: 2026-01-01',
      '      last_review: 2026-01-01',
      '      reps: 6',
      `      lapses: ${lapses}`,
    ] : []),
  ].join('\n') + '\n'
}

/** b1 门面 vault：默认单课程/单节点图 + 入门笔记 + 单题题库（lapses 种子）。 */
const b1Vault = (lapses = 0) => ({
  tag: 'learnhub-b1-',
  notes: { 入门: NOTE },
  banks: { 入门: bank(lapses) },
})

/** 相对今天的 ISO 日（前 n 天；留痕/作答流水播种用）。 */
function daysAgoIso(n: number): string {
  const d = new Date(Date.now() - n * 86400000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function seedR2Evidence(engine: VaultHandle['engine']): Promise<void> {
  for (const [i, ok] of [false, true, false, true, false].entries()) {
    await engine.store.appendPractice({
      course: '数学', node: '入门', ex: 1, answer: ok ? 'true' : 'false',
      correct: ok, judge: 'true_false', qid: 'q1', ts: `${daysAgoIso(6 - i)}T10:00:00`,
    })
  }
}

test('门面：R2 命中 → status/recommend 出带理由与重写入口的诊断项；留痕只写一条', async () => {
  await withVault(b1Vault(), async ({ engine }) => {
    await seedR2Evidence(engine)
    const status = await engine.statusJson()
    const course = (status.courses as Array<Record<string, unknown>>)[0]!
    const diags = course.diagnostics as Array<Record<string, unknown>>
    assert.equal(diags?.length, 1)
    const d = diags[0]!
    assert.equal(d.signal, 'R2')
    assert.equal(d.section, 's1')
    assert.match(String(d.reason), /答错集中（作答正确率 40%，5 次作答）/)
    assert.deepEqual(d.rewrite, { course: '数学', node: '入门', section: 's1' })
    assert.deepEqual(d.explain, { course: '数学', node: '入门' })

    // recommend：独立 diagnostic 事件（该节点无其他事件）带 diagnostics 数组
    const rec = await engine.recommend()
    const events = rec.events as Array<Record<string, unknown>>
    const diagEvent = events.find(e => e.type === 'diagnostic') as Record<string, unknown> | undefined
    assert.ok(diagEvent)
    assert.equal(diagEvent.node, '入门')
    const view = (diagEvent.diagnostics as Array<Record<string, unknown>>)[0]!
    assert.match(String(view.reason), /答错集中/)
    assert.deepEqual(view.rewrite, { course: '数学', node: '入门', section: 's1' })

    // 触发留痕恰好一条；再跑（冷却期内）建议仍在但不再写留痕
    const journalBefore = await engine.store.journalTail('数学', 100)
    const signals = journalBefore.filter(r => r.kind === 'section_regen_signal')
    assert.equal(signals.length, 1)
    assert.deepEqual(parseSignalDetail(signals[0]!.detail), { sectionId: 's1', signal: 'R2', base: 5 })
    const again = await engine.statusJson()
    const diags2 = ((again.courses as Array<Record<string, unknown>>)[0]!.diagnostics ?? []) as unknown[]
    assert.equal(diags2.length, 1)
    const journalAfter = await engine.store.journalTail('数学', 100)
    assert.equal(journalAfter.filter(r => r.kind === 'section_regen_signal').length, 1)
  })
})

test('门面：R1 冷却后二次命中 → escalate 转人工，不再给重写建议', async () => {
  // 上次 R1 触发在 10 天前（冷却已过），base_lapses=3；现在 lapses=4 → 升级
  await withVault(b1Vault(4), async ({ engine }) => {
    await engine.store.appendJournal({
      course: '数学', node: '入门', rating: null, kind: 'section_regen_signal', elapsed_days: 0,
      detail: formatSignalDetail({ sectionId: 's1', signal: 'R1', base: 3 }, '概念：定义', 'qid=q1 lapses=3'),
      ts: `${daysAgoIso(10)}T09:00:00`,
    })
    const [d] = await engine.diagnosticsAdvice()
    assert.ok(d)
    assert.equal(d.signal, 'R1')
    assert.equal(d.escalate, true)
    assert.match(d.reason, /转人工处理/)
    assert.equal(d.fresh, true)
  })
})

test('门面：单节重写落盘（content_section 留痕）→ R2 窗口归零 + 进入冷却', async () => {
  await withVault(b1Vault(), async ({ engine }) => {
    await seedR2Evidence(engine)
    assert.equal((await engine.diagnosticsAdvice()).length, 1)
    // 重写落盘 = 节版本 +1 的留痕（today）→ 证据全部出窗 + 冷却
    await engine.store.appendJournal({
      course: '数学', node: '入门', rating: null, kind: 'content_section', elapsed_days: 0,
      detail: '节「概念：定义」v2 落盘',
    })
    assert.deepEqual(await engine.diagnosticsAdvice(), [])
  })
})
