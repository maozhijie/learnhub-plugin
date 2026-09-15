/**
 * 教练只读工具面（ADR-0041 / #163；#249 / ADR-0077 七件 → 八件）：教练工具回路可调用的
 * **只读引擎视图白名单**——图视图、节点卡、概念足迹、行为摘要、题库概况、罗盘、终点锚、
 * 上游图摘要八件。裁决前按需自查取代盲盒上下文包的证据缺口：区/块与节点名、pre 引用、
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
import { effectiveStage } from './audit.ts'
import type { CompassDoc } from './compass.ts'
import { ETA_PENDING, SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, etaMarkerOf, hasLearnerAnnotations, parseCompass, sectionBody } from './compass.ts'
import type { ConceptRegistry } from './concepts.ts'
import { isDeprecated, resolveConcept } from './concepts.ts'
import type { Graph } from './graph.ts'
import { round2 } from './grading.ts'
import type { VaultFs } from './io.ts'
import { hasReadyContent } from './notes.ts'
import type { Paths } from './paths.ts'
import type { BankDoc } from './question-bank.ts'
import { endpointNames, readAnchors } from './seed.ts'
import { readySet } from './sessions.ts'
import { masteryOfFm } from './srs.ts'
import type { CourseEntry, Fm } from './types.ts'
import type { LlmToolCall, LlmToolSpec } from './llm.ts'

/** 工具面白名单（ADR-0041 形状；#249 / ADR-0077 八件）：名字是教练工具调用的唯一取值域。
 * `concept_registry` 已由 `concept_footprint` 完整吸收（词条档职责并入足迹视图）；
 * `node_card` 维持单步 pre 不动——上游闭包的全拓扑由 `upstream_dag` 承担。 */
export const COACH_TOOL_NAMES = [
  'graph_view', 'node_card', 'concept_footprint', 'behavior_digest',
  'bank_overview', 'compass_read', 'endpoint_anchor', 'upstream_dag',
] as const
export type CoachToolName = (typeof COACH_TOOL_NAMES)[number]

/** 全图摘要逐节点行的上限（ADR-0077 规模降级先写死）：超此值自动降为区/块聚合行 +
 * 前沿细节 + 显式溢出说明（⚠ 与 ⚑ 例外不截）。与 UPSTREAM_CLOSURE_CAP 同族：上限只防
 * 膨胀，不服务取值域完整性时才收紧——降级模式仍给出全部节点名可引用的替代面。 */
const FULL_GRAPH_CAP = 200

/** 登记表/题库概况等列表视图的渲染上限（同上：防膨胀不防完整性）。 */
const LIST_CAP = 200

/** 上游闭包全拓扑的预览上限（ADR-0077：#249「闭包超 cap 按深度截断 + 显式溢出行」）。
 * 截断保留**深度小的一端**（拓扑序在前的地基段）——地基是深链诊断的靶（「七步之前的
 * 地基」），近邻本就随 node_card 的单步 pre 廉价可得；溢出行点名切断深度与余数。 */
const UPSTREAM_CLOSURE_CAP = 60

/** ⚠ 弱掌握阈值（ADR-0077：mastery 低于此值或到期积压即标，全图摘要与上游图摘要
 * 共用一处判据）。口径与 B2 难度带校准同值不同域——此处只作读侧标记，不改任何调度、
 * 不进完成判据。 */
export const WEAK_MASTERY_THRESHOLD = 0.5

