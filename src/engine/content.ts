/**
 * 内容管线引擎（吸收自 Python content.py；生成动作本身由 AI agent 执行）。
 *
 * - 生成队列 课程根/state/生成队列.md 的读写与 T1/T2 触发
 * - 上下文包组装：agent 生成课程前拿到的全部资产
 * - 质检门：超纲引用检测 / 别名一致性（SymPy 自检脚本门随 Python 引擎退役）
 * - 反馈重生成协议：内容反馈区 → flagged → 重生成条目
 * - gen-exercises：题组过 schema/结构门禁后写入练习区（计数同步 + journal）
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { YAML } from './yaml.ts'
import { todayStr } from './dates.ts'
import { loadNote, saveNote } from './notes.ts'
import { normChoice } from './grading.ts'
import { RENDERERS, PLAIN_CODE_LANGS, SECTION_TYPES, INTERACTIVE_TYPES, parseSectionTitle, rendererCapabilityBlock } from '../../shared/content-renderers.ts'
import type { InteractiveType } from '../../shared/content-renderers.ts'
import type { GRegion, GNode, SectionManifest } from './types.ts'
import type { Graph } from './graph.ts'
import type { Paths } from './paths.ts'
import type { Fm, CourseEntry, JournalRec } from './types.ts'

export const QUEUE_GENERATE = '生成'
export const QUEUE_REGEN = '重生成'

export interface ExerciseMeta {
  ex: number
  q?: string
  answer?: string
  check?: string
  difficulty?: number
  uses?: string[]
  options?: string[]
  tol?: number
}

export class Content {
  constructor(private paths: Paths) {}

  // ---- 生成队列 ----

  private async queueLines(root: string): Promise<string[] | null> {
    const p = this.paths.queuePath(root)
    if (!existsSync(p)) return null
    return (await readFile(p, 'utf8')).split('\n')
  }

  async queueInit(root: string): Promise<void> {
    const p = this.paths.queuePath(root)
    if (existsSync(p)) return
    await mkdir(this.paths.courseStateDir(root), { recursive: true })
    await writeFile(p, '# 生成队列\n\n> 待生成/待重生成清单。引擎自动维护，人可编辑；完成条目打勾即止。\n', 'utf8')
  }

  /** 入队一条任务；同节点同 kind 未完成条目不重复。 */
  async queueAdd(root: string, kind: string, node: string, reason: string, priority = '中'): Promise<boolean> {
    await this.queueInit(root)
    const lines = (await this.queueLines(root))!
    for (const ln of lines) {
      if (ln.startsWith('- [ ]') && ln.includes(`${kind}：${node}`)) return false
    }
    lines.push(`- [ ] ${kind}：${node} ｜ ${reason} ｜ 优先：${priority}`)
    await writeFile(this.paths.queuePath(root), lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8')
    return true
  }

  /** 解析生成队列未完成项 → [{kind, node, reason, priority}]。 */
  async queueItems(root: string): Promise<Array<{ kind: string; node: string; reason: string; priority: string }>> {
    const items = []
    for (const ln of (await this.queueLines(root)) ?? []) {
      const m = ln.match(/^- \[ \] (生成|重生成)：(.+?) ｜ (.*?) ｜ 优先：(.+)$/)
      if (m) items.push({ kind: m[1], node: m[2], reason: m[3], priority: m[4] })
    }
    return items
  }

  /** apply 落盘后勾掉该节点的未完成条目。 */
  async queueDone(root: string, node: string): Promise<boolean> {
    const lines = await this.queueLines(root)
    if (!lines) return false
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- \[ \] (生成|重生成)：(.+?) ｜/)
      if (m && m[2] === node) {
        lines[i] = '- [x] ' + lines[i].slice('- [ ] '.length)
        changed = true
      }
    }
    if (changed) await writeFile(this.paths.queuePath(root), lines.join('\n'), 'utf8')
    return changed
  }

  /** T1/T2 触发：返回 (触发类型, 节点) 列表。 */
  async onStageChange(
    root: string, graph: Graph, state: Record<string, Fm>, node: string, newStage: Fm['stage'],
  ): Promise<Array<['T1' | 'T2', string]>> {
    if (!['learning', 'review', 'mastered'].includes(newStage)) return []
    const added: Array<['T1' | 'T2', string]> = []
    const done = new Set(Object.entries(state).filter(([, f]) => f.stage === 'review' || f.stage === 'mastered').map(([n]) => n))
    done.add(node)
    for (const x of graph.succ[node] ?? []) {
      const xs = state[x]?.stage
      if (xs === 'learning' || xs === 'review' || xs === 'mastered') continue
      const pres = graph.preOf[x].filter(p => !graph.opt.has(p))
      const missing = pres.filter(p => !done.has(p))
      if (!missing.length) {
        if (await this.queueAdd(root, QUEUE_GENERATE, x, `触发：${node} 完成后解锁`, '高')) added.push(['T2', x])
      } else if (missing.length === 1 && missing[0] === node) {
        if (await this.queueAdd(root, QUEUE_GENERATE, x, `触发：${node} 的最后前置进入学习`, '中')) added.push(['T1', x])
      }
    }
    return added
  }

  // ---- 上下文包 ----

  /** 组装生成上下文包 → Markdown 文本。 */
  contextPack(graph: Graph, state: Record<string, Fm>, node: string, course?: string): string {
    const [, region, block] = graph.blockOf[node]
    const pres = graph.preOf[node]
    const succs = graph.succ[node] ?? []
    const enc = graph.encOf[node] ?? []
    const dSelf = graph.depth[node] ?? 0
    const isPractice = graph.typeOf[node] === 'practice'
    const out: string[] = []
    out.push(`# 生成上下文包：${node}`, '')
    out.push('## 1. 目标节点')
    out.push(`- 名称：${node} ｜ 区/块：${region} · ${block} ｜ 深度：${dSelf}${isPractice ? ' ｜ 类型：交互实践（practice）' : ''}`)
    out.push(`- pre：${pres.length ? pres.join('、') : '（无，根节点）'}`)
    if (graph.noteOf[node]) out.push(`- note：${graph.noteOf[node]}`)
    out.push('')
    out.push('## 2. 前置摘要（不要重复讲已教内容；下列结论可直接引用）')
    for (const p of pres) {
      const fm = state[p]
      if (fm && fm.content.version > 0) {
        out.push(`- **${p}**（已生成），实际教过的节：`)
        const secs = fm.content.sections ?? []
        if (secs.length) {
          for (const s of secs) out.push(`  - ${s.title}${s.points ? `（${s.points}）` : ''}`)
        } else {
          out.push('  - （节清单缺失，按节点名理解其内容）')
        }
      } else {
        const note = graph.noteOf[p]
        out.push(`- **${p}**（未生成${note ? `，note：${note}` : ''}）`)
      }
    }
    out.push('')
    out.push('## 3. 后继预告（如需收尾衔接，可在自然结束处一句话带过；不设固定栏目）')
    out.push(succs.length ? succs.join('、') : '（无后继，终点节点）')
    out.push('')
    out.push('## 4. 领域边界')
    const scope = `本课属于${course ? `课程「${course}」的` : ''}`
    out.push(`${scope}「${region} · ${block}」区块。只讲本节点范围内的内容；后继节点至多在自然收尾处一句话带过，不展开、不提前教；是否提及由你判断。`)
    const forbidden = Object.keys(graph.nset)
      .filter(n => n !== node && n.length >= 2 && (graph.depth[n] ?? 0) > dSelf)
      .sort((a, b) => (graph.depth[b] ?? 0) - (graph.depth[a] ?? 0))
      .slice(0, 200)
    out.push('')
    out.push('## 5. 禁止使用的概念（未学，不得出现、不得引用其结论）')
    out.push(forbidden.length ? forbidden.join('、') : '（无：本节点已是图内最深）')
    out.push('')
    out.push('## 6. 规范约束')
    out.push('- 别名统一表：鸽巢原理（非抽屉原理）、勾股定理（非毕达哥拉斯定理）、余弦定理（非阿尔·卡西定理）——完整表见 理念与规范.md §8')
    out.push('- 风格：成人自学者；直觉先于严格、具体先于抽象、技能先于形式化')
    out.push(isPractice
      ? '- 篇幅：说明文字 ≤ 400 字；核心交付物是交互模拟（规范见 §8）'
      : '- 篇幅：正文 ≤ 2500 字；练习 基础 2–4 / 变式 2–3 / 挑战 0–2')
    out.push('- 小节：类型前缀 + 实际标题（类型菜单见提示词）；节的划分、顺序与类型配比完全由你按内容与风格判断，不设固定栏目与固定收尾段（可选保留 ## 内容反馈 区收集学习者建议）')
    out.push('')
    out.push('## 7. 既有 enc 边（练习必须真实调用它们）')
    out.push(enc.length ? enc.map(([t, w]) => `${t}(w=${w.toFixed(1)})`).join('、') : '（暂无）')
    out.push('')
    out.push('## 8. 交付要求')
    if (isPractice) {
      out.push(Content.interactiveSpecBlock())
      out.push('- 末尾机器块：`<!-- enc_candidates: [] -->`（交互实践不出练习题）')
    } else {
      out.push('- 练习题以题组 YAML 经 learnhub_exercises_gen 写入（不再直接写进正文练习区）；数值题给 tol 容差')
      out.push('- 题型优先 single_choice / true_false / fill_in_blank（可机器判卷）；开放性问答题用 reflection 并在 answer 写评分要点')
      out.push('- 末尾机器块：`<!-- enc_candidates: [本课练习真实调用的前置技能] -->`')
    }
    return out.join('\n') + '\n'
  }

  // ---- 提示词模板 ----

  /** practice/交互节交互件创作规范（注入上下文包 §8；契约吸收 OpenMAIC 五类交互场景模板经验）。
   * 面板经 /vendor 同源伺服 katex/three（沙箱 CSP 放开 'self'）；交互件内公式由伺服端自动注入
   * KaTeX 渲染（直接写 $…$/$$…$$）；类型菜单与 widget-config 契约见 shared INTERACTIVE_TYPES。 */
  static interactiveSpecBlock(): string {
    return `\
### 交互模拟创作规范（本节点的核心交付物）

输出一个完整自包含的 HTML 文档，包裹在标记块中（系统会落盘为独立文件并替换为引用块）：

\`\`\`learnhub-interactive:交互/<语义化名称>.html
<!DOCTYPE html>
...（完整 HTML）
\`\`\`

## 必备契约（每类交互件都要满足）

1. **widget-config 必填**：<head> 内嵌结构化元数据，面板据此识别类型——
   \`<script type="application/json" id="widget-config">{ "type": "<类型>", "description": "一句话说明", "variables": [{ "name": "angle", "label": "角度", "min": 0, "max": 90, "default": 45, "unit": "°" }], "presets": [{ "name": "预设名", "state": { "angle": 30 } }] }</script>\`
2. **完成上报**：达成模拟目标时在文档末尾加
   \`<script>window.parent.postMessage({type:'LEARNHUB_COMPLETE', score: <0-1 可选成绩>, detail: '一句话结论'}, '*')</script>\`
3. **AI 老师操作接口**（必须实现；面板「问 AI 老师」会广播 LEARNHUB_TEACHER 消息驱动交互件演示）——把下面样板原样放进你的 <script>：
   \`window.addEventListener('message', function (e) { if (!e.data || e.data.type !== 'LEARNHUB_TEACHER') return; switch (e.data.action) { case 'highlight': { /* e.data.selector 高亮该元素 3s */ break } case 'setState': { /* e.data.state: {变量名: 值} 应用到模拟 */ break } case 'reveal': { /* e.data.selector 显示隐藏元素 */ break } case 'annotate': { /* e.data.text 顶部批注气泡 4s */ break } } })\`
   selector 用 CSS 选择器（如 '#angle-slider'、'#canvas'）；每个 case 必须用块作用域 {} 包裹（防重声明 SyntaxError）。
4. **单文件自包含**：全部 CSS/JS 内联；禁止外部 CDN 与网络请求。沙箱只放行同源 /learnhub/api/vendor/ 下的 katex 与 three 库（写法见 visualization3d）；公式直接写 $…$/$$…$$，伺服端自动注入 KaTeX 渲染，无需手写渲染代码。
5. **状态机清晰**：running/paused/ended 三态分离；reset 复位**所有**状态变量；按钮文案与点击后的动作一致（启动/暂停/继续/重新开始）。
6. **动画必须肉眼可见**：启动后对象明显移动/旋转/变化（requestAnimationFrame），让学习者一眼确认「在动」。
7. **移动端友好**：控制区与画布上下堆叠不重叠（320px 可用）；触控目标 ≥44px；canvas 用 ResizeObserver 自适应容器。
8. **实时数据**等宽字体显示并带单位；控件加 ARIA 标签；画布文字高对比。

## 类型菜单（widget-config 的 type，按内容选一个）

- **simulation**：过程仿真（物理/化学/经济/算法…）。≥2 个变量滑杆 + ≥2 个预设按钮；应用预设完整复位后运行；结束时给成败/结论反馈。
- **visualization3d**：3D 可视化（几何体/分子/天体/结构…）。用 vendored three（禁止 CDN）：
  \`<script type="importmap">{ "imports": { "three": "/learnhub/api/vendor/three/build/three.module.js", "three/addons/": "/learnhub/api/vendor/three/examples/jsm/" } }</script>\`
  然后 \`import * as THREE from 'three'\`、\`import { OrbitControls } from 'three/addons/controls/OrbitControls.js'\`。
  背景不用纯黑（如 #0a0a1a）；环境光 ≥0.5 + 半球光 + 主平行光让物体清晰可见；必须给放大/缩小按钮（移动端无滚轮）；WebGL 检测失败显示降级提示。
- **diagram**：可操作图解（思维导图/流程/关系图…）。节点可点击展开细节，支持增删/连线更佳。
- **game**：知识小游戏（分类/竞速/拼图…）。规则 30 秒内可懂；计分与 LEARNHUB_COMPLETE 的 score 上报绑定。
- **code**：在线编程（纯 JS，不引外部运行时）。代码编辑器 + 运行按钮 + 输出面板；用户代码在 Web Worker 或 new Function 内执行（防死循环卡 UI）；预置 2-3 个任务与可运行示例。

## 输出格式

只输出一个完整 HTML 文档（恰好一个 <!DOCTYPE html> 与一个 </html>），不要解释。
说明文字（上下文包正文）只做导览：看什么、调什么、观察什么规律，≤ 400 字。`
  }

  static readonly PROMPT_KINDS: Record<string, string> = {
    // 风格变体作用于「课程节生成」（课程节生成-<风格>）；整课版「课程生成*」已随
    // 大纲→逐节管线退役——旧 vault 快照文件不再被读取，可手工清理。
    课程大纲: `\
<!-- learnhub:prompt/v5 -->
# 课程大纲提示词（用户可编辑；生成时上下文包自动附在本模板之后）

你是 learnhub 学习系统的课程设计师。根据附后的上下文包，把目标节点的一课拆成依次学习的「节」清单；每节之后会单独生成正文。

## 设计原则

1. 节的划分、数量、顺序与类型配比完全由你根据课程内容、主题与讲解风格判断，选择最自然的讲解骨架：不套固定栏目，不设固定收尾段（无强制的过渡节/总结节）。
2. 一节 = 一个可完成的学习单元（一个概念、一道例题、一次演示、一次动手练习或一个交互模拟）；标题描述本节具体内容，不用栏目化通名；一节 = 学习页 1–2 屏——一个知识点需要 公式+推导+例题+图 才能讲完时拆成多个节；节内不允许再分小节（### 子标题会被质检门拒绝）。
3. type 从节类型菜单选（概念/例题/演示/小结/练习/交互）；练习节可选（整课可以没有练习节）；节类型配比按内容选组合模式，例如：连续 2–3 个概念节后跟一个练习节集中练、概念-演示穿插、全概念无练习节——不要机械地一节内容跟一节练习。
4. 通常 3–8 节，可按内容增减；相邻节之间要有学习上的递进关系（逐节生成时会注入前节已生成正文保证连贯）。

## 输出

只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

node: <节点名>
sections:
  - id: s1
    title: 概念：整数与自然数的分界
    type: 概念
    points: 本节要点（一句话）
    visual: 公式|mermaid|图片|交互|示意图|函数图|图表 之一（本节的讲解主体可视化——学习页文字宜少、公式/图/交互宜多，几乎每节都有，确无才写「无」；示意图=\`\`\`svg、函数图=\`\`\`plot、图表=\`\`\`chart）
`,
    课程节生成: `\
<!-- learnhub:prompt/v5 -->
# 课程节生成提示词（用户可编辑；系统附上：节清单、本节任务、前节已生成正文、上下文包）

你是 learnhub 学习系统的课程写手。根据附后的材料，只写「本节任务」指定的这一节正文。

## 硬约束（违反即返工）

1. 只输出一节：以 \`## 类型：标题\` 开头（标题与类型精确照抄本节任务），后接本节正文；不写其他节、不写 frontmatter。
2. 只用前置已教概念与常识；「禁止使用的概念」一节列出的名称不得出现，也不得引用其结论。
3. 不超出「领域边界」声明的区块范围；后继内容至多在自然收尾处一句话带过。
4. 可视化为主、文字为辅：讲解本体用公式/mermaid 图/svg 示意图/plot 函数图/chart 图表/交互件承载，文字只做引导与衔接（≤150 字），不写大段解说；每节至少一个可视化（交互节为交互件本身）；节内不写 ### 子标题；不在正文自设练习/趁热练习环节——练习由题库与练习节承载。
5. 与「前一节已生成正文」自然衔接：不重复它讲过的内容，开头不复述前节结论。
6. 排版约定：并列的误区/注意/要点块用 blockquote（> 首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点/边文本含 | { } " # 等特殊字符时必须整体双引号包裹（如 \`A["文本"]\`），否则渲染降级为源码。
7. 别名按「规范约束」统一；图片用 \`![[<课程根>/课程图/xx.png]]\`。

{{renderers}}

## 输出

只输出本节正文（## 标题 + 内容），不要附加解释。
`,
    '课程节生成-苏格拉底': `\
<!-- learnhub:prompt/v5 -->
# 课程节生成提示词——苏格拉底风格（用户可编辑；系统附上：节清单、本节任务、前节已生成正文、上下文包）

你是 learnhub 学习系统的苏格拉底式导师。根据附后的材料，只写「本节任务」指定的这一节正文：少给结论，多给「好问题 + 逐步逼近的思路」，让学习者在回答问题中自己建构知识。

## 硬约束（违反即返工）

1. 只输出一节：以 \`## 类型：标题\` 开头（标题与类型精确照抄本节任务），后接本节正文；不写其他节、不写 frontmatter。
2. 只用前置已教概念与常识；「禁止使用的概念」一节列出的名称不得出现，也不得引用其结论。
3. 不超出「领域边界」声明的区块范围；后继内容至多在自然收尾处一句话带过。
4. 可视化为主、文字为辅：讲解本体用公式/mermaid 图/svg 示意图/plot 函数图/chart 图表/交互件承载，文字只做引导与衔接（≤150 字），不写大段解说；每节至少一个可视化（交互节为交互件本身）；节内不写 ### 子标题；不在正文自设练习/趁热练习环节——练习由题库与练习节承载。
5. 风格约束：以引导问题推进——先给观察/反例式好问题，再一小步逼近，问题后紧跟「锚点」（一两句最低限度的正确方向提示，不是答案）；结论只在问题链走完后给出。
6. 与「前一节已生成正文」自然衔接：不重复它讲过的内容，开头不复述前节结论。
7. 排版约定：并列的误区/注意/要点块用 blockquote（> 首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点/边文本含 | { } " # 等特殊字符时必须整体双引号包裹（如 \`A["文本"]\`），否则渲染降级为源码。
8. 别名按「规范约束」统一；图片用 \`![[<课程根>/课程图/xx.png]]\`。

{{renderers}}

## 输出

只输出本节正文（## 标题 + 内容），不要附加解释。
`,
    '课程节生成-费曼': `\
<!-- learnhub:prompt/v5 -->
# 课程节生成提示词——费曼风格（用户可编辑；系统附上：节清单、本节任务、前节已生成正文、上下文包）

你是 learnhub 学习系统的费曼式讲解员。根据附后的材料，只写「本节任务」指定的这一节正文：假设学习者要把这节课讲给一个聪明的十二岁孩子听，用最朴素的类比和日常语言把概念讲透，再逐步引入正式记号。

## 硬约束（违反即返工）

1. 只输出一节：以 \`## 类型：标题\` 开头（标题与类型精确照抄本节任务），后接本节正文；不写其他节、不写 frontmatter。
2. 只用前置已教概念与常识；「禁止使用的概念」一节列出的名称不得出现，也不得引用其结论。
3. 不超出「领域边界」声明的区块范围；后继内容至多在自然收尾处一句话带过。
4. 可视化为主、文字为辅：讲解本体用公式/mermaid 图/svg 示意图/plot 函数图/chart 图表/交互件承载，文字只做引导与衔接（≤150 字），不写大段解说；每节至少一个可视化（交互节为交互件本身）；节内不写 ### 子标题；不在正文自设练习/趁热练习环节——练习由题库与练习节承载。
5. 风格约束：每个核心概念按「生活类比（并明确说类比在哪里失效）→ 朴素语言解释 → 正式定义/记号」推进；节末收一个「讲给别人听」的自测问题。
6. 与「前一节已生成正文」自然衔接：不重复它讲过的内容，开头不复述前节结论。
7. 排版约定：并列的误区/注意/要点块用 blockquote（> 首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点/边文本含 | { } " # 等特殊字符时必须整体双引号包裹（如 \`A["文本"]\`），否则渲染降级为源码。
8. 别名按「规范约束」统一；图片用 \`![[<课程根>/课程图/xx.png]]\`。

{{renderers}}

## 输出

只输出本节正文（## 标题 + 内容），不要附加解释。
`,
    题目生成: `\
<!-- learnhub:prompt/v4 -->
# 题目生成提示词（用户可编辑；节点正文由系统附在本模板之后）

你是 learnhub 学习系统的出题老师。根据附后的节点正文出一组练习题，覆盖正文的核心概念、易错点与典型应用。

## 硬约束

1. 题型必须多样，只用以下九种，不要全出同一题型：
   - 单选（single_choice）：options 列 4 项、answer 为一个正确选项字母。
   - 多选（multi_choice）：options 列 4 项、answer 为正确选项**字母数组**（如 ["A","C"]，至少 2 个正确项）。
   - 判断（true_false）：answer 为 对/错。
   - 填空（fill_in_blank）：answer 为**可接受答案数组**（同义写法都列出）。
   - 数值（numeric）：answer 为数值，必须同时给 tol 容差（如 0.01）；适合计算/估算题。
   - 排序（ordering）：options 为**乱序**的步骤/事件项（每项短且互不相同）、answer 为**正确顺序的项文本数组**（同一组项的重排）。
   - 配对（matching）：options 为左列项（≥2，短且互异）、answer 为与左列**一一对应**的右列文本数组（第 i 项是第 i 个左项的配对）。
   - 反思（reflection）：开放式小反思，answer 写评分要点。
   - 开放题（open_question）：**考整个课时内容的综合应用**（跨节综合，不是单节细节），section 固定写「通用」；answer 写参考要点（可省略）。每轮最多 1 道。
2. 难度递进：开头 1-2 道概念辨析（difficulty: 1），中间应用与计算（difficulty: 2），收尾综合或易错陷阱（difficulty: 3）+ 至多 1 道开放题。
3. 每题必须给全：题干、答案、解析（说明为什么对、错误选项错在哪）；几何/函数/数据类题的解析可用一个 \`\`\`svg 或 \`\`\`plot 代码块配图。
4. 只考正文里讲过的内容，不得引入正文没有的概念、记号或结论。
5. 选择题 options 不带 A./B. 编号前缀（系统自动编号）；填空题 answer 用数组列出所有可接受写法；node 字段原样照抄系统给出的节点名。
6. 每题标注 \`section\`：系统提供节标注清单时，section 必须**精确照抄清单中的节 id**（如 \`s2\`）；未提供清单时照抄正文节标题原文（如「概念：定义与性质」）；跨节综合题一律写「通用」。

## 输出

只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

node: <节点名>
questions:
  - id: q1
    kind: single_choice
    q: 题干
    options: ["选项一", "选项二", "选项三", "选项四"]
    answer: A
    explanation: 解析
    difficulty: 1
    section: 概念：定义与性质
    uses: [用到的前置概念]
`,
  }

  /** 读提示词模板；内置模板带版本标记，vault 快照缺标记或版本更低时覆盖升级（旧文件存 .bak 供 diff 恢复），
   * 非内置类型要求用户已自建同名文件。
   * {{renderers}} 占位符注入渲染能力清单；旧模板缺占位符时在末尾追加注入段（运行时兜底，不改用户文件）。 */
  async loadPrompt(kind: string): Promise<string> {
    const builtin = Content.PROMPT_KINDS[kind]
    await mkdir(this.paths.promptDir, { recursive: true })
    const p = `${this.paths.promptDir}/${kind}.md`
    if (!builtin && !existsSync(p)) {
      throw new Error(`[prompt] 未知提示词类型: ${kind}（内置：${Object.keys(Content.PROMPT_KINDS).join('、')}；或在 state/提示词/ 自建 ${kind}.md）`)
    }
    if (builtin) {
      const vaultVer = existsSync(p) ? Content.promptVersionOf(await readFile(p, 'utf8')) : 0
      if (vaultVer < Content.promptVersionOf(builtin)) {
        if (existsSync(p)) await writeFile(`${p}.bak`, await readFile(p, 'utf8'), 'utf8')
        await writeFile(p, builtin, 'utf8')
      }
    }
    const text = await readFile(p, 'utf8')
    const caps = rendererCapabilityBlock()
    if (text.includes('{{renderers}}')) return text.replaceAll('{{renderers}}', caps)
    return text.trimEnd() + '\n\n' + caps
  }

  /** 内置模板首行版本标记 → 数字；无标记（历史快照）= 0，下次 loadPrompt 即升级。 */
  static promptVersionOf(text: string): number {
    const m = /^<!-- learnhub:prompt\/v(\d+) -->/.exec(text)
    return m ? Number(m[1]) : 0
  }

  /** 可用提示词类型 = 内置 + state/提示词/ 下的自建变体（去 .md）。 */
  async promptKinds(): Promise<string[]> {
    const names = new Set(Object.keys(Content.PROMPT_KINDS))
    try {
      for (const f of await readdir(this.paths.promptDir)) {
        if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''))
      }
    } catch {
      // 提示词目录缺失 = 只有内置
    }
    return [...names].sort()
  }

  // ---- 质检门 ----

  /** 解析课程理念与规范.md §8 别名表 → {不采用名: 采用名}。 */
  private async aliasTable(root: string): Promise<Record<string, string>> {
    const p = `${this.paths.courseRoot(root)}/理念与规范.md`
    const table: Record<string, string> = {}
    if (!existsSync(p)) return table
    let inSection = false
    for (const line of (await readFile(p, 'utf8')).split('\n')) {
      if (line.startsWith('## 8.')) {
        inSection = true
        continue
      }
      if (inSection && line.startsWith('## ')) break
      if (inSection && line.startsWith('|') && !line.includes('采用名') && !line.includes('---')) {
        const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
        if (cells.length >= 2 && cells[0] && cells[1]) table[cells[1]] = cells[0]
      }
    }
    return table
  }

  private stripRoadmapSections(body: string): string {
    const out: string[] = []
    let skip = false
    for (const ln of body.split('\n')) {
      if (ln.startsWith('## ')) skip = ln.trim().startsWith('## 承上启下') || ln.trim().startsWith('## 内容反馈')
      if (!skip) out.push(ln)
    }
    return out.join('\n')
  }

  /** 超纲引用检测：正文提到的图内概念深度大于本节点 → 警告。 */
  checkOutOfScope(graph: Graph, node: string, body: string): string[] {
    const checked = this.stripRoadmapSections(body)
    const dSelf = graph.depth[node] ?? 0
    const hits = new Set<string>()
    for (const name of graph.nset) {
      if (name === node || name.length < 2) continue
      if ((graph.depth[name] ?? 0) > dSelf && checked.includes(name)) hits.add(name)
    }
    return [...hits].sort()
  }

  /** 节形状门禁：节内 ### 子标题破坏原子性（finding）；节 prose 过长
   * （warn >600 / finding >2000；长度剥离代码块/行内代码/公式/机器注释后计数——
   * 公式与图表不占文字预算，可视化为辅的文字纪律才有硬约束）。 */
  static checkSectionShape(body: string): { findings: string[]; warns: string[] } {
    const findings: string[] = []
    const warns: string[] = []
    for (const part of body.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      if (!title || title.startsWith('<!--')) continue // 机器区不参与节形状
      const md = nl >= 0 ? part.slice(nl + 1) : ''
      if (/^### /m.test(md)) {
        findings.push(`节「${title}」内出现 ### 子标题（破坏节的原子性：一节只讲一个知识点，需要分层就拆成多个节）`)
      }
      const prose = md
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '')
        .replace(/\$\$[\s\S]*?\$\$/g, '')
        .replace(/\$[^$\n]+\$/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, '')
      if (prose.length > 2000) {
        findings.push(`节「${title}」正文过长（约 ${prose.length} 字）：一节 = 学习页 1–2 屏，把内容拆成多个节`)
      } else if (prose.length > 600) {
        warns.push(`节「${title}」正文偏长（约 ${prose.length} 字）：可视化为主、文字为辅，超过 600 字建议压缩或拆节`)
      }
    }
    return { findings, warns }
  }

  /** mermaid 引号启发：节点/边文本含 | 等会破坏语法解析的字符且未整体双引号包裹 → warn
   * （渲染降级为源码块的高频根因，如 `B[模 |v| = …]`）。 */
  static checkMermaidQuotes(body: string): string[] {
    const warns: string[] = []
    for (const mm of body.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
      for (const line of mm[1].split('\n')) {
        const t = line.trim()
        // 未加引号的节点标签里出现 |（| 是 mermaid 的边语法）；已有 " 包裹的不报
        if (/\[[^"\]]*\|[^"\]]*\]/.test(t)) {
          warns.push(`mermaid 节点文本含「|」未用双引号包裹，渲染会降级为源码：${t.slice(0, 60)}`)
          break
        }
      }
    }
    return warns
  }

  /** 别名一致性：正文出现不采用名 → findings。 */
  async checkAliases(root: string, body: string): Promise<string[]> {
    const table = await this.aliasTable(root)
    return Object.entries(table)
      .filter(([bad]) => body.includes(bad))
      .map(([bad, good]) => `别名不一致: 正文用了「${bad}」，应采用「${good}」`)
  }

  /** 未注册的代码块语言（面板无渲染器、会降级为源码显示）→ 警告，防 AI 产出渲染不了的块。 */
  static checkRendererLangs(body: string): string[] {
    const known = new Set(RENDERERS.map(r => r.lang))
    const hits = new Set<string>()
    for (const m of body.matchAll(/^```([A-Za-z0-9_-]+)/gm)) {
      const lang = m[1].toLowerCase()
      if (lang && !known.has(lang) && !PLAIN_CODE_LANGS.has(lang)) hits.add(lang)
    }
    return [...hits].sort()
  }

  /** 富内容块语法门：plot/chart 必须是合法 JSON 对象、svg 必须以 <svg 开头
   * （这些块渲染器会降级为源码显示，生成侧越早拦截返工成本越低）。
   * 围栏行容忍尾随空白与 CRLF：闭合 ``` 后的空格会让捕获越过本块吞进下一个代码块
   * （合法 JSON 被误报非法），开头 ```plot 后的空格则让非法块漏检。 */
  static checkVisualBlocks(body: string): string[] {
    const findings: string[] = []
    let i = 0
    for (const m of body.matchAll(/^```plot[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm)) {
      i++
      if (!Content.isPlainJsonObject(m[1])) findings.push('```plot 第 ' + i + ' 块不是合法 JSON 对象（面板会降级为源码显示）')
    }
    i = 0
    for (const m of body.matchAll(/^```chart[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm)) {
      i++
      if (!Content.isPlainJsonObject(m[1])) findings.push('```chart 第 ' + i + ' 块不是合法 JSON 对象（面板会降级为源码显示）')
    }
    i = 0
    for (const m of body.matchAll(/^```svg[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm)) {
      i++
      if (!/^\s*<svg[\s>]/i.test(m[1])) findings.push('```svg 第 ' + i + ' 块必须以 <svg 开头（完整 SVG 片段）')
    }
    return findings
  }

  private static isPlainJsonObject(text: string): boolean {
    try {
      const v: unknown = JSON.parse(text)
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    } catch {
      return false
    }
  }

  /** 跑全部可自动化的质检门 → (passed, findings, warns)。 */
  async gateReport(graph: Graph, root: string, node: string, body: string): Promise<{ passed: boolean; findings: string[]; warns: string[] }> {
    const findings: string[] = []
    const warns: string[] = []
    const oos = this.checkOutOfScope(graph, node, body)
    if (oos.length) warns.push(`超纲引用（引用了更深的未学概念）: ${oos.join('、')}`)
    findings.push(...(await this.checkAliases(root, body)))
    // 练习元数据 uses 标注：仅当正文存在练习元数据时才检查——节级落盘（sectionApply）
    // 的单节正文不含练习区（练习由题库在出题阶段写入），无条件检查会对每节误报。
    if (/<!--\s*ex:\d+/.test(body) && !/uses:\s*\[[^\]]/.test(body)) {
      warns.push('练习元数据缺少 uses 标注（一期尽力标注，建议补上）')
    }
    const badLangs = Content.checkRendererLangs(body)
    if (badLangs.length) warns.push(`未注册的代码块语言（面板无法渲染，请改用支持的格式）: ${badLangs.join('、')}`)
    findings.push(...Content.checkVisualBlocks(body))
    const checkedBody = this.stripRoadmapSections(body)
    const shape = Content.checkSectionShape(checkedBody)
    findings.push(...shape.findings)
    warns.push(...shape.warns)
    warns.push(...Content.checkMermaidQuotes(checkedBody))
    const missingInteractive: string[] = []
    for (const m of body.matchAll(/```interactive\n([^\n]+)\n```/g)) {
      // 引用块统一存「学习中心相对路径」（extractInteractive 写入 <课程根>/<rel>，交互件伺服按同一路径解析）
      const rel = m[1].trim()
      if (!existsSync(`${this.paths.centerRoot}/${rel}`)) missingInteractive.push(rel)
    }
    if (missingInteractive.length) {
      findings.push(`interactive 引用的交互件文件不存在: ${missingInteractive.join('、')}`)
    }
    return { passed: !findings.length, findings, warns }
  }

  /** 解析正文中的 learnhub-interactive 标记块 → (替换后的正文, 待落盘交互件, 非法路径列表)。
   * 标记块 ```learnhub-interactive:<课程根相对路径> + 完整 HTML``` → 正文替换为
   * ```interactive 引用块（vault 相对路径），HTML 由 contentApply 在质检门前落盘。 */
  static extractInteractive(body: string, courseRoot: string): {
    body: string
    files: Array<{ rel: string; html: string }>
    invalid: string[]
  } {
    const files: Array<{ rel: string; html: string }> = []
    const invalid: string[] = []
    const out = body.replace(
      /```learnhub-interactive:([^\n]+)\n([\s\S]*?)```/g,
      (whole, rawRel: string, html: string) => {
        const rel = rawRel.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const bad = !rel || !rel.toLowerCase().endsWith('.html')
          || rel.split('/').some(seg => !seg || seg === '.' || seg === '..')
        if (bad) {
          invalid.push(rawRel.trim())
          return whole
        }
        files.push({ rel, html: html.trim() + '\n' })
        return '```interactive\n' + `${courseRoot}/${rel}` + '\n```'
      },
    )
    return { body: out, files, invalid }
  }

  // ---- 节清单（逐节生成管线） ----

  /** 大纲 YAML → 节清单（id 唯一、type ∈ 节类型菜单、title 非空；全 pending）。 */
  static parseOutline(yamlText: string): SectionManifest[] {
    const doc = YAML.parseModel(yamlText) as { sections?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.sections) || !doc.sections.length) {
      throw new Error('[outline] 模型没有产出可用大纲（sections 为空）。')
    }
    const out: SectionManifest[] = []
    const ids = new Set<string>()
    doc.sections.forEach((raw, i) => {
      const e = (raw ?? {}) as Record<string, unknown>
      const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `s${i + 1}`
      const title = String(e.title ?? '').trim()
      const type = String(e.type ?? '').trim() || parseSectionTitle(title).type.prefix
      if (!title) throw new Error(`[outline] sections.${i + 1}.title 不能为空`)
      if (ids.has(id)) throw new Error(`[outline] sections.${i + 1}.id「${id}」重复`)
      if (!SECTION_TYPES.some(t => t.prefix === type)) {
        throw new Error(`[outline] sections.${i + 1}.type「${type}」不在节类型菜单（${SECTION_TYPES.map(t => t.prefix).join('/')}）`)
      }
      ids.add(id)
      const points = typeof e.points === 'string' ? e.points.trim() : ''
      out.push({ id, title, type, status: 'pending', version: 0, ...(points ? { points } : {}) })
    })
    return out
  }

  /** 大纲落盘：manifest 写入 frontmatter content.sections（全 pending），正文不动。
   * fm 现读（逐节连续落盘时调用方的 stateMap 已过期）。 */
  async outlineApply(
    root: string, graph: Graph, node: string, yamlText: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<SectionManifest[]> {
    const manifest = Content.parseOutline(yamlText)
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm, body } = await loadNote(path)
    if (!fm || typeof fm.node !== 'string') throw new Error(`[outline] 课程文件不存在（先为节点生成内容骨架）: ${node}`)
    await saveNote(path, { ...fm, content: { ...((fm.content as Record<string, unknown>) ?? {}), sections: manifest } }, body)
    await journal({ course: '', node, rating: null, kind: 'content_outline', elapsed_days: 0, detail: `节清单 ${manifest.length} 节落盘（全 pending）` })
    return manifest
  }

  /** 单节落盘：交互件标记块先拆出落盘 → 节级质检门 → 正文按清单手术重组 →
   * 该节 status=ready/version+1、content.version+1（draft）；hints = enc 候选反哺图的补边提醒。
   * 门禁未过抛 code=GATE_FAILED 的错误（自动修复回路据此识别，其余错误原样传播）。 */
  async sectionApply(
    root: string, graph: Graph, node: string, sectionId: string, md: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<{ version: number; title: string }> {
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm, body } = await loadNote(path)
    if (!fm || typeof fm.node !== 'string') throw new Error(`[section] 课程文件不存在: ${node}`)
    const sections = ((fm.content as { sections?: SectionManifest[] } | undefined)?.sections) ?? []
    const entry = sections.find(m => m.id === sectionId)
    if (!entry) throw new Error(`[section] 节点「${node}」的节清单里没有「${sectionId}」——先运行大纲。`)
    const split = Content.extractInteractive(md, root)
    if (split.invalid.length) {
      throw new Error(`[section] learnhub-interactive 标记块路径非法（只允许课程根内相对 .html 路径，无 ..）: ${split.invalid.join('、')}`)
    }
    for (const f of split.files) {
      const target = `${this.paths.courseRoot(root)}/${f.rel}`
      await mkdir(target.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
      await writeFile(target, f.html, 'utf8')
    }
    // 提示词要求模型输出以 `## 标题` 开头，本方法按清单再包一层同名标题——先剥掉，避免正文标题重复
    const sectionMd = Content.stripLeadingSectionTitle(split.body, entry.title)
    const gate = await this.gateReport(graph, root, node, `## ${entry.title}\n\n${sectionMd}`)
    const html = Content.checkInteractiveHtml(split.files)
    if (gate.findings.length || html.findings.length) {
      const e: Error & { code?: string } = new Error(`[section] 「${entry.title}」质检门未过：\n${[...gate.findings, ...html.findings].map(x => `  ✗ ${x}`).join('\n')}\n${[...gate.warns, ...html.warns].map(w => `  ⚠ ${w}`).join('\n')}`)
      e.code = 'GATE_FAILED'
      throw e
    }
    const nextSections = sections.map(m => (m.id === sectionId ? { ...m, status: 'ready' as const, version: m.version + 1 } : m))
    const newBody = Content.assembleBody(body, sections, new Map([[entry.title, sectionMd.trim()]]))
    const version = (((fm.content as { version?: number } | undefined)?.version) ?? 0) + 1
    await saveNote(path, {
      ...fm,
      content: {
        ...((fm.content as Record<string, unknown>) ?? {}),
        version,
        generated_at: todayStr(),
        status: 'draft',
        sections: nextSections,
      },
    }, newBody)
    await journal({ course: '', node, rating: null, kind: 'content_section', elapsed_days: 0, detail: `节「${entry.title}」v${entry.version + 1} 落盘` })
    return { version, title: entry.title, hints: Content.encBackfeedHints(graph, node, sectionMd) }
  }

  /** 模型按提示词自带 `## 标题` 首行，落盘时由 sectionApply 按清单统一包标题——
   * 首个非空行恰为同名 `## 标题` 时剥掉（容忍行尾空白），否则原样返回。 */
  static stripLeadingSectionTitle(md: string, title: string): string {
    const lines = md.split('\n')
    let first = 0
    while (first < lines.length && !lines[first].trim()) first++
    return lines[first]?.trim() === `## ${title}` ? lines.slice(first + 1).join('\n').replace(/^\n+/, '') : md
  }

  /** 整篇正文按节清单重组：intro（首个 ## 之前）与保护区（练习/答案/内容反馈/机器块）原样保留；
   * 清单节用 provided md，否则沿用既有同名节，两者皆无（pending）则不进正文；
   * 既有内容节不在清单内即丢弃（重生成语义）。 */
  static assembleBody(existing: string, manifest: SectionManifest[], provided: Map<string, string>): string {
    const encBlock = existing.match(/<!--\s*enc_candidates:[^>]*-->/)?.[0] ?? ''
    const withoutEnc = encBlock ? existing.replace(encBlock, '') : existing
    const parts = withoutEnc.split(/^## /m)
    const intro = (parts[0] ?? '').trim()
    const existingSections = new Map<string, string>()
    const tail: string[] = []
    for (const part of parts.slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      const md = nl >= 0 ? part.slice(nl + 1) : ''
      const isProtected = title.startsWith('<!--') || ['练习', '答案', '内容反馈'].includes(title)
      if (isProtected) tail.push(`## ${part.trimEnd()}`)
      else existingSections.set(title, md.trim())
    }
    const out: string[] = []
    if (intro) out.push(intro)
    for (const m of manifest) {
      const md = provided.get(m.title) ?? existingSections.get(m.title)
      if (!md) continue // pending 节不进正文（生成后由本方法追加）
      out.push(`## ${m.title}\n\n${md}`)
    }
    out.push(...tail)
    if (encBlock) out.push(encBlock)
    return out.join('\n\n') + '\n'
  }

  /** 从整篇正文重导出节清单（整节点重生成/风格变体后 manifest 与正文重对齐，全部 ready）。 */
  static manifestFromBody(body: string, version: number): SectionManifest[] {
    const out: SectionManifest[] = []
    for (const part of body.split(/^## /m).slice(1)) {
      const title = (part.indexOf('\n') >= 0 ? part.slice(0, part.indexOf('\n')) : part).trim()
      if (!title || title.startsWith('<!--') || ['练习', '答案', '内容反馈'].includes(title)) continue
      out.push({ id: `s${out.length + 1}`, title, type: parseSectionTitle(title).type.prefix, status: 'ready', version })
    }
    return out
  }

  /** 交互件 HTML 门禁：体积上限、禁外联、完成上报必查；widget-config 契约缺失降级为警告
   * （存量 v1 交互件不返工，新生成由提示词保证）。 */
  static checkInteractiveHtml(files: Array<{ rel: string; html: string }>): { findings: string[]; warns: string[] } {
    const findings: string[] = []
    const warns: string[] = []
    for (const f of files) {
      if (f.html.length > 200 * 1024) findings.push(`交互件单文件超过 200KB: ${f.rel}`)
      if (/(?:src|href)\s*=\s*["']https?:\/\//i.test(f.html) || /fetch\(|XMLHttpRequest/.test(f.html)) {
        findings.push(`交互件含外联资源或网络调用（沙箱内不可用，需自包含）: ${f.rel}`)
      }
      if (!f.html.includes('LEARNHUB_COMPLETE')) findings.push(`交互件缺少 LEARNHUB_COMPLETE 完成上报: ${f.rel}`)
      if (!f.html.includes('LEARNHUB_TEACHER')) warns.push(`交互件未实现 LEARNHUB_TEACHER 监听（AI 老师无法驱动演示）: ${f.rel}`)
      const m = /<script[^>]*type="application\/json"[^>]*id="widget-config"[^>]*>([\s\S]*?)<\/script>/i.exec(f.html)
      if (!m) {
        warns.push(`交互件缺少 widget-config 元数据（建议补 {type, description}）: ${f.rel}`)
        continue
      }
      try {
        const cfg = JSON.parse(m[1]) as { type?: unknown }
        if (typeof cfg.type !== 'string' || !INTERACTIVE_TYPES.includes(cfg.type as InteractiveType)) {
          findings.push(`交互件 widget-config.type「${String(cfg.type)}」不在类型菜单（${INTERACTIVE_TYPES.join('/')}）: ${f.rel}`)
        }
      } catch {
        findings.push(`交互件 widget-config JSON 不可解析: ${f.rel}`)
      }
    }
    return { findings, warns }
  }

  // ---- 练习区 ----

  /** 解析练习元数据行 → [{ex, answer, check, difficulty, uses, options?, tol?}]。 */
  static practiceMeta(body: string): ExerciseMeta[] {
    const out: ExerciseMeta[] = []
    for (const m of body.matchAll(/<!--\s*ex:(\d+)\s*\|([^>]*)-->/g)) {
      const fields: ExerciseMeta = { ex: Number(m[1]) }
      for (const part of m[2].split('|')) {
        const p = part.trim()
        const ci = p.indexOf(':')
        if (ci < 0) continue
        const k = p.slice(0, ci).trim()
        const v = p.slice(ci + 1).trim()
        if (k === 'uses') {
          fields.uses = v.replace(/^\[|\]$/g, '').split(',').map(x => x.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean)
        } else if (k === 'difficulty') {
          fields.difficulty = /^\d+$/.test(v) ? Number(v) : 1
        } else if (k === 'options') {
          fields.options = v.split('；').map(x => x.trim()).filter(Boolean)
        } else if (k === 'tol') {
          const n = Number(v)
          if (Number.isFinite(n)) fields.tol = n
        } else {
          ;(fields as Record<string, unknown>)[k] = v
        }
      }
      out.push(fields)
    }
    return out
  }

  /** 解析 enc 候选机器块 → [节点名]。 */
  static encCandidates(body: string): string[] {
    const m = body.match(/<!--\s*enc_candidates:\s*\[([^\]]*)\]\s*-->/)
    return m ? m[1].split(',').map(x => x.trim()).filter(Boolean) : []
  }

  /** enc 反哺 hints：enc_candidates 引用的图内节点不在本节点 pre 传递闭包 → 建议补边。
   * E7（audit）管已写入图的 enc 边；本检查把纠正时机提前到内容落盘时（内容反哺图）。 */
  static encBackfeedHints(graph: Graph, node: string, body: string): string[] {
    const out: string[] = []
    for (const cand of Content.encCandidates(body)) {
      if (graph.nset.has(cand) && !graph.isAncestor(cand, node)) {
        out.push(`「${cand}」被 enc_candidates 引用但不在本节点 pre 闭包——确认依赖后用 learnhub_graph_propose(kind=edit) 的 set_pre 补边`)
      }
    }
    return out
  }

  /** 题干下方选项行（A. … / A) …）→ ["A. …"]；不足 2 项视为无选项。 */
  private extractOptions(text: string): string[] {
    const opts: string[] = []
    for (const ln of text.split('\n')) {
      const s = ln.trim()
      if (/^[A-Z][.、．)）]/.test(s)) {
        opts.push(s)
        continue
      }
      if (opts.length) break
    }
    return opts.length >= 2 ? opts : []
  }

  /** 练习区容错归一化 → (new_body, changed)。 */
  normalizePractice(body: string): { body: string; changed: boolean } {
    const m = body.match(/## 练习\s*\n([\s\S]*?)(?=\n## |$)/)
    if (!m) return { body, changed: false }
    const head = m[0].slice(0, m[0].length - m[1].length)
    const sec = m[1]
    const metas = [...sec.matchAll(/<!--\s*ex:\d+\s*\|([^>]*)-->/g)]
    if (!metas.length) return { body, changed: false }
    const out: string[] = []
    let changed = false
    let prevEnd = 0
    metas.forEach((mm, i) => {
      out.push(sec.slice(prevEnd, mm.index))
      prevEnd = mm.index! + mm[0].length
      const fields: Record<string, string> = {}
      const order: string[] = []
      for (const part of mm[1].split('|')) {
        const p = part.trim()
        const ci = p.indexOf(':')
        if (ci < 0) continue
        const k = p.slice(0, ci).trim()
        if (!(k in fields)) order.push(k)
        fields[k] = p.slice(ci + 1).trim()
      }
      if (fields.check === 'choice' && !fields.options) {
        const qEnd = i < metas.length - 1 ? metas[i + 1].index! : sec.length
        const opts = this.extractOptions(sec.slice(prevEnd, qEnd))
        if (opts.length) {
          fields.options = opts.join('；')
          if (!order.includes('options')) order.unshift('options')
          changed = true
        }
      }
      const newLine = `<!-- ex:${i + 1} | ${order.filter(k => k in fields).map(k => `${k}: ${fields[k]}`).join(' | ')} -->`
      if (newLine !== mm[0]) changed = true
      out.push(newLine)
    })
    if (!changed) return { body, changed: false }
    out.push(sec.slice(prevEnd))
    return { body: body.slice(0, m.index) + head + out.join('') + body.slice(m.index! + m[0].length), changed }
  }

  // ---- 反馈与生成落盘 ----

  /** 读课程文件「## 内容反馈」区的用户文字。 */
  async collectFeedback(root: string, graph: Graph, node: string): Promise<string> {
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { body } = await loadNote(path)
    const m = body.match(/## 内容反馈\s*\n([\s\S]*?)(?=\n## |$)/)
    if (!m) return ''
    return m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/^（[\s\S]*?）$/m, '').trim()
  }

  /** 标记反馈 → flagged + 重生成入队。返回消息或抛错。 */
  async feedback(root: string, graph: Graph, node: string, noteOf: (n: string) => Fm | undefined, project: (node: string, fm: Fm) => Promise<void>): Promise<string> {
    if (!graph.nset.has(node)) throw new Error(`[feedback] 未知节点: ${node}`)
    const fm = noteOf(node)
    if (!fm) throw new Error(`[feedback] 课程文件不存在: ${node}`)
    const text = await this.collectFeedback(root, graph, node)
    if (!text) throw new Error('[feedback] 「内容反馈」区为空——先写下问题与建议再运行本命令。')
    const next = { ...fm, content: { ...fm.content, status: 'flagged' as const } }
    await project(node, next)
    const brief = text.split(/\s+/).join(' ').slice(0, 40)
    await this.queueAdd(root, QUEUE_REGEN, node, `反馈：${brief}`, `版本：${fm.content.version}→${fm.content.version + 1}`)
    return `[feedback] 已标记 flagged 并入重生成队列：${node}（反馈：${brief}…）`
  }

  /** 写入生成内容：version+1，status=draft 待人审（frontmatter + journal）。 */
  async applyGeneration(
    root: string, graph: Graph, node: string, body: string,
    fmOf: (node: string) => Fm | undefined,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<number> {
    const fm = fmOf(node)
    if (!fm) throw new Error(`[apply] 课程文件不存在（先为节点生成内容骨架）: ${node}`)
    const version = fm.content.version + 1
    const next: Fm = {
      ...fm,
      content: {
        ...fm.content,
        version,
        generated_at: todayStr(),
        status: 'draft',
        // 节清单节点：整篇替换后 manifest 与正文重对齐（全部 ready、版本同步）
        ...(fm.content.sections ? { sections: Content.manifestFromBody(body, version) } : {}),
      },
    }
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    await saveNote(path, next as unknown as Record<string, unknown>, body)
    await journal({ course: '', node, rating: null, kind: 'content_apply', elapsed_days: 0, detail: `正文 v${version} 落盘（status=draft）` })
    return version
  }

  /** 人审通过 → content.status=reviewed。 */
  async review(root: string, graph: Graph, node: string, fmOf: (n: string) => Fm | undefined, project: (node: string, fm: Fm) => Promise<void>): Promise<string> {
    const fm = fmOf(node)
    if (!fm) throw new Error(`[review] 课程文件不存在: ${node}`)
    const next = { ...fm, content: { ...fm.content, status: 'reviewed' as const } }
    await project(node, next)
    return `[review] ${node} → reviewed（v${fm.content.version}）。`
  }

  // ---- gen-exercises（题组写入练习区；schema 门禁内联） ----

  /** 题组 schema 校验（ExerciseSet 同构，手写以输出与旧引擎一致的中文错误行）。 */
  static validateExerciseSet(doc: unknown): { ok: true; spec: { node: string; mode: 'replace' | 'append'; exercises: ExerciseMeta[] } } | { ok: false; errors: string[] } {
    const errors: string[] = []
    if (typeof doc !== 'object' || doc === null) return { ok: false, errors: ['(顶层): 必须是映射'] }
    const d = doc as Record<string, unknown>
    if (typeof d.node !== 'string' || !d.node.trim()) errors.push('node: 不能为空')
    if (d.mode !== undefined && d.mode !== 'replace' && d.mode !== 'append') errors.push('mode: 只允许 replace/append')
    if (!Array.isArray(d.exercises) || !d.exercises.length) errors.push('exercises: 题组为空')
    const exercises: ExerciseMeta[] = []
    if (Array.isArray(d.exercises)) {
      d.exercises.forEach((raw, i) => {
        const n = i + 1
        if (typeof raw !== 'object' || raw === null) {
          errors.push(`exercises.${n}: 必须是映射`)
          return
        }
        const e = raw as Record<string, unknown>
        if (typeof e.q !== 'string' || !e.q.trim()) errors.push(`exercises.${n}.q: 不能为空`)
        if (typeof e.answer !== 'string' || !e.answer.trim()) errors.push(`exercises.${n}.answer: 不能为空`)
        const check = e.check ?? 'human'
        if (!['sympy', 'choice', 'ai', 'human', 'single_choice', 'true_false', 'fill_in_blank', 'reflection'].includes(String(check))) {
          errors.push(`exercises.${n}.check: 非法类型 ${String(check)}`)
        }
        let difficulty = 1
        if (e.difficulty !== undefined) {
          const dv = Number(e.difficulty)
          if (!Number.isInteger(dv) || dv < 1 || dv > 3) errors.push(`exercises.${n}.difficulty: 必须是 1-3`)
          else difficulty = dv
        }
        const uses = Array.isArray(e.uses) ? e.uses.map(String) : []
        const options = Array.isArray(e.options) ? e.options.map(String) : []
        let tol: number | undefined
        if (e.tol !== undefined) {
          const tv = Number(e.tol)
          if (!(tv > 0)) errors.push(`exercises.${n}.tol: 必须是正数`)
          else tol = tv
        }
        exercises.push({ ex: n, q: String(e.q ?? ''), answer: String(e.answer ?? ''), check: String(check), difficulty, uses, options, tol })
      })
    }
    if (errors.length) return { ok: false, errors }
    return {
      ok: true,
      spec: {
        node: (d.node as string).trim(),
        mode: (d.mode as 'replace' | 'append') ?? 'replace',
        exercises,
      },
    }
  }

  /** 手动插队（T3）。 */
  async queueManual(root: string, node: string): Promise<string> {
    const ok = await this.queueAdd(root, QUEUE_GENERATE, node, '触发：手动插队（T3）', '高')
    return `[queue] ${node}${ok ? ' 已入队' : ' 已在队列中'}`
  }
}

/** 类型再导出（引擎内其它模块消费）。 */
export type { GRegion, GNode }
