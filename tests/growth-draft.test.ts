import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Graph, GraphStore } from '../src/engine/graph/graph.ts'
import { YAML } from '../src/engine/infra/yaml.ts'
import { GrowthSubsystem } from '../src/engine/coach/growth-subsystem.ts'
import { normalizePatchShape, replayDraft, sealedDecisionOf, editGateErrors, simulateOps } from '../src/engine/index.ts'
import { GROWTH_DRAFT_MARKER, draftPathOf, loadDraft } from '../src/engine/coach/growth-draft.ts'
import { GROWTH_DRAFT_MAX_ROUNDS } from '../src/engine/infra/params.ts'
import type { EditGateCtx } from '../src/engine/index.ts'
import type { EditOp, EditProposalSpec } from '../src/engine/coach/proposals.ts'
import type { GNode } from '../src/engine/types.ts'
import type { ConceptEntry, EndpointAnchor } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import { AgentSeam } from '../src/engine/infra/agent.ts'
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

// ---- #309：门同源 / 逃生口 / 水位重放（判据落在「模型看到了什么」上，故要摘回执） ----

/** 摘每轮工具回执（`req.messages` 末条 tool 消息）的脚本化假 agent（先例：#301 端到端用例）。 */
function receiptFake(queue: LoopTurn[][]): { seam: AgentSeam; receipts: string[] } {
  const receipts: string[] = []
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
      return current.shift()!
    },
  }, systemClock)
  return { seam, receipts }
}

/** 一具 draft_patch 调用（用例里 4 行以内能读完）。 */
function patchCall(id: string, ops: unknown[], extra: Record<string, unknown> = {}): LoopTurn {
  return { text: '', toolCalls: [{ id, name: 'draft_patch', arguments: JSON.stringify({ ops, ...extra }) }] }
}

/** 一具写件工具调用（draft_audit / draft_finish / draft_revert 这类无参或单参的）。 */
function toolCall(id: string, name: string, args: Record<string, unknown> = {}): LoopTurn {
  return { text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }
}

/** 草稿快照（站级用例读盘面用；目录里至多一份在途）。 */
function draftDocIn(h: Awaited<ReturnType<typeof withVault>>): {
  ops: Array<{ op?: string; name?: string; teaches?: unknown }>
  published: number
  concepts: Array<{ canonical: string }>
  note?: unknown
  rounds: Array<{ kind: string; summary: string; errors?: string[] }>
} {
  const dir = `${h.paths.courseStateDir('数学')}/草稿`
  const file = readdirSync(dir)[0]!
  return JSON.parse(readFileSync(join(dir, file), 'utf8'))
}

// ---- #312：轮次预算耗尽后的收束面（草稿侧；逃生口本体归 #309 的 draft_revert）----

/** 往课程草稿目录落一份在途草稿（存量草稿的站级用例共用）。 */
async function seedDraft(
  h: Awaited<ReturnType<typeof withVault>>,
  doc: Record<string, unknown>,
): Promise<void> {
  const dir = `${h.paths.courseStateDir('数学')}/草稿`
  await h.engine.fs.mkdir(dir)
  await h.engine.fs.writeFile(join(dir, `${String(doc.session_id)}.json`), JSON.stringify({
    marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', published: 0, concepts: [],
    created_at: '2026-09-16T00:00:00.000Z', updated_at: '2026-09-16T00:00:00.000Z',
    ...doc,
  }))
}

