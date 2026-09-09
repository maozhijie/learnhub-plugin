/**
 * 明文运行态存储（替代 Python db.py 的 SQLite 权威层）。
 *
 * - journal/practice/review-log：JSONL 逐行追加（与旧 复习日志.jsonl 惯例一致）
 * - proposals：state/proposals.json 单文件（pending/applied/rejected 全留痕）
 * - snapshots：state/snapshots/<课程>-v<N>.json 整图 YAML 文档序列
 * 全部写入走临时文件 + rename 原子替换（追加除外——追加用 open 'a' 一次写整行）。
 */
import { mkdir, readFile, rename, appendFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { nowIso, dayOfTs } from './dates.ts'
import type { JournalRec, PracticeRec, ProposalRec, ReviewRec, EArchiveRec, ErratumRec } from './types.ts'
import type { ReceiptLogRec } from './receipts.ts'
import type { HabitRepeatRec } from './habits.ts'
import type { PinRec } from './goals.ts'
import type { BandRec } from './coach.ts'
import type { ExperimentDef } from './nof1.ts'
import type { Paths } from './paths.ts'

/** 临时文件 + rename 原子写。 */
export async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

/** 勘误冲正的读侧净值（ADR-0031）：key-error 的作答按勘误记录替换 xp/对错；
 * defective/overridden 的作答整体剔除。原始流水不动，聚合账（XP、作答统计）
 * 一律先过本函数再算——「行为流水即事实」包含冲正凭证本身。 */
export function netPracticeRecs<T extends PracticeRec>(recs: readonly T[], errata: readonly ErratumRec[]): T[] {
  const byKey = new Map(errata.map(e => [`${e.target_ts}|${e.qid}`, e]))
  const out: T[] = []
  for (const r of recs) {
    const e = r.ts ? byKey.get(`${r.ts}|${r.qid ?? ''}`) : undefined
    if (!e) {
      out.push(r as T)
    } else if (e.verdict === 'key-error') {
      out.push({ ...(r as T), xp: e.xp, correct: e.correct ?? r.correct })
    }
    // defective/overridden：本次作答作废，不出现在净流里
  }
  return out
}

export class Store {
  constructor(private paths: Paths) {}

  // ---- journal ----

  /** 写一条 journal（JSONL 追加）→ 条目。 */
  async appendJournal(rec: Omit<JournalRec, 'ts'> & { ts?: string }): Promise<JournalRec> {
    const full: JournalRec = {
      ts: rec.ts ?? nowIso(),
      course: rec.course, node: rec.node, rating: rec.rating ?? null,
      kind: rec.kind, elapsed_days: Math.round(rec.elapsed_days ?? 0),
      session: rec.session ?? null, duration_s: rec.duration_s ?? null,
      ...(rec.xp !== undefined ? { xp: rec.xp } : {}),
      ...(rec.detail ? { detail: rec.detail } : {}),
    }
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.journalPath, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  /** 最近 N 条 journal（course 过滤可选）。 */
  async journalTail(course: string | null = null, limit = 50): Promise<JournalRec[]> {
    const lines = await this.readJsonl<JournalRec>(this.paths.journalPath)
    const hit = course ? lines.filter(r => r.course === course) : lines
    return hit.slice(-limit).reverse()
  }

  async journalCount(course?: string): Promise<number> {
    const lines = await this.readJsonl<JournalRec>(this.paths.journalPath)
    return course ? lines.filter(r => r.course === course).length : lines.length
  }

  /** 学习行为按日聚合（journal + practice；ts 为本地时间 ISO，过日界推学习日，ADR-0020）。
   * 打卡/日历热力图与 streak 的数据源——行为流水即事实，零新增文件。 */
  async activityCounts(cutoffMin = 0): Promise<Record<string, { journal: number; practice: number; total: number }>> {
    const [journal, practice] = await Promise.all([
      this.readJsonl<JournalRec>(this.paths.journalPath),
      this.readJsonl<PracticeRec>(this.paths.practicePath),
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
      ts: rec.ts ?? nowIso(),
      course: rec.course, node: rec.node, ex: rec.ex, answer: rec.answer,
      correct: rec.correct === undefined ? null : rec.correct,
      judge: rec.judge,
      ...(rec.qid ? { qid: rec.qid } : {}),
      ...(rec.feedback ? { feedback: rec.feedback } : {}),
      ...(rec.elapsed_s !== undefined ? { elapsed_s: Math.round(rec.elapsed_s * 10) / 10 } : {}),
      ...(rec.xp !== undefined ? { xp: rec.xp } : {}),
      ...(rec.predicted ? { predicted: rec.predicted } : {}),
    }
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.practicePath, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  /** 全部作答记录（节点/课程过滤由调用方做；量级小，全读可接受）。 */
  async practiceAll(): Promise<PracticeRec[]> {
    return this.readJsonl<PracticeRec>(this.paths.practicePath)
  }

  // ---- review-log（ADR-0012 逐次复习日志）----

  /** 追加一条复习日志（只在真实推进 FSRS 卡的落点调用，见 engine 各写点）。
   * event_kind/exec_source 仅执行事件行携带（rating_source='execution'，ADR-0018）。 */
  async appendReview(rec: Omit<ReviewRec, 'ts'> & { ts?: string }): Promise<ReviewRec> {
    const full: ReviewRec = {
      ts: rec.ts ?? nowIso(),
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
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.reviewLogPath, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  /** 全部复习日志。消费契约：文件缺失 = Missing 合法空态（返回 []）；
   * 逐行损坏 = Broken 报出（不静默吞——仪表盘/优化器的统计口径不能带病数据）。 */
  async reviewLogAll(): Promise<ReviewRec[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.reviewLogPath, 'utf8')
    } catch {
      return []
    }
    const out: ReviewRec[] = []
    for (const [i, line] of raw.split('\n').entries()) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as ReviewRec)
      } catch {
        throw new Error(`[review-log] ${this.paths.reviewLogPath} 第 ${i + 1} 行不是合法 JSON（Broken）：修复或删除该行后再试。`)
      }
    }
    return out
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

  async loadProposals(): Promise<ProposalRec[]> {
    try {
      const raw = await readFile(this.paths.proposalsPath, 'utf8')
      const doc = JSON.parse(raw)
      return Array.isArray(doc) ? doc as ProposalRec[] : []
    } catch {
      return []
    }
  }

  async saveProposals(list: ProposalRec[]): Promise<void> {
    await atomicWrite(this.paths.proposalsPath, JSON.stringify(list, null, 1) + '\n')
  }

  /** 新建提案 → id（自增）。 */
  async createProposal(kind: ProposalRec['kind'], course: string, summary: string, artifact: string): Promise<number> {
    const list = await this.loadProposals()
    const id = list.reduce((m, p) => Math.max(m, p.id), 0) + 1
    list.push({
      id, kind, course, status: 'pending', summary, artifact,
      created: nowIso(), decided: null, decision_note: '',
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
    if (!existsSync(dir)) return 0
    const { readdir } = await import('node:fs/promises')
    let max = 0
    for (const f of await readdir(dir)) {
      const m = f.match(new RegExp(`^${course}-v(\\d+)\\.json$`))
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max
  }

  async saveSnapshot(course: string, version: number, doc: unknown): Promise<void> {
    await atomicWrite(this.paths.snapshotPath(course, version), JSON.stringify(doc, null, 1) + '\n')
  }

  // ---- 今日 pin（E3 #67）----

  /** pin 清单；文件缺失 = Missing 合法空态（[]）；文件存在但损坏 = Broken 报出
   * （不静默吞——静默回空会被下一次 pin 写入覆盖，学习者数据不得无声降级）。 */
  async loadPins(): Promise<PinRec[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.pinPath, 'utf8')
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
    await atomicWrite(this.paths.pinPath, JSON.stringify(list, null, 1) + '\n')
  }

  // ---- 难度带会话日志（E5 #65）----

  /** 追加一条难度带会话记录（JSONL；会话结束反馈点调用）。 */
  async appendBandRec(rec: BandRec): Promise<BandRec> {
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.bandLogPath, JSON.stringify(rec) + '\n', 'utf8')
    return rec
  }

  /** 全部难度带会话记录（文件缺失 = Missing 合法空态）。 */
  async bandRecsAll(): Promise<BandRec[]> {
    return this.readJsonl<BandRec>(this.paths.bandLogPath)
  }

  // ---- E 档案（ADR-0009 Learner Output 判词存档；#68 E2）----

  /** 追加一条 E 判词档案（JSONL）。判词只入档案：调用方不产生 XP、不写 canonical。 */
  async appendEArchive(rec: Omit<EArchiveRec, 'ts'> & { ts?: string }): Promise<EArchiveRec> {
    const full: EArchiveRec = {
      ts: rec.ts ?? nowIso(),
      course: rec.course, node: rec.node, kind: rec.kind,
      verdict: rec.verdict, tags: [...(rec.tags ?? [])],
      ...(rec.advice ? { advice: rec.advice } : {}),
      ...(rec.excerpt ? { excerpt: rec.excerpt } : {}),
    }
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.eArchivePath, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  /** 全部 E 判词档案（文件缺失 = Missing 合法空态；损坏行 = Broken 报出，学习者数据不得无声降级）。 */
  async eArchiveAll(): Promise<EArchiveRec[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.eArchivePath, 'utf8')
    } catch {
      return []
    }
    const out: EArchiveRec[] = []
    for (const [i, line] of raw.split('\n').entries()) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as EArchiveRec)
      } catch {
        throw new Error(`[e-archive] ${this.paths.eArchivePath} 第 ${i + 1} 行不是合法 JSON（Broken）：修复或删除该行后再试。`)
      }
    }
    return out
  }

  // ---- N-of-1 实验定义（D-1 #110 / ADR-0023；whole-file 原子写）----

  /** 全部实验定义；文件缺失 = Missing 合法空态（[]）；损坏 = Broken 报出
   * （分臂与结局登记是预注册事实，静默回空会被新实验覆盖）。 */
  async loadExperiments(): Promise<ExperimentDef[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.experimentsPath, 'utf8')
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
    await atomicWrite(this.paths.experimentsPath, JSON.stringify(list, null, 1) + '\n')
  }

  // ---- 回执流水（U-1 #88 / ADR-0016）与习惯重复流（U-3 #90 / ADR-0017）----

  /** 追加一条回执（含评审结果）。账本只增：已入 EMA 的历史分值永不回滚（ADR-0016）。 */
  async appendReceipt(rec: ReceiptLogRec): Promise<ReceiptLogRec> {
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.receiptLogPath, JSON.stringify(rec) + '\n', 'utf8')
    return rec
  }

  /** 全部回执（调用方按主体过滤）。损坏行 = Broken 报出（同 review-log：证据流水
   * 不能带病读——静默吞行会让「渐退曲线数错了第几份」）。 */
  async receiptsAll(): Promise<ReceiptLogRec[]> {
    let raw: string
    try {
      raw = await readFile(this.paths.receiptLogPath, 'utf8')
    } catch {
      return []
    }
    const out: ReceiptLogRec[] = []
    for (const [i, line] of raw.split('\n').entries()) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as ReceiptLogRec)
      } catch {
        throw new Error(`[receipts] ${this.paths.receiptLogPath} 第 ${i + 1} 行不是合法 JSON（Broken）：修复或删除该行后再试。`)
      }
    }
    return out
  }

  /** 追加一条习惯重复（自报即事实，无门禁；引擎侧零派生写入）。 */
  async appendHabitRepeat(rec: HabitRepeatRec): Promise<HabitRepeatRec> {
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.habitRepeatLogPath, JSON.stringify(rec) + '\n', 'utf8')
    return rec
  }

  /** 全部习惯重复（文件缺失 = Missing 合法空态；损坏行跳过同 journal——重复流是
   * 展示原料，坏一行不值得一档Broken 拦住全部曲线）。 */
  async habitRepeatsAll(): Promise<HabitRepeatRec[]> {
    return this.readJsonl<HabitRepeatRec>(this.paths.habitRepeatLogPath)
  }

  // ---- 勘误冲正流水（ADR-0031）----

  /** 追加一条勘误冲正记录（JSONL 追加，只增）。原始 practice 流水永不改写：
   * 冲正是显式的抵消凭证，聚合账读侧按净值读。 */
  async appendErratum(rec: Omit<ErratumRec, 'ts'> & { ts?: string }): Promise<ErratumRec> {
    const full: ErratumRec = {
      ts: rec.ts ?? nowIso(),
      course: rec.course, node: rec.node, qid: rec.qid,
      target_ts: rec.target_ts, verdict: rec.verdict, xp: rec.xp,
      ...(rec.correct !== undefined ? { correct: rec.correct } : {}),
      ...(rec.revision !== undefined ? { revision: rec.revision } : {}),
      ...(rec.reason ? { reason: rec.reason } : {}),
    }
    await mkdir(this.paths.centerStateDir, { recursive: true })
    await appendFile(this.paths.erratumLogPath, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

  /** 全部勘误冲正记录（文件缺失 = Missing 合法空态）。 */
  async erratumAll(): Promise<ErratumRec[]> {
    return this.readJsonl<ErratumRec>(this.paths.erratumLogPath)
  }

  // ---- utils ----

  private async readJsonl<T>(path: string): Promise<T[]> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return []
    }
    const out: T[] = []
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as T)
      } catch {
        // 跳过半行损坏（进程中断可能留下未写完的尾行）
      }
    }
    return out
  }
}
