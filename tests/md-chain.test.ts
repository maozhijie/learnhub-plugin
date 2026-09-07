import test from 'node:test'
import assert from 'node:assert/strict'
import { MD_HTML_POLICY, REHYPE_PLUGINS, REMARK_PLUGINS } from '../ui/src/components/md-chain.ts'

// ---- markdown 渲染链 HTML 策略 ----
// 回归背景：react-markdown 默认把 html 节点按转义文本渲染，笔记末尾的机器块
// `<!-- enc_candidates: [] -->`（引擎成分技能审计标注）原样出现在学习页正文里。
// 修复 = skipHtml: true（markdown 解析层丢弃 html 节点；代码块内注释是 code 节点，不受影响）。

test('MD_HTML_POLICY: skipHtml 必须开启（机器注释不得显示，裸 HTML 无注入面）', () => {
  assert.equal(MD_HTML_POLICY.skipHtml, true)
})

test('渲染链插件：remark-gfm + remark-math，rehype 仅 katex（无 rehype-raw）', () => {
  assert.equal(REMARK_PLUGINS.length, 2)
  assert.equal(REHYPE_PLUGINS.length, 1)
  // 若引入 rehype-raw，裸 HTML 会被真正渲染——与 skipHtml 策略冲突，需重新评审
  assert.ok(!REHYPE_PLUGINS.some(p => String((p as { name?: string }).name) === 'rehypeRaw'))
})
