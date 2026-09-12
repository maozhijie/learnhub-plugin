/** App 级教练通知（ADR-0038 面板下发的可见性半区）：轻轮询 diff 生成任务注册表与
 * 复诊在途清单，把「系统在我的课程上动了手」浮出来——
 * - 图域任务（种子/生长/罗盘/反编译/计划/里程碑）入队与终态各弹一条（含触发语义与结果行）；
 *   内容类任务不弹（各页已有指示器）；被阻尼拒掉的重拉不产生注册表条目 → 自然不弹。
 * - 生长批失败通知带「重试」按钮（#157）：点击重新下发面板生长命令（显式重新裁决，
 *   豁免失败阻尼）——教练一次产出畸形不再让课程静默停止生长。
 * - 生长批停摆（growthOutcome=idle）是判据满足的自然结果，不是成就（#161）：中性说明
 *   文案，不弹绿色成功。
 * - 通知回放（#161）：localStorage 记 last-seen 消费水位，面板打开首拍把「面板关闭
 *   期间完成、水位未及」的终态任务补发出来（带「补发」前缀，失败批照带「重试」）——
 *   不再因面板关闭错过结果。保留期外的终态（done 30 分钟）已被清扫，无从补发。
 * - 复诊结算（队列空闲钩子自动跑，宿主侧只有运行日志）：在途节点消失/三率增量 = 已出结论。
 * 通知按钮按任务性质分流：产物是提案的（种子/反编译/计划/里程碑）→「去提案页」人审；
 * 过程性的（生长/罗盘）→「去生成页」。 */
import { Button, Message, Notification } from '@arco-design/web-react'
import { useEffect, useRef } from 'react'
import { api } from './api'
import { isGenJobTerminal } from '../../src/generation-jobs'
import type { GenJobItem } from './types'
import { errorMessage } from './hooks/useCommand'

const GRAPH_PHASES = new Set(['seed', 'growth', 'compass', 'decompile', 'plan', 'milestone'])
const PHASE_TITLE: Record<string, string> = {
  seed: '种子起草',
  growth: '教练回合（生长批）',
  compass: '罗盘初画',
  decompile: '目标反编译',
  plan: '里程碑计划草案',
  milestone: '里程碑任务卡',
}
/** 产物是提案的任务：完成通知跳提案页（下一步动作是人审），其余跳生成页。 */
const PROPOSAL_OUTPUT = new Set(['seed', 'decompile', 'plan', 'milestone'])
/** 通知回放的消费水位（#161）：localStorage 键，值为已展示终态的最大 finishedAt 毫秒。 */
const LAST_SEEN_KEY = 'learnhub-coach-notif-lastseen'

/** 通知消费的快照字段（GenJobItem 子集，零手工镜像）。 */
type JobSnap = Pick<GenJobItem, 'course' | 'status' | 'phase' | 'message' | 'growthOutcome' | 'startedAt' | 'finishedAt'>

const phaseTitleOf = (j: JobSnap): string => PHASE_TITLE[j.phase ?? ''] ?? '图域任务'

