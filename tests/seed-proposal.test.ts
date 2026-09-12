import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Graph, GraphStore } from '../src/engine/graph.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { todayStr } from '../src/engine/dates.ts'
import { systemClock } from '../src/host/clock.ts'
import { validateSeedProposal, seedNodeToGNode, readAnchor, foldCompletion } from '../src/engine/seed.ts'
import { runAudit } from '../src/engine/audit.ts'
import { dataCheck } from '../src/engine/data-check.ts'
import { withVault } from './helpers/vault.ts'

// 种子提案 + 终点锚 + 完成宣告 + 先验喂料分流（#142 / ADR-0033 生长式图）：
// kind=seed 是课程唯一新入口——1–3 起点 + 终点 + 朝终点的粗占位边，
// 一次人审即开工；apply 落终点锚（state/终点锚.json：终点+目标类型+声明日期）；
// 完成 = 读侧宣告（零写侧状态）；换终点只走重新种子提案，锚无直改通道；
// vault 链接先验 ≥0.7 喂料分流（未回应可见，零先验 Missing 非 Broken）。

/** 未播种 vault：无注册表（mode=new 要求课程未注册，引擎建课脚手架负责落盘）。 */
const SEED_VAULT = { registry: null, graph: null }

const CAPABILITY_SEED = `course: 数学
mode: new
reason: 常识基线起步的能力锚定课程
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
`

const COVERAGE_SEED = `course: 数学
mode: new
goal_type: coverage
reason: 备考大纲清单式课程
endpoint:
  name: 大纲综合
  region: 基础
  block: 终点块
starts:
  - name: 大纲起步
    region: 基础
    block: 起点块
worksheet:
  - block: 极限与连续
    note: 大纲第 1 章
  - block: 微分中值定理
`

test('validateSeedProposal：schema 负路径（est/enc 拒收、上限、工作表互斥、重名）', () => {
  const node = { name: 'A', region: '区', block: '块' }
  // est/enc 是种子节点的禁区（零 enc 零 est；占位边由引擎落）
  const v1 = validateSeedProposal({ course: '数学', mode: 'new', endpoint: { ...node, est: 20 }, starts: [node] })
  assert.ok(v1.errors?.some(e => e.includes('零 enc 零 est')), 'est/enc 字段拒收并指向纪律')
  // 起点超过 3 个
  const v2 = validateSeedProposal({
    course: '数学', mode: 'new',
    endpoint: node,
    starts: [
      { name: 'S1', region: '区', block: '块' }, { name: 'S2', region: '区', block: '块' },
      { name: 'S3', region: '区', block: '块' }, { name: 'S4', region: '区', block: '块' },
    ],
  })
  assert.ok(v2.errors?.some(e => e.includes('上限 3')), '起点 1–3 条')
  // capability + worksheet 拒收；coverage 无 worksheet 拒收
  const v3 = validateSeedProposal({ course: '数学', mode: 'new', endpoint: node, starts: [node], worksheet: [{ block: 'B' }] })
  assert.ok(v3.errors?.some(e => e.includes('能力锚定课程不带块工作表')))
  const v4 = validateSeedProposal({ course: '数学', mode: 'new', goal_type: 'coverage', endpoint: node, starts: [node] })
  assert.ok(v4.errors?.some(e => e.includes('覆盖锚定（goal_type=coverage）必须携带块工作表')))
  // 起点/终点重名
  const v5 = validateSeedProposal({ course: '数学', mode: 'new', endpoint: node, starts: [{ ...node }] })
  assert.ok(v5.errors?.some(e => e.includes('种子节点重名')))
  // mode 必填
  const v6 = validateSeedProposal({ course: '数学', endpoint: node, starts: [node] })
  assert.ok(v6.errors?.some(e => e.includes('mode: 缺失或非法')))
})

