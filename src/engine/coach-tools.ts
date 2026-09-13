/**
 * 教练只读工具面（ADR-0041 / #163）：教练工具回路可调用的**只读引擎视图白名单**——
 * 图视图、节点卡、概念登记表、行为摘要、题库概况、罗盘、终点锚七件。裁决前按需自查
 * 取代盲盒上下文包的证据缺口：区/块与节点名、pre 引用、概念名在产出裁决前可直接对表。
 *
 * 信任边界不动：教练不持任何写工具——写路径仍走提案→受理门→apply 正道；工具实现
 * 只有读侧引擎视图，没有队列入口、没有教练/入队触点（防递归自激）；白名单外调用
 * 一律拒收（isError 回灌，模型可见）。原则照旧：工具访问提升证据质量，回路产物照过
 * 全部既有门，门不因回路存在而放松。
 *
 * 归属：本文件是 Growth 域的读侧视图折叠（与 coach-round.ts 同域），不回引门面、
 * 不 import growth-subsystem（R7 零环）——引擎访问面经 `CoachToolDeps` 结构化注入
 * （GrowthDeps 天然满足），行为摘要这类依赖子系统私有取材口径的视图经 providers
 * 注入（单一出处不漂移）。
 */
import { effectiveStage } from './audit.ts'
import type { CompassDoc } from './compass.ts'
import { ETA_PENDING, SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, etaMarkerOf, hasLearnerAnnotations, parseCompass, sectionBody } from './compass.ts'
import type { ConceptRegistry } from './concepts.ts'
import type { Graph } from './graph.ts'
import type { VaultFs } from './io.ts'
import { hasReadyContent } from './notes.ts'
import type { Paths } from './paths.ts'
import type { BankDoc } from './question-bank.ts'
import { readAnchor } from './seed.ts'
import { readySet } from './sessions.ts'
import type { CourseEntry, Fm } from './types.ts'
import type { LlmToolCall, LlmToolSpec } from './llm.ts'

/** 工具面白名单（ADR-0041 七件，名字是教练工具调用的唯一取值域）。 */
export const COACH_TOOL_NAMES = [
  'graph_view', 'node_card', 'concept_registry', 'behavior_digest',
  'bank_overview', 'compass_read', 'endpoint_anchor',
] as const
export type CoachToolName = (typeof COACH_TOOL_NAMES)[number]

/** 图面全名单的预览上限（防生长后视图失控；自 growth-subsystem 随工具面归位）。
 * 比罗盘初画的 GRAPH_NAMES_PREVIEW (80) 宽：教练裁决的 pre 引用必须逐字命中既有
 * 节点名，名单截断会直接造成受理门断边拒收——上限只防膨胀，不服务取值域完整性时
 * 才收紧。 */
const GRAPH_NAMES_CAP = 200

/** 登记表/题库概况等列表视图的渲染上限（同上：防膨胀不防完整性）。 */
const LIST_CAP = 200

/** 节点阶段的人读标签（growthGraphView 的细节行口径，图面与节点卡共用）。 */
function activeLabel(state: Record<string, Fm>, n: string): string {
  const s = effectiveStage(state, n)
  if (s === 'learning') return '在学'
  if (s === 'mastered') return '已掌握'
  if (s === 'review') return '复习中'
  return hasReadyContent(state[n]) ? '未开始·正文已生成' : '未开始·待生成'
}

/** 图面（教练回路 graph_view 与生长批上下文包第三块共用同一折叠；自 growth-subsystem
 * 归位）：结构事实源——裁决 ops 的节点名与 pre 引用的取值域。前沿与在学节点给细节行
 * （区·块/pre/teaches/est/正文态），其余节点给全名单（供 set_pre 等引用既有节点）。
 * endpoint：终点恒标（#200 / ADR-0055）——图面头部带终点行，终点节点细节行带标记；
 * 轻量段同吃这份图面，裁决不盲。纯组装零写副作用。 */
