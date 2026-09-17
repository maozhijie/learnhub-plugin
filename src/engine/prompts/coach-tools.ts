/**
 * 教练只读工具面与视图骨架的模型面散文（#311）：`coach/coach-tools.ts` 的只读工具
 * description/参数说明，与各视图的输出骨架行（行前缀与提示句）。
 *
 * 文本是惰性字符串 + `{{变量}}` 占位符，取值由 `../infra/prompt-render.ts::render` 在
 * 调用点完成（缺变量与残留占位符都抛，详见 ADR-0075）。**本文件是模型可见散文，改动走章程 §8。**
 *
 * 为什么收在这里（#311 用户裁决）：模型读到的散文此前一半散在各站拼装函数里，改一句措辞
 * 要跨文件找；集中到 `prompts/` 后提示词手调只有一个落点。同批的还有 `coach-pack.ts`
 * （上下文包骨架）与 `coach-exec.ts`（教练执行站：写件描述/草稿状态块/回执）。
 *
 * 两口径共用：只读工具在**活图**（`coachToolSpecs`）与**草稿**（`growth-subsystem` 的
 * 教练执行读件九件）两处登记——旧实现两处各写一份，同源常量收在此处（口径不同者给显式两名）。
 */

// ---------------------------------------------------------------- 只读工具 description（活图口径）

export const TOOL_GRAPH_VIEW_DESC_LIVE = '当前课程图面：全部节点名单 + 前沿/在学节点细节行（深度/pre/teaches/est/正文态）与概念组读数表。裁决 ops 的节点名与 pre 引用的取值域——产出裁决前先来这里对表。'
export const TOOL_NODE_CARD_DESC_LIVE = '单节点结构档：深度、阶段、pre/teaches/assumes、est、下游消费、误解先验。'
export const TOOL_CONCEPT_FOOTPRINT_DESC_LIVE = '概念足迹（双职责）：① 词条档 canonical/别名/定义/confusable（teaches/assumes/concepts 铸名对表的唯一权威）；② 足迹——哪些节点 teaches/assumes 它、题目 invokes 分布、confusable 指向，以及插入挂点判读（足迹非空 = 天然挂点）。query 是**子串发现**不是存在性判定：无命中时**空 ≠ 不存在**——换宽词再试，或不带 query 读全表逐条对照；写侧提案的概念引用仍须逐字命中在册名字。'
export const TOOL_BEHAVIOR_DIGEST_DESC = '行为摘要五件套（窗口=最近 7 学习日或 10 节取大）：掌握轨迹/卡点集中度/速度校准/误解活跃度/保留率。'
export const TOOL_BANK_OVERVIEW_DESC = '题库概况：逐节点在库/归档/invokes 标注题数。巩固批与出题现势参照。'
export const TOOL_COMPASS_READ_DESC = '罗盘现势：终点集合/剩余路线 + 学习者批注（软输入，提议非指令）+ 沙盘 ETA。'
export const TOOL_ENDPOINT_ANCHOR_DESC_LIVE = '终点锚集合：逐终点的终点节点/目标类型/声明日/块工作表核销进度/收尾宣告。'
export const TOOL_UPSTREAM_DAG_DESC_LIVE = '上游图摘要：给定节点的前置传递闭包全拓扑（逐条带深度/阶段/掌握度/到期/est，⚠ = 弱掌握或到期积压）+ 闭包内 pre 邻接表 + 超 cap 溢出行。深链诊断「七步之前的地基」一次可见，取代逐跳 node_card。'
export const TOOL_SUBGRAPH_DESC_LIVE = '下游子图：给定节点的**下游传递闭包**全拓扑（谁消费它、影响面到哪——逐条带深度/阶段/掌握度/到期/est，⚠ = 弱掌握或到期积压）+ 子图内 pre 邻接表 + 超 cap 溢出行。插入/旁支/删改前的下游影响面自查，与 upstream_dag（上游）互为对边；一跳上游看 node_card，深链地基看 upstream_dag。'

// ---------------------------------------------------------------- 只读工具 description（草稿口径）

