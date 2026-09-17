import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Graph } from '../src/engine/graph/graph.ts'
import { GrowthSubsystem } from '../src/engine/coach/growth-subsystem.ts'
import { normalizePatchShape, sealedDecisionOf } from '../src/engine/index.ts'
import { selfContradictionErrors } from '../src/engine/coach/proposals.ts'
import { structureReadingsOf, foldCompletion, readAnchors } from '../src/engine/coach/seed.ts'
import type { EndpointAnchor } from '../src/engine/coach/seed.ts'
import { GROWTH_DRAFT_MARKER } from '../src/engine/coach/growth-draft.ts'
import type { EditOp } from '../src/engine/coach/proposals.ts'
import type { ConceptEntry, GNode, Fm } from '../src/engine/types.ts'
import { AgentSeam } from '../src/engine/infra/agent.ts'
import { systemClock } from '../src/host/clock.ts'
import { withVault } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import { memLogger } from './helpers/logger.ts'

// #315 生长链路止血（B1 已学读数 / B2 收尾前置 / B3 形状前移与单概念归属 /
// B5 结构读数同源 / B6 僵尸草稿 / B7 节点概念自相矛盾；B4 空草稿文案在站级用例）：
// 判据逐条对应票面验收——测试钉住「就绪未开始不计已学」「闭包未真已学不落 sealed」等。

function fm(stage: Fm['stage']): Fm {
  return { node: 'x', stage, fsrs: null, content: { version: 0, generated_at: null, sections: [] } } as unknown as Fm
}

/** 三节点图：甲 → 乙 → 终点；锚 = 终点。 */
function chainFixture(): { nodes: GNode[]; graph: Graph; anchors: EndpointAnchor[] } {
  const nodes: GNode[] = [
    { name: '甲', pre: [], opt: false, note: '', enc: [] },
    { name: '乙', pre: ['甲'], opt: false, note: '', enc: [] },
    { name: '终点', pre: ['乙'], opt: false, note: '', enc: [] },
  ]
  return {
    nodes, graph: new Graph(nodes),
    anchors: [{ endpoint: '终点', goal_type: 'capability', declared: '2026-09-17', worksheet: [], seed_nodes: [], start_basis: {} }],
  }
}

// ---- B1：「已学」读数 —— ready/unseen 不计，skipped 计入（人裁口径） ----

test('#315 B1：闭包「已学」读数——就绪未开始（ready/unseen）不计入，skipped 计入', () => {
  const { graph, anchors } = chainFixture()
  const readyAndSkipped = foldCompletion(graph, { 甲: fm('ready'), 乙: fm('skipped') }, anchors)
  assert.deepEqual(readyAndSkipped[0]!.closure, { learned: 1, total: 2 },
    'ready 是就绪未开始不计；skipped（用户已有基础跳过）计入')
  const started = foldCompletion(graph, { 甲: fm('learning'), 乙: fm('mastered') }, anchors)
  assert.deepEqual(started[0]!.closure, { learned: 2, total: 2 })
  const nothing = foldCompletion(graph, { 甲: fm('unseen'), 乙: fm('ready') }, anchors)
  assert.deepEqual(nothing[0]!.closure, { learned: 0, total: 2 },
    '图面「未开始·待生成」的节点不再被算成已学（B1 假读数）')
})

// ---- B2：sealed 收尾前置「闭包真已学」，不满足降级为普通接线批 ----

