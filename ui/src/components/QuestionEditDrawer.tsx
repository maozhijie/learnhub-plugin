/** 单题编辑抽屉（共享组件，#120）：题库管理页（BankPage）与会话内「…」菜单复用
 * 同一编辑面；保存走 questionUpdate（既有白名单门禁）。题目列表接口不含答案
 * （防泄漏）——答案留空 = 不修改，填写才覆盖。 */
import { Button, Drawer, Input, Message, Space, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { errorMessage } from '../hooks/useCommand'

const { Text } = Typography

/** 编辑目标的最小形状：题库条目与会话题目各自映射传入。 */
export interface QuestionEditTarget {
  course: string
  node: string
  qid: string
  kind: string
  q: string
  difficulty: number
  options?: string[]
}

export default function QuestionEditDrawer(props: {
  target: QuestionEditTarget | null
  onClose: () => void
  onSaved: () => void
}) {
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState('')
  const [explanation, setExplanation] = useState('')
  const [difficulty, setDifficulty] = useState(1)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (props.target) {
      const e = props.target
      setQ(e.q)
      setAnswer('')
      setExplanation('')
      setDifficulty(e.difficulty)
    }
  }, [props.target])

  const save = async () => {
    if (!props.target) return
    setBusy(true)
    try {
      // 答案留空 = 不修改，填写才覆盖
      const patch: Record<string, unknown> = { q: q.trim(), difficulty }
      if (explanation.trim()) patch.explanation = explanation.trim()
      if (answer.trim()) {
        const k = props.target.kind
        if (k === 'true_false') patch.answer = answer.trim() === 'true'
        else if (k === 'fill_in_blank' || k === 'multi_choice' || k === 'ordering' || k === 'matching') {
          patch.answer = answer.split('|').map(s => s.trim()).filter(Boolean)
        } else patch.answer = answer.trim()
      }
      await api.questionUpdate(props.target.course, props.target.node, props.target.qid, patch)
      Message.success('已保存（validateBank 门禁通过）')
      props.onSaved()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer width={480} visible={!!props.target} footer={null} unmountOnExit
      title={`编辑 ${props.target?.qid ?? ''} · ${props.target?.node ?? ''}`} onCancel={props.onClose}>
      {props.target && (
        <Space direction='vertical' style={{ width: '100%' }} size={10}>
          <Text type='secondary'>
            {props.target.kind === 'true_false' ? '答案 true/false'
              : props.target.kind === 'numeric' ? '数值答案（tol 保留原值）'
                : props.target.kind === 'ordering' ? '正确顺序项，用 | 分隔'
                  : props.target.kind === 'matching' ? '右列配对文本，用 | 分隔（对应左列顺序）'
                    : props.target.kind === 'open_question' ? '参考要点（可留空不改）'
                      : '答案请与选项字母/可接受值一致（门禁会校验）'}
          </Text>
          {props.target.options && (
            <Space size={4} wrap>{props.target.options.map((o, i) => (
              <Tag key={i} size='small'>
                {props.target?.kind === 'single_choice' || props.target?.kind === 'multi_choice'
                  ? `${String.fromCharCode(65 + i)}. ${o}` : o}
              </Tag>
            ))}</Space>
          )}
          <Input.TextArea value={q} onChange={setQ} autoSize={{ minRows: 2, maxRows: 6 }} />
          <Input value={answer} onChange={setAnswer} placeholder='答案（留空则不修改）' />
          <Input value={explanation} onChange={setExplanation} placeholder='解析（可选，留空不修改）' />
          <Space size={8}>
            <Text>难度</Text>
            {[1, 2, 3].map(d => (
              <Button key={d} size='mini' type={difficulty === d ? 'primary' : 'default'} onClick={() => setDifficulty(d)}>{d}</Button>
            ))}
          </Space>
          <Button type='primary' loading={busy} onClick={() => void save()}>保存</Button>
        </Space>
      )}
    </Drawer>
  )
}
