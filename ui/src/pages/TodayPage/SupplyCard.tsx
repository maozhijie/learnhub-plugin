/** 供给卡 + 待审闸门计数（#208 / ADR-0058 今日页唯一的新功能件）：学习日的供给
 * 视野——在酿 n / 停摆原因（中性文案）/ 恢复队列 / 失败重试，全部走既有任务注册表
 * 轮询缝（/generate/status，与生成队列页同一事实源所以状态一致），零新后端。
 * 停摆 = 重启后排队任务暂停（生成队列词条：重启后暂停待手动恢复，不自动开跑）；
 * 注册表损坏是硬停（防坏档被覆盖），供给卡只指路、修复在生成队列页。闸门计数 =
 * 待审提案数（人审动作只在收件箱，今日只放计数——今日页边界），点击深链提案收件箱。
 * 失败重试与生成页同路由：生长批 → coach/growth（显式重新裁决，豁免失败阻尼），
 * 出题 → question-generate，内容 → generate（断点续跑语义在服务端）。 */
import { Button, Card, Tag, Typography } from '@arco-design/web-react'
import { GEN_PHASE_META, useGenJobActions } from '../../hooks/useGenJobActions'
import type { AppFrame } from '../../App'
import type { GenJobItem } from '../../types'

const { Text } = Typography

/** 今日页轮询缝投影的供给快照（index.tsx 每拍 setState，本组件纯呈现+动作）。 */
export interface SupplySnapshot {
  /** 在酿（running/cancelling）任务。 */
  running: GenJobItem[]
  queuedCount: number
  /** 重启后队列暂停（排队任务不自动开跑——停摆态，恢复队列即解）。 */
  paused: boolean
  /** 任务注册表损坏（硬停，修复在生成队列页）。 */
  broken: string | null
  /** 失败/部分完成任务（可重实行——与生成页「重试」同路由）。 */
  failed: GenJobItem[]
}

/** 待审闸门计数卡：断粮时第一眼分清「闸门没审」还是「系统坏了」（#204 用户故事 4）。 */
export function GateCard({ frame, pending }: { frame: AppFrame; pending: number | null }) {
  return (
    <Card size='small' className='today-gate' hoverable style={{ borderRadius: 10, cursor: 'pointer' }}
      onClick={() => frame.goto('courses.proposals')}>
      <div className='today-supply-line'>
        <div>
          <Text type='secondary' style={{ display: 'block', fontSize: 12 }}>待审提案</Text>
          <Text className='today-supply-num'>{pending ?? '—'}</Text>
          {pending === 0 && <Text type='secondary' style={{ fontSize: 12 }}> 收件箱清着，不欠人审</Text>}
          {pending != null && pending > 0 && (
            <Text type='secondary' style={{ fontSize: 12 }}> 生长批/种子在等人审——审慢了课程断粮</Text>
          )}
        </div>
        <Button size='mini' style={{ marginLeft: 'auto' }} onClick={e => { e.stopPropagation(); frame.goto('courses.proposals') }}>
          去收件箱
        </Button>
      </div>
    </Card>
  )
}

/** 供给卡：队列健康的单行读法 + 停摆/失败的就地处置。数据由今日页轮询缝注入
 * （SupplySnapshot），动作后 onRefresh 立即重拍（不等下一个 5s 节拍）。 */
export function SupplyCard({ frame, supply, onRefresh }: {
  frame: AppFrame
  supply: SupplySnapshot | null
  onRefresh: () => Promise<void>
}) {
  // 恢复/重试动作走共享缝（与生成页同实现，#209 评审收拢）
  const { busyKey, retry, resumeQueue } = useGenJobActions({ onDone: onRefresh })
  const resuming = supply?.paused && (supply.queuedCount ?? 0) > 0

  const brewing = supply?.running.length ?? 0
  const queued = supply?.queuedCount ?? 0
  const failed = supply?.failed ?? []
  return (
    <Card size='small' title='课程供给' style={{ borderRadius: 10 }}
      extra={<Button size='mini' type='text' onClick={() => frame.goto('courses.queue')}>生成队列</Button>}>
      {supply?.broken ? (
        <div className='today-supply-line'>
          <Text type='secondary' style={{ flex: 1, minWidth: 200 }}>
            任务注册表损坏，队列已停止接受新任务（防止坏档被覆盖）：<Text bold>{supply.broken}</Text>
          </Text>
          <Button size='mini' onClick={() => frame.goto('courses.queue')}>去生成队列</Button>
        </div>
      ) : resuming ? (
        <div className='today-supply-line'>
          {/* 停摆中性文案：重启后的正常保护态，不是故障——恢复队列即续 */}
          <Text style={{ flex: 1, minWidth: 200 }}>
            队列暂停：进程重启后有 {supply!.queuedCount} 个任务在排队，不会自动开跑。
          </Text>
          <Button size='mini' type='primary' onClick={() => void resumeQueue()}>恢复队列</Button>
        </div>
      ) : (
        <div className='today-supply-line'>
          <Text className='today-supply-num'>{brewing > 0 ? `在酿 ${brewing}` : '暂无在酿'}</Text>
          {queued > 0 && <Text type='secondary' style={{ fontSize: 12 }}>另有 {queued} 个排队</Text>}
          <Text type='secondary' style={{ fontSize: 12 }}>
            {brewing > 0 ? '正文在后台逐节生成，好了会出现在推荐流' : '需要新内容时从推荐卡或教练台入队'}
          </Text>
        </div>
      )}
      {failed.length > 0 && (
        <div className='today-supply-rows'>
          {failed.map(j => (
            <div key={j.key} className='today-supply-rowitem'>
              <Tag size='small' color='red'>{j.status === 'partial' ? '部分完成' : '失败'}</Tag>
              {j.phase && GEN_PHASE_META[j.phase] && <Tag size='small'>{GEN_PHASE_META[j.phase]!.label}</Tag>}
              <Text type='secondary' style={{ fontSize: 12, flex: 1, minWidth: 160 }}>
                「{j.node}」（{j.course}）上次任务未完成{retryHint(j)}
              </Text>
              <Button size='mini' type='text' status='warning' loading={busyKey === j.key}
                onClick={() => void retry(j)}>重试</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** 失败行的机制提示（一句话，与生成页语义一致）：内容/出题 = 断点续跑，生长批 = 重新裁决。 */
function retryHint(j: GenJobItem): string {
  if (j.phase === 'growth') return '，重试将重新下发生长一步'
  if (j.phase === 'quiz') return '，重试将重新入队出题'
  return '，重试从断点续跑（已就绪的节不重来）'
}

/** 供给行容器：供给卡 + 闸门计数并排（今日页六件之二）。 */
export function SupplyRow({ frame, supply, pending, onRefresh }: {
  frame: AppFrame
  supply: SupplySnapshot | null
  pending: number | null
  onRefresh: () => Promise<void>
}) {
  return (
    <div className='today-supply-row'>
      <SupplyCard frame={frame} supply={supply} onRefresh={onRefresh} />
      <GateCard frame={frame} pending={pending} />
    </div>
  )
}
