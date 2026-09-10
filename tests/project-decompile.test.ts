/**
 * 目标反编译（P-5 / #95）——**入口随 #138 cutover 退役**：知识子图半区走 pending gen
 * 提案（骨架路径），gen 已按 ADR-0033 生长式图退役；反编译子图簇将由种子提案重接
 * （#149）。本文件保留：
 * - 纯函数面：目标描述解析、检索词派生、双产物拆分校验（计划半区 = validatePlanArtifact、
 *   子图半区 = validateGenProposal）、子图落点裁决、修复轮提示词——#149 重接时原样复用；
 * - 入口退役契约：projectDecompile fail loud、模型零调用、零提案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decompileGoalOf, decompileRepairPrompt, decompileTerms, splitDecompileDoc, subgraphSpecOf } from '../src/engine/project-decompile.ts'
import { withVault } from './helpers/vault.ts'

const TWO_NODE_GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 25 }',
].join('\n')

const GOAL = '自学吉他：三个月弹会《野蜂飞舞》选段'

/** 注册笔记（vault 中心外个人笔记）+ 镜像区源清单（V-1 manifest；标题含检索词）。 */
const NOTE_FILES = [
  {
    path: 'notes/吉他练习.md',
    content: '# 吉他练习\n\n自学吉他的每日记录：爬格子与音阶练习是底座，目标是三个月弹会《野蜂飞舞》选段。\n',
  },
]
const NOTE_MANIFEST = [
  'sources:',
  '  - id: note-1',
  '    path: notes/吉他练习.md',
  '    fingerprint: abcdef1234567890',
  '    title: 吉他练习',
].join('\n')

/** 反编译 vault：注册笔记 + 源清单种子（其余走默认基线）。 */
const DECOMPILE_VAULT = {
  graph: TWO_NODE_GRAPH,
  notes: { 入门: {}, 进阶: {} },
  files: [...NOTE_FILES, { path: '学习中心/笔记源/源清单.yaml', content: NOTE_MANIFEST }],
}

/** 模型产出的反编译文档（plan 与 subgraph 双产物；合法形态）。 */
function decompileYaml(project: string, course: string): string {
  return `\
project: ${project}
plan:
  - id: m1
    name: 双手音阶连贯弹完
    task_class: 简：照谱复现
    acceptance_hints: C 大调两个八度双手连贯
    est: 600
    nodes: [数学/入门]
  - id: m2
    name: 完整弹会《野蜂飞舞》选段
    task_class: 繁：独立演绎
    acceptance_hints: 100 速度下完整弹完选段
    est: 900
subgraph:
  course: ${course}
  regions:
    - region: 演奏基础
      color: blue
      blocks:
        - name: 入手块
          nodes:
            - name: 持琴与手型
              pre: []
              opt: false
              note: 支撑 m1 的姿势底座
              est: 20
              enc: []
            - name: 音阶爬格
              pre: [持琴与手型]
              opt: false
              note: 支撑 m1 与 m2 的 daily 热身
              est: 25
              enc:
                - { node: 持琴与手型, w: 0.8 }
`
}

// ---- 纯函数 ----

test('decompileGoalOf：显式参数优先、回落项目档案 goal；空目标描述 fail loud', () => {
  assert.equal(decompileGoalOf('  自己的目标  ', '档案目标'), '自己的目标')
  assert.equal(decompileGoalOf(undefined, '档案目标'), '档案目标')
  assert.throws(() => decompileGoalOf('   ', '档案目标'), /目标描述为空/)
  assert.throws(() => decompileGoalOf(undefined, ''), /目标描述为空/)
})

test('decompileTerms：目标描述与笔记标题同炉 priorTerms（去重保序）', () => {
  const terms = decompileTerms('自学吉他：三个月弹会《野蜂飞舞》', ['吉他练习', '自学吉他'])
  assert.equal(terms[0], '自学吉他')
  assert.ok(terms.includes('吉他练习'))
  assert.ok(terms.includes('三个月弹会《野蜂飞舞》'))
  assert.equal(new Set(terms).size, terms.length, '去重')
})

