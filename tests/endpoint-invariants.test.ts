import { memLogger } from './helpers/logger.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { validateAnchorBook, validateEndpointAnchor, readAnchors, foldCompletion } from '../src/engine/seed.ts'
import type { EndpointAnchor } from '../src/engine/seed.ts'
import { createHostRuntime } from '../src/host/runtime.ts'
import { enqueueGeneration } from '../src/host/jobs.ts'
import { withVault, noteText, tfQuestion } from './helpers/vault.ts'

// 终点性不变式（#198/#199/#202 / ADR-0055+0056；#239 / ADR-0076 多终点化：一律按
// 锚集合读——生成门/就绪剔除/审计豁免/图面标记/收尾宣告逐终点判定）：
// - #198 受理门（#239 / ADR-0076 多终点化）：① 任何 add_node 以终点为 pre 拒（禁长过
//   目标）；② 主线批（前进/换向）含新节点必须声明 note.target_endpoints 且对每个声明
//   终点 set_pre 接线（替换语义，新前沿全部汇入终点闭包；同一新节点可进多个终点的
//   pre——交汇）；③ 收尾接线批（零 add_node 纯 set_pre）合法；旁支/巩固/插入豁免接线；
//   锚保护既有范围不变。
// - #199 生成门：终点 generate 恒拒（不看就绪）、contextPack 不为终点组装、T1/T2 不
//   登记终点、学习者就绪清单与推荐面剔终点。
// - #202 终点纯标记化：完成判据折叠自最后台阶（终点.pre 集全部 ≥ 阈值）+ 收尾事实
//   sealed 进锚（收尾接线批 apply 写、主线接线批 apply 清）+ 旧锚向后兼容。

/** 双节点图：入门（起点）→ 终点；再加一个旁支后继 A 供 T1/T2 对照。 */
const GRAPH = [
  'nodes:',
  '  - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 中间台阶, pre: [入门], opt: false, note: "", est: 20 }',
  '  - { name: 终点, pre: [入门], opt: false, note: "" }',
].join('\n')

/** 锚容器原文（写侧通道只有起草 apply 与逐终点 sealed 维护；测试经 files 逃生口直接落盘）。
 * 逐条锚的缺省面 = capability + 起草留痕，覆写字段随条目并入。 */
function anchorBook(entries: Array<Record<string, unknown> & { endpoint: string }>): string {
  const anchors = entries.map(a => ({
    goal_type: 'capability',
    declared: '2026-09-01',
    origin_proposal: 1,
    seed_nodes: ['入门', a.endpoint],
    start_basis: { 入门: 'baseline' },
    ...a,
  }))
  return JSON.stringify({ version: 2, anchors }, null, 1) + '\n'
}

/** 单终点锚容器原文。 */
function anchorDoc(endpoint = '终点', sealed?: string): string {
  return anchorBook([{ endpoint, ...(sealed ? { sealed } : {}) }])
}

const SEALED_VAULT = {
  graph: GRAPH,
  files: [{ path: join('学习中心', 'math', 'state', '终点锚.json'), content: anchorDoc() }],
  notes: {
    入门: { stage: 'review' },
    中间台阶: { stage: 'ready' },
    终点: { stage: 'ready', content: { version: 1, status: 'reviewed' } },
  },
}

/** 达标掌握度的节点笔记种子（mastery = 0.7×1 + 0.3×1 = 1.0 ≥ 0.8 阈值）。 */
const MASTERED = {
  stage: 'review',
  fsrs: { stability: 100, difficulty: 5, due: '2026-09-30', last_review: '2026-09-01', reps: 6, lapses: 0 },
  practice: { attempts: 1, correct: 1, ema: 1 },
}

