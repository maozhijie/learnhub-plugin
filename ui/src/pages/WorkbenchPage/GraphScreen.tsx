/** 工作台首屏（#209 / ADR-0058）：罗盘（学习者的进度语义装置，含批注区与沙盘 ETA）
 * + 终点面板 + 学习图 DAG 纵览。终点由学习者手加/删（ADR-0076：立即写盘、纯声明不触发
 * 生成——方向声明完由教练台「生长一步」放行）；点节点直接进学习视图（LessonView）；从学习视图「在图中查看」
 * 跳入时 focusNode 红描边定位；图本身不承载学习操作。#158 三态化：加载中/失败/空
 * 显式区分；空图（零节点）是合法空态——引导先加一个终点。 */
import { Button, Card, Input, Message, Modal, Result, Select, Space, Switch, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GraphDagView from '../../components/GraphDagView'
import { recTypeMeta } from '../../lib/rec-events'
import CompassCard from './CompassCard'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import type { AppFrame } from '../../App'
import type { BankEntry, GenJobItem, GraphDoc, RecommendDoc } from '../../types'

const { Text } = Typography

/** 图例：状态色点 + 掌握度深浅说明。终点条目按 ADR-0056／ADR-0076 注明「方向标记」语义——
 * 终点不被学习调度、不产料，不是图上待学的课程节点（#200 / ADR-0055）。 */
function Legend() {
  const items: Array<[string, string]> = [
    ['未学', '#c9cdd4'],
    ['就绪/进行', '#165dff'],
    ['复习/掌握', '#00b42a'],
    ['已跳过', '#722ed1'],
    ['推荐下一步', '#ff7d00'],
    ['⚑ 终点（方向标记）', '#f5319d'],
  ]
  return (
    <Space size={12} wrap align='center' className='lh-t-12'>
      {items.map(([label, color]) => (
        <Space key={label} size={4}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
          <Text type='secondary'>{label}</Text>
        </Space>
      ))}
      <Text type='secondary'>同色底越深 = 掌握度越高（悬停看数值）</Text>
      <Text type='secondary'>终点是方向标记：不被学习调度、不产料（ADR-0056）</Text>
    </Space>
  )
}

/** 终点面板（ADR-0076）：逐终点一行——名称、三档状态、闭包进度、服务于哪些终点
 * （交汇）；最后台阶里的交汇节点点名。添加（名称 + 可选一句方向说明）与删除入口；
 * 添加是纯声明：只落锚与节点、不触发生成，方向声明完再到教练台点「生长一步」放行。 */
function EndpointPanel({ frame, course, doc, onChanged }: {
  frame: AppFrame
  course: string
  doc: GraphDoc
  onChanged: () => void
}) {
  const completions = frame.status?.courses.find(c => c.name === course)?.completions ?? []
  const statusOf = new Map(completions.map(c => [c.endpoint, c]))
  const servesOf = new Map(doc.nodes.map(n => [n.data.id, n.data.serves ?? []]))
  const stepsOf = new Map((doc.endpoint_steps ?? []).map(e => [e.endpoint, e.last_steps]))
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [goalNote, setGoalNote] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    if (!name.trim()) { Message.warning('终点名必填'); return }
    setBusy(true)
    try {
      const r = await api.endpointAdd(course, name.trim(), goalNote.trim() || undefined)
      Message.success(`终点「${r.endpoint}」已落盘；方向先声明着，到教练台点「生长一步」放行教练接线`)
      setAdding(false)
      setName('')
      setGoalNote('')
      onChanged()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = (endpoint: string) => {
    Modal.confirm({
      title: `删除终点「${endpoint}」？`,
      content: '锚记录与节点一并移除；已铺出来的台阶会留在图上成为末端（正文、题库、调度全保留）。',
      okText: '删除终点',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.endpointRemove(course, endpoint)
          Message.success(`终点「${endpoint}」已删除`)
          onChanged()
        } catch (err) {
          Message.error(errorMessage(err))
        }
      },
    })
  }

  const statusTag = (endpoint: string): { label: string; color: string } => {
    const c = statusOf.get(endpoint)
    if (!c) return { label: '悬空锚', color: 'red' }
    if (c.status === 'reached') return { label: '已达成', color: 'green' }
    if (c.status === 'sealed') return { label: '已铺通', color: 'blue' }
    return { label: '未接线', color: 'gray' }
  }

  return (
    <Card size='small' title='终点（方向）' className='lh-card'
      extra={
        <Button size='mini' type='primary' onClick={() => setAdding(a => !a)}>{adding ? '收起' : '添加终点'}</Button>
      }>
      <Space direction='vertical' size={8} className='lh-full'>
        {adding && (
          <Space size={8} wrap>
            <Input size='small' placeholder='终点名（如：能即兴伴奏）' className='lh-w-220' value={name} onChange={setName} />
            <Input size='small' placeholder='方向说明（可选，给教练读）' className='lh-w-260' value={goalNote} onChange={setGoalNote} />
            <Button size='small' type='primary' loading={busy} onClick={() => void add()}>落盘并接线</Button>
          </Space>
        )}
        {doc.endpoints.length === 0 && (
          <Text type='secondary' className='lh-t-12'>
            还没有终点：加一个（立即写盘，不等生成队列），教练回合会把它接上相关的既有节点。
          </Text>
        )}
        {doc.endpoints.map(ep => {
          const st = statusTag(ep)
          const c = statusOf.get(ep)
          const steps = stepsOf.get(ep) ?? []
          const junctions = steps.filter(n => (servesOf.get(n)?.length ?? 0) >= 2)
          const others = (servesOf.get(ep) ?? []).filter(x => x !== ep)
          return (
            <div key={ep} className='lh-row lh-gap-10 lh-wrap lh-items-start'>
              <Space size={6} wrap>
                <Tag size='small' color='magenta'>⚑ {ep}</Tag>
                <Tag size='small' color={st.color}>{st.label}</Tag>
                {c && <Text type='secondary' className='lh-t-12'>已学 {c.closure.learned}/{c.closure.total}</Text>}
              </Space>
              <Text type='secondary' className='lh-t-12 lh-flex-1'>
                {steps.length ? `最后台阶：${steps.join('、')}` : 'pre 空——未接线'}
                {junctions.length > 0 && `｜交汇：${junctions.join('、')}（同时服务其他终点）`}
                {others.length > 0 && `｜该终点被服务：${others.join('、')}`}
              </Text>
              <Button size='mini' status='danger' onClick={() => remove(ep)}>删除</Button>
            </div>
          )
        })}
      </Space>
    </Card>
  )
}

