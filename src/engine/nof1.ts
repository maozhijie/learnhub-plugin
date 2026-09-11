/**
 * D-1 N-of-1 实验通道（#110 / ADR-0023）：单主体内随机化的自我实验——把同一批
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
import type { VaultFs } from './io.ts'
import { calendarDayOf, daysBetween, nowIsoOf, parseDay } from './dates.ts'
import type { Clock } from './clock.ts'
import { nodeKeyOf, sourceKeyOf } from './types.ts'
import { NOF1_VARIABLE_WHITELIST } from './types.ts'
import type { ExperimentDef, Nof1Variable } from './types.ts'
import type { JournalRec } from './types.ts'
import { YAML } from './yaml.ts'
import { atomicWrite, readLearnhubConfig, writeLearnhubConfig } from './io.ts'
import { runWriteUnit } from './write-unit.ts'
import { normalizeSleepAdvice } from './sleep.ts'
import { dueReviewFirstPushes, trueRetention } from './memory.ts'
import { retentionBand, bandDistribution, execRatingDistribution, thermostatSuggestions } from './thermostat.ts'
import { SANDBOX_RUNS, SANDBOX_DEFAULT_WEEKS, SANDBOX_WORDING, SANDBOX_NODE_EST_DEFAULT, simulateRun, aggregateRuns } from './sandbox.ts'
import { effectiveStage } from './audit.ts'
import type { FSRS } from 'ts-fsrs'
import type { ReviewRec, Fm, CourseEntry, ProposalRec } from './types.ts'
import type { Paths } from './paths.ts'
import type { BandRec } from './coach.ts'
import type { Registry } from './registry.ts'
import type { Projects } from './projects.ts'
import type { QuestionBank, BankDoc } from './question-bank.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { SedimentEvent, SedimentFold, SedimentKind, SedimentTier } from './sediment.ts'
import type { BandPref } from './adaptive.ts'
import type { SandboxDoc, SandboxCard, SandboxNode, SandboxPlan, SandboxCurvePoint } from './sandbox.ts'
import type { ThermostatDoc } from './thermostat.ts'

// ---- 白名单与模板库 ----

// 白名单与实验定义住 types.ts（store 反向 type-import 的中立层，#152 刀 2）；
// 此处原路径 re-export，store/门面/views 的既有导入路径不晃。
export { NOF1_VARIABLE_WHITELIST } from './types.ts'
export type { Nof1Variable, ExperimentDef } from './types.ts'

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
  /** 预登记主结局（ADR-0023 裁决 3）：调度侧 = 真实保留率（v1 模板全部此项）；
   * 练习侧 = EMA（#88/#89 证据通道已上线，分析器与练习侧模板登记待后票）。 */
  outcome: 'true_retention' | 'practice_ema'
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
    const tags = pool.map(() => (rng() < 0.5 ? 0 : 1))
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

/** 从复习日志提实验结局（预登记口径 = 真实保留率）：只取 auto/self 的「有旧卡」
 * 首次推进（真实保留率口径——与 memory.dueReviewFirstPushes 同一过滤：到期复习 =
 * 非 synthetic 且 stability_before 非空），按 exp 标注归属臂。 */
export function nof1Outcomes(logs: ReviewRec[], expId: number): Nof1OutcomeRec[] {
  const seen = new Set<string>()
  const out: Nof1OutcomeRec[] = []
  for (const rec of logs) {
    if (rec.rating_source !== 'auto' && rec.rating_source !== 'self') continue
    if (rec.stability_before === null || rec.stability_before === undefined) continue
    if (!rec.exp || rec.exp.id !== expId) continue
    const key = `${sourceKeyOf(rec.course, rec.node, rec.qid)}/${calendarDayOf(rec.ts)}` // 去重桶：出处时间戳的日历日
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ arm: rec.exp.arm, pass: rec.rating >= 2 })
  }
  return out
}


// ---- Lab 子系统（#152 刀 2 / ADR-0043）：D 系列实验台域——D1 N-of-1 实验、D2 恒温器、
// D3 沙盘、D4 睡眠配置。住领主文件 nof1.ts（聚合+转发模式）；跨子系统依赖经结构化
// 窄面 LabDeps 由门面注入（运行时回引门面，类型面零门面导入——R6 执法不破）。

