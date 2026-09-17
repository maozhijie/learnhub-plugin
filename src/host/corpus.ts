/**
 * 调用记录捕获器（#330 / ADR-0103，取代 #213 / ADR-0060 的「生成语料」形态）：
 * 宿主 LLM 适配器（host/llm.ts）缝合点出口的全量调用落盘——**按任务成组的完整
 * 请求/响应记录**，供人审分析「一次任务里模型到底被问了什么、答了什么、带了什么参数」。
 *
 * - 目录：`<学习中心>/state/调用记录/<课程>/<节点>.md`，一任务一组文件：文件头
 *   （任务元信息 + 调用索引 TOC）+ 每次调用一节（元数据行 + `### 请求`/`### 响应`
 *   JSON 原文块）。无业务键（course/node 缺一）的离线调用另置归档
 *   `state/调用记录/_离线/<站>.md`（同格式）。任务身份（course/node/来源）由调用点
 *   经 `stampCorpusSink` 盖章进捕获缝；来源区分作业/面板/agent/单节重写/离线。
 * - 请求 JSON = 语义级请求（结构化 messages/system/语义档/tools/temperature + 逐次
 *   尝试的 maxTokens）；响应 JSON = 组装自 StreamChunk（text/reasoning/toolCalls 含
 *   id/真实结束原因/usage 含缓存与总 token）——凡适配点技术上可得的一律入档。
 *   如实登记的边界：原始 HTTP wire body 拿不到；补全缝的多轮在入口已拍平成字符串，
 *   只能记单条合成 user 消息。
 * - 尝试序号（attempt）：捕获点在重试环**内**（截断重试/档位降级逐次各记一条）——
 *   首轮截断与降级证据不再丢失。
 * - 三态 outcome：ok=调用成功；failed=调用级失败（流稳定错误码/空闲超时/空输出，
 *   适配器当场标）或解析级失败（宿主 catch 点经 annotateLast 补标）；tolerated=
 *   解析容忍命中（大纲/拆节站经 outlineApply/splitApply 的 tolerated 返回通道补标）。
 *   补标改判该节 `结果` 行 + 失败码 + TOC 行。
 * - 生命周期：常开；默认保留 90 天、跨日惰性清扫（首次捕获/换日触发）；单文件软上限
 *   分卷 `<节点>.partN.md`（旧分卷停写后 mtime 冻结、到期随清扫退场）；清扫对每站
 *   保底样本（下限内的最新件不删）。**退役「成功 25/站、失败 200/站」环形**。
 * - 写盘异步 fire-and-forget、故障静默（观测面纪律：捕获故障不挡生成主流程）；
 *   lastRef 登记同步（宿主失败补标取它当「本轮有没有新捕获」的令牌，不依赖写盘完成）。
 *   flush() / sweepNow() 是测试缝。
 * - G9 裁决（ADR-0060 沿袭）：捕获写入是单文件遥测写、无跨文件一致性——不入
 *   runWriteUnit 站点表、不写 journal。
 * - 旧 `state/生成语料/` 冻结：不迁移、不删除（插件不删用户 vault 文件）；下方
 *   parseCorpusFrontmatter/parseCorpusFile 是旧格式读侧（供 prompt-bump/质量评审
 *   指向历史语料目录回放），新写入只走组文件形态。
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { QUIZ_SOLVER_STATION, QUALITY_REVIEW_STATION, COMPASS_STATION, DECOMPILE_STATION } from '../engine/index.ts'
import { GROWTH_DRAFT_STATION } from '../engine/index.ts'
import { safeFilename } from '../engine/infra/paths.ts'
import type { LlmEffort, LlmTokenUsage } from '../engine/index.ts'

/** 保留天数（ADR-0103 Q13）：跨日惰性清扫删除最后写入早于该天数的分卷文件。 */
export const CALL_RECORD_RETENTION_DAYS = 90
/** 单文件软上限（字节）：超过即滚下一分卷——不是硬截断，当前节写完才滚。 */
export const CALL_RECORD_PART_CAP = 256 * 1024
/** 每站样本下限（清扫保底）：候选最旧先删，某站在「留存件 + 已保底候选」里的样本数
 * 跌破该值时候选保留——低频站（申诉判卷、评审应答）不因 90 天窗口而清零。 */
