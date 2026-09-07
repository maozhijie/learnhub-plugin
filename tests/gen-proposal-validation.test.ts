import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { GraphStore } from '../src/engine/graph.ts'

const validProposal = `course: 校验课
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
            note: 入口说明
            est: 25.4
            type: practice
            bloom: 记忆
            difficulty: 1
          - name: 主技能
            pre: [前置技能]
            opt: true
            note: 目标说明
            enc:
              - node: 前置技能
                w: 0.8
                note: 强依赖
            est: 40
            type: practice
            bloom: 应用
            difficulty: 3
`

test('gen 提案按持久图 schema 逐节点拒绝无效字段，且不受理提案', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'learnhub-gen-invalid-'))
  try {
    const engine = new LearnhubEngine({ vault })
    const yaml = `course: 校验课
mode: new
regions:
  - region: 基础区
    blocks:
      - name: 入门
        nodes:
          - name: 未知字段节点
            hidden: true
          - pre: [不是字符串列表]
          - name: 空前置类型节点
            pre: {}
          - name: 坏可选节点
            opt: "yes"
          - name: 坏说明节点
            note: 12
          - name: 坏成分节点
            enc: 7
          - name: 坏边节点
            enc:
              - node: 目标
                w: 1.2
          - name: 边说明节点
            enc:
              - node: 目标
                note: 0.8
          - name: 边未知字段节点
            enc:
              - node: 目标
                weight: 0.5
          - name: 非正时长节点
            est: 0
          - name: 坏类型节点
            type: quiz
          - name: 坏认知节点
            bloom: 掌握
          - name: 坏难度节点
            difficulty: 6
`
    await assert.rejects(
      engine.graphPropose('gen', yaml),
      error => {
        const message = (error as Error).message
        const expected = [
          'regions.0.blocks.0.nodes.0 含未知字段',
          'nodes.1 节点 name 缺失或为空',
          'nodes.2[空前置类型节点] pre 必须是字符串列表',
          'nodes.3[坏可选节点] opt 必须是布尔值',
          'nodes.4[坏说明节点] note 必须是字符串',
          'nodes.5[坏成分节点] enc 必须是列表',
          'nodes.6[坏边节点] enc 权重 w 必须是 0–1 的数',
          'nodes.7[边说明节点] enc note 必须是字符串',
          'nodes.8[边未知字段节点] enc 条目含未知字段',
          'nodes.9[非正时长节点] est 必须是正数（分钟）',
          'nodes.10[坏类型节点] type 只允许 practice',
          'nodes.11[坏认知节点] bloom 非法',
          'nodes.12[坏难度节点] difficulty 必须是 1-5',
        ]
        for (const part of expected) assert.ok(message.includes(part), `${message}\n缺少：${part}`)
        return true
      },
    )
    assert.deepEqual(await engine.store.loadProposals(), [])
  } finally {
    await rm(vault, { recursive: true, force: true })
  }
})

test('gen 提案保留可选图维度，受理后与持久图解析一致', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'learnhub-gen-valid-'))
  try {
    const engine = new LearnhubEngine({ vault })
    const proposed = await engine.graphPropose('gen', validProposal) as { id: number; nodes: number }
    assert.equal(proposed.nodes, 2)

    const applied = await engine.graphApply('gen', proposed.id) as { nodes: number }
    assert.equal(applied.nodes, 2)

    const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('校验课')).load()
    assert.equal(regions[0]!.name, '基础区')
    assert.equal(regions[0]!.color, '#1f6f8b')
    const nodes = regions[0]!.blocks[0]!.nodes
    assert.deepEqual(nodes.map(n => n.name), ['前置技能', '主技能'])
    assert.equal(nodes[0]!.est, 25)
    assert.equal(nodes[0]!.type, 'practice')
    assert.equal(nodes[0]!.bloom, '记忆')
    assert.equal(nodes[0]!.difficulty, 1)
    assert.equal(nodes[1]!.opt, true)
    assert.deepEqual(nodes[1]!.pre, ['前置技能'])
    assert.deepEqual(nodes[1]!.enc, [{ node: '前置技能', w: 0.8, note: '强依赖' }])
    assert.equal(nodes[1]!.bloom, '应用')
    assert.equal(nodes[1]!.difficulty, 3)
  } finally {
    await rm(vault, { recursive: true, force: true })
  }
})

test('gen 与 edit 的目标键名区分保持不变', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'learnhub-gen-keys-'))
  try {
    const engine = new LearnhubEngine({ vault })
    const gen = await engine.graphPropose('gen', validProposal) as { id: number }
    await engine.graphApply('gen', gen.id)

    // gen 节点用 name；edit add_node 刻意用 node。前者已验证，这里锁定后者不被顺手“统一”。
    const wrongEditKey = `course: 校验课
ops:
  - op: add_node
    name: 追加技能
    region: 基础区
    block: 入门
    pre: [前置技能]
    est: 10
`
    await assert.rejects(
      engine.graphPropose('edit', wrongEditKey),
      /add_node 的节点字段名是 node，不是 name/,
    )
  } finally {
    await rm(vault, { recursive: true, force: true })
  }
})
