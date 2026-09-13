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
 * - 环形：失败与容忍必存但封顶（bad 桶 200/站），成功环形 25/站（ok 桶）——桶编码
 *   进文件名前缀（ok-/bad-，余段=ISO 时间戳+站内序号），修剪是纯目录操作零内容读。
 * - 写盘异步 fire-and-forget、故障静默（观测面纪律：语料故障不挡生成主流程）；
 *   lastRef 登记同步（宿主失败处理取引用不依赖写盘完成）。flush() 是测试缝。
 * - G9 裁决（ADR-0060）：语料写入是单文件遥测写、无跨文件一致性——不入
 *   runWriteUnit 站点表、不写 journal（journal 只记领域事实，不记观测面）。
 * - 站名是受控词表（PROMPT_KINDS ∪ AgentSeam 六站，无斜杠），ref 的 split('/') 依赖它。
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
  /** 按站补标最近一条捕获，返回迁移后的新 ref（无捕获 = undefined）。 */
  annotateLast(station: string, patch: CorpusPatch): string | undefined
  /** 该站最近一条捕获的相对 ref（供生成任务失败详情引用）。 */
  lastRef(station: string): string | undefined
  /** 等待全部在飞写盘完成（测试缝；生产不调）。 */
  flush(): Promise<void>
}

export function createCorpusCapture(centerRoot: string): CorpusCapture {
  const root = `${centerRoot.replace(/[/\\]+$/, '')}/state/生成语料`
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
      const name = `${bucket}-${input.ts.replace(/[:.]/g, '-')}-${seq}.md`
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

    annotateLast(station: string, patch: CorpusPatch): string | undefined {
      const name = lastByName.get(station)
      if (!name) return undefined
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
