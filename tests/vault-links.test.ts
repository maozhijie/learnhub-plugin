import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import {
  parseWikilinks, stripCodeFences, isDateTarget, isNonMdTarget, normalizeLinkName,
  linkNameOfPath, buildNameIndex, linkScore, scoreTier, mapEdgesToNodes, orientLinkPair,
  dirExcluded, VAULT_LINK_DEFAULT_DIR_EXCLUDES,
} from '../src/engine/vault-links.ts'
import { withVault as makeVault } from './helpers/vault.ts'

// ---- 纯函数缝：wikilink 解析 ----

test('纯函数缝：wikilink 解析（嵌入/别名/锚点/.md 剥离/围栏排除）', () => {
  const links = parseWikilinks([
    '[[目标笔记]]',
    '![[图片.png]]',
    '[[目标笔记|显示名]]',
    '[[长笔记#某标题]]',
    '[[长笔记#某标题|别名]]',
    '[[子目录/目标.md]]',
    '[[  空 白  目标 ]]',
    '[[2026-04-28 日记]]',
  ].join('\n'))
  assert.deepEqual(links, [
    { embed: false, target: '目标笔记' },
    { embed: true, target: '图片.png' },
    { embed: false, target: '目标笔记', alias: '显示名' },
    { embed: false, target: '长笔记' },
    { embed: false, target: '长笔记', alias: '别名' },
    { embed: false, target: '子目录/目标' },
    { embed: false, target: '空 白 目标' },
    { embed: false, target: '2026-04-28 日记' },
  ])

  // 代码围栏里的文档示例不进先验
  assert.equal(parseWikilinks('正文 [[真链接]]\n```md\n[[围栏里的示例]]\n```\n').length, 1)
  assert.match(stripCodeFences('a\n```x\nb\nc\n```\nd'), /^a\n\nd$/)

  assert.equal(isDateTarget('2026-04-28 编程笔记'), true)
  assert.equal(isDateTarget('2026 回顾'), false)
  assert.equal(isNonMdTarget('日记.base'), true)
  assert.equal(isNonMdTarget('截图.png'), true)
  assert.equal(isNonMdTarget('笔记.md'), false)
  assert.equal(isNonMdTarget('笔记.MD'), false)
  assert.equal(isNonMdTarget('无扩展名'), false)
  // 含点标题是正经笔记名（资产白名单制，不见点就滤）
  assert.equal(isNonMdTarget('Node.js 入门'), false)
  assert.equal(isNonMdTarget('笔记/v2.1 变更'), false)
})

test('纯函数缝：名字归一与 basename 索引（全半角折叠、撞车取最短）', () => {
  assert.equal(normalizeLinkName('入门 Node'), normalizeLinkName('入门node'))
  assert.equal(normalizeLinkName('ＡＢＣ'), normalizeLinkName('abc'))
  assert.equal(linkNameOfPath('笔记/深层/入门.md'), '入门')

  const { index, ambiguous } = buildNameIndex([
    'a/b/同名.md', '短/同名.md', '唯一.md', 'x/y/嵌套/同名.md',
  ])
  assert.equal(index.get(normalizeLinkName('同名')), '短/同名.md', '撞车取最短路径（Obsidian 缺省解析）')
  assert.equal(index.get(normalizeLinkName('唯一')), '唯一.md')
  assert.equal(ambiguous, 1)
})

test('纯函数缝：置信度打分与分层（次数/独立源/双向；≥0.7 提案、0.4–0.7 待裁决）', () => {
  assert.equal(linkScore(1, 1, false), 0.2) // 单文件单次：只落报告
  assert.equal(linkScore(3, 1, false), 0.4) // 同文件 3 次：进待裁决
  assert.equal(linkScore(4, 2, false), 0.6)
  assert.equal(linkScore(4, 1, true), 0.7) // 4 次单源 + 双向：到提案门槛
  assert.equal(linkScore(5, 3, true), 1) // 全饱和封顶
  assert.equal(scoreTier(0.7), 'proposal')
  assert.equal(scoreTier(0.69), 'review')
  assert.equal(scoreTier(0.4), 'review')
  assert.equal(scoreTier(0.39), 'report')
})

