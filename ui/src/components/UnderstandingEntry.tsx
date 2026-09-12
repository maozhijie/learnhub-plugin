/** 「加我的理解」节级入口（E1 #70，LessonView 页内伴生组件）：写一句自己的
 * 解释/例子/助记 → AI 对照该节要点给是非 + 定位（含糊/跳跃/说错）+ 可怎么补 →
 * 存为「我的卡」（独立域自调度，零 XP、不进掌握度）。判词反馈就地展示；
 * 同节可多次写（同内容去重在引擎侧）。 */
import { Button, Input, Message, Select, Space, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import MdView from './MdView'
import { api } from '../api'
import { errorMessage } from '../hooks/useCommand'
import type { UnderstandingResult } from '../types'

const { Text } = Typography

const NOTE_KINDS = [
  { value: 'recall_cue', label: '提示重述' },
  { value: 'cloze_rewrite', label: '挖空重述' },
  { value: 'self_explain', label: '自注讲解' },
] as const

const VERDICT_TAG: Record<string, { color: string }> = {
  对: { color: 'green' },
  部分对: { color: 'orange' },
  错: { color: 'red' },
}

export default function UnderstandingEntry(props: {
  course: string
  node: string
  sectionId: string
  existingCount: number
  onAdded: () => void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'recall_cue' | 'cloze_rewrite' | 'self_explain'>('recall_cue')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UnderstandingResult | null>(null)

  const save = async () => {
    setBusy(true)
    try {
      const r = await api.understandingAdd(props.course, props.node, text.trim(), {
        kind,
        section: props.sectionId,
      })
      setResult(r)
      setText('')
      setOpen(false)
      Message.success('已存入「我的卡」（可在学习中心页复习）')
      props.onAdded()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const clozeMissing = kind === 'cloze_rewrite' && !/\{\{[^{}]+\}\}/.test(text)

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {!open && (
          <Button size='mini' type='text' status='success' onClick={() => setOpen(true)}>
            ＋ 加我的理解
          </Button>
        )}
        {props.existingCount > 0 && (
          <Tooltip content='这一节你已写过的理解（在「我的卡」队列复习）'>
            <Tag size='small' color='green'>我的卡 ×{props.existingCount}</Tag>
          </Tooltip>
        )}
      </div>
      {open && (
        <div style={{
          border: '1px solid var(--color-success-3,#00d0b6)', background: 'var(--color-fill-1,#f7f8fa)',
          borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 680,
        }}>
          <Space size={6} wrap>
            <Select value={kind} onChange={v => setKind(v as typeof kind)} size='mini' style={{ width: 120 }}>
              {NOTE_KINDS.map(k => <Select.Option key={k.value} value={k.value}>{k.label}</Select.Option>)}
            </Select>
            <Text type='secondary' style={{ fontSize: 12 }}>
              用你的话写一句这一节的解释 / 例子 / 助记；挖空重述请用 {'{{…}}'} 标出挖空。保存后 AI 会对照该节要点给反馈。
            </Text>
          </Space>
          <Input.TextArea
            value={text} onChange={setText}
            placeholder='如：等差数列就是每一步加固定的数……'
            autoSize={{ minRows: 2, maxRows: 6 }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size='small' type='text' onClick={() => setOpen(false)}>收起</Button>
            <Button size='small' type='primary' status='success' loading={busy}
              disabled={!text.trim() || clozeMissing} onClick={() => void save()}>
              保存并获取反馈
            </Button>
          </div>
        </div>
      )}
      {result && (
        <div style={{
          borderLeft: `3px solid var(--color-${VERDICT_TAG[result.verdict.verdict]?.color ?? 'gray'}-6,#86909c)`,
          background: 'var(--color-fill-1,#f7f8fa)', borderRadius: '0 6px 6px 0',
          padding: '8px 12px', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 680,
        }}>
          <Space size={6} wrap>
            <Tag size='small' color={VERDICT_TAG[result.verdict.verdict]?.color}>{result.verdict.verdict}</Tag>
            {result.verdict.tags.map(t => <Tag key={t} size='small' color='orange'>{t}</Tag>)}
            {result.verdict.advice && <Text type='secondary' style={{ fontSize: 12 }}>可怎么补：{result.verdict.advice}</Text>}
          </Space>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}><MdView md={result.reply} /></div>
          <Text type='secondary' style={{ fontSize: 12 }}>
            这条理解已存为「我的卡」（{NOTE_KINDS.find(k => k.value === result.card.kind)?.label}），判词只入档案——不计 XP、不影响掌握度。
          </Text>
        </div>
      )}
    </div>
  )
}
