/**
 * agent 产出（图/变更）的门禁与落盘 + 提案生命周期。
 *
 * 流程铁律：agent 产出 YAML → schema 校验 → 结构检查（断边/环/冲突）→
 * 提案落盘 pending（产物文件全留痕）→ 人审 → apply 过 audit 门禁生效 → journal + 快照。
 * 拒绝同样留痕（status=rejected）。
 */
import type { VaultFs } from '../infra/io.ts'
import { createHash } from 'node:crypto'
import { YAML } from '../infra/yaml.ts'
import { Store } from '../store.ts'
import { atomicWrite } from '../infra/io.ts'
import { runWriteUnit } from '../infra/write-unit.ts'
import { Graph, GraphStore, parseConceptFields, parseEnc, misconceptionCapErrorsOfCounts, snapshotDoc } from '../graph/graph.ts'
import { ConceptRegistry, addConfusablePair, applyConceptMints, conceptMagnitudeWarnings, conceptPairKey, conceptReferenceErrors, isDeprecated, mergeConceptEntries, mintConflicts, namesOf, nearNameCandidates, nearNameWarnings, resolveConcept, validateConceptEntry } from '../concepts/concepts.ts'
import { CONCEPT_MERGE_IRREVERSIBLE, validateConceptMergeProposal, validateConfusableCandidateProposal } from '../concepts/concepts.ts'
import type { ConceptEntry, ConceptRef, ConfusableCandidateProposalSpec } from '../concepts/concepts.ts'
import { saveNote, defaultFrontmatter } from '../vault/notes.ts'
import { endpointNames, readAnchors, writeAnchors, isSeedGraph, structureReadingsOf } from './seed.ts'
import type { EndpointAnchor } from './seed.ts'
import type { Fm } from '../types.ts'
import {
  SECTION_ROUTE, compassScaffold, withSectionText, hasPaintedRoute, parseCompass, sectionBody, withRepaintMarker,
} from './compass.ts'
import { todayStr } from '../infra/dates.ts'
import type { Clock } from '../infra/clock.ts'
import type { Logger } from '../infra/logger.ts'
import { noopLogger } from '../infra/logger.ts'
import { appendProbationEntry, recheckPreregOf } from './probation.ts'
import type { RecheckPrereg } from './probation.ts'
import { RECHECK_DAYS_DEFAULT } from '../infra/params.ts'
import type { GNode, BloomLevel, EncEdge, ConceptTier, Misconception, GrowthOperator } from '../types.ts'
import { BLOOM_LEVELS, PROPOSAL_KINDS, PROPOSAL_STATUSES, GROWTH_OPERATORS } from '../types.ts'
import type { Paths } from '../infra/paths.ts'
import type { CourseEntry, ProposalKind, ProposalRec } from '../types.ts'
import type { GraphEditProposalResult, GraphEnrichProposalResult } from '../views/proposals.ts'
import type { GraphApplyEditResult, GraphApplyEnrichResult } from '../views/graph.ts'

/** apply 门禁的审计快照（facade 层跑 audit 后传入；findings 由 warns + 健康分组成）。
 * `errors`（#313 B5）= 审计 ERROR 明细：此前只写进 `课程根/审计报告.md`，而 apply 的抛错
 * 只说「先处理 审计报告.md」——草稿会话的模型只有读图工具、读不到文件，只能烧轮次。
 * 明细随错随行后，模型在拒收当场就看到死因（同一批 ERROR 也在 propose/草稿门序列里
 * 以 auditGate 提前报出）。 */
export interface ApplyAudit { ok: boolean; warns: string[]; health: number; errors?: string[] }

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
  /** 生长算子（#327 逐条目化：add_node 出生层）——这一条以什么方式长（新增/插入）。生长批
   * （note 在场）的每条 add_node 必带，批内可跨算子混合；其他 op 与普通提案（note 缺席）
   * 携带即拒收。接线义务（新增）、收束门（consolidate）、插入调速与复诊结算（插入）都按
   * 本字段的**逐条目**取值裁——算子不再携带方向语义，方向归 note.target_endpoints。 */
  operator?: GrowthOperator
  /** 收束声明（#335 刀①：巩固从算子值收编为新增条目的专用字段）——consolidate: true 的
   * 新增条目是综合收束：概念引用只许引已教概念、不产新概念（收束门裁）；只随新增条目携带。 */
  consolidate?: true
  /** 复诊预注册（#327 随条目走：只随 operator=插入 的 add_node 携带，恰一枚可机判
   * metric + 复诊期缺省 10 学习日 clamp [5,20]）——apply 随写入单元按条目登记边实验
   * 账本（复诊账本本就逐边，批级一枚是旧简化）。 */
  recheck?: RecheckPrereg
}

/** 生长批 note 区（#145 裁决产物面）：理由 + 朝向 + 分歧声明（可选）。生长批仍是
 * kind=edit 提案（不新增提案 kind）；note 在场即生长批——ops 允许为空（裁决=暂不产
 * 结构，留痕照走写入单元）。#327 起**算子是逐条目属性**（原「一批恰用一个算子」的
 * 批级 note.operator 退役）：每条 add_node 以 op.operator 声明自己的算子，批内可跨
 * 算子混合（前进/插入/旁支/巩固一轮混出）；复诊预注册同样随条目走（op.recheck，只随
 * 插入条目），apply 按条目登记边实验账本（账本本就逐边）。 */
export interface GrowthNote {
  reason: string
  /** 朝向声明（ADR-0076 教练回合多终点化）：本批朝哪些终点长（终点节点名列表）。
   * 批内含 前进/换向 条目且其 add_node 非空时必填非空——「主线批必接线」的覆盖检查
   * 对每个声明的终点各跑一遍（新前沿 = 前进/换向条目）；声明终点必须是在册锚。同一个
   * 新节点可同时进多个终点的 pre（交汇节点，合法形态）。 */
  target_endpoints?: string[]
  /** 真分歧声明（disagreement）：裁决与上下文/批注存在实质分歧时声明，宿主升级
   * 全量段重裁（显然步免仲裁税不声明）。字段名避让「申诉（Dispute，ADR-0031）」
   * 词条——同名同义纪律。 */
  disagreement?: string
}

/** 提案 op 上的退役键：边轻纪律键（#127：候选边留提案侧留痕、origin 从 journal 派生、
 * 复诊状态落 state/边实验.jsonl，提案节点零边元数据字段）+ 结构坐标键（#275：Region/Block
 * 退役，写侧不再有 region/block 坐标）。一律拒收不静默丢弃。 */
const RETIRED_OP_KEYS = ['origin', 'status', 'probation', 'region', 'block'] as const

/** edit 提案的合法顶层键（#313 A4）。此前顶层零白名单：模型写 `pres:` / `blooom:` 这类
 * 错键时字段无声蒸发，回执/审计/finish 全绿。同仓 parseNode/parseEnc/误解条目都是未知键
 * fail loud，这里对齐。 */
export const EDIT_TOP_KEYS = ['course', 'reason', 'concepts', 'ops', 'note'] as const

/** #316 / ADR-0099 退役键：罗盘「剩余路线」写权反转为罗盘站独占（learnhub_compass_paint），
 * 提案携带 route 一律拒收——专用文案点名退役，避免落进泛「未知字段」清单里看不出根因。 */
const RETIRED_TOP_ROUTE = 'route'

/** 单条 op 的合法键（#313 A4；糖算子自己的键——into/with/chain——在补丁入口展开成原子 op
 * 后就不在权威门里出现，故不在本表）。 */
export const EDIT_OP_KEYS = [
  'op', 'node', 'name', 'new', 'pre', 'enc', 'opt', 'note', 'est', 'type',
  'bloom', 'difficulty', 'teaches', 'assumes', 'misconceptions', 'operator', 'recheck', 'consolidate',
] as const

export interface EditProposalSpec {
  course: string
  reason?: string
  /** 铸名块（#141 登记机械化）：随生长批提案铸名入册，随图 apply 的写入单元落盘；
   * 提案被拒则登记不落盘。省略 = 本批零铸名。 */
  concepts?: ConceptEntry[]
  ops: EditOp[]
  /** 生长批 note 区（#145）：在场 = 生长批（教练回合裁决产物）；缺席 = 普通 edit 提案。
   * #316 / ADR-0099 起**无 route 字段**：罗盘「剩余路线」写权归罗盘站独占。 */
  note?: GrowthNote
}

/** 合法 op 词汇（schema 门与取值域回灌的单一出处；糖算子不在其中——它们在补丁入口展开成
 * 这些原子 op 之后才进权威门）。 */
export const EDIT_OPS = ['add_node', 'del_node', 'set_pre', 'set_enc', 'rename', 'set_note'] as const

/** 批内 add_node 数（插入登记/调速闸门的「本批新增」口径单点；解析前 doc.ops 与
 * EditOp[] 同形消费）。 */
export function addNodeCountOf(ops: Array<{ op?: unknown }> | undefined): number {
  return (ops ?? []).filter(o => o.op === 'add_node').length
}

/** 批内逐条目算子的汇总面（#327）：按条目出现序折叠「算子×条数」（如 `前进×2、插入×1`）。
 * 摘要/journal/回执的展示单源——批级 note.operator 退役后，「这批是什么批」由这里回答；
 * 调用方要取值域列表时用 growthOperatorsOf。 */
export function operatorFoldOf(ops: Array<{ op?: unknown; operator?: unknown }>): string {
  const counts = new Map<string, number>()
  for (const o of ops ?? []) {
    if (o.op !== 'add_node' || typeof o.operator !== 'string') continue
    counts.set(o.operator, (counts.get(o.operator) ?? 0) + 1)
  }
  return [...counts.entries()].map(([op, n]) => (n > 1 ? `${op}×${n}` : op)).join('、')
}

