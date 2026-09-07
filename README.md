# dsh-learnhub

学习中心 Learnhub：DeepSeek Harness 的学习引擎插件（v3 纯 TS 引擎 + allo 移植面板）。

Python 引擎已退役：原 `spawn python -m learnhub` 的全部逻辑吸收进
`src/engine/`（TS），同进程直调，不再有子进程与 CLI 逃生口。
评分模型是**题目级 FSRS 刷卡**：每道题自带一张调度卡，作答对错直接推进该题；
节点掌握度 = 其题目作答数据的汇总（派生，无自评）。
事实源依旧在 Obsidian Vault，调度仍是 ts-fsrs 日粒度。
XP 是**时间账本**（1 XP ≈ 1 分钟有效专注）：节点定价 = 内容标称 est × FSRS 难度
客观校准 k，完成时 settle 对账锁定；课程不变则总账有序稳定（见「XP 预算制」）。

- **host**（`lib/index.js`）：16 个 agent 工具直调 engine、`/learnhub/api/*` 面板后端、`/learnhub` SPA 伺服（`web/dist/`，改 UI 重跑 build 即生效）
- **client**（`lib/client.js`）：侧边栏底栏「学习中心」入口（新标签页打开 `/learnhub`，命名窗口复用）+ `learnhub:discuss` 宿主桥（学习中心 tab 经 `window.opener` 请求宿主开 dsh 会话）
- **引擎**（`lib/engine.js`）：独立构建产物，脚本（smoke/e2e/dev-server）与 UI 复用同一入口
- **面板 UI**（`ui/`）：Vite + React 18 + Arco Design + React Flow（@xyflow/react + dagre），组件移植自 allo learning 模块

开发环境注意：`@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` 是宿主私有 peer（未发布
公共 npm），`npm install` 的 prepare 钩子会把它们从 dsh monorepo（默认
`C:/Users/test/Desktop/deepseek-harness/packages`，可用 `DSH_MONOREPO` 覆盖）junction 进本仓库
`node_modules`——插件以 `link:` 装入 dsh profile，Node 按 realpath 解析 peer，缺了会报
`Cannot find package '@deepseek-ai/dsh-llm'`。

## 数据主权（v3）

vault `学习中心/` 是唯一事实源，没有数据库：

| 数据 | 位置 | 说明 |
|---|---|---|
| 题目级调度 | `<课程根>/题库/<节点>.yaml` | **每题一张 FSRS 卡**（`fsrs` 块：due/stability/difficulty/reps/lapses）+ 作答统计（`stats.attempts/correct/last`）；作答对错驱动推进 |
| 节点状态 | 课程笔记 frontmatter | `stage`（unseen/ready/learning/review/mastered/skipped）+ `mastery` + `practice` 计数/EMA；`fsrs` 字段是节点题目的聚合代表（到期最早那张卡的快照，审计与兼容用） |
| 图结构 | `<课程根>/data/*.yaml` | region/block/nodes{name,pre,opt,note,enc,est?,type?,bloom?,difficulty?}，人类可读可手编；`est` 为标称学习时长（分钟，XP 内容定价）、`type: practice` 为实践节点（交互模拟交付，不出练习题）、`bloom`（记忆/理解/应用/分析/评价/创造）与 `difficulty`（1-5）为可选认知维度（R11 难度跳跃门禁消费，渐进采纳） |
| 题库 | `<课程根>/题库/<节点>.yaml` | 题型 single_choice / true_false / fill_in_blank / multi_choice（字母数组）/ numeric（`tol` 容差）/ ordering / matching / reflection / open_question（AI 批改）+ 候选答案 + 解析 + `archived` |
| 流水 | `state/journal.jsonl`、`state/practice.jsonl` | 调度留痕与作答记录（审计用），逐行追加；journal 含 `xp_settle` 对账行与 XP 过程信号 |
| 生成任务/提示词 | `state/生成任务.json`、`state/提示词/*.md` | 生成任务注册表落盘（进程重启后 running→failed 可重试）；提示词模板版本化（内置 v5 首用落盘、可手编，内置升级自动覆盖旧快照并存 `.bak`） |
| 提案/快照 | `state/proposals.json`、`state/snapshots/*.json` | 图谱变更提案与 apply 前快照 |
| 日志 | `state/学习日志.md`、`state/运行日志.md` | 生成/审计等运行流水 |

