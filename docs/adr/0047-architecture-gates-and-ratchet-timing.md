# 架构门清单、阈值来源与棘轮时序

#165 把三类架构债（子系统依赖面没有约束也没有测量、宿主零测试无法抽层、没有类型门）变成**会失败的东西**：门清单 + 阈值 + 棘轮机制。本 ADR 定门的清单、每条阈值的来源、棘轮的刚性，以及**时序**——顶层重划（ADR-0044／0045／0046）落地前，门**只作棘轮**（冻结现状、只许降不许升），不收紧到目标值。

理由：「架构约定只有跑进 `npm test` 才算存在」是 ADR-0042 的结论，而**门的形状比门的数量重要**——已有的两条教训都指向形状。① **R3 曾恒过**：规则写了，但收集器只收相对说明符，于是从未触发——一个恒过的门比没有门更坏，它给出虚假的安全感。② **宿主抽离漏 14 个标识符**（host 模块没 export、宿主没回引）时，707 个测试全绿、`npm run build` 通过（esbuild 只剥类型）、`node --check` 只验语法——**只有运行时才会炸**。所以本 ADR 规定三件事：**所有门零依赖**（文本／加载／编译层面、`node:test` 原生、随 `npm test` 全量执行；ADR-0042 已否决为静态规则引 eslint／dependency-cruiser）；**每个门必须带自检**（构造一个必然违规的样本、断言门会失败；收集器类门另需断言它能看见目标形态，如裸包名／作用域包名）；**阈值必须是实测数字**，来源写进 ADR 与票面，调整需有据。

关键裁决：

- **门清单与档位**（硬门＝零容忍；棘轮＝不高于基线）：

| 门 | 内容 | 档位 | 落笔时的实测值 |
|---|---|---|---|
| **G1** 未定义标识符 | 剥注释与字符串后，「被当函数调用却未声明未导入」即失败（`scripts/undefined-scan.mjs`，已落地） | **硬门** | **0**（`shuffled` 修复后）。tsc 落地后由 TS2304 接管、本门退役 |
| **G2／G2b** 宿主装配面 | 动态 import `src/index.ts` 与 `host/*`；入口三件套齐备、技术层导出在、入口文件非空（已落地） | **硬门** | 绿。**G2 的加载冒烟不可退役**——tsc 看不见模块级初始化路径 |
| **G2c** 宿主模块级可变状态 | 宿主受控面（`src/index.ts` + `src/host/**/*.ts`，**动态发现**）除常量外零模块级 `let`；带自检（行首 `let` 被抓／缩进 `let` 不误伤）与面塌断言（#167 落地，ADR-0048） | **硬门** | **0**（8 处可变态收进 `HostRuntime`）。受控面 8 个文件 |
| **顶层不变量** | 只有教练层能调用图写原语；白名单＝`proposals.ts` | **硬门** | **绿**（`writeRegionDoc` 的唯一调用者就是 `proposals.ts`） |
| **窄面三向一致** | deps 声明 ↔ 类体 `this.e.X` 实用 ↔ 门面 `new XSubsystem({...})` 提供的键，任一方向多出或缺失即失败 | **缺件方向（dead／missing／unwired）硬门 0**；**多余接线棘轮，基线 30**（其中 **10 条 phantom**） | 声明 **167** ／ 接线 **197** ／ **多余 30**。清理后转硬门 0 |
| **窄面宽度** | 按三槽位卡上限（**顶层成员计，嵌套子面不计**） | **棘轮**；声明预算 `handles ≤12 / facade ≤20 / fns ≤10` 是**非活动目标** | 实测最大 handles **9**／facade **20**／fns **1**（对预算已绿；facade 已触上限、无余量）。活动门＝逐子系统实测基线 |
| **文件规模** | `src/`（`.ts`／`.tsx`）逐文件行数；目标 `src/engine/*.ts` ≤600 行、宿主单文件 ≤900 行；白名单 `engine/views/` 叶子（类型面）、`engine/types.ts`（共享类型与枚举大表） | **棘轮**；600／900 是**非活动目标** | **不可作活动阈值**：8 个 engine 文件全超 600（content 1809／question-bank 1480／projects 1415／proposals 1356／learner-cards 1325／note-source 1237／content-subsystem 1023／growth-subsystem 979），宿主 `index.ts` 3029 超 900。活动门＝逐文件基线（冻结在现状不涨；受控面 78 个文件） |
| **类型门** | `tsc --noEmit` 按**文件**错误数棘轮；`strict:false`（`noImplicitAny:false`）起步 | **棘轮** | `src/` **204**（宽松）／**218**（严格）。tsconfig + devDep + `typecheck` 脚本另开票 |

