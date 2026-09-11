/**
 * 目标反编译（P-5 / #95，v8 种子簇形态 #149）：双提案 = 里程碑计划草案（project_plan）
 * + 知识子图种子簇（kind=seed，起点 basis 铸 project——种子三路之 project 路接线）。
 * 本文件覆盖：
 * - 纯函数面：目标描述解析、检索词派生、双产物拆分校验（计划半区 = validatePlanArtifact、
 *   种子半区 = validateSeedProposal 骨架模式——零 enc 零 est 零 pre）、名字对账门、修复轮提示词；
 * - 同源同进同退：受理侧门禁全过才落提案（对账失败零提案），pair 联动的联合 apply
 *   （种子先落图、计划后落盘——apply 时序缺口回归钉）、单边 apply 守卫、reject 联动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decompileGoalOf, decompileRepairPrompt, decompileTerms, reconcilePlanNodes, splitDecompileDoc } from '../src/engine/project-decompile.ts'
import { systemClock } from '../src/host/clock.ts'
import { YAML } from '../src/engine/yaml.ts'
import type { PlanItem } from '../src/engine/projects.ts'
import { withVault } from './helpers/vault.ts'
import { AgentSeam } from '../src/engine/agent.ts'

const TWO_NODE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 25 }',
].join('\n')

const GOAL = '自学吉他：三个月弹会《野蜂飞舞》选段'

/** 注册笔记（vault 中心外个人笔记）+ 镜像区源清单（V-1 manifest；标题含检索词）。 */
const NOTE_FILES = [
  {
    path: 'notes/吉他练习.md',
    content: '# 吉他练习\n\n自学吉他的每日记录：爬格子与音阶练习是底座，目标是三个月弹会《野蜂飞舞》选段。\n',
  },
]
const NOTE_MANIFEST = [
  'sources:',
  '  - id: note-1',
  '    path: notes/吉他练习.md',
  '    fingerprint: abcdef1234567890',
  '    title: 吉他练习',
].join('\n')

/** 反编译 vault：注册笔记 + 源清单种子（其余走默认基线）。 */
const DECOMPILE_VAULT = {
  graph: TWO_NODE_GRAPH,
  notes: { 入门: {}, 进阶: {} },
  files: [...NOTE_FILES, { path: '学习中心/笔记源/源清单.yaml', content: NOTE_MANIFEST }],
}

/** 模型产出的反编译文档（plan + seed 双半区；合法形态——种子概念铸名覆盖 teaches 引用）。 */
function decompileYaml(project: string, course = '吉他'): string {
  return `\
project: ${project}
plan:
  - id: m1
    name: 双手音阶连贯弹完
    task_class: 简：照谱复现
    acceptance_hints: C 大调两个八度双手连贯
    est: 600
    nodes: [${course}/音阶爬格]
  - id: m2
    name: 完整弹会《野蜂飞舞》选段
    task_class: 繁：独立演绎
    acceptance_hints: 100 速度下完整弹完选段
    est: 900
    nodes: [${course}/完整弹奏选段]
seed:
  course: ${course}
  goal_type: capability
  concepts:
    - canonical: 吉他基础
  endpoint:
    name: 完整弹奏选段
    region: 演奏
    block: 终点块
    note: 合成项目的最终能力
    teaches: {吉他基础: 会用}
  starts:
    - name: 持琴与手型
      region: 演奏
      block: 入手块
      note: 支撑 m1 的姿势底座
      teaches: {吉他基础: 知道}
    - name: 音阶爬格
      region: 演奏
      block: 入手块
      note: 支撑 m1 与 m2 的 daily 热身
      teaches: {吉他基础: 知道}
`
}

/** 录制型假实现：记 prompt/effort，固定回放同一应答。 */
function replayFake(reply: string) {
  return scriptFake([reply])
}

/** 脚本化假实现（#162 起注入 AgentSeam）：脚本化补全端口进缝，调用记录留在端口层
 * （prompt/语义档经缝直通）。按调用序回放（第 i 次调用回 replies[i]，越界取最后一条）。 */
function scriptFake(replies: string[]) {
  const calls: Array<{ prompt: string; effort?: string }> = []
  const seam = new AgentSeam({
    complete: async (prompt, _system, opts) => {
      calls.push({ prompt, effort: opts?.effort })
      return replies[Math.min(calls.length - 1, replies.length - 1)]!
    },
  }, systemClock)
  return Object.assign(seam, { calls })
}

async function projectOf(engine: Awaited<ReturnType<typeof withVault>>['engine'], goal = GOAL): Promise<void> {
  await engine.project.projectCreate({ name: '练琴计划', goal })
}

