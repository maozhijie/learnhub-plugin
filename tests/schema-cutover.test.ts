/**
 * schema 版本硬门与迁移脚本（#138 / ADR-0034 宣告式断裂）。
 *
 * - 硬门：v2 正常构造；v1（缺 schema/缺版本/旧版本号/损坏 JSON/缺文件）在构造期
 *   同步拒载，报错含迁移指引——封死一切取用引擎的路径。
 * - 迁移脚本：已按裁决退役为存根（scripts/migrate-v1.mjs 头注），其端到端测试
 *   随脚本一同删除；存根时代的防回归 = 硬门拒载测试（下方）继续守护。
 * - data-check：存档区 archived 信息级盘点（数文件、不校验内容、不进 status）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

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
    assert.deepEqual(report.byArea.archive, { missing: 0, broken: 0, archived: 1, hint: 0 })
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
