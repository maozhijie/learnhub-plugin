/** 学习页推荐流的事件词汇与排序（LearnPage 消费）——零依赖纯模块，node:test 可直接消费。
 * 排序口径：置顶（「今天学它」pin，E3）→ 事件类型展示序（REC_TYPE.order）→ 原序稳定。 */

export interface RecTypeMeta { label: string; color: string; order: number }

export const REC_TYPE: Record<string, RecTypeMeta> = {
  pin: { label: '今天学它', color: 'gold', order: 0 },
  overdue: { label: '逾期', color: 'red', order: 1 },
  review: { label: '复习', color: 'green', order: 2 },
  diagnostic: { label: '内容诊断', color: 'magenta', order: 3 },
  learning: { label: '继续学', color: 'arcoblue', order: 4 },
  new: { label: '新学', color: 'cyan', order: 5 },
}

/** 未知类型排在全部已知类型之后（order 9），展示名回落到原始 type。 */
export function recTypeMeta(type: string): RecTypeMeta {
  return REC_TYPE[type] ?? { label: type, color: 'gray', order: 9 }
}

/** 推荐流排序：pin 置顶 → 类型 order 升序；两者皆同保持原序（Array.sort 稳定）。 */
export function sortRecEvents<T extends { pinned?: boolean; type: string }>(events: T[]): T[] {
  return [...events].sort((a, b) =>
    ((a.pinned ? 0 : 1) - (b.pinned ? 0 : 1))
    || (recTypeMeta(a.type).order - recTypeMeta(b.type).order))
}