/** 计划条目构造（对账门只消费 nodes；其余字段按 schema 补全）。 */
function planOf(nodesPerItem: string[][]): PlanItem[] {
  return nodesPerItem.map((nodes, i) => ({
    id: `m${i + 1}`, name: `里程碑${i + 1}`, task_class: '简', acceptance_hints: '达标',
    ...(nodes.length ? { nodes } : {}),
  }))
}

// ---- 纯函数 ----

test('decompileGoalOf：显式参数优先、回落项目档案 goal；空目标描述 fail loud', () => {
  assert.equal(decompileGoalOf('  自己的目标  ', '档案目标'), '自己的目标')
  assert.equal(decompileGoalOf(undefined, '档案目标'), '档案目标')
  assert.throws(() => decompileGoalOf('   ', '档案目标'), /目标描述为空/)
  assert.throws(() => decompileGoalOf(undefined, ''), /目标描述为空/)
})

test('decompileTerms：目标描述与笔记标题同炉 priorTerms（去重保序）', () => {
  const terms = decompileTerms('自学吉他：三个月弹会《野蜂飞舞》', ['吉他练习', '自学吉他'])
  assert.equal(terms[0], '自学吉他')
  assert.ok(terms.includes('吉他练习'))
  assert.ok(terms.includes('三个月弹会《野蜂飞舞》'))
  assert.equal(new Set(terms).size, terms.length, '去重')
})

test('splitDecompileDoc：双半区各自过既有 schema 门；种子半区受理侧定写（mode=new、basis=project）', () => {
  const good = splitDecompileDoc(YAML.parseModel(decompileYaml('练琴计划')), '练琴计划', { expectSeed: true })
  assert.equal(good.errors.length, 0)
  assert.equal(good.result!.plan.length, 2)
  assert.equal(good.result!.seed!.course, '吉他')
  assert.equal(good.result!.seed!.mode, 'new', 'mode 由引擎锁 new（不信模型）')
  assert.ok(good.result!.seed!.starts.every(s => s.basis === 'project'), '起点 basis 铸 project（第三路接线）')
  assert.equal(good.result!.seed!.starts.length, 2)

  // 计划半区：project 不一致（先行拒绝）；条目缺字段走 validatePlanItems 错误行
  const mismatch = splitDecompileDoc({ project: '别的项目', plan: [] }, '练琴计划', { expectSeed: true })
  assert.ok(mismatch.errors.some(e => e.includes('project')))
  const badPlan = splitDecompileDoc({ project: '练琴计划', plan: [{ id: '', name: '', task_class: '', acceptance_hints: '' }] }, '练琴计划', { expectSeed: true })
  assert.ok(badPlan.errors.some(e => e.includes('plan.1.id')))

  // 种子半区 = 骨架模式门：est/enc/pre 一律拒收（种子零 enc 零 est，粗占位边引擎落）
  const fullNode = splitDecompileDoc({
    project: '练琴计划',
    plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }],
    seed: {
      course: '吉他', goal_type: 'capability',
      endpoint: { name: '终点', region: '区', block: '块' },
      starts: [{ name: '起点', region: '区', block: '块', est: 20, enc: [{ node: '终点', w: 0.8 }], pre: ['终点'] }],
    },
  }, '练琴计划', { expectSeed: true })
  assert.ok(fullNode.errors.some(e => e.includes('未知字段') && e.includes('est')), 'est 拒收')
  assert.ok(fullNode.errors.some(e => e.includes('未知字段') && e.includes('enc')), 'enc 拒收')
  assert.ok(fullNode.errors.some(e => e.includes('未知字段') && e.includes('pre')), 'pre 拒收')

  // 半区与落点模式互斥：显式课程 + seed 在场 = 拒；无课程 + seed 缺席 = 拒
  const withSeed = splitDecompileDoc(YAML.parseModel(decompileYaml('练琴计划')), '练琴计划', { expectSeed: false })
  assert.ok(withSeed.errors.some(e => e.includes('显式目标课程时不产种子半区')))
  const noSeed = splitDecompileDoc({ project: '练琴计划', plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }] }, '练琴计划', { expectSeed: true })
  assert.ok(noSeed.errors.some(e => e.includes('种子半区必出')))

  // 顶层非映射
  assert.ok(splitDecompileDoc('not a map', '练琴计划', { expectSeed: true }).errors.length > 0)
})

