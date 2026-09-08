# 调研：内隐知识、长周期项目与全链路学习范式（2026-09-08）

- 日期：2026-09-08
- 状态：深度调研笔记（供方向讨论；不含实施决策，不拍板）
- 源材料：本仓库 `CONTEXT.md` + `docs/research/` 既有三份笔记（`learning-science.md`、`industry-scan.md`、`2026-09-big-directions.md`）+ 本次一手文献核实（Crossref / OpenAlex / PubMed 元数据与摘要核对，检索日 2026-09-08）。凡标注「转述」者为二手来源或教科书常识，未逐字核对原文。
- 与既有笔记的关系：`2026-09-big-directions.md` 的 Arc A–E 覆盖「作答数据回流 + 学习者产出 + 会话化」，本笔记**不重复**其内容，只在其外回答四个问题：①除「学习图+间隔复习」外还有什么全链路范式；②内隐/程序性主导的领域（乐器、运动、习惯）为何失效、有哪些有证据的方法；③月级大型实践项目（真实创造行为）的学习机制；④不限于现有产品形态的业界全链路扫描。两份同日深潜笔记在其下继续挖深：`2026-09-tacit-knowledge-deepdive.md`（§2 的机制层与测量工具层）、`2026-09-paradigms-deepdive.md`（§4 补强 + 无界持续实践新线）；三文件冲突处以深潜笔记为准，本文已按其结论修订三处：CI 现场-实验室分裂（§2.1.1）、di Stefano 2014 降级与反思证据换头牌（§4.4/§6/§7）、F6 证据升级（§6）。

## 0. TL;DR

1. **本系统是一个「陈述性检索调度引擎」**：ACT-R 的技能获得理论指出，陈述性知识（facts/rules）靠检索巩固，而程序性技能靠「知识编译 + 产生式练习强度增长」——两者是不同记忆系统、不同巩固机制。检索练习（FSRS 的语义）**不产生编译**，所以对内隐域失效是结构性的，不是调参问题。
2. **远迁移近乎不存在**（Sala & Gobet 2017）：训练收益随实验设计严谨度反向缩水。推论：陈述性单元记得再牢，也不会自动变成真实情境里的技能——**必须在目标情境中练**。这是所有全链路范式的共同底线。
3. 内隐域仍有可调度、有证据的方法：**练习变异性/contextual interference**（变式+随机化在保持/迁移上占优）、**外部注意焦点**（g≈0.58 retention）、**反馈渐退（guidance hypothesis）**、**心理演练**（偏差校正后 r≈0.13，小但真实）、**分布练习**（运动复杂任务效应衰减到 d≈0.46 以下）。这些都能映射为「练习计划」而非「动作感知」。
4. **4C/ID 全任务法是「60 个原子单元 vs 一个月大项目」的第三条路**：以真实全任务组织教学（task classes 由简到繁），类内做支持渐退（完整样例→补全任务→独立完成）。CodeCrafters 的「自己造一遍 Redis（97 stages）」就是它的产品化。对 learnhub 的含义：项目不必是原子拆分的对立面，可以是一种新节点类型 + 渐退模板。
5. **月级项目中的学习机制有一手证据**：每天 15 分钟书面反思使结业测试成绩 +22.8%（di Stefano 2014, Wipro 实地实验）；「检索+间隔」（successive relearning）在真实课程中稳定提升考试与长期保留；但「项目里嵌入检索」没有专门 RCT，属外推。
6. **习惯不是知识，不该塞进 FSRS 卡**：习惯是情境-反应绑定（约 43% 日常行为），自动化中位 66 天（18–254，漏一天无碍）。有证据的组件是 implementation intentions（d=0.65）与承诺装置；streaks 是双刃（提升留存但行为结局证据不稳）。
7. 语言相对适用的原因：词汇是海量陈述性映射且间隔效应中到大（L2 spacing 元分析 2022），显性教学+练习在 SLA 元分析中稳定占优（Norris & Ortega 2000）——恰好是本系统形态；但**语法直觉的自动化**（DeKeyser 路径）仍需大量输入/输出，超出卡片能力（TBLT d=0.93 靠真实任务）。
8. 对 learnhub 的新方向池（§6，均不拍板）：项目节点+渐退模板（F1/F2）、练习证据通道接外部动作回执（F3）、习惯一等公民（F4）、项目日志注册为复习对象（F5，与既有 Arc C1 衔接）、项目内检索点（F6）、先做后教顺序选项（F7）、音频题型（F8）。

## 1. 问题界定：当前范式覆盖什么，为什么在内隐域失效

