/**
 * 教练只读工具面单测（#163 / ADR-0041；#249 / ADR-0077 七件 → 八件）：
 * - 白名单结构：恰八件只读视图（顺序与名字是教练工具调用的取值域契约），
 *   concept_registry 已移除、concept_footprint / upstream_dag 在册；
 * - 只读性（零写侧）：全白名单逐工具调用后 vault 字节级不变——工具实现没有队列入口、
 *   没有教练/入队触点，防递归自激在这里落成可断言的行为；
 * - 视图内容：图面/节点卡/概念足迹/题库概况/上游图摘要的折叠形态与合法空态；
 * - 拒收语义：白名单外（含已退役的 concept_registry）调用 fail loud、坏参数 fail loud
 *   （缝以 isError 回灌，模型可见）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withVault, DEFAULT_REGISTRY } from './helpers/vault.ts'
import { draftCourse, CAPABILITY_DRAFT } from './helpers/drafted.ts'
import {
  COACH_TOOL_NAMES, coachToolSpecs, coachToolExecutor, renderGrowthGraphView,
} from '../src/engine/coach-tools.ts'
import type { CoachToolDeps } from '../src/engine/coach-tools.ts'
import { Graph } from '../src/engine/graph/graph.ts'
import { resolveConcept } from '../src/engine/concepts/concepts.ts'
import type { GNode, Fm } from '../src/engine/types.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import type { CourseEntry } from '../src/engine/types.ts'

// ---- 纯函数夹具（全图摘要直测：零 IO，Graph + Fm 直构）----

const gNode = (name: string, pre: string[], extra: Partial<GNode> = {}): GNode =>
  ({ name, pre, opt: false, note: '', enc: [], ...extra })

/** 最小 Fm（只填掌握度折叠读到的字段；content 给合法缺省）。 */
const fm = (stage: Fm['stage'], practice: { attempts: number; correct: number } = { attempts: 0, correct: 0 }): Fm =>
  ({ node: 'x', stage, fsrs: null, content: { version: 0, generated_at: null, status: 'ready' }, practice })

const SEED_VAULT = { registry: null, graph: null }

/** 起草夹具：概念「变化率」带别名/定义（概念足迹 query 过滤断言用）。 */
const DRAFT = {
  ...CAPABILITY_DRAFT,
  concepts: [{ canonical: '变化率', aliases: ['rate of change'], definition: '刻画「变化多快」的概念' }],
}

/**
 * 测试侧 providers：行为摘要给替身（本文件不测它的渲染），概念足迹的 invokes 折叠按
 * **生产同一规则**自建（排除归档题 + 登记表 canonical 归一）——生产口径住
 * `growth-subsystem.conceptInvokesOf`，facade 全链（coach-growth 的脚本化工具回合）
 * 消费的是那一份；本文件只在直测渲染面时喂等价输入。
 */
function providersOf(engine: LearnhubEngine, c: CourseEntry): { behaviorDigestText: () => Promise<string>; conceptInvokes: () => Promise<Map<string, Map<string, number>>> } {
  return {
    behaviorDigestText: async () => '摘要',
    conceptInvokes: async () => {
      const entries = await engine.concepts.load(c.root)
      const out = new Map<string, Map<string, number>>()
      await engine.learner.scanCourseBanks(c, async (node, bank) => {
        for (const q of bank.questions) {
          if (q.archived === true) continue
          const raw = typeof q.invokes === 'string' ? q.invokes.trim() : ''
          if (!raw) continue
          const concept = resolveConcept(entries, raw)?.canonical ?? raw
          let byNode = out.get(concept)
          if (!byNode) out.set(concept, byNode = new Map())
          byNode.set(node, (byNode.get(node) ?? 0) + 1)
        }
      })
      return out
    },
  }
}

function depsOf(engine: LearnhubEngine): CoachToolDeps {
  return {
    fs: engine.fs,
    paths: engine.paths,
    concepts: engine.concepts,
    scanCourseBanks: (c, fn) => engine.learner.scanCourseBanks(c, fn),
    loadView: c => engine.loadView(c),
    learningDay: () => engine.learningDay(),
  }
}