/** 批内出现的去重算子列表（条目出现序；结果类型与宿主消息的「operators」口径）。 */
export function growthOperatorsOf(ops: Array<{ op?: unknown; operator?: unknown }>): GrowthOperator[] {
  const out: GrowthOperator[] = []
  for (const o of ops ?? []) {
    if (o.op !== 'add_node' || typeof o.operator !== 'string') continue
    const op = o.operator as GrowthOperator
    if (!out.includes(op)) out.push(op)
  }
  return out
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
  // 顶层白名单（#313 A4）：未知键一律拒收。写错键名字段（pres/blooom/…）此前无声蒸发，
  // 回执、审计、finish 全绿——而模型那边「写了就生效」的假设没人纠正。
  const unknownTop = Object.keys(d).filter(k => !(EDIT_TOP_KEYS as readonly string[]).includes(k))
  if (unknownTop.length) {
    errors.push(`(顶层) 含未知字段 ${JSON.stringify(unknownTop)}（只允许 ${EDIT_TOP_KEYS.join('/')}——写错键名字段会无声蒸发；生长批的算子/理由/朝向/复诊预注册写进 note 区）`)
  }
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
  // 生长批 note 区（#145）：严格 schema——恰 {reason, target_endpoints?, disagreement?}，
  // 未知键拒收。#327：算子与复诊预注册不再住 note（逐条目化，随 add_node 的
  // operator / recheck 走）；note.operator / note.recheck 写了即按未知键点名退役。
  let note: GrowthNote | undefined
  let recheckWarns: string[] = []
  if (d.note !== undefined) {
    if (typeof d.note !== 'object' || d.note === null || Array.isArray(d.note)) {
      errors.push('note: 必须是映射（生长批裁决区 = {reason, target_endpoints?, disagreement?}）')
    } else {
      const n = d.note as Record<string, unknown>
      const noteErrors: string[] = []
      const unknown = Object.keys(n).filter(k => !['reason', 'target_endpoints', 'disagreement'].includes(k))
      if (unknown.length) {
        noteErrors.push(`note 含未知字段 ${JSON.stringify(unknown)}（只允许 reason/target_endpoints/disagreement；算子写在每条 add_node 的 operator——取值域 ${GROWTH_OPERATORS.join('/')}，复诊预注册写在插入条目的 recheck，朝向声明写在 target_endpoints，分歧声明写在 disagreement）`)
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
      errors.push(...noteErrors)
      if (!noteErrors.length) {
        note = {
          reason: (n.reason as string).trim(),
          ...(targetEndpoints ? { target_endpoints: targetEndpoints } : {}),
          ...(typeof n.disagreement === 'string' && n.disagreement.trim() ? { disagreement: n.disagreement.trim() } : {}),
        }
      }
    }
  }
  // #316 / ADR-0099：route 已退役——写权归罗盘站（learnhub_compass_paint），提案携带
  // 一律拒收；专用文案点名退役，避免落进泛「未知字段」清单里看不出根因。
  if (d[RETIRED_TOP_ROUTE] !== undefined) {
    errors.push(`route: 已退役——罗盘「剩余路线」写权归罗盘站（learnhub_compass_paint），教练对弧只有建议权（理由写进 note.reason）。`)
  }
  const ops: EditOp[] = []
  if (d.ops === undefined && note) {
    // 生长批允许零操作（裁决=暂不产结构；批留痕照走写入单元）
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
        errors.push(`${where}.op: 非法操作 ${String(op)}（允许 ${EDIT_OPS.join('/')}）${op === 'move' ? '——move 已随 Region/Block 退役：分组改为读侧派生，写侧不再有换分区操作' : ''}`)
        return
      }
      // 退役键（#127 边轻纪律 + #275 结构坐标）：静默丢弃会丢语义，fail loud。按键族分段给出可执行指引。
      const retired = Object.keys(o).filter(k => (RETIRED_OP_KEYS as readonly string[]).includes(k))
      const coords = retired.filter(k => k === 'region' || k === 'block')
      const edges = retired.filter(k => k !== 'region' && k !== 'block')
      if (coords.length) errors.push(`${where}: 不接受坐标键 ${JSON.stringify(coords)}（随 Region/Block 退役 ）——add_node 只需 name + pre，删掉这两个键即可落图（分布由读侧派生）`)
      if (edges.length) errors.push(`${where}: 不接受这些字段 ${JSON.stringify(edges)}（origin 从提案 journal 派生、复诊状态落 state/边实验.jsonl——图与提案节点零边字段）`)
      // 未知键白名单（#313 A4）：与图 YAML / 误解条目同款 fail loud——键名写错（pres/blooom/
      // est_minutes…）此前无声蒸发，门零错误、回执全绿，模型以为写了就生效。
      const unknownKeys = Object.keys(o).filter(k =>
        !(EDIT_OP_KEYS as readonly string[]).includes(k) && !(RETIRED_OP_KEYS as readonly string[]).includes(k))
      if (unknownKeys.length) {
        errors.push(`${where}: 含未知字段 ${JSON.stringify(unknownKeys)}（只允许 ${EDIT_OP_KEYS.join('/')}——字段名写错会无声蒸发；add_node 的节点名写 name，其余 op 引用既有节点写 node）`)
      }
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
      // add_node 的 pre 同口径（#313 A2）：非列表一律 fail loud——旧实现 `Array.isArray(o.pre) ?
      // … : []` 把 `pre: "甲"` 这类写法静默折成零前置，节点以**根部**落图（可学性判据、主线接线、
      // 断边检查全程无错误行）。与 set_pre/set_enc 的「必须列表」是同一件事，同文件不许两种口径。
      if (op === 'add_node' && o.pre !== undefined && !Array.isArray(o.pre)) {
        errors.push(`${where}: add_node 的 pre 必须是列表（前置节点名列表；收到 ${typeof o.pre === 'string' ? '字符串' : typeof o.pre}）——零前置写 pre: [] 或省略本字段`)
      }
      // pre 元素形状（#313 A2）：`String(p)` 会把 1/null/true 静默转成 '1'/'null'/'true'
      // 落成断边或鬼节点引用——节点名必须逐字是字符串。
      if (Array.isArray(o.pre) && o.pre.some(p => typeof p !== 'string' || !p.trim())) {
        errors.push(`${where}: pre 的每一项都要是非空节点名（逐字字符串）——收到 ${JSON.stringify(o.pre.slice(0, 5))}；数字/null 会被静默转成字符串落图`)}
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
      // 逐条目算子与复诊预注册（#327）：schema 门在此（取值域/形态），跨字段规则在 ops
      // 就位后统一裁（见下方 perEntryGate）。预注册走 recheckPreregOf 同一门（取值域/
      // 未知键/clamp 单源），clamp 产生的 warn 收集给受理回执。
      let opOperator: GrowthOperator | undefined
      if (o.operator !== undefined) {
        if (!(GROWTH_OPERATORS as readonly string[]).includes(String(o.operator))) {
          errors.push(`${where}.operator: 非法算子 ${JSON.stringify(String(o.operator))}（允许 ${GROWTH_OPERATORS.join('/')}）`)
        } else {
          opOperator = String(o.operator) as GrowthOperator
        }
      }
      // 收束声明（#335 刀①）：consolidate: true 随新增条目携带；其他 op / 非布尔值拒收
      let opConsolidate: true | undefined
      if (o.consolidate !== undefined) {
        if (op !== 'add_node') {
          errors.push(`${where}: consolidate 只随 add_node 携带（收束声明的是「这一条新增是综合收束」——其他 op 没有这个语义）`)
        } else if (o.consolidate !== true) {
          errors.push(`${where}.consolidate: 只接受 true（收束条目写 consolidate: true；非收束条目省略本字段）`)
        } else {
          opConsolidate = true
        }
      }
      let opRecheck: RecheckPrereg | undefined
      if (o.recheck !== undefined) {
        const v = recheckPreregOf(o.recheck, `${where}.recheck`)
        errors.push(...v.errors)
        recheckWarns.push(...v.warns)
        if (!v.errors.length && v.prereg) opRecheck = v.prereg
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
        ...(opOperator !== undefined ? { operator: opOperator } : {}),
        ...(opConsolidate !== undefined ? { consolidate: opConsolidate } : {}),
        ...(opRecheck !== undefined ? { recheck: opRecheck } : {}),
      })
    })
  }
  if (errors.length) return { errors }
  // 逐条目算子与复诊预注册的跨字段规则（#327，ops 就位后裁；#146 的批级规则随
  // 逐条目化迁移）：生长批（note 在场）的每条 add_node 必带 operator（批内可跨算子
  // 混合——一次长出一组各种类别的节点）；算子/预注册只随 add_node 出生（其他 op 与
  // 普通提案携带即拒收——它们没有「以什么方式长」的语义）；插入条目必须预注册复诊
  // （零人审结算的判据前提），预注册也只随插入条目携带（其他条目没有可登记的插入边）。
  if (note) {
    ops.forEach((op, i) => {
      const where = `ops.${i}`
      if (op.op !== 'add_node') {
        if (op.operator !== undefined || op.recheck !== undefined || op.consolidate !== undefined) {
          errors.push(`${where}: operator/recheck/consolidate 只随 add_node 携带（算子声明的是「这一条以什么方式长」——其他 op 没有这个语义）`)
        }
        return
      }
      if (!op.operator) {
        errors.push(`${where}: 生长批的 add_node 必须声明算子 operator（${GROWTH_OPERATORS.join('/')}，批内可跨算子混合；note 不再有批级 operator，算子逐条目声明）`)
      }
      if (op.operator === '插入' && !op.recheck) {
        errors.push(`${where}: 插入条目必须预注册复诊 recheck（metric: 前进恢复|卡点集中度降幅|保留率恢复；days 缺省 10 学习日）——插入边的到期结算零人审，没有预注册就没有结算判据`)
      }
      if (op.recheck && op.operator !== '插入') {
        errors.push(`${where}: 复诊预注册只随插入条目携带（本条 operator=${op.operator ?? '（未声明）'}——没有可登记的插入边就无需预注册）`)
      }
      if (op.consolidate && op.operator !== '新增') {
        errors.push(`${where}: 收束声明 consolidate 只随新增条目携带（本条 operator=${op.operator ?? '（未声明）'}）`)
      }
    })
    const mainlineAdds = ops.filter(o => o.op === 'add_node' && o.operator === '新增').length
    if (mainlineAdds > 0 && !(note.target_endpoints?.length)) {
      errors.push(`生长批含 ${mainlineAdds} 条新增节点但未声明朝向——note.target_endpoints 必填（本批朝哪些终点长；交汇优先，可声明多个）`)
    }
  } else {
    ops.forEach((op, i) => {
      if (op.operator !== undefined || op.recheck !== undefined || op.consolidate !== undefined) {
        errors.push(`ops.${i}: operator/recheck/consolidate 只随生长批的 add_node 携带（普通提案没有生长算子语义）`)
      }
    })
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
    },
  }
}

