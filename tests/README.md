# 测试

`npm test` = `npm run typecheck`（类型门，G7）+ `node --experimental-transform-types --test tests/*.test.ts`（Node >=24 原生 TS + `--experimental-transform-types`，零测试框架依赖；facade 测试需要 transform 模式处理注入类的 constructor parameter properties，引擎门面测试直接实例化 `LearnhubEngine`）。单跑规则测试可用 `node --experimental-transform-types --test tests/`。

## 门面 C 形态（#182 / ADR-0049，2026-09-12）

hub 已降级为纯容器：公开面从扁平 `engine.<方法>` 改为 **`engine.<子系统>.<方法>`**（子系统实例 = `learner`/`content2`/`project`/`bank2`/`channels`/`lab`/`graph`/`growth2`/`sched2`/`registry`/`proposals`/`projects`，全部公开 readonly 属性；hub 保留装配接线 + 装配域方法 statusJson/recommend/doctor/rebuild/saveGenJobs 等）。对测试的三点影响：

- **直调写点路径**：`engine.learner.learnerQueue(...)` 而非 `engine.learnerQueue(...)`；hub 装配域方法保留裸名（`engine.statusJson()`）。注册表 `engine` 字段同口径（点路径 + hub 裸名），门① 断言子系统类原型。
- **打桩按真实调用路径**：宿主泵/路由驱动的引擎调用走点路径，桩键写 `<子系统>.<方法>`（`tests/host-runtime.test.ts` 的 `stub()` 助手支持两种键）。
- **快照记名**：工具面/路由面行为快照的 `calls` 以 `<子系统>.<方法>` 记名（探针 shadow 覆盖子系统实例方法）；`tests/helpers/regen-fixtures.mts` 与 `regen-face-baseline.mts` 是快照/基线的再生成工具（结构性迁移后使用，输出 diff 必须逐条人审——status/text/error 漂移零容忍）。

## 测试缝与 vault 工厂（ADR-0013，2026-09-09）

- **`engine.store` 是正式测试缝**：D14「一切数据访问收口 engine 门面」是运行时纪律（工具/路由/UI 不得绕过）；测试侧的播种与断言走类型化的 `engine.store`（`reviewLogAll`/`appendPractice`/`loadPins` 等），这是文档化契约，不是后门。运行时代码零消费者（宿主/客户端/UI 均不触）。勿建 Probe 镜像、勿提议 store 私有化。C 形态下 store 仍是 hub 公开属性，此缝不变。
- **`tests/helpers/vault.ts` 是共享 vault 工厂**：`withVault(options, run)` 声明式生成临时 vault + `LearnhubEngine`（默认 = 单课程「数学」/单节点「入门」基线；options 覆盖 registry/graph/notes/banks/state 种子/中心外文件）；`run` 收 `{ engine, root, paths, store }`，重载荷场景（假 Anki 传输器、故意损坏档、空 vault）用 `root` 逃生口自行写文件。共享 helpers：`tfQuestion(id, opts)`（true_false 题目 YAML 行）、`noteText(...)`（节点笔记 frontmatter）、`answer(engine, ...)`（作答包装）。

接缝（2026-09-07 与用户确认）：

- S1 `quality.ts::jumpCandidates` —— 认知跨步候选（|Δdifficulty|≥2 或 depth 跨度 ≥3）
- S2 `quality.ts::floatNodes` —— 空降节点（region 序后 3/4 且 pre 空）
- S3 `health.ts::graphHealthScore` —— 前置完备项基于 S2
- Data Check `engine.index.ts::dataCheck` —— Missing/Broken 只读盘点（临时 Vault fixtures）

内容管线接缝（2026-09-07 新增，`content-gate.test.ts`；被测模块已改为显式字段赋值，strip-only 可导入）：

