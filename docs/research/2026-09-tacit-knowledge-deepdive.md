# 深潜：陈述性检索调度在内隐/程序性域失效的机制细节，与「技能域可调度成分」清单（2026-09-08）

- 日期：2026-09-08
- 状态：深潜笔记（基于 `2026-09-tacit-project-learning.md` §2 的机制层深化；其 83 条已核实结论一律不重复，只作「综合笔记 §x」交叉引用）
- 核实渠道：OpenAlex / Crossref / PubMed E-utilities 元数据与摘要核对（检索日 2026-09-08；当日 WebSearch 与 Crossref 均多次限流，全部 DOI 经 OpenAlex 或 PubMed 补核）。凡标「转述」者为标题级核实、教科书常识或二手来源，未核对原文细节。
- 范围：只回答「为什么结构性失效的机制是什么」与「技能域里到底哪些成分可被调度」，不做产品扫描（综合笔记 §5 已做），不列功能建议（第 6 节机制清单除外）。

## 1. ACT-R 程序化的机制细节

1. **production compilation 的两步：composition + factualization**。Taatgen & Anderson 把技能获得建模为「把任务无关的过程性规则组合、特化为任务特定的产生式」（摘要原文：combining and specializing task-independent procedures into task-specific procedures），用空中交通管制模拟任务的模型展示从主任务级直到按键级的轨迹。两步的名称与细节（composition：顺序激发的两条产生式合并为一条，抹去中间的陈述性存储；factualization：把对陈述性事实检索的依赖替换为产生式内部的常量绑定）出自论文正文（正文细节转述，摘要级已核实）。出处：[Taatgen & Anderson 2003, Production Compilation, Human Factors 45(1)](https://doi.org/10.1518/hfes.45.1.61.27224)（被引 171）。
   → 含义：编译的原料是「执行任务时的陈述性脚手架 + 问题求解循环本身」。卡片流提供前者，不提供后者；编译计数器在题目作答流里根本不转动——这是比「检索不巩固技能」更精确的失效点。

2. **编译何时不够：需要强化学习成分的三种情形**。编译只优化「正在被执行的那条策略」，不能在竞争策略间做选择——策略选择由 ACT-R 的 utility learning（对产生式期望效用的 RL 更新）承担；子目标完成对父目标的效用回传（subgoal learning）同样需要 utility 传播；在无外部反馈的输入统计学习里（如过去式 U 型学习，无反馈即可由输入分布驱动），编译需与基于输入频率的强化机制配合。出处：[Taatgen & Anderson 2002, Why do children learn to say "Broke"?, Cognition 86(2)](https://doi.org/10.1016/s0010-0277(02)00176-2)；机制分工见 Taatgen & Anderson 2003 正文（转述）。
   → 含义：技能调度需要两类证据——「执行了」（喂编译）与「做对了/做错了」（喂效用）。现有 FSRS 语义两者都不采集； practice 回执通道（综合笔记 F3）若只记「做了」而丢「结果」，仍只能喂一半。

3. **练习曲线形态之争：幂律 vs 指数律，对「堆量」的直接含义**。Newell & Rosenbloom 1981 提出反应时随练习次数的幂律下降（RT = a + b·N^−β）；Heathcote, Brown & Mewhort 2000 用个体层数据论证：幂律多为「对个体数据平均」造成的假象，个体层面指数函数（RT = a + b·e^(−βN)）拟合更优——指数意味着**真实渐近线**，晚期练习的边际收益比幂律预测的更小。反方（聚合层幂律可由个体指数律涌现）见 [R. B. Anderson 2001, The power law as an emergent property, Memory & Cognition 29(7)](https://doi.org/10.3758/bf03195767)。出处：[Heathcote, Brown & Mewhort 2000, The power law repealed, Psychonomic Bulletin & Review 7(2)](https://doi.org/10.3758/bf03212979)（被引 758）；[Newell & Rosenbloom 1981, Mechanisms of skill acquisition and the law of practice, 载 Anderson (Ed.), Cognitive Skills and Their Acquisition；Routledge 重印章节](https://doi.org/10.4324/9780203728178-6)。
   → 含义：综合笔记 §2.2.1 的「量必要不充分」在曲线层面更冷：即便按乐观的幂律口径，第 N 次重复的收益也按 N^−(1−β) 衰减；按指数口径则存在硬平台。对技能域，「到量了就该换任务/加变式」比「继续堆同一成分的量」更符合曲线形状。

4. **程序性保持有自己的曲线，与陈述性遗忘不同源**。Anderson, Fincham & Douglass 用认知技能任务统一分析练习与保持：技能保持随保留间隔呈幂函数衰减，且练习量越大、衰减越缓——「练习」与「抗遗忘」由同一套机制解释，但这条曲线采样自任务执行史，不是检索史。出处：[Anderson, Fincham & Douglass 1999, Practice and retention: A unifying analysis, JEP:LMC 25(5)](https://doi.org/10.1037/0278-7393.25.5.1120)。
   → 含义：若未来为技能成分建「强度」模型，其自变量必须是执行事件（何时、多少、何种变式），而非作答事件；直接套 FSRS 的 R 衰减在数学形式上就错了对象。

5. **检索练习替代不了任务执行：不可通约性的三个来源**。①编译只在问题求解循环中发生（§1.1）；②迁移由「共享相同产生式」预测——Singley & Anderson 的文本编辑系列证明迁移量正比于任务间共享的产生式，而「知道怎么做的文字描述」与产生式的条件-行动结构不一一对应（同一描述可编译成多条不同产生式，熟练产生式也不再依赖描述）；③熟练者对自己产生式的口头报告系统性缺失（Polanyi，综合笔记 §1.2）。出处：[Singley & Anderson 1985, The transfer of text-editing skill, IJHCS 22(4)](https://doi.org/10.1016/s0020-7373(85)80047-x)；[Singley & Anderson 1989《The Transfer of Cognitive Skill》](https://www.hup.harvard.edu/books/9780674902022)（书，转述）。
   → 含义：为技能出「关于做法的题」，测的是描述的记忆，不是产生式存在性；两者相关（新手期）但随熟练度脱钩——「描述记牢了」不能作为「会做」的代理证据。

6. **解析-直觉两阶段的适用条件（Kahneman/Klein 共识版）**。Kahneman 与 Klein 逐条对表后「无分歧」：直觉即识别，其成立需要两个环境条件——高规律性环境（线索-结局关系稳定）+ 充分的带反馈练习机会使线索可被习得；低规律性环境（如股市）中「专家直觉」是错觉。出处：[Kahneman & Klein 2009, Conditions for intuitive expertise: A failure to disagree, American Psychologist 64(6)](https://doi.org/10.1037/a0016755)（被引 2432）。
   → 含义：调度器能为「识别型直觉」供给重复与间隔，但**环境有效性不是调度器的供给物**——对规律性差的域（开放式写作水平自评、随机性强的结果），任何卡都不能把人练出真直觉。

## 2. 显性-内隐接口之争

1. **Reber 范式与其测量脆弱性**。人工语法范式证明无意图学习可习得结构（[Reber 1967, JVLVB 6(6)](https://doi.org/10.1016/s0022-5371(67)80149-x)，被引 1980），且学习不受「有无学习意图」指令影响（[Reber 1976, JEP:HLM 2(1)](https://doi.org/10.1037/0278-7393.2.1.88)）；但 Shanks & St John 指出几乎所有「无意识学习」证据都过不了两条检验（信息性标准：测试线索是否包含被试可意识到的相关线索；敏感性标准：测试是否足够灵敏），内隐/外显的分离远比教科书叙述弱。出处：[Shanks & St John 1994, Characteristics of dissociable human learning systems, BBS 17(3)](https://doi.org/10.1017/s0140525x00035032)（被引 1183）。
   → 含义：「内隐学习存在」不是「内隐学习可被工程利用」——范式层面连「学到了什么」都可争议（下条），为内隐成分设计学习事件要按最保守口径（当作统计敏感性）处理。

2. **学到的是什么：抽象规则 vs 表面统计**。Perruchet & Pacton 综述主张：所谓内隐学习实为对片段/表面特征的统计学习，无需也不必假设无意识抽象规则（转述综述立场）。出处：[Perruchet & Pacton 2006, Implicit learning and statistical learning: one phenomenon, two approaches, TiCS 10(5)](https://doi.org/10.1016/j.tics.2006.03.006)（被引 605）。
   → 含义：纯浸泡式输入能高效安装「片段统计」（高频搭配、合法换乘倾向），但通用性差的规则控制仍需显性骨架——这正是弱接口立场的心理学根据，也解释了为何纯输入不服从调度（输入量由内容供给决定，综合笔记 §3.4）。

3. **N. C. Ellis 的动态弱接口（摘要级机制）**。显性与内隐知识「可分离但协作」：显性学习在工作记忆中完成构式的初始登记（pattern recognizers），随后由内隐学习在后续输入处理中调谐与整合；公式、槽-框构式、操练（drills）与显性语法规则都有贡献——它们支撑「有意识的造句」，其后续使用（usage）反过来推进内隐学习与程序化；有缺陷的输出引发聚焦反馈（recasts），为显性分析提供素材。出处：[N. C. Ellis 2005, At the interface, SSLA 27(2)](https://doi.org/10.1017/s027226310505014x)（被引 881；摘要核实）。
   → 含义：「规则题+间隔」在接口链条上覆盖的是**第一段**（登记 pattern recognizer）——有真实证据价值；但「调谐」由后续大量输入/输出完成，卡片流若不衔接真实使用，登记的识别器永远处于生涩状态。

4. **「可钻出直觉吗」的实证边界：DeKeyser 的能力×年龄双重调制**。57 名匈牙利移民的语法判断测试：极少数成人达到儿童移民的区间，且这几位全部具有高言语分析能力；分析能力对童年到港者无预测力。作者结论：若把关键期限说限定于内隐学习机制，则年龄效应**无例外**——成人的「习得」几乎全是显性机制代偿。出处：[DeKeyser 2000, The robustness of critical period effects, SSLA 22(4)](https://doi.org/10.1017/s0272263100004022)（被引 1432；摘要核实）。配套技能观（显性规则经练习自动化）见综合笔记 §3.3（DeKeyser 1997）。
   → 含义：「规则题+间隔」能覆盖到的上限由两个变量决定：规则的结构密度（可拆解程度）与学习者的分析能力。对高分析能力者，卡片+变式练习确可推进到接近直觉的受控流畅；对低分析能力/高模糊性规则（如语感型搭配），卡片只是登记，不是习得。

5. **收束：显性规则经大量变式练习自动化的适用条件**。①规则靶定的构式在后续输入/输出中高频复现（Ellis 的调谐条件）；②变式覆盖足够表面特征，防止练成碎片统计（Perruchet 教训）；③练习带即时反馈（编译+效用都需要误差信号）；④学习者分析能力与规则可分析性匹配（DeKeyser）；⑤练习后必须接真实输入/输出，把显性骨架交给内隐调谐（Ellis）。满足①-⑤时，「规则题+间隔」覆盖规则记忆→受控提取段；不满足时覆盖不到自动化段。此为综合笔记 §1 覆盖度表「程序性=部分」一行的机制级细化。

## 3. 运动技能机制补深

1. **CI 为何有效：三种解释，以及 2024 元分析的新裁决**。解释层：精细加工说（elaboration：随机练习迫使区分并精化各动作的表征）vs 动作计划重构说（reconstruction：组间遗忘迫使每次重建计划、加深处理；Lee & Magill 1983, J. Motor Behavior——元数据本次未核实，转述）vs 图式/动力系统取向（见下条）。裁决层：2024 年两篇注册式元分析给出迄今最诚实的数字——**保持** SMD=0.63 [0.33, 0.93]（54 研究 194 效应量；去离群后 0.43；异质性 I²≈90%）；**延迟迁移** SMD=0.55 [0.25, 0.86]（去离群 0.40）。关键调节：**实验室情境保持 SMD=0.92 vs 现场 0.23（不显著）**；迁移实验室 0.75 vs 现场 0.37（不显著，去离群 0.11）；**未成年人接近零（保持 0.02, ns）**。出处：[Czyż et al. 2024, High contextual interference improves retention in motor learning, Scientific Reports 14](https://doi.org/10.1038/s41598-024-65753-3)、[Czyż, Wójcik & Solarská 2024, CI effects on transfer, Frontiers in Psychology 15](https://doi.org/10.3389/fpsyg.2024.1377122)。
   → 含义：综合笔记 §2.1.1 的「块→随机」建议要再加一条机制警戒线：CI 收益主要在实验室任务上成立，真实运动场景接近零。随机化编排是**课程设计参数**，其收益不保证迁移到真实练习环境；且别给青少年/新手一刀切随机化。

2. **图式理论 vs 动力系统：谁解释保持/迁移更好**。van Rossum 对 Schmidt 图式理论的经验基础作系统清点：变式练习假说的支持实验远少于教科书叙述（转述综述结论）——「练多组变式建抽象图式」作为保持/迁移解释偏弱；约束/动力系统取向（综合笔记 §2.1.8 CLF 的理论根）对「为何随机/变式有利」给出的是环境诱导向搜索的解释，但同样缺大元分析（综合笔记已标）。出处：[van Rossum 1990, Schmidt's schema theory: the empirical base, Human Movement Science 9(3-5)](https://doi.org/10.1016/0167-9457(90)90010-b)（被引 121）。
   → 含义：技能域「何时给变式」没有可调度的记忆参数，只有需要按任务逐个校准的设计参数——这与第 6 节「变式编排不进调度语义」的结论同源。

3. **「ECCT」指称澄清与 challenge point framework**。本次检索未能在主流文献核实「ECCT」缩写（疑为 challenge point 框架的扩展式转手称谓）。可核实的原始框架：练习条件的效应由**功能任务难度 × 学习者技能**共同决定，最优练习点（challenge point）因人而异——同一随机化/间隔对不同水平学习者含义不同。出处：[Guadagnoli & Lee 2004, Challenge point: a framework..., Journal of Motor Behavior 36(2)](https://doi.org/10.3200/jmbr.36.2.212-224)。
   → 含义：运动域不存在「对所有人最优的练习计划模板」——计划必须是按水平的函数；这与综合笔记 F2 的「渐退模板」方向一致，但模板的输入要含水平估计。

4. **观测学习/视频示范的证据形态**。综述+应用模型（非元分析）：观察本身不自动带来习得收益，需按目的选观察类型（技能示范 vs 表现示范；good model vs learning model）。系统综述（18 项体育教育研究）：无法元分析（异质），最佳证据合成结论——**观察学习优于不观察：强证据**；专家示范 vs 自我示范：无差异（中等证据）；言语提示加不加：冲突证据。出处：[Ste-Marie et al. 2012, Observation interventions for motor skill learning and performance, International Review of Sport and Exercise Psychology 5(2)](https://doi.org/10.1080/1750984X.2012.665076)（被引 335）、[Han et al. 2022, Use of Observational Learning in Physical Education: A Systematic Review, IJERPH 19(16)](https://doi.org/10.3390/ijerph191610109)。
   → 含义：视频示范是「有效但无量级」的组件；「自选示范」与「提示语」是两个证据弱点——综合笔记 §5.2 把视频自评列为运动域可复制组件，机制上应配「观察目的」标注，而非裸放视频。

5. **注意焦点的机制解释：选可靠的三条生理/行为证据**。①探针反应时：外部焦点下次级反应时更快——控制更自动化（constrained action hypothesis 的原始证据；[Wulf, McNevin & Shea 2001, QJEP 54A](https://doi.org/10.1080/713756012)）；②EMG：二头肌弯举实验中外部焦点下积分肌电显著降低（两个实验复现；[Vance et al. 2004, Journal of Motor Behavior 36(4)](https://doi.org/10.3200/jmbr.36.4.450-459)，摘要核实）；③耗氧效率：外部焦点改善跑步经济性、想着自己动作则变差（[Schücker et al. 2009, JSS 27(14)](https://doi.org/10.1080/02640410903150467)；[Schücker et al. 2018, JSS 36(13)](https://doi.org/10.1080/02640414.2018.1522697)）。理论整合（动机+注意；autonomy/competence 提升期望）：[Wulf & Lewthwaite 2016, OPTIMAL theory, Psychonomic Bulletin & Review 23](https://doi.org/10.3758/s13423-015-0999-9)（被引 1223）。
   → 含义与诚实标注：机制共识是「外部焦点减少意识性干预、提升自动控制」，生理证据以 EMG/probe-RT/耗氧为主；**construal-level（高阶构念=外部焦点）读法与「cardiac（心迷走/心率）证据」本次未找到可靠一手锚点**，坊间流传的这两条建议按未证实处理（这也回应了「选可靠的」要求）。综合笔记 §2.1.3 的效应量（保持 g≈0.58）是干预效果层；本条是机制层，两者互洽。

6. **运动记忆的睡眠依赖巩固，与间隔调度的机制连接**。一夜睡眠带来 20% 的手指敲击速度提升而无准确率损失，提升量与夜末 stage-2 NREM 时长相关（[Walker et al. 2002, Practice with sleep makes perfect, Neuron 35(1)](https://doi.org/10.1016/s0896-6273(02)00746-8)，摘要核实）；细化模型：习得与稳定化（抗干扰）在清醒期即可完成，**增强型巩固（无再练的提升）依赖睡眠**且呈阶段特异性（[Walker 2005, BBS 28(1)](https://doi.org/10.1017/s0140525x05000026)，摘要核实；综述 [Walker & Stickgold 2004, Neuron 44(1)](https://doi.org/10.1016/j.neuron.2004.08.031)）；小睡证据：含纺锤波的小睡与运动巩固相关（[Nishida & Walker 2007, PLoS ONE 2(4)](https://doi.org/10.1371/journal.pone.0000341)，标题级核实，细节转述）、对知觉辨别任务「一个 60–90 分钟小睡≈一整夜」（[Mednick et al. 2003, Nature Neuroscience 6(7)](https://doi.org/10.1038/nn1078)）。
   → 含义：运动技能在**间隔期不是被动遗忘而是主动增强**——这从机制上把运动域与 FSRS 语义区分开：FSRS 建模「间隔→可提取性衰减」，运动序列学习的间隔期增益为正。「两次短练习夹一晚睡眠 > 一次长练习」有神经机制背书，是间隔思想在运动域的正确形式，但调度对象是「会话排布+睡眠」，不是「到期队列」。

7. **疲劳与「质量>时长」的文献形态**。经典综合（[Lee & Genovese 1988, RQES 59(4)](https://doi.org/10.1080/02701367.1988.10609373)；[1989 续篇：离散/连续任务效应不同，RQES 60(1)](https://doi.org/10.1080/02701367.1989.10607414)）：分布练习的「学习效应」与「表现效应」可分离，集中练习的劣势部分归因于疲劳（疲劳假说；转述）；急性疲劳对运动学习本身的现代系统综述/元分析**本次未检出一篇可靠综述**（诚实标注）。间接锚点：睡眠剥夺阻断巩固收益（Walker 系列）；单次会话内收益饱和而跨睡眠收益继续（§3.6 上文）。
   → 含义：「短会话、保睡眠、重会话质量」是机制上最稳的疲劳管理表述；「疲劳影响学习」的直接 dose-response 证据缺口应如实告知用户，而不是引用励志化口号。

## 4. 音乐练习策略文献

1. **进阶学生练习策略的实证**：[Hallam 2012, The development of practising strategies in young people, Psychology of Music 40(5)](https://doi.org/10.1177/0305735612443868)（被引 92）追踪青少年练习策略从机械重复向分节、纠错、目标设定等元认知策略的演变（内容转述：问卷/访谈类证据）；[McPherson & Renwick 2001, A Longitudinal Study of Self-regulation in Children's Musical Practice, Music Education Research 3(2)](https://doi.org/10.1080/14613800120089232)（被引 154）日记式纵向记录显示练习的结构化/自我监督质量（而非时长本身）预测进步（内容转述）。证据强度：相关/准实验为主，无随机分配。
   → 含义：与综合笔记 §2.2.1-2.2.2（刻意练习之争、表征对照）闭环：音乐文献自己的纵向数据同样落在「质量可测、可预测」一侧；「质量」的可操作化就是策略与自我监督，不是玄学。

2. **音乐域的 blocked→random**：[Mathias et al. 2024, How Does Increasing Contextual Interference in a Musical Practice Session Affect Acquisition and Retention, Journal of Research in Music Education](https://doi.org/10.1177/00224294231222801)（2024，被引 2；单研究，小样本，转述结论方向与运动域 CI 一致但量级未知）。音乐 CI 文献总体为少量单研究（以 Stambaugh 系列为代表的单簧管任务线；本次 Stambaugh 具体篇目元数据未核实，转述）。
   → 含义：音乐域「随机化编排」的证据比运动域还薄一个量级；把它当「有理论+相邻证据的实验性设计参数」，不是可靠结论。

3. **视奏（sight-reading）的构成与干预真相**：构成模型——[Kopiez & Lee 2006, Music Education Research 8(1)](https://doi.org/10.1080/14613800600570785) 与 [2008 一般模型](https://doi.org/10.1080/14613800701871363)用路径模型把视奏分解为快速乐谱信息摄取与执行成分（最强背景预测因子含伴奏/合奏经验等；具体因子系数转述）；干预元分析——[Mishra 2013, Improving sightreading accuracy: A meta-analysis, Psychology of Music 41(5)](https://doi.org/10.1177/0305735612463770)（92 项研究 124 个分析）：**总体处理效应仅 |d|≈0.18 [95% CI 0.11–0.24]**；唯一显著调节是处理类型（听感训练、受控读谱、创造性活动、视唱/柯尔文有效）；对照组自身前后测也提升 d≈0.48（成熟/练习效应）。
   → 含义：这是第 6 节清单里最重要的一条 sobering 证据：市面上「视奏训练法」的增量大多接近噪声；真能吃到收益的子成分是**听感分类与受控读谱**——恰好是可出题、可间隔的形式；「视奏」整体不是。

4. **背谱（deliberate memory）=把检索练习做到自动化**：音乐会钢琴家学巴赫《意大利协奏曲》第三乐章的全程实践记录：以乐曲形式结构为提取方案（retrieval scheme）、以演奏提示（performance cues）为提取线索，并「花费大量精力使从概念（陈述性）记忆中提取的速度与自动化程度不输于运动与听觉记忆」（摘要核实）。出处：[Chaffin & Imreh 2002, Practicing Perfection, Psychological Science 13(4)](https://doi.org/10.1111/j.0956-7976.2002.00462.x)；配套：[Williamon & Valentine 2002, The Role of Retrieval Structures in Memorizing Music, Cognitive Psychology 44(1)](https://doi.org/10.1006/cogp.2001.0759)（被引 66；提取结构层次，细节转述）。
   → 含义：背谱是「技能的陈述性子成分可调度」清单里证据最漂亮的一条：专家自己就把记忆练习做成了检索练习（结构层级+提示线索+反复提取）。乐段检索点天然是卡片语义的合法对象。

5. **Chase & Simon 组块与听觉域类比的证据状态**：棋类组块/模板理论为金标准（[Chase & Simon 1973, Perception in chess, Cognitive Psychology 4(1)](https://doi.org/10.1016/0010-0285(73)90004-2)，被引 2840；[Gobet & Simon 1996, Templates in chess memory, Cognitive Psychology 31(1)](https://doi.org/10.1006/cogp.1996.0011)；[Gobet et al. 2001, Chunking mechanisms in human learning, TiCS 5(6)](https://doi.org/10.1016/s1364-6613(00)01662-4)）；音乐读谱的实验综述存在（[Sloboda 1984, Experimental Studies of Music Reading, Music Perception 2(2)](https://doi.org/10.2307/40285292)），但**听觉域的组块直接演示远弱于棋类**（多为间接指标与专家-新手差异，转述）。
   → 含义：「练耳=听觉组块」的说法中，组块机制本身是棋类外推；练耳能进卡片的理由不必依赖组块类比——它作为**分类检索任务**直接成立（综合笔记 §2.2.3），组块只是锦上添花的解释。

## 5. 习惯机制深挖与范畴错配的形式化

1. **cue-driven vs reward-driven：形成与维持的两条链**。Wood & Neal 的习惯-目标接口模型：目标只是把「情境-反应」对写进记忆；此后反应由情境线索直接触发，不再经过目标评价（[Wood & Neal 2007, A new look at habits and the habit-goal interface, Psychological Review 114(4)](https://doi.org/10.1037/0033-295x.114.4.843)，被引 993）。实验判据是**结果贬值不敏感**：目标导向行为在结果贬值后下调，习惯不下调；神经证据：目标导向估值依赖内侧眶额/腹内侧前额叶（[Valentin, Dickinson & O'Doherty 2007, J. Neuroscience 27(15)](https://doi.org/10.1523/jneurosci.0564-07.2007)），习惯化中后背外侧纹状体特异参与（[Tricomi, Balleine & O'Doherty 2009, Eur. J. Neuroscience 29(11)](https://doi.org/10.1111/j.1460-9568.2009.06796.x)）；双分离在人类的经典演示：内侧颞叶遗忘症患者的概率分类（纹状体依赖）学习完好、外显回忆受损（[Knowlton, Mangels & Squire 1996, Science 273](https://doi.org/10.1126/science.273.5280.1399)，被引 1262）；**分心会把学习推向纹状体习惯系统**（[Foerde, Knowlton & Poldrack 2006, PNAS 103(31)](https://doi.org/10.1073/pnas.0602659103)，标题核实，细节转述）。综述：[Graybiel 2008, Annu. Rev. Neurosci. 31](https://doi.org/10.1146/annurev.neuro.29.051605.112851)。
   → 含义：习惯的「形成需要早期奖励信号、维持靠情境重复」两段结构说明：习惯域的巩固信号是**情境重复次数**，不是「间隔后的成功提取」——与综合笔记 §2.3.1 的「习惯是另一套机制」在神经层闭合。

2. **自动化测量工具：SRHI / SRHI 元分析 / SRBAI**。SRHI 12 条目、三面（重复史/自动性/自我认同）：[Verplanken & Orbell 2003, JASP 33(6)](https://doi.org/10.1111/j.1559-1816.2003.tb01951.x)（被引 1599）；Lally 2010（综合笔记 §2.3.2 的 66 天）拟合的是 SRHI 的**自动性子集**（具体条目选择转述）。应用元分析：习惯-行为加权相关 r+=0.44（固定）/0.46（随机；22 文献 23 个相关），且习惯调节意图-行为关系（[Gardner et al. 2011, Annals of Behavioral Medicine 42(2)](https://doi.org/10.1007/s12160-011-9282-0)，摘要核实）。SRBAI：仅取自动性面的 4 条目短版，适合事件级/频繁施测（引入文献 Gardner et al. 2012/2016；元数据本次未全核，标注）。
   → 含义：习惯域**有**自己的自动化度量表；若要给习惯进度建模，正确接口是 SRBAI 类自评曲线（渐近、以重复次数为自变量），不是把 R 当自动化度。

3. **习惯中断假说（habit discontinuity）**：情境稳定时习惯接管行为，情境剧变（搬家、换岗）打开「行为重审窗口」，此时干预效果放大——[Verplanken & Wood 2006, Interventions to Break and Create Consumer Habits, J. Public Policy & Marketing 25(1)](https://doi.org/10.1509/jppm.25.1.90)（被引 925）；后续整理为「习惯不连续性作为改变载体」[Verplanken 2018, 载 The Psychology of Habit](https://doi.org/10.1007/978-3-319-97529-0_11)。证据为准实验/自然实验（搬迁研究），效应量中庸且异质（转述），无大 RCT（标注）。
   → 含义：「破旧习惯」的正确时机不是用户意志最強时，而是**情境切换时**；这给出与 FSRS 完全不同源的时间变量（生活事件，非复习间隔）。

4. **破除坏习惯的证据状态**：①执行意图能压习惯，但**习惯越强效果越小**——戒烟现场实验：对弱/中等习惯有效，对强习惯无效（[Webb, Sheeran & Luszczynska 2009, BJSP 48(2)](https://doi.org/10.1348/014466608x370591)，摘要核实）；②抑制训练（go/no-go）元分析：19 研究，d+=0.378 [0.258, 0.498]，GNG 优于 stop-signal，客观即时测量最大——作者自注「可能仅短期」（[Allom, Mullan & Hagger 2016, Health Psychology Review 10(2)](https://doi.org/10.1080/17437199.2015.1051078)，摘要核实）；③总体图景见 [Gardner 2014, Health Psychology Review 9(2)](https://doi.org/10.1080/17437199.2013.876238)（被引 823；转述）。
   → 含义：坏习惯没有「删除」操作，只有「情境改变窗口（§5.3）+ 对弱习惯有效的 if-then + 短期抑制训练」三板斧；对强习惯任何组件都别承诺效果——期望管理模板照综合笔记 §2.3.2 的口径再加一层。

5. **习惯堆叠/锚点的证据层级**：第一层，执行意图本身（d=0.65，综合笔记 §2.3.3）——「after 现有线索, then 行动」正是堆叠的形式化，证据强；第二层，线索锚定重复的纵向演示（牙线研究：挂在既有刷牙线索上；[Judah, Gardner & Kenward 2012, BJHP 17(2)](https://doi.org/10.1111/j.2044-8287.2012.02086.x)，被引 152，细节转述）；第三层，从业者框架（Fogg Tiny Habits、Clear 惯例堆叠）——无独立 RCT（综合笔记 §2.3.6 已标，本笔记不重复）。
   → 含义：堆叠的证据合法性**继承自执行意图**；凡超出「现有稳定线索+单一具体行动」格式的堆叠（多行为链、模糊线索）掉出证据范围。

6. **范畴错配表：FSRS 三参数在习惯域逐项无定义**（FSRS 语义依 [Ye 2022, KDD '22](https://doi.org/10.1145/3534678.3539081) 与 [FSRS wiki](https://github.com/open-spaced-repetition/fsrs4anki/wiki/FSRS-explained)）：

| FSRS 参数 | 记忆域定义 | 习惯域候选对应物 | 裁定 |
|---|---|---|---|
| R 可提取概率 | 距上次复习 t、稳定度 S 的衰减函数；「复习测试」是离散事件 | 习惯没有提取测试事件；一次未发生≠「提取失败」，原因可能是线索缺失/动机/抑制失败 | **无定义** |
| S 稳定度 | R 衰减到 90% 所需天数，由复习历史更新 | 自动化度（SRBAI 曲线）以**重复次数与情境稳定性**为自变量渐近增长；中断不衰减（Lally 漏天无碍，综合笔记 §2.3.2） | **无定义**（自变量都不同：间隔 vs 次数） |
| D 难度 | 条目内在难度 1–10，由评分更新，预测稳定度增速 | 行为复杂度≠难度：复杂行为可高度自动化（开车），简单行为可极难维持（服药） | **无定义**（构念不同） |
| 复习事件语义 | 卡-答-评离散三元组 | 连续行为流，无逐次评分；测量靠量表/情境日志 | 需要新对象语义（综合笔记 F4 已立项方向） |
| 调度者 | 到期队列推送 | 用户的情境与日历（线索在环境里，不在队列里） | 需要新语义 |

## 6. 收束：技能域可调度成分清单

**能进现有 FSRS 语义的（调度器仍是主场）**：

| 成分 | 机制依据 | 证据强度 |
|---|---|---|
| part-task 自动化练习带间隔（音阶、指法对、和弦转换分解） | 4C/ID 第④组件（综合笔记 §4.1.2）+ 编译需要执行次数（§1.1） | 理论强，域内 RCT 弱-中 |
| 鉴别/分类判断（练耳、和弦/音程听辨、影像/心律图、棋型） | 概率分类任务正是陈述性-程序性边界范式（Knowlton 1996）；分类检索直接成立（综合笔记 §2.2.3） | 中-强（任务同构论证+单域实证） |
| 技能的陈述性子成分（乐理规则、战术定义、语法规则、API 用法） | 本系统主场（综合笔记 §1 表） | 强 |
| 背谱/乐段检索点（结构层级+提取线索+反复提取） | Chaffin & Imreh：专家自发把背谱做成检索练习（§4.4） | 中-强（强个案+中样本研究） |
| 听感/读谱统计训练作为视奏子成分 | Mishra 元分析中唯一存活的 moderator 是听感类训练（§4.3） | 中（元分析背书，量级小） |
| 心理演练+观察示范作为补充件 | Toth r=0.131（综合笔记 §2.1.6）+ Ste-Marie/Han 强证据但无量级（§3.4） | 小效应，中（预期管理） |

**不能进的（是设计/环境/设备参数，不是记忆参数）**：

| 对象 | 为什么不是记忆参数 | 证据强度 |
|---|---|---|
| 变式序列的编排（task class 排序+类内随机化） | CI 收益是情境敏感的实验室效应（§3.1），且最优挑战点依水平而定（§3.3）；它回答「课程怎么排」 | CI 元分析高；编排收益中 |
| 反馈渐退节奏（guidance hypothesis，综合笔记 §2.1.4） | 反馈频率是教学设计参数，作用于依赖性而非记忆强度 | 经典综述，高（方向） |
| 动作实时反馈 | 设备/传感问题（综合笔记 §5.7 的共识），与调度无关 | 产品事实 |
| 会话排布与睡眠的耦合（睡前练/次日验） | 巩固由生理完成，调度器只能建议时段，不能「到期」 | 睡眠巩固高；具体排程建议中 |
| 习惯形成与破除的调度 | §5.6 错配表：R/S/D 无定义；调度者=情境+日历 | 高（构念论证+神经证据） |
| 领域规律性差时「练直觉」 | Kahneman-Klein 环境有效性条件不满足时重复不产生真直觉（§1.6） | 理论+实证混合，中-高 |

一句话判据：**FSRS 能调度的是「带离散判据的区分性/检索性成分」；凡收益来自「任务如何排、反馈何时撤、环境如何设」的成分，都是课程设计参数——调度器在这些地方的正确姿势是当内容组织的消费者，不是当权威**。

## 7. 证据强度与争议汇总

| 主题 | 代表证据 | 关键数字 | 强度 | 争议/注意 |
|---|---|---|---|---|
| production compilation 两步 | Taatgen & Anderson 2003 | 建模轨迹拟合；无单一 ES | 中-高（计算建模+任务验证） | 编译细节来自论文正文（转述）；无独立大样本实验 |
| 编译 vs RL 分工 | Taatgen & Anderson 2002 | 过去式 U 型（无反馈） | 中 | 架构内论证；跨架构不可比 |
| 幂律 vs 指数律 | Heathcote 2000 vs RB Anderson 2001 | 指数优；聚合幂律为伪象 vs 涌现 | 高（方法论已裁决大半） | 结论：晚期边际收益比幂律口径更小 |
| 程序性保持曲线 | Anderson, Fincham & Douglass 1999 | 保留间隔幂函数；练习调制衰减 | 中-高 | 认知技能域；运动域外推需谨慎 |
| 直觉的适用条件 | Kahneman & Klein 2009 | — | 中-高（理论共识+实证混合） | 「高规律环境」的判定本身模糊 |
| 内隐学习测量 | Shanks & St John 1994 | — | 高（批判成立） | 分离证据普遍脆弱；不是「内隐不存在」 |
| 弱接口 | N. C. Ellis 2005 | — | 中-高（机制综述） | SLA 场景；其他内隐域外推有限 |
| 成人自动化上限 | DeKeyser 2000 | 57 人；仅高分析能力者达标 | 中-高（单研究+后续复制线） | 样本小；GJT 测量口径之争 |
| CI 保持/迁移 | Czyż 2024 ×2 | 保持 0.63/迁移 0.55；现场 0.23/0.37 ns；青少年 ns | 高（注册式元分析） | I²≈90%；「ECCT」缩写不可核；理论解释未裁决 |
| 观测学习 | Ste-Marie 2012; Han 2022 | 强证据优于不观察；无量级 | 中 | BES 非元分析；言语提示证据冲突 |
| 注意焦点机制 | Wulf/McNevin 2001; Vance 2004; Schücker 2009/2018 | iEMG↓；probe-RT↓；跑经济性↑ | 中-高（小样本生理机制） | construal/cardiac 说法无可靠锚点（本次未检出） |
| 睡眠依赖巩固 | Walker 2002/2005; Mednick 2003; Nishida 2007 | 一夜+20% 速度；增强相依赖睡眠 | 高（序列学习范式） | 睡眠阶段相关为相关证据；个体差异大 |
| 疲劳/分布 | Lee & Genovese 1988/1989 | 学习 vs 表现效应分离 | 中 | 急性疲劳对学习的直接元分析缺位 |
| 音乐练习策略 | Hallam 2012; McPherson & Renwick 2001 | 质量预测进步（相关） | 低-中（相关/日记法） | 无随机分配 |
| 音乐 CI | Mathias 2024 等 | 单研究 | 低-中 | 文献薄；量级未知 |
| 视奏构成与干预 | Kopiez & Lee 2006/2008; Mishra 2013 | 干预总体效应绝对值 d≈0.18；对照组自发提升 0.48 | 高（92 研究元分析） | 「视奏训练法」普遍被高估 |
| 背谱=检索练习 | Chaffin & Imreh 2002; Williamon 2002 | 强个案+分组研究 | 中-强 | 单人深度个案为主 |
| 组块的听觉类比 | Chase & Simon 1973; Gobet 1996/2001; Sloboda 1984 | 棋类金标准 | 听觉域低-中（间接） | 类比≠演示 |
| 习惯-接口模型/神经 | Wood & Neal 2007; Valentin 2007; Tricomi 2009; Knowlton 1996; Foerde 2006 | 贬值不敏感判据；双分离 | 高（实验+影像） | 人类样本的贬值研究规模小 |
| SRHI/SRBAI | Verplanken & Orbell 2003; Gardner 2011 | r+=0.44–0.46 | 高（工具+元分析） | 自评工具；SRBAI 引入文献元数据未全核 |
| 习惯中断 | Verplanken & Wood 2006; Verplanken 2018 | 准实验；效应中庸 | 低-中 | 无大 RCT |
| 破习惯 | Webb 2009; Allom 2016 | II 对强习惯无效；GNG d+=0.38（短期） | 中 | 短期效应；长期未证 |
| FSRS 语义 | Ye 2022 KDD | — | —（工程语义） | 错配为论证，非实证命题 |

## 8. 主要来源汇总

**ACT-R 与技能获得**
- [Taatgen & Anderson 2003, Production Compilation, Human Factors 45(1)](https://doi.org/10.1518/hfes.45.1.61.27224) / [Taatgen & Anderson 2002, Cognition 86(2)](https://doi.org/10.1016/s0010-0277(02)00176-2)
- [Newell & Rosenbloom 1981 章节重印](https://doi.org/10.4324/9780203728178-6) / [Heathcote, Brown & Mewhort 2000](https://doi.org/10.3758/bf03212979) / [R. B. Anderson 2001](https://doi.org/10.3758/bf03195767)
- [Anderson, Fincham & Douglass 1999](https://doi.org/10.1037/0278-7393.25.5.1120) / [Singley & Anderson 1985](https://doi.org/10.1016/s0020-7373(85)80047-x)（1989 专著，转述）
- [Kahneman & Klein 2009](https://doi.org/10.1037/a0016755)

**显性-内隐接口**
- [Reber 1967](https://doi.org/10.1016/s0022-5371(67)80149-x) / [Reber 1976](https://doi.org/10.1037/0278-7393.2.1.88) / [Shanks & St John 1994](https://doi.org/10.1017/s0140525x00035032) / [Perruchet & Pacton 2006](https://doi.org/10.1016/j.tics.2006.03.006)
- [N. C. Ellis 2005](https://doi.org/10.1017/s027226310505014x) / [DeKeyser 2000](https://doi.org/10.1017/s0272263100004022)

**运动机制**
- [Czyż et al. 2024, Sci Rep（保持）](https://doi.org/10.1038/s41598-024-65753-3) / [Czyż, Wójcik & Solarská 2024, Front Psychol（迁移）](https://doi.org/10.3389/fpsyg.2024.1377122) / [van Rossum 1990](https://doi.org/10.1016/0167-9457(90)90010-b) / [Guadagnoli & Lee 2004](https://doi.org/10.3200/jmbr.36.2.212-224)
- [Ste-Marie et al. 2012](https://doi.org/10.1080/1750984X.2012.665076) / [Han et al. 2022](https://doi.org/10.3390/ijerph191610109)
- [Wulf, McNevin & Shea 2001](https://doi.org/10.1080/713756012) / [Vance et al. 2004](https://doi.org/10.3200/jmbr.36.4.450-459) / [Schücker 2009](https://doi.org/10.1080/02640410903150467) / [Schücker 2018](https://doi.org/10.1080/02640414.2018.1522697) / [Wulf & Lewthwaite 2016](https://doi.org/10.3758/s13423-015-0999-9)
- [Walker et al. 2002](https://doi.org/10.1016/s0896-6273(02)00746-8) / [Walker 2005](https://doi.org/10.1017/s0140525x05000026) / [Walker & Stickgold 2004](https://doi.org/10.1016/j.neuron.2004.08.031) / [Nishida & Walker 2007](https://doi.org/10.1371/journal.pone.0000341) / [Mednick et al. 2003](https://doi.org/10.1038/nn1078)
- [Lee & Genovese 1988](https://doi.org/10.1080/02701367.1988.10609373) / [1989](https://doi.org/10.1080/02701367.1989.10607414)

**音乐**
- [Hallam 2012](https://doi.org/10.1177/0305735612443868) / [McPherson & Renwick 2001](https://doi.org/10.1080/14613800120089232) / [Mathias et al. 2024](https://doi.org/10.1177/00224294231222801)
- [Kopiez & Lee 2006](https://doi.org/10.1080/14613800600570785) / [2008](https://doi.org/10.1080/14613800701871363) / [Mishra 2013](https://doi.org/10.1177/0305735612463770)
- [Chaffin & Imreh 2002](https://doi.org/10.1111/j.0956-7976.2002.00462.x) / [Williamon & Valentine 2002](https://doi.org/10.1006/cogp.2001.0759)
- [Chase & Simon 1973](https://doi.org/10.1016/0010-0285(73)90004-2) / [Gobet & Simon 1996](https://doi.org/10.1006/cogp.1996.0011) / [Gobet et al. 2001](https://doi.org/10.1016/s1364-6613(00)01662-4) / [Sloboda 1984](https://doi.org/10.2307/40285292)

**习惯**
- [Wood & Neal 2007](https://doi.org/10.1037/0033-295x.114.4.843) / [Valentin et al. 2007](https://doi.org/10.1523/jneurosci.0564-07.2007) / [Tricomi et al. 2009](https://doi.org/10.1111/j.1460-9568.2009.06796.x) / [Knowlton et al. 1996](https://doi.org/10.1126/science.273.5280.1399) / [Foerde et al. 2006](https://doi.org/10.1073/pnas.0602659103) / [Graybiel 2008](https://doi.org/10.1146/annurev.neuro.29.051605.112851)
- [Verplanken & Orbell 2003（SRHI）](https://doi.org/10.1111/j.1559-1816.2003.tb01951.x) / [Gardner et al. 2011（SRHI 元分析）](https://doi.org/10.1007/s12160-011-9282-0) / [Judah et al. 2012](https://doi.org/10.1111/j.2044-8287.2012.02086.x)（SRBAI 引入文献元数据未全核，标注）
- [Verplanken & Wood 2006](https://doi.org/10.1509/jppm.25.1.90) / [Verplanken 2018](https://doi.org/10.1007/978-3-319-97529-0_11) / [Webb, Sheeran & Luszczynska 2009](https://doi.org/10.1348/014466608x370591) / [Allom, Mullan & Hagger 2016](https://doi.org/10.1080/17437199.2015.1051078) / [Gardner 2014](https://doi.org/10.1080/17437199.2013.876238)
- [Ye 2022, KDD（FSRS）](https://doi.org/10.1145/3534678.3539081) / [FSRS wiki](https://github.com/open-spaced-repetition/fsrs4anki/wiki/FSRS-explained)

> 诚实性声明：所有 DOI 经 OpenAlex/PubMed/Crossref 核对（含对记忆错误的三处纠正：SRHI 综述在 Ann Behav Med 2011 非 Appetite；Mishra 视奏元分析在 Psychology of Music 2013 非 Psychomusicology 2014；FSRS 论文为 KDD 2022 非 2023）。标注「转述」处为标题级核实或教科书常识；「ECCT」缩写、construal-level 焦点解释、cardiac 焦点证据、急性疲劳-运动学习元分析、SRBAI 引入文献均未能核实可靠一手锚点，已按未证实处理。与综合笔记的分工：本笔记全部为机制层与测量工具层，未重复其 §2 任何结论条目。
