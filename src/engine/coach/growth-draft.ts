/**
 * 生长草稿缓存（#271 / ADR-0088 裁决 4）：教练执行会话的草稿快照落盘——vault 旁挂
 * `courseStateDir(root)/草稿/<sessionId>.json` 原子写（每批结束写，非逐 op），带
 * 「非活图、非提案」标记、不进提案生命周期；同课程同一时刻至多一份在途草稿，新会话
 * 遇在途草稿默认续建；finish 发布成功或显式取消时删除；进程重启可续建。
 *
 * 本文件只管**形状与 IO**，以及草稿补丁的糖算子展开与审计 findings 的纯函数
 * （#272；重放与门序列住 proposals.ts（replayDraft / editGateErrors——草稿通过 =
 * 门通过按构造成立），站编排住 growth-subsystem.ts（growth2.coachDraft）。
 */
import type { VaultFs } from '../infra/io.ts'
import { atomicWrite } from '../infra/io.ts'
import type { Paths } from '../infra/paths.ts'
import type { EditOp } from './proposals.ts'
import type { ConceptEntry } from '../concepts/concepts.ts'
import { nearNameCandidates, resolveConcept, validateConceptEntry } from '../concepts/concepts.ts'
import type { Graph } from '../graph/graph.ts'
import type { GNode, Misconception } from '../types.ts'
import type { EndpointAnchor } from './seed.ts'
import { render } from '../infra/prompt-render.ts'
import {
  FIND_CONFUSABLE_DANGLING, FIND_NEAR_NAME, FIND_ORPHAN_MINT, FIND_SEAL_TODO,
  OP_ERR_CHAIN_MIN, OP_ERR_CHAIN_PRE_LIST, OP_ERR_CONFUSABLE_FIELDS, OP_ERR_CONFUSABLE_SAME,
  OP_ERR_SPLIT_DUP, OP_ERR_SPLIT_ENDPOINT, OP_ERR_SPLIT_MIN, OP_ERR_SPLIT_MISSING, OP_ERR_SPLIT_NO_NODE,
  SHAPE_ERR_MINT_DICT, SHAPE_ERR_MINT_EMPTY, SHAPE_ERR_MINT_LIST, SHAPE_ERR_MINT_SHAPE,
  SHAPE_ERR_MIS_DICT_EMPTY, SHAPE_ERR_MIS_DICT_EMPTY_CONCEPT, SHAPE_ERR_MIS_DICT_VALUE,
  SHAPE_ERR_MIS_ITEM_MAP, SHAPE_ERR_MIS_ITEM_NO_CONCEPT, SHAPE_ERR_MIS_ITEM_NO_MODEL,
  SHAPE_ERR_MIS_ITEM_UNKNOWN, SHAPE_ERR_MIS_SHAPE, SHAPE_ERR_MIS_STRING_LIST,
  SHAPE_ERR_PAIR_EMPTY, SHAPE_ERR_PAIR_ITEM, SHAPE_ERR_TIER_MAP,
  SHAPE_NORM_MINT_DICT, SHAPE_NORM_MINT_NAME_KEY, SHAPE_NORM_MINT_NOT_LIST, SHAPE_NORM_MINT_STRING,
  SHAPE_NORM_MIS_BARE, SHAPE_NORM_MIS_DICT, SHAPE_NORM_TIER_PAIR,
  SHAPE_WORD_BOOLEAN, SHAPE_WORD_LIST, SHAPE_WORD_MAP, SHAPE_WORD_NULL, SHAPE_WORD_NUMBER,
  SHAPE_WORD_STRING, SHAPE_WORD_STRING_LIST,
} from '../prompts/coach-draft.ts'

/** 教练执行站的语料站标签（host STATIONS.growthDraft 引门面常量对齐；站名是受控词表）。 */
export const GROWTH_DRAFT_STATION = '教练执行'

/** 草稿文件的身份标记（读侧拒收非本格式文件的防呆面；「非活图、非提案」）。 */
export const GROWTH_DRAFT_MARKER = '生长草稿（非活图、非提案）'

