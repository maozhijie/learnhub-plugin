/**
 * agent 产出（图/变更）的门禁与落盘 + 提案生命周期。
 *
 * 流程铁律：agent 产出 YAML → schema 校验 → 结构检查（断边/环/冲突）→
 * 提案落盘 pending（产物文件全留痕）→ 人审 → apply 过 audit 门禁生效 → journal + 快照。
 * 拒绝同样留痕（status=rejected）。
 */
import type { VaultFs } from './io.ts'
import { createHash } from 'node:crypto'
import { YAML } from './yaml.ts'
import { Store } from './store.ts'
import { atomicWrite } from './io.ts'
import { runWriteUnit } from './write-unit.ts'
import { Graph, GraphStore, loadRegionDoc, parseConceptFields, parseEnc, misconceptionCapErrors, snapshotDoc } from './graph.ts'
import { ConceptRegistry, addConfusablePair, applyConceptMints, conceptMagnitudeWarnings, conceptPairKey, conceptReferenceErrors, isDeprecated, mergeConceptEntries, mintConflicts, namesOf, nearNameCandidates, nearNameWarnings, resolveConcept, validateConceptEntry } from './concepts.ts'
import { CONCEPT_MERGE_IRREVERSIBLE, validateConceptMergeProposal, validateConfusableCandidateProposal } from './concepts.ts'
import type { ConceptEntry, ConceptRef, ConfusableCandidateProposalSpec } from './concepts.ts'
import { saveNote, defaultFrontmatter } from './notes.ts'
import { endpointNames, readAnchors, writeAnchors, isSeedGraph } from './seed.ts'
import type { EndpointAnchor } from './seed.ts'
import {
  SECTION_ROUTE, compassScaffold, withSectionText, validateRouteBody, stripWrappingFence,
} from './compass.ts'
import { todayStr } from './dates.ts'
import type { Clock } from './clock.ts'
import { appendProbationEntry, recheckPreregOf } from './probation.ts'
import type { RecheckPrereg } from './probation.ts'
import { RECHECK_DAYS_DEFAULT } from './params.ts'
import type { GRegion, GBlock, GNode, BloomLevel, EncEdge, ConceptTier, Misconception, GrowthOperator } from './types.ts'
import { BLOOM_LEVELS, PROPOSAL_KINDS, PROPOSAL_STATUSES, GROWTH_OPERATORS } from './types.ts'
import type { Paths } from './paths.ts'
import type { CourseEntry, ProposalKind, ProposalRec } from './types.ts'
import type { GraphEditProposalResult, GraphEnrichProposalResult } from './views/proposals.ts'
import type { GraphApplyEditResult, GraphApplyEnrichResult } from './views/graph.ts'

/** apply 门禁的审计快照（facade 层跑 audit 后传入；findings 由 warns + 健康分组成）。 */
export interface ApplyAudit { ok: boolean; warns: string[]; health: number }

export interface EditOp {
  op: 'add_node' | 'del_node' | 'set_pre' | 'set_enc' | 'rename' | 'set_note'
  node?: string
  /** add_node 的节点键（#131 §7 键名统一：与图 YAML/parseNode 同名，旧 `node` 键退役）。 */
  name?: string
  new?: string
  pre?: string[]
  /** set_enc 整体替换的成分技能边（与图 YAML 同形态：字符串=权重 1，映射带可选 w/note）；add_node 可选携带。 */
  enc?: Array<string | { node: string; w?: number; note?: string }>
  opt?: boolean
  note?: string
  est?: number
  type?: 'practice'
  bloom?: string
  difficulty?: number
  /** 概念字段组（add_node 出生层，schema v2 #127）：teaches/assumes 概念名→档，误解条目列表。 */
  teaches?: Record<string, ConceptTier>
  assumes?: Record<string, ConceptTier>
  misconceptions?: Misconception[]
}

/** 生长批 note 区（#145 裁决产物面）：算子标签 + 理由 + 分歧声明（可选）。生长批仍是
 * kind=edit 提案（不新增提案 kind）；note 在场即生长批——ops 允许为空（裁决=暂不产
 * 结构，罗盘重写随写入单元落盘）。#146 起插入批随批预注册复诊（note.recheck：恰一枚
 * 可机判 metric + 复诊期缺省 10 学习日 clamp [5,20]），apply 随写入单元登记边实验账本。 */
export interface GrowthNote {
  operator: GrowthOperator
  reason: string
  /** 朝向声明（ADR-0076 教练回合多终点化）：本批朝哪些终点长（终点节点名列表）。
   * 主线批（前进/换向）含 add_node 时必填非空——「主线批必接线」的覆盖检查对每个
   * 声明的终点各跑一遍；声明终点必须是在册锚。同一个新节点可同时进多个终点的 pre
   * （交汇节点，合法形态）。其他算子省略。 */
  target_endpoints?: string[]
  /** 真分歧声明（disagreement）：轻量段裁决与上下文/批注存在实质分歧时声明，宿主
   * 升级全量段重裁（两段式 effort；显然步免仲裁税不声明）。字段名避让「申诉
   * （Dispute，ADR-0031）」词条——同名同义纪律。 */
  disagreement?: string
  /** 复诊预注册（#146 词条「复诊」）：只随 operator=插入 且本批有 add_node 的批携带
   * （其他算子携带即拒收；插入批缺预注册拒收）——metric 恰一枚（前进恢复/卡点集中度
   * 降幅/保留率恢复），days 缺省 10 学习日 clamp [5,20]。 */
  recheck?: RecheckPrereg
}

/** 提案 op 上的退役键：边轻纪律键（#127：候选边留提案侧留痕、origin 从 journal 派生、
 * 复诊状态落 state/边实验.jsonl，提案节点零边元数据字段）+ 结构坐标键（#275：Region/Block
 * 退役，写侧不再有 region/block 坐标）。一律拒收不静默丢弃。 */
const RETIRED_OP_KEYS = ['origin', 'status', 'probation', 'region', 'block'] as const

export interface EditProposalSpec {
  course: string
  reason?: string
  /** 铸名块（#141 登记机械化）：随生长批提案铸名入册，随图 apply 的写入单元落盘；
   * 提案被拒则登记不落盘。省略 = 本批零铸名。 */
  concepts?: ConceptEntry[]
  ops: EditOp[]
  /** 生长批 note 区（#145）：在场 = 生长批（教练回合裁决产物）；缺席 = 普通 edit 提案。 */
  note?: GrowthNote
  /** 罗盘批内重写（#145）：「剩余路线」段新正文，随图 apply 的写入单元落盘——提案被拒
   * 罗盘不落盘。唯一写权属生长批（note 在场）；普通 edit 提案携带即拒收。 */
  route?: string
}

const EDIT_OPS = ['add_node', 'del_node', 'set_pre', 'set_enc', 'rename', 'set_note'] as const

/** 批内 add_node 数（插入登记/调速闸门的「本批新增」口径单点；解析前 doc.ops 与
 * EditOp[] 同形消费）。 */
export function addNodeCountOf(ops: Array<{ op?: unknown }> | undefined): number {
  return (ops ?? []).filter(o => o.op === 'add_node').length
}

/** EditOp 的 enc 载荷 → EncEdge[]（字符串=权重 1，映射带可选 w/note；与图 YAML parseEnc 同形态）。 */
function normalizeOpEnc(raw: EditOp['enc']): EncEdge[] {
  return (raw ?? []).map(item => typeof item === 'string'
    ? { node: item, w: 1.0 }
    : { node: item.node, w: item.w ?? 1.0, ...(item.note ? { note: item.note } : {}) })
}

