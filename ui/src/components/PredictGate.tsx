/** 预测门（P-8 #97，专家思维轨迹节的阅读流交互门）：正文里的 learnhub-predict
 * 机器块渲染为「先预测再揭晓」——学习者先凭直觉选一个做法（不记分、零写入），
 * 选后才揭示正确项与元评论，并放行块后正文继续阅读。预测是承诺装置不是测验：
 * 答对答错都不奖不罚，与 JOL 抽查（调度面配对采样）无关。 */
import { Button, Tag, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PredictBlock } from '../../../shared/content-renderers'

const { Text } = Typography

const LETTERS = ['A', 'B', 'C', 'D']

export default function PredictGate(props: { parsed: PredictBlock; after: ReactNode }) {
  const { parsed } = props
  const [picked, setPicked] = useState<string | null>(null)
  const done = picked !== null

  return (
    <div style={{
      border: `1px dashed ${done ? 'var(--color-success-6,#00b42a)' : 'var(--color-primary-6,#165dff)'}`,
      borderRadius: 8, padding: '12px 14px', margin: '10px 0',
      display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--color-fill-2,#f2f3f5)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tag size='small' color={done ? 'green' : 'arcoblue'}>预测门</Tag>
        <Text type='secondary' style={{ fontSize: 12 }}>
          {done ? '已揭晓——继续往下读' : '先别往下看。凭直觉预测专家的下一步，选一个再看答案（不记分）'}
        </Text>
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{parsed.q}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {parsed.options.map((opt, i) => {
          const isAnswer = opt === parsed.answer
          const isPicked = opt === picked
          const state = !done ? 'idle'
            : isAnswer ? 'answer'
              : isPicked ? 'picked' : 'dim'
          const background = state === 'answer' ? 'var(--color-success-light-1,#e8ffea)'
            : state === 'picked' ? 'var(--color-warning-light-1,#fff7e8)'
              : state === 'dim' ? 'transparent' : 'var(--color-bg-2,#fff)'
          const borderColor = state === 'answer' ? 'var(--color-success-6,#00b42a)'
            : state === 'picked' ? 'var(--color-warning-6,#ff7d00)'
              : 'var(--color-border-2,#e5e6eb)'
          return done ? (
            <div key={i} style={{ borderRadius: 6, padding: '8px 10px', lineHeight: 1.7, background, border: `1px solid ${borderColor}`, opacity: state === 'dim' ? 0.7 : 1 }}>
              <span style={{ fontWeight: 600, marginRight: 8 }}>{LETTERS[i]}</span>
              <span style={{ whiteSpace: 'pre-wrap' }}>{opt}</span>
              {state === 'answer' && <Tag size='small' color='green' style={{ marginLeft: 8 }}>正确</Tag>}
              {state === 'picked' && <Tag size='small' color='orange' style={{ marginLeft: 8 }}>你的预测</Tag>}
            </div>
          ) : (
            <Button key={i} long style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => setPicked(opt)}>
              <span style={{ fontWeight: 600, marginRight: 8 }}>{LETTERS[i]}</span>
              <span style={{ whiteSpace: 'pre-wrap' }}>{opt}</span>
            </Button>
          )
        })}
      </div>
      {done && parsed.why && (
        <div style={{
          borderLeft: '3px solid var(--color-primary-6,#165dff)', background: 'var(--color-fill-1,#f7f8fa)',
          borderRadius: '0 6px 6px 0', padding: '8px 12px', fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap',
        }}>{parsed.why}</div>
      )}
      {/* 块后正文：门未过不渲染（阅读流被挡住），揭晓后放行 */}
      {done && props.after}
    </div>
  )
}
