/**
 * 卡点自报闭环（#248 / ADR-0077）：三层只测外部行为——
 * - 纯函数层：频控折叠 / 消费态折叠 / 教练回合注入块（先例 coach-round.test.ts）；
 * - 引擎写点：落账字段、频控 fail loud、节点取值域、与作答投影互不可见
 *   （先例 coach-growth.test.ts 的 withVault seam）；
 * - 宿主编排缝：落账 → force 入队 → 在途合并 → 消费标记 → 异常不丢账
 *   （先例 host-runtime.test.ts 的影子引擎桩）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { stuckReportGate, foldStuckReports, stuckReportInject } from '../src/engine/stuck-report.ts'
import type { StuckConsumptionRec, StuckReportRec } from '../src/engine/types.ts'
import { withVault, noteText } from './helpers/vault.ts'
import { createHostRuntime } from '../src/host/runtime.ts'
import type { HostRuntime } from '../src/host/runtime.ts'
import { handleApi } from '../src/host/api.ts'

// ---------------------------------------------------------------- 纯函数层

const day = (ts: string): string => ts.slice(0, 10)
const priorOf = (recs: StuckReportRec[], cutoff = 0) =>
  recs.map(r => ({ day: day(r.ts), node: r.node }))

const TODAY = '2026-09-14'

const sr = (ts: string, node: string): StuckReportRec => ({
  kind: 'stuck_report', ts, course: '数学', node, text: `卡在${node}`, id: `${ts}|${node}`,
})
const sc = (ts: string, targets: string[]): StuckConsumptionRec => ({
  kind: 'stuck_report_consumed', ts, course: '数学', targets,
})

test('频控：同节点同学习日第二条被拒（带原因），异节点放行', () => {
  const prior = [sr('2026-09-14T09:00:00', '入门')]
  const again = stuckReportGate(priorOf(prior), '入门', TODAY)
  assert.equal(again.ok, false)
  assert.match(again.ok ? '' : again.reason, /上限 1 条/)
  const other = stuckReportGate(priorOf(prior), '进阶', TODAY)
  assert.equal(other.ok, true)
})

test('频控：全课程每日总量触顶后异节点也被拒（带总量原因）；次日归零放行', () => {
  const prior = Array.from({ length: 5 }, (_, i) => sr(`2026-09-14T0${i}:00:00`, `节点${i}`))
  const blocked = stuckReportGate(priorOf(prior), '新节点', TODAY)
  assert.equal(blocked.ok, false)
  assert.match(blocked.ok ? '' : blocked.reason, /总量上限（5 条\/日）/)
  const nextDay = stuckReportGate(priorOf(prior), '新节点', '2026-09-15')
  assert.equal(nextDay.ok, true)
})

test('频控：同节点与总量同时触顶时，同节点理由优先（更具体）', () => {
  const prior = Array.from({ length: 5 }, (_, i) => sr(`2026-09-14T0${i}:00:00`, `节点${i}`))
  prior.push(sr('2026-09-14T10:00:00', '节点0'))
  const r = stuckReportGate(priorOf(prior), '节点0', TODAY)
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /同一节点/)
})

test('消费折叠：同秒两条自报按行 id 各自独立抵消（ts 秒精度不定位到条）', () => {
  const rows = [sr('2026-09-14T09:00:00', '入门'), sr('2026-09-14T09:00:00', '进阶'),
    sc('2026-09-14T09:00:30', ['2026-09-14T09:00:00|入门'])]
  const folded = foldStuckReports(rows)
  assert.equal(folded[0]!.consumed, true)
  assert.equal(folded[1]!.consumed, false, '同秒异节点的另一条不被误抵消')
})

test('消费折叠：未消费缺省；冲正标记 → consumed + consumed_ts；重复冲正取首个', () => {
  const rows = [sr('2026-09-14T09:00:00', '入门'), sr('2026-09-14T10:00:00', '进阶'),
    sc('2026-09-14T12:00:00', ['2026-09-14T09:00:00|入门'])]
  const folded = foldStuckReports(rows)
  assert.equal(folded.length, 2)
  assert.equal(folded[0]!.consumed, true)
  assert.equal(folded[0]!.consumed_ts, '2026-09-14T12:00:00')
  assert.equal(folded[1]!.consumed, false)
  const twice = foldStuckReports([
    sr('2026-09-14T09:00:00', '入门'),
    sc('2026-09-14T12:00:00', ['2026-09-14T09:00:00|入门']),
    sc('2026-09-14T13:00:00', ['2026-09-14T09:00:00|入门']),
  ])
  assert.equal(twice[0]!.consumed_ts, '2026-09-14T12:00:00')
})

test('注入块：待消费逐条一行、原话逐字（仅换行渲染层转义为 ⏎）；已消费不进块；空待消费 = null', () => {
  const rows = [sr('2026-09-14T09:00:00', '入门'), sr('2026-09-14T10:00:00', '进阶'),
    sc('2026-09-14T12:00:00', ['2026-09-14T09:00:00|入门'])]
  const block = stuckReportInject(foldStuckReports(rows))
  assert.ok(block)
  assert.ok(block.includes('【卡点自报'), '头部标注在场')
  assert.ok(block.includes('节点「进阶」：卡在进阶'), '逐字携带原话')
  assert.ok(!block.includes('入门'), '已消费的不进块')
  // 多行原话：逐条一行的清单结构不破（续行转义为可见标记，不与下一条边界混淆）
  const multi = stuckReportInject(foldStuckReports([
    { ...sr('2026-09-14T13:00:00', '入门'), text: '第一节说 A，\n第二节又说 B，对不上' },
  ]))
  assert.ok(multi!.includes('第一节说 A， ⏎ 第二节又说 B，对不上'), '换行转义、原文保真')
  assert.equal(multi!.split('\n').length, 2, '多行原话仍占一行')
  assert.equal(stuckReportInject([]), null)
  assert.equal(stuckReportInject(foldStuckReports([sr('2026-09-14T09:00:00', '入门'),
    sc('2026-09-14T12:00:00', ['2026-09-14T09:00:00|入门'])])), null)
})

// ---------------------------------------------------------------- 引擎写点（withVault seam）

/** 双节点图：频控与在途测试需要第二个节点。 */
const TWO_NODE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 20 }',
].join('\n')