test('AC1 种子全链：受理→人审→apply 落终点锚+目标类型，占位边可被生长批消费', async () => {
  await withVault(SEED_VAULT, async ({ engine, root, paths }) => {
    const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as {
      id: number; kind: string; goal_type: string; endpoint: string; starts: number; prior_feed_unresponded: number
    }
    assert.equal(r.kind, 'seed')
    assert.equal(r.goal_type, 'capability', 'goal_type 缺省 = capability 能力锚定')
    assert.equal(r.starts, 1)
    assert.equal(r.prior_feed_unresponded, 0, '零先验路径全绿（无缓存 = Missing 非 Broken）')

    // 人审入口：pending 提案可见
    const pending = await engine.graph.graphProposals('pending', 'seed')
    assert.equal(pending.length, 1)

    const applied = await engine.graph.graphApply('seed', r.id) as {
      course: string; endpoint: string; starts: string[]; declared: string; snapshot: number; findings: string[]
    }
    assert.equal(applied.endpoint, '用导数解决优化问题')
    assert.deepEqual(applied.starts, ['认识变化率'])
    assert.ok(applied.declared, '声明日期落盘')
    assert.ok(!applied.findings.some(f => f.includes('健康分')), '种子图健康分不设阈值（findings 无 <80 提示）')

    // 注册表 + 课程脚手架（mode=new 建课）
    const registry = await readFile(join(root, '学习中心', '课程注册表.yaml'), 'utf8')
    assert.match(registry, /name: 数学/)
    // 图落盘：起点 + 终点 + 朝终点的粗占位边（终点.pre = 起点）
    const dataYaml = await readFile(join(root, '学习中心', '数学', 'data', '00_基础.yaml'), 'utf8')
    assert.match(dataYaml, /name: 认识变化率/)
    assert.match(dataYaml, /name: 用导数解决优化问题/)
    assert.match(dataYaml, /pre:[\s\S]*认识变化率/)
    // 种子节点零 enc 零 est
    assert.doesNotMatch(dataYaml, /est:/)
    assert.doesNotMatch(dataYaml, /enc:/)
    // 终点锚：终点 + 目标类型 + 声明日期 + 来源提案
    const anchor = await readAnchor(paths.anchorPath('数学'), nodeVaultFs)
    assert.ok(anchor)
    assert.equal(anchor!.endpoint, '用导数解决优化问题')
    assert.equal(anchor!.goal_type, 'capability')
    assert.equal(anchor!.declared, applied.declared)
    assert.equal(anchor!.origin_proposal, r.id)
    assert.deepEqual(anchor!.seed_nodes, ['认识变化率', '用导数解决优化问题'])
    // journal + 快照
    const journal = await readFile(join(root, '学习中心', 'state', 'journal.jsonl'), 'utf8')
    assert.match(journal, /graph_seed/)
    const snapshot = await readFile(join(root, '学习中心', 'state', 'snapshots', '数学-v1.json'), 'utf8')
    assert.ok(snapshot.includes('认识变化率'))

    // 占位边可被生长批消费：edit 提案细化终点前置（补中间节点+重接 pre）
    const growth = `course: 数学
reason: 生长批细化占位边
ops:
  - op: add_node
    name: 求解一阶导数
    region: 基础
    block: 中间块
    pre: [认识变化率]
    est: 20
  - op: set_pre
    node: 用导数解决优化问题
    pre: [求解一阶导数]
`
    const gr = await engine.graph.graphPropose('edit', growth) as { id: number }
    await engine.graph.graphApply('edit', gr.id)
    const store = new GraphStore(paths, paths.courseRoot('数学'), nodeVaultFs)
    const grown = await store.load()
    const endpoint = grown.flatMap(rg => rg.blocks.flatMap(b => b.nodes)).find(n => n.name === '用导数解决优化问题')!
    assert.deepEqual(endpoint.pre, ['求解一阶导数'], '生长批已消化粗占位边')
    // 图已生长（≠ 种子节点全集）→ 形状告警恢复：R1 浅叶子重新可见
    const auditAfter = await runAudit(paths, '数学', '数学', new Graph(grown), grown, todayStr(new Date()), nodeVaultFs)
    assert.ok(!auditAfter.failed)
    assert.ok(auditAfter.warns.some(w => w.startsWith('R1')), '生长后形状告警恢复（豁免翻转）')
  })
})

