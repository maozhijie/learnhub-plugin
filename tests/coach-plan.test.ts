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
import { readFile, writeFile } from 'node:fs/promises'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import { coachPromptFamily, validatePlanHandover } from '../src/engine/coach/coach-round.ts'
import type { GrowthPlanHandover } from '../src/engine/coach/coach-round.ts'
import { SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, parseCompass, sectionBody, withSectionText } from '../src/engine/coach/compass.ts'
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
    // #316 / ADR-0099：计划契约无 route——罗盘写权归罗盘站，思路官对弧只有建议权。
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

test('#316 / ADR-0099 计划契约无 route：携带即拒收（写权归罗盘站），建议写进 reason', () => {
  // 前进带 route → 计划门拒收，死因点名退役
  assert.ok(
    validatePlanHandover({ ...goldPlan(), route: '- **用导数解决优化问题**：\n  - **某面**：推进广度' } as unknown as GrowthPlanHandover, '数学')
      .some(e => e.includes('route') && e.includes('已退役')),
  )
  // 金计划（无 route）零错误；前进不再必写 route
  assert.deepEqual(validatePlanHandover(goldPlan(), '数学'), [])
  // 停摆/插入/巩固照旧过门
  assert.deepEqual(validatePlanHandover({ ...goldPlan(), operator: '停摆', target_endpoints: [], steps: [] }, '数学'), [])
})

// ---- 两站假 agent：思路官走 complete（单发零工具），执行官走 stream 回路（脚本化） ----

type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }

function twoStationFake(opts: { plans: string[]; sessions: LoopTurn[][] }) {
  const completeCalls: Array<{ prompt: string; mode: 'complete' | 'repair'; effort?: string }> = []
  /** 执行官司路的逐轮请求（回灌的工具结果住在 messages 里——断言补丁期拒收文案用）。 */
  const streamCalls: Array<{ messages: Array<{ text?: string }> }> = []
  let planIdx = 0
  let sessionIdx = 0
  let currentTurns: LoopTurn[] = []
  const seam = new AgentSeam({
    logger: memLogger(),
    // seam.repair 与 complete 同一传输（都进本端口）——mode 按调用序标注：首次 = 单发，后续 = 回灌重裁
    complete: async (prompt, _system, opts2) => {
      const mode = completeCalls.length === 0 ? 'complete' as const : 'repair' as const
      const plan = opts.plans[planIdx++]!
      completeCalls.push({ prompt, mode, effort: opts2?.effort })
      return plan
    },
    stream: async req => {
      streamCalls.push(req as { messages: Array<{ text?: string }> })
      if (!currentTurns.length) {
        const nextSession = opts.sessions[sessionIdx++]
        if (!nextSession) throw new Error('脚本化回路端口：会话脚本已耗尽')
        currentTurns = [...nextSession]
      }
      const turn = currentTurns.shift()!
      return { text: turn.text, toolCalls: turn.toolCalls ?? [] }
    },
  }, systemClock)
  return Object.assign(seam, {
    completeCalls, streamCalls, consumedSessions: () => sessionIdx,
    /** 回灌给执行官的全部文本（含工具结果），拼接后供逐字断言。 */
    fedBack: () => streamCalls.flatMap(c => c.messages.map(m => m.text ?? '')).join('\n'),
  })
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

test('首裁不是重裁（#310 / ADR-0092 §修订）：本课程无生长批历史时 panel_dispatch 也走常规族，且首裁抬 deep 档；有历史后照旧折叠到重裁族', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    // ① 空课首裁 + panel_dispatch：重裁族的叙述（沿用/推翻上次裁决）预设了一个不存在的
    //    上一轮，摘要块也取不到——派发按「触发点 + 状态」折叠，无历史 → 常规族。
    const cold = twoStationFake({ plans: [goldPlanYaml()], sessions: [executorTurns()] })
    await h.engine.growth2.coachGrowthBatch('数学', cold, { trigger: 'panel_dispatch' })
    const coldPrompt = cold.completeCalls[0]!.prompt
    assert.match(coldPrompt, /思路官回合提示词/, '无历史 → 常规族（首裁不是重裁）')
    assert.doesNotMatch(coldPrompt, /思路官重裁提示词/)
    assert.doesNotMatch(coldPrompt, /## 上次裁决摘要（上一次生长批/)

    // ② 有生长批历史之后：panel_dispatch 照旧折叠到重裁族，摘要块在场（现状不变）
    const stopPlan = yamlOf({ operator: '停摆', reason: '就绪缺口由内容生成跟上', target_endpoints: [], steps: [] })
    const warm = twoStationFake({ plans: [stopPlan], sessions: [] })
    await h.engine.growth2.coachGrowthBatch('数学', warm, { trigger: 'panel_dispatch', force: true })
    const warmPrompt = warm.completeCalls[0]!.prompt
    assert.match(warmPrompt, /思路官重裁提示词/, '有历史 → 重裁族（触发点折叠照旧）')
    assert.match(warmPrompt, /## 上次裁决摘要（上一次生长批/)
  })
})

