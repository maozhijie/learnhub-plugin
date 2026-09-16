// 生长批的安全性回归（#313 A 组「静默丢弃」+ B2「插入算子经执行官站不可发布」）：
// 判据都落在**同一件事的两侧**——门说什么、落盘后图/账本是什么。A 组四条的共同形态是
// 「门零错误、回执全绿，而数据没了或被改了」：同批删+建被吞、add_node 的 pre 静默折成
// 零前置、del_node 静默摘入边、未知键无声蒸发。B2 是六算子里的插入经两站编排不可达。
//
// 覆盖：
// - A1/A3 重放与落图同源（replayDraft / applyOpsToNodes 同一套按身份的欠账口径）。
// - A2/A4 schema 门：pre 必须列表、顶层与 op 级未知键 fail loud。
// - B2 站级：插入批的复诊预注册有两条合法来源（draft_patch 的 note_recheck / 思路官计划兜底），
//   落账本（state/边实验.jsonl）——提示词那句「插入批落地时随批携带」由此成立。
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { Graph } from '../src/engine/graph/graph.ts'
import { YAML } from '../src/engine/infra/yaml.ts'
import { replayDraft } from '../src/engine/index.ts'
import { applyOpsToNodes, validateEditProposal } from '../src/engine/coach/proposals.ts'
import { readProbationLedger } from '../src/engine/coach/probation.ts'
import type { EditOp } from '../src/engine/coach/proposals.ts'
import type { GNode } from '../src/engine/types.ts'
import { systemClock } from '../src/host/clock.ts'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import { withVault, noteText } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

// ---- 纯函数夹具：甲→乙→丙（乙带一条 enc 指向甲）+ 终点甲 ----
function fixture(): { nodes: GNode[]; graph: Graph } {
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [] },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [{ node: '甲', w: 1 }] },
    { name: '丙', pre: ['乙'], opt: false, note: '', enc: [] },
    { name: '终点甲', pre: [], opt: false, note: '', enc: [] },
  ]
  return { nodes, graph: new Graph(nodes) }
}

const copy = (nodes: GNode[]): GNode[] => JSON.parse(JSON.stringify(nodes)) as GNode[]
const nameSet = (nodes: GNode[]): Set<string> => new Set(nodes.map(n => n.name))

test('#313 A1：同批 del_node X + add_node X（先删后建改写）不再吞掉新节点', () => {
  const { nodes, graph } = fixture()
  const ops: EditOp[] = [
    { op: 'del_node', node: '乙' },
    { op: 'add_node', name: '乙', pre: ['甲'], teaches: { 变化率: '会用' } },
  ]
  const r = replayDraft(nodes, graph, ops)
  // 零错误：丙 的 pre 在批末重新落到同名新节点上（不是断边，也不该被静默摘掉）
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.diff.added_nodes, ['乙'])
  assert.deepEqual(r.diff.removed_nodes, ['乙'])
  // 落图同事实：新乙在场且轮廓是新写的（旧实现在此把新乙一起滤掉，只剩 journal 说 del+add）
  const after = copy(nodes)
  applyOpsToNodes(after, ops)
  assert.equal(after.length, 4)
  assert.deepEqual(nameSet(after), new Set(['甲', '乙', '丙', '终点甲']))
  assert.deepEqual(after.find(n => n.name === '乙')!.teaches, { 变化率: '会用' })
  assert.deepEqual(after.find(n => n.name === '丙')!.pre, ['乙'], '消费方仍依赖这个名字')
})

test('#313 A1：同批 del_node A + rename B→A 不再吞掉改名结果', () => {
  const { nodes, graph } = fixture()
  const ops: EditOp[] = [
    { op: 'del_node', node: '丙' },
    { op: 'rename', node: '乙', new: '丙' },
  ]
  const r = replayDraft(nodes, graph, ops)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.diff.renamed, [{ from: '乙', to: '丙' }])
  const after = copy(nodes)
  applyOpsToNodes(after, ops)
  assert.equal(after.length, 3)
  assert.deepEqual(nameSet(after), new Set(['甲', '丙', '终点甲']))
  assert.deepEqual(after.find(n => n.name === '丙')!.pre, ['甲'], '改名后的丙带的是乙的前置')
  assert.deepEqual(after.find(n => n.name === '丙')!.enc, [{ node: '甲', w: 1 }])
})

test('#313 A3：del_node 不再静默摘掉指向它的 pre/enc 入边——断边由门报出并给可执行出路', () => {
  const { nodes, graph } = fixture()
  const r = replayDraft(nodes, graph, [{ op: 'del_node', node: '甲' }])
  assert.equal(r.errors.length, 2, 'pre 断边与 enc 断边各一条')
  const pre = r.errors.find(e => e.startsWith('变更后断边'))!
  assert.match(pre, /乙 -> 甲/)
  assert.match(pre, /被本批删除/)
  assert.match(pre, /set_pre/, '错误行指向真实存在的动作')
  assert.match(r.errors.find(e => e.startsWith('变更后 enc 断边'))!, /乙 ~enc~ 甲/)
  // 显式摘桥（先 set_pre/set_enc 再删）是合法写法——删节点这件事本身照旧允许
  const ok = replayDraft(nodes, graph, [
    { op: 'set_pre', node: '乙', pre: [] },
    { op: 'set_enc', node: '乙', enc: [] },
    { op: 'del_node', node: '甲' },
  ])
  assert.deepEqual(ok.errors, [])
})