test('AC2 覆盖锚定带块工作表；能力锚定带工作表受理被拒；种子审计豁免生效', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    // capability + worksheet → 受理门拒收
    await assert.rejects(
      () => engine.graph.graphPropose('seed', CAPABILITY_SEED + 'worksheet:\n  - block: 多余清单\n'),
      /能力锚定课程不带块工作表/,
    )
    // coverage 全链
    const r = await engine.graph.graphPropose('seed', COVERAGE_SEED) as { id: number; worksheet?: number }
    assert.equal(r.worksheet, 2)
    await engine.graph.graphApply('seed', r.id)
    const anchor = await readAnchor(paths.anchorPath('数学'), nodeVaultFs)
    assert.equal(anchor!.goal_type, 'coverage')
    assert.equal(anchor!.worksheet.length, 2)
    assert.equal(anchor!.worksheet[0]!.block, '极限与连续')
    assert.equal(anchor!.worksheet[0]!.done, false)

    // 种子审计豁免：种子图（= 锚的种子节点全集）无 R1/R8/R13 形状告警 + 豁免 INFO 行
    const regions = await new GraphStore(paths, paths.courseRoot('数学'), nodeVaultFs).load()
    const graph = new Graph(regions)
    const audit = await runAudit(paths, '数学', '数学', graph, regions, todayStr(new Date()), nodeVaultFs)
    assert.ok(!audit.failed)
    assert.ok(!audit.warns.some(w => w.startsWith('R1') || w.startsWith('R8') || w.startsWith('R13')), '形状告警豁免')
    assert.ok(audit.infos.some(w => w.includes('种子图豁免生效')), '豁免显式可见不静默')
    assert.match(String(audit.baseline['终点锚']), /大纲综合（覆盖锚定/)
    // analyze 同源豁免：missing_pre 清空 + seed_phase 标记
    const doc = await engine.graph.graphAnalyze('数学') as { suggestions: { missing_pre: string[]; seed_phase?: boolean } }
    assert.equal(doc.suggestions.missing_pre.length, 0)
    assert.equal(doc.suggestions.seed_phase, true)
  })
})

