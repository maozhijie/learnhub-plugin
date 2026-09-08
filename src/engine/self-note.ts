/**
 * E1 节级「我的理解」自注反馈（#70 / ADR-0009 Learner Output）的纯规则层。
 *
 * 写注当下 AI 对照该节已教要点给是非 + 定位反馈（对/错/部分对 + 含糊/跳跃/说错
 * + 可怎么补）。判词 schema 与 E2「讲给我听」同构，复用 explain.parseExplainVerdict
 * （不可解析抛错 → 调用方零副作用，ADR-0004 事务性）；判词只入 E 档案
 * （kind=self_note）、零 XP、不写掌握度/FSRS/canonical 任何字段。
 */
import type { ExplainPoint } from './explain.ts'
import type { LearnerCardKind } from './learner-cards.ts'

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
  return [
    '你是 learnhub 的学习教练。学习者刚用自己的话写下一句对某节内容的理解（解释/例子/助记），你拿到该节已教要点与这条自注。',
    '请对照要点给一次**定位反馈**：是非判断（对/部分对/错）+ 偏离定位（含糊=表述不精确、跳跃=缺关键步骤、说错=与要点矛盾）+ 每处「可怎么补」。',
    '这是学习反馈不是评分：不打分数、不评级；语气直接、引用学习者原话定位；只对照该节要点，不超纲、不引入新概念。',
    '',
    '## 输出（严格 JSON，不要代码围栏、不要任何额外解释）',
    '{',
    '  "verdict": "对" | "部分对" | "错",',
    '  "tags": ["含糊", "跳跃", "说错"],',
    '  "advice": "一句最关键的「可怎么补」",',
    '  "reply": "Markdown 定位反馈全文：逐处给出标签+原话引用+怎么补"',
    '}',
    'tags 只能是三者（含糊/跳跃/说错）中实际出现的子集，可为空数组。',
  ].join('\n')
}

/** 自注反馈的 user 材料：对照要点（节锚点时为该节正文，否则全节要点）+ 学习者自注。 */
export function selfNoteFeedbackPrompt(points: ExplainPoint[], sectionTitle: string | undefined, note: string): string {
  const lines: string[] = []
  lines.push(sectionTitle ? `## 本节已教要点（反馈只对照这些）·「${sectionTitle}」` : '## 本课已教要点（反馈只对照这些）')
  for (const s of points) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  if (!points.length) lines.push('', '（本节还没有可对照的正文要点——只就表述本身反馈是否清楚。）')
  lines.push('', '## 学习者的自注', '', note.slice(0, 4000))
  return lines.join('\n')
}
