/**
 * 明文运行态存储（替代 Python db.py 的 SQLite 权威层）。
 *
 * - journal/practice/review-log：JSONL 逐行追加（与旧 复习日志.jsonl 惯例一致）
 * - proposals：state/proposals.json 单文件（pending/applied/rejected 全留痕）
 * - snapshots：state/snapshots/<课程>-v<N>.json 整图 YAML 文档序列
 * 全部写入走临时文件 + rename 原子替换（追加除外——追加用 open 'a' 一次写整行）。
 * 通用 IO 原语（atomicWrite / learnhub.json 读写 / JSONL 只读）住 ./io.ts——零领域
 * 依赖叶子，供 graph 等低层模块回引，不构成对存储层的反向依赖（#152 刀 1 / ADR-0042）。
 */
import { atomicWrite, readJsonlLines } from './io.ts'
import type { VaultFs } from './io.ts'
import { netPracticeRecs } from './grading.ts'
import { nowIsoOf, dayOfTs } from './dates.ts'
import type { Clock } from './clock.ts'
import type { JournalRec, PracticeRec, PracticeStreamRow, ProposalRec, ReviewRec, EArchiveRec, ErratumRec, StuckConsumptionRec, StuckReportRec } from './types.ts'
import type { ReceiptLogRec } from './receipts.ts'
import type { HabitRepeatRec } from './habits.ts'
import type { PinRec } from './goals.ts'
import type { BandRec } from './coach.ts'
import type { ExperimentDef } from './types.ts'
import type { Paths } from './paths.ts'

// netPracticeRecs 住 grading.ts（#152 刀 6 归位：题库域经 grading 取用；store 被低层
// 模块反向 type-import，值依赖留原地会把存储层拖进下游成环）。
export { netPracticeRecs } from './grading.ts'

// 卡点自报 id 分配的串行链（#248）：「读 taken → 定 id → append」必须互斥，否则并发
// 请求读到同一 taken 集会产出重复 id、击穿按 id 抵消语义。失败不链式传染（链只记完成）。
let stuckAppendChain: Promise<void> = Promise.resolve()

/** 提案逐条最小形状契约（ADR-0053；store 与 data-check 同一出处，防双纪律漂移）：
 * id 正整数、status 三值、artifact 非空字符串（apply 的回读键）。
 * 返回错误列表（空 = 合格）。 */
export function proposalShapeErrors(e: unknown): string[] {
  const p = (e ?? {}) as Partial<ProposalRec>
  const errs: string[] = []
  if (!Number.isInteger(p.id) || (p.id as number) <= 0) errs.push('id 必须是正整数')
  if (p.status !== 'pending' && p.status !== 'applied' && p.status !== 'rejected') {
    errs.push(`status 必须是 pending/applied/rejected（收到 ${JSON.stringify(p.status ?? null)}）`)
  }
  if (typeof p.artifact !== 'string' || !p.artifact.trim()) errs.push('artifact 必须是非空字符串（apply 的回读键）')
  return errs
}

export class Store {
  constructor(private paths: Paths, private clock: Clock, private fs: VaultFs) {}

  // ---- journal ----

