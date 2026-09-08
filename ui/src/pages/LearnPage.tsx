/** 学习页（主界面）：XP 时间账本条 + 复习横幅 + 「接下来学/复习」推荐流
 * （点开直接进 LessonView）+ 课程卡（次要区）。二级视图 LessonView 承载
 * 正文/mastery 会话/完成。复习会话 = Anki 式刷卡队列：跨课程到期题扁平排队，
 * 一卡一票（作答或满 5 秒申报忘记），背面自评 Hard/Good/Easy 推进调度。 */
import {
  Alert, Button, Card, Empty, Input, Message, Modal, Popconfirm, Progress, Space,
  Tag, Tooltip, Typography,
} from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import LessonView from '../components/LessonView'
import QuestionCard, { type AnswerOutcome, toOutcome } from '../components/QuestionCard'
import { nextBand, pickNext } from '../../../src/engine/adaptive'
import { api } from '../api'
import type { AppFrame } from '../App'
import type { DiagnosticEntry, RecEvent, RecommendDoc, ReviewCard, ReviewQueueDoc, XpStatus } from '../types'

const { Text, Title } = Typography

const REC_TYPE: Record<string, { label: string; color: string; order: number }> = {
  overdue: { label: '逾期', color: 'red', order: 0 },
  review: { label: '复习', color: 'green', order: 1 },
  diagnostic: { label: '内容诊断', color: 'magenta', order: 2 },
  learning: { label: '继续学', color: 'arcoblue', order: 3 },
  new: { label: '新学', color: 'cyan', order: 4 },
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

/** 复习横幅：到期卡驱动（复习队列张数 + 开始复习）。 */
function ReviewBanner({ dueCount, onStart }: { dueCount: number; onStart: () => void }) {
  return (
    <Card size='small' style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>待复习</Text>
          <Text style={{ fontSize: 20, fontWeight: 600 }}>{dueCount}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}> 张卡到期</Text>
        </div>
        <Button type='primary' onClick={onStart} disabled={dueCount === 0} style={{ marginLeft: 'auto' }}>
          开始复习（{dueCount}）
        </Button>
      </div>
    </Card>
  )
}

/** 推荐流大卡片：点开直接进 LessonView——主界面的核心动作；内联跳过（已有基础免学）。
 * 内容三态标识：已生成（点开有东西读）/ 生成中 / 排队中；未生成节点主按钮让给「生成内容」。
 * 事件携带 diagnostics（B1 #69）时内联「重写此节」直达动作——Popconfirm 确认后才走
 * 单节重写管线（诊断建议先行，不自动动库）。 */
function RecCard({ e, gen, onOpen, onSkip, onGenerate }: {
  e: RecEvent
  gen?: 'queued' | 'running'
  onOpen: () => void
  onSkip: () => void
  onGenerate: () => void
}) {
  const t = REC_TYPE[e.type] ?? { label: e.type, color: 'gray', order: 9 }
  const generating = gen === 'running' || gen === 'queued'
  const [rewriting, setRewriting] = useState<string | null>(null)
  const rewriteSection = async (d: DiagnosticEntry) => {
    setRewriting(d.rewrite.section)
    try {
      const r = await api.sectionRewrite(d.rewrite.course, d.rewrite.node, d.rewrite.section)
      Message.success(r.message)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRewriting(null)
    }
  }
  return (
    <Card size='small' hoverable style={{ borderRadius: 10, cursor: 'pointer', borderLeft: `3px solid var(--color-${t.color === 'red' ? 'danger' : t.color === 'green' ? 'success' : t.color === 'arcoblue' ? 'arcoblue' : 'primary'}-6,#165dff)` }}>
      <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Tag color={t.color}>{t.label}</Tag>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title heading={6} style={{ margin: 0 }}>
            {e.node}
            {gen === 'running' && <Tag size='small' color='arcoblue' style={{ marginLeft: 8 }}>生成中</Tag>}
            {gen === 'queued' && <Tag size='small' color='gray' style={{ marginLeft: 8 }}>排队中</Tag>}
            {!generating && e.hasContent && <Tag size='small' color='green' style={{ marginLeft: 8 }}>已生成</Tag>}
          </Title>
          <Text type='secondary' style={{ fontSize: 12 }}>
            {e.course}{e.region ? ` · ${e.region}` : ''}{e.why ? ` · ${e.why}` : ''}
          </Text>
        </div>
        {!e.hasContent && !generating ? (
          <Button size='mini' type='primary' status='warning' onClick={ev => { ev.stopPropagation(); onGenerate() }}>
            生成内容
          </Button>
        ) : (
          <Button size='mini' type='primary' loading={gen === 'running'} disabled={gen === 'queued'}
            onClick={ev => { ev.stopPropagation(); onOpen() }}>
            {gen === 'running' ? '生成中' : gen === 'queued' ? '排队中' : e.type === 'review' || e.type === 'overdue' ? '去复习' : '去学习'}
          </Button>
        )}
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
      {e.diagnostics?.length ? (
        <div onClick={ev => ev.stopPropagation()} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {e.diagnostics.map(d => (
            <div key={d.section} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '6px 10px',
            }}>
              <Tag size='small' color={d.signal === 'R1' ? 'red' : 'orange'}>{d.signal}</Tag>
              <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 200 }}>「{d.sectionTitle}」{d.reason}</Text>
              {d.escalate ? (
                <Tooltip content='重写后仍反复失败：问题可能不在正文——请人工审题、归档坏题或检查前置'>
                  <Tag size='small' color='purple'>转人工处理</Tag>
                </Tooltip>
              ) : (
                <Popconfirm
                  title={`重写「${d.sectionTitle}」这一节？`}
                  content='走单节重写管线（过质检门 + 一轮修复）：只手术这一节正文（版本 +1），题库与复习计划不动。'
                  onOk={() => void rewriteSection(d)}>
                  <Button size='mini' type='text' loading={rewriting === d.rewrite.section}>重写此节</Button>
                </Popconfirm>
              )}
            </div>
          ))}
        </div>
      ) : null}
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

