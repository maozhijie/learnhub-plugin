# 门面子系统化：聚合+转发模式与分节对照表定稿

engine/index.ts（7,200+ 行、约 240 方法、52 个 `// ----` 分节）的拆分不解散门面、不 mixin 拼装：每个子系统以**类**的形式出生并**住进既有领主文件**（罗盘域住 compass.ts、lab 域住 nof1.ts……零文件搬移、接缝路径不晃），门面 `LearnhubEngine` 保留全部公共方法做一行转发。host 零改动，D14 字面不动——「一切数据访问收口门面」的语义在转发模式下原样成立。本 ADR 与首刀（刀 2 lab）同落，此后每刀一个子系统、`npm test` 全绿落一次提交。

理由：门面的价值是公共面的稳定（host/UI/tests 都只认它），病灶只是方法体堆积。聚合+转发让拆分成为纯机械搬移——签名不动、调用点不动、每刀可独立回滚；mixin 拼装把 240 方法摊进多个原型后门面只剩壳，类型面与跳转全部失焦；解散门面则要同步改全部消费方，违背增量纪律。

关键裁决：
- **子系统依赖 = 结构化窄面注入，不 import 门面**：子系统类构造收一个 `XDeps` 接口（住子系统文件内），只列本域消费的成员；门面构造尾部 `new XSubsystem({ store: this.store, sched: r => this.sched(r), … })` 显式接线。运行时是回引门面（跨子系统调用经门面，不建横向依赖网），类型面零门面导入——R6「engine 子模块不回引 engine/index.ts」字面成立，且私有方法（sched/learningDay）经箭头捕获注入，绕开 TS 私有成员不满足结构化面的限制。
- **子系统不引用 Store/领域类类型当 deps 成员类型，一律就地写成结构化窄面**（LabStore 先例）：store 等存储层反向 type-import 着各域的记录类型（ExperimentDef、ReceiptLogRec），子系统再 import 这些类类型就重造类型环——R7 在刀 2 首刀即拦截两例（store⇄nof1 两跳环）。
- **领域记录类型住中立词汇层**：store 反向依赖的类型（ExperimentDef、ReceiptLogRec 一类）归 types.ts 或收窄面消解；nof1.ts 原路径 re-export，既有导入路径不晃。
- **views 同步归档**：每刀把 views.ts 对应分区搬进 `views/<subsystem>.ts`，views.ts 保留 barrel（`export type { … } from './views/<subsystem>.ts'`，保持纯类型）；facade 与 ui 跨包的 `import type … from '…/views.ts'` 路径不变。
- **分节→子系统对照表**（52 节定稿；分节注释锚保留在门面作地标，行号随刀漂移）：
  - **lab**（住 nof1.ts）：D1 N-of-1、D2 恒温器、D3 沙盘、D4 睡眠配置
  - **channels**（住 note-source.ts）：C1 笔记复习源、卡池镜像、漂移治理、用户排除清单、C2 Anki 通道
  - **learner**（住 learner-cards.ts）：pin「今天学它」(E3)、JOL 抽查 (E4)、Self-Calibration、E5 可用的困难教练、E2 讲给我听、E1 我的卡、U 区技能与执行事件、U 区回执、U 区习惯、U4 周复盘
  - **project**（住 projects.ts）：项目域 P 区、过点对账/检索点/行为推断 enc、执行事件流 2×2、目标反编译
  - **bank**（住 question-bank.ts）：C-3 错误对比卡、学习面板题目管理、B2 难度感知回流、题库一键清理、瑕疵题勘误冲正
  - **graph**（住 graph-subsystem.ts——枢纽领主例外）：graph analyze、Vault 链接先验、图探索、提案门禁包装、enc 覆盖层回填
  - **content**（住 content-subsystem.ts——枢纽领主例外，content.ts 被 14 模块引用）：内容管线、note resolve/反馈区、P4 课程工作区与题库
  - **sched**（住 sched-subsystem.ts——枢纽领主例外，srs.ts 被 30 模块引用）：节点跳过/完成确认、XP 时间账本、记忆健康仪表盘、FSRS 参数优化器、沉淀层
  - **registry**（住 registry.ts）：概念注册表管理、课程删除清扫
  - **growth**（住 growth-subsystem.ts——枢纽领主例外，compass.ts 被 12 模块引用）：罗盘、教练回合感知面、生长批受理、边实验账本与复诊
  - **留门面（装配域，不设子系统）**：加载与解析、status/recommend、doctor、rebuild、生成任务持久化（宿主队列落盘臂）、utils 私有 helper 归位
