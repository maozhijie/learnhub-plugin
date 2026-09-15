import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withVault, localDay } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { systemClock } from '../src/host/clock.ts'
import type { Paths } from '../src/engine/paths.ts'
import { SANDBOX_WORDING } from '../src/engine/sandbox.ts'
import { weekStartOf } from '../src/engine/kata.ts'
import {
  SECTION_ROUTE, SECTION_ANNOTATIONS, SECTION_ETA, ROUTE_PENDING, ANNOTATION_GUIDE, ETA_PENDING,
  ETA_MARKER_PREFIX, parseCompass, sectionBody, withSectionText, validateRouteBody, etaMarkerOf,
  reconcileRoute, hasPaintedRoute,
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

const GOLD_ROUTE = [
  '- **把变化率说成本质**：从日常速度与陡峭感出发建立「变化多快」的直觉，朝导数定义推进。',
  '- **候选：平均变化率台阶**（候选）：补割线→切线的过渡单元，落图由生长批裁决。',
  '- **合成优化视角**：把导数接到极值判断，通向终点「用导数解决优化问题」。',
].join('\n')

const GOLD_ROUTE_2 = GOLD_ROUTE + '\n- **换向预留**：学习者批注提到的应用优先先立占位。'

/** 录制型假实现（#162 起注入 AgentSeam；#163 起罗盘初画走只读工具回路）：脚本化
 * 回路端口进缝——单个应答包装成「一轮收束」的回路会话（无工具调用 = 文本产出即终）；
 * 调用记录留在缝级（会话首请求的 prompt/system/语义档），既有调用数基线断言全部沿用。
 * requests = 逐轮回路历史（工具回灌断言用）。 */
function replayFake(reply: string) {
  const calls: Array<{ prompt: string; system?: string; effort?: string }> = []
  const requests: Array<{ messages: Array<{ role: string; text?: string; isError?: boolean }>; tools?: Array<{ name: string }> }> = []
  const seam = new AgentSeam({
    complete: async (prompt, system, opts) => {
      calls.push({ prompt, system, effort: opts?.effort })
      return reply
    },
    stream: async req => {
      calls.push({ prompt: (req.messages[0] as { text: string }).text, system: req.system, effort: req.effort })
      requests.push({ messages: [...req.messages], tools: req.tools })
      return { text: reply, toolCalls: [] }
    },
  }, systemClock)
  return Object.assign(seam, { calls, requests })
}

async function seedApplied(engine: LearnhubEngine): Promise<void> {
  // #256 种子通道退役：起草夹具直接落盘（等效建课 + 手加终点「导数方向」+ 起草起点/终点），
  // 罗盘脚手架随起草落盘（与退役前 applySeed 的 compass=scaffold 同态）。
  await draftCourse(engine, CAPABILITY_DRAFT)
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

test('AC1 起草落罗盘脚手架；金样本初画全链：单次 deep 调用、路线落位、批注保留', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)

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
    const painted = await engine.growth2.compassPaint('数学', fake)
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

test('#163 罗盘重画经工具回路：裁决前查图自证名字（工具回灌进历史），轨迹随结果带出', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    // 脚本：先请求 graph_view（核实「认识变化率」在图上），收到图面回灌后再产出金路线
    const scripted = (() => {
      const calls: Array<{ prompt: string; system?: string; effort?: string }> = []
      const requests: Array<{ messages: Array<{ role: string; text?: string; toolCalls?: unknown }>; tools?: Array<{ name: string }> }> = []
      const seam = new AgentSeam({
        complete: async prompt => { calls.push({ prompt }); return GOLD_ROUTE },
    stream: async req => {
      calls.push({ prompt: (req.messages[0] as { text: string }).text, effort: req.effort })
      requests.push({ messages: [...req.messages], tools: req.tools })
          if (requests.length === 1) {
            return { text: '先查图面核实起点名。', toolCalls: [{ id: 't1', name: 'graph_view', arguments: '{}' }] }
          }
          return { text: GOLD_ROUTE, toolCalls: [] }
        },
      }, systemClock)
      return Object.assign(seam, { calls, requests })
    })()
    const painted = await engine.growth2.compassPaint('数学', scripted)

    // 回路面：白名单随请求、工具结果回灌进第二轮历史（教练真的看到了图面才裁决）
    assert.equal(scripted.requests.length, 2)
    assert.ok(scripted.requests[0]!.tools!.some(t => t.name === 'graph_view'), '白名单随请求')
    const toolTurn = scripted.requests[1]!.messages[2] as { role: string; text: string }
    assert.equal(toolTurn.role, 'tool')
    assert.match(toolTurn.text, /认识变化率/, '图面回灌给模型（名字取值域在场）')
    // 路线门照旧首过即落盘；轨迹随结果带出（任务消息消费）
    const doc = parseCompass(await readFile(paths.compassPath('数学'), 'utf8'))
    assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), GOLD_ROUTE)
    assert.equal(painted.trajectory.length, 1)
    assert.match(painted.trajectory[0]!, /graph_view/)
    assert.equal(scripted.calls[0]!.effort, 'deep')
  })
})

