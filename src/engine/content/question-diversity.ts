/**
 * 出题多样性仪表（#230 / ADR-0064）：纯读侧测量——批内题型分布熵、干扰项对编辑距离、
 * 题面 self-BLEU（另附平均对相似度，同轴第二读数）。
 *
 * 为什么单立一轴：防相似门（#119，`question-dedup.ts`）只拦字面近似——归一化精确重复
 * 与 trigram ≥0.8 的近乎逐字重复。「同构题」（换皮不换结构）与「众数化干扰项」（四个选项
 * 里三个是填充物、正确项位置固定）都能从查重门底下整批穿过去；#225 调查证据（arXiv:2607.18476）
 * 显示格式约束会让众数答案占比从 41% 涨到 64%。两条轴互补而非覆盖，本模块补的是多样性轴。
 *
 * 纯函数、零副作用、无门禁、不写盘——只被出题两路在入库后调一次，报告随返回值走
 * 既有的 duplicates 报告面。测量口径（逐条写死，改口径 = 改基线）：
 *
 * 1. 题型分布熵——批内按 kind 计数的香农熵（以 2 为底，单位 bit）；
 *    定义域来自本批实际出现的题型（未出现的题型不占概率质量），故上界 = log2(不同题型数)。
 * 2. 干扰项对编辑距离——单选/多选题单题 `options` 两两归一化 Levenshtein 距离（字符），
 *    题内取均值、批内按题量平均；报告同时给范围内最差一题的题内均值（可直接定位）。
 * 3. 题面 self-BLEU——每道题的题面相对批内**其余**题面（多参考）的 BLEU：n-gram
 *    精度 1–4、加一平滑（Chen & Cherry 方法 1，短中文题必需，否则 4-gram 频繁零匹配
 *    把分数机械压到 0）、标准 brevity penalty（参考长度 = 其余题面平均长度）；
 *    批内按题面长度加权平均。1 = 全批一个模子，0 = 彼此无共现。
 *
 * **读数与题量（实测，别读错）**：BLEU 逐 gram 取各参考的最大计数（多参考定义），
 * 于是**参考集越大、命中越容易**——同一份语料取前 k 道实测 self-BLEU k=2→0.061、
 * k=12→0.370、k=40→0.505，而长度加权的平均对相似度同区间只从 0.000 走到 0.036。
 * 所以：**跨批比较的漂移读数用平均对相似度**（对题量不敏感的第二读数），批内/题库的
 * self-BLEU 是**同量级样本**之间才可比的读数；报告随身带样本量就是为这件事。
 *
 * 解读约束（票面明写）：多样性 ≠ 质量——高分只说明「不趋同」，不与量规评分（#221/#222）
 * 合并成单一分数，判断须与评审抽样池交叉看。
 */
import { normalizeStem } from './question-dedup.ts'

/** 干扰项指标只覆盖有选项的判卷题型（单选/多选）——即「干扰项」这一概念实际存在的地方。 */
const OPTION_KINDS: ReadonlySet<string> = new Set(['single_choice', 'multi_choice'])

/** self-BLEU 的 n-gram 阶数上界（1–4，与 BLEU 论文一致）。 */
export const SELF_BLEU_MAX_ORDER = 4

/** 多样性报告的最小题目形状（题库题/待入库题共用）。 */
export interface DiversityQuestion {
  kind?: string
  q?: string
  options?: unknown
}

/** 任意题目形状 → 测量输入（引擎入库题、题库文件、测试样本三处共用**同一个投影**）：
 * 测量只看这三样，多出来的字段（id/答案/解析/调度）不参与读数——要加轴再扩这里。 */
export function diversityQuestionOf(q: {
  kind?: unknown
  q?: unknown
  options?: unknown
}): DiversityQuestion {
  return {
    kind: typeof q.kind === 'string' ? q.kind : undefined,
    q: typeof q.q === 'string' ? q.q : undefined,
    options: q.options,
  }
}

/** 一条读数 + 样本量：样本量恒与读数一起走，「0.5 是 2 道题算的还是 30 道题算的」不留歧义。 */
export interface DiversityReading {
  value: number
  sample: number
}

/** 干扰项对编辑距离读数：批内题内均值按题量平均；`min` = 范围内最差一题（最像的一组选项）。 */
export interface DistractorReading extends DiversityReading {
  min: number
  /** min 取自哪一题（题面截断 60 字），无题可测时缺席。 */
  minQ?: string
}

