import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Graph } from '../src/engine/graph.ts'
import { normalizePatchShape, replayDraft, sealedDecisionOf, editGateErrors, simulateOps } from '../src/engine/index.ts'
import { GROWTH_DRAFT_MARKER } from '../src/engine/growth-draft.ts'
import type { EditGateCtx } from '../src/engine/index.ts'
import type { EditOp, EditProposalSpec } from '../src/engine/proposals.ts'
import type { GNode } from '../src/engine/types.ts'
import type { ConceptEntry, EndpointAnchor } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import { AgentSeam } from '../src/engine/agent.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

// 生长草稿内核与执行官站（#271 / ADR-0088；#301 形状门/门异常/站标签）：
// - 门同源：replayDraft 与 simulateOps 同一套结构重放；editGateErrors 收拢受理门全序列。
// - sealed 谓词单一出处：seal（零 add_node 纯 set_pre）/ reopen（含 add_node 接线）/ 夹带不动。
// - 站级：脚本化假 agent 灌工具调用轨迹——过门 / 按批 finish 走真实提案管线 / 拒收零落盘 /
//   续建恢复认知 / 禁止空手结束。
// - #301 形状门：补丁入口「收下即归一」（宽容归一 + 可见回执 + tolerated 补标），事故语料
//   作 fixture 逐调用回放。

// ---- 纯函数测试夹具：声明序平铺 4 节点（甲→乙→丙 + 终点甲）----
function fixture(): { nodes: GNode[]; graph: Graph } {
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [] },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [] },
    { name: '丙', pre: ['乙'], opt: false, note: '', enc: [] },
    { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
  ]
  return { nodes, graph: new Graph(nodes) }
}

test('replayDraft：草稿差异（新增/接线改写/新增边）与错误累积，simulateOps 同源', () => {
  const { nodes, graph } = fixture()
  const ops: EditOp[] = [
    { op: 'add_node', name: '丁', pre: ['丙'] },
    { op: 'set_pre', node: '丙', pre: ['乙', '丁'] },
    { op: 'del_node', node: '不存在' }, // 错误累积不中断
  ]
  const r = replayDraft(nodes, graph, ops)
  assert.deepEqual(r.errors, ['del_node 节点不存在: 不存在'])
  assert.deepEqual(r.diff.added_nodes, ['丁'])
  const rewire = r.diff.rewired.find(w => w.node === '丙')!
  assert.deepEqual(rewire.pres_before, ['乙'])
  assert.deepEqual(rewire.pres_after, ['乙', '丁'])
  assert.deepEqual(r.diff.added_edges, [{ node: '丙', pre: '丁' }])
  // 门同源：simulateOps 内部改调 replayDraft，错误逐字一致
  assert.deepEqual(simulateOps(nodes, graph, ops), r.errors)
})

test('sealedDecisionOf：零 add_node 纯 set_pre 批 = seal；含 add_node 接线 = reopen；夹带零新增批不动', () => {
  const anchors: EndpointAnchor[] = [{
    endpoint: '终点甲', goal_type: 'capability', declared: '2026-09-16',
    worksheet: [], seed_nodes: [], start_basis: {},
  }]
  const seal = sealedDecisionOf([{ op: 'set_pre', node: '终点甲', pre: ['丙'] }], anchors)
  assert.equal(seal.sealing, true)
  assert.deepEqual(seal.effects, [{ endpoint: '终点甲', action: 'seal' }])
  const reopen = sealedDecisionOf([
    { op: 'add_node', name: '丁', pre: [] },
    { op: 'set_pre', node: '终点甲', pre: ['丁'] },
  ], anchors)
  assert.deepEqual(reopen.effects, [{ endpoint: '终点甲', action: 'reopen' }])
  const untouched = sealedDecisionOf([
    { op: 'set_note', node: '甲', note: 'x' },
    { op: 'set_pre', node: '终点甲', pre: ['丙'] },
  ], anchors)
  assert.equal(untouched.sealing, false)
  assert.deepEqual(untouched.effects, [])
})

