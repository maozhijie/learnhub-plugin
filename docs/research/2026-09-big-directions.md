# 调研：后续大的新功能扩展方向

- 日期：2026-09-08
- 状态：方向调研（供 wayfinder 绘图选目的地；不含实施决策）
- 评价维度：学习效果证据 > 与既有架构/数据模型的契合 > 单学习者本地场景的可行性 > 实现成本
- 源材料：本仓库 `CONTEXT.md`/ADR/README + `docs/research/` 既有三份笔记 + 本次线上调研（出处见 §10）

## 0. TL;DR

learnhub 已经拥有别家没有的三样东西：**题目级 FSRS 卡**、**带 pre/enc 边的课程图**、**生成即校验的 LLM 内容管线**。行业（§3–§8）显示，下一步大方向的共同轴线是「**作答数据回流**」——把学习者行为喂回调度与生成。据此把候选方向聚成五条弧：

1. **Arc A · 从「到期队列」走向「会选题的调度」**（作答期自适应 + 图感知 + 记忆仪表盘）——改造最大、证据最强、全部在既有 per-question FSRS + 图数据上长出来，且天然单学习者友好。**首推**。
2. **Arc B · 错题回流内容**：全错/低掌握 → 重写节/补节/再出题（#15 主线的具体化），门禁前的硬前提是 #19 掌握度口径收敛。
3. **Arc C · Vault 即课程输入**：把个人已有笔记变成可调度学习资产 + 移动端 Anki 互通——扩产品面最猛、差异化最大，但范围扩张需先 grill。
4. **Arc D · 会话化学习**：AI 老师在「错误发生的当下」介入（而非泛泛答疑）——与宿主会话桥最配，但 Khanmigo RCT 显示自由对话效用有限，形态必须绑在错误点。
5. **Arc E · 主观能动性：把学习者变成内容的共同作者**（本版新增）——自建卡片/自注解释、把概念讲给 AI 听、目标与计划的所有权、预测-校准、自选难度的「教练」兜底。证据扎实（生成效应 d≈0.45、教学相长 +10–20%、校准干预 +8.9%），且与本产品「卡片自己带 FSRS、Vault 可手编」的基因天然契合；但**自建题需 AI 脚手架**（文献警示自由自测题无效），且多数条目要作为「学习者自主功能」而非引擎自动管线来设计。

另有两条**决策先行项**：`#19 掌握度口径收敛`（Arc B/C/E1 的前置）与 `enc 边从「只服务生成」升级为「调度也消费」`（Arc A 图感知的关键杠杆，当前全库 enc=0）。

## 1. 现状基线（代码事实）

数据与调度模型（详见 CONTEXT.md、`src/engine/srs.ts`、`sessions.ts`）：

- **题目级 FSRS-6 调度**：每题一张卡（due/stability/difficulty/reps/lapses），`state/fsrs参数.json` 支持 21 参数个人化（目前无优化器入口，靠外部落盘）。
- **复习队列** = 全课程到期题卡按 due 升序平铺（`bankSnapshot` + `reviewQueue`），每题每天最多推进一次；复习流自评语义（对=rating3、错=rating1；忘记门控 5s；答对后 Hard/Good/Easy 三档自评推进 FSRS）。练习流仍是自动映射（对=Good/错=Again，无自评）。
- **图**：region/block/node + `pre`（解锁门禁 `R_GATE=0.85`，`sessions.ts::readySet/gateBlockers`）+ `enc`（成分技能带权重边，目前只服务生成上下文与审计，**调度不消费**；全库 enc=0）。节点带可选 `difficulty`(1–5)/`bloom`/`est`。
- **掌握度两口径并存（#19）**：A=`nodeMastery`（题库正确率，消费方=作答响应/LessonView 写回）；B=`masteryOfFm`=0.7·S/(2·S_MASTER)+0.3·练习EMA（消费方=图着色/lesson/coursesTree，符合 CONTEXT.md 定义）。
- **内容管线**：大纲 → 逐节正文（可视化/交互件）→ 自动出题，门禁+单轮修复；作答证据通道（practice EMA）已建。
- **XP 账本**：est×FSRS 难度校准 k 定价、settle 对账、ETA/每日目标/streak 派生——与 Math Academy 的「1 XP≈1 分钟、daily XP goal」几乎同构。
- **学习者自主入口现状**：题目管理页已可**自建题**（过 validateBank 门禁，自带 FSRS 卡）；复习流答对后**自评难度**（Hard/Good/Easy）；节点可「跳过」（已有基础）；XP/目标/streak 记录系统。**尚无**：学习者自注/改写/讲解通道、预测-校准、目标所有权、自选难度的结构支持——这些是 Arc E 的空位。
- **面板**：学习/图/题目管理/统计/生成五个页签 + 节进度 stepper + AI 老师抽屉 + 「与 AI 讨论本课」宿主会话桥。

