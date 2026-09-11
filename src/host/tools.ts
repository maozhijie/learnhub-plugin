/**
 * 宿主技术层·agent 工具面（#167 自 src/index.ts 分装；ADR-0048）：
 * 111 个 defineTool 按 8 域分组注册。分组只是适配器的组织方式——注册循环（tool 助手）
 * 与每个工具的名称/描述/schema 逐字不变（快照基线 tests/fixtures/host-tools-snapshot.json，
 * 由 tests/host-runtime.test.ts 断言）；runtime 与队列一律经 HostRuntime 参数。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ANKI_ENDPOINT, AnkiConnectClient } from '../engine/index.ts'
import { applyId, bandPref, graphKind, questionCount, rejectId, requireSkipDirection } from '../tool-contracts.ts'
import { llmSeam, llmView } from './llm.ts'
import { run, stripFences } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import {
  enqueueGeneration,
  enqueueQuizGeneration,
  generateProjectMilestone,
  generateProjectPlan,
  generateSection,
  resetCourseChain,
  sessionStartCheckpoint,
  sweepGenJobs,
  triggerPlanGrowth,
  waitForQuizJob,
} from './jobs.ts'

/** Agent 独有能力在面板的说明锚点（能指南，ADR 面无此决议；#167 落回工具注册同文件维护，
 * 指南页与各页「这些事可以找 agent」提示都从这里渲染——单一事实源防文案漂移）。
 * 分流纪律：面板已有控件的动作不进指南（UI 是默认通道，agent 是进阶路径）——
 * 建课/生长/罗盘/回填/反编译/项目草案/项目创建已随面板下发退出本清单。
 * page = 面板页签（learn/graph/bank/stats/lab/generate/practice/projects/global）；
 * prompt = 可直接粘进 dsh 会话的示例指令。 */
export const AGENT_GUIDE: Array<{ tool: string; page: string; text: string; prompt?: string }> = [
  { tool: 'learnhub_pin_today', page: 'learn', text: '「今天学它」：把节点置顶为今日推荐榜首（可挂执行意图），只影响今天、次日自动失效。',
    prompt: '用 learnhub_pin_today 把「<节点>」设为今天的学习目标' },
  { tool: 'learnhub_unpin', page: 'learn', text: '取消今天的「今天学它」置顶。', prompt: '取消「<节点>」的今日置顶' },
  { tool: 'learnhub_goal_intention', page: 'learn', text: '在今日 pin 上写/清「在【线索】之后就【行动】」的执行意图（随 pin 当日过期）。',
    prompt: '给今天「<节点>」的 pin 挂一个执行意图：晚饭后就在书桌前学完它' },
  { tool: 'learnhub_note_source_exclude', page: 'learn', text: '把个人笔记文件/目录加入排除清单（未来不再被自动注册为复习源）。',
    prompt: '把「<笔记路径>」加入笔记源排除清单' },
  { tool: 'learnhub_note_source_unexclude', page: 'learn', text: '从笔记源排除清单移除（恢复可注册资格）。',
    prompt: '把「<笔记路径>」移出笔记源排除清单' },
  { tool: 'learnhub_graph_node', page: 'graph', text: '单节点深查：前置/后继/enc 边/生成状态/健康问题一次看全。',
    prompt: '用 learnhub_graph_node 深查「<节点>」' },
  { tool: 'learnhub_graph_browse', page: 'graph', text: '按区/块浏览课程图结构。', prompt: '按区块浏览「<课程>」的图结构' },
  { tool: 'learnhub_graph_path', page: 'graph', text: '查询两节点之间的先修链（学 B 之前要过哪些节点）。',
    prompt: '查一下从「<节点A>」到「<节点B>」的先修链' },
  { tool: 'learnhub_question_audit', page: 'bank', text: '题库契约只读体检：表达式/数字填空、记法违规、转义损坏、超长解析——只盘点不修复。',
    prompt: '跑一次题库体检，把违规存量题列给我' },
  { tool: 'learnhub_question_get', page: 'bank', text: '读单题全文（含答案与解析）——改题/审题前先看原题。',
    prompt: '把「<节点>」题库里 q1 的完整题目读给我看' },
  { tool: 'learnhub_bank_cleanup', page: 'bank', text: '一键清理题库：跳过节点的全部未归档题 + 已完成节点的休眠题（从未调度），预览确认后归档（可逆，不删除）。',
    prompt: '预览一下题库清理会归档哪些题，我确认后再执行' },
  { tool: 'learnhub_content_check', page: 'generate', text: '只跑正文质检门不落盘——在 vault 手改笔记后自检违规。',
    prompt: '对「<节点>」跑一次正文质检' },
  { tool: 'learnhub_data_check', page: 'global', text: '只读数据体检：盘点注册表/图/笔记/题库的 Missing 与 Broken，不修复不写入。',
    prompt: '跑一次数据体检，告诉我有没有 Broken' },
  { tool: 'learnhub_rebuild', page: 'global', text: '重建就绪清单等派生文件（过审计门；数据文件坏了后的修复入口）。',
    prompt: '重建一遍就绪清单' },
  { tool: 'learnhub_note_resolve', page: 'global', text: '把 vault 笔记路径解析到所属课程/节点（查归属用）。',
    prompt: '「<笔记路径>」属于哪个课程节点？' },
  { tool: 'learnhub_skill_create', page: 'practice', text: '创建技能条目（乐器/运动/编程等持续技能的调度 lane 载体）。',
    prompt: '创建技能条目「<技能名>」' },
  { tool: 'learnhub_execution_log', page: 'practice', text: '记一条技能执行事件（表现评级 1-4 + 真实专注时长；入 XP 账本与 streak）。',
    prompt: '记一条执行事件：今天练了「<技能>」40 分钟，自评 3 分' },
  { tool: 'learnhub_receipt_submit', page: 'practice', text: '提交外部练习回执（描述/图片/导出皆可；AI 量表评审，零 XP、不推调度）。',
    prompt: '提交一份回执：<练习内容描述>' },
  { tool: 'learnhub_receipt_list', page: 'practice', text: '查看已提交的回执清单。', prompt: '列出我提交过的回执' },
  { tool: 'learnhub_project_milestone_pass', page: 'projects', text: '里程碑显式通过结算：按 est 定价锁定 XP（对账动作，不是删除）。',
    prompt: '「<项目>」的里程碑 m1 通过了，帮我结算' },
  { tool: 'learnhub_project_milestone_recall', page: 'projects', text: '里程碑回溯会话：过点前对关联节点抽题+自述（检索点练习）。',
    prompt: '为「<项目>」的里程碑 m1 发起回溯会话' },
  { tool: 'learnhub_project_enc_candidates', page: 'projects', text: '从项目执行行为推断成分技能边候选，生成待人审图提案（面板回填按钮走的是作答记录推断，这是项目执行流推断——两条通道）。',
    prompt: '从「<项目>」的执行记录里找成分技能边候选' },
]

