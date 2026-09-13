import test from 'node:test'
import assert from 'node:assert/strict'
import { Content } from '../src/engine/content.ts'
import { validateBank } from '../src/engine/question-bank.ts'

// ---- S5 checkSectionShape:节形状门（阈值从档位预算派生：warn=×1.3 / finding=×2）----

test('S5: 节内 ### 子标题降为 warn（门禁改革：不可程序修复的格式类不硬拦）', () => {
  const r = Content.checkSectionShape('## 概念：向量\n\n正文一句。\n\n### 小标题\n\n更多正文。\n', 250)
  assert.equal(r.findings.length, 0)
  assert.equal(r.warns.length, 1)
  assert.match(r.warns[0]!, /###/)
})

test('S5: 正文超预算×1.3 是 warn,超预算×2 是 finding（预算 400 → 520/800）', () => {
  const warnBody = `## 概念：A\n\n${'字'.repeat(650)}\n`
  const r1 = Content.checkSectionShape(warnBody, 400)
  assert.equal(r1.findings.length, 0)
  assert.equal(r1.warns.length, 1)
  assert.match(r1.warns[0]!, /×1\.3/)
  const failBody = `## 概念：B\n\n${'字'.repeat(801)}\n`
  const r2 = Content.checkSectionShape(failBody, 400)
  assert.equal(r2.findings.length, 1)
  assert.match(r2.findings[0]!, /正文过长/)
})

test('S5: 可视化块超 SECTION_VISUAL_CAP 是 finding,合计口径含 mermaid/svg/interactive', () => {
  const ok = '## 演示：图\n\n说明。\n\n```mermaid\ngraph LR\nA-->B\n```\n\n```svg\n<svg viewBox="0 0 1 1"></svg>\n```\n'
  assert.equal(Content.checkSectionShape(ok, 250).findings.length, 0, '恰好 2 块放行')
  const over = ok + '\n```chart\n{"series":[1]}\n```\n'
  const r = Content.checkSectionShape(over, 250)
  assert.equal(r.findings.length, 1)
  assert.match(r.findings[0]!, /可视化块 3 个超过上限 2/)
  const gen = '## 交互：玩\n\n玩。\n\n```learnhub-interactive:交互/a.html\n<!DOCTYPE html>\n```\n\n```mermaid\ngraph LR\nA-->B\n```\n\n```plot\n{"a":1}\n```\n'
  const rg = Content.checkSectionShape(gen, 250)
  assert.equal(rg.findings.length, 1, '生成时态的 learnhub-interactive 标记块同样计入')
  assert.match(rg.findings[0]!, /可视化块 3 个超过上限 2/)
})

test('S5: 代码块/公式/行内代码不占文字预算', () => {
  const long = `## 概念：D\n\n短句。\n\n\`\`\`python\n${'#'.repeat(2500)}\n\`\`\`\n\n$$${'x'.repeat(2500)}$$\n\n行内 \`code\` 不算字数。\n`
  const r = Content.checkSectionShape(long, 250)
  assert.equal(r.findings.length, 0)
  assert.equal(r.warns.length, 0)
})

test('S5: 机器区(### 注释标题后)不参与节形状', () => {
  const md = '## 概念：C\n\n正文。\n\n<!-- enc_candidates: [] -->\n\n## <!--机器区-->\n\n### 不算子标题\n'
  const r = Content.checkSectionShape(md, 250)
  assert.equal(r.findings.length, 0)
  assert.equal(r.warns.length, 0)
})

// ---- S6 checkVisualBlocks:富内容块门 ----

test('S6: 合法 plot/chart JSON 对象通过', () => {
  const body = '```plot\n{"type":"function", "expr": "x^2"}\n```\n\n```chart\n{"series":[1,2,3]}\n```\n'
  assert.deepEqual(Content.checkVisualBlocks(body), [])
})

test('S6: plot JSON 数组/标量不是对象,finding', () => {
  assert.equal(Content.checkVisualBlocks('```plot\n[1,2]\n```\n').length, 1)
  assert.equal(Content.checkVisualBlocks('```plot\n42\n```\n').length, 1)
})

test('S6: 非法 JSON(缺右括号)finding,块序号正确', () => {
  const body = '```plot\n{"a":1}\n```\n\n```plot\n{"b":\n```\n'
  const r = Content.checkVisualBlocks(body)
  assert.equal(r.length, 1)
  assert.match(r[0]!, /第 2 块/)
})

test('S6: 尾随逗号容错——清洗后可解析即通过(fast 档模型高频失误)', () => {
  const body = '```plot\n{"type":"function", "expr": "x^2",}\n```\n\n```chart\n{"series":[1,2,],}\n```\n'
  assert.deepEqual(Content.checkVisualBlocks(body), [])
})

test('S6: svg 必须以 <svg 开头', () => {
  assert.deepEqual(Content.checkVisualBlocks('```svg\n<svg viewBox="0 0 1 1"></svg>\n```\n'), [])
  const r = Content.checkVisualBlocks('```svg\nnot svg\n```\n')
  assert.equal(r.length, 1)
  assert.match(r[0]!, /<svg/)
})

// ---- S6.5 fixRichBlocks:程序性自动修复（落盘前清洗，不再只是门禁容忍） ----

test('S6.5: plot 尾随逗号在落盘前被改写为合法 JSON', () => {
  const body = '```plot\n{"type":"function", "expr": "x^2",}\n```\n'
  const fixed = Content.fixRichBlocks(body)
  assert.notEqual(fixed, body)
  const m = fixed.match(/```plot\n([\s\S]*?)\n```/)
  assert.ok(m, '修复后 plot 块仍在')
  assert.doesNotThrow(() => JSON.parse(m![1]!))
})

test('S6.5: plot JSON 带行注释脏输入被清洗（注释不属 JSON，面板无法渲染）', () => {
  const body = '```chart\n// 示意：本周数据\n{"series": [1, 2, 3],}\n```\n'
  const fixed = Content.fixRichBlocks(body)
  const m = fixed.match(/```chart\n([\s\S]*?)\n```/)
  assert.ok(m, '修复后 chart 块仍在')
  const parsed = JSON.parse(m![1]!) as { series?: number[] }
  assert.deepEqual(parsed.series, [1, 2, 3])
})

test('S6.5: 合法 plot JSON 原样保留（不画蛇添足）', () => {
  const body = '```plot\n{"type":"function", "expr": "x^2"}\n```\n'
  assert.equal(Content.fixRichBlocks(body), body)
})

test('S6.5: svg 块前导杂质裁剪至首个 <svg', () => {
  const body = '```svg\n这是一张示意图：\n<svg viewBox="0 0 1 1"><circle/></svg>\n```\n'
  const fixed = Content.fixRichBlocks(body)
  const m = fixed.match(/```svg\n([\s\S]*?)\n```/)
  assert.ok(m, '修复后 svg 块仍在')
  assert.match(m![1]!, /^<svg/)
  assert.doesNotMatch(m![1]!, /示意图/)
})

test('S6.5: mermaid 节点文本含 | 未引号 → 自动补双引号', () => {
  const body = '```mermaid\ngraph LR\nB[模 |v| = 3] --> C\n```\n'
  const fixed = Content.fixRichBlocks(body)
  assert.match(fixed, /B\["模 \|v\| = 3"\]/)
  // 修复后不应再有 mermaid 引号 warn
  assert.deepEqual(Content.checkMermaidQuotes(fixed), [])
})

// ---- 修复回路：findings 带定位、repair prompt 要求局部重写 ----

test('repair: plot finding 附带违规定位（块号 + 行摘录）', () => {
  const body = '## 概念：图\n\n一段说明。\n\n```plot\n{"a": 1,}\n```\n'
  const located = Content.locateFinding(body, '```plot 第 1 块不是合法 JSON 对象（面板会降级为源码显示）')
  assert.match(located, /第 1 块/)
  assert.match(located, /\{"a": 1,\}/)
})

test('repair: 修复 prompt 是「局部重写」指令并带定位，而非整节重写', () => {
  const first = '## 概念：图\n\n一段说明。\n\n```plot\n{"a": 1,}\n```\n'
  const gateText = '✗ ```plot 第 1 块不是合法 JSON 对象（面板会降级为源码显示）\n⚠ 节「概念：图」正文偏长'
  const prompt = Content.sectionRepairPrompt('## 任务模板\n\n## 输出\n\n只输出本节正文', '## 任务档案', first, gateText)
  assert.match(prompt, /只重写/)
  assert.match(prompt, /第 1 块/)
  assert.doesNotMatch(prompt, /重新输出本节正文/)
  // 门禁行不丢
  assert.match(prompt, /正文偏长/)
})

// ---- mermaid 引号 / 渲染语言 ----

test('mermaid 未引号节点文本含 | 是 warn,引号包裹后不报', () => {
  const bad = '```mermaid\ngraph LR\nB[模 |v| = 3] --> C\n```\n'
  assert.equal(Content.checkMermaidQuotes(bad).length, 1)
  const good = '```mermaid\ngraph LR\nB["模 |v| = 3"] --> C\n```\n'
  assert.deepEqual(Content.checkMermaidQuotes(good), [])
})

test('未注册代码块语言被点名,普通代码语言不报', () => {
  const r = Content.checkRendererLangs('```plot\n1\n```\n\n```foobar\nx\n```\n\n```python\ny\n```\n')
  assert.deepEqual(r, ['foobar'])
})

// ---- S7 checkInteractiveHtml:交互件门 ----

const widget = (cfg: string, extra = '') =>
  `<html><head><script type="application/json" id="widget-config">${cfg}</script></head>` +
  `<body><script>window.parent.postMessage({type:'LEARNHUB_COMPLETE'},'*')</script>${extra}</body></html>`

test('S7: 缺完成上报/含外联是 finding,缺 TEACHER 监听是 warn', () => {
  const r1 = Content.checkInteractiveHtml([{ rel: '交互/a.html', html: '<html><body>无上报</body></html>' }])
  assert.ok(r1.findings.some(f => /LEARNHUB_COMPLETE/.test(f)))
  assert.ok(r1.warns.some(w => /LEARNHUB_TEACHER/.test(w)))
  const r2 = Content.checkInteractiveHtml([{ rel: '交互/b.html', html: widget('{"type":"game"}', '<script src="https://cdn.example/x.js"></script>') }])
  assert.ok(r2.findings.some(f => /外联/.test(f)))
})

test('S7: widget-config 缺失是 warn,type 非法是 finding', () => {
  const r1 = Content.checkInteractiveHtml([{ rel: '交互/c.html', html: '<html><body><script>LEARNHUB_COMPLETE</script></body></html>' }])
  assert.ok(r1.warns.some(w => /widget-config/.test(w)))
  assert.equal(r1.findings.length, 0)
  const r2 = Content.checkInteractiveHtml([{ rel: '交互/d.html', html: widget('{"type":"unknown_kind"}') }])
  assert.ok(r2.findings.some(f => /类型菜单/.test(f)))
  const r3 = Content.checkInteractiveHtml([{ rel: '交互/e.html', html: widget('{"type":"simulation"}') }])
  assert.deepEqual(r3.findings, [])
})

test('S7: 超过 200KB 是 finding', () => {
  const big = widget('{"type":"game"}') + '<!--' + 'x'.repeat(201 * 1024) + '-->'
  const r = Content.checkInteractiveHtml([{ rel: '交互/f.html', html: big }])
  assert.ok(r.findings.some(f => /200KB/.test(f)))
})

// ---- 节清单:parseOutline / assembleBody / stripLeadingSectionTitle ----

test('parseOutline: 合法清单全 pending,缺 id 自动补,points 可选', () => {
  const ms = Content.parseOutline('node: 某节点\nsections:\n  - id: s1\n    title: 概念：向量\n    type: 概念\n  - title: 例题：读模\n    type: 例题\n    points: 一句话\n')
  assert.equal(ms.length, 2)
  assert.deepEqual(ms.map(m => m.id), ['s1', 's2'])
  assert.ok(ms.every(m => m.status === 'pending' && m.version === 0))
  assert.equal(ms[1]!.points, '一句话')
})

test('parseOutline: sections 空/缺 title/id 重复/类型不在菜单 都抛错', () => {
  assert.throws(() => Content.parseOutline('node: x\nsections: []\n'), /sections 为空/)
  assert.throws(() => Content.parseOutline('node: x\nsections:\n  - title: \"\"\n    type: 概念\n'), /title/)
  assert.throws(() => Content.parseOutline('node: x\nsections:\n  - id: s1\n    title: A\n    type: 概念\n  - id: s1\n    title: B\n    type: 例题\n'), /重复/)
  assert.throws(() => Content.parseOutline('node: x\nsections:\n  - id: s1\n    title: A\n    type: 随笔\n'), /节类型菜单/)
})

function manifest(id: string, title: string, type: string) {
  return { id, title, type, status: 'ready' as const, version: 1 }
}

test('assembleBody: intro/保护区/enc 块保留,pending 不进正文,清单节用 provided', () => {
  const existing = [
    '开头导语。',
    '',
    '## 概念：旧内容',
    '',
    '旧正文',
    '',
    '## 练习',
    '',
    '练习区内容',
    '',
    '<!-- enc_candidates: [基础] -->',
    '',
  ].join('\n')
  const out = Content.assembleBody(
    existing,
    [manifest('s1', '概念：新标题', '概念'), manifest('s2', '概念：还没生成', '概念')],
    new Map([['概念：新标题', '新正文']]),
  )
  assert.match(out, /^开头导语。/)
  assert.match(out, /## 概念：新标题\n\n新正文/)
  assert.doesNotMatch(out, /旧正文/)
  assert.doesNotMatch(out, /还没生成/)
  assert.match(out, /## 练习\n\n练习区内容/)
  assert.match(out, /<!-- enc_candidates: \[基础\] -->\n?$/)
})

test('stripLeadingSectionTitle: 同名首行剥掉,不同标题原样返回', () => {
  assert.equal(Content.stripLeadingSectionTitle('## 概念：A\n\n正文', '概念：A'), '正文')
  assert.equal(Content.stripLeadingSectionTitle('\n\n## 概念：A \n\n正文', '概念：A'), '正文')
  assert.equal(Content.stripLeadingSectionTitle('## 概念：B\n\n正文', '概念：A'), '## 概念：B\n\n正文')
})

// ---- S9 validateBank:题库 schema(只管形状,不管数量) ----

test('validateBank: 各题型合法样例通过,数量不限', () => {
  const r = validateBank({
    node: '某节点',
    questions: [
      { id: 'q1', kind: 'single_choice', q: '1+1?', options: ['1', '2', '3', '4'], answer: 'B', difficulty: 1 },
      { id: 'q2', kind: 'true_false', q: '对吗', answer: '对' },
      { id: 'q3', kind: 'fill_in_blank', q: '填空', answer: ['答案A', '答案B'] },
      { id: 'q4', kind: 'numeric', q: '算', answer: '1/2', tol: 0.01 },
      { id: 'q5', kind: 'ordering', q: '排序', options: ['第二步', '第一步'], answer: ['第一步', '第二步'] },
      { id: 'q6', kind: 'matching', q: '配对', options: ['左1', '左2'], answer: ['右1', '右2'] },
      { id: 'q7', kind: 'multi_choice', q: '多选', options: ['a', 'b', 'c', 'd'], answer: ['A', 'C'] },
      { id: 'q8', kind: 'reflection', q: '反思', answer: '要点' },
    ],
  })
  assert.equal(r.errors, undefined)
  assert.equal(r.spec!.questions.length, 8)
})

test('validateBank: 形状错误逐题报错', () => {
  const r = validateBank({
    node: '',
    questions: [
      { kind: 'single_choice', q: 'x', options: ['a', 'b'], answer: 'E' },
      { kind: 'ordering', q: 'x', options: ['a', 'b'], answer: ['a', 'a'] },
      { kind: 'numeric', q: 'x', answer: '不是数' },
      { kind: 'matching', q: 'x', options: ['a', 'b'], answer: ['只有一项'] },
    ],
  })
  assert.ok(r.errors)
  assert.ok(r.errors!.some(e => e.includes('node')))
  assert.ok(r.errors!.some(e => e.includes('questions.1')))
  assert.ok(r.errors!.some(e => e.includes('questions.2')))
  assert.ok(r.errors!.some(e => e.includes('questions.3')))
  assert.ok(r.errors!.some(e => e.includes('questions.4')))
})
