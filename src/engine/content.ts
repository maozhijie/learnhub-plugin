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
import { endpointNames, readAnchors } from './seed.ts'
import { round2 } from './grading.ts'
import { CONFUSABLE_INJECT_CAP, capConfusablePairs, invokesTagged } from './concepts.ts'
import { withContractLast } from './prompt-assembly.ts'
import { TEMPLATES } from './prompts/templates.ts'
import { RENDERERS, PLAIN_CODE_LANGS, SECTION_TYPES, INTERACTIVE_TYPES, parseSectionTitle, rendererCapabilityBlock, predictBlockRe, parsePredictBlock } from '../../shared/content-renderers.ts'
import type { InteractiveType } from '../../shared/content-renderers.ts'
import type { GNode, SectionManifest, EncEdge } from './types.ts'
import type { Graph } from './graph.ts'
import type { Paths } from './paths.ts'
import type { Fm, JournalRec } from './types.ts'
import type { Logger } from './logger.ts'
import { noopLogger } from './logger.ts'

export const QUEUE_GENERATE = '生成'
export const QUEUE_REGEN = '重生成'

/** 可视化块围栏语言（单节合计受 SECTION_VISUAL_CAP 约束；interactive 为落盘后的引用块）。 */
const SECTION_VISUAL_LANGS: ReadonlySet<string> = new Set(['mermaid', 'svg', 'plot', 'chart', 'interactive'])

/** 上下文包 §5「禁止使用的概念」条数上限（#147 起的 200 条实测值，#218 复核保留为显式
 * 常量并配截断告知）。深度降序 → 截掉的是最靠前的浅层节点，留下的是最不该提前教的深层
 * 节点；上限本身是排版预算（200 条名 ≈ 1–2k 字），不是语义判据。 */
