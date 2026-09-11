import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from '../src/engine/paths.ts'
import { parseReflectionGrading, parseOpenGrading } from '../src/engine/grading.ts'
import { withVault } from './helpers/vault.ts'

// ---- 解析加固（#116.1）：markdown 围栏、外层散文、尾逗号、字符串分数 ----

test('parseReflectionGrading：围栏包裹 + 尾逗号 + 外层散文均可解析', () => {
  const fenced = '```json\n{"score": 0.8, "feedback": "覆盖了核心概念，",}\n```'
  assert.deepEqual(parseReflectionGrading(fenced), { score: 0.8, feedback: '覆盖了核心概念，' })
  const prose = '好的，以下是判卷结果：\n{"score": 0.7, "feedback": "基本正确。"}\n请参考。'
  assert.equal(parseReflectionGrading(prose).score, 0.7)
  const plain = '{"score": 0.6, "feedback": "及格。"}'
  assert.equal(parseReflectionGrading(plain).feedback, '及格。')
})

test('parseReflectionGrading：字符串分数安全数值化；非数值分数仍拒绝', () => {
  assert.equal(parseReflectionGrading('{"score": "0.75", "feedback": "x"}').score, 0.75)
  assert.throws(() => parseReflectionGrading('{"score": "high", "feedback": "x"}'), /missing score\/feedback/)
  assert.throws(() => parseReflectionGrading('{"score": 1.5, "feedback": "x"}'), /越界/)
  assert.throws(() => parseReflectionGrading('{"feedback": "只有反馈"}'), /missing score\/feedback/)
})

test('parseOpenGrading：围栏 + 字符串整数分数；小数分越界拒绝', () => {
  const fenced = '```json\n{"score": 7, "feedback": "逐点批改…",}\n```'
  assert.deepEqual(parseOpenGrading(fenced), { score: 7, feedback: '逐点批改…' })
  assert.equal(parseOpenGrading('{"score": "8", "feedback": "x"}').score, 8)
  assert.throws(() => parseOpenGrading('{"score": 7.5, "feedback": "x"}'), /越界/)
  assert.throws(() => parseOpenGrading('{"score": 11, "feedback": "x"}'), /越界/)
})

// ---- 引擎行为（#116.2/4）：解析失败自动重问一次 + 原始输出留痕；事务性保持 ----

/** reflection 题的原始题库 YAML（同 transactional-grading 口径）。 */
function bankText(kind: string, answer: string): string {
  return [
    'node: 入门',
    'questions:',
    `  - id: a1`,
    `    kind: ${kind}`,
    '    q: 用自己的话解释这个概念。',
    `    answer: ${answer}`,
  ].join('\n')
}

async function evidenceSnapshot(paths: Paths): Promise<Record<string, string | null>> {
  const read = async (p: string): Promise<string | null> => {
    try {
      return await readFile(p, 'utf8')
    } catch {
      return null
    }
  }
  return {
    bank: await read(join(paths.courseRoot('math'), '题库', '入门.yaml')),
    note: await read(join(paths.courseRoot('math'), '课程', '基础', '入门.md')),
    practice: await read(join(paths.centerStateDir, 'practice.jsonl')),
    journal: await read(join(paths.centerStateDir, 'journal.jsonl')),
  }
}

test('#116 重问成功：第一次解析失败自动重判一次，成功后正常落盘（单次作答证据）', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', fmExtra: ['mastery: 0'] } },
    banks: { 入门: `${bankText('reflection', '评分要点')}\n` },
  }, async ({ engine, paths }) => {
    const calls: string[] = []
    const ok = await engine.content2.questionAnswer(async prompt => {
      calls.push(prompt)
      if (calls.length === 1) return '抱歉，我无法以 JSON 输出。'
      return '```json\n{"score": 0.8, "feedback": "第二次判卷通过。",}\n```'
    }, '数学', '入门', 'a1', '我的完整回答', 30)
    assert.equal(calls.length, 2, '恰好重问一次')
    assert.match(calls[1]!, /只输出一个 JSON 对象/, '重问携带纠偏指令')
    assert.equal(ok.correct, true)
    assert.equal(ok.score, 80)
    const bank = await engine.bank.load(paths.courseRoot('math'), '入门')
    assert.equal(bank.questions[0]!.stats?.attempts, 1, '重试成功只记一次作答')
    assert.equal(bank.questions[0]!.fsrs?.reps, 1)
    // 留痕：失败那次的原始输出在案，成功路径也有留痕（attempt 1）
    assert.equal(existsSync(join(paths.centerStateDir, '判卷失败.jsonl')), true)
    const log = await readFile(join(paths.centerStateDir, '判卷失败.jsonl'), 'utf8')
    assert.match(log, /"attempt":1/)
    assert.match(log, /我无法以 JSON 输出/)
  })
})

test('#116 两次全失败：零落盘（事务性不变）+ 两次原始输出留痕带题目定位', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', fmExtra: ['mastery: 0'] } },
    banks: { 入门: `${bankText('open_question', '参考要点')}\n` },
  }, async ({ engine, paths }) => {
    const before = await evidenceSnapshot(paths)
    let calls = 0
    await assert.rejects(
      () => engine.content2.questionAnswer(async () => {
        calls++
        return '这是被 max-tokens 截断的断尾 JSON：{"score": 1'
      }, '数学', '入门', 'a1', '开放题回答', 30),
      /AI 判卷输出不可用.*未记录/s,
    )
    assert.equal(calls, 2, '重问一次后放弃')
    const after = await evidenceSnapshot(paths)
    assert.deepEqual(after, before, 'grading failure must leave bank/note/practice/journal untouched')
    const log = await readFile(join(paths.centerStateDir, '判卷失败.jsonl'), 'utf8')
    const lines = log.trim().split('\n')
    assert.equal(lines.length, 2, '两次尝试各留一条')
    for (const line of lines) {
      const rec = JSON.parse(line) as { course: string; node: string; qid: string; attempt: number; raw: string }
      assert.equal(rec.course, '数学')
      assert.equal(rec.node, '入门')
      assert.equal(rec.qid, 'a1')
      assert.match(rec.raw, /截断的断尾 JSON/)
    }
  })
})

test('#116 规则判卷题型不受影响（不触发重问与留痕）', async () => {
  await withVault({
    notes: { 入门: { stage: 'ready', fmExtra: ['mastery: 0'] } },
    banks: { 入门: [
      'node: 入门',
      'questions:',
      '  - id: a1',
      '    kind: true_false',
      '    q: 判断题。',
      '    answer: true',
    ].join('\n') },
  }, async ({ engine, paths }) => {
    let calls = 0
    const r = await engine.content2.questionAnswer(async () => {
      calls++
      return '不应被调用'
    }, '数学', '入门', 'a1', 'true', 30)
    assert.equal(calls, 0, 'true_false 走规则判卷，零模型调用')
    assert.equal(r.correct, true)
    assert.equal(existsSync(join(paths.centerStateDir, '判卷失败.jsonl')), false)
  })
})
