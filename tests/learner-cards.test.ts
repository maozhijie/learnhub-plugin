import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LearnhubEngine } from '../src/engine/index.ts'
import { validateLearnerCards, LEARNER_PROMPT_MAX, LEARNER_CONTENT_MAX } from '../src/engine/learner-cards.ts'
import { parseExplainVerdict, explainBackPack, EXPLAIN_VERDICTS, EXPLAIN_TAGS } from '../src/engine/explain.ts'
import { selfNoteFeedbackSystem, selfNoteFeedbackPrompt, selfNotePromptOf } from '../src/engine/self-note.ts'
import { todayStr } from '../src/engine/dates.ts'
import { withVault } from './helpers/vault.ts'

/** 入门带悬挂前置（前置概念不在图内）——讲解包要能照常点名前置。 */
const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [前置概念], opt: false, note: "", est: 20 }',
].join('\n')

/** 带 manifest（s1/s2 两节）与正文的节点笔记。 */
const NOTE = [
  '---',
  'node: 入门',
  'stage: review',
  'fsrs: null',
  'content:',
  '  version: 2',
  '  generated_at: "2026-09-01"',
  '  status: draft',
  '  sections:',
  '    - { id: s1, title: "概念：定义", type: 概念, status: ready, version: 1 }',
  '    - { id: s2, title: "例题：应用", type: 例题, status: ready, version: 0 }',
  'practice:',
  '  attempts: 3',
  '  correct: 2',
  '---',
  '',
  '# 入门',
  '',
  '## 概念：定义',
  '',
  'S1 等差数列 = 任意相邻两项之差恒定（公差 d）。',
  '',
  '## 例题：应用',
  '',
  'S2 已知 a₁、d、n 先求末项再套求和公式。',
  '',
  '## 练习',
  '',
  '（练习占位）',
].join('\n')

/** 悬挂前置图 + 双 section 笔记；无题库。原始字符串逐字落盘，补上原 harness 的结尾换行。 */
const LEARNER_VAULT = { graph: GRAPH, notes: { 入门: `${NOTE}\n` } }

const VALID_JSON = JSON.stringify({
  verdict: '部分对',
  tags: ['含糊', '跳跃'],
  advice: '补一句「为什么 ÷2」——倒序相加每对和相等、每对算两次。',
  reply: '**部分对**：公式说对了，但「为什么除以二」只说「倒过来加」，含糊。',
})

// ---- 纯函数缝 ----

