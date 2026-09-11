import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clampRecheckDays, recheckPreregOf, appendProbationEntry, readProbationLedger, foldProbation,
  recheckVerdict, recheckDue, learningDaysOf, growthRates, growthGate,
} from '../src/engine/probation.ts'
import type { ProbationEntry, ReviewRec } from '../src/engine/probation.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import type { PracticeRec } from '../src/engine/types.ts'
import { readSedimentCanon } from '../src/engine/sediment.ts'
import { withVault, tfQuestion, localDay } from './helpers/vault.ts'

// 边实验账本与复诊（#146 / 插入提案生命周期）：
// - 纯函数层（接缝 S53）：预注册 schema（metric 恰一枚/days clamp）、账本 IO 与折叠、
//   三枚可机判 metric 的结算判定、三率（滚动 30 学习日）与韧性闸门映射。
// - 门面全链：插入批受理（预注册随提案落字 → apply 同事务落账本）→ probation 在途
//   行使闸（只记流不回流，proven 恢复；前进节点不受闸）→ 到期结算钩子（proven｜
//   自动剪除 + 原粗边恢复 + 内容归档，零人审）→ 沉淀正典（recheck_outcome /
//   graph_repair）→ data-check 到期未决 hint 与面板三率/「实验中」可见。
// 确定性：复诊期按课程学习日推进（练习流水种子即学习日），登记日 = 提案 decided 日。

// ---- 种子材料 ----

/** 两节点图：入门 → 进阶（插入批在中间补「过渡」，剪除时恢复粗边 入门→进阶）。 */
const TWO_NODE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 20 }',
].join('\n')

/** 插入批 YAML：过渡节点 + set_pre 把进阶的前置换成过渡（复诊剪除时恢复 入门）。 */
function insertionYaml(opts: {
  metric?: string
  days?: string
  recheck?: boolean
  operator?: string
  withConcept?: boolean
  name?: string
  pre?: string
} = {}): string {
  const operator = opts.operator ?? '插入'
  const recheckOn = opts.recheck ?? true
  const name = opts.name ?? '过渡'
  return [
    'course: 数学',
    'note:',
    `  operator: ${operator}`,
    '  reason: 卡点集中指向过渡缺口，当场补台阶',
    ...(recheckOn
      ? [`  recheck:`, `    metric: ${opts.metric ?? '前进恢复'}`, ...(opts.days ? [`    days: ${opts.days}`] : [])]
      : []),
    'ops:',
    '  - op: add_node',
    `    name: ${name}`,
    '    region: 基础',
    '    block: 入门块',
    `    pre: [${opts.pre ?? '入门'}]`,
    '    est: 10',
    ...(opts.withConcept ? ['    teaches: {过渡概念: 会用}'] : []),
    '  - op: set_pre',
    '    node: 进阶',
    `    pre: [${name}]`,
    ...(opts.withConcept ? ['concepts:', '  - canonical: 过渡概念'] : []),
  ].join('\n') + '\n'
}

/** 插入批受理：propose + apply（返回 apply 结果）。 */
async function applyInsertion(engine: Awaited<ReturnType<typeof withVault>>['engine'], yaml: string): Promise<Record<string, unknown>> {
  const prop = await engine.graph.graphPropose('edit', yaml) as { id: number }
  return await engine.graph.graphApply('edit', prop.id) as Record<string, unknown>
}

/** 学习日种子：练习流水即课程学习日（ts 用本地正午——dayOfTs 按本地时区折叠）。 */
const ts = (offset: number): string => `${localDay(offset)}T12:00:00`
const pRec = (offset: number, node: string, opts: Partial<PracticeRec> = {}): PracticeRec => ({
  ts: ts(offset), course: '数学', node, ex: 1, answer: '', correct: true, judge: 'true_false', ...opts,
})
const rRec = (offset: number, node: string, qid: string, rating: 1 | 3): ReviewRec => ({
  ts: ts(offset), course: '数学', node, qid, rating, rating_source: 'auto', elapsed_days: 1,
  stability_before: 3, difficulty_before: 5, r_pred: 0.9,
})

// ---- 纯函数层：预注册 schema ----

