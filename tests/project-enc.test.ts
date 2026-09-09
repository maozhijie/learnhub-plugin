/**
 * 行为推断 enc 边（P-6 / #96）：项目窗口内的翻卡/回看共现 → 带置信度候选边 →
 * 每课程单个 pending edit 提案走人审（enc_backfill「单提案人审」先例）。
 *
 * - 纯函数：共现对提取（同日去重、minCo、稳定排序）、方向裁决（pre 闭包优先，
 *   启发式兜底）、共现→权重标尺（对齐 encWeightOf）。
 * - 边界（ADR-0015 裁决 3/6）：enc 边归节点域，项目只产出候选提案；跨课程对不成边；
 *   已声明边不重复提名。零 schema 破坏——提案 = 既有 set_enc 整体替换 op，
 *   既有声明 enc 原样保留，人审走既有 graphApply（含审计门）。
 * - synthetic 复习推进不是真实行为，不算共现证据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cooccurrencePairs, orientCandidate, coWeight } from '../src/engine/project-enc.ts'
import { withVault, tfQuestion } from './helpers/vault.ts'

const TWO_NODE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 25 }',
].join('\n')

// ---- 纯函数 ----

test('cooccurrencePairs：同日多事件去重、minCo 过滤、co 降序同数按字典序', () => {
  const events = [
    { node: '乙', day: '2026-09-01' }, { node: '乙', day: '2026-09-01' }, // 同日同节点去重
    { node: '甲', day: '2026-09-01' },
    { node: '甲', day: '2026-09-02' }, { node: '乙', day: '2026-09-02' },
    { node: '甲', day: '2026-09-03' }, { node: '乙', day: '2026-09-03' },
    { node: '丙', day: '2026-09-03' }, // 丙只单独出现一天
  ]
  // 对内排序按码位：乙(U+4E59) < 甲(U+7532)
  assert.deepEqual(cooccurrencePairs(events, 2), [{ a: '乙', b: '甲', co: 3 }])
  assert.equal(cooccurrencePairs(events, 4).length, 0)
})

test('orientCandidate：pre 闭包定方向；无结构关系用首事件启发式；首日相同字典序兜底', () => {
  const isAncestor = (from: string, to: string) => from === '底座' && to === '上层'
  const firstDayOf = (n: string) => (n === '早' ? '2026-09-01' : n === '晚' ? '2026-09-05' : undefined)
  assert.deepEqual(orientCandidate('上层', '底座', isAncestor, firstDayOf), { skill: '底座', holder: '上层', why: 'pre 闭包方向' })
  assert.deepEqual(orientCandidate('晚', '早', () => false, firstDayOf).skill, '早', '先被练的为 skill')
  // 首日相同：对内字典序（共现对提取时已按码位排序 a<b），skill 取小者
  const tie = orientCandidate('同1', '同2', () => false, () => '2026-09-03')
  assert.equal(tie.skill, '同1')
  assert.equal(tie.holder, '同2')
  assert.match(tie.why, /字典序/)
})

test('coWeight：对齐 encWeightOf 标尺（≥3 天 1.0 / 2 天 0.8 / 1 天 0.6）', () => {
  assert.equal(coWeight(1), 0.6)
  assert.equal(coWeight(2), 0.8)
  assert.equal(coWeight(3), 1.0)
  assert.equal(coWeight(9), 1.0)
})

// ---- 行为：共现扫描 → 提案 → 人审落边 ----

const ENC_PLAN = (project: string) => `\
project: ${project}
plan:
  - id: m1
    name: 里程碑一
    task_class: 简
    acceptance_hints: 达标
    nodes: [入门, 进阶]
`

const recentTs = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

async function seedCoActivity(
  engine: Awaited<ReturnType<typeof withVault>>['engine'],
  days: number[],
): Promise<void> {
  for (const d of days) {
    const ts = recentTs(d)
    await engine.store.appendReview({
      course: '数学', node: '入门', qid: 'q1', rating: 3, rating_source: 'auto',
      elapsed_days: 1, stability_before: 2, difficulty_before: 5, r_pred: 0.9, ts,
    })
    await engine.store.appendPractice({
      course: '数学', node: '进阶', ex: 1, answer: 'B', correct: true, judge: 'allo', ts,
    })
  }
}

test('行为推断 enc：共现窗口 → 单个 pending edit 提案 → 人审 apply 落边（既有声明保留）', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    notes: { 入门: {}, 进阶: {} },
    banks: { 入门: [tfQuestion('q1')] },
  }, async ({ engine, root }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '三个月弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', ENC_PLAN('练琴计划'))
    await engine.projectApply(p1.id)
    await seedCoActivity(engine, [1, 2, 3])

    const r = await engine.projectEncCandidates('练琴计划', { min_co: 2 })
    assert.ok(r.events >= 6)
    assert.equal(r.proposals.length, 1, '单课程单提案（enc_backfill 先例）')
    assert.equal(r.proposals[0].course, '数学')
    assert.equal(r.candidates.length, 1)
    assert.equal(r.candidates[0].holder, '进阶', 'pre 闭包方向：入门是进阶的成分技能')
    assert.equal(r.candidates[0].skill, '入门')
    assert.equal(r.candidates[0].w, 1.0, '共现 3 天')

    // 人审：走既有 graphApply（含审计门）——零 schema 破坏，既有 apply 通路直接消费
    const applied = await engine.graphApply('edit', r.proposals[0].id)
    assert.equal(applied.course, '数学')
    assert.equal(applied.ops, 1)
    const dataYaml = readFileSync(join(root, '学习中心', 'math', 'data', '基础.yaml'), 'utf8')
    assert.match(dataYaml, /行为推断（P-6 #96）/)
    assert.match(dataYaml, /name: 进阶[\s\S]*enc:[\s\S]*node: 入门/)

    // 既有声明 enc 保留 + 已声明边不重复提名
    const r2 = await engine.projectEncCandidates('练琴计划', { min_co: 1 })
    assert.equal(r2.proposals.length, 0, '已落边不重复提名')
    assert.equal(r2.skipped_declared, 1)
    const node = await engine.graphNode('数学', '进阶')
    const enc = node.enc as Array<{ node: string; w: number; note?: string }>
    assert.equal(enc.length, 1)
    assert.equal(enc[0].node, '入门')
    assert.match(enc[0].note ?? '', /共现 3 天/)
  })
})

test('行为推断 enc 边界：窗口锚定里程碑过点时刻（过点后行为不在窗内）；min_co 控制灵敏度', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    notes: { 入门: {}, 进阶: {} },
  }, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '三个月弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', ENC_PLAN('练琴计划'))
    await engine.projectApply(p1.id)
    await engine.projectMilestoneWrite('练琴计划', 'm1',
      '## 给定\n\n起点。\n\n## 待办\n\n做。\n\n## 验收清单\n\n- [ ] 完成\n\n## 支持\n\n提示。')
    await engine.projectMilestonePass('练琴计划', 'm1')
    // 过点「之后」的共现行为（此刻）不落在「过点前窗口」内
    await seedCoActivity(engine, [0])
    const r = await engine.projectEncCandidates('练琴计划', { milestone: 'm1' })
    assert.equal(r.events, 0)
    assert.equal(r.proposals.length, 0)
    // 同一批事件对「现在」窗口可见；共现 1 天，min_co=2 时不出候选
    const now = await engine.projectEncCandidates('练琴计划')
    assert.ok(now.events >= 2)
    assert.equal(now.proposals.length, 0)
    // min_co=1 放行：pre 闭包方向 + w=0.6
    const loose = await engine.projectEncCandidates('练琴计划', { min_co: 1 })
    assert.equal(loose.proposals.length, 1)
    assert.equal(loose.candidates[0].w, 0.6)
    assert.equal(loose.candidates[0].holder, '进阶')
  })
})

test('行为推断 enc 红线：跨课程关联不成边；直接写 data 的路径只经提案人审', async () => {
  const registry = [
    'courses:',
    '  - id: math-01',
    '    name: 数学',
    '    root: math',
    '    enabled: true',
    '  - id: eng-01',
    '    name: 英语',
    '    root: eng',
    '    enabled: true',
  ].join('\n')
  await withVault({
    registry,
    graph: TWO_NODE_GRAPH,
    notes: { 入门: {}, 进阶: {} },
    files: [{
      path: '学习中心/eng/data/基础.yaml',
      content: TWO_NODE_GRAPH,
    }],
  }, async ({ engine }) => {
    await engine.projectCreate({ name: '混合计划', goal: '跨课练' })
    const plan = ENC_PLAN('混合计划').replace('nodes: [入门, 进阶]', 'nodes: [数学/入门, 英语/入门]')
    const p1 = await engine.projectPlanPropose('混合计划', plan)
    await engine.projectApply(p1.id)
    // 两个课程各一个节点活跃（同日），但跨课程对不成边
    for (const d of [1, 2, 3]) {
      const ts = recentTs(d)
      await engine.store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: 'a', correct: true, judge: 'allo', ts })
      await engine.store.appendPractice({ course: '英语', node: '入门', ex: 1, answer: 'a', correct: true, judge: 'allo', ts })
    }
    const r = await engine.projectEncCandidates('混合计划', { min_co: 2 })
    assert.equal(r.candidates.length, 0, '跨课程对不成边（enc 边不可跨图）')
    assert.equal(r.proposals.length, 0)
  })
})

test('行为推断 enc 红线：synthetic 复习推进不算行为证据', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    notes: { 入门: {}, 进阶: {} },
  }, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const p1 = await engine.projectPlanPropose('练琴计划', ENC_PLAN('练琴计划'))
    await engine.projectApply(p1.id)
    for (const d of [1, 2, 3]) {
      const ts = recentTs(d)
      await engine.store.appendReview({
        course: '数学', node: '入门', qid: 'q1', rating: 3, rating_source: 'synthetic',
        elapsed_days: 0, stability_before: null, difficulty_before: null, r_pred: null, ts,
      })
      await engine.store.appendReview({
        course: '数学', node: '进阶', qid: 'q2', rating: 3, rating_source: 'synthetic',
        elapsed_days: 0, stability_before: null, difficulty_before: null, r_pred: null, ts,
      })
    }
    const r = await engine.projectEncCandidates('练琴计划', { min_co: 1 })
    assert.equal(r.events, 0, 'synthetic 初始化不是真实翻卡')
    assert.equal(r.proposals.length, 0)
  })
})

test('行为推断 enc 守卫：无关联节点/过点锚点缺失 fail loud', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    notes: { 入门: {}, 进阶: {} },
  }, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: '弹小曲' })
    const noNodes = `project: 练琴计划\nplan:\n  - id: m1\n    name: 里程碑一\n    task_class: 简\n    acceptance_hints: 达标\n`
    const p1 = await engine.projectPlanPropose('练琴计划', noNodes)
    await engine.projectApply(p1.id)
    await assert.rejects(engine.projectEncCandidates('练琴计划'), /没有关联节点/)
    await assert.rejects(engine.projectEncCandidates('练琴计划', { milestone: 'm1' }), /没有过点记录/)
  })
})
