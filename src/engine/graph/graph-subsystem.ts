/**
 * Graph 子系统（#152 刀 7 / ADR-0043）：图域——graph analyze、Vault 链接先验、
 * 图探索、提案门禁包装、enc 覆盖层回填。
 *
 * 住同域新文件而非领主 graph.ts：graph.ts 被 17 个 engine 模块引用（含 type-only），
 * 子系统类放进领主会让枢纽文件反向依赖 proposals/projects/analysis/audit/content 等
 * 全部下游，形成不可解的依赖汇聚（ADR-0043 补充：枢纽领主改用同域新文件承载，
 * 零既有模块搬移的原则不变）。本文件只被门面引用，故可自由 import 领域模块。
 */

// ---- Graph 子系统（#152 刀 7 / ADR-0043）：图域五节。本文件只被门面引用，可自由
// import 领域模块（枢纽领主 graph.ts 不被反向依赖）。

import type { VaultFs } from '../io.ts'
import type { Clock } from '../clock.ts'
import type { Store } from '../store.ts'
import type { Paths } from '../paths.ts'
import type { Projects, ProjectApplyResult } from '../projects.ts'
import type { GraphProposals, ApplyAudit } from '../proposals.ts'
import type { ConceptRegistry } from '../concepts/concepts.ts'
import { CONFUSABLE_CANDIDATE_MAX, conceptFootprintCore, conceptPairKey, confusableCandidates, declaredPairKeys, isDeprecated, mergeCandidates, resolveConcept } from '../concepts/concepts.ts'
import { groupView, type GroupAxis } from './graph.ts'
import type { CooccurrenceNode } from '../concepts/concepts.ts'
import type { Registry } from '../vault/registry.ts'
import type { QuestionBank } from '../question-bank.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from '../vault/notes.ts'
import type { Fm } from '../types.ts'
import type { Logger } from '../logger.ts'

/** Graph 域对门面的窄面（门面构造时传 this）：领域类与纯函数直接 import，
 * 这里只列门面私有方法/字段——它们无法从模块导入。 */
export interface GraphDeps {
  /** 时钟端口（#175 阶段①）：vault 链接扫描 generated_at。 */
  clock: Clock
  /** 调试日志端口（#253 / ADR-0080；#291 附录登记接线）：挖矿面题库 Broken 排除留痕。 */
  logger: Logger
  /** vault 存储端口（#175 阶段②）。 */
  fs: VaultFs
  store: Store
  paths: Paths
  projects: Projects
  proposals: GraphProposals
  concepts: ConceptRegistry
  registry: Registry
  bank: QuestionBank
  vaultRoot: string
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  seedAuditFor(courseName: string, today: string): Promise<ApplyAudit>
  /** 题目 invokes 折叠（concept_growth.demand.invoked 取材；口径住 growth-subsystem 单一出处）。 */
  conceptInvokesOf(c: { name: string; root: string }): Promise<Map<string, Map<string, number>>>
  applyProjectPlanProposal(pid?: number): Promise<ProjectApplyResult>
  experimentApply(pid?: number): Promise<{ id: number; title: string; arm_today: string }>
}
import { readVaultLinksCache as readVaultLinksCache$mod } from '../vault/vault-links.ts'
import type { VaultLinkPrior } from './analysis.ts'
import { analyzeGraph } from './analysis.ts'
import { effectiveStage } from './audit.ts'
import { Content } from '../content.ts'
import { declaredEncOf } from './graph.ts'
import { atomicWrite } from '../io.ts'
import { readNoteSourceExcludes } from '../vault/note-source.ts'
import { hasReadyContent, loadNote } from '../vault/notes.ts'
import type { EnrichFieldEntry } from '../proposals.ts'
import { endpointNames, isSeedGraph, junctionServes, readAnchors } from '../seed.ts'
import { assertNoBrokenNotes } from '../sessions.ts'
import { masteryOfFm } from '../srs.ts'
import type { CourseEntry, ProposalRec } from '../types.ts'
import { PROPOSAL_KINDS } from '../types.ts'
import type { VaultLinkCandidateView, VaultLinksDoc } from '../vault/vault-links.ts'
import { mapEdgesToNodes, orientLinkPair, readVaultLinkDirExcludes, scanVaultLinks, scoreTier } from '../vault/vault-links.ts'
import type { ConceptFootprintDoc, GraphApplyResult, GraphBrowseDoc, GraphDoc, GraphElementsDoc, GraphEncBackfillResult, GraphNodeDoc, GraphPathResult } from '../views/graph.ts'
import type { ExperimentStartResult } from '../views/lab.ts'
import type { GraphProposeResult, ConceptApplyResult } from '../views/proposals.ts'
import { YAML } from '../yaml.ts'
export class GraphSubsystem {
  constructor(private e: GraphDeps) {}

// ---- 门面原分节：analyze ----
// ---- 门面原分节：V2 ----
// ---- 门面原分节：explore ----
// ---- 门面原分节：gate ----
// ---- 门面原分节：enc ----