test('纯函数缝：我的卡 schema 门禁（卡面白名单/长度上限/挖空标记/控制字符/派生块透传）', () => {
  const bad = validateLearnerCards({
    node: '入门',
    cards: [
      { id: 'c1', kind: 'bad_kind', prompt: 'p', content: 'c', source_node: '入门' },
      { id: 'c2', kind: 'recall_cue', prompt: '', content: 'c', source_node: '入门' },
      { id: 'c3', kind: 'recall_cue', prompt: 'p', content: '', source_node: '入门' },
      { id: 'c4', kind: 'cloze_rewrite', prompt: 'p', content: '无挖空的表述', source_node: '入门' },
      { id: 'c5', kind: 'cloze_rewrite', prompt: 'p', content: '空挖空 {{}}', source_node: '入门' },
      { id: 'c6', kind: 'recall_cue', prompt: 'p', content: 'c', source_node: '' },
      { id: 'c7', kind: 'recall_cue', prompt: 'p\x02', content: 'c', source_node: '入门' },
      { id: 'c8', kind: 'recall_cue', prompt: 'p'.repeat(LEARNER_PROMPT_MAX + 1), content: 'c', source_node: '入门' },
      { id: 'c9', kind: 'recall_cue', prompt: 'p', content: 'c'.repeat(LEARNER_CONTENT_MAX + 1), source_node: '入门' },
    ],
  })
  assert.ok(bad.errors!.some(e => e.includes('cards.1.kind')))
  assert.ok(bad.errors!.some(e => e.includes('cards.2.prompt: 正面提示不能为空')))
  assert.ok(bad.errors!.some(e => e.includes('cards.3.content: 自注内容不能为空')))
  assert.ok(bad.errors!.some(e => e.includes('cards.4.content: 挖空重述必须含')))
  assert.ok(bad.errors!.some(e => e.includes('cards.5.content: 挖空重述必须含')))
  assert.ok(bad.errors!.some(e => e.includes('cards.6.source_node: 关联节点不能为空')))
  assert.ok(bad.errors!.some(e => e.includes('cards.7: 含控制字符')))
  assert.ok(bad.errors!.some(e => e.includes('cards.8.prompt: 超过')))
  assert.ok(bad.errors!.some(e => e.includes('cards.9.content: 超过')))

  // 换行/制表不拒；fsrs/stats 派生块只透传；cloze 合法通过
  const ok = validateLearnerCards({
    node: '入门',
    cards: [{
      id: 'c1', kind: 'cloze_rewrite', prompt: 'p\t提示\n换行', content: '求和公式 {{(a₁+aₙ)×n÷2}} 是核心', source_node: '入门',
      fsrs: { stability: 3, difficulty: 5, due: '2026-09-09', last_review: '2026-09-08', reps: 1, lapses: 0 },
      stats: { attempts: 1, correct: 1 },
    }],
  })
  assert.equal(ok.errors, undefined)
  assert.equal(ok.spec!.cards[0]!.fsrs!.due, '2026-09-09')
  assert.equal(ok.spec!.cards[0]!.stats!.attempts, 1)

  // node 不一致 fail loud；空卡组非法
  assert.ok(validateLearnerCards({ node: '别的', cards: [{ id: 'c1', kind: 'recall_cue', prompt: 'p', content: 'c', source_node: '入门' }] }, '入门').errors)
  assert.ok(validateLearnerCards({ node: '入门', cards: [] }).errors)
})

test('纯函数缝：讲解包拼装与判词解析（不可解析抛错、tags 白名单过滤）', () => {
  const pack = explainBackPack('数学', '入门',
    [{ title: '概念：定义', md: '相邻两项之差恒定' }], ['前置概念'], ['后继'])
  assert.match(pack, /讲给我听：数学 \/ 入门/)
  assert.match(pack, /### 概念：定义/)
  assert.match(pack, /相邻两项之差恒定/)
  assert.match(pack, /前置：前置概念/)
  assert.match(pack, /后继：/)
  assert.match(pack, /完全不懂/)
  assert.match(pack, /不评分/)
  assert.match(pack, /换一种问/)

  const v = parseExplainVerdict(VALID_JSON)
  assert.equal(v.verdict, '部分对')
  assert.deepEqual(v.tags, ['含糊', '跳跃'])
  assert.match(v.advice, /÷2/)
  assert.match(v.reply, /部分对/)

  // 围栏包裹可剥；非法 verdict/缺 advice/缺 reply/非 JSON 全部抛错（判词零副作用）
  assert.equal(parseExplainVerdict('```json\n' + VALID_JSON + '\n```').verdict, '部分对')
  assert.throws(() => parseExplainVerdict('不是 JSON'), /未存档/)
  assert.throws(() => parseExplainVerdict(JSON.stringify({ verdict: '满分', tags: [], advice: 'a', reply: 'r' })), /verdict/)
  assert.throws(() => parseExplainVerdict(JSON.stringify({ verdict: '对', tags: [], reply: 'r' })), /advice/)
  assert.throws(() => parseExplainVerdict(JSON.stringify({ verdict: '对', tags: [], advice: 'a' })), /reply/)
  // 非法 tag 被过滤（契约外标签不进档案）
  const filtered = parseExplainVerdict(JSON.stringify({ verdict: '对', tags: ['含糊', '太啰嗦'], advice: 'a', reply: 'r' }))
  assert.deepEqual(filtered.tags, ['含糊'])

  assert.deepEqual([...EXPLAIN_VERDICTS], ['对', '部分对', '错'])
  assert.deepEqual([...EXPLAIN_TAGS], ['含糊', '跳跃', '说错'])
})

// ---- 门面：E2 讲解会话 ----

test('讲解包：面板/宿主通道取到要点+图位置+初学者人设指令；未知节点 fail loud', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    const pack = await engine.learner.explainBackPack('数学', '入门')
    assert.match(pack, /### 概念：定义/)
    assert.match(pack, /### 例题：应用/)
    assert.match(pack, /前置：前置概念/)
    assert.match(pack, /S1 等差数列/)
    // 练习节不进要点（lessonSections 语义）
    assert.doesNotMatch(pack, /练习占位/)
    await assert.rejects(() => engine.learner.explainBackPack('数学', '不存在'), /不在课程/)
  })
})

