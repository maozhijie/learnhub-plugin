import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAnchor } from '../src/engine/seed.ts'
import { withVault } from './helpers/vault.ts'

// 存量异常态恢复演练（#201 / ADR-0055 边界条款验收票）：
// 以实机「数学」课的异常态形态为夹具（同构造数据，三病俱全），走一遍对账恢复全链：
//   病一：endpoint.pre 仍是种子三起点——12 个生长节点无一汇入终点闭包、终点深度恒 1；
//   病二：「按顺序综述从文字到答案的每一步动作」节点以终点为 pre（长过目标）；
//   病三：终点已被生成正文而真实坡道未成（坡道节点零正文零练习）。
// 演练步骤（提案 id / 各门行为 / 终局图态的自动化留痕，本文件即可重放命令序列）：
//   1. 收尾接线批（set_pre 终点 = 真实前沿一线）过 #198 新受理门，apply 落 sealed（#202）；
//   2. 复发预防对照：add_node 以终点为 pre 被受理门拒（禁长过目标）；
//   3. 「综述」节点处置走 del_node 提案快照语义（正文归档、快照留痕、journal 留痕）；
//   4. 生成门对终点恒拒（ADR-0056 修订：票面原 step3「未就绪拒收、就绪后放行」已随
//      终点纯标记化被取代——未就绪/就绪两形态都拒，不看就绪）；
//   5. 异常态 → 合法态读数：终点深度 1→7、主线深度 6→7、last_steps 随接线改扎、
//      收尾 + 最后台阶达标判完成；存量终点正文保留（不追溯清档边界）。

/** 异常态夹具图：三起点 + 终点（陈旧粗边）+ 12 生长节点（真实坡道 6 + 支线 5 + 综述 1）。 */
const BASE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 种子块',
  '    nodes:',
  '      - { name: 数与式运算, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 方程与恒等变形, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 图形与度量, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 用数学解决真实问题, pre: [数与式运算, 方程与恒等变形, 图形与度量], opt: false, note: "" }',
].join('\n')

const GROWTH_GRAPH = [
  'region: 生长',
  'color: green',
  'blocks:',
  '  - name: 主线坡道',
  '    nodes:',
  '      - { name: 从文字到方程, pre: [方程与恒等变形], opt: false, note: "", est: 15 }',
  '      - { name: 设未知数, pre: [从文字到方程], opt: false, note: "", est: 15 }',
  '      - { name: 建立方程模型, pre: [设未知数], opt: false, note: "", est: 20 }',
  '      - { name: 化简与变形, pre: [建立方程模型], opt: false, note: "", est: 20 }',
  '      - { name: 合成求解路径, pre: [化简与变形], opt: false, note: "", est: 25 }',
  '      - { name: 答案检验, pre: [合成求解路径], opt: false, note: "", est: 20 }',
  '  - name: 支线块',
  '    nodes:',
  '      - { name: 几何作图初步, pre: [图形与度量], opt: false, note: "", est: 15 }',
  '      - { name: 面积与周长计算, pre: [几何作图初步], opt: false, note: "", est: 20 }',
  '      - { name: 数据的收集与整理, pre: [数与式运算], opt: false, note: "", est: 15 }',
  '      - { name: 平均数与直观统计, pre: [数据的收集与整理], opt: false, note: "", est: 15 }',
  '      - { name: 数据可视化初步, pre: [平均数与直观统计], opt: false, note: "", est: 15 }',
  '  - name: 综述块',
  '    nodes:',
  '      - { name: 按顺序综述从文字到答案的每一步动作, pre: [用数学解决真实问题], opt: false, note: "" }',
].join('\n')

const ENDPOINT = '用数学解决真实问题'
const OVERVIEW = '按顺序综述从文字到答案的每一步动作'
const STARTS = ['数与式运算', '方程与恒等变形', '图形与度量']

