/**
 * 教练只读工具面（ADR-0041 / #163；#249 / ADR-0077 七件 → 八件；#326 八件 → 九件）：教练工具回路可调用的
 * **只读引擎视图白名单**——图视图、节点卡、概念足迹、行为摘要、题库概况、罗盘、终点锚、
 * 上游图摘要、下游子图九件。裁决前按需自查取代盲盒上下文包的证据缺口：节点名、pre 引用、
 * 概念名在产出裁决前可直接对表。
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
import { effectiveStage } from '../graph/audit.ts'
import type { CompassDoc } from './compass.ts'
import { ETA_PENDING, SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, etaMarkerOf, hasLearnerAnnotations, parseCompass, sectionBody } from './compass.ts'
import type { ConceptEntry, ConceptRegistry } from '../concepts/concepts.ts'
import { isDeprecated, resolveConcept } from '../concepts/concepts.ts'
import type { Graph } from '../graph/graph.ts'
import { groupView } from '../graph/graph.ts'
import { round2 } from '../infra/grading.ts'
import type { VaultFs } from '../infra/io.ts'
import { hasReadyContent } from '../vault/notes.ts'
import type { Paths } from '../infra/paths.ts'
import type { BankDoc } from '../content/question-bank.ts'
import { endpointNames, readAnchors } from './seed.ts'
import { readySet } from '../sched/sessions.ts'
import { masteryOfFm } from '../sched/srs.ts'
import type { CourseEntry, Fm } from '../types.ts'
import type { LlmToolCall, LlmToolSpec } from '../infra/llm.ts'
import { render } from '../infra/prompt-render.ts'
import {
  BO_EMPTY, BO_HEADING, BO_LINE, BO_OVERFLOW,
  CF_ALIASES_PART, CF_ASSUMERS_NONE, CF_ATTACH_HIT, CF_ATTACH_MISS, CF_ATTACH_VERDICT, CF_CONFUSABLE,
  CF_DANGLING_CONFUSABLE, CF_DEPRECATED_SUFFIX, CF_ENTRY_DEF, CF_ENTRY_HEADING, CF_ENTRY_NO_DEF,
  CF_HEADING, CF_INVOKES_DIST, CF_INVOKES_EMPTY, CF_NO_HIT_MISSING, CF_NO_HIT_WITH_QUERY, CF_OVERFLOW,
  CF_QUERY_FULL, CF_QUERY_HINT, CF_QUERY_PART, CF_TEACHERS_NONE, CF_TEACHING,
  CV_ANCHOR_LINE, CV_ANCHOR_NOTE, CV_ANNOTATIONS_HEADING, CV_ETA_HEADING, CV_ETA_WEEK_SUFFIX,
  CV_GOAL_CAPABILITY, CV_GOAL_COVERAGE, CV_HEADING, CV_ROUTE_PAINTED, CV_ROUTE_STATUS, CV_ROUTE_UNPAINTED,
  CV_ZERO_ENDPOINTS,
  EA_DECLARED, EA_GOAL_CAPABILITY, EA_GOAL_COVERAGE, EA_GOAL_TYPE, EA_HEADING, EA_HEADING_BARE, EA_NODE,
  EA_NOTE, EA_SEAL, EA_SEAL_DONE, EA_SEAL_TODO, EA_WORKSHEET, EA_ZERO_ENDPOINTS,
  GRAPH_VIEW_ACTIVE_EMPTY, GRAPH_VIEW_ACTIVE_HEADING, GRAPH_VIEW_CONCEPT_HEADING, GRAPH_VIEW_CONCEPT_LINE,
  GRAPH_VIEW_CONCEPT_SKIPPED_SUFFIX, GRAPH_VIEW_DEGRADED_SUFFIX, GRAPH_VIEW_DEPTH_BUCKET,
  GRAPH_VIEW_DEPTH_HEADING, GRAPH_VIEW_ENDPOINT_HEADING, GRAPH_VIEW_ENDPOINT_LINE, GRAPH_VIEW_FOOTER,
  GRAPH_VIEW_FULL_HEADING, GRAPH_VIEW_HEADING, GRAPH_VIEW_LINE_PRES, GRAPH_VIEW_LINE_ROW, GRAPH_VIEW_LINES_HEADING,
  GRAPH_VIEW_STATS, GRAPH_VIEW_UNTAGGED_LINE,
  GRAPH_VIEW_WEAK_EMPTY, GRAPH_VIEW_WEAK_HEADING, GRAPH_VIEW_ZERO_CONCEPT, GRAPH_VIEW_ZERO_ENDPOINTS,
  GRAPH_VIEW_ZERO_LINES,
  NODE_CARD_ASSUMES, NODE_CARD_CONSUMERS, NODE_CARD_CONSUMERS_ENDPOINT, NODE_CARD_CONSUMERS_LEAF,
  NODE_CARD_DEPTH, NODE_CARD_DIFFICULTY, NODE_CARD_DIFFICULTY_UNDECLARED, NODE_CARD_EMPTY, NODE_CARD_ENDPOINT_FLAG, NODE_CARD_HEADING, NODE_CARD_MISCONCEPTIONS,
  NODE_CARD_PRE, NODE_CARD_PRE_ITEM, NODE_CARD_PRE_ITEM_NO_DIFFICULTY, NODE_CARD_STAGE, NODE_CARD_STAGE_ENDPOINT, NODE_CARD_STAGE_EST, NODE_CARD_STAGE_PRACTICE,
  NODE_CARD_TEACHES, NODE_NOT_ON_GRAPH_ERR, NODE_ROW_BODY, NODE_ROW_COLUMNS, NODE_ROW_DUE,
  NODE_ROW_ENDPOINT_FLAG, NODE_ROW_EST, NODE_ROW_ITEM, NODE_ROW_PRE, NODE_ROW_ROOT, NODE_ROW_TEACHES,
  NODE_ROW_WEAK_FLAG,
  STAGE_LABEL_LEARNING, STAGE_LABEL_MASTERED, STAGE_LABEL_REVIEW, STAGE_LABEL_UNSEEN_READY,
  STAGE_LABEL_UNSEEN_TODO,
  TOOL_BANK_OVERVIEW_DESC, TOOL_BEHAVIOR_DIGEST_DESC, TOOL_COMPASS_READ_DESC,
  TOOL_CONCEPT_FOOTPRINT_DESC_LIVE, TOOL_ENDPOINT_ANCHOR_DESC_LIVE, TOOL_EXEC_BAD_ARGS,
  TOOL_EXEC_NODE_REQUIRED, TOOL_EXEC_READONLY_REJECT, TOOL_GRAPH_VIEW_DESC_LIVE, TOOL_NODE_CARD_DESC_LIVE,
  TOOL_PARAM_NODE_DESC, TOOL_PARAM_QUERY_DESC_LIVE, TOOL_SUBGRAPH_DESC_LIVE, TOOL_UPSTREAM_DAG_DESC_LIVE,
  UD_ADJ_HEADING, UD_ADJ_LINE, UD_CLOSURE_HEADING, UD_EMPTY_BODY, UD_EMPTY_HEADING, UD_HEADING,
  UD_OVERFLOW, UD_SIZE, UD_SIZE_FULL_SUFFIX, UD_SIZE_TRUNC_SUFFIX, UD_TARGET_ROW,
  SG_ADJ_HEADING, SG_ADJ_LINE, SG_CLOSURE_HEADING, SG_EMPTY_BODY, SG_EMPTY_HEADING, SG_HEADING,
  SG_OVERFLOW, SG_SIZE, SG_SIZE_FULL_SUFFIX, SG_SIZE_TRUNC_SUFFIX, SG_TARGET_ROW,
} from '../prompts/coach-tools.ts'

/** 工具面白名单（ADR-0041 形状；#249 / ADR-0077 八件 → #326 九件）：名字是教练工具调用的唯一取值域。
 * `concept_registry` 已由 `concept_footprint` 完整吸收（词条档职责并入足迹视图）；
 * `node_card` 维持单步 pre 不动——上游闭包的全拓扑由 `upstream_dag` 承担，下游闭包由
 * `subgraph` 承担（#326 下游/邻域子图读件）。 */
