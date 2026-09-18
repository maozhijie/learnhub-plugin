import test from 'node:test'
import assert from 'node:assert/strict'
import { teachesGateErrors } from '../src/engine/coach/proposals.ts'
import type { EditOp } from '../src/engine/coach/proposals.ts'
import type { EndpointAnchor } from '../src/engine/coach/seed.ts'

const anchor = (endpoint: string): EndpointAnchor => ({
  endpoint,
  goal_type: 'capability',
  declared: '2026-09-18',
  origin_proposal: 1,
  seed_nodes: [endpoint],
} as unknown as EndpointAnchor)

const add = (over: Partial<EditOp>): EditOp => ({ op: 'add_node', name: '节点甲', pre: [], ...over } as EditOp)

test('teaches 出生强制门：零 teaches 的教学节点拒收，错误行可执行', () => {
  const errors = teachesGateErrors([add({})], [])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /ops\.0\(add_node 节点甲\): 教学节点未 teaches 任何概念/)
})

test('teaches 出生强制门：teaches 在场 / practice / 终点 三类豁免', () => {
  assert.deepEqual(teachesGateErrors([add({ teaches: { 概念甲: '会用' } })], []), [])
  assert.deepEqual(teachesGateErrors([add({ type: 'practice' })], []), [])
  assert.deepEqual(teachesGateErrors([add({ name: '终点甲' })], [anchor('终点甲')]), [])
})

test('teaches 出生强制门：非 add_node 的操作不执法', () => {
  assert.deepEqual(teachesGateErrors([{ op: 'set_pre', node: '节点甲', pre: ['乙'] } as EditOp], []), [])
})
