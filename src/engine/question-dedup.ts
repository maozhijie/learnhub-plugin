/**
 * 出题防相似（#119）：生成后程序化查重。
 *
 * 两层判定：
 * 1. 精确重复——题面归一化（去空白/标点、casefold）后字符串相等；
 * 2. 近似重复——字符 trigram 的 Jaccard 相似度超过阈值（缺省 0.8）。
 *
 * 纯函数模块（host 出题路径与测试共用）；命中的题丢弃不入库，由调用方报告。
 */

/** 近似重复判定阈值：trigram Jaccard 相似度 ≥ 该值判为高度相似。 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.8

/** 题面归一化：去全部空白与中英文标点、casefold——只留「内容字符」。 */
export function normalizeStem(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符 trigram 集合（长度不足 3 的串整体作一个 gram）。 */
function trigrams(s: string): Set<string> {
  const t = normalizeStem(s)
  if (t.length < 3) return new Set(t ? [t] : [])
  const out = new Set<string>()
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3))
  return out
}

/** 字符 trigram Jaccard 相似度（0–1）：交集 / 并集；双方为空时返回 0（空串不与任何题相似）。 */
export function trigramSimilarity(a: string, b: string): number {
  const ga = trigrams(a)
  const gb = trigrams(b)
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

/** 已有题面的最小形状（题库题/新生成题共用，避免整题依赖）。 */
export interface StemLike {
  q: string
}

/** 题库 → 查重与注入基线（#119）：非归档题的题面/题型/难度，答案不带。 */
export function bankStemList(bank: {
  questions: ReadonlyArray<{ q: string; kind?: string; difficulty?: number; archived?: boolean }>
}): Array<{ q: string; kind?: string; difficulty?: number }> {
  return bank.questions
    .filter(q => q.archived !== true)
    .map(q => ({ q: q.q, kind: q.kind, difficulty: q.difficulty }))
}

/**
 * 在已有题面中查找与 `stem` 重复或高度相似的题：精确归一化相等，或 trigram
 * 相似度 ≥ 阈值。命中返回对方原题面（供报告「哪题与哪题撞」），无命中返回 null。
 */
export function findDuplicateStem(
  stem: string,
  existing: readonly StemLike[],
  threshold: number = DUPLICATE_SIMILARITY_THRESHOLD,
): string | null {
  const norm = normalizeStem(stem)
  if (!norm) return null
  for (const e of existing) {
    if (!e?.q) continue
    if (normalizeStem(e.q) === norm) return e.q
    if (trigramSimilarity(stem, e.q) >= threshold) return e.q
  }
  return null
}

/** 出题提示词的已有题注入清单（≤limit 条）：只题面+题型+难度，不含答案。 */
export function existingStemsPromptBlock(
  existing: ReadonlyArray<StemLike & { kind?: string; difficulty?: number }>,
  limit = 15,
): string {
  if (!existing.length) return ''
  const lines = existing.slice(-limit).map((e, i) => {
    const meta = [e.kind, e.difficulty !== undefined ? `难度${e.difficulty}` : ''].filter(Boolean).join('｜')
    return `${i + 1}. [${meta}] ${e.q.replace(/\s+/g, ' ').slice(0, 120)}`
  })
  return `\n\n## 题库已有题目（禁止重复出题）\n\n下面题目已在题库中，与它们重复或高度相似的题一律不要出：\n${lines.join('\n')}`
}
