/**
 * 工具面·例外 handler（#169；ADR-0045 裁定 2）：只放**走不了生成路径**的工具
 * （66/111 条：形状要加工 37／实参要换算 29）。
 * 其余 45 条由注册表声明驱动（`engine` + `bind` →
 * `run(rt, tool, async () => JSON.stringify(await engine(...)))`）。
 *
 * 写成**工厂**而不是模块级表：handler 体要用 registerTools 闭包里的 `rt`／`ctx`。
 * 键是工具名（与注册表 agent 通道同源）；门④·agent 侧断言键集合恰等于没有 bind 的 agent 通道集合。
 */
import type { Context } from '@deepseek-ai/cordis'
import { ANKI_ENDPOINT, AnkiConnectClient } from '../engine/index.ts'
import { applyId, bandPref, graphKind, questionCount, rejectId, requireSkipDirection } from '../tool-contracts.ts'
import { llmSeam, llmView } from './llm.ts'
import { run, stripFences } from './runtime.ts'
import type { HostRuntime } from './runtime.ts'
import {
  enqueueGeneration, enqueueQuizGeneration, generateProjectMilestone, generateProjectPlan,
  generateSection, resetCourseChain, sessionStartCheckpoint, sweepGenJobs, triggerPlanGrowth, waitForQuizJob,
} from './jobs.ts'