test('#198① 受理门：任何 add_node 以终点为 pre 直接拒（禁长过目标）', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
reason: 长过目标
ops:
  - op: add_node
    name: 目标综述
    pre: [终点]
    est: 20
`),
      /目标之后不是本课程的生长域|禁长过目标/,
    )
  })
})

test('#198② 主线批（前进）含新节点未声明朝向 → 受理门拒收（ADR-0076：target_endpoints 必填，拒因可读）', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 前沿缺下一台阶
ops:
  - op: add_node
    name: 新台阶
    pre: [入门]
    est: 15
`),
      /未声明朝向.*target_endpoints 必填/s,
    )
    // 声明朝向后接线未覆盖批内新前沿（新前沿 = 不被批内其他新节点消费的新节点）→ 同拒
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 前沿缺下一台阶
  target_endpoints: [终点]
ops:
  - op: add_node
    name: 新台阶
    pre: [入门]
    est: 15
  - op: set_pre
    node: 终点
    pre: [入门]
`),
      /未覆盖批内新前沿：新台阶/s,
    )
    // 换向批同受朝向声明义务约束
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 换向
  reason: 批注指向变化
ops:
  - op: add_node
    name: 新方向
    pre: [入门]
    est: 15
`),
      /未声明朝向/s,
    )
  })
})

test('#198③ 主线批接线合规受理 + 收尾接线批（零 add_node 纯 set_pre）合法', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    // 前进批带朝向声明 + 完整接线：新前沿汇入终点闭包 → 受理
    const mainline = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 前沿缺下一台阶
  target_endpoints: [终点]
ops:
  - op: add_node
    name: 新台阶
    pre: [入门]
    est: 15
  - op: set_pre
    node: 终点
    pre: [新台阶]
`) as { id: number }
    assert.ok(mainline.id > 0)
    await engine.graph.graphReject(mainline.id)

    // 收尾接线批：零 add_node、ops 只有终点 set_pre → 合法（停摆前把终点接上最终台阶）
    const closing = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 既有节点已满足终点要求，停摆前接线
ops:
  - op: set_pre
    node: 终点
    pre: [中间台阶]
`) as { id: number }
    assert.ok(closing.id > 0)
    await engine.graph.graphReject(closing.id)
  })
})

test('#198 豁免与既有语义：旁支批免接线可受理；del/rename 终点照拦；普通 edit 接线不设门', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    // 旁支批（症状/教学消费）豁免接线义务
    const side = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 旁支
  reason: 讲清主线必须先教的支线
ops:
  - op: add_node
    name: 支线台阶
    pre: [入门]
    est: 10
`) as { id: number }
    assert.ok(side.id > 0)
    await engine.graph.graphReject(side.id)

    // 锚保护既有范围不变：del/rename 终点照拦
    await assert.rejects(
      () => engine.graph.graphPropose('edit', 'course: 数学\nops:\n  - { op: del_node, node: 终点 }\n'),
      /del_node 拒绝/,
    )
    await assert.rejects(
      () => engine.graph.graphPropose('edit', 'course: 数学\nops:\n  - { op: rename, node: 终点, new: 新终点 }\n'),
      /rename 拒绝/,
    )
  })
})

test('#198/#202 apply 侧：收尾接线批写 sealed；主线接线批清 sealed；旁支批不动 sealed', async () => {
  await withVault({
    ...SEALED_VAULT,
    notes: {
      入门: MASTERED,
      中间台阶: MASTERED,
      终点: { stage: 'ready', content: { version: 1, status: 'reviewed' } },
    },
  }, async ({ engine, paths }) => {
    const anchorPath = paths.anchorPath('math')
    const readSealed = async (endpoint = '终点'): Promise<string | undefined> =>
      (await readAnchors(anchorPath, (await import('../src/host/vault-fs.ts')).nodeVaultFs))
        .find(a => a.endpoint === endpoint)?.sealed
    // 起点：未收尾——pre 集全达标也不判已达成（mastery_met=true 但 sealed=null）
    const before = (await engine.courseCompletion({ name: '数学', root: 'math' }))[0]!
    assert.equal(before.criteria.mastery_met, true, '最后台阶（终点.pre=入门）全达标')
    assert.equal(before.criteria.sealed, null)
    assert.equal(before.status, 'unwired', '未收尾 = 未铺通')
    assert.equal(before.complete, false, '未收尾不判达成')

    // 收尾接线批 apply → 锚写 sealed（收尾即宣告承诺兑现）
    const closing = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 既有节点已满足终点要求，停摆前接线
ops:
  - op: set_pre
    node: 终点
    pre: [中间台阶]
`) as { id: number }
    await engine.graph.graphApply('edit', closing.id)
    const sealed = await readSealed()
    assert.ok(sealed, '收尾接线批 apply 落 sealed')
    assert.match(sealed!, /^\d{4}-\d{2}-\d{2}$/)

    // 收尾 + 达标 + 闭包健康 → 该终点达成
    const complete = (await engine.courseCompletion({ name: '数学', root: 'math' }))[0]!
    assert.equal(complete.complete, true, '收尾后达标判达成')
    assert.equal(complete.status, 'reached')
    assert.deepEqual(complete.criteria.last_steps.map(s => s.node), ['中间台阶'], '判据折叠自最后台阶（终点.pre 集）')
    assert.equal(complete.criteria.sealed, sealed)

    // 主线接线批重开（前进 + add_node + 声明朝向 + 终点接线）→ sealed 清除，完成回到未完成
    const reopen = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 目标扩了一级，重开主线
  target_endpoints: [终点]