test('recheckPreregOf：metric 恰一枚枚举锁死、未知键拒收、days 越界 clamp 落 warn 不拒收', () => {
  const legal = recheckPreregOf({ metric: '前进恢复' })
  assert.equal(legal.errors.length, 0)
  assert.deepEqual(legal.prereg, { metric: '前进恢复' })

  const withDays = recheckPreregOf({ metric: '保留率恢复', days: 12 })
  assert.deepEqual(withDays.prereg, { metric: '保留率恢复', days: 12 })

  // 越界 clamp（[5,20]），clamp 落 warn
  const clampedLow = recheckPreregOf({ metric: '前进恢复', days: 3 })
  assert.equal(clampedLow.errors.length, 0)
  assert.deepEqual(clampedLow.prereg, { metric: '前进恢复', days: 5 })
  assert.match(clampedLow.warns.join(''), /clamp/)
  const clampedHigh = recheckPreregOf({ metric: '前进恢复', days: 100 })
  assert.deepEqual(clampedHigh.prereg, { metric: '前进恢复', days: 20 })

  // 负路径
  assert.match(recheckPreregOf({ metric: '疗效验证' }).errors.join(''), /metric/)
  assert.match(recheckPreregOf({ metric: '前进恢复', origin: 'x' }).errors.join(''), /未知字段/)
  assert.match(recheckPreregOf({ days: 10 }).errors.join(''), /metric/)
  assert.match(recheckPreregOf({ metric: '前进恢复', days: 'x' }).errors.join(''), /days/)
  assert.match(recheckPreregOf('过渡').errors.join(''), /映射/)
  assert.equal(clampRecheckDays(10), 10)
})

// ---- 纯函数层：账本 IO 与折叠 ----

test('边实验账本：追加只增、Missing 合法空态、损坏行跳过、写侧坏形状 fail loud', async () => {
  await withVault({ graph: TWO_NODE_GRAPH }, async ({ paths }) => {
    // Missing = 合法空态
    assert.deepEqual(await readProbationLedger(paths, 'math', nodeVaultFs), [])

    const entry: ProbationEntry = { node: '过渡', pre: ['入门'], proposal: 3, due: 10 }
    await appendProbationEntry(paths, 'math', entry, nodeVaultFs)
    await appendProbationEntry(paths, 'math', { ...entry, outcome: 'proven', decided_at: '2026-09-10T10:00:00' }, nodeVaultFs)
    const ledger = await readProbationLedger(paths, 'math', nodeVaultFs)
    assert.equal(ledger.length, 2)

    // 写侧坏形状 fail loud（outcome 落了没带 decided_at；proposal 非正整数）
    await assert.rejects(
      () => appendProbationEntry(paths, 'math', { node: '过渡', pre: [], proposal: 3, due: 10, outcome: 'proven' }, nodeVaultFs),
      /decided_at/)
    await assert.rejects(
      () => appendProbationEntry(paths, 'math', { node: '过渡', pre: [], proposal: -1, due: 10 }, nodeVaultFs),
      /proposal/)

    // 损坏行跳过（手工半行）
    const p = paths.probationLedgerPath('math')
    await writeFile(p, await readFile(p, 'utf8') + '{broken\n', 'utf8')
    assert.equal((await readProbationLedger(paths, 'math', nodeVaultFs)).length, 2)
  })
})

test('foldProbation：每 (proposal, node) 取最后一行——outcome 后行覆盖前行（probation→proven｜剪除）', () => {
  const entries: ProbationEntry[] = [
    { node: '过渡', pre: ['入门'], proposal: 1, due: 10 },
    { node: '旁支甲', pre: ['入门'], proposal: 2, due: 10 },
    { node: '过渡', pre: ['入门'], proposal: 1, due: 10, outcome: '剪除', decided_at: '2026-09-11T10:00:00' },
  ]
  const fold = foldProbation(entries)
  assert.equal(fold.inFlight.length, 1)
  assert.equal(fold.inFlight[0]!.node, '旁支甲')
  assert.equal(fold.decided.length, 1)
  assert.equal(fold.decided[0]!.outcome, '剪除')
  assert.equal(fold.byNode.get('过渡')!.outcome, '剪除')
})

// ---- 纯函数层：学习日、到期判定与三枚 metric ----

test('learningDaysOf：practice ∪ 到期复习首推去重升序、课程过滤、未来日排除；recheckDue 按学习日数判到期', () => {
  const practice = [pRec(0, '入门'), pRec(1, '入门'), pRec(1, '入门'), pRec(5, '入门'), pRec(-2, '入门', { course: '物理' })]
  const reviews = [rRec(2, '入门', 'q1', 3), rRec(2, '入门', 'q1', 3)]
  const days = learningDaysOf(practice, reviews, '数学', 0, localDay(4))
  assert.deepEqual(days, [localDay(0), localDay(1), localDay(2)], '去重升序、非本课程与未来日排除')

  assert.equal(recheckDue(days, localDay(0), 3).due, true, '登记日（含）起学习日 3 天 = 复诊期 3 → 到期')
  assert.equal(recheckDue(days, localDay(0), 4).due, false, '学习日 3 天 < 复诊期 4 → 未到期')
  const days6 = learningDaysOf([...practice, pRec(6, '入门')], reviews, '数学', 0, localDay(6))
  assert.equal(recheckDue(days6, localDay(0), 3).due, true, '学习日推进满复诊期 → 到期')
})