## 2. 行业坐标速写（2024–2026）

线上调研四路（自适应难度、SRS 前沿、AI 教学产品、图与 PKM 学习）的交叉结论：

- **Duolingo Birdbrain**：同一模型联合估计「学习者水平 × 单题难度」，session generator 在**作答期**按预测正确率（ZPD，目标 ~70–80%）从题池选题（每课约从 200 候选选 14），流式更新、HLR 并入；V2 是 LSTM 把全部历史压成 ~40 维向量。启示：**难度自适应是消费端（作答期选题）而非生产端**——learnhub 的 #15 已正确识别此方向。
- **知识追踪（KT）领域共识**：BKT 简单可解释但马尔可夫假设强；深度 KT（DKT）在大平台基准好，但在**稀疏交互（单个学习者、本地数据）下显著退化**——冷启动、随机波动难与真实学习区分。对 learnhub 的推论：**别上深度 KT；轻量 IRT/Elos 式题目难度估计 + FSRS difficulty 已够用**，这正是 per-question FSRS difficulty 可以直接当难度先验的理由。
- **FSRS 生态本身在快速演进**：FSRS-6（21 参数，Anki 25.09 内建）、可训练遗忘曲线、load balancing（把复习摊平到低负载日）、Easy Days；FSRS-7（35 参数，先用 GPU 训 LSTM 神经网络再知识蒸馏到 35 参数模型，给出 9000 参数网络约 99% 的精度）在路线图上；Anki 有从个人复习日志优化参数 + 预测保留率/真实保留率/遗忘曲线仪表盘。learnhub 目前 **FSRS-6 但无优化器、无保留率分析、无负载均衡**——这是低成本高价值的空白。
- **图感知学习工具正在出现**（NOEMA/Knowledge Graph MCP/ZenBrain/Reasonote/OpenMAIC/DeepTutor）：把概念抽成带前置边的图、per-concept 掌握度 + FSRS 调度、失败时**回退到前置概念**复习、`ready_to_learn`/`due_for_review`/`knowledge_gaps` 查询。这些产品验证了 learnhub「课程图 + 题目卡」架构的前瞻性——但多是 2025–2026 的新开源/新产品，**没有规模化证据**，learnhub 不需要抄它们，只需把自己的 pre/enc 边「调度化」。
- **AI 教学效果的最新 RCT（Khanmigo，NBER 35620）**：18 所中学两年整群随机，每学期约 +1.3 国家百分位（~0.06–0.08 SD/年；持续参与两年者 ~0.14 SD）。**关键发现：96% 学生试过但中位学生只有 1/3 练习日真用、出错后仅 17% 会话求助；消息多为抄答案**——「瓶颈是 engagement，不是 AI 能力」。推论：会话化学习要绑在**错误当下**才有戏，自由问答入口不产生学习；**把学习者从被动做题变成主动产出（讲解/自造卡/自注）是绕过 engagement 瓶颈的一条实证路**（见 Arc E）。
- **PKM/Obsidian 侧**：Obsidian ↔ Anki 生态（obsidian_to_anki、AnkiSync、Spaced Repetition 原生插件）验证「vault 为单一事实源 + SRS」是用户真需求；2025–2026 大量 AI 从 PDF/笔记/文档一键生成 flashcard/course 的新产品涌现。learnhub 的 vault 即事实源 + 渲染管线 + 题目卡，正好能做得比这些深——但**目前只学「AI 自造的课」，学不了用户自己的笔记**。

