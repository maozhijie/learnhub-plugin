# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## ADR 写作规范（本仓）

上游默认格式是「标题 + 1–3 句」，并明说 *an ADR can be a single paragraph*——价值在于记下**做了这个决定**与**为什么**，不在于填满章节。本仓照此收敛：ADR 是**决策记录**，不是施工日志。

**该有的（保留）**：

- **裁了什么**：决定本体，够一个后来者据此照做。
- **为什么**：实测数字与其理由保留（章程 §5 要求阈值来源写进 ADR），但只留语义与读数——行号、函数签名、代码片段、结构体定义不留（代码自身是事实源）。
- **否决了什么**：替代方案与否决理由。这是 ADR 最不可替代的部分，六个月内会有人重新提议同一个方案。
- **边界与显式 no**：「不做什么」与「做什么」同价；与相邻 ADR 的关系只引编号，不复制其内容。

**不该有的（写别处）**：

| 这类内容 | 归处 |
|---|---|
| 施工记录：commit sha、按刀／按提交分段的落地叙述 | 票面（GitHub Issue）；`git log` 是完整流水 |
| 逐条行为变更明细、快照迁移逐条审计、棘轮行数迁移 | `tests/README.md`（门册：行为变更与阈值的唯一登记处） |
| 实现细节：`file.ts:123`、函数名、类型定义、测试文件清单 | 代码与测试自身；ADR 只写语义 |
| 把票面设计文档整篇抄进来（一票一 ADR） | 票面才是设计方案的家；ADR 只收满足下面三问的部分 |

**尺寸与修订**：目标 ≤ 10 KB（约 60 行）；**超过 12 KB 即「过大」**，提交前瘦身或拆成「决策 + 指针」。依据是 2026-09-16 全量压缩的实测落点：决策密集者（承载多轮裁决或接口形状）8–12 KB，纯决策记录 4–8 KB。原文追加「§修订」节是本仓允许的先例，但**修订节同受尺寸约束**——只写新裁决与否决项，施工细节归票面；**改变了原裁决方向的**，写新 ADR 并在旧文件标一行「已被 ADR-NNNN 取代」。

**源码与测试的引用是契约面**：`src/`／`tests/` 里以 `ADR-00XX §小节` 或**原话**形式引用 ADR 的地方，压缩时**小节名与那几句原话必须保留**（或同提交改正引用处）——否则仓里会留下一片悬空的 `§` 指针。同理，测试断言的词条原话（如 `tests/output-contract.test.ts` 钉住的「格式敏感度标注（机械评审/规划/推理创意）」）是词表承诺，压缩词条释义时必须原样保留。本次全量压缩的实测教训：`ADR-0080 §勘误`（8 处）、`ADR-0085 §环语义裁定`（5 处）是压缩删小节后当场被 `npm test` 抓出来的。

**准入门槛**（三条全中才写，缺一条就不写）：难逆转 + 无上下文会令人惊讶 + 真实取舍。「一票一 ADR」不是本仓标准。

## CONTEXT.md 写作规范（本仓）

CONTEXT.md 是**词汇表，仅此而已**：它定义本项目特有的概念叫什么，不记录它怎么实现、也不承载裁决。上游 `CONTEXT-FORMAT.md` 的判据是「totally devoid of implementation details」——不是 spec、不是草稿本、不是实现决策的仓库。

**词条形状**（机械契约，改坏会红）：

```md
**Term（English Term）**:
定义一至两句——说「它是什么」，不说「它怎么运作」。
_Avoid_: 同义词甲、同义词乙
```

- 词条头 `**名字**:` **必须独立成行**，`_Avoid_:` 行紧随定义。`tests/helpers/copy-lock.ts` 运行时解析这两行取 canonical 词与 Avoid 词，是**文案锁门的唯一出处**（判据与边界见门册 L3 段）。释义散文不参与解析，但**词条头与 `_Avoid_` 行不得顺手改动**——删掉一个 Avoid 词等于放开一条文案反断言。
- **Be opinionated**：同一概念有多个说法时挑一个作 canonical，其余进 `_Avoid_`。
- **定义要短**：一至两句，说的是**它是什么**（与相邻概念的边界在哪），不是它怎么运作。
- **只收本项目特有的概念**：通用编程概念（超时、错误类型、工具函数模式）不进词表，哪怕本项目大量使用。
- 词条可按自然聚簇加子标题（`### 分组`）；子标题行被解析器安全忽略。

**不该有的（写别处）**：

| 这类内容 | 归处 |
|---|---|
| 实现细节：文件路径、字段名、函数名、磁盘布局、内部代号（`V-2`／`C1`／`Arc E` 一类） | 代码与 ADR |
| 行为规格：多步骤流程、状态机、阈值、枚举清单 | ADR／提示词／门册 |
| 裁决与理由（「刻意分岔」「宁可…也不…」） | ADR；词条至多留一句出处指针 |
| 历史沿革（「原 X 已撤」「已退役 #NNN」） | ADR 与 `git log`；退役概念应从词表移除，暂留时在词条头标注退役、定义压到一行 |

**尺寸**：主判据是「定义一至两句」；实测全量压缩后词条正文平均约 120 字、最长约 158 字，**超过 150 字即为膨胀信号**——那通常意味着词条里混进了规格或裁决。

## 取号纪律

编号是顺序号、不是身份。索引与当前最高号登记在 [`docs/adr/README.md`](../adr/README.md)。

1. 取号前 `git fetch origin` + `ls docs/adr/`（并行会话／worktree 下 rebase 后再看一次），取**目录里最大号 + 1**。
2. **同号冲突在并行窗口下会发生**：后落地者改号（先例：ADR-0093 原落 0092、撞《空图首级》一篇，2026-09-16 更正），并在文件末尾留一行取号说明。
3. 新增 ADR 的**同一次提交**里更新 `docs/adr/README.md` 的索引表。