export function toolHandlers(rt: HostRuntime, ctx: Context): Record<string, (args: never) => Promise<string>> {
  return {
  'learnhub_status': () => run(rt, 'learnhub_status', async () => {
      sessionStartCheckpoint(rt, ctx) // 会话开始触点（agent 会话开工 = 同一面板打开语义，节流共用）
      return JSON.stringify({ ...(await rt.engine.statusJson()), llm: llmView() })
    }),
  'learnhub_skip': (args: { course: string; node: string; skipped?: boolean }) => run(rt, 'learnhub_skip', async () =>
      JSON.stringify(await rt.engine.nodeSkip(args.course, args.node, requireSkipDirection(args.skipped)))),
  'learnhub_complete': (args: { course: string; node: string; force?: boolean }) => run(rt, 'learnhub_complete', async () =>
      JSON.stringify(await rt.engine.nodeComplete(args.course, args.node, args.force === true))),
  'learnhub_recommend': (args: { limit?: number }) => run(rt, 'learnhub_recommend', async () =>
      JSON.stringify(await rt.engine.recommend(args.limit === undefined ? 5 : args.limit))),
  'learnhub_pin_today': (args: { course: string; node: string; cue?: string; action?: string }) => run(rt, 'learnhub_pin_today', async () =>
      JSON.stringify(await rt.engine.pinToday(args.course, args.node, undefined, { cue: args.cue, action: args.action }))),
  'learnhub_goal_intention': (args: { course: string; node: string; cue?: string; action?: string }) => run(rt, 'learnhub_goal_intention', async () =>
      JSON.stringify(await rt.engine.setGoalIntention(args.course, args.node, { cue: args.cue, action: args.action }))),
  'learnhub_review_queue': (args: { course?: string; node?: string; band_pref?: string }) => run(rt, 'learnhub_review_queue', async () =>
      JSON.stringify(await rt.engine.reviewQueue(args.course, args.node, undefined, bandPref(args.band_pref)))),
  'learnhub_question_answer': (args: { course: string; node: string; qid: string; answer: string; predicted?: string }) => run(rt, 'learnhub_question_answer', async () =>
      JSON.stringify(await rt.engine.questionAnswer(
        llmSeam(ctx), args.course, args.node, args.qid, args.answer,
        null, { ...(args.predicted !== undefined ? { predicted: args.predicted as never } : {}) }))),
  'learnhub_generate': (args: { course: string; node: string; style?: string }) => run(rt, 'learnhub_generate', () =>
      enqueueGeneration(rt, ctx, args.course, args.node, args.style)),
  'learnhub_section_rewrite': (args: { course: string; node: string; section: string }) => run(rt, 'learnhub_section_rewrite', async () =>
      generateSection(rt, ctx, args.course, args.node, args.section)),
  'learnhub_coach': () => run(rt, 'learnhub_coach', async () => JSON.stringify(await rt.engine.coachAdvice())),
  'learnhub_calibration_profile': () => run(rt, 'learnhub_calibration_profile', async () => JSON.stringify(await rt.engine.calibrationProfile())),
  'learnhub_sleep_config': (args: { enabled?: boolean }) => run(rt, 'learnhub_sleep_config', async () =>
      JSON.stringify(args.enabled === undefined
        ? await rt.engine.sleepAdviceConfig()
        : await rt.engine.setSleepAdviceConfig({ enabled: args.enabled }))),
  'learnhub_graph_propose': (args: { kind: string; yaml: string }) => run(rt, 'learnhub_graph_propose', async () =>
      JSON.stringify(await rt.engine.graphPropose(graphKind(args.kind), args.yaml))),
  'learnhub_vault_links_scan': () => run(rt, 'learnhub_vault_links_scan', async () =>
      JSON.stringify(await rt.engine.vaultLinksScan())),
  'learnhub_graph_apply': async (args: { kind: string; id?: number; reject?: boolean; note?: string }) =>
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
      }),
  'learnhub_compass_paint': (args: { course?: string }) => run(rt, 'learnhub_compass_paint', async () =>
      JSON.stringify(await rt.engine.compassPaint(args.course, llmSeam(ctx)))),
  'learnhub_question_audit': () => run(rt, 'learnhub_question_audit', async () => JSON.stringify(await rt.engine.questionAudit())),
  'learnhub_question_generate': (args: { course: string; node: string; count?: number }) => run(rt, 'learnhub_question_generate', async () => {
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
    }),
  'learnhub_question_update': (args: { course: string; node: string; qid: string; patch: Record<string, unknown> }) => run(rt, 'learnhub_question_update', async () => {
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
    }),
  'learnhub_bank_cleanup': (args: { course?: string; apply?: boolean }) => run(rt, 'learnhub_bank_cleanup', async () =>
      JSON.stringify(args.apply === true
        ? { applied: await rt.engine.bankCleanupApply(args.course) }
        : await rt.engine.bankCleanupPreview(args.course))),
  'learnhub_project_create': (args: { name: string; goal: string; tier?: string }) => run(rt, 'learnhub_project_create', async () =>
      JSON.stringify(await rt.engine.projectCreate({
        name: args.name, goal: args.goal,
        ...(args.tier !== undefined ? { tier: args.tier as never } : {}),
      }))),
  'learnhub_project_list': () => run(rt, 'learnhub_project_list', async () => JSON.stringify(await rt.engine.projectList())),
  'learnhub_project_plan_generate': (args: { id: string }) => run(rt, 'learnhub_project_plan_generate', () => generateProjectPlan(rt, ctx, args.id)),
  'learnhub_project_milestone_generate': (args: { id: string; milestone: string }) => run(rt, 'learnhub_project_milestone_generate', () =>
      generateProjectMilestone(rt, ctx, args.id, args.milestone)),
  'learnhub_project_apply': (args: { id: number }) => run(rt, 'learnhub_project_apply', async () => {
      const result = await rt.engine.projectApply(args.id)
      triggerPlanGrowth(rt, ctx, result)
      return JSON.stringify(result)
    }),
  'learnhub_project_milestone_recall': (args: { id: string; milestone: string; nodes?: string[]; limit?: number }) => run(rt, 'learnhub_project_milestone_recall', async () =>
      JSON.stringify(await rt.engine.projectMilestoneRecall(args.id, args.milestone, { nodes: args.nodes, limit: args.limit }))),
  'learnhub_project_enc_candidates': (args: { id: string; milestone?: string; nodes?: string[]; window_days?: number; min_co?: number }) => run(rt, 'learnhub_project_enc_candidates', async () =>
      JSON.stringify(await rt.engine.projectEncCandidates(args.id, { milestone: args.milestone, nodes: args.nodes, window_days: args.window_days, min_co: args.min_co }))),
  'learnhub_project_decompile': (args: { id: string; goal?: string; course?: string; notes?: string[] }) => run(rt, 'learnhub_project_decompile', async () =>
      JSON.stringify(await rt.engine.projectDecompile(
        args.id,
        {
          ...(args.goal !== undefined ? { goal: args.goal } : {}),
          ...(args.course !== undefined ? { course: args.course } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
        },
        llmSeam(ctx),
      ))),
  'learnhub_project_exec_log': (args: { id: string; source: string; rating?: number; evidence?: { accuracy?: number; self_help?: number }; nodes?: string[]; note?: string }) => run(rt, 'learnhub_project_exec_log', async () =>
      JSON.stringify(await rt.engine.projectExecLog(args.id, {
        source: args.source,
        ...(args.rating !== undefined ? { rating: args.rating } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
        ...(args.nodes !== undefined ? { nodes: args.nodes } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
      }))),
  'learnhub_explain_back_pack': (args: { course: string; node: string }) => run(rt, 'learnhub_explain_back_pack', () =>
      rt.engine.explainBackPack(args.course, args.node)),
  'learnhub_explain_feedback': (args: { course: string; node: string; transcript: string }) => run(rt, 'learnhub_explain_feedback', async () =>
      JSON.stringify(await rt.engine.explainBackFeedback(args.course, args.node, args.transcript, llmSeam(ctx)))),
  'learnhub_learner_card_add': (args: { course: string; node: string; content: string; kind?: string; prompt?: string; section?: string }) => run(rt, 'learnhub_learner_card_add', async () => {
      if (!args.content?.trim()) throw new Error('[learner-card-add] content 必填——存的是学习者自己的话。')
      return JSON.stringify(await rt.engine.explainArchiveCard(args.course, args.node, {
        content: args.content,
        ...(args.kind !== undefined ? { kind: args.kind as 'recall_cue' | 'cloze_rewrite' } : {}),
        ...(args.prompt !== undefined && args.prompt.trim() ? { prompt: args.prompt } : {}),
        ...(args.section !== undefined && args.section.trim() ? { section: args.section } : {}),
      }))
    }),
  'learnhub_understanding_add': (args: { course: string; node: string; content: string; section?: string; kind?: string; prompt?: string }) => run(rt, 'learnhub_understanding_add', async () => {
      if (!args.content?.trim()) throw new Error('[understanding] content 必填——存的是学习者自己的话。')
      return JSON.stringify(await rt.engine.learnerNoteAdd(args.course, args.node, {
        content: args.content,
        ...(args.section !== undefined && args.section.trim() ? { section: args.section } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as never } : {}),
        ...(args.prompt !== undefined && args.prompt.trim() ? { prompt: args.prompt } : {}),
      }, llmSeam(ctx)))
    }),
  'learnhub_learner_card_archive': (args: { course: string; node: string; card: string; archived?: boolean }) => run(rt, 'learnhub_learner_card_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[learner-card-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.learnerCardArchive(args.course, args.node, args.card, args.archived))
    }),
  'learnhub_error_card_generate': (args: { course: string; node?: string; max?: number }) => run(rt, 'learnhub_error_card_generate', async () =>
      JSON.stringify(await rt.engine.errorCardGenerate(args.course, {
        ...(args.node ? { node: args.node } : {}),
        ...(args.max !== undefined ? { max: args.max } : {}),
      }, async prompt => stripFences(await llmSeam(ctx)(prompt))))),
  'learnhub_error_card_archive': (args: { course: string; node: string; card: string; archived?: boolean }) => run(rt, 'learnhub_error_card_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[error-card-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.errorCardArchive(args.course, args.node, args.card, args.archived))
    }),
  'learnhub_skill_create': (args: { name: string; maintenance_days?: number | null }) => run(rt, 'learnhub_skill_create', async () =>
      JSON.stringify(await rt.engine.skillCreate(args.name, {
        ...(args.maintenance_days !== undefined ? { maintenance_days: args.maintenance_days } : {}),
      }))),
  'learnhub_skill_list': () => run(rt, 'learnhub_skill_list', async () => JSON.stringify(await rt.engine.skillList())),
  'learnhub_skill_maintenance': (args: { skill: string; days?: number | null }) => run(rt, 'learnhub_skill_maintenance', async () =>
      JSON.stringify(await rt.engine.skillSetMaintenance(args.skill, args.days ?? null))),
  'learnhub_skill_archive': (args: { skill: string; archived?: boolean }) => run(rt, 'learnhub_skill_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[skill-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.skillArchive(args.skill, args.archived))
    }),
  'learnhub_execution_log': (args: { skill: string; source: string; minutes: number; rating?: number; evidence?: { accuracy?: number; self_help?: number }; note?: string }) =>
      run(rt, 'learnhub_execution_log', async () =>
        JSON.stringify(await rt.engine.executionLog(args.skill, {
          source: args.source as never, minutes: args.minutes,
          ...(args.rating !== undefined ? { rating: args.rating } : {}),
          ...(args.evidence ? { evidence: args.evidence } : {}),
          ...(args.note ? { note: args.note } : {}),
        }))),
  'learnhub_receipt_submit': (args: { course?: string; node: string; kind: string; material: string; force_full?: boolean }) =>
      run(rt, 'learnhub_receipt_submit', async () => {
        return JSON.stringify(await rt.engine.receiptSubmit(
          args.course, args.node,
          { kind: args.kind as never, material: args.material, ...(args.force_full !== undefined ? { force_full: args.force_full } : {}) },
          llmSeam(ctx),
        ))
      }),
  'learnhub_habit_create': (args: { name: string; cue: string; action: string }) => run(rt, 'learnhub_habit_create', async () =>
      JSON.stringify(await rt.engine.habitCreate(args))),
  'learnhub_habit_list': () => run(rt, 'learnhub_habit_list', async () => JSON.stringify(await rt.engine.habitList())),
  'learnhub_habit_repeat': (args: { habit: string; auto_rating?: number; note?: string }) => run(rt, 'learnhub_habit_repeat', async () =>
      JSON.stringify(await rt.engine.habitRepeat(args.habit, {
        ...(args.auto_rating !== undefined ? { auto_rating: args.auto_rating } : {}),
        ...(args.note ? { note: args.note } : {}),
      }))),
  'learnhub_habit_archive': (args: { habit: string; archived?: boolean }) => run(rt, 'learnhub_habit_archive', async () => {
      if (typeof args.archived !== 'boolean') throw new Error('[habit-archive] archived 必须显式给出（true 归档 / false 恢复）。')
      return JSON.stringify(await rt.engine.habitArchive(args.habit, args.archived))
    }),
  'learnhub_kata_save': (args: { week_start: string; answers: Record<string, string> }) => run(rt, 'learnhub_kata_save', async () =>
      JSON.stringify(await rt.engine.kataSave(args.week_start, args.answers as never))),
  'learnhub_kata_convert_intention': (args: { week_start: string; course: string; node: string; cue: string; action: string }) => run(rt, 'learnhub_kata_convert_intention', async () =>
      JSON.stringify(await rt.engine.kataToIntention(args.week_start,
        { course: args.course, node: args.node, cue: args.cue, action: args.action }))),
  'learnhub_experiment_templates': () => run(rt, 'learnhub_experiment_templates', async () =>
      JSON.stringify(await rt.engine.experimentTemplates())),
  'learnhub_experiment_apply': (args: { id?: number }) => run(rt, 'learnhub_experiment_apply', async () =>
      JSON.stringify(await rt.engine.experimentApply(applyId(args.id)))),
  'learnhub_thermostat': () => run(rt, 'learnhub_thermostat', async () => JSON.stringify(await rt.engine.thermostatView())),
  'learnhub_sandbox': (args: { minutes_per_day: number; weeks?: number; course?: string; nodes?: string[] }) =>
      run(rt, 'learnhub_sandbox', async () =>
        JSON.stringify(await rt.engine.sandboxRun({
          minutesPerDay: args.minutes_per_day, weeks: args.weeks, course: args.course, nodes: args.nodes,
        }))),
  'learnhub_note_source_list': () => run(rt, 'learnhub_note_source_list', async () =>
      JSON.stringify(await rt.engine.noteSourceList())),
  'learnhub_note_source_generate': (args: { id: string; count?: number }) => run(rt, 'learnhub_note_source_generate', async () => {
      const n = questionCount(args.count)
      return JSON.stringify(await rt.engine.noteSourceGenerate(args.id, n, async prompt => stripFences(await llmSeam(ctx)(prompt))))
    }),
  'learnhub_anki_export': (args: { endpoint?: string }) => run(rt, 'learnhub_anki_export', async () =>
      JSON.stringify(await rt.engine.ankiExportPush(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))),
  'learnhub_anki_import': (args: { endpoint?: string }) => run(rt, 'learnhub_anki_import', async () =>
      JSON.stringify(await rt.engine.ankiImportEvents(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))),
  'learnhub_anki_status': (args: { endpoint?: string }) => run(rt, 'learnhub_anki_status', async () =>
      JSON.stringify(await rt.engine.ankiStatus(new AnkiConnectClient(args.endpoint ?? ANKI_ENDPOINT)))),
  'learnhub_data_check': () => run(rt, 'learnhub_data_check', async () => JSON.stringify(await rt.engine.dataCheck())),
  'learnhub_probation': (args: { action?: 'status' | 'settle'; course?: string }) => run(rt, 'learnhub_probation', async () => {
      const a = (args ?? {}) as { action?: 'status' | 'settle'; course?: string }
      if (a.action === 'settle') return JSON.stringify(await rt.engine.settleRechecks(a.course))
      return JSON.stringify(await rt.engine.probationStatus(a.course))
    }),
  'learnhub_rebuild': (args: { course?: string }) => run(rt, 'learnhub_rebuild', async () =>
      (await rt.engine.rebuild(args.course)).message),
  'learnhub_feedback': (args: { path: string }) => run(rt, 'learnhub_feedback', () => rt.engine.submitFeedback(rt.vault, rt.centerRel, args.path)),
  'learnhub_note_resolve': (args: { path: string }) => run(rt, 'learnhub_note_resolve', async () =>
      JSON.stringify(await rt.engine.resolveNote(rt.vault, args.path, rt.centerRel))),
  'learnhub_course_reset': (args: { course: string }) => run(rt, 'learnhub_course_reset', async () => {
      const r = await resetCourseChain(rt, ctx, args.course)
      return JSON.stringify({ message: `已重置「${args.course}」（${r.reset.nodes.length} 节点），${r.queued} 个节点已入队重新生成（后台链，进度看任务注册表）。沉淀层波及：${r.reset.sediment}`, reset: r.reset, queued: r.queued })
    }),
  'learnhub_course_delete': (args: { course: string }) => run(rt, 'learnhub_course_delete', async () => {
      const r = await rt.engine.courseDelete(args.course)
      await sweepGenJobs(rt) // 写侧联动（ADR-0039）：任务记录随课程删除出册
      return JSON.stringify({ message: `已删除「${r.removed}」（整课目录移入 .trash，可手工恢复）。沉淀层波及：${r.sediment}`, ...r })
    }),
  'learnhub_optimize_params': () => run(rt, 'learnhub_optimize_params', async () =>
      JSON.stringify(await rt.engine.optimizeFsrsParams())),
  }
}
