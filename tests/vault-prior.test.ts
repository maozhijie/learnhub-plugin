/**
 * Vault 先验上下文注入（V-2 / #106；#229 检索换核）：生成节点内容/题目时检索学习者
 * Vault 相关笔记并注入生成上下文，正文尊重「你已有的理解与记法」。
 *
 * - 前置探测结论（票内落档，模块头注同文）：宿主 dsh-llm/dsh-tools 0.1.2-rc.1 导出面
 *   无检索/嵌入 API → 按 #78 预案降级为纯扫描关键词检索。
 * - ADR-0010 只读纪律：检索永不写个人笔记——纯扫描只读，学习中心与点目录排除。
 * - #229 三件（BM25 式打分 / 登记表查询扩展 / 审计可观测）：打分口径按可判读命题断言
 *   （IDF 区分罕见词、长度归一分、词频次线性饱和）、扩展按权重与来源断言、审计按
 *   「零命中与两种截断必留痕」断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ALIAS_TERM_WEIGHT, CONFUSABLE_TERM_WEIGHT,
  excerptAround, expandPriorTerms, priorQueryTerms, priorSection, priorTerms, queryEntriesFor, searchVaultPrior,
} from '../src/engine/vault/vault-prior.ts'
import type { PriorQueryTerm } from '../src/engine/vault/vault-prior.ts'
import type { ConceptEntry } from '../src/engine/concepts.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { withVault } from './helpers/vault.ts'

/** 检索词直写（不经分词/扩展的调用点，读起来更直白）。 */
const q = (...texts: string[]): PriorQueryTerm[] => texts.map(text => ({ text, weight: 1, source: 'base' as const }))

// ---- 纯函数 ----

test('priorTerms：按分隔符切分，全词 ≥2 字符，去重保序', () => {
  assert.deepEqual(priorTerms(['三角函数/诱导公式', '傅立叶，级数']), ['三角函数', '诱导公式', '傅立叶', '级数'])
  assert.deepEqual(priorTerms(['a', ' 波动方程 ', '']), ['波动方程'])
  assert.deepEqual(priorTerms([]), [])
})

test('expandPriorTerms：基础词保底，别名/易混概念按低权重并入（来源可读）', () => {
  const entries: ConceptEntry[] = [{
    canonical: '三角函数', aliases: ['三角比'], confusable: ['反三角函数'],
  }]
  const out = expandPriorTerms(['三角函数', '诱导公式'], entries)
  assert.deepEqual(out.find(t => t.text === '三角函数'), { text: '三角函数', weight: 1, source: 'base' })
  assert.deepEqual(out.find(t => t.text === '诱导公式'), { text: '诱导公式', weight: 1, source: 'base' })
  const alias = out.find(t => t.text === '三角比')!
  assert.equal(alias.weight, ALIAS_TERM_WEIGHT)
  assert.equal(alias.source, 'alias')
  const confusable = out.find(t => t.text === '反三角函数')!
  assert.equal(confusable.weight, CONFUSABLE_TERM_WEIGHT)
  assert.equal(confusable.source, 'confusable')
  // 无登记表 = 零扩展（Missing 合法空态照旧）
  assert.deepEqual(expandPriorTerms(['三角函数'], []), [{ text: '三角函数', weight: 1, source: 'base' }])
})

test('expandPriorTerms：同名取更高权重那一档（同一个词面不打两遍分）', () => {
  const entries: ConceptEntry[] = [{ canonical: '三角函数', aliases: ['三角比'], confusable: ['诱导公式'] }]
  const out = expandPriorTerms(['三角函数', '诱导公式'], entries)
  const hit = out.filter(t => t.text === '诱导公式')
  assert.equal(hit.length, 1, '基础词与易混对撞名时只留一条')
  assert.equal(hit[0]!.source, 'base', '基础词权重 1 高于易混对 0.35，基础档胜出')
})

test('expandPriorTerms：扩展只做一级（别名的别名不并入——再扩一次词面就炸）', () => {
  const entries: ConceptEntry[] = [
    { canonical: '甲', aliases: ['乙'] },
    { canonical: '乙', aliases: ['丙'] },
  ]
  const out = expandPriorTerms(['甲'], entries).map(t => t.text).sort()
  assert.deepEqual(out, ['乙', '甲'].sort())
  assert.ok(!out.includes('丙'), '乙虽在册，但它是扩展词不是基础词，不再往下扩')
})