test('recheckVerdict·前进恢复：复诊窗下游消费节点答对打通 = 达标；复诊前已答对/复诊窗无答对 = 不达标', () => {
  const base = {
    metric: '前进恢复' as const, course: '数学', cutoff: 0,
    entryDay: localDay(0), today: localDay(6), period: 5,
    consumers: ['进阶'], invokesOf: () => null,
  }
  // 复诊窗内进阶出现答对（复诊前无）→ 打通
  const met = recheckVerdict({ ...base, practice: [pRec(2, '进阶')], reviews: [] })
  assert.equal(met.met, true)
  assert.match(met.detail, /进阶/)

  // 复诊前已在进阶答对（停滞前提不成立）+ 复诊窗也答对 → 不算恢复
  const notMet = recheckVerdict({
    ...base, practice: [pRec(-2, '进阶'), pRec(2, '进阶')], reviews: [],
  })
  assert.equal(notMet.met, false)

  // 复诊窗无下游答对 → 不达标（诚实口径：疗效未证 = 剪）
  const silent = recheckVerdict({ ...base, practice: [pRec(2, '入门')], reviews: [] })
  assert.equal(silent.met, false)
})

test('recheckVerdict·卡点集中度降幅：错误清零直接达标；降幅 ≥ 阈值达标；无前提不达标', () => {
  const err = (offset: number, qid: string): PracticeRec => pRec(offset, '进阶', { qid, correct: false })
  const base = {
    metric: '卡点集中度降幅' as const, course: '数学', cutoff: 0,
    entryDay: localDay(0), today: localDay(6), period: 5,
    consumers: ['进阶'], invokesOf: (qid: string) => (qid === 'q1' ? '导数' : '积分'),
  }
  // 复诊窗错误清零 → 达标
  const cleared = recheckVerdict({ ...base, practice: [err(-2, 'q1'), err(-1, 'q1')], reviews: [] })
  assert.equal(cleared.met, true)
  // 集中度 1.0 → 0.5（降 0.5 ≥ 0.2）→ 达标
  const dropped = recheckVerdict({
    ...base,
    practice: [err(-2, 'q1'), err(-1, 'q1'), err(1, 'q1'), err(2, 'q2')],
    reviews: [],
  })
  assert.equal(dropped.met, true)
  // 集中度持平 1.0 → 1.0 → 不达标
  const flat = recheckVerdict({
    ...base,
    practice: [err(-2, 'q1'), err(-1, 'q1'), err(1, 'q1'), err(2, 'q1')],
    reviews: [],
  })
  assert.equal(flat.met, false)
  // 复诊前无错误（卡点前提不存在）→ 不达标
  const noPremise = recheckVerdict({ ...base, practice: [err(1, 'q1')], reviews: [] })
  assert.equal(noPremise.met, false)
})

test('recheckVerdict·保留率恢复：真实保留率回升 ≥ 阈值达标；样本不足不造假达标', () => {
  const base = {
    metric: '保留率恢复' as const, course: '数学', cutoff: 0,
    entryDay: localDay(0), today: localDay(6), period: 5,
    consumers: ['进阶'], invokesOf: () => null,
  }
  // 前 3 条全失手 → 后 3 条全通过：回升 1.0 → 达标
  const recovered = recheckVerdict({
    ...base,
    practice: [pRec(-3, '入门'), pRec(-2, '入门'), pRec(-1, '入门'), pRec(1, '入门'), pRec(2, '入门'), pRec(3, '入门')],
    reviews: [rRec(-3, '入门', 'a', 1), rRec(-2, '入门', 'b', 1), rRec(-1, '入门', 'c', 1), rRec(1, '入门', 'd', 3), rRec(2, '入门', 'e', 3), rRec(3, '入门', 'f', 3)],
  })
  assert.equal(recovered.met, true)
  // 前后都全通过：无回升 → 不达标
  const flat = recheckVerdict({
    ...base,
    practice: [pRec(-3, '入门'), pRec(-2, '入门'), pRec(-1, '入门'), pRec(1, '入门'), pRec(2, '入门'), pRec(3, '入门')],
    reviews: [rRec(-3, '入门', 'a', 3), rRec(-2, '入门', 'b', 3), rRec(-1, '入门', 'c', 3), rRec(1, '入门', 'd', 3), rRec(2, '入门', 'e', 3), rRec(3, '入门', 'f', 3)],
  })
  assert.equal(flat.met, false)
  // 复诊窗样本不足（2 < 3）→ 不达标（不造假达标）
  const thin = recheckVerdict({
    ...base,
    practice: [pRec(-3, '入门'), pRec(-2, '入门'), pRec(1, '入门'), pRec(2, '入门')],
    reviews: [rRec(-3, '入门', 'a', 1), rRec(-2, '入门', 'b', 1), rRec(1, '入门', 'c', 3), rRec(2, '入门', 'd', 3)],
  })
  assert.equal(thin.met, false)
})