function nonempty(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} 不能为空`)
  return v.trim()
}

/** EditOp / EditProposal schema 校验（warns 收集概念字段组的非阻提示，可省略）。 */
export function validateEditProposal(doc: unknown, warns?: string[]): { errors?: string[]; spec?: EditProposalSpec } {
  const errors: string[] = []
  const d = doc as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return { errors: ['(顶层): 必须是映射'] }
  try {
    nonempty(d.course, 'course')
  } catch (e) { errors.push((e as Error).message) }
  // 铸名块（#141）：条目形态同一契约（canonical 必填、aliases/definition 选填、
  // 未知键拒收）。与登记表的撞名对账在受理门（需要读登记表文件），这里只管形态。
  let concepts: ConceptEntry[] | undefined
  if (d.concepts !== undefined) {
    if (!Array.isArray(d.concepts)) {
      errors.push('concepts: 必须是列表（铸名条目 = {canonical, aliases?, definition?}）')
    } else {
      concepts = []
      d.concepts.forEach((raw: unknown, i: number) => {
        const v = validateConceptEntry(raw, `concepts.${i + 1}`)
        errors.push(...v.errors)
        if (v.entry) concepts!.push(v.entry)
      })
    }
  }
  // 生长批 note 区（#145）：严格 schema——恰 {operator, reason, disagreement?, recheck?}，
  // 未知键拒收。#146：recheck 只随插入批携带；插入批（有 add_node）缺预注册拒收。
  let note: GrowthNote | undefined
  let recheckWarns: string[] = []
  if (d.note !== undefined) {
    if (typeof d.note !== 'object' || d.note === null || Array.isArray(d.note)) {
      errors.push('note: 必须是映射（生长批裁决区 = {operator, reason, disagreement?, recheck?}）')
    } else {
      const n = d.note as Record<string, unknown>
      const noteErrors: string[] = []
      const unknown = Object.keys(n).filter(k => !['operator', 'reason', 'target_endpoints', 'disagreement', 'recheck'].includes(k))
      if (unknown.length) {
        noteErrors.push(`note 含未知字段 ${JSON.stringify(unknown)}（只允许 operator/reason/target_endpoints/disagreement/recheck；朝向声明写在 target_endpoints，分歧声明写在 disagreement，复诊预注册写在 recheck）`)
      }
      if (!(GROWTH_OPERATORS as readonly string[]).includes(String(n.operator))) {
        noteErrors.push(`note.operator: 非法算子 ${JSON.stringify(String(n.operator))}（允许 ${GROWTH_OPERATORS.join('/')}）`)
      }
      if (typeof n.reason !== 'string' || !n.reason.trim()) {
        noteErrors.push('note.reason 不能为空（每步生长都带理由——可解释、可追问）')
      }
      // 朝向声明（ADR-0076）：列表形态在此门，跨字段规则（主线批必声明、声明终点必须是
      // 在册锚、逐终点接线覆盖）在 endpointGuardErrors（需要锚集合与 ops 全貌）
      let targetEndpoints: string[] | undefined
      if (n.target_endpoints !== undefined) {
        if (!Array.isArray(n.target_endpoints) || !n.target_endpoints.length
          || n.target_endpoints.some((t: unknown) => typeof t !== 'string' || !t.trim())) {
          noteErrors.push('note.target_endpoints: 必须是非空字符串列表（本批朝哪些终点长；省略 = 非主线批）')
        } else {
          targetEndpoints = (n.target_endpoints as string[]).map(t => t.trim())
        }
      }
      if (n.disagreement !== undefined && (typeof n.disagreement !== 'string' || !n.disagreement.trim())) {
        noteErrors.push('note.disagreement: 分歧声明声明了就要写内容（真分歧才声明——显然步免仲裁税）')
      }
      // 复诊预注册（#146）：schema 门在此，跨字段规则在 ops 就位后统一裁（见下方 preregGate）
      let recheck: RecheckPrereg | undefined
      if (n.recheck !== undefined) {
        const v = recheckPreregOf(n.recheck)
        noteErrors.push(...v.errors)
        recheckWarns = v.warns
        if (!v.errors.length && v.prereg) recheck = v.prereg
      }
      errors.push(...noteErrors)
      if (!noteErrors.length) {
        note = {
          operator: String(n.operator) as GrowthOperator,
          reason: (n.reason as string).trim(),
          ...(targetEndpoints ? { target_endpoints: targetEndpoints } : {}),
          ...(typeof n.disagreement === 'string' && n.disagreement.trim() ? { disagreement: n.disagreement.trim() } : {}),
          ...(recheck ? { recheck } : {}),
        }
      }
    }
  }
  // 罗盘批内重写（#145）：route 只随生长批携带——「剩余路线」写权属教练回合生长批，
  // 普通 edit 提案携带即拒收（罗盘唯一写权，见 compass.ts 头注）。
  let route: string | undefined
  if (d.route !== undefined) {
    if (!note) {
      errors.push('route: 普通 edit 提案不得携带（「剩余路线」唯一写权属教练回合生长批——带 note 区的生长批才随批重写罗盘）')
    } else if (typeof d.route !== 'string' || !d.route.trim()) {
      errors.push('route: 必须是非空字符串（「剩余路线」段新正文；不重写罗盘就省略本字段）')
    } else {
      route = d.route
    }
  }
  const ops: EditOp[] = []
  if (d.ops === undefined && note) {
    // 生长批允许零操作（裁决=暂不产结构；罗盘重写与批留痕照走写入单元）
  } else if (!Array.isArray(d.ops)) {
    errors.push('ops: 必须是列表（普通提案至少一条操作；生长批裁决不产结构时写空列表 ops: []）')
  } else if (!d.ops.length && !note) {
    errors.push('ops: 提案没有操作条目')
  } else {
    d.ops.forEach((raw: unknown, i: number) => {
      const o = raw as Record<string, unknown> | null
      const where = `ops.${i}`
      if (typeof o !== 'object' || o === null) {
        errors.push(`${where}: 必须是映射`)
        return
      }
      const op = o.op
      if (typeof op !== 'string' || !(EDIT_OPS as readonly string[]).includes(op)) {
        errors.push(`${where}.op: 非法操作 ${String(op)}（允许 ${EDIT_OPS.join('/')}）${op === 'move' ? '——move 已随 Region/Block 退役（#275）：分组改为读侧派生，写侧不再有换分区操作' : ''}`)
        return
      }
      // 退役键（#127 边轻纪律 + #275 结构坐标）：静默丢弃会丢语义，fail loud。按键族分段给出可执行指引。
      const retired = Object.keys(o).filter(k => (RETIRED_OP_KEYS as readonly string[]).includes(k))
      const coords = retired.filter(k => k === 'region' || k === 'block')
      const edges = retired.filter(k => k !== 'region' && k !== 'block')
      if (coords.length) errors.push(`${where}: 不接受坐标键 ${JSON.stringify(coords)}（随 Region/Block 退役 #275）——add_node 只需 name + pre，删掉这两个键即可落图（分布由读侧派生）`)
      if (edges.length) errors.push(`${where}: 不接受这些字段 ${JSON.stringify(edges)}（origin 从提案 journal 派生、复诊状态落 state/边实验.jsonl——图与提案节点零边字段）`)
      // 键名统一到 name（#131 §7 / #1：与图 YAML 同口径，不做兼容双读也不容双写）——
      // add_node 用 name 定义新节点；其余 op 用 node 引用既有节点。写错键一律 fail loud。
      if (op === 'add_node') {
        if (o.node !== undefined && String(o.node).trim()) {
          errors.push(`${where}: op=add_node 不接受 node 键（键名已统一到 name——你写了 node: ${String(o.node).trim()}）`)
        }
        if (!(o.name && String(o.name).trim())) errors.push(`${where}: op=add_node 需要 name`)
      } else {
        if (o.name !== undefined && String(o.name).trim()) {
          errors.push(`${where}: op=${op} 不接受 name 键（name 只用于 add_node 定义新节点；引用既有节点写 node: ${String(o.name).trim()}）`)
        }
        if (!(o.node && String(o.node).trim())) errors.push(`${where}: op=${op} 需要 node`)
      }
      // 概念字段组只随 add_node 出生；写在其他 op 上 = 提案方误解语义，静默丢弃会丢字段
      if (op !== 'add_node' && (o.teaches !== undefined || o.assumes !== undefined || o.misconceptions !== undefined)) {
        errors.push(`${where}: op=${op} 不接受 teaches/assumes/misconceptions（概念字段组只在 add_node 出生时写）`)
      }
      if (op === 'rename' && !(o.new && String(o.new).trim())) errors.push(`${where}: rename 需要 new（rename 成对字段：node=旧名，new=新名）`)
      // 整体替换语义防呆：缺 pre/enc 数组会被当成空集静默清掉已有边，这里直接拒绝（显式清空写 pre: [] / enc: []）
      if (op === 'set_pre' && !Array.isArray(o.pre)) errors.push(`${where}: set_pre 需要 pre 列表（整体替换语义，缺省会被当成清空全部前置；显式清空写 pre: []）`)
      if (op === 'set_enc' && !Array.isArray(o.enc)) errors.push(`${where}: set_enc 需要 enc 列表（整体替换语义，缺省会被当成清空全部成分技能边；显式清空写 enc: []）`)
      // 认知维度可选字段（schema 从严：给了就必合法）
      if (o.bloom !== undefined && o.bloom !== '' && !(BLOOM_LEVELS as readonly string[]).includes(String(o.bloom))) {
        errors.push(`${where}.bloom: 非法认知层级 ${String(o.bloom)}（允许 ${BLOOM_LEVELS.join('/')}）`)
      }
      if (o.difficulty !== undefined && o.difficulty !== '' && ![1, 2, 3, 4, 5].includes(Number(o.difficulty))) {
        errors.push(`${where}.difficulty: 非法难度 ${String(o.difficulty)}（允许 1-5）`)
      }
      if (o.est !== undefined && o.est !== '' && !(Number.isFinite(Number(o.est)) && Number(o.est) > 0)) {
        errors.push(`${where}.est: 非法时长 ${String(o.est)}（分钟，正数）`)
      }
      if (o.type !== undefined && o.type !== '' && o.type !== 'practice') {
        errors.push(`${where}.type: 非法节点类型 ${String(o.type)}（只允许 practice）`)
      }
      if (o.enc !== undefined) {
        if (!Array.isArray(o.enc)) {
          errors.push(`${where}.enc: 必须是列表`)
        } else o.enc.forEach((e: unknown, j: number) => {
          const item = e as Record<string, unknown> | string | null
          const t = typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.node
          if (typeof t !== 'string' || !t.trim()) errors.push(`${where}.enc.${j}: 缺 node`)
          const w = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).w : undefined
          if (w !== undefined && (typeof w !== 'number' || w < 0 || w > 1)) errors.push(`${where}.enc.${j}: w 必须是 0–1 的数`)
        })
      }
      // 概念字段组（add_node 出生层）走 parseConceptFields 同一闸：尺寸/枚举 ERROR 直接拒收，
      // 1–2 条的窄节点 WARN 收集给受理回执（不阻）。
      let conceptFields: { teaches?: Record<string, ConceptTier>; assumes?: Record<string, ConceptTier>; misconceptions?: Misconception[] } = {}
      if (op === 'add_node' && (o.teaches !== undefined || o.assumes !== undefined || o.misconceptions !== undefined)) {
        try {
          conceptFields = parseConceptFields(o, where, op, String(o.name ?? ''), warns)
        } catch (e) {
          errors.push((e as Error).message)
        }
      }
      ops.push({
        op: op as EditOp['op'],
        node: typeof o.node === 'string' ? o.node.trim() : undefined,
        name: typeof o.name === 'string' ? o.name.trim() : undefined,
        new: typeof o.new === 'string' ? o.new.trim() : undefined,
        pre: Array.isArray(o.pre) ? o.pre.map(String) : [],
        ...(Array.isArray(o.enc) ? { enc: o.enc as EditOp['enc'] } : {}),
        opt: Boolean(o.opt),
        note: typeof o.note === 'string' ? o.note : undefined,
        ...(Number.isFinite(Number(o.est)) && Number(o.est) > 0 ? { est: Math.round(Number(o.est)) } : {}),
        ...(o.type === 'practice' ? { type: 'practice' as const } : {}),
        ...(typeof o.bloom === 'string' && (BLOOM_LEVELS as readonly string[]).includes(o.bloom)
          ? { bloom: o.bloom as BloomLevel } : {}),
        ...([1, 2, 3, 4, 5].includes(Number(o.difficulty))
          ? { difficulty: Number(o.difficulty) as 1 | 2 | 3 | 4 | 5 } : {}),
        ...conceptFields,
      })
    })
  }
  if (errors.length) return { errors }
  // 复诊预注册的跨字段规则（#146，ops 就位后裁）：插入=带预注册的生长批——
  // 有 add_node 的插入批必须预注册复诊（零人审结算的判据前提）；预注册只随插入批
  // 携带（其他算子/零新增节点没有可登记的插入边）。
  if (note) {
    const adds = addNodeCountOf(ops)
    if (note.operator === '插入' && adds > 0 && !note.recheck) {
      errors.push('note.recheck: 插入批必须预注册复诊（metric: 前进恢复|卡点集中度降幅|保留率恢复；days 缺省 10 学习日）——插入边的到期结算零人审，没有预注册就没有结算判据')
    }
    if (note.recheck && (note.operator !== '插入' || adds === 0)) {
      errors.push(`note.recheck: 复诊预注册只随插入批携带（本批 operator=${note.operator}、add_node ${adds} 条——没有可登记的插入边就无需预注册）`)
    }
  }
  warns?.push(...recheckWarns)
  if (errors.length) return { errors }
  return {
    spec: {
      course: (d!.course as string).trim(),
      reason: typeof d!.reason === 'string' ? d!.reason : '',
      ...(concepts !== undefined ? { concepts } : {}),
      ops,
      ...(note ? { note } : {}),
      ...(route !== undefined ? { route } : {}),
    },
  }
}

/** edit 提案全部概念引用（teaches/assumes 键 + 误解 concept；#141 受理门对表原料）。 */
function conceptRefsOfOps(ops: EditOp[]): ConceptRef[] {
  const refs: ConceptRef[] = []
  for (const [i, op] of ops.entries()) {
    const where = `ops.${i}(${op.op === 'add_node' ? op.name : op.node})`
    for (const concept of Object.keys(op.teaches ?? {})) refs.push({ where: `teaches[${where}]`, concept })
    for (const concept of Object.keys(op.assumes ?? {})) refs.push({ where: `assumes[${where}]`, concept })
    for (const m of op.misconceptions ?? []) refs.push({ where: `misconceptions[${where}]`, concept: m.concept })
  }
  return refs
}

/** 巩固门（#145 受理门校验）：operator=巩固 的批是综合收束——add_node 的概念引用
 * （teaches/assumes/误解）只许引已教概念（既有图 teaches 并集），不产新概念；
 * 不走复诊由边轻纪律键拒收与 #146 结算语义共同保证（巩固批没有复诊通道）。 */
