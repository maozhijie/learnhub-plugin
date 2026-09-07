/**
 * ```svg / ```plot / ```chart 代码块的渲染实现（MdView 查表分发，注册表在 renderers.tsx）。
 * 统一模式：重依赖动态 import（不进首屏 bundle，沿用 MermaidBlock 的 lazy 形态）；
 * 解析/校验不过 → 降级源码 <pre> 显示（misconfig 不静默吞掉，学习者仍能看到原文）。
 * plot：模型只声明数学对象（JSON spec），本文件负责求值（mathjs/number）与绘制（Mafs）；
 * chart：标准 ECharts option，按需注册四类 series；svg：DOMPurify 白名单清洗后内联。
 */
import DOMPurify from 'dompurify'
import { compile } from 'mathjs/number'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SVG_URI } from './svg-uri'
import 'mafs/core.css'

/** 渲染失败/校验不过时的源码降级块。 */
function Fallback(props: { cls: string; code: string }) {
  return <pre className={props.cls}><code>{props.code}</code></pre>
}

// ---- svg ----

/** SVG 示意图：白名单清洗（svg profile，天然剔 <script>/事件处理器）→ 内联渲染。 */
export function SvgBlock(props: { code: string }) {
  const clean = useMemo(() => {
    try {
      const out = DOMPurify.sanitize(props.code, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ALLOWED_URI_REGEXP: SVG_URI,
      })
      return /<svg[\s>]/i.test(out) ? out : null
    } catch {
      return null
    }
  }, [props.code])
  if (!clean) return <Fallback cls='md-svg-fallback' code={props.code} />
  return <div className='md-svg' dangerouslySetInnerHTML={{ __html: clean }} />
}

// ---- plot ----

type Vec2 = [number, number]

interface PlotStyle {
  color: string
  style: 'solid' | 'dashed'
}

/** plot 元素闭集合（与 shared/content-renderers.ts 的提示词规范一一对应）。 */
type Compiled =
  | ({ kind: 'fn'; f: (x: number) => number; label?: string } & PlotStyle)
  | ({ kind: 'parametric'; xy: (t: number) => Vec2; t: Vec2; label?: string } & PlotStyle)
  | ({ kind: 'point'; p: Vec2; label?: string } & PlotStyle)
  | ({ kind: 'vector'; tail: Vec2; head: Vec2; label?: string } & PlotStyle)
  | ({ kind: 'segment'; a: Vec2; b: Vec2; label?: string } & PlotStyle)
  | ({ kind: 'circle'; c: Vec2; r: number; label?: string } & PlotStyle)
  | ({ kind: 'polygon'; pts: Vec2[]; label?: string } & PlotStyle)
  | { kind: 'label'; p: Vec2; text: string }

