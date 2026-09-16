# 生长草稿：门同源的累积重放与执行官最小回路

#266 定了「思路官 + 执行官」两站方向，#271 是竖切第一票（最小可用回路）。2026-09-16 的 grilling 对票面做了逐条代码核验，发现 **6 处票面与现状的偏差**（见证据表），14 问裁决后定稿如下。本 ADR 只裁 #271 的设计；思路官拆分与旧路径退场归 #273，糖算子补全与概念面 findings 归 #272，UI 消费归 #269。

## 裁决

**核心不变式：草稿通过 = 门通过——按构造成立，不靠两套实现对齐。**

1. **门同源（本 ADR 的中心裁决）**：把 `proposeEdit` 的门序列收拢为一个导出纯函数 `editGateErrors(spec, {regions, graph, entries, anchors, growthGate?})`（结构重放 / 概念对表 / 终点锚保护 / 巩固门 / 生长闸门 / 路线门——`proposals.ts:546-594` 的全部门）。`proposeEdit` / `applyEdit` / 草稿内核**三处同调**。只跑 `simulateOps`（`proposals.ts:1477`）不够——它只是门的结构子集（断边/环/重名/误解上限），概念未铸名、锚保护、巩固门、生长闸门、路线门全在其外。
2. **重放与草稿差异**：新增 `replayDraft(regions, graph, ops) → {errors, overlay}`；`simulateOps` 保留导出（测试在用）但内部改调 `replayDraft`。sealed 谓词从 apply 写单元（`proposals.ts:782-796`：`wires` = set_pre 的 node 集；`sealing = adds===0 && 每个 op 都是 set_pre`；`adds>0` 且接线 → reopen）抽成 `sealedDecisionOf(ops, anchors)` **两处共用**——复刻必漂。草稿差异（Draft Diff）契约 `{base, added_nodes, removed_nodes, renamed, added_edges, rewired, sealed_effects}` 由重放产出。
3. **水位模型**：草稿持有**自身演化图快照**（内存 + 落盘）；内核对「草稿图 + 未发布 ops」重放；每次 finish 只把 `[水位, end)` 增量硬化为 `EditProposalSpec` 投给真实受理门 → `graphPropose` → `graphApply`；finish 时对真实基图**再跑一遍门**，漂移（外部改了图）即拒收、零落盘、草稿保留；水位只在 apply 成功后前移。每次 finish 重放全部累积 ops 的方案否决——已发布节点会「add_node 重名」当场炸。
4. **草稿缓存**：`courseStateDir(root)/草稿/<sessionId>.json` 原子写（**每批结束**写，非逐 op），带「非活图、非提案」标记、不进提案生命周期；同课程同一时刻**至多一份在途草稿**，新会话遇在途草稿默认**续建**（注入轮次日志；显式 force 才新建）；取消先只留内部 API（命令/面板接面另票）；重启可续建。
5. **执行官工具面**：读件五件（`graph_view / node_card / concept_footprint / upstream_dag / endpoint_anchor`——**复用 `coach-tools` 渲染函数、新建专用注册面**，description 面向补丁语境；旧八件与 `compassPaint` 不动，`coachToolsetFor` 仅 2 消费方已图查证）；写件三工具 **`patch` + `audit` + `finish`**；糖算子 `insert_prereq_chain` 作为 `patch` 的 `op` 取值（不另立工具）。**ops 词汇 = 现 `EDIT_OPS` 6 值，排除 `move` 与 region/block**（#275 已退役 fail loud），失败回灌取值域 = 节点 / 概念 canonical（票面旧「区·块」作废）。
6. **执行官输入自足**：本票无思路官——输入 = 现有 `coachContextPack` + 图面（与今日教练同源）。三段式（light/full/arbitration）外壳本票保留，`note.disagreement` 语义不动；#273 才把它换成「思路官 plan → 执行官执行」。
7. **站登记**：`STATIONS` 增 `growthDraft: '教练执行'`；`OutputFormat` 增 `'tool-calls'`（现枚举 `'yaml'|'markdown-blocks'|'json'|'route-text'` 装不下工具调用轨迹，塞进 `'json'` 是语义撒谎且文本锚门对不上）；模板键 `执行官回合` 进 `prompts/templates.ts`（v1，改提示词 = 改生产行为：同提交 `PROMPT_CHANGELOG` + prompt-bump 两条过门）；`REPAIR_MECHANISMS` 增 `draftAuditRepair`，`repair.mechanism` 指向它、`note` 记 `gateRepairRound` 兜底，`REPAIR_ROUND_LOCKS['教练执行'] = null`（显式缺口登记）。
8. **finish 与两类修复轮**：finish 被拒 → 门错误原文**回灌 loop 继续**（不进 `gateRepairRound`），轮数计入会话预算；「禁止空手结束」的机器判据 = loop 自然收束（模型不再请求工具）**且**未成功 finish **且**草稿仍有未发布增量 → fail loud；`gateRepairRound`（门错恰一轮回灌，`agent.ts:120`）保留为最后兜底。审计修复轮每轮 ≤N，常量进 `engine/params.ts`。
9. **预算落点**：`engine/params.ts` 常量单源——新增「每批 ops ≤24」「每会话轮次 ≤16」两常量；票面「每轮工具调用 ≤20」= 直接复用 `agentLoop` 的 `AGENT_LOOP_MAX_TOOL_ROUNDS = 20`（`agent.ts:40`，**不新增**）；learnhub.json 覆盖留后票。票面「进 host-params」作废——该机制不存在（`src/host/params.ts` 是 HTTP 参数量守卫，grep 零命中配置语义）。
10. **入口与边界**：新独立入口 `growth2.coachDraft(courseKey, agent, opts)`（测试缝：灌脚本化假 agent）；旧 `coachGrowthBatch` 一字不动（退场归 #273，加开关违背「修复策略单源」）。`note` 归 #271；`route`（罗盘批内重写）归 #273；「终点 X 已铺通待收尾」finding 与概念面 findings 归 #272（票面 #271:14 与 #272:16 的重叠按此消解）。
11. **术语**：**生长草稿（Growth Draft）** / **草稿差异（Draft Diff）**，已入 `CONTEXT.md`；避让既有「富化覆盖层（Enrichment Overlay）」（`paths.overlayPath` 是另一物）。

