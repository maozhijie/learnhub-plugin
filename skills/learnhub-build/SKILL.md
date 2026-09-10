---
name: learnhub-build
description: learnhub 课程构建与修订 SOP：与学习者讨论课程、修订正文、补题、调图时，明确什么该直接回答、什么必须用 learnhub_* 工具、什么可以编辑 vault 课程笔记。用户说「修订这一课」「改一下正文」「帮我补几道题」「调整课程结构」或从学习中心面板「与 AI 讨论本课」进入时使用。
---

# learnhub 课程构建与修订 SOP

会话里带课程上下文包（节点正文/题库摘要/掌握度/图位置）。先判断请求属于哪一类，再按对应纪律行动：

## 1. 纯答疑 / 讲解（不动任何文件）

学习者问概念、要解释、要例子 → 直接回答。答案只依据上下文包里的本课正文与本课范围；
确需引用课程外知识时明确声明「本课之外」。绝不顺手改文件。

## 2. 题库 / 调度 / 图结构（必须走 learnhub_* 工具）

题库条目、FSRS 调度状态、图结构、节点 stage、课程注册表、state/ 流水——**只经工具**，
禁止手改 YAML/JSON：

| 意图 | 工具 |
|---|---|
| 出题 / 补题 | `learnhub_question_generate`（模型管线，与自动出题同门禁）或 `learnhub_question_save`（整份手写题库） |
| 查题 / 改题 | `learnhub_question_list`（不含答案）/ `learnhub_question_get`（单题全量含答案，改题前先看原题）/ `learnhub_question_update`（patch 合并后重新校验，`{archived:true}` 隐藏题） |
| 调度/状态/进度 | `learnhub_status` / `learnhub_recommend` / `learnhub_rebuild` |
| 图探索 / 图结构增删改 | 逐步查询：`learnhub_graph_node`（单节点详情+前置闭包）/ `learnhub_graph_browse`（区/块浏览）/ `learnhub_graph_path`（前置路径链）；增删改 `learnhub_graph_propose`（schema 速查与批次纪律见该工具描述；edit 生长批门禁过后自动 apply，种子提案一次人审；修订类变更人审后 `learnhub_graph_apply`）——**禁止直接改 data/*.yaml** |
| 节点跳过/完成 | `learnhub_skip` / `learnhub_complete` |
| 重新生成内容 | 单节点 `learnhub_generate`；整课重来 `learnhub_course_reset`（备份到 .trash 后台重跑，先向用户确认） |

## 3. 课程正文修订（可编辑 vault 课程笔记）

学习者对某节正文提修改意见 → 允许直接编辑课程笔记 .md（路径见上下文包/`learnhub_note_resolve`）。
修订纪律：

1. 保留 frontmatter 不动（stage/fsrs/content/practice 全部是引擎资产）。
2. 保留 `## 承上启下`、`## 内容反馈` 两节与文末 `<!-- enc_candidates -->` 机器块。
3. 保留既有 `​```interactive` / `​```mermaid` / `​```media` 引用块与其文件，除非学习者明确要求改。
4. 改完**必须**跑 `learnhub_content_check`（course + node），把 findings 全部修复后再告知完成；
   warns 如实转述。
5. 大改（重写全节/换讲解风格）建议走 `learnhub_generate` 重新生成（`style` 参数选节级风格变体，如苏格拉底/费曼），而不是手改。

## 4. 交互实践节点（type: practice）

图里标 `type: practice` 的节点交付物是 `​```interactive` 交互件（HTML 存 `<课程根>/交互/`）。
修订交互件 = 编辑那个 .html 文件（自包含、禁外联、结尾保留 LEARNHUB_COMPLETE 上报脚本），
改完同样跑 `learnhub_content_check`。

## 汇报约定

每次动手后用一句话说清：改了什么文件/调了什么工具、质检结果、下一步建议（学习者在面板里刷新即可看到）。
