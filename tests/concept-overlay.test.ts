import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Graph, GraphStore, loadGraphDoc, parseNode, effectiveConceptFieldsOf, mergeTierMap, mergeNodeOverrides, SchemaError,
} from '../src/engine/graph/graph.ts'
import {
  validateEditProposal, teachesGateErrors, selfContradictionErrors, misconceptionGateErrors,
} from '../src/engine/coach/proposals.ts'
import type { EditOp } from '../src/engine/coach/proposals.ts'
import type { ConceptEntry } from '../src/engine/concepts/concepts.ts'
import { expandPatchOps, normalizePatchShape } from '../src/engine/coach/growth-draft.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { withVault } from './helpers/vault.ts'
import type { GNode, NodeOverrides } from '../src/engine/types.ts'

// 出生后概念打标修正通道（#299 / ADR-0106）：节点 overrides 覆盖键 + set_concepts op。
// 出生字段一字不动，读侧经 Graph 五访问器合并出有效值；门按合并后有效值判；两处旁路
// （misconceptionGateErrors / data-check）收编到同一合并出口；provenance 落 覆盖层.jsonl。

const node = (over: Partial<GNode> & { name: string }): GNode =>
  ({ name: over.name, pre: [], opt: false, note: '', enc: [], ...over })

const setConcepts = (overrides: NodeOverrides): EditOp => ({ op: 'set_concepts', node: '主技能', overrides })

test('parseOverrides：合法形态照抄；形态/取值域负路径可执行', () => {
  const ok = parseNode({
    name: 'N', pre: [], overrides: {
      teaches: { 甲: '会用', 乙: null },
      assumes: { 丙: '知道' },
      misconceptions: { 甲: [{ concept: '甲', model: '错法' }] },
    },
  }, 'data/x.yaml', '块')
  assert.deepEqual(ok.overrides, {
    teaches: { 甲: '会用', 乙: null },
    assumes: { 丙: '知道' },
    misconceptions: { 甲: [{ concept: '甲', model: '错法' }] },
  })
  const bad = (overrides: unknown, part: string): void => {
    assert.throws(
      () => parseNode({ name: 'N', pre: [], overrides }, 'data/x.yaml', '块'),
      (e: unknown) => {
        assert.ok(e instanceof SchemaError, '应为 SchemaError')
        assert.match((e as Error).message, new RegExp(part))
        return true
      },
    )
  }
  bad('x', 'overrides 必须是映射')
  bad({ badKey: 1 }, '含未知字段')
  bad({ teaches: { 甲: '精通' } }, '档位非法')
  bad({ teaches: { '  ': '知道' } }, '概念名不能为空')
  bad({ teaches: ['甲'] }, '必须是映射')
  bad({ misconceptions: { 甲: [{ concept: '乙', model: 'x' }] } }, '必须等于键名')
  bad({ misconceptions: { 甲: 'x' } }, '必须是条目列表 或 null')
  bad({ misconceptions: { 甲: [1, 2, 3, 4].map(i => ({ concept: '甲', model: `m${i}` })) } }, '封顶 3 条')
})

test('effectiveConceptFieldsOf：逐概念叠加、null 删除、误解逐概念整体替换', () => {
  const n = node({
    name: 'N',
    teaches: { 甲: '会用', 乙: '知道' },
    misconceptions: [
      { concept: '甲', model: 'a1' }, { concept: '甲', model: 'a2' }, { concept: '乙', model: 'b1' },
    ],
    overrides: {
      teaches: { 甲: '能教', 乙: null, 丙: '会用' },
      misconceptions: { 甲: [{ concept: '甲', model: 'a*' }] },
    },
  })
  const eff = effectiveConceptFieldsOf(n)
  assert.deepEqual(eff.teaches, { 甲: '能教', 丙: '会用' })
  assert.deepEqual(eff.assumes, {})
  // 甲一族整体替换、乙一族原样（出现序：出生序优先）
  assert.deepEqual(eff.misconceptions, [{ concept: '甲', model: 'a*' }, { concept: '乙', model: 'b1' }])
  // null 删除一整族
  const del = effectiveConceptFieldsOf(node({
    name: 'N', misconceptions: [{ concept: '乙', model: 'b1' }],
    overrides: { misconceptions: { 乙: null } },
  }))
  assert.deepEqual(del.misconceptions, [])
  // 无覆盖 = 出生原样；mergeTierMap 单点
  assert.deepEqual(effectiveConceptFieldsOf(node({ name: 'N', teaches: { 甲: '会用' } })).teaches, { 甲: '会用' })
  assert.deepEqual(mergeTierMap({ a: '知道' }, { a: null, b: '会用' }), { b: '会用' })
})

