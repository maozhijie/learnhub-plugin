/**
 * 项目执行事件流与 Mastery 交叉 2×2（P-7 / #98 / ADR-0015 §3/§4/§8）。
 *
 * 项目持有一条自己的执行事件流（事件 = 真实执行 + 表现评级 1-4 + 来源枚举），落
 * projects/<id>/exec.jsonl（追加式，先例 recall.jsonl）——它喂渐退档移动提议与 2×2
 * 诊断，与节点练习证据通道是两条流（ADR-0015 §4）。事件多记一个 tier 快照（落流时
 * 的项目档位）：入档推荐的「档内表现」口径据此归属，裁决事件形状的最小集扩展。
 *
 * 上行回流（§3）：执行事件落流时，对 nodes[] 中每一条「被行使的既有 enc 边」（= 图上
 * 实际存在的 enc 边，两端都在事件 nodes 内）两端节点各调一次既有 applyPracticeEvidence
 * ——单向复制进节点练习证据通道，零新存储形态。被行使判定 v1 就这么简单（两端都在
 * 事件 nodes 里即算行使）；判定机制精细化（何谓「这次执行真的调用了该技能」）归
 * P-6 行为推断 enc 后续票。
 *
 * 下行入档推荐（§8，challenge point）：只读纯函数——输入 = 当前档 + 档内表现（当前档
 * 下的执行事件统计）+ 关联节点 mastery 聚合，输出 = 推荐档位 + 理由摘要。永不写状态、
 * 永不参与 gateMilestone/passMilestone/题目门禁——学习者经既有 projectSetTier 手动改档。
 *
 * 2×2 诊断（项目面板核心视图）：X 轴 = 关联节点 masteryOfFm 聚合（均值，两位小数），
 * Y 轴 = 执行事件分（评级映射后 0-1）的 nextEma（首证取分，之后 0.7/0.3——与练习证据
 * 同机械）。两轴阈值统一 CROSS_AXIS_THRESHOLD（params.ts，与及格线 PASS_SCORE 同口径
 * 0.6）；证据缺失（null：无关联节点 / 无事件）按该轴低侧处理——未立住的证据不冒充
 * 已立住。四象限：会而不会用（高掌握×低执行）/ 会用而不牢（低掌握×高执行）/
 * 健康（高×高）/ 补底（低×低）。
 *
 * 评级映射参考 U 区 skills 先例（rating 1-4 整数 + source 枚举 auto/self/ai，映射归
 * 生产者；auto 来源必须走可观测证据的确定性映射 ratingFromEvidence，分数评级禁止直喂）；
 * 自评/ai 照收（ADR-0016 自报即可信精神）。零 XP、零 journal、零 review-log、
 * 零 sessions/srs（ADR-0015 §7：节点消费者对 Project 不可见）。
 */
import { existsSync } from 'node:fs'
import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { nextEma } from './grading.ts'
import { FADING_TIERS } from './projects.ts'
import type { FadingTier } from './projects.ts'
import { CROSS_AXIS_THRESHOLD, TIER_REC_MIN_EVENTS, TIER_REC_PROMOTE_SCORE, TIER_REC_DEMOTE_SCORE } from './params.ts'
import type { Paths } from './paths.ts'

/** 执行事件评分来源枚举（对齐 skills.ts / ADR-0018 入口契约）。 */
export type ExecSource = 'auto' | 'self' | 'ai'
export const EXEC_SOURCES: ExecSource[] = ['auto', 'self', 'ai']

/** 项目执行事件（exec.jsonl 逐行）。day = 学习日（证据流水的日归属口径；
 * 项目档案 created/updated 的日历日口径只适用出处戳，不适用喂诊断的证据）。 */
