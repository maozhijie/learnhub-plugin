/**
 * 统一 agent 缝（#162 / ADR-0041 双模式 / ADR-0044 归属）单测：
 * - 单发模式：剥围栏归位（原投递层适配器行为）、语义档原样贯通、调用日志按站归组
 *   且注入侧可观测（station/mode/effort/callNo/字数）。
 * - 门错修复轮（共享能力）：首过零修复、拒收恰回灌重裁一轮（门错误+被拒原文）、
 *   仍败以 fatal 抛两轮死因、修复轮自身失败同葬、门内程序性抛错原样冒泡；
 *   受理式门（propose/写盘）的产物经 GateVerdict.result 随行交还。
 * - 工具回路模式：白名单工具执行与结果回灌、runTool 失败以 isError 回灌、
 *   K≤6 轮预算封顶 fail loud（不可被调用方抬高）、LlmStream 缺位 fail loud。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentSeam, AGENT_LOOP_MAX_TOOL_ROUNDS, stripFences } from '../src/engine/agent.ts'
import { systemClock } from '../src/host/clock.ts'
import type { AgentCallRecord, GateVerdict } from '../src/engine/agent.ts'
import type { LlmComplete, LlmEffort, LlmLoopTurn, LlmStream, LlmToolSpec } from '../src/engine/llm.ts'

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
  const agent = new AgentSeam({ complete: port, onCall: obs.onCall }, systemClock)

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
  const agent = new AgentSeam({ complete: port, onCall: obs.onCall }, systemClock)
  const out = await agent.repair('教练生长', '回灌重裁', { effort: 'deep' })
  assert.equal(out, '修好了')
  assert.equal(port.calls[0]!.effort, 'deep')
  assert.equal(obs.records[0]!.mode, 'repair')
})

test('门错修复轮：首过零修复；拒收恰回灌重裁一轮（门错误+被拒原文）；受理产物随行', async () => {
  // 首过：repair 不被调用，受理产物经 result 交还
  const portOk = fakeComplete(['好产出'])
  const agentOk = new AgentSeam({ complete: portOk }, systemClock)
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
  const agent = new AgentSeam({ complete: port }, systemClock)
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

  // 仍败：fatal 拿到两轮死因
  const port2 = fakeComplete(['坏产出', '还是坏'])
  const agent2 = new AgentSeam({ complete: port2 }, systemClock)
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
})

test('门错修复轮：修复轮自身失败（模型/解析抛错）同葬进 fatal；门内程序性抛错原样冒泡', async () => {
  const port = fakeComplete(['坏产出', '修复轮产出'])
  const agent = new AgentSeam({ complete: port }, systemClock)
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
  const agent3 = new AgentSeam({ complete: fakeComplete(['x']) }, systemClock)
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
  const agent = new AgentSeam({ complete: fakeComplete([]), stream, onCall: obs.onCall }, systemClock)
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

test('工具回路：runTool 失败以 isError 回灌（模型可见），K≤6 预算封顶 fail loud；stream 缺位 fail loud', async () => {
  // runTool 抛错 → 工具轮 isError
  const errStream = fakeStream([
    { text: '查', toolCalls: [{ id: 'e1', name: 'bank_view', arguments: '{}' }] },
    { text: '好' },
  ])
  const agent = new AgentSeam({ complete: fakeComplete([]), stream: errStream }, systemClock)
  await agent.agentLoop({
    station: '教练生长', prompt: 'p', tools: [],
    runTool: async () => { throw new Error('白名单外工具') },
  })
  const toolTurn = errStream.requests[1]!.messages[2] as { role: string; text: string; isError?: boolean }
  assert.equal(toolTurn.isError, true)
  assert.match(toolTurn.text, /白名单外工具/)

  // 预算：K≤6 不可抬高——6 轮工具后第 7 轮仍请求工具 → fail loud（不无限回路）
  const endless = fakeStream(Array.from({ length: 9 }, (_, i) => ({
    text: `第${i}轮`, toolCalls: [{ id: `c${i}`, name: 'graph_view', arguments: '{}' }],
  })))
  const agent2 = new AgentSeam({ complete: fakeComplete([]), stream: endless }, systemClock)
  await assert.rejects(
    () => agent2.agentLoop({
      station: '教练生长', prompt: 'p', tools: [],
      runTool: async () => 'ok',
    }),
    /工具回路预算耗尽（K≤6 轮后仍在请求工具）/,
  )
  assert.equal(endless.requests.length, 7, '第 K+1 轮发现仍在请求工具即中止')

  // LlmStream 端口缺位：fail loud 指向适配器缺位
  const agent3 = new AgentSeam({ complete: fakeComplete([]) }, systemClock)
  await assert.rejects(
    () => agent3.agentLoop({ station: '罗盘', prompt: 'p', tools: [], runTool: async () => 'x' }),
    /LlmStream 端口/,
  )
  assert.equal(AGENT_LOOP_MAX_TOOL_ROUNDS, 6, 'ADR-0041 回路预算 K≤6')
})

test('工具回路：任务取消传导（#163）——旗标翻真即中止，后续轮与工具执行不再发生', async () => {
  // 旗标在首轮工具执行后翻真：第二轮底层调用不发生，抛错带取消语义（结果丢弃）
  let cancelled = false
  const stream = fakeStream([
    { text: '查一下', toolCalls: [{ id: 'c1', name: 'graph_view', arguments: '{}' }] },
    { text: '不该到达的终裁' },
  ])
  const agent = new AgentSeam({ complete: fakeComplete([]), stream }, systemClock)
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
  const agent2 = new AgentSeam({ complete: fakeComplete([]), stream: stream2 }, systemClock)
  await assert.rejects(
    () => agent2.agentLoop({ station: '罗盘', prompt: 'p', tools: [], runTool: async () => 'y', isCancelled: () => true }),
    /任务已取消/,
  )
  assert.equal(stream2.requests.length, 0, '开局即取消：回路一次底层调用都不发生')

  // 未取消：isCancelled 缺省语义不变（回路跑完）
  const stream3 = fakeStream([{ text: '终裁' }])
  const agent3 = new AgentSeam({ complete: fakeComplete([]), stream: stream3 }, systemClock)
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
  const agent = new AgentSeam({ complete: sinkFake, onCall: obs.onCall }, systemClock)
  await agent.complete('种子起草', 'p')
  assert.equal(obs.records.length, 1)
  assert.deepEqual(obs.records[0].usage, { inputTokens: 120, outputTokens: 45, reasoningTokens: 30 })
  // 站/形态沿端口 opts 下行（语料捕获贯通，#213）
  const seen: Array<{ station?: string; kind?: string }> = []
  const spy: LlmComplete = async (_p, _s, opts) => {
    seen.push({ station: opts?.station, kind: opts?.kind })
    return 'r'
  }
  const agent2 = new AgentSeam({ complete: spy }, systemClock)
  await agent2.repair('教练生长', '回灌')
  assert.deepEqual(seen, [{ station: '教练生长', kind: 'repair' }])
  // 端口不回 usage：AgentCallRecord.usage 缺席（路由未上报的合法态）
  const agent3 = new AgentSeam({ complete: fakeComplete(['x']), onCall: obs.onCall }, systemClock)
  await agent3.complete('罗盘', 'p')
  assert.equal(obs.records[1].usage, undefined)
})