- S5 `content.ts::checkSectionShape` —— 节形状门（### 子标题 warn、正文长度 warn/finding、公式与代码不占文字预算）
- S6 `content.ts::checkVisualBlocks` —— 富内容块门（plot/chart 合法 JSON 对象含尾随逗号容错、svg 起始）
- S6.5 `content.ts::fixRichBlocks` —— 程序性自动修复（plot/chart 尾随逗号/行注释清洗、svg 前导杂质裁剪、mermaid 自动补引号）
- S7 `content.ts::checkInteractiveHtml` —— 交互件门（完成上报/外联/200KB finding，TEACHER 监听与 widget-config 缺失 warn）
- S8 `content.ts::parseOutline / assembleBody / stripLeadingSectionTitle` —— 节清单解析与正文重组
- S9 `question-bank.ts::validateBank` —— 题库 schema（只管形状，不管数量）
- S10 `content.ts::locateFinding / sectionRepairPrompt` —— 修复轮 findings 附定位、prompt 要求局部重写
- S11 `complexity.ts::complexityTier / nodeTierOf / checkOutlineBudget / perSectionQuizTarget / genericQuizTarget / profileBlockLines` —— 复杂度档位折叠、护栏与锚点（`tests/complexity-tier.test.ts`）
- S12 `content.ts::PROMPT_KINDS` —— 内置模板版本标记与 §9 复杂度档案锚点（`tests/prompt-contract.test.ts`）
- S13 `health.ts::estSpreadNote` —— est 分布压缩 advisor 提示（不改健康分；`tests/health.test.ts`）
- S14 `notes.ts::validateNoteFrontmatter` —— `content.tier` 枚举校验与保留（`tests/strict-note-state.test.ts`）
- S15 `ui/src/lib/svg-uri.ts::SVG_URI` —— SVG 清洗 URI 白名单（DOMPurify 逐属性值筛查语义；`tests/svg-uri.test.ts`）
- S16 `ui/src/lib/quiz-rules.ts::passStreakFor` —— 练习轮连对目标随组内题量收缩（`tests/quiz-rules.test.ts`）
- S17 `ui/src/lib/md-chain.ts::MD_HTML_POLICY` —— markdown 链 skipHtml 策略（机器注释不显示；`tests/md-chain.test.ts`）
- S18 `generation-jobs.ts::nextQueuedJob` —— 全局生成队列 FIFO 选取（queued 非终态不清理；`tests/generation-jobs.test.ts`）
- S19 `notes.ts::hasReadyContent` —— 「已生成」三态标识数据源（任一节 ready；`tests/has-ready-content.test.ts`）
- S20 `content.ts::candidateCallSites / encPromotion / invokesProjection` —— enc 反哺候选收集、闭包内提升与 invokes 覆盖率投影（权重=invokes 覆盖率投影、无数据落缺省 1，#148 调用站阶梯退役；`tests/enc-backfill-audit.test.ts`）
- S21 `content.ts::encBackfeedHints / encContentHints` —— enc 反哺写回建议 + 内容级背书 R14–R16（覆盖缺口/一致性/权重区分度；`tests/enc-backfill-audit.test.ts`）
- S22 `sessions.ts::gateAdvice` —— A3 R 半 R 门建议生成（被 R-gate 拦下候选 → {前置, R, 到期题数}；`tests/a3-gate-advice.test.ts`）
- S23 `sessions.ts::isStruggle / withinStruggleWindow / encRemedialAdvice` —— A3 F 半 struggle 判定（作答量门槛低数据静默、近期窗口）与 enc 祖先 w×(1−R) 降序定向建议（`tests/a3-gate-advice.test.ts`）
- S24 `adaptive.ts::combinedDifficulty / startBand / nextBand / pickNext / sessionOrder` —— A1 会话内选档（静态+FSRS 合用难度、Mastery 起点先验单调、连对升档/错忘降档；`tests/adaptive-session.test.ts`）
- S25 `bank-advice.ts::calibrationAdvice / tooEasyAdvice` —— B2 难度带校准与全对归档建议（stage/作答量/Mastery/答错证据四道守门、低数据静默；`tests/bank-advice.test.ts`）
- S26 `memory.ts::forecast / stateHistograms / dueReviewFirstPushes / trueRetention / calibrationBins / forgettingCurve` —— 记忆健康四面板聚合（synthetic 与首学推进排除、每卡每天第一条；`tests/memory-health.test.ts`）
- S27 `optimize.ts::trainingSequences` —— FSRS 优化器训练序列构建（synthetic 排除、每卡每天第一条、delta_t 链；`tests/fsrs-optimize.test.ts`；门禁/写回走 facade + 假优化器注入）
- S28 `attribution.ts::evaluateSectionSignals / sectionEntryOf` —— B1 节级归因触发（R1/R2 阈值、（题,日）去重、节重写锚点、冷却 fresh/met 分层、R1 二次升级；`tests/b1-attribution.test.ts`；facade 集成同文件）
- S29 `goals.ts::todayPins / pinHeadScore / newLessonRationale / normalizeGoalIntention` —— E3「今天学它」pin 当日有效期、课程内置顶分与新课自然语句 rationale、执行意图录入校验（成对必填/trim 归一/都缺=清除；`tests/goals-pin.test.ts`；pin 覆盖层/过期失效/未就绪照开/意图挂载与清除走 facade）
- S30 `jol.ts::pickJolTargets / jolDeviatedQids / jolCalibration` —— E4 JOL 抽查选卡（信息价值优先 + 随机补齐）、偏差重探与校准配对聚合（门槛前 null；`tests/jol.test.ts`；抽查标记/predicted 落流水/全局开关走 facade）
- S31 `coach.ts::coachFeedback / withinCoachWindow` + `adaptive.ts::bandOffset` —— E5 难度带带权偏移与「可用的困难」教练触发（7 天窗口、全简单/全挑战分布、作答量门槛低数据静默；`tests/band-coach.test.ts`；bandPref 传导与会话日志走 facade）
- S32 `note-source.ts::validateNoteSourceEntries / classifySource / sourceHint / fingerprintOf / normalizeSourcePath` —— C1 笔记源注册契约、Missing/漂移判定与提示、路径归一（拒绝学习中心内部/越界；`tests/note-source.test.ts`；注册/出题/复习队列/作答通道/零写入快照走 facade）
- S33 `learner-cards.ts::validateLearnerCards` —— E1 我的卡 schema 门禁（卡面白名单/长度上限/挖空标记/控制字符拒绝/派生块透传；`tests/learner-cards.test.ts`；存卡/队列/自评通道与 #33 零写入边界走 facade）
- S34 `explain.ts::explainBackPack / explainFeedbackSystem / parseExplainVerdict` —— E2 讲解包拼装（要点+图位置+初学者人设指令）与定位反馈判词解析（不可解析抛错零副作用；`tests/learner-cards.test.ts`；反馈入 E 档案与 canonical 零写入走 facade）
- S35 `anki.ts::mapAnkiEase / sameDayAdvanced / planMirrorSync / sourceKeyOf·parseSourceKey / ankiCardPayload` —— C2 Anki 通道纯规则层（Again/Hard/Good/Easy→答错/自评档映射、同日已推进双门判定、镜象 diff 以 vault 为准、来源键编解码（兼容含 / 节点名）、导出负载排版与内容指纹；`tests/anki.test.ts`；导出推送/导入回写重算/同日跳过只留档/归档移除/清单丢失自愈走 facade + 假 AnkiConnect transport）
- S36 `self-note.ts::selfNoteFeedbackSystem / selfNoteFeedbackPrompt / selfNotePromptOf` —— E1「加我的理解」自注反馈指令拼装（节锚点收窄对照面、不超纲不评分）与默认卡面提示（`tests/learner-cards.test.ts`；判词入 E 档案 kind=self_note、AI 失败零副作用、#33 边界回归走 facade）
- S37 `sleep.ts::reconsolidationAdvice / normalizeSleepAdvice` —— D-4 睡眠耦合建议文案（Walker 依据＋心理演练 r≈0.13 预期管理措辞）与建议层开关归一（`tests/sleep.test.ts`；推荐附着/独立事件封顶/全局可关/零 canonical 走 facade）
- S38 `nof1.ts::shuffleAssign / nof1ArmForDay / interleaveBySource / analyzeNof1 / nof1Outcomes / NOF1_TEMPLATES·NOF1_VARIABLE_WHITELIST` —— D-1 N-of-1 纯规则层（卡级播种分臂、批次按学习日轮臂、混排保序摊入、置换检验＋自助法区间、结局提取过滤、白名单与 v1 模板口径；`tests/nof1.test.ts`；提案-确认制/臂标注/批次生效/账本零改动走 facade）
- S39 `thermostat.ts::retentionBand / bandDistribution / execRatingDistribution / thermostatSuggestions` —— D-2 恒温器观测聚合与建议触发（保留率带、难度带长期分布窗口、执行评级宽松读入、择易×高保留/择难×低保留触发、低数据静默、同向沉默；`tests/thermostat.test.ts`；仪表只读/建议逐条显式确认/伪造 id 拒绝走 facade）
- S40 `sandbox.ts::simulateRun / aggregateRuns / quantile` —— D-3 沙盘蒙特卡洛纯函数（播种确定、schedFor 按课程注入与调度同源、预算决定引入、跳过节点不计、p50/p80 聚合；`tests/sandbox.test.ts`；全链路零 canonical 写入逐字节比对走 facade）
- S41 `project-decompile.ts::decompileGoalOf / decompileTerms / splitDecompileDoc / reconcilePlanNodes / decompileRepairPrompt` —— P-5 目标反编译纯函数层（v8 种子簇形态 #149：空目标拒绝、检索词派生同 priorTerms 口径、双产物拆分校验 = validatePlanArtifact + validateSeedProposal 骨架模式同门（种子半区受理侧定写 mode=new / basis=project）、名字对账门 = plan.nodes 引用 ⊆ 种子簇节点名 ∪ 既有图节点名、修复轮提示词；`tests/project-decompile.test.ts`；双提案受理/联合 apply/单边守卫/reject 联动走 facade）
- S42 `project-exec.ts::execRatingScore / exercisedEncEdges / classifyCross / masteryAggregate / execEvidenceScore / recommendTier` —— P-7 项目执行事件流纯函数层（评级→0-1 带中点映射、被行使 enc 边判定 v1=两端都在事件 nodes 内、2×2 象限分类（null 归该轴低侧）、入档推荐纯函数（档内表现+底座，永不做门禁）；`tests/project-exec.test.ts`；回流→mastery→2×2 主链与零 canonical 红线走 facade）
- S43 `calibration.ts::overconfidenceOf / calibrationProfileView / calibrationHintText` —— Self-Calibration 自评校准画像（ADR-0022 #104）：「会」档系统性过信判定（≥JOL_CALIBRATION_MIN 条配对且实际正确率低于显著阈值；数据不足静默）、分源画像聚合（jol 源直调 jolCalibration 不 fork 数学；配对区间 first_ts/last_pair_ts 透出；全局参考视图带域特异警戒）与轻提示文案决策（`tests/calibration.test.ts`；画像入口/抽查密度加强 1/3→1/2/队列 calibration_hint/提示全局关/零 canonical 红线走 facade；编号 S43 = 让位 d-lab S37–S40，S41/S42 预留 p5/p7）
- S44 `output.ts::obsidianLink / outputArtifactFile / writeOutputArtifact / isRegistrableCenterRel` —— V-3 学习产物输出区（`学习中心/我的产出/<类>/`）：出链拼装（剥 .md/反斜杠归一/空路径拒绝）、文件名安全化（.. 拒绝、分隔全角化）、kind 白名单、注册豁免区判定（我的产出整区 + projects/<id>/日志.md 放行，其余中心内维持拒绝；`tests/output-zone.test.ts`；产物落盘/豁免区注册/引擎写后指纹自愈（自己的写不算漂移）/个人笔记零字节红线走 facade）
- S45 `kata.ts::weekStartOf / weekEndOf / prevWeekStartOf / inWeek / buildKataReality / parseKataBody / kataAnswered` —— U-4 周复盘纯函数层（ADR-0026）：学习周折叠（周一锚定、上一完整周、跨年边界）、现状聚合（周归属全经 dayOfTs 学习日折叠，凌晨归属随日界翻转；课程桶排除 milestone_settle 与 course='*' 执行 XP 行）、五问正文解析与作答判定（占位视同未答；`tests/weekly-kata.test.ts`；发起/保存/重开保留四问刷新现状/转换出口/零 canonical 零 XP 红线走 facade）
- S46 `vault-links.ts::parseWikilinks / stripCodeFences / isDateTarget / isNonMdTarget / normalizeLinkName / buildNameIndex / linkScore / scoreTier / mapEdgesToNodes / orientLinkPair / dirExcluded / readVaultLinkDirExcludes / scanVaultLinks` —— V-2 Vault 链接先验（#91）：单正则解析（嵌入/别名/锚点/.md 剥离、代码围栏排除）、资产扩展名白名单（含点标题不误滤）、全半角归一与 basename 索引（撞车取最短）、可解释加法打分与三层分级（≥0.7 提案 / 0.4–0.7 待裁决 / <0.4 报告）、候选边双端映射与 pre 闭包方向裁决（闭包外不成边）、目录段排除（x* 段前缀）与 learnhub.json 整体替换；`tests/vault-links.test.ts`；扫描去噪审计/缓存落 state/analyze 建议段/单提案回填可重入/个人笔记零写入走 facade
- S47 `note-source.ts::poolMirrorBody` —— V-4 卡池镜像正文（#108）：[[个人笔记]] wikilink + 卡数/到期快照 + 零写入红线条目；`tests/note-source.test.ts`；出题落镜像/解除随删/relink 跟随新路径走 facade
- S48 `sediment.ts::foldSediment / renderLearnerProfile / latestFsrsParams` —— 沉淀层读侧折叠（#139 / ADR-0034；#150 增第七类 nof1_outcome）：七类事件追加正典（即时/周分档，weekly 按 payload.week 归桶可重折）、latest/weekly/byConcept 三读法（两次折叠同输入同输出）、学习者档案纯渲染（手编必被覆盖）、FSRS 参数正典读法（缓存退役后删缓存不丢事实）；`tests/sediment.test.ts`；出生即写/断裂不变性（清内容层合成初始化仍取沉淀先验）/legacy 分区零消费/重置波及单独确认项走 facade
- S49 `llm.ts::LlmComplete / LlmStream` —— 宿主→引擎 LLM 端口（#137 补全缝、#162 工具回路缝，纯类型零导入）：引擎侧生成/组装函数只依赖缝型，opts.effort 语义档 fast/deep 沿缝贯通、注入侧可观测（档位翻译成部署 fastEffort/deepEffort 收口在宿主 llmSeam/llmStreamSeam 适配器）；`tests/llm-seam.test.ts`；固定回放假实现驱动出题全链字节级确定性、脚本化应答驱动判卷重问、learnerNoteAdd=fast / receiptSubmit=deep 档位观测走 facade
- S50 `concepts.ts::validateConceptEntry / validateConceptRegistry / namesOf / resolveConcept / conceptReferenceErrors / invokesUnregistered / mintConflicts / applyConceptMints / mergeConceptEntries / ConceptRegistry` —— 概念登记表（#141 / #122 契约 v0.1）：课程根/概念登记表.yaml 受控词表（条目 = canonical + 别名[] + 选填定义，全部名字联合唯一违约 Broken、文件缺失 Missing 合法空态且零 finding——选填域与我的卡同款）、精确匹配解析（canonical/别名 → 同一条目，永不模糊）、并入合并纯函数（名字并集、旧地址经别名续解析、definition 缺省回退）、铸名冲突双门（propose 从严同条目也拒 / apply 幂等同条目跳过）、引用对表（teaches/assumes/误解/invokes 未在册可执行拒收行）；`tests/concept-registry.test.ts`；铸名随 edit 提案 concepts 块与图 apply 同事务（被拒不落盘）、登记表 Broken 读侧抛错、data-check concept_registry 类走 facade
- S51 `coach-round.ts::behaviorWindow / behaviorDigest / renderBehaviorDigest / readyDepthCheck / renderSedimentForCoach` —— 教练回合感知面（#144 / ADR-0033 / ADR-0038）：行为摘要五件套读侧折叠（窗=最近 7 学习日或 10 节取大、错误按 invokes 概念聚合+停滞天数、est vs 实际滚动比+JOL 过信率、误解活跃度不硬猜归属、到期复习真实保留率；即算即用不落盘，全部注入式确定性）、就绪深度检查（默认 3、clamp [2,5]、冷启动首周（锚声明起 7 天）需求 ×1.5 ceil、ready=0 只告警不阻塞、终点剔除——就绪存量与前瞻需求都不计终点，除终点外前沿清空 exhausted 判据自然通过零告警，尾段合法停摆）、沉淀折叠教练投影（消费从 sedimentFold 单向取）、双沙盘仲裁参照（#150：arbitrationPopulations 现状照走 vs 含本批照走的两份总体、renderArbitrationEvidence 非承诺参照块）；`tests/coach-round.test.ts`；六区块上下文包定序（终点锚→行为摘要→登记表档位→误解目录→罗盘尾段→V-2 接缝）与轻量包恰两件、触发五点接线（node_complete/node_skip 路由 fire-and-forget、session_start 经 /status+learnhub_status 共用入口 30 分钟节流、queue_idle 宿主泵、panel_dispatch 面板下发 force 入队）走 facade
- S52 `proposals.ts::GROWTH_OPERATORS / consolidationGateErrors` + `content.ts::PROMPT_KINDS['教练回合']` —— 生长批受理（#145 / ADR-0033）：edit 提案 note 区 {operator, reason, disagreement?, recheck?} 严格 schema（算子枚举锁死、未知键拒收；分歧声明避让「申诉 Dispute」词条、复诊预注册写 recheck）、route 只随生长批携带（「剩余路线」唯一写权属教练回合生长批）、零操作生长批合法（ops: [] = 暂不产结构）、提案 op 边轻键拒收（origin/status/probation 一律 fail loud）、巩固门（operator=巩固 的 add_node 概念引用 ⊆ 既有图 teaches 并集，propose/apply 双门）、apply 同事务罗盘重写（路线门+锚在写盘前全过，提案被拒罗盘不落盘）；`tests/coach-growth.test.ts` + `tests/proposal-validation.test.ts`；coachGrowthBatch 三段式回合（#145/#150：轻量段 fast 恒 1 调用、分歧升级全量段 deep 恒 2 次、全量段仍真分歧升级双沙盘仲裁段恒 3 次——两份沙盘推演是读侧计算不计调用数、segments 可观测）、金样本组装字节级确定性、停机转译（check.ok 零调用停摆）、宿主队列 phase=growth 与生长→内容链走 facade
- S53 `probation.ts::recheckPreregOf / readProbationLedger·appendProbationEntry / foldProbation / recheckVerdict / recheckDue·learningDaysOf / growthRates / growthGate` —— 边实验账本与复诊（#146）：复诊预注册 schema（metric 恰一枚 {前进恢复,卡点集中度降幅,保留率恢复}、days 缺省 10 学习日 clamp [5,20] 落 warn）、账本 `state/边实验.jsonl` 追加只增（条目 {node, pre, proposal, due, outcome?, decided_at?}，每 (proposal,node) 后行覆盖前行 = probation→proven｜剪除）、三枚可机判 metric 的结算判定（诚实口径：数据不足前提一律不达标）、到期判定按课程学习日（practice ∪ 到期复习首推）、三率（滚动 30 学习日：插入率/剪枝率/复诊通过率）与韧性分映射闸门（旁支上限 20%→30%、复诊通过率触底/插入率超限闸停插入批，低数据静默）；`tests/probation.test.ts`；插入批受理预注册强制门与 apply 同事务落账本、probation 在途行使只记流不回流（proven 恢复；前进/旁支不受闸）、到期结算钩子（proven｜自动剪除 del_node+原粗边恢复+内容归档，零人审）、沉淀正典（recheck_outcome 按概念地址/graph_repair）、data-check probation_overdue hint（不进 status）与 statusJson/probationStatus「实验中」+三率可见走 facade

