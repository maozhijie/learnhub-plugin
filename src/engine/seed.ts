/**
 * 种子与终点锚（#142 / ADR-0033 生长式图）：
 *
 * - 种子提案（kind=seed）是课程唯一的新入口：1–3 起点 + 终点节点 +
 *   朝终点的粗占位边（终点.pre = 起点），一次人审即开工；种子节点零 enc 零 est。
 * - 终点锚 = 课程唯一结构承诺物（state/终点锚.json：终点节点+目标类型+声明日期），
 *   种子 apply 一次落盘；此后唯一的合法写通道是重新种子提案（换终点），锚不提供
 *   任何直改 API——edit 提案对终点节点的 del/rename 在受理门被拒（锚保护）。
 * - 完成 = 读侧宣告（雾区条款上半）：完成判据由 foldCompletion 折叠（ADR-0056 终点纯
 *   标记化）——mastery 折叠自最后台阶（终点.pre 集全部 ≥ 阈值）+ 已收尾（锚 sealed）；
 *   能力锚定另要求闭包健康；覆盖锚定另要求块工作表全部核销。零写侧状态、零专门停机
 *   代码；锚文件缺失 = 未播种（Missing 合法，null 折叠）。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import { parseConceptFields } from './graph.ts'
import { validateConceptEntry } from './concepts.ts'
import type { ConceptEntry } from './concepts.ts'
import type { Fm, GNode, ConceptTier, Misconception, BloomLevel } from './types.ts'
import { BLOOM_LEVELS } from './types.ts'
import { masteryOfFm } from './srs.ts'
import type { Graph } from './graph.ts'

/** 目标类型二分（#136）：能力锚定默认；覆盖锚定显式选择且必须带块工作表。 */
export type GoalType = 'capability' | 'coverage'
/** 完成判据的终点 mastery 阈值（读侧折叠常量；mastery = 0.7·稳定度完成度 + 0.3·练习证据）。 */
export const COMPLETION_MASTERY_THRESHOLD = 0.8

/** 起点定位三路（词条「种子」）：baseline 常识基线 / vault 先验熟悉边界 / project
 * 反编译子图簇（#149 接线：目标反编译产出种子提案时由引擎把起点铸成 project）。 */
export const START_BASES = ['baseline', 'vault', 'project'] as const
export type StartBasis = (typeof START_BASES)[number]

/** 终点锚（state/终点锚.json）：课程唯一结构承诺物。 */
export interface EndpointAnchor {
  version: 1
  /** 终点节点名（图上的位置；锚才是承诺）。 */
  endpoint: string
  goal_type: GoalType
  /** 声明日期（YYYY-MM-DD，种子 apply 的当前学习日）。 */
  declared: string
  /** 落盘来源提案 id（留痕；换终点 = 新种子提案覆盖整份锚）。 */
  origin_proposal: number
  /** 种子节点全集（起点 + 终点）：种子图豁免与完成折叠的闭包口径用。 */
  seed_nodes: string[]
  /** 起点定位三路声明（常识基线/vault 先验/项目簇占位；语义路由，引擎只留痕）。 */
  start_basis: Record<string, StartBasis>
  /** 块工作表（仅覆盖锚定课程携带；计划层核对表，图结构层零块承诺）。 */
  worksheet: Array<{ block: string; note?: string; done: boolean }>
  /** 收尾宣告（ADR-0056，YYYY-MM-DD）：收尾接线批 apply 时由引擎落盘——终点.pre 已指向
   * 教练认定的最终台阶、承诺兑现宣告成立。教练重开主线接线批（含 add_node）时清除。
   * 旧锚无此字段 = 未收尾（合法，照读）。 */
  sealed?: string
}