export function renderGrowthGraphView(
  graph: Graph, state: Record<string, Fm>, endpoint: string | null = null,
): string {
  // 前沿 = readySet（未开始且非 opt 前置全部达成）；rValue 恒 1 = R 软闸不改变可学性、
  // 故不带门——与教练回合检查点的前沿口径同源（GrowthSubsystem.coachFrontier 同款）。
  const active = [...new Set([
    ...readySet(graph, state, () => 1),
    ...graph.names.filter(n => effectiveStage(state, n) === 'learning'),
  ])].sort()
  const activeSet = new Set(active)
  const lines: string[] = [
    '## 当前图面（结构事实源——ops 的节点名与 pre 引用必须逐字来自这里）', '',
    `- 节点共 ${graph.names.length} 个；前沿与在学 ${active.length} 个（带细节行）`,
    ...(endpoint
      ? [`- ⚑ 终点：${endpoint}（承诺标记——一切生长须汇入它；不可 del/rename，零正文零题库不被调度，主线批须 set_pre 接线到新前沿）`]
      : ['（未播种——终点锚 Missing，先走种子提案 kind=seed）']),
    '', '### 前沿与在学节点', '',
  ]
  for (const n of active) {
    const [, region, block] = graph.blockOf[n]
    const pres = graph.preOf[n]
    const teaches = Object.entries(graph.teachesOf[n] ?? {}).map(([c, t]) => `${c} ${t}`)
    const est = graph.estOf[n]
    lines.push(`- ${n}${n === endpoint ? ' ⚑' : ''}（${region}·${block}｜${activeLabel(state, n)}${est ? `｜est ${est}′` : ''}）`
      + `｜pre: ${pres.length ? pres.join('、') : '（根）'}`
      + (teaches.length ? `｜teaches: ${teaches.join('、')}` : ''))
  }
  const rest = graph.names.filter(n => !activeSet.has(n)).sort()
  if (rest.length) {
    const shown = rest.slice(0, GRAPH_NAMES_CAP)
    lines.push('', `### 其余节点（全部名单，供 pre 引用；共 ${rest.length} 个）`, '',
      shown.join('、') + (rest.length > shown.length ? `……（超出预览上限 ${GRAPH_NAMES_CAP}，余 ${rest.length - shown.length} 个）` : ''))
  }
  return lines.join('\n') + '\n'
}

/** 节点卡（node_card）：单节点的结构档与内容态——区·块、阶段、pre/teaches/assumes、
 * est、下游消费、误解先验。未知节点 fail loud（graph_view 取逐字名单），不静默编空卡。
 * endpoint：终点卡恒标（#200）——下游消费与调度措辞按承诺标记口径。 */
export function renderNodeCard(
  graph: Graph, state: Record<string, Fm>, node: string, endpoint: string | null = null,
): string {
  if (!graph.nset.has(node)) {
    throw new Error(`节点「${node}」不在图上——用 graph_view 取逐字名单后重试（引用必须逐字命中）。`)
  }
  const [, region, block] = graph.blockOf[node]
  const pres = graph.preOf[node] ?? []
  const teaches = Object.entries(graph.teachesOf[node] ?? {})
  const assumes = Object.entries(graph.assumesOf[node] ?? {})
  const mis = graph.misconceptionsOf[node] ?? []
  const consumers = graph.succ[node] ?? []
  const isEndpoint = node === endpoint
  return [
    `## 节点卡：${node}${isEndpoint ? ' ⚑ 终点（承诺标记）' : ''}`, '',
    `- 区·块：${region} · ${block}`,
    `- 阶段：${activeLabel(state, node)}${isEndpoint ? '（终点——零正文零题库不被学习调度，ADR-0056）' : graph.typeOf[node] === 'practice' ? '（交互实践节点）' : ''}${graph.estOf[node] ? `｜est ${graph.estOf[node]}′` : ''}`,
    `- pre：${pres.length ? pres.join('、') : '（根）'}`,
    `- teaches：${teaches.length ? teaches.map(([c, t]) => `${c} ${t}`).join('、') : '（无）'}`,
    `- assumes：${assumes.length ? assumes.map(([c, t]) => `${c} ${t}`).join('、') : '（无）'}`,
    `- 下游消费：${consumers.length ? consumers.join('、') : isEndpoint ? '（无——终点是全局收敛点，后继不该存在；出现即异常态，走对账恢复）' : '（无——叶子节点）'}`,
    `- 误解先验：${mis.length ? mis.map(m => `${m.concept}：${m.model}`).join('；') : '（无）'}`,
  ].join('\n') + '\n'
}