## 证据表（票面偏差 → 核验结论）

| 偏差 | 核验证据 | 处置 |
|---|---|---|
| 「simulateOps = 门」不成立 | `proposals.ts:546-594` 另有 conceptGate/endpointGuard/consolidation/growthGate/routeGate；apply 复验 `:695-722` | 裁决 1 门同源 |
| 写词汇含 `move`/区·块 | `EditOp.op` 只余 6 值（`proposals.ts:40`）；`RETIRED_OP_KEYS`（`:85`）；move fail-loud（`:227`） | 裁决 5 排除 |
| 「host-params 可调」不存在 | `src/host/params.ts:1-27` 是 HTTP 守卫；grep `host-params` 零命中 | 裁决 9 常量单源 |
| 「与 #270 并行」前提失效 | `Graph.taughtByOf/assumedByOf` 已在产（`coach-tools.ts:164-171`、`proposals.ts:357`） | 无阻塞 |
| 「区·块取值域」过期 | 逐节点行已去坐标（`coach-tools.ts:85-107`，#281 落地） | 裁决 5 取值域改节点/概念 |
| 「Overlay」撞词 | `CONTEXT.md` 已有「富化覆盖层（Enrichment Overlay）」 | 裁决 11 铸新词 |

## 替代方案（否决）

