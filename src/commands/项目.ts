/**
 * 命令注册表·项目域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'

export const 项目域 = {
  'project-apply': command({
    id: "project-apply",
    summary: "Apply a pending PROJECT proposal by id (kind read from the record: project_plan = write the revised milestone plan into 项目.md with the old plan snapshotted — a revision diff (milestone identity keyed by id) is returned and switch-line/branch-in growth batches are ENQUEUED for the anchored courses (#149); project_milestone = overwrite the milestone artifact with the old text snapshotted). Decompile-linked plan proposals CANNOT apply alone while their seed half is pending — use learnhub_project_decompile_apply. Graph proposals (edit/seed) go through learnhub_graph_apply instead. Nothing applies without this explicit step — review pending proposals with the learner first.",
    args: {
      id: { type: "number", description: "Pending proposal id", required: true }
    },
    engine: "graph.projectApply",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_apply",
      }
    ]
  }),
  'project-create': command({
    id: "project-create",
    summary: "Create a project (P-area first-class entity, Course's SISTER not a node): a real-world practice the learner is actually doing, measured in weeks/months. Writes 学习中心/projects/<id>/项目.md (frontmatter: lifecycle=active, fading tier 骨架/补全/独立 default 补全, goal prose, empty plan). Projects carry ZERO XP, ZERO FSRS, never enter sessions/srs/review queue — node consumers are untouched. After creating, draft the milestone plan with learnhub_project_plan_generate.",
    args: {
      name: { type: "string", description: "Project name (also becomes the workspace id)", required: true },
      goal: { type: "string", description: "Learner's goal description prose (plan drafting input)", required: true },
      tier: { type: "string", description: "Fading tier: 骨架/补全/独立 (default 补全)" }
    },
    engine: "project.projectCreate",
    domain: "项目",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_project_create" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/project/create" }
      }
    ]
  }),
  'project-cross-view': command({
    id: "project-cross-view",
    summary: "Read a project's 2×2 MASTERY CROSS diagnostic (P-7, the project panel's core view): X = declarative mastery (mean masteryOfFm over the plan's linked nodes), Y = project execution evidence (EMA 0.7/0.3 of event scores; both axes threshold 0.6, missing evidence counts as low). Quadrants: 会而不会用 (high mastery × low execution — apply it), 会用而不牢 (low × high — shore up the knowledge base), 健康 (high × high), 补底 (low × low). Also returns the READ-ONLY fading-tier recommendation (challenge point): promotion criteria = performance within the current tier (≥3 events averaging ≥0.8) AND the linked-node mastery holding — the engine only proposes, the learner changes tier explicitly via learnhub_project_tier, and the recommendation NEVER gates milestones or anything else.",
    args: {
      id: {
        type: "string",
        description: "Project id",
        required: true,
        read: "query"
      }
    },
    engine: "project.projectCrossView",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_cross_view",
        bind: ["id"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/project/cross" },
        bind: ["id"]
      }
    ]
  }),
  'project-decompile': command({
    id: "project-decompile",
    summary: "GOAL DECOMPILATION, v8 seed-cluster form (#149): one model call produces TWO paired proposals from the goal description + registered notes — a milestone plan draft (project_plan) and a knowledge-subgraph SEED CLUSTER (kind=seed: 1-3 start nodes + endpoint, engine stamps basis=project and lands the coarse placeholder edges). Same-origin in-out: both pass gates before EITHER is filed (plan-seed name-reconciliation gate: every plan.nodes reference must resolve to a seed-cluster node or an existing graph node — dangling references reject the whole run), and the pair is LINKED (apply ONLY via learnhub_project_decompile_apply which lands the seed graph first then the plan; rejecting one auto-rejects the other). With an explicit course param: the course must already exist and NO seed half is produced (the plan references existing nodes only — new knowledge needs are grown later by the coach, driven by plan-revision diffs). Vault priors are mined read-only; nothing canonical is written before apply.",
    args: {
      id: { type: "string", description: "Project id (the plan-draft proposal targets it)", required: true },
      goal: { type: "string", description: "Goal description prose; defaults to the project's goal field (empty goal is rejected)" },
      course: { type: "string", description: "Existing target course: plan-only run (nodes must reference existing graph nodes); omit → the seed cluster becomes a NEW course seed proposal (pair-linked with the plan)" },
      notes: {
        type: "array",
        description: "Registered note-source ids or vault-relative paths to mine for prior context; omit → all registered sources",
        items: { type: "string" }
      }
    },
    engine: "project.projectDecompile",
    domain: "项目",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_project_decompile" },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/project/decompile" },
        phase: "decompile"
      }
    ]
  }),
  'project-decompile-apply': command({
    id: "project-decompile-apply",
    summary: "Apply a DECOMPILED pair TOGETHER (project_plan + seed, #149 same-origin in-out): pass BOTH proposal ids from learnhub_project_decompile; the seed lands first (cluster nodes + endpoint anchor + note scaffolds) so the plan's node references resolve, then the plan writes. Single-sided apply of a linked pair is rejected at the guard — use this joint entry (crash recovery: an already-applied half is skipped, a rejected half never revives — re-decompile instead).",
    args: {
      plan: { type: "number", description: "project_plan proposal id", required: true },
      seed: { type: "number", description: "seed proposal id (pair-linked with the plan)", required: true }
    },
    engine: "project.projectDecompileApply",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_decompile_apply",
        bind: ["plan", "seed"]
      }
    ]
  }),
  'project-enc-candidates': command({
    id: "project-enc-candidates",
    summary: "Mine BEHAVIORALLY-INFERRED enc candidate edges (P-6): scan the learner's real card flips/answer activity on the project's linked course nodes inside a window (default the 14 days before the named milestone's pass, else before now); node pairs co-active on ≥ min_co days (default 2) become enc candidates with confidence-weighted edges (≥3 days 1.0 / 2 days 0.8 / 1 day 0.6; direction from the pre-closure when the graph knows it, first-activity heuristic otherwise). Files ONE pending edit proposal per course (set_enc whole-replace ops, declared edges preserved — zero schema break; single-proposal human review like enc_backfill); the panel/learnhub_graph_apply decides. Cross-course pairs are dropped, already-declared edges are skipped. This is how the all-zero enc graph starts growing from doing, not declaring.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      milestone: { type: "string", description: "Milestone id anchoring the window end at its pass time (must have a pass record); omit to anchor at now" },
      nodes: {
        type: "array",
        description: "Extra linked course nodes (merged with the plan's declared nodes)",
        items: { type: "string" }
      },
      window_days: { type: "number", description: "Window length in days, 1-90 (default 14)" },
      min_co: { type: "number", description: "Minimum co-active days per pair (default 2)" }
    },
    engine: "project.projectEncCandidates",
    domain: "项目",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_project_enc_candidates" }
    ]
  }),
  'project-exec-log': command({
    id: "project-exec-log",
    summary: "Log ONE PROJECT execution event (P-7): a real work session on the project with a performance rating (1-4 integer; 4 = strong, 1 = poor) and an honest source (auto REQUIRES observable evidence mapped deterministically; self/ai take the explicit rating — self-report is trusted, ADR-0016). The event lands in the project's OWN stream (projects/<id>/exec.jsonl) feeding the fading-tier recommendation and the 2×2 diagnostic. Exercised linked nodes get practice evidence backflow ONE-WAY into each node's practice channel (existing applyPracticeEvidence EMA, node-level dedup — seeded stub nodes participate exactly like taught ones); the count of exercised existing enc edges is reported for observability but coarse placeholder pre edges are NOT backflow channels. Zero XP, zero journal, zero FSRS/scheduling writes.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      source: { type: "string", description: "auto (requires evidence) / self / ai", required: true },
      rating: { type: "number", description: "Performance rating 1-4 integer (required for self/ai; ignored for auto)" },
      evidence: { type: "object", description: "Observable evidence for source=auto: { accuracy: 0-1, self_help?: number }", additionalProperties: true },
      nodes: {
        type: "array",
        description: "Linked course nodes exercised this session (node name or 课程/节点); empty = stream-only, no backflow",
        items: { type: "string" }
      },
      note: { type: "string", description: "One-line note about this execution" }
    },
    engine: "project.projectExecLog",
    domain: "项目",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_project_exec_log" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/project/exec" }
      }
    ]
  }),
  'project-lifecycle': command({
    id: "project-lifecycle",
    summary: "Set a project's lifecycle: active/paused/delivered/archived. No irreversible transitions (ADR-0015) — delivered/archived projects can reopen to active; a no-deadline project may legally stay active forever. Pure status change: no XP settle, no scheduling effect.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      lifecycle: { type: "string", description: "active/paused/delivered/archived", required: true }
    },
    engine: "project.projectSetLifecycle",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_lifecycle",
        bind: ["id", "lifecycle"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/project/lifecycle" },
        bind: ["id", "lifecycle"]
      }
    ]
  }),
  'project-list': command({
    id: "project-list",
    summary: "List all projects as JSON (id/name/lifecycle/tier/plan size). Projects are the bounded project area: real practice with milestone plans, separate from course nodes.",
    args: {},
    engine: "project.projectList",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_list",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/projects" },
        bind: []
      }
    ]
  }),
  'project-log': command({
    id: "project-log",
    summary: "Read a project's log (V-5): the learner's free-form working journal at 学习中心/projects/<id>/日志.md — dated entries of what they did, where they got stuck, what they learned. Null when never written (legal empty state, no file is created by reading). The log may be REGISTERED as a Note Source (learnhub_note_source_register with the log path) so its content becomes reviewable — the engine only ever reads it.",
    args: {
      id: {
        type: "string",
        description: "Project id",
        required: true,
        read: "query"
      }
    },
    engine: "project.projectLog",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_log",
        bind: ["id"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/project/log" },
        bind: ["id"]
      }
    ]
  }),
  'project-log-append': command({
    id: "project-log-append",
    summary: "Append one dated entry to a project's log (V-5): the learner's own record of real project work — progress, blockers, decisions, learnings. Entries are learner-authored prose; engine bookkeeping (plan revisions, receipts mirror, exec events) lives in its own files and never pollutes the log. The engine refreshes the registered fingerprint after writing (its own writes are not content drift).",
    args: {
      id: { type: "string", description: "Project id", required: true },
      text: { type: "string", description: "Entry body (non-empty prose; multiple paragraphs/lines fine)", required: true }
    },
    engine: "project.projectLogAppend",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_log_append",
        bind: ["id", "text"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/project/log" },
        bind: ["id", "text"]
      }
    ]
  }),
  'project-milestone-generate': command({
    id: "project-milestone-generate",
    summary: "Generate ONE milestone artifact (a four-block task card 给定/待办/验收清单/支持) through the model at the project's current fading tier: 骨架 = near-complete demonstration, 补全 = partial product with【待补全】gaps, 独立 = situation and starting point only. Output passes a lightweight structural gate (one repair round on failure). FIRST generation lands directly; if the artifact already exists the same call files a PENDING project_milestone REGENERATION proposal instead — apply with learnhub_project_apply (old text is snapshotted, never silently overwritten). Zero XP, zero FSRS.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      milestone: { type: "string", description: "Milestone id from the plan (e.g. m1)", required: true }
    },
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "queued",
        tool: "learnhub_project_milestone_generate",
        phase: "milestone"
      },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/project/milestone/generate" },
        phase: "milestone"
      }
    ]
  }),
  'project-milestone-pass': command({
    id: "project-milestone-pass",
    summary: "Record the learner's EXPLICIT milestone pass (P-4 settlement): the learner declares a milestone checkpoint reached — no checklist gate and no question gate (Kulik 1990: strict gates hurt completion). One journal settlement row lands (kind=milestone_settle, aligned with the node xp_settle precedent): XP price = the plan's est declaration × FSRS difficulty calibration over the DECLARED linked nodes' question pools (defaults when undeclared; the calibration basis is locked to the plan — it cannot be extended at pass time), locked once — a second pass of the same milestone id is rejected, so revising a plan must use fresh milestone ids. This is the ONLY journal write the project domain ever makes; it counts toward the ledger and streak like real focused work does.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      milestone: { type: "string", description: "Milestone id from the plan", required: true }
    },
    engine: "project.projectMilestonePass",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_milestone_pass",
        bind: ["id", "milestone"]
      }
    ]
  }),
  'project-milestone-recall': command({
    id: "project-milestone-recall",
    summary: "Start a MILESTONE RECALL session (P-3): draw a few questions from the linked course nodes' question banks so the knowledge base stays connected to the real project — retrieval points serve the knowledge base only, they are NOT project acceptance criteria (the gate is only that the milestone artifact exists). Zero XP, zero FSRS, zero scheduling writes: the drawn questions are archived to projects/<id>/recall.jsonl and returned WITH answers for you to run verbally — ask, hear the learner out, compare; never call learnhub_question_answer for these. Then archive the learner's spoken key-decision narration with learnhub_project_recall_reflect.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      milestone: { type: "string", description: "Milestone id from the plan (artifact must be generated)", required: true },
      nodes: {
        type: "array",
        description: "Extra linked course nodes (merged with the plan's declared nodes)",
        items: { type: "string" }
      },
      limit: { type: "number", description: "Questions to draw (default 5)" }
    },
    engine: "project.projectMilestoneRecall",
    domain: "项目",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_project_milestone_recall" }
    ]
  }),
  'project-plan-generate': command({
    id: "project-plan-generate",
    summary: "Draft the milestone plan for a project through the model and file it as a PENDING project_plan proposal (human review in the panel; apply with learnhub_project_apply): an ordered 3–8 item plan of 1–2-week deliverable checkpoints, simple→complex task classes, each with acceptance hints. Revising an existing plan is the same channel — applying the proposal snapshots the replaced plan YAML (no silent overwrite). The plan lands in the project's 项目.md frontmatter; milestone ARTIFACTS are generated separately per milestone.",
    args: {
      id: { type: "string", description: "Project id", required: true }
    },
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "queued",
        tool: "learnhub_project_plan_generate",
        phase: "plan"
      },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/project/plan/generate" },
        phase: "plan"
      }
    ]
  }),
  'project-recall-log': command({
    id: "project-recall-log",
    summary: "Read a project's recall-session ledger (P-3): the draw records (which questions were drawn at which milestone) and reflect records (key-decision narrations). Read-only.",
    args: {
      id: { type: "string", description: "Project id", required: true }
    },
    engine: "project.projectRecallLog",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_recall_log",
        bind: ["id"]
      }
    ]
  }),
  'project-recall-reflect': command({
    id: "project-recall-reflect",
    summary: "Archive the learner's key-decision narration from a milestone recall session (P-3): their spoken「到目前为止的关键决策」goes verbatim into projects/<id>/recall.jsonl for later retrospection. No verdict, no scoring, no canonical writes — the narration is for looking back on, not for feeding the scheduler.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      milestone: { type: "string", description: "Milestone id", required: true },
      narration: { type: "string", description: "Learner's key-decision narration (verbatim, non-empty)", required: true }
    },
    engine: "project.projectRecallReflect",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_recall_reflect",
        bind: ["id", "milestone", "narration"]
      }
    ]
  }),
  'project-show': command({
    id: "project-show",
    summary: "Show one project in full: frontmatter (lifecycle/tier/goal/plan) plus per-milestone artifact status (generated or not, file name) and orphan files left by past plan revisions.",
    args: {
      id: { type: "string", description: "Project id", required: true }
    },
    engine: "project.projectShow",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_show",
        bind: ["id"]
      }
    ]
  }),
  'project-tier': command({
    id: "project-tier",
    summary: "Set a project's fading tier (骨架/补全/独立): how much support NEW milestone artifacts get (near-complete demonstration → partial product with gaps → situation only). Already-generated artifacts keep their tier (no retroactive rewrite — regenerating them at the new tier goes through the proposal channel). Tier movement criteria (performance within tier) belong to the execution-event stream; v1 sets it explicitly with the learner.",
    args: {
      id: { type: "string", description: "Project id", required: true },
      tier: { type: "string", description: "骨架/补全/独立", required: true }
    },
    engine: "project.projectSetTier",
    domain: "项目",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_project_tier",
        bind: ["id", "tier"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/project/tier" },
        bind: ["id", "tier"]
      }
    ]
  }),
}
