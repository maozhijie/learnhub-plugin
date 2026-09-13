/**
 * 输出契约注册表 phase 1（#214 / ADR-0061）：把散在解析器、提示词文本、提交信息与
 * ADR 散文里的每站输出契约收拢为机器可读数据——CONTEXT.md「输出契约」词条的落地件，
 * 治「迭代漂移」的根（近三个月全部生成事故都是契约矛盾/边界不清，#212 §二）。
 *
 * - 每站一条：形态（format）、契约句（clause——模板里「只输出一个 YAML 文档」族指令
 *   的原文锚）、允许/禁止成分、修复策略（轮数/反馈形状/升档）、失败码族、格式敏感度
 *   （机械评审/规划/推理创意——治理该站是否有资格考虑结构化通道迁移，推理与创意
 *   敏感站默认不迁；`'json'` 枚举位保留 = 未来 JSON 迁移的口子）。
 * - phase 1 先对齐现状语义，不改行为：validateByContract 是格式级前置校验（深结构
 *   门仍归各站既有解析器），文本锚门在 tests/output-contract.test.ts——模板文本与本
 *   注册表交叉核对，漂移即红，门带自检（故意改坏锚点必须变红，防恒过门）。
 * - 站名 = 语料站名词表（host/corpus.ts STATIONS，#213 受控词表）的同名值；引擎侧
 *   不引宿主（R2），对齐由文本锚门测试三方核对（注册表 ↔ PROMPT_KINDS ↔ STATIONS）。
 * - phase 2（装配器按契约依赖自动推导 omitDeliverables，本票只出设计）：见 ADR-0061 §6。
 */

/** 输出形态。`'json'` 是保留枚举位：判卷/回执评审已在其上，其余站迁移与否由
 * 格式敏感度治理（#214 增补：YAML 站群默认不迁——多样性坍缩证据 arXiv:2607.18476）。 */
export type OutputFormat = 'yaml' | 'markdown-blocks' | 'json' | 'route-text'

/** 格式敏感度：该站产物对输出形态变化的敏感轴（#212 §五）。机械评审 = 分类/量表类
 * 任务、格式税证据充分为正向；规划 = 结构化规划产物；推理创意 = 推理/创意敏感，
 * 默认不迁结构化通道。 */
export type FormatSensitivity = '机械评审' | '规划' | '推理创意'

/** 一条修复机制的登记：`file` = 相对 `src/` 的 posix 路径（**精确匹配**——同名文件靠
 * basename 兜底会解析到任一个，把「登记指对文件」悄悄变成运气）；`witness` = 该文件里
 * 真实存在的稳定串，**全部命中**才算对上（逐级阶梯多见证串缺一不可）；`what` = 这条
 * 回路做什么，人读面与门面共用。 */
export interface RepairMechanismSpec {
  file: string
  witness: string[]
  what: string
}

/** 修复轮机制注册表（#217 / ADR-0066）：每条策略必须**点名持有该回路的机制**，机制名只许
 * 取本表的键。门（tests/repair-policy.test.ts）拿 `file` + `witness` 与实现对账——登记一个
 * 不存在的回路、或回路改名后登记没跟上，都会红。没有这张表，`repair` 列就只是散文：
 * 「罗盘 0 轮」「出题无整批轮」这类断言无从执法，改了实现也没人提醒登记失真。
 *
 * 本表只证明「这条回路存在」；「本站的 mechanism 字段指的就是它」由 `REPAIR_ROUND_LOCKS`
 * 的行为锁与逐站人工审查兜底——这条覆盖边界写在门里，不假装已全覆盖（ADR-0066 §1）。 */