test('#315 B2：sealedDecisionOf——闭包未真已学不落 sealed（降级接线批），学完照常 seal', () => {
  const { anchors } = chainFixture()
  const sealBatch: EditOp[] = [{ op: 'set_pre', node: '终点', pre: ['乙'] }]
  const learned = sealedDecisionOf(sealBatch, anchors, ep => ep === '终点'
    ? { total: 2, unlearned: [] }
    : { total: 0, unlearned: [ep] })
  assert.equal(learned.sealing, true)
  assert.deepEqual(learned.effects, [{ endpoint: '终点', action: 'seal' }])
  assert.deepEqual(learned.downgraded, undefined)

  const notLearned = sealedDecisionOf(sealBatch, anchors, () => ({ total: 2, unlearned: ['甲'] }))
  assert.equal(notLearned.sealing, false, '收尾前置不满足 = 不构成收尾宣告')
  assert.deepEqual(notLearned.effects, [], '不落 sealed——接线照做（wired 仍在），只是降级')
  assert.deepEqual(notLearned.downgraded, ['终点'])
  assert.deepEqual(notLearned.wired, ['终点'])

  // 逐终点独立：两个终点，一个已学一个未学
  const twoAnchors = [...anchors, { endpoint: '终点2', goal_type: 'capability' as const, declared: '2026-09-17', worksheet: [], seed_nodes: [], start_basis: {} }]
  const mixed = sealedDecisionOf([
    { op: 'set_pre', node: '终点', pre: ['乙'] },
    { op: 'set_pre', node: '终点2', pre: ['乙'] },
  ], twoAnchors, ep => ep === '终点' ? { total: 1, unlearned: [] } : { total: 1, unlearned: ['甲'] })
  assert.deepEqual(mixed.effects, [{ endpoint: '终点', action: 'seal' }], '已学的终点照常落 sealed')
  assert.deepEqual(mixed.downgraded, ['终点2'])

  // 主线批（含 add_node 接线）语义不动：reopen 照旧
  const reopen = sealedDecisionOf([
    { op: 'add_node', name: '丁', pre: [] },
    { op: 'set_pre', node: '终点', pre: ['丁'] },
  ], anchors, () => ({ total: 0, unlearned: [] }))
  assert.deepEqual(reopen.effects, [{ endpoint: '终点', action: 'reopen' }])

  // 不传读数 = 纯结构判据（旧调用方/存量测试不受影响）
  const legacy = sealedDecisionOf(sealBatch, anchors)
  assert.equal(legacy.sealing, true)
})

// ---- B3①：misconceptions 裸字符串列表在单一 teaches 概念下确定性归属 ----

test('#315 B3：单一 teaches 概念时裸字符串误解列表归一归属；多概念仍拒收', () => {
  const single = normalizePatchShape([
    { op: 'add_node', name: '丁', pre: [], teaches: { 变化率: '会用' }, misconceptions: ['以为变化率就是导数', '以为变化率恒为正'] },
  ], undefined)
  assert.deepEqual(single.errors, [])
  assert.ok(single.normalized.some(s => s.includes('唯一 teaches 概念「变化率」')))
  const node = single.ops[0] as { misconceptions?: Array<{ concept: string; model: string }> }
  assert.deepEqual(node.misconceptions, [
    { concept: '变化率', model: '以为变化率就是导数' },
    { concept: '变化率', model: '以为变化率恒为正' },
  ])

  const multi = normalizePatchShape([
    { op: 'add_node', name: '丁', pre: [], teaches: { 甲概念: '会用', 乙概念: '知道' }, misconceptions: ['拆不出'] },
  ], undefined)
  assert.ok(multi.errors.some(e => e.includes('字符串列表')), '多概念时真拆不出——照旧拒收回灌速查')

  const noTeaches = normalizePatchShape([
    { op: 'add_node', name: '丁', pre: [], misconceptions: ['无 teaches 不归属'] },
  ], undefined)
  assert.ok(noTeaches.errors.some(e => e.includes('字符串列表')), '无 teaches 不猜归属')
})

test('#315 B3：draft_patch 工具 schema 的 ops 描述带合法形态速查（第一次调用前即可见）', () => {
  const specs = GrowthSubsystem.draftToolSpecs()
  const patch = specs.find(s => s.name === 'draft_patch')!
  const desc = JSON.stringify(patch)
  assert.ok(desc.includes('合法形态速查'), '速查进工具描述')
  for (const piece of ['teaches / assumes', 'misconceptions', 'concepts（铸名）']) {
    assert.ok(desc.includes(piece), `速查四件套含 ${piece}`)
  }
})

// ---- B5：结构读数（两站「是否还需生长」同源谓词） ----

