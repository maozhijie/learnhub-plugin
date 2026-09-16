/**
 * 题库一键清理（ADR-0032）：找出「基本不会再有用」的题，预览分组 → 确认 → 归档，
 * 永不物理删除。范围两条规则：
 *   (a) 跳过节点（stage=skipped）的全部未归档题——跳过即视同已通过，其题库整体退场；
 *   (b) 已完成节点（review/mastered）的休眠题（CONTEXT.md：在库未归档、从未调度）——
 *       错过了 nodeComplete 的一次性纳管（完成后的补题/校准重出），此后大多不再被用到。
 * 纯规则函数（引擎无关，可直接单测）；落盘走既有 archiveQuestion（reason=cleanup）。
 */

/** 节点完成后不再有批量纳管入口的 stage 集合（mastered 引擎当前不写入，读侧兼容）。 */
const COMPLETED_STAGES: ReadonlySet<string> = new Set(['review', 'mastered'])

/** 清理规则标签：skipped_node=跳过节点的题 / dormant_after_complete=已完成节点的休眠题。 */
export type CleanupReason = 'skipped_node' | 'dormant_after_complete'

/** 单节点清理候选（纯规则）：stage 与题库行 → 候选 qid + 规因。空数组 = 该节点无候选。 */
export function cleanupCandidatesForNode(
  stage: string | undefined,
  qs: Array<{ id: string; archived?: boolean; fsrs?: { reps: number } | null }>,
): Array<{ qid: string; reason: CleanupReason }> {
  if (stage === 'skipped') {
    return qs.filter(q => !q.archived).map(q => ({ qid: q.id, reason: 'skipped_node' }))
  }
  if (stage !== undefined && COMPLETED_STAGES.has(stage)) {
    return qs.filter(q => !q.archived && !q.fsrs?.reps).map(q => ({ qid: q.id, reason: 'dormant_after_complete' }))
  }
  return []
}
