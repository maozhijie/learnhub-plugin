/**
 * schema 版本硬门与迁移脚本（#138 / ADR-0034 宣告式断裂）。
 *
 * - 硬门：v2 正常构造；v1（缺 schema/缺版本/旧版本号/损坏 JSON/缺文件）在构造期
 *   同步拒载，报错含迁移指引——封死一切取用引擎的路径。
 * - 迁移脚本：子进程跑 scripts/migrate-v1.mjs，端到端验证存档搬移、登记表豁免、
 *   行为流水原地保留、版本戳与防重跑。（脚本 cutover 完成后按裁决退役为存根，
 *   本段端到端测试随之删除。）
 * - data-check：存档区 archived 信息级盘点（数文件、不校验内容、不进 status）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { LearnhubEngine } from '../src/engine/index.ts'
import { localDay, tfQuestion, withVault } from './helpers/vault.ts'

const run = promisify(execFile)

/** 工厂外的裸 vault（版本门负路径专用：工厂总是盖 v2 戳并构造引擎）。 */
async function rawVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-gate-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, content, 'utf8')
  }
  return root
}

test('硬门：v2 库正常构造，schema 块随引擎可读', async () => {
  await withVault({}, async ({ engine }) => {
    assert.equal(engine.schema.version, 2)
    await engine.enabledCourses() // 一切方法照常
  })
})

