/**
 * 统一 agent 缝（#162 / ADR-0041 双模式 / ADR-0044 归属）单测：
 * - 单发模式：剥围栏归位（原投递层适配器行为）、语义档原样贯通、调用日志按站归组
 *   且注入侧可观测（station/mode/effort/callNo/字数）。
 * - 门错修复轮（共享能力）：首过零修复、拒收恰回灌重裁一轮（门错误+被拒原文）、
 *   仍败以 fatal 抛两轮死因、修复轮自身失败同葬、门内程序性抛错原样冒泡；
 *   受理式门（propose/写盘）的产物经 GateVerdict.result 随行交还。
 * - 工具回路模式：白名单工具执行与结果回灌、runTool 失败以 isError 回灌、
 *   K≤20 轮预算封顶 fail loud（不可被调用方抬高）、LlmStream 缺位 fail loud。
 */
import { memLogger } from './helpers/logger.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentSeam, AGENT_LOOP_MAX_TOOL_ROUNDS, AGENT_LOOP_REPEAT_LIMIT, stripFences } from '../src/engine/infra/agent.ts'
import { systemClock } from '../src/host/clock.ts'
import type { AgentCallRecord, GateVerdict } from '../src/engine/infra/agent.ts'
import type { LlmComplete, LlmEffort, LlmLoopTurn, LlmStream, LlmToolSpec } from '../src/engine/infra/llm.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 事故语料回放序列（#309 缺陷④）：2026-09-17 实机逐轮的「工具名 + 结果原文 + 成/败」。
 * 提取规则与出处见 fixture 的 `_source`。 */
function incidentSeq(): Array<{ calls: string[]; failed: boolean; result: string }> {
  return (JSON.parse(readFileSync(join(HERE, 'fixtures', 'agent-loop-incident-2026-09-17.json'), 'utf8')) as {
    turns: Array<{ calls: string[]; failed: boolean; result: string }>
  }).turns
}

/** 脚本化补全端口：按调用序回放，记录 prompt/system/语义档。 */
function fakeComplete(replies: string[]) {
  const calls: Array<{ prompt: string; system?: string; effort?: LlmEffort }> = []
  const fn: LlmComplete = async (prompt, system, opts) => {
    calls.push({ prompt, system, effort: opts?.effort })
    if (!replies.length) throw new Error('脚本化补全端口：应答已耗尽')
    return replies.shift()!
  }
  return Object.assign(fn, { calls })
}

/** 观测面收集器（注入侧可观测的测试形态）。 */
function collector(): { records: AgentCallRecord[]; onCall: (r: AgentCallRecord) => void } {
  const records: AgentCallRecord[] = []
  return { records, onCall: r => records.push(r) }
}