test('#312 B4：轮次预算耗尽不再砖化——入口照进站，追加补丁被拒并点名真出口，已备好的批照常发布', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    // 一次挣扎会话撞满预算（16 轮）后草稿保留、轮数跨触发累计：此前每次触发都在入口抛，
    // 「可显式取消」当时没有任何生产接面 → 该课程事实上锁死（除手删磁盘文件外无出路）。
    await seedDraft(h, {
      session_id: 'draft-budget',
      ops: [
        { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, teaches: { 变化率: '会用' } },
        { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
      ],
      rounds: Array.from({ length: GROWTH_DRAFT_MAX_ROUNDS }, (_, i) => ({
        at: '2026-09-16T00:00:00.000Z', kind: 'patch', summary: `历史轮 ${i + 1}`,
      })),
      note: { operator: '前进', reason: '前沿缺下一台阶', target_endpoints: ['用导数解决优化问题'] },
    })
    const { seam, receipts } = receiptFake([[
      patchCall('c1', [{ op: 'add_node', name: '多余台阶', pre: ['认识变化率'] }], { note_operator: '前进', note_reason: 'r' }),
      toolCall('c2', 'draft_finish'),
      { text: '已发布备好的那批。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.resumed, true, '预算耗尽也照进站续建（此前入口抛 = 连收束的机会都没有）')
    assert.equal(r.finished, true, '已备好的批照常发布：收束权归回路')
    assert.equal(r.unpublished_ops, 0)
    const fed = receipts.join('\n')
    assert.equal(fed.includes('多余台阶'), false, '追加补丁整批未落草稿')
    assert.match(fed, /轮次预算耗尽/, '拒收回执说明预算状态')
    assert.match(fed, /draft_revert/, '回执点名可用的收束动作（#309 的逃生口）')
    assert.match(fed, /learnhub_coach_draft_cancel/, '回执点名真实存在的出口（agent 工具）')
    assert.match(fed, /coach\/draft\/cancel/, '回执点名真实存在的出口（宿主路由）')
  })
})

test('#312 B4：预算耗尽只收紧「追加」——收束动作照放行（draft_revert 撤掉卡住的增量后清空本批）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    await seedDraft(h, {
      session_id: 'draft-budget-revert',
      ops: [{ op: 'add_node', name: '多余台阶', pre: ['认识变化率'], est: 12 }],
      rounds: Array.from({ length: GROWTH_DRAFT_MAX_ROUNDS }, (_, i) => ({
        at: '2026-09-16T00:00:00.000Z', kind: 'patch', summary: `历史轮 ${i + 1}`,
      })),
      note: { operator: '前进', reason: 'r' },
    })
    const { seam, receipts } = receiptFake([[
      toolCall('r1', 'draft_revert'),
      { text: '撤回后收束。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.unpublished_ops, 0, '逃生口在预算耗尽时照常可用（它是收束动作，不是添砖）')
    assert.match(receipts.join('\n'), /已撤销 1 条未发布增量/)
    const doc = draftDocIn(h)
    assert.deepEqual(doc.ops, [], '未发布增量已清，批级 note 随批作废')
    assert.equal(doc.note, undefined)
  })
})

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
          },
          // 前进批的接线义务也归**补丁期**的门（#309 缺陷①）：试算跑的是受理门同一套，
          // 含终点锚保护——少了这条 set_pre，补丁当场被拒而不是等到 finish
          { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] }],
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
    assert.ok(receipts.some(r => /已入草稿：本补丁 2 条/.test(r)), '成功回执照旧')
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
    // 只留「误解字典形」这一处毒：同一批语料里档位也是非法的（直观/理解/应用），而 #309 缺陷①
    // 之后 schema 门会先报档位那一行——本用例要钉的是毒**形状**本身，故把档位键摘掉让判据对准它
    const legacyOps = poison.ops!.map(o => {
      const { teaches: _t, assumes: _a, ...rest } = o as Record<string, unknown>
      return rest
    }).filter(o => Object.keys(o).length)
    await h.engine.fs.writeFile(join(dir, 'draft-legacy.json'), JSON.stringify({
      marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', session_id: 'draft-legacy',
      ops: legacyOps, published: 0, concepts: [], rounds: [],
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
    // 回灌是字段指向的可执行行。**措辞换了一处**（#309 缺陷①）：finish 现在跑的是受理门完整
    // 序列（schema 纯校验在前），毒形状由 `parseConceptFields` 先报「必须是列表」——这句比
    // 重放侧的「形状非法」更贴入口（重放侧那一句仍覆盖在单元级断言里，见本用例上半段）。
    assert.match(finish[0]!.errors!.join('\n'), /misconceptions 必须是列表/, '回灌是字段指向的可执行行')
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

test('#302 ② finish 崩溃补轮志：缺 note / 非法算子这类抛出此前零痕迹，现在进草稿轮志（含崩溃摘要）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    // 事故形态：模型连调 draft_finish 而每次都在同一条早退分支上抛错（缺本批 note）。
    // 此前这类抛出既不发工具失败事件、也不写轮志——草稿里只剩 patch/audit，finish 一次没有。
    const r = await h.engine.growth2.coachDraft('数学', scriptFake([[
      { text: '', toolCalls: [{ id: 'c1', name: 'draft_finish', arguments: '{}' }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'draft_finish', arguments: '{ }' }] },
      { text: '先不发了。' },
    ]]))
    assert.equal(r.finished, false)
    const finishes = r.rounds.filter(x => x.kind === 'finish')
    assert.equal(finishes.length, 2, '两次崩溃各留一条 finish 轮志（此前一次都没有）')
    assert.match(finishes[0]!.summary, /^finish 崩溃（\[draft_finish\] 缺本批 note/)
    // 崩溃摘要 = 错误首行；完整错误原文随轮志 errors 落盘（可回灌给下一轮的执行官看）
    const doc = await loadDraft(h.engine.fs, draftPathOf(h.engine.paths, '数学', r.session_id))
    const last = doc!.rounds.at(-1)!
    assert.equal(last.kind, 'finish')
    assert.equal(last.errors?.length, 1)
    assert.match(last.errors![0]!, /缺本批 note/)
  })
})

