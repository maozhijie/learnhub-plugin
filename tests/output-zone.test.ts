import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { withVault } from './helpers/vault.ts'
import { obsidianLink, writeOutputArtifact, outputArtifactFile, isRegistrableCenterRel } from '../src/engine/output.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'

/** 个人笔记字节快照（红线：输出区/注册动作对用户笔记零写入）。 */
async function snapshot(root: string, rels: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const rel of rels) out.set(rel, await readFile(join(root, rel), 'utf8'))
  return out
}

test('obsidianLink：vault 相对路径 → [[路径|别名]]，剥 .md、归一反斜杠、空路径拒绝', () => {
  assert.equal(obsidianLink('读书笔记/吉他技巧.md'), '[[读书笔记/吉他技巧]]')
  assert.equal(obsidianLink('读书笔记/吉他技巧.md', '吉他'), '[[读书笔记/吉他技巧|吉他]]')
  assert.equal(obsidianLink('a\\b\\c.md'), '[[a/b/c]]')
  assert.throws(() => obsidianLink('  '))
})

test('outputArtifactFile / writeOutputArtifact：kind 白名单、文件名安全化、frontmatter 契约', async () => {
  await withVault({ registry: null, graph: null }, async ({ paths }) => {
    for (const bad of ['../x', '']) assert.throws(() => outputArtifactFile(bad))
    // 路径分隔按仓库命名惯例全角化（与节点改名同款），不构成越界
    assert.equal(outputArtifactFile('a/b.md'), 'a／b.md')
    await assert.rejects(
      () => writeOutputArtifact(paths, { kind: '随手记' as never, file: 'x.md', fm: {}, body: 'x' }, nodeVaultFs),
      /产物类非法/,
    )
    const p = await writeOutputArtifact(paths, {
      kind: '讲解稿',
      file: '入门.1.md',
      fm: { kind: 'explain_script', created: '2026-09-09' },
      body: `# 讲解稿\n\n${obsidianLink('读书笔记/吉他技巧.md', '吉他')}`,
    }, nodeVaultFs)
    assert.ok(existsSync(p))
    const text = await readFile(p, 'utf8')
    assert.match(text, /^---\nkind: explain_script\ncreated: 2026-09-09\n---/)
    assert.match(text, /\[\[读书笔记\/吉他技巧\|吉他\]\]/)
    // 文件落在输出区约定位置：学习中心/我的产出/<类>/
    assert.ok(p.replace(/\\/g, '/').includes('/我的产出/讲解稿/入门.1.md'))
  })
})

test('#107 注册通道豁免区判定：我的产出整区放行、项目日志放行、其余中心内维持拒绝', () => {
  const c = '学习中心'
  assert.equal(isRegistrableCenterRel(c, '学习中心/我的产出'), true)
  assert.equal(isRegistrableCenterRel(c, '学习中心/我的产出/周复盘/2026-08-31.md'), true)
  assert.equal(isRegistrableCenterRel(c, '学习中心/我的产出2/x.md'), false)
  assert.equal(isRegistrableCenterRel(c, '学习中心/projects/p1/日志.md'), true)
  assert.equal(isRegistrableCenterRel(c, '学习中心/projects/p1/项目.md'), false)
  assert.equal(isRegistrableCenterRel(c, '学习中心/projects/p1/milestones/01-x.md'), false)
  assert.equal(isRegistrableCenterRel(c, '学习中心/math/data/基础.yaml'), false)
})

test('#107 我的产出/项目日志可注册为笔记源；中心内其余路径仍拒绝', async () => {
  await withVault({
    files: [
      { path: '学习中心/我的产出/周复盘/2026-08-31.md', content: '---\nkind: weekly_kata\n---\n\n# 周复盘\n\n## 现状\n\n- 学习 2 天\n' },
      { path: '读书笔记/私人.md', content: '# 私人\n' },
    ],
  }, async ({ engine }) => {
    // 中心内常规路径维持拒绝
    await assert.rejects(() => engine.channels.noteSourceRegister('学习中心/math/data/基础.yaml'), /学习中心内部文件不注册/)
    // 输出区文档放行（#107）
    const kata = await engine.channels.noteSourceRegister('学习中心/我的产出/周复盘/2026-08-31.md')
    assert.equal(kata.registered, 1)
    // 项目日志放行（#113 约定路径）；文件尚不存在 = 注册入口拒绝（与用户笔记同语义：注册的是现存文件）
    await assert.rejects(() => engine.channels.noteSourceRegister('学习中心/projects/p1/日志.md'), /路径不存在/)
    await engine.projectCreate({ name: 'P1', goal: 'g' })
    await engine.projectLogAppend('P1', '第一条。')
    const log = await engine.channels.noteSourceRegister('学习中心/projects/p1/日志.md')
    assert.equal(log.registered, 1)
    // 真实个人笔记照旧可注册（回归）
    const personal = await engine.channels.noteSourceRegister('读书笔记/私人.md')
    assert.equal(personal.registered, 1)
    const list = await engine.channels.noteSourceList()
    assert.equal(list.total, 3)
  })
})

test('#107 红线：产物写入 + 注册全链对个人笔记零字节改动；注册动作不写vault 用户区', async () => {
  await withVault({
    files: [{ path: '读书笔记/吉他.md', content: '# 吉他\n\n大横按很难。\n' }],
  }, async ({ engine, root }) => {
    const before = await snapshot(root, ['读书笔记/吉他.md'])
    // 出链产物：讲解稿指向个人笔记——只出链
    const p = await writeOutputArtifact(engine.paths, {
      kind: '错误卡',
      file: 'q1.md',
      fm: { kind: 'error_card', created: '2026-09-09' },
      body: `错因：坐标转换漏了尺度。\n\n出处：${obsidianLink('读书笔记/吉他.md')}`,
    }, nodeVaultFs)
    assert.match(await readFile(p, 'utf8'), /\[\[读书笔记\/吉他\]\]/)
    // 把带出链的产物注册为复习源（豁免区）→ 用户笔记依旧零改动
    await engine.channels.noteSourceRegister(p.replace(/\\/g, '/').slice(root.length + 1))
    const after = await snapshot(root, ['读书笔记/吉他.md'])
    assert.deepEqual([...before.entries()], [...after.entries()])
  })
})

test('#113 引擎写注册豁免区文件后刷新指纹：自己的写不算漂移，外部手改才算', async () => {
  await withVault({ registry: null, graph: null }, async ({ engine }) => {
    // 先落一条项目日志并注册，再经引擎追加——引擎写后应保持 ok 而非 drifted
    await engine.projectCreate({ name: '吉他翻新', goal: '半年内能完整弹一首曲子' })
    await engine.projectLogAppend('吉他翻新', '今天换了琴弦，手感好多了。')
    const logPath = engine.paths.projectLogPath('吉他翻新')
    await engine.channels.noteSourceRegister(logPath.replace(/\\/g, '/'))
    await engine.projectLogAppend('吉他翻新', '第二天：练了 F 和弦转换。')
    let list = await engine.channels.noteSourceList()
    assert.equal(list.sources[0].status, 'ok', '引擎自己的日志追加不算内容漂移')
    // 用户在引擎之外手改 → 漂移如实报出（可重出/归档）
    const { writeFile } = await import('node:fs/promises')
    await writeFile(logPath, (await readFile(logPath, 'utf8')) + '手改的一行\n', 'utf8')
    list = await engine.channels.noteSourceList()
    assert.equal(list.sources[0].status, 'drifted')
  })
})
