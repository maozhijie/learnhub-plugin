/**
 * 节级归因（Arc B1 #69 / ADR-0007）与逐题节定位（Arc D #64）共用模块。
 *
 * 归因的本质：把题目作答证据经 q.section 绑到节段（Section），再按双规则判
 * 「内容诊断信号」——R1 单题持续失败（lapses≥3，天然按日去重）、R2 节级作答
 * 表现（自节 version 锚点以来按（题,日）去重 ≥4 次且正确率 <0.5）。只消费
 * 「作答正确率」词汇，不消费 Mastery（ADR-0007：判定掌握与内容诊断分层）。
 * 全部纯派生自既有 practice.jsonl / journal.jsonl / 题库 stats+fsrs，零新增文件。
 *
 * 节匹配 = 前端轮装配同一套语义（PracticeFlow buildRounds）：节 id 精确命中
 * （新管线服务端强制）→ 标题精确 → 归一化标题回退（旧题 section=标题原文，常有
 * 「类型：」前缀/空白差异）；「通用」与匹配不上返回 null（跨节综合题失败指向
 * 节点级问题，归 B2，不参与节归因）。
 */
import { parseSectionTitle } from '../../shared/content-renderers.ts'
import { daysBetween, parseDay } from './dates.ts'
import type { SectionManifest } from './types.ts'

/** 门面暴露的诊断建议项 = 判定 + 课程/节点定位。 */
export interface DiagnosticItem extends SectionVerdict {
  course: string
  node: string
}

// ---- 触发阈值（#40 决议采纳 #39 调研全套默认；锚点初值，实测后可校准）----

/** R1：单题持续失败（leech 式）。Anki leech 8 按节均 2-4 题的规模结构缩到 3。 */
export const R1_LAPSES = 3
/** R2：窗口内（题,日）去重作答量下限（出题地板 2 题/节 × 每题两个不同日）。 */
export const R2_MIN_ATTEMPTS = 4
/** R2：正确率线（严格低于完成门禁 0.6，小样本噪声余量）。 */
export const R2_ACCURACY = 0.5
/** 冷却：同节触发（或重写落盘）后 N 天内不重复触发（≥一个 FSRS 复习周期）。 */
export const SIGNAL_COOLDOWN_DAYS = 7

// ---- 节匹配（引擎侧归因与逐题讲解共用）----

/** 节标题归一化键：剥「类型：」前缀 + 去空白——AI 的 section 标注常有
 * 「概念：X」vs 清单「概念：定义」这类前缀/空白差异，精确匹配会漏。 */
export function normSectionKey(s: string): string {
  return parseSectionTitle(s).clean.replace(/\s+/g, '')
}

/** q.section → 节清单条目：id 精确 → 标题精确 → 归一化标题；「通用」（跨节综合题）
 * 与匹配不上返回 null。 */
export function sectionEntryOf(
  section: string | undefined | null,
  manifest: SectionManifest[] | undefined,
): SectionManifest | null {
  if (!section || section === '通用' || !manifest?.length) return null
  return manifest.find(m => m.id === section)
    ?? manifest.find(m => m.title === section)
    ?? manifest.find(m => normSectionKey(m.title) === normSectionKey(section))
    ?? null
}

// ---- 触发规则（纯派生，接缝 S28）----

/** 一次节级诊断判定：met = 判定当下命中（建议项展示依据，条件不消失建议就在）；
 * fresh = 全新触发（过冷却 + 证据超越上次快照 base）——调用方据此落 journal 留痕，
 * 冷却期内不重复触发但建议项保持可见；escalate = R1 此前已触发过（冷却后二次命中
 * 升级人工，不再建议重写）。 */
export interface SectionVerdict {
  sectionId: string
  sectionTitle: string
  signal: 'R1' | 'R2'
  escalate: boolean
  fresh: boolean
  reason: string
  evidence: Record<string, number | string>
}

/** journal kind='section_regen_signal' 的 detail 编解码（机器可回读的快照字段 +
 * 人类可读文案；detail 是 JournalRec 唯一的自由字段）。 */
export interface SignalSnapshot {
  sectionId: string
  signal: 'R1' | 'R2'
  /** 触发时的证据快照：R1 = 当时的最大 lapses；R2 = 当时的窗口作答数（重触发要求被超越）。 */
  base: number
  escalate?: boolean
}