// ---- #309 缺陷①：补丁期即拒（门同源含 schema 面）----

test('#309 ① 补丁期就拒非法取值：档位「初识」/ 退役 op move / 非法 bloom·difficulty 各被拒并回灌取值域', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const { seam, receipts } = receiptFake([[
      // 事故原形：模型自造档位「初识」（合法只有 知道/会用/能教）——此前一路落进草稿，
      // 直到 finish 才被 propose 的 schema 门拒，而那时 op 已清不掉（缺陷②叠缺陷①）
      patchCall('p1', [{ op: 'add_node', name: '平均变化率', pre: ['认识变化率'], teaches: { 变化率: '初识' } }],
        { note_operator: '旁支', note_reason: 'r' }),
      // 退役 op（事故里 ops[11] 的另一个永久毒点）
      patchCall('p2', [{ op: 'move', node: '认识变化率', to: '别处' }], { note_operator: '旁支', note_reason: 'r' }),
      patchCall('p3', [{ op: 'add_node', name: '甲台阶', pre: ['认识变化率'], bloom: '领悟' }], { note_operator: '旁支', note_reason: 'r' }),
      patchCall('p4', [{ op: 'add_node', name: '乙台阶', pre: ['认识变化率'], difficulty: 9 }], { note_operator: '旁支', note_reason: 'r' }),
      { text: '四批都被拒，收束。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.unpublished_ops, 0, '毒 op 一条都没落草稿（草稿零落毒）')
    assert.equal(draftDocIn(h).ops.length, 0)
    const all = receipts.join('\n---\n')
    assert.match(all, /档位非法 "初识"（允许 知道\/会用\/能教）/, '非法档位在补丁期就被拒且指明合法取值')
    assert.match(all, /非法操作 move.*已随 Region\/Block 退役/, '退役 op 同款被补丁期拒')
    assert.match(all, /非法认知层级 领悟/, '非法 bloom 同款')
    assert.match(all, /非法难度 9/, '非法 difficulty 同款')
    assert.match(all, /合法取值域：\n  · 档位取值域（teaches \/ assumes 的值）：知道 \/ 会用 \/ 能教/, '回灌带档位取值域')
    assert.match(all, /op 词汇：add_node \/ del_node \/ set_pre \/ set_enc \/ rename \/ set_note/, '回灌带 op 词汇')
    // 每次拒收都留轮志（#302 ② 的观测面照旧）
    assert.equal(draftDocIn(h).rounds.filter(x => x.kind === 'patch').length, 4)
  })
})

test('#309 ①③ 审计 = 同批 propose 的受理结论（同一批 ops 两侧错误行逐字一致）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    // 存量毒草稿（读侧不自愈）：绕过补丁期门的那一类只能在草稿里预置
    const dir = `${h.paths.courseStateDir('数学')}/草稿`
    await h.engine.fs.mkdir(dir)
    const ops = [{ op: 'add_node', name: '平均变化率', pre: ['认识变化率'], teaches: { 变化率: '初识' } }]
    await h.engine.fs.writeFile(join(dir, 'draft-poison.json'), JSON.stringify({
      marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', session_id: 'draft-poison',
      ops, published: 0, concepts: [], rounds: [],
      note: { operator: '旁支', reason: '存量毒草稿' },
      created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z',
    }))
    const { seam, receipts } = receiptFake([[toolCall('a1', 'draft_audit'), { text: '收束。' }]])
    // 审计看见门错误后模型收束，草稿里还留着那条毒 op → 禁止空手结束 fail loud（照旧纪律）
    await assert.rejects(() => h.engine.growth2.coachDraft('数学', seam), /禁止空手结束/)
    const audit = receipts.find(r => r.startsWith('审计'))!
    assert.match(audit, /审计未过/, '审计看得见 schema 面的错（此前只跑结构重放，会报「通过」）')
    const auditErrors = audit.split('\n').filter(l => l.trim().startsWith('✗')).map(l => l.trim())

    // 同一批 ops 走真实受理门：错误行必须逐字一致（「草稿通过 = 门通过」的反面同款）
    await assert.rejects(
      () => h.engine.graph.graphPropose('edit', YAML.stringify({
        course: '数学', ops, note: { operator: '旁支', reason: '存量毒草稿' },
      })),
      (err: Error) => {
        const proposeErrors = err.message.split('\n').filter(l => l.trim().startsWith('✗')).map(l => l.trim())
        assert.deepEqual(proposeErrors, auditErrors, '两侧错误行逐字一致（门同源含 schema 面）')
        return true
      },
    )

    // 另一侧（AC3 的 ⟺）：干净的一批两侧**都过**——审计说「通过」且受理门收下它。
    // 只钉拒绝侧会把「审计恒判不过」这种实现读成合规，故两个方向各来一次。
    const cleanDir = `${h.paths.courseStateDir('数学')}/草稿`
    await h.engine.fs.unlink(join(cleanDir, 'draft-poison.json')).catch(() => undefined)
    const goodOps = [
      { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, teaches: { 变化率: '会用' } },
      { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
    ]
    await h.engine.fs.writeFile(join(cleanDir, 'draft-clean.json'), JSON.stringify({
      marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', session_id: 'draft-clean',
      ops: goodOps, published: 0, concepts: [], rounds: [],
      note: { operator: '前进', reason: '前沿缺下一台阶', target_endpoints: ['用导数解决优化问题'] },
      created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z',
    }))
    const clean = receiptFake([[toolCall('a2', 'draft_audit'), { text: '收束。' }]])
    await assert.rejects(() => h.engine.growth2.coachDraft('数学', clean.seam), /禁止空手结束/)
    assert.match(clean.receipts.join('\n'), /审计通过（草稿通过 = 门通过）/, '干净的一批审计通过')
    const proposed = await h.engine.graph.graphPropose('edit', YAML.stringify({
      course: '数学', ops: goodOps,
      note: { operator: '前进', reason: '前沿缺下一台阶', target_endpoints: ['用导数解决优化问题'] },
    }))
    assert.ok(proposed.id > 0, '同一批 ops 受理门也收下——两侧结论一致')
  })
})

