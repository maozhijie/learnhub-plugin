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
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { YAML } from './yaml.ts'
import { todayStr } from './dates.ts'
import { atomicWrite } from './store.ts'
import { loadNote, saveNote } from './notes.ts'
import { safeFilename } from './paths.ts'
import type { Paths } from './paths.ts'
import type { Store } from './store.ts'
import type { ProposalRec } from './types.ts'

export type ProjectLifecycle = 'active' | 'paused' | 'delivered' | 'archived'
export const PROJECT_LIFECYCLES: ProjectLifecycle[] = ['active', 'paused', 'delivered', 'archived']

/** 渐退档（Fading Tier）：骨架→补全→独立；项目属性，产物形态随档生成（ADR-0015）。 */
export type FadingTier = '骨架' | '补全' | '独立'
export const FADING_TIERS: FadingTier[] = ['骨架', '补全', '独立']

/** 窄化谓词（校验与 as 转换共用，防各处手写 includes 散落漂移）。 */
export function isProjectLifecycle(v: unknown): v is ProjectLifecycle {
  return (PROJECT_LIFECYCLES as string[]).includes(v as string)
}
export function isFadingTier(v: unknown): v is FadingTier {
  return (FADING_TIERS as string[]).includes(v as string)
}

/** 里程碑计划条目（设计 §3 关键接口：#92 提案修订与 #95 目标反编译的共同产出形态）。
 * est/nodes 可选（#93/#94 落地）：est = 过点定价申报（分钟）；nodes = 关联课程节点
 * （检索点抽题与行为推断 enc 的挂靠点，ADR-0015 裁决 6——关联永不构成门禁）。 */
export interface PlanItem {
  id: string
  name: string
  task_class: string
  acceptance_hints: string
  /** 过点定价申报（分钟，正数；缺省回落 XP_PER_MILESTONE_DEFAULT）。 */
  est?: number
  /** 关联课程节点（节点名或「课程/节点」；抽题/行为扫描按此解析，空 = 未关联）。 */
  nodes?: string[]
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
export function validatePlanItems(raw: unknown, where = 'plan'): { errors: string[]; plan: PlanItem[] } {
  const errors: string[] = []
  const plan: PlanItem[] = []
  if (!Array.isArray(raw)) {
    return { errors: [`${where}: 必须是列表`], plan }
  }
  const ids = new Set<string>()
  raw.forEach((item, i) => {
    const n = i + 1
    if (typeof item !== 'object' || item === null) {
      errors.push(`${where}.${n}: 必须是映射`)
      return
    }
    const e = item as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    const taskClass = typeof e.task_class === 'string' ? e.task_class.trim() : ''
    const hints = typeof e.acceptance_hints === 'string' ? e.acceptance_hints.trim() : ''
    if (!id) errors.push(`${where}.${n}.id: 不能为空`)
    else if (ids.has(id)) errors.push(`${where}.${n}.id「${id}」重复`)
    else ids.add(id)
    if (!name) errors.push(`${where}.${n}.name: 不能为空`)
    if (!taskClass) errors.push(`${where}.${n}.task_class: 不能为空（任务类由简到繁的梯度描述）`)
    if (!hints) errors.push(`${where}.${n}.acceptance_hints: 不能为空（验收要点草案）`)
    // 可选域（#93/#94）：est 正数申报；nodes 非空字符串列表（去重保序）
    let est: number | undefined
    if (e.est !== undefined) {
      if (typeof e.est !== 'number' || !Number.isFinite(e.est) || e.est <= 0) {
        errors.push(`${where}.${n}.est: 必须是正数（分钟）`)
      } else {
        est = Math.round(e.est)
      }
    }
    let nodes: string[] | undefined
    if (e.nodes !== undefined) {
      if (!Array.isArray(e.nodes)) {
        errors.push(`${where}.${n}.nodes: 必须是列表`)
      } else {
        const seen = new Set<string>()
        nodes = []
        for (const v of e.nodes) {
          if (typeof v !== 'string' || !v.trim()) {
            errors.push(`${where}.${n}.nodes: 条目必须是非空字符串`)
            nodes = undefined
            break
          }
          const t = v.trim()
          if (!seen.has(t)) {
            seen.add(t)
            nodes.push(t)
          }
        }
        if (nodes && !nodes.length) nodes = undefined
      }
    }
    plan.push({
      id, name, task_class: taskClass, acceptance_hints: hints,
      ...(est !== undefined ? { est } : {}),
      ...(nodes ? { nodes } : {}),
    })
  })
  return { errors, plan }
}

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
export function validatePlanArtifact(doc: unknown, projectId: string): { errors?: string[]; plan?: PlanItem[] } {
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (d.project !== projectId) return { errors: [`project: 「${String(d.project)}」与目标项目「${projectId}」不一致`] }
  const plan = validatePlanItems(d.plan)
  if (plan.errors.length) return { errors: plan.errors }
  if (!plan.plan.length) return { errors: ['plan: 不能为空（撤销计划请改用生命周期 archived，不 empty-plan 覆写）'] }
  return { plan: plan.plan }
}

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

/** 项目提案 apply 结果（判别联合：kind 区分计划/里程碑）。 */
export type ProjectApplyResult =
  | { kind: 'project_plan'; project: string; milestones: number; snapshot: string | null }
  | { kind: 'project_milestone'; project: string; milestone: string; file: string; snapshot: string }

export class Projects {
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  private paths: Paths
  private store: Store
  constructor(paths: Paths, store: Store) {
    this.paths = paths
    this.store = store
  }

