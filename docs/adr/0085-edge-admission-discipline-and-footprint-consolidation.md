# 边种与边属性的准入判据：边轻纪律成文 + 概念足迹收成一处

一条纪律在这个仓里**被执行，却从未被定义**：`graph.ts` 的 `RETIRED_EDGE_KEYS` 与 `proposals.ts` 的 `RETIRED_OP_KEYS` 对 `origin` / `status` / `probation` 三个键在图 YAML 与提案 op 两侧各设一道 fail loud 拒收，而「边轻纪律」这个词在整个 `docs/` 里**从未被定义**——只在 ADR-0077 的 `upstream_dag` 段被旁引一次，另在调研笔记 `docs/research/2026-09-graph-edge-semantics.md` 有一条外部对照基线（RDF 等标准同取向），但**没有一处给出判据**。本 ADR 把这条纪律成文——钉死它的诊断、给出边属性的二分判据与三档逃生口、写明加边种的准入判据；同时把一处结构欠账（概念足迹的折叠散在多处）的**收拢形态**落成纸面。

本 ADR **只落文档**（本文件 + `CONTEXT.md` 两处词条），不含代码；概念足迹的**收拢实现另开票**（见「实现登记」）。域词条（`CONTEXT.md`「边轻纪律」「概念足迹」）按同一口径修订，两者的差值以本 ADR 为准。

## 诊断：不复制事实源（#127 原文）

设计时的原话是「**行为侧不加新字段、不复制事实源**」。当时的边缘计划有三个字段——`origin`（骨架/生长/修复）、`status`（asserted/confirmed/proven）、`probation`（指针）；落地时三者**全部驱逐**。驱逐后的表述散在四处、措辞一致地写作"派生"：

- `graph.ts`：`RETIRED_EDGE_KEYS` 的拒收文案「origin 从提案 journal 派生」
- `proposals.ts`：`RETIRED_OP_KEYS` 的注释「候选边留提案侧留痕、origin 从 journal 派生、复诊状态落 state/边实验.jsonl」
- `probation.ts` 文件头：「账本不重复存储（**与 origin 从 journal 派生同款纪律**）」
- 面向教练的工具描述（`commands/图谱.ts` 的 `graph_propose` summary）：「insertion origin derives from the proposal journal」

**这条纪律目前尚未受伤**——找不到消费者在问"这条边是骨架、生长还是修复"，所以它是**潜伏的欠账**，不是活的 bug。但把它成文时，`#127` 的四处欠账必须如实写下来。

## 三字段的三种机制（一句话掩盖了三件事）

三个字段被当作同一件事驱逐，**实际理由各不相同**：

| 字段 | 真正的理由 | 成立的前提 |
|---|---|---|
| `origin`（骨架/生长/修复） | **可派生** | ① 每条边都产生于某次提案；② 存在 `operator → 骨架/生长/修复` 的**映射规则** |
| `status`（asserted/confirmed/proven） | 三个值**各有各的家**：asserted=图自身、confirmed=提案记录、proven=复诊账本 | 一次**跨三源连接**；且 `confirmed` 已裁不设 |
| `probation`（指针） | **生命周期不同**——复诊结局之一就是「剪除」，边被删而**记录必须留下** | 它**不是可派生的**；账本**即事实源**（`due`/`outcome`/`decided_at` 别处都没有），不是谁的副本 |

把 `probation` 说成"不重复存储"，等于**把自己的事实源说成了别人的副本**——**决定对，理由说错**。三种机制的正确命名是：**可派生 / 跨源连接 / 生命周期不同**——其中只有第一种有资格"不落边"，后两种不落边的形态是**账本**（`probation`）或**跨源连接**（`status`），不是"派生"。

## 诊断的四处欠账（如实登记）

