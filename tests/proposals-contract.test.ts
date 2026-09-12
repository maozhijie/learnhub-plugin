/**
 * 提案注册表契约（#193 / ADR-0053）：store.loadProposals 逐条最小形状契约（id 正整数、
 * status 三值、artifact 非空、pair 存在性）+ Data Check proposals area + 复诊盘点去静默
 * + 提案出生即完整（空 artifact 两段窗口关闭）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataCheckReport } from '../src/engine/data-check.ts'
import { withVault } from './helpers/vault.ts'

const PROPOSALS = join('学习中心', 'state', 'proposals.json')

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1, kind: 'edit', course: '数学', status: 'pending', summary: '',
  artifact: 'x.yaml', created: '2026-09-12T10:00:00+08:00', decided: null, decision_note: '',
  ...over,
})

function byReason(report: DataCheckReport): Map<string, number> {
  const out = new Map<string, number>()
  for (const f of report.findings) out.set(f.reason, (out.get(f.reason) ?? 0) + 1)
  return out
}

test('loadProposals：Missing 合法空态；四种损坏形态各自抛 Broken 且带路径与条目位置', async () => {
  await withVault({}, async ({ engine, root }) => {
    const p = join(root, PROPOSALS)
    assert.deepEqual(await engine.store.loadProposals(), [], '文件缺失 = Missing 合法空态')

    await writeFile(p, '{oops', 'utf8')
    await assert.rejects(() => engine.store.loadProposals(),
      /\[proposals\] .+proposals\.json 不是合法 JSON（Broken）：修复或删除该文件后再试。/)

    await writeFile(p, '{"id":1}', 'utf8')
    await assert.rejects(() => engine.store.loadProposals(), /不是清单数组（Broken）/)

    await writeFile(p, JSON.stringify([rec({ status: 'appling' })]), 'utf8')
    await assert.rejects(() => engine.store.loadProposals(),
      /第 0 条不满足提案契约（Broken：status 必须是 pending\/applied\/rejected（收到 "appling"））/)

    await writeFile(p, JSON.stringify([rec({ artifact: '' })]), 'utf8')
    await assert.rejects(() => engine.store.loadProposals(), /第 0 条.*artifact 必须是非空字符串/)

    await writeFile(p, JSON.stringify([rec({ id: 0 })]), 'utf8')
    await assert.rejects(() => engine.store.loadProposals(), /第 0 条.*id 必须是正整数/)

    await writeFile(p, JSON.stringify([rec({ pair: 9 })]), 'utf8')
    await assert.rejects(() => engine.store.loadProposals(),
      /第 0 条 pair 悬空（Broken：声明的联动提案 #9 不在清单中）：修复或删除该条目后再试。/)
  })
})

test('Data Check proposals area：损坏形态逐条报 broken（可定位），损坏不阻断其余条目盘点', async () => {
  await withVault({}, async ({ engine, root }) => {
    const p = join(root, PROPOSALS)

    await writeFile(p, '{oops', 'utf8')
    assert.equal(byReason(await engine.dataCheck()).get('proposals_json_parse'), 1)

    await writeFile(p, '42', 'utf8')
    assert.equal(byReason(await engine.dataCheck()).get('proposals_schema'), 1)

    await writeFile(p, JSON.stringify([
      rec({ status: 'appling', artifact: join(root, '学习中心', 'state', 'learnhub.json') }),
      rec({ id: 2, artifact: join(root, '学习中心', 'state', 'learnhub.json'), pair: 99 }),
      rec({ id: 3, artifact: join(root, '学习中心', 'state', '不存在的产物.yaml') }),
    ]), 'utf8')
    const report = await engine.dataCheck()
    const reasons = byReason(report)
    assert.equal(reasons.get('proposals_schema'), 1, '字段违约逐条定位（第 0 条）')
    assert.equal(reasons.get('proposals_pair_dangling'), 1, 'pair 悬空定位（提案 #2）')
    assert.equal(reasons.get('proposals_artifact_missing'), 1, '悬空 artifact：propose 落盘后产物被手工挪走/删除的场景')
    assert.equal(report.status, 'broken')
    assert.deepEqual(report.byArea.proposals, { missing: 0, broken: 3, archived: 0, hint: 0 })
  })
})

test('proposals Broken 时复诊盘点出 finding 而非静默（#193 悬空注释兑现）', async () => {
  await withVault({
    files: [{ path: join('学习中心', 'math', 'state', '边实验.jsonl'), content: '{"node":"入门","pre":[],"proposal":1,"due":5}\n' }],
  }, async ({ engine, root }) => {
    await writeFile(join(root, PROPOSALS), '{broken', 'utf8')
    const report = await engine.dataCheck()
    assert.equal(byReason(report).get('proposals_json_parse'), 1, '提案损坏显式浮出（旧实现 overdue 静默）')
    assert.equal(report.inventory.probationLedgers.present, 1, '账本盘点照常')
    assert.equal(report.inventory.probationLedgers.overdue, 0, '登记日无从对账 → overdue 不判（损坏已在 proposals area 报出）')
  })
})

test('提案出生即完整：构造器形态 createProposal 落盘可读回（两段窗口关闭，#193）', async () => {
  await withVault({}, async ({ engine }) => {
    const pid = await engine.store.createProposal('edit', '数学', '测试提案',
      id => engine.paths.proposalArtifactPath(id, 'edit', '数学'))
    const list = await engine.store.loadProposals()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.id, pid)
    assert.equal(list[0]!.status, 'pending')
    assert.ok(list[0]!.artifact.endsWith(`${pid}-edit-数学.yaml`), 'artifact 出生即带路径')
    // 正常读写面零行为变更：takePending 语义照旧
    const prop = await engine.store.takePending('edit')
    assert.equal(prop.id, pid)
  })
})
