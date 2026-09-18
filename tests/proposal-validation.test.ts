import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEditProposal } from '../src/engine/coach/proposals.ts'
import { GROWTH_OPERATORS } from '../src/engine/types.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse } from './helpers/drafted.ts'
import { YAML } from '../src/engine/infra/yaml.ts'

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

test('#145 note 区严格 schema（#327 逐条目化后）：恰 {reason, target_endpoints?, disagreement?}，算子随条目走', () => {
  const base = (note: string, ops: string): string => `course: 校验课\n${note}ops:\n${ops}`
  const addNode = '  - op: add_node\n    name: 新节点\n    pre: []\n'
  // note.operator / note.recheck 退役：写了按未知键点名（指路逐条目写法）
  const badOperator = validateEditProposal(YAML.parse(base('note:\n  operator: 冲刺\n  reason: 理由\n', addNode)))
  assert.ok(badOperator.errors!.some(e => e.includes('note 含未知字段') && e.includes('"operator"') && e.includes(GROWTH_OPERATORS.join('/'))))
  const noReasonDoc = validateEditProposal(YAML.parse(base('note:\n  disagreement: 与批注有分歧\n', addNode)))
  assert.ok(noReasonDoc.errors!.some(e => e.includes('note.reason 不能为空')))
  const unknownKey = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n  mode: auto\n', addNode)))
  assert.ok(unknownKey.errors!.some(e => e.includes('note 含未知字段') && e.includes('reason/target_endpoints/disagreement')), 'mode 键退役；operator/recheck 指路到 add_node 条目（#327）')

  // 朝向声明（ADR-0076）：schema 门只看列表形态；跨字段规则在受理门 endpointGuardErrors
  const emptyTargets = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n  target_endpoints: []\n', addNode)))
  assert.ok(emptyTargets.errors!.some(e => e.includes('note.target_endpoints: 必须是非空字符串列表')))
  const nonStringTargets = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n  target_endpoints: [终点甲, 3]\n', addNode)))
  assert.ok(nonStringTargets.errors!.some(e => e.includes('note.target_endpoints: 必须是非空字符串列表')))
  const emptyDisagreement = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n  disagreement: "  "\n', addNode)))
  assert.ok(emptyDisagreement.errors!.some(e => e.includes('note.disagreement')))

  // 逐条目算子（#327）：非法取值拒收；生长批 add_node 缺 operator 拒收；普通提案带 operator 拒收
  const badOpOperator = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n', '  - op: add_node\n    name: 新节点\n    pre: []\n    operator: 冲刺\n')))
  assert.ok(badOpOperator.errors!.some(e => e.includes('ops.0.operator: 非法算子') && e.includes(GROWTH_OPERATORS.join('/'))))
  const missingOperator = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n', addNode)))
  assert.ok(missingOperator.errors!.some(e => e.includes('ops.0: 生长批的 add_node 必须声明算子 operator')))
  const plainWithOperator = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - op: add_node\n    name: 新节点\n    pre: []\n    operator: 新增\n'))
  assert.ok(plainWithOperator.errors!.some(e => e.includes('operator/recheck/consolidate 只随生长批的 add_node 携带')))
  const opOnNonAdd = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n', '  - op: set_pre\n    node: 台阶\n    pre: []\n    operator: 新增\n')))
  assert.ok(opOnNonAdd.errors!.some(e => e.includes('ops.0: operator/recheck/consolidate 只随 add_node 携带')))

  // 合法形态：note 不再有 operator；disagreement 解析进 spec（trim 后）
  const ok = validateEditProposal(YAML.parse(base('note:\n  reason: 教学消费支线\n  disagreement: 与批注指向有分歧\n  target_endpoints: [新节点]\n', '  - op: add_node\n    name: 新节点\n    pre: []\n    operator: 新增\n')))
  assert.equal(ok.errors, undefined)
  assert.deepEqual(ok.spec!.note, { reason: '教学消费支线', disagreement: '与批注指向有分歧', target_endpoints: ['新节点'] })
  const targeted = validateEditProposal(YAML.parse(base('note:\n  reason: 理由\n  target_endpoints: [终点甲, 终点乙]\n', '  - op: add_node\n    name: 新节点\n    pre: []\n    operator: 新增\n')))
  assert.equal(targeted.errors, undefined)
  assert.deepEqual(targeted.spec!.note!.target_endpoints, ['终点甲', '终点乙'], '朝向声明解析进 spec（trim 后）')
  const plain = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - op: add_node\n    name: 新节点\n    pre: []\n'))
  assert.equal(plain.errors, undefined)
  assert.equal(plain.spec!.note, undefined, '普通提案无 note 区')
})

