/**
 * 学习状态与调度（吸收自 Python sessions.py；刷卡模型瘦身版）。
 *
 * 命令面：status / recommend / lesson。数据主权：课程笔记 frontmatter 是节点
 * stage 事实源；题库 YAML 是题目调度事实源（每题一张 FSRS 卡）。
 * 复习到期判定 = 题库聚合（节点 due = min(题目 due)），由 facade 注入 bankDue。
 * 节点的 stage 推进发生在作答（首答→learning）与完成确认（→review）两处，见 engine。
 */
import type { VaultFs } from './io.ts'
import { parseDay, daysBetween, dayOfTs } from './dates.ts'
import { effectiveStage } from './srs.ts'
import { retrievability, getScheduler, masteryOfFm } from './srs.ts'
import { R_GATE } from './params.ts'
import { loadNote, asFm, validateNoteFrontmatter, hasReadyContent } from './notes.ts'
import type { BrokenNote } from './notes.ts'
import type { Graph } from './graph.ts'
import type { Fm, Stage } from './types.ts'
import type { Paths } from './paths.ts'
import { DIAGNOSTIC_SCORE, diagnosticView } from './attribution.ts'
import type { DiagnosticItem } from './attribution.ts'
import { newLessonRationale, pinHeadScore, todayPins } from './goals.ts'
import type { PinRec } from './goals.ts'
import { reconsolidationAdvice, SLEEP_SCORE, SLEEP_STANDALONE_MAX } from './sleep.ts'
import type { SleepSuggestion } from './sleep.ts'

