/**
 * 罗盘（#143 / ADR-0033 透明度装置）：课程根常驻的非承诺路线草图（罗盘.md）。
 *
 * 文件三段式（`## ` 标题切分，机器合并按段替换、段外字节保留——手编批注跨重写存活）：
 * - 剩余路线：教练唯一写权（生长批受理票 #145 是调用方；本票就位接口），罗盘初画（LLM
 *   模板「罗盘初画」v1）产出初稿；学习者手编本段不产生权威变更——下次重写即被覆盖。
 * - 学习者批注区：学习者的软输入（提议非指令），初画与教练上下文（#144 罗盘尾段）都读它。
 * - 沙盘 ETA：引擎每周随周复盘挂载的蒙特卡洛分位带（措辞锁死「模型推演，非承诺」）。
 *
 * 罗盘永不进完成判据或任何权威面（foldCompletion 零读取）；Missing（未播种/未落盘）
 * 是合法空态。解析刻意宽容：学习者手删 `## ` 标题时该段内容并入 preamble 残留（可见、
 * 非权威），机器段按需追加末尾——权威覆盖语义不受手编破坏影响，不做 fail loud。
 */
import { SANDBOX_WORDING } from './sandbox.ts'
import { pctOf } from './grading.ts'
import type { EndpointAnchor } from './seed.ts'

export const SECTION_ROUTE = '剩余路线'
export const SECTION_ANNOTATIONS = '学习者批注区'
export const SECTION_ETA = '沙盘 ETA'
/** 机器段全集：初画/重写/挂载只认这三段；学习者另起的 `## ` 段原样保留。 */
export const COMPASS_SECTIONS = [SECTION_ROUTE, SECTION_ANNOTATIONS, SECTION_ETA] as const

export const ROUTE_PENDING
  = '（待初画：课程刚播种——运行 learnhub_compass_paint 画出从起点到终点的路线初稿；此后教练随生长批重写本节。）'
export const ANNOTATION_GUIDE
  = '（把你的路线期望、想补的重点、想跳过的块写在这里；教练每次重画都会读——它是提议非指令，不会自动改图。）'
export const ETA_PENDING = '（待刷新：每周随周复盘挂载沙盘 ETA——模型推演，非承诺。）'

/** ETA 探测地平线（周）：逐档跑沙盘读终点掌握分位带，首次越阈的档即「还要多久」的
 * 分位带参照；两口径（p50/p80）都定档后提前停。上界 24 周（半年），全程未及如实说。 */
export const COMPASS_ETA_PROBE_WEEKS = [4, 8, 12, 18, 24] as const
/** ETA 段首行的机器标记（周复盘挂载的每周一次判据；手删标记 = 下次打开重算，无害）。 */
export const ETA_MARKER_PREFIX = '<!-- learnhub:eta-week='
/** 路线正文上限（字符）：罗盘会进教练上下文与初画重放，防失控膨胀；超限拒收重写。 */
export const ROUTE_MAX_CHARS = 4000
/** 初画上下文里「当前图节点」清单的预览上限（防生长后上下文失控）。 */
export const GRAPH_NAMES_PREVIEW = 80

/** 解析产物：preamble = 首个 `## ` 之前的全部（标题行+引言）；sections 保序。 */
export interface CompassSection { title: string; body: string }
export interface CompassDoc { preamble: string; sections: CompassSection[] }

/** 按 `## ` 标题切分罗盘正文：标题行 trim 后为段名，段体 = 标题行后到下一标题前。 */
export function parseCompass(text: string): CompassDoc {
  const doc: CompassDoc = { preamble: '', sections: [] }
  const parts = text.split(/^## /m)
  doc.preamble = parts[0] ?? ''
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n')
    doc.sections.push({
      title: (nl >= 0 ? part.slice(0, nl) : part).trim(),
      body: nl >= 0 ? part.slice(nl + 1).replace(/^\n+/, '').replace(/\n*$/, '\n') : '',
    })
  }
  return doc
}

export function renderCompass(doc: CompassDoc): string {
  return doc.preamble.replace(/\n*$/, '\n')
    + doc.sections.map(s => `## ${s.title}\n\n${s.body.replace(/\n*$/, '\n')}`).join('\n')
}