  /** 全部项目（按目录名序）。目录存在但项目.md 缺失 = 跳过（半建状态不算 Broken）。 */
  async list(): Promise<ProjectFm[]> {
    if (!existsSync(this.paths.projectsDir)) return []
    const out: ProjectFm[] = []
    for (const ent of await readdir(this.paths.projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const p = this.paths.projectNotePath(ent.name)
      if (!existsSync(p)) continue
      out.push(await this.load(ent.name))
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 读单个项目；不存在 = Missing 报错（调用方决定语义）。存在但坏 = Broken。 */
  async load(id: string): Promise<ProjectFm> {
    const p = this.paths.projectNotePath(id)
    if (!existsSync(p)) throw new Error(`[projects] 项目「${id}」不存在（Missing）：先 learnhub_project_create。`)
    const { fm } = await loadNote(p)
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
    if (existsSync(p)) throw new Error(`[project-create] 项目「${id}」已存在（${p}）。`)
    const today = todayStr()
    const fm: ProjectFm = { id, name, lifecycle: 'active', tier, goal, plan: [], created: today, updated: today }
    await mkdir(this.paths.projectDir(id), { recursive: true })
    await mkdir(this.paths.projectMilestoneDir(id), { recursive: true })
    await saveNote(p, fm as unknown as Record<string, unknown>, `# ${name}\n\n> 目标：${goal}\n\n（里程碑计划走 learnhub_project_plan_generate 提案通道；产物见 milestones/。）\n`)
    return fm
  }

  /** 全量写回项目 frontmatter（updated 随写随戳；body 不动）。 */
  async saveFm(id: string, fm: ProjectFm): Promise<void> {
    const p = this.paths.projectNotePath(id)
    if (!existsSync(p)) throw new Error(`[projects] 项目「${id}」不存在（Missing）。`)
    const { body } = await loadNote(p)
    await saveNote(p, { ...fm, updated: todayStr() } as unknown as Record<string, unknown>, body)
  }

  /** 项目视图：计划 × 产物落盘状态 + 遗留文件。 */
  async view(id: string): Promise<ProjectView> {
    const fm = await this.load(id)
    const expected = new Map(fm.plan.map((m, i) => [milestoneFileOf(i, m.name), m]))
    const orphans: string[] = []
    const dir = this.paths.projectMilestoneDir(id)
    if (existsSync(dir)) {
      for (const f of await readdir(dir)) {
        if (!expected.has(f)) orphans.push(f)
      }
    }
    return {
      fm,
      milestones: fm.plan.map((m, i) => {
        const file = milestoneFileOf(i, m.name)
        return { id: m.id, name: m.name, task_class: m.task_class, acceptance_hints: m.acceptance_hints, file, generated: existsSync(this.paths.projectMilestonePath(id, file)) }
      }),
      orphans,
    }
  }

  // ---- 计划提案（project_plan；带快照的修订通道，设计 §7） ----

  async proposePlan(projectId: string, yamlText: string): Promise<{ id: number; kind: 'project_plan'; project: string; milestones: number; initial: boolean }> {
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
    const pid = await this.store.createProposal('project_plan', projectId,
      `${initial ? '初次规划' : '计划修订'}：${v.plan.length} 个里程碑`, '')
    const path = this.paths.proposalArtifactPath(pid, 'project_plan', projectId)
    await mkdir(this.paths.proposalDir, { recursive: true })
    await writeFile(path, YAML.stringify(doc), 'utf8')
    await this.store.updateProposal(pid, { artifact: path })
    return { id: pid, kind: 'project_plan', project: projectId, milestones: v.plan.length, initial }
  }

  /** apply 计划提案：被替换的旧计划 YAML 落快照（初次规划无快照），不静默覆盖。 */
  async applyPlan(pid?: number): Promise<ProjectApplyResult> {
    const prop = await this.store.takePending('project_plan', pid)
    const v = validatePlanArtifact(await this.loadArtifact(prop), prop.course)
    if (v.errors || !v.plan) {
      throw new Error(`[project-plan-apply] 提案产物 schema 失效。\n${(v.errors ?? []).map(e => `  ✗ ${e}`).join('\n')}`)
    }
    const project = await this.load(prop.course)
    let snapshot: string | null = null
    if (project.plan.length) {
      snapshot = this.paths.projectSnapshotPath(prop.id, 'plan.yaml')
      await atomicWrite(snapshot, YAML.stringify({ project: project.id, plan: project.plan }))
    }
    await this.saveFm(project.id, { ...project, plan: v.plan })
    // 不写 journal：journal 是学习行为流水（streak/热力图聚合它的全部行），项目域写它会
    // 涨 streak——违反 ADR-0015 裁决 7「节点消费者对 Project 不可见」。留痕 = 提案记录本身
    // （pending/applied + decision_note 带快照路径）。
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date().toISOString(),
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
    if (existsSync(path)) {
      throw new Error(`[project-milestone] 「${file}」已生成——按档重生成走提案通道（learnhub_project_milestone_generate 会自动转提案，apply 后带快照覆盖）。`)
    }
    this.gateOrFail(md, project.tier)
    await mkdir(this.paths.projectMilestoneDir(projectId), { recursive: true })
    await writeFile(path, md.trimEnd() + '\n', 'utf8')
    return { written: file, tier: project.tier }
  }

  /** 按档重生成提案：产物已存在时唯一合法的覆盖通道（带快照，设计 §4/§7）。 */
  async proposeMilestone(projectId: string, milestoneId: string, md: string): Promise<{ id: number; kind: 'project_milestone'; project: string; milestone: string; file: string }> {
    const { project, item, file } = await this.locateMilestone(projectId, milestoneId)
    const path = this.paths.projectMilestonePath(projectId, file)
    if (!existsSync(path)) {
      throw new Error(`[project-milestone] 「${file}」尚未生成——首生直落即可（learnhub_project_milestone_generate），无需提案。`)
    }
    this.gateOrFail(md, project.tier)
    const doc: MilestoneArtifact = { project: projectId, milestone: milestoneId, md }
    const pid = await this.store.createProposal('project_milestone', projectId,
      `里程碑「${item.name}」按档「${project.tier}」重生成`, '')
    const artifactPath = this.paths.proposalArtifactPath(pid, 'project_milestone', projectId)
    await mkdir(this.paths.proposalDir, { recursive: true })
    await writeFile(artifactPath, YAML.stringify(doc), 'utf8')
    await this.store.updateProposal(pid, { artifact: artifactPath })
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
    await atomicWrite(snapshot, await readFile(path, 'utf8'))
    await mkdir(this.paths.projectMilestoneDir(project.id), { recursive: true })
    await writeFile(path, v.md.trimEnd() + '\n', 'utf8')
    await this.store.updateProposal(prop.id, {
      status: 'applied', decided: new Date().toISOString(), decision_note: `快照 ${snapshot}`,
    })
    return { kind: 'project_milestone', project: project.id, milestone: v.milestone, file, snapshot }
  }

  /** 落盘分发（引擎唯一消费入口）：未生成 = 首生直落；已生成 = 自动转重生成提案
   * （带快照覆盖，设计 §4「不静默覆盖」）。 */
  async writeMilestone(projectId: string, milestoneId: string, md: string): Promise<
    { written: string; tier: FadingTier } | { proposed: number; kind: 'project_milestone'; file: string }
  > {
    const { project, file } = await this.locateMilestone(projectId, milestoneId)
    if (existsSync(this.paths.projectMilestonePath(projectId, file))) {
      const prop = await this.proposeMilestone(projectId, milestoneId, md)
      return { proposed: prop.id, kind: 'project_milestone', file }
    }
    return this.generateMilestone(projectId, milestoneId, md)
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
    const settled = (await this.store.journalTail(project.id, Number.MAX_SAFE_INTEGER))
      .some(r => r.kind === 'milestone_settle' && r.node === milestoneId)
    if (settled) {
      throw new Error(`[project-pass] 里程碑「${milestoneId}」已过点对账（定价锁定，重复过点不入账）；计划换了内容请用新的里程碑 id。`)
    }
    await this.store.appendJournal({
      course: project.id, node: milestoneId, rating: null,
      kind: 'milestone_settle', elapsed_days: 0,
      xp: settle.xp, detail: `里程碑「${item.name}」过点：${settle.detail}`,
    })
    return { project: project.id, milestone: milestoneId, name: item.name, file, xp: settle.xp }
  }

  /** 里程碑已过点？（对账流水即事实，零新增状态文件。） */
  async isMilestonePassed(projectId: string, milestoneId: string): Promise<boolean> {
    return (await this.store.journalTail(projectId, Number.MAX_SAFE_INTEGER))
      .some(r => r.kind === 'milestone_settle' && r.node === milestoneId)
  }

  /** 里程碑产物落盘状态（#93 检索点门槛：交付物 = 任务卡已生成）。 */
  async isMilestoneDelivered(projectId: string, milestoneId: string): Promise<{ delivered: boolean; file: string }> {
    const { file } = await this.locateMilestone(projectId, milestoneId)
    return { delivered: existsSync(this.paths.projectMilestonePath(projectId, file)), file }
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
    if (!existsSync(prop.artifact)) throw new Error(`[projects] 提案产物文件不存在: ${prop.artifact}`)
    return YAML.parse(await readFile(prop.artifact, 'utf8'))
  }
}
