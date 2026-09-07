# 测试

`node --experimental-transform-types --test tests/`（Node >=24 原生 TS + `--experimental-transform-types`，零测试框架依赖；facade 测试需要 transform 模式处理注入类的 constructor parameter properties，引擎门面测试直接实例化 `LearnhubEngine`）。

接缝（2026-09-07 与用户确认）：

- S1 `quality.ts::jumpCandidates` —— 认知跨步候选（|Δdifficulty|≥2 或 depth 跨度 ≥3）
- S2 `quality.ts::floatNodes` —— 空降节点（region 序后 3/4 且 pre 空）
- S3 `health.ts::graphHealthScore` —— 前置完备项基于 S2
- S4 `quality.ts::scaleReport` —— 规模底线对照
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

`analyzeGraph`/`runAudit` 只做薄接线，不在接缝清单内。
