---
name: learnhub-study
description: 主持一次 learnhub 学习会话：动态推荐接下来该做的事（复习/继续/新课）、讲学节点、陪练练习题、判卷、记录评分（自动结算）再取下一批。用户说「开始学习」「今天学什么」「做题」时使用。
---

# learnhub 学习会话

主持完整的学-练-评闭环。数据权威在 vault：课程笔记 frontmatter 携带调度状态
（无数据库），一切变更只走 learnhub_* 工具。
学习节奏是动态的：不提前规划一天的任务，而是每做完一件事自动取下一批推荐。

## 会话流程

1. **开局**：`learnhub_recommend`（默认 5 条）拿跨课动态推荐队列：逾期复习 > 今日到期 > 半途未完成的课 > 新课（解锁后继多者优先 + 分区轮转）。把事件列给用户挑（每条带 type/course/node/score/why）。
2. **讲学**：用户选定后 `learnhub_lesson`（node+course，course 可省由引擎跨课唯一匹配）取学习包：分节正文（练习/反馈区已剔除、答案已并入例题，含图片与图表）+ 练习题 + 前置。逐节讲解，每节讲完确认用户听懂再进下一节。
3. **陪练**：题库作答流（allo 语义）——`learnhub_question_list` 取题目（single_choice/true_false/fill_in_blank/multi_choice/numeric/ordering/matching/reflection/open_question，不含答案），让用户作答后 `learnhub_question_answer` 自动判卷并落库（对错立判、错题公布答案与解析；reflection/open_question 由 AI 按评分要点判卷），无需再手工记录。节点没有题库或题不够：`learnhub_question_generate`（course+node+count）触发出题管线（与自动出题同门禁），或面板练习页「AI 出题」。
4. **收尾**：题目做完后 `learnhub_complete` 确认完成（正确率达标即过；未答题自动入复习循环；不满意可用 force 强制），或让用户在面板节点页确认。
5. **续学**：完成后再调一次 `learnhub_recommend`——队列已自动更新，向用户报下一批推荐并提议继续。

## 准则

- 评分必须来自用户本人的回忆质量判断，不要替用户打分；拿不准就问。
- 练习判错后先讲清错因再继续，必要时回讲知识点。
- 节点内容有问题时引导用户在笔记「内容反馈」区写意见，然后 `learnhub_feedback` 提交，进入重生成队列。
- 题目不够或太简单：`learnhub_question_generate` 补题；要改某道题的答案/解析用 `learnhub_question_update`（题库重新过校验才落盘），别手改题库 YAML。

## 课程生成

缺课正文时两条路共用同一门禁（大纲 → 逐节正文 → 自动出题；上下文包 + 可编辑提示词模板 state/提示词/课程大纲.md、课程节生成.md → 模型 → 质检门 → draft）：

- 面板「生成」页签一键生成（可选拾风格变体），生成后人审通过/打回；
- agent 侧用 `learnhub_generate`（course+node；可选 style 选节级风格变体，如苏格拉底/费曼），产出同样是 draft，需引导用户在面板「生成」页签人审通过后才能进入学习。超纲靠提示词与上下文包的「领域边界/禁止使用的概念」约束，质检门只警告不拦截，人审是最后关口。
