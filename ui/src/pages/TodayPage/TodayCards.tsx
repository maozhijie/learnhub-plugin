/** 今日页卡片组（页内子组件，就近维护）：XP 账本条 + 复习横幅 + 推荐流大卡
 * （#208 / ADR-0058 今日页成型；课程卡已迁出今日，住课程区「我的课程」的 CourseCardGrid）。横幅 C1/C2/E1 裸入口退役：笔记源/我的卡/导出到 Anki 收进
 * 「我的资产」菜单（AssetsMenu），漂移/挂起状态行与其直达动作保留。数据经 props
 * 注入，动作回调上抛——本文件不持取数状态（缝在 index.tsx）。 */
import { Button, Card, Message, Popconfirm, Progress, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import { recTypeMeta } from '../../lib/rec-events'
import type {
  AdviceItem, DiagnosticEntry, RecEvent, ReviewQueueDoc, XpStatus,
} from '../../types'

const { Text, Title } = Typography

/** XP 时间账本条：今日 XP / 每日目标环 + 连续学习天数（Math Academy 的进度货币）。 */
export function XpBar({ xp, onEditGoal }: { xp: XpStatus; onEditGoal: () => void }) {
  const percent = Math.min(100, Math.round((xp.today_xp / Math.max(1, xp.goal)) * 100))
  return (
    <Card size='small' className='lh-card'>
      <div className='lh-row lh-gap-20 lh-wrap'>
        <Progress type='circle' width={44} percent={percent} showText={false} />
        <div>
          <Text className='lh-strong lh-t-16'>{xp.today_xp} XP</Text>
          <Text type='secondary' className='lh-block lh-t-12'>今日 · 目标 {xp.goal} XP</Text>
        </div>
        <div>
          <Text className='lh-strong lh-t-16'>{xp.streak} 天</Text>
          <Text type='secondary' className='lh-block lh-t-12'>连续学习</Text>
        </div>
        <Button size='mini' type='text' className='lh-ml-auto' onClick={onEditGoal}>
          调整每日目标
        </Button>
      </div>
    </Card>
  )
}

/** 复习横幅：到期卡驱动（复习队列张数 + 开始复习）——队列已并入我的卡（ADR-0021），
 * 张数为题卡+自注卡合计。C1/C2/E1 裸入口退役（#208）：笔记源/我的卡/导出到 Anki
 * 收进「我的资产」菜单，横幅只留学习动作（开始复习/挖错误卡）。笔记源状态行（C1
 * #59/#72）保留：漂移 = 重新出题/归档旧题直达；挂起 = 重新注册/打开抽屉——这些是
 * 复习队列的供给维护动作，不是资产管理入口。动作全部面板内完成。 */
export function ReviewBanner({ reviewQ, onStart, onOpenSources, onRegenerateSource, onReregister, onMineErrors, mining }: {
  reviewQ: ReviewQueueDoc | null
  onStart: () => void
  onOpenSources: (focusId?: string) => void
  onRegenerateSource: (id: string) => void
  onReregister: (path: string) => void
  onMineErrors: () => void
  mining: boolean
}) {
  const dueCount = reviewQ?.total ?? 0
  const drifted = reviewQ?.note_drifted ?? []
  const suspended = reviewQ?.note_suspended ?? []
  return (
    <Card size='small' className='lh-card'>
      <div className='lh-row lh-gap-24 lh-wrap'>
        <div>
          <Text type='secondary' className='lh-block lh-t-12'>待复习</Text>
          <Text className='lh-t-20 lh-strong'>{dueCount}</Text>
          <Text type='secondary' className='lh-t-12'> 张卡到期</Text>
        </div>
        <div className='lh-ml-auto lh-flex lh-gap-8 lh-wrap'>
          <Button type='primary' onClick={onStart} disabled={dueCount === 0}>
            开始复习（{dueCount}）
          </Button>
          <Tooltip content='从你的错答流水挖高频错误模式，生成「三选一，其中一项是你的错法」辨别卡进复习队列（C-3）'>
            <Button onClick={onMineErrors} loading={mining}>挖错误卡</Button>
          </Tooltip>
        </div>
      </div>
      {(drifted.length > 0 || suspended.length > 0) && (
        <div className='lh-mt-8 lh-col lh-gap-4'>
          {drifted.map(d => (
            <div key={d.id} className='lh-row lh-gap-8 lh-wrap'>
              <Text type='warning' className='lh-t-12 lh-flex-1 lh-minw-220'>
                笔记源「{d.id}」{d.hint}
              </Text>
              <Popconfirm
                title='按笔记当前内容重新出题？'
                content='出题即确认当前内容（漂移清除）；旧题保留，可在笔记源抽屉里逐题归档。'
                onOk={() => onRegenerateSource(d.id)}>
                <Button size='mini' type='text'>重新出题</Button>
              </Popconfirm>
              <Button size='mini' type='text' onClick={() => onOpenSources(d.id)}>归档旧题</Button>
            </div>
          ))}
          {suspended.map(s => (
            <div key={s.id} className='lh-row lh-gap-8 lh-wrap'>
              <Text type='error' className='lh-t-12 lh-flex-1 lh-minw-220'>
                笔记源「{s.id}」{s.reason}
              </Text>
              <Tooltip content={`按原路径重新注册：${s.path}`}>
                <Button size='mini' type='text' onClick={() => onReregister(s.path)}>重新注册</Button>
              </Tooltip>
              <Button size='mini' type='text' status='danger' onClick={() => onOpenSources(s.id)}>管理笔记源</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 生成任务在推荐卡上的进度态（#160）：state = 排队/生成中；progress = 逐节进度
 * （任务进入逐节正文阶段后由 /generate/status 带出，大纲/出题阶段缺席）。 */
export interface RecGenState {
  state: 'queued' | 'running'
  progress?: { done: number; total: number; current?: string }
}

/** 进度态读法：「生成中 3/7」式逐节进度，而非只说在队列。 */
function genLabel(gen: RecGenState): string {
  if (gen.state === 'queued') return '排队中'
  const p = gen.progress
  return p && p.total > 0 ? `生成中 ${p.done}/${p.total}` : '生成中'
}

/** 推荐流大卡片：点开直接进 LessonView——主界面的核心动作；内联跳过（已有基础免学）。
 * 内容三态标识：已生成（点开有东西读）/ 生成中（带逐节进度，#160）/ 排队中；未生成节点
 * 主按钮让给「生成正文」（#158 口径统一：全面板同一动作同名，幽灵名清零）。
 * 「今天学它」pin 无界面入口（对话走 agent 工具设置）：pinned 事件只带「你选了它」
 * 置顶标识，不给取消按钮（取消 = 对 agent 说，或次日自动失效）。
 * 事件携带 diagnostics（B1 #69）时内联「重写此节」直达动作——Popconfirm 确认后才走
 * 单节重写管线（诊断建议先行，不自动动库）。
 * 事件携带 advice（A3 #54/#55，#72 UI 挂接）时内联「定向复习」直达——软闸弱前置 /
 * enc 成分技能的到期题一键进目标节点刷卡会话（建议先行，不拦直接学）。 */
export function RecCard({ e, gen, onOpen, onSkip, onGenerate, onAdvice }: {
  e: RecEvent
  gen?: RecGenState
  onOpen: () => void
  onSkip: () => void
  onGenerate: () => void
  onAdvice: (a: AdviceItem) => void
}) {
  const t = recTypeMeta(e.type)
  const generating = gen !== undefined
  const genText = gen ? genLabel(gen) : ''
  const [rewriting, setRewriting] = useState<string | null>(null)
  const rewriteSection = async (d: DiagnosticEntry) => {
    setRewriting(d.rewrite.section)
    try {
      const r = await api.sectionRewrite(d.rewrite.course, d.rewrite.node, d.rewrite.section)
      Message.success(r.message)
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setRewriting(null)
    }
  }
  return (
    <Card size='small' hoverable style={{ borderRadius: 10, cursor: 'pointer', borderLeft: `3px solid var(--color-${t.color === 'red' ? 'danger' : t.color === 'green' ? 'success' : t.color === 'arcoblue' ? 'arcoblue' : 'primary'}-6,#165dff)` }}>
        <div onClick={onOpen} className='lh-row lh-gap-12 lh-wrap'>
          <Tag color={t.color}>{t.label}</Tag>
          {e.pinned && <Tag size='small' color='gold'>你选了它</Tag>}
          <div className='lh-grow'>
          <Title heading={6} className='lh-m-0'>
            {e.node}
            {gen && <Tag size='small' color={gen.state === 'running' ? 'arcoblue' : 'gray'} className='lh-ml-8'>{genText}</Tag>}
            {!generating && e.hasContent && <Tag size='small' color='green' className='lh-ml-8'>已生成</Tag>}
          </Title>
          <Text type='secondary' className='lh-t-12'>
            {e.course}{e.region ? ` · ${e.region}` : ''}{e.why ? ` · ${e.why}` : ''}
          </Text>
          {e.intention && (
            <Text type='secondary' className='lh-t-12 lh-block lh-mt-2 lh-text-gold'>
              计划：在「{e.intention.cue}」之后，{e.intention.action}
            </Text>
          )}
        </div>
        {!e.hasContent && !generating ? (
          <Button size='mini' type='primary' status='warning' onClick={ev => { ev.stopPropagation(); onGenerate() }}>
            生成正文
          </Button>
        ) : (
          <Button size='mini' type='primary' loading={gen?.state === 'running'} disabled={gen?.state === 'queued'}
            onClick={ev => { ev.stopPropagation(); onOpen() }}>
            {gen ? genText : e.type === 'review' || e.type === 'overdue' ? '去复习' : '去学习'}
          </Button>
        )}
        {/* span 拦截冒泡：卡片本体点击是打开学习，Popconfirm 触发不应进学习视图 */}
        <span onClick={ev => ev.stopPropagation()}>
          <Popconfirm
            title={`跳过「${e.node}」？`}
            content='该节点将视同已通过，不再出现在推荐与阻塞判定；可在节点学习页取消跳过。'
            onOk={onSkip}>
            <Button size='mini' type='text' status='warning'>跳过</Button>
          </Popconfirm>
        </span>
      </div>
      {e.diagnostics?.length ? (
        <div onClick={ev => ev.stopPropagation()} className='lh-mt-8 lh-col lh-gap-4'>
          {e.diagnostics.map(d => (
            <div key={d.section} className='lh-row lh-gap-8 lh-wrap lh-surface-1 lh-r-6 lh-p-6px-10px'>
              <Tag size='small' color={d.signal === 'R1' ? 'red' : 'orange'}>{d.signal}</Tag>
              <Text type='secondary' className='lh-t-12 lh-flex-1 lh-minw-200'>「{d.sectionTitle}」{d.reason}</Text>
              {d.escalate ? (
                <Tooltip content='重写后仍反复失败：问题可能不在正文——请人工审题、归档坏题或检查前置'>
                  <Tag size='small' color='purple'>转人工处理</Tag>
                </Tooltip>
              ) : (
                <Popconfirm
                  title={`重写「${d.sectionTitle}」这一节？`}
                  content='走单节重写管线（过质检门 + 一轮修复）：只手术这一节正文（版本 +1），题库与复习计划不动。'
                  onOk={() => void rewriteSection(d)}>
                  <Button size='mini' type='text' loading={rewriting === d.rewrite.section}>重写此节</Button>
                </Popconfirm>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {e.advice?.length ? (
        <div onClick={ev => ev.stopPropagation()} className='lh-mt-8 lh-col lh-gap-4'>
          {e.advice.map(a => (
            <div key={a.node} className='lh-row lh-gap-8 lh-wrap lh-surface-1 lh-r-6 lh-p-6px-10px'>
              <Tag size='small' color='orange'>建议先复习</Tag>
              <Text type='secondary' className='lh-t-12 lh-flex-1 lh-minw-200'>
                先复习「{a.node}」的 {a.due} 道到期题（当前可回忆度 {Math.round(a.r * 100)}%）再回来继续
              </Text>
              <Tooltip content='一键进入该节点的定向复习会话（单节点自适应排序）'>
                <Button size='mini' type='text' onClick={() => onAdvice(a)}>定向复习</Button>
              </Tooltip>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}
