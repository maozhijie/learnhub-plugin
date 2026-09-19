/**
 * 教练执行站的模型面散文（#311）：`coach/growth-subsystem.ts` 的写件工具描述与参数说明、
 * 「草稿状态」块、合法取值域回灌与草稿差异行、写件工具的回执与拒收回灌。
 *
 * 文本是惰性字符串 + `{{变量}}` 占位符，取值由 `../infra/prompt-render.ts::render` 在调用点
 * 完成（缺变量与残留占位符都抛，详见 ADR-0075）。**本文件是模型可见散文，改动走章程 §8。**
 *
 * 这些行全部经工具通道回灌到模型眼前（写件工具的成功回执即下一轮上下文、门拒收即 errors
 * 回灌、轮志摘要随草稿状态块注入续建会话），故与提示词同口径收进 `prompts/` 单一落点。
 * 只读工具的**草稿口径** description 住同名族 `coach-tools.ts`（两口径共用常量）。
 */

// ---------------------------------------------------------------- 写件工具的 op 参数说明（draft_patch 的 opFields）

export const EXEC_OP_FIELD_OP = '原子操作：add_node / del_node / set_pre / set_enc / rename / set_note；糖算子 insert_prereq_chain / split_node / suggest_confusable（见下）'
export const EXEC_OP_FIELD_INTO = 'split_node 的拆分新名（≥2 个，轮廓继承被拆节点；终点不可拆）'
export const EXEC_OP_FIELD_WITH = 'suggest_confusable 的易混对端（须是在册概念或随批铸名）'
export const EXEC_OP_FIELD_NAME = 'add_node 的新节点名'
export const EXEC_OP_FIELD_NODE = '引用既有节点的名字（add_node 以外的 op 用）'
export const EXEC_OP_FIELD_PRE = '前置节点名列表（add_node / set_pre；set_pre 是整体替换语义）'
export const EXEC_OP_FIELD_ENC = 'set_enc 整体替换的成分技能边'
export const EXEC_OP_FIELD_NEW = 'rename 的新名'
export const EXEC_OP_FIELD_NOTE = '节点一句话说明'
export const EXEC_OP_FIELD_EST = '预估分钟（add_node）'
export const EXEC_OP_FIELD_BLOOM = '认知层级（add_node）'
export const EXEC_OP_FIELD_DIFFICULTY = '难度 1–5（add_node）'
export const EXEC_OP_FIELD_TEACHES = '概念→档（add_node 出生层；非 practice、非终点的 add_node 必带至少 1 条，缺席受理门拒收。概念必须逐字在册或随批铸名。**档位取值域：{{tiers}}**）'
export const EXEC_OP_FIELD_ASSUMES = '概念→档（add_node 出生层。**档位取值域：{{tiers}}**）'
export const EXEC_OP_FIELD_MISCONCEPTIONS = '误解条目（add_node 出生层）'
export const EXEC_OP_FIELD_OPERATOR = '生长算子（add_node 必填；**取值域：{{ops}}**；批内可跨算子混合——它声明这一条以什么方式长：接线义务归新增条目、复诊结算归插入条目、收束声明归 consolidate）'
export const EXEC_OP_FIELD_RECHECK = '复诊预注册 {metric, days?}（**operator=插入 的条目必填**，其余算子不得携带）——插入边的到期结算零人审，没有预注册就没有结算判据。'

// ---------------------------------------------------------------- 写件工具 description