export const REPAIR_MECHANISMS: Readonly<Record<string, RepairMechanismSpec>> = {
  outlineRepairFeedback: {
    file: 'generation-jobs.ts', witness: ['export function outlineRepairFeedback'],
    what: '大纲/拆节站：可修死因（OUTLINE_BUDGET/OUTLINE_SHAPE/MODEL_YAML）回灌恰一轮，其余原样上抛',
  },
  sectionRepairLadder: {
    file: 'host/jobs.ts', witness: ['Content.blockPatchPrompt', 'Content.sectionRepairBody', 'splitOverflowSection'],
    what: '节正文修复阶梯三档：块级局部修补 → 整节压缩（deep 升档）→ 溢出交大纲拆节',
  },
  gateRepairRound: {
    file: 'engine/agent.ts', witness: ['async gateRepairRound'],
    what: '缝的共享门错修复轮：门错误 + 被拒原文回灌重产恰一次，仍败以站点 fatal 抛两轮死因',
  },
  seedRepairPrompt: {
    file: 'engine/seed.ts', witness: ['export function seedRepairPrompt'],
    what: '种子起草：干跑校验门未过 → 回灌重出完整 YAML 恰一次',
  },
  decompileRepairPrompt: {
    file: 'engine/project-decompile.ts', witness: ['export function decompileRepairPrompt'],
    what: '目标反编译：双产物校验/名字对账死因回灌恰一次',
  },
  invokesOncePerQuestion: {
    file: 'engine/note-source.ts', witness: ['async repairInvokesOnce'],
    what: '出题逐题回路：清单在场且有题缺 invokes → 恰一次补标调用（不是整批重产）',
  },
  auditRepairOncePerQuestion: {
    file: 'engine/question-audit.ts', witness: ['出题修复（第二意见抽查发现答案键不一致）'],
    what: '出题第二意见（#223）：不一致题恰一次回灌修复、修复题原位替换再审计、仍败弃题',
  },
  gradingReaskOnce: {
    file: 'engine/content-subsystem.ts', witness: ['[重判要求]'],
    what: '判卷：解析失败自动重问一次，仍失败零落盘抛「AI 判卷输出不可用」',
  },
  disputeReaskOnce: {
    file: 'engine/question-bank.ts', witness: ['[重判要求]'],
    what: '申诉判卷：同判卷重判轮，仍失败抛「AI 复核输出不可用」',
  },
  milestoneStructureRepair: {
    file: 'host/jobs.ts', witness: ['MILESTONE_GATE_FAILED', 'gateRepairRound<string, MilestoneWriteResult>'],
    what: '里程碑产物：轻量结构门未过 → gateRepairRound 回灌重产恰一次',
  },
}

/** 修复策略（单源，对齐现状登记：rounds = 整批门错回灌重产轮数，0 = 无整批修复轮）。
 * feedback = 回灌反馈的形状；mechanism = 持有这 rounds 轮回路的机制（0 轮必须是 'none'，
 * 由 tests/repair-policy.test.ts 强制）；perItem = **不属于「几轮」范畴**的逐题/逐项回路
 * （出题站的两个恰一次回路从此有名字，不再只活在 feedback 散文里）；escalate = 升档/出路
 * 规则；note = 形态补充（块级修补 fail-safe、三段式回合等）。 */
export interface RepairPolicy {
  rounds: number
  feedback: string
  mechanism: RepairMechanism
  perItem?: RepairMechanism[]
  escalate?: string
  note?: string
}

/** 修复机制名 = 注册表键 ∪ 'none'（无整批修复回路，失败即断或零落盘）。 */
export type RepairMechanism = 'none' | keyof typeof REPAIR_MECHANISMS

/** 行为侧「几轮」的锁覆盖登记（#217）：站 → 断言该站模型调用数的测试文件；`null` =
 * **显式登记的缺口**（还没数过调用数，不假装已覆盖）。门断言两件事：① rounds > 0 的站
 * 必须在本表内（有锁或显式缺口——漏登即红）；② 有锁的站其测试文件必须真实存在。
 *
 * 为什么需要这张表：机制登记只证明「这个回路在 src/ 里存在」，**不证明「本站的
 * mechanism 字段指的是它」**——#217 逐站审查时正是靠人读实现抓出课程节拆分登记失真
 * （旧散文声称与大纲站同款回灌，实现对不上）。把「哪些站已经被数过调用数」变成数据，
 * 缺口就不会静默存在。 */
export const REPAIR_ROUND_LOCKS: Readonly<Record<string, string | null>> = {
  课程大纲: 'host-runtime.test.ts',
  课程节拆分: 'host-runtime.test.ts',
  题目生成: 'repair-policy.test.ts',
  回执评审: 'repair-policy.test.ts',
  罗盘: 'compass.test.ts',
  课程节生成: 'section-split.test.ts',
  种子起草: 'seed-proposal.test.ts',
  目标反编译: null,
  教练生长: null,
  里程碑草案: null,
  判卷: null,
  申诉判卷: null,
}

/** phase 1 格式级形状声明（validateByContract 的判据）。深结构门（逐题形态、候选
 * 对照、名字对账……）仍归各站解析器，本表只锁「解析产物像不像本站产物的形状」。 */
export type ContractShape =
  | { kind: 'yaml-top'; keys: Array<{ key: string; shape: 'array' | 'object' | 'string' | 'number' }> }
  | { kind: 'json-top'; keys: Array<{ key: string; shape: 'array' | 'object' | 'string' | 'number' }> }
  | { kind: 'markdown-section' }
  | { kind: 'markdown-blocks'; blocks: string[] }
  | { kind: 'route-text' }
  | { kind: 'any' }

