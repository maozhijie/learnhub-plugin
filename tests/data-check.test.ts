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
