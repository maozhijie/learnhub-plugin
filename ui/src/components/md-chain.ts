/**
 * MdView 与 InlineMd 共用的 markdown 渲染链配置——零 UI 依赖，node:test 可直接消费。
 *
 * skipHtml: true：生成内容不渲染裸 HTML（MdView 头注释"不渲染裸 HTML"的执行点）。
 * react-markdown 默认会把 html 节点按**转义文本**显示出来——笔记末尾的机器块
 * （如 `<!-- enc_candidates: [] -->`，引擎给成分技能审计用的标注）会原样出现在学习页。
 * skipHtml 让 markdown 解析层丢弃这些节点；代码块内的 HTML 注释是 code 节点，不受影响。
 */
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

export const REMARK_PLUGINS = [remarkGfm, remarkMath]
export const REHYPE_PLUGINS = [rehypeKatex]

export const MD_HTML_POLICY = { skipHtml: true } as const