/** 一条输出契约。station = 语料站名；surface = 同站多交付面时的面名（如课程节生成的
 * 正文/交互件）。锚源三族：templates（PROMPT_KINDS 键）/ systemAnchors（判卷族系统
 * 提示词判别名）/ specBlocks（引擎拼装规范块判别名）——至少声明一族，文本锚门据此
 * 取模板文本与契约句对账。 */
export interface OutputContract {
  station: string
  surface?: string
  templates?: string[]
  /** 判别名：reflection/open/dispute（grading.ts 系统提示词常量）、receipt（receipts.ts）。 */
  systemAnchors?: string[]
  /** 规范块判别名：interactiveSpecBlock（content.ts 交互规范块）。 */
  specBlocks?: string[]
  format: OutputFormat
  /** 契约句原文锚（模板/system 提示词里的输出指令原句，子串匹配——全部命中才算对上）。 */
  clause: string[]
  /** 契约在提示词的位置：模板（缺省）或 system（回执评审是全仓唯一 system 契约先例）。 */
  contractLocation?: '模板' | 'system'
  allowed: string[]
  forbidden: string[]
  repair: RepairPolicy
  /** 解析容忍（剥围栏/剥机器块注释重试等不改语义的清洗，tolerated 留痕）。 */
  tolerance?: string
  failureCodes: string[]
  sensitivity: FormatSensitivity
  /** 是否有资格考虑结构化通道迁移。phase 1 对齐现状：只有已在 JSON 通道上的站为 true；
   * YAML 站群默认不迁（#214 增补证据注记），迁移裁决归工具调用 spike（#216）。 */
  structuredEligible: boolean
  shape: ContractShape
  notes?: string
}

const YAML_CLAUSE = ['只输出一个 YAML 文档', '不要代码围栏、不要任何解释']

/** 输出契约注册表（全站覆盖：14 模板站 + 判卷族 + 交互件面；会话式辅导站不在册，
 * 理由见 OUT_OF_SCOPE_STATIONS）。修复策略列如实登记现状（罗盘 0 轮 = 金样本锚定、
 * 回执 0 轮 = ADR-0004 事务性、出题无整批轮——整批修复轮评估归 #217）。 */
