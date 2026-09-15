# 调研：学习/知识图谱的边语义词汇表与边种扩展的代价边界

- 日期：2026-09-15
- 状态：基于一手来源的文献/业界调研（喂「复用现有两种边种」这一赌注的裁决；**不含实施决策，不替本仓拍板**）
- 关联笔记（同目录，口径一致）：`2026-09-vault-link-graph-prior.md`、`industry-scan.md`、`2026-09-big-directions.md`
- 术语口径：本仓边语义以 `CONTEXT.md` 为准——`pre`（硬前置，无权重，管门禁/ready）、`enc`（成分技能边，0–1 权重，必须落在该节点 `pre` 传递闭包内）；读侧派生但不落盘：`Jump`/`Float`/`Mastery`/终点锚/交汇节点。**本文出现的所有外部术语，均在每一节末尾显式映射回 `pre`/`enc`/边轻纪律/概念层/两级分组。**

## 0. TL;DR（只陈述证据分布，不下裁决）

1. **边种类收敛区间（Q1）在"教学依赖性"这条线上高度稳定**：从 KST 的 surmise/prerequisite 单一关系，到 Gagné 的 component-skill 层级、ALEKS 的 outer/inner fringe、Math Academy 的前置图，主流都用**一种有向依赖关系**承担「能不能学」。本仓的 `pre` 正对应这条线。
2. **但"成分/包含"这条线是被独立加密的**：Math Academy 明确把 `enc` 型关系（encompassing / component skill，带权重）做成与前置图**并列的第二张图**，且给出「被包含的往往是前置，但前置不一定都被包含」的约束——**与本仓 `enc ⊆ pre` 闭包约束同构**。这是本次调研对赌注**最有力的一手支持**（§2.5）。
3. **第三种边的存在性（Q2）证据是分裂的**：KT 领域一手论文同时说「关系有很多种（prerequisite/similarity/collaboration/remedial/hierarchy）」又说「实际只用两个最常用（prerequisite + similarity）」。收敛到两类是**工程主流**，但**"多于两类"是被同行评议论文反复列出的**，不是罕见异类。→ 见 §3 与 §9 的冲突。
4. **边属性（Q3）没有"必须外置"的普适结论**：W3C RDF 恰恰因为**不能**给边直接挂属性，才被迫发展出 reification（且被标准综述判为"代价较高"），RDF 1.2 才补上 triple terms；而 ConceptNet、Property Graph、Math Academy **都把边属性直接落存储**。→ "外置账本"是**可辩护的取舍**，不是行业默认，见 §4 与 §8。
5. **Q4（概念层叠加 vs 一等概念图）与 Q5（两级 vs 多级）未能取到"崩溃规模"的一手实证**。只有相邻证据（超节点/hub 遍历退化、精细加工论的多级细化），见 §5、§6，凡缺一手处已如实标注。

---

## 1. 取证方法与证据强度分级

**证据强度分级**（本文通篇使用）：

| 级别 | 定义 |
|---|---|
| **一手** | 论文原文 / 官方技术文档 / 标准规范（W3C、ISO 等）/ 官方工程博客 |
| **二手** | 同行评议综述、教材、百科全书、经翻译的官方书稿（引述一手但非原文） |
| **传闻** | 无出处可溯的业界说法、社区帖、产品宣传 |

**本仓边语义快照（对照基线）**：

- 存储层**刻意只有两种边**：`pre`（无权重、门禁）、`enc`（0–1 权重、服务于生成/审计/复习回退路由）。
- **边轻纪律**：图 YAML 禁止携带任何边属性；`origin/status/probation` 被解析器显式拒载（fail loud），边来源落提案 journal、复诊状态落 `state/边实验.jsonl`。
- **概念层是节点叠加**：`teaches/assumes/misconceptions` 是节点上的 map，不是一等概念图。
- **层级分组固定两级**：`Region/Block`；`CONTEXT.md` 自承「概念上希望深度可变，工程当前固定两级」。

---

## 2. Q1：成熟系统的边种类通常收敛到几类

### 2.1 知识空间理论（KST / Doignon–Falmagne）

- **一手**：Doignon, J.-P., & Falmagne, J.-C. (1985). *Spaces for the assessment of knowledge*. International Journal of Man-Machine Studies, 23(2), 175–196. DOI `10.1016/S0020-7373(85)80031-6`。KST 用**一种 surmise 关系**（推测/前提关系，偏序）刻画"掌握 A 才可能掌握 B"，知识状态=闭集族。
- **一手（专著）**：Doignon & Falmagne (1999). *Knowledge Spaces*. Springer. ISBN `978-3-540-64501-6`（后扩为 *Learning Spaces*, 2011）。
- **结论**：KST 的**词汇表只有一个依赖关系族**（surmise relation 及其派生：precedence、可辨识性），不设"第二种边"。
- **映射本仓**：这正是 `pre` 的理论根，且 KST 的"知识状态闭集"= `pre` 传递闭包的结构原型。

### 2.2 ALEKS 的 outer / inner fringe

- **一手（官方）**：ALEKS 官网自述基于 Knowledge Space Theory，"determine students' knowledge and prerequisite gaps"。`https://www.aleks.com/`
- **一手（论文）**：International Journal of Artificial Intelligence in Education (2022) 对 fringe 的定义——**outer fringe**（学生当前知识状态下**可学**的题集）、**inner fringe**（其知识状态的**边界**、可被移除的最外层）。`https://link.springer.com/article/10.1007/s40593-022-00309-y`
- **二手（官方书稿中译）**：Falmagne & Doignon《学习空间：跨学科的应用数学》（2016 简体中译）目录含"ALEKS 评估算法""推测关系"；另一份业界文档记载"ALEKS 实际学习空间通常约 400 个主题、超过 1 万亿知识状态"（`max.book118.com` 文档，**二手**，数字需以官方为准）。
- **结论**：ALEKS 的**边语义仍是单一依赖**，但引入**读侧派生**概念（可学集合/边界）——与本仓 `Jump`/`Float`/ready 是同一设计手法：**边少，语义在读侧派生**。
- **映射本仓**：`pre` 门禁 → ready 集，正是 outer fringe 的工程实现；本仓"读侧派生概念不落盘"与 ALEKS fringe 由知识状态**实时算出**同理。