test('mergeNodeOverrides：逐概念键并入（同键后写覆盖）', () => {
  const merged = mergeNodeOverrides(
    { teaches: { 甲: '会用', 乙: null } },
    { teaches: { 甲: '能教', 丙: '知道' }, assumes: { 丁: '会用' } },
  )
  assert.deepEqual(merged.teaches, { 甲: '能教', 乙: null, 丙: '知道' })
  assert.deepEqual(merged.assumes, { 丁: '会用' })
})

test('Graph 读侧按合并值：五访问器与反向映射，graphDoc 落盘回读保真', () => {
  const nodes = [
    node({ name: '起点' }),
    node({
      name: '主技能', pre: ['起点'], teaches: { 甲: '会用' }, assumes: { 丙: '知道' },
      overrides: { teaches: { 甲: null, 丁: '能教' }, assumes: { 丙: '会用' } },
    }),
  ]
  const g = new Graph(nodes)
  assert.deepEqual(g.teachesOf['主技能'], { 丁: '能教' })
  assert.equal(g.taughtByOf['甲'], undefined, '被删概念无反向映射')
  assert.deepEqual(g.taughtByOf['丁'], ['主技能'])
  assert.deepEqual(g.assumesOf['主技能'], { 丙: '会用' })
  assert.deepEqual(g.assumedByOf['丙'], ['主技能'])
  const doc = new GraphStore(null as never, '', nodeVaultFs).graphDoc(nodes) as { nodes: Array<Record<string, unknown>> }
  assert.deepEqual(doc.nodes[1]!.overrides, { teaches: { 甲: null, 丁: '能教' }, assumes: { 丙: '会用' } })
  const again = loadGraphDoc(doc, 'data/图.yaml')
  assert.deepEqual(again[1]!.overrides, nodes[1]!.overrides)
})

test('门按合并值判：有效 teaches 归零 / teaches∩assumes / 误解封顶按合并计数', () => {
  const g = new Graph([
    node({ name: '起点' }),
    node({ name: '主技能', pre: ['起点'], teaches: { 甲: '会用' }, assumes: { 丙: '知道' } }),
  ])
  // 有效 teaches 归零被拒；保留一枚放行
  assert.ok(teachesGateErrors([setConcepts({ teaches: { 甲: null } })], [], g)
    .some(e => e.includes('修正后有效 teaches 归零')))
  assert.deepEqual(teachesGateErrors([setConcepts({ teaches: { 甲: '能教' } })], [], g), [])
  // 合并后同节点 teaches∩assumes 被拒；不交叉放行
  assert.ok(selfContradictionErrors([setConcepts({ assumes: { 甲: '会用' } })], [], g)
    .some(e => e.includes('同一概念')))
  assert.deepEqual(selfContradictionErrors([setConcepts({ assumes: { 丁: '知道' } })], [], g), [])
  // 误解封顶按合并计数（存量 3 + 覆盖新增 3 → 越过封顶）
  const base = [node({ name: 'A', misconceptions: [1, 2, 3].map(i => ({ concept: '甲', model: `b${i}` })) })]
  const sim = [
    node({ name: 'A', misconceptions: [1, 2, 3].map(i => ({ concept: '甲', model: `b${i}` })) }),
    node({ name: 'B', overrides: { misconceptions: { 甲: [1, 2, 3].map(i => ({ concept: '甲', model: `o${i}` })) } } }),
  ]
  assert.ok(misconceptionGateErrors(sim, base, []).some(e => e.includes('误解封顶越界')))
})

test('validateEditProposal：set_concepts 的 overrides 契约（缺/空/越权/出生字段误写）', () => {
  const v = (op: Record<string, unknown>) => validateEditProposal({ course: '数学', ops: [op] })
  assert.ok(v({ op: 'set_concepts', node: 'A' }).errors?.some(e => e.includes('需要 overrides')))
  assert.ok(v({ op: 'set_concepts', node: 'A', overrides: {} }).errors?.some(e => e.includes('空覆盖')))
  assert.ok(v({ op: 'add_node', name: 'A', pre: [], overrides: { teaches: { 甲: '知道' } } }).errors
    ?.some(e => e.includes('不接受 overrides')))
  assert.ok(v({ op: 'set_concepts', node: 'A', teaches: { 甲: '知道' }, overrides: { teaches: { 甲: '知道' } } }).errors
    ?.some(e => e.includes('不接受 teaches/assumes/misconceptions')))
  const good = v({ op: 'set_concepts', node: 'A', overrides: { teaches: { 甲: '能教', 乙: null } } })
  assert.equal(good.errors, undefined)
  assert.deepEqual(good.spec!.ops[0]!.overrides, { teaches: { 甲: '能教', 乙: null } })
})

