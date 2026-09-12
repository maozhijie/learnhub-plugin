/**
 * 代码块渲染器注册表：按 ```lang 分发，MdView 消费；未注册 lang 降级源码显示。
 *
 * 格式清单事实源在 shared/content-renderers.ts（与引擎提示词共享）——
 * 新增格式 = 注册表加一个实现 + shared RENDERERS 加一行，两侧自动同步。
 * 行内/独立公式（$…$、$$…$$）不占代码块，由 MdView 的 remark-math 链处理。
 */
import type { ReactNode } from 'react'
import { useContext, useEffect, useRef, useState } from 'react'
import { Message, Tag } from '@arco-design/web-react'
import { api } from '../api'
import { RENDERERS } from '../../../shared/content-renderers'
import { SettleContext } from '../lib/settle-context'
import { ChartBlock, PlotBlock, SvgBlock } from './visual-blocks'
import { useWidgetBus } from './widget-bus'

/** Mermaid 图（主题跟随 arco-theme；失败降级源码）。 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2, 9)}`)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        const dark = document.body.getAttribute('arco-theme') === 'dark'
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
        const { svg } = await mermaid.render(idRef.current, code)
        if (!cancelled) { setSvg(svg); setFailed(false) }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [code])
  if (failed || svg === null) {
    return <pre className='md-mermaid-fallback'><code>{code}</code></pre>
  }
  return <div className='md-mermaid' dangerouslySetInnerHTML={{ __html: svg }} />
}

/** 音视频块：每行一个 vault 相对路径 → /file 路由播放器（按扩展名选 video/audio）。 */
const MEDIA_MIME: Record<string, 'video' | 'audio'> = {
  mp4: 'video', webm: 'video', ogv: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', oga: 'audio', m4a: 'audio', flac: 'audio',
}

function MediaBlock({ code }: { code: string }) {
  const lines = code.split('\n').map(s => s.trim()).filter(Boolean)
  if (!lines.length) return <pre><code>{code}</code></pre>
  return (
    <div className='md-media' style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.map((p, i) => {
        const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
        const kind = MEDIA_MIME[ext] ?? 'video'
        const src = `/learnhub/api/file?path=${encodeURIComponent(p.replace(/\\/g, '/'))}`
        return kind === 'audio'
          ? <audio key={i} controls src={src} style={{ width: '100%' }} />
          : <video key={i} controls src={src} style={{ maxWidth: '100%', borderRadius: 8 }} />
      })}
    </div>
  )
}

/** 交互模拟块：sandbox iframe 内嵌 vault 交互件（```interactive 块，首行 vault 相对路径）。
 * 协议：交互件 postMessage({type:'LEARNHUB_COMPLETE', score?, detail?}) → 亮徽标；
 * 会话内（SettleContext，交互节轮）且带 score 时上报 /interactive/settle 入练习档案
 * （同节同日一次，防刷在服务端）；自由阅读（无上下文）只亮徽标。
 * postMessage({type:'SHOW_ANNOTATION', content}) → 块顶浮层展示 AI 标注文字（8s 自动消失）。 */
function InteractiveBlock({ code }: { code: string }) {
  const path = code.split('\n').map(s => s.trim()).filter(Boolean)[0]
  const settle = useContext(SettleContext)
  const bus = useWidgetBus()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [done, setDone] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 成绩只上报一次（iframe 内重复完成不重复计分；上报失败回置允许重试）。 */
  const settledRef = useRef(false)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; content?: string; score?: unknown; detail?: unknown } | null
      if (!data || typeof data !== 'object') return
      if (data.type === 'LEARNHUB_COMPLETE') {
        setDone(true)
        const detail = typeof data.detail === 'string' && data.detail.trim() ? data.detail.trim() : undefined
        if (detail) setResult(detail)
        const score = typeof data.score === 'number' && Number.isFinite(data.score) ? data.score : undefined
        if (settle && score !== undefined && !settledRef.current) {
          settledRef.current = true
          void api.interactiveSettle(settle.course, settle.node, settle.sectionId, score, detail)
            .then(r => { if (r.settled) Message.success('交互成绩已记入练习档案') })
            .catch(() => { settledRef.current = false })
        }
      }
      if (data.type === 'SHOW_ANNOTATION' && typeof data.content === 'string' && data.content.trim()) {
        setNote(data.content.trim())
        if (noteTimer.current) clearTimeout(noteTimer.current)
        noteTimer.current = setTimeout(() => setNote(null), 8000)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (noteTimer.current) clearTimeout(noteTimer.current)
    }
  }, [settle])
  // AI 老师广播通道：注册发送器（iframe 未加载完成时 postMessage 静默丢弃；动作总在加载后触发，无需等 onLoad）
  useEffect(() => {
    if (!bus) return
    return bus.register(msg => iframeRef.current?.contentWindow?.postMessage(msg, '*'))
  }, [bus])
  if (!path) return <pre className='md-interactive-fallback'><code>{code}</code></pre>
  const src = `/learnhub/api/interactive?path=${encodeURIComponent(path.replace(/\\/g, '/'))}`
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {note && (
        <div style={{
          position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
          background: 'var(--color-primary-6,#165dff)', color: '#fff', borderRadius: 8,
          padding: '6px 12px', fontSize: 13, maxWidth: '90%', boxShadow: '0 4px 10px rgba(0,0,0,.25)',
        }}>{note}</div>
      )}
      <iframe
        ref={iframeRef}
        sandbox='allow-scripts' src={src} title='交互模拟' loading='lazy'
        style={{ width: '100%', minHeight: 380, border: '1px solid var(--color-border-2,#e5e6eb)', borderRadius: 8 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {done
          ? <Tag size='small' color='green'>{result ? `交互已完成：${result}` : '交互已完成'}</Tag>
          : <Tag size='small' color='gray'>动手玩一玩上面的模拟（完成交互后这里会亮起）</Tag>}
      </div>
    </div>
  )
}

interface RendererImpl {
  lang: string
  render: (code: string) => ReactNode
}

/** 注册表：shared 清单里占代码块的格式在此实现（math 走 remark 插件链，不在此；
 * svg/plot/chart 实现在 visual-blocks.tsx）。 */
const BLOCK_RENDERERS: RendererImpl[] = [
  { lang: 'mermaid', render: code => <MermaidBlock code={code} /> },
  { lang: 'media', render: code => <MediaBlock code={code} /> },
  { lang: 'interactive', render: code => <InteractiveBlock code={code} /> },
  { lang: 'svg', render: code => <SvgBlock code={code} /> },
  { lang: 'plot', render: code => <PlotBlock code={code} /> },
  { lang: 'chart', render: code => <ChartBlock code={code} /> },
]

/** lang → 渲染结果；未注册返回 null（调用方降级源码）。 */
export function renderBlock(lang: string, code: string): ReactNode | null {
  const hit = BLOCK_RENDERERS.find(r => r.lang === lang.toLowerCase())
  return hit ? hit.render(code) : null
}

/** UI 实现与 shared 清单的对账（注册表遗漏时构建期即知）。 */
export function verifyRendererCoverage(): void {
  for (const r of RENDERERS) {
    if (r.lang === 'math') continue
    if (!BLOCK_RENDERERS.some(b => b.lang === r.lang)) {
      throw new Error(`[learnhub] shared 清单里的渲染器「${r.lang}」缺少 UI 实现（components/renderers.tsx）`)
    }
  }
}