/** Lab 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
/** store 的结构化窄面：不 import store——store 反向 type-import 本域的 ExperimentDef，
 * 再引 Store 类型就重造 receipts⇄store 类环（R7 实测拦截后的解法）。 */
export interface LabStore {
  loadExperiments(): Promise<ExperimentDef[]>
  saveExperiments(list: ExperimentDef[]): Promise<void>
  createProposal(kind: ProposalRec['kind'], course: string, summary: string, artifact: string): Promise<number>
  updateProposal(id: number, patch: Partial<ProposalRec>): Promise<ProposalRec | null>
  takePending(kind: ProposalRec['kind'], pid?: number): Promise<ProposalRec>
  reviewLogAll(): Promise<ReviewRec[]>
  bandRecsAll(): Promise<BandRec[]>
  /** 写入单元的 journal sink（#176：experimentStop 末尾的 write_unit 条目）。 */
  appendJournal(rec: JournalRec): Promise<JournalRec>
}

export interface LabDeps {
  /** 时钟端口（#175 阶段①）：实验 started_ts/decided 戳。 */
  clock: Clock
  /** vault 存储端口（#175 阶段②）。 */
  fs: VaultFs
  store: LabStore
  paths: Paths
  registry: Pick<Registry, 'resolve'>
  projects: Pick<Projects, 'list'>
  bank: Pick<QuestionBank, 'load'>
  sched(courseRoot: string | null): Promise<FSRS>
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  scanCourseBanks(c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>): Promise<void>
  sedimentAppend(kind: SedimentKind, tier: SedimentTier, payload: Record<string, unknown>, concept?: string): Promise<SedimentEvent>
  sedimentFold(): Promise<SedimentFold>
  sedimentRebuildProfile(): Promise<string>
}

export class LabSubsystem {
  constructor(private e: LabDeps) {}


  /** 实验模板库（含未解锁项——可见不可发起；白名单外参数结构上无法配置：propose
   * 只收模板 id，模板只从白名单登记）。 */
  async experimentTemplates(): Promise<Nof1Template[]> {
    return NOF1_TEMPLATES
  }

  async experimentList(): Promise<ExperimentDef[]> {
    return this.e.store.loadExperiments()
  }

  /** 当前在跑的实验（v1 一次一个；开停手动）。 */
  private async nof1Active(): Promise<ExperimentDef | null> {
    const list = await this.e.store.loadExperiments()
    return list.find(e => e.status === 'running') ?? null
  }

  /** 实验对复习队列的当日生效臂（批次交替，ADR-0023 裁决 2）。 */
  async nof1QueueEffect(
    today: string,
  ): Promise<{ id: number; variable: Nof1Variable; arm: string } | null> {
    const exp = await this.nof1Active()
    if (!exp || exp.assignment.kind !== 'batch') return null
    return { id: exp.id, variable: exp.variable, arm: nof1ArmForDay(exp, today) }
  }

  /** 推进落复习日志时的臂标注（ADR-0023 裁决 5）：batch = 当日臂（范围内课程）；
   * card = 卡级分臂 map。只是归因留痕——不改变推进、XP、Mastery；优化器混训不特判。 */
  async expTag(
    courseName: string, node: string, qid: string, today: string,
  ): Promise<{ id: number; arm: string } | null> {
    const exp = await this.nof1Active()
    if (!exp) return null
    if (exp.scope_course && exp.scope_course !== courseName) return null
    if (exp.assignment.kind === 'card') {
      const arm = exp.assignment.map[sourceKeyOf(courseName, node, qid)]
      return arm ? { id: exp.id, arm } : null
    }
    return { id: exp.id, arm: nof1ArmForDay(exp, today) }
  }

  /** 合格卡池（已调度未归档题卡，范围过滤）：卡级随机化的分臂对象与提案预览口径。 */
  private async nof1PoolKeys(scopeCourse: string | null): Promise<string[]> {
    const keys: string[] = []
    for (const c of await this.e.enabledCourses()) {
      if (scopeCourse && c.name !== scopeCourse) continue
      await this.e.scanCourseBanks(c, async (node, bank) => {
        for (const q of bank.questions) {
          if (!q.archived && q.fsrs?.reps) keys.push(`${c.name}/${node}/${q.id}`)
        }
      })
    }
    return keys
  }

