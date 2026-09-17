/**
 * 罗盘（#143 / ADR-0033 透明度装置；#316 / ADR-0099 写权反转）：课程根常驻的非承诺路线
 * 草图（罗盘.md）。
 *
 * 文件三段式（`## ` 标题切分，机器合并按段替换、段外字节保留——手编批注跨重写存活）：
 * - 剩余路线：**罗盘站唯一写权**（ADR-0099：教练是局部最优求解器，不得直接改弧——
 *   #310/ADR-0097 的「思路官随方向批携带 route」随 #316 退役）。`learnhub_compass_paint`
 *   经「罗盘初画/罗盘重画」两族模板产出正文；重估触发（终点增删/目标描述修订）置重画
 *   待办标记，进度不触发重画。学习者手编本段不产生权威变更——下次重写即被覆盖。
 * - 学习者批注区：学习者的软输入（提议非指令），初画与教练上下文（#144 罗盘尾段）都读它。
 * - 沙盘 ETA：引擎每周随周复盘挂载的蒙特卡洛分位带（措辞锁死「模型推演，非承诺」）。
 *
 * 罗盘永不进完成判据或任何权威面（foldCompletion 零读取）；Missing（未落盘）
 * 是合法空态。解析刻意宽容：学习者手删 `## ` 标题时该段内容并入 preamble 残留（可见、
 * 非权威），机器段按需追加末尾——权威覆盖语义不受手编破坏影响，不做 fail loud。
 */
import { CONCEPT_TIERS, type ConceptTier } from '../types.ts'
import { SANDBOX_WORDING } from '../sched/sandbox.ts'
import { pctOf } from '../infra/grading.ts'
import type { EndpointAnchor } from './seed.ts'

/** 罗盘站的语料站标签（#313 D19）：站名是受控词表（host STATIONS）成员，引擎侧单一出处
 * ——此前引擎与宿主各写一份字面量，改名即静默分裂成两个语料目录。 */
export const COMPASS_STATION = '罗盘'

export const SECTION_ROUTE = '剩余路线'
export const SECTION_ANNOTATIONS = '学习者批注区'
export const SECTION_ETA = '沙盘 ETA'
/** 机器段全集：初画/重写/挂载只认这三段；学习者另起的 `## ` 段原样保留。 */
export const COMPASS_SECTIONS = [SECTION_ROUTE, SECTION_ANNOTATIONS, SECTION_ETA] as const

export const ROUTE_PENDING
  = '（待初画：运行 learnhub_compass_paint 按锚定终点画出路线初稿——一节一个终点；此后由罗盘站低频重估重画。）'
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
    `> 罗盘：常驻可见的路线草图，不构成承诺。「${SECTION_ROUTE}」由罗盘站写（learnhub_compass_paint 初画；低频重估重画，写权归罗盘站——教练只建议不执笔）。`,
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

/** 路线正文门（罗盘站写盘共用的首过闸；返回错误行，空 = 通过）：
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

/** 路线条目的候选标注（罗盘站模板硬约束：未落图的台阶「一律标注（候选）」）。 */
export const ROUTE_CANDIDATE_MARKER = '候选'

/** 重画待办标记（#316 触发接线）：写侧事件（终点增删/目标描述修订）在「剩余路线」段尾
 * 追加一行机器注释（段级合并下跨罗盘站其他写盘存活；compass_paint 落盘新正文时自然清除）。
 * 只标记不触发——重画仍由人/教练显式拉起罗盘站。 */
export const REPAINT_MARKER_PREFIX = '<!-- learnhub:repaint-due'
export const REPAINT_MARKER = `${REPAINT_MARKER_PREFIX} -->`

/** 路线段是否带重画待办标记（返回触发原因，无标记 = null）。 */
export function repaintDueOf(routeBody: string | null): string | null {
  const line = routeBody?.split('\n').find(l => l.startsWith(REPAINT_MARKER_PREFIX))
  if (!line) return null
  const m = new RegExp(`^${REPAINT_MARKER_PREFIX}(?:=(.*))? -->$`).exec(line.trim())
  return (m?.[1] ?? '').trim() || '方向声明变更'
}