/** 注册全部 agent 工具（apply 装配步；名称与 schema 逐字不变，仅组织方式改为按域分组）。 */
export function registerTools(ctx: Context, rt: HostRuntime): void {
  const textOutput = {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
  }
  const tool = (name: string, description: string, parameters: Record<string, unknown>, fn: (args: never) => Promise<string>) =>
    ctx.tools.register(defineTool({
      name, description, parameters,
      output: textOutput,
      execute: fn as never,
    }) as never)

  // —— 学习（学习闭环动线 + 内容生成入队） ——
  tool('learnhub_status',
    'Return the learning center status (center summary + per-course detail) as JSON. blocked entries are executable soft-gate advice: a candidate blocked only by a decayed prerequisite carries {pre, r, due, entry} — review the prerequisite\'s due questions first (direct entry) or still learn the candidate directly. Courses may also carry diagnostics (B1 content-diagnostic suggestions): a section with concentrated wrong answers (R1 single-question lapses or R2 section accuracy <0.5 over ≥4 deduped answers) with reason, evidence, and a rewrite direct action — surface it to the learner and rewrite via learnhub_section_rewrite ONLY after they confirm (advice-first, never automatic). Evaluating diagnostics appends a trigger record to the journal when a signal fires fresh (that ledger drives the 7-day cooldown and R1 escalation); nothing else is written.',
    {}, () => run(rt, 'learnhub_status', async () => {
      sessionStartCheckpoint(rt, ctx) // 会话开始触点（agent 会话开工 = 同一面板打开语义，节流共用）
      return JSON.stringify({ ...(await rt.engine.statusJson()), llm: llmView() })
    }))
  tool('learnhub_skip',
    'Mark a node as skipped (learner already knows it) or un-skip. Skipped nodes count as passed: they leave the recommendation queue and no longer block successors. Skipping also archives every non-archived question of the node (reason=skip, ADR-0032) — reversible per question from the bank panel; un-skipping does NOT auto-restore them (restoring is the learner\'s explicit action).',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      skipped: { type: 'boolean', required: true, description: 'Explicit direction: true to skip, false to un-skip (omission is an argument error)' },
    },
    (args: { course: string; node: string; skipped?: boolean }) => run(rt, 'learnhub_skip', async () =>
      JSON.stringify(await rt.engine.nodeSkip(args.course, args.node, requireSkipDirection(args.skipped)))))
  tool('learnhub_complete',
    'Confirm a node has been learned this round. Accuracy below the passing line (0.6, with enough attempts) is rejected with accepted=false — review prerequisites or retry with force. On acceptance: unanswered bank questions get their FSRS card initialized (due tomorrow), the node stage moves to review, and a perfect-score completion earns bonus XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      force: { type: 'boolean', description: 'true to bypass the accuracy gate' },
    },
    (args: { course: string; node: string; force?: boolean }) => run(rt, 'learnhub_complete', async () =>
      JSON.stringify(await rt.engine.nodeComplete(args.course, args.node, args.force === true))))
  tool('learnhub_lesson',
    "Fetch one node's lesson pack as JSON: course body split into teaching sections (练习/反馈 excluded, 答案 merged into 例题), prereqs, and suggested next nodes. Use this to teach a node step by step.",
    {
      node: { type: 'string', required: true, description: 'Node name' },
      course: { type: 'string', required: true, description: 'Course name' },
    },
    (args: { node: string; course: string }) => run(rt, 'learnhub_lesson', async () => JSON.stringify(await rt.engine.lesson(args.course, args.node))))
  tool('learnhub_recommend',
    'Get the dynamic cross-course recommendation queue as JSON: next events (review/learning/new/struggle/diagnostic/pin) ranked by priority (overdue reviews first by days overdue and retention decay, then half-finished lessons, then new lessons by unlock count and region rotation). Each event has type/course/node/score/why. Events the learner pinned as「今天学它」carry pinned=true and lead their course for today only (tomorrow they fall back to the default order); a pinned node with no other event appears as a standalone pin event — a not-ready pinned node keeps its soft-gate hint but stays openable. Events may carry an `advice` array of executable review suggestions {node, r, due, w?}: soft-gate advice on new lessons when a prerequisite\'s retention decayed below the R gate (review that prereq\'s due questions first — you may still learn the lesson directly), and remedial advice when a node keeps struggling (review its weighted component-skill ancestors first, ranked by w×(1−R); silent when the node has no enc edges or too few recent answers). Execute an advice item with learnhub_review_queue on {course, node: advice[].node}, then learnhub_question_answer. Events may also carry a `diagnostics` array (B1 content diagnostics, standalone events typed diagnostic): a section whose content keeps failing the learner (R1 single-question repeated lapses, or R2 answer accuracy <0.5 over ≥4 deduped answers since the section was last rewritten) with reason, evidence, and a rewrite direct action {course, node, section} — after the learner confirms, execute it with learnhub_section_rewrite (gated single-section rewrite; the question bank is untouched); the Arc D per-question explain entry lives in the panel\'s error state. Practice/interaction nodes (reconsolidation-typed, D-4) may appear as type:"sleep" events or carry a sleep field {text, rehearsal}: a「睡前练、醒后验」timing suggestion with an optional mental-rehearsal note (evidence-weighted wording) — surface it with the node, never treat it as a due change; the whole layer is switchable via learnhub_sleep_config. Fetch the next batch after finishing one.',
    { limit: { type: 'number', description: 'Max events to return (default 5)' } },
    (args: { limit?: number }) => run(rt, 'learnhub_recommend', async () =>
      JSON.stringify(await rt.engine.recommend(args.limit === undefined ? 5 : args.limit))))
  tool('learnhub_pin_today',
    'Pin a node as「今天学它」(E3 goal ownership): for TODAY only it is raised to the top of its course in learnhub_recommend with a「你选了它」marker and its normal reason — a read-side ordering overlay, never a gate; pinning a not-ready node keeps the prerequisite soft-gate hint and the node stays openable. Pins expire automatically tomorrow. Optionally mount an execution intention (C-5): pass cue AND action to attach an if-then plan「在【时间/地点锚】之后【单一具体行动】」— the format is locked to a stable cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence; Gollwitzer & Sheeran 2006). The intention rides the pinned recommend event and the panel, and expires with the pin. Learner Output: zero effect on scheduling, mastery, or XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must exist in the course graph)' },
      cue: { type: 'string', description: 'Execution-intention cue (stable time/place anchor, e.g. 早上刷完牙后) — required together with action' },
      action: { type: 'string', description: 'Execution-intention action (ONE concrete action, verb-first) — required together with cue' },
    },
    (args: { course: string; node: string; cue?: string; action?: string }) => run(rt, 'learnhub_pin_today', async () =>
      JSON.stringify(await rt.engine.pinToday(args.course, args.node, undefined, { cue: args.cue, action: args.action }))))
  tool('learnhub_goal_intention',
    'Set or clear an execution intention (C-5 if-then plan) on TODAY\'s「今天学它」pin for a node: pass cue AND action to write「在【时间/地点锚】之后【单一具体行动】」— format locked to a stable time/place cue + ONE concrete action (multi-step chains and vague cues fall outside the evidence); pass neither to clear it. The intention lives on the pin (goal preference), covers the recommendation read side only, and expires with the pin tomorrow — it has no life of its own. Surface it from learnhub_recommend events (pinned events carry an intention {cue, action}). Fails loud if the node has no pin today. Learner Output: zero effect on scheduling, mastery, or XP.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must have a pin today)' },
      cue: { type: 'string', description: 'Execution-intention cue (stable time/place anchor) — omit cue AND action to clear' },
      action: { type: 'string', description: 'Execution-intention action (ONE concrete action, verb-first) — omit cue AND action to clear' },
    },
    (args: { course: string; node: string; cue?: string; action?: string }) => run(rt, 'learnhub_goal_intention', async () =>
      JSON.stringify(await rt.engine.setGoalIntention(args.course, args.node, { cue: args.cue, action: args.action }))))
  tool('learnhub_unpin',
    'Cancel a「今天学它」pin: the node returns to the default recommendation order immediately.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run(rt, 'learnhub_unpin', async () =>
      JSON.stringify(await rt.engine.unpinToday(args.course, args.node))))
  tool('learnhub_review_queue',
    'List the cross-course due review cards as JSON (Anki-style; answers omitted — answer with learnhub_question_answer, self-rate Hard/Good/Easy after correct replies). Omit filters for the whole queue: cards sort by predicted recall risk R ascending (r carried per card). Note-source cards (C1) ride the same queue with source:"note" and course=笔记源 (node = source id) — answer/rate/forget them through the SAME learnhub_question_answer / learnhub_question_rate / learnhub_question_forget calls; note_drifted (content changed — offer regenerate/archival) and note_suspended (missing source or broken mirror) summaries ride the response; suspended cards never block course cards. Pass course and/or node for TARGETED review — the direct entry that recommendation/status advice items point to (A3 soft-gate prerequisite review and enc component-skill remediation): {course, node} returns exactly that node\'s due questions. A single-node session is ADAPTIVELY ordered (A1 difficulty tuning): cards carry a combined difficulty scalar d and the response carries the node-mastery start band — present cards nearest that band first; during the session shift the band up one step after every second consecutive correct answer and drop it back toward the base after a wrong/forgot, re-picking the nearest-d remaining card each time. band_pref (E5) is the learner\'s explicit difficulty choice as a weighted preference on that start band: hard raises it, easy relaxes it, omit for pure A1 — the anti-frustration drop-back still applies. Cards flagged jol=true are the sampled JOL probe (E4): before revealing the answer you may ask the learner for a one-tap prediction (会/不会/没把握) and pass it back as the predicted field on learnhub_question_answer / learnhub_question_forget — skippable, never blocking. A `calibration_hint` string riding the response (Self-Calibration, ADR-0022) means the learner\'s「会」predictions have run systematically low on actual accuracy: surface it verbatim next to the JOL probe as a gentle, non-blocking expectation-management nudge — never turn it into a score or a gate (the learner can disable it globally). Unknown node names fail loud.',
    {
      course: { type: 'string', description: 'Course name; omit for all enabled courses' },
      node: { type: 'string', description: 'Node name filter — targeted review of this node\'s due questions (A3 advice direct entry; adaptive difficulty order)' },
      band_pref: { type: 'string', description: 'Learner\'s explicit difficulty band (E5): easy/standard/hard as a weighted preference on the A1 start band' },
    },
    (args: { course?: string; node?: string; band_pref?: string }) => run(rt, 'learnhub_review_queue', async () =>
      JSON.stringify(await rt.engine.reviewQueue(args.course, args.node, undefined, bandPref(args.band_pref)))))
  tool('learnhub_question_answer',
    'Answer one bank question (flashcard model): auto-judged 1.0/0.0 (reflection graded by AI against its rubric); the result drives THAT question\'s FSRS schedule (correct=Good, wrong=Again). Node mastery is purely derived (masteryOfFm: 0.7 x memory-stability progress + 0.3 x practice-evidence EMA); per-question answer stats only feed the completion gate, not mastery. predicted (E4 JOL) records the learner\'s pre-answer one-tap prediction (会/不会/没把握) from a jol-flagged probe card — omit when not asked.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
      answer: { type: 'string', required: true, description: 'User answer (choice: letter, multi_choice: comma-joined letters; true_false: 对/错; fill_in_blank: text; numeric: number; ordering/matching: newline-joined item texts in submitted order; reflection/open_question: free text)' },
      predicted: { type: 'string', description: 'Learner\'s pre-answer JOL prediction (E4): 会 / 不会 / 没把握' },
    },
    (args: { course: string; node: string; qid: string; answer: string; predicted?: string }) => run(rt, 'learnhub_question_answer', async () =>
      JSON.stringify(await rt.engine.questionAnswer(
        llmSeam(ctx), args.course, args.node, args.qid, args.answer,
        null, { ...(args.predicted !== undefined ? { predicted: args.predicted as never } : {}) }))))

  tool('learnhub_generate',
    'Queue one course note for generation via the global serial queue: outline first (the model decides section split, order, and types from the content, topic, and style — no fixed structure), then one model call per section through the quality gates as a draft (ready sections are skipped, so retrying resumes the pipeline), then per-section + synthesis quiz questions. Returns immediately with a queue position; at most one node pipeline runs at a time (check the gen-jobs registry tool or panel generate tab for progress). The context pack (prereqs, domain boundary, forbidden concepts) and user-editable prompt templates (state/提示词/课程大纲.md, 课程节生成.md) drive the calls. Missing notes are scaffolded first (on-demand lesson semantics). style selects a per-section prompt variant (课程节生成-<style>, e.g. 苏格拉底/费曼) applied to every section call; the outline and gates stay on the default path.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name to generate' },
      style: { type: 'string', description: 'Prompt style variant; omit for the default template' },
    },
    (args: { course: string; node: string; style?: string }) => run(rt, 'learnhub_generate', () =>
      enqueueGeneration(rt, ctx, args.course, args.node, args.style)))
  tool('learnhub_section_rewrite',
    'Rewrite ONE section of a node through the model — the same gated pipeline as the panel section-rewrite: section task context → model → quality gates → one repair round on gate failure → surgical reassembly of that section (section version +1, node content back to draft; the question bank, FSRS cards, and schedules are untouched). This is the direct action for B1 content-diagnostic suggestions (learnhub_recommend/status diagnostics: R1 single-question repeated failure, R2 section answer-accuracy collapse). Diagnostics are advisory — confirm with the learner before calling; never rewrite a section nobody asked about. Synchronous: a section typically takes tens of seconds.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      section: { type: 'string', required: true, description: 'Section id from the node manifest (e.g. "s2") — exactly what diagnostics[].rewrite.section carries' },
    },
    (args: { course: string; node: string; section: string }) => run(rt, 'learnhub_section_rewrite', async () =>
      generateSection(rt, ctx, args.course, args.node, args.section)))
  tool('learnhub_coach',
    'Get the「可用的困难」coach feedback (E5, read-only informational, no gates or scoring): checks the last 7 days of the learner\'s difficulty-band session choices and in-band performance. All-easy streak with due questions their FSRS state says they should know → a gentle nudge to try the standard band; consistent challenge-band struggle (accuracy below 0.6) → a pointer back to prerequisite/component-skill review. Low data stays silent. Surface messages verbatim when present; never force anything.',
    {},
    () => run(rt, 'learnhub_coach', async () => JSON.stringify(await rt.engine.coachAdvice())))
  tool('learnhub_calibration_profile',
    'Get the Self-Calibration profile (ADR-0022, #104) as JSON: per-source slices of learner self-assessment × objective outcome pairs (v1 source "jol" = JOL prediction × actual answer; more sources land via the pairing contract). Each source carries calibration bins (per-prediction actual accuracy, shown only at >=10 sampled pairs — below the gate it is null, never fabricated) and an overconfidence verdict with evidence (the「会」bin\'s n / actual accuracy / threshold). `global` merges sources as a REFERENCE view only — domain-specific components are significant, so always present it together with its warning and treat the per-source slices as authoritative. When a source is overconfident and hints are enabled, review-queue responses ride a `calibration_hint` string: surface it verbatim at the self-assessment exit as a gentle nudge (see learnhub_review_queue); JOL probe density is then boosted (1/3 → 1/2) automatically. Read-only derivation: this NEVER discounts learner self-assessment driving canonical state — FSRS ratings pass through untouched and nothing feeds Mastery/XP. Never present it as a personality trait or a score.',
    {},
    () => run(rt, 'learnhub_calibration_profile', async () => JSON.stringify(await rt.engine.calibrationProfile())))
  tool('learnhub_sleep_config',
    'Get or set the sleep-coupled scheduling advice layer (D-4). When enabled (default), recommendations for reconsolidation-type nodes (practice/interaction nodes, e.g. instrument or sport practice) carry a「睡前练、醒后验」timing suggestion — practice briefly before sleep, verify retention right after waking (Walker 2002/2005) — plus an optional mental-rehearsal note (small effect r≈0.13, expectation-managed wording). Read-side advice only: it never changes scheduling semantics, due dates, mastery, or XP. Omit enabled to read the current config.',
    { enabled: { type: 'boolean', description: 'true/false to turn the sleep advice layer on/off; omit to read current config' } },
    (args: { enabled?: boolean }) => run(rt, 'learnhub_sleep_config', async () =>
      JSON.stringify(args.enabled === undefined
        ? await rt.engine.sleepAdviceConfig()
        : await rt.engine.setSleepAdviceConfig({ enabled: args.enabled }))))

  // —— 图谱（图结构/提案/概念登记/罗盘/vault 链接先验） ——
  tool('learnhub_graph_analyze',
    'Analyze a course knowledge graph: structural stats, unreachable nodes, bottlenecks, lapse hotspots, graph health score (0-100, see health), next-batch suggestions (suggestions.expand_blocks/missing_pre/unconverged, plus jump_candidates + jump_total — cognitive-jump edges needing a verdict each — and merge_blocks), the full per-node schema (schema: pre/enc/est/bloom/difficulty/note per node — the data basis for edge-level self-checks), plus cytoscape render elements. Returns JSON. Run before planning each batch of graph edits; the next-batch plan must cite concrete entries from health/suggestions.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      elementsOnly: { type: 'boolean', description: 'Only output cytoscape render elements (nodes/edges)' },
    },
    (args: { course?: string; elementsOnly?: boolean }) => run(rt, 'learnhub_graph_analyze', async () =>
      JSON.stringify(await rt.engine.graphAnalyze(args.course, args.elementsOnly))))
  tool('learnhub_graph_node',
    'Inspect one graph node in depth: schema field values (pre/est/type/bloom/difficulty/note), direct successors, enc component-skill edges with weights and notes, block placement, learning stage/content status, and the full transitive prerequisite closure (sorted deepest-first). Use to drill into a single node without pulling the whole graph.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course?: string; node: string }) => run(rt, 'learnhub_graph_node', async () =>
      JSON.stringify(await rt.engine.graphNode(args.course, args.node))))
  tool('learnhub_graph_browse',
    'Browse a course graph by region and/or block: node listings with depth/stage/est/difficulty/type/content status. Omit both filters to list every region (structure overview); give region (and optionally block) to explore one area. A block without a region succeeds only when exactly one block with that name exists; zero matches or ambiguity across regions fails with the matching region list so you can add the region filter. Unknown regions/blocks fail loud with valid names.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      region: { type: 'string', description: 'Region name filter' },
      block: { type: 'string', description: 'Block name filter (requires region when ambiguous)' },
    },
    (args: { course?: string; region?: string; block?: string }) => run(rt, 'learnhub_graph_browse', async () =>
      JSON.stringify(await rt.engine.graphBrowse(args.course, args.region, args.block))))
  tool('learnhub_graph_path',
    'Ask whether one node is a (transitive) prerequisite of another and via which chain: returns related, direct, the BFS shortest chain from→…→to, the full prerequisite-closure size of `to`, and the depth span. Use for teaching-path planning and for explaining why something is locked.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      from: { type: 'string', required: true, description: 'Candidate prerequisite node' },
      to: { type: 'string', required: true, description: 'Target node' },
    },
    (args: { course?: string; from: string; to: string }) => run(rt, 'learnhub_graph_path', async () =>
      JSON.stringify(await rt.engine.graphPath(args.course, args.from, args.to))))
  tool('learnhub_graph_propose',

    'Submit a graph proposal. Schema quick reference — write YAML strictly to this, wrong key names are rejected. kind=seed (#142) is the NEW-COURSE ENTRY: 1-3 start nodes + one endpoint node — starts must be SINGLE-BEHAVIOR units a zero-basis learner can step onto from common knowledge, with ZERO compound/blanket concepts (「Python 基础语法」-style blanket names fail as starts; compound content belongs to the growth path, ADR-0040); the engine lands coarse placeholder edges (endpoint.pre = starts), one human review then the course starts. Seed nodes carry ZERO enc and ZERO est (rejected if declared); goal_type defaults to capability (completion = endpoint mastery + closure health) — coverage must be explicit AND carry a non-empty worksheet list ({block, note?, done?}; capability+worksheet is rejected). mode=new requires the course NOT be registered (the engine scaffolds the registry entry + dirs on apply); mode=reseed requires it — endpoint change / worksheet update of an existing course, the ONLY anchor-edit channel (no direct anchor writes; the endpoint-anchored node is also guarded: del_node/rename via kind=edit are rejected). Start entries may declare basis: baseline (common knowledge start) / vault (prior familiarity boundary) / project (decompiled cluster; goal decompilation #149 stamps it automatically on the starts it files). Seed node keys: name/region/block/note?/bloom?/difficulty?/teaches?/assumes?/misconceptions?. kind=edit (per batch) top-level keys: course; reason?; concepts? ([{canonical, aliases?, definition?}] — concept-registry minting block, #141: names land in 课程根/概念登记表.yaml with the SAME apply transaction, nothing written while the proposal is pending/rejected); ops[] — add_node defines a new node via key `name` (unified with graph YAML in schema v2; the old `node` key is rejected): add_node{name, region, block, pre, est? (minutes, positive), bloom? (记忆/理解/应用/分析/评价/创造), difficulty? (1-5), type?: practice, note?, enc?, teaches? ({concept: 知道|会用|能教}, 1-8), assumes? ({concept: tier}, 3-10 when present), misconceptions? ([{concept, model}], ≤3 per concept course-wide)}; every other op targets an existing node via key `node`: set_pre{node, pre} replaces the whole pre set (pre is required, [] to clear); set_enc{node, enc} replaces the whole enc list ([skill] or [{node, w, note}]; enc is required, [] to clear); del_node{node}; rename{node, new}; move{node, region, block}; set_note{node, note}. Generation-time discipline the gates cannot check (ADR-0040): each add_node is ONE independent learning act — self-question whether a zero-basis learner could pick it up from its pre within 30 minutes, else split or add a prerequisite first; most names are action sentences (解/求/推导…, no「理解导数」-style level-unclear near-duplicates, no blanket compounds); pre is the COMPLETE direct-prerequisite set (no transitive padding); give every new pre edge a necessity verdict (delete-the-edge test: no concrete failure point = redundant, drop it). Edge-light rule: graph YAML carries ZERO edge metadata — candidate edges stay in the proposal, insertion origin derives from the proposal journal, probation lives in state/边实验.jsonl (fields like origin/status/probation are rejected). Growth-batch note region (#145/#146): note{operator: 前进|插入|巩固|旁支|换向, reason, disagreement?, recheck?} marks the batch as a coach-round verdict; an insertion batch (operator=插入 with add_node ops) MUST preregister its recheck — note.recheck{metric: 前进恢复|卡点集中度降幅|保留率恢复 (exactly one, same source as the symptom), days? (learning days, default 10, clamped to [5,20] with a warn)} — the engine auto-adjudicates at expiry (proven, or auto-prune via del_node + coarse-edge restore, zero human review); recheck on non-insertion batches is rejected, and insertion batches are gate-throttled when the recheck pass rate bottoms out or the insertion/side-branch share exceeds its cap. Batch `pre` may only reference existing nodes or nodes created earlier in the same batch. Concept-reference gate (#141): every concept named in teaches/assumes/misconceptions must be registered in the course concept registry (canonical or alias, exact match) OR minted in the same proposal\'s concepts block — unregistered names are rejected with the missing list; minting a name that already exists is rejected too (reference the entry, or merge via learnhub_concept_merge after human confirmation). Prior feed (#142): vault-link candidates with w≥0.7 mapped to the proposal\'s nodes that the structure does NOT explicitly answer (no pre/enc edge between the pair) come back in warns (non-blocking) — answer them with real edges, or let a vault rescan drop them; zero priors is a legal normal path. Keep pre-edge cognitive jumps (difficulty gap >= 2 or depth span >= 3) off the graph or expect R13 jump-candidate warnings. Schema + structure gates reject bad YAML with actionable errors (including dangling enc edges and misconception cap breaches). In growth batches apply edit proposals immediately after gates pass (anchor-review model, ADR-0003); seed proposals wait for the one human review.',

    {
      kind: { type: 'string', required: true, description: '"seed" (new-course entry or endpoint change — one human review) or "edit" (change ops) or "enrich" (overlay backfill)' },
      yaml: { type: 'string', required: true, description: 'Full proposal YAML text (SeedProposal / EditProposal / EnrichProposal schema)' },
    },
    (args: { kind: string; yaml: string }) => run(rt, 'learnhub_graph_propose', async () =>
      JSON.stringify(await rt.engine.graphPropose(graphKind(args.kind), args.yaml))))
  tool('learnhub_graph_proposals',
    'List graph proposals by status — use status=pending to see what awaits human review in the panel, with the proposal id, course, reason, and op summary. After the user decides in the panel, apply with learnhub_graph_apply using that id.',
    {
      status: { type: 'string', description: 'Filter by status (default pending; e.g. applied/rejected)' },
      kind: { type: 'string', description: 'Filter by kind: edit / seed / enrich / project_plan / project_milestone / experiment' },
    },
    (args: { status?: string; kind?: string }) => run(rt, 'learnhub_graph_proposals', async () =>
      JSON.stringify(await rt.engine.graphProposals(args.status, args.kind))))
  tool('learnhub_graph_enc_backfill',
    'Backfill enc (component-skill) edges for a course via the enrichment-overlay channel (#140, weight semantics #148): every non-practice node with ready content whose note body / exercise metadata declares enc_candidates or whose bank questions invoke prereq-taught concepts (invokes-coverage projection) that are not yet declared as enc becomes one field entry (whole-replace enc). Weights = the invokes-coverage projection (share of the node\'s questions invoking concepts taught by that prereq; candidate edges without invokes data land the schema-default weight 1 — the old call-site ladder is retired). Queued as a SINGLE pending enrich proposal with sha256 fingerprints of the canonical region files. Nothing changed returns ops=0. Re-runnable — already-covered nodes produce no entries; practice nodes keep legal empty enc. Use for the A3 pilot when enabling that course, then review/apply with learnhub_graph_apply(kind=enrich).',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run(rt, 'learnhub_graph_enc_backfill', async () =>
      JSON.stringify(await rt.engine.graphEncBackfill(args.course))))
  tool('learnhub_vault_links_scan',
    'Scan the WHOLE vault (outside the learning center; dot-dirs, built-in attachment/archive dirs 99附件/05ob自定义/00类型/03属性/过时*, and the user note-source exclusion list skipped — the built-in list can be replaced via vault_link_excludes in learnhub.json) for [[wikilinks]] between personal notes and produce de-noised UNDIRECTED association pairs with confidence w∈[0,1] (enc-edge weight convention): embeds ![[…]], non-.md targets (.base/.png/…), diary date targets, unresolved targets, self-links and code-fence examples are filtered, each with a hit-count audit (nothing silently dropped). READ-ONLY on personal notes — the cache lands in the engine state dir (state/vault链接.json with per-file fingerprints for drift/rescan); pure file scanning, no host search API. Pair confidence tiers: w≥0.7 proposal-ready (learnhub_graph_link_backfill), 0.4–0.7 shown in learnhub_graph_analyze suggestions.vault_link_candidates for human adjudication, <0.4 report-only. Run before graph analysis to surface vault link priors.',
    {},
    () => run(rt, 'learnhub_vault_links_scan', async () =>
      JSON.stringify(await rt.engine.vaultLinksScan())))
  tool('learnhub_graph_link_backfill',
    'Turn vault link priors into enc candidate edges (V-2 #91) via the enrichment-overlay channel (#140): mapped pairs with w ≥ 0.7 whose direction resolves INSIDE the pre-transitive-closure become field entries (whole-replace enc; declared enc preserved, new edges noted with the source link evidence for traceability), queued as a SINGLE pending enrich proposal per course with sha256 fingerprints of the canonical region files. Pairs without a pre relation are NOT forced (enc contract/E7: enc target must sit in the holder\'s prereq closure) — they come back as blocked_no_pre with a why, for you to add pre edges explicitly or drop. Re-runnable; already-declared edges are skipped. Requires learnhub_vault_links_scan to have run (fails loud with a pointer otherwise). Review/apply with learnhub_graph_apply(kind=enrich).',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run(rt, 'learnhub_graph_link_backfill', async () =>
      JSON.stringify(await rt.engine.graphLinkBackfill(args.course))))
  tool('learnhub_graph_apply',
    'Decide a pending graph proposal: apply (audit-gated, writes data/*.yaml with rename linkage + journal + snapshot; kind=enrich re-checks the sha256 content fingerprints and refuses stale proposals; kind=seed lands the endpoint anchor state/终点锚.json + start/endpoint nodes with coarse placeholder edges, seed graphs get the shape-warning & health-threshold exemption) or reject (kept on record). Seed proposals (kind=seed) are the new-course entry and the ONLY endpoint-change channel — they always wait for the one human review. In edit batches the agent applies directly after gates pass; revision changes wait for human review first (ADR-0003). The apply result carries findings: audit warns plus a health-score hint when below the quality baseline (suppressed while the graph is still just the seed) — address them in the next batch.',
    {
      kind: { type: 'string', required: true, description: '"seed" (course entry / endpoint change) or "edit" (change ops) or "enrich" (overlay backfill)' },
      id: { type: 'number', description: 'Proposal id as a positive integer; omit only for the latest pending of this kind' },
      reject: { type: 'boolean', description: 'true to reject instead of apply' },
      note: { type: 'string', description: 'Rejection reason (recorded)' },
    },
    async (args: { kind: string; id?: number; reject?: boolean; note?: string }) =>
      run(rt, 'learnhub_graph_apply', async () => {
        if (args.reject) {
          const id = rejectId(args.id)
          await rt.engine.graphReject(id, args.note ?? '')
          return `[reject] 提案 #${id} 已拒绝留痕。`
        }
        const r = await rt.engine.graphApply(graphKind(args.kind), applyId(args.id))
        // 编辑批可含 del_node/rename（ADR-0039 写侧联动）：apply 出口同步清扫注册表
        await sweepGenJobs(rt)
        return JSON.stringify(r)
      }))
  tool('learnhub_concept_merge',
    'Merge one concept-registry entry into another (概念登记表 #141, human-decision surface): the absorbed entry disappears and ALL of its names (canonical + aliases) become aliases of the surviving entry, so every historical address keeps resolving — entries are never deleted, only merged. Use when the same concept was minted twice under different names (same meaning, confirmed by the learner); deepening a concept to a higher tier REUSES the same entry and is NOT a merge. Journal-tracked; the registry file is 课程根/概念登记表.yaml.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      from: { type: 'string', required: true, description: 'Name (canonical or alias) of the entry to absorb' },
      into: { type: 'string', required: true, description: 'Name (canonical or alias) of the surviving entry' },
    },
    (args: { course: string; from: string; into: string }) => run(rt, 'learnhub_concept_merge', async () =>
      JSON.stringify(await rt.engine.conceptMerge(args.course, args.from, args.into))))
  tool('learnhub_compass',
    'Read a course compass (罗盘, ADR-0033 transparency device #143): the resident non-commitment route sketch at the course root — current 剩余路线 (route, coach-owned, rewritten per growth batch), the learner annotation area (软输入: read it before planning growth batches; proposals, never orders), and the weekly sandbox ETA (quantile bands, 模型推演非承诺). Missing file = legal empty state (course not seeded yet). This file NEVER enters completion criteria or any authority — do not treat hand-edited routes as structure changes.',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run(rt, 'learnhub_compass', async () =>
      JSON.stringify(await rt.engine.compassRead(args.course))))
  tool('learnhub_compass_paint',
    'Paint (or repaint) the compass initial route (罗盘初画 #143): ONE deep-effort model call with the 罗盘初画 prompt template — endpoint anchor, seed graph, worksheet (coverage) and existing learner annotations (soft input) go in; ONLY the 剩余路线 section is rewritten (annotations preserved byte-for-byte, ETA reset for the weekly refresh). The route is a non-commitment sketch: stages toward the endpoint, candidate steps marked (候选), no time promises. Run right after a seed apply (the apply lands the scaffold with a 待初画 placeholder) and after a reseed; a route failing the format gate (non-empty, no ## headings, length cap) leaves the compass untouched. Completion criteria never read this file.',
    { course: { type: 'string', description: 'Course name; omit when only one course is enabled' } },
    (args: { course?: string }) => run(rt, 'learnhub_compass_paint', async () =>
      JSON.stringify(await rt.engine.compassPaint(args.course, llmSeam(ctx)))))

  // —— 题库（出题/修订/体检/清理/难度建议） ——
  tool('learnhub_question_audit',
    'Read-only content audit of all question banks (course banks + note-source mirror). Flags legacy questions that violate current contracts: fill_in_blank answers that look numeric or algebraic (ADR-0029 unique-answer blanks), notation violations in stem/options/explanation (bare ^ or _ outside $...$, LaTeX commands without $ delimiters), YAML double-quote escape corruption (control characters), and over-long explanations. Returns a JSON findings list; never repairs or writes.',
    {}, () => run(rt, 'learnhub_question_audit', async () => JSON.stringify(await rt.engine.questionAudit())))
  tool('learnhub_question_generate',
    'Generate quiz questions for a node via the model — queued as a quiz job on the global serial generation queue (mutually exclusive with the node content pipeline, so bank writes never interleave) and this call WAITS for the job to finish, then returns the result: node body → question prompt → llm → validateBank gate appends every question to the bank. The prompt lists the node\'s existing question stems and the engine drops generated questions that duplicate or closely resemble them (reported as duplicates). Birth tagging (#148): when the course concept registry scope (node teaches ∪ prereq-closure teaches) is non-empty every question must carry exactly ONE invokes concept — a missing tag gets one repair pass, still-empty questions are rejected and reported; the result\'s `enc` field carries the invokes-coverage projection (birth weights over prereq nodes, share of questions invoking each) — carry those into the next growth batch via set_enc whole-replace. Use when a node has no/too few questions. Progress is visible in the gen-jobs registry / panel generate tab while it waits.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must have generated content)' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { course: string; node: string; count?: number }) => run(rt, 'learnhub_question_generate', async () => {
      const n = questionCount(args.count)
      const { key } = enqueueQuizGeneration(rt, ctx, args.course, args.node, { count: n })
      const job = await waitForQuizJob(rt, key)
      if (job.status === 'cancelled') return JSON.stringify({ status: 'cancelled', message: job.message })
      if (job.status !== 'done') throw new Error(job.message || `出题任务终态 ${job.status}`)
      const r = rt.jobs.quizJobResults.get(key)
      rt.jobs.quizJobResults.delete(key)
      return JSON.stringify({
        status: job.status, message: job.message,
        ...(r ? {
          course: r.course, node: r.node, added: r.added, skipped: r.skipped, total: r.total,
          duplicates: r.duplicates, rejected: r.rejected, enc: r.enc,
        } : {}),
      })
    }))
  tool('learnhub_question_update',
    'Update one bank question: patch merges into the stored question with a strict authoring whitelist (q/options/answer/explanation/difficulty/section/uses/tags/tol) and the whole bank re-validates before writing. Empty patches, unknown fields, and id/kind/node/fsrs/stats/archived keys are rejected. Archiving is a separate operation: send the patch {archived:true|false} as the only key to route to the archive endpoint; mixing archive with content edits fails instead of partially applying. learnhub_question_list omits answers — take corrections from the user or the note content, not from thin air.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
      patch: { type: 'object', additionalProperties: true, required: true, description: 'Authoring fields to merge ({"answer":"A",...}), or {"archived":true} alone for archive' },
    },
    (args: { course: string; node: string; qid: string; patch: Record<string, unknown> }) => run(rt, 'learnhub_question_update', async () => {
      if ('archived' in args.patch) {
        const archived = args.patch.archived
        if (typeof archived !== 'boolean') {
          throw new Error('[question-update] archived 必须是布尔值（archive/restore 独立操作）')
        }
        const rest = Object.keys(args.patch).filter(k => k !== 'archived')
        if (rest.some(k => k !== 'reason')) {
          throw new Error('[question-update] 归档与内容修订是两条独立操作，混合 patch 会被整体拒绝（先归档，或先改内容再单独归档）')
        }
        const reason = typeof args.patch.reason === 'string' ? args.patch.reason : undefined
        await rt.engine.questionArchive(args.course, args.node, args.qid, archived, reason)
        return JSON.stringify({ course: args.course, node: args.node, qid: args.qid, archived })
      }
      return JSON.stringify(await rt.engine.questionUpdate(args.course, args.node, args.qid, args.patch))
    }))
  tool('learnhub_question_get',
    'Read one bank question in full, including answer, explanation, difficulty, section, and uses — the revision/authoring companion to learnhub_question_list (which omits answers on purpose for the answering flow). Read the original before correcting a question with learnhub_question_update.',
    {
      course: { type: 'string', description: 'Course name; omit when only one course is enabled' },
      node: { type: 'string', required: true, description: 'Node name' },
      qid: { type: 'string', required: true, description: 'Question id inside the bank, e.g. "q1"' },
    },
    (args: { course?: string; node: string; qid: string }) => run(rt, 'learnhub_question_get', async () =>
      JSON.stringify(await rt.engine.questionGet(args.course, args.node, args.qid))))
  tool('learnhub_question_list',
    'List the question-bank questions of a node as JSON (no answers). Bank files live at <课程根>/题库/<节点>.yaml; kinds: single_choice / true_false / fill_in_blank / multi_choice / numeric / ordering / matching / reflection / open_question.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run(rt, 'learnhub_question_list', async () =>
      JSON.stringify(await rt.engine.questions(args.course, args.node))))
  tool('learnhub_question_save',
    'Save a question bank for a node: validates the Bank YAML (node/kind/q/answer per kind: single_choice needs options + letter answer; multi_choice options + letter array; true_false boolean; fill_in_blank accepted answers; numeric numeric answer + optional tol; ordering options + ordered answer items; matching left-column options + paired right-column answers; reflection grading rubric; open_question reference points) then writes <课程根>/题库/<节点>.yaml.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name (must match the node field inside the YAML)' },
      yaml: { type: 'string', required: true, description: 'Bank YAML text (node/questions[id,kind,q,answer,options?,explanation?,difficulty?,uses?])' },
    },
    (args: { course: string; node: string; yaml: string }) => run(rt, 'learnhub_question_save', async () =>
      JSON.stringify(await rt.engine.questionSave(args.course, args.node, args.yaml))))
  tool('learnhub_difficulty_advice',
    'Detect difficulty-mismatch advice across question banks (B2, read-only, advice-first — nothing is written): nodes in review/mastered with low derived mastery + struggling answer accuracy + enough answer volume get a "difficulty band miscalibrated, regenerate" suggestion carrying a difficulty/bloom target-band instruction (feed it to learnhub_question_generate or the section-rewrite flow, validateBank gate applies); individual questions whose scheduling evidence says "too easy" (enough FSRS advances with zero lapses and an interval grown past the threshold — same-day repeats never count) get a "too easy, archivable" annotation (archiving is the author/panel decision via learnhub_question_update archived patch — never silent removal). Responses already dismissed by the learner are filtered out (dismissed count returned). Low data stays silent.',
    { course: { type: 'string', description: 'Course name; omit to scan all enabled courses' } },
    (args: { course?: string }) => run(rt, 'learnhub_difficulty_advice', async () =>
      JSON.stringify(await rt.engine.difficultyAdvice(args.course))))
  tool('learnhub_bank_cleanup',
    'One-click question-bank housekeeping (ADR-0032, archive-only — never deletes). Preview (default): per node, every non-archived question of skipped nodes plus every dormant question (in bank, never scheduled) of completed review/mastered nodes, grouped with counts and stem excerpts. With apply=true: archives exactly those candidates with reason=cleanup — reversible from the bank panel (restore filter). Always run the preview first and tell the learner what will be archived before applying.',
    {
      course: { type: 'string', description: 'Course name; omit to scan all enabled courses' },
      apply: { type: 'boolean', description: 'omit/false = read-only preview; true = archive the candidates (reason=cleanup)' },
    },
    (args: { course?: string; apply?: boolean }) => run(rt, 'learnhub_bank_cleanup', async () =>
      JSON.stringify(args.apply === true
        ? { applied: await rt.engine.bankCleanupApply(args.course) }
        : await rt.engine.bankCleanupPreview(args.course))))

  // —— 项目（P 区姊妹实体：计划/里程碑/反编译/执行） ——
  tool('learnhub_project_create',
    'Create a project (P-area first-class entity, Course\'s SISTER not a node): a real-world practice the learner is actually doing, measured in weeks/months. Writes 学习中心/projects/<id>/项目.md (frontmatter: lifecycle=active, fading tier 骨架/补全/独立 default 补全, goal prose, empty plan). Projects carry ZERO XP, ZERO FSRS, never enter sessions/srs/review queue — node consumers are untouched. After creating, draft the milestone plan with learnhub_project_plan_generate.',
    {
      name: { type: 'string', required: true, description: 'Project name (also becomes the workspace id)' },
      goal: { type: 'string', required: true, description: 'Learner\'s goal description prose (plan drafting input)' },
      tier: { type: 'string', description: 'Fading tier: 骨架/补全/独立 (default 补全)' },
    },
    (args: { name: string; goal: string; tier?: string }) => run(rt, 'learnhub_project_create', async () =>
      JSON.stringify(await rt.engine.projectCreate({
        name: args.name, goal: args.goal,
        ...(args.tier !== undefined ? { tier: args.tier as never } : {}),
      }))))
  tool('learnhub_project_list',
    'List all projects as JSON (id/name/lifecycle/tier/plan size). Projects are the bounded project area: real practice with milestone plans, separate from course nodes.',
    {},
    () => run(rt, 'learnhub_project_list', async () => JSON.stringify(await rt.engine.projectList())))
  tool('learnhub_project_show',
    'Show one project in full: frontmatter (lifecycle/tier/goal/plan) plus per-milestone artifact status (generated or not, file name) and orphan files left by past plan revisions.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run(rt, 'learnhub_project_show', async () =>
      JSON.stringify(await rt.engine.projectShow(args.id))))
  tool('learnhub_project_log',
    'Read a project\'s log (V-5): the learner\'s free-form working journal at 学习中心/projects/<id>/日志.md — dated entries of what they did, where they got stuck, what they learned. Null when never written (legal empty state, no file is created by reading). The log may be REGISTERED as a Note Source (learnhub_note_source_register with the log path) so its content becomes reviewable — the engine only ever reads it.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run(rt, 'learnhub_project_log', async () =>
      JSON.stringify(await rt.engine.projectLog(args.id))))
  tool('learnhub_project_log_append',
    'Append one dated entry to a project\'s log (V-5): the learner\'s own record of real project work — progress, blockers, decisions, learnings. Entries are learner-authored prose; engine bookkeeping (plan revisions, receipts mirror, exec events) lives in its own files and never pollutes the log. The engine refreshes the registered fingerprint after writing (its own writes are not content drift).',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      text: { type: 'string', required: true, description: 'Entry body (non-empty prose; multiple paragraphs/lines fine)' },
    },
    (args: { id: string; text: string }) => run(rt, 'learnhub_project_log_append', async () =>
      JSON.stringify(await rt.engine.projectLogAppend(args.id, args.text))))
  tool('learnhub_project_lifecycle',
    'Set a project\'s lifecycle: active/paused/delivered/archived. No irreversible transitions (ADR-0015) — delivered/archived projects can reopen to active; a no-deadline project may legally stay active forever. Pure status change: no XP settle, no scheduling effect.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      lifecycle: { type: 'string', required: true, description: 'active/paused/delivered/archived' },
    },
    (args: { id: string; lifecycle: string }) => run(rt, 'learnhub_project_lifecycle', async () =>
      JSON.stringify(await rt.engine.projectSetLifecycle(args.id, args.lifecycle))))
  tool('learnhub_project_tier',
    'Set a project\'s fading tier (骨架/补全/独立): how much support NEW milestone artifacts get (near-complete demonstration → partial product with gaps → situation only). Already-generated artifacts keep their tier (no retroactive rewrite — regenerating them at the new tier goes through the proposal channel). Tier movement criteria (performance within tier) belong to the execution-event stream; v1 sets it explicitly with the learner.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      tier: { type: 'string', required: true, description: '骨架/补全/独立' },
    },
    (args: { id: string; tier: string }) => run(rt, 'learnhub_project_tier', async () =>
      JSON.stringify(await rt.engine.projectSetTier(args.id, args.tier))))
  tool('learnhub_project_plan_generate',
    'Draft the milestone plan for a project through the model and file it as a PENDING project_plan proposal (human review in the panel; apply with learnhub_project_apply): an ordered 3–8 item plan of 1–2-week deliverable checkpoints, simple→complex task classes, each with acceptance hints. Revising an existing plan is the same channel — applying the proposal snapshots the replaced plan YAML (no silent overwrite). The plan lands in the project\'s 项目.md frontmatter; milestone ARTIFACTS are generated separately per milestone.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run(rt, 'learnhub_project_plan_generate', () => generateProjectPlan(rt, ctx, args.id)))
  tool('learnhub_project_milestone_generate',
    'Generate ONE milestone artifact (a four-block task card 给定/待办/验收清单/支持) through the model at the project\'s current fading tier: 骨架 = near-complete demonstration, 补全 = partial product with【待补全】gaps, 独立 = situation and starting point only. Output passes a lightweight structural gate (one repair round on failure). FIRST generation lands directly; if the artifact already exists the same call files a PENDING project_milestone REGENERATION proposal instead — apply with learnhub_project_apply (old text is snapshotted, never silently overwritten). Zero XP, zero FSRS.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id from the plan (e.g. m1)' },
    },
    (args: { id: string; milestone: string }) => run(rt, 'learnhub_project_milestone_generate', () =>
      generateProjectMilestone(rt, ctx, args.id, args.milestone)))
  tool('learnhub_project_apply',
    'Apply a pending PROJECT proposal by id (kind read from the record: project_plan = write the revised milestone plan into 项目.md with the old plan snapshotted — a revision diff (milestone identity keyed by id) is returned and switch-line/branch-in growth batches are ENQUEUED for the anchored courses (#149); project_milestone = overwrite the milestone artifact with the old text snapshotted). Decompile-linked plan proposals CANNOT apply alone while their seed half is pending — use learnhub_project_decompile_apply. Graph proposals (edit/seed) go through learnhub_graph_apply instead. Nothing applies without this explicit step — review pending proposals with the learner first.',
    { id: { type: 'number', required: true, description: 'Pending proposal id' } },
    (args: { id: number }) => run(rt, 'learnhub_project_apply', async () => {
      const result = await rt.engine.projectApply(args.id)
      triggerPlanGrowth(rt, ctx, result)
      return JSON.stringify(result)
    }))
  tool('learnhub_project_milestone_pass',
    'Record the learner\'s EXPLICIT milestone pass (P-4 settlement): the learner declares a milestone checkpoint reached — no checklist gate and no question gate (Kulik 1990: strict gates hurt completion). One journal settlement row lands (kind=milestone_settle, aligned with the node xp_settle precedent): XP price = the plan\'s est declaration × FSRS difficulty calibration over the DECLARED linked nodes\' question pools (defaults when undeclared; the calibration basis is locked to the plan — it cannot be extended at pass time), locked once — a second pass of the same milestone id is rejected, so revising a plan must use fresh milestone ids. This is the ONLY journal write the project domain ever makes; it counts toward the ledger and streak like real focused work does.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id from the plan' },
    },
    (args: { id: string; milestone: string }) => run(rt, 'learnhub_project_milestone_pass', async () =>
      JSON.stringify(await rt.engine.projectMilestonePass(args.id, args.milestone))))
  tool('learnhub_project_milestone_recall',
    'Start a MILESTONE RECALL session (P-3): draw a few questions from the linked course nodes\' question banks so the knowledge base stays connected to the real project — retrieval points serve the knowledge base only, they are NOT project acceptance criteria (the gate is only that the milestone artifact exists). Zero XP, zero FSRS, zero scheduling writes: the drawn questions are archived to projects/<id>/recall.jsonl and returned WITH answers for you to run verbally — ask, hear the learner out, compare; never call learnhub_question_answer for these. Then archive the learner\'s spoken key-decision narration with learnhub_project_recall_reflect.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id from the plan (artifact must be generated)' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Extra linked course nodes (merged with the plan\'s declared nodes)' },
      limit: { type: 'number', description: 'Questions to draw (default 5)' },
    },
    (args: { id: string; milestone: string; nodes?: string[]; limit?: number }) => run(rt, 'learnhub_project_milestone_recall', async () =>
      JSON.stringify(await rt.engine.projectMilestoneRecall(args.id, args.milestone, { nodes: args.nodes, limit: args.limit }))))
  tool('learnhub_project_recall_reflect',
    'Archive the learner\'s key-decision narration from a milestone recall session (P-3): their spoken「到目前为止的关键决策」goes verbatim into projects/<id>/recall.jsonl for later retrospection. No verdict, no scoring, no canonical writes — the narration is for looking back on, not for feeding the scheduler.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', required: true, description: 'Milestone id' },
      narration: { type: 'string', required: true, description: 'Learner\'s key-decision narration (verbatim, non-empty)' },
    },
    (args: { id: string; milestone: string; narration: string }) => run(rt, 'learnhub_project_recall_reflect', async () =>
      JSON.stringify(await rt.engine.projectRecallReflect(args.id, args.milestone, args.narration))))
  tool('learnhub_project_recall_log',
    'Read a project\'s recall-session ledger (P-3): the draw records (which questions were drawn at which milestone) and reflect records (key-decision narrations). Read-only.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run(rt, 'learnhub_project_recall_log', async () =>
      JSON.stringify(await rt.engine.projectRecallLog(args.id))))
  tool('learnhub_project_enc_candidates',
    'Mine BEHAVIORALLY-INFERRED enc candidate edges (P-6): scan the learner\'s real card flips/answer activity on the project\'s linked course nodes inside a window (default the 14 days before the named milestone\'s pass, else before now); node pairs co-active on ≥ min_co days (default 2) become enc candidates with confidence-weighted edges (≥3 days 1.0 / 2 days 0.8 / 1 day 0.6; direction from the pre-closure when the graph knows it, first-activity heuristic otherwise). Files ONE pending edit proposal per course (set_enc whole-replace ops, declared edges preserved — zero schema break; single-proposal human review like enc_backfill); the panel/learnhub_graph_apply decides. Cross-course pairs are dropped, already-declared edges are skipped. This is how the all-zero enc graph starts growing from doing, not declaring.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      milestone: { type: 'string', description: 'Milestone id anchoring the window end at its pass time (must have a pass record); omit to anchor at now' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Extra linked course nodes (merged with the plan\'s declared nodes)' },
      window_days: { type: 'number', description: 'Window length in days, 1-90 (default 14)' },
      min_co: { type: 'number', description: 'Minimum co-active days per pair (default 2)' },
    },
    (args: { id: string; milestone?: string; nodes?: string[]; window_days?: number; min_co?: number }) => run(rt, 'learnhub_project_enc_candidates', async () =>
      JSON.stringify(await rt.engine.projectEncCandidates(args.id, { milestone: args.milestone, nodes: args.nodes, window_days: args.window_days, min_co: args.min_co }))))
  tool('learnhub_project_decompile',
    'GOAL DECOMPILATION, v8 seed-cluster form (#149): one model call produces TWO paired proposals from the goal description + registered notes — a milestone plan draft (project_plan) and a knowledge-subgraph SEED CLUSTER (kind=seed: 1-3 start nodes + endpoint, engine stamps basis=project and lands the coarse placeholder edges). Same-origin in-out: both pass gates before EITHER is filed (plan-seed name-reconciliation gate: every plan.nodes reference must resolve to a seed-cluster node or an existing graph node — dangling references reject the whole run), and the pair is LINKED (apply ONLY via learnhub_project_decompile_apply which lands the seed graph first then the plan; rejecting one auto-rejects the other). With an explicit course param: the course must already exist and NO seed half is produced (the plan references existing nodes only — new knowledge needs are grown later by the coach, driven by plan-revision diffs). Vault priors are mined read-only; nothing canonical is written before apply.',
    {
      id: { type: 'string', required: true, description: 'Project id (the plan-draft proposal targets it)' },
      goal: { type: 'string', description: 'Goal description prose; defaults to the project\'s goal field (empty goal is rejected)' },
      course: { type: 'string', description: 'Existing target course: plan-only run (nodes must reference existing graph nodes); omit → the seed cluster becomes a NEW course seed proposal (pair-linked with the plan)' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Registered note-source ids or vault-relative paths to mine for prior context; omit → all registered sources' },
    },
    (args: { id: string; goal?: string; course?: string; notes?: string[] }) => run(rt, 'learnhub_project_decompile', async () =>
      JSON.stringify(await rt.engine.projectDecompile(
        args.id,
        {
          ...(args.goal !== undefined ? { goal: args.goal } : {}),
          ...(args.course !== undefined ? { course: args.course } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
        },
        llmSeam(ctx),
      ))))
  tool('learnhub_project_decompile_apply',
    'Apply a DECOMPILED pair TOGETHER (project_plan + seed, #149 same-origin in-out): pass BOTH proposal ids from learnhub_project_decompile; the seed lands first (cluster nodes + endpoint anchor + note scaffolds) so the plan\'s node references resolve, then the plan writes. Single-sided apply of a linked pair is rejected at the guard — use this joint entry (crash recovery: an already-applied half is skipped, a rejected half never revives — re-decompile instead).',
    {
      plan: { type: 'number', required: true, description: 'project_plan proposal id' },
      seed: { type: 'number', required: true, description: 'seed proposal id (pair-linked with the plan)' },
    },
    (args: { plan: number; seed: number }) => run(rt, 'learnhub_project_decompile_apply', async () =>
      JSON.stringify(await rt.engine.projectDecompileApply(args.plan, args.seed))))
  tool('learnhub_project_exec_log',
    'Log ONE PROJECT execution event (P-7): a real work session on the project with a performance rating (1-4 integer; 4 = strong, 1 = poor) and an honest source (auto REQUIRES observable evidence mapped deterministically; self/ai take the explicit rating — self-report is trusted, ADR-0016). The event lands in the project\'s OWN stream (projects/<id>/exec.jsonl) feeding the fading-tier recommendation and the 2×2 diagnostic. Exercised linked nodes get practice evidence backflow ONE-WAY into each node\'s practice channel (existing applyPracticeEvidence EMA, node-level dedup — seeded stub nodes participate exactly like taught ones); the count of exercised existing enc edges is reported for observability but coarse placeholder pre edges are NOT backflow channels. Zero XP, zero journal, zero FSRS/scheduling writes.',
    {
      id: { type: 'string', required: true, description: 'Project id' },
      source: { type: 'string', required: true, description: 'auto (requires evidence) / self / ai' },
      rating: { type: 'number', description: 'Performance rating 1-4 integer (required for self/ai; ignored for auto)' },
      evidence: { type: 'object', additionalProperties: true, description: 'Observable evidence for source=auto: { accuracy: 0-1, self_help?: number }' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Linked course nodes exercised this session (node name or 课程/节点); empty = stream-only, no backflow' },
      note: { type: 'string', description: 'One-line note about this execution' },
    },
    (args: { id: string; source: string; rating?: number; evidence?: { accuracy?: number; self_help?: number }; nodes?: string[]; note?: string }) => run(rt, 'learnhub_project_exec_log', async () =>
      JSON.stringify(await rt.engine.projectExecLog(args.id, {
        source: args.source,
        ...(args.rating !== undefined ? { rating: args.rating } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
        ...(args.nodes !== undefined ? { nodes: args.nodes } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
      }))))
  tool('learnhub_project_cross_view',
    'Read a project\'s 2×2 MASTERY CROSS diagnostic (P-7, the project panel\'s core view): X = declarative mastery (mean masteryOfFm over the plan\'s linked nodes), Y = project execution evidence (EMA 0.7/0.3 of event scores; both axes threshold 0.6, missing evidence counts as low). Quadrants: 会而不会用 (high mastery × low execution — apply it), 会用而不牢 (low × high — shore up the knowledge base), 健康 (high × high), 补底 (low × low). Also returns the READ-ONLY fading-tier recommendation (challenge point): promotion criteria = performance within the current tier (≥3 events averaging ≥0.8) AND the linked-node mastery holding — the engine only proposes, the learner changes tier explicitly via learnhub_project_tier, and the recommendation NEVER gates milestones or anything else.',
    { id: { type: 'string', required: true, description: 'Project id' } },
    (args: { id: string }) => run(rt, 'learnhub_project_cross_view', async () =>
      JSON.stringify(await rt.engine.projectCrossView(args.id))))

  // —— 学习者产出（E 区我的卡与错误卡 + U 区技能/回执/习惯 + 周复盘） ——
  tool('learnhub_explain_back_pack',
    'Open the「讲给我听」Feynman session for a node (E2, learner output — the learner explains to YOU): returns the session pack = section-by-section content points + graph position + your role instructions. Your role in this and following turns: a COMPLETE NOVICE who knows nothing about the topic — ask questions ONLY from the content points, one question at a time, probing ambiguity/vagueness, skipped steps, and wrong statements in the learner\'s words; never grade, never praise, never go beyond the points, never give answers; if the learner says「换一种问」re-ask the unclear point from a different angle; wrap up briefly in-character once everything is covered. After the session ends, call learnhub_explain_feedback with the full transcript.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run(rt, 'learnhub_explain_back_pack', () =>
      rt.engine.explainBackPack(args.course, args.node)))
  tool('learnhub_explain_feedback',
    'Close a「讲给我听」session (E2) with located feedback: sends the full transcript to the grading model against the node\'s content points and returns verdict (对/部分对/错) + deviation tags (含糊/跳跃/说错) + a "how to fill the gap" advice + the full markdown feedback for the learner. The verdict is archived ONLY in the E archive — zero XP, zero canonical writes (Learner Output boundary); fails loud with zero side effects if the model output is unparseable.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      transcript: { type: 'string', required: true, description: 'Full explain-back dialogue (learner explanations + your novice questions)' },
    },
    (args: { course: string; node: string; transcript: string }) => run(rt, 'learnhub_explain_feedback', async () =>
      JSON.stringify(await rt.engine.explainBackFeedback(args.course, args.node, args.transcript, llmSeam(ctx)))))
  tool('learnhub_learner_card_add',
    'Archive the learner\'s own wording as a LearnerCard (E1「我的卡」, the archive target of E2 explain-back): kind recall_cue (再讲一遍 — default; front asks them to re-explain in their own words) or cloze_rewrite (挖空重述; content must contain at least one non-empty {{…}} cloze). The card lives in the「我的卡」E domain (ADR-0021: its reviews ride the merged cross-course review queue and earn unbound XP — totals/daily goal/streak only, never per-course or per-node ledgers; one push per card per day via learnhub_learner_rate / learnhub_learner_forget). Creating the card is zero XP and writes nothing to mastery or node scheduling. Duplicate content on the same node is rejected.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Source node the card attaches to' },
      content: { type: 'string', required: true, description: 'The learner\'s own wording (the archived explanation/note)' },
      kind: { type: 'string', description: 'recall_cue (default) or cloze_rewrite' },
      prompt: { type: 'string', description: 'Front prompt; a default is generated per kind when omitted' },
      section: { type: 'string', description: 'Section id to anchor the card to a specific section' },
    },
    (args: { course: string; node: string; content: string; kind?: string; prompt?: string; section?: string }) => run(rt, 'learnhub_learner_card_add', async () => {
      if (!args.content?.trim()) throw new Error('[learner-card-add] content 必填——存的是学习者自己的话。')
      return JSON.stringify(await rt.engine.explainArchiveCard(args.course, args.node, {
        content: args.content,
        ...(args.kind !== undefined ? { kind: args.kind as 'recall_cue' | 'cloze_rewrite' } : {}),
        ...(args.prompt !== undefined && args.prompt.trim() ? { prompt: args.prompt } : {}),
        ...(args.section !== undefined && args.section.trim() ? { section: args.section } : {}),
      }))
    }))
  tool('learnhub_understanding_add',
    'Add the learner\'s「我的理解」as a section-anchored self-note (E1「加我的理解」entry): the learner writes ONE explanation/example/mnemonic in their OWN words for a section they just learned; the model compares it against that section\'s taught points and returns verdict (对/部分对/错) + located deviations (含糊/跳跃/说错) + a "how to fill the gap" advice + the full markdown feedback. The verdict is archived ONLY in the E archive and the wording becomes a LearnerCard in the「我的卡」E domain (ADR-0021: reviews ride the merged review queue and earn unbound XP — totals only, never per-course ledgers) — Learner Output boundary: creating is zero XP, zero mastery/node-scheduling writes. Unparseable model feedback fails loud with zero side effects (nothing is archived, no card is created). kind: recall_cue 提示重述 (default) / cloze_rewrite 挖空重述 (content must contain a non-empty {{…}} cloze) / self_explain 自注讲解.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
      content: { type: 'string', required: true, description: 'The learner\'s own wording (their understanding, in their words)' },
      section: { type: 'string', description: 'Section id or title to anchor the note to (the feedback then compares against that section only)' },
      kind: { type: 'string', description: 'Card face: recall_cue (default) / cloze_rewrite / self_explain' },
      prompt: { type: 'string', description: 'Front prompt; a default is generated per kind when omitted' },
    },
    (args: { course: string; node: string; content: string; section?: string; kind?: string; prompt?: string }) => run(rt, 'learnhub_understanding_add', async () => {
      if (!args.content?.trim()) throw new Error('[understanding] content 必填——存的是学习者自己的话。')
      return JSON.stringify(await rt.engine.learnerNoteAdd(args.course, args.node, {
        content: args.content,
        ...(args.section !== undefined && args.section.trim() ? { section: args.section } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as never } : {}),
        ...(args.prompt !== undefined && args.prompt.trim() ? { prompt: args.prompt } : {}),
      }, llmSeam(ctx)))
    }))
  tool('learnhub_learner_queue',
    'List ALL「我的卡」E-domain cards (E1) for inventory/management: due cards first (due ascending), never-scheduled cards after. Each card carries prompt (front: what to restate) and content (back: the learner\'s own wording), source_node/source_section anchors, and attempts. Review happens in the merged cross-course review queue (ADR-0021) or directly via learnhub_learner_rate (Hard/Good/Easy 2/3/4) / learnhub_learner_forget — one push per card per day. Rating earns unbound XP: counted in totals/daily goal/streak only, never in per-course/per-node ledgers, never in mastery.',
    { course: { type: 'string', description: 'Course name; omit for all enabled courses' } },
    (args: { course?: string }) => run(rt, 'learnhub_learner_queue', async () =>
      JSON.stringify(await rt.engine.learnerQueue(args.course))))
  tool('learnhub_learner_rate',
    'Settle one「我的卡」self-note card with the learner\'s self-rating after they restated and compared (2=Hard 3=Good 4=Easy). One push per card per day (a second same-day rating is rejected). Only the card\'s own FSRS block moves; the rating earns unbound XP (ADR-0021) — counted in totals/daily goal/streak only, never in per-course/per-node ledgers or mastery.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to (source_node)' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      rating: { type: 'number', required: true, description: 'Self-rating: 2 Hard / 3 Good / 4 Easy' },
    },
    (args: { course: string; node: string; card: string; rating: number }) => run(rt, 'learnhub_learner_rate', async () =>
      JSON.stringify(await rt.engine.learnerCardRate(args.course, args.node, args.card, args.rating))))
  tool('learnhub_learner_forget',
    'Declare「忘记」on a「我的卡」self-note card — the learner could not restate it, so the card is pushed with rating 1 (again tomorrow). One push per card per day; zero XP (a 0-XP unbound journal row keeps the streak ledger honest, ADR-0021), no mastery or node-scheduling writes.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to (source_node)' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
    },
    (args: { course: string; node: string; card: string }) => run(rt, 'learnhub_learner_forget', async () =>
      JSON.stringify(await rt.engine.learnerCardForget(args.course, args.node, args.card))))
  tool('learnhub_learner_card_archive',
    'Archive or restore one「我的卡」self-note card (E1 management). Archived cards leave the learner queue but keep their history in the card file. E-domain internal action: zero canonical writes.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to (source_node)' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { course: string; node: string; card: string; archived?: boolean }) => run(rt, 'learnhub_learner_card_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[learner-card-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.learnerCardArchive(args.course, args.node, args.card, args.archived))
    }))

  // ·· C-3 错误对比卡（#82）：错法挖矿 → 三选一辨别卡 → 错误 deck 走 FSRS ··

  tool('learnhub_error_card_mine',
    'Mine the answer-attempt stream for high-frequency error patterns (C-3 #82, read-only preview): groups substantive wrong answers (correct=false with an actual wrong answer; forget declarations do not count) by course/node/question and returns candidates with >=2 lapses, each carrying the learner\'s distinct wrong answers (most recent first). This is the human-audit surface for "error patterns are reasonable" — generation is learnhub_error_card_generate; nothing is written here.',
    {
      course: { type: 'string', description: 'Course name; omit for all enabled courses' },
      node: { type: 'string', description: 'Node name to scope the mining' },
    },
    (args: { course?: string; node?: string }) => run(rt, 'learnhub_error_card_mine', async () =>
      JSON.stringify(await rt.engine.errorCardMine(args.course, args.node))))
  tool('learnhub_error_card_generate',
    'Generate 错误对比卡 discrimination cards from mined error patterns (C-3 #82): picks the top uncovered candidates (same question failed substantively >=2 times, no active card yet, batch cap 5), feeds the model the original question/answer/explanation + the learner\'s own wrong answers + the bound section excerpt, and the model returns three-option cards where ONE option is the learner\'s own wrong approach. Cards pass a schema gate (exactly 3 distinct options; answer and mine must both be among them and differ; (node,source_q) must match an offered candidate) and land in the per-node 错误卡 deck (课程根/错误卡/<节点>.yaml). Creation is zero XP and writes nothing canonical — the deck joins the review queue (source=error) and reviews earn unbound XP via learnhub_error_card_answer. Zero-disk-write on any model/gate failure.',
    {
      course: { type: 'string', description: 'Course name' },
      node: { type: 'string', description: 'Node name to scope mining/generation' },
      max: { type: 'number', description: 'Max cards this run (default 5, cap 5)' },
    },
    (args: { course: string; node?: string; max?: number }) => run(rt, 'learnhub_error_card_generate', async () =>
      JSON.stringify(await rt.engine.errorCardGenerate(args.course, {
        ...(args.node ? { node: args.node } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
      }, async prompt => stripFences(await llmSeam(ctx)(prompt))))))
  tool('learnhub_error_card_queue',
    'List ALL 错误对比卡 (C-3 #82) for inventory/audit: due cards first (due ascending), never-scheduled cards after. Each card carries the full face (q/options/answer/mine/explanation) plus source_q provenance — use this to spot-check that mined error patterns are faithful to what the learner actually did. Review happens in the merged cross-course review queue (source=error) or directly via learnhub_error_card_answer (auto-graded: pick the correct approach = 3, pick wrong = 1; one push per card per day). Correct picks earn unbound XP (totals/daily goal/streak only).',
    { course: { type: 'string', description: 'Course name; omit for all enabled courses' } },
    (args: { course?: string }) => run(rt, 'learnhub_error_card_queue', async () =>
      JSON.stringify(await rt.engine.errorCardQueue(args.course))))
  tool('learnhub_error_card_answer',
    'Settle one 错误对比卡 (C-3 #82) with the learner\'s three-way choice: the choice must be one of the card\'s option texts verbatim. Auto-graded — picking the correct approach pushes the card with rating 3, picking wrong with rating 1 (one push per card per day, second same-day answer rejected). Only the card\'s own FSRS block moves (default params, optimizer never trains it); a correct pick earns unbound XP (xp_error journal row — totals/daily goal/streak only, never per-course/per-node ledgers or mastery); wrong picks leave a 0-XP unbound row. The reveal (answer / the learner\'s mine option / explanation) rides the response for the learner to compare.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      choice: { type: 'string', required: true, description: 'The chosen option text (verbatim one of options)' },
    },
    (args: { course: string; node: string; card: string; choice: string }) => run(rt, 'learnhub_error_card_answer', async () =>
      JSON.stringify(await rt.engine.errorCardAnswer(args.course, args.node, args.card, args.choice))))
  tool('learnhub_error_card_archive',
    'Archive or restore one 错误对比卡 (C-3 #82 management): archived cards leave the review queue but keep their history in the card file; a question with only an archived card becomes minable again on the next generate run. Error-deck internal action: zero canonical writes.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node the card belongs to' },
      card: { type: 'string', required: true, description: 'Card id, e.g. "c1"' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { course: string; node: string; card: string; archived?: boolean }) => run(rt, 'learnhub_error_card_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[error-card-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.errorCardArchive(args.course, args.node, args.card, args.archived))
    }))

  // ·· U 区·技能条目与执行事件通道（#89 / ADR-0018 + ADR-0019）：lane 与题目 FSRS 并行，不复用题目卡、不进复习队列 ··
  tool('learnhub_skill_create',
    'Create a skill entry (U-area schedulable practice subject, e.g. guitar/swimming/coding): the carrier of the execution-event scheduling lane. The lane runs PARALLEL to question FSRS (same kernel math, own isolated state) — it never reuses question cards, never enters the review queue, and has no mastery. Optional maintenance beat cap (days, default 30, null = off) guarantees long-dormant skills resurface at low frequency (mini-redo + replay).',
    {
      name: { type: 'string', required: true, description: 'Skill name (also becomes the id)' },
      maintenance_days: { type: 'number', description: 'Maintenance beat cap in days: 7-365, or 0/null to disable (default 30)' },
    },
    (args: { name: string; maintenance_days?: number | null }) => run(rt, 'learnhub_skill_create', async () =>
      JSON.stringify(await rt.engine.skillCreate(args.name, {
        ...(args.maintenance_days !== undefined ? { maintenance_days: args.maintenance_days } : {}),
      }))))
  tool('learnhub_skill_list',
    'List skill entries with their lane due dates (maintenance cap folded in). due_kind marks what a due lane wants: acquisition (FSRS due drove it) or maintenance (the beat cap brought it back — mini-redo + replay). Fresh skills (never executed) have due=null: no due semantics until the first execution.',
    {}, () => run(rt, 'learnhub_skill_list', async () => JSON.stringify(await rt.engine.skillList())))
  tool('learnhub_skill_maintenance',
    'Set a skill\'s maintenance beat cap (days 7-365, or null to disable): the lane comes due at most this many days after the last execution, so interval growth can never drown the skill (Arthur 1998: disused motor skills decay hard — low-frequency contact itself has value). Pure entity property: the existing FSRS state is untouched.',
    {
      skill: { type: 'string', required: true, description: 'Skill id' },
      days: { type: 'number', description: 'Cap in days (7-365); omit/null disables the cap' },
    },
    (args: { skill: string; days?: number | null }) => run(rt, 'learnhub_skill_maintenance', async () =>
      JSON.stringify(await rt.engine.skillSetMaintenance(args.skill, args.days ?? null))))
  tool('learnhub_skill_archive',
    'Archive or restore a skill entry (reversible; archived is a shelving label). Archived skills refuse new execution events until restored.',
    {
      skill: { type: 'string', required: true, description: 'Skill id' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { skill: string; archived?: boolean }) => run(rt, 'learnhub_skill_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[skill-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.skillArchive(args.skill, args.archived))
    }))
  tool('learnhub_execution_log',
    'Log one execution event on a skill (the lane\'s core input): a real practice + a performance rating (1-4 integer; 4 = strong, 1 = poor) that pushes the skill\'s lane via the same advance kernel (one push per lane per learning day). Source honesty: source=\'auto\' REQUIRES observable evidence (evidence.accuracy 0-1, optional evidence.self_help) mapped deterministically — raw scores are never fed to FSRS; source=\'self\'/\'ai\' take an explicit rating. XP = native focused minutes (minutes 1-1440, 1 XP ≈ 1 min), same ledger and streak as study time (ADR-0019); the event row lands in the review log with rating_source=execution and an event kind (acquisition/maintenance) distinguishing the two flows.',
    {
      skill: { type: 'string', required: true, description: 'Skill id' },
      source: { type: 'string', required: true, description: 'auto (evidence-mapped) / self / ai' },
      minutes: { type: 'number', required: true, description: 'Focused minutes of this execution (1-1440); credited as XP 1:1' },
      rating: { type: 'number', description: 'Performance rating 1-4 (required unless source=auto)' },
      evidence: { type: 'object', additionalProperties: true, description: 'source=auto only: {accuracy: 0-1, self_help?: count}' },
      note: { type: 'string', description: 'Free note (e.g. what was practiced, receipt reference)' },
    },
    (args: { skill: string; source: string; minutes: number; rating?: number; evidence?: { accuracy?: number; self_help?: number }; note?: string }) =>
      run(rt, 'learnhub_execution_log', async () =>
        JSON.stringify(await rt.engine.executionLog(args.skill, {
          source: args.source as never, minutes: args.minutes,
          ...(args.rating !== undefined ? { rating: args.rating } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
          ...(args.note ? { note: args.note } : {}),
        }))))

  // ·· U 区·回执反馈环（#88 / ADR-0016）：回执 → AI 量表评审 → EMA + 渐退反馈 ··

  tool('learnhub_receipt_submit',
    'File an external-practice receipt on a PRACTICE node (v1 carrier) and run the full loop: receipt → AI rubric review (rubric source = the node\'s content points; free-form questions are NOT answered) → the score enters the node\'s practice EMA (same weight, old 0.7/new 0.3). Self-reported = trusted (no anti-cheat gate); material is free-form (text description / image path / export / coach signoff). Receipts never earn XP, never push any FSRS card, and are never Broken. Feedback fades: full error-specific reviews follow a decreasing-frequency curve (receipt #1,2,4,7,11,16,… capped at every 5th); other receipts get score + one-line verdict only. The learner can always force a full review (force_full).',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Practice node name (type=practice)' },
      kind: { type: 'string', required: true, description: 'text / image / export / signoff' },
      material: { type: 'string', required: true, description: 'Receipt material: description, image path, export data, or signoff reference' },
      force_full: { type: 'boolean', description: 'Learner explicitly asks for a full error-specific review now' },
    },
    (args: { course?: string; node: string; kind: string; material: string; force_full?: boolean }) =>
      run(rt, 'learnhub_receipt_submit', async () => {
        return JSON.stringify(await rt.engine.receiptSubmit(
          args.course, args.node,
          { kind: args.kind as never, material: args.material, ...(args.force_full !== undefined ? { force_full: args.force_full } : {}) },
          llmSeam(ctx),
        ))
      }))
  tool('learnhub_receipt_list',
    'List a practice node\'s receipt history with the fading-feedback state: each receipt\'s material kind, review depth (full/brief), rubric score, and verdict; total count and how many receipts until the next full review. Read-only.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Practice node name' },
    },
    (args: { course?: string; node: string }) => run(rt, 'learnhub_receipt_list', async () =>
      JSON.stringify(await rt.engine.receiptList(args.course, args.node))))

  // ·· U 区·习惯一等公民（#90 / ADR-0017）：零 FSRS 语义、零 canonical 写入 ··

  tool('learnhub_habit_create',
    'Create a habit (U-area first-class object): an execution intention (cue + action, format locked to "stable time/place cue → ONE concrete action") + an automation curve + a forgiving streak. Habits have NO FSRS semantics, no mastery, NO due dates — the scheduler is context and calendar, the engine never reminds. Repetitions are self-reported (no gate, no anti-cheat — self-measurement is not an exam).',
    {
      name: { type: 'string', required: true, description: 'Habit name' },
      cue: { type: 'string', required: true, description: 'Stable cue: time/place anchor (e.g. "after brushing teeth in the morning")' },
      action: { type: 'string', required: true, description: 'ONE concrete action (verb-first); multi-behavior chains fall outside the evidence format' },
    },
    (args: { name: string; cue: string; action: string }) => run(rt, 'learnhub_habit_create', async () =>
      JSON.stringify(await rt.engine.habitCreate(args))))
  tool('learnhub_habit_list',
    'List habits with their derived surfaces: total self-reported repeats, forgiving streak (small gaps ≤2 days don\'t break it), and latest automation self-rating. Curve and streak are shown to the learner only — they never enter mastery, XP, or any canonical measure.',
    {}, () => run(rt, 'learnhub_habit_list', async () => JSON.stringify(await rt.engine.habitList())))
  tool('learnhub_habit_show',
    'Show one habit in full: execution intention (cue + action), full automation curve (x = cumulative repeats, y = self-rating 1-5; no decay — interruptions don\'t erode it), streak, and recent repeat log.',
    { habit: { type: 'string', required: true, description: 'Habit id' } },
    (args: { habit: string }) => run(rt, 'learnhub_habit_show', async () =>
      JSON.stringify(await rt.engine.habitShow(args.habit))))
  tool('learnhub_habit_repeat',
    'Self-report one repetition of a habit (the ONLY counting source; unlimited, no gate). Optionally carry an automation self-rating 1-5 (SRBAI-style, event-level, not required every time). Zero XP, zero scheduling writes — habit repeats never enter the execution-event lane or any ledger.',
    {
      habit: { type: 'string', required: true, description: 'Habit id' },
      auto_rating: { type: 'number', description: 'Optional automation self-rating 1-5 (how automatic did it feel?)' },
      note: { type: 'string', description: 'Free note' },
    },
    (args: { habit: string; auto_rating?: number; note?: string }) => run(rt, 'learnhub_habit_repeat', async () =>
      JSON.stringify(await rt.engine.habitRepeat(args.habit, {
        ...(args.auto_rating !== undefined ? { auto_rating: args.auto_rating } : {}),
        ...(args.note ? { note: args.note } : {}),
      }))))
  tool('learnhub_habit_archive',
    'Archive or restore a habit (reversible; archived is a shelving label). Habits have no deadlines — staying active forever is legal.',
    {
      habit: { type: 'string', required: true, description: 'Habit id' },
      archived: { type: 'boolean', required: true, description: 'true to archive, false to restore' },
    },
    (args: { habit: string; archived?: boolean }) => run(rt, 'learnhub_habit_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[habit-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.habitArchive(args.habit, args.archived))
    }))
  tool('learnhub_kata_open',
    'Open the Weekly Kata (U-4, ADR-0026 — the global once-per-week five-question debrief where the bounded area [course overview + one section per active project] meets the unbounded area [habits + skill entries]): the review target is the LAST COMPLETE learning week (calendar week folded by learning days; early-morning sessions roll back over the day cutoff). The「现状」section is auto-filled by the engine from that week\'s REAL data (XP, answers/accuracy, true retention, per-project milestone passes and exec events, habit repeats, skill executions, note-source reviews with [[links]] back to the personal notes); the other four questions (目标条件/障碍/下一实验/预期所学) are the LEARNER\'S to answer — ask them, never answer for them. The record lands in 学习中心/我的产出/周复盘/<Monday>.md (V-3 output zone; registrable as a Note Source). Learner Output domain: zero XP, no Mastery, no FSRS card, zero canonical writes; no reminders, missing a week is never penalized.',
    { week_start: { type: 'string', description: 'Monday YYYY-MM-DD of the week to review; omit for the most recent complete week' } },
    (args: { week_start?: string }) => run(rt, 'learnhub_kata_open', async () =>
      JSON.stringify(await rt.engine.kataOpen(args.week_start))))
  tool('learnhub_kata_save',
    'Save the learner\'s answers to the four learner questions of a Weekly Kata record (现状 is engine-owned and cannot be written here — facts come from behavior). Patch semantics: only provided keys are written; empty string resets a question to unanswered. Use this after the learner answers out loud, or point them at the panel/obsidian file to write directly.',
    {
      week_start: { type: 'string', required: true, description: 'Monday YYYY-MM-DD of the record' },
      answers: { type: 'object', additionalProperties: true, required: true, description: 'Partial map: 目标条件/障碍/下一实验/预期所学 → learner\'s own words' },
    },
    (args: { week_start: string; answers: Record<string, string> }) => run(rt, 'learnhub_kata_save', async () =>
      JSON.stringify(await rt.engine.kataSave(args.week_start, args.answers as never))))
  tool('learnhub_kata_convert_experiment',
    'One-click exit from the Kata\'s「下一实验」to an N-of-1 experiment proposal (U-4↔D-1 interface): files the SAME proposal-confirm flow as learnhub_experiment_propose (nothing starts by itself) and stamps the proposal number into the Kata record. Requires the week\'s record to exist (learnhub_kata_open first).',
    {
      week_start: { type: 'string', required: true, description: 'Monday YYYY-MM-DD of the record' },
      template: { type: 'string', required: true, description: 'Template id from learnhub_experiment_templates' },
      course: { type: 'string', description: 'Scope to one course; omit for all enabled courses' },
    },
    (args: { week_start: string; template: string; course?: string }) => run(rt, 'learnhub_kata_convert_experiment', async () =>
      JSON.stringify(await rt.engine.kataToExperiment(args.week_start, args.template, args.course))))
  tool('learnhub_kata_convert_intention',
    'One-click exit from the Kata\'s「下一实验」to an Execution Intention pinned to TODAY\'S goal preference (U-4↔C-5 interface): pins the chosen node to the top of today\'s recommendations carrying the if-then plan (cue = stable time/place anchor, action = ONE concrete act; format is locked and validated) and stamps the record. The pin expires with the day — the intention lives on today\'s read-side only.',
    {
      week_start: { type: 'string', required: true, description: 'Monday YYYY-MM-DD of the record' },
      course: { type: 'string', required: true, description: 'Course name of the target node' },
      node: { type: 'string', required: true, description: 'Node to pin today' },
      cue: { type: 'string', required: true, description: 'Stable cue (time/place anchor), e.g. 早上刷完牙后' },
      action: { type: 'string', required: true, description: 'Single concrete action, e.g. 做 5 道到期复习' },
    },
    (args: { week_start: string; course: string; node: string; cue: string; action: string }) => run(rt, 'learnhub_kata_convert_intention', async () =>
      JSON.stringify(await rt.engine.kataToIntention(args.week_start,
        { course: args.course, node: args.node, cue: args.cue, action: args.action }))))

  // —— 实验室（D 系列实验台：N-of-1/恒温器/沙盘） ——
  tool('learnhub_experiment_templates',
    'List the N-of-1 experiment template library (D-1, ADR-0023): preset self-experiments on engine-controlled content/design parameters only (scheduling core is NEVER an experiment variable). Each template carries id/title/question/arms/unit/description and an unlocked flag — unlocked=false templates are visible but cannot be started yet. Zero XP, never touches Mastery; arm labels go into the review log for attribution. Propose with learnhub_experiment_propose, the learner confirms, then learnhub_experiment_apply.',
    {}, () => run(rt, 'learnhub_experiment_templates', async () =>
      JSON.stringify(await rt.engine.experimentTemplates())))
  tool('learnhub_experiment_propose',
    'Propose an N-of-1 experiment from a preset template (D-1, proposal-confirmation flow, step 1): validates the template is unlocked and no experiment is running (v1 runs one at a time), previews the eligible card pool (scheduled, non-archived bank questions), and files a pending experiment proposal for the learner to confirm. Whitelist enforcement is structural: only template ids resolve; unknown ids and non-whitelist parameters fail loud. Never starts anything by itself.',
    {
      template: { type: 'string', required: true, description: 'Template id from learnhub_experiment_templates' },
      course: { type: 'string', description: 'Scope the experiment to one course; omit for all enabled courses' },
    },
    (args: { template: string; course?: string }) => run(rt, 'learnhub_experiment_propose', async () =>
      JSON.stringify(await rt.engine.experimentPropose(args.template, args.course))))
  tool('learnhub_experiment_apply',
    'Confirm and start a pending N-of-1 experiment proposal (D-1, proposal-confirmation flow, step 2): re-validates the artifact against the template whitelist, builds the assignment (batch templates alternate arms by learning day starting today; card-level templates get a seeded deterministic split), writes the experiment definition, and reports today\'s arm. Fails loud if another experiment is already running or the artifact fails re-validation.',
    { id: { type: 'number', description: 'Proposal id; omit for the newest pending experiment proposal' } },
    (args: { id?: number }) => run(rt, 'learnhub_experiment_apply', async () =>
      JSON.stringify(await rt.engine.experimentApply(applyId(args.id)))))
  tool('learnhub_experiment_stop',
    'Stop a running N-of-1 experiment (start/stop is always manual, ADR-0023): annotations cease, the report becomes final. Omit id to stop the currently running experiment.',
    { id: { type: 'number', description: 'Experiment id; omit for the running one' } },
    (args: { id?: number }) => run(rt, 'learnhub_experiment_stop', async () =>
      JSON.stringify(await rt.engine.experimentStop(args.id))))
  tool('learnhub_experiment_report',
    'Get the plain-language N-of-1 report (D-1, ADR-0023): arm-by-arm true retention, arm difference, 95% bootstrap interval, and a permutation test — phrased as an individual effect, never a population claim. Below the minimum observation window (per-arm real-advance minimum) it reports progress only and refuses to judge. running = interim reading; stopped = final.',
    { id: { type: 'number', description: 'Experiment id; omit for the running (or latest) one' } },
    (args: { id?: number }) => run(rt, 'learnhub_experiment_report', async () =>
      JSON.stringify(await rt.engine.experimentReport(args.id))))
  tool('learnhub_thermostat',
    'Get the challenge-point thermostat dashboard (D-2, ADR-0024): cross-region observation aggregate + READ-ONLY suggestions — the thermostat is NOT an auto-controller. Course region: true-retention band + long-term difficulty-band choice distribution. Unbounded region: execution-event rating distribution (empty until the U-area execution channel lands). Project region: deferred to P-7, tier list only. Three knobs max (A1 target difficulty-band default, retrieval-point density [not yet available], fading-tier move aggregation); at most three suggestions, low-data-silent. To ACT on a suggestion, show it to the learner and after their explicit confirmation call learnhub_thermostat_apply with the suggestion id — never apply without confirmation; there is no engine-side auto adjustment.',
    {},
    () => run(rt, 'learnhub_thermostat', async () => JSON.stringify(await rt.engine.thermostatView())))
  tool('learnhub_thermostat_apply',
    'Apply ONE thermostat suggestion AFTER the learner explicitly confirms it (D-2, ADR-0024): only ids currently offered by learnhub_thermostat are accepted (stale or invented ids fail loud) — this is the single confirmation gate. Confirmed band-default suggestions write the A1 default difficulty band via the existing config entry; the learner\'s explicit per-session band choice still overrides it.',
    { suggestion: { type: 'string', required: true, description: 'Suggestion id exactly as offered by learnhub_thermostat (e.g. band_default:standard)' } },
    (args: { suggestion: string }) => run(rt, 'learnhub_thermostat_apply', async () =>
      JSON.stringify(await rt.engine.thermostatApply(args.suggestion))))
  tool('learnhub_sandbox',
    'Run the plan sandbox (D-3, ADR-0025): Monte-Carlo projection of the learner\'s study plan using the SAME FSRS+mastery models as the scheduler (~200 seeded runs). Input = daily minutes goal x horizon in weeks (default 6) x intended course/nodes. Output = end-of-horizon mastery map (per node p50/p80) + total-mastery curve with 50/80 percentile bands + the honest assumption list (1 min per review, practice evidence frozen, new nodes introduced in course order). READ-ONLY: zero canonical writes, no gating, no scheduling side effects. The wording is locked to「模型推演，非承诺」— present the distribution as a distribution, never as a promise, and never as a feasibility verdict; the learner negotiates their own plan with it.',
    {
      minutes_per_day: { type: 'number', required: true, description: 'Daily learning-minutes goal of the plan' },
      weeks: { type: 'number', description: 'Horizon in weeks (default 6, max 26)' },
      course: { type: 'string', description: 'Scope to one course; omit for all enabled courses' },
      nodes: { type: 'array', items: { type: 'string' }, description: 'Intended node subset; omit for whole course(s)' },
    },
    (args: { minutes_per_day: number; weeks?: number; course?: string; nodes?: string[] }) =>
      run(rt, 'learnhub_sandbox', async () =>
        JSON.stringify(await rt.engine.sandboxRun({
          minutesPerDay: args.minutes_per_day, weeks: args.weeks, course: args.course, nodes: args.nodes,
        }))))

  // —— 通道（C1 笔记源 + C2 Anki 互通） ——
  tool('learnhub_note_source_register',
    'Register a personal vault note (or a folder — batch-registers every .md under it, recursively, dot-dirs skipped) as a Note Source (C1): the engine reads it ONLY to generate review questions; the note file is never written (zero bytes change, never judged Broken). Derivatives (fingerprint manifest + per-source question bank) live in the 学习中心/笔记源 mirror. Re-registering a missing source by the same path restores it. Registrable zones: everything OUTSIDE the learning center, PLUS two learner-document zones inside it (V-3/V-5) — 学习中心/我的产出/** (weekly kata, scripts, error cards) and 学习中心/projects/<id>/日志.md — so learner output can become reviewable too; every other learning-center path is rejected. The user exclusion list (learnhub_note_source_exclude) is enforced at this entry: an excluded input fails loud, and excluded subtrees are batch-skipped — skipped/skipped_paths report everything skipped (excluded entries and any learning-center files; when every .md under the input is skipped the error says so). Question generation is a separate explicit step (learnhub_note_source_generate).',
    { path: { type: 'string', required: true, description: 'Note or folder path, vault-relative or absolute; must be outside the learning center (except the two learner-document zones), not on the user exclusion list, and must exist' } },
    (args: { path: string }) => run(rt, 'learnhub_note_source_register', async () =>
      JSON.stringify(await rt.engine.noteSourceRegister(args.path))))
  tool('learnhub_note_source_list',
    'List registered Note Sources (C1) with pool status: ok / missing (note deleted or renamed — pool suspended, re-register or unregister) / drifted (note edited since question generation — regenerate or archive old questions, never automatic). Cards enter the global review queue automatically when due (course field = 笔记源). The response also carries excludes — the user exclusion list (paths never auto-registered; governs future registrations only, existing sources stay).',
    {},
    () => run(rt, 'learnhub_note_source_list', async () =>
      JSON.stringify(await rt.engine.noteSourceList())))
  tool('learnhub_note_source_unregister',
    'Unregister a Note Source (C1): removes the registry entry, the mirror manifest item, the mirror question bank, and the pool-mirror md. The user\'s note file is untouched. Use the id from learnhub_note_source_list.',
    { id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' } },
    (args: { id: string }) => run(rt, 'learnhub_note_source_unregister', async () =>
      JSON.stringify(await rt.engine.noteSourceUnregister(args.id))))
  tool('learnhub_note_source_relink',
    'Relink a Note Source to a new path (V-6 drift governance): when a registered note was RENAMED or MOVED, the source reads Missing and its card pool suspends — relink re-attaches the SAME source id to the new path, keeping the mirror bank and every card\'s FSRS schedule (unlike unregister+re-register, which orphans the old cards). Fingerprint and title refresh from the new file; the pool-mirror md backlink follows. The new path passes the same hygiene as registration (outside the learning center, not on the user exclusion list, not already taken by another source) and must EXIST — relink is a recovery action. Fails loud on every conflict.',
    {
      id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' },
      path: { type: 'string', required: true, description: 'New note path (after the rename/move), vault-relative or absolute' },
    },
    (args: { id: string; path: string }) => run(rt, 'learnhub_note_source_relink', async () =>
      JSON.stringify(await rt.engine.noteSourceRelink(args.id, args.path))))
  tool('learnhub_note_source_exclude',
    'Add a path to the user exclusion list (V-1): a note/folder that batch registrations must never absorb (e.g. private journals, sync-noise folders). Vault-relative or absolute, file or folder (folder = the whole subtree), need not exist yet. Governs FUTURE registrations only — already-registered sources stay until learnhub_note_source_unregister. Current list rides learnhub_note_source_list.',
    { path: { type: 'string', required: true, description: 'Note or folder path to exclude, vault-relative or absolute; must be outside the learning center' } },
    (args: { path: string }) => run(rt, 'learnhub_note_source_exclude', async () =>
      JSON.stringify(await rt.engine.noteSourceExclude(args.path))))
  tool('learnhub_note_source_unexclude',
    'Remove a path from the user exclusion list (must be on it — fails loud otherwise), making it registrable again via learnhub_note_source_register. Does not auto-register.',
    { path: { type: 'string', required: true, description: 'Excluded path to release, vault-relative or absolute' } },
    (args: { path: string }) => run(rt, 'learnhub_note_source_unexclude', async () =>
      JSON.stringify(await rt.engine.noteSourceUnexclude(args.path))))
  tool('learnhub_note_source_generate',
    'Generate review questions for a Note Source (C1): reads the note body (read-only) → 笔记出题 prompt → model → validateBank gate appends each question to the mirror bank (学习中心/笔记源/题库/<id>.yaml) → new cards get their FSRS card initialized (due tomorrow, synthetic init like course completion). The manifest fingerprint refreshes to the current content (drift acknowledged); old questions are NOT auto-archived — offer the learner to archive them explicitly. Fails loud when the source file is missing (re-register first).',
    {
      id: { type: 'string', required: true, description: 'Note-source id, e.g. "note-1"' },
      count: { type: 'number', description: 'Question count cap (default 6)' },
    },
    (args: { id: string; count?: number }) => run(rt, 'learnhub_note_source_generate', async () => {
      const n = questionCount(args.count)
      return JSON.stringify(await rt.engine.noteSourceGenerate(args.id, n, async prompt => stripFences(await llmSeam(ctx)(prompt))))
    }))
  tool('learnhub_anki_export',
    'Push today\'s due cards to desktop Anki over AnkiConnect (C2 #63, ADR-0011 — Anki is a pure ANSWERING conduit, the vault stays the ONLY scheduler): recalibrates the mirror deck(s) learnhub::<课程> on every call — adds missing due cards (model「learnhub」, fields 题目/答案/来源, the 来源 field carries 课程/节点/题id for write-back attribution), updates reworded ones, and DELETES mirror cards that are archived, regenerated, or no longer due in the vault (the deck is a disposable mirror — never judged Broken, vault wins on any mismatch; Anki-side scheduling output is discarded). Requires Anki running with the AnkiConnect add-on. After the learner answers in Anki (Again/Hard/Good/Easy), bring the answers home with learnhub_anki_import — import BEFORE the next export so freshly answered cards are not re-pushed.',
    { endpoint: { type: 'string', description: 'AnkiConnect endpoint; default http://127.0.0.1:8765' } },
    (args: { endpoint?: string }) => run(rt, 'learnhub_anki_export', async () =>
      JSON.stringify(await rt.engine.ankiExportPush(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))))
  tool('learnhub_anki_import',
    'Pull Anki review events since the last import and write them back as RAW ANSWERING EVIDENCE — the vault re-schedules every affected card with its own ts-fsrs, so the conclusion is identical no matter where the learner answered (ADR-0011: vault is the only scheduler). Mapping: Again → 答错 (rating 1, auto), Hard/Good/Easy → 复习自评档 (2/3/4, self, counted as recalled). The「one push per card per day」invariant holds across devices: a card the vault already advanced that day keeps its schedule untouched — the event is archived in the practice stream only. Imported events land in the practice stream (judge=review, timestamped at the Anki answer time, zero XP) and real advances also land in the review log, so memory-health stats and the FSRS parameter optimizer see Anki answers. Events that cannot be attributed (mirror lost → recovered via the 来源 field; question archived/regenerated) are counted and skipped, never guessed.',
    { endpoint: { type: 'string', description: 'AnkiConnect endpoint; default http://127.0.0.1:8765' } },
    (args: { endpoint?: string }) => run(rt, 'learnhub_anki_import', async () =>
      JSON.stringify(await rt.engine.ankiImportEvents(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))))
  tool('learnhub_anki_status',
    'Show the Anki channel status (C2): mirror size and deck names, last push/import timestamps, the current vault due-card distribution the next export would push, and AnkiConnect reachability. Use it to check the channel before exporting or importing.',
    { endpoint: { type: 'string', description: 'AnkiConnect endpoint; default http://127.0.0.1:8765' } },
    (args: { endpoint?: string }) => run(rt, 'learnhub_anki_status', async () =>
      JSON.stringify(await rt.engine.ankiStatus(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))))

  // —— 维护（体检/重建/反馈/解析/参数优化/课程重置删除/内容质检） ——
  tool('learnhub_data_check',
    'Run a read-only Data Check across the registry, graph YAML, course notes/frontmatter, and question banks. Return JSON findings that distinguish Missing (legal absence) from Broken (present but invalid); it never repairs or writes vault data.',
    {}, () => run(rt, 'learnhub_data_check', async () => JSON.stringify(await rt.engine.dataCheck())))
  tool('learnhub_probation',
    'Insertion-edge probation (recheck) status and settlement, #146. action=status (default): per-course view of insertion edges under probation (nodes the panel marks 实验中/under experiment), overdue-but-undecided entries, the three throttle rates over the rolling 30 learning days (insertion rate / prune rate / recheck pass rate) and the resilience gate state (side-branch cap 20%→30% when resilient; insertion batches are rejected at the gate when the pass rate bottoms out). action=settle: run the settlement hook now — due entries are auto-adjudicated with zero human review: metric met → proven (insertion becomes permanent); not met → the engine proposes and auto-applies del_node with coarse-edge restoration (settleRechecks). Settlement also writes recheck_outcome / graph_repair events to the sediment canon.',
    { action: { type: 'string', enum: ['status', 'settle'], description: 'default status' }, course: { type: 'string', description: 'course name; default all enabled courses' } },
    (args: { action?: 'status' | 'settle'; course?: string }) => run(rt, 'learnhub_probation', async () => {
      const a = (args ?? {}) as { action?: 'status' | 'settle'; course?: string }
      if (a.action === 'settle') return JSON.stringify(await rt.engine.settleRechecks(a.course))
      return JSON.stringify(await rt.engine.probationStatus(a.course))
    }))
  tool('learnhub_rebuild',
    'Run audit gate + ready-list regeneration for all enabled courses, or one course.',
    { course: { type: 'string', description: 'Course name; omit to rebuild all enabled courses' } },
    (args: { course?: string }) => run(rt, 'learnhub_rebuild', async () =>
      (await rt.engine.rebuild(args.course)).message))
  tool('learnhub_feedback',
    'Submit content feedback of a course note: reads the note「内容反馈」section and marks the node flagged + regeneration queue.',
    { path: { type: 'string', required: true, description: 'Note path, vault-relative or absolute' } },
    (args: { path: string }) => run(rt, 'learnhub_feedback', () => rt.engine.submitFeedback(rt.vault, rt.centerRel, args.path)))
  tool('learnhub_note_resolve',
    'Resolve a course note: read its frontmatter node and map the path to its enabled course via 课程注册表.yaml.',
    { path: { type: 'string', required: true, description: 'Note path, vault-relative or absolute' } },
    (args: { path: string }) => run(rt, 'learnhub_note_resolve', async () =>
      JSON.stringify(await rt.engine.resolveNote(rt.vault, args.path, rt.centerRel))))
  tool('learnhub_course_reset',
    'Reset one course for full regeneration: all node notes are backed up into .trash/regenerate-<ts>/ and rewritten as ungenerated skeletons; the question bank, interactive artifacts, and generated-image dirs move into the same backup. The graph, learning progress, and prompt snapshots are kept. Regeneration then runs as a background chain over all nodes in graph topological order (each node: outline → sections → quiz) and this call returns immediately with the queued count; progress shows in the panel generate tab. Refuses while generation tasks are running. Destructive but recoverable — confirm with the user before calling. The sediment layer (learner-model state: FSRS params, calibration profile) is NEVER touched — surface that as its own separate confirmation item (#139).',
    { course: { type: 'string', required: true, description: 'Course name' } },
    (args: { course: string }) => run(rt, 'learnhub_course_reset', async () => {
      const r = await resetCourseChain(rt, ctx, args.course)
      return JSON.stringify({ message: `已重置「${args.course}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成（后台链，进度看任务注册表）。沉淀层波及：${r.reset.sediment}`, reset: r.reset, queued: r.queued })
    }))
  tool('learnhub_course_delete',
    'Delete one course: remove it from the course registry and move the whole course directory into 学习中心/.trash/ (recoverable by hand). Learning progress lives inside the course directory, so it goes too. Destructive — confirm with the user before calling; for a content-only redo prefer learnhub_course_reset (keeps the graph and progress).',
    { course: { type: 'string', required: true, description: 'Course name' } },
    (args: { course: string }) => run(rt, 'learnhub_course_delete', async () => {
      const r = await rt.engine.courseDelete(args.course)
      await sweepGenJobs(rt) // 写侧联动（ADR-0039）：任务记录随课程删除出册
      return JSON.stringify({ message: `已删除「${r.removed}」（整课目录移入 .trash，可手工恢复）。沉淀层波及：${r.sediment}`, ...r })
    }))
  tool('learnhub_optimize_params',
    'Manually trigger FSRS-6 personal parameter optimization (A2, never automatic — like Anki): retrains the 21 scheduling parameters from the learner\'s real review log (synthetic initializations excluded, first push per card per day) across all enabled courses. Gates: at least 400 real review pushes are required, and the trained parameters must evaluate strictly better than the current/default parameters (same-protocol logLoss comparison) — otherwise nothing is written and the skip reason is returned with the metrics. On success the one learner-level parameter set is written to every enabled course\'s fsrs参数.json with full training metadata (count/date/metrics); the scheduler picks it up with zero changes. Expect ~a few seconds of training.',
    {},
    () => run(rt, 'learnhub_optimize_params', async () =>
      JSON.stringify(await rt.engine.optimizeFsrsParams())))
  tool('learnhub_content_check',
    'Run the automated content quality gates (out-of-scope references, alias consistency, unregistered code-block languages, interactive file existence) on an existing course note without applying anything. Run this after manually editing a course note in the vault; fix every reported finding.',
    {
      course: { type: 'string', required: true, description: 'Course name' },
      node: { type: 'string', required: true, description: 'Node name' },
    },
    (args: { course: string; node: string }) => run(rt, 'learnhub_content_check', async () =>
      JSON.stringify(await rt.engine.contentCheck(args.course, args.node))))
}
