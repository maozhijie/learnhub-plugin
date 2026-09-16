/**
 * 提示词渲染器门（#237 / ADR-0075）：`{{var}}` 占位符的取值必须有唯一的严格口径——缺变量
 * 与「值自带占位符」都必须变红，且**挖空数据不得被误判**（`{{…}}`／`{{答案}}` 是学习者
 * 卡面的 cloze 语法，会作为值流进提示词；把它当残留抛错会让自注讲解对合法输入炸掉）。
 *
 * 门带自检（ADR-0047 铁律①）：正样本（正常替换、数字、重复占位、无占位符）与反样本
 * （缺变量、值非文本、值自带标识符形态的占位符）各成用例；挖空形态另有一条反向用例，
 * 保证「收窄口径」这一条不是注释里的空话——放宽成「任何 {{…}}」时它会红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { render } from '../src/engine/infra/prompt-render.ts'

test('render：替换字符串与数字占位符', () => {
  assert.equal(render('辅导 {{node}} 第 {{n}} 节', { node: '极限', n: 3 }), '辅导 极限 第 3 节')
})

test('render：同一占位符出现多次都替换', () => {
  assert.equal(render('{{a}}-{{a}}-{{a}}', { a: 'x' }), 'x-x-x')
})

test('render：无占位符的模板原样返回', () => {
  assert.equal(render('只输出 YAML。', {}), '只输出 YAML。')
})

test('render：多余变量不抛（模板没用到就是没用到）', () => {
  assert.equal(render('正文 {{body}}', { body: 'ok', unused: 'ignored' }), '正文 ok')
})

test('render：缺变量抛错，且消息点名占位符与已传键', () => {
  assert.throws(() => render('{{need}} 缺失', { other: 'x' }), /缺变量 \{\{need\}\}.*已传：other/)
})

test('render：空变量表 + 模板要变量 → 抛错', () => {
  assert.throws(() => render('{{need}}', {}), /缺变量 \{\{need\}\}.*已传：无/)
})

test('render：变量值不是字符串或数字 → 抛错', () => {
  assert.throws(() => render('{{v}}', { v: null as unknown as string }), /不是字符串或数字/)
})

test('render：值自带标识符形态的占位符 → 抛残留（模型会读到原文）', () => {
  assert.throws(() => render('{{v}}', { v: '含 {{leaked}} 的值' }), /渲染后残留占位符 \{\{leaked\}\}/)
})

test('render：挖空形态的值原样通过，不判残留（cloze 语法是数据不是占位符）', () => {
  assert.equal(render('{{v}}', { v: '把 {{答案}} 挖空，或写 {{…}}' }), '把 {{答案}} 挖空，或写 {{…}}')
})

test('render：非标识符形态的花括号原样通过（JSON 示例、对象字面量散文）', () => {
  assert.equal(render('{{v}}', { v: '{{ light: 1 }} 与 {"a":{"b":1}}' }), '{{ light: 1 }} 与 {"a":{"b":1}}')
})

test('render：值里的 Anki 模板语法 {{frontside}} 是标识符形态 → 抛（设计如此）', () => {
  assert.throws(() => render('{{v}}', { v: '{{frontside}}<hr>{{答案}}' }), /残留占位符 \{\{frontside\}\}/)
})