/** 一条轮次日志（草稿快照的对话记忆面：续建时注入教练执行上下文，恢复认知）。 */
export interface GrowthDraftRound {
  /** ISO 时刻。 */
  at: string
  /** `revert` = `draft_revert` 撤销未发布增量（#309 缺陷②的逃生口，轮志照记）；`arc` =
   * `draft_arc` 弧建议声明（#320：弧对齐指认与结构性重画建议提成独立工具，零操作）。 */
  kind: 'patch' | 'audit' | 'finish' | 'note' | 'revert' | 'arc'
  summary: string
  /** 该轮的门错误回灌（过门轮省略）。 */
  errors?: string[]
}

/** 草稿快照（水位模型，ADR-0088 裁决 3）：草稿持**累积 ops + 已发布水位**——
 * 内核对「基图 + ops[0..published)（已发布段）+ 未发布增量」重放；每次 finish 只把
 * `[水位, end)` 增量硬化为 EditProposalSpec 投给真实受理门 → graphPropose → graphApply；
 * 水位只在 apply 成功后前移；基图漂移（外部改了图）时 finish 拒收、零落盘、草稿保留。 */
export interface GrowthDraftDoc {
  marker: typeof GROWTH_DRAFT_MARKER
  version: 1
  course: string
  session_id: string
  /** 累积 ops（含已发布段；patch 追加、失败回滚零追加）。 */
  ops: EditOp[]
  /** 已发布水位：ops[0..published) 已随历次 finish 走完 propose→apply。 */
  published: number
  /** 批级铸名块（累积；随每次 finish 随批投递——applyConceptMints 对同条目幂等）。 */
  concepts: ConceptEntry[]
  /** 未发布增量的算子/理由区（下一次 finish 硬化为 note；置空即清）。 */
  note?: EditProposalNoteLite
  /** confusable 建议（#272）：生长铸造新概念时顺手给的易混指向。建议不是 EditOp、
   * 不进 ops——它没有图结构效果；finish 发布成功后展开为 proposeConfusableCandidate
   * 同款候选提案（人审面板 /proposals/apply，不自动入册）。 */
  confusables?: PatchSuggestion[]
  rounds: GrowthDraftRound[]
  created_at: string
  updated_at: string
}

/** note 区的落盘瘦身形态（与 GrowthNote 同构；avoid 引 proposals 的 GrowthNote 造成
 * 类型耦合——草稿缓存只关心可 JSON 化的取值）。
 * #327 起 note 只载**批级**声明（理由/朝向/分歧）；算子与复诊预注册是逐条目属性
 * （op.operator / op.recheck，随 doc.ops 走）——受理门要求插入条目必须预注册
 * （proposals.validateEditProposal），草稿侧的写入面就是 add_node 条目自己的 recheck 字段。 */
export interface EditProposalNoteLite {
  reason: string
  target_endpoints?: string[]
  disagreement?: string
}

/** confusable 建议一条（#272）：concept 是（通常随批铸名的）新概念，with 是易混对端。 */
export interface PatchSuggestion {
  concept: string
  with: string
}

// ---- 补丁形状归一（#301 缺陷① / ADR-0088 §修订「收下即归一」）----

/** 形状归一的产物：ops（原样条目 + 归一后的概念字段组；仍是补丁载荷形态，展开归
 * expandPatchOps）/ concepts（铸名条目，**发布形态**）/ normalized（归一动作行——回执与
 * 轮次日志用，空 = 形状本来就合法）/ errors（修不了的形状：非空即整批拒收，行内带字段
 * 指向与合法形态）。
 *
 * 为什么需要它（2026-09-16 数学基础空课事故）：草稿补丁的宽容面此前是「原样收下」，
 * 模型给的三形状（字符串列表/字典/配对列表）全都直进 doc.ops/doc.concepts，直到 finish
 * 才在权威门里炸——而权威门对**非数组** misconceptions 是 `for...of` 直接抛 TypeError
 * 穿透，一次 finish 轮次都记不下、回灌给模型一行裸异常。裁决（ADR-0088 §修订）：
 * **暂存宽容、发布严格**——名字/条目信息完备的形状在补丁入口当场归一为发布形态（回执
 * 注明归一动作、语料补标 tolerated），修不了的当场整批拒收回灌合法形态；毒形状永不随
 * 草稿过夜，权威门恒见合法形态。 */
