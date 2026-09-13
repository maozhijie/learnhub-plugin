/** 课程卡网格（「我的课程」首屏主体，#208 迁出今日 / #209 落位）：自包含取数：复习队列是次要数据
 * （失败按空处理不翻页），跨页流经 learnhub:reload 补拉；逐课「复习」在本组件内
 * 拉起 ReviewSession（按课程过滤到期卡）。破坏性操作（重新生成/删除）与日常操作
 * 视觉隔离（#155）：收进「⋯」菜单并着 danger 色；显式确认步在页内 handler。 */
import { Button, Card, Dropdown, Menu, Message, Modal, Progress, Space, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { errorMessage } from '../hooks/useCommand'
import ReviewSession from './ReviewSession'
import type { AppFrame } from '../App'
import type { QueueCard, ReviewQueueDoc, StatusCourse } from '../types'

const { Text, Title } = Typography

/** 课程卡：进度 + 完成宣告 + 打开图/复习 + ⋯菜单（破坏性操作）。计数语义：
 * 未学 = unseen+ready。完成宣告（#142 雾区条款上半）：读侧折叠的宣告——完成判据满足时
 * 这里展示，零写侧状态。 */
export function CourseCard(props: {
  name: string
  counts: { unseen: number; ready: number; learning: number; review: number; mastered: number; skipped: number }
  total: number
  due: number
  completion?: StatusCourse['completion']
  onOpen: () => void
  onReview: () => void
  onRegenerate: () => void
  onDelete: () => void
}) {
  const notStarted = props.counts.unseen + props.counts.ready
  const done = props.counts.mastered
  const percent = props.total ? Math.round((done / props.total) * 100) : 0
  const goalLabel = props.completion?.goal_type === 'coverage' ? '覆盖锚定' : '能力锚定'
  return (
    <Card size='small' hoverable className='lh-card'>
      <div className='lh-col lh-gap-8'>
        <Title heading={6} className='lh-m-0'>{props.name}</Title>
        <Progress percent={percent} showText size='small' />
        <Space size={4} wrap>
          <Tag size='small' color='gray'>未学 {notStarted}</Tag>
          <Tag size='small' color='arcoblue'>进行 {props.counts.learning}</Tag>
          <Tag size='small' color='green'>复习 {props.counts.review}</Tag>
          <Tag size='small' color='green'>掌握 {done}</Tag>
          {props.counts.skipped > 0 && <Tag size='small' color='purple'>跳过 {props.counts.skipped}</Tag>}
          {props.due > 0 && <Tag size='small' color='red'>到期 {props.due}</Tag>}
          {props.completion?.complete && (
            <Tag size='small' color='green'>
              🎉 已完成（{goalLabel} · 终点「{props.completion.endpoint}」· {props.completion.declared} 宣告锚定）
            </Tag>
          )}
        </Space>
        <Space size={6} className='lh-full'>
          <Button size='mini' onClick={props.onOpen}>打开图</Button>
          <Button size='mini' onClick={props.onReview}>复习</Button>
          <span className='lh-ml-auto'>
            <Dropdown
              trigger='click'
              position='br'
              droplist={
                <Menu className='lh-minw-132'>
                  <Menu.Item key='regenerate' className='lh-text-warn' onClick={props.onRegenerate}>
                    重新生成…
                  </Menu.Item>
                  <Menu.Item key='delete' className='lh-text-danger' onClick={props.onDelete}>
                    删除课程…
                  </Menu.Item>
                </Menu>
              }>
              <Button size='mini' type='text' className='lh-p-0-6px'>…</Button>
            </Dropdown>
          </span>
        </Space>
      </div>
    </Card>
  )
}

/** 课程卡网格：课程树 × 状态面投影；次要数据 reviewQueue 自取（逐课复习过滤用）。 */
export default function CourseCardGrid({ frame }: { frame: AppFrame }) {
  const reviewQ = useCallback(() => api.reviewQueue().catch(() => null as ReviewQueueDoc | null), [])
  const [queueDoc, setQueueDoc] = useState<ReviewQueueDoc | null>(null)
  useEffect(() => { void reviewQ().then(setQueueDoc) }, [reviewQ])
  // 跨页流（提案应用/作答结算等）触发全局刷新事件时补拉到期数
  useEffect(() => {
    const h = () => { void reviewQ().then(setQueueDoc) }
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [reviewQ])

  const deleteCourse = (name: string) => {
    Modal.confirm({
      title: `删除课程「${name}」？`,
      content: '注册表移除，课程目录移入 学习中心/.trash/（可手工找回）。',
      onOk: async () => {
        try {
          const r = await api.courseDelete(name)
          Message.success(`已删除 ${r.removed}，目录在 ${r.trash}`)
          await frame.reload()
        } catch (err) {
          Message.error(errorMessage(err))
        }
      },
    })
  }

  // 整课重生成（与生成队列页同一 /course/reset 通道，进度在生成队列看）
  const regenerateCourse = (name: string) => {
    Modal.confirm({
      title: `重新生成课程「${name}」？`,
      content: (
        <div className='lh-lh-1p9'>
          <div>将删除该课程的：全部节正文与节清单、全部练习题、全部交互件与生成的图片。</div>
          <div className='lh-mt-8 lh-muted'>
            旧内容备份到 .trash（可恢复）；课程图谱、学习进度与掌握度保留。删除后按学习顺序逐节点重新生成（每个节点需数分钟），进度在「生成」入口实时展示。
          </div>
        </div>
      ),
      okText: '重新生成',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api.resetCourse(name)
          Message.success(`已重置「${name}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成`)
          await frame.reload()
        } catch (err) {
          Message.error(errorMessage(err))
        }
      },
    })
  }

  // 逐课复习：过滤跨课程到期队列成单课程会话（与复习横幅同一 ReviewSession 缝）
  const [session, setSession] = useState<{ cards: QueueCard[]; hint?: string } | null>(null)
  const startReview = (course: string) => {
    const cards = (queueDoc?.cards ?? []).filter(c => c.course === course)
    if (!cards.length) { Message.info('该课程暂无到期复习'); return }
    setSession({ cards, hint: queueDoc?.calibration_hint })
  }

  const courses = frame.tree?.courses ?? []
  if (courses.length === 0) return null
  return (
    <>
      <Card size='small' title='我的课程' className='lh-card'>
        <div className='lh-grid-cards'>
          {courses.map(c => {
            const s = frame.status?.courses.find(x => x.name === c.name)
            return (
              <CourseCard
                key={c.name} name={c.name} total={s?.total ?? 0} due={s?.due_today ?? 0}
                counts={s?.counts ?? { unseen: 0, ready: 0, learning: 0, review: 0, mastered: 0, skipped: 0 }}
                completion={s?.completion}
                onOpen={() => frame.openCourse(c.name, 'graph')}
                onRegenerate={() => regenerateCourse(c.name)}
                onReview={() => startReview(c.name)}
                onDelete={() => deleteCourse(c.name)} />
            )
          })}
        </div>
        <Text type='secondary' className='lh-t-12 lh-block lh-mt-8'>
          点「打开图」进入该课的单课工作台（罗盘与图首屏）。
        </Text>
      </Card>
      {session && (
        <ReviewSession queue={session.cards} calibrationHint={session.hint}
          onClose={() => setSession(null)}
          onFinish={async () => { await frame.reload(); setQueueDoc(await reviewQ()) }}
          onSettled={async () => { setQueueDoc(await reviewQ()) }} />
      )}
    </>
  )
}
