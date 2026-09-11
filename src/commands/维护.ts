/**
 * 命令注册表·维护域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'
import type { CommandSpec } from './types.ts'

export const 维护域: CommandSpec[] = [
  command({
    id: "content-check",
    summary: "Run the automated content quality gates (out-of-scope references, alias consistency, unregistered code-block languages, interactive file existence) on an existing course note without applying anything. Run this after manually editing a course note in the vault; fix every reported finding.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true }
    },
    engine: "contentCheck",
    domain: "维护",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_content_check",
        bind: ["course", "node"]
      }
    ]
  }),
  command({
    id: "course-delete",
    summary: "Delete one course: remove it from the course registry and move the whole course directory into 学习中心/.trash/ (recoverable by hand). Learning progress lives inside the course directory, so it goes too. Destructive — confirm with the user before calling; for a content-only redo prefer learnhub_course_reset (keeps the graph and progress).",
    args: {
      course: { type: "string", description: "Course name", required: true }
    },
    engine: "courseDelete",
    domain: "维护",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_course_delete",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/course/delete" },
      }
    ]
  }),
  command({
    id: "course-reset",
    summary: "Reset one course for full regeneration: all node notes are backed up into .trash/regenerate-<ts>/ and rewritten as ungenerated skeletons; the question bank, interactive artifacts, and generated-image dirs move into the same backup. The graph, learning progress, and prompt snapshots are kept. Regeneration then runs as a background chain over all nodes in graph topological order (each node: outline → sections → quiz) and this call returns immediately with the queued count; progress shows in the panel generate tab. Refuses while generation tasks are running. Destructive but recoverable — confirm with the user before calling. The sediment layer (learner-model state: FSRS params, calibration profile) is NEVER touched — surface that as its own separate confirmation item (#139).",
    args: {
      course: { type: "string", description: "Course name", required: true }
    },
    domain: "维护",
    channels: [
      {
        channel: "agent",
        mode: "queued",
        tool: "learnhub_course_reset",
        phase: "outline"
      },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/course/reset" },
        phase: "outline"
      }
    ]
  }),
  command({
    id: "data-check",
    summary: "Run a read-only Data Check across the registry, graph YAML, course notes/frontmatter, and question banks. Return JSON findings that distinguish Missing (legal absence) from Broken (present but invalid); it never repairs or writes vault data.",
    args: {},
    engine: "dataCheck",
    domain: "维护",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_data_check",
      }
    ]
  }),
  command({
    id: "doctor",
    args: {},
    engine: "doctor",
    domain: "维护",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/doctor" },
        bind: []
      }
    ]
  }),
  command({
    id: "feedback",
    summary: "Submit content feedback of a course note: reads the note「内容反馈」section and marks the node flagged + regeneration queue.",
    args: {
      path: { type: "string", description: "Note path, vault-relative or absolute", required: true }
    },
    engine: "submitFeedback",
    domain: "维护",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_feedback" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/feedback" }
      }
    ]
  }),
  command({
    id: "interactive",
    args: {},
    domain: "维护",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/interactive" }
      }
    ]
  }),
  command({
    id: "interactive-settle",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      section: { type: "string", required: true },
      detail: { type: "string", read: "raw" }
    },
    engine: "interactiveSettle",
    domain: "维护",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/interactive/settle" }
      }
    ]
  }),
  command({
    id: "note-resolve",
    summary: "Resolve a course note: read its frontmatter node and map the path to its enabled course via 课程注册表.yaml.",
    args: {
      path: {
        type: "string",
        description: "Note path, vault-relative or absolute",
        required: true,
        read: "query"
      }
    },
    engine: "resolveNote",
    domain: "维护",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_note_resolve" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/note" }
      }
    ]
  }),
  command({
    id: "optimize-params",
    summary: "Manually trigger FSRS-6 personal parameter optimization (A2, never automatic — like Anki): retrains the 21 scheduling parameters from the learner's real review log (synthetic initializations excluded, first push per card per day) across all enabled courses. Gates: at least 400 real review pushes are required, and the trained parameters must evaluate strictly better than the current/default parameters (same-protocol logLoss comparison) — otherwise nothing is written and the skip reason is returned with the metrics. On success the one learner-level parameter set is written to every enabled course's fsrs参数.json with full training metadata (count/date/metrics); the scheduler picks it up with zero changes. Expect ~a few seconds of training.",
    args: {},
    engine: "optimizeFsrsParams",
    domain: "维护",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_optimize_params",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/optimize-params" },
        bind: []
      }
    ]
  }),
  command({
    id: "probation",
    summary: "Insertion-edge probation (recheck) status and settlement, #146. action=status (default): per-course view of insertion edges under probation (nodes the panel marks 实验中/under experiment), overdue-but-undecided entries, the three throttle rates over the rolling 30 learning days (insertion rate / prune rate / recheck pass rate) and the resilience gate state (side-branch cap 20%→30% when resilient; insertion batches are rejected at the gate when the pass rate bottoms out). action=settle: run the settlement hook now — due entries are auto-adjudicated with zero human review: metric met → proven (insertion becomes permanent); not met → the engine proposes and auto-applies del_node with coarse-edge restoration (settleRechecks). Settlement also writes recheck_outcome / graph_repair events to the sediment canon.",
    args: {
      action: {
        type: "string",
        description: "default status",
        enum: ["status", "settle"]
      },
      course: { type: "string", description: "course name; default all enabled courses" }
    },
    domain: "维护",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_probation" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/probation" },
      }
    ]
  }),
  command({
    id: "rebuild",
    summary: "Run audit gate + ready-list regeneration for all enabled courses, or one course.",
    args: {
      course: { type: "string", description: "Course name; omit to rebuild all enabled courses" }
    },
    engine: "rebuild",
    domain: "维护",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_rebuild",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/rebuild" },
      }
    ]
  }),
  command({
    id: "tutor",
    args: {
      messages: { type: "array" },
      course: { type: "string", required: true },
      node: { type: "string", required: true }
    },
    domain: "维护",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/tutor" }
      }
    ]
  }),
]