/** edit 提案全部概念引用（teaches/assumes 键 + 误解 concept；#141 受理门对表原料）。
 * 非列表 misconceptions 在此**跳过**而不是 `for...of`（#301 缺陷②：字典形不可迭代，
 * 抛出的 TypeError 会穿透整条门序列——连 finish 轮次都记不下、回灌给模型一行裸异常）。
 * 该形状的可执行错误行由重放侧（nodeFromAddOp）给出，一处说一次。 */
function conceptRefsOfOps(ops: EditOp[]): ConceptRef[] {
  const refs: ConceptRef[] = []
  for (const [i, op] of ops.entries()) {
    const where = `ops.${i}(${op.op === 'add_node' ? op.name : op.node})`
    // 取不到真概念名的字段一律跳过（形状问题由重放侧的可执行行给出，见 nodeFromAddOp）：
    // 非映射的 teaches/assumes 会被 Object.keys 数成「引用「0」未在册」、非列表或非条目的
    // misconceptions 会数成「引用「undefined」未在册」——两类鬼引用都会盖住真错误（#301）
    for (const field of ['teaches', 'assumes'] as const) {
      const map: unknown = op[field]
      if (map === undefined || map === null || typeof map !== 'object' || Array.isArray(map)) continue
      for (const concept of Object.keys(map)) refs.push({ where: `${field}[${where}]`, concept })
    }
    for (const m of Array.isArray(op.misconceptions) ? op.misconceptions : []) {
      const concept = (m as { concept?: unknown } | null)?.concept
      if (typeof concept === 'string' && concept.trim()) {
        refs.push({ where: `misconceptions[${where}]`, concept })
      }
    }
  }
  return refs
}

/** 难度步进门（#335 刀②）：add_node 声明了 difficulty 且其直接前置的难度可解析时，
 * 与前置最大难度步进 >1 拒收——「难度渐进」从提示词软约束升为受理硬门（学习曲线
 * 2→4 两连跳的实证根因）。前置难度取「基图 difficultyOf + 本批已声明」的并集：
 * 批内链条（insert_prereq_chain 展开后）的中间节点经批内声明解析，不需先落图。
 * 任一侧难度缺席（未标注）不参与判定——门只执法两端都可解析的边。 */
export function difficultyStepGateErrors(ops: EditOp[], graph: Graph): string[] {
  const diffOf = new Map<string, number>()
  for (const n of graph.names) {
    const d = graph.difficultyOf[n]
    if (d !== undefined) diffOf.set(n, d)
  }
  const errors: string[] = []
  for (const op of ops) {
    if (op.op === 'add_node' && op.difficulty !== undefined && op.name) diffOf.set(op.name, op.difficulty)
  }
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'add_node' || op.difficulty === undefined) continue
    const pres = (op.pre ?? []).map(p => diffOf.get(p)).filter((d): d is number => d !== undefined)
    if (!pres.length) continue
    const maxPre = Math.max(...pres)
    if (op.difficulty - maxPre > 1) {
      errors.push(`ops.${i}(add_node ${op.name}): 难度步进越档（前置最大难度 ${maxPre} → 本节点 ${op.difficulty}，步进 >1）——相邻节点 difficulty 每步至多 +1（学习曲线门）；内容确实需要陡升时拆中间台阶分批长`)
    }
  }
  return errors
}

/** 收束门（#145 受理门校验；#327 逐条目化；#335 刀①收编）：consolidate: true 的**新增条目**
 * 是综合收束——该 add_node 的概念引用（teaches/assumes/误解）只许引已教概念（既有图
 * teaches 并集），不产新概念；不走复诊由边轻纪律键拒收与 #146 结算语义共同保证（收束条目
 * 没有复诊通道——预注册只随插入条目）。混算子批里只裁收束条目，其余条目不受影响。 */
export function consolidationGateErrors(
  ops: EditOp[], graph: Graph,
  entries: ReadonlyArray<ConceptEntry>,
): string[] {
  // 已教概念集单一出处 Graph.taughtByOf（#270 反向映射）：names 全扫折叠退役。
  // 两侧都归一到 canonical（#313 C12）——图上写别名、提案写 canonical（或反过来）时
  // 按原始串比对会误判「不是已教概念」而无谓拒收。
  const canon = canonicalizerOf(entries)
  const taught = new Set(Object.keys(graph.taughtByOf).map(canon))
  const errors: string[] = []
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'add_node' || !op.consolidate) continue
    const where = `ops.${i}(add_node ${op.name})`
    for (const concept of Object.keys(op.teaches ?? {})) {
      if (!taught.has(canon(concept))) errors.push(`${where}: 收束条目 teaches「${concept}」不是已教概念——收束只引已教概念做综合收束；新概念由非收束新增条目产出`)
    }
    for (const concept of Object.keys(op.assumes ?? {})) {
      if (!taught.has(canon(concept))) errors.push(`${where}: 收束条目 assumes「${concept}」不是已教概念——收束只引已教概念做综合收束`)
    }
    for (const m of Array.isArray(op.misconceptions) ? op.misconceptions : []) {
      const concept = (m as { concept?: unknown } | null)?.concept
      if (typeof concept !== 'string' || !concept.trim()) continue // 形状错误由重放侧给出（#301）
      if (!taught.has(canon(concept))) errors.push(`${where}: 收束条目误解条目「${concept}」不是已教概念——收束只引已教概念做综合收束`)
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
 * effects 为空 = 本批不触碰任何终点锚。
 *
 * #315 B2 收尾前置：传入了 `closureLearnedOf`（终点 → 闭包真已学读数）时，闭包未全部
 * 真已学的终点**不落 sealed**——收尾批就地降级为普通接线批（接线照做、不 sealed、
 * 不进停摆判据），被降级的终点记入 `downgraded`；完整的状态型完成判据（mastery 阈值
 * + 闭包健康）归 #316。未传时保持纯结构判据（存量测试与旧调用方不受影响）。 */
export interface SealedDecision {
  /** 被本批 set_pre 接线的终点节点（图上在册锚的子集）。 */
  wired: string[]
  /** 是否构成收尾宣告（零 add_node 纯 set_pre 批）。 */
  sealing: boolean
  effects: Array<{ endpoint: string; action: 'seal' | 'reopen' }>
  /** 因闭包未真已学被降级的终点（#315 B2；仅在传入 closureLearnedOf 时出现）。 */
  downgraded?: string[]
}

/** 闭包真已学读数（终点 → 闭包剔除终点自身后的未学名单；#315 B2）。 */
export type ClosureLearnedOf = (endpoint: string) => { total: number; unlearned: string[] }

export function sealedDecisionOf(ops: EditOp[], anchors: EndpointAnchor[], closureLearnedOf?: ClosureLearnedOf): SealedDecision {
  // 接线必须**非空**（#313 C10）：`set_pre {node: 终点, pre: []}` 是把终点的前置清空，
  // 不构成收尾接线——旧谓词只看 op 形态，于是「pre 空 = 未接线」的终点会被标成 sealed
  // （与上下文包里读出的「未接线」自相矛盾，而 sealed 一旦落锚会一直留着）。
  const wires = new Set(ops.filter(o => o.op === 'set_pre' && o.node && (o.pre ?? []).length > 0).map(o => o.node!))
  const touched = anchors.filter(a => wires.has(a.endpoint))
  if (!wires.size || !touched.length) return { wired: [], sealing: false, effects: [] }
  const adds = addNodeCountOf(ops)
  const sealing = adds === 0 && ops.every(o => o.op === 'set_pre' && (o.pre ?? []).length > 0)
  if (!sealing && adds === 0) return { wired: touched.map(a => a.endpoint), sealing: false, effects: [] }
  // #315 B2：闭包未真已学的终点不落 sealed——降级为普通接线批（接线照做），其余终点照常。
  const downgradeable = sealing && closureLearnedOf !== undefined
  const downgraded = downgradeable
    ? touched.map(a => a.endpoint).filter(ep => (closureLearnedOf!(ep).unlearned.length > 0))
    : []
  const sealTargets = touched.filter(a => !downgraded.includes(a.endpoint))
  const effects: SealedDecision['effects'] = []
  if (sealing && sealTargets.length) {
    effects.push(...sealTargets.map(a => ({ endpoint: a.endpoint, action: 'seal' as const })))
  }
  if (adds > 0) {
    effects.push(...touched.map(a => ({ endpoint: a.endpoint, action: 'reopen' as const })))
  }
  return {
    wired: touched.map(a => a.endpoint),
    sealing: sealing && sealTargets.length > 0,
    effects,
    ...(downgraded.length ? { downgraded } : {}),
  }
}

/** 节点概念自相矛盾门（#315 B7，人裁口径 = 门拒）：同一节点 teaches 与 assumes 同一概念
 * （canonical 归一后比对，#313 C12 同款）= 教自己假设已会的东西，拒收该批。合法的
 * 「螺旋升档」编码写法（只 teaches 高档、不 assumes）不需要门另眼：assume 同概念
 * 无论档位一律拒。 */
export function selfContradictionErrors(
  ops: EditOp[], entries: ReadonlyArray<ConceptEntry>,
): string[] {
  const canon = canonicalizerOf(entries)
  const errors: string[] = []
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'add_node') continue
    const where = `ops.${i}(add_node ${op.name})`
    for (const concept of Object.keys(op.teaches ?? {})) {
      if (op.assumes && Object.keys(op.assumes).some(a => canon(a) === canon(concept))) {
        errors.push(`${where}: 同一节点 teaches 与 assumes 同一概念「${concept}」（教自己假设已会的东西）——若意图是螺旋升档，只写 teaches 高档、不要 assumes 同概念`)
      }
    }
  }
  return errors
}

/** 概念名归一的判决面（#313 C12）：图上与 op 里的概念名允许写别名（对表门按在册
 * canonical ∪ aliases 放行），但**按名比对的判据**（巩固门的「已教」集合、误解封顶的
 * 逐概念计数）必须归一到 canonical——否则同一个概念因写法不同被折成两半：巩固门误判
 * 「不是已教概念」而无谓拒收，封顶按串拆开（实际可放 4–6 条）。归一同一处实现，不各写一份。 */
function canonicalizerOf(entries: ReadonlyArray<ConceptEntry>): (name: string) => string {
  if (!entries.length) return n => n
  return name => resolveConcept([...entries], name)?.canonical ?? name
}

/** 误解封顶门（#313 C9 增量判据 + C12 归一）：`nodes` 与 `base` 都按 canonical 计数，且只报
 * 「本批把某概念推过封顶/存量水位」的那一类——存量越界（概念合并的产物）不再砖死课程。 */