export const OUTPUT_CONTRACTS: readonly OutputContract[] = [
  {
    station: '课程大纲',
    templates: ['课程大纲'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（node + sections 节清单，含 id/title/type/points/tier/visual）'],
    forbidden: ['代码围栏', '解释性文字', '机器块（enc_candidates 等节正文契约成分）'],
    repair: {
      rounds: 1,
      mechanism: 'outlineRepairFeedback',
      feedback: '解析/形状/护栏死因回灌（outlineRepairFeedback：OUTLINE_SHAPE、MODEL_YAML、节数护栏三类可修，其余原样上抛不回灌）',
      escalate: '大纲轮语义档随节点难度声明（高复杂度节点 deep）',
      note: '恰一回灌修复轮；重产仍败直接置 failed',
    },
    tolerance: 'parseModel 剥围栏 → 剥 HTML 注释/机器块重试（onTolerated 留痕，语料补标 tolerated）',
    failureCodes: ['OUTLINE_SHAPE', 'MODEL_YAML'],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'sections', shape: 'array' }] },
  },
  {
    station: '课程节生成',
    surface: '正文',
    templates: ['课程节生成', '课程节生成-苏格拉底', '课程节生成-费曼'],
    format: 'markdown-blocks',
    clause: ['只输出本节正文（## 标题 + 内容），不要附加解释'],
    allowed: [
      '单节 markdown 正文（以 ## 类型：标题 开头，标题与类型精确照抄本节任务）',
      '机器块（enc_candidates / learnhub-interactive / learnhub-predict）',
      '可视化块（mermaid/svg/plot/chart，单节合计 ≤2）',
    ],
    forbidden: ['frontmatter', '多节输出', '解释性文字', '### 子标题（warn）', '正文自设练习环节'],
    repair: {
      rounds: 2,
      mechanism: 'sectionRepairLadder',
      feedback: '质检清单回灌（✗ 项定位 + 块级修补给原文；长度 finding 附显式压缩目标与计数口径）',
      escalate: '整节修复轮升 deep 档；压缩仍溢出交管线跑大纲拆节阶梯（深度一层，子节不再拆）',
      note: '块级修补（#147）：清单 ✗ 全部定位到具体违规块才走，混入非块级 finding fail-safe 回整节修复',
    },
    tolerance: 'fixRichBlocks（plot/chart 尾随逗号清洗、svg 前导裁剪、mermaid 补引号）+ fixAliases（别名替换）落盘前确定性微修，留痕不静默',
    failureCodes: ['GATE_FAILED'],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'markdown-section' },
    notes: '学理最富站：worked example 阶梯/检索点/误解坑位/前置档位/图文互引硬约束见模板；溢出修复阶梯见 ADR-0054',
  },
  {
    station: '课程节生成',
    surface: '交互件',
    specBlocks: ['interactiveSpecBlock'],
    format: 'markdown-blocks',
    clause: ['只输出一个完整 HTML 文档（恰好一个 <!DOCTYPE html> 与一个 </html>），不要解释'],
    allowed: ['learnhub-interactive 标记块（完整自包含 HTML：widget-config 必填、完成上报、TEACHER 操作接口、单文件零外联）'],
    forbidden: ['外部 CDN 与网络请求', '解释性文字'],
    repair: {
      rounds: 2,
      mechanism: 'sectionRepairLadder',
      feedback: '交互件契约 finding 随节质检清单回灌（块级修补不支持交互件块，走整节修复）',
      escalate: '随课程节生成站修复阶梯（整节修复轮 deep 档）',
    },
    failureCodes: ['GATE_FAILED'],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'any' },
    notes: '交互件不是独立模型调用——它是节正文交付契约的组成面（contextPack §8 注入交互规范块，落盘由 extractInteractive 抽取替换引用块）',
  },
  {
    station: '课程节拆分',
    templates: ['课程节拆分'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（sections 2–3 子节：title/type/points/tier）'],
    forbidden: ['代码围栏', '解释性文字', '原节之外的新主题（只拆不扩）'],
    repair: {
      // #217 逐站审查抓出的登记失真（#214 继承的旧散文声称「同大纲站的死因回灌」）：
      // 实现对 splitOverflowSection 只发**一次**调用，解析失败原样上抛、由管线记入失败
      // 清单——`outlineRepairFeedback` 的唯一调用点在 jobs.ts 的大纲轮，拆节站没有它。
      // 登记按实现改（不是反过来）：拆节是节正文修复阶梯的**末级**，它自己不再有下一级。
      rounds: 0,
      mechanism: 'none',
      feedback: '无修复轮——拆分 YAML 解析失败原样上抛（管线记入该节失败清单，可「重试续跑」再走一遍；阶梯末级之下没有下一级）',
      escalate: '恒 deep 档（溢出拆节是修复阶梯末级）',
    },
    tolerance: '同大纲站（parseModel 剥围栏/注释重试，tolerated 留痕）',
    failureCodes: ['OUTLINE_SHAPE', 'MODEL_YAML'],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'sections', shape: 'array' }] },
    notes: '2–3 子节由引擎锁死（applySplit）',
  },
  {
    station: '题目生成',
    templates: ['题目生成'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（node + questions，九题型，invokes 恰一枚在册概念）'],
    forbidden: ['代码围栏', '解释性文字', 'YAML 双引号（吃掉 LaTeX 反斜杠）', 'ASCII 数学记号'],
    repair: {
      rounds: 0,
      mechanism: 'none',
      perItem: ['invokesOncePerQuestion', 'auditRepairOncePerQuestion'],
      feedback: '门错无整批修复轮（#214 现状，#217 复核裁决维持——理由与预注册触发条件见 ADR-0066 §3）；逐题补标恰一次（repairInvokesOnce，#148）；第二意见审计不一致题恰一次回灌修复（#223 question-audit，deep 档，修复再审计仍败弃题）',
      note: '逐题门（转义/答案形态/invokes 在册/查重）拒收走报告面；整批修复轮的裁决与预注册触发条件见 ADR-0066 §3',
    },
    tolerance: 'repairQuestionStrings 转义损坏确定性修复（计数留痕），修不好拒收',
    failureCodes: ['MODEL_YAML'],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'questions', shape: 'array' }] },
    notes: '逐题门拒收无稳定码（rejected 数组报告）；单题非法不毁整批；全弃光沿用既有「一道都没入库」fail loud 语义',
  },
  {
    station: '独立解题',
    specBlocks: ['solverPrompt'],
    format: 'json',
    clause: ['只输出一个 JSON 对象（不要代码围栏、不要任何解释）'],
    allowed: ['一个 JSON 对象（answer 按题型形态 + steps 关键步骤一两句）'],
    forbidden: ['代码围栏', '解释性文字'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮——应答不可解析按审计失败保守放行（unresolved，不弃题不重试）' },
    failureCodes: [],
    sensitivity: '机械评审',
    structuredEligible: true,
    shape: { kind: 'any' },
    notes: '#223 第二意见门的盲解调用：只看题干与选项、零答案键零解析（answer 形态按题型：字母/字母数组/布尔/术语/数值/数组）；对账比较器 = evaluateAllo（判卷同款）',
  },
  {
    station: '笔记出题',
    templates: ['笔记出题'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（node + questions，题型收敛子集：单选/判断/填空/数值/反思）'],
    forbidden: ['代码围栏', '解释性文字', 'YAML 双引号', 'ordering/matching/multi_choice/open_question（笔记源 v1 题型收敛）'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮（同题目生成站现状）' },
    tolerance: '同题目生成站（转义修复留痕）',
    failureCodes: ['MODEL_YAML'],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'questions', shape: 'array' }] },
  },
  {
    station: '错误对比卡',
    templates: ['错误对比卡'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（cards，每候选恰一张卡：node/source_q 照抄 + options 三项 + answer/mine）'],
    forbidden: ['代码围栏', '解释性文字', '候选清单之外的 (node, source_q)'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮——候选对照门/schema 门未过零落盘抛错' },
    failureCodes: [],
    sensitivity: '机械评审',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'cards', shape: 'array' }] },
    notes: '机械出卡恒 fast 档；无修复轮的代价由「零落盘 + 可重试」承担',
  },
  {
    station: '回执评审',
    templates: ['回执评审'],
    systemAnchors: ['receipt'],
    format: 'json',
    clause: ['严格 JSON，不要代码围栏、不要任何额外解释'],
    contractLocation: 'system',
    allowed: ['一个 JSON 对象（score 0–1 + verdict 总评 + errors 逐条拆解，brief 时 errors 空数组）'],
    forbidden: ['代码围栏', '解释性文字'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮（ADR-0004 事务性：解析失败回执与 EMA 零落盘）' },
    failureCodes: [],
    sensitivity: '机械评审',
    structuredEligible: true,
    shape: { kind: 'json-top', keys: [{ key: 'score', shape: 'number' }, { key: 'verdict', shape: 'string' }] },
    notes: '契约在 system 提示（全仓唯一）——离生成点最近，契约后置（#218）的现成先例',
  },
  {
    station: '判卷',
    systemAnchors: ['reflection', 'open'],
    format: 'json',
    clause: ['Output JSON only, without Markdown fences or commentary'],
    contractLocation: 'system',
    allowed: ['一个 JSON 对象（score + feedback 两段批改；reflection 0–1 / open 0–10 整数）'],
    forbidden: ['Markdown 围栏', '注释与外层散文'],
    repair: {
      rounds: 1,
      mechanism: 'gradingReaskOnce',
      feedback: '解析失败自动重问一次（[重判要求] 只输出一个 JSON 对象）',
      note: '仍失败抛「AI 判卷输出不可用」——本次作答边界失败零落盘，原始输出留痕判卷失败.jsonl（#116 逃生门）',
    },
    tolerance: '剥围栏 → 取 {...} → 去尾逗号（parseGradingDoc 容错）',
    failureCodes: [],
    sensitivity: '机械评审',
    structuredEligible: true,
    shape: { kind: 'json-top', keys: [{ key: 'score', shape: 'number' }, { key: 'feedback', shape: 'string' }] },
    notes: '规则题型（单选/判断/填空/多选/数值/排序/配对）不走模型判卷——evaluateAllo 确定性判卷',
  },
  {
    station: '申诉判卷',
    systemAnchors: ['dispute'],
    format: 'json',
    clause: ['Output JSON only, without Markdown fences or commentary'],
    contractLocation: 'system',
    allowed: ['一个 JSON 对象（verdict 三态 + reasoning；key_error 必附 suggested_answer）'],
    forbidden: ['Markdown 围栏', '注释与外层散文'],
    repair: { rounds: 1, mechanism: 'disputeReaskOnce', feedback: '解析失败自动重问一次（同判卷重判轮）', note: '仍失败抛「AI 复核输出不可用」，UI 放行直接豁免降级入口' },
    tolerance: '同判卷（parseGradingDoc 容错）',
    failureCodes: [],
    sensitivity: '机械评审',
    structuredEligible: true,
    shape: { kind: 'json-top', keys: [{ key: 'verdict', shape: 'string' }, { key: 'reasoning', shape: 'string' }] },
    notes: '两段式防锚定（Phase 1 独立解题、明确忽略存储键）——全仓 LLM-as-judge 先例，#223 第二意见门继承此形态',
  },
  {
    station: '种子起草',
    templates: ['种子提案'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（course/mode/reason/goal_type/endpoint/starts（1–3）/worksheet（仅 coverage））'],
    forbidden: ['代码围栏', '解释性文字', 'est/enc/pre 等种子骨架外字段（粗占位边引擎落）', 'capability 携带 worksheet'],
    repair: {
      rounds: 1,
      mechanism: 'seedRepairPrompt',
      feedback: '受理门错误原文 + 被拒候选原文回灌（seedRepairPrompt，gateRepairRound 恰一次）',
      escalate: '修复轮 deep 档',
    },
    failureCodes: ['SEED_GATE_FAILED'],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'endpoint', shape: 'object' }, { key: 'starts', shape: 'array' }] },
    notes: '权威受理门在 proposeSeed（schema/注册表对账/结构/概念对表）；唯一有操作化正反例的站（起点/终点资格 ✗✓）',
  },
  {
    station: '教练生长',
    templates: ['教练回合'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（course/note（operator+reason[+disappointment? disagreement+recheck]）/route/ops/concepts）'],
    forbidden: ['代码围栏', '解释性文字', '终点出现在 add_node 的 pre 里（禁长过目标）', '非插入批携带 recheck'],
    repair: {
      rounds: 1,
      mechanism: 'gateRepairRound',
      feedback: '受理门反馈 + 被拒裁决原文随全量包回灌重裁（repair 单发，恰一次）',
      escalate: '重裁段恒 deep 档',
      note: '三段式回合：轻量段 fast 恒 1 调用 → 分歧升级全量段 deep → 仍真分歧双沙盘仲裁段；每段经 agentLoop 工具回路（K≤6）',
    },
    failureCodes: [],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'note', shape: 'object' }, { key: 'route', shape: 'string' }, { key: 'ops', shape: 'array' }] },
    notes: '受理门（schema/结构事实/概念对表/锚保护/巩固门/生长闸门/路线门）拒收零落盘；裁决语义全在提示词（生长纪律 ADR-0040）',
  },
  {
    station: '罗盘',
    templates: ['罗盘初画'],
    format: 'route-text',
    clause: ['只输出「剩余路线」一节的正文', '不带 "## " 标题、不带代码围栏、不要解释'],
    allowed: ['「剩余路线」一节正文（3–7 个阶段条目，每条一行 - **阶段名**：一句话）'],
    forbidden: ['"## " 段级标题', '代码围栏', '时间估算与进度百分比（非承诺措辞）'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮——路线门首过即落盘（金样本锚定恒 1 调用，调用数在 tests/compass.test.ts 锚定）' },
    tolerance: 'stripWrappingFence（剥整段包裹围栏）',
    failureCodes: [],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'route-text' },
    notes: '版本最老的模板（v1）；经只读工具回路（K≤6）自证节点名后画线',
  },
  {
    station: '目标反编译',
    templates: ['项目目标反编译'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档双产物（project + plan 半区 + seed 半区；显式目标课程时 seed 半区省略）'],
    forbidden: ['代码围栏', '解释性文字', '计划引用种子簇与既有结构之外的节点名（名字对账）'],
    repair: {
      rounds: 1,
      mechanism: 'decompileRepairPrompt',
      feedback: '双产物拆分校验/名字对账死因回灌（decompileRepairPrompt，gateRepairRound 恰一次）',
      escalate: '修复轮 deep 档',
    },
    failureCodes: [],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'project', shape: 'string' }, { key: 'plan', shape: 'array' }] },
    notes: '双提案同进同退（人审联合 apply）；seed 半区起点资格同种子提案判据（v9）',
  },
  {
    station: '计划草案',
    templates: ['项目里程碑计划'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（project + plan 3–8 里程碑：id/name/task_class/acceptance_hints/est/nodes）'],
    forbidden: ['代码围栏', '解释性文字', '每里程碑档位（渐退档是项目属性）'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮——计划草案一次成型；修订走提案快照的人审语义，草案不自动重试' },
    failureCodes: [],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'project', shape: 'string' }, { key: 'plan', shape: 'array' }] },
  },
  {
    station: '里程碑草案',
    templates: ['项目里程碑产物'],
    format: 'markdown-blocks',
    clause: ['只输出这一个里程碑的任务卡（四块），不要解释'],
    allowed: ['四块固定任务卡（## 给定 / ## 待办 / ## 验收清单 / ## 支持，缺一不可）'],
    forbidden: ['解释性文字', '题目与题库字段（能力核对只走验收清单）', '其他里程碑的任务卡'],
    repair: {
      rounds: 1,
      mechanism: 'milestoneStructureRepair',
      feedback: '轻量结构门错误回灌（sectionRepairPrompt 同款机械，gateRepairRound 复用）',
      escalate: '修复轮 deep 档',
    },
    failureCodes: ['MILESTONE_GATE_FAILED'],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'markdown-blocks', blocks: ['给定', '待办', '验收清单', '支持'] },
    notes: '渐退三档配比按系统给出的当前档位只写一档；首生直落 / 已生成自动转重生成提案',
  },
]