test('纯函数缝：候选边映射图节点（双端精确命中才成对）与方向裁决（pre 闭包外不成边）', () => {
  const edges = [
    { a: '笔记/入门.md', b: '笔记/进阶.md', count: 5, files: 2, sources: [], bidirectional: true, w: 1 },
    { a: '笔记/入门.md', b: '笔记/无关.md', count: 3, files: 1, sources: [], bidirectional: false, w: 0.4 },
    { a: '笔记/入门.md', b: '其他/入门.md', count: 2, files: 1, sources: [], bidirectional: false, w: 0.3 },
  ] as const
  const mapped = mapEdgesToNodes(edges as unknown as Parameters<typeof mapEdgesToNodes>[0], ['入门', '进阶'])
  assert.equal(mapped.length, 1)
  assert.equal(mapped[0]!.aNode, '入门')
  assert.equal(mapped[0]!.bNode, '进阶')

  const ancestor = (from: string, to: string) => from === '入门' && to === '进阶'
  assert.deepEqual(orientLinkPair('入门', '进阶', ancestor), { ok: true, skill: '入门', holder: '进阶' })
  assert.deepEqual(orientLinkPair('进阶', '入门', ancestor), { ok: true, skill: '入门', holder: '进阶' })
  const blocked = orientLinkPair('平行', '进阶', ancestor)
  assert.equal(blocked.ok, false)
  assert.match(blocked.ok ? '' : blocked.why, /pre 关系/)
})

test('纯函数缝：目录段排除（x* 段前缀、其余段全等）', () => {
  assert.equal(dirExcluded('99附件/图.md', VAULT_LINK_DEFAULT_DIR_EXCLUDES), true)
  assert.equal(dirExcluded('notes/过时20260903/旧.md', VAULT_LINK_DEFAULT_DIR_EXCLUDES), true)
  assert.equal(dirExcluded('notes/过时备查/旧.md', VAULT_LINK_DEFAULT_DIR_EXCLUDES), true)
  assert.equal(dirExcluded('01笔记/正文.md', VAULT_LINK_DEFAULT_DIR_EXCLUDES), false)
})

// ---- 引擎行为：扫描 → 缓存 → analyze 段 → 单提案回填 ----

/** 双节点图：入门(pre []) → 进阶(pre [入门])；另有 平行/未关联 验证 blocked。 */
const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 平行, pre: [], opt: false, note: "", est: 15 }',
  '  - name: 进阶块',
  '    nodes:',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 30 }',
  '      - { name: 未关联, pre: [], opt: false, note: "", est: 20 }',
].join('\n')

const NOTE = (title: string, body: string[]) =>
  [`# ${title}`, '', ...body].join('\n')

interface LinksVault {
  engine: LearnhubEngine
  root: string
  notePaths: Record<string, string>
}

/** 带四节点课程 + 根目录四篇个人笔记（互链强度分层）的 vault。 */
async function withLinksVault(run: (v: LinksVault) => Promise<void>): Promise<void> {
  await makeVault({
    tag: 'learnhub-vaultlinks-',
    graph: GRAPH,
    notes: {
      入门: {}, 平行: {}, 进阶: {}, 未关联: {},
    },
    files: [
      { path: '入门.md', content: NOTE('入门', ['[[进阶]]']) },
      { path: '进阶.md', content: NOTE('进阶', ['[[入门]]', '[[入门]]', '[[入门]]', '[[入门]]', '[[未关联]]']) },
      { path: '平行.md', content: NOTE('平行', ['[[入门]]', '[[入门]]', '[[入门]]']) },
      { path: '未关联.md', content: NOTE('未关联', ['[[进阶]]', '[[进阶]]', '[[进阶]]', '[[进阶]]']) },
      // 噪声：嵌入/日期/非 md 目标/unresolved/自链
      { path: '噪声.md', content: NOTE('噪声', [
        '![[图.png]]', '[[2026-04-30 日记]]', '[[日记.base]]', '[[不存在的手记]]', '[[噪声]]',
        '```md', '[[围栏示例]]', '```',
      ]) },
    ],
  }, async ({ engine, root }) => {
    await run({
      engine, root,
      notePaths: Object.fromEntries(['入门', '进阶', '平行', '未关联'].map(n => [n, join(root, `${n}.md`)])),
    })
  })
}

