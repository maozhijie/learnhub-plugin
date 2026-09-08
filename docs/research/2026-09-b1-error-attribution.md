# 调研：错题归因到节 + 定向重写触发/冷却规则（Arc B1）

- 日期：2026-09-08
- 状态：规则建议（供 grilling 票 #40 引用决策；不含实施排期）
- 评价维度：小样本下的稳健性 > 与既有数据模型/决议（ADR-0007、#19 口径收敛）的契合 > 实现成本
- 源材料：本仓库代码（`src/engine/`、`ui/src/`、`src/index.ts`，行号见各论断处）+ 既有调研笔记（[2026-09-big-directions.md](2026-09-big-directions.md) §4 B1、[2026-09-node-content-quality.md](2026-09-node-content-quality.md)）+ CONTEXT.md/ADR；外部产品实践仅作形态参照并标注证据强度（出处见 §7）

## 0. TL;DR

1. **归因现状：数据已备、聚合缺位。** 新管线每题带 `section`（服务端强制为节 id，`src/engine/index.ts:1393`），综合题强制「通用」（`:1331`）；旧题 section=标题原文，前端轮装配已有成熟的「id 优先 + 归一化标题回退 + 综合收尾轮」匹配器（`ui/src/components/PracticeFlow.tsx:79-131`）。但**引擎侧没有任何按节聚合的消费方**——`bankSnapshot`/`nodeMastery` 全是节点级。归因的工程本质 = 把前端匹配器抽成共享函数 + 引擎侧做节级聚合。
2. **触发建议：双规则 + 分母门槛，不采用票面两个单一方案。**「错题数 ≥ N」会被分散错题误伤，「整节正确率 < 阈值」扛不住小样本——建议 R1（单题持续失败：`fsrs.lapses ≥ 3`，leech 式）+ R2（整节窗口正确率：自节版本锚点以来按（题，日）去重作答 ≥ 4 次且正确率 < 0.5）。两层信号只消费「作答正确率」词汇（CONTEXT.md Answer Accuracy），**不消费 Mastery**——与 ADR-0007「判定掌握」与「内容诊断信号」分层对齐。
3. **冷却建议：7 天，纯派生、零新增文件。** 触发后同一节 7 天内不重复触发；判据 = 该节最近一次 signal 事件或 `content_section` 落盘事件（谁晚取谁）+ 7 天。R2 的分子分母在节版本递增（重写完成）后自动归零（新正文新证据）；R1 的 lapses **不**重置（单节重写不动题库），二次触发升级人工而非再重写。

## 1. 归因：单题作答证据如何归因到节（代码现状核对）

### 1.1 `q.section` 数据现状

| 事实 | 出处 |
|---|---|
| `BankQuestion.section?: string`，注释「来源正文节标题…缺省归入『通用』收尾轮」；schema 只透传不校验内容 | `src/engine/question-bank.ts:44-45,171` |
| 逐节管线出题时**服务端强制** `section = 节 id`（`s.id`，模型无自由度） | `src/engine/index.ts:1384,1393` |
| 跨节综合题 `section` 强制「通用」 | `src/engine/index.ts:1331` |
| 面板手动出题（`/question-generate`）不带节清单 → section 由模型自定或缺失 | `src/index.ts` `/question-generate` 段；`src/engine/index.ts:1296` |
| 每内容节出题量地板 2（低/中/高档 2/3/4） | `src/engine/complexity.ts:166-177`（TIER_ANCHORS）；commit 662a956 |
| 交互件成绩以合成题 `qid = interactive:<sectionId>` 记入作答流水，`correct = score ≥ PASS_SCORE(0.6)` | `src/engine/index.ts:1411-1428` |

结论：**新管线题库的 section 绑定是可靠外键**（服务端强制、非模型自由文本）；风险面在旧库（section=标题原文）与手动出题（section 缺失/自拟）。

### 1.2 已有的归因匹配先例（前端轮装配）

`ui/src/components/PracticeFlow.tsx:79-131` 的 `buildRounds` 就是事实上的归因规则，且已在生产消费：