/** 块工作表条目的共用解析+归一（validateAnchor 与 validateSeedProposal 同一契约）：
 * block 必填非空、note/done 选填合法；strictKeys 时未知键拒收（提案侧防呆，锚读侧宽容）。
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

/** 锚文件契约校验（读侧 fail loud 的依据；手改破坏形状 = Broken 可见）。 */
export function validateAnchor(doc: unknown): { errors: string[]; anchor?: EndpointAnchor } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { errors: ['(顶层): 必须是映射'] }
  }
  const d = doc as Record<string, unknown>
  const allowed = ['version', 'endpoint', 'goal_type', 'declared', 'origin_proposal', 'seed_nodes', 'start_basis', 'worksheet', 'sealed']
  const unknown = Object.keys(d).filter(k => !allowed.includes(k))
  if (unknown.length) errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknown)}（只允许 ${allowed.join('/')}）`)
  if (d.version !== 1) errors.push(`version: 必须是 1（收到 ${JSON.stringify(d.version)}）`)
  if (typeof d.endpoint !== 'string' || !d.endpoint.trim()) errors.push('endpoint: 不能为空')
  if (d.goal_type !== 'capability' && d.goal_type !== 'coverage') {
    errors.push(`goal_type: 只允许 capability/coverage（收到 ${JSON.stringify(d.goal_type)}）`)
  }
  if (typeof d.declared !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.declared)) {
    errors.push('declared: 必须是 YYYY-MM-DD 日期')
  }
  // sealed 是引擎写侧字段（收尾接线批 apply 落盘），读侧只验形状不放写通道
  if (d.sealed !== undefined && (typeof d.sealed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.sealed))) {
    errors.push('sealed: 必须是 YYYY-MM-DD 日期（收尾宣告；缺省 = 未收尾）')
  }
  if (!Number.isInteger(d.origin_proposal) || (d.origin_proposal as number) <= 0) {
    errors.push('origin_proposal: 必须是正整数（落盘来源提案 id）')
  }
  if (!Array.isArray(d.seed_nodes) || !d.seed_nodes.length || d.seed_nodes.some(n => typeof n !== 'string' || !n.trim())) {
    errors.push('seed_nodes: 必须是非空字符串列表（起点 + 终点）')
  }
  let worksheet: EndpointAnchor['worksheet'] = []
  if (d.worksheet !== undefined) {
    worksheet = parseWorksheetEntries(d.worksheet, 'worksheet', errors)
  }
  if (d.goal_type === 'coverage' && (!Array.isArray(d.worksheet) || !d.worksheet.length)) {
    errors.push('worksheet: 覆盖锚定课程必须携带块工作表（非空）；能力锚定课程不带')
  }
  const startBasis: Record<string, StartBasis> = {}
  if (d.start_basis !== undefined) {
    if (typeof d.start_basis !== 'object' || d.start_basis === null || Array.isArray(d.start_basis)) {
      errors.push('start_basis: 必须是映射（起点名 → 定位路由 baseline/vault/project）')
    } else {
      for (const [k, v] of Object.entries(d.start_basis as Record<string, unknown>)) {
        if (typeof v !== 'string' || !(START_BASES as readonly string[]).includes(v)) {
          errors.push(`start_basis[${k}]: 非法定位 ${JSON.stringify(v)}（允许 ${START_BASES.join('/')}）`)
        } else startBasis[k] = v as StartBasis
      }
    }
  }
  if (errors.length) return { errors }
  return {
    errors,
    anchor: {
      version: 1,
      endpoint: (d.endpoint as string).trim(),
      goal_type: d.goal_type as GoalType,
      declared: d.declared as string,
      origin_proposal: d.origin_proposal as number,
      seed_nodes: (d.seed_nodes as string[]).map(n => n.trim()),
      start_basis: startBasis,
      worksheet,
      ...(typeof d.sealed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.sealed) ? { sealed: d.sealed } : {}),
    },
  }
}

/** 读锚：Missing = null（未播种，合法空态）；Broken（不可读/JSON 坏/契约违约）fail
 * loud——锚是结构承诺物，静默降级会让完成判据按坏锚折叠（ADR-0004）。 */
export async function readAnchor(path: string, fs: VaultFs): Promise<EndpointAnchor | null> {
  let text: string
  try {
    text = await fs.readFile(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT') return null
    throw new Error(`[终点锚] 锚文件不可读（位置：${path}）——锚不提供直改通道，换终点走种子提案（kind=seed）重写。\n  ✗ ${err instanceof Error ? err.message : String(err)}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`[终点锚] 锚文件 Broken（JSON 无法解析，位置：${path}）——锚不提供直改通道，换终点走种子提案（kind=seed）重写。\n  ✗ ${err instanceof Error ? err.message : String(err)}`)
  }
  const v = validateAnchor(doc)
  if (v.errors.length || !v.anchor) {
    throw new Error(`[终点锚] 锚文件 Broken（契约违约，位置：${path}）——锚不提供直改通道，换终点走种子提案（kind=seed）重写。\n  ✗ ${v.errors.join('\n  ✗ ')}`)
  }
  return v.anchor
}