export const TOOL_GRAPH_VIEW_DESC_DRAFT = '当前草稿图面（基图 + 草稿增量已叠加）：全部节点名单 + 细节行。patch 的节点名与 pre 引用的取值域——出补丁前先来这里对表。'
export const TOOL_NODE_CARD_DESC_DRAFT = '单节点结构档（草稿图口径）：阶段、pre/teaches/assumes、下游消费、误解先验。'
export const TOOL_CONCEPT_FOOTPRINT_DESC_DRAFT = '概念足迹：teaches/assumes/误解 引用对表的唯一权威（写侧恒精确——引用必须逐字命中在册名字或随批 concepts 铸名）。query 是子串发现不是存在性判定：空 ≠ 不存在。'
export const TOOL_UPSTREAM_DAG_DESC_DRAFT = '上游图摘要：给定节点的前置传递闭包全拓扑 + 闭包内 pre 邻接。接线定位与深链诊断用。'
export const TOOL_SUBGRAPH_DESC_DRAFT = '下游子图：给定节点的下游传递闭包全拓扑 + 子图内 pre 邻接。插入/旁支挂点与下游影响面自查用——别把新台阶插到会挡别人路的地方。'
export const TOOL_ENDPOINT_ANCHOR_DESC_DRAFT = '终点锚集合：逐终点的目标类型/声明日/收尾宣告。set_pre 接线的靶在这里对表（终点只可被 set_pre 接线，禁出现在 add_node 的 pre）。'

// ---------------------------------------------------------------- 只读工具参数说明

export const TOOL_PARAM_NODE_DESC = '节点名（逐字，来自 graph_view）'
/** 草稿口径的 `upstream_dag` 用短名（活图口径带出处）。 */
export const TOOL_PARAM_NODE_DESC_BARE = '节点名（逐字）'
export const TOOL_PARAM_QUERY_DESC_LIVE = '可选子串（命中 canonical 或别名）；省略 = 读全表'
export const TOOL_PARAM_QUERY_DESC_DRAFT = '可选子串；省略 = 读全表'

// ---------------------------------------------------------------- 工具执行器回灌文案（模型可见）

export const TOOL_EXEC_BAD_ARGS = '工具「{{name}}」参数不是合法 JSON：{{raw}}'
export const TOOL_EXEC_NODE_REQUIRED = '{{tool}} 需要 node 参数（逐字节点名）。'
export const TOOL_EXEC_READONLY_REJECT = '白名单外工具「{{name}}」被拒：教练工具面只有只读视图（{{names}}），写路径走提案→受理门→apply。'

// ---------------------------------------------------------------- 节点阶段标签（逐节点行/节点卡共用）

export const STAGE_LABEL_LEARNING = '在学'
export const STAGE_LABEL_MASTERED = '已掌握'
export const STAGE_LABEL_REVIEW = '复习中'
export const STAGE_LABEL_UNSEEN_READY = '未开始·正文已生成'
export const STAGE_LABEL_UNSEEN_TODO = '未开始·待生成'

// ---------------------------------------------------------------- 全图摘要（graph_view 视图骨架）

