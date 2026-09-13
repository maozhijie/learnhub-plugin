/** 生成页：待生成队列（生成队列.md 人审产物）+ 进行中/近期生成任务（服务端任务注册表）。
 * 页面刷新后状态从这里恢复（服务端注册表是事实来源，allo 同语义）。
 * 生成支持提示词风格变体（课程节生成-<style>，作用于逐节生成）；失败任务可重试续跑（ADR-0054）
 * 或一键转 dsh 会话讨论。
 * 双形态（#209 / ADR-0058）：不带 course = 全局面（课程区「生成队列」入口，整册视野
 * 含整课重生成）；带 course = 单课工作台「生长与队列」分栏的本课切片——同一注册表
 * 过滤出本课任务，全局暂停/恢复语义不变（恢复影响整条队列，切片内如实提示）。 */
import { Alert, Button, Card, Empty, Message, Modal, Progress, Select, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, discussInHost } from '../api'
import { usePolling } from '../hooks/usePolling'
import type { AppFrame } from '../App'
import type { GenJobItem, QueueItem } from '../types'
import { errorMessage } from '../hooks/useCommand'
import { GEN_PHASE_META, useGenJobActions } from '../hooks/useGenJobActions'

const { Text } = Typography

const STATUS_TAG: Record<GenJobItem['status'], { label: string; color: string }> = {
  queued: { label: '排队中', color: 'gray' },
  running: { label: '生成中', color: 'arcoblue' },
  cancelling: { label: '取消中', color: 'orange' },
  done: { label: '已完成', color: 'green' },
  partial: { label: '部分完成', color: 'purple' },
  failed: { label: '失败', color: 'red' },
  cancelled: { label: '已取消', color: 'gray' },
}