interface PlotSpec {
  xRange?: Vec2
  yRange?: Vec2
  grid?: 'cartesian' | 'polar'
  elements?: Array<Record<string, unknown>>
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const vec = (v: unknown): Vec2 | null => {
  if (!Array.isArray(v) || v.length !== 2) return null
  const x = num(v[0])
  const y = num(v[1])
  return x === null || y === null ? null : [x, y]
}

const PLOT_DEFAULT = '#165dff'

/** spec → 求值闭包列表；未知/非法元素跳过并告警（生成侧由质检门拦 JSON 语法）。 */
function compilePlotSpec(spec: PlotSpec): Compiled[] {
  const out: Compiled[] = []
  for (const e of spec.elements ?? []) {
    const type = typeof e.type === 'string' ? e.type : ''
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined
    const style: PlotStyle = {
      color: typeof e.color === 'string' && e.color.trim() ? e.color.trim() : PLOT_DEFAULT,
      style: e.style === 'dashed' ? 'dashed' : 'solid',
    }
    try {
      switch (type) {
        case 'fn': {
          const f = compile(String(e.expr))
          out.push({ kind: 'fn', f: (x: number) => f.evaluate({ x }) as number, label, ...style })
          break
        }
        case 'parametric': {
          const fx = compile(String(e.exprX))
          const fy = compile(String(e.exprY))
          const t = vec(e.tRange) ?? [0, 2 * Math.PI]
          out.push({ kind: 'parametric', xy: (t: number) => [fx.evaluate({ t }) as number, fy.evaluate({ t }) as number], t, label, ...style })
          break
        }
        case 'point': {
          const p = vec([e.x, e.y])
          if (p) out.push({ kind: 'point', p, label, ...style })
          break
        }
        case 'vector': {
          const tail = vec(e.tail) ?? [0, 0]
          const head = vec(e.head)
          if (head) out.push({ kind: 'vector', tail, head, label, ...style })
          break
        }
        case 'segment': {
          const a = vec(e.a)
          const b = vec(e.b)
          if (a && b) out.push({ kind: 'segment', a, b, label, ...style })
          break
        }
        case 'circle': {
          const c = vec(e.center)
          const r = num(e.r)
          if (c && r !== null && r > 0) out.push({ kind: 'circle', c, r, label, ...style })
          break
        }
        case 'polygon': {
          const pts = Array.isArray(e.points) ? e.points.map(vec) : []
          if (pts.length >= 3 && pts.every(p => p)) out.push({ kind: 'polygon', pts: pts as Vec2[], label, ...style })
          break
        }
        case 'label': {
          const p = vec([e.x, e.y])
          if (p && typeof e.text === 'string') out.push({ kind: 'label', p, text: e.text })
          break
        }
        default:
          console.warn(`[learnhub] plot 元素类型「${type}」未注册，已跳过`)
      }
    } catch (err) {
      console.warn(`[learnhub] plot 元素「${type}」求值失败已跳过: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

/** 函数图像/坐标几何：JSON spec → Mafs 坐标系渲染（Mafs 动态加载）。 */
export function PlotBlock(props: { code: string }) {
  const spec = useMemo<PlotSpec | null>(() => {
    try { return JSON.parse(props.code) as PlotSpec } catch { return null }
  }, [props.code])
  const compiled = useMemo(() => (spec ? compilePlotSpec(spec) : null), [spec])
  const [mafs, setMafs] = useState<typeof import('mafs') | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const m = await import('mafs')
        if (!cancelled) { setMafs(m); setFailed(false) }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [])
  if (!spec || !compiled || failed || !mafs) return <Fallback cls='md-plot-fallback' code={props.code} />

  const { Mafs, Coordinates, Plot, Vector, Point, Circle, Polygon, Line, Text } = mafs
  const xr: Vec2 = vec(spec.xRange) ? spec.xRange! : [-6, 6]
  const yr: Vec2 = vec(spec.yRange) ? spec.yRange! : [-4, 4]
  const nodes = compiled.map((c, i) => {
    switch (c.kind) {
      case 'fn':
        return (
          <Fragment key={i}>
          <Plot.OfX y={c.f} color={c.color} style={c.style} weight={2} />
          {c.label && <Text x={xr[1] * 0.88} y={c.f(xr[1] * 0.88)} attach='ne' color={c.color}>{c.label}</Text>}
        </Fragment>
        )
      case 'parametric':
        return <Plot.Parametric key={i} xy={c.xy} t={c.t} color={c.color} style={c.style} weight={2} />
      case 'point':
        return (
          <Fragment key={i}>
          <Point x={c.p[0]} y={c.p[1]} color={c.color} />
          {c.label && <Text x={c.p[0]} y={c.p[1]} attach='ne' color={c.color}>{c.label}</Text>}
        </Fragment>
        )
      case 'vector':
        return (
          <Fragment key={i}>
          <Vector tail={c.tail} tip={c.head} color={c.color} style={c.style} weight={2} />
          {c.label && <Text x={(c.tail[0] + c.head[0]) / 2} y={(c.tail[1] + c.head[1]) / 2} attach='ne' color={c.color}>{c.label}</Text>}
        </Fragment>
        )
      case 'segment':
        return (
          <Fragment key={i}>
          <Line.Segment point1={c.a} point2={c.b} color={c.color} style={c.style} weight={2} />
          {c.label && <Text x={(c.a[0] + c.b[0]) / 2} y={(c.a[1] + c.b[1]) / 2} attach='ne' color={c.color}>{c.label}</Text>}
        </Fragment>
        )
      case 'circle':
        return (
          <Fragment key={i}>
          <Circle center={c.c} radius={c.r} color={c.color} strokeStyle={c.style} fillOpacity={0.08} />
          {c.label && <Text x={c.c[0]} y={c.c[1] + c.r} attach='n' color={c.color}>{c.label}</Text>}
        </Fragment>
        )
      case 'polygon':
        return (
          <Fragment key={i}>
          <Polygon points={c.pts} color={c.color} fillOpacity={0.12} />
          {c.label && <Text x={c.pts[0][0]} y={c.pts[0][1]} attach='ne' color={c.color}>{c.label}</Text>}
        </Fragment>
        )
      case 'label':
        return <Text key={i} x={c.p[0]} y={c.p[1]}>{c.text}</Text>
      default: {
        const never: never = c
        return never
      }
    }
  })
  return (
    <div className='md-plot'>
      <Mafs viewBox={{ x: xr, y: yr }} preserveAspectRatio={false} pan={false} zoom={false} height={320}>
        {spec.grid === 'polar'
          ? <Coordinates.Polar />
          : <Coordinates.Cartesian />}
        {nodes}
      </Mafs>
    </div>
  )
}

// ---- chart ----

/** chart series 白名单（防模型产出未按需注册的图型 → 空白画布）。 */
const CHART_SERIES = new Set(['line', 'bar', 'pie', 'scatter'])

/** ECharts option 解析守卫：series 类型白名单 + 禁外部 URL。 */
function parseChartOption(code: string): Record<string, unknown> | null {
  try {
    const opt = JSON.parse(code) as { series?: unknown }
    if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null
    const series = Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []
    for (const s of series) {
      const t = (s as { type?: unknown })?.type
      if (typeof t === 'string' && !CHART_SERIES.has(t)) return null
    }
    if (/https?:\/\//i.test(JSON.stringify(opt))) return null
    return opt as Record<string, unknown>
  } catch {
    return null
  }
}

/** 数据图表：标准 ECharts option → echarts/core 按需注册渲染（ResizeObserver 自适应 + 主题跟随）。 */
export function ChartBlock(props: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const option = useMemo(() => parseChartOption(props.code), [props.code])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!option) return
    let disposed = false
    let chart: import('echarts/core').EChartsType | null = null
    let ro: ResizeObserver | undefined
    void (async () => {
      try {
        const echarts = await import('echarts/core')
        const charts = await import('echarts/charts')
        const components = await import('echarts/components')
        const { CanvasRenderer } = await import('echarts/renderers')
        echarts.use([
          charts.LineChart, charts.BarChart, charts.PieChart, charts.ScatterChart,
          components.GridComponent, components.TooltipComponent, components.LegendComponent,
          components.DataZoomComponent, components.TitleComponent, CanvasRenderer,
        ])
        if (disposed || !ref.current) return
        const dark = document.body.getAttribute('arco-theme') === 'dark'
        chart = echarts.init(ref.current, dark ? 'dark' : undefined)
        chart.setOption({ ...option, backgroundColor: 'transparent' })
        ro = new ResizeObserver(() => chart?.resize())
        ro.observe(ref.current)
      } catch {
        if (!disposed) setFailed(true)
      }
    })()
    return () => {
      disposed = true
      ro?.disconnect()
      chart?.dispose()
    }
  }, [option])
  if (!option || failed) return <Fallback cls='md-chart-fallback' code={props.code} />
  return <div ref={ref} className='md-chart' style={{ width: '100%', height: 340 }} />
}