test('editGateErrors：概念未铸名/终点接线义务被拦；全过则空', async () => {
  const { nodes, graph } = fixture()
  const anchors: EndpointAnchor[] = [{
    endpoint: '终点甲', goal_type: 'capability', declared: '2026-09-16',
    worksheet: [], seed_nodes: [], start_basis: {},
  }]
  const entries: ConceptEntry[] = []
  const base = { nodes, graph, entries, anchors }
  const bad: EditProposalSpec = {
    course: '数学',
    ops: [{ op: 'add_node', name: '丁', pre: [], teaches: { 未铸名: '会用' } }],
    note: { operator: '旁支', reason: 'r' },
  }
  const errors = await editGateErrors(bad, base satisfies EditGateCtx)
  assert.ok(errors.some(e => e.includes('未铸名') || e.includes('在册')), errors.join('\n'))
  const noWire: EditProposalSpec = {
    course: '数学',
    ops: [{ op: 'add_node', name: '丁', pre: [] }],
    note: { operator: '前进', reason: 'r', target_endpoints: ['终点甲'] },
  }
  const errors2 = await editGateErrors(noWire, base satisfies EditGateCtx)
  assert.ok(errors2.some(e => e.includes('未接线')), errors2.join('\n'))
  const good: EditProposalSpec = {
    course: '数学',
    ops: [
      { op: 'add_node', name: '丁', pre: [], teaches: { 新概念: '会用' } },
      { op: 'set_pre', node: '终点甲', pre: ['丁'] },
    ],
    note: { operator: '前进', reason: 'r', target_endpoints: ['终点甲'] },
  }
  const ok = await editGateErrors(good, { ...base, mints: [{ canonical: '新概念' }] })
  assert.deepEqual(ok, [])
})

// ---- 站级：脚本化假 agent ----
type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
function scriptFake(sessions: Array<string | LoopTurn[]>) {
  const queue = sessions.map(s => [...(typeof s === 'string' ? [{ text: s }] : s)] as LoopTurn[])
  let current: LoopTurn[] = []
  const seam = new AgentSeam({
    logger: memLogger(),
    complete: async () => { throw new Error('脚本化补全端口：不应调用') },
    stream: async req => {
      void req
      if (!current.length) {
        current = queue.shift()
        if (!current) throw new Error('脚本化回路端口：会话脚本已耗尽')
      }
      const next = current.shift()!
      return { text: next.text, toolCalls: next.toolCalls ?? [] }
    },
  }, systemClock)
  return seam
}

const SEED = { registry: null, graph: null }

async function seeded(h: Awaited<ReturnType<typeof withVault>>): Promise<void> {
  await draftCourse(h.engine, CAPABILITY_DRAFT)
}

test('执行官站：patch→finish 走真实提案管线并落 sealed；草稿清场；水位前移', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const agent = scriptFake([[
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({
          ops: [
            { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15 },
            { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
          ],
          note_operator: '前进',
          note_reason: '前沿缺下一台阶',
          note_target_endpoints: ['用导数解决优化问题'],
        }),
      }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'draft_finish', arguments: '{}' }] },
      { text: '本批已发布，收束。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', agent)
    assert.equal(r.finished, true)
    assert.equal(r.unpublished_ops, 0)
    assert.equal(r.published_batches, 1)
    // 走的是真实提案管线：journal 有 graph_edit、快照已推进
    const applied = await h.engine.graph.graphProposals('applied', 'edit')
    assert.ok(applied.length >= 1, '提案已 applied')
    // 发布成功草稿已清场（显式取消拿不到在途草稿）
    assert.deepEqual(await h.engine.growth2.coachDraftCancel('数学'), { cancelled: false })
  })
})

