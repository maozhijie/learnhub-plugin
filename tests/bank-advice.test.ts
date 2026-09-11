import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  B2_EASY_MIN_INTERVAL_DAYS, B2_EASY_MIN_REPS, B2_MASTERY_LOW, B2_NODE_MIN_ATTEMPTS,
  adviceDismissKey, calibrationAdvice, tooEasyAdvice,
} from '../src/engine/bank-advice.ts'
import { withVault } from './helpers/vault.ts'

/** 本文件课程图带 `bloom: 理解`（bloom 目标带断言的原料），与工厂默认图不同。 */
const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20, bloom: 理解 }',
].join('\n')

/** 题目行：stats 可播种（作答统计是检测的证据源之一）。
 * stats 用多行块式落盘，与工厂 tfQuestion 的 flow 式不同字节 → 保留本地实现。 */
function tfQuestion(id: string, opts: { attempts?: number; correct?: number } = {}): string[] {
  return [
    `  - id: ${id}`,
    '    kind: true_false',
    `    q: ${id} 题干：说法是否成立。`,
    '    answer: true',
    ...(opts.attempts !== undefined
      ? ['    stats:', `      attempts: ${opts.attempts}`, `      correct: ${opts.correct ?? 0}`]
      : []),
  ]
}

/** 「过于简单」门槛证据的 FSRS 块：零遗忘 + 间隔拉满。 */
function easyFsrs(opts: { reps?: number; lapses?: number; interval?: number } = {}): Record<string, string | number> {
  const interval = opts.interval ?? B2_EASY_MIN_INTERVAL_DAYS
  return {
    stability: 30, difficulty: 4,
    last_review: '2026-08-01', due: `2026-08-${String(1 + interval).padStart(2, '0')}`,
    reps: opts.reps ?? B2_EASY_MIN_REPS, lapses: opts.lapses ?? 0,
  }
}

// ---- 纯规则（接缝 S25）----

test('calibrationAdvice：四道守门（stage/作答量/Mastery/答错证据），低数据静默', () => {
  const base = { stage: 'review', attempts: 6, accuracy: 0.3, mastery: 0.4 }
  const hit = calibrationAdvice(base)
  assert.ok(hit, '全过 → 出建议')
  assert.equal(hit!.kind, 'difficulty_calibration')
  assert.match(hit!.reason, /掌握度低迷/)
  assert.match(hit!.instruction, /difficulty/)
  assert.match(hit!.instruction, /bloom 对准「理解」/, 'bloom 目标带来自节点声明')

  assert.equal(calibrationAdvice({ ...base, stage: 'learning' }), null, 'stage 守门：新学防饱和低值不误报')
  assert.equal(calibrationAdvice({ ...base, stage: 'ready' }), null)
  assert.equal(calibrationAdvice({ ...base, attempts: B2_NODE_MIN_ATTEMPTS - 1 }), null, '作答量门槛：低数据静默')
  assert.equal(calibrationAdvice({ ...base, mastery: B2_MASTERY_LOW }), null, 'Mastery 达阈值 → 静默')
  assert.equal(calibrationAdvice({ ...base, accuracy: 0.6 }), null, '无答错证据（作答正确率不低迷）→ 静默')
  assert.equal(calibrationAdvice({ ...base, accuracy: null }), null, '无作答记录 → 静默')
  assert.match(calibrationAdvice({ ...base, bloom: undefined })!.instruction, /「理解」/, 'bloom 缺省回退理解层')
})

test('tooEasyAdvice：调度证据口径——次数×零遗忘×间隔三关，任一不满足静默', () => {
  const q = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1', q: 'a1 题干', ...overrides,
  })
  const hit = tooEasyAdvice([q({ fsrs: easyFsrs(), stats: { attempts: 9, correct: 9 } })])
  assert.equal(hit.length, 1, '全部条件满足 → 出建议')
  assert.equal(hit[0]!.kind, 'too_easy')
  assert.equal(hit[0]!.reps, B2_EASY_MIN_REPS)
  assert.equal(hit[0]!.interval_days, B2_EASY_MIN_INTERVAL_DAYS)
  assert.match(hit[0]!.reason, /不自动移除/)
  assert.match(hit[0]!.stem, /a1 题干/, '带题面摘录（面板条目可直接认题）')

  assert.equal(tooEasyAdvice([q({ fsrs: easyFsrs({ reps: B2_EASY_MIN_REPS - 1 }), stats: { attempts: 9, correct: 9 } })]).length, 0,
    '推进次数不足（含合成初始化的 reps）→ 静默')
  assert.equal(tooEasyAdvice([q({ fsrs: easyFsrs({ lapses: 1 }), stats: { attempts: 9, correct: 8 } })]).length, 0,
    '有遗忘记录 → 静默')
  assert.equal(tooEasyAdvice([q({ fsrs: easyFsrs({ interval: B2_EASY_MIN_INTERVAL_DAYS - 1 }), stats: { attempts: 9, correct: 9 } })]).length, 0,
    '间隔未拉长（如同日连刷堆出来的次数）→ 静默')
  assert.equal(tooEasyAdvice([q({ fsrs: easyFsrs(), stats: { attempts: 9, correct: 8 } })]).length, 0,
    '终身统计有答错（同日重复不推 FSRS 但记 stats）→ 静默')
  assert.equal(tooEasyAdvice([q({ fsrs: easyFsrs() })]).length, 0,
    '无作答统计兜底 → 静默（合成建卡的卡不该只凭 reps 标注）')
  assert.equal(tooEasyAdvice([q({ archived: true, fsrs: easyFsrs(), stats: { attempts: 9, correct: 9 } })]).length, 0,
    '已归档跳过')
  assert.equal(tooEasyAdvice([q()]).length, 0, '未调度（无 fsrs）静默')
})

