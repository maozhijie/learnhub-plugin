/**
 * E1 节级「我的理解」自注反馈（#70 / ADR-0009 Learner Output）的纯规则层。
 *
 * 写注当下 AI 对照该节已教要点给是非 + 定位反馈（对/错/部分对 + 含糊/跳跃/说错
 * + 可怎么补）。判词 schema 与 E2「讲给我听」同构，复用 explain.parseExplainVerdict
 * （不可解析抛错 → 调用方零副作用，ADR-0004 事务性）；判词只入 E 档案
 * （kind=self_note）、零 XP、不写掌握度/FSRS/canonical 任何字段。
 *
 * 指令散文住 `prompts/feedback.ts`（#237 / ADR-0075 惰性化）；自注原文与节正文明
 * 学习者自写内容，朴素拼装注入、不进 `render` 变量面（口径见该模块头注）。
 */
import { render } from './prompt-render.ts'
import {
  SELF_NOTE_FEEDBACK_HEADING, SELF_NOTE_FEEDBACK_NO_POINTS, SELF_NOTE_FEEDBACK_NOTE_HEADING,
  SELF_NOTE_FEEDBACK_SECTION_HEADING, SELF_NOTE_FEEDBACK_SYSTEM,
} from './prompts/feedback.ts'
import type { ExplainPoint } from './explain.ts'
import type { LearnerCardKind } from './types.ts'

/** 自注卡的默认正面提示（按卡面档；学习者可显式覆盖）。 */
export function selfNotePromptOf(kind: LearnerCardKind, anchor: string): string {
  switch (kind) {
    case 'cloze_rewrite': return `补全你自己的表述：${anchor}`
    case 'self_explain': return `这个节你理解成了什么：${anchor}`
    default: return `再讲一遍：用你的话讲清「${anchor}」`
  }
}

/** 自注反馈的 system 指令：对照要点给是非 + 定位 + 怎么补；严格 JSON 输出。
 * 定位标签与 E2 同集（含糊=表述不精确 / 跳跃=缺关键步骤 / 说错=与要点矛盾）。 */
export function selfNoteFeedbackSystem(): string {
  return render(SELF_NOTE_FEEDBACK_SYSTEM, {})
}

/** 自注反馈的 user 材料：对照要点（节锚点时为该节正文，否则全节要点）+ 学习者自注。 */
export function selfNoteFeedbackPrompt(points: ExplainPoint[], sectionTitle: string | undefined, note: string): string {
  const lines: string[] = [sectionTitle
    ? render(SELF_NOTE_FEEDBACK_SECTION_HEADING, { sectionTitle })
    : render(SELF_NOTE_FEEDBACK_HEADING, {})]
  for (const s of points) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  if (!points.length) lines.push('', render(SELF_NOTE_FEEDBACK_NO_POINTS, {}))
  lines.push('', render(SELF_NOTE_FEEDBACK_NOTE_HEADING, {}), '', note.slice(0, 4000))
  return lines.join('\n')
}
