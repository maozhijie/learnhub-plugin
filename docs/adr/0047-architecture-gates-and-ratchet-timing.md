# 架构门清单、阈值来源与棘轮时序

#165 把三类架构债（子系统依赖面没有约束也没有测量、宿主零测试无法抽层、没有类型门）变成**会失败的东西**：门清单 + 阈值 + 棘轮机制。本 ADR 定门的清单、每条阈值的来源、棘轮的刚性，以及**时序**——顶层重划（ADR-0044／0045／0046）落地前，门**只作棘轮**（冻结现状、只许降不许升），不收紧到目标值。

理由：「架构约定只有跑进 `npm test` 才算存在」是 ADR-0042 的结论，而**门的形状比门的数量重要**——已有的两条教训都指向形状。① **R3 曾恒过**：规则写了，但收集器只收相对说明符，于是从未触发——一个恒过的门比没有门更坏，它给出虚假的安全感。② **宿主抽离漏 14 个标识符**（host 模块没 export、宿主没回引）时，707 个测试全绿、`npm run build` 通过（esbuild 只剥类型）、`node --check` 只验语法——**只有运行时才会炸**。所以本 ADR 规定三件事：**所有门零依赖**（文本／加载／编译层面、`node:test` 原生、随 `npm test` 全量执行；ADR-0042 已否决为静态规则引 eslint／dependency-cruiser）；**每个门必须带自检**（构造一个必然违规的样本、断言门会失败；收集器类门另需断言它能看见目标形态，如裸包名／作用域包名）；**阈值必须是实测数字**，来源写进 ADR 与票面，调整需有据。

关键裁决：

- **门清单与档位**（硬门＝零容忍；棘轮＝不高于基线）：

| 门 | 内容 | 档位 | 落笔时的实测值 |
|---|---|---|---|
| **G1** 未定义标识符 | 剥注释与字符串后，「被当函数调用却未声明未导入」即失败（`scripts/undefined-scan.mjs`，已落地） | **硬门** | **0**（`shuffled` 修复后）。**#170 起由 G7 的 TS2304 接管**（同一形态的编译期权威判据，且能看见类型位置——G1 只看「当函数调用」），本门保留作零依赖兜底 |
| **G2／G2b** 宿主装配面 | 动态 import `src/index.ts` 与 `host/*`；入口三件套齐备、技术层导出在、入口文件非空（已落地） | **硬门** | 绿。**G2 的加载冒烟不可退役**——tsc 看不见模块级初始化路径 |
| **G2c** 宿主模块级可变状态 | 宿主受控面（`src/index.ts` + `src/host/**/*.ts`，**动态发现**）除常量外零模块级 `let`；带自检（行首 `let` 被抓／缩进 `let` 不误伤）与面塌断言（#167 落地，ADR-0048） | **硬门** | **0**（8 处可变态收进 `HostRuntime`）。受控面 8 个文件 |
| **顶层不变量** | 只有教练层能调用图写原语；白名单＝`proposals.ts` | **硬门** | **绿**（`writeRegionDoc` 的唯一调用者就是 `proposals.ts`） |
| **窄面三向一致** | deps 声明 ↔ 类体 `this.e.X` 实用 ↔ 门面 `new XSubsystem({...})` 提供的键，任一方向多出或缺失即失败 | **四个方向全部硬门 0**（dead／missing／unwired／surplus） | 落笔 声明 **167** ／ 接线 **197** ／ **多余 30**（其中 **10 条 phantom**）；**#171 清理后** 声明 167 ／ 接线 **167** ／ 多余 **0**（见下「#171 落地实测」） |
| **窄面宽度** | 按三槽位卡上限（**顶层成员计，嵌套子面不计**） | **棘轮**；声明预算 `handles ≤12 / facade ≤20 / fns ≤10` 是**非活动目标** | 实测最大 handles **9**／facade **20**／fns **1**（对预算已绿；facade 已触上限、无余量）。活动门＝逐子系统实测基线 |
| **文件规模** | `src/`（`.ts`／`.tsx`）逐文件行数；目标 `src/engine/*.ts` ≤600 行、宿主单文件 ≤900 行；白名单 `engine/views/` 叶子（类型面）、`engine/types.ts`（共享类型与枚举大表） | **棘轮**；600／900 是**非活动目标** | **不可作活动阈值**：8 个 engine 文件全超 600（content 1809／question-bank 1480／projects 1415／proposals 1356／learner-cards 1325／note-source 1237／content-subsystem 1023／growth-subsystem 979）。宿主 `index.ts` 落笔 3029 → **#167 拆为薄入口（91 行，回到 900 目标内）**，但拆出的 `host/api.ts` **998** 与 `host/tools.ts` **1044** 接过超限项；活动门＝逐文件基线（冻结在现状不涨；受控面 83 个文件） |
| **类型门** | `tsc --noEmit` 按**文件**错误数棘轮；`strict:false`（`noImplicitAny:false`）起步 | **棘轮** | 落笔口径 `src/` **204**（宽松）／**218**（严格）；**#170 落地实测 80 处 / 9 个涉错文件**（见下「#170 落地实测」） |