/** phase 1 明确不在册的语料站与理由（覆盖面是显式清单，不是漏登）：会话式辅导站
 * （AgentSeam/直调、自由文本、无固定交付契约）不立输出契约；申诉判卷在册（判卷族）。 */
export const OUT_OF_SCOPE_STATIONS: readonly { station: string; reason: string }[] = [
  { station: '讲解反馈', reason: '会话式讲解定位反馈——自由文本，无固定交付契约（E2 档案面）' },
  { station: '自注反馈', reason: '会话式自注反馈——自由文本，无固定交付契约（E1 档案面）' },
  { station: '老师辅导', reason: '会话式辅导——对话形态，无固定交付契约' },
  { station: '讲给我听', reason: '会话式费曼回讲——对话形态，无固定交付契约' },
]

/** 按站取契约（同站多交付面用 surface 区分；缺省返回正文/唯一面）。 */
export function contractOf(station: string, surface?: string): OutputContract | undefined {
  return OUTPUT_CONTRACTS.find(c => c.station === station && (surface === undefined || c.surface === surface))
}

/** 一次模板版本变更的登记（#220 的字段格式：version / date / change type / **预期输出
 * 增量**）。`version` = 变更后的模板版本标记；`expectedDelta` = 这次改动**预期模型输出
 * 发生什么变化**——语料回放（#213）与评审对照（#222）据此对账「变了没有、变得对不对」，
 * 也是 #220「改模板必须带预期增量」过门条件的登记面。 */