export const COACH_TOOL_NAMES = [
  'graph_view', 'node_card', 'concept_footprint', 'behavior_digest',
  'bank_overview', 'compass_read', 'endpoint_anchor', 'upstream_dag', 'subgraph',
] as const
export type CoachToolName = (typeof COACH_TOOL_NAMES)[number]

/** 全图摘要逐节点行的上限（ADR-0077 规模降级先写死）：超此值自动降为 depth 段聚合行 +
 * 前沿细节 + 显式溢出说明（⚠ 与 ⚑ 例外不截）。与 UPSTREAM_CLOSURE_CAP 同族：上限只防
 * 膨胀，不服务取值域完整性时才收紧——降级模式仍给出全部节点名可引用的替代面。 */
const FULL_GRAPH_CAP = 200

/** 登记表/题库概况等列表视图的渲染上限（同上：防膨胀不防完整性）。 */
const LIST_CAP = 200

/** 上游闭包全拓扑的预览上限（ADR-0077：#249「闭包超 cap 按深度截断 + 显式溢出行」）。
 * 截断保留**深度小的一端**（拓扑序在前的地基段）——地基是深链诊断的靶（「七步之前的
 * 地基」），近邻本就随 node_card 的单步 pre 廉价可得；溢出行点名切断深度与余数。 */
const UPSTREAM_CLOSURE_CAP = 60

/** 下游闭包全拓扑的预览上限（#326，与 UPSTREAM_CLOSURE_CAP 同族）：截断保留**深度小的
 * 一端**——对下游即离目标最近的近邻环（影响面的第一圈），远端溢出显式点名。 */
const SUBGRAPH_CLOSURE_CAP = 60

/** ⚠ 弱掌握阈值（ADR-0077：mastery 低于此值或到期积压即标，全图摘要与上游图摘要
 * 共用一处判据）。口径与 B2 难度带校准同值不同域——此处只作读侧标记，不改任何调度、
 * 不进完成判据。 */
export const WEAK_MASTERY_THRESHOLD = 0.5

/** 节点阶段的人读标签（growthGraphView 的细节行口径，图面与节点卡共用）。 */
function activeLabel(state: Record<string, Fm>, n: string): string {
  const s = effectiveStage(state, n)
  if (s === 'learning') return render(STAGE_LABEL_LEARNING, {})
  if (s === 'mastered') return render(STAGE_LABEL_MASTERED, {})
  if (s === 'review') return render(STAGE_LABEL_REVIEW, {})
  return hasReadyContent(state[n]) ? render(STAGE_LABEL_UNSEEN_READY, {}) : render(STAGE_LABEL_UNSEEN_TODO, {})
}

/** ⚠ 弱掌握判定（ADR-0077）：只对**已开始**的节点判。unseen / ready 是「还没开始学」
 * （mastery = 0 是尚未积累证据，不是学塌了；阶段标签已如实呈现，再打 ⚠ 会把标记稀释成
 * 每行都有的噪音），skipped 是「用户已有基础跳过」（调度视同已通过，同理不标）。
 * 两条命中任一即标：掌握度低于阈值（塌陷点，拓扑里直接现形）或到期积压（已排程且
 * due 已过 today）。today 缺席（无时钟的纯渲染调用）时只判掌握度。 */
const STARTED_STAGES = new Set(['learning', 'review', 'mastered'])
function isWeak(state: Record<string, Fm>, n: string, today: string): boolean {
  if (!STARTED_STAGES.has(effectiveStage(state, n))) return false
  if (masteryOfFm(state[n]) < WEAK_MASTERY_THRESHOLD) return true
  const fs = state[n]?.fsrs
  const due = fs && fs.reps ? fs.due : null
  return Boolean(due && today && String(due) <= today)
}

/** 逐节点行的公共折叠（ADR-0077：全图摘要与上游图摘要**同源同形**；#281：去「区·块」
 * 死坐标——分组是读侧派生，逐节点行不再携带）：深度｜阶段｜掌握度(+⚠)｜est｜due，
 * pre 邻接与 teaches 并入同行。两处视图的差别只在
 * `pres`（摘要给图上全部 pre；上游闭包给**闭包内**的 pre 子集——闭包外的边不属本视图
 * 的拓扑）与各自的外围块（降级聚合 / 邻接表 + cap），行本身一份实现——两处各写一遍
 * 行格式，就会出现「摘要显示 d2、工具显示 深度 2」这类只靠人眼对齐的漂移。
 * 返回不带项目符号的行体（调用方决定是 `- ` 列表项还是别的挂法，如目标节点行）。 */
