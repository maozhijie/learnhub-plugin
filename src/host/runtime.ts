/**
 * 宿主技术层·runtime（#167 自 src/index.ts 分装；ADR-0048）：
 * 显式 runtime 对象承载宿主全部可变态——engine（门面实例）、agent（统一 agent 缝实例，
 * #162：投递层构造并注入双端口适配，应用层 engine/agent.ts 消费）、vault/centerRel
 * （部署路径）、jobs（生成任务注册表 + 出题结果表）与 flags
 * （queuePaused/pumping/lastSessionStartAt）。技术层函数一律收 runtime 参数（不在函数
 * 体内引用模块级状态），因此每个技术层函数在测试里都可用自造 runtime 直接调用——宿主
 * 第一次可测。除常量外宿主模块级 let 归零。本文件同时承载跨技术层共享的运行日志工具
 * （stripFences 已随缝归位 engine/agent.ts）与部署路径校验/首启 seed。
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { AgentSeam, LearnhubEngine } from '../engine/index.ts'
import type { SeedDraftRequest } from '../engine/index.ts'
import type { GenJobFailure, GenJobPhase, GenJobStatus } from '../generation-jobs.ts'
import { llmSeam, llmStreamSeam } from './llm.ts'
import { mathRng, systemClock } from './clock.ts'
import { nodeVaultFs } from './vault-fs.ts'

/** apply 时的行 config：部署路径与 AI 路由，均可在 profile patch 覆盖。 */
export interface LearnhubConfig {
  /** vault 根目录绝对路径（必填，各机器不同）。 */
  vault?: string
  /** 学习中心相对 vault 的路径（缺省「学习中心」）。 */
  centerRel?: string
  /** AI 生成/判卷的 llm seam provider。 */
  provider?: string
  /** AI 生成/判卷的模型名。 */
  model?: string
  /** 大纲/节正文等机械调用的思考档（缺省 off 提速；路由不支持该档位时自动降级为部署默认）。 */
  fastEffort?: 'off' | 'low'
  /** 高复杂度节点（难度≥4/深节点）的大纲与修复轮的思考档（缺省 low；P4 分层 effort）。 */
  deepEffort?: 'off' | 'low'
}

/** 课程生成任务注册表（course/node 键）：面板「生成」页签的状态源，
 * 页面刷新后从这里恢复（allo 同语义：服务端注册表是事实来源）；
 * 状态每次变更全量落盘 state/生成任务.json，host 重启后读入并把遗留 running 标为失败。 */
export interface GenJob {
  course: string
  node: string
  startedAt: string
  /** 终态时刻（保留期起算点，随注册表落盘）：恢复清扫据此让保留期跨重启仍生效；
   * 旧档无戳回退 startedAt（ADR-0039）。 */
  finishedAt?: string
  status: GenJobStatus
  /** 组合管线的当前阶段：大纲（outline）→ 逐节正文（sections）→ 自动出题（quiz）；
   * 图域任务用 seed/growth/compass/decompile/plan/milestone（#131 §5 / #140；#185 起词表英文统一）。
   * phase=quiz 且直接入队 = 纯出题任务（#118 补生成任务化：/question-generate）。 */
  phase?: GenJobPhase
  /** 逐节进度：done=已就绪节数 total=总节数 current=正在生成的节标题。 */
  progress?: { done: number; total: number; current?: string }
  message?: string
  /** 单节终局失败清单（ADR-0053，结构化失败信息）：失败横幅「定点重写失败节」的
   * 消费面；partial/failed 终态时写入，成功与排队中无此字段（磁盘子格式可选字段，
   * 恢复侧对缺字段旧档案按「无失败信息」读）。 */
  failures?: GenJobFailure[]
  /** 节生成提示词风格变体（缺省默认「课程节生成」）。 */
  style?: string
  /** 节点复杂度档位（低/中/高；生成入口算好写入，面板进度与弹性评估可读）。 */
  tier?: '低' | '中' | '高'
  /** 纯出题任务的参数（#118）：题量上限 / 定向补节（#117）/ 学习者生成指令（#120）。 */
  count?: number
  section?: { id: string; title: string }
  instruction?: string
  /** 入队时实际使用的模型名（模型透明：任务注册表与面板可审计每次生成用的是什么）。 */
  model?: string
  /** 生长批任务的裁决结果（#145，phase=生长；队列空闲自动拉批的重拉判据读它）：
   * idle=就绪深度满足未拉回合 / no_structure=教练裁决暂不产结构 / applied=已应用。 */
  growthOutcome?: 'idle' | 'no_structure' | 'applied'
  /** 里程碑计划修订注入（#149）：换线/补支注入块随任务携带进教练回合（注入即显式
   * 重新裁决请求——就绪深度满足也不短路停摆，见 coachGrowthBatch）。 */
  growthInject?: string
  /** 图域任务负载（面板下发，phase 决定形状）：种子=建课/换终点表单（SeedDraftRequest
   * 去 course——course 是任务键槽）；反编译=项目目标反编译；计划/里程碑=项目草案
   * （course 槽放项目 id）。 */
  seedPayload?: Omit<SeedDraftRequest, 'course'>
  decompilePayload?: { project: string; course?: string; goal?: string; notes?: string[] }
  planPayload?: { project: string }
  milestonePayload?: { project: string; milestone: string }
}