- **落地实测（#166，2026-09-11；门已进 `npm test`）**：脚本 `scripts/scan-deps-face.mjs`（G3／G4）、`scripts/scan-budget.mjs`（G5）、`scripts/scan-invariant.mjs`（G6），基线 `scripts/arch-baseline.json` + `scripts/arch-baseline.mjs`，门体 `tests/arch-guards.test.ts`。实测把本 ADR 落笔时的两处口径修正到可实现值：① 接线总数 **197**（原文 188 系早期手数口径的偏差；多余 30 ／ phantom 10 两项不变，与本 ADR 的清单逐条吻合）；② 宽度实测最大 **9／20／1**（原文 ≈10／≈14／≤3 是手数，且「facade ≈14」恰等于 content 20 个回引方法里的 14 个 private——按本 ADR 的槽位定义（门面方法与回引，不区分 public／private）应为 20；**facade 预算 ≤20 已触上限、无余量**，这正是接缝三槽位票要解决的问题）。槽位归属规则与「嵌套子面不计」的判据写在 `scripts/scan-deps-face.mjs` 头注释里。
- **G3 的第三方向已实现**（本 ADR 落笔时是缺口）：门面 `new XSubsystem({...})` 的接线键现在参与比对，只取 **brace-depth-1** 键；`unwired`（声明了但门面没接线）作为第三个缺件方向一并进硬门 0。