纪律：**D14** 一切数据访问收口 `engine/` 模块，工具/路由/UI 不得绕过；
**D15** 评分即作答——判卷后直接推进该题 FSRS 并写回题库（无工作单中间层）；
XP 例外：完成节点时有一次 `xp_settle` 对账（见「XP 预算制」），属于账本层不碰调度；
`config.vault` 缺失/目录不存在加载即报错（fail loud，不做静默兜底）。

## 工具面（16 个）

- 调度与学习：`learnhub_status / recommend / lesson / rebuild / feedback / note_resolve`
- 节点操作：`learnhub_skip`（跳过/取消跳过，已有基础的节点）、`learnhub_complete`（完成确认，未答题入复习循环）
- 图谱五面 + 逐步探索：`learnhub_graph_analyze / propose / proposals / apply`（analyze 返回图谱健康分 0-100、下一批建议 expand_blocks/missing_pre/unconverged 与每节点 schema 字段值 pre/enc/est/bloom/difficulty/note——边级自查的数据依据，建议条目上限随图规模伸缩；proposals 列 pending/历史提案；apply 返回 findings = audit warns 摘要 + 健康分不足提醒；edit ops 含 set_enc 成分技能边整体替换，add_node 支持可选 est/type/bloom/difficulty/enc，gen 与 edit 两路一致）；探索三件套 `learnhub_graph_node`（单节点详情+前置传递闭包）/ `learnhub_graph_browse`（区/块过滤浏览）/ `learnhub_graph_path`（from 是否 to 的前置 + BFS 最短链）——不拉全图逐步查细节
- 图谱质量机制：健康分 5 项（动作句命名/est 覆盖/前置完备/收敛度/结构卫生）进审计基线表；审计新增 R11 难度跳跃（相邻 pre 边 |Δdifficulty|≥2 → warn）与 R12 认知-时长失配（info）；`learnhub-graph-generate` 技能规定结束条件为「audit 无 ERROR 且健康分 ≥ 80」+ 每批边级自查表 + 每累计约 50 ops 委派 `subagent_graph_prosecutor` 对抗审查；数量限定按图规模伸缩（批次 ≤25、大图放宽 ≤40；健康分别名命中按节点数归一；R1 浅叶阈值随最大深度相对化；审计条目超 15 附溢出行）——数百节点的课程属正常范围；正文落盘时 enc_candidates 引用非祖先节点 → 返回值附 hints 提醒补边（内容反哺图）
- 题库（刷卡作答流）：`learnhub_question_list / question_save / question_answer`，`learnhub_question_generate`（模型出题管线，与自动出题同门禁）、`learnhub_question_get`（单题全量含答案，修订用——list 不带答案防作答流泄题）、`learnhub_question_update`（patch 合并重新校验，`{archived:true}` 隐藏题）
- 生成：`learnhub_generate`（大纲 → 逐节正文 → 自动出题三段管线，断点续跑；缺笔记先补骨架，on-demand 课时语义；可选 `style` 节级风格变体作用于每节生成）、`learnhub_course_reset`（整课重置后台重跑，HTTP 与工具同通道）与 `learnhub_course_delete`（删课移入 .trash，可手工恢复）
- 质检：`learnhub_content_check`（对现有课程笔记跑质检门——超纲引用/别名一致性/未注册代码块语言/interactive 引用文件存在；agent 手改正文后必须跑一遍并修掉全部 findings）

## 面板（Vite SPA，移植自 allo learning）

`/learnhub/` 六个页签，信息架构以「学习流为主、图为总览」，明暗双主题（arco-theme 跟随系统，可手动切换）：

