/**
 * YAML 统一出口：全引擎唯一从 `yaml` 包取数的地方。
 *
 * dump 固定 allowUnicode / 不排序键 / 宽 120 列（与旧引擎 Python yaml.safe_dump
 * allow_unicode=True, sort_keys=False, width=120 的产出对齐，图文件 diff 友好）。
 */
import { parse, stringify } from 'yaml'
import { stripHtmlComments } from './html-comments.ts'

/** 模型 YAML 解析失败的人话化：稳定码 MODEL_YAML + 中文语境前缀，原始定位与消息
 * 保留——失败横幅与修复轮回灌直接消费这段文本，宿主大纲站按 code 识别解析类失败
 * 接修复轮（与 OUTLINE_BUDGET/OUTLINE_SHAPE 同一分流）。 */
function modelYamlError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const e = new Error(`模型输出不是合法 YAML：${raw}`)
  ;(e as Error & { code?: string }).code = 'MODEL_YAML'
  return e
}

export const YAML = {
  parse: (text: string): unknown => parse(text),
  /** 模型/agent 输出解析入口：先剥掉可能包裹整段输出的 markdown 代码围栏（```yaml 等
   * 任意语言标记）再 parse——提示词虽要求「不要围栏」，但高频违反，解析边界统一容忍；
   * 围栏未闭合时剥掉首行围栏后照常 parse，让后续 schema 校验给出可读错误。
   * 忠实 parse 失败后再剥一遍 HTML 注释重试（onTolerated 留痕给调用方写 journal）：
   * 正文管线的机器块契约（enc_candidates 等）经上下文包与 vault 摘录持续示范给模型，
   * 会串味进 YAML 输出（CONTEXT.md「机器块」词条的契约边界）——注释对 YAML 永远是
   * 噪音，但剥除只在忠实解析已败时发生，合法输出零影响。
   * 盘上手写文件（注册表/题库/图数据/笔记）不是模型输出，仍用 parse。 */
  parseModel: (text: string, opts?: { onTolerated?: (note: string) => void }): unknown => {
    const lines = text.trim().split('\n')
    if (lines[0]?.startsWith('```')) lines.shift()
    if (lines.length > 0 && lines[lines.length - 1].trimEnd() === '```') lines.pop()
    const src = lines.join('\n').trim()
    try {
      return parse(src)
    } catch (err) {
      const stripped = stripHtmlComments(src)
      if (stripped !== src) {
        try {
          const doc = parse(stripped)
          opts?.onTolerated?.('模型输出串入机器块，已剥除后解析')
          return doc
        } catch {
          // 剥注释救不回：按原始错误报（人话化），不给二次错误添乱
        }
      }
      throw modelYamlError(err)
    }
  },
  stringify: (value: unknown): string =>
    stringify(value, { aliasDuplicateObjects: false, lineWidth: 120 }),
}
