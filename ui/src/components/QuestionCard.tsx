/** 题型作答卡（allo evaluate 交互，9 种题型）：
 * 规则判卷——single_choice/multi_choice 选项作答、true_false 判断、fill_in_blank 文本、
 * numeric 数值、ordering 上移/下移排序、matching 逐左项下拉配对；
 * AI 判卷——reflection（评分要点）与 open_question（10 分制综合批改）。
 * 题干/选项/排序项/配对项/判卷反馈经 InlineMd 渲染（Markdown+公式，与课程正文同一条链）。
 * 全部提交引擎判卷，结果内联展示判卷反馈；作答即驱动该题 FSRS 调度（对=Good、错=Again）。
 * 计时随提交上报（XP 时间账本的乱猜判定原料）；结算 XP 徽标展示（+N / 乱猜 -1 / 重复 0）。
 * 复习刷卡变体（variant='review'）：提交改走 submitter（deferSchedule 挂起调度，背面自评）、
 * 正面「忘记」申报受 5 秒主动回忆门控（展示起算倒计时）、背面追加正确答案块；
 * 自评难度按钮等复习专属背面件由 footer 注入。 */
import { Button, Input, Message, Radio, Select, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { InlineMd } from './MdView'
import { api } from '../api'
import type { QuestionItem } from '../types'

const { Text } = Typography

/** 「忘记」门控秒数：卡面展示满 5 秒才允许申报，防止以申报代替主动回忆。 */
const FORGET_AFTER_SECONDS = 5

export interface AnswerOutcome {
  correct: boolean | null
  judge: string
  feedback?: string
  /** 本次作答 XP 结算（answer 响应的 xp/xp_reason 透传）。 */
  xp?: number
  xp_reason?: 'correct' | 'wrong' | 'guess' | 'repeat'
  /** 复习刷卡流附加件：翻面答案/解析回显、自评挂起与三档到期预览。 */
  answer?: string
  explanation?: string
  pendingRating?: boolean
  previews?: { hard: string; good: string; easy: string }
}

/** 引擎作答/忘记响应 → 卡面结果（AnswerResult 的可选字段收窄为 Outcome 语义）。 */
export function toOutcome(r: import('../types').AnswerResult): AnswerOutcome {
  return {
    correct: r.correct ?? null, judge: r.judge, feedback: r.feedback,
    xp: r.xp, xp_reason: r.xp_reason,
    answer: r.answer, explanation: r.explanation,
    pendingRating: r.pendingRating, previews: r.previews,
  }
}

const KIND_LABEL: Record<QuestionItem['kind'], string> = {
  single_choice: '单选', fill_in_blank: '填空', true_false: '判断', reflection: '反思',
  multi_choice: '多选', numeric: '数值', ordering: '排序', matching: '配对', open_question: '开放',
}

/** XP 结算徽标。 */
function XpBadge({ xp, reason }: { xp?: number; reason?: string }) {
  if (xp === undefined || reason === undefined) return null
  if (reason === 'repeat') return <Tag size='small' color='gray'>重复练习 +0 XP</Tag>
  if (reason === 'guess') return <Tag size='small' color='red'>{xp} XP · 提交太快，按乱猜计</Tag>
  if (xp > 0) return <Tag size='small' color='green'>+{xp} XP</Tag>
  return null
}

/** 排序题：项列表 + 上移/下移（不引拖拽库）。 */
function OrderList({ items, order, onOrder, disabled }: {
  items: string[]
  order: number[]
  onOrder: (next: number[]) => void
  disabled: boolean
}) {
  const move = (pos: number, delta: -1 | 1) => {
    const next = [...order]
    const target = pos + delta
    if (target < 0 || target >= next.length) return
    ;[next[pos], next[target]] = [next[target], next[pos]]
    onOrder(next)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {order.map((optIdx, pos) => (
        <div key={optIdx} style={{
          display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--color-border-2,#e5e6eb)',
          borderRadius: 6, padding: '4px 8px', background: 'var(--color-fill-1,#f7f8fa)',
        }}>
          <Text style={{ fontSize: 12, color: 'var(--color-text-3,#86909c)', width: 18 }}>{pos + 1}.</Text>
          <Text style={{ flex: 1, fontSize: 13 }}><InlineMd text={items[optIdx]} /></Text>
          <Button size='mini' type='text' disabled={disabled || pos === 0} onClick={() => move(pos, -1)}>↑</Button>
          <Button size='mini' type='text' disabled={disabled || pos === order.length - 1} onClick={() => move(pos, 1)}>↓</Button>
        </div>
      ))}
    </div>
  )
}

export default function QuestionCard(props: {
  course: string
  node: string
  question: QuestionItem
  /** 作答完成（无论对错）→ 父级刷新统计/驱动练习流。 */
  onDone?: (outcome: AnswerOutcome) => void
  /** mastery 会话内隐藏「再做一次」（重复作答不推进调度，换题/重读更有价值）。 */
  noRedo?: boolean
  /** review = 复习刷卡变体：一卡一票（无重做）、5 秒门控忘记、背面正确答案块。 */
  variant?: 'practice' | 'review'
  /** 复习刷卡流的提交器（deferSchedule 挂起调度）；缺省走练习流 api.questionAnswer。 */
  submitter?: (payload: string, elapsedS: number) => Promise<AnswerOutcome>
  /** 「忘记」申报（复习变体；引擎按答错记证据、0 XP）。入参 = 卡面展示到申报的秒数。 */
  onForget?: (elapsedS: number) => Promise<AnswerOutcome>
  /** 背面附加件（自评难度按钮、下一张等），渲染在判卷反馈之下。 */
  footer?: (outcome: AnswerOutcome) => ReactNode
}) {
  const { question: q } = props
  const [choice, setChoice] = useState<string>('')
  const [multi, setMulti] = useState<string[]>([])
  const [text, setText] = useState('')
  const [order, setOrder] = useState<number[] | null>(null)
  const [pairs, setPairs] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null)
  const [forgetting, setForgetting] = useState(false)
  // 「忘记」门控倒计时：卡面展示起算（复习变体专属）
  const [forgetIn, setForgetIn] = useState(props.variant === 'review' ? FORGET_AFTER_SECONDS : 0)
  // 计时起点：题目渲染 / 重做时重置（乱猜判定 = 耗时过短且答错）
  const startRef = useRef(Date.now())

  useEffect(() => {
    if (forgetIn <= 0) return
    const timer = setTimeout(() => setForgetIn(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [forgetIn])

  const isChoice = q.kind === 'single_choice' || q.kind === 'true_false'
  const isMulti = q.kind === 'multi_choice'
  const isNumeric = q.kind === 'numeric'
  const isOrdering = q.kind === 'ordering'
  const isMatching = q.kind === 'matching'
  const isText = q.kind === 'fill_in_blank' || q.kind === 'reflection' || q.kind === 'open_question'
  const opts = q.options ?? []
  const orderSeq = order ?? opts.map((_, i) => i)

  const canSubmit = !busy && (
    isChoice ? choice !== ''
      : isMulti ? multi.length > 0
        : isNumeric ? text.trim() !== ''
          : isOrdering ? opts.length > 0
            : isMatching ? opts.length > 0 && opts.every((_, i) => pairs[i])
              : text.trim() !== ''
  )

  /** 题型化提交载荷（引擎判卷入口统一为 string）。 */
  const payload = (): string => {
    if (isMulti) return [...multi].sort().join(',')
    if (isOrdering) return orderSeq.map(i => opts[i]).join('\n')
    if (isMatching) return opts.map((_, i) => pairs[i] ?? '').join('\n')
    if (q.kind === 'true_false') return choice === 'T' ? 'true' : 'false'
    if (isChoice) return choice // single_choice：提交选中的选项字母
    return text.trim()
  }

  const submit = async () => {
    setBusy(true)
    const elapsedS = Math.round(((Date.now() - startRef.current) / 1000) * 10) / 10
    try {
      let res: AnswerOutcome
      if (props.submitter) {
        res = await props.submitter(payload(), elapsedS)
      } else {
        const r = await api.questionAnswer(props.course, props.node, q.id, payload(), elapsedS)
        if (r.scheduled === false) {
          Message.info('该题今日已推进过复习调度，本次仅记录练习统计')
        }
        res = toOutcome(r)
      }
      setOutcome(res)
      props.onDone?.(res)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 「忘记」申报：不作答直接翻面，调度与统计按答错记（引擎侧 0 XP）。 */
  const doForget = async () => {
    if (!props.onForget || outcome) return
    setForgetting(true)
    try {
      const elapsedS = Math.round(((Date.now() - startRef.current) / 1000) * 10) / 10
      const oc = await props.onForget(elapsedS)
      setOutcome(oc)
      props.onDone?.(oc)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setForgetting(false)
    }
  }

  const redo = () => {
    setOutcome(null)
    setChoice('')
    setMulti([])
    setText('')
    setOrder(null)
    setPairs({})
    startRef.current = Date.now()
  }

  const openPlaceholder = q.kind === 'reflection'
    ? '写下你的回答（AI 按评分要点判卷）'
    : '写下你的综合应用回答（AI 按 10 分制批改，≥6 及格）'

  return (
    <div style={{
      border: '1px solid var(--color-border-2,#e5e6eb)', borderRadius: 8,
      padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Tag size='small' color='arcoblue'>{KIND_LABEL[q.kind]}</Tag>
        <Text type='secondary' style={{ fontSize: 12 }}>难度 {q.difficulty} · #{q.no}</Text>
      </div>
      <div style={{ fontSize: 16, lineHeight: 1.75 }}><InlineMd text={q.q} /></div>

      {isChoice && (
        q.kind === 'single_choice' ? (
          <Radio.Group value={choice} onChange={v => setChoice(v)} direction='vertical' disabled={!!outcome}>
            {opts.map((opt, i) => (
              <Radio key={i} value={String.fromCharCode(65 + i)}>{String.fromCharCode(65 + i)}. <InlineMd text={opt} /></Radio>
            ))}
          </Radio.Group>
        ) : (
          <Radio.Group value={choice} onChange={v => setChoice(v)} disabled={!!outcome}>
            <Radio value='T'>正确</Radio>
            <Radio value='F'>错误</Radio>
          </Radio.Group>
        )
      )}

      {isMulti && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {opts.map((opt, i) => {
            const letter = String.fromCharCode(65 + i)
            const checked = multi.includes(letter)
            return (
              <label key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: outcome ? 'default' : 'pointer',
                padding: '2px 4px', borderRadius: 4,
                background: checked ? 'var(--color-primary-light-1,#e8f3ff)' : 'transparent',
              }}>
                <input type='checkbox' checked={checked} disabled={!!outcome}
                  onChange={() => setMulti(m => checked ? m.filter(x => x !== letter) : [...m, letter])} />
                <Text style={{ fontSize: 13 }}>{letter}. <InlineMd text={opt} /></Text>
              </label>
            )
          })}
        </div>
      )}

      {isNumeric && (
        <Input
          value={text} onChange={setText} placeholder='输入数值（支持小数/分数/百分数）'
          disabled={!!outcome} style={{ maxWidth: 280 }} />
      )}

      {isOrdering && (
        <OrderList items={opts} order={orderSeq} onOrder={setOrder} disabled={!!outcome} />
      )}

      {isMatching && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {opts.map((opt, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 13, minWidth: 100 }}><InlineMd text={opt} /></Text>
              <Select
                value={pairs[i]} placeholder='选择配对'
                style={{ flex: 1, maxWidth: 320 }} disabled={!!outcome}
                onChange={v => setPairs(p => ({ ...p, [i]: v as string }))}>
                {(q.pairOptions ?? []).map((p, j) => <Select.Option key={j} value={p}><InlineMd text={p} /></Select.Option>)}
              </Select>
            </div>
          ))}
        </div>
      )}

      {isText && (
        <Input.TextArea
          value={text} onChange={setText}
          placeholder={openPlaceholder}
          autoSize={{ minRows: q.kind === 'open_question' ? 4 : 1, maxRows: 10 }} disabled={!!outcome} />
      )}

      {!outcome ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {props.variant === 'review' && props.onForget && (
            <Button size='small' status='danger' disabled={forgetIn > 0 || busy}
              loading={forgetting} onClick={() => void doForget()}>
              {forgetIn > 0 ? `忘记（${forgetIn}s 后可用）` : '忘记'}
            </Button>
          )}
          <Button type='primary' size='small' loading={busy} disabled={!canSubmit}
            onClick={() => void submit()}>提交</Button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {outcome.correct === true && <Tag color='green'>答对了</Tag>}
            {outcome.correct === false && (outcome.judge === 'forget'
              ? <Tag color='orange'>忘记了</Tag>
              : <Tag color='red'>答错了</Tag>)}
            {outcome.correct === null && <Tag>已记录</Tag>}
            <XpBadge xp={outcome.xp} reason={outcome.xp_reason} />
            <Text type='secondary' style={{ fontSize: 12 }}>判卷：{outcome.judge}</Text>
            {!props.noRedo && props.variant !== 'review' && (
              <Button size='mini' type='text' onClick={redo}>再做一次</Button>
            )}
          </div>
          {outcome.feedback && (
            <div style={{
              borderLeft: `3px solid ${outcome.correct === true ? 'var(--color-success-6,#00b42a)' : outcome.correct === false ? 'var(--color-danger-6,#f53f3f)' : 'var(--color-border-2,#e5e6eb)'}`,
              background: outcome.correct === true ? 'var(--color-success-light-1,#e8ffea)' : outcome.correct === false ? 'var(--color-danger-light-1,#ffece8)' : 'var(--color-fill-1,#f7f8fa)',
              borderRadius: '0 6px 6px 0', padding: '8px 12px',
              fontSize: 14, lineHeight: 1.7,
            }}><InlineMd text={outcome.feedback} /></div>
          )}
          {props.variant === 'review' && outcome.answer && (
            <div style={{ fontSize: 13 }}>
              <Text type='secondary'>正确答案：</Text>
              <Text bold>{outcome.answer}</Text>
            </div>
          )}
          {props.footer?.(outcome)}
        </div>
      )}
    </div>
  )
}