/** 概念登记表视图（concept_registry）：canonical/别名/定义折叠；query 子串过滤
 * （命中 canonical 或别名）。登记表是铸名对表的唯一权威——裁决 concepts 块前先查。 */
export async function renderConceptRegistry(concepts: ConceptRegistry, c: CourseEntry, query?: string): Promise<string> {
  const entries = await concepts.load(c.root)
  const q = query?.trim()
  const hit = q
    ? entries.filter(e => e.canonical.includes(q) || (e.aliases ?? []).some(a => a.includes(q)))
    : entries
  const lines = [`## 概念登记表：${c.name}（${hit.length}/${entries.length} 条${q ? `，query=「${q}」` : ''}）`, '']
  if (!hit.length) {
    lines.push(entries.length ? '（无命中条目——名字对表以本表为准，裁决 concepts 只许铸本表没有的新名。）'
      : 'Missing（合法空态——铸名随生长批提案落盘；本批 concepts 铸名即可。）')
  }
  for (const e of hit.slice(0, LIST_CAP)) {
    lines.push(`- ${e.canonical}${e.aliases?.length ? `（别名：${e.aliases.join('、')}）` : ''}${e.definition ? `：${e.definition}` : ''}`)
  }
  if (hit.length > LIST_CAP) lines.push(`……（超出预览上限 ${LIST_CAP}，余 ${hit.length - LIST_CAP} 条——用 query 收窄）`)
  return lines.join('\n') + '\n'
}

/** 题库概况（bank_overview）：逐节点题目计数折叠（在库/归档/invokes 标注），裁决
 * 巩固/出题相关批时的现势参照。零题课程给合法空态行。 */
export async function renderBankOverview(
  scanCourseBanks: CoachToolDeps['scanCourseBanks'], c: CourseEntry,
): Promise<string> {
  const perNode: Array<{ node: string; total: number; archived: number; invokes: number }> = []
  await scanCourseBanks(c, async (_nodeName: string, bank: BankDoc) => {
    perNode.push({
      node: bank.node,
      total: bank.questions.length,
      archived: bank.questions.filter(q => q.archived === true).length,
      invokes: bank.questions.filter(q => typeof q.invokes === 'string' && q.invokes.trim()).length,
    })
  })
  perNode.sort((a, b) => a.node.localeCompare(b.node))
  const total = perNode.reduce((s, p) => s + p.total, 0)
  const lines = [`## 题库概况：${c.name}（${total} 题在 ${perNode.length} 个节点的库中）`, '']
  if (!perNode.length) {
    lines.push('（题库空——合法空态：题目随正文生成后的出题管线落库。）')
    return lines.join('\n') + '\n'
  }
  for (const p of perNode.slice(0, LIST_CAP)) {
    lines.push(`- ${p.node}：${p.total} 题（归档 ${p.archived} · invokes 标注 ${p.invokes}）`)
  }
  if (perNode.length > LIST_CAP) lines.push(`……（超出预览上限 ${LIST_CAP}，余 ${perNode.length - LIST_CAP} 个节点）`)
  return lines.join('\n') + '\n'
}

/** 罗盘视图（compass_read）：剩余路线 + 学习者批注（软输入——提议非指令）+ 沙盘 ETA
 * 的现势折叠。未播种给合法空态（终点锚同源判定）。 */
