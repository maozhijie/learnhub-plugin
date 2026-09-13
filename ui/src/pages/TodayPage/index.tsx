/** 今日页（#208 / ADR-0058 五区改版 T4，自学习页收窄成型）：学习日的全部——
 * XP/streak/每日目标、复习横幅、「接下来学/复习」推荐流（在酿节点带进度 chip）、
 * 供给卡（在酿 n/停摆恢复/失败重试）与待审闸门计数、「我的资产」菜单（我的卡/
 * 笔记源抽屉收进去；导出到 Anki 归洞察通道卡，#210）。课程卡列表不进今日（住课程区
 * 「我的课程」）；建课唯一主动入口在课程区教练台（#154/#159 既裁）。人审动作只在
 * 提案收件箱，今日只放计数；复习流/练习会话/申诉交互原样不动。
 * 二级视图 LessonView 承载正文/mastery 会话/完成。复习会话 = Anki 式刷卡队列：
 * 跨课程到期卡扁平排队，一卡一票（作答或满 5 秒申报忘记），背面自评 Hard/Good/Easy
 * 推进调度；我的卡（E1）按 ADR-0021 汇入同一队列。
 * #72 UI 入口史：横幅 C1/C2/E1 裸入口退役进资产菜单（Anki 出口随 #210 迁洞察通道卡），推荐卡渲染 A3 定向复习建议项，
 * 复习卡头部带 A1 可回忆度读数。
 * #183：取数走 useCommand 缝（推荐流是主数据、失败 = 页面失败态；横幅/供给/闸门等
 * 次要数据失败按空处理不翻整页——既有语义），任务轮询走 usePolling（生成状态 +
 * 待审提案数同一拍，供给卡与生成队列页同一事实源）。 */