test('引擎落账：原话逐字、course 归一；与作答投影互不可见、零 XP（零激励落地）', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ engine }) => {
    const rec = await engine.growth2.stuckReportAppend('数学', '入门', '  这节的导数和上一节的极限对不上。\n')
    assert.equal(rec.kind, 'stuck_report')
    assert.equal(rec.course, '数学')
    assert.equal(rec.node, '入门')
    assert.equal(rec.text, '这节的导数和上一节的极限对不上。', '原话逐字（trim 除外）')
    // 作答投影看不见卡点行：作答统计/激励/聚合零感知
    const answers = await engine.store.practiceAll()
    assert.equal(answers.length, 0)
    // 激励聚合（streak/热力图数据源）同样零感知：先落一条真作答打底，再报卡点读数不涨
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: '2', correct: true, judge: 'ok' })
    const before = await engine.store.activityCounts()
    await engine.growth2.stuckReportAppend('数学', '进阶', '进阶卡住了')
    const after = await engine.store.activityCounts()
    assert.equal(after['2026-09-14']?.practice, before['2026-09-14']?.practice, '卡点行不进 activityCounts（自报不点亮 streak/热力图）')
    assert.equal((after['2026-09-14']?.practice ?? 0) >= 1, true, '真作答打底确认聚合本身在工作')
    // 卡点投影读得到（入门自报 + 激励聚合检查落的那条）
    assert.equal((await engine.store.stuckStreamAll()).length, 2)
    assert.equal(await engine.growth2.stuckPending('数学').then(r => r.length), 2)
  })
})

