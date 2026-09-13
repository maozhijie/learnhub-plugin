/**
 * 项目域（P 区 / ADR-0015 Project 姊妹实体；#92，设计 docs/design/2026-09-project-artifact-design.md）。
 *
 * 工作区 学习中心/projects/<id>/：项目.md（身份 + plan YAML frontmatter）与
 * milestones/NN-<slug>.md（四块任务卡产物，单文件单次生成）。零 XP、零 FSRS、
 * 不进 sessions/srs（节点消费者零改动）；里程碑计划与已生成产物的修订走带快照的
 * 提案通道（proposal store kind 泛化，快照 = 被替换的计划 YAML / 产物旧文），
 * 不静默覆盖。渐退档（骨架/补全/独立）是项目属性，产物形态随档生成。
 *
 * Missing/Broken 纪律沿用 ADR-0004：项目文件缺失 = 合法空态（清单跳过）；
 * 存在但坏 = Broken 抛出。
 */
import type { VaultFs } from './io.ts'
import { YAML } from './yaml.ts'
// FadingTier/FADING_TIERS 住 types.ts、PlanItem 与计划产物校验住 project-decompile.ts
// （#152 刀 5 归位：project-exec/project-decompile 反向引用，留原地即成环）；
// 原路径 re-export，门面与 tests 的既有导入路径不晃。
export type { FadingTier } from './types.ts'
export { FADING_TIERS } from './types.ts'
import { FADING_TIERS } from './types.ts'
import type { FadingTier } from './types.ts'
export type { PlanItem } from './project-decompile.ts'
export { validatePlanItems, validatePlanArtifact } from './project-decompile.ts'
import type { PlanItem } from './project-decompile.ts'
import { validatePlanItems, validatePlanArtifact } from './project-decompile.ts'
import { todayStr } from './dates.ts'
import { Content } from './content.ts'
import type { Clock } from './clock.ts'
import { readProbationLedger, foldProbation } from './probation.ts'
import { Store } from './store.ts'
import { atomicWrite } from './io.ts'
import { loadNote, saveNote } from './notes.ts'
import { safeFilename } from './paths.ts'
import type { Paths } from './paths.ts'
import type { Registry } from './registry.ts'
import type { QuestionBank, BankQuestion } from './question-bank.ts'
import type { GraphProposals, EnrichFieldEntry } from './proposals.ts'
import type { NoteSourceManifest } from './note-source.ts'
import type { Graph } from './graph.ts'
import type { ProjectCrossDoc, ProjectExecBackflow, ProjectExecResult } from './views/project.ts'
import { declaredEncOf } from './graph.ts'
import type { BrokenNote } from './notes.ts'
import type { CourseEntry, Fm } from './types.ts'
import type { AgentSeam, GateVerdict } from './agent.ts'
import type { GraphApplyResult } from './views/graph.ts'
import type { GraphProposeResult } from './views/proposals.ts'

import { applyPracticeEvidence } from './grading.ts'
import { masteryOfFm } from './srs.ts'
import type { ExecutionEvidence } from './skills.ts'
import { ratingFromEvidence } from './skills.ts'

import { difficultyCalibration, milestonePrice } from './xp.ts'
import { dayOfTs, nowIsoOf } from './dates.ts'
import { CROSS_AXIS_THRESHOLD, TIER_REC_DEMOTE_SCORE, TIER_REC_MIN_EVENTS, TIER_REC_PROMOTE_SCORE, XP_PER_MILESTONE_DEFAULT } from './params.ts'
import { execRatingScore, exercisedEncEdges, classifyCross, masteryAggregate, execEvidenceScore, recommendTier, validateExecEvent, appendExecRec, execRecsAll } from './project-exec.ts'
import type { ProjectExecRec } from './project-exec.ts'
import { searchVaultPrior, priorSection } from './vault-prior.ts'

import { decompileGoalOf, decompileTerms, splitDecompileDoc, decompileRepairPrompt, reconcilePlanNodes, splitNodeSpec } from './project-decompile.ts'
import type { DecompileDoc } from './project-decompile.ts'
import { drawRecallQuestions, appendRecallRec, recallRecsAll } from './project-recall.ts'
import type { RecallQuestion, RecallRec } from './project-recall.ts'
import { cooccurrencePairs, orientCandidate, coWeight } from './project-enc.ts'
import { fingerprintOf } from './note-source.ts'
import type { ProposalRec, JournalRec } from './types.ts'

/** 项目日志文件头（V-5 #113：首次追加时落一次；说明口径与注册语义）。 */
export const PROJECT_LOG_HEADER
  = '# 项目日志\n\n> 学习者的自由项目记录：做了什么、卡在哪、学到了什么。引擎只提供落盘与注册，\n> 不替你写；经笔记源注册通道注册后可从这份日志出复习题（引擎对它只读+出题）。\n\n'

export type ProjectLifecycle = 'active' | 'paused' | 'delivered' | 'archived'
export const PROJECT_LIFECYCLES: ProjectLifecycle[] = ['active', 'paused', 'delivered', 'archived']

/** 渐退档（Fading Tier）：骨架→补全→独立；项目属性，产物形态随档生成（ADR-0015）。 */

/** 窄化谓词（校验与 as 转换共用，防各处手写 includes 散落漂移）。 */
export function isProjectLifecycle(v: unknown): v is ProjectLifecycle {
  return (PROJECT_LIFECYCLES as string[]).includes(v as string)
}
export function isFadingTier(v: unknown): v is FadingTier {
  return (FADING_TIERS as string[]).includes(v as string)
}

/** 项目 frontmatter（项目.md；设计 §1 schema）。 */
export interface ProjectFm {
  id: string
  name: string
  lifecycle: ProjectLifecycle
  tier: FadingTier
  /** 学习者目标描述原文。 */
  goal: string
  /** 里程碑计划；空数组 = 还没有计划（初次规划提案的合法起点）。 */
  plan: PlanItem[]
  /** 出处戳用日历日（学习日口径不适用于项目域——项目零调度）。 */
  created: string
  updated: string
}

/** 计划条目 schema 校验（结构门：id/name/task_class/acceptance_hints 非空 + id 唯一）。
 * 3–8 个与 1–2 周粒度是提示词侧引导（设计 §3「粒度引导（提示词约束）」），不做硬门。 */

/** 项目 frontmatter 契约校验（读侧与写侧共用同一口径）。 */
export function validateProjectFm(raw: unknown, path: string): ProjectFm {
  const bad = (detail: string): Error =>
    new Error(`[projects] 项目档案 Broken（位置：${path}）\n  ✗ ${detail}`)
  if (typeof raw !== 'object' || raw === null) throw bad('frontmatter 必须是映射')
  const d = raw as Record<string, unknown>
  const id = typeof d.id === 'string' ? d.id.trim() : ''
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (!id) throw bad('id: 不能为空')
  if (!name) throw bad('name: 不能为空')
  if (!(PROJECT_LIFECYCLES as string[]).includes(String(d.lifecycle))) {
    throw bad(`lifecycle: 非法值 ${String(d.lifecycle)}（允许 ${PROJECT_LIFECYCLES.join('/')}）`)
  }
  if (!isFadingTier(d.tier)) {
    throw bad(`tier: 非法值 ${String(d.tier)}（允许 ${FADING_TIERS.join('/')}）`)
  }
  if (typeof d.goal !== 'string') throw bad('goal: 不能为空（学习者目标描述原文）')
  const plan = validatePlanItems(d.plan ?? [])
  if (plan.errors.length) throw bad(plan.errors.join('；'))
  if (typeof d.created !== 'string' || !d.created) throw bad('created: 不能为空')
  if (typeof d.updated !== 'string' || !d.updated) throw bad('updated: 不能为空')
  return {
    id,
    name,
    lifecycle: d.lifecycle as ProjectLifecycle,
    tier: d.tier as FadingTier,
    goal: d.goal,
    plan: plan.plan,
    created: d.created,
    updated: d.updated,
  }
}

// ---- 里程碑产物轻量结构机检（设计 §6：替代课程域渲染/题目门） ----

export interface MilestoneGateReport { passed: boolean; findings: string[]; warns: string[] }

const MILESTONE_BLOCKS = ['给定', '待办', '验收清单', '支持'] as const

/** 四块齐全；各块非空；验收清单至少一条 - [ ] 行为句条目；无题目泄漏；档位一致性
 * （独立档不得出现补全档的【待补全】缺口标记）。机器只锁结构与档位形态，行为句
 * 质量与解法路径缺省由提示词承载。 */
export function gateMilestone(md: string, tier: FadingTier): MilestoneGateReport {
  const findings: string[] = []
  const warns: string[] = []
  const blocks = new Map<string, string>()
  for (const part of md.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n')
    const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
    const body = nl >= 0 ? part.slice(nl + 1) : ''
    if (blocks.has(title)) warns.push(`重复块「${title}」（保留首块，重复块忽略）`)
    else blocks.set(title, body)
  }
  for (const b of MILESTONE_BLOCKS) {
    if (!blocks.has(b)) findings.push(`缺少「## ${b}」块（四块固定结构：给定/待办/验收清单/支持）`)
  }
  for (const b of MILESTONE_BLOCKS) {
    const body = (blocks.get(b) ?? '').trim()
    if (blocks.has(b) && !body) findings.push(`「${b}」块为空`)
  }
  const checklist = blocks.get('验收清单') ?? ''
  if (blocks.has('验收清单') && checklist.trim() && !/^- \[[ xX]\] .+/m.test(checklist)) {
    findings.push('「验收清单」没有 - [ ] 条目（至少一条可自核对的行为句）')
  }
  if (tier === '独立' && (blocks.get('给定') ?? '').includes('【待补全】')) {
    findings.push('独立档「给定」出现【待补全】缺口标记（那是补全档形态；独立档只给情境与起点，不含解法路径）')
  }
  // 无题目泄漏（设计 §6）：课程域练习元数据与题库 schema 字段不得出现在项目产物
  if (/<!--\s*ex:\d+/.test(md)) findings.push('出现课程域练习元数据 <!-- ex:N -->（项目产物不出题）')
  if (/^\s*(kind|answer|options|tol):\s*/m.test(md) && /kind:\s*(single_choice|multi_choice|true_false|fill_in_blank|numeric|ordering|matching|reflection|open_question)/.test(md)) {
    findings.push('出现题库题目 schema 字段（kind: 题型…）——项目产物不出题，能力核对只走验收清单')
  }
  return { passed: !findings.length, findings, warns }
}

