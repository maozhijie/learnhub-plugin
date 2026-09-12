/** 学习页（主界面）：XP 时间账本条 + 复习横幅 + 「接下来学/复习」
 * 推荐流（点开直接进 LessonView）+ 课程卡（次要区）。二级视图 LessonView 承载
 * 正文/mastery 会话/完成。复习会话 = Anki 式刷卡队列：跨课程到期卡扁平排队，
 * 一卡一票（作答或满 5 秒申报忘记），背面自评 Hard/Good/Easy 推进调度；
 * 我的卡（E1）按 ADR-0021 汇入同一队列——按卡种分面：题卡走作答+AI 判卷，
 * 自注卡走 重述 → 翻面对照 → 自评（无绑定 XP，只计总账不进课程/节点账）。
 * 「今天学它」pin 不设界面入口（对话经 agent 工具 learnhub_pin_today 设置，
 * pinned 行仍显「你选了它」置顶标识）。
 * #72 UI 入口补全：横幅区挂 C1 笔记源抽屉 / C2 导出到 Anki / E1 我的卡管理，
 * 推荐卡渲染 A3 定向复习建议项（一键进目标节点刷卡），复习卡头部带 A1 可回忆度读数。
 * #183：取数走 useCommand 缝（推荐流是主数据、失败 = 页面失败态；横幅类次要数据
 * 失败按空处理不翻整页——既有语义），任务轮询走 usePolling。 */
