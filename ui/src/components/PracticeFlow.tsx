/** mastery 练习会话（Math Academy active learning loop），节序列驱动：
 * 节清单（manifest）存在时按节类型装配轮次——内容节 = 读节→做该节题（连对 2 过、
 * 至多 5 题）；练习节 = 一等练习轮（无阅读，直接做题）；交互节 = 交互件轮
 * （沙箱 iframe 运行，达成目标上报成绩结算）。旧节点（无清单）回退标题匹配。
 * 题目按 section 绑定节 id（旧题回退节标题），未落节的题进通用收尾轮。
 * 顶部节进度 stepper（MathAcademy 式细条分段）：已过蓝条可点回跳、当前高亮、未到置灰。
 * 「上一步」按轮回看：一组问题视为一步，已过关的题组回看只展示小结；
 * 同一次学习里每道题只作答一次（重进题组自动定位到第一个未作答题）。 */
import { Alert, Button, Card, Space, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import MdView from './MdView'
import QuestionCard, { type AnswerOutcome } from './QuestionCard'
import { SettleContext } from './settle-context'
import { parseSectionTitle } from '../../../shared/content-renderers'
import type { LessonSection, QuestionItem, SectionManifestItem } from '../types'

const { Text, Title } = Typography

const PASS_STREAK = 2        // 连对即过该节（MA）
const MAX_ASK_PER_ROUND = 5  // 每节至多 5 题（MA），超过未连对 2 → struggle

interface Round {
  key: string
  type: 'read' | 'quiz' | 'interactive'
  title: string
  typeLabel: string
  md?: string
  questions?: QuestionItem[]
  /** 交互节轮的节 id（SettleContext 上报结算用）。 */
  sectionId?: string
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
      if (m.type === '交互') {
        if (md) rounds.push({ key: `ix:${m.id}`, type: 'interactive', title: cleanTitle(m.title), typeLabel: m.type, md, sectionId: m.id })
        pushStep(m.id, cleanTitle(m.title), start, null)
      } else if (m.type === '练习') {
        // 一等练习节：无阅读轮，直接做题；无题不出轮（出题后 questions 刷新重建轮次）
        if (qs.length) {
          rounds.push({ key: `quiz:${m.id}`, type: 'quiz', title: cleanTitle(m.title), typeLabel: m.type, questions: qs })
          pushStep(m.id, cleanTitle(m.title), start, `quiz:${m.id}`)
        }
      } else {
        if (md) rounds.push({ key: `read:${m.id}`, type: 'read', title: cleanTitle(m.title), typeLabel: m.type, md })
        if (qs.length) {
          rounds.push({ key: `quiz:${m.id}`, type: 'quiz', title: cleanTitle(m.title), typeLabel: m.type, questions: qs })
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
      rounds.push({ key: `read:${s.title}`, type: 'read', title: parsed.clean, typeLabel: parsed.type.label, md: s.md })
      if (qs.length) rounds.push({ key: `quiz:${s.title}`, type: 'quiz', title: parsed.clean, typeLabel: parsed.type.label, questions: qs })
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
  /** struggle 时请求 AI 追加出题（父级出题并刷新 questions）。 */
  onNeedMore: () => Promise<void>
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
  const [needMoreBusy, setNeedMoreBusy] = useState(false)
  /** 本会话作答记录：已答题集合（回看不重答）与每题对错（连对/进度恢复用）。 */
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(new Set())
  const [outcomes, setOutcomes] = useState<Record<string, boolean>>({})
  /** 已过关的题组（连对达标）：回看时整组只展示小结。 */
  const [doneRounds, setDoneRounds] = useState<ReadonlySet<string>>(new Set())
  /** 走到过的最远轮次：回看早前步骤不掉「会话已走完」。 */
  const [maxReached, setMaxReached] = useState(0)

  const allDone = maxReached >= rounds.length
  const round = roundIdx < rounds.length ? rounds[roundIdx] : null
  const qs = round?.type === 'quiz' ? round.questions ?? [] : []
  const current = qs[qIdx]

  useEffect(() => { props.onPassChange?.(allDone) }, [allDone, props])

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
    setAsked(list.filter(q => answeredIds.has(q.id)).length)
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

  /** 「下一题」：连对 2 → 过节（整组标记完成）；未答题用尽/超上限 → struggle；
   * 否则跳到组内下一个未作答题（已答过的题不重复出现）。 */
  const advance = () => {
    const wasCorrect = answered?.correct === true
    const newStreak = wasCorrect ? streak + 1 : 0
    if (newStreak >= PASS_STREAK) {
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

  /** struggle → AI 再出题：出完回到本步开头重读/重做（新题经 questions 刷新进轮，
   * 旧题已答过不再重复，重进题组时自动定位到新题）。 */
  const needMore = async () => {
    setNeedMoreBusy(true)
    try {
      await props.onNeedMore()
      const st = steps.find(s => s.quizKey === round?.key)
      gotoRound(st ? st.start : roundIdx)
    } finally {
      setNeedMoreBusy(false)
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
      return (
        <Card size='small' style={{ borderRadius: 10 }}>
          <Space direction='vertical' size={10} style={{ width: '100%' }}>
            <Alert
              type='warning'
              content={`「${round.title}」这一节还没过关（${PASS_STREAK} 题连对才通过，本节最多 ${MAX_ASK_PER_ROUND} 题）。可以先重读一遍，或让 AI 再出几道同类题。`}
            />
            <Space size={8} wrap>
              <Button size='small' onClick={() => {
                const st = steps.find(s => s.quizKey === round.key)
                if (st && st.start < roundIdx) gotoRound(st.start)
                else if (roundIdx > 0) prevRound()
              }}>重读本节</Button>
              <Button size='small' type='primary' loading={needMoreBusy} onClick={() => void needMore()}>
                AI 再出题
              </Button>
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
              第 {qIdx + 1}/{qs.length} 题 · 连对 {streak}/{PASS_STREAK}
            </Text>
          </Space>
          {current && (
            <QuestionCard key={current.id} course={props.course} node={props.node} question={current} noRedo onDone={handleDone} />
          )}
          {(answered || roundIdx > 0) && (
            <Space size={8} style={{ alignSelf: 'flex-end' }}>
              {roundIdx > 0 && <Button size='small' onClick={prevRound}>上一步</Button>}
              {answered && (
                <Button type='primary' size='small' onClick={advance}>
                  {answered.correct === true && streak + 1 >= PASS_STREAK ? '连对达标，下一节' : '下一题'}
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
