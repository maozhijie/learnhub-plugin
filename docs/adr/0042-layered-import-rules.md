# 分层依赖规则成文与零依赖执法（import 规则测试）

引擎与宿主的分层事实上成立（host→门面→engine 领域模块、engine 零宿主依赖、运行时零循环依赖）但从未成文，D14「一切数据访问收口门面」只活在 engine/index.ts 头注释里，无任何执法：宿主曾有三处绕门面深导入（llm 缝型、Content、Anki 传输常量、complexity 档位），engine 内部还有真实存在的 import 环。本 ADR 把分层规则写成七条可判定的检查，落 `tests/import-rules.test.ts`（node:test 原生、零新依赖、随 `npm test` 每次全量执行）持续执法——巨型文件回落是 #152 的验收信号，可执法的子系统边界才是病根本治。

理由：分层一旦无执法，每张新票都在无感地测试它的边界（宿主深导入是方便捷径，类型环是顺手 import）；规则只有跑进测试才算存在，写进 ADR 的纯约定已被现状证伪。执法机制刻意选了最重的依赖——零：node:test 行级收集相对导入（静态、import type、侧效、export … from、动态 import()）加 DFS 无环检查，覆盖面大于 eslint-boundaries / dependency-cruiser 的最小可用配置，且不引入任何工具链。

关键裁决：
- **七条规则**：R1 host（src/index.ts）的 engine 相对导入只准解析到 engine/index.ts；R2 engine 禁 import 宿主；R3 engine 禁 import `@deepseek-ai/*`（缝型自带，llm/transport 由宿主注入）；R4 views.ts 全部 import 必须是 `import type`（views 纯类型投影）；R5 io.ts 零相对导入（零领域依赖叶子，只准 node 内置与 npm 包）；R6 engine 内零文件 import engine/index.ts（门面是唯一汇点，子系统不回引门面——跨子系统调用经门面传 `Pick<LearnhubEngine,…>` 收窄类型，不建横向依赖网）；R7 src 相对 import 全图零环（含 type-only 边与动态导入边）。
- **环的实测与解法**（票面勘误）：票面 assumed 全图唯一环是 receipts⇄store 纯类型环；执法测试落地的首轮扫描实测出三条环（srs⇄经 sediment/kata⇄回 srs 的三个变体），全部共享 sediment→kata 一条边——sediment 只为拿 `weekStartOf` 回引复盘层。处置两条：receipts 改用本地结构化窄面 `ReceiptStore`（只认 `receiptsAll`/`appendReceipt`，engine.store 结构化满足，store→receipts 单向类型依赖成立）；周折叠函数族（weekStartOf/weekEndOf/prevWeekStartOf/inWeek）归位 dates.ts——纯日历语义住日历模块，kata 原路径 re-export 保住 S45 接缝（tests 与门面仍从 kata 导入）。
- **store 拆 io**：atomicWrite / readLearnhubConfig / writeLearnhubConfig / readJsonlLines 是通用 IO 原语，迁往 io.ts 叶子——graph.ts 这类低层结构模块此前为拿 atomicWrite 反向依赖存储层，改引 io 后倒挂解除；store 保留 netPracticeRecs（勘误域逻辑）与全部领域存储职责。
- **宿主收口与 re-export 门语义**：宿主深导入（Content、ANKI_ENDPOINT/AnkiConnectClient、TIER_LABELS/tierIdxOf/genericQuizTarget、LlmComplete/LlmEffort 型）改从 engine/index.ts 取，门面以 re-export 门供应；门只供应纯函数、常量与缝型——数据访问仍只走门面方法，门不是数据旁路，D14 字面不动。

边界：
- tests/ 直 import 引擎模块（`../src/engine/*.ts`）是 ADR-0013 的文档化测试缝，不在规则域；规则扫描面只覆盖 src/。
- ui/ 跨包 `import type` views 不在规则域（R4 只约束 views.ts 自身的导入形态）。
- src 根的 tool-contracts.ts / generation-jobs.ts 是宿主侧模块：R1 只约束 host 对 engine 的导入形态，宿主内部组织归 #152 刀 12。
- engine 对 `../../shared/`（仓库级共享渲染器）的导入合法，规则只记账不禁止。

替代方案（否决）：
- eslint-boundaries / dependency-cruiser——为七条静态规则引入两个工具链与配置面，杀鸡用牛刀；node:test 原生实现零依赖且随全量测试必跑。
- 纯约定（成文但不执法）——D14 现状即反例：写在头注释里的纪律照样长出三处深导入与三条环。
- mixin 拼装 / 解散门面——#152 主刀已裁决聚合+转发模式，本 ADR 只固守其导入面前提。
