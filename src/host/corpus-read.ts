/**
 * 调用记录读侧（#330 / ADR-0103 Q9「重建按调用读侧」）：从按任务成组的组文件解析出
 * 每次调用的全量视图（请求/响应 JSON、元数据、任务身份），供三条生产读侧消费
 * （冒烟站表 host/smoke、质量评审抽样 host/quality-review、提示词回放 scripts/prompt-bump）。
 * **读侧单一出处**：格式解析只住本文件——冒烟与评审各解析一遍必然分叉（ADR-0060 沿袭）。
 * 旧 `state/生成语料/` 目录冻结不迁移，其读侧（parseCorpusFrontmatter/parseCorpusFile）
 * 同住这里，corpusLayoutOf 判向；格式漂移门（行尾归一、坏行占位）在冻结读侧继续执法。
 */
import { readdirSync, readFileSync } from 'node:fs'
import type { LlmTokenUsage } from '../engine/index.ts'
import { OFFLINE_DIR, SECTION_HEAD, partNoOf } from './corpus.ts'
import type { CallRequestRecord, CallResponseRecord, CallSource } from './corpus.ts'

// ---------------------------------------------------------------- 旧格式读侧（冻结）

/** 行尾归一：文件住在用户 vault 里，Windows 侧编辑/同步/检出（git autocrlf）都会把
 * LF 变 CRLF——围栏行会成 `---\r`，按字面比对会静默失配。**读侧一律先归一**。 */
function normalizeNewlines(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/\n+$/, '\n')
}

/** 【旧格式·冻结】生成语料文件 frontmatter 解析（行级键值，只取首个 `---` 围栏内的
 * `键: 值` 行；值不做引号/类型解析）。供指向历史 `state/生成语料/` 目录的读侧使用
 * （prompt-bump 回放 / 质量评审抽样历史语料），新写入不再产此格式。 */
export function parseCorpusFrontmatter(body: string): Record<string, string> {
  const lines = normalizeNewlines(body).split('\n')
  const end = lines.indexOf('---', 1)
  const out: Record<string, string> = {}
  if (end < 0) return out
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(': ')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2)
  }
  return out
}

/** 空输出在旧格式语料里的渲染态——读侧还原为空串（「空输出」是渲染占位，不是产物
 * 内容；评审器据此判「不可评分」，见 engine isScoreable）。 */
export const EMPTY_OUTPUT_PLACEHOLDER = '（空输出）'

/** 「工具调用」段标记（#236，旧格式）：产物整个在工具调用参数里时，受评对象就是这一段。 */
export const TOOL_CALLS_MARKER = '## 工具调用'

/** 工具调用段单行解析（一行一条 JSON）。坏行不静默丢：以「（未解析）」占位保留原文，
 * 评审面照样看得见模型产出过什么——一条坏行不该让整件载荷从读侧消失。 */
function parseToolCallLine(line: string): { name: string; arguments: string } | null {
  const t = line.trim()
  if (!t) return null
  try {
    const v = JSON.parse(t) as { name?: unknown; arguments?: unknown } | null
    if (v && typeof v === 'object' && typeof v.name === 'string') {
      return { name: v.name, arguments: typeof v.arguments === 'string' ? v.arguments : JSON.stringify(v.arguments ?? '') }
    }
  } catch { /* 落回原文占位 */ }
  return { name: '（未解析）', arguments: t }
}

/** 【旧格式·冻结】生成语料文件全文解析：frontmatter + `## 提示词` 段 + `## 原始输出` 段。
 * 供指向历史 `state/生成语料/` 目录的读侧使用；新写入只走组文件形态（ADR-0103）。 */
export function parseCorpusFile(body: string): {
  frontmatter: Record<string, string>
  prompt: string
  output: string
  /** 工具调用载荷（#236；段缺席 = 空数组——旧语料不加段也照样读得出）。 */
  toolCalls: Array<{ name: string; arguments: string }>
} {
  const frontmatter = parseCorpusFrontmatter(body)
  const lines = normalizeNewlines(body).split('\n')
  const start = (marker: string): number => lines.findIndex(l => l.trim() === marker)
  const promptAt = start('## 提示词')
  const outputAt = start('## 原始输出')
  const toolCallsAt = start(TOOL_CALLS_MARKER)
  const endOf = (from: number): number | undefined => {
    const next = [outputAt, toolCallsAt].filter(i => i > from)
    return next.length ? Math.min(...next) : undefined
  }
  const prompt = promptAt >= 0 ? lines.slice(promptAt + 1, endOf(promptAt)).join('\n') : ''
  const raw = outputAt >= 0 ? lines.slice(outputAt + 1, endOf(outputAt)).join('\n') : ''
  const output = raw.trim() === EMPTY_OUTPUT_PLACEHOLDER ? '' : raw
  const toolCalls = toolCallsAt >= 0
    ? lines.slice(toolCallsAt + 1).map(parseToolCallLine).filter((c): c is { name: string; arguments: string } => c !== null)
    : []
  return {
    frontmatter,
    prompt: prompt.replace(/^\n+|\n+$/g, ''),
    output: output.replace(/^\n+|\n+$/g, ''),
    toolCalls,
  }
}

