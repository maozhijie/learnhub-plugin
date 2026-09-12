import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addDays, todayStr } from '../src/engine/dates.ts'
import { systemClock } from '../src/host/clock.ts'
import { parseCompass, sectionBody, SECTION_ROUTE, SECTION_ANNOTATIONS } from '../src/engine/compass.ts'
import { withVault, noteText } from './helpers/vault.ts'
import { AgentSeam } from '../src/engine/agent.ts'

// 生长批受理（#145/#150 / ADR-0033 滚动教练的裁决产物面）：
// - 教练回合三段式 effort：显然步轻量段（fast，行为摘要+罗盘+图面）恒 1 次调用；
//   真分歧（note.disagreement）升级全量段（deep，六区块包+图面）重裁；全量段仍真分歧
//   升级双沙盘仲裁段（deep，+两份沙盘推演参照）终审——升级路径可观测。
// - 裁决产物 = kind=edit 提案 + note{算子, 理由, 分歧声明?}：算子标签/理由进 note 区
//   与 journal、罗盘重写与图 apply 同事务（提案被拒罗盘不落盘）、journal 挂提案 id。
// - 巩固门：巩固节点只引已教概念（受理门校验）、不走复诊（边轻键一律拒收）。
// - 裁决语义在提示词不测——金样本只锁组装与 schema（首过率/调用数基线对照）。

const SEED_VAULT = { registry: null, graph: null }

/** 种子提案：概念「变化率」随种子铸名、起点/终点 teaches 引用（巩固门的已教概念底座）。 */
const CAPABILITY_SEED = `course: 数学
mode: new
concepts:
  - canonical: 变化率
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
  teaches: {变化率: 会用}
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
    teaches: {变化率: 会用}
`

/** 画面里的金样本裁决（模板输出契约：course + note + route + ops [+ concepts]）。
 * ops 缺省 = 默认前进批；ops = [] 显式零操作（ops: []）；concepts = 顶层铸名块。
 * #198 生长方向不变式：前进批含 add_node 必接线终点（set_pre 替换语义），否则被
 * 受理门拒收回灌——金样本一律带接线，调用数基线（首过恒 1）不回归。 */
function goldVerdict(opts: {
  operator?: string
  reason?: string
  disagreement?: string
  ops?: string[]
  concepts?: string[]
  route?: string
} = {}): string {
  const opsBody = opts.ops ?? [
    '- op: add_node',
    '  name: 平均变化率',
    '  region: 基础',
    '  block: 起点块',
    '  pre: [认识变化率]',
    '  est: 15',
    '  bloom: 理解',
    '  difficulty: 2',
    '  teaches: {变化率: 会用}',
    '- op: set_pre',
    '  node: 用导数解决优化问题',
    '  pre: [平均变化率]',
  ]
  const routeLines = (opts.route
    ? opts.route.split('\n')
    : [
        '- **把变化率说成本质**：从日常速度出发建立「变化多快」的直觉。',
        '- **合成优化视角**：把导数接到极值判断，通向终点。',
      ]).map(l => `  ${l}`)
  return [
    'course: 数学',
    'note:',
    `  operator: ${opts.operator ?? '前进'}`,
    `  reason: ${opts.reason ?? '前沿缺下一台阶，沿终点推进'}`,
    ...(opts.disagreement ? [`  disagreement: ${opts.disagreement}`] : []),
    // #146 起插入批必须预注册复诊（metric 恰一枚 + days 缺省 10 学习日）
    ...(opts.operator === '插入' ? ['  recheck:', '    metric: 卡点集中度降幅', '    days: 10'] : []),
    'route: |',
    ...routeLines,
    ...(opts.ops && opts.ops.length === 0 ? ['ops: []'] : ['ops:', ...opsBody.map(l => `  ${l}`)]),
    ...(opts.concepts?.length ? ['concepts:', ...opts.concepts.map(l => `  ${l}`)] : []),
  ].join('\n') + '\n'
}

/** 录制型假实现：固定回放同一应答（包装成「一轮收束」的回路会话）。 */
function replayFake(reply: string) {
  return scriptFake([reply])
}

/** 会话脚本化假实现（#163 回路形态）：每段裁决走 agentLoop（stream 端口），sessions[i]
 * 是第 i 个回路会话的助手轮脚本——字符串 = 单轮文本收束，数组 = 逐轮（带 toolCalls 的
 * 轮请求工具、缝执行站点 runTool 后回灌继续）；回灌重裁段走 complete 端口按 repairReplies
 * 回放。calls = 缝级调用观测（回路会话记会话首请求的 prompt/语义档、repair 记补全调用）
 * ——既有调用数基线断言全部沿用；requests = 逐轮回路历史（工具回灌/白名单拒收断言用）。 */
