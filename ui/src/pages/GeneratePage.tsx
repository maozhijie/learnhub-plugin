/** 生成页：待生成队列（生成队列.md 人审产物）+ 进行中/近期生成任务（服务端任务注册表）。
 * 页面刷新后状态从这里恢复（服务端注册表是事实来源，allo 同语义）。
 * 生成支持提示词风格变体（课程节生成-<style>，作用于逐节生成）；失败任务可一键转 dsh 会话讨论。 */
import { Alert, Button, Card, Empty, Message, Modal, Progress, Select, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api, discussInHost } from '../api'
import { isActiveTab } from '../active-tab'
import type { AppFrame } from '../App'
import type { GenJobItem, QueueItem } from '../types'

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

/** phase → 人读标签（图域任务 = 面板下发/教练回合产物的队列形态）。 */
const PHASE_TAG: Partial<Record<NonNullable<GenJobItem['phase']>, { label: string; color: string }>> = {
  quiz: { label: '出题', color: 'cyan' },
  种子: { label: '种子起草', color: 'lime' },
  生长: { label: '生长批', color: 'orange' },
  罗盘: { label: '罗盘初画', color: 'gold' },
  反编译: { label: '目标反编译', color: 'purple' },
  计划: { label: '计划草案', color: 'purple' },
  里程碑: { label: '里程碑草案', color: 'purple' },
}

