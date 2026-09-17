/**
 * GraphDagView 连线回归门：边渲染不得依赖 ResizeObserver 首测。
 *
 * 真实环境病形：xyflow v12 的边渲染门（isNodeInitialized）要求 node.internals.handleBounds，
 * 而它只由 RO 回调写入（RO 回调绑渲染帧：后台标签页/被遮挡窗口/无头环境不产帧就永不到达）；
 * 且受控 nodes prop 每次同步时 parseHandles 见节点对象不带 measured 就把 handleBounds 重置回
 * undefined——工作台 5s 轮询每拍刷新 genStates 身份触发一次整阵同步，于是连线「出现后下一拍
 * 被集体抹掉」，prod 构建里这套丢弃静默无警告。声明式 handles 让 handleBounds 直接由
 * node.handles 派生（每次同步重建、永不重置），首帧即在、与测量环境无关。
 *
 * happy-dom 无布局引擎、RO 回调永不触发，恰是本病最严苛形态：修复前本门必红（0 条边）。
 */
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, cleanup, waitFor, importUi, uiImport } from './helpers/ui-dom.ts'

afterEach(() => cleanup())

// happy-dom 不带 ResizeObserver global（xyflow pane 观察器裸用它）：补永不触发回调的
// no-op 桩——恰造成本病最严苛形态（无测量回调）；若给即发实现会改掉修复前的红形。
if (!(globalThis as Record<string, unknown>).ResizeObserver) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

const React = (await uiImport('react')).default

/** 与 /graph 接口同形的最小夹具：3 节点 2 边（含一个终点节点）。 */
const DOC = {
  stats: { nodes: 3, edges: 2, enc_edges: 0, roots: 1, leaves: 0, max_depth: 2, components: 1, has_cycle: false },
  nodes: [
    { data: { id: '配对判定', depth: 0, stage: 'skipped', opt: false, mastery: 0, hasContent: false, isEndpoint: false } },
    { data: { id: '大小比较', depth: 1, stage: 'ready', opt: false, mastery: 0, hasContent: false, isEndpoint: false } },
    { data: { id: '结业水平', depth: 2, stage: 'ready', opt: false, mastery: 0, hasContent: false, isEndpoint: true } },
  ],
  edges: [
    { data: { id: '配对判定->大小比较', source: '配对判定', target: '大小比较', kind: 'pre' } },
    { data: { id: '大小比较->结业水平', source: '大小比较', target: '结业水平', kind: 'pre' } },
  ],
  endpoints: ['结业水平'],
  endpoint_steps: [],
}

test('GraphDagView：无测量回调环境里边全量渲染（边静默丢弃回归）', async () => {
  const { default: GraphDagView } = await importUi('components/GraphDagView.tsx')
  render(React.createElement(GraphDagView, {
    doc: DOC as never, recommended: [], lockedIds: new Set<string>(), bankSet: new Set<string>(),
    onSelect: () => {},
  }))
  await waitFor(() => assert.equal(
    document.querySelectorAll('.react-flow__edge').length, 2,
    '两条边都应渲染（不依赖 ResizeObserver 测量回调）',
  ))
})

test('GraphDagView：受控 nodes 整阵替换后边不消失（轮询拍重置回归）', async () => {
  const { default: GraphDagView } = await importUi('components/GraphDagView.tsx')
  const props = {
    doc: DOC as never, recommended: [] as string[], lockedIds: new Set<string>(), bankSet: new Set<string>(),
    onSelect: () => {}, genStates: {} as Record<string, 'queued' | 'running'>,
  }
  const { rerender } = render(React.createElement(GraphDagView, props))
  await waitFor(() => assert.equal(document.querySelectorAll('.react-flow__edge').length, 2))
  // 轮询拍的同形替换：genStates 新身份 → layoutDag 整阵重建 flowNodes/flowEdges（节点对象不带 measured）
  await rerender(React.createElement(GraphDagView, { ...props, genStates: {} }))
  await waitFor(() => assert.equal(
    document.querySelectorAll('.react-flow__edge').length, 2,
    '整阵替换后边仍在（handleBounds 不被同步重置）',
  ))
})