- **草稿只跑 `simulateOps`**——直接违背第一不变式；概念/锚/巩固/闸门/路线全漏，等于把 #266 要治的「回灌重裁」病换个地方复发。
- **运行态增量模拟**——复刻 rename/del 叠加语义必造「草稿校验 ≠ 门校验」漂移（#266 已裁，本次维持累积重放）。
- **`OutputFormat` 塞 `'json'`**——文本锚门（`tests/output-contract.test.ts` 三面对账）对不上，且站契约撒谎。
- **`coachGrowthBatch` 加开关切新站**——两套活路径违背「修复策略单源」。

## 行为与门影响

- 新增文件与导出面：G4/G5/G7 棘轮精确匹配——`scripts/arch-baseline.json` 与门册 `tests/README.md` 同提交同步。
- 模板新增 `执行官回合`：prompt-bump 两门 + `PROMPT_CHANGELOG`（章程 §8）。
- 站级测试：门面灌脚本化假 agent（先例 `tests/coach-growth.test.ts`、`tests/coach-loop-pass-rate.test.ts`），断言过门 / 拒收零落盘 / 水位前移 / 漂移拒收 / 续建恢复认知 / 禁止空手结束 / 纯 set_pre 批收尾 sealed 落盘。
- 草稿内核纯函数单测：确定性回放（累积 ops → errors / Draft Diff）。

## 取号与票面

取号：0088（写前 `ls docs/adr/` 确认，0087 已占）。票面：#271（父 Epic #266）。图查证记录：`coachToolsetFor` 入边 2（`coachGrowthBatch`/`compassPaint`）、`simulateOps` 入边 `proposeEdit`/`applyEdit`、`gateRepairRound` 生产 3 处（`coachGrowthBatch`/`projectDecompile`/`generateProjectMilestone`——方法调用 `trace_path` 报 0 为已知坑，`query_graph` CALLS|USAGE 补证）、`coachGrowthBatch` 动态分发。裁决过程：2026-09-16 grilling 两轮 14 问，CONTEXT.md 词条随轮落地。

## §修订（2026-09-16，#301 生长草稿三缺陷收口）

触发：同日「数学基础」空课事故——空课（仅一终点锚）面板下发生长批，思路官裁决正常、执行官第 2 轮即铺出正确结构（2 add_node + 终点 set_pre + 铸名 5 概念），但 `draft_finish` 连续 4 次被引擎侧异常击穿（`TypeError: object is not iterable`，非门拒绝），模型用其余十几轮做形状试探全部无效、第 21 轮撞 K≤20 预算顶，**零结构发布**（烧 ~49.7k token）。原文与语料存 2026-09-16 实机存档，**已入仓为回放 fixture**：`tests/fixtures/growth-draft-incident-2026-09-16.json`（提取规则见其 `_source`）。

**修订裁决一：补丁入口「收下即归一」（草稿宽容面从「原样收下」收紧为「归一或拒收」）。** 原裁决只声明「草稿通过 = 门通过」，对**入口形状**未置一词，实现因此原样收下模型给的一切形状（字符串列表/字典/配对列表），毒形状随草稿过夜、直到 finish 才在权威门炸（而权威门对非数组 `misconceptions` 是 `for...of` 直接抛 TypeError 穿透——连 finish 轮次都记不下）。修订后的分界是**两面**：

- **暂存宽容（草稿补丁入口，`growth-draft.ts::normalizePatchShape`）**：名字/条目信息完备的形状当场归一为发布形态——铸名 字符串`「X」`/`{name: X}`/字典`{X: 定义}`（含多键与裸值，均「名字→定义」同族）→ `{canonical[, definition]}`；`teaches/assumes` 配对列表 `[[概念,档],…]` → 概念→档映射；`misconceptions` 按概念归组的字典 `{概念:[文字…]}` → `[{concept, model}]`。归一动作随当次工具回执可见（引擎侧返回文本，**不新开提示词常量**），并随 `onTolerated` 回调给宿主**当次**捕获补标 tolerated（批次结束后再补标只会落到最后一轮）。
- **发布严格（权威门）**：修不了的形状入口整批拒收 + 回灌合法形态速查（`PATCH_SHAPE_CHEATSHEET`），**毒形状永不随草稿过夜**；权威门恒见合法形态，门同源不变式按构造而非按运气成立。拒收面含：`misconceptions` 字符串列表（一条字符串拆不出 concept——事故里它被摊成 `{concept: undefined}`，让审计报出「孤立新铸概念："undefined"」的鬼错误）、误解条目非映射/键名错（事故里模型写过 `[{concept, text}]`）、字典值非文本/文本列表、铸名不可判读形态。**尺寸带/每概念封顶/概念在册**等语义维度不入口归一（那是「补 op 能修」的一类，归 finish 权威门）。

