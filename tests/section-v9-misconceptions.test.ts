/**
 * 误解目录与节段 v9 换装（#147）。
 *
 * - 节段难度档：deriveSectionTier 纯函数（缺席按节位置+节点难度推导，不回填）、
 *   parseOutline 收录/丢弃非法 tier、视图 tierLabel 解析（清单值优先）。
 * - 节段 v9 模板换装过金样本回放闸：contentOutline + contentSection 全链落盘，
 *   同种子 vault 两次跑笔记文件字节级一致。
 * - 误解目录三条消费链在注入样例上可见：思维轨迹踩坑（contextPack §11/§12）、
 *   错误对比卡出生期候选错法、干扰项材料（出题两通道）。
 * - QC 格式类门禁程序化修复（别名）与修复轮块级局部修补（plan/prompt/splice）。
 * - 审计面 R18 概念字段盘点（档位零门禁零调度的确认面）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Content } from '../src/engine/content.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { todayStr } from '../src/engine/dates.ts'
import { deriveSectionTier, sectionTierLabel } from '../src/engine/complexity.ts'
import { Graph, GraphStore } from '../src/engine/graph.ts'
import { runAudit } from '../src/engine/audit.ts'
import type { LlmComplete } from '../src/engine/llm.ts'
import { withVault } from './helpers/vault.ts'

/** 录制型假实现（同 llm-seam.test.ts 口径）：记 prompt，固定回放同一应答。 */
function replayFake(reply: string) {
  const calls: Array<{ prompt: string }> = []
  const fn: LlmComplete = async prompt => {
    calls.push({ prompt })
    return reply
  }
  return Object.assign(fn, { calls })
}

/** 主 vault：入门（difficulty 3，无 PS-I）带 teaches/assumes/误解各一组。 */
const MISC_GRAPH = `
region: 基础
color: blue
blocks:
  - name: 入门块
    nodes:
      - name: 入门
        pre: []
        opt: false
        note: ""
        est: 20
        difficulty: 3
        teaches: { 鸽巢原理: 会用 }
        assumes: { 计数: 知道 }
        misconceptions:
          - { concept: 鸽巢原理, model: 把「总有一个巢至少两只」误记成「每个巢都有两只」 }
`

const MIS_MODEL = /把「总有一个巢至少两只」误记成「每个巢都有两只」/

const OUTLINE_YAML = [
  'node: 入门',
  'sections:',
  '  - id: s1',
  '    title: 概念：鸽巢原理',
  '    type: 概念',
  '    tier: 低',
  '  - id: s2',
  '    title: 例题：放球',
  '    type: 例题',
].join('\n')

/** 金样本节正文（过质检门：短正文、无可视化块、无机器块）。 */
const GOLD_S1 = '## 概念：鸽巢原理\n\n把不少于 n 只鸽放进 n 个巢，总有一个巢里至少两只。\n\n> **误区**：以为均匀分布是必然的。\n'
const GOLD_S2 = '## 例题：放球\n\n把 3 个球放进 2 个抽屉，必有一个抽屉至少 2 个球。\n'

async function seedOutline(engine: { contentOutline: (c: string, n: string, y: string) => Promise<unknown> }) {
  return engine.contentOutline('数学', '入门', OUTLINE_YAML)
}

// ---- 节段难度档：推导纯函数 ----

test('deriveSectionTier：基档随节点 difficulty，节位置做递进（前 1/3 降、后 1/3 升）', () => {
  assert.equal(deriveSectionTier(3, undefined, 1, 1), 2, '单节 = 基档不调')
  assert.deepEqual(
    [1, 2, 3].map(p => deriveSectionTier(3, undefined, p, 3)),
    [1, 2, 3],
    '中难节点三节：低/中/高（替换写死的开头 d1/中间 d2/收尾 d3）',
  )
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(p => deriveSectionTier(3, undefined, p, 6)),
    [1, 1, 2, 2, 3, 3],
    '六节单调递进',
  )
  assert.deepEqual(
    [1, 2, 3].map(p => deriveSectionTier(1, undefined, p, 3)),
    [1, 1, 2],
    '低难节点：低/低/中（升档封顶不越界）',
  )
  assert.deepEqual(
    [1, 2, 3].map(p => deriveSectionTier(5, undefined, p, 3)),
    [2, 3, 3],
    '高难节点：中/高/高（降档地板 1 之上）',
  )
})