import { Button, Card, Empty, Message, Modal, Space, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import LessonView from '../../components/LessonView'
import SeedFormModal from '../../components/SeedFormModal'
import { CommandBoundary } from '../../components/CommandBoundary'
import { useCommand, errorMessage } from '../../hooks/useCommand'
import { usePolling } from '../../hooks/usePolling'
import { sortRecEvents } from '../../lib/rec-events'
import { api } from '../../api'
import type { AppFrame } from '../../App'
import type { AdviceItem, LearnerCardItem, QueueCard, RecEvent } from '../../types'
import ReviewSession from './ReviewSession'
import { CourseCard, RecCard, ReviewBanner, XpBar } from './LearnCards'
import NoteSourceDrawer from './NoteSourceDrawer'
import LearnerCardManager from './LearnerCardManager'

const { Text, Title } = Typography

/** 建课引导（#159 退役）：学习页不再宣传「复制指令给 agent 建课」——唯一主动建课入口
 * 是教练台表单（SeedFormModal），空态按钮直达；agent 通道仍在册（工具照常受理），
 * 只是 UI 不再把它当作新手路径（ADR-0038 分流纪律）。 */

export default function LearnPage({ frame }: { frame: AppFrame }) {
  // 推荐流是本页主数据：它失败 = 页面失败态（#158）；xp/复习横幅/Anki 是次要数据，
  // 失败按空处理（Command 不翻转 data、页面按 null 渲染缺省），不让单点故障翻整页
  const rec = useCommand(() => api.recommend(12))
  const xp = useCommand(() => api.xp())
  const reviewQ = useCommand(() => api.reviewQueue())
  const anki = useCommand(() => api.ankiStatus())
  const [session, setSession] = useState<QueueCard[] | null>(null)
  // Self-Calibration 过信轻提示（ADR-0022 #104）：随会话启动的队列载荷带出
  const [calibrationHint, setCalibrationHint] = useState<string | undefined>(undefined)
  /** 建课表单（教练台种子起草；#159 起唯一主动建课入口，CreateDialog 已退役）。 */
  const [seedForm, setSeedForm] = useState(false)
  const [runningJobs, setRunningJobs] = useState(0)
  const [queuedJobs, setQueuedJobs] = useState(0)
  const [exportingAnki, setExportingAnki] = useState(false)
  /** #72 C1/E1：笔记源抽屉（focusId = 横幅「归档旧题」直达定位）与我的卡管理抽屉。
   * recentArchived = 会话级「本次已归档」清单（E1 恢复入口；关抽屉再开不清空）。 */
  const [sourceDrawer, setSourceDrawer] = useState<{ open: boolean; focusId: string | null }>({ open: false, focusId: null })
  const [cardMgrOpen, setCardMgrOpen] = useState(false)
  const [recentArchived, setRecentArchived] = useState<LearnerCardItem[]>([])
  /** 排队/生成中的节点（course/node → 阶段），推荐卡三态标识消费。 */
  const [genMap, setGenMap] = useState<Record<string, 'queued' | 'running'>>({})

  // 各命令的 reload 稳定（useCommand 内部 useCallback），解构后作 deps 不抖动
  const { reload: reloadRec } = rec
  const { reload: reloadXp } = xp
  const { reload: reloadReviewQ } = reviewQ
  const { reload: reloadAnki } = anki
  const reloadAll = useCallback(() =>
    Promise.all([reloadRec(), reloadXp(), reloadReviewQ(), reloadAnki()]).then(() => undefined),
  [reloadRec, reloadXp, reloadReviewQ, reloadAnki])

  // 从学习视图返回推荐流：XP/推荐流按最新数据重拉（作答结算发生在学习视图内）
  const prevLessonRef = useRef(frame.lesson)
  useEffect(() => {
    if (prevLessonRef.current && !frame.lesson) void reloadAll()
    prevLessonRef.current = frame.lesson
  }, [frame.lesson, reloadAll])

  // 后台生成悬浮指示条 + 队列状态轮询：活动任务集合出现终态边沿 → 重拉推荐流
  //（对应节点的「已生成」标识随之点亮）。边沿检测是页面逻辑，节拍样板在 usePolling。
  const activeKeysRef = useRef<Set<string>>(new Set())
  usePolling(async () => {
    try {
      const st = await api.generateStatus()
      const active = st.jobs.filter(j => j.status === 'running' || j.status === 'cancelling')
      const gen: Record<string, 'queued' | 'running'> = {}
      for (const j of st.jobs) {
        if (j.status === 'running' || j.status === 'cancelling') gen[`${j.course}/${j.node}`] = 'running'
        else if (j.status === 'queued') gen[`${j.course}/${j.node}`] = 'queued'
      }
      const keys = new Set(active.map(j => j.key))
      const edge = [...activeKeysRef.current].some(k => !keys.has(k))
      activeKeysRef.current = keys
      setRunningJobs(active.length)
      setQueuedJobs(st.queuedCount)
      setGenMap(gen)
      if (edge) void reloadAll()
    } catch {
      setRunningJobs(0)
      setQueuedJobs(0)
      setGenMap({})
    }
  }, { tab: 'learn', intervalMs: 5000 })

  useEffect(() => {
    const h = () => { void frame.reload(); void reloadAll() }
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [frame, reloadAll])

  const recData = rec.data
  const dueCards = reviewQ.data?.cards ?? []
  const events = recData?.events ?? []

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

  // C2 导出到 Anki（#63/#72）：横幅按钮直推到期卡（Anki 未开时引擎报错带指引）
  const exportAnki = async () => {
    setExportingAnki(true)
    try {
      const r = await api.ankiExport()
      Message.success(`已推送到 Anki：新增 ${r.added} · 更新 ${r.updated} · 移除 ${r.removed}（到期 ${r.total} 张）`)
      await reloadAll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setExportingAnki(false)
    }
  }

  // C1 笔记源动作（#59/#72）：横幅提示行直达——漂移重新出题 / 缺失重新注册
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

  // 课程卡入口的整课重生成（与生成页同一 /course/reset 通道，进度在生成页看）
  const regenerateCourse = (name: string) => {
    Modal.confirm({
      title: `重新生成课程「${name}」？`,
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <div>将删除该课程的：全部节正文与节清单、全部练习题、全部交互件与生成的图片。</div>
          <div style={{ marginTop: 8, color: 'var(--color-text-3)' }}>
            旧内容备份到 .trash（可恢复）；课程图谱、学习进度与掌握度保留。删除后按学习顺序逐节点重新生成（每个节点需数分钟），进度在「生成」页签实时展示。
          </div>
        </div>
      ),
      okText: '重新生成',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api.resetCourse(name)
          Message.success(`已重置「${name}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成`)
          await Promise.all([frame.reload(), reloadAll()])
        } catch (err) {
          Message.error(errorMessage(err))
        }
      },
    })
  }

  // 二级视图：节点学习（最大最丰富）
  if (frame.lesson) {
    return <LessonView course={frame.lesson.course} node={frame.lesson.node} frame={frame} />
  }

  const noCourses = frame.tree && frame.tree.courses.length === 0

  return (
    <Space direction='vertical' style={{ width: '100%' }} size={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Title heading={4} style={{ margin: 0 }}>学习中心</Title>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button onClick={() => setSeedForm(true)}>新建课程</Button>
        </div>
      </div>
      {/* 主数据三态（首载中/失败/内容——#158，缝级收口）：推荐流没到前其余区块不渲染 */}
      <CommandBoundary cmd={rec} variant='page' title='学习页加载失败'
        loadingNode={<Card size='small' style={{ borderRadius: 10 }}><Text type='secondary'>加载推荐与复习队列…</Text></Card>}>
        {() => (
          <>
            <XpBar xp={xp.data ?? { date: '', day_cutoff: '', today_xp: 0, goal: 30, streak: 0, streak_grace_days: 1, eta: [] }}
              onEditGoal={() => frame.goto('stats')} />
            <ReviewBanner reviewQ={reviewQ.data} anki={anki.data}
              onStart={() => { setCalibrationHint(reviewQ.data?.calibration_hint); setSession(dueCards) }}
              onExportAnki={() => void exportAnki()} exporting={exportingAnki}
              onOpenSources={focusId => setSourceDrawer({ open: true, focusId: focusId ?? null })}
              onRegenerateSource={id => void regenerateSource(id)}
              onReregister={path => void reregisterSource(path)}
              onManage={() => setCardMgrOpen(true)}
              onMineErrors={() => void mineErrors()} mining={mining} />

            {/* 核心区：「接下来学/复习」推荐流——点开直接进学习视图 */}
            {noCourses ? (
              <Card size='small' style={{ borderRadius: 10 }}>
                <Space direction='vertical' size={12} style={{ width: '100%', display: 'flex', alignItems: 'center', padding: '16px 0' }}>
                  <Text type='secondary'>还没有课程。起草一份种子提案（1–3 个起点 + 终点锚），一次人审即开工；图由教练随生长批逐步生长。</Text>
                  <Button type='primary' onClick={() => setSeedForm(true)}>新建课程（种子提案）</Button>
                </Space>
              </Card>
            ) : (events.length > 0 ? (
              <Card size='small' title='接下来' style={{ borderRadius: 10 }}>
                <Space direction='vertical' style={{ width: '100%' }} size={10}>
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
              <Empty description='暂无推荐：所有到期内容已处理。可在课程卡「打开图」里挑节点学习，或点右上角「新建课程」。' />
            ))}
          </>
        )}
      </CommandBoundary>

      {/* 课程卡（次要区） */}
      <Card size='small' title='我的课程' style={{ borderRadius: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
          {frame.tree?.courses.map(c => {
            const s = frame.status?.courses.find(x => x.name === c.name)
            return (
              <CourseCard
                key={c.name} name={c.name} total={s?.total ?? 0} due={s?.due_today ?? 0}
                counts={s?.counts ?? { unseen: 0, ready: 0, learning: 0, review: 0, mastered: 0, skipped: 0 }}
                completion={s?.completion}
                onOpen={() => { frame.setCourse(c.name); frame.goto('graph') }}
                onRegenerate={() => regenerateCourse(c.name)}
                onReview={() => {
                  const q = dueCards.filter(card => card.course === c.name)
                  if (!q.length) { Message.info('该课程暂无到期复习'); return }
                  setCalibrationHint(reviewQ.data?.calibration_hint)
                  setSession(q)
                }}
                onDelete={() => deleteCourse(c.name)} />
            )
          })}
        </div>
      </Card>

      {session && session.length > 0 && (
        <ReviewSession queue={session} calibrationHint={calibrationHint}
          onClose={() => setSession(null)}
          onFinish={async () => { await Promise.all([frame.reload(), reloadAll()]) }}
          onSettled={reloadAll} />
      )}
      {seedForm && <SeedFormModal visible={seedForm} mode='new' course={null} onCancel={() => setSeedForm(false)} />}
      <NoteSourceDrawer open={sourceDrawer.open} focusId={sourceDrawer.focusId}
        onClose={() => setSourceDrawer({ open: false, focusId: null })} onChanged={reloadAll} />
      <LearnerCardManager open={cardMgrOpen} onClose={() => setCardMgrOpen(false)} onChanged={reloadAll}
        archived={recentArchived} onArchivedChange={setRecentArchived} />

      {/* 后台生成悬浮指示条 */}
      {runningJobs > 0 && !frame.lesson && (
        <div
          role='button' tabIndex={0}
          onClick={() => frame.goto('generate')}
          onKeyDown={e => { if (e.key === 'Enter') frame.goto('generate') }}
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 100, cursor: 'pointer',
            background: 'var(--color-bg-2,#fff)', border: '1px solid var(--color-border-2,#e5e6eb)',
            borderRadius: 20, boxShadow: 'var(--color-shadow-1, 0 4px 10px rgba(0,0,0,0.1))',
            padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8,
          }}>
          <span style={{ color: 'var(--color-primary-6,#165dff)' }}>◌</span>
          <Text>{runningJobs} 个正文生成中{queuedJobs > 0 ? ` · ${queuedJobs} 个排队` : ''}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}>点击查看</Text>
        </div>
      )}
    </Space>
  )
}