export const EXEC_TOOL_DRAFT_PATCH_DESC = '批量补丁（写件）：把一组 EditOp 原子操作追加进生长草稿（每批 ≤24 条未发布增量；失败整批回滚并回灌 errors + 合法取值域）。糖算子——insert_prereq_chain：chain 按序展开成线性 add_node 链；split_node：把既有节点拆成 into 多个（轮廓继承 + 消费方 set_pre 重排 + 删原节点；终点不可拆）；suggest_confusable：给随批铸名的新概念顺手登记易混指向（不是图 op；finish 发布成功后展开为混淆对候选提案，人审后才入册）。op 词汇不含 move 与 region/block（已退役 ）。'
export const EXEC_TOOL_DRAFT_AUDIT_DESC = '审计（写件，只读效果）：对草稿图 + 未发布增量跑与受理门同一套校验（草稿通过 = 门通过），返回门错误与草稿差异；另附非阻 findings（限本会话新铸概念的孤立/悬空/近似名撞车 + 终点收尾提示 + 隐性前提对照：本批节点名、note 与铸名概念 definition 中出现、却既不在任何 teaches/assumes 也未随批铸名的领域术语，逐个列入 findings，落实动作是补前置台阶接线、回连在册概念或显式声明首引——不拦 finish，但该修的照修）。finish 前先 audit。'
export const EXEC_TOOL_DRAFT_FINISH_DESC = '按批发布（写件）：把自上次发布以来的未发布增量硬化为生长批提案 → 受理门 → apply。基图漂移（外部改了图）或门复验未过 = 拒收零落盘、错误回灌继续修。收尾（终点坡道铺通）须以零 add_node 的纯 set_pre 独立批 finish。'
export const EXEC_TOOL_DRAFT_REVERT_DESC = '撤销（写件）：丢弃最近 N 条未发布增量（省略 count = 丢弃本批全部未发布增量，回到水位）。给「草稿里卡着修不掉的坏增量」留一条路——追加式草稿删不掉已入草稿的 op，del_node 重铸也改不动它；撤销后本批作废（连本批 note / 铸名 / confusable 建议一并清），已发布段（水位以下）不可动。'
export const EXEC_TOOL_DRAFT_REVERT_COUNT_DESC = '丢弃最近多少条未发布增量（正整数；省略 = 全部丢弃）'
export const EXEC_TOOL_DRAFT_NOTE_DESC = '停摆收束（写件，零操作）：本回合不长结构时用它声明理由——零操作 + 给理由，草稿形状不变。弧建议（serves_arc / repaint_suggest）不在本工具上，改走 draft_arc。'
export const EXEC_TOOL_DRAFT_ARC_DESC = '弧建议（写件，零操作）：声明本回合对罗盘弧的建议——serves_arc（本批服务弧的哪一阶段，只是给罗盘站的参考信息，拿不准归属就不写）与 repaint_suggest（结构性重画建议，只允许结构性事由）。只有建议权（弧的写权在罗盘站）；完全可选且应当少用——只在确有结构性建议时才调，拿不准就不调，不要为凑建议而调。'

// ---------------------------------------------------------------- draft_patch 参数说明

export const EXEC_PARAM_OPS_DESC = '补丁操作列表。{{cheatsheet}}（第一次调用前即可见——形状不合法整批拒收，别拿调用去试。）'
export const EXEC_PARAM_CHAIN_DESC = 'insert_prereq_chain 的链条目（按序线性串联）'
export const EXEC_PARAM_CONCEPTS_DESC = '随批铸名（本批新引入的概念；已能用就不铸；铸名须原子，一名只指一个可独立教学的对象）'
export const EXEC_PARAM_NOTE_REASON_DESC = '本批理由一句话（下次 finish 硬化为 note.reason）'
export const EXEC_PARAM_NOTE_TARGET_ENDPOINTS_DESC = '批含前进/换向条目时的朝向声明（朝哪些终点长；与接线义务配套）'
export const EXEC_PARAM_METRIC_DESC = '可机判结局指标：{{metrics}}'
export const EXEC_PARAM_DAYS_DESC = '复诊期学习日数（缺省 {{default}}，越界 clamp 到 [{{min}},{{max}}]）'

// ---------------------------------------------------------------- 草稿状态块

export const EXEC_STATUS_HEADING = '## 草稿状态（会话 {{session}}{{resumed}}；水位 {{published}}/{{total}}）'
export const EXEC_STATUS_RESUMED = '，续建'
export const EXEC_STATUS_NEW = '，新建'
export const EXEC_STATUS_COUNTS = '- 未发布增量 {{unpublished}} 条；铸名缓存 {{mints}} 条'
export const EXEC_STATUS_NOTE = '- 本批理由：{{reason}}'
export const EXEC_STATUS_ROUNDS_HEADING = '- 轮次日志（尾部 8 条）：'
export const EXEC_STATUS_ROUND_LINE = '  - [{{kind}}] {{summary}}{{errors}}'
export const EXEC_STATUS_ROUND_ERRORS = '（✗ {{count}} 个错误）'

// ---------------------------------------------------------------- draft_note / draft_arc 参数（单站回路的零操作声明）