test('#315 B5：structureReadingsOf——complete = sealed ∧ 闭包真已学；悬空锚不入算', () => {
  const { graph, anchors } = chainFixture()
  const unsealed = structureReadingsOf(graph, { 甲: fm('learning'), 乙: fm('mastered') }, anchors)
  assert.deepEqual(unsealed, [{ endpoint: '终点', sealed: false, learned: 2, total: 2, unlearned: [], complete: false }])
  const sealedNotLearned = structureReadingsOf(graph, { 甲: fm('ready'), 乙: fm('ready') }, [
    { ...anchors[0]!, sealed: '2026-09-17' },
  ])
  assert.deepEqual(sealedNotLearned[0]!.complete, false, 'sealed 但闭包有未学 = 结构未铺完')
  assert.deepEqual(sealedNotLearned[0]!.unlearned, ['乙', '甲'], '未学名单升序（unicode 序）')
  const done = structureReadingsOf(graph, { 甲: fm('skipped'), 乙: fm('review') }, [
    { ...anchors[0]!, sealed: '2026-09-17' },
  ])
  assert.deepEqual(done[0]!.complete, true)
  // 悬空锚不入算
  const dangling = structureReadingsOf(new Graph([]), {}, anchors)
  assert.deepEqual(dangling, [])
})

test('#315 B5：同一图面下两站上下文包的结构读数逐字一致（对照测试）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const extract = (pack: string): string[] =>
      pack.split('\n').filter(l => l.includes('结构读数：'))
    const planner = await h.engine.growth2.coachContextPack('数学', { packLabel: '思路官——方向裁决' })
    const executor = await h.engine.growth2.coachContextPack('数学', { packLabel: '执行官——草稿会话上下文' })
    const plannerLines = extract(planner)
    // CAPABILITY_DRAFT 两条锚：手加「导数方向」（空闭包）与起草「用导数解决优化问题」
    assert.ok(plannerLines.some(l => l.includes('闭包真已学 0/0｜结构未铺完')))
    assert.ok(plannerLines.some(l => l.includes('闭包真已学 0/1（未学：认识变化率）｜结构未铺完')))
    assert.deepEqual(extract(executor), plannerLines, '两站引用同一谓词，读数逐字一致')
  })
})

// ---- B7：同一节点 teaches 与 assumes 同一概念 → 门拒 ----

test('#315 B7：teaches 与 assumes 同概念（含别名归一）拒收；不同概念放行', () => {
  const entries: ConceptEntry[] = [{ canonical: '变化率', aliases: ['rate of change'] }]
  const contradiction = selfContradictionErrors([
    { op: 'add_node', name: '丁', pre: [], teaches: { 变化率: '能教' }, assumes: { 变化率: '会用' } },
  ], entries)
  assert.equal(contradiction.length, 1)
  assert.match(contradiction[0]!, /teaches 与 assumes 同一概念「变化率」/)
  const viaAlias = selfContradictionErrors([
    { op: 'add_node', name: '丁', pre: [], teaches: { 变化率: '能教' }, assumes: { 'rate of change': '会用' } },
  ], entries)
  assert.equal(viaAlias.length, 1, '别名写法按 canonical 归一后同样命中')
  const spiral = selfContradictionErrors([
    { op: 'add_node', name: '丁', pre: [], teaches: { 变化率: '能教' }, assumes: { 别的概念: '会用' } },
  ], entries)
  assert.deepEqual(spiral, [], '假设别的概念 = 合法，螺旋升档只 teaches 高档不 assumes 同概念')
})

// ---- B4 + B6：空草稿 audit 文案（非门错误）+ 僵尸草稿清场（站级） ----

type LoopTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
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

async function seedDraft(h: Awaited<ReturnType<typeof withVault>>, doc: Record<string, unknown>): Promise<void> {
  const dir = `${h.paths.courseStateDir('数学')}/草稿`
  await h.engine.fs.mkdir(dir)
  await h.engine.fs.writeFile(join(dir, `${String(doc.session_id)}.json`), JSON.stringify({
    marker: GROWTH_DRAFT_MARKER, version: 1, course: '数学', published: 0, concepts: [],
    created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z',
    ...doc,
  }))
}

