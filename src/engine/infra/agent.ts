/**
 * 统一 agent 缝（ADR-0041 形状 / ADR-0044 归属；#162 落地）：引擎与 LLM 交互的
 * 唯一调用面，接口按业务事实分双模式——`complete()` 单发直返 + `agentLoop()` 有界
 * 只读工具回路。
 *
 * 归属（ADR-0044）：本文件是应用层的端口消费者——端口住应用层（`engine/infra/llm.ts` 的
 * `LlmComplete`/`LlmStream` 纯类型）、实现住适配器（dsh 耦合 100% 收在 `host/llm.ts`
 * 唯一适配文件）、装配住投递层（`createHostRuntime` 构造并注入）；R3「engine 禁
 * import `@deepseek-ai/*`」从此就是应用层与适配器的分界线。
 *
 * 调用策略在缝里实现一次、全部站共享：
 * - 补全文本后处理：`stripFences`（原散在投递层的适配器行为）随缝归位；
 * - 语义档（fast/deep）：调用点只声明语义档，沿缝贯通、注入侧经 onCall 可观测；
 * - 调用日志：每轮底层调用产出 `AgentCallRecord`（站/模式/档/序号/耗时/字数）；
 * - 门错修复轮（恰一轮回灌重裁）：`gateRepairRound()`——受理门错误原文 + 被拒候选
 *   原文回灌重产一次，仍败以站点死因抛出。#157 的生长批回灌重裁段即此形态的雏形，
 *   随缝收口共享（受理门本身零改动，ADR-0050 语义原样）。
 *
 * 回路预算（ADR-0041；ADR-0077 上调 6→20；#328 起三件成组）：轮数 ≤20 / 输出 token
 * ≤32768 / 总时长 ≤30 分钟（`agentLoop` 强制，不设调用方覆盖）+ 1 次门错
 * 修复轮（`gateRepairRound` 强制）；回路只在生成队列任务内运行，工具实现禁止递归
 * 入队/触发教练。宿主会话适配位（后路）：教练未来需要全 agent 面（查 vault 笔记、
 * 查网）时，把注入的 LlmStream 换成 `ctx.agents.create` 的会话适配实现——调用点
 * 零改动。
 */
import type { LlmComplete, LlmEffort, LlmLoopTurn, LlmStream, LlmTokenUsage, LlmToolCall, LlmToolSpec } from './llm.ts'
import type { Clock } from './clock.ts'
import type { Logger } from './logger.ts'

/** 剥掉模型可能包住的整段 markdown 代码围栏：限 markdown/yaml/json 等数据类标签——
 * 正文类标签（svg/plot 等）本身是内容的一部分，剥掉会毁掉 ```svg/```plot 引用块。
 * （自 host/runtime.ts 随缝归位：这是补全结果的适配器后处理，不再散在投递层。） */
export function stripFences(body: string): string {
  const m = body.match(/^```(?:markdown|md|yaml|yml|json)?\s*\n([\s\S]*?)\n```\s*$/)
  return m ? m[1] : body
}

/** 工具轮预算上限（ADR-0041 形状；ADR-0077 上调 6→20；#328 起为三件成组预算的轮数件）：
 * 回路第 K 轮后仍请求工具即中止；不设调用方覆盖（统一天花板不分档）——教练职责变重
 * （归因/定位/插入裁决/在途自报消费）要更深回路，撞顶照旧 fail loud（trajectory 工具轨迹
 * 补自激防线的观测面）。 */
export const AGENT_LOOP_MAX_TOOL_ROUNDS = 20

