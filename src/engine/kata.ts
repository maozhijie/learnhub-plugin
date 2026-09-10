/**
 * 周复盘 Weekly Kata（U-4 #114 / ADR-0026）：全局每周一张的五问结构化复盘
 * （目标条件/现状/障碍/下一实验/预期所学），有界（进行中项目各一节 + 课程概览）
 * 与无界（习惯/技能条目）同屏——两区的铰链。
 *
 * - 学习周 = 日历周按学习日折叠（ADR-0020）：行为流水的 ts 过日界得学习日，学习日
 *   所在日历周（周一–周日）即其学习周；复盘对象 = 上一完整学习周，不引入滚动窗口。
 * - 现状 = 引擎用上一学习周的真实数据自动填；其余四问学习者作答。
 * - 落 学习中心/我的产出/周复盘/<周一日期>.md（V-3 输出区，#107 约定）。
 * - Learner Output 域（ADR-0009/0026）：零 XP、不进 Mastery、本身不做 FSRS 卡、
 *   零 canonical 写入；无推送、入口常驻、缺勤不罚。
 * - 「下一实验」出口：自由文本 + 一键转 N-of-1 实验提案（ADR-0023 提案-确认制）或
 *   执行意图挂目标偏好（C-5 既有机制）；转换留痕写在记录里。
 *
 * 聚合纯函数（buildKataReality）：流水进 → 分箱出；周归属全部经 dayOfTs（学习日
 * 口径，凌晨归属随日界），周内/周外用 YYYY-MM-DD 字典序比较。
 */
import { parseDay, fmtDay, dayOfTs } from './dates.ts'
import { obsidianLink } from './output.ts'
import { execRatingScore } from './project-exec.ts'
import type { ProjectExecRec } from './project-exec.ts'
import { crossingText, etaHorizonOf } from './compass.ts'
import type { CompassEta } from './compass.ts'
import { dueReviewFirstPushes, trueRetention } from './memory.ts'
import type { PracticeRec, JournalRec, ReviewRec } from './types.ts'
import type { HabitRepeatRec } from './habits.ts'

export const KATA_KIND = 'weekly_kata'

/** 五问（顺序固定；「现状」引擎填，其余四问学习者作答）。 */
export const KATA_QUESTIONS = ['目标条件', '现状', '障碍', '下一实验', '预期所学'] as const
export type KataQuestion = (typeof KATA_QUESTIONS)[number]
export type KataAnswer = Exclude<KataQuestion, '现状'>
export const KATA_LEARNER_QUESTIONS: KataAnswer[] = ['目标条件', '障碍', '下一实验', '预期所学']

/** 未作答占位（区分「写了空话」与「还没写」的判定基准）。 */
export const KATA_EMPTY = '（待答）'

// ---- 学习周折叠（ADR-0026 裁决 2：日历周按学习日折叠）----

