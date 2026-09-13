/** 课程正文 Markdown 渲染：react-markdown + remark-gfm（表格/删除线/任务列表）
 * + remark-math/rehype-katex（公式）。代码块经 renderers.tsx 注册表按 lang 分发
 * （mermaid/media），未注册语言降级源码；Obsidian 图片嵌入 ![[path]] 预处理为
 * 面板文件路由 URL。不渲染裸 HTML（skipHtml，见 md-chain.ts——机器注释等 html
 * 节点直接丢弃，而非默认的转义文本显示）。
 * learnhub-predict 预测门块（P-8 #97）由 splitPredictSegments 切出渲染为
 * PredictGate「先预测再揭晓」阅读门：门未过不渲染块后正文，揭晓后递归放行
 * （一节多门自然嵌套）；不合法块（人工改坏）降级源码显示。
 * InlineMd 为同一条链的行内变体：题干/选项/判卷反馈等短文本复用。 */
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import 'katex/contrib/mhchem' // \ce 等化学宏注册进 rehype-katex 共享的 katex 实例
import 'katex/dist/katex.min.css'
import { MD_HTML_POLICY, REHYPE_PLUGINS, REMARK_PLUGINS } from '../lib/md-chain'
import { renderBlock, verifyRendererCoverage } from './renderers'
import { splitPredictSegments } from '../../../shared/content-renderers'
import type { PredictBlock } from '../../../shared/content-renderers'
import PredictGate from './PredictGate'

void verifyRendererCoverage()

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

/** 纯 markdown 主体（无预测门分界时的完整渲染）。 */
function MdBody(props: { md: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      {...MD_HTML_POLICY}
      components={{ code: MdCode }}
    >
      {props.md}
    </ReactMarkdown>
  )
}

export default function MdView(props: { md: string; className?: string }) {
  const md = useMemo(() => preprocessWikilinks(props.md), [props.md])
  const segments = useMemo(() => splitPredictSegments(md), [md])
  // 无预测门：与既有渲染路径完全一致
  if (segments.length <= 1 && (segments.length === 0 || segments[0]!.type === 'md')) {
    return (
      <div className={`md-body ${props.className ?? ''}`}>
        <MdBody md={md} />
      </div>
    )
  }
  return (
    <div className={`md-body ${props.className ?? ''}`}>
      {segments.map((seg, i) => {
        if (seg.type === 'md') return <MdBody key={i} md={seg.md} />
        if ('error' in seg.parsed) {
          // 人工改坏的块：质检门会拦新生成；这里降级源码显示不让页面崩
          return <pre key={i} className='md-predict-invalid'><code>{seg.raw}</code></pre>
        }
        const parsed: PredictBlock = seg.parsed
        // after 走递归 MdView：一节多门时内层门保持各自的「先预测再放行」
        return <PredictGate key={i} parsed={parsed} after={<MdView md={seg.after} />} />
      })}
    </div>
  )
}

/** 题干/选项/判卷反馈等短文本的 Markdown+公式渲染（与 MdView 同一条 remark-math
 * 链）：段落降为 span 保持行内布局；外层 pre-wrap 保留原文换行（commonmark
 * 软换行在输出文本里是 \n，常规 white-space 下折叠成空格）。代码块同走
 * renderBlock——题干/解析可携带 svg/plot/chart 图。 */
export function InlineMd(props: { text: string }) {
  return (
    <span className='lh-prewrap'>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        {...MD_HTML_POLICY}
        components={{ p: pToSpan, code: MdCode }}
      >{props.text}</ReactMarkdown>
    </span>
  )
}
