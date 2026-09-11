/**
 * 技能条目与执行事件调度通道（U-2 #89 / ADR-0018 + ADR-0019）。
 *
 * 技能条目（Skill Entry）= 无界实践区可排期的实践主体（乐器/运动/编程…），执行事件
 * 调度 lane 的唯一 v1 载体：lane 与题目 FSRS 并行（复用 ts-fsrs 数学与 21 参数，经
 * advance.ts 同一推进内核），**不复用题目卡、不进复习队列、无 mastery、不进题目门禁**。
 * 状态落 学习中心/技能/<id>.yaml（ADR-0018 工程影响：实体形态归本票定）。
 *
 * 执行事件（Execution Event）= 真实执行 + 表现评级（1-4 整数 + 来源枚举 auto/self/ai）。
 * 入口契约只锁两件事：评级是 [1,4] 整数（分数直喂禁止——ts-fsrs 乘子按枚举精确判等）、
 * 来源诚实登记；映射归生产者——auto 来源必须走可观测证据的确定性映射（ratingFromEvidence），
 * 无判据可测退化为学习者自评档（self）。落盘复用 ReviewRec（rating_source='execution'），
 * 不建并行日志；维持/习得靠 event_kind 字段区分（#89 验收项）。
 *
 * 维持性复活 = lane 内 due 驱动 + 维持节拍上限（默认 30 天可关可调）：技能条目的生效
 * 到期取「FSRS due」与「上次事件日 + 维持帽」较早者——到期即到，不被间隔增长淹没
 * （Arthur 1998：停用技能 d 滑至 -1.4，低频接触本身有价值）。帽先到的事件记 maintenance
 * （会话内容形态 = 迷你重做+回放），FSRS due 先到记 acquisition。无独立维持调度器。
 *
 * XP：执行事件按其原生专注时长入账（1 XP ≈ 1 分钟，journal kind='xp_execution'，
 * 对齐 xp_learner 无绑定行先例），进 streak 口径——时长可信性判据（ADR-0019）；
 * 不设反作弊门（账本是学习者自己的）。
 *
 * Missing/Broken 纪律沿用 ADR-0004：技能文件缺失 = 合法空态；存在但坏 = Broken 抛出。
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import { YAML } from './yaml.ts'
import { todayStr, addDays } from './dates.ts'
import type { Clock } from './clock.ts'
import type { FsrsBlock } from './types.ts'
import type { AdvanceCard, AdvanceLog } from './advance.ts'
import type { Paths } from './paths.ts'

export type SkillStatus = 'active' | 'archived'
export const SKILL_STATUSES: SkillStatus[] = ['active', 'archived']

/** 执行事件评分来源枚举（ADR-0018 入口契约；auto = 可观测证据确定性映射）。 */
export type ExecutionSource = 'auto' | 'self' | 'ai'
export const EXECUTION_SOURCES: ExecutionSource[] = ['auto', 'self', 'ai']

/** 执行事件种类（ADR-0018 裁决 6：维持事件与习得事件在流水可区分）。 */
export type ExecutionEventKind = 'acquisition' | 'maintenance'

/** 维持节拍默认上限（天，可关可调；Arthur 1998 的低频接触节拍）。 */
export const MAINTENANCE_DEFAULT_DAYS = 30
/** 维持帽 clamp 边界：低于一周的「维持」是日常练习不是维持节拍，超过一年间隔增长已淹没它。 */
export const MAINTENANCE_MIN_DAYS = 7
export const MAINTENANCE_MAX_DAYS = 365

/** 技能条目（技能/<id>.yaml frontmatter 同构）。 */
export interface SkillDoc {
  /** id = 安全文件名（唯一）。 */
  skill: string
  name: string
  status: SkillStatus
  /** 维持节拍上限（天）；null = 关（lane 退化为纯 FSRS due 驱动）。 */
  maintenance_days: number | null
  /** lane 的隔离调度状态（从未执行 = 缺省；永不写回任何题目卡/节点 frontmatter）。 */
  fsrs?: FsrsBlock
  /** 一 lane 一学习日一次推进门（stats.last）+ 简单计数（correct = 评级 >1 次数）。 */
  stats?: { attempts: number; correct: number; last?: string }
  created: string
  updated: string
}

/** 维持帽取值归一：undefined = 缺省节拍；null/0 = 关；数字 clamp [7,365]，非法输入
 * fail loud（显式设置动作；坏档不能静默读成默认）。 */
export function clampMaintenanceDays(v: number | null | undefined, op = 'skill-maintenance'): number | null {
  if (v === undefined) return MAINTENANCE_DEFAULT_DAYS
  if (v === null || v === 0) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`[${op}] maintenance_days 只能是天数或 null（关闭）；收到 ${String(v)}。`)
  }
  const d = Math.round(v)
  if (d < MAINTENANCE_MIN_DAYS || d > MAINTENANCE_MAX_DAYS) {
    throw new Error(`[${op}] maintenance_days 必须在 ${MAINTENANCE_MIN_DAYS}–${MAINTENANCE_MAX_DAYS} 天之间（收到 ${d}）；关闭传 null。`)
  }
  return d
}

