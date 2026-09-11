/**
 * 命令注册表·装配（#169；ADR-0045）。
 *
 * 一张表，两个适配器：agent 通道→工具面（host/tools.ts + host/tool-handlers.ts），
 * panel 通道→路由面（host/api.ts + host/handlers.ts）。门跑在这张装配表上
 * （唯一性/配对/engine 存在性/阶段/指南投影/声明与面一致）。
 *
 * **表是「按 id 键的对象」而不是数组**：#169 把它当成类型可见形状用——`CommandId` /
 * `CommandOutput<id>` 让 UI 的 111 个端点从 `output` 派生响应类型（ADR-0045 裁定 7），
 * 数组形状做不到这件事（类型层按 id 取不到单条声明）。运行时的遍历面另给 `COMMAND_LIST`。
 */
import { 学习域 } from './学习.ts'
import { 图谱域 } from './图谱.ts'
import { 题库域 } from './题库.ts'
import { 项目域 } from './项目.ts'
import { 学习者产出域 } from './学习者产出.ts'
import { 实验室域 } from './实验室.ts'
import { 通道域 } from './通道.ts'
import { 维护域 } from './维护.ts'
import type { CommandSpec } from './types.ts'

export { command } from './types.ts'
export type { CommandSpec, ChannelSpec, ParamSpec, ParameterSchemaSpec, CommandDomain, HttpMethod } from './types.ts'

/** 全量命令表（键 = 命令 id；装配是单点，唯一性由此可断言）。 */
export const COMMANDS = {
  ...学习域,
  ...图谱域,
  ...题库域,
  ...项目域,
  ...学习者产出域,
  ...实验室域,
  ...通道域,
  ...维护域,
}

/** 各域文件的条数（装配自检用：跨文件重名会让 Object.keys 少于各域之和）。 */
export const DOMAIN_SIZES: Record<string, number> = {
  学习: Object.keys(学习域).length, 图谱: Object.keys(图谱域).length,
  题库: Object.keys(题库域).length, 项目: Object.keys(项目域).length,
  学习者产出: Object.keys(学习者产出域).length, 实验室: Object.keys(实验室域).length,
  通道: Object.keys(通道域).length, 维护: Object.keys(维护域).length,
}

/** 运行时的遍历面（门与两个适配器用它；顺序＝域文件顺序）。 */
export const COMMAND_LIST: readonly CommandSpec[] = Object.values(COMMANDS)

/** 命令 id 的联合类型（UI 按它取输出类型）。 */
export type CommandId = keyof typeof COMMANDS

/** 命令的响应类型 = 该命令 `output` 的派生（引擎入口的返回类型；留空者 unknown）。 */
export type CommandOutput<K extends CommandId> = NonNullable<(typeof COMMANDS)[K]['output']>

/** 按工具名索引（agent 通道）。 */
export const BY_TOOL: ReadonlyMap<string, CommandSpec> = new Map(
  COMMAND_LIST.flatMap(c => c.channels.filter(x => x.tool).map(x => [x.tool!, c] as const)),
)

/** 按 `${method} ${path}` 索引（panel 通道，含前缀项）。 */
export const BY_ROUTE: ReadonlyMap<string, CommandSpec> = new Map(
  COMMAND_LIST.flatMap(c => c.channels.filter(x => x.route).map(x => [`${x.route!.method} ${x.route!.path}`, c] as const)),
)
