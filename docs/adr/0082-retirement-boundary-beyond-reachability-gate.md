# 退役边界在可达性门之外：种子链与四条死命令整体退役

ADR-0076 已把「种子」降职：建课改成**名称即空图**（`POST /course/create`）+ 学习者手加终点（`POST /endpoint/add`/`remove`），目标反编译改为 **plan-only**。此后种子（结构起草）通道的**产品入口全部消失**——面板不再有「起草」按钮、反编译不再产 seed 半区——但**机器面**还留着一整套：`seed-propose` 命令声明、`POST /seed/propose` 路由、handler、模板「种子提案」、生成站「种子起草」、质量量规轴「种子·终点」、引擎方法（`proposeSeed`/`applySeed`/`proposalImpact`/`seedPropose`/`contentReview`）、前端 `SeedImpactPreview`/`api.proposalImpact`/`SeedImpactDoc` 与 gen-job `phase=seed` 词汇，以及 decompile 双半区的 `pair` 联动机械。它们被两份行为快照（路由 488 条、工具 261 条探针）以 200 响应「钉活」，于是没有任何门会把它们判红。

四条命令同理：`node-pin`（`POST /node/pin`）、`review`（`POST /review`）、`courses`（`GET /courses`）、`day-cutoff`（`PUT /day-cutoff`）在面板与 agent 面都已无调用方（`pin` 的 agent 工具 `learnhub_pin_today`/`unpin`、`GET /courses/tree` 通道等**替代入口仍在**），只剩声明、路由与快照条目。

理由：与 ADR-0081 同族——**「声明即产品面」**。无产品入口的命令/路由/引擎方法不该继续养着：维护者要记它、契约测试要覆盖它、快照条目还会把死入口**钉活**。行为快照是**行为回归**（这条路由当时该怎么回），不是**可达性回归**（还有谁在调它）；把「快照里有 200」读成「入口还活着」是把回归网误当可达性门。退役的判据是**可达性**（有没有产品入口/调用方），不是快照存在与否——这正是本 ADR 与父票 #254「死入口退役」主题的边界裁定。

关键裁决：

- **种子链整体退役**：删 `seed-propose` 命令、`POST /seed/propose` 路由与 handler、模板「种子提案」（`Content.PROMPT_KINDS` 相应键）、生成站「种子起草」、质量量规轴「种子·终点」（`quality-audit` 的 `AUDIT_AXES` 第二轴）、引擎方法 `proposeSeed`/`applySeed`/`proposalImpact`/`seedPropose`/`contentReview`，以及前端 `SeedImpactPreview`/`api.proposalImpact`/`SeedImpactDoc`/`GRAPH_PHASES.seed`/`GEN_PHASE_META.seed`/`SeedDraftRequest`。反编译保持 plan-only。
- **`pair` 联动机械随 seed 半区一并删**：`learnhub_project_decompile_apply` 工具、`project-decompile-apply` 命令（唯一 agent 面工具随删）、联合 apply 的「先落种子再落计划」守卫、`proposals-impact`/`proposalImpact` 影响预览一并退役；计划 apply 只走 `learnhub_project_apply`。
- **四条死命令退役**：`node-pin`、`review`、`courses`、`day-cutoff` 的命令声明/路由/handler/专属引擎方法与 UI 死封装删净。**保留 `learnhub_pin_today`/`learnhub_unpin` 两个 agent 工具**（agent 面入口仍在，与命令 `pin-today`/`unpin` 各自独立）。被删的 6 条路径一律回落 404。
- **存量兼容（读侧宽容、写侧拒绝）**：提案读取**不校验 `kind`**，存量 vault 中既有的 `kind=seed` 提案行仍可合法读出、**不判 Broken**；但 apply 侧按 kind 拒绝，种子提案不可再 apply。这是「合法读出的历史行不该因退役而染红」的 ADR-0004 同族纪律。
- **提示词面：删站不补登记**。删除「种子提案」模板只减少一个版本号、不产生新版本号——`prompt-bump -- check` 的判据是版本号**集合差**（新增才违规），故删站恒绿、**不需要** `PROMPT_CHANGELOG` 条目（没有「预期输出增量」可说）。质量量规同步删「种子·终点」轴，`AUDIT_AXES` 只余「教练回合」。
- **同提交迁移全部受控面**：路由/工具行为快照删除死入口探针（方法不匹配样本从 `/node/pin` 改挂仍在的 `/rebuild`）、`host-routes-baseline.json` 删 6 条、`host-tools-snapshot.json`/`host-tools-behavior.json` 随契约更新、`host-face-baseline.json` 重算（种子链退役令 `graph.seedPropose`/`content2.contentReview`/`proposals.proposalImpact`/`sched2.setDayCutoff` 出路由面；冒烟管线改走 `graphPropose`/`graphApply` 两条入口转共享；`pinToday`/`unpinToday` 随 node-pin 路由退役转工具独有）、G2 命令数 162→155、G3/G4/G5 棘轮基线 `--update`。G3 的 dead 声明硬门同步删 `GraphDeps` 的 `noteManifest`/`loadPrompt` 两个死声明。

