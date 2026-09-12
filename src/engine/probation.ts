/**
 * 边实验账本与复诊（#146 / ADR-0033 插入提案生命周期）。
 *
 * 插入边的完整一生：插入=生长批 edit 提案（operator=插入）+ 复诊预注册随提案落字
 * （note.recheck：metric 恰一枚 + days 缺省 10 clamp [5,20]）→ apply 随写入单元登记进
 * 边实验账本（state/边实验.jsonl，每课程一份追加只增：条目 {node, pre, proposal,
 * due, outcome?, decided_at?}，状态集 {probation→proven｜剪除}，confirmed 不设）→
 * 到期由引擎结算钩子自动裁决：达标 proven、不达标自动剪（del_node 归档+恢复原粗边），
 * 零人审。probation 在途的插入边行使不回流练习证据（proven 后恢复；普通前进/旁支
 * 节点不受闸）。
 *
 * 本模块是纯函数层 + 账本 IO 薄层：预注册校验、复诊期 clamp、到期判定与三枚可机判
 * metric（前进恢复/卡点集中度降幅/保留率恢复）、三率（插入率/剪枝率/复诊通过率，
 * 滚动 30 学习日）与韧性闸门映射。全部输入注入式（流水/账本行/学习日序列），同输入
 * 同输出；图与提案的读写归 proposals/门面，这里零图依赖。
 *
 * 账本是状态机索引：复诊预注册的落字处 = 提案 artifact（note.recheck），metric 由
 * 结算钩子按条目 proposal 字段回读——账本不重复存储（与 origin 从 journal 派生同款
 * 纪律）。outcome 缺席 = probation 在途；同一 (proposal, node) 的后行覆盖前行
 * （追加只增，读侧折叠取最新行）。
 */
import type { VaultFs } from './io.ts'
import { dueReviewFirstPushes, trueRetention } from './memory.ts'
import { readJsonlLines } from './io.ts'
import {
  RECHECK_DAYS_MIN, RECHECK_DAYS_MAX,
  RECHECK_CONCENTRATION_DROP, RECHECK_RETENTION_RECOVER, RECHECK_RETENTION_MIN_SAMPLES,
  GROWTH_RATES_WINDOW_DAYS, GROWTH_RATE_MIN_SAMPLE, GROWTH_RECHECK_PASS_FLOOR,
  GROWTH_INSERT_RATE_CAP, GROWTH_SIDEBRANCH_CAP, GROWTH_SIDEBRANCH_CAP_RESILIENT,
  GROWTH_RESILIENCE_HIGH,
} from './params.ts'
import { dayOfTs } from './dates.ts'
import { pctOf } from './grading.ts'
import type { Paths } from './paths.ts'
import type { PracticeRec, ReviewRec } from './types.ts'

// ---- 账本条目（词条「边实验账本」）----

/** 复诊结局：达标 proven；不达标自动剪除。confirmed 已裁不设。 */
export const PROBATION_OUTCOMES = ['proven', '剪除'] as const
export type ProbationOutcome = (typeof PROBATION_OUTCOMES)[number]

/** 边实验账本条目（state/边实验.jsonl 每行）。pre = 登记时插入节点的 pre 声明
 * （原粗边接线来源的登记快照；结算恢复以当时图为准，这里只留审计底稿）。 */
export interface ProbationEntry {
  /** 插入的中继节点。 */
  node: string
  /** 登记时的 pre 声明（恢复原粗边的接线来源底稿）。 */
  pre: string[]
  /** 生长批提案 id：预注册落字处（note.recheck）与登记日（提案 decided）的回读键。 */
  proposal: number
  /** 复诊期（学习日数；默认 10、clamp [5,20]）。 */
  due: number
  /** 结局；缺席 = probation 在途。 */
  outcome?: ProbationOutcome
  /** 结算时刻（ISO）。 */
  decided_at?: string
}