/** 脚本化回路端口：按调用序回放助手轮（文本+工具调用），记录整段回路历史。 */
function fakeStream(script: Array<{ text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>) {
  const requests: Array<{ messages: LlmLoopTurn[]; tools?: LlmToolSpec[]; effort?: LlmEffort }> = []
  const fn: LlmStream = async req => {
    requests.push({ messages: req.messages, tools: req.tools, effort: req.effort })
    if (!script.length) throw new Error('脚本化回路端口：应答已耗尽')
    const next = script.shift()!
    return { text: next.text, toolCalls: next.toolCalls ?? [] }
  }
  return Object.assign(fn, { requests })
}

test('stripFences：整段围栏剥壳（数据类标签），正文类标签与普通文本原样', () => {
  assert.equal(stripFences('```markdown\n# 路线\n```\n'), '# 路线')
  assert.equal(stripFences('```yaml\na: 1\n```'), 'a: 1')
  assert.equal(stripFences('course: 数学\nops: []'), 'course: 数学\nops: []')
  // 正文类标签是内容的一部分：不剥
  assert.equal(stripFences('```svg\n<svg/>\n```'), '```svg\n<svg/>\n```')
})

test('单发模式：剥围栏内建、语义档贯通端口、调用日志按站归组且注入侧可观测', async () => {
  const port = fakeComplete(['```yaml\nok: 1\n```', '直接文本'])
  const obs = collector()
  const agent = new AgentSeam({ logger: memLogger(), complete: port, onCall: obs.onCall }, systemClock)

  const first = await agent.complete('罗盘', '画罗盘', { effort: 'deep' })
  assert.equal(first, 'ok: 1', '整段围栏在缝里剥掉（站点拿到的已是净文本）')
  const second = await agent.complete('罗盘', '重画')
  assert.equal(second, '直接文本')

  assert.deepEqual(port.calls.map(c => c.effort), ['deep', undefined], '语义档原样贯通（不传 = 部署默认）')
  assert.deepEqual(port.calls.map(c => c.system), [undefined, undefined])
  // 调用日志：站/模式/档/序号/字数齐备，序号按站+模式递增
  assert.equal(obs.records.length, 2)
  assert.equal(obs.records[0]!.station, '罗盘')
  assert.equal(obs.records[0]!.mode, 'complete')
  assert.equal(obs.records[0]!.effort, 'deep')
  assert.equal(obs.records[0]!.callNo, 1)
  assert.equal(obs.records[1]!.callNo, 2)
  assert.equal(obs.records[0]!.promptChars, '画罗盘'.length)
  // replyChars 是传输层口径（端口原样应答，含围栏）
  assert.equal(obs.records[0]!.replyChars, '```yaml\nok: 1\n```'.length)
  assert.ok(obs.records[0]!.durationMs >= 0)
})

test('repair：与 complete 同一传输，观测面单独标 repair 模式', async () => {
  const port = fakeComplete(['修好了'])
  const obs = collector()
  const agent = new AgentSeam({ logger: memLogger(), complete: port, onCall: obs.onCall }, systemClock)
  const out = await agent.repair('教练生长', '回灌重裁', { effort: 'deep' })
  assert.equal(out, '修好了')
  assert.equal(port.calls[0]!.effort, 'deep')
  assert.equal(obs.records[0]!.mode, 'repair')
})

test('门错修复轮：首过零修复；拒收恰回灌重裁一轮（门错误+被拒原文）；受理产物随行', async () => {
  // 首过：repair 不被调用，受理产物经 result 交还
  const portOk = fakeComplete(['好产出'])
  const agentOk = new AgentSeam({ logger: memLogger(), complete: portOk }, systemClock)
  const ok = await agentOk.gateRepairRound<string, { spec: number }>('种子起草', {
    first: () => agentOk.complete('种子起草', '包'),
    gate: raw => (raw === '好产出' ? { errors: [], result: { spec: 1 } } : { errors: ['格式错'] }),
    repair: () => { throw new Error('修复轮不该被调用') },
    fatal: () => new Error('不该 fatal'),
  })
  assert.equal(ok.candidate, '好产出')
  assert.equal(ok.result.spec, 1, '受理式门过门产物随行')
  assert.equal(ok.repaired, false)
  assert.equal(portOk.calls.length, 1)

  // 拒收 → 恰一轮回灌重裁 → 过
  const port = fakeComplete(['坏产出', '好产出'])
  const log = memLogger()
  const agent = new AgentSeam({ logger: log, complete: port }, systemClock)
  const repaired = await agent.gateRepairRound<string, { spec: number }>('种子起草', {
    first: () => agent.complete('种子起草', '包'),
    gate: raw => (raw === '好产出' ? { errors: [], result: { spec: 2 } } : { errors: ['格式错', '缺字段'] }),
    repair: (gateErrors, rejected) => {
      assert.deepEqual(gateErrors, ['格式错', '缺字段'], '门错误原文原样回灌')
      assert.equal(rejected, '坏产出', '被拒候选原文随行')
      return agent.repair('种子起草', `修复提示词 ${gateErrors.join('；')} ${rejected}`, { effort: 'deep' })
    },
    fatal: () => new Error('不该 fatal'),
  })
  assert.equal(repaired.candidate, '好产出')
  assert.equal(repaired.result.spec, 2, '重裁产出重进受理门，产物取重裁那一轮')
  assert.equal(repaired.repaired, true)
  assert.equal(port.calls.length, 2, '恰一次修复轮（首轮 + 重裁共 2 次补全）')
  // #253 / ADR-0080：门错修复轮的四条事件——「首轮被拒 → 跑过重裁 → 过门」
  assert.deepEqual(log.events(), ['agent.gate.first', 'agent.gate.repair'])
  assert.equal(log.nth('agent.gate.first')!.fields.verdict, 'reject')
  assert.equal(log.nth('agent.gate.first')!.fields.station, '种子起草', '站点参数沿缝贯通')
  assert.equal(log.nth('agent.gate.repair')!.fields.attempt, 1, '恰一轮：attempt 恒 1')

  // 仍败：fatal 拿到两轮死因
  const port2 = fakeComplete(['坏产出', '还是坏'])
  const log2 = memLogger()
  const agent2 = new AgentSeam({ logger: log2, complete: port2 }, systemClock)
  await assert.rejects(
    () => agent2.gateRepairRound<string, void>('种子起草', {
      first: () => agent2.complete('种子起草', '包'),
      gate: (raw): GateVerdict<void> => (raw === '好产出' ? { errors: [] } : { errors: [`门拒绝：${raw}`] }),
      repair: (gateErrors, rejected) => agent2.repair('种子起草', `${gateErrors.join()}|${rejected}`, { effort: 'deep' }),
      fatal: (first, repair) => new Error(`死因【首轮】${first.join('；')}【重裁】${repair.join('；')}`),
    }),
    /死因【首轮】门拒绝：坏产出【重裁】门拒绝：还是坏/,
  )
  assert.equal(port2.calls.length, 2, '恰两轮调用，不无限重试')
  // #253 / ADR-0080 验收判据 2：两轮死因在 `agent.gate.death` 里**全文可读**（续行）
  assert.deepEqual(log2.events(), ['agent.gate.first', 'agent.gate.repair', 'agent.gate.repair.reject', 'agent.gate.death'])
  assert.equal(log2.nth('agent.gate.repair.reject')!.fields.errors, 1)
  const death = log2.nth('agent.gate.death')!
  assert.equal(death.level, 'error')
  assert.equal(death.fields.first_errors, 1)
  assert.equal(death.fields.repair_errors, 1)
  assert.deepEqual(death.fields.detail, ['门拒绝：坏产出', '门拒绝：还是坏'], '两轮死因原文都在（不是只给计数）')
  // 首轮就过门：`agent.gate.repair` 缺席 = 「没跑重试」的一眼判据
  const log3 = memLogger()
  const agentOk2 = new AgentSeam({ logger: log3, complete: fakeComplete(['好产出']) }, systemClock)
  await agentOk2.gateRepairRound<string, void>('种子起草', {
    first: () => agentOk2.complete('种子起草', '包'),
    gate: () => ({ errors: [] }),
    repair: () => { throw new Error('不该被调用') },
    fatal: () => new Error('不该 fatal'),
  })
  assert.deepEqual(log3.events(), ['agent.gate.first'], '首过：只记 first，repair 缺席')
  assert.equal(log3.nth('agent.gate.first')!.fields.verdict, 'pass')
})

test('门错修复轮：修复轮自身失败（模型/解析抛错）同葬进 fatal；门内程序性抛错原样冒泡', async () => {
  const port = fakeComplete(['坏产出', '修复轮产出'])
  const agent = new AgentSeam({ logger: memLogger(), complete: port }, systemClock)
  await assert.rejects(
    () => agent.gateRepairRound<string, void>('目标反编译', {
      first: () => agent.complete('目标反编译', '包'),
      gate: () => ({ errors: ['未过双产物校验门'] }),
      repair: () => agent.repair('目标反编译', '修复轮模型炸了', { effort: 'deep' }).then(() => { throw new Error('模型调用失败[RATE_LIMIT]') }),
      fatal: (first, death) => new Error(`两轮死因：${first.join()} / ${death.join()}`),
    }),
    /两轮死因：.*模型调用失败\[RATE_LIMIT\]/,
  )

  // 门内抛错 = 程序性失败（非门拒绝）：原样冒泡、不进修复轮
  const agent3 = new AgentSeam({ logger: memLogger(), complete: fakeComplete(['x']) }, systemClock)
  await assert.rejects(
    () => agent3.gateRepairRound<string, void>('目标反编译', {
      first: () => agent3.complete('目标反编译', '包'),
      gate: () => { throw new Error('YAML 语法错误') },
      repair: () => { throw new Error('不该被调用') },
      fatal: () => new Error('不该 fatal'),
    }),
    /YAML 语法错误/,
  )
})

test('工具回路：白名单工具执行回灌继续、最终文本剥围栏、轨迹与轮次可观测', async () => {
  const stream = fakeStream([
    { text: '我先查一下图面。', toolCalls: [{ id: 'c1', name: 'graph_view', arguments: '{"course":"数学"}' }] },
    { text: '```yaml\nverdict: 1\n```' },
  ])
  const obs = collector()
  const agent = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream, onCall: obs.onCall }, systemClock)
  const tools: LlmToolSpec[] = [{ name: 'graph_view', description: '图面', parameters: { type: 'object' } }]
  const toolInputs: string[] = []
  const r = await agent.agentLoop({
    station: '教练生长', prompt: '裁决下一步', effort: 'deep', tools,
    runTool: async call => {
      toolInputs.push(`${call.name}:${call.id}`)
      return '图面内容'
    },
  })
  assert.equal(r.text, 'verdict: 1', '最终文本在缝里剥围栏')
  assert.equal(r.toolRounds, 1)
  assert.deepEqual(toolInputs, ['graph_view:c1'])
  assert.equal(r.trajectory.length, 1)
  assert.match(r.trajectory[0]!, /graph_view/)

  // 回路历史：user → assistant(带工具调用) → tool 结果 → 第二轮
  assert.equal(stream.requests.length, 2)
  const history = stream.requests[1]!.messages
  assert.deepEqual(history.map(t => t.role), ['user', 'assistant', 'tool'])
  assert.deepEqual((history[1] as { toolCalls?: unknown }).toolCalls?.[0], { id: 'c1', name: 'graph_view', arguments: '{"course":"数学"}' })
  assert.equal((history[2] as { text: string }).text, '图面内容')
  assert.equal(stream.requests[0]!.tools?.length, 1, '工具白名单随请求')
  assert.equal(stream.requests[0]!.effort, 'deep')
  // 回路轮观测：mode=loop、序号递增
  assert.ok(obs.records.every(x => x.mode === 'loop' && x.station === '教练生长'))
  assert.deepEqual(obs.records.map(x => x.callNo), [1, 2])
})

