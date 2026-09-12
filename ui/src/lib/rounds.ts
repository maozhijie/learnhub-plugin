/** mastery 会话轮次计划（PracticeFlow 消费）——零依赖纯模块，node:test 可直接消费。
 * 节清单（manifest）驱动节序列：内容节 = 读节→做该节题；练习节 = 一等练习轮（无阅读）；
 * 交互节 = 交互件轮。旧节点（无清单）回退标题匹配；未落节的题进「综合」收尾轮。 */
import { parseSectionTitle } from '../../../shared/content-renderers.ts'
import type { LessonSection, QuestionItem, SectionManifestItem } from '../types'

export interface Round {
  key: string
  type: 'read' | 'quiz' | 'interactive'
  title: string
  typeLabel: string
  md?: string
  questions?: QuestionItem[]
  /** 交互节轮的节 id（SettleContext 上报结算用）。 */
  sectionId?: string
  /** 轮次所属节的类型（struggle 分支按轮类型隐藏「AI 再出题」，#117）。 */
  sectionType?: string
  /** 轮次所属节的定位（提意见重生成的定向节，#120）。 */
  sectionRef?: { id: string; title: string }
}

/** stepper 一步 = 一个节（read+quiz 成对并入）或通用收尾轮。 */
export interface Step {
  key: string
  label: string
  start: number
  /** 该步的过关判据轮 key（无 quiz 轮的内容节以读完为准）。 */
  quizKey: string | null
}

/** 节标题归一化：剥类型前缀 + 去空白——AI 的 section 标注常有
 * 「概念：X」vs 正文「X」这类前缀/空白差异，精确匹配会漏题进综合轮。 */
function normSection(s: string): string {
  return parseSectionTitle(s).clean.replace(/\s+/g, '')
}

/** 节标题 → 展示名（剥「类型：」前缀，类型另由 Tag 表达）。 */
function cleanTitle(title: string): string {
  return parseSectionTitle(title).clean
}

/** 轮次计划：manifest 驱动节序列（练习节一等化、交互节轮），旧节点回退标题匹配；
 * 未落节的题收进「综合」quiz 轮。 */
export function buildRounds(
  sections: LessonSection[], manifest: SectionManifestItem[] | null, questions: QuestionItem[],
): { rounds: Round[]; steps: Step[] } {
  const rounds: Round[] = []
  const steps: Step[] = []
  const mdByTitle = new Map(sections.map(s => [s.title, s.md]))
  const used = new Set<string>()
  const pushStep = (key: string, label: string, start: number, quizKey: string | null) => {
    steps.push({ key, label, start, quizKey })
  }
  if (manifest?.length) {
    for (const m of manifest) {
      const md = mdByTitle.get(m.title) ?? null
      // 绑节 id 优先（新管线），回退归一化标题（旧题 section=标题原文）
      const qs = questions.filter(q => q.section === m.id
        || (q.section != null && q.section !== '通用' && normSection(q.section) === normSection(m.title)))
      qs.forEach(q => used.add(q.id))
      const start = rounds.length
      const ref = { id: m.id, title: m.title }
      if (m.type === '交互') {
        if (md) rounds.push({ key: `ix:${m.id}`, type: 'interactive', title: cleanTitle(m.title), typeLabel: m.type, md, sectionId: m.id, sectionType: m.type, sectionRef: ref })
        pushStep(m.id, cleanTitle(m.title), start, null)
      } else if (m.type === '练习') {
        // 一等练习节：无阅读轮，直接做题；无题不出轮（出题后 questions 刷新重建轮次）
        if (qs.length) {
          rounds.push({ key: `quiz:${m.id}`, type: 'quiz', title: cleanTitle(m.title), typeLabel: m.type, questions: qs, sectionType: m.type, sectionRef: ref })
          pushStep(m.id, cleanTitle(m.title), start, `quiz:${m.id}`)
        }
      } else {
        if (md) rounds.push({ key: `read:${m.id}`, type: 'read', title: cleanTitle(m.title), typeLabel: m.type, md, sectionType: m.type, sectionRef: ref })
        if (qs.length) {
          rounds.push({ key: `quiz:${m.id}`, type: 'quiz', title: cleanTitle(m.title), typeLabel: m.type, questions: qs, sectionType: m.type, sectionRef: ref })
          pushStep(m.id, cleanTitle(m.title), start, `quiz:${m.id}`)
        } else if (md) {
          pushStep(m.id, cleanTitle(m.title), start, null)
        }
      }
    }
  } else {
    for (const s of sections) {
      const parsed = parseSectionTitle(s.title)
      const key = normSection(s.title)
      const qs = questions.filter(q => q.section === s.title || (q.section != null && normSection(q.section) === key))
      qs.forEach(q => used.add(q.id))
      const start = rounds.length
      const ref = { id: s.title, title: s.title }
      rounds.push({ key: `read:${s.title}`, type: 'read', title: parsed.clean, typeLabel: parsed.type.label, md: s.md, sectionRef: ref })
      if (qs.length) rounds.push({ key: `quiz:${s.title}`, type: 'quiz', title: parsed.clean, typeLabel: parsed.type.label, questions: qs, sectionRef: ref })
      pushStep(s.title, parsed.clean, start, qs.length ? `quiz:${s.title}` : null)
    }
  }
  const generic = questions.filter(q => !used.has(q.id))
  if (generic.length) {
    rounds.push({ key: 'quiz:generic', type: 'quiz', title: '综合', typeLabel: '通用', questions: generic })
    pushStep('quiz:generic', '综合', rounds.length - 1, 'quiz:generic')
  }
  return { rounds, steps }
}