**修订裁决二：门复验异常转门错误（保险丝）。** `growth-subsystem.ts` 调 `editGateErrors` 处加 try/catch：异常折叠为带字段指向的门错误行（`logRound('finish')` 照记、回灌可执行反馈），不再让异常穿透 writeTool 只回灌一行裸异常。配套让重放侧成为形状问题的**单一发声处**：`nodeFromAddOp` 对不能忠实落图的形状 fail loud（非列表 `misconceptions`、取不到真概念名的条目），`replayDraft` 逐 op 收下该行；`conceptRefsOfOps`/`consolidationGateErrors` 对非数组/非条目项**跳过**（不再 `for...of` 抛错，也不再造「引用「undefined」未在册」的鬼引用）。

**修订裁决三：生长失败语料补标按真实失败站落盘。** 两站各失败各的——站标签由引擎在抛出点随错误随行（`stationTaggedError`：思路官段 `COACH_PLAN_STATION`、草稿段 `GROWTH_DRAFT_STATION`），宿主按标签补标；未标注（两站都没跑起来：零终点/注册表缺课/纯 IO 故障）= 没有死因样本，**不补标**。旧口径写死 `STATIONS.growth`（'教练思路'，拆分前单站遗留名）把执行官站的失败补标到思路官站最近一条捕获上（事故里那是一条成功件，被改成 `failed` + `bad-` 前缀，死因还把排查者指向错的语料目录）。站名常量归引擎侧（`COACH_PLAN_STATION` 随门面出，host `STATIONS.growthPlan` 引它对齐），遗留键清理。

**存量处置**：事故毒草稿（`published=0`）修复落地后取消重开，**不做读侧自愈**——毒形状只可能存在于未发布段（`published>0` 的草稿过不了 finish），取消永远安全。落地动作：本仓 `coachDraftCancel` 是唯一取消通道（命令/面板接面仍归另票），故在 vault 里把该文件**停用改名**（`草稿/draft-2026-09-16T17-59-59.json` → 同目录 `*.json.cancelled`；`findActiveDraft` 只收 `*.json`，改名即等于取消，且证据留档不删）。

**提示词面判定（明确登记，防误读为漏登）**：本次新增的模型可见散文 = 形状拒收回执（`PATCH_SHAPE_CHEATSHEET` + 逐字段错误行）与成功回执的「形状归一 N 处」一节，两处都是**引擎侧工具返回文本**（与既有回执「已入草稿：…先 draft_audit 再 draft_finish。」同类），不在 `src/engine/prompts/`、不是 `PROMPT_KINDS` 模板、不入 `TEMPLATE_FILES`：prompt-bump 两门不执法（票面 受管制面 同此判定）。按章程 §8 末段，这一类靠**人审 + 收尾点名**兜——清单见票面 #301 评论（逐条给常量名与文件行）。§8 的登记纪律面（让最终 prompt 变化者须同提交登记）**不覆盖工具回执文本**：登记表的键 = `PROMPT_KINDS` 全集，给非模板文本造条目会让状态级门（键集合 == PROMPT_KINDS）当场变红。