function nodeRowBody(
  graph: Graph, state: Record<string, Fm>, n: string,
  opts: { today: string; endpoints: ReadonlySet<string>; pres?: string[] },
): string {
  const pres = opts.pres ?? graph.preOf[n]
  const teaches = Object.entries(graph.teachesOf[n] ?? {}).map(([c, t]) => `${c} ${t}`)
  const est = graph.estOf[n]
  const fs = state[n]?.fsrs
  const due = fs && fs.reps ? fs.due : null
  const columns = render(NODE_ROW_COLUMNS, {
    stage: activeLabel(state, n),
    mastery: masteryOfFm(state[n]),
    weak: isWeak(state, n, opts.today) ? render(NODE_ROW_WEAK_FLAG, {}) : '',
  })
    + (est ? render(NODE_ROW_EST, { est }) : '')
    + (due ? render(NODE_ROW_DUE, { due: String(due) }) : '')
  return render(NODE_ROW_BODY, {
    node: n,
    flag: opts.endpoints.has(n) ? render(NODE_ROW_ENDPOINT_FLAG, {}) : '',
    depth: graph.depth[n] ?? 0,
    columns,
  })
    + render(NODE_ROW_PRE, { pres: pres.length ? pres.join('、') : render(NODE_ROW_ROOT, {}) })
    + (teaches.length ? render(NODE_ROW_TEACHES, { teaches: teaches.join('、') }) : '')
}

/** 逐节点行（列表项形态）。 */
function nodeRow(
  graph: Graph, state: Record<string, Fm>, n: string,
  opts: { today: string; endpoints: ReadonlySet<string>; pres?: string[] },
): string {
  return render(NODE_ROW_ITEM, { body: nodeRowBody(graph, state, n, opts) })
}

/** 全图摘要（#250 / ADR-0077，自 #144 的「前沿细节 + 其余名单」升级）：教练全量包
 * 图面块的**常驻形态**——逐节点一行全图紧凑拓扑（深度序、阶段、掌握度，pre
 * 邻接并入同行），弱掌握带 ⚠、终点带 ⚑。对教练它是预先存在的上下文：任何裁决自带
 * 全局骨架、健康分布与接线靶（卡点归因、算子裁决、插入定位都不必先查工具）。同时
 * 是结构事实源——ops 的节点名与 pre 引用的取值域（逐节点一行意味着
 * **全部**节点名都在，不再有「其余名单」的截断面）。
 *
 * 规模降级（ADR-0077 先写死；#281 换轴）：图超 FULL_GRAPH_CAP 时自动降为「depth 段
 * 聚合行（节点数/掌握均值/就绪数）+ 前沿与在学细节行 + 显式溢出说明」，**⚠ 弱掌握与
 * ⚑ 终点例外不截**（诊断与接线价值最高的子集）；**概念组读数表永不全量降级**——它是
 * 教练判读的核心面，降级只压节点级载荷（可见性是结构保证，不靠模型主动查）。
 * 与 upstream_dag 的分工：摘要 = 常驻地图集（省列），工具 = 变焦（全列含 due/est/teaches）。
 *
 * endpoints：终点恒标（#200 / ADR-0055；#239 多终点化：**逐个终点**）——头部带每个
 * 终点一行，节点行带 ⚑。opts.today：⚠ 到期积压判据的 today（缺席时只判掌握度）。
 * opts.conceptEntries：概念组读数表的 canonical 归并供料（缺席 = 空表头，别名不裂组）。
 * 轻量段同吃这份图面，裁决不盲。纯组装零写副作用、读侧派生零落盘。 */