test('#163 罗盘任务取消传导：旗标翻真即中止，罗盘零改动', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const before = await readFile(paths.compassPath('数学'), 'utf8')
    const fake = replayFake(GOLD_ROUTE)
    await assert.rejects(
      () => engine.growth2.compassPaint('数学', fake, { isCancelled: () => true }),
      /任务已取消/,
    )
    assert.equal(await readFile(paths.compassPath('数学'), 'utf8'), before, '取消后罗盘零改动')
  })
})

test('AC1 金样本回放确定性：同种子 vault 两次初画，罗盘字节级一致', async () => {
  const texts: string[] = []
  for (let i = 0; i < 2; i++) {
    await withVault(SEED_VAULT, async ({ engine, paths }) => {
      await seedApplied(engine)
      await engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE))
      texts.push(await readFile(paths.compassPath('数学'), 'utf8'))
    })
  }
  assert.equal(texts[0], texts[1], '同种子同金样本 → 罗盘字节一致')
})

test('初画路线门负路径：坏产物 fail loud 且罗盘零改动；围栏包裹的合法产物剥壳收下', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    await engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE))
    const before = await readFile(paths.compassPath('数学'), 'utf8')

    // 空产物 / 标题劫持：fail loud，罗盘保持原样
    await assert.rejects(() => engine.growth2.compassPaint('数学', replayFake('   ')), /路线门[\s\S]*为空/)
    await assert.rejects(
      () => engine.growth2.compassPaint('数学', replayFake('## 剩余路线\n\n- 冒充整页')),
      /路线门[\s\S]*标题/,
    )
    assert.equal(await readFile(paths.compassPath('数学'), 'utf8'), before)

    // 围栏包裹会被剥壳（金样本回放里模型爱包围栏）
    await engine.growth2.compassPaint('数学', replayFake('```markdown\n' + GOLD_ROUTE_2 + '\n```'))
    const after = await readFile(paths.compassPath('数学'), 'utf8')
    assert.equal(sectionBody(parseCompass(after), SECTION_ROUTE)?.trim(), GOLD_ROUTE_2)
  })
})

test('AC2 批注区是软输入：初画附进上下文；写权重写保批注；手编路线被覆盖且完成判据零读罗盘', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    await engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE))

    // 学习者手编：批注区写真话、路线乱写、外加一段自留备忘
    const p = paths.compassPath('数学')
    const handText = (await readFile(p, 'utf8'))
      .replace(ANNOTATION_GUIDE, '我想快点走到优化应用，跳过证明类的块。')
      .replace(GOLD_ROUTE, '手编：我要直接学优化。')
      + '\n## 我的备忘\n\n自留段落。\n'
    await writeFile(p, handText, 'utf8')

    // 软输入进上下文：下一次初画的 prompt 带上批注原文（提议非指令由模板锁）
    const fake = replayFake(GOLD_ROUTE_2)
    const repainted = await engine.growth2.compassPaint('数学', fake)
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
    assert.equal(foldWithoutCompass!.length, 2, 'fold 逐终点：锚册两条终点各一条折叠')
    assert.equal(foldWithoutCompass![0]!.complete, false, '手编路线不产生完成宣告')
  })
})

