/**
 * 沉淀层（#139 / ADR-0034）：学习模型状态的唯一事实源与连续性载体（第四存储域）。
 *
 * 两个结构保证：
 * - **出生即写**：泛用模型数据（FSRS 参数、校准画像、速度韧性、内容质量结论、
 *   复诊结局、图修复史/概念级先验、N-of-1 实验结局）出生即追加进正典，断裂零蒸馏——
 *   v1→v2 的断裂蒸馏桥已裁取消（#151 不予修复、ADR-0036）。
 * - **读侧单向**：消费一律从正典折叠（foldSediment），禁止再读内容层旧居所——
 *   FSRS 参数文件已退役为缓存（正典在沉淀，删缓存不丢事实）。
 *
 * 形态 = 追加 jsonl 正典（学习中心/沉淀/沉淀.jsonl，小到单文件可抄走）+ 学习者
 * 档案.md 可读投影（纯派生、每次结算重建、手编必被覆盖）+ legacy 分区（只保留、
 * 零消费路径）。永不自动删除；内容层任何不可逆操作（断裂/重生成/硬删除）不伤它。
 *
 * 即时/周分档：immediate 事件按最新态折叠；weekly 事件按学习周（周一锚定）分组、
 * 中心级可重折——追加正典天然可重放，重折 = 重新 foldSediment。
 * 沉淀记录用概念地址（登记表条目名）书写，不用节点/题目 id（跨断裂存活的档案
 * 坐标系，CONTEXT.md「概念」词条）；addresser 尚未接线（#141 登记表、#146 复诊、
 * #145 生长批），concept 字段缺席合法。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite, readJsonlLines } from './io.ts'
import { calendarDayOf, weekStartOf } from './dates.ts'
import { nowIsoOf } from './dates.ts'
import type { Paths } from './paths.ts'

/** 七类事件（#139 事件骨架；#150 增 N-of-1 实验结局——停=定稿，个体效应结论出生即写）。 */
export const SEDIMENT_KINDS = [
  'fsrs_params',
  'calibration',
  'speed_resilience',
  'content_quality',
  'recheck_outcome',
  'graph_repair',
  'nof1_outcome',
] as const
export type SedimentKind = (typeof SEDIMENT_KINDS)[number]

/** 分档：immediate = 最新态语义（新事件覆盖旧态的读法）；weekly = 周档流水
 * （按学习周分组保留历史，中心级可重折）。 */
export type SedimentTier = 'immediate' | 'weekly'

/** 正典事件。payload 形态随 kind 演变（追加正典 + 折叠读侧，字段演进不破坏历史）。 */
export interface SedimentEvent {
  ts: string
  kind: SedimentKind
  tier: SedimentTier
  payload: Record<string, unknown>
  /** 概念地址（登记表条目名）：复诊结局、概念级先验等按概念书写的记录用；缺席合法。 */
  concept?: string
}

export type SedimentEventInput = Omit<SedimentEvent, 'ts'> & { ts?: string }

export function isSedimentKind(v: unknown): v is SedimentKind {
  return typeof v === 'string' && (SEDIMENT_KINDS as readonly string[]).includes(v)
}

/** 追加一条沉淀事件（出生即写的唯一入口）：落正典 + 确保 legacy 分区在盘。 */
export async function appendSedimentEvent(paths: Paths, event: SedimentEventInput, nowMs: number, fs: VaultFs): Promise<SedimentEvent> {
  if (!isSedimentKind(event.kind)) {
    throw new Error(`[sediment] 非法 kind: ${String(event.kind)}（允许 ${SEDIMENT_KINDS.join('/')}）`)
  }
  if (event.tier !== 'immediate' && event.tier !== 'weekly') {
    throw new Error(`[sediment] 非法 tier: ${String(event.tier)}（只允许 immediate/weekly）`)
  }
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    throw new Error('[sediment] payload 必须是映射（事件载荷；形态随 kind 演变，最小 {}）')
  }
  if (event.concept !== undefined && (typeof event.concept !== 'string' || !event.concept.trim())) {
    throw new Error('[sediment] concept（概念地址）缺席合法，给了就必须是非空字符串')
  }
  const full: SedimentEvent = {
    ts: event.ts ?? nowIsoOf(nowMs),
    kind: event.kind,
    tier: event.tier,
    payload: event.payload,
    ...(event.concept !== undefined ? { concept: event.concept.trim() } : {}),
  }
  await fs.mkdir(paths.sedimentDir)
  await fs.mkdir(paths.sedimentLegacyDir)
  await fs.appendFile(paths.sedimentPath, JSON.stringify(full) + '\n')
  return full
}

