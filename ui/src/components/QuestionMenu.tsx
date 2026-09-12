/** 会话内单题「…」菜单（#120）：编辑 / 归档（恢复）/ 提意见重生成 / 题目有误申诉（ADR-0031）。
 * 编辑复用 QuestionEditDrawer（与题库管理页同一编辑面，questionUpdate 白名单门禁）；
 * 归档走 questionArchive（可逆），归档题经 questions 刷新立即退出会话选题与轮次；
 * 提意见重生成 = 归档旧题 + 携意见定向生成新题（同节定向，复用定向补生成通道，
 * 意见作为生成指令注入提示词；意图分类一键填入）。调度语义按 ADR-0028：新题是全新
 * 调度卡、从零调度，不迁移旧题 FSRS 状态；文案明示「新题将重新开始复习调度」。
 * 申诉与提意见分离：申诉 = 对判罚有异议（LLM 复核 → 改判/作废/豁免），
 * 提意见 = 只是想要一道更好的题（不触发复核）。 */
import { Button, Dropdown, Input, Menu, Message, Modal, Space, Tag, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../api'
import DisputeModal, { isRuleKind } from './DisputeModal'
import type { DisputeSettled } from './DisputeModal'
import QuestionEditDrawer from './QuestionEditDrawer'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

/** 提意见的意图分类（一键填入，可再编辑）：把「哪里不满意」结构化，重出指令更好用。 */
const FEEDBACK_INTENTS = ['题意含糊，条件不清', '难度不合适', '换个应用角度', '与正文讲法冲突']

export interface QuestionMenuTarget {
  course: string
  node: string
  qid: string
  kind: string
  q: string
  difficulty: number
  options?: string[]
  /** 提意见重生成的定向节（会话轮次携带；缺省 = 不提供重生成入口）。 */
  section?: { id: string; title: string }
}

export default function QuestionMenu(props: {
  target: QuestionMenuTarget
  /** 任一操作落地后回调（父级静默刷新 questions，轮次重建/新题并入随之发生）。 */
  onMutated: () => void
  /** 瑕疵题申诉结算回调（ADR-0031）：父级做会话内判罚恢复与作废重出链路。 */
  onDisputed?: (r: DisputeSettled) => void
}) {
  const [editing, setEditing] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [disputeTarget, setDisputeTarget] = useState(false)
  const [busy, setBusy] = useState(false)

  const doArchive = async () => {
    setBusy(true)
    try {
      await api.questionArchive(props.target.course, props.target.node, props.target.qid, true)
      Message.success(`已归档 ${props.target.qid}（可在题目管理页恢复）`)
      props.onMutated()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 意见重生成：先归档旧题（可逆），再携意见定向出一道同节新题（任务化入队）。 */
  const doFeedbackRegen = async () => {
    const text = feedback.trim()
    if (!text) return
    setBusy(true)
    try {
      await api.questionArchive(props.target.course, props.target.node, props.target.qid, true)
      const r = await api.questionGenerate(
        props.target.course, props.target.node, 1,
        { section: props.target.section, instruction: text })
      Message.info(`已归档旧题并提交重生成任务：${r.message}`)
      setFeedback('')
      setFeedbackOpen(false)
      props.onMutated()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 归档确认用 Modal.confirm（Dropdown 收起会连带卸载 Popconfirm 弹层，这里用命令式确认更稳）。 */
  const confirmArchive = () => {
    Modal.confirm({
      title: `归档「${props.target.qid}」？`,
      content: '归档后立即退出会话与复习调度，题目管理页可恢复。',
      okText: '归档',
      cancelText: '取消',
      onOk: () => doArchive(),
    })
  }

  return (
    <span onClick={e => e.stopPropagation()}>
      <Dropdown
        trigger='click'
        droplist={
          <Menu style={{ minWidth: 148 }}>
            <Menu.Item key='edit' onClick={() => setEditing(true)}>编辑本题</Menu.Item>
            {isRuleKind(props.target.kind) && (
              <Menu.Item key='dispute' onClick={() => setDisputeTarget(true)}>题目有误（申诉）</Menu.Item>
            )}
            <Menu.Item key='regen' disabled={!props.target.section} onClick={() => setFeedbackOpen(true)}>
              提意见，重出一题
            </Menu.Item>
            <Menu.Item key='archive' onClick={confirmArchive}>归档本题</Menu.Item>
          </Menu>
        }>
        <Button size='mini' type='text' loading={busy} style={{ padding: '0 6px' }}>…</Button>
      </Dropdown>

      <QuestionEditDrawer
        target={editing ? props.target : null}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false)
          Message.info('题目已更新，会话内下次出卡生效')
          props.onMutated()
        }} />

      <Modal
        title={`提意见重出 · ${props.target.qid}`}
        visible={feedbackOpen}
        onCancel={() => setFeedbackOpen(false)}
        footer={null} unmountOnExit>
        <Space direction='vertical' style={{ width: '100%' }} size={10}>
          <Text type='secondary'>
            旧题将归档（可逆），AI 按你的意见为本节重出一道新题。新题将重新开始复习调度
            （不继承旧题节奏）；恢复旧题即接续原节奏。
          </Text>
          <Space size={6} wrap>
            {FEEDBACK_INTENTS.map(intent => (
              <Tag key={intent} size='small' color='arcoblue' style={{ cursor: 'pointer' }}
                onClick={() => setFeedback(intent)}> {intent}</Tag>
            ))}
          </Space>
          <Input.TextArea
            value={feedback} onChange={setFeedback}
            placeholder='如：这道题题意含糊，请把条件说清楚；或：换一个更贴近实际应用的角度出'
            autoSize={{ minRows: 3, maxRows: 6 }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size='small' onClick={() => setFeedbackOpen(false)}>取消</Button>
            <Button size='small' type='primary' loading={busy}
              disabled={!feedback.trim()} onClick={() => void doFeedbackRegen()}>
              归档旧题并重出
            </Button>
          </div>
        </Space>
      </Modal>

      <DisputeModal
        target={disputeTarget
          ? { course: props.target.course, node: props.target.node, qid: props.target.qid, kind: props.target.kind }
          : null}
        onClose={() => setDisputeTarget(false)}
        onSettled={r => {
          Message.info('申诉已结算')
          props.onMutated()
          props.onDisputed?.(r)
        }} />
    </span>
  )
}
