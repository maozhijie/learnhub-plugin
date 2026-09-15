/**
 * 调试日志的宿主实现（#253 / ADR-0080）：pino core + 自建 Writable sink。
 *
 * **为什么是「pino core + 自建 sink」而不是 `pino.transport()`**：transport 的目标模块在
 * esbuild 单文件产物里按路径运行时解析，打包后失效（官方已知坑）——这不是「以后再说」的
 * 风险，是本仓构建形态的硬约束。按天切分、保留期清扫、上限与失败静默因此全在自建 sink
 * 里，pino 在本票的收益**退化为「级别门 + 日志 API」**：格式化与旋转仍得自写，后人不必
 * 以为引了框架就一劳永逸（ADR-0080 如实记录其价值边界）。
 *
 * 形态契约（逐条有测试）：
 * - 落点 `<dir>/<本地日历日>.log`（`Paths.logsDir`，引擎只登记路径）；行内**不带日期**
 *   （文件名担日历日）；文件名用日历日而非学习日——出处戳永远用日历日（词条「学习日」）。
 * - 行格式 `[HH:MM:SS.mmm] [LEVEL] <事件名> k=v k=v`；多行只允许 `MULTILINE_EVENTS`
 *   里的形态，续行缩进两格。
 * - 单条上界 `LOG_ENTRY_LIMIT` 字符，超限截断并显式标注 `…（已截断）`。
 * - 保留 `LOG_RETENTION_DAYS` 天：跨日新建文件时惰性清扫，**只认**
 *   `^\d{4}-\d{2}-\d{2}\.log$`——其余文件（用户放进来的）一律不碰，不压缩。
 * - 单日 `LOG_DAILY_LIMIT_BYTES` 软上限：超限**停止当天写盘** + 文件尾追加标记行 +
 *   console 告警一次（次日自动复位）。**绝不静默停止**——「同一节一周 4,149 条重复失败」
 *   那类雪崩正是静默停止喂出来的（`tests/README.md` 记过）。
 * - 写盘失败静默不影响主流程（与 `runLog` 同款纪律），但内部记 `failures`／`lastError`
 *   并经实例暴露——避免「日志自己坏了没人知道」。
 * - 级别门**唯一一处**住在这里；默认 INFO，可经宿主侧 env `LEARNHUB_LOG_LEVEL` 调
 *   （引擎侧不读环境）。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pino } from 'pino'
import type { LogFields, LogLevel, Logger } from '../engine/logger.ts'

/** 事件名 → 级别门的数值映射（ADR-0080：error 50／warn 40／info 30／debug 20）。 */
const LEVEL_NUM: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 }
const LEVEL_LABEL: Record<number, string> = { 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR' }
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** 单条上界（ADR-0080：原 `LOG_LIMIT` 1500 的升档）。 */
export const LOG_ENTRY_LIMIT = 16384
/** 保留天数（常量 + 测试，不做配置化：没人校准的旋钮不如常量）。 */
export const LOG_RETENTION_DAYS = 30
/** 单日软上限（字节）。 */
export const LOG_DAILY_LIMIT_BYTES = 20 * 1024 * 1024
/** 保留期清扫只认这个文件名形状；其余文件一律不碰。 */
const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.log$/

/** 允许带续行的事件（ADR-0080 多行纪律）：续行的用途只有一个——把「门到底说了什么」
 * 原样留住（压成单行会把错误清单腰斩，而那是排查时最不可替代的信息）。
 * `coach.segment.exit` 只在 `schema=reject` 时带（见 `allowsContinuation`）。 */
export const MULTILINE_EVENTS: readonly string[] = [
  'engine.call', 'agent.gate.death', 'agent.gate.first', 'coach.gate.reject', 'coach.segment.exit',
]

/** 事件+字段 → 是否允许续行。 */
function allowsContinuation(event: string, fields: Record<string, unknown>): boolean {
  if (!MULTILINE_EVENTS.includes(event)) return false
  if (event === 'coach.segment.exit') return fields.schema === 'reject'
  return true
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** 本地时间 `HH:MM:SS.mmm`（行内不带日期——文件名担日历日）。 */
function clockLabel(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 本地**日历日** `YYYY-MM-DD`。 */
function dayLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 日历日整日偏移（保留期判定用；本地时区的日期字符串算术，不经 UTC）。 */
function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() + deltaDays)
  return dayLabel(dt.getTime())
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 单条条目文本：首行 + 续行（缩进两格）；数组字段在允许续行时逐元素成行，
 * 否则内联（`k=v1 | v2`）——「哪些事件有多行」因此是**可测的闭集**，不是随手的格式。 */
function renderEntry(levelNum: number, event: string, fields: Record<string, unknown>, nowMs: number): string {
  const head: string[] = []
  const tail: string[] = []
  const multiline = allowsContinuation(event, fields)
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      const items = v.map(x => String(x))
      if (!items.length) continue
      if (multiline) tail.push(...items.map(line => `  ${line}`))
      else head.push(`${k}=${items.join(' | ')}`)
      continue
    }
    head.push(`${k}=${String(v)}`)
  }
  const label = LEVEL_LABEL[levelNum] ?? String(levelNum)
  const line = `[${clockLabel(nowMs)}] [${label}] ${event}${head.length ? ` ${head.join(' ')}` : ''}`
  return [line, ...tail].join('\n')
}

