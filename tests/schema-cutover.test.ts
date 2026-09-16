/**
 * schema 版本硬门与断裂宣告（#138 / ADR-0034 宣告式断裂；#239 断裂 v3；#284 断裂 v4）。
 *
 * - 硬门：v4 正常构造；旧库（缺 schema/缺版本/旧版本号/损坏 JSON/缺文件/未来版本号）
 *   在构造期同步拒载，报错宣告零迁移断裂——旧课程库不再支持、由用户自删：删除旧
 *   课程目录（或整个学习中心数据目录）后重建（#284：一次性断裂脚本退役，不再有
 *   migrate 脚本与存档搬移）。
 * - data-check：存档区 archived 信息级盘点（数文件、不校验内容、不进 status；
 *   存档区跨断裂累加——pre-v1/ 与 pre-v2/ 同住一个 存档 目录，只报总量）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LearnhubEngine, noopLogger } from '../src/engine/index.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/engine/schema.ts'
import { mathRng, systemClock } from '../src/host/clock.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { tfQuestion, withVault } from './helpers/vault.ts'

/** 工厂外的裸 vault（版本门负路径专用：工厂总是盖 v4 戳并构造引擎）。 */
async function rawVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-gate-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, content, 'utf8')
  }
  return root
}

test('硬门：v4 库正常构造，schema 块随引擎可读', async () => {
  await withVault({}, async ({ engine }) => {
    assert.equal(engine.schema.version, CURRENT_SCHEMA_VERSION)
    assert.equal(engine.schema.version, 4)
    await engine.registry.enabled() // 一切方法照常
  })
})