### 2.3 Gagné 学习层级论与 "component skill" 的出处

- **一手**：Gagné, R. M. (1968). *Learning hierarchies*. Educational Psychologist, 6(1), 1–9（学习层级经**任务分析**得出，层级顶端技能的掌握依赖下位技能）。
- **一手**：Gagné, R. M. (1965). *The Conditions of Learning*. Holt, Rinehart and Winston（智力技能五亚类：辨别→具体概念→定义概念→规则→高级规则）。
- **一手（component skill 的早期表述）**：Gagné (1985)，转引自 Driscoll, M. P. (2000). *Psychology of Learning for Instruction*, p.351，原文英语："**a set of component skills that must be learned before the complex skill of which they are a part can be learned**."
- **结论**：**"component skill"（成分技能）这一术语的一手早期出处可归到 Gagné 学习层级论**；其边语义是**从属/组成**（subordinate/component），**不是** prerequisite 的那种"先后门禁"——尽管二者高度重叠。
- **映射本仓**：`enc` 定义的正是"complex skill 包含的 component skills"，Gagné 是其最贴切的术语来源；本仓把 `enc` 约束在 `pre` 闭包内，正是承认"组成关系"与"先后关系"高度重叠但需单向约束。

### 2.4 Merrill《首要教学原理》的成分技能

- **一手**：Merrill, M. D. (2002). *First Principles of Instruction*. ETR&D, 50(3), 43–59. DOI `10.1007/BF02505024`（中译本《首要教学原理》）。提出**五种成分技能（component skill）**：是什么/有什么/哪一类/如何做/发生了什么，成分技能是解决复杂问题所必需的知识与技能组合。
- **映射本仓**：`enc` 的"练习须真实调用该前置组件"语义，与 Merrill"成分技能是问题解决所必需"的定位一致。

### 2.5 Math Academy 的双图（**本次对赌注最有力的一手证据**）

- **一手（官方书稿）**：The Math Academy Way——第 4 章「核心技术：知识图谱」；第 13 章「精熟学习」。书中明确：知识图谱**记录两类关系**——**前置知识关系**（prerequisite，"箭头从简单的前置指向后继"）与**包含关系**（encompassing："高级数学问题会潜在地训练或'包含'很多较基础的技能"）。
- **一手（官方访谈稿，作者 Skycak 自述构建过程）**：`https://zhuanlan.zhihu.com/p/1916803246829314569`（译自官方 *How We Build the Knowledge Graph*）。关键原文（中文译文）：
  - "我们知识图谱中的所有信息——**数万个前置知识链接、解题时间估算，以及包含关系**（即，当更简单的主题作为**组成技能**出现在高级主题中时，这个更简单的主题应该获得多少'权重分值'），也都是由专业人士精心制作的。"
  - "**Alex 构建前置知识图**……**我构建包含关系图**。"
  - "每个前置知识都有一个**包含权重**，表示前置主题的多少部分平均被包含在解决后续主题问题中。"
  - **"被包含的主题往往是前置知识，但前置知识不一定都被包含。"**
- **结论**：
  1. Math Academy 的**存储层就是两张图**：前置图 + 包含图（带 0–1 权重性质的分值）。**与本仓 `pre` + `enc`（带权）两种边一一对应。**
  2. "被包含 ⊂ 前置"的约束，**与 `enc` 必须落在 `pre` 传递闭包内（`enc ⊆ pre`）完全同构**。
  3. 这直接说明：**"复用两种边种、只给第二种增加带权成员"在成熟系统里是有先例的、不是本仓独有的简化**。
- **映射本仓**：`pre`↔前置图，`enc`↔包含图/包含权重；本仓的 "enc 权重=invokes 覆盖率投影"（ADR-0037）与 Math Academy"前置主题多少部分被包含"的**权重语义同源**。

### 2.6 通用知识图的词汇表：ConceptNet / SKOS / 概念图

- **一手（AAAI 论文 + 官方 wiki）**：Speer, Chin & Havasi (2017). *ConceptNet 5.5: An Open Multilingual Graph of General Knowledge*. AAAI-17（arXiv:`1612.03975`）。关系 wiki：`https://github.com/commonsense/conceptnet5/wiki/Relations`。
  - ConceptNet **把关系收敛为一个封闭集合**（"closed set"），核心 **34 个关系**（5.7 版增删）。
  - 与学习最相关的两条：`/r/HasPrerequisite`（A 依赖 B 先发生）与 `/r/RelatedTo`（**最泛、对称**，"正向关系但无法表述是什么"）。
  - 每条**边**的 json 字段含 `weight`（可信度，正值）+ `sources`（谱系）+ `dataset` + `license`。→ 见 §4：**边属性落存储**。
- **一手（W3C 标准）**：SKOS Reference (2009). `https://www.w3.org/TR/skos-reference/`。语义关系：`skos:broader/narrower`（层级）+ `skos:related`（关联）+ 5 种映射（exact/close/broad/narrow/relatedMatch）。**词汇表收敛为"层级 + 关联"两族。**
- **一手（专著）**：Novak, J. D., & Gowin, D. B. (1984). *Learning How to Learn*. Cambridge University Press。概念图四要素：概念、命题、交叉连接、层级结构；**连接词（linking phrases）是开放词汇**（"引发/导致/需要/提供…"），命题=概念-连接线-概念。
- **结论**：通用知识图分两派——
  - **封闭词汇表派**（ConceptNet 34 关系、SKOS 两族）：边种类**有上限、可枚举**；
  - **开放连接词派**（Novak 概念图）：连接词**无上限、由作者自填**，本质是**边上的自由文本标签**（一种边属性）。
