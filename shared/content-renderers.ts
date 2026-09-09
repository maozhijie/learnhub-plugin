/**
 * 内容渲染器与节类型清单——UI 渲染注册表与引擎提示词的单一事实源（零依赖）。
 *
 * 消费方：
 * - ui/src/components/renderers.ts：按 lang 实现渲染器、MdView 查表分发
 * - src/engine/content.ts：loadPrompt 把清单注入生成提示词、gateReport 校验未注册 lang
 *
 * 扩展新格式 = 在 RENDERERS 加一项 + UI 注册表加一个实现，两侧自动同步。
 */
export interface RendererSpec {
  /** 代码块语言标记（```lang）。 */
  lang: string
  label: string
  /** 创作提示：这个格式适合表达什么。 */
  hint: string
  /** 写法示例（注入提示词）。 */
  example: string
}

/** 交互件类型菜单（widget-config 的 type 字段与生成提示词共享）。 */
export const INTERACTIVE_TYPES = ['simulation', 'visualization3d', 'diagram', 'game', 'code'] as const
export type InteractiveType = (typeof INTERACTIVE_TYPES)[number]

export const RENDERERS: RendererSpec[] = [
  {
    lang: 'mermaid',
    label: 'Mermaid 图',
    hint: '流程图、时序图、状态图等矢量示意图',
    example: '```mermaid\ngraph LR\nA[概念] --> B[应用]\n```',
  },
  {
    lang: 'math',
    label: '数学公式',
    hint: '一切数学一律用它：行内 $...$、独立成行 $$...$$，直接写在正文里，不用代码块；禁止 ASCII 记号（x^2、a_1）与不带 $ 定界符的裸 LaTeX 命令',
    example: '行内 $E = mc^2$；独立公式 $$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$',
  },
  {
    lang: 'media',
    label: '音视频',
    hint: '代码块内每行写一个 vault 相对媒体路径，按扩展名渲染为视频/音频播放器',
    example: '```media\n<课程根>/课程图/demo.mp4\n```',
  },
  {
    lang: 'interactive',
    label: '交互模拟',
    hint: '代码块内写一个 vault 相对 HTML 路径（自包含交互件，禁外联），面板内嵌沙箱渲染；交互件结尾应 postMessage({type:\'LEARNHUB_COMPLETE\'},\'*\') 上报完成',
    example: '```interactive\n<课程根>/交互/单摆模拟.html\n```',
  },
  {
    lang: 'svg',
    label: 'SVG 示意图',
    hint: '精确静态示意图（几何图形/向量/坐标系/结构图示）：完整手写 SVG，可直接内联 <animate>/<animateTransform> 做动画；面板清洗后渲染，禁 <script> 与外部引用',
    example: '```svg\n<svg viewBox="0 0 220 120" xmlns="http://www.w3.org/2000/svg">\n  <line x1="10" y1="100" x2="210" y2="100" stroke="#86909c" stroke-width="1"/>\n  <path d="M10 100 Q80 10 200 40" fill="none" stroke="#165dff" stroke-width="2"/>\n  <circle cx="200" cy="40" r="3" fill="#f53f3f"/>\n  <text x="180" y="30" font-size="12">P</text>\n</svg>\n```',
  },
  {
    lang: 'plot',
    label: '函数图像/坐标几何',
    hint: '数学坐标图：JSON spec（xRange/yRange + elements）声明数学对象（函数/参数曲线/点/向量/线段/圆/多边形），面板用坐标系渲染——模型只给数学对象，不写像素',
    example: '```plot\n{ "xRange": [-4, 4], "yRange": [-3, 3],\n  "elements": [\n    { "type": "fn", "expr": "sin(x)", "label": "f(x)" },\n    { "type": "vector", "tail": [0, 0], "head": [1.57, 1], "label": "v" },\n    { "type": "point", "x": 1.57, "y": 1, "label": "P" } ] }\n```',
  },
  {
    lang: 'chart',
    label: '数据图表',
    hint: '数据可视化：标准 ECharts option JSON（series 限 line/bar/pie/scatter），面板按需渲染（自带动画）；禁外部 URL',
    example: '```chart\n{ "xAxis": { "type": "category", "data": ["周一","周二","周三","周四","周五"] },\n  "yAxis": { "type": "value" },\n  "series": [ { "type": "line", "name": "复习量", "data": [4, 7, 5, 9, 12], "smooth": true } ] }\n```',
  },
]

