import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withVault, localDay } from './helpers/vault.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import type { Paths } from '../src/engine/paths.ts'
import { SANDBOX_WORDING } from '../src/engine/sandbox.ts'
import { weekStartOf } from '../src/engine/kata.ts'
import {
  SECTION_ROUTE, SECTION_ANNOTATIONS, SECTION_ETA, ROUTE_PENDING, ANNOTATION_GUIDE, ETA_PENDING,
  ETA_MARKER_PREFIX, parseCompass, sectionBody, withSectionText, validateRouteBody, etaMarkerOf,
} from '../src/engine/compass.ts'
import { AgentSeam } from '../src/engine/agent.ts'

// 罗盘（#143 / ADR-0033 透明度装置）：课程根常驻的非承诺路线草图（罗盘.md）。
// - 种子 apply 落罗盘脚手架；罗盘初画（模板 v1、deep 档、单次调用）产出剩余路线初稿，
//   过金样本回放闸（首过无修复轮、调用数恒 1、同种子回放字节一致）。
// - 学习者批注区 = 教练软输入（提议非指令），跨重写/初画/ETA 挂载字节保留；
//   手编路线不产生权威变更——下次重写被覆盖，完成判据折叠零读罗盘。
// - 「剩余路线」唯一写权接口 = engine.compassRewrite（调用方是生长批受理票 #145）。
// - 沙盘 ETA 每周随周复盘挂载（标记周幂等），措辞锁死「模型推演，非承诺」。

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

const GOLD_ROUTE = [
  '- **把变化率说成本质**：从日常速度与陡峭感出发建立「变化多快」的直觉，朝导数定义推进。',
  '- **候选：平均变化率台阶**（候选）：补割线→切线的过渡单元，落图由生长批裁决。',
  '- **合成优化视角**：把导数接到极值判断，通向终点「用导数解决优化问题」。',
].join('\n')

const GOLD_ROUTE_2 = GOLD_ROUTE + '\n- **换向预留**：学习者批注提到的应用优先先立占位。'

/** 录制型假实现（#162 起注入 AgentSeam）：脚本化补全端口进缝，调用记录留在端口层
 * （prompt/system/语义档经缝直通），固定回放同一应答。 */
function replayFake(reply: string) {
  const calls: Array<{ prompt: string; system?: string; effort?: string }> = []
  const seam = new AgentSeam({
    complete: async (prompt, system, opts) => {
      calls.push({ prompt, system, effort: opts?.effort })
      return reply
    },
  }, systemClock)
  return Object.assign(seam, { calls })
}

async function seedApplied(
  engine: LearnhubEngine,
): Promise<{ compass: { state: string; annotations_preserved: boolean } }> {
  const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
  return await engine.graphApply('seed', r.id) as { compass: { state: string; annotations_preserved: boolean } }
}

/** 测试用最小罗盘正文（与 compassScaffold 同构）。 */
function compassFileForTest(): string {
  return [
    '# 罗盘 · 测试', '',
    `## ${SECTION_ROUTE}`, '', ROUTE_PENDING, '',
    `## ${SECTION_ANNOTATIONS}`, '', ANNOTATION_GUIDE, '',
    `## ${SECTION_ETA}`, '', ETA_PENDING, '',
  ].join('\n')
}

test('纯函数：段级合并保留段外字节、未知段原样保留、路线门三查', () => {
  const base = compassFileForTest()
  // 段级替换：其余段字节保留
  const next = withSectionText(base, SECTION_ROUTE, GOLD_ROUTE)
  const doc = parseCompass(next)
  assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), GOLD_ROUTE)
  assert.equal(sectionBody(doc, SECTION_ANNOTATIONS)?.trim(), ANNOTATION_GUIDE)
  assert.equal(sectionBody(doc, SECTION_ETA)?.trim(), ETA_PENDING)
  // 学习者手写的未知 `## ` 段原样保留；缺席段追加在末尾
  const withExtra = withSectionText(base + '\n## 我的备忘\n\n先补概率。\n', SECTION_ROUTE, GOLD_ROUTE)
  assert.match(withExtra, /## 我的备忘\n\n先补概率。/)
  const withNew = withSectionText(base, '新增段', '内容')
  assert.match(withNew, /## 新增段\n\n内容/)
  // 路线门：空正文 / `## ` 标题劫持 / 超限
  assert.ok(validateRouteBody('   ').some(e => e.includes('为空')))
  assert.ok(validateRouteBody('- ok\n## 劫持\n').some(e => e.includes('标题')))
  assert.ok(validateRouteBody('x'.repeat(4001)).some(e => e.includes('超出上限')))
  assert.deepEqual(validateRouteBody(GOLD_ROUTE), [])
})

