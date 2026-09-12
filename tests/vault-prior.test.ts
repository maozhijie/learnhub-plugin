/**
 * Vault 先验上下文注入（V-2 / #106）：生成节点内容/题目时检索学习者 Vault 相关笔记
 * 并注入生成上下文，正文尊重「你已有的理解与记法」。
 *
 * - 前置探测结论（票内落档，模块头注同文）：宿主 dsh-llm/dsh-tools 0.1.2-rc.1 导出
 *   面无检索/嵌入 API → 按 #78 预案降级为纯扫描关键词检索。
 * - ADR-0010 只读纪律：检索永不写个人笔记——纯扫描只读，学习中心与点目录排除。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priorTerms, searchVaultPrior, priorSection, excerptAround } from '../src/engine/vault-prior.ts'
import { nodeVaultFs } from '../src/host/vault-fs.ts'
import { withVault } from './helpers/vault.ts'

// ---- 纯函数 ----

test('priorTerms：按分隔符切分，全词 ≥2 字符，去重保序', () => {
  assert.deepEqual(priorTerms(['三角函数/诱导公式', '傅立叶，级数']), ['三角函数', '诱导公式', '傅立叶', '级数'])
  assert.deepEqual(priorTerms(['a', ' 波动方程 ', '']), ['波动方程'])
  assert.deepEqual(priorTerms([]), [])
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

// ---- 行为：纯扫描检索 ----

test('searchVaultPrior：命中中心外个人笔记；学习中心与点目录排除；标题命中权重高；只读', async () => {
  const personalNote = '# 吉他和弦笔记\n\n我习惯把大三度记成「三大度」，练习时先听再按。'
  await withVault({
    files: [
      { path: '乐理/和弦.md', content: personalNote },
      { path: '乐理/.obsidian/缓存.md', content: '# 大三度\n\n不该被扫到。' },
      { path: '学习中心/数学/课程/基础/杂记.md', content: '# 大三度\n\n中心内不是先验来源。' },
      { path: '乐理/无关.md', content: '# 购物清单\n\n牛奶 鸡蛋。' },
    ],
  }, async ({ engine, root }) => {
    const vault = root.replace(/\\/g, '/')
    const hits = await searchVaultPrior(vault, '学习中心', ['大三度', '吉他和弦'], {}, nodeVaultFs)
    assert.equal(hits.length, 1, '中心内与点目录条目不入结果')
    assert.equal(hits[0].path, '乐理/和弦.md')
    assert.equal(hits[0].title, '吉他和弦笔记')
    assert.match(hits[0].excerpt, /三大度|大三度/)

    assert.equal((await searchVaultPrior(vault, '学习中心', ['不存在的词'], {}, nodeVaultFs)).length, 0)

    // 只读纪律：检索后个人笔记原样
    assert.equal(readFileSync(join(root, '乐理', '和弦.md'), 'utf8'), personalNote)
    // 引擎通路：引擎构造的 vaultRoot 同款扫描
    const viaEngine = await searchVaultPrior(engine.vaultRoot, '学习中心', priorTerms(['入门']))
    assert.equal(viaEngine.length, 0)
  })
})

test('searchVaultPrior：机器块不进摘录也不参与打分（笔记抄录课程正文的串味源）', async () => {
  await withVault({
    files: [
      // 真摘录 + 尾部机器块：摘录保留正文、剥掉机器块
      { path: '乐理/笔记甲.md', content: '# 大三度\n\n大三度是三和弦的底色。\n\n<!-- enc_candidates: [三和弦] -->' },
      // 整条只剩机器块：剥除后无检索词命中 → score 0，不入结果
      { path: '乐理/笔记乙.md', content: '# 杂记\n\n<!-- enc_candidates: [小三度] -->' },
      // 学习者手写的跨行 HTML 注释是笔记内容：原样保留，不剥（机器块 ≠ 一般 HTML 注释）
      { path: '乐理/笔记丙.md', content: '# 大三度听感\n\n<!-- 私人备忘：\n   这段先不给人看 -->\n大三度按起来很顺手。' },
    ],
  }, async ({ root }) => {
    const vault = root.replace(/\\/g, '/')
    const hits = await searchVaultPrior(vault, '学习中心', ['大三度', '小三度'], { limit: 5 }, nodeVaultFs)
    const paths = hits.map(h => h.path)
    assert.ok(!paths.includes('乐理/笔记乙.md'), '纯机器块笔记不打分（引擎元数据不算学习者知识）')
    const 甲 = hits.find(h => h.path === '乐理/笔记甲.md')!
    assert.match(甲.excerpt, /三和弦的底色/)
    assert.doesNotMatch(甲.excerpt, /enc_candidates/, '机器块不进摘录（不当输出示范）')
    const 丙 = hits.find(h => h.path === '乐理/笔记丙.md')!
    assert.match(丙.excerpt, /私人备忘/, '学习者手写的跨行 HTML 注释原样保留（只剥机器块）')
  })
})

// ---- 行为：生成入口注入 ----

test('V-2 注入：contentPack 附「学习者已有理解」段；零命中不注入', async () => {
  await withVault({
    files: [{ path: '乐理/音程.md', content: '# 我的音程笔记\n\n入门的时候我总把大三度和小三度听混，后来用「大=宽」记住的。' }],
  }, async ({ engine }) => {
    const pack = await engine.content2.contentPack('数学', '入门')
    assert.match(pack, /学习者已有理解（Vault 先验）/)
    assert.match(pack, /我的音程笔记/)
    assert.match(pack, /永不改写/)
  })

  await withVault({}, async ({ engine }) => {
    const pack = await engine.content2.contentPack('数学', '入门')
    assert.doesNotMatch(pack, /学习者已有理解/, '零命中零注入（生成面不带空段）')
  })
})

test('V-2 注入：出题提示词带先验段（综合与逐节同款），题目照常过门禁落库', async () => {
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
    const r = await engine.bank2.questionGenerate('数学', '入门', 1, async prompt => {
      prompts.push(prompt)
      return 'node: 入门\nquestions:\n  - kind: true_false\n    q: 大三度比小三度宽（口诀「大=宽」）。\n    answer: true'
    })
    assert.equal(r.added, 1)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /学习者已有理解（Vault 先验）/)
    assert.match(prompts[0], /宽窄/)

    // 逐节管线同款注入（节清单播种在 frontmatter，正文按标题切分）
    const prompts2: string[] = []
    await engine.bank2.questionGenerateSections('数学', '入门', async prompt => {
      prompts2.push(prompt)
      return 'questions:\n  - kind: true_false\n    q: 节题。\n    answer: true'
    })
    assert.ok(prompts2.length >= 1, '内容节应有出题调用')
    assert.match(prompts2[0], /学习者已有理解（Vault 先验）/)
  })
})
