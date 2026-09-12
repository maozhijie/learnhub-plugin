/** 轮次计划纯模块单测（L1，#183）：buildRounds 的节序列装配口径。
 * 被测模块：`ui/src/lib/rounds.ts`（自 PracticeFlow 抽出的纯逻辑——manifest 驱动
 * 节序列、旧节点标题匹配回退、未落节题收综合轮）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRounds } from '../ui/src/lib/rounds.ts'
import type { LessonSection, QuestionItem, SectionManifestItem } from '../ui/src/types.ts'

const section = (title: string, md = '正文'): LessonSection => ({ title, md })
const q = (id: string, sectionTitle?: string): QuestionItem => ({
  id, kind: 'single_choice', q: `题 ${id}`, difficulty: 0.5,
  options: [], answer: 'A', explanation: '', section: sectionTitle,
} as unknown as QuestionItem)

test('manifest 驱动：内容节 = 读节 + 题轮成对，步以题轮为过关判据', () => {
  const manifest: SectionManifestItem[] = [
    { id: 's1', title: '概念：等差数列', type: '概念' },
    { id: 's2', title: '概念：通项公式', type: '概念' },
  ]
  const sections = [section('概念：等差数列'), section('概念：通项公式')]
  const questions = [q('q1', 's1'), q('q2', '概念:等差数列'), q('q3', 's2')]
  const { rounds, steps } = buildRounds(sections, manifest, questions)
  // s1：绑节 id 一题 + 归一化标题回退一题（全半角冒号差异不漏题）→ read + quiz
  assert.deepEqual(rounds.map(r => r.key), ['read:s1', 'quiz:s1', 'read:s2', 'quiz:s2'])
  assert.equal(rounds[1]!.questions!.length, 2)
  assert.deepEqual(steps.map(s => s.key), ['s1', 's2'])
  assert.equal(steps[0]!.quizKey, 'quiz:s1')
  assert.equal(steps[0]!.start, 0)
  assert.equal(steps[1]!.start, 2)
})

test('练习节一等化：无阅读轮直接做题；无题不出轮', () => {
  const manifest: SectionManifestItem[] = [
    { id: 'p1', title: '练习：求和', type: '练习' },
    { id: 'p2', title: '练习：应用', type: '练习' },
  ]
  const { rounds, steps } = buildRounds([], manifest, [q('q9', 'p1')])
  assert.deepEqual(rounds.map(r => r.key), ['quiz:p1'])
  assert.equal(rounds[0]!.type, 'quiz')
  assert.deepEqual(steps.map(s => s.key), ['p1'])
})

test('交互节：md 存在才出交互轮，无题也进步（读完即过）', () => {
  const manifest: SectionManifestItem[] = [{ id: 'ix1', title: '交互：单摆', type: '交互' }]
  const withMd = buildRounds([section('交互：单摆')], manifest, [])
  assert.deepEqual(withMd.rounds.map(r => r.type), ['interactive'])
  assert.equal(withMd.rounds[0]!.sectionId, 'ix1')
  assert.equal(withMd.steps[0]!.quizKey, null)
  // 无正文：不出交互轮（无可渲染内容），但步仍在（该节不产出可作答轮）
  const noMd = buildRounds([], manifest, [])
  assert.deepEqual(noMd.rounds, [])
  assert.deepEqual(noMd.steps.map(s => s.key), ['ix1'])
  assert.equal(noMd.steps[0]!.quizKey, null)
})

test('旧节点回退：无 manifest 按标题精确/归一化匹配；未落节题进综合轮', () => {
  const sections = [section('概念：数列'), section('概念：极限')]
  const questions = [
    q('q1', '概念：数列'),
    q('q2', '概念:  数列'), // 归一化后同节
    q('q3', '通用'),
  ]
  const { rounds, steps } = buildRounds(sections, null, questions)
  assert.deepEqual(rounds.map(r => r.key), ['read:概念：数列', 'quiz:概念：数列', 'read:概念：极限', 'quiz:generic'])
  assert.equal(rounds[1]!.questions!.length, 2)
  // q3 未落节 → 综合轮收尾
  assert.equal(rounds[3]!.title, '综合')
  assert.equal(rounds[3]!.questions!.length, 1)
  assert.deepEqual(steps.map(s => s.key), ['概念：数列', '概念：极限', 'quiz:generic'])
})

test('「通用」标注：manifest 分支不参与标题归一化匹配（直进综合轮）', () => {
  const manifest: SectionManifestItem[] = [{ id: 's1', title: '概念：数列', type: '概念' }]
  const { rounds } = buildRounds([section('概念：数列')], manifest, [q('q1', '通用'), q('q2', '通用')])
  // manifest 分支排除 section='通用' 的题（防「通用」误吞进内容节）——全部进综合轮
  assert.deepEqual(rounds.map(r => r.key), ['read:s1', 'quiz:generic'])
  const generic = rounds.find(r => r.key === 'quiz:generic')!
  assert.equal(generic.questions!.length, 2)
})