test('执行官站：拒收回灌 loop（坏补丁回滚）+ 禁止空手结束（有增量未 finish 即 fail loud）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    // 第一批：坏补丁（引用不存在节点）被回滚后，好补丁入草稿；随后回路收束不 finish → fail loud
    const agent = scriptFake([[
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({ ops: [{ op: 'add_node', name: '平均变化率', pre: ['不存在的节点'] }], note_operator: '巩固', note_reason: 'r' }),
      }] },
      { text: '', toolCalls: [{
        id: 'c2', name: 'draft_patch',
        arguments: JSON.stringify({ ops: [{ op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, teaches: { 变化率: '会用' } }], note_operator: '巩固', note_reason: '综合收束' }),
      }] },
      { text: '收束（故意不 finish）。' },
    ]])
    await assert.rejects(
      () => h.engine.growth2.coachDraft('数学', agent),
      /未发布增量.*禁止空手结束|禁止空手结束/,
    )
    // 拒收零落草稿：坏补丁的「不存在的节点」不在草稿里；草稿保留可续建
    const r2 = await h.engine.growth2.coachDraft('数学', scriptFake([[
      { text: '', toolCalls: [{ id: 'c3', name: 'draft_audit', arguments: '{}' }] },
      { text: '', toolCalls: [{
        id: 'c4', name: 'draft_finish', arguments: '{}',
      }] },
      { text: '续建发布完成。' },
    ]]))
    assert.equal(r2.resumed, true, '在途草稿默认续建')
    assert.equal(r2.finished, true)
  })
})

// ---- #301 缺陷①：补丁形状门「收下即归一」（事故语料作 fixture 回放）----

const HERE = dirname(fileURLToPath(import.meta.url))

interface IncidentPatch {
  ops?: Array<Record<string, unknown>>
  concepts?: unknown
}
/** 事故语料 fixture（2026-09-16 数学基础空课）：draft_patch 各次调用的 arguments 原文
 * （提取规则写在 fixture 的 `_source` 里，来源 = vault 语料 `教练执行/ok-2026-09-16T10-00-*.md`）。 */
function incidentPatch(call: number): IncidentPatch {
  const doc = JSON.parse(readFileSync(join(HERE, 'fixtures', 'growth-draft-incident-2026-09-16.json'), 'utf8')) as {
    calls: Array<{ call: number; patch: IncidentPatch }>
  }
  const hit = doc.calls.find(c => c.call === call)
  assert.ok(hit, `fixture 里没有 call${call}`)
  return hit.patch
}

