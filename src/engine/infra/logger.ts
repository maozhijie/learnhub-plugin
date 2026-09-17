/**
 * 调试日志端口（#253 / ADR-0080）：端口形状住应用层、实现住适配器、装配住 `EngineConfig`。
 *
 * 引擎只发**结构化条目**（稳定事件名 + 字段面）：不拼字符串、不判级别、不 import pino、
 * 零 `node:fs`（G8 的 fsImports／fsCalls 保持 0）。行文本、级别门、按天落盘、保留期与
 * 上限全在宿主实现（`src/host/log-file.ts`）——与 `Clock`／`Rng`／`VaultFs` 三端口同纪律。
 *
 * 纯类型零导入（R5 类叶子纪律）。
 */

/** 日志级别（级别门唯一一处住在宿主实现；默认 INFO，可经宿主侧 env 调）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 字段值：标量渲染成 `k=v`；**数组渲染成缩进两格的续行**（每元素一行——用于门错误
 * 清单这类「压成单行会腰斩」的材料，且只允许事件闭集里声明的形态带续行，见 ADR-0080
 * 多行纪律）；`undefined`／`null` 整个键省略（缺值不造字段，缺 `tokens` 即此例）。
 *
 * 值只允许标量与标量数组：**不落原文**——提示词、裁决 YAML、学习笔记内容一律不进日志
 * （原文已在调用记录与 `journal.jsonl`；日志会被人 `rg` 与贴进排查对话，裹挟个人笔记
 * 有隐私面）。 */
export type LogFieldValue = string | number | boolean | null | undefined | string[]

/** 字段面：键用 snake_case（`station` 值保持中文，与现网 console 一致）。 */
export interface LogFields {
  [key: string]: LogFieldValue
}

/** 四方法端口：`event` 是稳定事件名（点分小写，闭集见 ADR-0080 表），`fields` 是字段面。
 * 四方法签名一致——调用点只声明「这是什么事件、带什么数据」，可观测性口径归宿主。 */
export interface Logger {
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** 零副作用实现：供**仓库脚本**（只消费 `lib/engine.js` 产物、不经宿主装配）与
 * 「本构造点不关心日志」的测试用。
 *
 * 定义在引擎侧而非宿主侧的理由：脚本 import 的是引擎单文件产物，`host/log-file.ts`
 * 不在其中——若只住宿主，脚本就得为此拉进整个宿主装配（ADR-0080 §修订 2026-09-15）。
 * `host/log-file.ts` 仍按 ADR 原意 re-export 它。 */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