**① 「origin 从 journal 派生」零实现。** 这是唯一被点名的那条派生，却**没有任何一行代码在兑现它**。`origin` 在 `src` + `ui/src` 里**只出现在拒收文案 / 注释 / 工具描述**三类文本（`graph.ts` 的拒收提示、`proposals.ts` 的 `RETIRED_OP_KEYS` 与注释、`probation.ts` 与 `growth-subsystem.ts` 的注释、`commands/图谱.ts` 的 `graph_propose` 描述）——**零派生实现**。（票面写"4 处"，实测九个 token、五个文件；性质不变：全是文案，无一行代码。）被真正守住的对照是另一件：`probationFrame` 的「登记日/决定日从提案记录派生」读的是**按 id 查的提案 artifact（表）**；而承诺给 `origin` 的是**从 journal 派生（流）**——**成本差一个量级，纪律却把它们写成"同款"。**

**② 面向 AI 的承诺是假的。** `commands/图谱.ts` 的 `graph_propose` summary 当场告诉教练「insertion origin derives from the proposal journal」——**AI 会信，代码做不到。**

**③ 反证：同一份代码里有个内部不一致。** `seed.ts` 的**终点锚**存了 `origin_proposal?: number`（`EndpointAnchor`）。同一个问题（"这是哪个提案造的？"）**锚存了、边没存**——可见「边不能存 origin」**是当时的选择，不是从原则推出的结论**；其成本（要用时跨源连接，而连接没写）未经计算。

**④ 更正本票早期版本的一次误判（如实留痕）。** 早期版本曾把「沉淀 addresser 尚未接线」列为同款实例——**已撤**。实测 `recordRecheckOutcome`（`growth-subsystem.ts`）**已**按概念地址逐条写 `recheck_outcome`，`coach-round.ts` 也已在读；真正的问题只是 `sediment.ts` 的文件头注释**曾**过时（**代码超前于注释**，方向与通常相反），该过时声明已由 #262 删除（ADR-0084 登记）。故**已证实的干净实例只有 `origin` 一个**——不足以称"固有失效模式"。

## 结构性风险：驱逐字段时无门检查替代派生是否存在

三字段的驱逐暴露的是一个比"假承诺"更准确、也更能验证的风险：**纪律驱逐字段时，没有任何门检查"替代派生是否真的存在"**（本仓的架构门 R1–R7 / G1–G9 与 `scripts/scan-*.mjs` 清单里没有这一条）。原因是**驱逐**是**一次性的拒收**（有门守：`RETIRED_EDGE_KEYS` / `RETIRED_OP_KEYS` 当场 fail loud），而**替代派生**是**一份要长期存在的实现**（无人管）。前者有门，后者裸奔。

**一对反向实例**（注释与实现两个方向的漂移）：

- `origin`——**注释超前于代码**：注释与工具描述承诺派生，代码零实现。
- `sediment.ts`——**代码超前于注释**：文件头曾声明 addresser 未接线，而 `recordRecheckOutcome` 早已按概念地址写事件。**注意：它不是「替代派生缺失」这一失效模式的实例**（派生存在、只是注释落后）——它是"靠注释对账"不可靠的**反向**佐证，与 `origin` 成对。此过时声明已由 #262 删除。

两例合起来说明同一件事：**替代派生存在与否不能靠注释声明，必须有门把"承诺"与"实现"对起来。** 这与本节开头的判断同构。（门本身**另开票**——本 ADR 只登记这道缺口、形状与它要防的形态。）

## 边属性二分判据：声明 vs 状态

成文的判据如下——它要能被其他词条与 ADR 直接引用：

> **凡欲落在边上的属性，先在「声明」与「状态」之间二分：**
> - **声明（Declaration）**——描述**边的固有成分**、只写一次、不随生命周期演化、边消失即随之消失：住**边上**（图 YAML 内联）。既有实例：`enc.w`（成分技能权重）、`enc.note`。
> - **状态（State）**——描述**边在生命周期里的演化**、会被反复更新、且**边被删除后记录仍须存活**：**不落边**。既有实例：`origin`、`status`、`probation`。

