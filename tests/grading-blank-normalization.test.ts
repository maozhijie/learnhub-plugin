/**
 * 判卷归一（ADR-0029 落地面）：唯一答案填空的书写差异归一 + numeric 缺省相对容差。
 * evaluateAllo 判卷行为的回归基线（此前无任何覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAllo, normBlank } from '../src/engine/grading.ts'

test('normBlank：NFKC 折叠全角/半角 → 去全部空白 → 小写', () => {
  assert.equal(normBlank('ＤＮＡ 聚 合 酶'), normBlank('dna聚合酶'))
  assert.equal(normBlank('  Hello   World  '), 'helloworld')
})

test('填空判卷：空白、全半角、大小写书写差异不再误判（ADR-0029 归一口径）', () => {
  const q = { kind: 'fill_in_blank' as const, q: '等差数列相邻两项之差叫____。', answer: ['公差', '公差 d'] }
  assert.equal(evaluateAllo(q, '公 差').correct, true, '内部空格差异')
  assert.equal(evaluateAllo(q, '　公差　').correct, true, '全角空格')
  const en = { kind: 'fill_in_blank' as const, q: '____', answer: ['DNA 聚合酶'] }
  assert.equal(evaluateAllo(en, 'ＤＮＡ聚合酶').correct, true, '全角字母（NFKC 折叠）')
  assert.equal(evaluateAllo(en, 'dna 聚合酶').correct, true, '大小写')
  assert.equal(evaluateAllo(en, 'RNA 聚合酶').correct, false, '答错仍判错')
  const multi = { kind: 'fill_in_blank' as const, q: '卡壳处说明该处____。', answer: ['没懂', '没理解'] }
  assert.equal(evaluateAllo(multi, '没 理 解').correct, true, '候选数组逐一归一比较')
})

test('numeric 判卷：缺省极小相对容差只吸收浮点毛刺，不放过真误差', () => {
  const q = { kind: 'numeric' as const, q: '0.3', answer: '0.3' }
  assert.equal(evaluateAllo(q, '0.30000000000000004').correct, true, '浮点表示毛刺')
  assert.equal(evaluateAllo(q, '0.3001').correct, false, '真误差仍判错')
  assert.equal(evaluateAllo({ kind: 'numeric' as const, q: '', answer: '0' }, '0.00000000001').correct, false, '答案为 0 时容差收缩到 1e-12')
})

test('numeric 判卷：显式 tol、分数与百分数解析行为不变', () => {
  const tolQ = { kind: 'numeric' as const, q: '', answer: '1/3', tol: 0.01 }
  assert.equal(evaluateAllo(tolQ, '0.334').correct, true)
  assert.equal(evaluateAllo(tolQ, '0.35').correct, false, '0.35 与 1/3 差 0.0167 > tol 0.01')
  const pct = { kind: 'numeric' as const, q: '', answer: '0.5' }
  assert.equal(evaluateAllo(pct, '50%').correct, true)
  assert.equal(evaluateAllo(pct, '1/2').correct, true)
})
