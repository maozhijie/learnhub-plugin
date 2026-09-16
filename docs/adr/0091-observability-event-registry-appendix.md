# 调试日志附录事件登记表：#259 巡检增量（闭集外新事件与指针级事件统一入册）

ADR-0080 建立了调试日志的事件闭集，但闭集是**当票快照**不是登记制：此后每次接线都要回头改 0080 正文，既改历史裁决又让闭集清单越来越像流水账。#259 的四路沉默路径审计一次性盘出了约 40 条待接事件（吞错点、fail-loud 缺位、静默兜底、指针级补齐），散在内容/题库、图/教练、调度/笔记源/宿主三个接线票里——登记需要一个**只增不改**的附录位，0080 正文闭集不动。

理由：事件名的权威登记处必须先于接线存在（T2–T4 票面明文「事件名与级别以附录 ADR 登记为准」），否则三张票各起各名，门册与排查手册就对不上账。本 ADR 只做登记与判据，不含任何代码变更；行为修复走三张独立修复票（#294–#296，各以原生 blocking 指回 #259）。

关键裁决：

- **附录登记制：本 ADR 是 ADR-0080 之后的增量事件唯一登记处。** 0080 正文闭集（17 条）不动；此后接线的新事件先入本表再接线，历史裁决不被追改。命名规范与级别原则沿用 0080：事件名点分小写、字段 `snake_case`、进出/结果 = INFO、拒收与"触发修复" = WARN、死亡/失败 = ERROR、逐轮轨迹与尺寸明细 = DEBUG。
- **接日志是默认；唯一豁免判据是"必须复述他处字段才有用"。** 指针级事件是默认形态：日志只做索引（计数/指针/为什么），细节留在其权威通道（journal、data-check 报告、`GATE_FAILED` 续行、logGradingFailure）——日志不复述他处字段即无双写漂移（ADR-0080「不落原文」的延伸，判据是防"两份事实"，不是防"日志多"）。
- **接线分三票，登记归一。** 下表「票」列指向接线票（#290 content/bank、#291 graph/coach、#292 sched/note_source/host）；实现票以本表为事件名权威，落地后不许漂移改名。
- **已在代码未登记的四条先补登记**（`coach.draft.*`，#273 草稿回路接入时产出、漏登 0080 闭集）：登记先于接线，存量欠账同表清偿。

## 附录事件登记表（#259 巡检增量 · 全量）

### content/bank 族（接线票 #290）

| 事件 | 级别 | 字段 | 备注 |
|---|---|---|---|
| `content.gate.lenient` | WARN | `node` `section` `over_by` | 满编降级的引擎内视图（此前零留痕） |
| `content.gate.alias_missing` | INFO | `node` `section` | alias 门失活 |
| `content.gate.section_reject` | DEBUG | `section` `errors=<n>` | 指针级：错误清单已在 `GATE_FAILED` 续行，日志只记计数 |
| `content.queue.line_skipped` | INFO | `course` `node` | 生成队列行跳过 |
| `content.repair.rich_blocks` | INFO | `node` `blocks=<n>` `langs=<n>` | 指针级：fixRichBlocks 修复计数，细节目 journal（违背 ADR-0030 自家纪律的补账） |
| `content.pack.registry_broken` | INFO | `course` | contentPack 登记表降级 |
| `content.review_queue.fallback` | DEBUG | `why=io\|missing` | reviewQueue 读异常与 Missing 分流留痕（io=EBUSY/EPERM 类应浮出，missing=合法空态） |
| `bank.gate.registry_broken` | WARN | `course` | bank 侧登记表降级 |
| `bank.card.bank_broken` | WARN | `course` `node` | 题库 Broken（候选/复诊面排除路径） |
| `bank.card.skip_broken` | DEBUG | `node` | Broken 卡跳过轨迹 |
| `bank.card.broken_seen` | DEBUG | `node` | 指针级：明细在 data-check 报告 |
| `bank.quiz.section_parse_fail` | WARN | `node` `section` | 逐节出题 YAML 解析失败 |
| `bank.quiz.admit_fail` | WARN | `course` `node` `qid` | admitQuestion 失败留痕（过渡期——修复票 #294 落地后收编为 ERROR 或随 fail-loud 消失） |
| `bank.quiz.cancelled` | WARN | `course` `node` `added_so_far=<n>` | 取消时半批已入库量留痕 |
| `bank.quiz.grading_retry` | DEBUG | `kind` `attempt` | 指针级：明细在 logGradingFailure |

### graph/coach 族（接线票 #291）