export function consolidationGateErrors(
  operator: GrowthOperator | undefined, ops: EditOp[], graph: Graph,
): string[] {
  if (operator !== '巩固') return []
  // 已教概念集单一出处 Graph.taughtByOf（#270 反向映射）：names 全扫折叠退役。
  const taught = new Set(Object.keys(graph.taughtByOf))
  const errors: string[] = []
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'add_node') continue
    const where = `ops.${i}(add_node ${op.name})`
    for (const concept of Object.keys(op.teaches ?? {})) {
      if (!taught.has(concept)) errors.push(`${where}: 巩固节点 teaches「${concept}」不是已教概念——巩固只引已教概念做综合收束；新概念走 前进/插入/旁支 产出`)
    }
    for (const concept of Object.keys(op.assumes ?? {})) {
      if (!taught.has(concept)) errors.push(`${where}: 巩固节点 assumes「${concept}」不是已教概念——巩固只引已教概念做综合收束`)
    }
    for (const m of op.misconceptions ?? []) {
      if (!taught.has(m.concept)) errors.push(`${where}: 巩固节点误解条目「${m.concept}」不是已教概念——巩固只引已教概念做综合收束`)
    }
  }
  return errors
}

export function applyFindings(audit: ApplyAudit, seedPhase = false): string[] {
  const findings = audit.warns.map(w => `⚠ ${w}`)
  if (!seedPhase && audit.ok && audit.health > 0 && audit.health < 80) {
    findings.push(`⚠ 图谱健康分 ${audit.health} < 80 基线：继续生长前可参考 learnhub_graph_analyze 的 health/suggestions 定位短板`)
  }
  return findings
}

/** sealed 谓词（#271 / ADR-0088 抽出共享：apply 写单元与草稿内核两处同调，不复刻）：
 * 收尾接线批 = 零 add_node 的纯 set_pre 批 → 被接线终点落 sealed；被含 add_node 的
 * 主线批接线 → reopen。夹带其他 op 的零新增批不构成收尾宣告、也不动 sealed。
 * effects 为空 = 本批不触碰任何终点锚。 */
export interface SealedDecision {
  /** 被本批 set_pre 接线的终点节点（图上在册锚的子集）。 */
  wired: string[]
  /** 是否构成收尾宣告（零 add_node 纯 set_pre 批）。 */
  sealing: boolean
  effects: Array<{ endpoint: string; action: 'seal' | 'reopen' }>
}

export function sealedDecisionOf(ops: EditOp[], anchors: EndpointAnchor[]): SealedDecision {
  const wires = new Set(ops.filter(o => o.op === 'set_pre' && o.node).map(o => o.node!))
  const touched = anchors.filter(a => wires.has(a.endpoint))
  if (!wires.size || !touched.length) return { wired: [], sealing: false, effects: [] }
  const adds = addNodeCountOf(ops)
  const sealing = adds === 0 && ops.every(o => o.op === 'set_pre')
  if (!sealing && adds === 0) return { wired: touched.map(a => a.endpoint), sealing: false, effects: [] }
  return {
    wired: touched.map(a => a.endpoint),
    sealing,
    effects: touched.map(a => ({ endpoint: a.endpoint, action: sealing ? 'seal' as const : 'reopen' as const })),
  }
}

/** edit 受理门全序列收拢（#271 / ADR-0088 中心裁决「门同源」）：结构重放 / 概念对表 /
 * 终点锚保护 / 巩固门 / 生长闸门——proposeEdit / applyEdit / 草稿内核**三处同调**，
 * 草稿通过 = 门通过按构造成立。上下文由调用方装载（entries = 登记现行条目，需铸名
 * 合并的调用方传合并后集合并省略 mints；anchors = 现行终点锚），本函数零 IO。 */
export interface EditGateCtx {
  regions: GRegion[]
  graph: Graph
  entries: ConceptEntry[]
  anchors: EndpointAnchor[]
  /** 本批铸名块（对表用；与 entries 撞名由 mintConflicts 硬拒）。 */
  mints?: ConceptEntry[]
  growthGate?: (spec: EditProposalSpec) => Promise<string[]>
}

export async function editGateErrors(spec: EditProposalSpec, ctx: EditGateCtx): Promise<string[]> {
  const mints = ctx.mints ?? []
  const errors = [
    ...simulateOps(ctx.regions, ctx.graph, spec.ops),
    ...mintConflicts(mints, ctx.entries),
    ...conceptReferenceErrors(conceptRefsOfOps(spec.ops), namesOf([...ctx.entries, ...mints])),
    ...endpointGuardErrorsOf(spec, ctx.anchors),
    ...consolidationGateErrors(spec.note?.operator, spec.ops, ctx.graph),
  ]
  if (errors.length) return errors
  const gateBlocks = ctx.growthGate ? await ctx.growthGate(spec) : []
  // 闸门横幅随错误行返回（原 propose/apply 两侧的包装文案，门同调后单源在此）
  return gateBlocks.length ? ['生长闸门拒绝受理（插入积极性调速，#146）', ...gateBlocks] : []
}

// ---- 富化覆盖层通道（kind=enrich，#140：schema v2 出生/覆盖层分家）----

/** 覆盖层字段条目：节点 → 该字段的写入值。首期只有 enc（#127 §6：覆盖层首期=enc 回填）。 */
export interface EnrichFieldEntry { node: string; enc: EncEdge[] }

export interface EnrichProposalSpec {
  course: string
  reason?: string
  fields: EnrichFieldEntry[]
  /** 引擎受理时写入：受影响正典文件（课程根相对路径）的 sha256——apply 时复核，
   * 不符 = 提案基于旧版图，拒收。手工构造的提案没有指纹，同样拒收。 */
  fingerprints?: Record<string, string>
}

const ENRICH_TOP_KEYS = new Set(['course', 'reason', 'fields', 'fingerprints'])
const ENRICH_ENTRY_KEYS = new Set(['node', 'enc'])

