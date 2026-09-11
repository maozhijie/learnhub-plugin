/**
 * 项目执行事件流与 Mastery 交叉 2×2（P-7 / #98 / ADR-0015 §3/§4/§8；#149 行使即回流）。
 *
 * - 纯函数：评级→0-1 分数确定性映射（ratingFromEvidence 证据带的带中点逆映射）、
 *   被行使 enc 边判定（两端都在事件 nodes 内；#149 起降为 enc 面观测）、2×2 象限分类、
 *   入档推荐（challenge point）。
 * - 验收主链：一条执行事件走完 回流（节点级：行使节点各回流一次 EMA）→ mastery 变化
 *   → 项目 2×2 象限落位 全链。
 * - #149 stub 语义：种子簇节点（stub）行使即回流 EMA（mastery/enc 面天然参与）；
 *   粗 pre 占位边只记流（exec.jsonl）不回流（边零证据写入）。
 * - 非对称红线：升档推荐在任何门禁位不出现（gateMilestone/passMilestone 行为零变化、
 *   推荐纯函数、推荐不落盘）；执行事件零 XP、零 journal/review-log/practice/sessions/srs。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  execRatingScore, exercisedEncEdges, classifyCross, masteryAggregate,
  execEvidenceScore, recommendTier,
} from '../src/engine/project-exec.ts'
import { masteryOfFm } from '../src/engine/srs.ts'
import { withVault } from './helpers/vault.ts'

// ---- 图种子：入门(pre 底座) ← 进阶，进阶声明 enc: [入门] ----

const ENC_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 25, enc: [入门] }',
].join('\n')

const NO_ENC_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 平行, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

const PLAN_WITH_NODES = (project: string, nodes: string) => `\
project: ${project}
plan:
  - id: m1
    name: 里程碑一
    task_class: 简
    acceptance_hints: 达标
    nodes: [${nodes}]
`

/** 读课程节点 frontmatter 状态（mastery 派生断言用）。 */
async function stateOf(engine: Awaited<ReturnType<typeof withVault>>['engine']): Promise<Record<string, import('../src/engine/types.ts').Fm>> {
  return (await engine.loadView({ name: '数学', root: 'math' })).state
}

// ---- 纯函数：评级 → 0-1 分数 ----

test('execRatingScore：ratingFromEvidence 证据带的带中点逆映射；越界 fail loud', () => {
  assert.equal(execRatingScore(4), 0.95) // [0.9,1.0] 中点
  assert.equal(execRatingScore(3), 0.8) // [0.7,0.9) 中点
  assert.equal(execRatingScore(2), 0.55) // [0.4,0.7) 中点
  assert.equal(execRatingScore(1), 0.2) // [0,0.4) 中点
  for (const bad of [0, 5, 2.5, '3', null, NaN]) {
    assert.throws(() => execRatingScore(bad as never), /1-4 的整数/, String(bad))
  }
})

// ---- 纯函数：被行使 enc 边判定（v1 = 两端都在事件 nodes 内） ----

test('exercisedEncEdges：既有 enc 边两端都在 nodes 内才算被行使；去重且方向保留', () => {
  const encOf = (holder: string) => (holder === '进阶' ? ['入门'] : [])
  assert.deepEqual(exercisedEncEdges(['进阶', '入门'], encOf), [{ holder: '进阶', skill: '入门' }])
  // 一端缺席不算行使
  assert.deepEqual(exercisedEncEdges(['进阶'], encOf), [])
  assert.deepEqual(exercisedEncEdges(['入门'], encOf), [])
  // 图上没有边 → 空
  assert.deepEqual(exercisedEncEdges(['甲', '乙'], () => []), [])
  // 重复节点与重复邻接去重（同一有序对只回流一次）
  const dupAdj = (holder: string) => (holder === '乙' ? ['甲', '甲'] : [])
  assert.deepEqual(exercisedEncEdges(['乙', '甲', '乙'], dupAdj), [{ holder: '乙', skill: '甲' }])
})

// ---- 纯函数：2×2 象限 ----