export const GRAPH_VIEW_HEADING = '## 当前图面（全图摘要——结构事实源；ops 的节点名与 pre 引用必须逐字来自这里）'
export const GRAPH_VIEW_STATS = '- 节点共 {{total}} 个；前沿与在学 {{active}} 个｜弱掌握 {{weak}} 个 ⚠（⚠ = 已开始且掌握度低于 {{threshold}} 或到期积压）{{degraded}}'
export const GRAPH_VIEW_DEGRADED_SUFFIX = '｜**超 {{cap}} 已降级**（depth 段聚合 + 前沿细节；⚠ 与 ⚑ 例外不截；概念组读数不降级）'
export const GRAPH_VIEW_ENDPOINT_LINE = '- ⚑ 终点：{{node}}（方向标记——朝该方向的生长须汇入它；不可 del/rename，零正文零题库不被调度，主线批须 set_pre 接线到新前沿）'
export const GRAPH_VIEW_ZERO_ENDPOINTS = '（零终点——空锚是合法空态，先加一个终点：教练回合无从裁决方向）'
export const GRAPH_VIEW_CONCEPT_HEADING = '### 概念组读数（teaches/assumes 派生可重叠；未标概念显式在列）'
export const GRAPH_VIEW_CONCEPT_LINE = '- {{label}}：教 {{supply}}｜assumes {{assumed}}｜成员 {{members}} 个{{skipped}}'
export const GRAPH_VIEW_CONCEPT_SKIPPED_SUFFIX = '｜跳过 {{count}}'
export const GRAPH_VIEW_UNTAGGED_LINE = '- 未标概念：{{count}} 个节点（合法 Missing——概念铸名随生长批提案落盘，不回填）'
export const GRAPH_VIEW_ZERO_CONCEPT = '（零概念足迹——合法空态： teaches/assumes 随生长批落盘）'
export const GRAPH_VIEW_FULL_HEADING = '### 全图（逐节点一行，深度序——⚠ 弱掌握、⚑ 终点）'
export const GRAPH_VIEW_DEPTH_HEADING = '### depth 段聚合（超 {{cap}} 个节点，逐节点行已降级）'
export const GRAPH_VIEW_DEPTH_BUCKET = '- {{label}}：{{count}} 个节点（掌握均值 {{mean}}｜前沿与在学 {{ready}}）'
export const GRAPH_VIEW_ACTIVE_HEADING = '### 前沿与在学细节（{{count}} 个）'
export const GRAPH_VIEW_ACTIVE_EMPTY = '（前沿与在学为空——合法空态：就绪存量 0 或全图已开始）'
export const GRAPH_VIEW_WEAK_HEADING = '### ⚠ 弱掌握（例外不截，{{count}} 个）'
export const GRAPH_VIEW_WEAK_EMPTY = '（无弱掌握节点——无已开始的低掌握/到期积压节点）'
export const GRAPH_VIEW_ENDPOINT_HEADING = '### ⚑ 终点（例外不截，{{count}} 个）'
export const GRAPH_VIEW_FOOTER = '……（全图 {{total}} 个节点超出逐节点行上限 {{cap}}——已降级为 depth 段聚合 + 前沿与在学细节；⚠ 弱掌握与 ⚑ 终点例外全列，概念组读数不降级。变焦细节用 upstream_dag / node_card。）'

// ---------------------------------------------------------------- 逐节点行（全图摘要与上游图摘要同源同形）

export const NODE_ROW_ITEM = '- {{body}}'
export const NODE_ROW_ENDPOINT_FLAG = ' ⚑'
export const NODE_ROW_BODY = '{{node}}{{flag}}（深度 {{depth}}｜{{columns}}）'
export const NODE_ROW_COLUMNS = '{{stage}}｜掌握 {{mastery}}{{weak}}'
export const NODE_ROW_WEAK_FLAG = ' ⚠'
export const NODE_ROW_EST = '｜est {{est}}′'
export const NODE_ROW_DUE = '｜due {{due}}'
export const NODE_ROW_PRE = '｜pre: {{pres}}'
export const NODE_ROW_TEACHES = '｜teaches: {{teaches}}'
export const NODE_ROW_ROOT = '（根）'

// ---------------------------------------------------------------- 节点卡（node_card 视图骨架）

export const NODE_CARD_HEADING = '## 节点卡：{{node}}{{flag}}'
export const NODE_CARD_ENDPOINT_FLAG = ' ⚑ 终点（方向标记）'
export const NODE_CARD_DEPTH = '- 深度：{{depth}}（读侧派生，地基在 0）'
export const NODE_CARD_STAGE = '- 阶段：{{stage}}{{suffix}}'
export const NODE_CARD_STAGE_ENDPOINT = '（终点——零正文零题库不被学习调度）'
export const NODE_CARD_STAGE_PRACTICE = '（交互实践节点）'
export const NODE_CARD_STAGE_EST = '｜est {{est}}′'
export const NODE_CARD_PRE = '- pre：{{pres}}'
export const NODE_CARD_TEACHES = '- teaches：{{teaches}}'
export const NODE_CARD_ASSUMES = '- assumes：{{assumes}}'
export const NODE_CARD_CONSUMERS = '- 下游消费：{{consumers}}'
export const NODE_CARD_CONSUMERS_ENDPOINT = '（无——终点是全局收敛点，后继不该存在；出现即异常态，走对账恢复）'
export const NODE_CARD_CONSUMERS_LEAF = '（无——叶子节点）'
export const NODE_CARD_MISCONCEPTIONS = '- 误解先验：{{mis}}'
export const NODE_CARD_EMPTY = '（无）'
export const NODE_NOT_ON_GRAPH_ERR = '节点「{{node}}」不在图上——用 graph_view 取逐字名单后重试（引用必须逐字命中）。'