test('工具回路：runTool 失败以 isError 回灌（模型可见），K≤20 预算封顶 fail loud；stream 缺位 fail loud', async () => {
  // runTool 抛错 → 工具轮 isError
  const errStream = fakeStream([
    { text: '查', toolCalls: [{ id: 'e1', name: 'bank_view', arguments: '{}' }] },
    { text: '好' },
  ])
  const agent = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: errStream }, systemClock)
  await agent.agentLoop({
    station: '教练生长', prompt: 'p', tools: [],
    runTool: async () => { throw new Error('白名单外工具') },
  })
  const toolTurn = errStream.requests[1]!.messages[2] as { role: string; text: string; isError?: boolean }
  assert.equal(toolTurn.isError, true)
  assert.match(toolTurn.text, /白名单外工具/)

  // 预算：K≤20 不可抬高——20 轮工具后第 21 轮仍请求工具 → fail loud（不无限回路）
  // 工具结果逐轮在变（否则先撞同错误熔断——#302 ③ 的防线在 K 顶之前，两者各测各的）
  const endless = fakeStream(Array.from({ length: 23 }, (_, i) => ({
    text: `第${i}轮`, toolCalls: [{ id: `c${i}`, name: 'graph_view', arguments: '{}' }],
  })))
  const agent2 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: endless }, systemClock)
  let spin = 0
  await assert.rejects(
    () => agent2.agentLoop({
      station: '教练生长', prompt: 'p', tools: [],
      runTool: async () => `图面第 ${++spin} 版（逐轮在变）`,
    }),
    /工具回路预算耗尽（K≤20 轮后仍在请求工具）/,
  )
  assert.equal(endless.requests.length, 21, '第 K+1 轮发现仍在请求工具即中止')

  // LlmStream 端口缺位：fail loud 指向适配器缺位
  const agent3 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]) }, systemClock)
  await assert.rejects(
    () => agent3.agentLoop({ station: '罗盘', prompt: 'p', tools: [], runTool: async () => 'x' }),
    /LlmStream 端口/,
  )
  assert.equal(AGENT_LOOP_MAX_TOOL_ROUNDS, 20, 'ADR-0077 回路预算 K≤20（上调自 ADR-0041 的 6）')
})