test('定位反馈：判词解析入 E 档案；解析失败零副作用；canonical 通道零写入（#33 边界回归）', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    const bankBefore = existsSync(engine.paths.journalPath) ? await readFile(engine.paths.journalPath, 'utf8') : ''
    const noteBefore = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')

    let feedbackSystem = ''
    const v = await engine.learner.explainBackFeedback('数学', '入门',
      '[学习者] 等差求和就是首项加末项乘项数除以二。为什么除以二我忘了。',
      async (prompt, system) => {
        feedbackSystem = system ?? ''
        assert.match(prompt, /概念：定义/)
        assert.match(prompt, /S1 等差数列/)
        assert.match(prompt, /首项加末项乘项数除以二/)
        return VALID_JSON
      })
    assert.equal(v.verdict, '部分对')
    assert.deepEqual(v.tags, ['含糊', '跳跃'])
    assert.match(v.reply, /除以二/)

    // 判词只入 E 档案
    const archive = await engine.store.eArchiveAll()
    assert.equal(archive.length, 1)
    assert.equal(archive[0]!.kind, 'explain_back')
    assert.equal(archive[0]!.course, '数学')
    assert.equal(archive[0]!.node, '入门')
    assert.match(archive[0]!.excerpt ?? '', /除以二/)
    assert.match(feedbackSystem, /定位反馈/)
    assert.match(feedbackSystem, /不打分数/)

    // 解析失败：抛错且 E 档案零新增（判词零副作用）
    await assert.rejects(
      () => engine.learner.explainBackFeedback('数学', '入门', '[学习者] …', async () => '模型抽风输出'),
      /未存档/)
    assert.equal((await engine.store.eArchiveAll()).length, 1)

    // canonical 零写入：无 practice 流水、无复习日志、题库/笔记/journal 不动
    assert.ok(!existsSync(engine.paths.practicePath))
    assert.ok(!existsSync(engine.paths.reviewLogPath))
    assert.ok(!existsSync(engine.paths.courseRoot('math') + '/题库/入门.yaml'))
    assert.equal(await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8'), noteBefore)
    assert.equal(existsSync(engine.paths.journalPath) ? await readFile(engine.paths.journalPath, 'utf8') : '', bankBefore)
  })
})

// ---- 门面：E2 存档 → E1 卡 ----

test('存成我的卡：默认再讲一遍；挖空重述需带 {{}}；同内容去重', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    const r1 = await engine.learner.explainArchiveCard('数学', '入门', {
      content: '等差求和 = (a₁+aₙ)×n÷2，倒序相加每对和相等。',
      section: 's2',
    })
    assert.equal(r1.kind, 'recall_cue')
    assert.match(String(await cardFile(engine)), /再讲一遍：用你的话讲清「例题：应用」/)
    assert.match(String(await cardFile(engine)), /source_section: 例题：应用/)

    // 挖空重述：合法 {{}} 通过
    const r2 = await engine.learner.explainArchiveCard('数学', '入门', {
      kind: 'cloze_rewrite',
      content: '末项公式 {{a₁+(n−1)d}}——到第 1 个不加。',
    })
    assert.equal(r2.kind, 'cloze_rewrite')

    // 挖空缺 {{}} 拒绝；同内容重复拒绝
    await assert.rejects(
      () => engine.learner.explainArchiveCard('数学', '入门', { kind: 'cloze_rewrite', content: '没有挖空' }),
      /挖空/)
    await assert.rejects(
      () => engine.learner.explainArchiveCard('数学', '入门', { content: '等差求和 = (a₁+aₙ)×n÷2，倒序相加每对和相等。' }),
      /同内容卡已存在/)
    await assert.rejects(
      () => engine.learner.explainArchiveCard('数学', '入门', { content: '   ' }),
      /内容为空/)
  })
})

