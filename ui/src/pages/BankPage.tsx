/** 题目管理：全库浏览 / 筛选 / 编辑 / 自建 / 归档 + 题目标签。
 * #72 B2 挂接：页顶难度建议区（引擎 difficultyAdvice 只读检测）——失衡 → 「校准重出」
 * （走既有单节出题端点，validateBank 门禁落库）；全对过于简单 → 逐题「归档」。
 * 建议先行：全部 Popconfirm 确认后才触发，不自动改库。 */
import { Button, Card, Drawer, Empty, Input, Message, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AppFrame } from '../App'
import type { BankEntry, DifficultyAdviceNode } from '../types'

const { Text } = Typography

const KIND_LABEL: Record<string, string> = {
  single_choice: '单选', multi_choice: '多选', fill_in_blank: '填空', true_false: '判断',
  numeric: '数值', ordering: '排序', matching: '配对', reflection: '反思', open_question: '开放',
}

/** 自建题表单（九题型动态字段）。 */
function CreateQuestionForm(props: { course: string; nodes: string[]; onDone: () => void }) {
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
      Message.error(err instanceof Error ? err.message : String(err))
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

export default function BankPage({ frame }: { frame: AppFrame }) {
  const [entries, setEntries] = useState<BankEntry[] | null>(null)
  const [filterCourse, setFilterCourse] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<BankEntry | null>(null)
  const [creating, setCreating] = useState(false)
  /** B2 难度建议（#72）：失衡/过于简单只读建议，页顶建议区消费；null = 加载中。 */
  const [advice, setAdvice] = useState<DifficultyAdviceNode[] | null>(null)
  const [recalibrating, setRecalibrating] = useState<string | null>(null)
  /** 当前学习日（ADR-0020）：随难度建议载荷带出，UI 不自算日界；null = 建议未取到。 */
  const [today, setToday] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.questionsAll(filterCourse)
      setEntries(r.questions)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [filterCourse])

  const loadAdvice = useCallback(async () => {
    try {
      const doc = await api.difficultyAdvice()
      setAdvice(doc.nodes)
      setToday(doc.date) // 学习日（ADR-0020）：到期列着色与引擎同口径
    } catch {
      setAdvice([])
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadAdvice() }, [loadAdvice])

  const nodesForCourse = filterCourse
    ? (frame.tree?.courses.find(c => c.name === filterCourse)?.regions ?? [])
      .flatMap(r => r.blocks.flatMap(b => b.nodes.map(n => n.node)))
    : []
  /** 到期列着色：以引擎学习日为基准（ADR-0020）；学习日未取到时不着色。 */
  const dueColor = (due: string) =>
    today === null ? 'gray' : due < today ? 'red' : due === today ? 'orange' : 'gray'

  const visible = (entries ?? []).filter(e =>
    (showArchived || !e.archived)
    && (!search || e.q.includes(search) || e.node.includes(search)))

  const doArchive = async (e: BankEntry, archived: boolean) => {
    try {
      await api.questionArchive(e.course, e.node, e.qid, archived)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** B2 校准重出（#72）：走既有单节出题端点（模型 → validateBank 门禁落库）。
   * 难度/bloom 目标带指令无法随该端点下发（引擎无指令通道），只在确认框原文展示
   * 供学习者知晓；要按指令定向调制，仍可在 dsh 会话让 agent 走 learnhub_question_generate。 */
  const doRecalibrate = async (n: DifficultyAdviceNode) => {
    const key = `${n.course}/${n.node}`
    setRecalibrating(key)
    try {
      const r = await api.questionGenerate(n.course, n.node)
      Message.success(`「${n.node}」已校准重出：新增 ${r.added} 题（库内共 ${r.total} 题）`)
      await Promise.all([load(), loadAdvice()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRecalibrating(null)
    }
  }

  /** B2 过于简单归档（#72）：逐题归档（题目管理既有动作，恢复随时可逆）。 */
  const doArchiveAdvice = async (n: DifficultyAdviceNode, qid: string) => {
    try {
      await api.questionArchive(n.course, n.node, qid, true)
      Message.success(`已归档 ${qid}`)
      await Promise.all([load(), loadAdvice()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={12}>
      {/* B2 难度建议区（#72）：只读检测有产出才显示，低数据静默 */}
      {advice !== null && advice.length > 0 && (
        <Card size='small' title='难度建议（引擎检测，确认后才执行）' style={{ borderRadius: 10 }}>
          <Space direction='vertical' style={{ width: '100%' }} size={8}>
            {advice.map(n => (
              <div key={`${n.course}/${n.node}`} style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '8px 10px',
              }}>
                <Space size={8} wrap>
                  <Tag size='small' color='orange'>{n.course} · {n.node}</Tag>
                  {n.calibration && (
                    <>
                      <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 220 }}>{n.calibration.reason}</Text>
                      <Popconfirm
                        title={`校准重出「${n.node}」的题目？`}
                        content={n.calibration.instruction}
                        onOk={() => void doRecalibrate(n)}>
                        <Button size='mini' type='primary' status='warning' loading={recalibrating === `${n.course}/${n.node}`}>
                          校准重出
                        </Button>
                      </Popconfirm>
                    </>
                  )}
                </Space>
                {(n.too_easy ?? []).map(t => (
                  <Space key={t.qid} size={8} wrap style={{ paddingLeft: 0 }}>
                    <Tag size='small' color='gray'>过于简单 · {t.qid}</Tag>
                    <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 220 }}>{t.reason}</Text>
                    <Popconfirm title={`归档「${t.qid}」？`}
                      content='归档后不再进复习队列；可在本题库列表「显示已归档」里恢复。'
                      onOk={() => void doArchiveAdvice(n, t.qid)}>
                      <Button size='mini' type='text' status='warning'>归档</Button>
                    </Popconfirm>
                  </Space>
                ))}
              </div>
            ))}
          </Space>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={filterCourse} onChange={v => setFilterCourse(v)} placeholder='全部课程' style={{ width: 180 }} allowClear>
          {frame.tree?.courses.map(c => <Select.Option key={c.name} value={c.name}>{c.name}</Select.Option>)}
        </Select>
        <Input value={search} onChange={setSearch} placeholder='搜题干/节点' style={{ width: 220 }} allowClear />
        <Space size={6}><Text>显示已归档</Text><Switch checked={showArchived} onChange={setShowArchived} /></Space>
        <Button type='primary' size='small' style={{ marginLeft: 'auto' }}
          disabled={!filterCourse} onClick={() => setCreating(true)}>自建题</Button>
      </div>

      {entries === null ? null : visible.length === 0 ? (
        <Empty description='没有题目：选择课程后点「自建题」，或让 agent 出题（learnhub_question_save 工具）' />
      ) : (
        <Table size='small' data={visible} rowKey={e => `${e.course}/${e.node}/${e.qid}`}
          columns={[
            { title: '课程', dataIndex: 'course', width: 110 },
            { title: '节点', dataIndex: 'node', width: 170, ellipsis: true },
            { title: '#', dataIndex: 'qid', width: 54 },
            { title: '题型', width: 70, render: (_, e) => <Tag size='small'>{KIND_LABEL[e.kind] ?? e.kind}</Tag> },
            { title: '题干', dataIndex: 'q', ellipsis: true },
            { title: '到期', width: 112, render: (_, e) => e.due ? (
              <Tag size='small' color={dueColor(e.due)}
                title={e.lastReview ? `上次复习 ${e.lastReview}` : undefined}>
                {e.due}
              </Tag>
            ) : <Text type='secondary' style={{ fontSize: 12 }}>未调度</Text> },
            { title: '状态', width: 80, render: (_, e) => e.archived
              ? <Tag size='small' color='gray'>已归档</Tag>
              : <Tag size='small' color='green'>在库</Tag> },
            { title: '操作', width: 150, render: (_, e) => (
              <Space size={4}>
                <Button size='mini' type='text' onClick={() => setEditing(e)}>编辑</Button>
                {e.archived
                  ? <Button size='mini' type='text' onClick={() => void doArchive(e, false)}>恢复</Button>
                  : <Button size='mini' type='text' status='warning' onClick={() => void doArchive(e, true)}>归档</Button>}
              </Space>
            ) },
          ]}
          pagination={{ pageSize: 20, showTotal: true }} />
      )}

      <Drawer width={480} visible={creating} footer={null} unmountOnExit
        title={`自建题 · ${filterCourse ?? ''}`} onCancel={() => setCreating(false)}>
        {filterCourse && (
          <CreateQuestionForm course={filterCourse} nodes={nodesForCourse}
            onDone={() => { setCreating(false); void load() }} />
        )}
      </Drawer>

      <EditDrawer entry={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />
    </Space>
  )
}

/** 编辑抽屉：题干/答案/解析/难度。 */
function EditDrawer(props: { entry: BankEntry | null; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState('')
  const [explanation, setExplanation] = useState('')
  const [difficulty, setDifficulty] = useState(1)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (props.entry) {
      const e = props.entry
      setQ(e.q)
      setAnswer('')
      setExplanation('')
      setDifficulty(e.difficulty)
    }
  }, [props.entry])

  const save = async () => {
    if (!props.entry) return
    setBusy(true)
    try {
      // 题目列表接口不含答案（防泄漏）；答案留空 = 不修改，填写才覆盖
      const patch: Record<string, unknown> = { q: q.trim(), difficulty }
      if (explanation.trim()) patch.explanation = explanation.trim()
      if (answer.trim()) {
        const k = props.entry.kind
        if (k === 'true_false') patch.answer = answer.trim() === 'true'
        else if (k === 'fill_in_blank' || k === 'multi_choice' || k === 'ordering' || k === 'matching') {
          patch.answer = answer.split('|').map(s => s.trim()).filter(Boolean)
        } else patch.answer = answer.trim()
      }
      await api.questionUpdate(props.entry.course, props.entry.node, props.entry.qid, patch)
      Message.success('已保存（validateBank 门禁通过）')
      props.onSaved()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer width={480} visible={!!props.entry} footer={null} unmountOnExit
      title={`编辑 ${props.entry?.qid ?? ''} · ${props.entry?.node ?? ''}`} onCancel={props.onClose}>
      {props.entry && (
        <Space direction='vertical' style={{ width: '100%' }} size={10}>
          <Text type='secondary'>
            {props.entry.kind === 'true_false' ? '答案 true/false'
              : props.entry.kind === 'numeric' ? '数值答案（tol 保留原值）'
                : props.entry.kind === 'ordering' ? '正确顺序项，用 | 分隔'
                  : props.entry.kind === 'matching' ? '右列配对文本，用 | 分隔（对应左列顺序）'
                    : props.entry.kind === 'open_question' ? '参考要点（可留空不改）'
                      : '答案请与选项字母/可接受值一致（门禁会校验）'}
          </Text>
          {props.entry.options && (
            <Space size={4} wrap>{props.entry.options.map((o, i) => (
              <Tag key={i} size='small'>
                {props.entry?.kind === 'single_choice' || props.entry?.kind === 'multi_choice'
                  ? `${String.fromCharCode(65 + i)}. ${o}` : o}
              </Tag>
            ))}</Space>
          )}
          <Input.TextArea value={q} onChange={setQ} autoSize={{ minRows: 2, maxRows: 6 }} />
          <Input value={answer} onChange={setAnswer} placeholder='答案（留空则不修改）' />
          <Input value={explanation} onChange={setExplanation} placeholder='解析（可选，留空不修改）' />
          <Button type='primary' loading={busy} onClick={() => void save()}>保存</Button>
        </Space>
      )}
    </Drawer>
  )
}
