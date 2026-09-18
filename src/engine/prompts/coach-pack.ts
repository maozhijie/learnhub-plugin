/**
 * 教练上下文包与罗盘尾段的模型面散文（#311）：`coach/growth-subsystem.ts::coachContextPack`
 * 的六区块标题与骨架行，以及 `compassTail` 的罗盘尾段行。
 *
 * 文本是惰性字符串 + `{{变量}}` 占位符，取值由 `../infra/prompt-render.ts::render` 在调用点
 * 完成（缺变量与残留占位符都抛，详见 ADR-0075）。**本文件是模型可见散文，改动走章程 §8。**
 *
 * 口径：上下文包的**定序与取材逻辑**住 `growth-subsystem.ts`（`block()` 拼装、`foldCompletion`
 * 取材），本文件只收模型读到的标题与行文。首级判据块（`COACH_FIRST_RUNG_CRITERIA`）已住
 * `projects.ts`——那块是 #303/#310 的领域材料，不在本批搬迁范围。
 */

// ---------------------------------------------------------------- 包标题与区块标题

export const PACK_HEADING = '# 教练回合上下文包：{{course}}（{{label}}）'
export const PACK_LABEL_LIGHT = '轻量段——只带行为摘要与罗盘'
export const PACK_LABEL_FULL = '全量六区块'
export const PACK_BLOCK_ANCHOR_TITLE = '终点锚'
export const PACK_BLOCK_DIGEST_TITLE = '行为摘要（窗=最近 7 学习日或 10 节取大；即算即用不落盘）'
export const PACK_BLOCK_REGISTRY_TITLE = '登记表档位（前沿概念的教学档位视野）'
export const PACK_BLOCK_MISCONCEPTIONS_TITLE = '误解目录（前沿节点的误解先验）'
export const PACK_BLOCK_COMPASS_TAIL_TITLE = '罗盘尾段'
export const PACK_BLOCK_V2_TITLE = 'V-2 接缝（先验上下文注入——预留）'

// ---------------------------------------------------------------- 包头终点行

export const PACK_ENDPOINT_LINE = '- ⚑ 终点：{{endpoint}}（方向标记——朝该方向的生长须汇入它；零正文零题库不被调度）{{note}}｜状态：{{status}}{{closure}}'
export const PACK_ENDPOINT_NOTE = '｜目标描述：{{note}}'
export const PACK_ENDPOINT_CLOSURE = '｜闭包已学 {{learned}}/{{total}}'
export const PACK_ZERO_ENDPOINTS = '- （零终点——空锚是合法空态，先加一个终点：教练回合无从裁决方向）'
/** 包头与终点锚块共用的状态词表（#338 单一出处；消费在 growth-subsystem::endpointStatusText）。
 * 注：状态枚举 unwired 的语义 = 未收尾（sealed 为 null，含 pre 空与非空）——展示层按
 * pre 是否非空细分为 未接线/未铺通，两档都取锚块常量，不再另设包头简版词表。 */
export const PACK_STATUS_DANGLING = '悬空锚（终点不在图内）'
export const PACK_STATUS_SEALED = '已铺通（未达成）'

// ---------------------------------------------------------------- 终点锚区块

