/** 文案语义锁门自检（#207 / ADR-0047 铁律）：L1 纯函数层——判据本体（copy-lock
 * 助手）的正反两向都必须真的会红，解析器必须看得见真实 CONTEXT.md 的目标词条
 * （R3 教训：收集器恒过比没有门更坏）。语境落地的三条常驻锁在
 * tests/ui-pages-dom.test.ts「文案语义锁」段（沙盘/掌握度/休眠题）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadGlossary, lockCopy } from './helpers/copy-lock.ts'

const 沙盘 = '沙盘（Sandbox）'
const 掌握度 = 'Mastery（掌握度）'
const 休眠题 = '休眠题（Dormant Question）'

// ---- 收集器可见性：解析真实 CONTEXT.md（词表唯一出处）----

test('词表解析：真实 CONTEXT.md 里沙盘/掌握度/休眠题词条都看得见、词形正确', () => {
  const byHeader = new Map(loadGlossary().map(e => [e.header, e]))
  const sandbox = byHeader.get(沙盘)
  assert.ok(sandbox, '沙盘词条必须解析得到（词条名逐字对上）')
  assert.deepEqual(sandbox.canonical, ['沙盘'])
  assert.ok(sandbox.avoid.includes('预测沙盘') && sandbox.avoid.includes('可行性判定'),
    '沙盘 Avoid 词必须被收集（非承诺措辞锁之外的机械反断言面）')
  assert.deepEqual(sandbox.avoidContextual, ['模拟', '推演'],
    '「单独使用」括注项归入不机械执法面（「模型推演」合法形不误咬）')

  const mastery = byHeader.get(掌握度)
  assert.ok(mastery, '掌握度词条必须解析得到')
  for (const w of ['熟练度', '分数', '进度', '正确率']) assert.ok(mastery.avoid.includes(w), `掌握度 Avoid 缺「${w}」`)

  const dormant = byHeader.get(休眠题)
  assert.ok(dormant, '休眠题词条必须解析得到')
  assert.ok(dormant.avoid.includes('未调度题') && dormant.avoid.includes('死题'),
    '休眠题 Avoid 含「未调度题/死题」——「未调度」列名许可是子串不含，不冲突')

  const count = byHeader.size
  assert.ok(count >= 25, `词条收集量可疑（${count} 条），解析器可能漏条目`)
})

test('词表解析：括注里的「、」不被误切；无中文形的词条取原名', () => {
  const byHeader = new Map(loadGlossary().map(e => [e.header, e]))
  const accuracy = [...byHeader.values()].find(e => e.header.startsWith('Answer Accuracy'))
  assert.ok(accuracy, 'Answer Accuracy 词条解析得到')
  assert.ok(accuracy.avoid.includes('掌握度'), '括注内顿号不误切（「正确率（单独使用易与 Mastery 混）」是一条）')
  assert.ok(byHeader.has('XP'), '无中文形词条（XP）取原名')
})

// ---- 判据本体：正反两向都真的会红（ADR-0047 自检）----

test('正断言：缺 canonical 词 → 红', () => {
  assert.throws(() => lockCopy('沙盘 · 计划推演', { canonical: ['沙盘', '非承诺'] }), /非承诺/)
  lockCopy('沙盘 · 计划推演，模型推演，非承诺', { canonical: ['沙盘', '非承诺'] })
})

test('反断言：Avoid 词出现 → 红', () => {
  assert.throws(
    () => lockCopy('掌握度卡误写熟练度 90%', { canonical: ['掌握度'], glossary: 掌握度 }),
    /熟练度/,
  )
  lockCopy('节点掌握度 40%', { canonical: ['掌握度'], glossary: 掌握度 })
})

test('遮蔽规则：canonical 合成形（作答正确率）不触发 Avoid 子串（正确率）', () => {
  lockCopy('作答正确率只用于完成门禁，不是掌握度展示', { canonical: ['掌握度'], glossary: 掌握度 })
  assert.throws(
    () => lockCopy('掌握度区误写裸正确率', { canonical: ['掌握度'], glossary: 掌握度 }),
    /正确率/,
  )
})

test('休眠题：列名「未调度」许可（词条明文），「未调度题」仍拦', () => {
  lockCopy('到期列为「未调度」的一键清理休眠题', { canonical: ['休眠题'], glossary: 休眠题 })
  assert.throws(
    () => lockCopy('休眠题列表标题写成未调度题清单', { canonical: ['休眠题'], glossary: 休眠题 }),
    /未调度题/,
  )
})

test('allow 豁免与未知词条 fail loud', () => {
  assert.throws(
    () => lockCopy('清理休眠题时把标题写成「未调度题」（引用违禁词）', { canonical: ['休眠题'], glossary: 休眠题 }),
    /未调度题/,
  )
  lockCopy('清理休眠题时把标题写成「未调度题」（引用违禁词）', { canonical: ['休眠题'], glossary: 休眠题, allow: ['未调度题'] })
  assert.throws(
    () => lockCopy('任意文本', { canonical: ['任意'], glossary: '不存在的词条' }),
    /不存在的词条/,
  )
})

test('元素作用域：取 textContent（与字符串同判据）', () => {
  const el = { textContent: '沙盘 · 计划推演 非承诺' }
  lockCopy(el, { canonical: ['沙盘', '非承诺'], glossary: 沙盘 })
  const bad = { textContent: '这是预测沙盘' }
  assert.throws(() => lockCopy(bad, { canonical: ['沙盘'], glossary: 沙盘 }), /预测沙盘/)
})
