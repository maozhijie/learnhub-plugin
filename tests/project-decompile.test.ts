/**
 * 目标反编译（P-5 / #95）：输入「目标项目描述 + Vault 笔记」→ 反推里程碑计划草案
 * （project_plan 提案）+ 知识子图提案（图谱域单 pending gen 提案）各一份，双产物都走
 * 既有 Proposal 人审通道（逆向设计：4C/ID 任务分析 + PjBL）。
 *
 * - 纯函数：目标描述解析（空输入拒绝）、检索词派生（priorTerms 同口径）、双产物拆分校验
 *   （计划半区 = validatePlanArtifact、子图半区 = validateGenProposal，同一受理口径）、
 *   子图落点裁决（显式 course → append，缺省 → 新课程骨架 new）。
 * - 主链：播种注册笔记 → 反编译 → 恰好 1 个 pending 计划提案 + 1 个 pending 子图提案，
 *   上下文含 Vault 先验段；人审 apply 双双生效；reject 零副作用。
 * - 红线（ADR-0015 裁决 6 + ADR-0010）：反编译全程课程图 canonical、项目工作区、个人笔记
 *   零写入（apply 前零 canonical 写入；vault 检索只读）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decompileGoalOf, decompileRepairPrompt, decompileTerms, splitDecompileDoc, subgraphSpecOf } from '../src/engine/project-decompile.ts'
import { withVault } from './helpers/vault.ts'

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

/** 模型产出的反编译文档（plan 与 subgraph 双产物；合法形态）。 */
function decompileYaml(project: string, course: string): string {
  return `\
project: ${project}
plan:
  - id: m1
    name: 双手音阶连贯弹完
    task_class: 简：照谱复现
    acceptance_hints: C 大调两个八度双手连贯
    est: 600
    nodes: [数学/入门]
  - id: m2
    name: 完整弹会《野蜂飞舞》选段
    task_class: 繁：独立演绎
    acceptance_hints: 100 速度下完整弹完选段
    est: 900
subgraph:
  course: ${course}
  regions:
    - region: 演奏基础
      color: blue
      blocks:
        - name: 入手块
          nodes:
            - name: 持琴与手型
              pre: []
              opt: false
              note: 支撑 m1 的姿势底座
              est: 20
              enc: []
            - name: 音阶爬格
              pre: [持琴与手型]
              opt: false
              note: 支撑 m1 与 m2 的 daily 热身
              est: 25
              enc:
                - { node: 持琴与手型, w: 0.8 }
`
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

test('splitDecompileDoc：双产物各自过既有 schema 门；错误行聚合一次给出', () => {
  const good = splitDecompileDoc(JSON.parse(JSON.stringify({
    project: '练琴计划',
    plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }],
    subgraph: {
      course: '数学',
      regions: [{ region: '甲', color: 'blue', blocks: [{ name: '块', nodes: [{ name: '节点一', pre: [], opt: false, note: '', est: 20 }] }] }],
    },
  })), '练琴计划')
  assert.equal(good.errors.length, 0)
  assert.equal(good.plan!.length, 1)
  assert.equal(good.subgraph!.course, '数学')
  assert.equal(good.subgraph!.regions[0].blocks[0].nodes[0].name, '节点一')

  // 计划半区：project 不一致（先行拒绝）；条目缺字段走 validatePlanItems 错误行
  const mismatch = splitDecompileDoc({ project: '别的项目', plan: [] }, '练琴计划')
  assert.ok(mismatch.errors.some(e => e.includes('project')))
  const badPlan = splitDecompileDoc({ project: '练琴计划', plan: [{ id: '', name: '', task_class: '', acceptance_hints: '' }] }, '练琴计划')
  assert.ok(badPlan.errors.some(e => e.includes('plan.1.id')))

  // 子图半区：regions 缺失 / 节点未知字段（parseNode 同门）
  const badSub = splitDecompileDoc({ project: '练琴计划', plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }], subgraph: { course: '数学' } }, '练琴计划')
  assert.ok(badSub.errors.some(e => e.includes('regions')))
  const badNode = splitDecompileDoc({
    project: '练琴计划',
    plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }],
    subgraph: { course: '数学', regions: [{ region: '甲', blocks: [{ name: '块', nodes: [{ name: '坏', bogus: 1 }] }] }] },
  }, '练琴计划')
  assert.ok(badNode.errors.some(e => e.includes('未知字段')))

  // 顶层非映射
  assert.ok(splitDecompileDoc('not a map', '练琴计划').errors.length > 0)
})

test('subgraphSpecOf：显式目标课程 → append；缺省 → 模型自拟课程名 new（新课程骨架）', () => {
  assert.deepEqual(subgraphSpecOf({ course: '吉他', regions: [] }, '数学'), { course: '数学', mode: 'append' })
  assert.deepEqual(subgraphSpecOf({ course: '吉他', regions: [] }, undefined), { course: '吉他', mode: 'new' })
  assert.deepEqual(subgraphSpecOf({ course: '吉他', regions: [] }, '  '), { course: '吉他', mode: 'new' }, '空白课程名视同未给')
})