/** 单条上界截断（超限显式标注，不静默丢尾巴）。 */
function clipEntry(text: string): string {
  return text.length > LOG_ENTRY_LIMIT ? `${text.slice(0, LOG_ENTRY_LIMIT)}…（已截断）` : text
}

/** env `LEARNHUB_LOG_LEVEL` 解析：非法值回退缺省而不抛错——日志配置写坏不该挡启动。 */
function levelFromEnv(env: NodeJS.ProcessEnv): LogLevel | undefined {
  const raw = env.LEARNHUB_LOG_LEVEL?.trim().toLowerCase()
  return LEVELS.includes(raw as LogLevel) ? raw as LogLevel : undefined
}

/** 宿主日志实例：Logger 端口 + 可查的内部态（失败计数／当日停写状态）。 */
export interface FileLogger extends Logger {
  /** 写盘失败累计次数（失败静默但可查）。 */
  readonly failures: number
  /** 最近一次失败原因。 */
  readonly lastError: string | null
  /** 命中单日上限的日历日；null = 未停写（次日自动复位）。 */
  readonly cappedDay: string | null
}

export interface FileLoggerOptions {
  /** 日志目录（`Paths.logsDir`）；不存在则按需创建。 */
  dir: string
  /** 级别覆盖；缺省读 env `LEARNHUB_LOG_LEVEL`，再缺省 INFO。 */
  level?: LogLevel
  /** 取时端口：按天切分、保留期基准与行内时间戳都用它（测试注入固定时钟跨日）。 */
  now?: () => number
  /** 每日上限告警出口（缺省 `console.warn`；测试注入收集器断言「只告警一次」）。 */
  warn?: (message: string) => void
}