export function renderGrowthGraphView(
  graph: Graph, state: Record<string, Fm>, endpoints: ReadonlySet<string> = new Set<string>(),
  opts: { today?: string; conceptEntries?: ConceptEntry[] } = {},
): string {
  const today = opts.today ?? ''
  // 前沿 = readySet（未开始且非 opt 前置全部达成）；rValue 恒 1 = R 软闸不改变可学性、
  // 故不带门——与教练回合检查点的前沿口径同源（GrowthSubsystem.coachFrontier 同款）。
  const active = [...new Set([
    ...readySet(graph, state, () => 1),
    ...graph.names.filter(n => effectiveStage(state, n) === 'learning'),
  ])].sort()
  const activeSet = new Set(active)
  // 深度序（拓扑，地基在前）——同深按名字，保证同输入同输出
  const ordered = [...graph.names].sort((a, b) =>
    (graph.depth[a] ?? 0) - (graph.depth[b] ?? 0) || a.localeCompare(b))
  const weak = ordered.filter(n => isWeak(state, n, today))
  const degraded = ordered.length > FULL_GRAPH_CAP
  const lines: string[] = [
    render(GRAPH_VIEW_HEADING, {}), '',
    render(GRAPH_VIEW_STATS, {
      total: graph.names.length,
      active: active.length,
      weak: weak.length,
      threshold: WEAK_MASTERY_THRESHOLD,
      degraded: degraded ? render(GRAPH_VIEW_DEGRADED_SUFFIX, { cap: FULL_GRAPH_CAP }) : '',
    }),
    ...(endpoints.size
      ? [...endpoints].map(n => render(GRAPH_VIEW_ENDPOINT_LINE, { node: n }))
      : [render(GRAPH_VIEW_ZERO_ENDPOINTS, {})]),
  ]
  // 概念组读数表（#281）：canonical 归并后逐组一行（teaches/assumes/未标），永不全量降级
  // ——它是教练判读的核心面。只聚合计数，零阈值零建议：判读归教练。
  const canonicalOf = (raw: string): string => resolveConcept(opts.conceptEntries ?? [], raw)?.canonical ?? raw
  const conceptGroups = new Map<string, { supply: number; assumed: number; members: Set<string> }>()
  for (const raw of new Set([...Object.keys(graph.taughtByOf), ...Object.keys(graph.assumedByOf)])) {
    const label = canonicalOf(raw)
    const slot = conceptGroups.get(label) ?? conceptGroups.set(label, { supply: 0, assumed: 0, members: new Set() }).get(label)!
    slot.supply += graph.taughtByOf[raw]?.length ?? 0
    slot.assumed += graph.assumedByOf[raw]?.length ?? 0
    for (const n of graph.taughtByOf[raw] ?? []) slot.members.add(n)
    for (const n of graph.assumedByOf[raw] ?? []) slot.members.add(n)
  }
  const coveredByConcept = new Set([...conceptGroups.values()].flatMap(g => [...g.members]))
  let untagged = graph.names.filter(n => !coveredByConcept.has(n))
  // 真有概念叫「未标概念」：合并不顶替（同 groupView 纪律），兑底名单并入真实组
  const untitledGroup = conceptGroups.get('未标概念')
  if (untagged.length && untitledGroup) {
    for (const n of untagged) untitledGroup.members.add(n)
    untagged = []
  }
  lines.push('', render(GRAPH_VIEW_CONCEPT_HEADING, {}), '')
  if (conceptGroups.size || untagged.length) {
    for (const [label, g] of [...conceptGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const skipped = [...g.members].filter(n => effectiveStage(state, n) === 'skipped').length
      lines.push(render(GRAPH_VIEW_CONCEPT_LINE, {
        label, supply: g.supply, assumed: g.assumed, members: g.members.size,
        skipped: skipped ? render(GRAPH_VIEW_CONCEPT_SKIPPED_SUFFIX, { count: skipped }) : '',
      }))
    }
    if (untagged.length) lines.push(render(GRAPH_VIEW_UNTAGGED_LINE, { count: untagged.length }))
  } else {
    lines.push(render(GRAPH_VIEW_ZERO_CONCEPT, {}))
  }
  // 活跃线视图（终点.pre 派生，读侧零落盘）：线头 = 终点直接接线；被其他线头上游闭包
  // 包含的是已被更深线消费的旧头，滤出后的真线头才是「各在长线的当前最深节点」。
  // 线头深度差距与同族堆积是并拢（consolidate）与补弱（补前置台阶）的读数，判读归教练。
  if (endpoints.size) {
    lines.push('', render(GRAPH_VIEW_LINES_HEADING, {}), '')
    let anyLine = false
    for (const ep of endpoints) {
      const heads = graph.preOf[ep] ?? []
      const trueHeads = heads.filter(h => !heads.some(o => o !== h && graph.upstreamClosure(o).has(h)))
      for (const h of trueHeads) {
        const pres = graph.preOf[h] ?? []
        anyLine = true
        lines.push(render(GRAPH_VIEW_LINE_ROW, {
          head: h,
          depth: graph.depth[h] ?? 0,
          pres: pres.length
            ? ' ' + render(GRAPH_VIEW_LINE_PRES, { names: pres.slice(0, 3).join(' / ') + (pres.length > 3 ? ' / …' : '') })
            : '',
        }))
      }
    }
    if (!anyLine) lines.push(render(GRAPH_VIEW_ZERO_LINES, {}))
  }
  const nodeLine = (n: string): string => nodeRow(graph, state, n, { today, endpoints })
  if (!degraded) {
    lines.push('', render(GRAPH_VIEW_FULL_HEADING, {}), '')
    for (const n of ordered) lines.push(nodeLine(n))
  } else {
    // 降级：depth 段聚合（节点数/掌握均值/就绪数）→ 前沿与在学细节 → ⚠/⚑ 例外全列 → 溢出说明
    // 桶来源 = groupView(depth) 单一出处（环上显式「无法分层」，不静默空桶）
    const buckets = groupView(graph, 'depth')
    lines.push('', render(GRAPH_VIEW_DEPTH_HEADING, { cap: FULL_GRAPH_CAP }), '')
    for (const bucket of buckets) {
      const ns = bucket.nodes
      const mean = ns.reduce((s, n) => s + masteryOfFm(state[n]), 0) / ns.length
      const ready = ns.filter(n => activeSet.has(n)).length
      lines.push(render(GRAPH_VIEW_DEPTH_BUCKET, { label: bucket.label, count: ns.length, mean: round2(mean), ready }))
    }
    lines.push('', render(GRAPH_VIEW_ACTIVE_HEADING, { count: active.length }), '')
    if (active.length) for (const n of active) lines.push(nodeLine(n))
    else lines.push(render(GRAPH_VIEW_ACTIVE_EMPTY, {}))
    lines.push('', render(GRAPH_VIEW_WEAK_HEADING, { count: weak.length }), '')
    lines.push(weak.length ? weak.map(nodeLine).join('\n') : render(GRAPH_VIEW_WEAK_EMPTY, {}))
    const reachable = ordered.filter(n => endpoints.has(n))
    if (reachable.length) {
      lines.push('', render(GRAPH_VIEW_ENDPOINT_HEADING, { count: reachable.length }), '')
      for (const n of reachable) lines.push(nodeLine(n))
    }
    lines.push('', render(GRAPH_VIEW_FOOTER, { total: ordered.length, cap: FULL_GRAPH_CAP }))
  }
  return lines.join('\n') + '\n'
}

/** 节点卡（node_card）：单节点的结构档与内容态——深度、阶段、pre/teaches/assumes、
 * est、下游消费、误解先验。未知节点 fail loud（graph_view 取逐字名单），不静默编空卡。
 * endpoints：终点卡恒标（#200）——下游消费与调度措辞按方向标记口径。
 * conceptEntries：#336 读侧归一——传入时 teaches/assumes 展示 canonical + 别名，
 * 判据与展示同源（写侧门也走同一 resolveConcept）。 */
export function renderNodeCard(
  graph: Graph, state: Record<string, Fm>, node: string, endpoints: ReadonlySet<string> = new Set<string>(),
  conceptEntries?: ReadonlyArray<ConceptEntry>,
): string {
  if (!graph.nset.has(node)) {
    throw new Error(render(NODE_NOT_ON_GRAPH_ERR, { node }))
  }
  const pres = graph.preOf[node] ?? []
  const teaches = Object.entries(graph.teachesOf[node] ?? {})
  const assumes = Object.entries(graph.assumesOf[node] ?? {})
  const mis = graph.misconceptionsOf[node] ?? []
  const consumers = graph.succ[node] ?? []
  const isEndpoint = endpoints.has(node)
  const est = graph.estOf[node]
  // #336 读侧归一：teaches/assumes 展示 canonical + 别名（entries 传入时）
  const fmtConcept = (raw: string, tier: string): string => {
    if (!conceptEntries?.length) return `${raw} ${tier}`
    const hit = resolveConcept([...conceptEntries], raw)
    if (!hit || hit.canonical === raw) return `${raw} ${tier}`
    const aliases = hit.aliases?.filter(a => a !== raw) ?? []
    return aliases.length ? `${hit.canonical}（${aliases.join('、')}） ${tier}` : `${hit.canonical} ${tier}`
  }
  // 难度行缺席照出（未标注占位，不省略整行）；pre 条目内联前置难度——#335 难度步进门
  // 判的是「本节点 vs 直接前置最大难度」，只给自身难度模型算不出步进（活图与草稿口径
  // 共用本函数，改一处两口径同时生效）。
  const diffText = (n: string): string =>
    graph.difficultyOf[n] !== undefined ? String(graph.difficultyOf[n]) : render(NODE_CARD_DIFFICULTY_UNDECLARED, {})
  const presText = pres.length
    ? pres.map(p => graph.difficultyOf[p] !== undefined
      ? render(NODE_CARD_PRE_ITEM, { node: p, difficulty: diffText(p) })
      : render(NODE_CARD_PRE_ITEM_NO_DIFFICULTY, { node: p })).join('、')
    : render(NODE_ROW_ROOT, {})
  return [
    render(NODE_CARD_HEADING, { node, flag: isEndpoint ? render(NODE_CARD_ENDPOINT_FLAG, {}) : '' }), '',
    render(NODE_CARD_DEPTH, { depth: graph.depth[node] ?? 0 }),
    render(NODE_CARD_STAGE, {
      stage: activeLabel(state, node),
      suffix: isEndpoint ? render(NODE_CARD_STAGE_ENDPOINT, {})
        : graph.typeOf[node] === 'practice' ? render(NODE_CARD_STAGE_PRACTICE, {}) : '',
    }) + (est ? render(NODE_CARD_STAGE_EST, { est }) : ''),
    render(NODE_CARD_DIFFICULTY, { difficulty: diffText(node) }),
    render(NODE_CARD_PRE, { pres: presText }),
    render(NODE_CARD_TEACHES, { teaches: teaches.length ? teaches.map(([c, t]) => fmtConcept(c, t)).join('、') : render(NODE_CARD_EMPTY, {}) }),
    render(NODE_CARD_ASSUMES, { assumes: assumes.length ? assumes.map(([c, t]) => fmtConcept(c, t)).join('、') : render(NODE_CARD_EMPTY, {}) }),
    render(NODE_CARD_CONSUMERS, { consumers: consumers.length ? consumers.join('、') : isEndpoint ? render(NODE_CARD_CONSUMERS_ENDPOINT, {}) : render(NODE_CARD_CONSUMERS_LEAF, {}) }),
    render(NODE_CARD_MISCONCEPTIONS, { mis: mis.length ? mis.map(m => `${m.concept}：${m.model}`).join('；') : render(NODE_CARD_EMPTY, {}) }),
  ].join('\n') + '\n'
}

/** 概念足迹（concept_footprint，ADR-0077）：双职责——① **词条档**（canonical/别名/
 * 定义/confusable；完整吸收原 concept_registry 的铸名对表职责）；② **足迹**（哪些节点
 * teaches/assumes 它、题目 invokes 分布、confusable 指向谁）。
 *
 * query 语义 = 子串发现（命中 canonical 或别名），**不是**存在性判定：无 query 给全表
 * （cap 内定义逐条对照），空结果 = 「换宽词或读全表，不是不存在」——子串当发现机制会
 * 因粒度/角度/别称差异静默失败（ADR-0077 归因映射分层）。写侧恒精确：提案概念引用仍
 * 逐字命中在册名字，本视图只供读侧找候选。读侧派生零落盘。
 *
 * 足迹取材全经 providers 注入（题目的 invokes 折叠口径住 growth-subsystem——S60 契约：
 * 子系统私有折叠经 providers 复用，本文件不自己扫库；图侧反查读 `deps.loadView`）。 */
export async function renderConceptFootprint(
  deps: CoachToolDeps, c: CourseEntry, providers: CoachToolProviders, query?: string | string[],
): Promise<string> {
  const entries = await deps.concepts.load()
  // 多名字查询（#340）：string | string[] 统一归一为去空词数组
  const queries = Array.isArray(query)
    ? query.map(q => q.trim()).filter(Boolean)
    : (query?.trim() ? [query.trim()] : [])
  const hasQuery = queries.length > 0
  const hit = hasQuery
    ? entries.filter(e => queries.some(q => e.canonical.includes(q) || (e.aliases ?? []).some(a => a.includes(q))))
    : entries
  const { graph } = await deps.loadView(c)
  // 概念反向映射单一出处 Graph.taughtByOf/assumedByOf（#270）：names 全扫折叠退役——
  // 构造期同一趟折出，键序与节点序和手工折叠逐字一致。
  const teachers = graph.taughtByOf
  const assumers = graph.assumedByOf
  const invokes = await providers.conceptInvokes()
  // 显示用：多词用逗号拼接，单词直接显示（与旧行为一致）
  const queryDisplay = queries.join('、')
  const lines = [render(CF_HEADING, {
    course: c.name, hit: hit.length, total: entries.length,
    queryPart: hasQuery ? render(CF_QUERY_PART, { query: queryDisplay }) : render(CF_QUERY_FULL, {}),
  }), '']
  if (!hit.length) {
    lines.push(entries.length
      ? render(CF_NO_HIT_WITH_QUERY, { query: queryDisplay })
      : render(CF_NO_HIT_MISSING, {}))
    return lines.join('\n') + '\n'
  }
  if (hasQuery) lines.push(render(CF_QUERY_HINT, {}), '')
  for (const e of hit.slice(0, LIST_CAP)) {
    lines.push(render(CF_ENTRY_HEADING, { canonical: e.canonical, deprecated: isDeprecated(e) ? render(CF_DEPRECATED_SUFFIX, {}) : '' }))
    lines.push(render(CF_ENTRY_DEF, {
      aliasesPart: e.aliases?.length ? render(CF_ALIASES_PART, { aliases: e.aliases.join('、') }) : '',
      definition: e.definition ?? render(CF_ENTRY_NO_DEF, {}),
    }))
    const taught = teachers[e.canonical] ?? []
    const assumed = assumers[e.canonical] ?? []
    lines.push(render(CF_TEACHING, {
      taught: taught.length ? taught.join('、') : render(CF_TEACHERS_NONE, {}),
      assumed: assumed.length ? assumed.join('、') : render(CF_ASSUMERS_NONE, {}),
    }))
    const byNode = invokes.get(e.canonical)
    if (byNode?.size) {
      const dist = [...byNode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      lines.push(render(CF_INVOKES_DIST, { dist: dist.map(([n, k]) => `${n} ×${k}`).join('、') }))
    } else {
      lines.push(render(CF_INVOKES_EMPTY, {}))
    }
    if (e.confusable?.length) lines.push(render(CF_CONFUSABLE, { list: e.confusable.join('、') }))
    const missing = (e.confusable ?? []).filter(x => resolveConcept(entries, x) === null)
    if (missing.length) lines.push(render(CF_DANGLING_CONFUSABLE, { list: missing.join('、') }))
    lines.push(render(CF_ATTACH_VERDICT, {
      verdict: taught.length || assumed.length || byNode?.size ? render(CF_ATTACH_HIT, {}) : render(CF_ATTACH_MISS, {}),
    }), '')
  }
  if (hit.length > LIST_CAP) lines.push(render(CF_OVERFLOW, { cap: LIST_CAP, rest: hit.length - LIST_CAP }))
  return lines.join('\n') + '\n'
}

/** 上游图摘要（upstream_dag，ADR-0077）：给定节点渲染其**前置传递闭包全拓扑**——
 * 闭包节点逐条带深度/阶段/掌握度/到期/est（弱掌握带 ⚠，塌陷点在拓扑里直接
 * 现形），闭包内 pre 边以邻接表呈现（紧凑无歧义，与图上「pre 名字列表零边字段」的
 * 边轻纪律同构）。与全图摘要的分工：摘要 = 常驻地图集（省列），本工具 = 变焦（全列
 * 含 due/est）——诊断「七步之前的地基」不再靠逐跳 node_card。超 cap 按深度截断 +
 * 显式溢出行（保留地基段，见 UPSTREAM_CLOSURE_CAP）。未知节点 fail loud（graph_view
 * 取逐字名单）。读侧派生零落盘。 */
export function renderUpstreamDag(
  graph: Graph, state: Record<string, Fm>, node: string,
  opts: { today?: string; endpoints?: ReadonlySet<string> } = {},
): string {
  if (!graph.nset.has(node)) {
    throw new Error(render(NODE_NOT_ON_GRAPH_ERR, { node }))
  }
  const today = opts.today ?? ''
  const endpoints = opts.endpoints ?? new Set<string>()
  // 前置传递闭包（沿 preOf BFS；不含自身）——出处是 Graph.upstreamClosure（与 graph_node
  // 的 prereq_closure 同一实现，不是同一段代码各写一遍）
  const all = [...graph.upstreamClosure(node)].filter(n => n !== node)
    .sort((a, b) => (graph.depth[a] ?? 0) - (graph.depth[b] ?? 0) || a.localeCompare(b))
  const shown = all.slice(0, UPSTREAM_CLOSURE_CAP)
  const shownSet = new Set(shown)
  // 闭包内 pre 邻接的取值域（含目标节点——它是本视图的入口，边指向闭包内）
  const inScope = (n: string): boolean => n === node || shownSet.has(n)
  const row = (n: string): string =>
    nodeRow(graph, state, n, { today, endpoints, pres: graph.preOf[n].filter(inScope) })
  const lines: string[] = [
    render(UD_HEADING, { node, flag: endpoints.has(node) ? render(NODE_ROW_ENDPOINT_FLAG, {}) : '', total: all.length }), '',
    render(UD_TARGET_ROW, { row: nodeRowBody(graph, state, node, { today, endpoints }) }),
    render(UD_SIZE, {
      total: all.length,
      rest: all.length > shown.length
        ? render(UD_SIZE_TRUNC_SUFFIX, { shown: shown.length, rest: all.length - shown.length })
        : render(UD_SIZE_FULL_SUFFIX, {}),
    }),
    '',
  ]
  if (!all.length) {
    lines.push(render(UD_EMPTY_HEADING, {}), '', render(UD_EMPTY_BODY, {}), '')
  } else {
    lines.push(render(UD_CLOSURE_HEADING, {}), '')
    for (const n of shown) lines.push(row(n))
    if (all.length > shown.length) {
      const cut = graph.depth[all[shown.length]!] ?? 0
      lines.push('', render(UD_OVERFLOW, {
        cap: UPSTREAM_CLOSURE_CAP, rest: all.length - shown.length, cut, depth: graph.depth[node] ?? 0,
      }))
    }
    // 闭包内 pre 邻接表（紧凑无歧义；图上 pre 只有名字列表，零边字段——边轻纪律同构）
    lines.push('', render(UD_ADJ_HEADING, {}), '')
    for (const n of [...shown, node]) {
      const pres = graph.preOf[n].filter(inScope)
      lines.push(render(UD_ADJ_LINE, { node: n, pres: pres.length ? pres.join('、') : render(NODE_ROW_ROOT, {}) }))
    }
  }
  return lines.join('\n') + '\n'
}

/** 下游子图（subgraph，#326 下游/邻域子图读件）：给定节点渲染其**下游传递闭包**全拓扑
 * ——谁消费它、影响面到哪（插入/旁支/删改前的下游自查；与 upstream_dag 互为对边）。
 * 闭包节点逐条带深度/阶段/掌握度/到期/est（弱掌握带 ⚠），子图内 pre 边以邻接表呈现
 * （与 upstream_dag 同款边轻纪律）。超 cap 按深度截断 + 显式溢出行——保留深度小的一端
 * （离目标最近的近邻环，见 SUBGRAPH_CLOSURE_CAP）。未知节点 fail loud（graph_view 取
 * 逐字名单）。读侧派生零落盘。 */
export function renderSubgraph(
  graph: Graph, state: Record<string, Fm>, node: string,
  opts: { today?: string; endpoints?: ReadonlySet<string> } = {},
): string {
  if (!graph.nset.has(node)) {
    throw new Error(render(NODE_NOT_ON_GRAPH_ERR, { node }))
  }
  const today = opts.today ?? ''
  const endpoints = opts.endpoints ?? new Set<string>()
  // 后代传递闭包（沿 succ BFS；不含自身）——出处是 Graph.downstreamClosure（与
  // upstreamClosure 同一纪律的下游半边，不是手写 BFS 副本）
  const all = [...graph.downstreamClosure(node)].filter(n => n !== node)
    .sort((a, b) => (graph.depth[a] ?? 0) - (graph.depth[b] ?? 0) || a.localeCompare(b))
  const shown = all.slice(0, SUBGRAPH_CLOSURE_CAP)
  const shownSet = new Set(shown)
  // 子图内 pre 邻接的取值域（含目标节点——它是本视图的入口，边从闭包汇入它）
  const inScope = (n: string): boolean => n === node || shownSet.has(n)
  const row = (n: string): string =>
    nodeRow(graph, state, n, { today, endpoints, pres: graph.preOf[n].filter(inScope) })
  const lines: string[] = [
    render(SG_HEADING, { node, flag: endpoints.has(node) ? render(NODE_ROW_ENDPOINT_FLAG, {}) : '', total: all.length }), '',
    render(SG_TARGET_ROW, { row: nodeRowBody(graph, state, node, { today, endpoints }) }),
    render(SG_SIZE, {
      total: all.length,
      rest: all.length > shown.length
        ? render(SG_SIZE_TRUNC_SUFFIX, { shown: shown.length, rest: all.length - shown.length })
        : render(SG_SIZE_FULL_SUFFIX, {}),
    }),
    '',
  ]
  if (!all.length) {
    lines.push(render(SG_EMPTY_HEADING, {}), '', render(SG_EMPTY_BODY, {}), '')
  } else {
    lines.push(render(SG_CLOSURE_HEADING, {}), '')
    for (const n of shown) lines.push(row(n))
    if (all.length > shown.length) {
      const cut = graph.depth[all[shown.length]!] ?? 0
      lines.push('', render(SG_OVERFLOW, {
        cap: SUBGRAPH_CLOSURE_CAP, rest: all.length - shown.length, cut,
      }))
    }
    // 子图内 pre 邻接表（紧凑无歧义；图上 pre 只有名字列表，零边字段——边轻纪律同构）
    lines.push('', render(SG_ADJ_HEADING, {}), '')
    for (const n of [node, ...shown]) {
      const pres = graph.preOf[n].filter(inScope)
      lines.push(render(SG_ADJ_LINE, { node: n, pres: pres.length ? pres.join('、') : render(NODE_ROW_ROOT, {}) }))
    }
  }
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
  const lines = [render(BO_HEADING, { course: c.name, total, nodes: perNode.length }), '']
  if (!perNode.length) {
    lines.push(render(BO_EMPTY, {}))
    return lines.join('\n') + '\n'
  }
  for (const p of perNode.slice(0, LIST_CAP)) {
    lines.push(render(BO_LINE, { node: p.node, total: p.total, archived: p.archived, invokes: p.invokes }))
  }
  if (perNode.length > LIST_CAP) lines.push(render(BO_OVERFLOW, { cap: LIST_CAP, rest: perNode.length - LIST_CAP }))
  return lines.join('\n') + '\n'
}

/** 罗盘视图（compass_read）：终点集合 + 剩余路线 + 学习者批注（软输入——提议非指令）+
 * 沙盘 ETA 的现势折叠。零终点给合法空态（锚集合同源判定）。 */
export async function renderCompassView(deps: CoachToolDeps, c: CourseEntry): Promise<string> {
  const anchors = await readAnchors(deps.paths.anchorPath(c.root), deps.fs)
  if (!anchors.length) return `${render(CV_HEADING, { course: c.name })}\n\n${render(CV_ZERO_ENDPOINTS, {})}\n`
  const path = deps.paths.compassPath(c.root)
  const doc: CompassDoc | null = deps.fs.exists(path) ? parseCompass(await deps.fs.readFile(path)) : null
  const route = (doc ? sectionBody(doc, SECTION_ROUTE)?.trim() : '') ?? ''
  const eta = (doc ? sectionBody(doc, SECTION_ETA)?.trim() : '') ?? ''
  const annotations = doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null
  const lines: string[] = [
    render(CV_HEADING, { course: c.name }), '',
    ...anchors.map(a => render(CV_ANCHOR_LINE, {
      endpoint: a.endpoint,
      goalType: a.goal_type === 'coverage' ? render(CV_GOAL_COVERAGE, {}) : render(CV_GOAL_CAPABILITY, {}),
      note: a.goal_note ? render(CV_ANCHOR_NOTE, { note: a.goal_note }) : '',
    })),
    render(CV_ROUTE_STATUS, { status: route && route !== ETA_PENDING ? render(CV_ROUTE_PAINTED, {}) : render(CV_ROUTE_UNPAINTED, {}) }),
  ]
  if (route && route !== ETA_PENDING) lines.push('', route)
  if (eta && eta !== ETA_PENDING) {
    const marker = etaMarkerOf(eta)
    lines.push('', render(CV_ETA_HEADING, { week: marker ? render(CV_ETA_WEEK_SUFFIX, { weeks: marker }) : '' }), '', eta)
  }
  if (hasLearnerAnnotations(annotations)) lines.push('', render(CV_ANNOTATIONS_HEADING, {}), '', annotations!.trim())
  return lines.join('\n') + '\n'
}

/** 终点锚视图（endpoint_anchor）：课程的方向锚集合——逐终点给目标类型/声明日/
 * 目标描述/块工作表核销进度/收尾宣告（ADR-0056；#239 多终点化）。锚 Broken fail loud
 * （锚损坏必须显式浮出，不静默折成零终点）。 */
export async function renderEndpointAnchor(deps: CoachToolDeps, c: CourseEntry): Promise<string> {
  const anchors = await readAnchors(deps.paths.anchorPath(c.root), deps.fs)
  if (!anchors.length) return `${render(EA_HEADING_BARE, { course: c.name })}\n\n${render(EA_ZERO_ENDPOINTS, {})}\n`
  const lines = [render(EA_HEADING, { course: c.name, count: anchors.length }), '']
  for (const anchor of anchors) {
    lines.push(
      render(EA_NODE, { node: anchor.endpoint }),
      render(EA_GOAL_TYPE, { type: anchor.goal_type === 'coverage' ? render(EA_GOAL_COVERAGE, {}) : render(EA_GOAL_CAPABILITY, {}) }),
      render(EA_DECLARED, { declared: anchor.declared }),
      render(EA_SEAL, { seal: anchor.sealed ? render(EA_SEAL_DONE, { date: anchor.sealed }) : render(EA_SEAL_TODO, {}) }),
    )
    if (anchor.goal_note) lines.push(render(EA_NOTE, { note: anchor.goal_note }))
    if (anchor.worksheet.length) {
      lines.push(render(EA_WORKSHEET, {
        done: anchor.worksheet.filter(w => w.done).length,
        total: anchor.worksheet.length,
        list: anchor.worksheet.map(w => `${w.block}${w.done ? '✓' : ''}`).join('、'),
      }))
    }
  }
  return lines.join('\n') + '\n'
}

/** 工具面的引擎访问面（结构化注入；GrowthDeps 天然满足，零回引避免 R7 环）。 */
export interface CoachToolDeps {
  fs: VaultFs
  paths: Paths
  concepts: ConceptRegistry
  /** 逐节点题库扫描（bank_overview / concept_footprint 的 invokes 取材）。 */
  scanCourseBanks: (c: CourseEntry, fn: (node: string, bank: BankDoc) => Promise<void>) => Promise<void>
  /** 图视图（graph_view / node_card / concept_footprint / upstream_dag 取材）。 */
  loadView: (c: { name: string; root: string }) => Promise<{ graph: Graph; state: Record<string, Fm> }>
  /** 学习日（⚠ 到期积压判据的 today 出处；与全仓唯一时钟口径同源）。 */
  learningDay: () => Promise<{ today: string; cutoff: number }>
}

/** 依赖子系统私有取材口径的视图经 providers 注入（单一出处）：行为摘要五件套的
 * 取材（invokes 解析/掌握度折叠）住在 growth-subsystem，工具面直接复用其渲染产物。 */
export interface CoachToolProviders {
  behaviorDigestText: () => Promise<string>
  /** 概念 → 节点 → 在库题数（concept_footprint 的足迹取材）。口径住 growth-subsystem
   * 的题库扫描——本文件不自己扫库，避免与行为摘要的 invokes 折叠各写一份（两份口径
   * 必然漂移：一处排除归档题、一处不排除，消费者读到两个不一样的「invokes 分布」）。 */
  conceptInvokes: () => Promise<Map<string, Map<string, number>>>
}

/** 白名单九件的工具规格（JSON Schema 直通 provider function calling）。 */
export function coachToolSpecs(): LlmToolSpec[] {
  const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object', properties, required, additionalProperties: false,
  })
  return [
    { name: 'graph_view', description: render(TOOL_GRAPH_VIEW_DESC_LIVE, {}), parameters: obj({}) },
    { name: 'node_card', description: render(TOOL_NODE_CARD_DESC_LIVE, {}), parameters: obj({ node: { type: 'string', description: render(TOOL_PARAM_NODE_DESC, {}) } }, ['node']) },
    { name: 'concept_footprint', description: render(TOOL_CONCEPT_FOOTPRINT_DESC_LIVE, {}), parameters: obj({ query: { description: render(TOOL_PARAM_QUERY_DESC_LIVE, {}), oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }) },
    { name: 'behavior_digest', description: render(TOOL_BEHAVIOR_DIGEST_DESC, {}), parameters: obj({}) },
    { name: 'bank_overview', description: render(TOOL_BANK_OVERVIEW_DESC, {}), parameters: obj({}) },
    { name: 'compass_read', description: render(TOOL_COMPASS_READ_DESC, {}), parameters: obj({}) },
    { name: 'endpoint_anchor', description: render(TOOL_ENDPOINT_ANCHOR_DESC_LIVE, {}), parameters: obj({}) },
    { name: 'upstream_dag', description: render(TOOL_UPSTREAM_DAG_DESC_LIVE, {}), parameters: obj({ node: { type: 'string', description: render(TOOL_PARAM_NODE_DESC, {}) } }, ['node']) },
    { name: 'subgraph', description: render(TOOL_SUBGRAPH_DESC_LIVE, {}), parameters: obj({ node: { type: 'string', description: render(TOOL_PARAM_NODE_DESC, {}) } }, ['node']) },
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
      throw new Error(render(TOOL_EXEC_BAD_ARGS, { name: call.name, raw: raw.slice(0, 80) }))
    }
  }
  return async call => {
    // 终点恒标的读锚出处（#200 / ADR-0055；#239 多终点化）：图面与节点卡现算终点集合，不落盘不漂移
    const endpointsOf = async (): Promise<Set<string>> =>
      endpointNames(await readAnchors(deps.paths.anchorPath(c.root), deps.fs))
    switch (call.name as CoachToolName) {
      case 'graph_view': {
        const { graph, state } = await deps.loadView(c)
        const { today } = await deps.learningDay()
        return renderGrowthGraphView(graph, state, await endpointsOf(), { today, conceptEntries: await deps.concepts.load() })
      }
      case 'node_card': {
        const node = argsOf(call).node
        if (typeof node !== 'string' || !node.trim()) throw new Error(render(TOOL_EXEC_NODE_REQUIRED, { tool: 'node_card' }))
        const { graph, state } = await deps.loadView(c)
        return renderNodeCard(graph, state, node.trim(), await endpointsOf(), await deps.concepts.load())
      }
      case 'concept_footprint': {
        const raw = argsOf(call).query
        // 多名字查询（#340）：string | string[] 都接受
        const q = Array.isArray(raw)
          ? raw.filter((x): x is string => typeof x === 'string')
          : (typeof raw === 'string' ? raw : undefined)
        return renderConceptFootprint(deps, c, providers, q)
      }
      case 'behavior_digest':
        return providers.behaviorDigestText()
      case 'bank_overview':
        return renderBankOverview(deps.scanCourseBanks, c)
      case 'compass_read':
        return renderCompassView(deps, c)
      case 'endpoint_anchor':
        return renderEndpointAnchor(deps, c)
      case 'upstream_dag': {
        const node = argsOf(call).node
        if (typeof node !== 'string' || !node.trim()) throw new Error(render(TOOL_EXEC_NODE_REQUIRED, { tool: 'upstream_dag' }))
        const { graph, state } = await deps.loadView(c)
        const { today } = await deps.learningDay()
        return renderUpstreamDag(graph, state, node.trim(), { today, endpoints: await endpointsOf() })
      }
      case 'subgraph': {
        const node = argsOf(call).node
        if (typeof node !== 'string' || !node.trim()) throw new Error(render(TOOL_EXEC_NODE_REQUIRED, { tool: 'subgraph' }))
        const { graph, state } = await deps.loadView(c)
        const { today } = await deps.learningDay()
        return renderSubgraph(graph, state, node.trim(), { today, endpoints: await endpointsOf() })
      }
      default:
        throw new Error(render(TOOL_EXEC_READONLY_REJECT, { name: call.name, names: COACH_TOOL_NAMES.join('/') }))
    }
  }
}

/** 便捷组装：白名单规格 + 执行器（coachGrowthBatch / compassPaint 的注入面）。 */
export function coachToolset(
  deps: CoachToolDeps, c: CourseEntry, providers: CoachToolProviders,
): { tools: LlmToolSpec[]; runTool: (call: LlmToolCall) => Promise<string> } {
  return { tools: coachToolSpecs(), runTool: coachToolExecutor(deps, c, providers) }
}
