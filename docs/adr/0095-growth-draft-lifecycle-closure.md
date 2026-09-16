# 生长草稿的生命周期收口：门同源兑现到 schema 面、未发布段逃生口、水位重放修正

2026-09-17「数学基础」空课二次事故（实机语料 `生成语料/教练执行/` 20 件 ok + `bad-…0021.md`）：21 轮执行官调用、约 35k token、**零结构发布**。与 2026-09-16 那次（ADR-0088 §修订）不是同一个病——形状门「收下即归一」已生效、`object is not iterable` 未再现；这次暴露的是下一层：草稿的**生命周期**在四处漏。五个缺陷面里，熔断口径归 ADR-0041 §修订补记二、日志目录自愈归 ADR-0080 §修订，本 ADR 管草稿侧三件 + 一处实现与裁决的偏离。

## 裁决

**一、门同源兑现到 schema 面（缺陷①）。** ADR-0088 裁决 1 的中心不变式是「草稿通过 = 门通过，按构造成立」，但实现只把 `editGateErrors`（结构重放 / 概念对表 / 锚保护 / 巩固门 / 生长闸门）接到了草稿侧，**propose 的 schema 纯校验**（op 白名单、档位枚举、bloom/difficulty/est 取值域、字段互斥、note 跨字段规则、铸名/误解条目形态）仍只在 finish 才第一次见。事故实测：审计报「通过（1 条 findings）」两秒后 finish 被 schema 门拒（档位非法 `初识`）；再一轮审计「通过」后 finish 被门复验拒（未覆盖批内新前沿）。模型据此以为「审计通过 = 可以发布」。

新增 `editProposalGateErrors(doc, ctx)`（proposals.ts）= `validateEditProposal` + `editGateErrors`，返回 `{errors, spec, phase}`；`draft_patch` 试算 / `draft_audit` / `draft_finish` **三处同调**，且三处喂给门的是**同一个 `batchSpecOf(ops)` 对象**（不是三处各拼一份——拼装漂移正是这类事故的温床）。试算按「补丁生效后的本批形态」跑（本补丁**将要**声明的 note 与铸名一并代入），否则前进/换向的接线义务会在试算里缺席。`proposeEdit` 未改（它本来就依次调这两个函数；包装文案两处各说各话）。

边界（如实登记，不假装 `⟺` 是全域的）：propose 相对草稿门多两道**受理面**检查——课程在注册表（草稿站必然成立）与罗盘路线门（草稿站不产 route），故两侧结论在本站的实际定义域内一致；finish 走 `YAML.stringify` 往返再进 propose，往返本身不改形状（有 `draft_finish` 的拒收行与 propose 拒收行逐字一致的对照测试钉住拒绝侧）。

**二、未发布段的逃生口 `draft_revert`（缺陷②）。** 草稿只能追加（`doc.ops.push`），`published` 只在 apply 成功后前移，于是**被门拒的 op 永久留在未发布段、每次 finish 重投都带着它**——事故里 `ops[0..2]` 的非法档位与 `ops[11]` 的退役 op 因此不可清，模型的 del+add 重铸在原理上无效（`del_node` 不会让 `ops[0]` 消失）。写件工具增至四具：`draft_revert(count?)`——省略 count = 丢弃全部未发布增量回到水位；给了 count = 只丢尾部 N 条。回到水位即本批作废，**批级状态（note / 铸名缓存 / confusable 建议）一并清**；部分撤销保留它们。已发布段（水位以下）不可动。撤销轮照记轮志（`kind: 'revert'`）。

**三、水位重放的实现修正（事故的下一层）。** 草稿图曾以「基图 + **重放已发布段**」折叠，而 `applyEdit` 早已把已发布段写进 `data/图.yaml`——两处叠加即双重应用。实测后果：第一批发布成功后，同会话第二次 `draft_patch` 必以「add_node 重名」炸，**会话在第一批之后事实上已死，唯一出路是取消会话**（事故前无人走到第二批，所以没暴露）。修法与裁决 3 的字面一致（「内核对草稿图 + 未发布 ops 重放」）：草稿图 = 真实基图（= 水位处的草稿图），试算 / 审计 / 发布一律只取水位之后的 ops；基图漂移由 finish 的门复验对真实基图再跑一遍兜住。

**四、档位词汇进写作面（缺陷③）。** `CONCEPT_TIERS`（知道/会用/能教）此前不在模型动手写的位置：执行官提示词的补丁纪律不提档位，上下文包「登记表档位」块在空态下也不带取值域 → 模型自造「初识」，直到 propose 拒绝文案里才第一次见到合法取值。修法**不走提示词改动**：取值域写进 `draft_patch` 的 `teaches`/`assumes` 字段说明（工具 description 是模型每次调用都看得到的写作面）＋ 上下文包档位块**无条件**带一行取值域。两处都是引擎侧文本，`src/engine/prompts/` 一字未动（故不过 prompt-bump 两道门）。