- **映射本仓**：本仓既不属于 ConceptNet 那种富词汇表，也不属于 Novak 的自由连接词；**只留 pre/enc 两种边，正是"封闭且极小"的一极**。Novak 的"连接词开放"提示：**若要表达 pre/enc 之外的语义，最轻的做法是把语义塞进边的 note（旁注）而非新增边种**。

### 2.7 知识追踪（KT）里的关系类型

- **一手（论文原文，摘要可核）**：arXiv:`2406.12896`（Leveraging Pedagogical Theories to Understand Student Learning Process）原文："**KCs have various types of relations, including prerequisite, similarity, collaboration, remedial, and hierarchy** [10]."，并称"we focus on the two most common relations, **prerequisite and similarity**"。
- **一手**：Structure-Based Knowledge Tracing (SKT, WWW 2020)——用**有向 prerequisite + 无向 similarity**两种关系，配 partial propagation（有向）与 synchronization propagation（无向）。
- **一手**：*Variance-stabilized cognitive diagnosis via GCN…*, Scientific Reports (2025), `https://www.nature.com/articles/s41598-025-29367-7`——prerequisite（有向，由连对行为推断）+ similarity（无向，双向共现视为相似）+ exercise-knowledge 覆盖关系。
- **映射本仓**：KT 的 **prerequisite≈`pre`**、**similarity（无向关联）≈ 一种"联想边"**。本仓当前**没有**对称联想边——`enc` 是**有向且带权**的成分边，不等价于 similarity。**这是"现有两边形不成"这一赌注的一个潜在缺口**（见 §3、§9）。

### 2.8 小结：收敛区间

- **依赖线**（能不能学）：几乎**恒定收敛为 1 种有向关系**（KST surmise / ALEKS / Gagné / Math Academy 前置图 / `pre`）。
- **成分线**（学到的东西由什么组成）：在**有"内容生成/复习路由"需求的系统里显式出现**（Gagné component skill / Merrill 成分技能 / Math Academy 包含图 / `enc`）。
- **联想线**（横向相似）：在 KT 与通用知识图里常见（similarity / RelatedTo / skos:related），**但在纯课程先修图里常被省略**。
- 因此"收敛到几类"最诚实的回答是：**依赖(1) + 成分(0–1) = 1–2 类**是课程图主流；**再叠加联想(1) = 2–3 类**是 KT/通用知识图主流。本仓选择了 2 类。

---

## 3. Q2：是否存在被反复论证的"第三种边"

**"第三种边"的具体候选**：transfer（迁移）、related（联想/相似）、alternative-path（替代路径）、misconception-link（迷思概念链）。

| 候选 | 一手证据 | 结论 |
|---|---|---|
| **similarity / related（联想）** | arXiv:`2406.12896` 列为五类之一，且与 prerequisite 并列为"**两个最常用**"；Nature s41598-025-29367-7 以无向边独立建 likeness 关系；SKOS `skos:related`、ConceptNet `RelatedTo` | **被反复论证、且被大规模使用**——不是罕见异类。这是最"硬"的第三种边。 |
| **transfer（迁移）** | Gagné 学习层级论本身就讨论"某一技能可**迁移**到多个更高级规则"（学习分类学条目，二手）；ACS Survey 2025《Prerequisite Relation Learning》把迁移与前置并列讨论（**二手**，见 §10） | 概念上存在，但作为**独立边种**落地的一手工程证据**未充分取到**。 |
| **alternative-path（替代路径）** | 未取到以"独立边种"形式建模替代路径的一手来源 | **未找到一手来源**（GN 中多以"同一前置集的不同子集"隐含表达，属 `pre` 的超图性质，而非新边种）。 |
| **misconception-link（迷思链）** | 未取到以此命名边种的一手来源；本仓自身把 misconceptions 建模为**节点上的 map**而非边 | **未找到一手来源**（迷思多以"节点属性/状态"而非"边"承载）。 |

**KT 一手论文明确列出的关系种类**（同一句）：prerequisite、similarity、collaboration、remedial、hierarchy —— **共 5 类**（arXiv:`2406.12896`）。

**工程侧收敛**：
- **二手**：Alibaba SkillGraph（2026）用 **3 类边**——前置依赖（prerequisite）、增强关系（enhance）、共现关系（co-occur），图持续进化（出处为中文技术号转述论文，**二手**）。
- **一手**：SKT / 多数 KT 模型**只用 2 类**（prerequisite + similarity）。

**结论（区分证据类型）**：
- **有实证**：prerequisite + similarity 是 KT 的工程主用两类（arXiv:`2406.12896`、SKT、Nature 2025）。
- **有实证（扩展）**：同行评议论文把关系种类**明确扩到 5 类**（prerequisite/similarity/collaboration/remedial/hierarchy）；工业图扩到 3 类。
- **设计推论**：把一切压进"prerequisite + association"两类**是主流简化**，但**并非唯一被接受的收敛点**——联想的地位（similarity）在文献里是"常驻第三边"。
- **映射本仓**：本仓的"两边形"里，`enc` **不是** similarity（它是**有向、带权、受闭包约束**的成分边）。**若未来需求池出现"对称联想/共现"语义，现有两种边无法表达**——赌注在此处有真实缺口（详见 §9）。

---

## 4. Q3：边属性落存储 vs 落派生

四条一手证据线，结论**互相矛盾**，正说明"外置账本"是可辩护取舍而非行业默认：

### 4.1 负面证据：RDF 不能给边挂属性 → 被迫 reification（代价被标准综述判为"较高"）

