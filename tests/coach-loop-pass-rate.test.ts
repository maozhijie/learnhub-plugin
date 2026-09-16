/**
 * 受理门通过率对照基线（#163 AC3 实验的 #273 后继形态）：
 *
 * 旧实验（单发盲盒 vs 工具回路，8 场景 0/8 vs 8/8）随旧单发路径退场（#273 不留开关）。
 * 新回路的「过门率下限」由两件东西构成，本文件锁前一半（结构性对照基线）：
 *
 * 1. **结构性消灭幻觉面**：思路官交接计划零节点名零图上引用——旧实验的 8 个幻觉场景
 *    （pre 断边引用 / 概念未铸名 × 4 变体）在新契约下**无法成立**：把节点名/图 op 塞进
 *    计划 = 计划门当场拒收（validatePlanHandover）。本测试以同一组 8 变体回放，断言
 *    全部被计划门拦截（对照基线：旧单发 0/8 → 新契约 8/8 拦截）。
 * 2. **机制能力（脚本化全链首次过门 8/8）**：思路官 plan（脚本化）→ 执行官轨迹（脚本化）
 *    → 真实提案管线，全链逐场景 applied——在 tests/coach-plan.test.ts 全链测试锁死。
 *
 * 口径声明照旧：人格是脚本化的，本组实验度量的是机制能力，不是真实模型的首过率。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePlanHandover } from '../src/engine/coach/coach-round.ts'

/** 金样本计划骨架（与 coach-plan 的金计划同形：前进 + 朝向 + 意图句台阶）。 */
function goldPlanYaml(): string {
  return [
    'course: 数学',
    'operator: 前进',
    'reason: 前沿缺下一台阶，沿终点推进',
    'target_endpoints: [用导数解决优化问题]',
    'steps:',
    '  - intent: 从日常速度建立「变化多快」的直觉',
    '    teaches_concept: 变化率',
    '    est_hint: 15',
  ].join('\n') + '\n'
}

/** 幻觉场景（旧实验的 2 类目标 × 4 变体 → 新契约下的等价形态：越权写补丁/节点名）。 */
const HALLUCINATIONS: Array<{ target: string; variants: string[]; apply: (v: string, yaml: string) => string }> = [
  {
    target: '越权写图 op（补丁归执行官）',
    variants: ['add_node', 'set_pre', 'del_node', 'rename'],
    apply: (v, yaml) => yaml.replace('    est_hint: 15', `    est_hint: 15\n    op: ${v}`),
  },
  {
    target: '节点名入计划（零名字契约）',
    variants: ['平均变化率', '认识变化率初步', '导数直觉台阶', '变化率（直觉）'],
    apply: (v, yaml) => yaml.replace('    teaches_concept: 变化率', `    teaches_concept: 变化率\n    name: ${v}`),
  },
]

const SCENARIOS = HALLUCINATIONS.flatMap(h => h.variants.map(v => ({ target: h.target, variant: v, yaml: h.apply(v, goldPlanYaml()) })))

test('结构性对照基线（8 场景）：越权补丁/节点名入计划 → 计划门 8/8 拦截；金计划零错误', () => {
  // 对照：金计划（零名字）过计划门
  assert.deepEqual(validatePlanHandover(
    { operator: '前进', reason: '前沿缺下一台阶', target_endpoints: ['用导数解决优化问题'], steps: [{ intent: '直觉台阶', teaches_concept: '变化率', est_hint: 15 }] },
    '数学',
  ), [], '金计划过门（对照基线的「回路侧」）')

  let blocked = 0
  const seenTargets = new Set<string>()
  for (const sc of SCENARIOS) {
    const errors = validatePlanHandover(
      // 解析回放：把注入了越权字段的 YAML 当 object 校验（门吃解析产物，错误作数据）
      injectAsObject(sc.yaml),
      '数学',
    )
    assert.ok(errors.length > 0, `${sc.target}「${sc.variant}」应被计划门拒收`)
    blocked++
    seenTargets.add(sc.target)
  }
  assert.equal(blocked, SCENARIOS.length, `新契约结构性拦截全部幻觉形态（实测 ${blocked}/${SCENARIOS.length}）——旧单发对照 0/8 的后继基线`)
  assert.equal(seenTargets.size, HALLUCINATIONS.length, '两类越权目标全覆盖')
})

/** 把回放 YAML 的 steps 项取成 object（门吃解析产物；这里手工还原注入字段）。 */
function injectAsObject(yaml: string): Record<string, unknown> {
  const op = yaml.match(/    op: (.+)/)?.[1]
  const name = yaml.match(/    name: (.+)/)?.[1]
  const step: Record<string, unknown> = { intent: '直觉台阶', teaches_concept: '变化率', est_hint: 15 }
  if (op !== undefined) step.op = op.trim()
  if (name !== undefined) step.name = name.trim()
  return {
    course: '数学',
    operator: '前进',
    reason: '前沿缺下一台阶，沿终点推进',
    target_endpoints: ['用导数解决优化问题'],
    steps: [step],
  }
}
