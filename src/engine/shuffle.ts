/**
 * Fisher–Yates 洗牌（#152 后续：门面模块级 helper 归位，消除两处重复实现）。
 *
 * 两份历史实现语义相同、仅随机源不同（Math.random vs 注入 rng）：统一为
 * shuffledWith(items, rng)，shuffled(items) = 默认随机源的便捷壳。
 */
/** 洗牌（返回新数组；rng 注入，测试可播种确定性）。 */
export function shuffledWith<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 洗牌（默认 Math.random；matching 右列候选防按序泄题等展示场景用）。 */
export function shuffled<T>(items: readonly T[]): T[] {
  return shuffledWith(items, Math.random)
}