export interface ProjectExecRec {
  ts: string
  day: string
  rating: 1 | 2 | 3 | 4
  source: ExecSource
  /** 本次行使的关联节点（去重保序；空 = 无关联行使，只落项目流不回流）。 */
  nodes: string[]
  /** 落流时的项目渐退档快照（入档推荐「档内表现」口径的归属依据）。 */
  tier: FadingTier
  note?: string
}

/** 评级 → 0-1 分数的确定性映射（仓库默认；skills.ratingFromEvidence 可观测证据带的
 * 带中点逆映射：4←[0.9,1.0]→0.95 / 3←[0.7,0.9)→0.8 / 2←[0.4,0.7)→0.55 / 1←[0,0.4)→0.2）。
 * 映射归生产者（ADR-0018）——1-4 整数是入口契约，分数永不直喂。 */
export function execRatingScore(rating: 1 | 2 | 3 | 4): number {
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new Error(`[project-exec] 评级必须是 1-4 的整数（收到 ${String(rating)}）；分数评级禁止直喂。`)
  }
  const table: Record<number, number> = { 1: 0.2, 2: 0.55, 3: 0.8, 4: 0.95 }
  return table[rating]
}

/** 执行事件入参校验（写侧唯一口径）：rating 1-4 整数（越界/小数 fail loud，不静默
 * 取整）；source 枚举；nodes 非空字符串列表（去重保序，缺省 = 无关联行使——只落
 * 项目流，文档化语义）；note 可选字符串（trim 后空 = 丢弃）。 */
export function validateExecEvent(
  rating: unknown, source: unknown, nodesRaw: unknown, note: unknown, op = 'project-exec',
): { rating: 1 | 2 | 3 | 4; source: ExecSource; nodes: string[]; note?: string } {
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new Error(`[${op}] 评级必须是 1-4 的整数（收到 ${String(rating)}）；分数评级禁止直喂。`)
  }
  if (!(EXEC_SOURCES as string[]).includes(String(source))) {
    throw new Error(`[${op}] source 只能是 auto/self/ai（收到 ${String(source)}）。`)
  }
  const nodes: string[] = []
  if (nodesRaw !== undefined && nodesRaw !== null) {
    if (!Array.isArray(nodesRaw)) throw new Error(`[${op}] nodes 必须是列表。`)
    const seen = new Set<string>()
    for (const v of nodesRaw) {
      if (typeof v !== 'string' || !v.trim()) {
        throw new Error(`[${op}] nodes 条目必须是非空字符串。`)
      }
      const t = v.trim()
      if (!seen.has(t)) {
        seen.add(t)
        nodes.push(t)
      }
    }
  }
  const trimmed = typeof note === 'string' ? note.trim() : ''
  return {
    rating: rating as 1 | 2 | 3 | 4,
    source: source as ExecSource,
    nodes,
    ...(trimmed ? { note: trimmed } : {}),
  }
}

/** 被行使 enc 边判定（纯函数，v1）：图上实际存在的 enc 边（holder 的 enc 邻接里指向
 * skill）且两端都在事件 nodes 集合内 → 被行使。同一有序对去重；排序稳定可回放。
 * encOf 返回 holder 的 enc 邻接（skill 名列表；Graph.encOf 的 [skill, w] 元组由调用方
 * 拍平）。判定机制精细化归 P-6 后续（文件头注释）。 */
