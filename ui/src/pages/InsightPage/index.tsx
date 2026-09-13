/** 洞察区（#210 / ADR-0058 改版 T6·洞察区成型；#183 前身统计页）：周月循环的
 * 观测与自我实验的家——周复盘 Weekly Kata + 记忆健康仪表盘 + 自评校准画像 + 沙盘
 * + N-of-1 实验 + 睡眠耦合建议 + Anki 通道 + XP 时间账本（今日 XP / streak / 每日
 * 目标编辑）+ 每课程预计完成天数 + 各课程阶段统计（未学 = unseen+ready；复习到期 =
 * 有到期题目的节点）+ 运行环境（模型透明）。
 * 细分区块见同目录页内子组件（MemoryHealth／CalibrationProfileCard／KataCard／
 * AnkiChannelCard／SandboxCard／Nof1Card／SleepCard／RuntimeCard）。
 * 实验室页签退役（#210）：沙盘/N-of-1/睡眠三件就地入本区，恒温器已在 T5 随教练台
 * 分栏安家——四个功能无一处丢失；实验开跑的**确认动作只在提案收件箱**（人审唯一处，
 * 见 Nof1Card），本区只提供直达入口。
 * #183：六路取数全走 useCommand 缝——失败显式进三态（旧版静默置空 = 永远「加载中」
 * 的假象不再有）；教练反馈是纯信息性横幅，失败按无内容处理（登记例外，见票面走查清单）。 */
