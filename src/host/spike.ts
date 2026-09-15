/**
 * 工具调用通道 spike 装置（#216 / ADR-0069）：用生产数据裁决「自愿调用工具」是否值得
 * 铺开——双臂（现行 YAML 契约 vs 同提示词 + 必须调 submit 工具）在**大纲**与**出题**
 * 两站上各跑 N 次，同输入源，收三组指标（格式 / 内容·多样性 / 成本）。
 *
 * 为什么装置住宿主：真 provider 只在宿主 ctx 上（`ctx.llm`）。协议预注册与增补见
 * GitHub #216（含 2026-09-13 的 FormatSpread 增补与 #230 多样性仪表交付注记）。
 *
 * 关键设计（都是「不改生产语义」的落法）：
 *
 * 1. **提示词零复制**：站点的生产提示词由引擎在场拼装（大纲 = `loadPrompt('课程大纲')`
 *    + 裁剪包；出题 = `questionGenerate` 内部拼装），装置注入的补全缝把「生产提示词 +
 *    臂/变体后缀」发给模型，再把模型应答**原样**交回引擎的既有受理门。因此「同提示词」
 *    不是人工比对出来的，而是同一条代码路径。
 * 2. **JSON ⊂ YAML**：实验臂把 `submit` 工具参数（JSON）序列化成文本交回引擎——现有
 *    `YAML.parseModel` 直接吃 JSON，受理门与对照臂完全同一套。零引擎改动。
 * 3. **每格独立 vault 副本**：出题站的查重基线与 `bank` 范围读数会被历史批污染，故
 *    每格每次跑全新副本（模板一次构建、逐次拷贝）——臂间、变体间、次间互不污染。
 * 4. **判据不外借**：交付成功率 = 生产受理结果（大纲 `contentOutline` 不抛 / 出题
 *    `added > 0`）；多样性读 `questionGenerate` 返回的 #230 仪表；成本读 usage。
 * 5. **每臂 ≥2 个语义等价的措辞变体**（FormatSpread，arXiv:2310.11324）：单变体结论
 *    会被格式散布淹没，故两臂各两个措辞变体，读数按变体分列、同时给臂级聚合。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Content, CURRENT_SCHEMA_VERSION, normalizeStem } from '../engine/index.ts'
import { SPIKE_SUFFIX_RESTATE_CONTRACT, SPIKE_SUFFIX_TOOL_IMPERATIVE, SPIKE_SUFFIX_TOOL_PASSWORD } from '../engine/prompts/host.ts'
import { llmComplete, llmStreamSeam, llmView } from './llm.ts'
import { createHostRuntime } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'

/** 站（协议里的两个站；值与语料站名词表同名，便于与生产语料对读）。 */
export type SpikeStation = '课程大纲' | '题目生成'
/** 臂：control = 现行 YAML 契约；tool = 同提示词 + 必须调 submit 工具。 */
export type SpikeArm = 'control' | 'tool'

/** 一次跑的参数（缺省即协议：每格 9 次 → 每臂 18 次，落在预注册 15–20 内）。 */
export interface SpikeRequest {
  /** 每（臂 × 变体）次数；缺省 9。 */
  runsPerCell?: number
  /** 本站跑两站（缺省全跑）；成本闸可只跑一站。 */
  stations?: SpikeStation[]
  /** 出题站题量（缺省 4）。 */
  quizCount?: number
  /** 采样温度：两臂同值（缺省 1 = 宿主默认档同值；#219 端口是它的执行手段）。 */
  temperature?: number
  /** 语料落盘目录（绝对路径；缺省临时目录，随运行结束删除）。 */
  corpusDir?: string
}

