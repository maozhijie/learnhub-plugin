import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { validateAnchor, readAnchor, foldCompletion } from '../src/engine/seed.ts'
import type { EndpointAnchor } from '../src/engine/seed.ts'
import { createHostRuntime } from '../src/host/runtime.ts'
import { enqueueGeneration } from '../src/host/jobs.ts'
import { withVault, noteText, tfQuestion } from './helpers/vault.ts'

// 终点性不变式（#198/#199/#202 / ADR-0055+0056）：
// - #198 受理门：① 任何 add_node 以终点为 pre 拒（禁长过目标）；② 主线批（前进/换向）
//   含新节点必须 set_pre 接线终点（替换语义，新前沿全部汇入终点闭包）；③ 收尾接线批
//   （零 add_node 纯 set_pre）合法；旁支/巩固/插入豁免接线；锚保护既有范围不变。
// - #199 生成门：终点 generate 恒拒（不看就绪）、contextPack 不为终点组装、T1/T2 不
//   登记终点、学习者就绪清单与推荐面剔终点。
// - #202 终点纯标记化：完成判据折叠自最后台阶（终点.pre 集全部 ≥ 阈值）+ 收尾事实
//   sealed 进锚（收尾接线批 apply 写、主线接线批 apply 清）+ 旧锚向后兼容。

/** 双节点图：入门（起点）→ 终点；再加一个旁支后继 A 供 T1/T2 对照。 */
const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 中间台阶, pre: [入门], opt: false, note: "", est: 20 }',
  '      - { name: 终点, pre: [入门], opt: false, note: "" }',
].join('\n')

/** 锚文件原文（写侧通道只有种子 apply 与 sealed 维护；测试经 files 逃生口直接落盘）。 */
function anchorDoc(endpoint = '终点', sealed?: string): string {
  const doc: Record<string, unknown> = {
    version: 1,
    endpoint,
    goal_type: 'capability',
    declared: '2026-09-01',
    origin_proposal: 1,
    seed_nodes: ['入门', endpoint],
    start_basis: { 入门: 'baseline' },
  }
  if (sealed) doc.sealed = sealed
  return JSON.stringify(doc, null, 1) + '\n'
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
    region: 基础
    block: 入门块
    pre: [终点]
    est: 20
`),
      /目标之后不是本课程的生长域|禁长过目标/,
    )
  })
})

test('#198② 主线批（前进）含新节点缺接线终点 → 受理门拒收（回灌语义的拒因可读）', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 前沿缺下一台阶
ops:
  - op: add_node
    name: 新台阶
    region: 基础
    block: 入门块
    pre: [入门]
    est: 15
`),
      /未接线终点.*set_pre/s,
    )
    // 接线在场但未覆盖批内新前沿（新前沿 = 不被批内其他新节点消费的新节点）→ 同拒
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 前沿缺下一台阶
ops:
  - op: add_node
    name: 新台阶
    region: 基础
    block: 入门块
    pre: [入门]
    est: 15
  - op: set_pre
    node: 终点
    pre: [入门]
`),
      /未覆盖批内新前沿.*新台阶/s,
    )
    // 换向批同受接线义务约束
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 换向
  reason: 批注指向变化
ops:
  - op: add_node
    name: 新方向
    region: 基础
    block: 入门块
    pre: [入门]
    est: 15
`),
      /未接线终点/s,
    )
  })
})