/** 计划序位 → 产物文件名（设计 §1 布局：NN-<slug>.md）。 */
export function milestoneFileOf(planIndex: number, name: string): string {
  return `${String(planIndex + 1).padStart(2, '0')}-${safeFilename(name)}.md`
}

/** 提案产物文档（state/proposals/<pid>-<kind>-<project>.yaml）。 */
export interface PlanArtifact { project: string; plan: PlanItem[] }
export interface MilestoneArtifact { project: string; milestone: string; md: string }

/** 校验提案产物文档 → 错误行或规格（project 必须与提案 course 一致）。 */

export function validateMilestoneArtifact(doc: unknown, projectId: string): { errors?: string[]; milestone?: string; md?: string } {
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (d.project !== projectId) return { errors: [`project: 「${String(d.project)}」与目标项目「${projectId}」不一致`] }
  const milestone = typeof d.milestone === 'string' ? d.milestone.trim() : ''
  const md = typeof d.md === 'string' ? d.md : ''
  const errors: string[] = []
  if (!milestone) errors.push('milestone: 不能为空（计划里的里程碑 id）')
  if (!md.trim()) errors.push('md: 产物正文不能为空')
  return errors.length ? { errors } : { milestone, md }
}

export interface ProjectView {
  fm: ProjectFm
  /** 计划条目 × 产物落盘状态（file 按当前计划序位推导）。 */
  milestones: Array<{ id: string; name: string; task_class: string; acceptance_hints: string; file: string; generated: boolean }>
  /** milestones/ 下不匹配当前计划的遗留文件（计划修订后的漂移提示）。 */
  orphans: string[]
}

// ---- 计划修订快照 diff（#149：里程碑身份锚钉 id，修订驱动教练换线/补支的触发器原料） ----

/** 修订 diff（applyPlan 快照的前后 plan 派生，零新存储——快照语义的第二个消费方）：
 * added/removed 按 id 差集；retargeted = 同 id 而 nodes 集合变化（重指 = 换线判定的
 * 原料）。其余同 id 内容变化（name/est/验收口径微调）不入 diff——里程碑身份与消费
 * 挂靠都没变，不改生长方向（id 是身份锚：序位与文件名会漂移，id 不漂移）。 */
export interface PlanRevisionDiff {
  added: PlanItem[]
  removed: PlanItem[]
  retargeted: Array<{ id: string; name: string; before: string[]; after: string[] }>
}

/** nodes 集合比较（去重 + 与顺序无关——nodes 是抽题池/行使域的集合语义）。 */
function nodesSetEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const sa = [...new Set(a ?? [])].sort()
  const sb = [...new Set(b ?? [])].sort()
  return sa.length === sb.length && sa.every((v, i) => v === sb[i])
}

/** 快照 diff（纯函数）：id 为身份锚派生 {added, removed, retargeted}。stable 排序
 * （按 id）保证同输入同输出，注入生长批可回放。 */