test('splitDecompileDoc：双产物各自过既有 schema 门；错误行聚合一次给出', () => {
  const good = splitDecompileDoc(JSON.parse(JSON.stringify({
    project: '练琴计划',
    plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }],
    subgraph: {
      course: '数学',
      regions: [{ region: '甲', color: 'blue', blocks: [{ name: '块', nodes: [{ name: '节点一', pre: [], opt: false, note: '', est: 20 }] }] }],
    },
  })), '练琴计划')
  assert.equal(good.errors.length, 0)
  assert.equal(good.plan!.length, 1)
  assert.equal(good.subgraph!.course, '数学')
  assert.equal(good.subgraph!.regions[0].blocks[0].nodes[0].name, '节点一')

  // 计划半区：project 不一致（先行拒绝）；条目缺字段走 validatePlanItems 错误行
  const mismatch = splitDecompileDoc({ project: '别的项目', plan: [] }, '练琴计划')
  assert.ok(mismatch.errors.some(e => e.includes('project')))
  const badPlan = splitDecompileDoc({ project: '练琴计划', plan: [{ id: '', name: '', task_class: '', acceptance_hints: '' }] }, '练琴计划')
  assert.ok(badPlan.errors.some(e => e.includes('plan.1.id')))

  // 子图半区：regions 缺失 / 节点未知字段（parseNode 同门）
  const badSub = splitDecompileDoc({ project: '练琴计划', plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }], subgraph: { course: '数学' } }, '练琴计划')
  assert.ok(badSub.errors.some(e => e.includes('regions')))
  const badNode = splitDecompileDoc({
    project: '练琴计划',
    plan: [{ id: 'm1', name: '一', task_class: '简', acceptance_hints: '达标' }],
    subgraph: { course: '数学', regions: [{ region: '甲', blocks: [{ name: '块', nodes: [{ name: '坏', bogus: 1 }] }] }] },
  }, '练琴计划')
  assert.ok(badNode.errors.some(e => e.includes('未知字段')))

  // 顶层非映射
  assert.ok(splitDecompileDoc('not a map', '练琴计划').errors.length > 0)
})

test('subgraphSpecOf：显式目标课程 → append；缺省 → 模型自拟课程名 new（新课程骨架）', () => {
  assert.deepEqual(subgraphSpecOf({ course: '吉他', regions: [] }, '数学'), { course: '数学', mode: 'append' })
  assert.deepEqual(subgraphSpecOf({ course: '吉他', regions: [] }, undefined), { course: '吉他', mode: 'new' })
  assert.deepEqual(subgraphSpecOf({ course: '吉他', regions: [] }, '  '), { course: '吉他', mode: 'new' }, '空白课程名视同未给')
})

test('decompileRepairPrompt：修复轮携带原包 + 上次输出 + 逐条门禁清单', () => {
  const p = decompileRepairPrompt('原始包', '上次产出', ['  ✗ plan.1.name: 不能为空', '  ✗ regions: 不能为空'])
  assert.match(p, /原始包/)
  assert.match(p, /上次产出/)
  assert.match(p, /上一次输出未过双产物校验门/)
  assert.match(p, /plan\.1\.name/)
  assert.match(p, /regions/)
})

// ---- 入口退役契约（#138 / ADR-0033）----

test('入口退役：projectDecompile 随 gen 骨架提案退役，模型零调用、零提案', async () => {
  await withVault(DECOMPILE_VAULT, async ({ engine }) => {
    await engine.projectCreate({ name: '练琴计划', goal: GOAL })
    let calls = 0
    await assert.rejects(
      engine.projectDecompile('练琴计划', { course: '数学' }, async () => {
        calls++
        return decompileYaml('练琴计划', '吉他')
      }),
      /已随 gen 骨架提案退役/,
    )
    assert.equal(calls, 0, '退役在拼包前拒绝，不烧模型调用')
    assert.equal((await engine.store.loadProposals()).length, 0, '零提案')
  })
})