export function exercisedEncEdges(
  nodes: string[],
  encOf: (holder: string) => readonly string[],
): Array<{ holder: string; skill: string }> {
  const inSet = new Set(nodes)
  const seen = new Set<string>()
  const out: Array<{ holder: string; skill: string }> = []
  for (const holder of [...inSet].sort()) {
    for (const skill of encOf(holder) ?? []) {
      if (!inSet.has(skill) || skill === holder) continue
      const key = `${holder}\u0000${skill}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ holder, skill })
    }
  }
  return out.sort((a, b) => a.holder.localeCompare(b.holder) || a.skill.localeCompare(b.skill))
}

// ---- 2×2 象限（口径见文件头注释；阈值集中在 params.ts） ----

export type CrossQuadrantKey = 'knowledge_idle' | 'applied_shaky' | 'healthy' | 'foundation'

export interface CrossQuadrant { key: CrossQuadrantKey; label: string; hint: string }

const QUADRANTS: Record<CrossQuadrantKey, { label: string; hint: string }> = {
  knowledge_idle: {
    label: '会而不会用',
    hint: '陈述性掌握立得住、项目执行证据不足——把关联知识真用进项目：挑当前档的一个里程碑做一次，记一条执行事件。',
  },
  applied_shaky: {
    label: '会用而不牢',
    hint: '项目在推进、知识底座没跟上——对关联节点做检索点/复习，把陈述性掌握补牢后再加码。',
  },
  healthy: {
    label: '健康',
    hint: '掌握与执行互相印证——当前挑战点合适，保持节奏。',
  },
  foundation: {
    label: '补底',
    hint: '两侧证据都弱——先回底座（关联节点首学/复习），项目留在更支持的档位或暂缓推进。',
  },
}

/** X 轴口径：关联节点 masteryOfFm 均值（逐节点取值后算术平均，两位小数）；无关联节点 = null。 */
export function masteryAggregate(masteryList: readonly number[]): number | null {
  if (!masteryList.length) return null
  const mean = masteryList.reduce((a, b) => a + b, 0) / masteryList.length
  return Math.round(mean * 100) / 100
}

/** Y 轴口径：执行事件分（execRatingScore 映射后 0-1）按 nextEma 滚动（首证取分，
 * 之后 0.7/0.3，与节点练习证据同机械）；无事件 = null。 */
export function execEvidenceScore(recs: ReadonlyArray<{ rating: 1 | 2 | 3 | 4 }>): number | null {
  let ema: number | undefined
  for (const rec of recs) ema = nextEma(ema, execRatingScore(rec.rating))
  return ema === undefined ? null : ema
}

/** 2×2 分类（纯函数）：轴值 ≥ 阈值为高；null 归该轴低侧（证据未立住不冒充已立住）。 */
export function classifyCross(x: number | null, y: number | null, threshold: number = CROSS_AXIS_THRESHOLD): CrossQuadrant {
  const high = (v: number | null) => v !== null && v >= threshold
  const key: CrossQuadrantKey = high(x) && high(y) ? 'healthy'
    : high(x) ? 'knowledge_idle'
    : high(y) ? 'applied_shaky'
    : 'foundation'
  return { key, ...QUADRANTS[key] }
}

// ---- 入档推荐（challenge point，§8：引擎提议学习者可改，永不做门禁） ----

export interface TierRecommendation {
  current: FadingTier
  recommended: FadingTier
  action: 'promote' | 'demote' | 'hold'
  reasons: string[]
}

/** 入档推荐（只读纯函数）：升档判据 = 档内表现（当前档下 ≥ TIER_REC_MIN_EVENTS 条
 * 执行事件且均分 ≥ TIER_REC_PROMOTE_SCORE——当前档吃得过饱）**且**知识底座立得住
 * （关联节点 mastery 均值 ≥ CROSS_AXIS_THRESHOLD——不带底座升档会把项目推成
 * 「会用而不牢」）；档内均分 < TIER_REC_DEMOTE_SCORE（同样本下限）建议降一档
 * （challenge point 双向：支持与挑战匹配，不是只升不降）；样本不足或目标带内 →
 * hold（维持现状，静默不折腾）。永不写状态、永不参与 gateMilestone/passMilestone/
 * 题目门禁——改档走既有 projectSetTier（学习者显式动作）。 */
export function recommendTier(
  current: FadingTier,
  inTier: { count: number; avg: number | null },
  masteryAgg: number | null,
): TierRecommendation {
  const idx = FADING_TIERS.indexOf(current)
  const up = idx >= 0 ? FADING_TIERS[idx + 1] ?? null : null
  const down = idx > 0 ? FADING_TIERS[idx - 1] ?? null : null
  const enough = inTier.count >= TIER_REC_MIN_EVENTS && inTier.avg !== null
  const pct = (v: number) => `${Math.round(v * 100)}%`
  if (enough && inTier.avg >= TIER_REC_PROMOTE_SCORE) {
    if (masteryAgg !== null && masteryAgg < CROSS_AXIS_THRESHOLD) {
      return {
        current, recommended: current, action: 'hold',
        reasons: [
          `档内表现够升（${inTier.count} 次均分 ${pct(inTier.avg!)}），但知识底座均值 ${pct(masteryAgg)} < ${pct(CROSS_AXIS_THRESHOLD)}`,
          '先补底座再升档——不带底座升档会把项目推成「会用而不牢」',
        ],
      }
    }
    if (!up) {
      return {
        current, recommended: current, action: 'hold',
        reasons: [`已是最高档「独立」——无更高档可升；档内表现好（${inTier.count} 次均分 ${pct(inTier.avg!)}）可提高里程碑自主度`],
      }
    }
    return {
      current, recommended: up, action: 'promote',
      reasons: [
        `档内表现：${inTier.count} 次执行均分 ${pct(inTier.avg!)} ≥ ${pct(TIER_REC_PROMOTE_SCORE)}（当前档吃得过饱）`,
        `知识底座：关联节点掌握均值 ${masteryAgg === null ? '无关联节点' : pct(masteryAgg)}${masteryAgg !== null && masteryAgg >= CROSS_AXIS_THRESHOLD ? ' ≥ ' + pct(CROSS_AXIS_THRESHOLD) : '（未关联节点，不作约束）'}——升档不致「会用而不牢」`,
      ],
    }
  }
  if (enough && inTier.avg < TIER_REC_DEMOTE_SCORE) {
    if (!down) {
      return {
        current, recommended: current, action: 'hold',
        reasons: [`已是最低档「骨架」——无更低档可降；档内吃力（${inTier.count} 次均分 ${pct(inTier.avg!)}）考虑回关联节点补底座`],
      }
    }
    return {
      current, recommended: down, action: 'demote',
      reasons: [`档内表现吃力：${inTier.count} 次执行均分 ${pct(inTier.avg!)} < ${pct(TIER_REC_DEMOTE_SCORE)}（支持不足）`, '降一档加厚给定与支持，挑战点回到可完成区'],
    }
  }
  return {
    current, recommended: current, action: 'hold',
    reasons: [enough
      ? `档内均分 ${pct(inTier.avg!)} 处于目标带（${pct(TIER_REC_DEMOTE_SCORE)}–${pct(TIER_REC_PROMOTE_SCORE)}）——当前档位合适`
      : `档内样本不足：${inTier.count} 次 < ${TIER_REC_MIN_EVENTS}（样本攒够前维持现状）`],
  }
}

// ---- 事件流 IO（projects/<id>/exec.jsonl；先例 recall.jsonl 同惯例） ----

/** 追加一条执行事件（JSONL 一次整行追加）。 */
export async function appendExecRec(paths: Paths, projectId: string, rec: ProjectExecRec): Promise<void> {
  await mkdir(paths.projectDir(projectId), { recursive: true })
  await appendFile(paths.projectExecPath(projectId), JSON.stringify(rec) + '\n', 'utf8')
}

/** 全部执行事件（文件缺失 = 合法空态；半行损坏跳过，与 journal 同惯例）。 */
export async function execRecsAll(paths: Paths, projectId: string): Promise<ProjectExecRec[]> {
  const p = paths.projectExecPath(projectId)
  if (!existsSync(p)) return []
  const out: ProjectExecRec[] = []
  for (const line of (await readFile(p, 'utf8')).split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as ProjectExecRec)
    } catch {
      // 跳过半行损坏（进程中断尾行），与 journal 同惯例
    }
  }
  return out
}
