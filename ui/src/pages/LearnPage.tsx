/** 学习页（主界面）：XP 时间账本条 + 复习横幅 + 「接下来学/复习」
 * 推荐流（点开直接进 LessonView）+ 课程卡（次要区）。二级视图 LessonView 承载
 * 正文/mastery 会话/完成。复习会话 = Anki 式刷卡队列：跨课程到期卡扁平排队，
 * 一卡一票（作答或满 5 秒申报忘记），背面自评 Hard/Good/Easy 推进调度；
 * 我的卡（E1）按 ADR-0021 汇入同一队列——按卡种分面：题卡走作答+AI 判卷，
 * 自注卡走 重述 → 翻面对照 → 自评（无绑定 XP，只计总账不进课程/节点账）。
 * 「今天学它」pin 不设界面入口（对话经 agent 工具 learnhub_pin_today 设置，
 * pinned 行仍显「你选了它」置顶标识）。
 * #72 UI 入口补全：横幅区挂 C1 笔记源抽屉 / C2 导出到 Anki / E1 我的卡管理，
 * 推荐卡渲染 A3 定向复习建议项（一键进目标节点刷卡），复习卡头部带 A1 可回忆度读数。 */
import {
  Alert, Button, Card, Drawer, Empty, Input, Message, Modal, Popconfirm, Progress, Space,
  Tag, Tooltip, Typography,
} from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import LessonView from '../components/LessonView'
import { isActiveTab } from '../active-tab'
import QuestionCard, { type AnswerOutcome, type JolPick, toOutcome } from '../components/QuestionCard'
import LearnerCardCard from '../components/LearnerCardCard'
import ErrorCardCard from '../components/ErrorCardCard'
import { nextBand, pickNext } from '../../../src/engine/adaptive'
import { api } from '../api'
import type { AppFrame } from '../App'
import type {
  AdviceItem, AnkiStatusDoc, DiagnosticEntry, LearnerCardItem, LearnerQueueDoc,
  NoteSourceDoc, QuestionItem, RecEvent, RecommendDoc, ReviewCard, ReviewQueueDoc, XpStatus,
} from '../types'

const { Text, Title } = Typography

/** 我的卡卡面标签（与 LearnerCardCard 的 KIND_LABEL 同源；会话头部消费）。 */
const LEARNER_KIND_LABEL: Record<string, string> = {
  recall_cue: '提示重述', cloze_rewrite: '挖空重述', self_explain: '自注讲解',
}