export function formatSignalDetail(snap: SignalSnapshot, title: string, evidenceText: string): string {
  return `节「${title}」(${snap.sectionId}) ${snap.signal} 触发：${evidenceText} base=${snap.base}`
}

export function parseSignalDetail(detail: string | undefined): SignalSnapshot | null {
  if (!detail) return null
  const m = detail.match(/\(([^()\s]+)\)\s*(R1|R2) 触发：.*?base=(\d+)/)
  if (!m) return null
  return { sectionId: m[1]!, signal: m[2] as 'R1' | 'R2', base: Number(m[3]) }
}

/** 归因输入的一片作答证据（practice 流水的最小投影）。 */
export interface AttemptFact {
  qid: string
  day: string
  correct: boolean | null
}

/** journal 里一次单节重写落盘（kind='content_section'）的投影；title 用于旧行
 * （detail 只有节标题没有 id）按清单标题回退对齐。 */
export interface RewriteFact {
  title: string
  day: string
}

/** evaluateSectionSignals 的输入：单节点一份。 */
export interface SectionSignalInput {
  /** 节清单（无清单旧节点传 []——无 id 的节不产建议）。 */
  manifest: SectionManifest[]
  /** 节点题库的未归档题（R1 读 fsrs.lapses；R2 用它把 qid 绑到节）。 */
  questions: Array<{ id: string; section?: string; fsrs?: { lapses?: number } | null }>
  /** 该节点的作答流水投影（按日粒度；忘记申报 correct=false 已含）。 */
  attempts: AttemptFact[]
  /** 该节点既往触发留痕（journal 解析后的快照 + 流水日）。 */
  prevSignals: Array<SignalSnapshot & { day: string }>
  /** 该节点的单节重写落盘史（R2 窗口锚点 + 冷却起点之一）。 */
  rewrites: RewriteFact[]
  today: string
}

