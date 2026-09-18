/**
 * 概念足迹取材核（#268 + #340 多名字查询）：conceptFootprintCore 的纯派生回归——词条档诚实（缺失如实）、
 * 教学面/题目面取材（#270 反向映射 canonical 归并、invokes 排序）、漂移面三类
 * （孤儿/悬空/单向）恒全表派生不随 query 收窄、子串发现非存在性判定、多名字查询
 * （query: string | string[]）。零 IO。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { conceptFootprintCore } from '../src/engine/concepts/concepts.ts'
import type { ConceptEntry } from '../src/engine/concepts/concepts.ts'

function core(entries: ConceptEntry[], opts: {
  taughtByOf?: Record<string, string[]>
  assumedByOf?: Record<string, string[]>
  invokes?: Map<string, Map<string, number>>
  query?: string | string[]
} = {}) {
  return conceptFootprintCore({
    entries,
    taughtByOf: opts.taughtByOf ?? {},
    assumedByOf: opts.assumedByOf ?? {},
    invokes: opts.invokes ?? new Map(),
    query: opts.query,
  })
}

const ENTRIES: ConceptEntry[] = [
  { canonical: '导数', aliases: ['derivative'], definition: '变化率' },
  { canonical: '极限', confusable: ['导数', '不存在的概念'] },
  { canonical: '积分', aliases: ['integration'] },
]

test('#268 词条档诚实：缺失字段如实为空，不假装有', () => {
  const r = core(ENTRIES)
  const d = r.rows.find(x => x.canonical === '导数')!
  assert.deepEqual([d.aliases, d.definition, d.deprecated], [['derivative'], '变化率', false])
  const j = r.rows.find(x => x.canonical === '积分')!
  assert.deepEqual([j.aliases, j.definition], [['integration'], null], '无定义如实 null')
  assert.deepEqual(j.confusable, [], '无易混声明如实空')
})

test('#268 教学面：#270 反向映射经 canonical 归并（别名书写的足迹不裂行）；orphan 判定', () => {
  const r = core(ENTRIES, {
    taughtByOf: { 导数: ['甲'], derivative: ['乙'] },
    assumedByOf: { 极限: ['丙'] },
  })
  const d = r.rows.find(x => x.canonical === '导数')!
  assert.deepEqual(d.teachers, ['甲', '乙'], '别名 derivative 书写的 teaches 归并到 导数')
  const j = r.rows.find(x => x.canonical === '积分')!
  assert.equal(j.orphan, true, '教学面与题目面全空 = 孤儿')
  assert.equal(d.orphan, false)
})

test('#268 题目面：invokes 按题数降序、同数按节点名字典序', () => {
  const invokes = new Map([['导数', new Map([['乙节点', 2], ['甲节点', 2], ['丙节点', 5]])]])
  const r = core(ENTRIES, { invokes })
  const d = r.rows.find(x => x.canonical === '导数')!
  assert.deepEqual(d.invokes.map(i => i.node), ['丙节点', '甲节点', '乙节点'])
})

test('#268 漂移面三类：孤儿/悬空/单向；恒全表派生不随 query 收窄', () => {
  const r = core(ENTRIES, { assumedByOf: { 积分: ['丁'] } })
  assert.deepEqual(r.drift.orphans, ['导数', '极限'], '本夹具只给了积分足迹（assumes）：导数与极限 = 孤儿（登记表序）')
  assert.deepEqual(r.drift.dangling, [{ from: '极限', to: '不存在的概念' }])
  assert.deepEqual(r.drift.oneWay, [{ from: '极限', to: '导数' }],
    '极限声明指向导数而导数未回指 = 单向（记在声明方）')
  // 子串不改变漂移面：
  const filtered = core(ENTRIES, { assumedByOf: { 积分: ['丁'] }, query: '积' })
  assert.equal(filtered.matched, 1)
  assert.deepEqual(filtered.drift.orphans, r.drift.orphans, '漂移面恒全表，不随 query 收窄')
})

test('#268 单向判定的回指侧：对方回指后不再记单向', () => {
  const both: ConceptEntry[] = [
    { canonical: 'A', confusable: ['B'] },
    { canonical: 'B', confusable: ['A'] },
  ]
  const r = core(both)
  assert.deepEqual(r.drift.oneWay, [], '双向声明 = 无单向')
  const one = core([{ canonical: 'A', confusable: ['B'] }, { canonical: 'B' }])
  assert.deepEqual(one.drift.oneWay, [{ from: 'A', to: 'B' }])
})

test('#268 子串发现命中 canonical 或别名；空命中 matched=0 但 total/drift 不变', () => {
  assert.deepEqual(core(ENTRIES, { query: 'integr' }).rows.map(r => r.canonical), ['积分'],
    '别名 integration 含 integr → 命中积分')
  assert.deepEqual(core(ENTRIES, { query: 'deriv' }).rows.map(r => r.canonical), ['导数'],
    '别名 derivative 含 deriv → 命中导数（canonical 本身不含该子串）')
  const none = core(ENTRIES, { query: '不存在的关键词' })
  assert.equal(none.matched, 0)
  assert.equal(none.total, ENTRIES.length, 'total 仍报全表规模——空命中 ≠ 不存在')
})

// ---- #340 多名字查询 ----

test('#340 queries 字段：无 query 时返回空数组，有 query 时返回归一化后的词列表', () => {
  assert.deepEqual(core(ENTRIES).queries, [], '无 query → 空数组')
  assert.deepEqual(core(ENTRIES, { query: '导' }).queries, ['导'], '单词 string → 单元素数组')
  assert.deepEqual(core(ENTRIES, { query: '  ' }).queries, [], '空白 string → 空数组')
  assert.deepEqual(core(ENTRIES, { query: ['导', '积'] }).queries, ['导', '积'], '数组透传')
  assert.deepEqual(core(ENTRIES, { query: ['  ', '积', ''] }).queries, ['积'], '数组去空词')
})

test('#340 多名字查询：任一词命中即入选，结果去重', () => {
  const r = core(ENTRIES, { query: ['deriv', 'integr'] })
  assert.deepEqual(r.rows.map(x => x.canonical), ['导数', '积分'],
    'deriv → 导数（别名 derivative）、integr → 积分（别名 integration）')
  assert.equal(r.matched, 2)
})

test('#340 多名字查询：部分命中不报错，未命中词不影响已命中结果', () => {
  const r = core(ENTRIES, { query: ['导', '不存在的词'] })
  assert.deepEqual(r.rows.map(x => x.canonical), ['导数'])
  assert.equal(r.matched, 1)
  assert.equal(r.total, ENTRIES.length)
})

test('#340 多名字查询：漂移面恒全表，不受多词查询收窄', () => {
  const r = core(ENTRIES, { assumedByOf: { 积分: ['丁'] } })
  const filtered = core(ENTRIES, { assumedByOf: { 积分: ['丁'] }, query: ['导', '积'] })
  assert.deepEqual(filtered.drift.orphans, r.drift.orphans, '漂移面恒全表')
  assert.deepEqual(filtered.drift.dangling, r.drift.dangling)
  assert.deepEqual(filtered.drift.oneWay, r.drift.oneWay)
})