- **学习**（主界面）：复习横幅（待复习数 + 开始复习）+ **「接下来」推荐流**（逾期/复习/就绪/新学大卡片，复习项来自题库聚合 due，点开直接进入节点学习视图）+ 课程卡（进度/六态计数/删除，收窄为次要区）+ 复习会话（刷卡流：只刷到期题与未做题，答对 rating3、答错 rating1，无题提示出题或完成）
- **节点学习视图（LessonView）**：学习页二级全屏视图，最大最丰富的学习容器——状态引导单按钮（无正文→「生成正文（自动出题）」；有正文无题→「AI 出题」；有题→直接练习）+ 顶部节进度 stepper（MathAcademy 式细条分段，节序列驱动：内容节 = 读 + 本节练习并入一个步骤、`练习` 节 = 一等练习轮、`交互` 节 = 交互模拟轮；已过关蓝条可点回跳，当前高亮，节名在 tooltip）+ 正文分节 Markdown 渲染（GFM 表格 / mermaid 图 / svg 示意图 / plot 函数图 / chart 数据图表 / Obsidian 图片嵌入 / interactive 交互件；每节标题旁「重写」让 AI 单节重生成过门落盘）+ 练习区（题目 FSRS 到期排序 + 九种题型 QuestionCard）+ 掌握度（题目作答汇总）+「完成学习」与「跳过」按钮（完成按钮在练习区下方，做完题再确认）+ 生成中阶段/进度/耗时/取消（`/generate/status` 附 `contentVersion`，正文版本变化才整页刷新）+「在图中查看」低频跳转 + 右下角「问 AI 老师」抽屉（节点范围即时答疑）+「与 AI 讨论本课」（把节点上下文注入新建 dsh 会话，深度讨论/修订）
- **学习图**（全局总览，低频操作）：React Flow + dagre BT 分层 DAG——六态色板节点卡（skipped 紫色「跳」角标、practice 节点「练」角标）、推荐星标（琥珀入边引导）、前置未完成锁定虚线（skipped 视同已通过）、MiniMap、>300 节点视口裁剪；区过滤 / 节点名搜索 / 只看进行中开关；点节点进入学习视图；「在图中查看」跳入时红描边定位并居中
- **题目管理**：全库浏览/筛选/搜索、编辑（答案留空不改）、自建题（过 validateBank 门禁）、归档/恢复
- **统计**：课程六态总览（未学=unseen+ready、进行、复习、掌握、已跳过）+ XP / 每日目标 / streak / ETA（预算制推导，随作答证据越学越准）
- **生成**：正文生成任务注册表（运行中/取消/终态，落盘 `state/生成任务.json`，页面刷新可恢复，服务端为事实源；失败与部分完成保留 24h + 完整错误与重试 +「与 AI 讨论」直通 dsh 会话）+ 进度列（mini 进度条 + `done/total · 当前节`，outline/sections/quiz 阶段实时上报）+「生成正文」旁风格 Select（`/prompts` 列可用变体）

### 生成与出题管线

「生成正文」= **大纲 → 逐节正文 → 自动出题** 三段管线（生成任务带 `outline/sections/quiz` 阶段与 `done/total · 当前节` 进度，逐节实时上报）：

1. **大纲**：上下文包 + 「课程大纲」提示词 → llm 产节清单 YAML（id/title/type/points/visual；类型菜单：概念/例题/演示/小结/练习/交互；节数、顺序与类型配比由模型按内容、主题与讲解风格自行判断——支持连续概念节后集中练习、概念-演示穿插等组合模式，不套固定栏目；练习节可选）→ 校验后落 frontmatter `content.sections`（全 pending，节进度事实源，points 随清单落盘，作为后续生成的前置骨架数据源，`GET /lesson` 附 manifest）。内容配比：可视化为主、文字为辅——讲解本体放在公式/图/交互件里，每节文字 ≤150 字；上下文包前置摘要注入前置节点实际教过的节标题+要点，配合提示词硬规则治理超纲。
2. **逐节正文**：每节一次模型调用（「课程节生成」提示词 + 节任务 + 前节已生成正文保连贯 + 上下文包）→ 质检门 apply 单节落盘，门禁未过把带定位的清单回灌模型自动修复一轮（仅一轮，修复轮仍失败才报错）；已有 ready 节（断点续跑）沿用既有清单，只补未生成节。思考档分层：节正文初跑恒快速档（`fastEffort`，默认 off——文字量小、模板约束强，无需推理）；高复杂度节点（difficulty≥4 或深节点，见 CONTEXT.md Complexity Tier）的大纲与修复轮升 `deepEffort`（默认 low）；出题/批改/答疑保留默认思考。
3. **自动出题**：每内容节 1–2 道绑节 id（自适应：大纲含练习节 1 道、否则 2 道——支持「连续内容节→集中练习」编排；「题目生成」提示词 + 节标注清单，`section` 服务端强制为节 id，练习/交互节与未生成节跳过）+ 3 道综合（section=通用）→ validateBank 门禁逐题落盘，九种题型混合、难度递进；出题失败不回滚正文，任务终态为 `partial` 并保留失败信息，可在练习页单独重试（POST `/question-generate`）。

