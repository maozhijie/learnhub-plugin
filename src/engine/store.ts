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
import type { JournalRec, PracticeRec, ProposalRec, ReviewRec, EArchiveRec, ErratumRec } from './types.ts'
import type { ReceiptLogRec } from './receipts.ts'
import type { HabitRepeatRec } from './habits.ts'
import type { PinRec } from './goals.ts'
import type { BandRec } from './coach.ts'
import type { ExperimentDef } from './types.ts'
import type { Paths } from './paths.ts'

// netPracticeRecs 住 grading.ts（#152 刀 6 归位：题库域经 grading 取用；store 被低层
// 模块反向 type-import，值依赖留原地会把存储层拖进下游成环）。
export { netPracticeRecs } from './grading.ts'

/** 提案逐条最小形状契约（ADR-0053；store 与 data-check 同一出处，防双纪律漂移）：
 * id 正整数、status 三值、artifact 非空字符串（apply 的回读键）、pair 若在必须是正整数。
 * pair 的**存在性**是清单级（指向列表中存在的 id），由 loadProposals 统一核。
 * 返回错误列表（空 = 合格）。 */
export function proposalShapeErrors(e: unknown): string[] {
  const p = (e ?? {}) as Partial<ProposalRec>
  const errs: string[] = []
  if (!Number.isInteger(p.id) || (p.id as number) <= 0) errs.push('id 必须是正整数')
  if (p.status !== 'pending' && p.status !== 'applied' && p.status !== 'rejected') {
    errs.push(`status 必须是 pending/applied/rejected（收到 ${JSON.stringify(p.status ?? null)}）`)
  }
  if (typeof p.artifact !== 'string' || !p.artifact.trim()) errs.push('artifact 必须是非空字符串（apply 的回读键）')
  if (p.pair !== undefined && (!Number.isInteger(p.pair) || (p.pair as number) <= 0)) {
    errs.push('pair 必须是正整数（同源另一半提案 id）')
  }
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
    const [journal, practice] = await Promise.all([
      this.readJsonl<JournalRec>(this.paths.journalPath, 'journal'),
      this.readJsonl<PracticeRec>(this.paths.practicePath, 'practice'),
    ])
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

  /** 全部作答记录（节点/课程过滤由调用方做；量级小，全读可接受）。 */
  async practiceAll(): Promise<PracticeRec[]> {
    return this.readJsonl<PracticeRec>(this.paths.practicePath, 'practice')
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
   * JSON 损坏 / 非数组 / 逐条形状违约 / pair 悬空 = Broken 报出（文案带路径与条目位置）
   * ——pairApplyBlock 联动守卫与复诊对账吃这些字段的合法性，形状坏会把对账不一致
   * 静默误判成正常单边。 */
  async loadProposals(): Promise<ProposalRec[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.proposalsPath)
    } catch {
      return []
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
    const ids = new Set(doc.map(p => (p as ProposalRec).id))
    for (const [i, e] of doc.entries()) {
      const pair = (e as ProposalRec).pair
      if (pair !== undefined && !ids.has(pair)) {
        throw new Error(`[proposals] ${this.paths.proposalsPath} 第 ${i} 条 pair 悬空（Broken：声明的联动提案 #${pair} 不在清单中）：修复或删除该条目后再试。`)
      }
    }
    return doc as ProposalRec[]
  }

  async saveProposals(list: ProposalRec[]): Promise<void> {
    await atomicWrite(this.paths.proposalsPath, JSON.stringify(list, null, 1) + '\n', this.fs)
  }

  /** 新建提案 → id（自增）。artifact 支持路径构造器形态（产物路径含自增 id）——注册表
   * 条目出生即完整，没有「先落空 artifact 再回填」的两段窗口（ADR-0053 契约下空
   * artifact 是违约形态，注册表任何时刻落盘都必须可通过本类 loadProposals 读回）。
   * opts.pair = 联动提案 id 出生即写（#149 反编译对：计划半区落盘那一刻就带联动，
   * 任一时刻崩溃都不会留下可单边 apply 的无守卫半区）。 */
  async createProposal(
    kind: ProposalRec['kind'], course: string, summary: string,
    artifact: string | ((id: number) => string),
    opts: { pair?: number } = {},
  ): Promise<number> {
    const list = await this.loadProposals()
    const id = list.reduce((m, p) => Math.max(m, p.id), 0) + 1
    list.push({
      id, kind, course, status: 'pending', summary,
      artifact: typeof artifact === 'function' ? artifact(id) : artifact,
      ...(opts.pair !== undefined ? { pair: opts.pair } : {}),
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

  /** 同源双提案单边 apply 守卫（#149 反编译 v8 pair 联动；返回拒收文案，null = 放行）。
   * 另一半 pending = apply 时序缺口（计划先落盘会让 plan.nodes 引用悬空节点炸消费面）
   * ——拒收并指向联合入口；applied = 联合 apply 的崩溃恢复续段——放行；rejected =
   * 双提案应同退，单边生效会让同源产物半挂——拒收（重新反编译产生新对）。
   * opts.pairApply = 联合入口在两半区之间调用时的豁免旗标。 */
  static pairApplyBlock(
    prop: ProposalRec, proposals: ProposalRec[], opts: { pairApply?: boolean } = {},
  ): string | null {
    if (!prop.pair || opts.pairApply) return null
    const sibling = proposals.find(p => p.id === prop.pair)
    if (!sibling) return `提案 #${prop.id} 声明的联动提案 #${prop.pair} 不存在（同源对账数据不一致，fail loud）——先修复提案记录。`
    if (sibling.status === 'pending') {
      return `反编译双提案同进同退：另一半 #${sibling.id}（${sibling.kind}）仍 pending——`
        + '计划与种子簇必须同时生效（计划引用先有图可解析），用 learnhub_project_decompile_apply 联合 apply；要放弃就两半一起 reject。'
    }
    if (sibling.status === 'rejected') {
      return `反编译双提案同进同退：另一半 #${sibling.id}（${sibling.kind}）已拒——本提案应同退，不单边生效；重新反编译产生新对。`
    }
    return null // applied：联合 apply 中途失败后的恢复续段，放行
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
    } catch {
      return []
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
  async loadAdviceDismissals(): Promise<import('./bank-advice.ts').AdviceDismissRec[]> {
    let raw: string
    try {
      raw = await this.fs.readFile(this.paths.adviceDismissPath)
    } catch {
      return []
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
    return doc as import('./bank-advice.ts').AdviceDismissRec[]
  }

  /** 全量替换忽略清单（原子写）。 */
  async saveAdviceDismissals(list: import('./bank-advice.ts').AdviceDismissRec[]): Promise<void> {
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
    } catch {
      return []
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