test('工具回路：任务取消传导（#163）——旗标翻真即中止，后续轮与工具执行不再发生', async () => {
  // 旗标在首轮工具执行后翻真：第二轮底层调用不发生，抛错带取消语义（结果丢弃）
  let cancelled = false
  const stream = fakeStream([
    { text: '查一下', toolCalls: [{ id: 'c1', name: 'graph_view', arguments: '{}' }] },
    { text: '不该到达的终裁' },
  ])
  const agent = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream }, systemClock)
  const toolCalls: string[] = []
  await assert.rejects(
    () => agent.agentLoop({
      station: '教练生长', prompt: '裁决', tools: [],
      runTool: async call => {
        toolCalls.push(call.name)
        cancelled = true // 工具执行期间任务被取消（生成页取消旗标沿站点传入）
        return '图面'
      },
      isCancelled: () => cancelled,
    }),
    /任务已取消——工具回路中止/,
  )
  assert.deepEqual(toolCalls, ['graph_view'], '取消前的工具执行照常完成（结果随后丢弃）')
  assert.equal(stream.requests.length, 1, '旗标翻真后不再发生后续底层调用')

  // 首轮调用前即取消：零底层调用零工具执行
  const stream2 = fakeStream([{ text: 'x' }])
  const agent2 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: stream2 }, systemClock)
  await assert.rejects(
    () => agent2.agentLoop({ station: '罗盘', prompt: 'p', tools: [], runTool: async () => 'y', isCancelled: () => true }),
    /任务已取消/,
  )
  assert.equal(stream2.requests.length, 0, '开局即取消：回路一次底层调用都不发生')

  // 未取消：isCancelled 缺省语义不变（回路跑完）
  const stream3 = fakeStream([{ text: '终裁' }])
  const agent3 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: stream3 }, systemClock)
  const ok = await agent3.agentLoop({ station: '罗盘', prompt: 'p', tools: [], runTool: async () => 'y' })
  assert.equal(ok.text, '终裁')
})