/** 回路预算三件成组（#328 / ADR-0101 §否决了什么）：轮数 / 输出 token / 总时长——
 * 预算是「防烧穿」的成组防线，不是「多拨点数」的绩效指标。「只拨数字」式单纯加轮数被
 * 明确否决：本仓两次事故（#309 的 21 轮 / 约 35k token 零发布，与 2026-09-17 的 20 轮 /
 * 约 33.1k token 空转）都是**烧到轮数顶零发布**——轮数顶只兜自激空转的尾部，单独存在时
 * 挡不住「不撞顶但也烧穿了」的会话。三件各管一个烧穿面，按本仓规模论证如下：
 *
 * - **轮数 20**（`AGENT_LOOP_MAX_TOOL_ROUNDS`）：健康会话（单批或数批：graph_view 对表 →
 *   patch → audit → finish，生产轨迹实测一个发布批约 3–5 个工具轮）远低于此；20 给多批
 *   会话（3 批 × ~5 轮 + 审计与收尾）留头寸。理由不是「越大越好」，而是它与熔断
 *   （`AGENT_LOOP_REPEAT_LIMIT`，同错误 3 次止血）分工：熔断管「同一不可修复错误的反复
 *   重试」，轮数顶管「每次都换个花样但毫无进展」的长尾。
 * - **输出 token 32768**：回路真正随轮数线性涨的是输出侧（每轮的工具调用参数 + 简短
 *   文本；上下文与工具回执是输入侧）。健康会话的输出量级是数千；事故全程约 35k——
 *   取 32768 ≈ 恰好在「健康会话够用、事故挡得住」的量纲上，配合熔断与草稿侧
 *   `draft_revert` 撤销出口，把「烧穿」从不可见变成 fail loud 的死因。token 计量沿
 *   provider usage 回程（#213），路由未上报 usage 时该件不执法（best-effort，与观测面同口径）。
 * - **总时长 1800000ms（30 分钟）**：deep 档单轮含推理可达分钟级，20 轮健康上限 ≈ 20–30
 *   分钟；30 分钟封的是「无人值守烧额度」（#312 B1 的自激回路无人值守形态）的墙钟尾部
 *   ——token 件管不住 provider 慢响应，时长件与取消旗标（`isCancelled`）共同兜底。
 * 与消费侧的配合：草稿站（growth-subsystem.coachDraft）在回路外另有**会话级**轮志预算
 * （`GROWTH_DRAFT_MAX_ROUNDS`，写件轮计数）与「禁止空手结束」门——缝级三件管单次回路，
 * 站级预算管会话生命周期，两层不互相替代。 */
export const AGENT_LOOP_MAX_OUTPUT_TOKENS = 32768
export const AGENT_LOOP_MAX_DURATION_MS = 1_800_000

/** 同错误熔断阈值（ADR-0041 §修订补记 2026-09-16；#309 缺陷④ 加第二口径）。两条口径共用
 * 本阈值：① 同一工具**连续** ≥3 次返回**逐字相同**的结果（成功与失败同口径）——管纯自激
 * 空转；② 同一工具的**同一门错误行**在会话内累计 ≥3 次——管 `patch / finish` 交替的挣扎
 * （2026-09-17 事故实测：① 被中间的成功 patch 打断而 0 次触发、最终撞 K≤20 顶；② 的指纹
 * 口径见 `fingerprintLinesOf`，全文/全部行口径在事故与「连试四种不同非法取值」两种形态下
 * 各自失效）。② 按「进展世代」（`agentLoop` 的 `progressEpoch`，草稿站 = 已发布水位）前移
 * 清零：成功发布的正常节奏不误杀。与 K≤20 的分工：K 顶管「自激空转」，本阈值管「同一不可
 * 修复错误的反复重试」。 */
export const AGENT_LOOP_REPEAT_LIMIT = 3

/** 调用模式（观测面词汇）：complete 单发 / repair 门错修复轮 / loop 工具回路轮。 */
export type AgentCallMode = 'complete' | 'repair' | 'loop'

