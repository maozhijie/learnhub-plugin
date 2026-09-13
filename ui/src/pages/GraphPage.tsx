/** 图页 = 学习图驾驶舱（低频）：教练台（建课/生长一步/罗盘/回填/复诊）+ DAG 纵览
 * （区过滤/搜索/只看就绪 + 推荐星标）。点节点直接进学习视图（LessonView）；从学习
 * 视图「在图中查看」跳入时 focusNode 红描边定位。图本身不承载学习操作。
 * #158 三态化：加载中/失败/空显式区分——宿主不可达显「加载失败 + 重试」，不再把
 * 失败伪装成「还没有学习图」；#159 图缺失空态就地接教练台动作（重建种子直达）。 */
import { Button, Card, Input, Message, Modal, Result, Select, Space, Switch, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CoachCockpit from '../components/CoachCockpit'
import GraphDagView from '../components/GraphDagView'
import SeedFormModal from '../components/SeedFormModal'
import { api } from '../api'
import { onTabActive } from '../active-tab'
import { usePolling } from '../hooks/usePolling'
import { errorMessage } from '../hooks/useCommand'
import type { AppFrame } from '../App'
import type { BankEntry, GenJobItem, GraphDoc, RecommendDoc } from '../types'

const { Text } = Typography

/** 图域任务 phase 全集（与 useCoachToasts 同口径）：驾驶舱在途条与完成通知的消费面。 */
const GRAPH_PHASES = new Set(['seed', 'growth', 'compass', 'decompile', 'plan', 'milestone'])

const REC_TYPE_COLOR: Record<string, string> = { review: 'green', overdue: 'red', ready: 'blue', new: 'cyan' }
const REC_TYPE_LABEL: Record<string, string> = { review: '复习', overdue: '逾期', ready: '就绪', new: '新学' }

/** 图例：状态色点 + 掌握度深浅说明。终点条目按 ADR-0056 修订注明「承诺标记」语义——
 * 终点不被学习调度、不产料，不是图上待学的课程节点（#200 / ADR-0055）。 */
function Legend() {
  const items: Array<[string, string]> = [
    ['未学', '#c9cdd4'],
    ['就绪/进行', '#165dff'],
    ['复习/掌握', '#00b42a'],
    ['已跳过', '#722ed1'],
    ['推荐下一步', '#ff7d00'],
    ['⚑ 终点（承诺标记）', '#f5319d'],
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
      <Text type='secondary'>终点是锚定的承诺位置：不被学习调度、不产料（ADR-0056）</Text>
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
  /** #158 三态化：图加载失败显式记录（与「图缺失空态」分开——失败要给重试）。 */
  const [graphError, setGraphError] = useState<string | null>(null)
  /** #159：图缺失空态的就地教练台动作（重建种子表单）。 */
  const [seedForm, setSeedForm] = useState(false)
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
      // 图是本页主数据：失败要冒泡进失败态；题库/推荐是次要数据，缺了按空处理
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

  // 页签激活重取（#161）：keep-alive 下组件不重挂，「切回图页」补一次取数——
  // 隐藏期间错过的图变化与状态面变化（就绪深度/复诊）在切回时刷新。
  useEffect(() => onTabActive('graph', () => { void load(); void reloadFrame() }),
    [load, reloadFrame])

  // 生成队列轮询：角标随排队/生成点亮；活动任务出现终态边沿 → 重拉图（hasContent 点亮）。
  // 边沿检测是页面逻辑，节拍样板（挂载即取/激活门/切回即补/卸载清理）在 usePolling。
  const activeKeysRef = useRef<Set<string>>(new Set())
  usePolling(async () => {
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
  }, { tab: 'graph', intervalMs: 5000 })

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

  if (!course) {
    // 空 vault：驾驶舱仍然可达——建课从这里开始（种子提案一次人审即开工）
    return (
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <Card><Text type='secondary'>还没有课程——在这里新建：种子一次人审即开工，图随教练回合沿真实的需要生长。</Text></Card>
        <CoachCockpit course={null} jobs={graphJobs} onOpenJob={j => frame.locateJob(j.key)} />
      </Space>
    )
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
  if (!doc || !filtered || doc.nodes.length === 0) {
    // #159 图缺失空态：引导就地落在教练台动作上（重建种子直达），不再只推去生成页
    return (
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <Card>
          <Space direction='vertical' size={10}>
            <Text type='secondary'>课程「{course}」还没有学习图：种子提案尚未应用（或图数据为空）。</Text>
            <Space size={8}>
              <Button type='primary' onClick={() => setSeedForm(true)}>重建种子（换终点/改工作表）</Button>
              <Button onClick={() => frame.goto('generate')}>去生成页看任务</Button>
            </Space>
          </Space>
        </Card>
        {/* 图缺失 = 未播种：生长一步禁用（必然失败的操作），种子直达按钮在上面（#155） */}
        <CoachCockpit course={course} jobs={graphJobs} seeded={false} onOpenJob={j => frame.locateJob(j.key)} />
        {seedForm && <SeedFormModal visible={seedForm} mode='reseed' course={course} onCancel={() => setSeedForm(false)} />}
      </Space>
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
          {/* 主线深度（原 max_depth 正名，#200 / ADR-0055）：终点计入——课程长到哪里的进度读数 */}
          <Tag size='small' color='magenta'>主线深度 {doc.stats.max_depth}</Tag>
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

      {/* 教练台：图域命令面板下发（ADR-0038）；就绪深度卡随课直读状态面（#161）；
       * 有图 = 已播种，生长一步可用；任务条点击落生成页对应任务（#155） */}
      <CoachCockpit course={course} jobs={graphJobs} coach={coach} onOpenJob={j => frame.locateJob(j.key)} />

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