export default function GeneratePage({ frame, course }: { frame?: AppFrame; course?: string }) {
  const [jobs, setJobs] = useState<GenJobItem[] | null>(null)
  const [queuePaused, setQueuePaused] = useState(false)
  const [queuedCount, setQueuedCount] = useState(0)
  const [broken, setBroken] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [styles, setStyles] = useState<string[]>([])
  const [style, setStyle] = useState<string | undefined>(undefined)
  const [resetSel, setResetSel] = useState<string>('')
  const sliced = course !== undefined

  // 整课重生成课程清单直接复用 App 已加载的课程树
  const courses = frame?.tree?.courses.map(c => c.name) ?? []
  const resetTarget = sliced ? course! : (resetSel || frame?.course || courses[0] || '')

  const confirmReset = () => {
    if (!resetTarget) return
    Modal.confirm({
      title: '重新生成整课？',
      content: (
        <div className='lh-lh-1p9'>
          <div>将删除课程「{resetTarget}」的：</div>
          <div>· 全部节正文与节清单（学习页清空）</div>
          <div>· 全部练习题（题库）</div>
          <div>· 全部交互件与生成的图片</div>
          <div className='lh-mt-8 lh-muted'>
            旧内容备份到 .trash（可恢复）；课程图谱、学习进度与掌握度保留。删除后按学习顺序逐节点重新生成，每个节点需数分钟，进度在本页实时展示。
          </div>
        </div>
      ),
      okText: '重新生成',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api.resetCourse(resetTarget)
          Message.success(`已重置「${resetTarget}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成`)
          await load()
          frame?.reload()
        } catch (err) {
          Message.error(errorMessage(err))
        }
      },
    })
  }

  const load = useCallback(async () => {
    try {
      const [st, q] = await Promise.all([
        api.generateStatus(),
        api.queue().catch(() => [] as QueueItem[]),
      ])
      // 切片形态只看本课任务（全局注册表是事实源，切片是视图过滤不做账面裁剪）
      const mine = st.jobs.filter(j => !sliced || j.course === course)
      setJobs([...mine].sort((a, b) => {
        const rank = (x: GenJobItem) => (x.status === 'running' || x.status === 'cancelling' ? 0 : x.status === 'queued' ? 1 : 2)
        return rank(a) - rank(b) || a.startedAt.localeCompare(b.startedAt)
      }))
      setQueuePaused(st.queuePaused)
      setQueuedCount(mine.filter(j => j.status === 'queued').length)
      setBroken(st.broken ?? null)
      setQueue(sliced ? q.filter(i => i.course === course) : q)
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }, [sliced, course])

  // 恢复/重试走共享生成任务动作缝（与今日供给卡同实现，#209 评审收拢）
  const { busyKey: retryBusy, retry: retryShared, resumeQueue } = useGenJobActions({ onDone: load })

  useEffect(() => {
    void api.prompts().then(kinds => {
      setStyles(kinds
        .filter(k => k === '课程节生成' || k.startsWith('课程节生成-'))
        .map(k => (k === '课程节生成' ? '' : k.slice('课程节生成-'.length))))
    }).catch(() => setStyles([]))
  }, [])

  // 挂载即取 + 5s 轮询（任务与队列同源刷新）；非激活页签跳过取数、切回即补（ADR-0027）。
  // 切片形态挂在工作台视图下，轮询门认 'courses.course'。
  usePolling(load, { tab: sliced ? 'courses.course' : 'courses.queue', intervalMs: 5000 })

  // 任务定位（#155）：教练台在途任务条点击跳入时，focusJob 指到任务注册表 key——
  // 目标行加高亮类并滚入视野；任务尚未出现在注册表时随下一次轮询数据到位再试。
  const focusJob = frame?.focusJob ?? null
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusJob || focusedRef.current === focusJob) return
    const el = document.querySelector('tr.gen-job-focused')
    if (!el) return
    focusedRef.current = focusJob
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focusJob, jobs])

  const cancel = async (j: GenJobItem) => {
    try {
      await api.generateCancel(j.course, j.node)
      Message.success(j.status === 'queued' ? '已移出队列' : '已请求取消（结果会被丢弃）')
      await load()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  const generate = async (item: QueueItem) => {
    setBusyKey(`${item.course}/${item.node}`)
    try {
      const res = await api.generate(item.course, item.node, style || undefined)
      Message.success(res.message)
      await Promise.all([load(), frame?.reload()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <Space direction='vertical' className='lh-full' size={14}>
      <Card size='small' title={
        <Space size={10}>
          <span>{sliced ? `待生成队列（${course}）` : '待生成队列'}</span>
          {styles.length > 1 && (
            <Select value={style ?? ''} onChange={v => setStyle(v || undefined)} size='mini' className='lh-w-130'>
              {styles.map(s => <Select.Option key={s || '默认'} value={s}>{s ? `风格：${s}` : '默认风格'}</Select.Option>)}
            </Select>
          )}
        </Space>
      } className='lh-card'>
        <Text type='secondary' className='lh-block lh-mb-8'>
          来自 生成队列.md（agent 补内容建议 / 内容反馈自动入队）；一键生成后正文落盘 Obsidian，条目自动勾掉。
          {sliced && ' 此处只显本课条目，全局队列在「生成队列」入口。'}
        </Text>
        {queue === null ? null : queue.length === 0 ? (
          <Empty description={sliced ? '本课没有待生成条目' : '队列为空：在推荐卡或学习图对未生成节点点「生成正文」即可'} />
        ) : (
          <Table size='small' data={queue} rowKey={q => `${q.course}/${q.node}`} pagination={false}
            columns={[
              { title: '课程', dataIndex: 'course', width: 130 },
              { title: '节点', dataIndex: 'node', ellipsis: true },
              { title: '类型', width: 80, render: (_, q) => <Tag size='small' color={q.kind === '重生成' ? 'orange' : 'blue'}>{q.kind}</Tag> },
              { title: '原因', dataIndex: 'reason', ellipsis: true },
              { title: '优先级', dataIndex: 'priority', width: 80 },
              { title: '操作', width: 170, render: (_, q) => (
                <Space size={4}>
                  <Button size='mini' type='primary' loading={busyKey === `${q.course}/${q.node}`}
                    onClick={() => void generate(q)}>生成正文</Button>
                  <Button size='mini' type='text' onClick={() => frame?.openCourse(q.course, 'graph')}>去罗盘与图</Button>
                </Space>
              ) },
            ]} />
        )}
      </Card>
      <Card size='small' title={
        <Space size={10}>
          <span>{sliced ? `生成任务（${course}）` : '生成任务'}</span>
          {!sliced && courses.length > 0 && (
            <>
              <Select value={resetTarget} onChange={v => setResetSel(v)} size='mini' className='lh-w-170'>
                {courses.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
              </Select>
              <Button size='mini' status='danger' onClick={confirmReset}>重新生成整课</Button>
            </>
          )}
        </Space>
      } className='lh-card'>
        {broken && (
          <Alert
            type='error' className='lh-mb-8'
            content={<>生成任务注册表损坏，队列已停止接受新任务（防止坏档被覆盖）：<Text bold>{broken}</Text></>} />
        )}
        {queuePaused && queuedCount > 0 && (
          <Alert
            type='warning' className='lh-mb-8'
            content={<Space size={8}>
              <Text>进程重启后有 {queuedCount} 个{sliced ? '本课' : ''}排队任务已暂停（不自动开跑；恢复影响整条全局队列）。</Text>
              <Button size='mini' type='primary' onClick={() => void resumeQueue()}>恢复队列</Button>
            </Space>} />
        )}
        <Text type='secondary' className='lh-block lh-mb-8'>
          全局串行队列{sliced ? '的本课切片' : ''}：入队即返回，同一时刻只执行一个节点管线，按入队顺序后台执行；刷新页面不丢失。{sliced ? '种子起草与生长批由教练台分栏下发。' : '课程图的种子提案与生长批从教练台下发（入队即在本页看进度）。'}
        </Text>
        {jobs === null ? null : jobs.length === 0 ? (
          <Empty description='当前没有生成任务' />
        ) : (
          <Table size='small' data={jobs} rowKey={j => j.key} pagination={false}
            rowClassName={j => (j.key === focusJob ? 'gen-job-focused' : '')}
            columns={[
              { title: '节点', dataIndex: 'node', ellipsis: true, render: (_, j) => (
                <Space size={6}>
                  <span>{j.node}</span>
                  {j.phase && GEN_PHASE_META[j.phase] && (
                    <Tag size='small' color={GEN_PHASE_META[j.phase]!.color}>{GEN_PHASE_META[j.phase]!.label}</Tag>
                  )}
                </Space>
              ) },
              { title: '课程', dataIndex: 'course', width: 130 },
              { title: '开始时间', dataIndex: 'startedAt', width: 170, render: v => new Date(v).toLocaleTimeString() },
              { title: '状态', width: 90, render: (_, j) => {
                const t = STATUS_TAG[j.status]
                return <Tag size='small' color={t.color}>{t.label}</Tag>
              } },
              { title: '进度', width: 190, render: (_, j) => {
                const p = j.progress
                if (j.status === 'queued') return <Text type='secondary'>排队等待…</Text>
                if (!p || j.status !== 'running') return <Text type='secondary'>—</Text>
                return (
                  <Space size={8}>
                    <Progress size='mini' percent={p.total ? p.done / p.total : 0} className='lh-w-64' />
                    <Text type='secondary' className='lh-t-12 lh-maxw-100' ellipsis>
                      {p.done}/{p.total}{p.current ? ` · ${p.current}` : ''}
                    </Text>
                  </Space>
                )
              } },
              { title: '信息', dataIndex: 'message', ellipsis: true },
              { title: '操作', width: 170, render: (_, j) => (
                <Space size={4}>
                  {(j.status === 'running' || j.status === 'queued')
                    ? <Button size='mini' type='text' status='danger' onClick={() => void cancel(j)}>
                      {j.status === 'queued' ? '移出队列' : '取消'}
                    </Button>
                    : null}
                  {(j.status === 'failed' || j.status === 'partial') && (
                    <Button size='mini' type='text' status='warning'
                      loading={retryBusy === j.key}
                      onClick={() => void retryShared(j)}>重试</Button>
                  )}
                  {(j.status === 'failed' || j.status === 'partial') && (
                    <Button size='mini' type='text' onClick={() =>
                      discussInHost(j.course, j.node, `上次生成${j.status === 'partial' ? '部分完成，自动出题失败' : '失败'}：${j.message ?? '（无错误信息）'}。请分析原因并帮我修复，然后重试。`)
                    }>与 AI 讨论</Button>
                  )}
                </Space>
              ) },
            ]} />
        )}
      </Card>
    </Space>
  )
}