/** 'YYYY-MM-DD' → 所在日历周的周一（UTC 日算术；解析失败 null）。 */
export function weekStartOf(day: string): string | null {
  const d = parseDay(day)
  if (!d) return null
  const shift = (d.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  return fmtDay(new Date(d.getTime() - shift * 86400000))
}

/** 周一 → 周日（+6 天）。 */
export function weekEndOf(weekStart: string): string | null {
  const d = parseDay(weekStart)
  return d ? fmtDay(new Date(d.getTime() + 6 * 86400000)) : null
}

/** 相对 today 的上一完整学习周周一（today 所在周的周一往前推 7 天）。 */
export function prevWeekStartOf(today: string): string | null {
  const cur = weekStartOf(today)
  if (!cur) return null
  const d = parseDay(cur)!
  return fmtDay(new Date(d.getTime() - 7 * 86400000))
}

/** 学习日是否落在 [weekStart, weekEnd]（字符串字典序即日序）。 */
export function inWeek(day: string, weekStart: string, weekEnd: string): boolean {
  return day >= weekStart && day <= weekEnd
}

// ---- 现状聚合（引擎自动填的四问之外那一问）----

export interface KataRealityInput {
  weekStart: string
  weekEnd: string
  cutoffMin: number
  practice: PracticeRec[]
  journal: JournalRec[]
  reviewLog: ReviewRec[]
  habitRepeats: HabitRepeatRec[]
  /** 进行中项目（各一节；零动作也出现——铰链语义落在同屏）。 */
  projects: Array<{ id: string; name: string; plan: Array<{ id: string; name: string }> }>
  /** 项目执行事件（facade 逐项目读好带进来；键 = 项目 id）。 */
  projectExec: Record<string, ProjectExecRec[]>
  /** 笔记源 id → { path, title }（出链用；V-3「产物内插入指向个人笔记的出链」）。 */
  noteSources: Record<string, { path: string; title?: string }>
  /** 展示名映射（习惯/技能条目 id → 学习者起的名字）。 */
  habitNames: Record<string, string>
  skillNames: Record<string, string>
}

export interface KataReality {
  days: number
  xp: number
  answers: number
  accuracy: number | null
  due_reviews: number
  retention: number | null
  courses: Array<{ course: string; answers: number; xp: number }>
  projects: Array<{ id: string; name: string; milestones: string[]; exec_count: number; exec_avg: number | null }>
  habits: Array<{ id: string; name: string; repeats: number }>
  skills: Array<{ id: string; name: string; events: number }>
  note_sources: Array<{ id: string; path: string; title: string; reviews: number }>
}

/** 上一学习周的真实数据聚合（纯函数）：全部周归属经 dayOfTs(cutoff) 折叠成学习日。
 * 课程桶不含项目域 journal 行（kind=milestone_settle，course=项目 id）与执行 XP 行
 * （course='*'）；执行 XP 计入总 XP 与学习天数（ADR-0019 与学习时间同账同权）。 */
export function buildKataReality(input: KataRealityInput): KataReality {
  const { weekStart, weekEnd, cutoffMin } = input
  const dayOf = (ts: string | undefined): string | null => (ts ? dayOfTs(ts, cutoffMin) : null)
  const hit = (ts: string | undefined): boolean => {
    const d = dayOf(ts)
    return d !== null && inWeek(d, weekStart, weekEnd)
  }

  const days = new Set<string>()
  let xp = 0
  const courseStat = new Map<string, { answers: number; xp: number }>()
  const bumpCourse = (course: string | undefined, xpDelta: number, isAnswer: boolean): void => {
    if (!course || course === '*') return
    const slot = courseStat.get(course) ?? { answers: 0, xp: 0 }
    if (isAnswer) slot.answers += 1
    slot.xp += xpDelta
    courseStat.set(course, slot)
  }
  for (const r of input.practice) {
    if (!hit(r.ts)) continue
    const d = dayOf(r.ts)!
    days.add(d)
    const rxp = r.xp ?? 0
    xp += rxp
    bumpCourse(r.course, rxp, true)
  }
  for (const r of input.journal) {
    if (!hit(r.ts)) continue
    const d = dayOf(r.ts)!
    days.add(d)
    xp += r.xp ?? 0
    // 课程桶不含项目域行（milestone_settle 的 course=项目 id）与执行 XP 行（course='*'）——
    // 前者归项目桶，后者的 XP 已计入总账（ADR-0019 与学习时间同账同权）
    if (r.kind !== 'milestone_settle') bumpCourse(r.course, r.xp ?? 0, false)
  }
  // 作答正确率（practice 全量口径，judged 才计）
  const weekPractice = input.practice.filter(r => hit(r.ts))
  const judged = weekPractice.filter(r => r.correct !== null)
  const right = judged.filter(r => r.correct === true).length

  // 真实保留率：周内复习日志 → 既有「每卡每天第一条 + auto/self」过滤器 → Pass/Fail
  const weekLog = input.reviewLog.filter(r => hit(r.ts))
  const dueReviews = dueReviewFirstPushes(weekLog, cutoffMin)
  const retention = trueRetention(dueReviews)

  // 项目：过点里程碑（journal kind=milestone_settle，node=里程碑 id → 计划名）+ 执行事件
  const projects = input.projects.map(p => {
    const milestones = input.journal
      .filter(r => r.kind === 'milestone_settle' && r.course === p.id && hit(r.ts))
      .map(r => p.plan.find(m => m.id === r.node)?.name ?? r.node)
    const exec = (input.projectExec[p.id] ?? []).filter(r => hit(r.day))
    const execAvg = exec.length
      ? Math.round((exec.reduce((s, r) => s + execRatingScore(r.rating), 0) / exec.length) * 100) / 100
      : null
    return { id: p.id, name: p.name, milestones, exec_count: exec.length, exec_avg: execAvg }
  })

  // 无界：习惯重复（自报流）与技能执行事件（review-log rating_source=execution，node=技能 id）
  const habitCount = new Map<string, number>()
  for (const r of input.habitRepeats) {
    if (!hit(r.ts)) continue
    habitCount.set(r.habit, (habitCount.get(r.habit) ?? 0) + 1)
  }
  const skillCount = new Map<string, number>()
  for (const r of weekLog) {
    if (r.rating_source !== 'execution') continue
    skillCount.set(r.node, (skillCount.get(r.node) ?? 0) + 1)
  }

  // 笔记源复习（course=伪课程「笔记源」，node=源 id）→ 出链渲染原料
  const noteCount = new Map<string, number>()
  for (const r of input.reviewLog) {
    if (r.course !== '笔记源' || !hit(r.ts)) continue
    noteCount.set(r.node, (noteCount.get(r.node) ?? 0) + 1)
  }

  return {
    days: days.size,
    xp,
    answers: weekPractice.length,
    accuracy: judged.length ? Math.round((right / judged.length) * 1000) / 1000 : null,
    due_reviews: dueReviews.length,
    retention: retention.rate,
    courses: [...courseStat.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([course, s]) => ({ course, answers: s.answers, xp: s.xp })),
    projects,
    habits: [...habitCount.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, repeats]) => ({ id, name: input.habitNames[id] ?? id, repeats })),
    skills: [...skillCount.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, events]) => ({ id, name: input.skillNames[id] ?? id, events })),
    note_sources: [...noteCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .flatMap(([id, reviews]) => {
        const info = input.noteSources[id]
        if (!info) return []
        return [{ id, path: info.path, title: info.title ?? id, reviews }]
      }),
  }
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