test('adviceDismissKey：course/node/qid 三元定位', () => {
  assert.equal(adviceDismissKey('数学', '入门', 'q1'), '数学/入门/q1')
})

// ---- 门面：只读检测、建议先行、忽略清单、新节点不误报 ----

test('review 期低掌握 + 答错证据 → 校准建议；调度证据全对的题 → 归档标注；零写入', async () => {
  await withVault({
    graph: GRAPH,
    notes: { 入门: { stage: 'review' } },
    banks: { 入门: [
      ...[1, 2, 3, 4, 5, 6].map(i => tfQuestion(`w${i}`, { attempts: 1, correct: 0 })),
      ['  - id: easy', '    kind: true_false', '    q: easy 题干：说法是否成立。', '    answer: true',
        '    stats: { attempts: 4, correct: 4 }',
        '    fsrs:',
        ...Object.entries(easyFsrs()).map(([k, v]) => `      ${k}: ${v}`)],
    ] },
  }, async ({ engine, root }) => {
    const snapshot = async () => {
      const out = new Map<string, unknown>()
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) { await walk(path); continue }
          const [info, bytes] = await Promise.all([stat(path), readFile(path)])
          out.set(resolve(relative(root, path).replace(/\\/g, '/')), {
            size: info.size, mtimeMs: info.mtimeMs,
            hash: createHash('sha256').update(bytes).digest('hex'),
          })
        }
      }
      await walk(root)
      return out
    }
    const before = await snapshot()
    const r = await engine.bank2.difficultyAdvice('数学') as { nodes: Array<Record<string, unknown>>; dismissed: number }
    const after = await snapshot()
    assert.deepEqual(after, before, '只读检测：建议先行，库与笔记零写入')

    assert.equal(r.nodes.length, 1)
    const entry = r.nodes[0]
    assert.equal(entry.node, '入门')
    assert.equal(r.dismissed, 0, '无忽略条目')
    const calibration = entry.calibration as { reason: string; instruction: string }
    assert.match(calibration.reason, /题面难度与目标带失衡/)
    assert.match(calibration.instruction, /bloom 对准「理解」/)
    const tooEasy = entry.too_easy as Array<{ qid: string; stem: string }>
    assert.deepEqual(tooEasy.map(t => t.qid), ['easy'], '调度证据全对的题出归档标注建议')
    assert.match(tooEasy[0]!.stem, /easy 题干/, '建议带题面摘录')
  })
})

test('忽略清单：dismiss 后建议不再出现（dismissed 计数带出），undo 恢复', async () => {
  await withVault({
    graph: GRAPH,
    notes: { 入门: { stage: 'review' } },
    banks: { 入门: [
      ['  - id: easy', '    kind: true_false', '    q: easy 题干。', '    answer: true',
        '    stats: { attempts: 9, correct: 9 }',
        '    fsrs:',
        ...Object.entries(easyFsrs()).map(([k, v]) => `      ${k}: ${v}`)],
    ] },
  }, async ({ engine }) => {
    const r1 = await engine.bank2.difficultyAdvice('数学') as { nodes: unknown[]; dismissed: number }
    assert.equal(r1.nodes.length, 1, '先出建议')

    await engine.bank2.adviceDismiss('数学', '入门', 'easy')
    const r2 = await engine.bank2.difficultyAdvice('数学') as { nodes: Array<Record<string, unknown>>; dismissed: number }
    assert.deepEqual(r2.nodes, [], '被忽略的建议不再出现')
    assert.equal(r2.dismissed, 1, 'dismissed 计数带出')

    await engine.bank2.adviceDismiss('数学', '入门', 'easy', true) // undo
    const r3 = await engine.bank2.difficultyAdvice('数学') as { nodes: unknown[]; dismissed: number }
    assert.equal(r3.nodes.length, 1, 'undo 后建议恢复')
    assert.equal(r3.dismissed, 0)

    // 同条幂等
    await engine.bank2.adviceDismiss('数学', '入门', 'easy')
    await engine.bank2.adviceDismiss('数学', '入门', 'easy')
    const r4 = await engine.bank2.difficultyAdvice('数学') as { dismissed: number }
    assert.equal(r4.dismissed, 1, '重复忽略不叠加')
  })
})

test('新节点全对一次（mastery 低但作答量低于门槛）不误报；学习期节点静默', async () => {
  // ready 节点：1 次全对，mastery 低是防饱和正常低值 → 两极都静默
  await withVault({
    graph: GRAPH,
    notes: { 入门: { stage: 'ready' } },
    banks: { 入门: [tfQuestion('a1', { attempts: 1, correct: 1 })] },
  }, async ({ engine }) => {
    const r = await engine.bank2.difficultyAdvice() as { nodes: unknown[] }
    assert.deepEqual(r.nodes, [], '低数据静默，不误报')
  })
  // learning 节点即使作答量够也静默（stage 守门）
  await withVault({
    graph: GRAPH,
    notes: { 入门: { stage: 'learning' } },
    banks: { 入门: [1, 2, 3, 4, 5, 6].map(i => tfQuestion(`w${i}`, { attempts: 1, correct: 0 })) },
  }, async ({ engine }) => {
    const r = await engine.bank2.difficultyAdvice() as { nodes: unknown[] }
    assert.deepEqual(r.nodes, [], 'learning 期低掌握是正常状态，不出校准建议')
  })
})