test('#301 形状归一：事故语料逐调用回放（call2 字符串列表拒收 / call3 字典归一 / call5 铸名归一）', () => {
  // call2：两条 add_node 的误解都写成字符串列表（一条字符串拆不出它属于哪个概念）→ 整批拒收
  const call2 = incidentPatch(2)
  const s2 = normalizePatchShape(call2.ops!, call2.concepts)
  assert.equal(s2.errors.length, 2, s2.errors.join('\n') || '（本该拒收）')
  assert.match(s2.errors[0]!, /ops\.0\.misconceptions/)
  assert.match(s2.errors[1]!, /ops\.1\.misconceptions/)
  assert.match(s2.errors[0]!, /字符串列表/)
  assert.match(s2.errors[0]!, /concept, model/, '拒收行给合法形态（回灌即修正依据）')

  // call3：误解写成按概念归组的字典 → 归一为条目数组 + 归一动作进回执行
  const call3 = incidentPatch(3)
  const s3 = normalizePatchShape(call3.ops!, call3.concepts)
  assert.deepEqual(s3.errors, [])
  assert.deepEqual(s3.ops[0]!.misconceptions, [
    { concept: '导数', model: '把微积分当成一堆孤立公式，说不出它要解决的两类基本问题' },
    { concept: '导数', model: '把导数与积分当成互不相关的两个章节，而非同一枚硬币的两面' },
  ])
  assert.ok(s3.normalized.some(n => /ops\.0\.misconceptions 字典 → 条目数组（1 概念 \/ 2 条）/.test(n)), s3.normalized.join('\n'))
  assert.equal(s3.concepts.length, 5, '同批字符串铸名归一为 5 枚条目')

  // call5 / call6：铸名写成 {name: X} → 归一为 {canonical: X}
  for (const call of [5, 6]) {
    const p = incidentPatch(call)
    const s = normalizePatchShape(p.ops ?? [], p.concepts)
    assert.deepEqual(s.errors, [], `call${call}`)
    assert.deepEqual(s.concepts.map(c => c.canonical), ['导数', '积分', '极限', '瞬时变化率', '变化率'])
    assert.ok(s.normalized.some(n => /\{name\} → \{canonical: "导数"\}/.test(n)), s.normalized.join('\n'))
  }

  // call15：配对列表 teaches/assumes → 概念→档映射（同批误解条目键名写成 text → 入口拒收）
  const call15 = incidentPatch(15)
  const s15 = normalizePatchShape(call15.ops!, call15.concepts)
  assert.match(s15.errors.join('\n'), /未知字段 \["text"\]/, '键名错（原文 text，合法 model）在入口就拒收')
  assert.deepEqual(s15.ops[2]!.teaches, { 导数: '直观', 积分: '直观' }, '配对列表归一为映射（归一与拒收各算各的）')

  // call17：铸名整块写成字典（不是列表）→ 按「名字→定义」归一为多枚铸名
  const call17 = incidentPatch(17)
  const s17 = normalizePatchShape(call17.ops!, call17.concepts)
  assert.deepEqual(s17.errors, [])
  assert.deepEqual(s17.concepts, [
    { canonical: '导数', definition: '函数在某点处的瞬时变化率（差商的极限）' },
    { canonical: '积分', definition: '累积量的极限（黎曼和的极限）' },
    { canonical: '极限', definition: '自变量趋近某点时函数值趋向的确定值' },
    { canonical: '瞬时变化率', definition: '某时刻的即时变化速度，即导数' },
  ])

  // call21：本来合法的载荷零归一零拒收（无形状改动 = 不动它）
  const call21 = incidentPatch(21)
  const s21 = normalizePatchShape(call21.ops!, call21.concepts)
  assert.deepEqual(s21.errors, [])
  assert.deepEqual(s21.normalized, [])
  assert.deepEqual(s21.concepts, [])
})

test('#301 形状归一：裸值/非法形态逐类（铸名裸字典、非文本误解字典、误解条目非映射）', () => {
  // concepts 整块不是列表（裸字典）→ 按单条归一收下
  const bare = normalizePatchShape([], { 导数: '瞬时变化率' })
  assert.deepEqual(bare.errors, [])
  assert.deepEqual(bare.concepts, [{ canonical: '导数', definition: '瞬时变化率' }])
  assert.ok(bare.normalized.some(n => /concepts 不是列表（字典）/.test(n)))

  // 误解字典的值不是文本/文本列表 → 拒收（不猜内容）
  const badDict = normalizePatchShape([{ op: 'add_node', name: '丁', misconceptions: { 甲: { 深: 'x' } } }], [])
  assert.equal(badDict.errors.length, 1)
  assert.match(badDict.errors[0]!, /字典形的值必须是文本或文本列表/)

  // 误解条目不是映射（字符串列表之外的垃圾项）→ 拒收并指出第几项
  const badItems = normalizePatchShape([{ op: 'add_node', name: '丁', misconceptions: [42] }], [])
  assert.equal(badItems.errors.length, 1)
  assert.match(badItems.errors[0]!, /第 1 项必须是映射/)

  // 铸名字段无法判读（字典但键值都不是名字/定义）→ 拒收并说清合法形态
  const badMint = normalizePatchShape([], [{ canonical: 3 }])
  assert.equal(badMint.errors.length, 1)
  assert.match(badMint.errors[0]!, /铸名必须是条目/)
})