- **一手（标准）**：W3C *RDF 1.2 Concepts and Abstract Syntax*（Working Draft），`https://www.w3.org/TR/rdf12-concepts/`。RDF 数据模型是**三元组集合**，**顶点/边上没有内置属性**；给边加属性需用 **reification**（引入额外资源 `rdf:Statement` + `rdf:subject/predicate/object`）或命名的图。
- **一手（综述）**：软件学报《知识图谱数据管理研究综述》(2019)，`https://www.jos.org.cn/html/2019/7/5841.htm`："**RDF 图模型没有对于顶点和边上属性的内置支持**……边上属性的表示需要使用额外的机制，最常见的是利用'**具体化(reification)**'方法……**这种方式的代价比较高**。"
- **一手（标准演进）**：W3C *RDF 1.2 Semantics*（`https://www.w3.org/TR/rdf12-semantics/`）与 ISWC 2025 tutorial（`https://www.w3.org/Talks/2025/iswc-tutorial-rdfsparql-12/`）——RDF 1.2 新增 **triple terms + `rdf:reifies`/reifier**，"make statements about other statements"，正是为**降低给三元组加属性/谱系的代价**。
- **映射本仓**：本仓"图 YAML 零边字段、属性外置到 journal/账本"，**在结构上与 RDF 的 reification 是同一种保守取向**；RDF 社区花了十几年、推出 RDF 1.2 才缓解其代价——说明**外置本身有真实成本**（查询要拼、易不一致）。

### 4.2 正面证据：成熟系统把边属性直接落存储

- **一手**：ConceptNet 的**每条边**自带 `weight` + `sources` + `dataset`（见 §2.6）——**边属性落存储，不做外置**。
- **一手（工业图模型）**：**Property Graph / Labeled Property Graph（LPG）**（TinkerPop/Cypher 生态）允许**边直接携带键值属性**，无需 reification。
- **一手（官方书稿）**：Math Academy 的**包含权重直接维护在同一个知识图谱里**（§2.5），并直言其**代价**：首次编码包含关系时"每天约 8 小时、持续一个月"，估算口径为 `1500 主题 × 每主题 5 个前置 × 每条 2 分钟 = 250 小时`，且至今仍是**手工维护**（"正好在人力极限边缘"）。
- **映射本仓**：Math Academy 的代价**恰好印证了"边属性是有维护成本的"**——它选择"落存储 + 人工精心维护"，付出了**一个月全职**；本仓选择"落派生/外置账本"，省的是**维护与一致性风险**，代价是**查询需拼装**。

### 4.3 结论（三类区分）

- **有实证**：RDF 因无内建边属性而付出 reification 代价（W3C + 软件学报综述）。
- **有实证**：ConceptNet / LPG / Math Academy **都把边属性落存储**，且 Math Academy 明示其人工代价。
- **设计推论**：**"边属性必须外置到账本"没有普适的行业裁决**；外置（类 RDF）与外置代价、内建（类 LPG）与维护代价，是**两种都被大规模系统采用**的取舍。

---

## 5. Q4：概念层节点叠加 vs 一等概念图，各自在什么规模崩

**问题重述**：本仓 `teaches/assumes/misconceptions` 是**节点上的 map**（叠加/注解），不是把概念抽成一等节点。（对照：ConceptNet/SKOS 把概念抽成**一等资源**构成独立概念层。）

- **一手（标准）**：SKOS 把每个概念建模为**一等资源**（`skos:Concept`），并强制 `skos:inScheme` 绑定方案；层级用 `broader/narrower`（§2.6）。→ 一等概念图是**成熟且被标准化**的路线。
- **一手（相邻证据：超节点/hub 退化）**：
  - 图数据库反模式文档指出 **supernode（超级节点）** 会导致**遍历在特定顶点上性能退化**，需专门监测与建模规避（CSDN《图数据库性能、陷阱与反模式解析》，**二手**，转述图数据库通用经验）。
  - **一手（工程博客）**：Elastic Search Labs *Graph RAG & Elasticsearch*，`https://www.elastic.co/search-labs/blog/rag-graph-traversal`——真实 KG 呈"**少量 hub + 大量单邻居节点**"，最高频实体基数约 **24,700**，平均度 16.75；因此他们在查询期**强制每节点最多取 100 邻居**以免子图爆炸。
  - **一手（工程博客）**：Tencent Cloud《通过消除边来扩展知识图谱》——用"常用关键词连接节点"会创建高度连接块；最坏情况每节点同 5 个标签 → **5·n·(n−1) 条边**，**加载复杂度二次方增长**；改为存储入/出链而非物化边后降为 O(t·n)。
- **结论（诚实标注）**：
  - **一等概念图有权威标准做法**（SKOS），其**代价随概念层边数增长出现"hub/超节点"效应**（工程侧一手证据）。
  - **"节点叠加在哪一个具体规模崩"——未找到一手实证或权威论述**。可得的一手证据只能支撑定性结论：**把概念/标签做成边（一等概念图）会引入 hub 与二次方级边增长风险**；而"节点叠加"把它降为**节点属性**，避免了这一增长，代价是**无法对"概念本身"建交叉关系**。
  - **映射本仓**：`teaches/assumes` 作为**节点 map**≈"概念作为注解"，规避了概念层 hub 风险；**但若概念层需要概念↔概念的交叉推理（如概念先修），当前叠加模型表达不了**——这是叠加路线的**规模之外**的**表达力边界**。

---

## 6. Q5：层级分组固定两级是否通行上限