/** 单课调度素材的统一视图参数。 */
export interface ViewSource {
  (course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
}

/** 聚合学习态（status/recommend/ETA）前置门：任一必需笔记 Broken 即 fail loud。 */
export function assertNoBrokenNotes(where: string, broken: BrokenNote[]): void {
  if (!broken.length) return
  throw new Error(`[${where}] 课程状态 Broken，不能生成可能掩盖损坏的学习汇总：\n${broken.map(b => `  ✗ ${b.path} — ${b.reason}`).join('\n')}`)
}

export function doneSet(graph: Graph, state: Record<string, Fm>): Set<string> {
  return new Set(graph.names.filter(n => ['review', 'mastered', 'skipped'].includes(effectiveStage(state, n))))
}

export function learningSet(graph: Graph, state: Record<string, Fm>): Set<string> {
  return new Set(graph.names.filter(n => effectiveStage(state, n) === 'learning'))
}

/** 新课候选：未开始且全部非 opt 前置达标；rGate 给定时追加前置 R ≥ 门槛。 */
export function readySet(graph: Graph, state: Record<string, Fm>, rValue: (n: string) => number, rGate?: number): string[] {
  const done = doneSet(graph, state)
  const started = new Set([...done, ...learningSet(graph, state)])
  const out: string[] = []
  for (const n of graph.names) {
    if (started.has(n)) continue
    let ok = true
    for (const p of graph.preOf[n]) {
      if (graph.opt.has(p)) continue
      if (!done.has(p)) { ok = false; break }
      if (rGate !== undefined && rValue(p) < rGate) { ok = false; break }
    }
    if (ok) out.push(n)
  }
  return out.sort()
}

/** 被 R_gate 拦下的新课候选 → {候选: [(前置, R)]}。 */
export function gateBlockers(graph: Graph, state: Record<string, Fm>, rValue: (n: string) => number, rGate: number): Record<string, Array<[string, number]>> {
  const done = doneSet(graph, state)
  const started = new Set([...done, ...learningSet(graph, state)])
  const blockers: Record<string, Array<[string, number]>> = {}
  for (const n of graph.names) {
    if (started.has(n)) continue
    const weak: Array<[string, number]> = []
    let blocked = false
    for (const p of graph.preOf[n]) {
      if (graph.opt.has(p)) continue
      if (!done.has(p)) { blocked = true; break }
      const r = rValue(p)
      if (r < rGate) weak.push([p, r])
    }
    if (blocked || !weak.length) continue
    blockers[n] = weak.sort((a, b) => a[1] - b[1])
  }
  return blockers
}

// ---- A3 成分技能补救与前置再激活（决议 #37 / ADR-0008；实施 #54 R 半、#55 F 半）----

/** 推荐事件/状态暴露的可执行复习建议项（#54/#55 共用形状）：node = 直达复习目标
 * （review-queue 的 node 过滤入口），due = 其当前到期题数，r = 该目标当前可提取性
 * R；w 仅 enc 回退带（成分技能调用强度）。 */
export interface AdviceItem { node: string; w?: number; r: number; due: number }

/** struggle 近期窗口的 (course,node) 聚合作答量（facade 从作答流水注入）。 */
export interface WindowStat { attempts: number; correct: number }

/** struggle 判据（#55）：作答正确率阈值、作答量下限（低数据静默）与近期窗口宽度。 */
export const STRUGGLE_ACCURACY = 0.6
export const STRUGGLE_MIN_ATTEMPTS = 3
export const STRUGGLE_WINDOW_DAYS = 14
/** enc 回退建议项截取的头部数量（「取头部若干」）。 */
export const REMEDIAL_LIMIT = 3

const round3 = (r: number) => Math.round(r * 1000) / 1000

/** 按 node 分组（B1 诊断事件合流用；同插入序）。 */
function groupByNode(items: DiagnosticItem[]): Map<string, DiagnosticItem[]> {
  const out = new Map<string, DiagnosticItem[]>()
  for (const d of items) {
    const list = out.get(d.node) ?? []
    list.push(d)
    out.set(d.node, list)
  }
  return out
}

/** A3 R 半（#54）：gateBlockers 的可执行化投影——弱前置结构不变，每项补
 * 「当前到期题数」（题库聚合注入；无题库数据按 0，仍给建议、入口自然为空队列）。 */
export function gateAdvice(
  graph: Graph, state: Record<string, Fm>, rValue: (n: string) => number, rGate: number,
  dueCount: (n: string) => number,
): Record<string, AdviceItem[]> {
  const out: Record<string, AdviceItem[]> = {}
  for (const [n, weak] of Object.entries(gateBlockers(graph, state, rValue, rGate))) {
    out[n] = weak.map(([p, r]) => ({ node: p, r: round3(r), due: dueCount(p) }))
  }
  return out
}

/** struggle 判定（#55）：作答量达下限且作答正确率低于阈值才算；低数据自动静默。 */
export function isStruggle(attempts: number, correct: number): boolean {
  return attempts >= STRUGGLE_MIN_ATTEMPTS && correct / attempts < STRUGGLE_ACCURACY
}

/** 作答流水 ts（ISO，本地时）是否落在 struggle 近期窗口内（按学习日，ADR-0020；未来时间戳不算）。 */
export function withinStruggleWindow(ts: string, today: string, days = STRUGGLE_WINDOW_DAYS, cutoffMin = 0): boolean {
  const t = parseDay(dayOfTs(ts, cutoffMin))
  const now = parseDay(today)
  if (!t || !now) return false
  const back = daysBetween(now, t)
  return back >= 0 && back < days
}

/** A3 F 半（#55）：struggle 节点 → enc 成分技能按 w×(1−R) 降序的定向复习建议
 * （rank = 调用强度 × 遗忘程度；同 rank 按名字稳定排序）。调用方先判 struggle；
 * enc 为空在此静默返回 []；图外技能边防御性跳过。 */
export function encRemedialAdvice(
  graph: Graph, node: string, rValue: (n: string) => number,
  dueCount: (n: string) => number, limit = REMEDIAL_LIMIT,
): AdviceItem[] {
  return (graph.encOf[node] ?? [])
    .filter(([skill]) => graph.nset.has(skill))
    .map(([skill, w]) => ({ node: skill, w, r: round3(rValue(skill)), due: dueCount(skill) }))
    .sort((a, b) => ((b.w ?? 0) * (1 - b.r)) - ((a.w ?? 0) * (1 - a.r)) || a.node.localeCompare(b.node))
    .slice(0, limit)
}

/** 各区「最久未学习」排序（轮转）：从未学过的区最优先。 */
export function regionLru(graph: Graph, state: Record<string, Fm>): string[] {
  const last: Record<string, string> = {}
  for (const n of graph.names) {
    const fs = state[n]?.fsrs
    if (fs?.last_review) {
      const region = graph.blockOf[n][1]
      if (!last[region] || fs.last_review > last[region]) last[region] = fs.last_review
    }
  }
  const regions = graph.regions.map(r => r.name)
  return regions.slice().sort((a, b) => {
    const la = last[a] ?? ''
    const lb = last[b] ?? ''
    if (la !== lb) return la < lb ? -1 : 1
    return regions.indexOf(b) - regions.indexOf(a)
  })
}

export interface CourseStats {
  counts: Record<Stage, number>
  ready: string[]
  gated: string[]
  due: Array<{ d: string; n: string; r: number }>
  overdue: Array<{ d: string; n: string; r: number }>
  blocked: Record<string, Array<[string, number]>>
  /** 被 R-gate 拦下候选的可执行复习建议（#54 R 半）：候选 → 衰减前置清单（含到期题数）。 */
  advice: Record<string, AdviceItem[]>
}

export function courseStats(
  graph: Graph, state: Record<string, Fm>, rValue: (n: string) => number, today: string,
  rGate = R_GATE, dueCount: (n: string) => number = () => 0,
): CourseStats {
  const counts = { unseen: 0, ready: 0, learning: 0, review: 0, mastered: 0, skipped: 0 } as Record<Stage, number>
  const t = parseDay(today)!
  for (const n of graph.names) {
    counts[effectiveStage(state, n)]++
  }
  void t
  return {
    counts,
    ready: readySet(graph, state, rValue),
    gated: readySet(graph, state, rValue, rGate),
    due: [], overdue: [], // 复习到期改由题库聚合驱动（bankDue 注入），不再读节点 frontmatter
    blocked: gateBlockers(graph, state, rValue, rGate),
    advice: gateAdvice(graph, state, rValue, rGate, dueCount),
  }
}

/** 题库聚合的节点统计（facade 从题库文件汇总，一次遍历多处消费）：
 * due/count 驱动复习队列；accuracy/attempts 驱动 struggle 提示。 */
export interface NodeStat { node: string; due: string | null; count: number; accuracy: number | null; attempts: number }

export class Sessions {
  /** 当前操作的课程根目录（notePath 解析用；跨课循环内由调用方重设）。 */
  rootOf = ''