- **落地实测（#166，2026-09-11；门已进 `npm test`）**：脚本 `scripts/scan-deps-face.mjs`（G3／G4）、`scripts/scan-budget.mjs`（G5）、`scripts/scan-invariant.mjs`（G6），基线 `scripts/arch-baseline.json` + `scripts/arch-baseline.mjs`，门体 `tests/arch-guards.test.ts`。实测把本 ADR 落笔时的两处口径修正到可实现值：① 接线总数 **197**（原文 188 系早期手数口径的偏差；多余 30 ／ phantom 10 两项不变，与本 ADR 的清单逐条吻合）；② 宽度实测最大 **9／20／1**（原文 ≈10／≈14／≤3 是手数，且「facade ≈14」恰等于 content 20 个回引方法里的 14 个 private——按本 ADR 的槽位定义（门面方法与回引，不区分 public／private）应为 20；**facade 预算 ≤20 已触上限、无余量**，这正是接缝三槽位票要解决的问题）。槽位归属规则与「嵌套子面不计」的判据写在 `scripts/scan-deps-face.mjs` 头注释里。
- **G3 的第三方向已实现**（本 ADR 落笔时是缺口）：门面 `new XSubsystem({...})` 的接线键现在参与比对，只取 **brace-depth-1** 键；`unwired`（声明了但门面没接线）作为第三个缺件方向一并进硬门 0。
- **G2c 的落地形态（#167，2026-09-11）**：受控面**动态发现**（`src/index.ts` + `src/host/**/*.ts`），测量在 `scripts/scan-host-state.mjs`——硬编码文件清单会在 `src/host/` 新增文件时静默放过，正是 R3「收集器收空」的同族缺陷。两条自检按本 ADR 的「门的自检不止违规会失败」写：① 自检**驱动门自己用的纯判据**（`moduleLevelLets`：行首 `let` 被抓、缩进 `let` 不误伤、`const` 放行），不自写第二份正则——否则门腐烂而自检照绿；② 面塌断言（受控文件数 ≥6 且必含 `index.ts`／`host/runtime.ts`）。落地实测：受控面 **8** 个文件、模块级 `let` **0**（`src/index.ts` 3029 → 71 行；`host/` 五文件 + 既有 `http.ts`／`llm.ts`）。

- **棘轮机制（刚性）**：一份仓内基线文件记录每个受控量的实测值；门要求**实际 == 基线**——涨了失败，**降了但未同步下调基线也失败**（**过期即失败**）。基线只在清理提交里下调。理由：单侧棘轮（只拦上涨）的基线会沉淀成**永久余量**、逐条恒过，与 R3 恒过的教训同构；精确匹配是唯一不会腐烂的形状，而代价只是每次清理顺手改一行。**落地形态**：`scripts/arch-baseline.json`（受控量：逐子系统 声明／实用／接线数、三槽位计数、多余接线集、phantom 集、逐文件行数）＋ `scripts/arch-baseline.mjs`（比较与重写；`--update` 只在清理提交里用）。三个**缺件**方向（dead／missing／unwired）不进基线：它们是装配断裂而非可棘轮化的债，由 G3 直接卡 0。
- **窄面三向一致门补第三方向时的判据（#166 已落地，留作教训）**：落地前 `scripts/scan-deps-face.mjs` **退出 0**——它只比了「deps 声明 ↔ 类体实用」两个方向（两者今天都是 0），而**第三个方向（门面接线提供的键）**对 **30 条多余接线与其中的 10 条 phantom 完全不可见**。补该方向时**只取接线字面量的 brace-depth-1 键**：`ChannelsSubsystem` 的接线里 `registry: { load, loadNoteSources, save, get }` 是**嵌套窄子面**（`ChannelsDeps` 正以结构化窄面声明它），按扁平正则抽取会把子面成员误计为顶层接线——实测会伪造出 4 条不存在的 phantom。这条同样适用于宽度门的「嵌套子面不计」。**自检锁死**：夹具含嵌套子面 + 一条多余接线，断言接线键恰 5 个、phantom 恰 1 条，并先断言「扁平抽取确实会误取子面成员」（否则该自检没在测东西）。
- **10 条 phantom 的清单（供清理票验收）**：全在 `growth-subsystem.ts` 的门面接线（`engine/index.ts:390` 起）——`coachFrontier`、`compassEtaFold`、`growthGraphView`、`growthTallies`、`invokesResolver`、`parseGrowthVerdict`、`probationFrame`、`pruneProbationNode`、`recheckMetricOf`、`recordRecheckOutcome`。它们的 `this.X` 在门面上不存在，**且子系统也从不使用这些键**（所以 710 个测试全绿、也不会在运行时炸）——它们是纯粹的死接线。类型门会把这 10 条报成 TS2339（属性不存在），它们**同时是类型门第二阶段的首批清理对象**。
- **另 20 条多余接线（门面上存在、子系统从不使用）**：content 9 条（`judgeBankAnswer`／`logGradingFailure`／`nodeNote`／`questionContext`／`questionView`／`refreshRepCard`／`resolveNote`／`saveNodeNote`／`vaultPriorFor`）、growth 5 条（`coachCheckFor`／`coachContextPack`／`compassRead`／`compassTail`／`probationViewFor`）、learner 1（`scanCourseBanks`）、project 1（`refreshSourceFingerprints`）、bank 1（`content`）、sched 3（`sedimentAppend`／`sedimentFold`／`sedimentRebuildProfile`）。
- **每条阈值都进 ADR 与票面并标注来源**：三向基线 30／10、宽度实测 9／20／1、规模逐文件基线——全部来自本 ADR 落笔与 #166 落地时的实测量（口径修正见上条）。**#165 正文的门段写「当前会报 32 条多余接线」，实测为 30 条多余／10 条 phantom**；「10 条指向不存在的方法」实测成立。#165 正文另一处「本轮已清掉 31 个死成员」对应的是 **dead 方向（声明未用）**，实测已归 0——两个方向不要混。
- **时序（与顶层重划的关系）**：① 止血门先行（G1、G2、顶层不变量、三向、宽度、规模）→ ② 宿主 runtime → ③ 接缝三槽位 → ④ 收紧阈值。**顶层重划落地前，门只降不升。**
- **与顶层重划冲突的门 → 记入 ADR 并标注「重划后重推阈值」，不就地改阈值**。已知需重推的项：**文件规模**（重划会改文件归属）、**窄面宽度**（三槽位分组会改成员的槽位归属）、**窄面三向**（子系统边界可能变）。600／900／12／20／10 因此在本 ADR 里**只是目标与记录，不是活动阈值**——用旧形状的阈值去绑定新边界，正是 #165 顶层判断要避免的事。
- **不做「零死导出」门**：实测零引用导出 **0 条**（`sessions.ts::nodeLink` 是零引用**方法**、非导出，可随手清），此面无需门。
- **类型门的阶段**：① `src/` 基线建档并进门（允许存量错）→ ② 清**接线类**错误（未定义引用、字段声明丢失、指向不存在方法的接线——**上述 10 条 phantom 是真缺陷，优先**）→ ③ 基线压到 0 并转 `strict: true` → ④ 收纳 `tests/`、评估 `ui/`。错误集中的文件：`engine/index.ts` 56、`src/index.ts` 27、`question-bank.ts` 27、`content-subsystem.ts` 27、`views.ts` 19；错误码 top：TS2304 41（真缺陷）、TS2341 32（private 访问，设计信号）、TS2339 21（丢字段声明）、TS2322 21、TS2305 20（type-only 缺口）、TS18046 20、TS2345 19。