export const EXEC_PARAM_HALT_REASON_DESC = '本回合不长结构的理由（一句话；停摆收束必填）'
export const EXEC_PARAM_SERVES_ARC_DESC = '本批服务弧的阶段标题（照抄罗盘「剩余路线」的阶段标题原文，不是节点名；确知才写，不确定就省略）'
export const EXEC_PARAM_REPAINT_DESC = '结构性重画建议：{reason_class, note?}——reason_class ∈ {{reasons}}（读数信号不构成重画理由）'
export const EXEC_PARAM_REPAINT_NOTE_DESC = '重画建议的一句话说明'

// ---------------------------------------------------------------- 合法取值域回灌（domainsHint）

export const EXEC_DOMAIN_TIERS = '档位取值域（teaches / assumes 的值）：{{tiers}}'
export const EXEC_DOMAIN_OPS = 'op 词汇：{{ops}}（糖算子 insert_prereq_chain / split_node / suggest_confusable；move 与 region/block 已退役）'
export const EXEC_DOMAIN_NODES = '节点取值域（草稿图逐字）：{{names}}{{more}}'
export const EXEC_DOMAIN_NODES_MORE = ' …'
export const EXEC_DOMAIN_CONCEPTS = '概念取值域（在册 canonical）：{{list}}'
export const EXEC_DOMAIN_CONCEPTS_EMPTY = '（空册——随批 concepts 铸名）'

// ---------------------------------------------------------------- 草稿差异行（renderDiff）

export const EXEC_DIFF_ADDED_NODES = '新增节点 {{count}}：{{list}}'
export const EXEC_DIFF_REMOVED_NODES = '删除节点 {{count}}：{{list}}'
export const EXEC_DIFF_RENAMED = '改名 {{count}}：{{list}}'
export const EXEC_DIFF_RENAMED_ITEM = '{{from}}→{{to}}'
export const EXEC_DIFF_ADDED_EDGES = '新增边 {{count}}：{{list}}'
export const EXEC_DIFF_ADDED_EDGE_ITEM = '{{node}} ← {{pre}}'
export const EXEC_DIFF_REWIRED = '接线改写 {{count}}：{{list}}'
export const EXEC_DIFF_REWIRED_ITEM = '{{node}}（{{before}} → {{after}}）'
export const EXEC_DIFF_NONE = '（无）'
export const EXEC_DIFF_EMPTY_SET = '∅'

// ---------------------------------------------------------------- 轮志摘要与崩溃标签

export const EXEC_CRASH_PATCH = '补丁崩溃'
export const EXEC_CRASH_AUDIT = '审计崩溃'
export const EXEC_CRASH_FINISH = 'finish 崩溃'
export const EXEC_CRASH_NOTE = 'note 崩溃'
export const EXEC_CRASH_ARC = '弧建议崩溃'
export const EXEC_CRASH_REVERT = '撤销崩溃'
export const EXEC_CRASH_SUMMARY = '{{label}}（{{head}}）'
export const EXEC_ROUND_PATCH_BUDGET = '补丁被拒（轮次预算耗尽，{{rounds}}/{{max}}）'
export const EXEC_ROUND_PATCH_SHAPE = '补丁被拒（形状不合法 {{count}} 处；整批回滚）'
export const EXEC_ROUND_PATCH_REJECTED = '补丁被拒（{{count}} 条）'
export const EXEC_ROUND_PATCH_OK = '补丁 {{count}} 条（未发布 {{unpublished}}）{{norm}}'
export const EXEC_ROUND_PATCH_OK_NORM = '；形状归一 {{count}} 处'
export const EXEC_ROUND_AUDIT_EMPTY = '审计：空草稿（零未发布增量）——无事可做'
export const EXEC_ROUND_AUDIT_ERRORS = '审计：{{count}} 个门错误'
export const EXEC_ROUND_AUDIT_FINDINGS = '审计：通过（{{count}} 条 findings）'
export const EXEC_ROUND_AUDIT_OK = '审计：通过'
export const EXEC_ROUND_REVERT = '撤销 {{count}} 条未发布增量（余 {{rest}} 条）'
export const EXEC_ROUND_FINISH_REJECT = 'finish 被拒（{{count}} 个门错误；零落盘）'
export const EXEC_ROUND_FINISH_PROPOSE_REJECT = 'propose 被拒（零落盘）'
export const EXEC_ROUND_FINISH_APPLY_FAIL = 'apply 失败（提案 #{{id}} 已自清）'
export const EXEC_ROUND_FINISH_OK = '发布成功：提案 #{{id}}，快照 v{{snapshot}}，ops {{ops}}{{sealed}}{{confusable}}'
export const EXEC_ROUND_FINISH_SEALED = '；sealed：{{effects}}'
export const EXEC_ROUND_FINISH_CONFUSABLE = '；{{count}} 条 confusable 建议'
export const EXEC_ROUND_NOTE = '停摆收束（零操作）：{{reason}}'
export const EXEC_ROUND_ARC = '弧建议声明（零操作）：{{summary}}'
export const EXEC_ROUND_ARC_SERVES = 'serves_arc「{{value}}」'
export const EXEC_ROUND_ARC_REPAINT = 'repaint_suggest「{{value}}」'

