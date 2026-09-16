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
