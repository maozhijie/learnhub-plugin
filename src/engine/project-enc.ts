/**
 * 行为推断 enc 候选边（P-6 / #96）：项目窗口内的翻卡/回看共现 → 带置信度的 enc
 * 候选边 → 单个 pending edit 提案走人审（复刻 enc_backfill「单提案人审」通道先例）。
 *
 * 机制假设：迁移正比于共享产生式（Singley & Anderson）——同一时段反复一起被提取的
 * 两个节点共享工作记忆路径，值得一条成分技能边。这是全库 enc=0 的行为学破局点：
 * 课程域从未产出的 enc 边，第一次由「做」的行为证据提名。
 *
 * 边界（ADR-0015 裁决 3/6）：enc 边归节点域，项目只产出候选提案；边挂靠只在项目
 * 关联节点之间成对（计划条目 nodes 声明），跨课程对不成边（enc 边不可跨图）；
 * 关联永不构成门禁。零 schema 破坏——提案 = 既有 set_enc 整体替换 op，既有声明
 * enc 原样保留，新边带 note 可溯源可回滚。
 */

/** 窗口内行为事件的最小形状（node + 本地日；调用方负责按窗口过滤与按日去重）。 */
export interface CoEvent { node: string; day: string }

/** 共现候选对：co = 双节点同日都活跃的天数（窗口内）。 */
export interface CoCandidate { a: string; b: string; co: number }

/** 共现对提取（纯函数）：(node, day) 集合 → 同日共现天数 ≥ minCo 的无向对，
 * co 降序、同数按字典序（提案稳定可回放）。 */
export function cooccurrencePairs(events: CoEvent[], minCo: number): CoCandidate[] {
  const byDay = new Map<string, Set<string>>()
  for (const e of events) {
    let set = byDay.get(e.day)
    if (!set) byDay.set(e.day, set = new Set())
    set.add(e.node)
  }
  const pairDays = new Map<string, number>()
  for (const nodes of byDay.values()) {
    const list = [...nodes].sort()
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}\u0000${list[j]}`
        pairDays.set(key, (pairDays.get(key) ?? 0) + 1)
      }
    }
  }
  const out: CoCandidate[] = []
  for (const [key, co] of pairDays) {
    if (co >= minCo) {
      const [a, b] = key.split('\u0000')
      out.push({ a, b, co })
    }
  }
  return out.sort((x, y) => y.co - x.co || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
}

/** 方向裁决（纯函数）：enc 边方向 = skill 挂在 holder 上（holder 的 enc 列表指向 skill）。
 * pre 闭包可判方向时从图结构（a 是 b 的祖先 → skill=a, holder=b）；无结构关系时取
 * 窗口内首事件更晚者为 holder（先被练的更像被依赖的底座）——启发式，人审可改。 */
export function orientCandidate(
  a: string, b: string,
  isAncestor: (from: string, to: string) => boolean,
  firstDayOf: (node: string) => string | undefined,
): { skill: string; holder: string; why: string } {
  if (isAncestor(a, b)) return { skill: a, holder: b, why: 'pre 闭包方向' }
  if (isAncestor(b, a)) return { skill: b, holder: a, why: 'pre 闭包方向' }
  const da = firstDayOf(a) ?? ''
  const db = firstDayOf(b) ?? ''
  if (da !== db) {
    return da < db
      ? { skill: a, holder: b, why: '首事件更晚者为 holder（启发式，人审可改）' }
      : { skill: b, holder: a, why: '首事件更晚者为 holder（启发式，人审可改）' }
  }
  return { skill: a, holder: b, why: '首日相同，按字典序定方向（启发式，人审可改）' }
}

/** 共现 → enc 权重（对齐 encWeightOf 标尺：≥3 天 1.0 / 2 天 0.8 / 1 天 0.6）。 */
export function coWeight(co: number): number {
  return co >= 3 ? 1.0 : co === 2 ? 0.8 : 0.6
}