async function cardFile(engine: LearnhubEngine): Promise<string> {
  return readFile(join(engine.paths.learnerCardsDir('math'), '入门.yaml'), 'utf8')
}

// ---- 门面：E1「加我的理解」节级入口（#70）----

test('纯函数缝：自注反馈指令与默认卡面提示（对照要点、不超纲、不评分）', () => {
  const sys = selfNoteFeedbackSystem()
  assert.match(sys, /定位反馈/)
  assert.match(sys, /含糊.*跳跃.*说错|含糊=|说错=/s)
  assert.match(sys, /不打分数/)
  assert.match(sys, /严格 JSON/)
  const prompt = selfNoteFeedbackPrompt([{ title: '概念：定义', md: 'S1 等差数列 = 相邻两项之差恒定' }], '概念：定义',
    '等差数列就是每次加一样的数。')
  assert.match(prompt, /「概念：定义」/)
  assert.match(prompt, /S1 等差数列/)
  assert.match(prompt, /每次加一样的数/)

  assert.equal(selfNotePromptOf('recall_cue', '例题：应用'), '再讲一遍：用你的话讲清「例题：应用」')
  assert.equal(selfNotePromptOf('cloze_rewrite', '例题：应用'), '补全你自己的表述：例题：应用')
  assert.equal(selfNotePromptOf('self_explain', '例题：应用'), '这个节你理解成了什么：例题：应用')
})

test('加我的理解：AI 对照该节要点给定位反馈 → 判词入 E 档案 + 成卡（节锚点）', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    const r = await engine.learner.learnerNoteAdd('数学', '入门', {
      content: '等差数列就是每一步加固定的数，比如 2、4、6。',
      kind: 'recall_cue',
      section: 's1',
    }, async (prompt, system) => {
      assert.match(system ?? '', /定位反馈/)
      assert.match(prompt, /「概念：定义」/, '节锚点 → 对照面收窄到该节')
      assert.match(prompt, /S1 等差数列/)
      assert.ok(!/S2 已知/.test(prompt), '对照面不含其他节')
      assert.match(prompt, /每一步加固定的数/)
      return VALID_JSON
    })
    // 卡：独立域成卡（默认提示带节标题）
    assert.equal(r.card.kind, 'recall_cue')
    assert.equal(r.card.id, 'c1')
    const file = await cardFile(engine)
    assert.match(file, /再讲一遍：用你的话讲清「概念：定义」/)
    assert.match(file, /source_section: 概念：定义/)
    assert.match(file, /每一步加固定的数/)
    // 判词：只入 E 档案（kind=self_note）
    assert.equal(r.verdict.verdict, '部分对')
    assert.deepEqual(r.verdict.tags, ['含糊', '跳跃'])
    assert.match(r.reply, /除以二/)
    const archive = await engine.store.eArchiveAll()
    assert.equal(archive.length, 1)
    assert.equal(archive[0]!.kind, 'self_note')
    assert.match(archive[0]!.excerpt ?? '', /每一步加固定的数/)

    // 三种卡面至少一种可建已证；挖空卡与自注讲解卡同通道可建
    await engine.learner.learnerNoteAdd('数学', '入门', {
      content: '求和公式 {{(a₁+aₙ)×n÷2}} 是核心', kind: 'cloze_rewrite',
    }, async () => VALID_JSON)
    await engine.learner.learnerNoteAdd('数学', '入门', {
      content: '我理解这一节在讲把加法转成乘法。', kind: 'self_explain',
    }, async () => VALID_JSON)

    // 节锚点映射不上（坏节 id）：对照面为空并随 prompt 明示——不静默退化为全节要点
    await engine.learner.learnerNoteAdd('数学', '入门', {
      content: '锚点测试。', section: 's99',
    }, async (prompt) => {
      assert.match(prompt, /「s99」/)
      assert.match(prompt, /本节还没有可对照的正文要点/)
      return VALID_JSON
    })
    const q = await engine.learner.learnerQueue('数学')
    assert.equal(q.total, 4)
    assert.ok(q.cards.every(c => c.due === null), '新卡未调度，从「我的卡」队列首推')

    // #33 边界回归：题库/掌握度/XP/作答流水零新增写入
    assert.ok(!existsSync(engine.paths.practicePath))
    assert.ok(!existsSync(engine.paths.reviewLogPath))
    assert.ok(!existsSync(engine.paths.journalPath))
    assert.ok(!existsSync(engine.paths.courseRoot('math') + '/题库/入门.yaml'))
    assert.equal(await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8'), `${NOTE}\n`)
  })
})