test('deriveSectionTier：difficulty 缺席按 est 回退，都缺兜底中档；越界 position 收敛', () => {
  assert.equal(deriveSectionTier(undefined, 10, 1, 1), 1, 'est ≤15 → 低')
  assert.equal(deriveSectionTier(undefined, undefined, 2, 1), 2, '都缺 → 中')
  assert.equal(deriveSectionTier(3, undefined, 0, 3), 1, 'position 0 收敛进开头带')
  assert.equal(deriveSectionTier(3, undefined, 99, 3), 3, 'position 超界收敛进结尾带')
})

test('sectionTierLabel：清单值优先，非法清单值视为缺席走推导', () => {
  assert.equal(sectionTierLabel('高', 1, undefined, 1, 1), '高', '在场清单值直接用')
  assert.equal(sectionTierLabel('废话', 3, undefined, 3, 3), '高', '非法值 → 推导（pos3/3 → 基档+1）')
  assert.equal(sectionTierLabel(undefined, 3, undefined, 2, 3), '中', '缺席 → 推导（中段持平）')
})

// ---- parseOutline：tier 收录与非法值丢弃 ----

test('parseOutline：合法 tier 进清单，非法值丢弃（缺席推导，不拒收——档位不进门禁）', () => {
  const ms = Content.parseOutline([
    'node: x',
    'sections:',
    '  - id: s1',
    '    title: 概念：A',
    '    type: 概念',
    '    tier: 高',
    '  - id: s2',
    '    title: 例题：B',
    '    type: 例题',
    '    tier: 超难',
  ].join('\n'))
  assert.equal(ms[0]!.tier, '高')
  assert.equal(ms[1]!.tier, undefined, '非法 tier 视为缺席')
})

// ---- 视图：tierLabel 解析（清单值优先、缺席推导、不回填） ----

test('contentSectionsView：tierLabel 清单值优先、缺席按位置推导，且不回填清单', async () => {
  await withVault({
    tag: 'v9-tier-view-',
    graph: MISC_GRAPH,
    notes: { 入门: {} },
  }, async ({ engine, paths }) => {
    await seedOutline(engine)
    const views = await engine.contentSectionsView('数学', '入门')
    assert.equal(views[0]!.tierLabel, '低', 's1 清单 tier=低 在场直接用')
    assert.equal(views[1]!.tierLabel, '高', 's2 缺席 → 推导（difficulty 3 基中，pos2/2 → 高）')
    // 不回填：视图解析后 frontmatter 里 s2 仍无 tier 字段
    const notePath = paths.courseNotePath('math', '基础', '入门')
    const raw = await readFile(notePath, 'utf8')
    const s2Block = raw.slice(raw.indexOf('s2'))
    assert.doesNotMatch(s2Block.slice(0, s2Block.indexOf('title') >= 0 ? s2Block.indexOf('title') : s2Block.length), /tier/, 's2 清单项未回填 tier')
    assert.match(raw, /tier: 低/, 's1 的清单值仍在')
  })
})

// ---- 金样本回放闸：大纲 + 逐节落盘全链确定性 ----

test('金样本回放：v9 换装后大纲+逐节落盘全链，同种子 vault 笔记字节级一致', async () => {
  const run = () => withVault({
    tag: 'v9-gold-',
    graph: MISC_GRAPH,
    notes: { 入门: {} },
  }, async ({ engine, paths }) => {
    await seedOutline(engine)
    const r1 = await engine.contentSection('数学', '入门', 's1', GOLD_S1)
    const r2 = await engine.contentSection('数学', '入门', 's2', GOLD_S2)
    const notePath = paths.courseNotePath('math', '基础', '入门')
    return { r1, r2, note: await readFile(notePath, 'utf8') }
  })
  const a = await run()
  const b = await run()
  assert.equal(a.r1.version, b.r1.version)
  assert.equal(a.note, b.note, '同种子同金样本 → 课程笔记字节级一致')
  assert.match(a.note, /总有一个巢里至少两只/)
})

// ---- 误解目录消费链 1：思维轨迹踩坑供给（contextPack §11/§12） ----