/** 给路线段正文追加重画待办标记（已标记 = 幂等不叠加；原样返回）。 */
export function withRepaintMarker(routeBody: string, reason: string): string {
  if (repaintDueOf(routeBody)) return routeBody
  const trimmed = routeBody.replace(/\n*$/, '\n')
  return `${trimmed}<!-- learnhub:repaint-due=${reason} -->\n`
}

/** 深度档行内声明（弧格式可选字段，#316 §修订四）：`（会用）` / `（深度：能教）`。 */
const TIER_DECL_RE = /[（(](?:深度[:：])?(知道|会用|能教)[)）]/

/** 程度指向的粗词面（WARN① 倾向性检查的词表）：条目行含任一词即视为「说得出推进
 * 程度声明的哪个维度」。纯词面粗查、零语义解析——WARN 只提示不拒收，人审兜底。 */
const DEPTH_HINT_WORDS = ['程度', '深度', '广度', '综合运用', ...['知道', '会用', '能教']] as const

/** 罗盘「剩余路线」的终点节结构（弧条目解析，#316 周检讨与 WARN 共用）：节头 =
 * `- **终点名**：`（模板输出契约），节下条目 = `- **阶段名**：一句话` 行。 */
export interface RouteEndpointSection {
  endpoint: string
  /** 面条目：名字（粗体段，无粗体退回整行粗提）+ 深度档声明（缺省 null）+ 是否标候选 + 原行。 */
  faces: Array<{ name: string; tier: ConceptTier | null; candidate: boolean; text: string }>
}

/** 解析路线正文为逐终点节（不硬拒任何形态）。节头判据：`- **终点名**：` 且冒号后
 * 无正文（面条目同名形态但冒号后必有半句，二者可区分）；无节头时条目归 endpoint=''。 */
export function parseRouteSections(body: string): RouteEndpointSection[] {
  const out: RouteEndpointSection[] = []
  let cur: RouteEndpointSection | null = null
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('<!--')) continue
    const head = /^- \*\*(.+?)\*\*[:：]\s*$/.exec(line)
    if (head) {
      cur = { endpoint: head[1]!.trim(), faces: [] }
      out.push(cur)
      continue
    }
    const tier = TIER_DECL_RE.exec(line)?.[1] as ConceptTier | undefined ?? null
    const face: RouteEndpointSection['faces'][number] = {
      name: routeEntryName(line),
      tier,
      candidate: line.includes(ROUTE_CANDIDATE_MARKER),
      text: line,
    }
    if (cur) cur.faces.push(face)
    else out.push(cur = { endpoint: '', faces: [face] })
  }
  return out
}

/** 路线正文倾向性检查（#316：返回 WARN 行，空 = 无提示——**不拒收**，人审兜底）：
 * ① 条目说不出程度指向（无深度档声明且无任何程度维度词）；② 一整节零深度档声明。 */
export function routeBodyWarns(body: string): string[] {
  const warns: string[] = []
  const sections = parseRouteSections(body)
  for (const sec of sections) {
    let declared = 0
    for (const face of sec.faces) {
      if (face.tier) declared++
      else if (!DEPTH_HINT_WORDS.some(w => face.text.includes(w))) {
        warns.push(`「${face.name}」未声明深度档、也说不出程度指向——补半句它推进目标描述的哪个维度（深度/广度/综合运用），或标（深度：知道/会用/能教）。`)
      }
    }
    if (sec.faces.length && !declared) {
      const label = sec.endpoint ? `终点「${sec.endpoint}」` : '未分节路线'
      warns.push(`${label}一整节零深度档声明——每条面可选标（深度：知道/会用/能教），供周检讨算「需求 vs 现状」深度差。`)
    }
  }
  return warns
}

