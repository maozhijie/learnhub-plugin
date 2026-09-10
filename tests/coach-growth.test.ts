import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addDays, todayStr } from '../src/engine/dates.ts'
import { parseCompass, sectionBody, SECTION_ROUTE, SECTION_ANNOTATIONS } from '../src/engine/compass.ts'
import { withVault, noteText } from './helpers/vault.ts'
import type { LlmComplete } from '../src/engine/llm.ts'

// 生长批受理（#145 / ADR-0033 滚动教练的裁决产物面）：
// - 教练回合两段式 effort：显然步轻量段（fast，行为摘要+罗盘+图面）恒 1 次调用；
//   真分歧（note.disagreement）升级全量段（deep，六区块包+图面）重裁——升级路径可观测。
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
 * ops 缺省 = 默认前进批；ops = [] 显式零操作（ops: []）；concepts = 顶层铸名块。 */
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
    'route: |',
    ...routeLines,
    ...(opts.ops && opts.ops.length === 0 ? ['ops: []'] : ['ops:', ...opsBody.map(l => `  ${l}`)]),
    ...(opts.concepts?.length ? ['concepts:', ...opts.concepts.map(l => `  ${l}`)] : []),
  ].join('\n') + '\n'
}

/** 录制型假实现：记 prompt/system/语义档，固定回放同一应答。 */
function replayFake(reply: string) {
  return scriptFake([reply])
}

/** 脚本化假实现：按调用序回放（第 i 次调用回 replies[i]，越界取最后一条）。 */
function scriptFake(replies: string[]) {
  const calls: Array<{ prompt: string; system?: string; effort?: string }> = []
  const fn: LlmComplete = async (prompt, system, opts) => {
    calls.push({ prompt, system, effort: opts?.effort })
    return replies[Math.min(calls.length - 1, replies.length - 1)]!
  }
  return Object.assign(fn, { calls })
}

async function seedApplied(engine: Awaited<ReturnType<typeof withVault>>['engine']): Promise<void> {
  const r = await engine.graphPropose('seed', CAPABILITY_SEED) as { id: number }
  await engine.graphApply('seed', r.id)
}

/** 巩固门底座核对：种子的 teaches 已让「变化率」成为已教概念。 */
async function assertTaught(engine: Awaited<ReturnType<typeof withVault>>['engine'], concept: string): Promise<void> {
  const applied = await engine.graphPropose('edit', `course: 数学
ops:
  - op: add_node
    name: 巩固合法探针
    region: 基础
    block: 起点块
    pre: [认识变化率]
    teaches: {${concept}: 知道}
`)
  await engine.graphReject((applied as { id: number }).id)
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
    const r = await engine.coachGrowthBatch('数学', fake)

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
    const props = await engine.graphProposals('applied', 'edit')
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
    const r = await engine.coachGrowthBatch('数学', fake)

    // 升级路径可观测：恰两次调用（light/fast → full/deep），segments 逐步带算子
    assert.equal(fake.calls.length, 2, '调用数基线：分歧升级恒两次（无第三段）')
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
    await assert.rejects(() => engine.coachGrowthBatch('数学', replayFake(bad)), /悬空|断边|不存在/)
    assert.equal(await readFile(compassPath, 'utf8'), before, '提案被拒罗盘不落盘')
    assert.deepEqual(await engine.graphProposals('pending'), [])
    assert.deepEqual(await engine.graphProposals('applied', 'edit'), [], '零 edit 提案（种子提案除外）')

    // 路线门拒绝（route 带 "## " 标题劫持）：受理时就拒——零 pending、罗盘零改动
    const badRoute = goldVerdict({ route: '## 剩余路线\n\n- 冒充整页' })
    await assert.rejects(() => engine.coachGrowthBatch('数学', replayFake(badRoute)), /路线门|标题/)
    assert.equal(await readFile(compassPath, 'utf8'), before)
    assert.equal(
      await readFile(join(paths.centerRoot, 'state', 'journal.jsonl'), 'utf8'),
      journalBefore,
      '零 graph_edit journal',
    )
    assert.deepEqual(await engine.graphProposals('pending'), [], '路线门在受理时拒绝——零 pending 遗留')
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

    await assert.rejects(() => engine.coachGrowthBatch('数学', replayFake(goldVerdict())), /审计存在 ERROR/)
    assert.equal(await readFile(compassPath, 'utf8'), before, '罗盘零改动')
    const props = await engine.graphProposals('rejected', 'edit')
    assert.equal(props.length, 1, 'apply 失败的机器裁决自清为 rejected')
    assert.match(props[0]!.decision_note ?? '', /生长批自动 apply 失败/)
    assert.deepEqual(await engine.graphProposals('pending'), [])
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
      () => engine.coachGrowthBatch('数学', replayFake(consolidateNew)),
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
    const ok = await engine.coachGrowthBatch('数学', replayFake(consolidateOk))
    assert.equal(ok.state, 'applied')

    // 前进批产新概念：不受巩固门限制（正常铸名通道）
    const advanceNew = goldVerdict({
      operator: '前进',
      ops: [
        '- op: add_node',
        '  name: 极限初步',
        '  region: 基础',
        '  block: 起点块',
        '  pre: [认识变化率]',
        '  teaches: {极限: 知道}',
      ],
      concepts: ['- canonical: 极限'],
    })
    const adv = await engine.coachGrowthBatch('数学', replayFake(advanceNew))
    assert.equal(adv.state, 'applied')
    assert.equal(adv.applied!.created.join(','), '极限初步')
  })
})

test('停机转译：就绪深度满足时不拉回合（零调用）；force 越过后照常受理', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    const declared = todayStr()
    const r = await engine.graphPropose('seed', `course: 数学
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
    await engine.graphApply('seed', r.id)
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
    ] }))
    const idle = await engine.coachGrowthBatch('数学', fake, { today: addDays(declared, 7)! })
    assert.equal(idle.state, 'idle')
    assert.equal(fake.calls.length, 0, '停摆是判据满足的自然结果——零调用')
    assert.ok(idle.check.ok)

    // force 越过停摆（测试/排障语义）：照常拉回合并受理
    const forced = await engine.coachGrowthBatch('数学', fake, { force: true, today: addDays(declared, 7)! })
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
    const r = await engine.coachGrowthBatch('数学', fake)
    assert.equal(r.state, 'applied')
    assert.equal(r.applied!.ops, 0)
    assert.ok(r.applied!.compass_rewritten)
    assert.deepEqual(r.applied!.created, [])
    const doc = parseCompass(await readFile(paths.compassPath('数学'), 'utf8'))
    assert.match(sectionBody(doc, SECTION_ROUTE)!.trim(), /把变化率说成本质/)
    const props = await engine.graphProposals('applied', 'edit')
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
      const r = await engine.coachGrowthBatch('数学', fake)
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
      await engine.coachGrowthBatch('数学', fake)
      prompts.push(fake.calls[0]!.prompt)
    })
  }
  assert.equal(prompts[0], prompts[1], '同种子同金样本 → 组装字节一致')
})