export const CALL_RECORD_FLOOR = 2

/** 调用来源（ADR-0103 Q12）：作业=生成队列任务（正文/出题/生长批/图域）；面板=面板
 * 交互路由；agent=agent 交互工具；单节重写=定点重写；离线=无业务键的独立调用
 * （离线评审器等）。 */
export type CallSource = '作业' | '面板' | 'agent' | '单节重写' | '离线'

/** 任务身份（分组键 course/node + 来源）；course/node 缺一即入 _离线 归档。 */
export interface CallIdentity {
  course?: string
  node?: string
  source?: CallSource
}

/** 给捕获缝盖章任务身份（#330）：调用点在 course/node 在场的作用域包一层 sink，
 * 缝工厂（llmSeam/llmStreamSeam）与适配器零改动——身份不进端口类型，只在捕获组装时并组。 */
export function stampCorpusSink(corpus: CorpusCapture, identity: CallIdentity): CorpusSink {
  return input => corpus.record({ ...input, ...identity })
}

/** 语料捕获缝（适配器只消 record 一面；annotate/annotateLast/lastRef 由宿主失败处理与
 * 失败补标的在场证明经 rt.corpus 用，#313 B7/D20）。 */
export type CorpusSink = (input: CorpusRecordInput) => void

/** 语义级请求记录（请求 JSON 原文块）：结构化消息 + 参数面。补全缝只有单条合成
 * user 消息（如实登记的边界）；maxTokens 是重试策略的逐次尝试旋钮，随尝试入档。 */
export interface CallRequestRecord {
  messages: Array<{
    role: 'user' | 'assistant' | 'tool'
    text: string
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
  }>
  system?: string
  /** 语义档（fast/deep）；缺省 = 部署默认档。 */
  effort?: LlmEffort
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  temperature?: number
  maxTokens?: number
}

/** 响应记录（响应 JSON 原文块）：组装自 StreamChunk——思维内容、工具调用 id、真实
 * 结束原因、缓存与总 token 皆恢复入档。调用级失败时记当次尝试累积到的部分响应。 */
export interface CallResponseRecord {
  text: string
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  /** 真实结束原因（stop/tool-calls/max-tokens/aborted/error）；缺失 = 流未到终止块。 */
  finish?: string
  usage?: LlmTokenUsage
}

/** 缝合点出口的一条捕获记录（适配器组装，捕获器落盘）。 */
export interface CorpusRecordInput {
  ts: string
  station: string
  /** 调用形态：complete 单发 / repair 门错修复轮 / loop 工具回路轮（对齐 AgentCallMode）。 */
  kind: 'complete' | 'repair' | 'loop'
  /** 语义档；缺省 = 部署默认档（元数据记「默认」）。 */
  effort?: 'fast' | 'deep'
  outcome: 'ok' | 'tolerated' | 'failed'
  /** 失败码（failed 捕获级失败码或解析级补标码）。 */
  code?: string
  durationMs: number
  usage?: LlmTokenUsage
  provider: string
  model: string
  /** 任务身份（#330）：有 course+node 落任务组文件，缺一入 _离线 归档。 */
  course?: string
  node?: string
  source?: CallSource
  /** 尝试序号（1 起）：捕获点在重试环内，截断/降级重试逐次各记一条。 */
  attempt: number
  request: CallRequestRecord
  response: CallResponseRecord
}

/** 补标补丁：改判 outcome（+失败码）。 */
export interface CorpusPatch {
  outcome: 'ok' | 'tolerated' | 'failed'
  code?: string
}

