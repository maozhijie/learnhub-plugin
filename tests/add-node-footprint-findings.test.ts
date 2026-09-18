/**
 * add_node 前查足迹（#340 三）：addNodeFootprintFindings 的纯派生回归——
 * 两类非阻 findings：① 疑似重复教学（teaches 概念已有其他节点教 + 名面 trigram 信号）；
 * ② 疑似漏连 pre（assumes 概念在闭包外有 teaches 节点）。
 * 零 IO、零阻塞；findings 是建议不是自动连边。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { addNodeFootprintFindings } from '../src/engine/coach/proposals.ts'
import type { EditOp } from '../src/engine/coach/proposals.ts'
import type { ConceptEntry } from '../src/engine/concepts/concepts.ts'
import { Graph } from '../src/engine/graph/graph.ts'
import type { GNode } from '../src/types.ts'

const ENTRIES: ConceptEntry[] = [
  { canonical: '导数', aliases: ['derivative'], definition: '变化率' },
  { canonical: '极限', definition: '趋近于某值' },
  { canonical: '积分', aliases: ['integration'] },
  { canonical: '一元二次方程的解', definition: '求根公式' },
  { canonical: '一元二次方程的根', definition: '韦达定理' },
]

// 基础图：两个节点，甲 teaches 导数，乙 teaches 极限
const BASE_NODES: GNode[] = [
  { name: '甲', pre: [], opt: false, note: '', enc: [], teaches: { '导数': '掌握' }, assumes: {} },
  { name: '乙', pre: ['甲'], opt: false, note: '', enc: [], teaches: { '极限': '掌握' }, assumes: { '导数': '掌握' } },
]

test('#340 疑似重复教学：teaches 概念已有其他节点教 → 报 finding', () => {
  const graph = new Graph(BASE_NODES)
  const ops: EditOp[] = [{
    op: 'add_node', name: '丙', pre: ['乙'],
    teaches: { '导数': '掌握' },
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.ok(findings.some(f => f.includes('疑似重复教学') && f.includes('丙') && f.includes('导数') && f.includes('甲')),
    `应报「丙 teaches 导数，甲也教」，实际：${JSON.stringify(findings)}`)
})

test('#340 无重复教学：teaches 新概念 → 不报', () => {
  const graph = new Graph(BASE_NODES)
  const ops: EditOp[] = [{
    op: 'add_node', name: '丙', pre: ['乙'],
    teaches: { '积分': '掌握' },
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.ok(!findings.some(f => f.includes('疑似重复教学')),
    `不应报重复教学，实际：${JSON.stringify(findings)}`)
})

test('#340 疑似漏连 pre：assumes 概念在闭包外有 teaches 节点 → 报 finding', () => {
  const graph = new Graph(BASE_NODES)
  const ops: EditOp[] = [{
    op: 'add_node', name: '丙', pre: ['甲'],
    teaches: { '积分': '掌握' },
    assumes: { '极限': '掌握' },
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.ok(findings.some(f => f.includes('疑似漏连 pre') && f.includes('丙') && f.includes('极限') && f.includes('乙')),
    `应报「丙 assumes 极限，乙在闭包外教」，实际：${JSON.stringify(findings)}`)
})

test('#340 无漏连 pre：assumes 概念在闭包内有 teaches 节点 → 不报', () => {
  const graph = new Graph(BASE_NODES)
  const ops: EditOp[] = [{
    op: 'add_node', name: '丙', pre: ['乙'],
    teaches: { '积分': '掌握' },
    assumes: { '导数': '掌握' },
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.ok(!findings.some(f => f.includes('疑似漏连 pre')),
    `不应报漏连 pre，实际：${JSON.stringify(findings)}`)
})

test('#340 名面信号：teaches 概念与在册概念 trigram 相似且后者有人教 → 报 finding', () => {
  // 「一元二次方程的解」与「一元二次方程的根」trigram Jaccard ≈ 0.714 ≥ 0.6
  const nodes: GNode[] = [
    ...BASE_NODES,
    { name: '丁', pre: ['乙'], opt: false, note: '', enc: [], teaches: { '一元二次方程的根': '掌握' } },
  ]
  const graph = new Graph(nodes)
  const ops: EditOp[] = [{
    op: 'add_node', name: '戊', pre: ['丁'],
    teaches: { '一元二次方程的解': '掌握' },
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.ok(findings.some(f => f.includes('名面信号') && f.includes('一元二次方程的解') && f.includes('一元二次方程的根')),
    `应报名面信号，实际：${JSON.stringify(findings)}`)
})

test('#340 非 add_node op 不产出 findings', () => {
  const graph = new Graph(BASE_NODES)
  const ops: EditOp[] = [{
    op: 'set_pre', node: '乙', pre: ['甲'],
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.deepEqual(findings, [])
})

test('#340 别名解析：teaches 用别名书写 → 归一到 canonical 后查足迹', () => {
  const graph = new Graph(BASE_NODES)
  const ops: EditOp[] = [{
    op: 'add_node', name: '丙', pre: ['乙'],
    teaches: { 'derivative': '掌握' },
  }]
  const findings = addNodeFootprintFindings(ops, graph, ENTRIES)
  assert.ok(findings.some(f => f.includes('疑似重复教学') && f.includes('导数')),
    `应通过别名归一到 canonical「导数」报重复教学，实际：${JSON.stringify(findings)}`)
})
