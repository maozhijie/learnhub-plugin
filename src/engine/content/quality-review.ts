/**
 * 离线批量评审器（#222 / ADR-0070）：从生成语料（#213）抽样、按质量量规（#221 /
 * ADR-0062）逐维度评分、产人读报告——质量回路的第一条测量闭环。
 *
 * 三个「先于」的落法（票面规格逐条对应）：
 *
 * 1. **判定标准先于判定器**：本模块不定义判据——判据全部来自 `quality-rubrics.ts`
 *    的量规表，这里只做「量规 → 评审提示词 → 应答解析 → 报告」的机械。改判据改量规表，
 *    评审器跟着变（不可能出现两套判据）。
 * 2. **人读报告先行**：产出是 markdown 报告（每站逐维度分数分布、低分件清单、证据引用、
 *    模板版本对照视图、重复评审稳定性读数），写盘不进 canonical、不写沉淀层
 *    （「内容质量结论」事件 schema 另行落地）。报告里的每条分数都能指回**具体语料文件
 *    （ref）与产物原文里的证据引用**。
 * 3. **判读分层**（词条「内容质量」）：AI 按量规评分 = 提议，人审 = 终审，结果法院
 *    （复诊/N-of-1/申诉勘误）各守其领域。故本模块**不合成跨维度总分**、不做加权——
 *    维度正交，报告只给逐维度读数（`RUBRIC_COURTS` 随报告带出）。
 *
 * 两段式防锚定（照搬 grading.ts 申诉复核 DISPUTE_REVIEW 的形态：先独立做事、再看被评
 * 对象——适用处照搬）：一期**盲评**只给产物原文与量规（不给生成提示词、不给站/档/失败
 * 码等元数据），先把产物读成它自己的样子；二期**对账**才给生成提示词与元数据，让评审
 * 逐维度确认或修正（`revised` 标记），并说明契约里哪一条解释了差异。两份读数都留在
 * 报告里——「契约解释改变了判读」这件事本身是读数（锚定影响可观测），不是需要抹平的噪声。
 *
 * 确定性：抽样等距无随机数（同输入同抽样）；证据引用逐条做**确定性定位核对**（引文必须
 * 能在产物原文里找到，找不到记 unlocated 并在报告里显式列出——评审员的引文不实不得静默
 * 通过）；评分读数一律带样本量（缺席即缺席，不填 0）。纯函数、零副作用、不读时钟、
 * 不碰 fs（宿主侧读写与模型调用住 src/host/quality-review.ts）。
 */
import { stripFences } from '../agent.ts'
import { render } from '../prompt-render.ts'
import {
  QUALITY_REVIEW_BLIND_OUTPUT_SPEC,
  QUALITY_REVIEW_BLIND_PROMPT,
  QUALITY_REVIEW_RECONCILE_PROMPT,
} from '../prompts/grading.ts'
import type { QualityRubric, RubricDimension } from './quality-rubrics.ts'

/** 评审调用的语料站标签（宿主 STATIONS.qualityReview 引本常量对齐——站名对齐靠常量不靠字面）。 */
export const QUALITY_REVIEW_STATION = '质量评审'

/** 固定采样温度（#222「temperature 固定（票7）保证可比性」）：判定要可复算——跨模板版本、
 * 跨评审轮次的差异应是内容差异，不是采样噪声；温度固定下的残余波动即模型/供应商漂移信号
 * （与 #213 的格式漂移体检同一用途）。不设旋钮：改这个值 = 改口径 = 改 ADR。 */
export const REVIEW_TEMPERATURE = 0

/** 语义档：评审是判读（读全文 + 对表），走 deep 档；部署档翻译在宿主适配器。 */
export const REVIEW_EFFORT = 'deep' as const

/** 分数档（1–4；**无总分档**——档位是逐维度的判读，不是可加总的分数）。 */
export const REVIEW_SCORE_LABELS = { 1: '未兑现', 2: '部分兑现', 3: '基本兑现', 4: '充分兑现' } as const
export type ReviewScore = 1 | 2 | 3 | 4