  /** 提案-确认制第一步：模板发起 → pending experiment 提案（参数与合格卡池随提案
   * 给学习者过目）。白名单外/未解锁模板 fail loud；已有实验在跑拒绝（v1 单实验）。 */
  async experimentPropose(
    templateId: string, course?: string,
  ): Promise<{ proposal: number; template: string; title: string; pool: number; scope_course: string | null }> {
    const tpl = nof1Template(templateId)
    if (!tpl) {
      throw new Error(`[nof1] 没有模板「${templateId}」（可用：${NOF1_TEMPLATES.map(t => t.id).join('、')}）。白名单外参数无法配置为实验变量（ADR-0023）。`)
    }
    if (!tpl.unlocked) {
      throw new Error(`[nof1] 模板「${tpl.title}」未解锁：${tpl.unlock_note ?? '参数未上线'}。`)
    }
    if (course) await this.e.registry.resolve(course)
    const running = await this.nof1Active()
    if (running) {
      throw new Error(`[nof1] 实验 #${running.id}（${running.title}）还在跑——v1 一次一个实验，先 learnhub_experiment_stop 再开新的。`)
    }
    const pool = (await this.nof1PoolKeys(course ?? null)).length
    const armText = tpl.arms.map(a => tpl.arm_labels[a] ?? a).join(' / ')
    const summary = `${tpl.title}（N-of-1 提案）：主结局=真实保留率；臂 ${armText}；${tpl.unit === 'batch' ? '按学习日轮臂（批次交替）' : '卡级随机分臂'}；合格卡池 ${pool} 张；最短观察窗每臂 ${NOF1_PER_ARM_MIN} 次真实推进。确认后开跑。`
    const doc = {
      template: tpl.id, variable: tpl.variable, title: tpl.title, question: tpl.question,
      outcome: tpl.outcome, arms: tpl.arms, arm_labels: tpl.arm_labels, unit: tpl.unit,
      scope_course: course ?? null, per_arm_min: NOF1_PER_ARM_MIN, pool,
    }
    const scope = course ?? '全部课程'
    const pid = await this.e.store.createProposal('experiment', scope, summary, '')
    const path = this.e.paths.proposalArtifactPath(pid, 'experiment', scope)
    await atomicWrite(path, YAML.stringify(doc), this.e.fs)
    await this.e.store.updateProposal(pid, { artifact: path })
    return { proposal: pid, template: tpl.id, title: tpl.title, pool, scope_course: course ?? null }
  }