/** EnrichProposal schema 校验（富化=引擎直跑通道，指纹外的部分同样过 schema 门）。 */
export function validateEnrichProposal(doc: unknown): { errors?: string[]; spec?: EnrichProposalSpec } {
  const errors: string[] = []
  const d = doc as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return { errors: ['(顶层): 必须是映射'] }
  const unknownTop = Object.keys(d).filter(k => !ENRICH_TOP_KEYS.has(k))
  if (unknownTop.length) {
    errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknownTop)}（只允许 ${[...ENRICH_TOP_KEYS].join('/')}；fingerprints 由引擎受理时写入，不手工填）`)
  }
  try {
    nonempty(d.course, 'course')
  } catch (e) { errors.push((e as Error).message) }
  const fields: EnrichFieldEntry[] = []
  if (!Array.isArray(d.fields) || !d.fields.length) {
    errors.push('fields: 富化提案没有字段条目（每条 = {node, enc}）')
  } else {
    d.fields.forEach((raw: unknown, i: number) => {
      const where = `fields.${i}`
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        errors.push(`${where}: 必须是映射（{node, enc}）`)
        return
      }
      const f = raw as Record<string, unknown>
      const unknown = Object.keys(f).filter(k => !ENRICH_ENTRY_KEYS.has(k))
      if (unknown.length) {
        errors.push(`${where} 含未知字段 ${JSON.stringify(unknown)}（覆盖层首期只补写 enc——teaches/assumes/误解是出生字段，随生长批写；只允许 node/enc）`)
      }
      const node = typeof f.node === 'string' ? f.node.trim() : ''
      if (!node) errors.push(`${where}.node 不能为空`)
      if (f.enc === undefined) errors.push(`${where}.enc 缺失（覆盖层条目是字段全量替换；显式清空写 enc: []）`)
      else if (!Array.isArray(f.enc)) errors.push(`${where}.enc 必须是列表`)
      else {
        let enc: EncEdge[] = []
        try {
          enc = parseEnc(f.enc, where, 'enrich', node || '?')
        } catch (e) { errors.push((e as Error).message) }
        if (node) fields.push({ node, enc })
      }
    })
  }
  if (errors.length) return { errors }
  let fingerprints: Record<string, string> | undefined
  if (d.fingerprints !== undefined) {
    if (typeof d.fingerprints !== 'object' || d.fingerprints === null || Array.isArray(d.fingerprints)) {
      errors.push('fingerprints: 必须是映射（文件相对路径 → sha256）')
    } else {
      fingerprints = Object.fromEntries(
        Object.entries(d.fingerprints as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    }
  }
  if (errors.length) return { errors }
  const dupes = [...new Set(fields.map(f => f.node).filter((n, i, arr) => arr.indexOf(n) !== i))]
  if (dupes.length) errors.push(`fields: 节点重复条目 ${JSON.stringify(dupes)}（每节点至多一条；合并 enc 后重提）`)
  if (errors.length) return { errors }
  return {
    spec: {
      course: (d!.course as string).trim(),
      reason: typeof d!.reason === 'string' ? d!.reason : '',
      fields,
      ...(fingerprints ? { fingerprints } : {}),
    },
  }
}

/** sha256 内容指纹（enrich 受理/复核共用；utf8 文本）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 富化提案的目标节点缺席清单（受理与 apply 双门共用）。 */
function enrichMissingTargets(fields: EnrichFieldEntry[], graph: Graph): string[] {
  return [...new Set(fields.map(f => f.node).filter(n => !graph.nset.has(n)))]
}

/** 终点锚保护 + 生长方向不变式（#142/#198 / ADR-0055；#239 / ADR-0076 多终点化：**每个**终点
 * 各跑同一套检查）：edit 提案不得 del/rename 锚定的终点节点——那是绕开显式终点动作的锚直改。
 * 方向不变式三句：① 任何 add_node 以终点为 pre 直接拒——目标之后不是本课程的生长域；
 * ② 主线批（前进/换向）含新节点时必须声明 target_endpoints，接线覆盖检查对每个声明的终点
 * 各跑一遍——零终点课程同样不豁免；③ 收尾接线批（零 add_node 的纯 set_pre）合法。
 * 接线核查取「覆盖」而非「相等」：最后台阶可与既有台阶合流（交汇），新前沿全部在 wire 里
 * 就守住不变式。旁支/巩固/插入豁免接线义务。（#271 抽出纯函数形态：editGateErrors 三处同调） */
export function endpointGuardErrorsOf(spec: EditProposalSpec, anchors: EndpointAnchor[]): string[] {
  const endpoints = endpointNames(anchors)
  const label = (name: string): string => {
    const a = anchors.find(x => x.endpoint === name)!
    return `${a.declared} 声明${a.origin_proposal !== undefined ? `，提案 #${a.origin_proposal}` : ''}`
  }
  const errors: string[] = []
  for (const [i, op] of spec.ops.entries()) {
    if (!endpoints.has(op.node ?? '')) continue
    if (op.op === 'del_node') {
      errors.push(`ops.${i}: del_node 拒绝——「${op.node}」是锚定的终点（${label(op.node!)}）。终点增删走显式动作，不直改锚`)
    } else if (op.op === 'rename') {
      errors.push(`ops.${i}: rename 拒绝——「${op.node}」是锚定的终点（${label(op.node!)}）。终点增删走显式动作，不直改锚`)
    }
  }
  // ① 禁以终点为 pre：add_node 把方向锚当前置 = 长过目标
  for (const [i, op] of spec.ops.entries()) {
    if (op.op === 'add_node' && (op.pre ?? []).some(p => endpoints.has(p))) {
      const hit = (op.pre ?? []).filter(p => endpoints.has(p))
      errors.push(`ops.${i}: add_node「${op.name}」以终点「${hit.join('、')}」为 pre——目标之后不是本课程的生长域（禁长过目标）`)
    }
  }
  // ② 主线批必接线（ADR-0076 教练回合多终点化）：前进/换向批含新节点时必须声明
  //    note.target_endpoints（本批朝哪些终点长），接线覆盖检查对**每个**声明的终点
  //    各跑一遍；声明终点必须是在册锚（锚由人手增删，提案不得凭空捏造方向）。
  //    同一个新节点同时进多个终点的 pre 是合法形态（交汇节点，同一门下天然放行）。
  const adds = addNodeCountOf(spec.ops)
  if (spec.note && (spec.note.operator === '前进' || spec.note.operator === '换向') && adds > 0) {
    const targets = spec.note.target_endpoints ?? []
    if (!targets.length) {
      errors.push(`生长批（${spec.note.operator}）含 ${adds} 个新节点但未声明朝向——note.target_endpoints 必填（本批朝哪些终点长；交汇优先，可声明多个）`)
    }
    const newNames = spec.ops.filter(o => o.op === 'add_node').map(o => o.name!)
    const consumed = new Set(spec.ops.flatMap(o => o.op === 'add_node' ? (o.pre ?? []) : []))
    const frontier = newNames.filter(n => !consumed.has(n))
    for (const target of targets) {
      if (!endpoints.has(target)) {
        errors.push(`note.target_endpoints: 「${target}」不是在册终点——朝向只能声明锚上已声明的终点（锚由学习者手加，提案不得改）`)
        continue
      }
      const wirings = spec.ops.filter(o => o.op === 'set_pre' && o.node === target)
      if (!wirings.length) {
        errors.push(`生长批（${spec.note.operator}）声明朝「${target}」长但未接线——主线批必须携带 set_pre { node: ${target}, pre: [批内新前沿${frontier.length ? `（本批：${frontier.join('、')}）` : ''}] }（替换语义：终点.pre 恒指向教练当前认定的最后台阶，真实坡道取代起草粗边）`)
      } else {
        // apply 取最后一条 set_pre（整体替换语义后者生效）——接线核查同口径
        const wired = new Set(wirings[wirings.length - 1]!.pre ?? [])
        const missing = frontier.filter(n => !wired.has(n))
        if (missing.length) {
          errors.push(`set_pre(${target}) 未覆盖批内新前沿：${missing.join('、')}——主线批接线必须把本批新前沿全部汇入终点闭包（set_pre 整体替换，终点.pre = 当前认定的最后台阶）`)
        }
      }
    }
  }
  return errors
}

export class GraphProposals {
  private concepts: ConceptRegistry
  constructor(
    private paths: Paths,
    private store: Store,
    private registry: { get(key: string): Promise<CourseEntry | null>; load(): Promise<CourseEntry[]>; save(c: CourseEntry[]): Promise<void> },
    private centerRoot: string,
    /** 生长闸门（#146 插入/旁支调速）：受理与 apply 双门在 schema 门后调用——需要
     * 三率流水（账本/提案/练习），由门面注入（本类零流水依赖）；返回拒收行，空 = 放行。 */
    private growthGate: ((spec: EditProposalSpec) => Promise<string[]>) | undefined,
    /** 时钟端口（#175 阶段①）：decided/now 戳与学习日缺省都经它取时。 */
    private clock: Clock,
    private fs: VaultFs,
  ) {
    this.concepts = new ConceptRegistry(paths, this.fs)
  }

  /** 为图中缺笔记的节点补骨架文件（幂等）：apply 落图后调用。
   * 节点存在于图就该有 frontmatter 文件——vault 笔记是调度状态的事实源。 */
  async ensureNotesFor(root: string, regions: GRegion[]): Promise<number> {
    let created = 0
    for (const r of regions) {
      for (const b of r.blocks) {
        for (const n of b.nodes) {
          const path = this.paths.courseNotePath(root, n.name)
          if (this.fs.exists(path)) continue
          await saveNote(path, defaultFrontmatter(n.name) as unknown as Record<string, unknown>, '> 内容待生成。\n', this.fs)
          created++
        }
      }
    }
    return created
  }

  /** 提案产物 YAML 落盘（全留痕）→ artifact 路径。注册表条目出生即带 artifact 路径
   * （路径含自增 id，经 createProposal 构造器形态一次落盘，无「先空后填」两段窗口）。 */
  private async saveArtifact(kind: ProposalKind, course: string, doc: unknown): Promise<{ pid: number; path: string }> {
    const pid = await this.store.createProposal(kind, course, '',
      id => this.paths.proposalArtifactPath(id, kind, course))
    const path = this.paths.proposalArtifactPath(pid, kind, course)
    await atomicWrite(path, YAML.stringify(doc), this.fs)
    return { pid, path }
  }

  private async loadArtifact(path: string): Promise<unknown> {
    if (!this.fs.exists(path)) throw new Error(`[proposal] 文件不存在: ${path}`)
    return YAML.parse(await this.fs.readFile(path))
  }

  /** graph propose-edit：在内存图上模拟执行 + 概念引用对表 + 终点锚保护 + 巩固门
   * （#145）→ pending。warns = 受理门的非阻提示（窄节点等概念字段组提示），随受理
   * 回执返给提案方。note 在场 = 生长批：summary 带算子标签与理由（每步可解释）。 */
  async proposeEdit(yamlText: string): Promise<GraphEditProposalResult> {
    const warns: string[] = []
    const v = validateEditProposal(YAML.parseModel(yamlText), warns)
    if (v.errors) throw new Error(`[propose-edit] schema 校验失败，提案未受理。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[propose-edit] 注册表中没有课程「${spec.course}」。`)
    const regions = await new GraphStore(this.paths, this.paths.courseRoot(course.root), this.fs).load()
    const graph = new Graph(regions)
    const entries = await this.concepts.load(course.root) // 登记表 Broken 在此抛错，apply 不落盘
    // 非阻提示照旧（#264 近似名预检与量级告警）；错误面统一走 editGateErrors（门同源，ADR-0088）
    warns.push(...nearNameWarnings(nearNameCandidates(spec.concepts ?? [], entries)))
    if (spec.concepts?.length) warns.push(...conceptMagnitudeWarnings(applyConceptMints(entries, spec.concepts).entries))
    const anchors = await readAnchors(this.paths.anchorPath(course.root), this.fs)
    const gateErrors = await editGateErrors(spec, {
      regions, graph, entries, anchors,
      mints: spec.concepts ?? [], growthGate: this.growthGate,
    })
    if (gateErrors.length) {
      throw new Error(`[propose-edit] 提案未受理（修正后重提）。\n${gateErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 罗盘重写预检（#145 写入单元门：提案被拒罗盘不落盘——route 门在受理时就走一遍，
    // 不给坏路线落 pending 的机会）
    if (spec.route !== undefined) {
      const routeErrors = await this.routeGate(course.root, spec.route)
      if (routeErrors.length) {
        throw new Error(`[propose-edit] 罗盘重写未过路线门，提案未受理。\n${routeErrors.map(e => `  ✗ ${e}`).join('\n')}`)
      }
    }
    const { pid } = await this.saveArtifact('edit', spec.course, YAML.parseModel(yamlText))
    await this.store.updateProposal(pid, {
      summary: spec.note
        ? `生长批（${spec.note.operator}）：${spec.note.reason}｜${spec.ops.length} 条操作`
        : `${spec.ops.length} 条操作${spec.concepts?.length ? `；铸名 ${spec.concepts.length} 条` : ''}：${spec.ops.map(o => o.op).join('、')}`,
    })
    return {
      id: pid, kind: 'edit', course: spec.course, ops: spec.ops.length,
      ...(spec.note ? { operator: spec.note.operator, ...(spec.note.disagreement ? { disagreement: true } : {}) } : {}),
      ...(spec.route !== undefined ? { compass_rewrite: true } : {}),
      ...(warns.length ? { warns } : {}),
    }
  }

  /** 罗盘重写预检（propose 与 apply 双门共用；返回错误行，空 = 通过）：锚在终点上
   * （零终点 fail loud）+ 路线门（非空/无标题/限长）。 compass.ts 的写权机械不变。 */
  private async routeGate(root: string, routeMd: string): Promise<string[]> {
    const anchors = await readAnchors(this.paths.anchorPath(root), this.fs)
    if (!anchors.length) return ['课程零终点（空锚是合法空态）——罗盘重写锚在终点上，先加一个终点。']
    return validateRouteBody(stripWrappingFence(routeMd))
  }

  /** 终点守卫的 IO 薄壳（纯判定住模块层 endpointGuardErrorsOf；propose/apply 双门经
   * editGateErrors 同调消费，本方法保留给 route 门外的独立调用点）。 */
  private async endpointGuardErrors(root: string, spec: EditProposalSpec): Promise<string[]> {
    return endpointGuardErrorsOf(spec, await readAnchors(this.paths.anchorPath(root), this.fs))
  }


  /** graph apply-edit：概念对表复验 → 铸名与图随写入单元落盘 + 改名/移动/删除联动课程
   * 笔记 + 罗盘批内重写（#145：route 在场时随图 apply 的写入单元——路线门/巩固门全过
   * 才开始任何写盘，提案被拒罗盘不落盘）+ 快照。登记表先写（孤儿条目合法、悬空引用
   * 违约），graph 落盘在后。 */
  async applyEdit(pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }): Promise<GraphApplyEditResult> {
    if (!audit.ok) throw new Error('[apply-edit] 审计存在 ERROR，拒绝写入——先处理 审计报告.md。')
    const prop = await this.store.takePending('edit', pid)
    const v = validateEditProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[apply-edit] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[apply-edit] 注册表中没有课程「${spec.course}」。`)
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root), this.fs)
    // 概念对表复验（#141）：受理与 apply 之间登记表可能被并入/手改；铸名侧幂等
    // （已属同一条目跳过），撞上其他条目即拒绝，两门全过才开始任何写盘。
    const existing = await this.concepts.load(root)
    const { errors: mintErrors, entries: mergedEntries } = applyConceptMints(existing, spec.concepts ?? [])
    const conceptErrors = [...mintErrors, ...conceptReferenceErrors(conceptRefsOfOps(spec.ops), namesOf(mergedEntries))]
    if (conceptErrors.length) {
      throw new Error(`[apply-edit] 概念引用对表失败，提案不落盘。\n${conceptErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const regions = await store.load()
    const graph = new Graph(regions)
    // 门复验统一走 editGateErrors（门同源，ADR-0088）：结构重放/概念对表（铸名合并集）/锚
    // 保护/巩固门/生长闸门一次跑全——受理与 apply 之间图/登记表/锚可能变化，双门全过才写盘。
    const gateErrors = await editGateErrors(spec, {
      regions, graph, entries: mergedEntries,
      anchors: await readAnchors(this.paths.anchorPath(root), this.fs),
      growthGate: this.growthGate,
    })
    if (gateErrors.length) {
      throw new Error(`[apply-edit] 门复验拒绝写入（提案已不适用当前图或门状态已变，被拒绝可重提）。\n${gateErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 罗盘重写预检（#145 写入单元最后一道门）：路线门与锚复验不过 = 零写盘。
    let compassRoute: string | null = null
    if (spec.route !== undefined) {
      const routeErrors = await this.routeGate(root, spec.route)
      if (routeErrors.length) {
        throw new Error(`[apply-edit] 罗盘重写未过路线门，提案不落盘。\n${routeErrors.map(e => `  ✗ ${e}`).join('\n')}`)
      }
      compassRoute = stripWrappingFence(spec.route)
    }
    // 生长闸门复验（#146）已并入上方 editGateErrors（门同源）——空门合并保留这段位以锚住
    // “route 门在生长闸之后”的写序不变。

    // add_node 无坐标（#275）：落到图内既有的单一区（首个区）——区内无块时落点会建一个以
    // 区名命名的块（created_blocks 记这些新建块）。存储塌缩（一课程一文件）见 #284。
    const createdBlocks = new Set<string>()
    for (const op of spec.ops) {
      if (op.op !== 'add_node') continue
      const region = regions[0]
      if (region && !region.blocks.length) createdBlocks.add(region.name)
    }

    const renames: Record<string, string> = {}
    const dels: string[] = []
    for (const op of spec.ops) {
      if (op.op === 'rename') renames[op.node!] = op.new!
      else if (op.op === 'del_node') dels.push(op.node!)
    }

    // 2. data/*.yaml 重写（内存侧应用 ops；落盘动作进下方写入单元）
    applyOpsToRegions(regions, spec.ops)
    const files = await store.regionFiles()

    // 写入单元（#176）：写序照今天的声明——「铸名 → 图区重写 → 终点锚 sealed 维护
    // （#202）→ 笔记联动 → 罗盘批内重写 → 边实验账本 → 快照 → 笔记骨架 → journal(graph_edit)
    // → 提案 applied」。铸名孤儿条目合法、悬空引用违约（登记表先写、图在后）；路线门/
    // 巩固门/生长闸全过才进写序（罗盘被拒不落盘）。失败上抛中止，不回滚不续跑，失败不写
    // journal；重放被 takePending/simulateOps 门拦住（重放不保证收敛，靠门不靠续段）。
    let compassRewritten = false
    const probationRegistered: string[] = []
    let regions2: Awaited<ReturnType<GraphStore['load']>> = []
    let version = 0
    await runWriteUnit('applyEdit', {
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          // 写序第一笔照旧：此后任一步失败，登记表至多多出孤儿条目（合法态）——
          // 反过来图先写会让引用悬空；铸名幂等已在上方 applyConceptMints 门内
          name: '铸名落概念登记表',
          run: async () => {
            if (spec.concepts?.length) await this.concepts.save(root, mergedEntries)
          },
        },
        {
          name: '图区重写',
          run: async () => {
            for (const region of regions) {
              if (region.name in files) await store.writeRegionDoc(files[region.name], region)
            }
          },
        },
        {
          // 3.1 终点锚 sealed 维护（ADR-0056；#239 / ADR-0076 多终点化：**逐终点独立**）：
          //     只看**被本批接线的那一个终点**——收尾接线批 = 零 add_node 的纯 set_pre 批
          //     → 给该终点落 sealed 收尾宣告（该终点的坡道已铺到最终台阶）；该终点被含
          //     add_node 的主线批接线 → 清除（重开该终点主线 = 坡道重新在途）。其他终点
          //     的 sealed 不受本批影响。夹带其他 op 的零新增批不构成收尾宣告、也不动 sealed。
          //     读-改-写在一步内完成；零终点静默跳过；sealed 缺省不落盘（形状不变）。
          name: '终点锚 sealed 维护',
          run: async () => {
            // sealed 谓词单一出处 sealedDecisionOf（#271 / ADR-0088：apply 与草稿内核同调）
            const decision = sealedDecisionOf(spec.ops, await readAnchors(this.paths.anchorPath(root), this.fs))
            if (!decision.effects.length) return
            const today = todayStr(new Date(this.clock.nowMs()))
            const anchorPath = this.paths.anchorPath(root)
            const anchors = await readAnchors(anchorPath, this.fs)
            const next: EndpointAnchor[] = anchors.map(a => {
              const eff = decision.effects.find(e => e.endpoint === a.endpoint)
              if (!eff) return a
              return eff.action === 'seal' ? { ...a, sealed: today } : { ...a, sealed: undefined }
            })
            await writeAnchors(anchorPath, next, this.fs)
          },
        },
        {
          // 3. 改名/移动/删除联动课程笔记（用 ops 应用前的图定位旧文件位置；
          //    graphAfter 里旧名已不存在/位置已变，会让联动静默失效）
          name: '笔记联动（改名/归档）',
          run: async () => {
            for (const [oldName, newName] of Object.entries(renames)) await this.relocateNote(root, graph, oldName, newName)
            for (const node of dels) await this.archiveNote(root, graph, node, prop.id)
          },
        },
        {
          // 3.5 罗盘批内重写（#145）：路线门已过、只换「剩余路线」段，批注区/ETA
          //     字节保留；罗盘缺席落脚手架打底（与 compassRewrite 同语义）。
          name: '罗盘批内重写',
          run: async () => {
            if (compassRoute === null) return
            const compassPath = this.paths.compassPath(root)
            const base = this.fs.exists(compassPath) ? await this.fs.readFile(compassPath) : compassScaffold(course.name)
            await atomicWrite(compassPath, withSectionText(base, SECTION_ROUTE, compassRoute), this.fs)
            compassRewritten = true
          },
        },
        {
          // 3.6 边实验账本登记（#146）：插入批的每个 add_node 登记一条在途复诊
          //     （node/pre = 登记快照、proposal = 本批提案 id、due = 预注册学习日数）——
          //     到期结算钩子据此自动裁决（proven｜自动剪除），零人审。
          name: '边实验账本登记',
          run: async () => {
            if (!(spec.note?.operator === '插入' && spec.note.recheck)) return
            const due = spec.note.recheck.days ?? RECHECK_DAYS_DEFAULT
            for (const op of spec.ops) {
              if (op.op !== 'add_node') continue
              await appendProbationEntry(this.paths, root, {
                node: op.name!, pre: [...(op.pre ?? [])], proposal: prop.id, due,
              }, this.fs)
              probationRegistered.push(op.name!)
            }
          },
        },
        {
          name: '快照',
          run: async () => {
            regions2 = await store.load()
            version = (await this.store.latestSnapshotVersion(course.name)) + 1
            await this.store.saveSnapshot(course.name, version, snapshotDoc(store, regions2))
          },
        },
        {
          // 逐节点 existsSync 跳过（步骤内幂等：已有笔记的节点不覆盖）
          name: '笔记骨架补齐',
          run: async () => { await this.ensureNotesFor(root, regions2) },
        },
        {
          // detail 三段：操作清单（add_node 显示 name，其余显示 node）→ 铸名 → 生长批裁决；
          // 零操作批（裁决暂不产结构）也要留痕可读
          name: '操作 journal',
          run: async () => {
            const opList = spec.ops.map(o => `${o.op}(${o.op === 'add_node' ? o.name : o.node})`).join('；')
            const mintList = spec.concepts?.length ? `；铸名 ${spec.concepts.map(c => c.canonical).join('、')}` : ''
            const detail = (opList || `（零操作${spec.route !== undefined ? '，罗盘重写' : '，裁决留痕'}）`)
              + mintList
              + (spec.note ? `；生长批（${spec.note.operator}）：${spec.note.reason}` : '')
            await this.store.appendJournal({
              course: course.name, node: '*', rating: null, kind: 'graph_edit', elapsed_days: 0,
              session: String(prop.id),
              detail,
            })
          },
        },
        {
          name: '提案 applied',
          run: async () => {
            await this.store.updateProposal(prop.id, { status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(), decision_note: `快照 v${version}` })
          },
        },
      ],
    })
    // 种子图豁免（#142）：apply 后图仍 = 终点锚种子节点全集时健康分不设阈值
    const seedPhase = isSeedGraph(await readAnchors(this.paths.anchorPath(root), this.fs), new Graph(regions2))
    return {
      course: course.name,
      ops: spec.ops.length,
      snapshot: version,
      created_blocks: [...createdBlocks],
      renames,
      deleted: dels,
      ...(spec.note
        ? { operator: spec.note.operator, coach_reason: spec.note.reason, ...(spec.note.disagreement ? { disagreement: true } : {}) }
        : {}),
      ...(probationRegistered.length
        ? {
            probation_registered: probationRegistered,
            recheck: { metric: spec.note!.recheck!.metric, due: spec.note!.recheck!.days ?? RECHECK_DAYS_DEFAULT },
          }
        : {}),
      ...(compassRewritten ? { compass_rewritten: true } : {}),
      findings: applyFindings(audit, seedPhase),
    }
  }

  // ---- 建课（ADR-0076：名称即空图）----

  /** 名称建课（ADR-0076 §一：建课 = 名称即空图）：面板只收一个课程名，一个写入单元
   * 落全部脚手架——注册表条目（enabled）+ 课程根目录（data/课程/state）+
   * `data/00_未分区.yaml`（零节点区，空图的合法载体：GraphStore.load 正常读取）+
   * 空 `概念登记表.yaml`（concepts: []）+ `state/终点锚.json`（空锚，合法空态）+
   * `罗盘.md` 脚手架。**不自动初始化生成**：零节点图不入任何自动触发点（零节点闸），
   * 第一次生长由学习者显式下发或加终点触发。写序 = 脚手架在先、注册表条目在后：
   * 半途失败最多留孤儿目录（无注册表条目，建课可重试），不会留下不能加载的死课。 */
  async createCourse(name: string): Promise<CourseEntry> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('[create-course] 课程名不能为空。')
    const existing = await this.registry.get(trimmed)
    if (existing) throw new Error(`[create-course] 课程「${trimmed}」已在注册表——建课拒绝重名（课程名是注册表主键）。`)
    const items = await this.registry.load()
    const root = trimmed
    const store = new GraphStore(this.paths, this.paths.courseRoot(root), this.fs)
    const anchorPath = this.paths.anchorPath(root)
    const compassPath = this.paths.compassPath(root)
    const zeroRegion: GRegion = { name: '未分区', color: '', blocks: [] }
    const entry: CourseEntry = { id: `${root}-01`, name: trimmed, root, enabled: true }
    await runWriteUnit('createCourse', {
      course: trimmed,
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '课程脚手架（目录/零节点区/概念登记表/终点锚/罗盘）',
          run: async () => {
            for (const sub of ['data', '课程', 'state']) await this.fs.mkdir(`${this.centerRoot}/${root}/${sub}`)
            await store.writeRegionDoc(`${this.paths.dataDir(root)}/00_未分区.yaml`, zeroRegion)
            await this.concepts.save(root, [])
            await writeAnchors(anchorPath, [], this.fs)
            await atomicWrite(compassPath, compassScaffold(trimmed), this.fs)
          },
        },
        {
          name: '注册表条目',
          run: async () => {
            items.push(entry)
            await this.registry.save(items)
          },
        },
      ],
    })
    return entry
  }

  /** 添加终点（ADR-0076 §三：终点由学习者手动增删，立即写盘不等生成队列）：建一个
   * 零 pre 新节点（区/块 = 未分区）+ 落一条锚（可选一句目标描述给教练读；目标类型
   * 默认能力锚定、不露表单）。人手加终点不过资格判据（人是权威），但结构门照旧：
   * 课程必须已注册、图内不得重名（对已有正文/题库/调度/est 的节点名加终点一律拒）、
   * 锚集合不得重名。不提供改名、不提供「把已有节点设为终点」（撞纯标记红线）。 */
  async addEndpoint(courseName: string, endpointName: string, goalNote?: string): Promise<{ course: string; endpoint: string }> {
    const course = await this.registry.get(courseName.trim())
    if (!course) throw new Error(`[endpoint-add] 注册表中没有课程「${courseName.trim()}」——先建课（名称即空图）。`)
    const name = endpointName.trim()
    if (!name) throw new Error('[endpoint-add] 终点名不能为空。')
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root), this.fs)
    const regions = await store.load()
    const graph = new Graph(regions)
    if (graph.nset.has(name)) {
      throw new Error(`[endpoint-add] 图上已有节点「${name}」——不能把已有节点设为终点（撞纯标记红线：已有正文/题库/调度的节点不能被标成终点）；终点必须是新建的零 pre 节点。`)
    }
    const anchorPath = this.paths.anchorPath(root)
    const anchors = await readAnchors(anchorPath, this.fs)
    if (anchors.some(a => a.endpoint === name)) {
      throw new Error(`[endpoint-add] 终点「${name}」已有锚记录——一个终点只许一条锚。`)
    }
    const declared = todayStr(new Date(this.clock.nowMs()))
    const anchor: EndpointAnchor = {
      endpoint: name,
      ...(goalNote && goalNote.trim() ? { goal_note: goalNote.trim() } : {}),
      goal_type: 'capability',
      declared,
      worksheet: [],
      seed_nodes: [],
      start_basis: {},
    }
    await runWriteUnit('addEndpoint', {
      course: course.name,
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '终点节点落图（未分区，零 pre）',
          run: async () => {
            const regionName = '未分区'
            const files = await store.regionFiles()
            const path = files[regionName]
            if (path) {
              const current = loadRegionDoc(YAML.parse(await this.fs.readFile(path)), path)
              let block = current.blocks.find(b => b.name === regionName)
              if (!block) {
                block = { name: regionName, nodes: [] }
                current.blocks.push(block)
              }
              block.nodes.push({ name, pre: [], opt: false, note: '', enc: [] })
              await store.writeRegionDoc(path, current)
            } else {
              const idx = Object.keys(files).length
              const region: GRegion = { name: regionName, color: '', blocks: [{ name: regionName, nodes: [{ name, pre: [], opt: false, note: '', enc: [] }] }] }
              await store.writeRegionDoc(`${this.paths.dataDir(root)}/${String(idx).padStart(2, '0')}_${regionName}.yaml`, region)
            }
          },
        },
        {
          name: '终点锚落盘',
          run: async () => {
            await writeAnchors(anchorPath, [...anchors, anchor], this.fs)
          },
        },
      ],
    })
    return { course: course.name, endpoint: name }
  }

  /** 删除终点（ADR-0076 §三）：锚记录与节点一并移除，已铺的台阶留在图上成为末端——
   * 全图摘掉指向该终点的 pre 边（终点消失后引用悬空即断边），其余节点不动。已铺台阶
   * 的正文/题库/调度全保留。UI 确认一次（已铺出来的台阶会留在图上）。 */
  async removeEndpoint(courseName: string, endpointName: string): Promise<{ course: string; endpoint: string; unhooked: string[] }> {
    const course = await this.registry.get(courseName.trim())
    if (!course) throw new Error(`[endpoint-remove] 注册表中没有课程「${courseName.trim()}」。`)
    const name = endpointName.trim()
    if (!name) throw new Error('[endpoint-remove] 终点名不能为空。')
    const root = course.root
    const anchorPath = this.paths.anchorPath(root)
    const anchors = await readAnchors(anchorPath, this.fs)
    if (!anchors.some(a => a.endpoint === name)) {
      throw new Error(`[endpoint-remove] 「${name}」不是课程「${course.name}」的终点（锚集合里没有它）。`)
    }
    const store = new GraphStore(this.paths, this.paths.courseRoot(root), this.fs)
    const regions = await store.load()
    // 内存侧先算好各区重写文本（摘终点节点 + 全图摘指向它的 pre 边；台阶留在图上成为末端）
    const unhooked: string[] = []
    const touched = new Map<string, string>()
    for (const region of regions) {
      let dirty = false
      for (const b of region.blocks) {
        const kept = b.nodes.filter(n => {
          if (n.name === name) { dirty = true; return false }
          return true
        })
        for (const n of kept) {
          if (n.pre.includes(name)) {
            n.pre = n.pre.filter(p => p !== name)
            unhooked.push(n.name)
            dirty = true
          }
        }
        b.nodes = kept
      }
      if (dirty) touched.set(region.name, YAML.stringify(store.regionDoc(region)))
    }
    const anchorsNext = anchors.filter(a => a.endpoint !== name)
    await runWriteUnit('removeEndpoint', {
      course: course.name,
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '图区重写（摘终点节点与指向它的 pre 边）',
          run: async () => {
            const files = await store.regionFiles()
            for (const [regionName, text] of touched) {
              const abs = files[regionName]
              if (!abs) throw new Error(`[endpoint-remove] 区「${regionName}」没有对应 data/*.yaml。`)
              await atomicWrite(abs, text, this.fs)
            }
          },
        },
        {
          name: '锚记录移除',
          run: async () => {
            await writeAnchors(anchorPath, anchorsNext, this.fs)
          },
        },
      ],
    })
    return { course: course.name, endpoint: name, unhooked: [...new Set(unhooked)] }
  }

  /** graph propose-enrich（富化覆盖层，#140）：schema 门 → 目标节点在图核验 →
   * 受影响正典文件计 sha256 指纹（写入 artifact，apply 时复核）→ pending。 */
  async proposeEnrich(yamlText: string): Promise<GraphEnrichProposalResult> {
    const v = validateEnrichProposal(YAML.parseModel(yamlText))
    if (v.errors) throw new Error(`[propose-enrich] schema 校验失败，提案未受理。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[propose-enrich] 注册表中没有课程「${spec.course}」。`)
    const store = new GraphStore(this.paths, this.paths.courseRoot(course.root), this.fs)
    const regions = await store.load()
    const graph = new Graph(regions)
    const missing = enrichMissingTargets(spec.fields, graph)
    if (missing.length) {
      throw new Error(`[propose-enrich] 目标节点不在图内，提案未受理：${missing.join('、')}（覆盖层只补写既有节点；新增节点走 kind=edit）`)
    }
    const regionFiles = await store.regionFiles()
    const fingerprints: Record<string, string> = {}
    for (const f of spec.fields) {
      const regionName = graph.blockOf[f.node][1]
      const abs = regionFiles[regionName]
      if (!abs) throw new Error(`[propose-enrich] 区「${regionName}」没有对应 data/*.yaml（图加载不一致）。`)
      const rel = `data/${abs.replace(/[/\\]/g, '/').split('/').pop()}`
      if (!(rel in fingerprints)) fingerprints[rel] = sha256(await this.fs.readFile(abs))
    }
    const { pid } = await this.saveArtifact('enrich', spec.course, {
      course: spec.course,
      reason: spec.reason,
      fields: spec.fields,
      fingerprints,
    })
    await this.store.updateProposal(pid, { summary: `覆盖层回填 ${spec.fields.length} 个节点（enc）` })
    return { id: pid, kind: 'enrich', course: spec.course, fields: spec.fields.length, files: Object.keys(fingerprints).length }
  }

  /** graph apply-enrich：指纹复核 → 写正典（enc 整体替换）→ 覆盖层留痕 → journal + 快照。 */
  async applyEnrich(pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }): Promise<GraphApplyEnrichResult> {
    if (!audit.ok) throw new Error('[apply-enrich] 审计存在 ERROR，拒绝写入——先处理 审计报告.md。')
    const prop = await this.store.takePending('enrich', pid)
    const v = validateEnrichProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[apply-enrich] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec
    if (!spec.fingerprints || !Object.keys(spec.fingerprints).length) {
      throw new Error('[apply-enrich] 提案缺内容指纹（fingerprints 由引擎 propose-enrich 受理时写入；手工构造的提案不受理，重新生成）。')
    }
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[apply-enrich] 注册表中没有课程「${spec.course}」。`)
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root), this.fs)
    // 指纹复核先行：任一受影响正典文件在受理后被改过 → 提案基于旧版图，拒收（AC：指纹不符拒收）
    const stale: string[] = []
    for (const [rel, want] of Object.entries(spec.fingerprints)) {
      let cur: string
      try {
        cur = await this.fs.readFile(`${this.paths.courseRoot(root)}/${rel}`)
      } catch {
        stale.push(`${rel}（文件不存在）`)
        continue
      }
      if (sha256(cur) !== want) stale.push(rel)
    }
    if (stale.length) {
      throw new Error(`[apply-enrich] 正典文件在提案受理后被修改，sha256 指纹不符，拒绝写入：${stale.join('、')}`
        + `——reject 本提案后重新生成富化提案（提案必须基于当前正典）。`)
    }
    const regions = await store.load()
    const graph = new Graph(regions)
    const missing = enrichMissingTargets(spec.fields, graph)
    if (missing.length) throw new Error(`[apply-enrich] 目标节点已不在图内：${missing.join('、')}。`)
    // 内存侧先算好各区重写文本（不是落盘动作；落盘步骤见下方写入单元声明）
    const touched = new Map<string, string>() // 区名 → 重写后的文件文本（算指纹用）
    for (const f of spec.fields) {
      const regionName = graph.blockOf[f.node][1]
      const region = regions.find(r => r.name === regionName)
      if (!region) throw new Error(`[apply-enrich] 区「${regionName}」在图中不存在。`)
      for (const b of region.blocks) {
        const n = b.nodes.find(x => x.name === f.node)
        if (n) n.enc = f.enc.map(e => ({ ...e }))
      }
      touched.set(regionName, YAML.stringify(store.regionDoc(region)))
    }
    const regionFiles = await store.regionFiles()
    const fileHashes = new Map<string, string>()
    // 写入单元（#176）：写序照今天的声明——受影响区正典重写 → 覆盖层留痕 → 快照 →
    // journal(graph_enrich) → 提案 applied（覆盖层/快照只在全部正典写成功后）。
    // 指纹复核（上方）就是防重放门：部分 apply 后重放必被拒收。失败上抛中止，
    // 不回滚不续跑，失败不写 journal；恢复 = reject 后基于新正典重提。
    let version = 0
    await runWriteUnit('applyEnrich', {
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '受影响区正典重写',
          run: async () => {
            for (const [regionName, text] of touched) {
              const abs = regionFiles[regionName]
              if (!abs) throw new Error(`[apply-enrich] 区「${regionName}」没有对应 data/*.yaml。`)
              await atomicWrite(abs, text, this.fs)
              fileHashes.set(regionName, sha256(text))
            }
          },
        },
        {
          name: '覆盖层留痕',
          run: async () => {
            // state/覆盖层.jsonl，追加只增；读侧只读正典，这里只是审计与出处
            const now = new Date(this.clock.nowMs()).toISOString()
            const lines = spec.fields.map(f => JSON.stringify({
              target: f.node,
              field: 'enc',
              value: f.enc,
              content_hash: fileHashes.get(graph.blockOf[f.node][1]),
              applied_at: now,
            }))
            await this.fs.mkdir(this.paths.courseStateDir(root))
            await this.fs.appendFile(this.paths.overlayPath(root), lines.join('\n') + '\n')
          },
        },
        {
          name: '快照',
          run: async () => {
            const regions2 = await store.load()
            version = (await this.store.latestSnapshotVersion(course.name)) + 1
            await this.store.saveSnapshot(course.name, version, snapshotDoc(store, regions2))
          },
        },
        {
          name: '操作 journal',
          run: async () => {
            await this.store.appendJournal({
              course: course.name, node: '*', rating: null, kind: 'graph_enrich', elapsed_days: 0,
              session: String(prop.id), detail: spec.fields.map(f => `enc(${f.node})×${f.enc.length}`).join('；'),
            })
          },
        },
        {
          name: '提案 applied',
          run: async () => {
            await this.store.updateProposal(prop.id, { status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(), decision_note: `快照 v${version}` })
          },
        },
      ],
    })
    return {
      course: course.name,
      fields: spec.fields.length,
      snapshot: version,
      files: [...touched.keys()],
      findings: applyFindings(audit),
    }
  }

  // ---- 概念层治理回路（#265 / 父 #260）：合并提案 + 混淆对候选提案 ----

  /** 合并提案（#265 两段式第一段）：**一个字都不落盘**——登记表在 apply（人确认）之前
   * 保持原样。受理门：课程在册、from/into 都是登记表在册名字（canonical/别名精确匹配）
   * 且属**不同**条目——与 concept-merge 的旧直写门同一判据，只是延后到确认后执行。
   * 提案面显式带不可逆声明（CONCEPT_MERGE_IRREVERSIBLE）：合并只并入、不拆分。 */
  async proposeConceptMerge(
    courseKey: string, from: string, into: string, reason?: string,
  ): Promise<{ id: number; kind: 'concept_merge'; course: string; from: string; into: string; names: string[]; irreversible: true; warns: string[] }> {
    const course = await this.registry.get(courseKey.trim())
    if (!course) throw new Error(`[concept-merge-propose] 注册表中没有课程「${courseKey.trim()}」。`)
    const entries = await this.concepts.load(course.root)
    const gate = mergeConceptEntries(entries, from.trim(), into.trim())
    if (gate.errors.length) {
      throw new Error(`[concept-merge-propose] 合并提案未受理。\n${gate.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const src = resolveConcept(entries, from.trim())!
    const dst = resolveConcept(entries, into.trim())!
    const summary = `合并提案（不可逆：只并入、不拆分）：概念「${src.canonical}」并入「${dst.canonical}」`
      + `${reason?.trim() ? `｜理由：${reason.trim()}` : ''}｜等待人确认——未确认不落盘`
    const { pid } = await this.saveArtifact('concept_merge', course.name, {
      course: course.name, from: src.canonical, into: dst.canonical,
      ...(reason?.trim() ? { reason: reason.trim() } : {}), irreversible: true,
      irreversible_note: CONCEPT_MERGE_IRREVERSIBLE,
    })
    await this.store.updateProposal(pid, { summary })
    const mergedDst = resolveConcept(gate.entries, dst.canonical)!
    return {
      id: pid, kind: 'concept_merge', course: course.name,
      from: src.canonical, into: dst.canonical,
      names: [mergedDst.canonical, ...(mergedDst.aliases ?? [])],
      irreversible: true,
      warns: conceptMagnitudeWarnings(gate.entries),
    }
  }

  /** 已在待审队列的合并对键集（#274 派生器防重复登记的对照面）：按**产物结构**比对
   * （from/into 归一 canonical 的无序对键），不靠 summary 文本——与 confusable 候选
   * 去重同一纪律（摘要拿去当身份键会在措辞变化下静默失效）。 */
  async pendingConceptMergePairKeys(): Promise<Set<string>> {
    const out = new Set<string>()
    for (const p of await this.store.loadProposals()) {
      if (p.kind !== 'concept_merge' || p.status !== 'pending') continue
      const spec = validateConceptMergeProposal(await this.loadArtifact(p.artifact)).spec
      if (spec) out.add(conceptPairKey(spec.from, spec.into))
    }
    return out
  }

  /** 合并确认（#265 两段式第二段，**人的动作**：面板 /proposals/apply 触发）：产物复验
   * （形态 + 在册双门，受理后登记表可能被手改/并入）→ 并入落盘 → journal。不可逆语义
   * 在提案面已声明；这里只执行。 */
  async applyConceptMerge(pid?: number): Promise<{ kind: 'concept_merge'; course: string; from: string; into: string; names: string[] }> {
    const prop = await this.store.takePending('concept_merge', pid)
    const v = validateConceptMergeProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[concept-merge-apply] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const course = await this.registry.get(v.spec.course)
    if (!course) throw new Error(`[concept-merge-apply] 注册表中没有课程「${v.spec.course}」。`)
    const root = course.root
    const entries = await this.concepts.load(root)
    const merged = mergeConceptEntries(entries, v.spec.from, v.spec.into)
    if (merged.errors.length) {
      throw new Error(`[concept-merge-apply] 合并未执行（登记表保持原样——受理后登记表已变，reject 本提案重提）。\n${merged.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const src = resolveConcept(entries, v.spec.from)!
    await this.concepts.save(root, merged.entries)
    const dst = resolveConcept(merged.entries, v.spec.into)!
    const names = [dst.canonical, ...(dst.aliases ?? [])]
    await this.store.appendJournal({
      course: course.name, node: '*', rating: null, kind: 'concept_merge', elapsed_days: 0,
      session: String(prop.id),
      detail: `概念「${src.canonical}」并入「${dst.canonical}」（名字并集：${names.join('、')}；提案 #${prop.id} 人确认）`,
    })
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(),
      decision_note: `并入「${dst.canonical}」（名字 ${names.length} 个）`,
    })
    return { kind: 'concept_merge', course: course.name, from: src.canonical, into: dst.canonical, names }
  }

  /** 混淆对候选提案（#265）：一条候选一条提案（人审一次一条），**不自动入册**。受理门：
   * 课程在册、两端都是登记表在册**活跃**条目（废弃条目退出候选面，ADR-0084 ②）、
   * 尚未声明过（幂等——重复派生不再堆提案）。共现证据随产物落盘，人审可查。 */
  async proposeConfusableCandidate(
    courseKey: string, pair: { a: string; b: string; evidence: string[] }, reason?: string,
  ): Promise<{ id: number; kind: 'confusable_pair'; course: string; a: string; b: string; weight: number }> {
    const course = await this.registry.get(courseKey.trim())
    if (!course) throw new Error(`[concept-confusable-propose] 注册表中没有课程「${courseKey.trim()}」。`)
    const entries = await this.concepts.load(course.root)
    const ea = resolveConcept(entries, pair.a)
    const eb = resolveConcept(entries, pair.b)
    if (!ea || !eb) {
      throw new Error(`[concept-confusable-propose] 候选（「${pair.a}」↔「${pair.b}」）有名字不在登记表在册——候选只从在册概念派生。`)
    }
    if (isDeprecated(ea) || isDeprecated(eb)) {
      throw new Error(`[concept-confusable-propose] 候选（「${ea.canonical}」↔「${eb.canonical}」）含废弃条目——废弃条目退出候选面（ADR-0084 ②）。`)
    }
    if (ea.canonical === eb.canonical) {
      throw new Error(`[concept-confusable-propose] 候选两端是同一个条目「${ea.canonical}」——易混对需要两个不同条目。`)
    }
    if (!pair.evidence.length) throw new Error('[concept-confusable-propose] 候选没有共现证据——候选必须有来源可查。')
    const declared = addConfusablePair(entries, ea.canonical, eb.canonical)
    if (declared.errors.length) throw new Error(`[concept-confusable-propose] ${declared.errors.join('；')}`)
    if (!declared.changed) {
      throw new Error(`[concept-confusable-propose] 「${ea.canonical}」↔「${eb.canonical}」已在登记表声明过（任一方向）——不必重复提名。`)
    }
    const pending = await this.store.loadProposals()
    // pending 去重按**产物结构**比对（解析出的 a/b 无序对相等），不靠 summary 文本——
    // 摘要是展示面，拿它当身份键会在措辞变化下静默失效
    const dupKey = conceptPairKey(ea.canonical, eb.canonical)
    for (const p of pending) {
      if (p.kind !== 'confusable_pair' || p.status !== 'pending') continue
      let spec: ConfusableCandidateProposalSpec | undefined
      try {
        spec = validateConfusableCandidateProposal(await this.loadArtifact(p.artifact)).spec
      } catch {
        continue // 产物缺失/损坏的旧提案不参与比对（它自己 apply 时会 fail loud）
      }
      if (spec && conceptPairKey(spec.a, spec.b) === dupKey) {
        return { id: p.id, kind: 'confusable_pair', course: course.name, a: ea.canonical, b: eb.canonical, weight: pair.evidence.length }
      }
    }
    const { pid } = await this.saveArtifact('confusable_pair', course.name, {
      course: course.name, a: ea.canonical, b: eb.canonical, evidence: pair.evidence,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    })
    await this.store.updateProposal(pid, {
      summary: `混淆对候选：概念「${ea.canonical}」→「${eb.canonical}」（共现证据 ${pair.evidence.length} 条）｜证据：${pair.evidence[0]}${pair.evidence.length > 1 ? ` 等 ${pair.evidence.length} 条` : ''}｜人审接受后才入册`,
    })
    return { id: pid, kind: 'confusable_pair', course: course.name, a: ea.canonical, b: eb.canonical, weight: pair.evidence.length }
  }

  /** 混淆对候选确认（#265，人的动作）：产物复验 + 两端仍在册活跃 + 尚未声明 → 只写
   * a→b 一个方向入册（单向合法、是待复核态，ADR-0084 ③；写入侧不自动补双向）。 */
  async applyConfusableCandidate(pid?: number): Promise<{ kind: 'confusable_pair'; course: string; a: string; b: string; changed: boolean }> {
    const prop = await this.store.takePending('confusable_pair', pid)
    const v = validateConfusableCandidateProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[concept-confusable-apply] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const course = await this.registry.get(v.spec.course)
    if (!course) throw new Error(`[concept-confusable-apply] 注册表中没有课程「${v.spec.course}」。`)
    const root = course.root
    const entries = await this.concepts.load(root)
    const ea = resolveConcept(entries, v.spec.a)
    const eb = resolveConcept(entries, v.spec.b)
    if (!ea || !eb) throw new Error(`[concept-confusable-apply] 候选两端（「${v.spec.a}」「${v.spec.b}」）已不在登记表在册——reject 本提案重提。`)
    if (isDeprecated(ea) || isDeprecated(eb)) {
      throw new Error(`[concept-confusable-apply] 「${ea.canonical}」↔「${eb.canonical}」含废弃条目——废弃条目退出候选面。`)
    }
    const r = await this.concepts.addConfusable(root, ea.canonical, eb.canonical)
    await this.store.appendJournal({
      course: course.name, node: '*', rating: null, kind: 'concept_confusable', elapsed_days: 0,
      session: String(prop.id),
      detail: `易混对入册「${r.a}」→「${r.b}」${r.changed ? '' : '（已声明，幂等）'}（候选提案 #${prop.id} 人确认；单向是待复核态，ADR-0084 ③）`,
    })
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(),
      decision_note: `易混对「${r.a}」→「${r.b}」入册`,
    })
    return { kind: 'confusable_pair', course: course.name, a: r.a, b: r.b, changed: r.changed }
  }

  /** 改名联动课程笔记：搬文件 + 更新 fm.node + 题库随迁；无笔记静默跳过。 */
  private async relocateNote(root: string, graph: Graph, node: string, newName?: string): Promise<void> {
    if (!graph.blockOf[node]) return
    const oldPath = this.paths.courseNotePath(root, node)
    const targetName = newName ?? node
    if (this.fs.exists(oldPath)) {
      const { loadNote, saveNote } = await import('./notes.ts')
      const { fm, body } = await loadNote(oldPath, this.fs)
      const newPath = this.paths.courseNotePath(root, targetName)
      await saveNote(newPath, { ...(fm ?? {}), node: targetName }, body, this.fs)
      if (oldPath.toLowerCase() !== newPath.toLowerCase()) {
        // 新内容（fm.node=新名）已写入 newPath；摘除旧文件。
        // 不能 rename(oldPath, newPath)——会把旧 frontmatter 覆盖回新路径。
        await this.fs.unlink(oldPath).catch(async () => {
          await this.fs.writeFile(oldPath, '').catch(() => undefined)
        })
      }
    }
    // 题库随迁（改名时；无题库静默跳过）
    if (newName) {
      const { safeFilename } = await import('./paths.ts')
      const bankDir = this.paths.courseRoot(root)
      const oldBank = `${bankDir}/题库/${safeFilename(node)}.yaml`
      if (this.fs.exists(oldBank)) {
        await this.fs.rename(oldBank, `${bankDir}/题库/${safeFilename(targetName)}.yaml`).catch(() => undefined)
      }
    }
  }

  /** del_node：课程笔记与题库移入 state/archive（不丢用户内容）。 */
  private async archiveNote(root: string, graph: Graph, node: string, pid: number): Promise<void> {
    if (!graph.blockOf[node]) return
    const oldPath = this.paths.courseNotePath(root, node)
    const archiveDir = `${this.paths.courseStateDir(root)}/archive`
    const { safeFilename } = await import('./paths.ts')
    if (this.fs.exists(oldPath)) {
      await this.fs.mkdir(archiveDir)
      await this.fs.rename(oldPath, `${archiveDir}/del-${pid}-${safeFilename(node)}.md`)
    }
    const oldBank = `${this.paths.courseRoot(root)}/题库/${safeFilename(node)}.yaml`
    if (this.fs.exists(oldBank)) {
      await this.fs.mkdir(archiveDir)
      await this.fs.rename(oldBank, `${archiveDir}/del-${pid}-${safeFilename(node)}.yaml`)
    }
  }

  /** graph reject（全留痕：pending → rejected，决策理由随行）。 */
  async reject(pid: number, note = ''): Promise<ProposalRec> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`[reject] 提案 id 必须是正整数（收到 ${String(pid)}）；拒绝不能省略 id。`)
    }
    const list = await this.store.loadProposals()
    const prop = list.find(p => p.id === pid)
    if (!prop || prop.status !== 'pending') throw new Error(`[reject] 提案 #${pid} 不存在或已决。`)
    await this.store.updateProposal(pid, { status: 'rejected', decided: new Date(this.clock.nowMs()).toISOString(), decision_note: note })
    return prop
  }

  /** 提案清单（status/kind 过滤可选）。kind 全集见 types PROPOSAL_KINDS（图谱域 + 项目域）。 */
  async list(status?: string, kind?: string, limit = 100): Promise<ProposalRec[]> {
    let list = await this.store.loadProposals()
    if (status) {
      if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`[proposals] 非法 status: ${status}（允许 ${PROPOSAL_STATUSES.join('/')}）`)
      }
      list = list.filter(p => p.status === status)
    }
    if (kind) {
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`[proposals] 非法 kind: ${kind}（允许 ${PROPOSAL_KINDS.join('/')}）`)
      }
      list = list.filter(p => p.kind === kind)
    }
    return list.slice(-limit).reverse()
  }
}

