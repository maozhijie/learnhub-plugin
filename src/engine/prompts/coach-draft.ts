/**
 * 生长草稿形状面与回执的模型面散文（#311）：`coach/growth-draft.ts` 的
 * `PATCH_SHAPE_CHEATSHEET`、形状归一/拒收回执文案（`out.normalized` / `out.errors`）、
 * 糖算子展开错误与草稿 findings。
 *
 * 文本是惰性字符串 + `{{变量}}` 占位符，取值由 `../infra/prompt-render.ts::render` 在调用点
 * 完成（缺变量与残留占位符都抛，详见 ADR-0075）。**本文件是模型可见散文，改动走章程 §8。**
 *
 * 这些行全部会经工具回灌到模型眼前（draft_patch 拒收即整批回滚 + errors 回灌；归一动作进
 * 回执与轮志），故与提示词同口径收进 `prompts/` 单一落点。文件布局说明：执行官站的正身散文
 * （工具描述/状态块/交接块/回执）住同名族 `coach-exec.ts`，本文件专收草稿**形状面**。
 */

// ---------------------------------------------------------------- 形状速查（PATCH_SHAPE_CHEATSHEET）

export const PATCH_SHAPE_CHEATSHEET = [
  '合法形态速查（三件套）：',
  '  · teaches / assumes：{概念: 档}（配对列表 [[概念, 档], …] 也收）',
  '  · misconceptions：[{concept: 在册概念名, model: 错误模型文字}]（按概念归组的字典 {概念: [文字…]} 也收；**字符串列表不收**——拆不出概念）',
  '  · concepts（铸名）：[{canonical: 名字, definition?, aliases?}]（字符串「名字」、{name: 名字}、字典 {名字: 定义} 也收）',
].join('\n')

/** 收到形态的人话名（`shapeWordOf`；让模型认得出自己写了什么）。 */
export const SHAPE_WORD_STRING_LIST = '字符串列表'
export const SHAPE_WORD_LIST = '列表'
export const SHAPE_WORD_NULL = 'null'
export const SHAPE_WORD_MAP = '字典'
export const SHAPE_WORD_STRING = '字符串'
export const SHAPE_WORD_NUMBER = '数字'
export const SHAPE_WORD_BOOLEAN = '布尔'

// ---------------------------------------------------------------- teaches/assumes 归一（tierMapFieldOf）

export const SHAPE_ERR_TIER_MAP = '{{where}}: 必须是「概念→档」映射（{概念: 档}）——收到 {{shape}}'
export const SHAPE_ERR_PAIR_ITEM = '{{where}}: 配对列表的每一项都要是 [概念, 档] 二元组——第 {{index}} 项是 {{value}}；不用配对列表就写映射 {概念: 档}'
export const SHAPE_ERR_PAIR_EMPTY = '{{where}}: 配对列表的每一项都要有概念名与档——第 {{index}} 项是 {{value}}'
export const SHAPE_NORM_TIER_PAIR = '{{where}} 配对列表 → 概念→档映射（{{count}} 条）'

// ---------------------------------------------------------------- misconceptions 归一（misconceptionsFieldOf）

export const SHAPE_ERR_MIS_STRING_LIST = '{{where}}: 误解必须是条目列表 [{concept, model}]——收到字符串列表（一条字符串拆不出它属于哪个概念）：每条写成 {concept: 在册概念名, model: 错误模型文字}；按概念归组也可写字典 {概念: [文字…]}'
export const SHAPE_ERR_MIS_ITEM_MAP = '{{where}}: 误解条目第 {{index}} 项必须是映射 {concept, model}——收到 {{shape}}'
export const SHAPE_ERR_MIS_ITEM_UNKNOWN = '{{where}}: 误解条目第 {{index}} 项含未知字段 {{fields}}（条目只允许 concept/model——典型错答文字写进 model）'
export const SHAPE_ERR_MIS_ITEM_NO_CONCEPT = '{{where}}: 误解条目第 {{index}} 项缺 concept（在册概念名）'
export const SHAPE_ERR_MIS_ITEM_NO_MODEL = '{{where}}: 误解条目第 {{index}} 项缺 model（错误模型文字：典型错答、坑位用途）'
export const SHAPE_ERR_MIS_DICT_EMPTY_CONCEPT = '{{where}}: 误解字典的概念名不能为空'
export const SHAPE_ERR_MIS_DICT_VALUE = '{{where}}: 字典形的值必须是文本或文本列表（概念名 → 该项文字）——「{{concept}}」的值是 {{shape}}'
export const SHAPE_ERR_MIS_DICT_EMPTY = '{{where}}: 误解字典是空的（本字段省略即可）'
export const SHAPE_NORM_MIS_DICT = '{{where}} 字典 → 条目数组（{{concepts}} 概念 / {{entries}} 条）'
export const SHAPE_ERR_MIS_SHAPE = '{{where}}: 误解必须是条目列表 [{concept, model}]——收到 {{shape}}'
export const SHAPE_NORM_MIS_BARE = '{{where}}.misconceptions 裸字符串列表 → 归属本节点唯一 teaches 概念「{{concept}}」（{{count}} 条）'

