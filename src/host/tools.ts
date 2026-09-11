/**
 * 宿主技术层·agent 工具面（#167 分装 / #169 注册表驱动；ADR-0045）。
 *
 * 注册循环只做一件事：遍历注册表的 agent 通道——`summary` 当 description、
 * `sdkParameters(args)` 当 parameters（**工具面 schema 与重构前逐字相同**，门⑧ 断言）、
 * execute 取生成路径（`engine` + `bind` → `run(rt, tool, async () => JSON.stringify(await engine(…)))`）
 * 或例外 handler（见 `tool-handlers.ts`：形状要加工／实参要换算／无单一入口，
 * 由门④·agent 侧断言「handler 键集合 == 没有 bind 的 agent 通道集合」）。
 *
 * 两个 `as never` 的来历与去向：旧实现把 schema 打成 `Record<string, unknown>`、execute 与返回值
 * 两次 `as never`（SDK 的 `InferArgs` 推断被主动丢掉）。schema 现在由注册表给（类型是声明的
 * `ParameterSchemaSpec`），`execute` 只剩一处 `as never`——**参数类型由 SDK 从 schema 推断**，
 * 111 个处理函数不再手写第二遍参数类型。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { COMMAND_LIST } from '../commands/index.ts'
import type { CommandSpec } from '../commands/index.ts'
import { run } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import { toolHandlers } from './tool-handlers.ts'

export const AGENT_GUIDE: Array<{ tool: string; page: string; text: string; prompt?: string }> = [
  { tool: 'learnhub_pin_today', page: 'learn', text: '「今天学它」：把节点置顶为今日推荐榜首（可挂执行意图），只影响今天、次日自动失效。',
    prompt: '用 learnhub_pin_today 把「<节点>」设为今天的学习目标' },
  { tool: 'learnhub_unpin', page: 'learn', text: '取消今天的「今天学它」置顶。', prompt: '取消「<节点>」的今日置顶' },
  { tool: 'learnhub_goal_intention', page: 'learn', text: '在今日 pin 上写/清「在【线索】之后就【行动】」的执行意图（随 pin 当日过期）。',
    prompt: '给今天「<节点>」的 pin 挂一个执行意图：晚饭后就在书桌前学完它' },
  { tool: 'learnhub_note_source_exclude', page: 'learn', text: '把个人笔记文件/目录加入排除清单（未来不再被自动注册为复习源）。',
    prompt: '把「<笔记路径>」加入笔记源排除清单' },
  { tool: 'learnhub_note_source_unexclude', page: 'learn', text: '从笔记源排除清单移除（恢复可注册资格）。',
    prompt: '把「<笔记路径>」移出笔记源排除清单' },
  { tool: 'learnhub_graph_node', page: 'graph', text: '单节点深查：前置/后继/enc 边/生成状态/健康问题一次看全。',
    prompt: '用 learnhub_graph_node 深查「<节点>」' },
  { tool: 'learnhub_graph_browse', page: 'graph', text: '按区/块浏览课程图结构。', prompt: '按区块浏览「<课程>」的图结构' },
  { tool: 'learnhub_graph_path', page: 'graph', text: '查询两节点之间的先修链（学 B 之前要过哪些节点）。',
    prompt: '查一下从「<节点A>」到「<节点B>」的先修链' },
  { tool: 'learnhub_question_audit', page: 'bank', text: '题库契约只读体检：表达式/数字填空、记法违规、转义损坏、超长解析——只盘点不修复。',
    prompt: '跑一次题库体检，把违规存量题列给我' },
  { tool: 'learnhub_question_get', page: 'bank', text: '读单题全文（含答案与解析）——改题/审题前先看原题。',
    prompt: '把「<节点>」题库里 q1 的完整题目读给我看' },
  { tool: 'learnhub_bank_cleanup', page: 'bank', text: '一键清理题库：跳过节点的全部未归档题 + 已完成节点的休眠题（从未调度），预览确认后归档（可逆，不删除）。',
    prompt: '预览一下题库清理会归档哪些题，我确认后再执行' },
  { tool: 'learnhub_content_check', page: 'generate', text: '只跑正文质检门不落盘——在 vault 手改笔记后自检违规。',
    prompt: '对「<节点>」跑一次正文质检' },
  { tool: 'learnhub_data_check', page: 'global', text: '只读数据体检：盘点注册表/图/笔记/题库的 Missing 与 Broken，不修复不写入。',
    prompt: '跑一次数据体检，告诉我有没有 Broken' },
  { tool: 'learnhub_rebuild', page: 'global', text: '重建就绪清单等派生文件（过审计门；数据文件坏了后的修复入口）。',
    prompt: '重建一遍就绪清单' },
  { tool: 'learnhub_note_resolve', page: 'global', text: '把 vault 笔记路径解析到所属课程/节点（查归属用）。',
    prompt: '「<笔记路径>」属于哪个课程节点？' },
  { tool: 'learnhub_skill_create', page: 'practice', text: '创建技能条目（乐器/运动/编程等持续技能的调度 lane 载体）。',
    prompt: '创建技能条目「<技能名>」' },
  { tool: 'learnhub_execution_log', page: 'practice', text: '记一条技能执行事件（表现评级 1-4 + 真实专注时长；入 XP 账本与 streak）。',
    prompt: '记一条执行事件：今天练了「<技能>」40 分钟，自评 3 分' },
  { tool: 'learnhub_receipt_submit', page: 'practice', text: '提交外部练习回执（描述/图片/导出皆可；AI 量表评审，零 XP、不推调度）。',
    prompt: '提交一份回执：<练习内容描述>' },
  { tool: 'learnhub_receipt_list', page: 'practice', text: '查看已提交的回执清单。', prompt: '列出我提交过的回执' },
  { tool: 'learnhub_project_milestone_pass', page: 'projects', text: '里程碑显式通过结算：按 est 定价锁定 XP（对账动作，不是删除）。',
    prompt: '「<项目>」的里程碑 m1 通过了，帮我结算' },
  { tool: 'learnhub_project_milestone_recall', page: 'projects', text: '里程碑回溯会话：过点前对关联节点抽题+自述（检索点练习）。',
    prompt: '为「<项目>」的里程碑 m1 发起回溯会话' },
  { tool: 'learnhub_project_enc_candidates', page: 'projects', text: '从项目执行行为推断成分技能边候选，生成待人审图提案（面板回填按钮走的是作答记录推断，这是项目执行流推断——两条通道）。',
    prompt: '从「<项目>」的执行记录里找成分技能边候选' },
]


/**
 * 工具面的参数投影：注册表的 `args` → SDK 的 `parameters`（**工具面逐字契约的守门**）。
 * 剥掉投递层扩展键（`read`），并把源码形态 `{k: {..., required: true}}` 归一成
 * defineTool 的注册形态 `{type: 'object', properties, required[]}`——与工具面快照逐字一致
 * （tests/commands.test.ts 的门⑧）。
 */