/** 现状区旁挂的沙盘 ETA 摘要（#150 周复盘挂罗盘 ETA）：引擎 compassEtaRefresh 折叠
 * 后随行注入——与罗盘「沙盘 ETA」段同一份数据，零二次蒙特卡洛；此周复盘打开即附，
 * 与「现状」的上周聚合无关（推演是当下快照）。 */
export interface KataEtaSummary {
  course: string
  endpoint: string
  minutes_per_day: number
  /** 首次越阈档（at=探测周，from=上一探测周；null = 推演时程内未及）。 */
  p50_week: { at: number; from: number | null } | null
  p80_week: { at: number; from: number | null } | null
  /** 探测地平线上界（周；未及时如实说「N 周内未及」）。 */
  horizon: number
  wording: string
}

/** CompassEta → 旁挂摘要的唯一映射（kataOpen 消费；地平线口径与罗盘 ETA 段渲染同源）。 */
export function kataEtaSummary(course: string, eta: CompassEta): KataEtaSummary {
  return {
    course,
    endpoint: eta.endpoint,
    minutes_per_day: eta.minutes_per_day,
    p50_week: eta.p50_week,
    p80_week: eta.p80_week,
    horizon: etaHorizonOf(eta),
    wording: eta.wording,
  }
}

/** 现状段渲染（markdown 行；空态诚实留痕，不造假数据）。etas = 罗盘周 ETA 旁挂
 * （#150）：非空时在「有界 · 课程」后附「沙盘 ETA」小节——每周随罗盘挂载刷新，
 * 分位带参照、非承诺措辞照旧（ADR-0025 纪律不动）。 */