/** 复习刷卡会话（Anki 式扁平队列）：一卡一票——正面作答或满 5 秒申报忘记
 * （按答错记证据、0 XP），背面自评 Hard/Good/Easy（带到期预览，键盘 2/3/4）即翻
 * 下一张；答错/忘记自动 Again 明天再见，当次队列不回头。出完给小结（纯展示，
 * 逐题流水已实时入账）。
 * 单节点「已调度题」会话（#57 A1）：按目标难度带流式选题——起点先验取引擎在
 * 定向队列响应里给出的节点 Mastery 先验带，连续答对 ≥2 次升一档、答错/忘记
 * 降回基础题；多节点/全局会话维持快照序不变。 */
function ReviewSession(props: {
  queue: ReviewCard[]
  onClose: () => void
  onFinish: () => Promise<void>
  /** 每张卡结算后刷新主界面数据（XP/推荐流/到期数随作答实时更新）。 */
  onSettled: () => void
}) {
  const [idx, setIdx] = useState(0)
  const [tally, setTally] = useState({ right: 0, wrong: 0, forgot: 0, hard: 0, good: 0, easy: 0 })
  /** 当前卡背面的作答结果（自评键盘快捷键与 footer 的依据）。 */
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null)
  // A1 会话内自适应（#57）：仅单节点会话启用；pending 为剩余卡，band/streak 为目标带与连对数，
  // base 为起点先验带（答错/忘记的降档回落点），total 为会话卡数（自适应模式下取重拉队列）。
  const singleNode = new Set(props.queue.map(c => `${c.course}/${c.node}`)).size === 1
  const [adaptive, setAdaptive] = useState(false)
  const [pending, setPending] = useState<ReviewCard[]>(props.queue)
  const [total, setTotal] = useState(props.queue.length)
  const [band, setBand] = useState(0.5)
  const [streak, setStreak] = useState(0)
  const [base, setBase] = useState(0)
  useEffect(() => {
    if (!singleNode) return
    const head = props.queue[0]
    if (!head) return
    api.reviewQueue(head.course, head.node).then(doc => {
      if (!doc.cards.length || doc.band === undefined) return
      setAdaptive(true)
      setPending(doc.cards)
      setTotal(doc.cards.length)
      setBand(doc.band)
      setBase(doc.band)
    }).catch(() => { /* 拉不到先验：按快照序走 */ })
  // 会话挂载时取一次起点先验即可；后续由本组件内作答驱动
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const card = adaptive ? pickNext(pending, band) : props.queue[idx]
  const done = !card

  const next = () => {
    setOutcome(null)
    if (adaptive && card) setPending(list => list.filter(c => c.id !== card.id))
    else setIdx(i => i + 1)
  }

  /** A1 选档：作答结果即时改写目标带（连对 ≥2 升一档、答错/忘记降回基础带）。 */
  const applyBand = (ok: boolean) => {
    const ns = nextBand(band, ok, streak, base)
    setBand(ns.band)
    setStreak(ns.streak)
  }

  const handleDone = (oc: AnswerOutcome) => {
    setOutcome(oc)
    if (oc.correct === true) {
      setTally(t => ({ ...t, right: t.right + 1 }))
      if (adaptive) applyBand(true)
    } else if (oc.judge === 'forget' || oc.correct === false) {
      if (oc.judge === 'forget') setTally(t => ({ ...t, forgot: t.forgot + 1 }))
      else setTally(t => ({ ...t, wrong: t.wrong + 1 }))
      if (adaptive) applyBand(false)
    }
    props.onSettled()
  }

  /** 自评结算：挂起调度按选中档位落盘，选完即翻下一张。 */
  const rate = async (r: 2 | 3 | 4) => {
    if (!card) return
    try {
      await api.questionRate(card.course, card.node, card.id, r)
      setTally(t => ({
        ...t,
        hard: r === 2 ? t.hard + 1 : t.hard,
        good: r === 3 ? t.good + 1 : t.good,
        easy: r === 4 ? t.easy + 1 : t.easy,
      }))
      next()
      props.onSettled()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const forget = (elapsedS: number): Promise<AnswerOutcome> => {
    if (!card) return Promise.reject(new Error('没有当前卡'))
    return api.questionForget(card.course, card.node, card.id, elapsedS).then(toOutcome)
  }

  // 自评键盘快捷键（决议 3）：背面挂起时 2/3/4 = Hard/Good/Easy
  useEffect(() => {
    if (!outcome?.pendingRating) return
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.key === '2') void rate(2)
      else if (e.key === '3') void rate(3)
      else if (e.key === '4') void rate(4)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [outcome])

  /** 背面附加件：自评三按钮（挂起）/ 已推进说明 / Again 明天再见。 */
  const footer = (oc: AnswerOutcome): ReactNode => {
    if (oc.pendingRating && oc.previews) {
      return (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          <Text type='secondary' style={{ fontSize: 12 }}>记得多牢？自评推进调度（快捷键 2/3/4）</Text>
          <Button size='small' onClick={() => void rate(2)}>Hard · {oc.previews!.hard}</Button>
          <Button size='small' type='primary' onClick={() => void rate(3)}>Good · {oc.previews!.good}</Button>
          <Button size='small' status='success' onClick={() => void rate(4)}>Easy · {oc.previews!.easy}</Button>
        </div>
      )
    }
    if (oc.correct === true) {
      // 队列快照后该题被练习流答过（当日调度已推进）：无自评可出，仅记录并继续
      return (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <Text type='secondary' style={{ fontSize: 12 }}>今日已在学习中推进过调度，本次仅记录</Text>
          <Button size='small' type='primary' onClick={next}>下一张</Button>
        </div>
      )
    }
    if (oc.correct === false) {
      return (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <Text type='secondary' style={{ fontSize: 12 }}>
            {oc.judge === 'forget' ? '已按忘记调度，明天再见' : '已按答错调度（Again），明天再见'}
          </Text>
          <Button size='small' type='primary' onClick={next}>下一张</Button>
        </div>
      )
    }
    return null
  }

  const finish = async () => {
    await props.onFinish()
    props.onClose()
  }

  if (done) {
    return (
      <Modal title='复习完成' visible footer={null} unmountOnExit style={{ width: 480 }}
        onCancel={() => { void finish() }}>
        <Space direction='vertical' style={{ width: '100%' }} size={14}>
          <Card size='small' style={{ borderRadius: 10 }}>
            <Space direction='vertical' size={6}>
              <Title heading={6} style={{ margin: 0 }}>本轮复习 {total} 张</Title>
              <Text type='secondary'>
                答对 {tally.right}（Hard {tally.hard} / Good {tally.good} / Easy {tally.easy}）
                · 忘记 {tally.forgot} · 答错 {tally.wrong}
              </Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                忘记与答错的卡明天到期再见；逐题流水与 XP 已实时入账。
              </Text>
            </Space>
          </Card>
          <Button type='primary' long onClick={() => { void finish() }}>完成</Button>
        </Space>
      </Modal>
    )
  }

  return (
    <Modal title={`复习 ${(adaptive ? total - pending.length : idx) + 1}/${total}`} visible footer={null} unmountOnExit
      onCancel={() => { void finish() }} style={{ width: 680 }}>
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <Space size={8} wrap>
          <Text type='secondary'>{card.course} · </Text>
          <Text bold>{card.node}</Text>
          <Tag size='small' color='green'>到期 {card.due}</Tag>
          <Tag size='small'>做过 {card.attempts} 次</Tag>
        </Space>
        <QuestionCard key={card.id} course={card.course} node={card.node} question={card}
          variant='review' noRedo
          submitter={(payload, elapsedS) => api.questionAnswer(
            card.course, card.node, card.id, payload, elapsedS, { deferSchedule: true },
          ).then(toOutcome)}
          onForget={forget}
          footer={footer}
          onDone={handleDone} />
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
  const [reviewQ, setReviewQ] = useState<ReviewQueueDoc | null>(null)
  const [session, setSession] = useState<ReviewCard[] | null>(null)
  const [createVisible, setCreateVisible] = useState(false)
  const [runningJobs, setRunningJobs] = useState(0)
  const [queuedJobs, setQueuedJobs] = useState(0)
  /** 排队/生成中的节点（course/node → 阶段），推荐卡三态标识消费。 */
  const [genMap, setGenMap] = useState<Record<string, 'queued' | 'running'>>({})

  const load = useCallback(async () => {
    setRec(await api.recommend(12).catch(() => null))
    setXp(await api.xp().catch(() => null))
    setReviewQ(await api.reviewQueue().catch(() => null))
  }, [])

  useEffect(() => { void load() }, [load])

  // 从学习视图返回推荐流：XP/推荐流按最新数据重拉（作答结算发生在学习视图内）
  const prevLessonRef = useRef(frame.lesson)
  useEffect(() => {
    if (prevLessonRef.current && !frame.lesson) void load()
    prevLessonRef.current = frame.lesson
  }, [frame.lesson, load])
  // 后台生成悬浮指示条（allo CourseGenerationPill 同语义）+ 队列状态。
  // 活动任务集合出现终态边沿 → 重拉推荐流（对应节点的「已生成」标识随之点亮）。
  const activeKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const poll = async () => {
      try {
        const st = await api.generateStatus()
        const active = st.jobs.filter(j => j.status === 'running' || j.status === 'cancelling')
        const gen: Record<string, 'queued' | 'running'> = {}
        for (const j of st.jobs) {
          if (j.status === 'running' || j.status === 'cancelling') gen[`${j.course}/${j.node}`] = 'running'
          else if (j.status === 'queued') gen[`${j.course}/${j.node}`] = 'queued'
        }
        const keys = new Set(active.map(j => j.key))
        const edge = [...activeKeysRef.current].some(k => !keys.has(k))
        activeKeysRef.current = keys
        setRunningJobs(active.length)
        setQueuedJobs(st.queuedCount)
        setGenMap(gen)
        if (edge) void load()
      } catch {
        setRunningJobs(0)
        setQueuedJobs(0)
        setGenMap({})
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => clearInterval(timer)
  }, [load])
  useEffect(() => {
    const h = () => { void frame.reload(); void load() }
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [frame, load])

  const reviewEvents = (rec?.events ?? []).filter(e => e.type === 'review' || e.type === 'overdue')
  const learnEvents = (rec?.events ?? []).filter(e => e.type !== 'review' && e.type !== 'overdue')
  const dueCards = reviewQ?.cards ?? []

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

  // 推荐卡便捷生成：入队全局队列（后台按序执行），卡片随轮询转为「排队中/生成中」
  const generateNode = async (e: RecEvent) => {
    try {
      const r = await api.generate(e.course, e.node)
      Message.success(r.message)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
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
      <ReviewBanner dueCount={reviewQ?.total ?? 0} onStart={() => setSession(dueCards)} />

      {/* 核心区：「接下来学/复习」推荐流——点开直接进学习视图 */}
      {frame.tree && frame.tree.courses.length === 0 ? (
        <Empty description='还没有课程。点右上角「生成新课程」看引导，然后在 dsh 对话里让 agent 按技能建课。' />
      ) : (rec && (reviewEvents.length + learnEvents.length) > 0 ? (
        <Card size='small' title='接下来' style={{ borderRadius: 10 }}>
          <Space direction='vertical' style={{ width: '100%' }} size={10}>
            {[...reviewEvents, ...learnEvents].sort((a, b) =>
              (REC_TYPE[a.type]?.order ?? 9) - (REC_TYPE[b.type]?.order ?? 9)).map((e, i) => (
                <RecCard key={i} e={e} gen={genMap[`${e.course}/${e.node}`]}
                  onOpen={() => frame.openLesson(e.course, e.node)}
                  onSkip={() => void skipNode(e)}
                  onGenerate={() => void generateNode(e)} />
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
                  const q = dueCards.filter(card => card.course === c.name)
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
          <Text>{runningJobs} 个正文生成中{queuedJobs > 0 ? ` · ${queuedJobs} 个排队` : ''}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}>点击查看</Text>
        </div>
      )}
    </Space>
  )
}
