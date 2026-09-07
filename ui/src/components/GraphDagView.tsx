/**
 * 学习图 DAG 视图（移植自 allo GraphDagView：React Flow + dagre BT 分层布局）。
 * 五态色板、推荐星标、锁定虚线、MiniMap、大图视口裁剪全部保留；
 * 数据源换成 learnhub 引擎的 graphAnalyze elements（已是 React Flow 格式）。
 */
import { Graph, layout as dagreLayout } from '@dagrejs/dagre'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import type { GraphDoc, Stage } from '../types'

const NODE_WIDTH = 148
const NODE_HEIGHT = 54

/** 学习进度五态色板（Arco 语义 token + 字面 fallback：SVG stroke 的 var()
 * 失效会 fallback 到 none，连线直接消失）。 */
const STAGE_COLOR: Record<Stage, string> = {
  unseen: 'var(--color-text-4, #c9cdd4)',
  ready: 'var(--color-primary-6, #165dff)',
  learning: 'var(--color-primary-6, #165dff)',
  review: 'var(--color-success-6, #00b42a)',
  mastered: 'var(--color-success-6, #00b42a)',
  skipped: 'var(--color-purple-6, #722ed1)',
}
const STAGE_LABEL: Record<Stage, string> = {
  unseen: '未学', ready: '就绪', learning: '进行中', review: '复习', mastered: '已掌握', skipped: '已跳过',
}

/** 状态主色的 RGB（底色深浅插值用；字面值避免 var() 在叠加层的解析差异）。 */
const STAGE_RGB: Partial<Record<Stage, [number, number, number]>> = {
  ready: [22, 93, 255],       // primary-6 #165dff
  learning: [22, 93, 255],
  review: [0, 180, 42],       // success-6 #00b42a
  mastered: [0, 180, 42],
  skipped: [114, 46, 209],    // purple-6 #722ed1
}

