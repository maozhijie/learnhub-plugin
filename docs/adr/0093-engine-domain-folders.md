# engine 目录按域分文件夹：91 文件归 9 域单层 + 顶层 5

`src/engine/` 顶层平铺 91 个 `.ts`（约 3.3 万行）+ `prompts/`（7 文件）+ `views/`（9 文件），平铺已过导航临界（超千行的文件 8 个，最大 1639 行）。本 ADR 裁决：engine 内部按域建**单层**子文件夹，**纯搬移、零逻辑改动**——文件名、导出面、门面 `engine/index.ts` 的唯一汇点地位（R1/R6）、分层规则 R1–R7、产品契约全部原样。大文件拆解（proposals.ts、question-bank.ts 等超千行者）不在本裁决范围，按文件另开票；测试缝不借机重设计（ADR-0013 另案）。

理由：门面 C 形态（ADR-0049/#182）落地后，公开面 `engine.<子系统>.<方法>` 已把领域轴注册进全仓消费方词汇；对全仓调用图做社区聚类（12 团），engine 内部自然聚出的团与领域高度吻合（调度/学习日、生成管线、出题站、教练/提案、概念、vault 先验、存储 io）。**代码的实际耦合早已按域聚集，只是物理路径没跟着走**——本裁决让物理路径与公开面同构，延续本仓「路径可推、符号可搜」的导航纪律（ADR-0049 否决 B 形态的同一判据）。ADR-0049 曾点名「重划域边界是 D 案（取消 hub）的前置、另开票」——本 ADR 只做物理归组，不重划任何域边界、不碰 hub 形态。

## 映射表（91 文件，逐一按文件头职责注释 + import 图核实）

| 文件夹 | 成员（省略 `.ts`） | 件数 |
|---|---|---|
| `sched/` | **sched-subsystem**、srs、advance、sessions、xp、optimize、sandbox、calibration、jol、memory、sediment、adaptive、coach、thermostat、attribution、evidence-streams | 16 |
| `content/` | **content-subsystem**、content、question-bank、question-audit、question-dedup、question-diversity、question-hygiene、bank-advice、bank-cleanup、error-cards、complexity、quality-review、quality-rubrics、quality-review-report、quality-audit、output-contracts | 16 |
| `coach/` | **growth-subsystem**、proposals、coach-round、coach-tools、growth-draft、compass、seed、stuck-report、probation、nof1 | 10 |
| `graph/` | **graph-subsystem**、graph、analysis、audit、health、quality | 6 |
| `concepts/` | concepts | 1 |
| `vault/` | note-source、notes、vault-links、vault-prior、anki、registry | 6 |
| `learner/` | learner-cards、explain、self-note、goals、kata、output | 6 |
| `practice/` | projects、project-exec、project-decompile、project-enc、project-recall、habits、skills、receipts | 8 |
| `infra/` | io、paths、yaml、schema、clock、dates、params、logger、llm、agent、html-comments、shuffle、sleep、write-unit、prompt-assembly、prompt-render、grading | 17 |
| 顶层保留 | index（门面）、types、views（+ `views/`）、store、data-check | 5 |

加粗 = 该域的 C 形态子系统容器文件。**子系统容器随域进文件夹**（文件夹 = 子系统，物理路径与公开面同构）；集中一个 `subsystems/` 会把容器与成员拆成两半，回到导航老问题。

## 关键裁决