export default function GeneratePage({ frame }: { frame?: AppFrame }) {
  const [jobs, setJobs] = useState<GenJobItem[] | null>(null)
  const [queuePaused, setQueuePaused] = useState(false)
  const [queuedCount, setQueuedCount] = useState(0)
  const [queue, setQueue] = useState<QueueItem[] | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [styles, setStyles] = useState<string[]>([])
  const [style, setStyle] = useState<string | undefined>(undefined)
  const [resetSel, setResetSel] = useState<string>('')

  // 整课重生成课程清单直接复用 App 已加载的课程树
  const courses = frame?.tree?.courses.map(c => c.name) ?? []
  const resetTarget = resetSel || frame?.course || courses[0] || ''

  const confirmReset = () => {
    if (!resetTarget) return
    Modal.confirm({
      title: '重新生成整课？',
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <div>将删除课程「{resetTarget}」的：</div>
          <div>· 全部节正文与节清单（学习页清空）</div>
          <div>· 全部练习题（题库）</div>
          <div>· 全部交互件与生成的图片</div>
          <div style={{ marginTop: 8, color: 'var(--color-text-3)' }}>
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
          Message.error(err instanceof Error ? err.message : String(err))
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
      setJobs([...st.jobs].sort((a, b) => {
        const rank = (x: GenJobItem) => (x.status === 'running' || x.status === 'cancelling' ? 0 : x.status === 'queued' ? 1 : 2)
        return rank(a) - rank(b) || a.startedAt.localeCompare(b.startedAt)
      }))
      setQueuePaused(st.queuePaused)
      setQueuedCount(st.queuedCount)
      setQueue(q)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // 恢复重启后暂停的队列（遗留排队任务不自动开跑，防静默烧 token）
  const resumeQueue = async () => {
    try {
      const r = await api.generateResume()
      Message.success(`队列已恢复（${r.resumed} 个排队任务将按序执行）`)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
    // 生成中 5s 轮询（任务与队列同源刷新）；页签保活（ADR-0027）：非激活跳过取数
    const timer = setInterval(() => { if (isActiveTab('generate')) void load() }, 5000)
    return () => clearInterval(timer)
  }, [load])

  // 风格清单 = 「课程节生成」前缀的提示词类型（默认/内置变体/自建）——作用于逐节生成
  useEffect(() => {
    void api.prompts().then(kinds => {
      setStyles(kinds
        .filter(k => k === '课程节生成' || k.startsWith('课程节生成-'))
        .map(k => (k === '课程节生成' ? '' : k.slice('课程节生成-'.length))))
    }).catch(() => setStyles([]))
  }, [])

  const cancel = async (j: GenJobItem) => {
    try {
      await api.generateCancel(j.course, j.node)
      Message.success(j.status === 'queued' ? '已移出队列' : '已请求取消（结果会被丢弃）')
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }

  // 生长批失败重试（#157）：重新下发面板生长命令（显式重新裁决，服务端豁免失败阻尼）
  const retryGrowth = async (course: string) => {
    setBusyKey(`${course}/生长批`)
    try {
      const r = await api.coachGrowth(course)
      if (r.queued) Message.success(r.message)
      else Message.warning(r.message)
      await load()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  const generate = async (item: QueueItem) => {
    setBusyKey(`${item.course}/${item.node}`)
    try {
      const res = await api.generate(item.course, item.node, style || undefined)
      Message.success(res.message)
      await Promise.all([load(), frame?.reload()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <Card size='small' title={
        <Space size={10}>
          <span>待生成队列</span>
          {styles.length > 1 && (
            <Select value={style ?? ''} onChange={v => setStyle(v || undefined)} size='mini' style={{ width: 130 }}>
              {styles.map(s => <Select.Option key={s || '默认'} value={s}>{s ? `风格：${s}` : '默认风格'}</Select.Option>)}
            </Select>
          )}
        </Space>
      } style={{ borderRadius: 10 }}>
        <Text type='secondary' style={{ display: 'block', marginBottom: 8 }}>
          来自 生成队列.md（agent 补内容建议 / 内容反馈自动入队）；一键生成后正文落盘 Obsidian，条目自动勾掉。
        </Text>
        {queue === null ? null : queue.length === 0 ? (
          <Empty description='队列为空：在学习图页签对任意节点点「AI 生成正文」即可' />
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
                  <Button size='mini' type='text' onClick={() => {
                    frame?.setCourse(q.course)
                    frame?.goto('graph')
                  }}>去学习图</Button>
                </Space>
              ) },
            ]} />
        )}
      </Card>
      <Card size='small' title={
        <Space size={10}>
          <span>生成任务</span>
          {courses.length > 0 && (
            <>
              <Select value={resetTarget} onChange={v => setResetSel(v)} size='mini' style={{ width: 170 }}>
                {courses.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
              </Select>
              <Button size='mini' status='danger' onClick={confirmReset}>重新生成整课</Button>
            </>
          )}
        </Space>
      } style={{ borderRadius: 10 }}>
        {queuePaused && queuedCount > 0 && (
          <Alert
            type='warning' style={{ marginBottom: 8 }}
            content={<Space size={8}>
              <Text>进程重启后有 {queuedCount} 个排队任务已暂停（不自动开跑）。</Text>
              <Button size='mini' type='primary' onClick={() => void resumeQueue()}>恢复队列</Button>
            </Space>} />
        )}
        <Text type='secondary' style={{ display: 'block', marginBottom: 8 }}>
          全局串行队列：入队即返回，同一时刻只执行一个节点管线，按入队顺序后台执行；刷新页面不丢失。课程图的种子提案与生长批在 dsh 对话里进行（agent 侧）。
        </Text>
        {jobs === null ? null : jobs.length === 0 ? (
          <Empty description='当前没有生成任务' />
        ) : (
          <Table size='small' data={jobs} rowKey={j => j.key} pagination={false}
            columns={[
              { title: '节点', dataIndex: 'node', ellipsis: true, render: (_, j) => (
                <Space size={6}>
                  <span>{j.node}</span>
                  {j.phase && PHASE_TAG[j.phase] && (
                    <Tag size='small' color={PHASE_TAG[j.phase]!.color}>{PHASE_TAG[j.phase]!.label}</Tag>
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
                    <Progress size='mini' percent={p.total ? p.done / p.total : 0} style={{ width: 64 }} />
                    <Text type='secondary' style={{ fontSize: 12, maxWidth: 100 }} ellipsis>
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
                  {(j.status === 'failed' && j.phase === '生长') && (
                    <Button size='mini' type='text' status='warning'
                      loading={busyKey === j.key}
                      onClick={() => void retryGrowth(j.course)}>重试</Button>
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