/** 一条调用记录（语料可回看的单位：提示词 + 原始应答 + 计量）。 */
export interface SpikeRow {
  station: SpikeStation
  arm: SpikeArm
  variant: string
  run: number
  /** 自愿调用命中（工具臂才有意义；对照臂恒 false）。 */
  toolCalled: boolean
  /** 交付通过（生产受理门的结果）。 */
  delivered: boolean
  /** 交付失败时的死因摘要（门错误首行）。 */
  deliveryNote?: string
  /** schema 合规（解析成功 + 契约 shape 过）。 */
  schemaOk: boolean
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  durationMs: number
  promptChars: number
  replyChars: number
  /** 工具 schema 占额（字符数；对照臂恒 0）——成本轴第三组的确定性读数
   * （provider 报的输入 token 受前缀缓存影响，字符数是零噪音对照）。 */
  toolSchemaChars: number
  /** 每次模型调用的原始应答（含修复轮；工具臂记工具参数原文）。 */
  replies: string[]
  /** 站点特有的提取（大纲：节清单；出题：入库/拒收/多样性读数）。 */
  extract?: Record<string, unknown>
}

/** 一个格（站 × 臂 × 变体）的汇总。 */
export interface SpikeCell {
  station: SpikeStation
  arm: SpikeArm
  variant: string
  runs: number
  delivered: number
  deliveryRate: number
  toolHits: number
  /** 工具臂的口径；对照臂为 null（无工具可调）。 */
  hitRate: number | null
  schemaOk: number
  schemaRate: number
  inputTokens: number
  outputTokens: number
  /** 工具 schema 占额（字符数，逐次求和；对照臂 0）。 */
  toolSchemaChars: number
  meanDurationMs: number
}

/** 臂级聚合（对照预注册线；命中率只在工具臂有意义）。 */
export interface SpikeArmSummary {
  station: SpikeStation
  arm: SpikeArm
  runs: number
  delivered: number
  deliveryRate: number
  /** Wilson 95% 区间（小样本诚实读数：点估计之外必须带区间）。 */
  deliveryCi: [number, number]
  hitRate: number | null
  hitCi: [number, number] | null
  inputTokens: number
  outputTokens: number
  /** 工具 schema 占额（字符数；对照臂 0）。 */
  toolSchemaChars: number
}

export interface SpikeReport {
  startedAt: string
  durationMs: number
  provider: string
  model: string
  config: {
    runsPerCell: number
    stations: SpikeStation[]
    quizCount: number
    temperature: number
    variants: Record<SpikeArm, string[]>
  }
  cells: SpikeCell[]
  arms: SpikeArmSummary[]
  /** 预注册线裁决（格式达标判定 + 多样性轴对照 + 成本差）。 */
  verdict: {
    formatPass: boolean | null
    /** 逐条预注册线的读数（人读，不做多重比较后的自动结论）。 */
    lines: string[]
    decision: string
  }
  /** 多样性/内容面按臂聚合（批内范围读数：两臂各跑各的批）。 */
  quality: Array<{
    station: SpikeStation
    arm: SpikeArm
    runs: number
    metrics: Record<string, number | null>
    /** 出题：题型分布（逐轮计数求和）；大纲：节类型 / 难度档分布。 */
    kinds?: Record<string, number>
    types?: Record<string, number>
    tiers?: Record<string, number>
  }>
  /** 逐次原始行（语料可回看：提示词计量 + 每轮原始应答 + 行级提取）。 */
  rows: SpikeRow[]
  corpus: { dir: string | null; files: number }
  notes: string[]
}

/** 每臂每站的措辞变体（语义等价：同一契约、不同说法——FormatSpread 抗性检查）。
 * #237 / ADR-0075：措辞文本住 `prompts/host.ts`（装置专用段），这里只留臂 × id 的结构。 */
const VARIANTS: Record<SpikeArm, Array<{ id: string; suffix: string }>> = {
  control: [
    { id: '现状', suffix: '' },
    { id: '重申契约', suffix: SPIKE_SUFFIX_RESTATE_CONTRACT },
  ],
  tool: [
    { id: '指令式', suffix: SPIKE_SUFFIX_TOOL_IMPERATIVE },
    { id: '口令式', suffix: SPIKE_SUFFIX_TOOL_PASSWORD },
  ],
}