边界：

- **门的实现落点**：规则族进 `tests/import-rules.test.ts`（R1–R7，已有）与 `tests/arch-guards.test.ts`（G1／G2／G2b／**G3 三向／G4 宽度／G5 规模／G6 不变量**，#166 已齐）；测量在 `scripts/scan-deps-face.mjs`／`scan-budget.mjs`／`scan-invariant.mjs`，基线在 `scripts/arch-baseline.json`，`tests/README.md` 架构门段同步登记（#165 纪律：接缝与 `tests/README` 同步）。**每门带自检**（构造必然违规样本 → 断言门会失败；收集器类门另断言能看见目标形态）。
- **不为门引入任何依赖**：不引 eslint／dependency-cruiser／prettier／zod（ADR-0042 替代方案段已否决）。
- **`tests/` 与 `ui/` 的类型面不在类型门首期扫描面**（各自配置另开步）；`ui/` 有自己的 tsconfig 与 vite 构建。
- 不设「零死导出」门（实测无债）。
- 本 ADR 不裁宿主 runtime 的设计（见 ADR-0048），只裁门的清单与刚性。
- 基线文件本身需要**自检**：门要断言「基线里的每一项都对应一个受控对象」（防止删除对象后基线条目变成永不复位的幽灵条目）。已落地：子系统条目、受控文件条目、规模白名单条目三类各有自检。
- **门的自检不止「违规会失败」**：收集器类门还要断言**扫描面没塌**（如 G3 断言收集到的 `XDeps` 集合与基线一致、G5 断言受控文件数 > 50）——R3 恒过的根因正是收集器静默收空。

替代方案（否决）：

- **单侧棘轮**（只在实际 > 基线时失败）——省事，但基线会沉淀成永久余量、逐条恒过；与 R3 恒过的教训同构。这是本 ADR 最核心的否决。
- **两套机制**（声明预算冻结成不可变的硬上限 + 独立基线文件只许降）——多一套机制、收益与「基线只许降且过期即失败」完全相同，还给「预算与基线谁先失效」留下解释空间。
- **无自检的门**——恒过比没有门更坏（虚假的安全感）；自检是门的一部分，不是可选项。
- **把 600／900／12／20／10 直接当活动阈值**——今天会立刻全红（8 个 engine 文件 + 宿主都超），与「门要先行且全绿」相抵，也会用旧形状的阈值去绑定新边界。
- **重划落地后一次性收紧所有阈值**——涨落会跨多个票同时到期，无法归因到具体改动；逐文件基线 + 过期即失败能让每次下调都落在产生它的那次清理里。
- **用聚合值（如「engine 总行数」）代替逐文件基线**——一个文件长、另一个文件缩就相互抵消，看不见病灶；#165 的门清单本就是按文件与按子系统下的。
