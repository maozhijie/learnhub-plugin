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

## 登记面

- `tests/README.md`（门册）：`scan-write-unit.mjs` 路径表变更随第 ⑦ 刀登记。
- `docs/agents/architecture.md`：四层图补一句 engine 内部按域分文件夹，随第 ⑧ 刀（布局完成时）落地。
- 本 ADR 与 CONTEXT.md 无涉：文件夹布局是实现细节，不进词汇表。

**取号说明**：本篇原落 0092，与同日 8 分钟前先落地的《空图首级：起点资格判据迁家为教练材料注入》撞号（并行窗口竞态），2026-09-16 更正为 0093——CONTEXT.md 与既有引用均以 0092 指向前者。此后取号按 `docs/adr/README.md` 的登记表核对。
