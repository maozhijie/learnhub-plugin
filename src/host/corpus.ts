/**
 * 生成语料捕获器（#213 / ADR-0060）：宿主 LLM 适配器（host/llm.ts）缝合点出口的
 * 全量调用落盘——解析器回归 fixture 源、质量评审抽样池、模型/供应商更换时的格式
 * 漂移体检标本（CONTEXT.md「生成语料」词条的落地件）。
 *
 * - 目录：`<学习中心>/state/生成语料/<站>/`，一调用一文件：frontmatter（ts/站/kind/
 *   档/outcome/失败码/截断/耗时/usage/模型）+ 渲染后提示词 + 原始输出。
 * - 三态 outcome：ok=调用成功；failed=调用级失败（流稳定错误码/空闲超时/空输出，
 *   适配器当场标）或解析级失败（宿主 catch 点经 annotateLast 补标）；tolerated=
 *   解析容忍命中（大纲/拆节站经 outlineApply/splitApply 的 tolerated 返回通道补标）。
 *   补标同时把文件在 ok/bad 两桶间迁名，保证桶前缀与 outcome 恒一致。
 * - 工具调用段（#236）：一条调用的实质产物可能整个在工具调用参数里（文本为空、工具调用
 *   在场）——`## 工具调用` 段逐条落 `{name, arguments}`，arguments 与「原始输出」同级
 *   原文留档（不清洗、不截断）。
 * - 环形：失败与容忍必存但封顶（bad 桶 200/站），成功环形 25/站（ok 桶）——桶编码
 *   进文件名前缀（ok-/bad-，余段=ISO 时间戳+站内序号），修剪是纯目录操作零内容读。
 * - 写盘异步 fire-and-forget、故障静默（观测面纪律：语料故障不挡生成主流程）；
 *   lastRef 登记同步（宿主失败处理取引用不依赖写盘完成）。flush() 是测试缝。
 * - G9 裁决（ADR-0060）：语料写入是单文件遥测写、无跨文件一致性——不入
 *   runWriteUnit 站点表、不写 journal（journal 只记领域事实，不记观测面）。
 * - 站名是受控词表（PROMPT_KINDS ∪ AgentSeam 六站，无斜杠），ref 的 split('/') 依赖它。
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { QUIZ_SOLVER_STATION, QUALITY_REVIEW_STATION } from '../engine/index.ts'
import { COACH_PLAN_STATION, GROWTH_DRAFT_STATION } from '../engine/index.ts'
import type { LlmTokenUsage } from '../engine/index.ts'

/** 成功样本环形封顶（每站）。 */
export const CORPUS_KEEP_OK = 25
/** 失败·容忍样本环形封顶（每站；必存桶的上界，防无界增长）。 */
export const CORPUS_KEEP_BAD = 200

/** 缝合点出口的一条捕获记录（适配器组装，捕获器落盘）。 */
export interface CorpusRecordInput {
  ts: string
  station: string
  /** 调用形态：complete 单发 / repair 门错修复轮 / loop 工具回路轮（对齐 AgentCallMode）。 */
  kind: 'complete' | 'repair' | 'loop'
  /** 语义档；缺省 = 部署默认档（frontmatter 记「默认」）。 */
  effort?: 'fast' | 'deep'
  outcome: 'ok' | 'tolerated' | 'failed'
  /** 失败码（failed 捕获级失败码或解析级补标码）。 */
  code?: string
  truncated?: boolean
  durationMs: number
  usage?: LlmTokenUsage
  provider: string
  model: string
  prompt: string
  output: string
  /** 模型请求的工具调用（#236）：以工具调用承载实质产物的站（教练回合裁决 op、罗盘
   *  画线、判卷之外的回路站）文本常为空——产物就在 arguments 原文里，不落档即空壳。 */
  toolCalls?: Array<{ name: string; arguments: string }>
}

/** 补标补丁：改判 outcome（+失败码）。 */
export interface CorpusPatch {
  outcome: 'ok' | 'tolerated' | 'failed'
  code?: string
}