## 3. Arc A — 从「到期队列」到「会选题的调度」（首推）

### A1 预期回忆排序 / 作答期难度自适应（短期可做）
现状队列只按 `due` 升序；而 FSRS 已给每题算好 R（retrievability）。把复习/练习的出题顺序升级为「按预测成功概率 + 每题难度」组合排序（如先刷 R 最低、难度渐进），并可选做 Birdbrain-lite：**单节点内做题期按该题 FSRS difficulty 与作答历史微调顺序/权重**，而不是生成期定死难度。

- 证据：Birdbrain（§2）；IRTF 中小数据不需要深度 KT。
- 落点：`index.ts::reviewQueue`、`questionAnswer`/`questionForget` 的出题拼装；复用 `srs.ts::retrievability`。
- 前置：无（现有数据足够）；#19 收敛后可让「水平估计」更稳。
- 规模：中小。**这是 Arc A 里唯一不用等任何前置、可直接立项的**。

### A2 FSRS 参数优化 + 记忆健康仪表盘（中短期）
补上个人参数优化器（从 practice/journal 作答历史重训 21 参数 → 落 `fsrs参数.json`），并做「预测保留率 vs 真实保留率」「遗忘曲线」「每日复习负载预报」的统计页。Anki 生态已把这三件套做成标配，learnhub 目前全缺；数据在本地、不涉隐私。

- 证据：FSRS 官方（fsrs-rs 训练、Anki FSRS-6/load balancing）；行业把「预测 vs 真实保留率」当诚实度仪表。
- 落点：`srs.ts`（调度器参数）、`xp.ts`/统计页（图）。
- 前置：作答流水量足够（几百条即可）；无领域决策。
- 规模：中。可与 A1 同批立项。

### A3 enc 调度化：成分技能复习 + 前置衰减再激活（本系统的差异杀手）
图已建模 `pre`（先学关系）与 `enc`（本节点练习真实调用哪些前置技能、带权），但调度只消费 pre 的**解锁布尔**。文献与 2024 新实证都支持「学新内容前激活/再激活旧知识」：前置可提取性衰减到阈值以下时，先做一次**针对该前置节点题目的轻量检索**再放行新节点；enc 带权失败时回退到对应 pre 的题目重练。

- 证据：Chakraborty & Esposito 2024（再激活前置知识显著提升自我推导，55% vs 42%）；forward-testing / test-potentiated learning（Educational Psychology Review 2024 特辑）；Math Academy「解二步方程顺带复习一步方程」的隐式复习；NOEMA/ZenBrain 把 SRS 绑上概念边（新工具，无规模证据，仅作形态参照）。
- 落点：`sessions.ts::gateBlockers/readySet`（目前只挡不解锁建议）→ 把 R 衰减的前置做成「复习建议项」，复习流能直接进入该前置节点题目；enc 权重进图生成 prompt（enc_candidates 反哺已存在）+ 审计。
- 前置：**先补 enc 覆盖率**（当前全库 0，且 CONTEXT.md 已注明 enc 无真实存量）——需要一条数据或语义决策（是否让图生成器补 enc、enc 是否承担调度语义）。**这条本身就是一个决策 ticket**。
- 规模：中–大。差异化最大，但依赖 enc 决策。

### A4 全局负载均衡（跨课程摊平复习）
多课程到期日在同一天爆发时按 fuzz 窗口摊平（Anki load balancing 语义），与 XP 每日预算/ETA 联动。

- 证据：Anki 25.x load balancing / Easy Days。
- 前置：A1/A2 之后的调度层改造；涉及与「每题每天一次推进」不变量的兼容。
- 规模：中。可缓。

## 4. Arc B — 错题回流内容（#15 主线具体化）

### B1 错误归因到节 + 定向重写/补节
每节现在绑了题（出题锚点地板已 2/3/4），因此**单题作答证据天然可归因到节**。全错/低掌握（口径收敛后）的节 → 走既有单节重写端点（`POST /generate/section`，同一门禁与修复回路）定向重写或补一节；与「与 AI 讨论本课」桥接解释为什么。