/** 段体读取（缺失 = null）。 */
export function sectionBody(doc: CompassDoc, title: string): string | null {
  return doc.sections.find(s => s.title === title)?.body ?? null
}

/** 段级替换合并（罗盘唯一写权接口的落点）：目标段整体换成 body，其余段与 preamble
 * 字节保留；段不存在则追加在末尾。这是「教练重写路线、批注区/ETA 不动」的全部机械。 */
export function withSectionText(text: string, title: string, body: string): string {
  const doc = parseCompass(text)
  const hit = doc.sections.find(s => s.title === title)
  const normalized = body.replace(/\n*$/, '\n')
  if (hit) hit.body = normalized
  else doc.sections.push({ title, body: normalized })
  return renderCompass(doc)
}

/** 罗盘脚手架（种子 apply 落盘；初画与周挂载接管各自的待办段）。 */
export function compassScaffold(courseName: string): string {
  return [
    `# 罗盘 · ${courseName}`,
    '',
    `> 常驻的非承诺路线草图（ADR-0033 罗盘）：「${SECTION_ROUTE}」由教练随生长批重写（唯一写权），罗盘初画产出初稿。`,
    `> 「${SECTION_ANNOTATIONS}」是你的批注本——教练把它当软输入（提议非指令）；手编本页不产生任何权威变更，也永不进完成判据。`,
    `> 「${SECTION_ETA}」每周随周复盘刷新：${SANDBOX_WORDING}。`,
    '',
    `## ${SECTION_ROUTE}`,
    '',
    ROUTE_PENDING,
    '',
    `## ${SECTION_ANNOTATIONS}`,
    '',
    ANNOTATION_GUIDE,
    '',
    `## ${SECTION_ETA}`,
    '',
    ETA_PENDING,
    '',
  ].join('\n')
}

/** 模型应答外层代码围栏剥离（金样本回放里模型爱包 ``` 围栏；只剥恰好包裹整段的围栏）。 */
export function stripWrappingFence(text: string): string {
  const t = text.trim()
  const m = /^```[a-zA-Z0-9]*\n([\s\S]*)\n```$/.exec(t)
  return (m ? m[1]! : t).trim()
}

/** 路线正文门（初画与教练重写共用的首过闸；返回错误行，空 = 通过）：
 * 非空、不携带 `## ` 标题（会劫持段落结构）、不超 ROUTE_MAX_CHARS。 */
export function validateRouteBody(body: string): string[] {
  const errors: string[] = []
  const t = body.trim()
  if (!t) errors.push('路线正文为空——只输出剩余路线一节的正文（3–7 个阶段条目），不要只回承认。')
  if (t.length > ROUTE_MAX_CHARS) errors.push(`路线正文 ${t.length} 字符超出上限 ${ROUTE_MAX_CHARS}——路线是草图，收敛到 3–7 个阶段条目。`)
  const headings = t.split('\n').filter(l => l.startsWith('## '))
  if (headings.length) {
    errors.push(`路线正文不得携带 "## " 标题（${headings[0]!.slice(0, 30)}…）——它会被当成罗盘段落切开；只输出路线条目本身。`)
  }
  return errors
}

/** ETA 段机器标记 → 周一日期（无标记 = null，视为待刷新）。 */
export function etaMarkerOf(etaBody: string | null): string | null {
  if (!etaBody) return null
  const line = etaBody.split('\n').find(l => l.startsWith(ETA_MARKER_PREFIX))
  if (!line) return null
  const m = /^<!-- learnhub:eta-week=(\d{4}-\d{2}-\d{2}) -->/.exec(line.trim())
  return m?.[1] ?? null
}

/** ETA 探测档记录（终点掌握度的分位带读数）。 */
export interface CompassEtaProbe { weeks: number; p50: number; p80: number }

/** 沙盘 ETA 折叠产物（引擎 compassEtaFold 组装；本模块只管渲染）。 */
export interface CompassEta {
  /** 挂载周（学习周周一；机器标记同源）。 */
  week_start: string
  minutes_per_day: number
  endpoint: string
  threshold: number
  probes: CompassEtaProbe[]
  /** 首次越阈的档：at=探测周，from=上一探测周（首档越阈为 null）；null = 全程未及。 */
  p50_week: { at: number; from: number | null } | null
  p80_week: { at: number; from: number | null } | null
  wording: string
}