test('加我的理解：AI 判词不可解析 → 卡与判词零落盘（ADR-0004 事务性）；非法卡面拒绝', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    await assert.rejects(
      () => engine.learner.learnerNoteAdd('数学', '入门', { content: '我的理解' }, async () => '模型抽风'),
      /未存档/)
    assert.ok(!existsSync(join(engine.paths.learnerCardsDir('math'), '入门.yaml')), '卡未落盘')
    assert.equal((await engine.store.eArchiveAll()).length, 0)

    await assert.rejects(
      () => engine.learner.learnerNoteAdd('数学', '入门', { content: 'x', kind: 'bad_kind' as never }, async () => VALID_JSON),
      /卡面只能是/)
    await assert.rejects(
      () => engine.learner.learnerNoteAdd('数学', '入门', { content: '   ' }, async () => VALID_JSON),
      /内容为空|为空/)
    assert.equal((await engine.store.eArchiveAll()).length, 0)
  })
})

test('我的卡管理面：归档/恢复（E 池内部动作，canonical 零写入）', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    const r = await engine.learner.explainArchiveCard('数学', '入门', { content: '讲稿 A。' })
    await engine.learner.learnerCardArchive('数学', '入门', r.id, true)
    let q = await engine.learner.learnerQueue('数学')
    assert.equal(q.total, 0, '归档卡出队')
    await engine.learner.learnerCardArchive('数学', '入门', r.id, false)
    q = await engine.learner.learnerQueue('数学')
    assert.equal(q.total, 1)
    assert.ok(!existsSync(engine.paths.practicePath))
    assert.ok(!existsSync(engine.paths.journalPath))
  })
})

// ---- 门面：E1「我的卡」隔离调度 ----

