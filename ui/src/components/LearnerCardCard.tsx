/** 「我的卡」卡面（E1 #70，独立于判卷型 QuestionCard）：三段式复习交互——
 * 正面按卡面形态出题（提示重述 = prompt；挖空重述 = 学习者自己的挖空句隐藏 {{…}}；
 * 自注讲解 = prompt），学习者心里重述 → 翻面对照自己当初的表述 → 自评
 * Hard/Good/Easy 推进；忘记申报受 5 秒主动回忆门控（与复习刷卡同语义）。
 * 无判分：AI 只在创建时给过反馈，复习全程复习自评语义（一卡一天一次推进）。 */
import { Button, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { InlineMd } from './MdView'
import type { LearnerCardItem, LearnerCardKind } from '../types'

const { Text } = Typography

/** 「忘记」门控秒数：卡面展示满 5 秒才允许申报（防止以申报代替回忆）。 */
const FORGET_AFTER_SECONDS = 5

const KIND_LABEL: Record<LearnerCardKind, { label: string; color: string }> = {
  recall_cue: { label: '提示重述', color: 'arcoblue' },
  cloze_rewrite: { label: '挖空重述', color: 'purple' },
  self_explain: { label: '自注讲解', color: 'green' },
}

const CLOZE_MARK = /\{\{([^{}]+)\}\}/g

/** 挖空句正面：{{…}} 隐藏为空槽。 */
function clozeFront(text: string): string {
  return text.replace(CLOZE_MARK, () => '＿＿＿')
}

/** 挖空句背面：{{…}} 内容加粗对照。 */
function clozeBack(text: string): string {
  return text.replace(CLOZE_MARK, (_m, inner: string) => `**${inner}**`)
}

export default function LearnerCardCard(props: {
  card: LearnerCardItem
  onRate: (r: 2 | 3 | 4) => void | Promise<void>
  onForget: () => void | Promise<void>
}) {
  const { card } = props
  const [flipped, setFlipped] = useState(false)
  const [busy, setBusy] = useState(false)
  // 「忘记」门控倒计时：卡面展示起算
  const [forgetIn, setForgetIn] = useState(FORGET_AFTER_SECONDS)

  useEffect(() => {
    if (forgetIn <= 0) return
    const timer = setTimeout(() => setForgetIn(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [forgetIn])

  // 自评键盘快捷键（背面挂起时 2/3/4 = Hard/Good/Easy；正面不响应，忘记走门控按钮）
  useEffect(() => {
    if (!flipped) return
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
  }, [flipped])

  const rate = async (r: 2 | 3 | 4) => {
    setBusy(true)
    try {
      await props.onRate(r)
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    if (forgetIn > 0 || busy) return
    setBusy(true)
    try {
      await props.onForget()
    } finally {
      setBusy(false)
    }
  }

  const kind = KIND_LABEL[card.kind] ?? { label: card.kind, color: 'gray' }
  const frontIsCloze = card.kind === 'cloze_rewrite'

  return (
    <div className='lh-border lh-r-md lh-p-10px-12px lh-col lh-gap-10'>
      <div className='lh-gap-8 lh-row lh-wrap'>
        <Tag size='small' color={kind.color}>{kind.label}</Tag>
        <Text type='secondary' className='lh-t-12'>{card.course} · {card.node}</Text>
        {card.source_section && <Text type='secondary' className='lh-t-12'>· {card.source_section}</Text>}
        {card.due && <Tag size='small'>到期 {card.due}</Tag>}
        {card.attempts > 0 && <Tag size='small'>推进过 {card.attempts} 次</Tag>}
      </div>

      {!flipped ? (
        <>
          <div className='lh-t-16 lh-lh-1p75'>
            <InlineMd text={frontIsCloze ? clozeFront(card.content) : card.prompt} />
          </div>
          <Text type='secondary' className='lh-t-12'>
            {frontIsCloze ? '心里补全你自己的挖空句，再翻面对照' : '在心里用你自己的话重述一遍，再翻面对照'}
          </Text>
          <div className='lh-gap-8 lh-end lh-row'>
            <Button size='small' status='danger' disabled={forgetIn > 0 || busy} onClick={() => void forget()}>
              {forgetIn > 0 ? `忘记（${forgetIn}s 后可用）` : '忘记'}
            </Button>
            <Button type='primary' size='small' disabled={busy} onClick={() => setFlipped(true)}>翻面对照</Button>
          </div>
        </>
      ) : (
        <>
          <div className='lh-quote lh-quote-lg'>
            <InlineMd text={frontIsCloze ? clozeBack(card.content) : card.content} />
          </div>
          <div className='lh-gap-8 lh-end lh-row lh-wrap'>
            <Text type='secondary' className='lh-t-12'>对照自己当初的表述——记得多牢？自评推进（快捷键 2/3/4）</Text>
            <Button size='small' disabled={busy} onClick={() => void rate(2)}>Hard</Button>
            <Button size='small' type='primary' disabled={busy} onClick={() => void rate(3)}>Good</Button>
            <Button size='small' status='success' disabled={busy} onClick={() => void rate(4)}>Easy</Button>
          </div>
        </>
      )}
    </div>
  )
}
