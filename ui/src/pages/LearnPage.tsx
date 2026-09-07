/** 学习页（主界面）：XP 时间账本条 + 复习横幅 + 「接下来学/复习」推荐流
 * （点开直接进 LessonView）+ 课程卡（次要区）。二级视图 LessonView 承载
 * 正文/mastery 会话/完成。复习会话 = 刷卡：只列到期题，作答即驱动该题 FSRS
 * 调度；无题节点提示出题。 */
import {
  Alert, Button, Card, Empty, Input, Message, Modal, Popconfirm, Progress, Space,
  Tag, Typography,
} from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import LessonView from '../components/LessonView'
import QuestionCard from '../components/QuestionCard'
import { api } from '../api'
import type { AppFrame } from '../App'
import type { QuestionItem, RecEvent, RecommendDoc, XpStatus } from '../types'

const { Text, Title } = Typography

const REC_TYPE: Record<string, { label: string; color: string; order: number }> = {
  overdue: { label: '逾期', color: 'red', order: 0 },
  review: { label: '复习', color: 'green', order: 1 },
  learning: { label: '继续学', color: 'arcoblue', order: 2 },
  new: { label: '新学', color: 'cyan', order: 3 },
}

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** XP 时间账本条：今日 XP / 每日目标环 + 连续学习天数（Math Academy 的进度货币）。 */
function XpBar({ xp, onEditGoal }: { xp: XpStatus; onEditGoal: () => void }) {
  const percent = Math.min(100, Math.round((xp.today_xp / Math.max(1, xp.goal)) * 100))
  return (
    <Card size='small' style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <Progress type='circle' width={44} percent={percent} showText={false} />
        <div>
          <Text style={{ fontWeight: 600, fontSize: 16 }}>{xp.today_xp} XP</Text>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>今日 · 目标 {xp.goal} XP</Text>
        </div>
        <div>
          <Text style={{ fontWeight: 600, fontSize: 16 }}>{xp.streak} 天</Text>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>连续学习</Text>
        </div>
        <Button size='mini' type='text' style={{ marginLeft: 'auto' }} onClick={onEditGoal}>
          调整每日目标
        </Button>
      </div>
    </Card>
  )
}

/** 复习横幅：到期题驱动（有到期题的节点数 + 开始复习）。 */
function ReviewBanner({ dueCount, onStart }: { dueCount: number; onStart: () => void }) {
  return (
    <Card size='small' style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>待复习</Text>
          <Text style={{ fontSize: 20, fontWeight: 600 }}>{dueCount}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}> 个节点有到期题目</Text>
        </div>
        <Button type='primary' onClick={onStart} disabled={dueCount === 0} style={{ marginLeft: 'auto' }}>
          开始复习（{dueCount}）
        </Button>
      </div>
    </Card>
  )
}

/** 推荐流大卡片：点开直接进 LessonView——主界面的核心动作；内联跳过（已有基础免学）。 */
function RecCard({ e, onOpen, onSkip }: { e: RecEvent; onOpen: () => void; onSkip: () => void }) {
  const t = REC_TYPE[e.type] ?? { label: e.type, color: 'gray', order: 9 }
  return (
    <Card size='small' hoverable style={{ borderRadius: 10, cursor: 'pointer', borderLeft: `3px solid var(--color-${t.color === 'red' ? 'danger' : t.color === 'green' ? 'success' : t.color === 'arcoblue' ? 'arcoblue' : 'primary'}-6,#165dff)` }}>
      <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Tag color={t.color}>{t.label}</Tag>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title heading={6} style={{ margin: 0 }}>{e.node}</Title>
          <Text type='secondary' style={{ fontSize: 12 }}>
            {e.course}{e.region ? ` · ${e.region}` : ''}{e.why ? ` · ${e.why}` : ''}
          </Text>
        </div>
        <Button size='mini' type='primary' onClick={ev => { ev.stopPropagation(); onOpen() }}>
          {e.type === 'review' || e.type === 'overdue' ? '去复习' : '去学习'}
        </Button>
        {/* span 拦截冒泡：卡片本体点击是打开学习，Popconfirm 触发不应进学习视图 */}
        <span onClick={ev => ev.stopPropagation()}>
          <Popconfirm
            title={`跳过「${e.node}」？`}
            content='该节点将视同已通过，不再出现在推荐与阻塞判定；可在节点学习页取消跳过。'
            onOk={onSkip}>
            <Button size='mini' type='text' status='warning'>跳过</Button>
          </Popconfirm>
        </span>
      </div>
    </Card>
  )
}