- S54 `projects.ts::planRevisionDiff` + `store.ts::pairApplyBlock` —— 项目里程碑锚定（#149）：计划修订快照 diff 按 id 派生 {added/removed/retargeted}（id 身份锚：重排/改名不误报、nodes 集合语义与顺序无关）、换线（图上已有=stub 激活）/补支（图上没有=朝新里程碑长粗分支）经 planGrowthTriggers 按锚定课程聚合注入 coachGrowthBatch（check.ok 不短路）；同源双提案 pair 联动单边 apply 守卫（pending 拒/applied 放行恢复/rejected 拒绝复活）；`tests/project-domain.test.ts` + `tests/coach-growth.test.ts` + `tests/project-decompile.test.ts`；联合 apply projectDecompileApply（种子先落图计划后落盘）与宿主 phase=growth 注入入队走 facade

- S55 `seed.ts::seedRepairPrompt` + `content.ts::PROMPT_KINDS['种子提案']` + `generation-jobs.ts::GEN_JOB_PHASES` —— 面板下发的种子起草与图域任务化（ADR-0038）：目标描述+绑定字段（课程名/模式/目标类型/块工作表以表单为准，模型照抄错误被覆盖）→「种子提案」提示词组装（vault 先验选配——熟悉边界定位，注册清单 Missing = 零命中合法）→ 缝 complete → 干跑校验门（validateSeedProposal 直跑，未过经缝的门错修复轮回灌重产恰一次，双轮违约 SEED_GATE_FAILED 拒收）→ proposeSeed 权威受理（一次人审即开工）；起点 basis 语义路由（勾选笔记→vault、缺省 baseline）在提示词；phase 联合九值（节点管线三值 + 图域 seed/growth/compass/decompile/plan/milestone；#185 起英文统一，旧中文值为读侧别名；#155 剔除 enrich——回填只产提案走人审，从未入队）；`tests/seed-proposal.test.ts` + `tests/prompt-contract.test.ts` + `tests/generation-jobs.test.ts`；宿主 /seed/propose、/coach/growth（force 豁免停摆阻尼）、/coach/compass、/graph/backfill、/probation/settle 路由与反编译/计划/里程碑草案任务化走 facade

