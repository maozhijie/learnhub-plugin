/**
 * D-1 N-of-1 实验引擎（#110 / ADR-0023）：单主体内随机化的自我实验通道——把同一批
 * 合格对象随机分臂，用其真实学习结果测干预效应。人群效应对个体不可信，这正是本
 * 通道存在的理由；仪器已备（逐次复习日志 ADR-0012 + 真实保留率）。
 *
 * ADR-0023 红线（违反即返工）：
 * 1. 实验变量白名单 = 引擎可控的内容/课程设计参数（band_default / session_composition /
 *    ps_i_order / retrieval_point / ci_orchestration）。调度核心（FSRS 转移、推进门、
 *    XP 账本语义）永不作实验变量——canonical 事实源不是赌注。白名单外的参数在结构上
 *    无法配置：propose 只收模板 id，模板只从白名单登记。
 * 2. v1 随机化 = 卡级随机化（card=交换单位）与会话级参数的批次交替（按学习日轮臂）；
 *    不建 ABAB/洗脱期等序列设计。
 * 3. 主结局预登记（调度侧 = 真实保留率）；分析 = 臂间比较 + 置换检验 + 效应量区间
 *    （自助法百分位）；报告用直白话；不做序贯监控；最短观察窗 = 每臂 ≥N 次真实推进；
 *    实验开停手动。
 * 4. 启动走提案-确认制：模板发起 → 引擎给合格卡池与参数 → 学习者逐项确认后开跑。
 * 5. 数据边界：臂标注进复习日志（exp 字段，归因留痕）；零 XP；不进 Mastery/任何
 *    canonical 度量；FSRS 参数优化器默认混训不特判（标注已在，过滤留给未来）。
 *
 * 抽样与聚合全部零依赖纯函数（complexity.ts 先例）；RNG 播种自实验 id，确定性可测。
 */
import { parseDay, daysBetween } from './dates.ts'
import type { ReviewRec } from './types.ts'

// ---- 白名单与模板库 ----

/** 实验变量白名单（ADR-0023 裁决 1，红线）。调度核心参数永不入列。 */
export const NOF1_VARIABLE_WHITELIST = [
  'band_default',
  'session_composition',
  'ps_i_order',
  'retrieval_point',
  'ci_orchestration',
] as const
export type Nof1Variable = (typeof NOF1_VARIABLE_WHITELIST)[number]

/** 一条预置实验模板。unlocked=false = 参数未上线/无双变体通道，模板可见不可发起。 */
export interface Nof1Template {
  id: string
  variable: Nof1Variable
  title: string
  /** 直白话研究问题（报告文案的头）。 */
  question: string
  arms: [string, string]
  arm_labels: Record<string, string>
  /** card = 卡级随机化；batch = 会话级参数按学习日交替（ADR-0023 裁决 2）。 */
  unit: 'card' | 'batch'
  /** 预登记主结局（ADR-0023 裁决 3；v1 全部调度侧）。 */
  outcome: 'true_retention'
  description: string
  unlocked: boolean
  unlock_note?: string
}

/** v1 模板库：只收录已上线参数（难度带默认、会话组成）；PS-I/检索点模板随
 * #81/#93 的双变体内容通道解锁（参数本身已在白名单）。 */
export const NOF1_TEMPLATES: Nof1Template[] = [
  {
    id: 'band_default_std_vs_hard',
    variable: 'band_default',
    title: '难度带默认：标准 vs 挑战',
    question: '把会话默认难度带设为「挑战」时，我的真实保留率会不会更好？',
    arms: ['standard', 'hard'],
    arm_labels: { standard: '默认标准带', hard: '默认挑战带' },
    unit: 'batch',
    outcome: 'true_retention',
    description: '会话未显式选带时，默认带按学习日在标准/挑战间轮换（批次交替）。你随时可以显式选带覆盖默认——显式选择不受实验影响。',
    unlocked: true,
  },
  {
    id: 'session_composition_facet_vs_mixed',
    variable: 'session_composition',
    title: '会话组成：分组呈现 vs 混排',
    question: '复习会话里题卡与我的卡/笔记卡混着来，记忆效果会不会更好？',
    arms: ['faceted', 'mixed'],
    arm_labels: { faceted: '按卡种分组', mixed: '混排' },
    unit: 'batch',
    outcome: 'true_retention',
    description: '复习队列的呈现顺序按学习日在「分组（现状）/混排」间轮换（批次交替）。只改呈现顺序，不改到期与调度。',
    unlocked: true,
  },
  {
    id: 'ps_i_order',
    variable: 'ps_i_order',
    title: 'PS-I 顺序：先做后教 vs 先教后练',
    question: '带着解题缺口听课，记得牢吗？',
    arms: ['problem_first', 'instr_first'],
    arm_labels: { problem_first: '先做后教', instr_first: '先教后练' },
    unit: 'card',
    outcome: 'true_retention',
    description: '节点内容顺序在生成时落定，需要双变体内容通道才能在同批对象上分臂。',
    unlocked: false,
    unlock_note: '随 #81/#93 的双变体内容通道解锁',
  },
  {
    id: 'retrieval_point',
    variable: 'retrieval_point',
    title: '检索点位置与密度',
    question: '检索点前置还是后置、密一点还是疏一点，保留率更高？',
    arms: ['before', 'after'],
    arm_labels: { before: '检索点前置', after: '检索点后置' },
    unit: 'card',
    outcome: 'true_retention',
    description: '检索点位置与密度是项目检索点会话的设计参数。',
    unlocked: false,
    unlock_note: '随 #93 检索点会话落地解锁',
  },
]