function entryErrors(e: unknown, where: string): string[] {
  const errors: string[] = []
  const d = e as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return [`${where}: 必须是映射`]
  if (typeof d.node !== 'string' || !d.node.trim()) errors.push(`${where}.node 不能为空`)
  if (!Array.isArray(d.pre) || d.pre.some(p => typeof p !== 'string')) errors.push(`${where}.pre 必须是字符串列表`)
  if (!Number.isInteger(d.proposal) || (d.proposal as number) <= 0) errors.push(`${where}.proposal 必须是正整数（生长批提案 id）`)
  if (!Number.isFinite(d.due) || (d.due as number) <= 0) errors.push(`${where}.due 必须是正数（复诊期学习日数）`)
  if (d.outcome !== undefined && !(PROBATION_OUTCOMES as readonly string[]).includes(String(d.outcome))) {
    errors.push(`${where}.outcome 非法 ${JSON.stringify(String(d.outcome))}（允许 ${PROBATION_OUTCOMES.join('/')}；缺席 = probation 在途）`)
  }
  if (d.decided_at !== undefined && typeof d.decided_at !== 'string') errors.push(`${where}.decided_at 必须是 ISO 时间戳`)
  if (d.outcome !== undefined && d.decided_at === undefined) errors.push(`${where}.outcome 落了结局就必须带 decided_at`)
  return errors
}

/** 读账本（缺文件 = Missing 合法空态；JSONL 行级契约归 readJsonlLines 原语，ADR-0053：
 * 撕裂尾行豁免、中段坏行 = Broken；行内容另经 entryErrors 校验，坏形状行跳过——形状
 * 校验比裸 JSON.parse 多一道账本契约，与行级损坏是两层）。 */
export async function readProbationLedger(paths: Paths, root: string, fs: VaultFs): Promise<ProbationEntry[]> {
  const lines = await readJsonlLines<unknown>(paths.probationLedgerPath(root), fs, 'probation')
  const out: ProbationEntry[] = []
  for (const e of lines) {
    if (entryErrors(e, '').length) continue
    out.push(e as ProbationEntry)
  }
  return out
}

