/** 洞察区·周复盘 Weekly Kata 卡（#114 U4 / ADR-0026；页内子组件）：全局每周一张的
 * 五问复盘。入口常驻（洞察区 = 周视图家），无推送、缺勤不罚；现状引擎自动填
 * （只读渲染），四问学习者作答；「下一实验」一键转 N-of-1 提案（提案-确认制）或
 * 执行意图挂今日偏好。Learner Output 域：零 XP、不进掌握度、不做 FSRS 卡。
 * #210 人审收口：实验开跑的确认只在提案收件箱（人审唯一处）——转出提案后本卡留一条
 * 常驻回执与「去提案收件箱确认」直达入口（onOpenInbox 未传时只有文字提示）。
 * #183：周文档取数走 useCommand（week 变化即重取），保存经 set 回填（不打断输入），
 * 转换动作后 reload（与旧行为一致：重取会按引擎现状重铺四问）。 */
import { Alert, Button, Card, Collapse, Input, Message, Modal, Select, Space, Tag, Typography } from '@arco-design/web-react'
import { useEffect, useRef, useState } from 'react'
import { CommandBoundary } from '../../components/CommandBoundary'
import { api } from '../../api'
import { useCommand, errorMessage } from '../../hooks/useCommand'
import type { ExperimentsDoc, KataDoc } from '../../types'

const { Text } = Typography

/** 学习者作答的四问（引擎常量 KATA_QUESTIONS 含「现状」，此处只列作答面；值须与引擎一致）。 */
const KATA_ANSWER_KEYS = ['目标条件', '障碍', '下一实验', '预期所学'] as const
const KATA_PLACEHOLDER = '（待答）'

/** 引擎现状节内容铺进四问作答框（引擎占位 = 未答，铺空串）。 */
function seedAnswers(doc: KataDoc): Record<string, string> {
  return Object.fromEntries(KATA_ANSWER_KEYS.map(q => [q, doc.sections[q] === KATA_PLACEHOLDER ? '' : doc.sections[q] ?? '']))
}