export function planRevisionDiff(oldPlan: PlanItem[], newPlan: PlanItem[]): PlanRevisionDiff {
  const oldById = new Map(oldPlan.map(m => [m.id, m]))
  const newById = new Map(newPlan.map(m => [m.id, m]))
  const added = newPlan.filter(m => !oldById.has(m.id))
  const removed = oldPlan.filter(m => !newById.has(m.id))
  const retargeted = newPlan
    .filter(m => oldById.has(m.id) && !nodesSetEqual(oldById.get(m.id)!.nodes, m.nodes))
    .map(m => ({
      id: m.id, name: m.name,
      before: [...new Set(oldById.get(m.id)!.nodes ?? [])],
      after: [...new Set(m.nodes ?? [])],
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { added, removed, retargeted }
}

/** 计划修订的生长触发（#149：快照 diff 驱动教练换线/补支）：每个有锚定课程的课程
 * 一条——lines 是已渲染的注入行（coach 生长批的 inject 块正文），宿主据此入队
 * phase=生长 任务。无锚定课程的 diff 行落 plan_diff_warnings 不强路由（诚实降级）。 */
export interface PlanGrowthTrigger {
  course: string
  lines: string[]
}

/** 项目提案 apply 结果（判别联合：kind 区分计划/里程碑）。project_plan 变体可携带
 * 修订 diff 与生长触发（初次规划 diff 照产——空计划起点的 added=全量；无引擎侧
 * 解析面时（纯 Projects 类）growth 缺省）。 */
export type ProjectApplyResult =
  | { kind: 'project_plan'; project: string; milestones: number; snapshot: string | null;
      /** 计划修订快照 diff（旧计划 → 新计划，id 为身份锚；引擎 apply 包装层填写）。 */
      plan_diff?: PlanRevisionDiff
      /** 已过点里程碑被修订移除的显式警告（不拒绝——账本事实不改写，但「终点消失」要可见）。 */
      plan_diff_warnings?: string[]
      /** 换线/补支触发（按锚定课程聚合；宿主入队生长批）。 */
      growth?: PlanGrowthTrigger[] }
  | { kind: 'project_milestone'; project: string; milestone: string; file: string; snapshot: string }

export class Projects {
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  private paths: Paths
  private store: Store
  private clock: Clock
  private fs: VaultFs
  constructor(paths: Paths, store: Store, clock: Clock, fs: VaultFs) {
    this.paths = paths
    this.store = store
    this.clock = clock
    this.fs = fs
  }

  /** 全部项目（按目录名序）。目录存在但项目.md 缺失 = 跳过（半建状态不算 Broken）。 */
  async list(): Promise<ProjectFm[]> {
    if (!this.fs.exists(this.paths.projectsDir)) return []
    const out: ProjectFm[] = []
    for (const ent of await this.fs.readdirTypes(this.paths.projectsDir)) {
      if (!ent.directory) continue
      const p = this.paths.projectNotePath(ent.name)
      if (!this.fs.exists(p)) continue
      out.push(await this.load(ent.name))
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 读单个项目；不存在 = Missing 报错（调用方决定语义）。存在但坏 = Broken。 */
  async load(id: string): Promise<ProjectFm> {
    const p = this.paths.projectNotePath(id)
    if (!this.fs.exists(p)) throw new Error(`[projects] 项目「${id}」不存在（Missing）：先 learnhub_project_create。`)
    const { fm } = await loadNote(p, this.fs)
    return validateProjectFm(fm, p)
  }

  /** 建项目骨架：id 缺省取安全化名称；同名项目已存在即拒绝。 */
  async create(input: { name: string; goal: string; tier?: FadingTier; id?: string }): Promise<ProjectFm> {
    const name = input.name.trim()
    const goal = input.goal.trim()
    if (!name) throw new Error('[project-create] name 不能为空。')
    if (!goal) throw new Error('[project-create] goal 不能为空（学习者目标描述原文）。')
    const tier = input.tier ?? '补全'
    if (!isFadingTier(tier)) {
      throw new Error(`[project-create] tier 非法：${String(tier)}（允许 ${FADING_TIERS.join('/')}）`)
    }
    const id = (input.id ?? safeFilename(name)).trim()
    if (!id || id.includes('..')) throw new Error(`[project-create] id 非法：${id}`)
    const p = this.paths.projectNotePath(id)
    if (this.fs.exists(p)) throw new Error(`[project-create] 项目「${id}」已存在（${p}）。`)
    const today = todayStr(new Date(this.clock.nowMs()))
    const fm: ProjectFm = { id, name, lifecycle: 'active', tier, goal, plan: [], created: today, updated: today }
    await this.fs.mkdir(this.paths.projectDir(id))
    await this.fs.mkdir(this.paths.projectMilestoneDir(id))
    await saveNote(p, fm as unknown as Record<string, unknown>, `# ${name}\n\n> 目标：${goal}\n\n（里程碑计划走 learnhub_project_plan_generate 提案通道；产物见 milestones/。）\n`, this.fs)
    return fm
  }

  /** 全量写回项目 frontmatter（updated 随写随戳；body 不动）。 */
  async saveFm(id: string, fm: ProjectFm): Promise<void> {
    const p = this.paths.projectNotePath(id)
    if (!this.fs.exists(p)) throw new Error(`[projects] 项目「${id}」不存在（Missing）。`)
    const { body } = await loadNote(p, this.fs)
    await saveNote(p, { ...fm, updated: todayStr(new Date(this.clock.nowMs())) } as unknown as Record<string, unknown>, body, this.fs)
  }

  /** 项目视图：计划 × 产物落盘状态 + 遗留文件。 */
  async view(id: string): Promise<ProjectView> {
    const fm = await this.load(id)
    const expected = new Map(fm.plan.map((m, i) => [milestoneFileOf(i, m.name), m]))
    const orphans: string[] = []
    const dir = this.paths.projectMilestoneDir(id)
    if (this.fs.exists(dir)) {
      for (const f of await this.fs.readdir(dir)) {
        if (!expected.has(f)) orphans.push(f)
      }
    }
    return {
      fm,
      milestones: fm.plan.map((m, i) => {
        const file = milestoneFileOf(i, m.name)
        return { id: m.id, name: m.name, task_class: m.task_class, acceptance_hints: m.acceptance_hints, file, generated: this.fs.exists(this.paths.projectMilestonePath(id, file)) }
      }),
      orphans,
    }
  }

  // ---- 计划提案（project_plan；带快照的修订通道，设计 §7） ----

  async proposePlan(
    projectId: string, yamlText: string, opts: { pair?: number } = {},
  ): Promise<{ id: number; kind: 'project_plan'; project: string; milestones: number; initial: boolean }> {
    const project = await this.load(projectId)
    let doc: unknown
    try {
      doc = YAML.parseModel(yamlText)
    } catch (err) {
      throw new Error(`[project-plan-propose] YAML 无法解析，提案未受理。\n  ✗ ${err instanceof Error ? err.message : String(err)}`)
    }
    const v = validatePlanArtifact(doc, projectId)
    if (v.errors || !v.plan) {
      throw new Error(`[project-plan-propose] schema 校验失败，提案未受理。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const initial = project.plan.length === 0
    // 注册表条目出生即完整（ADR-0053 契约下空 artifact 是违约形态）：路径经构造器形态
    // 随条目一次落盘；pair 出生即写（#149 同源双提案——种子半区先建、号已知，计划半区
    // 落盘那一刻就带联动，任一时刻崩溃都不会留下可单边 apply 的无守卫计划半区）。
    const pid = await this.store.createProposal('project_plan', projectId,
      `${initial ? '初次规划' : '计划修订'}：${v.plan.length} 个里程碑`,
      id => this.paths.proposalArtifactPath(id, 'project_plan', projectId),
      opts.pair !== undefined ? { pair: opts.pair } : {})
    const path = this.paths.proposalArtifactPath(pid, 'project_plan', projectId)
    await atomicWrite(path, YAML.stringify(doc), this.fs)
    return { id: pid, kind: 'project_plan', project: projectId, milestones: v.plan.length, initial }
  }

  /** apply 计划提案：被替换的旧计划 YAML 落快照（初次规划无快照），不静默覆盖。
   * 同源双提案守卫（#149）：反编译 pair 联动的计划提案不得先于种子半区单独 apply
   * （计划引用悬空节点炸消费面）——联合入口走 opts.pairApply 豁免。 */
  async applyPlan(pid?: number, opts: { pairApply?: boolean } = {}): Promise<ProjectApplyResult> {
    const prop = await this.store.takePending('project_plan', pid)
    const block = Store.pairApplyBlock(prop, await this.store.loadProposals(), opts)
    if (block) throw new Error(`[project-plan-apply] ${block}`)
    const v = validatePlanArtifact(await this.loadArtifact(prop), prop.course)
    if (v.errors || !v.plan) {
      throw new Error(`[project-plan-apply] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const project = await this.load(prop.course)
    let snapshot: string | null = null
    if (project.plan.length) {
      snapshot = this.paths.projectSnapshotPath(prop.id, 'plan.yaml')
      await atomicWrite(snapshot, YAML.stringify({ project: project.id, plan: project.plan }), this.fs)
    }
    await this.saveFm(project.id, { ...project, plan: v.plan })
    // 不写 journal：journal 是学习行为流水（streak/热力图聚合它的全部行），项目域写它会
    // 涨 streak——违反 ADR-0015 裁决 7「节点消费者对 Project 不可见」。留痕 = 提案记录本身
    // （pending/applied + decision_note 带快照路径）。
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(),
      decision_note: snapshot ? `快照 ${snapshot}` : '初次规划（无旧计划，无快照）',
    })
    return { kind: 'project_plan', project: project.id, milestones: v.plan.length, snapshot }
  }

  // ---- 里程碑产物（首生直落，重生成走 project_milestone 提案） ----

  /** 计划条目定位 → {project, item, index, file}。 */
  private async locateMilestone(projectId: string, milestoneId: string) {
    const project = await this.load(projectId)
    const index = project.plan.findIndex(m => m.id === milestoneId)
    if (index < 0) {
      throw new Error(`[project-milestone] 项目「${projectId}」的计划里没有里程碑「${milestoneId}」（先修订计划）。`)
    }
    return { project, item: project.plan[index], index, file: milestoneFileOf(index, project.plan[index].name) }
  }

  /** 首次生成：文件尚不存在才允许直落（过轻量结构门）；已生成 = 重生成语义，拒绝。 */
  async generateMilestone(projectId: string, milestoneId: string, md: string): Promise<{ written: string; tier: FadingTier }> {
    const { project, file } = await this.locateMilestone(projectId, milestoneId)
    const path = this.paths.projectMilestonePath(projectId, file)
    if (this.fs.exists(path)) {
      throw new Error(`[project-milestone] 「${file}」已生成——按档重生成走提案通道（learnhub_project_milestone_generate 会自动转提案，apply 后带快照覆盖）。`)
    }
    this.gateOrFail(md, project.tier)
    await atomicWrite(path, md.trimEnd() + '\n', this.fs)
    return { written: file, tier: project.tier }
  }

  /** 按档重生成提案：产物已存在时唯一合法的覆盖通道（带快照，设计 §4/§7）。 */
  async proposeMilestone(projectId: string, milestoneId: string, md: string): Promise<{ id: number; kind: 'project_milestone'; project: string; milestone: string; file: string }> {
    const { project, item, file } = await this.locateMilestone(projectId, milestoneId)
    const path = this.paths.projectMilestonePath(projectId, file)
    if (!this.fs.exists(path)) {
      throw new Error(`[project-milestone] 「${file}」尚未生成——首生直落即可（learnhub_project_milestone_generate），无需提案。`)
    }
    this.gateOrFail(md, project.tier)
    const doc: MilestoneArtifact = { project: projectId, milestone: milestoneId, md }
    const pid = await this.store.createProposal('project_milestone', projectId,
      `里程碑「${item.name}」按档「${project.tier}」重生成`,
      id => this.paths.proposalArtifactPath(id, 'project_milestone', projectId))
    const artifactPath = this.paths.proposalArtifactPath(pid, 'project_milestone', projectId)
    await atomicWrite(artifactPath, YAML.stringify(doc), this.fs)
    return { id: pid, kind: 'project_milestone', project: projectId, milestone: milestoneId, file }
  }

  /** apply 重生成提案：旧产物全文落快照后覆盖。 */
  async applyMilestone(pid?: number): Promise<ProjectApplyResult> {
    const prop = await this.store.takePending('project_milestone', pid)
    const v = validateMilestoneArtifact(await this.loadArtifact(prop), prop.course)
    if (v.errors || !v.milestone || v.md === undefined) {
      throw new Error(`[project-milestone-apply] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const { project, file } = await this.locateMilestone(prop.course, v.milestone)
    const path = this.paths.projectMilestonePath(project.id, file)
    const snapshot = this.paths.projectSnapshotPath(prop.id, `m${file}`)
    await atomicWrite(snapshot, await this.fs.readFile(path), this.fs)
    await atomicWrite(path, v.md.trimEnd() + '\n', this.fs)
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date(this.clock.nowMs()).toISOString(), decision_note: `快照 ${snapshot}`,
    })
    return { kind: 'project_milestone', project: project.id, milestone: v.milestone, file, snapshot }
  }

  /** 落盘分发（引擎唯一消费入口）：未生成 = 首生直落；已生成 = 自动转重生成提案
   * （带快照覆盖，设计 §4「不静默覆盖」）。 */
  async writeMilestone(projectId: string, milestoneId: string, md: string): Promise<
    { written: string; tier: FadingTier } | { proposed: number; kind: 'project_milestone'; file: string }
  > {
    const { file } = await this.locateMilestone(projectId, milestoneId)
    if (this.fs.exists(this.paths.projectMilestonePath(projectId, file))) {
      const prop = await this.proposeMilestone(projectId, milestoneId, md)
      return { proposed: prop.id, kind: 'project_milestone', file }
    }
    return this.generateMilestone(projectId, milestoneId, md)
  }

  // ---- 项目日志（V-5 #113：学习者的自由项目记录，无界项目的「家」） ----

  /** 追加一条日志（learner-authored：引擎事件不进日志——它是潜在的复习源素材，
 * 机器流水各归各的文件）。文件缺失先落文件头。返回日志绝对路径。 */
  async appendLog(projectId: string, text: string, day: string): Promise<string> {
    await this.load(projectId) // Missing fail loud（日志挂在项目下，项目不存在就不能写）
    const body = text.trim()
    if (!body) throw new Error('[project-log] 日志内容不能为空。')
    const p = this.paths.projectLogPath(projectId)
    await this.fs.mkdir(this.paths.projectDir(projectId))
    const header = this.fs.exists(p) ? '' : PROJECT_LOG_HEADER
    await this.fs.appendFile(p, `${header}## ${day}\n\n${body}\n\n`)
    return p
  }

  /** 读日志全文；未写过 = 合法空态（null，不建空文件——设计文档「预留位置，不强制建」）。 */
  async readLog(projectId: string): Promise<string | null> {
    await this.load(projectId)
    const p = this.paths.projectLogPath(projectId)
    if (!this.fs.exists(p)) return null
    return this.fs.readFile(p)
  }

  // ---- 过点与对账（#94 / 设计 §5：过点是显式动作，无清单门禁、无题目门禁） ----

  /** 显式过点：触发里程碑对账流水（journal 新 kind='milestone_settle'，对齐 xp_settle
   * 先例——这是项目域唯一获准写 journal 的动作：过点是真实项目投入的显式陈述，进
   * streak 口径与账本汇总，ADR-0015 裁决 5 的 Settle 新粒度）。定价由引擎层计算传入
   * （校准要读关联节点题池，属课程域）；这里只锁语义：定位里程碑、查重守卫、落一行。
   * 验收清单勾选不参与（勾选是自报，允许带未勾条目过点，Kulik 1990）。 */
  async passMilestone(projectId: string, milestoneId: string, settle: { xp: number; detail: string }): Promise<{
    project: string; milestone: string; name: string; file: string; xp: number
  }> {
    const { project, item, file } = await this.locateMilestone(projectId, milestoneId)
    if (await this.milestoneSettleRec(project.id, milestoneId)) {
      throw new Error(`[project-pass] 里程碑「${milestoneId}」已过点对账（定价锁定，重复过点不入账）；计划换了内容请用新的里程碑 id。`)
    }
    await this.store.appendJournal({
      course: project.id, node: milestoneId, rating: null,
      kind: 'milestone_settle', elapsed_days: 0,
      xp: settle.xp, detail: `里程碑「${item.name}」过点：${settle.detail}`,
    })
    return { project: project.id, milestone: milestoneId, name: item.name, file, xp: settle.xp }
  }

  /** 过点对账流水行（无则 null；对账流水即事实，零新增状态文件）。
   * journal 的 course 维度按名过滤——项目 id 与课程名撞名时本查询只认 kind+node
   * （课程域 journal 行不会有 kind='milestone_settle'），不会误配。 */
  async milestoneSettleRec(projectId: string, milestoneId: string): Promise<JournalRec | null> {
    return (await this.store.journalTail(projectId, Number.MAX_SAFE_INTEGER))
      .find(r => r.kind === 'milestone_settle' && r.node === milestoneId) ?? null
  }

  /** 里程碑产物落盘状态（#93 检索点门槛：交付物 = 任务卡已生成）。 */
  async isMilestoneDelivered(projectId: string, milestoneId: string): Promise<{ delivered: boolean; file: string }> {
    const { file } = await this.locateMilestone(projectId, milestoneId)
    return { delivered: this.fs.exists(this.paths.projectMilestonePath(projectId, file)), file }
  }

  /** 轻量结构门未过 → 抛 code=MILESTONE_GATE_FAILED（修复回路据此识别）。 */
  private gateOrFail(md: string, tier: FadingTier): void {
    const gate = gateMilestone(md, tier)
    if (!gate.passed) {
      const e: Error & { code?: string } = new Error(
        `[project-milestone] 轻量结构门未过：\n${gate.findings.map(x => `  ✗ ${x}`).join('\n')}${gate.warns.length ? `\n${gate.warns.map(w => `  ⚠ ${w}`).join('\n')}` : ''}`)
      e.code = 'MILESTONE_GATE_FAILED'
      throw e
    }
  }

  private async loadArtifact(prop: ProposalRec): Promise<unknown> {
    if (!this.fs.exists(prop.artifact)) throw new Error(`[projects] 提案产物文件不存在: ${prop.artifact}`)
    return YAML.parse(await this.fs.readFile(prop.artifact))
  }
}

// ---- Project 子系统（#152 刀 5 / ADR-0043）：项目域——P 区项目生命周期、过点对账/
// 检索点/行为推断 enc、执行事件流 2×2、目标反编译。住领主文件 projects.ts（聚合+转发）；
// 跨子系统依赖经结构化窄面 ProjectDeps 由门面注入（运行时回引门面，类型面零门面导入——R6）。

/** Project 域对门面的结构化窄面（门面构造时传 this，只列本域消费的成员）。 */
export interface ProjectDeps {
  store: Pick<Store, 'loadProposals' | 'practiceAll' | 'reviewLogAll' | 'updateProposal'>
  paths: Paths
  registry: Pick<Registry, 'get'>
  bank: Pick<QuestionBank, 'load'>
  proposals: Pick<GraphProposals, 'reject'>
  /** 图 apply 包装（#175 阶段③归位：联合受理不再直调 applySeed）。 */
  graphApply(kind: 'seed', pid?: number, opts?: { pairApply?: boolean; today?: string }): Promise<GraphApplyResult>
  projects: Projects
  noteManifest: Pick<NoteSourceManifest, 'load' | 'save'>
  /** vault 根目录。 */
  vaultRoot: string
  /** 取当前 JOL 随机源（可注入播种；经访问器惰性取，测试注入后构造期不锁定）。 */
  jolRng(): () => number
  /** vault 存储端口（#175 阶段②）。 */
  fs: VaultFs
  /** 时钟端口（#175 阶段①）：检索点/执行流水 ts 与回看窗口终点。 */
  clock: Clock
  learningDay(): Promise<{ today: string; cutoff: number }>
  loadView(course: { name: string; root: string }): Promise<{ graph: Graph; state: Record<string, Fm>; broken: BrokenNote[] }>
  enabledCourses(): Promise<CourseEntry[]>
  loadPrompt(kind: string): Promise<string>
  locateNode(nodeSpec: string): Promise<{ course: CourseEntry; node: string }>
  graphPropose(kind: 'edit' | 'seed' | 'enrich', yamlText: string): Promise<GraphProposeResult>
  nodeNote(c: CourseEntry, graph: Graph, node: string): Promise<{ path: string; fm: Fm | null; body: string }>
  saveNodeNote(path: string, fm: Fm, body: string): Promise<void>
}

export class ProjectSubsystem {
  constructor(private e: ProjectDeps) {}

// ---- 门面原分节：P ----
// ---- 门面原分节：P346 ----
// ---- 门面原分节：P7 ----
// ---- 门面原分节：P5 ----


  async projectCreate(input: { name: string; goal: string; tier?: FadingTier; id?: string }): Promise<ProjectFm> {
    return this.e.projects.create(input)
  }


  async projectList(): Promise<ProjectFm[]> {
    return this.e.projects.list()
  }


  async projectShow(id: string): Promise<ProjectView> {
    return this.e.projects.view(id)
  }


  /** 追加一条项目日志（V-5 #113）：学习者自由记录；日志可经笔记源注册通道注册为
   * 复习源，引擎写入后顺带刷新已注册指纹（自己的写不算漂移）。 */
  async projectLogAppend(id: string, text: string, today?: string): Promise<{ project: string; path: string; day: string }> {
    const { today: day } = await this.e.learningDay()
    today ??= day
    const p = await this.e.projects.appendLog(id, text, today)
    await this.refreshSourceFingerprints([p])
    return { project: id, path: p, day: today }
  }


  /** 读项目日志全文（未写过 = null 合法空态，不建空文件）。 */
  async projectLog(id: string): Promise<{ project: string; path: string; log: string | null }> {
    return { project: id, path: this.e.paths.projectLogPath(id), log: await this.e.projects.readLog(id) }
  }


  /** 引擎写「注册豁免区」文件（我的产出/、项目日志）后刷新已注册源指纹（#107/#113）：
   * 引擎自己的写不算内容漂移——漂移语义只留给引擎之外的手改。该路径未注册或文件
   * 缺失时静默跳过（刷新是写侧卫生步骤，不是独立动作）。 */
  async refreshSourceFingerprints(absPaths: string[]): Promise<void> {
    if (!absPaths.length) return
    const rels = absPaths.map(p => p.replace(/\\/g, '/').slice(this.e.vaultRoot.length + 1))
    const manifest = await this.e.noteManifest.load()
    let changed = false
    for (const item of manifest.sources) {
      if (!rels.includes(item.path)) continue
      const abs = `${this.e.vaultRoot}/${item.path}`
      if (!this.e.fs.exists(abs)) continue
      const fp = fingerprintOf(await this.e.fs.readFile(abs))
      if (fp !== item.fingerprint) {
        item.fingerprint = fp
        changed = true
      }
    }
    if (changed) await this.e.noteManifest.save(manifest)
  }


  /** 生命周期变更（ADR-0015：无不可逆转移，任意状态可重开回 active）。 */
  async projectSetLifecycle(id: string, lifecycle: string): Promise<ProjectFm> {
    if (!isProjectLifecycle(lifecycle)) {
      throw new Error(`[project-lifecycle] 非法生命周期: ${lifecycle}（允许 ${PROJECT_LIFECYCLES.join('/')}）`)
    }
    const fm = await this.e.projects.load(id)
    const next = { ...fm, lifecycle }
    await this.e.projects.saveFm(id, next)
    return next
  }


  /** 渐退档变更（ADR-0015：档位移动判据归执行事件流，v1 学习者/agent 显式设定；
   * 已生成产物不回溯——新档只作用于后续生成）。 */
  async projectSetTier(id: string, tier: string): Promise<ProjectFm> {
    if (!isFadingTier(tier)) {
      throw new Error(`[project-tier] 非法档位: ${tier}（允许 ${FADING_TIERS.join('/')}）`)
    }
    const fm = await this.e.projects.load(id)
    const next = { ...fm, tier }
    await this.e.projects.saveFm(id, next)
    return next
  }


  /** 计划生成提示词：模板 + 项目档案 + 现状计划（修订时对照）。 */
  async projectPlanPack(id: string): Promise<string> {
    const fm = await this.e.projects.load(id)
    const tpl = await this.e.loadPrompt('项目里程碑计划')
    const current = fm.plan.length
      ? YAML.stringify({ plan: fm.plan })
      : '（空——本项目还没有里程碑计划，本次为初次规划）'
    return Content.withContractLast(tpl, `## 项目档案\n\n- 项目 id：${fm.id}\n- 项目名：${fm.name}\n- 生命周期：${fm.lifecycle}\n- 渐退档：${fm.tier}\n- 目标描述：\n\n${fm.goal}\n\n## 现状计划（修订时给出完整新版本，不保守微调）\n\n${current}`)
  }


  async projectPlanPropose(id: string, yamlText: string) {
    return this.e.projects.proposePlan(id, yamlText)
  }


  /** 里程碑产物生成提示词：模板 + 项目档案 + 计划全景 + 本里程碑任务与档位。 */
  async projectMilestonePack(id: string, milestoneId: string): Promise<string> {
    const view = await this.e.projects.view(id)
    const fm = view.fm
    const hit = view.milestones.find(m => m.id === milestoneId)
    if (!hit) {
      throw new Error(`[project-milestone-pack] 项目「${id}」的计划里没有里程碑「${milestoneId}」。`)
    }
    const tpl = await this.e.loadPrompt('项目里程碑产物')
    const planTable = view.milestones
      .map((m, i) => `${i + 1}. ${m.id}｜${m.name}｜任务类：${m.task_class}${m.generated ? '｜已生成' : ''}`)
      .join('\n')
    return Content.withContractLast(tpl, `## 项目档案\n\n- 项目 id：${fm.id}\n- 项目名：${fm.name}\n- 生命周期：${fm.lifecycle}\n- 目标描述：\n\n${fm.goal}\n\n## 里程碑计划（本里程碑的位置）\n\n${planTable}\n\n## 本里程碑任务\n\n- 里程碑 id：${hit.id}\n- 名称：${hit.name}\n- 任务类：${hit.task_class}\n- 验收要点草案：${hit.acceptance_hints}\n- 当前档位：${fm.tier}（产物按此档生成，只写这一档）\n${hit.generated ? `- 注意：该里程碑已有产物，本次是按档重生成——将走提案通道，apply 前旧文有快照。\n` : ''}`)
  }


  /** 里程碑产物落盘分发：未生成 = 直落（首生）；已生成 = 自动转重生成提案（带快照覆盖）。 */
  async projectMilestoneWrite(id: string, milestoneId: string, md: string): Promise<
    { written: string; tier: FadingTier } | { proposed: number; kind: 'project_milestone'; file: string }
  > {
    return this.e.projects.writeMilestone(id, milestoneId, md)
  }

  /** 项目关联节点解析（计划声明 ∪ 调用补充；ADR-0015 裁决 6：关联可显式声明，永不门禁）。
   * 定位失败 fail loud 并点名——悬空关联先修计划，不在消费面静默降级。 */
  private async resolveProjectNodes(specs: string[]): Promise<Array<{ course: CourseEntry; node: string }>> {
    const out: Array<{ course: CourseEntry; node: string }> = []
    const seen = new Set<string>()
    for (const spec of specs) {
      const hit = await this.e.locateNode(spec)
      const key = `${hit.course.name}/${hit.node}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(hit)
    }
    return out
  }


  private planItemOf(fm: ProjectFm, milestoneId: string, tool: string): PlanItem {
    const item = fm.plan.find(m => m.id === milestoneId)
    if (!item) {
      throw new Error(`[${tool}] 项目「${fm.id}」的计划里没有里程碑「${milestoneId}」（先修订计划）。`)
    }
    return item
  }


  /** 关联节点的活跃题池（pass 定价校准与检索点抽题共用）：逐节点读题库、滤归档。
   * course/node 与题目一起返回，消费方各取所需。 */
  private async loadActivePools(linked: Array<{ course: CourseEntry; node: string }>): Promise<Array<{ course: CourseEntry; node: string; questions: BankQuestion[] }>> {
    const pools: Array<{ course: CourseEntry; node: string; questions: BankQuestion[] }> = []
    for (const { course, node } of linked) {
      const bank = await this.e.bank.load(this.e.paths.courseRoot(course.root), node)
      const active = bank.questions.filter(q => !q.archived)
      if (active.length) pools.push({ course, node, questions: active })
    }
    return pools
  }


  /** 显式过点（#94 / 设计 §5）：里程碑完成 = 学习者显式动作，无清单门禁、无题目门禁。
   * 定价 = milestonePrice（计划 est 申报 × 关联节点题池 FSRS 难度校准；无申报/无证据
   * 回落缺省/中性）——校准池锁定为计划条目 nodes 声明，调用方不能临时加池（过点即
   * 锁定，事后注水＝账本不诚实）。对账流水 journal kind='milestone_settle' 一次性入账
   * 并锁定（重复过点被守卫拒绝）。这是项目域唯一获准写 journal 的动作：真实投入的
   * 显式陈述，进账本汇总与 streak 口径（ADR-0015 裁决 5 的 Settle 新粒度；
   * 计划/产物/检索点仍零 journal 写入）。 */
  async projectMilestonePass(
    id: string, milestoneId: string,
  ): Promise<{ project: string; milestone: string; name: string; xp: number; detail: string }> {
    const fm = await this.e.projects.load(id)
    const item = this.planItemOf(fm, milestoneId, 'project-pass')
    const linked = await this.resolveProjectNodes(item.nodes ?? [])
    const pools = await this.loadActivePools(linked)
    const pool = pools.flatMap(p => p.questions)
    const calibration = pool.length ? difficultyCalibration(pool) : 1
    const price = milestonePrice(item.est, calibration)
    const detail = `N₀=${item.est ?? XP_PER_MILESTONE_DEFAULT}${item.est ? '（est 申报）' : '（缺省，无 est 申报）'}`
      + ` × k=${calibration.toFixed(2)}（${pool.length ? `${linked.length} 个关联节点题池校准` : '无关联题池证据，取中性'}）= ${price}，定价锁定`
    const r = await this.e.projects.passMilestone(id, milestoneId, { xp: price, detail })
    return { project: r.project, milestone: r.milestone, name: r.name, xp: r.xp, detail }
  }


  /** 发起里程碑检索点会话（#93）：产物已生成（交付物在手）才受理；从关联节点题池
   * 抽题（跨池轮转、未作答优先、due 最早优先），抽题流水落 projects/<id>/recall.jsonl。
   * 零 XP、零 FSRS、零 journal——检索点只服务知识底座，不作项目验收标准。 */
  async projectMilestoneRecall(
    id: string, milestoneId: string, opts: { nodes?: string[]; limit?: number } = {},
  ): Promise<{ project: string; milestone: string; file: string; questions: Array<RecallQuestion & { answer: BankQuestion['answer']; options?: string[]; explanation?: string }> }> {
    const delivered = await this.e.projects.isMilestoneDelivered(id, milestoneId)
    if (!delivered.delivered) {
      throw new Error(`[project-recall] 里程碑「${milestoneId}」的产物尚未生成——检索点在交付物在手时发起（先 learnhub_project_milestone_generate）。`)
    }
    const fm = await this.e.projects.load(id)
    const item = this.planItemOf(fm, milestoneId, 'project-recall')
    const specs = [...new Set([...(item.nodes ?? []), ...(opts.nodes ?? [])])]
    if (!specs.length) {
      throw new Error('[project-recall] 该里程碑没有关联节点：计划条目 nodes 或调用参数 nodes 至少给一个（节点名或「课程/节点」）。')
    }
    const linked = await this.resolveProjectNodes(specs)
    const pools = await this.loadActivePools(linked)
    const byKey = new Map<string, BankQuestion>()
    for (const p of pools) {
      for (const q of p.questions) byKey.set(`${p.course.name}\u0000${p.node}\u0000${q.id}`, q)
    }
    if (!pools.length) {
      throw new Error('[project-recall] 关联节点都没有可用题目（题库为空或全归档）——先出题，或修订计划的 nodes 关联。')
    }
    const drawn = drawRecallQuestions(pools.map(p => ({ course: p.course.name, node: p.node, questions: p.questions })), opts.limit ?? 5, this.e.jolRng())
    await appendRecallRec(this.e.paths, id, {
      ts: nowIsoOf(this.e.clock.nowMs()), kind: 'draw', milestone: milestoneId, file: delivered.file,
      nodes: specs, questions: drawn,
    }, this.e.fs)
    const questions = drawn.map(d => {
      const q = byKey.get(`${d.course}\u0000${d.node}\u0000${d.qid}`)!
      return { ...d, answer: q.answer, ...(q.options ? { options: q.options } : {}), ...(q.explanation ? { explanation: q.explanation } : {}) }
    })
    return { project: id, milestone: milestoneId, file: delivered.file, questions }
  }


  /** 检索点自述落档（#93）：学习者口述「到目前为止的关键决策」，追加进 recall.jsonl。
   * 判词不评、canonical 不碰——自述是给复盘看的，不是给调度喂的。 */
  async projectRecallReflect(id: string, milestoneId: string, narration: string): Promise<{ project: string; milestone: string; recorded: true }> {
    const trimmed = narration?.trim()
    if (!trimmed) throw new Error('[project-recall] 自述不能为空（关键决策口述原文）。')
    const fm = await this.e.projects.load(id)
    this.planItemOf(fm, milestoneId, 'project-recall')
    await appendRecallRec(this.e.paths, id, { ts: nowIsoOf(this.e.clock.nowMs()), kind: 'reflect', milestone: milestoneId, narration: trimmed }, this.e.fs)
    return { project: id, milestone: milestoneId, recorded: true }
  }


  /** 检索点流水读取（#93；面板/复盘消费）。 */
  async projectRecallLog(id: string): Promise<RecallRec[]> {
    await this.e.projects.load(id)
    return recallRecsAll(this.e.paths, id, this.e.fs)
  }

  /** 记一条项目执行事件（P-7 #98；#149 stub 回流修订；#146 复诊闸）：项目自己的事件流
   * （projects/<id>/exec.jsonl，与节点练习证据通道是两条流，ADR-0015 §4）。评级 1-4
   * 整数 + 来源 auto/self/ai——auto 必须带可观测证据走确定性映射（ratingFromEvidence，
   * skills 先例）；自评/ai 照收（ADR-0016 自报即可信）。
   * 上行回流 = **行使即回流（节点级，#149）**：事件 nodes 解析到图上的每个节点（含种子簇
   * stub——有笔记有身份）各回流一次练习证据（applyPracticeEvidence 单向复制，同节点
   * 去重）；粗 pre 占位边不是回流通道（行使记录留在 exec 流水，边零证据写入——
   * 「粗 pre 只记流不回流」）；probation 在途的插入节点不回流（#146 复诊闸，只记流，
   * proven 后恢复）；被行使的既有 enc 边数随结果带出（enc 面观测，回流不再以 enc 边
   * 为门）。零 XP、零 journal、零 review-log、零 sessions/srs（ADR-0015 §7）。 */
  async projectExecLog(
    id: string,
    input: { source: string; rating?: number; evidence?: ExecutionEvidence; nodes?: string[]; note?: string },
  ): Promise<ProjectExecResult> {
    const fm = await this.e.projects.load(id)
    const source = input.source
    if (!(source === 'auto' || source === 'self' || source === 'ai')) {
      throw new Error(`[project-exec] source 只能是 auto/self/ai（收到 ${String(source)}）。`)
    }
    let rating: unknown = input.rating
    if (source === 'auto') {
      if (!input.evidence) {
        throw new Error("[project-exec] source='auto' 需要可观测证据（evidence.accuracy/self_help）——确定性映射是自动来源的唯一入口；无可观测判据时改用自评档（source='self' + rating）。")
      }
      rating = ratingFromEvidence(input.evidence)
    }
    const v = validateExecEvent(rating, source, input.nodes ?? [], input.note, 'project-exec')
    const { today } = await this.e.learningDay()
    const score = execRatingScore(v.rating)

    // 行使判定与节点级回流：逐课程载图（enc 边归节点域、不可跨图），每节点至多回流一次
    const linked = v.nodes.length ? await this.resolveProjectNodes(v.nodes) : []
    const byCourse = new Map<string, string[]>()
    for (const { course, node } of linked) {
      const list = byCourse.get(course.name) ?? []
      list.push(node)
      byCourse.set(course.name, list)
    }
    const backflow: ProjectExecBackflow[] = []
    const skipped: Array<{ course: string; node: string; reason: string }> = []
    let edges = 0
    for (const [courseName, nodes] of byCourse) {
      const c = await this.e.registry.get(courseName)
      if (!c) continue
      const { graph } = await this.e.loadView(c)
      // probation 在途行使闸（#146）：实验中的插入节点不回流练习证据（行使照落 exec 流水）。
      const gated = foldProbation(await readProbationLedger(this.e.paths, c.root, this.e.fs))
      const gatedNodes = new Set(gated.inFlight.map(e => e.node))
      // enc 面观测：被行使的既有 enc 边数（两端都在 nodes 内）；回流已改节点级，边数只作观测
      edges += exercisedEncEdges(nodes, holder => (graph.encOf[holder] ?? []).map(e => e[0])).length
      for (const node of nodes) {
        if (gatedNodes.has(node)) {
          skipped.push({
            course: courseName, node,
            reason: 'probation 在途（实验中的插入节点）——行使只记流不回流练习证据，proven 后恢复',
          })
          continue
        }
        const note = await this.e.nodeNote(c, graph, node)
        if (!note.fm) {
          skipped.push({
            course: courseName, node,
            reason: '节点笔记缺失或 frontmatter 不可用——练习证据无处落，跳过（Missing 合法空态）',
          })
          continue
        }
        const before = note.fm.practice_ema ?? 0
        const next = applyPracticeEvidence(note.fm, score)
        await this.e.saveNodeNote(note.path, next, note.body)
        backflow.push({
          course: courseName, node,
          ema_before: before, ema_after: next.practice_ema ?? 0, mastery_after: masteryOfFm(next),
        })
      }
    }

    await appendExecRec(this.e.paths, id, {
      ts: nowIsoOf(this.e.clock.nowMs()), day: today, rating: v.rating, source: v.source,
      nodes: v.nodes, tier: fm.tier, ...(v.note ? { note: v.note } : {}),
    }, this.e.fs)
    backflow.sort((a, b) => a.course.localeCompare(b.course) || a.node.localeCompare(b.node))
    return {
      project: id, day: today, rating: v.rating, source: v.source, score,
      nodes: v.nodes, edges, backflow, skipped,
    }
  }


  /** 项目 2×2 交叉视图（P-7 #98；项目面板核心视图，只读）：X = 关联节点 masteryOfFm
   * 均值（陈述性掌握），Y = 执行事件分 EMA 0.7/0.3（项目执行证据），阈值统一
   * CROSS_AXIS_THRESHOLD；四象限 = 会而不会用 / 会用而不牢 / 健康 / 补底。附只读
   * 入档推荐（challenge point：升档判据 = 档内表现 + 知识底座；引擎提议学习者经
   * projectSetTier 改档——不写任何状态、不参与 gateMilestone/passMilestone/门禁）。 */
  async projectCrossView(id: string): Promise<ProjectCrossDoc> {
    const fm = await this.e.projects.load(id)
    const specs = [...new Set(fm.plan.flatMap(m => m.nodes ?? []))]
    const linked = specs.length ? await this.resolveProjectNodes(specs) : []
    const linkedNodes: Array<{ course: string; node: string; mastery: number }> = []
    const masteryList: number[] = []
    const viewCache = new Map<string, Awaited<ReturnType<ProjectDeps['loadView']>>>()
    for (const { course, node } of linked) {
      let v = viewCache.get(course.name)
      if (!v) {
        v = await this.e.loadView(course)
        viewCache.set(course.name, v)
      }
      const m = masteryOfFm(v.state[node] ?? null)
      linkedNodes.push({ course: course.name, node, mastery: m })
      masteryList.push(m)
    }
    const x = masteryAggregate(masteryList)
    const recs = await execRecsAll(this.e.paths, id, this.e.fs)
    const y = execEvidenceScore(recs)
    const avg = (list: ProjectExecRec[]) => list.length
      ? Math.round(list.reduce((a, r) => a + execRatingScore(r.rating), 0) / list.length * 1000) / 1000
      : null
    // 档内表现：事件带的 tier 快照 = 当前档才计入（改档后旧档事件不冒充新档表现）
    const inTierRecs = recs.filter(r => r.tier === fm.tier)
    return {
      project: fm.id, name: fm.name, lifecycle: fm.lifecycle, tier: fm.tier,
      x: { value: x, caliber: `关联节点 masteryOfFm 均值（${masteryList.length} 个${specs.length ? '' : '；计划未关联节点'}）` },
      y: { value: y, caliber: `执行事件分（评级映射 0-1）EMA 0.7/0.3（${recs.length} 条事件）` },
      quadrant: classifyCross(x, y),
      linked_nodes: linkedNodes,
      exec: { count: recs.length, ema: y, avg: avg(recs) },
      recommendation: recommendTier(fm.tier, { count: inTierRecs.length, avg: avg(inTierRecs) }, x),
      events: recs.slice(-20).reverse(),
      thresholds: {
        axis: CROSS_AXIS_THRESHOLD,
        promote_min_events: TIER_REC_MIN_EVENTS,
        promote_score: TIER_REC_PROMOTE_SCORE,
        demote_score: TIER_REC_DEMOTE_SCORE,
      },
    }
  }


  /** 行为推断 enc 候选边（#96 / ADR-0015 裁决 3/6）：项目窗口内的翻卡/回看共现 →
   * 带置信度候选边 → 每课程单个 pending edit 提案走人审（enc_backfill「单提案人审」
   * 先例；set_enc 整体替换、既有声明 enc 原样保留，零 schema 破坏）。窗口终点 =
   * 指定里程碑的过点时刻（省略则现在）；事件源 = review-log（synthetic 除外）+ practice，
   * 只取关联节点。边只在 pre 闭包内落（CONTEXT Enc 契约 / 审计 E7）——跨无关节点对
   * 不硬提边，降级为 blocked_no_pre 信号（带方向提示，供未来补 pre 边参考）；
   * 已声明边不重复提名。 */
  async projectEncCandidates(
    id: string, opts: { milestone?: string; nodes?: string[]; window_days?: number; min_co?: number } = {},
  ): Promise<{
    project: string; window: { start: string; end: string; days: number }
    events: number; candidates: Array<{ course: string; holder: string; skill: string; co: number; w: number }>
    blocked_no_pre: Array<{ course: string; a: string; b: string; co: number; hint_skill: string; why: string }>
    proposals: Array<{ course: string; id: number; ops: number }>; skipped_declared: number
  }> {
    const fm = await this.e.projects.load(id)
    const days = Math.min(90, Math.max(1, Math.round(opts.window_days ?? 14)))
    const minCo = Math.max(1, Math.round(opts.min_co ?? 2))
    let endMs = this.e.clock.nowMs()
    if (opts.milestone !== undefined) {
      const rec = await this.e.projects.milestoneSettleRec(id, opts.milestone)
      if (!rec) {
        throw new Error(`[project-enc] 里程碑「${opts.milestone}」没有过点记录——共现窗口没有锚点（先过点，或省略 milestone 以现在为终点）。`)
      }
      endMs = Date.parse(rec.ts)
    }
    const startMs = endMs - days * 86_400_000
    const specs = [...new Set([...fm.plan.flatMap(m => m.nodes ?? []), ...(opts.nodes ?? [])])]
    if (!specs.length) {
      throw new Error('[project-enc] 项目没有关联节点：计划条目 nodes 或调用参数 nodes 至少给一个（行为扫描只在关联节点间成对）。')
    }
    const linked = await this.resolveProjectNodes(specs)
    const byCourse = new Map<string, Set<string>>()
    for (const { course, node } of linked) {
      let set = byCourse.get(course.name)
      if (!set) byCourse.set(course.name, set = new Set())
      set.add(node)
    }
    const { cutoff } = await this.e.learningDay()
    const inWindow = (ts: string) => {
      const ms = Date.parse(ts)
      return ms >= startMs && ms <= endMs
    }
    const [reviews, practices] = await Promise.all([
      this.e.store.reviewLogAll(), this.e.store.practiceAll(),
    ])
    let events = 0
    const firstDayByCourse = new Map<string, Map<string, string>>()
    const eventsByCourse = new Map<string, Array<{ node: string; day: string }>>()
    const bump = (course: string, node: string, ts: string) => {
      if (!byCourse.get(course)?.has(node)) return
      if (!inWindow(ts)) return
      const day = dayOfTs(ts, cutoff)
      events++
      const list = eventsByCourse.get(course) ?? []
      list.push({ node, day })
      eventsByCourse.set(course, list)
      const firstDays = firstDayByCourse.get(course) ?? new Map<string, string>()
      const prev = firstDays.get(node)
      if (prev === undefined || day < prev) firstDays.set(node, day)
      firstDayByCourse.set(course, firstDays)
    }
    for (const r of reviews) if (r.rating_source !== 'synthetic') bump(r.course, r.node, r.ts)
    for (const r of practices) bump(r.course, r.node, r.ts)

    const candidates: Array<{ course: string; holder: string; skill: string; co: number; w: number }> = []
    const blockedNoPre: Array<{ course: string; a: string; b: string; co: number; hint_skill: string; why: string }> = []
    const proposals: Array<{ course: string; id: number; ops: number }> = []
    let skippedDeclared = 0
    for (const [courseName, nodes] of byCourse) {
      const pairs = cooccurrencePairs(eventsByCourse.get(courseName) ?? [], minCo)
      if (!pairs.length) continue
      const c = await this.e.registry.get(courseName)
      if (!c) continue
      const { graph } = await this.e.loadView(c)
      const declared = declaredEncOf(graph)
      const fields: EnrichFieldEntry[] = []
      for (const pair of pairs.slice(0, 12)) {
        const dir = orientCandidate(
          pair.a, pair.b,
          (from, to) => graph.nset.has(from) && graph.nset.has(to) && graph.isAncestor(from, to),
          node => firstDayByCourse.get(courseName)?.get(node),
        )
        if (dir.ok === false) {
          blockedNoPre.push({ course: courseName, a: pair.a, b: pair.b, co: pair.co, hint_skill: dir.hint_skill, why: dir.why })
          continue
        }
        if (!nodes.has(dir.holder) || !nodes.has(dir.skill)) continue
        const existing = declared.get(dir.holder) ?? []
        if (existing.some(e => e.node === dir.skill)) {
          skippedDeclared++
          continue
        }
        const w = coWeight(pair.co)
        fields.push({
          node: dir.holder,
          enc: [...existing, { node: dir.skill, w, note: `行为推断（P-6 #96）：${days} 天窗口内共现 ${pair.co} 天（pre 闭包方向）` }],
        })
        candidates.push({ course: courseName, holder: dir.holder, skill: dir.skill, co: pair.co, w })
      }
      if (!fields.length) continue
      const yamlText = YAML.stringify({
        course: courseName,
        reason: `行为推断 enc 边（覆盖层通道，P-6 #96）：项目「${fm.name}」${days} 天窗口内翻卡/回看共现 ≥${minCo} 天的关联节点对`,
        fields,
      })
      const prop = await this.e.graphPropose('enrich', yamlText)
      proposals.push({ course: courseName, id: (prop as { id: number }).id, ops: fields.length })
    }
    return {
      project: id,
      window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), days },
      events, candidates, blocked_no_pre: blockedNoPre, proposals, skipped_declared: skippedDeclared,
    }
  }

  /** 目标反编译（P-5，v8 #149）：一次模型调用产出**双提案**——里程碑计划草案
   * （project_plan）与知识子图种子簇（kind=seed，子图簇直通新课程的种子起点，
   * 起点 basis 铸 project）。同源同进同退：
   * - 受理侧门禁全部过完才落任何提案：双半区 schema 门 + 名字对账门（plan.nodes ⊆
   *   种子簇 ∪ 既有图节点名）+ 种子落点/结构预检——任一失败回灌修复一轮，仍败则
   *   DECOMPILE_GATE_FAILED 零提案（同退的静态半）；
   * - 两提案 pair 互相指认：apply 只走 projectDecompileApply 联合入口（种子先落图、
   *   计划后落盘），单边 apply 被守卫拒、单边 reject 联动拒另一半（同退的动态半）。
   * 显式目标课程 = 已播种课程的新计划半区（nodes 引用既有节点名，对账门收紧到既有
   * 图；新知识需要走计划修订驱动的教练补支）；省略 course = 种子簇充当新课程种子。
   * 检索面复用 Vault 先验（只读）；apply 前零 canonical 写入（ADR-0015 裁决 6）。
   * 调用经统一 agent 缝（#162）：剥围栏/调用日志在缝里内建，双产物门未过经缝的门错
   * 修复轮回灌重产恰一次（修复轮语义档 deep——回灌重裁是值得多思考一轮的高难调用）。 */
  async projectDecompile(
    id: string,
    opts: { goal?: string; course?: string; notes?: string[] } = {},
    agent: AgentSeam,
  ): Promise<{
    project: string
    prior_hits: number
    notes: string[]
    repaired: boolean
    plan_proposal: { id: number; kind: 'project_plan'; project: string; milestones: number; initial: boolean }
    seed_proposal: { id: number; kind: 'seed'; course: string; endpoint: string; starts: number } | null
    pair: { plan: number; seed: number | null }
  }> {
    const fm = await this.e.projects.load(id)
    const goal = decompileGoalOf(opts.goal, fm.goal)
    // 注册笔记（V-1 manifest 只读）：显式 notes 按 id/path 解析，缺省 = 全部注册源
    const manifest = await this.e.noteManifest.load()
    const baseOf = (path: string): string => path.split('/').pop()!.replace(/\.md$/i, '')
    const picked: Array<{ id: string; path: string; title: string }> = []
    if (opts.notes?.length) {
      const byKey = new Map(manifest.sources.flatMap(s => [[s.id, s], [s.path.replace(/\\/g, '/'), s]] as const))
      for (const spec of opts.notes) {
        const hit = byKey.get(spec.replace(/\\/g, '/'))
        if (!hit) {
          throw new Error(`[project-decompile] 笔记「${spec}」不在注册清单（先 learnhub_note_source_register，或省略 notes 取全部注册源）。`)
        }
        picked.push({ id: hit.id, path: hit.path, title: hit.title ?? baseOf(hit.path) })
      }
    } else {
      for (const s of manifest.sources) {
        picked.push({ id: s.id, path: s.path, title: s.title ?? baseOf(s.path) })
      }
    }
    // 落点裁决（受理前）：显式课程必须在册并取其既有节点名（对账域）；未给 = 种子簇
    // 充当新课程种子（mode=new）
    const explicitCourse = opts.course?.trim()
    let target: CourseEntry | null = null
    if (explicitCourse) {
      target = await this.e.registry.get(explicitCourse)
      if (!target) throw new Error(`[project-decompile] 注册表中没有课程「${explicitCourse}」（显式目标课程须先建课播种；省略 course 参数可让种子簇充当新课程）。`)
    }
    // Vault 先验（只读检索）注入反编译上下文
    const terms = decompileTerms(goal, picked.map(p => p.title))
    const centerRel = this.e.paths.centerRoot.slice(this.e.vaultRoot.length + 1)
    const hits = terms.length ? await searchVaultPrior(this.e.vaultRoot, centerRel, terms, {}, this.e.fs) : []
    const prior = priorSection(hits)
    // 子图落点上下文：显式课程给现有结构（对账取值域）；未给 → seed 半区必出
    let courseBlock: string
    if (target) {
      const { graph } = await this.e.loadView(target)
      const names = graph.names.slice().sort()
      courseBlock = `- 目标课程：${target.name}（已播种/既有课程——**不产 seed 半区**，只给 plan）\n- 现有结构（plan.nodes 只能引用这些节点名，写「${target.name}/节点名」全形）：\n${names.map(n => `  - ${n}`).join('\n') || '  -（空图）'}`
    } else {
      courseBlock = '- 未指定目标课程：seed 半区必出（自拟新课程名写进 seed.course，子图簇 = 该新课程的种子：1–3 起点 + 终点）；plan.nodes 引用种子簇节点名（写「课程名/节点名」全形）'
    }
    const tpl = await this.e.loadPrompt('项目目标反编译')
    const notesList = picked.length ? picked.map(p => `- 《${p.title}》（${p.path}）`).join('\n') : '-（无注册笔记）'
    const current = fm.plan.length
      ? YAML.stringify({ plan: fm.plan })
      : '（空——本项目还没有里程碑计划，本次为初次规划）'
    // 模板与材料分开收（#218 契约后置）：材料在前、输出契约段置尾；修复轮回灌走
    // decompileRepairPrompt（同一材料块），契约在修复轮仍居尾。
    const materials = `## 目标项目档案\n\n- 项目 id：${fm.id}\n- 项目名：${fm.name}\n- 渐退档：${fm.tier}\n- 目标描述（目标项目描述原文）：\n\n${goal}\n\n## 现状计划（给出完整新版本，不保守微调）\n\n${current}\n\n## 注册笔记（Vault 先验的检索来源）\n\n${notesList}\n\n## 知识子图落点\n\n${courseBlock}${prior ? `\n\n---\n\n${prior}` : ''}`
    const pack = Content.withContractLast(tpl, materials)
    // 模型产出 → 双产物校验门 + 名字对账门（未过经缝的门错修复轮回灌重产恰一次，对齐
    // 「生成→门禁→修复一轮」机械）。对账域 = 种子簇 ∪ 全部启用课程的图节点名（与消费面
    // locateNode 的跨课解析同域——裸名歧义/悬空在受理前拦下，不留到消费面才炸）。
    const reconcileErrors = async (doc: DecompileDoc | undefined): Promise<string[]> => {
      if (!doc) return []
      const existingByCourse = new Map<string, Set<string>>()
      const ensureNames = async (courseName: string): Promise<void> => {
        if (existingByCourse.has(courseName)) return
        const c = await this.e.registry.get(courseName)
        if (!c) return
        const { graph } = await this.e.loadView(c)
        existingByCourse.set(courseName, new Set(graph.names))
      }
      for (const c of await this.e.enabledCourses()) await ensureNames(c.name)
      const seedCourseNames = new Set<string>()
      const extra: string[] = []
      if (doc.seed) {
        for (const n of [doc.seed.endpoint.name, ...doc.seed.starts.map(s => s.name)]) seedCourseNames.add(n)
        if (await this.e.registry.get(doc.seed.course)) {
          extra.push(`seed.course「${doc.seed.course}」已在注册表（mode=new 新课程入口撞名）——自拟一个新课程名，或显式 course 参数指向既有课程`)
        }
      }
      return [...extra, ...reconcilePlanNodes(doc.plan, {
        ...(doc.seed ? { seed: { course: doc.seed.course, nodeNames: seedCourseNames } } : {}),
        existingByCourse,
      })]
    }
    const judgeOnce = async (raw: string): Promise<GateVerdict<DecompileDoc>> => {
      const gate = splitDecompileDoc(YAML.parseModel(raw), fm.id, { expectSeed: !target })
      const reconcile = await reconcileErrors(gate.result)
      const errors = [...gate.errors, ...reconcile].map(x => `  ✗ ${x}`)
      return errors.length || !gate.result ? { errors } : { errors, result: gate.result }
    }
    const round = await agent.gateRepairRound<string, DecompileDoc>('目标反编译', {
      first: () => agent.complete('目标反编译', pack),
      gate: judgeOnce,
      repair: (gateErrors, rejected) =>
        agent.repair('目标反编译', decompileRepairPrompt(tpl, materials, rejected, gateErrors), { effort: 'deep' }),
      fatal: (_firstErrors, repairErrors) => {
        const e: Error & { code?: string } = new Error(
          `[project-decompile] 模型产出未过双产物校验门（已自动修复重试一轮，提案未受理）：\n${repairErrors.join('\n')}`)
        e.code = 'DECOMPILE_GATE_FAILED'
        return e
      },
    })
    const doc: DecompileDoc = round.result
    // 名字对账门已在修复环内跑过（judgeOnce 过门 = 对账为空）——此处直接受理。
    // 双提案受理（先种子后计划）：种子提案先落（重门已预检通过）；计划提案**出生即带
    // pair**（联动守卫从落盘那一刻生效——任一时刻崩溃都不会留下可单边 apply 的无守卫
    // 计划半区）；最后补种子半区的 pair 指认（此窗口内计划已被守卫保护，种子半区单边
    // apply 无害——计划未落盘就无悬空引用可言）。概念引用在 proposeSeed 受理门对
    // 登记表（铸名随种子 apply 的写入单元落盘）。
    let seedId: number | null = null
    let planProposal: Awaited<ReturnType<Projects['proposePlan']>> | null = null
    try {
      if (doc.seed) {
        seedId = ((await this.e.graphPropose('seed', YAML.stringify(doc.seed))) as { id: number }).id
      }
      planProposal = await this.e.projects.proposePlan(fm.id, YAML.stringify({ project: fm.id, plan: doc.plan }), seedId !== null ? { pair: seedId } : {})
      if (seedId !== null) await this.e.store.updateProposal(seedId, { pair: planProposal.id })
    } catch (err) {
      // 计划半区受理失败：种子半区联动退回（不留孤儿 pending），原样抛错
      if (seedId !== null) {
        await this.e.proposals.reject(seedId, `同源双提案受理失败联动退回：${err instanceof Error ? err.message : String(err)}`).catch(() => undefined)
      }
      throw err
    }
    const seedProposal = doc.seed
      ? { id: seedId!, kind: 'seed' as const, course: doc.seed.course, endpoint: doc.seed.endpoint.name, starts: doc.seed.starts.length }
      : null
    return {
      project: fm.id,
      prior_hits: hits.length,
      notes: picked.map(p => p.path),
      repaired: round.repaired,
      plan_proposal: planProposal!,
      seed_proposal: seedProposal,
      pair: { plan: planProposal!.id, seed: seedProposal?.id ?? null },
    }
  }


  /** 反编译双提案联合 apply（#149 同进同退的动态半）：两提案 pair 互指才受理；
   * 种子先落图（簇节点 + 终点锚 + 笔记脚手架——计划引用先有图可解析）、计划后落盘。
   * 任一半区已是 applied = 崩溃恢复续段（跳过重放该半区）；rejected = 拒绝复活
   * （重新反编译产生新对）。 */
  async projectDecompileApply(planPid: number, seedPid: number): Promise<{
    project: string
    seed: GraphApplyResult | null
    plan: ProjectApplyResult | null
  }> {
    const list = await this.e.store.loadProposals()
    const plan = list.find(p => p.id === planPid)
    const seed = list.find(p => p.id === seedPid)
    const bad = (why: string): Error => new Error(`[project-decompile-apply] ${why}`)
    if (!plan || (plan.status !== 'pending' && plan.status !== 'applied')) {
      throw bad(`计划提案 #${planPid} 不存在或已决（pending/applied 之外不受理）。`)
    }
    if (!seed || (seed.status !== 'pending' && seed.status !== 'applied')) {
      throw bad(`种子提案 #${seedPid} 不存在或已决（pending/applied 之外不受理）。`)
    }
    if (plan.kind !== 'project_plan' || seed.kind !== 'seed') {
      throw bad(`提案 kind 不对（#${planPid}=${plan.kind}，#${seedPid}=${seed.kind}）——联合 apply 只收 反编译对（project_plan + seed）。`)
    }
    if (plan.pair !== seedPid || seed.pair !== planPid) {
      throw bad(`提案 #${planPid} 与 #${seedPid} 不是同一反编译对（pair 联动缺失或互指不符）——反编译对只走本联合入口；独立提案（无 pair）才走 learnhub_project_apply / learnhub_graph_apply 单独生效。`)
    }
    const today = (await this.e.learningDay()).today
    // 种子先落图：簇节点 + 终点锚 + ensureNotesFor 笔记脚手架——计划引用先有图可解析
    const seedResult = seed.status === 'pending'
      ? await this.e.graphApply('seed', seedPid, { pairApply: true, today })
      : null
    const planResult = plan.status === 'pending'
      ? await this.applyProjectPlanProposal(planPid, { pairApply: true })
      : null
    return { project: (planResult as { project?: string })?.project ?? plan.course, seed: seedResult, plan: planResult }
  }



  /** 计划提案 apply 的引擎包装（#149 修订驱动生长）：apply 前捕旧计划，apply 后派生
   * 快照 diff（id 为身份锚）并解析换线/补支触发（按锚定课程聚合，宿主入队生长批）；
   * 已过点里程碑被移除/改名出显式警告（不拒绝）。单边守卫在 projects.applyPlan 内。 */
  async applyProjectPlanProposal(
    pid?: number, opts: { pairApply?: boolean } = {},
  ): Promise<ProjectApplyResult> {
    let before: ProjectFm | null = null
    const proposals = await this.e.store.loadProposals()
    const targetPid = pid ?? [...proposals].reverse().find(p => p.status === 'pending' && p.kind === 'project_plan')?.id
    if (targetPid !== undefined) {
      const prop = proposals.find(p => p.id === targetPid)
      if (prop?.kind === 'project_plan') {
        before = await this.e.projects.load(prop.course).catch(() => null)
      }
    }
    const result = await this.e.projects.applyPlan(pid, opts)
    if (result.kind !== 'project_plan') return result
    const after = await this.e.projects.load(result.project)
    const diff = planRevisionDiff(before?.plan ?? [], after.plan)
    const { triggers, warnings } = await this.planGrowthTriggers(result.project, before, after, diff)
    return {
      ...result,
      plan_diff: diff,
      ...(warnings.length ? { plan_diff_warnings: warnings } : {}),
      ...(triggers.length ? { growth: triggers } : {}),
    }
  }


  /** 换线/补支触发解析（读侧派生，#126 接口输入）：added/retargeted 条目的每个
   * nodes 引用——图上已存在 = 换线（stub 激活：内容生成/接入路线）；图上不存在 =
   * 补支（朝新里程碑长粗分支）。路由目标：显式「课程/」前缀照抄；裸名按其余计划
   * 条目的锚定课程集收敛（恰一门 → 路由，否则落警告不强路由）。已过点里程碑被
   * 移除/改名（同 id）出显式警告——账本事实不改写，但「终点消失/漂移」要可见。 */
  private async planGrowthTriggers(
    projectId: string, before: ProjectFm | null, after: ProjectFm, diff: PlanRevisionDiff,
  ): Promise<{ triggers: PlanGrowthTrigger[]; warnings: string[] }> {
    const warnings: string[] = []
    for (const m of diff.removed) {
      if (await this.e.projects.milestoneSettleRec(projectId, m.id)) {
        warnings.push(`里程碑「${m.name}」（${m.id}）已过点对账却被本次修订移除——账本事实不改写，但「终点消失」请知悉。`)
      }
    }
    if (before) {
      const afterById = new Map(after.plan.map(m => [m.id, m]))
      for (const old of before.plan) {
        const now = afterById.get(old.id)
        if (!now || now.name === old.name) continue
        if (await this.e.projects.milestoneSettleRec(projectId, old.id)) {
          warnings.push(`里程碑「${old.name}」（${old.id}）已过点对账却被本次修订改名为「${now.name}」——产物文件名随计划漂移（orphans 提示可见）。`)
        }
      }
    }
    type Candidate = { milestone: string; name: string; kind: '换线' | '补支'; node: string; course: string | null }
    const candidates: Candidate[] = []
    const items = [...diff.added, ...diff.retargeted.map(r => after.plan.find(m => m.id === r.id)!)]
    for (const item of items) {
      for (const spec of item.nodes ?? []) {
        const { course: specCourse, node } = splitNodeSpec(spec)
        let course: string | null = null
        let exists = false
        if (specCourse !== undefined) {
          const c = await this.e.registry.get(specCourse)
          if (!c) {
            warnings.push(`里程碑「${item.name}」（${item.id}）引用课程「${specCourse}」不在注册表——该行不入生长触发。`)
            continue
          }
          const { graph } = await this.e.loadView(c)
          course = c.name
          exists = graph.nset.has(node)
        } else {
          try {
            const hit = await this.e.locateNode(node)
            course = hit.course.name
            exists = true
          } catch {
            exists = false
          }
        }
        candidates.push({
          milestone: item.id, name: item.name,
          kind: exists ? '换线' : '补支',
          node: spec,
          course, // 显式「课程/」前缀恒路由；裸名未解析的补支走锚定课程集收敛
        })
      }
    }
    // 裸名补支的路由：锚定课程集 = 计划其余条目 nodes 解析到的课程（恰一门才强路由）
    const anchored = new Set<string>()
    for (const m of after.plan) {
      for (const spec of m.nodes ?? []) {
        try {
          anchored.add((await this.e.locateNode(spec)).course.name)
        } catch { /* 未解析的引用不参与锚定 */ }
      }
    }
    const byCourse = new Map<string, string[]>()
    for (const c of candidates) {
      let target = c.course
      if (!target && !c.node.includes('/') && anchored.size === 1) target = [...anchored][0]
      if (!target) {
        warnings.push(`里程碑「${c.name}」（${c.milestone}）的补支引用「${c.node}」无法确定锚定课程（多门或无锚定）——未入生长触发，请显式写「课程/节点」或人工在生成队列拉批。`)
        continue
      }
      const lines = byCourse.get(target) ?? []
      lines.push(c.kind === '换线'
        ? `- 换线：里程碑 ${c.milestone}「${c.name}」关联「${c.node}」已在图上——激活它（内容生成/接入路线），不长重复结构`
        : `- 补支：里程碑 ${c.milestone}「${c.name}」关联「${c.node}」图上尚无——沿足迹朝它长最小必要分支（粗节点+粗 pre，经生长批受理门）`)
      byCourse.set(target, lines)
    }
    const triggers: PlanGrowthTrigger[] = [...byCourse.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([course, lines]) => ({ course, lines }))
    return { triggers, warnings }
  }
}