/** 低分阈值：≤ 此值进低分件清单（2 = 部分兑现/有反例，是「该看这一件」的下界）。 */
export const LOW_SCORE_THRESHOLD = 2

/** 每站抽样配额（票面「失败件与容忍命中优先」）：bad 桶（失败 + 容忍命中）定额必取，
 * 成功桶等距补足。两桶独立不满额不互补——报告按实际件数走，不制造「凑够配额」的假象。 */
export interface SampleQuota {
  /** 失败件 + 容忍命中件（bad 桶）取样上限。 */
  bad: number
  /** 成功件（ok 桶）取样上限。 */
  ok: number
}

export const DEFAULT_SAMPLE_QUOTA: SampleQuota = { bad: 3, ok: 2 }

// ---------------------------------------------------------------- 语料样本（宿主读盘后投影）

/** 一件被评审的语料（宿主从 `state/生成语料/<站>/<文件>` 读出后投影；引擎只认这些字段）。 */
export interface ReviewSample {
  /** 语料文件相对引用 `<站>/<文件名>`——报告每条分数指回这里的锚。 */
  ref: string
  station: string
  ts: string
  /** 调用形态（complete/repair/loop）。 */
  kind: string
  effort?: string
  outcome: 'ok' | 'tolerated' | 'failed'
  /** 失败码（failed 件）。 */
  code?: string
  truncated?: boolean
  /** 模板版本（提示词里的版本标记；无标记 = null）。 */
  templateVersion: number | null
  /** 渲染后提示词（二期对账材料）。 */
  prompt: string
  /** 原始输出（一期受评对象的一半；空输出且无工具调用 = 不可评，见 isScoreable）。 */
  output: string
  /** 工具调用载荷（#236）：回路站的产物常整个在这里（arguments 原文）——与 output
   *  合成受评对象（见 artifactTextOf），两者都为空的件才不可评。 */
  toolCalls?: Array<{ name: string; arguments: string }>
}

/** 模板版本提取：渲染后提示词里的版本标记（`<!-- learnhub:prompt/vN -->` 随模板文本进
 * 提示词，见 content.ts loadPrompt）。取**首个**标记（提示词由模板 + 材料拼成，首段即
 * 模板）。不复用 `Content.promptVersionOf`：那个锚 `^`（判模板本体）、且无标记返回 0
 * （「历史快照待升级」语义）——这里是「从拼装后的提示词里认版本」，无标记必须能为 null
 * （非模板站、历史快照），不能冒充 v0。 */
export function templateVersionOf(prompt: string): number | null {
  const m = /<!-- learnhub:prompt\/v(\d+) -->/.exec(prompt)
  return m ? Number(m[1]) : null
}

/** 受评对象原文（#236）：文本 + 工具调用载荷的**合并视图**。以工具调用承载实质产物的
 * 站（教练回合裁决 op、罗盘画线）文本常为空——只看 output 会把整轮的真实产物判成
 * 「空壳不可评」；证据定位（evidenceLocated）与两期提示词都以此为产物原文。 */
export function artifactTextOf(sample: ReviewSample): string {
  const parts: string[] = []
  if (sample.output.trim()) parts.push(sample.output.trim())
  for (const c of sample.toolCalls ?? []) parts.push(`[工具调用 ${c.name}]\n${c.arguments}`)
  return parts.join('\n\n')
}

/** 可评分件：受评对象（文本 + 工具调用载荷）非空。失败件若两者皆空（调用级失败：流错误/
 * 超时）**不作评分**——它的审计价值是失败本身（失败码 + 语料），报告单列未评分件，零模型
 * 调用。文本为空而工具调用在场的件**可评**（产物在参数里，不是没有产物）。 */
export function isScoreable(sample: ReviewSample): boolean {
  return artifactTextOf(sample).length > 0
}