/** 写锚（调用方 = 种子 apply 整份覆盖 + 收尾接线批的 sealed 写/清——ADR-0056：
 * sealed 是 apply 写入单元内的锚字段维护，其余字段仍只走种子提案人审）。 */
export async function writeAnchor(path: string, anchor: EndpointAnchor, fs: VaultFs): Promise<void> {
  await atomicWrite(path, JSON.stringify(anchor, null, 1) + '\n', fs)
}

// ---- 种子提案 schema（kind=seed） ----

/** 种子节点条目（起点与终点同构；est/enc/pre 不可声明——种子零 enc 零 est，
 * 占位边由引擎落到终点.pre）。 */
export interface SeedNodeSpec {
  name: string
  region: string
  block: string
  note?: string
  bloom?: BloomLevel
  difficulty?: 1 | 2 | 3 | 4 | 5
  teaches?: Record<string, ConceptTier>
  assumes?: Record<string, ConceptTier>
  misconceptions?: Misconception[]
  /** 起点定位路由声明（仅起点；baseline 常识基线 / vault 先验熟悉边界 / project 反编译
   * 子图簇——第三路由 #149 目标反编译受理时铸成）。 */
  basis?: StartBasis
}

export interface SeedProposalSpec {
  course: string
  /** new = 新课程入口（注册表不得已有同名课程）；reseed = 既有课程重新种子（换终点/换工作表）。 */
  mode: 'new' | 'reseed'
  goal_type: GoalType
  endpoint: SeedNodeSpec
  starts: SeedNodeSpec[]
  /** 块工作表：goal_type=coverage 必带；capability 拒收。 */
  worksheet?: Array<{ block: string; note?: string; done?: boolean }>
  /** 铸名块（#141 同一契约，随图 apply 的写入单元落盘）。 */
  concepts?: ConceptEntry[]
  reason?: string
}

const SEED_NODE_KEYS = new Set(['name', 'region', 'block', 'note', 'bloom', 'difficulty', 'teaches', 'assumes', 'misconceptions', 'basis'])
const SEED_TOP_KEYS = new Set(['course', 'mode', 'goal_type', 'endpoint', 'starts', 'worksheet', 'concepts', 'reason'])

