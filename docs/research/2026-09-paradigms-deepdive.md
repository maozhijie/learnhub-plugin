# 深潜：有界项目侧补强 + 无界持续实践（2026-09-08）

- 日期：2026-09-08
- 状态：深潜笔记（线一补强 `2026-09-tacit-project-learning.md` §4；线二为其未覆盖的**无界持续实践**新线：学习融入真实生产生活，项目/实践没有截止日期、长期存在）
- 边界声明：不重复综合笔记 §4/§5 已核实的结论与出处（4C/ID 概要、CAF 概要、PS-I g=0.36、PjBL g≈0.71、模拟器 0.71、Eraut 2000、di Stefano 2014、successive relearning、tracer bullet、SuperMemo IR 概览——引用时只写「综合笔记 §x」交叉引用）；内隐域机制（运动/音乐/习惯/语言习得）另线负责，本笔记不碰。检索日 2026-09-08，DOI/摘要经 Crossref / OpenAlex / PubMed 核实；标注「转述」者为未逐字核对原文。

## 0. TL;DR

1. **反思是双线共用、也是证据最硬的一条**：debrief 元分析两连发——Tannenbaum & Cerasoli 2013（d=0.67，46 样本）与 Keiser & Arthur 2021（d=0.79，61 研究），后者确认有效条件：客观记录回放、与个体/团队对齐、学员主导 facilitation。反思条目的头号证据应从工作论文级升级为元分析级；di Stefano 2014 至今未过期刊同行评审，证据位阶下调。
2. **4C/ID 有元分析，但比预期弱**：现存两份综述都受制于「无对照的前后测设计」——Neck 2025（55 研究）g=0.76 全部来自 pre-post 无对照组，且 54% 的实施没有完整报告四组件、part-task 常被省略。结论：4C/ID 作为**设计框架**成熟，作为**被检验的因果假设**仍薄。渐退链本身（completion strategy）有 1990 年以来的实验链，但无独立大元分析。
3. **「项目式学习」是两个不同文献族**：K-16 课堂的 PjBL（Chen & Yang，综合笔记 §4.2 已引）与医学/职业教育的 PBL 是分开的；PBL 族的核心分化结论是——短期标准化知识测试偏讲授式，长期保留、技能发展、社会/认知胜任力偏 PBL（Strobel & van Barneveld 2009；Koh 2008）。
4. **无界实践线有一套完全不同的进步观**：Lave & Wenger 的「合法的边缘性参与」把学习定义为**成为**（参与度、身份），而非**记忆**（完成度）；Zettelkasten/SuperMemo/Matuschak 的实践传统则给出组织形式——**队列永不空、进度永不「完成」、组织者是调度器本身**。这与 learnhub「图=预先拆好的原子大纲」是两种世界观（§2.6 对立讲透）。
5. **技能衰减文献给了无界系统另一半语义**：停用后技能损失从 d≈-0.01（立即）滑到 d≈-1.4（>365 天），且认知/精确型任务衰减快于运动/速度型（Arthur 1998）；brief-and-frequent 复训（每月 2 分钟级）有初步证据。**维持性调度（性能保持）与习得性调度（FSRS 的记忆巩固）不是一回事**（§2.7）。
6. 70-20-10 是**启发式而非发现**（CCL 自报调查起源，无实证基线，学界批评明确）——它可以用来讲清系统边界，不能用来立项。

## 1. 线一：有界项目侧的补强

### 1.1 4C/ID 的实证证据现状

