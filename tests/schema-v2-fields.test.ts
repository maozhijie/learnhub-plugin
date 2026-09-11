import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GraphStore, loadRegionDoc, parseConceptFields, parseNode, SchemaError } from '../src/engine/graph.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { validateEditProposal } from '../src/engine/proposals.ts'
import { withVault } from './helpers/vault.ts'
import { YAML } from '../src/engine/yaml.ts'

// schema v2 节点概念字段组（#127 §1/§7 + v1.1 种子框架适配；#140 受理门）：
// teaches 在场 1–8（1–2 WARN）/ assumes 缺席合法在场 3–10（1–2 WARN）/ 误解 {concept, model}
// 无签名字段、每概念全课程封顶 3；档值中文锁定 知道/会用/能教；边轻：图 YAML 零边字段。

const graphWith = (nodeLines: string) => `
region: 基础
color: blue
blocks:
  - name: 入门块
    nodes:
${nodeLines}
`

function expectSchemaError(fn: () => unknown, part: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof SchemaError, `应为 SchemaError，收到 ${(e as Error)?.constructor?.name}`)
    assert.match((e as Error).message, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    return true
  })
}

test('概念字段组：合法三组照抄落图，regionDoc 序列化与 parseNode 回读一致', () => {
  const doc = YAML.parse(graphWith(`      - name: 主技能
        pre: []
        opt: false
        note: ""
        est: 20
        teaches: { 因式分解: 会用, 配方法: 能教 }
        assumes: { 整式乘法: 知道, 一元一次方程: 会用 }
        misconceptions:
          - concept: 因式分解
            model: 把因式分解当成整式乘法的逆运算瞎展开
        enc: []`))
  const region = loadRegionDoc(doc, 'data/基础.yaml')
  const n = region.blocks[0]!.nodes[0]!
  assert.deepEqual(n.teaches, { 因式分解: '会用', 配方法: '能教' })
  assert.deepEqual(n.assumes, { 整式乘法: '知道', 一元一次方程: '会用' })
  assert.deepEqual(n.misconceptions, [{ concept: '因式分解', model: '把因式分解当成整式乘法的逆运算瞎展开' }])
  // 快照/落盘序列化保真（regionDoc 顺序与省空值纪律）
  const round = new GraphStore(null as never, '', nodeVaultFs).regionDoc(region)
  const again = loadRegionDoc(round, 'data/基础.yaml')
  assert.deepEqual(again.blocks[0]!.nodes[0]!.teaches, n.teaches)
  assert.deepEqual(again.blocks[0]!.nodes[0]!.misconceptions, n.misconceptions)
})

test('概念字段组：缺席全合法（种子/纯结构节点零概念字段可过）', () => {
  const node = parseNode({ name: '裸节点', pre: [] }, 'data/x.yaml', '块')
  assert.equal(node.teaches, undefined)
  assert.equal(node.assumes, undefined)
  assert.equal(node.misconceptions, undefined)
})

test('teaches 尺寸带：8 条合法、9 条 ERROR、1–2 条 WARN 不阻', () => {
  const tiers = (n: number) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`概念${i + 1}`, '知道']))
  // 8 条合法
  const node8 = parseNode({ name: '满配', pre: [], teaches: tiers(8) }, 'data/x.yaml', '块')
  assert.equal(Object.keys(node8.teaches!).length, 8)
  // 9 条 ERROR
  expectSchemaError(() => parseNode({ name: '超配', pre: [], teaches: tiers(9) }, 'data/x.yaml', '块'), 'teaches 有 9 条（上限 8）')
  // 1–2 条 WARN：写入 warns 槽，不抛
  const warns: string[] = []
  parseNode({ name: '窄节点', pre: [], teaches: { 只有: '能教' } }, 'data/x.yaml', '块', warns)
  assert.equal(warns.length, 1)
  assert.match(warns[0]!, /teaches 仅 1 条（窄节点提示/)
})

