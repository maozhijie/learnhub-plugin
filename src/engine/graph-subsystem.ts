import { mkdir } from 'node:fs/promises'
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

import type { Store } from './store.ts'
import type { Paths } from './paths.ts'
import type { Projects, ProjectApplyResult } from './projects.ts'
import type { GraphProposals, ApplyAudit } from './proposals.ts'
import type { ConceptRegistry } from './concepts.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank } from './question-bank.ts'
import type { NoteSourceManifest } from './note-source.ts'
import type { Graph } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { Fm } from './types.ts'

/** Graph 域对门面的窄面（门面构造时传 this）：领域类与纯函数直接 import，
 * 这里只列门面私有方法/字段——它们无法从模块导入。 */
export interface GraphDeps {
  store: Store
  paths: Paths
  projects: Projects
  proposals: GraphProposals
  concepts: ConceptRegistry
  registry: Registry
  bank: QuestionBank
  noteManifest: NoteSourceManifest
  vaultRoot: string
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  loadPrompt(kind: string): Promise<string>
  assertNoteOk(course: { root: string }, graph: Graph, broken: BrokenNote[], node: string, tool: string): void
  seedAuditFor(courseName: string, today: string): Promise<ApplyAudit>
  applyProjectPlanProposal(pid?: number, opts?: { pairApply?: boolean }): Promise<ProjectApplyResult>
  experimentApply(pid?: number): Promise<{ id: number; title: string; arm_today: string }>
}
import { readVaultLinksCache as readVaultLinksCache$mod } from './vault-links.ts'
import type { VaultLinkPrior } from './analysis.ts'
import { analyzeGraph } from './analysis.ts'
import { effectiveStage, runAudit } from './audit.ts'
import { Content } from './content.ts'
import { declaredEncOf } from './graph.ts'
import { atomicWrite } from './io.ts'
import type { LlmComplete } from './llm.ts'
import { readNoteSourceExcludes } from './note-source.ts'
import { hasReadyContent, loadNote } from './notes.ts'
import { decompileTerms } from './project-decompile.ts'
import type { EnrichFieldEntry } from './proposals.ts'
import type { SeedDraftRequest, SeedProposalSpec } from './seed.ts'
import { isSeedGraph, readAnchor, seedRepairPrompt, validateSeedProposal } from './seed.ts'
import { assertNoBrokenNotes } from './sessions.ts'
import { masteryOfFm } from './srs.ts'
import type { GNode, ProposalRec } from './types.ts'
import { PROPOSAL_KINDS } from './types.ts'
import type { VaultLinkCandidateView, VaultLinksDoc } from './vault-links.ts'
import { mapEdgesToNodes, orientLinkPair, readVaultLinkDirExcludes, scanVaultLinks, scoreTier } from './vault-links.ts'
import { searchVaultPrior } from './vault-prior.ts'
import type { GraphApplyResult, GraphBrowseDoc, GraphDoc, GraphElementsDoc, GraphEncBackfillResult, GraphNodeDoc, GraphPathResult } from './views/graph.ts'
import type { ExperimentStartResult } from './views/lab.ts'
import type { GraphProposeResult } from './views/proposals.ts'
import { YAML } from './yaml.ts'
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
    // 种子图豁免（#142）：图仍 = 终点锚种子节点全集时，Float（missing_pre）建议豁免
    const anchor = await readAnchor(this.e.paths.anchorPath(c.root))
    const seedPhase = isSeedGraph(anchor, graph)
    const doc = await analyzeGraph(c.name, graph, state, this.e.store, (await this.e.learningDay()).today, vaultLinks, seedPhase)
    if (elementsOnly) return { nodes: doc.nodes, edges: doc.edges }
    return doc
  }

  /** 读链接先验缓存（Missing = null 合法空态；坏档 fail loud——它是引擎 state 契约文件）。 */
  private async readVaultLinksCache(): Promise<VaultLinksDoc | null> {
    return readVaultLinksCache$mod(this.e.paths.vaultLinksPath)
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
    const dirExcludes = await readVaultLinkDirExcludes(this.e.paths.learnhubConfigPath)
    const doc = await scanVaultLinks({
      vaultRoot: this.e.vaultRoot,
      centerRel: this.e.paths.centerRoot.slice(this.e.vaultRoot.length + 1),
      dirExcludes,
      pathExcludes: await readNoteSourceExcludes(this.e.paths),
    })
    await mkdir(this.e.paths.centerStateDir, { recursive: true })
    await atomicWrite(this.e.paths.vaultLinksPath, JSON.stringify(doc, null, 1) + '\n')
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
      if (!dir.ok) {
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
    let gnode: GNode | undefined
    for (const r of graph.regions) for (const b of r.blocks) {
      const hit = b.nodes.find(n => n.name === node)
      if (hit) { gnode = hit; break }
    }
    // 前置传递闭包（沿 pred BFS；不含自身），按深度降序=先学在前
    const seen = new Set<string>([node])
    const queue = [node]
    while (queue.length) {
      const u = queue.shift()!
      for (const p of graph.preOf[u]) if (!seen.has(p)) { seen.add(p); queue.push(p) }
    }
    const closure = [...seen].filter(n => n !== node)
      .sort((a, b) => (graph.depth[b] ?? 0) - (graph.depth[a] ?? 0))
    const fm = state[node]
    return {
      course: c.name,
      node,
      region: graph.blockOf[node][1],
      block: graph.blockOf[node][2],
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


  /** 区/块浏览：按区名/块名过滤的节点清单（探索某区域的结构与内容状态）。 */
  async graphBrowse(courseKey: string | undefined, region?: string, block?: string): Promise<GraphBrowseDoc> {
    const c = await this.e.registry.resolve(courseKey)
    const { graph, state, broken } = await this.e.loadView(c)
    const blockNames = [...new Set(graph.regions.flatMap(r => r.blocks.map(b => b.name)))]
    let regionName = region
    if (!regionName && block) {
      const hits = graph.regions.map(r => ({
        region: r.name,
        count: r.blocks.filter(b => b.name === block).length,
      })).filter(h => h.count > 0)
      if (!hits.length) {
        throw new Error(`[graph-browse] 只按块浏览时块「${block}」不存在（可用块：${blockNames.join('、') || '（无）'}）`)
      }
      if (hits.length > 1 || hits[0]!.count > 1) {
        const where = hits.map(h => `${h.region}（${h.count} 处）`).join('、')
        throw new Error(`[graph-browse] 块「${block}」不唯一（${where}）——请加 region 限定后再浏览。`)
      }
      regionName = hits[0]!.region
    }
    if (regionName && !graph.regions.some(r => r.name === regionName)) {
      throw new Error(`[graph-browse] 区「${regionName}」不存在（可用：${graph.regions.map(r => r.name).join('、')}）`)
    }
    if (regionName && block && !graph.regions.find(r => r.name === regionName)?.blocks.some(b => b.name === block)) {
      const regionBlocks = [...new Set(graph.regions.find(r => r.name === regionName)!.blocks.map(b => b.name))]
      throw new Error(`[graph-browse] 区「${regionName}」中没有块「${block}」（可用：${regionBlocks.join('、') || '（空）'}）`)
    }
    const regions = graph.regions
      .filter(r => !regionName || r.name === regionName)
      .map(r => ({
        name: r.name,
        blocks: r.blocks
          .filter(b => !block || b.name === block)
          .map(b => ({
            name: b.name,
            nodes: b.nodes.map(n => ({
              node: n.name,
              depth: graph.depth[n.name] ?? 0,
              stage: effectiveStage(state, n.name),
              est: graph.estOf[n.name],
              difficulty: graph.difficultyOf[n.name],
              type: graph.typeOf[n.name],
              content_status: state[n.name]?.content.status ?? 'draft',
            })),
          })),
      }))
    const total = regions.reduce((s, r) => s + r.blocks.reduce((t, b) => t + b.nodes.length, 0), 0)
    return {
      course: c.name,
      total,
      regions,
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
      for (const p of graph.preOf[u]) if (!seen.has(p)) { seen.add(p); parent[p] = u; queue.push(p) }
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

  async graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult> {
    if (kind !== 'edit' && kind !== 'seed' && kind !== 'enrich') {
      throw new Error(`[propose] 非法 kind: ${String(kind)}（图谱域只受理 edit/seed/enrich）`)
    }
    if (kind === 'seed') return this.e.proposals.proposeSeed(yamlText)
    return kind === 'edit' ? this.e.proposals.proposeEdit(yamlText) : this.e.proposals.proposeEnrich(yamlText)
  }


  async graphApply(kind: 'edit' | 'seed' | 'enrich', pid?: number): Promise<GraphApplyResult> {
    if (kind !== 'edit' && kind !== 'seed' && kind !== 'enrich') {
      throw new Error(`[apply] 非法 kind: ${String(kind)}（图谱域只受理 edit/seed/enrich）`)
    }
    // audit 门禁：目标课程存在 ERROR 时拒绝 apply；warns 摘要 + 健康分随 findings 返回
    // （mode=new 的种子提案课程尚未建 data 目录，audit 空跑——种子图豁免在 runAudit/applySeed 内按锚判）
    const pending = await this.e.store.takePending(kind, pid)
    const today = (await this.e.learningDay()).today
    const audit = await this.e.seedAuditFor(pending.course, today)
    if (kind === 'seed') return this.e.proposals.applySeed(pid, audit, today)
    return kind === 'edit' ? this.e.proposals.applyEdit(pid, audit) : this.e.proposals.applyEnrich(pid, audit)
  }


  async graphReject(pid: number, note = ''): Promise<ProposalRec> {
    return this.e.proposals.reject(pid, note)
  }


  /** 面板下发的种子起草（学习图页建课/换终点表单入口）：目标描述 + 模式 + 目标类型
   * （coverage 附块工作表）→「种子提案」提示词组装（vault 先验选配——熟悉边界定位）→
   * llm → 种子 YAML 干跑校验门（validateSeedProposal 直跑，未过回灌修复一轮）→
   * proposeSeed 权威受理（schema/注册表对账/结构/概念对表在受理侧重跑全量），一次人审
   * 即开工。课程名/模式/目标类型/工作表是表单绑定字段——以输入为准，不信模型照抄。
   * llm 为注入缝（#137）。 */
  async seedPropose(
    input: SeedDraftRequest,
    llm: LlmComplete,
  ): Promise<{ id: number; course: string; mode: 'new' | 'reseed'; goal_type: string; endpoint: string; starts: number; prior_hits: number; repaired: boolean }> {
    const course = input.course.trim()
    const goal = input.goal.trim()
    if (!course) throw new Error('[seed-propose] 课程名必填（mode=new 自拟新名，mode=reseed 选既有课程）。')
    if (!goal) throw new Error('[seed-propose] 目标描述必填——种子起草只认学习者的目标，不猜。')
    const mode = input.mode ?? 'new'
    const goalType = input.goalType ?? 'capability'
    const worksheet = goalType === 'coverage' ? (input.worksheet ?? []).filter(w => typeof w.block === 'string' && w.block.trim()) : []
    if (goalType === 'coverage' && !worksheet.length) {
      throw new Error('[seed-propose] 覆盖锚定必须携带非空块工作表（{block, note?} 列表）；能力锚定不需要。')
    }
    // vault 先验选配（只读检索）：注册清单 Missing = 零命中合法，退化常识基线
    let prior = ''
    let priorHits = 0
    if (input.useVaultPrior === true) {
      const manifest = await this.e.noteManifest.load()
      const titles = manifest.sources.map(s => s.title ?? s.path.split('/').pop()!.replace(/\.md$/i, ''))
      const terms = decompileTerms(goal, titles)
      const centerRel = this.e.paths.centerRoot.slice(this.e.vaultRoot.length + 1)
      const hits = terms.length ? await searchVaultPrior(this.e.vaultRoot, centerRel, terms) : []
      priorHits = hits.length
      if (hits.length) {
        const items = hits.map(h => `- 《${h.title}》（${h.path}）\n  > ${h.excerpt.replaceAll('\n', '\n  > ')}`).join('\n')
        prior = `## 学习者已有理解（Vault 先验）\n\n以下是学习者个人 Vault 里与目标相关的笔记摘录（只读检索所得）：\n\n${items}\n\n起点定位要求：把起点放在熟悉边界——笔记已稳定覆盖的内容不作起点（那是可快速略过的地形，在 reason 里点一句）；摘录只是他记过的东西，只读，永不改写。`
      }
    }
    const tpl = await this.e.loadPrompt('种子提案')
    const pack = `${tpl}\n\n---\n\n## 目标描述（学习者原文）\n\n${goal}\n\n## 模式与绑定（照抄，不自拟）\n\n- 课程名：${course}\n- 模式：${mode}\n- 目标类型：${goalType}`
      + (goalType === 'coverage' ? `\n- 块工作表（照抄块名）：\n${worksheet.map(w => `  - block: ${w.block}`).join('\n')}` : '')
      + (prior ? `\n\n---\n\n${prior}` : '')
    const gateOnce = (raw: string): { errors: string[]; spec: SeedProposalSpec | null } => {
      let doc: unknown
      try {
        doc = YAML.parseModel(raw)
      } catch (err) {
        return { errors: [`YAML 解析失败：${err instanceof Error ? err.message : String(err)}`], spec: null }
      }
      const v = validateSeedProposal(doc)
      return { errors: v.errors ?? [], spec: v.spec ?? null }
    }
    let raw = await llm(pack)
    let gate = gateOnce(raw)
    let repaired = false
    if (gate.errors.length) {
      repaired = true
      raw = await llm(seedRepairPrompt(pack, raw, gate.errors.map(x => `  ✗ ${x}`)))
      gate = gateOnce(raw)
    }
    if (gate.errors.length || !gate.spec) {
      const e: Error & { code?: string } = new Error(
        `[seed-propose] 模型产出未过种子校验门（已自动修复重试一轮，提案未受理）：\n${gate.errors.map(x => `  ✗ ${x}`).join('\n')}`)
      e.code = 'SEED_GATE_FAILED'
      throw e
    }
    const spec = gate.spec
    spec.course = course
    spec.mode = mode
    spec.goal_type = goalType
    if (goalType === 'coverage') spec.worksheet = worksheet
    else delete spec.worksheet
    const r = await this.graphPropose('seed', YAML.stringify(spec)) as { id: number; endpoint: string; starts: number }
    return { id: r.id, course, mode, goal_type: goalType, endpoint: r.endpoint, starts: r.starts, prior_hits: priorHits, repaired }
  }


  /** 概念并入（#141 条目禁删只并入；human 领域判断的执行面）：from 整条并入 into，
   * 名字并集，旧地址经别名续解析；journal 留痕。 */
  async conceptMerge(courseKey: string, from: string, into: string): Promise<{ course: string; into: string; names: string[] }> {
    const c = await this.e.registry.resolve(courseKey)
    const r = await this.e.concepts.merge(c.root, from, into)
    await this.e.store.appendJournal({
      course: c.name, node: '*', rating: null, kind: 'concept_merge', elapsed_days: 0,
      detail: `概念「${from}」并入「${r.into}」（名字并集：${r.names.join('、')}）`,
    })
    return { course: c.name, ...r }
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
      const [, regionName] = graph.blockOf[node]
      const { body } = await loadNote(this.e.paths.courseNotePath(c.root, regionName, node))
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


  /** 提案统一 apply 入口（图谱域 + 项目域 + 实验域；面板 /proposals/apply 消费）。
   * kind 显式照抄提案记录——未知 kind 报错，绝不静默归一成 gen。图谱域走 audit 门禁，
   * 项目域无图审计（takePending 各自在 apply 内做）；project_plan 走引擎包装
   * （修订快照 diff + 换线/补支触发随结果带出，#149）。 */
  async proposalApply(
    kind: string, pid?: number,
  ): Promise<GraphApplyResult | ProjectApplyResult | ExperimentStartResult> {
    if (kind === 'experiment') return this.e.experimentApply(pid)
    if (kind === 'project_plan') return this.e.applyProjectPlanProposal(pid)
    if (kind === 'project_milestone') return this.e.projects.applyMilestone(pid)
    if (kind === 'edit' || kind === 'seed' || kind === 'enrich') return this.graphApply(kind, pid)
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
