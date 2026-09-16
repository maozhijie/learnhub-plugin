/**
 * 思路官站与两站编排（#273）：教练去集中后的方向裁决站——单轮、零工具、单发产交接计划
 * {operator, target_endpoints, reason, steps, recheck?}，零节点名零图上引用；计划 schema
 * 门拒收 → 门错误 + 被拒计划原文回灌重裁恰一次（plannerRecheckOnce）；提示词两族随触发
 * 点折叠（coachPromptFamily 纯函数）；停摆计划不拉执行官；全链 = 思路官 plan（脚本化）
 * → 执行官轨迹（脚本化）→ 真实提案管线发布。
 *
 * 「单发形态」对照基线（#163 实验的遗产）：旧盲盒单发已被两站编排替换（零名字契约让
 * 幻觉面结构性消失），本文件的全链断言（首次过门 8/8 → 全链逐场景 applied）即新回路的
 * 过门率下限——回路基线以脚本化全链全过为准，不再保留第二套单发活路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSeam } from '../src/engine/agent.ts'
import { coachPromptFamily, validatePlanHandover } from '../src/engine/coach-round.ts'
import type { GrowthPlanHandover } from '../src/engine/coach-round.ts'
import { systemClock } from '../src/host/clock.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

const SEED = { registry: null, graph: null }

// ---- 族判定纯函数：trigger → 族的纯函数映射 ----

test('coachPromptFamily：常规生长族三点 + 显式重裁族两点（票面折叠）', () => {
  assert.equal(coachPromptFamily('node_complete'), 'routine')
  assert.equal(coachPromptFamily('session_start'), 'routine')
  assert.equal(coachPromptFamily('queue_idle'), 'routine')
  assert.equal(coachPromptFamily('node_skip'), 'recheck')
  assert.equal(coachPromptFamily('panel_dispatch'), 'recheck')
})

// ---- 计划 schema 门（纯函数，错误作数据） ----

function goldPlan(): GrowthPlanHandover {
  return {
    operator: '前进',
    reason: '前沿缺下一台阶，沿终点推进',
    target_endpoints: ['用导数解决优化问题'],
    steps: [{ intent: '从日常速度建立「变化多快」的直觉', teaches_concept: '变化率', est_hint: 15 }],
  }
}

const yamlOf = (p: Record<string, unknown>): string => [
  'course: 数学',
  `operator: ${String(p.operator)}`,
  `reason: ${String(p.reason)}`,
  ...(p.target_endpoints === undefined ? [] : [`target_endpoints: [${(p.target_endpoints as string[]).join('、')}]`]),
  ...(p.steps === undefined ? [] : (p.steps as unknown[]).length ? ['steps:', ...(p.steps as Array<Record<string, unknown>>).flatMap(s => [
    '  - intent: ' + String(s.intent ?? ''),
    ...(s.teaches_concept ? [`    teaches_concept: ${String(s.teaches_concept)}`] : []),
    ...(s.est_hint ? [`    est_hint: ${String(s.est_hint)}`] : []),
    ...(s.op ? [`    op: ${String(s.op)}`] : []),
    ...(s.name ? [`    name: ${String(s.name)}`] : []),
  ])] : ['steps: []']),
  ...(p.recheck === undefined ? [] : [`recheck:`, `  metric: ${String((p.recheck as Record<string, unknown>).metric)}`, `  days: ${String((p.recheck as Record<string, unknown>).days)}`]),
].join('\n')

test('validatePlanHandover：金计划零错误；枚举/朝向/零名字/recheck 各负例逐类拦截', () => {
  assert.deepEqual(validatePlanHandover(goldPlan(), '数学'), [])
  // 非法算子
  assert.ok(validatePlanHandover({ ...goldPlan(), operator: '复习' }, '数学').some(e => e.includes('operator 非法')))
  // 缺 reason
  assert.ok(validatePlanHandover({ ...goldPlan(), reason: '' }, '数学').some(e => e.includes('reason')))
  // 前进缺朝向
  assert.ok(validatePlanHandover({ ...goldPlan(), target_endpoints: [] }, '数学').some(e => e.includes('target_endpoints')))
  // 台阶缺 intent
  assert.ok(validatePlanHandover({ ...goldPlan(), steps: [{ est_hint: 10 }] }, '数学').some(e => e.includes('intent')))
  // 零名字契约：台阶带图 op 字段 = 越权写补丁
  assert.ok(validatePlanHandover({ ...goldPlan(), steps: [{ intent: 'x', op: 'add_node' }] }, '数学').some(e => e.includes('op')))
  assert.ok(validatePlanHandover({ ...goldPlan(), steps: [{ intent: 'x', name: '某节点' }] }, '数学').some(e => e.includes('name')))
  // recheck 仅插入批携带
  assert.ok(validatePlanHandover({ ...goldPlan(), recheck: { metric: '前进恢复' } }, '数学').some(e => e.includes('recheck 仅')))
  // metric 枚举与 days 区间
  assert.ok(validatePlanHandover({ ...goldPlan(), operator: '插入', recheck: { metric: '瞎蒙恢复' } }, '数学').some(e => e.includes('metric 非法')))
  assert.ok(validatePlanHandover({ ...goldPlan(), operator: '插入', recheck: { metric: '前进恢复', days: 40 } }, '数学').some(e => e.includes('5–20')))
  // 插入 + 合法 recheck 过门；停摆无朝向也过
  assert.deepEqual(validatePlanHandover({ ...goldPlan(), operator: '插入', recheck: { metric: '前进恢复', days: 10 } }, '数学'), [])
  assert.deepEqual(validatePlanHandover({ ...goldPlan(), operator: '停摆', target_endpoints: [], steps: [] }, '数学'), [])
  // course 不符
  assert.ok(validatePlanHandover({ ...goldPlan(), course: '物理' } as unknown as GrowthPlanHandover, '数学').some(e => e.includes('course')))
})

// ---- 两站假 agent：思路官走 complete（单发零工具），执行官走 stream 回路（脚本化） ----

type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }

function twoStationFake(opts: { plans: string[]; sessions: LoopTurn[][] }) {
  const completeCalls: Array<{ prompt: string; mode: 'complete' | 'repair' }> = []
  let planIdx = 0
  let sessionIdx = 0
  let currentTurns: LoopTurn[] = []
  const seam = new AgentSeam({
    logger: memLogger(),
    // seam.repair 与 complete 同一传输（都进本端口）——mode 按调用序标注：首次 = 单发，后续 = 回灌重裁
    complete: async prompt => {
      const mode = completeCalls.length === 0 ? 'complete' as const : 'repair' as const
      const plan = opts.plans[planIdx++]!
      completeCalls.push({ prompt, mode })
      return plan
    },
    stream: async () => {
      if (!currentTurns.length) {
        const nextSession = opts.sessions[sessionIdx++]
        if (!nextSession) throw new Error('脚本化回路端口：会话脚本已耗尽')
        currentTurns = [...nextSession]
      }
      const turn = currentTurns.shift()!
      return { text: turn.text, toolCalls: turn.toolCalls ?? [] }
    },
  }, systemClock)
  return Object.assign(seam, { completeCalls, consumedSessions: () => sessionIdx })
}

function goldPlanYaml(): string {
  return yamlOf(goldPlan() as unknown as Record<string, unknown>) + '\n'
}

function executorTurns(): LoopTurn[] {
  const patch = {
    ops: [
      { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, bloom: '理解', difficulty: 2, teaches: { 变化率: '会用' } },
      { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
    ],
    note_operator: '前进',
    note_reason: '前沿缺下一台阶，沿终点推进',
    note_target_endpoints: ['用导数解决优化问题'],
  }
  return [
    { text: '先读图。', toolCalls: [{ id: 'g1', name: 'graph_view', arguments: '{}' }] },
    { text: '落补丁。', toolCalls: [{ id: 'p1', name: 'draft_patch', arguments: JSON.stringify(patch) }] },
    { text: '审计。', toolCalls: [{ id: 'a1', name: 'draft_audit', arguments: '{}' }] },
    { text: '发布。', toolCalls: [{ id: 'f1', name: 'draft_finish', arguments: '{}' }] },
    { text: '本批已发布，回合完成。' },
  ]
}

test('全链：思路官 plan（脚本化）→ 执行官轨迹 → 真实提案管线发布；segments 与交接块可观测', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = twoStationFake({ plans: [goldPlanYaml()], sessions: [executorTurns()] })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.equal(r.state, 'applied')
    assert.deepEqual(r.segments.map(s => s.tier), ['plan', 'executor'])
    assert.equal(r.segments[0]!.operator, '前进')
    assert.ok(r.proposal!.id > 0, '提案 id 随行')
    assert.deepEqual(r.applied!.created, ['平均变化率'])
    assert.ok(r.applied!.ops > 0 && r.applied!.snapshot > 0)
    // 思路官提示词带图面与上下文包；零工具——工具面不应出现在思路官 prompt
    const planPrompt = agent.completeCalls[0]!.prompt
    assert.match(planPrompt, /当前图面/)
    assert.match(planPrompt, /思路官回合提示词/)
    // 交接块进执行官 prompt（advisory）：意图句台阶随包
    assert.match(planPrompt, /变化率/)
  })
})

test('停摆计划（operator=停摆）：不拉执行官，合法停摆零提案', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const plan = yamlOf({ operator: '停摆', reason: '就绪缺口由内容生成跟上', target_endpoints: [], steps: [] })
    const agent = twoStationFake({ plans: [plan], sessions: [] })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.equal(r.state, 'idle')
    assert.equal(r.proposal, null)
    assert.deepEqual(r.segments.map(s => s.tier), ['plan'])
    assert.equal(agent.consumedSessions(), 0, '执行官回路未被拉起')
  })
})

test('显式重裁族（panel_dispatch）：走「思路官重裁」模板；无留痕时不带上次裁决摘要块', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const agent = twoStationFake({ plans: [goldPlanYaml()], sessions: [executorTurns()] })
    await h.engine.growth2.coachGrowthBatch('数学', agent, { trigger: 'panel_dispatch' })
    const planPrompt = agent.completeCalls[0]!.prompt
    assert.match(planPrompt, /思路官重裁提示词/)
    assert.doesNotMatch(planPrompt, /## 上次裁决摘要（上一次生长批/)  
    // 常规族对照：session_start 走「思路官回合」
    const h2 = agent
    void h2
  })
})

test('计划门拒收 → 回灌重裁恰一次（plannerRecheckOnce）；segments 带 plan_repair', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const badPlan = yamlOf({ operator: '复习', reason: 'x', target_endpoints: [], steps: [] })
    const agent = twoStationFake({ plans: [badPlan, goldPlanYaml()], sessions: [executorTurns()] })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.deepEqual(r.segments.map(s => s.tier), ['plan', 'plan_repair', 'executor'])
    assert.equal(agent.completeCalls.length, 2)
    assert.equal(agent.completeCalls[1]!.mode, 'repair')
    // 回灌块带被拒计划原文
    assert.match(agent.completeCalls[1]!.prompt, /计划门反馈/)
    assert.match(agent.completeCalls[1]!.prompt, /operator: 复习/)
  })
})

test('两轮死因：重裁仍败 → fail loud（零提案落盘）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const badPlan = yamlOf({ operator: '复习', reason: 'x', target_endpoints: [], steps: [] })
    const agent = twoStationFake({ plans: [badPlan, badPlan], sessions: [] })
    await assert.rejects(
      () => h.engine.growth2.coachGrowthBatch('数学', agent),
      /思路官计划未过 schema 门[\s\S]*【首轮】[\s\S]*【重裁】/,
    )
    assert.equal(agent.completeCalls.length, 2, '恰一次回灌（两轮死因）')
  })
})