- **G2c 的落地形态（#167，2026-09-11）**：受控面**动态发现**（`src/index.ts` + `src/host/**/*.ts`），测量在 `scripts/scan-host-state.mjs`——硬编码文件清单会在 `src/host/` 新增文件时静默放过，正是 R3「收集器收空」的同族缺陷。两条自检按本 ADR 的「门的自检不止违规会失败」写：① 自检**驱动门自己用的纯判据**（`moduleLevelLets`：行首 `let` 被抓、缩进 `let` 不误伤、`const` 放行），不自写第二份正则——否则门腐烂而自检照绿；② 面塌断言（受控文件数 ≥6 且必含 `index.ts`／`host/runtime.ts`）。落地实测：受控面 **8** 个文件、模块级 `let` **0**（`src/index.ts` 3029 → **91** 行；`host/` 五文件 + 既有 `http.ts`／`llm.ts`）。
- **#171 落地实测（2026-09-11）：30 条多余接线清零，surplus 由棘轮转硬门 0。** 实测与本 ADR 清单逐条吻合：growth 15（含全部 10 条 phantom）、content 9、sched 3、learner 1、project 1、bank 1。**20 条「门面上存在、子系统从不使用」的键逐条核对过消费面**——它们全是子系统**自己的同名方法**（`this.judgeBankAnswer`／`this.coachCheckFor` 一类），门面接线是纯冗余；删除只动接线键、门面方法与签名零改动，公共面（host／UI／测试调用点）零改动。`sessions.ts::nodeLink`（零引用方法）同批清除。机制侧：`surplus`／`phantom` 从 `FACE_LISTS` 基线段**移除**，并入 `assemblyViolations` 硬门——一个恒须为空的清单留在基线里只会沉淀成幽灵条目；「接了一条没声明的线」本该当场失败，不该走「顺手改基线」。自检改为断言「非空 surplus 必被硬门抓住」。
- **#170 落地实测（2026-09-11）：类型门 G7 进 `npm test`，三类接线错误清零。** 落笔口径的 204／218 与本 ADR 正文的错误码分布是**换档前的读数**；落地用 `typescript@5.9.3` + `@types/node@24.13.4`（**精确锁版本**：错误数随工具链漂移，换档必须与基线同提交）与 `module`/`moduleResolution` = `nodenext`（`views.ts` 的无扩展名 type import 因此报 TS2835，已补 `.ts`）。**实测链（同一份 tsconfig，逐文件错误数）**：main（未清理）**196 处 / 17 个涉错文件** → #171 清掉 30 条接线后 **181** → #170 收工 **80 处 / 9 个涉错文件**。清掉的 106 处都是真缺陷、不是噪音（同批修准窄面类型又新暴露 5 处净增，故 181−106+5=80）：
  - **TS2304 40 处**（未定义引用，全为抽离漏搬的**类型** import）：`learner-cards` 15、`projects` 8、`src/index.ts` 8（`llmCfg` 是个**值**——宿主的 LLM 配置常量根本没 import）、`views/*` 6、`note-source` 3。`projects.ts` 的两处 `LearnhubEngine['…']` 不能靠 import 修（会成环，破 R7），改从本模块的 deps／类派生（`ProjectDeps['loadView']`／`Projects['proposePlan']`）。
  - **TS2305 20 处 + TS2300 6 处**：`views/content.ts` **13 个视图类型声明在 #152 刀 8 的归档里丢了**（`LessonDoc`／`TreeDoc`／`ReviewCard`／`ErrorCardFace` 等：commit `3b95ab2` 从旧 `views.ts` 删掉 16 型、只搬了 3 型），而 barrel `views.ts` 与 `content-subsystem.ts` 仍在 import 它们——**UI（`ui/src/types.ts`）也还在消费这些名字**。这是一次类型面静默缺失：707 个测试全绿（类型在 strip 模式下整句擦除），只有 tsc 看得见。已按 #152 前的原文恢复进 `views/content.ts`。同批：`AlloKind`（`grading.ts` 自引 `types.ts` 的死 import，实际声明就在本文件）、`AdviceDismissRec`（真身在 `bank-advice.ts`）、`projects.ts` 里与 `project-decompile.ts` **逐字重复**的 `PlanItem` 声明（TS2440／TS2484）。
  - **TS2339 26 处**：两类都是真缺陷。① 窄面类型面向宽（`BankDeps.questionContext` 声明成 `Promise<Record<string, unknown>>`，消费侧 18 处 `.kind`／`.q`／`.options` 全落 `unknown`）；② **联合收窄缺失**（`if (!x.ok)` 在 `strict: false` 下**不收窄**字面量真假分支——实测，`if (x.ok === false)` 才收窄），涉及 `graph-subsystem`／`projects`／`growth-subsystem`／`notes` 五处「成立时读失败分支字段」；③ 宿主 `ctx.webServer` 的类型不在册（服务由 dsh 的 web 插件提供、本仓库不依赖该包），按消费面在 `src/index.ts` 补 `declare module '@deepseek-ai/cordis'`（与 dsh-tools 给 `ctx.tools` 补声明同款，ADR-0013 结构化窄面）。
  - **同批被类型门逮到的运行时前兆**：`content-subsystem.ts` 把 `Content` 声明成 `import type` 却**当值用**（`Content.extractInteractive(...)`，TS1361）——strip 模式下这行 import 会被整句擦除，一调用就是 ReferenceError。修成值 import（该路径 `contentApply` 目前无调用点，属存量静默缺陷，已记在 #170 关闭评论里）。
  - **留在基线的存量债（阶段 ③ 的对象）**：TS2341 **32**（门面调用子系统的 private 方法——本 ADR 早已裁定是**设计信号**而非缺陷，随接缝三槽位票处理）、TS2322 26 ／ TS2345 7 ／ TS2740 5 ／ TS2739 3 ／ TS2367 2 ／ TS1016 2 ／ TS2352 1 ／ TS2741 1 ／ TS2559 1（多为同一「声明成 `Record<string, unknown>`」家族的残留，逐处修）。