export interface SectionTypeSpec {
  /** 节标题前缀（`## 前缀：标题`）。 */
  prefix: string
  label: string
  /** 该类型节的创作要求（提示词用）。 */
  rule: string
}

/** 节 = 类型化原子学习单元；无前缀默认「概念」。节的选用与配比由模型按内容与风格自行判断，
 * 清单只提供类型菜单与各类型的创作要求，不强制结构。 */
export const SECTION_TYPES: SectionTypeSpec[] = [
  { prefix: '概念', label: '概念', rule: '只讲一个知识点：动机融进行文（不设栏目化标题），定义 → 最小示例' },
  { prefix: '例题', label: '例题', rule: '完整 worked example：题目 → 分步解答 → 参考答案' },
  { prefix: '演示', label: '演示', rule: '可视化承载主要信息（图表/图片/动画/交互），文字只作旁注' },
  { prefix: '小结', label: '小结', rule: '要点回顾与易错点清单' },
  { prefix: '练习', label: '练习', rule: '本节为题组：题目由题库提供，正文只写能力目标与作答引导（≤120 字），不写题' },
  { prefix: '交互', label: '交互', rule: '一节 = 一个交互模拟 + 少量旁注：正文用 learnhub-interactive 标记块内联写完整自包含 HTML' },
  { prefix: '思维', label: '思维轨迹', rule: '专家意识流解题（P-8）：第一人称叙述专家拿到一道题后的真实思维流——尝试、犹豫、自我盘问；中途故意踩一次典型坑并当场用元评论点破；关键转折处设 learnhub-predict 预测门（先预测再揭晓）；收尾提炼可迁移的解题元策略' },
]

/** 节标题解析 → {type, clean}；无匹配前缀返回默认「概念」类型。 */
export function parseSectionTitle(title: string): { type: SectionTypeSpec; clean: string } {
  const m = title.match(/^(.+?)[:：]\s*(.+)$/)
  const hit = m ? SECTION_TYPES.find(t => t.prefix === m[1].trim()) : undefined
  if (hit && m) return { type: hit, clean: m[2].trim() }
  return { type: SECTION_TYPES[0], clean: title.trim() }
}

/** 渲染能力清单 → 提示词注入段（{{renderers}} 占位符替换文本）。 */
export function rendererCapabilityBlock(): string {
  const out: string[] = ['## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染，写了等于没写）', '']
  for (const r of RENDERERS) {
    out.push(`- **${r.label}**：${r.hint}。写法：`, '', r.example, '')
  }
  out.push('- **图片/动画**：`![[<课程根>/课程图/xx.png]]`（支持 png/jpg/webp/gif/svg，路径相对 vault 根）', '')
  out.push('- **交互模拟（「交互」节内联创作）**：正文直接用标记块写完整 HTML，系统落盘为独立文件并替换为引用块：', '',
    '```learnhub-interactive:交互/<语义化名称>.html', '<!DOCTYPE html>…完整自包含 HTML…', '```', '',
    '  硬性要求：单文件自包含（全部 CSS/JS 内联，禁外部资源与网络请求，图形用 canvas/SVG/DOM 绘制）；达成模拟目标时结尾上报 `<script>window.parent.postMessage({type:\'LEARNHUB_COMPLETE\', score: <0-1 成绩>, detail: \'一句话结论\'},\'*\')</script>`。', '')
  return out.join('\n')
}