// ---- #310 L5：首裁抬 deep（判据 = 前沿为空，与首级判据块的注入判据同一条） ----

test('首裁抬 deep（#310 L5）：前沿为空的首裁回合用 deep 档，非首裁维持 fast', async () => {
  const stopPlan = yamlOf({ operator: '停摆', reason: '首级台阶留待下一轮', target_endpoints: [], steps: [] })

  // ① 空图首级（只有终点锚 → 前沿为空）：这是「从零决定往哪儿长」的回合
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, { manualEndpoints: [{ name: '终点A', goalNote: '会用导数' }], notes: false })
    const cold = twoStationFake({ plans: [stopPlan], sessions: [] })
    await h.engine.growth2.coachGrowthBatch('数学', cold, { force: true })
    assert.equal(cold.completeCalls[0]!.effort, 'deep', '前沿为空 → deep（错的代价由恒 deep 的执行官以 20 倍 token 支付）')
  })

  // ② 前沿非空（有未开始的就绪节点）→ fast 档照旧
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const warm = twoStationFake({ plans: [stopPlan], sessions: [] })
    await h.engine.growth2.coachGrowthBatch('数学', warm, { force: true })
    assert.equal(warm.completeCalls[0]!.effort, 'fast', '非首裁维持 fast')
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
    // 回灌块带被拒计划原文 + 首轮 schema 错误清单（#296：修复轮不盲修）
    assert.match(agent.completeCalls[1]!.prompt, /计划门反馈/)
    assert.match(agent.completeCalls[1]!.prompt, /operator: 复习/)
    assert.match(agent.completeCalls[1]!.prompt, /schema 门错误清单/)
    assert.match(agent.completeCalls[1]!.prompt, /operator 非法/)
  })
})

// ---- 插入批的复诊预注册写入面（#312 B2）----

/** 插入批的补丁轮：在「认识变化率」与终点之间插一步（并把终点接线改到插入节点）。 */
function insertPatchTurn(noteExtra: Record<string, unknown>): LoopTurn {
  const patch = {
    ops: [
      { op: 'add_node', name: '中间台阶', pre: ['认识变化率'], est: 12, teaches: { 变化率: '会用' } },
      { op: 'set_pre', node: '用导数解决优化问题', pre: ['中间台阶'] },
    ],
    note_operator: '插入',
    note_reason: '卡点集中在缺失的前置步骤上，插一步补上',
    note_target_endpoints: ['用导数解决优化问题'],
    ...noteExtra,
  }
  return { text: '落补丁。', toolCalls: [{ id: 'p1', name: 'draft_patch', arguments: JSON.stringify(patch) }] }
}

function finishTurns(): LoopTurn[] {
  return [
    { text: '发布。', toolCalls: [{ id: 'f1', name: 'draft_finish', arguments: '{}' }] },
    { text: '本批已发布。' },
  ]
}