// ---- 纯函数层：三率与韧性闸门 ----

/** 三率场景：窗内生长出材 10 节（插入 4/前进 4/旁支 2），账本登记 4、已决 3。 */
function ratesFixture(passProven: number): ReturnType<typeof growthRates> {
  const days = Array.from({ length: 30 }, (_, i) => localDay(-29 + i))
  const tallies = [
    { operator: '插入', added: 2, day: localDay(-10) },
    { operator: '插入', added: 2, day: localDay(-9) },
    { operator: '前进', added: 2, day: localDay(-8) },
    { operator: '前进', added: 2, day: localDay(-7) },
    { operator: '旁支', added: 2, day: localDay(-6) },
    { operator: '前进', added: 2, day: localDay(-60) }, // 窗外不计
  ]
  const regs = Array.from({ length: 4 }, (_, i) => ({
    entry: { node: `插${i}`, pre: ['入门'], proposal: i + 1, due: 10 } as ProbationEntry,
    day: localDay(-10 + i),
  }))
  const decisions = Array.from({ length: 3 }, (_, i) => ({
    entry: {
      node: `插${i}`, pre: ['入门'], proposal: i + 1, due: 10,
      outcome: (i < passProven ? 'proven' : '剪除') as 'proven' | '剪除',
      decided_at: ts(-5 + i),
    },
    day: localDay(-5 + i),
  }))
  return growthRates(regs, decisions, tallies, days)
}

test('三率：滚动 30 学习日取材（窗外不计）、插入率/剪枝率/复诊通过率分母诚实', () => {
  const rates = ratesFixture(1)
  assert.equal(rates.window_days, 30)
  assert.equal(rates.coach_added, 10, '窗外批次不计入生长分母')
  assert.equal(rates.inserted, 4)
  assert.equal(rates.sidebranch, 2)
  assert.equal(rates.decided, 3)
  assert.equal(rates.proven, 1)
  assert.equal(rates.pruned, 2)
  assert.ok(Math.abs(rates.insert_rate! - 0.4) < 1e-3)
  assert.ok(Math.abs(rates.recheck_pass_rate! - 1 / 3) < 1e-3)
  assert.ok(Math.abs(rates.prune_rate! - 2 / 3) < 1e-3)
})

test('韧性闸门：复诊通过率触底/插入率超限 → 插入批闸停；旁支上限 20%（韧性高放宽 30%）；低数据静默', () => {
  // 通过率 1/3 < 0.5 → 插入闸停（韧性低：旁支 cap 0.2）
  const brittle = ratesFixture(1)
  const insertGate = growthGate(brittle, { operator: '插入', adds: 1 })
  assert.equal(insertGate.resilient, false)
  assert.equal(insertGate.sidebranch_cap, 0.2)
  assert.match(insertGate.blocks.join(''), /复诊通过率/)

  const sideGate = growthGate(brittle, { operator: '旁支', adds: 1 })
  assert.match(sideGate.blocks.join(''), /旁支超限/, '旁支占比 (2+1)/11 > 20% → 拒收')

  // 韧性高（通过率 3/3 ≥ 0.8）：旁支上限放宽 20%→30%，同批量放行
  const resilient = ratesFixture(3)
  const resilientGate = growthGate(resilient, { operator: '旁支', adds: 1 })
  assert.equal(resilientGate.resilient, true)
  assert.equal(resilientGate.sidebranch_cap, 0.3)
  assert.equal(resilientGate.blocks.length, 0, '(2+1)/11=27% ≤ 30% → 放行')

  // 插入率超限与批内 adds 合并计（防贴线连批绕闸）
  const insertHeavy = growthRates(
    Array.from({ length: 6 }, (_, i) => ({
      entry: { node: `插${i}`, pre: [], proposal: i + 1, due: 10 } as ProbationEntry,
      day: localDay(-10),
    })),
    [], [{ operator: '前进', added: 4, day: localDay(-9) }], Array.from({ length: 30 }, (_, i) => localDay(-29 + i)))
  const capped = growthGate(insertHeavy, { operator: '插入', adds: 2 })
  assert.match(capped.blocks.join(''), /插入率超限/, '(6+2)/12=67% > 50% → 拒收')
  // 低数据（窗内无生长）静默：旁支之外恒放行
  assert.deepEqual(growthGate(insertHeavy, { operator: '前进', adds: 5 }).blocks, [])
})

// ---- 门面全链 ----