export function nof1Template(id: string): Nof1Template | null {
  return NOF1_TEMPLATES.find(t => t.id === id) ?? null
}

// ---- 实验定义与状态（state/实验.json，whole-file 原子写）----

/** 实验定义（apply 提案时生成，start 后不再变动——分臂与结局登记是预注册的）。 */
export interface ExperimentDef {
  id: number
  template: string
  variable: Nof1Variable
  title: string
  question: string
  outcome: 'true_retention'
  arms: [string, string]
  arm_labels: Record<string, string>
  unit: 'card' | 'batch'
  /** 范围课程（null = 全部启用课程）。 */
  scope_course: string | null
  assignment:
    | { kind: 'card'; map: Record<string, string> }
    | { kind: 'batch'; start_day: string; order: [string, string] }
  /** 最短观察窗：每臂 ≥N 次真实推进（ADR-0023 裁决 3，N 随交付票定 = 20）。 */
  per_arm_min: number
  started_day: string
  started_ts: string
  status: 'running' | 'stopped'
  stopped_day?: string
  /** 来源提案 id（留痕）。 */
  proposal: number
}

/** v1 最短观察窗：每臂 20 次真实推进（到期复习口径）。 */
export const NOF1_PER_ARM_MIN = 20

// ---- 确定性 RNG 与分臂 ----

/** mulberry32 播种 RNG（纯确定性——测试与可复现分臂共用）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 卡级随机化（ADR-0023 裁决 2）：同一批合格卡 Fisher–Yates 均分入臂（播种确定）。
 * 卡数不整除时余数给前 |n|mod|arms|| 个臂。 */
export function shuffleAssign(poolKeys: string[], arms: string[], rng: () => number): Record<string, string> {
  const out: Record<string, string> = {}
  const pool = [...poolKeys]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  pool.forEach((key, i) => { out[key] = arms[i % arms.length]! })
  return out
}

/** 批次交替的当日臂：按学习日序数对臂序取模（determinstic、无状态、无需计数器）。 */
export function nof1ArmForDay(def: ExperimentDef, today: string): string {
  if (def.assignment.kind !== 'batch') {
    throw new Error(`[nof1] 实验 #${def.id} 是卡级分臂，没有批次臂。`)
  }
  const start = parseDay(def.assignment.start_day) ?? parseDay(def.started_day)
  const t = parseDay(today)
  if (!start || !t) return def.assignment.order[0]!
  const idx = Math.max(0, daysBetween(t, start))
  return def.assignment.order[idx % def.assignment.order.length]!
}

/** 会话组成「混排」臂的呈现顺序：把我的卡/笔记源卡均匀摊进题卡序列（两列内部
 * 各保序）；没有非题卡时原样返回。分面臂 = 引擎现行排序，不动。 */
export function interleaveBySource<T extends { source?: string }>(cards: T[]): T[] {
  const main: T[] = []
  const other: T[] = []
  for (const c of cards) (c.source ? other : main).push(c)
  if (!main.length || !other.length) return cards
  const out: T[] = []
  const step = main.length / other.length
  let oi = 0
  for (let i = 0; i < main.length; i++) {
    out.push(main[i]!)
    while (oi < other.length && Math.round((oi + 1) * step) <= i + 1) {
      out.push(other[oi]!)
      oi++
    }
  }
  while (oi < other.length) out.push(other[oi++]!)
  return out
}

// ---- 统计：臂间比较 + 置换检验 + 效应量区间 ----

export interface Nof1ArmStats { arm: string; label: string; n: number; rate: number }

/** 单实验的分析输入：每条一次真实推进的二元结局（1 = 过，0 = 败）与其臂。 */
export interface Nof1OutcomeRec { arm: string; pass: boolean }

export interface Nof1Analysis {
  ready: boolean
  per_arm: Nof1ArmStats[]
  need_per_arm: number
  /** 臂间差（臂 B − 臂 A，比例差；未达观察窗为 null）。 */
  diff: number | null
  /** 差的 95% 自助法百分位区间（比例差；未达观察窗为 null）。 */
  ci95: [number, number] | null
  /** 置换检验双侧 p（（含观测）重排比例；未达观察窗为 null）。 */
  p: number | null
  /** 直白话报告（措辞锁个体效应口径，不做人群式显著性宣称）。 */
  message: string
}

const PERM_ITERS = 9999
const BOOT_ITERS = 9999
const round4 = (x: number) => Math.round(x * 10000) / 10000