/** 周检讨读数（#316 §修订四；取代 ADR-0074「无锚即漂移」对账——对账方向从「地图追进度」
 * 反转为「给地图叠进度」）：零模型、零写侧、只读图面。**非权威**：不改罗盘、不进门禁、
 * 不触发重画；只把不该被忽略的偏差摆进周复盘现状区。覆盖口径本期 = 图上有节点
 * （「覆盖 = 组合运用过一次」的重算随 #318 切换，切换点在门册与 #317 B2 留痕）。 */
export interface RouteWeeklyReview {
  endpoint: string
  /** 覆盖缺口：图上零节点的面（名字粗匹配：互相包含即命中）。 */
  gaps: string[]
  /** 深度差：需求档（弧声明）> 现状档（面节点 teaches 概念折叠取最高档）的面。
   * 任一侧未声明不判（缺席不推定——现状无 teaches 档时不出行）。 */
  depth_gaps: Array<{ name: string; required: ConceptTier; actual: ConceptTier }>
  /** 跨面配比（粗）：逐面已落节点数（只作提示不判错，无权重语义）。 */
  shares: Array<{ name: string; nodes: number }>
}

/** 单终点节的周检讨读数。graphNames = 全图节点名；tierOfNode = 节点 → teaches 概念档
 * 折叠后的最高档（调用方用 foldTiers 同款口径组装；无 teaches = null，不推定）。 */
export function routeWeeklyReview(
  section: RouteEndpointSection,
  graphNames: readonly string[],
  tierOfNode: (node: string) => ConceptTier | null,
): RouteWeeklyReview {
  const gaps: string[] = []
  const depth_gaps: RouteWeeklyReview['depth_gaps'] = []
  const shares: RouteWeeklyReview['shares'] = []
  for (const face of section.faces) {
    const hit = graphNames.filter(n => n.includes(face.name) || face.name.includes(n))
    if (!hit.length) gaps.push(face.name)
    shares.push({ name: face.name, nodes: hit.length })
    if (face.tier) {
      const actuals = hit.map(tierOfNode).filter((t): t is ConceptTier => t !== null)
      if (!actuals.length) continue // 现状侧未声明（无 teaches 档）不推定、不判差
      const actual = CONCEPT_TIERS[Math.max(...actuals.map(t => CONCEPT_TIERS.indexOf(t)))]!
      if (CONCEPT_TIERS.indexOf(face.tier) > CONCEPT_TIERS.indexOf(actual)) {
        depth_gaps.push({ name: face.name, required: face.tier, actual })
      }
    }
  }
  return { endpoint: section.endpoint, gaps, depth_gaps, shares }
}

/** 弧条目名提取：模板行是 `- **阶段名**：一句话` ——取粗体段；无粗体时退回「行首标记后、
 * 第一个分隔符前」的一段，再退回整行（周检讨匹配与 WARN 点名只要一个可读名，不做语义解析）。 */
function routeEntryName(line: string): string {
  const bold = /\*\*(.+?)\*\*/.exec(line)
  if (bold) return bold[1]!.trim()
  const body = line.replace(/^\s*(?:[-*+]|\d+[.、)])\s*/, '').trim()
  const cut = body.search(/[：:（(]/)
  return ((cut > 0 ? body.slice(0, cut) : body).trim() || body || line)
}

/** 路线段是否已画（占位/空白 = 未画 → 无周检讨对象；判据与 ROUTE_PENDING 同源，
 * 与 hasLearnerAnnotations 同族）。 */