test('AC1 插入批受理：预注册随提案落字、apply 同事务落账本（条目形状/复诊期 clamp）、apply 结果带登记', async () => {
  await withVault({ graph: TWO_NODE_GRAPH }, async ({ engine, paths }) => {
    // 学习日底座（三率滚动窗的取材域；登记日 = 今天在窗内）
    for (let d = -2; d <= 0; d++) await engine.store.appendPractice(pRec(d, '入门'))
    const prop = await engine.graph.graphPropose('edit', insertionYaml({ days: '100', withConcept: true })) as { id: number; recheck?: unknown }
    assert.ok(((prop as { warns?: string[] }).warns ?? []).some(w => w.includes('clamp')), 'clamp 落受理回执 warn')
    const applied = await engine.graph.graphApply('edit', prop.id) as Record<string, unknown>
    assert.deepEqual(applied.probation_registered, ['过渡'])
    assert.deepEqual(applied.recheck, { metric: '前进恢复', due: 20 }, 'days 100 clamp 到 20')

    const ledger = await readProbationLedger(paths, 'math', nodeVaultFs)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]!.node, '过渡')
    assert.deepEqual(ledger[0]!.pre, ['入门'])
    assert.equal(ledger[0]!.due, 20)
    assert.equal(ledger[0]!.outcome, undefined, '在途 = probation')

    // 落字在提案 artifact（结算按 proposal id 回读 metric）
    const pid = ledger[0]!.proposal
    const artifact = await readFile(paths.proposalArtifactPath(pid, 'edit', '数学'), 'utf8')
    assert.match(artifact, /metric: 前进恢复/)

    // 面板/agent 可见：在途节点（「实验中」取数）与三率面（statusJson 与 probationStatus 同核）
    const status = await engine.growth2.probationStatus('数学')
    assert.deepEqual(status.courses[0]!.in_flight, ['过渡'])
    assert.deepEqual(status.courses[0]!.overdue, [])
    assert.equal(status.courses[0]!.rates.inserted, 1)
    assert.equal(status.courses[0]!.rates.recheck_pass_rate, null, '零已决 = 低数据静默（null 不造假）')
    assert.equal(status.courses[0]!.gate.resilient, null)
    assert.equal(status.courses[0]!.gate.sidebranch_cap, 0.2, '韧性样本不足：旁支 cap 取保守值 20%')
    const statusJson = await engine.statusJson()
    assert.deepEqual(statusJson.courses.find(c => c.name === '数学')!.probation!.in_flight, ['过渡'])
  })
})

test('预注册负路径：插入批缺预注册/非插入批携带/非法 metric 一律拒收，零账本零提案', async () => {
  await withVault({ graph: TWO_NODE_GRAPH }, async ({ engine, paths }) => {
    await assert.rejects(
      () => engine.graph.graphPropose('edit', insertionYaml({ recheck: false })),
      /note\.recheck: 插入批必须预注册复诊/,
      '插入批（有 add_node）必须预注册——零人审结算的判据前提')
    await assert.rejects(
      () => engine.graph.graphPropose('edit', insertionYaml({ operator: '前进' })),
      /复诊预注册只随插入批携带/,
      '前进批没有可登记的插入边')
    await assert.rejects(
      () => engine.graph.graphPropose('edit', insertionYaml({ metric: '疗效验证' })),
      /metric/)
    // 拒收零落盘：无提案、无账本
    assert.equal((await engine.graph.graphProposals()).length, 0)
    assert.deepEqual(await readProbationLedger(paths, 'math', nodeVaultFs), [])
  })
})