test('误解坑位进上下文包 §12；assumes 档位进 §13；缺席整段省略（Missing 合法空态）', async () => {
  await withVault({ tag: 'v9-pack-', graph: MISC_GRAPH, notes: { 入门: {} } }, async ({ engine }) => {
    const pack = await engine.contentPack('数学', '入门')
    assert.match(pack, /## 12\. 误解坑位（生成期先验；讲到对应概念时预埋坑位警示）/)
    assert.match(pack, MIS_MODEL, '误解错误模型文字进包')
    assert.match(pack, /## 13\. 前置概念档位（assumes；写作时按档位把握「能默认学习者会什么」）/)
    assert.match(pack, /- 计数：知道/, '前置档位条目进包')
    assert.doesNotMatch(pack, /## 10\. 先做后教/, 'difficulty 3 未达 PS-I 阈值，§10/§11 不出现')
  })
  await withVault({ tag: 'v9-pack-empty-' }, async ({ engine }) => {
    const pack = await engine.contentPack('数学', '入门')
    assert.doesNotMatch(pack, /误解坑位/, '无误解 → §12 整段省略')
    assert.doesNotMatch(pack, /前置概念档位/, '无 assumes → §13 整段省略')
  })
})

test('PS-I 高难节点的 §11 踩坑选材接线：§12 在场时坑必须从登记先验中取', async () => {
  const PSI_GRAPH = MISC_GRAPH.replace('difficulty: 3', 'difficulty: 4')
  await withVault({ tag: 'v9-pack-psi-', graph: PSI_GRAPH, notes: { 入门: {} } }, async ({ engine }) => {
    const pack = await engine.contentPack('数学', '入门')
    assert.match(pack, /## 11\. 专家思维轨迹/)
    assert.match(pack, /坑位选材：§12 附有误解坑位时\*\*必须\*\*从其中选一条与演示题同族的（登记在册的先验优先）/)
    assert.match(pack, MIS_MODEL)
  })
})

// ---- 误解目录消费链 3：干扰项材料（出题两通道） ----

const GOLD_BANK = [
  '```yaml',
  'node: 入门',
  'questions:',
  '  - kind: true_false',
  '    q: 金样本题：鸽巢原理说的是必然存在一个巢至少两只。',
  '    answer: true',
  '    difficulty: 1',
  '    section: 通用',
  '    invokes: 鸽巢原理',
  '```',
].join('\n')

/** 出生打标（#148）：invokes 在册校验需要登记表在册（MISC_GRAPH 的 teaches 概念）。 */
const REGISTRY = [{ path: '学习中心/math/概念登记表.yaml', content: 'concepts:\n  - canonical: 鸽巢原理\n' }]

test('questionGenerate：提示词附「误解先验（干扰项材料）」段（有误解才附）', async () => {
  await withVault({
    tag: 'v9-quiz-mis-',
    graph: MISC_GRAPH,
    notes: { 入门: { content: { version: 1, status: 'draft' }, body: ['# 入门', '', '鸽巢原理：把 n+1 只鸽放进 n 个巢，必有一巢至少两只。'] } },
    files: REGISTRY,
  }, async ({ engine }) => {
    const fake = replayFake(GOLD_BANK)
    const r = await engine.questionGenerate('数学', '入门', undefined, fake)
    assert.equal(r.added, 1)
    assert.match(fake.calls[0]!.prompt, /## 误解先验（干扰项材料）/)
    assert.match(fake.calls[0]!.prompt, MIS_MODEL)
  })
  await withVault({
    tag: 'v9-quiz-nomis-',
    notes: { 入门: { content: { version: 1, status: 'draft' }, body: ['# 入门', '', '鸽巢原理正文。'] } },
    files: REGISTRY,
  }, async ({ engine }) => {
    const fake = replayFake(GOLD_BANK)
    await engine.questionGenerate('数学', '入门', undefined, fake)
    assert.doesNotMatch(fake.calls[0]!.prompt, /## 误解先验/, '无误解 → 注入段缺席（模板措辞含词条不算）')
  })
})

test('questionGenerateSections：逐节难度锚走节段难度档（清单值/推导各走一遍）+ 误解先验段', async () => {
  await withVault({
    tag: 'v9-quiz-sections-',
    graph: MISC_GRAPH,
    notes: { 入门: {} },
    files: REGISTRY,
  }, async ({ engine }) => {
    await seedOutline(engine)
    await engine.contentSection('数学', '入门', 's1', GOLD_S1)
    await engine.contentSection('数学', '入门', 's2', GOLD_S2)
    const fake = replayFake(GOLD_BANK)
    const r = await engine.questionGenerateSections('数学', '入门', fake)
    assert.equal(fake.calls.length, 2, '两个内容节各一次调用')
    assert.match(fake.calls[0]!.prompt, /本节难度档：低/, 's1 清单 tier=低')
    assert.match(fake.calls[1]!.prompt, /本节难度档：高/, 's2 推导 = 高（pos2/2，基中+1）')
    assert.match(fake.calls[0]!.prompt, MIS_MODEL, '逐节出题同样附误解先验')
    assert.doesNotMatch(fake.calls[0]!.prompt, /本节属低复杂度节点/, '旧的节点级锚口径退役')
    assert.equal(r.sections, 2)
  })
})

// ---- 误解目录消费链 2：错误对比卡出生期候选错法 ----

const ERR_BANK = [
  'node: 入门',
  'questions:',
  '  - id: q1',
  '    kind: single_choice',
  '    q: 4 只鸽放进 3 个巢，结论是？',
  '    options: ["必有一巢至少 2 只", "每巢恰 1 只", "必有一巢至少 4 只", "以上都不对"]',
  '    answer: A',
  '    explanation: 鸽巢原理。',
  '    section: s1',
].join('\n')

const ERR_CARD_YAML = [
  'cards:',
  '  - node: 入门',
  '    source_q: q1',
  '    q: 把 5 只鸽放进 4 个巢，下面哪个结论成立？',
  '    options: ["必有一巢至少 2 只", "每巢最多 1 只", "可能每巢都有鸽"]',
  '    answer: 必有一巢至少 2 只',
  '    mine: 每巢最多 1 只',
  '    explanation: 鸽比巢多时必有巢共享；「每巢最多 1 只」与鸽多矛盾。',
].join('\n')

test('errorCardGenerate：材料附「误解先验（出生期候选错法）」，真实错答仍在场', async () => {
  await withVault({
    tag: 'v9-errcard-',
    graph: MISC_GRAPH,
    banks: { 入门: ERR_BANK },
  }, async ({ engine }) => {
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 1, answer: 'B', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-07T10:00:00' })
    await engine.store.appendPractice({ course: '数学', node: '入门', ex: 2, answer: 'B', correct: false, judge: 'single_choice', qid: 'q1', ts: '2026-09-08T10:00:00' })
    const fake = replayFake(ERR_CARD_YAML)
    const r = await engine.errorCardGenerate('数学', undefined, fake)
    assert.equal(r.generated.length, 1)
    assert.match(fake.calls[0]!.prompt, /误解先验（出生期候选错法；「干扰做法」项可从中改编，mine 仍以学习者错答为准）/)
    assert.match(fake.calls[0]!.prompt, MIS_MODEL)
    assert.match(fake.calls[0]!.prompt, /学习者的错答（去重，最近在前）：「B」/, '真实错答仍在材料里（先验让位）')
  })
})

// ---- QC：别名程序化修复 ----

const ALIAS_DOC = [
  '# 理念与规范',
  '',
  '## 8. 别名表',
  '',
  '| 采用名 | 不采用名 |',
  '|---|---|',
  '| 勾股定理 | 毕达哥拉斯定理 |',
  '',
].join('\n')

test('QC 程序化修复：别名不一致落盘前确定性替换，repairs 留痕，门禁不再报别名 finding', async () => {
  await withVault({
    tag: 'v9-alias-',
    files: [{ path: join('学习中心', 'math', '理念与规范.md'), content: ALIAS_DOC }],
    notes: { 入门: {} },
  }, async ({ engine }) => {
    await seedOutline(engine)
    const md = '## 概念：鸽巢原理\n\n毕达哥拉斯定理说直角边平方和等于斜边平方。\n'
    const r = await engine.contentSection('数学', '入门', 's1', md)
    assert.deepEqual(r.repairs, ['毕达哥拉斯定理→勾股定理'])
    const views = await engine.contentSectionsView('数学', '入门')
    assert.match(views[0]!.md!, /勾股定理说直角边平方和/)
    assert.doesNotMatch(views[0]!.md!, /毕达哥拉斯定理/)
    // 只读校验不受写侧修复影响：合法正文过门
    const check = await engine.contentCheck('数学', '入门')
    assert.equal(check.passed, true)
  })
})

// ---- QC：修复轮块级局部修补 ----

test('blockPatchPlan：全部 ✗ 定位到违规块才出计划；混入非块级 finding 返回 null', () => {
  const body = '## 概念：A\n\n说明。\n\n```plot\n{"a":\n```\n'
  const gate = '[section] 「概念：A」质检门未过：\n  ✗ ```plot 第 1 块不是合法 JSON 对象（面板会降级为源码显示）\n  ⚠ 正文偏长\n'
  const plan = Content.blockPatchPlan(body, gate)
  assert.ok(plan, '单一块级 finding → 出计划（⚠ 警告不计入）')
  assert.equal(plan!.length, 1)
  assert.match(plan![0]!.original, /```plot\n\{"a":/)
  const mixed = Content.blockPatchPlan(body, gate + '  ✗ 节「概念：A」正文过长（约 999 字 > 拒收线 500 字）\n')
  assert.equal(mixed, null, '块级 + 节级混排 → 回退整节修复')
  assert.equal(Content.blockPatchPlan(body, '✗ 节「A」可视化块 3 个超过上限 2\n'), null, '非块编号 finding 无块可定位')
})

test('blockPatchPlan：predict 块按自身编号定位', () => {
  const body = '## 思维：A\n\n```learnhub-predict\nanswer: 不是选项原文\n```\n'
  const gate = '  ✗ ```learnhub-predict 第 1 块不合法：answer 必须是 options 中一项的原文\n'
  const plan = Content.blockPatchPlan(body, gate)
  assert.ok(plan)
  assert.equal(plan![0]!.kind, 'learnhub-predict')
  assert.match(plan![0]!.original, /learnhub-predict/)
})

test('blockPatchPrompt/applyBlockPatch/extractFencedBlocks：逐块替换、数量不符拒拼', () => {
  const original = '## 概念：A\n\n```plot\n{"a":\n```\n\n```svg\nnot svg\n```\n'
  const gate = '  ✗ ```plot 第 1 块不是合法 JSON 对象（面板会降级为源码显示）\n  ✗ ```svg 第 1 块必须以 <svg 开头（完整 SVG 片段）\n'
  const plan = Content.blockPatchPlan(original, gate)
  assert.equal(plan!.length, 2)
  const prompt = Content.blockPatchPrompt(plan!)
  assert.match(prompt, /违规块 1/)
  assert.match(prompt, /违规块 2/)
  assert.match(prompt, /按违规块清单顺序/)
  const modelOut = '好的，修复如下：\n\n```plot\n{"a": 1}\n```\n\n```svg\n<svg viewBox="0 0 1 1"></svg>\n```\n'
  const blocks = Content.extractFencedBlocks(modelOut)
  assert.equal(blocks.length, 2, '散文与围栏行都剥掉，只留块')
  const merged = Content.applyBlockPatch(original, plan!, blocks)
  assert.match(merged!, /```plot\n\{"a": 1\}\n```/)
  assert.match(merged!, /<svg viewBox="0 0 1 1">/)
  assert.match(merged!, /^## 概念：A/, '块外内容零改动')
  assert.equal(Content.applyBlockPatch(original, plan!, [blocks[0]!]), null, '替换块数量不符 → null（回退整节）')
})

// ---- 审计面 R18：概念字段组盘点（档位零门禁零调度确认） ----

test('runAudit：R18 概念字段组盘点进 INFO 与基线（只盘点，不校验语义）', async () => {
  await withVault({ tag: 'v9-audit-', graph: MISC_GRAPH, notes: { 入门: {} } }, async ({ engine }) => {
    const regions = await new GraphStore(engine.paths, engine.paths.courseRoot('math'), nodeVaultFs).load()
    const graph = new Graph(regions)
    const r = await runAudit(engine.paths, 'math', '数学', graph, regions, todayStr(new Date()), nodeVaultFs)
    const r18 = r.infos.find(x => x.startsWith('R18 概念字段组盘点'))
    assert.ok(r18, 'R18 INFO 在场')
    assert.match(r18!, /teaches 1 节点、assumes 1 节点、误解 1 条/)
    assert.match(r18!, /不进门禁不进调度/)
    assert.equal(r.baseline['概念字段（teaches/assumes/误解）'], '1 / 1 / 1')
  })
})