/** 构造宿主日志（每个宿主进程一份；上限与失败态住本闭包，不碰宿主模块级 `let` 禁令）。 */
export function createFileLogger(opts: FileLoggerOptions): FileLogger {
  const now = opts.now ?? ((): number => Date.now())
  const warn = opts.warn ?? ((m: string): void => { console.warn(m) })
  const level = opts.level ?? levelFromEnv(process.env) ?? 'info'

  // 闭包态（非模块级）：当日日历日 / 当日已写字节 / 停写日 / 已告警日 / 失败面。
  let day = ''
  let bytes = 0
  let cappedDay: string | null = null
  let warnedDay: string | null = null
  let failures = 0
  let lastError: string | null = null

  const fail = (err: unknown): void => {
    failures++
    lastError = messageOf(err)
  }

  /** 跨日（或首次写）：建目录 → 惰性清扫 → 沿用当日已有字节数（跨进程重启不虚高）。 */
  const ensureDay = (target: string): void => {
    if (day === target) return
    day = target
    cappedDay = null
    warnedDay = null
    try {
      mkdirSync(opts.dir, { recursive: true })
      sweepOld(target)
      try {
        bytes = statSync(join(opts.dir, `${target}.log`)).size
      } catch {
        bytes = 0 // 当日文件尚未存在 = 合法零态
      }
    } catch (err) {
      bytes = 0
      fail(err)
    }
  }

  /** 保留期清扫：只删日期形状的 `.log`，超期即删（不压缩）。 */
  const sweepOld = (target: string): void => {
    const cutoff = shiftDay(target, -LOG_RETENTION_DAYS)
    for (const name of readdirSync(opts.dir)) {
      const m = LOG_FILE_RE.exec(name)
      if (!m || !m[1] || m[1] >= cutoff) continue
      rmSync(join(opts.dir, name), { force: true })
    }
  }

  /** 命中单日上限：停写 + 文件尾标记行 + 告警一次（次日 `ensureDay` 自动复位）。 */
  const cap = (target: string): void => {
    cappedDay = target
    try {
      appendFileSync(join(opts.dir, `${target}.log`),
        `[${clockLabel(now())}] [WARN] host.log.daily_cap 已停写：单日超过 ${LOG_DAILY_LIMIT_BYTES} 字节（次日自动复位）\n`, 'utf8')
    } catch (err) {
      fail(err)
    }
    if (warnedDay === target) return
    warnedDay = target
    try {
      warn(`[learnhub:log] 单日日志超过 ${LOG_DAILY_LIMIT_BYTES} 字节，已停写 ${join(opts.dir, `${target}.log`)}（次日自动复位）。`)
    } catch {
      // 告警出口故障不挡主流程
    }
  }

  const emit = (levelNum: number, event: string, fields: Record<string, unknown>, atMs: number): void => {
    try {
      const target = dayLabel(atMs)
      ensureDay(target)
      if (cappedDay === target) return
      const body = clipEntry(renderEntry(levelNum, event, fields, atMs))
      const size = Buffer.byteLength(body, 'utf8') + 1
      if (bytes + size > LOG_DAILY_LIMIT_BYTES) {
        cap(target)
        return
      }
      appendFileSync(join(opts.dir, `${target}.log`), `${body}\n`, 'utf8')
      bytes += size
    } catch (err) {
      fail(err)
    }
  }

  // pino 只担「级别门 + 日志 API」：`timestamp: false` + `base: undefined` 让它交出
  // 一份只含 `level` 与我们字段的 JSON 行，行文本由上面自建 sink 全权决定。
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      try {
        const rec = JSON.parse(chunk.toString()) as Record<string, unknown>
        const levelNum = typeof rec.level === 'number' ? rec.level : LEVEL_NUM[level]
        const event = typeof rec.event === 'string' ? rec.event : '(missing-event)'
        const { level: _level, event: _event, ...fields } = rec
        emit(levelNum, event, fields, now())
      } catch (err) {
        fail(err)
      }
      cb()
    },
  })
  const engine = pino({ level, timestamp: false, base: undefined }, sink)

  const port: Logger = {
    debug: (event, fields) => { engine.debug(recordOf(event, fields)) },
    info: (event, fields) => { engine.info(recordOf(event, fields)) },
    warn: (event, fields) => { engine.warn(recordOf(event, fields)) },
    error: (event, fields) => { engine.error(recordOf(event, fields)) },
  }

  // 观测态用 `defineProperties`（真 getter）而不是 `Object.assign`：后者会**当场求值**
  // 再当数据属性拷进去，`failures` 会永远停在 0、查不到后来的失败。同时声明
  // `enumerable: false`——这个对象会被探针/日志序列化（`shadowEngine` 把 AgentSeam
  // 的注入参 JSON.stringify 进行为快照），可枚举的内部态会污染快照且泄露宿主细节。
  Object.defineProperties(port, {
    failures: { get: () => failures, enumerable: false },
    lastError: { get: () => lastError, enumerable: false },
    cappedDay: { get: () => cappedDay, enumerable: false },
  })
  return port as FileLogger
}

/** 端口字段面 → pino 的合并对象（事件名进 `event` 键；pino 的 `level` 由它自己加）。 */
function recordOf(event: string, fields?: LogFields): Record<string, unknown> {
  return { event, ...(fields ?? {}) }
}

/** 宿主侧 noop 实现（ADR-0080 原意：与 `createFileLogger` 同文件导出，供宿主消费者取用）。 */
export { noopLogger } from '../engine/logger.ts'