// ---------------------------------------------------------------- 概念足迹（concept_footprint 视图骨架）

export const CF_HEADING = '## 概念足迹：{{course}}（{{hit}}/{{total}} 条{{queryPart}}）'
export const CF_QUERY_PART = '，query=「{{query}}」'
export const CF_QUERY_FULL = '（全表——无 query）'
export const CF_NO_HIT_WITH_QUERY = '（query「{{query}}」无命中条目——**空 ≠ 不存在**：换宽词再试，或不带 query 读全表逐条对照；写侧提案的概念引用仍必须逐字命中在册名字。）'
export const CF_NO_HIT_MISSING = 'Missing（合法空态——铸名随生长批提案落盘；本批 concepts 铸名即可。）'
export const CF_QUERY_HINT = '（子串发现只供找候选——**空 ≠ 不存在**：无命中时换宽词或不带 query 读全表。）'
export const CF_ENTRY_HEADING = '### {{canonical}}{{deprecated}}'
export const CF_DEPRECATED_SUFFIX = '（已废弃——地址仍解析、已从生成注入与候选面退出：勿再引用、勿铸同名）'
export const CF_ENTRY_DEF = '- 词条档：{{aliasesPart}}{{definition}}'
export const CF_ALIASES_PART = '别名 {{aliases}}｜'
export const CF_ENTRY_NO_DEF = '（无定义）'
export const CF_TEACHING = '- 教学面：teaches {{taught}}｜assumes {{assumed}}'
export const CF_TEACHERS_NONE = '（无节点教它）'
export const CF_ASSUMERS_NONE = '（无节点假设它）'
export const CF_INVOKES_DIST = '- 题目 invokes 分布：{{dist}}'
export const CF_INVOKES_EMPTY = '- 题目 invokes 分布：（无在库题标注它——合法空态：invokes 随出题出生打标）'
export const CF_CONFUSABLE = '- confusable 易混指向：{{list}}'
export const CF_DANGLING_CONFUSABLE = '  - （悬空易混引用：{{list}} 不在册——消费侧静默降级，不硬猜归属）'
export const CF_ATTACH_VERDICT = '- 插入挂点判读：{{verdict}}'
export const CF_ATTACH_HIT = '足迹非空 = 有天然挂点'
export const CF_ATTACH_MISS = '足迹空（含缺册）= 插入候选默认挂当前节点前置'
export const CF_OVERFLOW = '……（超出预览上限 {{cap}}，余 {{rest}} 条——用 query 收窄）'

// ---------------------------------------------------------------- 上游图摘要（upstream_dag 视图骨架）

export const UD_HEADING = '## 上游图摘要：{{node}}{{flag}}（前置传递闭包 {{total}} 个节点）'
export const UD_TARGET_ROW = '- 目标节点：{{row}}'
export const UD_SIZE = '- 闭包规模：{{total}} 个上游节点{{rest}}'
export const UD_SIZE_TRUNC_SUFFIX = '（本视图只列深度最小的 {{shown}} 个，余 {{rest}} 个见溢出行）'
export const UD_SIZE_FULL_SUFFIX = '（全列）'
export const UD_EMPTY_HEADING = '### 闭包节点'
export const UD_EMPTY_BODY = '（闭包为空——该节点是根：没有上游地基可诊断）'
export const UD_CLOSURE_HEADING = '### 闭包节点（深度序——地基在前；⚠ = 弱掌握或到期积压）'
export const UD_OVERFLOW = '……（超出预览上限 {{cap}}，余 {{rest}} 个——按深度截断，省略的是深度 ≥ {{cut}} 的节点；本次目标节点深度 {{depth}}，被省略的是离目标较近的一圈。近邻细节用 node_card 逐跳下钻。）'
export const UD_ADJ_HEADING = '### 闭包内 pre 邻接（本视图的读侧派生；图上 pre 只有名字列表，零边字段）'
export const UD_ADJ_LINE = '- {{node}} → {{pres}}'

// ---------------------------------------------------------------- 下游子图（subgraph 视图骨架，#326）