/** submit 工具的 JSON Schema（**参数即 JSON**：键位与 YAML 契约同构，宽松取值从严形状）。 */
const TOOL_SPECS: Record<SpikeStation, { name: string; description: string; parameters: Record<string, unknown> }> = {
  课程大纲: {
    name: 'submit',
    description: '提交本节点的课程大纲（节清单）。参数即结果，不要在正文里重复。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点名（照抄任务里的节点名）' },
        sections: {
          type: 'array',
          description: '节清单（3–5 节；只有拆不扩：本节点范围内的节）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '节 id（s1、s2…）' },
              title: { type: 'string', description: '节标题（「类型：标题」形态）' },
              type: { type: 'string', description: '节类型（精确取菜单：概念/例题/演示/小结/练习/交互/思维）' },
              points: { type: 'string', description: '一句话要点' },
              tier: { type: 'string', description: '节段难度档（可选）' },
              visual: { type: 'string', description: '所需可视化（无则「无」）' },
            },
            required: ['id', 'title', 'type'],
          },
        },
      },
      required: ['sections'],
    },
  },
  题目生成: {
    name: 'submit',
    description: '提交本批题目。参数即结果，不要在正文里重复。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '节点名（照抄）' },
        questions: {
          type: 'array',
          description: '题目列表（九题型菜单内取值；字段与现行 YAML 契约同构）',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: '题型（single_choice/true_false/fill_in_blank/numeric/multi_choice/ordering/matching/reflection/open_question）' },
              q: { type: 'string', description: '题面' },
              options: { type: 'array', items: { type: 'string' }, description: '选项（需要时）' },
              answer: { description: '答案（按题型：字母/字母数组/布尔/术语/数值/数组）' },
              explanation: { type: 'string', description: '解析' },
              difficulty: { type: 'number', description: '难度 1–3' },
              section: { type: 'string', description: '归属节 id（综合题写「通用」）' },
              invokes: { type: 'string', description: '调用概念（在册概念名）' },
            },
            required: ['kind', 'q', 'answer'],
          },
        },
      },
      required: ['questions'],
    },
  },
}

/** 模板 vault（一次构建）：单课程 / 单节点 / 一段有节的正文 / 三枚在册概念。 */
const COURSE = 'spike课'
const NODE = '变量是什么'
const NOTE_BODY = [
  '# 变量是什么',
  '',
  '## 概念：变量是什么',
  '',
  '变量是给一个会变的值起的名字。早上余额 50 元、晚上 20 元，都是同一个变量的不同时刻取值。',
  '把名字和值分开看：名字稳定，值随时可变。',
  '',
  '## 概念：赋值与读取',
  '',
  '赋值是把某个值写进名字（余额 = 50），读取是拿名字换回当前的值。两个动作常常成对出现。',
  '读的时候拿到的永远是「此刻」的值，不是写下它时的值。',
  '',
  '## 练习：两个时刻',
  '',
  '给出两个时刻的记录，判断哪个是赋值、哪个是读取，并说明变量在这一步变成了多少。',
  '',
  '> 机器块示例见生成正文契约；本节点正文由 spike 装置预置，不参与生成。',
].join('\n')

const REGISTRY = [
  'courses:',
  `  - id: spike-01`,
  `    name: ${COURSE}`,
  '    root: spike',
  '    enabled: true',
  '',
].join('\n')

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - name: 变量是什么',
  '        pre: []',
  '        opt: false',
  '        note: ""',
  '        est: 20',
  '        teaches:',
  '          变量: 会用',
  '      - name: 赋值与读取',
  '        pre: [变量是什么]',
  '        opt: false',
  '        note: ""',
  '        est: 20',
  '        teaches:',
  '          赋值: 会用',
  '      - name: 两个时刻的判断',
  '        pre: [赋值与读取]',
  '        opt: false',
  '        note: ""',
  '        est: 20',
  '        teaches:',
  '          读取: 知道',
  '',
].join('\n')

const CONCEPTS = [
  'concepts:',
  '  - canonical: 变量',
  '    aliases: [变数]',
  '  - canonical: 赋值',
  '    aliases: [赋初值]',
  '  - canonical: 读取',
  '    aliases: []',
  '',
].join('\n')

const NOTE = [
  '---',
  `node: ${NODE}`,
  'stage: ready',
  'fsrs: null',
  'mastery: 0',
  'content:',
  '  version: 1',
  '  generated_at: "2026-09-13"',
  '  status: draft',
  'practice:',
  '  attempts: 0',
  '  correct: 0',
  '---',
  '',
  NOTE_BODY,
  '',
].join('\n')

