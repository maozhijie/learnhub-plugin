---
name: learnhub-review
description: learnhub 复盘与定时任务：周复盘学习历史、巡检逾期节点，并用 schedule_create 注册每日学习提醒/逾期巡检/周复盘三条定时提醒。用户说「复盘」「定时提醒」「每天提醒我学习」时使用。
---

# learnhub 复盘与定时任务

## 复盘流程

1. **取数**：`learnhub_status` 看各课程进度与状态分布；`learnhub_graph_analyze` 看遗忘热点、瓶颈、不可达节点；读 `state/journal.jsonl`（调度流水）与 `state/practice.jsonl`（作答流水）了解近期学习节奏。
2. **结论**：哪些节点反复评 1-2（需重讲或拆细）、哪些长期未复习（逾期）、图谱结构是否失衡。
3. **行动**：
   - 结构问题 → 按 learnhub-graph-optimize 提 edit 提案；
   - 内容问题 → 引导内容反馈或委派 `subagent_exercise_gen` 补题；
   - 大型复盘直接委派 `subagent_reviewer`，它产报告并可自行提交 edit 提案。
4. 复盘报告讲给用户；所有变更仍走提案门禁，apply 前必须用户点头。

## 定时任务（schedule_create）

本部署挂了 `dsh-schedule`，用 `schedule_create` 注册三条提醒（自然语言时间需换算成显式参数）：

| 任务 | 注册方式 | 提醒内容 |
|---|---|---|
| 每日学习提醒 | `every_seconds: 86400` | 「用 learnhub_recommend 取今日推荐队列，汇报今天的学习/复习安排」 |
| 逾期巡检 | `every_seconds: 86400` | 「检查 learnhub_status 中的逾期复习节点，提醒用户优先处理」 |
| 周复盘 | `every_seconds: 604800` | 「执行 learnhub-review 技能的复盘流程并向用户汇报」 |

指定具体时刻用 `at: { date, time, time_zone: "Asia/Shanghai" }`；注册后用 `schedule_list` 核对，`schedule_delete` 清理重复项。

**已知限制（须向用户说明）**：提醒是会话级投递——只有注册它的那个 dsh 会话保持活跃时才按时触发；会话关闭期间的到期提醒会在下次恢复时补发（每类只补最新一次）。