export interface PatchShapeNormalization {
  ops: Array<Record<string, unknown>>
  concepts: ConceptEntry[]
  normalized: string[]
  errors: string[]
}

/** 收到形态的人话名（回灌行用：让模型认得出自己写了什么）。 */
function shapeWordOf(v: unknown): string {
  if (Array.isArray(v)) return v.every(x => typeof x === 'string') ? render(SHAPE_WORD_STRING_LIST, {}) : render(SHAPE_WORD_LIST, {})
  if (v === null) return render(SHAPE_WORD_NULL, {})
  if (typeof v === 'object') return render(SHAPE_WORD_MAP, {})
  if (typeof v === 'string') return render(SHAPE_WORD_STRING, {})
  if (typeof v === 'number') return render(SHAPE_WORD_NUMBER, {})
  if (typeof v === 'boolean') return render(SHAPE_WORD_BOOLEAN, {})
  return String(typeof v)
}

/** teaches/assumes 归一：配对列表 [[概念, 档], …] → 概念→档映射；映射形原样透传。
 * 其余形态（字符串/列表但元素不是二元组）报错——展开后它会被 `{...raw}` 摊成
 * `{0: [...]}` 这类伪映射，铸名对表与 teaches 反查会静默失真。 */
function tierMapFieldOf(
  raw: unknown, where: string, out: PatchShapeNormalization,
): Record<string, unknown> | undefined {
  if (!Array.isArray(raw)) {
    if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>
    out.errors.push(render(SHAPE_ERR_TIER_MAP, { where, shape: shapeWordOf(raw) }))
    return undefined
  }
  const map: Record<string, unknown> = {}
  for (const [i, pair] of raw.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      out.errors.push(render(SHAPE_ERR_PAIR_ITEM, { where, index: i + 1, value: JSON.stringify(pair) }))
      return undefined
    }
    const concept = String(pair[0] ?? '').trim()
    const tier = String(pair[1] ?? '').trim()
    if (!concept || !tier) {
      out.errors.push(render(SHAPE_ERR_PAIR_EMPTY, { where, index: i + 1, value: JSON.stringify(pair) }))
      return undefined
    }
    map[concept] = tier
  }
  out.normalized.push(render(SHAPE_NORM_TIER_PAIR, { where, count: Object.keys(map).length }))
  return map
}

/** misconceptions 归一：按概念归组的字典 `{概念: [文字…]}`（值为单条文本也收）→
 * 条目数组 `[{concept, model}]`。**条目数组只收合法条目形状**（恰 concept/model 两键、
 * 都非空）——本次事故里模型还写过 `[{concept, text}]`（键名错）与字符串列表（拆不出
 * 概念）两类：它们都无法被权威门受理，若放行就会「先落草稿、到 finish 才炸」= 毒 op
 * 清不掉、草稿卡死（事故里那十几轮形状试探正是这条路的产物），故一律入口拒收 + 回灌
 * 合法形态。尺寸带/每概念封顶等**语义**维度不在此裁（归 finish 的权威门，那是「补 op
 * 能修」的一类）。 */