test('#301 形状门端到端：字典形误解归一收下（回执注明归一动作）+ tolerated 回调随当次捕获', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const tolerated: string[] = []
    const receipts: string[] = []
    // 脚本化回路端口：把每轮 messages 里最后一条 tool 结果（= 工具回执）摘出来审
    const queue: LoopTurn[][] = [[
      { text: '', toolCalls: [{
        id: 'c1', name: 'draft_patch',
        arguments: JSON.stringify({
          ops: [{
            op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15,
            teaches: { 变化率: '会用' },
            misconceptions: { 变化率: ['把平均变化率当成瞬时变化率'] },
          }],
          concepts: ['平均变化率'],
          note_operator: '前进',
          note_reason: '前沿缺下一台阶',
          note_target_endpoints: ['用导数解决优化问题'],
        }),
      }] },
      { text: '补丁已入草稿。' },
    ]]
    let current: LoopTurn[] = []
    const seam = new AgentSeam({
      logger: memLogger(),
      complete: async () => { throw new Error('脚本化补全端口：不应调用') },
      stream: async req => {
        const last = req.messages.at(-1)
        if (last?.role === 'tool') receipts.push(last.text)
        if (!current.length) {
          current = queue.shift() ?? []
          if (!current.length) throw new Error('脚本化回路端口：会话脚本已耗尽')
        }
        const next = current.shift()!
        return { text: next.text, toolCalls: next.toolCalls ?? [] }
      },
    }, systemClock)
    await assert.rejects(
      () => h.engine.growth2.coachDraft('数学', seam, { onTolerated: code => tolerated.push(code) }),
      /禁止空手结束/, // 本用例只走到 patch：留着未发布增量收束 → fail loud（回执已落轨迹）
    )
    assert.deepEqual(tolerated, ['patch_shape_normalized'], '归一命中恰一次随当次调用通知宿主')
    assert.ok(receipts.some(r => /形状归一 2 处/.test(r)
      && /字典 → 条目数组（1 概念 \/ 1 条）/.test(r)
      && /concepts\.1 字符串 → 铸名条目「平均变化率」/.test(r)), receipts.join('\n---\n'))
    assert.ok(receipts.some(r => /已入草稿：本补丁 1 条/.test(r)), '成功回执照旧')
    // 落草稿的是归一后的**发布形态**（毒形状不随草稿过夜）
    const dir = `${h.paths.courseStateDir('数学')}/草稿`
    const doc = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')) as {
      ops: Array<{ misconceptions?: unknown }>; concepts: unknown
    }
    assert.deepEqual(doc.ops[0]!.misconceptions, [{ concept: '变化率', model: '把平均变化率当成瞬时变化率' }])
    assert.deepEqual(doc.concepts, [{ canonical: '平均变化率' }])
  })
})