- 证据：error-driven regeneration 形态在行业中已出现（CQELedu 等）；#14 报告 §2.3 已论证通道缺失是现状病灶。
- 落点：`question-bank.ts`（stats per qid）→ `index.ts::generate/section`；现成。
- 前置：**#19 掌握度口径收敛**（否则「低掌握」没有单一事实）；归因规则（错题≥N 或整节正确率<阈值才触发，避免高频重写）。
- 规模：中。这条就是 #15 的第一块拼图，可独立拆 ticket。

### B2 难度感知的出题再生成（错太多/太简单）
QG-DOK 类工作（Webb DOK 分层 + RAG 出题）显示用认知层级引导再生成能提升高阶题质量。低掌握节点出题时带 DOK/难度信息重新生成；答全对的题可标注「过于简单」供归档。

- 证据：arXiv 2505.11899（QG-DOK，DeepSeek-V3 在其评测内）；Duolingo LLM 出题但配人审。
- 前置：B1 同款（#19 + 归因规则）。
- 规模：中。可与 B1 合并成一条「数据回流出题」ticket 链。

## 5. Arc C — Vault 即课程输入 + 移动互通

### C1 个人笔记 → 可调度学习资产
把任意 vault 笔记/文件夹注册为学习对象：从既有正文**只出题不动文**（复用 renderers 白名单 + validateBank 门禁 + per-question FSRS），让用户对**自己写的笔记**做间隔复习；进阶才是「笔记→图→补节」。

- 证据：Obsidian SRS 生态（vault 事实源 + SRS 是真需求）；2025–2026 笔记/PDF→课程产品潮（Reasonote 的 skill-tree+SR、DeepTutor/OpenMAIC 的 KG+交互件、youngju 综述把 PKM+SRS 列为 2026 主线之一）。
- 落点：注册表（`registry.ts`）新增课程源类型或独立「笔记本」域；出题管线/题库/复习全部复用。
- 前置：这是**范围扩张**——事实源/目录布局/Missing-Broken 语义都要重新对齐，必须先 grill。
- 规模：大。差异化大、产品面扩张最大，也最容易失控。

### C2 移动/Anki 互通（export 到期卡到 Anki 或 AnkiConnect）
到期题目导出为 Anki 卡组/经 AnkiConnect 推送，手机刷完回写答案。与 C1 正交。

- 证据：Obsidian_to_Anki/AnkiSync 用户基数表明 vault↔Anki 双写是被反复验证的需求。
- 前置：**双向回写会触碰「vault 是唯一事实源」纪律**——需 ADR 级决策（单向只读导出 vs 双向）。
- 规模：中。

## 6. Arc D — 会话化学习（AI 老师在错误当下）

现状 AI 老师是「节点范围自由答疑」（抽屉）与「深聊」（宿主会话）。RCT 教训：自由问答的 engagement 与效果都弱。升级方向：**错误当下触发**——答错/忘记后出现「讲解这道题」/「换个方式重讲对应节」的动作，把该题题目+答案+对应节正文+作答记录打包注入宿主会话（learnhub:discuss 桥已具备，只需把「讨论整课」改成「讨论这题」的上下文包）；或面板内先做 guided worked-example（先看完整解法 → 半成品 → 独立重做，即样例渐退）。

- 证据：Khanmigo RCT（瓶颈是 engagement，AI 能力不是）；样例效应 + 专业度反转（既有 learning-science 笔记 §2）；Duolingo Max「Explain My Answer」2026 起转免费（形态验证，非效果证据）。
- 落点：`tutor`（`index.ts`）、`discuss-pack`、LessonView 错误态 UI。
- 前置：无大块数据前置；主要是一次产品形态决策（引导式 vs 自由式）。
- 规模：中。低成本高差异，值得单独原型验证。

## 7. Arc E — 主观能动性：把学习者变成内容的共同作者（新增弧）