// ---- #309 缺陷②：未发布段的逃生口 ----

test('#309 ② 逃生口：draft_revert 清掉已入草稿的坏 op，finish 随后成功发布', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    // 事故草稿的等价物：坏 op 已在水位之上的未发布段（补丁期门落地前入的草稿）
    const dir = `${h.paths.courseStateDir('数学')}/草稿`
    await h.engine.fs.mkdir(dir)
    const poison = { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], teaches: { 变化率: '初识' } }
    const good = [
      { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15, teaches: { 变化率: '会用' } },
      { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
    ]
    await h.engine.fs.writeFile(join(dir, 'draft-stuck.json'), JSON.stringify({
      marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', session_id: 'draft-stuck',
      ops: [poison], published: 0, concepts: [], rounds: [], note: { operator: '前进', reason: '前沿缺下一台阶' },
      created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z',
    }))
    const { seam, receipts } = receiptFake([[
      // 先撞一次墙：finish 被同一批错误行拒（毒 op 卡在未发布段，del+add 也改不动它）
      toolCall('f1', 'draft_finish'),
      // 逃生口：回退到水位（连本批 note / 铸名一并清）
      toolCall('v1', 'draft_revert'),
      patchCall('p1', good, { note_operator: '前进', note_reason: '前沿缺下一台阶', note_target_endpoints: ['用导数解决优化问题'] }),
      toolCall('f2', 'draft_finish'),
      { text: '发布完成。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.finished, true, '撤销后重开一批即可发布——「模型永远有一步可走」')
    assert.equal(r.unpublished_ops, 0)
    assert.match(receipts.join('\n'), /已撤销 1 条未发布增量：add_node\(平均变化率\)/)
    assert.match(receipts.join('\n'), /本批已清空——用 draft_patch 重开一批/)
    // 撤销轮进轮志（续建时注入上下文，恢复认知）
    assert.ok(r.rounds.some(x => x.kind === 'revert'), r.rounds.map(x => x.kind).join(','))
    const nodes = await new GraphStore(h.engine.paths, h.engine.paths.courseRoot('数学'), h.engine.fs).load()
    assert.ok(nodes.some(n => n.name === '平均变化率'), '干净重铸的那一版落了图')
    assert.deepEqual(await h.engine.growth2.coachDraftCancel('数学'), { cancelled: false }, '发布成功草稿清场')
  })
})

test('#309 ② draft_revert 的部分撤销与边界：count 只丢尾部 N 条；越界/非正整数当场拒收', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const { seam, receipts } = receiptFake([[
      patchCall('p1', [
        { op: 'add_node', name: '甲台阶', pre: ['认识变化率'] },
        { op: 'add_node', name: '乙台阶', pre: ['甲台阶'] },
      ], { note_operator: '旁支', note_reason: 'r' }),
      toolCall('v1', 'draft_revert', { count: 1 }),
      toolCall('v2', 'draft_revert', { count: 5 }), // 越界
      toolCall('v3', 'draft_revert', { count: 0 }), // 非正整数
      toolCall('v4', 'draft_revert'), // 全省
      { text: '收束。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    const all = receipts.join('\n---\n')
    assert.match(all, /已撤销 1 条未发布增量：add_node\(乙台阶\)。\n水位 0\/1；未发布增量 1 条/, 'count 只丢尾部 N 条')
    assert.match(all, /count=5 超过未发布增量 1 条/, '越界可读拒收')
    assert.match(all, /count 必须是正整数/, '非正整数拒收')
    assert.match(all, /已撤销 1 条未发布增量：add_node\(甲台阶\)。\n水位 0\/0；未发布增量 0 条/, '省略 count = 回到水位')
    assert.equal(r.unpublished_ops, 0)
    assert.equal(draftDocIn(h).ops.length, 0)
    assert.equal(draftDocIn(h).note, undefined, '回到水位 = 本批作废，note 一并清')
  })
})

test('#309 ② 逃生口边界：没有未发布增量时 draft_revert 可读拒收（不动已发布段）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const { seam, receipts } = receiptFake([[toolCall('v1', 'draft_revert'), { text: '收束。' }]])
    await h.engine.growth2.coachDraft('数学', seam)
    assert.match(receipts.join('\n'), /没有未发布增量可撤——已发布段（水位以下）不可动/)
  })
})

