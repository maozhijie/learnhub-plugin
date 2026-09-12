/**
 * 受理门通过率对照实验（#163 AC3 / ADR-0041）：同一组「带幻觉的裁决草稿」，分别以
 * **单发形态**（#162 的盲盒上下文包——产裁决前无任何自查）与**工具回路形态**（#163——
 * 裁决前经 graph_view 核实节点/区名、concept_registry 对表概念）送入生长站，统计
 * 受理门（propose）通过率。
 *
 * 实验设计（确定性，无随机）：12 个场景 = 3 类幻觉目标（pre 断边引用 / 区名 / 概念名）
 * × 4 个「貌似合理但在图上不存在」的变体——幻觉形态来自实机死批证据（引用不存在的区
 * 「代数与函数」、概念未铸名）。回路人格的修正**全部派生自工具回灌内容**（从 graph_view
 * 提取逐字节点/区名、从 concept_registry 提取 canonical，按二元组最大相似度对表），
 * 不作弊携带真名——它演示的是回路机制的能力：工具访问让畸形草稿在裁决前有据可修。
 *
 * 口径声明：人格是脚本化的，本实验度量的是**机制能力**（给了工具与自查轮，幻觉能在
 * 过门前被证据修正），不是真实模型的首过率；真实模型收益以实机运行日志为准。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { withVault } from './helpers/vault.ts'
import { AgentSeam } from '../src/engine/agent.ts'
import { systemClock } from '../src/host/clock.ts'

const SEED_VAULT = { registry: null, graph: null }

const CAPABILITY_SEED = `course: 数学
mode: new
concepts:
  - canonical: 变化率
endpoint:
  name: 用导数解决优化问题
  region: 基础
  block: 终点块
  teaches: {变化率: 会用}
starts:
  - name: 认识变化率
    region: 基础
    block: 起点块
    basis: baseline
    teaches: {变化率: 会用}
`

/** 金样本裁决骨架（与 coach-growth 的金样本同形：前进批 + pre 引用 + teaches 对表；
 * #198 主线批必接线终点——set_pre 替换语义随批接线新前沿）。 */
function goldVerdict(): string {
  return [
    'course: 数学',
    'note:',
    '  operator: 前进',
    '  reason: 前沿缺下一台阶，沿终点推进',
    'route: |',
    '  - **把变化率说成本质**：从日常速度出发建立「变化多快」的直觉。',
    'ops:',
    '  - op: add_node',
    '    name: 平均变化率',
    '    region: 基础',
    '    block: 起点块',
    '    pre: [认识变化率]',
    '    est: 15',
    '    bloom: 理解',
    '    difficulty: 2',
    '    teaches: {变化率: 会用}',
    '  - op: set_pre',
    '    node: 用导数解决优化问题',
    '    pre: [平均变化率]',
  ].join('\n') + '\n'
}

/** 幻觉场景：3 类目标 × 4 变体（貌似合理、图上/登记表不存在）。 */
const HALLUCINATIONS: Array<{ target: string; variants: string[]; apply: (v: string, yaml: string) => string }> = [
  {
    target: 'pre 断边引用（节点名不存在）',
    variants: ['认识变化律', '变化率认识', '认识变化率（基础）', '认识变化率初步'],
    apply: (v, yaml) => yaml.replace('pre: [认识变化率]', `pre: [${v}]`),
  },
  {
    target: '区名不存在（实机死批形态）',
    variants: ['代数与函数', '概率统计', '函数与极限', '代数'],
    apply: (v, yaml) => yaml.replaceAll('region: 基础', `region: ${v}`),
  },
  {
    target: '概念未铸名（teaches 对表拒收）',
    variants: ['变化律', '变化率概念', '变化率原理', '变化率（直觉）'],
    apply: (v, yaml) => yaml.replace('teaches: {变化率: 会用}', `teaches: {${v}: 会用}`),
  },
]

const SCENARIOS = HALLUCINATIONS.flatMap(h => h.variants.map(v => ({ target: h.target, variant: v, yaml: h.apply(v, goldVerdict()) })))

// ---- 回路人格的「证据修正」：全部派生自工具回灌文本，不携带真名 ----

const bigrams = (s: string): Set<string> => new Set([...s].slice(0, -1).map((_, i) => s.slice(i, i + 2)))