test('#315 B4+B6：空草稿 audit 回「无事可做」不报门错误；收场即清场不留下僵尸草稿', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    await seedDraft(h, {
      session_id: 'draft-zombie',
      ops: [],
      rounds: [
        { at: '2026-09-17T00:00:00.000Z', kind: 'audit', summary: '审计：1 个门错误', errors: ['ops: 提案没有操作条目'] },
      ],
    })
    const { seam, receipts } = receiptFake([[
      { text: '', toolCalls: [{ id: 'a1', name: 'draft_audit', arguments: '{}' }] },
      { text: '明白了，无事可做，收束。' },
    ]])
    const r = await h.engine.growth2.coachDraft('数学', seam)
    const fed = receipts.join('\n')
    assert.match(fed, /没有未发布增量——本会话无事可做/, '空草稿给收束指引，不是门错误')
    assert.match(fed, /可直接收束/)
    assert.equal(fed.includes('提案没有操作条目'), false, '不再报「ops: 提案没有操作条目」的门错误')
    assert.equal(r.finished, false)
    const dir = `${h.paths.courseStateDir('数学')}/草稿`
    assert.equal(existsSync(dir) && readdirSync(dir).length > 0, false, '收场即清场——僵尸草稿不残留、下次生长不续建')
  })
})

// ---- B2 apply 侧：收尾接线批落盘口径（闭包未真已学 → 锚上不落 sealed） ----

test('#315 B2 apply 主形态：空 pre 终点接线未学坡道，收尾批降级不落 sealed（接线后闭包参与判定）', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, CAPABILITY_DRAFT)
    const anchorPath = h.paths.anchorPath('数学')
    const readSealed = async (): Promise<string | undefined> => (await readAnchors(anchorPath, h.engine.fs)).find(a => a.endpoint === '导数方向')?.sealed
    assert.equal(await readSealed(), undefined)
    // 手加终点「导数方向」pre 为空：本批把终点接到唯一未学节点「认识变化率」（ready）——
    // 降级判定必须看**接线后**的闭包（用接线前旧图会读到空闭包而漏降级）。
    const prop = await h.engine.graph.graphPropose('edit', `course: 数学
note:
  operator: 前进
  reason: 终点坡道收尾接线
ops:
  - op: set_pre
    node: 导数方向
    pre: [认识变化率]
`) as { id: number }
    await h.engine.graph.graphApply('edit', prop.id)
    assert.equal(await readSealed(), undefined, '新接入的前置未学——不落 sealed（B2 降级在主形态生效）')
  })
})

test('#315 B2 apply：闭包未真已学时收尾批降级（锚不落 sealed）；学完后同类批照常落', async () => {
  await withVault({ registry: null, graph: null }, async h => {
    await draftCourse(h.engine, { ...CAPABILITY_DRAFT, notes: { 认识变化率: { stage: 'ready' } } })
    const anchorPath = h.paths.anchorPath('数学')
    const readSealed = async (): Promise<string | undefined> => (await readAnchors(anchorPath, h.engine.fs)).find(a => a.endpoint === '用导数解决优化问题')?.sealed
    assert.equal(await readSealed(), undefined)
    const sealBatch = () => `course: 数学
note:
  operator: 前进
  reason: 终点坡道收尾接线
ops:
  - op: set_pre
    node: 用导数解决优化问题
    pre: [认识变化率]
`
    const first = await h.engine.graph.graphPropose('edit', sealBatch()) as { id: number }
    await h.engine.graph.graphApply('edit', first.id)
    assert.equal(await readSealed(), undefined, '闭包「认识变化率」还是 ready（未开始）——不落 sealed')

    // 学完（skipped 计入已学）后同类收尾批照常落 sealed
    const note = readFileSync(join(h.paths.courseNotePath('数学', '认识变化率')), 'utf8')
      .replace('stage: ready', 'stage: skipped')
    await h.engine.fs.writeFile(h.paths.courseNotePath('数学', '认识变化率'), note)
    const second = await h.engine.graph.graphPropose('edit', sealBatch()) as { id: number }
    await h.engine.graph.graphApply('edit', second.id)
    assert.ok(await readSealed(), '闭包真已学后，收尾宣告照常落锚')
  })
})
