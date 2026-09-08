/**
 * E3 目标所有权（决议 #48 / 实施工单 #67）：「今天学它」pin 覆盖层 + 推荐榜首
 * rationale。pin 是 Learner Output（ADR-0009）：只改推荐读侧排序，不碰任何
 * canonical 调度、不设门禁；仅作用当日（date 过期自动失效）。未就绪节点照常
 * 可 pin——就绪提示随事件带出，引擎提议非指令。零依赖纯函数（接缝 S29）。
 */

/** 一条 pin 记录（state/今日pin.json；中心级、跨课程/节点皆可）。 */
export interface PinRec { course: string; node: string; date: string }

/** 当日有效的 pin：date 精确匹配当天，过期条目自动失效（不删除、只不生效）。 */
export function todayPins(pins: PinRec[], today: string): PinRec[] {
  return pins.filter(p => p.date === today)
}

/** pin 节点在其课程内的榜首分 = 该课程现有事件的最高分 + 1：课程内置顶，
 * 跨课程仍按全局分数排序语义（不无限跳到其他课程之上）。 */
export function pinHeadScore(events: Array<{ course: string; score: number }>, course: string): number {
  let max = 0
  for (const e of events) {
    if (e.course === course && e.score > max) max = e.score
  }
  return max + 1
}

/** 榜首新课的自然语句理由（#67）：由既有推荐信号（解锁数 / 区轮转）拼成一句
 * 可读的话，替代原来的分号拼接短语——引擎始终提议非指令。 */
export function newLessonRationale(unlocks: number, region: string, regionTop: boolean): string {
  const why: string[] = []
  if (unlocks > 0) why.push(`学好它能解锁 ${unlocks} 个后继`)
  why.push(regionTop ? `「${region}」区最久没学，按轮转该轮到它了` : `「${region}」区按轮转次序排到它`)
  return `为什么先学它：${why.join('，')}。`
}