test('classifyCross：四象限落位（≥0.6 为高）+ 证据缺失归该轴低侧', () => {
  assert.equal(classifyCross(0.9, 0.9).key, 'healthy')
  assert.equal(classifyCross(0.9, 0.59).key, 'knowledge_idle', '高掌握×低执行 = 会而不会用')
  assert.equal(classifyCross(0.59, 0.9).key, 'applied_shaky', '低掌握×高执行 = 会用而不牢')
  assert.equal(classifyCross(0.1, 0.2).key, 'foundation')
  // 阈值边界：0.6 恰好落高侧
  assert.equal(classifyCross(0.6, 0.6).key, 'healthy')
  // null（无关联节点 / 无执行事件）按该轴低侧处理
  assert.equal(classifyCross(null, null).key, 'foundation')
  assert.equal(classifyCross(0.9, null).key, 'knowledge_idle')
  assert.equal(classifyCross(null, 0.9).key, 'applied_shaky')
  // 四象限都有可读名
  for (const q of [classifyCross(0.9, 0.9), classifyCross(0.9, 0.1), classifyCross(0.1, 0.9), classifyCross(0.1, 0.1)]) {
    assert.ok(q.label.length >= 2)
    assert.ok(q.hint.length >= 6)
  }
})

test('聚合口径：masteryAggregate = 关联节点 mastery 均值；execEvidenceScore = 事件分 EMA(0.7/0.3)', () => {
  assert.equal(masteryAggregate([0.8, 0.6]), 0.7)
  assert.equal(masteryAggregate([]), null)
  assert.equal(masteryAggregate([0.24]), 0.24)
  // 事件分 EMA：首证取分，之后 0.7 旧 + 0.3 新（与练习证据同机械）
  assert.equal(execEvidenceScore([]), null)
  assert.equal(execEvidenceScore([{ rating: 3 }]), 0.8)
  assert.equal(execEvidenceScore([{ rating: 3 }, { rating: 4 }]), 0.845) // 0.8*0.7 + 0.95*0.3
})

// ---- 纯函数：入档推荐（challenge point，§8） ----

test('recommendTier：升档判据 = 档内表现 + 知识底座；双向提议；纯函数', () => {
  // 档内表现强 + 底座立得住 → 升一档
  const promote = recommendTier('补全', { count: 3, avg: 0.85 }, 0.75)
  assert.equal(promote.action, 'promote')
  assert.equal(promote.recommended, '独立')
  assert.match(promote.reasons.join('；'), /档内表现/)
  // 表现够升但底座不立住 → 维持（不带底座升档会把项目推成「会用而不牢」）
  const shaky = recommendTier('补全', { count: 3, avg: 0.85 }, 0.4)
  assert.equal(shaky.action, 'hold')
  assert.equal(shaky.recommended, '补全')
  assert.match(shaky.reasons.join('；'), /底座/)
  // 档内表现吃力 → 降一档（challenge point 双向）
  const demote = recommendTier('补全', { count: 3, avg: 0.3 }, 0.6)
  assert.equal(demote.action, 'demote')
  assert.equal(demote.recommended, '骨架')
  // 样本不足 → 维持（静默不折腾）
  assert.equal(recommendTier('补全', { count: 2, avg: 0.9 }, 0.9).action, 'hold')
  assert.equal(recommendTier('补全', { count: 3, avg: null }, 0.9).action, 'hold')
  // 边界封顶/兜底：独立档无更高档；骨架档无更低档
  assert.equal(recommendTier('独立', { count: 5, avg: 0.95 }, 0.9).action, 'hold')
  assert.equal(recommendTier('骨架', { count: 5, avg: 0.1 }, 0.3).action, 'hold')
  // 目标带内 → 维持
  assert.equal(recommendTier('补全', { count: 4, avg: 0.6 }, 0.7).action, 'hold')
  // 纯度断言：同输入两次调用结果 deepEqual，且不 mutate 入参
  const inTier = { count: 3, avg: 0.85 }
  assert.deepEqual(recommendTier('补全', inTier, 0.75), promote)
  assert.deepEqual(inTier, { count: 3, avg: 0.85 })
})

// ---- 验收主链：回流 → mastery 变化 → 2×2 落位 ----