/** 一次底层 LLM 调用的观测记录（注入侧可观测：宿主接调试日志 `agent.call` + console）。 */
export interface AgentCallRecord {
  /** 调用站标签（种子起草/教练生长/罗盘/目标反编译/计划草案/里程碑草案/…）。 */
  station: string
  mode: AgentCallMode
  /** 语义档；不传 = 部署默认档。 */
  effort?: LlmEffort
  /** 本进程内该站·该模式的第几次底层调用（1 起）。 */
  callNo: number
  promptChars: number
  replyChars: number
  durationMs: number
  /** token 计量（#213）：适配器从 provider usage 块回传；缺省 = 路由未上报。 */
  usage?: LlmTokenUsage
}

/** 缝的端口注入：complete 必带；stream 只在 agentLoop 消费；onCall 是观测面。
 * `logger`（#253 / ADR-0080）是**调试日志端口**——门错修复轮的四条 `agent.gate.*`
 * 事件由缝自己发（站点参数沿 `gateRepairRound(station, …)` 贯通），故缝必须持有它。
 * **必填**：可选会让「忘了接线 = 日志静默消失」，正是本票要治的病。 */
export interface AgentSeamPorts {
  complete: LlmComplete
  stream?: LlmStream
  onCall?: (record: AgentCallRecord) => void
  logger: Logger
}

/** 门的裁决：errors 空 = 过门。门可以是**受理门**（propose/写盘这类过门即落受理产物
 * 的门）——过门的产物经 result 随行交还站点，门错误清单按站点自己的格式给出（原样
 * 回灌修复轮、原样进死因）。门内抛错 = 程序性失败（非门拒绝），原样冒泡不进修复轮。 */
export interface GateVerdict<U> {
  errors: string[]
  result?: U
}

/** 门错修复轮的站点规格。 */
export interface GateRepairSpec<T, U> {
  /** 首轮产出候选。 */
  first: () => Promise<T>
  /** 门：校验（受理式门在过门处落产物，经 GateVerdict.result 随行）。 */
  gate: (candidate: T) => GateVerdict<U> | Promise<GateVerdict<U>>
  /** 修复轮（缝保证恰调用一次）：门错误原文 + 被拒候选原文回灌，重产候选。 */
  repair: (gateErrors: string[], rejected: T) => Promise<T>
  /** 两轮仍败（或修复轮自身失败）的死因——站点自己的错误文案与错误码。 */
  fatal: (firstErrors: string[], repairDeath: string[]) => Error
}

export class AgentSeam {
  /** clock = 时钟端口（#175 阶段①）：调用日志的耗时测量与 startedAt 经它取时——
   * 装配点（createHostRuntime）给 systemClock，测试给固定时钟。 */
  constructor(private readonly ports: AgentSeamPorts, private readonly clock: Clock) {}

  /** 本站本模式的底层调用序号（观测面用；实例态，缝随 runtime 每进程一份）。 */
  private callSeq = new Map<string, number>()

  /** 单发模式：一次对话直接返回（剥围栏 + 语义档 + 调用日志内建）。 */
  async complete(station: string, prompt: string, opts?: { system?: string; effort?: LlmEffort }): Promise<string> {
    return this.call(station, 'complete', prompt, opts)
  }

  /** 门错修复轮的补全（与 complete 同一传输，观测面标 repair——回灌重裁可观测）。 */
  async repair(station: string, prompt: string, opts?: { system?: string; effort?: LlmEffort }): Promise<string> {
    return this.call(station, 'repair', prompt, opts)
  }