- S56 `agent.ts::AgentSeam / stripFences / AGENT_LOOP_MAX_TOOL_ROUNDS` —— 统一 agent 缝（#162 / ADR-0041 形状 / ADR-0044 归属）：应用层端口消费者（消费 S49 双端口），双模式 `complete()` 单发 + `agentLoop()` 工具回路（K≤6 轮预算封顶、工具白名单外调用由 runTool 拒、LlmStream 缺位 fail loud；#163 起带 `isCancelled` 任务取消传导——每轮底层调用前与每次工具执行后检查，取消即抛错中止）、门错修复轮 `gateRepairRound()` 共享能力（门错误+被拒候选原文回灌重产**恰一次**，仍败以站点 fatal 抛两轮死因；#157 生长批回灌重裁的形态由此收口）、调用日志 `onCall` 注入侧可观测（站/模式/档/轮次/字数）、stripFences 补全后处理随缝归位（原散投递层 9 处接线收口一处，机械站暂由投递层导入复用）；宿主装配收口 createHostRuntime（HostRuntime.agent，console+运行日志双观测面）；`tests/agent-seam.test.ts`；六策略站（种子起草/罗盘/教练生长/目标反编译/计划草案/里程碑草案）金样本回放假实现（脚本化补全端口注入 AgentSeam）经缝走 facade，机械站（出卡/判卷/自注反馈）仍收裸 LlmComplete 择机迁
- S60 `coach-tools.ts::COACH_TOOL_NAMES / coachToolSpecs / coachToolExecutor / renderGrowthGraphView / coachToolset` —— 教练只读工具面（#163 / ADR-0041 白名单七件：graph_view/node_card/concept_registry/behavior_digest/bank_overview/compass_read/endpoint_anchor）：只读引擎视图分发器（引擎访问面结构化注入，行为摘要取材经 providers 复用子系统私有折叠；不回引 growth-subsystem，R7 零环）、白名单外调用 fail loud（缝以 isError 回灌）、坏参数 fail loud、零写侧零队列触点（测试以「全白名单逐工具调用后 vault 字节级不变」行为化断言）；`tests/coach-tools.test.ts`；生长站/罗盘重画经回路的接线（segments 升级路径、回路轨迹进任务消息、取消传导、受理门通过率对照实验）在 `tests/coach-growth.test.ts` + `tests/compass.test.ts` + `tests/coach-loop-pass-rate.test.ts`

- S57 `ui/src/lib/rounds.ts::buildRounds` —— mastery 会话轮次计划（#183 自 PracticeFlow 抽出的纯逻辑）：manifest 驱动节序列（内容节 read+quiz 成对、练习节一等化无阅读轮、交互节 md 存在才出轮）、旧节点标题归一化回退、manifest 分支排除「通用」标注题、未落节题收综合轮；`tests/rounds.test.ts`
- S58 `ui/src/lib/rec-events.ts::sortRecEvents / recTypeMeta` —— 学习页推荐流词汇与排序（#183 自 LearnPage 抽出的纯逻辑）：pin 置顶 → 类型展示序 → 稳定原序、未知类型灰显殿后；`tests/rec-events.test.ts`
- S59 `ui/src/lib/router.ts::parseHash / navigate / syncHash / onRouteChange / TAB_KEYS·DEFAULT_TAB·TabKey` —— 极简 hash 路由缝（#189 / ADR-0052，URL 为导航权威）：`#/页签[+/参数段]` 文法的纯解析核（首段取键、参数段留形不实现、非法/缺省回落默认页签）、写 URL／replaceState 规范化（无历史条目）／hashchange 订阅三薄绑定（lib 零 DOM 的登记例外，settle-context 先例）、页签键与页签表全 ui 唯一出处；`tests/ui-router.test.ts`（window 桩直测薄绑定 + active-tab 桥接初始从路由解析 + 页签表完整性门三表对账带自检）
- S60 `src/host/handlers.ts::pairJointTarget` —— 反编译双提案联合 apply 的面板路由检测（#156 / ADR-0038 补完）：统一 apply 路由检测到 pair 联动自动走 `project.projectDecompileApply` 联合入口（纯面板用户不再被单边守卫的「用 learnhub_project_decompile_apply」文案指向 agent 会话）、联合结果的 plan 半区换线/补支触发照常入队（triggerPlanGrowth 从 `plan` 半区取）；裁决纯函数收口全部分支——另一半 pending/applied（崩溃续段）→ 联合、已拒/缺失/目标已决/非对类 kind → null 走单边路径（单边守卫的精确拒收文案原样透出）；`tests/proposals-joint-apply.test.ts`（纯函数全分支 + 路由级影子引擎：联合调用序列 / 单边不联合 / 联合抛错透传 / plan 半区触发入队）；pair 互指校验、种子先落图、reject 联动同拒走 facade（S54）
- S61 `src/host/static.ts::extOf / serveVaultFile / serveVendor` —— 静态伺服文件路由的报错卫生（#155）：扩展名只从文件名段（最后一个 / 之后）判定（旧实现 `lastIndexOf('.')` 把目录名带点的无扩展名请求整段回显进错误消息）、报错只报扩展名判定不回显请求路径；`tests/host-static.test.ts`（无扩展名 / 目录名带点 / 白名单放行 404 三断言）。同票的 `panelPageHandler` 500 去除 err.message（ENOENT 含绝对 dist 路径）是**代码级变更、无独立实测链**（500 支线需 dist 坏缺才可达，PAGE_DIST 常量不可注入），登记见 ADR-0045 §#155/#156；`tests/ui-honesty-dom.test.ts`（#155/#156 的 L3 交互面：教练台未播种禁用生长+任务条点击 onOpenJob 带任务 key、种子表单按 queued 旗标着色、提案页应用→「查看结果」按类型分流）

