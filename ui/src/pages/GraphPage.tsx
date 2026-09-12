/** 图页 = 学习图驾驶舱（低频）：教练台（建课/生长一步/罗盘/回填/复诊）+ DAG 纵览
 * （区过滤/搜索/只看就绪 + 推荐星标）。点节点直接进学习视图（LessonView）；从学习
 * 视图「在图中查看」跳入时 focusNode 红描边定位。图本身不承载学习操作。 */
import { Button, Card, Input, Message, Modal, Select, Space, Switch, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CoachCockpit from '../components/CoachCockpit'
import GraphDagView from '../components/GraphDagView'
import { api } from '../api'
import { isActiveTab, onTabActive } from '../active-tab'
import type { AppFrame } from '../App'
import type { BankEntry, GenJobItem, GraphDoc, RecommendDoc } from '../types'

const { Text } = Typography

/** 图域任务 phase 全集（与 useCoachToasts 同口径）：驾驶舱在途条与完成通知的消费面。 */
const GRAPH_PHASES = new Set(['种子', '生长', '罗盘', '反编译', '计划', '里程碑'])

const REC_TYPE_COLOR: Record<string, string> = { review: 'green', overdue: 'red', ready: 'blue', new: 'cyan' }
const REC_TYPE_LABEL: Record<string, string> = { review: '复习', overdue: '逾期', ready: '就绪', new: '新学' }

/** 图例：状态色点 + 掌握度深浅说明。 */
function Legend() {
  const items: Array<[string, string]> = [
    ['未学', '#c9cdd4'],
    ['就绪/进行', '#165dff'],
    ['复习/掌握', '#00b42a'],
    ['已跳过', '#722ed1'],
    ['推荐下一步', '#ff7d00'],
  ]
  return (
    <Space size={12} wrap align='center' style={{ fontSize: 12 }}>
      {items.map(([label, color]) => (
        <Space key={label} size={4}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
          <Text type='secondary'>{label}</Text>
        </Space>
      ))}
      <Text type='secondary'>同色底越深 = 掌握度越高（悬停看数值）</Text>
    </Space>
  )
}

export default function GraphPage({ frame }: { frame: AppFrame }) {
  const course = frame.course
  const reloadFrame = frame.reload
  const [doc, setDoc] = useState<GraphDoc | null>(null)
  const [banks, setBanks] = useState<BankEntry[] | null>(null)
  const [rec, setRec] = useState<RecommendDoc | null>(null)
  const [loading, setLoading] = useState(false)
  /** 排队/生成中的节点（节点名 → 阶段；角标与 hover 工具条消费）。 */
  const [genStates, setGenStates] = useState<Record<string, 'queued' | 'running'>>({})
  /** 全部图域任务（不限当前课程——空 vault 时种子起草的 course 是尚未存在的新课）。 */
  const [graphJobs, setGraphJobs] = useState<GenJobItem[]>([])
  // 总览过滤
  const [region, setRegion] = useState<string>('')
  const [search, setSearch] = useState('')
  const [readyOnly, setReadyOnly] = useState(false)

  const load = useCallback(async () => {
    if (!course) { setDoc(null); return }
    setLoading(true)
    try {
      const [g, b, r] = await Promise.all([
        api.graph(course).catch(() => null),
        api.questionsAll(course).catch(() => ({ total: 0, questions: [] as BankEntry[] })),
        api.recommend(30).catch(() => ({ events: [] as RecommendDoc['events'] })),
      ])
      setDoc(g)
      setBanks(b.questions)
      setRec(r as RecommendDoc)
    } finally {
      setLoading(false)
    }
  }, [course])

  useEffect(() => { void load() }, [load])

  // 页签激活重取（#161）：keep-alive 下组件不重挂，「切回图页」补一次取数——
  // 隐藏期间错过的图变化与状态面变化（就绪深度/复诊）在切回时刷新。
  useEffect(() => onTabActive('graph', () => { void load(); void reloadFrame() }),
    [load, reloadFrame])

  // 生成队列轮询：角标随排队/生成点亮；活动任务出现终态边沿 → 重拉图（hasContent 点亮）
  const activeKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const poll = async () => {
      try {
        const st = await api.generateStatus()
        setGraphJobs(st.jobs.filter(j => GRAPH_PHASES.has(j.phase ?? '')))
        const gen: Record<string, 'queued' | 'running'> = {}
        const active = new Set<string>()
        for (const j of st.jobs) {
          if (j.course !== course) continue
          if (j.status === 'running' || j.status === 'cancelling') { gen[j.node] = 'running'; active.add(j.key) }
          else if (j.status === 'queued') gen[j.node] = 'queued'
        }
        const edge = [...activeKeysRef.current].some(k => !active.has(k))
        activeKeysRef.current = active
        setGenStates(gen)
        // 终态边沿连状态面一并刷新：就绪深度/完成宣告等读侧折叠跟随生成结果更新（#161）
        if (edge) { void load(); void reloadFrame() }
      } catch {
        setGenStates({})
      }
    }
    void poll()
    // 页签保活（ADR-0027）：非激活页签跳过取数，定时器只保留节拍
    const timer = setInterval(() => { if (isActiveTab('graph')) void poll() }, 5000)
    return () => clearInterval(timer)
  }, [course, load, reloadFrame])

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
  /** 全部启用课程（课程切换器选项）与当前课程的就绪深度检查（状态面直读，#161）。 */
  const courseNames = useMemo(() => frame.tree?.courses.map(c => c.name) ?? [], [frame.tree])
  const coach = useMemo(
    () => frame.status?.courses.find(c => c.name === course)?.coach ?? null,
    [frame.status, course],
  )

  const onSelect = (nodeId: string) => {
    if (!course) return
    frame.openLesson(course, nodeId)
  }

  // 图上便捷生成：未生成直接入队；已生成（重新生成）先确认——覆盖现有正文与题库不清，仅重写正文管线
  const onGenerate = (nodeId: string) => {
    if (!course) return
    const has = doc?.nodes.find(n => n.data.id === nodeId)?.data.hasContent
    const run = () => {
      void api.generate(course, nodeId)
        .then(r => { Message.success(r.message); void load() })
        .catch(err => Message.error(err instanceof Error ? err.message : String(err)))
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

  if (!course) {
    // 空 vault：驾驶舱仍然可达——建课从这里开始（种子提案一次人审即开工）
    return (
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <Card><Text type='secondary'>还没有课程——在这里新建：种子一次人审即开工，图随教练回合沿真实的需要生长。</Text></Card>
        <CoachCockpit course={null} jobs={graphJobs} />
      </Space>
    )
  }
  if (loading && !doc) {
    return <Card><Text type='secondary'>加载学习图…</Text></Card>
  }
  if (!doc || !filtered) {
    return (
      <Card>
        <Space direction='vertical'>
          <Text type='secondary'>课程「{course}」还没有学习图。</Text>
          <Button onClick={() => frame.goto('generate')}>去生成页处理</Button>
        </Space>
      </Card>
    )
  }

  const s = { nodes: doc.nodes.length, edges: doc.edges.length }
  return (
    <Space direction='vertical' style={{ width: '100%' }} size={12}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Typography.Title heading={4} style={{ margin: 0 }}>{course} · 学习图</Typography.Title>
        <Space size={4} wrap>
          <Tag size='small'>{s.nodes} 节点</Tag>
          <Tag size='small'>{s.edges} 依赖</Tag>
          <Tag size='small'>{bankSet.size} 有题库</Tag>
          <Tag size='small' color='gray'>全局总览 · 点节点进入学习</Tag>
        </Space>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* 课程切换器（#161）：多课程时图页直接换课（教练台/图/题库/推荐随课重取） */}
          {courseNames.length > 1 && (
            <Select size='small' value={course} style={{ width: 160 }}
              onChange={v => frame.setCourse(v)}
              options={courseNames.map(c => ({ label: c, value: c }))} />
          )}
          <Select
            size='small' placeholder='全区' style={{ width: 160 }} allowClear
            value={region || undefined} onChange={v => setRegion(v ?? '')}
            options={regions.map(r => ({ label: r, value: r }))} />
          <Input.Search size='small' placeholder='搜索节点名' style={{ width: 180 }}
            value={search} onChange={setSearch} allowClear />
          <Space size={6}>
            <Text style={{ fontSize: 12 }} type='secondary'>只看进行中</Text>
            <Switch size='small' checked={readyOnly} onChange={setReadyOnly} />
          </Space>
          <Button size='small' loading={loading} onClick={() => void load()}>刷新</Button>
        </div>
      </div>

      {/* 教练台：图域命令面板下发（ADR-0038）；就绪深度卡随课直读状态面（#161） */}
      <CoachCockpit course={course} jobs={graphJobs} coach={coach} />

      {/* 推荐条（琥珀=下一步推荐；点击卡片直接进学习视图） */}
      {(rec?.events ?? []).filter(e => e.course === course).length > 0 && (
        <Space size={6} wrap>
          {(rec?.events ?? []).filter(e => e.course === course).slice(0, 8).map((e, i) => (
            <Tag key={i} color={REC_TYPE_COLOR[e.type] ?? 'gray'}
              style={{ cursor: 'pointer' }}
              onClick={() => frame.openLesson(e.course, e.node)}>
              {e.node}（{REC_TYPE_LABEL[e.type] ?? e.type}）
            </Tag>
          ))}
        </Space>
      )}

      <div className='dag-wrap'>
        <GraphDagView
          key={course} doc={filtered} recommended={recommended} lockedIds={lockedIds}
          bankSet={bankSet} genStates={genStates} focusNode={frame.focusNode}
          onSelect={onSelect} onGenerate={onGenerate} />
      </div>

      <Legend />
    </Space>
  )
}