ops:
  - op: add_node
    name: 更高台阶
    pre: [中间台阶]
    est: 15
  - op: set_pre
    node: 终点
    pre: [更高台阶]
`) as { id: number }
    await engine.graph.graphApply('edit', reopen.id)
    assert.equal(await readSealed(), undefined, '主线批重开清 sealed')
    const afterReopen = (await engine.courseCompletion({ name: '数学', root: 'math' }))[0]!
    assert.equal(afterReopen.criteria.mastery_met, false, '新最后台阶（更高台阶）未达标')
    assert.equal(afterReopen.status, 'unwired', '清 sealed 后回到未铺通')
    assert.equal(afterReopen.complete, false, '清 sealed 后不判达成')

    // 旁支批（不含终点 set_pre）apply 不动 sealed：先收尾再长旁支
    const reseal = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 再次收尾接线
ops:
  - op: set_pre
    node: 终点
    pre: [更高台阶]
`) as { id: number }
    await engine.graph.graphApply('edit', reseal.id)
    const side = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 旁支
  reason: 支线补台阶
ops:
  - op: add_node
    name: 支线台阶
    pre: [入门]
    est: 10
`) as { id: number }
    await engine.graph.graphApply('edit', side.id)
    assert.ok(await readSealed(), '旁支批不动 sealed')
  })
})

test('#202 折叠语义：未收尾不判完成 / 收尾后达标判完成 / 旧锚（无 sealed）向后兼容', async () => {
  await withVault({
    ...SEALED_VAULT,
    notes: {
      入门: MASTERED,
      中间台阶: MASTERED,
      终点: { stage: 'ready', content: { version: 1, status: 'ready' } },
    },
  }, async ({ engine }) => {
    // 无 sealed 字段的锚读取与折叠不炸
    const fold = (await engine.courseCompletion({ name: '数学', root: 'math' }))[0]!
    assert.equal(fold.criteria.sealed, null, '无 sealed 字段 = 未收尾')
    assert.equal(fold.complete, false)
    assert.equal(fold.status, 'unwired')
    assert.equal(fold.criteria.endpoint_in_graph, true)
    assert.ok(fold.criteria.closure_healthy, '闭包健康判据不动')
    assert.deepEqual(fold.criteria.last_steps.map(s => [s.node, s.met]), [['入门', true]], '判据 = 终点.pre 集逐条达标')
    // 闭包进度剔终点自身（方向标记不被学习）：只剩「入门」这一步
    assert.deepEqual(fold.closure, { learned: 1, total: 1 }, '闭包进度：前置步数（终点自身不计）')

    // 悬空锚：终点不在图内 → mastery_met=false 可见不炸
    const { Graph } = await import('../src/engine/graph.ts')
    const dangling = foldCompletion(new Graph([]), {}, [{
      endpoint: '不在图内', goal_type: 'capability', declared: '2026-09-01',
      origin_proposal: 1, seed_nodes: ['不在图内'], worksheet: [], start_basis: {},
    }])
    assert.equal(dangling.length, 1)
    assert.equal(dangling[0]!.criteria.endpoint_in_graph, false)
    assert.equal(dangling[0]!.criteria.mastery_met, false)
    assert.equal(dangling[0]!.status, 'unwired')
    assert.equal(dangling[0]!.complete, false)
  })
})

test('#202 sealed 落盘口径：夹带非 set_pre op 的零新增批不构成收尾宣告；非终点接线不动 sealed', async () => {
  await withVault({
    ...SEALED_VAULT,
    notes: {
      入门: { stage: 'ready' },
      中间台阶: { stage: 'ready' },
      终点: { stage: 'ready', content: { version: 1, status: 'reviewed' } },
    },
    files: [{ path: join('学习中心', 'math', 'state', '终点锚.json'), content: anchorDoc('终点', '2026-09-10') }],
  }, async ({ engine, paths }) => {
    const anchorPath = paths.anchorPath('math')
    const readSealed = async () => (await readAnchors(anchorPath, (await import('../src/host/vault-fs.ts')).nodeVaultFs))[0]?.sealed
    // 起点：已收尾
    assert.equal(await readSealed(), '2026-09-10')
    // 零 add_node 但夹带 set_note（非纯 set_pre 批）→ sealed 不写也不清
    const mixed = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 只改备注不接线
ops:
  - op: set_note
    node: 中间台阶
    note: 备注微调
`) as { id: number }
    await engine.graph.graphApply('edit', mixed.id)
    assert.equal(await readSealed(), '2026-09-10', '非接线批不动 sealed')
    // 纯 set_pre 批但接线的是别的节点（不触终点）→ sealed 不动
    const otherTarget = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 重接中间台阶前置