export function hasPaintedRoute(body: string | null): boolean {
  const t = body?.trim() ?? ''
  return Boolean(t) && t !== ROUTE_PENDING
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

/** 单终点的探测带读数（逐终点独立探测：越阈即提前停，各终点互不影响）。 */
export interface CompassEtaRow {
  endpoint: string
  probes: CompassEtaProbe[]
  /** 首次越阈的档：at=探测周，from=上一探测周（首档越阈为 null）；null = 全程未及。 */
  p50_week: { at: number; from: number | null } | null
  p80_week: { at: number; from: number | null } | null
}

/** 沙盘 ETA 折叠产物（引擎 compassEtaFold 组装；本模块只管渲染）。
 * ADR-0076 罗盘多终点分节：逐终点一行（越阈参照照旧、非承诺措辞锁死）。 */
export interface CompassEta {
  /** 挂载周（学习周周一；机器标记同源）。 */
  week_start: string
  minutes_per_day: number
  threshold: number
  /** 逐终点一行（每终点独立探测带与越阈参照）。 */
  rows: CompassEtaRow[]
  wording: string
}

/** 单终点的越阈参照类型（crossingText 入参）。 */
export type CrossingRef = CompassEtaRow['p50_week']

/** 推演地平线上界（周）：ETA 段渲染与周复盘 ETA 旁挂（#150）共用的未及口径。
 * 逐终点行取该行实际探测到的最深档（未及时 = 全地平线）。 */
export function etaHorizonOf(row: { probes: CompassEtaProbe[] }): number {
  return row.probes.at(-1)?.weeks ?? COMPASS_ETA_PROBE_WEEKS[COMPASS_ETA_PROBE_WEEKS.length - 1]!
}

/** 越阈措辞：首档越阈「≤ 4 周」，跨档「约 9–12 周」，未及「推演时程（24 周）内未及」。
 * 罗盘 ETA 段与周复盘现状区的 ETA 旁挂（#150）共用同一措辞口径。 */
export function crossingText(c: CrossingRef, horizon: number): string {
  if (!c) return `推演时程（${horizon} 周）内未及`
  if (c.from === null) return `≤ ${c.at} 周`
  return `约 ${c.from + 1}–${c.at} 周`
}

/** ETA 段渲染：标记行 + 基准与措辞锁死 + 逐终点一行的越阈参照与分位带读数。 */
export function renderEtaBody(eta: CompassEta): string {
  const lines = [
    `${ETA_MARKER_PREFIX}${eta.week_start} -->`,
    `推演基准：每日目标约 ${eta.minutes_per_day} 分钟（取自每日 XP 目标）；${eta.wording}。`,
  ]
  for (const row of eta.rows) {
    const horizon = etaHorizonOf(row)
    const band = row.probes
      .map(p => `${p.weeks} 周 p50=${pctOf(p.p50)}/p80=${pctOf(p.p80)}`)
      .join(' · ')
    lines.push(`终点「${row.endpoint}」掌握度阈值 ${pctOf(eta.threshold)}：p50 口径${crossingText(row.p50_week, horizon)}；p80 口径${crossingText(row.p80_week, horizon)}。`)
    lines.push(`分位带（终点掌握度）：${band}。`)
  }
  return lines.join('\n') + '\n'
}

/** 初画上下文包（附在「罗盘初画」模板之后）：终点锚集合 + 起草起点与当前图 + 批注区软输入。 */
export function compassPaintContext(input: {
  courseName: string
  anchors: EndpointAnchor[]
  starts: Array<{ name: string; note: string }>
  graphNames: string[]
  annotations: string | null
}): string {
  const lines: string[] = ['', '---', '', '## 终点锚', '',
    `- 课程：${input.courseName}`]
  for (const anchor of input.anchors) {
    lines.push(
      `- 终点节点：${anchor.endpoint}`,
      `  - 目标类型：${anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定（完成=块工作表+终点）' : 'capability 能力锚定（完成=终点掌握）'}`,
      `  - 声明日期：${anchor.declared}`)
    if (anchor.goal_note) lines.push(`  - 目标描述：${anchor.goal_note}（这是程度声明——弧要答「推进它的哪个维度」）`)
  }
  lines.push('', '## 起草起点与当前图', '')
  // 起点定位按锚顺序首个命中（同一名字出现在多条锚的起草批次里时取先声明的那条）
  const basisOf = (name: string): string | undefined => {
    for (const a of input.anchors) {
      const b = a.start_basis[name]
      if (b) return b
    }
    return undefined
  }
  for (const s of input.starts) {
    const basis = basisOf(s.name)
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
