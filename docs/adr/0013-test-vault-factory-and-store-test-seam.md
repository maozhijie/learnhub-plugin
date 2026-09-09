# 测试缝定版：`engine.store` 是正式测试缝，配共享 vault 测试工厂；TestProbe 镜像与 store 私有化否决

决议（2026-09-09，架构深潜候选 3 收敛）：**D14「一切数据访问收口 engine 门面」是运行时纪律**——约束工具面、HTTP 路由与 UI，不得绕过引擎直写数据文件。测试侧的播种与断言走**类型化的 `engine.store`**，这是正式的、文档化的测试缝（见 tests/README），不是需要封死的后门。同时把 21 个测试文件手抄的 vault 脚手架（REGISTRY/GRAPH/NOTE YAML、`withVault` 的 8 种参数形状、`tfQuestion` 的 7 种签名变体）收敛为 `tests/helpers/vault.ts` 一个声明式工厂（默认基线 + options 覆盖 + root 逃生口）。

**为什么不建 TestProbe（门面上的播种/断言词汇层）**：删除测试不过关——Store 已是带真实类型的种子/断言面（测试实际使用其中 11 个方法：`reviewLogAll`/`practiceAll`/`appendPractice` 等），Probe 只能是 Store 的镜像 pass-through，删掉它复杂度不会在任何调用方重现；「一个 adapter 意味着假想 seam」。把 `store` 转私有的唯一效果是逼出这个镜像 module：负价值。未来架构扫描勿再提议。

**运行时零消费者佐证**：宿主（src/index.ts）、客户端与 UI 均不触 `engine.store`（2026-09-09 全仓核查），「测试专用」不是意图而是事实，此处只把它升格为文档化契约。

**工厂形状**：声明式 options（默认 = 全仓 20 个文件逐字相同的单课程/单节基线，可选项覆盖课程/图/笔记/题库/state 种子），重载荷场景（Anki 假传输器、笔记源中心外文件、data-check 故意损坏档、gen-proposal 空 vault）暴露 `root` 逃生口自行写文件——不造「什么都能配」的大 interface。`tfQuestion`/`note`/`answer` 三个漂移最重的 helpers 一并提升共享；`rec()` 构造器各文件语义不同，留本地。工厂住 `tests/helpers/`（无第二个消费者，不随引擎发版），一次性迁移全部 `withVault` 文件，`npm test` 全绿兜底。