test('teaches 枚举与形态：档值中文锁定，英文/未知档 ERROR，非映射 ERROR', () => {
  expectSchemaError(() => parseNode({ name: '坏档', pre: [], teaches: { 概念: 'mastered' } }, 'data/x.yaml', '块'), '档位非法 "mastered"（允许 知道/会用/能教）')
  expectSchemaError(() => parseConceptFields({ teaches: ['概念'] }, 'data/x.yaml', '块', '坏形态'), 'teaches 必须是映射（概念名 → 档位）')
  expectSchemaError(() => parseNode({ name: '空名', pre: [], teaches: { '  ': '知道' } }, 'data/x.yaml', '块'), 'teaches 概念名不能为空')
})

test('assumes 尺寸带：缺席合法、10 条合法、11 条 ERROR、1–2 条 WARN', () => {
  const tiers = (n: number) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`前置概念${i + 1}`, '会用']))
  const node10 = parseNode({ name: '宽前置', pre: [], assumes: tiers(10) }, 'data/x.yaml', '块')
  assert.equal(Object.keys(node10.assumes!).length, 10)
  expectSchemaError(() => parseNode({ name: '超宽', pre: [], assumes: tiers(11) }, 'data/x.yaml', '块'), 'assumes 有 11 条（上限 10）')
  const warns: string[] = []
  parseNode({ name: '入口', pre: [], assumes: { 常识: '知道' } }, 'data/x.yaml', '块', warns)
  assert.ok(warns.some(w => /assumes 仅 1 条/.test(w)))
})

test('误解条目：无签名字段（未知字段 ERROR）、缺 model ERROR、同节点同概念 4 条 ERROR', () => {
  expectSchemaError(
    () => parseNode({ name: '带签名', pre: [], misconceptions: [{ concept: '概念', model: '错法', signature: 'judge-a' }] }, 'data/x.yaml', '块'),
    '判据签名不设机器字段',
  )
  expectSchemaError(
    () => parseNode({ name: '缺模型', pre: [], misconceptions: [{ concept: '概念' }] }, 'data/x.yaml', '块'),
    '缺 model（错误模型文字',
  )
  expectSchemaError(
    () => parseNode({
      name: '堆误解', pre: [],
      misconceptions: [1, 2, 3, 4].map(i => ({ concept: '同一概念', model: `错法${i}` })),
    }, 'data/x.yaml', '块'),
    'misconceptions[同一概念] 有 4 条（同一概念全课程封顶 3 条）',
  )
})

test('边轻（#127 §2）：图 YAML 出现 origin/status/probation 边字段即 Broken，拒收信息可执行', () => {
  expectSchemaError(
    () => loadRegionDoc(YAML.parse(graphWith(`      - name: 插入节点
        pre: [起点]
        origin: insert-提案1
        enc: []`)), 'data/x.yaml'),
    'origin 从提案 journal 派生，图 YAML 不存储',
  )
  expectSchemaError(
    () => loadRegionDoc(YAML.parse(graphWith(`      - name: 复诊节点
        pre: [起点]
        status: probation
        enc: []`)), 'data/x.yaml'),
    '复诊状态落 state/边实验.jsonl',
  )
  expectSchemaError(
    () => loadRegionDoc(YAML.parse(graphWith(`      - name: 复诊节点
        pre: [起点]
        probation: 2026-09-20
        enc: []`)), 'data/x.yaml'),
    '边轻纪律',
  )
})

// ---- 受理门集成：概念字段组过 edit 提案门，跨节点误解封顶计数 ----

const CAP_VAULT = {
  graph: `
region: 基础
color: blue
blocks:
  - name: 入门块
    nodes:
      - { name: 起点, pre: [], opt: false, note: "", est: 20 }
      - name: 误解节点
        pre: [起点]
        misconceptions:
          - { concept: 概念甲, model: 错法一 }
          - { concept: 概念甲, model: 错法二 }
          - { concept: 概念甲, model: 错法三 }
`,
}

