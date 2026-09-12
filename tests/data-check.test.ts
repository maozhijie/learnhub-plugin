import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { DataCheckReport } from '../src/engine/data-check.ts'
import { withVault } from './helpers/vault.ts'

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - name: 入门',
  '        pre: []',
  '        opt: false',
  '        note: ""',
  '        est: 20',
  '      - name: 进阶',
  '        pre: [入门]',
  '        opt: false',
  '        note: ""',
  '        est: 25',
].join('\n')

const NOTE = [
  '---',
  'node: 入门',
  'stage: ready',
  'fsrs: null',
  'mastery: 0',
  'content:',
  '  version: 0',
  '  generated_at: null',
  '  status: draft',
  'practice:',
  '  attempts: 0',
  '  correct: 0',
  'user_note: 保留我的元数据',
  '---',
  '',
  '# 入门',
].join('\n')

const BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: true_false',
  '    q: 三角形内角和是 180 度。',
  '    answer: true',
].join('\n')

/** 三处故意损坏：图 schema、笔记 frontmatter、题库 kind（经逃生口覆盖正常档）。 */
const BROKEN_FILES = [
  { path: '学习中心/math/data/基础.yaml', content: `${GRAPH}\n        broken: true\n` },
  { path: '学习中心/math/课程/基础/入门.md', content: '---\nnode: "入门\n---\n' },
  { path: '学习中心/math/题库/入门.yaml', content: `${BANK.replace('true_false', 'impossible')}\n` },
]