/** 需要 node 参数的工具（逐字节点名）——只读性遍历时按名单补参。 */
const NODE_PARAM_TOOLS: Record<string, string> = {
  node_card: '{"node":"认识变化率"}',
  upstream_dag: '{"node":"用导数解决优化问题"}',
}

const course: CourseEntry = { name: '数学', root: 'math' }

/** vault 全量快照（相对路径 + 字节），只读性断言的底座。 */
async function snapshotVault(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else out.set(p.slice(root.length + 1), await readFile(p, 'utf8'))
    }
  }
  await walk(root)
  return out
}

test('白名单结构：恰八件只读视图（concept_registry 退役），规格带描述与参数 schema', () => {
  assert.deepEqual([...COACH_TOOL_NAMES], [
    'graph_view', 'node_card', 'concept_footprint', 'behavior_digest',
    'bank_overview', 'compass_read', 'endpoint_anchor', 'upstream_dag',
  ])
  assert.ok(!(COACH_TOOL_NAMES as readonly string[]).includes('concept_registry'), 'concept_registry 已由 concept_footprint 完整吸收')
  const specs = coachToolSpecs()
  assert.deepEqual(specs.map(s => s.name), [...COACH_TOOL_NAMES], '规格与白名单常量同源')
  for (const s of specs) {
    assert.ok(s.description.length > 10, `${s.name} 带描述`)
    assert.equal((s.parameters as { type?: string }).type, 'object')
  }
  // 空结果语义必须落在工具描述里（ADR-0077：引擎不写定位规则，语义靠工具面告知）
  const fp = specs.find(s => s.name === 'concept_footprint')
  assert.match(fp!.description, /空 ≠ 不存在/)
})

test('只读性：全白名单逐工具调用后 vault 字节级不变（零写侧、零队列触点的行为化断言）', async () => {
  await withVault(SEED_VAULT, async ({ engine, root }) => {
    await draftCourse(engine, DRAFT)
    const course = await engine.registry.resolve('数学') as CourseEntry
    const before = await snapshotVault(root)
    const runTool = coachToolExecutor(depsOf(engine), course, providersOf(engine, course))
    for (const name of COACH_TOOL_NAMES) {
      const out = await runTool({ id: 'x', name, arguments: NODE_PARAM_TOOLS[name] ?? '{}' })
      assert.ok(out.length > 0, `${name} 产出非空视图`)
    }
    const after = await snapshotVault(root)
    assert.deepEqual([...after.entries()], [...before.entries()], '工具面零写侧：vault 字节级不变')
  })
})

