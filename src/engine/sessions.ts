/**
 * 学习状态与调度（吸收自 Python sessions.py；刷卡模型瘦身版）。
 *
 * 命令面：status / recommend / lesson。数据主权：课程笔记 frontmatter 是节点
 * stage 事实源；题库 YAML 是题目调度事实源（每题一张 FSRS 卡）。
 * 复习到期判定 = 题库聚合（节点 due = min(题目 due)），由 facade 注入 bankDue。
 * 节点的 stage 推进发生在作答（首答→learning）与完成确认（→review）两处，见 engine。
 */
import { existsSync } from 'node:fs'
import { todayStr, parseDay, daysBetween } from './dates.ts'
import { effectiveStage } from './audit.ts'
import { retrievability, getScheduler, masteryOfFm } from './srs.ts'
import { loadNote, asFm } from './notes.ts'
import type { Graph } from './graph.ts'
import type { Fm, Stage } from './types.ts'
import type { Paths } from './paths.ts'

/** 单课调度素材的统一视图参数。 */
export interface ViewSource {
  (course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: string[] }>
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
}

export function courseStats(graph: Graph, state: Record<string, Fm>, rValue: (n: string) => number, today: string, rGate = 0.85): CourseStats {
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
  ) {}

  // ---- 笔记路径 ----

  /** 节点课程笔记的 vault 相对路径（不含 .md）；无笔记返回 null。 */
  notePath(root: string, graph: Graph, n: string): string | null {
    if (!graph.blockOf[n]) return null
    const region = graph.blockOf[n][1]
    const path = this.paths.courseNotePath(root, region, n)
    if (!existsSync(path)) return null
    const marker = '/学习中心/'
    const idx = path.replace(/\\/g, '/').indexOf(marker)
    return idx >= 0 ? path.replace(/\\/g, '/').slice(idx + 1).replace(/\.md$/, '') : null
  }

  private nodeLink(root: string, graph: Graph, n: string): string {
    const vp = this.notePath(root, graph, n)
    return vp ? `[[${vp}|${n}]]` : n
  }

  // ---- status ----

  async statusJson(
    enabled: Array<{ name: string; root: string; id?: string }>,
    statsByCourse: Map<string, NodeStat[]>,
    today = todayStr(),
  ): Promise<Record<string, unknown>> {
    const courses: Array<Record<string, unknown>> = []
    for (const c of enabled) {
      const { graph, state } = await this.viewOf(c)
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
      const rValue = (n: string) => retrievability(sched, state[n], today)
      const st = courseStats(graph, state, rValue, today)
      const stats = statsByCourse.get(c.name) ?? []
      const t = parseDay(today)!
      const withDue = stats.filter(s => s.due !== null)
      const overdueNodes = withDue.filter(s => (parseDay(s.due ?? '')?.getTime() ?? t.getTime()) < t.getTime())
      const dueNodes = withDue.filter(s => s.due === today)
      courses.push({
        id: c.id, name: c.name,
        total: graph.names.length, counts: st.counts,
        due_today: dueNodes.length,
        overdue: overdueNodes.map(o => ({ node: o.node, since: o.due, count: o.count, path: this.notePath(c.root, graph, o.node) })),
        ready: st.ready.map(n => ({ node: n, path: this.notePath(c.root, graph, n) })),
        gated: st.gated.map(n => ({ node: n, path: this.notePath(c.root, graph, n) })),
        blocked: Object.fromEntries(Object.entries(st.blocked).map(([n, weak]) =>
          [n, weak.map(([p, r]) => ({ pre: p, r: Math.round(r * 1000) / 1000 }))])),
      })
    }
    return { date: today, courses }
  }

  // ---- 动态推荐 ----

  async recommendEvents(
    enabled: Array<{ name: string; root: string }>,
    statsByCourse: Map<string, NodeStat[]>,
    today: string,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const c of enabled) {
      const { graph, state } = await this.viewOf(c)
      const sched = await getScheduler(this.paths, this.paths.courseRoot(c.root))
      const rValue = (n: string) => retrievability(sched, state[n], today)
      const st = courseStats(graph, state, rValue, today)
      const stats = statsByCourse.get(c.name) ?? []
      const t = parseDay(today)!
      const add = (etype: string, node: string, score: number, why: string) => {
        if (seen.has(node)) return
        seen.add(node)
        events.push({
          type: etype, course: c.name, node, region: graph.blockOf[node]?.[1] ?? '',
          score: Math.round(score * 10) / 10, why, path: this.notePath(c.root, graph, node),
        })
      }
      // 复习/逾期：题库聚合（节点有到期题目）
      for (const s of [...stats].sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''))) {
        const d = parseDay(s.due ?? '')
        if (!d) continue
        if (d.getTime() < t.getTime()) {
          const days = daysBetween(t, d)
          add('overdue', s.node, 60 + Math.min(days, 10) * 3 + s.count * 2,
            `逾期 ${days} 天，${s.count} 道题到期`)
        } else if (d.getTime() === t.getTime()) {
          add('review', s.node, 55, `今日 ${s.count} 道题到期`)
        }
      }
      // 学习中：保持率低或正确率低（struggle）时改写引导文案
      for (const n of graph.names.filter(x => effectiveStage(state, x) === 'learning').sort()) {
        const r = state[n] ? rValue(n) : 0.9
        const stat = stats.find(s => s.node === n)
        const struggling = stat?.accuracy !== null && stat !== undefined && stat.accuracy < 0.6
        const why = struggling
          ? `正确率仅 ${Math.round((stat?.accuracy ?? 0) * 100)}%，建议先复习前置概念再继续`
          : `学到一半，继续完成它（保持率约 ${Math.round(r * 100)}%）`
        add('learning', n, 52 + (1 - r) * 10 + (struggling ? 6 : 0), why)
      }
      // 新课：解锁后继数 + 分区轮转
      const lru = regionLru(graph, state)
      const lruBonus = new Map(lru.map((r0, i) => [r0, Math.max(0, 8 - i * 2)]))
      const ready = readySet(graph, state, rValue)
      const unlockedCount: Record<string, number> = {}
      for (const n of ready) {
        for (const p of graph.preOf[n]) unlockedCount[p] = (unlockedCount[p] ?? 0) + 1
      }
      for (const n of ready) {
        const region = graph.blockOf[n][1]
        const unlocks = unlockedCount[n] ?? 0
        const parts: string[] = []
        if (unlocks) parts.push(`学好可解锁 ${unlocks} 个后继`)
        parts.push(`「${region}」区${lru.length && lru[0] === region ? '最久未学，轮转优先' : '按轮转排序'}`)
        add('new', n, 30 + Math.min(unlocks * 4, 16) + (lruBonus.get(region) ?? 0), parts.join('；'))
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

  /** 单节点课程学习包：分节正文 + 前置 + 推荐下一步。 */
  async lesson(courseName: string, root: string, graph: Graph, state: Record<string, Fm>, node: string): Promise<Record<string, unknown>> {
    if (!graph.nset.has(node)) throw new Error(`[lesson] 课程「${courseName}」中没有节点「${node}」。`)
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm: rawFm, body } = await loadNote(path)
    const fm = asFm(rawFm)
    if (!fm) throw new Error(`[lesson] 课程文件不存在（内容未生成？）：${node}`)
    const sections = Sessions.lessonSections(body)
    const sched = await getScheduler(this.paths, this.paths.courseRoot(root))
    const rValue = (n: string) => retrievability(sched, state[n], todayStr())
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