  /** 门错修复轮（共享能力，ADR-0041「+1 次门错修复轮」）：first() 产出 → gate() 校验
   * → 未过以门错误原文 + 被拒候选原文回灌 repair() 重产**恰一次** → 仍败（或修复轮
   * 自身失败）以 fatal() 抛两轮死因。修复轮的语义档由站点在 repair() 内声明（回灌
   * 重裁恒 deep 档）。过门的受理产物经 `result` 交还（受理式门：类型上过门必有产物）。
   *
   * `station`（#253 / ADR-0080 复活，原为未用的 `_station`）是**日志站点标签**，四条
   * `agent.gate.*` 事件全带它——「到底跑没跑回灌重裁」由此一眼可判：
   * `agent.gate.repair` 不出现 = 首轮就过门（或根本没进这个缝）。三条实际调用点 =
   * 教练生长／目标反编译／里程碑草案（`agent.gate.first`/`repair`/`repair.reject`/`death`
   * 只从三站发出；「六站共用」指整个缝而非这一形态，见 ADR-0080 §修订）。 */
  async gateRepairRound<T, U>(station: string, spec: GateRepairSpec<T, U>): Promise<{ candidate: T; result: U; repaired: boolean }> {
    const log = this.ports.logger
    const candidate = await spec.first()
    const firstGate = await spec.gate(candidate)
    if (!firstGate.errors.length) {
      log.info('agent.gate.first', { station, verdict: 'pass', errors: 0 })
      return { candidate, result: firstGate.result as U, repaired: false }
    }
    log.info('agent.gate.first', { station, verdict: 'reject', errors: firstGate.errors.length, detail: firstGate.errors })
    log.info('agent.gate.repair', { station, attempt: 1 })
    let repairedCandidate: T
    try {
      repairedCandidate = await spec.repair(firstGate.errors, candidate)
    } catch (err) {
      const death = [err instanceof Error ? err.message : String(err)]
      log.error('agent.gate.death', { station, first_errors: firstGate.errors.length, repair_errors: death.length, detail: [...firstGate.errors, ...death] })
      throw spec.fatal(firstGate.errors, death)
    }
    const repairGate = await spec.gate(repairedCandidate)
    if (repairGate.errors.length) {
      log.warn('agent.gate.repair.reject', { station, errors: repairGate.errors.length, detail: repairGate.errors })
      log.error('agent.gate.death', { station, first_errors: firstGate.errors.length, repair_errors: repairGate.errors.length, detail: [...firstGate.errors, ...repairGate.errors] })
      throw spec.fatal(firstGate.errors, repairGate.errors)
    }
    return { candidate: repairedCandidate, result: repairGate.result as U, repaired: true }
  }

