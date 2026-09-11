/**
 * 面板 HTTP 路由：**数据表 + 一次查表分发**（#168；ADR-0045／ADR-0048）。
 *
 * 今天之前这里是 990 行的 if 链——124 个 `route ===` 分支、零 `else`／零 `switch`，
 * 逐条 `return`。现在分发只剩三步：查表 → 命中即执行 `handler` → 未命中回落 404，
 * 路由本身是数据（GET／PUT 段在 routes.ts，POST 子表在 routes-post.ts）。
 *
 * 两处**逐字保留**的今天语义（都由 tests/host-routes.test.ts 的 464 条探针钉住）：
 * - **POST/PUT 先读体再查表**：非法 JSON 的未知路由今天也是 500 而不是 404，
 *   因为 `readJson` 在 if 链顶就执行了——顺序搬过来，不趁重构顺手改。
 * - **404 文案**带原始方法名与剥前缀后的路由：`unknown route: ${method} ${route}`。
 * 错误出口仍是唯一一个 catch（`{ error: string }` + 500），`sendJson` 单次序列化的
 * 约定不变（引擎对象原样透传，禁手动 stringify 造成双重编码）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, sendJson } from './http.ts'
import type { HostRuntime } from './runtime.ts'
import { getRoutes, putRoutes } from './routes.ts'
import { postRoutes } from './routes-post.ts'
import type { RouteSpec } from './route-table.ts'

/** 客户端面板的 HTTP 路由前缀。 */
export const API = '/learnhub/api'

/** 全量面板路由表（GET 46 + POST 73 + PUT 6 = 125 条表项 / 120 条不同路径）：
 * 一段一段分开写（POST 是子表），装配成一张表——唯一性与「路由 ↔ 工具」对账
 * 都要全局视角，故表在装配处汇总（tests/host-routes.test.ts 遍历断言）。 */
export const routes: readonly RouteSpec[] = [...getRoutes, ...postRoutes, ...putRoutes]

/** 精确键索引 `${method} ${route}`；前缀项另放一列（今天唯一一条 GET /vendor/）。 */
const INDEX = new Map<string, RouteSpec>(
  routes.filter(r => !r.prefix).map(r => [`${r.method} ${r.route}`, r]),
)
const PREFIXES = routes.filter(r => r.prefix)

/** 查表：精确命中优先，其次按前缀项顺序（与 if 链「先精确后前缀」的求值序一致）。 */
export function matchRoute(method: string, route: string): RouteSpec | undefined {
  return INDEX.get(`${method} ${route}`) ?? PREFIXES.find(p => p.method === method && route.startsWith(p.route))
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
    const spec = matchRoute(method, route)
    if (!spec) {
      sendJson(res, 404, { error: `unknown route: ${method} ${route}` })
      return
    }
    await spec.handler({ rt, ctx, req, res, url, route, body })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
