/** 「错误对比卡」卡面（C-3 #82，独立于判卷型 QuestionCard 与自评型 LearnerCardCard）：
 * 三选一辨别卡——一项是正确做法、一项是学习者自己的错法、一项是干扰做法。选一项即
 * 判分推进（自动判分：选对=3/选错=1，一卡一天一次，引擎侧结算）；选后揭晓对照——
 * 正确项高亮、错法项标「你的错法」、展示解析。作答即判分，无忘记申报、无自评档。 */
import { Alert, Button, Tag, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { InlineMd } from './MdView'
import type { ErrorCardFace } from '../types'

const { Text } = Typography

const LETTERS = ['A', 'B', 'C']

export default function ErrorCardCard(props: {
  card: ErrorCardFace
  /** 三选一作答（引擎判分结算）；解析与揭晓面随结果返回。 */
  onAnswer: (choice: string) => Promise<{ correct: boolean; answer: string; mine: string; explanation: string }>
}) {
  const { card } = props
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ correct: boolean; answer: string; mine: string; explanation: string } | null>(null)

  const pick = async (choice: string) => {
    if (busy || reveal) return
    setBusy(true)
    setPicked(choice)
    try {
      const r = await props.onAnswer(choice)
      setReveal(r)
    } finally {
      setBusy(false)
    }
  }

  /** 选项状态：未揭晓 = 中性；揭晓后正确项绿、学习者的错法项橙标「你的错法」。 */
  const optionState = (opt: string): 'idle' | 'correct' | 'mine' | 'plain' => {
    if (!reveal) return 'idle'
    if (opt === reveal.answer) return 'correct'
    if (opt === reveal.mine) return 'mine'
    return 'plain'
  }

  return (
    <div className='lh-border lh-r-md lh-p-10px-12px lh-col lh-gap-10'>
      <div className='lh-gap-8 lh-row lh-wrap'>
        <Tag size='small' color='orange'>错误对比卡</Tag>
        <Text type='secondary' className='lh-t-12'>{card.course} · {card.node}</Text>
        {card.source_section && <Text type='secondary' className='lh-t-12'>· {card.source_section}</Text>}
        {card.due && <Tag size='small'>到期 {card.due}</Tag>}
        {card.attempts > 0 && <Tag size='small'>推进过 {card.attempts} 次</Tag>}
      </div>

      <div className='lh-t-15 lh-lh-1p75'>
        <InlineMd text={card.q} />
      </div>

      {!reveal ? (
        <>
          <Text type='secondary' className='lh-t-12'>
            三个做法里只有一个是正确的——其中另一个正是你上次的错法。凭直觉选，选错不加罚。
          </Text>
          <div className='lh-col lh-gap-8'>
            {card.options.map((opt, i) => (
              <Button key={i} long size='default' disabled={busy} className='lh-justify-start lh-text-left'
                onClick={() => void pick(opt)}>
                <span className='lh-strong lh-mr-8'>{LETTERS[i]}</span>
                <InlineMd text={opt} />
              </Button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className='lh-col lh-gap-6'>
            {card.options.map((opt, i) => {
              const st = optionState(opt)
              return (
                <div key={i} style={{
                  borderRadius: 6, padding: '8px 10px', lineHeight: 1.7,
                  border: `1px solid ${st === 'correct' ? 'var(--color-success-6,#00b42a)' : st === 'mine' ? 'var(--color-warning-6,#ff7d00)' : 'var(--color-border-2,#e5e6eb)'}`,
                  background: st === 'correct' ? 'var(--color-success-light-1,#e8ffea)'
                    : st === 'mine' ? 'var(--color-warning-light-1,#fff7e8)' : 'transparent',
                  opacity: st === 'plain' ? 0.75 : 1,
                }}>
                  <span className='lh-strong lh-mr-8'>{LETTERS[i]}</span>
                  <InlineMd text={opt} />
                  {st === 'correct' && <Tag size='small' color='green' className='lh-ml-8'>正确做法</Tag>}
                  {st === 'mine' && <Tag size='small' color='orange' className='lh-ml-8'>你的错法</Tag>}
                  {picked === opt && !reveal.correct && st !== 'correct' && st !== 'mine'
                    && <Tag size='small' className='lh-ml-8'>你选的</Tag>}
                </div>
              )
            })}
          </div>
          <Alert type={reveal.correct ? 'success' : 'warning'}
            content={reveal.correct ? '辨对了——错法已被你识破。' : '选到了错法（或干扰项）——正好把它再认清一遍。'} />
          <div className='lh-quote lh-quote-lg'>
            <InlineMd text={reveal.explanation} />
          </div>
        </>
      )}
    </div>
  )
}