  /** 工具回路模式（有界多轮迭代 + 只读工具调用）：模型每轮可请求白名单内工具，
   * 缝执行 runTool 并把结果回灌继续；模型不再请求工具即以文本产出收束（剥围栏）。
   * K≤`AGENT_LOOP_MAX_TOOL_ROUNDS` 轮后仍请求工具即 fail loud——预算封顶防自激循环。
   * 预算三件成组（#328）：轮数之外，输出 token（沿 usage 回程累计，路由未上报则该件
   * 不执法）与总时长任一件越顶同位 fail loud，死因点名触顶件与实测数——单纯加轮数被
   * ADR-0101 否决（两次事故都是烧到 K 顶零发布），三件各管一个烧穿面。
   * isCancelled（#163 任务取消传导）：每轮底层调用前与每次工具执行后检查，取消即抛错
   * 中止——生成页取消旗标沿站点传入，回路不再空烧后续轮。trajectory 逐轮记录工具调用
   * 与结果摘要（#163 任务消息消费）。
   * 同错误熔断（#302 ③ / ADR-0041 §修订补记；#309 缺陷④ 口径重写）见
   * `AGENT_LOOP_REPEAT_LIMIT`；工具级失败
   * 同时发 `agent.tool.fail` 一条（站/工具/错误摘要）——此前失败只活在 trajectory 与
   * 下一轮回灌里，调试日志零事件（事后只能逐件考古语料）。 */
  async agentLoop(req: {
    station: string
    /** 回路首条用户消息（任务指令/上下文包）。 */
    prompt: string
    system?: string
    effort?: LlmEffort
    /** 只读工具白名单（教练工具面 = 只读引擎视图白名单；白名单外调用由 runTool 拒）。 */
    tools: LlmToolSpec[]
    /** 工具执行器：缝只做回路与预算，不持有工具。 */
    runTool: (call: LlmToolCall) => Promise<string>
    /** 取消检查（队列任务取消旗标；缺省不查）。true = 抛错中止，已产结果丢弃。 */
    isCancelled?: () => boolean
    /** 进展世代（#309 缺陷④）：调用方在**确有进展**处返回一个单调值（草稿站 = 已发布
     * 水位，发布成功即前移）。每轮读一次，值变了就清空熔断游标——成功发布的正常节奏
     * 不误杀；缺省不查（无进展概念的站按会话内累计）。 */
    progressEpoch?: () => number
  }): Promise<{ text: string; toolRounds: number; trajectory: string[] }> {
    if (!this.ports.stream) {
      throw new Error(`[agent-seam] 「${req.station}」需要工具回路，但注入侧未提供 LlmStream 端口（宿主适配器缺位）。`)
    }
    const assertAlive = (): void => {
      if (req.isCancelled?.() === true) {
        throw new Error(`[agent-seam] 「${req.station}」任务已取消——工具回路中止（已产结果丢弃）。`)
      }
    }
    const turns: LlmLoopTurn[] = [{ role: 'user', text: req.prompt }]
    const trajectory: string[] = []
    // 熔断游标（缝的局部态，随一次回路生命周期生灭）。两条口径并存（#309 缺陷④）：
    // ① **连续逐字相同**（成功与失败同口径，ADR-0041 §修订补记原口径）——纯自激空转；
    // ② **同一工具、同一门错误行在会话内累计**（本票新增）——① 在 patch/finish 交替的挣扎
    //    形态下被中间的成功调用打断而恒不触发（2026-09-17 事故实测：4 次 finish 被拒、熔断
    //    0 次触发、最终撞 K≤20 顶）。指纹取**门错误行**而非全文/全部行见 `fingerprintLinesOf`；
    //    行口径在第 24 次调用（第三次 finish 被拒）止血。
    let lastTool = ''
    let lastResult = ''
    let repeats = 0
    // 口径② 的行指纹计数（键 = 工具 + 行，见 `LINE_SEP`）：只在进展世代前移时清空。
    const lineHits = new Map<string, number>()
    let epoch = req.progressEpoch?.()
    let toolRounds = 0
    // 预算三件成组（#328）的回路内计量：时长起点取自时钟端口（测试可注入固定钟）；
    // 输出 token 沿 provider usage 回程累计（路由未上报 usage 时该件不执法）。
    const loopStartedAt = this.clock.nowMs()
    let outputTokens = 0
    for (;;) {
      assertAlive()
      // 进展世代前移（发布成功）：清空熔断游标——成功发布的正常节奏不误杀（#309 ④）
      const nowEpoch = req.progressEpoch?.()
      if (nowEpoch !== epoch) {
        epoch = nowEpoch
        repeats = 0
        lineHits.clear()
      }
      const startedAt = this.clock.nowMs()
      const r = await this.ports.stream({
        messages: turns,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
        station: req.station,
        tools: req.tools,
      })
      this.emit(req.station, 'loop', req.effort, promptCharsOf(turns), r.text, startedAt, r.usage)
      if (r.usage) outputTokens += r.usage.outputTokens
      const calls = r.toolCalls ?? []
      if (!calls.length) {
        return { text: stripFences(r.text), toolRounds, trajectory }
      }
      // 预算三件成组（#328）：轮数 / 输出 token / 总时长任一件越顶即 fail loud——死因点名
      // 触顶的是哪一件与实测数，与「同错误熔断」的死因措辞可区分（熔断管同一不可修复错误
      // 的反复重试，三件预算管「换个花样但毫无进展」的烧穿长尾）。与轮数件同位裁决：本轮
      // 新请求的工具调用不再执行（与 K 顶同款，已执行轮的产物已在 trajectory）。
      const elapsedMs = this.clock.nowMs() - loopStartedAt
      const budgetTripped = toolRounds >= AGENT_LOOP_MAX_TOOL_ROUNDS
        ? `轮数件（${toolRounds} 轮后仍在请求工具，上限 ${AGENT_LOOP_MAX_TOOL_ROUNDS} 轮）`
        : outputTokens > AGENT_LOOP_MAX_OUTPUT_TOKENS
          ? `输出 token 件（累计 ${outputTokens}，上限 ${AGENT_LOOP_MAX_OUTPUT_TOKENS}）`
          : elapsedMs > AGENT_LOOP_MAX_DURATION_MS
            ? `总时长件（已用 ${elapsedMs}ms，上限 ${AGENT_LOOP_MAX_DURATION_MS}ms）`
            : null
      if (budgetTripped) {
        throw new Error(`[agent-seam] 「${req.station}」工具回路预算耗尽（三件成组：轮数/输出 token/总时长）——${budgetTripped}触顶，回路中止。`)
      }
      toolRounds++
      turns.push({ role: 'assistant', text: r.text, toolCalls: calls })
      for (const call of calls) {
        let out: string
        let isError = false
        try {
          out = await req.runTool(call)
        } catch (err) {
          out = err instanceof Error ? err.message : String(err)
          isError = true
          this.ports.logger.warn('agent.tool.fail', {
            station: req.station, tool: call.name, chars: out.length, error: firstLineOf(out),
          })
        }
        trajectory.push(`${call.name}(${call.arguments.length} 字符参数) → ${out.length} 字符${isError ? '（失败）' : ''}`)
        turns.push({ role: 'tool', callId: call.id, text: out, ...(isError ? { isError: true } : {}) })
        if (call.name === lastTool && out === lastResult) repeats++
        else { lastTool = call.name; lastResult = out; repeats = 1 }
        if (repeats >= AGENT_LOOP_REPEAT_LIMIT) {
          throw new Error(`[agent-seam] 「${req.station}」工具回路熔断：${call.name} 连续 ${repeats} 次返回逐字相同的结果（${out.length} 字符）——回路中止，死因：同错误重复。`)
        }
        if (isError) {
          // 口径②（#309 缺陷④）：同一工具 + 同一结果行在本次回路内累计（逐行去重）。中间夹着
          // 的成功调用、**别的工具**的失败、以及同一次失败里的其他错误行都不打断它——那正是
          // 事故里计数被重置的漏洞；清零只认进展世代（发布成功）。
          //
          // 代价与理由：同一行连续出现三轮即熔断，哪怕模型每轮都在改别处（那正是事故形状：
          // 三条「档位非法」行在四次 finish 拒绝里一直在场）。接受这个口径是因为「这一条错误
          // 三轮没被消掉」就是「同一不可修复错误的反复重试」本身，而 #309 缺陷② 起另有
          // `draft_revert` 这条正路；反过来放过的代价是非对称的（实测 35k token 零产出）。
          const lines = fingerprintLinesOf(out)
          let tripped: { line: string; n: number } | null = null
          for (const line of lines) {
            const key = `${call.name}${LINE_SEP}${line}`
            const n = (lineHits.get(key) ?? 0) + 1
            lineHits.set(key, n)
            if (n >= AGENT_LOOP_REPEAT_LIMIT && !tripped) tripped = { line, n }
          }
          if (tripped) {
            throw new Error(`[agent-seam] 「${req.station}」工具回路熔断：${call.name} 的同一结果行在本次会话内累计出现 `
              + `${tripped.n} 次（跨成功调用累计、逐字相同：「${tripped.line.length > 120 ? `${tripped.line.slice(0, 120)}…` : tripped.line}」）`
              + `——回路中止，死因：同错误重复。`)
          }
        }
        assertAlive()
      }
    }
  }