/** 掌握度 → 同色系底色：alpha 0.10（刚起步）→ 0.42（充分掌握）。 */
function masteryTint(stage: Stage, mastery: number): string | null {
  const rgb = STAGE_RGB[stage]
  if (!rgb) return null
  const a = 0.10 + Math.max(0, Math.min(1, mastery)) * 0.32
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`
}

interface DagNodeData extends Record<string, unknown> {
  title: string
  depth: number
  stage: Stage
  region: string
  recommended: boolean
  locked: boolean
  hasBank: boolean
  focused: boolean
  mastery: number
  practice: boolean
}
type DagNode = Node<DagNodeData, 'dagNode'>

/** 节点卡片：左侧状态色条 + 标题 + 层级/区/题库元信息；推荐琥珀描边、定位红描边、
 * 锁定半透明虚线；底色 = 状态浅色 × 掌握度深浅（作答 EMA 实时反映）；跳过 = 紫底 + 「跳」角标。 */
const DagNodeInner: React.FC<NodeProps<DagNode>> = ({ data }) => {
  const accent = data.focused
    ? 'var(--color-danger-6, #f53f3f)'
    : data.recommended
      ? 'var(--color-warning-6, #ff7d00)'
      : data.locked
        ? 'var(--color-text-4, #c9cdd4)'
        : STAGE_COLOR[data.stage]
  const border = data.focused
    ? '2px solid var(--color-danger-6, #f53f3f)'
    : data.recommended
      ? '1px solid var(--color-warning-6, #ff7d00)'
      : data.locked
        ? '1px dashed var(--color-border-2, #e5e6eb)'
        : '1px solid var(--color-border-2, #e5e6eb)'
  const tint = masteryTint(data.stage, data.mastery)
  const bg = tint ?? 'var(--color-bg-2, #fff)'
  const tooltip = `${data.title}${data.locked ? '（前置未完成）' : ''}`
    + (data.stage === 'review' || data.stage === 'mastered' || data.stage === 'learning'
      ? `（掌握度 ${Math.round(data.mastery * 100)}%）` : '')
  return (
    <div title={tooltip}
      style={{
        display: 'flex', height: '100%', alignItems: 'stretch', overflow: 'hidden',
        position: 'relative', borderRadius: 6, border, background: bg, opacity: data.locked ? 0.55 : 1,
      }}>
      {data.stage === 'skipped' && (
        <span style={{
          position: 'absolute', top: 0, right: 0, fontSize: 9, lineHeight: '13px',
          padding: '0 4px', borderBottomLeftRadius: 6,
          background: 'var(--color-purple-6, #722ed1)', color: '#fff',
        }}>跳</span>
      )}
      {data.practice && (
        <span style={{
          position: 'absolute', top: 0, left: 0, fontSize: 9, lineHeight: '13px',
          padding: '0 4px', borderBottomRightRadius: 6,
          background: 'var(--color-teal-6, #14c9c9)', color: '#fff',
        }}>练</span>
      )}
      <span style={{ width: 3, flexShrink: 0, backgroundColor: accent }} />
      <div style={{
        display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column',
        justifyContent: 'center', gap: 1, padding: '3px 6px', textAlign: 'left',
      }}>
        <span style={{
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', fontSize: 12, lineHeight: '15px', fontWeight: 500,
          color: 'var(--color-text-1, #1d2129)',
        }}>{data.title}</span>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 4, fontSize: 10,
          lineHeight: '12px', color: 'var(--color-text-3, #86909c)', flexShrink: 0,
        }}>
          <span style={{ fontWeight: 500, color: 'var(--color-text-2, #4e5969)' }}>L{data.depth + 1}</span>
          {data.recommended && <span style={{ color: 'var(--color-warning-6, #ff7d00)' }}>★</span>}
          <span>{STAGE_LABEL[data.stage]}</span>
          {data.hasBank && <span>·题</span>}
          {(data.stage === 'review' || data.stage === 'mastered' || data.stage === 'learning') && (
            <span>·{Math.round(data.mastery * 100)}%</span>
          )}
        </span>
      </div>
      <Handle type='target' id='dag-target' position={Position.Bottom} isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type='source' id='dag-source' position={Position.Top} isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  )
}

const NODE_TYPES = { dagNode: DagNodeInner }

/** dagre BT 分层：前置沉底、目标升至顶层。节点必须显式携带 width/height，
 * 否则 0×0 不可见、边端点错位、MiniMap 无矩形。 */
function layoutDag(doc: GraphDoc, lockedIds: Set<string>, recommendedSet: Set<string>, bankSet: Set<string>, focusNode: string | null) {
  const g = new Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'BT', nodesep: 16, ranksep: 40, marginx: 24, marginy: 24 })
  for (const n of doc.nodes) g.setNode(n.data.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const e of doc.edges) g.setEdge(e.data.source, e.data.target)
  dagreLayout(g)

  const flowNodes = doc.nodes.map<DagNode>(n => {
    const pos = g.node(n.data.id)
    return {
      id: n.data.id,
      type: 'dagNode',
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 },
      data: {
        title: n.data.id, depth: n.data.depth, stage: n.data.stage, region: n.data.region,
        recommended: recommendedSet.has(n.data.id), locked: lockedIds.has(n.data.id),
        hasBank: bankSet.has(n.data.id), focused: n.data.id === focusNode,
        mastery: n.data.mastery ?? 0,
        practice: (n.data as { type?: string }).type === 'practice',
      },
    }
  })
  // 汇入推荐节点的边琥珀描边做视线引导，其余极淡灰。
  // non-scaling-stroke：大图 fitView 后 zoom 极低，1px 线会被压成亚像素消失。
  const flowEdges = doc.edges.map<Edge>(e => {
    const highlighted = recommendedSet.has(e.data.target)
    const stroke = highlighted ? 'var(--color-warning-6, #ff7d00)' : 'var(--color-border-2, #e5e6eb)'
    return {
      id: e.data.id,
      source: e.data.source,
      target: e.data.target,
      sourceHandle: 'dag-source',
      targetHandle: 'dag-target',
      style: { stroke, strokeWidth: highlighted ? 1.5 : 1, vectorEffect: 'non-scaling-stroke' },
      markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: stroke },
    }
  })
  return { flowNodes, flowEdges }
}

interface GraphDagViewProps {
  doc: GraphDoc
  /** 推荐节点（琥珀星标 + 入边高亮）。 */
  recommended: string[]
  /** 锁定节点：存在前置未达 review/mastered（半透明虚线）。 */
  lockedIds: Set<string>
  /** 有题库的节点（元信息行显示「题」）。 */
  bankSet: Set<string>
  /** 定位目标：红描边高亮并把画布居中到该节点（「在图中查看」跳转）。 */
  focusNode?: string | null
  onSelect: (nodeId: string) => void
}

/** ≤300 节点全量渲染（视口裁剪会把「一端在视口外」的整条边裁掉，平移时结构断裂）；
 * >300 开启裁剪保 500 节点级流畅。key 绑节点数：图结构变化时重挂载重新 fitView。 */
const VIEWPORT_CULL_THRESHOLD = 300

const GraphDagViewInner: React.FC<GraphDagViewProps> = ({ doc, recommended, lockedIds, bankSet, focusNode, onSelect }) => {
  const recommendedSet = useMemo(() => new Set(recommended), [recommended])
  const { flowNodes, flowEdges } = useMemo(
    () => layoutDag(doc, lockedIds, recommendedSet, bankSet, focusNode ?? null),
    [doc, lockedIds, recommendedSet, bankSet, focusNode],
  )
  // 定位：React Flow init 完成（含 fitView）之前调用 setCenter 会被初始视口覆盖，
  // 因此挂载路径走 onInit，已就绪路径走 effect，都指到 focusNode 中心。
  const instanceRef = useRef<ReactFlowInstance<DagNode, Edge> | null>(null)
  const focus = useCallback((inst: ReactFlowInstance<DagNode, Edge>) => {
    if (!focusNode) return
    const hit = inst.getNodes().find(n => n.id === focusNode)
    if (hit) inst.setCenter(hit.position.x + NODE_WIDTH / 2, hit.position.y + NODE_HEIGHT / 2, { zoom: 0.9, duration: 400 })
  }, [focusNode])
  const handleInit = useCallback((inst: ReactFlowInstance<DagNode, Edge>) => {
    instanceRef.current = inst
    focus(inst)
  }, [focus])
  useEffect(() => {
    if (instanceRef.current) focus(instanceRef.current)
  }, [focus])
  return (
    <div className='dag-wrap'>
      <ReactFlow
        key={flowNodes.length}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onlyRenderVisibleElements={flowNodes.length > VIEWPORT_CULL_THRESHOLD}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => onSelect(node.id)}
        onInit={handleInit}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color='var(--color-fill-2, #f2f3f5)' />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2}
          maskColor='var(--color-mask-bg, rgba(29,33,41,0.4))'
          style={{ borderRadius: 6 }}
          nodeColor={node => {
            const d = (node as DagNode).data
            if (d.locked) return 'var(--color-text-4, #c9cdd4)'
            return d.recommended ? 'var(--color-warning-6, #ff7d00)' : STAGE_COLOR[d.stage]
          }} />
      </ReactFlow>
    </div>
  )
}

/** useReactFlow 要求 Provider 祖先：外层包 Provider，内层用 hook 做定位/fitView。 */
const GraphDagView: React.FC<GraphDagViewProps> = props => (
  <ReactFlowProvider>
    <GraphDagViewInner {...props} />
  </ReactFlowProvider>
)

export default GraphDagView