/** add_node op → GNode（模拟与实落共用一个构造；概念字段组随 op 携带，键名统一后取 name）。 */
function nodeFromAddOp(op: EditOp): GNode {
  return {
    name: op.name!,
    pre: [...(op.pre ?? [])],
    opt: Boolean(op.opt),
    note: op.note ?? '',
    ...(op.enc !== undefined ? { enc: normalizeOpEnc(op.enc) } : { enc: [] }),
    ...(op.est !== undefined ? { est: op.est } : {}),
    ...(op.type ? { type: op.type } : {}),
    ...(op.bloom ? { bloom: op.bloom as BloomLevel } : {}),
    ...(op.difficulty !== undefined ? { difficulty: op.difficulty as GNode['difficulty'] } : {}),
    ...(op.teaches ? { teaches: { ...op.teaches } } : {}),
    ...(op.assumes ? { assumes: { ...op.assumes } } : {}),
    ...(op.misconceptions?.length ? { misconceptions: op.misconceptions.map(m => ({ ...m })) } : {}),
  }
}

/** 草稿差异（Draft Diff，#271 / ADR-0088）：生长草稿相对其基图的结构增量读数——只读、
 * 零落盘，供草稿期实时看图与审计（UI 消费归 #269 候选，本票只保证可导出）。 */