import { Card, Empty, Message, Space, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import LessonView from '../../components/LessonView'
import { CommandBoundary } from '../../components/CommandBoundary'
import ReviewSession from '../../components/ReviewSession'
import { useCommand, errorMessage } from '../../hooks/useCommand'
import { usePolling } from '../../hooks/usePolling'
import { sortRecEvents } from '../../lib/rec-events'
import { api } from '../../api'
import type { AppFrame } from '../../App'
import type { AdviceItem, LearnerCardItem, QueueCard, RecEvent } from '../../types'
import { RecCard, ReviewBanner, XpBar } from './TodayCards'
import type { RecGenState } from './TodayCards'
import { SupplyRow } from './SupplyCard'
import type { SupplySnapshot } from './SupplyCard'
import { AssetsMenu } from './AssetsMenu'
import NoteSourceDrawer from './NoteSourceDrawer'
import LearnerCardManager from './LearnerCardManager'

const { Text, Title } = Typography

export default function TodayPage({ frame }: { frame: AppFrame }) {
  // 推荐流是本页主数据：它失败 = 页面失败态（#158）；xp/复习横幅/供给/闸门是
  // 次要数据，失败按空处理（Command 不翻转 data、页面按 null 渲染缺省），不让单点故障翻整页
  const rec = useCommand(() => api.recommend(12))
  const xp = useCommand(() => api.xp())
  const reviewQ = useCommand(() => api.reviewQueue())
  const [session, setSession] = useState<QueueCard[] | null>(null)
  // Self-Calibration 过信轻提示（ADR-0022 #104）：随会话启动的队列载荷带出
  const [calibrationHint, setCalibrationHint] = useState<string | undefined>(undefined)
  /** #72 C1/E1：笔记源抽屉（focusId = 横幅「归档旧题」直达定位）与我的卡管理抽屉，
   * 经「我的资产」菜单打开（#208）。recentArchived = 会话级「本次已归档」清单
   * （E1 恢复入口；关抽屉再开不清空）。 */
  const [sourceDrawer, setSourceDrawer] = useState<{ open: boolean; focusId: string | null }>({ open: false, focusId: null })
  const [cardMgrOpen, setCardMgrOpen] = useState(false)
  const [recentArchived, setRecentArchived] = useState<LearnerCardItem[]>([])
  /** 排队/生成中的节点（course/node → 状态 + 逐节进度），推荐卡进度态消费（#160）。 */
  const [genMap, setGenMap] = useState<Record<string, RecGenState>>({})
  /** 供给快照与待审提案数（#208）：与生成队列页同一事实源（/generate/status、/proposals）。 */
  const [supply, setSupply] = useState<SupplySnapshot | null>(null)
  const [pendingProps, setPendingProps] = useState<number | null>(null)
  const [runningJobs, setRunningJobs] = useState(0)
  const [queuedJobs, setQueuedJobs] = useState(0)

  // 各命令的 reload 稳定（useCommand 内部 useCallback），解构后作 deps 不抖动
  const { reload: reloadRec } = rec
  const { reload: reloadXp } = xp
  const { reload: reloadReviewQ } = reviewQ
  const reloadAll = useCallback(() =>
    Promise.all([reloadRec(), reloadXp(), reloadReviewQ()]).then(() => undefined),
  [reloadRec, reloadXp, reloadReviewQ])

  // 从学习视图返回推荐流：XP/推荐流按最新数据重拉（作答结算发生在学习视图内）
  const prevLessonRef = useRef(frame.lesson)
  useEffect(() => {
    if (prevLessonRef.current && !frame.lesson) void reloadAll()
    prevLessonRef.current = frame.lesson
  }, [frame.lesson, reloadAll])

  // 供给/闸门/进度一拍轮询：任务注册表 + 提案列表同源刷新；活动任务集合出现终态
  // 边沿 → 重拉推荐流（对应节点的「已生成」标识随之点亮）。边沿检测是页面逻辑，
  // 节拍样板在 usePolling；SupplyCard 的动作（恢复/重试）经本回调立即重拍。
  const activeKeysRef = useRef<Set<string>>(new Set())
  const refreshSupply = useCallback(async () => {
    let edge = false
    try {
      const st = await api.generateStatus()
      const active = st.jobs.filter(j => j.status === 'running' || j.status === 'cancelling')
      const gen: Record<string, RecGenState> = {}
      for (const j of st.jobs) {
        if (j.status === 'running' || j.status === 'cancelling') {
          gen[`${j.course}/${j.node}`] = { state: 'running', ...(j.progress ? { progress: j.progress } : {}) }
        } else if (j.status === 'queued') {
          gen[`${j.course}/${j.node}`] = { state: 'queued' }
        }
      }
      const keys = new Set(active.map(j => j.key))
      edge = [...activeKeysRef.current].some(k => !keys.has(k))
      activeKeysRef.current = keys
      setRunningJobs(active.length)
      setQueuedJobs(st.queuedCount)
      setGenMap(gen)
      setSupply({
        running: active,
        queuedCount: st.queuedCount,
        paused: st.queuePaused,
        broken: st.broken ?? null,
        failed: st.jobs.filter(j => j.status === 'failed' || j.status === 'partial'),
      })
    } catch {
      setRunningJobs(0)
      setQueuedJobs(0)
      setGenMap({})
      setSupply(null)
    }
    try {
      const props = await api.proposals()
      setPendingProps(props.filter(p => p.status === 'pending').length)
    } catch {
      setPendingProps(null)
    }
    if (edge) void reloadAll()
  }, [reloadAll])
  usePolling(refreshSupply, { tab: 'today', intervalMs: 5000 })

  useEffect(() => {
    const h = () => { void frame.reload(); void reloadAll(); void refreshSupply() }
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [frame, reloadAll, refreshSupply])

  const recData = rec.data
  const dueCards = reviewQ.data?.cards ?? []
  const events = recData?.events ?? []

  // 推荐卡便捷生成：入队全局队列（后台按序执行），卡片随轮询转为「排队中/生成中」
  const generateNode = async (e: RecEvent) => {
    try {
      const r = await api.generate(e.course, e.node)
      Message.success(r.message)
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  // 推荐卡内联跳过：与节点学习页同一 nodeSkip 语义（可逆，可在节点页取消）
  const skipNode = async (e: RecEvent) => {
    try {
      await api.nodeSkip(e.course, e.node, true)
      Message.success(`已跳过「${e.node}」：视同已通过，不再出现在推荐与阻塞判定`)
      await Promise.all([frame.reload(), reloadAll()])
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  /** 挖错误卡（C-3 #82）：全局课程挖矿 → 生成错误对比卡进错误 deck（新卡随复习队列出现）。 */
  const [mining, setMining] = useState(false)
  const mineErrors = async () => {
    setMining(true)
    try {
      const r = await api.errorGenerate()
      const n = r.generated.reduce((s, g) => s + g.ids.length, 0)
      if (n > 0) Message.success(`已生成 ${n} 张错误对比卡，进入复习队列`)
      else Message.info('这次没有挖到新的高频错误模式')
    } catch (err) {
      Message.warning(errorMessage(err))
    } finally {
      setMining(false)
      await Promise.all([frame.reload(), reloadAll()])
    }
  }

  // C1 笔记源动作（#59/#72）：横幅状态行直达——漂移重新出题 / 缺失重新注册
  const regenerateSource = async (id: string) => {
    try {
      const r = await api.noteSourceGenerate(id)
      Message.success(`「${id}」已按当前内容出题：新增 ${r.added} 题（旧题保留，可在笔记源抽屉里归档）`)
      await reloadAll()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }
  const reregisterSource = async (path: string) => {
    try {
      await api.noteSourceRegister(path)
      Message.success(`已恢复「${path}」的注册，卡池重新可用`)
      await reloadAll()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  // A3 建议项直达（#54/#55/#72）：拉目标节点的定向复习队列，直接进刷卡会话
  //（单节点会话自动启用 A1 难度带自适应）
  const startAdviceReview = async (e: RecEvent, a: AdviceItem) => {
    try {
      const doc = await api.reviewQueue(e.course, a.node)
      if (!doc.cards.length) { Message.info(`「${a.node}」暂无到期题：可直接点开节点学习`); return }
      setCalibrationHint(doc.calibration_hint)
      setSession(doc.cards)
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  // 二级视图：节点学习（最大最丰富）
  if (frame.lesson) {
    return <LessonView course={frame.lesson.course} node={frame.lesson.node} frame={frame} />
  }

  const noCourses = frame.tree && frame.tree.courses.length === 0

  return (
    <Space direction='vertical' className='lh-full' size={14}>
      <div className='today-head'>
        <Title heading={4} className='lh-m-0'>今日</Title>
        <div className='today-head-assets'>
          <AssetsMenu
            onOpenSources={() => setSourceDrawer({ open: true, focusId: null })}
            onManage={() => setCardMgrOpen(true)} />
        </div>
      </div>
      {/* 主数据三态（首载中/失败/内容——#158，缝级收口）：推荐流没到前其余区块不渲染 */}
      <CommandBoundary cmd={rec} variant='page' title='今日页加载失败'
        loadingNode={<Card size='small' className='lh-card'><Text type='secondary'>加载推荐与复习队列…</Text></Card>}>
        {() => (
          <>
            <XpBar xp={xp.data ?? { date: '', day_cutoff: '', today_xp: 0, goal: 30, streak: 0, streak_grace_days: 1, eta: [] }}
              onEditGoal={() => frame.goto('insight')} />
            <ReviewBanner reviewQ={reviewQ.data}
              onStart={() => { setCalibrationHint(reviewQ.data?.calibration_hint); setSession(dueCards) }}
              onOpenSources={focusId => setSourceDrawer({ open: true, focusId: focusId ?? null })}
              onRegenerateSource={id => void regenerateSource(id)}
              onReregister={path => void reregisterSource(path)}
              onMineErrors={() => void mineErrors()} mining={mining} />

            {/* 供给视野：课程供给（在酿/停摆/失败）+ 待审闸门（#208） */}
            <SupplyRow frame={frame} supply={supply} pending={pendingProps} onRefresh={refreshSupply} />

            {/* 核心区：「接下来学/复习」推荐流——点开直接进学习视图 */}
            {noCourses ? (
              <Card size='small' className='lh-card'>
                <Space direction='vertical' size={12} className='lh-full lh-row lh-p-16px-0'>
                  <Text type='secondary'>还没有课程：到课程区的教练台起草种子提案（1–3 个起点 + 终点锚），一次人审即开工。</Text>
                </Space>
              </Card>
            ) : (events.length > 0 ? (
              <Card size='small' title='接下来' className='lh-card'>
                <Space direction='vertical' className='lh-full' size={10}>
                  {sortRecEvents(events).map((e, i) => (
                    <RecCard key={i} e={e} gen={genMap[`${e.course}/${e.node}`]}
                      onOpen={() => frame.openLesson(e.course, e.node)}
                      onSkip={() => void skipNode(e)}
                      onGenerate={() => void generateNode(e)}
                      onAdvice={a => void startAdviceReview(e, a)} />
                  ))}
                </Space>
              </Card>
            ) : (
              <Empty description='暂无推荐：所有到期内容已处理。可到课程区打开学习图挑节点学习。' />
            ))}
          </>
        )}
      </CommandBoundary>

      {session && session.length > 0 && (
        <ReviewSession queue={session} calibrationHint={calibrationHint}
          onClose={() => setSession(null)}
          onFinish={async () => { await Promise.all([frame.reload(), reloadAll()]) }}
          onSettled={reloadAll} />
      )}
      <NoteSourceDrawer open={sourceDrawer.open} focusId={sourceDrawer.focusId}
        onClose={() => setSourceDrawer({ open: false, focusId: null })} onChanged={reloadAll} />
      <LearnerCardManager open={cardMgrOpen} onClose={() => setCardMgrOpen(false)} onChanged={reloadAll}
        archived={recentArchived} onArchivedChange={setRecentArchived} />

      {/* 后台生成悬浮指示条 */}
      {runningJobs > 0 && !frame.lesson && (
        <div
          role='button' tabIndex={0}
          onClick={() => frame.goto('courses.queue')}
          onKeyDown={e => { if (e.key === 'Enter') frame.goto('courses.queue') }}
          className='lh-float-hint'>
          <span className='lh-text-accent'>◌</span>
          <Text>{runningJobs} 个正文生成中{queuedJobs > 0 ? ` · ${queuedJobs} 个排队` : ''}</Text>
          <Text type='secondary' className='lh-t-12'>点击查看</Text>
        </div>
      )}
    </Space>
  )
}
