/**
 * 概念 merge 确定性派生器（#274）：非对话通道的合并候选提议（提案 + 人审）。
 *
 * 照 #265 confusable 派生完全同构的范式：纯函数（三条确定性信号、同输入同输出、
 * 已声明/废弃不提名）+ 子系统触发面（产 N 条待审提案、重跑不堆、max 封顶）+
 * 提案面（候选过 validateConceptMergeProposal、人审 apply 后登记表并入）。
 * 信任边界不动：apply 仍只有面板人审一条路（ADR-0084），派生只产提案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mergeCandidates, validateConceptMergeProposal,
  MERGE_TEXT_THRESHOLD, MERGE_FOOTPRINT_THRESHOLD, MERGE_INVOKES_THRESHOLD,
} from '../src/engine/concepts.ts'
import type { ConceptEntry } from '../src/engine/concepts.ts'
import { YAML } from '../src/engine/yaml.ts'
import { withVault } from './helpers/vault.ts'

// ---- 纯函数：三条信号各一票；已声明/废弃不提名；同输入同输出 ----

const PC_ENTRIES: ConceptEntry[] = [
  { canonical: '因式分解', definition: '把多项式化为几个整式的乘积' },
  { canonical: '因式分解法', definition: '把多项式化为几个整式的乘积形式' },
  { canonical: '丙' },
  { canonical: '丁', confusable: ['丙'] },
  { canonical: '戊', deprecated: true },
]

const PC_FOOTPRINT = {
  丙: ['入门', '进阶'],
  丁: ['入门', '进阶'], // 与丙足迹全同，但已声明 confusable → 不提名
  戊: ['入门'], // 废弃 → 退出候选面
}

const PC_INVOKES = {
  丙: ['入门'],
  丁: ['入门'],
  // 因式分解对不进 invokes 表（否则 invokes 信号会叠加，名面信号单轴断言就不纯了）
}

test('#274 派生器：名面重叠/足迹/invokes 三信号；已声明 confusable 跳过；废弃退出；同输入同输出', () => {
  const cands = mergeCandidates(PC_FOOTPRINT, PC_INVOKES, PC_ENTRIES)
  // 丙-丁（足迹 + invokes 双命中）已声明 confusable → 跳过；戊废弃不出现；
  // 唯一候选 = 因式分解-因式分解法（名面重叠，定义文本也重叠）
  assert.deepEqual(cands.map(c => [c.a, c.b]), [['因式分解', '因式分解法']])
  const [cand] = cands
  assert.ok(cand!.weight >= 1)
  assert.ok(cand!.evidence.some(l => l.includes('名面重叠')), '名面重叠信号落证据')
  assert.ok(cand!.evidence.every(l => l.includes('名面重叠')), '证据逐条可查（本对只有名面信号）')
  // a 字典序在前（确定性定序；并入向由人审定夺）
  assert.equal(cand!.a, '因式分解')
  assert.deepEqual(mergeCandidates(PC_FOOTPRINT, PC_INVOKES, PC_ENTRIES), cands, '同输入同输出（候选面可复现）')
})

test('#274 派生器：足迹雷同与 invokes 分布相近各自独立成票', () => {
  const entries: ConceptEntry[] = [{ canonical: '甲' }, { canonical: '乙' }]
  // 足迹全同、invokes 不重叠 → 只有足迹一票
  const fpOnly = mergeCandidates({ 甲: ['入门', '进阶'], 乙: ['入门', '进阶'] }, { 甲: ['入门'], 乙: ['进阶'] }, entries)
  assert.deepEqual(fpOnly.map(c => [c.a, c.b, c.weight]), [['甲', '乙', 1]])
  assert.ok(fpOnly[0]!.evidence[0]!.includes('足迹雷同'))
  // invokes 全同、无足迹 → 只有 invokes 一票
  const inv = mergeCandidates({}, { 甲: ['入门', '进阶'], 乙: ['入门', '进阶'] }, entries)
  assert.deepEqual(inv.map(c => [c.a, c.b, c.weight]), [['甲', '乙', 1]])
  assert.ok(inv[0]!.evidence[0]!.includes('invokes 分布相近'))
  // 阈值之下不提名：单节点足迹重叠 Jaccard=1 阈值边界（等于阈值即提名）
  assert.equal(MERGE_TEXT_THRESHOLD, 0.6)
  assert.equal(MERGE_FOOTPRINT_THRESHOLD, 0.8)
  assert.equal(MERGE_INVOKES_THRESHOLD, 0.8)
})

// ---- 子系统触发面：信号 → 待审提案；重跑不堆；max 封顶；人审 apply 落盘 ----

// #284 存储塌缩：单文件 data/图.yaml { nodes: [...] }
const MC_GRAPH = [
  'nodes:',
  '  - { name: 入门, pre: [], opt: false, note: "", est: 20, teaches: { 丙: 知道, 庚: 知道 } }',
  '  - { name: 进阶, pre: [入门], opt: false, note: "", est: 20, teaches: { 丙: 知道, 庚: 知道 } }',
].join('\n')

const MC_REGISTRY = [
  'concepts:',
  '  - canonical: 丙',
  '  - canonical: 庚',
  '  - canonical: 因式分解',
  '  - canonical: 因式分解法',
].join('\n')

const q = (id: string, invokes: string) => ([
  `  - id: ${id}`,
  '    kind: true_false',
  `    q: ${id} 题干：说法是否成立。`,
  '    answer: true',
  `    invokes: ${invokes}`,
])

const MC_BANKS = {
  入门: [q('q1', '丙'), q('q2', '庚')] as string[][],
  进阶: [q('q3', '丙'), q('q4', '庚')] as string[][],
}

test('#274 conceptMergeCandidates：信号 → 待审合并提案（不可逆声明 + 证据）；重跑不堆；max 封顶', async () => {
  await withVault({
    tag: 'learnhub-mergecand-',
    graph: MC_GRAPH,
    files: [{ path: '学习中心/math/概念登记表.yaml', content: `${MC_REGISTRY}\n` }],
    banks: MC_BANKS,
  }, async ({ engine }) => {
    const r1 = await engine.graph.conceptMergeCandidates('数学')
    assert.equal(r1.filed.length, 2, '两对候选（丙-庚 双信号、因式分解-因式分解法 名面）→ 两条待审提案')
    assert.ok(r1.message.includes('待审'))
    const bingFiled = r1.filed.find(f => f.into === '丙')!
    assert.ok(bingFiled, '丙-庚 在列：并入向 = 字典序在前者（into=丙）')
    assert.equal(bingFiled.from, '庚')
    assert.equal(bingFiled.weight, 2, '足迹 + invokes 双信号 → weight 2')
    // 提案产物过 schema 门 + 不可逆声明 + 证据随产物落盘
    const p1 = (await engine.store.loadProposals()).find(x => x.id === bingFiled.id)!
    const artifact = YAML.parse(readFileSync(p1.artifact, 'utf8')) as Record<string, unknown>
    const v = validateConceptMergeProposal(artifact)
    assert.equal(v.errors, undefined)
    assert.ok(v.spec, '候选提案过 schema 门')
    assert.equal(v.spec!.course, '数学')
    assert.equal(artifact.irreversible, true, '不可逆声明随提案面落盘')
    assert.ok(String(artifact.reason).includes('确定性派生（#274）'))
    assert.ok(String(artifact.reason).includes('足迹雷同'), '证据逐条可查，人审据此判断')
    // 重跑：已在待审队列的对不再堆
    const r2 = await engine.graph.conceptMergeCandidates('数学')
    assert.equal(r2.filed.length, 0)
    assert.ok(r2.message.includes('没有新的'))
    const total = (await engine.store.loadProposals()).filter(x => x.kind === 'concept_merge').length
    assert.equal(total, 2)
    // max 封顶：单次产出 ≤ max（人审一次一条的吞吐）
    const rc = await engine.graph.conceptMergeCandidates('数学', 1)
    assert.equal(rc.filed.length, 0, '已全部在队列 → 封顶后仍为 0')
  })
  await withVault({
    tag: 'learnhub-mergecap-',
    graph: MC_GRAPH,
    files: [{ path: '学习中心/math/概念登记表.yaml', content: `${MC_REGISTRY}\n` }],
    banks: MC_BANKS,
  }, async ({ engine }) => {
    const r1 = await engine.graph.conceptMergeCandidates('数学', 1)
    assert.equal(r1.filed.length, 1, 'max 封顶单次产出')
    const r2 = await engine.graph.conceptMergeCandidates('数学')
    assert.equal(r2.filed.length, 1, '其余候选留待下次扫描（已产出的不重复堆）')
  })
})

test('#274 信任边界：apply 只在面板人审后生效——登记表并入 + journal 留痕（两段式第二段照旧）', async () => {
  await withVault({
    tag: 'learnhub-mergeapply-',
    graph: MC_GRAPH,
    files: [{ path: '学习中心/math/概念登记表.yaml', content: `${MC_REGISTRY}\n` }],
    banks: MC_BANKS,
  }, async ({ engine, root }) => {
    const r = await engine.graph.conceptMergeCandidates('数学')
    const target = r.filed.find(f => f.into === '丙')!
    const applied = await engine.graph.conceptMergeApply(target.id)
    assert.equal(applied.kind, 'concept_merge')
    assert.equal(applied.from, '庚')
    assert.equal(applied.into, '丙')
    // 登记表并入：庚消失，名字并集挂在丙上（条目只并入、不删除）
    const yaml = readFileSync(join(root, '学习中心', 'math', '概念登记表.yaml'), 'utf8')
    const entries = YAML.parse(yaml) as { concepts: Array<{ canonical: string; aliases?: string[] }> }
    assert.deepEqual(entries.concepts.map(c => c.canonical).sort(), ['丙', '因式分解', '因式分解法'])
    const bing = entries.concepts.find(c => c.canonical === '丙')!
    assert.ok((bing.aliases ?? []).includes('庚'), '历史地址随名字并集保留')
    // 提案留痕：applied 状态
    const prop = (await engine.store.loadProposals()).find(x => x.id === target.id)!
    assert.equal(prop.status, 'applied')
  })
})
