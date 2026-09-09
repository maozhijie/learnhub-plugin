# 推进机械收口 advance 模块：guard 概念单点化，评分语义留在调用方

决议（2026-09-09，架构深潜候选 1）：题库卡/笔记源卡/我的卡/Anki 回填/合成初始化九处各自开放编码的刷卡推进流水线，收口为纯函数模块 `src/engine/advance.ts`（域词「推进 Advance」，CONTEXT 词条）：模块只拥有机械——「当日已推进」判定、FSRS 当日重算、elapsed_days 推导、复习日志快照束（S/D 前快照 + r_pred）、作答统计合并；XP、账本组合（practice 流水 / review-log / 代表卡刷新）、评分语义（自动判定 / 复习自评档 / 合成 rating=3）全部留在调用方——ADR-0006 的复习/练习语义分岔原样保留，不因机械收口而被「顺手统一」。

**guard 是两个有名概念，不是一个开关**（实现期的关键修正——「一刀切双门」的最初设想被代码证据否决）：合成初始化（nodeComplete / 笔记源出题给未调度卡写 rating=3 锚点）写 `fsrs.last_review` 但**不写 stats、不占当日推进额度**——questionForget 的「完成学习当日初始化的卡允许覆推 Again」与笔记源出题当日的挂起结算/忘记都依赖这一点，且有测试覆盖。因此：

- `alreadyAdvanced`（真实推进判定）= `stats.last === day`：学习者通道（作答 / 忘记 / 我的卡 / 挂起结算外的全部入口）用它把守——只有真实互动消费当日推进额度。
- `alreadyScheduledOn`（vault 当日已有调度动作）= `stats.last === day || fsrs.last_review === day`：仅 Anki 回放用它（原 `sameDayAdvanced` 的更严拼法，收编进模块）——回放通道不得在 vault 当日已有任何调度动作（含合成初始化）时再推一次（ADR-0011 镜象从属地位）。

**同日重复真实互动的执法口径随收口变严一处**：练习流同日重复判定由 `stats.last === today && fsrs?.reps` 收紧为 `alreadyAdvanced`（去掉 reps 限定）——挂起作答（deferSchedule 答对，只记账不推卡）后的当日再作答，旧代码会绕过重复判定再推卡并**静默丢弃 pending_rating 标记**；新口径视为同日重复、只记统计，pending 态保持完整。这是对防刷不变量的修复而非收紧。

**为什么模块不写账本**：删除测试方向相反——账本组合差异恰是 ADR-0006 保护的语义面；模块若用旗标收编账本写入，会把语义决策伪装成配置、interface 反而变浅。施工形态：纯推进核心（零 store 依赖、scheduler 注入、day 参数化）+ 三个入口对应三类流（`advance` 守门联合返回 / `advanceStrict` 守门抛错、文案归调用方 / `advancePending` 挂起结算无守门——准入是调用方的 pending 旗标）；合成初始化不是推进，继续直连 `applyRatingBlock`（其准入「reps>0 跳过」与 guard 概念不同族）。

**附带的管道收敛**（候选 6 随行）：门面的 resolve → loadView → 断言门管道在推进路径换为 questionContext/nodeNote 深帮助方法；`getScheduler` 每次调用读参数盘改为门面实例级缓存，`optimizeFsrsParams`（唯一写者）写回后显式失效。