/** 任务注册表 + 纯出题结果表（agent 工具等待完成后读取；结果不进持久化注册表）。 */
export interface HostJobs {
  genJobs: Map<string, GenJob>
  quizJobResults: Map<string, Awaited<ReturnType<LearnhubEngine['bank2']['questionGenerate']>>>
}

/** 运行旗标：重启恢复暂停 / 泵单并发闸 / 会话开始触点节流戳。 */
export interface HostFlags {
  queuePaused: boolean
  pumping: boolean
  lastSessionStartAt: number
}

/** 宿主运行时：全部可变态的显式落点（ADR-0048）。类型可命名、可导出、可被测试构造；
 * ctx 不驻留其上（投递层与宿主 API 的耦合面只留在 apply 与适配器文件——agent 缝持有
 * 的只是 host/llm.ts 适配器产出的端口闭包，不是 ctx 本身）。 */
export interface HostRuntime {
  engine: LearnhubEngine
  /** 统一 agent 缝（#162 / ADR-0041/0044）：六个策略站的调用面。站点方法以它为
   * llm 注入参——投递层构造一次、逐调用传入（#137 注入缝纪律沿袭：测试换假端口）。 */
  agent: AgentSeam
  vault: string
  centerRel: string
  jobs: HostJobs
  flags: HostFlags
}

/** 构造宿主 runtime（apply 装配的第一步）：部署路径校验（缺失/不存在直接失败，不做
 * 静默兜底）→ 新鲜库出生盖戳（#138）→ 构造引擎、agent 缝与空任务表。ctx 按 ADR-0048
 * 只在装配点消费（适配器闭包捕获），不驻留 runtime。 */
export function createHostRuntime(ctx: Context, config: LearnhubConfig = {}): HostRuntime {
  // —— 部署路径（机器级 config）——
  const vault = typeof config?.vault === 'string' ? config.vault.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (!vault) {
    throw new Error(
      '[learnhub] config.vault 缺失：在该机器的 profile patch（~/.dsh/profiles/web/cordis.patch.yml）'
      + '为 id: learnhub 行配置 vault（vault 根目录绝对路径）。')
  }
  if (!existsSync(vault)) throw new Error(`[learnhub] config.vault 目录不存在：${vault}`)
  const centerRel = (config?.centerRel ?? '学习中心').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const center = `${vault}/${centerRel}`
  if (!existsSync(center)) throw new Error(`[learnhub] 学习中心目录不存在：${center}`)
  // 新鲜库出生盖戳（#138）：learnhub.json 与课程注册表都还不存在的全新 vault 直接
  // 盖 v2（免跑已退役的迁移脚本）；任何 v1 痕迹（两者之一在）都交版本硬门判定——
  // 盖戳只发生在真正的一无所有，不掩盖任何旧库。
  const freshConfigPath = `${center}/state/learnhub.json`
  if (!existsSync(freshConfigPath) && !existsSync(`${center}/课程注册表.yaml`)) {
    mkdirSync(`${center}/state`, { recursive: true })
    writeFileSync(freshConfigPath, JSON.stringify({ schema: { version: 2, formats: {} } }, null, 1) + '\n', 'utf8')
  }
  const engine = new LearnhubEngine({ vault, centerRel, clock: systemClock, rng: mathRng, fs: nodeVaultFs })
  // —— 统一 agent 缝装配（#162）：端口适配住 host/llm.ts 唯一适配文件，投递层只构造
  // 与注入；调用日志沿缝贯通、注入侧可观测（console + 运行日志）。 ——
  let rtRef: HostRuntime | undefined
  const agent = new AgentSeam({
    complete: llmSeam(ctx),
    stream: llmStreamSeam(ctx),
    onCall: r => {
      console.info(`[learnhub:agent] ${r.station} · ${r.mode} #${r.callNo} · ${r.effort ?? '默认档'} · ${r.durationMs}ms · 入 ${r.promptChars}/出 ${r.replyChars} 字符`)
      if (rtRef) {
        void runLog(rtRef, 'llm_call',
          `${r.station} · ${r.mode} #${r.callNo} · ${r.effort ?? '默认档'} · ${r.durationMs}ms · 入 ${r.promptChars}/出 ${r.replyChars} 字符`)
          .catch(() => undefined)
      }
    },
  }, systemClock)
  const rt: HostRuntime = {
    engine, agent,
    vault,
    centerRel,
    jobs: { genJobs: new Map(), quizJobResults: new Map() },
    flags: { queuePaused: false, pumping: false, lastSessionStartAt: 0 },
  }
  rtRef = rt
  return rt
}