ops:
  - op: set_pre
    node: 中间台阶
    pre: [入门]
`) as { id: number }
    await engine.graph.graphApply('edit', otherTarget.id)
    assert.equal(await readSealed(), '2026-09-10', '非终点接线不动 sealed')
  })
})

test('#202/#239 锚条目校验：sealed 可选字段合法放行、坏日期拒收；无 sealed 照读', () => {
  const base = { endpoint: '终点', goal_type: 'capability', declared: '2026-09-01', origin_proposal: 1, seed_nodes: ['入门', '终点'] }
  const ok = validateEndpointAnchor({ ...base, sealed: '2026-09-13' }, 'anchors.0')
  assert.deepEqual(ok.errors, [])
  assert.equal((ok.anchor as EndpointAnchor).sealed, '2026-09-13')
  const legacy = validateEndpointAnchor(base, 'anchors.0')
  assert.deepEqual(legacy.errors, [], '无 sealed 照读')
  assert.equal((legacy.anchor as EndpointAnchor).sealed, undefined)
  const bad = validateEndpointAnchor({ ...base, sealed: '09/13/2026' }, 'anchors.0')
  assert.ok(bad.errors.some(e => e.includes('sealed: 必须是 YYYY-MM-DD 日期')))
})

test('#239 锚容器校验：空锚合法、未知键/版本门/终点重名拒收、逐条错误带条目定位', () => {
  const empty = validateAnchorBook({ version: 2, anchors: [] })
  assert.deepEqual(empty.errors, [], '零终点（空锚）是合法空态')
  assert.deepEqual(empty.book!.anchors, [])

  const entry = { endpoint: '终点', goal_type: 'capability', declared: '2026-09-01' }
  const two = validateAnchorBook({ version: 2, anchors: [entry, { ...entry, endpoint: '另一终点' }] })
  assert.deepEqual(two.errors, [])
  assert.deepEqual(two.book!.anchors.map(a => a.endpoint), ['终点', '另一终点'])

  const v1 = validateAnchorBook({ version: 1, endpoint: '终点' })
  assert.ok(v1.errors.some(e => e.includes('version: 必须是 2')), '旧单锚形状（v1）拒收')
  assert.ok(v1.errors.some(e => e.includes('anchors: 必须是列表')))

  const unknownTop = validateAnchorBook({ version: 2, anchors: [entry], extra: 1 })
  assert.ok(unknownTop.errors.some(e => e.includes('(顶层) 含未知字段')))

  const dup = validateAnchorBook({ version: 2, anchors: [entry, { ...entry }] })
  assert.ok(dup.errors.some(e => e.includes('终点重名')), '一个终点只许一条锚')

  const badEntry = validateAnchorBook({ version: 2, anchors: [entry, { endpoint: '' }] })
  assert.ok(badEntry.errors.some(e => e.startsWith('anchors.1.endpoint')), '逐条错误带条目定位')
})

test('#199 生成门：enqueueGeneration 对终点恒拒（不看就绪），非终点照常入队', async () => {
  await withVault(SEALED_VAULT, async ({ root }) => {
    const captured: unknown[] = []
    const ctx = {
      tools: { register: (t: unknown) => { captured.push(t); return () => undefined } },
      effect: () => undefined,
      webServer: { register: () => undefined },
    } as unknown as Context
    const rt = createHostRuntime(ctx, { vault: root, centerRel: '学习中心', logger: memLogger() })
    rt.flags.queuePaused = true // 泵保持安静：本测试只断言入队语义
    // 终点恒拒——就绪与否都拒，文案可读
    await assert.rejects(
      () => enqueueGeneration(rt, ctx, '数学', '终点'),
      /终点是方向标记，不被学习调度/,
    )
    await assert.rejects(
      () => enqueueGeneration(rt, ctx, '数学', '终点'),
      /生成门恒拒/,
    )
    // 非终点照常入队
    const r = await enqueueGeneration(rt, ctx, '数学', '入门')
    assert.equal(r.queued, true)
    // persistGenJobs 是 fire-and-forget：等落盘完成，避免 withVault 清理与写盘竞态
    const { existsSync } = await import('node:fs')
    const jobsFile = join(root, '学习中心', 'state', '生成任务.json')
    for (let i = 0; i < 50 && !existsSync(jobsFile); i++) await new Promise(res => setTimeout(res, 20))
    assert.ok(existsSync(jobsFile), '任务档已落盘')
  })
})

test('#199 生成门：contextPack 不为终点组装产料上下文（管线侧兜底）', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    await assert.rejects(
      () => engine.content2.contentPack('数学', '终点'),
      /终点是方向标记，不被学习调度/,
    )
    // 非终点照常组装
    const pack = await engine.content2.contentPack('数学', '入门')
    assert.match(pack, /生成上下文包：入门/)
  })
})

test('#199 T1/T2 不登记终点：前置节点进入学习时后继触发清单剔终点', async () => {
  const graph = [
    'nodes:',
    '  - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
    '  - { name: 普通后继, pre: [入门], opt: false, note: "", est: 20 }',
    '  - { name: 终点, pre: [入门], opt: false, note: "" }',
  ].join('\n')
  await withVault({
    graph,
    files: [{ path: join('学习中心', 'math', 'state', '终点锚.json'), content: anchorDoc() }],
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: [tfQuestion('q1')] },
  }, async ({ engine: e, paths }) => {
    // 首答把入门推进 learning（stage 变更触发 onStageChange → T1/T2 后继登记）
    const r = await e.content2.questionAnswer(async () => 'unused', '数学', '入门', 'q1', 'true', 30)
    assert.equal(r.correct, true)
    const queue = await readFile(join(paths.courseStateDir('math'), '生成队列.md'), 'utf8')
    assert.match(queue, /生成：普通后继/, '普通后继照常 T2 入队')
    assert.doesNotMatch(queue, /生成：终点/, '终点不入 T1/T2 触发清单')
  })
})

test('#199 学习者账剔终点：status 就绪存量/清单与推荐面都不含终点', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    // 入门已 review（done）→ 终点的全部前置达标：旧口径会把它列进就绪与推荐
    const status = await engine.statusJson()
    const course = status.courses.find(c => c.name === '数学')!
    assert.deepEqual(course.ready.map(r => r.node), ['中间台阶'], '就绪清单剔终点')
    assert.deepEqual(course.gated.map(g => g.node), ['中间台阶'], '软闸清单剔终点')

    const rec = await engine.recommend(30)
    const nodes = rec.events.filter(e => e.course === '数学').map(e => e.node)
    assert.ok(!nodes.includes('终点'), '推荐面不含终点')
    assert.ok(nodes.includes('中间台阶'), '普通就绪节点照常推荐')
  })
})

// ---- #239 多终点化：逐终点收尾与接线门（票面验收：接线终点 A 只给 A 写 sealed） ----

/** 两终点图：起点甲→终点甲、起点乙→终点乙（两条独立方向）。 */
const TWO_ENDPOINT_GRAPH = [
  'nodes:',
  '  - { name: 起点甲, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 起点乙, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 终点甲, pre: [起点甲], opt: false, note: "" }',
  '  - { name: 终点乙, pre: [起点乙], opt: false, note: "" }',
].join('\n')

const TWO_ENDPOINT_VAULT = {
  graph: TWO_ENDPOINT_GRAPH,
  files: [{
    path: join('学习中心', 'math', 'state', '终点锚.json'),
    content: anchorBook([
      { endpoint: '终点甲', seed_nodes: ['起点甲', '终点甲'], start_basis: { 起点甲: 'baseline' } },
      { endpoint: '终点乙', seed_nodes: ['起点乙', '终点乙'], start_basis: { 起点乙: 'baseline' } },
    ]),
  }],
  notes: { 起点甲: MASTERED, 起点乙: MASTERED },
}

test('#239 逐终点收尾：接线终点甲只给甲写 sealed，乙不受影响；甲重开主线只清甲的 sealed', async () => {
  await withVault(TWO_ENDPOINT_VAULT, async ({ engine, paths }) => {
    const nodeVaultFs = (await import('../src/host/vault-fs.ts')).nodeVaultFs
    const sealOf = async (endpoint: string): Promise<string | undefined> =>
      (await readAnchors(paths.anchorPath('math'), nodeVaultFs)).find(a => a.endpoint === endpoint)?.sealed
    // 起点：两条锚都未收尾（最后台阶已达标但没接线批宣告）
    assert.equal(await sealOf('终点甲'), undefined)
    assert.equal(await sealOf('终点乙'), undefined)

    // 收尾接线批（零 add_node 纯 set_pre）只接甲 → 只有甲落 sealed
    const closeA = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 甲方向已满足，停摆前接线
ops:
  - op: set_pre
    node: 终点甲
    pre: [起点甲]
`) as { id: number }
    await engine.graph.graphApply('edit', closeA.id)
    const sealedA = await sealOf('终点甲')
    assert.ok(sealedA, '接线的那一个终点落 sealed')
    assert.equal(await sealOf('终点乙'), undefined, '未接线的终点不受影响（逐终点独立）')

    // 逐终点读数：甲已达成、乙仍未接线
    const folds = await engine.courseCompletion({ name: '数学', root: 'math' })
    const byName = new Map(folds.map(f => [f.endpoint, f]))
    assert.equal(byName.get('终点甲')!.status, 'reached')
    assert.equal(byName.get('终点乙')!.status, 'unwired')
    assert.equal(byName.get('终点乙')!.criteria.sealed, null)

    // 甲重开主线（前进 + add_node + 声明朝甲）→ 只清甲的 sealed，乙照旧
    const reopenA = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 甲方向再进一级
  target_endpoints: [终点甲]
