/** 节点学习视图（最大最丰富的主学习容器）：
 * mastery 会话（PracticeFlow：读节→做题连对晋级）即学习主体，整课正文折叠
 * 供自由回看与加练出题；完成确认（正确率门禁：低于及格线默认拒绝，可 force）
 * + 跳过（已有基础）；按状态引导下一步（无正文→生成正文自动出题；有正文无题→
 * AI 出题）；生成/出题进行中轮询任务状态；「在图中查看」低频跳转。
 * 每节正文后「加我的理解」入口（E1 #70）：用自己的话写解释/例子/助记 → AI 对照
 * 该节要点给是非+定位反馈 → 存为「我的卡」（Learner Output：零 XP 零 canonical）。
 * 掌握度 = 口径 B 纯派生（masteryOfFm：0.7·记忆稳定度完成度 + 0.3·练习证据 EMA）。
 * #183：课文/题库/我的卡三路取数走 useCommand（任务在途 3s、空闲 15s 的自适应
 * 轮询走 usePolling——tick 返回下一次延迟），后台刷新失败保持旧数据不翻转。
 * 失败横幅（ADR-0054）：结构化失败清单 + 重试续跑/重写这一节/转 AI 修复/关闭四动作，
 * 「关闭」是视图状态存 UI 本地，不进任务账面。 */
