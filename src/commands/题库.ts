/**
 * 命令注册表·题库域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'
import type { CommandSpec } from './types.ts'

export const 题库域 = {
  'bank-cleanup': command({
    id: "bank-cleanup",
    summary: "One-click question-bank housekeeping (ADR-0032, archive-only — never deletes). Preview (default): per node, every non-archived question of skipped nodes plus every dormant question (in bank, never scheduled) of completed review/mastered nodes, grouped with counts and stem excerpts. With apply=true: archives exactly those candidates with reason=cleanup — reversible from the bank panel (restore filter). Always run the preview first and tell the learner what will be archived before applying.",
    args: {
      course: { type: "string", description: "Course name; omit to scan all enabled courses" },
      apply: { type: "boolean", description: "omit/false = read-only preview; true = archive the candidates (reason=cleanup)" }
    },
    domain: "题库",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_bank_cleanup" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/bank-cleanup" },
      }
    ]
  }),
  'bank-cleanup-apply': command({
    id: "bank-cleanup-apply",
    args: {
      course: { type: "string", read: "raw" }
    },
    engine: "bankCleanupApply",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/bank-cleanup/apply" },
        bind: ["course"]
      }
    ]
  }),
  'difficulty-advice': command({
    id: "difficulty-advice",
    summary: "Detect difficulty-mismatch advice across question banks (B2, read-only, advice-first — nothing is written): nodes in review/mastered with low derived mastery + struggling answer accuracy + enough answer volume get a \"difficulty band miscalibrated, regenerate\" suggestion carrying a difficulty/bloom target-band instruction (feed it to learnhub_question_generate or the section-rewrite flow, validateBank gate applies); individual questions whose scheduling evidence says \"too easy\" (enough FSRS advances with zero lapses and an interval grown past the threshold — same-day repeats never count) get a \"too easy, archivable\" annotation (archiving is the author/panel decision via learnhub_question_update archived patch — never silent removal). Responses already dismissed by the learner are filtered out (dismissed count returned). Low data stays silent.",
    args: {
      course: { type: "string", description: "Course name; omit to scan all enabled courses", read: "query" }
    },
    engine: "difficultyAdvice",
    domain: "题库",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_difficulty_advice",
        bind: ["course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/difficulty-advice" },
        bind: ["course"]
      }
    ]
  }),
  'difficulty-advice-dismiss': command({
    id: "difficulty-advice-dismiss",
    args: {
      course: { type: "string", read: "fallback" },
      node: { type: "string", read: "fallback" },
      qid: { type: "string", read: "raw" },
      undo: { type: "boolean" },
      all: { type: "boolean" }
    },
    engine: "adviceDismiss",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/difficulty-advice-dismiss" },
      }
    ]
  }),
  'question-add': command({
    id: "question-add",
    args: {
      question: { type: "object", required: true },
      course: { type: "string", required: true },
      node: { type: "string", required: true }
    },
    engine: "questionAdd",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-add" },
      }
    ]
  }),
  'question-archive': command({
    id: "question-archive",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      qid: { type: "string", required: true },
      archived: { type: "boolean" },
      reason: { type: "string", read: "raw" }
    },
    engine: "questionArchive",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-archive" },
      }
    ]
  }),
  'question-audit': command({
    id: "question-audit",
    summary: "Read-only content audit of all question banks (course banks + note-source mirror). Flags legacy questions that violate current contracts: fill_in_blank answers that look numeric or algebraic (ADR-0029 unique-answer blanks), notation violations in stem/options/explanation (bare ^ or _ outside $...$, LaTeX commands without $ delimiters), YAML double-quote escape corruption (control characters), and over-long explanations. Returns a JSON findings list; never repairs or writes.",
    args: {},
    engine: "questionAudit",
    domain: "题库",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_question_audit",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/question-audit" },
        bind: []
      }
    ]
  }),
  'question-dispute-apply': command({
    id: "question-dispute-apply",
    args: {
      resolution: {
        type: "string",
        required: true,
        enum: ["rekey", "void", "overridden"]
      },
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      qid: { type: "string", required: true },
      target_ts: { type: "string", read: "raw" },
      reason: { type: "string", read: "raw" }
    },
    engine: "questionDisputeApply",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-dispute/apply" }
      }
    ]
  }),
  'question-dispute-review': command({
    id: "question-dispute-review",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      qid: { type: "string", required: true }
    },
    engine: "questionDisputeReview",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-dispute/review" }
      }
    ]
  }),
  'question-forget': command({
    id: "question-forget",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      qid: { type: "string", required: true },
      elapsed_s: { type: "number", read: "finite" },
      predicted: { type: "string", read: "raw" }
    },
    engine: "questionForget",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-forget" }
      }
    ]
  }),
  'question-generate': command({
    id: "question-generate",
    summary: "Generate quiz questions for a node via the model — queued as a quiz job on the global serial generation queue (mutually exclusive with the node content pipeline, so bank writes never interleave) and this call WAITS for the job to finish, then returns the result: node body → question prompt → llm → validateBank gate appends every question to the bank. The prompt lists the node's existing question stems and the engine drops generated questions that duplicate or closely resemble them (reported as duplicates). Birth tagging (#148): when the course concept registry scope (node teaches ∪ prereq-closure teaches) is non-empty every question must carry exactly ONE invokes concept — a missing tag gets one repair pass, still-empty questions are rejected and reported; the result's `enc` field carries the invokes-coverage projection (birth weights over prereq nodes, share of questions invoking each) — carry those into the next growth batch via set_enc whole-replace. Use when a node has no/too few questions. Progress is visible in the gen-jobs registry / panel generate tab while it waits.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name (must have generated content)", required: true },
      count: { type: "number", description: "Question count cap (default 6)" }
    },
    domain: "题库",
    channels: [
      {
        channel: "agent",
        mode: "queued",
        tool: "learnhub_question_generate",
        phase: "quiz"
      },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/question-generate" },
        phase: "quiz"
      }
    ]
  }),
  'question-get': command({
    id: "question-get",
    summary: "Read one bank question in full, including answer, explanation, difficulty, section, and uses — the revision/authoring companion to learnhub_question_list (which omits answers on purpose for the answering flow). Read the original before correcting a question with learnhub_question_update.",
    args: {
      course: { type: "string", description: "Course name; omit when only one course is enabled" },
      node: { type: "string", description: "Node name", required: true },
      qid: { type: "string", description: "Question id inside the bank, e.g. \"q1\"", required: true }
    },
    engine: "questionGet",
    domain: "题库",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_question_get",
        bind: ["course", "node", "qid"]
      }
    ]
  }),
  'question-list': command({
    id: "question-list",
    summary: "List the question-bank questions of a node as JSON (no answers). Bank files live at <课程根>/题库/<节点>.yaml; kinds: single_choice / true_false / fill_in_blank / multi_choice / numeric / ordering / matching / reflection / open_question.",
    args: {
      course: {
        type: "string",
        description: "Course name",
        required: true,
        read: "query"
      },
      node: {
        type: "string",
        description: "Node name",
        required: true,
        read: "query"
      }
    },
    engine: "questions",
    domain: "题库",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_question_list",
        bind: ["course", "node"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/questions" },
        bind: ["course", "node"],
        required: ["node"]
      }
    ]
  }),
  'question-rate': command({
    id: "question-rate",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      qid: { type: "string", required: true }
    },
    engine: "questionRate",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-rate" }
      }
    ]
  }),
  'question-save': command({
    id: "question-save",
    summary: "Save a question bank for a node: validates the Bank YAML (node/kind/q/answer per kind: single_choice needs options + letter answer; multi_choice options + letter array; true_false boolean; fill_in_blank accepted answers; numeric numeric answer + optional tol; ordering options + ordered answer items; matching left-column options + paired right-column answers; reflection grading rubric; open_question reference points) then writes <课程根>/题库/<节点>.yaml.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name (must match the node field inside the YAML)", required: true },
      yaml: { type: "string", description: "Bank YAML text (node/questions[id,kind,q,answer,options?,explanation?,difficulty?,uses?])", required: true }
    },
    engine: "questionSave",
    domain: "题库",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_question_save",
        bind: ["course", "node", "yaml"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-save" },
        bind: ["course", "node", "yaml"]
      }
    ]
  }),
  'question-update': command({
    id: "question-update",
    summary: "Update one bank question: patch merges into the stored question with a strict authoring whitelist (q/options/answer/explanation/difficulty/section/uses/tags/tol) and the whole bank re-validates before writing. Empty patches, unknown fields, and id/kind/node/fsrs/stats/archived keys are rejected. Archiving is a separate operation: send the patch {archived:true|false} as the only key to route to the archive endpoint; mixing archive with content edits fails instead of partially applying. learnhub_question_list omits answers — take corrections from the user or the note content, not from thin air.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      qid: { type: "string", description: "Question id inside the bank, e.g. \"q1\"", required: true },
      patch: {
        type: "object",
        description: "Authoring fields to merge ({\"answer\":\"A\",...}), or {\"archived\":true} alone for archive",
        additionalProperties: true,
        required: true
      }
    },
    domain: "题库",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_question_update" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "PUT", path: "/question-update" },
      }
    ]
  }),
  'questions-all': command({
    id: "questions-all",
    args: {
      course: { type: "string", read: "query" }
    },
    engine: "questionsAll",
    domain: "题库",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/questions-all" },
        bind: ["course"]
      }
    ]
  }),
}