  constructor(
    private paths: Paths,
    private viewOf: ViewSource,
    private fs: VaultFs,
  ) {}

  // ---- 笔记路径 ----

  /** 节点课程笔记的 vault 相对路径（不含 .md）；无笔记返回 null。 */
  notePath(root: string, graph: Graph, n: string): string | null {
    if (!graph.blockOf[n]) return null
    const region = graph.blockOf[n][1]
    const path = this.paths.courseNotePath(root, region, n)
    if (!this.fs.exists(path)) return null
    const marker = '/学习中心/'
    const idx = path.replace(/\\/g, '/').indexOf(marker)
    return idx >= 0 ? path.replace(/\\/g, '/').slice(idx + 1).replace(/\.md$/, '') : null
  }

  // ---- status ----

  async statusJson(
    enabled: Array<{ name: string; root: string; id?: string }>,
    statsByCourse: Map<string, NodeStat[]>,
    today: string,
    dayCutoff: string,
  ): Promise<Record<string, unknown>> {
    const courses: Array<Record<string, unknown>> = []
    for (const c of enabled) {
      const { graph, state, broken } = await this.viewOf(c)
      assertNoBrokenNotes('status', broken)
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root), this.fs)
      const rValue = (n: string) => retrievability(sched, state[n], today)
      const statByNode = new Map((statsByCourse.get(c.name) ?? []).map(s => [s.node, s]))
      const st = courseStats(graph, state, rValue, today, R_GATE, n => statByNode.get(n)?.count ?? 0)
      const t = parseDay(today)!
      const withDue = [...statByNode.values()].filter(s => s.due !== null)
      const overdueNodes = withDue.filter(s => (parseDay(s.due ?? '')?.getTime() ?? t.getTime()) < t.getTime())
      const dueNodes = withDue.filter(s => s.due === today)
      courses.push({
        id: c.id, name: c.name,
        total: graph.names.length, counts: st.counts,
        due_today: dueNodes.length,
        overdue: overdueNodes.map(o => ({ node: o.node, since: o.due, count: o.count, path: this.notePath(c.root, graph, o.node) })),
        ready: st.ready.map(n => ({ node: n, path: this.notePath(c.root, graph, n) })),
        gated: st.gated.map(n => ({ node: n, path: this.notePath(c.root, graph, n) })),
        // 软闸建议项（#54 R 半）：被 R-gate 拦下的候选 → {前置, R, 前置到期题数, 直达入口}
        blocked: Object.fromEntries(Object.entries(st.advice).map(([n, items]) =>
          [n, items.map(a => ({
            pre: a.node, r: a.r, due: a.due,
            entry: { course: c.name, node: a.node },
          }))])),
      })
    }
    return { date: today, day_cutoff: dayCutoff, courses }
  }

  // ---- 动态推荐 ----

  async recommendEvents(
    enabled: Array<{ name: string; root: string }>,
    statsByCourse: Map<string, NodeStat[]>,
    today: string,
    limit: number,
    /** struggle 近期窗口统计（#55 F 半；缺省 = 无窗口数据，复习中节点不判 struggle）。 */
    windowStats?: Map<string, Map<string, WindowStat>>,
    /** 内容诊断建议项（#69 B1；门面 diagnosticsAdvice 的产出，per course 过滤后消费）。 */
    diagnostics?: DiagnosticItem[],
    /** 「今天学它」pin 清单（#67 E3；全量，函数内只取当日有效条目）。 */
    pins?: PinRec[],
    /** D-4 睡眠耦合建议层开关（#85；state/learnhub.json 的 sleep.enabled）。 */
    sleepAdvice?: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const c of enabled) {
      const { graph, state, broken } = await this.viewOf(c)
      assertNoBrokenNotes('recommend', broken)
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root), this.fs)
      const rValue = (n: string) => retrievability(sched, state[n], today)
      const stats = statsByCourse.get(c.name) ?? []
      const statByNode = new Map(stats.map(s => [s.node, s]))
      const dueCountOf = (n: string) => statByNode.get(n)?.count ?? 0
      const st = courseStats(graph, state, rValue, today, R_GATE, dueCountOf)
      const winByNode = windowStats?.get(c.name)
      const windowStruggle = (n: string): boolean => {
        const w = winByNode?.get(n)
        return w !== undefined && isStruggle(w.attempts, w.correct)
      }
      // A3 F 半（#55）：节点当前的 enc 回退建议——struggle 且有 enc 边时非空，否则 null 静默。
      // 学习中节点沿用累计作答正确率判定并叠加窗口；复习中节点只看近期窗口（低数据静默）。
      // 建议触发统一带作答量下限（spec #55）：累计路径不足 3 次同样静默。
      const remedial = (n: string): AdviceItem[] | null => {
        const stat = statByNode.get(n)
        const cumStruggle = stat !== undefined && stat.accuracy !== null
          && stat.attempts >= STRUGGLE_MIN_ATTEMPTS && stat.accuracy < STRUGGLE_ACCURACY
        const struggling = effectiveStage(state, n) === 'learning'
          ? (cumStruggle || windowStruggle(n))
          : windowStruggle(n)
        if (!struggling) return null
        const items = encRemedialAdvice(graph, n, rValue, dueCountOf)
        return items.length ? items : null
      }
      const t = parseDay(today)!
      const add = (etype: string, node: string, score: number, why: string, advice?: AdviceItem[]) => {
        if (seen.has(node)) return
        seen.add(node)
        events.push({
          type: etype, course: c.name, node, region: graph.blockOf[node]?.[1] ?? '',
          score: Math.round(score * 10) / 10, why, path: this.notePath(c.root, graph, node),
          hasContent: hasReadyContent(state[node]),
          ...(advice?.length ? { advice } : {}),
        })
      }
      // 复习/逾期：题库聚合（节点有到期题目）；节点近期 struggle 时把 enc 回退建议附在事件上
      for (const s of [...stats].sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))) {
        const d = parseDay(s.due ?? '')
        if (!d) continue
        const advice = remedial(s.node)
        const struggleNote = advice ? `；近期练习反复出错，建议先回补成分技能 ${advice[0]!.node}` : ''
        if (d.getTime() < t.getTime()) {
          const days = daysBetween(t, d)
          add('overdue', s.node, 60 + Math.min(days, 10) * 3 + s.count * 2,
            `逾期 ${days} 天，${s.count} 道题到期${struggleNote}`, advice ?? undefined)
        } else if (d.getTime() === t.getTime()) {
          add('review', s.node, 55, `今日 ${s.count} 道题到期${struggleNote}`, advice ?? undefined)
        }
      }
      // A3 F 半（#55）：复习中的节点近期窗口 struggle 但今日无到期事件 → 独立
      // struggle 事件（enc 为空或作答量不足时 remedial 为 null，静默）。
      // skipped 是用户自报已会，不打扰。
      for (const n of graph.names.filter(x => ['review', 'mastered'].includes(effectiveStage(state, x))).sort()) {
        if (seen.has(n)) continue
        const advice = remedial(n)
        if (!advice) continue
        add('struggle', n, 50,
          `近期练习反复出错，先回补成分技能 ${advice[0]!.node}（${advice[0]!.due} 道到期题）再重刷本节`, advice)
      }
      // 学习中：保持率低或作答正确率低（struggle）时改写引导文案；有 enc 边则给出定向回补建议
      for (const n of graph.names.filter(x => effectiveStage(state, x) === 'learning').sort()) {
        const r = state[n] ? rValue(n) : 0.9
        const stat = statByNode.get(n)
        const struggling = (stat !== undefined && stat.accuracy !== null && stat.accuracy < STRUGGLE_ACCURACY)
          || windowStruggle(n)
        const advice = struggling ? (remedial(n) ?? []) : []
        const why = struggling
          ? advice.length
            ? `作答正确率仅 ${Math.round((stat?.accuracy ?? 0) * 100)}%，先回补成分技能 ${advice[0]!.node}（${advice[0]!.due} 道到期题）再继续`
            : `作答正确率仅 ${Math.round((stat?.accuracy ?? 0) * 100)}%，建议先复习前置概念再继续`
          : `学到一半，继续完成它（保持率约 ${Math.round(r * 100)}%）`
        add('learning', n, 52 + (1 - r) * 10 + (struggling ? 6 : 0), why, advice.length ? advice : undefined)
      }
      // 新课：解锁后继数 + 分区轮转；被 R-gate 拦下的候选（#54 R 半）在 new 事件上
      // 前置展示软闸建议项——文案引导「先复习 P 的 n 道到期题」，评分抬一档排在
      // 普通新课之前，但不阻止直接学 N（软闸语义，无新增拦截）
      const lru = regionLru(graph, state)
      const lruBonus = new Map(lru.map((r0, i) => [r0, Math.max(0, 8 - i * 2)]))
      const ready = readySet(graph, state, rValue)
      const done = doneSet(graph, state)
      const started = new Set([...done, ...learningSet(graph, state)])
      // 「学好可解锁 N 个后继」的真实语义：学会本节后，那些唯一卡在本节的未开始
      // 节点（其余非 opt 前置均已通过）会进入可学集合。opt 前置不算门槛。
      const unlocksOf = (n: string): number => graph.names.filter(m =>
        !started.has(m) && graph.preOf[m].includes(n)
        && graph.preOf[m].every(p => p === n || graph.opt.has(p) || done.has(p))).length
      for (const n of ready) {
        const region = graph.blockOf[n][1]
        const unlocks = unlocksOf(n)
        const gate = st.advice[n]
        if (gate?.length) {
          const top = gate[0]!
          add('new', n, 40 + Math.min(unlocks * 4, 16) + (lruBonus.get(region) ?? 0),
            `前置 ${top.node} 保持率已衰减（R=${top.r}），建议先复习它的 ${top.due} 道到期题再学本节（仍可直接学）`,
            gate)
          continue
        }
        // rationale（#67 E3）：既有信号（解锁数/区轮转）升级为一句自然语句
        add('new', n, 30 + Math.min(unlocks * 4, 16) + (lruBonus.get(region) ?? 0),
          newLessonRationale(unlocks, region, lru.length > 0 && lru[0] === region))
      }
      // B1（#69）：本课程的内容诊断建议项——节点已有事件则附着，否则独立 diagnostic
      // 事件（score 介于 new 与 review 之间）。每节点合一条，diagnostics 数组内联
      // 理由与证据，并带「重写此节」直达动作（确认后才走单节重写管线）。
      for (const [node, list] of groupByNode(diagnostics?.filter(d => d.course === c.name) ?? [])) {
        const view = list.map(d => diagnosticView(d))
        const hit = events.find(e => e.course === c.name && e.node === node)
        if (hit) {
          hit.diagnostics = view
          continue
        }
        events.push({
          type: 'diagnostic', course: c.name, node,
          region: graph.blockOf[node]?.[1] ?? '', score: DIAGNOSTIC_SCORE,
          why: list[0]!.reason + (list.length > 1 ? `（另有 ${list.length - 1} 节待诊断）` : ''),
          path: this.notePath(c.root, graph, node),
          hasContent: hasReadyContent(state[node]),
          diagnostics: view,
        })
      }
      // E3（#67）：本课程当日 pin 的目标覆盖层——置顶到课程内榜首（分数 = 课程内
      // 最高分 + 1，跨课程仍按全局排序语义），附「你选了它」标识与正常理由。pin
      // 只作用当日（过期条目 todayPins 已滤掉）。未就绪节点照常可 pin：软闸建议
      // 随事件带出（提示前置未完成但保留照开自由，无硬拦）；无事件的节点合成
      // pin 事件（已学/学中/未开始按 stage 给理由）。
      for (const pin of todayPins(pins ?? [], today).filter(p => p.course === c.name)) {
        const head = pinHeadScore(events as Array<{ course: string; score: number }>, c.name)
        const hit = events.find(e => e.course === c.name && e.node === pin.node)
        if (hit) {
          hit.score = head
          hit.pinned = true
          // C-5 #84：pin 挂载的执行意图随事件带出（只读侧展示，无调度语义）
          if (pin.intention) hit.intention = pin.intention
          const gate = (hit as { advice?: AdviceItem[] }).advice
          // 未就绪 pin 保留照开自由：榜首带字面「前置未完成」提示（#54 软闸语义）
          hit.why = gate?.length
            ? `你选了它 · 前置未完成：${gate[0]!.node}（可先复习，仍可直接学）· ${hit.why}`
            : `你选了它 · ${hit.why}`
          continue
        }
        const gate = st.advice[pin.node]
        const stage = effectiveStage(state, pin.node)
        const due = dueCountOf(pin.node)
        const why = gate?.length
          ? `你选了它 · 前置未完成：${gate[0]!.node}（可先复习它的 ${gate[0]!.due} 道到期题，仍可直接学）`
          : stage === 'learning'
            ? '你选了它 · 学到一半，继续完成它'
            : ['review', 'mastered'].includes(stage)
              ? `你选了它 · 巩固已学${due ? `（${due} 道题到期）` : ''}`
              : '你选了它 · 今天学它'
        events.push({
          type: 'pin', course: c.name, node: pin.node,
          region: graph.blockOf[pin.node]?.[1] ?? '', score: head, why,
          path: this.notePath(c.root, graph, pin.node),
          hasContent: hasReadyContent(state[pin.node]),
          pinned: true,
          ...(pin.intention ? { intention: pin.intention } : {}),
          ...(gate?.length ? { advice: gate } : {}),
        })
      }
      // D-4（#85）睡眠耦合排程建议：重巩固型节点（practice 交互实践节点）在推荐里
      // 附「睡前练、醒后验」时段建议——纯读侧信息层，不改调度语义、不产生到期；
      // 已有事件的节点就地附着（不新占推荐位），已开始但今日无事件的节点至多补
      // SLEEP_STANDALONE_MAX 条独立 sleep 事件（分数低于新课带）。全局可关。
      if (sleepAdvice) {
        let standalone = 0
        for (const n of graph.names.filter(x => graph.typeOf[x] === 'practice').sort()) {
          const started = ['learning', 'review', 'mastered'].includes(effectiveStage(state, n))
          if (!started && !seen.has(n)) continue
          const sug: SleepSuggestion = reconsolidationAdvice(n)
          const hit = events.find(e => e.course === c.name && e.node === n)
          if (hit) {
            hit.sleep = sug
            continue
          }
          if (standalone >= SLEEP_STANDALONE_MAX) continue
          standalone++
          events.push({
            type: 'sleep', course: c.name, node: n,
            region: graph.blockOf[n]?.[1] ?? '', score: SLEEP_SCORE,
            why: sug.text, path: this.notePath(c.root, graph, n),
            hasContent: hasReadyContent(state[n]),
            sleep: sug,
          })
        }
      }
    }
    events.sort((a, b) => (b.score as number) - (a.score as number))
    return events.slice(0, limit)
  }

  // ---- 课程学习（面板全链路） ----

  /** 正文 → 学习分节 [{title, md}]（_lesson_sections 同语义）。 */
  static lessonSections(body: string): Array<{ title: string; md: string }> {
    const SKIP = ['练习', '内容反馈']
    const parts = body.split(/^## /m)
    const sections: Array<{ title: string; md: string }> = []
    const intro = parts[0].trim()
    if (intro) {
      const nl = intro.indexOf('\n')
      const title = nl >= 0 ? intro.slice(0, nl) : intro
      const md = nl >= 0 ? intro.slice(nl + 1).trim() : ''
      if (md) sections.push({ title: title.replace(/^#+\s*/, '').trim() || '导语', md })
    }
    let answersMd = ''
    for (const part of parts.slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      const md = (nl >= 0 ? part.slice(nl + 1) : '').trim()
      if (SKIP.includes(title) || title.startsWith('<!--')) continue
      if (!md) continue
      if (title === '答案') {
        answersMd = md
        continue
      }
      sections.push({ title, md })
    }
    if (answersMd) {
      const hit = sections.find(s => s.title === '例题')
      if (hit) hit.md += '\n\n### 参考答案\n' + answersMd
      else sections.push({ title: '答案', md: answersMd })
    }
    return sections
  }

  /** 单节点课程学习包：分节正文 + 前置 + 推荐下一步。today = 学习日（ADR-0020），facade 注入。 */
  async lesson(courseName: string, root: string, graph: Graph, state: Record<string, Fm>, node: string, today: string): Promise<Record<string, unknown>> {
    if (!graph.nset.has(node)) throw new Error(`[lesson] 课程「${courseName}」中没有节点「${node}」。`)
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path, this.fs)
    const fm = asFm(rawFm)
    if (!fm) {
      if (rawFm) {
        const checked = validateNoteFrontmatter(rawFm)
        throw new Error(`[lesson] 课程文件 Broken（${path}）— ${checked.errors.join('；')}`)
      }
      throw new Error(`[lesson] 课程文件不存在（内容未生成？）：${node}`)
    }
    const sections = Sessions.lessonSections(body)
    const sched = await getScheduler(this.paths, this.paths.courseRoot(root), this.fs)
    const rValue = (n: string) => retrievability(sched, state[n], today)
    const candidates = readySet(graph, state, rValue).filter(n => n !== node)
    const unlocks = candidates.filter(n => graph.preOf[n].includes(node))
    return {
      course: courseName, node,
      region: regionName,
      stage: effectiveStage(state, node),
      mastery: masteryOfFm(fm),
      sections,
      prereqs: [...graph.preOf[node]],
      suggest_next: [...unlocks, ...candidates.filter(n => !unlocks.includes(n))].slice(0, 8),
    }
  }
}