1. `q.section === m.id` → 绑定该节（新管线）；
2. 否则 `normSection(q.section) === normSection(m.title)` → 归一化标题回退（旧题：剥「类型：」前缀 + 去空白，`:44-47`——注释明言 AI 的 section 标注常有前缀/空白差异）；
3. section 缺失或「通用」或匹配不上 → 进「综合」收尾轮（`:126-131`）；
4. 无清单旧节点：按正文节标题匹配（`:108-122`；引擎侧 `manifestFromBody` 同语义回退，`src/engine/index.ts:599`）。

**缺口**：该匹配器只活在 UI。引擎所有聚合都是节点级——`bankSnapshot`（due/count/accuracy/attempts，`src/engine/index.ts:180-215`）、`nodeMastery`（Σcorrect/Σattempts，`:1008-1019`）、`questionsAll`/`questionView` 只透传 section 不聚合（`:731`）。

### 1.3 归因规则建议（R0）

- 把 `buildRounds` 的匹配逻辑（含 `normSection`）抽为**共享纯函数**（如 `src/engine/section-match.ts`），UI 轮装配与引擎归因共同消费——否则两处规则必然漂移。
- 交互节：`interactive:<sectionId>` 的 practice 记录按 sectionId 直接归因，与题目证据同池进入 R2。
- 「通用」/匹配不上的题：**v1 明确不参与节归因**（跨节综合题失败指向节点级问题，属 B2 难度感知出题或人工审题的范围）；报告留口子，不在本票扩大 scope。

## 2. 触发：阈值规则设计

### 2.1 先分层：判定掌握 ≠ 触发重写信号

ADR-0007（#19/#31 决议）已定：Mastery = `masteryOfFm`（FSRS 稳定度 + 练习 EMA 派生，节点级、读侧、不落盘）；题库正确率立为独立词汇「作答正确率」，只服务完成门禁与单题作答统计。B1 触发器的对齐方式：

- **不把 `masteryOfFm` 当触发条件**。理由①粒度错配——重写动作的单位是节，mastery 是节点级；理由②语义错配——mastery 表达「学习者学到什么程度」，触发器回答「哪节正文没把事情讲清楚」，后者是**内容诊断**，证据源天然是作答统计（Answer Accuracy 词汇）。
- 这样也避免再造 #19 式口径分裂：触发器读的字段全部在「作答统计」词汇内，UI 若展示触发建议，文案说「此节作答表现持续偏低，建议重写」，**不得**表述为掌握度（CONTEXT.md Answer Accuracy 条目禁令）。

### 2.2 R1：单题持续失败信号（leech 式）

- **规则**：绑节题 `q.fsrs.lapses ≥ 3` → 触发该节。
- **为什么 lapses 可直接用**：题目级 FSRS 每题每天至多推进一次（`src/engine/index.ts:869-875` 注释与实现），lapses 只在 rating=1 时 +1——它就是**天然按日去重的遗忘计数**，零扫描、无需窗口。
- **默认值 3 的理由**：Anki 的 leech 默认 8 次 lapse（阈值可配、半阈值再预警、tag note + 可选 suspend，见 §7[1]），但其语义是「大卡库里隔离一张坏卡、弃卡成本低」；learnhub 每节仅 2-4 题、一张题反复遗忘意味着该节 1/4~1/2 的题持续失效，且重写成本仅 1-2 次 LLM 调用（实测单节生成 15-25 秒，见 [2026-09-node-content-quality.md](2026-09-node-content-quality.md) §3）——取 8 的约一半压到 3，是「初值实现时可按实测校准」的锚点初值（先例：`src/engine/complexity.ts:160` 收敛记录的措辞）。
- R1 触发时在 signal 事件里记 `base_lapses` 快照。

### 2.3 R2：整节窗口正确率信号（小样本安全）