function anchorDoc(): string {
  return JSON.stringify({
    version: 1,
    endpoint: ENDPOINT,
    goal_type: 'capability',
    declared: '2026-09-01',
    origin_proposal: 1,
    seed_nodes: [...STARTS, ENDPOINT],
    start_basis: Object.fromEntries(STARTS.map(s => [s, 'baseline'])),
  }, null, 1) + '\n'
}

/** 达标掌握度（mastery = 0.7×1 + 0.3×1 = 1.0 ≥ 0.8）：真实前沿一线已练到位。 */
const MASTERED = {
  stage: 'review',
  fsrs: { stability: 100, difficulty: 5, due: '2026-09-30', last_review: '2026-09-01', reps: 6, lapses: 0 },
  practice: { attempts: 1, correct: 1, ema: 1 },
}

const DRILL_VAULT = {
  graph: BASE_GRAPH,
  graphFile: '00_基础.yaml',
  files: [
    { path: '学习中心/math/data/01_生长.yaml', content: GROWTH_GRAPH },
    { path: '学习中心/math/state/终点锚.json', content: anchorDoc() },
  ],
  notes: {
    // 病三：终点已被生成正文（真实坡道未成——坡道 11 节点零正文零练习）
    [ENDPOINT]: { stage: 'ready', content: { version: 1, status: 'reviewed' } },
    // 综述节点也被生成过（教练歪长的产物有了存量正文，处置时走归档）；多区键带「区/」前缀
    [`生长/${OVERVIEW}`]: { stage: 'ready', content: { version: 1, status: 'reviewed' } },
    // 真实前沿一线已练到位（学习者在坡道上走过，只是图没接线）
    '生长/合成求解路径': MASTERED,
    '生长/答案检验': MASTERED,
  },
}