/** 追加一条账本记录（只增；写侧严格校验，坏形状 fail loud 不落盘）。 */
export async function appendProbationEntry(paths: Paths, root: string, entry: ProbationEntry, fs: VaultFs): Promise<void> {
  const errors = entryErrors(entry, '边实验账本')
  if (errors.length) throw new Error(`[probation] 账本条目不合格，未落盘。\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
  await fs.mkdir(paths.courseStateDir(root))
  await fs.appendFile(paths.probationLedgerPath(root), JSON.stringify(entry) + '\n')
}

export interface ProbationFold {
  /** 全部行（文件序）。 */
  entries: ProbationEntry[]
  /** 在途复诊（每 (proposal, node) 最新行无 outcome）。node 唯一化。 */
  inFlight: ProbationEntry[]
  /** 已决（最新行带 outcome）。 */
  decided: Array<ProbationEntry & { outcome: ProbationOutcome }>
  /** 节点 → 最新行（行使闸/面板标记的查表）。 */
  byNode: Map<string, ProbationEntry>
}

/** 账本折叠：每 (proposal, node) 取最后一行 = 当前状态（追加只增的读侧口径）。 */
export function foldProbation(entries: ProbationEntry[]): ProbationFold {
  const latest = new Map<string, ProbationEntry>()
  for (const e of entries) latest.set(`${e.proposal}/${e.node}`, e)
  const inFlight: ProbationEntry[] = []
  const decided: Array<ProbationEntry & { outcome: ProbationOutcome }> = []
  const byNode = new Map<string, ProbationEntry>()
  for (const e of latest.values()) {
    if (e.outcome) decided.push(e as ProbationEntry & { outcome: ProbationOutcome })
    else inFlight.push(e)
    byNode.set(e.node, e)
  }
  inFlight.sort((a, b) => a.proposal - b.proposal || a.node.localeCompare(b.node))
  decided.sort((a, b) => (a.decided_at ?? '').localeCompare(b.decided_at ?? '') || a.node.localeCompare(b.node))
  return { entries, inFlight, decided, byNode }
}

// ---- 复诊预注册（随提案落字；metric 恰一枚）----

/** 可机判 metric 小集合（词条「复诊」）：插入批预注册恰一枚。 */
export const RECHECK_METRICS = ['前进恢复', '卡点集中度降幅', '保留率恢复'] as const
export type RecheckMetric = (typeof RECHECK_METRICS)[number]

export interface RecheckPrereg {
  metric: RecheckMetric
  /** 复诊期（学习日数）；缺省 10，声明值 clamp [5,20]（clamp 落 warn 不拒收）。 */
  days?: number
}

export function clampRecheckDays(n: number): number {
  return Math.min(RECHECK_DAYS_MAX, Math.max(RECHECK_DAYS_MIN, Math.round(n)))
}

/** note.recheck 的 schema 门（proposals.validateEditProposal 消费）：恰 {metric, days?}，
 * 未知键拒收；days 非法值拒收、越界值 clamp + warn（默认 10，声明只作快慢调节）。 */
export function recheckPreregOf(raw: unknown): { errors: string[]; warns: string[]; prereg?: RecheckPrereg } {
  const errors: string[] = []
  const warns: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: ['note.recheck: 必须是映射（复诊预注册 = {metric, days?}）'], warns }
  }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter(k => !['metric', 'days'].includes(k))
  if (unknown.length) {
    errors.push(`note.recheck 含未知字段 ${JSON.stringify(unknown)}（只允许 metric/days；预注册恰一枚可机判 metric）`)
  }
  if (!(RECHECK_METRICS as readonly string[]).includes(String(r.metric))) {
    errors.push(`note.recheck.metric: 非法 ${JSON.stringify(String(r.metric))}（允许 ${RECHECK_METRICS.join('/')}）`)
  }
  let days: number | undefined
  if (r.days !== undefined) {
    const n = Number(r.days)
    if (!Number.isFinite(n) || n <= 0) errors.push('note.recheck.days: 必须是正数（复诊期学习日数；缺省 10）')
    else {
      days = clampRecheckDays(n)
      if (days !== n) warns.push(`note.recheck.days ${n} 已 clamp 到 ${days}（复诊期合法区间 [${RECHECK_DAYS_MIN},${RECHECK_DAYS_MAX}] 学习日）`)
    }
  }
  if (errors.length) return { errors, warns }
  return { errors, warns, prereg: { metric: String(r.metric) as RecheckMetric, ...(days !== undefined ? { days } : {}) } }
}

// ---- 到期判定与 metric 结算（纯折叠；全部输入注入式）----

export interface RecheckVerdict { met: boolean; detail: string }

/** 课程学习日序列（去重升序、≤today）：practice ∪ 到期复习首推 的学习日折叠。
 * 复诊期按学习日计（词条「复诊」：默认 10 学习日）——学习日来自课程真实行为。 */
export function learningDaysOf(
  practice: PracticeRec[], reviews: ReviewRec[], course: string, cutoff: number, today: string,
): string[] {
  const days = new Set<string>()
  for (const r of practice) {
    if (r.course !== course) continue
    const d = dayOfTs(r.ts, cutoff)
    if (d <= today) days.add(d)
  }
  for (const r of dueReviewFirstPushes(reviews, cutoff)) {
    if (r.course !== course) continue
    const d = dayOfTs(r.ts, cutoff)
    if (d <= today) days.add(d)
  }
  return [...days].sort()
}

/** 窗内窗口：学习日序列里 < 边界的最后 n 个（不足全取）。 */
function windowBefore(days: string[], boundary: string, n: number): string[] {
  const before = days.filter(d => d < boundary)
  return before.slice(Math.max(0, before.length - n))
}

/** 结算判定输入（全部由门面注入：净额后流水 + 结算时点的图消费面）。 */
export interface RecheckEvaluationInput {
  metric: RecheckMetric
  /** 净额后练习流水（勘误冲正后）。 */
  practice: PracticeRec[]
  reviews: ReviewRec[]
  course: string
  cutoff: number
  /** 登记学习日（提案 decided 日的学习日折叠）。 */
  entryDay: string
  today: string
  /** 复诊期（entry.due，学习日数）。 */
  period: number
  /** 插入节点的下游消费节点（结算时点图的 succ；恢复语义的对面）。 */
  consumers: string[]
  /** 题目 id → invokes 概念（卡点集中度按概念聚合；未标注 null）。 */
  invokesOf: (qid: string) => string | null
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000

/** 窗口错误按 invokes 概念聚合的最大份额（无错误 = null）。 */
function concentrationOf(recs: PracticeRec[], days: Set<string>, cutoff: number, invokesOf: (qid: string) => string | null): number | null {
  const errors = recs.filter(r => r.correct === false && days.has(dayOfTs(r.ts, cutoff)))
  if (!errors.length) return null
  const byConcept = new Map<string | null, number>()
  for (const r of errors) {
    const c = r.qid ? invokesOf(r.qid) : null
    byConcept.set(c, (byConcept.get(c) ?? 0) + 1)
  }
  const top = Math.max(...byConcept.values())
  return round4(top / errors.length)
}

/** 三枚可机判 metric（词条「复诊」）的结算判定：
 * - 前进恢复：复诊窗内某下游消费节点出现答对、且复诊前同节点无答对（停滞被插入打通）。
 * - 卡点集中度降幅：复诊前窗有错误为前提；复诊窗错误清零直接达标，否则最大概念份额
 *   降幅 ≥ RECHECK_CONCENTRATION_DROP。
 * - 保留率恢复：前后窗到期复习样本各 ≥ RECHECK_RETENTION_MIN_SAMPLES，真实保留率
 *   回升 ≥ RECHECK_RETENTION_RECOVER。
 * 窗口口径：前后窗等宽（各 = 预注册复诊期）——结算拖欠时复诊窗不随拖延变宽（预注册
 * 的判据不因结算时点漂移而放水）。数据不满足前提一律不达标（预注册疗效未证 = 剪）
 * ——诚实口径，不造假达标。 */
export function recheckVerdict(input: RecheckEvaluationInput): RecheckVerdict {
  const days = learningDaysOf(input.practice, input.reviews, input.course, input.cutoff, input.today)
  const preDays = new Set(windowBefore(days, input.entryDay, input.period))
  const postDays = new Set(days.filter(d => d >= input.entryDay).slice(0, input.period))
  const inWin = (r: PracticeRec, set: Set<string>): boolean =>
    r.course === input.course && set.has(dayOfTs(r.ts, input.cutoff))

  if (input.metric === '前进恢复') {
    const consumers = new Set(input.consumers)
    const preCorrect = new Set(input.practice.filter(r => r.correct === true && inWin(r, preDays) && consumers.has(r.node)).map(r => r.node))
    const postCorrect = new Set(input.practice.filter(r => r.correct === true && inWin(r, postDays) && consumers.has(r.node)).map(r => r.node))
    const passed = [...postCorrect].filter(c => !preCorrect.has(c)).sort()
    if (passed.length) {
      return { met: true, detail: `复诊期内下游消费节点答对打通：${passed.join('、')}（复诊前无答对）` }
    }
    return { met: false, detail: `复诊期内下游消费节点（${input.consumers.join('、') || '无'}）没有新的答对通过——前进未恢复` }
  }

  if (input.metric === '卡点集中度降幅') {
    const pre = concentrationOf(input.practice, preDays, input.cutoff, input.invokesOf)
    const post = concentrationOf(input.practice, postDays, input.cutoff, input.invokesOf)
    if (pre === null) return { met: false, detail: '复诊前窗无错误作答——卡点前提不存在，降幅无从谈起' }
    if (post === null) return { met: true, detail: `复诊窗内错误清零（复诊前集中度 ${pctOf(pre)}）` }
    const drop = round4(pre - post)
    return drop >= RECHECK_CONCENTRATION_DROP
      ? { met: true, detail: `集中度 ${pctOf(pre)} → ${pctOf(post)}（降幅 ${pctOf(drop)} ≥ ${pctOf(RECHECK_CONCENTRATION_DROP)}）` }
      : { met: false, detail: `集中度 ${pctOf(pre)} → ${pctOf(post)}（降幅 ${pctOf(drop)} < ${pctOf(RECHECK_CONCENTRATION_DROP)}）` }
  }

  // 保留率恢复
  const due = dueReviewFirstPushes(input.reviews, input.cutoff).filter(r => r.course === input.course)
  const pre = trueRetention(due.filter(r => preDays.has(dayOfTs(r.ts, input.cutoff))))
  const post = trueRetention(due.filter(r => postDays.has(dayOfTs(r.ts, input.cutoff))))
  if (pre.pass + pre.fail < RECHECK_RETENTION_MIN_SAMPLES || post.pass + post.fail < RECHECK_RETENTION_MIN_SAMPLES) {
    return { met: false, detail: `到期复习样本不足（复诊前 ${pre.pass + pre.fail}、复诊窗 ${post.pass + post.fail} < ${RECHECK_RETENTION_MIN_SAMPLES}）——保留率恢复无从判定` }
  }
  const gain = round4(post.rate! - pre.rate!)
  return gain >= RECHECK_RETENTION_RECOVER
    ? { met: true, detail: `真实保留率 ${pctOf(pre.rate!)} → ${pctOf(post.rate!)}（回升 ${pctOf(gain)} ≥ ${pctOf(RECHECK_RETENTION_RECOVER)}）` }
    : { met: false, detail: `真实保留率 ${pctOf(pre.rate!)} → ${pctOf(post.rate!)}（回升 ${pctOf(gain)} < ${pctOf(RECHECK_RETENTION_RECOVER)}）` }
}

/** 结算时点的到期判定（纯函数）：课程学习日序列中，登记日（含）之后的学习日数
 * ≥ 复诊期即到期。返回 null = 未到期；否则给出结算用的窗口事实。 */
export function recheckDue(
  learningDays: string[], entryDay: string, period: number,
): { due: true } | { due: false; elapsed: number } {
  const elapsed = learningDays.filter(d => d >= entryDay).length
  return elapsed >= period ? { due: true } : { due: false, elapsed }
}

// ---- 三率与韧性闸门（词条「复诊」调速器；params 集中）----

/** 生长批出材记录（门面从提案 artifact 折叠：算子 + add_node 数 + 登记学习日）。 */
export interface GrowthBatchTally { operator: string; added: number; day: string }

/** 三率（滚动 30 学习日）。null = 窗内无样本（低数据静默，闸门不生效）。 */
export interface GrowthRates {
  window_days: number
  /** 窗内生长批新增节点总数（插入率/旁支占比的分母）。 */
  coach_added: number
  /** 窗内插入登记节点数。 */
  inserted: number
  insert_rate: number | null
  /** 窗内旁支新增节点数（韧性闸门的旁支上限消费）。 */
  sidebranch: number
  sidebranch_share: number | null
  /** 窗内已决复诊数（通过/剪除的分母）。 */
  decided: number
  proven: number
  pruned: number
  recheck_pass_rate: number | null
  prune_rate: number | null
}

export function growthRates(
  registrations: Array<{ entry: ProbationEntry; day: string | null }>,
  decisions: Array<{ entry: ProbationEntry & { outcome: ProbationOutcome }; day: string | null }>,
  tallies: GrowthBatchTally[],
  learningDays: string[],
): GrowthRates {
  const window = new Set(learningDays.slice(Math.max(0, learningDays.length - GROWTH_RATES_WINDOW_DAYS)))
  const inWin = (day: string | null): boolean => day !== null && window.has(day)
  const coachAdded = tallies.filter(t => inWin(t.day))
  const coach_added = coachAdded.reduce((s, t) => s + t.added, 0)
  const inserted = registrations.filter(r => inWin(r.day)).length
  const sidebranch = coachAdded.filter(t => t.operator === '旁支').reduce((s, t) => s + t.added, 0)
  const winDecisions = decisions.filter(d => inWin(d.day))
  const proven = winDecisions.filter(d => d.entry.outcome === 'proven').length
  const pruned = winDecisions.filter(d => d.entry.outcome === '剪除').length
  const decided = proven + pruned
  const rate = (n: number, d: number): number | null => (d > 0 ? round4(n / d) : null)
  return {
    window_days: window.size,
    coach_added,
    inserted,
    insert_rate: rate(inserted, coach_added),
    sidebranch,
    sidebranch_share: rate(sidebranch, coach_added),
    decided,
    proven,
    pruned,
    recheck_pass_rate: rate(proven, decided),
    prune_rate: rate(pruned, decided),
  }
}

// ---- 韧性分映射闸门（插入积极性调速器；结构可判定在代码——受理门/apply 双门消费）----

/** 单课程复诊/实验状态视图（statusJson 附带、/api/probation、learnhub_probation 的
 * 形状；门面 probationViewFor 产出）。 */
export interface ProbationCourseView {
  /** 在途复诊的插入节点（面板「实验中」标记取数；升序）。 */
  in_flight: string[]
  /** 已到复诊期仍未决的插入节点（data-check 到期未决提示类的同口径取数）。 */
  overdue: string[]
  /** 三率（滚动 30 学习日）。 */
  rates: GrowthRates
  /** 韧性闸门现势：resilient=null = 样本不足（低数据静默）；insert_blocks = 「下一个
   * 最小插入批」此刻会被拒收的原因行（教练调速的现势语义）。 */
  gate: {
    resilient: boolean | null
    sidebranch_cap: number
    insert_blocked: boolean
    insert_blocks: string[]
  }
}

export interface GrowthGateVerdict {
  /** 韧性高 = 已决样本足且复诊通过率达 GROWTH_RESILIENCE_HIGH；样本不足 null（低数据静默）。 */
  resilient: boolean | null
  /** 本次生效的旁支占比上限（韧性高放宽 GROWTH_SIDEBRANCH_CAP → RESILIENT）。 */
  sidebranch_cap: number
  /** 拒收行（空 = 放行）；只对 插入/旁支 批生效，其余算子恒放行。 */
  blocks: string[]
}

/** 生长闸门（受理门/apply 双门共用纯函数）：batch = 本批算子与 add_node 数——占比
 * 按「窗内累计 + 本批」计，防贴线连批绕闸。低数据静默（已决样本 < MIN 或窗内无生长），
 * 插入/旁支之外的生长算子永不拦。 */
export function growthGate(
  rates: GrowthRates, batch: { operator: string; adds: number },
): GrowthGateVerdict {
  const lowData = rates.decided < GROWTH_RATE_MIN_SAMPLE || rates.coach_added === 0
  const resilient = lowData ? null : rates.recheck_pass_rate !== null && rates.recheck_pass_rate >= GROWTH_RESILIENCE_HIGH
  const cap = resilient ? GROWTH_SIDEBRANCH_CAP_RESILIENT : GROWTH_SIDEBRANCH_CAP
  const verdict: GrowthGateVerdict = { resilient, sidebranch_cap: cap, blocks: [] }
  if (!batch.adds) return verdict
  if (batch.operator !== '插入' && batch.operator !== '旁支') return verdict

  const coachAfter = rates.coach_added + batch.adds
  if (batch.operator === '插入') {
    if (rates.recheck_pass_rate !== null && rates.decided >= GROWTH_RATE_MIN_SAMPLE
      && rates.recheck_pass_rate < GROWTH_RECHECK_PASS_FLOOR) {
      verdict.blocks.push(
        `插入闸停：复诊通过率 ${pctOf(rates.recheck_pass_rate)} 低于闸门 ${pctOf(GROWTH_RECHECK_PASS_FLOOR)}`
        + `（近 ${rates.window_days} 学习日已决 ${rates.decided} 条，剪除 ${rates.pruned} 条）——先等在途复诊结算或窗口滑动，本轮生长改裁 前进/巩固`)
    }
    const share = (rates.inserted + batch.adds) / coachAfter
    if (rates.insert_rate !== null && share > GROWTH_INSERT_RATE_CAP) {
      verdict.blocks.push(
        `插入率超限：本批后插入占生长新增 ${pctOf(share)} > 上限 ${pctOf(GROWTH_INSERT_RATE_CAP)}`
        + `（近 ${rates.window_days} 学习日生长新增 ${coachAfter} 节、插入 ${rates.inserted + batch.adds} 节）——先消化在途插入，本轮改裁 前进/巩固`)
    }
  } else {
    const share = (rates.sidebranch + batch.adds) / coachAfter
    if (rates.sidebranch_share !== null && share > cap) {
      verdict.blocks.push(
        `旁支超限：本批后旁支占生长新增 ${pctOf(share)} > 上限 ${pctOf(cap)}`
        + `（韧性${resilient === null ? '样本不足' : resilient ? '高·已放宽' : '低'}，近 ${rates.window_days} 学习日生长新增 ${coachAfter} 节）——主线优先，本轮改裁 前进/插入`)
    }
  }
  return verdict
}