/** 读正典（读侧契约归 readJsonlLines 原语，ADR-0053：缺文件 = Missing 合法空态、
 * 撕裂尾行豁免、中段坏行 = Broken 报出——追加正典是可重放事实，静默丢行即污染）。
 * kind/tier/payload 的形状过滤保留在 parse 之外：行级 JSON 契约与字段形状是两层，
 * 流水零 schema 的边界不动（ADR-0053 边界段）。 */
export async function readSedimentCanon(paths: Paths, fs: VaultFs): Promise<SedimentEvent[]> {
  const lines = await readJsonlLines<unknown>(paths.sedimentPath, fs, 'sediment')
  return lines.filter(e => {
    const ev = e as SedimentEvent
    return isSedimentKind(ev.kind) && (ev.tier === 'immediate' || ev.tier === 'weekly')
      && typeof ev.payload === 'object' && ev.payload !== null
  }) as SedimentEvent[]
}

/** 沉淀正典里的最新 FSRS 参数（读侧单向的唯一参数事实源）：课程参数文件退役为
 * 缓存后，getScheduler / 优化器基线在缓存缺失时从这里取（删缓存不丢事实）。 */
export async function latestFsrsParams(paths: Paths, fs: VaultFs): Promise<number[] | undefined> {
  const w = foldSediment(await readSedimentCanon(paths, fs)).latest.fsrs_params?.payload.parameters
  return Array.isArray(w) && w.length > 0 && w.every(x => typeof x === 'number')
    ? w as number[]
    : undefined
}

// ---- 读侧折叠（唯一消费口径；纯函数，两次折叠同输入同输出） ----

export interface SedimentWeekGroup {
  /** 学习周周一（YYYY-MM-DD，weekStartOf 折叠；ts 解析失败归 'unknown'）。 */
  week: string
  events: SedimentEvent[]
}

export interface SedimentFold {
  /** 全时序（稳定排序：ts 升序，同 ts 保持文件序）。 */
  events: SedimentEvent[]
  counts: Record<SedimentKind, number>
  /** 每 kind 最新一条（immediate 语义的主读法）。 */
  latest: Partial<Record<SedimentKind, SedimentEvent>>
  /** weekly 档按学习周分组（周升序）——周档流水中心级可重折的读法。 */
  weekly: Partial<Record<SedimentKind, SedimentWeekGroup[]>>
  /** 概念地址 → 该概念最新一条（复诊结局/概念级先验的读法；未接线时为空）。 */
  byConcept: Partial<Record<SedimentKind, Record<string, SedimentEvent>>>
}

function emptyCounts(): Record<SedimentKind, number> {
  return { fsrs_params: 0, calibration: 0, speed_resilience: 0, content_quality: 0, recheck_outcome: 0, graph_repair: 0, nof1_outcome: 0 }
}

/** 稳定排序：ts 升序；同 ts（或不可解析 ts）保持追加序——同输入同输出。 */
function stableSorted(events: SedimentEvent[]): SedimentEvent[] {
  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.ts) }))
    .sort((a, b) => (Number.isNaN(a.t) ? 1 : Number.isNaN(b.t) ? -1 : a.t - b.t) || a.i - b.i)
    .map(({ e }) => e)
}