export const SG_HEADING = '## 下游子图：{{node}}{{flag}}（下游传递闭包 {{total}} 个节点）'
export const SG_TARGET_ROW = '- 目标节点：{{row}}'
export const SG_SIZE = '- 闭包规模：{{total}} 个下游节点{{rest}}'
export const SG_SIZE_TRUNC_SUFFIX = '（本视图只列离目标最近的 {{shown}} 个，余 {{rest}} 个见溢出行）'
export const SG_SIZE_FULL_SUFFIX = '（全列）'
export const SG_EMPTY_HEADING = '### 闭包节点'
export const SG_EMPTY_BODY = '（闭包为空——该节点是叶子：没有下游消费方，影响面止于自身）'
export const SG_CLOSURE_HEADING = '### 闭包节点（深度序——近处在前；⚠ = 弱掌握或到期积压）'
export const SG_OVERFLOW = '……（超出预览上限 {{cap}}，余 {{rest}} 个——按深度截断，省略的是深度 ≥ {{cut}} 的更远下游；近邻细节用 node_card 逐跳下钻。）'
export const SG_ADJ_HEADING = '### 子图内 pre 邻接（本视图的读侧派生；图上 pre 只有名字列表，零边字段）'
export const SG_ADJ_LINE = '- {{node}} → {{pres}}'

// ---------------------------------------------------------------- 题库概况（bank_overview 视图骨架）

export const BO_HEADING = '## 题库概况：{{course}}（{{total}} 题在 {{nodes}} 个节点的库中）'
export const BO_EMPTY = '（题库空——合法空态：题目随正文生成后的出题管线落库。）'
export const BO_LINE = '- {{node}}：{{total}} 题（归档 {{archived}} · invokes 标注 {{invokes}}）'
export const BO_OVERFLOW = '……（超出预览上限 {{cap}}，余 {{rest}} 个节点）'

// ---------------------------------------------------------------- 罗盘视图（compass_read 视图骨架）

export const CV_HEADING = '## 罗盘：{{course}}'
export const CV_ZERO_ENDPOINTS = '（零终点——空锚是合法空态，先加一个终点：罗盘按终点组织剩余路线。）'
export const CV_ANCHOR_LINE = '- 终点：{{endpoint}}（{{goalType}}）{{note}}'
export const CV_ANCHOR_NOTE = '——{{note}}'
export const CV_GOAL_COVERAGE = 'coverage 覆盖锚定'
export const CV_GOAL_CAPABILITY = 'capability 能力锚定'
export const CV_ROUTE_STATUS = '- 剩余路线：{{status}}'
export const CV_ROUTE_PAINTED = '已画（见下）'
export const CV_ROUTE_UNPAINTED = '未画（占位/缺席）'
export const CV_ETA_HEADING = '### 沙盘 ETA（模型推演，非承诺{{week}}）'
export const CV_ETA_WEEK_SUFFIX = '；{{weeks}}周'
export const CV_ANNOTATIONS_HEADING = '### 学习者批注（软输入——提议非指令）'

// ---------------------------------------------------------------- 终点锚视图（endpoint_anchor 视图骨架）

export const EA_HEADING = '## 终点锚：{{course}}（{{count}} 个终点）'
/** 零终点（空锚合法空态）时的裸标题：不报数。 */
export const EA_HEADING_BARE = '## 终点锚：{{course}}'
export const EA_ZERO_ENDPOINTS = '（零终点——空锚是合法空态，先加一个终点。）'
export const EA_NODE = '- 终点节点：{{node}}'
export const EA_GOAL_TYPE = '- 目标类型：{{type}}'
export const EA_GOAL_COVERAGE = 'coverage 覆盖锚定（完成=块工作表+终点）'
export const EA_GOAL_CAPABILITY = 'capability 能力锚定（完成=终点掌握）'
export const EA_DECLARED = '- 声明日期：{{declared}}'
export const EA_SEAL = '- 收尾宣告：{{seal}}'
export const EA_SEAL_DONE = '已收尾（{{date}} 宣告坡道铺通——读数折叠自该终点.pre 集；该终点重开主线接线批会自动清除）'
export const EA_SEAL_TODO = '未收尾（停摆前该终点.pre 须指向你认定的最终台阶——零 add_node 的纯 set_pre 接线批即收尾宣告）'
export const EA_NOTE = '- 目标描述：{{note}}'
export const EA_WORKSHEET = '- 块工作表：{{done}}/{{total}} 已核销（{{list}}）'