test('扫描：去噪管线全绿、审计带命中计数、缓存落 state、个人笔记字节不变', async () => {
  await withLinksVault(async ({ engine, root, notePaths }) => {
    const before = await readFile(notePaths.入门!, 'utf8')
    const r = await engine.vaultLinksScan()

    assert.equal(r.scanned_files, 5, '学习中心排除；根目录 5 篇个人笔记全扫')
    assert.equal(r.truncated, false, '未触文件数上限')
    assert.equal(r.tiers.proposal, 2, '入门↔进阶、进阶↔未关联 两对强链接')
    assert.equal(r.tiers.review, 1, '平行→入门 ×3 单源无反向 = 0.4 待裁决')
    const top = r.edges[0]!
    assert.equal(top.a, '入门.md')
    assert.equal(top.b, '进阶.md')
    assert.equal(top.count, 5)
    assert.equal(top.files, 2)
    assert.equal(top.tier, 'proposal')
    // 待裁决层：平行→入门 ×3（单源无反向）
    const review = r.edges.find(e => e.a === '入门.md' && e.b === '平行.md')
    assert.equal(review?.tier, 'review')
    assert.equal(review?.w, 0.4)
    // 审计：噪声文件各规则命中
    assert.equal(r.audit.embed, 1)
    assert.equal(r.audit.date_target, 1)
    assert.equal(r.audit.non_md, 1)
    assert.equal(r.unresolved, 1)
    assert.equal(r.audit.self_link, 1)
    assert.equal(r.links_seen, 1 + 5 + 3 + 4 + 5, '分母 = 全部 wikilink 命中（围栏内的不计）')
    // 缓存落引擎 state 区（个人笔记零写入）
    assert.ok(existsSync(engine.paths.vaultLinksPath))
    const cache = JSON.parse(await readFile(engine.paths.vaultLinksPath, 'utf8')) as {
      version: number; fingerprints: Record<string, string>; generated_at: string
    }
    assert.equal(cache.version, 1)
    assert.equal(Object.keys(cache.fingerprints).length, 5)
    assert.match(cache.generated_at, /T/)
    assert.equal(await readFile(notePaths.入门!, 'utf8'), before)
    void root
  })
})

test('扫描排除区：学习中心/点目录/内置目录排除/用户排除清单；vault_link_excludes 整体替换内置清单', async () => {
  await withLinksVault(async ({ engine, root }) => {
    await mkdir(join(root, '99附件'), { recursive: true })
    await writeFile(join(root, '99附件', '附件.md'), NOTE('附件', ['[[入门]]']), 'utf8')
    await mkdir(join(root, '.obsidian'), { recursive: true })
    await writeFile(join(root, '.obsidian', '配置.md'), NOTE('配置', ['[[入门]]']), 'utf8')
    await mkdir(join(root, '私密区'), { recursive: true })
    await writeFile(join(root, '私密区', '手记.md'), NOTE('手记', ['[[入门]]']), 'utf8')
    await engine.noteSourceExclude('私密区')

    const base = await engine.vaultLinksScan()
    assert.equal(base.scanned_files, 5, '99附件 与 私密区 不进扫描')
    assert.equal(base.edges.some(e => e.a.includes('附件') || e.b.includes('附件')), false)

    // 配置整体替换内置清单：99附件 回到扫描、新名单生效
    const cfg = JSON.parse(await readFile(engine.paths.learnhubConfigPath, 'utf8')) as Record<string, unknown>
    await writeFile(engine.paths.learnhubConfigPath,
      JSON.stringify({ ...cfg, vault_link_excludes: ['私密区'] }, null, 1) + '\n', 'utf8')
    const overridden = await engine.vaultLinksScan()
    assert.equal(overridden.scanned_files, 6, '99附件 不再被内置清单排除（私密区仍被新名单排除）')
    assert.equal(overridden.edges.some(e => e.a.endsWith('附件.md') || e.b.endsWith('附件.md')), true)
  })
})

