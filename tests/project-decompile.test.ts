/**
 * 目标反编译（P-5 / #95；ADR-0076 / #240 种子降职——plan-only 形态）：反编译不再自带
 * 建课能力，目标课程必须已注册（未注册拒并指引先建课；课程入口 = 名称建课 + 手加终点），
 * 只产计划半区——计划引用既有图节点名，朝尚不存在节点的意图走计划修订驱动的教练补支。
 * 本文件覆盖：
 * - 纯函数面：目标描述解析、检索词派生、plan-only 拆分校验（计划半区 = validatePlanArtifact
 *   同门；模型仍产 seed 半区即拒）、名字对账门（引用 ⊆ 既有课程图节点名）、修复轮提示词；
 * - 门面：受理只落计划提案（seed_proposal/pair.seed 恒 null）、未指定/未注册课程拒 +
 *   先建课手加终点后成功的正反两 scenario、对账失败零提案（DECOMPILE_GATE_FAILED）、
 *   模型多产 seed 半区走修复轮摘除。
 * （ADR-0076 前 v8 的双提案 pair 联动/联合 apply/reject 联动退役：存量 pending 对仍可走
 * projectDecompileApply，但公开 API 不再产新对——动态半的回归面移交存量机制，此处不构造。）
 */
import { memLogger } from './helpers/logger.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { decompileGoalOf, decompileRepairPrompt, decompileTerms, reconcilePlanNodes, splitDecompileDoc } from '../src/engine/practice/project-decompile.ts'
import { Content } from '../src/engine/content/content.ts'
import { systemClock } from '../src/host/clock.ts'
import { YAML } from '../src/engine/yaml.ts'
import type { PlanItem } from '../src/engine/practice/projects.ts'
import { withVault } from './helpers/vault.ts'
import { AgentSeam } from '../src/engine/agent.ts'

/** 模板原文（契约后置的修复轮断言用：#218 起 decompileRepairPrompt 收模板与材料两半）。 */
const TPL = Content.PROMPT_KINDS['项目目标反编译']!

