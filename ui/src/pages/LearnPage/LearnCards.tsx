/** 学习页头部卡片组（页内子组件，就近维护）：XP 账本条 + 复习横幅 + 推荐流大卡 +
 * 课程卡。数据经 props 注入，动作回调上抛——本文件不持取数状态（缝在 index.tsx）。 */
import { Button, Card, Message, Popconfirm, Progress, Space, Tag, Tooltip, Typography } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../../api'
import { errorMessage } from '../../hooks/useCommand'
import { recTypeMeta } from '../../lib/rec-events'
import type {
  AdviceItem, AnkiStatusDoc, DiagnosticEntry, RecEvent, ReviewQueueDoc, StatusCourse, XpStatus,
} from '../../types'

const { Text, Title } = Typography

/** XP 时间账本条：今日 XP / 每日目标环 + 连续学习天数（Math Academy 的进度货币）。 */
export function XpBar({ xp, onEditGoal }: { xp: XpStatus; onEditGoal: () => void }) {
  const percent = Math.min(100, Math.round((xp.today_xp / Math.max(1, xp.goal)) * 100))
  return (
    <Card size='small' style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <Progress type='circle' width={44} percent={percent} showText={false} />
        <div>
          <Text style={{ fontWeight: 600, fontSize: 16 }}>{xp.today_xp} XP</Text>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>今日 · 目标 {xp.goal} XP</Text>
        </div>
        <div>
          <Text style={{ fontWeight: 600, fontSize: 16 }}>{xp.streak} 天</Text>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>连续学习</Text>
        </div>
        <Button size='mini' type='text' style={{ marginLeft: 'auto' }} onClick={onEditGoal}>
          调整每日目标
        </Button>
      </div>
    </Card>
  )
}

/** 复习横幅：到期卡驱动（复习队列张数 + 开始复习）——队列已并入我的卡（ADR-0021），
 * 张数为题卡+自注卡合计。C2（#63/#72）：「导出到 Anki」按钮——把 vault 到期卡推送进
 * 桌面 Anki 的镜象卡组（AnkiConnect 未达也可点，引擎 fail loud 带指引）；按钮计数 =
 * Anki 通道当前到期分布（不含我的卡，ADR-0021 测量面不扩）。笔记源状态行（C1 #59/#72）：
 * 漂移 = 重新出题/归档旧题直达；挂起 = 重新注册。「我的卡管理」入口常驻（E1 #70）。
 * 动作全部面板内完成，不再只提示「去 dsh 里对 agent 说」。 */