test('存量库（无覆盖键）加载与合并零变化：overrides 缺席、有效值 = 出生值', () => {
  const n = parseNode({ name: '入门', pre: [] }, 'data/图.yaml', '节点')
  assert.equal(n.overrides, undefined)
  assert.deepEqual(effectiveConceptFieldsOf(n), { teaches: {}, assumes: {}, misconceptions: [] })
  const doc = new GraphStore(null as never, '', nodeVaultFs).graphDoc([n]) as { nodes: Array<Record<string, unknown>> }
  assert.equal(doc.nodes[0]!.overrides, undefined, '无覆盖不落 overrides 键')
})

const OVERLAY_VAULT = {
  graph: `
nodes:
  - { name: 入门, pre: [], opt: false, note: "", est: 20 }
  - name: 主技能
    pre: [入门]
    est: 25
    teaches: { 因式分解: 会用, 配方法: 能教 }
    assumes: { 整式乘法: 知道 }
    misconceptions:
      - { concept: 因式分解, model: 把因式分解当成逆运算 }
      - { concept: 因式分解, model: 直接套公式不看结构 }
`,
  files: [{
    path: join('学习中心', '概念登记表.yaml'),
    content: ['concepts:', '  - canonical: 因式分解', '  - canonical: 配方法', '  - canonical: 整式乘法', '  - canonical: 换元法'].join('\n'),
  }],
}

test('set_concepts 端到端：出生字段不改、覆盖键落盘、overlay.jsonl + journal 留痕、读侧按合并值', async () => {
  await withVault(OVERLAY_VAULT, async ({ engine, root }) => {
    const yaml = `course: 数学
reason: 修正出生打标
ops:
  - op: set_concepts
    node: 主技能
    overrides:
      teaches: { 因式分解: 能教, 配方法: null }
      assumes: { 换元法: 知道 }
      misconceptions: { 因式分解: [{ concept: 因式分解, model: 修正后的错误模型 }] }
`
    const r = await engine.graph.graphPropose('edit', yaml) as { id: number }
    await engine.graph.graphApply('edit', r.id)

    // 出生字段逐字不改 + 覆盖键逐概念落盘（正典 data/图.yaml）
    const store = new GraphStore(engine.paths, join(root, '学习中心', 'math'), nodeVaultFs)
    const nodes = await store.load()
    const n = nodes.find(x => x.name === '主技能')!
    assert.deepEqual(n.teaches, { 因式分解: '会用', 配方法: '能教' }, '出生 teaches 逐字不变')
    assert.deepEqual(n.assumes, { 整式乘法: '知道' }, '出生 assumes 逐字不变')
    assert.equal(n.misconceptions?.length, 2, '出生误解不变')
    assert.deepEqual(n.overrides, {
      teaches: { 因式分解: '能教', 配方法: null },
      assumes: { 换元法: '知道' },
      misconceptions: { 因式分解: [{ concept: '因式分解', model: '修正后的错误模型' }] },
    })
    const dataYaml = await readFile(join(root, '学习中心', 'math', 'data', '图.yaml'), 'utf8')
    assert.match(dataYaml, /overrides:/, '覆盖键落正典')
    assert.match(dataYaml, /配方法: 能教/, '出生档仍在正典')

    // 读侧按合并值（Graph 五访问器 = concept_footprint / node_card / 内容注入的取材核）
    const g = new Graph(nodes)
    assert.deepEqual(g.teachesOf['主技能'], { 因式分解: '能教' })
    assert.deepEqual(g.assumesOf['主技能'], { 整式乘法: '知道', 换元法: '知道' })
    assert.deepEqual(g.misconceptionsOf['主技能'], [{ concept: '因式分解', model: '修正后的错误模型' }])
    assert.equal(g.taughtByOf['配方法'], undefined, '被删概念读侧不再出现')

    // 留痕：覆盖层.jsonl 行形状 = enc 富化同款 + reason/actor
    const overlay = (await readFile(join(root, '学习中心', 'math', 'state', '覆盖层.jsonl'), 'utf8'))
      .trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    assert.equal(overlay.length, 3)
    assert.deepEqual(overlay.map(x => x.field).sort(), ['assumes', 'misconceptions', 'teaches'])
    for (const row of overlay) {
      assert.equal(row.target, '主技能')
      assert.equal(row.actor, 'proposal')
      assert.match(String(row.content_hash), /^[0-9a-f]{64}$/)
      assert.ok(row.applied_at)
      assert.match(String(row.reason), /修正出生打标/)
    }

    // journal 有对应 op
    const journal = await readFile(engine.paths.journalPath, 'utf8')
    assert.match(journal, /graph_edit/)
    assert.match(journal, /set_concepts\(主技能\)/)
  })
})

