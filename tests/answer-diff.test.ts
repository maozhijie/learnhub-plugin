/**
 * 判错差异摘要（ADR-0031 前置）：判错结果态点名「漏选/多选/第几项」，
 * 让学习者能把判罚对上自己的作答——q13 误诊（漏选 A 被当成坏题）的根源就是缺这一层。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { answerDiff } from '../src/engine/grading.ts'

const MC = { kind: 'multi_choice' as const, q: '题干', answer: ['A', 'B', 'D'] }

test('multi_choice：漏选与多选逐项点名', () => {
  assert.equal(answerDiff(MC, 'B,D'), '漏选了 A')
  assert.equal(answerDiff(MC, 'A,B,C,D'), '多选了 C')
  assert.equal(answerDiff(MC, 'B,C'), '漏选了 A、D，多选了 C')
  assert.equal(answerDiff(MC, 'a,b,d'), null, '归一后全对 → 无差异')
})

test('其余规则题型各给一句可对账的差异', () => {
  assert.equal(answerDiff({ kind: 'single_choice', q: '', answer: 'B' }, 'C'), '你选了 C')
  assert.equal(answerDiff({ kind: 'true_false', q: '', answer: true }, 'false'), '你的判断：错误')
  assert.equal(answerDiff({ kind: 'fill_in_blank', q: '', answer: ['x'] }, 'y'), '你的作答不在可接受答案之列')
  assert.equal(answerDiff({ kind: 'numeric', q: '', answer: '1', tol: 0.01 }, '2'), '你的作答 2 不在容差（±0.01）内')
  assert.equal(
    answerDiff({ kind: 'ordering', q: '', answer: ['a', 'b', 'c'] }, 'a\nc\nb'),
    '从第 2 项起顺序不对',
  )
  assert.equal(answerDiff({ kind: 'matching', q: '', answer: ['a', 'b'] }, 'b\na'), '2 处配对不对')
})

test('AI 题型与空作答不产差异摘要', () => {
  assert.equal(answerDiff({ kind: 'reflection', q: '', answer: '要点' }, '答'), null)
  assert.equal(answerDiff(MC, ''), null)
  assert.equal(answerDiff({ kind: 'numeric', q: '', answer: '1' }, ''), null)
})