## 替代方案（否决）

- **审计继续只跑结构重放，schema 面留到 finish** —— 就是把事故原样保留：模型拿到的信号是「审计通过」，真相是门每次全拒。
- **同名重铸（后续 `add_node` 就地覆盖未发布的同名 `add_node`）** —— 更贴模型直觉，但改 op 日志语义（同一条 `add_node` 在未发布段有两种含义：追加 / 覆盖），且草稿是**追加式 op 日志**，就地替换会与水位前移、`replayDraft` 的改名/删除叠加语义纠缠。`draft_revert` + 重新 patch 已能表达重铸，且是纯增量、零存量语义风险。否决（票面列为候选 (b)）。
- **`draft_revert` 只撤 op、不动 note/铸名** —— 回到水位后 note 还挂着上一批的算子与理由、铸名缓存还带着上一批的概念，下一批会带着它们的残留发布。批级状态随批走。
- **门同源用「审计时也调一次 `graphPropose` 干跑」实现** —— 干跑要落提案产物（`saveArtifact` 会写盘并占提案 id），且 propose 不接受「不落盘」模式；比抽一个纯函数入口重得多。

## 不做什么

- 不动 `proposeEdit` / `applyEdit` 的错误文行与调用序（只是草稿侧改走合并入口）。
- 不改 `EditProposalSpec` / 草稿磁盘格式（`GrowthDraftRound.kind` 加一个取值 `revert`，`parseDraftDoc` 不校验 kind，零迁移）。
- 不动提示词与 `PROMPT_CHANGELOG`（本票零提示词改动）。
- 不给「教练回合」等其余 `agentLoop` 站加进展世代（它们没有「发布」这个进展概念，缺省即「同一门错误行按会话累计」）。
- 不做 UI/命令面的草稿取消接面（仍归 #269/#273 一线）。

## 图查证记录（AGENTS.md 收尾点名）

project `D-learnhub-plugin`（`query_graph` / `search_graph`）：`editGateErrors` 入边 3（`editProposalGateErrors` / `proposeEdit` / `applyEdit`）+ 测试——门序列三处同调不变；`replayDraft` 入边 `simulateOps` + 草稿内核（试算/审计/撤销）+ 测试；`agentLoop` 生产入边 2（`coachDraft` / `compassPaint`）——`progressEpoch` 是**可选**参，只有草稿站传（水位），其余站零改动；`draftToolSpecs` 入边仅 `coachDraft`；`EDIT_OPS` 消费方 `validateEditProposal`（家）+ 新增取值域回灌；`GrowthDraftDoc`/`GrowthDraftRound` 无引擎外消费方（host/commands/ui 零命中，`kind` 加值无破坏面）；`createFileLogger` 入边宿主 `createHostRuntime` + 测试。blast radius 收敛在 `coach/` 三件 + `infra/agent.ts` + `host/log-file.ts`。

## 行为与门影响

- 新增导出：`editProposalGateErrors`（proposals.ts）、`EDIT_OPS`（原为模块内 const，改导出供取值域回灌）、`LOG_FAILURE_WARN_STREAK`（host/log-file.ts）；`agentLoop` 增可选参 `progressEpoch`。G5 文件规模棘轮同提交迁移（`scripts/arch-baseline.json`，六件；typeErrors 仍 0，depsFace 与 adapterFace 零变动）；JSONL 结构门白名单加 `agent.ts`（切**门错误行**取熔断指纹，同 `generation-jobs` 的 `sectionFailure` 一族：纯文本非数据流）。
- **同版本号下的提示词登记**：上下文包注入面新增一行 + 执行官工具清单扩容，最终 prompt 变了 → 按章程 §8 在 `PROMPT_CHANGELOG` 三个键（`思路官回合` / `思路官重裁` / `执行官回合`）补同版本号条目；`src/engine/prompts/` 模板文本零改动，两道机械门（版本号集合差 / 版本号对齐）对本类变更不执法（ADR-0072 §已知边界 ④），靠登记 + 人审兜。执行官模板散文仍写「写件三工具」——改散文另票（本次只动工具清单这个模型每次调用都看的权威面）。
- 行为变更的读数与逐条验收见门册 `tests/README.md` 本票节；事故语料回放 fixture 住 `tests/fixtures/agent-loop-incident-2026-09-17.json`。
- 存量处置：事故草稿（`published: 0`）**不宜续建**——修复前它的毒 op 清不掉；修复后可直接 `draft_revert` 回退到水位重开，或显式取消（`coachDraftCancel` 内部 API 已有）。
- 未做的边界（如实登记）：口径② 只认「同一门错误行反复在场」，每轮换新错误行不介入（K≤20 兜底）；「草稿取消」仍只有内部 API（命令/面板接面归 #269/#273 一线）；`compassPaint` 等其余 `agentLoop` 站不传进展世代（无「发布」这一进展概念，缺省即按会话累计）。