1. **综述/元分析现状（先正名）**：「Frerejean et al. 2021, Instructional Design for Complex Learning」这一标题经检索**不存在对应文献**；实际对应物是三件：①Frerejean et al. 2019（EJOF EDU，4C/ID 在高等教育：HvA 移动应用开发、Iselinge 师范信息问题解决、KU Leuven 全科医学三个案例）；②Frerejean et al. 2021（Instructional Science，教师专业发展中的 Ten Steps 训练）；③真正的元分析是 Costa, Miranda & Melo 2021（Learning Environments Research，「4C/ID: a meta-analysis on use and effect」，DOI 已核，摘要未开放、效应量数字本笔记不引）。出处：[Frerejean 2019](https://doi.org/10.1111/ejed.12363)、[Frerejean 2021](https://doi.org/10.1007/s11251-021-09540-x)、[Costa et al. 2021](https://doi.org/10.1007/s10984-021-09373-y)。
   → 含义：讨论 4C/ID 证据时引用要以 2019/2021/2025 三篇为准，别再引不存在的标题。
2. **最新系统综述（含多层元分析）给出了最诚实的数字**：Neck, Leuders & Reinhold 2025（Frontiers in Education，PRISMA）：55 项实施研究（2004–2024）；仅 32 个效应量（12 研究）可入元分析，且全部是**前后测、无对照组**设计——合并 g=0.76（SE=0.31）；54% 的研究没有完整报告四组件，仅 11% 详述 Ten Steps；**part-task practice 常被省略（被认为可选）**；分领域看职业工艺 g=2.12（显著）、教育 g=0.41（n.s.）、医学 g=-0.03（n.s.）。出处：[Neck et al. 2025](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2025.1631375/full)。
   → 含义：4C/ID 的证据形态是「设计研究+弱对照」，立项叙事里应写成「成熟的设计框架+尚薄的因果证据」，与检索/间隔那种元分析森林图不是一个量级。
3. **Ten Steps 的操作细节（书，转述）**：task class 定义的是**复杂度层级**而非体量——类间由简到繁、类内任务等复杂但高变式；支持在类内按 scaffolding levels 渐退（完整样例→补全→常规的任何档数均可，无固定级数）；part-task practice 只用于需要自动化的 recurrent 成分（练到过度学习+带间隔）。出处：van Merriënboer & Kirschner《Ten Steps to Complex Learning》（书；实施实况见上条 Neck 2025：真正落地时最常缺的就是 part-task 和 Ten Steps 全流程）。
   → 含义：给 F2（渐退模板）的操作约束——档数由内容决定、类内变式必须有；「孤立自动化练习」是可选项而非必选项。
4. **渐退链各环节的实证**：completion strategy 的源头实验是编程教育——van Merriënboer 1990：高中编程课「补全半成品程序」优于「从头写程序」，1992 复制（JECR）；此后 Renkl/Atkinson 系列把 fading 做成研究纲领。**诚实标注：completion problems 至今没有独立大元分析**；相邻的大元分析是综合笔记与 `learning-science.md` §2 已有的两端（样例效应 Chen 2023 / 专业度反转 Tetzlaff 2025，交叉引用，不重述）。单点最新证据：Miller-Cotto 2025 RCT（六年级几何，N=114）：fading 前后测 g=1.08 显著优于常规作业，但对 worked example 无显著差异（统计功效不足；工作记忆调节为 null）。出处：[van Merriënboer 1990](https://doi.org/10.2190/4nk5-17l7-twqv-1ehl)、[1992 复制](https://doi.org/10.2190/mjdx-9pp4-kfmt-09pm)、[Miller-Cotto 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12879535/)。
   → 含义：渐退链是「实验链+框架内嵌」而非「元分析背书」——F2 的证据等级写「中」，机制与 4C/ID/工程实践同构（综合笔记 §4.4 tracer bullet 交叉引用），别夸大。

### 1.2 认知学徒制的实施研究（CS/编程域）

1. **pair programming 是 coaching 的教育版**，有元分析：Umapathy & Ritzhaupt 2017（ACM TOCE）：18 份研究报告、28 个独立效应量、N=3,308——编程作业、考试、通过率三个域正效应，情感指标例外（无稳定效应）。出处：[Umapathy & Ritzhaupt 2017](https://doi.org/10.1145/2996201)。
   → 含义：Exercism 式人评（综合笔记 §5.3）背后有量化证据；AI coaching 若做「结对」语义（一人写一人审+即时追问），有同构证据可引。
2. **业界的近似物是现代 code review**：Bacchelli & Bird 2013（ICSE，对 Google/Microsoft 等 873 名从业者的混合研究）：开发者与管理者期待的是**找缺陷**，实际收益主要是**知识转移、团队感知、专家思维外显**——即认知学徒制的 coaching/articulation 功能在工业界的自发形态。出处：[Bacchelli & Bird 2013](https://doi.org/10.1109/icse.2013.6606617)。
   → 含义：「让学习者读专家评审、并接受对自己产出的评审」比「AI 批改对错」更接近真实 feedback loop。
3. **studio-based learning（工作室制）**：从建筑教育移植到计算教育（公开评图、同伴互评、迭代演示）；CS 里有小样本实验支持（Hundhausen 2005 ICER：CS1 工作室中个性化+讨论算法优于纯观看），整体证据为案例级（诚实标注：无大元分析）。出处：[Hundhausen 2005, ICER](https://doi.org/10.1145/1089786.1089791)。
   → 含义：若做「项目+社群」形态，评图（demo+peer review）是比排行榜更贴证据的社群机制。
4. **专家思维显性化的两个具体技术**：①**对比案例（contrasting cases）**：先让学习者并排比较多个「差一点」的变体再听讲，为讲解准备好区别性知觉——Schwartz & Bransford 1998「A Time For Telling」的经典范式（实验级证据，无现代元分析）。②**错误库/错误管理训练**：把典型错误显性化并鼓励从错误中学习——Keith & Frese 2008 元分析（24 研究，N=2,183）：d=0.44，迁移 d=0.56，**适应性迁移（结构不同任务）d=0.80**；显性错误鼓励是有效成分。出处：[Schwartz & Bransford 1998](https://doi.org/10.1207/s1532690xci1604_4)、[Keith & Frese 2008](https://doi.org/10.1037/0021-9010.93.1.59)。
   → 含义：项目节点的 AI 支持可以是「给三个带典型错误的候选实现让学习者鉴别」，这同时吃到对比案例与错误管理两条证据；错误库可从用户作答数据自生长（与 Arc A 作答回流衔接）。

### 1.3 问题式学习（PBL, medical）证据——与 PjBL 分族

1. **两族文献必须分开**：项目式 PjBL（K-16 课堂，Chen & Yang 2019 g≈0.71）是综合笔记 §4.2 已引的另一族；PBL（medical/professional，问题驱动、小组辅导）证据形态完全不同——多为课程级对照与系统综述。
2. **分化结论（PBL 族的头号综合）**：Strobel & van Barneveld 2009 对 8 份元分析的元综合：**长期保留、技能发展、师生满意度偏 PBL；短期保留（标准化笔试）偏传统讲授**。出处：[Strobel & van Barneveld 2009](https://doi.org/10.7771/1541-5015.1046)（被引 1,000+）。
3. **毕业后表现（更远的终点）**：Koh et al. 2008 系统综述（15 项合格研究）：PBL 医学生对毕业后的社会与认知维度胜任力有正效应——应对不确定性（强证据）、法律/伦理意识（强）、沟通技能（中-强）、自学（中）；知识量维度无优势（与 Strobel 一致）。无合并效应量（主题式证据分级，诚实标注）。出处：[Koh et al. 2008, CMAJ 178(1)](https://doi.org/10.1503/cmaj.070565)。
4. **分化结论的早期元分析与「评估层级」修正**：Dochy et al. 2003（Learning and Instruction，被引 1,700+）：PBL 对知识量测得略负、对技能测得略正（方向性结论，数字未本次核实，转述）；Gijbels et al. 2005（RER，按评估层级重做元分析）：当评估指向「知识结构/原理整合」层级而非「事实记忆」层级时，PBL 的优势随评估层级上升而扩大。出处：[Dochy et al. 2003](https://doi.org/10.1016/s0959-4752(02)00025-7)、[Gijbels et al. 2005](https://doi.org/10.3102/00346543075001027)。
   → 含义：PBL 族的结论与「远迁移稀缺」（综合笔记 §1）并不矛盾——它赢在「目标情境中的能力终点」而非「知识测试」，这恰好是项目域该承诺的东西：**选指标时要选长期/表现型指标，别用 quiz 成绩评判项目学习**；反过来说，项目域内的检索点（§1.5）只服务知识底座，不要拿它当项目的验收标准。

### 1.4 反思证据的升级（本节替代 di Stefano 的头号证据位）

1. **Tannenbaum & Cerasoli 2013（头号证据）**：debrief/复盘元分析，46 样本、N=2,136：对个体与团队绩效 **d=0.67**，换算即比对照组好约 20–25%；主持人引导、含「诊断-处方」环节的 debrief 更强。出处：[Tannenbaum & Cerasoli 2013, Human Factors 55(1)](https://doi.org/10.1177/0018720812448394)、[PubMed 摘要](https://pubmed.ncbi.nlm.nih.gov/23516804/)。
2. **Keiser & Arthur 2021（更大更新的确认+ moderators）**：61 研究、107 个 d（915 团队+3,499 个体）：整体 **d=0.79**，大于训练方法文献里多数效应；两个稳定有效的训练特征——**与个体/团队水平对齐**、**有客观表现记录作为回放媒体**；最有效组合是「学员主导（self-led）+ 团队对齐」与「学员主导+客观媒体」；高结构化 AAR 在军队更优、在医疗与低结构化相当。出处：[Keiser & Arthur 2021, JAP 106(7)](https://doi.org/10.1037/apl0000821)、[PubMed](https://pubmed.ncbi.nlm.nih.gov/32852990/)。
   → 含义（两条合并）：「有效 debrief 的配方」= 具体目标 + 无追责氛围 + 客观记录 + 学员主导。工具能提供的是**客观媒体**（作答/练习/提交记录的时间线回放）——把复盘从「凭记忆」变成「对账」，是系统对该效应的直接贡献。
3. **di Stefano 2014 的状态（降级说明）**：综合笔记 §4.4 已引其 Wipro 实验（+22.8%）。本次核实：该文**至今仍是 SSRN 工作论文**（2014 起，仅在 AoM Proceedings 出现过摘要，未通过期刊同行评审）；且合作者之一自 2021 年起卷入哈佛商学院数据诚信调查、多篇他文已撤稿（本文不在已知撤稿列表内，据公开报道）。出处：[SSRN 2414478](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2414478)。
   → 含义：反思条目的证据排序改为：Keiser & Arthur 2021 > Tannenbaum & Cerasoli 2013 > di Stefano 2014（工作论文，谨慎引用）。

### 1.5 长项目内的检索嵌入：比 successive relearning 更近一步的实地证据

1. **课堂 quizzing 的全景元分析**：Yang, Luo, Vadillo, Yu & Shanks 2021（Psychological Bulletin）：222 项独立研究、48,478 名学生——课堂中嵌入测试使学业成绩 **g=0.499**；调节因素包括对照条件的学习策略、反馈提供、测试重复次数与实施时长。这是「检索嵌入真实课程」目前最大的实地证据，覆盖 STEM 课程。出处：[Yang et al. 2021](https://doi.org/10.1037/bul0000309)。
   → 含义：F6（项目内检索点）的机制外推从「successive relearning（综合笔记 §4.4）」升级为「有 222 研究的课堂实地元分析+元分析承认的动机机制」——仍非项目内 RCT，但已是二阶证据。
2. **pretesting（学前预答）是更小但同向的变体**：视频学习前先答题提升后测（Carpenter & Toftness 2017）；但在真实课堂录像上效应有限（2018 跟进）。定位：小效应、边界条件多，作为「项目开始前的预诊断」比作为主要手段更合适。出处：[Carpenter & Toftness 2017](https://doi.org/10.1016/j.jarmac.2016.07.014)、[2018 跟进](https://doi.org/10.1016/j.jarmac.2018.06.003)。
3. **诚实标注**：「工程课专门 RCT」仍然稀少——Yang 2021 覆盖各学科但未单列工程亚组结论；项目/工作流内的检索嵌入本身依旧没有专门 RCT（综合笔记 §4.4 的外推声明维持有效）。

## 2. 线二：无界持续实践（学习融入真实生产生活）

定位：线一的一切（项目、任务类、渐退）仍以「一个可交付的项目」为界；本线处理**没有截止日期、没有完成态**的实践——工作、开源、写作、长期改进。证据形态先天偏弱（案例/理论为主），每条明标。

### 2.1 Schön：反思性实践者

1. **knowing-in-action**：实践者的能力大部分内嵌在行动中，无法事先充分言明；**reflection-in-action**（行动中反思：边做边对意外信号重构问题框架）与 **reflection-on-action**（行动后反思）是两个不同时点的机制；前者的发生条件是「惊讶」（预期与结果失配）。出处：Schön 1983《The Reflective Practitioner》、1990《Educating the Reflective Practitioner》（Basic Books；概述见 [Wikipedia: Reflective practice](https://en.wikipedia.org/wiki/Reflective_practice)，转述）。
2. **三角形框架与两时点的机制区分（操作层面）**：Schön 的实践认识论是三层结构——**knowing-in-action（基底）→ reflection-in-action（行动中）→ reflection-on-action（行动后）**：内隐的行动知识是地基，反思只是对它的「回访」。in-action 的触发条件是「惊讶」——预期与结果失配的当下，实践者现场重构问题框架并即兴验证；它**不占额外时间**（就发生在行动里），但要求已有的图式足够厚。on-action 则**占专门时间、需要外部记录**（日志、录音、回放），因而可以被工具支撑。两者产出不同：前者改进「这一次的行动」（即兴修复），后者改进「下一次的策略」（图式修订）——后者才是可调度的学习事件（转述，据 Schön 1983 的案例叙述归纳）。
3. **证据状态（明标）**：Schön 的论证是**案例理论**（建筑、心理治疗、音乐、工程设计的个案分析），无受控研究、无效应量；且「reflection-in-action」因操作化不足受到持续性批评（如 Eraut 1994《Developing Professional Knowledge and Competence》指其概念边界模糊，转述）。其后 40 年的「反思」实证文献（§1.4）实际研究的多是 reflection-on-action 的结构化变体。
   → 含义：learnhub 能调度的只有 on-action（有记录、有时点、可结构化）；in-action 属于真实任务执行本身——与综合笔记 §1「程序性通道在执行时采样」同一结论，但这里补上时间轴：**项目结束后还有一条无限长的 on-action 长尾，而现有系统的账本在那里就关了**。工具对 in-action 的唯一间接支持是「事后能重建当时的现场」（客观媒体，见 §1.4.2）。

### 2.2 Lave & Wenger：学习即成为（不是记忆）

1. **合法的边缘性参与（LPP）**：学习不是「内化知识再参与」，而是「在新手可及的合法位置上参与共同实践，边缘性随贡献逐渐中心化」；实践共同体（CoP）是学习的基本单元，知识在共同体中而非个体头脑中储存。出处：Lave & Wenger 1991《Situated Learning: Legitimate Peripheral Participation》[Cambridge DOI](https://doi.org/10.1017/CBO9780511815355)（被引 3 万+）；Wenger 1998《Communities of Practice》[Cambridge DOI](https://doi.org/10.1017/CBO9780511803932)。
2. **Wenger 1998 的身份维度（转述）**：共同体中的意义由参与、想象、对齐三种方式生成；学习即**身份的再形成**——「成为能在这个共同体里被认出来的人」。这是「学习=成为而非记忆」的出处级表述：**没有终态、进步由参与度定义**。
3. **CoP 的构成与「身份移动」的进度语义（转述）**：Wenger 后续框架把共同体拆为三要素——领域（domain，共同关心什么）、共同体（community，谁与谁互动）、实践（practice，共享的方法与工件库）；学习者在其中的位置移动（旁观→发问→修文档→修 bug→review 他人→维持共同体）**本身就是进度**，无需终点。出处：Wenger, Trayner & de Laat 2011（概念框架报告，转述）；三要素另见 [Wenger 1998](https://doi.org/10.1017/CBO9780511803932)。
4. **开源贡献是 LPP 的现代实例（有实证）**：Steinmacher 等的新人研究系列：58 个新人障碍、6 大类（文化差异、新人特征、产品、文档、开发流程、沟通渠道），并产品化为 FLOSSco 新人门户（ICSE 2016）；SSLR（IST 2015）系统化该分类。学习侧：Hemetsberger & Reinhardt 2006（Management Learning）：OSS 社区是「社会-经验学习」场域——新手通过观察成品+评审互动获得超越个体经验的综合能力（定性研究，标注）。出处：[Steinmacher et al. 2015 SLR](https://doi.org/10.1016/j.infsof.2014.11.001)、[CSCW 2015](https://doi.org/10.1145/2675133.2675215)、[ICSE 2016 FLOSSco](https://igor.pro.br/publications/conf-icse-SteinmacherCTG16.pdf)、[Hemetsberger & Reinhardt 2006](https://doi.org/10.1177/1350507606063442)。
   → 含义：**「学习完成」在这个范式里没有定义域**——进步=从 issue 修文档到修 bug 到 review 别人 PR 的位置移动。原子卡片范式给不出这种进度语言；最多给「prerequisite 已掌握」，给不出「身份已移动」。Exercism mentor 流程（综合笔记 §5.3）正是 LPP 的产品化：学过的人回来当教练，参与本身构成学习。

### 2.3 Eraut 深化：工作场所学习的发生条件

1. **Eraut 2004（对 2000 年综述的机制化深化）**：对中晚期职业者的访谈研究把工作场所学习的发生条件归为——**挑战与支持并存**（只有挑战→放弃/焦虑，只有支持→停滞）、**信心与承诺**、以及最普遍的瓶颈——**时间**（学习常发生在任务间隙，而工作日程不给间隙）；学习事件分**情景式（episodic，显著、可报告）与常规化（routinised，嵌入流程、当事人不自知）**两类，后者占多数但最难课程化。出处：[Eraut 2004, Studies in Continuing Education 26(2)](https://doi.org/10.1080/158037042000225245)（被引 1,600+；与综合笔记 §4.3 的 Eraut 2000 为同组工作，机制细节以此为准）。
2. **episodic/routinised 之分的度量含义**：可报告的显著学习事件（episodic，Eraut 访谈中当事人能讲出的「那一次我学会了……」）只占工作学习的一小部分；大部分是 routinised——嵌入流程、当事人不自知的渐进改进。**用户自报的学习事件只是冰山露出水面的部分**；任何依赖「学习者主动写日志」的记录通道，结构性低估 routinised 学习（转述，据 Eraut 2004 的访谈发现归纳）。
3. **对「课程化」的结构性抵抗（转述，Eraut 1994/2004）**：工作场所学习的时机由工作本身触发、内容由当下问题决定、回报嵌入关系与声誉——这三点都**抵抗被预先包装成课程**；能课程化的只是其陈述性残留。这与「无界」的连接：工作场所学习天然就是无终态、无大纲、由参与定义的（与 §2.2 同构）。
   → 含义：不要试图把「工作学习」拉进课程图；系统能做的是给 Eraut 说的时间/记录/挑战-支持三元组当基础设施（见 §2.8.1/2.8.4）——且要接受「记录永远滞后于学习」这一上限，别把日志缺失当成没学习。

### 2.4 持续改进传统：改善/Toyota Kata——「教练型练习循环」作为元学习实践

1. **improvement kata（Rother 2009，书；转述）**：Toyota 的持续改进被 Rother 抽象为四步循环——①方向/挑战（长期、常不变）→②把握当前状态→③设立下一个目标条件→④小步 PDCA 实验逼近；配套 **coaching kata**：教练用固定五问（目标条件是什么/现状如何/现在卡在哪个障碍/下一步实验是什么/预期学到什么）每日走查，**教练不给答案，只维持循环结构**。要点：挑战永不「达成完毕」，到达一个目标条件即设下一个——**元学习实践的无终态设计样本**。出处：Rother 2009《Toyota Kata》（McGraw-Hill）；[作者官方 kata handbook 站](http://www-personal.umich.edu/~mrother/Homepage.html)。
2. **A3：一页纸的学习故事（转述）**：A3 报告把「提案-现状-分析-对策-跟进」压在一页纸上，其本质是**可分享的推理记录**——写给未来的自己与协作者的「我为什么这么改」；与项目日志（综合笔记 F5）的差异在于它强制了因果链条的显性化。出处：Sobek & Smalley 2008《Understanding A3 Thinking》（书，转述）。
3. **标准化作业：版本化的学习基线（转述）**：把「当前最佳已知方法」写成标准并持续修订——「标准」在这里不是终态，而是**下一次偏离-学习的 diff 基线**：执行中偏离→复盘→改标准，学习被编码为标准的版本历史。这与「卡片是冻结的原子」形成对照：工业界的学习载体是**可修订的活文档**。
4. **提案制度（kaizen suggestion system）：量产小学习的循环（转述）**：丰田系工厂的改进提案以「小、快、真实施」为特征——工人每年提交大量微小改进并快速落地验证，学习发生在「提出→试验→标准化」的闭环里而非培训教室里；单件改进不可测、总量改变能力，是「参与量即学习量」的工业版本。出处：丰田生产方式相关实践文献（转述，如 Ohno《Toyota Production System》与 Liker《The Toyota Way》，书）。
5. **证据层级（明标）**：以上均为工业实践方法论与案例研究，无受控实验、无效应量；与 debrief 文献（§1.4）在机制上同源（结构化复盘+客观记录+学员主导），可借该处 d=0.67/0.79 做机制背书，不能直接移植。
   → 含义：kata 的五问就是一个可生成的「教练脚本」模板；「目标条件永不最终达成」给出了一种进度语义——**进度=当前条件相对上一条件的移动量**，而非相对终点的剩余量；「标准的版本历史」则是项目产物可被调度的又一种对象形态。

### 2.5 70-20-10 模型：启发式而非发现（诚实标注）

1. **内容与起源**：70% 来自挑战性任务/日常经验、20% 来自他人（教练/同伴）、10% 来自正式课程——起源是 Lombardo & Eichinger 在创造性领导力中心（CCL）的职业发展工具（1996，Career Architect），基于对约 200 名高管**回顾式自报**的调查，从未经过受控检验；后经 Jennings 等推广为企业 L&D 口号。出处：[CCL 官方 70-20-10 页](https://www.ccl.org/articles/leading-effectively-articles/70-20-10-rule/)（起源自述，转述）。
2. **批评来源**：Johnson, Blackman & Buick 2018（HRDQ）系统检视后结论：该框架**缺乏实证基线**，比例数字不可作为发现使用，只能作为「经验学习为主」的重新概念化透镜。出处：[Johnson et al. 2018](https://doi.org/10.1002/hrdq.21330)。
   → 含义：唯一正当用法是**边界声明**：本系统可调度的就是「10」的强化与「20」的记录（教练回路记录，见 §2.8.5），「70」只能靠外部回执与实践节点采样（综合笔记 F3）——宣称覆盖 70% 即是造假。

### 2.6 终身学习基础设施：Zettelkasten / SuperMemo / evergreen notes——调度器作为组织者

1. **Zettelkasten**：Luhmann 一生写下约 9 万张卡片（学界通引数字，转述），出版 50+ 本书、600+ 篇文章（[zettelkasten.de 综述](https://zettelkasten.de/introduction/)）；其方法论自述为「**与卡片盒交流**」（Luhmann 1992《Kommunikation mit Zettelkästen: Ein Erfahrungsbericht》，Universitas 47；英译见 zettelkasten.de，转述）：卡片盒不是存档，而是**对话伙伴**——它能回话（意外检索到旧卡与新城卡的连接），因此能生产 thought；结构不是预先设计的大纲，而是从编号与链接中**自发生长**的。Luhmann 遗稿研究（Johannes Schmidt 的卡片索引研究，书章，转述）确认其生产力与卡片实践同步增长。
2. **SuperMemo 的 20 rules of formulating knowledge（Wozniak 1999，官方文档）**：增量阅读（概览见综合笔记 §5.6）背后的知识表述规则，要点：理解先于记忆；**最小信息原则**（每卡一个原子问答）；用挖空而非长问答；避免互相干扰的卡片；优化措辞。出处：[Wozniak, Effective learning: Twenty rules](https://www.supermemo.com/en/archives1990-2015/english/ol)。本系统的原子节点约束（节点≤30 分钟）正是 rules 的节点级对应物——这一层是**共识而非分歧**。
3. **Andy Matuschak 的 evergreen notes**：笔记应「常青」——面向概念、原子化、密集链接、为未来的自己写作；配文「Spaced everything」主张把间隔语义从记忆扩展到**创意工作的一切循环**（回顾、修订、重新接触）。出处：[Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes)、[Spaced everything](https://notes.andymatuschak.org/Spaced_everything)。
4. **三者的内部张力与桥（补一笔）**：ZK 传统本身**没有队列语义**——Luhmann 不复习，靠的是写卡时的链接密度与偶发重访；SuperMemo 把「遗忘模型+队列」装进同一系统；Matuschak 的「Spaced everything」是把 SRS 的调度语义**嫁接**到 ZK 型写作循环上的桥。即：「队列」不是无界实践的必要条件，「永不关闭」才是。
5. **三个传统的共同设计立场（本节收束）**：①**队列永不空**——复习/回顾是持续流，没有「刷完了」；②**进度永不「完成」**——产出（卡片/笔记/修订）只会累积与重组，不会「毕业」；③**组织者不是预先拆好的大纲，而是调度器本身**——内容在时间中边读边拆、边写边连，结构是调度与链接的**涌现物**。
6. **与 learnhub 世界观的对立（讲透）**：learnhub 的图 =「预先拆好的原子大纲」——作者在时间零点把课程拆成节点，学习者沿边遍历，**图是静态产物，进度=覆盖度**。ZK/SuperMemo/Matuschak 的图 =「调度器在时间中生长」——学习者读到哪拆到哪、连到哪，**图是活的副产物，进度=网络密度与重访次数**。两种世界观各有主场：预先大纲对**有边界的教学内容**（考试、课程）是最高效的；活的图对**无界的持续实践**（工作、写作、开源）是唯一成立的——因为那里**没有可以预先拆完的对象**。分歧点在语义而非实现：前者把「未学到的东西」建模为「图中尚无的节点」，后者建模为「图中尚无的连接」。
   → 含义：这不是要 learnhub 改架构，而是为「项目/实践侧的图随真实项目生长」提供世界观根据（§2.8.3）——项目侧的图不该由作者预拆，应由学习者的真实产出与记录长出来；且该图无需自带队列语义，先做到「永不关闭」即可（笔记源「只读出题」机制正站在这座桥上，见综合笔记 F5/C1）。

### 2.7 无终态系统的进度度量

1. **动机结构：目标取向理论（Dweck/Elliot 谱系）**：掌握目标（mastery：以能力增长定义成功）与表现-回避目标（performance-avoidance：以避免显得无能定义成功）是稳定的个体-情境取向；元分析（Payne, Youngcourt & Beaubien 2007，JAP）：**学习取向与学习/学业/任务/工作绩效全面正相关，表现-回避取向全面负相关，表现-趋近取向不相关**。出处：[Payne et al. 2007](https://doi.org/10.1037/0021-9010.92.1.128)、源头 [Dweck 1986, American Psychologist](https://doi.org/10.1037/0003-066x.41.10.1040)。
   → 含义：无截止系统**只能靠掌握取向供能**（没有「考试日」可让表现取向兑现），因此其进度语言必须持续暗示「能力在增长」而非「别丢脸」——这是无终态产品的动机设计第一性原理。
2. **无终态产品的实际进度语言（详表见 §3）**：个人纪录（PR）、作品集/贡献图增长、永不满级的等级（等级制无终点或上限极高）、streak、可累积的声望与特权。共性：**全部以「相对自己的历史」与「参与量」为度量，无一以「课程完成度」为度量**。证据状态：这些是产品实践，其效果证据为留存/行为数据（各家内部 A/B，非技能习得结局，明标）。
3. **进度语言的四要素（形式化归纳）**：①**相对自己的纪录**（PR/best：上限由本人刷新，永不封顶）；②**参与连续性**（streak/贡献热图：度量「在场」，可断可续）；③**无上限或渐近型等级**（等级永不满；或曲线渐近永不到达）；④**累积性特权**（声望解锁权限：进度兑换成责任而非奖品——Stack Overflow 的复审权、开源的 merge 权、Exercism 的 mentor 资格）。四要素中②③④直接对应 LPP 的身份移动（§2.2.3），①对应 mastery 取向的「能力在增长」信号（§2.7.1）。
4. **技能维持 vs 增长是两阶段，衰减速度有规律**：Arthur, Bennett, Stanush & McNelly 1998（Human Performance，53 文献 189 数据点）：停用后技能损失从 d≈-0.01（训练刚结束）滑至 **d≈-1.4（>365 天非使用）**；**认知/人工/精确型任务比运动/自然/速度型任务衰减更快**——即知识型技能恰恰是最脆的。出处：[Arthur et al. 1998](https://doi.org/10.1207/s15327043hup1101_3)。医学侧：CPR 等临床技能在数月内显著衰减；scoping review（21 研究）：**简短高频复训**（乃至每月 2 分钟级）指向更好的保持，但「理想复训时刻表」尚无强证据。出处：[Gugelmin-Almeida et al. 2022, Resuscitation Plus](https://doi.org/10.1016/j.resplu.2022.100319)。语言侧：语言磨蚀（attrition）总体比预期小，**停止接触时的熟练度越高衰减越慢**、词汇最脆弱（综述，转述）。出处：[Bardovi-Harlig & Stringer 2010, SSLA](https://doi.org/10.1017/s0272263109990246)。
   → 含义：维持阶段的调度目标不是「学新」（增长），而是**低频、小剂量、永不停机的性能保障**——它天然无终态。
5. **「维持性调度」与「习得性调度」（FSRS 语义）不是一回事**：FSRS（综合笔记已述其间隔语义）是**单一优化器**——对每个条目估计稳定度并按目标保持率排期，它不区分「初次习得」与「久置后的维持」两种语义状态；技能衰减文献里的「维持」是**绩效保持问题**（含运动/临床/复杂任务，很多根本没有「卡片」可言），其证据支持的维持手段是**复训事件**（重做带反馈的迷你实操）而非**检索作答**。结论：两者在「间隔、渐增、以遗忘模型为参照」这一点上同构，但在**证据来源、适用对象、事件形态**上不同——把技能维持硬塞进 FSRS 卡会犯综合笔记 §1 的领域错误（把程序性当陈述性），正确的对位是「实践节点的低频复活」而不是「卡片队列的低频复活」。
   → 含义：无界实践中「维持」应是一种**独立调度对象**（面向实践/绩效，事件=迷你重做+回放），与题目队列并行；这正是 §2.8.4 的立论。

### 2.8 收束：无界实践支持应该长什么样（机制结论）

1. **账本/日志永不关闭**：复盘-记录是终身流（Schön 的 on-action 长尾 + T&C/Keiser 的 d=0.67/0.79 + kata 的日常循环）。证据强度：**高**（两个独立元分析）。learnhub 含义：项目结束后复盘对象仍可被调度——综合笔记 F5 的无界推广：日志不是项目的附属品，是系统里永不毕业的一等内容。
2. **进步由参与与身份定义，而非完成度**：LPP/Wenger + Payne 2007 的动机结构 + 无终态产品的进度语言（PR/贡献图/永不满级）。证据强度：**理论+定性+动机元分析**（中），产品行为佐证（低-中）。learnhub 含义：完成门禁之外需要第二套「参与型」进度语言（连续性、相对自己的纪录、被共同体认出的产出），且它不设终态。
3. **项目的图随真实项目生长（图谱是活的）**：ZK/SuperMemo/Matuschak 的调度器即组织者 + Eraut 的抵抗课程化。证据强度：**实践级**（30 年活体实验，无对照，低-中）。learnhub 含义：项目/实践侧的图不应由作者预拆，而应从学习者的真实产出、日志、错误中长出来——原子大纲的范式留给有边界的课程域。
4. **维持性调度与习得性调度分离**：Arthur 1998（d 至 -1.4）+ 临床复训 scoping review + FSRS 语义辨析。证据强度：**中-高**（衰减元分析强；复训排期证据弱）。learnhub 含义：为技能/实践设独立的低频维持通道（事件=迷你重做+回放），不要塞进卡片队列。
5. **共同体/教练回路外包给真人社区**：pair programming 元分析（3/4 域正效应）+ Exercism/OSS 的 LPP 实例 + Keiser & Arthur 的「学员主导+客观媒体」最优组合。证据强度：**中-高**。learnhub 含义：系统自建的是**客观媒体**（记录/回放/复盘结构），coaching 与身份承认外包给真人社区与导师制，接口是回执（综合笔记 F3）与评审产物。
6. **70-20-10 只作边界声明**：证据强度：**低（无实证基线）**。learnhub 含义：对外叙事与立项边界用它画界，不用它承诺效果。
7. **两种形态的语义分工（总表）**：有界（线一，补强综合笔记 §4）与无界（本线）不是竞争范式，是同一系统的两个语义区段——

| 维度 | 有界项目侧（线一） | 无界实践侧（线二） |
|---|---|---|
| 终点 | 有可交付物/里程碑 | 无终点，账本永不关闭 |
| 进度定义 | 覆盖度+渐退完成度 | 参与度+身份移动+相对自己的纪录 |
| 图的来源 | 作者预拆的大纲 | 调度器/产出随时间生长 |
| 调度对象 | 题目、任务类、项目里程碑 | 日志复盘、维持性复训事件、参与连续性 |
| 头号证据 | debrief 元分析（d=0.67/0.79）+ 课堂 quizzing（g=0.499） | 衰减元分析（d 至 -1.4）+ 复训 scoping review + 动机元分析 |
| 外包 | 判题/教练给 AI 与工程判题 | coaching 与身份承认给真人共同体 |

## 3. 产品补充：无界形态的进度语言（综合笔记 §5 未扫描的部分）

以下每个产品的共性：**没有「毕业」，进度语言全部由参与量与相对自己的纪录构成**；效果证据多为留存/行为数据（各家内部 A/B，无技能习得对照研究，明标）。

- [Strava](https://www.strava.com/features)：段位（segment 排名/KOM）+**个人纪录 PR**+累计里程与成就徽章+挑战赛；进度=「本年比去年远」，等级体系持续可升。评价：留存行为数据强（社群承诺装置，综合笔记 §5.2 已注其证据属性），技能结局无。
- [GitHub 个人档案与贡献图](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile)：贡献热图（连续提交可视化）+成就徽章（Pull Shark 等）+作品集即档案（README 置顶仓库）；进度=绿格子密度与公开作品积累，永无完成态。评价：与真实产出**同构**（不是代理指标），但「贡献多≠学得多」，学习结局无证据。
- [Chess.com puzzles](https://www.chess.com/puzzles)（[Puzzle Rush](https://www.chess.com/news/view/puzzle-rush-on-chess-com)）：每日谜题（streak 连续完成）+Puzzle Rush 冲击个人最高分（限时生存模式）+无限 puzzle 集合与评分；进度=每日一题的连续性+**可无限刷新的 PR**。评价：与领域技能同构度最高的无界设计（puzzle=带反馈的检索/鉴别练习，对应综合笔记 §2.2.4 的鉴别型任务），效果证据仍为平台内部数据。
- [LeetCode 每日一题](https://leetcode.com/problemset/)：Daily Coding Challenge+连续完成计数+徽章+竞赛 rating（无上限）；进度=连续天数+rating 曲线。评价：行为留存设计成熟；「刷题模式识别 vs 工程能力」的局限综合笔记 §5.3 已注（社区共识，非研究证据）。
- [Stack Overflow 声望系统](https://stackoverflow.com/help/whats-reputation)（[特权阶梯](https://stackoverflow.com/help/privileges)）：声望分（可增可减）+金银铜徽章+**声望解锁特权**（评论、复审、关闭投票……）；进度=声望曲线+特权数量，等级永不「满」。评价：把「参与→身份→更大参与责任」做成了制度化的 LPP（§2.2.2），是共同体进度语言的教科书样本；学习结局同样无对照证据。

## 4. 证据强度与争议汇总

| 主题 | 代表证据 | 关键数字 | 强度 | 争议/注意 |
|---|---|---|---|---|
| debrief/复盘 | Keiser & Arthur 2021; T&C 2013 | d=0.79（61 研究）；d=0.67（46 样本）；~20-25% 绩效提升 | **高（双元分析）** | 有效依赖配方：客观媒体+对齐+学员主导；追责文化会毁掉它 |
| 反思（工作论文级） | di Stefano 2014（综合笔记 §4.4 已引） | +22.8% | **低-中（降级）** | 至今未过期刊同行评审；合作者涉数据诚信调查（本文未撤稿） |
| 课堂嵌入测试 | Yang et al. 2021, Psych Bull | g=0.499（222 研究/48,478 生） | **高** | 项目内 RCT 仍缺；对照条件与反馈提供是关键调节 |
| 4C/ID 整体 | Neck et al. 2025（55 研究）；Costa et al. 2021 | g=0.76，**全部 pre-post 无对照** | 中（证据形态弱） | 54% 实施未完整报告四组件；医学领域 g≈0；设计框架≠因果检验 |
| completion/fading 链 | van Merriënboer 1990/1992; Miller-Cotto 2025 | 编程课补全>生成（方向稳健）；fading RCT g=1.08 vs 常规，vs 样例 n.s. | 中 | 无独立大元分析；与样例效应/专业度反转的边界按水平分流 |
| pair programming | Umapathy & Ritzhaupt 2017 | 3/4 域正效应（N=3,308）；情感指标 null | 中-高 | 需配对质量与轮换机制 |
| 错误管理训练 | Keith & Frese 2008 | d=0.44；适应性迁移 d=0.80 | 高 | 「鼓励犯错」需心理安全条件 |
| 对比案例 | Schwartz & Bransford 1998 | 实验级（无现代元分析） | 中 | 「先对比后讲授」与样例效应按任务/水平分流 |
| PBL（medical 族） | Strobel & van Barneveld 2009; Koh 2008 | 长期保留/技能/满意度>PBL；短期笔试<讲授；胜任力：社会/认知维度正效应 | 中-高 | 与 PjBL（Chen & Yang）是两族文献，不可混引 |
| Schön 反思性实践 | Schön 1983/1990 | — | 低（案例理论） | reflection-in-action 操作化受批评；实证文献只覆盖 on-action |
| LPP/CoP | Lave & Wenger 1991; Wenger 1998 | — | 低-中（理论+定性） | 学习结局难以量化；OS 学习证据为定性 |
| OSS 新人学习 | Steinmacher 等; Hemetsberger & Reinhardt 2006 | 58 障碍/6 类（SLR） | 中（障碍侧）/低（学习侧） | 障碍实证多、学习增益定性 |
| 工作场所学习条件 | Eraut 2004 | 挑战+支持+时间；episodic/routinised | 中（访谈研究传统） | 转述为主；抵抗课程化是其本身结论 |
| Toyota kata | Rother 2009（书） | — | 低（实践方法论） | 无受控研究；机制上借 debrief 文献背书 |
| 70-20-10 | CCL 起源；Johnson et al. 2018 | — | **低（无实证基线）** | 仅作启发式/边界声明 |
| 无终态进度语言 | Strava/GitHub/Chess.com/LeetCode/SO 官方 | — | 低-中（留存行为数据） | 均为平台内部证据；非技能习得结局 |
| 目标取向 | Payne et al. 2007 | 学习 GO 正相关；表现-回避负相关；表现-趋近 null | 高 | 情境可诱发取向，非纯特质 |
| 技能衰减 | Arthur et al. 1998 | d -0.01→**-1.4**（>365d）；认知/精确型衰减最快 | 高（元分析） | 衰减≠遗忘；绩效测量口径影响估计 |
| 复训排期 | Gugelmin-Almeida et al. 2022 | 简短高频（≥月度，2 分钟级）方向性支持 | 中（scoping review） | 理想时刻表无强证据 |
| 语言磨蚀 | Bardovi-Harlig & Stringer 2010 | 熟练度高→衰减慢；词汇最脆 | 中（综述） | 自然习得与课堂习得磨蚀模式不同 |
| 维持 vs 习得调度 | FSRS 文档 vs Arthur/复训文献 | — | 中（概念辨析） | 事件形态不同：检索作答 vs 迷你重做；不可互换 |

## 5. 主要来源汇总

**线一（项目侧补强）**
- 4C/ID 实证：[Neck, Leuders & Reinhold 2025, Frontiers in Education](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2025.1631375/full) / [Costa, Miranda & Melo 2021, Learning Environments Research](https://doi.org/10.1007/s10984-021-09373-y) / [Frerejean et al. 2019](https://doi.org/10.1111/ejed.12363) / [Frerejean et al. 2021](https://doi.org/10.1007/s11251-021-09540-x)
- 渐退链：[van Merriënboer 1990, JECR](https://doi.org/10.2190/4nk5-17l7-twqv-1ehl) / [1992 复制](https://doi.org/10.2190/mjdx-9pp4-kfmt-09pm) / [Miller-Cotto 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12879535/)；两端元分析见 `learning-science.md` §2（Chen 2023 / Tetzlaff 2025）
- CS/编程：[Umapathy & Ritzhaupt 2017, TOCE](https://doi.org/10.1145/2996201) / [Bacchelli & Bird 2013, ICSE](https://doi.org/10.1109/icse.2013.6606617) / [Hundhausen 2005, ICER](https://doi.org/10.1145/1089786.1089791)
- 显性化技术：[Schwartz & Bransford 1998](https://doi.org/10.1207/s1532690xci1604_4) / [Keith & Frese 2008, JAP](https://doi.org/10.1037/0021-9010.93.1.59)
- PBL medical：[Strobel & van Barneveld 2009](https://doi.org/10.7771/1541-5015.1046) / [Koh et al. 2008, CMAJ](https://doi.org/10.1503/cmaj.070565)
- 反思升级：[Tannenbaum & Cerasoli 2013](https://doi.org/10.1177/0018720812448394) / [Keiser & Arthur 2021, JAP](https://doi.org/10.1037/apl0000821) / [di Stefano et al. 2014（SSRN 工作论文，状态核实）](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2414478)
- 检索嵌入：[Yang, Luo, Vadillo, Yu & Shanks 2021, Psych Bull](https://doi.org/10.1037/bul0000309) / [Carpenter & Toftness 2017](https://doi.org/10.1016/j.jarmac.2016.07.014)

**线二（无界持续实践）**
- 理论源头：Schön 1983/1990《The Reflective Practitioner》/《Educating the Reflective Practitioner》（书） / [Lave & Wenger 1991](https://doi.org/10.1017/CBO9780511815355) / [Wenger 1998](https://doi.org/10.1017/CBO9780511803932) / [Eraut 2004](https://doi.org/10.1080/158037042000225245)（Eraut 1994 为书）
- 开源实例：[Steinmacher et al. 2015 SLR, IST](https://doi.org/10.1016/j.infsof.2014.11.001) / [CSCW 2015](https://doi.org/10.1145/2675133.2675215) / [ICSE 2016 FLOSSco](https://igor.pro.br/publications/conf-icse-SteinmacherCTG16.pdf) / [Hemetsberger & Reinhardt 2006](https://doi.org/10.1177/1350507606063442)
- 持续改进：Rother 2009《Toyota Kata》（书）；[kata handbook（作者官方）](http://www-personal.umich.edu/~mrother/Homepage.html)
- 70-20-10：[CCL 官方起源页](https://www.ccl.org/articles/leading-effectively-articles/70-20-10-rule/) / [Johnson, Blackman & Buick 2018, HRDQ](https://doi.org/10.1002/hrdq.21330)
- 终身学习基础设施：[zettelkasten.de 综述（Luhmann 数字与工作流）](https://zettelkasten.de/introduction/)；Luhmann 1992《Kommunikation mit Zettelkästen》（Universitas 47，转述）；[Wozniak, Twenty rules](https://www.supermemo.com/en/archives1990-2015/english/ol)；[Matuschak, Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes) / [Spaced everything](https://notes.andymatuschak.org/Spaced_everything)
- 动机与衰减：[Payne et al. 2007, JAP](https://doi.org/10.1037/0021-9010.92.1.128) / [Dweck 1986, Am Psych](https://doi.org/10.1037/0003-066x.41.10.1040) / [Arthur et al. 1998](https://doi.org/10.1207/s15327043hup1101_3) / [Gugelmin-Almeida et al. 2022](https://doi.org/10.1016/j.resplu.2022.100319) / [Bardovi-Harlig & Stringer 2010](https://doi.org/10.1017/s0272263109990246)

**产品官方页（无界形态）**
- [Strava features](https://www.strava.com/features) / [GitHub profile docs](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile) / [Chess.com puzzles](https://www.chess.com/puzzles) / [Puzzle Rush](https://www.chess.com/news/view/puzzle-rush-on-chess-com) / [LeetCode problemset](https://leetcode.com/problemset/) / [Stack Overflow reputation](https://stackoverflow.com/help/whats-reputation) / [privileges](https://stackoverflow.com/help/privileges)

> 诚实性声明：线二的理论源头（Schön、Lave & Wenger、Wenger、Eraut 1994、Rother、ZK 传统）多数为**案例/理论级**，无效应量可报，均已在正文明标；线一的关键数字（d=0.67、d=0.79、g=0.499、g=0.76、d=0.44、d -0.01→-1.4）均经本次摘要核实。「Frerejean 2021 Instructional Design for Complex Learning」标题不存在已正名；Costa 2021 因摘要未开放未引具体数值。
