/** 单命令数据获取缝（#187 决议④ / #183）：一页一请求的标准形状。
 *
 * 语义边界（规格定死，两个并行会话不会做出两套语义）：
 * - **单命令即请求**：fn 是一个端点调用，无缓存、无去重——每次 run/reload/依赖变化
 *   都真实发请求（跨挂载不保留，重挂即重取）；
 * - **latest-wins**：竞态守卫只认最后一次发出的请求，迟到的旧响应整体丢弃；
 * - **失败不翻转**：失败只写 error（消息经 errorMessage 单点提取），data 保持最近一次
 *   成功值（首载前为 null）——#158「已有数据后的刷新失败保持旧数据」的缝级实现；
 * - **空态由调用方派生**：缝只供给 data/loading/error 三态，业务空态在渲染层判。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'

/** 错误消息单点提取（#183 错误提示收敛）：ApiError 已在 api.ts 携带服务端 error 字段，
 * 这里是全 ui/src 唯一把 unknown 错误转成可展示消息的地方——散落的
 * `err instanceof Error ? err.message : String(err)` 手写提取由此归一。 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

export interface Command<T> {
  /** 最近一次成功响应；首载前与失败时为 null（失败保持上次成功值不翻转）。
   * null = 「缝尚无数据」的哨兵——端点响应一律对象/数组，业务 null 是响应内字段，
   * 不会被这个哨兵吞掉。 */
  data: T | null
  /** 请求在途。调用方以 `data === null && loading` 派生首载加载态；
   * 已有数据时的在途刷新不翻转内容（静默刷新）。 */
  loading: boolean
  /** 最近一次失败的错误消息（errorMessage 单点提取）；成功后清空。 */
  error: string | null
  /** 显式重取；resolve 于该次请求落定（成功或失败）。 */
  reload: () => Promise<void>
  /** 本地写入（乐观更新/动作响应直接回填），绕过取数。 */
  set: (data: T) => void
}

export function useCommand<T>(fn: () => Promise<T>, deps: unknown[] = []): Command<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const result = await fnRef.current()
      if (seq !== seqRef.current) return // 迟到的旧响应：latest-wins 丢弃
      setData(result)
      setError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      setError(errorMessage(err))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  // 触发时机由调用方的 deps 参数表达（动态数组是本缝的 API 形状）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run() }, deps)

  const reload = useCallback(() => run(), [run])
  const set = useCallback((next: T) => setData(next), [])

  return { data, loading, error, reload, set }
}
