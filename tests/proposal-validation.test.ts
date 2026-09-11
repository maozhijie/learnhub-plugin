import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEditProposal } from '../src/engine/proposals.ts'
import { GROWTH_OPERATORS } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'
import { YAML } from '../src/engine/yaml.ts'

test('未知提案 kind：受理门统一拒收且不落提案', async () => {
  await withVault({ registry: null, graph: null, tag: 'learnhub-unknown-kind-' }, async ({ engine }) => {
    await assert.rejects(
      engine.graph.graphPropose('skeleton' as never, 'course: 校验课\nops: []\n'),
      /非法 kind/,
    )
    await assert.rejects(
      engine.graph.graphApply('skeleton' as never),
      /非法 kind/,
    )
    assert.deepEqual(await engine.store.loadProposals(), [])
  })
})

test('键名统一到 name（#140）：add_node 用 name，旧 node 键拒收并给可执行提示', async () => {
  await withVault({ registry: null, graph: null, tag: 'learnhub-key-unify-' }, async ({ engine }) => {
    // schema v2 键名统一：add_node 与图 YAML 同用 name，旧双键退役、不做兼容双读（#131 §7）
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
      engine.graph.graphPropose('edit', wrongEditKey),
      /op=add_node 不接受 node 键（键名已统一到 name/,
    )
    // 非 add_node 的 op 用 node 引用既有节点；误写 name 一律 fail loud（不容双写）
    const misplacedName = `course: 校验课
ops:
  - op: del_node
    name: 前置技能
`
    await assert.rejects(
      engine.graph.graphPropose('edit', misplacedName),
      /op=del_node 不接受 name 键（name 只用于 add_node 定义新节点/,
    )
  })
})

// ---- 生长批裁决产物面（#145）：note 区 / route / 零操作 / 边轻键 ----

test('#145 note 区严格 schema：恰 {operator, reason, disagreement?}，算子枚举锁死', () => {
  const base = (note: string): string => `course: 校验课\n${note}ops:\n  - op: add_node\n    name: 新节点\n    region: 基础区\n    block: 入门\n    pre: []\n`
  // 非法算子 / 缺理由 / 未知字段 / disagreement 空声明
  const badOperator = validateEditProposal(YAML.parse(base('note:\n  operator: 冲刺\n  reason: 理由\n')))
  assert.ok(badOperator.errors!.some(e => e.includes('note.operator: 非法算子') && e.includes(GROWTH_OPERATORS.join('/'))))
  const noReason = validateEditProposal(YAML.parse(base('note:\n  operator: 前进\n')))
  assert.ok(noReason.errors!.some(e => e.includes('note.reason 不能为空')))
  const unknownKey = validateEditProposal(YAML.parse(base('note:\n  operator: 前进\n  reason: 理由\n  mode: auto\n')))
  assert.ok(unknownKey.errors!.some(e => e.includes('note 含未知字段') && e.includes('operator/reason/disagreement')))
  const emptyDisagreement = validateEditProposal(YAML.parse(base('note:\n  operator: 前进\n  reason: 理由\n  disagreement: "  "\n')))
  assert.ok(emptyDisagreement.errors!.some(e => e.includes('note.disagreement')))

  // 合法形态：disagreement 解析进 spec（trim 后），缺席 = undefined
  const ok = validateEditProposal(YAML.parse(base('note:\n  operator: 旁支\n  reason: 教学消费支线\n  disagreement: 与批注指向有分歧\n')))
  assert.equal(ok.errors, undefined)
  assert.deepEqual(ok.spec!.note, { operator: '旁支', reason: '教学消费支线', disagreement: '与批注指向有分歧' })
  const plain = validateEditProposal(YAML.parse(base('')))
  assert.equal(plain.errors, undefined)
  assert.equal(plain.spec!.note, undefined, '普通提案无 note 区')
})