- **一手（理论）**：Reigeluth, C. M. (1999). *The Elaboration Theory*（精细加工论）。主张教学始于"**概要 epitome**"，再经**一系列细化等级（a series of levels of elaboration）**逐层加细节，并在宏观与微观间来回伸缩。→ **理论明确支持多层级、可变深度。**
- **一手（理论）**：Gagné 学习层级经**任务分析**得到**多级从属结构**（§2.3），深度由任务本身决定，不设两级上限。
- **二手**：中文教学设计文献把课程内容组织常见为**三层**（如"单元/小节/知识点"，或宏观/中观/微观）；部分学科 KG（如材料力学）实操到**四层**（课程层/知识层/知识点层/知识要素层）。这些是**从业惯例描述**，非一手实证。
- **结论（诚实标注）**：
  - **未取到"两级是通行工程上限"的一手来源**；相反，**教学理论一手来源主张深度可变、随内容细化**（Reigeluth、Gagné）。
  - 也没有取到"固定两级带来可量化损失"的一手实证。**该问题的一手证据不足，不宜据此断言"两级=行业上限"。**
  - **映射本仓**：`CONTEXT.md` 自承"概念上希望深度可变，工程当前固定两级"——**与一手理论（可变深度）不冲突，是刻意的工程简化**；风险不在"违反行业惯例"，而在**当内容需要第三层时，两级分组下会出现"塞不进/被压平"的结构应力**（属设计推论，无一手实证）。

---

## 7. 证据表（论断 | 来源 | 证据强度 | 对本仓的直接含义）

| # | 论断 | 来源 | 证据强度 | 对本仓的直接含义 |
|---|---|---|---|---|
| 1 | 课程图的依赖关系主流收敛为**单一有向 prerequisite** | Doignon & Falmagne 1985, DOI `10.1016/S0020-7373(85)80031-6` | 一手 | 支持 `pre` 单边种；其"知识状态闭集"= `pre` 传递闭包原型 |
| 2 | 可学集合由知识状态**实时派生**（outer/inner fringe），非另立边种 | Springer IJAIED 2022, `10.1007/s40593-022-00309-y`；ALEKS 官网 | 一手 | 支持"读侧派生概念不落盘"（`Jump`/`Float`/ready），与 ALEKS 同法 |
| 3 | "component skill"的一手早期出处为 Gagné 学习层级论 | Gagné 1985, in Driscoll 2000 p.351；Gagné 1968 *Learning hierarchies* | 一手 | `enc`（成分技能边）术语根正，语义=complex skill 的组成 |
| 4 | 成分技能是解决复杂问题所必需的知识技能组合 | Merrill 2002, DOI `10.1007/BF02505024` | 一手 | 支持 `enc`"练习须真实调用组件"的内容生成语义 |
| 5 | **成熟系统用两张并列图：前置图 + 包含（encompassing）图，含权重** | The Math Academy Way（书）+ 官方访谈 `zhuanlan.zhihu.com/p/1916803246829314569` | 一手 | **对赌注最强的支持**：`pre`↔前置图、`enc`↔包含图一一对应 |
| 6 | **"被包含 ⊂ 前置"的约束** | 同上（"被包含的往往是前置，但前置不一定都被包含"） | 一手 | **与 `enc ⊆ pre` 传递闭包约束同构** |
| 7 | ConceptNet 关系收敛为**封闭 34 关系**集合 | Speer et al. 2017, arXiv:`1612.03975`；官方 Relations wiki | 一手 | 支持"边词汇表可有上限、可枚举"；本仓取极小上限（2） |
| 8 | SKOS 收敛为"层级(broader/narrower)+关联(related)"两族 | W3C SKOS Reference 2009 | 一手 | 与本仓"依赖+成分"两族结构同型（不同领域） |
| 9 | 概念图的连接词是**开放词汇**（边上的自由文本） | Novak & Gowin 1984 | 一手 | 表达 pre/enc 之外的语义，最轻做法是**边 note** 而非新边种 |
| 10 | KT 主流只用 **prerequisite + similarity 两类** | arXiv:`2406.12896`；SKT WWW 2020 | 一手 | 支持"两类"是工程主流；**但 similarity 本仓无对应** |
| 11 | KT 论文**并列列出 5 类关系**（prerequisite/similarity/collaboration/remedial/hierarchy） | arXiv:`2406.12896` | 一手 | 反证：关系种类**可 > 2**，两类是简化而非唯一解 |
| 12 | similarity 用**无向边**独立建模 | Nature s41598-025-29367-7 | 一手 | 本仓 `enc` 是有向带权边，**不能代替对称联想边** |
| 13 | RDF **无内建边属性**，需 reification，且**代价较高** | W3C RDF 1.2 Concepts；软件学报 2019 综述 | 一手 | **边轻纪律/RDF 同取向**；外置是"保守且被标准承认有代价"的取舍 |
| 14 | RDF 1.2 新增 triple terms + `rdf:reifies` 以缓解边属性/谱系代价 | W3C RDF 1.2 Semantics；ISWC 2025 tutorial | 一手 | 说明"外置/重物化"的代价是**真实的**，社区花了十几年才缓解 |
| 15 | ConceptNet / LPG **边属性直接落存储** | ConceptNet 边 json（weight+sources）；Property Graph 模型 | 一手 | 反证：**"必须外置"不成立**，落存储是主流做法之一 |
| 16 | Math Academy 包含权重**手工落存储**，代价=约一个月全职（1500×5×2min≈250h） | 官方访谈稿 | 一手 | 边属性**有真实维护成本**；本仓外置省的是这份成本 |
| 17 | 一等概念图（SKOS）是**标准化且成熟**的路线 | W3C SKOS Reference 2009 | 一手 | 概念层叠加是**主动放弃**了一等概念图的表达力，非行业唯一解 |
| 18 | KG 呈"少量 hub + 大量单邻居"，高基数节点需限流防子图爆炸 | Elastic Search Labs *Graph RAG*（24,700 邻居上限 100） | 一手（工程博客） | 概念层若成边，需防 hub；节点叠加天然规避此风险 |
| 19 | 全连接式标签会致边数 **O(n²)** 增长，改存邻接可降复杂度 | Tencent Cloud《通过消除边来扩展知识图谱》 | 一手（工程博客） | "概念/标签成边"有**二次方级**增长风险 |
| 20 | 精细加工论主张**可变深度的多级细化** | Reigeluth 1999, *The Elaboration Theory* | 一手 | 反证"两级=上限"；两级是**工程简化**而非理论约束 |
| 21 | 课程内容层级业界常为 3 层（部分 4 层） | 中文教学设计文献/学科 KG（**二手**） | 二手 | 两级偏浅；无一手证据说两级会崩 |

