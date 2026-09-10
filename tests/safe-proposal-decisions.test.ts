import test from 'node:test'
import assert from 'node:assert/strict'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { GraphStore } from '../src/engine/graph.ts'
import { withVault } from './helpers/vault.ts'

/** 工厂基线课程（数学 / 基础区 / 入门块 / 入门节点）上做提案决策测试；gen 建课路径
 * 已随 #138 cutover 退役，测试不再经由它搭课程。 */
async function vaultWithCourse(run: (engine: LearnhubEngine, courseName: string) => Promise<void>): Promise<void> {
  await withVault({ tag: 'learnhub-proposals-' }, async ({ engine }) => {
    await run(engine, '数学')
  })
}

test('#11 explicit proposal ids must be positive integers; 0/negative/fraction/NaN fail', async () => {
  await vaultWithCourse(async (engine) => {
    await engine.graphPropose('edit', `course: 数学
ops:
  - { op: set_note, node: 入门, note: id 校验用修订 }
`)
    const invalidIds: number[] = [0, -1, 2.5, Number.NaN]
    for (const id of invalidIds) {
      await assert.rejects(() => engine.graphApply('edit', id), /提案 id 必须是正整数/, `id=${id}`)
    }
    const pending = await engine.graphProposals('pending', 'edit')
    assert.equal(pending.length, 1, 'failed explicit-id attempts must not consume the proposal')
    const applied = await engine.graphApply('edit') as { created_blocks: string[] }
    assert.ok(Array.isArray(applied.created_blocks))
  })
})

test('#11 rejection always requires a valid explicit id', async () => {
  await vaultWithCourse(async engine => {
    const prop = await engine.graphPropose('edit', `course: 数学
ops:
  - { op: set_note, node: 入门, note: 待拒绝修订 }
`) as { id: number }
    await assert.rejects(() => engine.graphReject(0), /必须.*正整数/)
    await assert.rejects(() => engine.graphReject(-2), /必须.*正整数/)
    await engine.graphReject(prop.id)
    const rejected = await engine.graphProposals('rejected', 'edit')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0]!.id, prop.id)
  })
})

test('#11 move to a nonexistent block fails at proposal validation', async () => {
  await vaultWithCourse(async engine => {
    await assert.rejects(
      () => engine.graphPropose('edit', `course: 数学
ops:
  - { op: move, node: 入门, region: 基础, block: 不存在的块 }
`),
      /move 目标块不存在（不允许静默建块）/,
    )
    const pending = await engine.graphProposals('pending', 'edit')
    assert.equal(pending.length, 0)
  })
})

test('#11 add_node may create a block and apply reports created_blocks; later move into it succeeds', async () => {
  await vaultWithCourse(async engine => {
    const add = await engine.graphPropose('edit', `course: 数学
ops:
  - { op: add_node, node: 新块起点, region: 基础, block: 新块, pre: [入门], est: 15 }
`) as { id: number }
    const applied = await engine.graphApply('edit', add.id) as { created_blocks: string[] }
    assert.deepEqual(applied.created_blocks, ['新块'])

    const move = await engine.graphPropose('edit', `course: 数学
ops:
  - { op: move, node: 入门, region: 基础, block: 新块 }
`) as { id: number }
    const moved = await engine.graphApply('edit', move.id) as { created_blocks: string[] }
    assert.deepEqual(moved.created_blocks, [], 'move must not create blocks')

    const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('math')).load()
    const newBlock = regions[0]!.blocks.find(b => b.name === '新块')
    assert.ok(newBlock)
    assert.deepEqual(newBlock!.nodes.map(n => n.name).sort(), ['入门', '新块起点'])
  })
})

test('#11 存量 pending gen 提案：apply 被退役门拒收，reject 留痕仍可用', async () => {
  await vaultWithCourse(async engine => {
    // 直接在提案流水里种一条 v1 时代的 pending gen 记录（cutover 后不再产生新的）
    const legacy = await engine.store.createProposal('gen' as never, '数学', 'v1 遗留骨架提案', 'state/proposals/legacy.yaml')
    await assert.rejects(() => engine.graphApply('gen', legacy), /kind=gen 骨架提案已退役/)
    await engine.graphReject(legacy, 'cutover 后拒绝留痕')
    const rejected = await engine.graphProposals('rejected')
    assert.ok(rejected.some(p => p.id === legacy && (p as { kind?: string }).kind === 'gen'))
  })
})