// ---------------------------------------------------------------- 抽样

/** 确定性等距取样：从 count 件里取 k 件，步长游标无随机数（同输入同抽样——剧本科测试与
 * 金样本回放全确定性）。口径与 #223 第二意见门的 `sampleAuditIndices` 同族（等距，不引
 * 随机数）；那一个是「率 × 难度加权」，这里是「两桶定额」，故各写各的、不互相借形参。 */
export function equidistantIndices(count: number, k: number): number[] {
  const take = Math.max(0, Math.min(count, k))
  if (take === 0) return []
  const stride = count / take
  const out: number[] = []
  for (let i = 0; i < take; i++) out.push(Math.min(count - 1, Math.floor(i * stride)))
  return out
}

/** 按站抽样（环形池口径）：站内按 ref 逆序——语料文件名是 `<桶>-<ISO 时间戳>-<站内序号>`，
 * 故逆序是「桶内新→旧」（桶前缀 ok-/bad- 排在时间之前，桶间不参与「谁更新」的比较；环形池
 * 保留的正是各桶最近的样本，「从最近的说起」按桶内成立）。bad 桶（失败 + 容忍命中）定额取
 * 最近 N 件；ok 桶等距取 M 件。返回按 ref 升序（桶内时间序）稳定排列，便于人读与报告 diff。 */
