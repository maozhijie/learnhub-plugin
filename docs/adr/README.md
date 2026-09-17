# ADR 索引

架构决策记录（Architecture Decision Record）。**每条只记决策与理由，不是施工日志**——写作规范（该写什么、不该写什么、尺寸纪律）见 [`docs/agents/domain.md`](../agents/domain.md) 的「ADR 写作规范」段。

**当前最高号：0099。**编号是顺序号，取号前 `git fetch origin` + `ls docs/adr/`，取最大号 + 1，并在**同一次提交**里把新条目加进本表。并行会话撞号时**后落地者改号**并留取号说明（先例见 [ADR-0093](./0093-engine-domain-folders.md)）。

| 编号 | 标题 |
|---|---|
| [0001](./0001-practice-node-fsrs-compromise.md) | 实践节点不更新 FSRS：mastery 上限 0.3 的工程妥协 |
| [0002](./0002-relative-health-score-absolute-scale-floor.md) | 健康分保持纯相对指标，绝对规模走独立规模底线 |
| [0003](./0003-anchor-review-instead-of-per-batch-human-review.md) | 图谱生成期批次提案自动 apply，人审撤到骨架与交付两个锚点 |
| [0004](./0004-user-data-must-not-degrade-silently.md) | 用户数据区分缺失与损坏，判卷失败不伪造分数 |
| [0005](./0005-est-not-primary-for-content-scope.md) | est 不作内容规模主信号：复杂度档案（difficulty × bloom × 前置规模）接管生成预算 |
| [0006](./0006-review-vs-practice-rating-split.md) | 复习与练习的评分语义刻意分岔 |
| [0007](./0007-mastery-canonical-derived-not-persisted.md) | 掌握度口径收敛：派生值唯一 canonical，正确率不是掌握度 |
| [0008](./0008-enc-scheduling-semantics-and-coverage.md) | enc 承担调度语义：成分技能边从「仅内容/审计」升级为调度也消费 |
| [0009](./0009-arc-e-learner-output-boundary.md) | Arc E 学习者产出边界：过程资产与复习对象，不进 Mastery/XP/FSRS |
| [0010](./0010-c1-note-source-mirror-readonly.md) | C1 个人笔记复习源：只读镜像、零写用户笔记、漂移不判损坏 |
| [0011](./0011-c2-anki-channel-bidirectional.md) | C2 Anki 互通：双向但 Anki 是纯作答通道，vault 始终唯一调度者 |
| [0012](./0012-a2-memory-health-dashboard-and-param-optimizer.md) | A2 记忆健康：复习日志作地基，仪表盘四面板与 FSRS 参数优化器立项 |
| [0013](./0013-test-vault-factory-and-store-test-seam.md) | 测试缝定版：`engine.store` 是正式测试缝，配共享 vault 测试工厂；TestProbe 镜像与 store 私有化否决 |
| [0014](./0014-advance-module-single-guard.md) | 推进机械收口 advance 模块：guard 概念单点化，评分语义留在调用方 |
| [0015](./0015-project-first-class-sister-entity.md) | Project 一等实体：Course 的姊妹对象，非项目节点 |
| [0016](./0016-receipts-self-report-evidence.md) | 外部回执入练习证据通道：自报即可信，证据不是内容 |
| [0017](./0017-habit-first-class-no-fsrs-semantics.md) | Habit 一等实体：执行意图 + 自动化曲线 + 宽容 streak，零 FSRS 语义 |
| [0018](./0018-execution-event-fsrs-reuse-boundary.md) | 执行事件调度通道：FSRS 数学复用边界 |
| [0019](./0019-execution-event-xp-duration-credibility.md) | 执行事件入 XP：时长可信性判据 |
| [0020](./0020-configurable-day-cutoff.md) | 日界可配置：学习日口径取代午夜切日 |
| [0021](./0021-learner-cards-join-review-queue-unbound-xp.md) | 学习者产出卡汇入复习队列：呈现统一、账本分家（无绑定 XP） |
| [0022](./0022-self-calibration-profile.md) | 自评校准画像：跨源「直觉 vs 实际」基础设施，收窄为分源自省面 |
| [0023](./0023-n-of-1-experiment.md) | N-of-1 实验：单主体内随机化，只动内容参数不动调度核心 |
| [0024](./0024-challenge-point-thermostat-propose-only.md) | 挑战点恒温器：跨区观测聚合+只读建议，「恒温器」不是自动控制器 |
| [0025](./0025-sandbox-monte-carlo-plan-projection.md) | 沙盘：现有模型的蒙特卡洛计划推演，只读、分布输出、非承诺 |
| [0026](./0026-weekly-kata-global-review.md) | 周复盘 Weekly Kata：全局每周一张的五问复盘，有界/无界两区的铰链 |
| [0027](./0027-practice-session-continuity-over-freshness.md) | 练习会话连续性优先于数据新鲜度 |
| [0028](./0028-regenerated-question-starts-fresh-schedule.md) | 重生成的新题新卡起算，不继承旧题调度 |
| [0029](./0029-fill-in-blank-unique-term-answers.md) | 填空题只考唯一写法的术语 |
| [0030](./0030-quiz-latex-notation-contract.md) | 题面数学一律 LaTeX 记法，违规拒收而非自动转换 |
| [0031](./0031-dispute-erratum-and-grading-reversal.md) | 瑕疵题勘误与判罚冲正：申诉有出口，账本可净额修正，但 FSRS 与原始流水不动 |
| [0032](./0032-error-contrast-cards-deck.md) | 错误对比卡域：错答挖矿的独立错误 deck（FSRS 汇入复习队列、无绑定 XP） |
| [0033](./0033-grown-graph-replaces-one-shot.md) | 课程图以种子+滚动教练生长，取代一次成型全图生成 |
| [0034](./0034-declarative-break-and-sediment-store.md) | schema 演进走宣告式断裂，学习模型状态落沉淀层 |
| [0035](./0035-question-cleanup-archive-only.md) | 题库清理只归档不删除，跳过节点即归档其题目 |
| [0036](./0036-cancel-break-distillation-bridge.md) | v1→v2 断裂不蒸馏：存档只作考古，不建蒸馏桥 |
| [0037](./0037-enc-weight-is-invokes-coverage-projection.md) | enc 权重 = invokes 覆盖率投影：调用站阶梯退役 |
| [0038](./0038-ui-dispatched-graph-lifecycle.md) | 学习图生命周期全流程进面板：UI 下发命令替代 agent 会话交接 |
| [0039](./0039-registry-sweep-on-content-delete.md) | 内容删除与生成任务注册表联动：悬空即清、无墓碑、保留期跨重启 |
| [0040](./0040-generation-time-discipline-back-in-prompts.md) | 生成时纪律回归提示词层：理念条款与质量自查随生长式提示词携带 |
| [0041](./0041-unified-agent-seam-and-tool-loop.md) | agent 交互收口统一缝：单发补全与只读工具回路双模式 |
| [0042](./0042-layered-import-rules.md) | 分层依赖规则成文与零依赖执法（import 规则测试） |
| [0043](./0043-facade-subsystem-extraction.md) | 门面子系统化：聚合+转发模式与分节对照表定稿 |
| [0044](./0044-top-level-layering-and-invariants.md) | 顶层分层：四层责任、顶层不变量与三件不要做 |
| [0045](./0045-command-registry-and-channel-discipline.md) | 命令面统一：声明式命令注册表（表项形状与分流纪律） |
| [0046](./0046-write-unit-and-atomic-write-inversion.md) | 写入单元与原子写倒挂修正 |
| [0047](./0047-architecture-gates-and-ratchet-timing.md) | 架构门清单、阈值来源与棘轮时序 |
| [0048](./0048-host-runtime-explicit-object.md) | 宿主 runtime：显式对象承载全部可变态 |
| [0049](./0049-facade-terminal-form.md) | 门面终态：hub 降级为容器，公开面改子系统路径 |
| [0050](./0050-growth-batch-feedback-retry-and-restore-payloads.md) | 生成队列可靠性：回灌重裁、显式重试与重启负载恢复 |
| [0051](./0051-layered-dependency-policy.md) | 依赖三层政策：门零依赖、测试 devDep 逐票许可、运行时依赖论证制 |
| [0052](./0052-frontend-layering-and-navigation-seam.md) | 前端分层与导航缝：四层目录、500 行预算、自研 hash 路由缝 |
| [0053](./0053-append-stream-torn-tail-exemption.md) | 追加流水撕裂尾行豁免：中段损坏即 Broken |
| [0054](./0054-section-overflow-repair-ladder.md) | 节内容溢出的修复阶梯：预算校准、压缩修复、大纲拆节与 partial 续跑 |
| [0055](./0055-endpoint-singularity-and-growth-direction-invariant.md) | 终点性单源派生与生长方向不变式 |
| [0056](./0056-endpoint-pure-marker-and-completion-refold.md) | 终点纯标记化与完成判据折叠 |
| [0057](./0057-nof1-receipt-review-mode-variable.md) | N-of-1 白名单增补练习侧变量：回执评审模式（receipt_review_mode） |
| [0058](./0058-cadence-axis-navigation.md) | 导航节奏轴：五区页签、两级路由与供给卡——面板信息架构改版 |
| [0059](./0059-generation-methodology-patches.md) | 生成方法论补丁四票的裁决：节间连贯注入、档位声明完备、交错补丁、双重编码软指令 |
| [0060](./0060-generation-corpus-capture.md) | 生成语料捕获 + token 计量（缝合点） |
| [0061](./0061-output-contract-registry.md) | ADR-0061: 输出契约注册表 phase 1——契约数据单一出处 + 文本锚门 |
| [0062](./0062-quality-rubric-registry.md) | ADR-0062: 质量量规注册表——五产物类型、判定标准先于判定器 |
| [0063](./0063-quiz-second-opinion-gate.md) | ADR-0063: 出题第二意见门——生成时独立解题对账 |
| [0064](./0064-question-diversity-instrument.md) | ADR-0064: 出题多样性仪表与基线测量 |
| [0065](./0065-prompt-contract-last-assembly.md) | ADR-0065: 提示词契约后置——单拼装缝 + 契约段末位 + 变更登记 |
| [0066](./0066-repair-policy-single-source.md) | ADR-0066: 修复轮策略单源——机制登记与实现对账；出题整批修复轮维持不设 |
| [0067](./0067-temperature-port-passthrough.md) | ADR-0067: temperature 端口贯通（默认值不动） |
| [0068](./0068-generation-smoke.md) | ADR-0068: 生成冒烟（临时 vault 全管线 + 结构断言报告） |
| [0069](./0069-tool-channel-spike-apparatus.md) | ADR-0069: 工具调用通道 spike 装置（双臂 × 两站 × 多变体） |
| [0070](./0070-offline-quality-review-and-graph-audit.md) | ADR-0070: 离线批量评审器与图质量面审计抽样（语料 × 量规 × 人读报告） |
| [0071](./0071-vault-prior-bm25-and-audit.md) | ADR-0071: Vault 先验检索换核——BM25 式打分、登记表查询扩展与检索审计 |
| [0072](./0072-prompt-changelog-discipline.md) | ADR-0072: 提示词变更纪律——登记四件套、提交级登记门与「过门」双检 |
| [0073](./0073-corpus-tool-call-payload.md) | ADR-0073: 生成语料补齐工具调用载荷（回路站的产物在语料里可见） |
| [0074](./0074-compass-route-reconcile.md) | ADR-0074: 罗盘路线对账（周复盘现状区的非权威读数；对账口径已被 #316 周检讨读数取代） |
| [0075](./0075-prompt-text-lazy-templates.md) | ADR-0075: 提示词文本的单源与惰性模板——`prompts/` 落点、`{{var}}` 严格渲染、模板面清单 |
| [0076](./0076-name-only-creation-and-plural-endpoints.md) | 名称建课、手动多终点与生长停摆判据 |
| [0077](./0077-stuck-report-direct-evidence.md) | 卡点自报直接成立插入症状，错归因由复诊兜底 |
| [0078](./0078-no-auto-enqueue-content.md) | 正文生成一律显式下发：撤掉 apply 与生长批的自动入队链 |
| [0079](./0079-section-gate-contract-vs-tendency-and-cap-leniency.md) | 节质检门分层：契约类硬拦、倾向类 warn、满编放行 |
| [0080](./0080-debug-log-port-and-daily-file.md) | 调试日志：端口形状住引擎、写侧住宿主、按天一个 .log |
| [0081](./0081-doctor-merged-into-data-check.md) | 单一诊断入口：doctor 并入 data-check 并整体退役 |
| [0082](./0082-retirement-boundary-beyond-reachability-gate.md) | 退役边界在可达性门之外：种子链与四条死命令整体退役 |
| [0083](./0083-reachability-gate-and-ops-surface.md) | 可达性门与 ops 面正名：命令必须至少一个可达面 |
| [0084](./0084-concept-layer-identity-and-address-lifecycle.md) | 概念层职责重划：登记表保留为身份系统、地址生命周期与治理纪律 |
| [0085](./0085-edge-admission-discipline-and-footprint-consolidation.md) | 边种与边属性的准入判据：边轻纪律成文 + 概念足迹收成一处 |
| [0086](./0086-concept-governance-loop-and-write-side-gates.md) | 概念层治理回路与写侧门：合并提案化、候选派生、近似名预检、量级纪律、注入上限 |
| [0087](./0087-graph-grouping-no-stored-hierarchy.md) | 图分组：不存储层级（纵向 depth + 横向派生可重叠） |
| [0088](./0088-growth-draft-gate-shared-replay.md) | 生长草稿：门同源的累积重放与执行官最小回路 |
| [0089](./0089-concept-identity-cross-course.md) | 概念身份跨课程化：中心级登记表与全库联合唯一 |
| [0090](./0090-single-file-graph-storage-schema-break-v4.md) | 存储塌缩：一课程一文件 + schema v4 宣告式断裂（零迁移） |
| [0091](./0091-observability-event-registry-appendix.md) | 调试日志附录事件登记表：#259 巡检增量（闭集外新事件与指针级事件统一入册） |
| [0092](./0092-empty-graph-first-rung-criteria-rehome.md) | 空图首级：起点资格判据迁家为教练材料注入（不开第三族） |
| [0093](./0093-engine-domain-folders.md) | engine 目录按域分文件夹：91 文件归 9 域单层 + 顶层 5 |
| [0094](./0094-renderer-menu-placeholder-only.md) | 渲染能力清单只认占位符：删有占位符就注入、没占位符就追加的运行期兜底 |
| [0095](./0095-growth-draft-lifecycle-closure.md) | 生长草稿的生命周期收口：门同源兑现到 schema 面、未发布段逃生口、水位重放修正 |
| [0096](./0096-blocking-audit-closures-criterion-dimension-and-real-exits.md) | 生长链路四个阻断收口：判据与动作同量纲、插入批预注册写入面、取消与预算的真出口 |
| [0097](./0097-compass-route-back-to-plan-contract.md) | 罗盘「剩余路线」恢复生产者：route 回到思路官的计划契约（route 归属已被 ADR-0099/#316 取代） |
| [0098](./0098-growth-chain-silent-loss-and-diagnosability.md) | 生长链路的静默丢弃与可诊断面收口（#313 第三次审计 A/B/C/D/E 五组） |
| [0099](./0099-compass-master-station.md) | 罗盘升格为大师站：战略分解、写权反转与终点锚程度语义 |
