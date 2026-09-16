import test from 'node:test'
import assert from 'node:assert/strict'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { GraphStore } from '../src/engine/graph/graph.ts'
import { withVault } from './helpers/vault.ts'

/** 工厂基线课程（数学 / 入门节点，#284 后图 = 单文件 data/图.yaml）上做提案决策测试。 */
async function vaultWithCourse(run: (engine: LearnhubEngine, courseName: string) => Promise<void>): Promise<void> {
  await withVault({ tag: 'learnhub-proposals-' }, async ({ engine }) => {
    await run(engine, '数学')
  })
}

test('#11 explicit proposal ids must be positive integers; 0/negative/fraction/NaN fail', async () => {
  await vaultWithCourse(async (engine) => {
    await engine.graph.graphPropose('edit', `course: 数学
ops:
  - { op: set_note, node: 入门, note: id 校验用修订 }
`)
    const invalidIds: number[] = [0, -1, 2.5, Number.NaN]
    for (const id of invalidIds) {
      await assert.rejects(() => engine.graph.graphApply('edit', id), /提案 id 必须是正整数/, `id=${id}`)
    }
    const pending = await engine.graph.graphProposals('pending', 'edit')
    assert.equal(pending.length, 1, 'failed explicit-id attempts must not consume the proposal')
    const applied = await engine.graph.graphApply('edit') as { course: string; ops: number }
    assert.equal(applied.course, '数学')
    assert.equal(applied.ops, 1, '隐式 apply 恰好消化这一条 pending 提案（GraphApplyEditResult 无 created_blocks——建块产物已随 #284 退役）')
  })
})

test('#11 rejection always requires a valid explicit id', async () => {
  await vaultWithCourse(async engine => {
    const prop = await engine.graph.graphPropose('edit', `course: 数学
ops:
  - { op: set_note, node: 入门, note: 待拒绝修订 }
`) as { id: number }
    await assert.rejects(() => engine.graph.graphReject(0), /必须.*正整数/)
    await assert.rejects(() => engine.graph.graphReject(-2), /必须.*正整数/)
    await engine.graph.graphReject(prop.id)
    const rejected = await engine.graph.graphProposals('rejected', 'edit')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]!.id, prop.id)
  })
})

test('#11 move 已退役：op 白名单拒绝（#275 写侧词汇退场）', async () => {
  await vaultWithCourse(async engine => {
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
ops:
  - { op: move, node: 入门, region: 基础, block: 块 }
`),
      /非法操作 move/,
    )
    const pending = await engine.graph.graphProposals('pending', 'edit')
    assert.equal(pending.length, 0)
  })
})

test('#11 add_node 无坐标落图（直接进单文件节点列表）；零建块产物随 #284 退役', async () => {
  await vaultWithCourse(async engine => {
    const add = await engine.graph.graphPropose('edit', `course: 数学
ops:
  - { op: add_node, name: 新块起点, pre: [入门], est: 15 }
`) as { id: number }
    const applied = await engine.graph.graphApply('edit', add.id) as { ops: number }
    assert.equal(applied.ops, 1, 'add_node 直接入节点列表，不新建块（#275）')

    const nodes = await new GraphStore(engine.paths, engine.paths.courseRoot('math'), nodeVaultFs).load()
    const landed = nodes.find(n => n.name === '新块起点')
    assert.ok(landed, '新节点落到 data/图.yaml 的节点列表')
  })
})

test('#11 存量 pending 未知 kind 提案：apply 统一拒收，reject 留痕仍可用', async () => {
  await vaultWithCourse(async engine => {
    // 直接在提案流水里种一条旧时代的 pending 未知 kind 记录（现行引擎不再产生该形态）
    const legacy = await engine.store.createProposal('skeleton' as never, '数学', '遗留结构提案', 'state/proposals/legacy.yaml')
    await assert.rejects(() => engine.graph.graphApply('skeleton' as never, legacy), /非法 kind/)
    await engine.graph.graphReject(legacy, '旧记录拒绝留痕')
    const rejected = await engine.graph.graphProposals('rejected')
    assert.ok(rejected.some(p => p.id === legacy && (p as { kind?: string }).kind === 'skeleton'))
  })
})