/** 二元组最大相似度对表：在候选里挑与幻觉名最接近的逐字名（无阈值——单候选必命中）。 */
function bestMatch(bad: string, candidates: string[]): string {
  const B = bigrams(bad)
  let best = candidates[0]!
  let bestScore = -1
  for (const c of candidates) {
    const A = bigrams(c)
    let inter = 0
    for (const x of A) if (B.has(x)) inter++
    const score = inter / Math.max(1, Math.min(A.size, B.size))
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best
}

/** 从工具回灌文本提取取值域并修正草稿（回路人格的裁前自查）。只对表**引用**——
 * pre 必须命中既有节点或本批更早创建的节点、region 必须命中既有区、teaches 必须命中
 * 登记表 canonical；add_node 的 name 是新节点名，合法地不在图上，不作对表。 */
function selfCheckCorrect(draft: string, graphView: string, registryText: string): string {
  const nodeNames = [...graphView.matchAll(/^- (.+?)（/gm)].map(m => m[1]!)
  const regions = [...new Set([...graphView.matchAll(/（(.+?)·.+?｜/gm)].map(m => m[1]!))]
  const concepts = [...registryText.matchAll(/^- (.+?)(?:（|：|$)/gm)].map(m => m[1]!)
  // 本批新建节点是后续 op（终点接线 set_pre）的合法 pre 取值域（与受理门同口径）
  const batchNames = [...draft.matchAll(/- op: add_node\n\s+name: (.+)/g)].map(m => m[1]!.trim())
  const preTargets = [...nodeNames, ...batchNames]
  let out = draft
  // pre 引用对表节点名
  out = out.replace(/pre: \[(.+?)\]/g, (_m, inner: string) =>
    'pre: [' + inner.split('、').map(x => preTargets.includes(x.trim()) ? x.trim() : bestMatch(x.trim(), preTargets)).join('、') + ']')
  // region 对表区名
  out = out.replace(/^(\s*region: )(.+)$/gm, (_m, p: string, r: string) =>
    p + (regions.includes(r.trim()) ? r : bestMatch(r.trim(), regions)))
  // teaches 对表登记表 canonical
  out = out.replace(/teaches: \{(.+?)\}/g, (_m, inner: string) =>
    'teaches: {' + inner.split('、').map(kv => {
      const [c, t] = kv.split(': ').map(s => s.trim())
      return `${concepts.includes(c!) ? c : bestMatch(c!, concepts)}: ${t}`
    }).join('、') + '}')
  return out
}

/** 单发形态假实现（#162 站点形态）：盲产裁决，零工具轮。 */
function singleShotFake(verdict: string): AgentSeam {
  return new AgentSeam({
    complete: async () => verdict,
    stream: async () => ({ text: verdict, toolCalls: [] }),
  }, systemClock)
}

/** 回路形态假实现（#163 站点形态）：先查图面与登记表，从回灌内容修正后再裁决。 */
function loopFake(corrupted: string): AgentSeam {
  const requests: Array<{ messages: Array<{ role: string; text?: string }>; tools?: Array<{ name: string }> }> = []
  const seam = new AgentSeam({
    complete: async () => { throw new Error('回路人格不走单发') },
    stream: async req => {
      requests.push({ messages: [...req.messages], tools: req.tools })
      if (requests.length === 1) return { text: '先查图面与登记表再裁。', toolCalls: [{ id: 'g1', name: 'graph_view', arguments: '{}' }] }
      if (requests.length === 2) return { text: '对表概念登记表。', toolCalls: [{ id: 'c1', name: 'concept_registry', arguments: '{}' }] }
      const graphView = requests[1]!.messages[2]!.text!
      const registry = requests[2]!.messages[4]!.text!
      return { text: selfCheckCorrect(corrupted, graphView, registry), toolCalls: [] }
    },
  }, systemClock)
  return Object.assign(seam, { requests })
}

test('受理门通过率对照（12 场景）：单发 0/12 vs 回路 12/12——工具自查让幻觉在过门前被证据修正', async () => {
  // 每场景一枚新 vault：金样本批会创建同名节点，跨场景不能共用一张图
  let singlePass = 0
  let loopPass = 0
  const seenTargets = new Set<string>()
  for (const sc of SCENARIOS) {
    await withVault(SEED_VAULT, async ({ engine }) => {
      const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
      await engine.graph.graphApply('seed', r.id)

      // 单发形态：盲产裁决被受理门拒收（零提案落盘）
      await assert.rejects(
        () => engine.growth2.coachGrowthBatch('数学', singleShotFake(sc.yaml)),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          return /受理门拒收|区不存在|断边|未铸名|登记表/.test(msg)
        },
        `${sc.target}「${sc.variant}」应被受理门拒收`,
      )
      assert.equal((await engine.graph.graphProposals('pending', 'edit')).length, 0, '被拒批零落盘')

      // 回路形态：裁前自查（graph_view + concept_registry）→ 证据修正 → 过门
      const fake = loopFake(sc.yaml)
      const out = await engine.growth2.coachGrowthBatch('数学', fake)
      assert.equal(out.state, 'applied', `${sc.target}「${sc.variant}」经回路修正后应过受理门`)
      assert.ok(out.trajectory.some(t => t.includes('graph_view')), '自查真的发生了（轨迹可证）')
      assert.ok(out.applied!.compass_rewritten)
      seenTargets.add(sc.target)
      loopPass++
    })
    void singlePass
  }
  const singleRate = `${singlePass}/${SCENARIOS.length}`
  const loopRate = `${loopPass}/${SCENARIOS.length}`

  assert.equal(loopPass, SCENARIOS.length, `回路形态全过（实测 ${loopRate}）`)
  assert.ok(singlePass < loopPass, `回路严格优于单发（单发 ${singleRate} vs 回路 ${loopRate}）`)
  assert.equal(seenTargets.size, HALLUCINATIONS.length, '三类幻觉目标全覆盖')
})