test('换终点（ADR-0076 §三）：removeEndpoint + addEndpoint——锚册与 fold 逐终点收缩，批注区字节保留，罗盘不自动重置', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const p = paths.compassPath('数学')
    await engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE))
    // 批注先写上（模拟学习者手编）
    const withAnn = (await readFile(p, 'utf8')).replace(ANNOTATION_GUIDE, '多来点应用题。')
    await writeFile(p, withAnn, 'utf8')

    // 换掉手加的锚「导数方向」（零 pre 终点节点，摘除不勾谁），换入新终点
    const removed = await engine.graph.removeEndpoint('数学', '导数方向')
    assert.equal(removed.endpoint, '导数方向')
    assert.deepEqual(removed.unhooked, [], '零 pre 终点被摘时无台阶被勾')
    await engine.graph.addEndpoint('数学', '证明微积分基本定理', '能独立证明微积分基本定理')

    // 批注区跨换终点字节保留；罗盘不自动重置——路线重写是教练的写权，机器不越权
    const text = await readFile(p, 'utf8')
    const doc = parseCompass(text)
    assert.equal(sectionBody(doc, SECTION_ANNOTATIONS)?.trim(), '多来点应用题。', '批注区跨换终点字节保留')
    assert.equal(sectionBody(doc, SECTION_ROUTE)?.trim(), GOLD_ROUTE, '罗盘不自动重置（旧路线由教练下轮重写）')

    // 锚册逐终点：换后两条锚 = 起草锚 + 新锚
    const anchorBook = JSON.parse(await readFile(paths.anchorPath('数学'), 'utf8')) as { anchors: Array<{ endpoint: string }> }
    assert.deepEqual(anchorBook.anchors.map(a => a.endpoint).sort(), ['用导数解决优化问题', '证明微积分基本定理'])
  })
})

test('AC3 沙盘 ETA 每周挂载：措辞锁死、标记周幂等、越阈分位带、零终点跳过', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    // 零终点课程跳过（此时还没有任何课程）
    const before = await engine.growth2.compassEtaRefresh()
    assert.deepEqual(before, [])

    await seedApplied(engine)
    const r1 = await engine.growth2.compassEtaRefresh('数学')
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
    const r2 = await engine.growth2.compassEtaRefresh('数学')
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
    await engine.growth2.compassEtaRefresh('数学', { force: true })
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

test('罗盘缺席的读侧：compassRead/compassTail 合法空态；零终点初画 fail loud', async () => {
  await withVault({}, async ({ engine }) => {
    const read = await engine.growth2.compassRead('数学')
    assert.equal(read.missing, true)
    assert.equal(read.route, null)
    assert.deepEqual(read.anchors, [], '零终点课程锚集合为空（合法空态）')
    assert.equal(await engine.growth2.compassTail('数学'), '', '罗盘缺席 = 空段（组装方整段省略）')
    // 零终点初画 fail loud（罗盘按终点组织路线）
    await assert.rejects(() => engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE)), /零终点[\s\S]*先加一个终点/)
  })
})

// ---- #231 罗盘路线对账：条目 vs 图面节点名的粗 diff（零模型、零写侧、非权威） ----

test('#231 对账三态：有锚（引用到图面节点名）/ 标候选（模板允许的未落图台阶）/ 无锚（漂移）', () => {
  const names = ['认识变化率', '用导数解决优化问题']
  const r = reconcileRoute([
    '- **认识变化率**：把变化率说成本质。',
    '- **补割线过渡台阶**（候选）：落图由生长批裁决。',
    '- **合成优化视角**：把导数接到极值判断，通向终点「用导数解决优化问题」。',
  ].join('\n'), names)
  assert.equal(r.entries, 3)
  assert.equal(r.anchored, 2, '引用起点名与终点名都算有锚（终点也是图面节点）')
  assert.equal(r.proposed, 1)
  assert.deepEqual(r.unmoored, [], '三条都有落法 = 零漂移')

  const drifted = reconcileRoute('- **合成优化视角**：把导数接到极值判断。', names)
  assert.deepEqual(drifted.unmoored, ['合成优化视角'], '既无引用也无候选标注 = 漂移，按条目名报出')
  assert.equal(drifted.anchored, 0)
  assert.equal(reconcileRoute('', names).entries, 0, '空路线 = 零条目')
  assert.equal(reconcileRoute('- 某条路线', []).unmoored.length, 1, '空图面 = 无从核对（全无锚）')
})

test('#240 罗盘多终点分节零假漂移：节头行（- **终点名**：）锚在图内终点上，不装成漂移条目', () => {
  const names = ['认识变化率', '用导数解决优化问题', '证明微积分基本定理']
  const r = reconcileRoute([
    '- **用导数解决优化问题**：',
    '- **认识变化率**：先立直觉。',
    '- **证明微积分基本定理**：',
    '- **平均变化率台阶**（候选）：落图由生长批裁决。',
  ].join('\n'), names)
  assert.equal(r.entries, 4, '对账口径逐行不变：两个分节节头也计条目')
  assert.equal(r.anchored, 3, '两个节头（终点名在图内）+ 引用起点的条目都有锚')
  assert.equal(r.proposed, 1, '标注（候选）的未落图台阶照旧走标候选')
  assert.deepEqual(r.unmoored, [], '零假漂移：分节节头不产生假漂移证据行')
})