/** 构建模板 vault（返回根目录）；调用方负责删除。 */
function buildTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), 'learnhub-spike-tpl-')).replace(/\\/g, '/')
  const center = `${root}/学习中心`
  mkdirSync(`${center}/spike/data`, { recursive: true })
  mkdirSync(`${center}/spike/课程`, { recursive: true })
  mkdirSync(`${center}/spike/题库`, { recursive: true })
  mkdirSync(`${center}/state`, { recursive: true })
  writeFileSync(`${center}/课程注册表.yaml`, REGISTRY, 'utf8')
  writeFileSync(`${center}/spike/概念登记表.yaml`, CONCEPTS, 'utf8')
  writeFileSync(`${center}/spike/data/基础.yaml`, GRAPH, 'utf8')
  writeFileSync(`${center}/spike/课程/${NODE}.md`, NOTE, 'utf8')
  writeFileSync(`${center}/state/learnhub.json`,
    JSON.stringify({ schema: { version: CURRENT_SCHEMA_VERSION, formats: {} }, day_cutoff: '00:00' }, null, 1) + '\n', 'utf8')
  return root
}

/** 递归拷贝目录（模板 → 每格独立副本；逐文件读写，避开 Windows 上 cpSync 的原生崩溃史）。 */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = `${src}/${e.name}`
    const d = `${dst}/${e.name}`
    if (e.isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

/** Wilson 95% 区间（小样本比例读数诚实化：点估计之外必须给区间）。 */
export function wilson(successes: number, n: number): [number, number] {
  if (n <= 0) return [0, 1]
  const z = 1.96
  const p = successes / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

/** 死因摘要：门错误首行（人读用；完整输出在语料里）。 */
function firstLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.split('\n').map(s => s.trim()).filter(Boolean)[0]?.slice(0, 200) ?? raw.slice(0, 200)
}

/** 一次调用的记录面（装置自持：语料落盘 + 行提取都用它）。 */
interface CallRecord {
  kind: 'model'
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  durationMs: number
  promptChars: number
  /** 本轮实际发出的提示词（生产拼装 + 变体后缀）——语料回看的输入面。 */
  prompt: string
  reply: string
  toolCalled: boolean
}

/** 语料落盘（自持 writer：一调用一文件，frontmatter + 提示词 + 原始应答）。
 * 目录由调用方给（缺省临时目录）；#213 的语料捕获器面向生产站词表，spike 站名不在
 * 受控词表内（不污染生产语料），故此处自带一个同形的迷你 writer（G9 裁决同 #213：
 * 单文件遥测写、无跨文件一致性 → 不入 runWriteUnit 站点表）。 */
function makeCorpusWriter(dir: string | null) {
  let files = 0
  return {
    write(row: Omit<SpikeRow, 'extract'>, prompt: string): void {
      if (!dir) return
      const stationDir = `${dir}/${row.station}`
      mkdirSync(stationDir, { recursive: true })
      const name = `${row.arm}-${row.variant}-${String(row.run).padStart(2, '0')}.md`
      writeFileSync(`${stationDir}/${name}`, [
        '---',
        `station: ${row.station}`,
        `arm: ${row.arm}`,
        `variant: ${row.variant}`,
        `run: ${row.run}`,
        `tool_called: ${row.toolCalled}`,
        `delivered: ${row.delivered}`,
        `schema_ok: ${row.schemaOk}`,
        ...(row.deliveryNote ? [`delivery_note: ${row.deliveryNote.split('\n').join(' ')}`] : []),
        `input_tokens: ${row.inputTokens}`,
        `output_tokens: ${row.outputTokens}`,
        `duration_ms: ${row.durationMs}`,
        '---',
        '',
        '## 提示词（生产拼装 + 变体后缀）',
        '',
        prompt || '（缺：本轮没有发出提示词）',
        '',
        '## 原始应答（含修复轮，逐轮）',
        '',
        ...row.replies.flatMap((r, i) => [`### 第 ${i + 1} 轮`, '', r || '（空）', '']),
      ].join('\n'), 'utf8')
      files++
    },
    count: (): number => files,
  }
}

/** 单次调用：按臂选通道，返回「交给引擎受理的文本」+ 记录。 */
async function callModel(
  ctx: Context, station: SpikeStation, arm: SpikeArm, sent: string,
  temperature: number, sink: CallRecord[],
): Promise<string> {
  const startedAt = Date.now()
  if (arm === 'control') {
    let usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number } | undefined
    const text = await llmComplete(ctx, sent, undefined, {
      temperature,
      usageSink: u => { usage = u },
    })
    sink.push({
      kind: 'model',
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      durationMs: Date.now() - startedAt,
      promptChars: sent.length,
      prompt: sent,
      reply: text,
      toolCalled: false,
    })
    return text
  }
  const r = await llmStreamSeam(ctx)({
    messages: [{ role: 'user', text: sent }],
    station,
    temperature,
    tools: [TOOL_SPECS[station]],
  })
  const call = r.toolCalls[0]
  const usage = r.usage
  sink.push({
    kind: 'model',
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    durationMs: Date.now() - startedAt,
    promptChars: sent.length,
    prompt: sent,
    reply: call ? call.arguments : r.text,
    toolCalled: call !== undefined,
  })
  // 自愿调用命中 → 参数即 JSON（字符串化交回引擎；JSON ⊂ YAML，现有解析器直接吃）
  // 未命中 → 回落文本（协议预注册的「失败无害回落」语义：走现行解析）
  if (!call) return r.text
  return typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
}