| 事件 | 级别 | 字段 | 备注 |
|---|---|---|---|
| `graph.apply.bank_follow_miss` | WARN | `course` `node` | apply 时题库随迁目标缺失 |
| `graph.proposal.scan_skip` | DEBUG | `kind` `id` | 提案去重扫描跳过 |
| `graph.mine.bank_skip` | WARN | `course` `node` | 挖矿面题库 Broken 排除 |
| `growth.draft.corrupt` | WARN | `course` `session` | 生长草稿档损坏 |
| `growth.tally_skip` | WARN | `course` | 三率 tally 折损 |
| `graph.reject_compensate_fail` | ERROR | `kind` `id` | graphReject 补偿失败（两处：半途提案滞留 pending） |
| `compass.eta.skip_fail` | WARN | `course` `detail` | ETA 挂载跳过原因 |
| `coach.plan.summary_miss` | DEBUG | `course` | 上次裁决摘要缺失（重裁族注入面空） |
| `coach.plan.reinject` | DEBUG | `course` `mode=repair` | runPlan 修复轮回灌观测（feedback 与 previousYaml 同源现状的留痕——修复轮盲修事实见修复票 #296） |
| `coach.checkpoint.fail` | WARN | `trigger` `course` `error` | 检查点检查失败（触发五点） |
| `coach_growth.stuck_read_failed` | WARN | `course` | 卡点读取失败 |
| `coach_growth.stuck_consume_failed` | WARN | `course` `targets=<n>` | 卡点消费标记失败 |

### sched/note_source/host 族（接线票 #292）

| 事件 | 级别 | 字段 | 备注 |
|---|---|---|---|
| `sched.params_fallback` | INFO | `source` `course` `why` | 损坏参数缓存静默回退官方默认参（学习质量漂移的可见性） |
| `sched.optimize.meta` | DEBUG | `execution_included` `execution_rows` | 指针级：混训门写回元数据 |
| `note_source.anki_export_skipped` | WARN | `source` | 镜像侧 Broken 静默漏源 |
| `note_source.ease_unknown` | DEBUG | `button` | 指针级：mapAnkiEase 未知样本进日志 |
| `host.gen_jobs.persist_failed` | ERROR | `error` | 注册表落盘吞错的出口留痕 |
| `host.gen_jobs.pump_escape` | ERROR | `job` `error` | 泵级 catch 兜住执行器抛错（任务将滞留 running——修复票 #296） |
| `host.gen_jobs.run_error` | ERROR | `job` `error` | 任务执行失败 |
| `host.gen_jobs.retention_swept` | INFO | `swept=<n>` | 保留期出册留痕 |
| `host.gen_jobs.sweep_skip` | WARN | `course` `why` | 悬空/畸形记录出册跳过 |
| `api.experiments.report_failed` | WARN | `error` | 实验报告读取失败（面板收到 report=null 的原因留痕） |
| `host.log.sweep_failed` | WARN | `file` `error` | log-file 保留期清扫逐文件失败（不中断其余文件清扫） |

### 存量补登记（已在代码、漏登 ADR-0080 闭集——接线票 #292 顺带核对字段一致性）

| 事件 | 级别 | 字段 | 备注 |
|---|---|---|---|
| `coach.draft.enter` | INFO | `course` `session` `resumed` | 草稿回路进入（执行官段起点） |
| `coach.draft.handover` | INFO | `course` `operator` `steps=<n>` | 思路官交接计划注入执行官 |
| `coach.draft.unfinished` | WARN | `course` `session` `unpublished=<n>` | 禁止空手结束触发（ADR-0088 裁决 8）——草稿保留待续建/取消 |
| `coach.draft.exit` | INFO | `course` `session` `finished` | 草稿回路退出 |

### 既有事件补字段（不新开事件名）

| 事件 | 级别 | 增量 | 备注 |
|---|---|---|---|
| `host.gen_jobs.restored` | INFO | + `skipped_malformed=<n>` | 恢复时畸形记录计数（ADR-0080 闭集内事件） |

### console 侧处置（非 logger 事件）

- `log-file.ts` 的 `levelFromEnv` 收到非法 `LEARNHUB_LOG_LEVEL` 值时 `console.warn` 一次（级别门实现住宿主，此处无 logger 可用——console 是唯一出口），接线票 #292 落地。

边界：

- **本 ADR 零代码变更**：登记 ≠ 接线。接线按票列分三张（#290/#291/#292），每票过 G4/G5 基线同步与假 logger 断言；行为修复（吞错、fail-loud 缺位、补偿回路）走 #294/#295/#296，不与本表混装。
- **`admit_fail` 是过渡期事件**：修复票 #294 把 admitQuestion 的 IO 失败与单题非法分流后，本事件随之升级或退役——退役时在本表标注，不删行。
- **指针级事件的细节通道**就是「备注」列点名的权威通道；接线时不得把细节字段加进日志（防漂移判据的执法点）。
- **门册**：接线落地后由 #293 把「关键路径已接日志 + 事件名清单」记入 `tests/README.md` 门册——本表是事件名权威，门册是验收登记，二者不互替。

替代方案（否决）：

- **扩 ADR-0080 正文闭集**——每票接线都追改历史裁决正文，闭集清单膨胀成流水账；勘误与增量分离（0080 勘误段 + 本附录）各司其职。否决。
- **只写进各接线票、不入 ADR**——三票各自维护事件名清单，门册与排查手册无单一权威出处，改名漂移无人执法。否决。
- **事件名集中注册表常量（代码侧 `EVENTS` 对象）**——登记的权威面是文档（门册、人审、排查手册都读文档），代码侧注册表反而制造第二事实源。否决（若日后事件名拼写门需要机器可读清单，从本表派生，不反向）。

取号：0091（写前 `ls docs/adr/` 确认，0090 已占）。票面：#289 观测面扩展 T1（附录 ADR 登记 + ADR-0080 勘误 + 三张修复票建出）；父票 #259。