function misconceptionsFieldOf(
  raw: unknown, where: string, out: PatchShapeNormalization,
): Misconception[] | undefined {
  if (Array.isArray(raw)) {
    if (raw.some(x => typeof x === 'string')) {
      out.errors.push(render(SHAPE_ERR_MIS_STRING_LIST, { where }))
      return undefined
    }
    for (const [j, item] of raw.entries()) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        out.errors.push(render(SHAPE_ERR_MIS_ITEM_MAP, { where, index: j + 1, shape: shapeWordOf(item) }))
        return undefined
      }
      const entry = item as Record<string, unknown>
      const unknown = Object.keys(entry).filter(k => k !== 'concept' && k !== 'model')
      if (unknown.length) {
        out.errors.push(render(SHAPE_ERR_MIS_ITEM_UNKNOWN, { where, index: j + 1, fields: JSON.stringify(unknown) }))
        return undefined
      }
      if (typeof entry.concept !== 'string' || !entry.concept.trim()) {
        out.errors.push(render(SHAPE_ERR_MIS_ITEM_NO_CONCEPT, { where, index: j + 1 }))
        return undefined
      }
      if (typeof entry.model !== 'string' || !entry.model.trim()) {
        out.errors.push(render(SHAPE_ERR_MIS_ITEM_NO_MODEL, { where, index: j + 1 }))
        return undefined
      }
    }
    return raw as Misconception[]
  }
  if (typeof raw === 'object' && raw !== null) {
    const entries: Misconception[] = []
    let concepts = 0
    for (const [concept, texts] of Object.entries(raw as Record<string, unknown>)) {
      if (!concept.trim()) {
        out.errors.push(render(SHAPE_ERR_MIS_DICT_EMPTY_CONCEPT, { where }))
        return undefined
      }
      const list = typeof texts === 'string' ? [texts] : Array.isArray(texts) ? texts : null
      if (!list || !list.every(t => typeof t === 'string' && t.trim())) {
        out.errors.push(render(SHAPE_ERR_MIS_DICT_VALUE, { where, concept, shape: shapeWordOf(texts) }))
        return undefined
      }
      concepts++
      for (const t of list as string[]) entries.push({ concept: concept.trim(), model: t.trim() })
    }
    if (!entries.length) {
      out.errors.push(render(SHAPE_ERR_MIS_DICT_EMPTY, { where }))
      return undefined
    }
    out.normalized.push(render(SHAPE_NORM_MIS_DICT, { where, concepts, entries: entries.length }))
    return entries
  }
  out.errors.push(render(SHAPE_ERR_MIS_SHAPE, { where, shape: shapeWordOf(raw) }))
  return undefined
}

/** 一条 op/链条目的概念字段组归一（add_node 出生层；链条目展开后也是 add_node）。 */
function normalizeConceptFieldsOf(
  rec: Record<string, unknown>, where: string, out: PatchShapeNormalization,
): Record<string, unknown> {
  const next = { ...rec }
  for (const field of ['teaches', 'assumes'] as const) {
    if (rec[field] === undefined) continue
    const v = tierMapFieldOf(rec[field], `${where}.${field}`, out)
    if (v !== undefined) next[field] = v
  }
  if (rec.misconceptions !== undefined) {
    // #315 B3：op 的 teaches 恰一个概念时，裸字符串误解列表确定性归属到它——「这条误解
    // 属于它教的那个概念」是可推断的（节点只教一个概念），不再强制模型重写一遍；
    // 混合列表/多概念仍交 misconceptionsFieldOf 拒收（那才是真拆不出）。
    const teachesMap = next.teaches
    const single = teachesMap !== undefined && typeof teachesMap === 'object' && !Array.isArray(teachesMap)
      ? Object.entries(teachesMap as Record<string, unknown>).filter(([k]) => k.trim()).map(([k]) => k.trim())
      : []
    const rawMis = rec.misconceptions
    if (single.length === 1 && Array.isArray(rawMis) && rawMis.length > 0 && rawMis.every(x => typeof x === 'string' && String(x).trim())) {
      next.misconceptions = (rawMis as string[]).map(t => ({ concept: single[0]!, model: t.trim() }))
      out.normalized.push(render(SHAPE_NORM_MIS_BARE, { where, concept: single[0]!, count: rawMis.length }))
      return next
    }
    const v = misconceptionsFieldOf(rec.misconceptions, `${where}.misconceptions`, out)
    if (v !== undefined) next.misconceptions = v
  }
  return next
}

/** 单条铸名归一（返回 0..n 条：字典形 {名字: 定义} 一键一枚）：字符串「X」→ {canonical}；
 * 字典 {name: X, …} → {canonical: X, …}；字典 {X: 定义} → {canonical: X, definition}。
 * 归一律过 validateConceptEntry（形态权威门原样借用——未知键/空名照样拒收，不造第二套
 * 契约）。 */