ops:
  - op: add_node
    name: 甲更高台阶
    pre: [起点甲]
    est: 15
  - op: set_pre
    node: 终点甲
    pre: [甲更高台阶]
`) as { id: number }
    await engine.graph.graphApply('edit', reopenA.id)
    assert.equal(await sealOf('终点甲'), undefined, '该终点重开主线清 sealed')
    assert.equal(await sealOf('终点乙'), undefined, '其他终点仍旧不受影响')
    const afterReopen = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.equal(afterReopen.find(f => f.endpoint === '终点甲')!.status, 'unwired', '甲回到未铺通（新最后台阶未达标）')
  })
})

test('#239 接线门多终点化（ADR-0076）：声明朝向逐终点接线受理、交汇合法、未声明/不在册拒收', async () => {
  await withVault(TWO_ENDPOINT_VAULT, async ({ engine, paths }) => {
    // 声明朝甲方向长：target_endpoints=[终点甲] + 甲接线 → 受理；乙的 pre 一字未动
    const growA = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 只朝甲方向长
  target_endpoints: [终点甲]
ops:
  - op: add_node
    name: 甲新台阶
    pre: [起点甲]
    est: 15
  - op: set_pre
    node: 终点甲
    pre: [甲新台阶]
`) as { id: number }
    assert.ok(growA.id > 0)
    await engine.graph.graphApply('edit', growA.id)
    const { GraphStore, Graph } = await import('../src/engine/graph.ts')
    const nodeVaultFs = (await import('../src/host/vault-fs.ts')).nodeVaultFs
    const graphOf = async (): Promise<Graph> =>
      new Graph(await new GraphStore(paths, paths.courseRoot('math'), nodeVaultFs).load())
    let graph = await graphOf()
    assert.deepEqual(graph.preOf['终点乙'], ['起点乙'], '未声明方向的接线不因本批漂移')
    assert.deepEqual(graph.preOf['终点甲'], ['甲新台阶'], '声明方向照常接线')

    // 交汇合法：同一新节点同批声明两个朝向、各带 set_pre → 同时进多个终点的 pre
    const junction = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 一级台阶同时服务两个方向（交汇）
  target_endpoints: [终点甲, 终点乙]
ops:
  - op: add_node
    name: 交汇台阶
    pre: [起点甲, 起点乙]
    est: 15
  - op: set_pre
    node: 终点甲
    pre: [交汇台阶]
  - op: set_pre
    node: 终点乙
    pre: [交汇台阶]
`) as { id: number }
    assert.ok(junction.id > 0)
    await engine.graph.graphApply('edit', junction.id)
    graph = await graphOf()
    assert.deepEqual(graph.preOf['终点甲'], ['交汇台阶'])
    assert.deepEqual(graph.preOf['终点乙'], ['交汇台阶'], '同一新节点可进多个终点的 pre（交汇节点）')

    // 声明不在册终点：拒收（锚由人手增删，提案不得凭空拼造方向）
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 朝不存在的方向长
  target_endpoints: [不存在的终点]
ops:
  - op: add_node
    name: 又一台阶
    pre: [起点甲]
    est: 10
`),
      /不是在册终点/,
    )

    // 未声明朝向：拒收（多终点化后不再有单锚桥梁期特例——没有方向就没有前进）
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 桥梁期的老写法
ops:
  - op: add_node
    name: 又一台阶
    pre: [起点甲]
    est: 10
`),
      /未声明朝向.*target_endpoints 必填/s,
    )
  })
})