设计立场先讲清：这一弧的目标不是「把自评/自答写进掌握度或调度」（CONTEXT.md 明确 mastery 与 XP 无自评；ADR-0006 自评只进记忆参数不碰定价），而是**给学习者一条产出通道**，让「动脑产出」本身成为学习动作。所有条目默认**参与式、可关闭**，与引擎自动管线正交。

文献基础（先共识，再映射）：

- **自造卡片的生成效应是实证最稳的一条**：Pan et al. 2023 六实验（JARMAC）——自己生成的卡片比成品卡片显著更好，48h 后测 recall d≈0.45、应用/迁移题 d≈0.29，**即便成品卡质量很高优势仍在**；机制是 generation effect + 加工深度 + generative learning（selecting-organizing-integrating）。**关键反直觉**：同一批研究里「自由自建」对浅层抄写无益，**无引导的自生题目甚至可能更差**——Myers et al. 2024（JEP: Applied）发现自问自答在延迟后测上**不如**答规定题/重读，因自命题常常打偏考点。
  → 设计推论：**鼓励学习者自造卡/自注，但必须给脚手架**（AI 对照节要点提点、把「你写的解释/例子」而不是「你自出的题」当首选产出）；**别让学习者空手自出题当练习主力**。
- **讲解/教 AI（protégé effect、费曼）**：Koh et al. 2018（教别人者后测高 10–20%）、Nestojko/Bjork 2014（**光有「要教」的预期就比「要考」更强**）、Chase 2009 命名 protégé effect。机制 = 检索 + 重组 + 实时发现缺口（元认知）+ 责任压力。
- **预测-校准（JOL / judgment of learning）**：出示前先判断「我估计会答对吗」再作答，能训练校准与记忆；CHI 2025 RCT 的 AI 校准支持（实时预测分数纠正高估）带来 +8.9% 学习增益；delayed/cue-only JOL 更准且有前向效应。
- **自选难度的双刃**：学习者自选「重读 vs 自测」时倾向只测有把握的（成功率高）项、长间隔/难题就逃——`toppino 2018`；且「misinterpreted effort」——学习者把费力误读为学得差，于是避开有难度的练习（ScienceDirect 2019）。
  → 设计推论：**给选择权但配「教练」**：选了太容易/在逃避时给出信息性反馈（SDT 的 informational feedback），而不是放任自流。
- **自主支持（SDT）**：meaningful choice、rationale、非控制性反馈、信息性反馈四件套提升内在动机；**自主性是技术化学习里最常被亏欠的需求**（JCAL 2026 综述）。Khanmigo RCT 的「engagement 瓶颈」与本弧同源。

### E1 学习者产出：自注解释 / 自造卡 / 「我的一句话」（首选落地）
每道题/每节给一个「加我的理解」入口：学习者用**自己的话**写一句解释、一个例子或一条助记（可空、可多次覆盖），**它自己就是一张附带 FSRS 卡的复习对象**（卡面=「用自己的话讲这个」/ 自注原文挖空重述，答后仍走复习自评语义）；AI 对照该节要点与正确答案**给非控制性反馈**（哪里偏离、可怎么补），不做判分入账。产出优先「改写/举例/自注」，**自出题仅作高级可选**。

- 证据：Pan 2023（d≈0.45）> Myers 2024 的自出题无益警示；Chi 1994 自解释 d≈1.14；Decimal Point 2022 聚焦开放自解释 > 菜单选择（延迟后测）。
- 落点：题目 schema（`question-bank.ts` 新增学习者字段或独立「学习者卡」文件）+ 复习流新题型；与既有自建题（已过 validateBank）并存。
- 前置：#19 只影响「要不要把它算进掌握度」——建议**不算**（学习者产出是过程资产，不是掌握度证据），因此实际不阻塞；需一次领域语义决策（卡片归属、与 AI 出题的同池 or 分池）。
- 规模：中。**Arc E 最该先做的**：复用现有卡模型与复习流，纯增量。