test('#312 B2：插入批经执行官站可发布——计划里的预注册复诊随批落地，账本登记在途', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    // 思路官侧本来就在计划里给了 recheck（交接块明写给执行官）；此前的写入面缺失让它
    // 到不了 note：draft_patch 无该参数、EditProposalNoteLite 无该字段、finish 不透传——
    // 受理门「插入批必须预注册复诊」因此恒拒 = 插入算子结构性不可发布。
    const plan = yamlOf({
      operator: '插入',
      reason: '卡点集中在缺失的前置步骤上',
      target_endpoints: ['用导数解决优化问题'],
      steps: [{ intent: '补上中间一步', teaches_concept: '变化率' }],
      recheck: { metric: '卡点集中度降幅', days: 8 },
    })
    const agent = twoStationFake({ plans: [plan], sessions: [[insertPatchTurn({}), ...finishTurns()]] })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.equal(r.state, 'applied', '插入批照常走真实提案管线发布')
    assert.deepEqual(r.applied!.created, ['中间台阶'])
    // 预注册落字处 = 提案 artifact 的 note.recheck，且边实验账本据此登记在途复诊
    const view = await h.engine.growth2.probationStatus('数学')
    assert.deepEqual(view.courses[0]!.in_flight, ['中间台阶'], '插入边随批登记在途（复诊到期自动结算）')
    const artifact = await h.engine.fs.readFile(h.engine.paths.proposalArtifactPath(r.proposal!.id, 'edit', '数学'))
    assert.match(artifact, /卡点集中度降幅/, '计划的复诊判据随批落到 artifact（结算侧按它取数）')
  })
})

test('#312 B2：执行官显式写的 note_recheck 覆盖计划里的那一枚；取值域非法当场拒收（整批回滚）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const plan = yamlOf({
      operator: '插入',
      reason: '卡点集中在缺失的前置步骤上',
      target_endpoints: ['用导数解决优化问题'],
      steps: [{ intent: '补上中间一步' }],
      recheck: { metric: '卡点集中度降幅', days: 8 },
    })
    const agent = twoStationFake({
      plans: [plan],
      sessions: [[
        // 第一发：非法的复诊指标——整批回滚（ops 一条不落草稿），回执带合法取值域
        insertPatchTurn({ note_recheck: { metric: '卡点降低' } }),
        // 第二发：同一条补丁，写合法的预注册——原样入草稿并胜出（计划是 advisory）
        insertPatchTurn({ note_recheck: { metric: '保留率恢复', days: 6 } }),
        ...finishTurns(),
      ]],
    })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.equal(r.state, 'applied')
    assert.match(agent.fedBack(), /metric ∈ 前进恢复\/卡点集中度降幅\/保留率恢复/, '拒收回执带取值域')
    assert.match(agent.fedBack(), /整批回滚/, '拒收是整批的（ops 不落草稿）')
    const artifact = await h.engine.fs.readFile(h.engine.paths.proposalArtifactPath(r.proposal!.id, 'edit', '数学'))
    assert.match(artifact, /保留率恢复/, '执行官写的那一枚胜出')
    assert.doesNotMatch(artifact, /卡点集中度降幅/, '计划的那一枚未被采用（显式值优先）')
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

// ---- #303：首级判据材料随上下文包进两族思路官（模板文件零改动，故断言落在 prompt 上）----

