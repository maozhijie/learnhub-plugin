/**
 * 面板路由表·表项形状与构造器（#168；ADR-0045／ADR-0048）。
 *
 * 路由从「990 行 if 链 / 124 个 `route ===` 分支」变成**数据表**：每条路由是一个
 * `RouteSpec`，分发只剩一次查表。本文件只放形状与构造器——零表项、零 I/O，
 * 让 GET／POST／PUT 三段各自成文件而不互相成环。
 *
 * **预留 ADR-0045 命令注册表的字段位**：`id / summary / args / engine / output / channels`
 * 已在形状里，本票只留位、不消费（表项先只是声明，#169 把注册表与适配器接上时在**原地**填，
 * 而不是另造一份表——#165 已裁定「数据化后应直接演进为命令注册表的投递面」）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostRuntime } from './runtime.ts'

/** 面板路由今天实际在用的三种方法（表项方法与路径都是分发键）。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT'

/** 路由处理上下文：一条路由需要的一切。`body` 只在 POST/PUT 段被解析（GET 段恒为 `{}`，
 * 今天 GET 不读请求体，契约不变）；`route` 是剥掉 `/learnhub/api` 前缀后的路径
 * （前缀路由与伺服类路由要原样用它）。 */
export interface RouteCall {
  rt: HostRuntime
  ctx: Context
  req: IncomingMessage
  res: ServerResponse
  url: URL
  route: string
  body: Record<string, unknown>
}

export type RouteHandler = (call: RouteCall) => Promise<void> | void

/** ADR-0045 命令注册表的字段位（#169 填充）。字段可选＝本票不消费它们，
 * 但形状先立住：注册表落地时是**填**这些键，不是改表项形状。 */
export interface RegistrySlots {
  /** 稳定主键（kebab）；工具名与路由路径由它派生或显式声明。 */
  id?: string
  /** 人话描述——工具面 description 与面板文案的单一出处。 */
  summary?: string
  /** 参数 schema（沿用宿主已在写的 SDK per-property DSL）：类型在 #169 与 SDK 对齐时收紧。 */
  args?: unknown
  /** 引擎入口（门面方法名）——必填字段，有门断言它存在（#169）。 */
  engine?: string
  /** 输出形状：引擎视图类型的类型引用（编译期，零运行时）。 */
  output?: unknown
  /** 允许通道 + 各自执行模型（今天不是命令的属性、是（命令, 通道）对的属性，故两字段不拆）。 */
  channels?: ReadonlyArray<{
    channel: 'agent' | 'panel'
    mode: 'sync' | 'queued'
    tool?: string
    route?: { method: HttpMethod; path: string }
  }>
}

/** 一条面板路由：分发键（method/route）+ 唯一实现（handler）+ 注册表字段位。 */
export interface RouteSpec extends RegistrySlots {
  method: HttpMethod
  route: string
  handler: RouteHandler
  /** 前缀路由：`route` 作前缀匹配（今天唯一一条：GET `/vendor/`）。 */
  prefix?: boolean
}

const spec = (method: HttpMethod, route: string, handler: RouteHandler): RouteSpec => ({ method, route, handler })

/** GET 表项构造器。 */
export const get = (route: string, handler: RouteHandler): RouteSpec => spec('GET', route, handler)
/** POST 表项构造器。 */
export const post = (route: string, handler: RouteHandler): RouteSpec => spec('POST', route, handler)
/** PUT 表项构造器。 */
export const put = (route: string, handler: RouteHandler): RouteSpec => spec('PUT', route, handler)
/** 前缀路由表项构造器（唯一一条 GET /vendor/）。 */
export const getPrefix = (route: string, handler: RouteHandler): RouteSpec => ({ ...spec('GET', route, handler), prefix: true })