test('主链：一条执行事件走完 回流→practice EMA→mastery→2×2 象限 全链', async () => {
  await withVault({
    graph: ENC_GRAPH,
    notes: { 入门: {}, 进阶: {} },
  }, async ({ engine, paths }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '三个月弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', PLAN_WITH_NODES('练琴计划', '入门, 进阶'))
    await engine.projectApply(p1.id)

    const before = await stateOf(engine)
    const mBefore = { 入门: masteryOfFm(before['入门']), 进阶: masteryOfFm(before['进阶']) }
    assert.equal(mBefore['入门'], 0)
    assert.equal(before['入门']?.practice_ema ?? 0, 0)

    // 一条执行事件：nodes 含 enc 边两端
    const r = await engine.projectExecLog('练琴计划', {
      source: 'self', rating: 3, nodes: ['进阶', '入门'], note: '第一次合练',
    })
    assert.equal(r.score, 0.8)
    assert.equal(r.edges, 1, '一条被行使 enc 边（进阶→入门；enc 面观测）')
    assert.equal(r.backflow.length, 2, '行使即回流（节点级）：两节点各一次、同节点去重')
    const bf = Object.fromEntries(r.backflow.map(b => [b.node, b]))
    assert.equal(bf['入门'].ema_before, 0)
    assert.equal(bf['入门'].ema_after, 0.8)
    assert.equal(bf['进阶'].ema_after, 0.8)

    // 两端节点 practice EMA 各变化一次、mastery 相应变化（frontmatter 是唯一写点）
    const after = await stateOf(engine)
    assert.equal(after['入门']?.practice_ema, 0.8)
    assert.equal(after['进阶']?.practice_ema, 0.8)
    assert.equal(after['入门']?.practice.attempts, 1)
    const mAfter = { 入门: masteryOfFm(after['入门']), 进阶: masteryOfFm(after['进阶']) }
    assert.ok(mAfter['入门'] > mBefore['入门'], `mastery 应随回流上升（${mBefore['入门']}→${mAfter['入门']}）`)

    // 事件流落 projects/<id>/exec.jsonl（项目自己的流，与节点练习证据通道两条流）
    const execPath = join(paths.projectsDir, '练琴计划', 'exec.jsonl')
    assert.ok(existsSync(execPath))
    const line = JSON.parse(readFileSync(execPath, 'utf8').trim().split('\n').at(-1)!)
    assert.equal(line.rating, 3)
    assert.equal(line.source, 'self')
    assert.deepEqual(line.nodes, ['进阶', '入门'])
    assert.equal(line.tier, '补全', '事件带落流时档位快照（档内表现口径的归属依据）')
    assert.equal(line.note, '第一次合练')

    // 2×2 象限随证据落位：x=关联节点 mastery 均值(0.24)，y=事件分 EMA(0.8) → 会用而不牢
    const cross = await engine.projectCrossView('练琴计划')
    assert.equal(cross.x.value, 0.24)
    assert.equal(cross.y.value, 0.8)
    assert.equal(cross.quadrant.key, 'applied_shaky')
    assert.equal(cross.linked_nodes.length, 2)
    assert.equal(cross.exec.count, 1)
    assert.equal(cross.events.length, 1)
    // 入档推荐随行（只读）：样本 1 < 3 → 维持
    assert.equal(cross.recommendation.action, 'hold')
    assert.equal(cross.recommendation.current, '补全')
  })
})

test('事件流边界：无 enc 边也回流（行使即回流）/ 空 nodes / 未知节点 / 评级越界 / auto 无证据', async () => {
  await withVault({
    graph: NO_ENC_GRAPH,
    notes: { 入门: {}, 平行: {} },
  }, async ({ engine, paths }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', PLAN_WITH_NODES('练琴计划', '入门, 平行'))
    await engine.projectApply(p1.id)

    // 无 enc 边（#149 行使即回流的节点级修订）：节点照样回流 EMA——stub 语义的底座
    const r = await engine.projectExecLog('练琴计划', { source: 'self', rating: 4, nodes: ['入门', '平行'] })
    assert.equal(r.edges, 0, '零被行使 enc 边（只作观测）')
    assert.equal(r.backflow.length, 2, '行使即回流：两节点各一次')
    const after = await stateOf(engine)
    assert.equal(after['入门']?.practice_ema, 0.95, '节点练习证据 EMA 随行使写入')
    assert.equal(after['平行']?.practice_ema, 0.95)

    // 空 nodes（文档化语义：只落项目流，零回流）
    const r2 = await engine.projectExecLog('练琴计划', { source: 'ai', rating: 2 })
    assert.deepEqual(r2.nodes, [])
    assert.equal(r2.edges, 0)
    assert.equal(r2.backflow.length, 0)
    assert.equal(JSON.parse(readFileSync(join(paths.projectsDir, '练琴计划', 'exec.jsonl'), 'utf8').trim().split('\n').at(-1)!).nodes.length, 0)

    // 评级越界 / 小数 / 未知来源 / 未知节点 fail loud，且不落流
    const recsBefore = (await engine.projectCrossView('练琴计划')).exec.count
    await assert.rejects(engine.projectExecLog('练琴计划', { source: 'self', rating: 5 }), /1-4 的整数/)
    await assert.rejects(engine.projectExecLog('练琴计划', { source: 'self', rating: 2.5 }), /1-4 的整数/)
    await assert.rejects(engine.projectExecLog('练琴计划', { source: 'self', rating: 0 }), /1-4 的整数/)
    await assert.rejects(engine.projectExecLog('练琴计划', { source: 'chat', rating: 3 }), /auto\/self\/ai/)
    await assert.rejects(engine.projectExecLog('练琴计划', { source: 'self', rating: 3, nodes: ['不存在的节点'] }), /找不到节点/)
    assert.equal((await engine.projectCrossView('练琴计划')).exec.count, recsBefore, '被拒事件不落流')

    // auto 来源必须带可观测证据（skills 先例）；带证据走确定性映射
    await assert.rejects(engine.projectExecLog('练琴计划', { source: 'auto', rating: 3 }), /可观测证据/)
    const r3 = await engine.projectExecLog('练琴计划', { source: 'auto', evidence: { accuracy: 0.95 } })
    assert.equal(r3.rating, 4)
    assert.equal(r3.score, 0.95)
  })
})