// ---------------------------------------------------------------- 铸名归一（mintEntriesOf / mintBlockOf）

export const SHAPE_ERR_MINT_EMPTY = '{{where}}: 铸名不能是空字符串'
export const SHAPE_NORM_MINT_STRING = '{{where}} 字符串 → 铸名条目「{{canonical}}」'
export const SHAPE_ERR_MINT_LIST = '{{where}}: 每条铸名是一个条目（{canonical, …} 或字符串），不是列表'
export const SHAPE_ERR_MINT_SHAPE = '{{where}}: 铸名必须是条目（{canonical, aliases?, definition?}）或字符串——收到 {{shape}}'
export const SHAPE_NORM_MINT_NAME_KEY = '{{where}} {name} → {canonical: {{canonical}}}'
export const SHAPE_NORM_MINT_DICT = '{{where}} 字典（{{keys}} 键）→ {{keys}} 枚铸名（键=名字、值=定义）'
export const SHAPE_ERR_MINT_DICT = '{{where}}: 铸名必须是条目（{canonical, aliases?, definition?}）或字符串——收到字典（键 {{keys}} 既不含 canonical/name，也不是「名字→定义」的字符串映射）'
export const SHAPE_NORM_MINT_NOT_LIST = 'concepts 不是列表（{{shape}}）→ 按单条铸名收下'

// ---------------------------------------------------------------- 糖算子展开错误（expandPatchOps）

export const OP_ERR_CONFUSABLE_FIELDS = '{{where}}: suggest_confusable 需要 name（本批铸名的新概念）与 with（易混对端）两个字段。'
export const OP_ERR_CONFUSABLE_SAME = '{{where}}: suggest_confusable 两端同名「{{concept}}」——易混指向需要两个不同概念。'
export const OP_ERR_SPLIT_NO_NODE = '{{where}}: split_node 缺 node（被拆节点的名字）。'
export const OP_ERR_SPLIT_ENDPOINT = '{{where}}: split_node 拒绝——「{{node}}」是锚定的终点（终点不可拆分；拆含 del_node，锚保护必拒）。'
export const OP_ERR_SPLIT_MISSING = '{{where}}: split_node 的 node 不存在: {{node}}（逐字来自 graph_view）。'
export const OP_ERR_SPLIT_MIN = '{{where}}: split_node 的 into 至少 2 个新名（拆一份请直接 rename）。'
export const OP_ERR_SPLIT_DUP = '{{where}}: split_node 的 into 含重名。'
export const OP_ERR_CHAIN_MIN = '{{where}}: insert_prereq_chain 的 chain 至少 2 条（一条不成链；单节点直接用 add_node）。'
export const OP_ERR_CHAIN_PRE_LIST = '{{where}}: insert_prereq_chain 的 pre 必须是列表（链首的前置节点名列表；收到 {{shape}}）——零前置写 pre: [] 或省略本字段。'

// ---------------------------------------------------------------- 草稿审计 findings（draftFindings）

export const FIND_CONFUSABLE_DANGLING = 'confusable 悬空指向：建议「{{concept}}」↔「{{with}}」的目标不在册——候选提案只收在册概念，先补登记或改指向'
export const FIND_ORPHAN_MINT = '孤立新铸概念：「{{concept}}」零 teaches / 零 assumes / 零 invokes——概念表不只是名词堆，铸名须有节点真的教它或假设它'
export const FIND_NEAR_NAME = '近似名撞车：铸名「{{name}}」与在册名字「{{existing}}」过近（相似度 {{similarity}}）——同一个概念就引用既有名字，确实是另一个概念请在 note.reason 里写明区别'
export const FIND_SEAL_TODO = '终点 {{endpoint}} 已铺通待收尾——收尾须纯 set_pre 独立批发布'