节类型决定学习流装配（LessonView stepper）：内容节 = 读 + 本节练习并入一个步骤（无题内容节即纯阅读步）；`练习` 节 = 一等练习轮（无题不出轮）；`交互` 节 = 交互模拟轮，完成后成绩结算。单节重写：`POST /generate/section`（LessonView 节标题旁「重写」入口）与管线共用同一拼装、门禁与修复回路。**重新生成整课**：`POST /course/reset`（入口两处：学习页课程卡「重新生成」、生成页「重新生成整课」，确认弹窗同语义）——全部节点笔记备份进 `.trash/regenerate-<时间戳>/` 后重写为未生成骨架，`题库/`、`交互/`、`课程图/` 三个生成产物目录一并移入同一备份；课程图谱、学习进度、提示词快照、生成队列.md 保留；随后按图拓扑序串行重跑生成管线（后台执行，进度看任务注册表；运行中有任务时拒绝）。

可选 `style` 节级风格变体（`课程节生成-苏格拉底`/`课程节生成-费曼`）：只替换逐节正文的节生成模板（引导提问+锚点 / 类比→朴素→正式），大纲、断点续跑与门禁与默认管线同一路径；自建风格在 `state/提示词/` 放 `课程节生成-<风格>.md` 即可。旧整课版「课程生成*」模板已随大纲→逐节管线退役（存量快照文件不再被读取，可手工清理）。提示词五个内置模板（大纲/节生成 + 两个风格变体/题目生成）版本化落盘 `state/提示词/`（首行 `learnhub:prompt/vN` 标记；内置升级自动覆盖旧快照、旧文件存 `.bak` 供 diff 恢复），可手编；`GET /learnhub/api/prompts` 列可用；未知 style 在生成开头 fail loud（不浪费大纲调用）。LLM 失败带稳定错误码（如 `[MISSING_CREDENTIAL/401]`）写运行日志。

### 正文渲染格式（面板支持的块格式清单）

格式清单事实源在 `shared/content-renderers.ts`（RENDERERS），一项同时驱动生成提示词能力段、质检门白名单与面板注册表：

- **公式**：KaTeX（remark-math 链，含 mhchem 化学宏），行内 `$…$`、独立 `$$…$$`
- **mermaid**：流程/时序/状态图（主题跟随、失败降级源码）
- **```svg 示意图**：模型手写精确 SVG（几何/向量/结构图，可内联 SMIL 动画），DOMPurify 白名单清洗后内联渲染
- **```plot 函数图**：模型产出数学对象 JSON spec（fn/parametric/point/vector/segment/circle/polygon/label），mathjs 求值 + Mafs 坐标系绘制——模型只给数学对象，不写像素
- **```chart 数据图表**：标准 ECharts option（series 限 line/bar/pie/scatter，禁外部 URL），echarts/core 按需注册渲染
- **图片/音视频**：`![[xx.png]]` 嵌入与 ```media 块（gif/mp4 等预渲染动画直接播）