test('decompileRepairPrompt：修复轮携带原包 + 上次输出 + 逐条门禁清单', () => {
  const p = decompileRepairPrompt('原始包', '上次产出', ['  ✗ plan.1.name: 不能为空', '  ✗ regions: 不能为空'])
  assert.match(p, /原始包/)
  assert.match(p, /上次产出/)
  assert.match(p, /上一次输出未过双产物校验门/)
  assert.match(p, /plan\.1\.name/)
  assert.match(p, /regions/)
})

// ---- 主链：反编译 → 双 pending 提案 → 人审 apply 生效 / reject 零副作用 ----

test('反编译主链：恰好 1 个计划提案 + 1 个子图提案，上下文含 Vault 先验段；apply 双双生效', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const prompts: string[] = []
    const r = await engine.projectDecompile('练琴计划', { course: '数学' }, async prompt => {
      prompts.push(prompt)
      return decompileYaml('练琴计划', '吉他')
    })
    assert.equal(prompts.length, 1, '一次模型调用产出双产物')
    assert.match(prompts[0]!, /学习者已有理解（Vault 先验）/, '先验摘录注入反编译上下文')
    assert.match(prompts[0]!, /自学吉他/, '目标描述进上下文')
    assert.match(prompts[0]!, /吉他练习/, '注册笔记元数据进上下文')
    assert.equal(r.prior_hits >= 1, true, '注册笔记被先验检索命中')
    assert.equal(r.repaired, false)
    assert.equal(r.project, '练琴计划')
    // 恰好两个 pending 提案：project_plan（目标=项目 id）+ gen（目标=课程）
    const props = await engine.store.loadProposals()
    assert.equal(props.filter(p => p.status === 'pending').length, 2)
    const planProp = props.find(p => p.kind === 'project_plan')!
    assert.equal(planProp.course, '练琴计划')
    const subProp = props.find(p => p.kind === 'gen')!
    assert.equal(subProp.course, '数学', '显式目标课程 → append 提案落在该课程')
    assert.deepEqual(
      { plan: r.plan_proposal.id, sub: r.subgraph_proposal.id, subMode: r.subgraph_proposal.mode, subNodes: r.subgraph_proposal.nodes },
      { plan: planProp.id, sub: subProp.id, subMode: 'append', subNodes: 2 },
    )

    // 人审 apply：复用既有 apply 路径——计划落项目.md、子图落课程图
    const appliedPlan = await engine.projectApply(planProp.id)
    assert.equal(appliedPlan.kind, 'project_plan')
    const view = await engine.projectShow('练琴计划')
    assert.equal(view.fm.plan.length, 2)
    assert.equal(view.fm.plan[0]!.id, 'm1')
    const appliedSub = await engine.graphApply('gen', subProp.id)
    assert.equal(appliedSub.course, '数学')
    assert.equal(appliedSub.nodes, 4, '既有 2 节点 + 追加 2 节点')
    const { graph } = await engine.loadView(await engine.resolveCourse('数学'))
    assert.ok(graph.nset.has('持琴与手型'))
    assert.ok(graph.nset.has('音阶爬格'))
  })
})

test('反编译无目标课程：子图独立成「新课程骨架」型 gen(mode=new) 提案，apply 后注册表出现新课程', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const r = await engine.projectDecompile('练琴计划', {}, async () => decompileYaml('练琴计划', '吉他'))
    assert.equal(r.subgraph_proposal.mode, 'new')
    assert.equal(r.subgraph_proposal.course, '吉他')
    const subProp = (await engine.store.loadProposals()).find(p => p.kind === 'gen')!
    assert.equal(subProp.course, '吉他')
    const applied = await engine.graphApply('gen', subProp.id)
    assert.equal(applied.course, '吉他')
    const courses = await engine.enabledCourses()
    assert.ok(courses.some(c => c.name === '吉他'), '新课程骨架经人审 apply 入注册表')
    const { graph } = await engine.loadView((await engine.enabledCourses()).find(c => c.name === '吉他')!)
    assert.ok(graph.nset.has('音阶爬格'))
  })
})

test('reject 零副作用：双提案都拒绝后计划与课程图维持原状', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const r = await engine.projectDecompile('练琴计划', { course: '数学' }, async () => decompileYaml('练琴计划', '吉他'))
    await engine.graphReject(r.plan_proposal.id, '不要')
    await engine.graphReject(r.subgraph_proposal.id, '不要')
    const view = await engine.projectShow('练琴计划')
    assert.equal(view.fm.plan.length, 0, '计划未落盘')
    const { graph } = await engine.loadView(await engine.resolveCourse('数学'))
    assert.equal(graph.names.length, 2, '课程图未变')
    const props = await engine.store.loadProposals()
    assert.ok(props.every(p => p.status === 'rejected'))
  })
})

