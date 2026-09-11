/**
 * learnhub 学习引擎插件（Host 侧，bundle 形态）—— v3 纯 TS 引擎。
 *
 * Python 引擎已退役：原 `spawn python -m learnhub` 的全部命令面由
 * src/engine/（TS）同进程承载，本文件只做装配（#167 薄入口，ADR-0048）：
 * - 构造显式 HostRuntime（部署路径校验 + 首启 seed + 引擎与队列状态，host/runtime.ts）
 * - 恢复生成任务注册表（host/jobs.ts）并注册 agent 工具面（host/tools.ts，按域分组）
 * - 注册 HTTP 路由 /learnhub/api/*（host/api.ts）与 /learnhub 独立面板页（host/static.ts）
 *
 * 技术层分文件：runtime（构造与装配）/ jobs（入队、泵、清扫、runner）/ api（路由
 * 分发）/ static（面板与 vendor 伺服）/ tools（工具面注册）；除常量外宿主零模块级
 * 可变状态，技术层函数一律收 HostRuntime 参数。
 *
 * 跨机器部署：vault/中心路径不硬编码，由 cordis 行 config 提供
 * （config.vault 必填；centerRel 缺省「学习中心」），机器差异写在
 * profile 的 cordis.patch.yml，仓库内不含任何机器路径。
 *
 * 纪律：
 * - D14（v3）：一切数据访问收口 engine/ 模块；工具/路由/UI 不得绕过 engine 直写数据文件。
 * - D15：评分只经工作单 → settle 入库；UI 自动写回也只写工作单评分行。
 * - 每次工具/路由调用追加 state/运行日志.md（LOG_LIMIT 截断）。
 */
import type { Context, Effect } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { llmCfg } from './host/llm.ts'
import { createHostRuntime } from './host/runtime.ts'
import type { LearnhubConfig } from './host/runtime.ts'
import { restoreGenJobs } from './host/jobs.ts'
import { registerTools } from './host/tools.ts'
import { API, handleApi } from './host/api.ts'
import { PAGE, panelPageHandler } from './host/static.ts'

export const name = 'dsh-learnhub'
export const inject = ['tools', 'webServer', 'llm']

/**
 * `webServer` 服务由宿主的 web 插件提供（dsh CLI 私有包，本仓库不依赖它，故类型不在册）：
 * 按消费面补声明——本插件只用 `register({ kind: 'prefix', path, handler })` 两种前缀路由
 * （ADR-0013 的结构化窄面：宽面由宿主定义，这里只登记自己用的那一格）。
 * `llm` / `tools` 的类型由 dsh-llm / dsh-tools 各自的 `declare module` 提供，无需在此重述。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): Effect
    }
  }
}

export type { LearnhubConfig } from './host/runtime.ts'

export function apply(ctx: Context, config?: LearnhubConfig) {
  // —— 装配：部署路径校验与首启 seed、引擎与队列状态收进显式 runtime（ADR-0048）——
  const rt = createHostRuntime(ctx, config ?? {})

  // provider/model/快速档来自行 config（缺省用当前默认模型与 off 快速档）
  if (config?.provider) llmCfg.provider = config.provider
  if (config?.model) llmCfg.model = config.model
  if (config?.fastEffort) llmCfg.fastEffort = config.fastEffort
  if (config?.deepEffort) llmCfg.deepEffort = config.deepEffort

  // 生成任务注册表恢复（fire-and-forget）：running 标失败、queued 保留但队列暂停
  restoreGenJobs(rt)

  // —— agent 工具面（111 个，按域分组注册）——
  registerTools(ctx, rt)

  // —— 客户端面板 HTTP 路由 ——
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API, handler: (req, res) => handleApi(rt, ctx, req, res) }),
    'learnhub: client panel API routes',
  )

  // —— 独立面板页面（Vite SPA：web/dist/index.html + assets/*，子路径全部伺服）——
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PAGE, handler: panelPageHandler }),
    'learnhub: panel SPA (web/dist)',
  )

  console.log(`[learnhub] plugin loaded: vault=${rt.vault}, center=${rt.vault}/${rt.centerRel}, 106 tools registered (pure TS engine), page at ${PAGE}, API at ${API}/*`)

  // 加载自检：不依赖模型直接跑一次 status，验证引擎通路。
  void rt.engine.statusJson()
    .then(doc => console.log(`[learnhub] self-check status OK (${JSON.stringify(doc).length} bytes)`))
    .catch(err => console.error(`[learnhub] self-check FAILED: ${err instanceof Error ? err.message : String(err)}`))
}