test('引擎频控：同节点同日第二条 fail loud 带原因且不落账；图外节点 fail loud', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ engine }) => {
    await engine.growth2.stuckReportAppend('数学', '入门', '第一次')
    await assert.rejects(
      () => engine.growth2.stuckReportAppend('数学', '入门', '第二次'),
      /上限 1 条/,
    )
    assert.equal((await engine.store.stuckStreamAll()).length, 1, '被拒的自报不落账')
    // 异节点可报
    await engine.growth2.stuckReportAppend('数学', '进阶', '进阶卡住了')
    assert.equal((await engine.store.stuckStreamAll()).length, 2)
    // 节点必须在图上
    await assert.rejects(
      () => engine.growth2.stuckReportAppend('数学', '图外', '不存在'),
      /不在课程「数学」的图上/,
    )
  })
})

test('消费标记：幂等——已消费的行 id 再标不计；标完 stuckPending 清空', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ engine }) => {
    const rec = await engine.growth2.stuckReportAppend('数学', '入门', '卡')
    assert.equal(await engine.growth2.stuckMarkConsumed('数学', [rec.id]), 1)
    assert.equal(await engine.growth2.stuckMarkConsumed('数学', [rec.id]), 0, '幂等：重复标记计数 0')
    assert.equal((await engine.growth2.stuckPending('数学')).length, 0)
  })
})

// ---------------------------------------------------------------- 宿主编排缝（影子引擎桩）

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail('等待超时：条件未在时限内成立')
    await sleep(10)
  }
}

function fakeCtx(): Context {
  return {
    tools: { register: () => () => undefined },
    effect: () => undefined,
    webServer: { register: () => undefined },
  } as unknown as Context
}

/** 独立 runtime：与 withVault 同 vault 建第二个引擎实例（宿主侧），vault 生命周期归 withVault。 */
function makeRt(vault: string): HostRuntime {
  return createHostRuntime(fakeCtx(), { vault, centerRel: '学习中心' })
}

function stub(rt: HostRuntime, methods: Record<string, unknown>): void {
  const engine = rt.engine as unknown as Record<string, unknown>
  for (const [k, fn] of Object.entries(methods)) {
    const dot = k.indexOf('.')
    if (dot < 0) { engine[k] = fn; continue } // 裸名：门面实例方法（如 saveGenJobs）
    const sub = engine[k.slice(0, dot)] as Record<string, unknown>
    sub[k.slice(dot + 1)] = fn
  }
}

/** POST /coach/stuck-report 的 handleApi 调用（读体 → 分发 → 捕获响应）。 */
async function postReport(rt: HostRuntime, body: Record<string, unknown>): Promise<{ status: number; doc: Record<string, unknown> }> {
  const req = {
    method: 'POST',
    url: `/learnhub/api/coach/stuck-report`,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  const out = { status: 0, doc: {} as Record<string, unknown> }
  const res = {
    writeHead: (code: number) => { out.status = code },
    end: (data?: unknown) => { out.doc = JSON.parse(String(data)) as Record<string, unknown> },
  }
  await handleApi(rt, fakeCtx(), req as never, res as never)
  return out
}

function stubGrowth(rt: HostRuntime, impl: (course: string, opts: { force?: boolean; inject?: string }) => Promise<unknown>): void {
  stub(rt, {
    'growth2.coachGrowthBatch': (course: string, _agent: unknown, opts: { force?: boolean; inject?: string }) => impl(course, opts),
    'growth2.coachCheckpoint': async () => ({ courses: [] }),
    'growth2.settleRechecks': async () => null,
    saveGenJobs: async () => undefined,
  })
}

const APPLIED = {
  state: 'applied', check: { course: '数学', ready: 0, required: 3, ok: false },
  proposal: { id: 1, ops: 1, operator: '前进', reason: '测试', disagreement: false },
  applied: { ops: 1, snapshot: 2, compass_rewritten: false, created: [] },
  segments: [], trajectory: [],
}

test('宿主编排：落账 → force 回合入队 → 注入合并 → 回执呈现 → 成功消费标记', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ root, engine }) => {
    const rt = makeRt(root)
    const calls: Array<{ force?: boolean; inject?: string }> = []
    stubGrowth(rt, async (_c, opts) => { calls.push(opts); return APPLIED })
    const r = await postReport(rt, { course: '数学', node: '入门', text: '导数和极限对不上' })
    assert.equal(r.status, 200)
    assert.equal(r.doc.recorded, true)
    assert.equal(r.doc.queued, true)
    assert.match(String(r.doc.message), /教练回合已启动/)
    await until(() => rt.jobs.genJobs.get('数学/生长批')?.status === 'done')
    // 消费标记在 done 之后落（回合成功分支尾部）：等可观测信号而非裸状态，避开竞态
    await until(() => (rt.jobs.genJobs.get('数学/生长批')!.message ?? '').includes('已消费卡点自报'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.force, true, '自报触发的回合走 force（绕过就绪深度短路）')
    assert.ok(calls[0]!.inject?.includes('导数和极限对不上'), '自报原话随 inject 进回合')
    assert.ok(calls[0]!.inject!.includes('【卡点自报'), '注入块带标注头')
    // 回合成功 → 消费标记落账；任务消息可观测
    assert.equal((await rt.engine.growth2.stuckPending('数学')).length, 0)
    assert.match(rt.jobs.genJobs.get('数学/生长批')!.message ?? '', /已消费卡点自报 1 条/)
    assert.equal((await engine.store.stuckStreamAll()).filter(x => x.kind === 'stuck_report_consumed').length, 1)
  })
})