/** 节点阶段的人读标签（growthGraphView 的细节行口径，图面与节点卡共用）。 */
function activeLabel(state: Record<string, Fm>, n: string): string {
  const s = effectiveStage(state, n)
  if (s === 'learning') return '在学'
  if (s === 'mastered') return '已掌握'
  if (s === 'review') return '复习中'
  return hasReadyContent(state[n]) ? '未开始·正文已生成' : '未开始·待生成'
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

/** 逐节点行的公共折叠（ADR-0077：全图摘要与上游图摘要**同源同形**）：深度｜区·块｜
 * 阶段｜掌握度(+⚠)｜est｜due，pre 邻接与 teaches 并入同行。两处视图的差别只在
 * `pres`（摘要给图上全部 pre；上游闭包给**闭包内**的 pre 子集——闭包外的边不属本视图
 * 的拓扑）与各自的外围块（降级聚合 / 邻接表 + cap），行本身一份实现——两处各写一遍
 * 行格式，就会出现「摘要显示 d2、工具显示 深度 2」这类只靠人眼对齐的漂移。
 * 返回不带项目符号的行体（调用方决定是 `- ` 列表项还是别的挂法，如目标节点行）。 */
function nodeRowBody(
  graph: Graph, state: Record<string, Fm>, n: string,
  opts: { today: string; endpoints: ReadonlySet<string>; pres?: string[] },
): string {
  const [, region, block] = graph.blockOf[n]
  const pres = opts.pres ?? graph.preOf[n]
  const teaches = Object.entries(graph.teachesOf[n] ?? {}).map(([c, t]) => `${c} ${t}`)
  const est = graph.estOf[n]
  const fs = state[n]?.fsrs
  const due = fs && fs.reps ? fs.due : null
  const columns = `${activeLabel(state, n)}｜掌握 ${masteryOfFm(state[n])}${isWeak(state, n, opts.today) ? ' ⚠' : ''}`
    + (est ? `｜est ${est}′` : '')
    + (due ? `｜due ${String(due)}` : '')
  return `${n}${opts.endpoints.has(n) ? ' ⚑' : ''}（深度 ${graph.depth[n] ?? 0}｜${region}·${block}｜${columns}）`
    + `｜pre: ${pres.length ? pres.join('、') : '（根）'}`
    + (teaches.length ? `｜teaches: ${teaches.join('、')}` : '')
}

/** 逐节点行（列表项形态）。 */
function nodeRow(
  graph: Graph, state: Record<string, Fm>, n: string,
  opts: { today: string; endpoints: ReadonlySet<string>; pres?: string[] },
): string {
  return `- ${nodeRowBody(graph, state, n, opts)}`
}

/** 全图摘要（#250 / ADR-0077，自 #144 的「前沿细节 + 其余名单」升级）：教练全量包
 * 图面块的**常驻形态**——逐节点一行全图紧凑拓扑（深度序、区·块、阶段、掌握度，pre
 * 邻接并入同行），弱掌握带 ⚠、终点带 ⚑。对教练它是预先存在的上下文：任何裁决自带
 * 全局骨架、健康分布与接线靶（卡点归因、算子裁决、插入定位都不必先查工具）。同时
 * 是结构事实源——ops 的节点名、region/block 与 pre 引用的取值域（逐节点一行意味着
 * **全部**节点名都在，不再有「其余名单」的截断面）。
 *
 * 规模降级（ADR-0077 先写死）：图超 FULL_GRAPH_CAP 时自动降为「区/块聚合行（节点数/
 * 掌握均值/就绪数）+ 前沿与在学细节行 + 显式溢出说明」，**⚠ 弱掌握与 ⚑ 终点例外不截**
 * （诊断与接线价值最高的子集）。与 upstream_dag 的分工：摘要 = 常驻地图集（省列），
 * 工具 = 变焦（全列含 due/est/teaches）。
 *
 * endpoints：终点恒标（#200 / ADR-0055；#239 多终点化：**逐个终点**）——头部带每个
 * 终点一行，节点行带 ⚑。opts.today：⚠ 到期积压判据的 today（缺席时只判掌握度）。
 * 轻量段同吃这份图面，裁决不盲。纯组装零写副作用、读侧派生零落盘。 */
export function renderGrowthGraphView(
  graph: Graph, state: Record<string, Fm>, endpoints: ReadonlySet<string> = new Set<string>(),
  opts: { today?: string } = {},
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
    '## 当前图面（全图摘要——结构事实源；ops 的节点名、区/块与 pre 引用必须逐字来自这里）', '',
    `- 节点共 ${graph.names.length} 个；前沿与在学 ${active.length} 个｜弱掌握 ${weak.length} 个 ⚠`
      + `（⚠ = 已开始且掌握度低于 ${WEAK_MASTERY_THRESHOLD} 或到期积压）`
      + (degraded ? `｜**超 ${FULL_GRAPH_CAP} 已降级**（区/块聚合 + 前沿细节；⚠ 与 ⚑ 例外不截）` : ''),
    ...(endpoints.size
      ? [...endpoints].map(n => `- ⚑ 终点：${n}（方向标记——朝该方向的生长须汇入它；不可 del/rename，零正文零题库不被调度，主线批须 set_pre 接线到新前沿）`)
      : ['（零终点——空锚是合法空态，先加一个终点：教练回合无从裁决方向）']),
  ]
  const nodeLine = (n: string): string => nodeRow(graph, state, n, { today, endpoints })
  if (!degraded) {
    lines.push('', `### 全图（逐节点一行，深度序——⚠ 弱掌握、⚑ 终点）`, '')
    for (const n of ordered) lines.push(nodeLine(n))
  } else {
    // 降级：区/块聚合（节点数/掌握均值/就绪数）→ 前沿与在学细节 → ⚠/⚑ 例外全列 → 溢出说明
    const buckets = new Map<string, string[]>()
    for (const n of ordered) {
      const key = `${graph.blockOf[n][1]}·${graph.blockOf[n][2]}`
      const xs = buckets.get(key)
      if (xs) xs.push(n)
      else buckets.set(key, [n])
    }
    lines.push('', `### 区/块聚合（超 ${FULL_GRAPH_CAP} 个节点，逐节点行已降级）`, '')
    for (const [key, ns] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const mean = ns.reduce((s, n) => s + masteryOfFm(state[n]), 0) / ns.length
      const ready = ns.filter(n => activeSet.has(n)).length
      lines.push(`- ${key}：${ns.length} 个节点（掌握均值 ${round2(mean)}｜前沿与在学 ${ready}）`)
    }
    lines.push('', `### 前沿与在学细节（${active.length} 个）`, '')
    if (active.length) for (const n of active) lines.push(nodeLine(n))
    else lines.push('（前沿与在学为空——合法空态：就绪存量 0 或全图已开始）')
    lines.push('', `### ⚠ 弱掌握（例外不截，${weak.length} 个）`, '')
    lines.push(weak.length ? weak.map(nodeLine).join('\n') : '（无弱掌握节点——无已开始的低掌握/到期积压节点）')
    const reachable = ordered.filter(n => endpoints.has(n))
    if (reachable.length) {
      lines.push('', `### ⚑ 终点（例外不截，${reachable.length} 个）`, '')
      for (const n of reachable) lines.push(nodeLine(n))
    }
    lines.push('', `……（全图 ${ordered.length} 个节点超出逐节点行上限 ${FULL_GRAPH_CAP}——已降级为区/块聚合 + 前沿与在学细节；⚠ 弱掌握与 ⚑ 终点例外全列。变焦细节用 upstream_dag / node_card。）`)
  }
  return lines.join('\n') + '\n'
}