- **门面验收形态**：纯转发 + 装配 + 私有 helper 归位；转发含少量私有（门面内部跨域调用点所用），同为逐行转发。
- **行数现实（刀 11 后实测）**：门面 1830 行中，198 个转发方法占 815 行（多行签名 + 类型标注，非每方法一行）——「≤800 行」的原估算假设一行一转发，签名展开后不可达。验收实质是**内容**而非行数：门面只剩转发 + 装配 + 装配域分节（加载解析/status/doctor/rebuild/生成任务持久化/utils），无领域方法体。
- **枢纽领主例外（刀 7 落地时补充，刀 8/9/11 沿用）**：领主文件被大量 engine 模块引用时（graph.ts 17 个、srs.ts 30 个、content.ts 14 个、compass.ts 12 个模块引用，含 type-only 边），把子系统类放进领主会迫使它反向依赖 proposals/projects/analysis/audit 等全部下游——结构化窄面得膨胀到四十余个成员，且每加一个纯函数都要过门面，反而模糊域边界。此类「枢纽领主」改用**同域新文件**承载子系统类（`graph-subsystem.ts` / `sched-subsystem.ts` / `content-subsystem.ts` / `growth-subsystem.ts`），该文件只被门面引用，可自由 import 领域模块；「零既有模块搬移、接缝路径不晃」的原则不变。判定线：领主文件的 importer ≥5 个 engine 模块即按枢纽处理（本域实测：lab→nof1.ts 3 个、channels→note-source.ts 4 个、bank→question-bank.ts 6 个仍住领主，graph 及以上全部走新文件）。

边界：
- 跨子系统调用一律经门面转发链（`this.e.<方法>` 注入窄面），子系统间零横向 import。
- views/ 子目录只做类型归档，视图聚合逻辑仍在（子系统方法内）；R4 只约束 views.ts 自身的导入形态（`import type` 且无值导出），views/*.ts 叶子文件不受此条约束（它们本就是类型层，须引 types/paths 等）。
- ADR-0013 测试缝（tests 直 import 引擎模块、engine.store）不受影响——子系统类的公共方法签名与领主文件纯函数面都原样保留。

替代方案（否决）：
- mixin 拼装（`class LearnhubEngine extends LabMixin…`）——公共面虽在，方法定义散进多原型，门面文件瘦了但类型跳转/调试栈/职责边界更糊；且 mixin 与窄面注入不兼容（mixin 需要 this 全型）。
- 解散门面、消费方直连子系统——违反增量纪律（一刀动全部消费方），D14 收口语义失锚。
- 子系统类 import 门面类型（`Pick<LearnhubEngine,…>`）——R6 字面即破，且门面类型是全型，收窄名存实亡；结构化窄面同等安全且可执法。

**与顶层分层及门时序的关系（ADR-0044 / ADR-0047 补记）**：本 ADR 的子系统（类 + 结构化窄面注入 + 门面聚合转发）是 ADR-0044 四层责任里**应用层**的内部组织形态——层级归属与形状都不改，聚合+转发模式不变。三条与门相关的补记：

① **窄面三向一致门的第三方向尚未实现**。现有 `scripts/scan-deps-face.mjs` 只比「deps 声明 ↔ 类体 `this.e.X` 实用」两个方向（实测两向今天都是 0：无死成员、无未声明使用，故工具**退出 0**），而**门面 `new XSubsystem({...})` 提供的键**这一方向缺失——实测多余接线 **30 条**（声明 167 / 接线 188），其中 **10 条 phantom**（`this.X` 在门面上不存在，全在 `growth-subsystem.ts` 的接线里）对它**完全不可见**。补该方向时必须**只取接线字面量的 brace-depth-1 键**：`ChannelsSubsystem` 的接线里 `registry: { load, loadNoteSources, save, get }` 是嵌套窄子面（`ChannelsDeps` 正以结构化窄面声明它），按扁平正则抽取会把子面成员误计为顶层接线——实测会伪造出 4 条不存在的 phantom。

② **窄面宽度的声明预算（handles ≤12 / facade ≤20 / fns ≤10）在顶层重划落地前是非活动目标**，活动门是逐子系统实测基线（实测最大 handles ≈10 / facade ≈14 / fns ≤3）。理由：三槽位分组会改成员的槽位归属，用旧形状的阈值绑定新边界正是要避免的事。

③ **枢纽领主判定线（领主文件 importer ≥5 个 engine 模块）与「零既有模块搬移、接缝路径不晃」原则不变**，但文件归属若因重划而变，规模与宽度阈值**需重推**（不是就地调）。

以上三条的机制细节、棘轮刚性与门清单见 ADR-0047。

