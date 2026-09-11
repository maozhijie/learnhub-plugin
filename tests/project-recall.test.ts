/**
 * 里程碑检索点（P-3 / #93）：产物已生成的里程碑可发起检索点会话——从关联节点题池
 * 抽题 + 学习者自述关键决策，流水落 projects/<id>/recall.jsonl。
 *
 * 红线：零 XP、零 FSRS、零 practice、零 journal——检索点只服务知识底座，不作项目
 * 验收标准；抽题只读题库（不改题不推进调度）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { drawRecallQuestions } from '../src/engine/project-recall.ts'
import type { RecallPool } from '../src/engine/project-recall.ts'
import { withVault, tfQuestion } from './helpers/vault.ts'

// ---- 纯函数：抽题 ----

function pool(node: string, questions: Array<Record<string, unknown>>): RecallPool {
  return { course: '数学', node, questions: questions as RecallPool['questions'] }
}

const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'true_false', q: `${id} 题干`, answer: true, ...extra })

test('drawRecallQuestions：跨池轮转、从未作答优先、due 最早优先、归档不进池', () => {
  const pools = [
    pool('大库', [
      q('a1'), q('a2'), q('a3'), q('a4'),
      q('old', { stats: { attempts: 2, correct: 1 }, fsrs: { stability: 2, difficulty: 5, due: '2026-08-01', last_review: '2026-07-01', reps: 3, lapses: 0 } }),
      q('newer', { stats: { attempts: 1, correct: 1 }, fsrs: { stability: 2, difficulty: 5, due: '2026-09-01', last_review: '2026-08-01', reps: 2, lapses: 0 } }),
      q('gone', { archived: true }),
    ]),
    pool('小库', [q('b1')]),
  ]
  const drawn = drawRecallQuestions(pools, 4, () => 0.5)
  assert.equal(drawn.length, 4)
  // 轮转：两池交替出题，小库不缺席
  assert.equal(drawn.filter(d => d.node === '小库').length, 1)
  // 从未作答优先于到期复习；归档题不出现
  const ids = drawn.map(d => d.qid)
  assert.ok(!ids.includes('gone'))
  assert.ok(ids.includes('b1'))
  assert.equal(drawn[0].node, '大库') // 第一手给题量大的池（轮转起点），但不淹没小库
  // 剩余全抽：never 池耗尽后才轮到 due 最早的复习题
  const all = drawRecallQuestions(pools, 10, () => 0.5).map(d => d.qid)
  assert.ok(all.indexOf('old') < all.indexOf('newer'), 'due 最早优先')
  assert.equal(all.length, 7) // 4 never + 2 due + 1 小库（gone 归档除外）
})

test('drawRecallQuestions：limit 缺省下限 1；空池列表返回空', () => {
  assert.equal(drawRecallQuestions([pool('x', [q('x1')])], 0, Math.random).length, 1)
  assert.equal(drawRecallQuestions([], 5, Math.random).length, 0)
})

// ---- 行为：检索点会话流 ----

const RECALL_PLAN = (project: string) => `\
project: ${project}
plan:
  - id: m1
    name: 装好环境并跑通第一个程序
    task_class: 简：工具链操作
    acceptance_hints: 能离线运行 hello world
    nodes: [入门]
`

const CARD = '## 给定\n\n空工程模板。\n\n## 待办\n\n安装依赖并运行。\n\n## 验收清单\n\n- [ ] 能运行 hello world\n\n## 支持\n\n命令清单。'

test('检索点门槛：产物未生成拒绝；生成后抽题落档（题干入流水，答案不入）', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('q1'), tfQuestion('q2', { fsrs: { stability: 2, difficulty: 5, due: '2026-08-01', last_review: '2026-07-01', reps: 2, lapses: 0 } })] },
  }, async ({ engine, root }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.projectPlanPropose('练耳日记', RECALL_PLAN('练耳日记'))
    await engine.projectApply(p1.id)

    await assert.rejects(engine.projectMilestoneRecall('练耳日记', 'm1'), /产物尚未生成/)

    await engine.projectMilestoneWrite('练耳日记', 'm1', CARD)
    const session = await engine.projectMilestoneRecall('练耳日记', 'm1', { limit: 2 })
    assert.equal(session.questions.length, 2)
    for (const d of session.questions) {
      assert.equal(d.course, '数学')
      assert.equal(d.node, '入门')
      assert.ok(d.answer !== undefined, '会话面带答案（对照用）')
    }

    // 流水落档：draw 记录只有题干（答案不落档），不写任何课程域状态
    const log = await engine.projectRecallLog('练耳日记')
    assert.equal(log.length, 1)
    assert.equal(log[0].kind, 'draw')
    const draw = log[0] as Extract<typeof log[0], { kind: 'draw' }>
    assert.equal(draw.milestone, 'm1')
    assert.deepEqual(draw.nodes, ['入门'])
    assert.equal(draw.questions.length, 2)
    assert.equal(JSON.stringify(draw.questions).includes('answer'), false)
    assert.ok(existsSync(`${root}/学习中心/projects/练耳日记/recall.jsonl`))
  })
})

test('检索点红线：零 XP/零 FSRS/零 practice/零 journal，题库文件原样', async () => {
  await withVault({
    banks: { 入门: [tfQuestion('q1', { fsrs: { stability: 2, difficulty: 5, due: '2026-08-01', last_review: '2026-07-01', reps: 2, lapses: 0 } })] },
  }, async ({ engine, store, paths, root }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const p1 = await engine.projectPlanPropose('练耳日记', RECALL_PLAN('练耳日记'))
    await engine.projectApply(p1.id)
    await engine.projectMilestoneWrite('练耳日记', 'm1', CARD)

    const bankBefore = (await engine.bank.load(paths.courseRoot('math'), '入门')).questions
    const reviewBefore = await store.reviewLogAll()
    const practiceBefore = await store.practiceAll()
    const journalBefore = await store.journalTail(null, 100)
    const xpBefore = JSON.stringify(await engine.xpStatus())

    await engine.projectMilestoneRecall('练耳日记', 'm1')
    await engine.projectRecallReflect('练耳日记', 'm1', '关键决策：先装 runtime 再配编辑器，避免权限坑。')

    assert.deepEqual((await engine.bank.load(paths.courseRoot('math'), '入门')).questions, bankBefore, '题库零写入')
    assert.deepEqual(await store.reviewLogAll(), reviewBefore)
    assert.deepEqual(await store.practiceAll(), practiceBefore)
    assert.deepEqual(await store.journalTail(null, 100), journalBefore, '检索点零 journal 写入')
    assert.equal(JSON.stringify(await engine.xpStatus()), xpBefore, '零 XP')

    const log = await engine.projectRecallLog('练耳日记')
    assert.equal(log.length, 2)
    const reflect = log[1] as Extract<typeof log[0], { kind: 'reflect' }>
    assert.equal(reflect.kind, 'reflect')
    assert.match(reflect.narration, /关键决策/)
  })
})

test('检索点守卫：无关联节点 fail loud（调用参数可补）；自述空串拒绝；里程碑不在计划 fail loud', async () => {
  await withVault({ banks: { 入门: [tfQuestion('q1')] } }, async ({ engine }) => {
    await engine.projectCreate({ name: '练耳日记', goal: '听辨音程' })
    const noNodes = `project: 练耳日记\nplan:\n  - id: m1\n    name: 过点\n    task_class: 简\n    acceptance_hints: 能跑\n`
    const p1 = await engine.projectPlanPropose('练耳日记', noNodes)
    await engine.projectApply(p1.id)
    await engine.projectMilestoneWrite('练耳日记', 'm1', CARD)

    await assert.rejects(engine.projectMilestoneRecall('练耳日记', 'm1'), /没有关联节点/)
    // 参数补充关联即可发起
    const session = await engine.projectMilestoneRecall('练耳日记', 'm1', { nodes: ['入门'] })
    assert.equal(session.questions.length, 1)

    await assert.rejects(engine.projectRecallReflect('练耳日记', 'm1', '   '), /自述不能为空/)
    await assert.rejects(engine.projectMilestoneRecall('练耳日记', 'm9'), /没有里程碑「m9」/)
    await assert.rejects(engine.projectRecallReflect('练耳日记', 'm9', '自述'), /没有里程碑「m9」/)
  })
})
