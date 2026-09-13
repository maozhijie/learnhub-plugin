/** 复习刷卡会话（Anki 式扁平队列，页内子组件）：一卡一票——正面作答或满 5 秒申报忘记
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
import { Alert, Button, Card, Message, Modal, Space, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import QuestionCard, { type AnswerOutcome, type JolPick, toOutcome } from './QuestionCard'
import LearnerCardCard from './LearnerCardCard'
import ErrorCardCard from './ErrorCardCard'
import { nextBand, pickNext } from '../../../src/engine/adaptive'
import { api } from '../api'
import { errorMessage } from '../hooks/useCommand'
import type { QueueCard, ReviewCard } from '../types'

const { Text, Title } = Typography

/** 我的卡卡面标签（与 LearnerCardCard 的 KIND_LABEL 同源；会话头部消费）。 */
const LEARNER_KIND_LABEL: Record<string, string> = {
  recall_cue: '提示重述', cloze_rewrite: '挖空重述', self_explain: '自注讲解',
}

export default function ReviewSession(props: {
  queue: QueueCard[]
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
  const [pending, setPending] = useState<QueueCard[]>(props.queue)
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
      Message.error(errorMessage(err))
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
      Message.error(errorMessage(err))
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome])

  /** 背面附加件：自评三按钮（挂起）/ 已推进说明 / Again 明天再见。 */
  const footer = (oc: AnswerOutcome): ReactNode => {
    if (oc.pendingRating && oc.previews) {
      return (
        <div className='lh-gap-8 lh-end lh-row lh-wrap'>
          <Text type='secondary' className='lh-t-12'>记得多牢？自评推进调度（快捷键 2/3/4）</Text>
          <Button size='small' onClick={() => void rate(2)}>Hard · {oc.previews!.hard}</Button>
          <Button size='small' type='primary' onClick={() => void rate(3)}>Good · {oc.previews!.good}</Button>
          <Button size='small' status='success' onClick={() => void rate(4)}>Easy · {oc.previews!.easy}</Button>
        </div>
      )
    }
    if (oc.correct === true) {
      // 队列快照后该题被练习流答过（当日调度已推进）：无自评可出，仅记录并继续
      return (
        <div className='lh-gap-8 lh-end lh-row'>
          <Text type='secondary' className='lh-t-12'>今日已在学习中推进过调度，本次仅记录</Text>
          <Button size='small' type='primary' onClick={next}>下一张</Button>
        </div>
      )
    }
    if (oc.correct === false) {
      return (
        <div className='lh-gap-8 lh-end lh-row'>
          <Text type='secondary' className='lh-t-12'>
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
      <Modal title='复习完成' visible footer={null} unmountOnExit className='lh-w-480'
        onCancel={() => { void finish() }}>
        <Space direction='vertical' className='lh-full' size={14}>
          <Card size='small' className='lh-card'>
            <Space direction='vertical' size={6}>
              <Title heading={6} className='lh-m-0'>本轮复习 {total} 张</Title>
              <Text type='secondary'>
                答对 {tally.right}（Hard {tally.hard} / Good {tally.good} / Easy {tally.easy}）
                · 忘记 {tally.forgot} · 答错 {tally.wrong}
              </Text>
              <Text type='secondary' className='lh-t-12'>
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
      onCancel={() => { void finish() }} className='lh-w-680'>
      <Space direction='vertical' className='lh-full' size={12}>
        <Space size={8} wrap>
          <Text type='secondary'>{card.course} · </Text>
          {/* V-4（#108）：笔记源卡显示来源笔记标题（node 是机器 id，对学习者无意义），
          并给 obsidian:// 跳转——绝对路径由 Obsidian 自解析所属 vault */}
          <Text bold>{card.source === 'note' ? (card.title ?? card.node) : card.node}</Text>
          {card.source === 'note' && card.source_abs && (
            <Tooltip content={`在 Obsidian 中打开来源笔记：${card.source_path ?? ''}`}>
              <a href={`obsidian://open?path=${encodeURIComponent(card.source_abs)}`}
                className='lh-t-12 lh-no-underline'>↗ 来源笔记</a>
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
        <div className='lh-row lh-gap-8 lh-wrap'>
          {answeredOnce || !bandRowOpen ? (
            <>
              <Tag size='small' color='gold'>难度带：{BAND_LABEL[bandPref]}</Tag>
              {!answeredOnce && (
                <Button size='mini' type='text' onClick={() => setBandRowOpen(true)}>调整</Button>
              )}
            </>
          ) : (
            <>
              <Text type='secondary' className='lh-t-12'>难度带</Text>
              <Space size={4}>
                {(['easy', 'standard', 'hard'] as const).map(b => (
                  <Button key={b} size='mini' type={bandPref === b ? 'primary' : 'outline'}
                    onClick={() => setBandPref(b)}>{BAND_LABEL[b]}</Button>
                ))}
                <Text type='secondary' className='lh-t-12'>挑战抬高目标带、简单放宽；答错仍会自动降回</Text>
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
              <div className='lh-flex lh-end'>
                <Button type='primary' size='small' onClick={next}>下一张</Button>
              </div>
            )}
          </>
        ) : card.learner ? (
          <LearnerCardCard key={`${card.course}/${card.learner.node}/${card.learner.id}`}
            card={card.learner} onRate={rate} onForget={learnerForget} />
        ) : (
/* 骨架卡在上方 error/learner 两分支消费；走到这里 = 题卡 */
          <QuestionCard key={card.id} course={card.course} node={card.node} question={card as ReviewCard}
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