/** 种子节点条目解析（起点/终点共用；seed 节点走 parseConceptFields 同一闸）。 */
function parseSeedNode(raw: unknown, where: string, errors: string[], warns: string[]): SeedNodeSpec | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${where}: 必须是映射`)
    return null
  }
  const r = raw as Record<string, unknown>
  const unknown = Object.keys(r).filter(k => !SEED_NODE_KEYS.has(k))
  if (unknown.length) {
    errors.push(`${where} 含未知字段 ${JSON.stringify(unknown)}（只允许 ${[...SEED_NODE_KEYS].join('/')}；`
      + `种子节点零 enc 零 est——enc/est 不接受，占位边由引擎落到终点 pre，起点是入口不携带 pre）`)
  }
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) errors.push(`${where}.name 不能为空`)
  const region = typeof r.region === 'string' ? r.region.trim() : ''
  if (!region) errors.push(`${where}.region 不能为空（分区定位：区名 + 块名）`)
  const block = typeof r.block === 'string' ? r.block.trim() : ''
  if (!block) errors.push(`${where}.block 不能为空（分区定位：区名 + 块名）`)
  if (r.note !== undefined && typeof r.note !== 'string') errors.push(`${where}.note: 必须是字符串`)
  if (r.bloom !== undefined && (!(BLOOM_LEVELS as readonly string[]).includes(String(r.bloom)))) {
    errors.push(`${where}.bloom: 非法认知层级 ${String(r.bloom)}（允许 ${BLOOM_LEVELS.join('/')}）`)
  }
  if (r.difficulty !== undefined && ![1, 2, 3, 4, 5].includes(Number(r.difficulty))) {
    errors.push(`${where}.difficulty: 非法难度 ${String(r.difficulty)}（允许 1-5）`)
  }
  if (r.basis !== undefined && !(START_BASES as readonly string[]).includes(String(r.basis))) {
    errors.push(`${where}.basis: 非法定位 ${String(r.basis)}（允许 ${START_BASES.join('/')}）`)
  }
  let fields: ReturnType<typeof parseConceptFields> = {}
  if (r.teaches !== undefined || r.assumes !== undefined || r.misconceptions !== undefined) {
    try {
      fields = parseConceptFields(r, '种子提案', where, name || '?', warns)
    } catch (e) {
      errors.push((e as Error).message)
    }
  }
  if (!name || !region || !block) return null
  return {
    name, region, block,
    ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
    ...(typeof r.bloom === 'string' && (BLOOM_LEVELS as readonly string[]).includes(r.bloom) ? { bloom: r.bloom as BloomLevel } : {}),
    ...([1, 2, 3, 4, 5].includes(Number(r.difficulty)) ? { difficulty: Number(r.difficulty) as 1 | 2 | 3 | 4 | 5 } : {}),
    ...fields,
    ...(typeof r.basis === 'string' && (START_BASES as readonly string[]).includes(r.basis) ? { basis: r.basis as StartBasis } : {}),
  }
}

/** SeedProposal schema 校验（warns 收集概念字段组非阻提示，可省略）。 */
export function validateSeedProposal(doc: unknown, warns?: string[]): { errors?: string[]; spec?: SeedProposalSpec } {
  const errors: string[] = []
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  const unknownTop = Object.keys(d).filter(k => !SEED_TOP_KEYS.has(k))
  if (unknownTop.length) {
    errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknownTop)}（只允许 ${[...SEED_TOP_KEYS].join('/')}）`)
  }
  if (typeof d.course !== 'string' || !d.course.trim()) errors.push('course: 不能为空')
  if (d.mode !== 'new' && d.mode !== 'reseed') {
    errors.push('mode: 缺失或非法（必填，new = 新课程入口 / reseed = 既有课程重新种子——换终点走这里）')
  }
  if (d.goal_type !== undefined && d.goal_type !== 'capability' && d.goal_type !== 'coverage') {
    errors.push(`goal_type: 只允许 capability/coverage（缺省 = capability 能力锚定；coverage 覆盖锚定必须显式选择并带 worksheet）`)
  }
  const goalType: GoalType = d.goal_type === 'coverage' ? 'coverage' : 'capability'
  if (d.endpoint === undefined) {
    errors.push('endpoint: 缺失（种子提案必须声明终点节点——课程唯一结构承诺物）')
  }
  const endpoint = d.endpoint === undefined ? null : parseSeedNode(d.endpoint, 'endpoint', errors, warns ?? [])
  if (!Array.isArray(d.starts) || !d.starts.length) {
    errors.push('starts: 缺失或为空（种子 = 1–3 个起点节点 + 终点）')
  }
  const starts: SeedNodeSpec[] = []
  if (Array.isArray(d.starts)) {
    if (d.starts.length > 3) {
      errors.push(`starts: 有 ${d.starts.length} 条（上限 3）——种子只铺起点，其余由教练生长批沿症状与消费生长`)
    }
    d.starts.forEach((raw, i) => {
      const s = parseSeedNode(raw, `starts.${i}`, errors, warns ?? [])
      if (s) starts.push(s)
    })
  }
  // 工作表：覆盖必带非空、能力拒收（互斥由判据语义锁定，不靠约定）
  let worksheet: SeedProposalSpec['worksheet']
  if (d.worksheet !== undefined) {
    worksheet = parseWorksheetEntries(d.worksheet, 'worksheet', errors, { strictKeys: true, requireNonEmpty: true })
  }
  if (goalType === 'coverage' && !worksheet?.length) {
    errors.push('worksheet: 覆盖锚定（goal_type=coverage）必须携带块工作表——完成判据=块工作表+终点')
  }
  if (goalType === 'capability' && d.worksheet !== undefined) {
    errors.push('worksheet: 能力锚定课程不带块工作表（完成判据=终点掌握；要清单式目标请显式 goal_type=coverage）')
  }
  let concepts: ConceptEntry[] | undefined
  if (d.concepts !== undefined) {
    if (!Array.isArray(d.concepts)) {
      errors.push('concepts: 必须是列表（铸名条目 = {canonical, aliases?, definition?}）')
    } else {
      concepts = []
      d.concepts.forEach((raw, i) => {
        const v = validateConceptEntry(raw, `concepts.${i + 1}`)
        errors.push(...v.errors)
        if (v.entry) concepts!.push(v.entry)
      })
    }
  }
  if (d.reason !== undefined && typeof d.reason !== 'string') errors.push('reason: 必须是字符串')
  // 重名防呆（跨 endpoint/starts；跨区同名也是重名）
  const names = starts.map(s => s.name)
  if (endpoint) names.push(endpoint.name)
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  if (dupes.length) errors.push(`种子节点重名: ${dupes.join('、')}（起点与终点名字必须互异）`)
  if (errors.length) return { errors }
  return {
    spec: {
      course: (d.course as string).trim(),
      mode: d.mode as 'new' | 'reseed',
      goal_type: goalType,
      endpoint: endpoint!,
      starts,
      ...(worksheet ? { worksheet } : {}),
      ...(concepts !== undefined ? { concepts } : {}),
      ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    },
  }
}