test('硬门：v3/v1 库（缺 schema 块 / 旧版本号 / 缺文件）构造期拒载并宣告零迁移断裂', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ '学习中心/state/learnhub.json': '{"day_cutoff":"00:00"}' }, /无 schema\.version（v1 库）/],
    [{ '学习中心/state/learnhub.json': JSON.stringify({ schema: { version: 3 } }) }, /v3/],
    [{ '学习中心/state/learnhub.json': JSON.stringify({ schema: { version: 1 } }) }, /v1/],
    [{}, /无 schema\.version（v1 库）/],
  ]
  for (const [files, versionPattern] of cases) {
    const root = await rawVault({ '学习中心/课程注册表.yaml': 'courses: []\n', ...files })
    try {
      assert.throws(() => new LearnhubEngine({ vault: root, clock: systemClock, rng: mathRng, fs: nodeVaultFs, logger: noopLogger }), (err: unknown) => {
        const message = (err as Error).message
        assert.ok(versionPattern.test(message), message)
        assert.match(message, /零迁移/, '#284：一次性断裂脚本退役，文案宣告零迁移')
        assert.match(message, /用户自删/, '旧课程库不再支持：由用户自删')
        assert.match(message, /删除旧课程目录/, '重建路径：删除旧课程目录（或整个学习中心数据目录）后重建')
        assert.doesNotMatch(message, /migrate-v2\.mjs/, '不再指路断裂脚本')
        return true
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('硬门：损坏 JSON 与史前库拒因分流（#295）——损坏给备份+人工检查指引，不给删库建议', async () => {
  const root = await rawVault({ '学习中心/课程注册表.yaml': 'courses: []\n', '学习中心/state/learnhub.json': '{broken json' })
  try {
    assert.throws(() => new LearnhubEngine({ vault: root, clock: systemClock, rng: mathRng, fs: nodeVaultFs, logger: noopLogger }), (err: unknown) => {
      const message = (err as Error).message
      assert.match(message, /JSON 解析失败（损坏）/, '#295：损坏拒因单列，不再并入史前库文案')
      assert.match(message, /备份/, '损坏档可能仍可抢救：先备份再人工检查')
      assert.doesNotMatch(message, /用户自删|删除旧课程目录/, '损坏拒因不给删库建议')
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('硬门：未来版本号同样拒载（引擎只认当前主版本）', async () => {
  const root = await rawVault({
    '学习中心/课程注册表.yaml': 'courses: []\n',
    '学习中心/state/learnhub.json': JSON.stringify({ schema: { version: 5 } }),
  })
  try {
    assert.throws(() => new LearnhubEngine({ vault: root, clock: systemClock, rng: mathRng, fs: nodeVaultFs, logger: noopLogger }), /v5/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('硬门：v2 库里的单锚形状（version: 1 锚文件）读侧 fail loud（零兼容读）', async () => {
  await withVault({
    files: [{
      path: '学习中心/math/state/终点锚.json',
      content: JSON.stringify({ version: 1, endpoint: '入门', goal_type: 'capability', declared: '2026-09-01' }),
    }],
  }, async ({ engine }) => {
    await assert.rejects(() => engine.graph.graphAnalyze('数学'), /锚文件 Broken[\s\S]*version: 必须是 2/)
  })
})

// ---- 断裂宣告（#284：一次性断裂脚本退役——零迁移、旧课用户自删重建） ----

test('断裂宣告：v3 库拒载文案点名存储塌缩与自删重建路径；拒载路径上零迁移零落盘', async () => {
  const root = await rawVault({
    '学习中心/课程注册表.yaml': 'courses: []\n',
    '学习中心/state/learnhub.json': JSON.stringify({ schema: { version: 3 } }),
  })
  try {
    assert.throws(() => new LearnhubEngine({ vault: root, clock: systemClock, rng: mathRng, fs: nodeVaultFs, logger: noopLogger }), (err: unknown) => {
      const message = (err as Error).message
      assert.match(message, /宣告式断裂：#284 存储塌缩/, '断裂理由点名存储塌缩')
      assert.match(message, /一课程一文件 data\/图\.yaml/, '新存储形态写进文案')
      assert.match(message, /零迁移脚本/)
      assert.match(message, /旧课程库不再支持、由用户自删：删除旧课程目录（或整个学习中心数据目录）后重建/)
      assert.match(message, /跨断裂存活的档案（概念登记表等）随重建课程重新落盘/)
      assert.doesNotMatch(message, /migrate/, '不再存在任何迁移脚本指路')
      return true
    })
    // 零迁移断言：拒载路径上引擎什么都不写——learnhub.json 原样、无存档目录
    // （旧脚本的存档搬移/版本戳改写/断裂史落笔全部退役）
    const configPath = join(root, '学习中心', 'state', 'learnhub.json')
    assert.equal(await readFile(configPath, 'utf8'), JSON.stringify({ schema: { version: 3 } }), 'learnhub.json 未被改写')
    assert.ok(!existsSync(join(root, '学习中心', '存档')), '不产生存档目录（存档搬移随脚本退役）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- data-check：archived 信息级盘点 ----

/** 干净现役库（有笔记有题库 → 无 Missing/Broken），存档区内容完全坏也照常盘点。 */
const CLEAN_VAULT = { notes: { 入门: {} }, banks: { 入门: [tfQuestion('q1', {})] } }

test('data-check：存档区出 archived 盘点（数文件、不校验内容、不进 status；跨断裂累加）', async () => {
  await withVault({
    ...CLEAN_VAULT,
    files: [
      { path: '学习中心/存档/pre-v1/2026-01-01/math/data.yaml', content: '{{{ 完全坏掉的"内容" }}' },
      { path: '学习中心/存档/pre-v1/2026-01-01/math/课程/入门.md', content: '# 存档笔记' },
      { path: '学习中心/存档/pre-v2/2026-09-14/物理/state/终点锚.json', content: '{"version":1}' },
      { path: '学习中心/state/learnhub.json', content: JSON.stringify({ schema: { version: 4, breaks: [{ from: 1, date: '2026-01-01', archived: ['math'] }, { from: 2, date: '2026-09-14', archived: ['物理'] }] }, day_cutoff: '00:00' }) },
    ],
  }, async ({ engine }) => {
    const report = await engine.dataCheck()
    assert.equal(report.status, 'ok', 'archived 不进 status')
    assert.equal(report.counts.archived, 1)
    assert.deepEqual(report.byArea.archive, { missing: 0, broken: 0, archived: 1, hint: 0 })
    assert.equal(report.inventory.archive.present, true)
    assert.equal(report.inventory.archive.files, 3, '存档区跨断裂累加：pre-v1 两件 + pre-v2 一件')
    const finding = report.findings.find(f => f.reason === 'pre_v2_archive')!
    assert.equal(finding.level, 'archived')
    assert.match(finding.detail!, /3 个文件/)
    assert.match(finding.detail!, /2026-01-01、2026-09-14/, '断裂史逐次列出')
  })
})

test('data-check：断裂史在档但存档区缺失 → pre_v2_artifact 提示；无断裂史零 archived', async () => {
  await withVault({
    ...CLEAN_VAULT,
    files: [
      { path: '学习中心/state/learnhub.json', content: JSON.stringify({ schema: { version: 4, breaks: [{ from: 1, date: '2026-01-01', archived: ['数学'] }] }, day_cutoff: '00:00' }) },
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