/** 出题站的多样性/内容提取（#230 仪表 + 题面去重计数——票面更正确认 distinct 需自算）。 */
function quizExtract(result: {
  added: number
  /** 单题非法（超纲题型等）静默跳过的题数——受理门的第三个出口，必须入报告 */
  skipped: number
  rejected: Array<{ q: string; reason: string }>
  duplicates: Array<{ q: string; against: string }>
  diversity?: { batch?: { sample: number; kinds: Record<string, number>; entropy?: { value: number; sample: number }; distractor?: { value: number; sample: number } | null; selfBleu?: { value: number; sample: number }; stemSimilarity?: { value: number; sample: number } } }
}, bankStems: string[]): Record<string, unknown> {
  const stats = result.diversity?.batch
  const distinct = new Set(bankStems.map(normalizeStem)).size
  return {
    added: result.added,
    skipped: result.skipped,
    rejected: result.rejected.length,
    duplicates: result.duplicates.length,
    kinds: stats?.kinds ?? {},
    entropy: stats?.entropy?.value ?? null,
    distractor: stats?.distractor ? stats.distractor.value : null,
    selfBleu: stats?.selfBleu?.value ?? null,
    stemSimilarity: stats?.stemSimilarity?.value ?? null,
    distinctStems: distinct,
    stems: bankStems.map(s => s.slice(0, 80)),
  }
}