export interface PromptBump {
  version: number
  date: string
  changeType: string
  expectedDelta: string
}

/** 提示词变更登记表（键 = PROMPT_KINDS 键，覆盖完备性由 tests/output-contract.test.ts
 * 对账）。**本表自 #218 起计**：#218 之前的历史版本线未回填（那时没有登记面，编不出一份
 * 诚实的表）；#220 落地后按同字段格式接管完整纪律，本表随之并入。
 *
 * 不变式（门在执法，不是注释）：每个模板键的**最高**登记版本 == 模板头
 * `<!-- learnhub:prompt/vN -->` 的现行版本——**bump 了模板却没补登记条目 = 红**。同一
 * 版本号下允许第二条登记：模板文本没动、但最终 prompt 变了（拼装侧重排、上下文包变更）
 * 也是「预期输出增量」要覆盖的变更，记在同一版本号下并写明变更面，不冒充版本 bump。 */
export const PROMPT_CHANGELOG: Readonly<Record<string, readonly PromptBump[]>> = {
  课程大纲: [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置 + 完整输出示例（占位域）+ 示例值占位化',
    expectedDelta: '输出段落尾（契约句是最终 prompt 的最后一段）；YAML 结构、节数与配比不变；示例不再把「整数与自然数的分界」一类真实内容带进输出（旧版示例值可被回填，占位化后不可）',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：上下文包的实现 bug 修复。受影响的是消费
    // 上下文包的三站（大纲/节生成/拆节），登记挂在主消费者（大纲）名下并在 ADR-0065 §6 说明。
    version: 11, date: '2026-09-13', changeType: '上下文包 §5「禁止使用的概念」复活（实现 bug 修复，模板文本未动）',
    expectedDelta: '大纲/节生成/拆节三站的 prompt 多出「§5 禁止使用的概念」清单（旧实现 Object.keys(Set) 恒空 → §5 恒渲染「（无：本节点已是图内最深）」）：最多 200 个更深节点名 + 超限时的截断告知。预期效果是「不提前教」的负向约束恢复生效；代价是 prompt 增长 1–2k 字。此项**未做真模型对照**（见 ADR-0065 §6）——若观察到幻觉/跑题上升，回退点就是这一行',
  }],
  课程节生成: [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '契约句（只输出本节正文）从 prompt 中段移到末段；正文结构与学理约束不变',
  }],
  '课程节生成-苏格拉底': [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '同上（风格变体同构）',
  }],
  '课程节生成-费曼': [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '同上（风格变体同构）',
  }],
  课程节拆分: [{
    version: 9, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '契约句移到末段；拆分 YAML 形态不变',
  }],
  题目生成: [{
    version: 14, date: '2026-09-13', changeType: '拼装侧契约后置 + 完整输出示例（占位域）+ section 示例占位化',
    expectedDelta: '契约句移到末段（查重块/概念清单/全节点正文等材料都在它之前）；题型与答案形态契约不变；示例值占位化后不会被回填成题干',
  }],
  笔记出题: [{
    version: 9, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '契约句移到末段；题型收敛子集不变',
  }],
  项目里程碑计划: [{
    version: 8, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: '契约句与 plan schema 从「硬约束 1」移到模板末段；里程碑条目形态不变',
  }],
  项目里程碑产物: [{
    version: 7, date: '2026-09-13', changeType: '输出结构段移到模板末尾并更名 `## 输出` + 拼装侧契约后置',
    expectedDelta: '四块任务卡的契约句与块清单落在末段；渐退三档配比指令提前（仍是同一份约束文本）',
  }],
  项目目标反编译: [{
    version: 10, date: '2026-09-13', changeType: '输出段与硬约束段换序（契约置尾）+ 拼装侧契约后置 + 现有节点名清单按区·块分段',
    expectedDelta: '契约句与双产物 schema 落在末段；plan/seed 字段形态不变；节点名清单从平铺千行改为按「区 · 块」分组（取值域不变、不截断）',
  }],
  回执评审: [{
    version: 6, date: '2026-09-13', changeType: '拼装侧：契约本就在 system 提示词（全仓先例，未动）',
    expectedDelta: '无变化——该站早就是「契约离生成点最近」的形态，是本次改版的参照物',
  }],
  错误对比卡: [{
    version: 8, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: 'cards schema 从「硬约束 1」移到模板末段；卡片字段形态不变',
  }],
  罗盘初画: [{
    version: 2, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: '路线正文契约句从「硬约束 1」移到末段；3–7 条阶段条目与措辞纪律不变',
  }],
  教练回合: [{
    version: 6, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: 'note/route/ops schema 从「硬约束 1」移到末段（回灌重裁段同构）；算子语义与批规模纪律不变',
  }],
  种子提案: [{
    version: 4, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: '种子 schema 从「硬约束 1」移到末段（修复轮同构）；起点/终点资格判据文本不变',
  }],
}