---

## 8. 反证 / 反例：支持"少边种、边轻、属性外置本是正确取舍"的证据

> 本节**主动去证伪**"复用现有两种边种即可"的赌注，收拢**反对新边种、反对加边属性**的一面。以下每条都在说：本仓的保守取向**有据可依**。

1. **RDF 社区的教训（最硬的反证）**：W3C 标准的 RDF 模型**根本不支持边属性**，给边加属性要 reification，标准综述直言"**代价比较高**"（软件学报 2019）；直到 RDF 1.2 才引入 triple terms 缓解。→ **"边属性不落存储"是连 W3C 都长期采用的保守取向**，本仓边轻纪律并不激进。
2. **概念图连接词的教训**：Novak 概念图的**开放连接词**（自由文本）带来了表达力，也带来了**词汇不可控/不可推理**的代价。→ 本仓把语义限制在 pre/enc 两枚举，**牺牲表达力换取可审计**，方向自洽。
3. **hub/超节点教训**：把概念/标签**做成边**会引入 hub 与 **O(n²)** 边增长（Tencent Cloud、Elastic Graph RAG 一手博客）。→ **节点叠加（概念作为节点属性）天然规避这一增长**，即本仓"概念层是节点叠加"是**在规模上更稳**的一侧。
4. **KT 工程收敛教训**：即便论文列出 5 类关系，**实际模型只消费 2 类**（prerequisite + similarity）——多出来的 3 类（collaboration/remedial/hierarchy）在主流系统里**被压缩或忽略**。→ **"关系种类多"在论文里成立，"边种多"在工程里往往被裁到 2**，支持本仓"先只留两种边"的产品化取向。
5. **KST 单一关系教训**：知识空间理论用**一种 surmise 关系**撑起了 ALEKS 这一规模化自适应系统（400 主题/上万亿知识状态）。→ **单/双关系族可以支撑复杂自适应教学**，新边种并非必要条件。
6. **Math Academy 的维护代价**：其包含权重手工落存储，付出**约一个月全职 + 持续维护**（官方访谈）。→ 若本仓把边属性落存储，进入**同类长期维护负担**；外置账本把这份成本转成"查询期拼装"，是**可辩护的取舍**（但非免费，见 §4.1）。

**同时保留的反向信号（防止本节变成一边倒背书）**：
- similarity（对称联想）在 KT **是常驻第三边**（§2.7、§3）——本仓两种边**表达不了它**。
- RDF 1.2 **专门花力气去支持"给边加属性"**，说明"边属性外置"的代价**真实且有人愿意付出成本去消除**——本仓若长期外置，需接受**查询复杂度/一致性**的持续成本。

---

## 9. 未解决 / 冲突的证据

| # | 冲突点 | 冲突双方 | 现状 |
|---|---|---|---|
| C1 | **边种类该收敛到几类** | 一手：KT 论文列 **5 类**且明说"多种关系存在"（arXiv:`2406.12896`）⟷ 一手：同论文"实际只用**两个最常用**"（prerequisite+similarity） | **未裁决**。两类是**工程主流**，但**"多于两类"有同行评议支撑**，非异类。 |
| C2 | **边属性落存储 vs 落派生** | 一手：RDF **不能**挂边属性、reification 代价高（W3C+软件学报）⟷ 一手：ConceptNet/LPG/Math Academy **边属性直接落存储** | **未裁决**。两种都被大规模系统采用；结论取决于"查询复杂度 vs 维护成本"的具体权衡。 |
| C3 | **本仓两种边是否够用** | 支持：Math Academy 双图**与 pre/enc 同构**（§2.5）⟷ 缺口：KT/通用图里 **similarity/RelatedTo 是常驻第三语义**，`enc`（有向带权）**不等价于**对称联想 | **未裁决**。**若需求池出现"对称联想/共现"语义，现有两种边无法表达**——这是赌注的真实边界。 |
| C4 | **概念层叠加 vs 一等概念图** | 一手：SKOS 是成熟标准（一等概念图有据）⟷ 一手：一等图有 hub/O(n²) 风险（工程博客） | **"崩溃规模"无一手指实**。可得证据只支持**定性**：叠加更抗规模，但**放弃概念间交叉关系**。 |
| C5 | **"encompassing" 的最早一手出处** | 已确证 Math Academy 用 encompassing（一手书/访谈）；Gagné 用 component/subordinate skill（一手） | **未找到比 Math Academy 更早、且明确以 "encompassing" 命名该关系的** 一手来源。**如实标注：encompassing 的术语学最早出处未取到一手来源**；component skill 的一手早期出处可归 Gagné。 |
| C6 | **替代路径 / 迷思链接是否为独立边种** | — | **未找到一手来源**（二者多以 `pre` 超图性质或节点属性承载，未见以独立边种建模的权威一手）。 |
| C7 | **层级固定两级是否为通行上限** | 一手：Reigeluth/Gagné 主张**可变深度**⟷ 无一手证据说"两级是行业上限" | **未找到"两级=上限"的一手来源**；也没取到"两级带来可量化损失"的一手实证。定位：两级是**工程简化**，非行业铁律。 |

---

## 10. 主要出处

**认知科学 / 教学理论（一手）**
- Doignon & Falmagne (1985). *Spaces for the assessment of knowledge*. Int. J. Man-Machine Studies 23(2):175–196. DOI `10.1016/S0020-7373(85)80031-6`
- Doignon & Falmagne (1999). *Knowledge Spaces*. Springer. ISBN `978-3-540-64501-6`
- Gagné, R. M. (1965). *The Conditions of Learning*. Holt, Rinehart and Winston
- Gagné, R. M. (1968). *Learning hierarchies*. Educational Psychologist 6(1):1–9
- Gagné (1985), in Driscoll (2000). *Psychology of Learning for Instruction*, p.351（component skills 原句）
- Merrill, M. D. (2002). *First Principles of Instruction*. ETR&D 50(3):43–59. DOI `10.1007/BF02505024`
- Novak & Gowin (1984). *Learning How to Learn*. Cambridge University Press
- Reigeluth, C. M. (1999). *The Elaboration Theory*. （精细加工论）

