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
    summary: "Read a course compass (罗盘) at the course root: the 剩余路线 route sketch (written only by the compass station; repainted only on real direction re-evaluation), the learner annotation area (soft input — proposals, never orders; read it before planning growth batches), and the weekly sandbox ETA (quantile bands, 模型推演非承诺). Missing file = legal empty state (not seeded yet). This file never enters completion criteria or any authority — hand-edited routes are not structure changes.",
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
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/compass" },
        bind: ["course"]
      }
    ]
  }),
  'compass-paint': command({
    id: "compass-paint",
    summary: "Paint or repaint the compass route (罗盘站独占写权). Runs through the generation queue as ONE deep-effort tool loop: before submitting, verify node names against read-only engine views (graph, concept registry, compass, endpoint anchor; at most 6 tool rounds). Only the 剩余路线 section is rewritten (learner annotations preserved byte-for-byte, ETA reset for weekly refresh). The route is a non-commitment sketch: stages toward each endpoint, candidates marked (候选), no time promises. A route failing the format gate (non-empty, no ## headings, length cap) leaves the compass untouched. Run right after a seed apply (the apply lands the scaffold with a 待初画 placeholder) and after a reseed; repaint only on real direction change (destination/degree change, detected drift, post-review revision) — progress never triggers it. Enqueues the job and waits for its terminal message; cancellation via the generate page. Completion criteria never read this file.",
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
    summary: "File a CONCEPT-MERGE PROPOSAL — merges nothing by itself. Merging is the one irreversible action in this system (只并入、不拆分; entries are never deleted, only merged), so it lands pending and the learner must confirm it in the panel (提案列表 → 应用, kind=concept_merge) before the absorbed entry's names (canonical + aliases) all become aliases of the surviving entry, so every historical address keeps resolving. Use when the same concept was minted twice under different names (same meaning, confirmed by the learner); deepening a concept to a higher tier REUSES the same entry and is NOT a merge. Receipt carries the resulting name set, non-blocking warnings (近似名候选 / 量级告警带), and the proposal id. Registry file: 课程根/概念登记表.yaml.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      from: { type: "string", description: "Name (canonical or alias) of the entry to absorb", required: true },
      into: { type: "string", description: "Name (canonical or alias) of the surviving entry", required: true },
      reason: { type: "string", description: "Why these two entries are the same concept (reviewed by the human before confirming)" }
    },
    engine: "graph.conceptMerge",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_concept_merge",
        bind: ["course", "from", "into", "reason"]
      }
    ]
  }),
  'concept-confusable-candidates': command({
    id: "concept-confusable-candidates",
    summary: "Derive confusable-PAIR CANDIDATES from question co-occurrence and file one PENDING proposal per candidate: sources are concepts invoked by different questions of the same node, and the node's misconception concepts against its questions' invokes. Nothing registers automatically — the learner reviews candidates one at a time in the panel (提案列表 → 应用, kind=confusable_pair); a one-way declaration (a→b) is legal but is a to-be-reviewed state. Evidence lines ship inside each proposal for human judgment. Filters: names must be registered and ACTIVE, already-declared pairs are never re-nominated, one scan files at most `max` proposals (people are the bottleneck). Re-runnable: pending duplicates are not stacked.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled", required: true },
      max: { type: "number", description: "Max proposals filed in this scan (default 20, hard cap 50)" }
    },
    engine: "graph.conceptConfusableCandidates",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_concept_confusable_candidates",
        bind: ["course", "max"]
      }
    ]
  }),
  'concept-merge-candidates': command({
    id: "concept-merge-candidates",
    summary: "Scan a course concept registry for SUSPECTED DUPLICATE entries and file one CONCEPT-MERGE PROPOSAL per pair — deterministic signals only, ZERO LLM: name-surface text overlap (canonical/aliases/definition), teaches/assumes footprint similarity, similar question-invokes distribution. Each proposal is an IRREVERSIBLE merge proposal (只并入、不拆分) landing pending — the scan merges nothing, apply is human-only via the proposals list. Pairs already declared confusable are never nominated; pending pairs are not stacked (re-runnable); deprecated entries leave the surface; at most `max` proposals per scan. Same surface as the panel button「扫描疑似重复概念」.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled", required: true },
      max: { type: "number", description: "Max proposals filed in this scan (default 20, hard cap 50)" }
    },
    engine: "graph.conceptMergeCandidates",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_concept_merge_candidates",
        bind: ["course", "max"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/concepts/merge-candidates" },
        bind: ["course"]
      }
    ]
  }),
  'concept-footprint': command({
    id: "concept-footprint",
    summary: "Read-only concept footprint view: per-entry term card (canonical/aliases/definition/confusable — missing fields shown as missing, never faked), teaching face (which nodes teach/assume it), question face (invokes distribution per node), and a DRIFT panel over the FULL registry regardless of query: orphans (empty footprint), dangling confusable pointers, one-way confusable (neutral fact, no fix verdict). query is SUBSTRING DISCOVERY over canonical/aliases, NOT an existence test: empty result means widen the term or read the full table. Pure read, zero writes; same data sources as the coach's concept_footprint tool, with the drift panel as the panel-only addition.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled", read: "query" },
      query: { type: "string", description: "Optional substring (hits canonical or alias); omit for full table + drift panel", read: "query" }
    },
    engine: "graph.conceptFootprint",
    domain: "图谱",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/concepts/footprint" },
        bind: ["course", "query"]
      }
    ]
  }),
  'graph-analyze': command({
    id: "graph-analyze",
    summary: "Analyze a course knowledge graph: structural stats, unreachable nodes, bottlenecks, lapse hotspots, graph health score (0-100, see health), next-batch suggestions (an imbalance-sorted per-concept table supply/demand/depth_spread/evidence, plus missing_pre and jump_candidates + jump_total — cognitive-jump edges needing a verdict each), the full per-node schema (pre/enc/est/bloom/difficulty/note — data basis for edge-level self-checks), plus cytoscape render elements. Returns JSON. Run before planning each batch of graph edits; the next-batch plan must cite concrete entries from health/suggestions.",
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
    summary: "Decide a pending graph proposal: apply (audit-gated, writes data/*.yaml with rename linkage + journal + snapshot; kind=enrich re-checks sha256 content fingerprints and refuses stale proposals; kind=seed lands the drafted structure on an ALREADY-registered course — appends the drafted endpoint to state/终点锚.json only when the name is free, existing anchors never touched; seed graphs get the shape-warning & health-threshold exemption) or reject (kept on record). Seed proposals never create courses; endpoints are hand-added/removed by the learner via the panel. In edit batches the agent applies directly after gates pass; revision changes wait for human review first. The apply result carries findings: audit warns plus a health-score hint when below the quality baseline (suppressed while the graph is still just the seed) — address them in the next batch.",
    args: {
      kind: { type: "string", description: "\"seed\" (structure draft for a registered course) or \"edit\" (change ops) or \"enrich\" (overlay backfill)", required: true },
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
    summary: "Browse a course graph by grouping axis: node listings grouped along depth (single-membership layers), concept (teaches/assumes derived, overlapping) or endpoint (per-endpoint upstream closure, overlapping), with depth/stage/est/difficulty/type/content status. axis defaults to depth; group optionally filters to one label; overlapping nodes repeat per group. Unknown axis/group names fail loud with the valid values.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" },
      axis: { type: "string", description: "Grouping axis: depth (default) / concept / endpoint" },
      group: { type: "string", description: "Optional group label filter along the chosen axis" }
    },
    engine: "graph.graphBrowse",
    domain: "图谱",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_graph_browse",
        bind: ["course", "axis", "group"]
      }
    ]
  }),
  'graph-enc-backfill': command({
    id: "graph-enc-backfill",
    summary: "Backfill enc (component-skill) edges for a course via the enrichment-overlay channel: every non-practice node with ready content whose note body / exercise metadata declares enc_candidates, or whose bank questions invoke prereq-taught concepts (invokes-coverage projection) not yet declared as enc, becomes one field entry (whole-replace enc). Weights = the share of the node's questions invoking concepts taught by that prereq; edges without invokes data land the default weight 1. Queued as a SINGLE pending enrich proposal with sha256 fingerprints of data/图.yaml. Nothing changed returns ops=0. Re-runnable — already-covered nodes produce no entries; practice nodes keep legal empty enc. Review/apply with learnhub_graph_apply(kind=enrich).",
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
    summary: "Turn vault link priors into enc candidate edges via the enrichment-overlay channel: mapped pairs with w ≥ 0.7 whose direction resolves INSIDE the pre-transitive-closure become field entries (whole-replace enc; declared enc preserved, new edges noted with the source link evidence for traceability), queued as a SINGLE pending enrich proposal per course with sha256 fingerprints of data/图.yaml. Pairs without a pre relation are NOT forced (the enc target must sit in the holder's prereq closure) — they come back as blocked_no_pre with a why: add pre edges explicitly or drop. Re-runnable; already-declared edges are skipped. Requires learnhub_vault_links_scan to have run (fails loud with a pointer otherwise). Review/apply with learnhub_graph_apply(kind=enrich).",
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
    summary: "List proposals by status — use status=pending to see what awaits human review in the panel (proposal id, course, reason, op summary). Concept-layer actions also queue here (concept_merge = an irreversible entry merge, confusable_pair = a derived confusable-pair candidate): the learner decides them in the panel one at a time. After the user decides in the panel, apply graph proposals with learnhub_graph_apply using that id (concept-layer ones are panel-only — the confirmation gate is a human action).",
    args: {
      status: { type: "string", description: "Filter by status (default pending; e.g. applied/rejected)" },
      kind: { type: "string", description: "Filter by kind: edit / enrich / project_plan / project_milestone / experiment / concept_merge / confusable_pair" }
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
    summary: "Submit a graph proposal. Write YAML strictly to this schema — wrong key names are rejected. Anchors are human-authored: add/remove endpoints are explicit panel actions, and endpoint-anchored nodes are guarded (del_node/rename on them via kind=edit are rejected). kind=edit top-level keys: course; reason?; concepts? ([{canonical, aliases?, definition?}] — concept minting; names land in 课程根/概念登记表.yaml with the SAME apply transaction, nothing writes while pending/rejected); ops[] — add_node defines a new node via key `name`: {name, pre, est? (minutes, positive), bloom? (记忆/理解/应用/分析/评价/创造), difficulty? (1-5), type?: practice, note?, enc?, teaches? ({concept: 知道|会用|能教}, 1-8), assumes? ({concept: tier}, 3-10 when present), misconceptions? ([{concept, model}], ≤3 per concept course-wide)}; every other op targets an existing node via key `node`: set_pre{node, pre} replaces the whole pre set ([] to clear); set_enc{node, enc} replaces the whole enc list ([skill] or [{node, w, note}]; [] to clear); del_node{node}; rename{node, new}; set_note{node, note}. Generation discipline (the gates cannot check these): each add_node is ONE independent learning act — a zero-basis learner must be able to pick it up from its pre within 30 minutes, else split or add a prerequisite first; names are action sentences (解/求/推导…; no「理解导数」-style level-unclear near-duplicates, no blanket compounds); pre is the COMPLETE direct-prerequisite set (no transitive padding); give every new pre edge a necessity verdict (delete-the-edge test: no concrete failure point = redundant, drop it). Edge-light rule: graph YAML carries ZERO edge metadata — candidate edges stay in the proposal; probation lives in state/边实验.jsonl (origin/status/probation fields are rejected). Growth-batch note region: note{operator: 前进|插入|巩固|旁支|换向, reason, target_endpoints?, disagreement?, recheck?} marks the batch as a coach-round verdict; a growth batch (前进/换向) with add_node ops MUST declare target_endpoints (a non-empty list of registered endpoints this batch grows toward; one new node may enter several endpoints' pre; the gate checks EVERY declared endpoint carries set_pre{node: <endpoint>} covering all in-batch new-frontier nodes; add_node with an endpoint as pre is rejected — never grow past the target; 换向 never edits anchors); an insertion batch (operator=插入 with add_node ops) MUST preregister note.recheck{metric: 前进恢复|卡点集中度降幅|保留率恢复 (exactly one, same source as the symptom), days? (learning days, default 10, clamped [5,20] with a warn)} — the engine auto-adjudicates at expiry (proven, or auto-prune via del_node + coarse-edge restore, zero human review); recheck on non-insertion batches is rejected, and insertion batches are gate-throttled when the recheck pass rate bottoms out or the insertion/side-branch share exceeds its cap. Batch `pre` may only reference existing nodes or nodes created earlier in the same batch. Concept-reference gate: every concept named in teaches/assumes/misconceptions must be registered in the course concept registry (canonical or alias, exact match) OR minted in the same proposal's concepts block — unregistered names are rejected with the missing list; minting a name that already exists is rejected too (reference the entry, or file a merge proposal with learnhub_concept_merge and let the human confirm it — merging is irreversible: 只并入、不拆分). A near-identical mint comes back in warns as a candidate list (non-blocking): prefer referencing the existing entry, or state the difference in the batch reason; entries also carry magnitude warning bands (alias count / confusable-pair count) in the receipt. Prior feed: vault-link candidates with w≥0.7 mapped to the proposal's nodes that the structure does NOT explicitly answer (no pre/enc edge between the pair) come back in warns (non-blocking) — answer them with real edges, or let a vault rescan drop them; zero priors is a legal normal path. Keep pre-edge cognitive jumps (difficulty gap >= 2 or depth span >= 3) off the graph or expect jump-candidate warnings. Schema + structure gates reject bad YAML with actionable errors (dangling enc edges, misconception cap breaches). In growth batches apply edit proposals immediately after gates pass.",
    args: {
      kind: { type: "string", description: "\"edit\" (change ops) or \"enrich\" (overlay backfill)", required: true },
      yaml: { type: "string", description: "Full proposal YAML text (EditProposal / EnrichProposal schema)", required: true }
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
