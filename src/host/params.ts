import type { ParamSpec, ParameterSchemaSpec } from '../commands/types.ts'

/**
 * 宿主参数守卫语义的唯一出处（#168；ADR-0045「参数校验收成一处的语义」）。
 *
 * 今天的三份手写实现——`need()`（123 个调用点）、**21 处**内联 `missing required field:`、
 * **51 处**手写 `typeof body.x` 守卫——在这里收成两层：
 *   - **必填**：`need`（非空字符串，带出 trim 值）／`needQuery`（查询串，不 trim，支持
 *     多键合并消息 `node/qid`）／`requireString`／`requireBoolean`／`requireNumber`／
 *     `requireObject`／`requireOneOf`；
 *   - **可选**：`optText`／`optTrimmed`／`optRaw`／`optString`／`optNumber`／`optFinite`／
 *     `optBoolean`／`optTrue`／`optObject`／`optList`（加查询串的 `optQuery`），外加
 *     `pick(key, value)`——`{k: v}` 或 `{}`，即今天 `...(cond ? {k:v} : {})` 的等价形式。
 *
 * 纪律：
 * - **错误消息与状态码逐字不变**：必填缺失/类型不符一律 `missing required field: <key>`
 *   （`requireOneOf` 是唯一例外，照抄今天的 `missing/invalid required field: <key>（a|b|c）`），
 *   经路由统一 catch 出口成 500——`sendJson` 单次序列化的约定不受影响。
 * - **可选参数的今天语义是「非法即当省略」**（`typeof` 不过就不带出该键）。它与 ADR-0045
 *   「可选参数只允许『省略』或『合法』」同向，但比字面更宽松：非法值被静默丢弃而非拒绝。
 *   本票原样保留（120 条路由行为逐字不变是验收线）；#169 若收紧成 fail loud，必须在票面
 *   登记这条行为变更。
 * - 本模块零 I/O、不 import engine 与宿主状态：只认 `Record<string, unknown>` 与 `URL`。
 */

/** 参数来源的两副形状：JSON 体与查询串。 */
type Body = Record<string, unknown>

/** 必填字符串（`need`）：缺失、非字符串或全空白即抛；带出 **trim 值**。 */
export function need(body: Body, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`missing required field: ${key}`)
  return v.trim()
}

/** 必填查询串：缺失或空串即抛（**不 trim**——查询串今天原样进引擎，空白的合法性由引擎判）。
 * 多键时一次校验、消息按 `a/b` 合并（今天的 `missing required field: node/qid`）。 */
export function needQuery(url: URL, ...keys: string[]): string[] {
  const values = keys.map(k => url.searchParams.get(k))
  if (values.some(v => !v)) throw new Error(`missing required field: ${keys.join('/')}`)
  return values as string[]
}

/** 可选查询串：缺省即 undefined（今天 `searchParams.get(k) ?? undefined`）。 */
export function optQuery(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined
}

/** 必填字符串（**不 trim、允许空串**）：今天 PUT /day-cutoff 的 `typeof !== 'string'` 语义。 */
export function requireString(body: Body, key: string): string {
  const v = body[key]
  if (typeof v !== 'string') throw new Error(`missing required field: ${key}`)
  return v
}

/** 必填布尔：今天 5 处 `typeof body.x !== 'boolean'` 的同一条语义。 */
export function requireBoolean(body: Body, key: string): boolean {
  const v = body[key]
  if (typeof v !== 'boolean') throw new Error(`missing required field: ${key}`)
  return v
}

/** 必填数字：`Number()` 强制转换后须有限（今天 `/daily-goal`、`/sandbox/run` 的同一条：
 * 字符串数字算合法，NaN/缺省/无穷即错）。 */
export function requireNumber(body: Body, key: string): number {
  const n = Number(body[key])
  if (!Number.isFinite(n)) throw new Error(`missing required field: ${key}`)
  return n
}

/** 必填对象：今天 `/question-add` 的 `typeof q !== 'object' || q === null` 语义。 */
export function requireObject(body: Body, key: string): Record<string, unknown> {
  const v = body[key]
  if (typeof v !== 'object' || v === null) throw new Error(`missing required field: ${key}`)
  return v as Record<string, unknown>
}

/** 必填枚举（字面量联合）：只收清单内的字符串，消息照抄今天的
 * `missing/invalid required field: <key>（a|b|c）`（今天唯一一处：申诉 resolution）。 */
export function requireOneOf<T extends string>(body: Body, key: string, allowed: readonly T[]): T {
  const v = body[key]
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`missing/invalid required field: ${key}（${allowed.join('|')}）`)
  }
  return v as T
}

// ---------------------------------------------------------------- 可选参数