### E2 「讲给我听」：把概念讲给 AI 听（费曼/教学相长出口）
节点正文学完后出现「讲给我听」：学习者口头或打字用自己的话讲这个节点（或某一节）；AI 扮演**不懂的初学者**按正文要点追问、抓「含糊/跳跃/说错」给定位反馈（对标该节点已教内容，不引入超纲）；完成后可把这次讲解存档为自注卡（E1 的输入源）。形态是 Arc D 的反向——D 是 AI 讲给学习者，E2 是学习者讲给 AI，恰好把 ICAP 顶格（Interactive/Constructive）与「宿主会话桥」复用起来。

- 证据：protégé effect（Koh 2018 +10–20%；Nestojko 2014 预期效应）；自解释（Chi 1994）；Decimal Point 聚焦开放自解释最佳。
- 落点：复用 `tutor` 通道 + `discuss-pack`，加「讲解评审」prompt（learner 讲稿 + 节点正文 + 该节要点）；产物落自注卡。
- 前置：无数据前置；一次形态决策（打字 vs 语音；要不要评分——建议不评分只给定位反馈）。
- 规模：小–中，**性价比极高**——几乎不动引擎，只加一个会话动作与落卡。

### E3 目标与计划的所有权（SRL forethought + SDT rationale）
现有每日目标（XP goal）是单值设定。升级为学习者可见的「我为什么要学这个」（节点推荐理由从引擎话术变成可理解的一句话）、「今天学什么我来定/引擎提议可改」：推荐流允许学习者把某节点设为「今天学它」或「这周目标」，引擎按目标 + R 衰减给建议（提议而非指令），并解释理由。

- 证据：SRL 2024 系统综述/meta——目标设定与计划 r≈.39–.45、自我监控 r≈.49 与成效正相关；SDT 自主支持（meaningful choice + rationale）。
- 落点：`sessions.ts::recommendEvents` 加「目标覆盖层」；统计页。
- 前置：无；需要 UX 决策（别把推荐流做复杂）。
- 规模：中。

### E4 预测-校准（JOL：先预测，再作答，后看校准）
复习流出示题目时先问一档「我估计会答对吗」（会在/不会/没把握，与 ADR-0006 的作答后自评难度**正交且不冲突**——它是作答前预测，不是难度申报）；作答后对照并沉淀为**校准曲线**（你觉得自己会 vs 实际对的分布），统计页可看「我是不是过度自信」。功能默认关闭或低打扰（与「5s 主动回忆门控」一起评估，避免打断心流）。

- 证据：JOL 前向效应与校准训练（Metcalfe 等经典 + 2024 数字环境元认知提问研究）；CHI 2025 校准 RCT（+8.9%）。
- 落点：复习流 UI + `PracticeRec` 加 `predicted` 字段（作答流水兼容：老记录缺省=null）；统计页校准图。
- 前置：流水 schema 加字段（Missing/Broken 原则要求显式兼容旧记录）；无领域决策。
- 规模：小。**低成本、高学习科学纯度**，与 A2 的记忆仪表盘共享统计页。

### E5 自选难度 + 可用的困难「教练」
给学习者自选练习难度的权利（这轮我想刷简单的/挑战难的），引擎据其选择给 **informational feedback**：总选简单 → 温和指出「最近 7 天你全在简单题，按你的 FSRS 状态有几道到期难题其实到了该会的水准」；总在难 → 提醒回到前置复习。不做强制门禁，把「自选但不自知地逃避」的坑用数据点出来。

- 证据：toppino 2018（自选倾向逃难题）；misinterpreted effort（2019）；SDT informational feedback；合意困难须可成功完成（learning-science 既有笔记）。
- 落点：练习/复习流的难度过滤 + A1 的难度排序共用一套 difficulty 标尺；统计页「难度分布 vs 表现」。
- 前置：A1 的 difficulty 排序先落地；无新数据。
- 规模：小–中。与 A1/E4 共享组件。

### E 弧总评与顺序
证据最硬的是 E1/E2（生成 + 讲解，均 d≈0.3–0.5 量级且有 RCT/实验背书），成本最低；E4 最小但学习科学纯度最高；E3/E5 依赖 A 弧难度/推荐组件。**建议把 E1+E2 作为本弧第一个 ticket**（增量复用卡模型与会话桥），E4 与 A2 的记忆仪表盘合批，E3/E5 挂 A 弧之后。