type LoopScriptTurn = { text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
function scriptFake(
  sessions: Array<string | LoopScriptTurn[]>,
  repairReplies: string[] = [],
) {
  const calls: Array<{ prompt: string; system?: string; effort?: string }> = []
  const requests: Array<{
    messages: Array<{ role: string; text?: string; toolCalls?: unknown; isError?: boolean }>
    tools?: Array<{ name: string }>
    effort?: string
  }> = []
  const queue = sessions.map(s => [...(typeof s === 'string' ? [{ text: s }] : s)] as LoopScriptTurn[])
  let current: LoopScriptTurn[] = []
  const seam = new AgentSeam({
    complete: async (prompt, system, opts) => {
      calls.push({ prompt, system, effort: opts?.effort })
      if (!repairReplies.length) throw new Error('脚本化补全端口：回灌重裁应答已耗尽')
      return repairReplies.shift()!
    },
    stream: async req => {
      if (!current.length) {
        current = queue.shift()
        if (!current) throw new Error('脚本化回路端口：会话脚本已耗尽')
        calls.push({ prompt: req.messages[0]!.text, system: req.system, effort: req.effort })
      }
      requests.push({ messages: [...req.messages], tools: req.tools, effort: req.effort })
      const next = current.shift()!
      return { text: next.text, toolCalls: next.toolCalls ?? [] }
    },
  }, systemClock)
  return Object.assign(seam, { calls, requests })
}

async function seedApplied(engine: Awaited<ReturnType<typeof withVault>>['engine']): Promise<void> {
  const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
  await engine.graph.graphApply('seed', r.id)
}

/** 巩固门底座核对：种子的 teaches 已让「变化率」成为已教概念。 */
async function assertTaught(engine: Awaited<ReturnType<typeof withVault>>['engine'], concept: string): Promise<void> {
  const applied = await engine.graph.graphPropose('edit', `course: 数学
ops:
  - op: add_node
    name: 巩固合法探针
    region: 基础
    block: 起点块
    pre: [认识变化率]
    teaches: {${concept}: 知道}
`)
  await engine.graph.graphReject((applied as { id: number }).id)
}

test('AC1 金样本全链：轻量段单次 fast 调用、提案应用、罗盘同事务重写、journal 挂提案 id', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const compassPath = paths.compassPath('数学')
    const annotations = '我想快点走到优化应用。'
    const before = await readFile(compassPath, 'utf8')
    const withAnn = before.replace(
      '（把你的路线期望、想补的重点、想跳过的块写在这里；教练每次重画都会读——它是提议非指令，不会自动改图。）',
      annotations)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(compassPath, withAnn, 'utf8')

    const fake = replayFake(goldVerdict())
    const r = await engine.growth2.coachGrowthBatch('数学', fake)

    // 组装与调用数基线：显然步恒 1 次调用、fast 档、轻量包（无终点锚/误解目录区块）
    assert.equal(fake.calls.length, 1, '调用数基线：显然步轻量段恒一次调用（无修复轮）')
    assert.equal(fake.calls[0]!.effort, 'fast')
    assert.match(fake.calls[0]!.prompt, /教练回合提示词/, '模板在前')
    assert.match(fake.calls[0]!.prompt, /轻量段——只带行为摘要与罗盘/, '轻量上下文包')
    assert.match(fake.calls[0]!.prompt, /当前图面/, '图面两段恒带（ops 的取值域）')
    assert.match(fake.calls[0]!.prompt, /认识变化率/, '图面细节行含前沿节点')
    assert.match(fake.calls[0]!.prompt, /变化率 会用/, '图面带 teaches 档位')
    assert.doesNotMatch(fake.calls[0]!.prompt, /## 终点锚/, '轻量段不带终点锚区块')
    assert.doesNotMatch(fake.calls[0]!.prompt, /## 误解目录/, '轻量段不带误解目录区块')

    // 受理结果：算子标签进结果、提案应用、罗盘同事务重写
    assert.equal(r.state, 'applied')
    assert.equal(r.segments.length, 1)
    assert.equal(r.segments[0]!.operator, '前进')
    assert.equal(r.proposal!.operator, '前进')
    assert.ok(r.applied!.compass_rewritten, '罗盘随批重写')
    assert.equal(r.applied!.created.join(','), '平均变化率')

    // 罗盘：路线段被替换、批注区字节保留
    const doc = parseCompass(await readFile(compassPath, 'utf8'))
    assert.match(sectionBody(doc, SECTION_ROUTE)!.trim(), /把变化率说成本质/)
    assert.equal(sectionBody(doc, SECTION_ANNOTATIONS)?.trim(), annotations)

    // journal 挂提案 id + 算子标签/理由进 detail；提案记录 summary 带算子
    const journal = await readFile(join(paths.centerRoot, 'state', 'journal.jsonl'), 'utf8')
    const growthLine = journal.split('\n').filter(l => l.includes('graph_edit')).at(-1)!
    assert.match(growthLine, new RegExp(`"session":"${r.proposal!.id}"`))
    assert.match(growthLine, /生长批（前进）：前沿缺下一台阶/)
    assert.match(growthLine, /add_node\(平均变化率\)/)
    const props = await engine.graph.graphProposals('applied', 'edit')
    assert.match(props[0]!.summary, /生长批（前进）：前沿缺下一台阶/)
  })
})

