import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanupCandidatesForNode } from '../src/engine/bank-cleanup.ts'
import { withVault, tfQuestion } from './helpers/vault.ts'

// ---- 纯规则 ----

test('cleanupCandidatesForNode：skipped 收全部未归档；completed 只收休眠题；其他 stage 空', () => {
  const qs = [
    { id: 'q1' },                          // 休眠
    { id: 'q2', fsrs: { reps: 1 } },       // 已调度
    { id: 'q3', archived: true },          // 已归档
    { id: 'q4', archived: true, fsrs: { reps: 3 } },
  ]
  assert.deepEqual(cleanupCandidatesForNode('skipped', qs), [
    { qid: 'q1', reason: 'skipped_node' }, { qid: 'q2', reason: 'skipped_node' },
  ], '跳过节点：全部未归档题入候选（无论调度与否）')

  assert.deepEqual(cleanupCandidatesForNode('review', qs), [{ qid: 'q1', reason: 'dormant_after_complete' }],
    '已完成节点：只收从未调度的休眠题')
  assert.deepEqual(cleanupCandidatesForNode('mastered', qs), [{ qid: 'q1', reason: 'dormant_after_complete' }])

  assert.deepEqual(cleanupCandidatesForNode('learning', qs), [], 'learning 期休眠题是正常状态，不清理')
  assert.deepEqual(cleanupCandidatesForNode('ready', qs), [])
  assert.deepEqual(cleanupCandidatesForNode(undefined, qs), [])
})

// ---- 门面：预览/应用（归档可逆不删除）、reason 记录、nodeSkip 自动归档 ----

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20 }',
  '      - { name: 进阶, pre: [入门], opt: false, note: "", est: 20 }',
].join('\n')

const scheduled = (reps = 2) => ({
  stability: 5, difficulty: 5, last_review: '2026-09-01', due: '2026-09-08', reps, lapses: 0,
})

test('bankCleanupPreview/Apply：skipped 节点收全部、review 节点只收休眠题；归档带 reason=cleanup', async () => {
  await withVault({
    graph: GRAPH,
    notes: {
      入门: { stage: 'skipped' },
      进阶: { stage: 'review' },
    },
    banks: {
      入门: [
        tfQuestion('k1'),                       // 休眠 → skipped 收
        tfQuestion('k2', { fsrs: scheduled() }), // 已调度 → skipped 也收
      ],
      进阶: [
        tfQuestion('d1'),                        // 休眠 → 收
        tfQuestion('d2', { fsrs: scheduled() }), // 已调度 → 留
        tfQuestion('d3', { archived: true }),    // 已归档 → 留
      ],
    },
  }, async ({ engine, paths }) => {
    const preview = await engine.bank2.bankCleanupPreview('数学')
    assert.equal(preview.total, 3, 'k1/k2（跳过节点）+ d1（休眠题）')
    const byNode = new Map(preview.groups.map(g => [g.node, g]))
    assert.deepEqual(byNode.get('入门'), {
      course: '数学', node: '入门', stage: 'skipped', count: 2,
      reasons: { skipped_node: 2, dormant_after_complete: 0 },
      stems: byNode.get('入门')!.stems,
    }, '跳过节点分组（skipped_node 规因）')
    assert.equal(byNode.get('进阶')!.count, 1)
    assert.deepEqual(byNode.get('进阶')!.reasons, { skipped_node: 0, dormant_after_complete: 1 })
    assert.ok(byNode.get('进阶')!.stems.length === 1, '题面样本带出')

    const applied = await engine.bank2.bankCleanupApply('数学')
    assert.equal(applied.reduce((s, g) => s + g.archived, 0), 3)

    // 归档可逆：archived_reason=cleanup 落盘，恢复时一并清除
    const bankFile = join(paths.courseRoot('math'), '题库', '进阶.yaml')
    const text = await readFile(bankFile, 'utf8')
    assert.match(text, /id: d1[\s\S]*?archived: true[\s\S]*?archived_reason: cleanup/)
    const d2Block = text.split('id: d2')[1]?.split('id: d3')[0] ?? ''
    assert.ok(!d2Block.includes('archived'), '已调度的题不被清理（d2 无 archived 块）')

    // 恢复单题：archived 与 reason 一并清除
    await engine.bank2.questionArchive('数学', '进阶', 'd1', false)
    const restored = await readFile(bankFile, 'utf8')
    assert.doesNotMatch(restored, /archived_reason/, '恢复时归档原因一并清除')

    // 再跑预览：d1 恢复成在库休眠题重新成为候选；k1/k2/d3 已归档不再入候选
    const after = await engine.bank2.bankCleanupPreview('数学')
    assert.deepEqual(after.groups.map(g => g.node), ['进阶'], '只剩进阶的 d1 一个候选')
    assert.equal(after.groups[0]!.count, 1)
  })
})

test('nodeSkip：跳过时该节点全部未归档题自动归档（reason=skip），unskip 不自动恢复', async () => {
  await withVault({
    graph: GRAPH,
    notes: { 入门: { stage: 'learning' }, 进阶: { stage: 'ready' } },
    banks: {
      入门: [
        tfQuestion('s1'),
        tfQuestion('s2', { fsrs: scheduled() }),
        ['  - id: s3', '    kind: true_false', '    q: s3 题干：说法是否成立。', '    answer: true',
          '    archived: true', '    archived_reason: manual'],
      ],
    },
  }, async ({ engine, paths }) => {
    const r = await engine.sched2.nodeSkip('数学', '入门', true)
    assert.equal(r.stage, 'skipped')
    assert.equal(r.archived, 2, 's1/s2 归档，已归档的 s3 不动')

    const bankFile = join(paths.courseRoot('math'), '题库', '入门.yaml')
    const text = await readFile(bankFile, 'utf8')
    assert.match(text, /id: s1[\s\S]*?archived: true[\s\S]*?archived_reason: skip/)
    assert.match(text, /archived_reason: manual/, '既有归档原因不被覆盖')

    // unskip：stage 回 ready，题目保持归档（恢复是显式动作）
    await engine.sched2.nodeSkip('数学', '入门', false)
    const after = await readFile(bankFile, 'utf8')
    assert.match(after, /id: s1[\s\S]*?archived: true/, '取消跳过不自动恢复')

    // skipped 节点的题进一键清理预览（含未恢复的 s1/s2）
    const preview = await engine.bank2.bankCleanupPreview('数学')
    assert.equal(preview.total, 0, 's1/s2 已归档，无新增候选；s3 已归档')
  })
})