export async function renderCompassView(deps: CoachToolDeps, c: CourseEntry): Promise<string> {
  const anchor = await readAnchor(deps.paths.anchorPath(c.root), deps.fs)
  if (!anchor) return `## 罗盘：${c.name}\n\n（未播种——终点锚 Missing 是合法空态，先走种子提案 kind=seed。）\n`
  const path = deps.paths.compassPath(c.root)
  const doc: CompassDoc | null = deps.fs.exists(path) ? parseCompass(await deps.fs.readFile(path)) : null
  const route = (doc ? sectionBody(doc, SECTION_ROUTE)?.trim() : '') ?? ''
  const eta = (doc ? sectionBody(doc, SECTION_ETA)?.trim() : '') ?? ''
  const annotations = doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null
  const lines: string[] = [
    `## 罗盘：${c.name}`, '',
    `- 终点：${anchor.endpoint}（${anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定' : 'capability 能力锚定'}）`,
    `- 剩余路线：${route && route !== ETA_PENDING ? '已画（见下）' : '未画（占位/缺席）'}`,
  ]
  if (route && route !== ETA_PENDING) lines.push('', route)
  if (eta && eta !== ETA_PENDING) {
    lines.push('', `### 沙盘 ETA（模型推演，非承诺${etaMarkerOf(eta) ? `；${etaMarkerOf(eta)}周` : ''}）`, '', eta)
  }
  if (hasLearnerAnnotations(annotations)) lines.push('', '### 学习者批注（软输入——提议非指令）', '', annotations!.trim())
  return lines.join('\n') + '\n'
}

/** 终点锚视图（endpoint_anchor）：课程唯一结构承诺物——终点/目标类型/声明日/块工作表
 * 核销进度/收尾宣告（ADR-0056）。锚 Broken fail loud（承诺物损坏必须显式浮出，不静默
 * 折成未播种）。 */
export async function renderEndpointAnchor(deps: CoachToolDeps, c: CourseEntry): Promise<string> {
  const anchor = await readAnchor(deps.paths.anchorPath(c.root), deps.fs)
  if (!anchor) return `## 终点锚：${c.name}\n\n（未播种——终点锚 Missing 是合法空态，先走种子提案 kind=seed。）\n`
  const lines = [
    `## 终点锚：${c.name}`, '',
    `- 终点节点：${anchor.endpoint}`,
    `- 目标类型：${anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定（完成=块工作表+终点）' : 'capability 能力锚定（完成=终点掌握）'}`,
    `- 声明日期：${anchor.declared}`,
    `- 收尾宣告：${anchor.sealed ? `已收尾（${anchor.sealed} 宣告承诺兑现——完成判据折叠自终点.pre 集；重开主线接线批会自动清除）` : '未收尾（停摆前终点.pre 须指向你认定的最终台阶——零 add_node 的纯 set_pre 接线批即收尾宣告）'}`,
  ]
  if (anchor.worksheet.length) {
    lines.push(`- 块工作表：${anchor.worksheet.filter(w => w.done).length}/${anchor.worksheet.length} 已核销`
      + `（${anchor.worksheet.map(w => `${w.block}${w.done ? '✓' : ''}`).join('、')}）`)
  }
  return lines.join('\n') + '\n'
}

/** 工具面的引擎访问面（结构化注入；GrowthDeps 天然满足，零回引避免 R7 环）。 */
export interface CoachToolDeps {
  fs: VaultFs
  paths: Paths
  concepts: ConceptRegistry
  /** 逐节点题库扫描（bank_overview 取材）。 */
  scanCourseBanks: (c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>) => Promise<void>
  /** 图视图（graph_view / node_card 取材）。 */
  loadView: (c: { name: string; root: string }) => Promise<{ graph: Graph; state: Record<string, Fm> }>
}

/** 依赖子系统私有取材口径的视图经 providers 注入（单一出处）：行为摘要五件套的
 * 取材（invokes 解析/掌握度折叠）住在 growth-subsystem，工具面直接复用其渲染产物。 */
export interface CoachToolProviders {
  behaviorDigestText: () => Promise<string>
}