export function sampleQualitySamples(
  samples: readonly ReviewSample[],
  quota: SampleQuota = DEFAULT_SAMPLE_QUOTA,
): ReviewSample[] {
  const byStation = new Map<string, ReviewSample[]>()
  for (const s of samples) {
    const list = byStation.get(s.station) ?? []
    list.push(s)
    byStation.set(s.station, list)
  }
  const picked: ReviewSample[] = []
  for (const [, list] of [...byStation.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const newestFirst = [...list].sort((a, b) => b.ref.localeCompare(a.ref))
    const bad = newestFirst.filter(s => s.outcome !== 'ok')
    const ok = newestFirst.filter(s => s.outcome === 'ok')
    const chosen = [
      ...bad.slice(0, Math.max(0, quota.bad)),
      ...equidistantIndices(ok.length, Math.max(0, quota.ok)).map(i => ok[i]!),
    ]
    picked.push(...chosen.sort((a, b) => a.ref.localeCompare(b.ref)))
  }
  return picked
}

/** 站 → 量规（多站共享一份量规时逐站命中：题目的两站、种子·终点的两站）。未在册站
 * 返回 undefined——评审器只评「有量规的站」（判定标准先于判定器，没有量规就没有判定）。 */
export function rubricForStation(station: string, rubrics: readonly QualityRubric[]): QualityRubric | undefined {
  return rubrics.find(r => r.stations.includes(station))
}

/** 量规在册的全部站（缺省评审范围 = 语料目录里这些站的交集）。 */
export function rubricStations(rubrics: readonly QualityRubric[]): string[] {
  return [...new Set(rubrics.flatMap(r => r.stations))].sort()
}

/** 维度显示名（站 → 量规 → 维度）；未命中时退回 id——报告不因量规改版而缺行。 */
export function dimensionNameOf(rubrics: readonly QualityRubric[], station: string, dimension: string): string {
  const rubric = rubricForStation(station, rubrics)
  return rubric?.dimensions.find(d => d.id === dimension)?.name ?? dimension
}

// ---------------------------------------------------------------- 评审提示词（两段式防锚定）
// 提示词文本住 `prompts/grading.ts`（#237 / ADR-0075：散文与代码分家）；本模块是调用点——
// 量规块/产物原文块/元数据是**数据**（下面三个数据面函数），指令散文与段序由常量固定，
// 取值一律经 `render`（缺变量与残留占位符都抛，见 prompt-render.ts 头注）。

/** 评审员系统提示词（文本住 `prompts/grading.ts`，本处 re-export 保持既有 import 面）。
 * JSON-only 契约住在 system（#212 §四.1 的唯一先例是回执评审/判卷族——契约离生成点最近的
 * 位置；评审器是判定器，形态与判卷同族）。 */
export { QUALITY_REVIEW_SYSTEM } from '../prompts/grading.ts'

/** 量规块（两期共用）：逐维度列出判据与证据要求——判据原文来自量规表，评审器不重写。 */
function rubricBlock(rubric: QualityRubric): string {
  const dims = rubric.dimensions.map(d => [
    `### 维度「${d.name}」（id: ${d.id}）`,
    ...d.criteria.map(c => [
      `- 判据（${c.id}）：${c.criterion}`,
      `  证据要求：${c.evidence}`,
      `  出处：${c.source}`,
    ].join('\n')),
  ].join('\n'))
  return [
    `被评产物类型：${rubric.product}`,
    ...(rubric.notes?.length ? ['量规注记：', ...rubric.notes.map(n => `- ${n}`)] : []),
    '',
    ...dims,
  ].join('\n')
}

/** 产物原文块（围栏不带语言标记：产物形态因站而异，标错语言反而误导）。产物 = 合并视图
 * （文本 + 工具调用载荷，见 artifactTextOf）。**不写语料 ref**：ref 形如
 * `<站>/<ok|bad>-<时间戳>…`，站名与桶前缀（= outcome）都在里面——一期盲评印出来
 * 就等于把锚定源交给评审（code-review 抓出：ADR 承诺「站/档/outcome 一律不给」，实现却随
 * ref 一起给了）。语料锚只在二期与报告里出现。 */
function artifactBlock(sample: ReviewSample): string {
  return ['## 被评产物原文', '', '```', artifactTextOf(sample), '```'].join('\n')
}

/** 元数据块（二期对账的数据面）：语料锚、站与调用形态/档位/outcome、模板版本三行。**不是
 * 提示词文本**——它是调用方数据的序列化（与 rubricBlock／artifactBlock 同族），故不进
 * `prompts/grading.ts`；格式逐字节照旧。 */
function metadataBlock(sample: ReviewSample): string {
  return [
    `- 语料：${sample.ref}`,
    `- 站：${sample.station}｜调用形态：${sample.kind}｜语义档：${sample.effort ?? '默认'}｜outcome：${sample.outcome}${sample.code ? `（${sample.code}）` : ''}${sample.truncated ? '｜输出被 max-tokens 截断' : ''}`,
    `- 模板版本：${sample.templateVersion === null ? '无版本标记（非模板站或历史快照）' : `v${sample.templateVersion}`}`,
  ].join('\n')
}

/** 一期·盲评提示词：只给量规与产物原文——生成提示词、站名/档位/outcome 等元数据一概不给
 * （锚定源先在的判读会让评审去「解释产物为什么长这样」，而不是「产物本身够不够好」）。
 * 散文与段序住 `QUALITY_REVIEW_BLIND_PROMPT`，变量面 = 三个数据块。 */
export function reviewBlindPrompt(rubric: QualityRubric, sample: ReviewSample): string {
  return render(QUALITY_REVIEW_BLIND_PROMPT, {
    rubric: rubricBlock(rubric),
    artifact: artifactBlock(sample),
    outputSpec: blindOutputSpec(rubric),
  })
}

/** 一期输出规格（维度 id 原样照抄是硬要求：id 是报告聚合的键，别名即失配）。文本住
 * `QUALITY_REVIEW_BLIND_OUTPUT_SPEC`，唯一变量 = 量规维度数。 */
function blindOutputSpec(rubric: QualityRubric): string {
  return render(QUALITY_REVIEW_BLIND_OUTPUT_SPEC, { dimensionCount: rubric.dimensions.length })
}

/** 二期·对账提示词：给出生成提示词（材料 + 输出契约）与元数据，让评审逐维度确认或修正
 * 一期判读——契约解释了产物形态时降档/升档都要说明依据（`revised` + `notes`）。散文与段序
 * 住 `QUALITY_REVIEW_RECONCILE_PROMPT`；变量面 = 数据块（量规／产物原文／一期判读 JSON／
 * 元数据／生成提示词）+ 量规维度数。 */
export function reviewReconcilePrompt(
  rubric: QualityRubric,
  sample: ReviewSample,
  blind: readonly DimensionScore[],
): string {
  return render(QUALITY_REVIEW_RECONCILE_PROMPT, {
    rubric: rubricBlock(rubric),
    artifact: artifactBlock(sample),
    blindScores: JSON.stringify({ dimensions: blind.map(d => ({ id: d.id, score: d.score, evidence: d.evidence, notes: d.notes })) }, null, 1),
    metadata: metadataBlock(sample),
    generationPrompt: sample.prompt.trim() || '（空提示词——语料未记录）',
    dimensionCount: rubric.dimensions.length,
  })
}

// ---------------------------------------------------------------- 应答解析与证据核对

/** 一个维度的判读。 */
export interface DimensionScore {
  /** 维度 id（量规表口径）。 */
  id: string
  /** 1–4；null = 产物本身不可判（na）。 */
  score: ReviewScore | null
  /** 证据引用（产物原文原句）。 */
  evidence: string[]
  notes: string
  /** 二期：相对一期是否修正。 */
  revised?: boolean
  /** 证据定位核对的失败项（引文在产物原文里找不到——确定性核对，不是模型自述）。 */
  unlocated: string[]
}

/** 从模型应答里取出 JSON 对象：剥围栏 → 取首个 {...} → 去尾逗号（与判卷/申诉复核同款
 * 容错机械：模型偶尔带围栏或尾逗号，这不改变它想说什么）。 */
export function parseReviewDoc(raw: string): Record<string, unknown> {
  const text = stripFences(raw)
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('评审应答中找不到 JSON 对象')
  return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>
}

/** 维度匹配宽容度：模型偶尔把 name 当 id 回（提示词同时给了两者）——按 id 优先、name 兜底
 * 归一；两处都对不上才是失配。 */
function dimensionIndexer(rubric: QualityRubric): Map<string, RubricDimension> {
  const map = new Map<string, RubricDimension>()
  for (const d of rubric.dimensions) {
    map.set(d.id, d)
    if (!map.has(d.name)) map.set(d.name, d)
  }
  return map
}

/** 应答 → 逐维度判读（**全维度齐备**是硬要求：缺一个维度 = 该件评审失败，由调用方记
 * failure——报告显式区别「评审失败」与「判了低分」，两者不可混为一谈）。 */
export function parseDimensionScores(
  raw: string,
  rubric: QualityRubric,
  artifact: string,
): { scores: DimensionScore[]; contractNote: string } {
  const doc = parseReviewDoc(raw)
  const list = doc.dimensions
  if (!Array.isArray(list) || !list.length) throw new Error('评审应答缺 dimensions 数组')
  const index = dimensionIndexer(rubric)
  const seen = new Map<string, DimensionScore>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const rawId = typeof row.id === 'string' ? row.id.trim() : ''
    const dim = index.get(rawId)
    if (!dim) throw new Error(`评审应答出现量规外的维度「${rawId}」`)
    if (seen.has(dim.id)) throw new Error(`评审应答重复维度「${dim.id}」`)
    const score = parseScore(row.score, dim.id)
    const evidence = Array.isArray(row.evidence)
      ? row.evidence.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim())
      : []
    const notes = typeof row.notes === 'string' ? row.notes.trim() : ''
    seen.set(dim.id, {
      id: dim.id,
      score,
      evidence,
      notes,
      ...(row.revised === true ? { revised: true } : row.revised === false ? { revised: false } : {}),
      unlocated: evidence.filter(q => !evidenceLocated(q, artifact)),
    })
  }
  const missing = rubric.dimensions.filter(d => !seen.has(d.id)).map(d => d.id)
  if (missing.length) throw new Error(`评审应答缺维度：${missing.join('、')}`)
  return {
    scores: rubric.dimensions.map(d => seen.get(d.id)!),
    contractNote: typeof doc.contract_note === 'string' ? doc.contract_note.trim() : '',
  }
}

