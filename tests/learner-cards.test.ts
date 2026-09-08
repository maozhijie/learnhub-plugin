import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { validateLearnerCards, LEARNER_PROMPT_MAX, LEARNER_CONTENT_MAX } from '../src/engine/learner-cards.ts'
import { parseExplainVerdict, explainBackPack, EXPLAIN_VERDICTS, EXPLAIN_TAGS } from '../src/engine/explain.ts'
import { todayStr } from '../src/engine/dates.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

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

async function withVault(run: (engine: LearnhubEngine) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-e1e2-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(join(course, '课程', '基础', '入门.md'), `${NOTE}\n`, 'utf8')
    await run(new LearnhubEngine({ vault: root }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

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
  await withVault(async engine => {
    const pack = await engine.explainBackPack('数学', '入门')
    assert.match(pack, /### 概念：定义/)
    assert.match(pack, /### 例题：应用/)
    assert.match(pack, /前置：前置概念/)
    assert.match(pack, /S1 等差数列/)
    // 练习节不进要点（lessonSections 语义）
    assert.doesNotMatch(pack, /练习占位/)
    await assert.rejects(() => engine.explainBackPack('数学', '不存在'), /不在课程/)
  })
})

test('定位反馈：判词解析入 E 档案；解析失败零副作用；canonical 通道零写入（#33 边界回归）', async () => {
  await withVault(async engine => {
    const bankBefore = existsSync(engine.paths.journalPath) ? await readFile(engine.paths.journalPath, 'utf8') : ''
    const noteBefore = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')

    let feedbackSystem = ''
    const v = await engine.explainBackFeedback('数学', '入门',
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
      () => engine.explainBackFeedback('数学', '入门', '[学习者] …', async () => '模型抽风输出'),
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
  await withVault(async engine => {
    const r1 = await engine.explainArchiveCard('数学', '入门', {
      content: '等差求和 = (a₁+aₙ)×n÷2，倒序相加每对和相等。',
      section: 's2',
    })
    assert.equal(r1.kind, 'recall_cue')
    assert.match(String(await cardFile(engine)), /再讲一遍：用你的话讲清「例题：应用」/)
    assert.match(String(await cardFile(engine)), /source_section: 例题：应用/)

    // 挖空重述：合法 {{}} 通过
    const r2 = await engine.explainArchiveCard('数学', '入门', {
      kind: 'cloze_rewrite',
      content: '末项公式 {{a₁+(n−1)d}}——到第 1 个不加。',
    })
    assert.equal(r2.kind, 'cloze_rewrite')

    // 挖空缺 {{}} 拒绝；同内容重复拒绝
    await assert.rejects(
      () => engine.explainArchiveCard('数学', '入门', { kind: 'cloze_rewrite', content: '没有挖空' }),
      /挖空/)
    await assert.rejects(
      () => engine.explainArchiveCard('数学', '入门', { content: '等差求和 = (a₁+aₙ)×n÷2，倒序相加每对和相等。' }),
      /同内容卡已存在/)
    await assert.rejects(
      () => engine.explainArchiveCard('数学', '入门', { content: '   ' }),
      /内容为空/)
  })
})

async function cardFile(engine: LearnhubEngine): Promise<string> {
  return readFile(join(engine.paths.learnerCardsDir('math'), '入门.yaml'), 'utf8')
}

// ---- 门面：E1「我的卡」隔离调度 ----

test('我的卡队列与自评：新卡入队→首推到期→一卡一天一次；canonical 零掺入', async () => {
  await withVault(async engine => {
    await engine.explainArchiveCard('数学', '入门', { content: '讲稿 A：求和公式的来历。' })
    await engine.explainArchiveCard('数学', '入门', { content: '讲稿 B：末项公式的来历。' })

    // 新卡（从未调度）入队，due 为空
    const q1 = await engine.learnerQueue('数学')
    assert.equal(q1.total, 2)
    assert.equal(q1.due_count, 0)
    assert.equal(q1.cards.filter(c => c.due === null).length, 2)
    assert.match(String(q1.cards[0]!.prompt), /再讲一遍/)

    // 首推（自评 Good）→ 明天到期；同日第二推拒绝
    const r = await engine.learnerCardRate('数学', '入门', 'c1', 3)
    assert.equal(r.scheduled, true)
    assert.ok(String(r.due) > todayStr())
    await assert.rejects(() => engine.learnerCardRate('数学', '入门', 'c1', 2), /今天已推进过/)
    await assert.rejects(() => engine.learnerCardForget('数学', '入门', 'c1'), /今天已推进过/)

    // 忘记申报（rating=1）→ 另一张卡当日推进
    const f = await engine.learnerCardForget('数学', '入门', 'c2')
    assert.equal(f.rating, 1)
    const q2 = await engine.learnerQueue()
    assert.equal(q2.due_count, 0) // 都推到明天了
    assert.equal(q2.total, 2)

    // 档位契约：rate 只收 2/3/4；未知卡 fail loud
    await assert.rejects(() => engine.learnerCardRate('数学', '入门', 'c3', 3), /没有 c3/)
    await assert.rejects(() => engine.learnerCardRate('数学', '入门', 'c1', 5), /自评档位/)

    // E 池隔离自调度：不写复习日志/practice/journal，无 XP；节点 frontmatter 未被动
    assert.ok(!existsSync(engine.paths.reviewLogPath))
    assert.ok(!existsSync(engine.paths.practicePath))
    assert.ok(!existsSync(engine.paths.journalPath))
    const fm = await readFile(engine.paths.courseNotePath('math', '基础', '入门'), 'utf8')
    assert.match(fm, /practice:\n  attempts: 3\n  correct: 2/)
  })
})
