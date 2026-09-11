/** App 级教练通知（ADR-0038 面板下发的可见性半区）：轻轮询 diff 生成任务注册表与
 * 复诊在途清单，把「系统在我的课程上动了手」浮出来——
 * - 图域任务（种子/生长/罗盘/反编译/计划/里程碑）入队与终态各弹一条（含触发语义与结果行）；
 *   内容类任务不弹（各页已有指示器）；被阻尼拒掉的重拉不产生注册表条目 → 自然不弹。
 * - 复诊结算（队列空闲钩子自动跑，宿主侧只有运行日志）：在途节点消失/三率增量 = 已出结论。
 * 通知按钮按任务性质分流：产物是提案的（种子/反编译/计划/里程碑）→「去提案页」人审；
 * 过程性的（生长/罗盘）→「去生成页」。首拍（首次成功取数）只建快照——不回放历史。 */
import { Button, Notification } from '@arco-design/web-react'
import { useEffect, useRef } from 'react'
import { api } from './api'

const GRAPH_PHASES = new Set(['种子', '生长', '罗盘', '反编译', '计划', '里程碑'])
const PHASE_TITLE: Record<string, string> = {
  种子: '种子起草',
  生长: '教练回合（生长批）',
  罗盘: '罗盘初画',
  反编译: '目标反编译',
  计划: '里程碑计划草案',
  里程碑: '里程碑任务卡',
}
/** 产物是提案的任务：完成通知跳提案页（下一步动作是人审），其余跳生成页。 */
const PROPOSAL_OUTPUT = new Set(['种子', '反编译', '计划', '里程碑'])

interface JobSnap { status: string; phase?: string; message?: string }

export function useCoachToasts(nav: { generate: () => void; proposals: () => void }): void {
  const prevJobsRef = useRef<Map<string, JobSnap> | null>(null)
  const prevProbationRef = useRef<Map<string, { nodes: Set<string>; proven: number; pruned: number }> | null>(null)
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    let jobsPrimed = false
    let probationPrimed = false

    const notify = (kind: 'info' | 'success' | 'error', title: string, text: string | undefined,
      target: 'generate' | 'proposals' = 'generate') => {
      Notification[kind]({
        title,
        content: (
          <span>
            {text}
            <Button size='mini' type='text' style={{ marginLeft: 6 }}
              onClick={() => navRef.current[target]()}>
              {target === 'proposals' ? '去提案页' : '去生成页'}
            </Button>
          </span>
        ),
        duration: kind === 'error' ? 12 : 6,
        closable: true,
      })
    }

    const pollJobs = async (): Promise<void> => {
      let snaps: Map<string, JobSnap>
      try {
        const st = await api.generateStatus()
        snaps = new Map()
        for (const j of st.jobs) {
          if (!GRAPH_PHASES.has(j.phase ?? '')) continue
          snaps.set(j.key, { status: j.status, phase: j.phase, message: j.message })
        }
      } catch {
        return // 宿主暂不可达：下轮再试（首拍未成不启用通知）
      }
      const prev = prevJobsRef.current
      if (jobsPrimed && prev) {
        for (const [key, cur] of snaps) {
          const old = prev.get(key)
          const title = PHASE_TITLE[cur.phase ?? ''] ?? '图域任务'
          if (!old) {
            if (cur.status === 'queued' || cur.status === 'running') {
              notify('info', `${title}已触发`, cur.message ?? '已入队，生成页看进度')
            }
          } else if (old.status !== cur.status) {
            if (cur.status === 'done') {
              notify('success', `${title}完成`, cur.message,
                PROPOSAL_OUTPUT.has(cur.phase ?? '') ? 'proposals' : 'generate')
            } else if (cur.status === 'partial') {
              notify('info', `${title}部分完成`, cur.message)
            } else if (cur.status === 'failed' || cur.status === 'cancelled') {
              notify('error', `${title}${cur.status === 'failed' ? '失败' : '已取消'}`, cur.message)
            }
          }
        }
      }
      prevJobsRef.current = snaps
      jobsPrimed = true
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