test('AC2 行使闸：probation 在途行使只记流不回流（EMA/计数不动）、proven 后恢复；前进节点不受闸', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    banks: { 入门: [tfQuestion('q0')] },
    files: [{ path: '学习中心/math/题库/过渡.yaml', content: ['node: 过渡', 'questions:', ...tfQuestion('q1')].join('\n') + '\n' }],
  }, async ({ engine }) => {
    await applyInsertion(engine, insertionYaml({ metric: '前进恢复', days: '5', withConcept: true }))
    const noLlm = async () => { throw new Error('规则题不该调模型') }

    // 在途：过渡上作答——流水照记、evidence_gated 标记、EMA/计数不动
    const gated = await engine.content2.questionAnswer(noLlm, '数学', '过渡', 'q1', 'true', 30)
    assert.equal(gated.correct, true)
    assert.equal(gated.evidence_gated, true)
    // 前进节点不受闸：同款作答照常回流
    const normal = await engine.content2.questionAnswer(noLlm, '数学', '入门', 'q0', 'true', 30)
    assert.equal(normal.evidence_gated, undefined)

    const practice = await engine.store.practiceAll()
    assert.equal(practice.filter(r => r.node === '过渡').length, 1, '只记流：流水在')
    const fmOf = async (node: string): Promise<string> => {
      const files = { 过渡: '基础/过渡', 入门: '基础/入门' } as Record<string, string>
      return await readFile(`${engine.paths.courseDir('math')}/${files[node]}.md`, 'utf8')
    }
    const gatedFm = await fmOf('过渡')
    assert.match(gatedFm, /attempts: 0/, '不回流：计数不动')
    assert.doesNotMatch(gatedFm, /practice_ema: [1-9]/, '不回流：EMA 不动')
    const normalFm = await fmOf('入门')
    assert.match(normalFm, /attempts: 1/, '前进节点照常回流')
    assert.match(normalFm, /practice_ema: 1/)

    // 复诊窗推进（days 5）+ 下游答对 → proven → 闸 lifts
    for (let d = 1; d <= 5; d++) await engine.store.appendPractice(pRec(d, '入门'))
    await engine.store.appendPractice(pRec(2, '进阶'))
    const settled = await engine.growth2.settleRechecks('数学', { today: localDay(5) })
    const entry = settled.courses[0]!.settled[0]
    assert.equal(entry!.node, '过渡')
    assert.equal(entry!.outcome, 'proven')
    assert.equal(entry!.metric, '前进恢复')

    // proven 后恢复：同款作答照常回流
    const lifted = await engine.content2.questionAnswer(noLlm, '数学', '过渡', 'q1', 'false', 30)
    assert.equal(lifted.evidence_gated, undefined)
    const liftedFm = await fmOf('过渡')
    assert.match(liftedFm, /attempts: 1/)
    assert.match(liftedFm, /practice_ema: 0/, '答错 = 0 分入 EMA')

    // 沉淀正典：recheck_outcome 按概念地址书写（过渡概念 随批铸名）
    const fold = await engine.sched2.sedimentFold()
    assert.equal(fold.counts.recheck_outcome, 1)
    assert.equal(fold.byConcept.recheck_outcome!['过渡概念']!.payload.outcome, 'proven')
  })
})

test('AC1 到期结算·自动剪除：不达标 del_node 归档 + 原粗边恢复（零人审）+ 图修复/复诊结局落沉淀 + journal 留痕', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    banks: { },
  }, async ({ engine, paths, root }) => {
    await applyInsertion(engine, insertionYaml({ metric: '前进恢复', days: '5', withConcept: true }))
    // 复诊期推进（5 学习日），但下游消费节点始终没有答对 → 前进未恢复
    for (let d = 1; d <= 5; d++) await engine.store.appendPractice(pRec(d, '入门'))

    const r = await engine.growth2.settleRechecks('数学', { today: localDay(5) })
    assert.equal(r.courses[0]!.settled[0]!.outcome, '剪除')
    const settlePid = r.courses[0]!.settled[0]!.proposal
    assert.ok(settlePid, '剪除走自动提案（留痕）')

    // 图形态：过渡被删、原粗边恢复（进阶.pre = [入门]；YAML 流式/块式两种序列化都认）
    const data = await readFile(join(paths.courseRoot('math'), 'data', '基础.yaml'), 'utf8')
    assert.doesNotMatch(data, /过渡/, '插入节点已删')
    assert.match(data, /pre: \[入门\]|pre:\s*\n\s+- 入门/, '原粗边恢复')

    // 内容归档：课程笔记移入 state/archive（del-node-<提案id>-过渡.md）
    const archive = await readFile(
      join(paths.courseStateDir('math'), 'archive', `del-${settlePid}-过渡.md`), 'utf8')
    assert.match(archive, /node: 过渡/)

    // 账本：outcome 行追加（只增）→ 剪除收口
    const ledger = await readProbationLedger(paths, 'math', nodeVaultFs)
    assert.equal(ledger.length, 2)
    assert.equal(ledger[1]!.outcome, '剪除')
    assert.ok(ledger[1]!.decided_at)

    // 沉淀正典：recheck_outcome（无 teaches = 单条无概念地址）+ graph_repair
    const canon = await readSedimentCanon(paths, nodeVaultFs)
    const recheck = canon.filter(e => e.kind === 'recheck_outcome')
    assert.equal(recheck.length, 1)
    assert.equal(recheck[0]!.payload.outcome, '剪除')
    const repair = canon.filter(e => e.kind === 'graph_repair')
    assert.equal(repair.length, 1)
    assert.equal((repair[0]!.payload as Record<string, unknown>).action, 'recheck_prune')
    assert.deepEqual((repair[0]!.payload as Record<string, unknown>).concepts, ['过渡概念'])

    // journal + 剪除提案留痕（机器裁决也要可追问）
    const journal = await readFile(paths.journalPath, 'utf8')
    assert.match(journal, /probation_settle/)
    assert.match(journal, new RegExp(`"session":"${ledger[0]!.proposal}"`))
    const appliedProps = await engine.graph.graphProposals('applied', 'edit')
    assert.ok(appliedProps.some(p => p.id === settlePid && (p.decision_note ?? '').includes('快照')))

    // 幂等：再次结算无在途可决
    const again = await engine.growth2.settleRechecks('数学', { today: localDay(6) })
    assert.equal(again.courses[0]!.settled.length, 0)
    void root
  })
})