/** 跑一次 spike（路由 handler 调用）。 */
export async function runToolChannelSpike(ctx: Context, req: SpikeRequest = {}): Promise<SpikeReport> {
  if (!ctx.llm) {
    throw new Error('[spike] 宿主 ctx 没有 llm——工具通道 spike 必须在宿主进程内跑（真 provider 只在宿主）。'
      + '先在仓库根 npm run build，再 npx @deepseek-ai/dsh web 起宿主。')
  }
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const runsPerCell = Math.max(1, Math.min(30, req.runsPerCell ?? 9))
  const stations: SpikeStation[] = req.stations?.length ? req.stations : ['课程大纲', '题目生成']
  const quizCount = req.quizCount ?? 4
  const temperature = req.temperature ?? 1
  const template = buildTemplate()
  const corpusDir = req.corpusDir ?? null
  if (corpusDir) mkdirSync(corpusDir, { recursive: true })
  const writer = makeCorpusWriter(corpusDir)
  const rows: SpikeRow[] = []
  try {
    for (const station of stations) {
      for (const arm of ['control', 'tool'] as SpikeArm[]) {
        for (const variant of VARIANTS[arm]) {
          for (let run = 1; run <= runsPerCell; run++) {
            // 每格独立 vault 副本（查重基线/bank 读数不被历史批污染）
            const root = mkdtempSync(join(tmpdir(), 'learnhub-spike-run-')).replace(/\\/g, '/')
            rmSync(`${root}/学习中心`, { recursive: true, force: true })
            copyDir(`${template}/学习中心`, `${root}/学习中心`)
            const rt: HostRuntime = createHostRuntime(ctx, { vault: root, centerRel: '学习中心', quizAuditRate: 0 })
            const calls: CallRecord[] = []
            const seam = async (prompt: string, _system?: string): Promise<string> => {
              const sent = `${prompt}${variant.suffix}`
              return callModel(ctx, station, arm, sent, temperature, calls)
            }
            let delivered = false
            let schemaOk = false
            let note: string | undefined
            let extract: Record<string, unknown> | undefined
            try {
              if (station === '课程大纲') {
                const tpl = await rt.engine.content2.loadPrompt('课程大纲')
                const pack = await rt.engine.content2.contentPack(COURSE, NODE, { omitDeliverables: true })
                // 生产拼装出口（#218 契约后置）：装置不自己写 `${tpl}\n---\n${pack}`——
                // 那正是 #218 判据修订要消灭的旧形态，且会让实验测一个生产已不发的 prompt
                const yaml = await seam(Content.withContractLast(tpl, pack))
                const applied = await rt.engine.content2.contentOutline(COURSE, NODE, yaml)
                delivered = true
                schemaOk = true
                const sections = (applied.sections ?? []) as Array<{ id?: string; type?: string }>
                // 难度档在节清单视图里（contentOutline 返回的 manifest 不带 tierLabel）
                const view = await rt.engine.content2.contentSectionsView(COURSE, NODE)
                const tierOf = new Map(view.map(v => [v.id, v.tierLabel]))
                extract = {
                  sections: sections.length,
                  types: sections.map(s => String(s.type ?? '?')),
                  tiers: sections.map(s => String(tierOf.get(String(s.id ?? '')) ?? '?')),
                  sectionIds: sections.map(s => String(s.id ?? '?')),
                }
              } else {
                const r = await rt.engine.bank2.questionGenerate(COURSE, NODE, quizCount, seam, { generic: true })
                delivered = r.added > 0
                if (!delivered) note = `全部未入库：拒收 ${r.rejected.length}（${r.rejected[0]?.reason?.slice(0, 80) ?? '—'}）`
                schemaOk = delivered || r.rejected.length > 0
                const bank = await rt.engine.bank.load(rt.engine.paths.courseRoot('spike'), NODE)
                extract = quizExtract(r, bank.questions.filter(q => !q.archived).map(q => q.q))
              }
            } catch (err) {
              note = firstLine(err)
              schemaOk = false
            }
            const row: SpikeRow = {
              station, arm, variant: variant.id, run,
              toolCalled: calls.some(c => c.toolCalled),
              delivered,
              ...(note ? { deliveryNote: note } : {}),
              schemaOk,
              inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
              outputTokens: calls.reduce((n, c) => n + c.outputTokens, 0),
              durationMs: calls.reduce((n, c) => n + c.durationMs, 0),
              promptChars: calls.reduce((n, c) => n + c.promptChars, 0),
              replyChars: calls.reduce((n, c) => n + c.reply.length, 0),
              toolSchemaChars: arm === 'tool' ? calls.length * JSON.stringify(TOOL_SPECS[station]).length : 0,
              replies: calls.map(c => c.reply),
              ...(extract ? { extract } : {}),
            }
            rows.push(row)
            writer.write(row, calls[0]?.prompt ?? '')
            rmSync(root, { recursive: true, force: true })
          }
        }
      }
    }
    return buildReport({ rows, stations, runsPerCell, quizCount, temperature, startedAt, startedAtMs, corpus: { dir: corpusDir, files: writer.count() } })
  } finally {
    rmSync(template, { recursive: true, force: true })
  }
}

