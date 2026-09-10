/**
 * agent 产出（图/变更）的门禁与落盘 + 提案生命周期（吸收自 Python gen.py）。
 *
 * 流程铁律：agent 产出 YAML → schema 校验 → 结构检查（断边/环/冲突）→
 * 提案落盘 pending（产物文件全留痕）→ 人审 → apply 过 audit 门禁生效 → journal + 快照。
 * 拒绝同样留痕（status=rejected）。
 */
import { readFile, writeFile, rename, mkdir, unlink, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { YAML } from './yaml.ts'
import { Store, atomicWrite } from './store.ts'
import { Graph, GraphStore, loadRegionDoc, parseNode, parseConceptFields, parseEnc, misconceptionCapErrors, snapshotDoc, structureCheck } from './graph.ts'
import { ConceptRegistry, applyConceptMints, conceptReferenceErrors, mintConflicts, namesOf, validateConceptEntry } from './concepts.ts'
import type { ConceptEntry, ConceptRef } from './concepts.ts'
import { saveNote, defaultFrontmatter } from './notes.ts'
import {
  validateSeedProposal, seedNodeToGNode, anchorFromSeed, readAnchor, writeAnchor, isSeedGraph,
} from './seed.ts'
import type { SeedProposalSpec } from './seed.ts'
import { readVaultLinksCache, splitPriorFeed } from './vault-links.ts'
import type { PriorFeedVerdict } from './vault-links.ts'
import {
  SECTION_ANNOTATIONS, SECTION_ETA, SECTION_ROUTE, ROUTE_PENDING, ETA_PENDING,
  compassScaffold, withSectionText, parseCompass, sectionBody, validateRouteBody, stripWrappingFence,
} from './compass.ts'
import { todayStr } from './dates.ts'
import { appendProbationEntry, recheckPreregOf } from './probation.ts'
import type { RecheckPrereg } from './probation.ts'
import { RECHECK_DAYS_DEFAULT } from './params.ts'
import type { GRegion, GBlock, GNode, BloomLevel, EncEdge, ConceptTier, Misconception, GrowthOperator } from './types.ts'
import { BLOOM_LEVELS, PROPOSAL_KINDS, GROWTH_OPERATORS } from './types.ts'
import type { Paths } from './paths.ts'
import type { Store } from './store.ts'
import type { CourseEntry, ProposalKind } from './types.ts'

/** apply 门禁的审计快照（facade 层跑 audit 后传入；findings 由 warns + 健康分组成）。 */
export interface ApplyAudit { ok: boolean; warns: string[]; health: number }

export interface GenProposalSpec {
  course: string
  mode: 'new' | 'append'
  regions: Array<{ region: string; color?: string; blocks: Array<{ name: string; nodes: GNode[] }> }>
}

export interface EditOp {
  op: 'add_node' | 'del_node' | 'set_pre' | 'set_enc' | 'rename' | 'move' | 'set_note'
  node?: string
  /** add_node 的节点键（#131 §7 键名统一：与图 YAML/parseNode 同名，旧 `node` 键退役）。 */
  name?: string
  new?: string
  region?: string
  block?: string
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
 * 结构，罗盘重写照走同事务）。#146 起插入批随批预注册复诊（note.recheck：恰一枚
 * 可机判 metric + 复诊期缺省 10 学习日 clamp [5,20]），apply 同事务登记边实验账本。 */
export interface GrowthNote {
  operator: GrowthOperator
  reason: string
  /** 真分歧声明（disagreement）：轻量段裁决与上下文/批注存在实质分歧时声明，宿主
   * 升级全量段重裁（两段式 effort；显然步免仲裁税不声明）。字段名避让「申诉
   * （Dispute，ADR-0031）」词条——同名同义纪律。 */
  disagreement?: string
  /** 复诊预注册（#146 词条「复诊」）：只随 operator=插入 且本批有 add_node 的批携带
   * （其他算子携带即拒收；插入批缺预注册拒收）——metric 恰一枚（前进恢复/卡点集中度
   * 降幅/保留率恢复），days 缺省 10 学习日 clamp [5,20]。 */
  recheck?: RecheckPrereg
}

/** 提案 op 上的边轻纪律键（#127：候选边留提案侧留痕、origin 从 journal 派生、
 * 复诊状态落 state/边实验.jsonl——提案节点同样零边元数据字段，一律拒收不静默丢弃）。 */
const RETIRED_OP_KEYS = ['origin', 'status', 'probation'] as const

export interface EditProposalSpec {
  course: string
  reason?: string
  /** 铸名块（#141 登记机械化）：随生长批提案铸名入册，与图 apply 同事务落盘；
   * 提案被拒则登记不落盘。省略 = 本批零铸名。 */
  concepts?: ConceptEntry[]
  ops: EditOp[]
  /** 生长批 note 区（#145）：在场 = 生长批（教练回合裁决产物）；缺席 = 普通 edit 提案。 */
  note?: GrowthNote
  /** 罗盘批内重写（#145）：「剩余路线」段新正文，与图 apply 同事务落盘——提案被拒
   * 罗盘不落盘。唯一写权属生长批（note 在场）；普通 edit 提案携带即拒收。 */
  route?: string
}

const EDIT_OPS = ['add_node', 'del_node', 'set_pre', 'set_enc', 'rename', 'move', 'set_note'] as const

/** 批内 add_node 数（插入登记/调速闸门的「本批新增」口径单点；解析前 doc.ops 与
 * EditOp[] 同形消费）。 */
export function addNodeCountOf(ops: Array<{ op?: unknown }> | undefined): number {
  return (ops ?? []).filter(o => o.op === 'add_node').length
}

/** gen 骨架提案退役（#138 cutover / ADR-0033 生长式图）：受理门统一拒收，新课程
 * 入口由种子提案接管（#142），反编译子图入口已重接为种子簇（#149：learnhub_project_decompile
 * 产 project_plan + seed 双提案，同进同退）。 */
export function genRetiredError(what: string): Error {
  return new Error(
    `[${what}] kind=gen 骨架提案已退役（#138 cutover / ADR-0033 生长式图）——`
    + '新课程入口由种子提案接管（#142），课程结构变更用 kind=edit；'
    + '存量 pending gen 提案不再受理 apply（reject 留痕）。')
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

/** GenProposal schema 校验（手写，错误行格式与旧引擎一致）。 */
export function validateGenProposal(doc: unknown): { errors?: string[]; spec?: GenProposalSpec } {
  const errors: string[] = []
  const d = doc as Record<string, unknown> | null
  if (typeof d !== 'object' || d === null) return { errors: ['(顶层): 必须是映射'] }
  try {
    nonempty(d.course, 'course')
  } catch (e) { errors.push((e as Error).message) }
  if (d.mode === undefined) errors.push('mode: 缺失（必填，只允许 new/append：新增课程写 new，向已有课程追加写 append）')
  else if (d.mode !== 'new' && d.mode !== 'append') errors.push('mode: 只允许 new/append（新增课程写 new；向已有课程追加写 append）')
  const regions: GenProposalSpec['regions'] = []
  if (!Array.isArray(d.regions) || !d.regions.length) {
    errors.push('regions: 不能为空')
  } else {
    d.regions.forEach((rr: unknown, i: number) => {
      const r = rr as Record<string, unknown> | null
      const where = `regions.${i}`
      if (typeof r !== 'object' || r === null) {
        errors.push(`${where}: 必须是映射`)
        return
      }
      if (typeof r.region !== 'string' || !r.region.trim()) {
        const hint = typeof r.name === 'string' && r.name.trim()
          ? `（区条目的键是 region，不是 name——你写了 name: ${r.name.trim()}）`
          : ''
        errors.push(`${where}.region 不能为空${hint}`)
      }
      const blocks: GenProposalSpec['regions'][number]['blocks'] = []
      if (!Array.isArray(r.blocks) || !r.blocks.length) {
        errors.push(`${where}.blocks: 块[${String(r.region)}] 没有节点`)
      } else {
        r.blocks.forEach((br: unknown, bi: number) => {
          const b = br as Record<string, unknown> | null
          if (typeof b !== 'object' || b === null || typeof b.name !== 'string' || !b.name.trim()) {
            errors.push(`${where}.blocks.${bi}: 块 name 不能为空`)
            return
          }
          if (!Array.isArray(b.nodes)) {
            errors.push(`${where}.blocks.${bi}: 块[${b.name}] nodes 必须是列表`)
            return
          }
          const rawNodes = b.nodes
          const nodes: GNode[] = []
          if (!rawNodes.length) {
            errors.push(`${where}.blocks.${bi}: 块[${b.name}] 没有节点`)
            return
          }
          // 受理前复用持久图节点解析，避免 gen 专用宽松解析把坏数据留到 apply 时才暴露。
          rawNodes.forEach((rawNode: unknown, ni: number) => {
            try {
              nodes.push(parseNode(rawNode, '生成提案', `${where}.blocks.${bi}.nodes.${ni}`))
            } catch (e) {
              errors.push((e as Error).message)
            }
          })
          blocks.push({ name: b.name.trim(), nodes })
        })
      }
      regions.push({ region: typeof r.region === 'string' ? r.region.trim() : '', color: typeof r.color === 'string' ? r.color : '', blocks })
    })
  }
  if (errors.length) return { errors }
  return { spec: { course: (d!.course as string).trim(), mode: (d!.mode as 'new' | 'append') ?? 'append', regions } }
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
      const unknown = Object.keys(n).filter(k => !['operator', 'reason', 'disagreement', 'recheck'].includes(k))
      if (unknown.length) {
        noteErrors.push(`note 含未知字段 ${JSON.stringify(unknown)}（只允许 operator/reason/disagreement/recheck；分歧声明写在 disagreement，复诊预注册写在 recheck）`)
      }
      if (!(GROWTH_OPERATORS as readonly string[]).includes(String(n.operator))) {
        noteErrors.push(`note.operator: 非法算子 ${JSON.stringify(String(n.operator))}（允许 ${GROWTH_OPERATORS.join('/')}）`)
      }
      if (typeof n.reason !== 'string' || !n.reason.trim()) {
        noteErrors.push('note.reason 不能为空（每步生长都带理由——可解释、可追问）')
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
    // 生长批允许零操作（裁决=暂不产结构；罗盘重写与批留痕照走同事务）
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
        errors.push(`${where}.op: 非法操作 ${String(op)}（允许 ${EDIT_OPS.join('/')}）`)
        return
      }
      // 边轻纪律（#127）：提案节点同样零边元数据字段——静默丢弃会丢生长语义，fail loud。
      const retired = Object.keys(o).filter(k => (RETIRED_OP_KEYS as readonly string[]).includes(k))
      if (retired.length) {
        errors.push(`${where}: 提案 op 不接受边元数据字段 ${JSON.stringify(retired)}（origin 从提案 journal 派生、复诊状态落 state/边实验.jsonl——图与提案节点零边字段）`)
      }
      // 键名统一到 name（#131 §7 / #1：与图 YAML、gen 节点同口径，不做兼容双读也不容双写）——
      // add_node 用 name 定义新节点；其余 op 用 node 引用既有节点。写错键一律 fail loud。
      if (op === 'add_node') {
        if (o.node !== undefined && String(o.node).trim()) {
          errors.push(`${where}: op=add_node 不接受 node 键（键名已统一到 name——你写了 node: ${String(o.node).trim()}；速查表见技能文档）`)
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
      if ((op === 'add_node' || op === 'move') && !(o.region && o.block)) errors.push(`${where}: op=${op} 需要 region 与 block（分区定位：区名 + 块名）`)
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
        region: typeof o.region === 'string' ? o.region.trim() : undefined,
        block: typeof o.block === 'string' ? o.block.trim() : undefined,
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
  const taught = new Set<string>()
  for (const n of graph.names) for (const c of Object.keys(graph.teachesOf[n] ?? {})) taught.add(c)
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

/** 种子提案全部概念引用（起点/终点节点的概念字段组；铸名随种子提案同事务落盘）。 */
function conceptRefsOfSeed(spec: SeedProposalSpec): ConceptRef[] {
  const refs: ConceptRef[] = []
  for (const [where, node] of [...spec.starts.map((s, i) => [`starts.${i}`, s] as const), ['endpoint', spec.endpoint] as const]) {
    for (const concept of Object.keys(node.teaches ?? {})) refs.push({ where: `teaches[${where}(${node.name})]`, concept })
    for (const concept of Object.keys(node.assumes ?? {})) refs.push({ where: `assumes[${where}(${node.name})]`, concept })
    for (const m of node.misconceptions ?? []) refs.push({ where: `misconceptions[${where}(${node.name})]`, concept: m.concept })
  }
  return refs
}

/** apply 返回的 findings：audit warns 摘要 + 健康分不足提示（引擎不设阈值，
 * 结束条件「≥ 80」归 learnhub-graph-generate 技能的 agent 纪律）。
 * seedPhase=true 时健康分提示豁免（#142：种子图健康分不设阈值——起点/终点几张
 * 节点的图分数必然低，提示是噪音；生长批进入后恢复）。 */
export function applyFindings(audit: ApplyAudit, seedPhase = false): string[] {
  const findings = audit.warns.map(w => `⚠ ${w}`)
  if (!seedPhase && audit.ok && audit.health > 0 && audit.health < 80) {
    findings.push(`⚠ 图谱健康分 ${audit.health} < 80：结束条件未满足，继续分批构建（learnhub_graph_analyze 的 health/suggestions 给出方向）`)
  }
  return findings
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

export class GraphProposals {
  private concepts: ConceptRegistry
  constructor(
    private paths: Paths,
    private store: Store,
    private registry: { get(key: string): Promise<CourseEntry | null>; load(): Promise<CourseEntry[]>; save(c: CourseEntry[]): Promise<void> },
    private centerRoot: string,
    /** 生长闸门（#146 插入/旁支调速）：受理与 apply 双门在 schema 门后调用——需要
     * 三率流水（账本/提案/练习），由门面注入（本类零流水依赖）；返回拒收行，空 = 放行。 */
    private growthGate?: (spec: EditProposalSpec) => Promise<string[]>,
  ) {
    this.concepts = new ConceptRegistry(paths)
  }

  /** 概念引用对表门（#141）：teaches/assumes/误解 的概念引用必须精确命中登记表
   * 在册名字（canonical 或别名）或提案铸名块的铸名；铸名与登记表撞名同样
   * 拒收。返回错误行列表（空 = 通过）。root 参数是课程 root（非路径）。
   * edit 与 seed（#142）共用。 */
  private async conceptGateErrors(root: string, refs: ConceptRef[], mints: ConceptEntry[]): Promise<string[]> {
    const existing = await this.concepts.load(root) // 登记表 Broken 在此抛错，apply 不落盘
    const errors = mintConflicts(mints, existing)
    const known = namesOf([...existing, ...mints])
    errors.push(...conceptReferenceErrors(refs, known))
    return errors
  }

  /** 为图中缺笔记的节点补骨架文件（幂等）：gen/edit apply 落图后调用。
   * 节点存在于图就该有 frontmatter 文件——vault 笔记是调度状态的事实源。 */
  async ensureNotesFor(root: string, regions: GRegion[]): Promise<number> {
    let created = 0
    for (const r of regions) {
      for (const b of r.blocks) {
        for (const n of b.nodes) {
          const path = this.paths.courseNotePath(root, r.name, n.name)
          if (existsSync(path)) continue
          await saveNote(path, defaultFrontmatter(n.name) as unknown as Record<string, unknown>, '> 内容待生成。\n')
          created++
        }
      }
    }
    return created
  }

  /** 提案产物 YAML 落盘（全留痕）→ artifact 路径。 */
  private async saveArtifact(kind: ProposalKind, course: string, doc: unknown): Promise<{ pid: number; path: string }> {
    const pid = await this.store.createProposal(kind, course, '', '')
    const path = this.paths.proposalArtifactPath(pid, kind, course)
    await mkdir(this.paths.proposalDir, { recursive: true })
    await writeFile(path, YAML.stringify(doc), 'utf8')
    await this.store.updateProposal(pid, { artifact: path })
    return { pid, path }
  }

  private async loadArtifact(path: string): Promise<unknown> {
    if (!existsSync(path)) throw new Error(`[gen] 文件不存在: ${path}`)
    return YAML.parse(await readFile(path, 'utf8'))
  }

  /** graph propose-edit：在内存图上模拟执行 + 概念引用对表 + 终点锚保护 + 巩固门
   * （#145）→ pending。warns = 受理门的非阻提示（窄节点等概念字段组提示），随受理
   * 回执返给提案方。note 在场 = 生长批：summary 带算子标签与理由（每步可解释）。 */
  async proposeEdit(yamlText: string): Promise<Record<string, unknown>> {
    const warns: string[] = []
    const v = validateEditProposal(YAML.parseModel(yamlText), warns)
    if (v.errors) throw new Error(`[propose-edit] schema 校验失败，提案未受理。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[propose-edit] 注册表中没有课程「${spec.course}」。`)
    const regions = await new GraphStore(this.paths, this.paths.courseRoot(course.root)).load()
    const graph = new Graph(regions)
    const errors = simulateOps(regions, graph, spec.ops)
    const conceptErrors = await this.conceptGateErrors(course.root, conceptRefsOfOps(spec.ops), spec.concepts ?? [])
    // 终点锚保护（#142 雾区条款下半）：锚定的终点节点不可经 edit 直改——
    // del_node/rename 会把锚悬空，换终点只走重新种子提案（kind=seed, mode=reseed）。
    const anchorErrors = await this.anchorGuardErrors(course.root, spec.ops)
    // 巩固门（#145）：operator=巩固 的 add_node 只引已教概念。
    const consolidationErrors = consolidationGateErrors(spec.note?.operator, spec.ops, graph)
    if (errors.length || conceptErrors.length || anchorErrors.length || consolidationErrors.length) {
      throw new Error(`[propose-edit] 提案未受理（修正后重提）。\n`
        + [...errors, ...conceptErrors, ...anchorErrors, ...consolidationErrors].map(e => `  ✗ ${e}`).join('\n'))
    }
    // 生长闸门（#146 插入/旁支调速）：三率超限/复诊通过率触底时插入与旁支闸停（低数据
    // 静默）——插入积极性的调速器在受理门就拦，不让超速批落 pending。
    const gateErrors = this.growthGate ? await this.growthGate(spec) : []
    if (gateErrors.length) {
      throw new Error(`[propose-edit] 生长闸门拒绝受理（插入积极性调速，#146）。\n${gateErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 罗盘重写预检（#145 同事务：提案被拒罗盘不落盘——route 门在受理时就走一遍，
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
   * （未播种 fail loud）+ 路线门（非空/无标题/限长）。 compass.ts 的写权机械不变。 */
  private async routeGate(root: string, routeMd: string): Promise<string[]> {
    const anchor = await readAnchor(this.paths.anchorPath(root))
    if (!anchor) return ['课程未播种（终点锚 Missing）——罗盘重写锚在终点上，先走种子提案（kind=seed）。']
    return validateRouteBody(stripWrappingFence(routeMd))
  }

  /** 终点锚保护（#142）：edit 提案不得 del/rename 锚定的终点节点——那是绕开
   * 种子提案通道的锚直改。其余 op（set_pre/set_enc/move/set_note）不构成「换终点」，
   * 不拦——结构生长照常。 */
  private async anchorGuardErrors(root: string, ops: EditOp[]): Promise<string[]> {
    const anchor = await readAnchor(this.paths.anchorPath(root))
    if (!anchor) return []
    const errors: string[] = []
    for (const [i, op] of ops.entries()) {
      if (op.node !== anchor.endpoint) continue
      if (op.op === 'del_node') {
        errors.push(`ops.${i}: del_node 拒绝——「${op.node}」是终点锚锚定的终点（${anchor.declared} 声明，提案 #${anchor.origin_proposal}）。锚无直改通道，换终点走重新种子提案（kind=seed, mode=reseed）`)
      } else if (op.op === 'rename') {
        errors.push(`ops.${i}: rename 拒绝——「${op.node}」是终点锚锚定的终点（${anchor.declared} 声明，提案 #${anchor.origin_proposal}）。锚无直改通道，换终点走重新种子提案（kind=seed, mode=reseed）`)
      }
    }
    return errors
  }

  /** graph apply-edit：概念对表复验 → 铸名与图同事务落盘 + 改名/移动/删除联动课程
   * 笔记 + 罗盘批内重写（#145：route 在场时与图 apply 同事务——路线门/巩固门全过
   * 才开始任何写盘，提案被拒罗盘不落盘）+ 快照。登记表先写（孤儿条目合法、悬空引用
   * 违约），graph 落盘在后。 */
  async applyEdit(pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }): Promise<Record<string, unknown>> {
    if (!audit.ok) throw new Error('[apply-edit] 审计存在 ERROR，拒绝写入——先处理 审计报告.md。')
    const prop = await this.store.takePending('edit', pid)
    const v = validateEditProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[apply-edit] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[apply-edit] 注册表中没有课程「${spec.course}」。`)
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root))
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
    const errors = simulateOps(regions, graph, spec.ops) // 二次校验
    if (errors.length) throw new Error('[apply-edit] 提案已不适用当前图（被拒绝，可重提）。')
    // 终点锚保护复验（#142）：受理与 apply 之间锚可能新落（种子 apply 并发），
    // 两门全过才开始任何写盘。
    const anchorErrors = await this.anchorGuardErrors(root, spec.ops)
    if (anchorErrors.length) {
      throw new Error(`[apply-edit] 终点锚保护拒绝写入——换终点只走重新种子提案（kind=seed）。\n${anchorErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 巩固门复验（#145）：受理与 apply 之间图可能变化，已教概念集在当前图上重算。
    const consolidationErrors = consolidationGateErrors(spec.note?.operator, spec.ops, graph)
    if (consolidationErrors.length) {
      throw new Error(`[apply-edit] 巩固门拒绝写入——巩固节点只引已教概念。\n${consolidationErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 罗盘重写预检（#145 同事务最后一道门）：路线门与锚复验不过 = 零写盘。
    let compassRoute: string | null = null
    if (spec.route !== undefined) {
      const routeErrors = await this.routeGate(root, spec.route)
      if (routeErrors.length) {
        throw new Error(`[apply-edit] 罗盘重写未过路线门，提案不落盘。\n${routeErrors.map(e => `  ✗ ${e}`).join('\n')}`)
      }
      compassRoute = stripWrappingFence(spec.route)
    }
    // 生长闸门复验（#146）：受理与 apply 之间三率可能被其他批的结算/登记推移，
    // 双门全过才开始任何写盘（与巩固门同款纪律）。
    const gateErrors = this.growthGate ? await this.growthGate(spec) : []
    if (gateErrors.length) {
      throw new Error(`[apply-edit] 生长闸门拒绝写入（插入积极性调速，#146）。\n${gateErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }

    // 1. 铸名随生长批落盘（同事务第一笔：此后任一步失败，登记表至多多出孤儿条目——
    //    合法态；反过来图先写会让引用悬空）
    if (spec.concepts?.length) await this.concepts.save(root, mergedEntries)

    const createdBlocks = new Set<string>()
    for (const op of spec.ops) {
      if (op.op !== 'add_node') continue
      const region = regions.find(r => r.name === op.region)
      if (region && !region.blocks.some(b => b.name === op.block)) createdBlocks.add(op.block!)
    }

    const renames: Record<string, string> = {}
    const moves: Array<[string, string, string]> = []
    const dels: string[] = []
    for (const op of spec.ops) {
      if (op.op === 'rename') renames[op.node!] = op.new!
      else if (op.op === 'move') moves.push([op.node!, op.region!, op.block!])
      else if (op.op === 'del_node') dels.push(op.node!)
    }

    // 2. data/*.yaml 重写
    applyOpsToRegions(regions, spec.ops)
    const files = await store.regionFiles()
    for (const region of regions) {
      if (region.name in files) await store.writeRegionDoc(files[region.name], region)
    }

    // 3. 改名/移动/删除联动课程笔记（用 ops 应用前的图定位旧文件位置；
    //    graphAfter 里旧名已不存在/位置已变，会让联动静默失效）
    for (const [oldName, newName] of Object.entries(renames)) await this.relocateNote(root, graph, oldName, newName, undefined)
    for (const [node, regionName] of moves) await this.relocateNote(root, graph, node, undefined, regionName)
    for (const node of dels) await this.archiveNote(root, graph, node, prop.id)

    // 3.5 罗盘批内重写（#145 同事务）：路线门已过、只换「剩余路线」段，批注区/ETA
    //     字节保留；罗盘缺席落脚手架打底（与 compassRewrite 同语义）。
    let compassRewritten = false
    if (compassRoute !== null) {
      const compassPath = this.paths.compassPath(root)
      const base = existsSync(compassPath) ? await readFile(compassPath, 'utf8') : compassScaffold(course.name)
      await atomicWrite(compassPath, withSectionText(base, SECTION_ROUTE, compassRoute))
      compassRewritten = true
    }

    // 3.6 边实验账本登记（#146 同事务）：插入批的每个 add_node 登记一条在途复诊
    //     （node/pre = 登记快照、proposal = 本批提案 id、due = 预注册学习日数）——
    //     到期结算钩子据此自动裁决（proven｜自动剪除），零人审。
    const probationRegistered: string[] = []
    if (spec.note?.operator === '插入' && spec.note.recheck) {
      const due = spec.note.recheck.days ?? RECHECK_DAYS_DEFAULT
      for (const op of spec.ops) {
        if (op.op !== 'add_node') continue
        await appendProbationEntry(this.paths, root, {
          node: op.name!, pre: [...(op.pre ?? [])], proposal: prop.id, due,
        })
        probationRegistered.push(op.name!)
      }
    }

    const regions2 = await store.load()
    const version = (await this.store.latestSnapshotVersion(course.name)) + 1
    await this.store.saveSnapshot(course.name, version, snapshotDoc(store, regions2))
    await this.ensureNotesFor(root, regions2)
    // detail 三段：操作清单（add_node 显示 name，其余显示 node）→ 铸名 → 生长批裁决；
    // 零操作批（裁决暂不产结构）也要留痕可读
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
    await this.store.updateProposal(prop.id, { status: 'applied', decided: new Date().toISOString(), decision_note: `快照 v${version}` })
    // 种子图豁免（#142）：apply 后图仍 = 终点锚种子节点全集时健康分不设阈值
    const seedPhase = isSeedGraph(await readAnchor(this.paths.anchorPath(root)), new Graph(regions2))
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

  // ---- 种子提案（kind=seed，#142：课程新入口 + 终点锚；gen 骨架退役后接管）----

  /** 先验喂料分流判定（#142）：≥0.7 候选对在给定图结构上的回应情况。缓存缺文件 =
   * 零候选（Missing 合法空态，零先验零注入全绿）；坏档 fail loud（引擎 state 契约文件）。 */
  private async priorFeed(graph: Graph): Promise<{ responded: PriorFeedVerdict[]; unresponded: PriorFeedVerdict[] }> {
    const cache = await readVaultLinksCache(this.paths.vaultLinksPath)
    if (!cache) return { responded: [], unresponded: [] }
    return splitPriorFeed(cache.edges, graph.names, graph)
  }

  /** graph propose-seed（#142）：课程新入口（gen 骨架退役后接管）。schema 门 →
   * 注册表状态对账（new/reseed）→ 结构检查（投影图）→ 概念对表 → 先验喂料分流
   * （≥0.7 未被结构回应的候选进 warns，非阻——喂料分流取代人审分流）→ pending，
   * 一次人审即开工。 */
  async proposeSeed(yamlText: string): Promise<Record<string, unknown>> {
    const warns: string[] = []
    const v = validateSeedProposal(YAML.parseModel(yamlText), warns)
    if (v.errors) throw new Error(`[propose-seed] schema 校验失败，提案未受理。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const course = await this.registry.get(spec.course)
    if (spec.mode === 'new' && course) {
      throw new Error(`[propose-seed] mode=new 但课程「${spec.course}」已在注册表——重新种子/换终点写 mode=reseed。`)
    }
    if (spec.mode === 'reseed' && !course) {
      throw new Error(`[propose-seed] mode=reseed 但注册表中没有课程「${spec.course}」——新课程入口写 mode=new。`)
    }
    // 对表/检查用的课程根：新课程尚无注册表条目，root 约定 = 课程名（initCourse 同款）
    const root = course?.root ?? spec.course
    const store = new GraphStore(this.paths, this.paths.courseRoot(root))
    const existingRegions: GRegion[] = []
    for (const path of Object.values(await store.regionFiles())) {
      existingRegions.push(loadRegionDoc(YAML.parse(await readFile(path, 'utf8')), path))
    }
    const seedRegions = seedSpecToRegions(spec)
    const errors = structureCheck(existingRegions.length ? new Graph(existingRegions) : null, seedRegions, '种子提案')
    const conceptErrors = await this.conceptGateErrors(root, conceptRefsOfSeed(spec), spec.concepts ?? [])
    // 先验喂料分流：在投影后的合并图上判回应（含本提案新节点）
    const feed = await this.priorFeed(new Graph([...existingRegions, ...seedRegions]))
    warns.push(...priorFeedWarns(feed.unresponded))
    if (errors.length || conceptErrors.length) {
      throw new Error(`[propose-seed] 提案未受理（修正后重提）。\n`
        + [...errors, ...conceptErrors].map(e => `  ✗ ${e}`).join('\n'))
    }
    const { pid } = await this.saveArtifact('seed', spec.course, YAML.parseModel(yamlText))
    await this.store.updateProposal(pid, {
      summary: `种子（${spec.goal_type === 'coverage' ? '覆盖锚定' : '能力锚定'}）：${spec.starts.length} 起点 → 终点「${spec.endpoint.name}」`
        + (spec.worksheet?.length ? `；块工作表 ${spec.worksheet.length} 项` : ''),
    })
    return {
      id: pid, kind: 'seed', course: spec.course, mode: spec.mode,
      goal_type: spec.goal_type, endpoint: spec.endpoint.name, starts: spec.starts.length,
      ...(spec.worksheet?.length ? { worksheet: spec.worksheet.length } : {}),
      prior_feed_unresponded: feed.unresponded.length,
      ...(warns.length ? { warns } : {}),
    }
  }

  /** graph apply-seed（#142）：概念对表复验 + 结构复验 →（mode=new 建课脚手架）→
   * 落图（起点 + 终点 + 朝终点的粗占位边）→ 终点锚落盘（整份覆盖：换终点/换工作表
   * 都只走种子提案人审，锚无直改通道）→ 铸名 + 快照 + 笔记脚手架 + journal。
   * 同源双提案守卫（#149）：反编译 pair 联动的种子提案不得先于计划半区单独 apply
   * （联合入口走 opts.pairApply 豁免；计划已生效的恢复续段放行）。 */
  async applySeed(
    pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }, today?: string,
    opts: { pairApply?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    if (!audit.ok) throw new Error('[apply-seed] 审计存在 ERROR，拒绝写入——先处理 审计报告.md。')
    const prop = await this.store.takePending('seed', pid)
    const pairBlock = Store.pairApplyBlock(prop, await this.store.loadProposals(), opts)
    if (pairBlock) throw new Error(`[apply-seed] ${pairBlock}`)
    const v = validateSeedProposal(await this.loadArtifact(prop.artifact))
    if (v.errors || !v.spec) throw new Error(`[apply-seed] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec
    let course = await this.registry.get(spec.course)
    if (spec.mode === 'new') {
      if (course) {
        throw new Error(`[apply-seed] mode=new 但课程「${spec.course}」已被注册（受理后状态变化）——reject 本提案后按 mode=reseed 重提。`)
      }
      course = await this.initCourse(spec.course)
    }
    if (!course) throw new Error(`[apply-seed] 注册表中没有课程「${spec.course}」。`)
    const root = course.root
    const store = new GraphStore(this.paths, this.paths.courseRoot(root))
    // 概念对表复验（#141 同款：受理与 apply 之间登记表可能变化；铸名侧幂等），两门全过才开始写盘
    const existing = await this.concepts.load(root)
    const { errors: mintErrors, entries: mergedEntries } = applyConceptMints(existing, spec.concepts ?? [])
    const conceptErrors = [...mintErrors, ...conceptReferenceErrors(conceptRefsOfSeed(spec), namesOf(mergedEntries))]
    if (conceptErrors.length) {
      throw new Error(`[apply-seed] 概念引用对表失败，提案不落盘。\n${conceptErrors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    // 结构复验：图可能在受理后变化（重名/断边/环在合并视图上重查）
    const existingFiles = await store.regionFiles()
    const existingRegions: GRegion[] = []
    for (const path of Object.values(existingFiles)) {
      existingRegions.push(loadRegionDoc(YAML.parse(await readFile(path, 'utf8')), path))
    }
    const seedRegions = seedSpecToRegions(spec)
    const errors = structureCheck(existingRegions.length ? new Graph(existingRegions) : null, seedRegions, '种子提案')
    if (errors.length) {
      throw new Error(`[apply-seed] 提案已不适用当前图（被拒绝，可重提）。\n${errors.map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const createdBlocks = new Set<string>()
    const existingBlocks = new Map<string, Set<string>>()
    for (const region of existingRegions) existingBlocks.set(region.name, new Set(region.blocks.map(b => b.name)))
    for (const region of seedRegions) {
      const current = existingBlocks.get(region.name)
      for (const block of region.blocks) {
        if (!current?.has(block.name)) createdBlocks.add(block.name)
      }
    }

    // 1. 铸名随种子落盘（同事务第一笔：登记表先写，图在后——孤儿条目合法、悬空引用违约）
    if (spec.concepts?.length) await this.concepts.save(root, mergedEntries)

    // 2. data/*.yaml 落图（既有区按块名合并；新区新建文件——gen 同款布局）
    const written: string[] = []
    for (const region of seedRegions) {
      const path = existingFiles[region.name]
      if (path) {
        const current = loadRegionDoc(YAML.parse(await readFile(path, 'utf8')), path)
        const byName = new Map(current.blocks.map(b => [b.name, b]))
        for (const nb of region.blocks) {
          const hit = byName.get(nb.name)
          if (hit) hit.nodes.push(...nb.nodes)
          else current.blocks.push(nb)
        }
        await store.writeRegionDoc(path, current)
      } else {
        const idx = Object.keys(existingFiles).length + written.length
        await store.writeRegionDoc(`${this.paths.dataDir(root)}/${String(idx).padStart(2, '0')}_${region.name}.yaml`, region)
      }
      written.push(region.name)
    }

    // 3. 终点锚落盘（课程唯一结构承诺物；整份覆盖写——换终点走重新种子提案）
    const declared = today ?? todayStr()
    const anchor = anchorFromSeed(spec, prop.id, declared)
    await writeAnchor(this.paths.anchorPath(root), anchor)

    // 4. 罗盘常驻（#143 / ADR-0033 透明度装置）：种子 apply 落罗盘——新建 = 脚手架
    //    （路线/ETA 待初画与周挂载接管）；reseed（换终点）= 批注区字节保留，路线与
    //    ETA 重置占位（旧路线锚在旧终点上，初画重画后周挂载回填）。零 LLM 依赖，
    //    apply 永不被透明度装置挡住。
    const compassPath = this.paths.compassPath(root)
    const existingCompass = existsSync(compassPath) ? await readFile(compassPath, 'utf8') : null
    const compassNext = existingCompass
      ? withSectionText(withSectionText(existingCompass, SECTION_ROUTE, ROUTE_PENDING), SECTION_ETA, ETA_PENDING)
      : compassScaffold(course.name)
    await atomicWrite(compassPath, compassNext)

    const regions = await store.load()
    const version = (await this.store.latestSnapshotVersion(course.name)) + 1
    await this.store.saveSnapshot(course.name, version, snapshotDoc(store, regions))
    await this.ensureNotesFor(root, regions)
    await this.store.appendJournal({
      course: course.name, node: '*', rating: null, kind: 'graph_seed', elapsed_days: 0,
      session: String(prop.id),
      detail: `种子（${spec.goal_type === 'coverage' ? '覆盖锚定' : '能力锚定'}）：起点 ${spec.starts.map(s => s.name).join('、')} → 终点 ${spec.endpoint.name}；占位边 ${spec.starts.length} 条`
        + (spec.concepts?.length ? `；铸名 ${spec.concepts.map(c => c.canonical).join('、')}` : ''),
    })
    await this.store.updateProposal(prop.id, { status: 'applied', decided: new Date().toISOString(), decision_note: `终点锚落盘；快照 v${version}` })
    const merged = new Graph(regions)
    const feed = await this.priorFeed(merged)
    // 种子图豁免：图仍 = 种子节点全集时健康分不设阈值（findings 不带 <80 提示）
    const seedPhase = isSeedGraph(anchor, merged)
    return {
      course: course.name,
      mode: spec.mode,
      goal_type: spec.goal_type,
      endpoint: spec.endpoint.name,
      starts: spec.starts.map(s => s.name),
      declared,
      ...(spec.worksheet?.length ? { worksheet_items: spec.worksheet.length } : {}),
      regions: written,
      snapshot: version,
      created_blocks: [...createdBlocks],
      compass: existingCompass
        ? { state: 'reseeded' as const, annotations_preserved: Boolean(sectionBody(parseCompass(compassNext), SECTION_ANNOTATIONS)?.trim()) }
        : { state: 'scaffold' as const, annotations_preserved: false },
      prior_feed: { unresponded: feed.unresponded.length },
      findings: applyFindings(audit, seedPhase),
    }
  }

  /** mode=new 的建课脚手架：注册表条目 + data/课程/state 目录（原 gen 建课语义，
   * #142 随种子提案回归）。 */
  private async initCourse(name: string): Promise<CourseEntry> {
    const items = await this.registry.load()
    const root = name
    for (const sub of ['data', '课程', 'state']) {
      await mkdir(`${this.centerRoot}/${root}/${sub}`, { recursive: true })
    }
    const entry: CourseEntry = { id: `${root}-01`, name, root, enabled: true }
    items.push(entry)
    await this.registry.save(items)
    return entry
  }

  /** graph propose-enrich（富化覆盖层，#140）：schema 门 → 目标节点在图核验 →
   * 受影响正典文件计 sha256 指纹（写入 artifact，apply 时复核）→ pending。 */
  async proposeEnrich(yamlText: string): Promise<Record<string, unknown>> {
    const v = validateEnrichProposal(YAML.parseModel(yamlText))
    if (v.errors) throw new Error(`[propose-enrich] schema 校验失败，提案未受理。\n${v.errors.map(e => `  ✗ ${e}`).join('\n')}`)
    const spec = v.spec!
    const course = await this.registry.get(spec.course)
    if (!course) throw new Error(`[propose-enrich] 注册表中没有课程「${spec.course}」。`)
    const store = new GraphStore(this.paths, this.paths.courseRoot(course.root))
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
      if (!(rel in fingerprints)) fingerprints[rel] = sha256(await readFile(abs, 'utf8'))
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
  async applyEnrich(pid?: number, audit: ApplyAudit = { ok: true, warns: [], health: 0 }): Promise<Record<string, unknown>> {
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
    const store = new GraphStore(this.paths, this.paths.courseRoot(root))
    // 指纹复核先行：任一受影响正典文件在受理后被改过 → 提案基于旧版图，拒收（AC：指纹不符拒收）
    const stale: string[] = []
    for (const [rel, want] of Object.entries(spec.fingerprints)) {
      let cur: string
      try {
        cur = await readFile(`${this.paths.courseRoot(root)}/${rel}`, 'utf8')
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
    // 写正典：enc 整体替换 + 受影响区文件重写（同事务：快照/覆盖层留痕只在全部写成功后）
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
    for (const [regionName, text] of touched) {
      const abs = regionFiles[regionName]
      if (!abs) throw new Error(`[apply-enrich] 区「${regionName}」没有对应 data/*.yaml。`)
      await atomicWrite(abs, text)
      fileHashes.set(regionName, sha256(text))
    }
    // 覆盖层留痕（state/覆盖层.jsonl，追加只增；读侧只读正典，这里只是审计与出处）
    const now = new Date().toISOString()
    const lines = spec.fields.map(f => JSON.stringify({
      target: f.node,
      field: 'enc',
      value: f.enc,
      content_hash: fileHashes.get(graph.blockOf[f.node][1]),
      applied_at: now,
    }))
    await mkdir(this.paths.courseStateDir(root), { recursive: true })
    await appendFile(this.paths.overlayPath(root), lines.join('\n') + '\n', 'utf8')
    const regions2 = await store.load()
    const version = (await this.store.latestSnapshotVersion(course.name)) + 1
    await this.store.saveSnapshot(course.name, version, snapshotDoc(store, regions2))
    await this.store.appendJournal({
      course: course.name, node: '*', rating: null, kind: 'graph_enrich', elapsed_days: 0,
      session: String(prop.id), detail: spec.fields.map(f => `enc(${f.node})×${f.enc.length}`).join('；'),
    })
    await this.store.updateProposal(prop.id, { status: 'applied', decided: new Date().toISOString(), decision_note: `快照 v${version}` })
    return {
      course: course.name,
      fields: spec.fields.length,
      snapshot: version,
      files: [...touched.keys()],
      findings: applyFindings(audit),
    }
  }

  /** 改名/移动联动课程笔记：搬文件 + 更新 fm.node + 题库随迁；无笔记静默跳过。 */
  private async relocateNote(root: string, graph: Graph, node: string, newName?: string, newRegion?: string): Promise<void> {
    if (!graph.blockOf[node]) return
    const region = graph.blockOf[node][1]
    const oldPath = this.paths.courseNotePath(root, region, node)
    const targetName = newName ?? node
    const targetRegion = newRegion ?? region
    if (existsSync(oldPath)) {
      const { loadNote, saveNote } = await import('./notes.ts')
      const { fm, body } = await loadNote(oldPath)
      const newPath = this.paths.courseNotePath(root, targetRegion, targetName)
      await saveNote(newPath, { ...(fm ?? {}), node: targetName }, body)
      if (oldPath.toLowerCase() !== newPath.toLowerCase()) {
        // 新内容（fm.node=新名）已写入 newPath；摘除旧文件。
        // 不能 rename(oldPath, newPath)——会把旧 frontmatter 覆盖回新路径。
        await unlink(oldPath).catch(async () => {
          await writeFile(oldPath, '').catch(() => undefined)
        })
      }
    }
    // 题库随迁（改名时；无题库静默跳过）
    if (newName) {
      const { safeFilename } = await import('./paths.ts')
      const bankDir = this.paths.courseRoot(root)
      const oldBank = `${bankDir}/题库/${safeFilename(node)}.yaml`
      if (existsSync(oldBank)) {
        await rename(oldBank, `${bankDir}/题库/${safeFilename(targetName)}.yaml`).catch(() => undefined)
      }
    }
  }

  /** del_node：课程笔记与题库移入 state/archive（不丢用户内容）。 */
  private async archiveNote(root: string, graph: Graph, node: string, pid: number): Promise<void> {
    if (!graph.blockOf[node]) return
    const region = graph.blockOf[node][1]
    const oldPath = this.paths.courseNotePath(root, region, node)
    const archiveDir = `${this.paths.courseStateDir(root)}/archive`
    const { safeFilename } = await import('./paths.ts')
    if (existsSync(oldPath)) {
      await mkdir(archiveDir, { recursive: true })
      await rename(oldPath, `${archiveDir}/del-${pid}-${safeFilename(node)}.md`)
    }
    const oldBank = `${this.paths.courseRoot(root)}/题库/${safeFilename(node)}.yaml`
    if (existsSync(oldBank)) {
      await mkdir(archiveDir, { recursive: true })
      await rename(oldBank, `${archiveDir}/del-${pid}-${safeFilename(node)}.yaml`)
    }
  }

  /** graph reject。同源双提案联动（#149）：pair 在场的提案被拒时，pending 的另一半
   * 联动同拒（同进同退——反编译双提案是一个逻辑单元，半挂的 pending 只会误导人审）；
   * 已决的另一半不动（applied 不回滚、rejected 幂等）。 */
  async reject(pid: number, note = ''): Promise<Record<string, unknown>> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`[reject] 提案 id 必须是正整数（收到 ${String(pid)}）；拒绝不能省略 id。`)
    }
    const list = await this.store.loadProposals()
    const prop = list.find(p => p.id === pid)
    if (!prop || prop.status !== 'pending') throw new Error(`[reject] 提案 #${pid} 不存在或已决。`)
    await this.store.updateProposal(pid, { status: 'rejected', decided: new Date().toISOString(), decision_note: note })
    if (prop.pair) {
      const sibling = list.find(p => p.id === prop.pair)
      if (sibling && sibling.status === 'pending') {
        await this.store.updateProposal(sibling.id, {
          status: 'rejected', decided: new Date().toISOString(),
          decision_note: `同源双提案同退（#${pid} 已拒，联动拒绝）${note ? `：${note}` : ''}`,
        })
      }
    }
    return prop
  }

  /** 提案清单（status/kind 过滤可选）。kind 全集见 types PROPOSAL_KINDS（图谱域 + 项目域）。 */
  async list(status?: string, kind?: string, limit = 100): Promise<Record<string, unknown>[]> {
    let list = await this.store.loadProposals()
    if (status) {
      if (!['pending', 'applied', 'rejected'].includes(status)) throw new Error(`[proposals] 非法 status: ${status}（允许 pending/applied/rejected）`)
      list = list.filter(p => p.status === status)
    }
    if (kind) {
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`[proposals] 非法 kind: ${kind}（允许 ${PROPOSAL_KINDS.join('/')}）`)
      }
      list = list.filter(p => p.kind === kind)
    }
    return list.slice(-limit).reverse() as unknown as Record<string, unknown>[]
  }
}

/** GenProposal regions → GRegion（gen._spec_to_regions 同构；YAML 路径直接产 GNode）。 */
export function specToRegions(specRegions: GenProposalSpec['regions']): GRegion[] {
  return specRegions.map(r => ({
    name: r.region,
    color: r.color ?? '',
    blocks: r.blocks.map(b => ({
      name: b.name,
      nodes: b.nodes,
    })),
  }))
}

/** SeedProposal → GRegion[]（#142）：起点 pre=[]，终点 pre=起点——朝终点的粗占位边
 * （生长批用 set_pre 消化细化）；种子节点零 enc 零 est。同区同名块聚进同一块。 */
export function seedSpecToRegions(spec: SeedProposalSpec): GRegion[] {
  const byRegion = new Map<string, Map<string, GNode[]>>()
  const put = (node: GNode, region: string, block: string): void => {
    let blocks = byRegion.get(region)
    if (!blocks) { blocks = new Map(); byRegion.set(region, blocks) }
    let nodes = blocks.get(block)
    if (!nodes) { nodes = []; blocks.set(block, nodes) }
    nodes.push(node)
  }
  for (const s of spec.starts) put(seedNodeToGNode(s, []), s.region, s.block)
  put(seedNodeToGNode(spec.endpoint, spec.starts.map(s => s.name)), spec.endpoint.region, spec.endpoint.block)
  return [...byRegion.entries()].map(([name, blocks]) => ({
    name,
    color: '',
    blocks: [...blocks.entries()].map(([bname, nodes]) => ({ name: bname, nodes })),
  }))
}

/** 先验喂料分流的受理回执行（#142：≥0.7 须被结构显式回应——可见非阻，喂料分流
 * 取代人审分流；回应 = pre/enc 边落地，或 vault 重扫后候选自然消失）。 */
export function priorFeedWarns(unresponded: PriorFeedVerdict[]): string[] {
  return unresponded.map(v =>
    `≥0.7 先验候选未被结构回应: ${v.aNode} ~ ${v.bNode}（w=${v.w}）——喂料分流要求结构显式回应（补 pre/enc 边），或确属无关（重扫 vault 后消失）`)
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

/** 在 regions 副本上模拟全部操作 → 错误列表（gen._simulate_ops 同语义）。 */
export function simulateOps(regions: GRegion[], graph: Graph, ops: EditOp[]): string[] {
  const sim: GRegion[] = JSON.parse(JSON.stringify(regions))
  const errors: string[] = []
  const names = new Set(graph.names)
  const renameMap: Record<string, string> = {}
  const removed = new Set<string>()

  const regionOf = (name: string) => sim.find(r => r.name === name)

  for (const op of ops) {
    if (op.op === 'add_node') {
      if (names.has(op.name!)) { errors.push(`add_node 重名: ${op.name}`); continue }
      const r = regionOf(op.region!)
      if (!r) { errors.push(`add_node 区不存在: ${op.region}`); continue }
      let blk = r.blocks.find(b => b.name === op.block)
      if (!blk) {
        blk = { name: op.block!, nodes: [] }
        r.blocks.push(blk)
      }
      blk.nodes.push(nodeFromAddOp(op))
      names.add(op.name!)
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
    } else if (op.op === 'move') {
      if (!names.has(op.node!)) { errors.push(`move 节点不存在: ${op.node}`); continue }
      const dstRegion = regionOf(op.region!)
      if (!dstRegion) errors.push(`move 目标区不存在: ${op.region}`)
      else if (!dstRegion.blocks.some(b => b.name === op.block)) {
        errors.push(`move 目标块不存在（不允许静默建块）: ${op.region}/${op.block}`)
      }
    } else if (op.op === 'set_pre') {
      if (!names.has(op.node!)) { errors.push(`set_pre 节点不存在: ${op.node}`); continue }
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
  return errors
}

/** 把 op 列表实际落到 Region 对象列表（gen._apply_ops_to_regions 同语义）。 */
export function applyOpsToRegions(regions: GRegion[], ops: EditOp[]): void {
  const renameMap: Record<string, string> = {}
  const removed = new Set<string>()
  const regionOf = (name: string) => regions.find(r => r.name === name)
  const findNode = (node: string): { r: GRegion; b: GBlock; n: GNode } | null => {
    for (const r of regions) for (const b of r.blocks) {
      const n = b.nodes.find(x => x.name === node)
      if (n) return { r, b, n }
    }
    return null
  }

  for (const op of ops) {
    if (op.op === 'add_node') {
      const r = regionOf(op.region!)!
      let blk = r.blocks.find(b => b.name === op.block)
      if (!blk) {
        blk = { name: op.block!, nodes: [] }
        r.blocks.push(blk)
      }
      blk.nodes.push(nodeFromAddOp(op))
    } else if (op.op === 'del_node') {
      removed.add(op.node!)
    } else if (op.op === 'rename') {
      renameMap[op.node!] = op.new!
    } else if (op.op === 'move') {
      const hit = findNode(op.node!)
      if (!hit) continue
      hit.b.nodes = hit.b.nodes.filter(n => n.name !== op.node)
      const dstR = regionOf(op.region!)!
      let dstBlk = dstR.blocks.find(b => b.name === op.block)
      if (!dstBlk) {
        throw new Error(`[apply-edit] move 目标块不存在（不允许静默建块）: ${op.region}/${op.block}`)
      }
      dstBlk.nodes.push(hit.n)
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

export { atomicWrite }