test('AC4 data-check 到期未决：hint 提示类（不进 status）+ inventory 盘点；未到期不提示', async () => {
  await withVault({
    graph: TWO_NODE_GRAPH,
    notes: { 入门: {}, 进阶: {} },
    banks: { 入门: [tfQuestion('q0')], 进阶: [tfQuestion('q9')] },
    files: [{ path: '学习中心/math/题库/过渡.yaml', content: ['node: 过渡', 'questions:', ...tfQuestion('q8')].join('\n') + '\n' }],
  }, async ({ engine }) => {
    await applyInsertion(engine, insertionYaml({ metric: '前进恢复', days: '5' }))
    // 登记日挪到 6 学习日前 + 复诊窗推满（未结算）→ 该决未决
    const proposals = await engine.store.loadProposals()
    await engine.store.saveProposals(proposals.map(p =>
      p.kind === 'edit' ? { ...p, decided: ts(-6) } : p))
    for (let d = 5; d >= 1; d--) await engine.store.appendPractice(pRec(-d, '入门'))

    const report = await engine.dataCheck()
    assert.equal(report.counts.hint, 1)
    assert.equal(report.status, 'ok', 'hint 是提示类：不进 status')
    assert.equal(report.inventory.probationLedgers.present, 1)
    assert.equal(report.inventory.probationLedgers.overdue, 1)
    const hint = report.findings.find(f => f.reason === 'probation_overdue')!
    assert.match(hint.location, /边实验账本/)
    assert.match(hint.location, /过渡/)
    assert.equal(hint.level, 'hint')

    // 对照：复诊窗未推满则不提示
    await withVault({
      graph: TWO_NODE_GRAPH,
      notes: { 入门: {}, 进阶: {} },
      banks: { 入门: [tfQuestion('q0')], 进阶: [tfQuestion('q9')] },
    }, async ({ engine: e2 }) => {
      await applyInsertion(e2, insertionYaml({ metric: '前进恢复', days: '5' }))
      const report2 = await e2.dataCheck()
      assert.equal(report2.counts.hint, 0, '未到期未决不算 hint（登记日=今天，复诊期未满）')
    })
  })
})