**两个轴正交，不可混读**：本判据（声明 vs 状态）回答"落不落在边上"；「三字段的三种机制」回答"不落边时去哪"——`probation` → **账本**、`status` → **跨源连接**、`origin` → **可派生**（无家可去、也不必去）。状态**不落边**的形态因此有三种（去账本 / 跨源连接 / 可派生），三者叠加才完整；把三者并成一句"不重复存储"正是本 ADR 要纠正的"一句话掩盖三件事"。**禁止把状态塞进边**——`graph.ts` / `proposals.ts` 的两道 fail loud 拒收就是这条判据的执法面。

## 三档逃生口

二分之后若确实需要"边上的额外信息"，走三档逃生口——**各带一个本仓既有实例**：

1. **结构化状态 → 账本**：追加流水，不进图。实例：**边实验账本**（`state/边实验.jsonl`，`probation.ts`）——插入边复诊的 `due`/`outcome`/`decided_at` 全在账本，图 YAML 的 `pre` 保持零边字段。
2. **非结构化说明 → 边上的自由文本**：轻微、只读、随边并存。实例：**`enc.note`**（如 `content.ts` `invokesProjection` 写出的「invokes 投影 cnt/total」）。
3. **统一适用的软硬判断 → 顶点上的布尔**：作用于一个节点与其**全部**前置边的关系。实例：**`opt`**（`graph.ts` 的空降节点/可选前置布尔，构造期收进 `opt` 集合，`isReady` 据此放行可选前置）。

### `opt` 的代价（只写好处会误导）

顶点布尔是**广播**的：它作用在**整个顶点**的所有 pre 边上，粒度**塌到顶点级**。由此产生的表达缺口——**"p 对这个消费者可选、对彼必需"这类边级差异表达不了**。`opt` 能成立，是因为它要表达的那类"软硬判断"**在本仓恰好是顶点级**的；一旦出现边级差异，顶点布尔**不是**逃生口，而是要重新走准入判据的**新边属性**。逃生口有边界，不是万能。

## 准入判据：加边种要有据

> **新增边种（或新增边属性）之前，必须先证明它"不可派生"**——即证明该信息**不在盘上**、且**无法由既有正典（图 YAML + 提案 journal + 账本 + 概念登记表）在需要时算出**。

**规则不是"永不加边种"，是"加边种要有据"。** 判据本身**不成立**的情形确实存在——至少两个反例边界：

- **两节点相关但零共同概念**：这条"相关性"**信息不在盘上**——没有任何既有源（`teaches`/`assumes`/`invokes`/`enc`）能推出它，只能作为**声明**（新边或新属性）落图。
- **边的置信度随时间演化**：它是**状态**（会更新、边删后记录须留），即使可算也只能进**账本**，不能进边。

准入判据的**首次自我适用**见「裁定形态 ②」——本 ADR 自己就用它否决了一处新增（`misconceptions` 反向）。

## 概念足迹收拢

### 准确清单（实测）

概念足迹今天的真实形态是**折叠散在多处**（A：3 处概念反向 + B：4 处反向可达）——不是一等派生。

**A. 概念反向（扫全图折到概念）—— 3 处**

| 位置 | 折出什么 | 消费者 |
|---|---|---|
| `coach-tools.ts` `renderConceptFootprint` | 概念 → 教/假设它的节点[] | 概念足迹工具 |
| `content.ts` `invokesProjection` 的 `holderOf` | 概念 → 最近的祖先教授者 | enc 权重投影 |
| `proposals.ts` `consolidationGateErrors` | `taught: Set<概念>`（已教概念全集） | 巩固门 |

**B. 反向可达（祖先闭包）—— 4 处，其中 3 处是 O(N) 扫描**