test('AC2 两段式升级：分歧声明升级全量段（deep、六区块），以全量段结论为准且路径可观测', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const compassPath = paths.compassPath('数学')
    const fake = scriptFake([
      goldVerdict({ disagreement: '轻量段看不到误解目录，插入判据不足——升级' }),
      goldVerdict({ operator: '插入', reason: '卡点集中度指向缺口，插入过渡节' }),
    ])
    const r = await engine.growth2.coachGrowthBatch('数学', fake)

    // 升级路径可观测：恰两次调用（light/fast → full/deep），segments 逐步带算子
    // （全量段未再声明分歧——升级链到此为止，无仲裁段）
    assert.equal(fake.calls.length, 2, '调用数基线：分歧升级恒两次（全量段未再声明，无仲裁段）')
    assert.equal(fake.calls[0]!.effort, 'fast')
    assert.equal(fake.calls[1]!.effort, 'deep')
    assert.deepEqual(r.segments.map(s => [s.tier, s.effort, s.operator]), [
      ['light', 'fast', '前进'],
      ['full', 'deep', '插入'],
    ])
    // 全量段带六区块（终点锚/误解目录在轻量段缺席）
    assert.doesNotMatch(fake.calls[0]!.prompt, /## 终点锚/)
    assert.match(fake.calls[1]!.prompt, /## 终点锚/)
    assert.match(fake.calls[1]!.prompt, /## 误解目录/)
    // 以全量段结论为准：最终提案 = 插入批；分歧只在轻量段的 segments 上可观测
    assert.equal(r.proposal!.operator, '插入')
    assert.equal(r.proposal!.disagreement, false, '全量段结论无分歧声明')
    assert.equal(r.segments[0]!.disagreement, true, '升级起点 = 轻量段的分歧声明')
    assert.match((await readFile(compassPath, 'utf8')), /把变化率说成本质/)
  })
})

test('AC3 双沙盘仲裁：全量段仍真分歧 → 第三段带两份推演参照终审；调用数恒 3、结论为最终裁决', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const fake = scriptFake([
      goldVerdict({ disagreement: '轻量段看不到误解目录，插入判据不足——升级' }),
      goldVerdict({ operator: '插入', reason: '卡点集中度指向缺口', disagreement: '带着六区块仍然撕不动：插入补救 vs 直接前进' }),
      goldVerdict({ operator: '前进', reason: '推演代价可忽略，按教学判断沿终点推进' }),
    ])
    const r = await engine.growth2.coachGrowthBatch('数学', fake)

    // 升级路径可观测：恰三次调用（light/fast → full/deep → arbitration/deep）；
    // 沙盘推演是读侧蒙特卡洛，不计 LLM 调用数
    assert.equal(fake.calls.length, 3, '调用数基线：双沙盘仲裁恒三次调用')
    assert.deepEqual(fake.calls.map(c => c.effort), ['fast', 'deep', 'deep'])
    assert.deepEqual(r.segments.map(s => [s.tier, s.effort, s.operator, s.disagreement]), [
      ['light', 'fast', '前进', true],
      ['full', 'deep', '插入', true],
      ['arbitration', 'deep', '前进', false],
    ])
    // 仲裁段装配：全量区块仍在 + 双沙盘参照块（两计划带并排、非承诺措辞、分歧声明原话）
    const arb = fake.calls[2]!.prompt
    assert.match(arb, /仲裁段——全量包\+双沙盘推演参照/)
    assert.match(arb, /## 终点锚/, '仲裁段带全量包（六区块定序不变）')
    assert.match(arb, /## 双沙盘推演（终审参照——模型推演，非承诺）/)
    assert.ok(arb.includes('分歧声明（全量段）：带着六区块仍然撕不动：插入补救 vs 直接前进'))
    assert.ok(arb.includes('计划一（现状照走）：W1'), '计划一 = 现状照走的逐周分位带')
    assert.ok(arb.includes('计划二（含本批照走，新增：平均变化率）'), '计划二 = 含全量段候选批照走')
    assert.match(arb, /推演基准：每日约 30 分钟 × 6 周/)
    assert.match(arb, /终审归你的教学判断/, '代价参考口径：收益不在推演里')
    // 以仲裁段结论为准：最终提案 = 前进批（全量段的插入批被终审推翻）
    assert.equal(r.state, 'applied')
    assert.equal(r.proposal!.operator, '前进')
    assert.equal(r.proposal!.disagreement, false, '仲裁段终审不再声明分歧（没有更多段）')
    assert.match((await readFile(paths.compassPath('数学'), 'utf8')), /把变化率说成本质/, '罗盘同事务照走')
  })
})