/** phase 1 格式级校验：解析产物按注册表 shape 校验（对齐现状语义，不改行为——
 * 深结构门仍归各站解析器，本函数只回答「这坨解析产物像不像本站产物的形状」）。 */
export function validateByContract(entry: OutputContract, parsed: unknown): { ok: true } | { ok: false; errors: string[] } {
  const s = entry.shape
  if (s.kind === 'any') return { ok: true }
  if (s.kind === 'yaml-top' || s.kind === 'json-top') {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, errors: [`[${entry.station}] ${s.kind === 'json-top' ? 'JSON' : 'YAML'} 产物必须是映射（顶层对象）`] }
    }
    const d = parsed as Record<string, unknown>
    const errors: string[] = []
    for (const { key, shape } of s.keys) {
      const v = d[key]
      const missing = v === undefined || v === null
      const bad = !missing && ((shape === 'array' && !Array.isArray(v))
        || (shape === 'object' && (typeof v !== 'object' || Array.isArray(v)))
        || (shape === 'string' && typeof v !== 'string')
        || (shape === 'number' && typeof v !== 'number'))
      if (missing || bad) errors.push(`[${entry.station}] 顶层 ${key} 缺失或不是 ${shape}`)
    }
    return errors.length ? { ok: false, errors } : { ok: true }
  }
  if (typeof parsed !== 'string' || !parsed.trim()) {
    return { ok: false, errors: [`[${entry.station}] 产物必须是${s.kind === 'route-text' ? '路线正文' : 'markdown 正文'}文本`] }
  }
  if (s.kind === 'markdown-section') {
    const errors: string[] = []
    if (!parsed.trimStart().startsWith('## ')) errors.push(`[${entry.station}] 正文必须以「## 类型：标题」开头`)
    if (/^---\s*$/m.test(parsed.slice(0, 40))) errors.push(`[${entry.station}] 正文不得携带 frontmatter`)
    return errors.length ? { ok: false, errors } : { ok: true }
  }
  if (s.kind === 'markdown-blocks') {
    const missing = s.blocks.filter(b => !parsed.includes(`## ${b}`))
    return missing.length
      ? { ok: false, errors: [`[${entry.station}] 缺少固定块：${missing.map(b => `## ${b}`).join('、')}`] }
      : { ok: true }
  }
  // route-text：无段级标题、无围栏（路线门 validateRouteBody 的格式级子集；条目数与
  // 措辞门仍归 compass.ts 原门，phase 1 不重复执法）
  const errors: string[] = []
  if (/^## /m.test(parsed)) errors.push(`[${entry.station}] 路线正文不得携带 "## " 段级标题`)
  if (parsed.includes('```')) errors.push(`[${entry.station}] 路线正文不得携带代码围栏`)
  return errors.length ? { ok: false, errors } : { ok: true }
}