test('#213 token 计量回程：端口 opts.usageSink 回调的 usage 进 AgentCallRecord（缺省缺席）', async () => {
  const obs = collector()
  // 假端口手动回填 usage（真实链路里适配器从 provider usage chunk 投影后回调）
  const sinkFake: LlmComplete = async (_prompt, _system, opts) => {
    opts?.usageSink?.({ inputTokens: 120, outputTokens: 45, reasoningTokens: 30 })
    return '回复'
  }
  const agent = new AgentSeam({ logger: memLogger(), complete: sinkFake, onCall: obs.onCall }, systemClock)
  await agent.complete('种子起草', 'p')
  assert.equal(obs.records.length, 1)
  assert.deepEqual(obs.records[0].usage, { inputTokens: 120, outputTokens: 45, reasoningTokens: 30 })
  // 站/形态沿端口 opts 下行（语料捕获贯通，#213）
  const seen: Array<{ station?: string; kind?: string }> = []
  const spy: LlmComplete = async (_p, _s, opts) => {
    seen.push({ station: opts?.station, kind: opts?.kind })
    return 'r'
  }
  const agent2 = new AgentSeam({ logger: memLogger(), complete: spy }, systemClock)
  await agent2.repair('教练生长', '回灌')
  assert.deepEqual(seen, [{ station: '教练生长', kind: 'repair' }])
  // 端口不回 usage：AgentCallRecord.usage 缺席（路由未上报的合法态）
  const agent3 = new AgentSeam({ logger: memLogger(), complete: fakeComplete(['x']), onCall: obs.onCall }, systemClock)
  await agent3.complete('罗盘', 'p')
  assert.equal(obs.records[1].usage, undefined)
})

