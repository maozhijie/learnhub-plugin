/**
 * 目标反编译（P-5 / #95）：输入「目标项目描述 + Vault 笔记」→ 反推**里程碑计划草案**
 * 与**知识子图提案**各一份（逆向设计：4C/ID 任务分析 + PjBL——知识为项目服务）。
 *
 * 双产物都走既有 Proposal 人审通道、零新 proposal kind（#92/#105 的 P 区接口裁决）：
 * - 计划半区 = `PlanArtifact{project, plan}`（与 #92 计划提案同构，validatePlanArtifact
 *   同一 schema 门），proposePlan 受理、projectApply 生效、graphReject 拒绝；
 * - 子图半区 = 图谱域**单 pending gen 提案**（regions 形态两用：显式目标课程 → mode=append
 *   追加进该课程；无课程 → mode=new 独立成「新课程骨架」——按 graphPropose 既有校验门
 *   能过的最简形态，先例 P-6 projectEncCandidates 的单提案人审）。
 *
 * 红线（ADR-0015 裁决 6 + ADR-0010）：apply 前零 canonical 写入（不动课程图、不写
 * 项目.md 的 plan）；检索面复用 V-2 vault-prior（只读，永不写个人笔记）；关联永不构成
 * 门禁。双提案**同进同退**：门禁拆分校验与 gen 结构检查都在受理任一提案前完成（门面编排），
 * 不留半挂状态。
 *
 * 本模块只放纯函数（零 IO、零引擎实例依赖）：目标描述解析、检索词派生、双产物拆分校验、
 * 子图落点裁决、修复轮提示词拼装；编排（检索/提案受理）在引擎门面 projectDecompile。
 */
import { validatePlanArtifact } from './projects.ts'
import type { PlanItem } from './projects.ts'
import { validateGenProposal } from './gengraph.ts'
import type { GenProposalSpec } from './gengraph.ts'
import { priorTerms } from './vault-prior.ts'

/** 反编译产出的子图半区（gen 提案的 regions 形态，节点已过 parseNode 解析）。 */
export interface DecompileSubgraph {
  course: string
  regions: GenProposalSpec['regions']
}

/** 目标描述解析：显式参数优先（trim），缺省回落项目档案 goal；两者皆空 fail loud——
 * 目标项目描述是反编译的唯一任务输入，空输入静默回落会让模型自由发挥。 */
export function decompileGoalOf(explicit: string | undefined, projectGoal: string): string {
  const goal = (explicit ?? projectGoal).trim()
  if (!goal) {
    throw new Error('[project-decompile] 目标描述为空：反编译的输入是目标项目描述原文（显式 goal 参数或项目档案 goal 至少一个非空）。')
  }
  return goal
}

/** 检索面（V-2 同口径）：检索词 = 目标描述经 priorTerms 派生 + 注册笔记标题/名。
 * 纯派生零 IO——扫描交给 searchVaultPrior（只读纪律在那一侧锁死）。 */
export function decompileTerms(goal: string, noteTitles: string[]): string[] {
  return priorTerms([goal, ...noteTitles])
}

/** 模型产出 → 双产物拆分校验：计划半区与子图半区各自过既有 schema 门
 * （validatePlanArtifact / validateGenProposal），错误行聚合一次给出——门面据此做
 * 修复轮回灌；两半区任一非法即整体不受理（双提案同进同退的静态半）。 */
export function splitDecompileDoc(
  doc: unknown, projectId: string,
): { errors: string[]; plan?: PlanItem[]; subgraph?: DecompileSubgraph } {
  if (typeof doc !== 'object' || doc === null) {
    return { errors: ['(顶层): 必须是映射（project/plan/subgraph）'] }
  }
  const d = doc as Record<string, unknown>
  const errors: string[] = []
  // 计划半区：#92 的 PlanArtifact 同一门（project 一致 + 条目 schema）
  const pv = validatePlanArtifact({ project: d.project, plan: d.plan }, projectId)
  errors.push(...(pv.errors ?? []))
  // 子图半区：gen 提案同一门（course 非空 + regions 形态；mode 由门面按落点裁决，此处占位）
  const s = (d.subgraph ?? {}) as Record<string, unknown>
  const gv = validateGenProposal({ course: s.course, mode: 'append', regions: s.regions })
  errors.push(...(gv.errors ?? []))
  if (errors.length) return { errors }
  return {
    errors: [],
    plan: pv.plan,
    subgraph: { course: gv.spec!.course, regions: gv.spec!.regions },
  }
}

/** 子图落点裁决：目标课程由调用方显式给出（工具参数）→ append 追加进该课程、course
 * 显式值覆盖模型自拟名；未给 → new，模型自拟课程名独立成新课程骨架。 */
export function subgraphSpecOf(
  subgraph: DecompileSubgraph, explicitCourse: string | undefined,
): { course: string; mode: 'new' | 'append' } {
  const c = explicitCourse?.trim()
  return c ? { course: c, mode: 'append' } : { course: subgraph.course, mode: 'new' }
}

/** 修复轮提示词：原包 + 上次输出 + 门禁清单回灌，要求整体重出完整 YAML（模型高频
 * 违反输出契约——缺字段/漏半区；一次盲跑定生死会让入口反复失败，对齐既有
 * 「生成→门禁→修复一轮」机械）。 */
export function decompileRepairPrompt(pack: string, previous: string, errors: string[]): string {
  return `${pack}\n\n## 上一次输出未过双产物校验门（重新输出**完整** YAML 文档，修正下列全部问题；仍只输出一个 YAML，不要解释）\n\n上一次输出：\n\n${previous}\n\n校验清单：\n\n${errors.join('\n')}\n`
}
