/**
 * 命令注册表·图谱域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'

export const 图谱域 = {
  'agent-guide': command({
    id: "agent-guide",
    args: {},
    domain: "图谱",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/agent-guide" }
      }
    ]
  }),
  'compass': command({
    id: "compass",
    summary: "Read a course compass (罗盘, ADR-0033 transparency device #143): the resident non-commitment route sketch at the course root — current 剩余路线 (route, coach-owned, rewritten per growth batch), the learner annotation area (软输入: read it before planning growth batches; proposals, never orders), and the weekly sandbox ETA (quantile bands, 模型推演非承诺). Missing file = legal empty state (course not seeded yet). This file NEVER enters completion criteria or any authority — do not treat hand-edited routes as structure changes.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" }
    },
    engine: "growth2.compassRead",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_compass",
        bind: ["course"]
      }
    ]
  }),
  'compass-paint': command({
    id: "compass-paint",
    summary: "Paint or repaint the compass route (罗盘 #143): runs through the generation queue as ONE deep-effort tool loop (#163) — before the route gate the coach may self-verify node/region names against read-only engine views (graph, concept registry, compass, endpoint anchor; at most 6 tool rounds). Only the 剩余路线 section is rewritten (annotations preserved byte-for-byte, ETA reset for the weekly refresh). The route is a non-commitment sketch: stages toward the endpoint, candidate steps marked (候选), no time promises. A route failing the format gate (non-empty, no ## headings, length cap) leaves the compass untouched. Run right after a seed apply (the apply lands the scaffold with a 待初画 placeholder) and after a reseed. The call enqueues the compass job and waits for its terminal message; cancellation goes through the generate page. Completion criteria never read this file.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" }
    },
    engine: "growth2.compassPaint",
    domain: "图谱",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_compass_paint" }
    ]
  }),
  'concept-merge': command({
    id: "concept-merge",
    summary: "Merge one concept-registry entry into another (概念登记表 #141, human-decision surface): the absorbed entry disappears and ALL of its names (canonical + aliases) become aliases of the surviving entry, so every historical address keeps resolving — entries are never deleted, only merged. Use when the same concept was minted twice under different names (same meaning, confirmed by the learner); deepening a concept to a higher tier REUSES the same entry and is NOT a merge. Journal-tracked; the registry file is 课程根/概念登记表.yaml.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      from: { type: "string", description: "Name (canonical or alias) of the entry to absorb", required: true },
      into: { type: "string", description: "Name (canonical or alias) of the surviving entry", required: true }
    },
    engine: "graph.conceptMerge",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_concept_merge",
        bind: ["course", "from", "into"]
      }
    ]
  }),
  'graph-analyze': command({
    id: "graph-analyze",
    summary: "Analyze a course knowledge graph: structural stats, unreachable nodes, bottlenecks, lapse hotspots, graph health score (0-100, see health), next-batch suggestions (suggestions.expand_blocks/missing_pre/unconverged, plus jump_candidates + jump_total — cognitive-jump edges needing a verdict each — and merge_blocks), the full per-node schema (schema: pre/enc/est/bloom/difficulty/note per node — the data basis for edge-level self-checks), plus cytoscape render elements. Returns JSON. Run before planning each batch of graph edits; the next-batch plan must cite concrete entries from health/suggestions.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled", read: "query" },
      elementsOnly: { type: "boolean", description: "Only output cytoscape render elements (nodes/edges)" }
    },
    engine: "graph.graphAnalyze",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_analyze",
        bind: ["course", "elementsOnly"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/graph" }
      }
    ]
  }),
  'graph-apply': command({
    id: "graph-apply",
    summary: "Decide a pending graph proposal: apply (audit-gated, writes data/*.yaml with rename linkage + journal + snapshot; kind=enrich re-checks the sha256 content fingerprints and refuses stale proposals; kind=seed lands the endpoint anchor state/终点锚.json + start/endpoint nodes with coarse placeholder edges, seed graphs get the shape-warning & health-threshold exemption) or reject (kept on record). Seed proposals (kind=seed) are the new-course entry and the ONLY endpoint-change channel — they always wait for the one human review. In edit batches the agent applies directly after gates pass; revision changes wait for human review first (ADR-0003). The apply result carries findings: audit warns plus a health-score hint when below the quality baseline (suppressed while the graph is still just the seed) — address them in the next batch.",
    args: {
      kind: { type: "string", description: "\"seed\" (course entry / endpoint change) or \"edit\" (change ops) or \"enrich\" (overlay backfill)", required: true },
      id: { type: "number", description: "Proposal id as a positive integer; omit only for the latest pending of this kind" },
      reject: { type: "boolean", description: "true to reject instead of apply" },
      note: { type: "string", description: "Rejection reason (recorded)" }
    },
    domain: "图谱",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_graph_apply" }
    ]
  }),
  'graph-browse': command({
    id: "graph-browse",
    summary: "Browse a course graph by region and/or block: node listings with depth/stage/est/difficulty/type/content status. Omit both filters to list every region (structure overview); give region (and optionally block) to explore one area. A block without a region succeeds only when exactly one block with that name exists; zero matches or ambiguity across regions fails with the matching region list so you can add the region filter. Unknown regions/blocks fail loud with valid names.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" },
      region: { type: "string", description: "Region name filter" },
      block: { type: "string", description: "Block name filter (requires region when ambiguous)" }
    },
    engine: "graph.graphBrowse",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_browse",
        bind: ["course", "region", "block"]
      }
    ]
  }),
  'graph-enc-backfill': command({
    id: "graph-enc-backfill",
    summary: "Backfill enc (component-skill) edges for a course via the enrichment-overlay channel (#140, weight semantics #148): every non-practice node with ready content whose note body / exercise metadata declares enc_candidates or whose bank questions invoke prereq-taught concepts (invokes-coverage projection) that are not yet declared as enc becomes one field entry (whole-replace enc). Weights = the invokes-coverage projection (share of the node's questions invoking concepts taught by that prereq; candidate edges without invokes data land the schema-default weight 1 — the old call-site ladder is retired). Queued as a SINGLE pending enrich proposal with sha256 fingerprints of the canonical region files. Nothing changed returns ops=0. Re-runnable — already-covered nodes produce no entries; practice nodes keep legal empty enc. Use for the A3 pilot when enabling that course, then review/apply with learnhub_graph_apply(kind=enrich).",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled", read: "text" }
    },
    engine: "graph.graphEncBackfill",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_enc_backfill",
        bind: ["course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/graph/backfill" },
        bind: ["course"]
      }
    ]
  }),
  'graph-link-backfill': command({
    id: "graph-link-backfill",
    summary: "Turn vault link priors into enc candidate edges (V-2 #91) via the enrichment-overlay channel (#140): mapped pairs with w ≥ 0.7 whose direction resolves INSIDE the pre-transitive-closure become field entries (whole-replace enc; declared enc preserved, new edges noted with the source link evidence for traceability), queued as a SINGLE pending enrich proposal per course with sha256 fingerprints of the canonical region files. Pairs without a pre relation are NOT forced (enc contract/E7: enc target must sit in the holder's prereq closure) — they come back as blocked_no_pre with a why, for you to add pre edges explicitly or drop. Re-runnable; already-declared edges are skipped. Requires learnhub_vault_links_scan to have run (fails loud with a pointer otherwise). Review/apply with learnhub_graph_apply(kind=enrich).",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" }
    },
    engine: "graph.graphLinkBackfill",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_link_backfill",
        bind: ["course"]
      }
    ]
  }),
  'graph-node': command({
    id: "graph-node",
    summary: "Inspect one graph node in depth: schema field values (pre/est/type/bloom/difficulty/note), direct successors, enc component-skill edges with weights and notes, block placement, learning stage/content status, and the full transitive prerequisite closure (sorted deepest-first). Use to drill into a single node without pulling the whole graph.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" },
      node: { type: "string", description: "Node name", required: true }
    },
    engine: "graph.graphNode",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_node",
        bind: ["course", "node"]
      }
    ]
  }),
  'graph-path': command({
    id: "graph-path",
    summary: "Ask whether one node is a (transitive) prerequisite of another and via which chain: returns related, direct, the BFS shortest chain from→…→to, the full prerequisite-closure size of `to`, and the depth span. Use for teaching-path planning and for explaining why something is locked.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" },
      from: { type: "string", description: "Candidate prerequisite node", required: true },
      to: { type: "string", description: "Target node", required: true }
    },
    engine: "graph.graphPath",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_path",
        bind: ["course", "from", "to"]
      }
    ]
  }),
  'graph-proposals': command({
    id: "graph-proposals",
    summary: "List graph proposals by status — use status=pending to see what awaits human review in the panel, with the proposal id, course, reason, and op summary. After the user decides in the panel, apply with learnhub_graph_apply using that id.",
    args: {
      status: { type: "string", description: "Filter by status (default pending; e.g. applied/rejected)" },
      kind: { type: "string", description: "Filter by kind: edit / seed / enrich / project_plan / project_milestone / experiment" }
    },
    engine: "graph.graphProposals",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_proposals",
        bind: ["status", "kind"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/proposals" },
        bind: []
      }
    ]
  }),
  'graph-propose': command({
    id: "graph-propose",
    summary: "Submit a graph proposal. Schema quick reference — write YAML strictly to this, wrong key names are rejected. kind=seed (#142) is the NEW-COURSE ENTRY: 1-3 start nodes + one endpoint node — starts must be SINGLE-BEHAVIOR units a zero-basis learner can step onto from common knowledge, with ZERO compound/blanket concepts (「Python 基础语法」-style blanket names fail as starts; compound content belongs to the growth path, ADR-0040); the engine lands coarse placeholder edges (endpoint.pre = starts), one human review then the course starts. Seed nodes carry ZERO enc and ZERO est (rejected if declared); goal_type defaults to capability (completion = last-step mastery folded from endpoint.pre + closure health + sealed closing declaration, ADR-0056) — coverage must be explicit AND carry a non-empty worksheet list ({block, note?, done?}; capability+worksheet is rejected). mode=new requires the course NOT be registered (the engine scaffolds the registry entry + dirs on apply); mode=reseed requires it — endpoint change / worksheet update of an existing course, the ONLY anchor-edit channel (no direct anchor writes; the endpoint-anchored node is also guarded: del_node/rename via kind=edit are rejected). Start entries may declare basis: baseline (common knowledge start) / vault (prior familiarity boundary) / project (decompiled cluster; goal decompilation #149 stamps it automatically on the starts it files). Seed node keys: name/region/block/note?/bloom?/difficulty?/teaches?/assumes?/misconceptions?. kind=edit (per batch) top-level keys: course; reason?; concepts? ([{canonical, aliases?, definition?}] — concept-registry minting block, #141: names land in 课程根/概念登记表.yaml with the SAME apply transaction, nothing written while the proposal is pending/rejected); ops[] — add_node defines a new node via key `name` (unified with graph YAML in schema v2; the old `node` key is rejected): add_node{name, region, block, pre, est? (minutes, positive), bloom? (记忆/理解/应用/分析/评价/创造), difficulty? (1-5), type?: practice, note?, enc?, teaches? ({concept: 知道|会用|能教}, 1-8), assumes? ({concept: tier}, 3-10 when present), misconceptions? ([{concept, model}], ≤3 per concept course-wide)}; every other op targets an existing node via key `node`: set_pre{node, pre} replaces the whole pre set (pre is required, [] to clear); set_enc{node, enc} replaces the whole enc list ([skill] or [{node, w, note}]; enc is required, [] to clear); del_node{node}; rename{node, new}; move{node, region, block}; set_note{node, note}. Generation-time discipline the gates cannot check (ADR-0040): each add_node is ONE independent learning act — self-question whether a zero-basis learner could pick it up from its pre within 30 minutes, else split or add a prerequisite first; most names are action sentences (解/求/推导…, no「理解导数」-style level-unclear near-duplicates, no blanket compounds); pre is the COMPLETE direct-prerequisite set (no transitive padding); give every new pre edge a necessity verdict (delete-the-edge test: no concrete failure point = redundant, drop it). Edge-light rule: graph YAML carries ZERO edge metadata — candidate edges stay in the proposal, insertion origin derives from the proposal journal, probation lives in state/边实验.jsonl (fields like origin/status/probation are rejected). Growth-batch note region (#145/#146): note{operator: 前进|插入|巩固|旁支|换向, reason, disagreement?, recheck?} marks the batch as a coach-round verdict; an insertion batch (operator=插入 with add_node ops) MUST preregister its recheck — note.recheck{metric: 前进恢复|卡点集中度降幅|保留率恢复 (exactly one, same source as the symptom), days? (learning days, default 10, clamped to [5,20] with a warn)} — the engine auto-adjudicates at expiry (proven, or auto-prune via del_node + coarse-edge restore, zero human review); recheck on non-insertion batches is rejected, and insertion batches are gate-throttled when the recheck pass rate bottoms out or the insertion/side-branch share exceeds its cap. Batch `pre` may only reference existing nodes or nodes created earlier in the same batch. Concept-reference gate (#141): every concept named in teaches/assumes/misconceptions must be registered in the course concept registry (canonical or alias, exact match) OR minted in the same proposal's concepts block — unregistered names are rejected with the missing list; minting a name that already exists is rejected too (reference the entry, or merge via learnhub_concept_merge after human confirmation). Prior feed (#142): vault-link candidates with w≥0.7 mapped to the proposal's nodes that the structure does NOT explicitly answer (no pre/enc edge between the pair) come back in warns (non-blocking) — answer them with real edges, or let a vault rescan drop them; zero priors is a legal normal path. Keep pre-edge cognitive jumps (difficulty gap >= 2 or depth span >= 3) off the graph or expect R13 jump-candidate warnings. Schema + structure gates reject bad YAML with actionable errors (including dangling enc edges and misconception cap breaches). In growth batches apply edit proposals immediately after gates pass (anchor-review model, ADR-0003); seed proposals wait for the one human review.",
    args: {
      kind: { type: "string", description: "\"seed\" (new-course entry or endpoint change — one human review) or \"edit\" (change ops) or \"enrich\" (overlay backfill)", required: true },
      yaml: { type: "string", description: "Full proposal YAML text (SeedProposal / EditProposal / EnrichProposal schema)", required: true }
    },
    engine: "graph.graphPropose",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_propose",
      }
    ]
  }),
  'proposals-apply': command({
    id: "proposals-apply",
    args: {
      kind: { type: "string", required: true }
    },
    engine: "graph.proposalApply",
    domain: "图谱",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/proposals/apply" }
      }
    ]
  }),
  'proposals-impact': command({
    id: "proposals-impact",
    args: {
      kind: { type: "string", required: true, description: "Only \"seed\" carries an impact preview" },
      id: { type: "number", description: "Pending seed proposal id (default: the latest pending seed proposal)" }
    },
    engine: "proposals.proposalImpact",
    domain: "图谱",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/proposals/impact" },
        bind: ["kind", "id"]
      }
    ]
  }),
  'proposals-reject': command({
    id: "proposals-reject",
    args: {
      note: { type: "string", read: "fallback" }
    },
    engine: "graph.graphReject",
    domain: "图谱",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/proposals/reject" }
      }
    ]
  }),
  'vault-links-scan': command({
    id: "vault-links-scan",
    summary: "Scan the WHOLE vault (outside the learning center; dot-dirs, built-in attachment/archive dirs 99附件/05ob自定义/00类型/03属性/过时*, and the user note-source exclusion list skipped — the built-in list can be replaced via vault_link_excludes in learnhub.json) for [[wikilinks]] between personal notes and produce de-noised UNDIRECTED association pairs with confidence w∈[0,1] (enc-edge weight convention): embeds ![[…]], non-.md targets (.base/.png/…), diary date targets, unresolved targets, self-links and code-fence examples are filtered, each with a hit-count audit (nothing silently dropped). READ-ONLY on personal notes — the cache lands in the engine state dir (state/vault链接.json with per-file fingerprints for drift/rescan); pure file scanning, no host search API. Pair confidence tiers: w≥0.7 proposal-ready (learnhub_graph_link_backfill), 0.4–0.7 shown in learnhub_graph_analyze suggestions.vault_link_candidates for human adjudication, <0.4 report-only. Run before graph analysis to surface vault link priors.",
    args: {},
    engine: "graph.vaultLinksScan",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_vault_links_scan",
      }
    ]
  }),
}
