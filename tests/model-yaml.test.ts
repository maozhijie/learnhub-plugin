/**
 * 模型 YAML 解析边界（parseModel）：
 * - 机器块串味容忍：正文管线的 <!-- enc_candidates --> 契约经上下文包/vault 摘录示范
 *   给模型后会串味进 YAML 输出（大纲站两连败的签名），忠实解析已败时剥注释重试救回，
 *   onTolerated 留痕；合法输出零影响（不触发剥除路径）。
 * - 引号感知：单引号标量内的 <!-- 不是注释，不剥。
 * - 死育人话化：剥后仍败抛稳定码 MODEL_YAML + 中文前缀，原始定位保留。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { YAML } from '../src/engine/yaml.ts'

test('parseModel：行尾/整行机器块串味，忠实解析败后剥注释救回并留痕', () => {
  const polluted = [
    'node: 一元一次方程',
    'sections:',
    '  - id: s1',
    "    title: '概念：未知数'  <!-- enc_candidates: [] -->",
    '  - id: s2',
    '    title: 例题：代入检验',
    '<!-- enc_candidates: [代数式] -->',
  ].join('\n')
  const notes: string[] = []
  const doc = YAML.parseModel(polluted, { onTolerated: n => { notes.push(n) } }) as { sections: Array<{ id: string }> }
  assert.deepEqual(doc.sections.map(s => s.id), ['s1', 's2'])
  assert.equal(notes.length, 1, '救回必须留痕（不静默）')
})

test('parseModel：纯前缀 plain scalar 后的行尾机器块同样救回', () => {
  // 无引号前缀：机器块混进 plain scalar 行，截断到 <!-- 前即恢复合法
  const doc = YAML.parseModel('title: 概念：变量 <!-- enc_candidates: [] -->') as { title: string }
  assert.equal(doc.title, '概念：变量')
})

test('parseModel：跨行机器块整段剥除，中间行不残留为 YAML 键', () => {
  const notes: string[] = []
  const polluted = [
    'node: X',
    'sections:',
    '  - id: s1',
    '    title: 概念：A',
    '<!-- enc_candidates:',
    '  代数式、方程',
    '-->',
  ].join('\n')
  const doc = YAML.parseModel(polluted, { onTolerated: n => { notes.push(n) } }) as { sections: Array<{ id: string }> }
  assert.deepEqual(doc.sections.map(s => s.id), ['s1'], '剥除后中间行不残留为杂键')
  assert.equal(notes.length, 1)
})

test('parseModel：未闭合注释剥到串尾', () => {
  const doc = YAML.parseModel('node: X\nsections: []\n<!-- enc_candidates: [代数式')  as { sections: unknown[] }
  assert.deepEqual(doc.sections, [])
})

test('parseModel：合法 YAML 不走剥除路径，onTolerated 不触发', () => {
  const notes: string[] = []
  const doc = YAML.parseModel('a: 1\nb: [x, y]\n', { onTolerated: n => { notes.push(n) } }) as { a: number }
  assert.equal(doc.a, 1)
  assert.equal(notes.length, 0)
})

test('parseModel：单引号标量内的 <!-- 不是注释，不剥（引号感知）', () => {
  const notes: string[] = []
  // 该文本本身合法：忠实解析直接成功，剥除路径不触发、引号内文本原样保留
  const doc = YAML.parseModel("q: '用 <!-- 标记包裹'  # 合法标量\n", { onTolerated: n => { notes.push(n) } }) as { q: string }
  assert.equal(doc.q, '用 <!-- 标记包裹')
  assert.equal(notes.length, 0)
})

test('parseModel：剥后仍败 → 抛 MODEL_YAML 稳定码 + 中文前缀，原始定位保留', () => {
  // 结构坏在注释之外（缩进错），剥注释救不回
  const bad = 'sections:\n  - id: s1\n title: 缩进错 <!-- enc_candidates: [] -->'
  try {
    YAML.parseModel(bad)
    assert.fail('应当抛出')
  } catch (err) {
    const e = err as Error & { code?: string }
    assert.equal(e.code, 'MODEL_YAML')
    assert.match(e.message, /模型输出不是合法 YAML/)
    assert.match(e.message, /Unexpected scalar|bad indentation|映射|缩进/, '原始 yaml 库定位信息保留')
  }
})

test('parseModel：代码围栏容忍保持既有行为（回归）', () => {
  const doc = YAML.parseModel('```yaml\nnode: X\nsections: []\n```') as { node: string }
  assert.equal(doc.node, 'X')
})