test('拒收零落盘：裁决未过受理门时罗盘与图零改动、零提案零 journal', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const compassPath = paths.compassPath('数学')
    const before = await readFile(compassPath, 'utf8')
    const journalBefore = await readFile(join(paths.centerRoot, 'state', 'journal.jsonl'), 'utf8')

    // 断边裁决（pre 引用不存在的节点）：propose 门拒绝 → coachGrowthBatch fail loud
    const bad = goldVerdict({ ops: [
      '- op: add_node',
      '  name: 悬空节点',
      '  region: 基础',
      '  block: 起点块',
      '  pre: [不存在节点]',
    ] })
    await assert.rejects(() => engine.growth2.coachGrowthBatch('数学', replayFake(bad)), /悬空|断边|不存在/)
    assert.equal(await readFile(compassPath, 'utf8'), before, '提案被拒罗盘不落盘')
    assert.deepEqual(await engine.graph.graphProposals('pending'), [])
    assert.deepEqual(await engine.graph.graphProposals('applied', 'edit'), [], '零 edit 提案（种子提案除外）')

    // 路线门拒绝（route 带 "## " 标题劫持）：受理时就拒——零 pending、罗盘零改动
    const badRoute = goldVerdict({ route: '## 剩余路线\n\n- 冒充整页' })
    await assert.rejects(() => engine.growth2.coachGrowthBatch('数学', replayFake(badRoute)), /路线门|标题/)
    assert.equal(await readFile(compassPath, 'utf8'), before)
    assert.equal(
      await readFile(join(paths.centerRoot, 'state', 'journal.jsonl'), 'utf8'),
      journalBefore,
      '零 graph_edit journal',
    )
    assert.deepEqual(await engine.graph.graphProposals('pending'), [], '路线门在受理时拒绝——零 pending 遗留')
  })
})

test('apply 失败自清：审计 ERROR 拦下 apply 时机器裁决不留 pending，罗盘零改动', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    // 弄坏课程文件（E4 Broken → 审计 ERROR）：受理门不查审计，apply 门会拦
    const notePath = paths.courseNotePath('数学', '基础', '认识变化率')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(notePath, '---\nnode: 认识变化率\ncontent:\n  sections: "坏档"\n---\n# 认识变化率\n', 'utf8')
    const compassPath = paths.compassPath('数学')
    const before = await readFile(compassPath, 'utf8')

    await assert.rejects(() => engine.growth2.coachGrowthBatch('数学', replayFake(goldVerdict())), /审计存在 ERROR/)
    assert.equal(await readFile(compassPath, 'utf8'), before, '罗盘零改动')
    const props = await engine.graph.graphProposals('rejected', 'edit')
    assert.equal(props.length, 1, 'apply 失败的机器裁决自清为 rejected')
    assert.match(props[0]!.decision_note ?? '', /生长批自动 apply 失败/)
    assert.deepEqual(await engine.graph.graphProposals('pending'), [])
  })
})