/** gateReport 白名单外的代码块语言 → 未渲染能力警告用的通用编程语言。 */
export const PLAIN_CODE_LANGS = new Set([
  'text', 'plain', 'txt', 'code', 'yaml', 'yml', 'json', 'bash', 'sh', 'shell',
  'python', 'py', 'js', 'javascript', 'ts', 'typescript', 'sql', 'java', 'c',
  'cpp', 'html', 'css', 'xml', 'md', 'markdown', 'diff', 'none', '',
])

// ---- 预测门机器块（P-8 #97：专家思维轨迹节的阅读流门）----
// 正文内嵌 ```learnhub-predict 围栏块，MdView 渲染为「先预测再揭晓」的阅读门；
// 引擎质检门按同一解析器校验结构（shared 单一事实源）。块内容是受限行式 YAML：
// q（预测题面）/ options（候选做法流式数组，2–4 项互异）/ answer（正确项原文）/
// why（可选，揭晓时的元评论）。

export const PREDICT_BLOCK_LANG = 'learnhub-predict'

export interface PredictBlock { q: string; options: string[]; answer: string; why?: string }

/** 解析流式数组 ["项一", "项二"]（容忍单双引号与尾随逗号）；非数组形态返回 null。 */
function parseFlowArray(text: string): string[] | null {
  const t = text.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const inner = t.slice(1, -1)
  const items: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ',') { items.push(cur.trim()); cur = '' }
    else cur += ch
  }
  if (quote !== null) return null
  const last = cur.trim()
  if (last) items.push(last)
  return items
}

/** 解析预测门块内容 → 结构化数据或错误说明（质检门与 UI 渲染共用）。 */
export function parsePredictBlock(text: string): PredictBlock | { error: string } {
  const fields = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (!m) return { error: `无法识别的行：「${line.slice(0, 40)}」（只允许 q/options/answer/why 字段）` }
    fields.set(m[1]!, m[2]!.trim())
  }
  const q = fields.get('q')
  const optionsRaw = fields.get('options')
  const answer = fields.get('answer')
  if (!q) return { error: '缺少 q（预测题面）' }
  if (!optionsRaw) return { error: '缺少 options（候选做法数组）' }
  const options = parseFlowArray(optionsRaw)
  if (!options || !options.length) return { error: 'options 必须是 ["做法一", "做法二", …] 形式的数组' }
  if (options.length < 2 || options.length > 4) return { error: `options 需要 2–4 项（收到 ${options.length} 项）` }
  if (new Set(options).size !== options.length) return { error: 'options 各项必须互不相同' }
  if (!answer) return { error: '缺少 answer（正确项原文）' }
  if (!options.includes(answer)) return { error: 'answer 必须是 options 中一项的原文' }
  const why = fields.get('why')
  return { q, options, answer, ...(why ? { why } : {}) }
}

/** 预测门围栏块的围栏正则（围栏行容忍尾随空白与 CRLF，同 checkVisualBlocks 纪律）。 */
export function predictBlockRe(): RegExp {
  return /^```learnhub-predict[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm
}

/** 把 markdown 切成 md / predict 段序列（UI 渲染分界用）；predict 段携带解析结果
 * 与「块后全部内容」（门未过时隐藏，答案揭晓后经递归 MdView 再渲染）。 */
export function splitPredictSegments(md: string): Array<
  { type: 'md'; md: string } | { type: 'predict'; raw: string; parsed: PredictBlock | { error: string }; after: string }
> {
  const out: Array<{ type: 'md'; md: string } | { type: 'predict'; raw: string; parsed: PredictBlock | { error: string }; after: string }> = []
  let last = 0
  for (const m of md.matchAll(predictBlockRe())) {
    const before = md.slice(last, m.index)
    if (before.trim()) out.push({ type: 'md', md: before })
    const afterStart = m.index + m[0].length
    out.push({ type: 'predict', raw: m[0], parsed: parsePredictBlock(m[1]!), after: md.slice(afterStart) })
    last = afterStart
  }
  const tail = md.slice(last)
  if (tail.trim()) out.push({ type: 'md', md: tail })
  return out
}
