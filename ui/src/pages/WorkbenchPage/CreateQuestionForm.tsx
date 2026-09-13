/** 自建题表单（九题型动态字段；#209 自题目管理页抽出为题库分栏的组件）。 */
import { Button, Input, Message, Select, Space, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'

const { Text } = Typography

export const KIND_LABEL: Record<string, string> = {
  single_choice: '单选', multi_choice: '多选', fill_in_blank: '填空', true_false: '判断',
  numeric: '数值', ordering: '排序', matching: '配对', reflection: '反思', open_question: '开放',
}

export default function CreateQuestionForm(props: { course: string; nodes: string[]; onDone: () => void }) {
  const [node, setNode] = useState(props.nodes[0] ?? '')
  const [kind, setKind] = useState('true_false')
  const [q, setQ] = useState('')
  const [options, setOptions] = useState('')
  const [answer, setAnswer] = useState('')
  const [tol, setTol] = useState('')
  const [explanation, setExplanation] = useState('')
  const [difficulty, setDifficulty] = useState(1)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!node || !q.trim()) { Message.warning('节点与题干必填'); return }
    setBusy(true)
    try {
      const question: Record<string, unknown> = { kind, q: q.trim(), difficulty, explanation: explanation.trim() || undefined }
      const optList = options.split('\n').map(s => s.trim()).filter(Boolean)
      if (kind === 'true_false') question.answer = answer.trim() === 'true'
      else if (kind === 'fill_in_blank' || kind === 'multi_choice' || kind === 'ordering' || kind === 'matching') {
        question.answer = answer.split('|').map(s => s.trim()).filter(Boolean)
        if (kind !== 'fill_in_blank') question.options = optList
      } else if (kind === 'numeric') {
        question.answer = answer.trim()
        const t = Number(tol)
        if (Number.isFinite(t) && t > 0) question.tol = t
      } else {
        question.answer = answer.trim()
        if (kind === 'single_choice') question.options = optList
      }
      const r = await api.questionAdd(props.course, node, question)
      Message.success(`已添加 ${r.id}（题库共 ${r.count} 题）`)
      props.onDone()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const needsOptions = kind === 'single_choice' || kind === 'multi_choice' || kind === 'ordering' || kind === 'matching'
  const answerPlaceholder = kind === 'true_false' ? '答案：true / false'
    : kind === 'fill_in_blank' ? '可接受答案，用 | 分隔多个'
      : kind === 'multi_choice' ? '正确选项字母，用 | 分隔（如 A|C）'
        : kind === 'ordering' ? '正确顺序的项文本，用 | 分隔（与选项同一组项）'
          : kind === 'matching' ? '右列配对文本，用 | 分隔（顺序对应左列每一行）'
            : kind === 'numeric' ? '数值答案（支持小数/分数/百分数）'
              : kind === 'reflection' ? '评分要点'
                : kind === 'open_question' ? '参考要点（可留空，AI 按题干综合评判）'
                  : '正确答案（选项字母）'

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={10}>
      <Select value={node} onChange={setNode} placeholder='选择节点' style={{ width: '100%' }}>
        {props.nodes.map(n => <Select.Option key={n} value={n}>{n}</Select.Option>)}
      </Select>
      <Select value={kind} onChange={setKind} style={{ width: 160 }}>
        {Object.entries(KIND_LABEL).map(([k, v]) => <Select.Option key={k} value={k}>{v}</Select.Option>)}
      </Select>
      <Input.TextArea value={q} onChange={setQ} placeholder='题干（支持 LaTeX 文本）' autoSize={{ minRows: 2, maxRows: 6 }} />
      {needsOptions && (
        <Input.TextArea value={options} onChange={setOptions}
          placeholder={kind === 'ordering' ? '乱序项，每行一个（answer 按正确顺序）'
            : kind === 'matching' ? '左列项，每行一个（answer 顺序与之对应）'
              : '选项，每行一个（A/B/C 自动编号）'}
          autoSize={{ minRows: 3, maxRows: 8 }} />
      )}
      <Input value={answer} onChange={setAnswer} placeholder={answerPlaceholder} />
      {kind === 'numeric' && (
        <Input value={tol} onChange={setTol} placeholder='容差 tol（可选，如 0.01）' />
      )}
      <Input value={explanation} onChange={setExplanation} placeholder='解析（可选）' />
      <Space size={10}>
        <Text>难度</Text>
        <Select value={difficulty} onChange={setDifficulty} style={{ width: 90 }}>
          {[1, 2, 3].map(d => <Select.Option key={d} value={d}>{d}</Select.Option>)}
        </Select>
      </Space>
      <Button type='primary' loading={busy} onClick={() => void submit()}>添加（过 schema 门禁后落盘）</Button>
    </Space>
  )
}