test('受理门：误解跨节点封顶——存量 3 条后再提案第 4 条被拒，拒收信息可执行', async () => {
  await withVault({ ...CAP_VAULT, tag: 'learnhub-miscap-' }, async ({ engine }) => {
    const yaml = `course: 数学
reason: 再添一条同概念误解
ops:
  - op: add_node
    name: 新误解节点
    region: 基础
    block: 入门块
    pre: [误解节点]
    misconceptions:
      - { concept: 概念甲, model: 错法四 }
`
    await assert.rejects(
      () => engine.graph.graphPropose('edit', yaml),
      /误解封顶越界: 概念「概念甲」全课程已有 4 条误解（同一概念封顶 3 条）/,
    )
    assert.equal((await engine.store.loadProposals()).length, 0, '拒收不落提案')
  })
})

test('受理门：add_node 携带概念字段组过门落图；窄节点 warns 随受理回执返回', async () => {
  await withVault({ tag: 'learnhub-conceptfields-' }, async ({ engine, root }) => {
    // 默认单节点图起步：生长批形态的窄节点（teaches 1 条 = WARN 不阻；assumes 2 条 = WARN）
    // 概念引用随 #141 铸名块同批入册（teaches 引用铸名，assumes 引用登记表外名字须铸名）
    const yaml = `course: 数学
concepts:
  - canonical: 行变换几何直觉
  - canonical: 矩阵乘法
  - canonical: 行列式
ops:
  - op: add_node
    name: 中继节点
    region: 基础
    block: 入门块
    pre: [入门]
    est: 10
    teaches: { 行变换几何直觉: 知道 }
    assumes: { 矩阵乘法: 会用, 行列式: 知道 }
    misconceptions:
      - { concept: 行变换几何直觉, model: 把行变换当成列变换 }
`
    const r = await engine.graph.graphPropose('edit', yaml) as { id: number; warns?: string[] }
    assert.ok(r.warns?.some(w => /teaches 仅 1 条（窄节点提示/.test(w)), '窄节点提示随受理回执返回')
    assert.ok(r.warns?.some(w => /assumes 仅 2 条/.test(w)))
    await engine.graph.graphApply('edit', r.id)
    // 出生层落图：概念字段组随 add_node 写进正典 data/*.yaml
    const dataYaml = readFileSync(join(root, '学习中心', 'math', 'data', '基础.yaml'), 'utf8')
    assert.match(dataYaml, /teaches:/)
    assert.match(dataYaml, /行变换几何直觉: 知道/)
    assert.match(dataYaml, /misconceptions:/)
    assert.match(dataYaml, /model: 把行变换当成列变换/)
  })
})

test('受理门：概念字段组的 ERROR 尺寸/枚举负路径在 edit 门被拒（拒收信息可执行）', async () => {
  await withVault({ graph: null, tag: 'learnhub-conceptreject-' }, async ({ engine }) => {
    const bad = `course: 数学
ops:
  - op: add_node
    name: 概念爆炸
    region: 基础
    block: 入门块
    pre: []
    teaches: { 概念1: 知道, 概念2: 知道, 概念3: 知道, 概念4: 知道, 概念5: 知道, 概念6: 知道, 概念7: 知道, 概念8: 知道, 概念9: 知道 }
    assumes: { 概念A: 知道, 概念B: 知道 }
`
    await assert.rejects(() => engine.graph.graphPropose('edit', bad), /teaches 有 9 条（上限 8）/)

    const badTier = `course: 数学
ops:
  - op: add_node
    name: 坏档位
    region: 基础
    block: 入门块
    pre: []
    teaches: { 概念: 精通 }
`
    await assert.rejects(() => engine.graph.graphPropose('edit', badTier), /档位非法 "精通"（允许 知道\/会用\/能教）/)
    assert.equal((await engine.store.loadProposals()).length, 0, '负路径不落提案')
  })
})

test('受理门：概念字段组写在非 add_node 的 op 上被拒（出生字段不静默丢弃）', () => {
  const v = validateEditProposal({
    course: '数学',
    ops: [{ op: 'set_pre', node: '起点', pre: [], teaches: { 概念: '知道' } }],
  })
  assert.ok(v.errors?.some(e => e.includes('不接受 teaches/assumes/misconceptions（概念字段组只在 add_node 出生时写）')))
})
