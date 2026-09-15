/**
 * 终点锚（#142 / ADR-0033 生长式图；#239 / ADR-0076 多终点化；#256 / ADR-0081 种子链退役）：
 *
 * - 终点锚是课程的方向锚**集合**（`state/终点锚.json` = `{version: 2, anchors: [...]}`）：
 *   一条锚 = 一个终点的方向与承诺（终点节点 + 选填目标描述 + 目标类型 + 声明日期 +
 *   选填收尾宣告 + 覆盖锚定的块工作表）。课程可有任意多条，`anchors: []` 是合法空态
 *   （零方向）。**一切读侧按集合工作**——生成门、就绪/推荐剔除、审计豁免、图面标记、
 *   读数的消费者逐个终点判定，不再假定唯一终点。
 * - 锚上的 `origin_proposal` / `seed_nodes` / `start_basis` 是已退役的种子起草通道
 *   （#256）留下的字段：**只作存量读侧保留**——不再有写通道，读侧（锚校验、锚落盘
 *   回写、种子图豁免）照旧认。
 * - 完成判据降为逐终点读数与停摆输入：foldCompletion 按终点折叠（ADR-0056 终点纯标记
 *   化——mastery 折叠自最后台阶（终点.pre 集全部 ≥ 阈值）+ 该终点已收尾（sealed）；
 *   能力锚定另要求闭包健康，覆盖锚定另要求块工作表全部核销）。零写侧状态、零专门停机
 *   代码；锚文件缺失 = 零终点（合法空态，空集合折叠）。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import type { Fm } from './types.ts'
import { effectiveStage, masteryOfFm } from './srs.ts'
import type { Graph } from './graph.ts'

/** 目标类型二分（#136）：能力锚定默认；覆盖锚定显式选择且必须带块工作表。 */
export type GoalType = 'capability' | 'coverage'
/** 完成判据的终点 mastery 阈值（读侧折叠常量；mastery = 0.7·稳定度完成度 + 0.3·练习证据）。 */
export const COMPLETION_MASTERY_THRESHOLD = 0.8

/** 起点定位三路（已退役的种子起草通道留痕字段的读侧类型）：baseline 常识基线 /
 * vault 先验熟悉边界 / project 反编译子图簇。不再有写通道。 */
export const START_BASES = ['baseline', 'vault', 'project'] as const
export type StartBasis = (typeof START_BASES)[number]

/** 锚容器版本（#239 / ADR-0076）：文件形状 = `{version: 2, anchors: [EndpointAnchor]}`。 */
export const ANCHOR_SCHEMA_VERSION = 2

/** 单条终点锚（容器 v2 的条目）：一个终点的方向与承诺。 */
export interface EndpointAnchor {
  /** 终点节点名（图上的位置；终点是方向标记，不是可教可考的课程节点）。 */
  endpoint: string
  /** 选填目标描述（给教练读的一句话方向说明；人手加终点时写，起草通道不带）。 */
  goal_note?: string
  goal_type: GoalType
  /** 声明日期（YYYY-MM-DD，锚落盘的当前学习日）。 */
  declared: string
  /** 收尾宣告（ADR-0056，YYYY-MM-DD）：收尾接线批 apply 时由引擎落盘——该终点.pre 已
   * 指向教练认定的最终台阶、坡道铺通宣告成立。该终点重开主线接线批（含 add_node）时
   * 清除。**逐终点独立**：一个终点的收尾/重开不影响其他终点。缺省 = 未收尾（合法照读）。 */
  sealed?: string
  /** 块工作表（仅覆盖锚定锚携带；计划层核对表，图结构层零块承诺）。落盘可省（= 空表）。 */
  worksheet: Array<{ block: string; note?: string; done: boolean }>
  /** 落盘来源起草提案 id（起草通道留痕；人手加的锚无此字段）。 */
  origin_proposal?: number
  /** 该锚所属起草批次的节点全集（起点 + 终点）：种子图豁免与罗盘起点的口径用。
   * 人手加的锚无此字段（= 空集）。 */
  seed_nodes: string[]
  /** 起点定位三路声明（起草通道留痕；语义路由，引擎只留痕）。 */
  start_basis: Record<string, StartBasis>
}

