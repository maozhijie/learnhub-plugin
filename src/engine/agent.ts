/**
 * 统一 agent 缝（ADR-0041 形状 / ADR-0044 归属；#162 落地）：引擎与 LLM 交互的
 * 唯一调用面，接口按业务事实分双模式——`complete()` 单发直返 + `agentLoop()` 有界
 * 只读工具回路。
 *
 * 归属（ADR-0044）：本文件是应用层的端口消费者——端口住应用层（`engine/llm.ts` 的
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
 * 回路预算（ADR-0041）：K≤6 次工具轮（`agentLoop` 强制，不设调用方覆盖）+ 1 次门错
 * 修复轮（`gateRepairRound` 强制）；回路只在生成队列任务内运行，工具实现禁止递归
 * 入队/触发教练。宿主会话适配位（后路）：教练未来需要全 agent 面（查 vault 笔记、
 * 查网）时，把注入的 LlmStream 换成 `ctx.agents.create` 的会话适配实现——调用点
 * 零改动。
 */
import type { LlmComplete, LlmEffort, LlmLoopTurn, LlmStream, LlmToolCall, LlmToolSpec } from './llm.ts'

/** 剥掉模型可能包住的整段 markdown 代码围栏：限 markdown/yaml/json 等数据类标签——
 * 正文类标签（svg/plot 等）本身是内容的一部分，剥掉会毁掉 ```svg/```plot 引用块。
 * （自 host/runtime.ts 随缝归位：这是补全结果的适配器后处理，不再散在投递层。） */
export function stripFences(body: string): string {
  const m = body.match(/^```(?:markdown|md|yaml|yml|json)?\s*\n([\s\S]*?)\n```\s*$/)
  return m ? m[1] : body
}

/** 工具轮预算上限（ADR-0041 K≤6）：回路第 K 轮后仍请求工具即中止；不设调用方覆盖。 */
export const AGENT_LOOP_MAX_TOOL_ROUNDS = 6

/** 调用模式（观测面词汇）：complete 单发 / repair 门错修复轮 / loop 工具回路轮。 */
export type AgentCallMode = 'complete' | 'repair' | 'loop'

/** 一次底层 LLM 调用的观测记录（注入侧可观测：宿主接运行日志/console）。 */
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
}

/** 缝的端口注入：complete 必带；stream 只在 agentLoop 消费；onCall 是观测面。 */
export interface AgentSeamPorts {
  complete: LlmComplete
  stream?: LlmStream
  onCall?: (record: AgentCallRecord) => void
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
  constructor(private readonly ports: AgentSeamPorts) {}

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
   * 重裁恒 deep 档）。过门的受理产物经 `result` 交还（受理式门：类型上过门必有产物）。 */
  async gateRepairRound<T, U>(station: string, spec: GateRepairSpec<T, U>): Promise<{ candidate: T; result: U; repaired: boolean }> {
    const candidate = await spec.first()
    const firstGate = await spec.gate(candidate)
    if (!firstGate.errors.length) return { candidate, result: firstGate.result as U, repaired: false }
    let repairedCandidate: T
    try {
      repairedCandidate = await spec.repair(firstGate.errors, candidate)
    } catch (err) {
      throw spec.fatal(firstGate.errors, [err instanceof Error ? err.message : String(err)])
    }
    const repairGate = await spec.gate(repairedCandidate)
    if (repairGate.errors.length) throw spec.fatal(firstGate.errors, repairGate.errors)
    return { candidate: repairedCandidate, result: repairGate.result as U, repaired: true }
  }

  /** 工具回路模式（有界多轮迭代 + 只读工具调用）：模型每轮可请求白名单内工具，
   * 缝执行 runTool 并把结果回灌继续；模型不再请求工具即以文本产出收束（剥围栏）。
   * K≤`AGENT_LOOP_MAX_TOOL_ROUNDS` 轮后仍请求工具即 fail loud——预算封顶防自激循环。
   * trajectory 逐轮记录工具调用与结果摘要（#163 任务消息消费）。 */
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
  }): Promise<{ text: string; toolRounds: number; trajectory: string[] }> {
    if (!this.ports.stream) {
      throw new Error(`[agent-seam] 「${req.station}」需要工具回路，但注入侧未提供 LlmStream 端口（宿主适配器缺位）。`)
    }
    const turns: LlmLoopTurn[] = [{ role: 'user', text: req.prompt }]
    const trajectory: string[] = []
    let toolRounds = 0
    for (;;) {
      const startedAt = Date.now()
      const r = await this.ports.stream({
        messages: turns,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
        tools: req.tools,
      })
      this.emit(req.station, 'loop', req.effort, promptCharsOf(turns), r.text, startedAt)
      const calls = r.toolCalls ?? []
      if (!calls.length) {
        return { text: stripFences(r.text), toolRounds, trajectory }
      }
      if (toolRounds >= AGENT_LOOP_MAX_TOOL_ROUNDS) {
        throw new Error(`[agent-seam] 「${req.station}」工具回路预算耗尽（K≤${AGENT_LOOP_MAX_TOOL_ROUNDS} 轮后仍在请求工具）——回路中止。`)
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
        }
        trajectory.push(`${call.name}(${call.arguments.length} 字符参数) → ${out.length} 字符${isError ? '（失败）' : ''}`)
        turns.push({ role: 'tool', callId: call.id, text: out, ...(isError ? { isError: true } : {}) })
      }
    }
  }

  /** 底层调用的共用传输：端口调用 + 观测记录。 */
  private async call(station: string, mode: AgentCallMode, prompt: string, opts?: { system?: string; effort?: LlmEffort }): Promise<string> {
    const startedAt = Date.now()
    const raw = await this.ports.complete(
      prompt,
      opts?.system,
      opts?.effort === undefined ? undefined : { effort: opts.effort },
    )
    this.emit(station, mode, opts?.effort, prompt.length, raw, startedAt)
    return stripFences(raw)
  }

  /** 观测面：记录产出后回放 onCall；观测面故障不挡调用。 */
  private emit(station: string, mode: AgentCallMode, effort: LlmEffort | undefined, promptChars: number, reply: string, startedAt: number): void {
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
        durationMs: Date.now() - startedAt,
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
