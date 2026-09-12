/** 推荐流事件词汇单测（L1，#183）：REC_TYPE 展示序、pin 置顶排序与复习/学习分面。
 * 被测模块：`ui/src/lib/rec-events.ts`（自 LearnPage 抽出的纯逻辑）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { REC_TYPE, recTypeMeta, sortRecEvents } from '../ui/src/lib/rec-events.ts'

test('recTypeMeta：已知类型取表，未知类型灰显且排最后', () => {
  assert.equal(REC_TYPE.pin!.order, 0)
  assert.deepEqual(recTypeMeta('pin'), { label: '今天学它', color: 'gold', order: 0 })
  assert.deepEqual(recTypeMeta('mystery'), { label: 'mystery', color: 'gray', order: 9 })
})

test('sortRecEvents：pin 置顶 → 类型 order → 稳定保持原序', () => {
  const sorted = sortRecEvents([
    { type: 'new', id: 'a' },
    { type: 'review', id: 'b' },
    { type: 'learning', id: 'c', pinned: true },
    { type: 'overdue', id: 'd' },
    { type: 'mystery', id: 'e' },
    { type: 'review', id: 'f' },
  ])
  assert.deepEqual(sorted.map(e => e.id), ['c', 'd', 'b', 'f', 'a', 'e'])
})

test('sortRecEvents 不改入参（返回新数组）', () => {
  const input = [{ type: 'new', id: 'a' }, { type: 'pin', id: 'b', pinned: true }]
  sortRecEvents(input)
  assert.deepEqual(input.map(e => e.id), ['a', 'b'])
})
