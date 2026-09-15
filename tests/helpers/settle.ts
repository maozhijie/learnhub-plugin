/**
 * 探针用的「后台链收尾」等待（#253 / ADR-0080 暴露的探针竞态）。
 *
 * 生成泵与教练五点触发是**不 await 的后台链**（`pumpGeneration` 的 `.finally` 里再挂
 * `coachTrigger`）；行为探针若在响应返回时就快照，比的是事件循环调度而不是产品行为。
 * 旧快照末尾那几条其实是 `runLog` 的 `fs.promises` await 顺带让出来的调度间隙——
 * 日志换成同步 sink 后那个偶然的让位消失，`host-routes-snapshot` / `host-tools-behavior`
 * 的调用序列当场短了一截（15 + 2 条）。修的是探针，不是产品：让等待显式化，
 * 判据不再依赖「日志恰好是异步的」这种无关性质。
 *
 * 判据：泵不在跑 + 连续两轮宏任务间隙内 `calls` 不再增长（自终止，最多 50 轮）。
 */
export async function settleQuiet(recorder: { calls: string[] }, flags: { pumping: boolean }): Promise<void> {
  let stable = 0
  for (let i = 0; i < 50; i++) {
    const before = recorder.calls.length
    await new Promise(resolve => setTimeout(resolve, 0))
    if (recorder.calls.length === before && !flags.pumping) {
      stable++
      if (stable >= 2) return
    } else {
      stable = 0
    }
  }
}