/** 按调用读侧的一条记录：从组文件解析出的一次调用尝试的全量视图
 * （= ParsedCallRecord + 目录定位面 ref/course/node）。 */
export type CallRecordView = ParsedCallRecord & {
  /** 相对引用 `<课程>/<节点>#<序号>` 或 `_离线/<站>#<序号>`（label 取自目录/文件名）。 */
  ref: string
  course?: string
  node?: string
}

/** 解析出的一次调用（组内 label 由调用方按文件路径补成 ref）。 */
export interface ParsedCallRecord {
  seq: number
  station: string
  source?: CallSource
  kind: string
  attempt: number
  outcome: 'ok' | 'tolerated' | 'failed'
  code?: string
  truncated: boolean
  durationMs: number
  model: string
  provider: string
  ts: string
  effort?: string
  usage?: LlmTokenUsage
  request: CallRequestRecord
  response: CallResponseRecord
  prompt: string
  output: string
  toolCalls: Array<{ name: string; arguments: string }>
}

/** token 元数据行的回读（读侧 usage 兜底；响应 JSON 在场时不走这里）。 */
function parseUsageLine(line: string | undefined): LlmTokenUsage | undefined {
  const m = /入 (\d+)\/出 (\d+)/.exec(line ?? '')
  if (!m || !line) return undefined
  const grab = (label: string): number | undefined => {
    const r = new RegExp(`${label} (\\d+)`).exec(line)
    return r ? Number(r[1]) : undefined
  }
  const usage: LlmTokenUsage = { inputTokens: Number(m[1]), outputTokens: Number(m[2]) }
  const reasoning = grab('推理')
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  const cacheRead = grab('缓存读')
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  const cacheWrite = /\/写 (\d+)/.exec(line)
  if (cacheWrite) usage.cacheWriteTokens = Number(cacheWrite[1])
  const total = grab('总')
  if (total !== undefined) usage.totalTokens = total
  return usage
}

/** 从节内的 ```json 围栏取原文块。 */
function fencedJsonAfter(lines: string[], marker: string): unknown | undefined {
  const at = lines.findIndex(l => l.trim() === marker)
  if (at < 0) return undefined
  const open = lines.findIndex((l, i) => i > at && l.trim() === '```json')
  if (open < 0) return undefined
  const close = lines.findIndex((l, i) => i > open && l.trim() === '```')
  if (close < 0) return undefined
  try {
    return JSON.parse(lines.slice(open + 1, close).join('\n'))
  } catch {
    return undefined
  }
}

/** 组文件（一个分卷）全文解析：文件头（任务/分卷/更新 + TOC）+ 每调用一节。
 * 非本格式文件（无节或缺 JSON 块）返回空数组——调用方按空跳过，不猜内容。 */