test('#302 ③ 同错误熔断：同一工具连续 3 次逐字相同即熔断（死因注明「同错误重复」），K 顶与取消照旧', async () => {
  // 事故形态（ADR-0041 §修订补记）：draft_finish 连抛同一异常——第 3 次即止血，不等 K≤20
  const script = Array.from({ length: 6 }, (_, i) => ({
    text: `第${i + 1}轮：再试一次`, toolCalls: [{ id: `f${i}`, name: 'draft_finish', arguments: '{}' }],
  }))
  const stream = fakeStream(script)
  const log = memLogger()
  const agent = new AgentSeam({ logger: log, complete: fakeComplete([]), stream }, systemClock)
  let toolRuns = 0
  await assert.rejects(
    () => agent.agentLoop({
      station: '执行官草稿', prompt: '发布', tools: [],
      runTool: async () => { toolRuns++; throw new Error('[draft_finish] 门复验未过：ops[0].pre 引用不存在的节点') },
    }),
    /工具回路熔断：draft_finish 连续 3 次返回逐字相同的结果.*死因：同错误重复/,
  )
  assert.equal(stream.requests.length, 3, '第 3 次相同结果即熔断——第 4 轮底层调用不发生')
  assert.equal(toolRuns, 3, '工具执行恰 3 次（省下的轮次就是省下的 token）')
  // 每条失败都有事件（#302 ②）：站/工具/字符数/错误摘要首行
  assert.equal(log.count('agent.tool.fail'), 3)
  const fail = log.nth('agent.tool.fail')!
  assert.equal(fail.level, 'warn')
  assert.equal(fail.fields.station, '执行官草稿')
  assert.equal(fail.fields.tool, 'draft_finish')
  assert.equal(typeof fail.fields.chars, 'number')
  assert.match(String(fail.fields.error), /^\[draft_finish\] 门复验未过/)

  // 错误行逐轮在变（不是同一条行反复在场）不误杀：模型一路改到过门——ADR-0041 §修订补记的
  // 原始判据形状（渐进修复的每一轮报的是**不同**的行，故行计数恒为 1）
  const fixing = fakeStream([
    ...Array.from({ length: 5 }, (_, i) => ({
      text: `第${i + 1}轮`, toolCalls: [{ id: `r${i}`, name: 'draft_finish', arguments: '{}' }],
    })),
    { text: '```yaml\nok: 1\n```' },
  ])
  const agent2 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: fixing }, systemClock)
  let left = 6
  const ok = await agent2.agentLoop({
    station: '执行官草稿', prompt: '发布', tools: [],
    runTool: async () => { throw new Error(`门错误清单剩 ${--left} 条（逐轮在缩短）`) },
  })
  assert.equal(ok.text, 'ok: 1', '逐轮变化的错误不误杀——修复链走完由模型收束')
  assert.equal(fixing.requests.length, 6)

  // 同工具但结果不同（读写交替的自然节奏）不计数：A/B 交替 8 轮也不熔断
  const alternating = fakeStream([
    ...Array.from({ length: 8 }, (_, i) => ({
      text: `第${i + 1}轮`, toolCalls: [{ id: `a${i}`, name: i % 2 ? 'draft_audit' : 'draft_patch', arguments: '{}' }],
    })),
    { text: '收束' },
  ])
  const agent3 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: alternating }, systemClock)
  const mixed = await agent3.agentLoop({
    station: '执行官草稿', prompt: 'p', tools: [],
    runTool: async call => (call.name === 'draft_audit' ? '审计：通过' : '已入草稿'),
  })
  assert.equal(mixed.text, '收束')
  assert.equal(AGENT_LOOP_REPEAT_LIMIT, 3, 'ADR-0041 §修订补记：同错误熔断阈值 = 连续 3 次')
})

