/**
 * 教练回合感知面（#144 / ADR-0033 滚动教练）：触发点共用的三个纯函数层——
 * 行为摘要五件套（读侧折叠）、就绪深度检查、沉淀折叠的教练投影。
 *
 * - 行为摘要（词条「行为摘要」）：掌握轨迹 / 卡点集中度（作答错误按 invokes 概念
 *   聚合+停滞天数）/ 速度校准（est vs 实际滚动比+JOL 过信率）/ 误解活跃度 /
 *   保留率概况；窗=最近 7 学习日或 10 节取大。即算即用不落盘——原始留流水，
 *   摘要是读侧折叠（与 Mastery 同款纪律）：全部输入由调用方注入（流水/est/
 *   误解目录/掌握度），本模块零 IO 零时钟，同输入同输出。
 * - 就绪深度检查（词条「前瞻深度」）：就绪存量（未开始且正文已生成）对照前瞻
 *   深度（默认 3、clamp [2,5]）；冷启动首周（终点锚声明起 7 天内）新手节奏慢、
 *   同样 est 的内容耗时约 ×1.5，等效于就绪存量的时间折算缩水——按节点口径放大
 *   深度需求（ceil）。ready=0 只告警不阻塞：生长永不挡当前学习动作，FIFO 不插队
 *   靠检查点前置（生长批只在检查点之后入队，不越过任何已排队任务）。
 * - 六区块上下文包的组装在门面（coachContextPack）：终点锚→行为摘要→登记表档位
 *   →误解目录→罗盘尾段（罗盘+沉淀折叠）→V-2 接缝；轻量包恰两件（行为摘要+罗盘）。
 *   本模块只出区块体渲染（行为摘要 / 沉淀折叠教练投影）。
 *
 * 裁决语义（算子集、停机规则）在提示词、归生长批受理票 #145——本票只管感知。
 * 零依赖纯函数（接缝 S51）。
 */
import { dayOfTs, parseDay, daysBetween } from './dates.ts'
import { dueReviewFirstPushes, trueRetention } from './memory.ts'
import { SEDIMENT_KINDS } from './sediment.ts'
import type { SedimentFold } from './sediment.ts'
import type { PracticeRec, ReviewRec, Misconception } from './types.ts'

// ---- 行为摘要：窗口（最近 7 学习日或 10 节取大） ----

export const DIGEST_WINDOW_DAYS = 7
export const DIGEST_WINDOW_NODES = 10

/** 窗口选取产物：days = 入窗学习日升序；nodes = 窗口内出现过的节点（去重升序）。 */
export interface DigestWindow { days: string[]; nodes: string[]; extended: boolean }

/** 双窗取大：基窗 = 最近 7 学习日（按学习日聚合、未来日排除）；基窗内不足 10 节
 * 则逐日外扩直到凑满 10 节或流水耗尽（extended = 曾超出 7 日基窗）。 */
export function behaviorWindow(recs: Array<Pick<PracticeRec, 'ts' | 'node'>>, today: string, cutoffMin = 0): DigestWindow {
  const byDay = new Map<string, Set<string>>()
  for (const r of recs) {
    const d = dayOfTs(r.ts, cutoffMin)
    if (d > today) continue
    let nodes = byDay.get(d)
    if (!nodes) byDay.set(d, nodes = new Set())
    nodes.add(r.node)
  }
  const daysDesc = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const days: string[] = []
  const nodes = new Set<string>()
  for (const d of daysDesc) {
    days.push(d)
    for (const n of byDay.get(d)!) nodes.add(n)
    if (days.length >= DIGEST_WINDOW_DAYS && nodes.size >= DIGEST_WINDOW_NODES) break
  }
  days.reverse()
  return { days, nodes: [...nodes].sort(), extended: days.length > DIGEST_WINDOW_DAYS }
}

// ---- 行为摘要：五件套折叠 ----

/** 掌握轨迹：窗口内逐学习日的作答量与正确率 + 趋势 + 活跃节点当前掌握度。 */
export interface DigestTrajectory {
  days: Array<{ day: string; attempts: number; accuracy: number | null }>
  /** 窗口前半 vs 后半的日均正确率比较（≥2 个有作答日才置值）。 */
  trend: 'up' | 'flat' | 'down' | null
  /** 窗口活跃节点的当前掌握度（masteryOfFm 折叠，调用方注入），node 升序。 */
  mastery: Array<{ node: string; mastery: number }>
}