// #284 存储塌缩：单文件 data/图.yaml { nodes: [...] }
const TWO_NODE_GRAPH = [
  'nodes:',
  '  - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '  - { name: 进阶, pre: [入门], opt: false, note: "", est: 25 }',
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

/** 模型产出的反编译文档（plan-only，ADR-0076：YAML 顶层只剩 project+plan）；计划
 * 引用已注册课程的既有图节点名（默认挂「数学」的入门/进阶两节点）。 */
function decompileYaml(project: string, course = '数学'): string {
  return `\
project: ${project}
plan:
  - id: m1
    name: 双手音阶连贯弹完
    task_class: 简：照谱复现
    acceptance_hints: C 大调两个八度双手连贯
    est: 600
    nodes: [${course}/入门]
  - id: m2
    name: 完整弹会《野蜂飞舞》选段
    task_class: 繁：独立演绎
    acceptance_hints: 100 速度下完整弹完选段
    est: 900
    nodes: [${course}/进阶]
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
  const seam = new AgentSeam({ logger: memLogger(),
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

test('splitDecompileDoc：plan-only 拆分（计划半区过既有 schema 门）；模型仍产 seed 半区即拒（ADR-0076）', () => {
  // plan-only 合法形态：计划半区过 validatePlanArtifact 同门，DecompileDoc 无 seed 域
  const good = splitDecompileDoc(YAML.parseModel(decompileYaml('练琴计划')), '练琴计划')
  assert.equal(good.errors.length, 0)
  assert.equal(good.result!.plan.length, 2)
  assert.equal(good.result!.seed, undefined, 'DecompileDoc 无 seed 域（plan-only）')

  // 带 seed 半区即拒：错误行指引先建课再反编译（新知识走计划修订驱动的教练补支）
  const withSeed = splitDecompileDoc({
    project: '练琴计划',
    plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }],
    seed: { course: '吉他', goal_type: 'capability', endpoint: { name: '终点', region: '区', block: '块' } },
  }, '练琴计划')
  assert.equal(withSeed.result, undefined)
  assert.ok(withSeed.errors.some(e => e.includes('seed: 反编译不再自带建课能力')))
  assert.ok(withSeed.errors.some(e => e.includes('先建课再反编译')))

  // 计划半区：project 不一致（先行拒绝）；条目缺字段走 validatePlanItems 错误行
  const mismatch = splitDecompileDoc({ project: '别的项目', plan: [] }, '练琴计划')
  assert.ok(mismatch.errors.some(e => e.includes('project')))
  const badPlan = splitDecompileDoc({ project: '练琴计划', plan: [{ id: '', name: '', task_class: '', acceptance_hints: '' }] }, '练琴计划')
  assert.ok(badPlan.errors.some(e => e.includes('plan.1.id')))

  // 顶层非映射
  assert.ok(splitDecompileDoc('not a map', '练琴计划').errors.length > 0)
})

test('reconcilePlanNodes：名字对账门——引用必须落在既有课程图节点（无歧义）；对账失败场景', () => {
  const existing = new Map<string, Set<string>>([['数学', new Set(['入门', '进阶'])]])

  // 全着落：显式「课程/节点」引用既有图
  assert.deepEqual(
    reconcilePlanNodes(planOf([['数学/入门'], ['数学/进阶']]), { existingByCourse: existing }),
    [],
  )

  // 对账失败：显式课程引用悬空节点（构造场景：模型把 m1 挂到了还没长的节点）
  const dangling = reconcilePlanNodes(planOf([['数学/弹唱编配']]), { existingByCourse: existing })
  assert.equal(dangling.length, 1)
  assert.match(dangling[0]!, /弹唱编配/)
  assert.match(dangling[0]!, /引用的节点不在课程「数学」图内/)
  assert.match(dangling[0]!, /计划修订驱动的教练补支/)

  // 裸名：恰一着落放行；多门课程命中是歧义；零命中悬空
  assert.deepEqual(reconcilePlanNodes(planOf([['入门']]), { existingByCourse: existing }), [])
  const bareMiss = reconcilePlanNodes(planOf([['不存在的节点']]), { existingByCourse: existing })
  assert.match(bareMiss[0]!, /未落在既有图节点名中/)
  const twoCourses = new Map<string, Set<string>>([['数学', new Set(['入门'])], ['物理', new Set(['入门'])]])
  const ambiguous = reconcilePlanNodes(planOf([['入门']]), { existingByCourse: twoCourses })
  assert.match(ambiguous[0]!, /多门课程中命中/)

  // 未注册课程前缀
  const noCourse = reconcilePlanNodes(planOf([['钢琴/入门']]), { existingByCourse: existing })
  assert.match(noCourse[0]!, /课程「钢琴」不在注册表/)
})

test('decompileRepairPrompt：修复轮携带原材料 + 上次输出 + 逐条门禁清单，契约段仍居尾（#218）', () => {
  const p = decompileRepairPrompt(TPL, '原材料', '上次产出', [
    '  ✗ plan.1.name: 不能为空',
    '  ✗ plan.2.nodes.1「即兴」引用的节点不在课程「数学」图内——计划必须引用既有图节点（朝尚不存在节点的意图走计划修订驱动的教练补支）',
  ])
  assert.match(p, /原材料/)
  assert.match(p, /上次产出/)
  assert.match(p, /上一次输出未过双产物校验门/)
  assert.match(p, /plan\.1\.name/)
  assert.match(p, /计划修订驱动的教练补支/)
  // 契约后置（#218）：回灌反馈是材料，模板的输出契约段仍是最终 prompt 的末段
  assert.ok(p.indexOf('只输出一个 YAML 文档') > p.indexOf('上一次输出未过双产物校验门'), '契约段在反馈块之后')
})

// ---- 门面：plan-only 受理（种子降职后只产计划提案）----

test('门面 plan-only（ADR-0076；#256 种子链退役）：受理只落计划提案（无 seed_proposal/pair）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    const llm = replayFake(decompileYaml('练琴计划'))
    const r = await engine.project.projectDecompile('练琴计划', { course: '数学' }, llm)
    assert.equal(r.repaired, false)
    assert.equal(r.plan_proposal.kind, 'project_plan')
    assert.equal('seed_proposal' in r, false, '种子半区退役：反编译不再产种子提案（#256）')
    assert.equal('pair' in r, false, 'pair 联动机械随种子链退役（#256）')
    // 提案记录：单提案
    const list = await engine.store.loadProposals()
    assert.equal(list.filter(p => p.status === 'pending').length, 1, '只落计划提案')
    const plan = list.find(p => p.id === r.plan_proposal.id)!
    assert.equal(plan.kind, 'project_plan')
    assert.equal(plan.pair, undefined, '单提案无 pair 联动')
  })
})

test('门面落点裁决（ADR-0076）：未指定/未注册课程即拒并指引先建课；建课 + 手加终点后反编译成功', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    const llm = replayFake(decompileYaml('练琴计划'))
    // 反一：未指定 course——反编译不再自带建课能力（旧「省略 course 自动建课」即拒）
    await assert.rejects(
      engine.project.projectDecompile('练琴计划', {}, llm),
      /未指定目标课程——反编译不再自带建课能力（ADR-0076）：先建课（名称即空图），再显式 course 参数指向它/,
    )
    // 反二：course 未注册——注册表没有「吉他」
    await assert.rejects(
      engine.project.projectDecompile('练琴计划', { course: '吉他' }, llm),
      /注册表中没有课程「吉他」——先建课（名称即空图）再反编译/,
    )
    assert.equal((await engine.store.loadProposals()).length, 0, '落点裁决拒在受理前——零提案')
    assert.equal(llm.calls.length, 0, '落点裁决在模型调用之前（不烧 token）')

    // 正：先建课（名称即空图）→ 手加终点 → 显式 course 指向它 → 反编译成功
    await engine.graph.createCourse('吉他')
    await engine.graph.addEndpoint('吉他', '完整弹奏选段', '合成项目的最终能力')
    const planOnly = `\
project: 练琴计划
plan:
  - id: m1
    name: 完整弹会《野蜂飞舞》选段
    task_class: 繁：独立演绎
    acceptance_hints: 100 速度下完整弹完选段
    est: 900
    nodes: [吉他/完整弹奏选段]
`
    const llm2 = replayFake(planOnly)
    const r = await engine.project.projectDecompile('练琴计划', { course: '吉他' }, llm2)
    assert.equal(r.plan_proposal.milestones, 1)
    const list = await engine.store.loadProposals()
    assert.equal(list.filter(p => p.status === 'pending').length, 1, '只落计划提案')
    // 修订通道照常：apply 带 diff 触发面在 project-domain 测
    const applied = await engine.graph.projectApply(r.plan_proposal.id)
    assert.equal(applied.kind, 'project_plan')
  })
})

test('对账失败 = 零提案（受理侧质量门的静态半；修复一轮后仍失败 DECOMPILE_GATE_FAILED）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    // m1 引用「数学/弹唱编配」——数学图没有这个节点，对账门两次都拦
    const bad = decompileYaml('练琴计划').replace('数学/入门', '数学/弹唱编配')
    const llm = replayFake(bad)
    await assert.rejects(
      engine.project.projectDecompile('练琴计划', { course: '数学' }, llm),
      (e: Error & { code?: string }) => {
        assert.equal(e.code, 'DECOMPILE_GATE_FAILED')
        assert.match(e.message, /双产物校验门/)
        assert.match(e.message, /弹唱编配/)
        assert.match(e.message, /引用的节点不在课程「数学」图内/)
        return true
      },
    )
    assert.equal(llm.calls.length, 2, '修复轮回灌一次（共两次调用）')
    assert.equal((await engine.store.loadProposals()).length, 0, '对账不过不落提案——零提案同退')
  })
})

test('模型多产 seed 半区：修复轮摘除（ADR-0076 即拒）→ 只落计划提案', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await projectOf(engine)
    const planOnly = decompileYaml('练琴计划')
    // 第一次带 seed 半区（plan-only 形态下非法）→ 修复轮摘除 → 只落计划提案
    const bad = `${planOnly}seed:
  course: 吉他
  goal_type: capability
  endpoint: { name: 完整弹奏选段, region: 演奏, block: 终点块 }
  starts: [{ name: 持琴与手型, region: 演奏, block: 入手块 }]
`
    const llm = scriptFake([bad, planOnly])
    const r = await engine.project.projectDecompile('练琴计划', { course: '数学' }, llm)
    assert.equal(r.repaired, true)
    const list = await engine.store.loadProposals()
    assert.equal(list.filter(p => p.status === 'pending').length, 1, '只落计划提案')
    assert.equal(list[0]!.pair, undefined, '单提案无 pair 联动')
    // 修订通道照常：apply 带 diff 触发面在 project-domain 测
    const applied = await engine.graph.projectApply(r.plan_proposal.id)
    assert.equal(applied.kind, 'project_plan')
  })
})