test('#303 两族共享首级判据：前沿为空时回合/重裁两族提示词都带判据块；重裁族与上次裁决摘要共存', async () => {
  await withVault(SEED, async h => {
    // 前沿变空的现实路径：先跑一批（产出「平均变化率」+ 落一条 applied 提案），
    // 再把两个节点学完——图上仍有普通节点，但未开始存量归零（非「仅终点」特例）。
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const first = twoStationFake({ plans: [goldPlanYaml()], sessions: [executorTurns()] })
    const r1 = await h.engine.growth2.coachGrowthBatch('数学', first)
    assert.equal(r1.state, 'applied')
    for (const node of ['认识变化率', '平均变化率']) await h.engine.sched2.nodeComplete('数学', node, true)

    // ① 常规生长族：判据块进提示词（材料随包，模板文本一字未动）
    const stopPlan = yamlOf({ operator: '停摆', reason: '就绪缺口由内容生成跟上', target_endpoints: [], steps: [] })
    const routine = twoStationFake({ plans: [stopPlan], sessions: [] })
    await h.engine.growth2.coachGrowthBatch('数学', routine, { force: true })
    const routinePrompt = routine.completeCalls[0]!.prompt
    assert.match(routinePrompt, /思路官回合提示词/)
    assert.match(routinePrompt, /首级判据（本回合\*\*前沿为空\*\*/, '常规族带判据块')
    assert.match(routinePrompt, /零复合概念/, '判据四条随行（ADR-0040 原文）')
    assert.match(routinePrompt, /裁决纪律：优先选能同时推进多个未达成终点的台阶/, '与既有裁决纪律行同域共存')

    // ② 显式重裁族：同一上下文包组装 → 判据块同样在场；「上次裁决摘要」块与它共存无冲突
    const recheck = twoStationFake({ plans: [stopPlan], sessions: [] })
    await h.engine.growth2.coachGrowthBatch('数学', recheck, { force: true, trigger: 'panel_dispatch' })
    const recheckPrompt = recheck.completeCalls[0]!.prompt
    assert.match(recheckPrompt, /思路官重裁提示词/)
    assert.match(recheckPrompt, /首级判据（本回合\*\*前沿为空\*\*/, '重裁族同样带判据块（两族经同一上下文包组装）')
    assert.match(recheckPrompt, /## 上次裁决摘要（上一次生长批/, '上一批的 applied 提案留痕照常注入（#303 顺带修正：旧实现把落盘路径当产物原文读 → 摘要块恒不出现）')
    assert.ok(
      recheckPrompt.indexOf('首级判据（本回合') < recheckPrompt.indexOf('## 上次裁决摘要'),
      '段序纪律：包材料在前、包外注入块在后',
    )
  })
})

// ---- #316 / ADR-0099：罗盘写权反转（计划不携带 route；罗盘不随生长批动）----

test('#316 计划携带 route 被计划门拒 → 回灌重裁恰一次（死因点名 route 退役）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    // 前进 + 带 route 的旧契约计划——计划门判它越权写弧，当场拒收
    const legacy = goldPlanYaml() + '\nroute: |\n  - **某面**：推进广度'
    const agent = twoStationFake({ plans: [legacy, goldPlanYaml()], sessions: [executorTurns()] })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.equal(r.state, 'applied')
    assert.equal(agent.completeCalls.length, 2, '计划门拒收 → 回灌重裁恰一次')
    assert.equal(agent.completeCalls[1]!.mode, 'repair')
    assert.match(agent.completeCalls[1]!.prompt, /route/, '死因点名 route')
    assert.match(agent.completeCalls[1]!.prompt, /已退役/, '错误行点名退役与写权归属')
  })
})

test('#316 前进批不动罗盘：「剩余路线」段原样保留（写权归罗盘站）', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const p = h.engine.paths.compassPath('数学')
    // 先写一份已画路线——前进批不得碰它（弧只在罗盘站初画/重估时变）
    const R0 = '- **用导数解决优化问题**：\n  - **旧稿台阶**：罗盘站初画的路线（候选）'
    await writeFile(p, withSectionText(await readFile(p, 'utf8'), SECTION_ROUTE, R0))

    const agent = twoStationFake({ plans: [goldPlanYaml()], sessions: [executorTurns()] })
    const r = await h.engine.growth2.coachGrowthBatch('数学', agent)
    assert.equal(r.state, 'applied')

    const doc = parseCompass(await readFile(p, 'utf8'))
    assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), R0, '罗盘不随生长批动（写权归罗盘站）')
  })
})

// ---- #319 / ADR-0099：阶段标题锚点 + serves_arc 软对齐 + 结构性重画建议通道 ----

test('#319 计划契约增 serves_arc 与 repaint_suggest：形状门（枚举/非空字符串），命中与否不在本门执法', () => {
  // serves_arc：合法标题过门（不校验是否真在弧上——软对齐在引擎侧对表）
  assert.deepEqual(validatePlanHandover({ ...goldPlan(), serves_arc: '某阶段' }, '数学'), [])
  // serves_arc：空串/非字符串拒收（形状门）
  assert.ok(validatePlanHandover({ ...goldPlan(), serves_arc: '' }, '数学').some(e => e.includes('serves_arc')))
  assert.ok(validatePlanHandover({ ...goldPlan(), serves_arc: 42 } as unknown as GrowthPlanHandover, '数学').some(e => e.includes('serves_arc')))
  // repaint_suggest：结构性理由过门；读数型理由（枚举外）当场拒收
  assert.deepEqual(validatePlanHandover({ ...goldPlan(), repaint_suggest: { reason_class: '前沿枯竭' } }, '数学'), [])
  assert.ok(validatePlanHandover({ ...goldPlan(), repaint_suggest: { reason_class: '最近学得吃力' } }, '数学').some(e => e.includes('reason_class 非法')))
  assert.ok(validatePlanHandover({ ...goldPlan(), repaint_suggest: { reason_class: '保留率下滑' } }, '数学').some(e => e.includes('reason_class 非法')))
  assert.ok(validatePlanHandover({ ...goldPlan(), repaint_suggest: { reason_class: '前沿枯竭', note: '' } }, '数学').some(e => e.includes('note')))
})