- **棘轮机制（刚性）**：一份仓内基线文件记录每个受控量的实测值；门要求**实际 == 基线**——涨了失败，**降了但未同步下调基线也失败**（**过期即失败**）。基线只在清理提交里下调。理由：单侧棘轮（只拦上涨）的基线会沉淀成**永久余量**、逐条恒过，与 R3 恒过的教训同构；精确匹配是唯一不会腐烂的形状，而代价只是每次清理顺手改一行。**落地形态**：`scripts/arch-baseline.json`（受控量：逐子系统 声明／实用／接线数、三槽位计数、逐文件行数、**涉错文件的类型错误数**）＋ `scripts/arch-baseline.mjs`（比较与重写；`--update` 只在清理提交里用）。四个**装配**方向（dead／missing／unwired／surplus）不进基线：它们是装配断裂而非可棘轮化的债，由 G3 直接卡 0。
- **类型门的测量与自检（#170）**：测量在 `scripts/scan-types.mjs`——`tsc --noEmit --pretty false --listFiles` 一次调用同时取回**逐文件错误数**与**受控面文件集**（`checked`），门据此断言「`src/` 里每个 `.ts`／`.tsx` 都被 tsc 读到」（只看错误数分不清「干净」与「根本没扫」——R3 恒过的形状）；tsc 只报**无文件位置**的错误（tsconfig 写坏）时测量**抛错**而非静默返回空集。基线形状因此分两层：`measure()` = 纯文本受控量（depsFace／sizes，零子进程——G3／G5 那几条文本门不因同处一个基线模块而被迫依赖 tsc），`measureAll()` = 再加 `typeErrors`（CLI 的 `--json`／`--update`／全量对照用它）。TLA 教训：测量脚本**不得**反向 import 基线模块（会造成 ESM 循环 + 顶层 await 死锁），`--types` 入口因此开在 `arch-baseline.mjs` 一侧、且只跑 `scanTypes`。**四向装配判定与文案只有一处**（`scan-deps-face.mjs::faceViolations`，门与那里的 CLI 共用）。`npm test` = `npm run typecheck` + 全部测试；G7 在测试文件里再断言一次（单独 `node --test` 也拦得住），代价是 `npm test` 里 tsc 跑两次。