/** 课程卡（次要区）：进度 + 打开图/复习/删除。计数语义：未学 = unseen+ready。 */
function CourseCard(props: {
  name: string
  counts: { unseen: number; ready: number; learning: number; review: number; mastered: number; skipped: number }
  total: number
  due: number
  onOpen: () => void
  onReview: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const notStarted = props.counts.unseen + props.counts.ready
  const done = props.counts.mastered
  const percent = props.total ? Math.round((done / props.total) * 100) : 0
  return (
    <Card size='small' hoverable style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Title heading={6} style={{ margin: 0 }}>{props.name}</Title>
        <Progress percent={percent} showText size='small' />
        <Space size={4} wrap>
          <Tag size='small' color='gray'>未学 {notStarted}</Tag>
          <Tag size='small' color='arcoblue'>进行 {props.counts.learning}</Tag>
          <Tag size='small' color='green'>复习 {props.counts.review}</Tag>
          <Tag size='small' color='green'>掌握 {done}</Tag>
          {props.counts.skipped > 0 && <Tag size='small' color='purple'>跳过 {props.counts.skipped}</Tag>}
          {props.due > 0 && <Tag size='small' color='red'>到期 {props.due}</Tag>}
        </Space>
        <Space size={6}>
          <Button size='mini' onClick={props.onOpen}>打开图</Button>
          <Button size='mini' onClick={props.onReview}>复习</Button>
          <Button size='mini' type='text' status='warning' onClick={props.onRegenerate}>重新生成</Button>
          <Button size='mini' type='text' status='danger' onClick={props.onDelete}>删除</Button>
        </Space>
      </div>
    </Card>
  )
}

/** 复习会话：逐节点刷卡（只列到期/未做过题），作答即驱动该题 FSRS；无题节点提示完成/出题。 */
function ReviewSession(props: {
  queue: RecEvent[]
  onClose: () => void
  onFinish: () => Promise<void>
  /** 每题作答后刷新推荐流/XP（主界面数据随作答实时更新）。 */
  onSettled: () => void
}) {
  const [idx, setIdx] = useState(0)
  const [questions, setQuestions] = useState<QuestionItem[] | null>(null)
  const today = todayStr()
  const item = props.queue[idx]

  const loadQuestions = useCallback(async () => {
    setQuestions(null)
    if (!item) return
    try {
      const bank = await api.questions(item.course, item.node)
      // 刷卡语义：到期题优先；无任何题 → 提示出题
      const due = bank.questions.filter(q => q.due !== null && q.due <= today)
      const fresh = bank.questions.filter(q => q.due === null)
      setQuestions([...due, ...fresh])
    } catch {
      setQuestions([])
    }
  }, [item, today])

  useEffect(() => { void loadQuestions() }, [loadQuestions])

  if (!item) return null

  const finish = async () => {
    await props.onFinish()
    props.onClose()
  }

  return (
    <Modal
      title={`复习 ${idx + 1}/${props.queue.length}`} visible footer={null} unmountOnExit
      onCancel={() => { void finish() }} style={{ width: 620 }}>
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <div>
          <Text type='secondary'>{item.course} · </Text>
          <Text bold>{item.node}</Text>
          {item.why && <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>{item.why}</Text>}
        </div>
        {questions === null ? <Text type='secondary'>加载题库…</Text>
          : questions.length > 0 ? (
            questions.map(q => (
              <QuestionCard key={q.id} course={item.course} node={item.node} question={q}
                onDone={() => { void loadQuestions(); props.onSettled() }} />
            ))
          ) : (
            <Alert type='info' content='该节点还没有题目：在学习视图里「AI 出题」，或直接「完成学习」。' />
          )}
        <Button size='small' type='text' onClick={() => setIdx(i => i + 1)}>跳过此节点</Button>
      </Space>
    </Modal>
  )
}

/** 建课引导：多轮生成走 dsh agent（技能 learnhub-graph-generate），面板只给入口说明。 */
function CreateDialog(props: { visible: boolean; onClose: () => void }) {
  return (
    <Modal title='生成新课程' visible={props.visible} footer={null} onCancel={props.onClose} style={{ width: 560 }}>
      <Space direction='vertical' size={12}>
        <Alert type='info' content='课程图由 dsh agent 按多轮流程构建（范围分析 → 骨架 → 分批展开 → 审计修复），复杂主题产出数百节点，节点名用动作句。' />
        <Text>在 dsh 对话里直接说：</Text>
        <Input.TextArea
          value='用 learnhub-graph-generate 技能，为我生成课程「<主题>」，起点：<已有基础>，目标：<学会什么>'
          readOnly autoSize={{ minRows: 3, maxRows: 4 }} />
        <Text type='secondary' style={{ fontSize: 12 }}>
          提案生成后回到本面板「提案」页签审阅应用；在推荐流里点开节点即可「生成正文（自动出题）」。已有基础的节点可在推荐卡或节点学习页里「跳过」。
        </Text>
      </Space>
    </Modal>
  )
}

export default function LearnPage({ frame }: { frame: AppFrame }) {
  const [rec, setRec] = useState<RecommendDoc | null>(null)
  const [xp, setXp] = useState<XpStatus | null>(null)
  const [session, setSession] = useState<RecEvent[] | null>(null)
  const [createVisible, setCreateVisible] = useState(false)
  const [runningJobs, setRunningJobs] = useState(0)

  const load = useCallback(async () => {
    setRec(await api.recommend(12).catch(() => null))
    setXp(await api.xp().catch(() => null))
  }, [])

  useEffect(() => { void load() }, [load])

  // 从学习视图返回推荐流：XP/推荐流按最新数据重拉（作答结算发生在学习视图内）
  const prevLessonRef = useRef(frame.lesson)
  useEffect(() => {
    if (prevLessonRef.current && !frame.lesson) void load()
    prevLessonRef.current = frame.lesson
  }, [frame.lesson, load])
  // 后台生成悬浮指示条（allo CourseGenerationPill 同语义）
  useEffect(() => {
    const poll = async () => {
      try {
        const jobs = await api.generateStatus()
        setRunningJobs(jobs.filter(j => j.status === 'running' || j.status === 'cancelling').length)
      } catch {
        setRunningJobs(0)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const h = () => { void frame.reload(); void load() }
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [frame, load])

  const reviewQueue = (rec?.events ?? []).filter(e => e.type === 'review' || e.type === 'overdue')
  const learnEvents = (rec?.events ?? []).filter(e => e.type !== 'review' && e.type !== 'overdue')

  const deleteCourse = (name: string) => {
    Modal.confirm({
      title: `删除课程「${name}」？`,
      content: '注册表移除，课程目录移入 学习中心/.trash/（可手工找回）。',
      onOk: async () => {
        try {
          const r = await api.courseDelete(name)
          Message.success(`已删除 ${r.removed}，目录在 ${r.trash}`)
          await frame.reload()
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        }
      },
    })
  }

  // 推荐卡内联跳过：与节点学习页同一 nodeSkip 语义（可逆，可在节点页取消）
  const skipNode = async (e: RecEvent) => {
    try {
      await api.nodeSkip(e.course, e.node, true)
      Message.success(`已跳过「${e.node}」：视同已通过，不再出现在推荐与阻塞判定`)
      await Promise.all([frame.reload(), load()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  // 课程卡入口的整课重生成（与生成页同一 /course/reset 通道，进度在生成页看）
  const regenerateCourse = (name: string) => {
    Modal.confirm({
      title: `重新生成课程「${name}」？`,
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <div>将删除该课程的：全部节正文与节清单、全部练习题、全部交互件与生成的图片。</div>
          <div style={{ marginTop: 8, color: 'var(--color-text-3)' }}>
            旧内容备份到 .trash（可恢复）；课程图谱、学习进度与掌握度保留。删除后按学习顺序逐节点重新生成（每个节点需数分钟），进度在「生成」页签实时展示。
          </div>
        </div>
      ),
      okText: '重新生成',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api.resetCourse(name)
          Message.success(`已重置「${name}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成`)
          await Promise.all([frame.reload(), load()])
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        }
      },
    })
  }

  // 二级视图：节点学习（最大最丰富）
  if (frame.lesson) {
    return <LessonView course={frame.lesson.course} node={frame.lesson.node} frame={frame} />
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Title heading={4} style={{ margin: 0 }}>学习中心</Title>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button onClick={() => setCreateVisible(true)}>生成新课程</Button>
        </div>
      </div>
      <XpBar xp={xp ?? { date: '', today_xp: 0, goal: 30, streak: 0, eta: [] }}
        onEditGoal={() => frame.goto('stats')} />
      <ReviewBanner dueCount={reviewQueue.length} onStart={() => setSession(reviewQueue)} />

      {/* 核心区：「接下来学/复习」推荐流——点开直接进学习视图 */}
      {frame.tree && frame.tree.courses.length === 0 ? (
        <Empty description='还没有课程。点右上角「生成新课程」看引导，然后在 dsh 对话里让 agent 按技能建课。' />
      ) : (rec && (reviewQueue.length + learnEvents.length) > 0 ? (
        <Card size='small' title='接下来' style={{ borderRadius: 10 }}>
          <Space direction='vertical' style={{ width: '100%' }} size={10}>
            {[...reviewQueue, ...learnEvents].sort((a, b) =>
              (REC_TYPE[a.type]?.order ?? 9) - (REC_TYPE[b.type]?.order ?? 9)).map((e, i) => (
                <RecCard key={i} e={e} onOpen={() => frame.openLesson(e.course, e.node)}
                  onSkip={() => void skipNode(e)} />
              ))}
          </Space>
        </Card>
      ) : (
        <Empty description='暂无推荐：所有到期内容已处理。可在课程卡「打开图」里挑节点学习，或生成新课程。' />
      ))}

      {/* 课程卡（次要区） */}
      <Card size='small' title='我的课程' style={{ borderRadius: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
          {frame.tree?.courses.map(c => {
            const s = frame.status?.courses.find(x => x.name === c.name)
            return (
              <CourseCard
                key={c.name} name={c.name} total={s?.total ?? 0} due={s?.due_today ?? 0}
                counts={s?.counts ?? { unseen: 0, ready: 0, learning: 0, review: 0, mastered: 0, skipped: 0 }}
                onOpen={() => { frame.setCourse(c.name); frame.goto('graph') }}
                onRegenerate={() => regenerateCourse(c.name)}
                onReview={() => {
                  const q = reviewQueue.filter(e => e.course === c.name)
                  if (!q.length) { Message.info('该课程暂无到期复习'); return }
                  setSession(q)
                }}
                onDelete={() => deleteCourse(c.name)} />
            )
          })}
        </div>
      </Card>

      {session && session.length > 0 && (
        <ReviewSession queue={session} onClose={() => setSession(null)}
          onFinish={async () => { await Promise.all([frame.reload(), load()]) }}
          onSettled={load} />
      )}
      {createVisible && <CreateDialog visible={createVisible} onClose={() => setCreateVisible(false)} />}

      {/* 后台生成悬浮指示条 */}
      {runningJobs > 0 && !frame.lesson && (
        <div
          role='button' tabIndex={0}
          onClick={() => frame.goto('generate')}
          onKeyDown={e => { if (e.key === 'Enter') frame.goto('generate') }}
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 100, cursor: 'pointer',
            background: 'var(--color-bg-2,#fff)', border: '1px solid var(--color-border-2,#e5e6eb)',
            borderRadius: 20, boxShadow: 'var(--color-shadow-1, 0 4px 10px rgba(0,0,0,0.1))',
            padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8,
          }}>
          <span style={{ color: 'var(--color-primary-6,#165dff)' }}>◌</span>
          <Text>{runningJobs} 个正文生成中</Text>
          <Text type='secondary' style={{ fontSize: 12 }}>点击查看</Text>
        </div>
      )}
    </Space>
  )
}