`plot`/`chart`/`svg` 非法块在质检门（apply 时）即拒：JSON 不可解析或非 `<svg` 开头都是 finding，防止 AI 产出渲染不了的块进正文；围栏行尾随空白不参与匹配（合法块不会因 ``` 后的空格被误判，非法块也不会漏检）。

### 交互件（v2 契约）

正文里的交互件用标记块交付（契约吸收 OpenMAIC 五类交互场景模板经验）：

````markdown
```learnhub-interactive:交互/单摆.html
<!doctype html><html>…完整自包含 HTML…</html>
```
````

apply 时拆出 HTML 落盘 `<课程根>/交互/单摆.html`，正文替换为 ```` ```interactive ```` 引用块（学习中心相对路径）；质检门校验引用文件存在。交互件伺服同时接受学习中心相对（`<课程根>/…`）与 vault 相对（`学习中心/<课程根>/…`）两种引用形态（路由归一后校验）。交互件硬性要求（生成提示词全文约束）：

- **widget-config 必填**：`<script type="application/json" id="widget-config">` 内嵌 `{type, description, variables, presets}`；`type` 必须是类型菜单之一：`simulation`（过程仿真，≥2 滑杆 + ≥2 预设）/ `visualization3d`（vendored three + importmap，光照/缩放按钮/WebGL 降级）/ `diagram`（可操作图解）/ `game`（知识小游戏，计分绑 score）/ `code`（纯 JS 在线编程，Web Worker 执行防死循环）；缺 config 降级为警告（存量 v1 不返工），类型未知是 finding
- **完成上报**：结尾 `postMessage({type:'LEARNHUB_COMPLETE', score?, detail?}, '*')`——`score` ∈ [0,1] 时面板经 `POST /interactive/settle` 记入练习档案（同节同日一次防刷；EMA 推进节点 frontmatter 掌握度，不碰题目 FSRS，节点掌握度仍是题库作答正确率；自由阅读态无结算上下文，只亮「交互已完成」徽标）
- **AI 老师操作接口**：widget 侧监听 `LEARNHUB_TEACHER` 广播（highlight/setState/reveal/annotate 四 action，selector 用 CSS 选择器、case 用块作用域）；「问 AI 老师」抽屉把老师答案里的 ```` ```learnhub-teacher ```` JSON 块转成演示按钮，经 WidgetBus 广播驱动本页全部交互件
- **自包含单文件**：内联 CSS/JS、禁外部网络与 CDN——库供给走 host 同源伺服：CSP 放开 `'self'`（`connect-src` 仍由 `default-src 'none'` 封死），`/learnhub/api/vendor/` 伺服 vendored katex 与 three（build 时从面板 node_modules 复制进 `web/vendor/`）；公式直接写 `$…$`/`$$…$$`，伺服端检测到定界符自动注入 KaTeX 渲染（存量交互件免重生成即生效）；`img-src 'self'` 同时解锁经 /file 路由引用 vault 图片
- **体验底线**：running/paused/ended 状态机与 reset 完整复位、移动端不重叠 + 44px 触控、requestAnimationFrame 且动画肉眼可见、实时数据带单位、ARIA 标签

`type: practice` 实践节点：图节点加 `type: practice` 后，生成提示词切换为「交互模拟 + 简短说明、不出练习题」，学习视图完成语义走无题路径，交互完成事件作 UI 引导。

### 会话化与答疑（面板 ↔ dsh 会话分层）

- **生成任务 durable**：genJobs 每次状态变更原子落盘 `state/生成任务.json`；进程重启读入，遗留 running/cancelling 标 `failed`（「进程重启中断，可重试」），终态 `partial` 原样恢复。
- **问 AI 老师**（面板内即时答疑）：`POST /learnhub/api/tutor`，body 携带本节点正文 + 题库摘要 + 掌握度的 system 与完整对话历史；只答不写，历史由前端持久。
- **与 AI 讨论本课**（深度讨论/修订）：学习中心 tab 经 `window.opener` 发 `learnhub:discuss` → host 给出 `GET /learnhub/api/discuss-pack`（节点正文 + 题库摘要 + 掌握度 + 图位置）→ client 用 `sessions.create/open` 开新 dsh 会话并把上下文与用户意图作为首条 prompt 注入 → 应用窗口切回前台，学习中心 tab 保持打开（不打断学习进度；iframe 宿主形态下发 `parent`，行为等价）。agent 侧 SOP 见 `skills/learnhub-build`（何时直接回答、何时用 `learnhub_*` 工具、何时编辑课程笔记、图变更必须走 propose 人审）。

### 评分模型（题目即刷卡卡）

作答判卷后按对错映射 FSRS rating（对=3、错=1）推进**该题**的调度卡并写回题库；
同节点多题各自独立推进，互不干扰；**每题每天至多推进一次调度**——同日重复作答
（「再做一次」）只记练习统计，不再碰调度卡。**乱猜作答（耗时 < 5s 且答错）同样不碰卡**
（含首答）——难度证据只由认真作答驱动。节点 due = 其题目 due 的最小值，复习队列读
题库聚合（无题节点不进复习队列）。「完成学习」把全部未归档题纳入复习循环——
做过的按各自下次到期复习，没做过的初始化为明天起刷；节点 stage→review。
九种题型判卷：选择题字母集合相等（多选顺序无关）、true_false 布尔、填空候选归一/数值容差
（`tol`，兼容分数与百分数）、排序/配对逐项归一（排序顺序敏感）、reflection 与 open_question
走 AI（开放题 10 分制，≥6 及格，feedback 必含逐点批改 + 具体改进建议）。

### XP 预算制（est 内容定价 × FSRS 难度客观校准）

**不变量**：节点 XP 预算 = N₀ × k，是课程内容与客观难度证据的确定函数——与作答路径
（顺序、重复、乱猜）无关；完成后定价锁定，总账 = Σ已完成节点 N₀×k，课程图不变时总量有序稳定。

- **标称预算 N₀**（分钟）：节点 `est`（图 YAML 可手编、图生成提示词要求产出）优先；
  缺省回落 Σ题(题型权重 × 难度)（`XP_BASE`：single/true_false 1、fill/multi/numeric/ordering/matching 2、reflection/open 3）；
  再缺省 `XP_PER_NODE_DEFAULT`（12）。
- **难度校准因子 k**（客观、零人工干预）：k = Σ题(w_q × d̂_q) ÷ Σ题(w_q)，
  其中 d̂_q = `fsrs.difficulty / 5`（ts-fsrs difficulty ∈ [1,10]，中性 5 → 因子 1），
  无作答记录的题取 1；clamp 到 [0.5, 3]。乱猜不推进 FSRS，故乱猜不能推高节点定价。
- **结算**：作答即时入账过程信号（答对 +w×d、答错 0、乱猜 −1、同日重复 0）；
  `nodeComplete` 时以完成时刻的 N = N₀×k 对账，Δ = N − 过程净 XP 写 journal
  `{kind:'xp_settle'}`；**完成后该节点定价锁定**（重复完成 Δ=0，幂等）。
- **ETA**：剩余工作量 = Σ未完成节点当前 N₀×k（unseen+ready+learning；skipped 视同完成），
  `eta.days = ceil(剩余预算 ÷ 每日目标)`——随作答证据积累自动校准，越学越准。

## 安装

```sh
git clone https://github.com/maozhijie/learnhub-plugin.git
npm install
npm run build
dsh plugin --profile web add "link:/absolute/path/to/learnhub-plugin"
```

bundle 已注册进 profile 的 `dsh.profile.bundles`；`time-context` 与 `schedule` 两行随 bundle patch 一起插入。

## 机器级配置（跨机器的关键）

仓库内不含任何机器路径。每台机器在自己的 profile patch
（`~/.dsh/profiles/web/cordis.patch.yml`）按 id 覆盖行 config：

```yaml
- id: dsh-learnhub
  config:
    vault: /absolute/path/to/vault          # 必填：vault 根目录
    # centerRel: 学习中心                  # 缺省即可
    provider: deepseek-official
    model: deepseek-v4-flash
    # fastEffort: off                     # 大纲/节正文初跑的思考档 off|low（默认 off；路由不支持时自动降级为部署默认）
    # deepEffort: low                      # 高复杂度节点（难度≥4/深节点）的大纲/修复轮思考档 off|low（默认 low；P4 分层 effort）