/** 单一范围（本批新增 / 题库累计）的三指标读数。
 *
 * 键在场性是**读法力**：题库范围（入库后至少 1 道题）恒有全部键，形状稳定、基线可比；
 * 批内范围在样本不足时**该项整个缺席**——单题批报不出 self-BLEU（1 道题无法自比），
 * 一个只有单选/判断题的批报不出干扰项距离。缺席 ≠ 0：0 是「测到了、就是趋同」的正读数，
 * 缺席是「这道轴在本批没有测量对象」，两者混一起会把退化读成多样性。 */
export interface DiversityMetrics {
  /** 参与本范围测量的题量（题库范围排除归档题）。 */
  sample: number
  kinds: Record<string, number>
  /** 题型分布熵（bit）；题型唯一时恒为 0，题型 ≥2 时 > 0。 */
  entropy: DiversityReading
  /** 干扰项对编辑距离；批内没有单/多选题时缺席。 */
  distractor?: DistractorReading
  /** 题面 self-BLEU；少于 2 道题面时缺席（单题无法自比）。 */
  selfBleu?: DiversityReading
  /** 平均对相似度（字符 trigram Jaccard 且按题面长度加权）——self-BLEU 的同轴第二读数。 */
  stemSimilarity?: DiversityReading
}

/** 出题多样性报告：批内 + 题库累计两范围（判据同源，样本量如实分开）。 */
export interface QuestionDiversityReport {
  batch: DiversityMetrics
  bank: DiversityMetrics
}

/** 香农熵（bit）：空集返回 0，单一取值恒为 0。 */
export function entropyOf(counts: ReadonlyArray<number>): number {
  const total = counts.reduce((a, b) => a + (b > 0 ? b : 0), 0)
  if (total <= 0) return 0
  let h = 0
  for (const n of counts) {
    if (n <= 0) continue
    const p = n / total
    h -= p * Math.log2(p)
  }
  return h
}