test('AC1 种子 apply 落罗盘脚手架；金样本初画全链：单次 deep 调用、路线落位、批注保留', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    const applied = await seedApplied(engine)
    assert.equal(applied.compass.state, 'scaffold')

    // 脚手架三段式：路线待初画、批注区引导、ETA 待刷新
    const p = paths.compassPath('数学')
    const scaffold = await readFile(p, 'utf8')
    const doc = parseCompass(scaffold)
    assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), ROUTE_PENDING)
    assert.equal(sectionBody(doc, SECTION_ANNOTATIONS)?.trim(), ANNOTATION_GUIDE)
    assert.equal(sectionBody(doc, SECTION_ETA)?.trim(), ETA_PENDING)
    assert.match(scaffold, /永不进完成判据/)

    // 金样本初画：一次 deep 调用、上下文带终点锚/起点、首过落盘
    const fake = replayFake(GOLD_ROUTE)
    const painted = await engine.compassPaint('数学', fake)
    assert.equal(fake.calls.length, 1, '调用数基线：初画恒一次调用（无修复轮）')
    assert.equal(fake.calls[0]!.effort, 'deep')
    assert.match(fake.calls[0]!.prompt, /罗盘初画/)
    assert.match(fake.calls[0]!.prompt, /用导数解决优化问题/)
    assert.match(fake.calls[0]!.prompt, /认识变化率/)
    assert.equal(painted.route_lines, GOLD_ROUTE.split('\n').length)
    assert.equal(painted.repainted, false, '初画 = 脚手架上的第一次产出')

    // 路线原样落位在「剩余路线」段内，批注区/ETA 不动
    const paintedText = await readFile(p, 'utf8')
    const paintedDoc = parseCompass(paintedText)
    assert.equal(sectionBody(paintedDoc, SECTION_ROUTE)?.trim(), GOLD_ROUTE)
    assert.equal(sectionBody(paintedDoc, SECTION_ANNOTATIONS)?.trim(), ANNOTATION_GUIDE)
    assert.equal(sectionBody(paintedDoc, SECTION_ETA)?.trim(), ETA_PENDING)
    const journal = await readFile(join(paths.centerRoot, 'state', 'journal.jsonl'), 'utf8')
    assert.match(journal, /compass_paint/)
  })
})

test('AC1 金样本回放确定性：同种子 vault 两次初画，罗盘字节级一致', async () => {
  const texts: string[] = []
  for (let i = 0; i < 2; i++) {
    await withVault(SEED_VAULT, async ({ engine, paths }) => {
      await seedApplied(engine)
      await engine.compassPaint('数学', replayFake(GOLD_ROUTE))
      texts.push(await readFile(paths.compassPath('数学'), 'utf8'))
    })
  }
  assert.equal(texts[0], texts[1], '同种子同金样本 → 罗盘字节一致')
})

test('初画路线门负路径：坏产物 fail loud 且罗盘零改动；围栏包裹的合法产物剥壳收下', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    await engine.compassPaint('数学', replayFake(GOLD_ROUTE))
    const before = await readFile(paths.compassPath('数学'), 'utf8')

    // 空产物 / 标题劫持：fail loud，罗盘保持原样
    await assert.rejects(() => engine.compassPaint('数学', replayFake('   ')), /路线门[\s\S]*为空/)
    await assert.rejects(
      () => engine.compassPaint('数学', replayFake('## 剩余路线\n\n- 冒充整页')),
      /路线门[\s\S]*标题/,
    )
    assert.equal(await readFile(paths.compassPath('数学'), 'utf8'), before)

    // 围栏包裹会被剥壳（金样本回放里模型爱包围栏）
    await engine.compassPaint('数学', replayFake('```markdown\n' + GOLD_ROUTE_2 + '\n```'))
    const after = await readFile(paths.compassPath('数学'), 'utf8')
    assert.equal(sectionBody(parseCompass(after), SECTION_ROUTE)?.trim(), GOLD_ROUTE_2)
  })
})