/** 节点卡（node_card）：单节点的结构档与内容态——区·块、阶段、pre/teaches/assumes、
 * est、下游消费、误解先验。未知节点 fail loud（graph_view 取逐字名单），不静默编空卡。
 * endpoints：终点卡恒标（#200）——下游消费与调度措辞按方向标记口径。 */
export function renderNodeCard(
  graph: Graph, state: Record<string, Fm>, node: string, endpoints: ReadonlySet<string> = new Set<string>(),
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
  const isEndpoint = endpoints.has(node)
  return [
    `## 节点卡：${node}${isEndpoint ? ' ⚑ 终点（方向标记）' : ''}`, '',
    `- 区·块：${region} · ${block}`,
    `- 阶段：${activeLabel(state, node)}${isEndpoint ? '（终点——零正文零题库不被学习调度，ADR-0056）' : graph.typeOf[node] === 'practice' ? '（交互实践节点）' : ''}${graph.estOf[node] ? `｜est ${graph.estOf[node]}′` : ''}`,
    `- pre：${pres.length ? pres.join('、') : '（根）'}`,
    `- teaches：${teaches.length ? teaches.map(([c, t]) => `${c} ${t}`).join('、') : '（无）'}`,
    `- assumes：${assumes.length ? assumes.map(([c, t]) => `${c} ${t}`).join('、') : '（无）'}`,
    `- 下游消费：${consumers.length ? consumers.join('、') : isEndpoint ? '（无——终点是全局收敛点，后继不该存在；出现即异常态，走对账恢复）' : '（无——叶子节点）'}`,
    `- 误解先验：${mis.length ? mis.map(m => `${m.concept}：${m.model}`).join('；') : '（无）'}`,
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
  deps: CoachToolDeps, c: CourseEntry, providers: CoachToolProviders, query?: string,
): Promise<string> {
  const entries = await deps.concepts.load(c.root)
  const q = query?.trim()
  const hit = q
    ? entries.filter(e => e.canonical.includes(q) || (e.aliases ?? []).some(a => a.includes(q)))
    : entries
  const { graph } = await deps.loadView(c)
  const teachers = new Map<string, string[]>()
  const assumers = new Map<string, string[]>()
  const fold = (map: Map<string, string[]>, concept: string, node: string): void => {
    const xs = map.get(concept)
    if (xs) xs.push(node)
    else map.set(concept, [node])
  }
  for (const n of graph.names) {
    for (const concept of Object.keys(graph.teachesOf[n] ?? {})) fold(teachers, concept, n)
    for (const concept of Object.keys(graph.assumesOf[n] ?? {})) fold(assumers, concept, n)
  }
  const invokes = await providers.conceptInvokes()
  const lines = [`## 概念足迹：${c.name}（${hit.length}/${entries.length} 条${q ? `，query=「${q}」` : '（全表——无 query）'}）`, '']
  if (!hit.length) {
    lines.push(entries.length
      ? `（query「${q ?? ''}」无命中条目——**空 ≠ 不存在**：换宽词再试，或不带 query 读全表逐条对照；写侧提案的概念引用仍必须逐字命中在册名字。）`
      : 'Missing（合法空态——铸名随生长批提案落盘；本批 concepts 铸名即可。）')
    return lines.join('\n') + '\n'
  }
  if (q) lines.push(`（子串发现只供找候选——**空 ≠ 不存在**：无命中时换宽词或不带 query 读全表。）`, '')
  for (const e of hit.slice(0, LIST_CAP)) {
    lines.push(`### ${e.canonical}${isDeprecated(e) ? '（已废弃——地址仍解析、已从生成注入与候选面退出：勿再引用、勿铸同名）' : ''}`)
    lines.push(`- 词条档：${e.aliases?.length ? `别名 ${e.aliases.join('、')}｜` : ''}${e.definition ?? '（无定义）'}`)
    const taught = teachers.get(e.canonical) ?? []
    const assumed = assumers.get(e.canonical) ?? []
    lines.push(`- 教学面：teaches ${taught.length ? taught.join('、') : '（无节点教它）'}｜assumes ${assumed.length ? assumed.join('、') : '（无节点假设它）'}`)
    const byNode = invokes.get(e.canonical)
    if (byNode?.size) {
      const dist = [...byNode.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      lines.push(`- 题目 invokes 分布：${dist.map(([n, k]) => `${n} ×${k}`).join('、')}`)
    } else {
      lines.push('- 题目 invokes 分布：（无在库题标注它——合法空态：invokes 随出题出生打标）')
    }
    if (e.confusable?.length) lines.push(`- confusable 易混指向：${e.confusable.join('、')}`)
    const missing = (e.confusable ?? []).filter(x => resolveConcept(entries, x) === null)
    if (missing.length) lines.push(`  - （悬空易混引用：${missing.join('、')} 不在册——消费侧静默降级，不硬猜归属）`)
    lines.push(`- 插入挂点判读：${taught.length || assumed.length || byNode?.size ? '足迹非空 = 有天然挂点' : '足迹空（含缺册）= 插入候选默认挂当前节点前置'}`, '')
  }
  if (hit.length > LIST_CAP) lines.push(`……（超出预览上限 ${LIST_CAP}，余 ${hit.length - LIST_CAP} 条——用 query 收窄）`)
  return lines.join('\n') + '\n'
}

/** 上游图摘要（upstream_dag，ADR-0077）：给定节点渲染其**前置传递闭包全拓扑**——
 * 闭包节点逐条带深度/区·块/阶段/掌握度/到期/est（弱掌握带 ⚠，塌陷点在拓扑里直接
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
    throw new Error(`节点「${node}」不在图上——用 graph_view 取逐字名单后重试（引用必须逐字命中）。`)
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
    `## 上游图摘要：${node}${endpoints.has(node) ? ' ⚑' : ''}（前置传递闭包 ${all.length} 个节点）`, '',
    `- 目标节点：${nodeRowBody(graph, state, node, { today, endpoints })}`,
    `- 闭包规模：${all.length} 个上游节点${all.length > shown.length ? `（本视图只列深度最小的 ${shown.length} 个，余 ${all.length - shown.length} 个见溢出行）` : '（全列）'}`,
    '',
  ]
  if (!all.length) {
    lines.push('### 闭包节点', '', '（闭包为空——该节点是根：没有上游地基可诊断）', '')
  } else {
    lines.push('### 闭包节点（深度序——地基在前；⚠ = 弱掌握或到期积压）', '')
    for (const n of shown) lines.push(row(n))
    if (all.length > shown.length) {
      const cut = graph.depth[all[shown.length]!] ?? 0
      lines.push('', `……（超出预览上限 ${UPSTREAM_CLOSURE_CAP}，余 ${all.length - shown.length} 个——按深度截断，省略的是深度 ≥ ${cut} 的节点；本次目标节点深度 ${graph.depth[node] ?? 0}，被省略的是离目标较近的一圈。近邻细节用 node_card 逐跳下钻。）`)
    }
    // 闭包内 pre 邻接表（紧凑无歧义；图上 pre 只有名字列表，零边字段——边轻纪律同构）
    lines.push('', '### 闭包内 pre 邻接（本视图的读侧派生；图上 pre 只有名字列表，零边字段）', '')
    for (const n of [...shown, node]) {
      const pres = graph.preOf[n].filter(inScope)
      lines.push(`- ${n} → ${pres.length ? pres.join('、') : '（根）'}`)
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

/** 罗盘视图（compass_read）：终点集合 + 剩余路线 + 学习者批注（软输入——提议非指令）+
 * 沙盘 ETA 的现势折叠。零终点给合法空态（锚集合同源判定）。 */
export async function renderCompassView(deps: CoachToolDeps, c: CourseEntry): Promise<string> {
  const anchors = await readAnchors(deps.paths.anchorPath(c.root), deps.fs)
  if (!anchors.length) return `## 罗盘：${c.name}\n\n（零终点——空锚是合法空态，先加一个终点：罗盘按终点组织剩余路线。）\n`
  const path = deps.paths.compassPath(c.root)
  const doc: CompassDoc | null = deps.fs.exists(path) ? parseCompass(await deps.fs.readFile(path)) : null
  const route = (doc ? sectionBody(doc, SECTION_ROUTE)?.trim() : '') ?? ''
  const eta = (doc ? sectionBody(doc, SECTION_ETA)?.trim() : '') ?? ''
  const annotations = doc ? sectionBody(doc, SECTION_ANNOTATIONS) : null
  const lines: string[] = [
    `## 罗盘：${c.name}`, '',
    ...anchors.map(a => `- 终点：${a.endpoint}（${a.goal_type === 'coverage' ? 'coverage 覆盖锚定' : 'capability 能力锚定'}）${a.goal_note ? `——${a.goal_note}` : ''}`),
    `- 剩余路线：${route && route !== ETA_PENDING ? '已画（见下）' : '未画（占位/缺席）'}`,
  ]
  if (route && route !== ETA_PENDING) lines.push('', route)
  if (eta && eta !== ETA_PENDING) {
    lines.push('', `### 沙盘 ETA（模型推演，非承诺${etaMarkerOf(eta) ? `；${etaMarkerOf(eta)}周` : ''}）`, '', eta)
  }
  if (hasLearnerAnnotations(annotations)) lines.push('', '### 学习者批注（软输入——提议非指令）', '', annotations!.trim())
  return lines.join('\n') + '\n'
}

/** 终点锚视图（endpoint_anchor）：课程的方向锚集合——逐终点给目标类型/声明日/
 * 目标描述/块工作表核销进度/收尾宣告（ADR-0056；#239 多终点化）。锚 Broken fail loud
 * （锚损坏必须显式浮出，不静默折成零终点）。 */
export async function renderEndpointAnchor(deps: CoachToolDeps, c: CourseEntry): Promise<string> {
  const anchors = await readAnchors(deps.paths.anchorPath(c.root), deps.fs)
  if (!anchors.length) return `## 终点锚：${c.name}\n\n（零终点——空锚是合法空态，先加一个终点。）\n`
  const lines = [`## 终点锚：${c.name}（${anchors.length} 个终点）`, '']
  for (const anchor of anchors) {
    lines.push(
      `- 终点节点：${anchor.endpoint}`,
      `- 目标类型：${anchor.goal_type === 'coverage' ? 'coverage 覆盖锚定（完成=块工作表+终点）' : 'capability 能力锚定（完成=终点掌握）'}`,
      `- 声明日期：${anchor.declared}`,
      `- 收尾宣告：${anchor.sealed ? `已收尾（${anchor.sealed} 宣告坡道铺通——读数折叠自该终点.pre 集；该终点重开主线接线批会自动清除）` : '未收尾（停摆前该终点.pre 须指向你认定的最终台阶——零 add_node 的纯 set_pre 接线批即收尾宣告）'}`,
    )
    if (anchor.goal_note) lines.push(`- 目标描述：${anchor.goal_note}`)
    if (anchor.worksheet.length) {
      lines.push(`- 块工作表：${anchor.worksheet.filter(w => w.done).length}/${anchor.worksheet.length} 已核销`
        + `（${anchor.worksheet.map(w => `${w.block}${w.done ? '✓' : ''}`).join('、')}）`)
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

/** 白名单八件的工具规格（JSON Schema 直通 provider function calling）。 */
export function coachToolSpecs(): LlmToolSpec[] {
  const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object', properties, required, additionalProperties: false,
  })
  return [
    { name: 'graph_view', description: '当前课程图面：全部节点名单 + 前沿/在学节点细节行（区·块/pre/teaches/est/正文态）。裁决 ops 的节点名、region/block 与 pre 引用的取值域——产出裁决前先来这里对表。', parameters: obj({}) },
    { name: 'node_card', description: '单节点结构档：区·块、阶段、pre/teaches/assumes、est、下游消费、误解先验。', parameters: obj({ node: { type: 'string', description: '节点名（逐字，来自 graph_view）' } }, ['node']) },
    { name: 'concept_footprint', description: '概念足迹（双职责）：① 词条档 canonical/别名/定义/confusable（teaches/assumes/concepts 铸名对表的唯一权威）；② 足迹——哪些节点 teaches/assumes 它、题目 invokes 分布、confusable 指向，以及插入挂点判读（足迹非空 = 天然挂点）。query 是**子串发现**不是存在性判定：无命中时**空 ≠ 不存在**——换宽词再试，或不带 query 读全表逐条对照；写侧提案的概念引用仍须逐字命中在册名字。', parameters: obj({ query: { type: 'string', description: '可选子串（命中 canonical 或别名）；省略 = 读全表' } }) },
    { name: 'behavior_digest', description: '行为摘要五件套（窗口=最近 7 学习日或 10 节取大）：掌握轨迹/卡点集中度/速度校准/误解活跃度/保留率。', parameters: obj({}) },
    { name: 'bank_overview', description: '题库概况：逐节点在库/归档/invokes 标注题数。巩固批与出题现势参照。', parameters: obj({}) },
    { name: 'compass_read', description: '罗盘现势：终点集合/剩余路线 + 学习者批注（软输入，提议非指令）+ 沙盘 ETA。', parameters: obj({}) },
    { name: 'endpoint_anchor', description: '终点锚集合：逐终点的终点节点/目标类型/声明日/块工作表核销进度/收尾宣告。', parameters: obj({}) },
    { name: 'upstream_dag', description: '上游图摘要：给定节点的前置传递闭包全拓扑（逐条带深度/区·块/阶段/掌握度/到期/est，⚠ = 弱掌握或到期积压）+ 闭包内 pre 邻接表 + 超 cap 溢出行。深链诊断「七步之前的地基」一次可见，取代逐跳 node_card。', parameters: obj({ node: { type: 'string', description: '节点名（逐字，来自 graph_view）' } }, ['node']) },
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
    // 终点恒标的读锚出处（#200 / ADR-0055；#239 多终点化）：图面与节点卡现算终点集合，不落盘不漂移
    const endpointsOf = async (): Promise<Set<string>> =>
      endpointNames(await readAnchors(deps.paths.anchorPath(c.root), deps.fs))
    switch (call.name as CoachToolName) {
      case 'graph_view': {
        const { graph, state } = await deps.loadView(c)
        const { today } = await deps.learningDay()
        return renderGrowthGraphView(graph, state, await endpointsOf(), { today })
      }
      case 'node_card': {
        const node = argsOf(call).node
        if (typeof node !== 'string' || !node.trim()) throw new Error('node_card 需要 node 参数（逐字节点名）。')
        const { graph, state } = await deps.loadView(c)
        return renderNodeCard(graph, state, node.trim(), await endpointsOf())
      }
      case 'concept_footprint': {
        const q = argsOf(call).query
        return renderConceptFootprint(deps, c, providers, typeof q === 'string' ? q : undefined)
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
        if (typeof node !== 'string' || !node.trim()) throw new Error('upstream_dag 需要 node 参数（逐字节点名）。')
        const { graph, state } = await deps.loadView(c)
        const { today } = await deps.learningDay()
        return renderUpstreamDag(graph, state, node.trim(), { today, endpoints: await endpointsOf() })
      }
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