- **分类轴 = 按域，不按技术角色。** 否决 `subsystems/`、`stations/`、`tools/` 式的技术角色轴：它把同一域的读写两侧物理拆开，导航更差，且与 C 形态公开面词汇脱钩。
- **单层锁死**：`engine/<域>/<文件>.ts`，域内不再嵌套（`views/` 是先例）。
- **顶层保留 5 件**：`index.ts`（门面唯一汇点）、`types.ts`、`views.ts`、`store.ts`、`data-check.ts`。后两者 import 域文件、坐在域**之上**（store 聚合账本流水、data-check 盘点全域），入任何桶都制造「infra 依赖域」的倒挂。顶层从 91 收到 5。
- **边界裁决**（备选已在拷问中记录，均按推荐案落定）：`sediment`/`adaptive`/`coach`/`thermostat`/`evidence-streams` → `sched/`（A1 难度带三件与沉淀层调的都是作答/会话/模型面）；`nof1`/`probation`/`stuck-report` → `coach/`（实验变量=引擎参数走提案-确认、复诊是教练插入边机制、卡点自报落账即拉教练回合）；`grading` → `infra/`（零 engine 依赖、被全域消费的叶子语义层）；`practice/` 命名保留（与 CONTEXT 词条 Practice Node 的词面相撞只存在于代码层，glossary 的 avoid 规则管文档用语不管路径名）；`concepts/` 单文件文件夹成立（概念层语义独立、ADR-0084 系列撑腰，#300 概念工作台落地即是第二成员——并入 `graph/` 会让「登记表是身份系统、图是引用方」的层界物理消失）。
- **不动清单**：`prompts/` 与 `views/` 保持原位——`prompts/` 的路径是 `scripts/prompt-bump.mts::TEMPLATE_FILES` 两道提示词门的登记面，搬移收益纯导航、成本不对称；R1–R7、写侧白名单（`proposals.ts` 是 `GraphStore.writeRegionDoc` 唯一白名单成员）、产品契约（HTTP 路由/agent 工具面/磁盘格式）零触碰；tests 的 296 处深导入（70 个测试文件）随刀机械改 import specifier。
- **施工 = 8 刀，风险递增序**：① `vault/`（试点，验证流程）→ ② `graph/`+`concepts/` → ③ `content/` → ④ `sched/` → ⑤ `practice/` → ⑥ `learner/` → ⑦ `coach/` → ⑧ `infra/`。每刀 = 搬一域 + 全仓改 specifier + 全量门绿 + 独立提交，独立可回滚（ADR-0043 立的逐刀纪律）。唯一牵动路径键控门的是 ⑦（`scripts/scan-write-unit.mjs` 硬编码 `engine/proposals.ts` 等 4 条路径，随刀同步）；diff 最大的是 ⑧（全仓 import 改写 + `src/host` 深导入的 prompt-render/logger 两处），放最后因为届时施工模式已被前七刀验证。
- **本 ADR 只定终态与序列，不施工**（施工总票 #304，立而不排期；子票按 issue-tracker 粒度判据执行时归并开出）。

## §修订（2026-09-16，#305 刀①–④ 实测）

**更正上「唯一牵动路径键控门的是 ⑦」**：该判断低估了波及面，实测刀①–④ **每一刀**都触到路径键控面，全量 7 类（刀⑤–⑧ 同表复用，只多出第 8 类，见 §修订二）：

| 路径键控面 | 触到的刀 | 说明 |
|---|---|---|
| `scripts/arch-baseline.json::sizes` | **每刀** | 逐文件行数按路径进基线；纯搬移下值不变、键必迁，须同提交 `--update` |
| `src/engine/output-contracts.ts::REPAIR_MECHANISMS[].file`（随刀③迁至 `content/`） | ①③⑤⑦⑧ | 按 `src/` 相对路径精确匹配读源对账 witness 串 |
| `quality-rubrics.ts` 判据的 `引擎:` 出处 | ③ | 锚门按 `src/engine/<file>` 读源对账锚点原句 |
| `scan-invariant.mjs`（`definedIn`／白名单）／`scan-closure.mjs`（原语之家／白名单） | ②⑦ | G6／G10 |
| `scan-write-unit.mjs::WRITE_UNIT_SITES` | ④⑦ | 本 ADR 原已记 ⑦；④ 的 `sched-subsystem.ts` 同属 |
| `prompt-bump.mts`（`TEMPLATE_FILES`／登记表面） | ③ | 见下条 |
| `tests/arch-guards.test.ts` 自检里**抄写**上述常量值的路径字面量 | ②④ | 见下条 |