function parseScore(value: unknown, dimensionId: string): ReviewScore | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new Error(`维度「${dimensionId}」判分非法：${JSON.stringify(value)}（允许 1–4 整数或 null）`)
  }
  return n as ReviewScore
}

/** 证据定位核对（确定性）：引文去掉全部空白后必须能在产物原文（同样去空白）里找到。
 * 整句找不到时退一步认「≥12 字的归一化前缀」命中——模型照抄长句时偶有尾部改写，但前缀
 * 命中足以证明引用的是原文而不是编的。两者皆不中 = unlocated（报告显式列出，永不静默
 * 放过：评审员的引文不实是评审质量本身的读数）。 */
export function evidenceLocated(quote: string, artifact: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const hay = norm(artifact)
  if (!hay) return false
  const needle = norm(quote)
  if (!needle) return false
  if (hay.includes(needle)) return true
  return needle.length >= 12 && hay.includes(needle.slice(0, 12))
}

// ---------------------------------------------------------------- 逐件评审记录

/** 一件的一次评审（一期 + 二期两份读数；`repeats` > 1 时同件多条，run 区分）。 */
export interface SampleReview {
  ref: string
  station: string
  /** 第几次重复评审（1 起）。 */
  run: number
  templateVersion: number | null
  outcome: ReviewSample['outcome']
  /** 一期判读（盲评）。 */
  blind?: DimensionScore[]
  /** 二期判读（对账后的终判）。 */
  reconciled?: DimensionScore[]
  /** 二期对账注记（契约对判读的影响）。 */
  contractNote?: string
  /** 评审失败原因（应答不可解析/维度缺失）——**评审失败 ≠ 产物差**，报告单列。 */
  failure?: string
  calls: number
  inputTokens: number
  outputTokens: number
  durationMs: number
}