test('我的卡队列与自评：新卡入队→首推到期→一卡一天一次；canonical 零掺入', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    await engine.learner.explainArchiveCard('数学', '入门', { content: '讲稿 A：求和公式的来历。' })
    await engine.learner.explainArchiveCard('数学', '入门', { content: '讲稿 B：末项公式的来历。' })

    // 新卡（从未调度）入队，due 为空
    const q1 = await engine.learner.learnerQueue('数学')
    assert.equal(q1.total, 2)
    assert.equal(q1.due_count, 0)
    assert.equal(q1.cards.filter(c => c.due === null).length, 2)
    assert.match(String(q1.cards[0]!.prompt), /再讲一遍/)

    // 首推（自评 Good）→ 明天到期；同日第二推拒绝
    const r = await engine.learner.learnerCardRate('数学', '入门', 'c1', 3)
    assert.equal(r.scheduled, true)
    assert.ok(String(r.due) > todayStr(new Date()))
    await assert.rejects(() => engine.learner.learnerCardRate('数学', '入门', 'c1', 2), /今天已推进过/)
    await assert.rejects(() => engine.learner.learnerCardForget('数学', '入门', 'c1'), /今天已推进过/)

    // 忘记申报（rating=1）→ 另一张卡当日推进
    const f = await engine.learner.learnerCardForget('数学', '入门', 'c2')
    assert.equal(f.rating, 1)
    const q2 = await engine.learner.learnerQueue()
    assert.equal(q2.due_count, 0) // 都推到明天了
    assert.equal(q2.total, 2)

    // 档位契约：rate 只收 2/3/4；未知卡 fail loud
    await assert.rejects(() => engine.learner.learnerCardRate('数学', '入门', 'c3', 3), /没有 c3/)
    await assert.rejects(() => engine.learner.learnerCardRate('数学', '入门', 'c1', 5), /自评档位/)

    // 测量面零掺入（ADR-0021 裁决 2）：不写复习日志/practice，节点 frontmatter 未被动；
    // XP 走无绑定行（journal，ADR-0021）：c1 自评 Good = max(1, round(难度 5)) = 5，c2 忘记 = 0
    assert.ok(!existsSync(engine.paths.reviewLogPath))
    assert.ok(!existsSync(engine.paths.practicePath))
    const xpRows = (await engine.store.journalTail(null, Number.MAX_SAFE_INTEGER))
      .filter(r => r.kind === 'xp_learner')
    assert.equal(xpRows.length, 2)
    assert.ok(xpRows.every(r => r.course === '*' && r.node === '*'))
    assert.deepEqual(xpRows.map(r => r.xp).sort((a, b) => a - b), [0, 5])
    const fm = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    assert.match(fm, /practice:\n  attempts: 3\n  correct: 2/)
  })
})

test('我的卡汇入复习队列（ADR-0021）：新卡队尾首推、到期卡入队、定向入口可见、复习日志零掺入', async () => {
  await withVault(LEARNER_VAULT, async ({ engine }) => {
    await engine.learner.explainArchiveCard('数学', '入门', { content: '讲稿 A：求和公式的来历。' })

    // 未调度新卡：due 空、R 满档落队尾，learner 字段随卡带出（UI 分面渲染依据）
    const q1 = await engine.content2.reviewQueue()
    assert.equal(q1.total, 1)
    const fresh = q1.cards[0] as Record<string, unknown>
    assert.equal(fresh.source, 'learner')
    assert.equal(fresh.due, null)
    assert.equal(fresh.r, 1)
    const lf = fresh.learner as Record<string, unknown>
    assert.equal(lf.id, 'c1')
    assert.equal(lf.kind, 'recall_cue')
    assert.equal(lf.course, '数学')
    assert.equal(lf.node, '入门')
    assert.equal(lf.due, null)
    assert.match(String(lf.prompt), /再讲一遍/)
    assert.match(String(lf.content), /求和公式/)

    // 定向入口同可见（单节点会话带起点难度带）
    const qDir = await engine.content2.reviewQueue('数学', '入门')
    assert.equal(qDir.cards.length, 1)
    assert.ok(qDir.band !== undefined)

    // 种一个 due=当前的调度块 → 进队且 R < 1；rate 结算走无绑定 XP（权重 1 × 难度 5）
    const today = todayStr(new Date())
    await engine.learnerCards.updateCardEvidence('math', '入门', 'c1', {
      fsrs: { stability: 3, difficulty: 5, due: today, last_review: '2026-09-08', reps: 1, lapses: 0 },
    })
    const q2 = await engine.content2.reviewQueue()
    assert.equal(q2.total, 1)
    assert.equal(String(q2.cards[0]!.due), today)
    assert.ok((q2.cards[0]!.r as number) < 1)
    const r = await engine.learner.learnerCardRate('数学', '入门', 'c1', 3)
    assert.equal(r.xp, 5)

    // 推到明天 → 出队；无绑定行已落 journal，复习日志/practice 零掺入
    assert.equal((await engine.content2.reviewQueue()).total, 0)
    const rows = (await engine.store.journalTail(null, Number.MAX_SAFE_INTEGER))
      .filter(x => x.kind === 'xp_learner')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.xp, 5)
    assert.equal(rows[0]!.course, '*')
    assert.ok(!existsSync(engine.paths.reviewLogPath))
    assert.ok(!existsSync(engine.paths.practicePath))
  })
})
