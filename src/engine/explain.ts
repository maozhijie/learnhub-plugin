/**
 * E2「讲给我听」（#68 / ADR-0009 Learner Output）：费曼讲解会话的纯规则层。
 *
 * 会话骨架（原型 #47 转正）：学习者用自己的话讲 → AI 扮完全不懂的初学者按正文要点
 * 追问（抓含糊/跳跃/说错，不评分不超纲）→ 收尾给定位反馈（对/错/部分对 + 定位 +
 * 可怎么补）。判词只入 E 档案、零 XP、不写 canonical。
 *
 * 两个接缝：讲稿包/指令拼装（explainBackPack）与判词解析（parseExplainVerdict，
 * AI 输出不可解析时抛错——判卷失败零副作用，ADR-0004）。
 */

/** 正文要点条目（节标题 + 现正文；s1–s3 型，来自 lessonSections/节清单）。 */
export interface ExplainPoint { title: string; md: string }

/** 讲解会话包：{正文要点 + 图位置 + 初学者人设指令}——宿主/tutor 会话的 system/首条消息。 */
export function explainBackPack(
  course: string, node: string, sections: ExplainPoint[], pre: string[], succ: string[],
): string {
  const lines: string[] = []
  lines.push(`# 讲给我听：${course} / ${node}`)
  lines.push('', '学习者刚学完这一课，即将**用他自己的话**把内容讲给你听。')
  lines.push('', '## 本课正文要点（你的一切追问与反馈只对照这些，不超纲）')
  for (const s of sections) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  if (!sections.length) lines.push('', '（本课还没有可对照的正文要点——只围绕学习者讲稿本身追问表述是否清楚。）')
  lines.push('', '## 图位置',
    `- 前置：${pre.join('、') || '无'}`,
    `- 后继：${(succ ?? []).join('、') || '无'}`)
  lines.push('', '## 你的角色（完全不懂的初学者）',
    '1. 你扮演对该主题**完全不懂**的初学者：不认识任何术语与公式，只依据学习者讲解里的说法来理解。',
    '2. 追问只依据上面的「本课正文要点」：抓讲稿里的**含糊**（表述不精确）、**跳跃**（缺关键步骤）、**说错**（与要点矛盾），每次只问一个问题，逼学习者讲清「为什么」。',
    '3. 不评分、不夸奖、不当考官——你是真的不懂；绝不超纲：不问要点之外的内容、不引入新概念、不给答案。',
    '4. 多轮进行：学习者回答后继续追问还没讲清的点；学习者说「换一种问」时，换一个角度重问当前没讲清的点。',
    '5. 要点都问到后，以初学者口吻简短收尾（如「我大概明白了」），不替学习者总结。')
  lines.push('', '讲解用 Markdown，公式用 KaTeX（$...$）。现在等学习者开讲。')
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
  return [
    '你是 learnhub 的学习教练。学习者刚把一节课讲给一位完全不懂的初学者听，你拿到完整对话与该课正文要点。',
    '请对照要点给一次**定位反馈**：是非判断（对/部分对/错）+ 偏离定位（含糊=表述不精确、跳跃=缺关键步骤、说错=与要点矛盾）+ 每处「可怎么补」。',
    '这是学习反馈不是评分：不打分数、不评级；语气直接、引用学习者原话定位。',
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

/** 定位反馈回合的 user 材料：要点 + 完整对话记录。 */
export function explainFeedbackPrompt(sections: ExplainPoint[], transcript: string): string {
  const lines: string[] = ['## 本课正文要点（反馈只对照这些）']
  for (const s of sections) {
    lines.push('', `### ${s.title}`, '', s.md.slice(0, 1200))
  }
  lines.push('', '## 讲解对话记录', '', transcript.slice(-8000))
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