**两条形态裁决（比上表更可复用）**：

- **登记面须是清单、含搬迁前的历史路径**，否则 git 历史简化在搬迁提交处截断：只改 `CHANGELOG_FILE` 单路径会让登记门的纪律起点从 `7a9a136`（#218 引入提交）静默漂到搬迁提交——扫描窗口随之从「自 #218 起」缩到「自本刀起」而**照旧报绿**（实测：双路径下起点仍为 `7a9a136`）。这不是新裁决，是 ADR-0075 §3「面是清单不是单文件」在登记表面上的同一判据；`TEMPLATE_FILES` 与 `CHANGELOG_FILES` 现在都按它写。
- **自检只许引用路径键控常量，不许抄写其值**：抄写的样本在常量迁家后不再命中目标分支——读模块级表的当场变红（可发现），纯样本的则**门照旧绿而分支悄悄不再被断言**（不可发现，比红更坏，正是 ADR-0047「恒过的门比没有门更坏」的局部形态）。刀②④ 各修一处（G6 引用 `GRAPH_WRITE_PRIMITIVES[0].definedIn`、G9 按 `{...WRITE_UNIT_SITES}` 造读数）。

**施工器**：`scripts/move-engine-domain.mjs`（刀① 沉淀，可复用到 ⑧）——`git mv` + 两向 specifier 改写（未搬文件指向被搬文件的 + 被搬文件自身全部相对 specifier 重算；后者不可省，否则被搬文件指向留守文件的 specifier 静默失配）。测试缝、导出面、`prompts/`／`views/` 位置均未动，与原裁决一致。

## §修订二（2026-09-16，#306/#307 刀⑤–⑧ 实测：施工完成）

八刀落齐，顶层 91 → **5**（`index`／`types`／`views`／`store`／`data-check`）。⑤⑦⑧ 触到的路径键控面**与上表同构**（逐刀落点见门册），但实测**多出第 8 类**；受管制面独占的合并序如设计（⑦⑧ 各一次过门，无重复登记）。三条补充供复用：

- **第 8 类 = 非递归目录遍历**：`readdirSync(engineDir)`「列顶层」式的收集器不随搬迁失败，而是**静默收窄**——`tests/dedup-convergence.test.ts` 的单一出处门面从 91 件缩到 22 件，门照旧报绿（ADR-0047 的局部恒过）。判据：收集器类门必须带**扫描面断言**（实测数字作下限），别只断言判定结果；`home` 一类键也要**路径精确**，basename 递归后会踩同名文件（`prompts/grading.ts` 与 `infra/grading.ts`）。
- **「门照常执法」要拿负样本证，不能拿绿证**：迁家后门绿有两种成因——门真在看新键，或门已不再看这一面。实测法 = 造违规文件直接调门本体（本批造 `rogue-probe-tmp.ts` 验 G6／G9），验完即删。
- **散文扫尾分「活引用」与「历史记录」**：会误导读者的活注释随刀改（本批 14 处）；`docs/adr/**`／`docs/research/**`／门册旧行／机器生成 wiki 不改——在历史记录里追改路径等于伪造当时的现场。

**登记面**：`tests/README.md`（门册）①–④／⑤–⑥／⑦／⑧ 各一节（含负样本读数与逐刀路径键表）；`docs/agents/architecture.md` 四层图补终态 + 收入搬迁施工器；本 ADR 与 CONTEXT.md 无涉（布局是实现细节，不进词汇表）。

**取号说明**：本篇原落 0092，与同日 8 分钟前先落地的《空图首级：起点资格判据迁家为教练材料注入》撞号（并行窗口竞态），2026-09-16 更正为 0093——CONTEXT.md 与既有引用均以 0092 指向前者。此后取号按 `docs/adr/README.md` 的登记表核对。