test('analyze 建议段：候选映射到图节点（proposal/review 分层 + 行动指引）；未扫描带 hint', async () => {
  await withLinksVault(async ({ engine }) => {
    // 未扫描：空段 + hint（零 schema 破坏——新字段缺省可空）
    const before = await engine.graphAnalyze('数学') as Record<string, unknown>
    const beforeSug = before.suggestions as Record<string, unknown>
    assert.deepEqual(beforeSug.vault_link_candidates, [])
    assert.equal((before.vault_links as Record<string, unknown>).scanned_at, null)
    assert.match(String((before.vault_links as Record<string, unknown>).hint), /vault_links_scan/)

    await engine.vaultLinksScan()
    const doc = await engine.graphAnalyze('数学') as Record<string, unknown>
    const cands = (doc.suggestions as Record<string, unknown>).vault_link_candidates as Array<Record<string, unknown>>
    assert.equal((doc.vault_links as Record<string, unknown>).scanned_at !== null, true)
    // 全部候选对的两端都映射到图节点（笔记名 = 节点名）
    assert.equal(cands.length >= 3, true)
    const names = new Set(['入门', '进阶', '平行', '未关联'])
    for (const c of cands) {
      assert.ok(names.has(String(c.a)) && names.has(String(c.b)), `候选两端在图内：${c.a}/${c.b}`)
      assert.equal(['proposal', 'review'].includes(String(c.tier)), true)
      assert.match(String(c.suggestion), /learnhub_graph/)
    }
    const pair = cands.find(c => new Set([c.a, c.b]).size === 2
      && [c.a, c.b].every(n => ['入门', '进阶'].includes(String(n))))
    assert.equal(pair?.tier, 'proposal')
  })
})

test('链接先验回填：pre 闭包内成 enrich 单提案（既有 enc 保留、可重入）；闭包外降级 blocked_no_pre', async () => {
  await withLinksVault(async ({ engine }) => {
    await engine.vaultLinksScan()
    const r = await engine.graphLinkBackfill('数学')

    assert.equal(r.ops, 1, '入门→进阶（pre 闭包内）成边；进阶↔未关联 无 pre 关系不硬提')
    assert.equal(r.proposal !== null, true)
    assert.equal(r.blocked_no_pre.length, 1)
    assert.deepEqual(
      { a: r.blocked_no_pre[0]!.a, b: r.blocked_no_pre[0]!.b },
      { a: '未关联', b: '进阶' },
    )
    // 提案内容：覆盖层字段条目挂在 holder=进阶，skill=入门，w 保留，note 可溯源（#140 kind=enrich）
    const proposals = await engine.graphProposals('pending', 'enrich')
    const prop = proposals.find(p => p.id === r.proposal!.id)
    assert.ok(prop, '提案在 pending 列表')
    assert.equal(prop!.kind, 'enrich')
    const yamlText = await readFile(
      engine.paths.proposalArtifactPath(r.proposal!.id, 'enrich', '数学'), 'utf8')
    assert.match(yamlText, /fields:/)
    assert.match(yamlText, /node: 进阶/)
    assert.match(yamlText, /fingerprints:/)
    assert.match(yamlText, /vault 链接先验（#91）/)
    assert.match(yamlText, /w: 0.9/)

    // 可重入：提案过审 apply 后，同一批候选不再重复提名（已声明边跳过）
    await engine.graphApply('enrich', r.proposal!.id)
    const r2 = await engine.graphLinkBackfill('数学')
    assert.equal(r2.ops, 0)
    assert.equal(r2.proposal, null)
    assert.equal(r2.skipped_declared, 1, '已落图边不再提名；blocked 对维持信号')
  })

  await makeVault({ tag: 'learnhub-vaultlinks-nocache-', graph: GRAPH, notes: { 入门: {} } }, async ({ engine }) => {
    await assert.rejects(() => engine.graphLinkBackfill('数学'), /先跑 learnhub_vault_links_scan/)
  })
})