export function renderKataReality(r: KataReality, etas: KataEtaSummary[] = []): string {
  const lines: string[] = ['### 总览', '']
  const overview = [`学习 ${r.days} 天`, `XP +${r.xp}`, `作答 ${r.answers} 次${r.accuracy !== null ? `（作答正确率 ${pct(r.accuracy)}）` : ''}`]
  if (r.due_reviews > 0) {
    overview.push(`到期复习 ${r.due_reviews} 次${r.retention !== null ? `（真实保留率 ${pct(r.retention)}）` : ''}`)
  }
  lines.push(`- ${overview.join(' · ')}`, '')

  lines.push('### 有界 · 课程', '')
  lines.push(...(r.courses.length
    ? r.courses.map(c => `- ${c.course}：作答 ${c.answers} 次${c.xp ? ` · XP +${c.xp}` : ''}`)
    : ['当周没有课程作答。']), '')

  if (etas.length) {
    lines.push('### 沙盘 ETA', '')
    lines.push(...etas.map(e => `- ${e.course} → 终点「${e.endpoint}」：p50${crossingText(e.p50_week, e.horizon)}；p80${crossingText(e.p80_week, e.horizon)}（每日约 ${e.minutes_per_day} 分钟口径；${e.wording}）`))
    lines.push('')
  }

  lines.push('### 有界 · 项目', '')
  lines.push(...(r.projects.length
    ? r.projects.map(p => {
        const bits: string[] = []
        bits.push(p.milestones.length ? `过点 ${p.milestones.length} 个（${p.milestones.join('、')}）` : '当周无过点')
        if (p.exec_count) bits.push(`执行事件 ${p.exec_count} 次（均分 ${pct(p.exec_avg ?? 0)}）`)
        return `- ${p.name}：${bits.join(' · ')}`
      })
    : ['没有进行中的项目。']), '')

  lines.push('### 无界', '')
  const unbounded: string[] = [
    ...r.habits.map(h => `习惯「${h.name}」重复 ${h.repeats} 次`),
    ...r.skills.map(s => `技能「${s.name}」执行 ${s.events} 次`),
  ]
  lines.push(...(unbounded.length ? unbounded.map(l => `- ${l}`) : ['当周没有习惯重复或技能执行事件。']), '')

  lines.push('### 笔记源', '')
  lines.push(...(r.note_sources.length
    ? r.note_sources.map(n => `- ${obsidianLink(n.path, n.title)}：复习 ${n.reviews} 次`)
    : ['当周没有笔记源复习。']))
  return lines.join('\n')
}

// ---- 记录文档（我的产出/周复盘/<周一>.md）----

/** 五问记录装配：现状=引擎段，四问=学习者段（缺省占位）。 */
export function assembleKataDoc(input: {
  weekStart: string
  weekEnd: string
  created: string
  reality: string
  answers: Partial<Record<KataAnswer, string>>
}): string {
  const answerOf = (q: KataAnswer): string => (input.answers[q] ?? '').trim() || KATA_EMPTY
  const section = (title: string, body: string): string => `## ${title}\n\n${body.trim() || KATA_EMPTY}`
  return [
    `# 周复盘 ${input.weekStart} ~ ${input.weekEnd}`,
    '',
    '> 五问复盘（ADR-0026）：「现状」由引擎用上一学习周的真实数据自动填，其余四问你来答。',
    '> Learner Output 域：零 XP、不进掌握度、不做 FSRS 卡；缺勤不罚。',
    '> 可经笔记源注册通道把本页注册为复习对象（引擎不强推）。',
    '',
    section('目标条件', answerOf('目标条件')),
    '',
    section('现状', input.reality),
    '',
    section('障碍', answerOf('障碍')),
    '',
    section('下一实验', answerOf('下一实验')),
    '',
    section('预期所学', answerOf('预期所学')),
  ].join('\n')
}

/** 解析五问记录正文 → 各问文本（`^## ` 切分；未知标题忽略）。frontmatter 由 notes.loadNote 解析。 */
export function parseKataBody(body: string): Record<KataQuestion, string> {
  const sections = new Map<string, string>()
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
    if (nl >= 0) sections.set(title, part.slice(nl + 1).trim())
  }
  const out = {} as Record<KataQuestion, string>
  for (const q of KATA_QUESTIONS) out[q] = sections.get(q) ?? ''
  return out
}

/** 四问是否都已作答（占位视同未答）。 */
export function kataAnswered(sections: Record<KataQuestion, string>): boolean {
  return KATA_LEARNER_QUESTIONS.every(q => {
    const v = sections[q].trim()
    return v.length > 0 && v !== KATA_EMPTY
  })
}