test('#313 A2：add_node 的 pre 非列表/含非字符串项一律拒收（不再静默折成零前置）', () => {
  const nonList = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, pre: 前置技能 }\n'))
  assert.ok(nonList.errors!.some(e => e.includes('add_node 的 pre 必须是列表')), nonList.errors!.join('\n'))
  const numbers = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, pre: [1, 2] }\n'))
  assert.ok(numbers.errors!.some(e => e.includes('pre 的每一项都要是非空节点名')), numbers.errors!.join('\n'))
  const empty = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, pre: [] }\n'))
  assert.equal(empty.errors, undefined, '显式零前置是合法形态（根部节点）')
  const absent = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点 }\n'))
  assert.equal(absent.errors, undefined, '省略 pre 与 pre: [] 同义')
})

test('#313 A4：未知键 fail loud——顶层与 op 级各有白名单', () => {
  const top = validateEditProposal(YAML.parse('course: 校验课\nreasn: 打错字\nops:\n  - { op: add_node, name: 新节点, pre: [] }\n'))
  assert.ok(top.errors!.some(e => e.includes('(顶层) 含未知字段') && e.includes('reasn')), top.errors!.join('\n'))
  const op = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, pres: [甲], pre: [] }\n'))
  assert.ok(op.errors!.some(e => e.includes('含未知字段') && e.includes('pres')), op.errors!.join('\n'))
  // 退役键仍走各自那段更准的文案（白名单不吃掉它们的专属指引）
  const retired = validateEditProposal(YAML.parse('course: 校验课\nops:\n  - { op: add_node, name: 新节点, pre: [], origin: 插入 }\n'))
  assert.ok(retired.errors!.some(e => e.includes('不接受这些字段') && e.includes('origin')), retired.errors!.join('\n'))
  // 合法形态不受影响
  const ok = validateEditProposal(YAML.parse('course: 校验课\nreason: r\nconcepts:\n  - canonical: 概念甲\nops:\n  - { op: add_node, name: 新节点, pre: [], teaches: { 概念甲: 会用 } }\n'))
  assert.equal(ok.errors, undefined, ok.errors?.join('\n'))
})

// ---- B5：审计门的明细与受理面 ----

/** 制造一条确定性审计 ERROR：课程目录里多出一份不属任何图节点的笔记（E4）。 */
async function ghostNote(h: Awaited<ReturnType<typeof withVault>>): Promise<void> {
  await writeFile(h.paths.courseNotePath('数学', '幽灵节点'), noteText('幽灵节点') + '\n', 'utf8')
}

const SIDE_BATCH = 'course: 数学\nnote:\n  operator: 旁支\n  reason: 教学消费支线\nops:\n  - op: add_node\n    name: 支线台阶\n    pre: [认识变化率]\n'

test('#313 B5：审计 ERROR 的明细随错随行（apply 拒收不再只指一份模型读不到的报告）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const prop = await h.engine.graph.graphPropose('edit', SIDE_BATCH) as { id: number }
    await ghostNote(h)
    const err = await h.engine.graph.graphApply('edit', prop.id).then(() => null, (e: unknown) => e as Error)
    assert.ok(err, 'apply 被审计门拒绝')
    assert.match(err!.message, /审计门存在 ERROR/)
    assert.match(err!.message, /E4 课程文件对应未知节点/, '明细随行——草稿会话的模型读不到 课程根/审计报告.md')
  })
})

test('#313 B5：审计 ERROR 也进受理门（propose 当场拒，不再「受理通过而 apply 每轮拒」）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    await ghostNote(h)
    await assert.rejects(() => h.engine.graph.graphPropose('edit', SIDE_BATCH), (e: Error) => {
      assert.match(e.message, /审计门拒绝受理/, 'propose 侧同判据（门同源）')
      assert.match(e.message, /E4 课程文件对应未知节点/)
      return true
    })
    // 审计 ERROR 清了就照常受理（门只拦「当前状态不干净」）
    await h.engine.fs.unlink(h.paths.courseNotePath('数学', '幽灵节点'))
    const ok = await h.engine.graph.graphPropose('edit', SIDE_BATCH) as { id: number }
    assert.ok(ok.id > 0)
  })
})

// ---- B2：插入批的复诊预注册写入面 ----