// ---------------------------------------------------------------- 写件工具回执与拒收回灌

export const EXEC_ERR_ITEM = '  ✗ {{error}}'
export const EXEC_FINDING_ITEM = '  ⚠ {{finding}}'
export const EXEC_NORM_ITEM = '  · {{norm}}'

export const ERR_PATCH_BUDGET = '[draft_patch] 本会话轮次预算耗尽（{{rounds}}/{{max}} 轮）——不再接受追加；本批已有 {{unpublished}} 条未发布增量：可 draft_audit 后 draft_finish 发布它们、draft_revert 撤掉卡住的增量，或取消本会话草稿重开一批（agent 工具 learnhub_coach_draft_cancel / 宿主 API POST /coach/draft/cancel）。'
export const ERR_STEP_NODE_CAP = '[draft_patch] 「生长一步」会话累计新增节点已达上限（已 {{count}} + 本批 {{batch}} > {{cap}}）——一步是一步：先 draft_finish 发布已备内容，剩余缺口下回合再来。'
export const ERR_PATCH_EMPTY_OPS = '[draft_patch] ops 不能为空——不产结构就不要调本工具。'
export const ERR_PATCH_SHAPE = '[draft_patch] 形状未过（整批回滚，零落草稿）：\n{{errors}}\n{{cheatsheet}}'
export const ERR_PATCH_MAX_OPS = '[draft_patch] 每批未发布增量 ≤{{max}} 条（本补丁后将为 {{count}}）——先 draft_finish 发布再开新批。'
export const ERR_PATCH_GATE = '[draft_patch] 补丁未过受理门同一套校验（整批回滚，零草稿）：\n{{errors}}\n合法取值域：\n  · {{domains}}'

export const RECEIPT_PATCH = '已入草稿：本补丁 {{count}} 条；未发布增量 {{unpublished}} 条（水位 {{published}}/{{total}}）。{{norm}}\n先 draft_audit 再 draft_finish。'
export const RECEIPT_PATCH_NORM = '\n形状归一 {{count}} 处（已按发布形态收下）：\n{{lines}}'

export const RECEIPT_AUDIT_EMPTY = '没有未发布增量——本会话无事可做（可直接收束：已发布段无需 audit/finish；要长新内容就 draft_patch 开新批）。'
export const RECEIPT_AUDIT_FAIL = '审计未过（与受理门同一套校验，草稿通过 = 门通过）：\n{{errors}}\n合法取值域：\n  · {{domains}}\n草稿差异：\n{{diff}}'
export const RECEIPT_AUDIT_OK = '审计通过（草稿通过 = 门通过）。草稿差异：\n{{diff}}'
export const RECEIPT_AUDIT_FINDINGS = '\n审计 findings（非阻 {{count}} 条；不拦 finish，该修的照修）：\n{{lines}}'
export const RECEIPT_AUDIT_FINDINGS_NONE = '\n审计 findings：无'
export const RECEIPT_AUDIT_NEXT_READY = '\n未发布增量 {{count}} 条——可 draft_finish。'
export const RECEIPT_AUDIT_NEXT_NONE = '\n未发布增量 0 条——不可 finish，先用 draft_patch 补一批。'

export const ERR_REVERT_NOTHING = '[draft_revert] 没有未发布增量可撤——已发布段（水位以下）不可动。'
export const ERR_REVERT_COUNT_INT = '[draft_revert] count 必须是正整数（省略 = 丢弃全部未发布增量；收到 {{value}}）。'
export const ERR_REVERT_COUNT_MAX = '[draft_revert] count={{count}} 超过未发布增量 {{total}} 条（省略 count 即全部丢弃）。'
export const RECEIPT_REVERT = '已撤销 {{count}} 条未发布增量：{{list}}。'
export const RECEIPT_REVERT_WATERMARK = '\n水位 {{published}}/{{total}}；未发布增量 {{unpublished}} 条。'
export const RECEIPT_REVERT_RESIDUAL = '\n剩余未发布段重放：{{body}}'
export const RECEIPT_REVERT_RESIDUAL_OK = '通过（结构面）'
export const RECEIPT_REVERT_NEXT_RESUME = '\n可继续 draft_patch 或 draft_audit。'
export const RECEIPT_REVERT_NEXT_CLEAR = '\n本批已清空——用 draft_patch 重开一批。'