test('priorQueryTerms：分词 + 扩展的唯一出口（生成入口口径）', () => {
  const out = priorQueryTerms(['三角函数/诱导公式'], [{ canonical: '三角函数', aliases: ['三角比'] }])
  assert.deepEqual(out.filter(t => t.source === 'base').map(t => t.text), ['三角函数', '诱导公式'])
  assert.deepEqual(out.filter(t => t.source === 'alias').map(t => t.text), ['三角比'])
})

test('excerptAround：命中位置周围取窗；无命中回退开头', () => {
  const body = '前缀铺垫。'.repeat(50) + '关键词在这里。' + '后缀补充。'.repeat(50)
  const ex = excerptAround(body, '关键词', 40)
  assert.ok(ex.includes('关键词'))
  assert.ok(ex.length <= 60)
  assert.equal(excerptAround('没有命中', '关键词', 10), '没有命中')
})

test('priorSection：零命中返回空串；有命中带出处路径与只读声明', () => {
  assert.equal(priorSection([]), '')
  const section = priorSection([{ path: '笔记/吉他和弦.md', title: '吉他和弦', excerpt: '大三度 = 大三和弦的根音关系', score: 4 }])
  assert.match(section, /学习者已有理解（Vault 先验）/)
  assert.match(section, /笔记\/吉他和弦\.md/)
  assert.match(section, /大三度/)
  assert.match(section, /尊重学习者已有/)
  assert.match(section, /永不改写/)
})

// ---- 行为：BM25 式打分 ----

/** 直控语料的检索（vault 根 + 分词扩展一步到位，断言面只留打分/审计）。 */
async function search(root: string, terms: string[], opts: { limit?: number; maxFiles?: number } = {}, entries: ConceptEntry[] = []) {
  return searchVaultPrior(root.replace(/\\/g, '/'), '学习中心', priorQueryTerms(terms, entries), opts, nodeVaultFs)
}