const readLastSeen = (): number => {
  const raw = Number(localStorage.getItem(LAST_SEEN_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}
const writeLastSeen = (ts: number): void => {
  if (Number.isFinite(ts) && ts > readLastSeen()) localStorage.setItem(LAST_SEEN_KEY, String(ts))
}
/** 终态消费水位：finishedAt 缺席（历史档案）回落 startedAt。 */
const terminalTs = (j: JobSnap): number => Date.parse(j.finishedAt ?? j.startedAt) || 0

export function useCoachToasts(nav: { generate: () => void; proposals: () => void }): void {
  const prevJobsRef = useRef<Map<string, JobSnap> | null>(null)
  const prevProbationRef = useRef<Map<string, { nodes: Set<string>; proven: number; pruned: number }> | null>(null)
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    let jobsPrimed = false
    let probationPrimed = false

    /** 生长批失败通知的「重试」（#157）：重新下发面板生长命令（显式重新裁决，
     * 服务端豁免失败阻尼重新入队）；结果以轻提示反馈，通知本体自动消散。 */
    const retryGrowth = async (course: string): Promise<void> => {
      try {
        const r = await api.coachGrowth(course)
        if (r.queued) Message.success(r.message)
        else Message.warning(r.message)
      } catch (err) {
        Message.error(errorMessage(err))
      }
    }

    const notify = (kind: 'info' | 'success' | 'error', title: string, text: string | undefined,
      target: 'generate' | 'proposals' = 'generate', onRetry?: () => void) => {
      Notification[kind]({
        title,
        content: (
          <span>
            {text}
            {onRetry && (
              <Button size='mini' type='text' status='warning' style={{ marginLeft: 6 }}
                onClick={() => onRetry()}>
                重试
              </Button>
            )}
            <Button size='mini' type='text' style={{ marginLeft: onRetry ? 0 : 6 }}
              onClick={() => navRef.current[target]()}>
              {target === 'proposals' ? '去提案页' : '去生成页'}
            </Button>
          </span>
        ),
        duration: kind === 'error' ? 12 : 6,
        closable: true,
      })
    }

    /** 终态通知（#161 抽出共用）：diff 边沿与首拍回放同一语义——停摆走中性说明，
     * 失败的生长批照带「重试」，回放的标题带「补发」前缀。终态判定与宿主同源
     * （isGenJobTerminal，生成任务契约单一出处）。 */
    const terminalNotify = (cur: JobSnap, replay: boolean): void => {
      const title = phaseTitleOf(cur)
      const prefix = replay ? '补发·' : ''
      const target = PROPOSAL_OUTPUT.has(cur.phase ?? '') ? 'proposals' as const : 'generate' as const
      if (cur.status === 'done') {
        if (cur.phase === 'growth' && cur.growthOutcome === 'idle') {
          notify('info', `${prefix}${title}停摆`, cur.message, target)
        } else {
          notify('success', `${prefix}${title}完成`, cur.message, target)
        }
      } else if (cur.status === 'partial') {
        notify('info', `${prefix}${title}部分完成`, cur.message, target)
      } else if (cur.status === 'failed' || cur.status === 'cancelled') {
        notify('error', `${prefix}${title}${cur.status === 'failed' ? '失败' : '已取消'}`, cur.message,
          target, cur.status === 'failed' && cur.phase === 'growth' ? () => void retryGrowth(cur.course) : undefined)
      }
    }

    const pollJobs = async (): Promise<void> => {
      let jobs: GenJobItem[]
      try {
        jobs = (await api.generateStatus()).jobs
      } catch {
        return // 宿主暂不可达：下轮再试（首拍未成不启用通知）
      }
      const snaps = new Map<string, JobSnap>()
      for (const j of jobs) {
        if (!GRAPH_PHASES.has(j.phase ?? '')) continue
        snaps.set(j.key, {
          course: j.course, status: j.status, phase: j.phase, message: j.message,
          growthOutcome: j.growthOutcome, startedAt: j.startedAt, finishedAt: j.finishedAt,
        })
      }
      const prev = prevJobsRef.current
      if (jobsPrimed && prev) {
        for (const [key, cur] of snaps) {
          const old = prev.get(key)
          if (!old) {
            if (cur.status === 'queued' || cur.status === 'running') {
              notify('info', `${phaseTitleOf(cur)}已触发`, cur.message ?? '已入队，生成页看进度')
            } else if (isGenJobTerminal(cur.status)) {
              // 会话中途出生即终态的任务（两次轮询之间走完全程）：照常弹终态，不错过结果
              terminalNotify(cur, false)
            }
          } else if (old.status !== cur.status && isGenJobTerminal(cur.status)) {
            terminalNotify(cur, false)
          }
        }
      } else {
        // 首拍（#161 通知回放）：面板关闭期间完成、消费水位未及的终态补发出来
        // （带「补发」前缀）——不再因面板关闭错过结果。
        const lastSeen = readLastSeen()
        for (const cur of snaps.values()) {
          if (isGenJobTerminal(cur.status) && terminalTs(cur) > lastSeen) terminalNotify(cur, true)
        }
      }
      prevJobsRef.current = snaps
      jobsPrimed = true
      // 消费水位推进（#161）：本轮注册表里可见的终态都已展示（首拍补发 / 后续拍 diff 弹条）
      const terminal = [...snaps.values()].filter(j => isGenJobTerminal(j.status))
      const maxTs = terminal.length ? Math.max(...terminal.map(terminalTs)) : 0
      if (maxTs > 0) writeLastSeen(maxTs)
    }

    const pollProbation = async (): Promise<void> => {
      let cur: Map<string, { nodes: Set<string>; proven: number; pruned: number }>
      try {
        const d = await api.probation()
        cur = new Map(d.courses.map(c => [c.course, {
          nodes: new Set(c.in_flight), proven: c.rates.proven, pruned: c.rates.pruned,
        }]))
      } catch {
        return
      }
      const prev = prevProbationRef.current
      if (probationPrimed && prev) {
        for (const [course, was] of prev) {
          const now = cur.get(course)
          if (!now) continue
          const settled = [...was.nodes].filter(n => !now.nodes.has(n))
          // 三率是滚动 30 学习日窗口：proven/pruned 只在真出现新结算时增加（窗口滑动只会减少）
          const dProven = now.proven - was.proven
          const dPruned = now.pruned - was.pruned
          if (!settled.length && dProven <= 0 && dPruned <= 0) continue
          const breakdown = [
            ...(dProven > 0 ? [`转正 ${dProven}`] : []),
            ...(dPruned > 0 ? [`剪除 ${dPruned}`] : []),
          ].join('／')
          const detail = settled.length
            ? `${settled.join('、')} 已出结论${breakdown ? `（${breakdown}）` : ''}——详见运行日志`
            : `${breakdown}——详见运行日志`
          notify('info', `复诊结算（${course}）`, detail)
        }
      }
      prevProbationRef.current = cur
      probationPrimed = true
    }

    void pollJobs()
    void pollProbation()
    const jobsTimer = setInterval(() => { void pollJobs() }, 10_000)
    const probationTimer = setInterval(() => { void pollProbation() }, 60_000)
    return () => { clearInterval(jobsTimer); clearInterval(probationTimer) }
  }, [])
}