export interface DraftDiff {
  added_nodes: string[]
  removed_nodes: string[]
  renamed: Array<{ from: string; to: string }>
  /** 新增的 pre 边（rewired 节点里「after 有 before 无」的逐条展开）。 */
  added_edges: Array<{ node: string; pre: string }>
  /** set_pre 整体替换的接线改写（before/after 都给——替换语义下删除也可见）。 */
  rewired: Array<{ node: string; pres_before: string[]; pres_after: string[] }>
}

export interface DraftReplay { errors: string[]; diff: DraftDiff }

/** 草稿内核的重放（#271 / ADR-0088）：与 simulateOps 同一套结构重放，额外折出 DraftDiff
 * ——草稿校验与门校验同源（simulateOps 内部改调本函数，两处不各写一遍）。 */
export function replayDraft(regions: GRegion[], graph: Graph, ops: EditOp[]): DraftReplay {
  const sim: GRegion[] = JSON.parse(JSON.stringify(regions))
  const errors: string[] = []
  const names = new Set(graph.names)
  const renameMap: Record<string, string> = {}
  const removed = new Set<string>()
  const added: string[] = []
  const rewired: Array<{ node: string; pres_before: string[]; pres_after: string[] }> = []

  for (const op of ops) {
    if (op.op === 'add_node') {
      if (names.has(op.name!)) { errors.push(`add_node 重名: ${op.name}`); continue }
      // 无坐标（#275）：落到图内既有的单一区（首个区）；区内无块时以区名建块。
      const r = sim[0]
      if (!r) { errors.push('add_node 无可落区（图内无区）'); continue }
      let blk = r.blocks[0]
      if (!blk) {
        blk = { name: r.name, nodes: [] }
        r.blocks.push(blk)
      }
      blk.nodes.push(nodeFromAddOp(op))
      names.add(op.name!)
      added.push(op.name!)
    } else if (op.op === 'del_node') {
      if (!names.has(op.node!)) { errors.push(`del_node 节点不存在: ${op.node}`); continue }
      names.delete(op.node!)
      removed.add(op.node!)
    } else if (op.op === 'rename') {
      if (!names.has(op.node!)) errors.push(`rename 旧名不存在: ${op.node}`)
      else if (names.has(op.new!)) errors.push(`rename 新名已占用: ${op.new}`)
      else {
        renameMap[op.node!] = op.new!
        names.delete(op.node!)
        names.add(op.new!)
      }
    } else if (op.op === 'set_pre') {
      if (!names.has(op.node!)) { errors.push(`set_pre 节点不存在: ${op.node}`); continue }
      rewired.push({ node: op.node!, pres_before: [...(graph.preOf[op.node!] ?? [])], pres_after: [...(op.pre ?? [])] })
      for (const r of sim) for (const b of r.blocks) for (const n of b.nodes) {
        if (n.name === op.node) n.pre = [...(op.pre ?? [])]
      }
    } else if (op.op === 'set_enc') {
      if (!names.has(op.node!)) { errors.push(`set_enc 节点不存在: ${op.node}`); continue }
      for (const r of sim) for (const b of r.blocks) for (const n of b.nodes) {
        if (n.name === op.node) n.enc = normalizeOpEnc(op.enc)
      }
    }
  }

  const mapped = (p: string) => renameMap[p] ?? p
  for (const r of sim) {
    for (const b of r.blocks) {
      for (const n of b.nodes) {
        if (removed.has(n.name)) continue
        n.name = mapped(n.name)
        n.pre = n.pre.map(mapped).filter(p => !removed.has(p))
        n.enc = n.enc.map(e => ({ ...e, node: mapped(e.node) })).filter(e => !removed.has(e.node))
      }
      b.nodes = b.nodes.filter(n => !removed.has(n.name))
    }
  }
  if (!errors.length) {
    const merged = new Graph(sim)
    const dangling = new Set(merged.names.flatMap(n => merged.preOf[n].filter(p => !merged.nset.has(p)).map(p => `${n} -> ${p}`)))
    for (const d of [...dangling].sort()) errors.push(`变更后断边: ${d}`)
    const encDangling = new Set(merged.names.flatMap(n => (merged.encOf[n] ?? []).filter(([p]) => !merged.nset.has(p)).map(([p]) => `${n} ~enc~ ${p}`)))
    for (const d of [...encDangling].sort()) errors.push(`变更后 enc 断边: ${d}`)
    if (merged.hasCycle) errors.push(`变更后引入环：${merged.cycleNodes.slice(0, 5).join('、')}`)
    errors.push(...misconceptionCapErrors(sim))
  }
  const diff: DraftDiff = {
    added_nodes: added,
    removed_nodes: [...removed],
    renamed: Object.entries(renameMap).map(([from, to]) => ({ from, to })),
    added_edges: rewired.flatMap(w =>
      w.pres_after.map(mapped).filter(p => !removed.has(p) && !w.pres_before.includes(p)).map(p => ({ node: mapped(w.node), pre: p }))),
    rewired: rewired.map(w => ({ node: mapped(w.node), pres_before: w.pres_before.map(mapped).filter(p => !removed.has(p)), pres_after: w.pres_after.map(mapped).filter(p => !removed.has(p)) })),
  }
  return { errors, diff }
}