/** 对单个 (题,日) 取当日首条（同日重试是输入修正不是独立证据）。 */
function firstAttemptPerDay(attempts: AttemptFact[]): AttemptFact[] {
  const seen = new Set<string>()
  const out: AttemptFact[] = []
  for (const a of attempts) {
    if (!a.day) continue
    const key = `${a.qid}/${a.day}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

const dayAfter = (a: string, b: string): number =>
  (parseDay(a) && parseDay(b) ? daysBetween(parseDay(a)!, parseDay(b)!) : 0)

/** 节级触发判定（纯函数，零副作用）：逐清单节评估 R1/R2 + 冷却 + 升级。
 * 判定纪律：R2 窗口 = 该节最近一次重写落盘之后的（题,日）首条作答；R1 的 lapses
 * 不随重写重置（单节重写不动题库）；fresh（落留痕的新触发）要求过冷却且证据超越
 * 该信号类型上次快照（base，避免无新证据的周期性复读）；该类型此前触发过 → R1
 * 升级人工。快照按信号类型分账：R1 的 base 是 lapses、R2 的 base 是作答数，
 * 不可跨类型比较（R2 先触发不能挡住后出现的 R1）。 */
export function evaluateSectionSignals(input: SectionSignalInput): SectionVerdict[] {
  if (!input.manifest.length) return []
  const rewritesBySection = new Map<string, string>() // sectionId → 最近重写日
  for (const rw of input.rewrites) {
    const entry = input.manifest.find(m => m.title === rw.title)
      ?? input.manifest.find(m => normSectionKey(m.title) === normSectionKey(rw.title))
    if (!entry) continue
    const prev = rewritesBySection.get(entry.id)
    if (!prev || rw.day > prev) rewritesBySection.set(entry.id, rw.day)
  }
  const lastSignalByKind = (sectionId: string) => {
    const byKind: Partial<Record<'R1' | 'R2', SignalSnapshot & { day: string }>> = {}
    for (const s of input.prevSignals) {
      if (s.sectionId !== sectionId) continue
      const cur = byKind[s.signal]
      if (!cur || s.day > cur.day) byKind[s.signal] = s
    }
    return byKind
  }
  const deduped = firstAttemptPerDay(input.attempts).filter(a => a.correct !== null)

  const out: SectionVerdict[] = []
  for (const m of input.manifest) {
    // 归因：绑节题（id → 标题 → 归一化标题）+ 交互件成绩（qid=interactive:<节id>）
    const bound = input.questions.filter(q => sectionEntryOf(q.section, [m]) !== null)
    const boundIds = new Set(bound.map(q => q.id))
    const sectionAttempts = deduped.filter(a =>
      boundIds.has(a.qid) || a.qid === `interactive:${m.id}`)
    // 冷却：同节上次触发或重写落盘（谁晚取谁）距今不足 N 天 → 不再产生新触发（建议仍可见）
    const lastEventDay = [
      ...input.prevSignals.filter(s => s.sectionId === m.id).map(s => s.day),
      rewritesBySection.get(m.id),
    ].filter((d): d is string => Boolean(d)).sort().at(-1)
    const inCooldown = lastEventDay !== undefined
      && dayAfter(input.today, lastEventDay) < SIGNAL_COOLDOWN_DAYS
    const prevOf = lastSignalByKind(m.id)

    // R1：绑节题最大 lapses ≥ 阈值（lapses 是天然按日去重的遗忘计数，不随重写重置）
    const prevR1 = prevOf.R1
    const maxLapses = bound.length ? Math.max(...bound.map(q => q.fsrs?.lapses ?? 0)) : 0
    if (maxLapses >= R1_LAPSES) {
      out.push({
        sectionId: m.id,
        sectionTitle: m.title,
        signal: 'R1',
        escalate: prevR1 !== undefined,
        fresh: !inCooldown && maxLapses > (prevR1?.base ?? 0),
        reason: prevR1
          ? `单题反复失败仍未解决（lapses=${maxLapses}，上次触发后重写无效）——转人工处理：审题、归档坏题或检查前置`
          : `单题反复失败（lapses=${maxLapses}≥${R1_LAPSES}）——建议重写这一节，或先讲解这道题`,
        evidence: { qid: bound.find(q => (q.fsrs?.lapses ?? 0) === maxLapses)!.id, lapses: maxLapses },
      })
      continue
    }

    // R2：自节重写锚点以来的（题,日）首条作答 ≥4 次且正确率 <0.5（窗口随 version 递增自动归零）。
    // 锚点时刻 = 该节最近一次 content_section 落盘事件（journal；manifest sections[].version
    // 是同一事实的计数、不带时刻，无法独立充当窗口起点——#69 票面「version 锚点」的时间源）。
    const anchorDay = rewritesBySection.get(m.id)
    const window = anchorDay ? sectionAttempts.filter(a => dayAfter(a.day, anchorDay) > 0) : sectionAttempts
    const total = window.length
    const correct = window.filter(a => a.correct === true).length
    const accuracy = total ? correct / total : null
    if (total >= R2_MIN_ATTEMPTS && accuracy !== null && accuracy < R2_ACCURACY) {
      out.push({
        sectionId: m.id,
        sectionTitle: m.title,
        signal: 'R2',
        escalate: false,
        fresh: !inCooldown && total > (prevOf.R2?.base ?? 0),
        reason: `本节答错集中（作答正确率 ${Math.round(accuracy * 100)}%，${total} 次作答）——建议重写这一节，或先讲解错题`,
        evidence: { attempts: total, correct, accuracy: Math.round(accuracy * 100) / 100 },
      })
    }
  }
  return out
}

/** 诊断建议项的对外形状（status 附带 / recommend 事件携带 / 工具面共用，单一出处）：
 * rewrite = 一键重写直达动作（既有单节重写管线，确认后才触发）；explain = Arc D
 * 讲解入口所在（节点学习页答错/忘记错误态的「讲解这道题」）。 */
export function diagnosticView(d: DiagnosticItem): Record<string, unknown> {
  return {
    node: d.node, section: d.sectionId, sectionTitle: d.sectionTitle,
    signal: d.signal, escalate: d.escalate, fresh: d.fresh,
    reason: d.reason, evidence: d.evidence,
    rewrite: { course: d.course, node: d.node, section: d.sectionId },
    explain: { course: d.course, node: d.node },
  }
}

/** recommend 流里独立 diagnostic 事件的评分（介于 new 与 review 之间，低于 struggle）。 */
export const DIAGNOSTIC_SCORE = 54

/** 单节重写落盘的 journal detail → 节标题（引擎 content_section 的既有文案契约，
 * 历史行只有节标题没有 id；id 由消费方按清单标题回退对齐）。非重写行返回 null。 */
export function parseRewriteDetail(detail: string | undefined): string | null {
  return detail?.match(/节「(.+?)」v\d+ 落盘/)?.[1] ?? null
}