test('AC3 调速闸门按 params 生效：复诊通过率触底/插入率超限时插入批被受理门拒收，前进/旁支照常', async () => {  await withVault({ graph: TWO_NODE_GRAPH }, async ({ engine, paths }) => {
    // 学习日底座（窗内取材）
    for (let d = -10; d <= 0; d++) await engine.store.appendPractice(pRec(d, '入门'))
    // 真实插入批 1：登记 1 节
    await applyInsertion(engine, insertionYaml({ metric: '前进恢复', days: '5' }))
    // 手工补 3 个已决复诊 + 3 个生长批出材（2 节插入 ×3），decided 在窗内：
    // coach_added = 1+6 = 7、inserted = 4、decided = 3（1 proven 2 剪除 → 通过率 1/3）
    for (let i = 0; i < 3; i++) {
      const pid = await engine.store.createProposal('edit', '数学', `生长批（插入）：场景批 ${i}`, '')
      await writeFile(paths.proposalArtifactPath(pid, 'edit', '数学'),
        ['course: 数学', 'note:', '  operator: 插入', `  reason: 场景批 ${i}`, '  recheck:', '    metric: 前进恢复', 'ops:',
          '  - op: add_node', `    name: 场景节点${i}甲`, '    region: 基础', '    block: 入门块', '    pre: [入门]',
          '  - op: add_node', `    name: 场景节点${i}乙`, '    region: 基础', '    block: 入门块', '    pre: [入门]'].join('\n') + '\n', 'utf8')
      await engine.store.updateProposal(pid, { status: 'applied', decided: ts(-8 + i) })
      await appendProbationEntry(paths, 'math', { node: `场景${i}`, pre: ['入门'], proposal: pid, due: 5 }, nodeVaultFs)
      await appendProbationEntry(paths, 'math', {
        node: `场景${i}`, pre: ['入门'], proposal: pid, due: 5,
        outcome: i === 0 ? 'proven' : '剪除', decided_at: ts(-4 + i),
      }, nodeVaultFs)
    }
    // 调速现势：通过率 1/3 < 0.5、插入率 4/7 > 0.5 → 插入批闸停；旁支 1 节（1/8=12.5%）放行
    const view = await engine.growth2.probationStatus('数学')
    assert.equal(view.courses[0]!.gate.insert_blocked, true)
    assert.match(view.courses[0]!.gate.insert_blocks.join(''), /复诊通过率/)

    await assert.rejects(
      () => engine.graph.graphPropose('edit', [
        'course: 数学', 'note:', '  operator: 插入', '  reason: 再插一节', '  recheck:', '    metric: 前进恢复', '    days: 5', 'ops:',
        '  - op: add_node', '    name: 过渡二号', '    region: 基础', '    block: 入门块', '    pre: [入门]',
      ].join('\n') + '\n'),
      /生长闸门拒绝受理[\s\S]*复诊通过率/,
      '超速插入批在受理门就被拒收（构造超限场景验证调速）')
    // 前进批不受闸（route 不携带——未播种课程没有罗盘重写通道，与本票无关）
    const fwd = await engine.graph.graphPropose('edit', [
      'course: 数学', 'note:', '  operator: 前进', '  reason: 主线推进', 'ops:',
      '  - op: add_node', '    name: 前进节点', '    region: 基础', '    block: 入门块', '    pre: [入门]',
    ].join('\n') + '\n') as { id: number }
    assert.ok(fwd.id > 0)
    await engine.graph.graphReject(fwd.id)
    // 旁支 1 节：占比 1/8 = 12.5% ≤ 20% → 放行
    const side = await engine.graph.graphPropose('edit', [
      'course: 数学', 'note:', '  operator: 旁支', '  reason: 教学消费支线', 'ops:',
      '  - op: add_node', '    name: 旁支节点', '    region: 基础', '    block: 入门块', '    pre: [入门]',
    ].join('\n') + '\n') as { id: number }
    assert.ok(side.id > 0)
    await engine.graph.graphReject(side.id)
  })
})

test('结算只遍历折叠后的在途条目：已决 (proposal,node) 的裁决前行不被复读重裁（proven 不翻案）', async () => {
  await withVault({ graph: TWO_NODE_GRAPH }, async ({ engine, paths }) => {
    // 插入 A（过渡，前进恢复 days 5）：复诊窗推进 + 下游答对 → proven
    await applyInsertion(engine, insertionYaml({ metric: '前进恢复', days: '5', withConcept: true }))
    for (let d = 1; d <= 5; d++) await engine.store.appendPractice(pRec(d, '入门'))
    await engine.store.appendPractice(pRec(2, '进阶'))
    const first = await engine.growth2.settleRechecks('数学', { today: localDay(5) })
    assert.equal(first.courses[0]!.settled[0]!.outcome, 'proven')

    // 插入 B（过渡乙，卡点集中度降幅 days 5）：窗内错误持平 → 不达标剪除；
    // B 的 set_pre 把进阶前置从 过渡 换成 过渡乙（A 的插入边转由 过渡乙 承接）
    await applyInsertion(engine, insertionYaml({
      metric: '卡点集中度降幅', days: '5', name: '过渡乙', pre: '过渡',
    }))
    const err = (d: number): PracticeRec => pRec(d, '入门', { qid: 'qE', correct: false })
    await engine.store.appendPractice(err(1))
    await engine.store.appendPractice(err(2))
    const second = await engine.growth2.settleRechecks('数学', { today: localDay(5) })
    assert.deepEqual(second.courses[0]!.settled.map(s => [s.node, s.outcome]), [['过渡乙', '剪除']],
      '第二次结算只裁决 B——A 已决，不得复读重裁')

    // A 的 proven 不翻案：过渡仍在图、账本恰 2 行（登记 + 一条 proven），无重复结局
    const data = await readFile(join(paths.courseRoot('math'), 'data', '基础.yaml'), 'utf8')
    assert.match(data, /过渡\n|过渡 /, 'A 节点仍在图（未翻案剪除）')
    const ledger = await readProbationLedger(paths, 'math', nodeVaultFs)
    const byProposal = new Map<number, number>()
    for (const e of ledger) byProposal.set(e.proposal, (byProposal.get(e.proposal) ?? 0) + 1)
    assert.equal(byProposal.get(ledger[0]!.proposal), 2, 'A 恰登记+裁决各一行')
    const provenLines = ledger.filter(e => e.outcome === 'proven')
    assert.equal(provenLines.length, 1, 'proven 恰一条（无重复结算刷正典）')
    const fold = await engine.sched2.sedimentFold()
    assert.equal(fold.counts.recheck_outcome, 2, '沉淀恰 A+B 两条复诊结局')
  })
})