test('#309 ④ 熔断口径②：patch/finish 交替、拒绝文案逐字相同也熔断（成功发布即清零不误杀）', async () => {
  // 事故形态（2026-09-17 数学基础二次事故）：patch 成功 → finish 被同一批错误行拒绝，
  // 交替反复。口径① 的「连续逐字相同」被中间的成功 patch 打断，熔断 0 次触发 → 撞 K 顶。
  const script = Array.from({ length: 12 }, (_, i) => ({
    text: `第${i + 1}轮`,
    toolCalls: [{ id: `c${i}`, name: i % 2 ? 'draft_finish' : 'draft_patch', arguments: '{}' }],
  }))
  const reject = [
    '[draft_finish] 受理门拒收（零落盘，草稿保留）：',
    '  ✗ ops.0: teaches 档位非法 "初识"（允许 知道/会用/能教）',
    '  ✗ ops.1: teaches 档位非法 "初识"（允许 知道/会用/能教）',
  ].join('\n')
  const stream = fakeStream(script)
  const agent = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream }, systemClock)
  let runs = 0
  await assert.rejects(
    () => agent.agentLoop({
      station: '教练执行', prompt: '发布', tools: [],
      runTool: async call => {
        runs++
        if (call.name === 'draft_patch') return `已入草稿：本补丁 ${runs} 条` // 每轮都不同且成功
        throw new Error(reject)
      },
    }),
    /工具回路熔断：draft_finish 的同一结果行在本次会话内累计出现 3 次.*死因：同错误重复/,
  )
  assert.equal(runs, 6, '第 3 次 finish 被拒即熔断（patch/finish 各走 3 次即止）')

  // 中间夹别的错误行不打断本行的账（事故里第三次 finish 拒绝是门复验的 set_pre 覆盖错误，
  // 与前后两次 schema 拒绝不同——它不该把 schema 行的计数清掉）
  const interleaved = fakeStream([
    ...Array.from({ length: 10 }, (_, i) => ({ text: `第${i + 1}轮`, toolCalls: [{ id: `i${i}`, name: 'draft_finish', arguments: '{}' }] })),
    { text: '收束' },
  ])
  const agent1b = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: interleaved }, systemClock)
  let nth = 0
  await assert.rejects(
    () => agent1b.agentLoop({
      station: '教练执行', prompt: '发布', tools: [],
      runTool: async () => {
        nth++
        // 第 2 次换成完全不同的一批错误行（事故里的「另一类拒绝」）；第 1/3/4 次都带那条
        // 逐字相同的行 → 它在第 4 次累计到 3（中间那一次不含它，照样累计）
        throw new Error(nth === 2
          ? '  ✗ 另一类错误（门复验：未覆盖批内新前沿）\n  ✗ 附注：第 2 次'
          : `  ✗ 同一批错误行（逐字相同）\n  ✗ 附注：第 ${nth} 次`)
      },
    }),
    /同一结果行在本次会话内累计出现 3 次/,
  )

  // 错误行逐轮在变（同一条行不反复在场）不误杀：模型一路改到过门
  const shrinking = fakeStream([
    ...Array.from({ length: 4 }, (_, i) => ({ text: `第${i + 1}轮`, toolCalls: [{ id: `s${i}`, name: 'draft_finish', arguments: '{}' }] })),
    { text: '收束' },
  ])
  const agent2 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: shrinking }, systemClock)
  let left = 4
  const fixed = await agent2.agentLoop({
    station: '教练执行', prompt: '发布', tools: [],
    runTool: async () => {
      // 报的是「还剩 N 条」这一轮**新**的行——指纹逐轮不同，故不累计（行口径按逐字相同的行判）
      throw new Error(`  ✗ 门错误还剩 ${left--} 条（逐轮在缩短）`)
    },
  })
  assert.equal(fixed.text, '收束', '逐轮变化的错误行不误杀')

  // 成功发布（进展世代前移）清零：同一失败文本再出现也从头计数——正常节奏不误杀
  const publishing = fakeStream([
    ...Array.from({ length: 6 }, (_, i) => ({ text: `第${i + 1}轮`, toolCalls: [{ id: `p${i}`, name: 'draft_finish', arguments: '{}' }] })),
    { text: '收束' },
  ])
  const agent4 = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream: publishing }, systemClock)
  let published = 0
  const ok = await agent4.agentLoop({
    station: '教练执行', prompt: '发布', tools: [],
    progressEpoch: () => published,
    runTool: async () => {
      published++ // 每轮都算「发布成功」——世代前移即清零
      throw new Error('  ✗ 同一条错误行（逐字相同）')
    },
  })
  assert.equal(ok.text, '收束', '有进展的重复失败不熔断')
})