/** 种子节点条目 → GNode（零 enc 零 est；起点 pre 空，终点 pre = 起点——朝终点的粗占位边）。 */
export function seedNodeToGNode(spec: SeedNodeSpec, pre: string[]): GNode {
  return {
    name: spec.name,
    pre: [...pre],
    opt: false,
    note: spec.note ?? '',
    enc: [],
    ...(spec.bloom ? { bloom: spec.bloom } : {}),
    ...(spec.difficulty !== undefined ? { difficulty: spec.difficulty } : {}),
    ...(spec.teaches ? { teaches: { ...spec.teaches } } : {}),
    ...(spec.assumes ? { assumes: { ...spec.assumes } } : {}),
    ...(spec.misconceptions?.length ? { misconceptions: spec.misconceptions.map(m => ({ ...m })) } : {}),
  }
}

// ---- 完成 = 读侧宣告（雾区条款上半） ----

export interface CompletionFold {
  goal_type: GoalType
  endpoint: string
  declared: string
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
    /** 收尾宣告（ADR-0056）：锚上的 sealed 日期；null = 未收尾——两种 goal_type 都
     * 要求已收尾才判完成。 */
    sealed: string | null
    /** 仅能力锚定：终点前置闭包健康（无重名/断边/环/enc 违约）。 */
    closure_healthy?: boolean
    closure_errors?: string[]
    /** 仅覆盖锚定：块工作表核销进度。 */
    worksheet?: { total: number; done: number; complete: boolean }
  }
}

/** 终点前置闭包健康（能力锚定完成判据的结构可判定部分；audit 的 E 级同款口径，
 * 纯派生零 IO 零写入）。检查面收敛在「终点 + 其前置传递闭包」上——闭包之外与终点
 * 无关的远端破损由审计/生成门负责，不拦完成宣告：E1 重名 / E2 闭包断边 /
 * E3 闭包上的环 / E6 闭包 enc 断边 / E7 闭包 enc 非祖先。 */