- **规则**：自该节**锚点**（最近一次 `content_section` 落盘，即 manifest 该节 version 递增；无事件则课程起点）以来的窗口内，该节证据的作答次数 N ≥ 4 且 正确率 < 0.5 → 触发。
- **分母口径（关键）**：按（qid, 本地日）去重。同日重复作答（「再做一次」）现状已只记 stats 不推卡不给 XP（`:842-847`）——同日重试是输入修正不是独立证据，R2 分母不应收它。`questionForget`（忘记，按答错记）与交互件 settle 都计入；`questionRate`（已复习自评）现状即不动 stats 不记流水（`:928-945` 注释「只推卡」）→ 天然不产生信号。
- **N ≥ 4 的理由**：出题地板 2 题/节（662a956），4 次按日去重 ≈ 每题至少两个不同日的独立证据；统计上 rule of three 说明 n=4 时即使 0 对，真实错误率 95% 置信上界也只有 3/4=0.75（§7[2]）——**所以本阈值不是统计证明，是干预启发式**：重写成本（一节 1-2 次 LLM 调用）足够低，宁可早诊；而 N < 4 时不动——首次全错更可能是首次接触而非正文烂，此时正确介入是复习与 AI 讲解（Arc D），不是烧重写。
- **正确率 < 0.5 的理由**：严格低于完成门禁及格线 PASS_SCORE=0.6（`src/engine/grading.ts:89`；nodeComplete 现行门禁 `attempts ≥ 3 && accuracy < 0.6`，`src/engine/index.ts:1070`），留小样本噪声余量：n=4 时 0.5 线意味着最多对 1 题——已是压倒性的失败形态，不是边缘波动。
- **回应票面二选一**：「错题数 ≥ N」不作独立规则——错题分散在多节会误伤无关节；「整节正确率 < 阈值」不作唯一规则——无分母门槛扛不住小样本。R1 管「单题反复忘」（内容或题目本身有问题），R2 管「整节学不会」（讲解有问题），正交且都带分母/去重门槛。

### 2.4 明确不触发的情况

- 节点级 struggle 提示（`sessions.ts:224` 消费 `bankSnapshot.accuracy`）与 R1/R2 无关，不改。
- 「通用」收尾轮证据不归因（§1.3）。
- 同日重复作答不推分母（§2.3）。
- 触发只对**已生成且有节绑定证据**的节有意义；无 manifest 旧节点回退标题匹配，匹配不上就不触发。

## 3. 数据从哪读：字段、路径、落点

触发评估器建议做成**纯派生只读函数**（与 `bankSnapshot`、`activityCounts` 同型；后者注释明言「行为流水即事实，零新增文件」）：

| 读什么 | 哪里 | 用途 |
|---|---|---|
| `q.section`、`q.stats`、`q.fsrs.lapses` | 题库 YAML（`QuestionBank.load`，`src/engine/question-bank.ts:199`；`stats` schema `:49-51`） | 归因绑定 + R1 lapses + 节内题目清单 |
| 节 manifest（id/title/version） | 笔记 frontmatter `content.sections`（`src/engine/types.ts:17-25`；`sectionApply` version+1 `src/engine/content.ts:773-817`） | 归因回退 + R2 锚点（version 递增时刻） |
| 窗口作答事件 | `state/practice.jsonl`（`PracticeRec{ts,course,node,qid,correct,judge}`，`src/engine/paths.ts:32`、`store.ts:78-96`、`types.ts:103-117`；`practiceAll` 注释「量级小，全读可接受」） | R2 分子/分母（按（qid,日）去重）+ 忘记/交互件证据 |
| 重写落盘历史 | `state/journal.jsonl` kind=`content_section`（`content.ts:817`；写入链 `src/engine/index.ts:581`） | 锚点时刻 + 冷却判据之一 |
| 触发留痕 | journal 新 kind=`section_regen_signal`（detail 带节 id + 规则 + 快照数字） | 冷却判据之二 + 升级判定 |

**冷却状态存哪：不新增任何持久化状态。** journal + practice.jsonl 都是既有追加型流水，冷却/锚点/升级全部可派生（单学习者本地场景，全读成本可忽略——与 `activityCounts` 同一先例）。备选方案（节 manifest 加可选 signal 字段）被否：manifest 是内容管线状态（types.ts `SectionManifest`），混入触发器状态会污染 schema 校验（`notes.ts`）且违背「派生视图不落盘」的 ADR-0007 精神。

**实现注意**：`content_section` 的 journal detail 现在只有节标题没有节 id（`content.ts:817` `节「title」vN 落盘`）——新事件应在 detail 补节 id，旧行按 `normSection` 标题归一回退（与 UI 同一函数，§1.3）。

**消费路径**：v1 触发 = journal 留痕 + 面板建议（LessonView/节点页「此节作答表现持续偏低，建议重写」），由人或 agent 点火既有 `POST /generate/section`（`src/index.ts:735-740` → `generateSection` `:397-406`，同一门禁 + 一轮带定位修复，入全局串行队列）。自动入队留作后续开关（`enqueueGeneration` 已存在），但队列全局单并发（`:252+`），自动重写会挤占新课生成——默认不自动。

