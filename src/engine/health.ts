/**
 * 图谱健康分：把「教学语义上站得住」压缩成一个可优化的数字（0-100，5 项各 20 分）。
 *
 * 设计动机：audit 只查结构（重名/环/断边），「无 ERROR」是图谱构建的唯一结束信号，
 * 模型缺乏继续分批打磨的动力。健康分给出技能层「结束条件」的可计算锚点
 * （结束条件「健康分 ≥ 80」写在 learnhub-graph-generate 技能里，引擎只报分数不设阈值）。
 * 全部指标从图派生结构即可计算，不依赖学习状态。
 */
import type { Graph } from './graph.ts'

/** 动作词表（learnhub-graph-generate 技能「单元命名」节的机械化版本）。 */
const ACTION_WORDS = [
  '解', '求', '证明', '推导', '计算', '辨析', '建立', '比较', '判定', '构造',
  '区分', '应用', '验证', '化简', '变形', '转化', '估计', '近似', '检验', '分类',
  '归纳', '抽象', '训练', '设计', '实现', '绘制', '判断', '评估', '预测', '优化',
  '列举', '描述', '解释', '分析', '选择', '转换', '识别', '掌握', '理解',
]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** 图谱健康分：score ∈ [0,100]；breakdown 各项均为 0-20 的原始得分。 */
export function graphHealthScore(graph: Graph): { score: number; breakdown: Record<string, number> } {
  const names = graph.names

  // a) 动作句比例 ×20
  const actionHits = names.filter(n => ACTION_WORDS.some(w => n.includes(w))).length
  const actionNaming = names.length ? (actionHits / names.length) * 20 : 0

  // b) est 覆盖率 ×20
  const estCoverage = names.length ? (Object.keys(graph.estOf).length / names.length) * 20 : 0

  // c) 前置完备 ×20：depth>1 且 pre 为空 = 空降节点，越少越好
  const floats = names.filter(n => (graph.depth[n] ?? 0) > 1 && graph.preOf[n].length === 0).length
  const preCompleteness = names.length ? (1 - floats / names.length) * 20 : 0

  // d) 收敛度 ×20：非根节点平均 pre 数（≥2 满分、=1 零分线性插值；环/无内点 = 0）
  const inner = names.filter(n => graph.preOf[n].length > 0)
  const avgPre = inner.length ? inner.reduce((s, n) => s + graph.preOf[n].length, 0) / inner.length : 0
  const convergence = graph.hasCycle || !inner.length ? 0 : 20 * clamp01((avgPre - 1) / 1)

  // e) 结构卫生 ×20：别名包含命名、多连通分量、不可达节点逐项扣分。
  //    别名命中按节点数归一：包含对随图规模自然增多（「勾股定理」⊂「勾股定理的逆定理」
  //    这类合法派生命名在数百节点图里不可全罚），每 50 节点容忍 1 对起扣。
  const uniq = [...graph.nset].sort((a, b) => a.length - b.length)
  let aliasHits = 0
  for (let i = 0; i < uniq.length; i++) {
    if (uniq[i].length < 3) continue
    for (let j = i + 1; j < uniq.length; j++) {
      if (uniq[i] !== uniq[j] && uniq[j].includes(uniq[i])) aliasHits++
    }
  }
  const aliasAllowance = Math.max(1, Math.ceil(names.length / 50))
  let hygiene = 20
  hygiene -= Math.min(10, Math.floor(aliasHits / aliasAllowance) * 2)
  hygiene -= Math.min(6, Math.max(0, graph.components.length - 1) * 3)
  hygiene -= names.length > 0 && graph.roots.length === 0 ? 4 : 0
  const structureHygiene = Math.max(0, hygiene)

  const breakdown = {
    action_naming: Math.round(actionNaming * 10) / 10,
    est_coverage: Math.round(estCoverage * 10) / 10,
    pre_completeness: Math.round(preCompleteness * 10) / 10,
    convergence: Math.round(convergence * 10) / 10,
    structure_hygiene: structureHygiene,
  }
  const score = Math.min(100, Math.round(Object.values(breakdown).reduce((s, v) => s + v, 0)))
  return { score, breakdown }
}
