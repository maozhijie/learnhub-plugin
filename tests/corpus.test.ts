import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CALL_RECORD_PART_CAP, createCorpusCapture, OFFLINE_DIR, stampCorpusSink, STATIONS } from '../src/host/corpus.ts'
import { corpusLayoutOf, parseCallRecordFile, parseCorpusFile, readCallRecords, TOOL_CALLS_MARKER } from '../src/host/corpus-read.ts'
import { COMPASS_STATION, DECOMPILE_STATION, GROWTH_DRAFT_STATION, QUALITY_REVIEW_STATION, QUIZ_SOLVER_STATION } from '../src/engine/index.ts'
import type { CorpusRecordInput } from '../src/host/corpus.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
    attempt: 1,
    request: { messages: [{ role: 'user', text: '渲染后的提示词正文' }] },
    response: { text: '模型原始输出正文', finish: 'stop' },
    ...patch,
  }
}

function groupFile(root: string, course: string, node: string): string {
  return join(root, 'state', '调用记录', course, `${node}.md`)
}

test('调用记录：任务组文件落盘——文件头（任务/更新/TOC）+ 节元数据 + 请求/响应 JSON 块', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    c.record(base('题目生成', {
      course: '数学', node: '变量', source: '作业', effort: 'fast',
      usage: { inputTokens: 123, outputTokens: 456, reasoningTokens: 78, totalTokens: 579, cacheReadTokens: 10, cacheWriteTokens: 4 },
    }))
    await c.flush()
    const path = groupFile(root, '数学', '变量')
    assert.ok(existsSync(path), '一任务一组文件：<课程>/<节点>.md')
    const body = readFileSync(path, 'utf8')
    assert.match(body, /^# 调用记录 数学\/变量\n/)
    assert.match(body, /- 任务: 数学\/变量/)
    assert.match(body, /- 更新: 2026-09-13T12:00:00\.000Z/)
    assert.match(body, /## 调用索引/, '文件头含调用索引 TOC')
    assert.match(body, /- #1 ｜ 题目生成 ｜ 作业 ｜ complete ｜ ok ｜ 2026-09-13T12:00:00\.000Z/)
    assert.match(body, /## #1 ｜ 题目生成 ｜ 作业/)
    assert.match(body, /- 时间: 2026-09-13T12:00:00\.000Z/)
    assert.match(body, /- 阶段: complete/)
    assert.match(body, /- 档位: fast/)
    assert.match(body, /- 尝试: 1/)
    assert.match(body, /- 结果: ok/)
    assert.match(body, /- 模型: deepseek-v4-flash（deepseek-official）/)
    assert.match(body, /- 耗时: 1234ms/)
    assert.match(body, /token: 入 123\/出 456（推理 78；缓存读 10\/写 4；总 579）/, '缓存与总 token 恢复入档')
    assert.match(body, /### 请求/)
    assert.match(body, /### 响应/)
    const parsed = parseCallRecordFile(body)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].station, '题目生成')
    assert.equal(parsed[0].source, '作业')
    assert.equal(parsed[0].prompt, '渲染后的提示词正文')
    assert.equal(parsed[0].output, '模型原始输出正文')
    assert.equal(parsed[0].usage?.totalTokens, 579)
    assert.deepEqual(parsed[0].request.messages, [{ role: 'user', text: '渲染后的提示词正文' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录：同任务多次调用追加同组文件（序号连续、TOC 逐行）；无身份调用落 _离线/<站>.md', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    c.record(base('课程大纲', { course: '数学', node: '变量', source: '作业', ts: '2026-09-13T12:00:01.000Z' }))
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', ts: '2026-09-13T12:00:02.000Z' }))
    c.record(base('老师辅导', { source: '面板', course: '数学', ts: '2026-09-13T12:00:03.000Z' })) // node 缺 → 离线
    await c.flush()
    const body = readFileSync(groupFile(root, '数学', '变量'), 'utf8')
    assert.match(body, /- #1 ｜ 课程大纲 ｜/)
    assert.match(body, /- #2 ｜ 课程节生成 ｜/)
    assert.equal(parseCallRecordFile(body).length, 2, '两节同组文件')
    const offlinePath = join(root, 'state', '调用记录', OFFLINE_DIR, '老师辅导.md')
    assert.ok(existsSync(offlinePath), '无业务键 → _离线/<站>.md')
    const offline = parseCallRecordFile(readFileSync(offlinePath, 'utf8'))
    assert.equal(offline.length, 1)
    assert.equal(offline[0].source, '面板', '离线件仍带来源')
    const views = readCallRecords(join(root, 'state', '调用记录'))
    assert.equal(views.length, 3)
    const keyed = views.find(v => v.station === '课程大纲')!
    assert.equal(keyed.ref, '数学/变量#1')
    assert.equal(keyed.course, '数学')
    assert.equal(keyed.node, '变量')
    assert.equal(views.find(v => v.station === '老师辅导')!.ref, '_离线/老师辅导#1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录：重试逐次各记一条（attempt 递增），失败带失败码与部分响应', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    c.record(base('判卷', {
      course: '数学', node: '变量', source: '面板',
      outcome: 'failed', code: 'RATE_LIMIT', durationMs: 50,
      response: { text: '写到一半', finish: 'error' },
    }))
    c.record(base('判卷', { course: '数学', node: '变量', source: '面板', attempt: 2, durationMs: 900 }))
    await c.flush()
    const body = readFileSync(groupFile(root, '数学', '变量'), 'utf8')
    assert.match(body, /- #1 ｜ 判卷 ｜ 面板 ｜ complete ｜ failed ｜/)
    assert.match(body, /- #2 ｜ 判卷 ｜ 面板 ｜ complete ｜ ok ｜/)
    assert.match(body, /- 尝试: 1/)
    assert.match(body, /- 尝试: 2/)
    assert.match(body, /- 失败码: RATE_LIMIT/)
    const calls = parseCallRecordFile(body)
    assert.equal(calls[0].response.text, '写到一半', '失败尝试的部分响应不丢')
    assert.equal(calls[1].outcome, 'ok')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录补标：annotateLast 改判该节 结果/失败码 + TOC 行；since 令牌相等即跳过；无捕获返回 undefined', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    assert.equal(c.annotateLast('没这站', { outcome: 'failed', code: 'X' }), undefined)
    const since = c.lastRef('课程大纲')
    c.record(base('课程大纲', { course: '数学', node: '变量', source: '作业' }))
    const ref = c.lastRef('课程大纲')!
    assert.ok(ref.startsWith('数学/变量#'), 'ref = <课程>/<节点>#<序号>')
    // since 令牌 = record 之前的 lastRef（undefined）——「本轮零捕获」判据
    assert.equal(c.annotateLast('课程大纲', { outcome: 'failed', code: 'MODEL_YAML' }, { since }), ref)
    assert.equal(c.annotateLast('课程大纲', { outcome: 'failed', code: 'MODEL_YAML' }), ref, '省略 since = 照旧补标')
    await c.flush()
    const body = readFileSync(groupFile(root, '数学', '变量'), 'utf8')
    assert.match(body, /- 结果: failed/)
    assert.match(body, /- 失败码: MODEL_YAML/)
    assert.match(body, /- #1 ｜ 课程大纲 ｜ 作业 ｜ complete ｜ failed ｜/, 'TOC 行同步改判')
    assert.equal(parseCallRecordFile(body)[0].outcome, 'failed', '读侧读到补标后的结果')
    assert.equal(c.lastRef('课程大纲'), ref, 'lastRef 不迁名（组文件内改判）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录补标：多调用组文件——补标中间节时只改该节的节体与 TOC 行，别节原样', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', response: { text: '第一节', finish: 'stop' } }))
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', response: { text: '第二节', finish: 'stop' } }))
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', response: { text: '第三节', finish: 'stop' } }))
    const ref2 = '数学/变量#2'
    c.annotate(ref2, { outcome: 'failed', code: 'GATE_FAILED' })
    await c.flush()
    const calls = parseCallRecordFile(readFileSync(groupFile(root, '数学', '变量'), 'utf8'))
    assert.equal(calls.length, 3, '三节俱在')
    assert.equal(calls[0].outcome, 'ok', '#1 不背补标')
    assert.equal(calls[1].outcome, 'failed', '#2 精确改判')
    assert.equal(calls[1].code, 'GATE_FAILED')
    assert.equal(calls[1].output, '第二节')
    assert.equal(calls[2].outcome, 'ok', '#3 不受牵连')
    const body = readFileSync(groupFile(root, '数学', '变量'), 'utf8')
    assert.match(body, /- #2 ｜ 课程节生成 ｜ 作业 ｜ complete ｜ failed ｜/, 'TOC 第 #2 行改判（多行 TOC 不只看第一条）')
    assert.match(body, /- #1 ｜ 课程节生成 ｜ 作业 ｜ complete ｜ ok ｜/, 'TOC #1 行原样')
    assert.match(body, /- #3 ｜ 课程节生成 ｜ 作业 ｜ complete ｜ ok ｜/, 'TOC #3 行原样')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录补标：tolerated 改判（拆节/大纲容忍通道）；annotate 未知 ref 静默', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    c.record(base('课程节拆分', { course: '数学', node: '变量', source: '作业' }))
    const ref = c.annotateLast('课程节拆分', { outcome: 'tolerated' })!
    c.annotate('别人家的ref#9', { outcome: 'failed', code: 'X' }) // 未知 ref：静默不抛
    await c.flush()
    const body = readFileSync(groupFile(root, '数学', '变量'), 'utf8')
    assert.match(body, /- 结果: tolerated/)
    assert.doesNotMatch(body, /- 失败码:/)
    void ref
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录：lastRef 同步登记（写盘未 flush 时已可取）；空目录不建组目录', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    c.record(base('里程碑草案', { kind: 'repair', course: '数学', node: '变量', source: '作业' }))
    assert.ok(c.lastRef('里程碑草案'))
    assert.ok(!existsSync(join(root, 'state', '调用记录', '数学')))
    await c.flush()
    assert.ok(existsSync(groupFile(root, '数学', '变量')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录：身份盖章缝 stampCorpusSink——course/node/source 随每次 record 并组', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    const sink = stampCorpusSink(c, { course: '数学', node: '变量', source: '单节重写' })
    sink(base('课程节生成'))
    sink(base('课程节生成', { attempt: 2 }))
    await c.flush()
    const calls = parseCallRecordFile(readFileSync(groupFile(root, '数学', '变量'), 'utf8'))
    assert.equal(calls.length, 2)
    assert.ok(calls.every(x => x.source === '单节重写'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录补标：跨分卷——滚卷后补标旧分卷里的节，改判落在旧卷、ref 仍指得着', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    const big = 'x'.repeat(CALL_RECORD_PART_CAP)
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', response: { text: '旧卷节', finish: 'stop' }, request: { messages: [{ role: 'user', text: big }] } }))
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', ts: '2026-09-13T12:01:00.000Z' }))
    await c.flush()
    assert.ok(existsSync(join(root, 'state', '调用记录', '数学', '变量.part2.md')), '前置：已滚卷')
    c.annotate('数学/变量#1', { outcome: 'tolerated' })
    await c.flush()
    const part1 = parseCallRecordFile(readFileSync(join(root, 'state', '调用记录', '数学', '变量.md'), 'utf8'))
    assert.equal(part1[0].outcome, 'tolerated', '旧分卷里的节被补到')
    assert.match(readFileSync(join(root, 'state', '调用记录', '数学', '变量.md'), 'utf8'), /- #1 ｜ 课程节生成 ｜ 作业 ｜ complete ｜ tolerated ｜/, '旧卷 TOC 行同步')
    const part2 = parseCallRecordFile(readFileSync(join(root, 'state', '调用记录', '数学', '变量.part2.md'), 'utf8'))
    assert.equal(part2[0].outcome, 'ok', '新卷不受牵连')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录：单文件软上限分卷 <节点>.partN.md——超限滚下一卷，序号跨卷连续', async () => {
  const root = tmpCenter()
  try {
    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    const big = 'x'.repeat(CALL_RECORD_PART_CAP)
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', request: { messages: [{ role: 'user', text: big }] } }))
    c.record(base('课程节生成', { course: '数学', node: '变量', source: '作业', attempt: 1, ts: '2026-09-13T12:01:00.000Z' }))
    await c.flush()
    const dir = join(root, 'state', '调用记录', '数学')
    assert.ok(existsSync(join(dir, '变量.md')), '第一卷 = <节点>.md')
    assert.ok(existsSync(join(dir, '变量.part2.md')), '超限滚卷')
    const calls = readCallRecords(join(root, 'state', '调用记录'))
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(x => x.ref), ['数学/变量#1', '数学/变量#2'], '跨卷序号连续')
    assert.equal(calls[1].prompt, '渲染后的提示词正文', '第二卷的新节正常解析')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('调用记录生命周期：90 天保留 + 每站下限保底（sweepNow 测试缝）', async () => {
  const root = tmpCenter()
  try {
    const dir = join(root, 'state', '调用记录', '数学')
    mkdirSync(dir, { recursive: true })
    const offline = join(root, 'state', '调用记录', OFFLINE_DIR)
    mkdirSync(offline, { recursive: true })
    const now = new Date('2026-09-17T08:00:00.000Z')
    const old = new Date(now.getTime() - 91 * 86_400_000)
    const fresh = new Date(now.getTime() - 1000)
    // 过期件：判卷站只有这一个旧组文件——下限保底（FLOOR=2）应保留
    writeFileSync(join(dir, '变量.md'), renderFakeGroup('数学/变量', ['判卷']), 'utf8')
    utimesSync(join(dir, '变量.md'), old, old)
    // 过期件：课程大纲站有 FLOOR+1 个旧组文件——最旧的一件删除，其余保底
    for (const [i, node] of ['甲', '乙', '丙'].entries()) {
      writeFileSync(join(dir, `${node}.md`), renderFakeGroup(`数学/${node}`, ['课程大纲']), 'utf8')
      utimesSync(join(dir, `${node}.md`), old, new Date(old.getTime() + i * 1000))
    }
    // 新鲜件不受保留期影响
    writeFileSync(join(dir, '新节点.md'), renderFakeGroup('数学/新节点', ['题目生成']), 'utf8')
    utimesSync(join(dir, '新节点.md'), fresh, fresh)
    // 过期离线件：三件同站——下限保底留最新两件，最旧一件出册
    for (const [i, name] of ['老师辅导一', '老师辅导二', '老师辅导三'].entries()) {
      writeFileSync(join(offline, `${name}.md`), renderFakeGroup(`_离线/${name}`, ['老师辅导']), 'utf8')
      utimesSync(join(offline, `${name}.md`), old, new Date(old.getTime() + i * 1000))
    }

    const c = createCorpusCapture(join(root, 'state', '调用记录'))
    const swept = await c.sweepNow(now.getTime())
    assert.ok(existsSync(join(dir, '变量.md')), '判卷站唯一件跌破每站下限 → 保底不删')
    assert.ok(!existsSync(join(dir, '甲.md')), '课程大纲站最旧过期件删除')
    assert.ok(existsSync(join(dir, '乙.md')) && existsSync(join(dir, '丙.md')), '下限内的较新过期件保留（保底 2 件）')
    assert.ok(existsSync(join(dir, '新节点.md')), '新鲜件不扫')
    assert.ok(!existsSync(join(offline, '老师辅导一.md')), '过期离线件最旧一件出册')
    assert.ok(existsSync(join(offline, '老师辅导二.md')) && existsSync(join(offline, '老师辅导三.md')), '离线站保底两件留存')
    assert.equal(swept, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function renderFakeGroup(label: string, stations: string[]): string {
  const toc = stations.map((s, i) => `- #${i + 1} ｜ ${s} ｜ 作业 ｜ complete ｜ ok ｜ 2026-06-01T00:00:00.000Z`).join('\n')
  const sections = stations.map((s, i) => [
    `## #${i + 1} ｜ ${s} ｜ 作业`, '', '- 时间: 2026-06-01T00:00:00.000Z', '- 阶段: complete', '- 尝试: 1', '- 结果: ok',
    '- 模型: m（p）', '- 耗时: 1ms', '- 截断: false', '', '### 请求', '', '```json', '{"messages":[]}', '```', '',
    '### 响应', '', '```json', '{"text":""}', '```', '', '',
  ].join('\n')).join('\n')
  return `# 调用记录 ${label}\n\n- 任务: ${label}\n- 分卷: x.md\n- 更新: 2026-06-01T00:00:00.000Z\n\n## 调用索引\n\n${toc}\n\n---\n\n${sections}`
}

test('调用记录读侧：corpusLayoutOf 判向——新组文件 / 旧生成语料站目录 / 空', () => {
  const root = tmpCenter()
  try {
    const fresh = join(root, '调用记录')
    mkdirSync(join(fresh, '数学'), { recursive: true })
    writeFileSync(join(fresh, '数学', '变量.md'), renderFakeGroup('数学/变量', ['判卷']), 'utf8')
    mkdirSync(join(fresh, OFFLINE_DIR), { recursive: true })
    assert.equal(corpusLayoutOf(fresh), '调用记录')
    assert.equal(corpusLayoutOf(join(REPO, 'tests', 'fixtures', 'quality-corpus')), '生成语料', '仓库夹具 = 旧格式（历史语料回放面）')
    assert.equal(corpusLayoutOf(join(root, '不存在')), '空')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('旧格式读侧（冻结）：无工具调用段照读；段内坏行以占位保留原文不静默丢（#236 兼容面）', () => {
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

test('#301 站名词表受控纪律：生长单站引引擎常量（站名对齐靠常量不靠字面），遗留站名已清理', () => {
  assert.equal(STATIONS.growthDraft, GROWTH_DRAFT_STATION, '教练执行站名 = 引擎常量（GROWTH_DRAFT_STATION）')
  // 拆分前的单站遗留名 `growth: '教练思路'` 已删；#320 两站回单站后 `growthPlan`（思路官站）也退场
  assert.equal(Object.keys(STATIONS).includes('growth'), false, '遗留映射键不再存在')
  assert.equal(Object.keys(STATIONS).includes('growthPlan'), false, '两站回单站后思路官站键退场')
})

test('#313 D19 站名一条链：引擎侧站常量全部在宿主词表里（四站点双写的收口）', () => {
  // 判据：引擎写下的站名 ∈ STATIONS——此前罗盘/目标反编译两侧各写一份字面量（改一侧即
  // 静默分裂成两个语料目录、GRAPH_JOB_STATIONS 失败补标失配），现有门只断言
  // OUTPUT_CONTRACTS ⊆ STATIONS，管不到「引擎侧常量」这一面。
  const engineStations: Array<[string, string]> = [
    ['GROWTH_DRAFT_STATION', GROWTH_DRAFT_STATION],
    ['COMPASS_STATION', COMPASS_STATION], ['DECOMPILE_STATION', DECOMPILE_STATION],
    ['QUIZ_SOLVER_STATION', QUIZ_SOLVER_STATION], ['QUALITY_REVIEW_STATION', QUALITY_REVIEW_STATION],
  ]
  const known = new Set(Object.values(STATIONS) as string[])
  for (const [name, value] of engineStations) {
    assert.ok(known.has(value), `引擎常量 ${name}（${value}）不在宿主词表 STATIONS 里——两侧改名即分裂成两个语料目录`)
  }
  // 四个生成站（罗盘/反编译/计划/里程碑）的 GRAPH_JOB_STATIONS 映射也要在册
  const graphStations = ['罗盘', '目标反编译', '计划草案', '里程碑草案']
  for (const g of graphStations) assert.ok(known.has(g), `图域任务站 ${g} 不在词表里`)
})
