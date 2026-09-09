/**
 * 项目域（P 区 / ADR-0015；#92 可修订里程碑计划与渐退档模板）。
 *
 * - Proposal store 泛化：kind 扩 project_plan/project_milestone；计划修订走带快照的
 *   提案通道（快照 = 被替换的计划 YAML / 产物旧文），不静默覆盖。
 * - 渐退三档（骨架/补全/独立）产物形态：轻量结构机检（四块齐全/验收清单条目/无题目
 *   泄漏/档位一致性），首生直落、重生成必走提案。
 * - 红线：项目域全路径零 canonical 写入——sessions/srs/xp 与课程笔记 frontmatter 不动
 *   （ADR-0015 裁决 7：节点消费者对 Project 不可见）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validatePlanItems, validatePlanArtifact, validateMilestoneArtifact,
  gateMilestone, milestoneFileOf, PROJECT_LIFECYCLES, FADING_TIERS,
} from '../src/engine/projects.ts'
import { Content } from '../src/engine/content.ts'
import { withVault } from './helpers/vault.ts'

// ---- 纯函数：计划 schema ----

const PLAN_OK = [
  { id: 'm1', name: '跑通环境', task_class: '简：工具链操作', acceptance_hints: '能离线运行 hello world' },
  { id: 'm2', name: '写出记录器', task_class: '中：状态管理', acceptance_hints: '数据落盘可重放' },
]

test('计划 schema：缺字段/重复 id 报错行；空列表合法（项目可无计划）', () => {
  assert.deepEqual(validatePlanItems(PLAN_OK).errors, [])
  const bad = validatePlanItems([
    { id: 'm1', name: '', task_class: 'x', acceptance_hints: 'y' },
    { id: 'm1', name: '重复', task_class: 'x', acceptance_hints: 'y' },
    { id: '', name: '缺id', task_class: 'x', acceptance_hints: 'y' },
  ])
  assert.equal(bad.errors.length, 3)
  assert.match(bad.errors[0], /name: 不能为空/)
  assert.match(bad.errors[1], /id「m1」重复/)
  assert.match(bad.errors[2], /id: 不能为空/)
  assert.deepEqual(validatePlanItems([]).errors, [])
  assert.match(validatePlanItems('no').errors[0], /必须是列表/)
})

test('计划提案产物校验：project 不一致 / 空计划拒绝', () => {
  assert.deepEqual(validatePlanArtifact({ project: '吉他', plan: PLAN_OK }, '吉他').errors, undefined)
  assert.match(validatePlanArtifact({ project: '别的', plan: PLAN_OK }, '吉他')!.errors![0], /不一致/)
  assert.match(validatePlanArtifact({ project: '吉他', plan: [] }, '吉他')!.errors![0], /plan: 不能为空/)
  assert.match(validateMilestoneArtifact({ project: '别的', milestone: 'm1', md: 'x' }, '吉他')!.errors![0], /不一致/)
  assert.match(validateMilestoneArtifact({ project: '吉他', milestone: '', md: 'x' }, '吉他')!.errors![0], /milestone/)
})

// ---- 纯函数：轻量结构门（三档形态） ----

function card(blocks: Record<string, string>): string {
  return Object.entries(blocks).map(([h, b]) => `## ${h}\n\n${b}`).join('\n\n')
}

const GIVEN = '一份可运行的半成品。'
const CHECK = '- [ ] 打开文件能看到数据\n- [ ] 修改后能保存'

test('结构门：四块齐全 + 验收清单条目 + 无题目泄漏 → 通过（补全档）', () => {
  const md = card({ 给定: '部分成品 +【待补全】缺口', 待办: '补上缺口', 验收清单: CHECK, 支持: '关键提示' })
  const g = gateMilestone(md, '补全')
  assert.equal(g.passed, true, g.findings.join('；'))
})

test('结构门：缺块/空块/无清单条目/题目泄漏 → findings', () => {
  const missing = gateMilestone(card({ 待办: 'x', 验收清单: CHECK, 支持: 'y' }), '补全')
  assert.match(missing.findings.join('\n'), /缺少「## 给定」块/)

  const emptyGiven = gateMilestone(card({ 给定: '  ', 待办: 'x', 验收清单: CHECK, 支持: 'y' }), '骨架')
  assert.match(emptyGiven.findings.join('\n'), /「给定」块为空/)

  const noItems = gateMilestone(card({ 给定: GIVEN, 待办: 'x', 验收清单: '自己看着办', 支持: 'y' }), '独立')
  assert.match(noItems.findings.join('\n'), /没有 - \[ \] 条目/)

  const quizLeak = gateMilestone(
    card({ 给定: GIVEN, 待办: 'x', 验收清单: CHECK, 支持: 'y' }) + '\n\n<!-- ex:1 | answer: A -->', '补全')
  assert.match(quizLeak.findings.join('\n'), /不出题/)

  const bankLeak = gateMilestone(
    card({ 给定: GIVEN, 待办: 'x', 验收清单: CHECK, 支持: 'y' }) + '\n\n```yaml\nkind: single_choice\n```', '补全')
  assert.match(bankLeak.findings.join('\n'), /题库题目 schema/)
})

test('结构门档位一致性：独立档出现【待补全】→ finding；各档正常形态 → 通过', () => {
  const independent = gateMilestone(card({ 给定: '情境起点 +【待补全】', 待办: '自主完成', 验收清单: '- [ ] 达标', 支持: '自查提示' }), '独立')
  assert.match(independent.findings.join('\n'), /独立档「给定」出现【待补全】/)

  for (const tier of FADING_TIERS) {
    const md = tier === '补全'
      ? card({ 给定: '半成品+【待补全】缺口', 待办: '补全缺口', 验收清单: '- [ ] 覆盖缺口', 支持: '关键提示' })
      : tier === '骨架'
        ? card({ 给定: '近完整示范+分步说明', 待办: '照做复现', 验收清单: '- [ ] 步骤一\n- [ ] 步骤二', 支持: '执行规则全量' })
        : card({ 给定: '情境与起点', 待办: '全自主规划执行', 验收清单: '- [ ] 达标标准', 支持: '自查提示' })
    const g = gateMilestone(md, tier)
    assert.equal(g.passed, true, `${tier} 档应通过：${g.findings.join('；')}`)
  }
})

test('里程碑文件名：计划序位两位前缀 + 安全化名称', () => {
  assert.equal(milestoneFileOf(0, '跑通环境'), '01-跑通环境.md')
  assert.equal(milestoneFileOf(10, 'a/b'), '11-a／b.md')
})

// ---- 提示词模板契约（prompt-contract 同口径，项目域两模板） ----

test('项目域两模板进 PROMPT_KINDS：v6 标记 + 四块/三档/不出题要点', () => {
  for (const kind of ['项目里程碑计划', '项目里程碑产物'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]
    assert.ok(tpl, `${kind} 应为内置模板`)
    assert.match(Content.promptVersionOf(tpl).toString(), /^[6-9]$/, `${kind} 应带 v6+ 版本标记`)
  }
  const plan = Content.PROMPT_KINDS['项目里程碑计划']!
  assert.match(plan, /3–8 个里程碑/)
  assert.match(plan, /由简到繁/)
  const artifact = Content.PROMPT_KINDS['项目里程碑产物']!
  for (const block of ['## 给定', '## 待办', '## 验收清单', '## 支持']) {
    assert.ok(artifact.includes(block), `产物模板应含 ${block} 结构说明`)
  }
  for (const tier of FADING_TIERS) assert.match(artifact, new RegExp(tier))
  assert.match(artifact, /不出题/)
})

// ---- 行为：项目实体 + 提案快照流 ----

const PLAN_YAML = (project: string, extra = '') => `\
project: ${project}
plan:
  - id: m1
    name: 装好环境并跑通第一个程序
    task_class: 简：工具链操作，无算法成分
    acceptance_hints: 能离线运行 hello world${extra}
`

test('项目生命周期：创建→清单→视图→生命周期/档位变更；Missing/Broken 纪律', async () => {
  await withVault({}, async ({ engine, paths }) => {
    await assert.rejects(engine.projectShow('不存在'), /不存在（Missing）/)
    const fm = await engine.projectCreate({ name: '练耳日记', goal: '三个月内能听辨大小三度' })
    assert.equal(fm.lifecycle, 'active')
    assert.equal(fm.tier, '补全')
    assert.deepEqual(fm.plan, [])
    await assert.rejects(engine.projectCreate({ name: '练耳日记', goal: '重复建' }), /已存在/)

    const list = await engine.projectList()
    assert.equal(list.length, 1)

    const view = await engine.projectShow('练耳日记')
    assert.equal(view.fm.goal, '三个月内能听辨大小三度')
    assert.deepEqual(view.orphans, [])

    for (const lc of ['paused', 'active', 'delivered', 'archived', 'active']) {
      const next = await engine.projectSetLifecycle('练耳日记', lc)
      assert.equal(next.lifecycle, lc)
    }
    await assert.rejects(engine.projectSetLifecycle('练耳日记', 'done'), /非法生命周期/)

    const t = await engine.projectSetTier('练耳日记', '独立')
    assert.equal(t.tier, '独立')
    await assert.rejects(engine.projectSetTier('练耳日记', '终极'), /非法档位/)
    assert.ok(existsSync(join(paths.projectsDir, '练耳日记', '项目.md')))
  })
})

test('Broken 纪律：项目档案存在但缺 lifecycle 字段 → Broken 抛出', async () => {
  await withVault({
    files: [{
      path: '学习中心/projects/坏项目/项目.md',
      content: '---\nid: 坏项目\nname: 坏项目\ntier: 补全\ngoal: x\nplan: []\ncreated: 2026-09-09\nupdated: 2026-09-09\n---\n',
    }],
  }, async ({ engine }) => {
    await assert.rejects(engine.projectShow('坏项目'), /Broken/)
  })
})

test('计划提案流：初次规划 apply 无快照；修订 apply 带旧计划快照；提案记录留痕', async () => {
  await withVault({}, async ({ engine, store }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    await assert.rejects(engine.projectPlanPropose('练耳日记', 'project: 别的项目\nplan: []'), /不一致/)

    const p1 = await engine.projectPlanPropose('练耳日记', PLAN_YAML('练耳日记'))
    assert.equal(p1.initial, true)
    const pending = await engine.graphProposals('pending', 'project_plan')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, 'project_plan')
    await assert.rejects(engine.graphProposals('pending', 'bogus'), /非法 kind/)

    const r1 = await engine.projectApply(p1.id)
    assert.equal(r1.kind, 'project_plan')
    assert.equal(r1.milestones, 1)
    assert.equal(r1.snapshot, null)
    const view1 = await engine.projectShow('练耳日记')
    assert.equal(view1.fm.plan.length, 1)
    assert.equal(view1.milestones[0].file, '01-装好环境并跑通第一个程序.md')

    // 修订：新计划 apply 后旧计划落快照
    const p2 = await engine.projectPlanPropose('练耳日记', PLAN_YAML('练耳日记', '\n  - id: m2\n    name: 双音听辨小曲\n    task_class: 中：结合乐器\n    acceptance_hints: 十次内八次正确'))
    assert.equal(p2.initial, false)
    const r2 = await engine.projectApply(p2.id)
    assert.ok(r2.snapshot, '修订 apply 应带快照')
    assert.ok(existsSync(r2.snapshot))
    assert.match(r2.snapshot!, /project-\d+-plan\.yaml$/)
    const snap = readFileSync(r2.snapshot!, 'utf8')
    assert.match(snap, /装好环境并跑通第一个程序/)
    assert.doesNotMatch(snap, /双音听辨小曲/)
    assert.equal((await engine.projectShow('练耳日记')).fm.plan.length, 2)

    // 留痕 = 提案记录本身（journal 是学习行为流水，项目域不写它）
    const applied = await store.loadProposals()
    const planProps = applied.filter(p => p.kind === 'project_plan')
    assert.equal(planProps.length, 2)
    assert.equal(planProps[0].status, 'applied')
    assert.match(planProps[0].decision_note ?? '', /初次规划/)
    assert.match(planProps[1].decision_note ?? '', /快照/)
    assert.equal(applied.every(p => p.status !== 'pending'), true)
  })
})

test('里程碑产物流：首生直落；重生成自动转提案；apply 后旧文快照；门禁未过拒收', async () => {
  await withVault({}, async ({ engine }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.projectPlanPropose('练耳日记', PLAN_YAML('练耳日记'))
    await engine.projectApply(p1.id)

    const v1 = '## 给定\n\n空工程模板。\n\n## 待办\n\n安装依赖并运行。\n\n## 验收清单\n\n- [ ] 能运行 hello world\n\n## 支持\n\n命令清单见支持页。'
    const w1 = await engine.projectMilestoneWrite('练耳日记', 'm1', v1)
    assert.ok('written' in w1 && w1.written === '01-装好环境并跑通第一个程序.md')
    // 已生成后重复首生语义被拒（引导走提案）
    await assert.rejects(engine.projects.generateMilestone('练耳日记', 'm1', v1), /提案通道/)

    // 未过结构门 → MILESTONE_GATE_FAILED
    await assert.rejects(
      engine.projectMilestoneWrite('练耳日记', 'm1', '## 待办\n\n缺三块。'),
      (err: unknown) => (err as { code?: string }).code === 'MILESTONE_GATE_FAILED',
    )

    // 重生成：已生成文件存在 → 自动转 pending 提案
    const v2 = v1.replace('空工程模板。', '空工程模板（v2 补充说明）。')
    const w2 = await engine.projectMilestoneWrite('练耳日记', 'm1', v2)
    assert.ok('proposed' in w2)
    const applied = await engine.projectApply(w2.proposed)
    assert.equal(applied.kind, 'project_milestone')
    assert.ok(existsSync(applied.snapshot))
    const snap = readFileSync(applied.snapshot, 'utf8')
    assert.match(snap, /空工程模板。/)
    assert.doesNotMatch(snap, /v2 补充说明/)
    const onDisk = readFileSync(`${engine.paths.projectMilestoneDir('练耳日记')}/${applied.file}`, 'utf8')
    assert.match(onDisk, /v2 补充说明/)
  })
})

test('红线：项目全路径零 canonical 写入——复习队列/XP 账本/课程笔记原样', async () => {
  await withVault({ notes: { 入门: {} } }, async ({ engine, store, root }) => {
    const queueBefore = JSON.stringify(await engine.reviewQueue())
    const xpBefore = JSON.stringify(await engine.xpStatus())
    const noteBefore = readFileSync(join(root, '学习中心', 'math', '课程', '基础', '入门.md'), 'utf8')
    const journalBefore = await store.journalTail(null, 100)

    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.projectPlanPropose('练耳日记', PLAN_YAML('练耳日记'))
    await engine.projectApply(p1.id)
    await engine.projectMilestoneWrite('练耳日记', 'm1',
      '## 给定\n\n空工程模板。\n\n## 待办\n\n安装依赖并运行。\n\n## 验收清单\n\n- [ ] 能运行 hello world\n\n## 支持\n\n命令清单。')
    await engine.projectSetTier('练耳日记', '骨架')
    await engine.projectSetLifecycle('练耳日记', 'paused')

    assert.equal(JSON.stringify(await engine.reviewQueue()), queueBefore)
    assert.equal(JSON.stringify(await engine.xpStatus()), xpBefore)
    assert.equal(readFileSync(join(root, '学习中心', 'math', '课程', '基础', '入门.md'), 'utf8'), noteBefore)
    // journal 一行不增（streak/热力图聚合 journal 全部行——项目域写它会涨 streak，ADR-0015 裁决 7）
    const after = await store.journalTail(null, 100)
    assert.equal(after.length, journalBefore.length)
    assert.equal(PROJECT_LIFECYCLES.length, 4)
  })
})
