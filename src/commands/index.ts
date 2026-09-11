/**
 * 命令注册表·装配（#169；ADR-0045）。
 *
 * 一张表，两个适配器：agent 通道→工具面（host/tools.ts），panel 通道→路由面（host/routes*.ts）。
 * 门跑在这张装配表上（唯一性/配对/engine 存在性/阶段/指南投影）。
 */
import type { CommandSpec } from './types.ts'
import { 学习域 } from './学习.ts'
import { 图谱域 } from './图谱.ts'
import { 题库域 } from './题库.ts'
import { 项目域 } from './项目.ts'
import { 学习者产出域 } from './学习者产出.ts'
import { 实验室域 } from './实验室.ts'
import { 通道域 } from './通道.ts'
import { 维护域 } from './维护.ts'

export { command } from './types.ts'
export type { CommandSpec, ChannelSpec, ParamSpec, ParameterSchemaSpec, CommandDomain, HttpMethod } from './types.ts'

/** 全量命令（唯一性/配对的门面）。 */
export const COMMANDS: readonly CommandSpec[] = [
  ...学习域,
  ...图谱域,
  ...题库域,
  ...项目域,
  ...学习者产出域,
  ...实验室域,
  ...通道域,
  ...维护域,
]

/** 按工具名索引（agent 通道）。 */
export const BY_TOOL: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.flatMap(c => c.channels.filter(x => x.tool).map(x => [x.tool!, c] as const)),
)

/** 按 `${method} ${path}` 索引（panel 通道，含前缀项）。 */
export const BY_ROUTE: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.flatMap(c => c.channels.filter(x => x.route).map(x => [`${x.route!.method} ${x.route!.path}`, c] as const)),
)