- **#168 落地实测（2026-09-11）：路由表数据化顺带把宿主单文件拉回目标内。** 规模：新增 `host/route-table.ts` 74／`host/routes.ts` 263／`host/routes-post.ts` 585／`host/params.ts` 152，`host/api.ts` **999 → 60**（分发）、`http.ts` 61 → 54（`need` 迁出）、`static.ts` 123 → 122；受控文件 **83 → 87**。**宿主单文件只剩 `host/tools.ts` 1040 超 900 目标**（其余 11 个 host 文件全在目标内）。类型门：**80 → 75 处 / 11 个涉错文件**（`api.ts` 的 7 处 `unknown` 传参被 `params.ts` 的守卫类型收口修好，2 处随守卫搬移进 `routes-post.ts`——`skillSetMaintenance` 的 `body.days ?? null` 与 `/node/pin` 的三元返回类型，两者都涉及今天的行为语义，**不在本票顺手改**）。本 ADR 落笔时写的「G5 的活动门＝逐文件基线」在 #168 得到一次正向使用：因为棘轮只许降不许升，路由表**没有**就地长在 `api.ts` 里，而是按表段拆文件——门真的改变了设计选择。回归网另加：125 条路由对账清单 + 464 条探针的 `{status, res, 引擎调用}` 行为快照（`tests/host-routes.test.ts`），把「逐字不变」从声明变成证据。
- **窄面三向一致门补第三方向时的判据（#166 已落地，留作教训）**：落地前 `scripts/scan-deps-face.mjs` **退出 0**——它只比了「deps 声明 ↔ 类体实用」两个方向（两者今天都是 0），而**第三个方向（门面接线提供的键）**对 **30 条多余接线与其中的 10 条 phantom 完全不可见**。补该方向时**只取接线字面量的 brace-depth-1 键**：`ChannelsSubsystem` 的接线里 `registry: { load, loadNoteSources, save, get }` 是**嵌套窄子面**（`ChannelsDeps` 正以结构化窄面声明它），按扁平正则抽取会把子面成员误计为顶层接线——实测会伪造出 4 条不存在的 phantom。这条同样适用于宽度门的「嵌套子面不计」。**自检锁死**：夹具含嵌套子面 + 一条多余接线，断言接线键恰 5 个、phantom 恰 1 条，并先断言「扁平抽取确实会误取子面成员」（否则该自检没在测东西）。
- **10 条 phantom 的清单（#171 已删除，留作验收对照）**：全在 `growth-subsystem.ts` 的门面接线（`engine/index.ts:390` 起）——`coachFrontier`、`compassEtaFold`、`growthGraphView`、`growthTallies`、`invokesResolver`、`parseGrowthVerdict`、`probationFrame`、`pruneProbationNode`、`recheckMetricOf`、`recordRecheckOutcome`。它们的 `this.X` 在门面上不存在，**且子系统也从不使用这些键**（所以 710 个测试全绿、也不会在运行时炸）——纯粹的死接线；类型门会把这 10 条报成 TS2339（属性不存在），#171 连同另 20 条一起删除（见「#171 落地实测」）。
- **另 20 条多余接线（门面上存在、子系统从不使用）**：content 9 条（`judgeBankAnswer`／`logGradingFailure`／`nodeNote`／`questionContext`／`questionView`／`refreshRepCard`／`resolveNote`／`saveNodeNote`／`vaultPriorFor`）、growth 5 条（`coachCheckFor`／`coachContextPack`／`compassRead`／`compassTail`／`probationViewFor`）、learner 1（`scanCourseBanks`）、project 1（`refreshSourceFingerprints`）、bank 1（`content`）、sched 3（`sedimentAppend`／`sedimentFold`／`sedimentRebuildProfile`）。
- **每条阈值都进 ADR 与票面并标注来源**：三向基线 30／10、宽度实测 9／20／1、规模逐文件基线——全部来自本 ADR 落笔与 #166 落地时的实测量（口径修正见上条）。**#165 正文的门段写「当前会报 32 条多余接线」，实测为 30 条多余／10 条 phantom**；「10 条指向不存在的方法」实测成立。#165 正文另一处「本轮已清掉 31 个死成员」对应的是 **dead 方向（声明未用）**，实测已归 0——两个方向不要混。
- **时序（与顶层重划的关系）**：① 止血门先行（G1、G2、顶层不变量、三向、宽度、规模）→ ② 宿主 runtime → ③ 接缝三槽位 → ④ 收紧阈值。**顶层重划落地前，门只降不升。**
- **与顶层重划冲突的门 → 记入 ADR 并标注「重划后重推阈值」，不就地改阈值**。已知需重推的项：**文件规模**（重划会改文件归属）、**窄面宽度**（三槽位分组会改成员的槽位归属）、**窄面三向**（子系统边界可能变）。600／900／12／20／10 因此在本 ADR 里**只是目标与记录，不是活动阈值**——用旧形状的阈值去绑定新边界，正是 #165 顶层判断要避免的事。
- **不做「零死导出」门**：实测零引用导出 **0 条**（`sessions.ts::nodeLink` 是零引用**方法**、非导出，**#171 已清除**），此面无需门。
- **类型门的阶段（① ② 已于 #170 落地，③ ④ 待开票）**：① `src/` 基线建档并进门（允许存量错）→ ② 清**接线类**错误（未定义引用、字段声明丢失、指向不存在方法的接线）→ ③ 基线压到 0 并转 `strict: true` → ④ 收纳 `tests/`、评估 `ui/`。② 的实际战果见上「#170 落地实测」（TS2304／TS2339／TS2305 全清，181 → 80 处）；③ 的对象是 TS2341 32（设计信号，随接缝三槽位票）与 TS2322 26／TS2345 7／TS2740 5／TS2739 3／TS2367 2／TS1016 2／TS2352 1／TS2741 1／TS2559 1 共 47 处。本 ADR 落笔时按文件与错误码的读数（`engine/index.ts` 56／`src/index.ts` 27／`question-bank.ts` 27／`content-subsystem.ts` 27／`views.ts` 19；TS2304 41／TS2341 32／TS2339 21／TS2322 21／TS2305 20／TS18046 20／TS2345 19）是**换档前**的口径：落地用 `typescript@5.9.3` + `nodenext` 后同一份源码报 **196 处**、且 TS18046（`unknown` 上的操作）在 `strict: false` 下不出现——阈值一律以落地实测为准。

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

## #169 落地实测（2026-09-12 补记，#184）

#169 四提交（`9dc977a` 注册表骨架／`3d15d3a` panel 切面／`e1c83d8` agent 切面／`451cc01` UI 同源）与本补记落笔间又叠了 #158、#159、#161、#178、#182、#185 六张票。本节是**现状陈述的登记处**，取代上文 #167／#168／#170／#171 各落地实测里的「现值」地位（那些原文作为历史记录一概不改写）；当前实测一律以 `scripts/arch-baseline.json` 与 `node scripts/arch-baseline.mjs` 输出为准（精确匹配棘轮，基线即现状的机器可读版）：