test('AC4 巩固门：巩固节点只引已教概念（新概念拒收）；前进批产新概念不受限', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    await assertTaught(engine, '变化率')

    // 巩固批引新概念（随批铸名也不行——铸名 ≠ 已教）：受理门拒收
    const consolidateNew = goldVerdict({
      operator: '巩固',
      reason: '收束变化率',
      ops: [
        '- op: add_node',
        '  name: 变化率综合',
        '  region: 基础',
        '  block: 起点块',
        '  pre: [认识变化率]',
        '  teaches: {极限: 知道}',
      ],
      concepts: ['- canonical: 极限'],
    })
    await assert.rejects(
      () => engine.growth2.coachGrowthBatch('数学', replayFake(consolidateNew)),
      /巩固门|只引已教概念/,
    )

    // 巩固批引已教概念：通过
    const consolidateOk = goldVerdict({
      operator: '巩固',
      reason: '综合变化率做收束',
      ops: [
        '- op: add_node',
        '  name: 变化率综合',
        '  region: 基础',
        '  block: 起点块',
        '  pre: [认识变化率]',
        '  teaches: {变化率: 会用}',
      ],
    })
    const ok = await engine.growth2.coachGrowthBatch('数学', replayFake(consolidateOk))
    assert.equal(ok.state, 'applied')

    // 前进批产新概念：不受巩固门限制（正常铸名通道）；主线批带终点接线（#198）
    const advanceNew = goldVerdict({
      operator: '前进',
      ops: [
        '- op: add_node',
        '  name: 极限初步',
        '  region: 基础',
        '  block: 起点块',
        '  pre: [认识变化率]',
        '  teaches: {极限: 知道}',
        '- op: set_pre',
        '  node: 用导数解决优化问题',
        '  pre: [极限初步]',
      ],
      concepts: ['- canonical: 极限'],
    })
    const adv = await engine.growth2.coachGrowthBatch('数学', replayFake(advanceNew))
    assert.equal(adv.state, 'applied')
    assert.equal(adv.applied!.created.join(','), '极限初步')
  })
})

test('停机转译：就绪深度满足时不拉回合（零调用）；force 越过后照常受理', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    const declared = todayStr(new Date())
    const r = await engine.graph.graphPropose('seed', `course: 数学
mode: new
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
  - name: 极限直觉
    region: 基础
    block: 起点块
  - name: 函数图像
    region: 基础
    block: 起点块
`) as { id: number }
    await engine.graph.graphApply('seed', r.id)
    // 三个起点正文就绪（ready=3）；today 移出冷启动首周（required=3）→ 深度满足
    const { writeFile, mkdir } = await import('node:fs/promises')
    for (const node of ['认识变化率', '极限直觉', '函数图像']) {
      await mkdir(`${paths.centerRoot}/数学/课程/基础`, { recursive: true })
      await writeFile(
        paths.courseNotePath('数学', '基础', node),
        noteText(node, { content: { sections: ['    - { id: s1, title: 开场, type: 概念, status: ready, version: 0 }'] } }),
        'utf8',
      )
    }
    const fake = replayFake(goldVerdict({ ops: [
      '- op: add_node',
      '  name: 平均变化率',
      '  region: 基础',
      '  block: 起点块',
      '  pre: [认识变化率]',
      '- op: set_pre',
      '  node: 用导数解决优化问题',
      '  pre: [平均变化率]',
    ] }))
    const idle = await engine.growth2.coachGrowthBatch('数学', fake, { today: addDays(declared, 7)! })
    assert.equal(idle.state, 'idle')
    assert.equal(fake.calls.length, 0, '停摆是判据满足的自然结果——零调用')
    assert.ok(idle.check.ok)

    // force 越过停摆（测试/排障语义）：照常拉回合并受理
    const forced = await engine.growth2.coachGrowthBatch('数学', fake, { force: true, today: addDays(declared, 7)! })
    assert.equal(forced.state, 'applied')
    assert.equal(fake.calls.length, 1)
    assert.match(await readFile(paths.compassPath('数学'), 'utf8'), /把变化率说成本质/)
  })
})

test('零操作生长批：裁决=暂不产结构（ops: []）合法——罗盘重写与留痕照走同事务', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const fake = replayFake(goldVerdict({
      operator: '前进',
      reason: '结构已足，等内容生成跟上',
      ops: [],
    }))
    const r = await engine.growth2.coachGrowthBatch('数学', fake)
    assert.equal(r.state, 'applied')
    assert.equal(r.applied!.ops, 0)
    assert.ok(r.applied!.compass_rewritten)
    assert.deepEqual(r.applied!.created, [])
    const doc = parseCompass(await readFile(paths.compassPath('数学'), 'utf8'))
    assert.match(sectionBody(doc, SECTION_ROUTE)!.trim(), /把变化率说成本质/)
    const props = await engine.graph.graphProposals('applied', 'edit')
    assert.match(props[0]!.summary, /生长批（前进）：结构已足/)
  })
})