边界：

- **测试夹具的种子三件套替换为声明式落盘**。退役前 `createCourse + addEndpoint + applySeed` 的测试夹具无法再走种子通道，改为 `tests/helpers/drafted.ts::draftCourse` 直接落盘复现 applySeed 的最终态（registry + `data/*.yaml` + 终点锚 + 概念登记表 + 罗盘脚手架 + 笔记骨架）。这是夹具对已删通道的**等价替代**，不改任何判据。
- **`src/engine/seed.ts` 只删写侧**：读侧保留 `EndpointAnchor` 的 `origin_proposal`/`seed_nodes`/`start_basis` 字段、`isSeedGraph`/`foldCompletion`/`junctionServes`——存量 vault 里 seed 落下的锚与节点仍在图上，读侧必须照读。
- **存量 `phase=seed` 生成任务也走恢复侧兼容**（与提案 `kind=seed` 同族）：历史档里已落盘的 `phase='seed'`/`'种子'` queued 任务无执行器，恢复时经 `RETIRED_GEN_JOB_PHASES` 明确标失败可重试，不让它落进 `pumpGeneration` 的默认分派被当正文管线误跑（那会把 phase 改写成 `outline` 并永久改写任务记录）。
- **行为快照的删法**：死入口的探针与 baseline 条目**一并删**（删除即迁移），不是标记为 skip——留着死探针等于把退役面继续钉活。
- **未过门登记（§8「取不到就不假装」）**：本站（种子提案）模板**删除**不涉及新版本号、不产生「预期输出增量」，故 §8 的两条过门（语料回放、评审对照）都不适用，`prompt-bump -- check` 恒绿即为受控面证据。
- **遗留一处（本票明确改道）**：删 `sched2.setDayCutoff` 后，`src/engine/xp.ts::writeDayCutoff` 也无调用方，连同其单测一并删（`tests/day-cutoff.test.ts` 只留 `readDayCutoff`/`sumXp` 等日界特性测试）；日界此后只能手编 `state/learnhub.json` 的 `day_cutoff`，无编程写入面。
- **夹具与退役前 applySeed 的三处可核实偏差（如实登记，不改任何断言）**：① `draftCourse` 不落 `state/snapshots/`（旧 applySeed 的「快照」站会落版本 1），故经它建的课程后续 applyEdit 得到的快照版本从 2 变为 1；② 未显式声明 `basis` 的起点，`start_basis` 填 `'baseline'`（旧 `anchorFromSeed` 只收显式声明项）；③ `origin_proposal` 硬编码 1（旧为真实提案 id）。三处只影响「快照版本/锚留痕」这类读数，本票受影响的既有断言不读它们；后续新增断言若依赖，按此处口径。

替代方案（否决）：

- **保留命令/路由、只删 UI**——死入口继续养（引擎方法、视图类型、快照条目、契约测试），问题没解决；与 ADR-0081 否决的「只删面板路由」同形。
- **让存量 `kind=seed` 提案判 Broken**——与 ADR-0004「合法读出的历史行不染红」冲突：退役一个新产通道，不该把存量 vault 的合法历史行判成损坏。
- **保留 `pair` 联合入口、只删 seed 产者**——联合 apply 的「先落种子再落计划」已无对象（没有命令能再产 seed 提案），保留的是死半区。

取号：0082（合入主检出时顺延：0080 为 #253 调试日志、0081 为 #255 doctor 并入）。票面：#256（父 #254）。