/** 汇总：格 → 臂 → 预注册线裁決。 */
function buildReport(o: {
  rows: SpikeRow[]
  stations: SpikeStation[]
  runsPerCell: number
  quizCount: number
  temperature: number
  startedAt: string
  startedAtMs: number
  corpus: { dir: string | null; files: number }
}): SpikeReport {
  const cells: SpikeCell[] = []
  for (const station of o.stations) {
    for (const arm of ['control', 'tool'] as SpikeArm[]) {
      for (const variant of VARIANTS[arm]) {
        const rs = o.rows.filter(r => r.station === station && r.arm === arm && r.variant === variant.id)
        if (!rs.length) continue
        const delivered = rs.filter(r => r.delivered).length
        const hits = rs.filter(r => r.toolCalled).length
        const schemaOk = rs.filter(r => r.schemaOk).length
        cells.push({
          station, arm, variant: variant.id, runs: rs.length,
          delivered, deliveryRate: delivered / rs.length,
          toolHits: hits,
          hitRate: arm === 'tool' ? hits / rs.length : null,
          schemaOk, schemaRate: schemaOk / rs.length,
          inputTokens: rs.reduce((n, r) => n + r.inputTokens, 0),
          outputTokens: rs.reduce((n, r) => n + r.outputTokens, 0),
          toolSchemaChars: rs.reduce((n, r) => n + r.toolSchemaChars, 0),
          meanDurationMs: Math.round(rs.reduce((n, r) => n + r.durationMs, 0) / rs.length),
        })
      }
    }
  }
  const arms: SpikeArmSummary[] = []
  for (const station of o.stations) {
    for (const arm of ['control', 'tool'] as SpikeArm[]) {
      const rs = o.rows.filter(r => r.station === station && r.arm === arm)
      if (!rs.length) continue
      const delivered = rs.filter(r => r.delivered).length
      const hits = rs.filter(r => r.toolCalled).length
      arms.push({
        station, arm, runs: rs.length, delivered, deliveryRate: delivered / rs.length,
        deliveryCi: wilson(delivered, rs.length),
        hitRate: arm === 'tool' ? hits / rs.length : null,
        hitCi: arm === 'tool' ? wilson(hits, rs.length) : null,
        inputTokens: rs.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: rs.reduce((n, r) => n + r.outputTokens, 0),
        toolSchemaChars: rs.reduce((n, r) => n + r.toolSchemaChars, 0),
      })
    }
  }
  const quality = o.stations.map(station => ({
    station,
    arm: 'control' as SpikeArm,
    runs: 0,
    metrics: {} as Record<string, number | null>,
  })).flatMap(x => [x, { ...x, arm: 'tool' as SpikeArm }]).map(x => {
    const rs = o.rows.filter(r => r.station === x.station && r.arm === x.arm)
    const nums = (key: string): number[] => rs.map(r => Number((r.extract ?? {})[key]))
      .filter(v => Number.isFinite(v))
    const mean = (key: string): number | null => {
      const v = nums(key)
      return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)) : null
    }
    /** 分位读数（#216 协议要的是「分布」不只均值）：p10/p50/p90。 */
    const quantile = (key: string, q: number): number | null => {
      const v = rs.map(r => Number((r.extract ?? {})[key])).filter(Number.isFinite).sort((a, b) => a - b)
      if (!v.length) return null
      const idx = Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))
      return Number(v[idx]!.toFixed(4))
    }
    /** 题型/节类型分布：逐轮计数求和（臂级词表）。 */
    const distOf = (key: string): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const r of rs) {
        const xs = (r.extract ?? {})[key]
        if (!Array.isArray(xs)) continue
        for (const x of xs) out[String(x)] = (out[String(x)] ?? 0) + 1
      }
      return out
    }
    const kindsAgg: Record<string, number> = {}
    for (const r of rs) {
      const k = (r.extract ?? {}).kinds
      if (k && typeof k === 'object') for (const [kind, n] of Object.entries(k as Record<string, number>)) kindsAgg[kind] = (kindsAgg[kind] ?? 0) + Number(n)
    }
    const metrics: Record<string, number | null> = x.station === '题目生成'
      ? {
        added: mean('added'), skipped: mean('skipped'), rejected: mean('rejected'), duplicates: mean('duplicates'),
        entropy: mean('entropy'), distractor: mean('distractor'),
        selfBleu: mean('selfBleu'), stemSimilarity: mean('stemSimilarity'),
        selfBleuP10: quantile('selfBleu', 0.1), selfBleuP50: quantile('selfBleu', 0.5), selfBleuP90: quantile('selfBleu', 0.9),
        simP10: quantile('stemSimilarity', 0.1), simP50: quantile('stemSimilarity', 0.5), simP90: quantile('stemSimilarity', 0.9),
        distinctStems: mean('distinctStems'),
      }
      : { sections: mean('sections') }
    return {
      station: x.station, arm: x.arm, runs: rs.length, metrics,
      ...(x.station === '题目生成' ? { kinds: kindsAgg } : { types: distOf('types'), tiers: distOf('tiers') }),
    }
  })

  const lines: string[] = []
  let formatPass: boolean | null = null
  for (const station of o.stations) {
    const c = arms.find(a => a.station === station && a.arm === 'control')
    const t = arms.find(a => a.station === station && a.arm === 'tool')
    if (!c || !t) continue
    const rateOk = t.deliveryRate >= c.deliveryRate
    const hitOk = (t.hitRate ?? 0) >= 0.95
    if (formatPass === null) formatPass = true
    formatPass = formatPass && rateOk && hitOk
    lines.push(`【${station}】交付成功率 对照 ${(c.deliveryRate * 100).toFixed(1)}%（${c.delivered}/${c.runs}，CI ${(c.deliveryCi[0] * 100).toFixed(0)}–${(c.deliveryCi[1] * 100).toFixed(0)}%）`
      + ` vs 工具 ${(t.deliveryRate * 100).toFixed(1)}%（${t.delivered}/${t.runs}，CI ${(t.deliveryCi[0] * 100).toFixed(0)}–${(t.deliveryCi[1] * 100).toFixed(0)}%）`
      + `｜命中率 ${t.hitRate === null ? '—' : `${(t.hitRate * 100).toFixed(1)}%`}（CI ${t.hitCi ? `${(t.hitCi[0] * 100).toFixed(0)}–${(t.hitCi[1] * 100).toFixed(0)}` : '—'}%）`
      + `｜预注册线（交付 ≥ 对照 且 命中 ≥95%）：${rateOk && hitOk ? '达标' : `未达标（${rateOk ? '' : '交付低于对照；'}${hitOk ? '' : '命中 <95%'}）`}`)
  }
  const decision = formatPass === false
    ? '格式达标线未过 → 按裁决树对未达标站关闭结构化通道（(b) 方向）'
    : '格式达标线已过 → 继续读多样性轴与成本轴（税若存在应出现在多样性轴——预注册核心线）'
  const view = llmView()
  return {
    startedAt: o.startedAt,
    durationMs: Date.now() - o.startedAtMs,
    provider: view.provider,
    model: view.model,
    config: {
      runsPerCell: o.runsPerCell, stations: o.stations, quizCount: o.quizCount, temperature: o.temperature,
      variants: { control: VARIANTS.control.map(v => v.id), tool: VARIANTS.tool.map(v => v.id) },
    },
    cells,
    arms,
    verdict: { formatPass, lines, decision },
    quality,
    rows: o.rows,
    corpus: o.corpus,
    notes: [
      `每格 ${o.runsPerCell} 次 × 2 变体 = 每臂 ${o.runsPerCell * 2} 次（预注册 N=15–20 区间内）`,
      `采样温度统一设 ${o.temperature}（两臂同值：控制变量；#219 端口是执行手段）`,
      '出题站第二意见门关闭（auditRate=0）、逐题修复轮（#148）与门错回滚仍在：它们是受理语义的一部分',
      '工具臂未命中即回落文本走现行解析（协议预注册的「失败无害回落」）',
      '小样本诚实读数：比例一律带 Wilson 95% CI；点估计不做显著性宣称',
      '成本口径：prompt 字符数零噪音可对照（两臂同生产提示词，差只在变体后缀与工具 schema）；provider 报的输入 token 受前缀缓存影响（同站同前缀，越靠后的调用越便宜），故 token 差只作量级参考，工具占额以 toolSchemaChars 为准',
      'distinct 题面数按 normalizeStem 去重自算（#230 更正说明：仪表不含该计数）',
      'reasoner 与 chat 分开报：本报告是单个模型的一次运行；换模型需另起宿主（配置决定模型）重跑一次并单独留档',
    ],
  }
}
