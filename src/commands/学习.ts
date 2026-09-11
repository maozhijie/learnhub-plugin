/**
 * 命令注册表·学习域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'
import type { CommandSpec } from './types.ts'

export const 学习域: CommandSpec[] = [
  command({
    id: "band-session",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      band: { type: "string", read: "raw" }
    },
    engine: "logBandSession",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/band-session" }
      }
    ]
  }),
  command({
    id: "calibration-hints",
    args: {
      hints_enabled: { type: "boolean", required: true }
    },
    engine: "calibrationHintsConfig",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/calibration/hints" },
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "PUT", path: "/calibration/hints" },
      }
    ]
  }),
  command({
    id: "calibration-profile",
    summary: "Get the Self-Calibration profile (ADR-0022, #104) as JSON: per-source slices of learner self-assessment × objective outcome pairs (v1 source \"jol\" = JOL prediction × actual answer; more sources land via the pairing contract). Each source carries calibration bins (per-prediction actual accuracy, shown only at >=10 sampled pairs — below the gate it is null, never fabricated) and an overconfidence verdict with evidence (the「会」bin's n / actual accuracy / threshold). `global` merges sources as a REFERENCE view only — domain-specific components are significant, so always present it together with its warning and treat the per-source slices as authoritative. When a source is overconfident and hints are enabled, review-queue responses ride a `calibration_hint` string: surface it verbatim at the self-assessment exit as a gentle nudge (see learnhub_review_queue); JOL probe density is then boosted (1/3 → 1/2) automatically. Read-only derivation: this NEVER discounts learner self-assessment driving canonical state — FSRS ratings pass through untouched and nothing feeds Mastery/XP. Never present it as a personality trait or a score.",
    args: {},
    engine: "calibrationProfile",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_calibration_profile",
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/calibration/profile" },
        bind: []
      }
    ]
  }),
  command({
    id: "coach",
    summary: "Get the「可用的困难」coach feedback (E5, read-only informational, no gates or scoring): checks the last 7 days of the learner's difficulty-band session choices and in-band performance. All-easy streak with due questions their FSRS state says they should know → a gentle nudge to try the standard band; consistent challenge-band struggle (accuracy below 0.6) → a pointer back to prerequisite/component-skill review. Low data stays silent. Surface messages verbatim when present; never force anything.",
    args: {},
    engine: "coachAdvice",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_coach",
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/coach" },
        bind: []
      }
    ]
  }),
  command({
    id: "coach-compass",
    args: {
      course: { type: "string", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/coach/compass" },
        phase: "罗盘"
      }
    ]
  }),
  command({
    id: "coach-growth",
    args: {
      course: { type: "string", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/coach/growth" },
        phase: "生长"
      }
    ]
  }),
  command({
    id: "complete",
    summary: "Confirm a node has been learned this round. Accuracy below the passing line (0.6, with enough attempts) is rejected with accepted=false — review prerequisites or retry with force. On acceptance: unanswered bank questions get their FSRS card initialized (due tomorrow), the node stage moves to review, and a perfect-score completion earns bonus XP.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      force: { type: "boolean", description: "true to bypass the accuracy gate" }
    },
    engine: "nodeComplete",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_complete",
        bind: ["course", "node", "force"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/node/complete" },
      }
    ]
  }),
  command({
    id: "courses",
    args: {},
    engine: "enabledCourses",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/courses" },
      }
    ]
  }),
  command({
    id: "courses-tree",
    args: {
      course: { type: "string", read: "query" }
    },
    engine: "coursesTree",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/courses/tree" },
        bind: ["course"]
      }
    ]
  }),
  command({
    id: "daily-goal",
    args: {
      goal: { type: "number", required: true }
    },
    engine: "setDailyGoal",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "PUT", path: "/daily-goal" },
        bind: ["goal"]
      }
    ]
  }),
  command({
    id: "day-cutoff",
    args: {
      value: { type: "string", required: true }
    },
    engine: "setDayCutoff",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "PUT", path: "/day-cutoff" },
        bind: ["value"]
      }
    ]
  }),
  command({
    id: "discuss-pack",
    args: {
      node: { type: "string", required: true, read: "query" },
      course: { type: "string", read: "query" }
    },
    engine: "discussionPack",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/discuss-pack" },
        bind: ["course", "node"]
      }
    ]
  }),
  command({
    id: "file",
    args: {},
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/file" }
      }
    ]
  }),
  command({
    id: "generate",
    summary: "Queue one course note for generation via the global serial queue: outline first (the model decides section split, order, and types from the content, topic, and style — no fixed structure), then one model call per section through the quality gates as a draft (ready sections are skipped, so retrying resumes the pipeline), then per-section + synthesis quiz questions. Returns immediately with a queue position; at most one node pipeline runs at a time (check the gen-jobs registry tool or panel generate tab for progress). The context pack (prereqs, domain boundary, forbidden concepts) and user-editable prompt templates (state/提示词/课程大纲.md, 课程节生成.md) drive the calls. Missing notes are scaffolded first (on-demand lesson semantics). style selects a per-section prompt variant (课程节生成-<style>, e.g. 苏格拉底/费曼) applied to every section call; the outline and gates stay on the default path.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name to generate", required: true },
      style: { type: "string", description: "Prompt style variant; omit for the default template" }
    },
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "queued",
        tool: "learnhub_generate",
        phase: "outline"
      },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/generate" },
        phase: "outline"
      }
    ]
  }),
  command({
    id: "generate-cancel",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/generate/cancel" }
      }
    ]
  }),
  command({
    id: "generate-resume",
    args: {},
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/generate/resume" }
      }
    ]
  }),
  command({
    id: "generate-status",
    args: {},
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/generate/status" }
      }
    ]
  }),
  command({
    id: "goal-intention",
    summary: "Set or clear an execution intention (C-5 if-then plan) on TODAY's「今天学它」pin for a node: pass cue AND action to write「在【时间/地点锚】之后【单一具体行动】」— format locked to a stable time/place cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence); pass neither to clear it. The intention lives on the pin (goal preference), covers the recommendation read side only, and expires with the pin tomorrow — it has no life of its own. Surface it from learnhub_recommend events (pinned events carry an intention {cue, action}). Fails loud if the node has no pin today. Learner Output: zero effect on scheduling, mastery, or XP.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name (must have a pin today)", required: true },
      cue: { type: "string", description: "Execution-intention cue (stable time/place anchor) — omit cue AND action to clear" },
      action: { type: "string", description: "Execution-intention action (ONE concrete action, verb-first) — omit cue AND action to clear" }
    },
    engine: "setGoalIntention",
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_goal_intention" }
    ]
  }),
  command({
    id: "jol",
    args: {
      enabled: { type: "boolean" },
      rate: { type: "number", read: "finite" }
    },
    engine: "jolConfig",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/jol" },
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "PUT", path: "/jol" }
      }
    ]
  }),
  command({
    id: "lesson",
    summary: "Fetch one node's lesson pack as JSON: course body split into teaching sections (练习/反馈 excluded, 答案 merged into 例题), prereqs, and suggested next nodes. Use this to teach a node step by step.",
    args: {
      node: {
        type: "string",
        description: "Node name",
        required: true,
        read: "query"
      },
      course: {
        type: "string",
        description: "Course name",
        required: true,
        read: "query"
      }
    },
    engine: "lesson",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_lesson",
        bind: ["course", "node"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/lesson" },
        bind: ["course", "node"],
        required: ["node"]
      }
    ]
  }),
  command({
    id: "memory",
    args: {},
    engine: "memoryHealth",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/memory" },
        bind: []
      }
    ]
  }),
  command({
    id: "node-pin",
    args: {
      pinned: { type: "boolean", required: true },
      course: { type: "string", required: true },
      node: { type: "string", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/node/pin" }
      }
    ]
  }),
  command({
    id: "pin-today",
    summary: "Pin a node as「今天学它」(E3 goal ownership): for TODAY only it is raised to the top of its course in learnhub_recommend with a「你选了它」marker and its normal reason — a read-side ordering overlay, never a gate; pinning a not-ready node keeps the prerequisite soft-gate hint and the node stays openable. Pins expire automatically tomorrow. Optionally mount an execution intention (C-5): pass cue AND action to attach an if-then plan「在【时间/地点锚】之后【单一具体行动】」— the format is locked to a stable cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence; Gollwitzer & Sheeran 2006). The intention rides the pinned recommend event and the panel, and expires with the pin. Learner Output: zero effect on scheduling, mastery, or XP.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name (must exist in the course graph)", required: true },
      cue: { type: "string", description: "Execution-intention cue (stable time/place anchor, e.g. 早上刷完牙后) — required together with action" },
      action: { type: "string", description: "Execution-intention action (ONE concrete action, verb-first) — required together with cue" }
    },
    engine: "pinToday",
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_pin_today" }
    ]
  }),
  command({
    id: "prompts",
    args: {},
    engine: "promptKinds",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/prompts" },
        bind: []
      }
    ]
  }),
  command({
    id: "question-answer",
    summary: "Answer one bank question (flashcard model): auto-judged 1.0/0.0 (reflection graded by AI against its rubric); the result drives THAT question's FSRS schedule (correct=Good, wrong=Again). Node mastery is purely derived (masteryOfFm: 0.7 x memory-stability progress + 0.3 x practice-evidence EMA); per-question answer stats only feed the completion gate, not mastery. predicted (E4 JOL) records the learner's pre-answer one-tap prediction (会/不会/没把握) from a jol-flagged probe card — omit when not asked.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      qid: { type: "string", description: "Question id inside the bank, e.g. \"q1\"", required: true },
      answer: {
        type: "string",
        description: "User answer (choice: letter, multi_choice: comma-joined letters; true_false: 对/错; fill_in_blank: text; numeric: number; ordering/matching: newline-joined item texts in submitted order; reflection/open_question: free text)",
        required: true,
        read: "fallback"
      },
      predicted: { type: "string", description: "Learner's pre-answer JOL prediction (E4): 会 / 不会 / 没把握", read: "raw" }
    },
    engine: "questionAnswer",
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_question_answer" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/question-answer" },
        required: ["course", "node", "qid"]
      }
    ]
  }),
  command({
    id: "queue",
    args: {},
    engine: "queueItemsAll",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/queue" },
        bind: []
      }
    ]
  }),
  command({
    id: "recommend",
    summary: "Get the dynamic cross-course recommendation queue as JSON: next events (review/learning/new/struggle/diagnostic/pin) ranked by priority (overdue reviews first by days overdue and retention decay, then half-finished lessons, then new lessons by unlock count and region rotation). Each event has type/course/node/score/why. Events the learner pinned as「今天学它」carry pinned=true and lead their course for today only (tomorrow they fall back to the default order); a pinned node with no other event appears as a standalone pin event — a not-ready pinned node keeps its soft-gate hint but stays openable. Events may carry an `advice` array of executable review suggestions {node, r, due, w?}: soft-gate advice on new lessons when a prerequisite's retention decayed below the R gate (review that prereq's due questions first — you may still learn the lesson directly), and remedial advice when a node keeps struggling (review its weighted component-skill ancestors first, ranked by w×(1−R); silent when the node has no enc edges or too few recent answers). Execute an advice item with learnhub_review_queue on {course, node: advice[].node}, then learnhub_question_answer. Events may also carry a `diagnostics` array (B1 content diagnostics, standalone events typed diagnostic): a section whose content keeps failing the learner (R1 single-question repeated lapses, or R2 answer accuracy <0.5 over ≥4 deduped answers since the section was last rewritten) with reason, evidence, and a rewrite direct action {course, node, section} — after the learner confirms, execute it with learnhub_section_rewrite (gated single-section rewrite; the question bank is untouched); the Arc D per-question explain entry lives in the panel's error state. Practice/interaction nodes (reconsolidation-typed, D-4) may appear as type:\"sleep\" events or carry a sleep field {text, rehearsal}: a「睡前练、醒后验」timing suggestion with an optional mental-rehearsal note (evidence-weighted wording) — surface it with the node, never treat it as a due change; the whole layer is switchable via learnhub_sleep_config. Fetch the next batch after finishing one.",
    args: {
      limit: { type: "number", description: "Max events to return (default 5)" }
    },
    engine: "recommend",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_recommend",
        bind: ["limit"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/recommend" }
      }
    ]
  }),
  command({
    id: "review",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true }
    },
    engine: "contentReview",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/review" },
      }
    ]
  }),
  command({
    id: "review-queue",
    summary: "List the cross-course due review cards as JSON (Anki-style; answers omitted — answer with learnhub_question_answer, self-rate Hard/Good/Easy after correct replies). Omit filters for the whole queue: cards sort by predicted recall risk R ascending (r carried per card). Note-source cards (C1) ride the same queue with source:\"note\" and course=笔记源 (node = source id) — answer/rate/forget them through the SAME learnhub_question_answer / learnhub_question_rate / learnhub_question_forget calls; note_drifted (content changed — offer regenerate/archival) and note_suspended (missing source or broken mirror) summaries ride the response; suspended cards never block course cards. Pass course and/or node for TARGETED review — the direct entry that recommendation/status advice items point to (A3 soft-gate prerequisite review and enc component-skill remediation): {course, node} returns exactly that node's due questions. A single-node session is ADAPTIVELY ordered (A1 difficulty tuning): cards carry a combined difficulty scalar d and the response carries the node-mastery start band — present cards nearest that band first; during the session shift the band up one step after every second consecutive correct answer and drop it back toward the base after a wrong/forgot, re-picking the nearest-d remaining card each time. band_pref (E5) is the learner's explicit difficulty choice as a weighted preference on that start band: hard raises it, easy relaxes it, omit for pure A1 — the anti-frustration drop-back still applies. Cards flagged jol=true are the sampled JOL probe (E4): before revealing the answer you may ask the learner for a one-tap prediction (会/不会/没把握) and pass it back as the predicted field on learnhub_question_answer / learnhub_question_forget — skippable, never blocking. A `calibration_hint` string riding the response (Self-Calibration, ADR-0022) means the learner's「会」predictions have run systematically low on actual accuracy: surface it verbatim next to the JOL probe as a gentle, non-blocking expectation-management nudge — never turn it into a score or a gate (the learner can disable it globally). Unknown node names fail loud.",
    args: {
      course: { type: "string", description: "Course name; omit for all enabled courses", read: "query" },
      node: { type: "string", description: "Node name filter — targeted review of this node's due questions (A3 advice direct entry; adaptive difficulty order)", read: "query" },
      band_pref: { type: "string", description: "Learner's explicit difficulty band (E5): easy/standard/hard as a weighted preference on the A1 start band" }
    },
    engine: "reviewQueue",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_review_queue",
        bind: ["course", "node", null, "band_pref"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/review-queue" }
      }
    ]
  }),
  command({
    id: "section-rewrite",
    summary: "Rewrite ONE section of a node through the model — the same gated pipeline as the panel section-rewrite: section task context → model → quality gates → one repair round on gate failure → surgical reassembly of that section (section version +1, node content back to draft; the question bank, FSRS cards, and schedules are untouched). This is the direct action for B1 content-diagnostic suggestions (learnhub_recommend/status diagnostics: R1 single-question repeated failure, R2 section answer-accuracy collapse). Diagnostics are advisory — confirm with the learner before calling; never rewrite a section nobody asked about. Synchronous: a section typically takes tens of seconds.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      section: { type: "string", description: "Section id from the node manifest (e.g. \"s2\") — exactly what diagnostics[].rewrite.section carries", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "queued",
        tool: "learnhub_section_rewrite",
        phase: "sections"
      },
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/generate/section" },
        phase: "sections"
      }
    ]
  }),
  command({
    id: "seed-propose",
    args: {
      course: { type: "string", required: true },
      goal: { type: "string", required: true },
      worksheet: { type: "array" },
      useVaultPrior: { type: "boolean" }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/seed/propose" },
        phase: "种子"
      }
    ]
  }),
  command({
    id: "skip",
    summary: "Mark a node as skipped (learner already knows it) or un-skip. Skipped nodes count as passed: they leave the recommendation queue and no longer block successors. Skipping also archives every non-archived question of the node (reason=skip, ADR-0032) — reversible per question from the bank panel; un-skipping does NOT auto-restore them (restoring is the learner's explicit action).",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      skipped: { type: "boolean", description: "Explicit direction: true to skip, false to un-skip (omission is an argument error)", required: true }
    },
    engine: "nodeSkip",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_skip",
        bind: ["course", "node", "skipped"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/node/skip" }
      }
    ]
  }),
  command({
    id: "sleep",
    args: {
      enabled: { type: "boolean" }
    },
    engine: "sleepAdviceConfig",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/sleep" },
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "PUT", path: "/sleep" }
      }
    ]
  }),
  command({
    id: "sleep-config",
    summary: "Get or set the sleep-coupled scheduling advice layer (D-4). When enabled (default), recommendations for reconsolidation-type nodes (practice/interaction nodes, e.g. instrument or sport practice) carry a「睡前练、醒后验」timing suggestion — practice briefly before sleep, verify retention right after waking (Walker 2002/2005) — plus an optional mental-rehearsal note (small effect r≈0.13, expectation-managed wording). Read-side advice only: it never changes scheduling semantics, due dates, mastery, or XP. Omit enabled to read the current config.",
    args: {
      enabled: { type: "boolean", description: "true/false to turn the sleep advice layer on/off; omit to read current config" }
    },
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_sleep_config" }
    ]
  }),
  command({
    id: "status",
    summary: "Return the learning center status (center summary + per-course detail) as JSON. blocked entries are executable soft-gate advice: a candidate blocked only by a decayed prerequisite carries {pre, r, due, entry} — review the prerequisite's due questions first (direct entry) or still learn the candidate directly. Courses may also carry diagnostics (B1 content-diagnostic suggestions): a section with concentrated wrong answers (R1 single-question lapses or R2 section accuracy <0.5 over ≥4 deduped answers) with reason, evidence, and a rewrite direct action — surface it to the learner and rewrite via learnhub_section_rewrite ONLY after they confirm (advice-first, never automatic). Evaluating diagnostics appends a trigger record to the journal when a signal fires fresh (that ledger drives the 7-day cooldown and R1 escalation); nothing else is written.",
    args: {},
    engine: "statusJson",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_status",
        bind: []
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/status" },
      }
    ]
  }),
  command({
    id: "unpin",
    summary: "Cancel a「今天学它」pin: the node returns to the default recommendation order immediately.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true }
    },
    engine: "unpinToday",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_unpin",
        bind: ["course", "node"]
      }
    ]
  }),
  command({
    id: "vendor-",
    args: {},
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/vendor/" },
        prefix: true
      }
    ]
  }),
  command({
    id: "xp",
    args: {},
    engine: "xpStatus",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/xp" },
        bind: []
      }
    ]
  }),
]
