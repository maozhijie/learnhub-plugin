/**
 * 目标反编译（P-5 / #95，v8 种子簇形态 #149）：输入「目标项目描述 + Vault 笔记」→
 * 反推**里程碑计划草案**与**知识子图种子簇**各一份（逆向设计：4C/ID 任务分析 + PjBL
 * ——知识为项目服务）。子图半区走种子起点（词条「种子」起点三路之 project 路）：
 * 子图簇 = 新课程的种子（1–3 起点
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

/** 「课程/节点」规格的共享解析（对账门与门面触发解析同一条解析路径）：带「/」前缀
 * = 显式课程引用；裸名 = 跨课程引用（存在性/唯一性由调用方按各自语义判定）。 */
export function splitNodeSpec(spec: string): { course?: string; node: string } {
  return spec.includes('/')
    ? (() => {
        const [cname, node] = spec.split('/', 2)
        return { course: cname.trim(), node: node.trim() }
      })()
    : { node: spec.trim() }
}

/** 名字对账门（受理侧质量门，非学习者门禁；#126 接口输入的落地）：plan[].nodes
 * 引用的节点名必须有着落且无歧义——种子簇节点名（同源产物自洽）∪ 既有课程图节点名。
 * 显式「课程/节点」= 该课程图内必须存在；裸名 = 恰一着落（种子簇命中与既有课程命中
 * 并存、或多门课程命中都是歧义——消费面 locateNode 对多门命中 fail loud，对账门把
 * 悬空与歧义一并拦在受理前；与断边/环检查同一性质：约束 agent 产出自洽，ADR-0015
 * 裁决 6 的「关联不门禁人」不拦「对账约束 agent」）。返回错误行列表（空 = 通过）。 */
export function reconcilePlanNodes(
  plan: PlanItem[],
  opts: { seed?: { course: string; nodeNames: Set<string> }; existingByCourse: Map<string, Set<string>> },
): string[] {
  const errors: string[] = []
  plan.forEach((item, i) => {
    for (const [j, spec] of (item.nodes ?? []).entries()) {
      const where = `plan.${i + 1}.nodes.${j + 1}`
      const { course, node } = splitNodeSpec(spec)
      if (course !== undefined) {
        if (opts.seed && course === opts.seed.course) {
          const inSeed = opts.seed.nodeNames.has(node)
          const inExisting = opts.existingByCourse.get(course)?.has(node) ?? false
          if (!inSeed && !inExisting) {
            errors.push(`${where}「${spec}」不在种子簇节点名中（同源对账：种子簇 = ${[...opts.seed.nodeNames].sort().join('、')}）`)
          }
          continue
        }
        const names = opts.existingByCourse.get(course)
        if (!names) {
          errors.push(`${where} 引用课程「${course}」不在注册表（反编译对账只对种子课程与既有课程）`)
          continue
        }
        if (!names.has(node)) {
          errors.push(`${where}「${spec}」引用的节点不在课程「${course}」图内——反编译双提案必须自洽（计划引用悬空节点会在过点/检索点/行使消费面炸）；朝尚不存在节点的意图留给计划修订驱动的教练补支`)
        }
        continue
      }
      // 裸名：恰一着落（种子簇 ∪ 各课程唯一命中）
      const courseHits = [...opts.existingByCourse.entries()].filter(([, names]) => names.has(node)).map(([c]) => c)
      const seedHit = opts.seed?.nodeNames.has(node) ?? false
      if (seedHit && courseHits.length) {
        errors.push(`${where}「${node}」同时落在种子簇与课程「${courseHits.join('、')}」——歧义引用，写「课程名/节点名」全形`)
      } else if (courseHits.length > 1) {
        errors.push(`${where}「${node}」在多门课程中命中（${courseHits.join('、')}）——歧义引用，写「课程名/节点名」全形`)
      } else if (!seedHit && courseHits.length === 0) {
        errors.push(`${where}「${node}」未落在种子簇或既有图节点名中（名字对账门：引用的节点必须在种子簇内或既有图内；跨课程建议写「课程/节点」全形）`)
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

/** 里程碑计划条目（设计 §3 关键接口：#92 提案修订与 #95 目标反编译的共同产出形态）。
 * est/nodes 可选（#93/#94 落地）：est = 过点定价申报（分钟）；nodes = 关联课程节点
 * （检索点抽题与行为推断 enc 的挂靠点，ADR-0015 裁决 6——关联永不构成门禁）。
 * 住本模块（projects.ts 经 re-export 供门面与 tests 的既有导入路径消费）。 */
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

export function validatePlanArtifact(doc: unknown, projectId: string): { errors?: string[]; plan?: PlanItem[] } {
  if (typeof doc !== 'object' || doc === null) return { errors: ['(顶层): 必须是映射'] }
  const d = doc as Record<string, unknown>
  if (d.project !== projectId) return { errors: [`project: 「${String(d.project)}」与目标项目「${projectId}」不一致`] }
  const plan = validatePlanItems(d.plan)
  if (plan.errors.length) return { errors: plan.errors }
  if (!plan.plan.length) return { errors: ['plan: 不能为空（撤销计划请改用生命周期 archived，不 empty-plan 覆写）'] }
  return { plan: plan.plan }
}
