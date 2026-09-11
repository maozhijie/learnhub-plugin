# 写入单元与原子写倒挂修正

数据面是**多处权威 + 约定协调**：每域各有正典（笔记 frontmatter＝调度事实源、`data/*.yaml`＝图事实源、沉淀正典＝参数事实源，另有题库／我的卡／错误卡／技能／习惯 YAML、课程注册表、笔记源清单），无事务管理器，跨文件一致靠 **32 处「同事务」注释** + 门禁 + 幂等重放（`applyEdit`／`applySeed`／`applyEnrich`／`nodeComplete`／`experimentStop`／`settleRechecks`／`optimizeFsrs` 等各处）。本 ADR 把「同事务」立成**一个极薄的写入单元**，并把落盘的持久性倒挂修正到「正典与状态同等」。**写入单元的抽象实现另开票；本 ADR 定边界，并裁定原子写倒挂修正这一低风险前置的范围。**

理由：32 处顺序约定**是领域知识、不是框架缺口**（哪一处先写、为何先写，只有该域说得清），所以写入单元**不接管排序**，只做三件事：按声明顺序执行、强制每步幂等（已存在即续段——这模式代码里已经在，只是散落在各自注释中）、末尾追加一条 journal。真正需要修的是**持久性倒挂**：`atomicWrite`（`engine/io.ts:10`，tmp + rename）24 个调用点**几乎全是 `state/*.json`**，而正典反而裸写——实测裸写 **48 处**（30 次 `writeFile`／`writeFileSync` + 15 次 `appendFile` + 宿主 3 处），其中 **11 个「按工件分家」的写入器写的是正典**。

最锋利的不是「正典没原子写」这句概括，而是两条具体事实：

1. **图 YAML 同一份正典有两条写路径、两种持久性**——`graph.ts:268`（`GraphStore.writeRegionDoc`，service `applyEdit`／`applySeed`）走**裸 `writeFile`**，而 `proposals.ts:1044`（`applyEnrich`）走 `atomicWrite`。同一份事实源，durability 取决于走哪个提案类型。
2. **`notes.saveNote`（`notes.ts:315`）非原子，且有 15 个调用点**（`content-subsystem.ts:237,892`、`notes.ts:326`、`content.ts:1287,1337,1734`、`engine/index.ts:497,1826`、`question-bank.ts:1414`、`proposals.ts:511,1086`、`projects.ts:327,336`、`sched-subsystem.ts:85,176`）——笔记 frontmatter 是**调度事实源**，单价最高。

另有 `sediment.ts:230-235` 手搓了一份 tmp + rename（`atomicWrite` 的重复实现，含自己的 `Date.now()` 取 tmp 名）与 **10 处**重复的 `mkdir`-before-write 惯用法（`io.ts:11`、`graph.ts:267`、`notes.ts:316`、`error-cards.ts:266`、`learner-cards.ts:221`、`question-bank.ts:301,320`、`content.ts:1313`、`content-subsystem.ts:181,234`）——而 `atomicWrite` 内部本就 mkdir。

关键裁决：

- **写入单元的边界**：一次操作把要落的多处收成**有序步骤列表**，按声明顺序执行，末尾追加一条 journal。它**只记录并强制「声明顺序＝执行顺序」**。不接管排序（顺序是领域知识）、不回滚、不做隔离。
- **明确不引 WAL／两阶段提交／事件溯源**：失败留下部分态，恢复走既有 `dataCheck`（只读体检）／`doctor`／`rebuild` 三条入口——这三条已经存在，部分态不是新引入的风险。
- **journal 不新开工件**：复用既有 `state/运行日志.md`（append + `LOG_LIMIT` 1500）与既有 JSONL 流水（review-log／practice／journal 等）作为 sink；写入单元**不引入新的日志文件**。
- **原子写倒挂修正的范围（广口径）**：**11 个正典写入器全部改走 `atomicWrite`**——图 region YAML、题库 YAML、我的卡／错误卡／技能／习惯 YAML、课程注册表 YAML、笔记源清单 YAML、笔记 frontmatter、提案工件、交互 HTML、队列 md、首启 config seed。**排除两类**：① **追加型**（JSONL 流水、运行日志 md、队列 md 的 append 段）——append 就是那里的正确原语，改成原子写反而破坏 append-only 的保序与追加语义；② **已原子的 `state/*.json`**（不动）。
- **第一刀是图 YAML 的双路径不一致**：让 `graph.ts:268` 与 `proposals.ts:1044` 走同一原语——同一份正典不该有两种 durability，且这是**教练层内部**的缺陷，可在顶层不变量门（ADR-0044）的白名单覆盖下独立修、独立验。
- **顺手消重**：删 `sediment.ts:230-235` 的手搓复制品（改调 `atomicWrite`）、消掉 10 处重复的 mkdir-before-write 惯用法。
- **单一原语，不新造**：沿用 `engine/io.ts:10` 的 `atomicWrite`（tmp + rename），不新增落盘原语。
- **`writeRegionDoc`（`graph.ts:266`）的 public 面是否收窄**（ADR-0044 登记的第一处不变量松动）**在本 ADR 不作裁决**，随适配器／不变量票评估——本 ADR 只要求它**原子**。
- **行为保持**：710 个既有测试断言的是工件**内容**、不是写入机制，所以本修正是纯行为保持，可独立提交、独立回滚。