## 4. 冷却与学习者行为矩阵（Q4）

- **冷却时长：7 天（默认）**。理由：重写后学习者需要至少一个完整 FSRS 复习周期才能给出新证据（首答后 FSRS 首间隔通常在 1-7 天量级）；7 天内 R2 窗口分母本来就攒不够（≥4 个不同日），冷却实质是防止 R1（lapses 累积不重置）在重写后立即再触发。R1/R2 共用同一冷却。
- **正文版本递增时计数是否重置**：R2 重置——窗口锚点就是节 version 递增时刻，重写完成后分子分母自动归零（新正文新证据）；R1 **不重置**——单节重写不动题库（只有整课重置 `contentReset` 才把题库移 trash，`src/engine/index.ts:533-570`），同一批题的 FSRS 卡历史延续。
- **触发后重复触发**：冷却期内一律抑制；冷却期满后 R1 若再 +1 次 lapse（`base_lapses` 快照被超越）→ **二次触发升级为人工处理**（题目质量问题走题目管理/归档，前置缺失走 Arc A3 前置复习建议），不再自动建议重写——映射 Anki「半阈值预警」的防骚扰语义（§7[1]），避免对「问题不在正文」的节反复烧 token。

| 学习者行为 | 代码现状 | 对触发的影响 |
|---|---|---|
| 同日重做（「再做一次」） | 记 stats 与 practice 流水；不推 FSRS 卡、0 XP | 不计 R2 分母（去重口径）；不影响 R1 |
| 忘记（questionForget） | 按答错记 stats+practice，推 rating=1 | 计 R2（答错）；lapses+1 可促 R1 |
| 复习刷卡答对 + 自评（questionRate） | 只推卡，不动 stats、不记流水 | 无任何触发影响 |
| 复习刷卡答对（deferSchedule 作答） | 记 stats+practice（appendPractice 无条件） | 计 R2 分子分母（复习期答错是最强内容失效证据） |
| 交互件结算（interactiveSettle） | qid=`interactive:<sectionId>`，correct=score≥0.6，同节同日一次 | 计 R2 |
| 手动单节重写（面板「重写」按钮） | 走同一 `POST /generate/section` → `content_section` 事件 | 等同自动重写：重置 R2 窗口 + 开启 7 天冷却 |
| 手动改题/归档（questionUpdate/archive） | 题面或归档变更 | 归档题退出证据池（`bankSnapshot` 同款过滤）；改题后建议人工顺手重写该节（引擎不做题目级脏标记，留观察项） |

## 5. 参数默认值表（供 #40 grill）

| 参数 | 默认 | 理由与调整方向 |
|---|---|---|
| R1 lapses 阈值 | 3 | Anki leech 8 按卡库规模/成本结构缩小（节均 2-4 题、重写 1-2 次调用）；锚点初值，实测后可校准（complexity.ts 先例） |
| R2 窗口分母 N | ≥ 4 | 出题地板 2 题/节 × 每题两个不同日；N<4 宁可不动（首次全错 ≠ 内容差） |
| R2 正确率线 | < 0.5 | 严格低于完成门禁 0.6，小样本噪声余量；n=4 时等价「至多对 1 题」 |
| R2 分母口径 | 按（qid，本地日）去重 | 同日重试非独立证据（FSRS 侧已同日只推进一次，口径对齐） |
| 冷却时长 | 7 天 | ≥ 一个 FSRS 复习周期；期间 R2 分母本就攒不够，实质挡 R1 立即复发 |
| 二次触发 | 升级人工处理 | Anki 半阈值预警映射；问题可能不在正文（题目差/缺前置） |
| 自动入队 | 默认关 | 全局串行生成队列会被挤占；v1 只建议 + 留痕 |

## 6. 边界与反模式

- 不把触发信号当掌握度展示（ADR-0007 / CONTEXT.md Answer Accuracy 禁令）。
- 不用深度知识追踪模型——单学习者稀疏作答下深度 KT 显著退化（[2026-09-big-directions.md](2026-09-big-directions.md) §2 共识），R1/R2 的轻量规则 + FSRS 现成 lapses 已够。
- 不因触发而自动改题库——单节重写只动正文（代码现状），题目层问题走题目管理/归档；两者混在一起会把「正文没讲清」和「题出得烂」的责任搅浑。
- 「通用」轮与匹配不上的旧题不硬归因——错误的归因比没有归因更糟（重写错节 = 烧 token + 洗掉好正文）。