export interface CorpusCapture {
  /** 捕获一次调用：同步登记 lastRef，异步落盘 + 惰性清扫。 */
  record(input: CorpusRecordInput): void
  /** 按相对 ref（`<课程>/<节点>#<序号>` 或 `_离线/<站>#<序号>`）补标；组不在本进程
   * 簿册（重启前的旧 ref / 已滚出）时静默跳过。 */
  annotate(ref: string, patch: CorpusPatch): void
  /** 按站补标最近一条捕获，返回该 ref（无捕获 = undefined）。
   * `since` = 调用方在本轮开始前取的 `lastRef` 令牌（#313 B7）：相等即「本轮对该站零捕获」
   * ——此时「最近一条」是上一轮甚至上一个会话的件，补标会把它改判 failed（解析级失败
   * 被标到成功件上，抽样与排查双失真）。非模型失败（取消 / 轮次预算耗尽 / 熔断前零调用 /
   * 空手结束）正是这种形态。省略 = 照旧补标。 */
  annotateLast(station: string, patch: CorpusPatch, opts?: { since?: string }): string | undefined
  /** 该站最近一条捕获的相对 ref：**失败补标的在场证明**（#313 B7 起有生产消费——宿主
   * 在任务开始前取一次，失败时交回 annotateLast 的 `since` 比对）。 */
  lastRef(station: string): string | undefined
  /** 等待全部在飞写盘完成（测试缝；生产不调）。 */
  flush(): Promise<void>
  /** 立即跑一轮保留期清扫，返回删除件数（测试缝；生产由跨日惰性触发）。 */
  sweepNow(now?: number): Promise<number>
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
  /** 离线评审器的判定应答（#222 / ADR-0070）：评审调用本身进调用记录——评审器也要能被
   * 评（判读稳定性/引文是否实，见评审报告），且它是「换模型/换供应商」时最该先看的标本。 */
  qualityReview: QUALITY_REVIEW_STATION,
  explainFeedback: '讲解反馈',
  selfNote: '自注反馈',
  tutor: '老师辅导',
  explainBack: '讲给我听',
  /** 生长单站的站标签（#271 草稿内核 / ADR-0088；#320 两站回单站 / ADR-0101）：引引擎侧
   * 常量对齐（站名对齐靠常量不靠字面）。#301 清理了拆分前的单站遗留名 `growth`；#320
   * 两站回单站后 `growthPlan`（思路官站）退场，只余 `growthDraft`（教练执行）。 */
  growthDraft: GROWTH_DRAFT_STATION,
  compass: COMPASS_STATION,
  decompile: DECOMPILE_STATION,
  plan: '计划草案',
  milestone: '里程碑草案',
} as const

/** 离线归档目录名（course/node 缺一的调用按站落这里）。 */
export const OFFLINE_DIR = '_离线'

// ---------------------------------------------------------------- 组文件写侧

const jsonText = (v: unknown): string => JSON.stringify(v, null, 1)

/** token 元数据行（人读速览；读侧以响应 JSON 的 usage 为准，此行是 skimming 面）。 */
function usageLineOf(usage: LlmTokenUsage | undefined): string | undefined {
  if (!usage) return undefined
  const extra = [
    usage.reasoningTokens !== undefined ? `推理 ${usage.reasoningTokens}` : '',
    usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
      ? `缓存读 ${usage.cacheReadTokens ?? 0}/写 ${usage.cacheWriteTokens ?? 0}` : '',
    usage.totalTokens !== undefined ? `总 ${usage.totalTokens}` : '',
  ].filter(Boolean)
  return `- token: 入 ${usage.inputTokens}/出 ${usage.outputTokens}${extra.length ? `（${extra.join('；')}）` : ''}`
}

export const SECTION_HEAD = /^## #(\d+) ｜ (.+?) ｜ (.+)$/
const TOC_LINE = /^- #(\d+) ｜ (.+?) ｜ (.+?) ｜ (.+?) ｜ (.+?) ｜ (.+)$/m

/** 一节（一次调用尝试）的渲染。节标题行带 序号｜站｜来源——读侧与清扫的站盘点都扫它。 */
function renderCallSection(input: CorpusRecordInput, seq: number): string {
  const usageLine = usageLineOf(input.usage)
  return [
    `## #${seq} ｜ ${input.station} ｜ ${input.source ?? '离线'}`,
    ``,
    `- 时间: ${input.ts}`,
    `- 阶段: ${input.kind}`,
    `- 档位: ${input.effort ?? '默认'}`,
    `- 尝试: ${input.attempt}`,
    `- 结果: ${input.outcome}`,
    ...(input.code !== undefined ? [`- 失败码: ${input.code}`] : []),
    `- 模型: ${input.model}（${input.provider}）`,
    `- 耗时: ${input.durationMs}ms`,
    ...(usageLine !== undefined ? [usageLine] : []),
    `- 截断: ${input.response.finish === 'max-tokens'}`,
    ``,
    `### 请求`,
    ``,
    '```json',
    jsonText(input.request),
    '```',
    ``,
    `### 响应`,
    ``,
    '```json',
    jsonText(input.response),
    '```',
    ``,
    ``,
  ].join('\n')
}

