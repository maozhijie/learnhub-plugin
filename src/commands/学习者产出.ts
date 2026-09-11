/**
 * 命令注册表·学习者产出域（#169；ADR-0045 裁定：声明按域分文件、单点装配、门在装配表上跑）。
 *
 * 本文件由重构前的两个投递面实测生成，之后**手改会被门打回**——声明的权威是
 * tests/commands.test.ts 的两道对账（工具面快照 + 路由清单/探针快照）。
 */
import { command } from './types.ts'

export const 学习者产出域 = {
  'error-card-answer': command({
    id: "error-card-answer",
    summary: "Settle one 错误对比卡 (C-3 #82) with the learner's three-way choice: the choice must be one of the card's option texts verbatim. Auto-graded — picking the correct approach pushes the card with rating 3, picking wrong with rating 1 (one push per card per day, second same-day answer rejected). Only the card's own FSRS block moves (default params, optimizer never trains it); a correct pick earns unbound XP (xp_error journal row — totals/daily goal/streak only, never per-course/per-node ledgers or mastery); wrong picks leave a 0-XP unbound row. The reveal (answer / the learner's mine option / explanation) rides the response for the learner to compare.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node the card belongs to", required: true },
      card: { type: "string", description: "Card id, e.g. \"c1\"", required: true },
      choice: { type: "string", description: "The chosen option text (verbatim one of options)", required: true }
    },
    engine: "bank2.errorCardAnswer",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_error_card_answer",
        bind: ["course", "node", "card", "choice"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/error-answer" }
      }
    ]
  }),
  'error-card-archive': command({
    id: "error-card-archive",
    summary: "Archive or restore one 错误对比卡 (C-3 #82 management): archived cards leave the review queue but keep their history in the card file; a question with only an archived card becomes minable again on the next generate run. Error-deck internal action: zero canonical writes.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node the card belongs to", required: true },
      card: { type: "string", description: "Card id, e.g. \"c1\"", required: true },
      archived: { type: "boolean", description: "true to archive, false to restore", required: true }
    },
    engine: "bank2.errorCardArchive",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_error_card_archive",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/error-archive" }
      }
    ]
  }),
  'error-card-generate': command({
    id: "error-card-generate",
    summary: "Generate 错误对比卡 discrimination cards from mined error patterns (C-3 #82): picks the top uncovered candidates (same question failed substantively >=2 times, no active card yet, batch cap 5), feeds the model the original question/answer/explanation + the learner's own wrong answers + the bound section excerpt, and the model returns three-option cards where ONE option is the learner's own wrong approach. Cards pass a schema gate (exactly 3 distinct options; answer and mine must both be among them and differ; (node,source_q) must match an offered candidate) and land in the per-node 错误卡 deck (课程根/错误卡/<节点>.yaml). Creation is zero XP and writes nothing canonical — the deck joins the review queue (source=error) and reviews earn unbound XP via learnhub_error_card_answer. Zero-disk-write on any model/gate failure.",
    args: {
      course: { type: "string", description: "Course name" },
      node: { type: "string", description: "Node name to scope mining/generation", read: "text" },
      max: { type: "number", description: "Max cards this run (default 5, cap 5)" }
    },
    engine: "errorCardGenerate",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_error_card_generate" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/error-generate" },
        required: ["course"]
      }
    ]
  }),
  'error-card-mine': command({
    id: "error-card-mine",
    summary: "Mine the answer-attempt stream for high-frequency error patterns (C-3 #82, read-only preview): groups substantive wrong answers (correct=false with an actual wrong answer; forget declarations do not count) by course/node/question and returns candidates with >=2 lapses, each carrying the learner's distinct wrong answers (most recent first). This is the human-audit surface for \"error patterns are reasonable\" — generation is learnhub_error_card_generate; nothing is written here.",
    args: {
      course: { type: "string", description: "Course name; omit for all enabled courses" },
      node: { type: "string", description: "Node name to scope the mining" }
    },
    engine: "bank2.errorCardMine",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_error_card_mine",
        bind: ["course", "node"]
      }
    ]
  }),
  'error-card-queue': command({
    id: "error-card-queue",
    summary: "List ALL 错误对比卡 (C-3 #82) for inventory/audit: due cards first (due ascending), never-scheduled cards after. Each card carries the full face (q/options/answer/mine/explanation) plus source_q provenance — use this to spot-check that mined error patterns are faithful to what the learner actually did. Review happens in the merged cross-course review queue (source=error) or directly via learnhub_error_card_answer (auto-graded: pick the correct approach = 3, pick wrong = 1; one push per card per day). Correct picks earn unbound XP (totals/daily goal/streak only).",
    args: {
      course: { type: "string", description: "Course name; omit for all enabled courses", read: "query" }
    },
    engine: "bank2.errorCardQueue",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_error_card_queue",
        bind: ["course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/error-queue" },
        bind: ["course"]
      }
    ]
  }),
  'execution-log': command({
    id: "execution-log",
    summary: "Log one execution event on a skill (the lane's core input): a real practice + a performance rating (1-4 integer; 4 = strong, 1 = poor) that pushes the skill's lane via the same advance kernel (one push per lane per learning day). Source honesty: source='auto' REQUIRES observable evidence (evidence.accuracy 0-1, optional evidence.self_help) mapped deterministically — raw scores are never fed to FSRS; source='self'/'ai' take an explicit rating. XP = native focused minutes (minutes 1-1440, 1 XP ≈ 1 min), same ledger and streak as study time (ADR-0019); the event row lands in the review log with rating_source=execution and an event kind (acquisition/maintenance) distinguishing the two flows.",
    args: {
      skill: { type: "string", description: "Skill id", required: true },
      source: { type: "string", description: "auto (evidence-mapped) / self / ai", required: true },
      minutes: { type: "number", description: "Focused minutes of this execution (1-1440); credited as XP 1:1", required: true },
      rating: { type: "number", description: "Performance rating 1-4 (required unless source=auto)" },
      evidence: { type: "object", description: "source=auto only: {accuracy: 0-1, self_help?: count}", additionalProperties: true },
      note: { type: "string", description: "Free note (e.g. what was practiced, receipt reference)" }
    },
    engine: "executionLog",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_execution_log" }
    ]
  }),
  'explain-back': command({
    id: "explain-back",
    args: {
      messages: { type: "array" },
      course: { type: "string", required: true },
      node: { type: "string", required: true }
    },
    domain: "学习者产出",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/explain-back" }
      }
    ]
  }),
  'explain-back-pack': command({
    id: "explain-back-pack",
    summary: "Open the「讲给我听」Feynman session for a node (E2, learner output — the learner explains to YOU): returns the session pack = section-by-section content points + graph position + your role instructions. Your role in this and following turns: a COMPLETE NOVICE who knows nothing about the topic — ask questions ONLY from the content points, one question at a time, probing ambiguity/vagueness, skipped steps, and wrong statements in the learner's words; never grade, never praise, never go beyond the points, never give answers; if the learner says「换一种问」re-ask the unclear point from a different angle; wrap up briefly in-character once everything is covered. After the session ends, call learnhub_explain_feedback with the full transcript.",
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
    engine: "learner.explainBackPack",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_explain_back_pack",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/explain-back-pack" },
        bind: ["course", "node"],
        required: ["node"]
      }
    ]
  }),
  'explain-feedback': command({
    id: "explain-feedback",
    summary: "Close a「讲给我听」session (E2) with located feedback: sends the full transcript to the grading model against the node's content points and returns verdict (对/部分对/错) + deviation tags (含糊/跳跃/说错) + a \"how to fill the gap\" advice + the full markdown feedback for the learner. The verdict is archived ONLY in the E archive — zero XP, zero canonical writes (Learner Output boundary); fails loud with zero side effects if the model output is unparseable.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      transcript: {
        type: "string",
        description: "Full explain-back dialogue (learner explanations + your novice questions)",
        required: true,
        read: "fallback"
      }
    },
    engine: "learner.explainBackFeedback",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_explain_feedback" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/explain-feedback" },
        required: ["course", "node"]
      }
    ]
  }),
  'explain-pack': command({
    id: "explain-pack",
    args: {
      node: { type: "string", required: true, read: "query" },
      qid: { type: "string", required: true, read: "query" },
      course: { type: "string", read: "query" }
    },
    engine: "errorExplainPack",
    domain: "学习者产出",
    channels: [
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/explain-pack" },
      }
    ]
  }),
  'habit-archive': command({
    id: "habit-archive",
    summary: "Archive or restore a habit (reversible; archived is a shelving label). Habits have no deadlines — staying active forever is legal.",
    args: {
      habit: { type: "string", description: "Habit id", required: true },
      archived: { type: "boolean", description: "true to archive, false to restore", required: true }
    },
    engine: "learner.habitArchive",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_habit_archive",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/habits/archive" },
      }
    ]
  }),
  'habit-create': command({
    id: "habit-create",
    summary: "Create a habit (U-area first-class object): an execution intention (cue + action, format locked to \"stable time/place cue → ONE concrete action\") + an automation curve + a forgiving streak. Habits have NO FSRS semantics, no mastery, NO due dates — the scheduler is context and calendar, the engine never reminds. Repetitions are self-reported (no gate, no anti-cheat — self-measurement is not an exam).",
    args: {
      name: { type: "string", description: "Habit name", required: true },
      cue: { type: "string", description: "Stable cue: time/place anchor (e.g. \"after brushing teeth in the morning\")", required: true },
      action: { type: "string", description: "ONE concrete action (verb-first); multi-behavior chains fall outside the evidence format", required: true }
    },
    engine: "learner.habitCreate",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_habit_create" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/habits/create" }
      }
    ]
  }),
  'habit-list': command({
    id: "habit-list",
    summary: "List habits with their derived surfaces: total self-reported repeats, forgiving streak (small gaps ≤2 days don't break it), and latest automation self-rating. Curve and streak are shown to the learner only — they never enter mastery, XP, or any canonical measure.",
    args: {},
    engine: "learner.habitList",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_habit_list",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/habits" },
        bind: []
      }
    ]
  }),
  'habit-repeat': command({
    id: "habit-repeat",
    summary: "Self-report one repetition of a habit (the ONLY counting source; unlimited, no gate). Optionally carry an automation self-rating 1-5 (SRBAI-style, event-level, not required every time). Zero XP, zero scheduling writes — habit repeats never enter the execution-event lane or any ledger.",
    args: {
      habit: { type: "string", description: "Habit id", required: true },
      auto_rating: { type: "number", description: "Optional automation self-rating 1-5 (how automatic did it feel?)" },
      note: { type: "string", description: "Free note", read: "text" }
    },
    engine: "learner.habitRepeat",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_habit_repeat" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/habits/repeat" }
      }
    ]
  }),
  'habit-show': command({
    id: "habit-show",
    summary: "Show one habit in full: execution intention (cue + action), full automation curve (x = cumulative repeats, y = self-rating 1-5; no decay — interruptions don't erode it), streak, and recent repeat log.",
    args: {
      habit: {
        type: "string",
        description: "Habit id",
        required: true,
        read: "query"
      }
    },
    engine: "learner.habitShow",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_habit_show",
        bind: ["habit"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/habit" },
        bind: ["habit"]
      }
    ]
  }),
  'kata-convert-experiment': command({
    id: "kata-convert-experiment",
    summary: "One-click exit from the Kata's「下一实验」to an N-of-1 experiment proposal (U-4↔D-1 interface): files the SAME proposal-confirm flow as learnhub_experiment_propose (nothing starts by itself) and stamps the proposal number into the Kata record. Requires the week's record to exist (learnhub_kata_open first).",
    args: {
      week_start: { type: "string", description: "Monday YYYY-MM-DD of the record", required: true },
      template: { type: "string", description: "Template id from learnhub_experiment_templates", required: true },
      course: { type: "string", description: "Scope to one course; omit for all enabled courses" }
    },
    engine: "learner.kataToExperiment",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_kata_convert_experiment",
        bind: ["week_start", "template", "course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/kata/convert/experiment" },
        bind: ["week_start", "template", "course"]
      }
    ]
  }),
  'kata-convert-intention': command({
    id: "kata-convert-intention",
    summary: "One-click exit from the Kata's「下一实验」to an Execution Intention pinned to TODAY'S goal preference (U-4↔C-5 interface): pins the chosen node to the top of today's recommendations carrying the if-then plan (cue = stable time/place anchor, action = ONE concrete act; format is locked and validated) and stamps the record. The pin expires with the day — the intention lives on today's read-side only.",
    args: {
      week_start: { type: "string", description: "Monday YYYY-MM-DD of the record", required: true },
      course: { type: "string", description: "Course name of the target node", required: true },
      node: { type: "string", description: "Node to pin today", required: true },
      cue: { type: "string", description: "Stable cue (time/place anchor), e.g. 早上刷完牙后", required: true },
      action: { type: "string", description: "Single concrete action, e.g. 做 5 道到期复习", required: true }
    },
    engine: "kataToIntention",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_kata_convert_intention" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/kata/convert/intention" }
      }
    ]
  }),
  'kata-open': command({
    id: "kata-open",
    summary: "Open the Weekly Kata (U-4, ADR-0026 — the global once-per-week five-question debrief where the bounded area [course overview + one section per active project] meets the unbounded area [habits + skill entries]): the review target is the LAST COMPLETE learning week (calendar week folded by learning days; early-morning sessions roll back over the day cutoff). The「现状」section is auto-filled by the engine from that week's REAL data (XP, answers/accuracy, true retention, per-project milestone passes and exec events, habit repeats, skill executions, note-source reviews with [[links]] back to the personal notes); the other four questions (目标条件/障碍/下一实验/预期所学) are the LEARNER'S to answer — ask them, never answer for them. The record lands in 学习中心/我的产出/周复盘/<Monday>.md (V-3 output zone; registrable as a Note Source). Learner Output domain: zero XP, no Mastery, no FSRS card, zero canonical writes; no reminders, missing a week is never penalized.",
    args: {
      week_start: { type: "string", description: "Monday YYYY-MM-DD of the week to review; omit for the most recent complete week", read: "query" }
    },
    engine: "learner.kataOpen",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_kata_open",
        bind: ["week_start"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/kata" },
        bind: ["week_start"]
      }
    ]
  }),
  'kata-save': command({
    id: "kata-save",
    summary: "Save the learner's answers to the four learner questions of a Weekly Kata record (现状 is engine-owned and cannot be written here — facts come from behavior). Patch semantics: only provided keys are written; empty string resets a question to unanswered. Use this after the learner answers out loud, or point them at the panel/obsidian file to write directly.",
    args: {
      week_start: { type: "string", description: "Monday YYYY-MM-DD of the record", required: true },
      answers: {
        type: "object",
        description: "Partial map: 目标条件/障碍/下一实验/预期所学 → learner's own words",
        additionalProperties: true,
        required: true
      }
    },
    engine: "learner.kataSave",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_kata_save",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/kata/save" },
        required: ["week_start"]
      }
    ]
  }),
  'learner-card-add': command({
    id: "learner-card-add",
    summary: "Archive the learner's own wording as a LearnerCard (E1「我的卡」, the archive target of E2 explain-back): kind recall_cue (再讲一遍 — default; front asks them to re-explain in their own words) or cloze_rewrite (挖空重述; content must contain at least one non-empty {{…}} cloze). The card lives in the「我的卡」E domain (ADR-0021: its reviews ride the merged cross-course review queue and earn unbound XP — totals/daily goal/streak only, never per-course or per-node ledgers; one push per card per day via learnhub_learner_rate / learnhub_learner_forget). Creating the card is zero XP and writes nothing to mastery or node scheduling. Duplicate content on the same node is rejected.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Source node the card attaches to", required: true },
      content: {
        type: "string",
        description: "The learner's own wording (the archived explanation/note)",
        required: true,
        read: "fallback"
      },
      kind: { type: "string", description: "recall_cue (default) or cloze_rewrite", read: "raw" },
      prompt: { type: "string", description: "Front prompt; a default is generated per kind when omitted", read: "text" },
      section: { type: "string", description: "Section id to anchor the card to a specific section", read: "text" }
    },
    engine: "explainArchiveCard",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_learner_card_add" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/explain-archive" },
        required: ["course", "node"]
      }
    ]
  }),
  'learner-card-archive': command({
    id: "learner-card-archive",
    summary: "Archive or restore one「我的卡」self-note card (E1 management). Archived cards leave the learner queue but keep their history in the card file. E-domain internal action: zero canonical writes.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node the card belongs to (source_node)", required: true },
      card: { type: "string", description: "Card id, e.g. \"c1\"", required: true },
      archived: { type: "boolean", description: "true to archive, false to restore", required: true }
    },
    engine: "learner.learnerCardArchive",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_learner_card_archive",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/learner-archive" },
      }
    ]
  }),
  'learner-forget': command({
    id: "learner-forget",
    summary: "Declare「忘记」on a「我的卡」self-note card — the learner could not restate it, so the card is pushed with rating 1 (again tomorrow). One push per card per day; zero XP (a 0-XP unbound journal row keeps the streak ledger honest, ADR-0021), no mastery or node-scheduling writes.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node the card belongs to (source_node)", required: true },
      card: { type: "string", description: "Card id, e.g. \"c1\"", required: true }
    },
    engine: "learner.learnerCardForget",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_learner_forget",
        bind: ["course", "node", "card"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/learner-forget" },
        bind: ["course", "node", "card"]
      }
    ]
  }),
  'learner-queue': command({
    id: "learner-queue",
    summary: "List ALL「我的卡」E-domain cards (E1) for inventory/management: due cards first (due ascending), never-scheduled cards after. Each card carries prompt (front: what to restate) and content (back: the learner's own wording), source_node/source_section anchors, and attempts. Review happens in the merged cross-course review queue (ADR-0021) or directly via learnhub_learner_rate (Hard/Good/Easy 2/3/4) / learnhub_learner_forget — one push per card per day. Rating earns unbound XP: counted in totals/daily goal/streak only, never in per-course/per-node ledgers, never in mastery.",
    args: {
      course: { type: "string", description: "Course name; omit for all enabled courses", read: "query" }
    },
    engine: "learner.learnerQueue",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_learner_queue",
        bind: ["course"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/learner-queue" },
        bind: ["course"]
      }
    ]
  }),
  'learner-rate': command({
    id: "learner-rate",
    summary: "Settle one「我的卡」self-note card with the learner's self-rating after they restated and compared (2=Hard 3=Good 4=Easy). One push per card per day (a second same-day rating is rejected). Only the card's own FSRS block moves; the rating earns unbound XP (ADR-0021) — counted in totals/daily goal/streak only, never in per-course/per-node ledgers or mastery.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node the card belongs to (source_node)", required: true },
      card: { type: "string", description: "Card id, e.g. \"c1\"", required: true },
      rating: { type: "number", description: "Self-rating: 2 Hard / 3 Good / 4 Easy", required: true }
    },
    engine: "learner.learnerCardRate",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_learner_rate",
        bind: ["course", "node", "card", "rating"]
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/learner-rate" }
      }
    ]
  }),
  'receipt-list': command({
    id: "receipt-list",
    summary: "List a practice node's receipt history with the fading-feedback state: each receipt's material kind, review depth (full/brief), rubric score, and verdict; total count and how many receipts until the next full review. Read-only.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Practice node name", required: true }
    },
    engine: "receiptList",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_receipt_list",
        bind: ["course", "node"]
      }
    ]
  }),
  'receipt-submit': command({
    id: "receipt-submit",
    summary: "File an external-practice receipt on a PRACTICE node (v1 carrier) and run the full loop: receipt → AI rubric review (rubric source = the node's content points; free-form questions are NOT answered) → the score enters the node's practice EMA (same weight, old 0.7/new 0.3). Self-reported = trusted (no anti-cheat gate); material is free-form (text description / image path / export / coach signoff). Receipts never earn XP, never push any FSRS card, and are never Broken. Feedback fades: full error-specific reviews follow a decreasing-frequency curve (receipt #1,2,4,7,11,16,… capped at every 5th); other receipts get score + one-line verdict only. The learner can always force a full review (force_full).",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Practice node name (type=practice)", required: true },
      kind: { type: "string", description: "text / image / export / signoff", required: true },
      material: { type: "string", description: "Receipt material: description, image path, export data, or signoff reference", required: true },
      force_full: { type: "boolean", description: "Learner explicitly asks for a full error-specific review now" }
    },
    engine: "receiptSubmit",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_receipt_submit" }
    ]
  }),
  'skill-archive': command({
    id: "skill-archive",
    summary: "Archive or restore a skill entry (reversible; archived is a shelving label). Archived skills refuse new execution events until restored.",
    args: {
      skill: { type: "string", description: "Skill id", required: true },
      archived: { type: "boolean", description: "true to archive, false to restore", required: true }
    },
    engine: "learner.skillArchive",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_skill_archive",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/skills/archive" },
      }
    ]
  }),
  'skill-create': command({
    id: "skill-create",
    summary: "Create a skill entry (U-area schedulable practice subject, e.g. guitar/swimming/coding): the carrier of the execution-event scheduling lane. The lane runs PARALLEL to question FSRS (same kernel math, own isolated state) — it never reuses question cards, never enters the review queue, and has no mastery. Optional maintenance beat cap (days, default 30, null = off) guarantees long-dormant skills resurface at low frequency (mini-redo + replay).",
    args: {
      name: { type: "string", description: "Skill name (also becomes the id)", required: true },
      maintenance_days: { type: "number", description: "Maintenance beat cap in days: 7-365, or 0/null to disable (default 30)" }
    },
    engine: "learner.skillCreate",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_skill_create" }
    ]
  }),
  'skill-list': command({
    id: "skill-list",
    summary: "List skill entries with their lane due dates (maintenance cap folded in). due_kind marks what a due lane wants: acquisition (FSRS due drove it) or maintenance (the beat cap brought it back — mini-redo + replay). Fresh skills (never executed) have due=null: no due semantics until the first execution.",
    args: {},
    engine: "learner.skillList",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_skill_list",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "GET", path: "/skills" },
        bind: []
      }
    ]
  }),
  'skill-maintenance': command({
    id: "skill-maintenance",
    summary: "Set a skill's maintenance beat cap (days 7-365, or null to disable): the lane comes due at most this many days after the last execution, so interval growth can never drown the skill (Arthur 1998: disused motor skills decay hard — low-frequency contact itself has value). Pure entity property: the existing FSRS state is untouched.",
    args: {
      skill: { type: "string", description: "Skill id", required: true },
      days: { type: "number", description: "Cap in days (7-365); omit/null disables the cap" }
    },
    engine: "learner.skillSetMaintenance",
    domain: "学习者产出",
    channels: [
      {
        channel: "agent",
        mode: "sync",
        tool: "learnhub_skill_maintenance",
      },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/skills/maintenance" }
      }
    ]
  }),
  'understanding-add': command({
    id: "understanding-add",
    summary: "Add the learner's「我的理解」as a section-anchored self-note (E1「加我的理解」entry): the learner writes ONE explanation/example/mnemonic in their OWN words for a section they just learned; the model compares it against that section's taught points and returns verdict (对/部分对/错) + located deviations (含糊/跳跃/说错) + a \"how to fill the gap\" advice + the full markdown feedback. The verdict is archived ONLY in the E archive and the wording becomes a LearnerCard in the「我的卡」E domain (ADR-0021: reviews ride the merged review queue and earn unbound XP — totals only, never per-course ledgers) — Learner Output boundary: creating is zero XP, zero mastery/node-scheduling writes. Unparseable model feedback fails loud with zero side effects (nothing is archived, no card is created). kind: recall_cue 提示重述 (default) / cloze_rewrite 挖空重述 (content must contain a non-empty {{…}} cloze) / self_explain 自注讲解.",
    args: {
      course: { type: "string", description: "Course name", required: true },
      node: { type: "string", description: "Node name", required: true },
      content: {
        type: "string",
        description: "The learner's own wording (their understanding, in their words)",
        required: true,
        read: "fallback"
      },
      section: { type: "string", description: "Section id or title to anchor the note to (the feedback then compares against that section only)", read: "text" },
      kind: { type: "string", description: "Card face: recall_cue (default) / cloze_rewrite / self_explain", read: "text" },
      prompt: { type: "string", description: "Front prompt; a default is generated per kind when omitted", read: "text" }
    },
    engine: "learnerNoteAdd",
    domain: "学习者产出",
    channels: [
      { channel: "agent", mode: "sync", tool: "learnhub_understanding_add" },
      {
        channel: "panel",
        mode: "sync",
        route: { method: "POST", path: "/learner-add" },
        required: ["course", "node"]
      }
    ]
  }),
}