1. **陈述性 vs 程序性是两个系统（ACT-R）**：Anderson 把技能获得分为陈述性阶段（依赖事实与规则）与程序化阶段（知识编译：把陈述性编码为产生式规则），之后产生式强度随使用次数按幂律增长；两条通道的巩固机制独立。检索练习巩固的是陈述性通道，编译只发生在「执行任务本身」时。出处：[Anderson 1982, Acquisition of cognitive skill, Psychological Review 89(4)](https://doi.org/10.1037/0033-295x.89.4.369)、[Anderson 1996, ACT: A simple theory of complex cognition, American Psychologist 51(4)](https://doi.org/10.1037/0003-066x.51.4.355)；阶段划分另见 Fitts & Posner 1967《Human Performance》（书，转述）。
   → 映射：本系统的题目作答、FSRS 稳定度、掌握度全部采样自陈述性通道；实践节点是唯一的程序性采样窗口（每节点每日限一次的交互件）。这不是缺陷修补问题——要覆盖程序性域，需要第二条证据通道。
2. **内隐知识「知多于可言」**：Polanyi 指出熟练者的知识大部分无法完全显性化（「We can know more than we can tell」）。无法显性编码 → 无法全部出题、无法全部由作者预先声明。出处：Polanyi 1966《The Tacit Dimension》（书；概述见 [Wikipedia: Tacit knowledge](https://en.wikipedia.org/wiki/Tacit_knowledge)，转述）；工作场所视角见 [Eraut 2000, Non-formal learning and tacit knowledge in professional work, BJEP 70(1)](https://doi.org/10.1348/000709900158001)。
   → 映射：图谱生成器把课程拆成节点时，天然只拆「可言说」部分；内隐部分在图外。承认这一点后，系统应显式承认「本课程有不可拆分的实践成分」，而不是假装题库=课程。
3. **远迁移稀缺，是所有原子化方案的共同敌人**：国际象棋/音乐训练/工作记忆训练对认知与学业能力的迁移，效应量与实验设计质量**反向相关**（有主动对照组的设计里收益趋零）。出处：[Sala & Gobet 2017, Does Far Transfer Exist?, Current Directions in Psychological Science 26(6)](https://doi.org/10.1177/0963721417712760)。
   → 映射：enc（成分技能）边存在的理由正在于此——它声明「本节点练习真实调用了哪些前置」。但当前全库 enc=0 且调度不消费（见 big-directions §8 决策项），陈述性记忆与真实调用之间的桥还没搭起来。远迁移证据说明：即使把 enc 做满，也只解决「知识被调用」，不解决「技能在真实情境中生成」。
4. **区分「领域适配」与「学习风格适配」**：学习风格（视觉型/听觉型因材施教）是神话——匹配假说在严格设计中不被支持；但领域类型（陈述性 vs 程序性）的适配是有机制依据的，两者不是一回事。出处：[Pashler, McDaniel, Rohrer & Bjork 2008, Learning Styles: Concepts and Evidence, PSPI 9(3)](https://doi.org/10.1111/j.1539-6053.2009.01038.x)。
   → 映射：给本系统的辩护与警示各一条——不必为「风格」做任何适配；但必须为「领域类型」做适配，这正是本笔记的主题。
5. **覆盖度对照（本次调研的总图景）**：

| 知识类型 | 巩固机制 | 需要的证据通道 | learnhub 现有组件 | 覆盖度 |
|---|---|---|---|---|
| 陈述性（事实/规则/词块） | 检索+间隔巩固记忆 | 题目作答流 | 题目级 FSRS + 复习队列 + Mastery | **完整**（主场） |
| 鉴别/分类（练耳、影像、棋型） | 同陈述性，带感知成分 | 大量带反馈的分类判断 | 同上（缺音频/图片题型） | 大部分（F8 补齐） |
| 程序性（认知技能：语法运用、解题套路） | 知识编译+产生式强度（幂律） | 变式任务的执行本身 | practice 交互件 + 练习证据 EMA | 部分（容量受限、非变式序列） |
| 运动/音乐技能 | 运动程序化（与陈述性不同源） | 实时动作反馈+分布练习计划 | 仅外部回执（无） | 缺（F3） |
| 创造/综合（月级项目） | 全任务执行+反思+渐退支持 | 项目里程碑+反思产物 | 无 | 缺（F1/F2/F5） |
| 习惯 | 情境-反应绑定（非记忆） | 情境重复+自动化自评 | XP streak（记录层） | 缺（F4） |

## 2. 内隐域：学界解释与有证据的方法

### 2.1 运动技能

1. **练习变异性与 contextual interference（CI）**：在同一节课内随机混合多个变式（random practice）习得期慢，但保持/迁移测试优于分组块练（blocked）——Shea & Morgan 1979 经典范式；元分析确认方向性优势（Brady 2004）。边界条件：Magill & Hall——低复杂度任务 CI 有利，高复杂度任务习得期仍宜分块，把一个复杂动作先整块学会再随机化。出处：[Shea & Morgan 1979, JEP: HPP 5(2)](https://doi.org/10.1037/0278-7393.5.2.179)、[Brady 2004, Contextual interference: a meta-analytic study, Perceptual and Motor Skills 99(4)](https://doi.org/10.2466/pms.99.4.116-126)、[Magill & Hall 1990, Human Movement Science 9(3-5)](https://doi.org/10.1016/0167-9457(90)90005-x)；变异性理论源头 [Schmidt 1975, A schema theory of discrete motor skill learning](https://doi.org/10.1037/h0076770) 与 [Kerr & Booth 1978, Specific and Varied Practice of Motor Skill](https://doi.org/10.1177/003151257804600201)。
   → 映射：这与既有 learning-science 笔记的「交错」条目同源，但强调运动域的边界条件——复杂动作先块后随机。若 learnhub 未来为运动/乐器域排「练习计划」，块状→随机的渐变序列比一刀切交错更符合证据。**2024 注册式元分析警戒线**（深潜 A §3.1）：CI 保持 SMD=0.63 [0.33,0.93]，但**实验室情境 0.92 vs 现场 0.23（不显著）、青少年≈0**——随机化编排的收益主要在实验室任务上成立，真实练习场景别预期迁移，新手/青少年勿一刀切随机化。
2. **分布练习对运动任务同样有效但效应打折**：元分析 63 研究 112 效应量，间隔优于集中 d=0.46；任务复杂、间隔类型与方法学严谨度显著调节效应（严谨研究的效应更小）。出处：[Donovan & Radosevich 1999, Journal of Applied Psychology 84(5)](https://doi.org/10.1037/0021-9010.84.5.795)。
   → 映射：「每天 30 分钟练一周」优于「一次 3.5 小时」——本系统的每日容量模型（est 上限 30 分钟）与运动域证据兼容；但别对运动技能预期 FSRS 那么大的间隔收益。
3. **外部注意焦点（External Focus, EF）**：让学习者把注意放在「动作产生的效果」（球飞向哪里、杆头轨迹）而不是身体部位本身，元分析 73 研究：表现 g=0.264、保持 g=0.583、迁移 g=0.584。出处：[Chua, Lewthwaite & Wulf 2021, Superiority of external attentional focus, Psychological Bulletin 147(9)](https://doi.org/10.1037/bul0000335)、综述 [Wulf 2013](https://doi.org/10.1080/1750984x.2012.723728)。
   → 映射：这是**话术层**的发现，成本几乎为零——未来任何运动/乐器节段的指导语模板，都应把「收肘」写成「让拍面指向目标」。属于可立即借鉴、不需要新功能的证据。
4. **反馈是双刃：guidance hypothesis**：每次都给增强反馈（结果知识/表现知识）让学习者依赖反馈，撤掉后保持成绩下降；应递减频率、带宽化（错得多才说）。出处：[Salmoni, Schmidt & Walter 1984, Knowledge of results and motor learning, Psychological Bulletin 95(3)](https://doi.org/10.1037/0033-2909.95.3.355)。
   → 映射：AI 老师的「错误当下介入」（big-directions Arc D）在动作域要有渐退设计，不是越多越好；对题目反馈同理——每题秒级全解析可能制造依赖。
5. **自控反馈（self-controlled feedback）**：让学习者自己决定何时要反馈，习得期效应很大（ES≈1.87 vs 规定反馈 0.85），但**保持期证据混杂**（一项元分析中保持期不显著甚至反转）。出处：[Amaro et al. 2020?—Journal of Motor Behavior 元分析, 10.1080/00222895.2020.1782825](https://doi.org/10.1080/00222895.2020.1782825)、更新元分析 [Behavioral Sciences 2025](https://doi.org/10.3390/bs15091291)（第一作者见链接；效应见摘要）。
   → 映射：与既有 Arc E5「自选难度+教练」一致：给选择权，但配数据点破——运动域的版本是「自选反馈」也要防止变成逃避困难。
6. **心理演练（motor imagery / mental practice）**：Driskell 1994 元分析确认正效应（常引 d≈0.48，转述）；24 年后重复元分析给出更诚实的数字：发表偏倚校正后 r=0.131，小而显著；对外部提示的运动任务更好，1–6 周项目更有效。身体练习为主、心理演练为辅。出处：[Driskell, Copper & Moran 1994, JAP 79(4)](https://doi.org/10.1037/0021-9010.79.4.481)、[Toth et al. 2020, Psychology of Sport and Exercise 48](https://www.sciencedirect.com/science/article/abs/pii/S1469029219301530)。
   → 映射：「不能弹琴/不能上场时做什么」有实证答案——想象执行+看示范，可作为实践节点的补充形态；但预期收益要按小效应管理。
7. **显性指导的边界随水平反转**：新手从显性技术指导中受益（先知道怎么做）；高手在压力下若把注意拉回显性规则（reinvestment，choking 的一种机制）反而退步——这解释了为何「外部注意焦点」对高手更关键。综述性结论（转述）：指导的显性化程度应随熟练度渐退。出处：与 §2.1.3 同源（[Wulf 2013 综述](https://doi.org/10.1080/1750984x.2012.723728)）；与既有 learning-science 笔记的「专业度反转」条目为同一原理在运动域的表现。
   → 映射：运动/乐器域的指导密度不能恒定——「指导随水平渐退」是两条证据线的公共结论，正好是 F2 渐退模板的另一个论据。
8. **运动域的「全链路教学法」对应物是 CLF（constraints-led，约束导向）**：不逐条纠正动作，而是设计约束（场地大小、规则、器材）让目标动作模式在解决问题中自发涌现；教练的角色从「给答案」变成「设局」。理论成熟（Renshaw, Chow, Davids & Hammond 2019《The Constraints-Led Approach》，Routledge，书；转述），效果证据为情境化研究、无大元分析（标注）。
   → 映射：CLF 与 4C/ID 在精神上同构（真实任务+环境设计代替分步讲解），是 §4 范式在运动域的对位；learnhub 若做运动域，内容形态应输出「练习局的设计」（约束/目标/变式），而不是动作分解文字。

### 2.2 乐器

1. **刻意练习之争**：Ericsson 1993 提出专家表现主要由刻意练习量解释（音乐专业学生对照组的累积练习量差异）；Macnamara, Hambrick & Oswald 2014 元分析反过来说：刻意练习只解释表现方差的游戏 26%、音乐 21%、体育 18%、教育 4%、职业 <1%；Ericsson 2014 回应称元分析混入了「非个体化的一般经验」测量、低估真实刻意练习；2019 年对 1993 年原始样本的再访谈发现顶尖与优秀小提琴学生差异**并非**练习量所解释；2021 年再反水：个体化程度与练习质量被元分析忽略后，练习测量的预测力显著回升。结论：练习量必要而不充分，「怎么练」（个体化+质量）可能是更大杠杆——对个人学习者反而是好消息。出处：[Ericsson, Krampe & Tesch-Römer 1993, Psychological Review 100(3)](https://doi.org/10.1037/0033-295x.100.3.363)、[Macnamara et al. 2014, Psychological Science 25(3)](https://doi.org/10.1177/0956797614535810)、[Ericsson 2014, Intelligence 45](https://doi.org/10.1016/j.intell.2013.12.001)、[Macnamara & Maitra 2019, Royal Society Open Science 6(5)](https://doi.org/10.1098/rsos.190327)、[Debatin et al. 2021, Current Psychology](https://doi.org/10.1007/s12144-021-02326-x)。
   → 映射：本系统 XP 账本只记「有效专注的量」——这场争论直接说明**量不是全部**；Modacity 等产品把「记录每次练习的目标/问题/录音」做成核心功能（§5），是「质量」侧的产品化。learnhub 的学习者产出通道天然适合承接「今天练习解决了什么问题」。
2. **心理表征：刻意练习框架里「量」背后的真变量**：Ericsson 晚年把刻意练习的机制落在心理表征（mental representations）上——专家与新手的核心差异是「对表现的内部模型」质量，刻意练习的作用是持续把表现与该模型对照修正。这解释了为什么纯堆量无效（无对照就无修正），也解释了记录/回听/自我评估为何有效。出处：Ericsson & Pool 2016《Peak: Secrets from the New Science of Expertise》（书，转述）；框架源头见 [Ericsson et al. 1993](https://doi.org/10.1037/0033-295x.100.3.363)。
   → 映射：Modacity 的产品逻辑（每段练习先写意图、后回听录音对照）就是「表征对照」的产品化；learnhub 的学习者产出通道（big-directions E1/E2）在内隐域的自然形态是「练习意图+自我评估」，而非自造题。
3. **音乐技能的程序性本质与慢练**：音乐表演是高度程序性的运动序列；慢练/分段的直接 RCT 缺失（诚实标注），相邻证据是 4C/ID 的部分任务练习（part-task practice）——对 recurrent 技能成分先单独练到自动化再合成（见 §4.1），以及 Drake & Palmer 对音乐表演计划与练习关系的研究。出处：[Drake & Palmer 2000, Cognition 74](https://doi.org/10.1016/s0010-0277(99)00061-x)、van Merriënboer, Clark & de Croock 2002（§4.1）。
   → 映射：若做乐器域，可把「慢练某乐段→原速合成」建模为支持渐退的任务序列，而不是把乐理出完题就完事。
4. **练耳是伪装成技能的陈述性/鉴别性任务**：Functional Ear Trainer 的方法是「在调性语境中辨认音级」（scale degree recognition）——本质是带即时反馈的海量分类检索练习，**天然适合间隔调度**（同 Anki 社区的听感牌组）。出处：[functionaleartrainer.com](https://www.functionaleartrainer.com/)（方法文档）；学界对应物为音高/调性模式训练研究（转述）。
   → 映射：这是内隐域里**最接近现有系统能力**的一块——它只需要音频题型（F8），调度、 mastery、题目管理全部复用。

### 2.3 习惯养成：与知识学习的分野

1. **习惯是另一套机制**：约 43% 的日常行为是情境触发的自动化反应（不进入决策）；习惯=「情境-反应」绑定，靠稳定情境中的重复+奖励形成，与陈述性记忆、与「会不会」无关——你不会「忘记」怎么刷牙，但会失去刷牙的自动化。出处：[Wood, Quinn & Kashy 2002, JPSP 83(6)](https://doi.org/10.1037/0022-3514.83.6.1281)、[Wood & Rünger 2016, Psychology of Habit, Annual Review of Psychology 67](https://doi.org/10.1146/annurev-psych-122414-033417)。
   → 映射：「每天背 50 卡」本身也可以是一个习惯目标，但「每天复习到期卡」是 FSRS 驱动的任务，两者机制不同——习惯的调度者是用户的日历与情境，不是到期队列。
2. **自动化需要多久：Lally 2010**：66 名成功建模者，同一情境重复行为 84 天，自动化（SRHI 子集）拟合渐近曲线，达到 95% 渐近水平的中位时间 **66 天**，范围 **18–254 天**；漏掉一天没有实质影响。出处：[Lally, van Jaarsveld, Potts & Wardle 2010, European Journal of Social Psychology 40(6)](https://doi.org/10.1002/ejsp.674)（Crossref 收录年 2009）。
   → 映射：给任何「习惯功能」的期望管理模板：不是 21 天、不是打卡完美主义；中断可恢复——streak 设计必须宽容（见下条）。
3. **执行意图（implementation intentions）是习惯域效应量最高的组件**：「if 情境 then 行动」计划把控制权交给情境线索，元分析 94 项检验 d=0.65。出处：[Gollwitzer & Sheeran 2006, Advances in Experimental Social Psychology 38](https://www.sciencedirect.com/science/chapter/bookseries/pii/S0065260106380021)、[全文 PDF（美国国家癌症研究所镜像）](https://cancercontrol.cancer.gov/sites/default/files/2020-06/goal_intent_attain.pdf)。
   → 映射：几乎零成本的形态：「我将在【时间/地点】之后【做】」写入目标偏好——与 big-directions E3（目标所有权）共享数据结构。
4. **诱惑捆绑与承诺装置**：把「想做的事」（听有声书）绑定「该做的事」（健身），初期健身房到访 +51%（完全捆绑）/+29%（中间条件）；承诺装置（质押金钱/公开承诺）在健康行为中有可控证据。出处：[Milkman, Minson & Volpp 2014, Holding the Hunger Games Hostage at the Gym, Management Science 60(2)](https://doi.org/10.1287/mnsc.2013.1784)、[Rogers, Milkman & Volpp 2014, Commitment Devices, JAMA 311(20)](https://doi.org/10.1001/jama.2014.3485)、业界实现 [stickK.com](https://www.stickk.com/)（耶鲁经济学家创建的承诺契约平台）。
   → 映射：XP 账本是「记录」不是「承诺」；若做激励，捆绑（学完才解锁娱乐）与质押是文献支持的两种形态——但都是动机层，CONTEXT.md 明确 XP 以记录为本，需谨慎不越位。
5. **streak 的双刃**：Duolingo 官方实验显示 streak 显著提升 D1/D7/D14 留存，达 7 天 streak 的用户继续学习可能性 2.4 倍；但其官方博客同时承认断签焦虑问题，streak freeze 就是为此设计。行为结局（而不只是留存）的证据不稳。出处：[Duolingo 官方：streak 背后的习惯研究](https://blog.duolingo.com/how-duolingo-streak-builds-habit/)、[streak 留存实验](https://blog.duolingo.com/how-streaks-keep-duolingo-learners-committed-to-their-language-goals/)、[改进 streak](https://blog.duolingo.com/improving-the-streak/)；游戏化总体效应见 [Sailer & Homner 2019, The Gamification of Learning: a Meta-analysis, Educational Psychology Review 32](https://doi.org/10.1007/s10648-019-09498-w)（认知 g=0.49 在严谨研究中稳定；动机 g=0.36、行为 g=0.25 不稳定）。
   → 映射：本系统已有 XP streak 派生指标；教训是：streak 服务于「连续性」，其宽容机制（freeze/漏天无损）应先行——与 Lally 的「漏一天无碍」一致。
6. **习惯 App 的普遍缺陷**：提醒类 App 支持「行为启动」而不支持「习惯形成」（缺情境绑定与自动化测量设计）。出处：[Stawarz, Cox & Blandford 2015, Beyond Self-Tracking and Reminders, CHI 2015](https://doi.org/10.1145/2702123.2702230)、[同组 2014](https://doi.org/10.1145/2556288.2557079)。
   → 映射：做习惯功能时避免重蹈「又一个提醒器」——组件应该是执行意图+情境+进度可视化，而不是把「到期」语义套上去。Tiny Habits（Fogg 2021，书）的「锚点+缩小行为」是同一方向的从业者版（证据以小样本/从业验证为主，标注）。
7. **学习行为本身是习惯问题**：「每天坐下来学 30 分钟」不是陈述性知识，而是一个行为习惯——它的失败模式（三天打鱼）与健身、冥想完全同构。Duolingo 的核心产品创新（streak/streak freeze/提醒）正是把 SRS 产品的一半工程花在了行为习惯层。出处：同上 Lally/Wood/§5.5。
   → 映射：本系统把 XP streak 当作记账衍生品，方向诚实；但若用户留存问题显现，文献指向的杠杆不是更多游戏化（行为结局不稳），而是执行意图（上桌计划）与宽容连续性（freeze/漏天无损）——见 F4。

## 3. 语言为何相对适用，以及它的程序性边界

1. **词汇是陈述性检索的最佳主场**：L2 间隔练习元分析（48 实验 98 效应量）：间隔对二语学习中到大的效应；短间隔即时测试与长间隔同效，但**延迟测试长间隔更优**——与 FSRS 的记忆模型语义完全同构。出处：[The Effects of Spaced Practice on Second Language Learning: A Meta-Analysis, Language Learning 2022](https://doi.org/10.1111/lang.12479)；综述 [Carpenter, Pan & Butler 2022, Nature Reviews Psychology](https://doi.org/10.1038/s44159-022-00089-1)；Duolingo 的 HLR 调度见既有 industry-scan/big-directions 笔记（不重复）。
2. **显性教学+练习在 SLA 里是占优路径**：Norris & Ortega 2000 综合 49 研究：聚焦式显性教学产生大而持久的靶点增益，显性优于隐姓埋名的纯浸入——这为「先教后练再间隔」的本系统形态背书。出处：[Norris & Ortega 2000, Effectiveness of L2 Instruction, Language Learning 50(1)](https://doi.org/10.1111/0023-8333.00136)。
3. **语法直觉的自动化（程序性边界一）**：DeKeyser 的技能习得理论把 SLA 映射到 ACT-R：显性规则经大量练习自动化为程序性能力；其 1997 实证显示形态-句法自动化遵循与认知技能相同的练习规律。learnhub 的「规则题+间隔」部分覆盖这条路径，但自动化的量（成千上万次变式提取）超出题库容量。出处：[DeKeyser 1997, Beyond Explicit Rule Learning, SSLA 19(2)](https://doi.org/10.1017/s0272263197002040)；系统化论述见 DeKeyser (Ed.) 2007《Practice in a Second Language》（书，转述）。
4. **输入假说的争议（程序性边界二）**：Krashen 主张可理解输入驱动习得、显性「学习」不能转化为「习得」（无接口）；该假说因不可证伪与循环定义受到持续批评（Gregg 1984）。Swain 的输出假说补充了输入侧缺失的三功能（注意缺口、假设检验、元语言反思）。工程结论：纯输入不服从调度（听/看量由内容供给决定），纯卡片也不产生输出。出处：Krashen 1982《Principles and Practice in Second Language Acquisition》[作者官网全文 PDF](http://www.sdkrashen.com/content/books/principles_and_practice.pdf)、[Gregg 1984, Krashen's Monitor and Occam's Razor, Applied Linguistics 5(2)](https://doi.org/10.1093/applin/5.2.79)、Swain 1985「The output hypothesis」载 Gass & Madden (Eds.)《Input in Second Language Acquisition》（书章，转述）。
5. **任务型教学（TBLT）的证据**：52 项长期实施研究合成，TBLT 对二语发展总体 d=0.93——真实交际任务才是流利度的证据主场，卡片只是脚手架。出处：[Bryfonski & McKay 2019, TBLT implementation and evaluation: A meta-analysis, Language Teaching Research 23(5)](https://doi.org/10.1177/1362168817744389)。
   → 映射（本节汇总）：语言课程里「词汇/词块/语法规则」子图交给现有管线（证据最强）；「输入流」（Refold 式浸入）与「输出任务」（TBLT/iTalki 真人）应建模为外部通道或实践节点，不假装能被 FSRS 调度。业界对照见 §5。

## 4. 创造性学习与月级项目：全链路范式盘点

### 4.1 4C/ID 全任务法（与本系统张力最大、最值得细读）

1. **核心主张**：复杂技能的学习任务应以**真实全任务**组织，按 task classes 由简到繁排成变式序列；类内做**支持渐退**：完整样例（worked example）→ 补全任务（completion）→ 常规任务（conventional）；「支持性信息」（心智模型/认知策略，随任务类提升）与「即时信息」（怎么做的规则，随熟练度渐退）分开供给；只有 recurrent 技能的原子成分才做孤立的部分任务练习（part-task practice）。**completion strategy 直接回答「60 个原子单元 vs 一个月大项目」：让学习者从同一真实任务的中间状态补全，随熟练度减少预置部分——既保真实情境又控制负荷。**出处：[van Merriënboer, Clark & de Croock 2002, Blueprints for complex learning: The 4C/ID-model, ETR&D 50(2)](https://doi.org/10.1007/bf02504993)；体系详见 van Merriënboer & Kirschner《Ten Steps to Complex Learning》（书，转述）。
   → 映射：本系统=「原子优先」（节点≤30 分钟，极端 60），4C/ID=「全任务优先」（任务可以是周级的）。两者并不互斥：乐理、词汇这类陈述性子技能正是 4C/ID 里该做 part-task practice 的部分；而「月级项目」可以成为图上的一种**全任务节点**，其学习行为由「补全度」渐退来定义（见 F1/F2）。
2. **四组件清单（4C/ID 的名字来源）**：①learning tasks（全任务变式序列，按 task classes 排序，类内随机化以获得 contextual interference 的收益）；②supportive information（心智模型与认知策略，随任务类递进，课前给）；③just-in-time information（执行规则与纠错指导，随熟练度渐退）；④part-task practice（只对 recurrent 成分做孤立自动化练习，带间隔）。**对本系统最锋利的一条判据：原子化拆分是 4C/ID 里的第④组件，而本系统把④当成了全部**——①②③没有对应物。出处：同上（[ETR&D 50(2)](https://doi.org/10.1007/bf02504993)）。
   → 映射：不必推翻现有架构：①可由项目节点承担（F1），③可由 AI 老师的 contextual 介入承担（Arc D），②可由节点正文承担；真正缺的是「把①接进图与调度」的语义。
3. **既有系统的位置**：practice 交互件节点已是「交互任务」的雏形，但单节点≤60 分钟的容量上限使其永远做不成 task class（变式序列）。差距不在交互件，在「任务的纵向组织」。

### 4.2 认知学徒制与产出式学习

1. **认知学徒制**：modeling（专家演示）→ coaching（陪练反馈）→ scaffolding（支撑）→ fading（撤除）+ articulation/reflection（外化与反思）。这是「真实情境+专家 invisible 技能显性化」的通用框架，医学模拟教育（§4.3）与编程导师制（§5）都是它的实例。出处：Collins, Brown & Newman 1989「Cognitive Apprenticeship: Teaching the Crafts of Reading, Writing, and Mathematics」，载 Resnick (Ed.)《Knowing, Learning, and Instruction》[Routledge 章节 DOI](https://doi.org/10.4324/9781315044408-14)。
   → 映射：AI 老师抽屉≈coaching；「讲给我听」（big-directions E2）≈articulation；缺的是 modeling（看专家全程怎么做）与 scaffolding/fading 的结构——在项目域才显现需求。完整方法论是六步循环：modeling（专家演示并外化决策）→ coaching（学员做、专家即时反馈）→ scaffolding（给提示与部分成品）→ articulation（学员说出自己的思路）→ reflection（对照专家做法）→ exploration（独立扩展），fading 贯穿全程（同上出处）。对照 CodeCrafters 的 stage 提示渐退与 Exercism 的人评，方法论完全同源——业界把「coaching+fade」做成了订阅制人工服务，AI 时代的差异化机会是把 coaching 的边际成本打到零。
2. **productive failure（生产性失败）**：先让学生对没学过的概念自行解题（失败），再给规范教学，比「先教后练」在深度理解/迁移上更优；元分析 53 研究 166 比较：PS-I（解题-教学）优于 I-PS（教学-解题）g=0.36 [0.20, 0.51]，高保真实现 0.37–0.58；**幼龄（2–5 年级）例外**。出处：[Sinha & Kapur 2021, When Problem Solving Followed by Instruction Works, Review of Educational Research 91(6)](https://doi.org/10.3102/00346543211019105)。
   → 映射：与「样例效应+专业度反转」（既有 learning-science 笔记 §2）合起来看：新手要样例，但**在真实项目域**，允许先挣扎再教学的顺序选项（F7）有中等效应支持——两条证据以「学习者水平+任务类型」为界。
3. **constructionism（建造主义）**：Papert——学习发生在「构建可分享的实物作品」时最有效。无严格元分析（标注），但其思想是 PBL/创客运动的源头。出处：Papert 1980《Mindstorms》；Harel & Papert (Eds.) 1991《Constructionism》中「Situating Constructionism」（书章；概述见 [Wikipedia: Constructionism](https://en.wikipedia.org/wiki/Constructionism_(learning_theory))，转述）。
4. **PBL 的效应量**：46 项实验研究元分析，项目式学习对学业成绩 g≈0.71，受学科/学段/时长调节。出处：[Chen & Yang 2019, Educational Research Review 26](https://doi.org/10.1016/j.edurev.2018.11.001)。
   → 映射：证据在 K–16 课堂、教师主导场景，外推到成人自学需谨慎；但方向与 4C/ID、认知学徒制一致。

### 4.3 模拟器与工作场所

1. **模拟器训练（医学教育）**：模拟+刻意练习 vs 传统临床教学，14 项比较研究合并效应量 **0.71 [0.65, 0.76]**——「中间保真度的模拟环境」是通往真实技能的有效台阶。出处：[McGaghie et al. 2011, Academic Medicine 86(7)](https://doi.org/10.1097/acm.0b013e318217e119)。
   → 映射：实践交互件的证据背景（既有 learning-science 笔记 §5 已从 ICAP 角度论证）——模拟的价值在「可重复+可评分」，真实情境的价值在「迁移」，两者是阶梯不是替代。
2. **工作场所学习**：Eraut 指出专业知识大部分通过非正式工作学习获得，其传递依赖情境与关系，难以课程化。出处：[Eraut 2000, BJEP 70(1)](https://doi.org/10.1348/000709900158001)。
   → 映射：对「课程图能覆盖职业能力到什么程度」的期望校准——课程图能到「能上岗的知识底座」，能力成熟在工作里发生。

### 4.4 长项目中的学习机制（项目中学 vs 学后做）

1. **反思的实证**：Wipro 呼叫中心新员工培训中，每天最后 15 分钟书面反思「学到了什么」，结业测试成绩 +22.8%（后续实验室复制同方向）；作者结论：经验不会自动变成学习，反思是把经验转成学习的关键机制。出处：[di Stefano, Gino, Pisano & Staats 2014, Learning by Thinking（SSRN 工作论文）](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2414478)、[HBR 报道](https://hbr.org/2014/07/dear-diary)、[HBS Working Knowledge](https://www.library.hbs.edu/working-knowledge/reflecting-on-work-improves-job-performance)。军队系统的同型实践为 AAR（事后回顾），见 [HBR: Learning in the Thick of It](https://hbr.org/2005/07/learning-in-the-thick-of-it)（转述）。**证据降级**（深潜 B §1.4）：此文至今未通过期刊同行评审（SSRN 工作论文状态），且合作者之一自 2021 年起卷入数据诚信调查（本文不在已知撤稿列表）；反思的头号证据改为 debrief 双元分析——Keiser & Arthur 2021 d=0.79、Tannenbaum & Cerasoli 2013 d=0.67，有效配方=客观记录回放+个体/团队对齐+学员主导。
   → 映射：项目节点天然该有「收尾反思」动作，且其产物（项目日志）可注册为复习对象（F5，与既有 Arc C1 笔记源机制直接复用）。
2. **检索+间隔在真实课程中的「边做边复习」**：successive relearning（重复的「检索→间隔→再检索」循环）提升课程考试成绩与长期保留（课堂实地）；对学校场景的系统综述确认检索练习收益跨年龄/学科稳定。出处：[Rawson & Dunlosky 2013, The Power of Successive Relearning, Educational Psychology Review 25](https://doi.org/10.1007/s10648-013-9240-4)、[Rawson, Dunlosky & Matyas? 2020—Applied Cognitive Psychology 高风险考试研究](https://doi.org/10.1002/acp.3699)、[Agarwal, Nunes & Blunt 2021, Educational Psychology Review 33](https://doi.org/10.1007/s10648-021-09595-9)；检索优于精细加工的概念图：[Karpicke & Blunt 2011, Science 331](https://doi.org/10.1126/science.1199327)。
   → 映射：Karpicke & Blunt 对「把项目日志当复习对象」有一个重要设计含义：**复习日志不能只是重读**（重读弱于检索）——应该从日志出题/挖空/自述重写，即笔记源「只读出题」机制的直接延伸（F5/F6）。
3. **诚实标注**：「月级项目中嵌入间隔检索」没有直接 RCT——上面都是相邻证据（真实课程中的 successive relearning + 工作培训中的反思实验），外推合理但未验证。
4. **工程实践中的对应物**：tracer bullet（曳光弹：先打通端到端的最小实现）与 walking skeleton（行走骨架：把主要构件连起来的最小端到端系统）——学习视角读法：先建立完整图式（whole schema）再局部深化，同时尽早暴露集成风险；与 4C/ID 的「先简后繁全任务」同构。出处：Hunt & Thomas《The Pragmatic Programmer》[书页](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/)；[C2 wiki: WalkingSkeleton](https://wiki.c2.com/?WalkingSkeleton)（Cockburn 提出，定义见 Crystal Clear，书，转述）。
   → 映射：F2 的项目模板渐退路径（骨架→补全→独立）有工程实践与教学理论的双重出处。
5. **「学后做」还是「做中学」：证据支持的是序列融合**：陈述性底座用「先教+间隔」（本系统主场，Dunlosky/SLA 元分析均支持）；综合能力用「先做后教」（PS-I g=0.36）；期间用反思（+22.8%）与 successive relearning 保持检索密度。三种节奏分别对应学习图节点、项目节点、复习队列——它们不是竞争范式，而是**时间轴上的三个区段**。出处：本节前述各条。
   → 映射：learnhub 当前把三段压缩成一段（先教后测+间隔），对陈述性域足够；月级项目需求本质是「第二区段与第三区段在场」，即 F1+F5+F6 的组合。

## 5. 业界产品扫描：全链路学习的现有形态

共性观察：**每个内隐域的成熟产品，补的都是「实时反馈回路」或「真实情境」这两块 learnhub 没有的东西**；它们不试图把陈述性记忆做深（那是 learnhub/Anki 的主场）。

### 5.1 乐器
- [Yousician](https://yousician.com/)：设备麦克风实时音高检测，边弹边判，游戏化关卡——反馈延迟压到秒级（官方功能页）。
- [Synthesia](https://synthesiagame.com/)：下落音符+支持发光键盘，视觉引导的「跟随式练习」（官方）。
- [flowkey](https://flowkey.com/)：视频示范+听你弹的「等待模式」（弹对才继续）——把 feedback 变成 gate（官方功能页）。
- [SmartMusic](https://www.smartmusic.com/)：学校乐队市场，伴奏+红绿逐音评估，教师端布置与批改——「评估型伴奏」形态（官方）。
- [Modacity](https://modacity.co/)：反其道行之——不做游戏化，做**刻意练习日志**：每段练习记录意图/问题/录音，回听对比（官方首页自述 Music Practice Journal & Companion）。
- [Functional Ear Trainer](https://www.functionaleartrainer.com/)：音级听感训练（见 §2.2.3）。
- 启示：learnhub 在乐器域的正确位置是 Modacity 式「练习日志+复习」与乐理/练耳题库（F3/F8），不是再造 Yousician 的实时音频引擎。

### 5.2 运动
- 视频动作反馈：体育教学系统综述（11 项研究）支持视频示范/自我示范+言语反馈优于纯言语（[German Journal of Exercise and Sport Research 2021](https://doi.org/10.1007/s12662-021-00782-y)）；消费端为 Coach's Eye 类录像标注 App（生态碎片化，无强证据产品）。
- CLF（constraints-led，约束导向教练法）：改约束（场地/规则/器材）而不是教标准动作，让技能从环境互动中涌现——理论框架成熟（Renshaw, Chow, Davids & Hammond 2019《The Constraints-Led Approach》，Routledge，书；转述），**效果证据多为情境化研究，App 化产品罕见**。
- Strava 类社群承诺：段位/排行榜是社群承诺装置；效果证据为留存行为（内部数据），非技能习得（标注）。
- 启示：运动域产品化的可复制部分是「视频自评+教练批注」与「练习计划的分布/变异性设计」（§2.1.1/2.1.2）；learnhub 若介入，起点是练习计划与日志（同 F3），把「何时练、练什么变式、反馈何时给」当作可调度对象，而不是试图感知动作本身。

### 5.3 编程
- [Exercism](https://exercism.org/)：免费练习题 + 社区**导师人评**（mentoring）——认知学徒制的 coaching 规模化（官方；本站 mentor 流程文档见站内 Docs）。
- [CodeCrafters](https://codecrafters.io/)：「自己造一遍 Redis/Git/Kafka/Shell」，按 stage 推进（Build your own Redis 有 **97 个 stage**）——**这就是 4C/ID completion strategy 的产品化**：给骨架与渐进提示，让学习者在真实复杂度里从补全走向独立（官方首页）。同趋势的社区索引：[build-your-own-x（GitHub）](https://github.com/codecrafters-io/build-your-own-x)。
- [JavaScript30](https://javascript30.com/)：30 个无框架小项目——「中等粒度全任务」序列（Wes Bos 官方）。
- [SICP](https://mitpress.mit.edu/9780262510875/structure-and-interpretation-of-computer-programs/)（MIT Press）：习题驱动的概念建构经典——「书+习题」的全链路原型。
- LeetCode 模式刷题（[NeetCode](https://neetcode.io/) 把 150 题组织成 pattern 树）：**模式刷题=陈述性化+交错调度**，工程社区普遍认为它训练「面试模式识别」而非工程能力（社区共识，非研究证据，标注）。
- 启示：编程域把「陈述性检索（语法/API）→ 模式刷题 → 大项目」做成了一条事实上的渐退链；learnhub 现在只有第一环。

### 5.4 语言
- [Refold](https://refold.la/)：浸入式习得路线图（immersion 为主、卡片为辅），代表「输入流」一极（官方 roadmap）。
- [Clozemaster](https://www.clozemaster.com/)：海量句境填空（cloze）——把词汇检索放进句法语境的批量方案（官方首页）。
- [Pimsleur](https://www.pimsleur.com/)：graduated interval recall（渐进间隔回忆）的音频课程，方法源头是 [Pimsleur 1967, A Memory Schedule, Modern Language Journal 51(2)](https://doi.org/10.1111/j.1540-4781.1967.tb06700.x)——间隔调度早于 SRS 软件的实践版。
- [iTalki](https://www.italki.com/)：真人 1 对 1——输出反馈的外包（无效果研究，市场验证，标注）。
- 启示：语言是唯一每环都有成熟独立产品的领域；learnhub 的差异化在把「陈述性环」做深（题目级 FSRS），并诚实地把输入/输出环留给外部或桥接（Khanmigo RCT 的教训同样适用：自由对话不是输出环的答案）。

### 5.5 习惯
- [Habitica](https://habitica.com/)：RPG 化任务/习惯管理；[Streaks](https://streaksapp.com/)：极简打卡；证据同 §2.3.5（游戏化行为结局不稳，Sailer & Homner 2019）。
- [stickK](https://www.stickk.com/)：承诺契约（质押+裁判）——承诺装置的产品化（§2.3.4）。
- Duolingo streak 体系：streak+freeze+里程碑社群化，官方 A/B 证据最充分（§2.3.5 链接）。
- 启示：习惯产品的可信组件清单很短：执行意图、承诺、宽容的连续性可视化。其余多为氛围。

### 5.6 通用
- **Anki 用于非陈述性领域的实践**：社区把 Anki 用于听感、心电图/影像鉴别、棋局模式等「快速鉴别」任务——本质仍是分类检索，说明 FSRS 语义可覆盖「感知分类」这类弱程序性任务（社区实践，无受控研究，标注；调度机制见 [Anki 手册](https://docs.ankiweb.net/scheduling.html)）。
- **SuperMemo incremental reading**：把「长文本阅读→摘录→挖空→调度」做成一个全链路——学习材料不再是预先拆好的节点，而是调度器边读边拆。它是「长文本全链路」的 30 年活体实验，本系统笔记源「只读出题」是它的保守子集。出处：[SuperMemo 帮助文档：Incremental reading](https://help.supermemo.org/wiki/Incremental_reading)（官方）。
- 启示：增量阅读证明「调度器可以当内容的组织者」，这为「项目日志/长文档进入复习系统」提供了形态先例（F5）。

### 5.7 跨领域机制对照（扫描的收束）

| 机制 | 乐器 | 运动 | 编程 | 语言 | learnhub 现状 |
|---|---|---|---|---|---|
| 秒级动作反馈 | Yousician/flowkey 音高检测 | 视频标注 | 测试即时判题 | 发音打分（Duolingo Max） | 无（也不该自建） |
| 真实情境/全任务 | 曲目演奏 | CLF 练习局 | CodeCrafters/JS30 | TBLT/iTalki 对话 | practice 交互件（粒度受限） |
| 支持渐退 | flowkey 等待模式 | 教练 hand-over | stage 提示/导师退场 | Pimsleur 句长递增 | 样例效应已用于节段；任务级渐退无 |
| 陈述性调度 | 乐理/练耳题 | 规则/战术卡 | 语法/API 卡 | Anki/Clozemaster | **最强项** |
| 行为习惯层 | 练琴日志（Modacity） | Strava streak | 提交连续性 | Duolingo streak | XP streak（记录层） |
| 人工/社群反馈 | SmartMusic 教师端 | 教练 | Exercism 导师 | iTalki | AI 老师（Arc D） |

读法：成熟产品普遍把「秒级反馈」和「真实情境」外包给领域设备/真人/工程判题，把「渐退」做成内容进度设计，把「习惯层」做成留存工程；learnhub 的独特资产仍是陈述性调度——补齐路径应是借它盘（F 弧），不是全线自建。

## 6. 对 learnhub 的可选方向（F 弧；均不拍板，标注证据强度与实现代价）

与既有 Arc A–E 正交或衔接；凡引用 E1/E2/C1 处见 `2026-09-big-directions.md`。

- **F1 项目节点 / 项目级调度**（新增节点类型：type=project，容量以周计，不进题目完成门禁）：证据=PBL g≈0.71（课堂场景）+4C/ID 理论+模拟器 0.71（台阶价值）；代价=大（新节点类型、新证据语义、图审计规则、与「节点≤30 分钟」领域定义冲突——需 `/domain-modeling` 先行）；风险=PBL 效应对教师主导场景敏感，自学场景未验证。落点：课程 schema（`registry.ts`/课程图）、完成门禁（`sessions.ts::readySet` 同族语义）、XP settle 需要里程碑粒度的新对账动作。
- **F2 项目渐退模板（completion strategy）**：项目按「tracer bullet 骨架→补全→独立」三档支持等级推进，AI 提供样例与部分实现；证据=4C/ID 理论（无单体大 RCT，标注）+CodeCrafters 形态验证；代价=中（内容管线要能生成「部分完成的任务」而非「正文+题目」，与现有六类节段模型不兼容，是真正的瓶颈）。落点：生成管线新任务类型（大纲阶段为项目规划里程碑与支持等级）、题库外的验收清单。
- **F3 练习证据通道扩展到动作域（外部回执）**：实践节点允许学习者提交外部练习回执（录音/视频链接、教练签核、App 导出截图）汇入练习证据 EMA；证据=弱-中（无 RCT，但与既有练习证据通道机制同构；Salmoni 渐退原则指导反馈频率）；代价=小-中（申报语义+Missing/Broken 边界要定义清楚：回执是证据不是内容）。落点：练习证据流水（`PracticeRec` 同族）加来源枚举、实践节点结算页。
- **F4 习惯一等公民（不是 FSRS 卡）**：独立 habit 对象：执行意图（if-then）+自动化进度可视化（Lally 曲线期望管理）+宽容 streak；证据=强（Gollwitzer d=0.65；Lally 2010；Sailer & Homner 的「行为结局不稳」警示 streak 泛滥）；代价=中（新对象类型+新调度语义——它没有 R/稳定度，硬套 FSRS 是领域错误）；与 CONTEXT.md 的冲突点：mastery 定义不覆盖习惯自动化，需要明确「习惯不是掌握度」。落点：新 registry 条目类型+面板新视图；与 E3 目标所有权共享「计划」数据结构。
- **F5 项目日志注册为复习对象**：debrief 双元分析的反思效应（Keiser & Arthur 2021 d=0.79 / T&C 2013 d=0.67，深潜 B §1.4；di Stefano 2014 已降级为工作论文级，谨慎引用）+ SuperMemo 增量阅读先例；落点=复用笔记源「只读出题」机制（与既有 Arc C1 完全同路，C1 做「个人笔记→课程」时把「项目/练习日志」列为头号用例即可）；代价=小（借 C1 之力）。
- **F6 项目内检索点（retrieve-as-you-go）**：项目里程碑处插低配检索点（从该项目关联节点的题池抽题+自述「到目前为止的关键决策」）；证据=课堂 quizzing 全景元分析 g=0.499（Yang et al. 2021，222 研究 48,478 名学生，深潜 B §1.5）+ successive relearning（检索+间隔在真实课程稳定）、项目内专门 RCT 仍缺（标注）；代价=小-中（调度层与项目节点的交互）。注意与 F5 的分工：F5 复习的是「日志写下的经验」，F6 复习的是「课程图里的知识」——两者在里程碑汇合（Karpicke & Blunt 的教训：检索化，不要只重读）。
- **F7 先做后教（PS-I 顺序选项）**：内容管线为「高难度/高 bloom」节点生成「先挑战题→再正文」的变体；证据=g=0.36（Sinha & Kapur 2021），幼龄例外→成人自学场景是适用区；代价=小（管线顺序开关+一个节段类型）；注意与既有「样例效应（新手要样例）」的边界——按节点难度分流，不是全局反转。
- **F8 音频题型（练耳/发音鉴别/乐句听辨）**：鉴别型任务天然适配 FSRS（§2.2.3、§5.6 Anki 实践）；证据=中（同构性论证+社区实践，无独立 RCT）；代价=中（题目 schema+渲染管线+移动端音频基建）。这是内隐域里唯一「不改调度语义、只加题型」的增量。

优先级视角（如需排序讨论）：F5/F7 小而证据扎实，F4 填补一个真实的领域空白，F1/F2 是「月级项目」问题的正面回答但需要先做领域建模决策，F8 是乐器/语言域的钥匙。

**F 弧与既有 Arc 的组合关系**（引自 `2026-09-big-directions.md`，避免重复立项）：

| 组合 | 内容 | 说明 |
|---|---|---|
| F5 × Arc C1 | 个人笔记/项目日志 → 复习对象 | 同一条管线，日志是头号用例——两者应合并立项而非各做一个 |
| F2 × Arc E1/E2 | 项目的「补全/讲解」产物 → 学习者产出 | 项目反思（F5 的产物）与自注解释共用调度与档案语义 |
| F1 × Arc A3 | 项目节点的练习真实调用 → enc 边 | 项目是 enc 边最自然的**真实存量来源**（全库 enc=0 的破局点之一） |
| F3 × Arc D | 外部回执 → AI 反馈当下化 | 回执触发「错误当下」讲解，而非自由答疑 |
| F4 × E3 | 习惯 if-then 计划 → 目标所有权 | 共享「学习者计划」数据结构 |
| F6 × Arc A1 | 里程碑检索点 → 会选题的调度 | 复用按 R 排序的出题拼装 |

## 7. 证据强度与争议汇总表

| 主题 | 代表证据 | 关键数字 | 强度 | 争议/注意 |
|---|---|---|---|---|
| 刻意练习量 vs 质量 | Ericsson 1993 vs Macnamara 2014 vs Ericsson 2014 vs Macnamara & Maitra 2019 vs Debatin 2021 | 音乐表现方差：练习解释 21%（元分析口径） | 高（双向元分析+再访谈） | 未决：练习**量**的解释力被高估或低估取决于「个体化测量」；量必要不充分 |
| 远迁移 | Sala & Gobet 2017 | 效应与设计质量反向 | 高 | 几乎一票否决「学好 A 自动惠及 B」类功能 |
| 外部注意焦点 | Chua et al. 2021, Psych Bull | perf .26 / retention .58 / transfer .58 | 高 | 主要是运动任务；对认知任务外推未证 |
| CI/练习变异性 | Shea & Morgan 1979; Magill & Hall 1990; Czyż 2024 注册式元分析（深潜 A） | 保持 SMD=0.63/迁移 0.55；**现场 0.23 ns、青少年 ns** | 中-高（方向）；现场存疑 | 复杂动作块练更优；随机化收益主要在实验室任务成立，真实场景勿一刀切 |
| 分布 vs 集中（运动） | Donovan & Radosevich 1999 | d=0.46（低严谨研究虚高） | 中 | 运动复杂任务收益打折 |
| 心理演练 | Driskell 1994 vs Toth 2020 | 常引 d≈0.48 → 偏倚校正后 r=0.131 | 中 | 预期管理：小效应，辅助手段 |
| 自控反馈 | JMB 2020 元分析 | 习得 1.87 / 保持期混杂 | 中 | 「给选择权」在保持期未必赢 |
| 间隔（L2） | Language Learning 2022 元分析 | 中-大；延迟测试长间隔优 | 高 | 与 FSRS 语义同构 |
| 显性 L2 教学 | Norris & Ortega 2000 | 大而持久；显性>隐性 | 高 | 靶点测量的局限（针对性测量的批评，转述） |
| TBLT | Bryfonski & McKay 2019 | d=0.93 | 中-高 | 长期项目实施研究，实施保真度异质 |
| 输入假说 | Krashen 1982; Gregg 1984 | — | 低（理论争议） | 不可证伪批评未解决；工程上别押注单一假说 |
| 执行意图 | Gollwitzer & Sheeran 2006 | d=0.65（94 检验） | 高 | 对简单行为的效应更强 |
| 习惯自动化 | Lally 2010 | 中位 66 天（18–254）；漏天无碍 | 中（单一前瞻研究） | 样本 82 人建模成功；行为差异大 |
| 游戏化 | Sailer & Homner 2019 | 认知 .49 稳 / 动机 .36 / 行为 .25 不稳 | 中 | 行为结局对发表偏倚敏感 |
| PBL | Chen & Yang 2019 | g≈0.71（46 研究） | 中 | 课堂场景；成人自学外推未证 |
| productive failure | Sinha & Kapur 2021 | g=0.36；高保真 0.37–0.58；幼龄例外 | 高 | 与样例效应的适用边界要按水平/任务分流 |
| 模拟器医学教育 | McGaghie 2011 | ES 0.71 [0.65,0.76]（14 研究） | 中-高 | 研究数少 |
| 反思/复盘 | Keiser & Arthur 2021; T&C 2013（深潜 B） | d=0.79（61 研究）/ d=0.67（46 样本）；有效配方=客观媒体+对齐+学员主导 | 高（双元分析） | di Stefano 2014 的 +22.8% 降级为工作论文级（未过同行评审、合作者涉数据诚信调查），谨慎引用 |
| 4C/ID 全任务 | Neck et al. 2025 系统综述（深潜 B） | g=0.76，但**全部来自无对照前后测**；54% 实施未完整报告四组件 | 中（设计框架成熟、因果证据薄） | 医学域 g≈0；part-task 实践中常被省略 |
| 反馈渐退（guidance hypothesis） | Salmoni 1984 | 无元分析量级；方向稳健（保持期） | 高（经典综述） | 反馈频率是设计参数，不是越多越好 |
| successive relearning | Rawson & Dunlosky 2013/2020; Agarwal 2021 | 真实课程考试成绩与长期保留提升 | 高 | 「项目内嵌检索」本身仍无专门 RCT |
| 掌握学习/2-sigma | Bloom 1984 vs Kulik et al. 1990 | Bloom 称 2σ；Kulik 108 研究：正效应但随设计严谨度缩水，且自定步调**降低课程完成率** | 高（争议已裁决） | 对本系统 R_GATE 门禁的警示：严格门槛有完成率代价 |
| 学习风格 | Pashler et al. 2008 | 匹配假说无严格支持 | 高（证伪） | 神话；勿据「风格」适配 |
| 外部动作反馈 | 视频反馈 PE 综述 2021（11 研究） | 示范/自我示范+言语 > 纯言语 | 中 | 教育场景；消费 App 无对照研究 |
| CLF 约束导向 | Renshaw et al. 2019（书） | — | 低-中（理论+情境研究） | 无大元分析 |
| Anki 非陈述用法 | 社区实践（练耳/影像/棋型） | — | 低（实践佐证） | 本质是分类检索，非运动程序 |
| 截止日期承诺 | Ariely & Wertenbroch 2002 | **已撤稿**（Crossref 标注 RETRACTED） | — | 承诺装置改引 Rogers/Milkman/Volpp 2014 |
| 项目内嵌检索 | （外推自 successive relearning / Agarwal 2021） | — | 低-中 | 无专门 RCT；机制同构论证 |

## 8. 主要来源汇总

**认知架构与迁移**
- [Anderson 1982, Acquisition of cognitive skill](https://doi.org/10.1037/0033-295x.89.4.369) / [Anderson 1996, ACT](https://doi.org/10.1037/0003-066x.51.4.355)
- [Sala & Gobet 2017, Does Far Transfer Exist?](https://doi.org/10.1177/0963721417712760)
- [Pashler et al. 2008, Learning Styles](https://doi.org/10.1111/j.1539-6053.2009.01038.x)
- [Kulik, Kulik & Bangert-Drowns 1990, Mastery Learning Meta-Analysis](https://doi.org/10.3102/00346543060002265)；Bloom 1984「2 Sigma」为对照命题（Educational Researcher 13(6)，转述）

**运动与音乐**
- [Shea & Morgan 1979](https://doi.org/10.1037/0278-7393.5.2.179) / [Brady 2004 CI 元分析](https://doi.org/10.2466/pms.99.4.116-126) / [Magill & Hall 1990](https://doi.org/10.1016/0167-9457(90)90005-x) / [Schmidt 1975](https://doi.org/10.1037/h0076770) / [Kerr & Booth 1978](https://doi.org/10.1177/003151257804600201)
- [Donovan & Radosevich 1999](https://doi.org/10.1037/0021-9010.84.5.795) / [Chua, Lewthwaite & Wulf 2021](https://doi.org/10.1037/bul0000335) / [Wulf 2013](https://doi.org/10.1080/1750984x.2012.723728)
- [Salmoni, Schmidt & Walter 1984（guidance hypothesis）](https://doi.org/10.1037/0033-2909.95.3.355) / [自控反馈元分析 2020 JMB](https://doi.org/10.1080/00222895.2020.1782825) / [2025 更新](https://doi.org/10.3390/bs15091291)
- [Driskell et al. 1994](https://doi.org/10.1037/0021-9010.79.4.481) / [Toth et al. 2020](https://www.sciencedirect.com/science/article/abs/pii/S1469029219301530)
- [Ericsson et al. 1993](https://doi.org/10.1037/0033-295x.100.3.363) / [Macnamara et al. 2014](https://doi.org/10.1177/0956797614535810) / [Ericsson 2014](https://doi.org/10.1016/j.intell.2013.12.001) / [Macnamara & Maitra 2019](https://doi.org/10.1098/rsos.190327) / [Debatin et al. 2021](https://doi.org/10.1007/s12144-021-02326-x) / [Drake & Palmer 2000](https://doi.org/10.1016/s0010-0277(99)00061-x)；Ericsson & Pool 2016《Peak》（书，转述）；Renshaw et al. 2019《The Constraints-Led Approach》（书，转述）

**习惯与动机**
- [Wood, Quinn & Kashy 2002](https://doi.org/10.1037/0022-3514.83.6.1281) / [Wood & Rünger 2016](https://doi.org/10.1146/annurev-psych-122414-033417) / [Lally et al. 2010](https://doi.org/10.1002/ejsp.674)
- [Gollwitzer & Sheeran 2006](https://www.sciencedirect.com/science/chapter/bookseries/pii/S0065260106380021)（[PDF](https://cancercontrol.cancer.gov/sites/default/files/2020-06/goal_intent_attain.pdf)）
- [Milkman et al. 2014 诱惑捆绑](https://doi.org/10.1287/mnsc.2013.1784) / [Rogers et al. 2014 承诺装置 JAMA](https://doi.org/10.1001/jama.2014.3485) / [stickK](https://www.stickk.com/)
- [Sailer & Homner 2019 游戏化元分析](https://doi.org/10.1007/s10648-019-09498-w) / [Stawarz et al. 2015](https://doi.org/10.1145/2702123.2702230)
- Duolingo streak 官方：[习惯研究](https://blog.duolingo.com/how-duolingo-streak-builds-habit/) / [留存实验](https://blog.duolingo.com/how-streaks-keep-duolingo-learners-committed-to-their-language-goals/) / [改进 streak](https://blog.duolingo.com/improving-the-streak/)

**语言**
- [L2 间隔练习元分析 2022](https://doi.org/10.1111/lang.12479) / [Carpenter et al. 2022](https://doi.org/10.1038/s44159-022-00089-1)
- [Norris & Ortega 2000](https://doi.org/10.1111/0023-8333.00136) / [DeKeyser 1997](https://doi.org/10.1017/s0272263197002040) / [Gregg 1984](https://doi.org/10.1093/applin/5.2.79) / [Krashen 1982 全文 PDF](http://www.sdkrashen.com/content/books/principles_and_practice.pdf) / [Bryfonski & McKay 2019](https://doi.org/10.1177/1362168817744389) / [Pimsleur 1967](https://doi.org/10.1111/j.1540-4781.1967.tb06700.x)

**全链路范式与项目**
- [van Merriënboer, Clark & de Croock 2002, 4C/ID](https://doi.org/10.1007/bf02504993)（Ten Steps 为书，转述）
- [Collins, Brown & Newman 1989, 认知学徒制](https://doi.org/10.4324/9781315044408-14)
- [Sinha & Kapur 2021, PS-I 元分析](https://doi.org/10.3102/00346543211019105) / [Chen & Yang 2019 PBL](https://doi.org/10.1016/j.edurev.2018.11.001) / [McGaghie et al. 2011 模拟器](https://doi.org/10.1097/acm.0b013e318217e119) / [Eraut 2000](https://doi.org/10.1348/000709900158001)
- [di Stefano et al. 2014 反思（SSRN）](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2414478) / [HBR](https://hbr.org/2014/07/dear-diary) / [HBS WK](https://www.library.hbs.edu/working-knowledge/reflecting-on-work-improves-job-performance) / [AAR（HBR 2005）](https://hbr.org/2005/07/learning-in-the-thick-of-it)
- [Rawson & Dunlosky 2013 successive relearning](https://doi.org/10.1007/s10648-013-9240-4) / [2020 高风险考试](https://doi.org/10.1002/acp.3699) / [Agarwal et al. 2021](https://doi.org/10.1007/s10648-021-09595-9) / [Karpicke & Blunt 2011](https://doi.org/10.1126/science.1199327)
- [Pragmatic Programmer（tracer bullets）](https://pragprog.com/titles/tpp20/the-pragmatic-programmer-20th-anniversary-edition/) / [C2 wiki: WalkingSkeleton](https://wiki.c2.com/?WalkingSkeleton)

**业界产品（官方页）**
- 乐器：[Yousician](https://yousician.com/) / [Synthesia](https://synthesiagame.com/) / [flowkey](https://flowkey.com/) / [SmartMusic](https://www.smartmusic.com/) / [Modacity](https://modacity.co/) / [Functional Ear Trainer](https://www.functionaleartrainer.com/)
- 编程：[Exercism](https://exercism.org/) / [CodeCrafters](https://codecrafters.io/) / [build-your-own-x](https://github.com/codecrafters-io/build-your-own-x) / [JavaScript30](https://javascript30.com/) / [NeetCode](https://neetcode.io/) / [SICP](https://mitpress.mit.edu/9780262510875/structure-and-interpretation-of-computer-programs/)
- 语言：[Refold](https://refold.la/) / [Clozemaster](https://www.clozemaster.com/) / [Pimsleur](https://www.pimsleur.com/) / [iTalki](https://www.italki.com/)
- 通用：[Anki 手册](https://docs.ankiweb.net/scheduling.html) / [SuperMemo Incremental reading](https://help.supermemo.org/wiki/Incremental_reading)

> 诚实性声明：标注「转述」的条目未逐字核对原文；效应量凡未经本次摘要核实的均已标注口径或来源层级。Kulik 1990 的「自定步调降低完成率」与本系统完成门禁的张力、Ariely 2002 撤稿，是本次调研对既有计划的两条反向提醒。

## 9. 衔接与建议下一步（讨论用，非实施）

- 本笔记与 `2026-09-big-directions.md` 的关系：Arc A–E 回答「如何让现有范式吃到自己的数据」，本笔记的 F 弧回答「现有范式之外还有什么有证据的学习形态」。若做 wayfinder 绘图，F 弧各条应作为独立目的地候选，与 Arc A–E 平行挂载，经 §6 的组合矩阵避免重复立项。
- 若只做一轮讨论，建议聚焦三个决策（均为领域决策，非实施 ticket）：①「项目」是否成为一等节点类型（决定 F1/F2/F6 的存在空间，需 `/domain-modeling`）；②练习证据通道是否接受外部回执（F3，动 Missing/Broken 语义边界）；③习惯是否进入领域词汇表（F4，决定它与 mastery/streak 的边界）。
- F7（PS-I 顺序）与 F8（音频题型）不依赖上述决策，可作为低成本探针先验证内容管线与题型的弹性。
- 本笔记的证据边界已在 §7 汇总：除 Gollwitzer、间隔效应、远迁移否定、外部注意焦点等高置信结论外，项目域与习惯域的多数字段仍以「理论+相邻实证」为主，立项前应按证据强度表逐条复核时效。