test('#149 stub 与粗 pre：种子簇节点行使回流 EMA（自身一次）；粗 pre 占位边只记流不回流', async () => {
  await withVault({ registry: null, graph: null }, async ({ engine, paths }) => {
    // 种子图（粗占位边：endpoint.pre = starts）+ 项目挂靠种子簇节点
    const seedYaml = `course: 数学
mode: new
goal_type: capability
endpoint:
  name: 弹唱目标
  region: 演奏
  block: 终点块
starts:
  - name: 持琴与手型
    region: 演奏
    block: 入手块
    basis: project
  - name: 音阶爬格
    region: 演奏
    block: 入手块
    basis: project
`
    const sp = await engine.graphPropose('seed', seedYaml) as { id: number }
    await engine.graphApply('seed', sp.id)
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', PLAN_WITH_NODES('练琴计划', '数学/弹唱目标, 数学/音阶爬格'))
    await engine.projectApply(p1.id)

    // 事件行使「终点 + 一个起点」：两节点间只有粗 pre 占位边（无 enc）
    const r = await engine.projectExecLog('练琴计划', { source: 'self', rating: 3, nodes: ['数学/弹唱目标', '数学/音阶爬格'] })
    assert.equal(r.edges, 0, '粗 pre 占位边不是 enc 边——零被行使边（只记流）')
    assert.equal(r.backflow.length, 2, '行使即回流：被行使节点各一次（粗 pre 关系不产生第三笔回流）')
    const course = await engine.registry.get('数学')
    const { graph, state } = await engine.loadView(course!)
    assert.ok(graph.preOf['弹唱目标'].includes('音阶爬格'), '种子粗占位边在图（endpoint.pre = starts）')
    assert.equal(state['弹唱目标']?.practice_ema, 0.8, 'stub 行使回流 EMA——mastery 面天然参与')
    assert.equal(state['音阶爬格']?.practice_ema, 0.8)
    // 粗 pre 只记流：事件完整落 exec.jsonl（行使记录在项目流水里，不在边上）
    const line = JSON.parse(readFileSync(join(paths.projectsDir, '练琴计划', 'exec.jsonl'), 'utf8').trim().split('\n').at(-1)!)
    assert.deepEqual(line.nodes, ['数学/弹唱目标', '数学/音阶爬格'])
  })
})

test('入档推荐全链：档内表现攒够 → 推荐升档但不落盘；改档后档内归属随之切换', async () => {
  await withVault({
    graph: ENC_GRAPH,
    notes: {
      入门: { fsrs: { stability: 60, difficulty: 5, due: '2026-09-10', last_review: '2026-09-01', reps: 3, lapses: 0 }, practice: { attempts: 3, correct: 3, ema: 0.9 } },
      进阶: { fsrs: { stability: 60, difficulty: 5, due: '2026-09-10', last_review: '2026-09-01', reps: 3, lapses: 0 }, practice: { attempts: 3, correct: 3, ema: 0.9 } },
    },
  }, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', PLAN_WITH_NODES('练琴计划', '入门, 进阶'))
    await engine.projectApply(p1.id)

    for (let i = 0; i < 3; i++) {
      await engine.projectExecLog('练琴计划', { source: 'self', rating: 4 })
    }
    const cross = await engine.projectCrossView('练琴计划')
    assert.equal(cross.recommendation.action, 'promote', '档内 3 次 0.95 + 底座 0.97 → 推荐升档')
    assert.equal(cross.recommendation.recommended, '独立')
    // 非对称红线：推荐不落盘——项目档位原样，学习者显式改档才生效
    assert.equal((await engine.projects.load('练琴计划')).tier, '补全')

    // 学习者显式改档（既有 projectSetTier 通道）后，档内统计归属切换：新档样本不足 → 维持
    await engine.projectSetTier('练琴计划', '独立')
    const cross2 = await engine.projectCrossView('练琴计划')
    assert.equal(cross2.recommendation.current, '独立')
    assert.equal(cross2.recommendation.action, 'hold')
    assert.match(cross2.recommendation.reasons.join('；'), /样本|最高档/)
  })
})