/** 锚容器（`state/终点锚.json`，version 2）：课程的全部终点；`anchors: []` = 零终点。 */
export interface AnchorBook {
  version: typeof ANCHOR_SCHEMA_VERSION
  anchors: EndpointAnchor[]
}

/** 锚的块工作表条目共用解析+归一（validateEndpointAnchor 的块工作表契约）：
 * block 必填非空、note/done 选填合法；strictKeys 时未知键拒收（锚读侧宽容）。
 * 返回归一条目列表（坏条目跳过，错误行已入 errors）。 */
function parseWorksheetEntries(
  raw: unknown, where: string, errors: string[], opts: { strictKeys?: boolean; requireNonEmpty?: boolean } = {},
): Array<{ block: string; note?: string; done: boolean }> {
  if (!Array.isArray(raw) || (opts.requireNonEmpty && !raw.length)) {
    errors.push(`${where}: 必须是非空列表（条目 = {block, note?, done?}）`)
    return []
  }
  const out: Array<{ block: string; note?: string; done: boolean }> = []
  raw.forEach((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`${where}.${i}: 必须是映射`)
      return
    }
    const w = item as Record<string, unknown>
    if (opts.strictKeys) {
      const unknownW = Object.keys(w).filter(k => !['block', 'note', 'done'].includes(k))
      if (unknownW.length) errors.push(`${where}.${i} 含未知字段 ${JSON.stringify(unknownW)}（只允许 block/note/done）`)
    }
    if (typeof w.block !== 'string' || !w.block.trim()) errors.push(`${where}.${i}.block: 不能为空`)
    if (w.note !== undefined && typeof w.note !== 'string') errors.push(`${where}.${i}.note: 必须是字符串`)
    if (w.done !== undefined && typeof w.done !== 'boolean') errors.push(`${where}.${i}.done: 必须是布尔值`)
    if (typeof w.block === 'string' && w.block.trim()) {
      out.push({ block: w.block.trim(), ...(typeof w.note === 'string' && w.note ? { note: w.note } : {}), done: w.done === true })
    }
  })
  return out
}