## 8. 两条决策先行项

1. **#19 掌握度口径收敛**（domain decision，需人拍板 + `/domain-modeling`）。B1/B2 与 A1 的「水平估计」都挂它。方向 a（B 全面接管）比 b（改名并存）更贴合 CONTEXT.md，但会动 LessonView tooltip 与 nodeComplete 写回，需同步测试。
2. **enc 边的调度化决策**：当前 enc=0、只服务生成。选择：(a) 保持「仅生成/审计」，Arc A3 不做或退化为用 pre 近似；(b) 图生成器开始产出 enc 并承担调度语义（A3 成立）。这是 Arc A 内部最大分叉，建议先单独立一个决策/调研 ticket，不需要等其它。
3. **Arc E 的语义边界决策**（新增）：学习者产出（自注/讲解/预测）**一律不算掌握度与 XP**，只作过程资产与记忆对象——这决定 E 弧所有落地的「不写进哪」清单，需在第一个 E ticket 前用 `/domain-modeling` 定稿（避免再造一个 #19 式的口径分裂）。

## 9. 反模式备忘（读了文献之后不该做的事）

- 不做「无引导的自由自出题」当练习主力（Myers 2024）。
- 不把自评/预测写进 mastery 或 XP（CONTEXT.md / ADR-0006 / #19 教训）。
- 不做纯自由对话式答疑当核心功能（Khanmigo RCT 的 engagement 瓶颈）。
- 不做强制门禁式「你必须先复习前置」（去自主性）；要提议 + 理由，不设卡。

## 10. 主要出处