// ---- 红线：反编译全程零 canonical 写入 ----

/** 递归快照目录内全部文件（相对路径 → 内容 + mtimeMs）。 */
async function snapshot(dir: string): Promise<Map<string, { content: string; mtime: number }>> {
  const out = new Map<string, { content: string; mtime: number }>()
  async function walk(cur: string): Promise<void> {
    let entries
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const child = join(cur, ent.name)
      if (ent.isDirectory()) await walk(child)
      else if (ent.isFile()) {
        const st = await stat(child)
        out.set(child.slice(dir.length + 1), { content: await readFile(child, 'utf8'), mtime: st.mtimeMs })
      }
    }
  }
  await walk(dir)
  return out
}

test('红线：反编译全程课程图 canonical、项目工作区、个人笔记零写入（vault 检索只读）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine, root }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const beforeCourse = await snapshot(join(root, '学习中心', 'math'))
    const beforeProject = await snapshot(join(root, '学习中心', 'projects'))
    const beforeNotes = await snapshot(join(root, 'notes'))

    await engine.projectDecompile('练琴计划', { course: '数学' }, async () => decompileYaml('练琴计划', '吉他'))

    assert.deepEqual(await snapshot(join(root, '学习中心', 'math')), beforeCourse, '课程图 canonical（data/课程/题库）零写入')
    assert.deepEqual(await snapshot(join(root, '学习中心', 'projects')), beforeProject, '项目工作区（项目.md/plan）零写入')
    assert.deepEqual(await snapshot(join(root, 'notes')), beforeNotes, '个人笔记零写入（ADR-0010 只读纪律）')

    // 正向对照：写侧只发生在 Proposal 通道（提案记录 + 产物 YAML）
    const afterProps = await snapshot(join(root, '学习中心', 'state', 'proposals'))
    assert.equal([...afterProps.keys()].filter(f => f.endsWith('.yaml')).length, 2, '双提案产物全留痕')
  })
})

// ---- 校验门 ----

test('校验门：空目标描述被拒（模型零调用、零提案）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    let calls = 0
    await assert.rejects(
      engine.projectDecompile('练琴计划', { goal: '   ' }, async () => {
        calls++
        return decompileYaml('练琴计划', '吉他')
      }),
      /目标描述为空/,
    )
    assert.equal(calls, 0, '目标描述为空在拼包前拒绝，不烧模型调用')
    assert.equal((await engine.store.loadProposals()).length, 0)
  })
})

test('校验门：非法计划 YAML 未过双产物校验门——修复一轮仍败则双提案都不受理（DECOMPILE_GATE_FAILED）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const bad = 'project: 练琴计划\nplan:\n  - id: m1\n    name: 缺 task_class 与验收\nsubgraph:\n  course: 数学\n'
    let calls = 0
    const seen: string[] = []
    await assert.rejects(
      engine.projectDecompile('练琴计划', {}, async prompt => {
        calls++
        seen.push(prompt)
        return bad
      }),
      (err: unknown) => (err as Error & { code?: string }).code === 'DECOMPILE_GATE_FAILED',
    )
    assert.equal(calls, 2, '门禁清单回灌修复一轮（首跑 + 修复）')
    assert.match(seen[1]!, /上一次输出未过双产物校验门/, '修复轮携带门禁清单')
    assert.equal((await engine.store.loadProposals()).length, 0, '双提案同进同退：校验不过零受理')
  })
})

test('校验门：首跑未过门、修复轮通过 → 双提案正常受理（repaired 留痕）', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const bad = 'project: 练琴计划\nplan: []\nsubgraph: {}\n'
    let calls = 0
    const r = await engine.projectDecompile('练琴计划', { course: '数学' }, async prompt => {
      calls++
      return calls === 1 ? bad : decompileYaml('练琴计划', '吉他')
    })
    assert.equal(calls, 2)
    assert.equal(r.repaired, true)
    assert.equal((await engine.store.loadProposals()).filter(p => p.status === 'pending').length, 2)
  })
})

test('校验门：显式 notes 不在注册清单 fail loud；显式目标课程不存在 fail loud', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    const llm = async (): Promise<string> => {
      throw new Error('model must not be called')
    }
    await assert.rejects(engine.projectDecompile('练琴计划', { notes: ['note-404'] }, llm), /不在注册清单/)
    await assert.rejects(engine.projectDecompile('练琴计划', { course: '物理' }, llm), /注册表中没有课程「物理」/)
  })
})

test('校验门：目标项目不存在（Missing）fail loud', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await assert.rejects(engine.projectDecompile('幽灵项目', {}, async () => ''), /不存在/)
  })
})
