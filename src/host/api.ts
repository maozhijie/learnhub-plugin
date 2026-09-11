/**
 * 面板 HTTP 路由：**注册表驱动分发**（#168 数据表 → #169 注册表；ADR-0045／ADR-0048）。
 *
 * 分发三步：查表（注册表的 panel 通道）→ 命中即按声明取值并直调引擎（生成路径）→
 * 生成路径覆盖不到的例外由 `handlers.ts` 的手写 handler 承接；未命中回落 404。
 *
 * 三条**逐字保留**的今天语义（由 tests/host-routes.test.ts 的 464 条探针钉住）：
 * - **POST/PUT 先读体再查表**：非法 JSON 的未知路由今天也是 500 而不是 404；
 * - **404 文案**带原始方法名与剥前缀后的路由：`unknown route: ${method} ${route}`；
 * - **错误出口唯一**（`{ error: string }` + 500），`sendJson` 单次序列化的约定不变
 *   （引擎对象原样透传，禁手动 stringify 造成双重编码）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BY_ROUTE, COMMAND_LIST } from '../commands/index.ts'
import type { ChannelSpec, CommandSpec } from '../commands/index.ts'
import { readJson, sendJson } from './http.ts'
import type { LearnhubEngine } from '../engine/index.ts'
import { readArgs } from './params.ts'
import { apiRun } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import { HANDLERS } from './handlers.ts'
import type { RouteCall } from './route-table.ts'

/** 客户端面板的 HTTP 路由前缀。 */
export const API = '/learnhub/api'

/** 前缀路由（今天唯一一条：GET /vendor/）——精确键之外的第二张网。 */
const PREFIX_ROUTES: Array<{ method: string; path: string; command: CommandSpec; channel: ChannelSpec }> =
  COMMAND_LIST.flatMap(c => c.channels
    .filter(ch => ch.route && ch.prefix)
    .map(ch => ({ method: ch.route!.method, path: ch.route!.path, command: c, channel: ch })))

/** 查表：精确命中优先，其次前缀项（与 if 链「先精确后前缀」的求值序一致）。 */
export function matchRoute(method: string, route: string): CommandSpec | undefined {
  return BY_ROUTE.get(`${method} ${route}`)
    ?? PREFIX_ROUTES.find(p => p.method === method && route.startsWith(p.path))?.command
}

/** 命中详情：命令 + 该 (method, path) 对应的通道。 */
function lookup(method: string, route: string): { command: CommandSpec; channel: ChannelSpec } | undefined {
  const exact = BY_ROUTE.get(`${method} ${route}`)
  if (exact) return { command: exact, channel: exact.channels.find(ch => ch.route?.method === method && ch.route?.path === route)! }
  const pre = PREFIX_ROUTES.find(p => p.method === method && route.startsWith(p.path))
  return pre ? { command: pre.command, channel: pre.channel } : undefined
}

/** /learnhub/api/* 路由分发：客户端面板的全部后端入口（响应形状与 v2 一致）。 */
export async function handleApi(rt: HostRuntime, ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API.length)
  const method = req.method ?? ''
  try {
    // POST/PUT 段：先解析请求体（与拆分前同序——体恒被读，即使路由未命中），再查表
    const hasBody = method === 'POST' || method === 'PUT'
    const body = hasBody ? await readJson(req) : {}
    const hit = lookup(method, route)
    if (!hit) {
      sendJson(res, 404, { error: `unknown route: ${method} ${route}` })
      return
    }
    const { command, channel } = hit
    // 生成路径：声明式取值 → 引擎直调（日志口径按通道声明，与手写时代逐字一致）
    if (command.engine !== undefined && channel.bind !== undefined) {
      const engine = command.engine
      const args = readArgs(command.args, channel, hasBody ? { kind: 'body', body } : { kind: 'query', url }, channel.bind)
      const call = async () => (rt.engine[engine as keyof LearnhubEngine] as (...a: unknown[]) => unknown)(...args)
      const out = channel.log === false ? await call() : await apiRun(rt, `api${channel.route?.path ?? route}`, call)
      sendJson(res, 200, out)
      return
    }
    // 例外：手写 handler（键是命令 id；门④ 断言它恰等于非生成路径命令的集合）
    const handler = HANDLERS[`${method} ${channel.route?.path ?? route}`]
    if (!handler) throw new Error(`[route] ${method} ${route} 既无生成路径也无 handler（门④ 该拦下）`)
    const call: RouteCall = { rt, ctx, req, res, url, route, body }
    await handler(call)
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