test('AC2 批注区是软输入：初画附进上下文；写权重写保批注；手编路线被覆盖且完成判据零读罗盘', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    await engine.compassPaint('数学', replayFake(GOLD_ROUTE))

    // 学习者手编：批注区写真话、路线乱写、外加一段自留备忘
    const p = paths.compassPath('数学')
    const handText = (await readFile(p, 'utf8'))
      .replace(ANNOTATION_GUIDE, '我想快点走到优化应用，跳过证明类的块。')
      .replace(GOLD_ROUTE, '手编：我要直接学优化。')
      + '\n## 我的备忘\n\n自留段落。\n'
    await writeFile(p, handText, 'utf8')

    // 软输入进上下文：下一次初画的 prompt 带上批注原文（提议非指令由模板锁）
    const fake = replayFake(GOLD_ROUTE_2)
    const repainted = await engine.compassPaint('数学', fake)
    assert.match(fake.calls[0]!.prompt, /我想快点走到优化应用，跳过证明类的块。/)
    assert.match(fake.calls[0]!.prompt, /软输入/)
    assert.equal(repainted.annotations_preserved, true)
    assert.equal(repainted.repainted, true)
    // 重画后：批注与自留段保留，手编路线被教练版本覆盖（手编不权威）
    const text = await readFile(p, 'utf8')
    const doc = parseCompass(text)
    assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), GOLD_ROUTE_2)
    assert.equal(sectionBody(doc, SECTION_ANNOTATIONS)?.trim(), '我想快点走到优化应用，跳过证明类的块。')
    assert.match(text, /## 我的备忘/)

    // 罗盘尾段（#144 教练上下文消费缝）：路线 + 批注软输入成块
    const tail = await engine.growth2.compassTail('数学')
    assert.match(tail, /剩余路线/)
    assert.match(tail, /提议非指令/)
    assert.match(tail, /跳过证明类的块/)

    // 写权接口：批注区、ETA、自留段字节保留，只换路线
    await engine.growth2.compassRewrite('数学', GOLD_ROUTE)
    const afterRewrite = await readFile(p, 'utf8')
    const doc2 = parseCompass(afterRewrite)
    assert.equal(sectionBody(doc2, SECTION_ROUTE)?.trim(), GOLD_ROUTE)
    assert.equal(sectionBody(doc2, SECTION_ANNOTATIONS)?.trim(), '我想快点走到优化应用，跳过证明类的块。')
    assert.match(afterRewrite, /## 我的备忘/)

    // 完成判据折叠零读罗盘：手编「已完成」路线与罗盘整个删掉，fold 完全一致
    const foldWithHandRoute = await engine.courseCompletion({ name: '数学', root: '数学' })
    await rm(p)
    const foldWithoutCompass = await engine.courseCompletion({ name: '数学', root: '数学' })
    assert.deepEqual(foldWithHandRoute, foldWithoutCompass)
    assert.equal(foldWithoutCompass!.complete, false, '手编路线不产生完成宣告')
  })
})

