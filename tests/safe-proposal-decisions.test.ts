import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { GraphStore } from '../src/engine/graph.ts'

const validGen = `course: 校验课
mode: new
regions:
  - region: 基础区
    color: "#1f6f8b"
    blocks:
      - name: 入门
        nodes:
          - name: 前置技能
            pre: []
            opt: false
            note: ""
            est: 20
          - name: 主技能
            pre: [前置技能]
            opt: false
            note: ""
            est: 30
`

async function vaultWithCourse(run: (engine: LearnhubEngine, courseName: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-proposals-'))
  try {
    const engine = new LearnhubEngine({ vault: root })
    const proposed = await engine.graphPropose('gen', validGen) as { id: number }
    await engine.graphApply('gen', proposed.id)
    await run(engine, '校验课')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('#11 explicit proposal ids must be positive integers; 0/negative/fraction/NaN fail', async () => {
  await vaultWithCourse(async (engine) => {
    await engine.graphPropose('gen', `course: 校验课
mode: append
regions:
  - region: 基础区
    blocks:
      - name: 入门
        nodes:
          - { name: 预备主技能, pre: [前置技能], est: 10 }
`)
    const invalidIds: number[] = [0, -1, 2.5, Number.NaN]
    for (const id of invalidIds) {
      await assert.rejects(() => engine.graphApply('gen', id), /提案 id 必须是正整数/, `id=${id}`)
    }
    const pending = await engine.graphProposals('pending', 'gen')
    assert.equal(pending.length, 1, 'failed explicit-id attempts must not consume the proposal')
    const applied = await engine.graphApply('gen') as { created_blocks: string[] }
    assert.ok(Array.isArray(applied.created_blocks))
  })
})

test('#11 rejection always requires a valid explicit id', async () => {
  await vaultWithCourse(async engine => {
    const prop = await engine.graphPropose('edit', `course: 校验课
ops:
  - { op: set_note, node: 主技能, note: 待拒绝修订 }
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
      () => engine.graphPropose('edit', `course: 校验课
ops:
  - { op: move, node: 主技能, region: 基础区, block: 不存在的块 }
`),
      /move 目标块不存在（不允许静默建块）/,
    )
    const pending = await engine.graphProposals('pending', 'edit')
    assert.equal(pending.length, 0)
  })
})

test('#11 add_node may create a block and apply reports created_blocks; later move into it succeeds', async () => {
  await vaultWithCourse(async engine => {
    const add = await engine.graphPropose('edit', `course: 校验课
ops:
  - { op: add_node, node: 新块起点, region: 基础区, block: 新块, pre: [前置技能], est: 15 }
`) as { id: number }
    const applied = await engine.graphApply('edit', add.id) as { created_blocks: string[] }
    assert.deepEqual(applied.created_blocks, ['新块'])

    const move = await engine.graphPropose('edit', `course: 校验课
ops:
  - { op: move, node: 主技能, region: 基础区, block: 新块 }
`) as { id: number }
    const moved = await engine.graphApply('edit', move.id) as { created_blocks: string[] }
    assert.deepEqual(moved.created_blocks, [], 'move must not create blocks')

    const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('校验课')).load()
    const newBlock = regions[0]!.blocks.find(b => b.name === '新块')
    assert.ok(newBlock)
    assert.deepEqual(newBlock!.nodes.map(n => n.name).sort(), ['主技能', '新块起点'])
  })
})

test('#11 apply result on gen mode lists created blocks explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-proposals-gen-'))
  try {
    const engine = new LearnhubEngine({ vault: root })
    const prop = await engine.graphPropose('gen', validGen) as { id: number }
    const applied = await engine.graphApply('gen', prop.id) as { created_blocks: string[] }
    assert.deepEqual(applied.created_blocks, ['入门'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