test('视图内容：图面带节点取值域、节点卡带结构档、概念足迹双职责、题库概况计数、上游图摘要全拓扑', async () => {
  await withVault(SEED_VAULT, async ({ engine, root }) => {
    await draftCourse(engine, DRAFT)
    const course = await engine.registry.resolve('数学') as CourseEntry
    // 起草自建课程根：题库文件按真实根落盘（bank_overview / concept_footprint 取材）
    const { writeFile, mkdir } = await import('node:fs/promises')
    const bankDir = join(root, '学习中心', course.root, '题库')
    await mkdir(bankDir, { recursive: true })
    await writeFile(join(bankDir, '认识变化率.yaml'),
      ['node: 认识变化率', 'questions:',
        '  - id: q1', '    kind: true_false', '    q: 变化率题干。', '    answer: true', '    invokes: 变化率',
        '  - id: q2', '    kind: true_false', '    q: 归档题干。', '    answer: false', '    archived: true',
      ].join('\n') + '\n', 'utf8')
    const runTool = coachToolExecutor(depsOf(engine), course, providersOf(engine, course))

    // graph_view：结构事实源（节点名 + pre 引用取值域）
    const view = await runTool({ id: '1', name: 'graph_view', arguments: '' })
    assert.match(view, /当前图面/)
    assert.match(view, /认识变化率/)
    assert.match(view, /teaches: 变化率 会用/)

    // node_card：单节点结构档
    const card = await runTool({ id: '2', name: 'node_card', arguments: '{"node":"用导数解决优化问题"}' })
    assert.match(card, /节点卡：用导数解决优化问题/)
    assert.match(card, /深度：1（读侧派生，地基在 0）/)
    assert.doesNotMatch(card, /区·块/)
    assert.match(card, /teaches：变化率 会用/)

    // concept_footprint：词条档（canonical/别名/定义）+ 足迹（teaches/assumes/invokes 分布）
    const fp = await runTool({ id: '3', name: 'concept_footprint', arguments: '{"query":"rate of change"}' })
    assert.match(fp, /1\/1 条/)
    assert.match(fp, /### 变化率/)
    assert.match(fp, /词条档：别名 rate of change｜刻画「变化多快」的概念/)
    assert.match(fp, /教学面：teaches 认识变化率、用导数解决优化问题/)
    assert.match(fp, /题目 invokes 分布：认识变化率 ×1/, '归档题不进 invokes 分布')
    assert.match(fp, /足迹非空 = 有天然挂点/)
    // 空结果 = 不是不存在（语义写进渲染产物本身）
    const miss = await runTool({ id: '3b', name: 'concept_footprint', arguments: '{"query":"极限"}' })
    assert.match(miss, /无命中条目/)
    assert.match(miss, /空 ≠ 不存在/)
    // 无 query = 全表（登记表 cap 内全读）
    const all = await runTool({ id: '3c', name: 'concept_footprint', arguments: '' })
    assert.match(all, /1\/1 条（全表——无 query）/)

    // bank_overview：在库/归档/invokes 计数
    const bank = await runTool({ id: '4', name: 'bank_overview', arguments: '' })
    assert.match(bank, /题库概况：数学/)
    assert.match(bank, /认识变化率：2 题（归档 1 · invokes 标注 1）/)

    // upstream_dag：前置闭包全拓扑 + 邻接表（认识变化率 是 用导数解决优化问题 的唯一上游）
    const dag = await runTool({ id: '5', name: 'upstream_dag', arguments: '{"node":"用导数解决优化问题"}' })
    assert.match(dag, /上游图摘要：用导数解决优化问题 ⚑（前置传递闭包 1 个节点）/)
    assert.match(dag, /- 认识变化率（深度 0｜未开始·待生成｜掌握 0）/, '未开始节点不误标 ⚠（ready 是「还没学」不是「学塌了」）')
    assert.match(dag, /### 闭包内 pre 邻接/)
    assert.match(dag, /- 用导数解决优化问题 → 认识变化率/)
    // 根节点：闭包空给合法空态行
    const rootDag = await runTool({ id: '5b', name: 'upstream_dag', arguments: '{"node":"认识变化率"}' })
    assert.match(rootDag, /闭包为空——该节点是根/)
  })
})

test('上游图摘要：⚠ 弱掌握标记与超 cap 按深度截断的显式溢出行（ADR-0077）', async () => {
  await withVault(SEED_VAULT, async ({ engine }) => {
    // 起点节点已开始且掌握度低（stage=learning + 练习正确率低 → mastery<0.5）→ ⚠
    await draftCourse(engine, {
      ...DRAFT,
      notes: { '认识变化率': { stage: 'learning', practice: { attempts: 3, correct: 1 } } },
    })
    const course = await engine.registry.resolve('数学') as CourseEntry
    const runTool = coachToolExecutor(depsOf(engine), course, providersOf(engine, course))
    const dag = await runTool({ id: '1', name: 'upstream_dag', arguments: '{"node":"用导数解决优化问题"}' })
    assert.match(dag, /- 认识变化率（深度 0｜在学｜掌握 0\.1 ⚠/, '弱掌握节点在闭包拓扑里带 ⚠')
  })

  // 超 cap：cap=60，造 65 个上游节点（单链）+ 目标节点
  const chain = 66
  const nameOf = (i: number): string => `链${String(i).padStart(3, '0')}`
  const graphYaml = [
    'nodes:',
    ...Array.from({ length: chain }, (_, i) =>
      i === chain - 1
        ? `  - { name: ${nameOf(i)}, pre: [${nameOf(i - 1)}] }`
        : `  - { name: ${nameOf(i)}, pre: [${i ? nameOf(i - 1) : ''}] }`),
  ].join('\n')
  await withVault({ registry: DEFAULT_REGISTRY, graph: graphYaml }, async ({ engine }) => {
    const course = await engine.registry.resolve('数学') as CourseEntry
    const runTool = coachToolExecutor(depsOf(engine), course, providersOf(engine, course))
    const dag = await runTool({ id: '1', name: 'upstream_dag', arguments: `{"node":"${nameOf(chain - 1)}"}` })
    assert.match(dag, new RegExp(`前置传递闭包 ${chain - 1} 个节点`))
    assert.match(dag, /超出预览上限 60，余 5 个——按深度截断/)
    assert.match(dag, /### 闭包内 pre 邻接/)
  })
})

test('全图摘要（纯函数）:逐节点一行含深度/掌握/邻接，⚠ 弱掌握与 ⚑ 终点标记；概念组读数常驻', () => {
  const graph = new Graph([
    gNode('甲', []),
    gNode('乙', ['甲']),
    gNode('丙', ['乙'], { est: 15 }),
    gNode('终点', ['丙']),
  ])
  const state: Record<string, Fm> = {
    甲: fm('review', { attempts: 3, correct: 1 }),   // 已开始且掌握 0.1 → ⚠
    乙: fm('learning'),                              // 已开始、掌握 0 → ⚠
    丙: fm('ready'),                                 // 未开始 → 不标 ⚠
    终点: fm('unseen'),
  }
  const view = renderGrowthGraphView(graph, state, new Set(['终点']), { today: '2026-09-15' })
  assert.match(view, /## 当前图面（全图摘要——结构事实源/)
  assert.match(view, /节点共 4 个；前沿与在学 \d+ 个｜弱掌握 2 个 ⚠/)
  assert.match(view, /- ⚑ 终点：终点（方向标记/)
  assert.match(view, /### 全图（逐节点一行，深度序——⚠ 弱掌握、⚑ 终点）/)
  // 逐节点一行：深度序在前（甲 d0 在 丙 d2 之前）+ 掌握 + pre 邻接 + teaches 并入同行
  // （#281：区·块死坐标退役，逐节点行不再携带）
  assert.match(view, /### 概念组读数（teaches\/assumes 派生可重叠；未标概念显式在列）/)
  assert.match(view, /- 未标概念：4 个节点（合法 Missing/)
  assert.match(view, /- 甲（深度 0｜复习中｜掌握 0\.1 ⚠）｜pre: （根）/)
  assert.match(view, /- 丙（深度 2｜未开始·待生成｜掌握 0｜est 15′）｜pre: 乙/)
  assert.match(view, /- 终点 ⚑（深度 3｜/)
  assert.ok(view.indexOf('- 甲（深度 0') < view.indexOf('- 丙（深度 2'), '深度序：地基在前')
  assert.ok(!/- 丙（[^）]*⚠/.test(view), '未开始（ready）不误标 ⚠——mastery 0 是还没学不是学塌了')
  // 全部节点名逐行在场 = pre 引用的取值域（旧「其余节点名单」的截断面已消失）
  for (const n of ['甲', '乙', '丙', '终点']) assert.ok(view.includes(`- ${n}`), `${n} 逐节点行在场`)

  // ⚑ 由读锚派生：零终点给合法空态行
  assert.match(renderGrowthGraphView(graph, state), /（零终点——空锚是合法空态/)
})

test('全图摘要（纯函数）：超 cap 降级为 depth 段聚合 + 前沿细节 + 溢出说明，⚠ 与 ⚑ 例外不截', () => {
  const many = Array.from({ length: 210 }, (_, i) => gNode(`批${String(i).padStart(3, '0')}`, []))
  const graph = new Graph([...many, gNode('弱点', [], { est: 10 }), gNode('终点', ['弱点'])])
  const state: Record<string, Fm> = { 弱点: fm('review', { attempts: 3, correct: 1 }), 终点: fm('unseen') }
  const view = renderGrowthGraphView(graph, state, new Set(['终点']), { today: '2026-09-15' })
  assert.match(view, /节点共 212 个/)
  assert.match(view, /超 200 已降级/)
  assert.match(view, /### depth 段聚合（超 200 个节点，逐节点行已降级）/)
  assert.match(view, /- L0：211 个节点（掌握均值 0｜前沿与在学 210）/)
  assert.match(view, /### 前沿与在学细节/)
  // ⚠ 与 ⚑ 例外不截：弱掌握与终点各自全列（即便它们落在聚合桶里）
  assert.match(view, /### ⚠ 弱掌握（例外不截，1 个）/)
  assert.match(view, /- 弱点（深度 0｜复习中｜掌握 0\.1 ⚠｜est 10′）｜pre: （根）/)
  assert.match(view, /### ⚑ 终点（例外不截，1 个）/)
  assert.match(view, /- 终点 ⚑（深度 1｜/)
  assert.match(view, /……（全图 212 个节点超出逐节点行上限 200——已降级为 depth 段聚合 \+ 前沿与在学细节；⚠ 弱掌握与 ⚑ 终点例外全列，概念组读数不降级。变焦细节用 upstream_dag \/ node_card。）/)
  assert.ok(!view.includes('### 全图（逐节点一行'), '降级时不再出逐节点行块（整块退场，不是逐节点截断）')
  // 聚合桶覆盖全量节点（211 + 1 = 212）——降级的诚实性在这里可判（终点因弱点已学而就绪）
  assert.match(view, /- L1：1 个节点（掌握均值 0｜前沿与在学 1）/)
})

test('合法空态与拒收语义：零终点锚给空态行；白名单外/坏参数 fail loud', async () => {
  await withVault({ registry: DEFAULT_REGISTRY, graph: null }, async ({ engine }) => {
    void engine
    const runTool = coachToolExecutor({
      fs: {
        exists: () => false,
        readFile: async () => { const e: Error & { code?: string } = new Error('no file'); e.code = 'ENOENT'; throw e },
        writeFile: async () => undefined,
      } as never,
      paths: engine.paths,
      concepts: engine.concepts,
      scanCourseBanks: async () => undefined,
      loadView: async () => { throw new Error('不应取图') },
      learningDay: async () => ({ today: '2026-09-15', cutoff: 0 }),
    }, course, providersOf(engine, course))

    // 零终点（空锚）：罗盘/终点锚视图给合法空态（不炸、不静默编内容）
    const anchor = await runTool({ id: '1', name: 'endpoint_anchor', arguments: '' })
    assert.match(anchor, /零终点/)
    const compass = await runTool({ id: '2', name: 'compass_read', arguments: '' })
    assert.match(compass, /零终点/)

    // 白名单外调用 fail loud（缝以 isError 回灌，模型可见拒收原因与唯一取值域）
    await assert.rejects(
      () => runTool({ id: '3', name: 'graph_apply', arguments: '{"kind":"edit"}' }),
      /白名单外工具「graph_apply」被拒.*提案→受理门→apply/,
    )
    // 已退役的 concept_registry 也走拒收——不是「换了个名字还在」，是白名单真收紧了
    // （#249 验收：registry 移除后的拒收；拒收文案回程新名单供模型改道）
    await assert.rejects(
      () => runTool({ id: '3b', name: 'concept_registry', arguments: '{"query":"变化率"}' }),
      /白名单外工具「concept_registry」被拒.*concept_footprint/s,
    )
    await assert.rejects(
      () => runTool({ id: '4', name: 'enqueue_generation', arguments: '{}' }),
      /白名单外工具「enqueue_generation」被拒/,
    )

    // 坏参数 fail loud：非法 JSON / 缺参
    await assert.rejects(
      () => runTool({ id: '6', name: 'node_card', arguments: 'not-json' }),
      /参数不是合法 JSON/,
    )
    await assert.rejects(
      () => runTool({ id: '7', name: 'node_card', arguments: '{}' }),
      /需要 node 参数/,
    )
  })
})

test('node_card 未知节点 fail loud 并指路 graph_view（图面是逐字取值域）', async () => {
  await withVault({ registry: DEFAULT_REGISTRY }, async ({ engine }) => {
    const runTool = coachToolExecutor(depsOf(engine), course, providersOf(engine, course))
    await assert.rejects(
      () => runTool({ id: '1', name: 'node_card', arguments: '{"node":"不存在的节点"}' }),
      /不在图上.*graph_view/,
    )
    // 对照：在册节点出卡
    const card = await runTool({ id: '2', name: 'node_card', arguments: '{"node":"入门"}' })
    assert.match(card, /节点卡：入门/)
  })
})