/** 白名单七件的工具规格（JSON Schema 直通 provider function calling）。 */
export function coachToolSpecs(): LlmToolSpec[] {
  const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object', properties, required, additionalProperties: false,
  })
  return [
    { name: 'graph_view', description: '当前课程图面：全部节点名单 + 前沿/在学节点细节行（区·块/pre/teaches/est/正文态）。裁决 ops 的节点名、region/block 与 pre 引用的取值域——产出裁决前先来这里对表。', parameters: obj({}) },
    { name: 'node_card', description: '单节点结构档：区·块、阶段、pre/teaches/assumes、est、下游消费、误解先验。', parameters: obj({ node: { type: 'string', description: '节点名（逐字，来自 graph_view）' } }, ['node']) },
    { name: 'concept_registry', description: '概念登记表：canonical/别名/定义。teaches/assumes/concepts 铸名对表的唯一权威——query 子串过滤可收窄。', parameters: obj({ query: { type: 'string', description: '可选子串（命中 canonical 或别名）' } }) },
    { name: 'behavior_digest', description: '行为摘要五件套（窗口=最近 7 学习日或 10 节取大）：掌握轨迹/卡点集中度/速度校准/误解活跃度/保留率。', parameters: obj({}) },
    { name: 'bank_overview', description: '题库概况：逐节点在库/归档/invokes 标注题数。巩固批与出题现势参照。', parameters: obj({}) },
    { name: 'compass_read', description: '罗盘现势：剩余路线 + 学习者批注（软输入，提议非指令）+ 沙盘 ETA。', parameters: obj({}) },
    { name: 'endpoint_anchor', description: '终点锚：终点节点/目标类型/声明日/块工作表核销进度。', parameters: obj({}) },
  ]
}

/** 工具执行器（只读视图分发）：白名单外调用 fail loud（缝以 isError 回灌，模型可见
 * 拒收原因）；参数 JSON 容忍空串（无参调用的常见形态）。零写侧、零队列触点。 */
export function coachToolExecutor(
  deps: CoachToolDeps, c: CourseEntry, providers: CoachToolProviders,
): (call: LlmToolCall) => Promise<string> {
  const argsOf = (call: LlmToolCall): Record<string, unknown> => {
    const raw = call.arguments.trim()
    if (!raw) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      throw new Error(`工具「${call.name}」参数不是合法 JSON：${raw.slice(0, 80)}`)
    }
  }
  return async call => {
    // 终点恒标的读锚出处（#200 / ADR-0055）：图面与节点卡现算终点标记，不落盘不漂移
    const endpointOf = async (): Promise<string | null> =>
      (await readAnchor(deps.paths.anchorPath(c.root), deps.fs))?.endpoint ?? null
    switch (call.name as CoachToolName) {
      case 'graph_view': {
        const { graph, state } = await deps.loadView(c)
        return renderGrowthGraphView(graph, state, await endpointOf())
      }
      case 'node_card': {
        const node = argsOf(call).node
        if (typeof node !== 'string' || !node.trim()) throw new Error('node_card 需要 node 参数（逐字节点名）。')
        const { graph, state } = await deps.loadView(c)
        return renderNodeCard(graph, state, node.trim(), await endpointOf())
      }
      case 'concept_registry': {
        const q = argsOf(call).query
        return renderConceptRegistry(deps.concepts, c, typeof q === 'string' ? q : undefined)
      }
      case 'behavior_digest':
        return providers.behaviorDigestText()
      case 'bank_overview':
        return renderBankOverview(deps.scanCourseBanks, c)
      case 'compass_read':
        return renderCompassView(deps, c)
      case 'endpoint_anchor':
        return renderEndpointAnchor(deps, c)
      default:
        throw new Error(`白名单外工具「${call.name}」被拒：教练工具面只有只读视图（${COACH_TOOL_NAMES.join('/')}），写路径走提案→受理门→apply。`)
    }
  }
}

/** 便捷组装：白名单规格 + 执行器（coachGrowthBatch / compassPaint 的注入面）。 */
export function coachToolset(
  deps: CoachToolDeps, c: CourseEntry, providers: CoachToolProviders,
): { tools: LlmToolSpec[]; runTool: (call: LlmToolCall) => Promise<string> } {
  return { tools: coachToolSpecs(), runTool: coachToolExecutor(deps, c, providers) }
}