test('#145 零操作：生长批（note 在场）ops 空列表合法；普通提案与 ops 缺失照旧拒收', () => {
  const note = 'note:\n  reason: 结构已足，等内容跟上\n'
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

test('#316 / ADR-0099 route 退役：提案携带即拒收（写权归罗盘站），专用文案点名退役', () => {
  const routeBody = 'route: |\n  - **阶段一**：推进广度。\n'
  const plainWithRoute = validateEditProposal(YAML.parse(`course: 校验课\n${routeBody}ops:\n  - op: add_node\n    name: 新节点\n    pre: []\n`))
  assert.ok(plainWithRoute.errors!.some(e => e.includes('route: 已退役') && e.includes('learnhub_compass_paint')))
  // 生长批同理：写权反转后 note 区也不再豁免 route
  const growthWithRoute = validateEditProposal(YAML.parse(`course: 校验课\nnote:\n  reason: 理由\n${routeBody}ops:\n  - op: add_node\n    name: 新节点\n    pre: []\n    operator: 新增\n`))
  assert.ok(growthWithRoute.errors!.some(e => e.includes('route: 已退役')))
})

test('#127 边轻纪律在提案侧：op 携带 origin/status/probation 一律拒收（不走复诊的结构保证）', () => {
  for (const key of ['origin', 'status', 'probation']) {
    const yaml = `course: 校验课
ops:
  - op: add_node
    name: 插入节点
    pre: []
    ${key}: 10
`
    const v = validateEditProposal(YAML.parse(yaml))
    assert.ok(v.errors!.some(e => e.includes(`不接受这些字段`) && e.includes(`"${key}"`)), `键 ${key} 应被拒收`)
  }
})

test('#275 写侧词汇退场：add_node 无坐标通过；move/region/block 一律拒收', () => {
  // add_node 不再要求坐标：只写 name/pre 即过 schema 门
  const bare = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, pre: [] }\n'))
  assert.equal(bare.errors, undefined)
  assert.equal(bare.spec!.ops[0]!.op, 'add_node')
  // move 已退役：不在 op 白名单，fail loud 且列出可执行操作集
  const move = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: move, node: 入门, region: 基础, block: 块 }\n'))
  assert.ok(move.errors!.some(e => e.includes('非法操作 move') && e.includes('add_node/del_node/set_pre/set_enc/rename/set_note')))
  // 残留坐标键（region/block）一律拒收不静默丢弃
  const residue = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, region: 基础区, block: 入门, pre: [] }\n'))
  assert.ok(residue.errors!.some(e => e.includes('不接受坐标键') && e.includes('"region"') && e.includes('"block"')))
})

test('#145 收束门受理路径：收束批引未教概念拒收、引已教概念通过（走引擎全门）', async () => {
  await withVault({ registry: null, graph: null, tag: 'learnhub-consolidate-' }, async ({ engine }) => {
    // #256 种子通道退役：起草夹具直接落盘（概念「变化率」随批铸名，起点 teaches 引用）
    await draftCourse(engine, {
      course: '校验课',
      concepts: [{ canonical: '变化率' }],
      starts: [{ name: '入门', teaches: { 变化率: '会用' } }],
      endpoint: { name: '综合应用' },
    })
    const consolidate = (teaches: string, extraConcepts = ''): string => `course: 校验课
note:
  reason: 收束已学
  target_endpoints: [综合应用]
ops:
  - op: add_node
    name: 综合收束
    pre: [入门]
    operator: 新增
    consolidate: true
    teaches: {${teaches}}
  - op: set_pre
    node: 综合应用
    pre: [综合收束]
${extraConcepts}`
    await assert.rejects(
      () => engine.graph.graphPropose('edit', consolidate('极限: 知道', 'concepts:\n  - canonical: 极限\n')),
      /收束|只引已教概念/,
      '随批铸名 ≠ 已教——收束条目引新概念拒收',
    )
    const ok = await engine.graph.graphPropose('edit', consolidate('变化率: 会用')) as { id: number; operators?: string[] }
    assert.deepEqual(ok.operators, ['新增'])
    // 边轻键在引擎全门同样拒收（受理与 schema 一致）
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 校验课
ops:
  - op: set_pre
    node: 入门
    pre: [入门]
    probation: 10
`), /不接受这些字段/)
  })
})