A3 门面行为（建议项出现/消退、软闸不拦人、reviewQueue node 过滤直达、struggle 事件与静默）走引擎门面黑盒：`tests/a3-remediation.test.ts`。

`analyzeGraph`/`runAudit` 只做薄接线，不在接缝清单内。

宿主装配缝（2026-09-11 新增，#167 / ADR-0048；`tests/host-runtime.test.ts`）——宿主第一次可测：

- **`createHostRuntime(ctx, config): HostRuntime` 是宿主唯一装配缝**：显式 runtime 对象承载全部可变态（`engine`／`agent`（#162 统一 agent 缝：端口适配在 host/llm.ts，onCall 接 console+运行日志）／`vault`／`centerRel`／`jobs.genJobs`／`jobs.quizJobResults`／`flags.queuePaused·pumping·lastSessionStartAt`），技术层函数（队列泵/路由/工具面/伺服）一律收 runtime 参数。测试造 runtime = 临时 vault + 假 ctx + 引擎方法影子化（实例属性覆盖原型），零模块级状态、并行测试互不污染。
- **三端口装配（#175 / ADR-0044）**：`EngineConfig = { vault, centerRel?, clock: Clock, rng: Rng, fs: VaultFs }` 全必填、引擎内零回退直读——时钟/随机实现住 `host/clock.ts`（systemClock／mathRng），存储实现住 `host/vault-fs.ts`（nodeVaultFs：utf8 读、recursive mkdir、readdirTypes = withFileTypes 投影、statIsFile）。测试注入：`withVault({ clock, rng })`（`tests/clock-rng-port.test.ts` 确定性三断言）；直调自由函数（loadNote／readDayCutoff／runAudit 等）传 `nodeVaultFs`。
- 断言面：队列泵状态机（入队 → 执行 → 终态 → 保留期清扫与 delayMs 补挂）、暂停/恢复（`resumeQueue`）、`quizJobResults` 等待语义（`waitForQuizJob` 超时/消失 fail loud）、runtime 构造校验与首启 seed（#138 盖戳在构造路径）。
- **工具面快照**：`tests/fixtures/host-tools-snapshot.json` 由重构前的 `src/index.ts` mock-apply 捕获（111 个工具的 name/description/parameters），断言按域分组重排后逐工具逐字不变。
- **AGENT_GUIDE 受检投影·前半**（#169 的 AC 之一提前落地）：22 条指南的 `tool` 名必须 ∈ 111 个工具（ADR-0045 记的「22 条手写、从未与 111 个工具对账过」至此有门）、`page` ∈ 面板页签词表、文案/prompt 非空、无重复条目。后半（「通道分类与该命令一致」）要等命令注册表落地。
- **「路由 ↔ 工具」对账基线**：`tests/fixtures/host-face-baseline.json`（口径＝工具注册区 vs 工具区外全部，ADR-0045 实测）：共享引擎入口 **85**、工具独有 **25**、路由独有 **50**（#159 +1：`proposals.proposalImpact`；#156 +1：`project.projectDecompileApply` 从工具独有变两面共享——面板统一 apply 路由检测到反编译对自动走联合入口）——命令注册表迁移的回归网。

路由表与参数守卫（2026-09-11 新增，#168 / ADR-0045／ADR-0048；`tests/host-routes.test.ts` + `tests/helpers/routes-probe.ts`）：
- **路由从 if 链变成数据表**：`host/routes.ts`（GET 46 + PUT 6）／`host/routes-post.ts`（POST 子表 73）／`host/route-table.ts`（表项形状 `{method, route, handler}` + ADR-0045 注册表字段位 `id·summary·args·engine·output·channels`，本票只留位）／`host/api.ts`（装配 + 一次查表分发）。`handleApi` 保留两处**逐字不动**的今天语义：POST/PUT **先读体再查表**（非法 JSON 的未知路由今天也是 500）、404 文案带原始方法与剥前缀后的路由名。
- **参数守卫收成一处的语义**：`host/params.ts` 是唯一出处（`need` 自 `http.ts` 迁来）——必填 `need`／`needQuery`／`requireString`／`requireBoolean`／`requireNumber`／`requireObject`／`requireOneOf`，可选 `opt*`（查询串 `optQuery`）与 `pick(key, value)`（＝今天 `...(cond ? {k:v} : {})`）。**21 处内联 `missing required field:` 与 51 处手写 `typeof body.x` 归零**；消息契约自 #158 起改为中文 `ParamError`（`缺少必填参数：<key>`，枚举例外 `缺少或非法必填参数：<key>（允许：…）`），`handleApi` 统一 catch 追加 `（路由 <method> <route>）`——状态码（统一 500 出口）不变，消息不再逐字冻结（探针快照 218 条守卫消息已随契约迁移）。今天可选参数的语义是「非法即当省略」（比 ADR-0045 的「省略或合法」更宽松），本票原样保留；#169 若收紧成 fail loud 须在票面登记。
- **对账清单**：`tests/fixtures/host-routes-baseline.json` ＝重构前实测的 125 条（GET 46 / POST 73 / PUT 6）+#159 新增 1 条（POST /proposals/impact）＝**126 条**，逐条断言每条路由都被探针覆盖、探针不超清单。
- **行为快照**：`tests/fixtures/host-routes-snapshot.json` ＝**467 条探针**（每条路由 × 空参／全参／逐个缺参 + 分发纪律样本；#159 +3）的 `{status, res, 引擎调用序列}` 基线，逐字重放比对——「响应形状与守卫消息与基线一致」的证据（#158 起守卫消息契约 = 中文 `ParamError` + 路由名，基线随契约同提交迁移）。探针驱动见 `tests/helpers/routes-probe.ts`：每次探针一个全新 runtime、引擎方法影子化为录制替身、`res.end` 即冻结（响应后的 fire-and-forget 不入快照；vault 路径与 ISO 时刻换占位符，快照不钉机器与时钟）。
- 守卫收口另有两道文本门：`src/host/` 下 `typeof body.` 与守卫消息（`params.ts` 之外）清零；`sendJson` 状态码分布 200×122／404×4／500×1（404 的另三处来自 `static.ts` 的伺服未命中）。

命令注册表（2026-09-11 新增，#169 / ADR-0045 裁定；`tests/commands.test.ts` + `tests/tools-face.test.ts` + `tests/helpers/tools-probe.ts`）：