| 位置 | 形态 |
|---|---|
| `Graph.upstreamClosure` | **BFS** ← 自称"单一出处"，其注释已记录"两处各写一遍 BFS"的旧教训 |
| `content.ts` `conceptScopeOf` | `graph.names` 上 `filter` + `isAncestor` ← O(N) |
| `content.ts` `invokesProjection` | 逐点 `isAncestor` ← O(N) × 每个概念 |
| `seed.ts` `closureOf` | 无环走 `graph.names` 筛 `isAncestor`（O(N)）；**有环走内联 `preOf` BFS**（`upstreamClosure` 的手写副本） |

**C. 题目侧 —— 已收拢，不动。** 单实现 `growth-subsystem.conceptInvokesOf` + providers 契约（`renderConceptFootprint` 经 `providers.conceptInvokes()` 复用，本文件不自己扫库）。

### 裁定形态（四条）

1. **概念反向住 `Graph` 构造期**，与正向映射**并列**：`taughtByOf` / `assumedByOf`（概念 → 节点[]，按 `graph.names` 序 → 确定性）。**顺带完成**——`teachesOf` / `assumesOf` 本就在同一趟构造里建好（`Graph` 构造期已有那段遍历），反向只是同一趟里多折一次。
2. **不做 `misconceptions` 反向**——今天无消费者；按本 ADR 的准入判据，**没有消费者的不加**。**这是准入判据的第一次自我适用，必须记进本 ADR。**
3. **`upstreamClosure` 独占反向可达**，B 的四处扫描改读它。安全性依据：**集合恒等**（无环图上 `isAncestor(a, n) ≡ a ∈ upstreamClosure(n)\{n}`）+ **比较器是全序**（`content.ts` `byDepthDesc`：`depth` 差 `||` 名字，无并列）→ **输出逐字不变**。**但有两处差异必须显式对待，不得掩饰**：
   - **有环时**：有环图上 `Graph.reach` 为空、`isAncestor` 恒 false，而 BFS 的 `upstreamClosure` 仍沿 `preOf` 走完全部可达前置。**`content.ts` 的两处扫描**（`conceptScopeOf` / `invokesProjection`）在环图上确实返回空集；**但 `seed.ts` 的 `closureOf` 已按 `hasCycle` 分叉**（环上走内联 BFS、输出非空且与 `upstreamClosure` 等价）——故并非"三处都空"。收敛时 `content.ts` 两处沿用 `upstreamClosure`，环图读数会**从空集恢复到真实可达集**（修复而非回归，但**行为确实变了**）。
   - **有断边时（无环亦然）——`upstreamClosure` 会抛错、扫描不会**：`Graph` 构造期 `preOf` 保留全部 `pre` 名（含悬空名），而 `succ` / `pred` 与 `reach` 只收 `nset` 成员——故 `isAncestor` 对断边**优雅降级**（返回子集），而 `upstreamClosure` 的 BFS 直接遍历 `preOf`，走到悬空名时 `preOf[p]` 为 `undefined`、`for...of` **抛 `TypeError`**（实测：`names=[A,C]`、`preOf={A:[X],C:[A]}`、`X` 悬空时 `isAncestor` 集为 `[A]` 而 `upstreamClosure(C)` 抛 `this.preOf[u] is not iterable`）。断边是显式容忍态（`graph.ts` 文件头「不因重名/断边/环崩溃」、`structureCheck` 报断边、audit E2），故收敛前**必须先给 `upstreamClosure` 补 `nset` 守卫**（或消费面自滤），否则会把今天不炸的扫描变成崩溃路径。
   **两处差异均须专门测试钉住。**
4. **统一在消费面，不在存储面。** **节点侧 = eager**（数据就在 `Graph` 手里，构造期一次折出）；**题目侧 = lazy**（`loadView` 只返回 graph + state，**不含题目**，扫题库不免费，故维持按需经 providers）。两面对外**一张脸**（一个读侧视图同时消费两侧），**不建新模块**。理由：题目粒度天然更大、更贵，硬把两侧塞进同一个 eager 存储面是"为了对称而付不值的代价"。

