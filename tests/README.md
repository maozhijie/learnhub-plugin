# 测试

`node --experimental-transform-types --test tests/`（Node >=24 原生 TS + `--experimental-transform-types`，零测试框架依赖；facade 测试需要 transform 模式处理注入类的 constructor parameter properties，引擎门面测试直接实例化 `LearnhubEngine`）。

## 测试缝与 vault 工厂（ADR-0013，2026-09-09）

- **`engine.store` 是正式测试缝**：D14「一切数据访问收口 engine 门面」是运行时纪律（工具/路由/UI 不得绕过）；测试侧的播种与断言走类型化的 `engine.store`（`reviewLogAll`/`appendPractice`/`loadPins` 等），这是文档化契约，不是后门。运行时代码零消费者（宿主/客户端/UI 均不触）。勿建 Probe 镜像、勿提议 store 私有化。
- **`tests/helpers/vault.ts` 是共享 vault 工厂**：`withVault(options, run)` 声明式生成临时 vault + `LearnhubEngine`（默认 = 单课程「数学」/单节点「入门」基线；options 覆盖 registry/graph/notes/banks/state 种子/中心外文件）；`run` 收 `{ engine, root, paths, store }`，重载荷场景（假 Anki 传输器、故意损坏档、空 vault）用 `root` 逃生口自行写文件。共享 helpers：`tfQuestion(id, opts)`（true_false 题目 YAML 行）、`noteText(...)`（节点笔记 frontmatter）、`answer(engine, ...)`（作答包装）。

接缝（2026-09-07 与用户确认）：

