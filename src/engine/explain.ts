/**
 * E2「讲给我听」（#68 / ADR-0009 Learner Output）：费曼讲解会话的纯规则层。
 *
 * 会话骨架（原型 #47 转正）：学习者用自己的话讲 → AI 扮完全不懂的初学者按正文要点
 * 追问（抓含糊/跳跃/说错，不评分不超纲）→ 收尾给定位反馈（对/错/部分对 + 定位 +
 * 可怎么补）。判词只入 E 档案、零 XP、不写 canonical。
 *
 * 两个接缝：讲稿包/指令拼装（explainBackPack）与判词解析（parseExplainVerdict，
 * AI 输出不可解析时抛错——判卷失败零副作用，ADR-0004）。
 *
 * 指令散文住 `prompts/feedback.ts`（#237 / ADR-0075 惰性化），本文件只做取值与拼装：
 * 正文要点/讲稿是动态材料（含学习者自写内容），朴素拼装后就地注入，不进 `render` 变量面
 * ——危险与口径见该模块头注。
 */
import { render } from './prompt-render.ts'
import {
  EXPLAIN_BACKPACK_HEADER, EXPLAIN_BACKPACK_NO_POINTS, EXPLAIN_BACKPACK_TAIL,
  EXPLAIN_FEEDBACK_POINTS_HEADING, EXPLAIN_FEEDBACK_SYSTEM, EXPLAIN_FEEDBACK_TRANSCRIPT_HEADING,
} from './prompts/feedback.ts'

/** 正文要点条目（节标题 + 现正文；s1–s3 型，来自 lessonSections/节清单）。 */
export interface ExplainPoint { title: string; md: string }

/** 讲解会话包：{正文要点 + 图位置 + 初学者人设指令}——宿主/tutor 会话的 system/首条消息。 */
export function explainBackPack(
  course: string, node: string, sections: ExplainPoint[], pre: string[], succ: string[],
): string {
  const lines: string[] = [render(EXPLAIN_BACKPACK_HEADER, { course, node })]
  for (const s of sections) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  if (!sections.length) lines.push('', render(EXPLAIN_BACKPACK_NO_POINTS, {}))
  lines.push('', render(EXPLAIN_BACKPACK_TAIL, {
    pre: pre.join('、') || '无',
    succ: (succ ?? []).join('、') || '无',
  }))
  return lines.join('\n')
}

export const EXPLAIN_VERDICTS = ['对', '部分对', '错'] as const
export type ExplainVerdict = (typeof EXPLAIN_VERDICTS)[number]

export const EXPLAIN_TAGS = ['含糊', '跳跃', '说错'] as const
export type ExplainTag = (typeof EXPLAIN_TAGS)[number]

export interface ExplainVerdictDoc {
  verdict: ExplainVerdict
  tags: ExplainTag[]
  advice: string
  reply: string
}

/** 定位反馈回合的 system 指令：对照要点给是非 + 定位 + 怎么补；严格 JSON 输出。 */
export function explainFeedbackSystem(): string {
  return render(EXPLAIN_FEEDBACK_SYSTEM, {})
}

/** 定位反馈回合的 user 材料：要点 + 完整对话记录（讲稿是学习者自写内容，朴素拼装注入）。 */
export function explainFeedbackPrompt(sections: ExplainPoint[], transcript: string): string {
  const lines: string[] = [render(EXPLAIN_FEEDBACK_POINTS_HEADING, {})]
  for (const s of sections) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  lines.push('', render(EXPLAIN_FEEDBACK_TRANSCRIPT_HEADING, {}), '', transcript.slice(-8000))
  return lines.join('\n')
}

/** 解析定位反馈的模型输出：剥围栏 → JSON → 契约校验；不可解析抛错（零副作用，调用方不落盘）。 */
export function parseExplainVerdict(raw: string): ExplainVerdictDoc {
  const text = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, '$1').trim()
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`[explain] 定位反馈不是合法 JSON（AI 判词输出不可用，本次未存档）：${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof doc !== 'object' || doc === null) throw new Error('[explain] 定位反馈输出必须是 JSON 对象（本次未存档）。')
  const d = doc as Record<string, unknown>
  const rawVerdict = d.verdict
  if (typeof rawVerdict !== 'string' || !(EXPLAIN_VERDICTS as readonly string[]).includes(rawVerdict)) {
    throw new Error(`[explain] verdict 只能是「${EXPLAIN_VERDICTS.join('」「')}」之一（收到 ${String(rawVerdict)}；本次未存档）。`)
  }
  const verdict = rawVerdict as ExplainVerdict
  const rawTags = Array.isArray(d.tags) ? d.tags : []
  const tags = rawTags.filter((t): t is ExplainTag =>
    typeof t === 'string' && (EXPLAIN_TAGS as readonly string[]).includes(t))
  const advice = typeof d.advice === 'string' ? d.advice.trim() : ''
  const reply = typeof d.reply === 'string' ? d.reply.trim() : ''
  if (!advice) throw new Error('[explain] 缺少 advice（可怎么补）字段（本次未存档）。')
  if (!reply) throw new Error('[explain] 缺少 reply（反馈全文）字段（本次未存档）。')
  return { verdict, tags, advice, reply }
}