export default function KataCard({ courseNames, onOpenInbox }: { courseNames: string[]; onOpenInbox?: () => void }) {
  /** 当前查看的周（undefined = 缺省上一完整学习周；Select 切换即重取）。 */
  const [week, setWeek] = useState<string | undefined>(undefined)
  const kata = useCommand(() => api.kataOpen(week), [week])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  // 四问只在新取到的周文档上铺一次（取数成功边沿）；保存回填（set）不重铺，
  // 不打断输入——与旧 load() 的铺值时机一致
  const [seeded, setSeeded] = useState(false)
  const seededDocRef = useRef<KataDoc | null>(null)
  useEffect(() => { setSeeded(false) }, [week])
  const doc = kata.data
  useEffect(() => {
    if (doc && !seeded && seededDocRef.current !== doc) {
      seededDocRef.current = doc
      setAnswers(seedAnswers(doc))
      setSeeded(true)
    }
  }, [doc, seeded])
  const [saving, setSaving] = useState(false)
  const [exp, setExp] = useState<ExperimentsDoc | null>(null)
  const [expTpl, setExpTpl] = useState<string | undefined>()
  const [expCourse, setExpCourse] = useState<string | undefined>()
  const [expModal, setExpModal] = useState(false)
  const [intModal, setIntModal] = useState(false)
  const [iCourse, setICourse] = useState<string | undefined>()
  const [iNode, setINode] = useState('')
  const [iCue, setICue] = useState('')
  const [iAct, setIAct] = useState('')
  /** 本次会话内转出的实验提案（常驻回执 + 收件箱直达入口；人审动作在收件箱）。 */
  const [converted, setConverted] = useState<number | null>(null)

  const save = async () => {
    if (!doc) return
    setSaving(true)
    try {
      const saved = await api.kataSave(doc.week_start, answers)
      kata.set(saved)
      Message.success(saved.answered ? '四问已齐——本周复盘完成' : '已保存（还有未答的问）')
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const convertExperiment = async () => {
    if (!doc || !expTpl) return
    try {
      const r = await api.kataConvertExperiment(doc.week_start, expTpl, expCourse)
      Message.success(`实验提案 #${r.proposal} 已发起——到提案收件箱确认后开跑`)
      setConverted(r.proposal)
      setExpModal(false)
      await kata.reload()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  const convertIntention = async () => {
    if (!doc || !iCourse || !iNode.trim() || !iCue.trim() || !iAct.trim()) return
    try {
      await api.kataConvertIntention(doc.week_start, iCourse, iNode.trim(), iCue.trim(), iAct.trim())
      Message.success('执行意图已挂上今天的目标偏好（学习日日界后过期）')
      setIntModal(false)
      await kata.reload()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  return (
    <Card
      size='small' title='周复盘 · 五问' style={{ borderRadius: 10 }}
      extra={doc && (
        <Space size={8}>
          <Select size='mini' value={doc.week_start} onChange={v => setWeek(v)} style={{ width: 130 }}
            placeholder='选择周'>
            {(doc.list.map(x => x.week_start).includes(doc.week_start)
              ? doc.list.map(x => x.week_start)
              : [doc.week_start, ...doc.list.map(x => x.week_start)]
            ).map(w => <Select.Option key={w} value={w}>{w} 那周</Select.Option>)}
          </Select>
          <Tag color={doc.answered ? 'green' : 'gray'} size='small'>{doc.answered ? '四问已齐' : '待作答'}</Tag>
        </Space>
      )}>
      <CommandBoundary cmd={kata} loadingNode={<Text type='secondary'>加载中…</Text>}>
        {doc => (
          <div style={{ display: 'grid', gap: 10 }}>
            {converted !== null && (
              <Alert
                type='warning'
                content={
                  <Space size={8} wrap>
                    <Text>实验提案 #{converted} 已发起：确认开跑在提案收件箱（人审唯一处），确认前零副作用。</Text>
                    {onOpenInbox && <Button size='mini' type='primary' onClick={onOpenInbox}>去提案收件箱确认</Button>}
                  </Space>
                }
              />
            )}
            <Text type='secondary' style={{ fontSize: 12 }}>
              复盘对象：{doc.week_start} ~ {doc.week_end}（上一完整学习周，凌晨学习日按日界归属）·
              记录落「我的产出/周复盘」，零 XP、可注册为复习源；无推送、缺勤不罚。
            </Text>
            <Collapse bordered={false} defaultActiveKey={['status']}>
              <Collapse.Item name='status' header='现状（引擎自动填）'>
                <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{doc.reality}</pre>
              </Collapse.Item>
            </Collapse>
            {KATA_ANSWER_KEYS.map(q => (
              <div key={q} style={{ display: 'grid', gap: 4 }}>
                <Text style={{ fontSize: 12, fontWeight: 600 }}>
                  {q}{q === '下一实验' && <Text type='secondary' style={{ fontSize: 11 }}>（自由文本；可一键转实验提案或执行意图）</Text>}
                </Text>
                <Input.TextArea
                  value={answers[q] ?? ''}
                  placeholder={q === '目标条件' ? '上一周你想要达成什么？' : q === '障碍' ? '什么挡住了你？' : q === '下一实验' ? '下周试一个小改变' : '如果实验有效，你会看到什么？'}
                  onChange={v => setAnswers(a => ({ ...a, [q]: v }))}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                />
              </div>
            ))}
            <Space size={8} wrap>
              <Button size='small' type='primary' loading={saving} onClick={() => void save()}>保存四问</Button>
              <Button size='small' disabled={!answers['下一实验']?.trim()} onClick={() => { void api.experiments().then(setExp).catch(() => setExp(null)); setExpModal(true) }}>转 N-of-1 提案</Button>
              <Button size='small' disabled={!answers['下一实验']?.trim()} onClick={() => setIntModal(true)}>转执行意图</Button>
            </Space>
          </div>
        )}
      </CommandBoundary>
      <Modal
        title='「下一实验」转 N-of-1 实验提案' visible={expModal}
        onCancel={() => setExpModal(false)}
        footer={null}>
        <div style={{ display: 'grid', gap: 10 }}>
          <Text type='secondary' style={{ fontSize: 12 }}>
            发起的是待确认提案（提案-确认制）：到提案收件箱确认后才开跑（人审唯一处）。实验变量只允许引擎可控的内容参数。
          </Text>
          <Select placeholder='选择实验模板' value={expTpl} onChange={setExpTpl} style={{ width: '100%' }}>
            {(exp?.templates ?? []).filter(t => t.unlocked).map(t => (
              <Select.Option key={t.id} value={t.id}>{t.title}</Select.Option>
            ))}
          </Select>
          <Select placeholder='范围：全部课程' value={expCourse} onChange={setExpCourse} allowClear style={{ width: '100%' }}>
            {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Button type='primary' disabled={!expTpl} onClick={() => void convertExperiment()}>发起提案</Button>
        </div>
      </Modal>
      <Modal
        title='「下一实验」转执行意图' visible={intModal}
        onCancel={() => setIntModal(false)}
        footer={null}>
        <div style={{ display: 'grid', gap: 10 }}>
          <Text type='secondary' style={{ fontSize: 12 }}>
            「在【稳定线索】之后做【单一具体行动】」——挂上今天的目标偏好（推荐榜首），随当前学习日过期（日界后失效）。
          </Text>
          <Select placeholder='课程' value={iCourse} onChange={setICourse} style={{ width: '100%' }}>
            {courseNames.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Input placeholder='节点名（如：入门）' value={iNode} onChange={setINode} />
          <Input placeholder='线索（时间/地点锚，如：早上刷完牙后）' value={iCue} onChange={setICue} />
          <Input placeholder='单一具体行动（如：做 5 道到期复习）' value={iAct} onChange={setIAct} />
          <Button type='primary' disabled={!iCourse || !iNode.trim() || !iCue.trim() || !iAct.trim()} onClick={() => void convertIntention()}>挂今日执行意图</Button>
        </div>
      </Modal>
    </Card>
  )
}