test('金样本回放闸：两族金样本首过（首过率对照、调用数基线恒 1）+ 同种子回放组装字节一致', async () => {
  // 第二族 = 旁支批（换算子/换理由/换节点名——覆盖另一算子的首过与组装）
  const sideBranch = goldVerdict({
    operator: '旁支',
    reason: '讲清主线必须先教的支线',
    ops: [
      '- op: add_node',
      '  name: 导数的几何意义',
      '  region: 基础',
      '  block: 起点块',
      '  pre: [认识变化率]',
      '  est: 10',
    ],
  })

  // 首过率对照：每族金样本一次调用即过全部门（无修复轮、无升级）
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    for (const verdict of [goldVerdict(), sideBranch]) {
      const fake = replayFake(verdict)
      const r = await engine.growth2.coachGrowthBatch('数学', fake)
      assert.equal(fake.calls.length, 1, `首过基线：${r.proposal!.operator} 批一次调用过门`)
      assert.equal(r.state, 'applied')
    }
  })

  // 确定性：同种子两 vault，同族金样本的组装 prompt 字节级一致
  const prompts: string[] = []
  for (let i = 0; i < 2; i++) {
    await withVault(SEED_VAULT, async ({ engine }) => {
      await seedApplied(engine)
      const fake = replayFake(goldVerdict())
      await engine.growth2.coachGrowthBatch('数学', fake)
      prompts.push(fake.calls[0]!.prompt)
    })
  }
  assert.equal(prompts[0], prompts[1], '同种子同金样本 → 组装字节一致')
})

test('#149 计划修订注入：check.ok 不再短路停摆（注入=显式重裁请求），注入块随包进提示词', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    const declared = todayStr(new Date())
    const r = await engine.graph.graphPropose('seed', `course: 数学
mode: new
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
  - name: 极限直觉
    region: 基础
    block: 起点块
  - name: 函数图像
    region: 基础
    block: 起点块
`) as { id: number }
    await engine.graph.graphApply('seed', r.id)
    // 三个起点正文就绪（ready=3）；today 移出冷启动首周（required=3）→ 深度满足
    const { writeFile, mkdir } = await import('node:fs/promises')
    for (const node of ['认识变化率', '极限直觉', '函数图像']) {
      await mkdir(`${paths.centerRoot}/数学/课程/基础`, { recursive: true })
      await writeFile(
        paths.courseNotePath('数学', '基础', node),
        noteText(node, { content: { sections: ['    - { id: s1, title: 开场, type: 概念, status: ready, version: 0 }'] } }),
        'utf8',
      )
    }
    const verdict = goldVerdict({ ops: [
      '- op: add_node',
      '  name: 平均变化率',
      '  region: 基础',
      '  block: 起点块',
      '  pre: [认识变化率]',
      '- op: set_pre',
      '  node: 用导数解决优化问题',
      '  pre: [平均变化率]',
    ] })
    // 对照：就绪深度满足 + 无注入 → 停摆零调用
    const idle = await engine.growth2.coachGrowthBatch('数学', replayFake(verdict), { today: addDays(declared, 7)! })
    assert.equal(idle.state, 'idle')
    // 计划修订注入 = 显式的重新裁决请求：check.ok 不短路，注入块随包进轻量段提示词
    const inject = '- 补支：里程碑 m2「双音听辨」关联「数学/即兴入门」图上尚无——沿足迹朝它长最小必要分支'
    const fake = replayFake(verdict)
    const round = await engine.growth2.coachGrowthBatch('数学', fake, { today: addDays(declared, 7)!, inject })
    assert.equal(round.state, 'applied')
    assert.equal(fake.calls.length, 1, '注入回合照走两段式（显然步恒 1 次调用）')
    assert.match(fake.calls[0]!.prompt, /里程碑计划修订注入（项目消费拉动的生长请求）/)
    assert.match(fake.calls[0]!.prompt, /即兴入门/)
    assert.match(fake.calls[0]!.prompt, /换线 = 激活图上已有节点/)
  })
})

// ---- 回灌止血（#157）：受理门拒收 → 门错误回灌教练重裁一次（仍败才 failed）----

/** 引用图上不存在的区的畸形裁决（实机死法；过 schema 门、被 propose 受理门拒）。 */
const BAD_REGION_OPS = [
  '- op: add_node',
  '  name: 平均变化率',
  '  region: 幻区',
  '  block: 起点块',
  '  pre: [认识变化率]',
  '  est: 15',
  '  bloom: 理解',
  '  difficulty: 2',
  '  teaches: {变化率: 会用}',
]