// ---- #309 水位重放修正：一批发布后第二批仍可建（旧实现第二批当场死）----

test('#309 水位：一批发布成功后同会话再开一批照常（基图已含已发布段，不重复应用）', async () => {
  await withVault(SEED, async h => {
    await seeded(h)
    const { seam } = receiptFake([[
      patchCall('p1', [
        { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15 },
        { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
      ], { note_operator: '前进', note_reason: '第一级台阶', note_target_endpoints: ['用导数解决优化问题'] }),
      toolCall('f1', 'draft_finish'),
      patchCall('p2', [
        { op: 'add_node', name: '瞬时速度', pre: ['平均变化率'], est: 15 },
        { op: 'set_pre', node: '用导数解决优化问题', pre: ['瞬时速度'] },
      ], { note_operator: '前进', note_reason: '第二级台阶', note_target_endpoints: ['用导数解决优化问题'] }),
      toolCall('f2', 'draft_finish'),
      { text: '两批完成。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.published_batches, 2, '同会话两批都发布成功（旧实现在第二次 draft_patch 就炸）')
    assert.equal(r.finished, true)
    const nodes = await new GraphStore(h.engine.paths, h.engine.paths.courseRoot('数学'), h.engine.fs).load()
    assert.ok(nodes.some(n => n.name === '瞬时速度'))
  })
})

// ---- #309 缺陷③：档位词汇住在写作面 ----

test('#309 ③ 档位取值域进写作面：draft_patch 的工具 description 与上下文包档位块都无条件带', async () => {
  const specs = GrowthSubsystem.draftToolSpecs()
  const patch = specs.find(s => s.name === 'draft_patch')!
  const fields = (patch.parameters as { properties: { ops: { items: { properties: Record<string, { description?: string }> } } } })
    .properties.ops.items.properties
  for (const f of ['teaches', 'assumes'] as const) {
    assert.match(String(fields[f]!.description), /档位取值域：知道 \/ 会用 \/ 能教/, `${f} 的字段说明要给取值域`)
  }
  assert.ok(specs.some(s => s.name === 'draft_revert'), '逃生口是模型可见的工具')
  await withVault(SEED, async h => {
    await seeded(h)
    const pack = await h.engine.growth2.coachContextPack('数学')
    assert.match(pack, /teaches \/ assumes 的档位取值域：知道 \/ 会用 \/ 能教/, '档位块无条件带取值域（空态也带）')
  })
})

// ---- #320 / ADR-0101：单站回路的读件面（还回三件） ----

test('#320 单站读件面：draftToolSpecs 的只读白名单含还回的三件（行为摘要/题库概况/罗盘读）+ #326 的 subgraph', () => {
  const names = GrowthSubsystem.draftToolSpecs().map(s => s.name)
  for (const t of ['behavior_digest', 'bank_overview', 'compass_read'] as const) {
    assert.ok(names.includes(t), `读件 ${t} 在草稿回路工具面（#320 还回，不再桩成空串）`)
  }
  assert.ok(names.includes('subgraph'), '下游子图读件在草稿回路工具面（#326）')
  assert.ok(names.includes('draft_note'), '零操作停摆收束工具在册')
  assert.ok(names.includes('draft_arc'), '弧建议提成独立写件在册（#320）')
  assert.ok(names.includes('draft_revert'), '逃生口工具仍在册')
})

test('#320 单站写件面：弧建议走 draft_arc，draft_patch/draft_note 不再带这些参数（单一通道）', () => {
  const specs = GrowthSubsystem.draftToolSpecs()
  const propsOf = (n: string) => Object.keys(
    (specs.find(s => s.name === n)!.parameters as { properties: Record<string, unknown> }).properties,
  )
  assert.ok(!propsOf('draft_patch').includes('note_serves_arc') && !propsOf('draft_patch').includes('repaint_suggest'),
    'draft_patch 不再带弧建议参数（#320：提成 draft_arc）')
  assert.ok(!propsOf('draft_note').includes('serves_arc') && !propsOf('draft_note').includes('repaint_suggest'),
    'draft_note 不再带弧建议参数')
  assert.deepEqual(propsOf('draft_arc').sort(), ['repaint_suggest', 'serves_arc'], 'draft_arc 只带弧建议两参（serves_arc / repaint_suggest）')
})

