import test from 'node:test'
import assert from 'node:assert/strict'
import { Content } from '../src/engine/content.ts'

// ---- v6 提示词契约（#14 P2/P3）：版本标记 + 复杂度档案锚点 ----

test('P2: 五个内置模板全部升到 prompt/v6', () => {
  for (const kind of Object.keys(Content.PROMPT_KINDS)) {
    const text = Content.PROMPT_KINDS[kind]!
    assert.ok(Content.promptVersionOf(text) >= 6, `${kind} 应升到 v6+`)
  }
})

test('P2: 大纲模板节数锚定改指上下文包 §9（不再写死"通常 3-8 节"）', () => {
  const tpl = Content.PROMPT_KINDS['课程大纲']!
  assert.match(tpl, /复杂度档案/)
  assert.match(tpl, /目标节段数区间/)
  assert.doesNotMatch(tpl, /通常 3–8 节/)
})

test('P2: 节生成模板文字预算与可视化引导改指上下文包 §9（不再写死 ≤150 字）', () => {
  const tpl = Content.PROMPT_KINDS['课程节生成']!
  assert.match(tpl, /复杂度档案/)
  assert.match(tpl, /大多数节段配一个主体可视化/)
  assert.doesNotMatch(tpl, /文字只做引导与衔接（≤150 字）/)
})

test('P2: 风格变体模板同步 v6 锚点（与默认模板同口径）', () => {
  for (const kind of ['课程节生成-苏格拉底', '课程节生成-费曼'] as const) {
    const tpl = Content.PROMPT_KINDS[kind]!
    assert.match(tpl, /复杂度档案/, `${kind} 应指向 §9 锚点`)
  }
})

// ---- P-5 目标反编译模板（#95）：版本标记 + 双产物输出契约 + 先验注入指令 ----

test('P5: 项目目标反编译模板——版本标记、plan/subgraph 双产物契约、Vault 先验注入指令', () => {
  const tpl = Content.PROMPT_KINDS['项目目标反编译']!
  assert.ok(Content.promptVersionOf(tpl) >= 6, '项目目标反编译 应带版本标记 v6+')
  assert.match(tpl, /project: <项目 id/, 'plan 半区 = #92 的 PlanArtifact 契约')
  assert.match(tpl, /acceptance_hints/, '计划条目字段按设计 §3')
  assert.match(tpl, /subgraph:/, '子图半区 = 图谱域 gen regions 形态')
  assert.match(tpl, /enc:/, '子图节点可挂成分技能边')
  assert.match(tpl, /学习者已有理解（Vault 先验）/, '先验段注入指令（尊重已有理解，不从零铺已会节点）')
  assert.match(tpl, /提案/, '双产物走人审提案通道（apply 前零 canonical 写入）')
})