export function foldSediment(events: SedimentEvent[]): SedimentFold {
  const sorted = stableSorted(events)
  const fold: SedimentFold = { events: sorted, counts: emptyCounts(), latest: {}, weekly: {}, byConcept: {} }
  const weekBuckets = new Map<SedimentKind, Map<string, SedimentEvent[]>>()
  for (const e of sorted) {
    fold.counts[e.kind]++
    fold.latest[e.kind] = e // sorted 升序：后到覆盖 = 最新
    if (e.tier === 'weekly') {
      let buckets = weekBuckets.get(e.kind)
      if (!buckets) weekBuckets.set(e.kind, buckets = new Map())
      // 归桶口径：payload.week（事件声明的所属学习周，结算类事件的惯例字段）优先，
      // 缺席按事件 ts 的学习日归桶——「写时刻」不等于「所述周」
      const rawDay = typeof e.payload.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.payload.week)
        ? e.payload.week
        : calendarDayOf(e.ts)
      const week = weekStartOf(rawDay) ?? 'unknown'
      const bucket = buckets.get(week)
      if (bucket) bucket.push(e)
      else buckets.set(week, [e])
    }
    if (e.concept) {
      const byKind = fold.byConcept[e.kind] ?? (fold.byConcept[e.kind] = {})
      byKind[e.concept] = e
    }
  }
  for (const [kind, buckets] of weekBuckets) {
    fold.weekly[kind] = [...buckets.entries()]
      .sort(([a], [b]) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : a < b ? -1 : a > b ? 1 : 0))
      .map(([week, events]) => ({ week, events }))
  }
  return fold
}

// ---- 学习者档案.md（可读投影：纯派生、每次结算重建、手编必被覆盖） ----

const KIND_TITLES: Record<SedimentKind, string> = {
  fsrs_params: 'FSRS 参数（模型脾气）',
  calibration: '校准画像（自评 vs 实际）',
  speed_resilience: '速度韧性（节奏与保持）',
  content_quality: '内容质量结论',
  recheck_outcome: '复诊结局',
  graph_repair: '图修复史与概念级先验',
  nof1_outcome: '实验结局（N-of-1）',
}

function section(kind: SedimentKind, fold: SedimentFold): string {
  const lines: string[] = [`## ${KIND_TITLES[kind]}`, '']
  const weeks = fold.weekly[kind]
  if (weeks?.length) {
    lines.push(`- 周档 ${weeks.length} 组（最近 ${weeks[weeks.length - 1]!.week}），共 ${fold.counts[kind]} 条`)
  }
  const latest = fold.latest[kind]
  if (latest) {
    lines.push(`- 最新（${latest.ts}）: \`${JSON.stringify(latest.payload)}\``)
    if (latest.concept) lines.push(`  - 概念地址：${latest.concept}`)
  }
  if (!latest && !weeks?.length) lines.push('（尚无记录——生产者接线后出生即写）')
  lines.push('')
  return lines.join('\n')
}

/** 学习者档案投影（纯函数）：沉淀折叠的人读汇总。 */
export function renderLearnerProfile(fold: SedimentFold, nowMs: number): string {
  return [
    '---',
    'type: learner-profile',
    `rebuilt_at: ${nowIsoOf(nowMs)}`,
    'source: 沉淀/沉淀.jsonl（正典投影——手编必被覆盖，改请改正典侧生产者）',
    '---',
    '',
    '# 学习者档案',
    '',
    '学习模型状态的沉淀层投影（ADR-0034）：内容层可以断裂、重生成、硬删除，这里的模型脾气不丢。',
    '每次结算重建；`legacy/` 分区只保留不消费。',
    '',
    (SEDIMENT_KINDS as readonly SedimentKind[]).map(k => section(k, fold)).join('\n'),
  ].join('\n')
}

/** 重建投影（结算钩子的落盘出口）：fold → 写 学习者档案.md（原子替换；ADR-0046：手搓 tmp+rename 复制品改调唯一原语）。 */
export async function rebuildLearnerProfile(paths: Paths, fold: SedimentFold, nowMs: number, fs: VaultFs): Promise<string> {
  const md = renderLearnerProfile(fold, nowMs)
  await atomicWrite(paths.learnerProfilePath, md, fs)
  return md
}