### 防复发门（必须有，否则会第四次散）

`upstreamClosure` 的注释写过一次教训——「口径一致靠注释，不靠代码」——随后**被违反三次**（B 表里三处 O(N) 扫描就是证据；其中 `seed.ts` 环图分支还内联了一份 BFS 副本）。"靠注释"已证明无效。故本 ADR 要求：**加一条门**（在 `tests/arch-guards.test.ts`，或用 `scripts/scan-*.mjs` 套路）——**禁止在 `graph.names` 上"筛 + `isAncestor`"求祖先集，也禁止就地手写 `preOf` BFS 求闭包**（两类都命中即报，指向 `Graph.upstreamClosure`；`seed.ts` `closureOf` 的内联副本是第二类的现成样本）。门的具体实现随概念足迹收拢**另开票**，届时按章程 §5 加门纪律（带正反两向自检：误报样本不再报、真违规样本仍拦截），阈值与实测链登记进 `tests/README.md` 门册。

## 被拒方案

### 节点与边分开存储（`nodes.yaml` + `edges.yaml`，边成一等行）——不采纳

- **逻辑上买不到卖点。** 拆分看似让边有行身份、`origin` / `status` 自然成列；但边轻纪律禁止的**恰恰是边上的状态**，`origin` 正是机制痕迹——拆完依然不能存。真正买到的是**边的双向可查**，而这件事住在**读层**（`Graph` 构造期物化反向映射，零 schema 改动）。
- **制造双源。** `data/*.yaml` 今天是**唯一正典且人可读、git 可审**（`graph.ts` 文件头明写）。拆开后一致性从"不可能不一致"变成"必须维护一致"；而写入单元（`runWriteUnit`）的失败态会从**孤儿条目（合法）**变成**断边（违约——正是 `structureCheck` 要报的错）**。
- **`opt` 与粒度。** `opt` 今天是广播型顶点布尔。边成一等行后它理论上可细化到边，代价是存量回填 + 由 1 条信息变 N 条；而它想表达的那种边级差异是否真被需要，**尚无消费者证明**。
- **`pre` 的可读性。** `region → blocks → nodes` 两级容器同时是**分区**与**阅读结构**（`graph.ts`）；拆开后读一个节点要跨文件（对 agent 亦然）。

**判据（何时才该拆）**：（甲）边的**顶点类型不止一种**；（乙）边种 ≥3 且**形状异质**；（丙）边的集合需要被**独立审计 / 独立演化**。

**而「引用二分图」今天已经满足（甲）**——它的左侧同时是**节点**（住 `data/*.yaml`）与**题目**（住题库 YAML），右侧是**概念**（住 `概念登记表.yaml`），天然跨三个文件。**所以：节点/边那种"数据图"不该拆；该收拢的是「引用二分图」。**

### `misconceptions` 反向——不做（准入判据的首次自我适用）

`misconceptionsOf` 的反向（概念 → 列出哪些节点把它当误解）今天**无消费者**。按本 ADR 的准入判据，**没有消费者的不加**。这是准入判据落成后的**第一次自我适用**，优先于任何"对称性好看"的直觉。

### 其余（并入既有裁决，不重开）

- **新增 `pre` / `enc` 之外的边种** → 不新增；本 ADR 只立判据，不改 schema。
- **重开 #249** → 不重开；本 ADR 只记录它留下的缝隙（教练工具面白名单与工具规格归 #249，已关）。

## 实现登记（待开票）

**本 ADR 只落文档**（本文件 + `CONTEXT.md` 两处词条）。以下**实现另开票（待开票）**，形态与判据以本 ADR 为准：

