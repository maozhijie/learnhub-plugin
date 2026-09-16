/**
 * 生长草稿缓存（#271 / ADR-0088 裁决 4）：执行官会话的草稿快照落盘——vault 旁挂
 * `courseStateDir(root)/草稿/<sessionId>.json` 原子写（每批结束写，非逐 op），带
 * 「非活图、非提案」标记、不进提案生命周期；同课程同一时刻至多一份在途草稿，新会话
 * 遇在途草稿默认续建；finish 发布成功或显式取消时删除；进程重启可续建。
 *
 * 本文件只管**形状与 IO**，以及草稿补丁的糖算子展开与审计 findings 的纯函数
 * （#272；重放与门序列住 proposals.ts（replayDraft / editGateErrors——草稿通过 =
 * 门通过按构造成立），站编排住 growth-subsystem.ts（growth2.coachDraft）。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import type { Paths } from './paths.ts'
import type { EditOp } from './proposals.ts'
import type { ConceptEntry } from './concepts.ts'
import { nearNameCandidates, resolveConcept } from './concepts.ts'
import type { Graph } from './graph.ts'
import type { GNode, GRegion } from './types.ts'
import type { EndpointAnchor } from './seed.ts'

/** 执行官站的语料站标签（host STATIONS.growthDraft 引门面常量对齐；站名是受控词表）。 */
export const GROWTH_DRAFT_STATION = '教练执行'

/** 草稿文件的身份标记（读侧拒收非本格式文件的防呆面；「非活图、非提案」）。 */
export const GROWTH_DRAFT_MARKER = '生长草稿（非活图、非提案）'

/** 一条轮次日志（草稿快照的对话记忆面：续建时注入执行官上下文，恢复认知）。 */
export interface GrowthDraftRound {
  /** ISO 时刻。 */
  at: string
  kind: 'patch' | 'audit' | 'finish' | 'note'
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
 * 类型耦合——草稿缓存只关心可 JSON 化的取值）。 */
export interface EditProposalNoteLite {
  operator: string
  reason: string
  target_endpoints?: string[]
  disagreement?: string
}

/** confusable 建议一条（#272）：concept 是（通常随批铸名的）新概念，with 是易混对端。 */
export interface PatchSuggestion {
  concept: string
  with: string
}

// ---- 糖算子展开（#272）：expandPatchOps 与手写原子 ops 在 replayDraft 下逐字等价 ----

/** regions 里按名找节点（草稿补丁展开面的局部助手；Graph 不暴露节点对象访问器）。 */
function nodeInRegions(regions: ReadonlyArray<GRegion>, name: string): GNode | null {
  for (const r of regions) for (const b of r.blocks) {
    const n = b.nodes.find(x => x.name === name)
    if (n) return n
  }
  return null
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
  regions: ReadonlyArray<GRegion>, graph: Graph, endpoints: ReadonlySet<string>,
): { ops: EditOp[]; confusables: PatchSuggestion[] } {
  const expanded: EditOp[] = []
  const confusables: PatchSuggestion[] = []
  for (const [i, raw] of rawOps.entries()) {
    if (raw.op === 'suggest_confusable') {
      const concept = String(raw.name ?? '').trim()
      const target = String(raw.with ?? '').trim()
      if (!concept || !target) throw new Error(`ops.${i}: suggest_confusable 需要 name（本批铸名的新概念）与 with（易混对端）两个字段。`)
      if (concept === target) throw new Error(`ops.${i}: suggest_confusable 两端同名「${concept}」——易混指向需要两个不同概念。`)
      confusables.push({ concept, with: target })
      continue
    }
    if (raw.op === 'split_node') {
      const node = String(raw.node ?? '').trim()
      const into = (Array.isArray(raw.into) ? raw.into as unknown[] : []).map(x => String(x ?? '').trim()).filter(Boolean)
      if (!node) throw new Error(`ops.${i}: split_node 缺 node（被拆节点的名字）。`)
      if (endpoints.has(node)) throw new Error(`ops.${i}: split_node 拒绝——「${node}」是锚定的终点（终点不可拆分；拆含 del_node，锚保护必拒）。`)
      const src = nodeInRegions(regions, node)
      if (!src) throw new Error(`ops.${i}: split_node 的 node 不存在: ${node}（逐字来自 graph_view）。`)
      if (into.length < 2) throw new Error(`ops.${i}: split_node 的 into 至少 2 个新名（拆一份请直接 rename）。`)
      if (new Set(into).size !== into.length) throw new Error(`ops.${i}: split_node 的 into 含重名。`)
      const pres = [...(graph.preOf[node] ?? [])]
      for (const name of into) {
        expanded.push({
          op: 'add_node', name,
          pre: [...pres],
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
    if (chain.length < 2) throw new Error(`ops.${i}: insert_prereq_chain 的 chain 至少 2 条（一条不成链；单节点直接用 add_node）。`)
    chain.forEach((item, j) => {
      expanded.push({
        op: 'add_node',
        name: String(item.name ?? ''),
        pre: j === 0 ? (Array.isArray(raw.pre) ? raw.pre as string[] : [])
          : [String(chain[j - 1]!.name ?? '')],
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
      out.push(`confusable 悬空指向：建议「${s.concept}」↔「${s.with}」的目标不在册——候选提案只收在册概念，先补登记或改指向`)
    }
  }
  for (const m of args.mints) {
    const taught = args.graph.taughtByOf[m.canonical]?.length ?? 0
    const assumed = args.graph.assumedByOf[m.canonical]?.length ?? 0
    let invoked = 0
    for (const n of args.invokes.get(m.canonical)?.values() ?? []) invoked += n
    if (!taught && !assumed && !invoked) {
      out.push(`孤立新铸概念：「${m.canonical}」零 teaches / 零 assumes / 零 invokes——概念表不只是名词堆，铸名须有节点真的教它或假设它`)
    }
  }
  for (const c of nearNameCandidates([...args.mints], [...args.entries])) {
    out.push(`近似名撞车：铸名「${c.name}」与在册名字「${c.existing}」过近（相似度 ${c.similarity}）——同一个概念就引用既有名字，确实是另一个概念请在 note.reason 里写明区别`)
  }
  for (const a of args.anchors) {
    if (a.sealed) continue
    if ((args.graph.preOf[a.endpoint] ?? []).length > 0) {
      out.push(`终点 ${a.endpoint} 已铺通待收尾——收尾须纯 set_pre 独立批发布`)
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
 * 时取字典序最新（幂等自愈面——正常流程不会出现多份；残留旧文件由下次 finish/取消清场）。 */
export async function findActiveDraft(fs: VaultFs, paths: Paths, root: string): Promise<GrowthDraftDoc | null> {
  const dir = draftDirOf(paths, root)
  if (!fs.exists(dir)) return null
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort()
  for (const f of files.reverse()) {
    const doc = await loadDraft(fs, `${dir}/${f}`)
    if (doc) return doc
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