/** 终判读数：二期优先，二期缺席（只跑了一期/二期应答坏）时退回一期。**评审失败件恒无终判**
 * （`failure` 在场即 `undefined`）——失败的一期判读仍留档（附录里以「未采信」展示），但不进
 * 任何分布与低分件清单（ADR-0070 §4「评审失败 ≠ 产物差」；code-review 抓出的反例：二期应答
 * 坏时旧实现回退一期，同一件既列「评审失败」又计低分）。 */
export function finalScores(review: SampleReview): DimensionScore[] | undefined {
  if (review.failure) return undefined
  return review.reconciled ?? review.blind
}

/** 分布读数的取数单位 = **件**（不是评审记录）：重复评审（`repeats` > 1）只为稳定性读数存在，
 * 同一件的多轮不得在分布/低分件/系统性候选里被数成多件（否则默认两轮下「一件低分」= 2/2 =
 * 100%，直接越过系统性候选线——code-review 实测抓出）。每件取**首轮**（run 最小）为分布口径；
 * 跨轮分歧归稳定性读数（temperature 固定下它测的是模型侧漂移，不是样本间差异）。 */
export function canonicalReviews(reviews: readonly SampleReview[]): SampleReview[] {
  const first = new Map<string, SampleReview>()
  for (const r of reviews) {
    const cur = first.get(r.ref)
    if (!cur || r.run < cur.run) first.set(r.ref, r)
  }
  return [...first.values()]
}

// ---------------------------------------------------------------- 聚合读数

