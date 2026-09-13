# ADR-0063: 出题第二意见门——生成时独立解题对账

日期：2026-09-13 ｜ 票：#223 ｜ 总纲：#212 ｜ 证据：#225 报告 §5（docs/research/2026-09-generation-methodology.md）

## 背景与问题

答案正确性是全管线唯一零外部信号的可验证属性：判卷有重判轮、格式有修复轮，答案键对错却只押在出题同一次调用的提示词自检上（「把每道题当作考生独立重解一遍」）——内在自证是文献中最弱形态（Huang ICLR 2024：无外部信号的 self-correct 一致降分；Reflexion：修正需要环境反馈）。仓库自己已有满足「外部信号」前提的先例：申诉复核两段式（Phase 1 独立解题、明确忽略存储键 + 确定性对账）。#223 把这个形态前移到生成时，把键错题拦在学习者遭遇之前。

## 裁决

### 1. 形态：抽样 + 盲解 + 确定性对账 + 恰一次修复（`src/engine/question-audit.ts`）

- **抽样而非全量**（逐题成本）：确定性等距抽样——k = round(n×rate)，不引随机数（同输入同抽样，剧本测试与金样本回放全确定性）；**高难度档加权 = difficulty 3 恒入样**。抽样率可配：机器级 config `quizAuditRate`（0–1，**缺省 0.25 起步低**，0 = 关门；非法值装配时 fail loud，#12 口径）。引擎级显式 opt-in（`opts.secondOpinion`）——引擎缺省不审计，宿主按配置传入。
- **盲解**：独立 solver 调用只看题干与选项，零答案键零解析，逐客观题只答「答案 + 关键步骤」（JSON）。reflection/open_question 排除（无确定性对账面）。solver 调用带独立语料站标签「独立解题」（STATIONS.quizSolver，#213 词表随门面常量对齐）、fast 档。
- **对账**：比较器 = `evaluateAllo`（判卷同款确定性比较）——选择题字母归一、**填空可接受答案数组 = 同义写法白名单**（normBlank NFKC 归一，ADR-0029）、numeric/tol 容差、排序/配对逐位。不一致 ≠ 键必错：等价表述/多解的误拒治理走题目量规（#221「键自洽」判据）与「门红了先裁决」纪律，不为绿扭曲判据。
- **不一致处置**：该题拒收，拒收原因 + 独立解 + 存储键回灌修复轮（gateRepairRound 形态：**恰一次**，题目生成站 repair 形态、deep 档）；修复题原位替换后**再审计一次**，一致才入库；修复轮产出不可用或仍不一致 → **弃题不阻塞整批**（弃题进 rejected 报告面，理由带「第二意见」前缀）。
- **逃生门**：solver 应答不可解析/形态不可判 = 审计失败（unresolved），**保守放行不弃题**——审计失败不等于键错，且不重试解题调用（成本封顶）。

### 2. 报告可见（#223 验收）

`questionGenerate`/`questionGenerateSections` 返回值增 `secondOpinion` 报告：rate/eligible/sampled/inconsistent/repaired/discarded/unresolved/**solverCalls**（抽样率与成本可见，逐节出题跨节聚合）。纯出题任务与管线的任务消息追加「第二意见抽样 N（拦 X 修 Y）」注记；成本明细随语料 frontmatter 的 usage 落盘（#213）。

### 3. 范围

课程题库出题（`questionGenerate`）与逐节管线出题（`questionGenerateSections`）；笔记出题 v1 不接（收敛题型面小、独立入口，留待语料观察后议）。成本量级（#225 报告）：出题站 +40–70% token、全管线约 +10–20%（rate 1/4 下）。

## 后果

- 键错有了生成时的外部信号门；漏拦残余由申诉勘误（结果法院）兜底，两条防线分工不重叠。
- 拒收/弃题走 rejected 报告面，全批阻塞结构性不可能（弃题只减不入）。
- 代价：出题成本上升（抽样率可调可关）；solver 误判会造成误弃题——由「修复轮改好则入库」+ 量规回流治理，不在门上放松比较器。
- `evaluateAllo` 判卷与对账共用同一比较器：判卷语义修订时两处同步，对账口径永不漂移于判卷口径。
- 行为快照迁移（同提交）：出题缝闭包改为转发调用级 station/kind/effort（第二意见的解题/修复调用语料站标正确），`bank2.questionGenerate` 受参形状随之变化——路由行为快照 4 条探针（POST /question-generate 全参/缺 section/缺 instruction/缺 count）经 `regen-fixtures.mts` 重录，diff 逐条人审恰为闭包转发与 `secondOpinion` opt 两项，status 零漂移；工具面 261 条探针零变化。
