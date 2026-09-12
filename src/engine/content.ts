/**
 * 内容管线引擎（吸收自 Python content.py；生成动作本身由 AI agent 执行）。
 *
 * - 生成队列 课程根/state/生成队列.md 的读写与 T1/T2 触发
 * - 上下文包组装：agent 生成课程前拿到的全部资产
 * - 质检门：超纲引用检测 / 别名一致性（SymPy 自检脚本门随 Python 引擎退役）
 * - 反馈重生成协议：内容反馈区 → flagged → 重生成条目
 * - gen-exercises：题组过 schema/结构门禁后写入练习区（计数同步 + journal）
 */
import type { VaultFs } from './io.ts'
import { atomicWrite } from './io.ts'
import { YAML } from './yaml.ts'
import { todayStr } from './dates.ts'
import type { Clock } from './clock.ts'
import { outlineBudgetForNode, nodeProfileLines, nodeTierOf, nodeProblemFirstOf, TIER_LABELS, TIER_LABEL_TO_IDX, TIER_ANCHORS, MAX_SECTIONS, SECTION_VISUAL_CAP, sectionLengthThresholds } from './complexity.ts'
import { loadNote, saveNote } from './notes.ts'
import { round2 } from './grading.ts'
import { invokesTagged } from './concepts.ts'
import { RENDERERS, PLAIN_CODE_LANGS, SECTION_TYPES, INTERACTIVE_TYPES, parseSectionTitle, rendererCapabilityBlock, predictBlockRe, parsePredictBlock } from '../../shared/content-renderers.ts'
import type { InteractiveType } from '../../shared/content-renderers.ts'
import type { GRegion, GNode, SectionManifest, EncEdge } from './types.ts'
import type { Graph } from './graph.ts'
import type { Paths } from './paths.ts'
import type { Fm, JournalRec } from './types.ts'

export const QUEUE_GENERATE = '生成'
export const QUEUE_REGEN = '重生成'