```

## 构建

```sh
npm install
npm run build     # ui(vite→web/dist) + vendor(katex/three→web/vendor) + lib 三产物 + 技能同步
npm run check
```

`npm run build` 先构建面板 SPA（`ui/` → `web/dist/`，node_modules 缺失自动补 install）并复制交互件 vendored 库（katex/three → `web/vendor/`），
再出 lib 三产物，最后把 `skills/*` 真实复制到 `<dshHome>/skills/`
（skill-filesystem 的内置扫描根，`DSH_HOME` 环境变量可覆盖 home），
技能随构建安装、对所有 dsh 会话可见；改技能后重跑 build 即生效。
`lib/`、`web/`（dist + vendor）均为构建中间结果，不入 git（`.gitignore` 忽略）；
克隆后先 `npm install && npm run build` 再使用；修改 `src/` 或 `ui/` 后重新 build 即生效。

## 部署更新（拉取新代码后）

宿主经 profile 的 `link:` junction 直读本仓库（`~/.dsh/profiles/<profile>/node_modules/dsh-learnhub → <本仓库>`），
没有第二份安装副本。代码更新后只需：

1. `npm install`（依赖有变化时）+ `npm run build`——重出 lib 三产物，skills 随构建同步到 `<dshHome>/skills/`；
2. **重启 dsh 宿主**——lib 是宿主启动时加载的，重建不会热生效。

preset 存根（`~/.dsh/.agent-presets/learnhub/agent.cordis.yml`）的 Include `path` 指向本机
clone 的 `preset/learnhub/agent.cordis.yml`（file:// URL，安装见文末「用户根安装」）。
正常更新不需要动它（改仓库文件即生效）；clone 位置或盘符变化时改存根里的 URL，改完重启宿主。

验证（只读，不写 vault）：`node scripts/smoke.mjs <vault 根目录>`，全绿即新版引擎可用。

## 脚本

```sh
node scripts/smoke.mjs <vault>       # 只读冒烟：status/xpStatus/promptKinds/recommend/doctor/analyze/coursesTree/读路径
node scripts/e2e.mjs <vault>         # 写路径端到端：临时副本上跑 题库(9题型)→作答(FSRS/乱猜)→XP 预算对账→skip/complete→审计→doctor→edit 联动→交互件→风格变体→图谱健康分/认知维度→genJobs
node scripts/dev-server.mjs <vault> [port]  # 面板开发伺服：直调引擎 + web/dist（无模型 seam）
node scripts/ensure-notes.mjs <vault> [course]  # 幂等补齐课程缺笔记的骨架文件（存量修复）
node scripts/smoke-panel.mjs [port]  # 面板伺服冒烟：301/资产/API 形状
```

e2e 在系统临时目录复制最小 vault 子集并重置笔记 frontmatter，绝不触碰真实 vault。
各脚本的 `<vault>` 都是 **vault 根目录**（引擎在其下找 `学习中心/`），
传 `学习中心` 本身会得到合法的空注册表（Missing），课程相关步骤全部落空。

## 目录

```
src/index.ts          host 插件源码（工具面 + HTTP 路由 + SPA 伺服 + 生成任务注册表）
src/engine/*.ts       TS 引擎（paths/registry/graph/notes/srs/grading/sessions/content/gengraph/audit/analysis/question-bank/store/门面）
ui/                   面板 SPA 源码（Vite + React + Arco + React Flow；pages/ components/）
web/dist/             面板构建产物（host 伺服；assets 带 hash 永久缓存，index.html no-store）
web/vendor/           交互件 vendored 库（katex/three，build 时从 ui/node_modules 复制）
src/client/index.tsx  客户端源码（slots 座位注入）
scripts/              smoke / e2e / dev-server / ensure-notes / smoke-panel
cordis.patch.yml      bundle patch 层
preset/ skills/       「学习伙伴」preset 与 agent skills
```

preset 的用户根安装（一次性）：复制 `preset/learnhub/user-root-composition.yml`
到 `~/.dsh/.agent-presets/learnhub/agent.cordis.yml`（连同 `preset.yml`），
把 Include 的 `path` 改成本机 clone 的绝对 file:// URL，改仓库文件即生效。
注意必须真实目录：scanRoot 只认 `isDirectory()`，junction 会被跳过。