export function sdkParameters(args: CommandSpec['args']): Record<string, unknown> {
  const SDK_KEYS = new Set(['type', 'required', 'description', 'enum', 'items', 'additionalProperties'])
  const stripSpec = (spec: unknown): unknown => {
    if (Array.isArray(spec)) return spec.map(stripSpec)
    if (spec && typeof spec === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
        if (!SDK_KEYS.has(k)) continue
        out[k] = k === 'items' ? stripSpec(v) : v
      }
      return out
    }
    return spec
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = stripSpec(v)
  return out
}

/** 生成路径的实参：按 `bind` 顺序取同名声明的键（SDK 已按 schema 校验过必填与类型）。 */
const boundArgs = (args: Record<string, unknown>, bind: Array<string | null>): unknown[] =>
  bind.map(k => (k === null ? undefined : args[k]))

/** 注册全部 agent 工具（apply 装配步）：注册表 → defineTool，名称/描述/schema 逐字不变。 */
export function registerTools(ctx: Context, rt: HostRuntime): void {
  const textOutput = {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
  }
  const handlers = toolHandlers(rt, ctx)
  for (const c of COMMAND_LIST) {
    const channel = c.channels.find(ch => ch.channel === 'agent')
    if (!channel?.tool) continue
    const tool = channel.tool
    const engine = c.engine
    const bind = channel.bind
    const execute = bind !== undefined && engine !== undefined
      ? (args: Record<string, unknown>) => run(rt, tool, async () => JSON.stringify(await rt.engine[engine](...boundArgs(args, bind))))
      : handlers[tool]
    ctx.tools.register(defineTool({
      name: tool,
      description: c.summary!,
      parameters: sdkParameters(c.args),
      output: textOutput,
      execute: execute as never,
    }) as never)
  }
}