export function ReviewBanner({ reviewQ, anki, onStart, onExportAnki, exporting, onOpenSources, onRegenerateSource, onReregister, onManage, onMineErrors, mining }: {
  reviewQ: ReviewQueueDoc | null
  anki: AnkiStatusDoc | null
  onStart: () => void
  onExportAnki: () => void
  exporting: boolean
  onOpenSources: (focusId?: string) => void
  onRegenerateSource: (id: string) => void
  onReregister: (path: string) => void
  onManage: () => void
  onMineErrors: () => void
  mining: boolean
}) {
  const dueCount = reviewQ?.total ?? 0
  const drifted = reviewQ?.note_drifted ?? []
  const suspended = reviewQ?.note_suspended ?? []
  const ankiDue = anki?.due.total
  const ankiOffline = anki?.anki != null && !anki.anki.connected
  return (
    <Card size='small' style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>待复习</Text>
          <Text style={{ fontSize: 20, fontWeight: 600 }}>{dueCount}</Text>
          <Text type='secondary' style={{ fontSize: 12 }}> 张卡到期</Text>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button type='primary' onClick={onStart} disabled={dueCount === 0}>
            开始复习（{dueCount}）
          </Button>
          <Tooltip content={ankiOffline
            ? `未连上 AnkiConnect：${anki?.anki?.error ?? '桌面 Anki 未打开'}`
            : '把到期卡推送到桌面 Anki 的 learnhub 卡组（Anki 纯作答通道，调度仍在 vault）'}>
            <Button onClick={onExportAnki} loading={exporting} status={ankiOffline ? 'warning' : 'default'}>
              导出到 Anki{typeof ankiDue === 'number' ? `（${ankiDue}）` : ''}
            </Button>
          </Tooltip>
          <Button onClick={() => onOpenSources()}>笔记源</Button>
          <Tooltip content='从你的错答流水挖高频错误模式，生成「三选一，其中一项是你的错法」辨别卡进复习队列（C-3）'>
            <Button onClick={onMineErrors} loading={mining}>挖错误卡</Button>
          </Tooltip>
          <Button onClick={onManage}>我的卡管理</Button>
        </div>
      </div>
      {(drifted.length > 0 || suspended.length > 0) && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {drifted.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text type='warning' style={{ fontSize: 12, flex: 1, minWidth: 220 }}>
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
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text type='error' style={{ fontSize: 12, flex: 1, minWidth: 220 }}>
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

/** 推荐流大卡片：点开直接进 LessonView——主界面的核心动作；内联跳过（已有基础免学）。
 * 内容三态标识：已生成（点开有东西读）/ 生成中 / 排队中；未生成节点主按钮让给「生成正文」
 * （#158 口径统一：全面板同一动作同名，幽灵名清零）。
 * 「今天学它」pin 无界面入口（对话走 agent 工具设置）：pinned 事件只带「你选了它」
 * 置顶标识，不给取消按钮（取消 = 对 agent 说，或次日自动失效）。
 * 事件携带 diagnostics（B1 #69）时内联「重写此节」直达动作——Popconfirm 确认后才走
 * 单节重写管线（诊断建议先行，不自动动库）。
 * 事件携带 advice（A3 #54/#55，#72 UI 挂接）时内联「定向复习」直达——软闸弱前置 /
 * enc 成分技能的到期题一键进目标节点刷卡会话（建议先行，不拦直接学）。 */
export function RecCard({ e, gen, onOpen, onSkip, onGenerate, onAdvice }: {
  e: RecEvent
  gen?: 'queued' | 'running'
  onOpen: () => void
  onSkip: () => void
  onGenerate: () => void
  onAdvice: (a: AdviceItem) => void
}) {
  const t = recTypeMeta(e.type)
  const generating = gen === 'running' || gen === 'queued'
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
        <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Tag color={t.color}>{t.label}</Tag>
          {e.pinned && <Tag size='small' color='gold'>你选了它</Tag>}
          <div style={{ minWidth: 0, flex: 1 }}>
          <Title heading={6} style={{ margin: 0 }}>
            {e.node}
            {gen === 'running' && <Tag size='small' color='arcoblue' style={{ marginLeft: 8 }}>生成中</Tag>}
            {gen === 'queued' && <Tag size='small' color='gray' style={{ marginLeft: 8 }}>排队中</Tag>}
            {!generating && e.hasContent && <Tag size='small' color='green' style={{ marginLeft: 8 }}>已生成</Tag>}
          </Title>
          <Text type='secondary' style={{ fontSize: 12 }}>
            {e.course}{e.region ? ` · ${e.region}` : ''}{e.why ? ` · ${e.why}` : ''}
          </Text>
          {e.intention && (
            <Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 2, color: 'var(--color-gold-6, #d48806)' }}>
              计划：在「{e.intention.cue}」之后，{e.intention.action}
            </Text>
          )}
        </div>
        {!e.hasContent && !generating ? (
          <Button size='mini' type='primary' status='warning' onClick={ev => { ev.stopPropagation(); onGenerate() }}>
            生成正文
          </Button>
        ) : (
          <Button size='mini' type='primary' loading={gen === 'running'} disabled={gen === 'queued'}
            onClick={ev => { ev.stopPropagation(); onOpen() }}>
            {gen === 'running' ? '生成中' : gen === 'queued' ? '排队中' : e.type === 'review' || e.type === 'overdue' ? '去复习' : '去学习'}
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
        <div onClick={ev => ev.stopPropagation()} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {e.diagnostics.map(d => (
            <div key={d.section} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '6px 10px',
            }}>
              <Tag size='small' color={d.signal === 'R1' ? 'red' : 'orange'}>{d.signal}</Tag>
              <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 200 }}>「{d.sectionTitle}」{d.reason}</Text>
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
        <div onClick={ev => ev.stopPropagation()} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {e.advice.map(a => (
            <div key={a.node} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              background: 'var(--color-fill-1,#f7f8fa)', borderRadius: 6, padding: '6px 10px',
            }}>
              <Tag size='small' color='orange'>建议先复习</Tag>
              <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
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

/** 课程卡（次要区）：进度 + 完成宣告 + 打开图/复习/删除。计数语义：未学 = unseen+ready。
 * 完成宣告（#142 雾区条款上半）：读侧折叠的宣告——完成判据满足时这里展示，零写侧状态。 */
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
    <Card size='small' hoverable style={{ borderRadius: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Title heading={6} style={{ margin: 0 }}>{props.name}</Title>
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
        <Space size={6}>
          <Button size='mini' onClick={props.onOpen}>打开图</Button>
          <Button size='mini' onClick={props.onReview}>复习</Button>
          <Button size='mini' type='text' status='warning' onClick={props.onRegenerate}>重新生成</Button>
          <Button size='mini' type='text' status='danger' onClick={props.onDelete}>删除</Button>
        </Space>
      </div>
    </Card>
  )
}