test('set_concepts 进生长草稿：形状归一/糖展开原样透传；真实受理门按合并值拒（单缝）', async () => {
  // 草稿入口两关（收下即归一 / 糖展开）不为 set_concepts 开拒收分支
  const norm = normalizePatchShape([{ op: 'set_concepts', node: 'A', overrides: { teaches: { 甲: null } } }], [])
  assert.deepEqual(norm.errors, [])
  assert.equal((norm.ops[0] as Record<string, unknown>).op, 'set_concepts')
  const expanded = expandPatchOps([{ op: 'set_concepts', node: 'A', overrides: { teaches: { 甲: null } } }], [], new Graph([]), new Set())
  assert.deepEqual(expanded.ops, [{ op: 'set_concepts', node: 'A', overrides: { teaches: { 甲: null } } }])
  // 真实受理门（graphPropose → editGateErrors 单缝）：修正使有效 teaches 归零被拒
  await withVault(OVERLAY_VAULT, async ({ engine }) => {
    const yaml = `course: 数学
reason: 清空 teaches
ops:
  - op: set_concepts
    node: 主技能
    overrides:
      teaches: { 因式分解: null, 配方法: null }
`
    await assert.rejects(() => engine.graph.graphPropose('edit', yaml), /修正后有效 teaches 归零/)
    assert.equal((await engine.store.loadProposals()).length, 0, '拒收不落提案')
  })
})

test('split_node 继承合并后有效字段：修正不因拆分静默丢失', () => {
  const nodes = [
    node({ name: '甲' }),
    node({
      name: '乙', pre: ['甲'], teaches: { 旧概念: '会用' },
      overrides: { teaches: { 旧概念: null, 新概念: '能教' } },
    }),
  ]
  const { ops } = expandPatchOps(
    [{ op: 'split_node', node: '乙', into: ['乙一', '乙二'] }], nodes, new Graph(nodes), new Set(),
  )
  const adds = ops.filter(o => o.op === 'add_node') as Array<{ name: string; teaches?: Record<string, string> }>
  assert.equal(adds.length, 2)
  for (const a of adds) {
    assert.deepEqual(a.teaches, { 新概念: '能教' }, '拆分件带的是合并后有效值（旧概念已删、新概念已升）')
  }
})

// data-check 旁路收编（spec §4）：体检读数按合并后有效值——出生 teaches 被覆盖删除的概念
// 成孤儿、覆盖层新增的概念有足迹（不按原始出生字段读）。
const CHECK_VAULT = {
  graph: `
nodes:
  - { name: 入门, pre: [], opt: false, note: "", est: 20 }
  - name: 主技能
    pre: [入门]
    est: 25
    teaches: { 甲概念: 会用 }
    overrides:
      teaches: { 甲概念: null, 乙概念: 会用 }
`,
  files: [{
    path: join('学习中心', '概念登记表.yaml'),
    content: ['concepts:', '  - canonical: 甲概念', '  - canonical: 乙概念'].join('\n'),
  }],
}

test('data-check 旁路收编：概念层读数按合并值——被删概念成孤儿、覆盖新增概念有足迹', async () => {
  await withVault(CHECK_VAULT, async ({ engine }) => {
    const report = await engine.dataCheck()
    const orphan = report.findings.find(f => f.reason === 'concept_orphan_registry')
    assert.ok(orphan, '合并后「甲概念」零足迹 → 报孤儿')
    assert.match(orphan!.detail ?? '', /甲概念/)
    assert.doesNotMatch(orphan!.detail ?? '', /乙概念/, '覆盖新增的「乙概念」有足迹，不作孤儿')
  })
})

// 门按别名归一（spec 施工面·测试行）：覆盖层概念写别名，经 canonical 归一后与有效 teaches
// 相撞仍被自相矛盾门拒收（与 tests/i315-growth-fixes.test.ts 的 B7 同款）。
test('set_concepts 门按别名归一：覆盖层概念写别名归一后与有效 teaches 相撞仍拒', () => {
  const entries: ConceptEntry[] = [{ canonical: '换元法', aliases: ['代换法'] }]
  const g = new Graph([
    node({ name: '起点' }),
    node({ name: '主技能', pre: ['起点'], teaches: { 换元法: '会用' } }),
  ])
  const hit = selfContradictionErrors([setConcepts({ assumes: { 代换法: '知道' } })], entries, g)
  assert.equal(hit.length, 1, '别名写法按 canonical 归一后命中')
  assert.match(hit[0]!, /同一概念/)
  assert.deepEqual(selfContradictionErrors([setConcepts({ assumes: { 别的概念: '知道' } })], entries, g), [])
})
