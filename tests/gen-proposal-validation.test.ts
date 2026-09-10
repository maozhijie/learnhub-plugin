import test from 'node:test'
import assert from 'node:assert/strict'
import { validateGenProposal, specToRegions } from '../src/engine/gengraph.ts'
import { withVault } from './helpers/vault.ts'
import { YAML } from '../src/engine/yaml.ts'

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

test('kind=gen 已退役：受理门拒收且不落提案（#138）', async () => {
  await withVault({ registry: null, graph: null, tag: 'learnhub-gen-retired-' }, async ({ engine }) => {
    await assert.rejects(
      engine.graphPropose('gen', validProposal),
      /kind=gen 骨架提案已退役/,
    )
    await assert.rejects(
      engine.graphApply('gen'),
      /kind=gen 骨架提案已退役/,
    )
    assert.deepEqual(await engine.store.loadProposals(), [])
  })
})

test('gen 提案形态门（反编译子图半区复用）按持久图 schema 逐节点拒绝无效字段', async () => {
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
  const v = validateGenProposal(YAML.parse(yaml))
  assert.ok(v.errors, '必须给出错误清单')
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
  for (const part of expected) {
    assert.ok(v.errors.some(e => e.includes(part)), `${v.errors.join('\n')}\n缺少：${part}`)
  }
})

test('gen 形态门保留可选图维度，spec 与持久图解析一致', async () => {
  const v = validateGenProposal(YAML.parse(validProposal))
  assert.equal(v.errors, undefined)
  const regions = specToRegions(v.spec!.regions)
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
})

test('键名统一到 name（#140）：add_node 用 name，旧 node 键拒收并给可执行提示', async () => {
  await withVault({ registry: null, graph: null, tag: 'learnhub-key-unify-' }, async ({ engine }) => {
    // schema v2 键名统一：add_node 与图 YAML/gen 节点同用 name，旧双键退役、不做兼容双读（#131 §7）
    const wrongEditKey = `course: 校验课
ops:
  - op: add_node
    node: 追加技能
    region: 基础区
    block: 入门
    pre: [前置技能]
    est: 10
`
    await assert.rejects(
      engine.graphPropose('edit', wrongEditKey),
      /op=add_node 不接受 node 键（键名已统一到 name/,
    )
    // 非 add_node 的 op 用 node 引用既有节点；误写 name 一律 fail loud（不容双写）
    const misplacedName = `course: 校验课
ops:
  - op: del_node
    name: 前置技能
`
    await assert.rejects(
      engine.graphPropose('edit', misplacedName),
      /op=del_node 不接受 name 键（name 只用于 add_node 定义新节点/,
    )
  })
})