/** Levenshtein 编辑距离（字符，插入/删除/替换各计价 1）；等长时退化为汉明距离。 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // 行滚动 DP：只留上一行，O(min) 内存
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  const next = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    next[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      next[j] = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + cost)
    }
    prev = next.slice()
  }
  return prev[b.length]!
}

/** 字符 n-gram 计数（归一化后；长度不足 n 时退化为一枚整串 gram）。 */
function ngrams(normalized: string, n: number): Map<string, number> {
  const out = new Map<string, number>()
  if (!normalized) return out
  if (normalized.length < n) {
    out.set(normalized, 1)
    return out
  }
  for (let i = 0; i <= normalized.length - n; i++) {
    const g = normalized.slice(i, i + n)
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

/** 两串的字符 trigram Jaccard 相似度（0–1；任一为空返回 0）——self-BLEU 的同轴第二读数。 */
export function trigramOverlap(a: string, b: string): number {
  const ga = new Set(ngrams(normalizeStem(a), 3).keys())
  const gb = new Set(ngrams(normalizeStem(b), 3).keys())
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

/**
 * 单参考 BLEU（1–4 阶，加一平滑，标准 brevity penalty）：
 * `candLen` > 参考长度时 BP = 1，否则 exp(1 − refLen/candLen)。
 * 参考长度取 0（参考空串）时返回 0——空参考不构成「一致」的证据。
 */
function bleuAgainst(
  cand: string,
  refs: readonly string[],
  candLen: number,
  refMeanLen: number,
): number {
  if (!refs.length || refMeanLen <= 0 || candLen <= 0) return 0
  let logSum = 0
  for (let n = 1; n <= SELF_BLEU_MAX_ORDER; n++) {
    const cg = ngrams(cand, n)
    const rg = new Map<string, number>()
    for (const r of refs) for (const [g, c] of ngrams(r, n)) rg.set(g, Math.max(rg.get(g) ?? 0, c))
    let overlap = 0
    for (const [g, c] of cg) overlap += Math.min(c, rg.get(g) ?? 0)
    let total = 0
    for (const c of cg.values()) total += c
    // 加一平滑：分子分母同加 1（Chen & Cherry 方法 1）——短题 4-gram 零匹配不把整分机械清零
    logSum += Math.log((overlap + 1) / (total + 1))
  }
  const bp = candLen >= refMeanLen ? 1 : Math.exp(1 - refMeanLen / candLen)
  return bp * Math.exp(logSum / SELF_BLEU_MAX_ORDER)
}

/** 题面文本（非字符串/空白视作空串，不参与题面轴）。 */
function stemOf(q: DiversityQuestion): string {
  return typeof q.q === 'string' && q.q.trim() ? q.q : ''
}

/** 干扰项清洗：非字符串与非空白即剔除（数字题型不落 options，此处只管形状）。 */
function optionTextsOf(q: DiversityQuestion): string[] {
  if (typeof q.kind !== 'string' || !OPTION_KINDS.has(q.kind)) return []
  if (!Array.isArray(q.options)) return []
  return q.options
    .map(o => (typeof o === 'string' ? o : ''))
    .map(o => o.trim())
    .filter(Boolean)
}

/** 单题干扰项对编辑距离（题内两两归一化 Levenshtein 均值；<2 选项返回 null）。 */
export function distractorDistanceOf(options: readonly string[]): number | null {
  if (options.length < 2) return null
  const norm = options.map(normalizeStem)
  let sum = 0
  let pairs = 0
  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      sum += levenshteinDistance(norm[i]!, norm[j]!)
      pairs++
    }
  }
  return pairs ? sum / pairs : null
}

/** 题面 self-BLEU（每道题相对其余题面，按题面长度加权平均；少于 2 道题面返回 null）。 */
export function selfBleuOf(stems: readonly string[]): number | null {
  const texts = stems.map(normalizeStem).filter(Boolean)
  if (texts.length < 2) return null
  const lens = texts.map(t => t.length)
  const totalLen = lens.reduce((a, b) => a + b, 0)
  let weighted = 0
  for (let i = 0; i < texts.length; i++) {
    const refs = texts.filter((_, j) => j !== i)
    const refMean = (totalLen - lens[i]!) / refs.length
    weighted += lens[i]! * bleuAgainst(texts[i]!, refs, lens[i]!, refMean)
  }
  return weighted / totalLen
}

/** 平均对相似度（字符 trigram Jaccard，按题面长度加权；少于 2 道题面返回 null）。 */
export function meanStemSimilarityOf(stems: readonly string[]): number | null {
  const texts = stems.map(normalizeStem).filter(Boolean)
  if (texts.length < 2) return null
  const lens = texts.map(t => t.length)
  const totalLen = lens.reduce((a, b) => a + b, 0)
  let weighted = 0
  for (let i = 0; i < texts.length; i++) {
    let sum = 0
    for (let j = 0; j < texts.length; j++) if (i !== j) sum += trigramOverlap(texts[i]!, texts[j]!)
    weighted += lens[i]! * (sum / (texts.length - 1))
  }
  return weighted / totalLen
}

/**
 * 单一范围的多样性指标（纯函数）：传入题目子集（已按范围筛好），返回三指标读数。
 * 每项读数只在自己有样本时报出——1 道题的批不报熵以外的任何东西，不拿 0 冒充单题。
 * 输入是内建产物（DiversityQuestion 由 `diversityQuestionOf` 投影而来），此处不再过滤形状。
 */
export function diversityMetricsOf(questions: readonly DiversityQuestion[]): DiversityMetrics {
  const items = questions
  const kinds: Record<string, number> = {}
  for (const q of items) {
    const k = typeof q.kind === 'string' && q.kind ? q.kind : 'unknown'
    kinds[k] = (kinds[k] ?? 0) + 1
  }
  const stems = items.map(stemOf).filter(Boolean)

  // 干扰项：逐题算题内均值，再按题量平均；范围内最差一题（均值最小）随报告点名
  let distractorSum = 0
  let distractorCount = 0
  let distractorMin = Number.POSITIVE_INFINITY
  let distractorMinQ: string | undefined
  for (const q of items) {
    const d = distractorDistanceOf(optionTextsOf(q))
    if (d === null) continue
    distractorSum += d
    distractorCount++
    if (d < distractorMin) {
      distractorMin = d
      distractorMinQ = stemOf(q).slice(0, 60) || undefined
    }
  }

  const selfBleu = selfBleuOf(stems)
  const stemSimilarity = meanStemSimilarityOf(stems)
  const report: DiversityMetrics = {
    sample: items.length,
    kinds,
    entropy: { value: entropyOf(Object.values(kinds)), sample: items.length },
  }
  // 缺席项（样本不足）**不落键**——不拿 0 冒充「无多样性」；已观测到的最小值恒有（题量 ≥1）
  if (distractorCount) {
    const distractor: DistractorReading = {
      value: distractorSum / distractorCount,
      sample: distractorCount,
      min: distractorMin,
    }
    if (distractorMinQ) distractor.minQ = distractorMinQ
    report.distractor = distractor
  }
  if (selfBleu !== null) report.selfBleu = { value: selfBleu, sample: stems.length }
  if (stemSimilarity !== null) report.stemSimilarity = { value: stemSimilarity, sample: stems.length }
  return report
}

/** 出题多样性报告：批内（本批入库题）+ 题库累计（入库后全库非归档题）两范围。 */
export function questionDiversityReportOf(
  batch: readonly DiversityQuestion[],
  bank: readonly DiversityQuestion[],
): QuestionDiversityReport {
  return { batch: diversityMetricsOf(batch), bank: diversityMetricsOf(bank) }
}