test('#313 B2：note 区跨字段门照旧——插入批缺预注册拒收、非插入批携带拒收', () => {
  const missing = validateEditProposal(YAML.parse('course: 校验课\nnote:\n  operator: 插入\n  reason: r\nops:\n  - { op: add_node, name: 新节点, pre: [] }\n'))
  assert.ok(missing.errors!.some(e => e.includes('插入批必须预注册复诊')), missing.errors!.join('\n'))
  const surplus = validateEditProposal(YAML.parse('course: 校验课\nnote:\n  operator: 前进\n  reason: r\n  recheck: { metric: 前进恢复 }\nops:\n  - { op: add_node, name: 新节点, pre: [] }\n'))
  assert.ok(surplus.errors!.some(e => e.includes('复诊预注册只随插入批携带')), surplus.errors!.join('\n'))
})

type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
/** 脚本化假 agent + 每轮工具回执（`req.messages` 末条 tool 消息）——判据是「模型看到了什么」。 */
function scriptFake(turns: LoopTurn[]): { seam: AgentSeam; receipts: string[] } {
  const queue = [...turns]
  const receipts: string[] = []
  const seam = new AgentSeam({
    logger: memLogger(),
    complete: async () => { throw new Error('脚本化补全端口：不应调用') },
    stream: async req => {
      const last = req.messages.at(-1)
      if (last?.role === 'tool') receipts.push(last.text)
      const next = queue.shift()
      if (!next) throw new Error('脚本化回路端口：脚本已耗尽')
      return { text: next.text, toolCalls: next.toolCalls ?? [] }
    },
  }, systemClock)
  return { seam, receipts }
}

function patchCall(id: string, ops: unknown[], extra: Record<string, unknown> = {}): LoopTurn {
  return { text: '', toolCalls: [{ id, name: 'draft_patch', arguments: JSON.stringify({ ops, ...extra }) }] }
}

const finishCall = (id: string): LoopTurn => ({ text: '', toolCalls: [{ id, name: 'draft_finish', arguments: '{}' }] })

/** 一条插入批的最小合法 ops：起点「认识变化率」与终点「用导数解决优化问题」之间插一级台阶。 */
const INSERT_OPS = [
  { op: 'add_node', name: '平均变化率', pre: ['认识变化率'], est: 15 },
  { op: 'set_pre', node: '用导数解决优化问题', pre: ['平均变化率'] },
]

test('#313 B2：draft_patch 的 note_recheck 是真实写入面——插入批可发布且复诊落账本', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const { seam } = scriptFake([
      patchCall('c1', INSERT_OPS, {
        note_operator: '插入', note_reason: '卡点集中在变化率到导数的跨步',
        note_recheck: { metric: '卡点集中度降幅', days: 5 },
      }),
      finishCall('c2'),
      { text: '本批已发布。' },
    ])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.finished, true, '插入批经执行官站可发布（此前无任何合法写法）')
    const ledger = await readProbationLedger(h.paths, '数学', h.engine.fs)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]!.node, '平均变化率')
    assert.equal(ledger[0]!.due, 5, '复诊期取显式 days')
    assert.deepEqual(ledger[0]!.pre, ['认识变化率'])
    assert.equal(ledger[0]!.outcome, undefined, '在途（未结算）')
  })
})

test('#313 B2：思路官计划的 recheck 兜底——note_recheck 省略也能发布（提示词承诺成立）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const { seam } = scriptFake([
      // 补丁只声明算子与理由：预注册随计划来（提示词交接块原话「插入批落地时随批携带」）
      patchCall('c1', INSERT_OPS, { note_operator: '插入', note_reason: '卡点集中在跨步' }),
      finishCall('c2'),
      { text: '本批已发布。' },
    ])
    const r = await h.engine.growth2.coachDraft('数学', seam, {
      plan: {
        operator: '插入', reason: '卡点集中在跨步', target_endpoints: [], steps: [{ intent: '插入一级台阶' }],
        recheck: { metric: '卡点集中度降幅' },
      },
    })
    assert.equal(r.finished, true)
    const ledger = await readProbationLedger(h.paths, '数学', h.engine.fs)
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0]!.node, '平均变化率')
    assert.equal(ledger[0]!.due, 10, '计划未给 days → 缺省 10 学习日')
  })
})

test('#313 B2：note_recheck 形状不合法当场整批拒收（回灌合法取值域，草稿零增量）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const { seam, receipts } = scriptFake([
      patchCall('c1', INSERT_OPS, {
        note_operator: '插入', note_reason: 'r', note_recheck: { metric: '乱写的 metric' },
      }),
      { text: '收束（本批不成立）。' },
    ])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    assert.equal(r.unpublished_ops, 0, '整批回滚：毒形状不随草稿过夜')
    const receipt = receipts.join('\n---\n')
    assert.match(receipt, /note_recheck 未过/)
    assert.match(receipt, /卡点集中度降幅/, '回灌带合法取值域（模型不必去猜）')
    // 门拒绝也落调试日志（#313 B6：草稿侧此前只活在草稿档的轮志里，人翻日志看不到）
    const gateLog = h.logger.nth('coach.gate.reject')!
    assert.equal(gateLog.fields.gate, 'draft_patch', 'gate = 被拒的工具')
    assert.equal(gateLog.fields.station, '教练执行')
  })
})