test('reconcilePlanNodes：名字对账门——引用必须有 种子簇∪既有图 着落；对账失败场景', () => {
  const seed = { course: '吉他', nodeNames: new Set(['持琴与手型', '音阶爬格', '完整弹奏选段']) }
  const existing = new Map<string, Set<string>>([['数学', new Set(['入门', '进阶'])]])

  // 全着落：种子簇 + 既有课程
  assert.deepEqual(
    reconcilePlanNodes(planOf([['吉他/音阶爬格'], ['吉他/完整弹奏选段', '数学/入门']]), { seed, existingByCourse: existing }),
    [],
  )

  // 对账失败：引用不在种子簇也不在既有图（构造场景：模型把 m1 挂到了还没长的节点）
  const dangling = reconcilePlanNodes(planOf([['吉他/弹唱编配']]), { seed, existingByCourse: existing })
  assert.equal(dangling.length, 1)
  assert.match(dangling[0]!, /弹唱编配/)
  assert.match(dangling[0]!, /不在种子簇节点名/)

  // 裸名：恰一着落——种子簇唯一命中或恰一门课程命中都放行；歧义（多门命中/种子∩既有）
  assert.deepEqual(reconcilePlanNodes(planOf([['音阶爬格']]), { seed, existingByCourse: existing }), [])
  assert.deepEqual(reconcilePlanNodes(planOf([['入门']]), { seed, existingByCourse: new Map([['数学', new Set(['入门'])]]) }), [])
  const bareMiss = reconcilePlanNodes(planOf([['不存在的节点']]), { seed, existingByCourse: existing })
  assert.match(bareMiss[0]!, /未落在种子簇或既有图节点名/)
  const twoCourses = new Map<string, Set<string>>([['数学', new Set(['入门'])], ['物理', new Set(['入门'])]])
  const ambiguous = reconcilePlanNodes(planOf([['入门']]), { seed, existingByCourse: twoCourses })
  assert.match(ambiguous[0]!, /多门课程中命中/)
  const bothHit = reconcilePlanNodes(planOf([['音阶爬格']]), { seed, existingByCourse: new Map([['数学', new Set(['音阶爬格'])]]) })
  assert.match(bothHit[0]!, /同时落在种子簇/)

  // 未注册课程前缀
  const noCourse = reconcilePlanNodes(planOf([['钢琴/入门']]), { seed, existingByCourse: existing })
  assert.match(noCourse[0]!, /课程「钢琴」不在注册表/)

  // 显式课程（无种子半区）形态：对账域只有既有图
  const explicitOnly = reconcilePlanNodes(planOf([['数学/进阶'], ['数学/即兴']]), { existingByCourse: existing })
  assert.equal(explicitOnly.length, 1)
  assert.match(explicitOnly[0]!, /数学\/即兴/)
})

test('decompileRepairPrompt：修复轮携带原包 + 上次输出 + 逐条门禁清单', () => {
  const p = decompileRepairPrompt('原始包', '上次产出', ['  ✗ plan.1.name: 不能为空', '  ✗ seed: 缺失'])
  assert.match(p, /原始包/)
  assert.match(p, /上次产出/)
  assert.match(p, /上一次输出未过双产物校验门/)
  assert.match(p, /plan\.1\.name/)
  assert.match(p, /seed/)
})

// ---- 门面：双提案受理 + 同源同进同退 ----

test('门面 v8：双提案 pair 互相指认、种子起点铸 project、概念铸名随种子提案', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    const llm = replayFake(decompileYaml('练琴计划'))
    const r = await engine.projectDecompile('练琴计划', {}, llm)
    assert.equal(r.repaired, false)
    assert.equal(r.pair.plan, r.plan_proposal.id)
    assert.equal(r.pair.seed, r.seed_proposal!.id)
    assert.equal(r.seed_proposal!.course, '吉他')
    assert.equal(r.seed_proposal!.starts, 2)
    // 提案记录：pair 互指
    const list = await engine.store.loadProposals()
    const plan = list.find(p => p.id === r.plan_proposal.id)!
    const seed = list.find(p => p.id === r.seed_proposal!.id)!
    assert.equal(plan.kind, 'project_plan')
    assert.equal(seed.kind, 'seed')
    assert.equal(plan.pair, seed.id)
    assert.equal(seed.pair, plan.id)
  })
})

test('对账失败 = 零提案（同进同退的静态半；修复一轮后仍失败 DECOMPILE_GATE_FAILED）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    // m1 引用「吉他/弹唱编配」——种子簇没有这个节点，对账门两次都拦
    const bad = decompileYaml('练琴计划').replace('吉他/音阶爬格', '吉他/弹唱编配')
    const llm = replayFake(bad)
    await assert.rejects(
      engine.projectDecompile('练琴计划', {}, llm),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, 'DECOMPILE_GATE_FAILED')
        assert.match(e.message, /双产物校验门/)
        assert.match(e.message, /弹唱编配/)
        assert.match(e.message, /不在种子簇节点名/)
        return true
      },
    )
    assert.equal(llm.calls.length, 2, '修复轮回灌一次（共两次调用）')
    assert.equal((await engine.store.loadProposals()).length, 0, '双提案任一不受理——零提案同退')
  })
})