**自适应系统 / 知识空间应用**
- ALEKS 官网：`https://www.aleks.com/`
- Springer IJAIED (2022), inner/outer fringe：`https://link.springer.com/article/10.1007/s40593-022-00309-y`
- Falmagne & Doignon《学习空间：跨学科的应用数学》(2016 简体中译)

**Math Academy（官方书/访谈，一手）**
- The Math Academy Way：第 4 章「核心技术：知识图谱」、第 13 章「精熟学习」（中译：`https://zhuanlan.zhihu.com/p/28954028250`、`http://www.bilibili.com/read/cv41838401/`）
- 官方访谈（构建知识图谱）：`https://zhuanlan.zhihu.com/p/1916803246829314569`

**通用知识图 / 标准（一手）**
- Speer, Chin & Havasi (2017). *ConceptNet 5.5*. AAAI-17. arXiv:`1612.03975`；Relations wiki：`https://github.com/commonsense/conceptnet5/wiki/Relations`
- W3C SKOS Reference (2009)：`https://www.w3.org/TR/skos-reference/`
- W3C RDF 1.2 Concepts：`https://www.w3.org/TR/rdf12-concepts/`；RDF 1.2 Semantics：`https://www.w3.org/TR/rdf12-semantics/`
- ISWC 2025 tutorial (RDF/SPARQL 1.2)：`https://www.w3.org/Talks/2025/iswc-tutorial-rdfsparql-12/`

**知识追踪（KT，一手）**
- arXiv:`2406.12896`（关系种类 5 类 / 主用 2 类）
- SKT, Structure-Based Knowledge Tracing (WWW 2020)
- Scientific Reports (2025)：`https://www.nature.com/articles/s41598-025-29367-7`

**图工程（一手博客 / 二手综述）**
- Elastic Search Labs, *Graph RAG & Elasticsearch*：`https://www.elastic.co/search-labs/blog/rag-graph-traversal`
- Tencent Cloud《通过消除边来扩展知识图谱》：`https://cloud.tencent.com/developer/article/2441249`
- 软件学报《知识图谱数据管理研究综述》(2019)：`https://www.jos.org.cn/html/2019/7/5841.htm`
- CSDN《图数据库性能、陷阱与反模式解析》（**二手**，超节点）

**二手综述（标注，供进一步取证）**
- ACS Computing Surveys 57(11) 2025, *Prerequisite Relation Learning: A Survey and Outlook*，DOI `10.1145/3733593`
- 中文教学设计文献「精细加工论/细化理论」（百科/课件，**二手**）
- Alibaba SkillGraph 3 类边（中文技术号转述，**二手/传闻**）

> 说明：本笔记严格区分「有实证」（第 7 节表内多数条）／「设计推论」（如 §5、§6、§8 中带"推论/风险"措辞者）／「业界传闻」（§3 Alibaba、§6 部分惯例描述）。凡标注"未找到一手来源"处（§3 替代路径/迷思链接、§5 崩溃规模、§9 C5/C6/C7），一律留空待补，未以推测填补。**结论不下裁决**——由后续 `/grill-with-docs` + `/domain-modeling` 定夺。

---

## 11. 补充调研：ripwire（`redhat-et/ripwire`）——「AI context 的 ripgrep」

- 日期：2026-09-15
- 状态：补充调研（喂同一个「复用现有两种边种」赌注的裁决；仍**不下裁决**）
- 一手来源：项目官方文档 `README.md` 与 `docs/ARCHITECTURE.md`（GitHub；`raw.githubusercontent.com` 两次超时，ARCHITECTURE 经 blob 页取得）。注意 `docs/LINEAGE.md`、`docs/EVALS.md`、`docs/METHODOLOGY.md`、`docs/COMMANDS.md` 本轮**只见引用、未读原文**——下列结论均不依赖它们。
- 定位：C++23 单二进制、零运行时依赖、离线；crawl → tree-sitter 抽符号 → 解析引用成边 → Personalized PageRank 排序 → 流式 minified XML。索引 **0.25 s / 6.6 MB**，其对照的图数据库 MCP server 为 **46.8 s / 391 MB**。

### 11.1 它给本仓边语义问题加的第三个选项（本节最重要）

ripwire 的图构建是**显式近似**的（其文档明说「假边是预期且可接受的，交付物是重要性排序而不是可靠的调用图」），而它对「解析不了」的处理给出了本仓缺失的第三条路——**既不武断、也不判死**：

> 「基础规则一条固定阶梯（同文件 → 同目录 → 唯一全局定义 → 否则丢边，**绝不发明幽灵节点**）。若一个名字在选定层解析出 k > 1 个候选，resolver **不挑一个：它发 k 条边、各带权重 1/k**……PageRank 容忍这个分摊，而且**它消掉了一次武断的 tiebreak**。」（ARCHITECTURE.md §1）

配套两条粒度纪律：

- **per edge, not per symbol**：符号级标注「这个函数有一些模糊调用」会把它**每条边**都标上，「那是对其中大多数边说谎」（README / ARCHITECTURE.md §1）。→ 不确定性必须**逐边**披露，不得上浮到节点级。
- **绝不发明幽灵节点**：阶梯第 4 级就是丢边，但丢是兜底；不得为满足不变式而捏造结构。