## 7. 出处

**本地代码（一手）**

- `src/engine/question-bank.ts:44-51,171`（section 字段与 stats schema）、`:199`（load）
- `src/engine/index.ts:1393`（逐节出题强制 section=id）、`:1331`（综合题「通用」）、`:180-215`（bankSnapshot 节点级聚合）、`:1008-1019`（nodeMastery）、`:799-907`（questionAnswer：stats 写入/同日重复/乱猜/deferSchedule）、`:928-955`（questionRate 只推卡）、`:957-1005`（questionForget 按答错记）、`:1041-1073`（nodeComplete 门禁 attempts≥3 && <0.6）、`:1411-1428`（interactiveSettle）、`:533-570`（contentReset 才动题库）、`:581`（content_section 入 journal）
- `src/engine/complexity.ts:160-181`（TIER_ANCHORS 出题地板 2/3/4，commit 662a956）
- `src/engine/content.ts:773-817`（sectionApply version+1；journal detail 无节 id）、`src/engine/grading.ts:89`（PASS_SCORE=0.6）
- `src/engine/store.ts:26-96`（journal/practice JSONL 追加；activityCounts「行为流水即事实」）、`src/engine/paths.ts:30-34`（state 路径）、`src/engine/types.ts:17-25,88-117`（SectionManifest/JournalRec/PracticeRec）
- `src/index.ts:220-249`（applySectionWithRepair 门禁+一轮修复）、`:397-406`（generateSection）、`:735-740`（POST /generate/section）、`:252+`（全局串行生成队列）
- `ui/src/components/PracticeFlow.tsx:44-47,79-131`（归因匹配先例）、`ui/src/components/quiz-rules.ts`（连对过关基准）

**内部文档（一手）**

- `CONTEXT.md`（Mastery / Answer Accuracy / Section / Question / Missing / Broken 词汇）
- `docs/adr/0007-mastery-canonical-derived-not-persisted.md`（掌握度口径收敛决议）
- `docs/research/2026-09-big-directions.md` §4 B1（本票上游）与 §2（稀疏数据下深度 KT 退化共识）
- `docs/research/2026-09-node-content-quality.md` §1/§3（管线结构、单节生成 15-25 秒实测）

**外部（形态参照，已标注证据强度）**

1. Anki 手册 Leeches：默认 8 次 lapse 触发、阈值与 suspend 可在 deck options 调整、半阈值再预警、tag note——一手产品文档，**语义参照**（阈值数值不照搬：卡库规模与重写成本结构不同）。https://docs.ankiweb.net/leeches.html
2. Rule of three（统计学）：n 次独立试验 0 次事件时，真实发生率 95% 置信上界 ≈ 3/n——标准统计口径（数学事实），用于论证「小样本下正确率阈值是干预启发式而非估计」。[Rule of three (statistics) — Wikipedia](https://en.wikipedia.org/wiki/Rule_of_three_(statistics))
3. Duolingo Birdbrain（作答期按预测正确率选题）：官方博客，经 [2026-09-big-directions.md](2026-09-big-directions.md) §2 引用——**形态参照**：行业消费作答数据在作答期选题侧，无「错误驱动重写正文」的规模证据。
4. Math Academy 定向补漏/知识缺口回填：The Math Academy Way working draft（Justin Skycak）确实公开存在（https://www.justinmath.com/books/#the-math-academy-way），但「fail-fast 重修」的具体措辞**未在一手文本核实到**——按票面要求标注：**形态参照，无一手出处核实，无规模证据**。
5. CQELedu（IEEE Access 2025，错误驱动练习再生成）：经检索摘要引用（见 [2026-09-big-directions.md](2026-09-big-directions.md) §10 注），**形态参照，无规模证据**。

> 证据强度总注：本报告全部代码论断有文件行号一手出处；外部条目均为形态参照——成熟证据仅 Anki 官方文档（leech 语义）与 rule of three（数学事实），无任何「错误驱动正文重写」效果的外部规模证据，因此本票的所有阈值默认值都应被视为「锚点初值，按实测校准」，与 complexity.ts 收敛记录同一态度。