/** 可视化块围栏语言（单节合计受 SECTION_VISUAL_CAP 约束；interactive 为落盘后的引用块）。 */
const SECTION_VISUAL_LANGS: ReadonlySet<string> = new Set(['mermaid', 'svg', 'plot', 'chart', 'interactive'])

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
  // 显式字段赋值（参数属性在 strip-only 单测模式下不可导入）
  private paths: Paths
  private clock: Clock
  private fs: VaultFs
  constructor(paths: Paths, clock: Clock, fs: VaultFs) {
    this.paths = paths
    this.clock = clock
    this.fs = fs
  }

  // ---- 生成队列 ----

  private async queueLines(root: string): Promise<string[] | null> {
    const p = this.paths.queuePath(root)
    if (!this.fs.exists(p)) return null
    return (await this.fs.readFile(p)).split('\n')
  }

  async queueInit(root: string): Promise<void> {
    const p = this.paths.queuePath(root)
    if (this.fs.exists(p)) return
    await atomicWrite(p, '# 生成队列\n\n> 待生成/待重生成清单。引擎自动维护，人可编辑；完成条目打勾即止。\n', this.fs)
  }

  /** 入队一条任务；同节点同 kind 未完成条目不重复。 */
  async queueAdd(root: string, kind: string, node: string, reason: string, priority = '中'): Promise<boolean> {
    await this.queueInit(root)
    const lines = (await this.queueLines(root))!
    for (const ln of lines) {
      if (ln.startsWith('- [ ]') && ln.includes(`${kind}：${node}`)) return false
    }
    lines.push(`- [ ] ${kind}：${node} ｜ ${reason} ｜ 优先：${priority}`)
    await atomicWrite(this.paths.queuePath(root), lines.join('\n').replace(/\n+$/, '') + '\n', this.fs)
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
    if (changed) await atomicWrite(this.paths.queuePath(root), lines.join('\n'), this.fs)
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
      : '- 篇幅：单节正文以 §9 复杂度档案的单节篇幅预算为准（超 1.3 倍警告、2 倍拒收）——整课没有独立的总字数指标')
    out.push('- 小节：类型前缀 + 实际标题（类型菜单见提示词）；节的划分、顺序与类型配比完全由你按内容与风格判断，不设固定栏目与固定收尾段（可选保留 ## 内容反馈 区收集学习者建议）')
    out.push('')
    out.push('## 7. 既有 enc 边（练习必须真实调用它们）')
    out.push(enc.length ? enc.map(([t, w]) => `${t}(w=${w.toFixed(1)})`).join('、') : '（暂无）')
    out.push('- enc = 本课练习真实调用、且位于本节点 pre 闭包内的成分技能（ADR-0008）。')
    out.push('- 练习调用的前置技能请在练习元数据 `uses:` 里如实标注——引擎会把闭包内候选提升为 enc 边，供将来失败回退路由；不存在的候选宁缺毋滥。')
    out.push('')
    out.push('## 8. 交付要求')
    if (isPractice) {
      out.push(Content.interactiveSpecBlock())
      out.push('- 末尾机器块：`<!-- enc_candidates: [] -->`（交互实践不出练习题）')
    } else {
      out.push('- 练习题以题组 YAML 经 learnhub_exercises_gen 写入（不再直接写进正文练习区）；数值题给 tol 容差')
      out.push('- 题型优先 single_choice / true_false / numeric（可机器判卷）；fill_in_blank 只考唯一写法的术语（数字与代数式不进填空，ADR-0029）；开放性问答题用 reflection 并在 answer 写评分要点')
      out.push('- 末尾机器块：`<!-- enc_candidates: [本课练习真实调用的前置技能（须在本节点 pre 闭包内；落盘后据此提升为 enc 边）] -->`')
    }
    out.push('')
    out.push('## 9. 复杂度档案（本节点内容规模的锚点；别注水也别压扁）')
    if (isPractice) {
      out.push('- 实践节点：核心交付物是交互模拟，节段/题量预算不适用，按 §8 规范走')
    } else {
      out.push(...nodeProfileLines(graph, node))
    }
    if (!isPractice && nodeProblemFirstOf(graph, node)) {
      out.push('')
      out.push('## 10. 先做后教（PS-I 顺序变体；本节点 difficulty/bloom 达到高难阈值）')
      out.push('- 第一节必须是挑战节：类型「例题」、标题以「挑战：」开头，只给题面与尝试引导（明确请学习者先自己尝试、带着缺口往下读），本节不给解答步骤与答案。')
      out.push('- 随后的讲解节围绕挑战题展开；讲解收尾处（或紧随其后的独立节）完整解答挑战题，回扣学习者在第一节的尝试与缺口。')
      out.push('- 其余硬约束、节类型菜单与质检门不变；节清单按挑战节在前的顺序给出，生成与学习顺序都照此走。')
      out.push('')
      out.push('## 11. 专家思维轨迹（认知学徒制 modeling；本节点 difficulty/bloom 达到高难阈值）')
      out.push('- 大纲必须包含恰好一节「思维」节（标题以「思维：」开头），放在讲解铺开之后、收尾之前：它演示的题应与挑战节/讲解核心同族（可直接解挑战题，或解一道同族典型题）。')
      out.push('- 思维节写专家的意识流解题：第一人称叙述真实思维过程（尝试、犹豫、自我盘问、监控与调整），不是整洁的板书式解答；叙述与 $$ 公式/示意图穿插。')
      out.push('- 必须故意踩一次坑：走到一个典型错误岔路并「做下去」，直到出现矛盾信号，再当场用元评论点破（> **元评论**：我为什么差点走进去、什么信号暴露了它、下次靠什么提前绕开）。坑位选材：§12 附有误解坑位时**必须**从其中选一条与演示题同族的（登记在册的先验优先），没有 §12 才自选典型错误岔路。')
      out.push('- 关键转折处（坑前与收敛前至少各一处）设预测门：正文直接写 ```learnhub-predict 机器块——先让学习者预测专家下一步该做什么，再继续读。块格式（逐行字段）：')
      out.push('')
      out.push('```learnhub-predict')
      out.push('q: <预测提问：接下来专家会先做什么/哪条路是对的？>')
      out.push('options: ["<做法一>", "<做法二>", "<做法三>"]（2–4 项，互不相同，句式相近）')
      out.push('answer: <正确做法项的原文，与 options 中一项逐字一致>')
      out.push('why: <揭晓时的元评论一两句（可省）>')
      out.push('```')
      out.push('- 思维节收尾提炼 1–3 条可迁移的解题元策略（什么时候先看边界、什么时候量纲先行之类，按内容定）。')
      out.push('- 预测门会被质检门做结构校验（字段齐全、answer ∈ options），不合规格式会被拒收返工。')
    }
    // §12/§13（#147）：误解目录与前置档位是生成期感知面——缺席合法（Missing），整段省略。
    const mis = graph.misconceptionsOf[node] ?? []
    if (mis.length) {
      out.push('')
      out.push('## 12. 误解坑位（生成期先验；讲到对应概念时预埋坑位警示）')
      out.push('- 下列是本节点登记在册的误解先验（概念：错误模型）。讲到对应概念处，把典型错误预埋为坑位警示（blockquote 误区块）：先呈现错法、再当场点破错在哪、怎么防；不展开成新主题。')
      out.push('- 这是生成期先验：真实学习者的错误以后由作答流水挖矿与申诉复核接管，有反馈区意见时以意见为准。')
      for (const m of mis) out.push(`- ${m.concept}：${m.model}`)
    }
    const assumes = graph.assumesOf[node]
    if (assumes && Object.keys(assumes).length) {
      out.push('')
      out.push('## 13. 前置概念档位（assumes；写作时按档位把握「能默认学习者会什么」）')
      out.push('- 知道 = 学习者认识该概念（可提及作再认，不能默认会操作）；会用 = 能常规使用（可直接调用，必要时一句话回顾）；能教 = 已熟练（可作多步推理的默认起点，不必回顾）。前置不重教。')
      for (const [c, t] of Object.entries(assumes)) out.push(`- ${c}：${t}`)
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
<!-- learnhub:prompt/v9 -->
# 课程大纲提示词（用户可编辑；生成时上下文包自动附在本模板之后）

你是 learnhub 学习系统的课程设计师。根据附后的上下文包，把目标节点的一课拆成依次学习的「节」清单；每节之后会单独生成正文。

## 设计原则

1. 节的划分、数量、顺序与类型配比完全由你根据课程内容、主题与讲解风格判断，选择最自然的讲解骨架：不套固定栏目，不设固定收尾段（无强制的过渡节/总结节）。
2. 一节 = 一个可完成的学习单元（一个概念、一道例题、一次演示、一次动手练习、一个交互模拟或一段专家思维轨迹）；标题描述本节具体内容，不用栏目化通名；一节 = 学习页 1–2 屏，上下文包 §9 的篇幅与可视化预算是**硬约束**（单节文字超预算 1.3 倍警告、2 倍拒收；可视化块 ≤2 个）——一个知识点需要 公式+推导+例题+图 才能讲完时拆成多个节，预算装不下的内容进新节；节内不允许再分小节（### 子标题会被质检门提示，建议并入正文或拆成独立节）。
3. type 从节类型菜单选（概念/例题/演示/小结/练习/交互/思维）；练习节可选（整课可以没有练习节）；节类型配比按内容选组合模式，例如：连续 2–3 个概念节后跟一个练习节集中练、概念-演示穿插、全概念无练习节——不要机械地一节内容跟一节练习。
4. 节数按上下文包 §9 复杂度档案锚定：目标节段数区间内的自然划分（简单节点不注水拆长课，复杂节点留够展开空间；拿不准时偏向多一节——单节塞满两倍预算会被拒收返工，拆开讲更从容）；相邻节之间要有学习上的递进关系（逐节生成时会注入前节已生成正文保证连贯）。
5. 每节给 tier（节段难度档 低/中/高）：它是本节的难度档锚，出题难度与样例密度都按它递进——按节点难度与节的学习弧位置定档（开头的节偏易、收尾的节偏难，与节点难度相称）；拿不准可省略，系统会按节位置推导。
6. 若上下文包附有「学习者已有理解（Vault 先验）」段：划分与措辞尊重学习者已有的理解与记法——已会内容不重复铺陈，记法沿用其笔记写法。
7. 上下文包 §10（先做后教）与 §11（专家思维轨迹）出现时是硬性要求：按其指令纳入挑战节与/或「思维」节，位置与写法照指令执行。

## 输出

只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

node: <节点名>
sections:
  - id: s1
    title: 概念：整数与自然数的分界
    type: 概念
    points: 本节要点（一句话）
    tier: 低|中|高（可选；省略时系统按节位置推导）
    visual: 公式|mermaid|图片|交互|示意图|函数图|图表 之一（本节的讲解主体可视化——学习页文字宜少、公式/图/交互宜多，几乎每节都有，确无才写「无」；示意图=\`\`\`svg、函数图=\`\`\`plot、图表=\`\`\`chart）
`,
    课程节生成: `\
<!-- learnhub:prompt/v9 -->
# 课程节生成提示词（用户可编辑；系统附上：节清单、本节任务、前节已生成正文、上下文包）

你是 learnhub 学习系统的课程写手。根据附后的材料，只写「本节任务」指定的这一节正文。

## 硬约束（违反即返工）

1. 只输出一节：以 \`## 类型：标题\` 开头（标题与类型精确照抄本节任务），后接本节正文；不写其他节、不写 frontmatter。
2. 只用前置已教概念与常识；「禁止使用的概念」一节列出的名称不得出现，也不得引用其结论。
3. 若材料附有「前置概念档位」段：按档位把握能默认学习者会什么——知道 = 可提及作再认（不默认会操作）；会用 = 可直接调用（必要时一句话回顾）；能教 = 已熟练（可作多步推理的默认起点）。前置不重教；未列档位的前置按「会用」对待。
4. 若材料附有「误解坑位（生成期先验）」段：讲到对应概念处，把列出的典型错误预埋为坑位警示——用 blockquote 误区块（> 首行加粗标签）先呈现错法、再当场点破错在哪与什么信号暴露它；坑位就地辨析，不展开成新主题。该段缺席时不必自设坑位。
5. 不超出「领域边界」声明的区块范围；后继内容至多在自然收尾处一句话带过。
6. 可视化为主、文字为辅：讲解本体用公式/mermaid 图/svg 示意图/plot 函数图/chart 图表/交互件承载，文字只做引导与衔接（字数额度见上下文包 §9 复杂度档案，超预算 1.3 倍警告、2 倍拒收），不写大段解说；大多数节段配一个主体可视化（纯推理/衔接节可无；交互节为交互件本身）；单节可视化块（mermaid/svg/plot/chart/交互件合计）≤2 个，超出质检门拒收；节内不写 ### 子标题；不在正文自设练习/趁热练习环节——练习由题库与练习节承载（检索点是读流的一部分，见下条，不算练习环节）。
7. 节段难度档锚定：本节任务给出的「节段难度档」（低/中/高）锚定本节的样例密度与检索点——**低档**：每个新要点紧跟一个完整样例（worked example），检索点 0–1 处；**中档**：要点讲完先留「先自己做」的尝试空隙再给样例，检索点 1–2 处；**高档**：样例只给关键步骨架（细节留白让学习者补全），检索点 2–3 处。检索点 = 读流内嵌的一问一揭晓：先让学习者凭记忆作答或动手尝试（一句话提问），紧随其后揭晓；它不是练习题——不设判分、不进练习区、不写「练习」栏目。
8. 与「前一节已生成正文」自然衔接：不重复它讲过的内容，开头不复述前节结论。
9. 排版约定：并列的误区/注意/要点块用 blockquote（> 首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点/边文本含 | { } " # 等特殊字符时必须整体双引号包裹（如 \`A["文本"]\`），否则渲染降级为源码。
10. 别名按「规范约束」统一；图片用 \`![[<课程根>/课程图/xx.png]]\`。
11. 若材料附有「学习者已有理解（Vault 先验）」段：尊重学习者已有的理解与记法——已会内容不从零教，术语与记法沿用其笔记写法，与课程规范冲突时显式指出分歧并给出规范写法；该段是只读先验，不是要复述的材料。

{{renderers}}

## 输出

只输出本节正文（## 标题 + 内容），不要附加解释。
`,
    '课程节生成-苏格拉底': `\
<!-- learnhub:prompt/v9 -->
# 课程节生成提示词——苏格拉底风格（用户可编辑；系统附上：节清单、本节任务、前节已生成正文、上下文包）

你是 learnhub 学习系统的苏格拉底式导师。根据附后的材料，只写「本节任务」指定的这一节正文：少给结论，多给「好问题 + 逐步逼近的思路」，让学习者在回答问题中自己建构知识。

## 硬约束（违反即返工）

1. 只输出一节：以 \`## 类型：标题\` 开头（标题与类型精确照抄本节任务），后接本节正文；不写其他节、不写 frontmatter。
2. 只用前置已教概念与常识；「禁止使用的概念」一节列出的名称不得出现，也不得引用其结论。
3. 若材料附有「前置概念档位」段：按档位把握能默认学习者会什么——知道 = 可提及作再认（不默认会操作）；会用 = 可直接调用（必要时一句话回顾）；能教 = 已熟练（可作多步推理的默认起点）。前置不重教；未列档位的前置按「会用」对待。
4. 若材料附有「误解坑位（生成期先验）」段：讲到对应概念处，把列出的典型错误预埋为坑位警示——用 blockquote 误区块（> 首行加粗标签）先呈现错法、再当场点破错在哪与什么信号暴露它；坑位就地辨析，不展开成新主题。该段缺席时不必自设坑位。
5. 不超出「领域边界」声明的区块范围；后继内容至多在自然收尾处一句话带过。
6. 可视化为主、文字为辅：讲解本体用公式/mermaid 图/svg 示意图/plot 函数图/chart 图表/交互件承载，文字只做引导与衔接（字数额度见上下文包 §9 复杂度档案，超预算 1.3 倍警告、2 倍拒收），不写大段解说；大多数节段配一个主体可视化（纯推理/衔接节可无；交互节为交互件本身）；单节可视化块（mermaid/svg/plot/chart/交互件合计）≤2 个，超出质检门拒收；节内不写 ### 子标题；不在正文自设练习/趁热练习环节——练习由题库与练习节承载（检索点是读流的一部分，见下条，不算练习环节）。
7. 节段难度档锚定：本节任务给出的「节段难度档」（低/中/高）锚定本节的样例密度与检索点——**低档**：每个新要点紧跟一个完整样例（worked example），检索点 0–1 处；**中档**：要点讲完先留「先自己做」的尝试空隙再给样例，检索点 1–2 处；**高档**：样例只给关键步骨架（细节留白让学习者补全），检索点 2–3 处。检索点 = 读流内嵌的一问一揭晓：先让学习者凭记忆作答或动手尝试（一句话提问），紧随其后揭晓；它不是练习题——不设判分、不进练习区、不写「练习」栏目。检索点与引导问题天然同构：能当检索点的问题就别再另设。
8. 风格约束：以引导问题推进——先给观察/反例式好问题，再一小步逼近，问题后紧跟「锚点」（一两句最低限度的正确方向提示，不是答案）；结论只在问题链走完后给出。
9. 与「前一节已生成正文」自然衔接：不重复它讲过的内容，开头不复述前节结论。
10. 排版约定：并列的误区/注意/要点块用 blockquote（> 首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点/边文本含 | { } " # 等特殊字符时必须整体双引号包裹（如 \`A["文本"]\`），否则渲染降级为源码。
11. 别名按「规范约束」统一；图片用 \`![[<课程根>/课程图/xx.png]]\`。
12. 若材料附有「学习者已有理解（Vault 先验）」段：尊重学习者已有的理解与记法——已会内容不从零教，提问可从其笔记的记法与经验切入，与课程规范冲突时显式指出分歧并给出规范写法；该段是只读先验，不是要复述的材料。

{{renderers}}

## 输出

只输出本节正文（## 标题 + 内容），不要附加解释。
`,
    '课程节生成-费曼': `\
<!-- learnhub:prompt/v9 -->
# 课程节生成提示词——费曼风格（用户可编辑；系统附上：节清单、本节任务、前节已生成正文、上下文包）

你是 learnhub 学习系统的费曼式讲解员。根据附后的材料，只写「本节任务」指定的这一节正文：假设学习者要把这节课讲给一个聪明的十二岁孩子听，用最朴素的类比和日常语言把概念讲透，再逐步引入正式记号。

## 硬约束（违反即返工）

1. 只输出一节：以 \`## 类型：标题\` 开头（标题与类型精确照抄本节任务），后接本节正文；不写其他节、不写 frontmatter。
2. 只用前置已教概念与常识；「禁止使用的概念」一节列出的名称不得出现，也不得引用其结论。
3. 若材料附有「前置概念档位」段：按档位把握能默认学习者会什么——知道 = 可提及作再认（不默认会操作）；会用 = 可直接调用（必要时一句话回顾）；能教 = 已熟练（可作多步推理的默认起点）。前置不重教；未列档位的前置按「会用」对待。
4. 若材料附有「误解坑位（生成期先验）」段：讲到对应概念处，把列出的典型错误预埋为坑位警示——用 blockquote 误区块（> 首行加粗标签）先呈现错法、再当场点破错在哪与什么信号暴露它；坑位就地辨析，不展开成新主题。该段缺席时不必自设坑位。
5. 不超出「领域边界」声明的区块范围；后继内容至多在自然收尾处一句话带过。
6. 可视化为主、文字为辅：讲解本体用公式/mermaid 图/svg 示意图/plot 函数图/chart 图表/交互件承载，文字只做引导与衔接（字数额度见上下文包 §9 复杂度档案，超预算 1.3 倍警告、2 倍拒收），不写大段解说；大多数节段配一个主体可视化（纯推理/衔接节可无；交互节为交互件本身）；单节可视化块（mermaid/svg/plot/chart/交互件合计）≤2 个，超出质检门拒收；节内不写 ### 子标题；不在正文自设练习/趁热练习环节——练习由题库与练习节承载（检索点是读流的一部分，见下条，不算练习环节）。
7. 节段难度档锚定：本节任务给出的「节段难度档」（低/中/高）锚定本节的样例密度与检索点——**低档**：每个新要点紧跟一个完整样例（worked example），检索点 0–1 处；**中档**：要点讲完先留「先自己做」的尝试空隙再给样例，检索点 1–2 处；**高档**：样例只给关键步骨架（细节留白让学习者补全），检索点 2–3 处。检索点 = 读流内嵌的一问一揭晓：先让学习者凭记忆作答或动手尝试（一句话提问），紧随其后揭晓；它不是练习题——不设判分、不进练习区、不写「练习」栏目。「讲给别人听」的自测问题可充当收尾检索点。
8. 风格约束：每个核心概念按「生活类比（并明确说类比在哪里失效）→ 朴素语言解释 → 正式定义/记号」推进；节末收一个「讲给别人听」的自测问题。
9. 与「前一节已生成正文」自然衔接：不重复它讲过的内容，开头不复述前节结论。
10. 排版约定：并列的误区/注意/要点块用 blockquote（> 首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点/边文本含 | { } " # 等特殊字符时必须整体双引号包裹（如 \`A["文本"]\`），否则渲染降级为源码。
11. 别名按「规范约束」统一；图片用 \`![[<课程根>/课程图/xx.png]]\`。
12. 若材料附有「学习者已有理解（Vault 先验）」段：尊重学习者已有的理解与记法——类比可借用其笔记里已有的比喻，已会内容不从零教，与课程规范冲突时显式指出分歧并给出规范写法；该段是只读先验，不是要复述的材料。

{{renderers}}

## 输出

只输出本节正文（## 标题 + 内容），不要附加解释。
`,
    课程节拆分: `\
<!-- learnhub:prompt/v9 -->
# 课程节拆分提示词（用户可编辑；系统附上：待拆节的任务与上下文包）

你是 learnhub 学习系统的课程设计师。一个已规划的节在生成时正文超出了单节篇幅预算（压缩修复仍未通过），请把它拆成 2–3 个依次学习的小节——每个子节之后会单独生成正文。

## 要求

1. 只拆不扩：子节合起来覆盖原节的内容范围，不引入原节之外的新主题、不新增原节没有的知识点。
2. 每个子节仍是一节 = 学习页 1–2 屏（单个知识点/单道例题/一次演示）；上下文包 §9 的篇幅与可视化预算对每个子节同样成立。
3. 标题描述该子节的具体内容（可用「（上）（下）」收尾或按子内容命名，不用栏目化通名）；类型从节类型菜单选（概念/例题/演示/小结/练习/交互/思维）；相邻子节要有学习上的递进关系。
4. 每个子节给 tier（低/中/高），可省略（省略时系统按节位置推导）。

## 输出

只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

sections:
  - title: <子节标题>
    type: <节类型>
    points: <本节要点（一句话，可选）>
    tier: 低|中|高（可选）
`,
    题目生成: `\
<!-- learnhub:prompt/v11 -->
# 题目生成提示词（用户可编辑；节点正文由系统附在本模板之后）

你是 learnhub 学习系统的出题老师。根据附后的节点正文出一组练习题，覆盖正文的核心概念、易错点与典型应用。

## 硬约束

1. 题型必须多样，只用以下九种，不要全出同一题型：
   - 单选（single_choice）：options 列 4 项、answer 为一个正确选项字母；**答案是代数式的题（化简/因式分解/恒等变形等）必须用单选**——正确式 + 典型错误作干扰项。
   - 多选（multi_choice）：options 列 4 项、answer 为正确选项**字母数组**（如 ["A","C"]，至少 2 个正确项）。
   - 判断（true_false）：answer 为 对/错。
   - 填空（fill_in_blank）：**只考唯一写法的术语/名称/符号**——任何学过的人写出的正确答案至多差空白与大小写，题面自身锁定唯一答案；answer 为可接受答案数组（同义写法都列出）；**数字与代数式一律不进填空**：数字答案用 numeric，表达式答案用单选。
   - 数值（numeric）：answer 为数值，必须同时给 tol 容差（如 0.01）；适合计算/估算题。
   - 排序（ordering）：options 为**乱序**的步骤/事件项（每项短且互不相同）、answer 为**正确顺序的项文本数组**（同一组项的重排）。
   - 配对（matching）：options 为左列项（≥2，短且互异）、answer 为与左列**一一对应**的右列文本数组（第 i 项是第 i 个左项的配对）。
   - 反思（reflection）：开放式小反思，answer 写评分要点。
   - 开放题（open_question）：**考整个课时内容的综合应用**（跨节综合，不是单节细节），section 固定写「通用」；answer 写参考要点（可省略）。每轮最多 1 道。
2. 难度按系统附的「难度锚定」走（节段难度档/节点档位锚，逐节出题时每节的难度递进由锚定给出）；系统未附锚定时默认递进：开头 1-2 道概念辨析（difficulty: 1），中间应用与计算（difficulty: 2），收尾综合或易错陷阱（difficulty: 3）+ 至多 1 道开放题。
3. 数学记法契约：题干、选项、解析里的一切数学一律 KaTeX——行内 $…$、独立式 $$…$$；禁止 ASCII 记号（x^2、a_1）与不带 $ 定界符的裸 LaTeX 命令；正文用不上的公式不硬加。违反记法契约的题会被系统程序检测并拒收。
4. 每题必须给全：题干、答案、解析；解析 ≤4 句（约 150 字），按固定三段写——为什么对（1-2 句）→ 关键步骤（≤2 步，式子用 $$ 独立成行）→ 最易错点（1 句），用 markdown 短段或分点，不写大段连续文字；几何/函数/数据类题的解析可用一个 \`\`\`svg 或 \`\`\`plot 代码块配图。
5. 只考正文里讲过的内容，不得引入正文没有的概念、记号或结论。
6. 选择题 options 不带 A./B. 编号前缀（系统自动编号）；填空题 answer 用数组列出所有可接受写法；node 字段原样照抄系统给出的节点名。
7. 每题标注 \`section\`：系统提供节标注清单时，section 必须**精确照抄清单中的节 id**（如 \`s2\`）；未提供清单时照抄正文节标题原文（如「概念：定义与性质」）；跨节综合题一律写「通用」。
8. 若附有「学习者已有理解（Vault 先验）」段：题干与选项的记法沿用其笔记写法（与正文规范冲突时以正文为准）；他笔记里已熟练的内容可出一两道再认题巩固，不出从零学的新知识题。
9. 查重：系统附有「题库已有题目」清单时，与清单中题面重复或高度相似（同考点同问法、仅换数字/措辞）的题一律不要出——出全新角度或不同考点的题；若附「生成指令（学习者意见）」，按指令优先。
10. 交卷前逐题自检（出题老师对答案键负责）：把每道题**当作考生独立重解一遍**，核对三件事——①答案键与重解结果一致（多选逐项判真假，杜绝凑不满「至少 2 个正确项」硬凑错项）；②解析与答案键一致（解析的每句结论都要支撑答案键，不得自相矛盾）；③答案唯一的题不得出现第二个可辩护的正确选项。发现不一致，以重解结果为准改完再交。
11. 若附有「误解先验（干扰项材料）」段：选择题/判断题的干扰项优先把先验里的典型错误模型改编成选项（错误模型文字 → 学习者真会写出的选项），并在解析「最易错点」一句里点破；先验是生成期的候选材料——与「生成指令（学习者意见）」冲突时以指令为准。
12. 每题必须标注 \`invokes\`：**恰一枚**概念——本题最主要考察的那一个，从系统附的「概念清单」里选，名字**精确照抄**清单（一字不差）；只标一枚，不得多枚、不得空缺、不得写清单外的名字。系统未附「概念清单」时省略 invokes 字段即可。

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
    invokes: <概念清单中的名字>
    uses: [用到的前置概念]

YAML 写法注意：含反斜杠（LaTeX 命令）、冒号或特殊字符的标量一律用**单引号**包裹（如 q: '$3.14\\times57 + 3.14\\times43$'）；**禁用双引号**——双引号里 \\t \\n 会被 YAML 解释成控制字符，吃掉公式里的反斜杠（\\times 会损坏成 tab+imes）。
`,
    笔记出题: `\
<!-- learnhub:prompt/v9 -->
# 笔记出题提示词（用户可编辑；笔记正文由系统附在本模板之后）

你是 learnhub 学习系统的出题老师。学习者把自己的一篇笔记注册成了复习源，请根据附后的笔记正文出一组复习题，覆盖笔记的核心概念、关键结论与易混点，帮助学习者间隔复习自己的知识。

## 硬约束

1. 题型只用以下几种，按内容自然混搭，不要全出同一题型：
   - 单选（single_choice）：options 列 4 项、answer 为一个正确选项字母；**答案是代数式的题必须用单选**——正确式 + 典型错误作干扰项。
   - 判断（true_false）：answer 为 对/错。
   - 填空（fill_in_blank）：**只考唯一写法的术语/名称/符号**——任何学过的人写出的正确答案至多差空白与大小写，题面自身锁定唯一答案；answer 为可接受答案数组（同义写法都列出）；**数字与代数式一律不进填空**：数字答案用 numeric，表达式答案用单选。
   - 数值（numeric）：answer 为数值，必须同时给 tol 容差（如 0.01）。
   - 反思（reflection）：开放式小反思，answer 写评分要点。至多 1 道。
2. 数学记法契约：题干、选项、解析里的一切数学一律 KaTeX——行内 $…$、独立式 $$…$$；禁止 ASCII 记号（x^2、a_1）与不带 $ 定界符的裸 LaTeX 命令。违反记法契约的题会被系统程序检测并拒收。
3. 每题必须给全：题干、答案、解析；解析 ≤4 句（约 150 字），按固定三段写——为什么对（1-2 句）→ 关键步骤（≤2 步，式子用 $$ 独立成行）→ 最易错点（1 句），用 markdown 短段或分点，不写大段连续文字。
4. 只考笔记正文里写过的内容，不得引入笔记没有的概念、记号或结论——这是学习者自己的知识库，出题是帮他记住自己写的，不是替他扩展。
5. 选择题 options 不带 A./B. 编号前缀（系统自动编号）；node 字段原样照抄系统给出的源 id。
6. 不出 ordering/matching/multi_choice/open_question（笔记复习源 v1 题型收敛）；不出交互件、不出题中题。
7. 查重：系统附有「题库已有题目」清单时，与清单中题面重复或高度相似（同考点同问法、仅换数字/措辞）的题一律不要出——换全新角度或不同考点出题。
8. 交卷前逐题自检（出题老师对答案键负责）：把每道题当作考生独立重解一遍，核对答案键、解析与题面三者一致，发现不一致以重解结果为准改完再交。

## 输出

只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

node: <源 id>
questions:
  - id: q1
    kind: single_choice
    q: 题干
    options: ["选项一", "选项二", "选项三", "选项四"]
    answer: A
    explanation: 解析
    difficulty: 1

YAML 写法注意：含反斜杠（LaTeX 命令）、冒号或特殊字符的标量一律用**单引号**包裹（如 q: '$x^2 - 1$'）；**禁用双引号**——双引号里 \\t \\n 会被 YAML 解释成控制字符，吃掉公式里的反斜杠。
`,
    // 项目域两模板（P 区 / #92；设计 docs/design/2026-09-project-artifact-design.md §3/§6）。
    // 项目产物不走风格变体（苏格拉底/费曼不适用），走默认路径。
    项目里程碑计划: `\
<!-- learnhub:prompt/v7 -->
# 项目里程碑计划提示词（用户可编辑；项目档案与现状计划由系统附在本模板之后）

你是 learnhub 学习系统的项目规划师。学习者有一个真实在做的实践项目，请根据附后的目标描述规划出有序的里程碑计划（4C/ID 全任务先行：计划是任务类由简到繁的梯度，不是知识点清单）。

## 硬约束

1. 只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

project: <项目 id，照抄系统给出的 id>
plan:
  - id: m1
    name: 里程碑名（一个可交付检查点）
    task_class: 任务类：本里程碑任务的复杂度性质与在简→繁梯度中的位置
    acceptance_hints: 验收要点草案（过点时对照的达标口径）
    est: 预计真实投入分钟数（正整数，按 1–2 周粒度诚实估计；过点对账按它定价）
    nodes: [关联课程节点]（可选；项目挂靠课程知识时才填，节点名或「课程/节点」）

2. 全项目 3–8 个里程碑，每个是 1–2 周粒度的可交付检查点，按任务类由简到繁排序。
3. 里程碑写「做出来的东西」，不写「学过的主题」：name 是可验收的交付物，不是章节名。
4. 渐退档（骨架/补全/独立）是项目属性，计划不写每里程碑档位。
5. est 诚实申报：它是过点 XP 对账的定价基础（N₀ × 难度校准），高估虚增账本、低估薄待投入。
6. nodes 只挂真实依赖课程知识的里程碑（里程碑检索点从这些节点的题池抽题、行为推断在其间找成分技能边）；纯实操里程碑不硬凑关联，关联永不构成完成门禁。
7. 计划走提案修订（apply 前有旧计划快照，不静默覆盖）：给出你认为当前最优的完整版本，不做保守的增量微调。
`,
    项目里程碑产物: `\
<!-- learnhub:prompt/v6 -->
# 项目里程碑产物提示词（用户可编辑；项目档案、里程碑任务与当前档位由系统附在本模板之后）

你是 learnhub 学习系统的项目任务设计师。为附后的单个里程碑生成一张任务卡（4C/ID completion task）：学习者拿到的是「部分完成任务 + 验收清单」，不是一节课。

## 输出结构（四块固定，缺一不可）

## 给定
（预置/已完成部分 + 情境起点）
## 待办
（学习者要做的事：有序步骤或自由任务描述，动词开头）
## 验收清单
- [ ] 行为句条目（学习者可自行核对）
## 支持
（即时信息：执行规则/提示/常见坑）

## 渐退三档配比（按系统给出的当前档位生成，只写一档，不是三档都写）

- 骨架档：给定 = 近完整示范 + 分步说明；待办 = 照做复现；验收清单 = 每步一条（最细）；支持 = 执行规则全量。
- 补全档（主战场）：给定 = 部分成品 + 用【待补全】显式标注缺口；待办 = 补全缺口；验收清单 = 覆盖缺口；支持 = 关键提示。
- 独立档：给定 = 只给情境与起点（不含解法路径、不出现【待补全】）；待办 = 全自主规划执行；验收清单 = 达标标准（最粗）；支持 = 自查提示/常见坑。

## 硬约束

1. 只输出这一个里程碑的任务卡（四块），不要解释、不要写其他里程碑。
2. 不出题：没有题目、选项、答案与题库字段；能力核对只走验收清单。
3. 验收清单条目 = 行为句（动词开头、学习者可自行核对），至少一条。
4. 只依据附后的项目目标、计划与本里程碑任务，不引入无关的技术栈或范围。
`,
    // 目标反编译（P 区 / #95；v8 种子簇形态 #149）：一次模型调用产出双产物（里程碑
    // 计划 + 知识子图种子簇），各自过既有 schema 门后分走 project_plan 提案与图谱域
    // seed 提案（同源同进同退）；显式目标课程时只产计划半区（课程的新入口只有种子/
    // 生长，新知识需要走计划修订驱动的教练补支）。
    // v9（ADR-0040）：seed 起点资格与种子提案同判据（一句）+ 上交前自查一行——种子簇
    // 走同一道人审，不加例组、硬约束保持最密克制。
    项目目标反编译: `\
<!-- learnhub:prompt/v9 -->
# 项目目标反编译提示词（用户可编辑；目标项目档案、注册笔记与 Vault 先验、知识子图落点由系统附在本模板之后）

你是 learnhub 学习系统的逆向设计师。学习者给出一个目标项目的描述，请做**逆向设计**（4C/ID 任务分析 + PjBL）：从「最终做出来的成果」反推有序的里程碑计划，再反推支撑这些里程碑的知识**种子簇**——知识清单是为项目服务的，不是先学完再动手。课程是生长式的：种子只是起点与终点，其余结构由教练沿真实的症状与消费逐步生长，你不铺满整张图。

## 输出（只输出一个 YAML 文档，不要代码围栏、不要任何解释）

project: <项目 id，照抄系统给出的 id>
plan:
  - id: m1
    name: 里程碑名（一个可交付检查点）
    task_class: 任务类：本里程碑任务的复杂度性质与在简→繁梯度中的位置
    acceptance_hints: 验收要点草案（过点时对照的达标口径）
    est: 预计真实投入分钟数（正整数，按 1–2 周粒度诚实估计；过点对账按它定价）
    nodes: [关联课程节点]（可选；写「课程名/节点名」全形）
seed:
  course: <课程名>（未给显式目标课程时自拟一个新课程名；给了显式课程则整个 seed 半区**省略**）
  goal_type: capability（默认能力锚定，完成=终点掌握；清单式目标才写 coverage 并带 worksheet 块工作表）
  endpoint:
    name: 终点节点名（课程完成判据锚定的终点：做完项目所需能力的合成处）
    region: 区名
    block: 块名
    note: 一句话说明该终点合成项目的最终能力
    teaches: {概念名: 知道|会用|能教}
  starts:
    - name: 起点节点名（1–3 个；项目起步就能动手的入口）
      region: 区名
      block: 块名
      note: 一句话说明它支撑哪个里程碑
      teaches: {概念名: 知道|会用|能教}
  concepts:
    - canonical: 概念名（teaches/assumes 引用的每个概念都要在这里铸名，或精确照抄系统给出的在册名字）

## 硬约束

1. plan：全项目 3–8 个里程碑，每个是 1–2 周粒度的可交付检查点，按任务类由简到繁排序；里程碑写「做出来的东西」，不写「学过的主题」（name 是可验收的交付物，不是章节名）。修订场景：未实质变化的里程碑**沿用原 id**（里程碑身份锚钉 id，id 变了等于删+增），nodes 换挂靠就保留 id 改 nodes。
2. est 诚实申报：它是过点 XP 对账的定价基础，高估虚增账本、低估薄待投入。
3. nodes 只挂真实依赖课程知识的里程碑；纯实操里程碑不硬凑关联，关联永不构成完成门禁。
4. 名字对账：nodes 引用的每个节点名必须落在种子簇节点名或「现有结构」列出的既有节点名内——计划引用悬空节点会在过点/检索点/行使消费面炸，整体拒收。新知识缺口不硬凑名字：留给教练按计划修订补支生长。
5. seed 只收项目起步真实需要的知识（1–3 起点 + 1 终点）：节点是学习单元（一节课的粒度），**零 est 零 enc 零 pre**（朝终点的粗占位边由引擎落到终点前置）；teaches/assumes 引用的概念一律经 concepts 铸名或精确照抄在册名字。起点资格同种子提案：单一行为单元、零复合概念、零基础从常识直接可起步——复合概念留给教练沿生长补。
6. 若附有「学习者已有理解（Vault 先验）」段：反推时尊重学习者已有的理解与记法——他笔记里已熟练的内容不必铺起点，种子可直接从缺口接续；记法沿用其笔记写法。
7. 两份产物都只是**提案**（人审通过才生效）：给出你认为当前最优的完整版本，不做保守的增量微调；双提案同进同退（一起生效或一起放弃）。
8. 上交前自查：里程碑都是可验收交付物（不是主题）；plan.nodes 引用全部对得上账；seed 起点是单一行为单元。
`,
    // 回执评审（U-1 #88 / ADR-0016）：外部练习回执的 AI 量表评审。评分深度（full/brief，
    // 渐退反馈）由系统附上，模板只定义评分立场与 JSON 契约。
    回执评审: `\
<!-- learnhub:prompt/v6 -->
# 回执评审提示词（用户可编辑；回执材料、量表来源与本次评审深度由系统附在本模板之后）

你是 learnhub 学习系统的练习评审教练。学习者提交了一份真实练习的外部回执（自报即可信，不设反作弊门），请按量表给一次**错误具体**的定向评审。

## 评审立场

1. 这是回执触发的讲解（错误当下的定向反馈），不是自由答疑：只对照量表来源逐点评审，不扩展新主题、不布置作业。
2. 量表分（0–1）诚实反映回执对照量表来源的达成度：不安慰性给分，也不因材料单薄而惩罚性扣分（材料薄就按可见部分评，并在 verdict 注明依据有限）。
3. 错误具体 = 指到「哪个要点、错在哪、怎么改」，不写「整体不错，继续加油」式的空评。
4. 回执是学习者真实练习的记录：语气直接但尊重劳动，错误归错误、肯定归肯定。
`,
    // 错误对比卡（C-3 #82）：从作答流水挖出的高频错误模式 → 「三选一，其中一项是
    // 学习者的错法」辨别卡（错误管理训练：错法本身成为复习对象，入错误 deck 走 FSRS）。
    错误对比卡: `<!-- learnhub:prompt/v7 -->
# 错误对比卡生成提示词（用户可编辑；挖出的错误模式与原题材料由系统附在本模板之后）

你是 learnhub 学习系统的错误教练。学习者在一批题目上反复犯了错，请把每个错误模式做成一张「三选一」辨别卡：三个选项里，一项是正确做法，一项就是**这位学习者自己的错法**（从附材料的学习者错答里提炼），一项是有辨析价值的干扰做法——让错法本身成为复习对象。

## 硬约束

1. 只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

cards:
  - node: <节点名，照抄候选给出的节点名>
    source_q: <原题 id，照抄候选给出的 qid>
    q: 情境题面（把原题情境重述成「该用哪个做法」的选择情境；不要照抄原题问法）
    options: ["做法一", "做法二", "做法三"]
    answer: <正确做法项的原文，与 options 中一项逐字一致>
    mine: <学习者错法项的原文，与 options 中一项逐字一致，不得与 answer 相同>
    explanation: 为什么正确项对、学习者的错法错在哪、怎么辨析（≤4 句）

2. 每张卡恰好 3 个选项，互不相同、句式相近（不靠措辞长短或详略泄露答案）；三个选项在 options 里乱序给出。
3. mine 忠实还原学习者的真实思路（以其错答为准），不要美化为标准错误示例——这张卡考的是「认出自己的错法并选对」。
4. 干扰项来自同族常见误区（有迷惑性但可辨析），不设明显错误的凑数项。
5. 只依据附后的原题、正确答案、解析、学习者错答与节正文出卡，不得引入材料外的新概念。
6. 系统给出的每个候选都出恰好一张卡；node 与 source_q 必须逐字照抄候选标注。
7. 若附有「误解先验（出生期候选错法）」段：第三个选项（干扰做法）优先从中改编（选与本题考点同族的）；真实数据优先——mine 仍以学习者错答为准，先验只是候选错法，不是证据。
`,
    // 罗盘初画（#143 / ADR-0033 透明度装置）：旧一次成型大纲管线的降职继承者——种子
    // apply 后画出非承诺路线草图初稿；此后「剩余路线」由教练随生长批重写（唯一写权）。
    罗盘初画: `\
<!-- learnhub:prompt/v1 -->
# 罗盘初画提示词（用户可编辑；终点锚、种子与当前图、学习者批注由系统附在本模板之后）

你是 learnhub 学习系统的路线教练。这门课刚播种（起点 + 终点锚，一次人审即开工），请画出「剩余路线」初稿——从起点到终点的路线草图。它是常驻可见的地形感，不是承诺，也不是权威结构；此后教练随生长批重画。

## 硬约束

1. 只输出「剩余路线」一节的正文（markdown，不带 "## " 标题、不带代码围栏、不要解释）：3–7 个阶段条目，每条一行，格式 \`- **阶段名**：一句话（这个阶段为什么朝终点推进）\`。
2. 路线是草图不是承诺：不写时间估算、不写进度百分比、不写「将完成/保证」；用「方向/大致/候选」等措辞——沙盘 ETA 才是推演参照，且那是「模型推演，非承诺」。
3. 只把「当前图节点」里已有的节点当确定路标；你提议补的台阶/支线一律标注「（候选）」，落图由教练生长批裁决。
4. 附有「块工作表」（覆盖锚定课程）时：阶段按工作表块组织，顺序服务于终点综合；块清单是完成判据的核对表，路线不复制它的承诺语义。
5. 附有「学习者批注」时：它是软输入——提议非指令；与你的判断冲突时保留你的路线，并在受影响阶段行尾以（批注：…）回应一句。
6. 能力锚定课程：阶段服务于终点掌握（前置闭包怎么长、能力怎么合成），不罗列教科书目录。
`,
    // 教练回合（#145/#150 / ADR-0033 滚动教练）：每生长批一次的裁决面——读上下文包
    // 与图面，从生长算子集裁决下一步，产出一个生长批（kind=edit 提案 + note 区裁决 +
    // 罗盘重写）。裁决语义（算子语义、停机转译、分歧三段升级）全在提示词——受理门只
    // 锁组装与 schema。
    // v2（#146）：插入批随批预注册复诊（note.recheck）+ 插入积极性调速（闸门拒收超速批）。
    // v3（ADR-0040）：生长纪律段回归——认知粒度/动作句命名/依赖充分性/边级自查/上交前自查
    // （旧一次成型 SKILL.md 理念条款的生长式转世，allo 同源校勘；受理门查不了的生成时质量）。
    // v4（#150）：分歧纪律升三段式——轻量段免仲裁税、真分歧升全量段重裁、全量段仍真分歧
    // 升双沙盘仲裁段终审（两份分位带作参照；沙盘只读、非承诺措辞照旧——ADR-0025 不动）。
    教练回合: `\
<!-- learnhub:prompt/v4 -->
# 教练回合提示词（用户可编辑；上下文包与当前图面由系统附在本模板之后）

你是 learnhub 学习系统的滚动教练（ADR-0033 生长式图）。这门课的图从种子出发、由你的裁决沿真实的症状与消费逐步生长——每个节点都因真实的需要而存在，没有预先铺满的骨架。读附后的上下文包与图面，从生长算子集里裁决下一步，产出一个生长批。回合被拉起 = 就绪深度检查未满足（可学的正文不足）——除非结构已无需变化（等内容生成跟上），你应产出一个朝终点推进的最小必要批。

## 生长算子集（停机规则已转译进算子语义，一批恰用一个算子）

- **前进**：目标消费——沿终点方向给当前前沿补下一步台阶，服务终点前置闭包的合成。
- **插入**：症状消费——卡点集中度/停滞天数指向缺口时，在症状出现的当场补过渡节点。插入边带预注册复诊（note.recheck：恰一枚可机判 metric——前进恢复/卡点集中度降幅/保留率恢复，选与症状同源的那一枚；days 缺省 10 学习日），到期由引擎自动结算：达标转正（proven）、不达标自动剪除并恢复原粗边——你只管裁决与预注册，不写任何复诊结论。近期复诊通过率低/插入超限时受理门会闸停插入批：此时改裁 前进/巩固，别硬插。
- **巩固**：在足迹末端接综合收束节点，**只引已教概念**（图面在册 teaches 概念）做综合与收束；不走复诊。
- **旁支**：教学消费——为讲清主线必须先教的支线台阶；不走复诊（旁支占比有韧性闸门上限，超限批会被拒收）。
- **换向**：学习者批注/目标指向变化时重定路线方向；无项目课程的换终点不归你（走重新种子提案人审）——换向几乎总是补支，不是改锚。

## 三段式与分歧纪律

1. 本回合可能是轻量段（只带行为摘要与罗盘）：显然步直接裁决，**免仲裁税**——不声明分歧、不要求更多上下文。
2. 只有**真分歧**才在 note.disagreement 写一句话声明（你与上下文数据/学习者批注存在实质分歧、轻量段信息不足以裁决）：系统会升级全量段（六区块 + deep 档）重裁。没有真分歧绝不声明。
3. 全量段带着六区块重裁后**仍存在真分歧**（裁决依旧撕不动）才再次声明：系统会跑双沙盘（现状照走 vs 含本批照走的蒙特卡洛推演对照）并附两份分位带，拉起仲裁段终审。六区块能裁动就绝不声明。
4. 若附有「双沙盘推演（终审参照）」段：本回合即仲裁段（全量包 + 双沙盘参照）。推演只模拟「记」的维持——本批的收益不在推演里，两带差异只读作预算/保留的代价参考；你带参照做**终审裁决**，结论即最终裁决，note.disagreement 不再写（没有更多段了）。推演措辞是「模型推演，非承诺」——不因带好看而改判教学判断。

## 生长纪律（生成时质量——受理门只锁 schema 与结构事实，这些靠你自查）

- **认知粒度**：每个新节点是一次独立的学习行为单元。自问：零基础学习者能否在 30 分钟内从它的 pre 直接学会？不能 → 拆成台阶或先补前置；est 按此诚实申报（分钟）。
- **动作句命名**：节点名大多是动作句（解/求/证/推导/比较/判定……）——人对概念的单次学习行为是动作。「理解导数」「学习导数」这类层级不清的近似名禁用；「Python 基础语法」这类复合泛称不是一个学习行为。螺旋式合法：同一主题可在不同深度以不同视角重现，但名称必须可区分。
- **依赖充分性**：新节点的 pre 是它**完整的直接前置集合**——不懂 pre 里任何一条都会卡在本节；不塞间接前置（传递依赖交给图），除真无基础的入门步外 pre 不为空。
- **真实依赖优先于难度曲线**：前进补台阶遇到难度跳跃，先保证 pre 正确；铺垫缺口不硬塞——难度跳跃就是症状，下一回合的插入会在当场补过渡。
- **边级自查**：本批每条新 pre 边给一句 verdict——删掉这条边，学习会在哪一步失控？答不出具体失控点 = 冗余，不写；失控点中间缺一环 = 先补那个节点再引。

上交前逐条自查：每个新节点过一遍 30 分钟自问与动作句命名；每条新 pre 边过一遍 verdict。

## 硬约束

1. 只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

course: <课程名，照抄上下文包标题>
note:
  operator: 前进|插入|巩固|旁支|换向
  reason: 一句话（这批为什么朝终点推进/回应什么症状）
  disagreement: 分歧声明（可选；真分歧才写）
  recheck:
    metric: 前进恢复|卡点集中度降幅|保留率恢复
    days: 10
route: |
  - **阶段名**：一句话（重写后的「剩余路线」，3–7 条）
ops:
  - op: add_node
    name: 节点名
    region: 区名
    block: 块名
    pre: [图面中的既有节点名]
    est: 15
    bloom: 理解
    difficulty: 2
    teaches: {概念名: 会用}
    assumes: {概念名: 知道}
concepts:
  - canonical: 新概念名

2. 每批规模克制：≤8 个操作、只朝一个算子方向；apply 后看清全图再规划下一批——你每批重算一次，不做一次性规划。
3. 节点名、pre 引用、区/块名**逐字来自图面**；pre 只能引用图中已有节点或本批更早创建的节点。就绪深度已够、结构无需变化时写 \`ops: []\`（裁决=等内容跟上，route 照写）。
4. teaches/assumes/误解里的概念必须是登记表在册名字（照抄「登记表档位」区块）或随本批 concepts 铸名的新概念；一个名字至多铸一次，已能用就不铸。
5. route 恒写：罗盘「剩余路线」随批重写（3–7 条阶段条目，非承诺措辞——不写时间估算与进度承诺；路线只是草图）。
6. 巩固批纪律：巩固节点的 teaches/assumes/误解**只引已教概念**，受理门会拒收新概念。
7. 插入批纪律：note.recheck 必填（metric 与症状同源；days 缺省 10，合法区间 5–20 学习日，越界会被 clamp）；非插入批不得携带 recheck。
8. YAML 写法注意：含冒号、反斜杠或特殊字符的标量一律用**单引号**包裹；禁用双引号（\\t \\n 会吃掉公式反斜杠）。
`,
    // 种子提案（#142 受理语义 + 面板下发起草面）：从学习者的目标描述（+选配 vault
    // 先验的熟悉边界）起草 kind=seed 提案 YAML；起点定位、目标类型二分、种子骨架模式
    // 都在提示词——受理门（schema/注册表对账/结构/概念对表）在 proposeSeed 权威重跑，
    // 一次人审即开工（词条「种子」）。
    // v2（ADR-0040）：起点资格判据——单一行为单元/零复合概念/常识可起步/宁简勿繁 +
    // 操作化正反例（实测疼点：零基础自述下起点仍含复合概念，坡道第一级就是复合泛称）。
    种子提案: `\
<!-- learnhub:prompt/v2 -->
# 种子提案提示词（用户可编辑；目标描述、模式绑定与 vault 先验检索由系统附在本模板之后）

你是 learnhub 学习系统的建课教练（ADR-0033 生长式图）。学习者给出一句话或一段话的学习目标，你把它起草成一个种子提案：1–3 个起点节点 + 一个终点节点。课程从种子出发、由教练回合沿真实的症状与消费逐步生长——没有预先铺满的骨架，所以种子要小而准，不替后续生长预支结构。

## 起点资格（受理门查不了，靠你把关）

起点是坡道的第一级台阶，任何情况下都必须是**单一行为单元**：

- 零复合概念：名字连缀两个可独立教学的对象（与/和/及/的关系），或要先解释名字本身才能开学的行话泛称，都不合格。「Python 基础语法」✗ →「装好环境并运行第一行代码」✓；「导数与连续性的关系」✗ →「用生活例子算一次平均变化率」✓。
- 零基础学习者从常识直接可起步：不依赖任何尚未教的概念。学习者自述的基础水平（见目标描述）只写进 reason 点一句「略过哪些地形」，**不放松起点资格**——复合概念留给生长路径。
- 宁简勿繁：起点过简的代价趋近零（很快被生长消费掉），过繁的代价是整条坡道断裂。

## 硬约束

1. 只输出一个 YAML 文档（不要代码围栏、不要任何解释），结构如下：

course: <课程名，照抄附后的「课程名」字段>
mode: new|reseed
reason: 一句话（为什么这样定位起点与终点）
goal_type: capability|coverage
endpoint:
  name: 终点节点名
  region: 区名
  block: 块名
starts:
  - name: 起点节点名
    region: 区名
    block: 块名
    basis: baseline|vault
worksheet:
  - block: 块名

2. 起点恰 1–3 个、终点恰 1 个；种子节点零 enc 零 est 零 pre——朝终点的粗占位边由引擎落，pre/est/enc/teaches/bloom/difficulty 等节点字段一律不写。
3. worksheet 仅 goal_type=coverage 时携带（照抄附后的块工作表段）；capability 不得携带。
4. 起点定位（basis）：附有「学习者已有理解（Vault 先验）」段时，把起点放在熟悉边界——学习者笔记已稳定覆盖的内容不作起点（那是可快速略过的地形，在 reason 里点一句），basis 写 vault；没有该段或检索无命中 → 常识基线起步，basis 写 baseline。
5. goal_type 照抄附后的「目标类型」：capability（完成 = 终点掌握，默认）/ coverage（完成 = 块工作表 + 终点，仅目标显式是「过一遍/覆盖清单」式）。
6. mode 照抄附后的「模式」：reseed = 既有课程换终点/改工作表，终点可换、起点通常保留——除非目标本身变了。
7. 节点名用学习者视角的人话（一次独立的学习行为单元，不是原子知识点），起点名用动作句（见起点资格）；region/block 自拟且全提案一致。
8. YAML 写法注意：含冒号、反斜杠或特殊字符的标量一律用**单引号**包裹；禁用双引号。
`,
  }

  /** 读提示词模板；内置模板带版本标记，vault 快照缺标记或版本更低时覆盖升级（旧文件存 .bak 供 diff 恢复），
   * 非内置类型要求用户已自建同名文件。
   * {{renderers}} 占位符注入渲染能力清单；旧模板缺占位符时在末尾追加注入段（运行时兜底，不改用户文件）。 */
  async loadPrompt(kind: string): Promise<string> {
    const builtin = Content.PROMPT_KINDS[kind]
    await this.fs.mkdir(this.paths.promptDir)
    const p = `${this.paths.promptDir}/${kind}.md`
    if (!builtin && !this.fs.exists(p)) {
      throw new Error(`[prompt] 未知提示词类型: ${kind}（内置：${Object.keys(Content.PROMPT_KINDS).join('、')}；或在 state/提示词/ 自建 ${kind}.md）`)
    }
    if (builtin) {
      const vaultVer = this.fs.exists(p) ? Content.promptVersionOf(await this.fs.readFile(p)) : 0
      if (vaultVer < Content.promptVersionOf(builtin)) {
        if (this.fs.exists(p)) await this.fs.writeFile(`${p}.bak`, await this.fs.readFile(p))
        await this.fs.writeFile(p, builtin)
      }
    }
    const text = await this.fs.readFile(p)
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
      for (const f of await this.fs.readdir(this.paths.promptDir)) {
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
    if (!this.fs.exists(p)) return table
    let inSection = false
    for (const line of (await this.fs.readFile(p)).split('\n')) {
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

  /** 节形状门禁：节内 ### 子标题降 warn（破坏原子性，但不可程序修复——不硬拦）；
   * 节 prose 过长按档位锚点派生阈值（warn=预算×1.3 / finding=预算×2，见
   * sectionLengthThresholds）；可视化块（mermaid/svg/plot/chart/交互件引用）超
   * SECTION_VISUAL_CAP 即 finding——「1–2 屏」的屏占由文字与可视化共同构成，
   * 长度治理两头都管（长度口径派生自复杂度档案，不另设全局阈值）。长度剥离
   * 代码块/行内代码/公式/机器注释后计数——公式与图表不占文字预算。 */
  static checkSectionShape(body: string, sectionWordBudget: number): { findings: string[]; warns: string[] } {
    const findings: string[] = []
    const warns: string[] = []
    const { warn, block } = sectionLengthThresholds(sectionWordBudget)
    for (const part of body.split(/^## /m).slice(1)) {
      const nl = part.indexOf('\n')
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim()
      if (!title || title.startsWith('<!--')) continue // 机器区不参与节形状
      const md = nl >= 0 ? part.slice(nl + 1) : ''
      if (/^### /m.test(md)) {
        warns.push(`节「${title}」内出现 ### 子标题（破坏节的原子性——一节只讲一个知识点；请并入正文或拆成多个节）`)
      }
      // 交互件两种时态都算一块：落盘后的 ```interactive 引用块与生成时的 ```learnhub-interactive: 标记块
      const visuals = [...md.matchAll(/^```([A-Za-z0-9_-]+)/gm)]
        .map(m => (m[1]!.toLowerCase().startsWith('learnhub-interactive') ? 'interactive' : m[1]!.toLowerCase()))
        .filter(l => SECTION_VISUAL_LANGS.has(l)).length
      if (visuals > SECTION_VISUAL_CAP) {
        findings.push(`节「${title}」可视化块 ${visuals} 个超过上限 ${SECTION_VISUAL_CAP}（mermaid/svg/plot/chart/交互件合计）：合并或精简可视化，或把内容拆成多个节`)
      }
      const prose = md
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '')
        .replace(/\$\$[\s\S]*?\$\$/g, '')
        .replace(/\$[^$\n]+\$/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, '')
      if (prose.length > block) {
        findings.push(`节「${title}」正文过长（约 ${prose.length} 字 > 拒收线 ${block} 字 = 单节预算 ${sectionWordBudget}×2；字数按去空白、去公式与可视化/交互块后的正文字数计——公式与图不占预算）：一节 = 学习页 1–2 屏，把内容拆成多个节（管线可自动拆）或压缩文字`)
      } else if (prose.length > warn) {
        warns.push(`节「${title}」正文偏长（约 ${prose.length} 字 > 警告线 ${warn} 字 = 单节预算 ${sectionWordBudget}×1.3；字数按去空白、去公式与可视化/交互块后的正文字数计）：可视化为主、文字为辅，建议压缩或拆节`)
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

  /** 未注册的代码块语言（面板无渲染器、会降级为源码显示）→ 警告，防 AI 产出渲染不了的块。
   * learnhub- 前缀是引擎管理的机器块（learnhub-predict 预测门等），有自己的结构门，不在此列。 */
  static checkRendererLangs(body: string): string[] {
    const known = new Set(RENDERERS.map(r => r.lang))
    const hits = new Set<string>()
    for (const m of body.matchAll(/^```([A-Za-z0-9_-]+)/gm)) {
      const lang = m[1].toLowerCase()
      if (lang.startsWith('learnhub-')) continue
      if (lang && !known.has(lang) && !PLAIN_CODE_LANGS.has(lang)) hits.add(lang)
    }
    return [...hits].sort()
  }

  /** 正文是否含预测门机器块（思维节必备门用）。 */
  static hasPredictBlock(body: string): boolean {
    return predictBlockRe().test(body)
  }

  /** 预测门块结构门（P-8 #97）：learnhub-predict 块逐块解析——字段齐全、options 2–4 项
   * 互异、answer ∈ options。任何节里出现该块都须合法（MdView 会渲染成阅读流门）。 */
  static checkPredictBlocks(body: string): string[] {
    const findings: string[] = []
    let i = 0
    for (const m of body.matchAll(predictBlockRe())) {
      i++
      const v = parsePredictBlock(m[1]!)
      if ('error' in v) findings.push('```learnhub-predict 第 ' + i + ' 块不合法：' + v.error)
    }
    return findings
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
    const clean = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
    try {
      return clean(JSON.parse(text))
    } catch {
      // fast 档模型高频失误是尾随逗号:仅当原始解析失败时清洗重试,不改语义。
      // 误报面仅剩「字符串字面量内含 `,}` 且恰好是唯一语法错误」,可接受。
      try {
        return clean(JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')))
      } catch {
        return false
      }
    }
  }

  /** 程序性修复后的富内容块改写结果（落盘前调用；不改语义，只修机器可判的脏输入）。 */
  static fixRichBlocks(body: string): string {
    // plot/chart：JSON 尾随逗号/行注释是 fast 档模型高频失误；面板解析失败会降级源码，
    // 单靠门禁容忍不够——落盘前把可解析的脏 JSON 改写为规范 JSON.stringify 产物。
    // 合法 JSON 原样保留（不重排，避免与模型产出逐字 diff）。
    body = body.replace(/^```(plot|chart)[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm, (whole, lang: string, code: string) => {
      // 严格 JSON.parse 成功 → 合法产出，原样保留（不重排，避免与模型产出逐字 diff）
      if (Content.strictJsonObject(code)) return whole
      const parsed = Content.parseLooseJsonObject(code) // 脏输入：尾随逗号/行注释
      if (!parsed) return whole // 仍不可解析:留给门禁 finding,回灌模型定向修复
      return `\`\`\`${lang}\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
    })
    // svg：前导杂质裁剪至首个 <svg（门禁要求块以 <svg 开头）
    body = body.replace(/^```svg[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm, (whole, code: string) => {
      const idx = code.indexOf('<svg')
      if (idx <= 0) return whole
      return '```svg\n' + code.slice(idx) + '```'
    })
    // mermaid：节点文本含 | 等特殊字符且未整体双引号包裹时自动补引号（渲染降级的高频根因）
    body = body.replace(/^```mermaid[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm, (whole, code: string) => {
      const fixed = code.split('\n').map(line =>
        line.replace(/(\w[\w\u4e00-\u9fff]*)\[([^\]"\n]*\|[^\]"\n]*)\]/g, (_m, id: string, label: string) => `${id}["${label.replace(/"/g, '\\"')}"]`),
      ).join('\n')
      return fixed === code ? whole : '```mermaid\n' + fixed + '```'
    })
    return body
  }

  /** 别名一致性程序化修复（#147 QC 格式类门禁程序化修复）：正文出现不采用名 →
   * 全部替换为采用名（别名词表是课程规范的纯文字映射，替换语义安全）；
   * 返回修复明细供 journal 留痕。写侧修复——contentCheck 只读校验不受影响。 */
  async fixAliases(root: string, body: string): Promise<{ body: string; fixed: string[] }> {
    const table = await this.aliasTable(root)
    let out = body
    const fixed: string[] = []
    for (const [bad, good] of Object.entries(table)) {
      if (out.includes(bad)) {
        out = out.split(bad).join(good)
        fixed.push(`${bad}→${good}`)
      }
    }
    return { body: out, fixed }
  }

  /** 严格解析为 JSON 对象才为真（不容忍尾随逗号——fixRichBlocks 用它区分脏输入）。 */
  private static strictJsonObject(text: string): boolean {
    try {
      const v: unknown = JSON.parse(text)
      return typeof v === 'object' && v !== null && !Array.isArray(v)
    } catch {
      return false
    }
  }

  /** 视觉块序号 → 该块正文首行摘录（≤60 字；修复回灌时给模型定位用）。 */
  static visualBlockExcerpt(body: string, n: number): string | null {
    let i = 0
    for (const m of body.matchAll(/^```(plot|chart|svg)[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm)) {
      i++
      if (i === n) {
        const firstLine = m[2]!.trim().split('\n').find(ln => ln.trim()) ?? ''
        return firstLine.slice(0, 60) || null
      }
    }
    return null
  }

  /** 把一条门禁 finding/warn 文本按违规位置定位：视觉块 findings 附块内首行摘录。 */
  static locateFinding(body: string, finding: string): string {
    const m = /第 (\d+) 块/.exec(finding)
    if (!m) return finding
    const excerpt = Content.visualBlockExcerpt(body, Number(m[1]))
    return excerpt ? `${finding}\n       （违规定位：该块内容以 "${excerpt}" 开头）` : finding
  }

  /** 修复轮 prompt：把上一次输出 + 质检清单（附定位）回灌。正文过长 finding 附显式
   * 压缩目标与计数口径（ADR-0054：旧版只说「拆成多个节」，在「只输出一节」的修复轮里
   * 不可执行，压到多少也从未直说）；拆节的出路归管线（大纲拆节），不劝模型拆。 */
  static sectionRepairPrompt(
    basePrompt: string, previousOutput: string, gateReport: string,
    opts?: { wordBudget?: number },
  ): string {
    const locatedLines = gateReport.split('\n')
      .map(ln => Content.locateFinding(previousOutput, ln))
      .join('\n')
    const overflow = gateReport.includes('正文过长')
    const headline = overflow
      ? '## 上一次输出未过质检门（✗ 项必须全部修复；正文过长的修复 = 压缩文字，不是删结构）'
      : '## 上一次输出未过质检门（只重写下列 ✗ 项定位到的违规局部，其余内容原样保留；不要整节重新发挥）'
    const budgetBlock = overflow && opts?.wordBudget
      ? `\n## 压缩目标\n\n- 把超长节的正文压缩到 ≤ ${opts.wordBudget} 字（安全余量：目标 ${Math.ceil(opts.wordBudget * 1.3)} 字以内必过）。字数按去空白、去公式与可视化/交互块后的**纯文字数**计——公式、mermaid/svg/plot/chart 图、交互件不占预算，先删冗余解说与重复示例，可视化方案保留。\n- 拆成多个节由生成管线自动处理，本调用不需要也不会接受拆节——只输出压缩后的一节。\n`
      : ''
    return `${basePrompt}\n\n${headline}\n\n上次输出：\n\n${previousOutput}\n\n质检清单：\n\n${locatedLines}\n${budgetBlock}`
  }

  // ---- 修复轮·块级局部修补（#147：不再整节重跑） ----

  /** 可局部修补的违规块：```plot/chart/svg/learnhub-predict 第 N 块（各自语言独立编号，
   * 与门禁 finding 文本的编号口径一致）。其余 finding（节形状/别名/交互件契约）不是
   * 块级可定位的，走整节修复。 */
  static readonly BLOCK_FINDING_RE = /```(plot|chart|svg|learnhub-predict) 第 (\d+) 块/g

  /** 块级修补计划：质检清单里**每一条** finding 都能定位到具体违规块时返回计划
   * （块按门禁同款正则定位、记录原文），否则 null——一条非块级 finding 混入就放弃
   * 局部修补（fail-safe 回整节修复，不猜测）。 */
  static blockPatchPlan(body: string, gateReport: string): Array<{ kind: string; index: number; original: string }> | null {
    const wanted = new Set<string>()
    for (const m of gateReport.matchAll(Content.BLOCK_FINDING_RE)) {
      wanted.add(`${m[1]}#${m[2]}`)
    }
    if (!wanted.size) return null
    // ✗ 级 finding（清单里 ⚠ 是警告不拦落盘）出现任何非块级条目 → 不走局部修补
    //（模型看不到完整上下文会修错方向），fail-safe 回整节修复。
    const findingLines = gateReport.split('\n').filter(ln => /^\s*✗/.test(ln) && ln.trim())
    if (findingLines.length > wanted.size) return null
    const out: Array<{ kind: string; index: number; original: string }> = []
    for (const kind of ['plot', 'chart', 'svg', 'learnhub-predict']) {
      const re = kind === 'learnhub-predict'
        ? predictBlockRe()
        : new RegExp('^```' + kind + '[ \\t]*\\r?\\n([\\s\\S]*?)```[ \\t]*\\r?$', 'gm')
      const hits = [...body.matchAll(re)]
      for (const key of wanted) {
        const [k, n] = key.split('#')
        if (k === kind && hits[Number(n) - 1]) {
          out.push({ kind, index: Number(n), original: hits[Number(n) - 1]![0] })
        }
      }
    }
    return out.length === wanted.size ? out : null
  }

  /** 块级修补 prompt：只给违规块原文，只要求逐块交替换块（含围栏行），按清单顺序。 */
  static blockPatchPrompt(blocks: Array<{ kind: string; original: string }>): string {
    return [
      '下列代码块未过质检门，请逐块修复（只修违规点，不改动块内其余内容）：',
      '',
      ...blocks.map((b, i) => `### 违规块 ${i + 1}（\`\`\`${b.kind}）\n\n${b.original}`),
      '',
      '## 输出',
      '',
      `只输出 ${blocks.length} 个替换代码块（含围栏行，围栏语言与原块一致），按违规块清单顺序；不要输出解释、不要输出未点名的块。`,
    ].join('\n')
  }

  /** 应用块级修补：replacementBlocks 与计划一一对应（数量不符返回 null，交由调用方
   * 回退整节修复）；按定位把原块原文替换为替换块（相同原文的块按出现序逐个替换）。 */
  static applyBlockPatch(body: string, blocks: Array<{ original: string }>, replacementBlocks: string[]): string | null {
    if (replacementBlocks.length !== blocks.length) return null
    let out = body
    for (let i = 0; i < blocks.length; i++) {
      const original = blocks[i]!.original
      const at = out.indexOf(original)
      if (at < 0) return null
      out = out.slice(0, at) + replacementBlocks[i] + out.slice(at + original.length)
    }
    return out
  }

  /** 从模型修复产出中提取替换块（围栏块全文，按出现序；无围栏的输出返回空表）。 */
  static extractFencedBlocks(md: string): string[] {
    return [...md.matchAll(/^```[A-Za-z0-9_-]+[^\n]*\n[\s\S]*?```[ \t]*\r?$/gm)].map(m => m[0].replace(/\r$/, '').trimEnd())
  }

  /** JSON 尾随逗号 + 行注释容忍解析（`// …` 到行尾，不拆字符串；仍非对象返回 null）。 */
  private static parseLooseJsonObject(code: string): Record<string, unknown> | null {
    const isObj = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
    try {
      const v: unknown = JSON.parse(code)
      return isObj(v) ? v : null
    } catch {
      // 逐行剥 // 注释（不触碰字符串内的 //，如 https://——先剥引号外安全区域再回退整体剥尾随逗号）
      const stripped = code.split('\n').map(ln => ln.replace(/^(\s*)\/\/.*$/, '$1')).join('\n')
      try {
        const v: unknown = JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'))
        return isObj(v) ? v : null
      } catch {
        return null
      }
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
    findings.push(...Content.checkPredictBlocks(body))
    findings.push(...Content.checkVisualBlocks(body))
    const checkedBody = this.stripRoadmapSections(body)
    const shape = Content.checkSectionShape(checkedBody, TIER_ANCHORS[nodeTierOf(graph, node)].sectionWordBudget)
    findings.push(...shape.findings)
    warns.push(...shape.warns)
    warns.push(...Content.checkMermaidQuotes(checkedBody))
    const missingInteractive: string[] = []
    for (const m of body.matchAll(/```interactive\n([^\n]+)\n```/g)) {
      // 引用块统一存「学习中心相对路径」（extractInteractive 写入 <课程根>/<rel>，交互件伺服按同一路径解析）
      const rel = m[1].trim()
      if (!this.fs.exists(`${this.paths.centerRoot}/${rel}`)) missingInteractive.push(rel)
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
      // 节段难度档（#147）：大纲期定的出题难度递进锚；只收 低/中/高，非法值视为缺席
      // （走推导路径，不拒收——档位不进门禁）。
      const tier = typeof e.tier === 'string' && TIER_LABEL_TO_IDX[e.tier] !== undefined ? e.tier as '低' | '中' | '高' : undefined
      out.push({ id, title, type, status: 'pending', version: 0, ...(points ? { points } : {}), ...(tier ? { tier } : {}) })
    })
    return out
  }

  // ---- 拆节（ADR-0054 修复阶梯末级：压缩修复仍溢出的节在大纲侧一拆为 2–3 个子节） ----

  /** 拆节 YAML → 子节清单：复用 parseOutline 校验（title 必填、type ∈ 节类型菜单），
   * 模型的 id 字段一律忽略（引擎派生 `${parentId}-N` 防撞名），数量锁 2–3。 */
  static parseSplitOutline(yamlText: string, parentId: string): SectionManifest[] {
    const subs = Content.parseOutline(yamlText)
    if (subs.length < 2 || subs.length > 3) {
      throw new Error(`[split] 拆节要求 2–3 个子节，模型给出 ${subs.length} 个。`)
    }
    return subs.map((s, i) => ({ ...s, id: `${parentId}-${i + 1}`, status: 'pending' as const, version: 0 }))
  }

  /** 拆节的清单替换核心（纯函数）：只有 pending 节可拆（ready 节有已落盘正文，拆节会
   * 孤儿化内容），拆后总节数不越上限；位次原位替换，返回新清单（原清单不变）。 */
  static applySplit(sections: SectionManifest[], sectionId: string, subs: SectionManifest[], maxSections: number): SectionManifest[] {
    const idx = sections.findIndex(m => m.id === sectionId)
    if (idx < 0) throw new Error(`[split] 节清单里没有「${sectionId}」。`)
    if (sections[idx]!.status !== 'pending') {
      throw new Error(`[split] 只有未落盘的节才能拆（「${sections[idx]!.title}」已是 ready）。`)
    }
    const total = sections.length - 1 + subs.length
    if (total > maxSections) {
      throw new Error(`[split] 拆后总节数 ${total} 超过上限 ${maxSections}——不拆，按失败节处理。`)
    }
    const out = [...sections.slice(0, idx), ...subs, ...sections.slice(idx + 1)]
    if (new Set(out.map(m => m.id)).size !== out.length) {
      throw new Error('[split] 子节 id 与既有节 id 冲突。')
    }
    return out
  }

  /** 大纲落盘：manifest 写入 frontmatter content.sections（全 pending），正文不动。
   * fm 现读（逐节连续落盘时调用方的 stateMap 已过期）。 */
  async outlineApply(
    root: string, graph: Graph, node: string, yamlText: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<SectionManifest[]> {
    const manifest = Content.parseOutline(yamlText)
    const budget = outlineBudgetForNode(graph, node, manifest.length)
    if (budget.length) {
      const e: Error & { code?: string } = new Error(`[outline] 大纲护栏未过：\n${budget.map(f => `  ✗ ${f}`).join('\n')}`)
      e.code = 'OUTLINE_BUDGET'
      throw e
    }
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm, body } = await loadNote(path, this.fs)
    if (!fm || typeof fm.node !== 'string') throw new Error(`[outline] 课程文件不存在（先为节点生成内容骨架）: ${node}`)
    // 档位随大纲记录（预留接入点：弹性评估读 content.tier；不驱动调度）
    const tier = TIER_LABELS[nodeTierOf(graph, node)]
    // PS-I 顺序变体随大纲留痕（#81：只改生成顺序，调度/门禁不读它）
    const psi = graph.typeOf[node] !== 'practice' && nodeProblemFirstOf(graph, node)
    await saveNote(path, { ...fm, content: { ...((fm.content as Record<string, unknown>) ?? {}), sections: manifest, tier } }, body, this.fs)
    await journal({ course: '', node, rating: null, kind: 'content_outline', elapsed_days: 0, detail: `节清单 ${manifest.length} 节落盘（全 pending；档位 ${tier}${psi ? '；PS-I 先做后教' : ''}）` })
    return manifest
  }

  /** 拆节落盘（ADR-0054）：溢出的 pending 节原位替换为 2–3 个子节（模型 YAML），正文不动
   * （pending 节本就不进正文），journal 留痕。返回新插入的子节清单（管线据此逐子节生成）。 */
  async splitApply(
    root: string, graph: Graph, node: string, sectionId: string, yamlText: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<SectionManifest[]> {
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm, body } = await loadNote(path, this.fs)
    if (!fm || typeof fm.node !== 'string') throw new Error(`[split] 课程文件不存在: ${node}`)
    const sections = ((fm.content as { sections?: SectionManifest[] } | undefined)?.sections) ?? []
    const subs = Content.parseSplitOutline(yamlText, sectionId)
    let next: SectionManifest[]
    try {
      next = Content.applySplit(sections, sectionId, subs, MAX_SECTIONS)
    } catch (err) {
      const e: Error & { code?: string } = new Error(err instanceof Error ? err.message : String(err))
      e.code = 'SPLIT_FAILED'
      throw e
    }
    const parent = sections.find(m => m.id === sectionId)!
    await saveNote(path, { ...fm, content: { ...((fm.content as Record<string, unknown>) ?? {}), sections: next } }, body, this.fs)
    await journal({ course: '', node, rating: null, kind: 'content_split', elapsed_days: 0, detail: `节「${parent.title}」正文溢出，拆为 ${subs.map(s => `「${s.title}」`).join('、')}` })
    return subs
  }

  /** 单节落盘：交互件标记块先拆出落盘 → QC 格式类程序化修复（别名，#147）→ 节级质检门 →
   * 正文按清单手术重组 → 该节 status=ready/version+1、content.version+1（draft）；
   * hints = enc 候选反哺图的补边提醒，repairs = 程序化修复明细（留痕用）。
   * 门禁未过抛 code=GATE_FAILED 的错误（自动修复回路据此识别，其余错误原样传播）。 */
  async sectionApply(
    root: string, graph: Graph, node: string, sectionId: string, md: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<{ version: number; title: string; hints: string[]; repairs: string[] }> {
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    const { fm, body } = await loadNote(path, this.fs)
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
      await atomicWrite(target, f.html, this.fs)
    }
    // 提示词要求模型输出以 `## 标题` 开头，本方法按清单再包一层同名标题——先剥掉，避免正文标题重复
    const stripped = Content.stripLeadingSectionTitle(split.body, entry.title)
    // 格式类门禁程序化修复（#147）：别名不一致是机器可判可修的纯文字违规，先确定性
    // 替换再过门禁——门禁只拦机器修不了的违规；修复明细进 journal 与返回值留痕。
    const aliasFix = await this.fixAliases(root, stripped)
    const sectionMd = Content.fixRichBlocks(aliasFix.body)
    const gate = await this.gateReport(graph, root, node, `## ${entry.title}\n\n${sectionMd}`)
    const html = Content.checkInteractiveHtml(split.files)
    // 思维节专属门（P-8 #97）：预测门至少一处——「先预测再揭晓」的阅读流门是这一
    // 节类型的存在理由；块结构合法性已在 gateReport 全节检查。
    if (entry.type === '思维' && !Content.hasPredictBlock(sectionMd)) {
      gate.findings.push('「思维轨迹」节必须至少设一处 ```learnhub-predict 预测门（关键转折处先预测再揭晓；格式见上下文包 §11）')
    }
    if (gate.findings.length || html.findings.length) {
      // 结构化失败信息（ADR-0054）：sectionId/标题支撑续跑与定点重写，预算数字支撑
      // 修复轮的显式压缩目标；message 仍是人读事实源（含 ✗ 清单）。
      const budget = TIER_ANCHORS[nodeTierOf(graph, node)].sectionWordBudget
      const e: Error & { code?: string; sectionId?: string; sectionTitle?: string; wordBudget?: number; wordBlock?: number }
        = new Error(`[section] 「${entry.title}」质检门未过：\n${[...gate.findings, ...html.findings].map(x => `  ✗ ${x}`).join('\n')}\n${[...gate.warns, ...html.warns].map(w => `  ⚠ ${w}`).join('\n')}`)
      e.code = 'GATE_FAILED'
      e.sectionId = entry.id
      e.sectionTitle = entry.title
      e.wordBudget = budget
      e.wordBlock = sectionLengthThresholds(budget).block
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
        generated_at: todayStr(new Date(this.clock.nowMs())),
        status: 'draft',
        sections: nextSections,
      },
    }, newBody, this.fs)
    await journal({ course: '', node, rating: null, kind: 'content_section', elapsed_days: 0, detail: `节「${entry.title}」v${entry.version + 1} 落盘${aliasFix.fixed.length ? `（程序化修复：${aliasFix.fixed.join('、')}）` : ''}` })
    // 反哺候选取自落盘后的整篇正文（enc_candidates 机器块可能在其它节末尾），
    // 这样单节落盘后也能对全文候选给出 enc/set_pre 反哺提醒
    return { version, title: entry.title, hints: Content.encBackfeedHints(graph, node, newBody), repairs: aliasFix.fixed }
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
          ;Object.assign(fields, { [k]: v })
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

  /** 反哺候选的完整调用站点（ADR-0008 / #53 的数据源）：enc_candidates 机器块（整节 1 站）
   * + 练习级 `<!-- ex:N | uses:[...] -->`（每题 1 站）。返回 候选名 → 调用站数。 */
  static candidateCallSites(body: string): Map<string, number> {
    const sites = new Map<string, number>()
    for (const cand of new Set(Content.encCandidates(body))) sites.set(cand, (sites.get(cand) ?? 0) + 1)
    for (const ex of Content.practiceMeta(body)) {
      if (!ex.uses?.length) continue
      for (const u of new Set(ex.uses)) sites.set(u, (sites.get(u) ?? 0) + 1)
    }
    return sites
  }

  /** 祖先序比较（确定性的深度浅→深、名字断平）——概念清单排序与投影选教者共用
   * 同一 depth 口径（graph.depth：根=0 向下递增）。 */
  private static byDepthDesc(node: Graph, a: string, b: string): number {
    return (node.depth[a] ?? 0) - (node.depth[b] ?? 0) || a.localeCompare(b)
  }

  /** 概念清单（#148 出生打标候选集）：本节点 teaches ∪ pre 闭包内各节点 teaches 的
   * 概念名，去重保序（本节点在前、祖先按深度浅→深、同深按名字）。清单 = 题目 invokes
   * 的合法取值域：本节概念供卡点聚合，前置概念供 enc 投影；全部在册（teaches 过受理门）。
   * 空清单（节点与闭包都无 teaches，存量/手编图）= 出生打标门不激活，invokes 恒合法 Missing。 */
  static conceptScopeOf(graph: Graph, node: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (n: string): void => {
      for (const c of Object.keys(graph.teachesOf[n] ?? {})) {
        if (!seen.has(c)) { seen.add(c); out.push(c) }
      }
    }
    push(node)
    const anc = graph.names.filter(n => n !== node && graph.isAncestor(n, node))
      .sort((a, b) => Content.byDepthDesc(graph, a, b))
    for (const a of anc) push(a)
    return out
  }

  /** 概念清单提示词块（清单为空 → 空串，出生打标门不激活）。 */
  static conceptListBlock(scope: string[]): string {
    if (!scope.length) return ''
    return `\n\n## 概念清单（invokes 只能从这里选，名字精确照抄）\n\n${scope.map(c => `- ${c}`).join('\n')}`
  }

  /** 题目 invokes 覆盖率投影（#148，enc 权重新语义）：节点题目集按一枚 invokes 概念
   * 聚合，投影到 pre 闭包内教该概念的前置节点 → enc 边候选。w = 该前置被 invokes 的
   * 题数 / 带 invokes 的题数（覆盖率份额，两位小数；每题恰一枚 → 份额和 ≤1）。本节点
   * 自教的概念不投影（enc 指向前置组件，不是自身教学目标），但仍进分母（自教稀释前置
   * 覆盖）；概念无闭包内前置教 → 不投影（invokes 本身仍供卡点聚合）。零 invokes →
   * 零投影（合法空态，不造权重）。同概念多节点教 → 取闭包内**最近**的前置（depth
   * 最大 = 离本节点最近的教授者，螺旋图上即本节点实际踩着的那个版本；同深名字断平）。
   * 出生 w 随生长批经 set_enc 写入作回退初值；归档题不进分母。 */
  static invokesProjection(graph: Graph, node: string, questions: Array<{ invokes?: unknown; archived?: unknown }>): EncEdge[] {
    const invoked = questions.filter(q => !q.archived && invokesTagged(q))
    if (!invoked.length) return []
    const total = invoked.length
    const cntByConcept = new Map<string, number>()
    for (const q of invoked) {
      const c = (q.invokes as string).trim()
      cntByConcept.set(c, (cntByConcept.get(c) ?? 0) + 1)
    }
    // 概念 → 闭包内教它的最近前置（depth 最大；同深名字典序小者；教的节点与闭包没变时结果稳定）
    const holderOf = new Map<string, { node: string; depth: number }>()
    for (const c of cntByConcept.keys()) {
      let best: { node: string; depth: number } | null = null
      for (const m of graph.names) {
        if (m === node || !graph.isAncestor(m, node) || !(c in (graph.teachesOf[m] ?? {}))) continue
        const d = graph.depth[m] ?? 0
        if (!best || d > best.depth || (d === best.depth && m.localeCompare(best.node) < 0)) best = { node: m, depth: d }
      }
      if (best) holderOf.set(c, best)
    }
    const cntByHolder = new Map<string, number>()
    for (const [c, cnt] of cntByConcept) {
      const holder = holderOf.get(c)
      if (!holder) continue
      cntByHolder.set(holder.node, (cntByHolder.get(holder.node) ?? 0) + cnt)
    }
    return [...cntByHolder.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([holder, cnt]) => ({
        node: holder,
        w: round2(cnt / total),
        note: `invokes 投影 ${cnt}/${total}`,
      }))
  }

  /** 本节点反哺候选 → 可提升的 enc 边：候选名解析回图节点（graph.nset）、只接受在本节点
   * pre 传递闭包内（isAncestor，与 E7 一致）的候选。权重 = invokes 覆盖率投影（#148：
   * projByHolder 给出该前置的出生 w 时随带投影 note），无 invokes 数据的候选边落 schema 缺省
   * 权重 1——调用站阶梯已退役（#148），区分度告警归审计 R16。practice 型节点无候选块，
   * 保持 enc: [] 合法空态。 */
  static encPromotion(graph: Graph, node: string, body: string, projByHolder?: Map<string, { w: number; note?: string }>): EncEdge[] {
    const out: EncEdge[] = []
    for (const cand of [...Content.candidateCallSites(body).keys()].sort((a, b) => a.localeCompare(b))) {
      if (!graph.nset.has(cand) || cand === node || !graph.isAncestor(cand, node)) continue
      const proj = projByHolder?.get(cand)
      out.push({ node: cand, w: proj?.w ?? 1, ...(proj ? { note: proj.note } : {}) })
    }
    return out
  }

  /** enc 反哺 hints：把反哺候选的图依赖缺口在内容落盘时（修正时机最早）指出来——
   * 候选在图内但不在本节点 pre 闭包 → 建议 set_pre 补边；在闭包内但未声明为 enc →
   * 建议 set_enc 补边（都整体替换、保留既有边，ADR-0008）。权重不在此建议——出生 w
   * 由题目 invokes 覆盖率投影随生长批写入（#148）。候选不在图内 → 提示别名/拼写。
   * E7（audit）管已写入图的 enc 边；结构审计验不了语义真假，内容级背书见 encContentHints。 */
  static encBackfeedHints(graph: Graph, node: string, body: string): string[] {
    const out: string[] = []
    const declared = new Set((graph.encOf[node] ?? []).map(([t]) => t))
    const sites = Content.candidateCallSites(body)
    for (const cand of [...sites.keys()].sort((a, b) => a.localeCompare(b))) {
      if (!graph.nset.has(cand)) {
        out.push(`enc_candidates 引用「${cand}」不在图内（别名/拼写核对，或用 add_node/set_pre 补节点后再谈 enc）`)
      } else if (graph.isAncestor(cand, node)) {
        if (!declared.has(cand)) {
          out.push(`enc_candidates 引用「${cand}」在本节点 pre 闭包内但未声明为 enc——用 learnhub_graph_propose(kind=edit) 的 set_enc 补边（整体替换、保留既有 enc；出生权重由题目 invokes 覆盖率投影随生长批写入）`)
        }
      } else {
        out.push(`「${cand}」被 enc_candidates 引用但不在本节点 pre 闭包——确认依赖后用 learnhub_graph_propose(kind=edit) 的 set_pre 补边`)
      }
    }
    return out
  }

  /** 内容级 enc 背书（#53 审计强化，E6/E7 之外的另一层）：Ready 内容与已声明 enc 的
   * 对照检查——(a) 覆盖缺口：非 practice 节点有闭包内反哺候选但没落成 enc（warn R14）；
   * (b) 一致性：已声明 enc 与当前候选零交集或存在声明边不在候选中（warn/info R15）；
   * (c) 权重合理性：≥2 条 enc 全同权重无区分度（warn R16；越界已由 parse 挡）。 */
  static encContentHints(graph: Graph, node: string, body: string, hasReady: boolean): { warns: string[]; infos: string[] } {
    const warns: string[] = []
    const infos: string[] = []
    const declared = graph.encOf[node] ?? []
    const declaredNames = new Set(declared.map(([t]) => t))
    const region = graph.blockOf[node]?.[1] ?? ''
    const sites = Content.candidateCallSites(body)
    // (a) 覆盖缺口：只对已有 Ready 内容的节点背书；practice 节点合法空 enc 不报
    if (hasReady && graph.typeOf[node] !== 'practice' && sites.size) {
      const missing = [...sites.keys()].filter(c =>
        graph.nset.has(c) && c !== node && graph.isAncestor(c, node) && !declaredNames.has(c))
      if (missing.length) {
        warns.push(`R14 enc 覆盖缺口: [${region}] ${node}：反哺候选已引用但未落 enc — ${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 个` : ''}（set_enc 提升，见 ADR-0008）`)
      }
    }
    // (b) 一致性：候选可空——正文候选被删光时「声明边全不在候选」正是最极端的漂移
    if (hasReady && declared.length) {
      const stale = [...declaredNames].filter(n => !sites.has(n))
      const covered = [...declaredNames].filter(n => sites.has(n)).length
      if (sites.size && covered === 0) {
        warns.push(`R15 enc 与反哺候选不一致: [${region}] ${node}：已声明 enc（${[...declaredNames].join('、')}）与反哺候选（${[...sites.keys()].join('、')}）零交集——内容或候选漂移，核对后 set_enc 重建`)
      }
      if (stale.length) {
        infos.push(`R15 enc 边未见当前反哺候选: [${region}] ${node}：${stale.join('、')}${sites.size ? '' : '（正文当前无任何反哺候选——机器块被删或内容已重写？）'}${stale.length === declared.length ? '（全部声明边都不在当前候选）' : ''}`)
      }
    }
    // (c) 权重合理性：全部同权 = 调度路由无区分度（全 0 无路由价值、全 1 等于无权重）
    if (declared.length >= 2 && new Set(declared.map(([, w]) => w)).size === 1) {
      warns.push(`R16 enc 权重无区分度: [${region}] ${node}：${declared.length} 条边全为 w=${declared[0][1]}——按调用强度校准权重后再启用调度路由`)
    }
    return { warns, infos }
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
    const { body } = await loadNote(path, this.fs)
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
        generated_at: todayStr(new Date(this.clock.nowMs())),
        status: 'draft',
        // 节清单节点：整篇替换后 manifest 与正文重对齐（全部 ready、版本同步）
        ...(fm.content.sections ? { sections: Content.manifestFromBody(body, version) } : {}),
      },
    }
    const [, regionName] = graph.blockOf[node]
    const path = this.paths.courseNotePath(root, regionName, node)
    await saveNote(path, next as unknown as Record<string, unknown>, body, this.fs)
    await journal({ course: '', node, rating: null, kind: 'content_apply', elapsed_days: 0, detail: `正文 v${version} 落盘（status=draft）` })
    return version
  }

  /** 人审通过 → content.status=reviewed。 */
  async review(_root: string, _graph: Graph, node: string, fmOf: (n: string) => Fm | undefined, project: (node: string, fm: Fm) => Promise<void>): Promise<string> {
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