/** 卡点集中度：窗口错误按题目 invokes 概念聚合（未标注题落 null 桶）+ 卡点节点
 * 停滞天数（今日 − 该节点最近一次答对的学习日；从未答对则自首次作答起算）。 */
export interface DigestBlockers {
  errors: number
  by_concept: Array<{ concept: string | null; count: number }>
  /** 最大概念份额（top1 错误数 ÷ 窗口错误总数；无错误为 null）。 */
  concentration: number | null
  stalls: Array<{ node: string; days: number; last_correct: string | null }>
}

/** 速度校准：窗口实际作答耗时 ÷ 触达节点的 est 预算和（est 分钟×60，缺席节点不计入
 * 分母；两者皆 >0 才置值）+ JOL「会」档过信率（窗口内「会」预测中答错的比例；
 * count = 「会」档配对数，档值本身是中文锁定词汇故不进字段名）。 */
export interface DigestSpeed {
  est_ratio: number | null
  actual_minutes: number | null
  est_minutes: number | null
  jol: { count: number; wrong: number; rate: number | null }
}

/** 误解活跃度：窗口错误作答中、题目 invokes 概念恰好命中该节点在册误解条目的次数
 * （invokes 缺席的题不硬猜归属）；by_concept 按次数降序。 */
export interface DigestMisconceptions {
  active: number
  by_concept: Array<{ concept: string; count: number }>
}

/** 保留率概况：窗口内到期复习的真实保留率（trueRetention 口径：auto/self、有旧卡、
 * 每卡每日第一条；synthetic 与首学推进天然排除）。 */
export interface DigestRetention { pass: number; fail: number; rate: number | null }

export interface BehaviorDigest {
  window: DigestWindow
  trajectory: DigestTrajectory
  blockers: DigestBlockers
  speed: DigestSpeed
  misconceptions: DigestMisconceptions
  retention: DigestRetention
}

