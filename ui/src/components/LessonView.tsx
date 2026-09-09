/** 节点学习视图（最大最丰富的主学习容器）：
 * mastery 会话（PracticeFlow：读节→做题连对晋级）即学习主体，整课正文折叠
 * 供自由回看与加练出题；完成确认（正确率门禁：低于及格线默认拒绝，可 force）
 * + 跳过（已有基础）；按状态引导下一步（无正文→生成正文自动出题；有正文无题→
 * AI 出题）；生成/出题进行中轮询任务状态；「在图中查看」低频跳转。
 * 每节正文后「加我的理解」入口（E1 #70）：用自己的话写解释/例子/助记 → AI 对照
 * 该节要点给是非+定位反馈 → 存为「我的卡」（Learner Output：零 XP 零 canonical）。
 * 掌握度 = 口径 B 纯派生（masteryOfFm：0.7·记忆稳定度完成度 + 0.3·练习证据 EMA）。 */
import { Button, Card, Collapse, Empty, Input, Message, Modal, Select, Space, Spin, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import MdView from './MdView'
import PracticeFlow from './PracticeFlow'
import TutorDrawer from './TutorDrawer'
import ExplainDrawer from './ExplainDrawer'
import { WidgetBusProvider } from './widget-bus'
import { api, discussInHost } from '../api'
import { isActiveTab } from '../active-tab'
import type { AppFrame } from '../App'
import type { GenJobItem, LearnerCardItem, LessonSection, QuestionItem, SectionManifestItem, UnderstandingResult } from '../types'

const { Text, Title } = Typography

const STAGE_LABEL: Record<string, { label: string; color: string }> = {
  unseen: { label: '未学', color: 'gray' },
  ready: { label: '就绪', color: 'blue' },
  learning: { label: '进行中', color: 'arcoblue' },
  review: { label: '复习', color: 'green' },
  mastered: { label: '已掌握', color: 'green' },
  skipped: { label: '已跳过', color: 'purple' },
}

const NOTE_KINDS = [
  { value: 'recall_cue', label: '提示重述' },
  { value: 'cloze_rewrite', label: '挖空重述' },
  { value: 'self_explain', label: '自注讲解' },
] as const

const VERDICT_TAG: Record<string, { color: string }> = {
  对: { color: 'green' },
  部分对: { color: 'orange' },
  错: { color: 'red' },
}

/** 「加我的理解」节级入口（E1 #70）：写一句自己的解释/例子/助记 → AI 对照该节
 * 要点给是非 + 定位（含糊/跳跃/说错）+ 可怎么补 → 存为「我的卡」（独立域自调度，
 * 零 XP、不进掌握度）。判词反馈就地展示；同节可多次写（同内容去重在引擎侧）。 */
function UnderstandingEntry(props: {
  course: string
  node: string
  sectionId: string
  existingCount: number
  onAdded: () => void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<'recall_cue' | 'cloze_rewrite' | 'self_explain'>('recall_cue')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<UnderstandingResult | null>(null)

  const save = async () => {
    setBusy(true)
    try {
      const r = await api.understandingAdd(props.course, props.node, text.trim(), {
        kind,
        section: props.sectionId,
      })
      setResult(r)
      setText('')
      setOpen(false)
      Message.success('已存入「我的卡」（可在学习中心页复习）')
      props.onAdded()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clozeMissing = kind === 'cloze_rewrite' && !/\{\{[^{}]+\}\}/.test(text)

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {!open && (
          <Button size='mini' type='text' status='success' onClick={() => setOpen(true)}>
            ＋ 加我的理解
          </Button>
        )}
        {props.existingCount > 0 && (
          <Tooltip content='这一节你已写过的理解（在「我的卡」队列复习）'>
            <Tag size='small' color='green'>我的卡 ×{props.existingCount}</Tag>
          </Tooltip>
        )}
      </div>
      {open && (
        <div style={{
          border: '1px solid var(--color-success-3,#00d0b6)', background: 'var(--color-fill-1,#f7f8fa)',
          borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 680,
        }}>
          <Space size={6} wrap>
            <Select value={kind} onChange={v => setKind(v as typeof kind)} size='mini' style={{ width: 120 }}>
              {NOTE_KINDS.map(k => <Select.Option key={k.value} value={k.value}>{k.label}</Select.Option>)}
            </Select>
            <Text type='secondary' style={{ fontSize: 12 }}>
              用你的话写一句这一节的解释 / 例子 / 助记；挖空重述请用 {'{{…}}'} 标出挖空。保存后 AI 会对照该节要点给反馈。
            </Text>
          </Space>
          <Input.TextArea
            value={text} onChange={setText}
            placeholder='如：等差数列就是每一步加固定的数……'
            autoSize={{ minRows: 2, maxRows: 6 }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size='small' type='text' onClick={() => setOpen(false)}>收起</Button>
            <Button size='small' type='primary' status='success' loading={busy}
              disabled={!text.trim() || clozeMissing} onClick={() => void save()}>
              保存并获取反馈
            </Button>
          </div>
        </div>
      )}
      {result && (
        <div style={{
          borderLeft: `3px solid var(--color-${VERDICT_TAG[result.verdict.verdict]?.color ?? 'gray'}-6,#86909c)`,
          background: 'var(--color-fill-1,#f7f8fa)', borderRadius: '0 6px 6px 0',
          padding: '8px 12px', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 680,
        }}>
          <Space size={6} wrap>
            <Tag size='small' color={VERDICT_TAG[result.verdict.verdict]?.color}>{result.verdict.verdict}</Tag>
            {result.verdict.tags.map(t => <Tag key={t} size='small' color='orange'>{t}</Tag>)}
            {result.verdict.advice && <Text type='secondary' style={{ fontSize: 12 }}>可怎么补：{result.verdict.advice}</Text>}
          </Space>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}><MdView md={result.reply} /></div>
          <Text type='secondary' style={{ fontSize: 12 }}>
            这条理解已存为「我的卡」（{NOTE_KINDS.find(k => k.value === result.card.kind)?.label}），判词只入档案——不计 XP、不影响掌握度。
          </Text>
        </div>
      )}
    </div>
  )
}

export default function LessonView(props: { course: string; node: string; frame: AppFrame }) {
  const { course, node, frame } = props
  const [sections, setSections] = useState<LessonSection[] | null>(null)
  const [manifest, setManifest] = useState<SectionManifestItem[] | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [mastery, setMastery] = useState(0)
  const [questions, setQuestions] = useState<QuestionItem[] | null>(null)
  const [myCards, setMyCards] = useState<LearnerCardItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [job, setJob] = useState<GenJobItem | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
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
  sessionActiveRef.current = questions !== null && questions.length > 0
  /** 会话期间后台内容有更新（冻结不打断）：轻提示横幅；本课结束后重进生效。 */
  const [staleNotice, setStaleNotice] = useState(false)
  useEffect(() => { setStaleNotice(false) }, [course, node])

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    // silent：作答后的统计刷新——保留旧内容直接覆盖，不闪 Spin（提交不整页刷新）
    // 非 silent 在会话存续中同样不置空（ADR-0027）：任何数据刷新不得卸载练习会话
    if (!opts?.silent && !sessionActiveRef.current) { setSections(null); setQuestions(null) }
    try {
      const [lesson, bank, cards] = await Promise.all([
        api.lesson(node, course).catch(() => null),
        api.questions(course, node).catch(() => null),
        api.learnerQueue(course).catch(() => null),
      ])
      setSections(lesson?.sections ?? [])
      setManifest(lesson?.manifest ?? null)
      setStage(lesson?.stage ?? null)
      setMastery(bank?.mastery ?? 0)
      setQuestions(bank?.questions ?? [])
      setMyCards((cards?.cards ?? []).filter(c => c.node === node))
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    }
  }, [course, node])

  useEffect(() => { void refresh() }, [refresh])

  // 生成/出题进行中：轮询本节点任务（running 时 3s，空闲 15s）
  const poll = useCallback(async () => {
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

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let wasActive = false
    const tick = async () => {
      // 页签保活：非激活页签跳过取数（组件常驻，定时器只保留节拍）
      if (!isActiveTab('learn')) { timer = setTimeout(() => void tick(), 15000); return }
      const mine = await poll()
      if (stopped) return
      const active = !!mine && (mine.status === 'running' || mine.status === 'cancelling')
      // 任务完成边沿（running→终态）：/generate 挂起请求若在出题阶段断开，
      // 出题仍会在服务端后台落盘，这里兜底刷新，避免「重开页面才见题目」。
      // 会话存续中冻结（ADR-0027）：不打断作答，只留轻提示，本课结束后重进生效。
      if (wasActive && !active) {
        wasActive = false
        void frame.reload()
        if (sessionActiveRef.current) setStaleNotice(true)
        else void refresh()
      } else if (active) wasActive = true
      // 增量刷新：正文版本变化（dsh 会话里 agent 修订了正文）→ 静默刷新当前视图
      const v = mine?.contentVersion
      if (v !== undefined && lastVersionRef.current !== null && v !== lastVersionRef.current) {
        if (sessionActiveRef.current) setStaleNotice(true)
        else void refresh({ silent: true })
      }
      if (v !== undefined) lastVersionRef.current = v
      timer = setTimeout(() => void tick(), active ? 3000 : 15000)
    }
    void tick()
    return () => { stopped = true; clearTimeout(timer) }
  }, [poll, refresh, frame.reload, reloadTick])

  const generate = async () => {
    setBusy('generate')
    try {
      const res = await api.generate(course, node)
      Message.success(res.message)
      await Promise.all([refresh(), frame.reload()])
      setReloadTick(t => t + 1)
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
      await Promise.all([poll(), refresh()])
    } finally {
      setBusy(null)
    }
  }

  const makeQuestions = async (): Promise<void> => {
    setBusy('quiz')
    try {
      const r = await api.questionGenerate(course, node, 6)
      Message.success(`已出题 ${r.added} 道（题库共 ${r.total}）`)
      await refresh()
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

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
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleSkip = async () => {
    setBusy('skip')
    try {
      const skipping = stage !== 'skipped'
      await api.nodeSkip(course, node, skipping)
      Message.success(skipping ? '已跳过：该节点视同已通过，不再出现在推荐与阻塞判定' : '已取消跳过')
      await Promise.all([refresh(), frame.reload()])
    } catch (err) {
      Message.error(err instanceof Error ? err.message : String(err))
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
      Message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const hasContent = !!sections?.length
  const hasQuestions = !!questions?.length
  const active = job && (job.status === 'running' || job.status === 'cancelling')
  const elapsed = job ? Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000) : 0
  const stageInfo = stage ? STAGE_LABEL[stage] ?? STAGE_LABEL.unseen : null

  // 状态引导：单一主按钮
  let nextAction: { label: string; onClick: () => void; loading: boolean } | null = null
  if (active) nextAction = null
  else if (!hasContent) nextAction = { label: '生成正文（自动出题）', onClick: () => void generate(), loading: busy === 'generate' }
  else if (!hasQuestions) nextAction = { label: 'AI 出题（6 道混合题型）', onClick: () => void makeQuestions(), loading: busy === 'quiz' }

  return (
    <WidgetBusProvider>
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 头部两行制：标题行（返回+标题+状态+掌握度）；动作行（主 CTA 左、AI 工具与跳过右） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Button size='small' type='text' onClick={frame.closeLesson}>← 返回</Button>
          <Title heading={4} style={{ margin: 0, fontSize: 20 }}>{node}</Title>
          {stageInfo && <Tag color={stageInfo.color}>{stageInfo.label}</Tag>}
          <Tooltip content='掌握度 = 0.7×记忆稳定度完成度 + 0.3×练习证据 EMA（作答对错累积，复习推高稳定度）；题目作答正确率只用于完成门禁。点「完成学习」后全部题目进入复习循环：做过的按各自到期复习，没做过的明天开始。'>
            <Text type='secondary' style={{ fontSize: 13, cursor: 'help' }}>掌握度 {(mastery * 100).toFixed(0)}% ⓘ</Text>
          </Tooltip>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {nextAction && (
            <Button type='primary' loading={nextAction.loading} onClick={nextAction.onClick}>
              {nextAction.label}
            </Button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
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
        <Space direction='vertical' size={10} style={{ width: '100%' }}>
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
        <div style={{
          border: '1px solid var(--color-primary-3,#94bfff)', background: 'var(--color-primary-light-1,#e8f3ff)',
          borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <Spin size={20} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            <Text>
              {job.phase === 'quiz' ? '自动出题中' : job.phase === 'outline' ? '生成课程大纲中' : '逐节生成正文中'}（已 {elapsed}s）——
              {job.phase === 'quiz' ? '出题完成后即可练习' : '完成后自动出题，可先离开稍后回来'}
            </Text>
            {job.progress && job.phase === 'sections' && (
              <Text type='secondary' style={{ fontSize: 12 }}>
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
              } catch (err) { Message.error(err instanceof Error ? err.message : String(err)) }
            }}>取消</Button>
        </div>
      )}
      {!active && job && (job.status === 'failed' || job.message?.includes('失败')) && (
        <div style={{
          border: '1px solid var(--color-danger-3,#f76560)', background: 'var(--color-danger-light-1,#ffece8)',
          borderRadius: 8, padding: '10px 14px',
        }}>
          <Text>{job.status === 'failed' ? '上次生成失败' : '部分完成'}：{job.message}</Text>
        </div>
      )}

      {/* 后台内容更新提示（ADR-0027 冻结语义）：不打断当前练习，本课结束后重进生效 */}
      {staleNotice && (
        <div style={{
          border: '1px solid var(--color-warning-3,#ffd257)', background: 'var(--color-warning-light-1,#fff7e8)',
          borderRadius: 8, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Text type='secondary' style={{ fontSize: 13, flex: 1 }}>
            本节点内容在后台有更新（正文/题目）。当前练习不受影响；本课结束后重进即见新版。
          </Text>
          <Button size='mini' type='text' onClick={() => setStaleNotice(false)}>知道了</Button>
        </div>
      )}

      {/* 主体：mastery 会话即学习界面——按节推进阅读与练习；manifest 驱动节序列（练习节一等化） */}
      {questions === null ? <Card size='small' style={{ borderRadius: 10 }}><Spin dot /></Card>
        : questions.length === 0
          ? (hasContent && !active && (
            <Empty description='还没有题目：点上方「AI 出题」生成一组混合题型练习' />
          ))
          : (
            <PracticeFlow key={`${course}/${node}`} course={course} node={node}
              sections={sections ?? []} manifest={manifest} questions={questions}
              onSettled={() => void refresh({ silent: true })}
              onNeedMore={() => makeQuestions()}
              onPassChange={setSessionPassed} />
          )}

      {/* 整课正文（折叠）：会话内已按节推进阅读；这里留给自由回看与单节重写 */}
      {hasContent && (
        <Card title='整课正文（自由阅读）' size='small' style={{ borderRadius: 10 }}
          extra={!active && (
            <Button size='mini' type='text' loading={busy === 'quiz'} onClick={() => void makeQuestions()}>
              AI 再出题
            </Button>
          )}>
          <Collapse>
            <Collapse.Item name='full' header='展开完整正文'>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8 }}>
                {sections.map((s, i) => {
                  const sid = s.id
                  return (
                    <div key={i}>
                      {s.title && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          margin: `${i === 0 ? 0 : 22}px 0 8px`, maxWidth: 680,
                        }}>
                          <h2 style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.4, margin: 0 }}>{s.title}</h2>
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
                          onAdded={() => void refresh({ silent: true })} />
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
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Button type='primary' status='success' size='large' loading={busy === 'complete'}
            onClick={() => void complete()}>
            完成学习
          </Button>
        </div>
      )}
      {!active && hasContent && hasQuestions && !sessionPassed && (
        <Text type='secondary' style={{ fontSize: 12, textAlign: 'center' }}>
          走完上面会话的全部小节后，这里会出现「完成学习」。
        </Text>
      )}
    </div>
    </WidgetBusProvider>
  )
}