/** 锚条目契约校验（容器内逐条；where = 错误行前缀，如 `anchors.0`）。 */
export function validateEndpointAnchor(doc: unknown, where: string): { errors: string[]; anchor?: EndpointAnchor } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { errors: [`${where}: 必须是映射（一条锚 = {endpoint, goal_note?, goal_type, declared, sealed?, worksheet?}）`] }
  }
  const d = doc as Record<string, unknown>
  const allowed = ['endpoint', 'goal_note', 'goal_type', 'declared', 'sealed', 'worksheet', 'origin_proposal', 'seed_nodes', 'start_basis']
  const unknown = Object.keys(d).filter(k => !allowed.includes(k))
  if (unknown.length) errors.push(`${where} 含未知字段 ${JSON.stringify(unknown)}（只允许 ${allowed.join('/')}）`)
  if (typeof d.endpoint !== 'string' || !d.endpoint.trim()) errors.push(`${where}.endpoint: 不能为空`)
  if (d.goal_note !== undefined && typeof d.goal_note !== 'string') errors.push(`${where}.goal_note: 必须是字符串（选填目标描述）`)
  if (d.goal_type !== 'capability' && d.goal_type !== 'coverage') {
    errors.push(`${where}.goal_type: 只允许 capability/coverage（收到 ${JSON.stringify(d.goal_type)}）`)
  }
  if (typeof d.declared !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.declared)) {
    errors.push(`${where}.declared: 必须是 YYYY-MM-DD 日期`)
  }
  // sealed 是引擎写侧字段（收尾接线批 apply 落盘），读侧只验形状不放写通道
  if (d.sealed !== undefined && (typeof d.sealed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.sealed))) {
    errors.push(`${where}.sealed: 必须是 YYYY-MM-DD 日期（收尾宣告；缺省 = 未收尾）`)
  }
  if (d.origin_proposal !== undefined && (!Number.isInteger(d.origin_proposal) || (d.origin_proposal as number) <= 0)) {
    errors.push(`${where}.origin_proposal: 缺省或正整数（落盘来源起草提案 id）`)
  }
  if (d.seed_nodes !== undefined
    && (!Array.isArray(d.seed_nodes) || d.seed_nodes.some(n => typeof n !== 'string' || !n.trim()))) {
    errors.push(`${where}.seed_nodes: 缺省或字符串列表（起草批次的起点 + 终点）`)
  }
  let worksheet: EndpointAnchor['worksheet'] = []
  if (d.worksheet !== undefined) {
    worksheet = parseWorksheetEntries(d.worksheet, `${where}.worksheet`, errors)
  }
  if (d.goal_type === 'coverage' && !worksheet.length) {
    errors.push(`${where}.worksheet: 覆盖锚定必须携带块工作表（非空）；能力锚定不带`)
  }
  const startBasis: Record<string, StartBasis> = {}
  if (d.start_basis !== undefined) {
    if (typeof d.start_basis !== 'object' || d.start_basis === null || Array.isArray(d.start_basis)) {
      errors.push(`${where}.start_basis: 必须是映射（起点名 → 定位路由 baseline/vault/project）`)
    } else {
      for (const [k, v] of Object.entries(d.start_basis as Record<string, unknown>)) {
        if (typeof v !== 'string' || !(START_BASES as readonly string[]).includes(v)) {
          errors.push(`${where}.start_basis[${k}]: 非法定位 ${JSON.stringify(v)}（允许 ${START_BASES.join('/')}）`)
        } else startBasis[k] = v as StartBasis
      }
    }
  }
  if (errors.length) return { errors }
  return {
    errors,
    anchor: {
      endpoint: (d.endpoint as string).trim(),
      ...(typeof d.goal_note === 'string' && d.goal_note.trim() ? { goal_note: d.goal_note.trim() } : {}),
      goal_type: d.goal_type as GoalType,
      declared: d.declared as string,
      ...(typeof d.sealed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.sealed) ? { sealed: d.sealed } : {}),
      worksheet,
      ...(Number.isInteger(d.origin_proposal) && (d.origin_proposal as number) > 0 ? { origin_proposal: d.origin_proposal as number } : {}),
      seed_nodes: Array.isArray(d.seed_nodes) ? (d.seed_nodes as string[]).map(n => n.trim()) : [],
      start_basis: startBasis,
    },
  }
}

/** 锚容器契约校验（读侧 fail loud 的依据；手改破坏形状 = Broken 可见）。
 * 容器层：version 门 + anchors 列表（空列表 = 零终点，合法空态）+ 逐条条目契约 +
 * 终点名唯一（一个终点只许一条锚——读侧全部按键判定）。 */