// ---- 非对称红线 ----

test('红线：执行事件零 XP / 零 journal / 零 review-log / 零 practice 流水 / 复习队列原样', async () => {
  await withVault({
    graph: ENC_GRAPH,
    notes: { 入门: {}, 进阶: {} },
  }, async ({ engine, store }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', PLAN_WITH_NODES('练琴计划', '入门, 进阶'))
    await engine.projectApply(p1.id)

    const queueBefore = JSON.stringify(await engine.content2.reviewQueue())
    const xpBefore = JSON.stringify(await engine.xpStatus())
    const journalBefore = await store.journalTail(null, 100)
    const reviewBefore = await store.reviewLogAll()
    const practiceBefore = await store.practiceAll()

    await engine.projectExecLog('练琴计划', { source: 'self', rating: 3, nodes: ['入门', '进阶'] })

    assert.equal(JSON.stringify(await engine.content2.reviewQueue()), queueBefore, '复习队列不动')
    assert.equal(JSON.stringify(await engine.xpStatus()), xpBefore, 'XP 账本不动（执行事件零 XP）')
    assert.equal((await store.journalTail(null, 100)).length, journalBefore.length, 'journal 零写入')
    assert.equal((await store.reviewLogAll()).length, reviewBefore.length, 'review-log 零写入')
    assert.equal((await store.practiceAll()).length, practiceBefore.length, 'practice 流水零写入（回流走节点 frontmatter EMA，非中央流水）')
  })
})

test('红线：升档推荐不出现在任何门禁位——gateMilestone/passMilestone 行为零变化', async () => {
  const STRONG = { fsrs: { stability: 60, difficulty: 5, due: '2026-09-10', last_review: '2026-09-01', reps: 3, lapses: 0 }, practice: { attempts: 3, correct: 3, ema: 0.9 } }
  await withVault({
    graph: ENC_GRAPH,
    notes: { 入门: STRONG, 进阶: STRONG },
  }, async ({ engine, store }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', PLAN_WITH_NODES('练琴计划', '入门, 进阶'))
    await engine.projectApply(p1.id)

    // 攒出一份「强烈推荐升档」的状态
    for (let i = 0; i < 3; i++) {
      await engine.projectExecLog('练琴计划', { source: 'self', rating: 4 })
    }
    const cross = await engine.projectCrossView('练琴计划')
    assert.equal(cross.recommendation.action, 'promote')

    // 门禁位 1：轻量结构门照旧——与推荐无关的失败原样拒绝
    await assert.rejects(
      engine.projectMilestoneWrite('练琴计划', 'm1', '## 待办\n\n缺三块。'),
      (err: unknown) => (err as { code?: string }).code === 'MILESTONE_GATE_FAILED',
    )
    // 门禁位 2：过点对账照旧——定价语义与推荐无关（无题池 → k=1，est 未申报 → 120）
    const pass = await engine.projectMilestonePass('练琴计划', 'm1')
    assert.equal(pass.xp, 120)
    assert.doesNotMatch(pass.detail, /推荐|升档|promote/, '对账流水不含任何推荐语义')
    const rows = await store.journalTail('练琴计划', 10)
    assert.equal(rows.length, 1, '除过点对账行外 journal 仍零写入')
    assert.equal(rows[0].kind, 'milestone_settle')
    // 门禁位 3：推荐是纯读——跨视图调用前后项目档位与执行流不变
    const fmAfter = await engine.projects.load('练琴计划')
    assert.equal(fmAfter.tier, '补全')
    assert.equal(fmAfter.plan.length, 1)
  })
})