- **概念足迹收成一处**：`Graph` 构造期加 `taughtByOf` / `assumedByOf`；B 的 O(N) 扫描与 `seed.ts` 内联 BFS 改读 `upstreamClosure`（须先补 `nset` 守卫防断边抛错；连同环图/断边行为差异的专门测试）；`coach-tools.ts` / `content.ts` / `proposals.ts` 三处消费面改读反向映射；**防复发门**（禁止 `graph.names` 上"筛 + `isAncestor`"，禁止手写 `preOf` BFS）。这是一张**尚未开出的票**——本 ADR 落其形态与清单，不施工。
- **卡点自报归因面的概念足迹消费**：既有实现（#249），不动。

## 行为与门影响

- **零代码、零行为变更**：本票只新增一份 ADR 与两处 `CONTEXT.md` 词条，不改路由 / 工具面 / 提示词 / schema / 磁盘格式。
- **不跑 `npm test` / `prompt-bump`**：纯文档变更，两门无判据面（与 #263 同款）。本 ADR 的「防复发门」要求随**实现票**落地——届时的门按章程 §5 加（带自检、阈值实测、门册登记），不在本票。

## 边界

- **不动任何源码**（`Graph` 不加反向映射、多处折叠不收敛）——实现另票。
- **不做**任何存储层的拆分或合并（节点/边分开存储已在「被拒方案」裁为不采纳）。
- 不新增边种、不改 `pre` / `enc` 的 schema。
- 不重开 #249（已关；本 ADR 只记录它留下的缝隙）。
- 不改概念登记表的身份语义与废弃态（那是 #260 / #262–#265 的面）。
- 不做「概念足迹」的 UI（#268）。

取号：0085（写前 `ls docs/adr/` 确认，0084 已占）。票面：#267。

## 实现登记·补记（#270，2026-09-15）

「概念足迹收成一处」已由 #270 落地。本节补记结果与两处实现期裁定，上文不动：

- **反向映射**：`Graph` 构造期与正向同趟折出 `taughtByOf` / `assumedByOf`（names 序确定性；`misconceptions` 反向继续不做——准入判据二次适用）。
- **`upstreamClosure` 守卫**：`nset` 过滤 + `preOf[u] ?? []`——悬空前置不入闭包、悬空名入参退化 `{自身}`（裁定：闭包只认图内节点，保 `foldCompletion` 进度计数与 `closureHealthErrors` 不被断边污染）。第五处 `graphPath` 的 parent 回溯 BFS 同口径补守卫（要**链**不要集合，G10 白名单豁免）。
- **四处扫描退役**：`conceptScopeOf` 祖先段、`invokesProjection` 候选集、`seed.closureOf`（环图分支内联 BFS 整体删除）、`renderConceptFootprint` 折叠、`consolidationGateErrors` taught 集——全部改读原语。
- **环语义裁定（选项 a）**：`isAncestor` 在环上也走闭包（环图构造退化为逐点 succ BFS，课程规模可接受），25+ 调用点保持 boolean 契约不变（选项 b「环上作废」需全部调用点处理 void，改动面不成比例）。**depth/edges 保持环上作废**（`hasCycle` 显式旗标）。
- **作废署名**：「算不出」≠「没有」——`max_depth`/`unreachable` 环上 `null`（不再伪装成 0/[]）；健康分 `topology_void: ['convergence']`；审计环图 INFO 披露「R1/R2/R4/R6 本轮不算」；UI 图深度标签显式「作废（图有环）」。已知退化（环上 depth 并列 → 「最近前置」退化为名字序）由环 fixture 钉住。
- **防复发门 G10**（`scripts/scan-closure.mjs`，门册已登记）：拦 names 筛 `isAncestor`（链式/for-of 两形态）与 for-of `preOf` + queue.shift 手写 BFS；豁免原语之家与 graphPath 白名单。
- 验证：`npm test` 全绿（G5 基线 8 文件同提交迁移；G3/G4 零漂移；类型门 0/0）。
