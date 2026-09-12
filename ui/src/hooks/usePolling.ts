/** 页签保活轮询缝（#183 收编五页手搓样板）：setInterval + isActiveTab 门 +
 * learnhub:tab 切回即补取数 + 卸载清理，四处样板一个 hook。
 *
 * 节拍语义：
 * - 挂载即取一次（keep-alive 下组件只在首次进入页签时挂载，此刻必激活）；
 * - 激活页签：取数后按 tick 返回值调度下一次（返回数字 = 自定义延迟，如 LessonView
 *   的任务在途 3s/空闲 15s；返回 undefined 用 intervalMs）；
 * - 非激活页签：不取数，idleMs（缺省 = intervalMs）后重查——定时器只保留节拍（ADR-0027）；
 * - learnhub:tab 事件命中本页签：立即取数（切回即补；隐藏期间错过的边沿在此补判）。
 */
import { useEffect, useRef } from 'react'
import { isActiveTab } from '../active-tab'
import type { TabKey } from '../App'

export function usePolling(
  tick: () => Promise<number | void>,
  opts: { tab: TabKey; intervalMs: number; idleMs?: number },
): void {
  const { tab, intervalMs, idleMs = intervalMs } = opts
  // tick 每渲染重建（内部常闭包页面最新状态），经 ref 进循环——循环本身只按 opts 建一次
  const tickRef = useRef(tick)
  tickRef.current = tick
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (ms: number) => { timer = setTimeout(() => { void beat() }, ms) }
    const beat = async () => {
      if (stopped) return
      if (!isActiveTab(tab)) { schedule(idleMs); return }
      const next = await tickRef.current()
      if (stopped) return
      schedule(typeof next === 'number' ? next : intervalMs)
    }
    const onTab = (e: Event) => {
      if ((e as CustomEvent).detail !== tab || stopped) return
      clearTimeout(timer)
      void beat()
    }
    window.addEventListener('learnhub:tab', onTab)
    void beat()
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('learnhub:tab', onTab)
    }
  }, [tab, intervalMs, idleMs])
}