export interface CorpusCapture {
  /** 捕获一次调用：同步登记 lastRef，异步落盘 + 环形修剪。 */
  record(input: CorpusRecordInput): void
  /** 按相对 ref（`<站>/<文件名>`）补标；文件已滚出/已迁名时静默跳过。 */
  annotate(ref: string, patch: CorpusPatch): void
  /** 按站补标最近一条捕获，返回迁移后的新 ref（无捕获 = undefined）。
   * `since` = 调用方在本轮开始前取的 `lastRef` 令牌（#313 B7）：相等即「本轮对该站零捕获」
   * ——此时「最近一条」是上一轮甚至上一个会话的件，补标会把它改名 `bad-`（bad 桶被污染
   * = 质量评审抽样失真，失败详情里那句「语料 …/<件>」也指向成功件）。非模型失败
   * （取消 / 轮次预算耗尽 / 熔断前零调用 / 空手结束）正是这种形态。省略 = 照旧补标。 */
  annotateLast(station: string, patch: CorpusPatch, opts?: { since?: string }): string | undefined
  /** 该站最近一条捕获的相对 ref（供生成任务失败详情引用 + 失败补标的在场证明）。 */
  lastRef(station: string): string | undefined
  /** 等待全部在飞写盘完成（测试缝；生产不调）。 */
  flush(): Promise<void>
}

/** 语料站名词表（#213 受控词表单一出处，ADR-0060）：PROMPT_KINDS 生成站 ∪ 判卷/讲解
 * 等交互站 ∪ AgentSeam 六策略站 ∪ 出题第二意见解题站（#223）。接线处（缝工厂参/管线
 * opts/补标映射）一律引用本表，站内对齐（调用点站名 ↔ annotateLast 站名）靠共享常量
 * 而非字面相等；quizSolver 引门面常量（引擎侧单一出处，R1 走门面）。 */
export const STATIONS = {
  outline: '课程大纲',
  section: '课程节生成',
  split: '课程节拆分',
  quiz: '题目生成',
  quizSolver: QUIZ_SOLVER_STATION,
  noteQuiz: '笔记出题',
  errorCards: '错误对比卡',
  receipt: '回执评审',
  judge: '判卷',
  dispute: '申诉判卷',
  /** 离线评审器的判定应答（#222 / ADR-0070）：评审调用本身进语料——评审器也要能被评
   * （判读稳定性/引文是否实，见评审报告），且它是「换模型/换供应商」时最该先看的标本。 */
  qualityReview: QUALITY_REVIEW_STATION,
  explainFeedback: '讲解反馈',
  selfNote: '自注反馈',
  tutor: '老师辅导',
  explainBack: '讲给我听',
  /** 生长两站的站标签（#271/#273 拆分 / ADR-0088）：思路官与执行官各一站，都引引擎侧
   * 常量对齐（站名对齐靠常量不靠字面）。#301 清理了拆分前的单站遗留名 `growth`——那张
   * 写死的映射把执行官站的失败补标到思路官站（详见 host/jobs 的失败补标处）。 */
  growthPlan: COACH_PLAN_STATION,
  growthDraft: GROWTH_DRAFT_STATION,
  compass: '罗盘',
  decompile: '目标反编译',
  plan: '计划草案',
  milestone: '里程碑草案',
} as const

/** 行尾归一：语料文件住在用户 vault 里，Windows 侧编辑/同步/检出（git autocrlf）都会把
 * LF 变 CRLF——围栏行会成 `---\r`，按字面比 `---` 的解析会静默失去整个 frontmatter
 * （outcome 退回缺省 ok、站表恒空）。**读侧一律先归一**（code-review 后的合入验证抓出：
 * 夹具在 Windows 检出后与工作区内的 LF 版本解析结果不同）。 */
function normalizeNewlines(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/\n+$/, '\n')
}

/** 语料文件 frontmatter 解析（行级键值，只取首个 `---` 围栏内的 `键: 值` 行；值不做引号/
 * 类型解析，嵌套流式值原样保留）。读侧单一出处：冒烟汇总（host/smoke）与质量评审抽样
 * （host/quality-review）同用——格式漂移只可能漂一处，两处各解析一遍必然分叉。 */
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