/** lane 生效到期（#105 接缝：维持节拍纯函数）：FSRS due 与「上次事件日 + 维持帽」
 * 取较早；从未执行返回 null（fresh——首推入口，无到期语义）。 */
export function laneDue(fs: FsrsBlock | null | undefined, maintenanceDays: number | null): string | null {
  if (!fs || !fs.reps) return null
  const due = fs.due
  if (maintenanceDays) {
    const cap = addDays(fs.last_review, maintenanceDays)
    if (cap && cap < due) return cap
  }
  return due
}

/** 到期/事件种类（纯函数）：维持帽**严格早于** FSRS due 且今天已到帽 → maintenance
 * （帽是把 lane 带到到期的因，会话内容形态 = 迷你重做+回放）；其余（含 fresh、
 * 未到期的提前练习、FSRS due 先到或同日）都是 acquisition。 */
export function laneEventKind(
  fs: FsrsBlock | null | undefined, maintenanceDays: number | null, today: string,
): ExecutionEventKind {
  if (fs?.reps && maintenanceDays) {
    const cap = addDays(fs.last_review, maintenanceDays)
    if (cap && cap < fs.due && today >= cap) return 'maintenance'
  }
  return 'acquisition'
}

/** 可观测执行证据（准确率 / 自主求助次数；全部可缺省）。 */
export interface ExecutionEvidence { accuracy?: number; self_help?: number }

/** 可观测执行证据 → 1-4 确定性映射（ADR-0018 裁决 3 的仓库推荐默认，不收主观自由分）：
 * 准确率带 [≥0.9→4, ≥0.7→3, ≥0.4→2, <0.4→1]；自主求助超过 1 次每次降一档
 * （求助=卡壳的可观测信号）。无 accuracy 判据时调用方必须退化走学习者自评档。 */
export function ratingFromEvidence(ev: ExecutionEvidence): 1 | 2 | 3 | 4 {
  const acc = ev.accuracy
  if (typeof acc !== 'number' || !Number.isFinite(acc) || acc < 0 || acc > 1) {
    throw new Error(`[execution-log] 证据映射需要 0–1 的 accuracy（收到 ${String(acc)}）；无可观测判据时改用自评档（source='self' + rating）。`)
  }
  const help = typeof ev.self_help === 'number' && Number.isFinite(ev.self_help) ? Math.max(0, Math.round(ev.self_help)) : 0
  const band = acc >= 0.9 ? 4 : acc >= 0.7 ? 3 : acc >= 0.4 ? 2 : 1
  return Math.max(1, band - Math.max(0, help - 1)) as 1 | 2 | 3 | 4
}

/** 技能文档契约校验（读侧与写侧共用同一口径，风格同 validateProjectFm）。 */
export function validateSkillDoc(raw: unknown, path: string): SkillDoc {
  const bad = (detail: string): Error =>
    new Error(`[skills] 技能条目 Broken（位置：${path}）\n  ✗ ${detail}`)
  if (typeof raw !== 'object' || raw === null) throw bad('frontmatter 必须是映射')
  const d = raw as Record<string, unknown>
  const skill = typeof d.skill === 'string' ? d.skill.trim() : ''
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (!skill) throw bad('skill: 不能为空')
  if (!name) throw bad('name: 不能为空')
  if (!(SKILL_STATUSES as string[]).includes(String(d.status))) {
    throw bad(`status: 非法值 ${String(d.status)}（允许 ${SKILL_STATUSES.join('/')}）`)
  }
  // 缺省 = 默认节拍；null = 关；数字 clamp（非法值 fail loud——坏档不能读成默认）
  const maintenance = clampMaintenanceDays(d.maintenance_days as number | null | undefined, 'skills')
  if (typeof d.created !== 'string' || !d.created) throw bad('created: 不能为空')
  if (typeof d.updated !== 'string' || !d.updated) throw bad('updated: 不能为空')
  return {
    skill,
    name,
    status: d.status as SkillStatus,
    maintenance_days: maintenance,
    ...(d.fsrs && typeof d.fsrs === 'object' ? { fsrs: d.fsrs as FsrsBlock } : {}),
    ...(d.stats && typeof d.stats === 'object' ? { stats: d.stats as SkillDoc['stats'] } : {}),
    created: d.created,
    updated: d.updated,
  }
}

/** 执行事件一次落账的完整产出（engine.executionLog 的返回）。 */
export interface ExecutionLogResult {
  skill: string
  rating: 1 | 2 | 3 | 4
  source: ExecutionSource
  kind: ExecutionEventKind
  /** 推进后的 lane 到期（下一节拍）。 */
  due: string
  /** 本次入账 XP（= 原生专注分钟数，ADR-0019）。 */
  xp: number
  minutes: number
  attempts: number
}

