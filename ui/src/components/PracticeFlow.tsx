/** mastery 练习会话（Math Academy active learning loop），节序列驱动：
 * 节清单（manifest）存在时按节类型装配轮次——内容节 = 读节→做该节题（连对目标随
 * 组内题量收缩，基准 2、上限 5 题）；练习节 = 一等练习轮（无阅读，直接做题）；交互节 = 交互件轮
 * （沙箱 iframe 运行，达成目标上报成绩结算）。旧节点（无清单）回退标题匹配。
 * 题目按 section 绑定节 id（旧题回退节标题），未落节的题进通用收尾轮。
 * 顶部节进度 stepper（MathAcademy 式细条分段）：已过蓝条可点回跳、当前高亮、未到置灰。
 * 「上一步」按轮回看：一组问题视为一步，已过关的题组回看只展示小结；
 * 同一次学习里每道题只作答一次（重进题组自动定位到第一个未作答题）。
 * 瑕疵题申诉（ADR-0031）：判错结果态与单题菜单都可发起申诉；复核成立后的会话内
 * 判罚恢复——改判对恢复连对推进、作废/豁免按中性处理（连对不奖不罚、不占出题预算），
 * 作废链路顺带归档旧题并按申诉理由定向重出一题。 */
import { Alert, Button, Card, Message, Popconfirm, Space, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import MdView from './MdView'
import QuestionCard, { RevealCard, type AnswerOutcome } from './QuestionCard'
import QuestionMenu from './QuestionMenu'
import type { DisputeSettled } from './DisputeModal'
import { SettleContext } from './settle-context'
import { parseSectionTitle } from '../../../shared/content-renderers'
import { api } from '../api'
import { MAX_ASK_PER_ROUND, passStreakFor, QUIZ_SOFT_CAP } from './quiz-rules'
import type { LessonSection, QuestionItem, SectionManifestItem } from '../types'

const { Text, Title } = Typography

interface Round {
  key: string
  type: 'read' | 'quiz' | 'interactive'
  title: string
  typeLabel: string
  md?: string
  questions?: QuestionItem[]
  /** 交互节轮的节 id（SettleContext 上报结算用）。 */
  sectionId?: string
  /** 轮次所属节的类型（struggle 分支按轮类型隐藏「AI 再出题」，#117）。 */
  sectionType?: string
  /** 轮次所属节的定位（提意见重生成的定向节，#120）。 */
  sectionRef?: { id: string; title: string }
}

/** stepper 一步 = 一个节（read+quiz 成对并入）或通用收尾轮。 */
interface Step {
  key: string
  label: string
  start: number
  /** 该步的过关判据轮 key（无 quiz 轮的内容节以读完为准）。 */
  quizKey: string | null
}

/** 节标题归一化：剥类型前缀 + 去空白——AI 的 section 标注常有
 * 「概念：X」vs 正文「X」这类前缀/空白差异，精确匹配会漏题进综合轮。 */
function normSection(s: string): string {
  return parseSectionTitle(s).clean.replace(/\s+/g, '')
}

/** 节标题 → 展示名（剥「类型：」前缀，类型另由 Tag 表达）。 */
function cleanTitle(title: string): string {
  return parseSectionTitle(title).clean
}

/** 轮次计划：manifest 驱动节序列（练习节一等化、交互节轮），旧节点回退标题匹配；
 * 未落节的题收进「综合」quiz 轮。 */
function buildRounds(
  sections: LessonSection[], manifest: SectionManifestItem[] | null, questions: QuestionItem[],
): { rounds: Round[]; steps: Step[] } {
  const rounds: Round[] = []
  const steps: Step[] = []
  const mdByTitle = new Map(sections.map(s => [s.title, s.md]))
  const used = new Set<string>()
  const pushStep = (key: string, label: string, start: number, quizKey: string | null) => {
    steps.push({ key, label, start, quizKey })
  }
  if (manifest?.length) {
    for (const m of manifest) {
      const md = mdByTitle.get(m.title) ?? null
      // 绑节 id 优先（新管线），回退归一化标题（旧题 section=标题原文）
      const qs = questions.filter(q => q.section === m.id
        || (q.section != null && q.section !== '通用' && normSection(q.section) === normSection(m.title)))
      qs.forEach(q => used.add(q.id))
      const start = rounds.length
      const ref = { id: m.id, title: m.title }
      if (m.type === '交互') {
        if (md) rounds.push({ key: `ix:${m.id}`, type: 'interactive', title: cleanTitle(m.title), typeLabel: m.type, md, sectionId: m.id, sectionType: m.type, sectionRef: ref })
        pushStep(m.id, cleanTitle(m.title), start, null)
      } else if (m.type === '练习') {
        // 一等练习节：无阅读轮，直接做题；无题不出轮（出题后 questions 刷新重建轮次）
        if (qs.length) {
          rounds.push({ key: `quiz:${m.id}`, type: 'quiz', title: cleanTitle(m.title), typeLabel: m.type, questions: qs, sectionType: m.type, sectionRef: ref })
          pushStep(m.id, cleanTitle(m.title), start, `quiz:${m.id}`)
        }
      } else {
        if (md) rounds.push({ key: `read:${m.id}`, type: 'read', title: cleanTitle(m.title), typeLabel: m.type, md, sectionType: m.type, sectionRef: ref })
        if (qs.length) {
          rounds.push({ key: `quiz:${m.id}`, type: 'quiz', title: cleanTitle(m.title), typeLabel: m.type, questions: qs, sectionType: m.type, sectionRef: ref })
          pushStep(m.id, cleanTitle(m.title), start, `quiz:${m.id}`)
        } else if (md) {
          pushStep(m.id, cleanTitle(m.title), start, null)
        }
      }
    }
  } else {
    for (const s of sections) {
      const parsed = parseSectionTitle(s.title)
      const key = normSection(s.title)
      const qs = questions.filter(q => q.section === s.title || (q.section != null && normSection(q.section) === key))
      qs.forEach(q => used.add(q.id))
      const start = rounds.length
      const ref = { id: s.title, title: s.title }
      rounds.push({ key: `read:${s.title}`, type: 'read', title: parsed.clean, typeLabel: parsed.type.label, md: s.md, sectionRef: ref })
      if (qs.length) rounds.push({ key: `quiz:${s.title}`, type: 'quiz', title: parsed.clean, typeLabel: parsed.type.label, questions: qs, sectionRef: ref })
      pushStep(s.title, parsed.clean, start, qs.length ? `quiz:${s.title}` : null)
    }
  }
  const generic = questions.filter(q => !used.has(q.id))
  if (generic.length) {
    rounds.push({ key: 'quiz:generic', type: 'quiz', title: '综合', typeLabel: '通用', questions: generic })
    pushStep('quiz:generic', '综合', rounds.length - 1, 'quiz:generic')
  }
  return { rounds, steps }
}

/** 节进度 stepper（MathAcademy 式细条分段）：已过蓝条可点回跳，当前高亮，未到置灰；节名在 tooltip。 */
function Stepper(props: {
  steps: Step[]
  currentIdx: number
  isDone: (st: Step) => boolean
  goto: (roundIdx: number) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {props.steps.map((st, i) => {
        const done = props.isDone(st)
        const current = i === props.currentIdx
        return (
          <button key={st.key} type='button' title={st.label} aria-label={st.label}
            onClick={done ? () => props.goto(st.start) : undefined}
            style={{
              flex: 1, height: 6, minWidth: 18, maxWidth: 56, borderRadius: 3,
              border: 'none', padding: 0, cursor: done ? 'pointer' : 'default',
              background: current
                ? 'var(--color-primary-6,#165dff)'
                : done
                  ? 'var(--color-primary-3,#94bfff)'
                  : 'var(--color-fill-3,#e5e6eb)',
            }} />
        )
      })}
    </div>
  )
}

export default function PracticeFlow(props: {
  course: string
  node: string
  sections: LessonSection[]
  /** 节清单（逐节生成管线；null = 旧节点，回退标题匹配）。 */
  manifest: SectionManifestItem[] | null
  questions: QuestionItem[]
  /** 每题作答后父级刷新统计（silent）。 */
  onSettled: () => void
  /** struggle 时请求 AI 定向补题（#117：父级任务化入队后即返回，新题经 questions
   * 刷新自动并入，quizPending 表示任务进行中；入参 = 定向节）。 */
  onNeedMore: (section: { id: string; title: string }) => Promise<void> | void
  /** 出题任务进行中（父级轮询 GenJob；按钮转入「出题中」态）。 */
  quizPending?: boolean
  /** 节点未归档题已达软上限（40，#117）：补题按钮需 Popconfirm 显式确认。 */
  quizSoftCap?: boolean
  /** 会话内单题被编辑/归档/重生成（#120 菜单落地）后的父级刷新。 */
  onQuestionsMutated?: () => void
  /** 会话通过状态变化（全部节过关）→ 父级放行「完成学习」。 */
  onPassChange?: (passed: boolean) => void
}) {
  const { rounds, steps } = useMemo(
    () => buildRounds(props.sections, props.manifest, props.questions),
    [props.sections, props.manifest, props.questions],
  )
  const [roundIdx, setRoundIdx] = useState(0)
  const [qIdx, setQIdx] = useState(0)
  const [streak, setStreak] = useState(0)
  const [asked, setAsked] = useState(0)
  const [answered, setAnswered] = useState<AnswerOutcome | null>(null)
  const [struggling, setStruggling] = useState(false)
  /** 本会话作答记录：已答题集合（回看不重答）与每题对错（连对/进度恢复用）。 */
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(new Set())
  const [outcomes, setOutcomes] = useState<Record<string, boolean>>({})
  /** 申诉冲正作废的题（ADR-0031）：判罚中性——退出可作答预算、连对不奖不罚。 */
  const [voidedIds, setVoidedIds] = useState<ReadonlySet<string>>(new Set())
  /** 已过关的题组（连对达标）：回看时整组只展示小结。 */
  const [doneRounds, setDoneRounds] = useState<ReadonlySet<string>>(new Set())
  /** 走到过的最远轮次：回看早前步骤不掉「会话已走完」。 */
  const [maxReached, setMaxReached] = useState(0)

  const allDone = maxReached >= rounds.length
  const round = roundIdx < rounds.length ? rounds[roundIdx] : null
  const qs = round?.type === 'quiz' ? round.questions ?? [] : []
  const current = qs[qIdx]
  // 可作答题数（直通题不计，ADR-0027；申诉作废题退出预算，ADR-0031）：连对目标按它算，
  // 全直通轮为 0（翻完即过）。本会话已真实作答的题即便刷新后带上 advancedToday 也仍算
  // 可作答——否则静默刷新会把刚答的题逐出目标分母，连对机制被架空（审查 #115 修复）。
  const answerableLen = qs.filter(q =>
    (!q.advancedToday || answeredIds.has(q.id)) && !voidedIds.has(q.id)).length
  const passTarget = passStreakFor(answerableLen)
  /** 直通卡只给「本会话还没碰过」的已推进题；会话内作答过的一律按普通作答卡走完结果态。 */
  const revealPending = !!current?.advancedToday && !answeredIds.has(current.id)

  useEffect(() => { props.onPassChange?.(allDone) }, [allDone, props])

  // ---- 题目集外部变化（定向补题并入 / 会话内归档·重生成，#117/#120）----
  // 题目 id 签名没变（纯统计静默刷新）→ 零动作，不打断正在进行的作答；
  // 变了 → 归位（原轮次键还在就回原轮次并重定位到第一个未作答题，轮次整个
  // 消失就近落位），struggle/走完态下有新未作答题则自动重进本题组。
  const questionsSigRef = useRef(props.questions)
  const roundsSigRef = useRef(rounds)
  useEffect(() => {
    if (questionsSigRef.current === props.questions) return
    questionsSigRef.current = props.questions
    const prevRounds = roundsSigRef.current
    roundsSigRef.current = rounds
    const sig = (rs: typeof rounds) => rs.map(r => (r.questions ?? []).map(q => q.id).join('|')).join('#')
    if (sig(prevRounds) === sig(rounds)) return
    const prevRound = prevRounds[roundIdx]
    const found = rounds.findIndex(r => r.key === (prevRound?.key ?? ''))
    const target = found >= 0 ? found : Math.min(roundIdx, Math.max(rounds.length - 1, 0))
    const prevCurrentId = prevRound?.type === 'quiz' ? prevRound.questions?.[qIdx]?.id : undefined
    const cur = rounds[target]?.type === 'quiz' ? (rounds[target].questions ?? [])[qIdx] : undefined
    const exhausted = rounds[target]?.type === 'quiz' && !cur
    const relocated = prevCurrentId !== undefined && !rounds.some(r => (r.questions ?? []).some(q => q.id === prevCurrentId))
    if (relocated || exhausted || target !== roundIdx) {
      setStruggling(false)
      gotoRound(target)
    } else if (struggling) {
      const hasNew = (rounds[target].questions ?? []).some(q => !answeredIds.has(q.id))
      if (hasNew) {
        setStruggling(false)
        gotoRound(target)
      }
    }
  }, [props.questions])

  /** step 是否已过：有 quiz 轮看过关集合；纯阅读步以读完（maxReached 越过本步末轮）为准。 */
  const isStepDone = (st: Step): boolean => {
    if (st.quizKey) return doneRounds.has(st.quizKey)
    const i = steps.indexOf(st)
    const end = (steps[i + 1]?.start ?? rounds.length) - 1
    return maxReached > end
  }
  const currentStepIdx = (() => {
    let idx = 0
    for (let i = 0; i < steps.length; i++) if (roundIdx >= steps[i].start) idx = i
    return idx
  })()

  /** list 中 from 起第一个未作答题的下标（全答完 = list.length）。 */
  const firstUnanswered = (list: QuestionItem[], from = 0): number => {
    for (let i = from; i < list.length; i++) if (!answeredIds.has(list[i].id)) return i
    return list.length
  }

  /** 进入第 idx 轮（上一步/下一步/回跳共用）：题组定位到第一个未作答题，
   * 连对与已答数按本会话作答记录恢复——一组问题 = 一步，整组只答一次。 */
  const gotoRound = (idx: number) => {
    const r = rounds[idx]
    setRoundIdx(idx)
    setMaxReached(m => Math.max(m, idx))
    setAnswered(null)
    setStruggling(false)
    if (r?.type !== 'quiz') { setQIdx(0); setStreak(0); setAsked(0); return }
    const list = r.questions ?? []
    setQIdx(firstUnanswered(list))
    setAsked(list.filter(q => answeredIds.has(q.id) && !voidedIds.has(q.id)).length)
    let s = 0
    for (let i = list.length - 1; i >= 0; i--) {
      const oc = outcomes[list[i].id]
      if (oc === undefined) continue
      if (oc) s++
      else break
    }
    setStreak(s)
  }

  const nextRound = () => gotoRound(roundIdx + 1)
  const prevRound = () => gotoRound(roundIdx - 1)

  const handleDone = (oc: AnswerOutcome) => {
    setAnswered(oc)
    setAsked(a => a + 1)
    if (current) {
      setAnsweredIds(s => new Set(s).add(current.id))
      setOutcomes(o => ({ ...o, [current.id]: oc.correct === true }))
    }
    props.onSettled()
  }

  /** 「下一题」：连对达标（目标随组内可作答题量收缩，申诉作废的题退出分母）→
   * 过节（整组标记完成）；未答题用尽/超上限 → struggle；否则跳到组内下一个未作答题
   * （已答过的题不重复出现）。申诉作废的中性态（ADR-0031）：连对不奖不罚。 */
  const advance = () => {
    const voided = answered?.voided === true
    const wasCorrect = answered?.correct === true
    const newStreak = voided ? streak : wasCorrect ? streak + 1 : 0
    if (!voided && newStreak >= passTarget) {
      if (round) setDoneRounds(d => new Set(d).add(round.key))
      nextRound()
      return
    }
    setStreak(newStreak)
    const next = firstUnanswered(qs, qIdx + 1)
    if (asked < MAX_ASK_PER_ROUND && next < qs.length) {
      setQIdx(next)
      setAnswered(null)
      return
    }
    setStruggling(true)
  }

  /** 直通卡「下一题」（ADR-0027）：对错中性——计入本会话已看集合即可，不产连对、
   * 不记 outcomes。组内再无可看的题时收轮：全直通轮翻完直接过关；混合轮（可作答
   * 题已用尽仍未达标）留在本轮落 struggle，与既有口径一致。 */
  const revealNext = () => {
    if (!current) return
    const seen = new Set(answeredIds).add(current.id)
    setAnsweredIds(seen)
    const next = qs.find(q => !seen.has(q.id))
    if (next) { setQIdx(qs.indexOf(next)); setAnswered(null); return }
    if (answerableLen === 0 && round) setDoneRounds(d => new Set(d).add(round.key))
    else setStruggling(true)
  }

  /** struggle → AI 定向补题（#117）：只为当前卡住的节补 3 道同类题。任务化入队后即返回
   * （进行中态由父级经 quizPending 轮询驱动），新题经 questions 刷新自动并入本题组
   * （外部题目集变化效果会把会话重定位到第一个未作答题）。 */
  const needMore = () => {
    if (!round?.sectionRef) return
    void props.onNeedMore(round.sectionRef)
  }

  /** 单题「…」菜单（#120）：编辑/归档/提意见重生成——定向节取本节轮的 sectionRef。 */
  const questionMenu = (q: QuestionItem) => props.onQuestionsMutated ? (
    <QuestionMenu
      target={{
        course: props.course, node: props.node, qid: q.id, kind: q.kind,
        q: q.q, difficulty: q.difficulty, options: q.options,
        section: round?.sectionRef,
      }}
      onMutated={() => props.onQuestionsMutated?.()}
      onDisputed={r => handleDisputeSettled(q.id, r)} />
  ) : null

  /** 申诉结算后的会话内判罚恢复（ADR-0031）：
   * - 改判对 → 本会话该题按对计，连对恢复推进；
   * - 作废/豁免 → 中性（outcomes 除名、退出出题预算、推进时连对不奖不罚）；
   * - 作废（void）→ 链路归档旧题并按申诉理由为本节定向重出一题（新题经外部题目集
   *   变化自动并入本题组）。直通卡菜单发起的历史申诉：本会话没答过的题自然零动作。 */
  const handleDisputeSettled = (qid: string, r: DisputeSettled) => {
    const corrected = r.resolution === 'rekey' && r.correctNow === true
    setOutcomes(o => {
      const next = { ...o }
      if (corrected) next[qid] = true
      else delete next[qid]
      return next
    })
    if (!corrected) {
      setVoidedIds(s => new Set(s).add(qid))
      setAsked(a => Math.max(0, a - 1))
    }
    setAnswered(prev => prev ? {
      ...prev,
      correct: corrected ? true : null,
      xp: corrected ? r.xp : 0,
      xp_reason: corrected ? 'correct' : undefined,
      voided: !corrected,
    } : prev)
    props.onSettled()
    if (r.resolution === 'void') {
      // 归档已随引擎结算原子落盘（ADR-0031）；这里只补重出：按申诉理由为本节定向出一道新题
      // （入全局队列，可取消可重试；新题经外部题目集变化自动并入本题组）
      void (async () => {
        try {
          await api.questionGenerate(props.course, props.node, 1, {
            ...(round?.sectionRef ? { section: round.sectionRef } : {}),
            ...(r.reason ? { instruction: `原题已因瑕疵被申诉作废，理由：${r.reason}。请避开该问题重出一道同类题` } : {}),
          })
          props.onQuestionsMutated?.()
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        }
      })()
    }
  }

  const stepperEl = steps.length > 1 && (
    <Stepper steps={steps} currentIdx={currentStepIdx} isDone={isStepDone} goto={gotoRound} />
  )

  /** 当前轮渲染主体（外层统一包装 stepper）。 */
  const body = (): ReactNode => {
    if (roundIdx >= rounds.length) {
      return (
        <Card size='small' style={{ borderRadius: 10, background: 'var(--color-success-light-1,#e8ffea)' }}>
          <Space direction='vertical' size={6} style={{ width: '100%' }}>
            <Title heading={6} style={{ margin: 0 }}>练习通过</Title>
            <Text type='secondary'>全部小节已过关。下方「完成学习」把本节题目纳入复习循环；明天起按间隔重复安排复习。</Text>
          </Space>
        </Card>
      )
    }
    if (!round) return null

    // ---- 阅读轮 ----
    if (round.type === 'read') {
      return (
        <Card size='small' style={{ borderRadius: 10 }} bodyStyle={{ padding: '20px 24px 22px' }}>
          <Space direction='vertical' size={12} style={{ width: '100%' }}>
            <Space size={8}>
              <Tag color='arcoblue'>{round.typeLabel}</Tag>
              <Title heading={6} style={{ margin: 0 }}>{round.title}</Title>
            </Space>
            <MdView md={round.md ?? ''} />
            <Space size={8} style={{ alignSelf: 'flex-end' }}>
              {roundIdx > 0 && <Button size='small' onClick={prevRound}>上一步</Button>}
              <Button type='primary' onClick={nextRound}>继续</Button>
            </Space>
          </Space>
        </Card>
      )
    }

    // ---- 交互节轮：交互件轮渲染（SettleContext 供 InteractiveBlock 上报结算） ----
    if (round.type === 'interactive') {
      return (
        <Card size='small' style={{ borderRadius: 10 }} bodyStyle={{ padding: '16px 20px 18px' }}>
          <SettleContext.Provider value={{ course: props.course, node: props.node, sectionId: round.sectionId ?? '' }}>
            <Space direction='vertical' size={12} style={{ width: '100%' }}>
              <Space size={8}>
                <Tag color='purple'>{round.typeLabel}</Tag>
                <Title heading={6} style={{ margin: 0 }}>{round.title}</Title>
              </Space>
              <MdView md={round.md ?? ''} />
              <Space size={8} style={{ alignSelf: 'flex-end' }}>
                {roundIdx > 0 && <Button size='small' onClick={prevRound}>上一步</Button>}
                <Button type='primary' onClick={nextRound}>继续</Button>
              </Space>
            </Space>
          </SettleContext.Provider>
        </Card>
      )
    }

    // ---- 练习轮：整组已过关（回看小结，不重答） ----
    if (doneRounds.has(round.key)) {
      const right = qs.filter(q => outcomes[q.id] === true).length
      return (
        <Card size='small' style={{ borderRadius: 10 }} bodyStyle={{ padding: '16px 20px 18px' }}>
          <Space direction='vertical' size={12} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Tag color='arcoblue'>{round.typeLabel}</Tag>
              <Title heading={6} style={{ margin: 0 }}>{round.title}</Title>
              <Tag size='small' color='green'>已过关</Tag>
            </Space>
            <Text type='secondary' style={{ fontSize: 13, lineHeight: 1.7 }}>
              本组共 {qs.length} 题，本次学习答对 {right} 题；每道题一次学习只作答一次，回看不再重答。
            </Text>
            <Space size={8} style={{ alignSelf: 'flex-end' }}>
              {roundIdx > 0 && <Button size='small' onClick={prevRound}>上一步</Button>}
              <Button type='primary' size='small' onClick={nextRound}>继续往下</Button>
            </Space>
          </Space>
        </Card>
      )
    }

    // ---- 练习轮：struggle 分支（组内已无可作答的题） ----
    if (struggling || (!current && qs.length > 0)) {
      // 练习/交互节不出题库补题（#117）：这类节 struggle 只留重读与跳过
      const practiceLike = round.sectionType === '练习' || round.sectionType === '交互'
      const moreButton = (
        <Button size='small' type='primary' loading={props.quizPending} disabled={props.quizPending}
          onClick={needMore}>
          {props.quizPending ? 'AI 出题中…' : 'AI 再出题'}
        </Button>
      )
      return (
        <Card size='small' style={{ borderRadius: 10 }}>
          <Space direction='vertical' size={10} style={{ width: '100%' }}>
            <Alert
              type='warning'
              content={props.quizPending
                ? `正在为「${round.title}」补题，完成后新题会自动出现在本题组。`
                : `「${round.title}」这一节还没过关（需连对 ${passTarget} 题，本节最多 ${MAX_ASK_PER_ROUND} 题）。可以先重读一遍，或让 AI 再出几道同类题。`}
            />
            <Space size={8} wrap>
              <Button size='small' onClick={() => {
                const st = steps.find(s => s.quizKey === round.key)
                if (st && st.start < roundIdx) gotoRound(st.start)
                else if (roundIdx > 0) prevRound()
              }}>重读本节</Button>
              {!practiceLike && (
                props.quizSoftCap ? (
                  <Popconfirm
                    title={`本节点未归档题已达 ${QUIZ_SOFT_CAP} 道软上限`}
                    content='继续补题会让题库更难维护，确认仍要为这一节再补 3 道同类题吗？'
                    onOk={needMore}>
                    {moreButton}
                  </Popconfirm>
                ) : moreButton
              )}
              <Button size='small' type='text' onClick={nextRound}>跳过本节，继续后面的</Button>
            </Space>
          </Space>
        </Card>
      )
    }

    // ---- 练习轮：单题 ----
    return (
      <Card size='small' style={{ borderRadius: 10 }} bodyStyle={{ padding: '16px 20px 18px' }}>
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Tag color='arcoblue'>{round.typeLabel}</Tag>
            <Title heading={6} style={{ margin: 0 }}>{round.title}</Title>
            <Text type='secondary' style={{ fontSize: 12 }}>
              第 {qIdx + 1}/{qs.length} 题 · 连对 {streak}/{passTarget}
            </Text>
          </Space>
          {current && (revealPending ? (
            <RevealCard key={current.id} question={current} onNext={revealNext} menu={questionMenu(current)} />
          ) : (
            <QuestionCard key={current.id} course={props.course} node={props.node} question={current} noRedo
              onDone={handleDone} menu={questionMenu(current)} onEscape={revealNext}
              onDisputeSettled={handleDisputeSettled} />
          ))}
          {!revealPending && (answered || roundIdx > 0) && (
            <Space size={8} style={{ alignSelf: 'flex-end' }}>
              {roundIdx > 0 && <Button size='small' onClick={prevRound}>上一步</Button>}
              {answered && (
                <Button type='primary' size='small' onClick={advance}>
                  {answered.correct === true && streak + 1 >= passTarget ? '连对达标，下一节' : '下一题'}
                </Button>
              )}
            </Space>
          )}
        </Space>
      </Card>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {stepperEl}
      {body()}
    </div>
  )
}