test('#157 回灌重裁：受理门拒收（引用不存在的区）→ 门错误回灌重裁段 → 合法产出进受理门', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    // 首轮裁决引用图上不存在的区（实机死法）：过 schema 门（区是自由字符串）、
    // 被 propose 受理门拒（add_node 区不存在）；重裁段产出合法裁决 → 提案照常受理
    const fake = scriptFake([goldVerdict({ ops: BAD_REGION_OPS })], [goldVerdict()])
    const r = await engine.growth2.coachGrowthBatch('数学', fake)

    // 调用数基线：轻量段 1 次 + 回灌重裁段恰 1 次（deep 档）
    assert.equal(fake.calls.length, 2, '受理门拒收后恰回灌重裁一次')
    assert.equal(fake.calls[1]!.effort, 'deep', '回灌重裁段恒 deep 档')
    // 门错误与被拒原文都回灌进重裁段 prompt（教练拿得到死因与修正起点）
    assert.match(fake.calls[1]!.prompt, /受理门反馈/)
    assert.match(fake.calls[1]!.prompt, /区不存在: 幻区/, '首轮拒绝原因原样回灌')
    assert.match(fake.calls[1]!.prompt, /region: 幻区/, '被拒裁决原文随包回灌')
    assert.match(fake.calls[1]!.prompt, /当前图面/, '重裁段恒带图面（修正引用的取值域）')
    // 重裁产出走完整受理链：提案应用、路径可观测（light → repair）
    assert.equal(r.state, 'applied')
    assert.deepEqual(r.segments.map(s => s.tier), ['light', 'repair'])
    assert.equal(r.segments[1]!.tier, 'repair')
    assert.equal(r.segments[1]!.effort, 'deep')
    assert.equal(r.proposal!.operator, '前进')
    assert.equal(r.applied!.created.join(','), '平均变化率')
  })
})

test('#157 回灌仍败：重裁产出再被受理门拒收 → 原样失败且错误带两轮死因，零提案落盘', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
  const malformed = goldVerdict({ ops: BAD_REGION_OPS })
  const fake = scriptFake([malformed], [malformed])
    await assert.rejects(
      engine.growth2.coachGrowthBatch('数学', fake),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        assert.match(msg, /回灌重裁一轮仍未通过/, '失败显式声明死因形态')
        assert.match(msg, /【首轮】/, '带首轮拒绝原因')
        assert.match(msg, /【重裁】/, '带重裁拒绝原因')
        assert.match(msg, /区不存在: 幻区/)
        return true
      },
    )
    assert.equal(fake.calls.length, 2, '恰两轮调用（轻量段 + 回灌重裁段），不无限重试')
    // 被拒批次零落盘：两轮都没到 saveArtifact，无 pending 提案残留
    assert.equal((await engine.graph.graphProposals('pending', 'edit')).length, 0)
  })
})

// ---- 教练工具回路（#163 / ADR-0041）：只读白名单 + K 轮预算 + 取消传导 ----

test('#163 AC 脚本化工具应答：教练裁决前经图视图核实名字，产出过受理门的批', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    // 脚本：轻量段先调 graph_view 核实「认识变化率」在图上（再调 concept_registry 对表
    // 「变化率」），收到真实视图回灌后才产出裁决——裁决的名字取自工具回灌内容
    const fake = scriptFake([[
      { text: '裁决前先查图面核实起点名。', toolCalls: [{ id: 't1', name: 'graph_view', arguments: '{}' }] },
      { text: '图面确认「认识变化率」在前沿，再对表登记表。', toolCalls: [{ id: 't2', name: 'concept_registry', arguments: '{"query":"变化率"}' }] },
      { text: goldVerdict() },
    ]])
    const r = await engine.growth2.coachGrowthBatch('数学', fake)

    // 批照常过受理门（回路产物过全部既有门，门零放松）：提案应用、罗盘同事务重写
    assert.equal(r.state, 'applied')
    assert.equal(r.proposal!.operator, '前进')
    assert.ok(r.applied!.compass_rewritten)

    // 工具真的被站点执行器跑过：结果回灌进回路历史（模型看到的是真图面）
    const second = fake.requests[1]!
    assert.equal((second.messages[2] as { role: string; text: string }).role, 'tool')
    assert.match((second.messages[2] as { text: string }).text, /认识变化率/, 'graph_view 回灌真实图面')
    const third = fake.requests[2]!
    assert.match((third.messages[4] as { text: string }).text, /变化率/, 'concept_registry 回灌登记表内容')
    // 白名单随请求（七件只读视图）
    assert.equal(fake.requests[0]!.tools!.length, 7)

    // 回路轨迹带段前缀进结果（宿主消费：任务消息），逐轮可观测
    assert.equal(r.trajectory.length, 2)
    assert.match(r.trajectory[0]!, /^\[轻量段\] graph_view\(2 字符参数\) → \d+ 字符$/)
    assert.match(r.trajectory[1]!, /^\[轻量段\] concept_registry/)
  })
})