test('#198③ 主线批接线合规受理 + 收尾接线批（零 add_node 纯 set_pre）合法', async () => {
  await withVault(SEALED_VAULT, async ({ engine }) => {
    // 前进批带完整接线：新前沿汇入终点闭包 → 受理
    const mainline = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 前沿缺下一台阶
ops:
  - op: add_node
    name: 新台阶
    region: 基础
    block: 入门块
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
    region: 基础
    block: 入门块
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
    // 起点：未收尾——pre 集全达标也不判完成（ mastery_met=true 但 sealed=null ）
    const before = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.ok(before)
    assert.equal(before!.criteria.mastery_met, true, '最后台阶（终点.pre=入门）全达标')
    assert.equal(before!.criteria.sealed, null)
    assert.equal(before!.complete, false, '未收尾不判完成')

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
    const sealedAnchor = await readAnchor(anchorPath, (await import('../src/host/vault-fs.ts')).nodeVaultFs)
    assert.ok(sealedAnchor?.sealed, '收尾接线批 apply 落 sealed')
    assert.match(sealedAnchor!.sealed!, /^\d{4}-\d{2}-\d{2}$/)
    const sealed = sealedAnchor!.sealed!

    // 收尾 + 达标 + 闭包健康 → 完成宣告成立
    const complete = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.ok(complete)
    assert.equal(complete!.complete, true, '收尾后达标判完成')
    assert.deepEqual(complete!.criteria.last_steps.map(s => s.node), ['中间台阶'], '判据折叠自最后台阶（终点.pre 集）')
    assert.equal(complete!.criteria.sealed, sealed)

    // 主线接线批重开（前进 + add_node + 终点接线）→ sealed 清除，完成回到未完成
    const reopen = await engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 目标扩了一级，重开主线
ops:
  - op: add_node
    name: 更高台阶
    region: 基础
    block: 入门块
    pre: [中间台阶]
    est: 15
  - op: set_pre
    node: 终点
    pre: [更高台阶]
`) as { id: number }
    await engine.graph.graphApply('edit', reopen.id)
    const reopened = await readAnchor(anchorPath, (await import('../src/host/vault-fs.ts')).nodeVaultFs)
    assert.equal(reopened?.sealed, undefined, '主线批重开清 sealed')
    const afterReopen = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.ok(afterReopen)
    assert.equal(afterReopen!.criteria.mastery_met, false, '新最后台阶（更高台阶）未达标')
    assert.equal(afterReopen!.complete, false, '清 sealed 后回到未完成')
    void sealed

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
    region: 基础
    block: 入门块
    pre: [入门]
    est: 10
`) as { id: number }
    await engine.graph.graphApply('edit', side.id)
    const afterSide = await readAnchor(anchorPath, (await import('../src/host/vault-fs.ts')).nodeVaultFs)
    assert.ok(afterSide?.sealed, '旁支批不动 sealed')
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
    // 旧锚形状（无 sealed 字段）读取与折叠不炸
    const fold = await engine.courseCompletion({ name: '数学', root: 'math' })
    assert.ok(fold)
    assert.equal(fold!.criteria.sealed, null, '旧锚缺字段 = 未收尾')
    assert.equal(fold!.complete, false)
    assert.equal(fold!.criteria.endpoint_in_graph, true)
    assert.ok(fold!.criteria.closure_healthy, '闭包健康判据不动')
    assert.deepEqual(fold!.criteria.last_steps.map(s => [s.node, s.met]), [['入门', true]], '判据 = 终点.pre 集逐条达标')

    // 悬空锚：终点不在图内 → mastery_met=false 可见不炸
    const { Graph } = await import('../src/engine/graph.ts')
    const dangling = foldCompletion(new Graph([]), {}, { version: 1, endpoint: '不在图内', goal_type: 'capability', declared: '2026-09-01', origin_proposal: 1, seed_nodes: ['不在图内'] })
    assert.ok(dangling)
    assert.equal(dangling!.criteria.endpoint_in_graph, false)
    assert.equal(dangling!.criteria.mastery_met, false)
    assert.equal(dangling!.complete, false)
  })
})

test('#202 validateAnchor：sealed 可选字段合法放行、坏日期拒收；旧锚零 sealed 照读', () => {
  const base = { version: 1, endpoint: '终点', goal_type: 'capability', declared: '2026-09-01', origin_proposal: 1, seed_nodes: ['入门', '终点'] }
  const ok = validateAnchor({ ...base, sealed: '2026-09-13' })
  assert.deepEqual(ok.errors, [])
  assert.equal((ok.anchor as EndpointAnchor).sealed, '2026-09-13')
  const legacy = validateAnchor(base)
  assert.deepEqual(legacy.errors, [], '旧锚无 sealed 照读')
  assert.equal((legacy.anchor as EndpointAnchor).sealed, undefined)
  const bad = validateAnchor({ ...base, sealed: '09/13/2026' })
  assert.ok(bad.errors.some(e => e.includes('sealed: 必须是 YYYY-MM-DD 日期')))
})

test('#199 生成门：enqueueGeneration 对终点恒拒（不看就绪），非终点照常入队', async () => {
  await withVault(SEALED_VAULT, async ({ root }) => {
    const captured: unknown[] = []
    const ctx = {
      tools: { register: (t: unknown) => { captured.push(t); return () => undefined } },
      effect: () => undefined,
      webServer: { register: () => undefined },
    } as unknown as Context
    const rt = createHostRuntime(ctx, { vault: root, centerRel: '学习中心' })
    rt.flags.queuePaused = true // 泵保持安静：本测试只断言入队语义
    // 终点恒拒——就绪与否都拒，文案可读
    await assert.rejects(
      () => enqueueGeneration(rt, ctx, '数学', '终点'),
      /终点是承诺标记，不被学习调度/,
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
      /终点是承诺标记，不被学习调度/,
    )
    // 非终点照常组装
    const pack = await engine.content2.contentPack('数学', '入门')
    assert.match(pack, /生成上下文包：入门/)
  })
})

test('#199 T1/T2 不登记终点：前置节点进入学习时后继触发清单剔终点', async () => {
  const graph = [
    'region: 基础',
    'color: blue',
    'blocks:',
    '  - name: 入门块',
    '    nodes:',
    '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
    '      - { name: 普通后继, pre: [入门], opt: false, note: "", est: 20 }',
    '      - { name: 终点, pre: [入门], opt: false, note: "" }',
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
