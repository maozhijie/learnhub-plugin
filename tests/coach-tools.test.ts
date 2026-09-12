/**
 * 教练只读工具面单测（#163 / ADR-0041）：
 * - 白名单结构：恰 ADR-0041 七件只读视图（顺序与名字是教练工具调用的取值域契约）；
 * - 只读性（零写侧）：全白名单逐工具调用后 vault 字节级不变——工具实现没有队列入口、
 *   没有教练/入队触点，防递归自激在这里落成可断言的行为；
 * - 视图内容：图面/节点卡/登记表/题库概况的折叠形态与合法空态；
 * - 拒收语义：白名单外调用 fail loud、坏参数 fail loud（缝以 isError 回灌，模型可见）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withVault, DEFAULT_REGISTRY } from './helpers/vault.ts'
import {
  COACH_TOOL_NAMES, coachToolSpecs, coachToolExecutor,
} from '../src/engine/coach-tools.ts'
import type { CoachToolDeps } from '../src/engine/coach-tools.ts'
import type { LearnhubEngine } from '../src/engine/index.ts'
import type { CourseEntry } from '../src/engine/types.ts'

const SEED_VAULT = { registry: null, graph: null }

const CAPABILITY_SEED = `course: 数学
mode: new
concepts:
  - canonical: 变化率
    aliases: [rate of change]
    definition: 刻画「变化多快」的概念
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

function depsOf(engine: LearnhubEngine): CoachToolDeps {
  return {
    fs: engine.fs,
    paths: engine.paths,
    concepts: engine.concepts,
    scanCourseBanks: (c, fn) => engine.learner.scanCourseBanks(c, fn),
    loadView: c => engine.loadView(c),
  }
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

test('白名单结构：恰 ADR-0041 七件只读视图，规格带描述与参数 schema', () => {
  assert.deepEqual([...COACH_TOOL_NAMES], [
    'graph_view', 'node_card', 'concept_registry', 'behavior_digest',
    'bank_overview', 'compass_read', 'endpoint_anchor',
  ])
  const specs = coachToolSpecs()
  assert.deepEqual(specs.map(s => s.name), [...COACH_TOOL_NAMES], '规格与白名单常量同源')
  for (const s of specs) {
    assert.ok(s.description.length > 10, `${s.name} 带描述`)
    assert.equal((s.parameters as { type?: string }).type, 'object')
  }
})

test('只读性：全白名单逐工具调用后 vault 字节级不变（零写侧、零队列触点的行为化断言）', async () => {
  await withVault(SEED_VAULT, async ({ engine, root }) => {
    const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
    await engine.graph.graphApply('seed', r.id)
    const course = await engine.registry.resolve('数学') as CourseEntry
    const before = await snapshotVault(root)
    const runTool = coachToolExecutor(depsOf(engine), course, {
      behaviorDigestText: async () => '（行为摘要渲染产物——provider 注入）',
    })
    for (const name of COACH_TOOL_NAMES) {
      const out = await runTool({ id: 'x', name, arguments: name === 'node_card' ? '{"node":"认识变化率"}' : '{}' })
      assert.ok(out.length > 0, `${name} 产出非空视图`)
    }
    const after = await snapshotVault(root)
    assert.deepEqual([...after.entries()], [...before.entries()], '工具面零写侧：vault 字节级不变')
  })
})

test('视图内容：图面带节点取值域、节点卡带结构档、登记表 query 过滤、题库概况计数', async () => {
  await withVault(SEED_VAULT, async ({ engine, root }) => {
    const r = await engine.graph.graphPropose('seed', CAPABILITY_SEED) as { id: number }
    await engine.graph.graphApply('seed', r.id)
    const course = await engine.registry.resolve('数学') as CourseEntry
    // 种子 apply 自建课程根：题库文件按真实根落盘（bank_overview 取材）
    const { writeFile, mkdir } = await import('node:fs/promises')
    const bankDir = join(root, '学习中心', course.root, '题库')
    await mkdir(bankDir, { recursive: true })
    await writeFile(join(bankDir, '认识变化率.yaml'),
      ['node: 认识变化率', 'questions:',
        '  - id: q1', '    kind: true_false', '    q: 变化率题干。', '    answer: true', '    invokes: 变化率',
        '  - id: q2', '    kind: true_false', '    q: 归档题干。', '    answer: false', '    archived: true',
      ].join('\n') + '\n', 'utf8')
    const runTool = coachToolExecutor(depsOf(engine), course, { behaviorDigestText: async () => '摘要' })

    // graph_view：结构事实源（节点名 + pre 引用取值域）
    const view = await runTool({ id: '1', name: 'graph_view', arguments: '' })
    assert.match(view, /当前图面/)
    assert.match(view, /认识变化率/)
    assert.match(view, /teaches: 变化率 会用/)

    // node_card：单节点结构档
    const card = await runTool({ id: '2', name: 'node_card', arguments: '{"node":"用导数解决优化问题"}' })
    assert.match(card, /节点卡：用导数解决优化问题/)
    assert.match(card, /基础 · 终点块/)
    assert.match(card, /teaches：变化率 会用/)

    // concept_registry：canonical/别名/定义 + query 子串过滤（命中别名也算命中）
    const registry = await runTool({ id: '3', name: 'concept_registry', arguments: '{"query":"rate of change"}' })
    assert.match(registry, /1\/1 条/)
    assert.match(registry, /变化率（别名：rate of change）：刻画「变化多快」的概念/)
    const miss = await runTool({ id: '3b', name: 'concept_registry', arguments: '{"query":"极限"}' })
    assert.match(miss, /无命中条目/)

    // bank_overview：在库/归档/invokes 计数
    const bank = await runTool({ id: '4', name: 'bank_overview', arguments: '' })
    assert.match(bank, /题库概况：数学/)
    assert.match(bank, /认识变化率：2 题（归档 1 · invokes 标注 1）/)
  })
})

test('合法空态与拒收语义：未播种锚给空态行；白名单外/坏参数 fail loud', async () => {
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
    }, course, { behaviorDigestText: async () => '摘要' })

    // 未播种：罗盘/终点锚视图给合法空态（不炸、不静默编内容）
    const anchor = await runTool({ id: '1', name: 'endpoint_anchor', arguments: '' })
    assert.match(anchor, /未播种/)
    const compass = await runTool({ id: '2', name: 'compass_read', arguments: '' })
    assert.match(compass, /未播种/)

    // 白名单外调用 fail loud（缝以 isError 回灌，模型可见拒收原因与唯一取值域）
    await assert.rejects(
      () => runTool({ id: '3', name: 'graph_apply', arguments: '{"kind":"edit"}' }),
      /白名单外工具「graph_apply」被拒.*提案→受理门→apply/,
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
    const runTool = coachToolExecutor(depsOf(engine), course, { behaviorDigestText: async () => '摘要' })
    await assert.rejects(
      () => runTool({ id: '1', name: 'node_card', arguments: '{"node":"不存在的节点"}' }),
      /不在图上.*graph_view/,
    )
    // 对照：在册节点出卡
    const card = await runTool({ id: '2', name: 'node_card', arguments: '{"node":"入门"}' })
    assert.match(card, /节点卡：入门/)
  })
})