export function parseCallRecordFile(body: string): ParsedCallRecord[] {
  const lines = normalizeNewlines(body).split('\n')
  const calls: ParsedCallRecord[] = []
  const starts: Array<{ seq: number; station: string; source: string; at: number }> = []
  for (const [i, line] of lines.entries()) {
    const m = SECTION_HEAD.exec(line)
    if (m) starts.push({ seq: Number(m[1]), station: m[2], source: m[3], at: i })
  }
  for (const [idx, s] of starts.entries()) {
    const end = idx + 1 < starts.length ? starts[idx + 1].at : lines.length
    const seg = lines.slice(s.at, end)
    const meta: Record<string, string> = {}
    for (const line of seg) {
      const m = /^- ([^:]+): (.*)$/.exec(line)
      if (m) meta[m[1].trim()] = m[2]
    }
    const request = fencedJsonAfter(seg, '### 请求') as CallRequestRecord | undefined
    const response = fencedJsonAfter(seg, '### 响应') as CallResponseRecord | undefined
    if (!request || !response) continue // 缺 JSON 块 = 非本格式/损坏件：跳过不猜
    const modelMatch = /^(.*)（([^）]*)）$/.exec(meta['模型'] ?? '')
    const usage = response.usage ?? parseUsageLine(meta['token'])
    calls.push({
      seq: s.seq,
      station: s.station,
      source: s.source as CallSource,
      kind: meta['阶段'] ?? 'complete',
      ...(meta['档位'] !== undefined && meta['档位'] !== '默认' ? { effort: meta['档位'] } : {}),
      attempt: Number(meta['尝试'] ?? 1) || 1,
      outcome: meta['结果'] === 'failed' || meta['结果'] === 'tolerated' ? meta['结果'] as 'failed' | 'tolerated' : 'ok',
      ...(meta['失败码'] !== undefined ? { code: meta['失败码'] } : {}),
      truncated: meta['截断'] === 'true',
      durationMs: Number((meta['耗时'] ?? '0').replace(/ms$/, '')) || 0,
      ...(modelMatch ? { model: modelMatch[1].trim(), provider: modelMatch[2] } : { model: meta['模型'] ?? '', provider: '' }),
      ts: meta['时间'] ?? '',
      ...(usage ? { usage } : {}),
      request,
      response,
      prompt: request.messages.map(m => m.text).join('\n\n'),
      output: response.text ?? '',
      toolCalls: (response.toolCalls ?? []).map(c => ({ name: c.name, arguments: c.arguments })),
    })
  }
  return calls
}

/** 读调用记录目录：`<dir>/<课程>/<节点>*.md` ∪ `<dir>/_离线/<站>*.md`（含分卷），
 * 按 ts 稳定排序。opts.stations 过滤站（缺省全量）。**同步读**——消费方（冒烟站表、
 * 质量评审抽样、prompt-bump 回放）都是同步读盘段。非本格式文件跳过——历史
 * `state/生成语料/` 目录请走 parseCorpusFile 旧读侧（corpusLayoutOf 可判向）。 */
export function readCallRecords(dir: string, opts: { stations?: readonly string[] } = {}): CallRecordView[] {
  const out: CallRecordView[] = []
  let dirs: string[]
  try {
    dirs = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }
  for (const d of dirs) {
    let files: string[]
    try {
      files = readdirSync(`${dir}/${d}`)
    } catch {
      continue
    }
    const stems = [...new Set(files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '').replace(/\.part\d+$/, '')))]
    for (const base of stems) {
      const parts = files.filter(f => partNoOf(f, base) > 0).sort((a, b) => partNoOf(a, base) - partNoOf(b, base))
      for (const f of parts) {
        let body = ''
        try {
          body = readFileSync(`${dir}/${d}/${f}`, 'utf8')
        } catch {
          continue
        }
        for (const call of parseCallRecordFile(body)) {
          if (opts.stations?.length && !opts.stations.includes(call.station)) continue
          const keyed = d !== OFFLINE_DIR
          out.push({
            ...call,
            ref: `${d}/${base}#${call.seq}`,
            ...(keyed ? { course: d, node: base } : {}),
          })
        }
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts) || a.ref.localeCompare(b.ref))
}

/** 目录形态判向：新组文件（调用记录）/ 旧站目录（生成语料，冻结）/ 空或不存在。
 * 读侧消费方（质量评审、prompt-bump 回放）据此选读侧。判据：新组文件以 `# 调用记录`
 * 标题起头，旧语料以 frontmatter `---` 起头（文件名前缀 ok-/bad- 只是辅助特征——
 * 历史回放/夹具的旧格式件不必然带桶前缀）。 */
export function corpusLayoutOf(dir: string): '调用记录' | '生成语料' | '空' {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return '空'
  }
  if (entries.includes(OFFLINE_DIR)) return '调用记录'
  for (const e of entries) {
    let files: string[]
    try {
      files = readdirSync(`${dir}/${e}`).filter(f => f.endsWith('.md'))
    } catch {
      continue // 非目录
    }
    const sample = files[0]
    if (!sample) continue
    const head = readFileSync(`${dir}/${e}/${sample}`, 'utf8').slice(0, 64).replace(/^\uFEFF/, '')
    if (head.startsWith('# 调用记录 ')) return '调用记录'
    if (head.startsWith('---') || /^(?:ok|bad)-/.test(sample)) return '生成语料'
  }
  return '空'
}