  async graphAnalyze(
    courseKey?: string, elementsOnly = false,
  ): Promise<GraphDoc | GraphElementsDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state } = await this.e.loadView(c)
    const vaultLinks = await this.loadVaultLinkPrior(graph)
    // 种子图豁免（#142）：图仍 = 锚集合种子节点并集时，Float（missing_pre）建议豁免
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    const seedPhase = isSeedGraph(anchors, graph)
    const endpoints = endpointNames(anchors)
    // 终点标记随锚走（#200 / ADR-0055 读侧单源派生；#239 多终点化：逐终点标记）：
    // 节点载荷标 isEndpoint、leaves/空降建议/健康分口径剔终点，UI 图面据此渲染终点
    // 样式并关终点生成入口
    const doc = await analyzeGraph(c.name, graph, state, this.e.store, (await this.e.learningDay()).today, vaultLinks, seedPhase, endpoints, {
      conceptEntries: await this.e.concepts.load(c.root),
      conceptInvokes: await this.e.conceptInvokesOf(c),
      stuckByNode: await this.stuckByNode(c.name),
    })
    // 交汇节点读侧派生（ADR-0076）：落在 ≥2 个终点前置闭包内的节点标 serves（仅交汇
    // 节点携带）；逐终点最后台阶随行（UI 终点列表反向展示）
    const serves = junctionServes(graph, anchors)
    for (const n of doc.nodes) {
      const s = serves.get(n.data.id)
      if (s) n.data.serves = s
    }
    if (elementsOnly) return { nodes: doc.nodes, edges: doc.edges }
    return {
      ...doc,
      endpoints: [...endpoints],
      endpoint_steps: anchors
        .filter(a => graph.nset.has(a.endpoint))
        .map(a => ({ endpoint: a.endpoint, last_steps: graph.preOf[a.endpoint] })),
    }
  }

  /** 卡点自报节点计数（#248 流水 → 节点 → 条数；只聚合计数，原文永不进图分析）。 */
  private async stuckByNode(courseName: string): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (const r of await this.e.store.stuckStreamAll()) {
      if (r.kind !== 'stuck_report' || r.course !== courseName) continue
      out.set(r.node, (out.get(r.node) ?? 0) + 1)
    }
    return out
  }

  /** 读链接先验缓存（Missing = null 合法空态；坏档 fail loud——它是引擎 state 契约文件）。 */
  private async readVaultLinksCache(): Promise<VaultLinksDoc | null> {
    return readVaultLinksCache$mod(this.e.paths.vaultLinksPath, this.e.fs)
  }


  /** analyze 的先验段：缓存映射到本课程图的候选（w ≥ 0.4，proposal/review 分层 +
     行动指引）；未扫描返回空段（带 hint）。 */
  private async loadVaultLinkPrior(graph: Graph): Promise<VaultLinkPrior> {
    const cache = await this.readVaultLinksCache()
    if (!cache) return { scanned_at: null, mapped_total: 0, candidates: [] }
    const mapped = mapEdgesToNodes(
      cache.edges.filter(e => e.w >= 0.4),
      graph.names,
    )
    const candidates: VaultLinkCandidateView[] = mapped.map(({ edge, aNode, bNode }) => {
      const tier = scoreTier(edge.w) === 'proposal' ? 'proposal' as const : 'review' as const
      return {
        a: aNode,
        b: bNode,
        a_note: edge.a,
        b_note: edge.b,
        w: edge.w,
        count: edge.count,
        files: edge.files,
        bidirectional: edge.bidirectional,
        tier,
        suggestion: tier === 'proposal'
          ? 'learnhub_graph_link_backfill 可生成 set_enc 提案（单提案人审）'
          : '置信度居中——人工裁决后 learnhub_graph_propose 显式主张（pre 从严）',
      }
    })
    return { scanned_at: cache.generated_at, mapped_total: candidates.length, candidates }
  }


  /** 全库 wikilink 扫描（learnhub_vault_links_scan）：学习中心/点目录/内置目录排除/
   * 用户排除清单之外的全部 .md → 解析 → 过滤（带命中率审计）→ 无向关联对。
   * 产物落 state/vault链接.json（引擎 state 区），个人笔记零写入（ADR-0010）。 */
  async vaultLinksScan(): Promise<{
    generated_at: string
    scanned_files: number
    truncated: boolean
    links_seen: number
    unresolved: number
    audit: VaultLinksDoc['audit']
    tiers: { proposal: number; review: number; report: number }
    edges: Array<{ a: string; b: string; count: number; files: number; w: number; tier: string }>
    cache: string
  }> {
    const dirExcludes = await readVaultLinkDirExcludes(this.e.paths.learnhubConfigPath, this.e.fs)
    const doc = await scanVaultLinks({
      vaultRoot: this.e.vaultRoot,
      centerRel: this.e.paths.centerRoot.slice(this.e.vaultRoot.length + 1),
      dirExcludes,
      pathExcludes: await readNoteSourceExcludes(this.e.paths, this.e.fs),
      nowMs: this.e.clock.nowMs(),
      fs: this.e.fs,
    })
    await this.e.fs.mkdir(this.e.paths.centerStateDir)
    await atomicWrite(this.e.paths.vaultLinksPath, JSON.stringify(doc, null, 1) + '\n', this.e.fs)
    const tiers = { proposal: 0, review: 0, report: 0 }
    for (const e of doc.edges) tiers[scoreTier(e.w)]++
    return {
      generated_at: doc.generated_at,
      scanned_files: doc.scanned_files,
      truncated: doc.truncated,
      links_seen: doc.links_seen,
      unresolved: doc.unresolved,
      audit: doc.audit,
      tiers,
      edges: doc.edges.slice(0, 50).map(e => ({
        a: e.a, b: e.b, count: e.count, files: e.files, w: e.w, tier: scoreTier(e.w),
      })),
      cache: this.e.paths.vaultLinksPath,
    }
  }


  /** 链接先验回填（learnhub_graph_link_backfill）：映射到本课程图、w ≥ 0.7 的候选对，
   * pre 闭包内定向成 set_enc op（既有声明 enc 原样保留——整体替换语义），汇总为
   * 单个 pending edit 提案走人审（enc_backfill 先例）；无 pre 关系的对不硬提，降级
   * blocked_no_pre 信号（带 why，供人审/补 pre 参考）。可重入：已声明边不重复提名。 */
  async graphLinkBackfill(courseKey?: string): Promise<{
    course: string
    scanned_edges: number
    mapped: number
    ops: number
    proposal: { id: number } | null
    blocked_no_pre: Array<{ a: string; b: string; w: number; why: string }>
    skipped_declared: number
    message: string
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const cache = await this.readVaultLinksCache()
    if (!cache) {
      throw new Error('[link-backfill] 没有链接先验缓存——先跑 learnhub_vault_links_scan。')
    }
    const { graph } = await this.e.loadView(c)
    const proposalTier = mapEdgesToNodes(cache.edges.filter(e => scoreTier(e.w) === 'proposal'), graph.names)
    const declared = declaredEncOf(graph)
    const fields: EnrichFieldEntry[] = []
    const candidates: Array<{ holder: string; skill: string; w: number }> = []
    const blockedNoPre: Array<{ a: string; b: string; w: number; why: string }> = []
    let skippedDeclared = 0
    for (const { edge, aNode, bNode } of proposalTier) {
      const dir = orientLinkPair(aNode, bNode, (from, to) => graph.nset.has(from) && graph.nset.has(to) && graph.isAncestor(from, to))
      // `=== false` 而非 `!dir.ok`：strictNullChecks 关时真假分支不参与字面量联合收窄
      // （#170 类型门实测），显式比较在两种档位下都收窄。
      if (dir.ok === false) {
        blockedNoPre.push({ a: aNode, b: bNode, w: edge.w, why: dir.why })
        continue
      }
      const existing = declared.get(dir.holder) ?? []
      if (existing.some(e => e.node === dir.skill)) {
        skippedDeclared++
        continue
      }
      fields.push({
        node: dir.holder,
        enc: [...existing, {
          node: dir.skill, w: edge.w,
          note: `vault 链接先验（#91）：${edge.a.split('/').pop()} ↔ ${edge.b.split('/').pop()}（${edge.count} 次/${edge.files} 源${edge.bidirectional ? '/双向' : ''}）`,
        }],
      })
      candidates.push({ holder: dir.holder, skill: dir.skill, w: edge.w })
    }
    if (!fields.length) {
      return {
        course: c.name, scanned_edges: cache.edges.length, mapped: proposalTier.length, ops: 0,
        proposal: null, blocked_no_pre: blockedNoPre, skipped_declared: skippedDeclared,
        message: '没有可回填的边：映射候选为空、已在 pre 闭包外（见 blocked_no_pre）或已声明。',
      }
    }
    const yamlText = YAML.stringify({
      course: c.name,
      reason: `Vault 链接先验回填（覆盖层通道，V-2 #91）：${fields.length} 个节点的个人笔记关联对成 enc 边（w ≥ 0.7、pre 闭包内）`,
      fields,
    })
    const prop = await this.graphPropose('enrich', yamlText)
    return {
      course: c.name, scanned_edges: cache.edges.length, mapped: proposalTier.length, ops: fields.length,
      proposal: { id: (prop as { id: number }).id }, blocked_no_pre: blockedNoPre,
      skipped_declared: skippedDeclared,
      message: `已生成 pending enrich 提案 #${(prop as { id: number }).id}（覆盖层通道）——过审后 learnhub_graph_apply(kind=enrich) 生效（可重入，已声明边不重复提名）`,
    }
  }

  /** 单节点图详情：schema 字段值 + 直接邻域（succ）+ enc 边（含 note）+ 前置传递闭包。 */
  async graphNode(courseKey: string | undefined, node: string): Promise<GraphNodeDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    if (!graph.nset.has(node)) throw new Error(`[graph-node] 节点「${node}」不在课程「${c.name}」的图内。`)
    this.e.assertNoteOk(c, graph, broken, node, 'graph-node')
    const gnode = graph.nodes.find(n => n.name === node)
    // 前置传递闭包（Graph.upstreamClosure 单一出处；不含自身），按深度降序=先学在前
    const closure = [...graph.upstreamClosure(node)].filter(n => n !== node)
      .sort((a, b) => (graph.depth[b] ?? 0) - (graph.depth[a] ?? 0))
    const fm = state[node]
    return {
      course: c.name,
      node,
      depth: graph.depth[node] ?? 0,
      opt: graph.opt.has(node),
      pre: graph.preOf[node],
      succ: graph.succ[node] ?? [],
      enc: gnode?.enc ?? [],
      est: graph.estOf[node],
      type: graph.typeOf[node],
      bloom: graph.bloomOf[node],
      difficulty: graph.difficultyOf[node],
      ...(gnode?.teaches ? { teaches: gnode.teaches } : {}),
      ...(gnode?.assumes ? { assumes: gnode.assumes } : {}),
      ...(gnode?.misconceptions?.length ? { misconceptions: gnode.misconceptions } : {}),
      note: graph.noteOf[node],
      stage: effectiveStage(state, node),
      mastery: masteryOfFm(fm),
      content: fm?.content ? { version: fm.content.version, status: fm.content.status } : undefined,
      prereq_closure: closure,
    }
  }


  /** 组浏览（graphBrowse，#281）：按分组轴（depth/concept/endpoint）切组的节点清单——
   * depth 单归属、concept/endpoint 派生可重叠（同一节点详情随组重复，多重位置可见）。
   * 坏轴名/坏组名 fail loud（列出可用取值）。 */
  async graphBrowse(courseKey: string | undefined, axis: GroupAxis = 'depth', group?: string): Promise<GraphBrowseDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    // 轴合法性由 groupView 顶部统一 fail loud（单一出处）
    const anchors = await readAnchors(this.e.paths.anchorPath(c.root), this.e.fs)
    const groups = groupView(graph, axis, {
      conceptEntries: await this.e.concepts.load(c.root),
      endpoints: [...endpointNames(anchors)],
    })
    if (group && !groups.some(g => g.label === group)) {
      throw new Error(`[graph-browse] 轴「${axis}」下没有组「${group}」（可用：${groups.map(g => g.label).join('、') || '（空）'}）`)
    }
    const shown = groups.filter(g => !group || g.label === group)
    const nodeOf = (n: string) => ({
      node: n,
      depth: graph.depth[n] ?? 0,
      stage: effectiveStage(state, n),
      est: graph.estOf[n],
      difficulty: graph.difficultyOf[n],
      type: graph.typeOf[n],
      content_status: state[n]?.content.status ?? 'draft' as const,
    })
    return {
      course: c.name,
      axis,
      total: shown.reduce((s, g) => s + g.nodes.length, 0),
      groups: shown.map(g => ({ label: g.label, nodes: g.nodes.map(nodeOf) })),
      // 纯结构浏览继续可用，但 Broken 状态必须显式暴露，不伪装成 unseen/draft
      broken_notes: broken.map(b => ({
        path: b.path,
        ...(b.node ? { node: b.node } : {}),
        reason: b.reason,
      })),
    }
  }


  /** 前置路径查询：from 是否（以及经哪条链）是 to 的前置。 */
  async graphPath(courseKey: string | undefined, from: string, to: string): Promise<GraphPathResult> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph } = await this.e.loadView(c)
    if (!graph.nset.has(from)) throw new Error(`[graph-path] from 节点「${from}」不在课程「${c.name}」的图内。`)
    if (!graph.nset.has(to)) throw new Error(`[graph-path] to 节点「${to}」不在课程「${c.name}」的图内。`)
    const seen = new Set<string>([to])
    const parent: Record<string, string> = {}
    const queue = [to]
    while (queue.length) {
      const u = queue.shift()!
      // 悬空容错（#270 第五处，与 upstreamClosure 同一口径）：E2 断边名不入队
      // （无定义、给不出「先学什么」）；?? [] 兜 preOf 键缺席（防御性——现控制流
      // 入队的恒为图内节点，真正拦悬空的是 nset.has(p)）。
      for (const p of graph.preOf[u] ?? []) {
        if (!graph.nset.has(p) || seen.has(p)) continue
        seen.add(p)
        parent[p] = u
        queue.push(p)
      }
    }
    if (!seen.has(from)) {
      return { course: c.name, from, to, related: false, message: `「${from}」不在「${to}」的前置闭包内。` }
    }
    const chain = [from]
    let cur = from
    while (cur !== to) { cur = parent[cur]; chain.push(cur) }
    return {
      course: c.name,
      from,
      to,
      related: true,
      direct: graph.preOf[to].includes(from),
      closure_size: seen.size - 1,
      chain,
      depth_span: (graph.depth[to] ?? 0) - (graph.depth[from] ?? 0),
    }
  }

  async graphPropose(kind: 'edit' | 'enrich', yamlText: string): Promise<GraphProposeResult> {
    if (kind !== 'edit' && kind !== 'enrich') {
      throw new Error(`[propose] 非法 kind: ${String(kind)}（图谱域只受理 edit/enrich）`)
    }
    return kind === 'edit' ? this.e.proposals.proposeEdit(yamlText) : this.e.proposals.proposeEnrich(yamlText)
  }


  async graphApply(
    kind: 'edit' | 'enrich', pid?: number,
    opts?: { today?: string },
  ): Promise<GraphApplyResult> {
    if (kind !== 'edit' && kind !== 'enrich') {
      throw new Error(`[apply] 非法 kind: ${String(kind)}（图谱域只受理 edit/enrich）`)
    }
    // audit 门禁：目标课程存在 ERROR 时拒绝 apply；warns 摘要 + 健康分随 findings 返回
    const pending = await this.e.store.takePending(kind, pid)
    const today = opts?.today ?? (await this.e.learningDay()).today
    const audit = await this.e.seedAuditFor(pending.course, today)
    return kind === 'edit' ? this.e.proposals.applyEdit(pid, audit) : this.e.proposals.applyEnrich(pid, audit)
  }


  async graphReject(pid: number, note = ''): Promise<ProposalRec> {
    return this.e.proposals.reject(pid, note)
  }


  /** 名称建课（ADR-0076 §一：建课 = 名称即空图）：只收一个课程名，一个写入单元落全部
   * 脚手架（实现与门在 proposals.createCourse）。不自动初始化生成——零节点图不入任何
   * 自动触发点，第一次生长由学习者显式下发或加终点触发。 */
  async createCourse(name: string): Promise<CourseEntry> {
    return this.e.proposals.createCourse(name)
  }

  /** 添加终点（ADR-0076 §三：终点由学习者手动增删，立即写盘不等生成队列）：建零 pre
   * 新节点 + 落一条锚（实现与门在 proposals.addEndpoint）。落盘后的教练回合接线触发归
   * 宿主入队侧（force 豁免停摆短路，同课程在途去重）。 */
  async addEndpoint(courseKey: string, endpoint: string, goalNote?: string): Promise<{ course: string; endpoint: string }> {
    return this.e.proposals.addEndpoint(courseKey, endpoint, goalNote)
  }

  /** 删除终点（ADR-0076 §三）：锚与节点一并移除，已铺台阶留在图上成为末端
   * （实现与门在 proposals.removeEndpoint）。 */
  async removeEndpoint(courseKey: string, endpoint: string): Promise<{ course: string; endpoint: string; unhooked: string[] }> {
    return this.e.proposals.removeEndpoint(courseKey, endpoint)
  }


  /** 合并提案（#265 / ADR-0084：合并是这套系统里唯一的不可逆动作——走「提案 + 人确认」
   * 两段式，与图变更提案同规格）：**未确认不落盘**。登记表在 apply（面板 /proposals/apply，
   * 人的动作）之前一字不改；提案面显式声明不可逆语义（只并入、不拆分）。受理门与 apply
   * 双门各自在册对表（提案可能基于旧登记表）。 */
  async conceptMerge(courseKey: string, from: string, into: string, reason?: string): Promise<{
    proposal: number; kind: 'concept_merge'; course: string; from: string; into: string
    names: string[]; irreversible: true; warns: string[]
  }> {
    const r = await this.e.proposals.proposeConceptMerge(courseKey, from, into, reason)
    return {
      proposal: r.id, kind: r.kind, course: r.course, from: r.from, into: r.into,
      names: r.names, irreversible: true, warns: r.warns,
    }
  }

  /** 合并确认的执行面（面板 /proposals/apply，kind=concept_merge）：agent 无直调通道——
   * 唯一许给人判断的动作必须有门（ADR-0084）。 */
  async conceptMergeApply(pid?: number): Promise<{ kind: 'concept_merge'; course: string; from: string; into: string; names: string[] }> {
    return this.e.proposals.applyConceptMerge(pid)
  }

  /** 混淆对候选派生（#265）：从**题目共现**挖候选（同一节点题目各自 invokes 的概念对、
   * 错答先验与正答 invokes 的概念对），逐条产出**待审提案**（人审一次一条）——**不自动
   * 入册**（对齐「别名自动收编永远人审」的同一纪律）。已声明过的对不重复提名，已有
   * pending 提案的对不再堆；废弃条目退出候选面（ADR-0084 ②）。 */
  async conceptConfusableCandidates(courseKey?: string, max?: number): Promise<{
    course: string; scanned: number; filed: Array<{ id: number; a: string; b: string; weight: number }>
    message: string
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph } = await this.e.loadView(c)
    const entries = await this.e.concepts.load(c.root)
    const decl = declaredPairKeys(entries)
    const nodes: CooccurrenceNode[] = []
    for (const node of graph.order) {
      let questions: Array<{ id?: string; q?: string; invokes?: unknown }> = []
      try {
        questions = (await this.e.bank.load(this.e.paths.courseRoot(c.root), node)).questions
      } catch {
        // 挖矿面题库 Broken 排除留痕（#291）：其余节点照常挖（ADR-0071 宽容读取）
        this.e.logger.warn('graph.mine.bank_skip', { course: c.name, node })
        questions = [] // 题库 Broken/缺席不拦候选派生（其余节点照常挖；ADR-0071 宽容读取）
      }
      if (!questions.some(q => typeof q.invokes === 'string' && q.invokes.trim())) continue
      nodes.push({ node, questions, misconceptions: graph.misconceptionsOf[node] ?? [] })
    }
    const candidates = confusableCandidates(nodes, entries)
    // max 是位置参数（工具面 boundArgs 按 bind 序传参）：上限旋钮，缺省 CONFUSABLE_CANDIDATE_MAX，硬帽 50
    const cap = Math.max(1, Math.min(max ?? CONFUSABLE_CANDIDATE_MAX, 50))
    const filed: Array<{ id: number; a: string; b: string; weight: number }> = []
    for (const cand of candidates) {
      if (filed.length >= cap) break
      // 纯函数已剔除已声明对；这里防御性再挡一道（登记表在两次读取之间被并发改动的窗口）
      if (decl.has(conceptPairKey(cand.a, cand.b))) continue
      const p = await this.e.proposals.proposeConfusableCandidate(c.name, cand)
      filed.push({ id: p.id, a: p.a, b: p.b, weight: p.weight })
    }
    return {
      course: c.name, scanned: nodes.length, filed,
      message: filed.length
        ? `已产出 ${filed.length} 条待审混淆对候选提案（人审一次一条；接受后才入册）；共扫 ${nodes.length} 个带 invokes 的节点`
        : '没有新的混淆对候选：共现证据不足，或候选都已声明/已在待审队列（候选面不含废弃条目）',
    }
  }

  /** 合并候选派生（#274）：非对话通道的合并候选提议——确定性信号（① 名面重叠 /
   * ② teaches∪assumes 足迹雷同（#270 反向映射取材）/ ③ 题目 invokes 分布相近，零 LLM
   * 可回放）逐对产出 concept_merge **待审提案**（复用 proposeConceptMerge，含不可逆
   * 声明）。信任边界不动：apply 仍只有面板人审一条路（ADR-0084），派生只产提案、绝不
   * 自动入册。已声明 confusable 的对不提名（人已裁定易混而非同一）；已在待审队列的对
   * 不重复堆；废弃条目退出候选面。max 上限旋钮（缺省 CONFUSABLE_CANDIDATE_MAX，硬帽
   * 50——与 confusable 派生同一套人审吞吐纪律）。 */
  async conceptMergeCandidates(courseKey?: string, max?: number): Promise<{
    course: string; scanned: number
    filed: Array<{ id: number; from: string; into: string; weight: number }>
    message: string
  }> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph } = await this.e.loadView(c)
    const entries = await this.e.concepts.load(c.root)
    // ③ invokes 分布：概念 → invokes 它的节点集（题库 Broken/缺席不拦派生，其余节点照常挖；ADR-0071 宽容读取）
    const invokesNodesOf: Record<string, string[]> = {}
    let scanned = 0
    for (const node of graph.order) {
      let questions: Array<{ invokes?: unknown }> = []
      try {
        questions = (await this.e.bank.load(this.e.paths.courseRoot(c.root), node)).questions
      } catch {
        // 挖矿面题库 Broken 排除留痕（#291）：其余节点照常挖（ADR-0071 宽容读取）
        this.e.logger.warn('graph.mine.bank_skip', { course: c.name, node })
        questions = []
      }
      if (!questions.some(q => typeof q.invokes === 'string' && q.invokes.trim())) continue
      scanned++
      for (const q of questions) {
        if (typeof q.invokes !== 'string' || !q.invokes.trim()) continue
        const hit = resolveConcept(entries, q.invokes.trim())
        if (!hit || isDeprecated(hit)) continue
        const list = invokesNodesOf[hit.canonical] ??= []
        if (!list.includes(node)) list.push(node)
      }
    }
    // ② 足迹：teaches ∪ assumes 反向映射按概念合并（#270 单一出处，构造期折出）
    const footprintOf: Record<string, string[]> = {}
    for (const [concept, holders] of Object.entries(graph.taughtByOf)) footprintOf[concept] = [...holders]
    for (const [concept, holders] of Object.entries(graph.assumedByOf)) {
      const list = footprintOf[concept] ??= []
      for (const n of holders) if (!list.includes(n)) list.push(n)
    }
    const candidates = mergeCandidates(footprintOf, invokesNodesOf, entries)
    // max 是位置参数（工具面 boundArgs 按 bind 序传参）：上限旋钮，硬帽 50（与 confusable 同帽）
    const cap = Math.max(1, Math.min(max ?? CONFUSABLE_CANDIDATE_MAX, 50))
    const pendingPairs = await this.e.proposals.pendingConceptMergePairKeys()
    const filed: Array<{ id: number; from: string; into: string; weight: number }> = []
    for (const cand of candidates) {
      if (filed.length >= cap) break
      // 已在队列的跳过（登记表在两次读取之间被并发改动的窗口由这里兜住）
      const key = conceptPairKey(cand.a, cand.b)
      if (pendingPairs.has(key)) continue
      // 并入向取字典序在前者（确定性规则；语义上谁并谁入由人审定夺）
      const p = await this.e.proposals.proposeConceptMerge(
        c.name, cand.b, cand.a,
        `确定性派生（#274）：${cand.evidence.join('；')}`,
      )
      pendingPairs.add(key) // 同一扫描内不重复登记
      filed.push({ id: p.id, from: p.from, into: p.into, weight: cand.weight })
    }
    return {
      course: c.name, scanned, filed,
      message: filed.length
        ? `已产出 ${filed.length} 条待审合并提案（不可逆：只并入、不拆分；人审一次一条）；共扫 ${scanned} 个带 invokes 的节点`
        : '没有新的合并候选：确定性信号不足，或候选都已声明 confusable/已在待审队列（候选面不含废弃条目）',
    }
  }

  /** 混淆对候选确认的执行面（面板 /proposals/apply，kind=confusable_pair）：只写提案
   * 声明的那个方向（单向是待复核态，ADR-0084 ③）。 */
  async conceptConfusableApply(pid?: number): Promise<{ kind: 'confusable_pair'; course: string; a: string; b: string; changed: boolean }> {
    return this.e.proposals.applyConfusableCandidate(pid)
  }

  /** 概念足迹读视图（#268，GET /concepts/footprint）：纯读零落盘——词条档 + 教学面
   * （#270 反向映射）+ 题目面（invokes 折叠口径住 growth-subsystem 单一出处）+ 漂移面
   * 三类（孤儿/悬空/单向，恒全表派生）。query = 子串发现非存在性判定。与教练
   * concept_footprint 同数据源（登记表 + 反向映射 + conceptInvokesOf），漂移面是
   * 面板独有增量；教练侧渲染仍走自己的文本折叠（含插入挂点判读），未消费本核。 */
  async conceptFootprint(courseKey?: string, query?: string): Promise<ConceptFootprintDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const entries = await this.e.concepts.load(c.root)
    const { graph } = await this.e.loadView(c)
    const invokes = await this.e.conceptInvokesOf(c)
    return {
      course: c.name,
      ...conceptFootprintCore({ entries, taughtByOf: graph.taughtByOf, assumedByOf: graph.assumedByOf, invokes, query }),
    }
  }

  /** enc 覆盖层回填入口（#148 权重新语义）：对课程里已有 Ready 内容、且反哺候选或
   * 题目 invokes 投影尚有未落 enc 边的非 practice 节点，批量生成一个 pending enrich
   * 提案（每节点一条字段条目：既有声明 enc 原样保留 + 补闭包内提升边）。权重 =
   * invokes 覆盖率投影（该前置被 invokes 的题数份额，调用站阶梯已退役）；候选边无
   * invokes 数据时落 schema 缺省权重 1，投影-only 边带投影 note。sha256 指纹锚定正典
   * 版本。可重入——已全覆盖节点不产生条目，重跑不会重复膨胀、不与已声明 enc 冲突；
   * practice 节点维持合法空 enc 不动。提案走人审（ADR-0003 修订变更语义）：过审计后由
   * graphApply(kind=enrich) 生效，留痕可回溯（state/覆盖层.jsonl）。 */
  async graphEncBackfill(courseKey?: string): Promise<GraphEncBackfillResult> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    assertNoBrokenNotes('enc-backfill', broken)
    // 既有声明 enc 的原始形态在 region 节点上（图视图 encOf 丢 note）；declaredEncOf 一次建表
    const encOfNode = declaredEncOf(graph)
    const fields: EnrichFieldEntry[] = []
    let scanned = 0
    for (const node of graph.order) {
      const fm = state[node]
      if (!fm || !hasReadyContent(fm)) continue
      if (graph.typeOf[node] === 'practice') continue // practice 节点无题，enc: [] 合法空态
      const { body } = await loadNote(this.e.paths.courseNotePath(c.root, node), this.e.fs)
      // 投影（#148）：节点在库题目的 invokes 覆盖率 → 前置节点的出生 w（候选边同享此权重）
      const proj = Content.invokesProjection(graph, node, (await this.e.bank.load(this.e.paths.courseRoot(c.root), node)).questions)
      const projW = new Map(proj.map(e => [e.node, { w: e.w, note: e.note }]))
      if (!Content.candidateCallSites(body).size && !proj.length) continue
      scanned++
      const declared = encOfNode.get(node) ?? []
      const declaredName = new Set(declared.map(e => e.node))
      const target = [...declared]
      for (const p of Content.encPromotion(graph, node, body, projW)) {
        if (declaredName.has(p.node)) continue
        target.push(p)
        declaredName.add(p.node)
      }
      for (const e of proj) {
        if (declaredName.has(e.node)) continue // 已声明/候选已补 → 保留在先形态
        target.push(e)
        declaredName.add(e.node)
      }
      if (target.length === declared.length) continue // 候选已全落 enc → 无变更
      fields.push({ node, enc: target })
    }
    if (!fields.length) {
      return { course: c.name, scanned, ops: 0, proposal: null, message: '没有需要回填的节点：候选已全落 enc，或没有可提升的反哺候选与 invokes 投影。' }
    }
    const yamlText = YAML.stringify({
      course: c.name,
      reason: `enc 反哺回填（覆盖层通道，ADR-0008 / #148 权重=invokes 覆盖率投影）：${fields.length} 个节点按既有 Ready 内容与在库题目补成分技能边`,
      fields,
    })
    const prop = await this.graphPropose('enrich', yamlText)
    return {
      course: c.name, scanned, ops: fields.length, proposal: prop,
      message: `已为 ${fields.length} 个节点生成 pending enrich 提案 #${String((prop as { id?: unknown }).id)}（覆盖层通道，sha256 指纹锚定正典）——过审后 learnhub_graph_apply(kind=enrich) 生效（可重入，无遗漏则返回 ops=0）`,
    }
  }


  async graphProposals(status?: string, kind?: string): Promise<ProposalRec[]> {
    return this.e.proposals.list(status, kind)
  }


  /** 提案统一 apply 入口（图谱域 + 项目域 + 实验域 + 概念层治理域；面板
   * /proposals/apply 消费）。kind 显式照抄提案记录——未知 kind 报错，绝不静默归一成
   * gen。图谱域走 audit 门禁，项目域无图审计（takePending 各自在 apply 内做）；
   * project_plan 走引擎包装（修订快照 diff + 换线/补支触发随结果带出，#149）；
   * concept_merge / confusable_pair（#265）是**概念层治理动作**——只从面板可达
   * （agent 无直调通道）：合并不可逆、易混对候选不许自动入册，两条都要求人按一次。 */
  async proposalApply(
    kind: string, pid?: number,
  ): Promise<GraphApplyResult | ProjectApplyResult | ExperimentStartResult | ConceptApplyResult> {
    if (kind === 'experiment') return this.e.experimentApply(pid)
    if (kind === 'project_plan') return this.e.applyProjectPlanProposal(pid)
    if (kind === 'project_milestone') return this.e.projects.applyMilestone(pid)
    if (kind === 'edit' || kind === 'enrich') return this.graphApply(kind, pid)
    if (kind === 'concept_merge') return this.conceptMergeApply(pid)
    if (kind === 'confusable_pair') return this.conceptConfusableApply(pid)
    throw new Error(`[apply] 非法 kind: ${String(kind)}（允许 ${PROPOSAL_KINDS.join('/')}）`)
  }


  /** 提案按 id apply（项目域工具入口）：记录自证 kind，pending 项目提案才受理。 */
  async projectApply(pid: number): Promise<ProjectApplyResult> {
    const list = await this.e.store.loadProposals()
    const prop = list.find(p => p.id === pid)
    if (!prop || prop.status !== 'pending') throw new Error(`[project-apply] 提案 #${pid} 不存在或已决。`)
    if (prop.kind === 'project_plan') return this.e.applyProjectPlanProposal(pid)
    if (prop.kind === 'project_milestone') return this.e.projects.applyMilestone(pid)
    throw new Error(`[project-apply] 提案 #${pid} 是 ${prop.kind} 提案——图谱域走 learnhub_graph_apply。`)
  }
}