test('#163 AC 白名单外调用被拒：isError 回灌模型可见，回路继续、裁决照常过门', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    // 脚本：模型先试图调写工具 graph_apply（白名单外）→ 被站点执行器拒收 →
    // 拒收原因原样回灌 → 模型改走正道产出裁决（提案→受理门→apply）
    const fake = scriptFake([[
      { text: '我直接把节点写上图。', toolCalls: [{ id: 'w1', name: 'graph_apply', arguments: '{"kind":"edit"}' }] },
      { text: '写工具被拒——只读工具面，走提案正道。', toolCalls: [{ id: 'w2', name: 'coach_growth', arguments: '{}' }] },
      { text: goldVerdict() },
    ]])
    const r = await engine.growth2.coachGrowthBatch('数学', fake)

    assert.equal(r.state, 'applied', '拒收不炸回路：模型改走正道后裁决照常受理')
    // 两次白名单外调用都被拒，拒收原因原样回灌（模型可见）
    const toolText = (req: { messages: Array<{ role: string; text?: string }> }) =>
      (req.messages.filter(m => m.role === 'tool').at(-1) as { text: string }).text
    assert.match(toolText(fake.requests[1]!), /白名单外工具「graph_apply」被拒/)
    assert.match(toolText(fake.requests[2]!), /白名单外工具「coach_growth」被拒/)
    // 图零直接改动：唯一的图变更来自 apply 出口（提案 id 留痕），无旁路写入
    assert.equal(r.applied!.created.join(','), '平均变化率')
  })
})

test('#163 AC 任务取消传导（站点级）：开局取消零调用；回路中取消即中止且已产裁决丢弃', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    // 开局取消：一次底层调用都不发生
    const fake1 = replayFake(goldVerdict())
    await assert.rejects(
      () => engine.growth2.coachGrowthBatch('数学', fake1, { isCancelled: () => true }),
      /任务已取消/,
    )
    assert.equal(fake1.calls.length, 0, '开局取消：回路零底层调用')
    assert.equal((await engine.graph.graphProposals('pending', 'edit')).length, 0, '零提案落盘')

    // 回路中取消：工具执行期间旗标翻真 → 下一轮前中止，裁决丢弃
    let cancelled = false
    const fake2 = scriptFake([[
      { text: '查图面。', toolCalls: [{ id: 'c1', name: 'graph_view', arguments: '{}' }] },
      { text: goldVerdict() },
    ]])
    // runTool 不是站点可控的——借 gate 前的 isCancelled 钩子：首次检查（first 前）放行，
    // 工具回灌后的下一轮检查取消。用计数器模拟「取消发生在首轮工具执行后」。
    let checks = 0
    await assert.rejects(
      () => engine.growth2.coachGrowthBatch('数学', fake2, {
        isCancelled: () => {
          checks++
          return checks > 1 // first() 前的 assertAlive 放行，回路首轮工具执行后翻真
        },
      }).then(() => { cancelled = true }),
      /任务已取消/,
    )
    assert.equal(cancelled, false)
    assert.equal((await engine.graph.graphProposals('pending', 'edit')).length, 0, '取消批零提案落盘')
  })
})

test('#163 AC 门错修复轮恰好一次不回归：拒收后恰回灌重裁一段（repair 单发），轨迹只来自回路段', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    // 首轮回路会话产出畸形裁决（引用幻区）被受理门拒收 → repair 单发重裁一次 → 过门
    const fake = scriptFake(
      [[
        { text: '查一下图面再裁。', toolCalls: [{ id: 't1', name: 'graph_view', arguments: '{}' }] },
        { text: goldVerdict({ ops: BAD_REGION_OPS }) },
      ]],
      [goldVerdict()],
    )
    const r = await engine.growth2.coachGrowthBatch('数学', fake)
    assert.equal(r.state, 'applied')
    assert.deepEqual(r.segments.map(s => s.tier), ['light', 'repair'], '恰一次门错修复轮（#157 语义不回归）')
    // 轨迹只来自回路段（repair 是单发，无工具轮）；段前缀区分
    assert.equal(r.trajectory.length, 1)
    assert.match(r.trajectory[0]!, /^\[轻量段\] graph_view/)
  })
})