import { Button, Card, Collapse, Empty, Input, Message, Modal, Popconfirm, Space, Spin, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import MdView from './MdView'
import PracticeFlow from './PracticeFlow'
import TutorDrawer from './TutorDrawer'
import ExplainDrawer from './ExplainDrawer'
import UnderstandingEntry from './UnderstandingEntry'
import { WidgetBusProvider } from './widget-bus'
import { CommandBoundary } from './CommandBoundary'
import { QUIZ_SOFT_CAP } from '../lib/quiz-rules'
import { api, discussInHost } from '../api'
import { useCommand, errorMessage } from '../hooks/useCommand'
import { usePolling } from '../hooks/usePolling'
import type { AppFrame } from '../App'
import type { GenJobItem } from '../types'

const { Text, Title } = Typography

const STAGE_LABEL: Record<string, { label: string; color: string }> = {
  unseen: { label: '未学', color: 'gray' },
  ready: { label: '就绪', color: 'blue' },
  learning: { label: '进行中', color: 'arcoblue' },
  review: { label: '复习', color: 'green' },
  mastered: { label: '已掌握', color: 'green' },
  skipped: { label: '已跳过', color: 'purple' },
}

export default function LessonView(props: { course: string; node: string; frame: AppFrame }) {
  const { course, node, frame } = props
  const lessonCmd = useCommand(() => api.lesson(node, course), [node, course])
  const bankCmd = useCommand(() => api.questions(course, node), [node, course])
  const cardsCmd = useCommand(() => api.learnerQueue(course), [course, node])
  const sections = lessonCmd.data?.sections ?? []
  const manifest = lessonCmd.data?.manifest ?? null
  const stage = lessonCmd.data?.stage ?? null
  const mastery = bankCmd.data?.mastery ?? 0
  const myCards = (cardsCmd.data?.cards ?? []).filter(c => c.node === node)
  const [busy, setBusy] = useState<string | null>(null)
  const [job, setJob] = useState<GenJobItem | null>(null)
  /** mastery 会话是否走完全部节（走完才放行「完成学习」）。 */
  const [sessionPassed, setSessionPassed] = useState(false)
  const [tutorOpen, setTutorOpen] = useState(false)
  const [explainOpen, setExplainOpen] = useState(false)
  const [discussOpen, setDiscussOpen] = useState(false)
  const [discussIntent, setDiscussIntent] = useState('')
  const jobRef = useRef<GenJobItem | null>(null)
  /** 上次见到的正文版本（增量刷新：其他视图/agent 修订了正文时静默刷新）。 */
  const lastVersionRef = useRef<number | null>(null)
  /** 练习会话存续中（PracticeFlow 挂载）——冻结语义开关的每次渲染镜像（ADR-0027）。 */
  const sessionActiveRef = useRef(false)
  sessionActiveRef.current = (bankCmd.data?.questions?.length ?? 0) > 0
  /** 会话期间后台内容有更新（冻结不打断）：轻提示横幅；本课结束后重进生效。 */
  const [staleNotice, setStaleNotice] = useState(false)
  useEffect(() => { setStaleNotice(false) }, [course, node])

  // 失败横幅的「关闭」（ADR-0054）：视图状态存 UI 本地（任务注册表是账面、不掺视图状态），
  // 按任务记录粒度（startedAt）记忆——新一轮任务（重试续跑后）横幅照常出现。
  const failKey = job ? `learnhub:failHidden:${course}/${node}:${job.startedAt}` : null
  const [failHidden, setFailHidden] = useState(false)
  useEffect(() => {
    setFailHidden(false)
    if (failKey && localStorage.getItem(failKey) === '1') setFailHidden(true)
  }, [failKey])
  const dismissFailure = () => {
    if (failKey) { try { localStorage.setItem(failKey, '1') } catch { /* 隐私模式等：本次会话内仍生效 */ } }
    setFailHidden(true)
  }

  // 重拉三路数据。缝在失败时保持旧数据不翻转（区别于旧版非 silent 清空重来的闪断：
  // 会话存续冻结语义 ADR-0027 由「数据不置空」更强的保证承载）。
  // 只被事件回调消费，不做 useCallback（reload 本身稳定，重复点击安全）。
  const refresh = async () => {
    await Promise.all([lessonCmd.reload(), bankCmd.reload(), cardsCmd.reload()])
  }

  // 生成/出题进行中：轮询本节点任务（running 时 3s，空闲 15s；非激活页签 15s 节拍不取数）
  const poll = useCallback(async (): Promise<GenJobItem | null> => {
    try {
      const jobs = (await api.generateStatus()).jobs
      const mine = jobs.find(j =>
        j.course === course && j.node === node && (j.status === 'running' || j.status === 'cancelling'))
        ?? jobs.find(j => j.course === course && j.node === node) ?? null
      jobRef.current = mine
      setJob(mine)
      return mine
    } catch {
      return null
    }
  }, [course, node])

  const wasActiveRef = useRef(false)
  usePolling(async () => {
    const mine = await poll()
    const active = !!mine && (mine.status === 'running' || mine.status === 'cancelling')
    // 任务完成边沿（running→终态）：出题任务（phase=quiz）的新题增量并入当前会话
    // （ADR-0027 增量并入语义，静默刷新不打断作答）；内容管线的正文/结构变化仍冻结
    // 到本课结束后重进生效，只留轻提示。
    if (wasActiveRef.current && !active) {
      wasActiveRef.current = false
      void frame.reload()
      if (mine?.phase === 'quiz') void refresh()
      else if (sessionActiveRef.current) setStaleNotice(true)
      else void refresh()
    } else if (active) wasActiveRef.current = true
    // 增量刷新：正文版本变化（dsh 会话里 agent 修订了正文）→ 静默刷新当前视图
    const v = mine?.contentVersion
    if (v !== undefined && lastVersionRef.current !== null && v !== lastVersionRef.current) {
      if (sessionActiveRef.current) setStaleNotice(true)
      else void refresh()
    }
    if (v !== undefined) lastVersionRef.current = v
    return active ? 3000 : 15000
  }, { tab: 'today', intervalMs: 3000, idleMs: 15000 })

  const generate = async () => {
    setBusy('generate')
    try {
      const res = await api.generate(course, node)
      Message.success(res.message)
      await Promise.all([refresh(), frame.reload()])
      void poll()
    } catch (err) {
      Message.error(errorMessage(err))
      await Promise.all([poll(), refresh()])
    } finally {
      setBusy(null)
    }
  }

  /** AI 出题（#118 任务化）：入队即返回，进度经任务轮询显示（横幅「正在出题」），
   * 完成边沿静默刷新 questions 并入轮次。定向补题（struggle，#117）只补当前节、
   * 每次 3 道，由 PracticeFlow 触发后同样走任务队列。
   * skipped 节点出题需显式确认（Q13）：跳过视同已通过、原题已归档，再出题通常用不上。 */
  const confirmSkippedThen = (run: () => Promise<void>): void => {
    if (stage !== 'skipped') { void run(); return }
    Modal.confirm({
      title: '该节点已跳过',
      content: '跳过的节点视同已通过（原有题目已在跳过时归档，可在题库恢复）。为它新出的题大概率不会被用到——确认仍要出题吗？',
      okText: '仍要出题',
      cancelText: '算了',
      onOk: () => run(),
    })
  }
  const makeQuestions = (): void => confirmSkippedThen(async (): Promise<void> => {
    setBusy('quiz')
    try {
      const r = await api.questionGenerate(course, node, 6)
      Message.info(r.message)
      await poll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  })
  /** struggle 定向补题（#117）：只补当前卡住的节，每次 3 道（服务端缺省），
   * 任务化入队后经完成边沿静默刷新并入本题组。 */
  const makeSectionQuestions = (section: { id: string; title: string }): void => confirmSkippedThen(async (): Promise<void> => {
    setBusy(`quiz:${section.id}`)
    try {
      const r = await api.questionGenerate(course, node, undefined, { section })
      Message.info(r.message)
      await poll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  })

  /** 完成确认：直接结算（引擎正确率门禁：低于及格线默认拒绝并提示，可 force 旁路）。
   * 成功后回学习中心页（推荐流已刷新，刚完成的节点不再出现）。 */
  const complete = async (force = false): Promise<void> => {
    setBusy('complete')
    try {
      const r = await api.nodeComplete(course, node, force)
      if (r.accepted === false) {
        Modal.confirm({
          title: '本轮还没过关',
          content: `${r.reason ?? '正确率低于及格线，建议明天再来或先复习前置概念。'}仍要标记完成吗？`,
          okText: '仍要完成',
          cancelText: '再练练',
          onOk: () => complete(true),
        })
        return
      }
      Message.success(`已完成${r.initialized ? `：${r.initialized} 道题进入复习循环` : ''}${r.due ? `（下次复习 ${r.due}）` : ''}`)
      await frame.reload()
      window.dispatchEvent(new Event('learnhub:reload'))
      frame.closeLesson()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleSkip = async () => {
    setBusy('skip')
    try {
      const skipping = stage !== 'skipped'
      const r = await api.nodeSkip(course, node, skipping)
      Message.success(skipping
        ? `已跳过：该节点视同已通过，不再出现在推荐与阻塞判定${r.archived ? `；${r.archived} 道未归档题已一并归档（题库「显示已归档」可恢复）` : ''}`
        : '已取消跳过（此前跳过时归档的题不会自动恢复，可在题库按原因 skip 筛出恢复）')
      await Promise.all([refresh(), frame.reload()])
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  /** 单节重写：指定节重新生成并过门（节清单里有 id 的节才可重写）。
   * 会话存续中冻结（ADR-0027）：不热替换正文，留提示，重进生效。 */
  const rewriteSection = async (sectionId: string) => {
    setBusy(`section:${sectionId}`)
    try {
      const res = await api.sectionRewrite(course, node, sectionId)
      Message.success(res.message)
      if (sessionActiveRef.current) setStaleNotice(true)
      else await refresh()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const hasContent = sections.length > 0
  const questions = bankCmd.data?.questions ?? null
  const hasQuestions = !!questions?.length
  // 未归档题软上限（#117）：questions 视图只含未归档题，length 即未归档数
  const quizSoftCapReached = (questions?.length ?? 0) >= QUIZ_SOFT_CAP
  const active = job && (job.status === 'running' || job.status === 'cancelling')
  const quizPending = !!active && job?.phase === 'quiz'
  const elapsed = job ? Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000) : 0
  const stageInfo = stage ? STAGE_LABEL[stage] ?? STAGE_LABEL.unseen : null

  // 状态引导：单一主按钮
  let nextAction: { label: string; onClick: () => void; loading: boolean } | null = null
  if (active) nextAction = null
  else if (!hasContent) nextAction = { label: '生成正文（自动出题）', onClick: () => void generate(), loading: busy === 'generate' }
  else if (!hasQuestions) nextAction = { label: 'AI 出题（6 道混合题型）', onClick: () => void makeQuestions(), loading: busy === 'quiz' }

  return (
    <WidgetBusProvider>
    <div className='lh-maxw-720 lh-m-0-auto lh-col lh-gap-14'>
      {/* 头部两行制：标题行（返回+标题+状态+掌握度）；动作行（主 CTA 左、AI 工具与跳过右） */}
      <div className='lh-col lh-gap-10'>
        <div className='lh-row lh-gap-10 lh-wrap'>
          <Button size='small' type='text' onClick={frame.closeLesson}>← 返回</Button>
          <Title heading={4} className='lh-m-0 lh-t-20'>{node}</Title>
          {stageInfo && <Tag color={stageInfo.color}>{stageInfo.label}</Tag>}
          <Tooltip content='掌握度 = 0.7×记忆稳定度完成度 + 0.3×练习证据 EMA（作答对错累积，复习推高稳定度）；题目作答正确率只用于完成门禁。点「完成学习」后全部题目进入复习循环：做过的按各自到期复习，没做过的明天开始。'>
            <Text type='secondary' className='lh-t-13 lh-help'>掌握度 {(mastery * 100).toFixed(0)}% ⓘ</Text>
          </Tooltip>
        </div>
        <div className='lh-row lh-gap-8 lh-wrap'>
          {nextAction && (
            <Button type='primary' loading={nextAction.loading} onClick={nextAction.onClick}>
              {nextAction.label}
            </Button>
          )}
          <div className='lh-row lh-gap-2 lh-wrap lh-ml-auto'>
            {/* E2「讲给我听」（#68）：学完出现（复习/已掌握态）、自愿可关——学习者讲、AI 听 */}
            {hasContent && (stage === 'review' || stage === 'mastered') && (
              <Button size='small' type='text' status='success' onClick={() => setExplainOpen(true)}>讲给我听</Button>
            )}
            <Button size='small' type='text' onClick={() => setTutorOpen(true)}>问 AI 老师</Button>
            <Button size='small' type='text' onClick={() => { setDiscussIntent(''); setDiscussOpen(true) }}>与 AI 讨论</Button>
            <Button size='small' type='text' onClick={() => frame.locateInGraph(node)}>在图中查看</Button>
            {!active && (
              <Button size='small' type='text' status='warning' loading={busy === 'skip'} onClick={() => void toggleSkip()}>
                {stage === 'skipped' ? '取消跳过' : '跳过'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Modal
        title={`与 AI 讨论本课 · ${node}`}
        visible={discussOpen}
        onCancel={() => setDiscussOpen(false)}
        footer={null} unmountOnExit>
        <Space direction='vertical' size={10} className='lh-full'>
          <Text type='secondary'>
            会在 dsh 里新开一个会话，自动带上本课上下文（正文/题库/掌握度/图位置）。
            适合：提修改意见让 AI 改正文、补题、调图结构等深度操作；答疑用「问 AI 老师」更快。
          </Text>
          <Input.TextArea
            value={discussIntent} onChange={setDiscussIntent}
            placeholder='想让 AI 做什么？如：例题 2 的讲解跳步了，请补充分步推导'
            autoSize={{ minRows: 3, maxRows: 6 }} />
          <Button type='primary' disabled={!discussIntent.trim()} onClick={() => {
            discussInHost(course, node, discussIntent.trim())
            setDiscussOpen(false)
            Message.info('已在新会话发起讨论（会话窗口已切回前台，学习中心页保持打开）')
          }}>开始讨论</Button>
        </Space>
      </Modal>

      <TutorDrawer course={course} node={node} visible={tutorOpen} onClose={() => setTutorOpen(false)} />

      <ExplainDrawer course={course} node={node} visible={explainOpen} onClose={() => setExplainOpen(false)} />

      {/* 生成/出题进行中：阶段 + 逐节进度 + 耗时 + 取消 */}
      {active && job && (
        <div className='lh-callout-info'>
          <Spin size={20} />
          <div className='lh-grow lh-col lh-gap-2'>
            <Text>
              {job.phase === 'quiz' ? '自动出题中' : job.phase === 'outline' ? '生成课程大纲中' : '逐节生成正文中'}（已 {elapsed}s）——
              {job.phase === 'quiz' ? '出题完成后即可练习' : '完成后自动出题，可先离开稍后回来'}
            </Text>
            {job.progress && job.phase === 'sections' && (
              <Text type='secondary' className='lh-t-12'>
                节进度 {job.progress.done}/{job.progress.total}{job.progress.current ? ` · 正在写「${job.progress.current}」` : ''}
              </Text>
            )}
          </div>
          <Button size='mini' type='text' status='danger'
            onClick={async () => {
              try {
                await api.generateCancel(course, node)
                Message.success('已请求取消')
                void poll()
              } catch (err) { Message.error(errorMessage(err)) }
            }}>取消</Button>
        </div>
      )}
      {!active && job && (job.status === 'failed' || job.status === 'partial' || job.message?.includes('失败')) && !failHidden && (
        <div className='lh-callout-danger'>
          <Text>{job.status === 'failed' ? '上次生成失败' : '部分完成'}：{job.message}</Text>
          {(job.failures ?? []).length > 0 && (
            <div className='lh-col lh-gap-4'>
              {(job.failures ?? []).map((f, i) => (
                <div key={i} className='lh-row lh-gap-8 lh-wrap'>
                  <Text type='secondary' className='lh-grow lh-t-12'>
                    ✗ {f.sectionTitle ?? f.sectionId ?? '未知节'}{f.finding ? `：${f.finding}` : ''}
                    {f.corpusRef ? `（语料 ${f.corpusRef}）` : ''}
                  </Text>
                  {f.sectionId && (
                    <Tooltip content='只重新生成这一节（过质检门后落盘），不动其余节'>
                      <Button size='mini' type='text' loading={busy === `section:${f.sectionId}`}
                        onClick={() => void rewriteSection(f.sectionId!)}>重写这一节</Button>
                    </Tooltip>
                  )}
                </div>
              ))}
            </div>
          )}
          <Space size={8}>
            {/* 续跑（ADR-0054）：重新入队即断点续跑——已就绪节跳过、只补缺失/失败节 */}
            <Button size='mini' type='primary' loading={busy === 'generate'} onClick={() => void generate()}>重试续跑</Button>
            <Button size='mini' type='text' onClick={() => {
              setDiscussIntent(`上次生成${job.status === 'partial' ? '部分完成' : '失败'}：${job.message ?? '（无错误信息）'}。请分析原因并帮我修复，然后重试。`)
              setDiscussOpen(true)
            }}>转 AI 修复</Button>
            <Button size='mini' type='text' onClick={dismissFailure}>关闭</Button>
          </Space>
        </div>
      )}

      {/* 后台内容更新提示（ADR-0027 冻结语义）：不打断当前练习，本课结束后重进生效 */}
      {staleNotice && (
        <div className='lh-callout-warn'>
          <Text type='secondary' className='lh-t-13 lh-flex-1'>
            本节点内容在后台有更新（正文/题目）。当前练习不受影响；本课结束后重进即见新版。
          </Text>
          <Button size='mini' type='text' onClick={() => setStaleNotice(false)}>知道了</Button>
        </div>
      )}

      {/* 主体：mastery 会话即学习界面——按节推进阅读与练习；manifest 驱动节序列（练习节一等化）；
      题库三态（首载 Spin / 失败重试 / 内容）由缝统一供给 */}
      <CommandBoundary cmd={bankCmd} loadingNode={<Card size='small' className='lh-card'><Spin dot /></Card>}>
        {bank => (
          bank.questions.length === 0
            ? (hasContent && !active && (
              <Empty description='还没有题目：点上方「AI 出题」生成一组混合题型练习' />
            ))
            : (
              <PracticeFlow key={`${course}/${node}`} course={course} node={node}
                sections={sections} manifest={manifest} questions={bank.questions}
                onSettled={() => void refresh()}
                onNeedMore={s => makeSectionQuestions(s)}
                quizPending={quizPending}
                quizSoftCap={quizSoftCapReached}
                onQuestionsMutated={() => void refresh()}
                onPassChange={setSessionPassed} />
            )
        )}
      </CommandBoundary>

      {/* 整课正文（折叠）：会话内已按节推进阅读；这里留给自由回看与单节重写 */}
      {hasContent && (
        <Card title='整课正文（自由阅读）' size='small' className='lh-card'
          extra={!active && (quizSoftCapReached ? (
            <Popconfirm
              title={`本节点未归档题已达 ${QUIZ_SOFT_CAP} 道软上限`}
              content='确认仍要再出一组（6 道）混合题型题吗？'
              onOk={() => void makeQuestions()}>
              <Button size='mini' type='text' loading={busy === 'quiz'}>AI 再出题</Button>
            </Popconfirm>
          ) : (
            <Button size='mini' type='text' loading={busy === 'quiz'} onClick={() => void makeQuestions()}>
              AI 再出题
            </Button>
          ))}>
          <Collapse>
            <Collapse.Item name='full' header='展开完整正文'>
              <div className='lh-col lh-gap-4 lh-pt-8'>
                {sections.map((s, i) => {
                  const sid = s.id
                  return (
                    <div key={i}>
                      {s.title && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          margin: `${i === 0 ? 0 : 22}px 0 8px`, maxWidth: 680,
                        }}>
                          <h2 className='lh-t-19 lh-strong lh-lh-1p4 lh-m-0'>{s.title}</h2>
                          {sid && !active && (
                            <Tooltip content='让 AI 重新生成这一节（过质检门后落盘）'>
                              <Button size='mini' type='text' loading={busy === `section:${sid}`}
                                onClick={() => void rewriteSection(sid)}>重写</Button>
                            </Tooltip>
                          )}
                        </div>
                      )}
                      <MdView md={s.md} />
                      {/* E1「加我的理解」（#70）：每节正文后的自注入口——判词只入档案 */}
                      {sid && (
                        <UnderstandingEntry
                          course={course} node={node} sectionId={sid}
                          existingCount={myCards.filter(c => c.source_section === s.title).length}
                          onAdded={() => void refresh()} />
                      )}
                    </div>
                  )
                })}
              </div>
            </Collapse.Item>
          </Collapse>
        </Card>
      )}

      {/* 完成确认：mastery 会话全部节过关（或本节点无题）才放行；直接结算，拒绝由引擎门禁提示 */}
      {!active && hasContent && stage !== 'skipped' && stage !== 'mastered' && (sessionPassed || !hasQuestions) && (
        <div className='lh-flex lh-center'>
          <Button type='primary' status='success' size='large' loading={busy === 'complete'}
            onClick={() => void complete()}>
            完成学习
          </Button>
        </div>
      )}
      {!active && hasContent && hasQuestions && !sessionPassed && (
        <Text type='secondary' className='lh-t-12 lh-text-center'>
          走完上面会话的全部小节后，这里会出现「完成学习」。
        </Text>
      )}
    </div>
    </WidgetBusProvider>
  )
}