function mintEntriesOf(raw: unknown, where: string, out: PatchShapeNormalization): ConceptEntry[] {
  const accept = (candidate: Record<string, unknown>, note?: string): ConceptEntry[] => {
    const v = validateConceptEntry(candidate, where)
    if (v.errors.length || !v.entry) {
      out.errors.push(...v.errors)
      return []
    }
    if (note) out.normalized.push(note)
    return [v.entry]
  }
  if (typeof raw === 'string') {
    const canonical = raw.trim()
    if (!canonical) {
      out.errors.push(render(SHAPE_ERR_MINT_EMPTY, { where }))
      return []
    }
    return accept({ canonical }, render(SHAPE_NORM_MINT_STRING, { where, canonical }))
  }
  if (Array.isArray(raw)) {
    out.errors.push(render(SHAPE_ERR_MINT_LIST, { where }))
    return []
  }
  if (typeof raw !== 'object' || raw === null) {
    out.errors.push(render(SHAPE_ERR_MINT_SHAPE, { where, shape: shapeWordOf(raw) }))
    return []
  }
  const r = raw as Record<string, unknown>
  if (typeof r.canonical === 'string') return accept(r)
  if (typeof r.name === 'string') {
    const { name, ...rest } = r
    return accept({ canonical: name, ...rest }, render(SHAPE_NORM_MINT_NAME_KEY, { where, canonical: JSON.stringify(name.trim()) }))
  }
  const keys = Object.keys(r)
  if (keys.length && keys.every(k => k.trim()) && keys.every(k => typeof r[k] === 'string')) {
    const entries: ConceptEntry[] = []
    for (const k of keys) {
      const definition = String(r[k]).trim()
      entries.push(...accept({ canonical: k.trim(), ...(definition ? { definition } : {}) }))
    }
    if (entries.length === keys.length) out.normalized.push(render(SHAPE_NORM_MINT_DICT, { where, keys: keys.length }))
    return entries
  }
  out.errors.push(render(SHAPE_ERR_MINT_DICT, { where, keys: JSON.stringify(keys) }))
  return []
}