  /** 确认开跑（提案 apply）：重新校验产物 → 生成实验定义与分臂（batch 起始日=今天；
   * card 播种自提案 id 的确定性均分）→ 写 state/实验.json。提案产物失效 fail loud。 */
  async experimentApply(pid?: number): Promise<{ id: number; title: string; arm_today: string }> {
    const prop = await this.e.store.takePending('experiment', pid)
    if (await this.nof1Active()) {
      throw new Error(`[nof1-apply] 已有实验在跑——v1 一次一个，先 stop 再开。`)
    }
    let doc: {
      template?: string; variable?: string; title?: string; question?: string
      outcome?: string; arms?: string[]; arm_labels?: Record<string, string>
      unit?: string; scope_course?: string | null; per_arm_min?: number
    }
    try {
      doc = YAML.parse(await this.e.fs.readFile(prop.artifact)) as typeof doc
    } catch (err) {
      throw new Error(`[nof1-apply] 提案产物无法解析（${prop.artifact}）：${err instanceof Error ? err.message : String(err)}`)
    }
    const tpl = doc.template ? nof1Template(doc.template) : null
    if (!tpl || tpl.variable !== doc.variable || !NOF1_VARIABLE_WHITELIST.includes(doc.variable as Nof1Variable)
      || (doc.outcome !== 'true_retention' && doc.outcome !== 'practice_ema')
      || doc.unit !== tpl.unit
      || !Array.isArray(doc.arms) || doc.arms.length !== 2 || doc.arms[0] !== tpl.arms[0] || doc.arms[1] !== tpl.arms[1]
      || !doc.title) {
      throw new Error(`[nof1-apply] 提案产物与模板不一致或白名单校验失败（template=${String(doc.template)} variable=${String(doc.variable)}）。`)
    }
    const { today } = await this.e.learningDay()
    const list = await this.e.store.loadExperiments()
    const def: ExperimentDef = {
      id: list.reduce((m, e) => Math.max(m, e.id), 0) + 1,
      template: tpl.id, variable: tpl.variable, title: doc.title,
      question: doc.question ?? tpl.question,
      outcome: doc.outcome,
      arms: [doc.arms[0]!, doc.arms[1]!], arm_labels: doc.arm_labels ?? tpl.arm_labels,
      unit: tpl.unit, scope_course: doc.scope_course ?? null,
      assignment: tpl.unit === 'card'
        ? { kind: 'card', map: shuffleAssign(await this.nof1PoolKeys(doc.scope_course ?? null), doc.arms, mulberry32(1000 + prop.id)) }
        : { kind: 'batch', start_day: today, order: [doc.arms[0]!, doc.arms[1]!] },
      per_arm_min: doc.per_arm_min ?? NOF1_PER_ARM_MIN,
      started_day: today, started_ts: nowIsoOf(this.e.clock.nowMs()), status: 'running', proposal: prop.id,
    }
    list.push(def)
    await this.e.store.saveExperiments(list)
    await this.e.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date(this.e.clock.nowMs()).toISOString(),
      decision_note: `实验 #${def.id} 开跑（今日臂 ${nof1ArmForDay(def, today)}）`,
    })
    return { id: def.id, title: def.title, arm_today: nof1ArmForDay(def, today) }
  }

  /** 手动停（ADR-0023：实验开停手动）。停 = 定稿（#150 结局落沉淀正典）：结局分析
   * 出生即写沉淀正典（kind=nof1_outcome、immediate 档；未达观察窗的如实进度态也落——
   * 正典记录发生了什么，不造假结论），学习者档案投影重建。
   * 写入单元（#176）：步骤顺序照今天的声明——「结局事件 → 停标志落盘 → 投影重建」，
   * 崩溃后重试收敛（结局步骤的 done 幂等判据 = 同实验 id 已有结局事件即续段）。
   * 失败：任一步抛错上抛中止，不回滚不续跑（恢复走 dataCheck/doctor）。 */
  async experimentStop(id?: number): Promise<ExperimentDef> {
    const list = await this.e.store.loadExperiments()
    const hit = id !== undefined ? list.find(e => e.id === id) : list.find(e => e.status === 'running')
    if (!hit) throw new Error(`[nof1-stop] 没有可停的实验${id !== undefined ? `（实验 #${id} 不存在）` : ''}。`)
    if (hit.status !== 'running') throw new Error(`[nof1-stop] 实验 #${hit.id} 已是 ${hit.status}。`)
    const { today } = await this.e.learningDay()
    const analysis = await this.nof1AnalysisOf(hit)
    await runWriteUnit('experimentStop', {
      clock: this.e.clock,
      journal: rec => this.e.store.appendJournal(rec),
      steps: [
        {
          name: '结局事件落沉淀正典',
          done: async () => {
            const fold = await this.e.sedimentFold()
            return fold.events.some(e => e.kind === 'nof1_outcome' && e.payload.experiment === hit.id)
          },
          run: async () => {
            await this.e.sedimentAppend('nof1_outcome', 'immediate', {
        experiment: hit.id,
        template: hit.template,
        variable: hit.variable,
        title: hit.title,
        question: hit.question,
        outcome: hit.outcome,
        arms: hit.arms,
        arm_labels: hit.arm_labels,
        unit: hit.unit,
        started_day: hit.started_day,
        stopped_day: today,
        ready: analysis.ready,
        per_arm: analysis.per_arm,
        diff: analysis.diff,
        ci95: analysis.ci95,
        p: analysis.p,
        message: analysis.message,
            })
          },
        },
        {
          name: '实验清单停标志落盘',
          run: async () => {
            hit.status = 'stopped'
            hit.stopped_day = today
            await this.e.store.saveExperiments(list)
          },
        },
        { name: '学习者档案投影重建', run: async () => { await this.e.sedimentRebuildProfile() } },
      ],
    })
    return hit
  }

  /** 实验结局分析（report 与 stop 共用的唯一口径，#150）：调度侧二元结局可析
   * （种子约定 9000+id 与报告一致）；练习侧（EMA）分析器待后票，占位结论如实落档。 */
  private async nof1AnalysisOf(hit: ExperimentDef): Promise<Nof1Analysis> {
    if (hit.outcome !== 'true_retention') {
      return {
        ready: false, per_arm: [], need_per_arm: hit.per_arm_min,
        diff: null, ci95: null, p: null,
        message: '该实验预登记了练习侧结局（EMA）：EMA 分析器与练习侧模板登记待后票落地；臂标注已在积累。',
      }
    }
    const recs = nof1Outcomes(await this.e.store.reviewLogAll(), hit.id)
    return analyzeNof1(recs, hit, 9000 + hit.id)
  }

  /** 直白话报告（臂间比较+置换检验+效应量区间；ADR-0023 裁决 3）。未达最短观察窗
   * 只报进度不做效应判断；running = 期中读数，stopped = 定稿。练习侧结局（EMA）
   * 的证据通道已上线（#88/#89），登记在案但 v1 分析器只支持调度侧二元结局。 */
  async experimentReport(id?: number): Promise<{ experiment: ExperimentDef; analysis: Nof1Analysis }> {
    const list = await this.e.store.loadExperiments()
    const hit = id !== undefined
      ? list.find(e => e.id === id)
      : list.find(e => e.status === 'running') ?? list[list.length - 1]
    if (!hit) throw new Error('[nof1-report] 还没有实验——先从模板库发起（learnhub_experiment_propose）。')
    return { experiment: hit, analysis: await this.nof1AnalysisOf(hit) }
  }


  /** A1 目标难度带默认值（state/learnhub.json 的 band_default；null = 纯 A1 自动）。
   * 消费链：会话显式选带 > 实验当日臂 > 此默认值 > 纯 A1。 */
  async bandDefault(): Promise<BandPref | null> {
    const doc = await readLearnhubConfig(this.e.paths.learnhubConfigPath, this.e.fs) as {
      band_default?: string
    }
    return ['easy', 'standard', 'hard'].includes(doc.band_default ?? '')
      ? doc.band_default as BandPref : null
  }

  /** 写默认带（既有配置入口——恒温器建议显式确认后落到这里；null = 清除回纯 A1）。 */
  async setBandDefault(band: string | null): Promise<{ band_default: BandPref | null }> {
    if (band !== null && !['easy', 'standard', 'hard'].includes(band)) {
      throw new Error(`[band-default] band 只能是 easy/standard/hard 或 null（收到 ${String(band)}）。`)
    }
    const prev = await readLearnhubConfig(this.e.paths.learnhubConfigPath, this.e.fs)
    const next = { ...prev, band_default: band }
    if (band === null) delete next.band_default
    await writeLearnhubConfig(this.e.paths.learnhubConfigPath, next, this.e.fs)
    return { band_default: band as BandPref | null }
  }

  /** 跨区挑战点仪表（只读聚合，零新度量；ADR-0024）。 */
  async thermostatView(today?: string): Promise<ThermostatDoc> {
    const { today: learningToday, cutoff } = await this.e.learningDay()
    today ??= learningToday
    const logs = await this.e.store.reviewLogAll()
    const retention = trueRetention(dueReviewFirstPushes(logs, cutoff))
    const bands = bandDistribution(await this.e.store.bandRecsAll(), today)
    const defaultBand = await this.bandDefault()
    const suggestions = thermostatSuggestions({
      retention: { rate: retention.rate, real: retention.real },
      bands, defaultBand,
    })
    const projects = await this.e.projects.list()
    return {
      date: today,
      course_region: {
        retention,
        retention_band: retentionBand(retention.rate),
        band_choices: bands,
      },
      unbounded_region: {
        execution_ratings: execRatingDistribution(logs, today),
        note: '执行事件评级分布——数据源随 U 区执行事件通道（#89）落地；落地前为合法空态。',
      },
      project_region: {
        status: 'deferred',
        note: '项目区观测（Mastery 交叉 2×2 + 档内表现）随 P-7（#96）后补，不阻塞 v1；下表只聚合展示各项目当前渐退档。',
        projects: projects.map(p => ({ id: p.id, name: p.name, tier: p.tier })),
      },
      knobs: [
        { knob: 'band_default', title: 'A1 目标难度带默认值', status: '可确认生效（既有配置入口）', current: defaultBand },
        { knob: 'retrieval_density', title: '检索点密度', status: '未上线（随 #93 检索点会话落地解锁）' },
        { knob: 'fading_tier', title: '渐退档移动提议', status: '聚合展示：档位移动走项目域显式入口（projectSetTier），v1 无待决移动提议对象，此处只汇总各项目当前档', current: projects.map(p => `${p.name}:${p.tier}`).join('、') || null },
      ],
      suggestions,
    }
  }

  /** 建议的显式确认入口（ADR-0024：建议采用走既有入口、逐条显式确认）。只受理
   * 当前仪表正在给出的建议 id——陈旧/伪造 id 拒绝；引擎内无任何自动调用路径。 */
  async thermostatApply(suggestionId: string): Promise<{ applied: string; band_default: BandPref | null }> {
    const view = await this.thermostatView()
    const hit = view.suggestions.find(s => s.id === suggestionId)
    if (!hit) {
      throw new Error(`[thermostat] 建议「${suggestionId}」不在当前建议清单里（可能已过期或从未给出）——恒温器只逐条确认当前建议，不受理任意参数写入。`)
    }
    await this.setBandDefault(hit.apply.value)
    return { applied: hit.id, band_default: hit.apply.value }
  }


  /** 按计划推演：现有 FSRS 的 R 作伯努利抽样推进 + mastery 派生原样复用，
   * SANDBOX_RUNS 次蒙特卡洛。输出分布（50/80% 分位带）；措辞锁「模型推演，
   * 非承诺」。零写侧——不进门禁、不进调度、不改账本，不给可行性判定。 */
  async sandboxRun(input: {
    minutesPerDay: number
    weeks?: number
    course?: string
    nodes?: string[]
  }): Promise<SandboxDoc> {
    if (!Number.isFinite(input.minutesPerDay) || input.minutesPerDay <= 0) {
      throw new Error(`[sandbox] minutesPerDay 必须是正数（收到 ${String(input.minutesPerDay)}）。`)
    }
    const weeks = Math.min(26, Math.max(1, Math.round(input.weeks ?? SANDBOX_DEFAULT_WEEKS)))
    const plan: SandboxPlan = { minutesPerDay: Math.round(input.minutesPerDay), weeks }
    const { today } = await this.e.learningDay()
    const courses = input.course ? [await this.e.registry.resolve(input.course)] : await this.e.enabledCourses()
    const nodeFilter = input.nodes?.length ? new Set(input.nodes) : null
    const { cards, nodes, scheds } = await this.sandboxPopulation(courses, nodeFilter)
    // 蒙特卡洛：播种确定（同输入同分布）；每门课注入自己的调度器实例（与调度同源，
    // R 参数跟课走——与 reviewQueue/memoryHealth 同一 sched 通道）。
    const { curve, map } = this.mcAggregate(plan, cards, nodes, today, scheds, courses[0]!.name)
    return {
      wording: SANDBOX_WORDING,
      date: today,
      plan,
      runs: SANDBOX_RUNS,
      scope: { courses: courses.map(c => c.name), nodes: nodes.length },
      curve,
      map,
      assumptions: [
        `每次复习计 1 分钟；每日预算 ${plan.minutesPerDay} 分钟，耗尽后剩余到期卡顺延（与真实欠账一致）。`,
        '复习通过率 = 当前 FSRS 模型的可提取性 R 伯努利抽样：过记 Good、败记 Again；推进与调度同一套函数（各课程用自己的调度器参数）。',
        '新节点按课程图序在预算内引入（est 分钟摊日），学成记一次合成 Good；休眠题随学成入场。',
        '练习证据（EMA/正确率）冻结为当前值——沙盘只模拟「记」的维持，不模拟「练」的进步。',
      ],
    }
  }

  /** 沙盘推演的总体采集（sandboxRun 与罗盘 ETA 挂载共用，#143）：模拟卡 + 模拟节点
   * + 各课调度器实例。skipped（学习者自报已会）不进推演范围；未开始节点带 null 代表
   * 卡随引入学成创建；题库缺失 = 合法空态。 */  async sandboxPopulation(
    courses: CourseEntry[], nodeFilter: Set<string> | null,
  ): Promise<{
    cards: SandboxCard[]
    nodes: SandboxNode[]
    scheds: Map<string, FSRS>
  }> {
    const cards: SandboxCard[] = []
    const nodes: SandboxNode[] = []
    const scheds = new Map<string, FSRS>()
    for (const c of courses) {
      scheds.set(c.name, await this.e.sched(this.e.paths.courseRoot(c.root)))
      const { graph, state } = await this.e.loadView(c)
      for (const name of graph.order) {
        if (nodeFilter && !nodeFilter.has(name)) continue
        const fm = state[name]
        // skipped = 学习者自报已会：不在推演范围（与推荐口径一致）
        if (effectiveStage(state, name) === 'skipped') continue
        const started = Boolean(fm?.fsrs?.reps)
        nodes.push({
          course: c.name, node: name,
          est: graph.estOf[name] ?? SANDBOX_NODE_EST_DEFAULT,
          practice: fm?.practice ?? { attempts: 0, correct: 0 },
          ema: fm?.practice_ema,
          started, skipped: false,
        })
        // 节点代表卡（有起点状态带 fs；未开始 = null，随引入学成创建）
        cards.push({
          key: `node:${c.name}/${name}`, course: c.name, node: name, kind: 'node',
          fs: started ? fm!.fsrs! : null,
        })
        try {
          const bank = await this.e.bank.load(this.e.paths.courseRoot(c.root), name)
          for (const q of bank.questions) {
            if (q.archived) continue
            cards.push({ key: `${c.name}/${name}/${q.id}`, course: c.name, node: name, kind: 'question', fs: q.fsrs ?? null })
          }
        } catch {
          // 该节点还没有题库：合法空态（practice 节点常态）
        }
      }
    }
    return { cards, nodes, scheds }
  }

  /** 蒙特卡洛循环（sandboxRun 与罗盘 ETA 挂载共用，#143）：SANDBOX_RUNS 次、播种
   * 约定 7000+i·7919（同输入同分布）；无该课调度器时回退 fallbackCourse 的实例。 */
  private mcRuns(
    plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string,
    scheds: Map<string, FSRS>, fallbackCourse: string,
  ): Array<{ endByNode: number[]; curve: number[] }> {
    const runs: Array<{ endByNode: number[]; curve: number[] }> = []
    for (let i = 0; i < SANDBOX_RUNS; i++) {
      runs.push(simulateRun(plan, cards, nodes, today, {
        schedFor: course => scheds.get(course) ?? scheds.get(fallbackCourse)!,
        rng: mulberry32(7000 + i * 7919),
      }))
    }
    return runs
  }

  /** 蒙特卡洛 + 聚合一步（三调用点共用：sandboxRun / 罗盘 ETA 折叠 / 双沙盘仲裁参照）。 */
  mcAggregate(
    plan: SandboxPlan, cards: SandboxCard[], nodes: SandboxNode[], today: string,
    scheds: Map<string, FSRS>, fallbackCourse: string,
  ): { curve: SandboxCurvePoint[]; map: Array<{ node: string; p50: number; p80: number }> } {
    return aggregateRuns(
      this.mcRuns(plan, cards, nodes, today, scheds, fallbackCourse),
      nodes.map(n => nodeKeyOf(n.course, n.node)), plan.weeks,
    )
  }


  /** 读睡眠耦合建议配置：enabled=false 时推荐里不再出现「睡前练、醒后验」建议层。 */
  async sleepAdviceConfig(): Promise<{ enabled: boolean }> {
    const doc = await readLearnhubConfig(this.e.paths.learnhubConfigPath, this.e.fs) as {
      sleep?: { enabled?: boolean }
    }
    return normalizeSleepAdvice(doc.sleep)
  }

  /** 写睡眠耦合建议配置（原子替换，保留配置文件其他字段）。 */
  async setSleepAdviceConfig(patch: { enabled?: boolean }): Promise<{ enabled: boolean }> {
    const prev = await readLearnhubConfig(this.e.paths.learnhubConfigPath, this.e.fs)
    const next = await this.sleepAdviceConfig().then(cur => ({ enabled: patch.enabled ?? cur.enabled }))
    await writeLearnhubConfig(this.e.paths.learnhubConfigPath, { ...prev, sleep: next }, this.e.fs)
    return next
  }
}
