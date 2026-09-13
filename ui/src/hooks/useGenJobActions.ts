/** 生成任务动作缝（#209 评审收拢）：供给卡（今日页）与生成页（全局面/本课切片）
 * 对任务注册表的同形动作共用一份实现——失败重试三路由（生长批 → coach/growth 显式
 * 重新裁决；出题 → question-generate；内容 → generate 断点续跑，语义在服务端）、
 * 停摆恢复（重启后排队任务不自动开跑，恢复影响整条全局队列）、图域 phase 词汇
 * （教练台在途条与完成通知的消费面，单一出处）。 */
import { Message } from '@arco-design/web-react'
import { useState } from 'react'
import { api } from '../api'
import { errorMessage, notifyQueued } from './useCommand'
import type { GenJobItem } from '../types'

/** 图域任务 phase 全集（教练回合/面板下发的队列形态；与引擎 GEN_JOB_PHASES 同口径）。 */
export const GRAPH_PHASES = new Set(['seed', 'growth', 'compass', 'decompile', 'plan', 'milestone'])

/** phase → 人读标签+展示色（生成页任务表与供给卡失败行共用，单一出处）。 */
export const GEN_PHASE_META: Partial<Record<NonNullable<GenJobItem['phase']>, { label: string; color: string }>> = {
  quiz: { label: '出题', color: 'cyan' },
  seed: { label: '种子起草', color: 'lime' },
  growth: { label: '生长批', color: 'orange' },
  compass: { label: '罗盘初画', color: 'gold' },
  decompile: { label: '目标反编译', color: 'purple' },
  plan: { label: '计划草案', color: 'purple' },
  milestone: { label: '里程碑草案', color: 'purple' },
}

/** 生成任务动作：retry/resume 后调 onDone 重拍数据（不等下一个轮询节拍）。 */
export function useGenJobActions(opts: { onDone?: () => Promise<void> | void } = {}) {
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // 失败/部分完成任务的重试：与生成页同路由（growth → 生长一步重裁决；
  // quiz → 出题重入队；内容 → 断点续跑，已就绪的节不重来）
  const retry = async (j: GenJobItem) => {
    setBusyKey(j.key)
    try {
      if (j.phase === 'growth') {
        notifyQueued(await api.coachGrowth(j.course))
      } else {
        const r = j.phase === 'quiz'
          ? await api.questionGenerate(j.course, j.node)
          : await api.generate(j.course, j.node)
        Message.info(r.message)
      }
      await opts.onDone?.()
    } catch (err) {
      Message.error(errorMessage(err))
    } finally {
      setBusyKey(null)
    }
  }

  // 恢复队列：遗留排队任务按序开跑（全局语义——恢复影响整条队列，各处文案如实说明）
  const resumeQueue = async () => {
    try {
      const r = await api.generateResume()
      Message.success(`队列已恢复（${r.resumed} 个排队任务将按序执行）`)
      await opts.onDone?.()
    } catch (err) {
      Message.error(errorMessage(err))
    }
  }

  return { busyKey, retry, resumeQueue }
}