/** 单条运行日志输出截断上限（与 OB 插件同源）。 */
const LOG_LIMIT = 1500

/** 注册表 engine 字段 → 可调用引擎入口（ADR-0049 C 形态）：
 * 子系统方法写 `<子系统>.<方法>` 点路径，hub 装配域方法保留裸名。
 * 仅此一处做字符串查表；调用方仍以 (...args) 展开传参。
 * 返回前必须 bind 接收者（#190）：调用点是裸函数展开调用，类方法的 `this.e`
 * 门面引用依赖绑定——抽函数不绑定 = 凡用 this 的引擎入口全 500（桩替身不用
 * this，探针快照看不见该缺陷）。 */
export function resolveEngineEntry(rt: HostRuntime, engine: string): (...a: never[]) => unknown {
  const dot = engine.indexOf('.')
  if (dot < 0) {
    const fn = (rt.engine as unknown as Record<string, unknown>)[engine]
    if (typeof fn !== 'function') throw new Error(`[engine] 门面没有引擎入口 ${engine}`)
    return (fn as (...a: never[]) => unknown).bind(rt.engine)
  }
  const sub = (rt.engine as unknown as Record<string, unknown>)[engine.slice(0, dot)]
  const fn = sub ? (sub as Record<string, unknown>)[engine.slice(dot + 1)] : undefined
  if (typeof fn !== 'function') throw new Error(`[engine] 引擎入口不存在：${engine}`)
  return (fn as (...a: never[]) => unknown).bind(sub)
}

/** 运行日志：每次引擎调用的记录（工具名 + 输出摘要）。 */
export async function runLog(rt: HostRuntime, tool: string, output: string): Promise<void> {
  const path = `${rt.engine.paths.centerStateDir}/运行日志.md`
  try {
    if (!existsSync(path)) {
      await mkdir(rt.engine.paths.centerStateDir, { recursive: true })
      await appendFile(path, '# 运行日志\n\n> 插件调用 learnhub 引擎的记录。引擎自动产出，勿手工改。\n', 'utf8')
    }
    const ts = new Date().toLocaleString('sv-SE')
    const clip = output.length > LOG_LIMIT ? output.slice(0, LOG_LIMIT) + '\n…（已截断）' : output
    await appendFile(path, `\n## ${ts} · ${tool}\n\n\`\`\`\n${clip.trim() || '（无输出）'}\n\`\`\`\n`, 'utf8')
  } catch {
    // 日志失败不影响主流程
  }
}

/** D14 v3 唯一出口：engine 调用 + 运行日志。 */
export async function run(rt: HostRuntime, tool: string, fn: () => Promise<string>): Promise<string> {
  const out = await fn()
  await runLog(rt, tool, out)
  return out
}

/** 面板路由出口：引擎返回对象原样透传（sendJson 统一序列化一次），
 * 日志记录序列化摘要；调用失败也留痕（#116：运行日志支持失败记录），随后原样抛出。
 * 绝不在路由里手动 stringify 对象——会双编码。 */
export async function apiRun<T>(rt: HostRuntime, tool: string, fn: () => Promise<T>): Promise<T> {
  let out: T
  try {
    out = await fn()
  } catch (err) {
    await runLog(rt, tool, `调用失败：${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
  await runLog(rt, tool, typeof out === 'string' ? out : JSON.stringify(out))
  return out
}

