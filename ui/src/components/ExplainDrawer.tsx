/** 「讲给我听」抽屉（E2 #68 / ADR-0009 Learner Output）：
 * 学习者用自己的话开讲 → AI 扮完全不懂的初学者按正文要点追问（抓含糊/跳跃/说错，
 * 不评分不超纲，可「换一种问」）→ 收尾点「定位反馈」给 是非+定位+可怎么补（判词只入
 * E 档案，零 XP）→ 可选「存成我的卡」（再讲一遍/挖空重述两档，入 E1 池独立调度）。
 * 打字入口 v1；语音留后续。整个入口自愿：随时关闭即结束（会话不落盘）。 */
import { Button, Drawer, Empty, Input, Message, Radio, Spin, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import MdView from './MdView'

const { Text } = Typography

interface Turn { role: 'user' | 'assistant'; content: string }

interface Verdict { verdict: string; tags: string[]; advice: string; reply: string }

const VERDICT_COLOR: Record<string, string> = { 对: 'green', 部分对: 'orange', 错: 'red' }
const TAG_COLOR: Record<string, string> = { 含糊: 'orange', 跳跃: 'purple', 说错: 'red' }

export default function ExplainDrawer(props: {
  course: string
  node: string
  visible: boolean
  onClose: () => void
}) {
  const [messages, setMessages] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Verdict | null>(null)
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveKind, setArchiveKind] = useState<'recall_cue' | 'cloze_rewrite'>('recall_cue')
  const [archiveText, setArchiveText] = useState('')
  const [archiveBusy, setArchiveBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // 换节点/重开清空会话（讲解随节点走，跨节点无意义）
  useEffect(() => {
    if (props.visible) {
      setMessages([]); setInput(''); setFeedback(null)
      setArchiveOpen(false); setArchiveText(''); setArchiveKind('recall_cue')
    }
  }, [props.visible, props.course, props.node])
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy, feedback])

  /** 讲稿/回答发送：讲稿是第一轮，之后每轮都是初学者追问的回答。 */
  const send = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || busy) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    if (!override) setInput('')
    setBusy(true)
    try {
      const r = await api.explainBack(props.course, props.node, next)
      setMessages(m => [...m, { role: 'assistant', content: r.answer }])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
      setMessages(messages)
    } finally {
      setBusy(false)
    }
  }

  /** 定位反馈：完整对话发回引擎判词（对/部分对/错 + 定位标签 + 可怎么补）。 */
  const askFeedback = async () => {
    if (feedbackBusy || !messages.some(m => m.role === 'user')) return
    setFeedbackBusy(true)
    try {
      const transcript = messages
        .map(m => `${m.role === 'assistant' ? '[初学者]' : '[学习者]'} ${m.content}`)
        .join('\n\n')
      const v = await api.explainFeedback(props.course, props.node, transcript)
      setFeedback(v)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setFeedbackBusy(false)
    }
  }

  /** 存成我的卡：默认「再讲一遍」；挖空重述需自带 {{…}} 挖空。 */
  const archive = async () => {
    const content = archiveText.trim() || lastLearnerText
    if (!content) return
    setArchiveBusy(true)
    try {
      const r = await api.explainArchive(props.course, props.node, content, { kind: archiveKind })
      Message.success(`已存为我的卡 ${r.id}（E 池独立复习，不碰掌握度/XP）`)
      setArchiveOpen(false)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setArchiveBusy(false)
    }
  }

  const lastLearnerText = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''

  return (
    <Drawer
      width={520} visible={props.visible} footer={null} unmountOnExit
      headerStyle={{ border: 'none' }}
      title={<Text>讲给我听 · {props.node}</Text>}
      onCancel={props.onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: 'calc(100vh - 140px)' }}>
        <Text type='secondary' style={{ fontSize: 12 }}>
          用你自己的话把这节课讲明白，AI 扮完全不懂的初学者只追问、不评分；讲完点「定位反馈」看哪里含糊/跳跃/说错。自愿参与，随时关闭。
        </Text>
        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 4 }}>
          {messages.length === 0 && (
            <Empty description='把这一课讲给我听吧——就当我是完全不懂的人。' />
          )}
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
              maxWidth: m.role === 'user' ? '85%' : '100%',
              background: m.role === 'user' ? 'var(--color-primary-light-1,#e8f3ff)' : 'var(--color-fill-1,#f7f8fa)',
              borderRadius: 8, padding: '8px 12px',
            }}>
              <Text type='secondary' style={{ fontSize: 11 }}>{m.role === 'user' ? '我' : '初学者'}</Text>
              {m.role === 'user'
                ? <Text style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{m.content}</Text>
                : <MdView md={m.content} />}
            </div>
          ))}
          {busy && <Spin dot style={{ alignSelf: 'flex-start' }} />}
          {feedback && (
            <div style={{
              border: '1px solid var(--color-border-2,#e5e6eb)', borderRadius: 8,
              padding: '10px 12px', background: 'var(--color-fill-2,#f2f3f5)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Tag color={VERDICT_COLOR[feedback.verdict] ?? 'gray'}>对照要点：{feedback.verdict}</Tag>
                {feedback.tags.map(t => <Tag key={t} color={TAG_COLOR[t] ?? 'gray'}>{t}</Tag>)}
              </div>
              <MdView md={feedback.reply} />
              {feedback.advice && (
                <Text style={{ fontSize: 13 }}>可怎么补：{feedback.advice}</Text>
              )}
              <Text type='secondary' style={{ fontSize: 11 }}>
                判词只记入你的产出档案——零 XP、不进掌握度、不影响任何调度。
              </Text>
            </div>
          )}
        </div>
        {archiveOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: '1px dashed var(--color-border-2,#e5e6eb)', borderRadius: 8, padding: 10 }}>
            <Radio.Group value={archiveKind} onChange={v => setArchiveKind(v)} size='small'>
              <Radio value='recall_cue'>再讲一遍（默认）</Radio>
              <Radio value='cloze_rewrite'>挖空重述（内容需含 {'{{…}}'}）</Radio>
            </Radio.Group>
            <Input.TextArea
              value={archiveText} onChange={setArchiveText}
              placeholder={archiveKind === 'cloze_rewrite'
                ? '把这版讲稿整理成挖空句，如：求和公式是 {{(a₁+aₙ)×n÷2}}，原因是…'
                : '可再整理一版讲稿再存（留空 = 存最后一版原话）'}
              autoSize={{ minRows: 2, maxRows: 6 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type='primary' size='small' loading={archiveBusy}
                disabled={archiveKind === 'cloze_rewrite' && !(archiveText.trim() || lastLearnerText).includes('{{')}
                onClick={() => void archive()}>存入我的卡</Button>
              <Button size='small' type='text' onClick={() => setArchiveOpen(false)}>取消</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <Input.TextArea
              value={input} onChange={setInput}
              placeholder='开讲（Enter 发送；讲完点右下「定位反馈」）'
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={busy}
              onPressEnter={e => {
                if (!e.shiftKey) { e.preventDefault(); void send() }
              }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Button type='primary' size='small' loading={busy} disabled={!input.trim()} onClick={() => void send()}>发送</Button>
              {messages.some(m => m.role === 'assistant') && (
                <Button size='mini' type='text' disabled={busy} onClick={() => void send('换一种问')}>换一种问</Button>
              )}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {!archiveOpen && (
            <Button size='small' disabled={!lastLearnerText} onClick={() => { setArchiveText(''); setArchiveOpen(true) }}>
              存成我的卡
            </Button>
          )}
          <Button type='primary' size='small' status='success' loading={feedbackBusy}
            disabled={!messages.some(m => m.role === 'user')} onClick={() => void askFeedback()}>
            定位反馈
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
