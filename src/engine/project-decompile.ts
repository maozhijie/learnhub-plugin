/**
 * 目标反编译（P-5 / #95，v8 种子簇形态 #149）：输入「目标项目描述 + Vault 笔记」→
 * 反推**里程碑计划草案**与**知识子图种子簇**各一份（逆向设计：4C/ID 任务分析 + PjBL
 * ——知识为项目服务）。v7 的子图半区走 gen 骨架提案，随 #138 cutover 退役；v8 重接
 * 为种子起点（词条「种子」起点三路之 project 路）：子图簇 = 新课程的种子（1–3 起点
 * + 终点，起点 basis=project 由引擎铸造），显式目标课程时不产种子半区（课程唯一的
 * 新入口是种子；既有课程的新知识需要走计划修订驱动的教练补支）。
 *
 * 双产物**同源同进同退**（#149 / ADR-0015 裁决 6：apply 前零 canonical 写入）：
 * - 静态半（受理门）：两半区各自过既有 schema 门（validatePlanArtifact /
 *   validateSeedProposal——骨架模式：种子零 enc 零 est、粗占位边由引擎落到
 *   endpoint.pre），外加**名字对账门**（reconcilePlanNodes：plan[].nodes 引用的节点名
 *   ⊆ 种子簇节点名 ∪ 既有课程图节点名）——任一错误行即整体不受理，零提案（同退）。
 * - 动态半（apply/reject）：两提案带 pair 联动（ProposalRec.pair），apply 须走联合
 *   入口（种子先落图、计划后落盘——计划引用先有图可解析，堵住「计划先 apply 而种子
 *   悬空」的消费面时序缺口）；任一半区单独 apply 被守卫拒、任一半区 reject 联动拒
 *   另一半。
 *
 * 本模块只放纯函数（零 IO、零引擎实例依赖）：目标描述解析、检索词派生、双产物拆分
 * 校验、名字对账门、修复轮提示词拼装；编排（检索/提案受理/联动）在引擎门面
 * projectDecompile / projectDecompileApply。
 */
import { validatePlanArtifact } from './projects.ts'
import type { PlanItem } from './projects.ts'
import { validateSeedProposal } from './seed.ts'
import type { SeedProposalSpec } from './seed.ts'
import { priorTerms } from './vault-prior.ts'