- **一份声明、两个适配器**的地基：`src/commands/`（`types.ts` 表项形状 + 8 个域文件 + `index.ts` 装配）声明 **155 条命令**（111 agent 通道 + 126 panel 通道、73 条双通道；155 = 73 双 + 38 仅工具 + 44 仅面板，#159 +1：proposals-impact），`BY_TOOL`／`BY_ROUTE` 是两张索引。
- **八道门**（1-6 硬门、7 既有快照、8 一致性锁）：① `engine` ∈ 门面原型方法（留空的 25 条逐条登记理由：队列型 9／按参分派型 7／无引擎型 9）② 队列通道 `phase` ∈ `GEN_JOB_PHASES` 且 runner 认得（节点锚定阶段或 `jobs.ts` 里有字面分支）③ `id`／`tool` 名／`(method, path)` 唯一（并断言索引没被静默覆盖）④ handler 覆盖（待适配器切面）⑤ `AGENT_GUIDE` 每条 tool ∈ 注册表的 agent 通道 ⑥ `src/commands/` 零对外运行时依赖（只允许同目录相对 import 与 `import type`）⑦ 零行为漂移：**工具面 259 条行为探针**（`tests/fixtures/host-tools-behavior.json`，每个工具全参 + 逐个缺必填）+ 路由面 467 条探针快照 ⑧ 声明与面一致：agent 通道 `args` 经 `sdkParameters` 投影后与工具面快照**逐字相同**、panel 通道 `(method, path)` 与路由清单逐字相同。
- **`bind`／`required`／`phase` 住通道**（ADR-0045 裁定）：实参绑定 `Array<string|null>`＝引擎实参位置序、`required` 表达「必填是（命令,通道）对的事实」（实测 9 处两面不一致）、`phase` 是队列通道的入口阶段。`args` 的 `read` 键是投递层取值语义（trimmed／text／raw／fallback／finite／query），下发工具面前由 `sdkParameters` 剥掉——**工具面 schema 逐字不变是硬约束**，门⑧ 就是它的锁。
- 声明由重构前的两个投递面实测生成（生成器一次性，不入库）；此后手改会被门⑧ 打回。
- **UI 同源派生**（`tests/ui-types.test.ts` + `scripts/scan-ui-types.mjs`）：响应类型从注册表 `output` 派生（`CommandOutput<id>`，镜像已清零）、调用点棘轮现值 **142**（#159 +1：`api.proposalImpact`；有意增减随提交同步）；UI 类型门只断言 `ui/src` 自身 0 错（依赖源码的存量债归根类型门），另有一条「UI 写出的 snake_case 线名必须在声明里」的权威门。
- **两个适配器已切到声明**：panel 面 = `host/api.ts`（查表 → 有 `bind` 走生成路径 49/125 → 否则 `host/handlers.ts` 的 76 条例外 handler）；agent 面 = `host/tools.ts`（1039 → 127 行注册循环 + `sdkParameters` 投影 → 例外 66 条在 `host/tool-handlers.ts`）。`routes.ts`／`routes-post.ts` 退役。
- **零漂移的三张网**：工具面 schema 快照（111 条 name/description/parameters）+ 工具面 259 条行为探针（文本 + 引擎调用序列）+ 路由面 464 条探针，切面前捕获、切面后逐字复现。

UI 测试网与数据获取缝（2026-09-12 新增，#183 / ADR-0051／ADR-0052；四层形状 = `lib/` 纯逻辑 + `hooks/` 数据获取 + `pages/<Page>/` 页面条目与页内子组件 + `components/` 跨页组件）：