async function snapshot(root: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>()
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const [info, bytes] = await Promise.all([stat(path), readFile(path)])
      const key = resolve(relative(root, path).replace(/\\/g, '/'))
      out.set(key, {
        size: info.size,
        mode: info.mode,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        birthtimeMs: info.birthtimeMs,
        hash: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  await walk(root)
  return out
}

function byReason(report: DataCheckReport): Map<string, number> {
  const out = new Map<string, number>()
  for (const finding of report.findings) {
    out.set(finding.reason, (out.get(finding.reason) ?? 0) + 1)
  }
  return out
}

test('Data Check separates legal missing objects from valid data at the engine facade', async () => {
  await withVault({ graph: GRAPH, notes: { 入门: NOTE }, banks: { 入门: BANK } }, async ({ engine, root }) => {
    const report = await engine.dataCheck()

    assert.equal(report.status, 'missing')
    assert.equal(report.counts.broken, 0)
    assert.equal(report.counts.missing, 2)
    assert.deepEqual(report.byArea.note, { missing: 1, broken: 0, archived: 0, hint: 0 })
    assert.deepEqual(report.byArea.question_bank, { missing: 1, broken: 0, archived: 0, hint: 0 })

    const reasons = byReason(report)
    assert.equal(reasons.get('note_missing'), 1)
    assert.equal(reasons.get('question_bank_missing'), 1)
    assert.ok(report.findings.every(f => f.location.includes(root)))
    assert.ok(report.findings.some(f => f.reason === 'note_missing' && f.location.includes('进阶.md')))
  })
})

test('Data Check reports broken YAML and schema without crashing the scan', async () => {
  await withVault({ graph: GRAPH, notes: { 入门: NOTE }, banks: { 入门: BANK }, files: BROKEN_FILES }, async ({ engine, root }) => {
    const report = await engine.dataCheck()

    assert.equal(report.status, 'broken')
    assert.equal(report.counts.broken, 3)
    const reasons = byReason(report)
    assert.equal(reasons.get('graph_schema'), 1)
    assert.equal(reasons.get('note_yaml_parse'), 1)
    assert.equal(reasons.get('question_bank_schema'), 1)
    assert.ok(report.findings.every(f => f.location.includes(root)))
    assert.ok(report.findings.every(f => typeof f.reason === 'string' && f.reason.length > 0))
  })
})

test('Data Check keeps malformed registry as Broken instead of an empty course list', async () => {
  await withVault({ registry: 'courses:\n  - name: "数学\n', graph: null }, async ({ engine }) => {
    const report = await engine.dataCheck()

    assert.equal(report.status, 'broken')
    assert.deepEqual(report.byArea.registry, { missing: 0, broken: 1, archived: 0, hint: 0 })
    assert.equal(report.inventory.courses, 0)
    assert.equal(byReason(report).get('registry_yaml_parse'), 1)
  })
})

test('Data Check does not write or mutate Vault files', async () => {
  await withVault({ graph: GRAPH, notes: { 入门: NOTE }, banks: { 入门: BANK }, files: BROKEN_FILES }, async ({ engine, root }) => {
    const before = await snapshot(root)
    await engine.dataCheck()
    const after = await snapshot(root)

    assert.deepEqual(after, before)
  })
})

test('复诊扫描读坏流不炸：Broken 降级为 finding、该课程 overdue 结算降级为 0（#192 / ADR-0053）', async () => {
  await withVault({
    graph: GRAPH, notes: { 入门: NOTE }, banks: { 入门: BANK },
    files: [
      { path: '学习中心/math/state/边实验.jsonl', content: '{"node":"入门","pre":[],"proposal":1,"due":5}\n' },
      { path: '学习中心/state/practice.jsonl', content: '{"ts":"2024-01-01T10:00:00+08:00","course":"数学","node":"入门","ex":"e","answer":"a","correct":true,"judge":"auto"}\n{broken\n' },
    ],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    const reasons = byReason(report)

    assert.equal(reasons.get('probation_stream_broken'), 1, '坏流浮出 finding（体检的本分是可见性）')
    assert.equal(report.inventory.probationLedgers.present, 1, '账本本身在盘，盘点照常')
    assert.equal(report.inventory.probationLedgers.overdue, 0, '行为流水损坏 → overdue 结算降级为 0')
    assert.equal(report.status, 'broken')
  })
})

test('Data Check gen_jobs area：坏档报 broken finding；合法档的悬空记录不报（归 ADR-0039 清扫）', async () => {
  await withVault({
    files: [{ path: '学习中心/state/生成任务.json', content: '{broken' }],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    const gj = report.findings.filter(f => f.area === 'gen_jobs')
    assert.equal(gj.length, 1)
    assert.equal(gj[0]!.reason, 'gen_jobs_json_parse')
    assert.match(gj[0]!.detail ?? '', /修复或删除该文件后重启宿主/)
    assert.equal(report.status, 'broken')
  })
})

test('Data Check gen_jobs area：合法 JSON 数组（含悬空记录）零 finding——悬空归恢复清扫', async () => {
  await withVault({
    files: [{
      path: '学习中心/state/生成任务.json',
      content: JSON.stringify([
        { course: '已删课程', node: '幽灵节点', startedAt: '2026-09-12T10:00:00+08:00', status: 'done' },
      ]) + '\n',
    }],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.findings.filter(f => f.area === 'gen_jobs').length, 0, '悬空记录不报（避免与 ADR-0039 清扫双重处置）')
  })
})

// ---- evidence_streams area（#195 / ADR-0053）：逐流盘点 + 撕裂尾行 hint ----

const REC = '{"ts":"2024-01-01T10:00:00+08:00","course":"数学","node":"入门","ex":"e","answer":"a","correct":true,"judge":"auto"}'

test('Data Check evidence_streams area：中段坏行 → broken finding（带路径与行号），status 吃 broken', async () => {
  await withVault({
    files: [{ path: '学习中心/state/勘误.jsonl', content: `${REC}\n{broken\n${REC}\n` }],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    const hits = report.findings.filter(f => f.area === 'evidence_streams')
    assert.equal(hits.length, 1, '逐流出 finding：一条坏行一条，不遮蔽其余流')
    assert.equal(hits[0]!.level, 'broken')
    assert.equal(hits[0]!.reason, 'evidence_stream_broken')
    assert.match(hits[0]!.location, /勘误\.jsonl/, 'location 带路径')
    assert.match(hits[0]!.detail ?? '', /第 2 行/, 'detail 带行号')
    assert.equal(report.byArea.evidence_streams.broken, 1)
    assert.equal(report.status, 'broken', 'status 汇总吃 broken')
  })
})

test('Data Check evidence_streams area：撕裂尾行 → hint finding（不进 status，与 archived/hint 先例同款）', async () => {
  await withVault({
    notes: { 入门: NOTE }, banks: { 入门: BANK },
    files: [{ path: '学习中心/state/practice.jsonl', content: `${REC}\n{"ts":"2024-01-02T1` }],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    const hits = report.findings.filter(f => f.area === 'evidence_streams')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.level, 'hint')
    assert.equal(hits[0]!.reason, 'evidence_stream_torn_tail')
    assert.match(hits[0]!.location, /practice\.jsonl/)
    assert.match(hits[0]!.detail ?? '', /第 2 行/)
    assert.equal(report.byArea.evidence_streams.hint, 1)
    assert.equal(report.counts.hint, 1)
    assert.equal(report.status, 'ok', 'hint 不进 status：只剩撕裂尾行时体检整体仍 ok')
    const row = report.inventory.evidenceStreams.find(s => s.stream === 'practice')!
    assert.equal(row.present, true)
    assert.equal(row.entries, 1, '条目数只数合法行，撕裂残行不计入')
  })
})