/** 铸名块归一（裸值宽容：模型把整块写成单条时按单条收下）。 */
function mintBlockOf(raw: unknown, out: PatchShapeNormalization): ConceptEntry[] {
  if (raw === undefined || raw === null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  if (!Array.isArray(raw)) out.normalized.push(render(SHAPE_NORM_MINT_NOT_LIST, { shape: shapeWordOf(raw) }))
  const entries: ConceptEntry[] = []
  for (const [i, item] of items.entries()) entries.push(...mintEntriesOf(item, `concepts.${i + 1}`, out))
  return entries
}

/** 补丁载荷的形状归一（draft_patch 入口；纯函数）。概念字段组只归一 add_node 与
 * insert_prereq_chain 的链条目——写在其他 op 上的概念字段组归权威门按「只许 add_node
 * 出生」拒收（那里的话更准）。 */
export function normalizePatchShape(
  rawOps: ReadonlyArray<Record<string, unknown>>, rawConcepts: unknown,
): PatchShapeNormalization {
  const out: PatchShapeNormalization = { ops: [], concepts: [], normalized: [], errors: [] }
  for (const [i, raw] of rawOps.entries()) {
    const where = `ops.${i}`
    if (raw.op === 'add_node') {
      out.ops.push(normalizeConceptFieldsOf(raw, where, out))
      continue
    }
    if (raw.op === 'insert_prereq_chain' && Array.isArray(raw.chain)) {
      out.ops.push({
        ...raw,
        chain: (raw.chain as unknown[]).map((item, j) =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
            ? normalizeConceptFieldsOf(item as Record<string, unknown>, `${where}.chain[${j}]`, out)
            : item),
      })
      continue
    }
    out.ops.push({ ...raw })
  }
  out.concepts = mintBlockOf(rawConcepts, out)
  return out
}

/** 合法形态速查（形状拒收回灌的那一段）：事故里模型烧掉十几轮在试探形状，
 * 拒收回执一次给全三件套的合法写法。**文本已迁 `prompts/coach-draft.ts`（#311 集中单源）**，
 * 此处只作同名 re-export 以保调用点不变。 */
export { PATCH_SHAPE_CHEATSHEET } from '../prompts/coach-draft.ts'

// ---- 糖算子展开（#272）：expandPatchOps 与手写原子 ops 在 replayDraft 下逐字等价 ----

/** 图节点列表里按名找节点（草稿补丁展开面的局部助手；Graph 不暴露节点对象访问器）。 */
function nodeInNodes(nodes: ReadonlyArray<GNode>, name: string): GNode | null {
  return nodes.find(x => x.name === name) ?? null
}

/** insert_prereq_chain（#271）+ split_node / suggest_confusable（#272）的统一展开：
 * 返回原子 EditOp 序列（连同原样透传的普通 op）与 confusable 建议（后者不是图 op）。
 * 展开错误当场抛（`ops.<i>:` 前缀，与重放错误同款行文）——调用方整批回滚。
 *
 * split_node(node, into[]) 的确定性语义：into 每名各 add_node 一次（pre 继承被拆节点的
 * 现势 pre，est/bloom/difficulty/note/teaches/assumes/misconceptions 全轮廓继承），随后
 * 每个以 node 为 pre 的消费方 set_pre 重排（node 在其 pre 里的位置原位替换为 into 全体
 * ——保守语义：任一拆分件都接住原可达性），最后 del_node 被拆节点。终点不可拆（拆含
 * del_node，锚保护在 finish 必拒——按门同源口径提前到展开面 fail loud）。 */
export function expandPatchOps(
  rawOps: ReadonlyArray<Record<string, unknown>>,
  nodes: ReadonlyArray<GNode>, graph: Graph, endpoints: ReadonlySet<string>,
): { ops: EditOp[]; confusables: PatchSuggestion[] } {
  const expanded: EditOp[] = []
  const confusables: PatchSuggestion[] = []
  for (const [i, raw] of rawOps.entries()) {
    if (raw.op === 'suggest_confusable') {
      const concept = String(raw.name ?? '').trim()
      const target = String(raw.with ?? '').trim()
      if (!concept || !target) throw new Error(render(OP_ERR_CONFUSABLE_FIELDS, { where: `ops.${i}` }))
      if (concept === target) throw new Error(render(OP_ERR_CONFUSABLE_SAME, { where: `ops.${i}`, concept }))
      confusables.push({ concept, with: target })
      continue
    }
    if (raw.op === 'split_node') {
      const node = String(raw.node ?? '').trim()
      const into = (Array.isArray(raw.into) ? raw.into as unknown[] : []).map(x => String(x ?? '').trim()).filter(Boolean)
      if (!node) throw new Error(render(OP_ERR_SPLIT_NO_NODE, { where: `ops.${i}` }))
      if (endpoints.has(node)) throw new Error(render(OP_ERR_SPLIT_ENDPOINT, { where: `ops.${i}`, node }))
      const src = nodeInNodes(nodes, node)
      if (!src) throw new Error(render(OP_ERR_SPLIT_MISSING, { where: `ops.${i}`, node }))
      if (into.length < 2) throw new Error(render(OP_ERR_SPLIT_MIN, { where: `ops.${i}` }))
      if (new Set(into).size !== into.length) throw new Error(render(OP_ERR_SPLIT_DUP, { where: `ops.${i}` }))
      const pres = [...(graph.preOf[node] ?? [])]
      // 拆分件的算子/复诊预注册随 raw 声明、逐件继承（#327 逐条目化：生长批的每条
      // add_node 都要 operator——拆分不改变「以什么方式长」，一件声明全体继承）。
      for (const name of into) {
        expanded.push({
          op: 'add_node', name,
          pre: [...pres],
          ...(raw.operator !== undefined ? { operator: raw.operator as EditOp['operator'] } : {}),
          ...(raw.recheck !== undefined ? { recheck: raw.recheck as EditOp['recheck'] } : {}),
          ...(src.note ? { note: src.note } : {}),
          ...(src.est !== undefined ? { est: src.est } : {}),
          ...(src.bloom ? { bloom: src.bloom } : {}),
          ...(src.difficulty !== undefined ? { difficulty: src.difficulty } : {}),
          ...(src.teaches ? { teaches: { ...src.teaches } } : {}),
          ...(src.assumes ? { assumes: { ...src.assumes } } : {}),
          ...(src.misconceptions?.length ? { misconceptions: src.misconceptions.map(m => ({ ...m })) } : {}),
        })
      }
      for (const consumer of graph.order) {
        const cps = graph.preOf[consumer] ?? []
        if (!cps.includes(node)) continue
        expanded.push({ op: 'set_pre', node: consumer, pre: cps.flatMap(p => (p === node ? into : [p])) })
      }
      expanded.push({ op: 'del_node', node })
      continue
    }
    if (raw.op !== 'insert_prereq_chain') {
      expanded.push(raw as unknown as EditOp)
      continue
    }
    const chain = Array.isArray(raw.chain) ? raw.chain as Array<Record<string, unknown>> : []
    if (chain.length < 2) throw new Error(render(OP_ERR_CHAIN_MIN, { where: `ops.${i}` }))
    // 链首的 pre 同 add_node 口径（#313 A2）：非列表此前静默折成 []，整条链会以「零前置」
    // 落图挂在根部——与 set_pre/add_node 的「必须列表」是一件事。
    if (raw.pre !== undefined && !Array.isArray(raw.pre)) {
      throw new Error(render(OP_ERR_CHAIN_PRE_LIST, { where: `ops.${i}`, shape: typeof raw.pre === 'string' ? render(SHAPE_WORD_STRING, {}) : typeof raw.pre }))
    }
    chain.forEach((item, j) => {
      expanded.push({
        op: 'add_node',
        name: String(item.name ?? ''),
        pre: j === 0 ? (Array.isArray(raw.pre) ? raw.pre as string[] : [])
          : [String(chain[j - 1]!.name ?? '')],
        // 链条目的算子/复诊预注册逐条透传（#327 逐条目化：展开后的 add_node 与手写原子 op 同形）
        ...(item.operator !== undefined ? { operator: item.operator as EditOp['operator'] } : {}),
        ...(item.recheck !== undefined ? { recheck: item.recheck as EditOp['recheck'] } : {}),
        ...(item.est !== undefined ? { est: Number(item.est) } : {}),
        ...(item.bloom !== undefined ? { bloom: String(item.bloom) as EditOp['bloom'] } : {}),
        ...(item.difficulty !== undefined ? { difficulty: Number(item.difficulty) as EditOp['difficulty'] } : {}),
        ...(item.teaches !== undefined ? { teaches: item.teaches as EditOp['teaches'] } : {}),
        ...(item.assumes !== undefined ? { assumes: item.assumes as EditOp['assumes'] } : {}),
        ...(item.misconceptions !== undefined ? { misconceptions: item.misconceptions as EditOp['misconceptions'] } : {}),
      })
    })
  }
  return { ops: expanded, confusables }
}

// ---- 草稿审计 findings（#272）：非阻提示行，不拦 finish ----

/** 草稿审计 findings（#272）：与门错误分列——findings 只把结构信号显式给教练，
 * 不拦 finish。范围限**本会话新铸概念**（全表健康归概念治理线）+ 收尾提示：
 * - 孤立新铸概念：零 teaches / 零 assumes / 零 invokes（「概念表不只是名词堆」）；
 * - confusable 悬空指向：建议目标不在册（提案通道只收在册概念）；
 * - 近似名撞车：与在册 canonical/别名过近（复用 nearNameCandidates 同一阈值）；
 * - 收尾提示：终点已接线（pre 非空）且未收尾宣告——收尾须纯 set_pre 独立批发布。 */
export function draftFindings(args: {
  mints: ReadonlyArray<ConceptEntry>
  entries: ReadonlyArray<ConceptEntry>
  graph: Graph
  invokes: ReadonlyMap<string, ReadonlyMap<string, number>>
  confusables: ReadonlyArray<PatchSuggestion>
  anchors: ReadonlyArray<EndpointAnchor>
}): string[] {
  const out: string[] = []
  for (const s of args.confusables) {
    if (!resolveConcept([...args.entries], s.with)) {
      out.push(render(FIND_CONFUSABLE_DANGLING, { concept: s.concept, with: s.with }))
    }
  }
  for (const m of args.mints) {
    const taught = args.graph.taughtByOf[m.canonical]?.length ?? 0
    const assumed = args.graph.assumedByOf[m.canonical]?.length ?? 0
    let invoked = 0
    for (const n of args.invokes.get(m.canonical)?.values() ?? []) invoked += n
    if (!taught && !assumed && !invoked) {
      out.push(render(FIND_ORPHAN_MINT, { concept: m.canonical }))
    }
  }
  for (const c of nearNameCandidates([...args.mints], [...args.entries])) {
    out.push(render(FIND_NEAR_NAME, { name: c.name, existing: c.existing, similarity: c.similarity }))
  }
  for (const a of args.anchors) {
    if (a.sealed) continue
    if ((args.graph.preOf[a.endpoint] ?? []).length > 0) {
      out.push(render(FIND_SEAL_TODO, { endpoint: a.endpoint }))
    }
  }
  return out
}

/** 草稿目录：courseStateDir(root)/草稿/。 */
export function draftDirOf(paths: Paths, root: string): string {
  return `${paths.courseStateDir(root)}/草稿`
}

/** 草稿文件路径：courseStateDir(root)/草稿/<sessionId>.json。 */
export function draftPathOf(paths: Paths, root: string, sessionId: string): string {
  return `${draftDirOf(paths, root)}/${sessionId}.json`
}

/** 草稿快照解析（读侧防呆：marker 不符即拒收——「非活图、非提案」的文件不许被当草稿读）。 */
export function parseDraftDoc(raw: string): GrowthDraftDoc | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  const d = doc as Record<string, unknown> | null
  if (!d || d.marker !== GROWTH_DRAFT_MARKER || d.version !== 1) return null
  if (typeof d.course !== 'string' || typeof d.session_id !== 'string' || !Array.isArray(d.ops)) return null
  return d as unknown as GrowthDraftDoc
}