/** 可选文本：非空白的字符串，带出**原值**（今天 `...(typeof x === 'string' && x.trim() ? {k: x} : {})`）。 */
export function optText(body: Body, key: string): string | undefined {
  const v = body[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** 可选文本（**带出 trim 值**）：今天 `...(typeof x === 'string' && x.trim() ? {k: x.trim()} : {})`。 */
export function optTrimmed(body: Body, key: string): string | undefined {
  const v = body[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** 可选原样字符串：只要 `typeof === 'string'`（空串也算，带出原值）——
 * 今天字面量联合字段（kind/predicted/band/reason/target_ts）的 `as never` 取值形态。 */
export function optRaw(body: Body, key: string): string | undefined {
  const v = body[key]
  return typeof v === 'string' ? v : undefined
}

/** 可选字符串带缺省：今天 `typeof x === 'string' ? x : ''`。 */
export function optString(body: Body, key: string, fallback = ''): string {
  const v = body[key]
  return typeof v === 'string' ? v : fallback
}

/** 可选数字：只要 `typeof === 'number'`（**不查有限性**，今天 auto_rating/rating 的形态）。 */
export function optNumber(body: Body, key: string): number | undefined {
  const v = body[key]
  return typeof v === 'number' ? v : undefined
}

/** 可选有限数字：今天 `typeof x === 'number' && Number.isFinite(x)` 的形态。 */
export function optFinite(body: Body, key: string): number | undefined {
  const v = body[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 可选布尔（真布尔值）：今天 `typeof x === 'boolean'`。 */
export function optBoolean(body: Body, key: string): boolean | undefined {
  const v = body[key]
  return typeof v === 'boolean' ? v : undefined
}

/** 可选显式方向旗标：仅 `=== true` 算真（今天 `body.defer_schedule === true` 一类；
 * 缺省/false/其他类型都算不来——「显式重新裁决」类参数的统一语义）。 */
export function optTrue(body: Body, key: string): boolean {
  return body[key] === true
}

/** 可选对象：非空对象才带出（数组也算对象，与今天的 `typeof === 'object'` 判定一致）。 */
export function optObject(body: Body, key: string): Record<string, unknown> | undefined {
  const v = body[key]
  return typeof v === 'object' && v !== null ? v as Record<string, unknown> : undefined
}

/** 可选数组：今天 `Array.isArray(x) ? x : undefined` 的形态。 */
export function optList(body: Body, key: string): unknown[] | undefined {
  const v = body[key]
  return Array.isArray(v) ? v : undefined
}

/** 可选项 → 可展开的补丁：值为 undefined 即空对象（`...(cond ? {k: v} : {})` 的等价形式）。 */
export function pick<K extends string, V>(key: K, value: V | undefined): Record<string, V> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<string, V>
}

// ---------------------------------------------------------------- 注册表驱动的取值（#169）

/** 参数来源：GET 段是查询串，POST/PUT 段是 JSON 体（与手写时代的取值面一致）。 */
export type ArgSource =
  | { kind: 'query'; url: URL }
  | { kind: 'body'; body: Body }

/** 一个键按声明取值：`required` 决定必填语义，`read` 决定可选语义（查询串恒为字符串面）。 */
function readOne(key: string, spec: ParamSpec, source: ArgSource, required: boolean): unknown {
  if (source.kind === 'query') {
    return required ? needQuery(source.url, key)[0] : optQuery(source.url, key)
  }
  const body = source.body
  if (spec.type === 'string') {
    if (required) return spec.enum ? requireOneOf(body, key, spec.enum) : spec.read === 'raw' ? requireString(body, key) : need(body, key)
    switch (spec.read) {
      case 'text': return optText(body, key)
      case 'raw': return optRaw(body, key)
      case 'fallback': return optString(body, key)
      default: return optTrimmed(body, key)
    }
  }
  if (spec.type === 'number') {
    if (required) return requireNumber(body, key)
    return spec.read === 'finite' ? optFinite(body, key) : optNumber(body, key)
  }
  if (spec.type === 'boolean') return required ? requireBoolean(body, key) : optBoolean(body, key)
  if (spec.type === 'object') return required ? requireObject(body, key) : optObject(body, key)
  return optList(body, key)
}

/**
 * 注册表声明 + 通道 `bind` → 引擎实参（顺序＝bind 顺序；`null` 位传 undefined）。
 * 必填清单取通道的 `required`（缺失时回落到 `args` 的 `required`）——「必填」是（命令,通道）
 * 对的事实（实测 9 处两面不一致），故优先级在通道。
 */
export function readArgs(
  args: ParameterSchemaSpec,
  channel: { required?: string[] },
  source: ArgSource,
  bind: Array<string | null>,
): unknown[] {
  const required = new Set(channel.required ?? Object.entries(args).filter(([, s]) => s.required).map(([k]) => k))
  return bind.map(key => {
    if (key === null) return undefined
    const spec = args[key]
    if (!spec) throw new Error(`missing required field: ${key}`) // 声明漏键（门⑧ 该拦下）
    return readOne(key, spec, source, required.has(key))
  })
}