test('AC3 完成判据读侧折叠：达标/不达标各一，宣告零写副作用；换终点只走种子提案、锚直改被拒', async () => {
  await withVault(SEED_VAULT, async ({ engine, root, paths }) => {
    const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
    await engine.graph.graphApply('seed', r.id)

    // 不达标：终点未学（mastery 0）→ complete=false
    const before = await engine.courseCompletion({ name: '数学', root: '数学' })
    assert.ok(before)
    assert.equal(before!.goal_type, 'capability')
    assert.equal(before!.complete, false)
    assert.equal(before!.criteria.endpoint_mastery, 0)

    // 达标：终点 mastery ≥ 0.8（稳定度饱和 + 高练习证据）且闭包健康
    const notePath = paths.courseNotePath('数学', '基础', '用导数解决优化问题')
    await writeFile(notePath, `---
node: 用导数解决优化问题
stage: mastered
fsrs:
  stability: 60
  difficulty: 5
  due: 2026-09-10
  last_review: 2026-09-09
  reps: 12
  lapses: 0
practice:
  attempts: 10
  correct: 10
practice_ema: 0.95
content:
  version: 1
  generated_at: 2026-09-09T00:00:00.000Z
  status: reviewed
---
# 用导数解决优化问题
`, 'utf8')
    const after = await engine.courseCompletion({ name: '数学', root: '数学' })
    assert.equal(after!.criteria.mastery_met, true)
    assert.equal(after!.criteria.closure_healthy, true, '闭包健康（无重名/断边/环/enc 违约）')
    assert.equal(after!.complete, true, '读侧宣告：终点掌握 + 闭包健康 = 完成')

    // 面板宣告（status 折叠）且零写副作用：折叠前后锚文件与 journal 字节不变
    const anchorPath = paths.anchorPath('数学')
    const anchorBefore = await readFile(anchorPath, 'utf8')
    const journalPath = join(root, '学习中心', 'state', 'journal.jsonl')
    const journalBefore = await readFile(journalPath, 'utf8')
    const status = await engine.statusJson() as { courses: Array<{ name: string; completion?: { complete: boolean } }> }
    assert.equal(status.courses.find(c => c.name === '数学')?.completion?.complete, true, 'status 携带完成宣告')
    assert.equal(await readFile(anchorPath, 'utf8'), anchorBefore, '锚文件零写副作用')
    assert.equal(await readFile(journalPath, 'utf8'), journalBefore, 'journal 零写副作用')

    // 锚直改被拒：edit 提案 del/rename 终点节点 → 受理门拒绝并指路种子提案
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
ops:
  - op: del_node
    node: 用导数解决优化问题
`), /del_node 拒绝[\s\S]*换终点走重新种子提案/,
    )
    await assert.rejects(
      () => engine.graph.graphPropose('edit', `course: 数学
ops:
  - op: rename
    node: 用导数解决优化问题
    new: 换个名字
`), /rename 拒绝[\s\S]*换终点走重新种子提案/,
    )

    // 换终点只走种子提案通道：mode=reseed 人审后 apply → 锚整份覆盖
    const reseed = `course: 数学
mode: reseed
endpoint:
  name: 证明微积分基本定理
  region: 基础
  block: 新终点块
starts:
  - name: 直观理解积分
    region: 基础
    block: 起点块
    basis: vault
`
    const r2 = await engine.graph.graphPropose('seed', reseed) as { id: number; mode: string }
    assert.equal(r2.mode, 'reseed')
    await engine.graph.graphApply('seed', r2.id)
    const anchor2 = await readAnchor(paths.anchorPath('数学'), nodeVaultFs)
    assert.equal(anchor2!.endpoint, '证明微积分基本定理')
    assert.equal(anchor2!.origin_proposal, r2.id)
    assert.equal(anchor2!.start_basis['直观理解积分'], 'vault')
    // 换锚后旧终点不再受保护（coach 换向算子可消化）
    const unguard = await engine.graph.graphPropose('edit', `course: 数学
ops:
  - op: set_note
    node: 用导数解决优化问题
    note: 旧终点，已被换向消化
`) as { id: number }
    assert.ok(unguard.id)
    // 新锚的终点在图内
    assert.ok((await engine.courseCompletion({ name: '数学', root: '数学' }))!.criteria.endpoint_in_graph)
  })
})

test('AC4 先验喂料分流：≥0.7 未回应进 warns+审计可见；已回应不告警；零先验全绿', async () => {
  await withVault(SEED_VAULT, async ({ engine, root, paths }) => {
    // vault 链接先验缓存：一对落在两个起点之间（种子结构不回应）、一对落在起点→终点（占位边回应）
    const stateDir = join(root, '学习中心', 'state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vault链接.json'), JSON.stringify({
      version: 1,
      generated_at: '2026-09-10T00:00:00.000Z',
      scanned_files: 2,
      truncated: false,
      links_seen: 3,
      edges: [
        { a: 'notes/认识变化率.md', b: 'notes/直观理解积分.md', count: 5, files: 3, sources: ['notes/x.md'], bidirectional: true, w: 1.0 },
        { a: 'notes/认识变化率.md', b: 'notes/用导数解决优化问题.md', count: 5, files: 3, sources: ['notes/y.md'], bidirectional: true, w: 0.9 },
      ],
      unresolved: 0,
      audit: { embed: 0, non_md: 0, date_target: 0, self_link: 0, ambiguous_basenames: 0 },
      fingerprints: {},
    }), 'utf8')

    // 第二个起点：让「认识变化率 ~ 直观理解积分」这对 ≥0.7 候选没有结构回应
    const yamlText = CAPABILITY_SEED.replace(
      'starts:\n',
      'starts:\n  - name: 直观理解积分\n    region: 基础\n    block: 起点块\n',
    )
    const r = await engine.graph.graphPropose('seed', yamlText) as { id: number; prior_feed_unresponded: number; warns?: string[] }
    assert.equal(r.prior_feed_unresponded, 1, '一对 ≥0.7 候选未被结构回应')
    assert.ok(r.warns?.some(w => w.includes('≥0.7 先验候选未被结构回应') && w.includes('认识变化率 ~ 直观理解积分')), '喂料分流可见非阻')
    assert.ok(!r.warns?.some(w => w.includes('认识变化率 ~ 用导数解决优化问题')), '占位边已回应的候选不告警')

    await engine.graph.graphApply('seed', r.id)
    // 审计可见：R17 WARN 落在持久图审计上
    const regions = await new GraphStore(paths, paths.courseRoot('数学'), nodeVaultFs).load()
    const graph = new Graph(regions)
    const audit = await runAudit(paths, '数学', '数学', graph, regions, todayStr(new Date()), nodeVaultFs)
    assert.ok(audit.warns.some(w => w.startsWith('R17') && w.includes('认识变化率 ~ 直观理解积分')), '审计 R17 可见')
    assert.ok(!audit.warns.some(w => w.includes('认识变化率 ~ 用导数解决优化问题')))

    // 零先验（缓存移除 = Missing）：受理回执与审计全绿，不判 Broken
    await rm(join(stateDir, 'vault链接.json'))
    const r2 = await engine.graph.graphPropose('seed', `course: 数学
mode: reseed
endpoint:
  name: 大纲综合二
  region: 基础
  block: 终点块二
starts:
  - name: 大纲起步二
    region: 基础
    block: 起点块二
`) as { id: number; prior_feed_unresponded: number; warns?: string[] }
    assert.equal(r2.prior_feed_unresponded, 0)
    assert.equal(r2.warns, undefined, '零先验零注入：无 warns')
    const audit2 = await runAudit(paths, '数学', '数学', graph, regions, todayStr(new Date()), nodeVaultFs)
    assert.ok(!audit2.warns.some(w => w.startsWith('R17')))
  })
})

test('data-check 终点锚盘点：未播种 Missing 全绿；在盘合法计数；悬空/坏档 Broken', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    // 未播种：Missing 合法（inventory 计数 0，零 endpoint_anchor finding）
    const before = await dataCheck(paths, Date.now(), nodeVaultFs)
    assert.equal(before.inventory.endpointAnchors.present, 0)
    assert.ok(!before.findings.some(f => f.area === 'endpoint_anchor'))

    // 播种后：在盘且合法 → present=1 零 finding
    const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
    await engine.graph.graphApply('seed', r.id)
    const after = await dataCheck(paths, Date.now(), nodeVaultFs)
    assert.equal(after.inventory.endpointAnchors.present, 1)
    assert.ok(!after.findings.some(f => f.area === 'endpoint_anchor'))

    // 锚悬空（手工把锚改到不存在的节点）→ data-check Broken；读侧折叠可见不炸
    const anchorPath = paths.anchorPath('数学')
    const raw = JSON.parse(await readFile(anchorPath, 'utf8')) as { endpoint: string }
    raw.endpoint = '幽灵终点'
    await writeFile(anchorPath, JSON.stringify(raw), 'utf8')
    const dangling = await dataCheck(paths, Date.now(), nodeVaultFs)
    const finding = dangling.findings.find(f => f.reason === 'endpoint_anchor_dangling')
    assert.ok(finding, '锚悬空 Broken 可见')
    assert.match(finding!.detail ?? '', /换终点走重新种子提案/)
    assert.equal(dangling.status, 'broken')
    const danglingFold = await engine.courseCompletion({ name: '数学', root: '数学' })
    assert.equal(danglingFold!.criteria.endpoint_in_graph, false)
    assert.equal(danglingFold!.complete, false, '悬空锚不宣告完成')

    // 锚坏档（契约违约）→ 读侧 fail loud，statusJson 拒绝按坏锚宣告
    await writeFile(anchorPath, JSON.stringify({ endpoint: 123 }), 'utf8')
    await assert.rejects(
      () => engine.statusJson(),
      /锚文件 Broken[\s\S]*换终点走种子提案/,
    )
  })
})

test('seedNodeToGNode：零 enc 零 est、起点 pre 空、终点 pre=起点（粗占位边）', () => {
  const start = seedNodeToGNode({ name: 'S', region: '区', block: '块' }, [])
  assert.equal(start.enc.length, 0)
  assert.equal(start.est, undefined)
  assert.deepEqual(start.pre, [])
  const endpoint = seedNodeToGNode({ name: 'E', region: '区', block: '块' }, ['S'])
  assert.deepEqual(endpoint.pre, ['S'])
})

test('foldCompletion：锚缺席返回 null（未播种无从宣告）；覆盖锚定按工作表折叠', () => {
  const regions = [{
    name: '区', color: '', blocks: [{ name: '块', nodes: [
      { name: '起点', pre: [], opt: false, note: '', enc: [] },
      { name: '终点', pre: ['起点'], opt: false, note: '', enc: [] },
    ] }],
  }]
  const graph = new Graph(regions)
  assert.equal(foldCompletion(graph, {}, null), null)
  const anchor = {
    version: 1 as const,
    endpoint: '终点',
    goal_type: 'coverage' as const,
    declared: '2026-09-10',
    origin_proposal: 1,
    seed_nodes: ['起点', '终点'],
    start_basis: {},
    worksheet: [
      { block: '块A', done: true },
      { block: '块B', done: false },
    ],
  }
  const fold = foldCompletion(graph, {}, anchor)
  assert.equal(fold!.complete, false)
  assert.equal(fold!.criteria.worksheet!.done, 1)
  assert.equal(fold!.criteria.worksheet!.total, 2)
  assert.ok(fold!.criteria.closure_healthy === undefined, '覆盖锚定不要求闭包健康')
  // 能力锚定同图：终点 mastery=0 → 不达标（闭包健康但 mastery 未过阈）
  const capFold = foldCompletion(graph, {}, { ...anchor, goal_type: 'capability', worksheet: [] })
  assert.equal(capFold!.complete, false)
  assert.equal(capFold!.criteria.closure_healthy, true)
  assert.equal(capFold!.criteria.mastery_met, false)

  // 闭包口径：闭包之外远端节点的断边/enc 违约不拦终点的「闭包健康」
  const messy = new Graph([{
    name: '区', color: '', blocks: [{ name: '块', nodes: [
      { name: '起点', pre: [], opt: false, note: '', enc: [] },
      { name: '终点', pre: ['起点'], opt: false, note: '', enc: [] },
      { name: '远端节点', pre: ['幽灵前置'], opt: false, note: '', enc: [{ node: '幽灵技能', w: 1 }] },
    ] }],
  }])
  const messyFold = foldCompletion(messy, {}, { ...anchor, goal_type: 'capability', worksheet: [] })
  assert.equal(messyFold!.criteria.closure_healthy, true, '闭包外的破损不进终点的闭包健康')
  assert.equal(messyFold!.criteria.closure_errors!.length, 0)
})

// ---- 面板下发的种子起草（seedPropose）：目标描述 → 缝 → 干跑门 → proposeSeed 受理 ----
// （#162 起站点收统一 agent 缝：脚本化补全端口注入 AgentSeam）

import { AgentSeam } from '../src/engine/agent.ts'

const SEED_LLM_OK = (course: string): string => `course: ${course}
mode: new
reason: 常识基线起步
goal_type: capability
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
`

test('seedPropose：目标起草种子提案——受理 pending、绑定字段以表单为准、零先验合法', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    let calls = 0
    const fake = new AgentSeam({ complete: async prompt => {
      calls++
      assert.ok(prompt.includes('学会用微积分解决优化问题'), '目标描述进上下文')
      assert.ok(prompt.includes('- 课程名：微积分'), '课程名绑定进上下文')
      assert.ok(prompt.includes('- 模式：new'), '模式进上下文')
      assert.ok(prompt.includes('- 目标类型：capability'), '目标类型进上下文')
      assert.ok(!prompt.includes('只读检索所得'), '未选配先验不附检索注入段')
      return 'course: 完全不相干的错名\n' + SEED_LLM_OK('x').slice('course: x\n'.length)
    } }, systemClock)
    const r = await engine.graph.seedPropose({ course: '微积分', goal: '学会用微积分解决优化问题' }, fake)
    assert.equal(calls, 1)
    assert.equal(r.course, '微积分', '课程名以表单为准（模型照抄错也被绑定覆盖）')
    assert.equal(r.endpoint, '用导数解决优化问题')
    assert.equal(r.starts, 1)
    assert.equal(r.repaired, false)
    assert.equal(r.prior_hits, 0)
    const seed = (await engine.store.loadProposals()).find(p => p.kind === 'seed' && p.id === r.id)
    assert.ok(seed && seed.status === 'pending', '提案 pending 等一次人审')
  })
})

test('seedPropose：首轮 YAML 违约回灌修复一轮；两轮仍违约拒收（SEED_GATE_FAILED）', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    const broken = 'course: 微积分\nmode: new\nreason: 缺终点\nstarts: []\n'
    let n = 0
    const flaky = new AgentSeam({ complete: async prompt => {
      n++
      if (n === 2) assert.ok(prompt.includes('种子校验门'), '修复轮带校验清单')
      return n === 1 ? broken : SEED_LLM_OK('微积分')
    } }, systemClock)
    const r = await engine.graph.seedPropose({ course: '微积分', goal: '学会微积分' }, flaky)
    assert.equal(n, 2)
    assert.equal(r.repaired, true)
    const alwaysBad = new AgentSeam({ complete: async () => broken }, systemClock)
    await assert.rejects(
      () => engine.graph.seedPropose({ course: '微积分', goal: '学会微积分' }, alwaysBad),
      (err: Error & { code?: string }) => err.code === 'SEED_GATE_FAILED',
    )
  })
})

test('seedPropose：coverage 绑定表单工作表（不信模型）；空工作表拒收', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    const cov = new AgentSeam({ complete: async prompt => {
      assert.ok(prompt.includes('块工作表'), 'coverage 工作表进上下文')
      return 'course: 历史\nmode: new\nreason: x\ngoal_type: coverage\nworksheet:\n  - block: 模型瞎写的块\nendpoint:\n  name: 完成考纲综述\n  region: 基础\n  block: 收束\nstarts:\n  - name: 通读考纲\n    region: 基础\n    block: 起点块\n    basis: baseline\n'
    } }, systemClock)
    const r = await engine.graph.seedPropose(
      { course: '历史', goal: '过一遍考纲', goalType: 'coverage', worksheet: [{ block: '代数' }, { block: '几何' }] }, cov)
    const seed = (await engine.store.loadProposals()).find(p => p.kind === 'seed' && p.id === r.id)
    assert.ok(seed?.summary.includes('块工作表 2 项'), '绑定表单的两块工作表（模型的单块被覆盖）')
    await assert.rejects(
      () => engine.graph.seedPropose({ course: '历史', goal: '过一遍考纲', goalType: 'coverage' }, cov),
      /块工作表/,
      'coverage 缺工作表直接拒收',
    )
  })
})

// ---- 种子提案影响预览（proposalImpact，#159）：reseed/建课应用确认框的知识前置 ----
// 预览 = 只读现势计算：新建哪些节点、覆盖什么锚、罗盘是否重置、什么全保留；
// 引擎 reseed 语义不动，预览说的是真会发生的事。

test('proposalImpact：reseed 预览如实区分新建节点/现锚覆盖/罗盘重置/全保留', async () => {
  // 默认 vault：课程「数学」已注册（root=math），图上已有节点「入门」——
  // 入手态即「可 reseed」的真实场景
  await withVault({}, async ({ engine }) => {
    const first = `course: 数学
mode: reseed
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
`
    const r = await engine.graph.graphPropose('seed', first) as { id: number }
    // 未播种：无锚、无罗盘——预览不说「覆盖」「重置」
    const impact = await engine.proposals.proposalImpact('seed', r.id)
    assert.equal(impact.course, '数学')
    assert.equal(impact.mode, 'reseed')
    assert.deepEqual(impact.new_nodes, ['认识变化率', '用导数解决优化问题'])
    assert.deepEqual(impact.existing_nodes, [], '提案与图无重名（重名会被受理门拒收）')
    assert.equal(impact.graph_nodes, 1, '当前图只有「入门」')
    assert.equal(impact.current_anchor, null)
    assert.equal(impact.compass_reset, false)

    // 应用后再提一轮换终点：预览翻转——现锚带出、罗盘重置为真
    await engine.graph.graphApply('seed', r.id)
    const second = `course: 数学
mode: reseed
endpoint:
  name: 证明微积分基本定理
  region: 基础
  block: 终点块
starts:
  - name: 直观理解积分
    region: 基础
    block: 起点块
    basis: vault
`
    const r2 = await engine.graph.graphPropose('seed', second) as { id: number }
    const impact2 = await engine.proposals.proposalImpact('seed', r2.id)
    assert.ok(impact2.current_anchor, '现锚带出')
    assert.equal(impact2.current_anchor!.endpoint, '用导数解决优化问题')
    assert.equal(impact2.current_anchor!.origin_proposal, r.id)
    assert.equal(impact2.compass_reset, true, '罗盘已存在：路线与 ETA 将重置')
    assert.equal(impact2.graph_nodes, 3, '现有图 3 节点全保留（入门 + 首轮种子 2 个）')
    // 省略 id = 最新 pending 种子提案（确认框从提案行直达时的形态）
    const impact3 = await engine.proposals.proposalImpact('seed')
    assert.deepEqual(impact3.new_nodes, ['直观理解积分', '证明微积分基本定理'])
  })
})

test('proposalImpact：非种子 kind 与不存在/已决提案拒预览；重名提案给出漂移信号', async () => {
  await withVault({}, async ({ engine }) => {
    await assert.rejects(() => engine.proposals.proposalImpact('edit'), /只有种子提案/)
    await assert.rejects(() => engine.proposals.proposalImpact('seed', 999), /不存在或已决/)
    // 提案受理后图上长出了同名节点（漂移）→ existing_nodes 非空 = 应用必败的提前示警
    const seed = `course: 数学
mode: reseed
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
`
    const r = await engine.graph.graphPropose('seed', seed) as { id: number }
    await engine.graph.graphApply('seed', r.id)
    const r2 = await engine.graph.graphPropose('seed', seed.replace('认识变化率', '直观理解积分').replace('用导数解决优化问题', '证明微积分基本定理')) as { id: number }
    // 受理后手工把同名节点放进图（模拟另一条通道先落了同名节点）
    const gstore = new GraphStore(engine.paths, engine.paths.courseRoot('math'), nodeVaultFs)
    const files = await gstore.regionFiles()
    const regions = await gstore.load()
    regions[0]!.blocks[0]!.nodes.push({ name: '直观理解积分', pre: [], opt: false, note: '', enc: [], est: 20 })
    await gstore.writeRegionDoc(Object.values(files)[0]!, regions[0]!)
    const impact = await engine.proposals.proposalImpact('seed', r2.id)
    assert.deepEqual(impact.existing_nodes, ['直观理解积分'])
  })
})