export const PACK_ANCHOR_NODE = '- 终点节点：{{endpoint}}（方向标记，不可 del/rename；接线 = 该主线批 set_pre 到它）'
export const PACK_ANCHOR_GOAL_TYPE = '  - 目标类型：{{type}}'
export const PACK_ANCHOR_DECLARED = '  - 声明日期：{{declared}}'
export const PACK_ANCHOR_STATUS = '  - 状态：{{status}}'
export const PACK_ANCHOR_STATUS_REACHED = '已达成（已铺通且最后台阶全掌握）'
export const PACK_ANCHOR_STATUS_UNSEALED = '未铺通（pre 非空、未收尾宣告）'
export const PACK_ANCHOR_STATUS_UNWIRED = '未接线（pre 空）——朝它长就要接线'
export const PACK_ANCHOR_CLOSURE = '  - 闭包学习进度：已学 {{learned}} / 共 {{total}}'
export const PACK_ANCHOR_STRUCT = '  - 结构读数：{{sealed}}｜闭包真已学 {{learned}}/{{total}}{{unlearned}}｜{{complete}}'
export const PACK_STRUCT_SEALED = '已收尾'
export const PACK_STRUCT_UNSEALED = '未收尾'
export const PACK_ANCHOR_STRUCT_UNLEARNED = '（未学：{{list}}）'
export const PACK_STRUCT_COMPLETE = '结构已铺完（该终点不再需要生长——计划门与收束判据同用本读数）'
export const PACK_STRUCT_INCOMPLETE = '结构未铺完'
export const PACK_ANCHOR_LAST_STEPS = '  - 最后台阶：{{steps}}'
export const PACK_ANCHOR_LAST_STEP_JUNCTION = '{{node}}（同时服务：{{others}}——交汇）'
export const PACK_ANCHOR_LAST_STEPS_EMPTY = '（pre 空——未接线）'
export const PACK_ANCHOR_NOTE = '  - 目标描述：{{note}}'
export const PACK_ANCHOR_WORKSHEET = '  - 块工作表：{{done}}/{{total}} 已核销'
export const PACK_JUNCTION_DISCIPLINE = '- 裁决纪律：优先选能同时推进多个未达成终点的台阶（交汇优先）'
export const PACK_ANCHOR_ZERO_BODY = '（零终点——空锚是合法空态，但教练回合无从裁决方向；先加一个终点。）'

// ---------------------------------------------------------------- 登记表档位区块

export const PACK_REGISTRY_LINE = '- 概念登记表：{{count}} 条在册{{retired}}'
export const PACK_REGISTRY_RETIRED = '（另有 {{count}} 条已废弃——地址仍解析，仅退出生成注入与候选面）'
export const PACK_REGISTRY_MISSING = '- 概念登记表：Missing（合法空态——铸名随生长批提案落盘）'
export const PACK_REGISTRY_TIERS = '- teaches / assumes 的档位取值域：{{tiers}}（写别的值会被受理门拒收）'
export const PACK_REGISTRY_ACTIVE = '- 可学/在学节点 {{count}} 个'
export const PACK_REGISTRY_TEACHES = '- 前沿 teaches：{{list}}'
export const PACK_REGISTRY_TEACHES_EMPTY = '（前沿节点无 teaches 字段）'
export const PACK_REGISTRY_ASSUMES = '- 前沿 assumes：{{list}}'
export const PACK_REGISTRY_ASSUMES_EMPTY = '（前沿节点无 assumes 字段）'

// ---------------------------------------------------------------- 误解目录区块

export const PACK_MISCONCEPTION_LINE = '- {{node}} · {{concept}}：{{model}}'
export const PACK_MISCONCEPTIONS_EMPTY = '（误解目录空——合法空态：误解先验随生长批写入；真实错误检测归作答流水挖矿与申诉复核）'

// ---------------------------------------------------------------- 罗盘尾段区块

export const PACK_COMPASS_HEADING = '### 罗盘'
export const PACK_COMPASS_EMPTY = '（罗盘缺席或尚无已画路线——合法空态：方向批（前进/换向）会随计划写出「剩余路线」；锚在终点上，零终点先加一个终点。）'
export const PACK_SEDIMENT_HEADING = '### 沉淀折叠'

// ---------------------------------------------------------------- V-2 接缝区块

export const PACK_V2_BODY = '（v1 未接线：vault 链接先验注入教练回合依赖宿主检索面——本区块为六区块定序占位，接线后由此注入。）'

// ---------------------------------------------------------------- 罗盘尾段（compassTail）

export const PACK_TAIL_ROUTE_HEADING = '### 罗盘 · 剩余路线（非承诺草图——方向感，不是承诺）'
export const PACK_TAIL_REPAINT_DUE = '（重画待办：{{due}}——弧的写权在罗盘站；如你认为该重估，用计划里的 repaint_suggest（结构性事由）建议，勿自行改写。）'
export const PACK_TAIL_ANNOTATIONS_HEADING = '### 罗盘 · 学习者批注（软输入——提议非指令）'