export function misconceptionGateErrors(
  nodes: GNode[], base: GNode[], entries: ReadonlyArray<ConceptEntry>,
): string[] {
  const canon = canonicalizerOf(entries)
  const counts = (ns: GNode[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const n of ns) {
      for (const mi of n.misconceptions ?? []) {
        const k = canon(mi.concept)
        m.set(k, (m.get(k) ?? 0) + 1)
      }
    }
    return m
  }
  return misconceptionCapErrorsOfCounts(counts(nodes), counts(base))
}

/** 在册条目底细工厂（裁决 7 / ADR-0089 修订）：撞名现场把条目底细摆到模型面前——
 * canonical + 定义（缺席显式「（无定义）」并注明判据不足）+ teaches/assumes 足迹摘要
 * （图内哪些节点教/假设它，经别名精确解析归一）。零 IO：图与登记表由调用方装载。
 * invokes 分布未入底细（门零 IO 约束，待有消费证据再接，票面勘误已如实登记）。 */
export function conceptEntryDetailOf(
  entries: ConceptEntry[], graph: Graph,
): (owner: string) => string {
  const canon = (raw: string): string | null => resolveConcept(entries, raw)?.canonical ?? null
  const footprint = (owner: string): string[] => {
    const out: string[] = []
    for (const [concept, nodes] of [...Object.entries(graph.taughtByOf), ...Object.entries(graph.assumedByOf)]) {
      if (canon(concept) !== owner) continue
      for (const n of nodes) if (!out.includes(n)) out.push(n)
    }
    return out
  }
  return owner => {
    const e = resolveConcept(entries, owner)
    const def = e?.definition ?? '（无定义——判据不足，缺省动作：不得引用，改铸消歧名）'
    const fp = owner ? footprint(owner) : []
    return `canonical「${owner}」·定义：${def}·足迹：${fp.length ? `teaches/assumes 节点 [${fp.join('、')}]` : '本课程图内暂无（teaches/assumes 均无）'}`
  }
}

/** 跨课首引复核提示（裁决 8 / ADR-0089 修订，纯读侧派生）：本批 ops 引用（teaches/
 * assumes/误解）的在册概念在本课程图内足迹为空（本课程首次引入）→ 非阻提示，随
 * 受理回执 warns 带出。零落盘、天然去重（落盘后足迹非空自消）；**不得混入 errors**
 * ——混入即被读成拒收并触发重裁。文案三段：语义现状 + 豁免句 + 仅语义不同时的出口。 */
export function crossCourseFirstRefWarnings(
  entries: ConceptEntry[], graph: Graph, refs: ConceptRef[],
): string[] {
  const canon = (raw: string): string | null => resolveConcept(entries, raw)?.canonical ?? null
  const footprintEmpty = (owner: string): boolean => {
    for (const [concept] of [...Object.entries(graph.taughtByOf), ...Object.entries(graph.assumedByOf)]) {
      if (canon(concept) === owner) return false
    }
    return true
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of refs) {
    const owner = canon(ref.concept)
    if (!owner || seen.has(owner)) continue
    if (!footprintEmpty(owner)) continue
    seen.add(owner)
    const e = resolveConcept(entries, owner)
    const def = e?.definition ?? '（无定义）'
    out.push(`跨课首引复核（非阻，无需改批）：「${owner}」·定义：${def} 在本课程图内暂无足迹（无节点 teaches/assumes 它，本课程首次引入）——若本批内容真实调用的就是它，无需任何改动，本条只是可见性留痕；仅当语义确实不同时，按「基名（限定语）」规范改铸消歧名`)
  }
  return out
}

/** edit 受理门全序列收拢（#271 / ADR-0088 中心裁决「门同源」）：结构重放 / 概念对表 /
 * 终点锚保护 / 巩固门 / 生长闸门——proposeEdit / applyEdit / 草稿内核**三处同调**，
 * 草稿通过 = 门通过按构造成立。上下文由调用方装载（entries = 登记现行条目，需铸名
 * 合并的调用方传合并后集合并省略 mints；anchors = 现行终点锚），本函数零 IO。 */
export interface EditGateCtx {
  nodes: GNode[]
  graph: Graph
  entries: ConceptEntry[]
  anchors: EndpointAnchor[]
  /** 本批铸名块（对表用；与 entries 撞名由 mintConflicts 硬拒）。 */
  mints?: ConceptEntry[]
  /** 撞名底细工厂（裁决 7）：调用方提供时拒收行附在册条目底细（canonical/定义/足迹）。
   * 门零 IO——由有图的调用方用 conceptEntryDetailOf 装载；缺席 = 旧形拒收行。 */
  entryDetailOf?: (owner: string) => string
  growthGate?: (spec: EditProposalSpec) => Promise<string[]>
  /** apply 侧审计门（#313 B5）：返回审计 ERROR 行，空 = 放行。propose 与草稿试算都接它，
   * 使「审计存在 ERROR」这件事在**第一次提案/第一次补丁**就可见——否则模型要烧到
   * apply 才看到一行指不到明细的拒收官话（草稿会话连审计报告文件都读不到）。 */
  auditGate?: () => Promise<string[]>
}

export async function editGateErrors(spec: EditProposalSpec, ctx: EditGateCtx): Promise<string[]> {
  const mints = ctx.mints ?? []
  const errors = [
    ...simulateOps(ctx.nodes, ctx.graph, spec.ops),
    ...mintConflicts(mints, ctx.entries, ctx.entryDetailOf),
    ...conceptReferenceErrors(conceptRefsOfOps(spec.ops), namesOf([...ctx.entries, ...mints])),
    ...endpointGuardErrorsOf(spec, ctx.anchors),
    ...consolidationGateErrors(spec.ops, ctx.graph, ctx.entries),
    ...difficultyStepGateErrors(spec.ops, ctx.graph),
    ...selfContradictionErrors(spec.ops, [...ctx.entries, ...mints]),
  ]
  // 误解封顶（#313 C9/C12）：增量判据 + canonical 归一，落在登记表现行条目（+ 本批铸名）上。
  // 结构面先过才跑（与旧序一致——重放已有错时叠一条派生错误只会盖住真死因）
  if (!errors.length) {
    errors.push(...misconceptionGateErrors(simulatedNodes(ctx.nodes, spec.ops), ctx.nodes, [...ctx.entries, ...mints]))
  }
  if (errors.length) return errors
  const gateBlocks = ctx.growthGate ? await ctx.growthGate(spec) : []
  // 闸门横幅随错误行返回（原 propose/apply 两侧的包装文案，门同调后单源在此）
  if (gateBlocks.length) return ['生长闸门拒绝受理（插入积极性调速，）', ...gateBlocks]
  const auditBlocks = ctx.auditGate ? await ctx.auditGate() : []
  return auditBlocks.length
    ? ['审计门拒绝受理（与 apply 同一判据：课程存在 ERROR 时任何提案都不落盘），明细：', ...auditBlocks]
    : []
}

/** 受理门的**完整**序列（#309 缺陷① / ADR-0088 §修订）：schema 纯校验（`validateEditProposal`
 * ——op 白名单、档位枚举、bloom/difficulty/est 取值域、字段互斥、note 区跨字段规则、铸名/误解
 * 条目形态）+ `editGateErrors`（结构重放 / 概念对表 / 终点锚保护 / 巩固门 / 生长闸门）。
 *
 * 为什么需要它：`editGateErrors` 只是门的**结构子集**，`draft_audit` 拿去当「草稿通过 = 门通过」
 * 的判据时漏掉了 schema 面——2026-09-17 事故里审计连报两次「通过」，finish 却分别被 propose 的
 * schema 门（`teaches[...] 档位非法 "初识"`）与门复验拒掉，模型据此以为「审计通过 = 可以发布」。
 * proposeEdit 与草稿内核（`draft_patch` 试算 / `draft_audit` / `draft_finish`）**同一函数、
 * 同一顺序**——同一批 ops 两侧结论一致按构造成立，不靠两套实现对齐。 */
