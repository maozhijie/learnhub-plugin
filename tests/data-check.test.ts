import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import type { DataCheckReport } from '../src/engine/data-check.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

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

async function writeVault(root: string): Promise<void> {
  const center = join(root, '学习中心')
  const course = join(center, 'math')
  await mkdir(join(course, 'data'), { recursive: true })
  await mkdir(join(course, '课程', '基础'), { recursive: true })
  await mkdir(join(course, '题库'), { recursive: true })
  await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`)
  await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`)
  await writeFile(join(course, '课程', '基础', '入门.md'), `${NOTE}\n`)
  await writeFile(join(course, '题库', '入门.yaml'), `${BANK}\n`)
}

async function writeBrokenVault(root: string): Promise<void> {
  await writeVault(root)
  const course = join(root, '学习中心', 'math')
  await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n        broken: true\n`)
  await writeFile(join(course, '课程', '基础', '入门.md'), '---\nnode: "入门\n---\n')
  await writeFile(join(course, '题库', '入门.yaml'), `${BANK.replace('true_false', 'impossible')}\n`)
}

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

async function withVault(seed: (root: string) => Promise<void>, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-data-check-'))
  try {
    await seed(root)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('Data Check separates legal missing objects from valid data at the engine facade', async () => {
  await withVault(writeVault, async root => {
    const engine = new LearnhubEngine({ vault: root })
    const report = await engine.dataCheck()

    assert.equal(report.status, 'missing')
    assert.equal(report.counts.broken, 0)
    assert.equal(report.counts.missing, 2)
    assert.deepEqual(report.byArea.note, { missing: 1, broken: 0 })
    assert.deepEqual(report.byArea.question_bank, { missing: 1, broken: 0 })

    const reasons = byReason(report)
    assert.equal(reasons.get('note_missing'), 1)
    assert.equal(reasons.get('question_bank_missing'), 1)
    assert.ok(report.findings.every(f => f.location.includes(root)))
    assert.ok(report.findings.some(f => f.reason === 'note_missing' && f.location.includes('进阶.md')))
  })
})

test('Data Check reports broken YAML and schema without crashing the scan', async () => {
  await withVault(writeBrokenVault, async root => {
    const engine = new LearnhubEngine({ vault: root })
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
  await withVault(async root => {
    await mkdir(join(root, '学习中心'), { recursive: true })
    await writeFile(join(root, '学习中心', '课程注册表.yaml'), 'courses:\n  - name: "数学\n')
  }, async root => {
    const engine = new LearnhubEngine({ vault: root })
    const report = await engine.dataCheck()

    assert.equal(report.status, 'broken')
    assert.deepEqual(report.byArea.registry, { missing: 0, broken: 1 })
    assert.equal(report.inventory.courses, 0)
    assert.equal(byReason(report).get('registry_yaml_parse'), 1)
  })
})

test('Data Check does not write or mutate Vault files', async () => {
  await withVault(writeBrokenVault, async root => {
    const engine = new LearnhubEngine({ vault: root })
    const before = await snapshot(root)
    await engine.dataCheck()
    const after = await snapshot(root)

    assert.deepEqual(after, before)
  })
})