**"收下即归一"的两处**超出票面字面、在其原则内**的判定（如实登记，供复核）**：① 铸名块裸值与非单键字典（`concepts: {X: 定义, Y: 定义}` 或整块不是列表）也按「名字→定义」归一——票面写的是字典 `{x:def}` 单条形态，但同一形状族；不收就等于保留一类**静默丢弃**（旧实现对非数组 concepts 直接 `[]` 丢掉，事故 call17 的 4 枚铸名即如此丢的）。② 误解条目**内**形状（`{concept, text}` 键名错、条目非映射）改为入口拒收而非归一：`text`→`model` 的改写是同一件的第二次猜测，且票面只授权「字典→条目数组」一种归一；拒收行会指名未知字段并给合法形态，一轮可修。两条都在 `tests/growth-draft.test.ts` 有对应断言。

**行为与门影响（本次修订）**：工具面/schema/路由/磁盘格式**零改动**（不是产品契约变更，无探针快照迁移）；新增导出 `normalizePatchShape`/`COACH_PLAN_STATION`/`stationOfError` + 类型 `PatchShapeNormalization`（`PATCH_SHAPE_CHEATSHEET` 只随 `growth-draft.ts` 出、不进門面——无引擎外消费方），G5/G7 棘轮随实现重写、`scripts/arch-baseline.json` 同提交更新（G4 窄面未触）；`REPAIR_MECHANISMS.plannerRecheckOnce` 的见证串随站名常量化改写（`agent.repair('教练思路'` → `agent.repair(COACH_PLAN_STATION`，S68 门当场红过，已同步）。**图查证记录**（AGENTS.md 收尾点名；project `D-learnhub-plugin`，`query_graph`）：`STATIONS` 入边 29 条全为成员访问（键改名只影响 `jobs.ts` 一处，已核；值未动故 S63 站表门不受影响）；`editGateErrors` ← `proposeEdit`/`applyEdit`/草稿内核 3 处（错误行契约三处同调不变）；`nodeFromAddOp` ← `replayDraft`/`applyOpsToNodes`（前者逐 op 收下抛错、后者只在门后跑，fail loud 不会从无门路径逃逸）；`normalizePatchShape`/`PATCH_SHAPE_CHEATSHEET` ← 仅补丁入口（无其他调用点漏接）；`GrowthDraftDoc` ← 草稿读写四函数 + `coachDraft`（磁盘格式未变，无迁移面）。验收回放：`tests/growth-draft.test.ts`（事故语料逐调用回放 call2/call3/call5/6/call15/call17/call21 + 毒草稿 finish 门错误化 + 保险丝折叠 + tolerated 回调）、`tests/corpus.test.ts`（站名词表对表）、`tests/coach-growth.test.ts`（两站失败各带各的标签）、`tests/host-runtime.test.ts`（失败补标落真死因件 + tolerated 落当次件 + 无标签不补标）。

## §修订指针（2026-09-17，#309）

本 ADR 的三处裁决被 #309 二次事故（2026-09-17「数学基础」，21 轮 / 约 35k token / 零发布）推进：**裁决 1「门同源」只兑现到结构子集**（propose 的 schema 纯校验缺席草稿侧 → 审计「通过」与 finish 被拒同帧共存）；**裁决 3「水位模型」的实现与文字不符**（实现对基图重放**已发布段**，而 `applyEdit` 早已把它写进 `data/图.yaml` → 第一次发布成功后同会话第二次 `draft_patch` 必炸，会话事实上已死）；**裁决 5「写件三工具」首次扩容**（新增逃生口 `draft_revert`——追加式草稿删不掉已入草稿的 op，缺陷② 使被门拒的 op 永久卡在未发布段）。裁决方向未变（门同源、水位前移语义、草稿暂存面），故不新开取代声明；三条的处置与实测数字见 **ADR-0095**（生长草稿的生命周期收口）。同期另两件：熔断口径改「跨成功调用累计」记在 ADR-0041 §修订补记二；日志目录自愈记在 ADR-0080 §修订。**本 ADR 正文不改**：裁决 1 的「三处同调」与裁决 3 的「内核对草稿图 + 未发布 ops 重放」按 ADR-0095 的解释执行。
