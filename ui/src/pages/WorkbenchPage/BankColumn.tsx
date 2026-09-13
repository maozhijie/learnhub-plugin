/** 题库分栏（#209 / ADR-0058 T5，自题目管理页解体进单课工作台）：本课切片的
 * 全职能——浏览/筛选/编辑/自建/归档 + 难度建议 + 体检与休眠清理；申诉结果与勘误
 * 留痕在列表（归档原因/改键后的题面随行可见，勘误动作在练习会话的申诉里）。
 * #72 B2：难度建议区（引擎 difficultyAdvice 只读检测，切片按课过滤）——失衡 →
 * 「校准重出」；全对过于简单 → 逐题「归档」或「忽略」（误判持久忽略）。建议条目带
 * 题面摘录，点击定位表格行。题库维护区（ADR-0032）：存量体检 + 一键清理休眠题，
 * 预览确认后归档、可逆、不删除。建议先行：全部 Popconfirm 确认后才触发，不自动改库。 */
import { Button, Card, Drawer, Empty, Input, Message, Modal, Popconfirm, Space, Switch, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import QuestionEditDrawer from '../../components/QuestionEditDrawer'
import type { AppFrame } from '../../App'
import type { BankEntry, CleanupPreviewDoc, DifficultyAdviceNode, QuestionAuditReport } from '../../types'
import { errorMessage } from '../../hooks/useCommand'
import CreateQuestionForm, { KIND_LABEL } from './CreateQuestionForm'

const { Text } = Typography

export default function BankColumn({ frame, course }: { frame: AppFrame; course: string }) {
  const [entries, setEntries] = useState<BankEntry[] | null>(null)
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<BankEntry | null>(null)
  const [creating, setCreating] = useState(false)
  /** B2 难度建议（#72）：失衡/过于简单只读建议（本课切片）；null = 加载中。 */
  const [advice, setAdvice] = useState<DifficultyAdviceNode[] | null>(null)
  const [recalibrating, setRecalibrating] = useState<string | null>(null)
  /** 当前学习日（ADR-0020）：随难度建议载荷带出，UI 不自算日界；null = 建议未取到。 */
  const [today, setToday] = useState<string | null>(null)
  /** 被忽略的建议条数（引擎持久忽略清单过滤后的计数；「恢复全部」入口消费）。 */
  const [dismissed, setDismissed] = useState(0)
  /** 从建议条目定位的题目（表格过滤到该节点并高亮 qid 列）。 */
  const [focus, setFocus] = useState<{ course: string; node: string; qid: string } | null>(null)
  /** 题库维护区（ADR-0032）：存量体检报告与一键清理预览。 */
  const [audit, setAudit] = useState<QuestionAuditReport | null>(null)
  const [auditBusy, setAuditBusy] = useState(false)
  const [cleanup, setCleanup] = useState<CleanupPreviewDoc | null>(null)
  const [cleanupBusy, setCleanupBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.questionsAll(course)
      setEntries(r.questions)
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }, [course])

  const loadAdvice = useCallback(async () => {
    try {
      const doc = await api.difficultyAdvice(course)
      setAdvice(doc.nodes)
      setToday(doc.date) // 学习日（ADR-0020）：到期列着色与引擎同口径
      setDismissed(doc.dismissed ?? 0)
    } catch {
      setAdvice([])
    }
  }, [course])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadAdvice() }, [loadAdvice])

  const nodesForCourse = (frame.tree?.courses.find(c => c.name === course)?.regions ?? [])
    .flatMap(r => r.blocks.flatMap(b => b.nodes.map(n => n.node)))
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
      Message.error(errorMessage(err))
    }
  }

  /** B2 校准重出（#72，#118 任务化）：入队 quiz 任务并轮询到终态后刷新题库与建议。
   * 难度/bloom 目标带指令无法随该端点下发（引擎无指令通道），只在确认框原文展示
   * 供学习者知晓；要按指令定向调制，仍可在 dsh 会话让 agent 走 learnhub_question_generate。 */
  const doRecalibrate = async (n: DifficultyAdviceNode) => {
    const key = `${n.course}/${n.node}`
    setRecalibrating(key)
    try {
      const r = await api.questionGenerate(n.course, n.node)
      Message.info(r.message)
      // 轮询任务终态（生成队列同样可见/可取消）；终态后刷新题库与建议
      const deadline = Date.now() + 15 * 60_000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        const st = await api.generateStatus()
        const mine = st.jobs.find(j => j.course === n.course && j.node === n.node)
        if (!mine || !['queued', 'running', 'cancelling'].includes(mine.status)) {
          if (mine?.status === 'done') Message.success(`「${n.node}」${mine.message ?? '出题完成'}`)
          else if (mine) Message.error(`「${n.node}」出题失败：${mine.message ?? '（无错误信息）'}`)
          break
        }
      }
      await Promise.all([load(), loadAdvice()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setRecalibrating(null)
    }
  }

  /** B2 过于简单归档（#72）：逐题归档并记录原因 too_easy（ADR-0032，可逆）。 */
  const doArchiveAdvice = async (n: DifficultyAdviceNode, qid: string) => {
    try {
      await api.questionArchive(n.course, n.node, qid, true, 'too_easy')
      Message.success(`已归档 ${qid}`)
      await Promise.all([load(), loadAdvice()])
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  /** 误判的持久忽略（引擎侧难度建议忽略清单；恢复全部一键清空）。 */
  const doDismiss = async (n: DifficultyAdviceNode, qid: string) => {
    try {
      await api.adviceDismiss(n.course, n.node, qid)
      await loadAdvice()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }
  const doRestoreDismissed = async () => {
    try {
      await api.adviceDismiss('', '', undefined, { all: true })
      await loadAdvice()
      Message.success('已恢复全部被忽略的建议')
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  /** 建议条目定位：表格过滤到该节点并高亮目标行（含已归档——建议的题可能已被归档）。 */
  const locate = (n: DifficultyAdviceNode, qid: string) => {
    setFocus({ course: n.course, node: n.node, qid })
    setShowArchived(true)
    setSearch(n.node)
  }

  /** 题库存量体检（ADR-0029/0030 只读盘点）。 */
  const doAudit = async () => {
    setAuditBusy(true)
    try {
      const report = await api.questionAudit()
      setAudit(report)
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setAuditBusy(false)
    }
  }

  /** 一键清理（ADR-0032）：预览分组确认后归档（可逆、不删除）。 */
  const doCleanupPreview = async () => {
    setCleanupBusy(true)
    try {
      setCleanup(await api.bankCleanupPreview(course))
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setCleanupBusy(false)
    }
  }
  const doCleanupApply = async () => {
    setCleanupBusy(true)
    try {
      const r = await api.bankCleanupApply(course)
      const n = r.reduce((s, g) => s + g.archived, 0)
      Message.success(`已归档 ${n} 道题（可在列表「显示已归档」里按原因恢复）`)
      setCleanup(null)
      await Promise.all([load(), loadAdvice()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setCleanupBusy(false)
    }
  }

  return (
    <Space direction='vertical' className='lh-full' size={12}>
      {/* B2 难度建议区（#72）：只读检测有产出才显示，低数据静默；条目带题面摘录，
          点击定位表格行；误判走「忽略」（持久，可一键恢复） */}
      {advice !== null && (advice.length > 0 || dismissed > 0) && (
        <Card size='small' title='难度建议（引擎检测，确认后才执行）' className='lh-card'>
          <Space direction='vertical' className='lh-full' size={8}>
            {advice.map(n => (
              <div key={`${n.course}/${n.node}`} className='lh-col lh-gap-4 lh-surface-1 lh-r-6 lh-p-8px-10px'>
                <Space size={8} wrap>
                  <Tag size='small' color='orange'>{n.course} · {n.node}</Tag>
                  {n.calibration && (
                    <>
                      <Text type='secondary' className='lh-t-12 lh-flex-1 lh-minw-220'>{n.calibration.reason}</Text>
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
                  <Space key={t.qid} size={8} wrap className='lh-pl-0'>
                    <Tag size='small' color='gray'>过于简单 · {t.qid}</Tag>
                    <Text className='lh-t-12 lh-click lh-maxw-360' ellipsis
                      onClick={() => locate(n, t.qid)}
                      title='点击在下方列表中定位这道题'>{t.stem || t.qid}</Text>
                    <Text type='secondary' className='lh-t-12 lh-flex-1 lh-minw-200'>{t.reason}</Text>
                    <Popconfirm title={`归档「${t.qid}」？`}
                      content='归档后不再进复习队列；可在下方列表「显示已归档」里恢复。'
                      onOk={() => void doArchiveAdvice(n, t.qid)}>
                      <Button size='mini' type='text' status='warning'>归档</Button>
                    </Popconfirm>
                    <Button size='mini' type='text' onClick={() => void doDismiss(n, t.qid)}
                      title='误判？持久忽略这条建议（可一键恢复）'>忽略</Button>
                  </Space>
                ))}
              </div>
            ))}
            {dismissed > 0 && (
              <Space size={8}>
                <Text type='secondary' className='lh-t-12'>已忽略 {dismissed} 条建议（误判不再打扰）</Text>
                <Button size='mini' type='text' onClick={() => void doRestoreDismissed()}>恢复全部</Button>
              </Space>
            )}
          </Space>
        </Card>
      )}

      {/* 题库维护区（ADR-0032）：存量体检只读盘点 + 一键清理（归档式、可逆、不删除） */}
      <Card size='small' title='题库维护（盘点只读，清理归档可逆）' className='lh-card'>
        <Space size={10} wrap>
          <Button size='small' loading={auditBusy} onClick={() => void doAudit()}>运行体检</Button>
          <Button size='small' status='warning' loading={cleanupBusy} onClick={() => void doCleanupPreview()}>一键清理休眠题</Button>
          <Text type='secondary' className='lh-t-12'>
            清理范围：跳过节点的未归档题 + 学完后从未调度（休眠）的题——预览确认后才归档，随时可恢复
          </Text>
        </Space>
        {audit && (
          <div className='lh-pt-8'>
            {audit.flagged === 0 ? (
              <Text type='secondary' className='lh-t-12'>
                体检通过：{audit.banks} 个题库、{audit.questions} 道题未发现契约违规。
              </Text>
            ) : (
              <>
                <Text type='secondary' className='lh-t-12'>
                  体检发现 {audit.flagged}/{audit.questions} 道题违规（{audit.banks} 个题库），可逐题归档或让 agent 校准重出：
                </Text>
                <div className='lh-pt-4 lh-col lh-gap-2'>
                  {audit.findings.filter(f => f.course === course).slice(0, 10).map(f => (
                    <Text key={`${f.course}/${f.node}/${f.id}`} className='lh-t-12'>
                      <Tag size='small' color='orange'>{f.course} · {f.node} · {f.id}</Tag>
                      {f.issues.join('；')}
                    </Text>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Card>

      {/* 一键清理预览（确认对话框）：按节点分组，确认后才落归档 */}
      <Modal
        title={`清理预览 · ${cleanup?.total ?? 0} 道题将归档`}
        visible={cleanup !== null}
        onCancel={() => setCleanup(null)}
        footer={cleanup && cleanup.total > 0 ? [
          <Button key='cancel' onClick={() => setCleanup(null)}>取消</Button>,
          <Button key='ok' type='primary' status='warning' loading={cleanupBusy} onClick={() => void doCleanupApply()}>
            确认归档（可逆）
          </Button>,
        ] : [<Button key='close' onClick={() => setCleanup(null)}>关闭</Button>]}
      >
        {cleanup && (cleanup.total === 0
          ? <Empty description='没有可清理的题目：没有跳过节点的残留题，也没有学完后从未调度的休眠题。' />
          : (
            <Space direction='vertical' className='lh-full' size={8}>
              <Text type='secondary' className='lh-t-12'>
                归档不删除：归档题退出复习队列与统计，随时可在列表「显示已归档」里按原因恢复。
              </Text>
              {cleanup.groups.map(g => (
                <div key={`${g.course}/${g.node}`} className='lh-surface-1 lh-r-6 lh-p-8px-10px'>
                  <Space size={8} wrap>
                    <Tag size='small' color='orange'>{g.course} · {g.node}</Tag>
                    <Tag size='small'>{g.count} 道</Tag>
                    {g.reasons.skipped_node > 0 && <Tag size='small' color='gray'>跳过节点 {g.reasons.skipped_node}</Tag>}
                    {g.reasons.dormant_after_complete > 0 && <Tag size='small' color='gray'>学完后从未调度 {g.reasons.dormant_after_complete}</Tag>}
                  </Space>
                  {g.stems.map((s, i) => (
                    <Text key={i} type='secondary' className='lh-t-12 lh-block lh-pl-8'>· {s}</Text>
                  ))}
                </div>
              ))}
            </Space>
          ))}
      </Modal>

      <div className='lh-gap-10 lh-row lh-wrap'>
        <Input value={search} onChange={setSearch} placeholder='搜题干/节点' className='lh-w-220' allowClear />
        <Space size={6}><Text>显示已归档</Text><Switch checked={showArchived} onChange={setShowArchived} /></Space>
        <Button type='primary' size='small' className='lh-ml-auto' onClick={() => setCreating(true)}>自建题</Button>
      </div>

      {entries === null ? null : visible.length === 0 ? (
        <Empty description='本课还没有题目：点「自建题」，或让 agent 出题（learnhub_question_save 工具）' />
      ) : (
        <Table size='small' data={visible} rowKey={e => `${e.course}/${e.node}/${e.qid}`}
          columns={[
            { title: '节点', dataIndex: 'node', width: 170, ellipsis: true },
            { title: '#', width: 54, render: (_, e) => (focus && e.course === focus.course && e.node === focus.node && e.qid === focus.qid
              ? <Tag size='small' color='orange' title='来自难度建议的定位'>{e.qid}</Tag>
              : e.qid) },
            { title: '题型', width: 70, render: (_, e) => <Tag size='small'>{KIND_LABEL[e.kind] ?? e.kind}</Tag> },
            { title: '题干', dataIndex: 'q', ellipsis: true },
            { title: '到期', width: 112, render: (_, e) => e.due ? (
              <Tag size='small' color={dueColor(e.due)}
                title={e.lastReview ? `上次复习 ${e.lastReview}` : undefined}>
                {e.due}
              </Tag>
            ) : <Text type='secondary' className='lh-t-12'>未调度</Text> },
            { title: '状态', width: 80, render: (_, e) => e.archived
              ? <Tag size='small' color='gray'
                  title={e.archivedReason ? `归档原因：${e.archivedReason}（恢复时清除）` : undefined}>已归档{e.archivedReason ? '·' + e.archivedReason : ''}</Tag>
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
        title={`自建题 · ${course}`} onCancel={() => setCreating(false)}>
        <CreateQuestionForm course={course} nodes={nodesForCourse}
          onDone={() => { setCreating(false); void load() }} />
      </Drawer>

      {/* 编辑抽屉（共享组件，#120）：会话内「…」菜单复用同一编辑面 */}
      <QuestionEditDrawer
        target={editing ? {
          course: editing.course, node: editing.node, qid: editing.qid, kind: editing.kind,
          q: editing.q, difficulty: editing.difficulty, options: editing.options,
        } : null}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load() }} />
    </Space>
  )
}