export function validateAnchorBook(doc: unknown): { errors: string[]; book?: AnchorBook } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { errors: ['(顶层): 必须是映射 {version, anchors}'] }
  }
  const d = doc as Record<string, unknown>
  const errors: string[] = []
  const unknown = Object.keys(d).filter(k => !['version', 'anchors'].includes(k))
  if (unknown.length) errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknown)}（只允许 version/anchors）`)
  if (d.version !== ANCHOR_SCHEMA_VERSION) {
    errors.push(`version: 必须是 ${ANCHOR_SCHEMA_VERSION}（收到 ${JSON.stringify(d.version)}）——容器形状 {version, anchors: [...]}`)
  }
  if (!Array.isArray(d.anchors)) {
    errors.push('anchors: 必须是列表（零终点 = 空列表，合法空态）')
    return { errors }
  }
  const anchors: EndpointAnchor[] = []
  d.anchors.forEach((raw, i) => {
    const v = validateEndpointAnchor(raw, `anchors.${i}`)
    errors.push(...v.errors)
    if (v.anchor) anchors.push(v.anchor)
  })
  const names = anchors.map(a => a.endpoint)
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  if (dupes.length) errors.push(`anchors: 终点重名 ${dupes.join('、')}（一个终点只许一条锚）`)
  if (errors.length) return { errors }
  return { errors, book: { version: ANCHOR_SCHEMA_VERSION, anchors } }
}

/** 锚条目 → 落盘形状（可选字段为空即省略：worksheet/seed_nodes/start_basis 只在
 * 覆盖锚定与起草通道的锚上出现）。 */
function anchorDoc(a: EndpointAnchor): Record<string, unknown> {
  return {
    endpoint: a.endpoint,
    ...(a.goal_note ? { goal_note: a.goal_note } : {}),
    goal_type: a.goal_type,
    declared: a.declared,
    ...(a.sealed ? { sealed: a.sealed } : {}),
    ...(a.worksheet.length ? { worksheet: a.worksheet } : {}),
    ...(a.origin_proposal !== undefined ? { origin_proposal: a.origin_proposal } : {}),
    ...(a.seed_nodes.length ? { seed_nodes: a.seed_nodes } : {}),
    ...(Object.keys(a.start_basis).length ? { start_basis: a.start_basis } : {}),
  }
}

/** 读锚集合：文件缺失 = 空集合（零终点是合法空态）；Broken（不可读/JSON 坏/契约违约）
 * fail loud——锚是方向与读数的输入，静默降级会让生长与读数按坏锚折叠（ADR-0004）。
 * 终点增删走显式动作（锚不直改），手改破坏形状必须先修复。 */
export async function readAnchors(path: string, fs: VaultFs): Promise<EndpointAnchor[]> {
  let text: string
  try {
    text = await fs.readFile(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT') return []
    throw new Error(`[终点锚] 锚文件不可读（位置：${path}）——终点增删走显式动作，锚不直改；手改破坏形状须先修复。\n  ✗ ${err instanceof Error ? err.message : String(err)}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`[终点锚] 锚文件 Broken（JSON 无法解析，位置：${path}）——终点增删走显式动作，锚不直改；手改破坏形状须先修复。\n  ✗ ${err instanceof Error ? err.message : String(err)}`)
  }
  const v = validateAnchorBook(doc)
  if (v.errors.length || !v.book) {
    throw new Error(`[终点锚] 锚文件 Broken（契约违约，位置：${path}）——终点增删走显式动作，锚不直改；手改破坏形状须先修复。\n  ✗ ${v.errors.join('\n  ✗ ')}`)
  }
  return v.book.anchors
}

/** 写锚集合（整份覆盖）：调用方 = 起草 apply（按终点并入）、逐终点 sealed 维护、终点增删动作。 */
export async function writeAnchors(path: string, anchors: EndpointAnchor[], fs: VaultFs): Promise<void> {
  const doc: { version: typeof ANCHOR_SCHEMA_VERSION; anchors: Array<Record<string, unknown>> } = {
    version: ANCHOR_SCHEMA_VERSION,
    anchors: anchors.map(anchorDoc),
  }
  await atomicWrite(path, JSON.stringify(doc, null, 1) + '\n', fs)
}

/** 终点名集（生成门/剔除面/图面标记/审计豁免的统一读侧派生）：每处按集合读，
 * 不再假定唯一终点。 */
export function endpointNames(anchors: EndpointAnchor[]): Set<string> {
  return new Set(anchors.map(a => a.endpoint))
}

// ---- 完成读数 = 逐终点折叠（雾区条款上半；#239 多终点化） ----

/** 逐终点状态三档（ADR-0076 生长停摆的输入）：未接线 → 已铺通（锚上 sealed）→
 * 已达成（已铺通且该终点最后台阶全部 ≥ 掌握阈值）。 */
export type EndpointStatus = 'unwired' | 'sealed' | 'reached'