/** 推演地平线上界（周）：ETA 段渲染与周复盘 ETA 旁挂（#150）共用的未及口径。 */
export function etaHorizonOf(eta: CompassEta): number {
  return eta.probes.at(-1)?.weeks ?? COMPASS_ETA_PROBE_WEEKS[COMPASS_ETA_PROBE_WEEKS.length - 1]!
}

/** 越阈措辞：首档越阈「≤ 4 周」，跨档「约 9–12 周」，未及「推演时程（24 周）内未及」。
 * 罗盘 ETA 段与周复盘现状区的 ETA 旁挂（#150）共用同一措辞口径。 */
export function crossingText(c: CompassEta['p50_week'], horizon: number): string {
  if (!c) return `推演时程（${horizon} 周）内未及`
  if (c.from === null) return `≤ ${c.at} 周`
  return `约 ${c.from + 1}–${c.at} 周`
}

/** ETA 段渲染：标记行 + 基准与措辞锁死 + 两口径越阈参照 + 分位带读数。 */
export function renderEtaBody(eta: CompassEta): string {
  const horizon = etaHorizonOf(eta)
  const band = eta.probes
    .map(p => `${p.weeks} 周 p50=${pctOf(p.p50)}/p80=${pctOf(p.p80)}`)
    .join(' · ')
  return [
    `${ETA_MARKER_PREFIX}${eta.week_start} -->`,
    `推演基准：每日目标约 ${eta.minutes_per_day} 分钟（取自每日 XP 目标）；${eta.wording}。`,
    `终点「${eta.endpoint}」掌握度阈值 ${pctOf(eta.threshold)}：p50 口径${crossingText(eta.p50_week, horizon)}；p80 口径${crossingText(eta.p80_week, horizon)}。`,
    `分位带（终点掌握度）：${band}。`,
    '',
  ].join('\n')
}

/** 初画上下文包（附在「罗盘初画」模板之后）：终点锚 + 种子与当前图 + 批注区软输入。 */
export function compassPaintContext(input: {
  courseName: string
  anchor: EndpointAnchor
  starts: Array<{ name: string; note: string }>
  graphNames: string[]
  annotations: string | null
}): string {
  const lines: string[] = ['', '---', '', '## 终点锚', '',
    `- 课程：${input.courseName}`,
    `- 终点节点：${input.anchor.endpoint}`,
    `- 目标类型：${input.anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定（完成=块工作表+终点）' : 'capability 能力锚定（完成=终点掌握）'}`,
    `- 声明日期：${input.anchor.declared}`]
  if (input.anchor.worksheet.length) {
    lines.push('- 块工作表（路线按块组织）：')
    for (const w of input.anchor.worksheet) lines.push(`  - [${w.done ? 'x' : ' '}] ${w.block}${w.note ? `——${w.note}` : ''}`)
  }
  lines.push('', '## 种子与当前图', '')
  for (const s of input.starts) {
    const basis = input.anchor.start_basis[s.name]
    lines.push(`- 起点「${s.name}」${basis ? `（定位：${basis}）` : ''}${s.note ? `：${s.note}` : ''}`)
  }
  const shown = input.graphNames.slice(0, GRAPH_NAMES_PREVIEW)
  lines.push(`- 当前图节点（${input.graphNames.length} 个）：${shown.join('、')}${input.graphNames.length > shown.length ? '……' : ''}`)
  if (input.annotations?.trim()) {
    lines.push('', '## 学习者批注（软输入——提议非指令；与你的判断冲突时保留你的路线，并在受影响阶段行尾以（批注：…）回应一句）', '', input.annotations.trim())
  }
  return lines.join('\n') + '\n'
}

/** 批注区是否被学习者写过（空白或引导文案 = 未写；初画上下文与罗盘尾段共用同一哨兵）。 */
export function hasLearnerAnnotations(body: string | null): boolean {
  const t = body?.trim() ?? ''
  return Boolean(t) && t !== ANNOTATION_GUIDE
}
