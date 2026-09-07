/**
 * YAML 统一出口：全引擎唯一从 `yaml` 包取数的地方。
 *
 * dump 固定 allowUnicode / 不排序键 / 宽 120 列（与旧引擎 Python yaml.safe_dump
 * allow_unicode=True, sort_keys=False, width=120 的产出对齐，图文件 diff 友好）。
 */
import { parse, stringify } from 'yaml'

export const YAML = {
  parse: (text: string): unknown => parse(text),
  /** 模型/agent 输出解析入口：先剥掉可能包裹整段输出的 markdown 代码围栏（```yaml 等
   * 任意语言标记）再 parse——提示词虽要求「不要围栏」，但高频违反，解析边界统一容忍；
   * 围栏未闭合时剥掉首行围栏后照常 parse，让后续 schema 校验给出可读错误。
   * 盘上手写文件（注册表/题库/图数据/笔记）不是模型输出，仍用 parse。 */
  parseModel: (text: string): unknown => {
    const lines = text.trim().split('\n')
    if (lines[0]?.startsWith('```')) lines.shift()
    if (lines.length > 0 && lines[lines.length - 1].trimEnd() === '```') lines.pop()
    return parse(lines.join('\n').trim())
  },
  stringify: (value: unknown): string =>
    stringify(value, { aliasDuplicateObjects: false, lineWidth: 120 }),
}