export default function GraphScreen({ frame, course, jobs }: { frame: AppFrame; course: string; jobs: GenJobItem[] }) {
  const reloadFrame = frame.reload
  const [doc, setDoc] = useState<GraphDoc | null>(null)
  const [banks, setBanks] = useState<BankEntry[] | null>(null)
  const [rec, setRec] = useState<RecommendDoc | null>(null)
  const [loading, setLoading] = useState(false)
  /** #158 三态化：图加载失败显式记录（与「空图合法空态」分开——失败要给重试）。 */
  const [graphError, setGraphError] = useState<string | null>(null)
  /** 排队/生成中的节点（节点名 → 阶段；角标与 hover 工具条消费）。 */
  const [genStates, setGenStates] = useState<Record<string, 'queued' | 'running'>>({})
  // 总览过滤
  const [region, setRegion] = useState<string>('')
  const [search, setSearch] = useState('')
  const [readyOnly, setReadyOnly] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 图是本屏主数据：失败要冒泡进失败态；题库/推荐是次要数据，缺了按空处理
      const g = await api.graph(course)
      const [b, r] = await Promise.all([
        api.questionsAll(course).catch(() => ({ total: 0, questions: [] as BankEntry[] })),
        api.recommend(30).catch(() => ({ events: [] as RecommendDoc['events'] })),
      ])
      setDoc(g)
      setBanks(b.questions)
      setRec(r as RecommendDoc)
      setGraphError(null)
    } catch (err) {
      setGraphError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [course])

  useEffect(() => { void load() }, [load])

  // 生成角标与终态边沿（#161 语义原样）：任务数据由工作台唯一轮询拍下发（jobs prop），
  // 本屏只做投影——本课节点的排队/生成态点亮角标；活动任务出现终态边沿 → 重拉图与
  // 状态面（就绪深度/完成宣告等读侧折叠跟随生成结果更新）。
  const activeKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const gen: Record<string, 'queued' | 'running'> = {}
    const active = new Set<string>()
    for (const j of jobs) {
      if (j.course !== course) continue
      if (j.status === 'running' || j.status === 'cancelling') { gen[j.node] = 'running'; active.add(j.key) }
      else if (j.status === 'queued') gen[j.node] = 'queued'
    }
    const edge = [...activeKeysRef.current].some(k => !active.has(k))
    activeKeysRef.current = active
    setGenStates(gen)
    if (edge) { void load(); void reloadFrame() }
  }, [jobs, course, load, reloadFrame])

  // 过滤：裁出子图（端点不在集合内的边一并裁掉）
  const filtered = useMemo(() => {
    if (!doc) return null
    const keep = (id: string) => {
      if (region && !(doc.nodes.find(n => n.data.id === id)?.data.region === region)) return false
      if (readyOnly) {
        const n = doc.nodes.find(x => x.data.id === id)
        if (!n || (n.data.stage !== 'ready' && n.data.stage !== 'learning')) return false
      }
      if (search && !id.includes(search.trim())) return false
      return true
    }
    const nodes = doc.nodes.filter(n => keep(n.data.id))
    const ids = new Set(nodes.map(n => n.data.id))
    const edges = doc.edges.filter(e => ids.has(e.data.source) && ids.has(e.data.target))
    return { ...doc, nodes, edges }
  }, [doc, region, search, readyOnly])

  const computeLocked = useCallback((g: GraphDoc) => {
    const stageOf = new Map(g.nodes.map(n => [n.data.id, n.data.stage] as const))
    const ups = new Map<string, string[]>()
    for (const e of g.edges) {
      const arr = ups.get(e.data.target) ?? []
      arr.push(e.data.source)
      ups.set(e.data.target, arr)
    }
    const locked = new Set<string>()
    for (const n of g.nodes) {
      if (n.data.stage === 'skipped') continue // 已跳过 = 视同已通过，不锁
      const upsOf = ups.get(n.data.id) ?? []
      if (upsOf.some(id => {
        const s = stageOf.get(id) ?? 'unseen'
        return s !== 'review' && s !== 'mastered' && s !== 'skipped'
      })) locked.add(n.data.id)
    }
    return locked
  }, [])

  const lockedIds = useMemo(() => (doc ? computeLocked(doc) : new Set<string>()), [doc, computeLocked])
  const recommended = useMemo(
    () => (rec?.events ?? []).filter(e => e.course === course).map(e => e.node),
    [rec, course],
  )
  const bankSet = useMemo(() => new Set(banks?.map(b => b.node) ?? []), [banks])
  const regions = useMemo(
    () => [...new Set(doc?.nodes.map(n => n.data.region) ?? [])].sort(),
    [doc],
  )

  const onSelect = (nodeId: string) => frame.openLesson(course, nodeId)

  // 图上便捷生成：未生成直接入队；已生成（重新生成）先确认——覆盖现有正文与题库不清，仅重写正文管线
  const onGenerate = (nodeId: string) => {
    const has = doc?.nodes.find(n => n.data.id === nodeId)?.data.hasContent
    const run = () => {
      void api.generate(course, nodeId)
        .then(r => { Message.success(r.message); void load() })
        .catch(err => Message.error(errorMessage(err)))
    }
    if (has) {
      Modal.confirm({
        title: `重新生成「${nodeId}」？`,
        content: '将重跑该节点的生成管线（大纲沿用断点续跑），现有正文会被逐节重写；题库保留。',
        okText: '重新生成',
        cancelText: '取消',
        onOk: run,
      })
    } else {
      run()
    }
  }

  if (loading && !doc) {
    return <Card><Text type='secondary'>加载学习图…</Text></Card>
  }
  // #158 首载失败：显式失败态 + 重试——失败不再伪装成「还没有学习图」
  if (graphError && !doc) {
    return (
      <Result
        status='error'
        title='学习图加载失败'
        subTitle={graphError}
        extra={<Button type='primary' onClick={() => void load()}>重试</Button>}
      />
    )
  }
  if (!doc || !filtered) {
    // 图缺失（理论上不会到这——零节点图也是合法 doc）：给刷新与教练台出口
    return (
      <Space direction='vertical' className='lh-full' size={12}>
        <Card>
          <Space direction='vertical' size={10}>
            <Text type='secondary'>课程「{course}」的学习图还没加载出来。</Text>
            <Space size={8}>
              <Button type='primary' onClick={() => void load()}>刷新</Button>
              <Button onClick={() => frame.openCourse(course, 'coach')}>去教练台</Button>
            </Space>
          </Space>
        </Card>
      </Space>
    )
  }
  if (doc.nodes.length === 0) {
    // 零节点空课（ADR-0076 合法空态）：终点面板先行——加终点给方向，教练才能生长
    return (
      <Space direction='vertical' className='lh-full' size={12}>
        <Card>
          <Space direction='vertical' size={10}>
            <Text>课程「{course}」是一门空课（零节点图）。</Text>
            <Text type='secondary' className='lh-t-12'>
              先添加终点给课程方向：终点立即写盘、不触发生成——想加几个加几个，
              方向都声明完了，再到教练台点「生长一步」放行教练接线。
            </Text>
          </Space>
        </Card>
        <EndpointPanel frame={frame} course={course} doc={doc} onChanged={() => { void load(); void reloadFrame() }} />
        <CompassCard course={course} />
        <Legend />
      </Space>
    )
  }

  const s = { nodes: doc.nodes.length, edges: doc.edges.length }
  return (
    <Space direction='vertical' className='lh-full' size={12}>
      <div className='lh-row lh-gap-10 lh-wrap'>
        <Space size={4} wrap>
          <Tag size='small'>{s.nodes} 节点</Tag>
          <Tag size='small'>{s.edges} 依赖</Tag>
          <Tag size='small'>{bankSet.size} 有题库</Tag>
          {/* 图深度（原「主线深度」正名，ADR-0076：多终点下没有单一主线可指；口径不变） */}
          <Tag size='small' color='magenta'>图深度 {doc.stats.max_depth}</Tag>
          <Tag size='small' color='gray'>全局总览 · 点节点进入学习</Tag>
        </Space>
        <div className='lh-ml-auto lh-gap-8 lh-row lh-wrap'>
          <Select
            size='small' placeholder='全区' className='lh-w-160' allowClear
            value={region || undefined} onChange={v => setRegion(v ?? '')}
            options={regions.map(r => ({ label: r, value: r }))} />
          <Input.Search size='small' placeholder='搜索节点名' className='lh-w-180'
            value={search} onChange={setSearch} allowClear />
          <Space size={6}>
            <Text className='lh-t-12' type='secondary'>只看进行中</Text>
            <Switch size='small' checked={readyOnly} onChange={setReadyOnly} />
          </Space>
          <Button size='small' loading={loading} onClick={() => void load()}>刷新</Button>
        </div>
      </div>

      {/* 罗盘（首屏上半）：路线草图 + 学习者批注 + 沙盘 ETA，语义零改动（#209） */}
      <CompassCard course={course} />

      {/* 终点面板（ADR-0076）：手加/删终点 + 逐终点状态与交汇读数 */}
      <EndpointPanel frame={frame} course={course} doc={doc} onChanged={() => { void load(); void reloadFrame() }} />

      {/* 推荐条（琥珀=下一步推荐；点击卡片直接进学习视图） */}
      {(rec?.events ?? []).filter(e => e.course === course).length > 0 && (
        <Space size={6} wrap>
          {(rec?.events ?? []).filter(e => e.course === course).slice(0, 8).map((e, i) => (
            <Tag key={i} color={recTypeMeta(e.type).color}
              className='lh-click'
              onClick={() => frame.openLesson(e.course, e.node)}>
              {e.node}（{recTypeMeta(e.type).label}）
            </Tag>
          ))}
        </Space>
      )}

      <div className='dag-wrap dag-wrap-compass'>
        <GraphDagView
          key={course} doc={filtered} recommended={recommended} lockedIds={lockedIds}
          bankSet={bankSet} genStates={genStates} focusNode={frame.focusNode}
          onSelect={onSelect} onGenerate={onGenerate} />
      </div>

      <Legend />
    </Space>
  )
}