/** 五件套的注入面（全部由调用方注入 → 确定性可测；practice 应为净额后流水）。 */
export interface DigestInput {
  course: string
  practice: PracticeRec[]
  reviews: ReviewRec[]
  /** 题目 id → invokes 概念（登记表 canonical 解析后；未标注返回 null）。 */
  invokesOf: (qid: string) => string | null
  estOf: Record<string, number>
  misconceptionsOf: Record<string, Misconception[]>
  /** 节点 → 当前掌握度（masteryOfFm 折叠）。 */
  masteryOf: Record<string, number>
  today: string
  cutoffMin?: number
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000

/** 行为摘要五件套（纯折叠；同输入同输出，零落盘）。 */
export function behaviorDigest(input: DigestInput): BehaviorDigest {
  const cutoff = input.cutoffMin ?? 0
  const coursePractice = input.practice.filter(r => r.course === input.course)
  const window = behaviorWindow(coursePractice, input.today, cutoff)
  const daySet = new Set(window.days)
  const win = coursePractice.filter(r => daySet.has(dayOfTs(r.ts, cutoff)))
  const graded = win.filter(r => typeof r.correct === 'boolean')
  const errors = win.filter(r => r.correct === false)

  // ① 掌握轨迹：逐日正确率 + 前后半趋势 + 活跃节点掌握度
  const byDayAsc = window.days.map(day => {
    const rs = graded.filter(r => dayOfTs(r.ts, cutoff) === day)
    const correct = rs.filter(r => r.correct === true).length
    return { day, attempts: rs.length, accuracy: rs.length ? round4(correct / rs.length) : null }
  })
  const accs = byDayAsc.filter(d => d.accuracy !== null).map(d => d.accuracy!)
  let trend: DigestTrajectory['trend'] = null
  if (accs.length >= 2) {
    const mid = Math.floor(accs.length / 2)
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    const diff = mean(accs.slice(mid)) - mean(accs.slice(0, mid))
    trend = diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : 'flat'
  }
  const trajectory: DigestTrajectory = {
    days: byDayAsc,
    trend,
    mastery: window.nodes.filter(n => input.masteryOf[n] !== undefined)
      .map(n => ({ node: n, mastery: input.masteryOf[n]! })),
  }

  // ② 卡点集中度：错误按 invokes 概念聚合 + 卡点节点停滞天数
  const conceptOf = (r: PracticeRec): string | null => (r.qid ? input.invokesOf(r.qid) : null)
  const errByConcept = new Map<string | null, number>()
  for (const r of errors) {
    const c = conceptOf(r)
    errByConcept.set(c, (errByConcept.get(c) ?? 0) + 1)
  }
  const byConcept = [...errByConcept.entries()]
    .map(([concept, count]) => ({ concept, count }))
    .sort((a, b) => b.count - a.count || (a.concept ?? '~').localeCompare(b.concept ?? '~'))
  const errNodes = [...new Set(errors.map(r => r.node))].sort()
  const stalls = errNodes.map(node => {
    const nodeRecs = coursePractice.filter(r => r.node === node)
    const correctDays = nodeRecs.filter(r => r.correct === true).map(r => dayOfTs(r.ts, cutoff)).sort()
    const lastCorrect = correctDays.at(-1) ?? null
    const anchorDay = lastCorrect ?? nodeRecs.map(r => dayOfTs(r.ts, cutoff)).sort()[0]!
    const parsed = parseDay(anchorDay)
    const days = parsed ? Math.max(0, daysBetween(parseDay(input.today) ?? parsed, parsed)) : 0
    return { node, days, last_correct: lastCorrect }
  }).sort((a, b) => b.days - a.days || a.node.localeCompare(b.node))
  const blockers: DigestBlockers = {
    errors: errors.length,
    by_concept: byConcept,
    concentration: errors.length ? round4((byConcept[0]?.count ?? 0) / errors.length) : null,
    stalls,
  }

  // ③ 速度校准：est vs 实际滚动比 + JOL 过信率
  const elapsed = win.map(r => r.elapsed_s).filter((s): s is number => typeof s === 'number' && s > 0)
  const actualS = elapsed.reduce((s, x) => s + x, 0)
  const estS = [...new Set(win.map(r => r.node))]
    .reduce((s, n) => s + (input.estOf[n] !== undefined ? input.estOf[n]! * 60 : 0), 0)
  const pairedHui = win.filter(r => r.predicted === '会' && typeof r.correct === 'boolean')
  const huiWrong = pairedHui.filter(r => r.correct === false).length
  const speed: DigestSpeed = {
    est_ratio: actualS > 0 && estS > 0 ? round4(actualS / estS) : null,
    actual_minutes: actualS > 0 ? Math.round(actualS / 6) / 10 : null,
    est_minutes: estS > 0 ? Math.round(estS / 60) : null,
    jol: { count: pairedHui.length, wrong: huiWrong, rate: pairedHui.length ? round4(huiWrong / pairedHui.length) : null },
  }

  // ④ 误解活跃度：窗口错误 × invokes 概念命中该节点在册误解条目
  const misByConcept = new Map<string, number>()
  let misActive = 0
  for (const r of errors) {
    const c = conceptOf(r)
    if (!c) continue
    const hit = (input.misconceptionsOf[r.node] ?? []).some(m => m.concept === c)
    if (!hit) continue
    misActive++
    misByConcept.set(c, (misByConcept.get(c) ?? 0) + 1)
  }
  const misconceptions: DigestMisconceptions = {
    active: misActive,
    by_concept: [...misByConcept.entries()].map(([concept, count]) => ({ concept, count }))
      .sort((a, b) => b.count - a.count || a.concept.localeCompare(b.concept)),
  }

  // ⑤ 保留率概况：窗口内到期复习的真实保留率
  const dueReviews = dueReviewFirstPushes(
    input.reviews.filter(r => r.course === input.course), cutoff,
  ).filter(r => daySet.has(dayOfTs(r.ts, cutoff)))
  const tr = trueRetention(dueReviews)
  const retention: DigestRetention = { pass: tr.pass, fail: tr.fail, rate: tr.rate }

  return { window, trajectory, blockers, speed, misconceptions, retention }
}

// ---- 行为摘要：区块体渲染 ----

const pct = (x: number): string => `${Math.round(x * 100)}%`

/** 行为摘要区块体（六区块包的第 2 块；轻量包第 1 块）。空窗 = 合法空态一行——
 * 区块本体仍在（定序稳定、轻量包恒两件），由组装方决定是否再加措辞。 */
export function renderBehaviorDigest(d: BehaviorDigest): string {
  if (!d.window.days.length) {
    return '（窗口内无行为流水——合法空态：原始留流水，摘要是读侧折叠；课程刚起步时本块如实为空。）'
  }
  const lines: string[] = []
  const span = d.window.days[0] === d.window.days.at(-1)
    ? d.window.days[0]!
    : `${d.window.days[0]} … ${d.window.days.at(-1)}`
  lines.push(`### 窗口`, `- 最近 ${d.window.days.length} 学习日（${span}，${d.window.nodes.length} 节）${d.window.extended ? '——为凑满 10 节已扩窗' : ''}`)

  lines.push('', '### 掌握轨迹')
  const days = d.trajectory.days.map(t =>
    `  - ${t.day}：${t.attempts} 答${t.accuracy !== null ? `，正确率 ${pct(t.accuracy)}` : '（无判分）'}`)
  if (days.length) lines.push(...days)
  else lines.push('  - （窗口内无已判分作答）')
  if (d.trajectory.trend) lines.push(`  - 趋势：${d.trajectory.trend === 'up' ? '升' : d.trajectory.trend === 'down' ? '降' : '平'}（窗口后半对照前半）`)
  if (d.trajectory.mastery.length) {
    lines.push(`  - 活跃节点掌握度：${d.trajectory.mastery.map(m => `${m.node} ${m.mastery}`).join('、')}`)
  }

  lines.push('', '### 卡点集中度（错误按 invokes 概念聚合）')
  if (!d.blockers.errors) {
    lines.push('- 窗口内无错误作答')
  } else {
    lines.push(`- 窗口错误 ${d.blockers.errors} 处：${d.blockers.by_concept.map(b => `${b.concept ?? '（未标注）'} ×${b.count}`).join('、')}`)
    if (d.blockers.concentration !== null) lines.push(`- 集中度（最大概念份额）：${pct(d.blockers.concentration)}`)
    for (const s of d.blockers.stalls) {
      lines.push(`- 停滞：${s.node} ${s.days} 天${s.last_correct ? `未答对（最近答对 ${s.last_correct}）` : '自首次作答从未答对'}`)
    }
  }

  lines.push('', '### 速度校准')
  if (d.speed.est_ratio !== null) {
    lines.push(`- est vs 实际：窗口实际 ${d.speed.actual_minutes} 分钟 ÷ 触达节点 est 预算 ${d.speed.est_minutes} 分钟 = ${d.speed.est_ratio}${d.speed.est_ratio > 1 ? '（比标称慢）' : d.speed.est_ratio < 1 ? '（比标称快）' : ''}`)
  } else {
    lines.push('- （窗口内无可折算的作答耗时/est 数据）')
  }
  if (d.speed.jol.count > 0) {
    lines.push(`- JOL「会」档：${d.speed.jol.count} 次中错 ${d.speed.jol.wrong}，过信率 ${pct(d.speed.jol.rate!)}`)
  } else {
    lines.push('- JOL「会」档：窗口内无「会」预测样本')
  }

  lines.push('', '### 误解活跃度')
  if (d.misconceptions.active > 0) {
    lines.push(`- 窗口错误踩中在册误解 ${d.misconceptions.active} 处：${d.misconceptions.by_concept.map(m => `${m.concept} ×${m.count}`).join('、')}`)
  } else {
    lines.push('- 窗口错误未踩中在册误解（或无错误/无 invokes 标注——缺席不硬猜归属）')
  }

  lines.push('', '### 保留率概况')
  // 真实保留率口径（trueRetention）：pass+fail>0 时 rate 必非 null
  lines.push((d.retention.pass + d.retention.fail) > 0
    ? `- 窗口内到期复习 ${d.retention.pass + d.retention.fail} 次：通过 ${d.retention.pass}、失手 ${d.retention.fail}，真实保留率 ${pct(d.retention.rate!)}`
    : '- 窗口内无到期复习记录')
  return lines.join('\n')
}

// ---- 就绪深度检查 ----

export const COACH_LOOKAHEAD_DEFAULT = 3
export const COACH_LOOKAHEAD_MIN = 2
export const COACH_LOOKAHEAD_MAX = 5
/** 冷启动首周宽度（终点锚 declared 起；词条「种子」）。 */
export const COACH_COLD_START_DAYS = 7
/** 冷启动首周的节奏折算（同样 est 的内容首周耗时约 ×1.5）。 */
export const COACH_COLD_START_EST_MULT = 1.5

/** 回合触发三点（#144）：节点完成 / 会话开始 / 队列空闲。 */
export type CoachTrigger = 'node_complete' | 'session_start' | 'queue_idle'

/** 教练回合单段装配的观测记录（#145 两段式 effort）：tier/effort 定档，operator 为
 * 该段裁决产出的算子标签，disagreement = 该段是否声明真分歧（true → 升级下一段）。 */
export interface CoachGrowthSegment {
  tier: 'light' | 'full'
  effort: 'fast' | 'deep'
  operator: string
  disagreement: boolean
}

/** 单课程就绪深度检查（facade 附加课程名后的对外视图）。 */
export interface CoachCheck extends ReadyDepthCheck { course: string }

export interface ReadyDepthCheck {
  /** 就绪存量：未开始（前置达成）且正文已生成的节点数（调用方按此口径注入）。 */
  ready: number
  /** 前瞻深度（配置值 clamp 后）。 */
  depth: number
  /** 需求深度（冷启动首周 ×1.5 后 ceil）。 */
  required: number
  cold_start: boolean
  ok: boolean
  /** 只告警不阻塞：ready=0 与低于前瞻各出一行。 */
  warnings: string[]
}

/** 就绪深度检查（纯函数）：ready ≥ required 即满足——满足时教练回合自然无批可产
 * （停摆是判据满足的自然结果，不是新状态）；ready=0 只告警（合法空态：刚播种/
 * 生长尚未跟上），永不阻塞、永不抛错。 */
export function readyDepthCheck(input: {
  ready: number
  /** 终点锚声明日（null = 未播种，不判冷启动）。 */
  declared: string | null
  today: string
  depth?: number | null
}): ReadyDepthCheck {
  const raw = input.depth ?? COACH_LOOKAHEAD_DEFAULT
  const depth = Number.isFinite(raw)
    ? Math.min(COACH_LOOKAHEAD_MAX, Math.max(COACH_LOOKAHEAD_MIN, Math.round(raw)))
    : COACH_LOOKAHEAD_DEFAULT
  const declared = parseDay(input.declared)
  const today = parseDay(input.today)
  const cold_start = declared !== null && today !== null
    && daysBetween(today, declared) >= 0
    && daysBetween(today, declared) < COACH_COLD_START_DAYS
  const required = cold_start ? Math.ceil(depth * COACH_COLD_START_EST_MULT) : depth
  const ok = input.ready >= required
  const warnings: string[] = []
  if (input.ready === 0) {
    warnings.push('就绪存量 ready=0（当前没有「前置已达成且正文已生成」的可学节点）——只告警不阻塞：生长永不挡当前学习动作。')
  } else if (!ok) {
    warnings.push(`就绪深度 ${input.ready} 低于前瞻需求 ${required}（深度 ${depth}${cold_start ? `，冷启动首周 ×${COACH_COLD_START_EST_MULT}` : ''}）——教练回合应裁决生长。`)
  }
  return { ready: input.ready, depth, required, cold_start, ok, warnings }
}

// ---- 沉淀折叠的教练投影（六区块包第 5 块「罗盘尾段」的沉淀半区） ----

/** 沉淀折叠 → 教练投影行（消费一律从 sedimentFold 取，禁止再读内容层旧居所）。
 * 空正典 = 合法空态一行。payload 形态随 kind 演变，按原始 JSON 携带（教练读原始值，
 * 不做二次解释——解释语义归各生产者）。 */
export function renderSedimentForCoach(fold: SedimentFold): string {
  if (!fold.events.length) {
    return '（沉淀正典空——合法空态：泛用模型数据出生即写，读侧单向折叠；当前无记录，随生产者接线逐步充实。）'
  }
  const counts = SEDIMENT_KINDS.map(k => `${k}=${fold.counts[k]}`).join('、')
  const lines = [`- 正典 ${fold.events.length} 条（${counts}）`]
  const latest = fold.latest.calibration
  if (latest) lines.push(`- 校准画像最新（${latest.ts}）：\`${JSON.stringify(latest.payload)}\``)
  const speed = fold.latest.speed_resilience
  if (speed) lines.push(`- 速度韧性最新（${speed.ts}）：\`${JSON.stringify(speed.payload)}\``)
  const recheck = fold.byConcept.recheck_outcome
  if (recheck) {
    const items = Object.keys(recheck).sort().map(c => `${c}（${recheck[c]!.ts}）`)
    if (items.length) lines.push(`- 复诊结局涉及概念（登记表地址，最新一条）：${items.join('、')}`)
  }
  return lines.join('\n')
}
