/**
 * 质量量规注册表（#221 / ADR-0062）：五类生成产物的质量判定标准——判定标准先于判定
 * 器，本表只定义量规，不建评审器（评审器归 #222，直接消费本表生成评审提示词与人审
 * 对表）。CONTEXT.md「质量量规」词条的落地件。
 *
 * - 来源 = 仓库自己的教育学操作化：CONTEXT.md 词条承诺（worked example 阶梯、检索点、
 *   PS-I、思维轨迹、误解坑位、前置档位、费曼/苏格拉底、4C/ID、渐退档、错误管理训练、
 *   非承诺措辞）+ 各站提示词契约 + ADR-0040/0056 资格判据。每条判据 = 判定标准 +
 *   证据要求（引原文定位）+ 出处（source）+ 锚点（anchor——门对 source 指向的文档
 *   核对原句在册，漂移即红，见 tests/quality-rubrics.test.ts）。
 * - 元数据写明分层法庭（词条「内容质量」）：AI 按量规评分 = 提议、人审 = 终审、
 *   学习者结果法院（复诊/N-of-1/申诉勘误）各守其领域；**无「总分」维度**——两轴
 *   正交（格式契约稳定/内容质量），量规只管内容质量轴，且维度间不作加权合成。
 * - 量规本身走人审：交付物经维护者过目才算数（#221 验收条款）。
 */

/** 分层法庭元数据（全部量规共用同一声明——判定分层是注册表级事实，不是量规级选项）。 */
export const RUBRIC_COURTS = {
  /** AI 评分面：提议，附证据引用，永不直接 canonical。 */
  ai: 'AI 按量规评分是提议：逐维度打分必须附证据引用（引原文定位），评分永不直接 canonical',
  /** 人审面：终审。 */
  human: '人审是终审：量规评分供人审对表逐条核对，采纳与否的裁决在人',
  /** 结果法院：各守其领域，不与评分混同。 */
  outcome: '学习者结果法院（复诊、N-of-1、申诉勘误）各守其领域——结果信号不回写评分，评分不冒充结果',
} as const

/** 一条判据。 */
export interface RubricCriterion {
  id: string
  /** 判定标准：这条维度下「好」长什么样（可被人审对表的判据，不是打分公式）。 */
  criterion: string
  /** 证据要求：评审必须引用什么原文作证据、定位到哪（引原文定位）。 */
  evidence: string
  /** 出处：判据的仓库内来源。格式 = `模板:<PROMPT_KINDS 键>` | `ADR-XXXX` | `词条:<词条名>` | `引擎:<engine 文件名>`。 */
  source: string
  /** 锚点：source 指向的文档里必须在册的原句片段（锚门核对用；缺席 = 不对账）。 */
  anchor?: string
}

export interface RubricDimension {
  id: string
  name: string
  criteria: RubricCriterion[]
}

export interface QualityRubric {
  /** 产物类型（五类：大纲/节正文/题目/教练回合/种子·终点）。 */
  id: '大纲' | '节正文' | '题目' | '教练回合' | '种子·终点'
  product: string
  /** 消费本量规的生成站（语料站名，对账 host STATIONS）。 */
  stations: string[]
  /** 分层法庭元数据（引用 RUBRIC_COURTS——单一出处）。 */
  court: typeof RUBRIC_COURTS
  dimensions: RubricDimension[]
  /** 量规级注记（预注册预测、判据边界等）。 */
  notes?: string[]
}