  /** 底层调用的共用传输：端口调用（站标签/形态/usage 回程沿 opts 贯通，#213）+ 观测记录。 */
  private async call(station: string, mode: AgentCallMode, prompt: string, opts?: { system?: string; effort?: LlmEffort }): Promise<string> {
    const startedAt = this.clock.nowMs()
    let usage: LlmTokenUsage | undefined
    const raw = await this.ports.complete(prompt, opts?.system, {
      ...(opts?.effort === undefined ? {} : { effort: opts.effort }),
      station,
      kind: mode,
      usageSink: u => { usage = u },
    })
    this.emit(station, mode, opts?.effort, prompt.length, raw, startedAt, usage)
    return stripFences(raw)
  }

  /** 观测面：记录产出后回放 onCall；观测面故障不挡调用。 */
  private emit(station: string, mode: AgentCallMode, effort: LlmEffort | undefined, promptChars: number, reply: string, startedAt: number, usage?: LlmTokenUsage): void {
    const key = `${station}·${mode}`
    const callNo = (this.callSeq.get(key) ?? 0) + 1
    this.callSeq.set(key, callNo)
    try {
      this.ports.onCall?.({
        station, mode,
        ...(effort !== undefined ? { effort } : {}),
        callNo,
        promptChars,
        replyChars: reply.length,
        durationMs: this.clock.nowMs() - startedAt,
        ...(usage !== undefined ? { usage } : {}),
      })
    } catch {
      // 观测面故障不挡调用
    }
  }
}

