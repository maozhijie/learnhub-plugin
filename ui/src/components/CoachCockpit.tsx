/** 教练台（学习图生命周期 UI 化，ADR-0038）：建课/换终点种子起草、生长一步、罗盘重画、
 * enc 回填与复诊卡片——图域命令从面板直接下发（入队即返回，进度/结果看生成页），
 * 不再依赖 dsh 会话里的 agent。产物一律走提案人审通道（生长批除外：受理门即门，
 * ADR-0003 维持「不把逐批人审修回来」）。 */
import { Button, Card, Checkbox, Input, Message, Modal, Progress, Radio, Space, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { isActiveTab } from '../active-tab'
import type { GenJobItem, ProbationDoc, StatusCourse } from '../types'

const { Text } = Typography

const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`)

/** 图域任务状态 → 在途条标签/颜色（done 只在注册表留 30 分钟，failed 留 24h 供排查）。 */
const JOB_STATUS: Partial<Record<GenJobItem['status'], { label: string; color: string }>> = {
  queued: { label: '排队中', color: 'gray' },
  running: { label: '进行中', color: 'arcoblue' },
  cancelling: { label: '取消中', color: 'orange' },
  done: { label: '已完成', color: 'green' },
  partial: { label: '部分完成', color: 'purple' },
  failed: { label: '失败', color: 'red' },
  cancelled: { label: '已取消', color: 'gray' },
}

/** 建课/换终点表单（种子起草，phase=种子 队列任务 → 种子提案一次人审）。
 * 课程名/目标类型/块工作表是绑定字段（引擎以表单为准，不信模型照抄）。 */
function SeedFormModal({ visible, mode, course, onCancel }: {
  visible: boolean
  mode: 'new' | 'reseed'
  course: string | null
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [goalType, setGoalType] = useState<'capability' | 'coverage'>('capability')
  const [usePrior, setUsePrior] = useState(false)
  const [worksheetText, setWorksheetText] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (visible) {
      setName(course ?? '')
      setGoal('')
      setGoalType('capability')
      setUsePrior(false)
      setWorksheetText('')
    }
  }, [visible, course])

  const submit = async () => {
    if (!name.trim()) { Message.warning('课程名必填'); return }
    if (!goal.trim()) { Message.warning('给一句目标描述——种子起草只认学习者的目标'); return }
    const worksheet = worksheetText.split('\n').map(x => x.trim()).filter(Boolean).map(block => ({ block }))
    if (goalType === 'coverage' && !worksheet.length) {
      Message.warning('覆盖锚定需要块工作表：每行一个块名')
      return
    }
    setBusy(true)
    try {
      const r = await api.seedPropose({
        course: name.trim(), goal: goal.trim(), mode,
        goalType, useVaultPrior: usePrior,
        worksheet: goalType === 'coverage' ? worksheet : [],
      })
      // 诚实版反馈：提案还不存在——起草完成后才落提案页（弹通知告知），别让人在提案页空等
      Message.success(`${r.message}通常 1–3 分钟；完成后弹通知、提案页出现提案——期间可随意刷新或离开页面`)
      onCancel()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={mode === 'new' ? '新建课程（种子提案）' : `换终点/改工作表（${course}）`}
      visible={visible}
      onCancel={onCancel}
      onOk={() => void submit()}
      okText='起草种子提案'
      confirmLoading={busy}
      style={{ width: 560 }}
      unmountOnExit
    >
      <Space direction='vertical' style={{ width: '100%' }} size={12}>
        {mode === 'new' ? (
          <Input placeholder='课程名（如：线性代数）' value={name} onChange={setName} />
        ) : (
          <Text type='secondary'>对既有课程重新种子：终点可换、起点通常保留（除非目标本身变了）。</Text>
        )}
        <Input.TextArea
          placeholder='目标描述：学完这门课你想能做什么？（一段话即可，模型据此定起点与终点）'
          value={goal} onChange={setGoal} autoSize={{ minRows: 3, maxRows: 6 }} />
        <Space size={16}>
          <Text type='secondary'>目标类型：</Text>
          <Radio.Group value={goalType} onChange={v => setGoalType(v as 'capability' | 'coverage')}>
            <Radio value='capability'>能力锚定（完成 = 终点掌握）</Radio>
            <Radio value='coverage'>覆盖锚定（完成 = 块工作表 + 终点）</Radio>
          </Radio.Group>
        </Space>
        {goalType === 'coverage' && (
          <Input.TextArea
            placeholder='块工作表：每行一个块名（完成判据的核对表）'
            value={worksheetText} onChange={setWorksheetText} autoSize={{ minRows: 3, maxRows: 6 }} />
        )}
        <Checkbox checked={usePrior} onChange={setUsePrior}>
          参考我的笔记定起点（Vault 先验检索：起点放在熟悉边界，已会内容不作起点）
        </Checkbox>
        <Text type='secondary' style={{ fontSize: 12 }}>
          提交即入队起草（通常 1–3 分钟，队列 FIFO，可能排在内容生成之后）；**随时刷新或离开页面都不影响**——
          任务在宿主执行，完成后弹通知、提案页出现提案。产物是种子提案：1–3 起点 + 终点，一次人审即开工；
          图的其余部分由教练回合随生长批生长，不预先铺满。
        </Text>
      </Space>
    </Modal>
  )
}

/** 就绪深度卡（#161）：状态面 course.coach 直读——就绪存量对照前瞻需求的进度条 + 告警。
 * 冷启动首周需求 ×1.5 后 ceil；exhausted（除终点外前沿清空，词条「前瞻深度」）= 判据
 * 自然通过——剩下的路是学掉终点，不是继续生长，与「刚播种的合法空态」区分开。 */
function ReadinessCard({ check }: { check: NonNullable<StatusCourse['coach']> }) {
  const tight = !check.ok
  // exhausted（尾段前沿清空）判据自然通过：进度条显满格，不因 ready=0 显 0% 绿条
  const ratio = check.exhausted || check.required <= 0
    ? 100
    : Math.min(100, Math.round((check.ready / check.required) * 100))
  return (
    <Card size='small' title='就绪深度（教练回合判据）' style={{ borderRadius: 10 }}
      extra={
        <Space size={8}>
          {check.cold_start && <Tag size='small' color='orange'>冷启动首周</Tag>}
          {check.exhausted
            ? <Tag size='small' color='gray'>尾段·前沿已清空</Tag>
            : (tight ? <Tag size='small' color='red'>低于前瞻</Tag> : <Tag size='small' color='green'>达标</Tag>)}
        </Space>
      }>
      <Space direction='vertical' size={4} style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Progress size='small' style={{ flex: 1 }} percent={ratio} showText={false}
            status={tight ? 'error' : 'success'} />
          <Text style={{ fontSize: 12, flexShrink: 0 }}>就绪 {check.ready}/{check.required}</Text>
        </div>
        {check.exhausted ? (
          <Text type='secondary' style={{ fontSize: 12 }}>
            除终点外就绪前沿已清空——判据自然通过、零告警：剩下的路是学掉终点，不是继续生长。
          </Text>
        ) : (
          <Text type='secondary' style={{ fontSize: 12 }}>
            前瞻需求 {check.required}（前瞻深度 {check.depth}{check.cold_start ? '，冷启动首周放宽后取整' : ''}）；
            就绪 = 前置已达成、正文已生成的未开始节点。
          </Text>
        )}
        {tight && check.warnings.map(w => (
          <Text key={w} type='warning' style={{ fontSize: 12 }}>{w}</Text>
        ))}
      </Space>
    </Card>
  )
}

/** 复诊卡片（#146 插入实验面）：在途/到期未决/三率/闸门 + 立即结算（无确认步——
 * 它本来就是零人审自动行为的手动触发，按钮只提前同一件事）。 */
function ProbationCard({ course }: { course: string }) {
  const [doc, setDoc] = useState<ProbationDoc['courses'][number] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.probation(course)
      setDoc(d.courses.find(c => c.course === course) ?? null)
    } catch {
      setDoc(null)
    }
  }, [course])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { if (isActiveTab('graph')) void load() }, 30_000)
    return () => clearInterval(timer)
  }, [load])

  if (!doc) return null
  const hasAnything = doc.in_flight.length > 0 || doc.overdue.length > 0
  const settle = async () => {
    setBusy(true)
    try {
      const r = await api.probationSettle()
      const mine = r.courses?.find(c => c.course === course)
      if (!mine || !mine.settled.length) Message.info('没有到期待决的复诊')
      else Message.success(`复诊结算：${mine.settled.map(s => `${s.node}→${s.outcome}`).join('；')}`)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card size='small' title='复诊（插入边实验）' style={{ borderRadius: 10 }}
      extra={
        <Space size={8}>
          {doc.overdue.length > 0 && <Tag size='small' color='red'>到期未决 {doc.overdue.length}</Tag>}
          <Button size='mini' type='outline' loading={busy} onClick={() => void settle()}>立即结算</Button>
        </Space>
      }>
      {hasAnything ? (
        <Space direction='vertical' size={4} style={{ width: '100%' }}>
          <Text>实验中：{doc.in_flight.length ? doc.in_flight.join('、') : '（无）'}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}>
            近 30 学习日：插入率 {pct(doc.rates.insert_rate)}｜剪除率 {pct(doc.rates.prune_rate)}
            ｜复诊通过 {doc.rates.proven}/{doc.rates.decided}
            {doc.gate.resilient !== null ? `｜韧性闸门：${doc.gate.insert_blocked ? '插入已闸停' : '正常'}` : ''}
          </Text>
          {doc.gate.insert_blocked && doc.gate.insert_blocks.length > 0 && (
            <Text type='secondary' style={{ fontSize: 12 }}>{doc.gate.insert_blocks.join('；')}</Text>
          )}
        </Space>
      ) : (
        <Text type='secondary'>本课程没有在途的插入边实验——教练插入新台阶时会随批预注册复诊，到期自动结算（达标转正，不达标自动剪）。</Text>
      )}
    </Card>
  )
}

/** 教练台入口卡片：course 为 null（空 vault）时只露出建课入口 + 在途任务条；
 * coach = 状态面该课程的就绪深度检查（#161，缺席不显卡）。 */
export default function CoachCockpit({ course, jobs, coach }: {
  course: string | null
  jobs?: GenJobItem[]
  coach?: StatusCourse['coach'] | null
}) {
  const [seedForm, setSeedForm] = useState<null | 'new' | 'reseed'>(null)
  const [busy, setBusy] = useState<'growth' | 'compass' | 'backfill' | null>(null)

  const growth = (c: string) => {
    Modal.confirm({
      title: `生长一步「${c}」？`,
      content: '教练回合将裁决下一步生长并产出一个生长批：过受理门即自动应用（罗盘随批重写），不逐批人审（ADR-0003）；裁决与结果在生成页可见。',
      okText: '生长一步',
      onOk: async () => {
        setBusy('growth')
        try {
          const r = await api.coachGrowth(c)
          if (r.queued) Message.success(r.message)
          else Message.warning(r.message)
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(null)
        }
      },
    })
  }

  const compass = async (c: string) => {
    setBusy('compass')
    try {
      const r = await api.compassPaint(c)
      Message.success(r.message)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const backfill = (c: string) => {
    Modal.confirm({
      title: `回填「${c}」的成分技能边候选？`,
      content: '依据真实作答记录推断缺失的 enc 边，产出富化提案——提案页人审后生效（确定性推断，不调模型）。',
      okText: '回填',
      onOk: async () => {
        setBusy('backfill')
        try {
          const r = await api.encBackfill(c)
          const s = JSON.stringify(r)
          Message.success(s.length > 120 ? `${s.slice(0, 120)}…——见提案页` : `${s}——见提案页`)
        } catch (err) {
          Message.error(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(null)
        }
      },
    })
  }

  return (
    <Card size='small' title='教练台' style={{ borderRadius: 10 }}
      extra={<Text type='secondary' style={{ fontSize: 12 }}>建课/换终点走种子提案（一次人审）；生长由教练回合裁决（过受理门自动应用）</Text>}>
      <Space size={8} wrap>
        <Button type='primary' size='small' onClick={() => setSeedForm('new')}>新建课程</Button>
        {course && (
          <>
            <Button size='small' loading={busy === 'growth'} onClick={() => growth(course)}>生长一步</Button>
            <Button size='small' loading={busy === 'compass'} onClick={() => void compass(course)}>罗盘重画</Button>
            <Button size='small' loading={busy === 'backfill'} onClick={() => backfill(course)}>回填成分技能边</Button>
            <Button size='small' type='outline' onClick={() => setSeedForm('reseed')}>换终点/改工作表</Button>
          </>
        )}
      </Space>
      {/* 在途条：图域任务的常驻可见性——提交动作和它的后果之间的那根线
        * （排队/进行中/失败全显示；点击去生成页看全程，失败的死因在任务消息里）。 */}
      {jobs && jobs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Space size={6} wrap align='center'>
            <Text type='secondary' style={{ fontSize: 12 }}>图域任务（点击去生成页看全程）：</Text>
            {jobs.map(j => {
              const st = JOB_STATUS[j.status]
              return (
                <Tooltip key={j.key} content={j.message ?? ''}>
                  <Tag size='small' color={st?.color ?? 'gray'} style={{ cursor: 'pointer' }}>
                    {j.node}（{j.course}）· {st?.label ?? j.status}
                  </Tag>
                </Tooltip>
              )
            })}
          </Space>
        </div>
      )}
      {course && coach && <div style={{ marginTop: 10 }}><ReadinessCard check={coach} /></div>}
      {course && <div style={{ marginTop: 10 }}><ProbationCard course={course} /></div>}
      <SeedFormModal visible={seedForm !== null} mode={seedForm ?? 'new'} course={course} onCancel={() => setSeedForm(null)} />
    </Card>
  )
}