test('#301 缺陷②：毒形状不再击穿门序列——finish 记轮次 + 字段指向的门错误（非裸 TypeError）', async () => {
  const { nodes, graph } = fixture()
  const anchors: EndpointAnchor[] = []
  const base: EditGateCtx = { nodes, graph, entries: [], anchors, mints: [] }
  // 单元级：非列表误解（字典/字符串列表）产出可执行门错误行，不抛异常
  const dictOp = { op: 'add_node', name: '丁', pre: [], misconceptions: { 甲: ['文字'] } } as unknown as EditOp
  assert.ok((await editGateErrors({ course: '数学', ops: [dictOp] }, base))[0]?.includes('misconceptions 形状非法'))
  const strOp = { op: 'add_node', name: '戊', pre: [], misconceptions: ['文字'] } as unknown as EditOp
  assert.match((await editGateErrors({ course: '数学', ops: [strOp] }, base))[0] ?? '', /不是合法条目/)
  // 鬼错误不复活：字符串条目不再摊成 {concept: undefined}（那会报成「概念"undefined"已有 N 条」）
  assert.doesNotMatch((await editGateErrors({ course: '数学', ops: [strOp] }, base)).join('\n'), /undefined/)
  // 非 add_node op 上的概念字段组：门序列不再因 for...of 抛错（该形状由受理 schema 门拒收）
  const noteOp = { op: 'set_note', node: '甲', note: 'x', misconceptions: { 甲: ['文字'] } } as unknown as EditOp
  await assert.doesNotReject(() => editGateErrors({ course: '数学', ops: [noteOp] }, base))
  // teaches/assumes 非映射（配对列表漏过归一时）同样 fail loud——不再摊成 {0:[…]} 再报「引用「0」未在册」
  const pairOp = { op: 'add_node', name: '己', pre: [], teaches: [['概念A', '会用']] } as unknown as EditOp
  const pairErrors = await editGateErrors({ course: '数学', ops: [pairOp] }, base)
  assert.match(pairErrors[0] ?? '', /\.teaches 形状非法/)
  assert.doesNotMatch(pairErrors.join('\n'), /引用「0」/)

  // 站级：存量毒草稿（读侧不自愈）跑 finish → 拿到带字段指向的门错误 + 该轮 finish 落日志
  await withVault(SEED, async h => {
    await seeded(h)
    const dir = `${h.paths.courseStateDir('数学')}/草稿`
    await h.engine.fs.mkdir(dir)
    const poison = incidentPatch(3)
    await h.engine.fs.writeFile(join(dir, 'draft-legacy.json'), JSON.stringify({
      marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', session_id: 'draft-legacy',
      ops: poison.ops, published: 0, concepts: [], rounds: [],
      note: { operator: '巩固', reason: '试探：存量毒形状能否被门拦下' },
      created_at: '2026-09-16T00:00:00.000Z', updated_at: '2026-09-16T00:00:00.000Z',
    }))
    const agent = scriptFake([[
      { text: '', toolCalls: [{ id: 'c1', name: 'draft_finish', arguments: '{}' }] },
      { text: '收到门错误（收束）。' },
    ]])
    await assert.rejects(() => h.engine.growth2.coachDraft('数学', agent), /禁止空手结束/)
    // finish 轮次照记（旧实现的异常穿透让 logRound('finish') 一次都不执行——草稿里零痕迹）
    const doc = JSON.parse(readFileSync(join(dir, 'draft-legacy.json'), 'utf8')) as {
      rounds: Array<{ kind: string; errors?: string[] }>
    }
    const finish = doc.rounds.filter(r => r.kind === 'finish')
    assert.equal(finish.length, 1, 'finish 被拒也留轮次痕迹')
    assert.match(finish[0]!.errors!.join('\n'), /misconceptions 形状非法/, '回灌是字段指向的可执行行')
  })
})

test('#301 缺陷②保险丝：门复验抛异常也折叠成门错误行（草稿里存着门自己读不懂的形状）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const dir = `${h.paths.courseStateDir('数学')}/草稿`
    await h.engine.fs.mkdir(dir)
    await h.engine.fs.writeFile(join(dir, 'draft-legacy.json'), JSON.stringify({
      marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', session_id: 'draft-legacy',
      // 铸名块整块是字典（非列表）——mintConflicts 的 for...of 不可迭代，门复验在抵达
      // 任何 per-op 判定前就抛；保险丝要把它变成可读的门错误行而不是裸异常
      ops: [{ op: 'add_node', name: '平均变化率', pre: ['认识变化率'] }],
      concepts: { 平均变化率: '平均变化率' }, published: 0, rounds: [],
      note: { operator: '前进', reason: '试探：门异常能否折叠成门错误' },
      created_at: '2026-09-16T00:00:00.000Z', updated_at: '2026-09-16T00:00:00.000Z',
    }))
    const agent = scriptFake([[
      { text: '', toolCalls: [{ id: 'c1', name: 'draft_finish', arguments: '{}' }] },
      { text: '收到门错误（收束）。' },
    ]])
    await assert.rejects(() => h.engine.growth2.coachDraft('数学', agent), /禁止空手结束/)
    const doc = JSON.parse(readFileSync(join(dir, 'draft-legacy.json'), 'utf8')) as {
      rounds: Array<{ kind: string; errors?: string[] }>
    }
    const finish = doc.rounds.filter(r => r.kind === 'finish')
    assert.equal(finish.length, 1, '门复验异常也记 finish 轮次（旧实现异常穿透时一次都不记）')
    const line = finish[0]!.errors!.join('\n')
    assert.match(line, /门复验内部异常（非门拒绝/, '折叠成门错误行')
    assert.match(line, /合法形态速查/, '随行给合法形态（与拒收回执同一份常量）')
  })
})