/** 空输出在语料里的渲染态（renderMd 的占位串）——读侧还原为空串（「空输出」是渲染占位，
 * 不是产物内容；评审器据此判「不可评分」，见 engine isScoreable）。 */
export const EMPTY_OUTPUT_PLACEHOLDER = '（空输出）'

/** 「工具调用」段标记（#236）：产物整个在工具调用参数里时，受评对象就是这一段——
 * 读侧与质量评审的合并视图（引擎 artifactTextOf）都按它取载荷。 */
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

/** 语料文件全文解析：frontmatter + `## 提示词` 段 + `## 原始输出` 段。**提示词与原始输出
 * 的原文原样返回**（质量评审的一期受评对象就是原始输出原文、二期对账材料是提示词原文；
 * 任何清洗都会让「证据引用可否定位」的核对失真）。段标记缺席（非本格式文件）时对应段返回
 * 空串——调用方按空串走「不可评/材料缺席」，不猜内容。 */
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
  // 段界 = 该段起点之后的最近一个段标记（新增的「工具调用」段必须在切分里算数：
  // 否则它会整个被「原始输出」吞掉，工具调用载荷静默变成产物文本的一部分）
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

export function createCorpusCapture(corpusDir: string): CorpusCapture {
  const root = corpusDir.replace(/[/\\]+$/, '')
  const lastByName = new Map<string, string>()
  const seqByStation = new Map<string, number>()
  const inflight = new Set<Promise<unknown>>()
  /** 站内写链串行：record 落盘完成前，同站 annotate 必须等在链尾——否则补标会在
   * 文件写完前读取而静默丢失（宿主真实形态就是 record 后立刻 annotateLast）。 */
  const chains = new Map<string, Promise<unknown>>()
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    return p.finally(() => { inflight.delete(p) })
  }
  /** 把落盘动作挂到该站的串行链尾（链上前一步失败不阻断后续，动作自身吞错）。 */
  const enqueue = <T>(station: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(station) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    chains.set(station, next)
    return track(next)
  }
  const stationOf = (ref: string): string => ref.split('/').slice(0, -1).join('/')

  /** frontmatter 行级补丁：替换 outcome 行（新 code 随行插入、旧 code 行删除）。
   * 只处理首个 --- 围栏内，正文原样。 */
  function applyPatch(body: string, patch: CorpusPatch): string {
    const lines = body.split('\n')
    const end = lines.indexOf('---', 1)
    if (end < 0) return body
    const out: string[] = []
    for (const [i, line] of lines.entries()) {
      if (i > 0 && i < end && line.startsWith('outcome: ')) {
        out.push(`outcome: ${patch.outcome}`)
        if (patch.code !== undefined) out.push(`code: ${patch.code}`)
        continue
      }
      if (i > 0 && i < end && line.startsWith('code: ')) continue
      out.push(line)
    }
    return out.join('\n')
  }

  function renderMd(input: CorpusRecordInput): string {
    const usage = input.usage
      ? `usage: { input_tokens: ${input.usage.inputTokens}, output_tokens: ${input.usage.outputTokens}`
        + `${input.usage.reasoningTokens !== undefined ? `, reasoning_tokens: ${input.usage.reasoningTokens}` : ''} }`
      : undefined
    return [
      '---',
      `ts: ${input.ts}`,
      `station: ${input.station}`,
      `kind: ${input.kind}`,
      `effort: ${input.effort ?? '默认'}`,
      `outcome: ${input.outcome}`,
      ...(input.code !== undefined ? [`code: ${input.code}`] : []),
      `truncated: ${input.truncated === true}`,
      `duration_ms: ${input.durationMs}`,
      ...(usage ? [usage] : []),
      `provider: ${input.provider}`,
      `model: ${input.model}`,
      `prompt_chars: ${input.prompt.length}`,
      `reply_chars: ${input.output.length}`,
      '---',
      '',
      '## 提示词',
      '',
      input.prompt,
      '',
      '## 原始输出',
      '',
      input.output || '（空输出）',
      '',
      // 工具调用段只在有载荷时出现（#236）：无调用的站文件形态与 #213 逐字一致，
      // 读侧「段缺席 = 空数组」承接旧语料
      ...(input.toolCalls?.length
        ? [TOOL_CALLS_MARKER, '', ...input.toolCalls.map(c => JSON.stringify({ name: c.name, arguments: c.arguments })), '']
        : []),
    ].join('\n')
  }

  /** 站目录环形修剪：按桶前缀分组、文件名升序（时间序）删最旧。 */
  async function prune(station: string): Promise<void> {
    let files: string[]
    try {
      files = await readdir(`${root}/${station}`)
    } catch {
      return
    }
    for (const [prefix, cap] of [['ok-', CORPUS_KEEP_OK], ['bad-', CORPUS_KEEP_BAD]] as const) {
      const bucket = files.filter(f => f.startsWith(prefix) && f.endsWith('.md')).sort()
      for (const f of bucket.slice(0, Math.max(0, bucket.length - cap))) {
        await unlink(`${root}/${station}/${f}`).catch(() => undefined)
      }
    }
  }

  /** tmp + rename 原子写（与 engine atomicWrite 同语义；host 侧直用 node:fs）。 */
  async function atomicPut(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  }

  return {
    record(input: CorpusRecordInput): void {
      const seq = (seqByStation.get(input.station) ?? 0) + 1
      seqByStation.set(input.station, seq)
      const bucket = input.outcome === 'ok' ? 'ok' : 'bad'
      // seq 定宽（同毫秒多条时字典序仍是时间序+序数序，修剪不误删）
      const name = `${bucket}-${input.ts.replace(/[:.]/g, '-')}-${String(seq).padStart(4, '0')}.md`
      lastByName.set(input.station, name)
      enqueue(input.station, async () => {
        await mkdir(`${root}/${input.station}`, { recursive: true })
        await atomicPut(`${root}/${input.station}/${name}`, renderMd(input))
        await prune(input.station)
      }).catch(() => undefined)
    },

    annotate(ref: string, patch: CorpusPatch): void {
      enqueue(stationOf(ref), async () => {
        let body: string
        try {
          body = await readFile(`${root}/${ref}`, 'utf8')
        } catch {
          return // 已滚出/已迁名：静默
        }
        const station = stationOf(ref)
        const oldName = ref.split('/').pop()!
        const newName = oldName.replace(/^(ok|bad)-/, `${patch.outcome === 'ok' ? 'ok' : 'bad'}-`)
        if (newName !== oldName) {
          await atomicPut(`${root}/${station}/${newName}`, applyPatch(body, patch))
          await unlink(`${root}/${ref}`).catch(() => undefined)
        } else {
          await atomicPut(`${root}/${ref}`, applyPatch(body, patch))
        }
        if (lastByName.get(station) === oldName) lastByName.set(station, newName)
      }).catch(() => undefined)
    },

    annotateLast(station: string, patch: CorpusPatch, opts: { since?: string } = {}): string | undefined {
      const name = lastByName.get(station)
      if (!name) return undefined
      // 本轮零新捕获（#313 B7）：令牌相等就是「最近一条不是这一轮产的」——不补标、
      // 不返回引用（失败详情就不该带语料指向）。
      if (opts.since !== undefined && opts.since === `${station}/${name}`) return undefined
      const newName = name.replace(/^(ok|bad)-/, `${patch.outcome === 'ok' ? 'ok' : 'bad'}-`)
      lastByName.set(station, newName)
      this.annotate(`${station}/${name}`, patch)
      return `${station}/${newName}`
    },

    lastRef(station: string): string | undefined {
      const name = lastByName.get(station)
      return name ? `${station}/${name}` : undefined
    },

    async flush(): Promise<void> {
      while (inflight.size) await Promise.all([...inflight])
    },
  }
}