  /** 写一条 journal（JSONL 追加）→ 条目。 */
  async appendJournal(rec: Omit<JournalRec, 'ts'> & { ts?: string }): Promise<JournalRec> {
    const full: JournalRec = {
      ts: rec.ts ?? nowIsoOf(this.clock.nowMs()),
      course: rec.course, node: rec.node, rating: rec.rating ?? null,
      kind: rec.kind, elapsed_days: Math.round(rec.elapsed_days ?? 0),
      session: rec.session ?? null, duration_s: rec.duration_s ?? null,
      ...(rec.xp !== undefined ? { xp: rec.xp } : {}),
      ...(rec.detail ? { detail: rec.detail } : {}),
    }
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.journalPath, JSON.stringify(full) + '\n')
    return full
  }

  /** 最近 N 条 journal（course 过滤可选）。 */
  async journalTail(course: string | null = null, limit = 50): Promise<JournalRec[]> {
    const lines = await this.readJsonl<JournalRec>(this.paths.journalPath, 'journal')
    const hit = course ? lines.filter(r => r.course === course) : lines
    return hit.slice(-limit).reverse()
  }

  async journalCount(course?: string): Promise<number> {
    const lines = await this.readJsonl<JournalRec>(this.paths.journalPath, 'journal')
    return course ? lines.filter(r => r.course === course).length : lines.length
  }

  /** 学习行为按日聚合（journal + practice；ts 为本地时间 ISO，过日界推学习日，ADR-0020）。
   * 打卡/日历热力图与 streak 的数据源——行为流水即事实，零新增文件。 */
  async activityCounts(cutoffMin = 0): Promise<Record<string, { journal: number; practice: number; total: number }>> {
    const [journal, rows] = await Promise.all([
      this.readJsonl<JournalRec>(this.paths.journalPath, 'journal'),
      this.readJsonl<PracticeStreamRow>(this.paths.practicePath, 'practice'),
    ])
    // 只聚合作答行（practiceAll 同款收窄）：卡点自报/消费标记是同流水的独立 kind，
    // 不进打卡/streak/热力图（零激励的落地面——自报不应点亮任何激励读数）
    const practice = rows.filter((r): r is PracticeRec => r.kind === undefined)
    const byDay: Record<string, { journal: number; practice: number; total: number }> = {}
    const bump = (ts: string | undefined, key: 'journal' | 'practice') => {
      if (!ts) return
      const day = dayOfTs(ts, cutoffMin)
      const slot = byDay[day] ?? (byDay[day] = { journal: 0, practice: 0, total: 0 })
      slot[key] += 1
      slot.total += 1
    }
    for (const r of journal) bump(r.ts, 'journal')
    for (const r of practice) bump(r.ts, 'practice')
    return byDay
  }

  // ---- practice ----

  /** 追加一条作答记录。 */
  async appendPractice(rec: Omit<PracticeRec, 'ts'> & { ts?: string }): Promise<PracticeRec> {
    const full: PracticeRec = {
      ts: rec.ts ?? nowIsoOf(this.clock.nowMs()),
      course: rec.course, node: rec.node, ex: rec.ex, answer: rec.answer,
      correct: rec.correct === undefined ? null : rec.correct,
      judge: rec.judge,
      ...(rec.qid ? { qid: rec.qid } : {}),
      ...(rec.feedback ? { feedback: rec.feedback } : {}),
      ...(rec.elapsed_s !== undefined ? { elapsed_s: Math.round(rec.elapsed_s * 10) / 10 } : {}),
      ...(rec.xp !== undefined ? { xp: rec.xp } : {}),
      ...(rec.predicted ? { predicted: rec.predicted } : {}),
    }
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.practicePath, JSON.stringify(full) + '\n')
    return full
  }

  /** 全部作答记录（节点/课程过滤由调用方做；量级小，全读可接受）。卡点自报行是
   * 同一 practice 流水里的独立 kind（ADR-0077 #248）：两个读侧投影互不可见——作答
   * 统计/激励/聚合零感知（零 XP 零激励的落地面），卡点行由 stuckStreamAll 消费。 */
  async practiceAll(): Promise<PracticeRec[]> {
    const rows = await this.readJsonl<PracticeStreamRow>(this.paths.practicePath, 'practice')
    return rows.filter((r): r is PracticeRec => r.kind === undefined)
  }

  // ---- 卡点自报（ADR-0077 #248；与 practice 同文件分条的独立 kind）----

  /** 追加一条卡点自报（原话逐字；频控在引擎写点 stuckReportAppend，不在本层）。
   * id 由本层拼装（消费标记的匹配 key）：`ts|node` + 碰撞后缀——ts 是流水约定的
   * 秒精度，同秒多报时不足以定位到条，行内唯一标识由这里保证。「读 taken → 定 id
   * → append」经模块级 promise 链串行化（并发请求读到同一 taken 集会产出重复 id，
   * 击穿按 id 抵消语义）；与 appendPractice/消费标记行不互锁（单行 appendFile 互不
   * 撕裂，它们也不参与 id 分配）。 */
  appendStuckReport(rec: Omit<StuckReportRec, 'kind' | 'ts' | 'id'> & { ts?: string }): Promise<StuckReportRec> {
    const run = (): Promise<StuckReportRec> => this.appendStuckReportInner(rec)
    const done = stuckAppendChain.then(run, run)
    stuckAppendChain = done.then(() => undefined, () => undefined)
    return done
  }

  private async appendStuckReportInner(rec: Omit<StuckReportRec, 'kind' | 'ts' | 'id'> & { ts?: string }): Promise<StuckReportRec> {
    const full: StuckReportRec = {
      kind: 'stuck_report',
      ts: rec.ts ?? nowIsoOf(this.clock.nowMs()),
      course: rec.course, node: rec.node, text: rec.text,
      id: '',
    }
    const taken = new Set((await this.stuckStreamAll()).map(r => r.kind === 'stuck_report' ? r.id : ''))
    let id = `${full.ts}|${full.node}`
    for (let n = 2; taken.has(id); n++) id = `${full.ts}|${full.node}#${n}`
    full.id = id
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.practicePath, JSON.stringify(full) + '\n')
    return full
  }

  /** 追加一条卡点自报消费标记（冲正式记录；原记录永不改写，读侧折叠）。 */
  async appendStuckConsumption(rec: { course: string; targets: string[] }): Promise<StuckConsumptionRec> {
    const full: StuckConsumptionRec = {
      kind: 'stuck_report_consumed',
      ts: nowIsoOf(this.clock.nowMs()),
      course: rec.course, targets: [...rec.targets],
    }
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.practicePath, JSON.stringify(full) + '\n')
    return full
  }

  /** 全部卡点自报与消费标记行（折叠前的原始两 kind；折叠归 stuck-report.ts）。 */
  async stuckStreamAll(): Promise<Array<StuckReportRec | StuckConsumptionRec>> {
    const rows = await this.readJsonl<PracticeStreamRow>(this.paths.practicePath, 'practice')
    return rows.filter((r): r is StuckReportRec | StuckConsumptionRec =>
      r.kind === 'stuck_report' || r.kind === 'stuck_report_consumed')
  }

  // ---- review-log（ADR-0012 逐次复习日志）----

  /** 追加一条复习日志（只在真实推进 FSRS 卡的落点调用，见 engine 各写点）。
   * event_kind/exec_source 仅执行事件行携带（rating_source='execution'，ADR-0018）。 */
  async appendReview(rec: Omit<ReviewRec, 'ts'> & { ts?: string }): Promise<ReviewRec> {
    const full: ReviewRec = {
      ts: rec.ts ?? nowIsoOf(this.clock.nowMs()),
      course: rec.course, node: rec.node, qid: rec.qid,
      rating: rec.rating, rating_source: rec.rating_source,
      elapsed_days: Math.round(rec.elapsed_days ?? 0),
      stability_before: rec.stability_before ?? null,
      difficulty_before: rec.difficulty_before ?? null,
      r_pred: rec.r_pred === null || rec.r_pred === undefined ? null : Math.round(rec.r_pred * 1000) / 1000,
      ...(rec.exp ? { exp: rec.exp } : {}),
      ...(rec.event_kind ? { event_kind: rec.event_kind } : {}),
      ...(rec.exec_source ? { exec_source: rec.exec_source } : {}),
    }
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.reviewLogPath, JSON.stringify(full) + '\n')
    return full
  }

  /** 全部复习日志（读侧契约归 readJsonlLines 原语，ADR-0053：缺失 = Missing 合法空态、
   * 中段坏行 = Broken 报出——仪表盘/优化器的统计口径不能带病数据、撕裂尾行豁免）。 */
  async reviewLogAll(): Promise<ReviewRec[]> {
    return readJsonlLines<ReviewRec>(this.paths.reviewLogPath, this.fs, 'review-log')
  }

  /** 节点作答统计（attempts/judged/correct/accuracy + 正确率）。勘误冲正按净值计
   * （ADR-0031）：被作废的作答剔除，改判对的对错以勘误记录为准。 */
  async attemptStats(course: string, node: string): Promise<{
    attempts: number; judged: number; correct: number; accuracy: number | null
  }> {
    const [all, errata] = await Promise.all([this.practiceAll(), this.erratumAll()])
    const hit = netPracticeRecs(all, errata).filter(r => r.course === course && r.node === node)
    const judged = hit.filter(r => r.correct !== null)
    const right = judged.filter(r => r.correct === true).length
    return {
      attempts: hit.length, judged: judged.length, correct: right,
      accuracy: judged.length ? Math.round((right / judged.length) * 1000) / 1000 : null,
    }
  }

  // ---- proposals ----

  /** 全部提案（ADR-0053 逐条最小形状契约）：文件缺失 = Missing 合法空态（[]）；存在但
   * JSON 损坏 / 非数组 / 逐条形状违约 = Broken 报出（文案带路径与条目位置）——形状坏会
   * 把对账不一致静默误判成正常单条。 */
  async loadProposals(): Promise<ProposalRec[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.proposalsPath)
    } catch (err) {
      // 只认 ENOENT 为 Missing 合法空态（#295，比照 gen-jobs #194）：权限/锁类 IO 错
      // 静默回空表会让下一次全量替换写静默销毁原档，Broken 同口径上抛。
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      throw new Error(`[proposals] ${this.paths.proposalsPath} 不可读（Broken）：${err instanceof Error ? err.message : String(err)}`)
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      throw new Error(`[proposals] ${this.paths.proposalsPath} 不是合法 JSON（Broken）：修复或删除该文件后再试。${err instanceof Error ? ` ${err.message}` : ''}`)
    }
    if (!Array.isArray(doc)) {
      throw new Error(`[proposals] ${this.paths.proposalsPath} 不是清单数组（Broken）：修复或删除该文件后再试。`)
    }
    for (const [i, e] of doc.entries()) {
      const errs = proposalShapeErrors(e)
      if (errs.length) {
        throw new Error(`[proposals] ${this.paths.proposalsPath} 第 ${i} 条不满足提案契约（Broken：${errs.join('；')}）：修复或删除该条目后再试。`)
      }
    }
    return doc as ProposalRec[]
  }

  async saveProposals(list: ProposalRec[]): Promise<void> {
    await atomicWrite(this.paths.proposalsPath, JSON.stringify(list, null, 1) + '\n', this.fs)
  }

  /** 新建提案 → id（自增）。artifact 支持路径构造器形态（产物路径含自增 id）——注册表
   * 条目出生即完整，没有「先落空 artifact 再回填」的两段窗口（ADR-0053 契约下空
   * artifact 是违约形态，注册表任何时刻落盘都必须可通过本类 loadProposals 读回）。 */
  async createProposal(
    kind: ProposalRec['kind'], course: string, summary: string,
    artifact: string | ((id: number) => string),
  ): Promise<number> {
    const list = await this.loadProposals()
    const id = list.reduce((m, p) => Math.max(m, p.id), 0) + 1
    list.push({
      id, kind, course, status: 'pending', summary,
      artifact: typeof artifact === 'function' ? artifact(id) : artifact,
      created: nowIsoOf(this.clock.nowMs()), decided: null, decision_note: '',
    })
    await this.saveProposals(list)
    return id
  }

  async updateProposal(id: number, patch: Partial<ProposalRec>): Promise<ProposalRec | null> {
    const list = await this.loadProposals()
    const hit = list.find(p => p.id === id)
    if (!hit) return null
    Object.assign(hit, patch)
    await this.saveProposals(list)
    return hit
  }

  /** 取 pending 提案（缺省 = 该 kind 最新一条）。 */
  async takePending(kind: ProposalRec['kind'], pid?: number): Promise<ProposalRec> {
    if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
      throw new Error(`[apply] 提案 id 必须是正整数（收到 ${String(pid)}）；省略 id 才表示该 kind 最新 pending。`)
    }
    const list = await this.loadProposals()
    let prop: ProposalRec | undefined
    if (pid) {
      prop = list.find(p => p.id === pid)
      if (!prop) throw new Error(`[apply] 提案 #${pid} 不存在。`)
    } else {
      prop = [...list].reverse().find(p => p.status === 'pending' && p.kind === kind)
      if (!prop) throw new Error(`[apply] 没有 pending 的 ${kind} 提案（先 propose）。`)
    }
    if (prop.status !== 'pending') throw new Error(`[apply] 提案 #${prop.id} 已 ${prop.status}。`)
    return prop
  }

  // ---- snapshots ----

  async latestSnapshotVersion(course: string): Promise<number> {
    const dir = this.paths.snapshotDir
    if (!this.fs.exists(dir)) return 0
    let max = 0
    for (const f of await this.fs.readdir(dir)) {
      const m = f.match(new RegExp(`^${course}-v(\\d+)\\.json$`))
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max
  }

  async saveSnapshot(course: string, version: number, doc: unknown): Promise<void> {
    await atomicWrite(this.paths.snapshotPath(course, version), JSON.stringify(doc, null, 1) + '\n', this.fs)
  }

  // ---- 今日 pin（E3 #67）----

  /** pin 清单；文件缺失 = Missing 合法空态（[]）；文件存在但损坏 = Broken 报出
   * （不静默吞——静默回空会被下一次 pin 写入覆盖，学习者数据不得无声降级）。 */
  async loadPins(): Promise<PinRec[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.pinPath)
    } catch (err) {
      // 只认 ENOENT 为 Missing 合法空态（#295）；其余 IO 错静默回空会被 pin 写入覆盖原档
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      throw new Error(`[pin] ${this.paths.pinPath} 不可读（Broken）：${err instanceof Error ? err.message : String(err)}`)
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      throw new Error(`[pin] ${this.paths.pinPath} 不是合法 JSON（Broken）：修复或删除该文件后再试。${err instanceof Error ? ` ${err.message}` : ''}`)
    }
    if (!Array.isArray(doc)) {
      throw new Error(`[pin] ${this.paths.pinPath} 不是清单数组（Broken）：修复或删除该文件后再试。`)
    }
    return doc as PinRec[]
  }

  /** 全量替换 pin 清单（原子写；调用方负责只保留当日有效条目）。 */
  async savePins(list: PinRec[]): Promise<void> {
    await atomicWrite(this.paths.pinPath, JSON.stringify(list, null, 1) + '\n', this.fs)
  }

  // ---- 「过于简单」建议忽略清单（B2；bank-advice.AdviceDismissRec）----

  /** 忽略清单；文件缺失 = Missing 合法空态（[]），坏档 = Broken 报出（与 pin 同纪律）。 */
  async loadAdviceDismissals(): Promise<import('./content/bank-advice.ts').AdviceDismissRec[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.adviceDismissPath)
    } catch (err) {
      // 只认 ENOENT 为 Missing 合法空态（#295，与 pin 同纪律）
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      throw new Error(`[advice-dismiss] ${this.paths.adviceDismissPath} 不可读（Broken）：${err instanceof Error ? err.message : String(err)}`)
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      throw new Error(`[advice-dismiss] ${this.paths.adviceDismissPath} 不是合法 JSON（Broken）：修复或删除该文件后再试。${err instanceof Error ? ` ${err.message}` : ''}`)
    }
    if (!Array.isArray(doc)) {
      throw new Error(`[advice-dismiss] ${this.paths.adviceDismissPath} 不是清单数组（Broken）：修复或删除该文件后再试。`)
    }
    return doc as import('./content/bank-advice.ts').AdviceDismissRec[]
  }

  /** 全量替换忽略清单（原子写）。 */
  async saveAdviceDismissals(list: import('./content/bank-advice.ts').AdviceDismissRec[]): Promise<void> {
    await atomicWrite(this.paths.adviceDismissPath, JSON.stringify(list, null, 1) + '\n', this.fs)
  }

  // ---- 难度带会话日志（E5 #65）----

  /** 追加一条难度带会话记录（JSONL；会话结束反馈点调用）。 */
  async appendBandRec(rec: BandRec): Promise<BandRec> {
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.bandLogPath, JSON.stringify(rec) + '\n')
    return rec
  }

  /** 全部难度带会话记录（文件缺失 = Missing 合法空态）。 */
  async bandRecsAll(): Promise<BandRec[]> {
    return this.readJsonl<BandRec>(this.paths.bandLogPath, 'band-log')
  }

  // ---- E 档案（ADR-0009 Learner Output 判词存档；#68 E2）----

  /** 追加一条 E 判词档案（JSONL）。判词只入档案：调用方不产生 XP、不写 canonical。 */
  async appendEArchive(rec: Omit<EArchiveRec, 'ts'> & { ts?: string }): Promise<EArchiveRec> {
    const full: EArchiveRec = {
      ts: rec.ts ?? nowIsoOf(this.clock.nowMs()),
      course: rec.course, node: rec.node, kind: rec.kind,
      verdict: rec.verdict, tags: [...(rec.tags ?? [])],
      ...(rec.advice ? { advice: rec.advice } : {}),
      ...(rec.excerpt ? { excerpt: rec.excerpt } : {}),
    }
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.eArchivePath, JSON.stringify(full) + '\n')
    return full
  }

  /** 全部 E 判词档案（读侧契约归 readJsonlLines 原语，ADR-0053：缺失 = Missing 合法
   * 空态、中段坏行 = Broken 报出——学习者数据不得无声降级）。 */
  async eArchiveAll(): Promise<EArchiveRec[]> {
    return readJsonlLines<EArchiveRec>(this.paths.eArchivePath, this.fs, 'e-archive')
  }

  // ---- N-of-1 实验定义（D-1 #110 / ADR-0023；whole-file 原子写）----

  /** 全部实验定义；文件缺失 = Missing 合法空态（[]）；损坏 = Broken 报出
   * （分臂与结局登记是预注册事实，静默回空会被新实验覆盖）。 */
  async loadExperiments(): Promise<ExperimentDef[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.experimentsPath)
    } catch (err) {
      // 只认 ENOENT 为 Missing 合法空态（#295）：分臂与结局登记是预注册事实，
      // 非 ENOENT 错静默回空会被新实验定义覆盖。
      if ((err as { code?: unknown }).code === 'ENOENT') return []
      throw new Error(`[nof1] ${this.paths.experimentsPath} 不可读（Broken）：${err instanceof Error ? err.message : String(err)}`)
    }
    let doc: unknown
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      throw new Error(`[nof1] ${this.paths.experimentsPath} 不是合法 JSON（Broken）：修复或删除该文件后再试。${err instanceof Error ? ` ${err.message}` : ''}`)
    }
    if (!Array.isArray(doc)) {
      throw new Error(`[nof1] ${this.paths.experimentsPath} 不是清单数组（Broken）：修复或删除该文件后再试。`)
    }
    // 最小形状契约（Broken 判据：未通过数据契约，不静默降级——分臂与结局登记是预注册事实）
    for (const [i, e] of doc.entries()) {
      const rec = e as Partial<ExperimentDef>
      if (typeof rec?.id !== 'number' || (rec.status !== 'running' && rec.status !== 'stopped')
        || !Array.isArray(rec.arms) || !rec.assignment) {
        throw new Error(`[nof1] ${this.paths.experimentsPath} 第 ${i} 条不满足实验定义契约（Broken）：修复或删除该条目后再试。`)
      }
    }
    return doc as ExperimentDef[]
  }

  /** 全量替换实验清单（原子写；调用方负责状态机合法）。 */
  async saveExperiments(list: ExperimentDef[]): Promise<void> {
    await atomicWrite(this.paths.experimentsPath, JSON.stringify(list, null, 1) + '\n', this.fs)
  }

  // ---- 回执流水（U-1 #88 / ADR-0016）与习惯重复流（U-3 #90 / ADR-0017）----

  /** 追加一条回执（含评审结果）。账本只增：已入 EMA 的历史分值永不回滚（ADR-0016）。 */
  async appendReceipt(rec: ReceiptLogRec): Promise<ReceiptLogRec> {
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.receiptLogPath, JSON.stringify(rec) + '\n')
    return rec
  }

  /** 全部回执（调用方按主体过滤；读侧契约归 readJsonlLines 原语，ADR-0053：中段坏行
   * = Broken 报出——证据流水不能带病读，静默吞行会让「渐退曲线数错了第几份」）。 */
  async receiptsAll(): Promise<ReceiptLogRec[]> {
    return readJsonlLines<ReceiptLogRec>(this.paths.receiptLogPath, this.fs, 'receipts')
  }

  /** 追加一条习惯重复（自报即事实，无门禁；引擎侧零派生写入）。 */
  async appendHabitRepeat(rec: HabitRepeatRec): Promise<HabitRepeatRec> {
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.habitRepeatLogPath, JSON.stringify(rec) + '\n')
    return rec
  }

  /** 全部习惯重复（读侧契约归 readJsonlLines 原语，ADR-0053 一刀切无展示原料例外：
   * 撕裂尾行豁免已精确覆盖中断场景，中段损坏没有任何无责解释）。 */
  async habitRepeatsAll(): Promise<HabitRepeatRec[]> {
    return this.readJsonl<HabitRepeatRec>(this.paths.habitRepeatLogPath, 'habit-repeats')
  }

  // ---- 勘误冲正流水（ADR-0031）----

  /** 追加一条勘误冲正记录（JSONL 追加，只增）。原始 practice 流水永不改写：
   * 冲正是显式的抵消凭证，聚合账读侧按净值读。 */
  async appendErratum(rec: Omit<ErratumRec, 'ts'> & { ts?: string }): Promise<ErratumRec> {
    const full: ErratumRec = {
      ts: rec.ts ?? nowIsoOf(this.clock.nowMs()),
      course: rec.course, node: rec.node, qid: rec.qid,
      target_ts: rec.target_ts, verdict: rec.verdict, xp: rec.xp,
      ...(rec.correct !== undefined ? { correct: rec.correct } : {}),
      ...(rec.revision !== undefined ? { revision: rec.revision } : {}),
      ...(rec.reason ? { reason: rec.reason } : {}),
    }
    await this.fs.mkdir(this.paths.centerStateDir)
    await this.fs.appendFile(this.paths.erratumLogPath, JSON.stringify(full) + '\n')
    return full
  }

  /** 全部勘误冲正记录（文件缺失 = Missing 合法空态）。 */
  async erratumAll(): Promise<ErratumRec[]> {
    return this.readJsonl<ErratumRec>(this.paths.erratumLogPath, 'erratum')
  }

  // ---- utils ----

  private async readJsonl<T>(path: string, label: string): Promise<T[]> {
    return readJsonlLines<T>(path, this.fs, label)
  }
}