const ARC_ROUTE = '- **用导数解决优化问题**：\n  - **阶段一：直觉**：推进广度\n  - **阶段二：定义**：推进深度'
const stopPlanWith = (extra = ''): string =>
  'course: 数学\noperator: 停摆\nreason: 就绪缺口由内容生成跟上\ntarget_endpoints: []\nsteps: []\n' + extra

test('#319 serves_arc 软对齐：命中留痕 + 连击清零；编造标题留痕不拒收；连续三批升级告警；建议随行带出', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const p = h.engine.paths.compassPath('数学')
    await writeFile(p, withSectionText(await readFile(p, 'utf8'), SECTION_ROUTE, ARC_ROUTE))

    // ① 命中：合法阶段标题 → info 留痕，停摆计划照常 idle
    const hit = twoStationFake({ plans: [stopPlanWith('serves_arc: 阶段一：直觉\n')], sessions: [] })
    const r1 = await h.engine.growth2.coachGrowthBatch('数学', hit, { force: true })
    assert.equal(r1.state, 'idle')
    assert.equal(h.logger.count('coach.arc.align'), 1)
    assert.equal(h.logger.nth('coach.arc.align')!.fields.serves_arc, '阶段一：直觉')

    // ② 建议通道：repaint_suggest 全量留痕 + 随行带出（宿主去抖入队）
    const suggest = stopPlanWith('repaint_suggest:\n  reason_class: 弧段走完\n  note: 当前弧段已全部走完\n')
    const r2 = await h.engine.growth2.coachGrowthBatch('数学', twoStationFake({ plans: [suggest], sessions: [] }), { force: true })
    assert.deepEqual(r2.repaint_suggest, { reason_class: '弧段走完', note: '当前弧段已全部走完' })
    assert.equal(h.logger.count('coach.repaint.suggest'), 1)

    // ③ 编造标题：留痕不拒收（state 照常），连击逐批涨，第三批升级告警
    for (let i = 1; i <= 3; i++) {
      await h.engine.growth2.coachGrowthBatch('数学', twoStationFake({ plans: [stopPlanWith('serves_arc: 编造的阶段\n')], sessions: [] }), { force: true })
      assert.equal(h.logger.count('coach.arc.align_miss'), i)
      assert.equal(h.logger.nth('coach.arc.align_miss')!.fields.streak, i)
    }
    assert.equal(h.logger.count('coach.arc.align_streak'), 1, '连续 3 批指认不出 → 告警事件')

    // ④ 命中后连击清零：再编造一次从 1 起算
    await h.engine.growth2.coachGrowthBatch('数学', twoStationFake({ plans: [stopPlanWith('serves_arc: 阶段二：定义\n')], sessions: [] }), { force: true })
    assert.equal(h.logger.count('coach.arc.align'), 2)
    await h.engine.growth2.coachGrowthBatch('数学', twoStationFake({ plans: [stopPlanWith('serves_arc: 又编造\n')], sessions: [] }), { force: true })
    assert.equal(h.logger.nth('coach.arc.align_miss', 4)!.fields.streak, 1)
  })
})

test('#319 锚点空位：弧未画时软对齐退化（缺席不推定，不计连击），建议照常带出', async () => {
  await withVault(SEED, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    // 不画弧（罗盘停留在 ROUTE_PENDING）——serves_arc 指认退化为纯软注入
    const plan = stopPlanWith('serves_arc: 随便什么\nrepaint_suggest:\n  reason_class: 前沿枯竭\n')
    const r = await h.engine.growth2.coachGrowthBatch('数学', twoStationFake({ plans: [plan], sessions: [] }), { force: true })
    assert.equal(r.state, 'idle')
    assert.equal(h.logger.count('coach.arc.align_degenerate'), 1)
    assert.equal(h.logger.nth('coach.arc.align_degenerate')!.fields.reason, 'missing-route')
    assert.equal(h.logger.count('coach.arc.align_miss'), 0, '缺席不计连击')
    assert.deepEqual(r.repaint_suggest, { reason_class: '前沿枯竭' })
  })
})