/** 在 regions 副本上模拟全部操作 → 错误列表（内部改调 replayDraft——草稿与门同源，ADR-0088）。 */
export function simulateOps(regions: GRegion[], graph: Graph, ops: EditOp[]): string[] {
  return replayDraft(regions, graph, ops).errors
}

/** 把 op 列表实际落到 Region 对象列表。 */
export function applyOpsToRegions(regions: GRegion[], ops: EditOp[]): void {
  const renameMap: Record<string, string> = {}
  const removed = new Set<string>()
  const findNode = (node: string): { r: GRegion; b: GBlock; n: GNode } | null => {
    for (const r of regions) for (const b of r.blocks) {
      const n = b.nodes.find(x => x.name === node)
      if (n) return { r, b, n }
    }
    return null
  }

  for (const op of ops) {
    if (op.op === 'add_node') {
      // 无坐标（#275）：落到图内既有的单一区（首个区）；区内无块时以区名建块。
      const r = regions[0]!
      let blk = r.blocks[0]
      if (!blk) {
        blk = { name: r.name, nodes: [] }
        r.blocks.push(blk)
      }
      blk.nodes.push(nodeFromAddOp(op))
    } else if (op.op === 'del_node') {
      removed.add(op.node!)
    } else if (op.op === 'rename') {
      renameMap[op.node!] = op.new!
    } else if (op.op === 'set_pre') {
      const hit = findNode(op.node!)
      if (hit) hit.n.pre = [...(op.pre ?? [])]
    } else if (op.op === 'set_enc') {
      const hit = findNode(op.node!)
      if (hit) hit.n.enc = normalizeOpEnc(op.enc)
    } else if (op.op === 'set_note') {
      const hit = findNode(op.node!)
      if (hit) hit.n.note = op.note ?? ''
    }
  }

  const mapped = (p: string) => renameMap[p] ?? p
  for (const r of regions) {
    for (const b of r.blocks) {
      for (const n of b.nodes) {
        n.name = mapped(n.name)
        n.pre = n.pre.map(mapped).filter(p => !removed.has(p))
        n.enc = n.enc.map(e => ({ ...e, node: mapped(e.node) })).filter(e => !removed.has(e.node))
      }
      b.nodes = b.nodes.filter(n => !removed.has(n.name))
    }
    r.blocks = r.blocks.filter(b => b.nodes.length)
  }
}

// ---- 图提案受理结果（#152 刀 5 自 views.ts 归位）----