**映射本仓**：`orientLinkPair` 在两节点无 `pre` 关系时直接判死（`blocked_no_pre`，`src/engine/vault-links.ts`），这是**武断**——我们其实识别得出这对节点，只是定不出方向。ripwire 的对照答案是：承认这条关联、标注它未定向、逐条披露。**但这不推翻 E7（`enc ⊆ pre`）**——ripwire 的「不发明幽灵节点」正是 E7 要守的同一个直觉。于是分岔被压缩成一句话：**「闭包外关联」要么开豁免按此模式承接，要么承认它只能在概念层（`confusable`）活。**

### 11.2 教训 → 落点文件（LINEAGE 式台账）

> 本仓此前的调研笔记（含本文件 §1–§10）只记「论断 / 来源 / 证据强度」，**缺「教训住在哪个文件」这一列**。补上——这一列正是 ripwire `docs/LINEAGE.md`（49 仓 + 70 论文逐行点名）的做法。

| # | 教训 | 出处（一手：项目官方文档） | 对本仓的直接含义 | 落点文件 |
|---|---|---|---|---|
| 1 | 解析含糊时**不挑一个**：发 k 条边各带权重 1/k，「消掉一次武断的 tiebreak」 | ARCHITECTURE.md §1 | `orientLinkPair` 定向不了即判死（武断）；应改为承认关联 + 逐条标注 | `src/engine/vault-links.ts` |
| 2 | 兜底是丢边，但**绝不发明幽灵节点** | ARCHITECTURE.md §1 | E7（`enc ⊆ pre`）不推翻：可承认未定向关联，但不得靠捏造结构满足不变式 | `src/engine/seed.ts`（E7 校验）/ `src/engine/content.ts` |
| 3 | 披露粒度 **per edge, not per symbol**——符号级标注「是对其中大多数边说谎」 | README / ARCHITECTURE.md §1 | 不确定性必须逐边披露，不得浮到节点级 | `src/engine/analysis.ts`（edges 已带 `kind`/`w`） |
| 4 | **A zero is a measurement. Absent is not zero.**；**拒绝 ≠ 零**（给真实编辑距离的 did-you-mean） | ARCHITECTURE.md §4 | 印证既有 fail-loud（`node_card` 未知节点抛错 + 叫人回取逐字名单）；可提升为词条 | `src/engine/coach-tools.ts` |
| 5 | 计数单位**逐读数点名**：`--callers` 数对、`--uses` 数使用点，两个数两个名，**故意不同名** | ARCHITECTURE.md §4 | 多样性仪表「没有单一总分」再抬一档：每个读数点出自己的计数单位 | `src/engine/question-diversity.ts` |
| 6 | 「**看不见自己断言的门**比没有门更糟——因为它报告的是信心」（CI 里 degrade 门连续三个周期因被编译掉而假绿） | ARCHITECTURE.md §5 | 直接命中「提示词纪律机械不可判」：可判定子集做成真门，余下明说人审，**不用假门兜底** | `docs/agents/architecture.md` / `AGENTS.md` |
| 7 | 文档与权威不一致时**文档是 bug**：README 的计数从 LINEAGE 表再派生，不一致即红 | README（`test/readmedriftcheck.sh`、`test/docscommandscheck.sh`） | 门册（阈值/实测链的唯一登记处）可上漂移门 | `tests/README.md` / `scripts/` |
| 8 | `docs/LINEAGE.md`：**每行点名「取的教训 + 它住在哪个文件」** | README | 本笔记缺这一列——本 §11.2 即为补齐 | `docs/research/` |
| 9 | 图**不是对象图**：四类型 + 三平行数组，「系统里其他一切都只是对那些数组的不同遍历」 | ARCHITECTURE.md §2 | 本仓 `Graph` 已十余个平行 `*Of` map（每加一种节点属性加一个）；扩展性焦虑的另一半在这里 | `src/engine/graph.ts` |
| 10 | **改变了答案的缓存是 bug，不是 tradeoff**（热跑逐字节等于冷跑，上门断言） | ARCHITECTURE.md §2 | 印证已发现的不一致：`Graph.encOf` 丢 `note` 而 `declaredEncOf` 保住 | `src/engine/graph.ts`（`encOf` 派生处） |
| 11 | 排序用 Personalized PageRank；行上带 `cx`/`churn`/`amp`/`tested`，**全派生不落存储** | ARCHITECTURE.md §1–§2 | 本仓图无中心度/排序（`ready` 是布尔的）——「想象力功能」最直接的空白，且证明纯派生够用 | `src/engine/analysis.ts` |
| 12 | 不用图数据库也能赢：**0.25 s/6.6 MB vs 46.8 s/391 MB** | README | 支持「读侧派生优先于存储字段」，反对为联想语义新建存储 | 架构取向（无单一文件） |
| 13 | 固定阈值、**禁用 per-corpus 分位数**（「冷仓库不能造出热点」） | README | 约束将来的「关联强度/热点」读数不得用本课程分位数 | `src/engine/analysis.ts`（Health Score 已是固定 0–100 口径） |
| 14 | 独立证据族只报「几族同意」，**且先验证独立性**（任两族最大相关 +0.168，故同意=印证而非重复计数） | README / ARCHITECTURE.md §4 | 多样性仪表「三个读数」缺一道相关性检查 | `src/engine/question-diversity.ts` |
| 15 | 阴性结果**如实发布**（经评估无提升的特性藏进 env var、移除 `--help` 条目） | ARCHITECTURE.md §4 | 呼应本仓需求池 §6 反需求清单与 U-5「克制后置」 | `docs/design/2026-09-learning-expansion-requirements.md` |

### 11.3 与 §9 的关系

§9 的 **C3**（「本仓两种边是否够用」）在 §11.1 之后更精确：问题不再是有没有「第三种边」，而是**闭包不变式（`enc ⊆ pre`）要不要为「未定向关联」开豁免**——开，则 `orientLinkPair` 的判死可以改成「承接 + 逐边披露」；不开，则无向联想只能在概念层（`confusable`）活。**两个去向都不需要新增边种**，这也与 §2.5（Math Academy 双图）和 §8（反证节）一致。