test('单边 apply 守卫（apply 时序缺口回归钉）：pair 在场时计划/种子单独 apply 都拒收', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    const r = await engine.projectDecompile('练琴计划', {}, replayFake(decompileYaml('练琴计划')))
    // 计划先 apply = 计划引用悬空节点炸消费面——守卫拒收并指向联合入口
    await assert.rejects(engine.graph.projectApply(r.plan_proposal.id), /同进同退/)
    await assert.rejects(engine.graph.projectApply(r.plan_proposal.id), /decompile_apply/)
    await assert.rejects(engine.graphApply('seed', r.seed_proposal!.id), /同进同退/)
    // 两提案都还 pending（守卫发生在任何写盘前）
    const list = await engine.store.loadProposals()
    assert.ok(list.every(p => p.status === 'pending'))
  })
})

test('联合 apply：种子先落图（锚+簇节点+笔记脚手架）、计划后落盘；stub 行使回流 EMA 可用', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine, paths }) => {
    await projectOf(engine)
    const r = await engine.projectDecompile('练琴计划', {}, replayFake(decompileYaml('练琴计划')))
    const out = await engine.projectDecompileApply(r.pair.plan, r.pair.seed!)
    assert.ok(out.seed, '种子半区已生效')
    assert.equal((out.plan as { kind: string }).kind, 'project_plan')
    // 终点锚落盘、簇节点进图、笔记脚手架就位（消费面可解析）
    const { readFile } = await import('node:fs/promises')
    const anchor = JSON.parse(await readFile(paths.anchorPath('吉他'), 'utf8'))
    assert.equal(anchor.endpoint, '完整弹奏选段')
    assert.ok(anchor.seed_nodes.includes('音阶爬格'))
    const course = await engine.registry.get('吉他')
    assert.ok(course, 'mode=new 建课脚手架')
    const { graph } = await engine.loadView(course!)
    assert.ok(graph.nset.has('持琴与手型'))
    // 计划引用先有图可解析：stub（种子簇节点）行使即回流 EMA——时序缺口的消费面回归钉
    const exec = await engine.projectExecLog('练琴计划', { source: 'self', rating: 3, nodes: ['吉他/音阶爬格'] })
    assert.equal(exec.backflow.length, 1)
    assert.equal(exec.backflow[0]!.ema_after, 0.8)
    // 联合 apply 幂等重放：两半区已决 → 跳过不炸（崩溃恢复语义）
    const replay = await engine.projectDecompileApply(r.pair.plan, r.pair.seed!)
    assert.equal(replay.seed, null)
    assert.equal(replay.plan, null)
  })
})

test('reject 联动：任一半区被拒，pending 的另一半同退', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    const r = await engine.projectDecompile('练琴计划', {}, replayFake(decompileYaml('练琴计划')))
    await engine.graph.graphReject(r.pair.plan, '不想要这个方向')
    const list = await engine.store.loadProposals()
    const plan = list.find(p => p.id === r.pair.plan)!
    const seed = list.find(p => p.id === r.pair.seed)!
    assert.equal(plan.status, 'rejected')
    assert.equal(seed.status, 'rejected', '种子半区联动同拒')
    assert.match(seed.decision_note ?? '', /同源双提案同退/)
  })
})

test('显式目标课程：只产计划半区（nodes 对既有图对账）；模型多产 seed 半区走修复轮摘除', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    // 第一次带 seed 半区（显式课程下非法）→ 修复轮摘除 → 只落计划提案
    const planOnly = `\
project: 练琴计划
plan:
  - id: m1
    name: 双手音阶连贯弹完
    task_class: 简：照谱复现
    acceptance_hints: C 大调两个八度双手连贯
    est: 600
    nodes: [数学/入门]
`
    const bad = `${planOnly}seed:
  course: 吉他
  goal_type: capability
  endpoint: { name: 完整弹奏选段, region: 演奏, block: 终点块 }
  starts: [{ name: 持琴与手型, region: 演奏, block: 入手块 }]
`
    const llm = scriptFake([bad, planOnly])
    const r = await engine.projectDecompile('练琴计划', { course: '数学' }, llm)
    assert.equal(r.repaired, true)
    assert.equal(r.seed_proposal, null)
    assert.equal(r.pair.seed, null)
    const list = await engine.store.loadProposals()
    assert.equal(list.filter(p => p.status === 'pending').length, 1, '只落计划提案')
    assert.equal(list[0]!.pair, undefined, '单提案无 pair 联动')
    // 修订通道照常：apply 带 diff 触发面在 project-domain 测
    const applied = await engine.graph.projectApply(r.plan_proposal.id)
    assert.equal(applied.kind, 'project_plan')
  })
})
