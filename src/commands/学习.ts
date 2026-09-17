/**
 * 命令注册表·学习域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'

export const 学习域 = {
  'band-session': command({
    id: "band-session",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      band: { type: "string", read: "raw" }
    },
    engine: "learner.logBandSession",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/band-session" }
      }
    ]
  }),
  'calibration-hints': command({
    id: "calibration-hints",
    args: {
      hints_enabled: { type: "boolean", required: true }
    },
    engine: "learner.calibrationHintsConfig",
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
  'calibration-profile': command({
    id: "calibration-profile",
    summary: "Get the self-calibration profile as JSON: per-source slices of learner self-assessment × objective outcome pairs (source \"jol\" = prediction × actual answer; more sources land via the pairing contract). Each source carries calibration bins (per-prediction actual accuracy, shown only at >=10 sampled pairs — below the gate it is null, never fabricated) and an overconfidence verdict with evidence. `global` merges sources as a REFERENCE view only — always present it together with its warning; the per-source slices are authoritative. When a source is overconfident and hints are enabled, review-queue responses carry a `calibration_hint` string: surface it verbatim at the self-assessment exit as a gentle nudge (see learnhub_review_queue); probe density is boosted automatically. Read-only: this never discounts learner self-assessment driving canonical state — FSRS ratings pass through untouched and nothing feeds Mastery/XP. Never present it as a personality trait or a score.",
    args: {},
    engine: "learner.calibrationProfile",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_calibration_profile",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/calibration/profile" },
        bind: []
      }
    ]
  }),
  'coach': command({
    id: "coach",
    summary: "Get the「可用的困难」coach feedback (read-only informational, no gates or scoring): checks the last 7 days of the learner's difficulty-band session choices and in-band performance. All-easy streak with due questions their FSRS state says they should know → a gentle nudge to try the standard band; consistent challenge-band struggle (accuracy below 0.6) → a pointer back to prerequisite/component-skill review. Low data stays silent. Surface messages verbatim when present; never force anything.",
    args: {},
    engine: "learner.coachAdvice",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_coach",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/coach" },
        bind: []
      }
    ]
  }),
  'coach-compass': command({
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
        phase: "compass"
      }
    ]
  }),
  'coach-growth': command({
    id: "coach-growth",
    summary: "Run one coach round for a course and apply the resulting growth batch: enqueues ONE growth job on the generation queue (phase=growth) and waits for its terminal message. The round is a single read-only tool loop — it decides this batch's growth operator and direction, then lands the structure through the draft circuit — and the batch is a kind=edit proposal that applies automatically once the gates pass (no per-batch human review). Structure only: no content is enqueued, so the receipt names the created nodes and you generate their bodies separately. Rejected when the course has zero endpoints, when the queue is paused (resume from the generate page), or while a batch is already running/cancelling. Budget: one deep tool loop — do not call it repeatedly to 'hurry' a course along.",
    args: {
      course: { type: "string", description: "Course name", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "queued",
        route: { method: "POST", path: "/coach/growth" },
        phase: "growth"
      },
      { channel: "agent", mode: "sync", tool: "learnhub_growth_batch" }
    ]
  }),
  'coach-draft-cancel': command({
    id: "coach-draft-cancel",
    summary: "Cancel the in-flight growth draft (生长草稿) of a course — deletes the DRAFT SNAPSHOT so the next growth step opens a fresh session. This is the escape hatch for a stuck draft session: when the round budget is exhausted (later draft_patch calls are refused; only draft_finish is still allowed) or when the unpublished increments keep failing the acceptance gate, the course stays resumed on that draft forever (drafts are resumed by default and round counts accumulate), and this is the way out. Only UNPUBLISHED increments are dropped — everything already published was applied to the graph and stays. Prefer draft_finish when the prepared increments are publishable; confirm with the learner before dropping work.",
    args: {
      course: { type: "string", description: "Course name", required: true }
    },
    engine: "growth2.coachDraftCancel",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_coach_draft_cancel",
        bind: ["course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/coach/draft/cancel" },
        bind: ["course"]
      }
    ]
  }),
  'stuck-report': command({
    id: "stuck-report",
    args: {
      course: { type: "string", required: true },
      node: { type: "string", required: true },
      text: { type: "string", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/coach/stuck-report" }
      }
    ]
  }),
  'complete': command({
    id: "complete",
    summary: "Confirm a node has been learned this round. Accuracy below the passing line (0.6, with enough attempts) is rejected with accepted=false — review prerequisites or retry with force. On acceptance: unanswered bank questions get their FSRS card initialized (due tomorrow), the node stage moves to review, and a perfect-score completion earns bonus XP.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      force: { type: "boolean", description: "true to bypass the accuracy gate" }
    },
    engine: "sched2.nodeComplete",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_complete",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/node/complete" },
      }
    ]
  }),
  'courses-tree': command({
    id: "courses-tree",
    args: {
      course: { type: "string", read: "query" },
      axis: { type: "string", description: "Grouping axis: depth (default) / concept / endpoint", read: "query" }
    },
    engine: "content2.coursesTree",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/courses/tree" },
        bind: ["course", "axis"]
      }
    ]
  }),
  'daily-goal': command({
    id: "daily-goal",
    args: {
      goal: { type: "number", required: true }
    },
    engine: "sched2.setDailyGoal",
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
  'discuss-pack': command({
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
  'file': command({
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
  'generate': command({
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
  'generate-cancel': command({
    id: "generate-cancel",
    summary: "Cancel a queued or running generation task for one node (排队的任务直接出队；running 的置 cancelling，回路在下一个检查点中止). node is the job key's node part: a node name for content/quiz jobs, or the job's own node for graph jobs (e.g. 罗盘 / 计划草案 / 里程碑草案) and 生长批 for the growth job. Works on the task registry, so it reaches anything that went through the queue — it does NOT reach a single-section rewrite in flight (that path is not registered). Returns whether anything was cancelled.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name, or the job node for queue-level jobs (生长批 / 罗盘 / 计划草案 / 里程碑草案)", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/generate/cancel" }
      },
      { channel: "agent", mode: "sync", tool: "learnhub_generate_cancel" }
    ]
  }),
  'generate-resume': command({
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
  'generate-status': command({
    id: "generate-status",
    summary: "Read the generation queue: every task record (course/node/status/message/progress/tier), the terminal-state retention readout, and the queue flags — including queuePaused (set by restart recovery: enqueuing still succeeds while paused, but the pump does not run until the queue is resumed from the panel). Use it to answer 'did my generation/growth task start, is it stuck, what did it say' before enqueuing anything else, and after a cancel.",
    args: {},
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/generate/status" }
      },
      { channel: "agent", mode: "sync", tool: "learnhub_generate_status" }
    ]
  }),
  'goal-intention': command({
    id: "goal-intention",
    summary: "Set or clear an execution intention (an if-then plan) on TODAY's「今天学它」pin for a node: pass cue AND action to write「在【时间/地点锚】之后【单一具体行动】」— format locked to a stable time/place cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence); pass neither to clear it. The intention lives on the pin, covers the recommendation read side only, and expires with the pin tomorrow — it has no life of its own. Surface it from learnhub_recommend events (pinned events carry an intention {cue, action}). Fails loud if the node has no pin today. Zero effect on scheduling, mastery, or XP.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name (must have a pin today)", required: true },
      cue: { type: "string", description: "Execution-intention cue (stable time/place anchor) — omit cue AND action to clear" },
      action: { type: "string", description: "Execution-intention action (ONE concrete action, verb-first) — omit cue AND action to clear" }
    },
    engine: "learner.setGoalIntention",
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_goal_intention" }
    ]
  }),
  'jol': command({
    id: "jol",
    args: {
      enabled: { type: "boolean" },
      rate: { type: "number", read: "finite" }
    },
    engine: "learner.jolConfig",
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
  'lesson': command({
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
    engine: "content2.lesson",
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
  'memory': command({
    id: "memory",
    args: {},
    engine: "sched2.memoryHealth",
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
  'pin-today': command({
    id: "pin-today",
    summary: "Pin a node as「今天学它」: for TODAY only it is raised to the top of its course in learnhub_recommend with a「你选了它」marker and its normal reason — a read-side ordering overlay, never a gate; pinning a not-ready node keeps the prerequisite soft-gate hint and the node stays openable. Pins expire automatically tomorrow. Optionally mount an execution intention: pass cue AND action to attach an if-then plan「在【时间/地点锚】之后【单一具体行动】」— the format is locked to a stable cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence). The intention rides the pinned recommend event and the panel, and expires with the pin. Zero effect on scheduling, mastery, or XP.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name (must exist in the course graph)", required: true },
      cue: { type: "string", description: "Execution-intention cue (stable time/place anchor, e.g. 早上刷完牙后) — required together with action" },
      action: { type: "string", description: "Execution-intention action (ONE concrete action, verb-first) — required together with cue" }
    },
    engine: "learner.pinToday",
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_pin_today" }
    ]
  }),
  'prompts': command({
    id: "prompts",
    args: {},
    engine: "content2.promptKinds",
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
  'question-answer': command({
    id: "question-answer",
    summary: "Answer one bank question (flashcard model): auto-judged 1.0/0.0 (reflection graded by AI against its rubric); the result drives THAT question's FSRS schedule (correct=Good, wrong=Again). Node mastery is purely derived (memory-stability progress + practice evidence); per-question answer stats only feed the completion gate, not mastery. predicted records the learner's pre-answer one-tap prediction (会/不会/没把握) from a jol-flagged probe card — omit when not asked.",
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
    engine: "content2.questionAnswer",
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
  'queue': command({
    id: "queue",
    args: {},
    engine: "content2.queueItemsAll",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/queue" },
        bind: [],
        // 面板轮询读路由（#302 ②）：留痕降到 DEBUG——本路由与 /generate/status 实测占某日
        // engine.call 的 78%，INFO 层被轮询噪音淹没；失败留痕（engine.call.fail）仍是 ERROR。
        log: "debug"
      }
    ]
  }),
  'recommend': command({
    id: "recommend",
    summary: "Get the dynamic cross-course recommendation queue as JSON: next events (review/learning/new/struggle/diagnostic/pin) ranked by priority (overdue reviews first by days overdue and retention decay, then half-finished lessons, then new lessons by unlock count and region rotation). Each event has type/course/node/score/why. Events the learner pinned as「今天学它」carry pinned=true and lead their course for today only (tomorrow they fall back to the default order); a pinned node with no other event appears as a standalone pin event — a not-ready pinned node keeps its soft-gate hint but stays openable. Events may carry an `advice` array of executable review suggestions {node, r, due, w?}: soft-gate advice on new lessons when a prerequisite's retention decayed below the gate (review that prereq's due questions first — you may still learn the lesson directly), and remedial advice when a node keeps struggling (review its weighted component-skill ancestors first, ranked by weight × missed retention; silent when the node has no enc edges or too few recent answers). Execute an advice item with learnhub_review_queue on {course, node: advice[].node}, then learnhub_question_answer. Events may also carry a `diagnostics` array (standalone events typed diagnostic): a section whose content keeps failing the learner (a single question with repeated lapses, or section answer accuracy <0.5 over ≥4 deduped answers since the section was last rewritten) with reason, evidence, and a rewrite direct action {course, node, section} — after the learner confirms, execute it with learnhub_section_rewrite (gated single-section rewrite; the question bank is untouched); the per-question explain entry lives in the panel's error state. Practice/interaction nodes may appear as type:\"sleep\" events or carry a sleep field {text, rehearsal}: a「睡前练、醒后验」timing suggestion with an optional mental-rehearsal note (evidence-weighted wording) — surface it with the node, never treat it as a due change; the whole layer is switchable via learnhub_sleep_config. Fetch the next batch after finishing one.",
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
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/recommend" }
      }
    ]
  }),
  'review-queue': command({
    id: "review-queue",
    summary: "List the cross-course due review cards as JSON (Anki-style; answers omitted — answer with learnhub_question_answer, self-rate Hard/Good/Easy after correct replies). Omit filters for the whole queue: cards sort by predicted recall risk ascending (r carried per card). Note-source cards ride the same queue with source:\"note\" and course=笔记源 (node = source id) — answer/rate/forget them through the SAME learnhub_question_answer / learnhub_question_rate / learnhub_question_forget calls; note_drifted (content changed — offer regenerate/archival) and note_suspended (missing source or broken mirror) summaries ride the response; suspended cards never block course cards. Pass course and/or node for TARGETED review — the direct entry that recommendation/status advice items point to (soft-gate prerequisite review and component-skill remediation): {course, node} returns exactly that node's due questions. A single-node session is ADAPTIVELY ordered: cards carry a combined difficulty scalar d and the response carries the node-mastery start band — present cards nearest that band first; during the session shift the band up one step after every second consecutive correct answer and drop it back toward the base after a wrong/forgot, re-picking the nearest-d remaining card each time. band_pref is the learner's explicit difficulty choice as a weighted preference on that start band: hard raises it, easy relaxes it, omit for pure adaptive — the anti-frustration drop-back still applies. Cards flagged jol=true are the sampled prediction probe: before revealing the answer you may ask the learner for a one-tap prediction (会/不会/没把握) and pass it back as the predicted field on learnhub_question_answer / learnhub_question_forget — skippable, never blocking. A `calibration_hint` string riding the response means the learner's「会」predictions have run systematically low on actual accuracy: surface it verbatim next to the probe as a gentle, non-blocking expectation-management nudge — never turn it into a score or a gate (the learner can disable it globally). Unknown node names fail loud.",
    args: {
      course: { type: "string", description: "Course name; omit for all enabled courses", read: "query" },
      node: { type: "string", description: "Node name filter — targeted review of this node's due questions (A3 advice direct entry; adaptive difficulty order)", read: "query" },
      band_pref: { type: "string", description: "Learner's explicit difficulty band (E5): easy/standard/hard as a weighted preference on the A1 start band" }
    },
    engine: "content2.reviewQueue",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_review_queue",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/review-queue" }
      }
    ]
  }),
  'section-rewrite': command({
    id: "section-rewrite",
    summary: "Rewrite ONE section of a node through the model — the same gated pipeline as the panel section-rewrite: section task context → model → quality gates → one repair round on gate failure → surgical reassembly of that section (section version +1, node content back to draft; the question bank, FSRS cards, and schedules are untouched). This is the direct action for content-diagnostic suggestions from learnhub_recommend / learnhub_status (repeated single-question failures or section answer-accuracy collapse). Diagnostics are advisory — confirm with the learner before calling; never rewrite a section nobody asked about. Synchronous: a section typically takes tens of seconds.",
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
  'course-create': command({
    id: "course-create",
    summary: "Create a course from its name only (name = empty graph): one write unit lands the registry entry, the course root with data/图.yaml ({ nodes: [] } — the legal carrier of an empty graph), an empty concept registry, an empty endpoint-anchor book and the compass scaffold. NO generation is started: a zero-node graph never enters automatic coach triggers, and adding endpoints declares directions only; the first growth comes from the learner dispatching a coach round explicitly (coach-growth).",
    args: {
      name: { type: "string", description: "Course name (the registry primary key; duplicates are rejected)", required: true }
    },
    engine: "graph.createCourse",
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/course/create" },
        bind: ["name"]
      }
    ]
  }),
  'endpoint-add': command({
    id: "endpoint-add",
    summary: "Add an endpoint (终点) to a course (endpoints are learner-authored, any number, written to disk immediately — no generation queue): lands a zero-pre node plus one anchor record {goal_type: capability, optional goal_note}. No AI qualification gate applies (the learner is the authority); structure gates still run (duplicate node names rejected — an existing node cannot be made an endpoint). Declaration only: NO generation is started, so the learner can declare every direction first and then release the coach once with one explicit round (coach-growth).",
    args: {
      course: { type: "string", required: true },
      endpoint: { type: "string", description: "Endpoint node name (must not collide with any existing node/anchor)", required: true },
      goalNote: { type: "string", description: "Optional one-sentence direction note for the coach" }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/endpoint/add" }
      }
    ]
  }),
  'endpoint-remove': command({
    id: "endpoint-remove",
    summary: "Remove an endpoint (终点) from a course: the anchor record and the node disappear in one write unit; already-laid steps stay on the graph as loose ends (pre edges pointing at the endpoint are unhooked). The endpoint is a direction marker with zero content/questions/scheduling, so nothing else is lost.",
    args: {
      course: { type: "string", required: true },
      endpoint: { type: "string", required: true }
    },
    domain: "学习",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/endpoint/remove" }
      }
    ]
  }),
  'skip': command({
    id: "skip",
    summary: "Mark a node as skipped (learner already knows it) or un-skip. Skipped nodes count as passed: they leave the recommendation queue and no longer block successors. Skipping also archives every non-archived question of the node (reason=skip) — reversible per question from the bank panel; un-skipping does NOT auto-restore them (restoring is the learner's explicit action).",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      skipped: { type: "boolean", description: "Explicit direction: true to skip, false to un-skip (omission is an argument error)", required: true }
    },
    engine: "sched2.nodeSkip",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_skip",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/node/skip" }
      }
    ]
  }),
  'sleep': command({
    id: "sleep",
    args: {
      enabled: { type: "boolean" }
    },
    engine: "lab.sleepAdviceConfig",
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
  'sleep-config': command({
    id: "sleep-config",
    summary: "Get or set the sleep-coupled scheduling advice layer. When enabled (default), recommendations for reconsolidation-type nodes (practice/interaction nodes, e.g. instrument or sport practice) carry a「睡前练、醒后验」timing suggestion — practice briefly before sleep, verify retention right after waking — plus an optional mental-rehearsal note (small effect, expectation-managed wording). Read-side advice only: it never changes scheduling semantics, due dates, mastery, or XP. Omit enabled to read the current config.",
    args: {
      enabled: { type: "boolean", description: "true/false to turn the sleep advice layer on/off; omit to read current config" }
    },
    domain: "学习",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_sleep_config" }
    ]
  }),
  'status': command({
    id: "status",
    summary: "Return the learning center status (center summary + per-course detail) as JSON. blocked entries are executable soft-gate advice: a candidate blocked only by a decayed prerequisite carries {pre, r, due, entry} — review the prerequisite's due questions first (direct entry) or still learn the candidate directly. Courses may also carry diagnostics (content-diagnostic suggestions): a section with concentrated wrong answers (a single question with repeated lapses, or section accuracy <0.5 over ≥4 deduped answers) with reason, evidence, and a rewrite direct action — surface it to the learner and rewrite via learnhub_section_rewrite ONLY after they confirm (advice-first, never automatic). Evaluating diagnostics appends a trigger record to the journal when a signal fires fresh (that ledger drives the 7-day cooldown and escalation); nothing else is written.",
    args: {},
    engine: "statusJson",
    domain: "学习",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_status",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/status" },
      }
    ]
  }),
  'unpin': command({
    id: "unpin",
    summary: "Cancel a「今天学它」pin: the node returns to the default recommendation order immediately.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true }
    },
    engine: "learner.unpinToday",
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
  'vendor-': command({
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
  'xp': command({
    id: "xp",
    args: {},
    engine: "sched2.xpStatus",
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
}