- S1 `quality.ts::jumpCandidates` —— 认知跨步候选（|Δdifficulty|≥2 或 depth 跨度 ≥3）
- S2 `quality.ts::floatNodes` —— 空降节点（region 序后 3/4 且 pre 空）
- S3 `health.ts::graphHealthScore` —— 前置完备项基于 S2
- S4 `quality.ts::scaleReport` —— 规模底线对照（**已随 #138 cutover 退役**，函数与登记一并移除）
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
- S15 `ui/src/components/svg-uri.ts::SVG_URI` —— SVG 清洗 URI 白名单（DOMPurify 逐属性值筛查语义；`tests/svg-uri.test.ts`）
- S16 `ui/src/components/quiz-rules.ts::passStreakFor` —— 练习轮连对目标随组内题量收缩（`tests/quiz-rules.test.ts`）
- S17 `ui/src/components/md-chain.ts::MD_HTML_POLICY` —— markdown 链 skipHtml 策略（机器注释不显示；`tests/md-chain.test.ts`）
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
- S41 `project-decompile.ts::decompileGoalOf / decompileTerms / splitDecompileDoc / subgraphSpecOf / decompileRepairPrompt` —— P-5 目标反编译纯函数层（空目标拒绝、检索词派生同 priorTerms 口径、双产物拆分校验 = validatePlanArtifact + validateGenProposal 同门、子图落点裁决 append/new、修复轮提示词；`tests/project-decompile.test.ts`；双提案受理/apply/红线零写入走 facade）
- S42 `project-exec.ts::execRatingScore / exercisedEncEdges / classifyCross / masteryAggregate / execEvidenceScore / recommendTier` —— P-7 项目执行事件流纯函数层（评级→0-1 带中点映射、被行使 enc 边判定 v1=两端都在事件 nodes 内、2×2 象限分类（null 归该轴低侧）、入档推荐纯函数（档内表现+底座，永不做门禁）；`tests/project-exec.test.ts`；回流→mastery→2×2 主链与零 canonical 红线走 facade）
- S43 `calibration.ts::overconfidenceOf / calibrationProfileView / calibrationHintText` —— Self-Calibration 自评校准画像（ADR-0022 #104）：「会」档系统性过信判定（≥JOL_CALIBRATION_MIN 条配对且实际正确率低于显著阈值；数据不足静默）、分源画像聚合（jol 源直调 jolCalibration 不 fork 数学；配对区间 first_ts/last_pair_ts 透出；全局参考视图带域特异警戒）与轻提示文案决策（`tests/calibration.test.ts`；画像入口/抽查密度加强 1/3→1/2/队列 calibration_hint/提示全局关/零 canonical 红线走 facade；编号 S43 = 让位 d-lab S37–S40，S41/S42 预留 p5/p7）
- S44 `output.ts::obsidianLink / outputArtifactFile / writeOutputArtifact / isRegistrableCenterRel` —— V-3 学习产物输出区（`学习中心/我的产出/<类>/`）：出链拼装（剥 .md/反斜杠归一/空路径拒绝）、文件名安全化（.. 拒绝、分隔全角化）、kind 白名单、注册豁免区判定（我的产出整区 + projects/<id>/日志.md 放行，其余中心内维持拒绝；`tests/output-zone.test.ts`；产物落盘/豁免区注册/引擎写后指纹自愈（自己的写不算漂移）/个人笔记零字节红线走 facade）
- S45 `kata.ts::weekStartOf / weekEndOf / prevWeekStartOf / inWeek / buildKataReality / parseKataBody / kataAnswered` —— U-4 周复盘纯函数层（ADR-0026）：学习周折叠（周一锚定、上一完整周、跨年边界）、现状聚合（周归属全经 dayOfTs 学习日折叠，凌晨归属随日界翻转；课程桶排除 milestone_settle 与 course='*' 执行 XP 行）、五问正文解析与作答判定（占位视同未答；`tests/weekly-kata.test.ts`；发起/保存/重开保留四问刷新现状/转换出口/零 canonical 零 XP 红线走 facade）
- S46 `vault-links.ts::parseWikilinks / stripCodeFences / isDateTarget / isNonMdTarget / normalizeLinkName / buildNameIndex / linkScore / scoreTier / mapEdgesToNodes / orientLinkPair / dirExcluded / readVaultLinkDirExcludes / scanVaultLinks` —— V-2 Vault 链接先验（#91）：单正则解析（嵌入/别名/锚点/.md 剥离、代码围栏排除）、资产扩展名白名单（含点标题不误滤）、全半角归一与 basename 索引（撞车取最短）、可解释加法打分与三层分级（≥0.7 提案 / 0.4–0.7 待裁决 / <0.4 报告）、候选边双端映射与 pre 闭包方向裁决（闭包外不成边）、目录段排除（x* 段前缀）与 learnhub.json 整体替换；`tests/vault-links.test.ts`；扫描去噪审计/缓存落 state/analyze 建议段/单提案回填可重入/个人笔记零写入走 facade
- S47 `note-source.ts::poolMirrorBody` —— V-4 卡池镜像正文（#108）：[[个人笔记]] wikilink + 卡数/到期快照 + 零写入红线条目；`tests/note-source.test.ts`；出题落镜像/解除随删/relink 跟随新路径走 facade
- S48 `sediment.ts::foldSediment / renderLearnerProfile / latestFsrsParams` —— 沉淀层读侧折叠（#139 / ADR-0034；#150 增第七类 nof1_outcome）：七类事件追加正典（即时/周分档，weekly 按 payload.week 归桶可重折）、latest/weekly/byConcept 三读法（两次折叠同输入同输出）、学习者档案纯渲染（手编必被覆盖）、FSRS 参数正典读法（缓存退役后删缓存不丢事实）；`tests/sediment.test.ts`；出生即写/断裂不变性（清内容层合成初始化仍取沉淀先验）/legacy 分区零消费/重置波及单独确认项走 facade
- S49 `llm.ts::LlmComplete` —— 宿主→引擎 LLM 补全注入缝（#137）：引擎侧生成/组装函数只依赖缝型（12 处回调签名统一），opts.effort 语义档 fast/deep 沿缝贯通、注入侧可观测（档位翻译成部署 fastEffort/deepEffort 收口在宿主 llmSeam 适配器）；`tests/llm-seam.test.ts`；固定回放假实现驱动出题全链字节级确定性、脚本化应答驱动判卷重问、learnerNoteAdd=fast / receiptSubmit=deep 档位观测走 facade
- S50 `concepts.ts::validateConceptEntry / validateConceptRegistry / namesOf / resolveConcept / conceptReferenceErrors / invokesUnregistered / mintConflicts / applyConceptMints / mergeConceptEntries / ConceptRegistry` —— 概念登记表（#141 / #122 契约 v0.1）：课程根/概念登记表.yaml 受控词表（条目 = canonical + 别名[] + 选填定义，全部名字联合唯一违约 Broken、文件缺失 Missing 合法空态且零 finding——选填域与我的卡同款）、精确匹配解析（canonical/别名 → 同一条目，永不模糊）、并入合并纯函数（名字并集、旧地址经别名续解析、definition 缺省回退）、铸名冲突双门（propose 从严同条目也拒 / apply 幂等同条目跳过）、引用对表（teaches/assumes/误解/invokes 未在册可执行拒收行）；`tests/concept-registry.test.ts`；铸名随 edit 提案 concepts 块与图 apply 同事务（被拒不落盘）、登记表 Broken 读侧抛错、data-check concept_registry 类走 facade
- S51 `coach-round.ts::behaviorWindow / behaviorDigest / renderBehaviorDigest / readyDepthCheck / renderSedimentForCoach` —— 教练回合感知面（#144 / ADR-0033）：行为摘要五件套读侧折叠（窗=最近 7 学习日或 10 节取大、错误按 invokes 概念聚合+停滞天数、est vs 实际滚动比+JOL 过信率、误解活跃度不硬猜归属、到期复习真实保留率；即算即用不落盘，全部注入式确定性）、就绪深度检查（默认 3、clamp [2,5]、冷启动首周（锚声明起 7 天）需求 ×1.5 ceil、ready=0 只告警不阻塞）、沉淀折叠教练投影（消费从 sedimentFold 单向取）、双沙盘仲裁参照（#150：arbitrationPopulations 现状照走 vs 含本批照走的两份总体、renderArbitrationEvidence 非承诺参照块）；`tests/coach-round.test.ts`；六区块上下文包定序（终点锚→行为摘要→登记表档位→误解目录→罗盘尾段→V-2 接缝）与轻量包恰两件、触发三点接线（nodeComplete 结果携带/statusJson 附 coach/宿主泵队列空闲留运行日志）走 facade
- S52 `gengraph.ts::GROWTH_OPERATORS / consolidationGateErrors` + `content.ts::PROMPT_KINDS['教练回合']` —— 生长批受理（#145 / ADR-0033）：edit 提案 note 区 {operator, reason, disagreement?} 严格 schema（算子枚举锁死、未知键拒收；避让「申诉 Dispute」词条）、route 只随生长批携带（「剩余路线」唯一写权属教练回合生长批）、零操作生长批合法（ops: [] = 暂不产结构）、提案 op 边轻键拒收（origin/status/probation 一律 fail loud）、巩固门（operator=巩固 的 add_node 概念引用 ⊆ 既有图 teaches 并集，propose/apply 双门）、apply 同事务罗盘重写（路线门+锚在写盘前全过，提案被拒罗盘不落盘）；`tests/coach-growth.test.ts` + `tests/gen-proposal-validation.test.ts`；coachGrowthBatch 三段式回合（#145/#150：轻量段 fast 恒 1 调用、分歧升级全量段 deep 恒 2 次、全量段仍真分歧升级双沙盘仲裁段恒 3 次——两份沙盘推演是读侧计算不计调用数、segments 可观测）、金样本组装字节级确定性、停机转译（check.ok 零调用停摆）、宿主队列 phase=生长 与生长→内容链走 facade

A3 门面行为（建议项出现/消退、软闸不拦人、reviewQueue node 过滤直达、struggle 事件与静默）走引擎门面黑盒：`tests/a3-remediation.test.ts`。

`analyzeGraph`/`runAudit` 只做薄接线，不在接缝清单内。