const REC_TYPE: Record<string, { label: string; color: string; order: number }> = {
  pin: { label: '今天学它', color: 'gold', order: 0 },
  overdue: { label: '逾期', color: 'red', order: 1 },
  review: { label: '复习', color: 'green', order: 2 },
  diagnostic: { label: '内容诊断', color: 'magenta', order: 3 },
  learning: { label: '继续学', color: 'arcoblue', order: 4 },
  new: { label: '新学', color: 'cyan', order: 5 },
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

/** 复习横幅：到期卡驱动（复习队列张数 + 开始复习）——队列已并入我的卡（ADR-0021），
 * 张数为题卡+自注卡合计。C2（#63/#72）：「导出到 Anki」按钮——把 vault 到期卡推送进
 * 桌面 Anki 的镜象卡组（AnkiConnect 未达也可点，引擎 fail loud 带指引）；按钮计数 =
 * Anki 通道当前到期分布（不含我的卡，ADR-0021 测量面不扩）。笔记源状态行（C1 #59/#72）：
 * 漂移 = 重新出题/归档旧题直达；挂起 = 重新注册。「我的卡管理」入口常驻（E1 #70）。
 * 动作全部面板内完成，不再只提示「去 dsh 里对 agent 说」。 */
function ReviewBanner({ reviewQ, anki, onStart, onExportAnki, exporting, onOpenSources, onRegenerateSource, onReregister, onManage, onMineErrors, mining }: {
  reviewQ: ReviewQueueDoc | null
  anki: AnkiStatusDoc | null
  onStart: () => void
  onExportAnki: () => void
  exporting: boolean
  onOpenSources: (focusId?: string) => void
  onRegenerateSource: (id: string) => void
  onReregister: (path: string) => void
  onManage: () => void
  onMineErrors: () => void
  mining: boolean
}) {
  const dueCount = reviewQ?.total ?? 0
  const drifted = reviewQ?.note_drifted ?? []
  const suspended = reviewQ?.note_suspended ?? []
  const ankiDue = anki?.due.total
  const ankiOffline = anki?.anki != null && !anki.anki.connected
  return (
    <Card size='small' style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>待复习</Text>
          <Text style={{ fontSize: 20, fontWeight: 600 }}>{dueCount}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}> 张卡到期</Text>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button type='primary' onClick={onStart} disabled={dueCount === 0}>
            开始复习（{dueCount}）
          </Button>
          <Tooltip content={ankiOffline
            ? `未连上 AnkiConnect：${anki?.anki?.error ?? '桌面 Anki 未打开'}`
            : '把到期卡推送到桌面 Anki 的 learnhub 卡组（Anki 纯作答通道，调度仍在 vault）'}>
            <Button onClick={onExportAnki} loading={exporting} status={ankiOffline ? 'warning' : 'default'}>
              导出到 Anki{typeof ankiDue === 'number' ? `（${ankiDue}）` : ''}
            </Button>
          </Tooltip>
          <Button onClick={() => onOpenSources()}>笔记源</Button>
          <Tooltip content='从你的错答流水挖高频错误模式，生成「三选一，其中一项是你的错法」辨别卡进复习队列（C-3）'>
            <Button onClick={onMineErrors} loading={mining}>挖错误卡</Button>
          </Tooltip>
          <Button onClick={onManage}>我的卡管理</Button>
        </div>
      </div>
      {(drifted.length > 0 || suspended.length > 0) && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {drifted.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text type='warning' style={{ fontSize: 12, flex: 1, minWidth: 220 }}>
                笔记源「{d.id}」{d.hint}
              </Text>
              <Popconfirm
                title='按笔记当前内容重新出题？'
                content='出题即确认当前内容（漂移清除）；旧题保留，可在笔记源抽屉里逐题归档。'
                onOk={() => onRegenerateSource(d.id)}>
                <Button size='mini' type='text'>重新出题</Button>
              </Popconfirm>
              <Button size='mini' type='text' onClick={() => onOpenSources(d.id)}>归档旧题</Button>
            </div>
          ))}
          {suspended.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text type='error' style={{ fontSize: 12, flex: 1, minWidth: 220 }}>
                笔记源「{s.id}」{s.reason}
              </Text>
              <Tooltip content={`按原路径重新注册：${s.path}`}>
                <Button size='mini' type='text' onClick={() => onReregister(s.path)}>重新注册</Button>
              </Tooltip>
              <Button size='mini' type='text' status='danger' onClick={() => onOpenSources(s.id)}>管理笔记源</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 推荐流大卡片：点开直接进 LessonView——主界面的核心动作；内联跳过（已有基础免学）。
 * 内容三态标识：已生成（点开有东西读）/ 生成中 / 排队中；未生成节点主按钮让给「生成内容」。
 * 「今天学它」pin 无界面入口（对话走 agent 工具设置）：pinned 事件只带「你选了它」
 * 置顶标识，不给取消按钮（取消 = 对 agent 说，或次日自动失效）。
 * 事件携带 diagnostics（B1 #69）时内联「重写此节」直达动作——Popconfirm 确认后才走
 * 单节重写管线（诊断建议先行，不自动动库）。
 * 事件携带 advice（A3 #54/#55，#72 UI 挂接）时内联「定向复习」直达——软闸弱前置 /
 * enc 成分技能的到期题一键进目标节点刷卡会话（建议先行，不拦直接学）。 */
function RecCard({ e, gen, onOpen, onSkip, onGenerate, onAdvice }: {
  e: RecEvent
  gen?: 'queued' | 'running'
  onOpen: () => void
  onSkip: () => void
  onGenerate: () => void
  onAdvice: (a: AdviceItem) => void
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
          {e.pinned && <Tag size='small' color='gold'>你选了它</Tag>}
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
          {e.intention && (
            <Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 2, color: 'var(--color-gold-6, #d48806)' }}>
              计划：在「{e.intention.cue}」之后，{e.intention.action}
            </Text>
          )}
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
      {e.advice?.length ? (
        <div onClick={ev => ev.stopPropagation()} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {e.advice.map(a => (
            <div key={a.node} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '6px 10px',
            }}>
              <Tag size='small' color='orange'>建议先复习</Tag>
              <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
                先复习「{a.node}」的 {a.due} 道到期题（当前可回忆度 {Math.round(a.r * 100)}%）再回来继续
              </Text>
              <Tooltip content='一键进入该节点的定向复习会话（单节点自适应排序）'>
                <Button size='mini' type='text' onClick={() => onAdvice(a)}>定向复习</Button>
              </Tooltip>
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
 * 我的卡（E1，ADR-0021）同队列同会话，按卡种分面：自注卡走 重述 → 翻面对照 →
 * 自评（LearnerCardCard，卡面自带 5 秒忘记门控与 2/3/4 快捷键），结算走
 * learner-rate/learner-forget——无绑定 XP（只计总账，不进课程/节点账）。
 * 单节点「已调度题」会话（#57 A1）：按目标难度带流式选题——起点先验取引擎在
 * 定向队列响应里给出的节点 Mastery 先验带，连续答对 ≥2 次升一档、答错/忘记
 * 降回基础题；多节点/全局会话维持快照序不变。
 * E5 难度带（#65）：会话开始时可选 简单/标准/挑战（参与式、可忽略、默认标准 =
 * 纯 A1），作为带权偏好随定向队列请求下发；会话结束把带选择与作答结算落日志
 * （困难教练数据源），并拉一次教练反馈附在小结里（只读信息性，无门禁）。
 * E4 JOL（#66）：抽查命中的题卡（jol 标记）在翻面前弹一档预测，随作答/忘记上报。 */
function ReviewSession(props: {
  queue: ReviewCard[]
  /** Self-Calibration 过信轻提示（ADR-0022 #104）：队列载荷 calibration_hint 透传，
   * 在 JOL 预测出口非阻断展示一句；提示全局关或未检出时为空。 */
  calibrationHint?: string
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
  // E5 难度带（#65）：会话开始的显式选择（默认标准 = 纯 A1）；参与式可关闭——
  // 收起即视为标准、不再打扰，首答后锁定为会话带
  const [bandPref, setBandPref] = useState<'easy' | 'standard' | 'hard'>('standard')
  const [bandRowOpen, setBandRowOpen] = useState(true)
  const [answeredOnce, setAnsweredOnce] = useState(false)
  // 按课程/节点的作答结算（会话结束落难度带日志的原料）
  const groupTally = useRef(new Map<string, { answered: number; correct: number }>())
  // 会话结束反馈点：教练的只读信息性反馈（低数据为空）
  const [coachMsgs, setCoachMsgs] = useState<string[]>([])
  useEffect(() => {
    if (!singleNode || answeredOnce) return
    const head = props.queue[0]
    if (!head) return
    api.reviewQueue(head.course, head.node, bandPref).then(doc => {
      if (!doc.cards.length || doc.band === undefined) return
      setAdaptive(true)
      setPending(doc.cards)
      setTotal(doc.cards.length)
      setBand(doc.band)
      setBase(doc.band)
    }).catch(() => { /* 拉不到先验：按快照序走 */ })
  // 难度带改变 / 首答前重取先验即可；首答后由本组件内作答驱动
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandPref, answeredOnce])
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
    setAnsweredOnce(true)
    if (card) {
      const key = `${card.course}/${card.node}`
      const g = groupTally.current.get(key) ?? { answered: 0, correct: 0 }
      g.answered++
      if (oc.correct === true) g.correct++
      groupTally.current.set(key, g)
    }
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

  /** 自评结算：挂起调度按选中档位落盘，选完即翻下一张。我的卡走 learner-rate
   * （无绑定 XP 在引擎侧落 journal 行，ADR-0021），题卡走 question-rate。 */
  const rate = async (r: 2 | 3 | 4) => {
    if (!card) return
    try {
      if (card.learner) await api.learnerRate(card.learner.course, card.learner.node, card.learner.id, r)
      else await api.questionRate(card.course, card.node, card.id, r)
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

  /** 错误对比卡三选一作答（C-3 #82）：引擎自动判分结算（选对=3/选错=1，一卡一天
   * 一次，无绑定 XP）；揭晓面（答案/错法/解析）随响应返回给卡面对照展示。 */
  const answerError = async (choice: string) => {
    if (!card?.error) throw new Error('没有当前卡')
    const r = await api.errorAnswer(card.error.course, card.error.node, card.error.id, choice)
    setAnsweredOnce(true)
    setTally(t => r.correct ? { ...t, right: t.right + 1 } : { ...t, wrong: t.wrong + 1 })
    setOutcome({ correct: r.correct, judge: 'error', answer: r.answer, explanation: r.explanation })
    props.onSettled()
    return { correct: r.correct, answer: r.answer, mine: r.mine, explanation: r.explanation }
  }

  /** 我的卡忘记申报（rating 1 推进，0 XP；5 秒门控在 LearnerCardCard 卡面内）。 */
  const learnerForget = async () => {
    if (!card?.learner) return
    try {
      await api.learnerForget(card.learner.course, card.learner.node, card.learner.id)
      setTally(t => ({ ...t, forgot: t.forgot + 1 }))
      next()
      props.onSettled()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const forget = (elapsedS: number, predicted?: JolPick): Promise<AnswerOutcome> => {
    if (!card) return Promise.reject(new Error('没有当前卡'))
    return api.questionForget(card.course, card.node, card.id, elapsedS, predicted).then(toOutcome)
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

  // 会话结束反馈点（#65/#66）：落难度带会话日志（按课程/节点分组）+ 拉一次教练反馈
  useEffect(() => {
    if (!done) return
    for (const [key, g] of groupTally.current) {
      if (g.answered <= 0) continue
      const [course, node] = key.split('/')
      api.bandSession(course!, node!, bandPref, g.answered, g.correct).catch(() => { /* 日志失败不打扰 */ })
    }
    api.coach().then(r => setCoachMsgs(r.messages)).catch(() => {})
  // 收尾只跑一次（done 边沿）；bandPref 是收尾时的会话带
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done])

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
                忘记与答错的卡明天到期再见；逐题流水与 XP 已实时入账——我的卡走无绑定
                XP（只计总账，不进课程/节点账）。
              </Text>
            </Space>
          </Card>
          {coachMsgs.length > 0 && (
            <Alert type='info' content={coachMsgs.map(m => <div key={m}>{m}</div>)} />
          )}
          <Button type='primary' long onClick={() => { void finish() }}>完成</Button>
        </Space>
      </Modal>
    )
  }

  const BAND_LABEL: Record<'easy' | 'standard' | 'hard', string> = { easy: '简单', standard: '标准', hard: '挑战' }

  return (
    <Modal title={`复习 ${(adaptive ? total - pending.length : idx) + 1}/${total}`} visible footer={null} unmountOnExit
      onCancel={() => { void finish() }} style={{ width: 680 }}>
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <Space size={8} wrap>
          <Text type='secondary'>{card.course} · </Text>
          {/* V-4（#108）：笔记源卡显示来源笔记标题（node 是机器 id，对学习者无意义），
          并给 obsidian:// 跳转——绝对路径由 Obsidian 自解析所属 vault */}
          <Text bold>{card.source === 'note' ? (card.title ?? card.node) : card.node}</Text>
          {card.source === 'note' && card.source_abs && (
            <Tooltip content={`在 Obsidian 中打开来源笔记：${card.source_path ?? ''}`}>
              <a href={`obsidian://open?path=${encodeURIComponent(card.source_abs)}`}
                style={{ fontSize: 12, textDecoration: 'none' }}>↗ 来源笔记</a>
            </Tooltip>
          )}
          {card.learner && <Tag size='small' color='purple'>{LEARNER_KIND_LABEL[card.learner.kind] ?? card.learner.kind}</Tag>}
          {card.error && <Tag size='small' color='orange'>错误对比卡</Tag>}
          {/* A1（#56/#72）：随卡下发的 FSRS 预测可回忆度 R——用词遵守 CONTEXT（可回忆度，不是掌握度）；
          未调度新卡（我的卡首刷）无 due 无 R，不显示 */}
          {card.due && typeof card.r === 'number' && (
            <Tooltip content='FSRS 预测的当前可回忆度（不是掌握度）'>
              <Tag size='small' color={card.r >= 0.8 ? 'green' : card.r >= 0.5 ? 'orange' : 'red'}>
                可回忆度 {Math.round(card.r * 100)}%
              </Tag>
            </Tooltip>
          )}
          {card.due
            ? <Tag size='small' color='green'>到期 {card.due}</Tag>
            : <Tag size='small' color='orange'>未调度 · 首刷</Tag>}
          <Tag size='small'>做过 {card.attempts} 次</Tag>
        </Space>
        {/* E5 难度带（#65）：会话开始的选择入口——参与式、可关闭（收起 = 标准纯 A1）；
        首答后锁定为会话带（A1 带权偏好只在会话起点生效） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {answeredOnce || !bandRowOpen ? (
            <>
              <Tag size='small' color='gold'>难度带：{BAND_LABEL[bandPref]}</Tag>
              {!answeredOnce && (
                <Button size='mini' type='text' onClick={() => setBandRowOpen(true)}>调整</Button>
              )}
            </>
          ) : (
            <>
              <Text type='secondary' style={{ fontSize: 12 }}>难度带</Text>
              <Space size={4}>
                {(['easy', 'standard', 'hard'] as const).map(b => (
                  <Button key={b} size='mini' type={bandPref === b ? 'primary' : 'outline'}
                    onClick={() => setBandPref(b)}>{BAND_LABEL[b]}</Button>
                ))}
                <Text type='secondary' style={{ fontSize: 12 }}>挑战抬高目标带、简单放宽；答错仍会自动降回</Text>
                <Button size='mini' type='text' onClick={() => setBandRowOpen(false)}>收起</Button>
              </Space>
            </>
          )}
        </div>
        {card.error ? (
          <>
            <ErrorCardCard key={`${card.course}/${card.error.node}/${card.error.id}`}
              card={card.error} onAnswer={answerError} />
            {outcome && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type='primary' size='small' onClick={next}>下一张</Button>
              </div>
            )}
          </>
        ) : card.learner ? (
          <LearnerCardCard key={`${card.course}/${card.learner.node}/${card.learner.id}`}
            card={card.learner} onRate={rate} onForget={learnerForget} />
        ) : (
          <QuestionCard key={card.id} course={card.course} node={card.node} question={card}
            variant='review' noRedo jolAsk={card.jol === true}
            calibrationHint={props.calibrationHint}
            submitter={(payload, elapsedS, predicted) => api.questionAnswer(
              card.course, card.node, card.id, payload, elapsedS,
              { deferSchedule: true, predicted }).then(toOutcome)}
            onForget={forget}
            footer={footer}
            onDone={handleDone} />
        )}
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

/** 笔记源抽屉（C1 #59，#72 UI 挂接）：源清单 + 注册/解除注册/出题 + 旧题逐题归档。
 * 从学习页复习横幅区进入；漂移提示的「归档旧题」跳进来并展开对应源的旧题清单。 */
function NoteSourceDrawer(props: { open: boolean; focusId: string | null; onClose: () => void; onChanged: () => void }) {
  const [doc, setDoc] = useState<NoteSourceDoc | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [oldQs, setOldQs] = useState<QuestionItem[] | null>(null)
  /** 缺失源的重连新路径（V-6 #109，按源 id 分格）。 */
  const [relinkPaths, setRelinkPaths] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setDoc(await api.noteSources().catch(() => null))
  }, [])
  useEffect(() => {
    if (props.open) {
      setExpanded(props.focusId)
      setOldQs(null)
      void load()
      if (props.focusId) void expandQuestions(props.focusId)
    }
  // focusId 变化（横幅「归档旧题」直达）时重新定位；load 稳定
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.focusId])

  /** 拉某源的旧题清单（笔记源伪课程走 /questions 同通道，不含答案）。 */
  const expandQuestions = async (id: string) => {
    try {
      const r = await api.questions('笔记源', id)
      setOldQs(r.questions)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleExpand = (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      setOldQs(null)
      return
    }
    setExpanded(id)
    setOldQs(null)
    void expandQuestions(id)
  }

  const register = async () => {
    if (!path.trim()) { Message.warning('填写笔记或文件夹路径（vault 相对或绝对）'); return }
    setBusy(true)
    try {
      const r = await api.noteSourceRegister(path.trim())
      Message.success(r.registered === 0 && r.updated > 0
        ? `已恢复注册（${r.updated} 篇，路径未变）`
        : `已注册 ${r.registered} 篇${r.updated ? `、恢复 ${r.updated} 篇` : ''}${r.skipped ? `、跳过 ${r.skipped} 篇（学习中心内部）` : ''}`)
      setPath('')
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const generate = async (id: string) => {
    setBusy(true)
    try {
      const r = await api.noteSourceGenerate(id)
      Message.success(`「${id}」出题完成：新增 ${r.added} 题（旧题保留，可展开逐题归档），新卡明天起进复习队列`)
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const unregister = async (id: string) => {
    try {
      const r = await api.noteSourceUnregister(id)
      Message.success(`已解除「${r.removed}」的注册（你的笔记文件未动）`)
      if (expanded === id) { setExpanded(null); setOldQs(null) }
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const archiveOne = async (id: string, qid: string) => {
    try {
      await api.questionArchive('笔记源', id, qid, true)
      Message.success(`已归档 ${qid}（不再进复习队列）`)
      if (expanded === id) await expandQuestions(id)
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** 改路径重连（V-6 #109）：源缺失（改名/移动）时把既有源重连到新路径——
   * 卡池与每张卡的调度保留（区别于解除后重注册：旧卡不会变孤儿）。 */
  const relink = async (id: string) => {
    const p = (relinkPaths[id] ?? '').trim()
    if (!p) { Message.warning('填写改名/移动后的新路径（vault 相对或绝对）'); return }
    try {
      const r = await api.noteSourceRelink(id, p)
      Message.success(`「${r.id}」已重连到 ${r.to}（卡池与调度保留）`)
      setRelinkPaths(m => ({ ...m, [id]: '' }))
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const STATUS: Record<string, { label: string; color: string }> = {
    ok: { label: '正常', color: 'green' },
    drifted: { label: '漂移', color: 'orange' },
    missing: { label: '缺失', color: 'red' },
    inconsistent: { label: '镜象不一致', color: 'purple' },
  }

  return (
    <Drawer width={560} visible={props.open} footer={null} unmountOnExit
      title='笔记源（个人笔记 → 复习题）' onCancel={props.onClose}>
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        <Alert type='info' style={{ fontSize: 12 }}
          content='注册 vault 里的笔记（单篇 .md 或整个文件夹）：引擎只读笔记来出复习题，永不改动笔记本身；到期卡进复习队列（课程列显示「笔记源」）。' />
        <Space size={8} style={{ width: '100%' }}>
          <Input value={path} onChange={setPath} placeholder='笔记或文件夹路径（vault 相对/绝对）' style={{ flex: 1 }}
            onPressEnter={() => void register()} />
          <Button type='primary' loading={busy} onClick={() => void register()}>注册</Button>
        </Space>
        {doc === null ? (
          <Text type='secondary'>加载中…</Text>
        ) : doc.sources.length === 0 ? (
          <Empty description='还没有笔记源：填上方路径注册一篇笔记试试' />
        ) : (
          doc.sources.map(s => {
            const st = STATUS[s.status] ?? { label: s.status, color: 'gray' }
            return (
              <Card size='small' key={s.id} style={{ borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Tag size='small' color={st.color}>{st.label}</Tag>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text style={{ fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || s.path}
                    </Text>
                    <Text type='secondary' style={{ fontSize: 12 }}>
                      {s.id} · {s.cards} 张卡{s.due > 0 ? `（到期 ${s.due}）` : ''}
                    </Text>
                  </div>
                  <Popconfirm title='按笔记当前内容出题？'
                    content='出题即确认当前内容（漂移清除）；旧题保留，可展开逐题归档。'
                    onOk={() => void generate(s.id)}>
                    <Button size='mini' type='primary' loading={busy}>出题</Button>
                  </Popconfirm>
                  {s.cards > 0 && (
                    <Button size='mini' onClick={() => toggleExpand(s.id)}>{expanded === s.id ? '收起旧题' : '旧题管理'}</Button>
                  )}
                  <Popconfirm title={`解除注册「${s.title || s.id}」？`}
                    content='移除注册与镜象题库；你的笔记文件不受影响。'
                    onOk={() => void unregister(s.id)}>
                    <Button size='mini' type='text' status='danger'>解除注册</Button>
                  </Popconfirm>
                </div>
                {s.hint && (
                  <Text type={s.status === 'missing' ? 'error' : 'warning'} style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                    {s.hint}
                  </Text>
                )}
                {s.status === 'missing' && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                    <Input size='mini' value={relinkPaths[s.id] ?? ''} onChange={v => setRelinkPaths(m => ({ ...m, [s.id]: v }))}
                      placeholder='改名/移动后的新路径（重连保留卡池与调度）'
                      onPressEnter={() => void relink(s.id)} />
                    <Button size='mini' type='outline' onClick={() => void relink(s.id)}>重连</Button>
                  </div>
                )}
                {expanded === s.id && (
                  <div style={{ marginTop: 8, borderTop: '1px solid var(--color-border-2,#e5e6eb)', paddingTop: 8 }}>
                    {oldQs === null ? <Text type='secondary' style={{ fontSize: 12 }}>加载中…</Text>
                      : oldQs.length === 0 ? <Text type='secondary' style={{ fontSize: 12 }}>没有在库旧题（都已归档；出题可补充新卡）</Text>
                        : oldQs.map(q => (
                          <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                            <Tag size='small' color='gray'>{q.id}</Tag>
                            <Text style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.q}</Text>
                            <Popconfirm title={`归档「${q.id}」？`}
                              content='归档后不再进复习队列（笔记内容更新后重出题即可替换）。'
                              onOk={() => void archiveOne(s.id, q.id)}>
                              <Button size='mini' type='text' status='warning'>归档</Button>
                            </Popconfirm>
                          </div>
                        ))}
                  </div>
                )}
              </Card>
            )
          })
        )}
      </Space>
    </Drawer>
  )
}

/** 「我的卡」管理抽屉（E1 #70，#72 UI 挂接）：自注卡清单 + 归档/恢复。
 * 队列只回在库卡：「本次已归档」清单挂在学习页会话级（关闭抽屉再开仍可恢复，
 * 页面刷新后归档历史在卡文件里留档，恢复走引擎侧）。 */
function LearnerCardManager(props: {
  open: boolean
  onClose: () => void
  onChanged: () => void
  /** 本次学习页会话里刚归档的卡（恢复入口的清单）。 */
  archived: LearnerCardItem[]
  onArchivedChange: (list: LearnerCardItem[]) => void
}) {
  const [q, setQ] = useState<LearnerQueueDoc | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setQ(await api.learnerQueue().catch(() => null))
  }, [])
  useEffect(() => {
    if (props.open) void load()
  }, [props.open, load])

  const toggleArchive = async (card: LearnerCardItem, flag: boolean) => {
    setBusy(true)
    try {
      await api.learnerArchive(card.course, card.node, card.id, flag)
      if (flag) {
        props.onArchivedChange([...props.archived, card])
        Message.success(`已归档「${card.id}」（不再进我的卡队列）`)
      } else {
        props.onArchivedChange(props.archived.filter(c => !(c.course === card.course && c.node === card.node && c.id === card.id)))
        Message.success(`已恢复「${card.id}」`)
      }
      await Promise.all([load(), props.onChanged()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const kindLabel = (k: string) => ({ recall_cue: '再讲一遍', cloze_rewrite: '挖空重述', self_explain: '自注讲解' })[k] ?? k

  return (
    <Drawer width={560} visible={props.open} footer={null} unmountOnExit
      title='我的卡管理（你自己的理解卡）' onCancel={props.onClose}>
      <Space direction='vertical' style={{ width: '100%' }} size={10}>
        <Alert type='info' style={{ fontSize: 12 }}
          content='归档后卡片不再进「我的卡」队列，历史保留在卡文件里；本次学习页会话里归档的卡可在此恢复。' />
        {q === null ? <Text type='secondary'>加载中…</Text>
          : q.cards.length === 0 ? <Empty description='没有在库卡：在节学习页「加我的理解」，或把「讲给我听」的讲稿存档' />
            : q.cards.map(c => (
              <div key={`${c.course}/${c.node}/${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Tag size='small' color='arcoblue'>{kindLabel(c.kind)}</Tag>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.prompt}</Text>
                  <Text type='secondary' style={{ fontSize: 12 }}>
                    {c.node} · {c.due ? `到期 ${c.due}` : '未调度'} · 做过 {c.attempts} 次
                  </Text>
                </div>
                <Popconfirm title='归档这张卡？'
                  content='归档后不再进「我的卡」队列；可在本抽屉立即恢复。'
                  onOk={() => void toggleArchive(c, true)}>
                  <Button size='mini' type='text' status='warning' disabled={busy}>归档</Button>
                </Popconfirm>
              </div>
            ))}
        {props.archived.length > 0 && (
          <>
            <Text type='secondary' style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>本次已归档（可恢复）</Text>
            {props.archived.map(c => (
              <div key={`archived-${c.course}/${c.node}/${c.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: 0.7 }}>
                <Tag size='small'>{kindLabel(c.kind)}</Tag>
                <Text type='secondary' style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.prompt}</Text>
                <Button size='mini' type='text' disabled={busy} onClick={() => void toggleArchive(c, false)}>恢复</Button>
              </div>
            ))}
          </>
        )}
      </Space>
    </Drawer>
  )
}

export default function LearnPage({ frame }: { frame: AppFrame }) {
  const [rec, setRec] = useState<RecommendDoc | null>(null)
  const [xp, setXp] = useState<XpStatus | null>(null)
  const [reviewQ, setReviewQ] = useState<ReviewQueueDoc | null>(null)
  const [session, setSession] = useState<ReviewCard[] | null>(null)
  // Self-Calibration 过信轻提示（ADR-0022 #104）：随会话启动的队列载荷带出
  const [calibrationHint, setCalibrationHint] = useState<string | undefined>(undefined)
  const [createVisible, setCreateVisible] = useState(false)
  const [runningJobs, setRunningJobs] = useState(0)
  const [queuedJobs, setQueuedJobs] = useState(0)
  /** #72 C2：Anki 通道状态（横幅导出按钮的到期计数与可达性提示）。 */
  const [anki, setAnki] = useState<AnkiStatusDoc | null>(null)
  const [exportingAnki, setExportingAnki] = useState(false)
  /** #72 C1/E1：笔记源抽屉（focusId = 横幅「归档旧题」直达定位）与我的卡管理抽屉。
   * recentArchived = 会话级「本次已归档」清单（E1 恢复入口；关抽屉再开不清空）。 */
  const [sourceDrawer, setSourceDrawer] = useState<{ open: boolean; focusId: string | null }>({ open: false, focusId: null })
  const [cardMgrOpen, setCardMgrOpen] = useState(false)
  const [recentArchived, setRecentArchived] = useState<LearnerCardItem[]>([])
  /** 排队/生成中的节点（course/node → 阶段），推荐卡三态标识消费。 */
  const [genMap, setGenMap] = useState<Record<string, 'queued' | 'running'>>({})

  const load = useCallback(async () => {
    setRec(await api.recommend(12).catch(() => null))
    setXp(await api.xp().catch(() => null))
    setReviewQ(await api.reviewQueue().catch(() => null))
    setAnki(await api.ankiStatus().catch(() => null))
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
    // 页签保活（ADR-0027）：非激活页签跳过取数，定时器只保留节拍；切回即补一次取数
    const onTabActive = (e: Event) => { if ((e as CustomEvent).detail === 'learn') void poll() }
    window.addEventListener('learnhub:tab', onTabActive)
    const timer = setInterval(() => { if (isActiveTab('learn')) void poll() }, 5000)
    return () => {
      clearInterval(timer)
      window.removeEventListener('learnhub:tab', onTabActive)
    }
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

  // C2 导出到 Anki（#63/#72）：横幅按钮直推到期卡（Anki 未开时引擎报错带指引）
  /** 挖错误卡（C-3 #82）：全局课程挖矿 → 生成错误对比卡进错误 deck（新卡随复习队列出现）。 */
  const [mining, setMining] = useState(false)
  const mineErrors = async () => {
    setMining(true)
    try {
      const r = await api.errorGenerate()
      const n = r.generated.reduce((s, g) => s + g.ids.length, 0)
      if (n > 0) Message.success(`已生成 ${n} 张错误对比卡，进入复习队列`)
      else Message.info('这次没有挖到新的高频错误模式')
    } catch (err) {
      Message.warning(err instanceof Error ? err.message : String(err))
    } finally {
      setMining(false)
      await Promise.all([frame.reload(), load()])
    }
  }

  const exportAnki = async () => {
    setExportingAnki(true)
    try {
      const r = await api.ankiExport()
      Message.success(`已推送到 Anki：新增 ${r.added} · 更新 ${r.updated} · 移除 ${r.removed}（到期 ${r.total} 张）`)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setExportingAnki(false)
    }
  }

  // C1 笔记源动作（#59/#72）：横幅提示行直达——漂移重新出题 / 缺失重新注册
  const regenerateSource = async (id: string) => {
    try {
      const r = await api.noteSourceGenerate(id)
      Message.success(`「${id}」已按当前内容出题：新增 ${r.added} 题（旧题保留，可在笔记源抽屉里归档）`)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }
  const reregisterSource = async (path: string) => {
    try {
      await api.noteSourceRegister(path)
      Message.success(`已恢复「${path}」的注册，卡池重新可用`)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  // A3 建议项直达（#54/#55/#72）：拉目标节点的定向复习队列，直接进刷卡会话
  //（单节点会话自动启用 A1 难度带自适应）
  const startAdviceReview = async (e: RecEvent, a: AdviceItem) => {
    try {
      const doc = await api.reviewQueue(e.course, a.node)
      if (!doc.cards.length) { Message.info(`「${a.node}」暂无到期题：可直接点开节点学习`); return }
      setCalibrationHint(doc.calibration_hint)
      setSession(doc.cards)
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
      <XpBar xp={xp ?? { date: '', day_cutoff: '', today_xp: 0, goal: 30, streak: 0, streak_grace_days: 1, eta: [] }}
        onEditGoal={() => frame.goto('stats')} />
      <ReviewBanner reviewQ={reviewQ} anki={anki}
        onStart={() => { setCalibrationHint(reviewQ?.calibration_hint); setSession(dueCards) }}
        onExportAnki={() => void exportAnki()} exporting={exportingAnki}
        onOpenSources={focusId => setSourceDrawer({ open: true, focusId: focusId ?? null })}
        onRegenerateSource={id => void regenerateSource(id)}
        onReregister={path => void reregisterSource(path)}
        onManage={() => setCardMgrOpen(true)}
        onMineErrors={() => void mineErrors()} mining={mining} />

      {/* 核心区：「接下来学/复习」推荐流——点开直接进学习视图 */}
      {frame.tree && frame.tree.courses.length === 0 ? (
        <Empty description='还没有课程。点右上角「生成新课程」看引导，然后在 dsh 对话里让 agent 按技能建课。' />
      ) : (rec && (reviewEvents.length + learnEvents.length) > 0 ? (
        <Card size='small' title='接下来' style={{ borderRadius: 10 }}>
          <Space direction='vertical' style={{ width: '100%' }} size={10}>
            {[...reviewEvents, ...learnEvents].sort((a, b) =>
              ((a.pinned ? 0 : 1) - (b.pinned ? 0 : 1))
              || ((REC_TYPE[a.type]?.order ?? 9) - (REC_TYPE[b.type]?.order ?? 9))).map((e, i) => (
                <RecCard key={i} e={e} gen={genMap[`${e.course}/${e.node}`]}
                  onOpen={() => frame.openLesson(e.course, e.node)}
                  onSkip={() => void skipNode(e)}
                  onGenerate={() => void generateNode(e)}
                  onAdvice={a => void startAdviceReview(e, a)} />
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
                  setCalibrationHint(reviewQ?.calibration_hint)
                  setSession(q)
                }}
                onDelete={() => deleteCourse(c.name)} />
            )
          })}
        </div>
      </Card>

      {session && session.length > 0 && (
        <ReviewSession queue={session} calibrationHint={calibrationHint}
          onClose={() => setSession(null)}
          onFinish={async () => { await Promise.all([frame.reload(), load()]) }}
          onSettled={load} />
      )}
      {createVisible && <CreateDialog visible={createVisible} onClose={() => setCreateVisible(false)} />}
      <NoteSourceDrawer open={sourceDrawer.open} focusId={sourceDrawer.focusId}
        onClose={() => setSourceDrawer({ open: false, focusId: null })} onChanged={load} />
      <LearnerCardManager open={cardMgrOpen} onClose={() => setCardMgrOpen(false)} onChanged={load}
        archived={recentArchived} onArchivedChange={setRecentArchived} />

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