export interface CompletionFold {
  endpoint: string
  goal_type: GoalType
  goal_note?: string
  declared: string
  /** 该终点的收尾宣告（null = 未铺通）。 */
  sealed: string | null
  /** 逐终点三档状态（读数；UI 展示见「逐终点状态与课程完成态退役」票）。 */
  status: EndpointStatus
  /** 旧完成判据的逐终点口径（已达成 ∧ 闭包健康/工作表核销）：只作读数，课程完成态已退役。 */
  complete: boolean
  criteria: {
    /** 终点节点在图内（锚悬空 = false，可见不炸面板）。 */
    endpoint_in_graph: boolean
    /** ADR-0056 终点纯标记化：完成判据折叠自最后台阶（终点.pre 集）——终点是承诺
     * 标记不是课程节点，自身零 mastery 零调度；每条最后台阶 = {节点, 掌握度, 达标}。 */
    last_steps: Array<{ node: string; mastery: number; met: boolean }>
    mastery_threshold: number
    /** 全部最后台阶达标（pre 集为空 = 悬空/未接线，不达标）。 */
    mastery_met: boolean
    /** 收尾宣告（ADR-0056）：该锚上的 sealed 日期；null = 未收尾——两种 goal_type 都
     * 要求已收尾才判完成。 */
    sealed: string | null
    /** 仅能力锚定：终点前置闭包健康（无重名/断边/环/enc 违约）。 */
    closure_healthy?: boolean
    closure_errors?: string[]
    /** 仅覆盖锚定：块工作表核销进度。 */
    worksheet?: { total: number; done: number; complete: boolean }
  }
  /** 闭包学习进度（终点前置闭包**剔终点自身**——方向标记不被学习，计入会让读数永不可达
   * M/M）：已学 N / 共 M（已学 = 已进入在学/复习/已掌握）。 */
  closure: { learned: number; total: number }
}

/** 终点前置闭包 = 终点 + 全部传递前置（环存在时退化为闭包内逐点 BFS）；终点不在图内
 * 时退化为 {终点} 本身（悬空锚由 endpoint_in_graph 呈现，这里不炸）。 */
function closureOf(graph: Graph, endpoint: string): Set<string> {
  const closure = new Set<string>([endpoint])
  if (!graph.nset.has(endpoint)) return closure
  if (!graph.hasCycle) {
    for (const n of graph.names) if (graph.isAncestor(n, endpoint)) closure.add(n)
  } else {
    const queue = [endpoint]
    while (queue.length) {
      const u = queue.shift()!
      for (const p of graph.preOf[u]) {
        if (graph.nset.has(p) && !closure.has(p)) { closure.add(p); queue.push(p) }
      }
    }
  }
  return closure
}

/** 终点前置闭包健康（能力锚定完成判据的结构可判定部分；audit 的 E 级同款口径，
 * 纯派生零 IO 零写入）。检查面收敛在「终点 + 其前置传递闭包」上——闭包之外与终点
 * 无关的远端破损由审计/生成门负责，不拦完成宣告：E1 重名 / E2 闭包断边 /
 * E3 闭包上的环 / E6 闭包 enc 断边 / E7 闭包 enc 非祖先。多终点下逐终点各跑一次
 * （一个终点的闭包破损不影响其他终点的读数）。 */
export function closureHealthErrors(graph: Graph, endpoint: string): string[] {
  const errors: string[] = []
  for (const [n, c] of Object.entries(graph.count)) {
    if (c > 1) errors.push(`重名节点: ${n} 出现 ${c} 次`)
  }
  if (!graph.nset.has(endpoint)) return errors // 悬空锚由 endpoint_in_graph 呈现，这里不重复
  const closure = closureOf(graph, endpoint)
  for (const n of closure) {
    for (const p of graph.preOf[n]) {
      if (!graph.nset.has(p)) errors.push(`断边: ${n} -> ${p}`)
    }
    if (graph.cycleNodes.includes(n)) errors.push(`环上有闭包节点: ${n}`)
    for (const [target] of graph.encOf[n] ?? []) {
      if (!graph.nset.has(target)) errors.push(`enc 断边: ${n} -> ${target}`)
      else if (!graph.hasCycle && !graph.isAncestor(target, n)) errors.push(`enc 非祖先: ${n} -> ${target}`)
    }
  }
  return errors
}

/** 种子图判定（种子审计豁免与健康分不设阈值的口径，#142 单锚推广到锚集合）：图仍 =
 * 全部锚的种子节点并集（一个不多一个不少）——图还是起草那一刻的样子；生长批进入任一
 * 节点即翻转。零起草留痕（人手加的锚）不构成种子图。 */
export function isSeedGraph(anchors: EndpointAnchor[], graph: Graph): boolean {
  const seeds = new Set(anchors.flatMap(a => a.seed_nodes))
  return seeds.size > 0 && seeds.size === graph.names.length && [...seeds].every(n => graph.nset.has(n))
}