**自适应 / 教学效果**
- Duolingo Birdbrain 官方：[Learning how to help you learn: Introducing Birdbrain!](https://blog.duolingo.com/learning-how-to-help-you-learn-introducing-birdbrain/)
- Khanmigo RCT：[NBER w35620 — One Click Away: AI Tutoring with Khanmigo in a Two-Year School Experiment](https://www.nber.org/papers/w35620)
- 知识追踪现状：A Survey of Deep Learning Based Knowledge Tracing from a Cognitive Processing Perspective（Neurocomputing 660, 2026，经检索摘要引用）；稀疏数据下 DKT 退化论点来自系统性综述 [A Systematic Review of Deep Knowledge Tracing (2015–2025): Toward Responsible AI for Education](https://www.preprints.org/manuscript/202510.1845)（Preprints.org 202510.1845）

**SRS / 记忆**
- FSRS 算法与实现：[awesome-fsrs wiki: The Algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)、[py-fsrs](https://github.com/open-spaced-repetition/py-fsrs)、[fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs)
- Anki 调度文档（FSRS-6/load balancing/Easy Days）：[Anki Scheduling 手册](https://docs.ankiweb.net/scheduling.html)
- 记忆工具综述（2026，PKM+SRS 主线）：[youngju.dev — AI Spaced Repetition & Memory Apps 2026 Guide](https://www.youngju.dev/blog/culture/2026-05-16-ai-spaced-repetition-memory-apps-2026-anki-ankihub-remnote-supermemo-quizlet-ai-mochi-cards-brainscape-classcard-memrise-deep-dive.en)

**主观能动性（Arc E 专属）**
- 生成效应：Pan, Zung, Imundo, Zhang & Qiu 2023, "User-Generated Digital Flashcards Yield Better Learning Than Premade Flashcards", JARMAC 12(4) — [OSF 全文](https://files.osf.io/v1/resources/f5k8p_v1/providers/osfstorage/634f9cba93d35206ea91cfc6?action=download&direct&version=1)、[Matuschak 笔记](https://notes.andymatuschak.org/z3X7hMWZcQnyMdgNevS5BBq)
- 自出题警示：Myers, Hausman & Rhodes 2024, "Testing Effects for Self-Generated Versus Experimenter-Provided Questions", JEP: Applied 30(2) — [PubMed](https://pubmed.ncbi.nlm.nih.gov/37589715/)
- 讲解/教学相长：Koh et al. 2018、Nestojko, Bjork & Bjork 2014（经检索摘要引用）；自解释经典 Chi et al. 1989/1994（效应量 d 最大约 1.14，见自解释研究综述）
- 自解释软件实现：[Aleven et al. — Geometry Explanation Tutor](http://www.cs.cmu.edu/~aleven/Papers/2003/Aleven_ea_AIED03.pdf)、[Decimal Point 聚焦自解释 RCT（NSF-PAR）](https://par.nsf.gov/biblio/10400363)
- 预测-校准：[AI 校准支持 RCT（CHI 2025）](https://dl.acm.org/doi/10.1145/3706598.3713960)
- 自选难度逃避：Toppino et al. 2018, Memory & Cognition（[PubMed 29845590](https://pubmed.ncbi.nlm.nih.gov/29845590/)）；misinterpreted effort（[ScienceDirect 2019](https://www.sciencedirect.com/science/article/abs/pii/S0010028519302270)）
- SRL：2024 Educational Research Review meta（metacognitive r≈.35–.44 / goal-setting r≈.39–.45 / monitoring r≈.49，经检索摘要引用）
- LLM 出题练习辅助（供 E1 脚手架参照）：[arXiv 2507.05629（LLM 检索题 89% vs 73% 保留）](https://arxiv.org/abs/2507.05629)

**图感知学习 / PKM**
- 前置关系学习综述：Prerequisite Relation Learning: A Survey and Outlook, ACM Computing Surveys 57(11) 2025, DOI 10.1145/3733593
- 前置再激活实证：Chakraborty & Esposito 2024, [ERIC EJ1437325](https://eric.ed.gov/?id=EJ1437325)
- 图感知 SRS 新工具（形态参照）：[NOEMA](https://github.com/aislamsilvalol-ctrl/noema)、[ZenBrain](https://zenodo.org/records/19481262/files/zenbrain-v6.pdf)、[DeepTutor](https://landscape.jimmysong.io/projects/deeptutor/)、[OpenMAIC](https://landscape.jimmysong.io/projects/openmaic/)、Reasonote（[HN](https://news.ycombinator.com/item?id=43910592)）
- Obsidian ↔ Anki 生态：[Obsidian_to_Anki](https://github.com/ObsidianToAnki/Obsidian_to_Anki)、[Obsidian 论坛 Anki 插件求索帖](https://forum.obsidian.md/t/myriad-anki-plugins-seeking-advice/113776/4)

**出题 / 难度感知生成**
- [QG-DOK: Automated Question Generation for Deeper Math Learning (arXiv 2505.11899)](https://arxiv.org/html/2505.11899v1)
- 前置学习路径 / 图 RAG：[KnowLP (arXiv 2506.22303)](https://arxiv.org/abs/2506.22303)
- 错误驱动练习生成（形态参照）：CQELedu (IEEE Access 2025) —— 经检索摘要引用

> 注：部分「行业已落地/新工具」条目只有形态意义、无规模证据，报告中已标注；成熟证据仅 Khanmigo RCT 与 FSRS/Anki 官方体系、Arc E 引用的实验研究。

## 11. 建议下一步

- 若把这些方向做成 wayfinder map，**目的地候选**可以是「作答数据全面回流（调度选题 + 内容重写）+ 学习者产出通道」（Arc A1–A2 + B1 + E1–E2），先解决 #19、enc 与 Arc E 语义边界三个决策点，A3/C/D 各按 ticket 挂靠。
- 首轮该决议的**三个决策 ticket**（而非实施 ticket）：#19 口径收敛（已存在于 tracker）、enc 调度化语义与补覆盖、Arc E 学习者产出「不算掌握度不算 XP」的边界定稿。
- 首轮可并行调研的**research ticket**：A2 的 FSRS 参数优化器在 ts-fsrs 上的可行性（现库用 ts-fsrs，优化器 API 与数据量要求需核实）；B1 的错误归因阈值规则；E1 卡片归属与复习流新题型的 schema 设计（与自建题分池/同池）。