test('searchVaultPrior：IDF 区分罕见词——仅命中罕见词的文档排在「只命中常见词」之前', async () => {
  await withVault({
    files: [
      // 「基础」出现在全部五篇（df = N）＝近乎零信息量；「变分」只出现在一篇
      { path: '笔记/一.md', content: '# 基础一\n\n基础内容。' },
      { path: '笔记/二.md', content: '# 基础二\n\n基础内容。' },
      { path: '笔记/三.md', content: '# 基础三\n\n基础内容。' },
      { path: '笔记/四.md', content: '# 基础四\n\n基础内容。' },
      { path: '笔记/五.md', content: '# 基础五\n\n基础内容，另有变分法。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['基础', '变分'], { limit: 5 })
    assert.equal(r.hits.length, 5)
    assert.equal(r.hits[0]!.path, '笔记/五.md', '罕见词命中的那篇第一（常见词几乎不加分；旧核里两者都只值 +1）')
  })
})

test('searchVaultPrior：长度归一——同样一次命中，短文档得分更高', async () => {
  await withVault({
    files: [
      { path: '笔记/短.md', content: '# 短\n\n关键词。' },
      { path: '笔记/长.md', content: '# 长\n\n' + '无关铺垫。'.repeat(200) + '关键词。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['关键词'], { limit: 5 })
    const short = r.hits.find(h => h.path === '笔记/短.md')!
    const long = r.hits.find(h => h.path === '笔记/长.md')!
    assert.ok(short.score > long.score, `长度归一：短文档分 ${short.score} 应高于长文档 ${long.score}`)
  })
})

test('searchVaultPrior：词频次线性饱和（tf 3 > tf 1，但小于 3 倍）', async () => {
  await withVault({
    files: [
      { path: '笔记/一次.md', content: '# 甲\n\n关键词。' },
      { path: '笔记/三次.md', content: '# 乙\n\n关键词，关键词，关键词。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['关键词'], { limit: 5 })
    const once = r.hits.find(h => h.path === '笔记/一次.md')!
    const thrice = r.hits.find(h => h.path === '笔记/三次.md')!
    assert.ok(thrice.score > once.score, '词频高者分高')
    assert.ok(thrice.score < once.score * 3, '饱和：词频三倍不等于分数线性的三倍（旧核的 +1/次是线性的）')
  })
})

test('searchVaultPrior：命中中心外个人笔记；学习中心与点目录排除；标题命中权重高；只读', async () => {
  const personalNote = '# 吉他和弦笔记\n\n我习惯把大三度记成「三大度」，练习时先听再按。'
  await withVault({
    files: [
      { path: '乐理/和弦.md', content: personalNote },
      { path: '乐理/.obsidian/缓存.md', content: '# 大三度\n\n不该被扫到。' },
      { path: '学习中心/数学/课程/杂记.md', content: '# 大三度\n\n中心内不是先验来源。' },
      { path: '乐理/无关.md', content: '# 购物清单\n\n牛奶 鸡蛋。' },
    ],
  }, async ({ engine, root }) => {
    const r = await searchVaultPrior(root.replace(/\\/g, '/'), '学习中心', q('大三度', '吉他和弦'), {}, nodeVaultFs)
    assert.equal(r.hits.length, 1, '中心内与点目录条目不入结果')
    assert.equal(r.hits[0]!.path, '乐理/和弦.md')
    assert.equal(r.hits[0]!.title, '吉他和弦笔记')
    assert.match(r.hits[0]!.excerpt, /三大度|大三度/)
    assert.equal(r.audit.zeroHit, false)
    assert.equal(r.audit.scanned, 2, '扫描面 = 中心外两篇 .md（无关篇也读进扫描面，只是不打分）')

    const none = await searchVaultPrior(root.replace(/\\/g, '/'), '学习中心', q('不存在的词'), {}, nodeVaultFs)
    assert.equal(none.hits.length, 0)
    assert.equal(none.audit.zeroHit, true, '零命中必须留痕（旧实现的空数组读不出「检索过没有」）')
    assert.ok(none.audit.scanned > 0, '零命中也要报扫描面：扫了 N 篇没命中 ≠ 没检索')

    // 标题字段加权：标题命中高于同词频的正文命中（同一篇内标题命中额外加权）
    const title = await searchVaultPrior(root.replace(/\\/g, '/'), '学习中心', q('吉他和弦'), {}, nodeVaultFs)
    assert.ok(title.hits[0]!.score > 0)

    // 只读纪律：检索后个人笔记原样
    assert.equal(readFileSync(join(root, '乐理', '和弦.md'), 'utf8'), personalNote)
    // 引擎通路：引擎构造的 vaultRoot 同款扫描
    const viaEngine = await searchVaultPrior(engine.vaultRoot, '学习中心', priorQueryTerms(['入门']))
    assert.equal(viaEngine.hits.length, 0)
  })
})

test('searchVaultPrior：标题命中加权高于同词频的正文命中（字段加权）', async () => {
  await withVault({
    files: [
      { path: '笔记/标题命中.md', content: '# 关键词甲\n\n无关内容。' },
      { path: '笔记/正文命中.md', content: '# 无关标题\n\n关键词甲。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['关键词甲'], { limit: 5 })
    const inTitle = r.hits.find(h => h.path === '笔记/标题命中.md')!
    const inBody = r.hits.find(h => h.path === '笔记/正文命中.md')!
    assert.ok(inTitle.score > inBody.score, '标题是短字段：命中即强信号（旧核 +3 vs +1 的数量关系在新核里保留）')
  })
})

test('searchVaultPrior：机器块不进摘录也不参与打分（笔记抄录课程正文的串味源）', async () => {
  await withVault({
    files: [
      // 真摘录 + 尾部机器块：摘录保留正文、剥掉机器块
      { path: '乐理/笔记甲.md', content: '# 大三度\n\n大三度是三和弦的底色。\n\n<!-- enc_candidates: [三和弦] -->' },
      // 整条只剩机器块：剥除后无检索词命中 → 不入结果
      { path: '乐理/笔记乙.md', content: '# 杂记\n\n<!-- enc_candidates: [小三度] -->' },
      // 学习者手写的跨行 HTML 注释是笔记内容：原样保留，不剥（机器块 ≠ 一般 HTML 注释）
      { path: '乐理/笔记丙.md', content: '# 大三度听感\n\n<!-- 私人备忘：\n   这段先不给人看 -->\n大三度按起来很顺手。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['大三度', '小三度'], { limit: 5 })
    const paths = r.hits.map(h => h.path)
    assert.ok(!paths.includes('乐理/笔记乙.md'), '纯机器块笔记不打分（引擎元数据不算学习者知识）')
    const 甲 = r.hits.find(h => h.path === '乐理/笔记甲.md')!
    assert.match(甲.excerpt, /三和弦的底色/)
    assert.doesNotMatch(甲.excerpt, /enc_candidates/, '机器块不进摘录（不当输出示范）')
    const 丙 = r.hits.find(h => h.path === '乐理/笔记丙.md')!
    assert.match(丙.excerpt, /私人备忘/, '学习者手写的跨行 HTML 注释原样保留（只剥机器块）')
  })
})

// ---- 行为：审计（零命中与两种截断必留痕）----

test('审计：无检索词 = 零命中 + 零扫描（两条静默路径合流到同一读数）', async () => {
  await withVault({ files: [{ path: '笔记/甲.md', content: '# 甲\n\n内容。' }] }, async ({ root }) => {
    const r = await searchVaultPrior(root.replace(/\\/g, '/'), '学习中心', [], {}, nodeVaultFs)
    assert.equal(r.hits.length, 0)
    assert.deepEqual(r.audit.terms, [])
    assert.equal(r.audit.scanned, 0, '无词不扫描（检索面空转是纯浪费）')
    assert.equal(r.audit.zeroHit, true)
  })
})

test('审计：结果面截断（命中数 > limit）留痕，命中清单只带实际注入的那些', async () => {
  await withVault({
    files: [
      { path: '笔记/一.md', content: '# 一\n\n关键词甲。' },
      { path: '笔记/二.md', content: '# 二\n\n关键词甲。' },
      { path: '笔记/三.md', content: '# 三\n\n关键词甲。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['关键词甲'], { limit: 1 })
    assert.equal(r.hits.length, 1)
    assert.equal(r.audit.matched, 3, '命中面 3 篇（截断前的真实命中数）')
    assert.equal(r.audit.hitsTrimmed, true)
    assert.equal(r.audit.hitPaths.length, 1)
    assert.equal(r.audit.scanTruncated, false, '扫描面没截——被截的是结果面')
  })
})

test('审计：扫描面截断改 mtime 优先（旧口径按目录字典序＝系统性偏斜）', async () => {
  await withVault({
    files: [
      // 字典序在前的是「旧」文件；新近改动的排在字典序之后
      { path: '笔记/a-旧.md', content: '# 旧\n\n关键词甲。' },
      { path: '笔记/z-新.md', content: '# 新\n\n关键词甲。' },
    ],
  }, async ({ root }) => {
    // 写盘顺序已保证新旧，但毫秒可能并列 → 显式拉开（排序是 mtime 优先，并列按路径）
    await utimes(join(root, '笔记', 'a-旧.md'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
    await utimes(join(root, '笔记', 'z-新.md'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))

    const r = await search(root, ['关键词甲'], { maxFiles: 1 })
    assert.equal(r.audit.scanTruncated, true, '读取面被 maxFiles 封顶 = 扫描面截断，必留痕')
    assert.equal(r.audit.scanned, 1)
    assert.deepEqual(r.audit.hitPaths, ['笔记/z-新.md'], '取最近改动的那篇（旧口径会取字典序在前的 a-旧）')
  })
})

// ---- 行为：登记表查询扩展（Furnas 词表问题）----

const TRI_ENTRY: ConceptEntry = { canonical: '三角函数', aliases: ['三角比'], confusable: ['反三角函数'] }

test('查询扩展：只写了别名的笔记也能被召回（别名命中可复现）', async () => {
  await withVault({
    files: [{ path: '笔记/我的记法.md', content: '# 我的叫法\n\n我一直管它叫「三角比」。' }],
  }, async ({ root }) => {
    const without = await search(root, ['三角函数'])
    assert.equal(without.hits.length, 0, '不扩词：学习者用自己的记法写笔记 → 零命中（Furnas 词表问题）')
    assert.equal(without.audit.zeroHit, true)

    const withExpansion = await search(root, ['三角函数'], {}, [TRI_ENTRY])
    assert.equal(withExpansion.hits.length, 1, '扩词后召回（别名低权重并入）')
    assert.equal(withExpansion.hits[0]!.path, '笔记/我的记法.md')
    assert.deepEqual(withExpansion.audit.terms, ['三角函数'])
    assert.ok(withExpansion.audit.expanded.includes('三角比'), '扩展词随审计带出')
  })
})

test('查询扩展：扩展词低权重——规范词命中排在别名命中之前（词面证据强度有别）', async () => {
  await withVault({
    files: [
      { path: '笔记/别名篇.md', content: '# 别名\n\n三角比。' },
      { path: '笔记/规范词篇.md', content: '# 规范\n\n三角函数。' },
    ],
  }, async ({ root }) => {
    const r = await search(root, ['三角函数'], {}, [TRI_ENTRY])
    assert.equal(r.hits.length, 2)
    assert.equal(r.hits[0]!.path, '笔记/规范词篇.md', '规范词命中优先于别名命中（0.5 权重不是同义断言）')
  })
})

test('queryEntriesFor：登记表 Missing = 空表合法；Broken = 扩展跳过但错误带出（不静默）', async () => {
  await withVault({}, async ({ engine }) => {
    assert.deepEqual(await queryEntriesFor(engine.concepts, 'math'), { entries: [] }, '缺失合法空态')
  })
  await withVault({
    files: [{ path: '学习中心/math/概念登记表.yaml', content: 'concepts:\n  - canonical: "缺引号\n' }],
  }, async ({ engine }) => {
    const r = await queryEntriesFor(engine.concepts, 'math')
    assert.deepEqual(r.entries, [], '扩展面降级为空表')
    assert.match(r.error ?? '', /概念登记表 Broken/, '降级绝不静默：错误随审计带出')
  })
})

// ---- 行为：生成入口注入 ----

test('V-2 注入：contentPack 附「学习者已有理解」段；零命中不注入；审计经 onPrior 带出', async () => {
  await withVault({
    files: [{ path: '乐理/音程.md', content: '# 我的音程笔记\n\n入门的时候我总把大三度和小三度听混，后来用「大=宽」记住的。' }],
  }, async ({ engine }) => {
    const audits: Array<{ hitPaths: string[]; zeroHit: boolean; scanned: number }> = []
    const pack = await engine.content2.contentPack('数学', '入门', { onPrior: a => audits.push(a) })
    assert.match(pack, /学习者已有理解（Vault 先验）/)
    assert.match(pack, /我的音程笔记/)
    assert.match(pack, /永不改写/)
    assert.equal(audits.length, 1, '每次取包必产一份审计')
    assert.deepEqual(audits[0]!.hitPaths, ['乐理/音程.md'], '命中文件清单带出')
    assert.equal(audits[0]!.zeroHit, false)
  })

  await withVault({}, async ({ engine }) => {
    let audit: { zeroHit: boolean; scanned: number } | null = null
    const pack = await engine.content2.contentPack('数学', '入门', { onPrior: a => { audit = a } })
    assert.doesNotMatch(pack, /学习者已有理解/, '零命中零注入（生成面不带空段）')
    assert.ok(audit && audit.zeroHit, '零命中留痕（旧实现读不出「检索过没有」）')
  })
})

test('V-2 注入：出题提示词带先验段（综合与逐节同款），审计经 opts.onPrior 带出', async () => {
  await withVault({
    notes: {
      入门: {
        content: { sections: ['    - id: s1', '      title: 概念：大三度', '      type: 概念', '      status: ready', '      version: 1'] },
        body: ['# 入门', '', '## 概念：大三度', '', '大三度 = 4 个半音，口诀「大=宽」。'],
      },
    },
    files: [{ path: '乐理/音程.md', content: '# 音程随记\n\n入门时我总把大三度听成小三度，直到用了「宽窄」口诀。' }],
  }, async ({ engine }) => {
    const prompts: string[] = []
    const audits: Array<{ hitPaths: string[] }> = []
    const r = await engine.bank2.questionGenerate('数学', '入门', 1, async prompt => {
      prompts.push(prompt)
      return 'node: 入门\nquestions:\n  - kind: true_false\n    q: 大三度比小三度宽（口诀「大=宽」）。\n    answer: true'
    }, { onPrior: a => audits.push(a) })
    assert.equal(r.added, 1)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]!, /学习者已有理解（Vault 先验）/)
    assert.match(prompts[0]!, /宽窄/)
    assert.deepEqual(audits[0]!.hitPaths, ['乐理/音程.md'], '出题站的先验审计同样带出')

    // 逐节管线同款注入（节清单播种在 frontmatter，正文按标题切分）
    const audits2: Array<{ hitPaths: string[] }> = []
    await engine.bank2.questionGenerateSections('数学', '入门', async () => {
      return 'questions:\n  - kind: true_false\n    q: 节题。\n    answer: true'
    }, { onPrior: a => audits2.push(a) })
    assert.equal(audits2.length, 1, '逐节批的审计也带出（同一检索，一次）')
    assert.deepEqual(audits2[0]!.hitPaths, ['乐理/音程.md'])
  })
})

test('V-2 注入：登记表别名扩展在生成入口生效（规范词 → 学习者私人记法）', async () => {
  await withVault({
    files: [
      // 登记表：入门 的别名是「起步」（学习者可能用别名写笔记）
      { path: '学习中心/math/概念登记表.yaml', content: 'concepts:\n  - canonical: 入门\n    aliases: [起步]\n' },
      { path: '乐理/我的一步.md', content: '# 起步随记\n\n起步那会儿我只知道「三比」这个说法。' },
    ],
  }, async ({ engine }) => {
    let audit: { expanded: string[]; hitPaths: string[] } | null = null
    const pack = await engine.content2.contentPack('数学', '入门', { onPrior: a => { audit = a } })
    assert.ok(audit && audit.expanded.includes('起步'), '别名并入检索词')
    assert.deepEqual(audit!.hitPaths, ['乐理/我的一步.md'], '只写了别名「起步」的笔记被召回')
    assert.match(pack, /我的一步/)
  })
})