export async function editProposalGateErrors(
  doc: unknown, ctx: EditGateCtx, warns?: string[],
): Promise<{ errors: string[]; spec?: EditProposalSpec; phase: 'schema' | 'gate' }> {
  const v = validateEditProposal(doc, warns)
  if (v.errors) return { errors: v.errors, phase: 'schema' }
  return { errors: await editGateErrors(v.spec!, ctx), spec: v.spec, phase: 'gate' }
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
 * ② 主线批（含新增条目）含新节点时必须声明 target_endpoints，接线覆盖检查对每个声明的终点
 * 各跑一遍——零终点课程同样不豁免；③ 收尾接线批（零 add_node 的纯 set_pre）合法。
 * 接线核查取「覆盖」而非「相等」：最后台阶可与既有台阶合流（交汇），新前沿全部在 wire 里
 * 就守住不变式。插入/收束条目豁免接线义务。（#271 抽出纯函数形态：editGateErrors 三处同调） */
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
  // ① 禁以终点为 pre：add_node 把方向锚当前置 = 长过目标。set_pre 同罚（#313 C10）：
  // `set_pre {node: X, pre: [终点]}` 此前无人拦——终点是**方向锚**（零正文不被调度），
  // 把它写成别人的前置既让方向失去意义，又让「已铺通」的读数失真；接线语义是
  // `set_pre {node: 终点, pre: [台阶]}`（终点当 node，不是当 pre）。
  for (const [i, op] of spec.ops.entries()) {
    if ((op.op !== 'add_node' && op.op !== 'set_pre') || !(op.pre ?? []).length) continue
    const hit = (op.pre ?? []).filter(p => endpoints.has(p))
    if (!hit.length) continue
    if (op.op === 'add_node') {
      errors.push(`ops.${i}: add_node「${op.name}」以终点「${hit.join('、')}」为 pre——目标之后不是本课程的生长域（禁长过目标）`)
    } else {
      errors.push(`ops.${i}: set_pre(${op.node}) 把终点「${hit.join('、')}」写进了前置——终点是方向锚不是台阶；接线写 set_pre { node: ${hit[0]}, pre: [<台阶>] }（终点当 node）`)
    }
  }
  // ② 主线批必接线（ADR-0076 教练回合多终点化；#327 逐条目化；#335 刀①：算子收缩后
  //    主线条目 = operator=新增）：批内含**新增条目**且其 add_node 非空时必须声明
  //    note.target_endpoints（本批朝哪些终点长），接线覆盖检查对**每个**声明的终点各跑
  //    一遍——新前沿只数新增条目（插入/收束条目没有接线义务，混算子批各裁各的）；
  //    声明终点必须是在册锚（锚由人手增删，提案不得凭空捏造方向）。
  //    同一个新节点同时进多个终点的 pre 是合法形态（交汇节点，同一门下天然放行）。
  const mainline = spec.ops.filter(o => o.op === 'add_node' && o.operator === '新增')
  if (spec.note && mainline.length > 0) {
    const targets = spec.note.target_endpoints ?? []
    if (!targets.length) {
      errors.push(`生长批含 ${mainline.length} 条新增节点但未声明朝向——note.target_endpoints 必填（本批朝哪些终点长；交汇优先，可声明多个）`)
    }
    const consumed = new Set(spec.ops.flatMap(o => o.op === 'add_node' ? (o.pre ?? []) : []))
    const frontier = mainline.map(o => o.name!).filter(n => !consumed.has(n))
    for (const target of targets) {
      if (!endpoints.has(target)) {
        errors.push(`note.target_endpoints: 「${target}」不是在册终点——朝向只能声明锚上已声明的终点（锚由学习者手加，提案不得改）`)
        continue
      }
      const wirings = spec.ops.filter(o => o.op === 'set_pre' && o.node === target)
      if (!wirings.length) {
        errors.push(`生长批声明朝「${target}」长但未接线——主线批必须携带 set_pre { node: ${target}, pre: [批内新前沿${frontier.length ? `（本批：${frontier.join('、')}）` : ''}] }（替换语义：终点.pre 恒指向教练当前认定的最后台阶，真实坡道取代起草粗边）`)
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
  /** 调试日志端口（#253 / ADR-0080；#290/#291 附录登记接线）：题库随迁丢失与去重扫描
   * 跳过留痕由本类发。缺省 noop——既有构造点零改动；宿主装配显式接引擎 logger。 */
  private logger: Logger
  constructor(
    private paths: Paths,
    private store: Store,
    private registry: { get(key: string): Promise<CourseEntry | null>; load(): Promise<CourseEntry[]>; save(c: CourseEntry[]): Promise<void> },
    private centerRoot: string,
    /** 生长闸门（#146 插入/旁支调速）：受理与 apply 双门在 schema 门后调用——需要
     * 三率流水（账本/提案/练习），由门面注入（本类零流水依赖）；返回拒收行，空 = 放行。 */
    private growthGate: ((spec: EditProposalSpec) => Promise<string[]>) | undefined,
    /** 审计门的受理面（#313 B5）：按课程名返回审计 ERROR 行（只算不落盘）。propose 与
     * 草稿试算共用同一判据——「审计通过」与「apply 被拒」不再能在同一帧共存。 */
    private auditGate: ((course: string) => Promise<string[]>) | undefined,
    /** 时钟端口（#175 阶段①）：decided/now 戳与学习日缺省都经它取时。 */
    private clock: Clock,
    private fs: VaultFs,
    /** 调度状态读取口（#315 B2）：收尾前置「闭包真已学」要在 apply 侧读掌握状态；
     * 缺省 = 收尾降级门不执法（存量构造点/测试零改动）。 */
    private stateOf: ((root: string) => Promise<Record<string, Fm>>) | undefined,
    logger: Logger = noopLogger,
  ) {
    this.logger = logger
    this.concepts = new ConceptRegistry(paths, this.fs)
  }

  /** 为图中缺笔记的节点补骨架文件（幂等）：apply 落图后调用。
   * 节点存在于图就该有 frontmatter 文件——vault 笔记是调度状态的事实源。 */
  async ensureNotesFor(root: string, nodes: GNode[]): Promise<number> {
    let created = 0
    for (const n of nodes) {
      const path = this.paths.courseNotePath(root, n.name)
      if (this.fs.exists(path)) continue
      await saveNote(path, defaultFrontmatter(n.name) as unknown as Record<string, unknown>, '> 内容待生成。\n', this.fs)
      created++
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
    const nodes = await new GraphStore(this.paths, this.paths.courseRoot(course.root), this.fs).load()
    const graph = new Graph(nodes)
    const entries = await this.concepts.load() // 登记表 Broken 在此抛错，apply 不落盘
    // 非阻提示照旧（#264 近似名预检与量级告警）+ 跨课首引复核（裁决 8，非阻 findings，
    // 不得混入 errors）；错误面统一走 editGateErrors（门同源，ADR-0088）
    warns.push(...nearNameWarnings(nearNameCandidates(spec.concepts ?? [], entries)))
    warns.push(...crossCourseFirstRefWarnings(entries, graph, conceptRefsOfOps(spec.ops)))
    if (spec.concepts?.length) warns.push(...conceptMagnitudeWarnings(applyConceptMints(entries, spec.concepts).entries))
    const anchors = await readAnchors(this.paths.anchorPath(course.root), this.fs)
    // 门序列 = editProposalGateErrors 的内部两步（validateEditProposal → editGateErrors）；此处
    // 不调那个合并入口只为让「注册表查不到课程」与「路线门」各出各的行文（草稿侧走合并入口）。
    const gateErrors = await editGateErrors(spec, {
      nodes, graph, entries, anchors,
      mints: spec.concepts ?? [], growthGate: this.growthGate,
      entryDetailOf: conceptEntryDetailOf(entries, graph),
      ...(this.auditGate ? { auditGate: () => this.auditGate!(course.name) } : {}),
    })
    if (gateErrors.length) {
      throw new Error(`[propose-edit] 提案未受理（修正后重提）。\n${gateErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const { pid } = await this.saveArtifact('edit', spec.course, YAML.parseModel(yamlText))
    await this.store.updateProposal(pid, {
      summary: spec.note
        ? `生长批（${operatorFoldOf(spec.ops) || (spec.ops.length ? '接线收束' : '裁决留痕')}）：${spec.note.reason}｜${spec.ops.length} 条操作`
        : `${spec.ops.length} 条操作${spec.concepts?.length ? `；铸名 ${spec.concepts.length} 条` : ''}：${spec.ops.map(o => o.op).join('、')}`,
    })
    return {
      id: pid, kind: 'edit', course: spec.course, ops: spec.ops.length,
      ...(spec.note ? { operators: growthOperatorsOf(spec.ops), ...(spec.note.disagreement ? { disagreement: true } : {}) } : {}),
      ...(warns.length ? { warns } : {}),
    }
  }

  /** 终点守卫的 IO 薄壳（纯判定住模块层 endpointGuardErrorsOf；propose/apply 双门经
   * editGateErrors 同调消费）。 */
  private async endpointGuardErrors(root: string, spec: EditProposalSpec): Promise<string[]> {
    return endpointGuardErrorsOf(spec, await readAnchors(this.paths.anchorPath(root), this.fs))
  }


  /** graph apply-edit：概念对表复验 → 铸名与图随写入单元落盘 + 改名/移动/删除联动课程
   * 笔记 + 快照。登记表先写（孤儿条目合法、悬空引用违约），graph 落盘在后。
   * #316 起无罗盘批内重写：弧的写权归罗盘站（learnhub_compass_paint）。 */
  async applyEdit(pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }): Promise<GraphApplyEditResult> {
    if (!audit.ok) throw new Error(`[apply-edit] 审计门存在 ERROR，拒绝写入（明细随行附上；报告人也读得到：课程根/审计报告.md）。`
      + (audit.errors?.length ? `\n${audit.errors.map(e => `  ✗ ${e}`).join('\n')}` : ''))
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
    const existing = await this.concepts.load()
    const { errors: mintErrors, entries: mergedEntries } = applyConceptMints(existing, spec.concepts ?? [])
    const conceptErrors = [...mintErrors, ...conceptReferenceErrors(conceptRefsOfOps(spec.ops), namesOf(mergedEntries))]
    if (conceptErrors.length) {
      throw new Error(`[apply-edit] 概念引用对表失败，提案不落盘。\n${conceptErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const nodes = await store.load()
    const graph = new Graph(nodes)
    // 门复验统一走 editGateErrors（门同源，ADR-0088）：结构重放/概念对表（铸名合并集）/锚
    // 保护/巩固门/生长闸门一次跑全——受理与 apply 之间图/登记表/锚可能变化，双门全过才写盘。
    const gateErrors = await editGateErrors(spec, {
      nodes, graph, entries: mergedEntries,
      anchors: await readAnchors(this.paths.anchorPath(root), this.fs),
      growthGate: this.growthGate,
      entryDetailOf: conceptEntryDetailOf(mergedEntries, graph),
    })
    if (gateErrors.length) {
      throw new Error(`[apply-edit] 门复验拒绝写入（提案已不适用当前图或门状态已变，被拒绝可重提）。\n${gateErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 生长闸门复验（#146）已并入上方 editGateErrors（门同源）。

    const renames: Record<string, string> = {}
    const dels: string[] = []
    for (const op of spec.ops) {
      if (op.op === 'rename') renames[op.node!] = op.new!
      else if (op.op === 'del_node') dels.push(op.node!)
    }
    // 笔记联动口径（#313 A1）：同批 del_node X + add_node X（或 rename B→X）= 改写/顶替这个名字，
    // 不是「删掉再新建一份」——旧笔记不归档（正文原地留给同名新节点，骨架补齐不覆盖已有文件），
    // 否则模型的「先删后建」改写会把学习者正文推进 state/archive 再补一个空骨架。真消失的名字照旧归档。
    const readded = new Set([
      ...spec.ops.filter(o => o.op === 'add_node').map(o => o.name!),
      ...Object.values(renames),
    ])
    const archived = dels.filter(n => !readded.has(n))

    // 2. data/图.yaml 重写（内存侧应用 ops；落盘动作进下方写入单元）
    applyOpsToNodes(nodes, spec.ops)
    // 应用后的图（#315 B2）：sealed 维护步的「闭包真已学」读数必须看**本批接线后**的
    // 闭包——收尾批的语义就是把终点接到最终台阶，用接线前的旧图会让新接入的未学子树
    // 逃出判定，降级门在主形态下失效。旧 `graph`（接线前快照）仍供笔记联动定位旧位置。
    const graphAfter = new Graph(nodes)

    // 写入单元（#176）：写序照今天的声明——「铸名 → 图重写 → 终点锚 sealed 维护
    // （#202）→ 笔记联动 → 边实验账本 → 快照 → 笔记骨架 → journal(graph_edit)
    // → 提案 applied」。铸名孤儿条目合法、悬空引用违约（登记表先写、图在后）；
    // 巩固门/生长闸全过才进写序。失败上抛中止，不回滚不续跑，失败不写
    // journal；重放被 takePending/simulateOps 门拦住（重放不保证收敛，靠门不靠续段）。
    // （#316：原「罗盘批内重写」步退场——弧的写权归罗盘站 learnhub_compass_paint。）
    const probationRegistered: string[] = []
    let nodes2: Awaited<ReturnType<GraphStore['load']>> = []
    let version = 0
    try {
      await runWriteUnit('applyEdit', {
        clock: this.clock!,
        journal: rec => this.store.appendJournal(rec),
        steps: [
          {
            // 写序第一笔照旧：此后任一步失败，登记表至多多出孤儿条目（合法态）——
            // 反过来图先写会让引用悬空；铸名幂等已在上方 applyConceptMints 门内
            name: '铸名落概念登记表',
            run: async () => {
              if (spec.concepts?.length) await this.concepts.save(mergedEntries)
            },
          },
          {
            name: '图重写',
            run: async () => {
              await store.writeGraphDoc(nodes)
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
              // sealed 谓词单一出处 sealedDecisionOf（#271 / ADR-0088：apply 与草稿内核同调）；
              // #315 B2 收尾前置：传入闭包真已学读数——未学完的终点降级为普通接线批
              // （接线照做、不落 sealed），零降级时与旧纯结构判据逐字等价。
              const anchorsNow = await readAnchors(this.paths.anchorPath(root), this.fs)
              const state = this.stateOf ? await this.stateOf(root) : undefined
              const readings = state ? structureReadingsOf(graphAfter, state, anchorsNow) : undefined
              const decision = sealedDecisionOf(spec.ops, anchorsNow,
                readings ? ep => {
                  const r = readings.find(x => x.endpoint === ep)
                  return { total: r?.total ?? 0, unlearned: r?.unlearned ?? [ep] }
                } : undefined)
              if (!decision.effects.length) return
              const today = todayStr(new Date(this.clock.nowMs()))
              const anchorPath = this.paths.anchorPath(root)
              const next: EndpointAnchor[] = anchorsNow.map(a => {
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
              for (const [oldName, newName] of Object.entries(renames)) await this.relocateNote(prop.course, root, graph, oldName, newName)
              for (const node of archived) await this.archiveNote(root, graph, node, prop.id)
            },
          },
          {
            // 3.6 边实验账本登记（#146；#327 随条目走）：operator=插入 的每条 add_node
            //     登记一条在途复诊（node/pre = 登记快照、proposal = 本批提案 id、
            //     due = 该条目预注册学习日数）——到期结算钩子据此自动裁决（proven｜
            //     自动剪除），零人审。混算子批里只登记插入条目。
            name: '边实验账本登记',
            run: async () => {
              for (const op of spec.ops) {
                if (op.op !== 'add_node' || op.operator !== '插入') continue
                await appendProbationEntry(this.paths, root, {
                  node: op.name!, pre: [...(op.pre ?? [])], proposal: prop.id,
                  due: op.recheck?.days ?? RECHECK_DAYS_DEFAULT,
                }, this.fs)
                probationRegistered.push(op.name!)
              }
            },
          },
          {
            name: '快照',
            run: async () => {
              nodes2 = await store.load()
              version = (await this.store.latestSnapshotVersion(course.name)) + 1
              await this.store.saveSnapshot(course.name, version, snapshotDoc(store, nodes2))
            },
          },
          {
            // 逐节点 existsSync 跳过（步骤内幂等：已有笔记的节点不覆盖）
            name: '笔记骨架补齐',
            run: async () => { await this.ensureNotesFor(root, nodes2) },
          },
          {
            // detail 三段：操作清单（add_node 显示 name，其余显示 node）→ 铸名 → 生长批裁决；
            // 零操作批（裁决暂不产结构）也要留痕可读
            name: '操作 journal',
            run: async () => {
              const opList = spec.ops.map(o => `${o.op}(${o.op === 'add_node' ? o.name : o.node})`).join('；')
              const mintList = spec.concepts?.length ? `；铸名 ${spec.concepts.map(c => c.canonical).join('、')}` : ''
              const detail = (opList || '（零操作，裁决留痕）')
                + mintList
                + (spec.note ? `；生长批（${operatorFoldOf(spec.ops)}）：${spec.note.reason}` : '')
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
    } catch (err) {
      // 半途失败的状态与出路（#313 C8）：写单元不回滚，所以「图已改、提案仍 pending、草稿水位
      // 不动」是可能态。此前这个事实只写在源码注释里——模型与人只看到一行原始异常，随后重投
      // 被门以「add_node 重名」拒（**错误行与真死因反向**，事故里模型据此怀疑有人抢跑、反复
      // del+add 重铸）。这里把分界与两条出路随错随行；失败点由 runWriteUnit 的前缀给出。
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`${msg}\n`
        + `【半途失败的状态】写入单元不回滚：失败点之前的写入（铸名/图重写/快照…）已落盘，`
        + `提案 #${prop.id} 仍在 pending（重放会被门以「重名/断边」拒，别重放）。\n`
        + `  出路：核对 data/图.yaml 的现势后 reject 本提案并按现状重提；草稿会话用 draft_revert 丢弃本批未发布增量重开。`)
    }
    // 种子图豁免（#142）：apply 后图仍 = 终点锚种子节点全集时健康分不设阈值
    const seedPhase = isSeedGraph(await readAnchors(this.paths.anchorPath(root), this.fs), new Graph(nodes2))
    return {
      course: course.name,
      ops: spec.ops.length,
      snapshot: version,
      renames,
      deleted: dels,
      ...(spec.note
        ? { operators: growthOperatorsOf(spec.ops), coach_reason: spec.note.reason, ...(spec.note.disagreement ? { disagreement: true } : {}) }
        : {}),
      ...(probationRegistered.length
        ? {
            probation_registered: probationRegistered,
            rechecks: spec.ops
              .filter(o => o.op === 'add_node' && o.operator === '插入' && probationRegistered.includes(o.name!))
              .map(o => ({ node: o.name!, metric: o.recheck!.metric, due: o.recheck?.days ?? RECHECK_DAYS_DEFAULT })),
          }
        : {}),
      findings: applyFindings(audit, seedPhase),
    }
  }

  // ---- 建课（ADR-0076：名称即空图）----

  /** 名称建课（ADR-0076 §一：建课 = 名称即空图）：面板只收一个课程名，一个写入单元
   * 落全部脚手架——注册表条目（enabled）+ 课程根目录（data/课程/state）+
   * `data/图.yaml`（{ nodes: [] }，空图的合法载体：GraphStore.load 正常读取，#284）+
   * `state/终点锚.json`（空锚，合法空态）+
   * `罗盘.md` 脚手架。概念登记表不再随建课落盘（v0.4 / ADR-0089 跨课程化：登记表是
   * 中心级一份，缺失即合法空态，随首次铸名出现）。**不自动初始化生成**：零节点图不入任何自动触发点（零节点闸），
   * 第一次生长由学习者在教练台显式下发（加终点是**纯声明**、不触发任何生成，ADR-0076 §三
   * / #313 D21——此处旧注释写「或加终点触发」与实现相反）。写序 = 脚手架在先、注册表条目在后：
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
    const entry: CourseEntry = { id: `${root}-01`, name: trimmed, root, enabled: true }
    await runWriteUnit('createCourse', {
      course: trimmed,
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '课程脚手架（目录/空图/终点锚/罗盘）',
          run: async () => {
            for (const sub of ['data', '课程', 'state']) await this.fs.mkdir(`${this.centerRoot}/${root}/${sub}`)
            await store.writeGraphDoc([])
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
   * 零 pre 新节点落 data/图.yaml（#284 单文件图）+ 落一条锚（可选一句目标描述给教练读；
   * 目标类型默认能力锚定、不露表单）。人手加终点不过资格判据（人是权威），但结构门照旧：
   * 课程必须已注册、图内不得重名（对已有正文/题库/调度/est 的节点名加终点一律拒）、
   * 锚集合不得重名。不提供改名、不提供「把已有节点设为终点」（撞纯标记红线）。 */
  async addEndpoint(courseName: string, endpointName: string, goalNote?: string): Promise<{ course: string; endpoint: string }> {
    const course = await this.registry.get(courseName.trim())
    if (!course) throw new Error(`[endpoint-add] 注册表中没有课程「${courseName.trim()}」——先建课（名称即空图）。`)
    const name = endpointName.trim()
    if (!name) throw new Error('[endpoint-add] 终点名不能为空。')
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root), this.fs)
    const nodes = await store.load()
    const graph = new Graph(nodes)
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
          name: '终点节点落图（零 pre）',
          run: async () => {
            nodes.push({ name, pre: [], opt: false, note: '', enc: [] })
            await store.writeGraphDoc(nodes)
          },
        },
        {
          name: '终点锚落盘',
          run: async () => {
            await writeAnchors(anchorPath, [...anchors, anchor], this.fs)
          },
        },
        {
          // #316 触发接线：方向声明变更 = 重估事件——罗盘置「重画待办」标记（只标记
          // 不触发；compass_paint 重画落盘新正文时自然清除）。罗盘缺席则无对象，跳过。
          name: '罗盘重画待办标记',
          run: async () => {
            const compassPath = this.paths.compassPath(root)
            if (!this.fs.exists(compassPath)) return
            const base = await this.fs.readFile(compassPath)
            const body = sectionBody(parseCompass(base), SECTION_ROUTE)
            if (!hasPaintedRoute(body)) return
            await atomicWrite(compassPath,
              withSectionText(base, SECTION_ROUTE, withRepaintMarker(body ?? '', `新增终点「${name}」`)), this.fs)
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
    const nodes = await store.load()
    // 内存侧先改好节点列表（摘终点节点 + 全图摘指向它的 pre 边；台阶留在图上成为末端）
    const unhooked: string[] = []
    for (const n of nodes) {
      if (n.name === name) continue
      if (n.pre.includes(name)) {
        n.pre = n.pre.filter(p => p !== name)
        unhooked.push(n.name)
      }
    }
    const kept = nodes.filter(n => n.name !== name)
    const anchorsNext = anchors.filter(a => a.endpoint !== name)
    await runWriteUnit('removeEndpoint', {
      course: course.name,
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '图重写（摘终点节点与指向它的 pre 边）',
          run: async () => {
            await store.writeGraphDoc(kept)
          },
        },
        {
          name: '锚记录移除',
          run: async () => {
            await writeAnchors(anchorPath, anchorsNext, this.fs)
          },
        },
        {
          // #316 触发接线：终点删除 = 目的地重估——罗盘置「重画待办」标记（幂等；
          // 罗盘缺席或未画则无对象，跳过）。
          name: '罗盘重画待办标记',
          run: async () => {
            const compassPath = this.paths.compassPath(root)
            if (!this.fs.exists(compassPath)) return
            const base = await this.fs.readFile(compassPath)
            const body = sectionBody(parseCompass(base), SECTION_ROUTE)
            if (!hasPaintedRoute(body)) return
            await atomicWrite(compassPath,
              withSectionText(base, SECTION_ROUTE, withRepaintMarker(body ?? '', `删除终点「${name}」`)), this.fs)
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
    const nodes = await store.load()
    const graph = new Graph(nodes)
    const missing = enrichMissingTargets(spec.fields, graph)
    if (missing.length) {
      throw new Error(`[propose-enrich] 目标节点不在图内，提案未受理：${missing.join('、')}（覆盖层只补写既有节点；新增节点走 kind=edit）`)
    }
    const abs = store.graphPath()
    if (!this.fs.exists(abs)) throw new Error(`[propose-enrich] 图文件不存在（图加载不一致）: ${abs}`)
    const fingerprints: Record<string, string> = { 'data/图.yaml': sha256(await this.fs.readFile(abs)) }
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
    if (!audit.ok) throw new Error(`[apply-enrich] 审计门存在 ERROR，拒绝写入（明细随行附上；报告人也读得到：课程根/审计报告.md）。`
      + (audit.errors?.length ? `\n${audit.errors.map(e => `  ✗ ${e}`).join('\n')}` : ''))
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
    const nodes = await store.load()
    const graph = new Graph(nodes)
    const missing = enrichMissingTargets(spec.fields, graph)
    if (missing.length) throw new Error(`[apply-enrich] 目标节点已不在图内：${missing.join('、')}。`)
    // 内存侧改好节点列表（enc 整体替换；不是落盘动作，落盘步骤见下方写入单元声明）
    const byName = new Map(nodes.map(n => [n.name, n]))
    for (const f of spec.fields) {
      const n = byName.get(f.node)
      if (n) n.enc = f.enc.map(e => ({ ...e }))
    }
    // 写入单元（#176）：写序照今天的声明——图正典重写 → 覆盖层留痕 → 快照 →
    // journal(graph_enrich) → 提案 applied（覆盖层/快照只在正典写成功后）。
    // 指纹复核（上方）就是防重放门：部分 apply 后重放必被拒收。失败上抛中止，
    // 不回滚不续跑，失败不写 journal；恢复 = reject 后基于新正典重提。
    let version = 0
    await runWriteUnit('applyEnrich', {
      clock: this.clock!,
      journal: rec => this.store.appendJournal(rec),
      steps: [
        {
          name: '图正典重写',
          run: async () => {
            await store.writeGraphDoc(nodes)
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
              content_hash: spec.fingerprints!['data/图.yaml'],
              applied_at: now,
            }))
            await this.fs.mkdir(this.paths.courseStateDir(root))
            await this.fs.appendFile(this.paths.overlayPath(root), lines.join('\n') + '\n')
          },
        },
        {
          name: '快照',
          run: async () => {
            const nodes2 = await store.load()
            version = (await this.store.latestSnapshotVersion(course.name)) + 1
            await this.store.saveSnapshot(course.name, version, snapshotDoc(store, nodes2))
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
      files: ['data/图.yaml'],
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
    const entries = await this.concepts.load()
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
    const entries = await this.concepts.load()
    const merged = mergeConceptEntries(entries, v.spec.from, v.spec.into)
    if (merged.errors.length) {
      throw new Error(`[concept-merge-apply] 合并未执行（登记表保持原样——受理后登记表已变，reject 本提案重提）。\n${merged.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const src = resolveConcept(entries, v.spec.from)!
    await this.concepts.save(merged.entries)
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
    const entries = await this.concepts.load()
    const ea = resolveConcept(entries, pair.a)
    const eb = resolveConcept(entries, pair.b)
    if (!ea || !eb) {
      throw new Error(`[concept-confusable-propose] 候选（「${pair.a}」↔「${pair.b}」）有名字不在登记表在册——候选只从在册概念派生。`)
    }
    if (isDeprecated(ea) || isDeprecated(eb)) {
      throw new Error(`[concept-confusable-propose] 候选（「${ea.canonical}」↔「${eb.canonical}」）含废弃条目——废弃条目退出候选面。`)
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
        // 提案去重扫描跳过留痕（#291 / ADR-0091）：产物缺失/损坏的旧提案不参与比对
        this.logger.debug('graph.proposal.scan_skip', { kind: 'confusable_pair', id: p.id })
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
    const entries = await this.concepts.load()
    const ea = resolveConcept(entries, v.spec.a)
    const eb = resolveConcept(entries, v.spec.b)
    if (!ea || !eb) throw new Error(`[concept-confusable-apply] 候选两端（「${v.spec.a}」「${v.spec.b}」）已不在登记表在册——reject 本提案重提。`)
    if (isDeprecated(ea) || isDeprecated(eb)) {
      throw new Error(`[concept-confusable-apply] 「${ea.canonical}」↔「${eb.canonical}」含废弃条目——废弃条目退出候选面。`)
    }
    const r = await this.concepts.addConfusable(ea.canonical, eb.canonical)
    await this.store.appendJournal({
      course: course.name, node: '*', rating: null, kind: 'concept_confusable', elapsed_days: 0,
      session: String(prop.id),
      detail: `易混对入册「${r.a}」→「${r.b}」${r.changed ? '' : '（已声明，幂等）'}（候选提案 #${prop.id} 人确认；单向是待复核态）`,
    })
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(),
      decision_note: `易混对「${r.a}」→「${r.b}」入册`,
    })
    return { kind: 'confusable_pair', course: course.name, a: r.a, b: r.b, changed: r.changed }
  }

  /** 改名联动课程笔记：搬文件 + 更新 fm.node + 题库随迁；无笔记静默跳过。 */
  private async relocateNote(course: string, root: string, graph: Graph, node: string, newName?: string): Promise<void> {
    if (!graph.nset.has(node)) return
    const oldPath = this.paths.courseNotePath(root, node)
    const targetName = newName ?? node
    if (this.fs.exists(oldPath)) {
      const { loadNote, saveNote } = await import('../vault/notes.ts')
      const { fm, body } = await loadNote(oldPath, this.fs)
      const newPath = this.paths.courseNotePath(root, targetName)
      await saveNote(newPath, { ...(fm ?? {}), node: targetName }, body, this.fs)
      if (oldPath.toLowerCase() !== newPath.toLowerCase()) {
        // 新内容（fm.node=新名）已写入 newPath；摘除旧文件。
        // 不能 rename(oldPath, newPath)——会把旧 frontmatter 覆盖回新路径。
        // unlink 失败 fail loud（#295）：清空正文的破坏性回退比可见的旧档残留更危险。
        try {
          await this.fs.unlink(oldPath)
        } catch (err) {
          throw new Error(
            `[concept-apply] 概念改名后旧笔记摘除失败：${oldPath}\n`
            + `  新档已写入 ${newPath}，旧档残留（新档是准），请手工删除。\n`
            + `  ✗ ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    // 题库随迁（改名时；无题库静默跳过）
    if (newName) {
      const { safeFilename } = await import('../infra/paths.ts')
      const bankDir = this.paths.courseRoot(root)
      const oldBank = `${bankDir}/题库/${safeFilename(node)}.yaml`
      if (this.fs.exists(oldBank)) {
        // 随迁失败 fail loud（#295；#291 的 graph.apply.bank_follow_miss 随吞错点消失
        // 退役——fail loud 已是更强的可见性，不必再留 WARN 指针）
        try {
          await this.fs.rename(oldBank, `${bankDir}/题库/${safeFilename(targetName)}.yaml`)
        } catch (err) {
          throw new Error(
            `[concept-apply] 题库随迁失败：题库仍挂旧节点名「${node}」（${oldBank}），与新节点名「${targetName}」不一致，请手工改名。\n`
            + `  ✗ ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  /** del_node：课程笔记与题库移入 state/archive（不丢用户内容）。 */
  private async archiveNote(root: string, graph: Graph, node: string, pid: number): Promise<void> {
    if (!graph.nset.has(node)) return
    const oldPath = this.paths.courseNotePath(root, node)
    const archiveDir = `${this.paths.courseStateDir(root)}/archive`
    const { safeFilename } = await import('../infra/paths.ts')
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

/** add_node op → GNode（模拟与实落共用一个构造；概念字段组随 op 携带，键名统一后取 name）。
 * 概念字段组形状在此 fail loud（#301 缺陷②）：此前对非列表 `misconceptions` 取 `.length`
 * 静默丢字段（数据丢失零反馈）、对字符串列表 `{...m}` 摊成 `{concept: undefined}` 鬼条目
 * （再经 misconceptionCapErrors 报出「概念"undefined"已有 N 条」的伪错误）——草稿重放与
 * 受理门两路都从这里漏。形状归一只发生在草稿补丁入口（暂存宽容 #301 缺陷①），权威门
 * 见到的非法形状一律 fail loud：`replayDraft` 逐 op 收下这行，不让异常穿透门序列。 */
function nodeFromAddOp(op: EditOp): GNode {
  const teaches = tierMapOf(op, 'teaches')
  const assumes = tierMapOf(op, 'assumes')
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
    ...(teaches ? { teaches } : {}),
    ...(assumes ? { assumes } : {}),
    ...(op.misconceptions !== undefined ? { misconceptions: misconceptionEntriesOf(op) } : {}),
  }
}

/** op.teaches/assumes → 概念→档映射（**非映射者 fail loud**，理由同 misconceptionEntriesOf：
 * 配对列表/字符串被 `{...raw}` 摊成 `{0:[…]}` 这类伪映射，再经概念对表报成「引用「0」未在册」
 * ——误导排查。配对列表的宽容形态只在草稿补丁入口归一（#301 缺陷①），权威门只管合法形态；
 * 档位枚举与尺寸带仍归 parseConceptFields。 */
function tierMapOf(op: EditOp, field: 'teaches' | 'assumes'): Record<string, ConceptTier> | undefined {
  const raw: unknown = op[field]
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? '列表' : typeof raw
    throw new Error(`add_node「${op.name ?? ''}」.${field} 形状非法（收到${got}）：teaches/assumes 是「概念→档」映射 {概念: 档}——配对列表 [[概念, 档], …] 请直接写映射后重提`)
  }
  return { ...(raw as Record<string, ConceptTier>) }
}

/** op.misconceptions → 条目列表（**不能忠实落图者 fail loud**；条目内其余形状——未知键、
 * 缺 model——仍归 parseConceptFields 逐条裁，不在这里复刻第二套契约）。判据就是
 * 「能否取到一枚真概念名」：取不到时旧实现会摊出 `{concept: undefined}` 的鬼条目，
 * 再经 misconceptionCapErrors 报成「误解封顶越界: 概念"undefined"已有 N 条」——误导
 * 排查（#301 缺陷①的鬼错误症状），故这一形态在此就地拦下。 */
function misconceptionEntriesOf(op: EditOp): Misconception[] {
  const raw: unknown = op.misconceptions
  if (!Array.isArray(raw)) {
    const got = typeof raw === 'object' && raw !== null ? '字典' : typeof raw
    throw new Error(`add_node「${op.name ?? ''}」.misconceptions 形状非法（收到${got}）：误解必须是条目列表 [{concept, model}]——字典形 {概念: [文字…]} 请拆成逐条条目后重提`)
  }
  const entries: Misconception[] = []
  for (const [j, item] of raw.entries()) {
    const m = item as Record<string, unknown> | null
    if (m === null || typeof m !== 'object' || Array.isArray(m) || typeof m.concept !== 'string' || !m.concept.trim()) {
      throw new Error(`add_node「${op.name ?? ''}」.misconceptions 第 ${j + 1} 项不是合法条目（一条字符串拆不出它属于哪个概念）：每条写成 {concept: 在册概念名, model: 错误模型文字}`)
    }
    entries.push({ ...m } as unknown as Misconception)
  }
  return entries
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
export function replayDraft(nodes: GNode[], graph: Graph, ops: EditOp[]): DraftReplay {
  const sim: GNode[] = JSON.parse(JSON.stringify(nodes))
  const errors: string[] = []
  const names = new Set(graph.names)
  const renameMap: Record<string, string> = {}
  /** 被本批删除的**节点身份**（不是名字——#313 A1/A3）：`del_node X` + 同批 `add_node X`
   * 是「先删后建」这一最自然的改写写法（模型修 teaches/误解 时唯一可用的形态，因为概念
   * 字段组只在 add_node 出生时写），按名字记账会把**新节点**一起滤掉（原节点被归档、
   * 新节点消失，journal 却写着 del+add，diff 还报「新增」）。按身份记账后：删的是「此刻
   * 图上那个节点」，后来的同名新节点不算被删；指向旧名的入边在批末重新落到同名新节点上
   * （`pre`/`enc` 不再按名字被无声剪掉——真断边由下方 `变更后断边` 门报出）。 */
  const removed = new Set<GNode>()
  const removedNames: string[] = []
  const added: string[] = []
  const rewired: Array<{ node: string; pres_before: string[]; pres_after: string[] }> = []

  for (const op of ops) {
    if (op.op === 'add_node') {
      if (names.has(op.name!)) { errors.push(`add_node 重名: ${op.name}`); continue }
      // 概念字段组的形状错误逐 op 收下（#301 缺陷②）：抛出去会穿透整条门序列
      let fresh: GNode
      try {
        fresh = nodeFromAddOp(op)
      } catch (e) {
        errors.push((e as Error).message)
        continue
      }
      sim.push(fresh)
      names.add(op.name!)
      added.push(op.name!)
    } else if (op.op === 'del_node') {
      if (!names.has(op.node!)) { errors.push(`del_node 节点不存在: ${op.node}`); continue }
      const hit = sim.find(n => n.name === op.node && !removed.has(n))
      if (hit) removed.add(hit)
      removedNames.push(op.node!)
      names.delete(op.node!)
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
      for (const n of sim) {
        if (n.name === op.node && !removed.has(n)) n.pre = [...(op.pre ?? [])]
      }
    } else if (op.op === 'set_enc') {
      if (!names.has(op.node!)) { errors.push(`set_enc 节点不存在: ${op.node}`); continue }
      for (const n of sim) {
        if (n.name === op.node && !removed.has(n)) n.enc = normalizeOpEnc(op.enc)
      }
    } else if (op.op === 'set_note') {
      if (!names.has(op.node!)) { errors.push(`set_note 节点不存在: ${op.node}`); continue }
      for (const n of sim) {
        if (n.name === op.node && !removed.has(n)) n.note = op.note ?? ''
      }
    }
  }

  const mapped = (p: string) => renameMap[p] ?? p
  for (const n of sim) {
    if (removed.has(n)) continue
    n.name = mapped(n.name)
    n.pre = n.pre.map(mapped)
    n.enc = n.enc.map(e => ({ ...e, node: mapped(e.node) }))
  }
  const simKept = sim.filter(n => !removed.has(n))
  if (!errors.length) {
    const merged = new Graph(simKept)
    const removedSet = new Set(removedNames)
    // 断边不再被静默摘除（#313 A3）：del_node 此前顺手 filter 掉所有指向被删节点的 pre/enc
    // 入边，于是「删掉一个还有人依赖的节点」永不报错、只静默改变下游的前置集合（对照
    // pruneProbationNode / removeEndpoint 都显式做摘边恢复，说明这里是漏的而非设计）。
    // 现在由本门 fail loud，错误行给可执行出路（显式 set_pre 摘桥 / 改用 rename）。
    const dangling = new Map<string, string>()
    for (const n of merged.names) {
      for (const p of merged.preOf[n]) if (!merged.nset.has(p)) dangling.set(`${n} -> ${p}`, p)
    }
    for (const [edge, missing] of [...dangling].sort()) errors.push(`变更后断边: ${edge}${removedSet.has(missing) ? `（「${missing}」被本批删除，但这条 pre 边还指着它——del_node 不再替你摘边：先对依赖它的节点 set_pre {node: <消费方>, pre: [...]} 显式摘桥，或改用 rename 保住节点）` : ''}`)
    const encDangling = new Map<string, string>()
    for (const n of merged.names) {
      for (const [p] of merged.encOf[n] ?? []) if (!merged.nset.has(p)) encDangling.set(`${n} ~enc~ ${p}`, p)
    }
    for (const [edge, missing] of [...encDangling].sort()) errors.push(`变更后 enc 断边: ${edge}${removedSet.has(missing) ? `（「${missing}」被本批删除——同上，先 set_enc 摘掉这条成分技能边）` : ''}`)
    if (merged.hasCycle) errors.push(`变更后引入环：${merged.cycleNodes.slice(0, 5).join('、')}`)
    // 误解封顶移出本函数（#313 C9/C12）：它要按 canonical 与**变更前**的计数比对，两者都
    // 需要登记表——归 editGateErrors 统一裁（replayDraft 只管结构面）。
  }
  const diff: DraftDiff = {
    added_nodes: added,
    removed_nodes: removedNames,
    renamed: Object.entries(renameMap).map(([from, to]) => ({ from, to })),
    added_edges: rewired.flatMap(w =>
      w.pres_after.map(mapped).filter(p => !w.pres_before.includes(p)).map(p => ({ node: mapped(w.node), pre: p }))),
    rewired: rewired.map(w => ({ node: mapped(w.node), pres_before: w.pres_before.map(mapped), pres_after: w.pres_after.map(mapped) })),
  }
  return { errors, diff }
}

/** 在节点列表副本上模拟全部操作 → 错误列表（内部改调 replayDraft——草稿与门同源，ADR-0088）。 */
export function simulateOps(nodes: GNode[], graph: Graph, ops: EditOp[]): string[] {
  return replayDraft(nodes, graph, ops).errors
}

/** op 列表落在一份深拷贝上的产物（门里的派生读数——误解封顶的「变更后」一侧）。
 * 与 applyOpsToNodes 同一套记账，不另写一遍应用逻辑。 */
function simulatedNodes(nodes: GNode[], ops: EditOp[]): GNode[] {
  const sim: GNode[] = JSON.parse(JSON.stringify(nodes))
  applyOpsToNodes(sim, ops)
  return sim
}

/** 把 op 列表实际落到节点列表（applyEdit 落图前的内存侧应用）。与 replayDraft 同一套
 * 记账口径（#313 A1/A3）：删除按**节点身份**记（同名 del+add 的新节点不被误删），
 * `pre`/`enc` 只做改名映射、不再按被删名过滤——真断边在门里就被拒，落不到这里。 */
export function applyOpsToNodes(nodes: GNode[], ops: EditOp[]): void {
  const renameMap: Record<string, string> = {}
  const removed = new Set<GNode>()
  const findNode = (node: string): GNode | null => nodes.find(x => x.name === node && !removed.has(x)) ?? null

  for (const op of ops) {
    if (op.op === 'add_node') {
      nodes.push(nodeFromAddOp(op))
    } else if (op.op === 'del_node') {
      const hit = findNode(op.node!)
      if (hit) removed.add(hit)
    } else if (op.op === 'rename') {
      renameMap[op.node!] = op.new!
    } else if (op.op === 'set_pre') {
      const hit = findNode(op.node!)
      if (hit) hit.pre = [...(op.pre ?? [])]
    } else if (op.op === 'set_enc') {
      const hit = findNode(op.node!)
      if (hit) hit.enc = normalizeOpEnc(op.enc)
    } else if (op.op === 'set_note') {
      const hit = findNode(op.node!)
      if (hit) hit.note = op.note ?? ''
    }
  }

  const mapped = (p: string) => renameMap[p] ?? p
  for (const n of nodes) {
    if (removed.has(n)) continue
    n.name = mapped(n.name)
    n.pre = n.pre.map(mapped)
    n.enc = n.enc.map(e => ({ ...e, node: mapped(e.node) }))
  }
  const kept = nodes.filter(n => !removed.has(n))
  nodes.length = 0
  nodes.push(...kept)
}

// ---- 图提案受理结果（#152 刀 5 自 views.ts 归位）----