test('#309 ④ 事故语料回放：2026-09-17 实机的 19 轮工具结果喂进回路，熔断在第三次 finish 被拒时止血', async () => {
  // fixture = 事故实机语料 `生成语料/教练执行/bad-...0021.md` 里逐轮摘出的工具结果原文
  // （提取规则见 fixture 的 `_source`）。回放价值：口径① 在这段序列上 0 次触发（连续逐字
  // 相同被中间的成功 patch 与一次 patch 形状拒绝打断），口径② 在第 24 次工具调用（第 18 轮，
  // 本地 00:18:00）命中一条 `✗ ops.0: … teaches[…] 档位非法 "初识"（允许 知道/会用/能教）`
  // 第三次在场——实测止血点，此后还有 3 轮调用（含又一次同文案拒绝与撞 K 顶前的挣扎）没发生。
  const seq = incidentSeq()
  // fixture 按**轮**存（一轮可多具工具，同一批结果）；缝的 runTool 按**具**调——拍平成一具一条，
  // 否则第一轮（4 具只读工具）就会让后面的轮次整体错位。
  const calls = seq.flatMap((t, ti) => t.calls.map((name, i) => ({ name, id: `t${ti + 1}-${i}`, failed: t.failed, result: t.result })))
  const script = Array.from({ length: seq.length }, (_, ti) => ({
    text: '继续。',
    toolCalls: seq[ti]!.calls.map((name, i) => ({ id: `t${ti + 1}-${i}`, name, arguments: '{}' })),
  }))
  script.push({ text: '（脚本耗尽前的收束）', toolCalls: [] })
  const stream = fakeStream(script)
  const agent = new AgentSeam({ logger: memLogger(), complete: fakeComplete([]), stream }, systemClock)
  let turn = 0
  await assert.rejects(
    () => agent.agentLoop({
      station: '教练执行', prompt: '生长', tools: [],
      runTool: async () => {
        const c = calls[turn++]
        if (!c) throw new Error('回放越界：熔断本该早已止血')
        if (c.failed) throw new Error(c.result)
        return c.result
      },
    }),
    /工具回路熔断：draft_finish 的同一结果行在本次会话内累计出现 3 次/,
  )
  assert.equal(turn, 24, '恰在第 24 次工具调用（第 18 轮）熔断——事故里它一路跑到第 21 轮撞 K 顶')
})

test('#302 ② 工具失败事件：成功调用不发；失败摘要是首行（全文留在轨迹与语料）', async () => {
  const log = memLogger()
  const stream = fakeStream([
    { text: '查', toolCalls: [{ id: 'ok1', name: 'graph_view', arguments: '{}' }] },
    { text: '再查', toolCalls: [{ id: 'bad1', name: 'bank_view', arguments: '{}' }] },
    { text: '收束' },
  ])
  const agent = new AgentSeam({ logger: log, complete: fakeComplete([]), stream }, systemClock)
  const r = await agent.agentLoop({
    station: '教练生长', prompt: 'p', tools: [],
    runTool: async call => {
      if (call.name === 'bank_view') throw new Error('白名单外工具\n第二行细节不进摘要')
      return '图面'
    },
  })
  assert.equal(log.count('agent.tool.fail'), 1, '成功调用不发事件（失败才发）')
  const e = log.nth('agent.tool.fail')!
  assert.equal(e.level, 'warn')
  assert.equal(e.fields.tool, 'bank_view')
  assert.equal(e.fields.error, '白名单外工具', '摘要 = 首行（多行错误的细节走轨迹/语料）')
  assert.equal(e.fields.chars, '白名单外工具\n第二行细节不进摘要'.length)
  assert.match(r.trajectory.join('\n'), /bank_view.*（失败）/, '轨迹照旧逐条记（#163 任务消息消费面不动）')
})