/** 主分析（纯函数，播种确定）：臂间比较 + 置换检验 + 自助法 95% 区间；未达
 * 最短观察窗时 ready=false，只给进度不给效应判断（ADR-0023：不做序贯监控）。 */
export function analyzeNof1(
  recs: Nof1OutcomeRec[],
  def: Pick<ExperimentDef, 'arms' | 'arm_labels' | 'per_arm_min'>,
  seed: number,
): Nof1Analysis {
  const [armA, armB] = def.arms
  const vals = (arm: string) => recs.filter(r => r.arm === arm).map(r => (r.pass ? 1 : 0))
  const va = vals(armA!)
  const vb = vals(armB!)
  const rate = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0)
  const per_arm: Nof1ArmStats[] = [
    { arm: armA!, label: def.arm_labels[armA!] ?? armA!, n: va.length, rate: round4(rate(va)) },
    { arm: armB!, label: def.arm_labels[armB!] ?? armB!, n: vb.length, rate: round4(rate(vb)) },
  ]
  const ready = va.length >= def.per_arm_min && vb.length >= def.per_arm_min
  const base = {
    ready,
    per_arm,
    need_per_arm: def.per_arm_min,
    diff: null as number | null,
    ci95: null as [number, number] | null,
    p: null as number | null,
    message: '',
  }
  const progress = `还在积累数据：${def.arm_labels[armA!] ?? armA} ${va.length}/${def.per_arm_min} 次、${def.arm_labels[armB!] ?? armB} ${vb.length}/${def.per_arm_min} 次真实推进。样本到了再看结论。`
  if (!ready) {
    return { ...base, message: progress }
  }
  const obsDiff = rate(vb) - rate(va)
  const pool = [...va.map(v => ({ v, arm: 0 })), ...vb.map(v => ({ v, arm: 1 }))]
  const rng = mulberry32(seed)
  const permDiff = (): number => {
    const tags = pool.map(e => (rng() < 0.5 ? 0 : 1))
    let sa = 0
    let sb = 0
    let na = 0
    let nb = 0
    pool.forEach((e, i) => {
      if (tags[i] === 0) { sa += e.v; na++ } else { sb += e.v; nb++ }
    })
    return (sa / na) - (sb / nb)
  }
  let hits = 0
  for (let i = 0; i < PERM_ITERS; i++) {
    if (Math.abs(permDiff()) >= Math.abs(obsDiff) - 1e-12) hits++
  }
  const p = (hits + 1) / (PERM_ITERS + 1)
  // 自助法 95% 百分位区间（同一 RNG 序列续用，播种确定）
  const boots: number[] = []
  for (let i = 0; i < BOOT_ITERS; i++) {
    let sa = 0
    let sb = 0
    for (let j = 0; j < va.length; j++) sa += va[Math.floor(rng() * va.length)]!
    for (let j = 0; j < vb.length; j++) sb += vb[Math.floor(rng() * vb.length)]!
    boots.push(sb / vb.length - sa / va.length)
  }
  boots.sort((a, b) => a - b)
  const q = (x: number) => boots[Math.min(boots.length - 1, Math.max(0, Math.round(x * (boots.length - 1))))]!
  const ci95: [number, number] = [round4(q(0.025)), round4(q(0.975))]
  const pp = Math.round(Math.abs(obsDiff) * 10000) / 100
  const dir = obsDiff > 0
    ? `「${def.arm_labels[armB!] ?? armB}」期间你的真实保留率比「${def.arm_labels[armA!] ?? armA}」高 ${pp} 个百分点`
    : obsDiff < 0
      ? `「${def.arm_labels[armB!] ?? armB}」期间你的真实保留率比「${def.arm_labels[armA!] ?? armA}」低 ${pp} 个百分点`
      : '两臂的真实保留率基本持平'
  const ciText = `95% 区间 ${Math.round(ci95[0]! * 10000) / 100}～${Math.round(ci95[1]! * 10000) / 100} 个百分点`
  const message = `${dir}（${ciText}；置换检验 p=${round4(p)}；每臂各 ${def.per_arm_min}+ 次真实推进）。`
    + '这是你身上的个体效应（N-of-1），不是人群结论；保留率受多因素影响，别把差异全归给这一个参数。'
  return { ...base, diff: round4(obsDiff), ci95, p: round4(p), message }
}

/** 从复习日志提实验结局（预登记口径 = 真实保留率）：只取 auto/self 的到期首次推进，
 * 按 exp 标注归属臂；synthetic（合成初始化）永不入局。 */
export function nof1Outcomes(logs: ReviewRec[], expId: number): Nof1OutcomeRec[] {
  const seen = new Set<string>()
  const out: Nof1OutcomeRec[] = []
  for (const rec of logs) {
    if (rec.rating_source !== 'auto' && rec.rating_source !== 'self') continue
    if (rec.stability_before === null || rec.stability_before === undefined) continue
    if (!rec.exp || rec.exp.id !== expId) continue
    const key = `${rec.course}/${rec.node}/${rec.qid}/${rec.ts.slice(0, 10)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ arm: rec.exp.arm, pass: rec.rating >= 2 })
  }
  return out
}