export function closureHealthErrors(graph: Graph, endpoint: string): string[] {
  const errors: string[] = []
  for (const [n, c] of Object.entries(graph.count)) {
    if (c > 1) errors.push(`重名节点: ${n} 出现 ${c} 次`)
  }
  if (!graph.nset.has(endpoint)) return errors // 悬空锚由 endpoint_in_graph 呈现，这里不重复
  // 终点前置闭包 = 终点 + 全部传递前置（环存在时 reach 缺席，退化为闭包内逐点 BFS）
  const closure = new Set<string>([endpoint])
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

/** 种子图判定（种子审计豁免与健康分不设阈值的口径，#142）：图仍 = 终点锚的
 * 种子节点全集（一个不多一个不少）——图还是种子本身；生长批进入任一节点即翻转。 */
export function isSeedGraph(anchor: EndpointAnchor | null, graph: Graph): boolean {
  return !!anchor
    && anchor.seed_nodes.length === graph.names.length
    && anchor.seed_nodes.every(n => graph.nset.has(n))
}

/** 完成判据折叠（读侧宣告，零写副作用）：锚缺失返回 null（未播种 = 无从宣告）。
 * ADR-0056 终点纯标记化：mastery 读数折叠自最后台阶（终点.pre 集，全部 ≥ 阈值）——
 * 终点自身不再被读 mastery（它是承诺标记不是可教可考的课程节点）；两种 goal_type 都
 * 要求已收尾（锚 sealed）。能力锚定另要求闭包健康（不动）；覆盖锚定另要求工作表全部
 * 核销（不动）。锚悬空（终点不在图内）或 pre 集为空（未接线）→ mastery_met=false 可见。 */
export function foldCompletion(
  graph: Graph, state: Record<string, Fm>, anchor: EndpointAnchor | null,
): CompletionFold | null {
  if (!anchor) return null
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
  return {
    goal_type: anchor.goal_type,
    endpoint: anchor.endpoint,
    declared: anchor.declared,
    complete,
    criteria,
  }
}

/** 写锚时的锚文档构造（种子 apply 用；起点/终点名与图内严格一致）。 */
export function anchorFromSeed(
  spec: SeedProposalSpec, originProposal: number, declared: string,
): EndpointAnchor {
  return {
    version: 1,
    endpoint: spec.endpoint.name,
    goal_type: spec.goal_type,
    declared,
    origin_proposal: originProposal,
    seed_nodes: [...spec.starts.map(s => s.name), spec.endpoint.name],
    start_basis: Object.fromEntries(spec.starts.filter(s => s.basis).map(s => [s.name, s.basis!])),
    worksheet: (spec.worksheet ?? []).map(w => ({ block: w.block, ...(w.note ? { note: w.note } : {}), done: w.done === true })),
  }
}

/** 面板下发的种子起草请求（ADR-0038）：绑定字段（课程名/模式/目标类型/块工作表）
 * 以表单为准，引擎受理前覆盖写入——模型照抄错误不影响绑定。 */
export interface SeedDraftRequest {
  course: string
  goal: string
  mode?: 'new' | 'reseed'
  goalType?: 'capability' | 'coverage'
  useVaultPrior?: boolean
  worksheet?: Array<{ block: string; note?: string }>
}

/** 种子起草修复轮提示词（面板下发的 seedPropose 用，decompileRepairPrompt 同款机械）：
 * 上一次输出未过干跑校验门 → 附校验清单重出完整 YAML。 */
export function seedRepairPrompt(pack: string, previous: string, errors: string[]): string {
  return `${pack}\n\n## 上一次输出未过种子校验门（重新输出**完整** YAML 文档，修正下列全部问题；仍只输出一个 YAML，不要解释）\n\n上一次输出：\n\n${previous}\n\n校验清单：\n\n${errors.join('\n')}\n`
}
