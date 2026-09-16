/**
 * 内存记录型假 logger（#253 / ADR-0080）：测试侧的默认注入实现。
 *
 * 为什么是记录的而不是 noop：本票的主验收物就是「**从日志一眼可见**」——教练回灌重裁
 * 有没有跑过、门拒了什么、两轮死因是什么。假实现只吞掉条目就等于把验收面测没了，
 * 故这里既记事件序列（`events()`）也留完整条目（`entries`）。
 *
 * 引擎侧确定性：断言在内存里完成，零盘面噪声、零跨日/保留期耦合——真正的盘面行为
 * （按天切分/保留期/上限）由 `tests/file-log.test.ts` 对 `host/log-file.ts` 单独测。
 */
import type { LogFields, LogLevel, Logger } from '../../src/engine/infra/logger.ts'

export interface LogEntry {
  level: LogLevel
  event: string
  fields: LogFields
}

export interface MemLogger extends Logger {
  /** 按发生顺序的完整条目（含字段）。 */
  readonly entries: LogEntry[]
  /** 事件名序列（最常用的断言面）。 */
  events(): string[]
  /** 某事件的第 n 条（1 起；缺省最后一条）。 */
  nth(event: string, n?: number): LogEntry | undefined
  /** 某事件出现过几次。 */
  count(event: string): number
  /** 清空（同一 logger 跨段复用时用）。 */
  clear(): void
}

export function memLogger(): MemLogger {
  const entries: LogEntry[] = []
  const push = (level: LogLevel) => (event: string, fields?: LogFields): void => {
    entries.push({ level, event, fields: fields ?? {} })
  }
  const log: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
  // 断言面用 `defineProperties` 声明为**不可枚举**：本对象会被当成注入参序列化进行为
  // 快照（`shadowEngine` 把 `AgentSeam` 的端口 JSON.stringify 进 `calls`），可枚举的
  // `entries` 会把「这一天记了多少条日志」烧进快照——那是易变的运行时状态，不是行为。
  Object.defineProperties(log, {
    entries: { get: () => entries, enumerable: false },
    events: { value: () => entries.map(e => e.event), enumerable: false },
    nth: {
      value: (event: string, n?: number) => {
        const hits = entries.filter(e => e.event === event)
        return n === undefined ? hits.at(-1) : hits[n - 1]
      },
      enumerable: false,
    },
    count: { value: (event: string) => entries.filter(e => e.event === event).length, enumerable: false },
    clear: { value: () => { entries.length = 0 }, enumerable: false },
  })
  return log as MemLogger
}