test('reseed：批注区跨换终点保留，路线与 ETA 重置待初画/待刷新', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const p = paths.compassPath('数学')
    await engine.compassPaint('数学', replayFake(GOLD_ROUTE))
    // 批注 + ETA 先挂上（模拟已运行一周）
    const withAnn = (await readFile(p, 'utf8')).replace(ANNOTATION_GUIDE, '多来点应用题。')
    await writeFile(p, withAnn, 'utf8')
    await engine.compassEtaRefresh('数学')

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
`
    const r = await engine.graph.graphPropose('seed', reseed) as { id: number }
    const applied = await engine.graphApply('seed', r.id) as { compass: { state: string; annotations_preserved: boolean } }
    assert.equal(applied.compass.state, 'reseeded')
    assert.equal(applied.compass.annotations_preserved, true)

    const text = await readFile(p, 'utf8')
    const doc = parseCompass(text)
    assert.equal(sectionBody(doc, SECTION_ANNOTATIONS)?.trim(), '多来点应用题。', '批注区跨换终点字节保留')
    assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), ROUTE_PENDING, '旧路线锚在旧终点上，重置待初画')
    assert.equal(sectionBody(doc, SECTION_ETA)?.trim(), ETA_PENDING, '旧 ETA 是旧结构的推演，重置待刷新')
    assert.equal(etaMarkerOf(sectionBody(doc, SECTION_ETA)), null)
  })
})

test('AC3 沙盘 ETA 每周挂载：措辞锁死、标记周幂等、越阈分位带、未播种跳过', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    // 未播种课程跳过（此时还没有任何课程）
    const before = await engine.compassEtaRefresh()
    assert.deepEqual(before, [])

    await seedApplied(engine)
    const r1 = await engine.compassEtaRefresh('数学')
    assert.deepEqual(r1.map(x => x.state), ['refreshed'])
    const p = paths.compassPath('数学')
    const text1 = await readFile(p, 'utf8')
    const doc1 = parseCompass(text1)
    const eta = sectionBody(doc1, SECTION_ETA)!
    const week = weekStartOf(localDay())!
    // 机器标记 + 措辞锁死 + 阈值口径 + 分位带读数
    assert.ok(eta.trim().startsWith(`${ETA_MARKER_PREFIX}${week} -->`), '标记周 = 当前学习周')
    assert.ok(eta.includes(SANDBOX_WORDING), '非承诺措辞锁死')
    assert.match(eta, /终点「用导数解决优化问题」掌握度阈值 80%/)
    assert.match(eta, /分位带（终点掌握度）：4 周 p50=/)
    // 批注/路线段不受挂载影响
    assert.equal(sectionBody(doc1, SECTION_ROUTE)?.trim(), ROUTE_PENDING)

    // 同周幂等：第二次挂载 current，文件字节不变
    const r2 = await engine.compassEtaRefresh('数学')
    assert.deepEqual(r2.map(x => x.state), ['current'])
    assert.equal(await readFile(p, 'utf8'), text1)

    // 越阈分位带：终点已掌握（stability 60 + ema 0.95 → mastery 0.99 ≥ 0.8）→ 首档即达
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
    await engine.compassEtaRefresh('数学', { force: true })
    const eta2 = sectionBody(parseCompass(await readFile(p, 'utf8')), SECTION_ETA)!
    assert.match(eta2, /p50 口径≤ 4 周/, '已掌握终点在首个探测档即越阈')
    assert.match(eta2, /p80 口径≤ 4 周/)
    assert.match(eta2, /4 周 p50=98%\/p80=98%/, '分位带读数随行（mastery=0.7·1+0.3·0.95 的 FP 舍入 0.98）')
  })
})

test('AC3 挂周复盘：kataOpen 触发罗盘 ETA 挂载', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    await engine.learner.kataOpen()
    const doc = parseCompass(await readFile(paths.compassPath('数学'), 'utf8'))
    assert.equal(etaMarkerOf(sectionBody(doc, SECTION_ETA)), weekStartOf(localDay()!), '周复盘打开即挂载当周 ETA')
  })
})

test('罗盘缺席的读侧：compassRead/compassTail 合法空态；未播种初画 fail loud', async () => {
  await withVault({}, async ({ engine }) => {
    const read = await engine.compassRead('数学')
    assert.equal(read.missing, true)
    assert.equal(read.route, null)
    assert.equal(read.endpoint, null, '未播种课程锚缺席 = null')
    assert.equal(await engine.growth2.compassTail('数学'), '', '罗盘缺席 = 空段（组装方整段省略）')
    // 未播种初画 fail loud（锚在终点上）
    await assert.rejects(() => engine.compassPaint('数学', replayFake(GOLD_ROUTE)), /未播种[\s\S]*种子提案/)
  })
})