/** 回路历史的累计字符数（观测面口径：首条任务指令 + 各轮工具结果）。 */
function promptCharsOf(turns: LlmLoopTurn[]): number {
  return turns.reduce((n, t) => n + t.text.length, 0)
}

/** 工具失败的**摘要**（`agent.tool.fail` 的 error 字段）：首行 + 上界。全文仍在 trajectory、
 * 生成语料与模型下一轮可见的回灌里——日志只做索引，不复述（ADR-0080「不落原文」）。 */
const TOOL_FAIL_SUMMARY_LIMIT = 500
function firstLineOf(text: string): string {
  const head = text.split('\n', 1)[0] ?? ''
  return head.length > TOOL_FAIL_SUMMARY_LIMIT ? `${head.slice(0, TOOL_FAIL_SUMMARY_LIMIT)}…` : head
}

/** 门错误行的统一前缀（本仓门输出的唯一错误行形态；schema 门/重放/锚保护/巩固门/闸门全用它）。 */
const GATE_ERROR_MARK = '✗'

/** 失败文本的**行指纹**（同错误熔断口径②的指纹单元，#309 缺陷④）。
 *
 * 取门错误行（`✗ ` 前缀）而不是全文或「全部行」是两处实测逼出来的：
 * ① 全文口径在事故里恒够不到阈值——四次 finish 拒绝的全文两两相同、两两不同（后两次多出
 *    一条 `ops.11.op: 非法操作 move`）；
 * ② 「全部行」口径会把**样板行**算进去（`[draft_patch] 补丁未过受理门同一套校验…` 这类包装
 *    与「合法取值域」区块），于是「连试四种不同的非法取值」也会凑够三次同样的样板行而误杀。
 * 若整段失败文本里一条门错误行都没有（裸异常那类，如 #301 的 `TypeError`），退化为整段文本
 * 一行——同一异常反复抛仍按逐字相同计数。轮内去重（一行出现两次算一次）。 */
function fingerprintLinesOf(text: string): string[] {
  const marks = [...new Set(text.split('\n').map(l => l.trim()).filter(l => l.startsWith(GATE_ERROR_MARK)))]
  return marks.length ? marks : [text.trim()]
}

/** 行指纹的键分隔符（工具与行拼键；行文本里不会出现 NUL）。 */
const LINE_SEP = '\u0000'