- **lib/**：md-chain／quiz-rules／svg-uri 自 components/ 迁入（S15–S17 接缝路径已同步，语义零变化）；`settle-context.ts` 同批迁入——它 import react 的 `createContext`（上下文对象，非组件、零 DOM、node:test 可直测），是 ADR-0052「lib 零 React」的**登记例外**（该 ADR 的迁移名单本身点名了它）。**L1 豁免**：它是 React 原语而非可断言逻辑，无独立单测，由 L2 的 LearnPage@lesson 变体（PracticeFlow 交互轮消费 SettleContext.Provider）传递覆盖；`md.ts`（54 行手写 md→HTML）全仓零引用，**已删除**。新增 S57 rounds／S58 rec-events 两个抽离纯模块。
- **数据获取缝 `ui/src/hooks/useCommand.ts`**（#187 决议④）：单命令即请求、无缓存无去重、latest-wins（seq 守卫丢迟到旧响应）、失败只写 error 不翻转 data、空态由调用方派生；`errorMessage()` 是全 ui/src 唯一错误→消息提取点（ApiError 单点，散落手写提取已归零），App.tsx 的 `toastError` 孤儿随之删除；`usePolling.ts` 收编六处手搓 `setInterval + isActiveTab + learnhub:tab` 样板（LearnPage/GraphPage/LessonView 自适应 3s/15s/GeneratePage/ProposalsPage/CoachCockpit 复诊卡 30s；useCoachToasts 的 App 级轮询按决议④豁免）；三态呈现组件 `components/CommandBoundary.tsx`（加载/失败/内容一个长相，页变体 Result、卡变体内联重试）。
- **L1 接缝单测**：`tests/rounds.test.ts` + `tests/rec-events.test.ts` + `tests/ui-router.test.ts`（挂 node:test 全量）。
- **ui 规模预算门**（`tests/ui-budget.test.ts`，独立于 arch-guards 的 G 家族）：ui/src 单文件 **≤500 行硬预算**——超线即红，不是可涨棘轮；现超线 0（原 4 文件已收敛：LearnPage 1292→目录化 5 文件、StatsPage 821→5 文件、LessonView 580→445+UnderstandingEntry、PracticeFlow 554→458+lib/rounds）。未来确需超线 = 票面登记理由后改门（BUDGET/豁免），不许静默养大。自检照 ADR-0047：注入必然超线样本断言门会红。
- **L2 冒烟渲染门**（`tests/ui-smoke.test.ts` + `tests/helpers/tsx-loader.mjs`）：`react-dom/server` 把每个页面条目渲染成非空静态标记——import 崩溃/首渲染崩溃在 `npm test` 即红。**技术前提实测**：Node 24.14 原生 TS 直跑不支持 JSX（.tsx → ERR_UNKNOWN_FILE_EXTENSION），故 loader 用 devDependencies 里已锁版本的 typescript 包做内存转译（零新增依赖、零构建步骤；.css 空模块替代、bundler 风格无扩展名导入在 resolve 钩子补后缀）；react/react-dom 经 `createRequire(ui/package.json)` 取自 ui 依赖树，与被测模块同一实例。**裸跑约束**：本门必须带 `--experimental-transform-types` 旗标跑（api.ts 的参数属性超出 strip-only 语法面，裸 `node --test` 即红）——官方 `npm test` 自带该旗标，单独手跑本文件时别省。**冻结表即棘轮**：render 12 项（App + 10 页 + LearnPage@lesson 变体——覆盖 LessonView/PracticeFlow 挂载）每项必须渲染成功；exempt 暂空；新页面不在两表 = 红（逼迫显式归类）；修好的页面从 exempt 挪进 render 后不得挪出。
- **lint（ADR-0051 第二层首例，不进门家族）**：`ui/` devDeps = eslint + eslint-plugin-react-hooks + @typescript-eslint/parser（仅作 parser——hooks 规则须 AST 解析 TS，不引入其规则集；许可考量：三者皆本地 devDep、零运行时产物、秒级执行，worktree 双份安装代价有限）；`cd ui && npm run lint`，规则仅 rules-of-hooks=error + exhaustive-deps=warn（现值 0 警 0 错），无任何风格规则。
- **L3 组件交互测试（2026-09-12 新增，#188 / ADR-0051 第二层许可；`tests/ui-seam-dom.test.ts` + `tests/ui-pages-dom.test.ts` + `tests/helpers/ui-dom.ts`）**：happy-dom 模拟 DOM + @testing-library/react 渲染/查询/点击，挂**既有 node:test runner**——根 `npm test` 的 glob 自动收编，**ui 侧零执行入口、零第二配置面**（ADR-0051「不建第二个 runner」；devDep 装在 `ui/` 子包，react 实例经 `createRequire(ui/package.json)` 与被测模块同源）。DOM global 在 `tests/helpers/ui-dom.ts`（测试文件内注册）落地：happy-dom Window 抄到 globalThis（保留 Node 的 fetch/console/timers，fetch 另被桩接管）；`fetch` 桩 = 路由表（键 `'GET /xp'`）→ 页面→api.ts→fetch 全链路真实、只有网络是假的，未登记路由 404 → 次要数据走缝级三态显式失败不翻页。**选型实测（二选一）**：happy-dom 单包零传递依赖（磁盘 ~16MB）战胜 jsdom（~30 个传递依赖）；arco 全套（Table/InputNumber/Collapse/Popconfirm/Modal/Message/Result/Tooltip）在其上交互无阻。**覆盖（棘轮化，不求覆盖率数字）**：useCommand 三态/命令重取/latest-wins/失败不翻转/set 本地回填、CommandBoundary 卡/页变体三态与重试、usePolling 切回页签补取数；三大页各≥1 条关键交互（LearnPage 推荐卡进学习视图 + 主数据整页失败态、StatsPage 今日 XP 上账 + 保存每日目标、LessonView 无题空态 + AI 出题入队 + 折叠展开）；页签表完整性（Exhibit A 必测项）不在本文件执法——#189 落地后 TAB_KEYS 唯一出处 = lib/router.ts，由 `tests/ui-router.test.ts` 三表对账门独家执法（直接消费权威导出、断言面是超集）；本文件初版另起过的同门已收敛退役——两道并存 = 页签形状每变一次要同步改两遍的漂移税。只测用户可见行为（点击后出现什么、调了哪个端点），不断言内部状态。**RTL 清理非自动**：node:test 无全局 afterEach，测试文件须自带 `afterEach(cleanup + Message.clear)`；页面挂 usePolling 的测试漏 cleanup 会因保活定时器挂住进程。
- **调用点棘轮现值 142 不变**（结构性收敛全部以 `() => api.x(...)` 包装保持调用点形状）；`api.ts` 端点名与签名零改动。
- **hash 路由缝（#189 / ADR-0052，U3 行为票）**：`lib/router.ts` 是导航权威缝——App 初始 tab 从 `parseHash(readHash())` 解析（刷新保持页签、`#/projects` 深链直达），跳转唯一写点 `go()` = 渲染态投影 + `navigate` 写 URL，`onRouteChange` 回灌前进/后退/手改 hash，`syncHash` 把空/非法 hash 规范成规范形（replaceState 无历史条目）；AppFrame 三跳转（goto/openLesson/locateInGraph）与通知分流、空课程守卫全部经 navigate，无裸 setTab。**active-tab 桥接取舍**（票面登记）：初始值从路由解析（深链首挂载 beat 不落 'learn' 假窗），此后 App effect 镜像——isActiveTab 门与 learnhub:tab 事件语义零变化；「isActiveTab 即时解析路由」被否（每次轮询碰 DOM、hashchange 异步于 React 提交时序更松）。**页签表完整性门**（Exhibit A 教训，U2 交互测试落地前的 L1 文本门）：App 的 TabPane 键／TabBody 保活分支／路由 TAB_KEYS 三表对账，缺键项（#158 形态）、幽灵 TabPane、缺分支、分支重复全被抓，带 ADR-0047 自检；U2（#188）初版在 tests/ui-pages-dom.test.ts 另起过一道同门，经门册去重（#188/#189）收敛退役——本门是页签表完整性的唯一执法者。

架构门（2026-09-11 新增，ADR-0042 / #152 刀 1；`tests/import-rules.test.ts`）：

- 分层依赖规则执法，随 `npm test` 全量必跑：R1 host 的 engine 导入只走门面、R2 engine 禁引宿主、R3 engine 禁引 `@deepseek-ai/*`、R4 views 纯类型、R5 io.ts 零相对导入叶子、R6 门面唯一汇点（engine 子模块不回引 engine/index.ts）、R7 src 相对 import 全图零环（含 type-only 与动态导入边）。R3 带自检：收集器须能看见裸包/作用域包说明符（曾出现只收相对说明符致 R3 恒过的实测缺陷，自检锁死）。行级收集相对导入（静态/type/侧效/export-from/动态）+ DFS；说明符解析带 .ts 直用、否则补 .ts、否则补 /index.ts。刀 1 随门落地两处解环先例：receipts 用本地 ReceiptStore 结构化窄面（receipts 不 import store）、周折叠函数族归位 dates.ts（sediment 改引 dates，kata 原路径 re-export 保 S45 接缝）。

单一出处门（#172；`tests/dedup-convergence.test.ts`）：七组重复实现收敛的对照测试 + 文本门——每位数值工具/键标识/常量收敛后的出处（grading 的 round2·clamp01·pctOf、dates 的 DAY_MS·calendarDayOf、types 的 sourceKeyOf·parseSourceKey·nodeKeyOf·PROPOSAL_STATUSES）与其收敛前参考公式逐值对照；文本扫描断言七组模式（含「pctOf 后拼字面百分号」的 %% 回归）在出处模块外零残留，剥注释扫描、每门带「必然违规样本」自检。两段节点键 `${course}/${node}` 不设文本门（与 `${dir}/${file}` 路径拼接文本不可区分，误咬更坏），由调用点改造与对照覆盖；键标识本体住 types.ts 中立词汇层、anki 原路径 re-export 保接缝（S35 所指 anki.ts 导入仍有效）。

写入单元（2026-09-11 新增，#176 / ADR-0046；`engine/write-unit.ts` + `tests/write-unit.test.ts`）：

- **`runWriteUnit(op, { course?, clock, journal, steps })` 是跨文件落盘的唯一编排口**：按声明顺序执行（顺序是领域知识，原语只强制「声明顺序＝执行顺序」）→ 声明了 `done` 幂等判据的步骤 done=true 即续段跳过（「已存在即续段」原语化；无 done = 每次都执行）→ 全部成功后经 sink 追加**恰一条** journal（复用既有 `state/journal.jsonl`，`kind='write_unit'`、`node=<op>`、`detail='steps=名:done|skipped,…'`、ts 经 Clock 端口——零新日志文件）。失败：步骤 k 抛错即上抛中止，不回滚不续跑、失败不写 journal（与原 26 处「同事务」注释的今天语义逐条对齐）；恢复走 dataCheck/doctor/rebuild。
- **七站点**（`scripts/scan-write-unit.mjs` 的站点清单，键 = 相对 src/ 的 posix 路径——views/proposals.ts 与 engine/proposals.ts 同名，按文件名计数会互相覆盖）：applyEdit 9 步／applySeed 8 步／applyEnrich 5 步（proposals.ts）、nodeComplete 5 步／optimizeFsrsParams 4 步（sched-subsystem.ts）、experimentStop 3 步（nof1.ts）、settleRechecks 每条目 2 步（growth-subsystem.ts）。今天语义对照表与三处形状裁定见 #176 票评论。
- **G9 写入单元门**（`tests/arch-guards.test.ts`）：src/ 零「同事务」注释（顺序知识只住步骤声明）+ 七站点各自必须经 `runWriteUnit`（迁移回退/新增跨文件落盘绕开原语即失败）；自检：残留被抓、调用数不足被抓、站点文件改名被抓（幽灵清单）、齐备则绿。

架构门 G1–G7（2026-09-11 新增，#165 / ADR-0047；`tests/arch-guards.test.ts`）：

把「约定只活在注释与 ADR 里」变成会失败的东西。全部零依赖、文本／加载／编译层面、`node:test` 原生、随 `npm test` 全量执行。两条铁律：**每个门都带自检**（构造必然违规的样本并断言门会失败；收集器类门另断言它能看见目标形态——R3 曾因收集器只收相对说明符而**恒过**，恒过的门比没有门更坏）；**棘轮是精确匹配**（实际 == 基线，涨了失败、**降了但未同步下调基线也失败**＝过期即失败）。

| 门 | 内容 | 档位 | 阈值来源（实测） |
|---|---|---|---|
| G1 未定义标识符 | 剥注释与字符串后「被当函数调用却未声明未导入」即失败（`scripts/undefined-scan.mjs`） | 硬门 0 | 0（`shuffled` 修复后）。**已由 G7 的 TS2304 接管**（同一形态的编译期权威判据），本门留作零依赖兜底 |
| G2／G2b／G2c 宿主装配面 | 动态 import `src/index.ts` 与 `host/*`；入口三件套 `name`／`inject`／`apply` 齐备、技术层导出在（#168 起 `need` 归 `host/params.ts`、路由表归 `host/route-table.ts`／`routes.ts`／`routes-post.ts`）、入口文件非空；G2c＝宿主除常量外零模块级 `let`（`scripts/scan-host-state.mjs`，受控面**动态发现**＝index.ts + host/**/*.ts；ADR-0048） | 硬门 | 绿。**G2 的加载冒烟不可退役**——tsc 看不见模块级初始化路径。G2c 受控面 14 个文件、模块级 let 0 |
| G3 窄面三向一致 | deps 声明 ↔ 类体 `this.e.X` 实用 ↔ 门面 `new XSubsystem({…})` 的接线键。**四个方向全为硬门 0**（dead／missing／unwired／surplus） | 硬门 0 | 声明 **186** ／ 实用 186 ／ 接线 **186** ／ 多余 **0**（9 个子系统；#171 曾清掉 30 条多余接线——10 phantom + 20 未使用——后由棘轮转硬门；落笔时三向 167，现值 186 随 #158/#159/#161 新增命令域自然增长，基线同步） |
| G4 窄面宽度（三槽位） | `handles`／`facade`／`fns` 逐子系统卡基线；`handles ≤12／facade ≤20／fns ≤10` 是**非活动目标** | 棘轮 | 实测最大 handles **11**／facade **21**／fns **0**（fns 对预算已绿；handles 11 贴 ≤12 上限；facade 21 已越 ≤20 非活动目标——目标是落笔时的愿望值，活动门是逐子系统基线，越线要靠重划解决而非就地收紧） |
| G5 文件规模 | `src/` 下逐文件行数卡基线（行数口径＝`wc -l`）；白名单：`engine/views/` 叶子、`engine/types.ts`（共享类型与枚举大表） | 棘轮；`engine ≤600／宿主 ≤900` 是**非活动目标** | **12 个受控 engine 文件超 600**（content 1812、proposals 1537、question-bank 1484、projects 1397、learner-cards 1337、note-source 1242、growth-subsystem 1069、content-subsystem 1026、data-check 815、index 789、nof1 785、sessions 630）；宿主最大 `jobs.ts` **855**（#161 合并入队钩子、#160 种子链 triggerSeedContent），**无宿主文件超 900**（`index.ts` 3029 → 91 薄入口见 #167；`api.ts` 999 → 60 见 #168；`tools.ts` 1040 → 127 见 #169 agent 切面，#169 后表生成路径取代了 `routes.ts`／`routes-post.ts`，两文件已退役）。活动门＝逐文件基线（**104** 个受控文件；#163 新增 `engine/coach-tools.ts`） |
| G6 顶层不变量 | 除教练层 `proposals.ts` 外无模块调用图写原语（`GraphStore.writeRegionDoc`，`data/*.yaml` 的唯一写路径） | 硬门 | 绿（唯一调用者就是 `proposals.ts`） |
| G7 类型门 | `tsc --noEmit`（根 `tsconfig.json`；`module`／`moduleResolution` = `nodenext`、`noEmit`；#178 批3 起 `strict: true`）逐文件错误数卡基线 | 棘轮 | 扫描面 `src/`：**0 处 / 0 个涉错文件**（基线 `typeErrors` 空表）。实测链：main **196 处 / 17 个涉错文件**（未清理）→ #171 **181** → #170 **80 处 / 9 文件** → #168 **75 处 / 11 文件**（错误随代码搬移）→ **#178 四批清零**（批1 门面接线伸进子系统的 31 个 TS2341 放宽为公开面；批2 TS2322 全清 + 两处潜伏 bug；批3 根 tsconfig 转 `strict: true`、24 处残差清零；批4 ui 依赖侧 86 处清零）→ **0/0**。UI 类型门：`ui/src` 0 错、依赖侧存量债 **0 处**（`npm run typecheck` 串行跑） |
| G8 适配器面 | engine 内时钟直读（`Date.now(`＋无参 `new Date()`，含模板串插值）／`Math.random`／`node:fs` import 数／fs 调用点数四标量卡基线（`scripts/scan-adapter-face.mjs`） | 棘轮 | 实测链：阶段①第一刀 **clockReads 29／mathRandom 0** → 时钟清扫 **clockReads 1**（唯一余量 = io.ts `atomicWrite` tmp 命名的登记例外；`tests/clock-rng-port.test.ts` 断言固定时钟+定长随机流下同输入同输出）→ 阶段② **fsImports 0／fsCalls 0**（engine 内零 node:fs——`VaultFs` 端口住 io.ts、实现住 host/vault-fs.ts、装配住 EngineConfig.fs） |