/** 逐（站 × 维度）分布：1–4 各档件数 + 不可判件数 + 低分件数 + 无证据判分数 + 引文未定位数。 */
export interface DimensionStat {
  station: string
  dimension: string
  dimensionName: string
  /** counts[n-1] = 判 n 分的件数。 */
  counts: [number, number, number, number]
  /** 判 null（产物不可判）件数。 */
  na: number
  /** 已判档件数（= counts 之和）。 */
  scored: number
  /** 低分档（≤ LOW_SCORE_THRESHOLD）件数。 */
  low: number
  /** 判了档但一条证据都没给的件数（量规要求证据引用——这是评审面自身的读数）。 */
  noEvidence: number
  /** 引文未能在产物原文里定位的引用条数。 */
  unlocated: number
}

/** 逐（站 × 维度）分布。只统计能判的**件**（评审失败件与空输出件不进——缺席即缺席，不填 0；
 * 同一件的多轮重复评审按 `canonicalReviews` 取首轮，不重复计件）。 */
export function scoreStats(reviews: readonly SampleReview[], rubrics: readonly QualityRubric[]): DimensionStat[] {
  const out = new Map<string, DimensionStat>()
  for (const r of canonicalReviews(reviews)) {
    const scores = finalScores(r)
    if (!scores) continue
    for (const d of scores) {
      const key = `${r.station}\u0000${d.id}`
      const stat = out.get(key) ?? {
        station: r.station,
        dimension: d.id,
        dimensionName: dimensionNameOf(rubrics, r.station, d.id),
        counts: [0, 0, 0, 0],
        na: 0,
        scored: 0,
        low: 0,
        noEvidence: 0,
        unlocated: 0,
      }
      if (d.score === null) stat.na++
      else {
        stat.counts[d.score - 1]++
        stat.scored++
        if (d.score <= LOW_SCORE_THRESHOLD) stat.low++
        if (!d.evidence.length) stat.noEvidence++
      }
      stat.unlocated += d.unlocated.length
      out.set(key, stat)
    }
  }
  return [...out.values()].sort((a, b) => a.station.localeCompare(b.station) || a.dimension.localeCompare(b.dimension))
}

/** 低分件（报告的核心消费面：低分件 + 证据贴回票）。 */
export interface LowScoreItem {
  ref: string
  station: string
  dimension: string
  dimensionName: string
  score: ReviewScore
  evidence: string[]
  notes: string
  templateVersion: number | null
  /** 该维度二期是否修正过一期。 */
  revised: boolean
}

/** 低分件清单（按 ref + 维度排序，稳定可比；件口径同 scoreStats——多轮不重复列同一件）。 */
export function lowScoreItems(reviews: readonly SampleReview[], rubrics: readonly QualityRubric[]): LowScoreItem[] {
  const out: LowScoreItem[] = []
  for (const r of canonicalReviews(reviews)) {
    const scores = finalScores(r)
    if (!scores) continue
    for (const d of scores) {
      if (d.score === null || d.score > LOW_SCORE_THRESHOLD) continue
      out.push({
        ref: r.ref,
        station: r.station,
        dimension: d.id,
        dimensionName: dimensionNameOf(rubrics, r.station, d.id),
        score: d.score,
        evidence: d.evidence,
        notes: d.notes,
        templateVersion: r.templateVersion,
        revised: d.revised === true,
      })
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref) || a.dimension.localeCompare(b.dimension))
}

/** 模板版本对照视图的一行（#222 验收「模板版本间对照视图」）。 */
export interface VersionStat {
  station: string
  /** 模板版本；null = 无版本标记（单列，不冒充 v0）。 */
  templateVersion: number | null
  samples: number
  scored: number
  /** 逐维度低分率（低分件数 / 已判档件数）；维度无已判档件时缺席。 */
  lowRateByDimension: Record<string, number>
  /** 本版本的语料引用（人读核对/贴票用；>8 件截断）。 */
  refs: string[]
}

