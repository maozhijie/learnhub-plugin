/**
 * 里程碑过点对账（P-4 / #94）：显式过点动作 → journal 新 kind='milestone_settle'
 * （对齐 xp_settle 先例），定价 = est 申报 × 关联节点题池难度校准（票内敲定口径）。
 *
 * - 无清单门禁、无题目门禁（Kulik 1990）；重复过点被守卫拒绝（定价锁定）。
 * - 过点是项目域唯一获准写 journal 的动作（真实投入显式陈述，进账本与 streak 口径）；
 *   除这一行外项目域仍零 canonical 写入（ADR-0015 裁决 5/7）。
 * - 计划条目可选域：est（正数分钟）与 nodes（非空字符串列表）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { milestonePrice } from '../src/engine/xp.ts'
import { validatePlanItems } from '../src/engine/projects.ts'
import { withVault, tfQuestion } from './helpers/vault.ts'

// ---- 纯函数：过点定价 ----

test('milestonePrice：est 申报 × 校准；缺省回落常量；k 夹取 [0.5,3]', () => {
  assert.equal(milestonePrice(100, 1.8), 180)
  assert.equal(milestonePrice(undefined, 1), 120) // 缺省 N₀=120（XP_PER_MILESTONE_DEFAULT）
  assert.equal(milestonePrice(0, 2), 240) // est 非正数视同未申报
  assert.equal(milestonePrice(100, 9), 300) // k 上夹 3
  assert.equal(milestonePrice(100, 0.01), 50) // k 下夹 0.5
  assert.equal(milestonePrice(100, NaN), 100) // 非法校准取中性
  assert.equal(milestonePrice(33, 1.0), 33)
})

// ---- 纯函数：计划可选域 schema ----

test('计划 schema 可选域：est 必须正数、nodes 必须非空字符串列表（去重保序）', () => {
  const ok = validatePlanItems([
    { id: 'm1', name: '过点', task_class: '简', acceptance_hints: '能跑', est: 90, nodes: ['入门', ' 进阶 ', '入门'] },
  ])
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.plan[0].est, 90)
  assert.deepEqual(ok.plan[0].nodes, ['入门', '进阶'])

  const bad = validatePlanItems([
    { id: 'm1', name: 'x', task_class: '简', acceptance_hints: 'y', est: -5 },
    { id: 'm2', name: 'x', task_class: '简', acceptance_hints: 'y', est: '很多' },
    { id: 'm3', name: 'x', task_class: '简', acceptance_hints: 'y', nodes: '入门' },
    { id: 'm4', name: 'x', task_class: '简', acceptance_hints: 'y', nodes: [''] },
  ])
  assert.equal(bad.errors.length, 4)
  assert.match(bad.errors[0], /est: 必须是正数/)
  assert.match(bad.errors[1], /est: 必须是正数/)
  assert.match(bad.errors[2], /nodes: 必须是列表/)
  assert.match(bad.errors[3], /nodes: 条目必须是非空字符串/)

  // 不申报可选域 = 旧计划原样合法
  assert.deepEqual(validatePlanItems([{ id: 'm1', name: 'x', task_class: '简', acceptance_hints: 'y' }]).plan[0], {
    id: 'm1', name: 'x', task_class: '简', acceptance_hints: 'y',
  })
})

// ---- 行为：过点对账流水 ----

const PLAN_WITH_NODES = (project: string) => `\
project: ${project}
plan:
  - id: m1
    name: 装好环境并跑通第一个程序
    task_class: 简：工具链操作
    acceptance_hints: 能离线运行 hello world
    est: 100
    nodes: [入门]
  - id: m2
    name: 双音听辨小曲
    task_class: 中：结合乐器
    acceptance_hints: 十次内八次正确
`

test('过点对账：显式动作落 journal kind=milestone_settle，定价=est×k 锁定；重复过点拒绝', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('q1', { fsrs: { stability: 3, difficulty: 9, due: '2026-09-10', last_review: '2026-09-01', reps: 2, lapses: 0 } })] },
  }, async ({ engine, store }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.project.projectPlanPropose('练耳日记', PLAN_WITH_NODES('练耳日记'))
    await engine.graph.projectApply(p1.id)

    // 过点前无 milestone_settle（对账流水即事实，经 store 缝断言）
    assert.equal(await engine.projects.milestoneSettleRec('练耳日记', 'm1'), null)

    const r = await engine.projectMilestonePass('练耳日记', 'm1')
    // k = fsrs difficulty 9 / 5 = 1.8（题池校准）；est=100 → 180
    assert.equal(r.xp, 180)
    assert.match(r.detail, /N₀=100（est 申报）/)
    assert.match(r.detail, /k=1\.80/)
    assert.ok(await engine.projects.milestoneSettleRec('练耳日记', 'm1'))

    const rows = await store.journalTail('练耳日记', 100)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'milestone_settle')
    assert.equal(rows[0].node, 'm1')
    assert.equal(rows[0].xp, 180)
    assert.match(rows[0].detail ?? '', /定价锁定/)

    // 重复过点：定价锁定，拒绝再入账
    await assert.rejects(engine.projectMilestonePass('练耳日记', 'm1'), /已过点对账/)

    // 未过点的第二个里程碑仍可过点（无 est 无 nodes → 缺省 120 × k=1）
    const r2 = await engine.projectMilestonePass('练耳日记', 'm2')
    assert.equal(r2.xp, 120)
    assert.match(r2.detail, /缺省，无 est 申报/)
    assert.match(r2.detail, /无关联题池证据，取中性/)
  })
})

test('过点进账本与 streak 口径：today_xp 计入对账行；除对账行外项目域零 journal 写入', async () => {
  await withVault({ notes: { 入门: {} } }, async ({ engine, store, root }) => {
    const xpBefore = await engine.sched2.xpStatus()
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.project.projectPlanPropose('练耳日记', PLAN_WITH_NODES('练耳日记'))
    await engine.graph.projectApply(p1.id)
    await engine.projectMilestoneWrite('练耳日记', 'm1',
      '## 给定\n\n空工程模板。\n\n## 待办\n\n安装依赖并运行。\n\n## 验收清单\n\n- [ ] 能运行 hello world\n\n## 支持\n\n命令清单。')
    await engine.project.projectSetTier('练耳日记', '骨架')

    const afterPlanOps = await store.journalTail(null, 100)
    assert.equal(afterPlanOps.length, 0, '计划/产物/档位操作零 journal 写入')

    await engine.projectMilestonePass('练耳日记', 'm1')
    const xp = await engine.sched2.xpStatus()
    assert.equal(xp.today_xp, xpBefore.today_xp + 100, '对账行进今日 XP 汇总（本测无题库 → k=1，est=100）')
    assert.equal(xp.streak, xpBefore.streak + 1, '过点当日进 streak 口径（真实投入显式陈述）')
    assert.equal((await store.journalTail(null, 100)).length, 1, '全库 journal 只增对账这一行')

    // 课程笔记零写入（红线）
    assert.doesNotMatch(readFileSync(join(root, '学习中心', 'math', '课程', '基础', '入门.md'), 'utf8'), /milestone_settle/)
    assert.ok(existsSync(join(root, '学习中心', 'projects', '练耳日记', '项目.md')))
  })
})

test('过点守卫：计划里没有该里程碑 fail loud；关联节点悬空 fail loud 点名', async () => {
  await withVault({}, async ({ engine }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.project.projectPlanPropose('练耳日记', PLAN_WITH_NODES('练耳日记'))
    await engine.graph.projectApply(p1.id)
    await assert.rejects(engine.projectMilestonePass('练耳日记', 'm9'), /没有里程碑「m9」/)
    // 悬空关联：计划声明 nodes 指向不存在的节点 → 点名报错（先修计划，不静默降级）
    const badPlan = PLAN_WITH_NODES('练耳日记').replace('nodes: [入门]', 'nodes: [不存在的节点]')
    const p2 = await engine.project.projectPlanPropose('练耳日记', badPlan)
    await engine.graph.projectApply(p2.id)
    await assert.rejects(engine.projectMilestonePass('练耳日记', 'm1'), /不存在的节点|找不到节点/)
  })
})
