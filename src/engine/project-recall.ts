/**
 * 里程碑检索点会话（P-3 / #93）：过点处从关联节点题池抽题 + 学习者自述关键决策。
 *
 * 证据口径（需求池 P-3）：课堂 quizzing g=0.499（Yang 2021，222 研究）为二阶证据，
 * 项目内 RCT 仍缺——预期管理措辞。检索点只服务知识底座，不是项目验收标准
 * （深潜 §1.3.4 分化结论）；门槛 = 里程碑产物已生成（交付物在），零 XP、零 FSRS、
 * 零 journal 写入——抽题与自述落 projects/<id>/recall.jsonl（项目域自有流水，
 * journal 是学习行为账，项目域写它会涨 streak，ADR-0015 裁决 7）。
 *
 * 抽题只读课程题库：不出新题、不改题、不推进任何调度（与 learnhub_question_answer
 * 通道彻底分流——检索点的作答证据只留学习者与 agent 的会话里）。
 */
import type { VaultFs } from './io.ts'
import type { BankQuestion } from './question-bank.ts'
import type { Paths } from './paths.ts'
import { shuffledWith as shuffled } from './shuffle.ts'

/** 检索点抽中的题（跨课程汇集；答案不落档——流水留「抽了什么」，判对错是会话内口头事）。 */
export interface RecallQuestion {
  course: string
  node: string
  qid: string
  kind: string
  q: string
}

/** 抽题池输入形状（一个关联节点 = 一池）。 */
export interface RecallPool {
  course: string
  node: string
  questions: BankQuestion[]
}

/** 抽题（纯函数）：跨池轮转（多节点项目不被单一大库淹没）；池内排序 = 从未作答优先
 * → FSRS due 最早优先（该复习的先回到眼前）。归档题不进池；同序级内洗牌避免每次
 * 抽到同一批（不追求均匀——检索点不是测验）。rng 必填（#175 阶段①：引擎内零
 * Math.random 直读——调用方传 rng 端口，测试播种定长流）。 */
export function drawRecallQuestions(pools: RecallPool[], limit: number, rng: () => number): RecallQuestion[] {
  const want = Math.max(1, Math.round(limit))
  const queues = pools.map(p => {
    const active = p.questions.filter(q => !q.archived)
    const never = shuffled(active.filter(q => !q.stats?.attempts), rng)
    const rest = shuffled(active.filter(q => q.stats?.attempts), rng)
      .sort((a, b) => (a.fsrs?.due ?? '9999').localeCompare(b.fsrs?.due ?? '9999'))
    return { pool: p, queue: [...never, ...rest] }
  }).filter(x => x.queue.length)
  const out: RecallQuestion[] = []
  let advanced = true
  while (out.length < want && advanced) {
    advanced = false
    for (const { pool, queue } of queues) {
      const q = queue.shift()
      if (!q) continue
      advanced = true
      out.push({ course: pool.course, node: pool.node, qid: q.id, kind: q.kind, q: q.q })
      if (out.length >= want) break
    }
  }
  return out
}

/** 检索点流水条目（recall.jsonl 逐行 JSON）。kind=draw 抽题落档 / reflect 自述落档。 */
export type RecallRec =
  | { ts: string; kind: 'draw'; milestone: string; file: string; nodes: string[]; questions: RecallQuestion[] }
  | { ts: string; kind: 'reflect'; milestone: string; narration: string }

/** 追加一条检索点流水（JSONL 一次整行追加，与 journal 同惯例）。 */
export async function appendRecallRec(paths: Paths, projectId: string, rec: RecallRec, fs: VaultFs): Promise<void> {
  await fs.mkdir(paths.projectDir(projectId))
  await fs.appendFile(paths.projectRecallPath(projectId), JSON.stringify(rec) + '\n')
}

/** 全部检索点流水（文件缺失 = 合法空态；消费方 = 复盘与视图）。 */
export async function recallRecsAll(paths: Paths, projectId: string, fs: VaultFs): Promise<RecallRec[]> {
  const p = paths.projectRecallPath(projectId)
  if (!fs.exists(p)) return []
  const out: RecallRec[] = []
  for (const line of (await fs.readFile(p)).split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as RecallRec)
    } catch {
      // 跳过半行损坏（进程中断尾行），与 journal 同惯例
    }
  }
  return out
}