/** 版本对照：按（站 × 模板版本）聚合低分率。跨版本比的是**同一维度**的低分率，不做跨维度合成。 */
export function versionComparison(reviews: readonly SampleReview[]): VersionStat[] {
  const groups = new Map<string, { station: string; templateVersion: number | null; refs: Set<string>; scored: Map<string, number>; low: Map<string, number> }>()
  for (const r of reviews) {
    const scores = finalScores(r)
    if (!scores) continue
    const key = `${r.station}\u0000${r.templateVersion === null ? 'unknown' : r.templateVersion}`
    const g = groups.get(key) ?? { station: r.station, templateVersion: r.templateVersion, refs: new Set<string>(), scored: new Map(), low: new Map() }
    g.refs.add(r.ref)
    for (const d of scores) {
      if (d.score === null) continue
      g.scored.set(d.id, (g.scored.get(d.id) ?? 0) + 1)
      if (d.score <= LOW_SCORE_THRESHOLD) g.low.set(d.id, (g.low.get(d.id) ?? 0) + 1)
    }
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(g => ({
      station: g.station,
      templateVersion: g.templateVersion,
      samples: g.refs.size,
      scored: [...g.scored.values()].reduce((a, b) => a + b, 0),
      lowRateByDimension: Object.fromEntries([...g.scored.entries()]
        .map(([dim, n]) => [dim, (g.low.get(dim) ?? 0) / n] as const)
        .sort((a, b) => a[0].localeCompare(b[0]))),
      refs: [...g.refs].sort().slice(0, 8),
    }))
    .sort((a, b) => a.station.localeCompare(b.station)
      || (a.templateVersion ?? Number.POSITIVE_INFINITY) - (b.templateVersion ?? Number.POSITIVE_INFINITY))
}

/** 稳定性读数（#222 验收「同输入两次评审稳定性可观测」）：同件同维度跨重复轮次的一致率
 * 与平均绝对差。可对件 = 该维度在多轮里都判了档的件；判 null 的轮次不计入（缺席不算分歧）。 */
export interface StabilityStat {
  station: string
  dimension: string
  /** 参与比较的件数（多轮都判了档）。 */
  pairs: number
  /** 完全一致的件数。 */
  agree: number
  /** 平均档差（各轮极差 max−min；两轮时即 |Δ|，>2 轮时是轮次极差——名字如实）。 */
  meanRange: number
}

/** 稳定性聚合（repeats < 2 时返回空数组——无重复即无稳定性读数）。 */
export function stabilityOf(reviews: readonly SampleReview[]): StabilityStat[] {
  const runs = new Map<string, SampleReview[]>()
  for (const r of reviews) {
    const key = `${r.station}\u0000${r.ref}`
    const list = runs.get(key) ?? []
    list.push(r)
    runs.set(key, list)
  }
  const acc = new Map<string, { station: string; dimension: string; pairs: number; agree: number; delta: number }>()
  for (const list of runs.values()) {
    if (list.length < 2) continue
    const perRun = list.map(r => new Map((finalScores(r) ?? []).map(d => [d.id, d.score] as const)))
    const dims = new Set([...perRun.flatMap(m => [...m.keys()])])
    for (const dim of dims) {
      const scores: ReviewScore[] = []
      for (const m of perRun) {
        const s = m.get(dim)
        if (s !== undefined && s !== null) scores.push(s)
      }
      if (scores.length < 2) continue
      const key = `${list[0]!.station}\u0000${dim}`
      const a = acc.get(key) ?? { station: list[0]!.station, dimension: dim, pairs: 0, agree: 0, delta: 0 }
      a.pairs++
      if (scores.every(s => s === scores[0])) a.agree++
      a.delta += Math.max(...scores) - Math.min(...scores)
      acc.set(key, a)
    }
  }
  return [...acc.values()]
    .map(a => ({ station: a.station, dimension: a.dimension, pairs: a.pairs, agree: a.agree, meanRange: a.pairs ? a.delta / a.pairs : 0 }))
    .sort((a, b) => a.station.localeCompare(b.station) || a.dimension.localeCompare(b.dimension))
}