const FORBIDDEN_CONCEPT_CAP = 200

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
  /** 调试日志端口（#253 / ADR-0080；#290 附录登记接线）：节门降级（content.gate.*）
   * 与富块修复计数（content.repair.rich_blocks）由本类发。缺省 noop——仓库脚本
   * 与既有构造点零改动；宿主装配（index.ts）显式接引擎 logger。 */
  private logger: Logger
  constructor(paths: Paths, clock: Clock, fs: VaultFs, logger: Logger = noopLogger) {
    this.logger = logger
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

  /** T1/T2 触发：返回 (触发类型, 节点) 列表。终点不登记（#199 / ADR-0055+0056 生成门：
   * 终点是方向标记不被学习调度，零正文零题库——后继触发清单对终点恒跳过）。 */
  async onStageChange(
    root: string, graph: Graph, state: Record<string, Fm>, node: string, newStage: Fm['stage'],
  ): Promise<Array<['T1' | 'T2', string]>> {
    if (!['learning', 'review', 'mastered'].includes(newStage)) return []
    const endpoints = endpointNames(await readAnchors(this.paths.anchorPath(root), this.fs))
    const added: Array<['T1' | 'T2', string]> = []
    const done = new Set(Object.entries(state).filter(([, f]) => f.stage === 'review' || f.stage === 'mastered').map(([n]) => n))
    done.add(node)
    for (const x of graph.succ[node] ?? []) {
      if (endpoints.has(x)) continue
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

  /** 组装生成上下文包 → Markdown 文本。omitDeliverables：剥掉 §8 交付要求——大纲
   * 消费（逐节管线的 outline 站）不需要机器块/出题渠道指令，它们是节正文契约，混进
   * 大纲包会与大纲模板「只输出一个 YAML 文档」冲突：模型把 <!-- enc_candidates -->
   * 追加进大纲 YAML，解析即炸（生成任务注册表两连败的签名）。
   * endpoints：终点节点名集（#200 / ADR-0055 伪终点措辞废除；#239 多终点化）——
   * 「无后继即终点」的结构启发式改读锚：只有锚定的终点才获终点措辞，普通前沿叶子
   * 不再被误标。 */
  contextPack(graph: Graph, state: Record<string, Fm>, node: string, course?: string,
    opts?: { omitDeliverables?: boolean; endpoints?: ReadonlySet<string>; retiredConcepts?: ReadonlySet<string> }): string {
    const pres = graph.preOf[node]
    const succs = graph.succ[node] ?? []
    const enc = graph.encOf[node] ?? []
    const dSelf = graph.depth[node] ?? 0
    const isPractice = graph.typeOf[node] === 'practice'
    const out: string[] = []
    out.push(`# 生成上下文包：${node}`, '')
    out.push('## 1. 目标节点')
    out.push(`- 名称：${node} ｜ 深度：${dSelf}${isPractice ? ' ｜ 类型：交互实践（practice）' : ''}`)
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
    out.push(succs.length ? succs.join('、')
      : opts?.endpoints?.has(node) ? '（无后继——本节点是锚集合锚定的终点）' : '（无后继）')
    out.push('')
    out.push('## 4. 领域边界')
    const scope = `本课属于${course ? `课程「${course}」的` : ''}`
    out.push(`${scope}一个节点。只讲本节点范围内的内容；后继节点至多在自然收尾处一句话带过，不展开、不提前教；是否提及由你判断。`)
    // #218 复核抓出的实现 bug（登记为行为变更）：本行原为 `Object.keys(graph.nset)`——
    // nset 是 Set（graph.ts:305），`Object.keys` 对 Set 恒返回空数组，§5 因此**恒渲染
    // 「（无：本节点已是图内最深）」**：#212 §四.4 讨论的「禁止概念 ≤200 是稀释点」在
    // 真实 prompt 里根本不存在。修回 `[...graph.nset]` 后 §5 才真的列出未学节点。
    // 证据与后果见 ADR-0065 §6（含预期输出增量），回归门见 tests/output-contract.test.ts。
    const allForbidden = [...graph.nset]
      .filter(n => n !== node && n.length >= 2 && (graph.depth[n] ?? 0) > dSelf)
      .sort((a, b) => (graph.depth[b] ?? 0) - (graph.depth[a] ?? 0))
    // #218 稀释治理裁决：**位置保留**（§5 是 §4 领域边界的展开，挪走要把 §6–§13 全部
    // 重编号，而模板按号引用 §8/§9/§10/§11——重编号会改掉那些锚点，收益无实测支撑）；
    // **截断策略改为显式**：按深度降序（最深=最不该提前教）截 200 条，截断时如实告知，
    // 免得模型把清单读成穷举、以为没列出的名字就可以用。
    const forbidden = allForbidden.slice(0, FORBIDDEN_CONCEPT_CAP)
    out.push('')
    out.push('## 5. 禁止使用的概念（未学，不得出现、不得引用其结论）')
    out.push(forbidden.length ? forbidden.join('、') : '（无：本节点已是图内最深）')
    if (allForbidden.length > forbidden.length) {
      out.push(`（本清单按图深度降序截取前 ${FORBIDDEN_CONCEPT_CAP} 条，共 ${allForbidden.length} 条未学节点；**未列出的节点同样未学**，同样不得出现或引用其结论。）`)
    }
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
    if (!opts?.omitDeliverables) {
      out.push('## 8. 交付要求')
      if (isPractice) {
        out.push(Content.interactiveSpecBlock())
        out.push('- 末尾机器块：`<!-- enc_candidates: [] -->`（交互实践不出练习题）')
      } else {
        out.push('- 练习题以题组 YAML 经 learnhub_exercises_gen 写入（不再直接写进正文练习区）；数值题给 tol 容差')
        out.push('- 题型优先 single_choice / true_false / numeric（可机器判卷）；fill_in_blank 只考唯一写法的术语（数字与代数式不进填空，ADR-0029）；开放性问答题用 reflection 并在 answer 写评分要点')
        out.push('- 末尾机器块：`<!-- enc_candidates: [本课练习真实调用的前置技能（须在本节点 pre 闭包内；落盘后据此提升为 enc 边）] -->`')
      }
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
    // 废弃条目从生成注入面退出（#262 / ADR-0084）：两段注入的都是概念名，按 retiredConcepts
    // 剔除；剔除后为空则整段省略（不产空块）。
    const retired = opts?.retiredConcepts
    const mis = (graph.misconceptionsOf[node] ?? []).filter(m => !retired?.has(m.concept))
    if (mis.length) {
      out.push('')
      out.push('## 12. 误解坑位（生成期先验；讲到对应概念时预埋坑位警示）')
      out.push('- 下列是本节点登记在册的误解先验（概念：错误模型）。讲到对应概念处，把典型错误预埋为坑位警示（blockquote 误区块）：先呈现错法、再当场点破错在哪、怎么防；不展开成新主题。')
      out.push('- 这是生成期先验：真实学习者的错误以后由作答流水挖矿与申诉复核接管，有反馈区意见时以意见为准。')
      for (const m of mis) out.push(`- ${m.concept}：${m.model}`)
    }
    const assumes = Object.entries(graph.assumesOf[node] ?? {}).filter(([c]) => !retired?.has(c))
    if (assumes.length) {
      out.push('')
      out.push('## 13. 前置概念档位（assumes；写作时按档位把握「能默认学习者会什么」）')
      out.push('- 知道 = 学习者认识该概念（可提及作再认，不能默认会操作）；会用 = 能常规使用（可直接调用，必要时一句话回顾）；能教 = 已熟练（可作多步推理的默认起点，不必回顾）。前置不重教。')
      for (const [c, t] of assumes) out.push(`- ${c}：${t}`)
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

  /** 生成站提示词模板（单源在 `prompts/templates.ts`；#237 / ADR-0075 自本文件迁出）。键集与
   * 契约注册表 `OUTPUT_CONTRACTS`、登记表 `PROMPT_CHANGELOG` 三面对账（tests/output-contract.test.ts）。 */
  static readonly PROMPT_KINDS: Record<string, string> = TEMPLATES

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

  /** 契约后置拼装（#218）：宿主经门面走这里（R1：宿主只见门面，`src/host/jobs.ts` 是
   * 唯一消费者）；引擎内部直接引 prompt-assembly.ts 的叶子函数——叶子零依赖、谁都能引，
   * 不必绕类。切分函数不在这里露第二遍（只被叶子自用与门消费，露了就是无人调的中间人）。 */
  static withContractLast(tpl: string, materials: string): string {
    return withContractLast(tpl, materials)
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
   * 互异、answer ∈ options。任何节里出现该块都须合法（MdView 会渲染成阅读流门）。
   * finding 附期望形态（ADR-0079 说明增强：修得动的拦才有意义；前缀保 BLOCK_FINDING_RE
   * 的块号定位口径不变）。 */
  static checkPredictBlocks(body: string): string[] {
    const findings: string[] = []
    let i = 0
    for (const m of body.matchAll(predictBlockRe())) {
      i++
      const v = parsePredictBlock(m[1]!)
      if ('error' in v) findings.push('```learnhub-predict 第 ' + i + ' 块不合法：' + v.error
        + '；期望四行字段 q: <预测提问> / options: ["做法一", "做法二"]（2–4 项互异） / answer: <options 中一项的原文> / why: <可省>')
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
      const err = Content.plainJsonError(m[1])
      if (err) findings.push(`\`\`\`plot 第 ${i} 块不是合法 JSON 对象（面板会降级为源码显示）：解析报错「${err}」；期望一个 JSON 对象，如 {"title":"示例","series":[1,2,3]}`)
    }
    i = 0
    for (const m of body.matchAll(/^```chart[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm)) {
      i++
      const err = Content.plainJsonError(m[1])
      if (err) findings.push(`\`\`\`chart 第 ${i} 块不是合法 JSON 对象（面板会降级为源码显示）：解析报错「${err}」；期望一个 JSON 对象，如 {"label":"示例","values":[1,2,3]}`)
    }
    i = 0
    for (const m of body.matchAll(/^```svg[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm)) {
      i++
      if (!/^\s*<svg[\s>]/i.test(m[1])) {
        const head = m[1].trimStart().split('\n')[0]!.trim().slice(0, 40)
        findings.push(`\`\`\`svg 第 ${i} 块必须以 <svg 开头（完整 SVG 片段）：块首行是「${head}」`)
      }
    }
    return findings
  }

  /** 富内容块 JSON 校验：合法 JSON 对象返回 null，否则返回给修复轮看的解析报错
   * （ADR-0079 说明增强：给原始报错而非干巴巴的「不合法」，块级修补一次修对）。 */
  private static plainJsonError(text: string): string | null {
    const isObj = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
    try {
      return isObj(JSON.parse(text)) ? null : '解析成功但不是 JSON 对象'
    } catch (e1) {
      // fast 档模型高频失误是尾随逗号:仅当原始解析失败时清洗重试,不改语义。
      // 误报面仅剩「字符串字面量内含 `,}` 且恰好是唯一语法错误」,可接受。
      try {
        return isObj(JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'))) ? null : '解析成功但不是 JSON 对象'
      } catch {
        return e1 instanceof Error ? e1.message : String(e1)
      }
    }
  }

  /** 程序性修复后的富内容块改写结果（落盘前调用；不改语义，只修机器可判的脏输入）。 */
  static fixRichBlocks(body: string): string {
    return Content.fixRichBlocksReport(body).body
  }

  /** fixRichBlocks 的计数变体（#290 指针级观测）：返回改写结果 + 修复块数与涉及语言数
   * ——管线调用站据此发 `content.repair.rich_blocks`（细节目 journal，日志只记计数）。 */
  static fixRichBlocksReport(body: string): { body: string; blocks: number; langs: number } {
    let blocks = 0
    const langs = new Set<string>()
    // plot/chart：JSON 尾随逗号/行注释是 fast 档模型高频失误；面板解析失败会降级源码，
    // 单靠门禁容忍不够——落盘前把可解析的脏 JSON 改写为规范 JSON.stringify 产物。
    // 合法 JSON 原样保留（不重排，避免与模型产出逐字 diff）。
    body = body.replace(/^```(plot|chart)[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm, (whole, lang: string, code: string) => {
      // 严格 JSON.parse 成功 → 合法产出，原样保留（不重排，避免与模型产出逐字 diff）
      if (Content.strictJsonObject(code)) return whole
      const parsed = Content.parseLooseJsonObject(code) // 脏输入：尾随逗号/行注释
      if (!parsed) return whole // 仍不可解析:留给门禁 finding,回灌模型定向修复
      blocks++
      langs.add(lang)
      return `\`\`\`${lang}\n${JSON.stringify(parsed, null, 2)}\n\`\`\``
    })
    // svg：前导杂质裁剪至首个 <svg（门禁要求块以 <svg 开头）
    body = body.replace(/^```svg[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm, (whole, code: string) => {
      const idx = code.indexOf('<svg')
      if (idx <= 0) return whole
      blocks++
      langs.add('svg')
      return '```svg\n' + code.slice(idx) + '```'
    })
    // mermaid：节点文本含 | 等特殊字符且未整体双引号包裹时自动补引号（渲染降级的高频根因）
    body = body.replace(/^```mermaid[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?$/gm, (whole, code: string) => {
      const fixed = code.split('\n').map(line =>
        line.replace(/(\w[\w\u4e00-\u9fff]*)\[([^\]"\n]*\|[^\]"\n]*)\]/g, (_m, id: string, label: string) => `${id}["${label.replace(/"/g, '\\"')}"]`),
      ).join('\n')
      if (fixed === code) return whole
      blocks++
      langs.add('mermaid')
      return '```mermaid\n' + fixed + '```'
    })
    return { body, blocks, langs: langs.size }
  }

  /** 别名一致性程序化修复（#147 QC 格式类门禁程序化修复）：正文出现不采用名 →
   * 全部替换为采用名（别名词表是课程规范的纯文字映射，替换语义安全）；
   * 返回修复明细供 journal 留痕。写侧修复——contentCheck 只读校验不受影响。 */
  async fixAliases(root: string, body: string): Promise<{ body: string; fixed: string[]; table_size: number }> {
    const table = await this.aliasTable(root)
    let out = body
    const fixed: string[] = []
    for (const [bad, good] of Object.entries(table)) {
      if (out.includes(bad)) {
        out = out.split(bad).join(good)
        fixed.push(`${bad}→${good}`)
      }
    }
    return { body: out, fixed, table_size: Object.keys(table).length }
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
   * 不可执行，压到多少也从未直说）；拆节的出路归管线（大纲拆节），不劝模型拆。
   * #218 契约后置：材料块（模板外材料 + 上次输出 + 质检清单 + 压缩目标）全在前，模板的
   * 输出契约段仍经 withContractLast 置尾——修复轮里模型最后读到的依旧是「只输出本节
   * 正文」，质检清单是材料不是交付契约。 */
  static sectionRepairPrompt(
    tpl: string, materials: string, previousOutput: string, gateReport: string,
    opts?: { wordBudget?: number },
  ): string {
    return Content.withContractLast(tpl, `${materials.trimEnd()}\n\n${Content.sectionRepairBody(previousOutput, gateReport, opts)}`)
  }

  /** 整节修复轮的反馈块本体（findings 附定位 + 超长时的压缩目标）。单独露出是因为
   * 里程碑草案站的提示词包由门面方法整体拼装（调用方拿不到模板与材料两半），#218 下它
   * 直接用 `withContractLast(已拼装包, 本块)` 把反馈插在契约段之前——同一反馈形状，
   * 不再为它维护第二份实现。 */
  static sectionRepairBody(
    previousOutput: string, gateReport: string,
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
    return `${headline}\n\n上次输出：\n\n${previousOutput}\n\n质检清单：\n\n${locatedLines}\n${budgetBlock}`
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

  /** schema 形状错（大纲/拆节共用）：稳定码供宿主修复轮分流，消息原样人读。 */
  private static shapeErr(msg: string): Error & { code: string } {
    const e = new Error(msg) as Error & { code: string }
    e.code = 'OUTLINE_SHAPE'
    return e
  }

  /** 大纲 YAML → 节清单（id 唯一、type ∈ 节类型菜单、title 非空；全 pending）。
   * schema 形状错统一 code=OUTLINE_SHAPE——宿主大纲站的修复轮据此与基础设施错
   * （课程文件缺失）分流；onTolerated 接收解析边界的剥注释留痕（写 journal 用）。 */
  static parseOutline(yamlText: string, onTolerated?: (note: string) => void): SectionManifest[] {
    const doc = YAML.parseModel(yamlText, { onTolerated }) as { sections?: unknown } | null
    if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.sections) || !doc.sections.length) {
      throw Content.shapeErr('[outline] 模型没有产出可用大纲（sections 为空）。')
    }
    const out: SectionManifest[] = []
    const ids = new Set<string>()
    doc.sections.forEach((raw, i) => {
      const e = (raw ?? {}) as Record<string, unknown>
      const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `s${i + 1}`
      const title = String(e.title ?? '').trim()
      const type = String(e.type ?? '').trim() || parseSectionTitle(title).type.prefix
      if (!title) throw Content.shapeErr(`[outline] sections.${i + 1}.title 不能为空`)
      if (ids.has(id)) throw Content.shapeErr(`[outline] sections.${i + 1}.id「${id}」重复`)
      if (!SECTION_TYPES.some(t => t.prefix === type)) {
        throw Content.shapeErr(`[outline] sections.${i + 1}.type「${type}」不在节类型菜单（${SECTION_TYPES.map(t => t.prefix).join('/')}）`)
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
   * 模型的 id 字段一律忽略（引擎派生 `${parentId}-N` 防撞名），数量锁 2–3。
   * onTolerated 同 parseOutline（解析边界剥注释留痕，拆节站写 journal 用）。 */
  static parseSplitOutline(yamlText: string, parentId: string, onTolerated?: (note: string) => void): SectionManifest[] {
    const subs = Content.parseOutline(yamlText, onTolerated)
    if (subs.length < 2 || subs.length > 3) {
      throw Content.shapeErr(`[split] 拆节要求 2–3 个子节，模型给出 ${subs.length} 个。`)
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
   * fm 现读（逐节连续落盘时调用方的 stateMap 已过期）。
   * 返回 tolerated（#213）：解析容忍命中清单随返回值出引擎——宿主语料捕获据此把
   * 大纲站当次调用补标 tolerated（容忍样本必存语义，ADR-0060）。 */
  async outlineApply(
    root: string, graph: Graph, node: string, yamlText: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<{ sections: SectionManifest[]; tolerated: string[] }> {
    const tolerated: string[] = []
    const manifest = Content.parseOutline(yamlText, note => { tolerated.push(note) })
    const budget = outlineBudgetForNode(graph, node, manifest.length)
    if (budget.length) {
      const e: Error & { code?: string } = new Error(`[outline] 大纲护栏未过：\n${budget.map(f => `  ✗ ${f}`).join('\n')}`)
      e.code = 'OUTLINE_BUDGET'
      throw e
    }
    const path = this.paths.courseNotePath(root, node)
    const { fm, body } = await loadNote(path, this.fs)
    if (!fm || typeof fm.node !== 'string') throw new Error(`[outline] 课程文件不存在（先为节点生成内容骨架）: ${node}`)
    // 档位随大纲记录（预留接入点：弹性评估读 content.tier；不驱动调度）
    const tier = TIER_LABELS[nodeTierOf(graph, node)]
    // PS-I 顺序变体随大纲留痕（#81：只改生成顺序，调度/门禁不读它）
    const psi = graph.typeOf[node] !== 'practice' && nodeProblemFirstOf(graph, node)
    await saveNote(path, { ...fm, content: { ...((fm.content as Record<string, unknown>) ?? {}), sections: manifest, tier } }, body, this.fs)
    await journal({ course: '', node, rating: null, kind: 'content_outline', elapsed_days: 0, detail: `节清单 ${manifest.length} 节落盘（全 pending；档位 ${tier}${psi ? '；PS-I 先做后教' : ''}${tolerated.length ? `；${tolerated.join('；')}` : ''}）` })
    return { sections: manifest, tolerated }
  }

  /** 拆节落盘（ADR-0054）：溢出的 pending 节原位替换为 2–3 个子节（模型 YAML），正文不动
   * （pending 节本就不进正文），journal 留痕。返回新插入的子节清单（管线据此逐子节生成）
   * 与 tolerated（#213，同 outlineApply 的容忍补标通道）。 */
  async splitApply(
    root: string, graph: Graph, node: string, sectionId: string, yamlText: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<{ sections: SectionManifest[]; tolerated: string[] }> {
    const path = this.paths.courseNotePath(root, node)
    const { fm, body } = await loadNote(path, this.fs)
    if (!fm || typeof fm.node !== 'string') throw new Error(`[split] 课程文件不存在: ${node}`)
    const sections = ((fm.content as { sections?: SectionManifest[] } | undefined)?.sections) ?? []
    const tolerated: string[] = []
    const subs = Content.parseSplitOutline(yamlText, sectionId, note => { tolerated.push(note) })
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
    await journal({ course: '', node, rating: null, kind: 'content_split', elapsed_days: 0, detail: `节「${parent.title}」正文溢出，拆为 ${subs.map(s => `「${s.title}」`).join('、')}${tolerated.length ? `；${tolerated.join('；')}` : ''}` })
    return { sections: subs, tolerated }
  }

  /** 满编放行（ADR-0079）：节清单已到总上限时，「正文过长」的拒收没有修复阶梯可走
   * （不再付整节压缩修复的 deep 轮——满编即交付、人审兑底；拆节需新增节会越上限）
   * ——此时长度 finding 降为 warn 放行落盘，journal 与任务 message 留痕。findings 混入
   * 任何非长度项（契约类）时不降级——契约未兑现仍然拦。sectionCount < MAX_SECTIONS 时
   * 拆节阶梯仍有效，不动。 */
  static demoteCapLengthFindings(
    findings: readonly string[], warns: readonly string[], sectionCount: number,
  ): { findings: string[]; warns: string[]; lenient: string | null; over_by?: number } {
    if (sectionCount < MAX_SECTIONS || !findings.length || !findings.every(f => f.includes('正文过长'))) {
      return { findings: [...findings], warns: [...warns], lenient: null }
    }
    let overBy: number | undefined
    const demoted = findings.map(f => {
      const m = f.match(/节「(.+?)」正文过长（约 (\d+) 字 > 拒收线 (\d+) 字/)
      if (m) {
        overBy = (overBy ?? 0) + (Number(m[2]) - Number(m[3]))
        return `满编放行：节「${m[1]}」正文约 ${m[2]} 字超拒收线 ${m[3]} 字（节点已满编 ${MAX_SECTIONS} 节，拆节阶梯不可用；人工复核兑底）`
      }
      return `满编放行（节点已满编，长度 finding 降为警告；人工复核兑底）：${f}`
    })
    return { findings: [], warns: [...warns, ...demoted], lenient: demoted.join('；'), ...(overBy ? { over_by: overBy } : {}) }
  }

  /** 单节落盘：交互件标记块先拆出落盘 → QC 格式类程序化修复（别名，#147）→ 节级质检门 →
   * 正文按清单手术重组 → 该节 status=ready/version+1、content.version+1（draft）；
   * hints = enc 候选反哺图的补边提醒，repairs = 程序化修复明细、lenient = 满编放行摘要
   * （留痕用）。
   * 门禁未过抛 code=GATE_FAILED 的错误（自动修复回路据此识别，其余错误原样传播）。 */
  async sectionApply(
    root: string, graph: Graph, node: string, sectionId: string, md: string,
    journal: (rec: Omit<JournalRec, 'ts'>) => Promise<unknown>,
  ): Promise<{ version: number; title: string; hints: string[]; repairs: string[]; lenient?: string }> {
    const path = this.paths.courseNotePath(root, node)
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
    // 别名门失活（#290）：词表空（规范文件缺席或无 §8）= 门不生效——INFO 留痕，不静默
    if (aliasFix.table_size === 0) {
      this.logger.info('content.gate.alias_missing', { node, section: entry.id })
    }
    const rich = Content.fixRichBlocksReport(aliasFix.body)
    if (rich.blocks > 0) {
      this.logger.info('content.repair.rich_blocks', { node, blocks: rich.blocks, langs: rich.langs })
    }
    const sectionMd = rich.body
    const gate = await this.gateReport(graph, root, node, `## ${entry.title}\n\n${sectionMd}`)
    const html = Content.checkInteractiveHtml(split.files)
    // 思维节专属门（P-8 #97）：预测门至少一处——「先预测再揭晓」的阅读流门是这一
    // 节类型的存在理由；块结构合法性已在 gateReport 全节检查。
    if (entry.type === '思维' && !Content.hasPredictBlock(sectionMd)) {
      gate.findings.push('「思维轨迹」节必须至少设一处 ```learnhub-predict 预测门（关键转折处先预测再揭晓；格式见上下文包 §11）')
    }
    // 满编放行（ADR-0079）：只看 gate.findings；交互件契约 finding 在场时照常拦（混入
    // 契约类不降级）。lenient 非空 = 本节以 warn 放行落盘，摘要进 journal 与返回值。
    const cap = html.findings.length
      ? { findings: gate.findings, warns: gate.warns, lenient: null as string | null }
      : Content.demoteCapLengthFindings(gate.findings, gate.warns, sections.length)
    gate.findings = cap.findings
    gate.warns = cap.warns
    // 节门降级的引擎内视图（#290 / ADR-0091）：满编放行 WARN 留痕（journal 与返回值之外
    // 的第三只眼）；节门拒收 DEBUG 只记指针（错误清单已在 GATE_FAILED 续行）。
    if (cap.lenient) {
      this.logger.warn('content.gate.lenient', { node, section: entry.id, over_by: cap.over_by })
    }
    if (gate.findings.length || html.findings.length) {
      this.logger.debug('content.gate.section_reject', { section: entry.id, errors: gate.findings.length + html.findings.length })
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
    await journal({ course: '', node, rating: null, kind: 'content_section', elapsed_days: 0, detail: `节「${entry.title}」v${entry.version + 1} 落盘${aliasFix.fixed.length ? `（程序化修复：${aliasFix.fixed.join('、')}）` : ''}${cap.lenient ? `；${cap.lenient}` : ''}` })
    // 反哺候选取自落盘后的整篇正文（enc_candidates 机器块可能在其它节末尾），
    // 这样单节落盘后也能对全文候选给出 enc/set_pre 反哺提醒
    return { version, title: entry.title, hints: Content.encBackfeedHints(graph, node, newBody), repairs: aliasFix.fixed, ...(cap.lenient ? { lenient: cap.lenient } : {}) }
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
    // 祖先段单一出处 Graph.upstreamClosure（#270）：names 筛 isAncestor 的手写副本退役
    // （G10 门）。环图行为变更登记：旧实现 reach 空 → 祖先段恒空；现在恢复真实可达集
    // （ADR-0085 §实现登记 #270，环 fixture 钉在 enc-backfill-audit.test.ts）。
    const anc = [...graph.upstreamClosure(node)].filter(n => n !== node)
      .sort((a, b) => Content.byDepthDesc(graph, a, b))
    for (const a of anc) push(a)
    return out
  }

  /** 概念清单提示词块（清单为空 → 空串，出生打标门不激活）。 */
  static conceptListBlock(scope: string[]): string {
    if (!scope.length) return ''
    return `\n\n## 概念清单（invokes 只能从这里选，名字精确照抄）\n\n${scope.map(c => `- ${c}`).join('\n')}`
  }

  /** 易混对提示词块（#232）：登记表 confusable 候选对（confusablePairsOf 提取，与本节
   * 概念清单相交），出题提示词据此要求收尾槽位出跨概念对比题；无对 → 空串（指令
   * 静默降级，不报错不硬造）。
   * #264 注入上限 + 截断披露：超 CONFUSABLE_INJECT_CAP 条按**稳定序**截断（序 =
   * confusablePairsOf 的产出序，登记表文件序的纯函数——同输入恒同输出），并把「共几对、
   * 截掉几对、为什么」如实写在注入文本内（披露纪律：不静默丢——静默截断会让模型以为
   * 清单就是全部）。这是组装面文字，不是提示词常量 ⇒ 不触发 prompt-bump（#264 判据）。 */
  static confusablePairsBlock(pairs: Array<{ a: string; b: string }>): string {
    if (!pairs.length) return ''
    const { pairs: kept, total, truncated } = capConfusablePairs(pairs)
    const body = kept.map(p => `- ${p.a} ↔ ${p.b}`).join('\n')
    const disclosure = truncated
      ? `\n\n> 本清单已截断：登记表命中共 ${total} 对，按登记表稳定序只注入前 ${kept.length} 对（注入上限 ${CONFUSABLE_INJECT_CAP} 对——超过这个量级就没有优先级可言）。未列出的对不是不存在，是该先把易混对声明收敛下来。`
      : ''
    return `\n\n## 易混对（登记表在册，跨概念对比题候选）\n\n${body}${disclosure}`
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
    // 概念 → 闭包内教它的最近前置（depth 最大；同深名字典序小者；教的节点与闭包没变时
    // 结果稳定）。候选集单一出处 Graph.taughtByOf（#270 反向映射）：names 全扫退役——
    // 旧 m===node 与 teachesOf[m] 检查由候选集性质吸收（isAncestor 自身恒 false）。
    // 环上 depth 作废（全 0）→「最近」退化为名字序——已知退化，环 fixture 钉住
    // （ADR-0085 §实现登记 #270）。
    const holderOf = new Map<string, { node: string; depth: number }>()
    for (const c of cntByConcept.keys()) {
      let best: { node: string; depth: number } | null = null
      for (const m of graph.taughtByOf[c] ?? []) {
        if (!graph.isAncestor(m, node)) continue
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
    const sites = Content.candidateCallSites(body)
    // (a) 覆盖缺口：只对已有 Ready 内容的节点背书；practice 节点合法空 enc 不报
    if (hasReady && graph.typeOf[node] !== 'practice' && sites.size) {
      const missing = [...sites.keys()].filter(c =>
        graph.nset.has(c) && c !== node && graph.isAncestor(c, node) && !declaredNames.has(c))
      if (missing.length) {
        warns.push(`R14 enc 覆盖缺口: ${node}：反哺候选已引用但未落 enc — ${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 个` : ''}（set_enc 提升，见 ADR-0008）`)
      }
    }
    // (b) 一致性：候选可空——正文候选被删光时「声明边全不在候选」正是最极端的漂移
    if (hasReady && declared.length) {
      const stale = [...declaredNames].filter(n => !sites.has(n))
      const covered = [...declaredNames].filter(n => sites.has(n)).length
      if (sites.size && covered === 0) {
        warns.push(`R15 enc 与反哺候选不一致: ${node}：已声明 enc（${[...declaredNames].join('、')}）与反哺候选（${[...sites.keys()].join('、')}）零交集——内容或候选漂移，核对后 set_enc 重建`)
      }
      if (stale.length) {
        infos.push(`R15 enc 边未见当前反哺候选: ${node}：${stale.join('、')}${sites.size ? '' : '（正文当前无任何反哺候选——机器块被删或内容已重写？）'}${stale.length === declared.length ? '（全部声明边都不在当前候选）' : ''}`)
      }
    }
    // (c) 权重合理性：全部同权 = 调度路由无区分度（全 0 无路由价值、全 1 等于无权重）
    if (declared.length >= 2 && new Set(declared.map(([, w]) => w)).size === 1) {
      warns.push(`R16 enc 权重无区分度: ${node}：${declared.length} 条边全为 w=${declared[0][1]}——按调用强度校准权重后再启用调度路由`)
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
    const path = this.paths.courseNotePath(root, node)
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
    const path = this.paths.courseNotePath(root, node)
    await saveNote(path, next as unknown as Record<string, unknown>, body, this.fs)
    await journal({ course: '', node, rating: null, kind: 'content_apply', elapsed_days: 0, detail: `正文 v${version} 落盘（status=draft）` })
    return version
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
export type { GNode }
