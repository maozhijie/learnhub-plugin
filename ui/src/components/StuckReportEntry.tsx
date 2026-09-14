/** 「我卡住了」卡点自报入口（ADR-0077 #248，LessonView 页内伴生组件）：阅读当下
 * 自由文本写下卡在哪里——唯一录入形态，原话逐字落 practice 流水（零结构化），
 * 落账成功即触发一次 force 教练回合（回执就地呈现；在途时如实说明不重复入队）。
 * 同节点每学习日 1 条、全课程每日总量上限（服务端 params 集中），频控拒绝带原因
 * 就地提示（回执为拒绝态、输入保留）。零 XP 零激励——不进任何 canonical/Mastery/
 * FSRS/完成判据。 */
import { Button, Input, Space, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../api'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

export default function StuckReportEntry(props: { course: string; node: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ kind: 'ok' | 'rejected'; queued?: boolean; text: string } | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.stuckReport(props.course, props.node, text.trim())
      // queued=false（在途拒重复入队 / 入队失败）：留了账但无新回合，不弹成功框
      // （#155 诚实着色惯例——非 queued 的 ok 是警示而非成就）
      setReceipt({ kind: 'ok', queued: r.queued, text: r.message })
      setText('')
      setOpen(false)
    } catch (err) {
      // 频控拒绝等失败：回执就地呈现拒绝原因，输入保留（改改再试）
      setReceipt({ kind: 'rejected', text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='lh-mt-6' data-testid='stuck-report-entry'>
      {!open && (
        <Button size='mini' type='text' status='warning'
          onClick={() => { setReceipt(null); setOpen(true) }}>
          我卡住了？
        </Button>
      )}
      {open && (
        <div className='lh-callout-warn'>
          <Text type='secondary' className='lh-t-12'>
            卡点自报：用你自己的话写下卡在哪里——跨节引用、模糊指代、情绪化描述都可以，原话逐字保存。
            提交后立即启动一次教练回合帮你归因；不计 XP、不影响掌握度。
          </Text>
          <Input.TextArea
            value={text} onChange={setText}
            placeholder='如：这节的 XXX 和上一节的 YYY 对不上，我不知道差在哪……'
            autoSize={{ minRows: 2, maxRows: 6 }} />
          <Space size={8}>
            <Button size='small' type='text' onClick={() => setOpen(false)}>收起</Button>
            <Button size='small' type='primary' status='warning' loading={busy}
              disabled={!text.trim()} onClick={() => void submit()}>
              提交给教练
            </Button>
          </Space>
        </div>
      )}
      {receipt && (
        <div className={receipt.kind === 'rejected' ? 'lh-callout-danger'
          : receipt.queued ? 'lh-callout-ok' : 'lh-callout-warn'}
          data-testid='stuck-report-receipt'>
          <Text type={receipt.kind === 'rejected' ? 'error' : 'secondary'} className='lh-t-12'>{receipt.text}</Text>
        </div>
      )}
    </div>
  )
}