import { Alert, Card, InputNumber, Button, Message, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { useCallback, useEffect, useState } from 'react'
import { CommandBoundary } from '../../components/CommandBoundary'
import { api } from '../../api'
import { useCommand, errorMessage } from '../../hooks/useCommand'
import type { AppFrame } from '../../App'
import type { StatusCourse } from '../../types'
import { MemoryHealthBody } from './MemoryHealth'
import CalibrationProfileCard from './CalibrationProfileCard'
import KataCard from './KataCard'
import AnkiChannelCard from './AnkiChannelCard'
import SandboxCard from './SandboxCard'
import Nof1Card from './Nof1Card'
import SleepCard from './SleepCard'
import RuntimeCard from './RuntimeCard'

const { Text } = Typography

export default function InsightPage({ frame }: { frame: AppFrame }) {
  const xp = useCommand(() => api.xp())
  const mem = useCommand(() => api.memory())
  const jol = useCommand(() => api.jol())
  const hints = useCommand(() => api.calibrationHints())
  const profile = useCommand(() => api.calibrationProfile())
  const coach = useCommand(() => api.coach())
  const [goal, setGoal] = useState<number>(30)
  const [saving, setSaving] = useState(false)

  // 各命令的 reload 稳定（useCommand 内部 useCallback），解构后作 deps 不抖动
  const { reload: reloadXp } = xp
  const { reload: reloadMem } = mem
  const { reload: reloadJol } = jol
  const { reload: reloadHints } = hints
  const { reload: reloadProfile } = profile
  const { reload: reloadCoach } = coach
  const reloadAll = useCallback(() =>
    Promise.all([reloadXp(), reloadMem(), reloadJol(), reloadHints(), reloadProfile(), reloadCoach()]).then(() => undefined),
  [reloadXp, reloadMem, reloadJol, reloadHints, reloadProfile, reloadCoach])

  useEffect(() => { if (xp.data) setGoal(xp.data.goal) }, [xp.data])
  // 作答/完成后回到本页能看到最新账本
  useEffect(() => {
    const h = () => void reloadAll()
    window.addEventListener('learnhub:reload', h)
    return () => window.removeEventListener('learnhub:reload', h)
  }, [reloadAll])

  const toggleJol = async (enabled: boolean) => {
    try {
      const r = await api.setJol({ enabled })
      jol.set(r)
      Message.success(enabled
        ? `预测抽查已开启（约每 ${Math.round(1 / Math.max(0.01, r.rate))} 张复习卡 1 张）`
        : '预测抽查已关闭：复习流不再弹预测')
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  // E4 抽样率（#72）：0<r≤1，即时保存（InputNumber 步进点击逐次触发）
  const rateJol = async (rate: number) => {
    if (!Number.isFinite(rate) || rate <= 0) return
    try {
      jol.set(await api.setJol({ rate }))
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  // 过信轻提示全局开关（ADR-0022 #104）：关掉后预测出口不再轻提醒、抽查密度不再加强
  const toggleHints = async (enabled: boolean) => {
    try {
      hints.set(await api.setCalibrationHints(enabled))
      Message.success(enabled ? '过信轻提示已开启' : '过信轻提示已关闭：预测出口不再提醒，抽查密度恢复默认')
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  const saveGoal = async () => {
    setSaving(true)
    try {
      const r = await api.setDailyGoal(goal)
      Message.success(`每日目标已调整为 ${r.goal} XP（约等于每天 ${r.goal} 分钟专注）`)
      await reloadAll()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space direction='vertical' className='lh-full' size={14}>
      <Alert type='info' content='洞察区是「提议非指令」区：沙盘是模型推演非承诺；实验的建议要你逐条确认才生效（确认在提案收件箱——人审唯一处）；这里发生的一切零 XP、不进掌握度、不碰调度语义。（恒温器在单课工作台的教练台分栏）' />
      {/* 可用的困难教练（#65 E5）：只读信息性反馈——低数据静默，触发才显示 */}
      {coach.data && coach.data.messages.length > 0 && (
        <Alert type='info' content={coach.data.messages.map(m => <div key={m}>{m}</div>)} />
      )}
      <KataCard courseNames={frame.tree?.courses.map(c => c.name) ?? []}
        onOpenInbox={() => frame.goto('courses.proposals')} />
      <Card size='small' title='记忆健康' className='lh-card'
        extra={<Text type='secondary' className='lh-t-12'>真实作答口径——合成首复习不计入</Text>}>
        <CommandBoundary cmd={mem}>
          {m => (
            <MemoryHealthBody mem={m} jol={jol.data} hints={hints.data}
              onToggleJol={enabled => void toggleJol(enabled)}
              onRateJol={rate => void rateJol(rate)}
              onToggleHints={enabled => void toggleHints(enabled)} />
          )}
        </CommandBoundary>
      </Card>
      <CommandBoundary cmd={profile} loadingNode={
        <Card size='small' title='自评校准画像' className='lh-card'>
          <Text type='secondary'>加载中…</Text>
        </Card>
      }>
        {p => <CalibrationProfileCard profile={p} />}
      </CommandBoundary>
      <SandboxCard courseNames={frame.tree?.courses.map(c => c.name) ?? []} />
      <Nof1Card frame={frame} />
      <SleepCard />
      <AnkiChannelCard />

      <Card size='small' title='XP 时间账本' className='lh-card'
        extra={xp.data && (
          <Space size={8}>
            <Text type='secondary' className='lh-t-12'>每日目标</Text>
            <InputNumber size='mini' mode='button' min={5} max={1000} step={5}
              value={goal} onChange={v => setGoal(Number(v) ?? 30)} className='lh-w-110' />
            <Button size='mini' type='primary' loading={saving} onClick={() => void saveGoal()}>保存</Button>
          </Space>
        )}>
        <CommandBoundary cmd={xp} loadingNode={<Text type='secondary'>加载中…</Text>}>
          {xpData => (
            <Space size={24} wrap>
              <div>
                <Text className='lh-strong lh-t-18'>{xpData.today_xp}</Text>
                <Text type='secondary' className='lh-t-12'>今日 XP（≈ 分钟专注）</Text>
              </div>
              <div>
                <Text className='lh-strong lh-t-18'>{xpData.streak}</Text>
                <Text type='secondary' className='lh-t-12'>连续学习天数（漏 {xpData.streak_grace_days} 天不断）</Text>
              </div>
              <div>
                <Text className='lh-strong lh-t-18'>{xpData.goal}</Text>
                <Text type='secondary' className='lh-t-12'>每日目标 XP</Text>
              </div>
            </Space>
          )}
        </CommandBoundary>
      </Card>

      <Card size='small' title='课程状态总览' className='lh-card'>
        <Table size='small' data={(frame.status?.courses ?? []) as StatusCourse[]} rowKey={c => c.id ?? c.name} pagination={false}
          columns={[
            { title: '课程', dataIndex: 'name' },
            { title: '总节点', dataIndex: 'total', width: 80 },
            { title: '未学', width: 70, render: (_, c) => <Tag size='small'>{c.counts.unseen + c.counts.ready}</Tag> },
            { title: '进行', width: 70, render: (_, c) => <Tag size='small' color='arcoblue'>{c.counts.learning}</Tag> },
            { title: '复习', width: 70, render: (_, c) => <Tag size='small' color='green'>{c.counts.review}</Tag> },
            { title: '掌握', width: 70, render: (_, c) => <Tag size='small' color='green'>{c.counts.mastered}</Tag> },
            { title: '已跳过', width: 80, render: (_, c) => c.counts.skipped > 0
              ? <Tag size='small' color='purple'>{c.counts.skipped}</Tag>
              : <Tag size='small' color='gray'>0</Tag> },
            { title: '今日到期', width: 90, render: (_, c) => c.due_today > 0
              ? <Tag size='small' color='red'>{c.due_today}</Tag>
              : <Tag size='small' color='gray'>0</Tag> },
          ]} />
      </Card>

      <Card size='small' title='预计完成（按当前每日目标外推）' className='lh-card'>
        {xp.data === null || xp.data.eta.length === 0 ? <Text type='secondary'>暂无启用课程。</Text> : (
          <Table size='small' data={xp.data.eta} rowKey={e => e.course} pagination={false}
            columns={[
              { title: '课程', dataIndex: 'course' },
              { title: '剩余节点', dataIndex: 'remaining', width: 100 },
              { title: '已完成', dataIndex: 'done', width: 90 },
              { title: '每节点 XP（历史估算）', dataIndex: 'per_node', width: 170 },
              { title: '预计天数', width: 100, render: (_, e) => (
                e.days > 0 ? <Tag size='small' color='arcoblue'>≈ {e.days} 天</Tag> : <Tag size='small' color='green'>已完成</Tag>
              ) },
            ]} />
        )}
        <Text type='secondary' className='lh-t-12 lh-block lh-mt-8'>
          ETA = 剩余节点 × 每节点 XP（该课程历史 XP / 已完成节点数，无历史按 12 XP 估） ÷ 每日目标。
          XP 记入作答流水：答对得题型权重 × 难度，提交过快且答错按乱猜扣分，同日重复作答不记账。
        </Text>
      </Card>

      <RuntimeCard frame={frame} />
    </Space>
  )
}