门的三处实现事实（照着改时别踩）：

- **G3 的第三方向只取接线字面量的 brace-depth-1 键**：`ChannelsSubsystem` 的接线里 `registry: { load, loadNoteSources, save, get }` 是嵌套窄子面（`ChannelsDeps` 正以结构化窄面声明它），按扁平正则抽取会把子面成员误计为顶层接线——实测会伪造出 **4 条不存在的 phantom**。G4 的「顶层成员计，嵌套子面不计」是同一条判据。自检：夹具有嵌套子面 + 一条多余接线，断言接线键恰 5 个、phantom 恰 1 条。
- **G4 的槽位归属是声明形式规则**：值属性 → `handles`（领域实例与值）、方法签名（含 generator）→ `facade`（回引门面）、函数型属性（`jolRng: () => number`）→ `fns`（注入的纯函数）。规则写在 `scripts/scan-deps-face.mjs` 头注释里。
- **G6 的白名单是紧的**：`graphApply('enrich')` 从 `growth-subsystem.ts`／`projects.ts` 直调 `proposals.*` 属提案门内的教练层行为，不触本门（ADR-0044 已登记）；原语定义处 `graph.ts` 不算调用者。自检：白名单外的调用（含解构别名）必须被看见。
- **G7 的扫描面自检靠 `--listFiles`**：测量与诊断同一次 `tsc` 调用取回（`scripts/scan-types.mjs`），门断言「src/ 里每个 `.ts`／`.tsx` 都被 tsc 读到」——只看错误数无法区分「干净」与「根本没扫」，这正是 R3 恒过的形状。另：tsc 只报无文件位置的错（tsconfig 写坏）时测量**抛错**而不是静默返回空集。**typescript 与 @types/node 精确锁版本**：错误数随工具链版本漂移，换档必须与基线同提交。
- **G7 的收窄档位**：`strict: false` 下真假分支不参与字面量联合收窄（`if (!x.ok)` 不收窄、`if (x.ok === false)` 收窄）——#170 实测，清理时统一改用显式比较。

棘轮基线与操作（`scripts/arch-baseline.json` + `scripts/arch-baseline.mjs`）：

- 基线记录每个受控量的实测值：逐子系统的声明／实用／接线数与三槽位计数、逐文件行数、**涉错文件的类型错误数**（只记有错的文件，未列出即 0 处）。**基线只在清理提交里下调**；涨了先看这行长在哪、能不能不长。
- 基线自身也自检**幽灵条目**：删了子系统／文件／修好一个文件却留下基线条目 = 永不复活的门，一并失败。
- 看当前实测与违规：`node scripts/arch-baseline.mjs`（全部受控量，违规退出 1）；单看类型门：`npm run typecheck`（= `node scripts/arch-baseline.mjs --types`）；单看窄面：`node scripts/scan-deps-face.mjs`；单看规模：`node scripts/scan-budget.mjs`；单看类型清单：`node scripts/scan-types.mjs`；单看顶层不变量：`node scripts/scan-invariant.mjs`；按实测重写基线：`node scripts/arch-baseline.mjs --update`。
- 四个「装配」方向（dead 声明未用／missing 用而未声明／unwired 声明未接线／surplus 接线未声明）**不进基线**——它们必须是 0，由 G3 直接卡（这些是装配断裂，不是可以棘轮化的债；`surplus` 在 #171 清到 0 后由棘轮转本档）。
- `npm test` = **类型门**（`npm run typecheck`）+ 全部规则与行为测试（类型门在 `tests/arch-guards.test.ts` 的 G7 里再跑一次同一份对照，故单独 `node --test` 也拦得住）。