test('#201 异常态恢复演练：接线批过受理门 → 复发预防对照 → 综述 del_node 快照语义 → 生成门恒拒 → 合法态读数', { timeout: 60_000 }, async t => {
  const trace: string[] = []

  await withVault(DRILL_VAULT, async ({ engine, paths, root }) => {
    const courseRoot = join(root, '学习中心', 'math')

    // ---- 异常态盘点（三病俱全的读数基线） ----
    const doc0 = await engine.graph.graphAnalyze('数学') as {
      stats: { leaves: number; max_depth: number }
      nodes: Array<{ data: { id: string; depth: number; isEndpoint: boolean } }>
      schema: Record<string, { pre: string[] }>
    }
    assert.deepEqual(doc0.schema[ENDPOINT]!.pre, STARTS, '病一：终点.pre 仍是种子三起点（陈旧粗边）')
    const endpointDepth0 = doc0.nodes.find(n => n.data.id === ENDPOINT)!.data.depth
    assert.equal(endpointDepth0, 1, '病一：终点深度恒 1')
    assert.equal(doc0.stats.max_depth, 6, '真实坡道已长到 depth 6（答案检验），终点却悬在 depth 1')
    assert.equal(doc0.nodes.length, 16, '图上 16 节点：4 种子 + 12 生长（坡道 6 + 支线 5 + 综述 1）')
    assert.deepEqual(doc0.schema[OVERVIEW]!.pre, [ENDPOINT], '病二：综述节点以终点为 pre（长过目标）')
    assert.equal(await engine.content2.contentVersion('数学', ENDPOINT), 1, '病三：终点已被生成正文')
    const completion0 = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.ok(completion0)
    assert.deepEqual(completion0!.criteria.last_steps.map(s => s.node), STARTS, '完成判据折叠自陈旧粗边（三起点）')
    assert.equal(completion0!.criteria.mastery_met, false)
    assert.equal(completion0!.criteria.sealed, null)
    assert.equal(completion0!.complete, false)
    // 生成门（未就绪形态：pre = 未掌握起点）——恒拒，不看就绪（ADR-0056 已取代票面原 step3 的「就绪后放行」）
    await assert.rejects(() => engine.content2.contentPack('数学', ENDPOINT), /终点是承诺标记，不被学习调度/)
    trace.push('异常态盘点：终点深度 1、主线深度 6、综述以终点为 pre、终点有正文；生成门拒（未就绪形态）')

    // ---- 第 1 步：收尾接线批过 #198 新受理门（教练裁决：终点 = 真实前沿一线）----
    const wiring = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 对账演练——陈旧终点接线（种子粗边）作废，终点改扎真实前沿「合成求解路径」「答案检验」一线，收尾宣告随批落锚
ops:
  - op: set_pre
    node: ${ENDPOINT}
    pre: [合成求解路径, 答案检验]
`) as { id: number }
    assert.equal(wiring.id, 1, '接线批提案 id（fresh vault 提案从 1 起计）')
    const wiringApplied = await engine.graph.graphApply('edit', wiring.id) as { ops: number; snapshot: number }
    assert.equal(wiringApplied.ops, 1)
    assert.equal(wiringApplied.snapshot, 1, '接线批 apply 留快照 v1（收尾接线批后图态）')
    const anchorAfterWiring = await readAnchor(paths.anchorPath('math'), (await import('../src/host/vault-fs.ts')).nodeVaultFs)
    assert.match(anchorAfterWiring!.sealed!, /^\d{4}-\d{2}-\d{2}$/, '纯 set_pre 接线批 apply 落 sealed 收尾宣告（#202）')
    trace.push(`提案 #${wiring.id}（收尾接线批 set_pre 终点 = 合成求解路径、答案检验）：受理门过 → apply 落快照 v1 + sealed`)

    // ---- 第 2 步：复发预防对照——add_node 以终点为 pre 被受理门拒（#198① 禁长过目标）----
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
ops:
  - op: add_node
    name: 结课寄语
    region: 生长
    block: 综述块
    pre: [${ENDPOINT}]
    est: 10
`),
      /目标之后不是本课程的生长域/,
    )
    trace.push('复发预防：add_node 以终点为 pre 被受理门拒（病二的成因结构今日不再可写入）')

    // ---- 第 3 步：综述处置走 del_node 提案快照语义 ----
    const del = await engine.graph.graphPropose('edit', `course: 数学
reason: 对账演练——长过目标的综述节点不是本课程的生长域，del_node 处置（正文随批归档）
ops:
  - op: del_node
    node: ${OVERVIEW}
`) as { id: number }
    assert.equal(del.id, 2, 'del_node 提案 id 紧随接线批')
    const delApplied = await engine.graph.graphApply('edit', del.id) as { deleted: string[]; snapshot: number }
    assert.deepEqual(delApplied.deleted, [OVERVIEW])
    assert.equal(delApplied.snapshot, 2, 'del_node apply 留快照 v2（处置后图态）')
    // 快照语义：v1 收容处置前图态（综述在册，可恢复点），v2 为处置后图态
    // （快照落中心级 state/snapshots/，按课程名分文件）
    const snap1 = await readFile(join(root, '学习中心', 'state', 'snapshots', '数学-v1.json'), 'utf8')
    const snap2 = await readFile(join(root, '学习中心', 'state', 'snapshots', '数学-v2.json'), 'utf8')
    assert.ok(snap1.includes(OVERVIEW), '快照 v1 保留综述（处置前图态留痕）')
    assert.ok(!snap2.includes(OVERVIEW), '快照 v2 已无综述（处置生效）')
    // 正文归档（del_node 联动）：规范路径不再有综述笔记，archive 区留 del-<pid> 存档
    const archiveDir = join(courseRoot, 'state', 'archive')
    const archived = await readdir(archiveDir)
    assert.ok(archived.some(f => f.startsWith(`del-${del.id}-`)), `综述正文归档 ${archiveDir}（del-<提案id>- 前缀）`)
    // journal 留痕：两笔 graph_edit（接线批 + 处置批），session = 提案 id
    const journal = await readFile(join(root, '学习中心', 'state', 'journal.jsonl'), 'utf8')
    assert.match(journal, /graph_edit[\s\S]*"session":"1"/, 'journal 留痕接线批（提案 #1）')
    assert.match(journal, /graph_edit[\s\S]*"session":"2"/, 'journal 留痕处置批（提案 #2）')
    trace.push(`提案 #${del.id}（del_node 综述）：受理门过 → apply 快照 v2 + 正文归档 + journal 留痕`)

    // ---- 第 4 步：生成门恒拒（就绪形态：终点.pre 已接线且全部达标）----
    await assert.rejects(() => engine.content2.contentPack('数学', ENDPOINT), /生成门恒拒/, '就绪形态照拒——恒拒不看就绪（ADR-0056）')
    trace.push('生成门：接线且最后台阶达标后仍拒终点产料（恒拒；票面原 step3「就绪后放行」被 ADR-0056 取代）')

    // ---- 第 5 步：异常态 → 合法态的读数变化 ----
    const doc1 = await engine.graph.graphAnalyze('数学') as {
      stats: { leaves: number; max_depth: number }
      nodes: Array<{ data: { id: string; depth: number; isEndpoint: boolean } }>
      schema: Record<string, { pre: string[] }>
    }
    assert.deepEqual(doc1.schema[ENDPOINT]!.pre, ['合成求解路径', '答案检验'], '终点.pre = 教练认定的最后台阶')
    const endpointDepth1 = doc1.nodes.find(n => n.data.id === ENDPOINT)!.data.depth
    assert.equal(endpointDepth1, 7, '终点深度 1 → 7（随主线接线生长）')
    assert.equal(doc1.stats.max_depth, 7, '主线深度 6 → 7（保留终点计的进度读数）')
    assert.equal(doc1.stats.leaves, 2, 'stats.leaves 剔终点（#200）：处置后叶子 = 两条支线尾')
    assert.equal(doc1.nodes.find(n => n.data.id === OVERVIEW), undefined, '综述已不在图上')
    const completion1 = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.ok(completion1)
    assert.deepEqual(completion1!.criteria.last_steps.map(s => s.node), ['合成求解路径', '答案检验'], '完成判据随接线改扎到最后台阶')
    assert.equal(completion1!.criteria.mastery_met, true, '最后台阶（已练到位）全部达标')
    assert.equal(completion1!.criteria.sealed, anchorAfterWiring!.sealed, '收尾宣告在锚上')
    assert.equal(completion1!.complete, true, '已收尾 + 最后台阶掌握 → 完成宣告成立（无需教练再出手）')
    // 学习者账：终点达标也不进就绪/推荐（#199 回归确认）
    const status = await engine.statusJson()
    const course = status.courses.find(c => c.name === '数学')!
    assert.ok(!course.ready.some(r => r.node === ENDPOINT), '就绪清单剔终点')
    // 不追溯清档边界：存量终点正文原样保留
    assert.equal(await engine.content2.contentVersion('数学', ENDPOINT), 1, '存量终点正文保留（ADR-0055 边界）')
    trace.push('终局图态：终点 pre=最后台阶、深度 7、主线深度 7、leaves=2；last_steps 改扎、sealed 在锚、完成成立；终点不进就绪；存量正文保留')

    // 演练留痕随测试输出（--test-reporter spec 可见；票面回填引用此轨迹）
    for (const line of trace) console.log(`  ↳ #201 演练：${line}`)
  })
})

test('#201 夹具回归：未对账时异常态持续可见（锚保护拦 del/rename 终点——对账唯一通道是提案）', async () => {
  await withVault(DRILL_VAULT, async ({ engine }) => {
    // 锚保护既有范围不变：终点不可经 edit 直改
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学\nops:\n  - { op: del_node, node: ${ENDPOINT} }\n`),
      /del_node 拒绝/,
    )
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学\nops:\n  - { op: rename, node: ${ENDPOINT}, new: 新终点 }\n`),
      /rename 拒绝/,
    )
  })
})