/** 分卷文件头（任务元信息 + 调用索引）。 */
function renderPartHeader(label: string, partName: string, ts: string): string {
  return [
    `# 调用记录 ${label}`,
    ``,
    `- 任务: ${label}`,
    `- 分卷: ${partName}`,
    `- 更新: ${ts}`,
    ``,
    `## 调用索引`,
    ``,
    `---`,
    ``,
  ].join('\n')
}

/** 在分卷正文追加一节：更新行刷新 + TOC 行插入（`---` 前，逐行换行保持追加序）+ 节追加。 */
function appendToPart(body: string, input: CorpusRecordInput, seq: number): string {
  const tocLine = `- #${seq} ｜ ${input.station} ｜ ${input.source ?? '离线'} ｜ ${input.kind} ｜ ${input.outcome} ｜ ${input.ts}`
  let out = body.replace(/^- 更新: .*$/m, `- 更新: ${input.ts}`)
  const sep = out.indexOf('\n---\n')
  if (sep < 0) return out.replace(/\n*$/, '\n\n') + renderCallSection(input, seq)
  out = out.slice(0, sep) + `\n${tocLine}` + out.slice(sep)
  return out.replace(/\n*$/, '\n\n') + renderCallSection(input, seq)
}

/** 补标补丁：改判该节的 结果 行（+失败码插入/移除）+ 对应 TOC 行 outcome 段。JSON 块原样。 */
function patchSection(body: string, seq: number, patch: CorpusPatch): string {
  const lines = body.split('\n')
  const startAt = lines.findIndex(l => SECTION_HEAD.test(l) && Number(SECTION_HEAD.exec(l)![1]) === seq)
  if (startAt < 0) return body
  let nextAt = lines.length
  for (let i = startAt + 1; i < lines.length; i++) {
    if (SECTION_HEAD.test(lines[i])) { nextAt = i; break }
  }
  let patched = false
  const seg: string[] = []
  for (const line of lines.slice(startAt + 1, nextAt)) {
    if (line.startsWith('- 结果: ')) {
      seg.push(`- 结果: ${patch.outcome}`)
      if (patch.code !== undefined) seg.push(`- 失败码: ${patch.code}`)
      patched = true
      continue
    }
    if (line.startsWith('- 失败码: ')) continue // 旧失败码移除（新码随结果行插入）
    seg.push(line)
  }
  if (!patched) return body
  // TOC 行按节序号逐行定位（组文件多调用时目标几乎总是最后的 TOC 行，不能只看第一条）
  for (const [i, line] of lines.entries()) {
    const m = TOC_LINE.exec(line)
    if (m && Number(m[1]) === seq) {
      lines[i] = `- #${m[1]} ｜ ${m[2]} ｜ ${m[3]} ｜ ${m[4]} ｜ ${patch.outcome} ｜ ${m[6]}`
      break
    }
  }
  return [...lines.slice(0, startAt + 1), ...seg, ...lines.slice(nextAt)].join('\n')
}

