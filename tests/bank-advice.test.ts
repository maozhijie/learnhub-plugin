import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { LearnhubEngine } from '../src/engine/index.ts'
import { B2_EASY_MIN_ATTEMPTS, B2_MASTERY_LOW, B2_NODE_MIN_ATTEMPTS, calibrationAdvice, tooEasyAdvice } from '../src/engine/bank-advice.ts'

const REGISTRY = [
  'courses:',
  '  - id: math-01',
  '    name: 数学',
  '    root: math',
  '    enabled: true',
].join('\n')

const GRAPH = [
  'region: 基础',
  'color: blue',
  'blocks:',
  '  - name: 入门块',
  '    nodes:',
  '      - { name: 入门, pre: [], opt: false, note: "", est: 20, bloom: 理解 }',
].join('\n')

function note(stage: string): string {
  return [
    '---',
    'node: 入门',
    `stage: ${stage}`,
    'fsrs: null',
    'content:',
    '  version: 0',
    '  generated_at: null',
    '  status: draft',
    'practice:',
    '  attempts: 0',
    '  correct: 0',
    '---',
    '',
    '# 入门',
  ].join('\n')
}

/** 题目行：stats 可播种（作答统计是检测的证据源）。 */
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

async function withVault(
  stage: string,
  questions: string[][],
  run: (engine: LearnhubEngine, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'learnhub-b2-'))
  try {
    const center = join(root, '学习中心')
    const course = join(center, 'math')
    await mkdir(join(course, 'data'), { recursive: true })
    await mkdir(join(course, '课程', '基础'), { recursive: true })
    await mkdir(join(course, '题库'), { recursive: true })
    await writeFile(join(center, '课程注册表.yaml'), `${REGISTRY}\n`, 'utf8')
    await writeFile(join(course, 'data', '基础.yaml'), `${GRAPH}\n`, 'utf8')
    await writeFile(join(course, '课程', '基础', '入门.md'), `${note(stage)}\n`, 'utf8')
    await writeFile(
      join(course, '题库', '入门.yaml'),
      ['node: 入门', 'questions:', ...questions.flat()].join('\n') + '\n',
      'utf8',
    )
    await run(new LearnhubEngine({ vault: root }), root)
  } finally {
    await rm(root, { recursive: true, force: true })
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

test('tooEasyAdvice：单题全对且作答量达门槛才标注，已归档跳过', () => {
  const hit = tooEasyAdvice([
    { id: 'a1', stats: { attempts: B2_EASY_MIN_ATTEMPTS, correct: B2_EASY_MIN_ATTEMPTS } },
    { id: 'a2', stats: { attempts: B2_EASY_MIN_ATTEMPTS - 1, correct: B2_EASY_MIN_ATTEMPTS - 1 } },
    { id: 'a3', stats: { attempts: 5, correct: 4 } },
    { id: 'a4', archived: true, stats: { attempts: 9, correct: 9 } },
  ])
  assert.deepEqual(hit.map(h => h.qid), ['a1'], '只有全对且量足的未归档题出建议')
  assert.equal(hit[0].kind, 'too_easy')
  assert.match(hit[0].reason, /不自动移除/)
})

// ---- 门面：只读检测、建议先行、新节点不误报 ----

test('review 期低掌握 + 答错证据 → 校准建议；全对题 → 归档标注；零写入', async () => {
  await withVault('review', [
    ...[1, 2, 3, 4, 5, 6].map(i => tfQuestion(`w${i}`, { attempts: 1, correct: 0 })),
    tfQuestion('easy', { attempts: 4, correct: 4 }),
  ], async (engine, root) => {
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
    const r = await engine.difficultyAdvice('数学') as { nodes: Array<Record<string, unknown>> }
    const after = await snapshot()
    assert.deepEqual(after, before, '只读检测：建议先行，库与笔记零写入')

    assert.equal(r.nodes.length, 1)
    const entry = r.nodes[0]
    assert.equal(entry.node, '入门')
    const calibration = entry.calibration as { reason: string; instruction: string }
    assert.match(calibration.reason, /题面难度与目标带失衡/)
    assert.match(calibration.instruction, /bloom 对准「理解」/)
    const tooEasy = entry.too_easy as Array<{ qid: string }>
    assert.deepEqual(tooEasy.map(t => t.qid), ['easy'], '全对题归档标注建议')
  })
})

test('新节点全对一次（mastery 低但作答量低于门槛）不误报；学习期节点静默', async () => {
  // ready 节点：1 次全对，mastery 低是防饱和正常低值 → 两极都静默
  await withVault('ready', [tfQuestion('a1', { attempts: 1, correct: 1 })], async engine => {
    const r = await engine.difficultyAdvice() as { nodes: unknown[] }
    assert.deepEqual(r.nodes, [], '低数据静默，不误报')
  })
  // learning 节点即使作答量够也静默（stage 守门）
  await withVault('learning', [
    ...[1, 2, 3, 4, 5, 6].map(i => tfQuestion(`w${i}`, { attempts: 1, correct: 0 })),
  ], async engine => {
    const r = await engine.difficultyAdvice() as { nodes: unknown[] }
    assert.deepEqual(r.nodes, [], 'learning 期低掌握是正常状态，不出校准建议')
  })
})