/** 推进内核消费的最小投影（stats 语义与题卡/我的卡同构）。 */
export type SkillCard = SkillDoc & AdvanceCard

export class Skills {
  private paths: Paths
  private clock: Clock
  private fs: VaultFs
  constructor(paths: Paths, clock: Clock, fs: VaultFs) {
    this.paths = paths
    this.clock = clock
    this.fs = fs
  }

  /** 全部技能（按 id 序）。目录存在但文件读不了 = 跳过并在 broken 报出（不阻塞清单）。 */
  async list(): Promise<{ skills: SkillDoc[]; broken: Array<{ id: string; path: string; reason: string }> }> {
    const out: SkillDoc[] = []
    const broken: Array<{ id: string; path: string; reason: string }> = []
    if (!this.fs.exists(this.paths.skillsDir)) return { skills: out, broken }
    for (const f of (await this.fs.readdir(this.paths.skillsDir)).filter(f => f.endsWith('.yaml')).sort()) {
      const p = `${this.paths.skillsDir}/${f}`
      try {
        out.push(validateSkillDoc(YAML.parse(await this.fs.readFile(p)), p))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        broken.push({ id: f.replace(/\.yaml$/, ''), path: p, reason: reason.includes('Broken') ? reason : `技能条目 Broken：${reason}` })
      }
    }
    return { skills: out, broken }
  }

  /** 读单个技能；不存在 = Missing 报错；存在但坏（含 YAML 解析失败）= Broken。 */
  async load(id: string): Promise<SkillDoc> {
    const p = this.paths.skillPath(id)
    if (!this.fs.exists(p)) throw new Error(`[skills] 技能「${id}」不存在（Missing）：先 learnhub_skill_create。`)
    let raw: unknown
    try {
      raw = YAML.parse(await this.fs.readFile(p))
    } catch (err) {
      throw new Error(`[skills] 技能条目 Broken（位置：${p}）\n  ✗ YAML 无法解析：${err instanceof Error ? err.message : String(err)}`)
    }
    return validateSkillDoc(raw, p)
  }

  /** 建技能条目：id 缺省取安全化名称；同名已存在即拒绝。 */
  async create(input: { name: string; id?: string; maintenance_days?: number | null }): Promise<SkillDoc> {
    const name = input.name.trim()
    if (!name) throw new Error('[skill-create] name 不能为空（乐器/运动/编程……这个持续技能叫什么）。')
    const id = (input.id ?? name).trim()
    if (!id || id.includes('..')) throw new Error(`[skill-create] id 非法：${id}`)
    const p = this.paths.skillPath(id)
    if (this.fs.exists(p)) throw new Error(`[skill-create] 技能「${id}」已存在（${p}）。`)
    const maintenance = clampMaintenanceDays(input.maintenance_days, 'skill-create')
    const today = todayStr(new Date(this.clock.nowMs()))
    const doc: SkillDoc = { skill: id, name, status: 'active', maintenance_days: maintenance, created: today, updated: today }
    await atomicWrite(p, YAML.stringify(doc), this.fs)
    return doc
  }

  /** 全量写回（updated 随写随戳）；Evidence 字段（fsrs/stats）整体替换由作答侧调用。 */
  async save(id: string, doc: SkillDoc): Promise<void> {
    const p = this.paths.skillPath(id)
    if (!this.fs.exists(p)) throw new Error(`[skills] 技能「${id}」不存在（Missing）。`)
    await atomicWrite(p, YAML.stringify({ ...doc, updated: todayStr(new Date(this.clock.nowMs())) }), this.fs)
  }

  /** 归档/恢复（可逆；archived 只是收纳标签）。 */
  async setStatus(id: string, status: SkillStatus): Promise<SkillDoc> {
    const doc = await this.load(id)
    doc.status = status
    await this.save(id, doc)
    return doc
  }

  /** 推进后的写回（fsrs/stats 整体替换；调用方已过守门）。 */
  async updateEvidence(id: string, patch: { fsrs: FsrsBlock; stats: NonNullable<SkillDoc['stats']> }): Promise<void> {
    const doc = await this.load(id)
    await this.save(id, { ...doc, fsrs: patch.fsrs, stats: patch.stats })
  }
}

/** 执行事件的复习日志身份与 XP 流水的 detail 公共拼装（engine 写点用，保持两处一致）。 */
export function executionRowIdentity(skill: string): { course: string; node: string; qid: string } {
  return { course: '*', node: skill, qid: 'exec' }
}

/** journal XP 行 detail（无绑定行；出处足以事后归账）。 */
export function executionXpDetail(input: {
  skill: string; source: ExecutionSource; kind: ExecutionEventKind; rating: number; minutes: number
}): string {
  return `执行事件 ${input.skill}（${input.source} ${input.rating}·${input.kind}·${input.minutes} 分钟）`
}

/** 快照束类型再导出（facade 签名引用，免 engine 侧多一条 import 链）。 */
export type { AdvanceLog }