export const ERR_NOTE_NO_REASON = '[draft_note] 缺理由——停摆收束必须给一句话说明本回合为什么不长结构。'
export const ERR_ARC_EMPTY = '[draft_arc] 空声明——serves_arc 与 repaint_suggest 至少给一件（什么都不声明就不要调本工具）。'
export const ERR_SERVES_ARC_SHAPE = 'serves_arc 非空时必须是阶段标题（照抄罗盘「剩余路线」的阶段标题原文，不是节点名）。'
export const ERR_REPAINT_REASON = 'repaint_suggest.reason_class 非法：{{value}}（只允许结构性事由：{{reasons}}——读数信号不构成重画理由）。'
export const ERR_REPAINT_NOTE = 'repaint_suggest.note 非空时必须是一句话说明。'
export const RECEIPT_NOTE = '已声明本回合不长结构（零操作收束）：{{reason}}。可直接收束，或继续 draft_patch 开新批。'
export const RECEIPT_ARC = '已声明弧建议（零操作）：{{summary}}。可继续 draft_patch 开新批，或直接收束。'

export const ERR_FINISH_NO_NOTE = '[draft_finish] 缺本批理由——先用 draft_patch 的 note_reason 声明本批理由（算子随每条 add_node 的 operator 声明）。'
export const ERR_FINISH_EMPTY = '[draft_finish] 没有未发布增量——先 draft_patch 再 finish。'
export const ERR_FINISH_DRIFT_EXCEPTION = '门复验内部异常（非门拒绝——本批 ops/概念块含引擎无法解析的字段形状）：{{msg}}\n{{cheatsheet}}'
export const ERR_FINISH_GATE = '[draft_finish] 门复验未过（拒收零落盘，草稿保留——修正后重试）：\n{{errors}}'
export const ERR_FINISH_PROPOSE = '[draft_finish] 受理门拒收（零落盘，草稿保留）：\n{{msg}}'
export const ERR_FINISH_APPLY = '[draft_finish] apply 失败（提案已拒绝清场，草稿保留）：\n{{msg}}'
export const REJECT_FINISH_APPLY = '生长草稿 finish 自动 apply 失败：{{msg}}'
export const EXEC_CONFUSABLE_CANDIDATE = 'confusable 候选提案 #{{id}}：「{{a}}」→「{{b}}」待人审'
export const EXEC_CONFUSABLE_FAIL = 'confusable 建议未展开（「{{concept}}」↔「{{with}}」）：{{msg}}'
export const RECEIPT_FINISH = '发布成功：提案 #{{id}} 已 apply（快照 v{{snapshot}}）；水位前移至 {{published}}/{{total}}。{{sealed}}{{confusable}}'
export const RECEIPT_FINISH_SEALED = '收尾宣告：{{effects}}。'
export const ERR_EXEC_WHITELIST = '白名单外工具「{{name}}」被拒：写件只有 draft_patch / draft_audit / draft_finish / draft_revert / draft_note / draft_arc。'

export const ERR_DRAFT_BUDGET_EXHAUSTED = '[coach-draft] 轮次预算已耗尽（{{rounds}}/{{max}} 轮）、本批仍有 {{unpublished}} 条未发布增量未发布成功——真出口：修好门错误后 finish、draft_revert 撤掉卡住的增量重开一批，或取消本会话草稿（agent 工具 learnhub_coach_draft_cancel / 宿主 API POST /coach/draft/cancel）。'
export const ERR_DRAFT_UNFINISHED = '[coach-draft] 回路收束但草稿仍有 {{unpublished}} 条未发布增量且未成功 finish（禁止空手结束）——草稿已保留（会话 {{session}}），续建或显式取消（agent 工具 learnhub_coach_draft_cancel / 宿主 API POST /coach/draft/cancel）。'
export const ERR_DRAFT_COURSE_MISMATCH = '[coach-draft] 在途草稿属于课程「{{draftCourse}}」，与「{{course}}」不符——同课程单份在途，先取消或完成它。'
