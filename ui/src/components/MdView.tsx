/** 课程正文 Markdown 渲染：react-markdown + remark-gfm（表格/删除线/任务列表）
 * + remark-math/rehype-katex（公式）。代码块经 renderers.tsx 注册表按 lang 分发
 * （mermaid/media），未注册语言降级源码；Obsidian 图片嵌入 ![[path]] 预处理为
 * 面板文件路由 URL。不渲染裸 HTML（生成内容无注入面）。
 * InlineMd 为同一条链的行内变体：题干/选项/判卷反馈等短文本复用。 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/contrib/mhchem' // \ce 等化学宏注册进 rehype-katex 共享的 katex 实例
import 'katex/dist/katex.min.css'
import { renderBlock, verifyRendererCoverage } from './renderers'

void verifyRendererCoverage()

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

/** 行内场景段落降为 span：<p> 的块级默认会撑断 Radio/Text 的行内布局。 */
function pToSpan(props: { children?: ReactNode }) {
  return <span>{props.children}</span>
}

/** 代码块分发（MdView 与 InlineMd 共用）：注册表命中按 lang 渲染，未注册降级源码。 */
function MdCode(props: { className?: string; children?: ReactNode }) {
  const text = String(props.children ?? '').replace(/\n$/, '')
  const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1] ?? ''
  const rendered = renderBlock(lang, text)
  if (rendered !== null) return rendered
  return <code className={props.className}>{props.children}</code>
}

/** Obsidian 嵌入语法 → 标准 markdown 图片（面板 /file 路由伺服 vault 相对路径）。 */
function preprocessWikilinks(md: string): string {
  return md.replace(/!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, path: string, label?: string) => {
    const p = path.trim().replace(/\\/g, '/')
    const alt = (label ?? '').trim() || p.split('/').pop() || p
    return `![${alt}](/learnhub/api/file?path=${encodeURIComponent(p)})`
  })
}

export default function MdView(props: { md: string; className?: string }) {
  const md = useMemo(() => preprocessWikilinks(props.md), [props.md])
  return (
    <div className={`md-body ${props.className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{ code: MdCode }}
      >
        {md}
      </ReactMarkdown>
    </div>
  )
}

/** 题干/选项/判卷反馈等短文本的 Markdown+公式渲染（与 MdView 同一条 remark-math
 * 链）：段落降为 span 保持行内布局；外层 pre-wrap 保留原文换行（commonmark
 * 软换行在输出文本里是 \n，常规 white-space 下折叠成空格）。代码块同走
 * renderBlock——题干/解析可携带 svg/plot/chart 图。 */
export function InlineMd(props: { text: string }) {
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{ p: pToSpan, code: MdCode }}
      >{props.text}</ReactMarkdown>
    </span>
  )
}
