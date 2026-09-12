# N-of-1 白名单增补练习侧变量：回执评审模式（receipt_review_mode）

决议（#203 收口，2026-09-13）：N-of-1 实验变量白名单（ADR-0023 裁决 1 红线）增补首个**练习侧**变量——**回执评审模式**（`receipt_review_mode`，臂 = `ai` / `self`），并交付其双变体通道与练习侧实验模板（`receipt_review_ai_vs_self`，outcome=`practice_ema`、unit=`batch`——受 #135 接口不变式约束）。裁决细目：

1. **白名单资格**：回执评审模式是引擎可控的**反馈/评审设计参数**（量表来源、评审深度、评分者归属同属课程设计面），不是调度核心——回执零 XP、零 FSRS 触碰、不进任何门禁（ADR-0016 裁决 5），「canonical 事实源不是赌注」的红线天然满足；干预侧在练习（回执评分），配练习侧结局（practice_ema）符合「结局侧跟干预侧」的预登记映射（#135 裁决 8 拒掉的是调度侧变量配练习侧结局，本变量不触此禁）。
2. **双变体通道（变量交付）**：臂 `ai` = 既有 AI 量表评审（ADR-0016 现状，rubric = 实践节点内容要点，full/brief 渐退照旧）；臂 `self` = 学习者自评分入账——提交回执时学习者直接给 0–1 量表分（可附一句话自评总评），**不调 LLM**、`review_mode='brief'`（只评分+总评，无逐条拆解——自评形态下语义照旧成立）、流水带 `source: 'self'`（旧流水缺此字段读侧视同 `'ai'`）。两档同一落盘（`state/回执.jsonl`）、同一 EMA 入账（`applyPracticeEvidence` 同权 0.7/0.3）、同一分析器（#135 练习侧采集按 `score` 原值入局）。**渐退位只数 AI 评审回执**：自评回执不产 AI 反馈、不消耗 full 评审频率位（`next_full_in` 对自评回执返回 null）——臂交替下 AI 反馈节奏保持 ADR-0016 原样。`self_score` 缺省/非数字/越界（<0 或 >1）一律 fail loud，不静默钳制（工具参数通则：只允许缺省与合法值两种形态）。
3. **配置面**：全局默认档 = `state/learnhub.json` 的 `receipt_review_mode`（缺省 `'ai'`，维持 ADR-0016 现状）；实验在跑且变量匹配时，**当日臂覆盖默认**（批次按学习日轮换，scope_course 只约束范围内课程的回执）。`force_full`（越级完整评审）是 AI 臂语义：自评臂日提交 `force_full` fail loud；AI 臂日提交 `self_score` 同样 fail loud（两臂口径不混）。
4. **方法论局限（如实登记，进模板文案）**：自评臂的结局分出自学习者本人——臂间差是**评分者口径差与行为差的联合效应**（自评通常偏宽），不是纯干预效应。N-of-1 本就只主张个体联合效应（报告措辞锁「不是人群结论」）；模板 question/description 明写这一点，学习者知情后自决。
5. **执行事件密度候选否决**：参数口径未定义（渐退反馈建议频率？阈值？无引擎可控的两档实现），登记了也发不起（unlocked=false 无意义）——白名单不为「将来可能有」的参数占位；待口径定义后再议。

同批被拒：执行事件密度入白名单（口径未定、无双变体通道）；把回执评审模式做成 per-course 常驻配置（v1 只需要全局默认 + 实验覆盖，多一层配置面无消费方）。

工程影响（供执行票消费，非本决议约束）：`NOF1_VARIABLE_WHITELIST` 增补；`ReceiptLogRec` 加 `source` 可选字段（缺省 ai，读侧归一）；`submitReceipt` 分派评审模式（learner-cards 入口先解析当日生效档）；lab 加配置读写与当日成立解析（`receiptReviewMode` / `setReceiptReviewMode` / `receiptReviewEffect`）；模板登记 `receipt_review_ai_vs_self`（unlocked=true——通道随本票交付）。ADR-0023 的调度核心红线、数据边界（零 XP / 不进 Mastery / 优化器混训不特判）全部不变——本变量只重排「谁给回执评分」，不动任何调度与账本语义。