/** 五份量规。每条判据可追溯到出处（词条 / ADR / 模板原句锚）。 */
export const QUALITY_RUBRICS: readonly QualityRubric[] = [
  {
    id: '大纲',
    product: '课程大纲（节清单：划分/顺序/类型/tier/visual/points）',
    stations: ['课程大纲'],
    court: RUBRIC_COURTS,
    dimensions: [
      {
        id: '结构划分', name: '节的划分与结构',
        criteria: [
          {
            id: '单元性', criterion: '一节 = 一个可完成的学习单元（一个概念/一道例题/一次演示/一次动手练习/一个交互/一段思维轨迹）；标题描述本节具体内容，不用栏目化通名',
            evidence: '引节标题清单逐条对照「具体内容 vs 栏目通名」，点名列出通名节',
            source: '模板:课程大纲', anchor: '一节 = 一个可完成的学习单元',
          },
          {
            id: '规模锚定', criterion: '节数落在上下文包 §9 复杂度档案的目标节段数区间内，不注水拆长、不压扁塞满；拿不准偏向多一节',
            evidence: '引 §9 目标区间数字与实际节数对照；超区间须说明内容侧理由',
            source: '模板:课程大纲', anchor: '拿不准时偏向多一节',
          },
          {
            id: '递进', criterion: '相邻节之间有学习上的递进关系（后节在前节台阶上抬高，不是并列罗列）',
            evidence: '引相邻节标题对并说明递进方向；说不清递进的相邻对点名',
            source: '模板:课程大纲', anchor: '相邻节之间要有学习上的递进关系',
          },
          {
            id: '配比自然', criterion: '节类型配比按内容选组合模式（集中练/穿插/全概念无练习节），不机械地一节内容跟一节练习',
            evidence: '引节类型序列说明所选组合模式；机械交替的序列点名',
            source: '模板:课程大纲', anchor: '不要机械地一节内容跟一节练习',
          },
        ],
      },
      {
        id: '教学法', name: '教学法兑现（大纲面）',
        criteria: [
          {
            id: '难度档弧线', criterion: 'tier 难度档开头的节偏易、收尾的节偏难，与节点难度相称；tier 是出题难度与样例密度的锚',
            evidence: '引 tier 序列与节点难度对照，指出逆弧线的节',
            source: '模板:课程大纲', anchor: '开头的节偏易、收尾的节偏难',
          },
          {
            id: '高难硬性', criterion: '高难节点的 §10（先做后教）与 §11（专家思维轨迹）是硬性要求：挑战节以「挑战：」开头先行、恰一节「思维：」节放在讲解后收尾前',
            evidence: '引上下文包 §10/§11 指令与大纲对照；高难节点缺挑战节/思维节即违规',
            source: '模板:课程大纲', anchor: '§10（先做后教）与 §11（专家思维轨迹）出现时是硬性要求',
          },
          {
            id: '先验尊重', criterion: '附「学习者已有理解（Vault 先验）」段时，划分与措辞尊重已有理解——已会内容不重复铺陈、记法沿用笔记写法',
            evidence: '引先验段条目与节清单对照，点名重复铺陈已会内容的节',
            source: '模板:课程大纲', anchor: '划分与措辞尊重学习者已有的理解与记法',
          },
        ],
      },
      {
        id: '下游可用性', name: '下游消费面质量',
        criteria: [
          {
            id: 'visual 诚实', criterion: '几乎每节声明讲解主体可视化（visual 字段），确无才写「无」；可视化类型与节内容匹配',
            evidence: '引 visual 序列；连续多节「无」或类型与内容不符（如演示节标「公式」）点名',
            source: '模板:课程大纲', anchor: '本节的讲解主体可视化',
          },
          {
            id: 'points 可执行', criterion: 'points 是一句话要点，具体到能供逐节生成衔接与前节结尾窗口消费',
            evidence: '引 points 抽查；空泛到无法指导衔接（如「讲解重点」）点名',
            source: '模板:课程大纲', anchor: 'points: 本节要点（一句话）',
          },
        ],
      },
    ],
  },
  {
    id: '节正文',
    product: '课程节正文（默认/苏格拉底/费曼三风格变体共享同一量规）',
    stations: ['课程节生成'],
    court: RUBRIC_COURTS,
    dimensions: [
      {
        id: '教学法兑现', name: '教育学操作化承诺兑现',
        criteria: [
          {
            id: '样例阶梯', criterion: '节段难度档兑现 worked example 阶梯：低档每个新要点紧跟完整样例；中档先留尝试空隙再给样例；高档样例只给关键步骨架（细节留白）',
            evidence: '引节段难度档与正文样例形态对照，逐样例标注档位应然与实然',
            source: '模板:课程节生成', anchor: '每个新要点紧跟一个完整样例',
          },
          {
            id: '检索点', criterion: '检索点 = 读流内嵌的一问一揭晓（先让学习者作答/尝试再揭晓），不设判分、不进练习区、不写「练习」栏目；密度按档位 0–1/1–2/2–3 处',
            evidence: '引检索点原句并标注档位应然密度；把检索点写成练习题的点名',
            source: '模板:课程节生成', anchor: '先让学习者凭记忆作答或动手尝试',
          },
          {
            id: '误解坑位', criterion: '登记在册的误解先验讲到对应概念处预埋为 blockquote 误区块：先呈现错法、再当场点破错在哪与什么信号暴露它；坑位就地辨析不展开成新主题',
            evidence: '引误解先验条目与误区块对照；漏埋、展开成新主题、或美化错法的点名',
            source: '模板:课程节生成', anchor: '把列出的典型错误预埋为坑位警示',
          },
          {
            id: '前置档位', criterion: '按「前置概念档位」把握能默认学习者会什么（知道=再认/会用=调用/能教=默认起点），前置不重教',
            evidence: '引档位段与正文对照；对「能教」前置作完整重教的段落点名',
            source: '模板:课程节生成', anchor: '前置不重教',
          },
          {
            id: '图文互引', criterion: '文字与图互引：文字提及图、图内标注与正文术语一致（双重编码组合原则，防图文两张皮）',
            evidence: '引正文提图句与图内标注对照；图存在但正文零提及的点名',
            source: '模板:课程节生成', anchor: '文字与图互引——文字提及图、图内标注与正文术语一致',
          },
          {
            id: '先做后教', criterion: '高难节点挑战节先行：挑战节只给题面与尝试引导不给解答；讲解收尾完整解答并回扣学习者第一节的尝试与缺口（PS-I）',
            evidence: '引挑战节与讲解收尾对照；解答未回扣尝试缺口的点名',
            source: '引擎:content.ts', anchor: '## 10. 先做后教',
          },
          {
            id: '思维轨迹', criterion: '思维节写专家第一人称意识流（尝试/犹豫/自我盘问/监控调整），必须故意踩一次典型错误岔路并当场元评论点破；关键转折处设预测门',
            evidence: '引思维节原句：意识流段落、坑位与元评论、预测门块各至少一处定位',
            source: '引擎:content.ts', anchor: '## 11. 专家思维轨迹',
          },
        ],
      },
      {
        id: '风格变体', name: '风格变体承诺兑现（按变体判）',
        criteria: [
          {
            id: '苏格拉底式', criterion: '苏格拉底变体：以引导问题推进（观察/反例式好问题+一小步逼近），问题后紧跟锚点提示；结论只在问题链走完后给出',
            evidence: '引问题链与锚点定位；问题链未走完先给结论的点名',
            source: '模板:课程节生成-苏格拉底', anchor: '结论只在问题链走完后给出',
          },
          {
            id: '费曼式', criterion: '费曼变体：每个核心概念按「生活类比（明确说类比在哪里失效）→ 朴素语言 → 正式记号」推进；节末收「讲给别人听」自测问题',
            evidence: '引类比段与失效声明、记号引入点、收尾自测问题各一处定位',
            source: '模板:课程节生成-费曼', anchor: '假设学习者要把这节课讲给一个聪明的十二岁孩子听',
          },
        ],
      },
      {
        id: '衔接与边界', name: '节间衔接与领域边界',
        criteria: [
          {
            id: '节间衔接', criterion: '与「前节结尾」自然衔接：不重复它讲过的内容，开头不复述前节结论（#227 注入面的显式判据——节间衔接断裂是流程性缺陷，不是个别文风问题）',
            evidence: '引前节结尾窗口与本节开头对照；复制/复述前节内容的段落点名',
            source: '模板:课程节生成', anchor: '仅供衔接参考，不复述',
          },
          {
            id: '领域边界', criterion: '只讲本节点范围：禁用概念不出现也不引用其结论；后继内容至多自然收尾处一句带过',
            evidence: '引禁用概念清单与正文检索对照；提前教/展开后继的段落点名',
            source: '模板:课程节生成', anchor: '「禁止使用的概念」一节列出的名称不得出现',
          },
        ],
      },
      {
        id: '结构排版', name: '结构与排版纪律',
        criteria: [
          {
            id: '篇幅预算', criterion: '一节 = 学习页 1–2 屏：文字不超 §9 预算（1.3 倍警告、2 倍拒收）；可视化块合计 ≤2；节内无 ### 子标题',
            evidence: '引去公式去图后的纯文字数与预算对照、可视化块计数',
            source: '模板:课程节生成', anchor: '超预算 1.3 倍警告、2 倍拒收',
          },
          {
            id: '排版约定', criterion: '并列误区/注意/要点块用 blockquote（首行加粗标签）；关键结论用独立公式（$$…$$）；mermaid 节点文本特殊字符整体双引号',
            evidence: '引违规块定位（渲染降级风险的块点名）',
            source: '模板:课程节生成', anchor: '必须整体双引号包裹',
          },
        ],
      },
    ],
    notes: [
      '「与相邻节衔接」是显式判据（#221 增补）：#227 判定节间衔接断裂是流程性缺陷——量规若只看单节文风，会把系统性问题误读为个别文风问题。',
    ],
  },
  {
    id: '题目',
    product: '练习题（课程题库 + 笔记出题）',
    stations: ['题目生成', '笔记出题'],
    court: RUBRIC_COURTS,
    dimensions: [
      {
        id: '答案键正确性', name: '答案键正确性（确定性可验证属性）',
        criteria: [
          {
            id: '键自洽', criterion: '把每道题当作考生独立重解一遍，独立解与答案键一致：多选逐项判真假（杜绝凑不满「至少 2 个正确项」硬凑错项）、答案唯一的题无第二个可辩护正确项、数值题带合理 tol',
            evidence: '引独立解题过程与答案键对照；对账不一致的题给题面定位（生成期第二意见门 #223 同判据）',
            source: '模板:题目生成', anchor: '当作考生独立重解一遍',
          },
          {
            id: '解析支撑键', criterion: '解析与答案键一致且每句结论都支撑答案键；按固定三段写（为什么对 → 关键步骤 → 最易错点），≤4 句',
            evidence: '引解析逐句对照答案键；自相矛盾句与超长解析点名',
            source: '模板:题目生成', anchor: '最易错点',
          },
        ],
      },
      {
        id: '多样性', name: '题型多样与不趋同',
        criteria: [
          {
            id: '题型多样', criterion: '题型按内容自然混搭、只用九种、不全出同一题型（开放题每轮至多 1 道；笔记源按收敛子集）',
            evidence: '引本批题型分布；全同题型或超限开放题点名',
            source: '模板:题目生成', anchor: '题型必须多样，只用以下九种',
          },
          {
            id: '不趋同', criterion: '与题库已有题不同考点或不同角度——同考点同问法仅换数字/措辞的重出即趋同；本批内部互查同款',
            evidence: '引新题面与最近相似已有题对照，说明考点/角度差异；说不出差异的判趋同',
            source: '模板:题目生成', anchor: '仅换数字/措辞',
          },
          {
            id: '难度递进', criterion: '难度按系统注入的「难度锚定」递进（缺省 1-2-3 弧线）；低复杂度节点不出 difficulty 3',
            evidence: '引难度锚定注入与题目 difficulty 分布对照',
            source: '模板:题目生成', anchor: '难度按系统附的「难度锚定」走',
          },
        ],
      },
      {
        id: '覆盖与立场', name: '覆盖边界与出题立场',
        criteria: [
          {
            id: '只考讲过的', criterion: '只考正文里讲过的内容：不引入正文没有的概念、记号或结论（笔记源：只考笔记写过的内容，不替学习者扩展）',
            evidence: '引超纲题面与正文检索对照；引笔记原文范围对照',
            source: '模板:题目生成', anchor: '只考正文里讲过的内容',
          },
          {
            id: 'invokes 恰一枚', criterion: '每题标注恰一枚 invokes：最主要考察的概念、登记表在册、名字精确照抄；清单缺席时缺席合法',
            evidence: '引 invokes 与概念登记表对照；多枚/空缺/清单外名字点名',
            source: '模板:题目生成', anchor: '恰一枚',
          },
          {
            id: '干扰项质量', criterion: '选择题干扰项 = 正确式 + 典型错误做法（优先改编误解先验），句式相近不靠措辞详略泄露答案',
            evidence: '引干扰项与其对应的典型错误对照；明显凑数项/泄答案项点名',
            source: '模板:题目生成', anchor: '典型错误模型改编成选项',
          },
        ],
      },
    ],
    notes: [
      '预注册预测（2026-09-13 #225 报告 §9）：「不趋同」维度将最先爆出低分——多样性全仓零测量 + 格式约束锐化压力（arXiv:2607.18476）。兑现度是调查结论的自检；多样性证据底座由 #230（多样性仪表与基线测量）供给。',
      '「键自洽」是确定性可验证属性检查（独立解题 + evaluateAllo 对账），不消费本量规的评审器——生成期由 #223 第二意见门执行，本判据供人审与离线评审对表。',
    ],
  },
  {
    id: '教练回合',
    product: '教练生长批（裁决 + note 区 + route 重写 + ops 操作）',
    stations: ['教练生长'],
    court: RUBRIC_COURTS,
    dimensions: [
      {
        id: '生长纪律', name: '生长纪律（ADR-0040 生成时质量）',
        criteria: [
          {
            id: '认知粒度', criterion: '每个新节点是独立学习行为单元：零基础学习者能在 30 分钟内从它的 pre 直接学会；est 按此诚实申报',
            evidence: '引新节点名/pre/est 与 30 分钟自问对照；明显多步复合的节点点名',
            source: '模板:教练回合', anchor: '30 分钟',
          },
          {
            id: '动作句命名', criterion: '节点名大多是动作句（解/求/证/推导/比较/判定）；「理解 X」「学习 X」与「XX 基础语法」类复合泛称禁用；螺旋式重现名称可区分',
            evidence: '引新节点名清单；层级不清近似名与复合泛称点名',
            source: '模板:教练回合', anchor: '动作句',
          },
          {
            id: '依赖充分性', criterion: '新节点的 pre 是完整的直接前置集合——不懂 pre 里任何一条都会卡住；不塞间接前置（传递依赖交给图）；真实依赖优先于难度曲线',
            evidence: '引每条新 pre 边与「缺了会卡在哪」对照；塞间接前置/漏关键前置点名',
            source: '模板:教练回合', anchor: '完整的直接前置集合',
          },
          {
            id: '边级自查', criterion: '本批每条新 pre 边给一句 verdict：删掉这条边学习会在哪一步失控——答不出具体失控点 = 冗余不写',
            evidence: '引边 verdict 原句；无 verdict 或失控点不可定位的边点名',
            source: '模板:教练回合', anchor: '边级自查',
          },
        ],
      },
      {
        id: '算子语义', name: '算子与结构语义',
        criteria: [
          {
            id: '接线义务', criterion: '前进/换向批含 add_node 时必须携带 set_pre 接线终点（整体替换语义）；收尾走零 add_node 的纯 set_pre 接线批（收尾即宣告承诺兑现）；终点不出现在 add_node 的 pre 里',
            evidence: '引批 ops 与终点 pre 现势对照；缺接线/终点当 pre 的批点名',
            source: '模板:教练回合', anchor: '主线批必接线',
          },
          {
            id: '插入预注册', criterion: '插入批 note.recheck 必填：metric 恰一枚可机判（与症状同源）、days 缺省 10 学习日；非插入批不得携带 recheck',
            evidence: '引插入批 recheck 与症状对照；metric 与症状不同源/越界 days 点名',
            source: '模板:教练回合', anchor: 'note.recheck 必填',
          },
          {
            id: '巩固只引已教', criterion: '巩固节点的 teaches/assumes/误解只引图面在册已教概念；旁支/巩固不走复诊',
            evidence: '引巩固批概念引用与图面 teaches 并集对照',
            source: '模板:教练回合', anchor: '只引已教概念',
          },
          {
            id: '批规模克制', criterion: '每批 ≤8 个操作、只朝一个算子方向；apply 后每批重算一次，不做一次性规划',
            evidence: '引批 op 计数与算子一致性；超限批/混合算子批点名',
            source: '模板:教练回合', anchor: '≤8 个操作',
          },
        ],
      },
      {
        id: '裁决与路线', name: '裁决纪律与路线重写',
        criteria: [
          {
            id: '分歧纪律', criterion: '三段式分歧纪律：显然步免仲裁税不声明；真分歧才写 note.disagreement 升全量段；六区块能裁动就绝不升级双沙盘',
            evidence: '引 segments 轨迹与 disagreement 声明对照；滥用升级/该升不升的回合点名',
            source: '模板:教练回合', anchor: '六区块能裁动就绝不声明',
          },
          {
            id: '路线重写', criterion: 'route 恒写（3–7 条阶段条目）；非承诺措辞——不写时间估算与进度承诺；路线是草图不是权威结构',
            evidence: '引 route 条目数与措辞检查；出现「将完成/保证」类承诺措辞点名',
            source: '模板:教练回合', anchor: '随批重写',
          },
          {
            id: '停机转译', criterion: '回合被拉起 = 就绪深度未满足：结构无需变化时写 ops: []（裁决=等内容跟上）；终点.pre 已达最终台阶时先出收尾接线批再停摆',
            evidence: '引就绪检查结果与裁决对照；无理由停摆或该收尾不收尾点名',
            source: '模板:教练回合', anchor: '收尾即宣告承诺兑现',
          },
        ],
      },
    ],
  },
  {
    id: '种子·终点',
    product: '种子提案（起点 + 终点锚；含目标反编译的 seed 半区）',
    stations: ['种子起草', '目标反编译'],
    court: RUBRIC_COURTS,
    dimensions: [
      {
        id: '起点资格', name: '起点资格（ADR-0040）',
        criteria: [
          {
            id: '单一行为单元', criterion: '起点是坡道第一级台阶，任何情况下必须是单一行为单元：名字连缀两个可独立教学对象（与/和/及）或要先解释名字本身的行话泛称不合格',
            evidence: '引起点名对照正反例（「装好环境并运行第一行代码」✓ vs「Python 基础语法」✗）',
            source: 'ADR-0040', anchor: '单一行为单元',
          },
          {
            id: '常识起步', criterion: '零基础学习者从常识直接可起步（不依赖未教概念）；学习者自述的基础只写进 reason，不放松起点资格',
            evidence: '引起点 pre 依赖面（应为零）与 reason 措辞对照',
            source: 'ADR-0040', anchor: '零基础学习者从常识直接可起步',
          },
          {
            id: '宁简勿繁', criterion: '起点过简代价趋零、过繁代价是整条坡道断裂——拿不准取更简的',
            evidence: '引起点粒度与首个生长台阶推演对照',
            source: 'ADR-0040', anchor: '宁简勿繁',
          },
        ],
      },
      {
        id: '终点资格', name: '终点资格（ADR-0056）',
        criteria: [
          {
            id: '承诺句', criterion: '终点名是承诺句（学习者兑现了什么承诺的合成处），不是一节可教可考的台阶句；不受「单一行为单元」约束',
            evidence: '引终点名判断句式（台阶句/主题句点名）',
            source: 'ADR-0056', anchor: '终点是承诺句不是台阶句',
          },
          {
            id: '面向覆盖', criterion: '目标有几个面向，终点句就合成几个面向：禁止静默丢弃、禁止窄化限定词（「或/A 者 B」）；确实装不下显式取舍写进 reason',
            evidence: '引目标描述面向分解与终点句对照（#202 机器学习四面向反例同款审法）',
            source: 'ADR-0056', anchor: '禁静默丢弃',
          },
          {
            id: '可兑现', criterion: '教练能从起点沿真实的需要长出通往终点的主线、并能在既有节点齐备时据它裁决收尾；「成为大师」类空泛口号不合格',
            evidence: '引终点句推演最后台阶的可辨认性；推演不出收尾判据的点名',
            source: 'ADR-0056', anchor: '可兑现性判据',
          },
        ],
      },
      {
        id: '骨架与路由', name: '种子骨架与先验路由',
        criteria: [
          {
            id: '骨架模式', criterion: '起点恰 1–3 个、终点恰 1 个；种子节点零 enc 零 est 零 pre（朝终点的粗占位边由引擎落）；worksheet 仅 coverage 携带',
            evidence: '引提案字段清单对照骨架模式；携带 est/pre 或 capability 带 worksheet 点名',
            source: '模板:种子提案', anchor: '零 enc 零 est 零 pre',
          },
          {
            id: '先验路由', criterion: '附 Vault 先验段时起点放在熟悉边界（学习者笔记已稳定覆盖的不作起点，basis=vault）；无命中常识基线起步（basis=baseline）',
            evidence: '引先验命中与起点选择对照；把已稳定覆盖内容当起点/先验命中仍标 baseline 点名',
            source: '模板:种子提案', anchor: '熟悉边界',
          },
          {
            id: '定位与取舍', criterion: 'reason 写「定位与取舍」：起点为什么放这里（略过哪些地形）+ 终点覆盖/显式舍弃了哪些面向',
            evidence: '引 reason 与面向分解对照；只写定位不写取舍（或反之）点名',
            source: '模板:种子提案', anchor: '定位与取舍',
          },
        ],
      },
    ],
  },
]

/** 按产物类型取量规。 */
export function rubricOf(id: QualityRubric['id']): QualityRubric | undefined {
  return QUALITY_RUBRICS.find(r => r.id === id)
}

/** 全量规判据扁平视图（评审器 #222 消费：逐判据生成评审提示词与人审对表行）。 */
export function allCriteria(): Array<{ rubric: QualityRubric['id']; dimension: RubricDimension['id']; criterion: RubricCriterion }> {
  const out: Array<{ rubric: QualityRubric['id']; dimension: RubricDimension['id']; criterion: RubricCriterion }> = []
  for (const r of QUALITY_RUBRICS) {
    for (const d of r.dimensions) {
      for (const c of d.criteria) out.push({ rubric: r.id, dimension: d.id, criterion: c })
    }
  }
  return out
}