/** 文件名 → 组内分卷序（`<base>.md`=1、`<base>.partN.md`=N、无关文件=0）。读写两侧共用。 */
export function partNoOf(file: string, base: string): number {
  if (file === `${base}.md`) return 1
  const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.part(\\d+)\\.md$`).exec(file)
  return m ? Number(m[1]) : 0
}

export function createCorpusCapture(corpusDir: string): CorpusCapture {
  const root = corpusDir.replace(/[/\\]+$/, '')
  /** 站 → 最近一条 ref（`<label>#<seq>`）；同步登记（annotateLast 不等写盘）。 */
  const lastByName = new Map<string, string>()
  /** 组（`<dir>/<base>`）→ 本进程已分配的最大序号；首触时从盘上续接（重启后 seq 不回卷）。 */
  const seqByGroup = new Map<string, number>()
  const inflight = new Set<Promise<unknown>>()
  /** 组内写链串行：record 落盘完成前，同组 annotate 必须等在链尾（宿主真实形态就是
   * record 后立刻 annotateLast）；清扫走独立链（只删到期件，与在写件无交）。 */
  const chains = new Map<string, Promise<unknown>>()
  let lastSweepDay: number | undefined
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    return p.finally(() => { inflight.delete(p) })
  }
  const enqueue = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    chains.set(key, next)
    return track(next)
  }

  /** 首触续接：从盘上既有分卷读最大节序号（同步小读，一组一次；进程重启后 ref 不撞节）。 */
  function seedSeq(dir: string, base: string, key: string): void {
    if (seqByGroup.has(key)) return
    let max = 0
    try {
      for (const f of readdirSync(dir)) {
        if (partNoOf(f, base) <= 0) continue
        for (const [, s] of readFileSync(`${dir}/${f}`, 'utf8').matchAll(/## #(\d+) ｜/g)) {
          max = Math.max(max, Number(s))
        }
      }
    } catch { /* 目录不存在/读不动 = 从 1 起 */ }
    seqByGroup.set(key, max)
  }

  function triggerSweep(): void {
    const day = Math.floor(Date.now() / 86_400_000)
    if (day === lastSweepDay) return
    lastSweepDay = day
    void enqueue('⟲sweep', () => sweep(Date.now())).catch(() => undefined)
  }

  /** ref（`<label>#<seq>`）→ 组内相对键（相对 root）。label 末段是节点名（safeFilename
   * 前可能含斜杠），按**最后一个**斜杠切课程/节点；`_离线/` 前缀 = 离线组。解析不出
   * 返回 null——annotate 静默跳过。 */
  function groupOfRef(ref: string): string | null {
    const hash = ref.lastIndexOf('#')
    if (hash <= 0) return null
    const label = ref.slice(0, hash)
    if (label.startsWith(`${OFFLINE_DIR}/`)) {
      const station = label.slice(OFFLINE_DIR.length + 1)
      return station ? `${OFFLINE_DIR}/${safeFilename(station)}` : null
    }
    const slash = label.lastIndexOf('/')
    if (slash <= 0) return null
    const course = label.slice(0, slash)
    const node = label.slice(slash + 1)
    return node ? `${safeFilename(course)}/${safeFilename(node)}` : null
  }

  /** tmp + rename 原子写（与 engine atomicWrite 同语义；host 侧直用 node:fs）。 */
  async function atomicPut(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  }

  return {
    record(input: CorpusRecordInput): void {
      const keyed = input.course !== undefined && input.node !== undefined
      const dir = keyed ? `${root}/${safeFilename(input.course!)}` : `${root}/${OFFLINE_DIR}`
      const base = keyed ? safeFilename(input.node!) : safeFilename(input.station)
      const label = keyed ? `${input.course}/${input.node}` : `${OFFLINE_DIR}/${input.station}`
      const key = `${dir}/${base}`
      seedSeq(dir, base, key)
      const seq = (seqByGroup.get(key) ?? 0) + 1
      seqByGroup.set(key, seq)
      const ref = `${label}#${seq}`
      lastByName.set(input.station, ref)
      enqueue(key, async () => {
        await mkdir(dir, { recursive: true })
        const files = (await readdir(dir)).filter(f => partNoOf(f, base) > 0)
        const latest = files.length ? Math.max(...files.map(f => partNoOf(f, base))) : 1
        let partNo = latest
        let path = `${dir}/${partNo <= 1 ? `${base}.md` : `${base}.part${partNo}.md`}`
        let body: string | null = await readFile(path, 'utf8').catch(() => null)
        if (body !== null && Buffer.byteLength(body, 'utf8') > CALL_RECORD_PART_CAP) {
          partNo = latest + 1
          path = `${dir}/${base}.part${partNo}.md`
          body = null
        }
        if (body === null) body = renderPartHeader(label, partNo <= 1 ? `${base}.md` : `${base}.part${partNo}.md`, input.ts)
        await atomicPut(path, appendToPart(body, input, seq))
      }).catch(() => undefined)
      triggerSweep()
    },

    annotate(ref: string, patch: CorpusPatch): void {
      // ref → 组：与 record 同一条组链排队（补标紧跟 record 的生产形态），按节序号在组内
      // **各分卷**定位目标节（最新卷先找——补标目标常态是刚追加的节；滚卷后旧分卷里的
      // 节也要能补到）。组不在本进程簿册（重启前的旧 ref / 从未捕获）静默跳过。
      const group = groupOfRef(ref)
      if (!group) return
      const key = `${root}/${group}`
      enqueue(key, async () => {
        const seq = Number(/#(\d+)$/.exec(ref)?.[1] ?? 0)
        const dir = `${root}/${group.split('/')[0]}`
        const base = group.split('/')[1] ?? ''
        let files: string[] = []
        try {
          files = (await readdir(dir)).filter(f => partNoOf(f, base) > 0)
        } catch {
          return
        }
        for (const f of files.sort((a, b) => partNoOf(b, base) - partNoOf(a, base))) {
          const path = `${dir}/${f}`
          const body = await readFile(path, 'utf8').catch(() => null)
          if (body === null) continue
          if (!new RegExp(`^## #${seq} ｜ `, 'm').test(body)) continue
          await atomicPut(path, patchSection(body, seq, patch))
          return
        }
      }).catch(() => undefined)
    },

    annotateLast(station: string, patch: CorpusPatch, opts: { since?: string } = {}): string | undefined {
      const ref = lastByName.get(station)
      if (!ref) return undefined
      // 本轮零新捕获（#313 B7）：令牌相等就是「最近一条不是这一轮产的」——不补标、
      // 不返回引用（失败详情就不该带调用记录指向）。
      if (opts.since !== undefined && opts.since === ref) return undefined
      this.annotate(ref, patch)
      return ref
    },

    lastRef(station: string): string | undefined {
      return lastByName.get(station)
    },

    async flush(): Promise<void> {
      while (inflight.size) await Promise.all([...inflight])
    },

    async sweepNow(now = Date.now()): Promise<number> {
      return sweep(now)
    },
  }

  /** 保留期清扫（跨日惰性触发）：删除「最后写入早于保留期」的分卷文件；每站样本下限
   * 保底——候选按新到旧过一遍，某站「留存件 + 已保底候选」数不足 FLOOR 时该候选保留
   * （即每站保住最新 FLOOR 件），其余删。站盘点扫文件头 TOC 行（每分卷 TOC 只覆盖
   * 本分卷，恰是保底计数需要的粒度）。 */
  async function sweep(now: number): Promise<number> {
    const cutoff = now - CALL_RECORD_RETENTION_DAYS * 86_400_000
    let dirs: string[]
    try {
      dirs = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return 0
    }
    const keptByStation = new Map<string, number>()
    const candidates: Array<{ path: string; stations: string[]; mtimeMs: number }> = []
    const stationsIn = (header: string): string[] =>
      [...header.matchAll(/^(?:- |## )#\d+ ｜ (.+?) ｜ /gm)].map(m => m[1])
    for (const d of dirs) {
      let files: string[]
      try {
        files = (await readdir(`${root}/${d}`)).filter(f => f.endsWith('.md'))
      } catch {
        continue
      }
      for (const f of files) {
        const path = `${root}/${d}/${f}`
        const st = await stat(path).catch(() => undefined)
        if (!st) continue
        const body = await readFile(path, 'utf8').catch(() => '')
        const header = body.slice(0, Math.max(0, body.indexOf('\n---\n')))
        const stations = stationsIn(header)
        if (st.mtimeMs > cutoff) {
          for (const s of stations) keptByStation.set(s, (keptByStation.get(s) ?? 0) + 1)
        } else {
          candidates.push({ path, stations, mtimeMs: st.mtimeMs })
        }
      }
    }
    const protectedNewer = new Map<string, number>()
    let swept = 0
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const c of candidates) {
      const mustKeep = c.stations.some(s => (keptByStation.get(s) ?? 0) + (protectedNewer.get(s) ?? 0) < CALL_RECORD_FLOOR)
      if (mustKeep) {
        for (const s of c.stations) protectedNewer.set(s, (protectedNewer.get(s) ?? 0) + 1)
      } else {
        await unlink(c.path).catch(() => undefined)
        swept++
      }
    }
    return swept
  }
}

// 组文件读侧住 host/corpus-read.ts（读侧单一出处；写侧与读侧以本文件的组格式常量相接）。