test('#145 零操作：生长批（note 在场）ops 空列表合法；普通提案与 ops 缺失照旧拒收', () => {
  const note = 'note:\n  operator: 前进\n  reason: 结构已足，等内容跟上\n'
  const zeroOps = validateEditProposal(YAML.parse(`course: 校验课\n${note}ops: []\n`))
  assert.equal(zeroOps.errors, undefined)
  assert.deepEqual(zeroOps.spec!.ops, [])
  // ops 键缺席 + note 在场 = 同零操作语义
  const absentOps = validateEditProposal(YAML.parse(`course: 校验课\n${note}`))
  assert.equal(absentOps.errors, undefined)
  assert.deepEqual(absentOps.spec!.ops, [])
  // 普通提案空列表/缺失照旧拒收
  const plainEmpty = validateEditProposal(YAML.parse('course: 校验课\nops: []\n'))
  assert.ok(plainEmpty.errors!.some(e => e.includes('ops: 提案没有操作条目')))
  const plainAbsent = validateEditProposal(YAML.parse('course: 校验课\n'))
  assert.ok(plainAbsent.errors!.some(e => e.startsWith('ops: 必须是列表')))
})

test('#145 route：唯一写权属生长批——普通提案携带拒收；生长批合法携带', () => {
  const routeBody = 'route: |\n  - **阶段一**：朝终点推进。\n'
  const plainWithRoute = validateEditProposal(YAML.parse(`course: 校验课\n${routeBody}ops:\n  - op: add_node\n    name: 新节点\n    region: 基础区\n    block: 入门\n    pre: []\n`))
  assert.ok(plainWithRoute.errors!.some(e => e.includes('route: 普通 edit 提案不得携带')))
  const growthWithRoute = validateEditProposal(YAML.parse(`course: 校验课\nnote:\n  operator: 前进\n  reason: 理由\n${routeBody}ops:\n  - op: add_node\n    name: 新节点\n    region: 基础区\n    block: 入门\n    pre: []\n`))
  assert.equal(growthWithRoute.errors, undefined)
  assert.ok(growthWithRoute.spec!.route!.includes('阶段一'))
  const emptyRoute = validateEditProposal(YAML.parse('course: 校验课\nnote:\n  operator: 前进\n  reason: 理由\nroute: "  "\nops:\n  - op: add_node\n    name: 新节点\n    region: 基础区\n    block: 入门\n    pre: []\n'))
  assert.ok(emptyRoute.errors!.some(e => e.includes('route: 必须是非空字符串')))
})

test('#127 边轻纪律在提案侧：op 携带 origin/status/probation 一律拒收（不走复诊的结构保证）', () => {
  for (const key of ['origin', 'status', 'probation']) {
    const yaml = `course: 校验课
ops:
  - op: add_node
    name: 插入节点
    region: 基础区
    block: 入门
    pre: []
    ${key}: 10
`
    const v = validateEditProposal(YAML.parse(yaml))
    assert.ok(v.errors!.some(e => e.includes(`不接受边元数据字段`) && e.includes(`"${key}"`)), `键 ${key} 应被拒收`)
  }
})

test('#145 巩固门受理路径：巩固批引未教概念拒收、引已教概念通过（走引擎全门）', async () => {
  await withVault({ registry: null, graph: null, tag: 'learnhub-consolidate-' }, async ({ engine }) => {
    const seed = `course: 校验课
mode: new
concepts:
  - canonical: 变化率
endpoint:
  name: 综合应用
  region: 基础区
  block: 终点块
starts:
  - name: 入门
    region: 基础区
    block: 入门
    teaches: {变化率: 会用}
`
    const seeded = await engine.graph.graphPropose('seed', seed) as { id: number }
    await engine.graph.graphApply('seed', seeded.id)
    const consolidate = (teaches: string, extraConcepts = ''): string => `course: 校验课
note:
  operator: 巩固
  reason: 收束已学
ops:
  - op: add_node
    name: 综合收束
    region: 基础区
    block: 入门
    pre: [入门]
    teaches: {${teaches}}
${extraConcepts}`
    await assert.rejects(
      () => engine.graph.graphPropose('edit', consolidate('极限: 知道', 'concepts:\n  - canonical: 极限\n')),
      /巩固门|只引已教概念/,
      '随批铸名 ≠ 已教——巩固节点引新概念拒收',
    )
    const ok = await engine.graph.graphPropose('edit', consolidate('变化率: 会用')) as { id: number; operator?: string }
    assert.equal(ok.operator, '巩固')
    // 边轻键在引擎全门同样拒收（受理与 schema 一致）
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 校验课
ops:
  - op: set_pre
    node: 入门
    pre: [入门]
    probation: 10
`), /不接受边元数据字段/)
  })
})