- **文件规模（G5）**：#168 拆出的 `routes.ts`／`routes-post.ts` 已被 #169 表生成路径**取代退役**（#168 节的「585／263」随之成为退役前读数）；`host/api.ts` 999 → 60（#168）→ **83**（#158/#159 增补分发）；`params.ts` 152（#168）→ **229**（#169 声明驱动取值迁入 + #185 fail loud 分支）；`route-table.ts` **74** 不变；`tools.ts` 1040 → **127**（#169 agent 切面，见 ADR-0045 §落地记录）→ **123**；`tool-handlers.ts` **268** 新增（#169 例外工具）；`jobs.ts` **820**。受控文件 **87**（#168）→ **103**。受控 engine 超 600 共 **12** 个（content 1812／proposals 1537／question-bank 1484／projects 1397／learner-cards 1337／note-source 1242／growth-subsystem 1049／content-subsystem 1026／data-check 815／index 787／nof1 785／sessions 630）——`engine/index.ts` 因 #182 门面纯转发收口 1803 → 787；宿主无文件超 900（最大 `jobs.ts` 820）。
- **类型门（G7）**：#168 收工的「75 处 / 11 个涉错文件」已被 **#178 四批清零**取代：批1 门面接线伸进子系统私有方法的 31 个 TS2341 放宽为公开面归零 → 批2 TS2322 全清（连带两处潜伏 bug）→ 批3 根 tsconfig 转 **`strict: true`**、strict 视图 24 处残差清零 → 批4 ui 依赖侧 86 处清零。**现值 0 处 / 0 个涉错文件，基线 `typeErrors` 空表**；#170 节的「80 处 / 9 个涉错文件」与 #168 节的「75/11」均为历史读数（三处数字的关系：#170 收工 80 → #168 搬移后 75 → #178 归 0，以基线为准）。UI 侧：`ui/src` 0 错、依赖侧存量债 **0 处**（#169 落地时为 58 → 0 + 依赖侧 186；#178 批4 把 86 处未使用类清零后报表转空——ADR-0045 §97 的「151 处」是更早的历史读数）。
- **窄面（G3／G4）**：#171 后的三向 167/167/0 → 现值 **186/186/186**（多余 0 维持；增量系 #158/#159/#161 新命令域的自然增长，基线同步）。宽度实测最大 **handles 11／facade 21／fns 0**（facade 已越 ≤20 非活动目标，活动门是逐子系统基线）。
- **G2c**：受控面 8 文件（#167）→ **14 文件**（动态发现随 `host/` 新文件增长）、模块级 `let` 维持 0。

## 修订（#158 落地，2026-09-12）：守卫消息契约的受控变更

本 ADR 与 ADR-0045/0048 落笔时把「参数守卫错误消息逐字不变」（`missing required field: <key>`）当作探针快照的证据契约。#158（面板说真话）以产品裁决**有意变更**了这条公共契约：守卫错误改中文并以 `ParamError` 类型抛出（`缺少必填参数：<key>`；枚举例外 `缺少或非法必填参数：<key>（允许：…）`），`handleApi` 统一 catch 追加 `（路由 <method> <route>）`——状态码语义（统一 500 出口）不变。按本 ADR「与既有门冲突要登记」的纪律登记如下：

- 变更范围：仅 `host/params.ts` 的消息模板与 `host/api.ts` 的 catch 组装；守卫语义唯一出处、可选参数「非法即当省略」的宽松语义、`sendJson` 调用点分布（200×(handlers+1)／404×4／500×1）全部不动。
- 迁移方式：探针快照 218 条守卫消息随同一提交机械迁移（脚本变换，非手抄）；`tests/host-routes.test.ts` 的消息形状门改为钉 `ParamError` 与中文模板。
- 证据契约的措辞从此是「响应形状与守卫消息**与基线一致**」——基线随每次有意的公共契约变更同提交迁移，而非永久冻结重构前字面量。

## 修订（#185 落地，2026-09-12）：可选参数收紧为 fail loud，取代上节「宽松语义不动」条款

上节「变更范围」里「可选参数『非法即当省略』的宽松语义全部不动」已被 #185 以产品裁决**有意变更**（ADR-0045 §修订）：`host/params.ts` 十个可选守卫改为「键在场但类型不符即抛 `ParamError`」。按本 ADR 纪律登记：

- 行为变更与受影响命令清单（47 条）登记在 ADR-0045 §#185 与 #185 票面；`GEN_JOB_PHASES` 命名统一（持久化值变更）同票落地，读侧别名迁移。
- 快照迁移（同提交）：路由探针 13 条 calls 变化（逐条人审均为 phase 值改名衍生，status 漂移 0）、工具面 0 变化；规模棘轮三处有因上调（generation-jobs 138→152／params 210→229／jobs 819→820），与本 ADR「涨了先看能不能不长」的裁断一并记录在票。