/** 读在途草稿（同课程单份在途；文件损坏/非本格式 = 无在途，不炸读侧）。 */
export async function loadDraft(fs: VaultFs, path: string): Promise<GrowthDraftDoc | null> {
  if (!fs.exists(path)) return null
  return parseDraftDoc(await fs.readFile(path))
}

/** 扫描在途草稿（同课程至多一份；目录 Missing/空 = null，合法空态）。多个文件在目录
 * 时取字典序最新（幂等自愈面——正常流程不会出现多份；残留旧文件由下次 finish/取消清场）。
 * onCorrupt（#291 观测缝）：损坏/非本格式的文件逐个回调（文件名，含后缀），不改变「坏档
 * 视为无在途」的读侧语义——调用方据此发 growth.draft.corrupt 留痕。 */
export async function findActiveDraft(
  fs: VaultFs, paths: Paths, root: string,
  onCorrupt?: (file: string) => void,
): Promise<GrowthDraftDoc | null> {
  const dir = draftDirOf(paths, root)
  if (!fs.exists(dir)) return null
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort()
  for (const f of files.reverse()) {
    const doc = await loadDraft(fs, `${dir}/${f}`)
    if (doc) return doc
    onCorrupt?.(f)
  }
  return null
}

/** 原子写快照（tmp + rename，同 engine atomicWrite 语义）。 */
export async function saveDraft(fs: VaultFs, path: string, doc: GrowthDraftDoc): Promise<void> {
  await atomicWrite(path, JSON.stringify(doc, null, 2), fs)
}

/** 删除草稿快照（finish 发布成功清场 / 显式取消；Missing 静默）。 */
export async function deleteDraft(fs: VaultFs, path: string): Promise<void> {
  if (fs.exists(path)) await fs.unlink(path).catch(() => undefined)
}