test('Data Check evidence_streams area：文件缺失 = Missing 合法空态零 finding，盘点仍记在场 false', async () => {
  await withVault({ notes: { 入门: NOTE }, banks: { 入门: BANK } }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.findings.filter(f => f.area === 'evidence_streams').length, 0, '缺失不报')
    const row = report.inventory.evidenceStreams.find(s => s.stream === 'habit-repeats')!
    assert.equal(row.present, false)
    assert.equal(row.entries, 0)
    assert.equal(report.status, 'ok')
  })
})

test('Data Check evidence_streams area：issue 点名十条全覆盖 + 项目 exec 逐项目盘点（#195）', async () => {
  await withVault({
    notes: { 入门: NOTE }, banks: { 入门: BANK },
    files: [
      { path: '学习中心/projects/毕业设计/exec.jsonl', content: `${REC}\n${REC}\n` },
      { path: '学习中心/math/state/边实验.jsonl', content: '{"node":"入门","pre":[],"proposal":1,"due":5}\n' },
    ],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    const streams = report.inventory.evidenceStreams
    // issue #195 点名十条（band→band-log、habit→habit-repeats、边实验账本→probation，
    // 流名与各消费方读侧 label 同串）；sediment/recall 是 #192 评审收口并入原语的两条
    const named = ['practice', 'journal', 'review-log', 'receipts', 'e-archive', 'erratum', 'band-log', 'habit-repeats', 'probation', 'exec']
    for (const key of named) assert.ok(streams.some(s => s.stream === key), `点名流水「${key}」在盘点清单中`)
    const exec = streams.filter(s => s.stream === 'exec')
    assert.equal(exec.length, 1)
    assert.equal(exec[0]!.present, true)
    assert.equal(exec[0]!.entries, 2)
    assert.match(exec[0]!.path, /projects[/\\]毕业设计[/\\]exec\.jsonl$/)
    const probation = streams.find(s => s.stream === 'probation')!
    assert.equal(probation.entries, 1)
  })
})

test('Data Check evidence_streams area：多流同时坏不炸、逐流出 finding', async () => {
  await withVault({
    files: [
      { path: '学习中心/state/勘误.jsonl', content: `${REC}\n{broken\n` },
      { path: '学习中心/state/回执.jsonl', content: '{broken\n' },
      { path: '学习中心/projects/p1/exec.jsonl', content: `${REC}\n{broken\n` },
    ],
  }, async ({ engine }) => {
    const report = await engine.dataCheck() // 能 resolve 即「不炸」
    const hits = report.findings.filter(f => f.area === 'evidence_streams' && f.level === 'broken')
    assert.equal(hits.length, 3, '中心与项目半径逐流各一条，互不遮蔽')
    assert.ok(hits.some(f => f.location.includes('勘误.jsonl')))
    assert.ok(hits.some(f => f.location.includes('回执.jsonl')))
    assert.ok(hits.some(f => f.location.includes('exec.jsonl')))
    assert.equal(report.byArea.evidence_streams.broken, 3)
    assert.equal(report.status, 'broken')
  })
})
