/**
 * 卡点自报（#248 / ADR-0077）：t=0 受阻信号的一等传感器——纯规则层。
 *
 * 录入形态唯一 = 自由文本，原话逐字落 practice 流水独立 kind（`stuck_report`）、
 * 零结构化（原话是事实源，任何提前提炼都是损耗）；落账成功后由宿主立即入队一次
 * force 教练回合（ADR-0076「添加终点 → 立即入队」同款先例），回合经既有 inject
 * 通道携带原文（本模块渲染注入块；消费裁决纪律由感知面票统一进提示词，本票不碰
 * 提示词）。与 B1 的 diagnostic（引擎产出的内容诊断建议项）零共享代码路径、零语义
 * 混用——两个主体、两个方向，事件 kind、消费方、展示面互不可见。
 *
 * 频控（params 集中，上限同时是回合触发上限）：同节点每学习日 1 条 + 全课程每日
 * 总量上限。消费标记是冲正式记录（先例 erratum 冲正流水：append-only 凭证，读侧
 * 折叠出消费态）——原记录永不改写，回合异常时自报自然留账不丢。
 */
import type { StuckConsumptionRec, StuckReportFolded, StuckReportRec } from '../types.ts'
import { STUCK_REPORT_PER_NODE_PER_DAY, STUCK_REPORT_DAILY_COURSE_CAP } from '../infra/params.ts'

/** 频控上限（默认取 params 集中表；显式入参供测试与未来调参面）。 */
export interface StuckGateLimits {
  perNodePerDay: number
  courseDailyCap: number
}

/** 频控折叠（纯函数）：按学习日判同节点条数与全课程总量。先到先得——两限同时
 * 触顶时同节点理由优先（更具体）。返回 ok 或带原因的拒绝（原因原样进回执）。 */
export function stuckReportGate(
  prior: Array<{ day: string; node: string }>,
  node: string,
  today: string,
  limits: StuckGateLimits = {
    perNodePerDay: STUCK_REPORT_PER_NODE_PER_DAY,
    courseDailyCap: STUCK_REPORT_DAILY_COURSE_CAP,
  },
): { ok: true } | { ok: false; reason: string } {
  const sameNode = prior.filter(p => p.node === node && p.day === today).length
  if (sameNode >= limits.perNodePerDay) {
    return {
      ok: false,
      reason: `同一节点本学习日已自报过（上限 ${limits.perNodePerDay} 条/学习日·节点）——原话已留账，教练回合会消费；请等下一回合或明日再报。`,
    }
  }
  const total = prior.filter(p => p.day === today).length
  if (total >= limits.courseDailyCap) {
    return {
      ok: false,
      reason: `本课程本学习日自报已达总量上限（${limits.courseDailyCap} 条/日）——教练回合会消费已留账的自报；请明日再报。`,
    }
  }
  return { ok: true }
}

/** 消费态折叠（纯函数）：报告行 + 冲正式消费标记 → 逐条消费态。targets 按报告行 id
 * 精确抵消（ts 是流水约定的秒精度，同秒多报时不足以定位到条）；重复抵消取首个消费时刻。 */
export function foldStuckReports(rows: Array<StuckReportRec | StuckConsumptionRec>): StuckReportFolded[] {
  const consumedTs = new Map<string, string>()
  for (const r of rows) {
    if (r.kind !== 'stuck_report_consumed') continue
    for (const t of r.targets) consumedTs.set(t, consumedTs.get(t) ?? r.ts)
  }
  return rows
    .filter((r): r is StuckReportRec => r.kind === 'stuck_report')
    .map(r => {
      const consumed_ts = consumedTs.get(r.id)
      return {
        id: r.id, ts: r.ts, course: r.course, node: r.node, text: r.text,
        consumed: consumed_ts !== undefined,
        ...(consumed_ts !== undefined ? { consumed_ts } : {}),
      }
    })
}

/** 自报原文的教练回合注入块（既有 inject 通道携带）：待消费清单逐条一行——原文
 * 是逐字保真，仅换行在渲染层转义为可见标记（多行原话的续行不与下一条的边界混淆；
 * 流水与折叠层原封不动）。无待消费自报 = null（整段省略——inject 缺席不改变回合的
 * 停机转译语义）。 */
export function stuckReportInject(pending: StuckReportFolded[]): string | null {
  const live = pending.filter(p => !p.consumed)
  if (!live.length) return null
  return [
    '【卡点自报（学习者原话，逐字未改——归因与响应的事实源）】',
    ...live.map(r => `- ${r.ts} 节点「${r.node}」：${r.text.replace(/\r?\n/g, ' ⏎ ')}`),
  ].join('\n')
}