test('硬门：v1 库（缺 schema 块 / 旧版本号 / 损坏 JSON / 缺文件）构造期拒载并指引迁移脚本', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ '学习中心/state/learnhub.json': '{"day_cutoff":"00:00"}' }, /无 schema\.version（v1 库）/],
    [{ '学习中心/state/learnhub.json': JSON.stringify({ schema: { version: 1 } }) }, /v1/],
    [{ '学习中心/state/learnhub.json': '{broken json' }, /无 schema\.version（v1 库）/],
    [{}, /无 schema\.version（v1 库）/],
  ]
  for (const [files, versionPattern] of cases) {
    const root = await rawVault({ '学习中心/课程注册表.yaml': 'courses: []\n', ...files })
    try {
      assert.throws(() => new LearnhubEngine({ vault: root }), (err: unknown) => {
        const message = (err as Error).message
        assert.ok(versionPattern.test(message), message)
        assert.match(message, /scripts\/migrate-v1\.mjs/, '报错必须指路一次性迁移脚本')
        return true
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('硬门：未来版本号同样拒载（引擎只认当前主版本）', async () => {
  const root = await rawVault({
    '学习中心/课程注册表.yaml': 'courses: []\n',
    '学习中心/state/learnhub.json': JSON.stringify({ schema: { version: 3 } }),
  })
  try {
    assert.throws(() => new LearnhubEngine({ vault: root }), /v3/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- 迁移脚本（端到端子进程；脚本退役后本段随之删除） ----

/** 搭一个 v1 库：注册表两课（其一含概念登记表）+ 课程目录 + 行为流水 + 旧 learnhub.json。 */
async function seedV1Vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-migrate-'))
  const center = join(root, '学习中心')
  await mkdir(join(center, 'math', 'state'), { recursive: true })
  await mkdir(join(center, '物理'), { recursive: true })
  await writeFile(join(center, '课程注册表.yaml'), [
    'courses:',
    '  - id: math-01',
    '    name: 数学',
    '    root: math',
    '    enabled: true',
    '  - { name: 物理, root: 物理, enabled: true }',
    'note_sources:',
    '  - { id: n1, path: notes/a.md, fingerprint: x, created: "2026-01-01", enabled: true }',
  ].join('\n'), 'utf8')
  await writeFile(join(center, 'math', 'data.yaml'), 'region: 基础\nblocks: []\n', 'utf8')
  await writeFile(join(center, 'math', 'state', 'fsrs参数.json'), '{"parameters":[1,2,3]}', 'utf8')
  await writeFile(join(center, '物理', '概念登记表.yaml'), 'concepts: []\n', 'utf8')
  await mkdir(join(center, 'state'), { recursive: true })
  await writeFile(join(center, 'state', 'practice.jsonl'), '{"ts":"2026-01-01T10:00:00+08:00","course":"math","node":"入门","ex":"q","answer":"a","correct":true,"judge":"quiz"}\n', 'utf8')
  await writeFile(join(center, 'state', 'learnhub.json'), '{"day_cutoff":"00:00"}', 'utf8')
  return root
}

test('迁移脚本：存档搬移 + 登记表豁免 + 流水原地 + 版本戳 + 防重跑', async () => {
  const vault = await seedV1Vault()
  const script = join(process.cwd(), 'scripts', 'migrate-v1.mjs')
  const day = localDay()
  try {
    const { stdout } = await run(process.execPath, [script, vault])
    assert.match(stdout, /cutover 完成：v1 → v2/)

    const center = join(vault, '学习中心')
    // ① 课程根整树入存档（fsrs参数.json 随课归档）
    const archivedMath = join(center, '存档', 'pre-v1', day, 'math')
    assert.equal(await readFile(join(archivedMath, 'state', 'fsrs参数.json'), 'utf8'), '{"parameters":[1,2,3]}')
    assert.ok(!existsSync(join(center, 'math')), '原课程根不在现役区')
    // ② 概念登记表豁免：随树搬走后放回原位
    assert.equal(await readFile(join(center, '物理', '概念登记表.yaml'), 'utf8'), 'concepts: []\n')
    // ③ 行为流水原地保留
    assert.match(await readFile(join(center, 'state', 'practice.jsonl'), 'utf8'), /"course":"math"/)
    // ④ 注册表清空、note_sources 保留、原文进存档
    const registry = await readFile(join(center, '课程注册表.yaml'), 'utf8')
    assert.match(registry, /courses: \[\]/)
    assert.match(registry, /note_sources:/)
    assert.match(await readFile(join(center, '存档', 'pre-v1', day, '课程注册表.yaml.v1'), 'utf8'), /root: math/)
    // ⑤ 版本戳 + breaks 断裂史
    const config = JSON.parse(await readFile(join(center, 'state', 'learnhub.json'), 'utf8'))
    assert.equal(config.schema.version, 2)
    assert.equal(config.schema.breaks[0].from, 1)
    assert.deepEqual([...config.schema.breaks[0].archived].sort(), ['math', '物理'])
    // ⑥ 引擎此刻可正常构造（硬门放行）
    const engine = new LearnhubEngine({ vault })
    assert.equal(engine.schema.version, 2)
    // ⑦ 防重跑
    await assert.rejects(run(process.execPath, [script, vault]), /拒绝重跑/)
  } finally {
    await rm(vault, { recursive: true, force: true })
  }
})

// ---- data-check：archived 信息级盘点 ----

/** 干净现役库（有笔记有题库 → 无 Missing/Broken），存档区内容完全坏也照常盘点。 */
const CLEAN_VAULT = { notes: { 入门: {} }, banks: { 入门: [tfQuestion('q1', {})] } }

test('data-check：存档区出 archived 盘点（数文件、不校验内容、不进 status）', async () => {
  await withVault({
    ...CLEAN_VAULT,
    files: [
      { path: '学习中心/存档/pre-v1/2026-01-01/math/data.yaml', content: '{{{ 完全坏掉的"内容" }}' },
      { path: '学习中心/存档/pre-v1/2026-01-01/math/课程/入门.md', content: '# 存档笔记' },
      { path: '学习中心/state/learnhub.json', content: JSON.stringify({ schema: { version: 2, breaks: [{ from: 1, date: '2026-01-01', archived: ['math'] }] }, day_cutoff: '00:00' }) },
    ],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.status, 'ok', 'archived 不进 status')
    assert.equal(report.counts.archived, 1)
    assert.deepEqual(report.byArea.archive, { missing: 0, broken: 0, archived: 1 })
    assert.deepEqual(report.inventory.archive, { present: true, files: 2 })
    const finding = report.findings.find(f => f.reason === 'pre_v2_archive')!
    assert.equal(finding.level, 'archived')
    assert.match(finding.detail!, /2 个文件/)
    assert.match(finding.detail!, /2026-01-01/)
  })
})

test('data-check：断裂史在档但存档区缺失 → pre_v2_artifact 提示；无断裂史零 archived', async () => {
  await withVault({
    ...CLEAN_VAULT,
    files: [
      { path: '学习中心/state/learnhub.json', content: JSON.stringify({ schema: { version: 2, breaks: [{ from: 1, date: '2026-01-01', archived: ['数学'] }] }, day_cutoff: '00:00' }) },
    ],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.status, 'ok')
    const artifact = report.findings.find(f => f.reason === 'pre_v2_artifact')!
    assert.equal(artifact.level, 'archived')
    assert.match(artifact.detail!, /存档区不在盘上/)
  })
  await withVault(CLEAN_VAULT, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.counts.archived, 0)
    assert.ok(!report.findings.some(f => f.area === 'archive'))
  })
})
