import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCorpusCapture, parseCorpusFile, STATIONS, TOOL_CALLS_MARKER } from '../src/host/corpus.ts'
import { COACH_PLAN_STATION, GROWTH_DRAFT_STATION } from '../src/engine/index.ts'
import type { CorpusRecordInput } from '../src/host/corpus.ts'

function tmpCenter(): string {
  return mkdtempSync(join(tmpdir(), 'learnhub-corpus-'))
}

function base(station: string, patch: Partial<CorpusRecordInput> = {}): CorpusRecordInput {
  return {
    ts: '2026-09-13T12:00:00.000Z',
    station,
    kind: 'complete',
    outcome: 'ok',
    durationMs: 1234,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    prompt: '渲染后的提示词正文',
    output: '模型原始输出正文',
    ...patch,
  }
}

test('语料捕获：ok 记录落盘，frontmatter 字段完整，正文两段', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    c.record(base('题目生成', {
      effort: 'fast',
      usage: { inputTokens: 123, outputTokens: 456, reasoningTokens: 78 },
    }))
    await c.flush()
    const dir = join(root, 'state', '生成语料', '题目生成')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^ok-/)
    const body = readFileSync(join(dir, files[0]), 'utf8')
    assert.match(body, /^---\n/)
    assert.match(body, /ts: 2026-09-13T12:00:00\.000Z/)
    assert.match(body, /station: 题目生成/)
    assert.match(body, /kind: complete/)
    assert.match(body, /effort: fast/)
    assert.match(body, /outcome: ok/)
    assert.match(body, /duration_ms: 1234/)
    assert.match(body, /usage: \{ input_tokens: 123, output_tokens: 456, reasoning_tokens: 78 \}/)
    assert.match(body, /provider: deepseek-official/)
    assert.match(body, /model: deepseek-v4-flash/)
    const promptPos = body.indexOf('## 提示词')
    const outputPos = body.indexOf('## 原始输出')
    assert.ok(promptPos > 0 && outputPos > promptPos)
    assert.match(body, /渲染后的提示词正文/)
    assert.match(body.slice(outputPos), /模型原始输出正文/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料捕获：failed 记录进 bad 桶并带失败码；usage 缺省不出 usage 行', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    c.record(base('判卷', { outcome: 'failed', code: 'AUTH' }))
    await c.flush()
    const dir = join(root, 'state', '生成语料', '判卷')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^bad-/)
    const body = readFileSync(join(dir, files[0]), 'utf8')
    assert.match(body, /outcome: failed/)
    assert.match(body, /code: AUTH/)
    assert.doesNotMatch(body, /usage:/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料环形：成功桶封顶 25、失败桶封顶 200，删最旧', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    for (let i = 0; i < 27; i++) {
      c.record(base('出题站', { ts: new Date(Date.UTC(2026, 8, 13, 12, 0, 0, i).valueOf() + i * 1000).toISOString(), output: `输出${i}` }))
    }
    for (let i = 0; i < 202; i++) {
      c.record(base('出题站', { ts: new Date(Date.UTC(2026, 8, 13, 13, 0, 0, i).valueOf() + i * 1000).toISOString(), outcome: 'failed', code: 'X', output: `失败${i}` }))
    }
    await c.flush()
    const dir = join(root, 'state', '生成语料', '出题站')
    const files = readdirSync(dir)
    assert.equal(files.filter(f => f.startsWith('ok-')).length, 25)
    assert.equal(files.filter(f => f.startsWith('bad-')).length, 200)
    // 最旧被删：ok 桶首文件对应第 3 条（i=2 起），bad 桶首文件对应第 3 条失败
    const oks = files.filter(f => f.startsWith('ok-')).sort()
    const body = readFileSync(join(dir, oks[0]), 'utf8')
    assert.doesNotMatch(body, /输出0/) // 最旧两条已滚出
    assert.match(body, /输出2/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料补标：annotateLast 把 ok 改判 failed 并迁桶，返回新 ref；lastRef 跟随', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    c.record(base('课程大纲'))
    const refBefore = c.lastRef('课程大纲')
    assert.ok(refBefore)
    const ref = c.annotateLast('课程大纲', { outcome: 'failed', code: 'MODEL_YAML' })
    assert.ok(ref && ref.startsWith('课程大纲/bad-'))
    assert.notEqual(ref, refBefore)
    await c.flush()
    const dir = join(root, 'state', '生成语料', '课程大纲')
    assert.equal(readdirSync(dir).length, 1)
    const body = readFileSync(join(dir, ref!.split('/')[1]), 'utf8')
    assert.match(body, /outcome: failed/)
    assert.match(body, /code: MODEL_YAML/)
    assert.equal(c.lastRef('课程大纲'), ref)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料补标：该站无捕获时 annotateLast 静默返回 undefined；tolerated 同迁 bad 桶', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    assert.equal(c.annotateLast('没这站', { outcome: 'failed', code: 'X' }), undefined)
    c.record(base('课程节拆分'))
    const ref = c.annotateLast('课程节拆分', { outcome: 'tolerated' })
    assert.ok(ref && ref.includes('bad-'))
    await c.flush()
    const body = readFileSync(join(root, 'state', '生成语料', '课程节拆分', ref!.split('/')[1]), 'utf8')
    assert.match(body, /outcome: tolerated/)
    assert.doesNotMatch(body, /code:/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料补标：annotate 按旧 ref 补标（文件已被 annotateLast 迁名后旧名静默跳过）', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    c.record(base('种子起草'))
    const oldRef = c.lastRef('种子起草')!
    c.annotate(oldRef, { outcome: 'failed', code: 'SEED_GATE_FAILED' })
    // 再按同一名补标一次（名字已迁 bad-）：静默不抛
    c.annotate(oldRef, { outcome: 'failed', code: 'AGAIN' })
    await c.flush()
    const dir = join(root, 'state', '生成语料', '种子起草')
    assert.equal(readdirSync(dir).length, 1)
    const body = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
    assert.match(body, /code: SEED_GATE_FAILED/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料捕获：lastRef 同步登记（写盘未 flush 时已可取）；空目录不建站目录', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    c.record(base('里程碑草案', { kind: 'repair' }))
    assert.ok(c.lastRef('里程碑草案'))
    assert.ok(!existsSync(join(root, 'state', '生成语料', '里程碑草案')))
    await c.flush()
    assert.ok(existsSync(join(root, 'state', '生成语料', '里程碑草案')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- 工具调用载荷（#236）：以工具调用承载实质产物的站在语料里不得成空壳 ----

test('语料捕获：工具调用段——文本为空而载荷在场时原文逐条落档，读侧按段还原（#236）', async () => {
  const root = tmpCenter()
  try {
    const args = '{"note":{"operator":"前进"},"ops":[{"add_node":"把一个数字存进变量"}]}'
    const c = createCorpusCapture(join(root, 'state', '生成语料'))
    c.record(base('教练生长', {
      kind: 'loop',
      output: '',
      toolCalls: [{ name: 'submit_batch', arguments: args }, { name: 'read_graph', arguments: '{}' }],
    }))
    c.record(base('教练生长', { kind: 'loop', output: '这一轮直接给了文本产出' }))
    await c.flush()
    const dir = join(root, 'state', '生成语料', '教练生长')
    const bodies = readdirSync(dir).sort().map(f => readFileSync(join(dir, f), 'utf8'))
    const withCalls = bodies.find(b => b.includes(TOOL_CALLS_MARKER))!
    assert.ok(withCalls.includes('reply_chars: 0'), '文本侧确实为空（frontmatter 读数如实）')
    assert.ok(withCalls.includes(JSON.stringify({ name: 'submit_batch', arguments: args })), 'arguments 原文进档（不清洗）')
    const parsed = parseCorpusFile(withCalls)
    assert.equal(parsed.output, '', '（空输出）占位还原为空串——载荷不在输出段里')
    assert.deepEqual(parsed.toolCalls, [
      { name: 'submit_batch', arguments: args },
      { name: 'read_graph', arguments: '{}' },
    ], '逐条 JSON 原样回读')
    // 无工具调用的件形态与 #213 逐字同（段缺席），读侧空数组
    const textOnly = bodies.find(b => !b.includes(TOOL_CALLS_MARKER))!
    assert.deepEqual(parseCorpusFile(textOnly).toolCalls, [])
    assert.equal(parseCorpusFile(textOnly).output, '这一轮直接给了文本产出')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('语料读侧：无工具调用段的旧格式照读；段内坏行以占位保留原文不静默丢（#236 兼容面）', () => {
  const legacy = ['---', 'station: 种子起草', 'outcome: ok', '---', '', '## 提示词', '', 'P', '', '## 原始输出', '', 'O', ''].join('\n')
  assert.deepEqual(parseCorpusFile(legacy).toolCalls, [], '段缺席 = 空数组（历史语料照读）')
  assert.equal(parseCorpusFile(legacy).output, 'O', '旧格式的输出段不受新增段影响')
  const broken = [
    '---', 'station: 教练生长', '---', '',
    '## 原始输出', '', '（空输出）', '',
    TOOL_CALLS_MARKER, '', '{"name":"a","arguments":"{}"}', '这不是 JSON', '',
  ].join('\n')
  const parsed = parseCorpusFile(broken)
  assert.deepEqual(parsed.toolCalls[0], { name: 'a', arguments: '{}' })
  assert.equal(parsed.toolCalls.length, 2, '坏行不被静默丢')
  assert.deepEqual(parsed.toolCalls[1], { name: '（未解析）', arguments: '这不是 JSON' }, '占位保留原文')
})

test('#301 站名词表受控纪律：生长两站各引引擎常量（站名对齐靠常量不靠字面），遗留单站名已清理', () => {
  assert.equal(STATIONS.growthPlan, COACH_PLAN_STATION, '思路官站名 = 引擎常量（COACH_PLAN_STATION）')
  assert.equal(STATIONS.growthDraft, GROWTH_DRAFT_STATION, '执行官站名 = 引擎常量（GROWTH_DRAFT_STATION）')
  assert.notEqual(STATIONS.growthPlan, STATIONS.growthDraft, '两站两目录——失败补标按真实失败站落盘（#301 缺陷③）')
  // 拆分前的单站遗留名 `growth: '教练思路'` 已删（写死的映射会把执行官站的失败标到思路官站）
  assert.equal(Object.keys(STATIONS).includes('growth'), false, '遗留映射键不再存在')
})