/** 反编译文档过门后的双半区规格。 */
export interface DecompileDoc {
  plan: PlanItem[]
  /** 种子半区：仅无显式目标课程时产出（mode 由引擎锁 new；起点 basis 铸 project）。 */
  seed?: SeedProposalSpec
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

/** 模型产出 → 双产物拆分校验：计划半区与种子半区各自过既有 schema 门，错误行聚合
 * 一次给出（门面据此做修复轮回灌）；两半区任一非法即整体不受理（同进同退的静态半）。
 *
 * expectSeed = 未给显式目标课程（子图簇充当新课程种子，半区必出）；false = 显式目标
 * 课程（课程的结构入口只有种子/生长，模型再产 seed 半区即拒——计划引用既有节点名，
 * 新知识需要留给计划修订驱动的教练补支）。
 *
 * 种子半区的受理侧定写（引擎铸造，不信模型）：mode 锁 new（自拟课程名撞既有注册表
 * 由门面预检/受理门拒收）、起点 basis 铸 project（起点三路的第三路接线，#149）。 */
export function splitDecompileDoc(
  doc: unknown, projectId: string, opts: { expectSeed: boolean },
): { errors: string[]; result?: DecompileDoc } {
  if (typeof doc !== 'object' || doc === null) {
    return { errors: ['(顶层): 必须是映射（project/plan/seed）'] }
  }
  const d = doc as Record<string, unknown>
  const errors: string[] = []
  // 计划半区：#92 的 PlanArtifact 同一门（project 一致 + 条目 schema）
  const pv = validatePlanArtifact({ project: d.project, plan: d.plan }, projectId)
  errors.push(...(pv.errors ?? []))
  // 种子半区：kind=seed 提案同一门（骨架模式——节点零 enc 零 est，粗占位边引擎落）
  let seed: SeedProposalSpec | undefined
  if (d.seed !== undefined) {
    const sv = validateSeedProposal({ ...(d.seed as Record<string, unknown>), mode: 'new' })
    errors.push(...(sv.errors ?? []))
    if (sv.spec) {
      seed = {
        ...sv.spec,
        mode: 'new',
        starts: sv.spec.starts.map(s => ({ ...s, basis: 'project' as const })),
      }
    }
  }
  if (!opts.expectSeed && d.seed !== undefined) {
    errors.push('seed: 显式目标课程时不产种子半区（课程的结构入口只有种子/生长——计划引用既有节点名；新知识需要走计划修订驱动的教练补支）')
    seed = undefined
  }
  if (opts.expectSeed && d.seed === undefined) {
    errors.push('seed: 缺失（未给显式目标课程时种子半区必出——反编译子图簇直通新课程的种子起点：1–3 起点 + 终点）')
  }
  if (errors.length) return { errors }
  return { errors: [], result: { plan: pv.plan!, ...(seed ? { seed } : {}) } }
}

/** 名字对账门（受理侧质量门，非学习者门禁；#126 接口输入的落地）：plan[].nodes
 * 引用的节点名必须有着落——种子簇节点名（同源产物自洽）∪ 既有课程图节点名（按
 * 「课程/节点」前缀定位课程，裸名对全部既有名字）。悬空引用会让 resolveProjectNodes
 * 在消费面 fail loud（过点/检索点/行使/2×2），对账门把它拦在受理前；与断边/环检查
 * 同一性质（约束 agent 产出自洽，ADR-0015 裁决 6 的「关联不门禁人」不拦「对账约束
 * agent」）。返回错误行列表（空 = 通过）。 */
export function reconcilePlanNodes(
  plan: PlanItem[],
  opts: { seed?: { course: string; nodeNames: Set<string> }; existingByCourse: Map<string, Set<string>> },
): string[] {
  const existingNames = new Set<string>()
  for (const names of opts.existingByCourse.values()) for (const n of names) existingNames.add(n)
  const errors: string[] = []
  plan.forEach((item, i) => {
    for (const [j, spec] of (item.nodes ?? []).entries()) {
      const where = `plan.${i + 1}.nodes.${j + 1}`
      if (spec.includes('/')) {
        const [cname, node] = spec.split('/', 2)
        const courseKey = cname.trim()
        const nodeKey = node.trim()
        if (opts.seed && courseKey === opts.seed.course) {
          const inSeed = opts.seed.nodeNames.has(nodeKey)
          const inExisting = opts.existingByCourse.get(courseKey)?.has(nodeKey) ?? false
          if (!inSeed && !inExisting) {
            errors.push(`${where}「${spec}」不在种子簇节点名中（同源对账：种子簇 = ${[...opts.seed.nodeNames].sort().join('、')}）`)
          }
          continue
        }
        const names = opts.existingByCourse.get(courseKey)
        if (!names) {
          errors.push(`${where} 引用课程「${courseKey}」不在注册表（反编译对账只对种子课程与既有课程）`)
          continue
        }
        if (!names.has(nodeKey)) {
          errors.push(`${where}「${spec}」引用的节点不在课程「${courseKey}」图内——反编译双提案必须自洽（计划引用悬空节点会在过点/检索点/行使消费面炸）；朝尚不存在节点的意图留给计划修订驱动的教练补支`)
        }
        continue
      }
      if (!opts.seed?.nodeNames.has(spec.trim()) && !existingNames.has(spec.trim())) {
        errors.push(`${where}「${spec.trim()}」未落在种子簇或既有图节点名中（名字对账门：引用的节点必须在种子簇内或既有图内；跨课程建议写「课程/节点」全形）`)
      }
    }
  })
  return errors
}

/** 修复轮提示词：原包 + 上次输出 + 门禁清单回灌，要求整体重出完整 YAML（模型高频
 * 违反输出契约——缺字段/漏半区；一次盲跑定生死会让入口反复失败，对齐既有
 * 「生成→门禁→修复一轮」机械）。 */
export function decompileRepairPrompt(pack: string, previous: string, errors: string[]): string {
  return `${pack}\n\n## 上一次输出未过双产物校验门（重新输出**完整** YAML 文档，修正下列全部问题；仍只输出一个 YAML，不要解释）\n\n上一次输出：\n\n${previous}\n\n校验清单：\n\n${errors.join('\n')}\n`
}