test('#231 条目名提取：粗体段优先，无粗体退回行首标记后的短名，再退回整行', () => {
  const r = reconcileRoute([
    '- **粗体名**：说明',
    '- 无粗体但很长的条目：说明在后面',
    '1. 编号条目（候选）注记',
    '**只有粗体**',
  ].join('\n'), [])
  assert.equal(r.proposed, 1, '第三条带「候选」→ 标候选（不进无锚）')
  assert.deepEqual(r.unmoored, ['粗体名', '无粗体但很长的条目', '只有粗体'])
})

test('#231 已画路线判据：待初画占位/空白 = 无对账对象（占位文案不得装成漂移条目）', () => {
  assert.equal(hasPaintedRoute(ROUTE_PENDING), false)
  assert.equal(hasPaintedRoute(''), false)
  assert.equal(hasPaintedRoute('   \n  '), false)
  assert.equal(hasPaintedRoute('- 一条路线'), true)
  // 反向证据：占位文案直接进对账会被当成一条巨大的「漂移条目」——所以调用方必须先挡
  assert.equal(reconcileRoute(ROUTE_PENDING, ['x']).unmoored.length, 1)
})

test('#231 挂载点顺带对账：compassEtaRefresh 随行携带 reconcile；未画路线无对账对象', async () => {
  await withVault(SEED_VAULT, async ({ engine, paths }) => {
    await seedApplied(engine)
    const r0 = await engine.growth2.compassEtaRefresh('数学')
    assert.equal(r0[0]!.reconcile, undefined, '待初画 = 无对账对象（占位不是条目）')

    await engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE))
    const routeBefore = sectionBody(parseCompass(await readFile(paths.compassPath('数学'), 'utf8')), SECTION_ROUTE)
    const r1 = await engine.growth2.compassEtaRefresh('数学')
    const rec = r1[0]!.reconcile!
    assert.equal(rec.entries, 3, '金样本三条条目')
    assert.equal(rec.anchored, 1, '第三条引用终点名')
    assert.equal(rec.proposed, 1, '第二条标（候选）')
    assert.deepEqual(rec.unmoored, ['把变化率说成本质'], '第一条被当成确定路标写出、图面却无从核对')
    // 非权威：对账只在读侧算，路线段字节不动（写侧仍唯教练随批重写）
    assert.equal(sectionBody(parseCompass(await readFile(paths.compassPath('数学'), 'utf8')), SECTION_ROUTE), routeBefore)

    // 标记周幂等早退（current）也不丢对账读数
    const r2 = await engine.growth2.compassEtaRefresh('数学')
    assert.equal(r2[0]!.state, 'current')
    assert.equal(r2[0]!.reconcile?.entries, 3)
  })
})

test('#231 周复盘现状区含对账结论：未画路线零小节；画了即出结论（漂移带证据条目名）', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    await seedApplied(engine)
    const bare = await engine.learner.kataOpen()
    assert.doesNotMatch(bare.reality, /### 罗盘对账/, '未画路线 = 零小节（零漂移零噪音）')

    await engine.growth2.compassPaint('数学', replayFake(GOLD_ROUTE))
    const doc = await engine.learner.kataOpen()
    assert.match(doc.reality, /### 罗盘对账/, '周复盘现状区含对账结论')
    assert.match(doc.reality, /- 数学：路线漂移 1 条——「把变化率说成本质」在图面无对应节点、也未标「（候选）」。/)
    assert.match(doc.reality, /不改罗盘、不触发重画/, '措辞沿罗盘非权威纪律')

    // 零漂移的路线：只剩一行结论、不出现告警行（零噪音）
    await engine.growth2.compassRewrite('数学', '- **认识变化率**：先立直觉。\n- **用导数解决优化问题**：接到终点。')
    const clean = await engine.learner.kataOpen()
    assert.match(clean.reality, /- 数学：路线 2 条条目与图面一致（2 条有锚）。/)
    assert.doesNotMatch(clean.reality, /路线漂移/)
  })
})