/** 逐终点完成折叠（读侧宣告，零写副作用）：按锚集合逐个终点折叠——锚缺失/空锚返回
 * 空列表（零终点 = 无从宣告）。ADR-0056 终点纯标记化：mastery 读数折叠自最后台阶
 * （终点.pre 集，全部 ≥ 阈值）——终点自身不再被读 mastery（它是方向标记不是可教可考的
 * 课程节点）；两种 goal_type 都要求该终点已收尾（锚 sealed）。能力锚定另要求闭包健康
 * （不动）；覆盖锚定另要求工作表全部核销（不动）。锚悬空（终点不在图内）或 pre 集为空
 * （未接线）→ mastery_met=false、status='unwired' 可见。 */
export function foldCompletion(
  graph: Graph, state: Record<string, Fm>, anchors: EndpointAnchor[],
): CompletionFold[] {
  return anchors.map(anchor => {
    const inGraph = graph.nset.has(anchor.endpoint)
    const lastSteps = inGraph
      ? graph.preOf[anchor.endpoint].map(n => {
          const mastery = masteryOfFm(state[n])
          return { node: n, mastery, met: mastery >= COMPLETION_MASTERY_THRESHOLD }
        })
      : []
    const masteryMet = lastSteps.length > 0 && lastSteps.every(s => s.met)
    const sealed = anchor.sealed ?? null
    const criteria: CompletionFold['criteria'] = {
      endpoint_in_graph: inGraph,
      last_steps: lastSteps,
      mastery_threshold: COMPLETION_MASTERY_THRESHOLD,
      mastery_met: masteryMet,
      sealed,
    }
    let complete = inGraph && masteryMet && sealed !== null
    if (anchor.goal_type === 'capability') {
      const closureErrors = closureHealthErrors(graph, anchor.endpoint)
      criteria.closure_healthy = closureErrors.length === 0
      criteria.closure_errors = closureErrors
      complete = complete && closureErrors.length === 0
    } else {
      const done = anchor.worksheet.filter(w => w.done).length
      criteria.worksheet = { total: anchor.worksheet.length, done, complete: anchor.worksheet.length > 0 && done === anchor.worksheet.length }
      complete = complete && criteria.worksheet.complete
    }
    const steps = [...closureOf(graph, anchor.endpoint)].filter(n => n !== anchor.endpoint)
    const learned = steps.filter(n => effectiveStage(state, n) !== 'unseen').length
    // 三档阶梯（ADR-0076）：未接线 → 已铺通（锚上 sealed 是**接线批落盘的结构事实**）
    // → 已达成（已铺通且最后台阶全达标）。悬空锚（终点不在图内）恒未接线——它连图上
    // 位置都没有，谈不上铺通。判据只看 sealed 与最后台阶：显式宣告的铺通不因 pre 集
    // 为空被改读成未接线（那种形态由 mastery_met=false 如实反映为「未达成」）。
    const status: EndpointStatus = !inGraph
      ? 'unwired'
      : sealed === null ? 'unwired' : masteryMet ? 'reached' : 'sealed'
    return {
      endpoint: anchor.endpoint,
      goal_type: anchor.goal_type,
      ...(anchor.goal_note ? { goal_note: anchor.goal_note } : {}),
      declared: anchor.declared,
      sealed,
      status,
      complete,
      criteria,
      closure: { learned, total: steps.length },
    }
  })
}

/** 交汇节点读侧派生（ADR-0076 词条「交汇节点」）：节点落在 ≥2 个终点的前置闭包内
 * 即交汇。返回 节点名 → 服务于哪些终点（**只收 ≥2 个的节点**——纯派生零写侧字段、
 * 不落盘，与 Mastery 同款纪律；悬空锚不入算）。终点闭包内剔除终点自身（方向标记
 * 互不为前置——禁长过目标）。 */
export function junctionServes(graph: Graph, anchors: EndpointAnchor[]): Map<string, string[]> {
  const serves = new Map<string, string[]>()
  for (const anchor of anchors) {
    if (!graph.nset.has(anchor.endpoint)) continue
    for (const n of closureOf(graph, anchor.endpoint)) {
      if (n === anchor.endpoint) continue
      const list = serves.get(n) ?? []
      list.push(anchor.endpoint)
      serves.set(n, list)
    }
  }
  return new Map([...serves].filter(([, list]) => list.length >= 2))
}