边界：

- **写入单元的抽象实现另开票**；本窗只做原子写倒挂修正这一低风险前置（#165 已如此裁定）。
- **append-only 语义不动**：流水与日志保持 append。
- `src/index.ts:1964-1965` 的 `mkdirSync`／`writeFileSync`（首启 seed `learnhub.json`）是 bootstrap 写，随宿主 runtime 票一并收进构造路径（见 ADR-0048），**不在上面 11 个写入器之内**。
- 不引入任何事务／日志框架；**不改任何正典的格式、路径与字段**。
- `atomicWrite` 的 tmp 命名（`` `${path}.tmp-${process.pid}-${Date.now()}` ``）含 `Date.now()`——时钟外移（ADR-0044）时属适配器关注点，本 ADR 不动它的行为。
- 幂等语义由**各域自己声明**（「已存在即续段」的具体判据因域而异）；写入单元只强制「声明了就要幂等」，不得替域推断。

替代方案（否决）：

- **全口径（48 处全改）**——含把 append 也改成原子写重写：会破坏 append-only 的保序与追加语义（流水与日志正靠 append），且把「正典 vs 状态」这条真实分界糊成「所有写」，反而失去判据。
- **窄口径（只改 frontmatter／`data/*.yaml`／题库 YAML／笔记源清单 4 类，贴 #165 正文的 Implementation Decisions）**——留下 7 个正典写入器仍裸写，**且不修图 YAML 的双路径不一致**（`applyEdit`／`applySeed` 仍非原子）——最锋利的那一处恰好落在窄口径之外。说明：#165 正文的用户故事 30 写「**所有**落盘走同一原语」，与同篇 Implementation Decisions 的 4 类口径不一致；本 ADR 取**广口径 + 显式排除 append** 作为最终口径。
- **引通用工作流／事件溯源框架**——见 ADR-0044「三件不要做」第一条；框架会要求把领域顺序重表达成配置，收益为负。
- **写入单元接管排序**（把顺序变成框架配置或自动推导）——32 处顺序是领域知识，重表达一遍只会把知识搬进配置并失去邻接可读性；写入单元的价值在**强制**，不在推导。
- **写入单元做回滚／快照**——回滚需要撤销日志或全量快照，成本跳一个量级，而既有 `dataCheck`／`doctor`／`rebuild` 已给出恢复路径；在这个单用户本地系统里，部分态不是需要事务化消除的风险。
- **先建写入单元，再回头修原子写**——顺序反了：原子写修正是纯行为保持、可独立回滚的低风险前置，而写入单元的抽象要先有边界才能定；先修倒挂能在抽象定稿前就把最脆的正典保护起来。

**落地补记（#176，2026-09-11）**：原语落 `engine/write-unit.ts`（`runWriteUnit`），七处候选全部迁移（无降级出局；今天语义对照表落 #176 票评论）。三处本 ADR 留白的形状裁定：① 步骤体 = `{ name, run, done? }`——`done` 是域自声明的幂等判据（true 即续段跳过），原语只强制「声明了就检查」，不替域推断；② journal sink 取本 ADR 并列两支中的**既有 `state/journal.jsonl`**（`kind='write_unit'`，ts 经 Clock 端口）而非 `运行日志.md`——后者是宿主工具调用观测面（LOG_LIMIT 截断在宿主 runLog），引擎写它会混淆观测语义且引擎侧无 append 原语（等 vault 存储端口）；已有域语义 journal（graph_edit 等）原样保留，单元条目是额外的清单行；③ 失败 = 上抛中止，不回滚不续跑、失败不写 journal——与迁移前七处的逐条语义对齐（重放不收敛的 applyEdit/applySeed 靠门拦，不靠续段；「账本已决、沉淀未落」等既有部分态窗口照迁并登记）。顺序知识随迁移从「同事务」注释转为步骤声明（G9 门执法：src/ 零残留 + 七站点必须经原语）。