test('宿主编排：在途回合期间自报只落账不入队，回合成功只消费起点清单（迟到者留账）', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ root }) => {
    const rt = makeRt(root)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const calls: unknown[] = []
    stubGrowth(rt, async () => { calls.push(1); await gate; return APPLIED })
    const r1 = await postReport(rt, { course: '数学', node: '入门', text: '第一报' })
    assert.equal(r1.doc.queued, true)
    await until(() => rt.jobs.genJobs.get('数学/生长批')?.status === 'running')
    await until(() => calls.length === 1, 5000) // stub 已进入 → 起点清单读取已定型，r2 落在后
    const r2 = await postReport(rt, { course: '数学', node: '进阶', text: '第二报' })
    assert.equal(r2.status, 200)
    assert.equal(r2.doc.recorded, true)
    assert.equal(r2.doc.queued, false, '在途不重复入队')
    assert.match(String(r2.doc.message), /在途/)
    release()
    await until(() => rt.jobs.genJobs.get('数学/生长批')?.status === 'done')
    // 消费标记在 done 之后落：等可观测信号（起点第一报被消费）再断言迟到者留账
    await until(() => (rt.jobs.genJobs.get('数学/生长批')!.message ?? '').includes('已消费卡点自报'))
    // 起点清单（第一报）已消费；执行期间落账的第二报留给下一次回合
    const pending = await rt.engine.growth2.stuckPending('数学')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.text, '第二报')
  })
})

test('宿主编排：回合异常 → 任务 failed，自报留账不丢（下次回合消费）', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ root }) => {
    const rt = makeRt(root)
    stubGrowth(rt, async () => { throw new Error('[coach-growth] 受理门拒收') })
    const r = await postReport(rt, { course: '数学', node: '入门', text: '卡住了' })
    assert.equal(r.status, 200, '落账与入队成功即回执；回合异常在队列侧显形')
    assert.equal(r.doc.queued, true)
    await until(() => rt.jobs.genJobs.get('数学/生长批')?.status === 'failed')
    const pending = await rt.engine.growth2.stuckPending('数学')
    assert.equal(pending.length, 1, '异常不丢账')
    assert.equal(pending[0]!.text, '卡住了')
  })
})

test('宿主编排：频控拒绝 → 500 带原因，不落账不触发', async () => {
  await withVault({ graph: TWO_NODE_GRAPH, notes: { 入门: noteText('入门'), 进阶: noteText('进阶') } }, async ({ root }) => {
    const rt = makeRt(root)
    const calls: unknown[] = []
    stubGrowth(rt, async () => { calls.push(1); return APPLIED })
    await postReport(rt, { course: '数学', node: '入门', text: '第一报' })
    const r2 = await postReport(rt, { course: '数学', node: '入门', text: '第二报' })
    assert.equal(r2.status, 500)
    assert.match(String(r2.doc.error), /上限 1 条/)
    assert.equal(calls.length, 1, '被频控拒绝的自报不触发回合')
  })
})
