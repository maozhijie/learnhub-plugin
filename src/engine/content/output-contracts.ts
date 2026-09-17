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
 * 格式敏感度治理（#214 增补：YAML 站群默认不迁——多样性坍缩证据 arXiv:2607.18476）。
 * `'tool-calls'`（#271 / ADR-0088）：产物整个在工具调用参数里（生长草稿执行官站），
 * 文本只是说明——塞进 'json' 是语义撒谎且文本锚门对不上。 */
export type OutputFormat = 'yaml' | 'markdown-blocks' | 'json' | 'route-text' | 'tool-calls'

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
    file: 'engine/infra/agent.ts', witness: ['async gateRepairRound'],
    what: '缝的共享门错修复轮：门错误 + 被拒原文回灌重产恰一次，仍败以站点 fatal 抛两轮死因',
  },
  decompileRepairPrompt: {
    file: 'engine/practice/project-decompile.ts', witness: ['export function decompileRepairPrompt'],
    what: '目标反编译：产物校验/名字对账死因回灌恰一次',
  },
  invokesOncePerQuestion: {
    file: 'engine/vault/note-source.ts', witness: ['async repairInvokesOnce'],
    what: '出题逐题回路：清单在场且有题缺 invokes → 恰一次补标调用（不是整批重产）',
  },
  auditRepairOncePerQuestion: {
    // #237 / ADR-0075：证人原为提示词文本「出题修复（第二意见抽查发现答案键不一致）」，该散文
    // 已迁到 prompts/quiz.ts（QUIZ_AUDIT_REPAIR_PROMPT）。证人换成**代码级锚点**：机制的实现
    // 是这个回路，不是那段散文——指向调用点才能同时盯住「回路被删」与「常量改名」。
    file: 'engine/content/question-audit.ts', witness: ['const repairPrompt = render(QUIZ_AUDIT_REPAIR_PROMPT'],
    what: '出题第二意见（#223）：不一致题恰一次回灌修复、修复题原位替换再审计、仍败弃题',
  },
  gradingReaskOnce: {
    // #237 / ADR-0075：同上，重问轮的证人由 `[重判要求]`（现住 prompts/content.ts）换成调用点。
    file: 'engine/content/content-subsystem.ts', witness: ['render(GRADING_REASK_PROMPT'],
    what: '判卷：解析失败自动重问一次，仍失败零落盘抛「AI 判卷输出不可用」',
  },
  disputeReaskOnce: {
    // #237 / ADR-0075：同上，重判后缀证人由 `[重判要求]`（现住 prompts/quiz.ts）换成调用点。
    file: 'engine/content/question-bank.ts', witness: ['render(DISPUTE_REASK_SUFFIX'],
    what: '申诉判卷：同判卷重判轮，仍失败抛「AI 复核输出不可用」',
  },
  milestoneStructureRepair: {
    file: 'host/jobs.ts', witness: ['MILESTONE_GATE_FAILED', 'gateRepairRound<string, MilestoneWriteResult>'],
    what: '里程碑产物：轻量结构门未过 → gateRepairRound 回灌重产恰一次',
  },
  draftAuditRepair: {
    // #271 / ADR-0088：证人 = 写件工具分发处的字面量（draft_patch/draft_audit/draft_finish；
    // #309 起增 draft_revert——第四具写件工具，门错误回灌继续修的机制面一并未变）。
    file: 'engine/coach/growth-subsystem.ts', witness: ['draft_patch', 'draft_audit', 'draft_finish', 'draft_revert'],
    what: '生长草稿执行官站：写件工具的门错误原文回灌 loop 继续修（轮数计入会话预算，不进 gateRepairRound）',
  },
  plannerRecheckOnce: {
    // #273：证人 = 思路官重裁调用点（agent.repair 站名走 COACH_PLAN_STATION 常量；
    // #301 起站名不再散字面量，证人串跟着换成常量名形态）。
    file: 'engine/coach/growth-subsystem.ts', witness: ['agent.repair(COACH_PLAN_STATION', 'COACH_PLAN_FEEDBACK_BLOCK'],
    what: '教练思路官：计划 schema 门拒收 → 门错误 + 被拒计划原文回灌重裁恰一次，仍败两轮死因抛出',
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
  教练执行: null,
  教练思路: 'coach-plan.test.ts',
  目标反编译: null,
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
    station: '质量评审',
    systemAnchors: ['qualityReview'],
    format: 'json',
    clause: ['JSON only，不带 Markdown 围栏、不带任何解释性文字'],
    contractLocation: 'system',
    allowed: ['一个 JSON 对象（dimensions 数组：逐维度 id + score 1–4 或 null + evidence 引文数组 + notes；二期另带 revised 与 contract_note）'],
    forbidden: ['Markdown 围栏', '解释性文字', '跨维度总分（量规无总分档——维度正交）'],
    repair: {
      rounds: 0,
      mechanism: 'none',
      feedback: '无修复轮——评分应答不可解析即记该件「评审失败」并在报告单列（评审不是产站：坏应答不重试以免成本翻倍；评审失败不得被读成低分）',
    },
    tolerance: '剥围栏 → 取首个 {...} → 去尾逗号（parseReviewDoc 容错，与判卷族同款机械）',
    failureCodes: [],
    sensitivity: '机械评审',
    structuredEligible: true,
    shape: { kind: 'json-top', keys: [{ key: 'dimensions', shape: 'array' }] },
    notes: '评审器（#222 / ADR-0070）的判定应答：契约住 system（判卷族同款——判定器不是产站，'
      + '判据在质量量规注册表 #221，本条目只锁应答形态与「无总分」禁令）。一期盲评/二期对账两段式（防锚定，照搬申诉复核形态）。',
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
    station: '教练思路',
    templates: ['思路官回合', '思路官重裁'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（course/operator/reason/target_endpoints/steps[intent/teaches_concept/est_hint][+recheck]）——零节点名零图上引用'],
    forbidden: ['代码围栏', '解释性文字', 'steps 内出现图 op 字段（op/name/node/pre/ops）——补丁归执行官'],
    repair: {
      rounds: 1,
      mechanism: 'plannerRecheckOnce',
      feedback: '计划 schema 门错误 + 被拒计划原文回灌重裁（repair 单发，恰一次）',
      escalate: '重裁恒 fast 档（两族同档）',
      note: '两站编排（#273）：思路官单轮零工具单发（两族随触发点折叠），停摆计划不拉执行官；执行归「教练执行」站的草稿回路',
    },
    failureCodes: [],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'yaml-top', keys: [{ key: 'operator', shape: 'string' }, { key: 'reason', shape: 'string' }, { key: 'steps', shape: 'array' }] },
    notes: '交接契约零名字零引用（粒度变焦归执行官）；显式重裁族注入上次裁决摘要（applied edit 提案留痕）',
  },
  {
    station: '教练执行',
    templates: ['执行官回合'],
    format: 'tool-calls',
    clause: ['产物以工具调用承载（draft_patch / draft_audit / draft_finish）', '全程以工具调用工作'],
    allowed: ['draft_patch / draft_audit / draft_finish 工具调用轨迹（产物在参数里；文本只作说明）'],
    forbidden: ['以正文交付裁决', '代码围栏', 'move 与 region/block（已退役 #275）'],
    repair: {
      rounds: 1,
      mechanism: 'draftAuditRepair',
      feedback: 'draft_patch/draft_audit/draft_finish 的门错误原文 + 合法取值域回灌 loop 继续修（轮数计入会话预算；不进 gateRepairRound）',
      note: '禁止空手结束 = 自然收束且有未发布增量 fail loud；计划门修复轮归思路官站（plannerRecheckOnce）',
    },
    failureCodes: [],
    sensitivity: '规划',
    structuredEligible: false,
    shape: { kind: 'any' },
    notes: '生长草稿执行官站（#271 / ADR-0088）：草稿通过 = 门通过按构造成立（editGateErrors 三处同调）；按批 finish 走真实受理门 → apply（tool-calls 是自己的结构化通道，不占 json 迁移资格口径）',
  },
  {
    station: '罗盘',
    templates: ['罗盘初画', '罗盘重画'],
    format: 'route-text',
    clause: ['只输出「剩余路线」一节的正文', '不带 "## " 标题、不带代码围栏、不要解释'],
    allowed: ['「剩余路线」一节正文（3–7 个阶段条目，每条一行 - **阶段名**：一句话；可标（深度：知道/会用/能教）与（候选））'],
    forbidden: ['"## " 段级标题', '代码围栏', '时间估算与进度百分比（非承诺措辞）'],
    repair: { rounds: 0, mechanism: 'none', feedback: '无修复轮——路线门首过即落盘（金样本锚定恒 1 调用，调用数在 tests/compass.test.ts 锚定）' },
    tolerance: 'stripWrappingFence（剥整段包裹围栏）',
    failureCodes: [],
    sensitivity: '推理创意',
    structuredEligible: false,
    shape: { kind: 'route-text' },
    notes: '版本最老的模板（v1）；经只读工具回路（K≤20）自证节点名后画线',
  },
  {
    station: '目标反编译',
    templates: ['项目目标反编译'],
    format: 'yaml',
    clause: YAML_CLAUSE,
    allowed: ['单个 YAML 文档（project + plan 半区；#256 起 seed 半区退役，plan-only）'],
    forbidden: ['代码围栏', '解释性文字', '计划引用既有结构之外的节点名（名字对账）'],
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
    notes: 'plan-only（#256 种子半区退役）：只产计划提案，apply 由 learnhub_project_apply 人审生效',
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
  }, {
    // 非模板变更（同版本号第三条登记）：**注入面换核**。模板文本一字未动，但最终 prompt 的
    // 「学习者已有理解（Vault 先验）」段会变——受影响的是注入先验的全部站（课程大纲/节生成
    // 三变体/拆节/出题二路/种子起草/目标反编译），按 #218 先例登记在上下文包的主消费者
    // （大纲）名下，变更面与判据见 ADR-0071。
    version: 11, date: '2026-09-13', changeType: 'Vault 先验检索换核（#229；模板文本未动，注入段内容变）',
    expectedDelta: '带 vault 个人笔记时「学习者已有理解」段召回的笔记集合与摘录窗口会变（IDF 压普遍词、登记表别名/易混扩词召回私人记法、mtime 优先取代目录字典序截断）；零命中时该段照旧缺席，但生成任务记录多了审计读数（扫 N 篇/截断/扩词）。无笔记的 vault 输出无变化',
  }, {
    // ADR-0079 门禁改革去重：门禁机械规则（1.3/2 倍阈值、可视化 ≤2、### 子标题提示）
    // 从散文删除——阈值以质检门（引擎）为单源，散文只留设计导向，防两处漂移。
    version: 12, date: '2026-09-14', changeType: '删散文里的门禁机械规则（1.3/2 倍阈值、可视化 ≤2、### 子标题提示句）',
    expectedDelta: '大纲/节生成的篇幅与可视化描述只留设计导向（1–2 屏、硬约束、可视化为主、预算见 §9），不再枚举拒收线与上限数字；生成行为预期不变——门在引擎侧执法且阈值未动（ADR-0079）',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 12, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）。',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音。 过门记录：check ✓（同版本号下的注入面登记不被提交级门执法——ADR-0072 §已知边界 ④，靠人审）；replay 报 3 件存量漂移（教练生长 2 件 + 种子起草 1 件，与本表 #273/#272 条目所列同一批同因），非本次变更引入；compare 未做真模型对照（同 #218 先例）——同票其余站（13 站去菜单 + 判据注入 3 站 + 重裁摘要修正 1 条，共 17 条登记）过门记录同此，见 ADR-0094',
  }],
  课程节生成: [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '契约句（只输出本节正文）从 prompt 中段移到末段；正文结构与学理约束不变',
  }, {
    // 同上（ADR-0079）：三风格变体共享的硬约束第 6 条删两处门禁机械规则。
    version: 12, date: '2026-09-14', changeType: '删散文里的门禁机械规则（1.3/2 倍阈值、可视化 ≤2 拒收句）',
    expectedDelta: '硬约束第 6 条保留「可视化为主、字数额度见 §9」，不再枚举拒收线与可视化上限；生成行为预期不变——门在引擎侧执法且阈值未动（ADR-0079）',
  }],
  '课程节生成-苏格拉底': [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '同上（风格变体同构）',
  }, {
    version: 12, date: '2026-09-14', changeType: '删散文里的门禁机械规则（1.3/2 倍阈值、可视化 ≤2 拒收句）',
    expectedDelta: '同课程节生成（风格变体同构；ADR-0079）',
  }],
  '课程节生成-费曼': [{
    version: 11, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '同上（风格变体同构）',
  }, {
    version: 12, date: '2026-09-14', changeType: '删散文里的门禁机械规则（1.3/2 倍阈值、可视化 ≤2 拒收句）',
    expectedDelta: '同课程节生成（风格变体同构；ADR-0079）',
  }],
  课程节拆分: [{
    version: 9, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '契约句移到末段；拆分 YAML 形态不变',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 9, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  题目生成: [{
    version: 14, date: '2026-09-13', changeType: '拼装侧契约后置 + 完整输出示例（占位域）+ section 示例占位化',
    expectedDelta: '契约句移到末段（查重块/概念清单/全节点正文等材料都在它之前）；题型与答案形态契约不变；示例值占位化后不会被回填成题干',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 14, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  笔记出题: [{
    version: 9, date: '2026-09-13', changeType: '拼装侧契约后置（模板文本未动）',
    expectedDelta: '契约句移到末段；题型收敛子集不变',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 9, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  项目里程碑计划: [{
    version: 8, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: '契约句与 plan schema 从「硬约束 1」移到模板末段；里程碑条目形态不变',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 8, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  项目里程碑产物: [{
    version: 7, date: '2026-09-13', changeType: '输出结构段移到模板末尾并更名 `## 输出` + 拼装侧契约后置',
    expectedDelta: '四块任务卡的契约句与块清单落在末段；渐退三档配比指令提前（仍是同一份约束文本）',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 7, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  项目目标反编译: [{
    version: 10, date: '2026-09-13', changeType: '输出段与硬约束段换序（契约置尾）+ 拼装侧契约后置 + 现有节点名清单按区·块分段',
    expectedDelta: '契约句与双产物 schema 落在末段；plan/seed 字段形态不变；节点名清单从平铺千行改为按「区 · 块」分组（取值域不变、不截断）',
  }, {
    // #240 / ADR-0076 第七节：种子降职后本站只产计划提案（seed 半区退役），且课程
    // 必须已注册（未注册拒并指引先建课）——模板文本改写以对齐。
    version: 11, date: '2026-09-14', changeType: 'plan-only（#240 / ADR-0076 种子降职）：删 seed 半区，课程未注册即拒',
    expectedDelta: 'YAML 顶层只剩 project + plan（不再有 seed 键）；提示词立场从「一次调用双产物」变「只反推里程碑计划」，未引用节点的意图改走计划修订驱动的教练补支；已注册课程的行为不变',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 11, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  回执评审: [{
    version: 6, date: '2026-09-13', changeType: '拼装侧：契约本就在 system 提示词（全仓先例，未动）',
    expectedDelta: '无变化——该站早就是「契约离生成点最近」的形态，是本次改版的参照物',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 6, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  错误对比卡: [{
    version: 8, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: 'cards schema 从「硬约束 1」移到模板末段；卡片字段形态不变',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 8, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }],
  罗盘初画: [{
    version: 2, date: '2026-09-13', changeType: '输出契约独立成节 `## 输出` 并置尾 + 拼装侧契约后置',
    expectedDelta: '路线正文契约句从「硬约束 1」移到末段；3–7 条阶段条目与措辞纪律不变',
  }, {
    // 非模板变更（同一版本号下的第二条登记，先例见 ADR-0065 §6）：**注入面改形状**
    // （#239 / ADR-0076 锚多终点化）。模板文本一字未动，但「终点锚」材料段从单条改为
    // **逐终点多条**（每条含终点名/目标类型/声明日/选填目标描述/覆盖锚定的块工作表），
    // 「起草起点与当前图」段的起点集改为全部锚的 seed_nodes 并集（剔终点）。
    version: 2, date: '2026-09-14', changeType: '锚集合注入（#239；模板文本未动，终点锚材料段改逐终点）',
    expectedDelta: '多终点课程的初画能看到全部方向（不再只画到一个终点）；单终点课程的净变化 = 终点行多两格缩进、起点段改名。零终点课程不走此站（fail loud「先加一个终点」）',
  }, {
    // #240 / ADR-0076 第四节：罗盘按终点分节（一节一个终点、节头 - **终点名**：，
    // 不用标题），对账机器按节头切分（#231 对账语义不变）。
    version: 3, date: '2026-09-14', changeType: '按终点分节（#240 / ADR-0076）：剩余路线一节一个终点，节头 - **终点名**：',
    expectedDelta: '路线正文从单列改多节（每终点 3–7 条阶段条目）；节头带锚记录的终点名、明确禁用标题行；同节点可出现在多节（交汇常态）。单终点课程的条目形态不变、多一节头行',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 3, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式；未列出的格式面板无法渲染…）」整段（含各渲染器的写法示例与交互模拟硬性要求，数百字）；产出契约不再被一段与本站无关的格式清单覆盖。预期生成行为变化：不再出现「按菜单写 HTML/交互件」式的契约外漂移；YAML/正文/卡片的形态契约回到单一声音',
  }, {
    // #316 / ADR-0099 罗盘站升格：程度驱动重写——撤硬约束②③节点名钉扎（回声病的规则侧
    // 根因）、撤硬约束 4 块工作表（C4 裁决）、原规则 6「不罗列教科书目录」改为程度驱动口径；
    // 增可选深度档；写权归罗盘站独占（罗盘重画族见同批新增键）。
    version: 4, date: '2026-09-17', changeType: '罗盘站升格（#316 / ADR-0099）：程度驱动重写，撤节点名钉扎与工作表约束，增可选深度档',
    expectedDelta: '弧条目不再被要求含图上节点名（对账「无锚即漂移」随 #316 退役）；覆盖锚定课程的弧不再按块工作表组织；每条阶段须说得出推进程度声明的哪个维度（深度/广度/综合运用），可标（深度：知道|会用|能教）；预期增量：弧从节点回声变为终点承诺的能力面展开，专业展开不再被规训禁止；条目形态从「阶段名：为什么朝终点」变为「阶段名：推进哪个程度维度」。过门记录：check ✓；replay 报 3 件语料回归，均为教练思路/种子起草站存量漂移（与本站无关，同 v1 条目先例），已登记；compare 未做真模型对照（待合并前真实课程评审兑现）',
  }],
  罗盘重画: [{
    // #316 / ADR-0099 罗盘站两族之二：重估驱动的重画族（进度不触发；触发 = 写侧事件置
    // 「重画待办」标记或评审修版）。与初画同构，站语境不同（已有旧弧；重估不是例行）。
    version: 1, date: '2026-09-17', changeType: '新站族（#316 / ADR-0099）：罗盘重画——重估驱动的重画，与初画分键供用户分别编辑',
    expectedDelta: 'learnhub_compass_paint 在路线已画时改走本族：提示词明确「重估不是例行刷新、进度不构成重画理由、改弧不改写已学事实」；正文形态契约与初画一致。预期增量：重画产出的弧保持终点承诺展开而非进度条化；重估触发与执行归罗盘站（教练只建议）',
  }],
  思路官回合: [{
    // #273：旧「教练回合」单发三段式退场，新站首版——产物从「生长批 YAML（note/route/ops）」
    // 变为**交接计划**（零节点名零图上引用）；裁决语义保留算子集与停摆转译，粒度变焦归执行官。
    version: 1, date: '2026-09-16', changeType: '新站（#273）：思路官方向裁决——单轮零工具单发产交接计划',
    expectedDelta: '产物形状从 kind=edit 提案 YAML 变为 {operator, reason, target_endpoints, steps[intent/teaches_concept/est_hint], recheck?}——零节点名零引用，补丁归执行官草稿回路；停摆转译进算子集（operator=停摆或 steps 空）。预期增量是「方向裁决」与「粒度变焦」解耦，思路官不再持工具、不再抄节点名，幻觉面随零名字契约结构性消失。过门记录：check ✓；replay 报 3 件语料回归经对照确认为 HEAD 存量漂移（教练生长 2 件 + 种子起草 1 件，同 #282/#272 先例），非本次变更引入；compare 未做真模型对照（同 v8 先例如实登记）',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 1, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式…）」整段——它与本站「只输出一个 YAML 文档」的输出契约直接矛盾（实机语料里模型照菜单说话）。预期生成行为变化：契约外格式漂移下降，YAML 契约回到单一声音；本站并不产出正文/HTML，删掉的是纯噪声',
  }, {
    // 非模板变更（同版本号第三条登记）：**注入面新增条件性材料块**（#303 / ADR-0092；模板文本未动）。
    version: 1, date: '2026-09-16', changeType: '空图首级判据材料注入（#303 / ADR-0092；模板文本未动，注入面新增）。',
    expectedDelta: '前沿为空的回合（空图新课的第一次生长：排除终点锚后未开始节点数为零——「仅终点」是特例，删空/学完普通节点同样命中）在「终点锚」区块多一段「首级判据」材料：单一行为单元 / 零复合概念（正反例：「Python 基础语法」✗ →「装好环境并运行第一行代码」✓）/ 常识可直接起步 / 宁简勿繁 + 一句操作化反例警示（ADR-0040 原文迁家）。非空图回合的包形与现状逐字相同（条件性材料块，前沿非空不注入、不白吃 token）。预期增量：新课后第一次生长的台阶不再是复合泛称（实测疼点：零基础自述下起点写成「Python 基础语法」式复合概念，坡道第一级即断裂）。模板文本零改动（材料注入），两族经同一上下文包组装自动共享。 过门记录：check ✓（同版本号下的注入面登记不被提交级门执法——ADR-0072 §已知边界 ④，靠人审）；replay 报 3 件存量漂移（教练生长 2 件 + 种子起草 1 件，与本表 #273/#272 条目所列同一批同因），非本次变更引入；compare 未做真模型对照（同 #218 先例）——同票其余站（13 站去菜单 + 判据注入 3 站 + 重裁摘要修正 1 条，共 17 条登记）过门记录同此，见 ADR-0094',
  }, {
    // 非模板变更（同版本号第五条登记）：**注入面新增一行取值域**（#309 缺陷③ / ADR-0095；
    // 模板文本未动）。与上一条同源：两族共用同一上下文包，「登记表档位」块多一行。
    version: 1, date: '2026-09-17', changeType: '档位取值域进上下文包（#309 缺陷③ / ADR-0095；模板文本未动，注入面新增一行）',
    expectedDelta: '「登记表档位」区块**无条件**多一行「teaches / assumes 的档位取值域：知道 / 会用 / 能教（写别的值会被受理门拒收）」——旧行为下取值域只在「前沿有档位」时经示例间接可见，空课/空态批下不可见，模型自造「初识」直到受理门拒绝文案才第一次见合法值（事故实测）。预期增量：计划里的 teaches_concept 档位与批内档位取值合法率上升，因档位非法折返的轮次下降；非空图回合同样多这一行（取值域是常量，条件化会重新制造「空态不可见」）。模板文本零改动（注入面新增一行），两族经同一上下文包组装自动共享',
  }, {
    // 模板变更（v1→v2）：计划契约增 route（#310 / ADR-0092 §修订）——恢复罗盘「剩余路线」
    // 的生产者：#273 把 route 划出执行官后没交给思路官，该段冻结在最后一次初画。
    version: 2, date: '2026-09-17', changeType: '计划契约增 route：罗盘「剩余路线」恢复生产者（#310 / ADR-0092 §修订）',
    expectedDelta: '交接计划多一个 `route` 字段（块标量）：**前进/换向必写**（按终点分节、节头 `- **终点名**：`、节下 3–7 条阶段条目、未落图台阶标「（候选）」、非承诺措辞、不用 `## ` 标题），停摆/插入/巩固可省略——省略 = 不改写、保留旧稿，绝不是清空。正文随批由引擎从计划携带写入罗盘「剩余路线」段（批注区/ETA 字节保留）。预期增量：该段不再冻结在最后一次初画，方向批与路线重新同步（计划与路线同作者、同一次裁决产出，不会「计划朝终点 A、罗盘写终点 B」）；缺 route 的前进/换向计划被计划门拒收（与 apply 侧同一个 validateRouteBody，#309 那类「计划门过、apply 门拒」的洞不新开）。并顺带改口径：教练包「罗盘尾段」的占位行不再指向 `learnhub_compass_paint` 初画（那是喂给**零工具**裁决站的错指示），改指方向批会写出该段。过门记录：check ✓；replay 对 docs/research/quality-corpus-222 报 1 件「种子起草」存量漂移（该站既不在回放面也不在缺席清单——经 stash 对照确认为 HEAD 既有登记缺口，与本票变更无关；本机 vault 语料已重置，教练站无样本可回放）；compare 未做真模型对照（同 #218 先例如实登记）',
  }, {
    // 非模板变更（同版本号第二条登记）：**注入面材料改写**（#310；本站模板文本未动——
    // 首级判据块住 prompts/projects.ts 单源，两族与执行官共享）。
    version: 2, date: '2026-09-17', changeType: '首级判据块补绑终点（#310 / ADR-0092 §修订；模板文本未动，注入面材料改写）',
    expectedDelta: '前沿为空的回合，判据块从「只有上界」改为「先绑方向再选型」：① 块头点名本课程与声明终点（`{{course}}` / `{{endpoints}}` 两占位符取包内既有材料——课程名与终点锚，不新增输入面）；② 新增「朝终点可辨认」为**先决条件**（台阶 = 动作句 + 该终点方向上的对象；「拆日常事成先后步骤」「说清每一步的输入与输出」「对给定规则按步骤跑一遍」这类任何课程都能套的通用技能句明示不合格）；③ 新增「本课程词汇」（对象取自课程名与终点锚，不引入之外的领域词；动作仍须零基础常识可起步）；④ 起点资格四条（单一行为单元／零复合概念／常识可直接起步／宁简勿繁）降为「都朝终点推进的候选之间的选型标尺」；⑤ 「宁简勿繁」删绝对化句「起点过简的代价趋近零」、限定为同向候选间的选择偏好，并把原文「过繁的代价是整条坡道断裂」的反向配重改挂到两条上界上（不随绝对化句一起丢掉）；⑥ 删域外正反例（「Python 基础语法」✗ →「装好环境并运行第一行代码」✓），改为判据式说明（不收具体领域 → 无照抄范例）。预期增量：空课首级不再被判据全过、方向为零的通用句占据（实测疼点：2026-09-16「数学基础」首裁铺出拆步骤／说清输入输出／按规则执行三连，与声明终点无可辨认推进关系）。过门记录同本键 route 条目',
  }, {
    // v2（#313 C15）：**模板文本变更**——「steps 为空 = 停摆」与算子枚举自相矛盾：非停摆算子
    // 写空 steps 会被引擎静默读成停摆（返回 idle、理由丢弃），而「计划不完整」与「裁决停摆」
    // 是两件事。门同步收紧（非停摆必须给台阶），模板改为「停摆只能由 operator: 停摆 表达」；
    // 收尾朝向段的「steps 可以为空」同款改成「仍要给至少一个台阶」。
    version: 2, date: '2026-09-17', changeType: '零步语态收紧（#313 C15）：steps 空只属停摆，非停摆必须给台阶',
    expectedDelta: '停摆的表达从「operator=停摆 或 steps 空」收成唯一一种（operator: 停摆）；非停摆算子的计划必带至少一个台阶——收尾朝向（坡道已铺通的纯接线意图）也照写一个台阶。预期增量：不再出现「非停摆算子 + 空 steps」的残缺计划（此前被静默读成停摆、方向丢失且用户看不到理由），因计划不完整折返回灌的轮次下降。过门记录：check ✓（提交级门对版本 bump 与登记同提交执法）；replay 未做——离线解析面 registry 里计划站的校验面随本提交改了（空 steps 从「合法」变「拒收」），无本机语料目录可取（vault 侧生成语料路径不在仓库内），如实登记未过门，回退点 = 本提交前一版模板与校验器；compare 未做真模型对照（同 v1 先例）',
  }, {
    // #316 / ADR-0099：撤 route——罗盘「剩余路线」写权反转为罗盘站独占（learnhub_compass_paint），
    // 思路官对弧只有建议权（理由写进 reason）。计划门对携带 route 一律拒收。
    version: 3, date: '2026-09-17', changeType: '撤 route（#316 / ADR-0099）：计划契约去罗盘路线字段，写权归罗盘站',
    expectedDelta: 'YAML 输出契约删除 route: | 段与「罗盘路线（route）」整节；预期增量：思路官不再在每轮计划里顺手产弧（那是回声病的生产端之一），token 随弧正文整段省去；罗盘在初画/重估之间保持稳定（进度不再抹地图）。过门记录：check ✓；replay 报 3 件语料回归，经对照确认为 HEAD 存量漂移（教练思路 2 件 + 种子起草 1 件，与本站模板无关，同 v1 条目先例），已登记；compare 未做真模型对照（同 v1 先例）',
  }],
  思路官重裁: [{
    // #273 显式重裁族：node_skip / panel_dispatch 触发；上次裁决摘要随包回灌，可沿用可推翻。
    version: 1, date: '2026-09-16', changeType: '新站重裁族（#273）：显式重新裁决 + 上次裁决摘要注入',
    expectedDelta: '与「思路官回合」同构的交接计划契约；多出「上次裁决摘要」块（applied edit 提案的算子/理由留痕）与沿用/推翻纪律（推翻时 reason 说明）。触发点映射：node_skip / panel_dispatch 走本族，其余走常规族。过门记录：check ✓；replay 报 3 件语料回归同上（存量漂移）；compare 未做真模型对照',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 1, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式…）」整段——它与本站「只输出一个 YAML 文档」的输出契约直接矛盾（实机语料里模型照菜单说话）。预期生成行为变化：契约外格式漂移下降，YAML 契约回到单一声音；本站并不产出正文/HTML，删掉的是纯噪声',
  }, {
    // 非模板变更（同版本号第三条登记）：**注入面新增条件性材料块**（#303 / ADR-0092；模板文本未动）。
    version: 1, date: '2026-09-16', changeType: '空图首级判据材料注入（#303 / ADR-0092；模板文本未动，注入面新增）',
    expectedDelta: '前沿为空的回合（空图新课的第一次生长：排除终点锚后未开始节点数为零——「仅终点」是特例，删空/学完普通节点同样命中）在「终点锚」区块多一段「首级判据」材料：单一行为单元 / 零复合概念（正反例：「Python 基础语法」✗ →「装好环境并运行第一行代码」✓）/ 常识可直接起步 / 宁简勿繁 + 一句操作化反例警示（ADR-0040 原文迁家）。非空图回合的包形与现状逐字相同（条件性材料块，前沿非空不注入、不白吃 token）。预期增量：新课后第一次生长的台阶不再是复合泛称（实测疼点：零基础自述下起点写成「Python 基础语法」式复合概念，坡道第一级即断裂）。模板文本零改动（材料注入），两族经同一上下文包组装自动共享',
  }, {
    // 非模板变更（同版本号第四条登记）：**既有注入块的实现 bug 修复**（#303 顺带；模板文本未动）。
    version: 1, date: '2026-09-16', changeType: '上次裁决摘要块读取修正（#303；模板文本未动，注入块首次生效）',
    expectedDelta: '重裁族的「上次裁决摘要」块**首次真正出现**：旧实现把 `ProposalRec.artifact`（落盘路径）当产物原文 `YAML.parseModel`，`note` 恒 undefined ——该块自 #273 起从未注入过，`coach.plan.summary_miss` 一路 DEBUG 静默。预期增量：显式重裁（node_skip / panel_dispatch）能看到上一批的算子/理由/提案号留痕，「可沿用可推翻、推翻时说明」的纪律第一次有材料可依；无 applied 提案时该块照旧缺席（合法空态）',
  }, {
    // 非模板变更（同版本号第五条登记）：**注入面新增一行取值域**（#309 缺陷③ / ADR-0095；
    // 模板文本未动）。与思路官回合同源（同一上下文包）。
    version: 1, date: '2026-09-17', changeType: '档位取值域进上下文包（#309 缺陷③ / ADR-0095；模板文本未动，注入面新增一行）',
    expectedDelta: '「登记表档位」区块**无条件**多一行「teaches / assumes 的档位取值域：知道 / 会用 / 能教（写别的值会被受理门拒收）」。重裁族同样吃这一行：重裁时若推翻上次方向换概念面，档位取值不必再靠猜（旧行为下空态不可见）。预期增量同思路官回合条目；本族多一处用处是重裁的 teaches_concept 面不再撞档位非法',
  }, {
    // 模板变更（v1→v2）：与「思路官回合」同构地增 route（#310 / ADR-0092 §修订）。
    version: 2, date: '2026-09-17', changeType: '计划契约增 route：罗盘「剩余路线」恢复生产者（#310 / ADR-0092 §修订）',
    expectedDelta: '与「思路官回合」同构：交接计划增 `route` 块标量，前进/换向必写、其余算子可省（缺省 = 不改写旧稿）；正文随批由引擎写入罗盘「剩余路线」段。两族的**义务/形态/缺省语义**一致（措辞按站名指代各写各的——常规族说「你的方向裁决」、本族说「你的重裁」）。预期增量同常规族条目；教练包「罗盘尾段」占位行改口径（不再指向 `learnhub_compass_paint` 初画）同常规族条目。过门记录：check ✓；replay 1 件「种子起草」存量漂移（经 stash 对照确认非本次引入）；compare 未做真模型对照',
  }, {
    // 非模板变更（同版本号第二条登记）：**注入面材料改写**（#310；本站模板文本未动）。
    version: 2, date: '2026-09-17', changeType: '首级判据块补绑终点（#310 / ADR-0092 §修订；模板文本未动，注入面材料改写）',
    expectedDelta: '同「思路官回合」条目：判据块头点名课程名与声明终点，新增「朝终点可辨认（先决条件）」与「本课程词汇」两条，起点资格四条降为选型标尺，「宁简勿繁」去引信，删域外正反例。两族经同一上下文包组装自动共享。预期增量：重裁族在空图首裁情形下同样不再产出方向为零的通用技能句。过门记录同本键 route 条目',
  }, {
    // v2（#313 C15）：与「思路官回合」同款——重裁族同样不许「非停摆 + 空 steps」。
    version: 2, date: '2026-09-17', changeType: '零步语态收紧（#313 C15）：与「思路官回合」同款收紧',
    expectedDelta: '同「思路官回合」v2 条目：停摆只由 operator: 停摆 表达，非停摆算子必给台阶。本族额外语义是重裁时「上次方向不需要新台阶」也必须显式写一个台阶或改裁停摆，不再能用空 steps 含混过去。过门记录同思路官回合 v2（check ✓；replay 未做——无本机语料目录，如实登记；compare 未做真模型对照）',  }, {
    // #316 / ADR-0099：撤 route——罗盘「剩余路线」写权反转为罗盘站独占（learnhub_compass_paint），
    // 思路官对弧只有建议权（理由写进 reason）。计划门对携带 route 一律拒收。
    version: 3, date: '2026-09-17', changeType: '撤 route（#316 / ADR-0099）：计划契约去罗盘路线字段，写权归罗盘站',
    expectedDelta: 'YAML 输出契约删除 route: | 段与「罗盘路线（route）」整节；预期增量：思路官不再在每轮计划里顺手产弧（那是回声病的生产端之一），token 随弧正文整段省去；罗盘在初画/重估之间保持稳定（进度不再抹地图）。过门记录：check ✓；replay 报 3 件语料回归，经对照确认为 HEAD 存量漂移（教练思路 2 件 + 种子起草 1 件，与本站模板无关，同 v1 条目先例），已登记；compare 未做真模型对照（同 v1 先例）',
  }],
  执行官回合: [{
    version: 1, date: '2026-09-16', changeType: '新站（#271 / ADR-0088）：生长草稿执行官回合模板 v1',
    expectedDelta: '新站首版——产物从「YAML 文档」变为工具调用轨迹（draft_patch/draft_audit/draft_finish 承载）；预期增量是生长批从「一回合一批」变为「草稿内多批累积 + 按批 finish」，失败回灌改在 loop 内继续修而非恰一次重裁。与旧教练回合站并行共存（旧路径不动，退场归 #273）',
  }, {
    // 糖算子补全 + 审计 findings（#272）：模板只改两处散文（op 词汇清单、审步骤 findings 句）
    version: 2, date: '2026-09-16', changeType: '补丁纪律扩糖算子（split_node / suggest_confusable）+ 审步骤带 findings 句（#272）',
    expectedDelta: '① op 词汇清单增 split_node（拆节点：轮廓继承、消费方重排、删原节点、终点不可拆）与 suggest_confusable（易混指向，finish 后自动展开为混淆对候选提案待人审）；② 工作循环第 3 步增「非阻 findings 不拦 finish 但该修的照修」句。裁决语义、输出契约、门序列不变；引擎侧 draft_patch 白名单同步新增两糖算子。过门记录：check ✓；replay 报 3 件语料回归经 stash 对照确认为 HEAD 存量漂移（教练生长 2 件 + 种子起草 1 件，2026-09-13 语料与回放面缺席清单，同 v8/#282 先例），非本次变更引入；compare 未做真模型对照（同 v8 先例如实登记）',
  }, {
    // 非模板变更（同一版本号下的第二条登记）：**注入面删减**——渲染能力清单的旧兜底
    // （模板无 `{{renderers}}` 就末尾追加）被删（#302 ① / ADR-0094）；本站模板文本一字未动。
    version: 2, date: '2026-09-16', changeType: '渲染菜单兜底回收（#302 ① / ADR-0094；模板文本未动，注入面删减）',
    expectedDelta: '最终 prompt 末尾不再有「## 面板支持的渲染格式（只能使用下列格式…）」整段——它与本站「只输出一个 YAML 文档」的输出契约直接矛盾（实机语料里模型照菜单说话）。预期生成行为变化：契约外格式漂移下降，YAML 契约回到单一声音；本站并不产出正文/HTML，删掉的是纯噪声',
  }, {
    // 非模板变更（同版本号第三条登记）：**注入面新增条件性材料块**——执行官与思路官共用同一上下文包（#303 / ADR-0092；模板文本未动）。
    version: 2, date: '2026-09-16', changeType: '空图首级判据材料注入（#303 / ADR-0092；模板文本未动，注入面新增）',
    expectedDelta: '前沿为空的回合（空图新课的第一次生长：排除终点锚后未开始节点数为零——「仅终点」是特例，删空/学完普通节点同样命中）在「终点锚」区块多一段「首级判据」材料：单一行为单元 / 零复合概念（正反例：「Python 基础语法」✗ →「装好环境并运行第一行代码」✓）/ 常识可直接起步 / 宁简勿繁 + 一句操作化反例警示（ADR-0040 原文迁家）。非空图回合的包形与现状逐字相同（条件性材料块，前沿非空不注入、不白吃 token）。预期增量：新课后第一次生长的台阶不再是复合泛称（实测疼点：零基础自述下起点写成「Python 基础语法」式复合概念，坡道第一级即断裂）。模板文本零改动（材料注入），两族经同一上下文包组装自动共享',
  }, {
    // 非模板变更（同版本号第四条登记）：**注入面新增一行 + 工具面扩容**（#309 缺陷②③ /
    // ADR-0095；模板文本未动）。本站的模型可见面不止模板：工具清单的 description 也是写作面。
    version: 2, date: '2026-09-17', changeType: '档位取值域进工具与上下文包 + 新增写件工具 draft_revert（#309 缺陷②③ / ADR-0095；模板文本未动）',
    expectedDelta: '① 上下文包「登记表档位」块无条件多一行档位取值域（同思路官条目）；② `draft_patch` 的 `teaches`/`assumes` 字段说明带同一取值域；③ 工具清单新增第四具写件工具 `draft_revert(count?)`——丢弃最近 N 条未发布增量（省略 count = 回到水位）并随轮志留痕。预期增量：档位取值非法导致的补丁/发布折返下降（事故里 `初识` 连拒四次、毒 op 清不掉，最终零发布）；草稿卡死时的下一动作从「反复重铸」变为「撤销回水位重开一批」。模板散文仍写着「写件三工具」——本票不改模板（改散文=改提示词，另票），工具清单是模型每次调用都看的权威面',
  }, {
    // 非模板变更（同版本号第五条登记）：**工具面新增参数 + 注入面一行改写**（#312 B2 /
    // ADR-0096；模板文本未动）。与上一条同源：本站的模型可见面不止模板。
    version: 2, date: '2026-09-17', changeType: 'draft_patch 增 note_recheck + 交接块点名写法（#312 B2 / ADR-0096；模板文本未动）',
    expectedDelta: '① `draft_patch` 新增可选参数 `note_recheck`（`{metric, days?}`，取值域与 clamp 写进 description）——插入批的复诊预注册从此有写入面；② 交接块的「预注册复诊」行从「插入批落地时随批携带」改为「用 draft_patch 的 note_recheck 写这一枚（缺席时按本计划兜底）」。预期增量：思路官裁「插入」后执行官不再无路可走（此前该算子经本站结构性不可发布：受理门要预注册而本站三处都没有写入面，模型只能熔断或改标别的算子）；预注册的写法从猜变成照抄交接块那一枚',
  }, {
    // 模板变更（v2→v3）：硬约束 3 说清 route 归属（#310 / ADR-0092 §修订）。
    version: 3, date: '2026-09-17', changeType: 'route 归属说清：路线随计划由引擎携带写入（#310 / ADR-0092 §修订）',
    expectedDelta: '硬约束 3 从「route（罗盘批内重写）不归本站」改为说清归属——「剩余路线」随思路官计划重画，正文由引擎从计划携带写入，**交接块里出现路线段时也无需本站动手**。预期增量：本站提示词的「不归我」旧句与新出现的交接块路线行并读不再自相矛盾，执行官不会尝试产出路线正文（那是零 op 的引擎写入）；教练包「罗盘尾段」占位行改口径（不再指向 `learnhub_compass_paint` 初画）同两族思路官条目。过门记录：check ✓；replay 对 docs/research/quality-corpus-222 报 1 件「种子起草」存量漂移（经 stash 对照确认为 HEAD 既有登记缺口，非本次引入）；compare 未做真模型对照',
  }, {
    // 非模板变更（同版本号第二条登记）：**注入面新增路线行 + 批规格携带 route**（#310；
    // 本站模板文本未动）。
    version: 3, date: '2026-09-17', changeType: '交接块带路线行 + 批规格携带 route（#310；模板文本未动，注入面新增）',
    expectedDelta: '「思路官交接」块在计划携带 route 时多一行「罗盘路线：『剩余路线』段本次随批重画（正文由引擎从本计划携带写入，你无需为它写任何 op）；路线是草图不是承诺」；引擎侧批规格（batchSpecOf）在生长批（note 区在场）上把计划路线带进 `spec.route`，试算/门复验/发布三处同走，故路线在试算阶段就被与 apply 侧同源的路线门验过。预期增量：罗盘重写对执行官**可见但无活干**（零 op）；计划缺省 route 时不带 `spec.route`，旧稿保留（绝不清空）。过门记录同本键 v3 条目',
  }, {
    // 非模板变更（同版本号第三条登记）：**注入面材料改写**（#310；本站模板文本未动——
    // 判据块住 prompts/projects.ts 单源，与两族思路官共用同一上下文包）。
    version: 3, date: '2026-09-17', changeType: '首级判据块补绑终点（#310 / ADR-0092 §修订；模板文本未动，注入面材料改写）',
    expectedDelta: '同两族思路官条目：判据块头点名课程名与声明终点，新增「朝终点可辨认（先决条件）」与「本课程词汇」，起点资格四条降为「都朝终点推进的候选之间的选型标尺」，「宁简勿繁」去引信，删域外正反例。本站与思路官同包共享，故同一改动同时进本站最终 prompt。预期增量：执行官落第一级台阶时不再把「拆日常事成先后步骤」这类通用技能句当作合格起点（本轮实测正是执行官照计划把通用句拆细落地）。过门记录同本键 v3 条目',
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
