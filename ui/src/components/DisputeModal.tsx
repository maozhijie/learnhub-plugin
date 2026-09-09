/** 瑕疵题申诉模态（ADR-0031）：把「题目错了」从无处安放的吐槽变成有出口、有裁决、
 * 有记账冲正的动作。判错后提交申诉 → 引擎 LLM 两阶段复核（先独立解题再对账）→
 * 三态裁定：key_error（键错，确认后改键并用新键重判原作答，可改判为对）/
 * defective（题面坏，作废本次判罚，归档重出由父级接手）/ ok（题没问题，可二次
 * 确认强制豁免——豁免是「不算」，永不产生得分）。复核输出不可用时放行「跳过复核
 * 直接豁免」降级入口（引擎侧复核只读，失败即整体不落盘）。 */
import { Button, Input, Message, Modal, Popconfirm, Space, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { InlineMd } from './MdView'

const { Text } = Typography

export interface DisputeTarget {
  course: string
  node: string
  qid: string
  kind: string
}

/** 结算回执：resolution + 改判结果 + XP 净值 + 申诉理由（父级作废重出时用作生成指令）。 */
export interface DisputeSettled {
  resolution: 'rekey' | 'void' | 'overridden'
  correctNow: boolean | null
  /** 该作答冲正后的 XP 净值（改判对 = 补记值；作废/豁免 = 0）。 */
  xp: number
  reason: string
}

const VERDICT_TAG: Record<string, { color: string; text: string }> = {
  key_error: { color: 'red', text: '复核结论：答案键错了' },
  defective: { color: 'orange', text: '复核结论：题面有毛病' },
  ok: { color: 'green', text: '复核结论：题与答案都没问题' },
}

const RULE_KINDS = new Set(['single_choice', 'multi_choice', 'true_false', 'fill_in_blank', 'numeric', 'ordering', 'matching'])

export default function DisputeModal(props: {
  target: DisputeTarget | null
  onClose: () => void
  /** 结算成功后回调（父级做会话内判罚恢复；void 链路归档重出）。 */
  onSettled?: (r: DisputeSettled) => void
}) {
  const [reason, setReason] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [fallbackable, setFallbackable] = useState(false)
  const [review, setReview] = useState<Awaited<ReturnType<typeof api.questionDisputeReview>> | null>(null)
  const runIdRef = useRef(0)

  const runReview = async () => {
    if (!props.target || reviewing) return
    const runId = ++runIdRef.current
    setReviewing(true)
    setReviewError('')
    setFallbackable(false)
    try {
      const r = await api.questionDisputeReview(props.target.course, props.target.node, props.target.qid)
      if (runId === runIdRef.current) setReview(r)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (runId === runIdRef.current) {
        setReviewError(msg)
        setFallbackable(msg.includes('AI 复核输出不可用'))
      }
    } finally {
      if (runId === runIdRef.current) setReviewing(false)
    }
  }

  const visible = !!props.target
  useEffect(() => {
    if (visible) {
      setReview(null)
      setReviewError('')
      setFallbackable(false)
      setReason('')
      void runReview()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const apply = async (resolution: 'rekey' | 'void' | 'overridden', revision?: { answer?: unknown; explanation?: string }) => {
    if (!props.target || applying) return
    setApplying(true)
    try {
      const r = await api.questionDisputeApply(props.target.course, props.target.node, props.target.qid, resolution, {
        ...(review ? { targetTs: review.target_ts } : {}),
        ...(revision ? { revision } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      if (resolution === 'rekey') {
        Message.success(r.correct_now
          ? `已改键并改判为对（补记 ${r.xp} XP）`
          : '已改键；原作答与新键仍不符，判罚维持')
      } else if (resolution === 'void') {
        Message.success('本次判罚已作废（不入对错、XP 归零）；旧题将归档并按你的理由重出一题')
      } else {
        Message.info('已豁免本题（不计对错、零 XP）；题目保留在复习调度里')
      }
      props.onSettled?.({ resolution, correctNow: r.correct_now, xp: r.xp, reason: reason.trim() })
      props.onClose()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const vt = review ? VERDICT_TAG[review.verdict] : null
  return (
    <Modal
      title={`题目有误？· ${props.target?.qid ?? ''}`}
      visible={visible}
      onCancel={props.onClose}
      footer={null}
      width={580}
      unmountOnExit>
      <Space direction='vertical' style={{ width: '100%' }} size={10}>
        <Input.TextArea
          value={reason} onChange={setReason}
          placeholder='你的理由（可选）：如「选项 A 说……但正文讲的是……」。留痕进勘误记录；作废重出时作为新题的生成指令'
          autoSize={{ minRows: 2, maxRows: 4 }} />

        {reviewing && (
          <Text type='secondary'>AI 正在独立解题并对账，通常需要十几秒……</Text>
        )}

        {reviewError && (
          <>
            <Text type='danger' style={{ fontSize: 13 }}>复核失败：{reviewError}</Text>
            <Space size={8}>
              <Button size='small' loading={reviewing} onClick={() => void runReview()}>重试复核</Button>
              {fallbackable && (
                <Popconfirm
                  title='跳过复核直接豁免？'
                  content='本次判罚将按作废口径冲正：不入对错、XP 归零（不得分）；题目保留在调度里。'
                  onOk={() => void apply('overridden')}>
                  <Button size='small' status='warning'>跳过复核，直接豁免</Button>
                </Popconfirm>
              )}
            </Space>
          </>
        )}

        {review && vt && (
          <>
            <Space size={8} wrap>
              <Tag color={vt.color}>{vt.text}</Tag>
              <Button size='mini' type='text' loading={reviewing} onClick={() => { setReview(null); void runReview() }}>重新复核</Button>
            </Space>
            <div style={{
              borderLeft: '3px solid var(--color-border-3,#c9cdd4)', background: 'var(--color-fill-1,#f7f8fa)',
              borderRadius: '0 6px 6px 0', padding: '8px 12px', fontSize: 13, lineHeight: 1.7,
              maxHeight: 260, overflow: 'auto',
            }}>
              <InlineMd text={review.reasoning} />
            </div>
            <Text type='secondary' style={{ fontSize: 12 }}>
              当前答案键：{review.current_answer}
            </Text>
            {review.verdict === 'key_error' && (
              <Space direction='vertical' size={6} style={{ width: '100%' }}>
                <Text type='secondary' style={{ fontSize: 12 }}>
                  建议新键：{Array.isArray(review.suggested_answer) ? review.suggested_answer.join('、') : String(review.suggested_answer)}
                  {review.suggested_explanation ? '（附新解析）' : ''}
                </Text>
                <Space size={8}>
                  <Button type='primary' size='small' loading={applying}
                    onClick={() => void apply('rekey', {
                      answer: review.suggested_answer,
                      ...(review.suggested_explanation ? { explanation: review.suggested_explanation } : {}),
                    })}>
                    改键并重判我的作答
                  </Button>
                  <Text type='secondary' style={{ fontSize: 12 }}>原作答符合新键则改判为对（补 XP）</Text>
                </Space>
              </Space>
            )}
            {review.verdict === 'defective' && (
              <Space size={8}>
                <Popconfirm
                  title='作废本题并重出？'
                  content='本次判罚作废（不入对错、XP 归零）；旧题归档（可逆），AI 按你的理由为本节重出一道新题。'
                  onOk={() => void apply('void')}>
                  <Button type='primary' size='small' loading={applying}>作废本次判罚并归档重出</Button>
                </Popconfirm>
              </Space>
            )}
            {review.verdict === 'ok' && (
              <Space size={8} wrap>
                <Popconfirm
                  title='仍要豁免本题？'
                  content='复核认为题目与答案都没问题。强制豁免按作废口径冲正（不计对错、XP 归零，不得分）；题目保留在复习调度里。'
                  onOk={() => void apply('overridden')}>
                  <Button size='small' status='warning' loading={applying}>仍要豁免本题（不得分）</Button>
                </Popconfirm>
                <Text type='secondary' style={{ fontSize: 12 }}>最终解释权在你——但豁免只是「不算」，不是「算你对」</Text>
              </Space>
            )}
          </>
        )}
      </Space>
    </Modal>
  )
}

/** 该题型是否走规则判卷（申诉入口只在规则题型展示；AI 题型已有讲解通道）。 */
export function isRuleKind(kind: string): boolean {
  return RULE_KINDS.has(kind)
}
