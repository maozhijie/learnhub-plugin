# 调研：E1 学习者产出卡的 schema 与归属设计

- 日期：2026-09-08
- 状态：调研报告（供 grilling 票 #46 直接引用决策；**不替 #33 拍板**，语义边界按工作假设推演，见 §6）
- 来源说明：一手来源 = 本地代码契约（`src/engine/`、`ui/src/`，论断标注文件:行号）；文献依据引用既有调研笔记 `docs/research/2026-09-big-directions.md` §7 E1 / §8.3 / §9（Pan 2023、Myers 2024 等，本报告未做新线上调研）；外部产品仅作形态参照并显式标注。

## 0. TL;DR

1. **归属**：倾向**独立学习者卡域**（独立目录 + 独立 schema + 独立门禁），不做「题库题加学习者字段」。核心理由：题库的聚合消费面（掌握度/完成门禁/XP 定价/完成代表卡）全部按「扫全部未归档题」实现，同池要靠六处逐点防守「不进掌握度」；独立域则结构性免触碰（§2）。
2. **分池**：倾向**独立「我的卡」队列**（独立入口、复用复习刷卡会话组件），不在 Review Queue 与 AI 题同池排序；「每题每天一次推进」不变量靠卡自身 `stats.last` 门禁实现，与分池不冲突（§3）。
3. **卡面**：新增 3 种卡面形态（提示重述 / 挖空重述 / 自注讲解），**不进 `AlloKind` 九题型集合**——判分走复习自评语义（Hard/Good/Easy + 忘记），AI 只在创建时给非控制性反馈、不做判分入账；接入点清单见 §4（文件级）。
4. **门禁**：独立 `validateLearnerCards`：非空、kind 白名单、长度上限、关联字段非空、派生块（fsrs/stats）只透传、控制字符拒绝；markdown 渲染面与题干同链（渲染链默认转义 HTML），不放宽（§5）。

---

## 1. 现状基线（代码事实）

### 1.1 题库契约与门禁

- `BankQuestion` 字段（`src/engine/question-bank.ts:32-52`）：`id / kind(AlloKind) / q / answer / options? / explanation? / difficulty? / uses? / tags? / tol? / section? / archived? / fsrs?(FsrsBlock) / stats?{attempts, correct, last?, pending_rating?}`。
- **九种题型 kind**（`question-bank.ts:56-59`，同 `src/engine/grading.ts:75-77`）：`single_choice / true_false / fill_in_blank / reflection / multi_choice / numeric / ordering / matching / open_question`。
- 判分语义（`grading.ts:92-157` `evaluateAllo`）：规则判卷七种（对 1.0 / 错 0.0）；`reflection` 与 `open_question` 必须走 AI 判卷通道（`grading.ts:110-113、148-152` 显式禁止规则判卷降级；引擎在 `index.ts:816-831` 分派），及格线 `PASS_SCORE = 0.6`（`grading.ts:89`）。
- `validateBank`（`question-bank.ts:71-185`）：顶层 `node` 非空、`questions` 非空数组；逐题校验 `kind` 合法（88 行）、题干非空（91 行）、按 kind 校验 `answer` 形状（single_choice 要 options+字母、fill_in_blank 要可接受答案、reflection 要评分要点……97-158 行）；`fsrs/stats` 只透传不做内部校验（173-175 行注释：「调度/统计块由作答侧写入，schema 只透传」）。
- **全部写路径过同一门禁**：整库 `save`（233-242）、单题 `addQuestion`（263-275）、`updateQuestion`（279-297，作者字段白名单 `QUESTION_AUTHORING_FIELDS = q/answer/options/explanation/difficulty/uses/tags/section/tol`，62-64 行；id/kind/fsrs/stats/archived 是身份或派生块，不能经内容修订改动）、作答侧 `updateQuestionEvidence`（300-324，fsrs/stats 只能整体替换）、`archiveQuestion`（327-338）。
- **Missing/Broken 纪律**：`load` 文件缺失返回空题库（合法 Missing），存在但 YAML/契约坏则抛 Broken、绝不静默当空库（`question-bank.ts:198-207`，`loadDoc` 247-254 同）；这是 ADR-0004 的既定原则（`data-check.ts:4`：「Missing 是合法空状态，Broken 是对象存在但无法解析或未通过契约」）。

### 1.2 复习流与「每题每天一次推进」不变量

- `reviewQueue`（`src/engine/index.ts:757-786`）：遍历全部启用课程的题库目录（`paths.bankDir`，`paths.ts:57`），跳过 archived，取 `fsrs.reps` 存在且 `due <= today` 的题，扁平队列按 due 升序（同日按节点名、题 id）；**不含从未调度的新题（due=null，入口在学习流）**；前置 `assertNoBrokenNotes` fail loud（762 行）。
- `questionAnswer`（`index.ts:799-914`）：判卷 → `correct = score >= PASS_SCORE` → practice 流水 + 节点 frontmatter 证据（EMA + stage 推进，851-865）→ 题目级 FSRS 推卡（对=3、错=1，886-889）。关键分支：
  - **每日一次不变量**：`repeated = (q.stats?.last === today && Boolean(q.fsrs?.reps))`，重复作答只记练习统计、不再碰调度卡（842 行 + 866-874 注释「每题每天至多推进一次」）；乱猜（耗时过短且答错，841 行）同样不推卡、负 XP。
  - **复习流挂起**：`opts.deferSchedule === true && correct` 时调度挂起，给 Hard/Good/Easy 三档到期预览，`stats.pending_rating` 标记（877-885）。
- `questionRate`（`index.ts:931-952`）：自评 2/3/4 → `applyRatingBlock` 推卡；准入 = `stats.last === today && stats.pending_rating`（挂起标记是唯一准入，938-941）；只推卡、不记流水、不给 XP。
- `questionForget`（`index.ts:957-1006`）：不作答直接翻面，rating=1 推卡、stats 按答错记、0 XP；当日已有作答记录则拒绝（963-965）。
- 复习自评语义是**刻意分岔**（ADR-0006）：复习流自评（自评只进记忆参数）、练习流自动映射，两处作答语义不许被「统一」。

### 1.3 题库的聚合消费面（归属方案 A 的实质成本所在）

以下六处全部按「遍历全部未归档题」实现，学习者卡若混入题库会被自动卷入：

| 消费点 | 位置 | 行为 |
| --- | --- | --- |
| 节点「作答正确率」 | `index.ts:1009-1020` `nodeMastery` | Σcorrect/Σattempts 聚合**全部未归档题** stats |
| 完成门禁 | `index.ts:1059-1066` `nodeComplete` | 正确率 < 0.6 拒绝完成 |
| 完成时初始化调度 | `index.ts:1081-1092` | 全部无 `fsrs` 的未归档题被初始化 FSRS 卡（明天起刷） |
| 节点代表卡 | `index.ts:1081-1092` | 全部未归档题中**到期最早**的卡写回节点 frontmatter `fsrs`（`repCard`）——它是 `masteryOfFm` 稳定度分量的输入（`srs.ts:141-156`） |
| 到期/正确率快照 | `index.ts:181-217` `bankSnapshot` | 复习队列计数、struggle 提示、面板通用轮组装 |
| XP 定价校准 | `index.ts:1160-1163` `xpStatus` | `nominalBudget(est, activeQs) × difficultyCalibration(activeQs)` 用全部未归档题 |

### 1.4 自建题入口（学习者与 AI 同池的既有事实）

- 题目管理页自建题：`ui/src/pages/BankPage.tsx:22-102`（九题型动态表单）→ `POST /question-add`（`src/index.ts:801-807`）→ `bank.addQuestion`——**AI 出题（`index.ts:1293-1342` `questionGenerate`、1347-1404 `questionGenerateSections`）与学习者自建题共用同一 `BankQuestion` 契约、同一题库文件**（`课程根/题库/<节点>.yaml`，`question-bank.ts:194-196`）。
- 既有先例「非题库产出独立结算」：交互件 `interactiveSettle`（`index.ts:1406-1441`）——不碰题目 FSRS（交互件不是题库题）、不进节点掌握度，只走 practice 流水与 EMA。

### 1.5 前端渲染与复习会话

- 题型渲染分发：`ui/src/components/QuestionCard.tsx:129-145`（`isChoice/isMulti/isNumeric/isOrdering/isMatching/isText` 布尔分发；`isText` 三题型共用 TextArea）；提交载荷统一 string（148-155）；`KIND_LABEL` 九标签（47-50）。`variant='review'`（复习刷卡变体）：提交走注入的 `submitter`（deferSchedule 挂起）、5 秒忘记门控（20-21、119-127）、背面正确答案块、footer 注入自评按钮（92-107）。
- 复习会话：`ui/src/pages/LearnPage.tsx:159-306` `ReviewSession`——**纯组件**，队列由调用方传入（`queue: ReviewCard[]`），自评键盘 2/3/4（210-221）、忘记（204-207）、小结（262-283）；入口横幅 `ReviewBanner`（50-65）与课程卡过滤（501-505）。
- 练习会话：`ui/src/components/PracticeFlow.tsx:54-109` `buildRounds`（manifest 驱动装配轮次）；每题一次学习只作答一次（166-168）。
- Markdown 渲染链：`MdView/InlineMd` 走 react-markdown + remark-math（`ui/src/components/MdView.tsx:40-67`，默认不放行原始 HTML）；引擎侧粗排 `md.ts` 有全量 `esc()` 转义（`ui/src/components/md.ts:4-13`）。题干/选项/反馈都走这条链。

---

## 2. 问题一：归属方案——独立学习者卡域 vs 题库加学习者字段

### 2.1 方案 A：题库题加学习者字段（或学习者卡作为题库题入同文件）

做法：`BankQuestion` 增加 `origin: 'learner'` 之类字段 + 新 kind，或学习者卡直接走 `addQuestion` 进 `题库/<节点>.yaml`。

利：
- 复用面最大：`reviewQueue`（扫题库目录）、`questionAnswer/Rate/Forget`（按 qid 定位）、`validateBank`、题目管理页 `questionsAll`，几乎零改动学习者卡即自动获得调度与复习（`index.ts:757-786、799-1006`）。
- 题目管理页已有自建题入口（`BankPage.tsx:22-102`），「学习者卡」形似自建题的一种，UI 心智连续。

弊（按严重度）：
1. **统计污染是结构性的，不是字段级的**。§1.3 的六个消费点全部「扫全部未归档题」：学习者自注卡的作答会自动进「作答正确率」、动完成门禁（ADR-0007 明确正确率只服务完成门禁）、被 `nodeComplete` 初始化 FSRS、甚至成为 `repCard` 污染 `masteryOfFm` 的稳定度分量。要维持「不进掌握度」（§6 工作假设）就得在六处逐点加 `origin` 过滤——每处都是未来口径分裂的隐患（#19 的教训：两口径并存导致同一存储字段写读不一致，ADR-0007）。
2. **契约不匹配逼出伪数据**。`BankQuestion.answer` 是必填且有按 kind 的形状校验（`question-bank.ts:97-158`），自注卡的「答案」是学习者自己的表述、不可预知、无判分语义——硬塞进九题型只能造假答案或再造一个走后门的 kind；而新 kind 进 `AlloKind` 会同时改动 `KINDS`（question-bank.ts:56）、`evaluateAllo`（grading.ts:92）、AI 出题提示词的题型集合（`loadPrompt('题目生成')`，index.ts:1310）与前端 `QuestionKind`/`KIND_LABEL`（`ui/src/types.ts:74-77`、`QuestionCard.tsx:47-50`）——**AI 出题契约被学习者功能扰动**。
3. **生命周期错位**。题库是生成产物：整课重置时 `题库/` 目录整体移入 .trash（`index.ts:561-566` `contentReset`）。学习者产出是学习者资产，不应随「重新生成整课」被回收（哪怕可恢复）。
4. **frontmatter/目录纪律**。题库文件按节点一文件、`node` 字段绑定节点（`question-bank.ts:75、181-183`），隐含「题目从属于节点」（CONTEXT.md Question 词条：「当前固定从属于一个节点」）。学习者卡的生命周期应随学习者，且未来可能挂在节而非节点级（§4 的关联字段设计）。

### 2.2 方案 B：独立学习者卡域（倾向）

做法：独立目录（如 `课程根/我的卡/<节点>.yaml`，`paths.ts:57` 旁新增 `learnerCardsDir`）+ 独立 schema `LearnerCard` + 独立门禁 `validateLearnerCards`（结构镜像 `question-bank.ts` 的手写校验与错误行风格）。

利：
- **统计隔离是结构性的**：不进题库目录就不会被 §1.3 任何消费点扫到——「不进掌握度/不算 XP」不需要任何防守代码，错误状态不可表示。
- **契约干净**：不动 `AlloKind`/`validateBank`/`evaluateAllo`/AI 出题提示词；自由文本卡的字段按自身语义设计（无伪答案）。
- **生命周期正确**：`contentReset` 只移 `题库/交互/课程图` 三个目录（`index.ts:561`），学习者卡天然幸免；课程删除时可独立决定去留。
- **有先例**：交互件已走过「非题库产出、独立结算、不碰题目 FSRS、不进掌握度」的路（§1.4，`index.ts:1406-1409` 注释）。
- 形态参照（**仅形态意义、无规模证据**）：Obsidian Spaced Repetition 插件的内联卡挂在学习者自己的笔记域、Mochi/RemNote 的牌组归属模型也是「自建卡独立于生成内容」。

弊（可控）：
1. 作答通道要新建：`questionAnswer` 按 qid 在题库内定位（`index.ts:809-811`），学习者卡需要独立 answer/rate/forget 通道。**缓解**：调度原语本来就是卡级的——`applyRatingBlock`/`previewDue` 不依赖节点（`srs.ts:118-136`），「每日一次 + 挂起自评」的门禁逻辑（stats.last / pending_rating 检查）可以在学习者卡 stats 上原样复制（§3.2）。
2. 卡与节点/节的关联无外键校验，节点重生成/改名后可能悬空——按 Missing 纪律处理为「合法悬空、展示标注」，不升级为 Broken（关联是软引用，卡本体契约完好）。

### 2.3 倾向与理由

**倾向方案 B（独立学习者卡域）**。一句话：方案 A 的复用是「省一次遍历」，代价是把学习者过程资产灌进六个掌握度/定价/门禁消费面再逐点打补丁；方案 B 的成本是「多写一个 300 行量级的卡域模块」，收益是 #33 语义边界、ADR-0007 口径、AI 出题契约三者零扰动。数据契约上 `answer` 必填语义与自注卡根本冲突，是硬伤而非权衡项。

---

## 3. 问题二：与 AI 出题同池 or 分池

### 3.1 同池（混进 Review Queue 排序）的问题

- Review Queue 的语义是「到期题卡按 due 升序逐张出示」（CONTEXT.md Review Queue 词条；`index.ts:757-786`）。学习者卡混入后：卡面认知操作不同（先主动重述再翻面对照自评，不是判卷型作答），混排打断 Anki 式刷卡节奏；due 相同时的插序规则（AI 题优先还是我的卡优先）没有自然答案。
- 预算挤占：复习横幅的到期数（`LearnPage.tsx:50-65`）与队列长度会被学习者卡稀释，Myers 2024 的警示（自出题/自测占主线反而劣化后测）提示**学习者产出的增益来自「自造」动作本身，不要求它占据调度主通道**（big-directions §7 E1）。
- XP/到期数纯净度：横幅与 XP 条是主界面一级信号，混池后任何「学习者卡不计 XP」的豁免都要在共享通道里特判（again：逐点防守）。

### 3.2 分池对「每题每天一次推进」不变量的影响：无冲突

不变量的实现完全在单卡自身证据上：`questionAnswer` 的 `stats.last === today` 检查（`index.ts:842`）、`questionForget` 的当日拒绝（963-965）、`questionRate` 的 `pending_rating` 挂起准入（938-941）。学习者卡独立域后在自己的 `stats` 上做同样三项检查即完整继承不变量——不变量是「每**卡**每天至多一次推进」，不依赖队列如何拼装。分池只改「队列从哪拉、入口怎么摆」，不改推卡语义。

### 3.3 倾向：独立「我的卡」队列 + 节点动线轻量插入点

- **主入口**：LearnPage 增加「我的卡」横幅/入口（与 `ReviewBanner` 并列），到期学习者卡进独立队列，复用 `ReviewSession` 的会话骨架（它是纯组件，吃 `ReviewCard[]` 形状数据，`LearnPage.tsx:159-306`；学习者卡条目补齐同形字段即可）。
- **插入点**（可选、后置）：节点学习页（LessonView）完成后追加「本节我的卡」轻量复习——对应「仅在关联节复习时插入」形态，作为分池的补充而非替代。
- 理由：(a) 语义边界（不算 XP/不进掌握度）在独立队列下天然成立；(b) 与 ADR-0006「不同意图的作答用不同入口语义」的刻意分岔风格一致；(c) 队列 UI 复用成本极低；(d) 不变量无冲突（§3.2）。
- 折中记录：若 #46 认为独立入口太重，「同池但学习者卡恒排在同 due AI 题之后 + 队列内分段标签」是次优可行解——但 XP/正确率豁免的逐点防守成本仍在，不建议。

---

## 4. 问题三：卡面形态与复习流接入点清单

### 4.1 现有题型与链路定位

- kind 集合：九种（`question-bank.ts:56-59`）；规则判卷七种 + AI 判卷两种（`grading.ts:75-77`；引擎分派 `index.ts:816-831`）。
- 渲染：`QuestionCard.tsx:129-145` 按 kind 布尔分发；提交载荷 string（148-155）。
- 复习链路：`reviewQueue`（engine）→ `LearnPage.ReviewSession`（UI）→ `QuestionCard variant='review'` + deferSchedule submitter + footer 自评。

### 4.2 新卡面形态（三形态，脚手架优先）

对应 big-directions §7 E1 的证据排序（Pan 2023 生成效应 d≈0.45；Myers 2024 → 改写/举例/自注优先于自由自出题；Chi 1994 自解释），三种 `card_kind`：

| card_kind | 卡面 | 复习交互 | 创建脚手架 |
| --- | --- | --- | --- |
| `recall_cue` 提示重述 | 正面 = 提示/线索（一句「用自己的话讲 X」+ 可选线索） | 心理重述 → 翻面看自己当初的自注 + 节要点对照 → 自评 | AI 从节要点生成提示候选 |
| `cloze_rewrite` 挖空重述 | 正面 = 学习者改写的挖空句 | 心里补空 → 翻面对照 → 自评 | AI 从正文节抽候选句供改写 |
| `self_explain` 自注讲解 | 正面 = 节/题主题 | 重讲 → 翻面对照 → 自评 | 创建时可附 AI 非控制性反馈（哪里偏离、可怎么补） |

**判分语义**：一律复习自评语义（答对挂起 → Hard/Good/Easy；5 秒门控忘记），**不走 `evaluateAllo`、不走 AI 判分入账**（big-directions §7 E1：「不做判分入账」）。AI 的角色限定在创建时的脚手架与非控制性反馈，不是 judge——这是与 `reflection`/`open_question` 的本质区别（后者 AI 判分入账、进正确率）。

**实现取向**：新建 `LearnerCardCard` 组件而非给 `QuestionCard` 加 kind 分支——复习交互是「重述→翻面→自评」三段，无判卷反馈区，与判卷型作答卡结构不同；且 `AlloKind`/`QuestionKind`/`KIND_LABEL` 是题库契约，不应被学习者功能撑大。

### 4.3 接入点清单（文件级）

方案 B（独立域）落地需要动的文件：

**引擎（src/）**
1. `src/engine/learner-cards.ts`（**新增**）：`LearnerCard` 接口 + `validateLearnerCards` + load/save/add/update/archive（镜像 `question-bank.ts` 的类结构与 Missing/Broken 语义）。
2. `src/engine/paths.ts`：新增 `learnerCardsDir`（57 行 `bankDir` 旁）。
3. `src/engine/types.ts`：`LearnerCard` 类型（`FsrsBlock` 复用，28-35 行）。
4. `src/engine/index.ts`：`learnerCardAnswer/Rate/Forget`（自评语义三件套，复用 `applyRatingBlock`/`previewDue`，复制 stats.last/pending_rating 门禁）、`learnerQueue`（独立到期队列）、`learnerCardAdd/Update/Archive`、脚手架反馈通道（llmComplete 注入，镜像 `questionGenerate` 的 host 注入模式 1293-1342）。
5. `src/engine/srs.ts`：**零改动**（`applyRatingBlock`/`previewDue` 已是卡级原语，118-136 行）。
6. `src/index.ts`：HTTP 路由 + 工具契约（镜像 `/question-answer` 等端点 779-835）；`src/tool-contracts.ts` 如需入参守卫。
7. `src/engine/data-check.ts`：`DataCheckArea` 加 `learner_cards` 区（18 行），盘点 Missing/Broken。

**前端（ui/）**

8. `ui/src/types.ts`：`LearnerCardItem` / 复习条目类型（`ReviewCard` 187-190 旁）。
9. `ui/src/api.ts`：新 api 方法。
10. `ui/src/components/LearnerCardCard.tsx`（**新增**）：三段式卡面（§4.2）。
11. `ui/src/pages/LearnPage.tsx`：「我的卡」横幅/入口 + 学习者卡复习会话（复用 `ReviewSession` 骨架 159-306）。
12. `ui/src/components/LessonView.tsx`：节点学习页「加我的理解」入口（创建表单 + 脚手架反馈展示）。
13. `ui/src/pages/BankPage.tsx` 或独立页：学习者卡管理（编辑/归档）。

方案 A（题库加字段）的对比清单（更长且跨契约，供权衡）：`question-bank.ts`（KINDS + validateBank + 白名单）、`grading.ts`（AlloKind + evaluateAllo 分支）、`index.ts`（判分分支 + 六个聚合面逐点过滤，§1.3）、AI 出题 prompt 约束（防 AI 出这种 kind）、`ui/src/types.ts`（QuestionKind）、`QuestionCard.tsx`（KIND_LABEL + 分发）、`BankPage.tsx`（表单）。

---

## 5. 问题四：validate 门禁清单（学习者自由文本卡）

独立 `validateLearnerCards`（镜像 `validateBank` 的手写风格与错误行格式，`question-bank.ts:66-68`），规则清单：

1. **结构与身份**：顶层 `node` 非空且与期望节点一致（镜像 expectedNode 检查，181-183）；`cards` 非空数组；每卡 `id` 非空唯一（缺省自动编号 `c1…`，镜像 addQuestion 266-269）。
2. **kind 白名单**：`card_kind ∈ {recall_cue, cloze_rewrite, self_explain}`（初始集合，非法即 Broken——镜像 kind 检查 87-89）。
3. **非空**：`prompt`（正面提示）与 `content`（学习者自注文本）trim 后非空——「自由文本卡」最核心的两条；`cloze_rewrite` 额外要求 content 含至少一个挖空标记（如 `{{…}}` 且挖空段非空）。
4. **长度上限**：`content` ≤ 2000 字符、`prompt` ≤ 500 字符。定性：这是**卫生约束**（防「把整课粘贴成一张卡」、防单文件膨胀拖慢每日全库扫描——`reviewQueue`/`bankSnapshot` 每天全量 load），不是学习效果主张。
5. **关联字段**：`source_node` 非空字符串（schema 层只查非空；图内存在性校验在引擎层做，失败按悬空 Missing 展示标注、不 Broken）；`source_section` 可选、非空即查。
6. **派生块只透传**：`fsrs`/`stats` 由作答侧写入，schema 只透传不内校验、作者通道白名单不含它们（镜像 `question-bank.ts:173-175` 与 `QUESTION_AUTHORING_FIELDS` 纪律 61-64）。
7. **渲染面与题干同等，不放宽**：「禁止 markdown 注入」的准确表述是——学习者文本走与题干相同的渲染链（InlineMd/MdView，react-markdown 默认不放行原始 HTML；`md.ts:4-13` 全量 `esc()` 转义，见 §1.5），schema 层加两条硬拒绝：控制字符（除换行/制表）与 YAML 解析层面的破坏性输入；**不引入比题干更宽的渲染能力**（不放行原始 HTML 块）。允许与题干同等的行内 Markdown/LaTeX 文本（BankPage 题干本就支持 LaTeX 文本，`BankPage.tsx:80`）。
8. **Missing/Broken 纪律**：文件缺失 = 合法空卡组；存在但 YAML/契约坏 = 抛 Broken、绝不静默当空库（镜像 `load`/`loadDoc`，198-207、247-254）；`reviewQueue` 与学习者队列同门：Broken fail loud（镜像 `assertNoBrokenNotes`，index.ts:762）。
9. **重复创建防呆**：同 `source_node + source_section + card_kind` 的活跃卡允许存在多张（改写多次是合理行为），但同 content 哈希重复拒绝（防连点重复建卡）。

---

## 6. 与 #31 / ADR-0007 的共存，及 #33 工作假设（显式处理）

- **工作假设声明（不替 #33 拍板）**：本报告按「学习者产出一律不算 Mastery、不算 XP、不推节点 stage/EMA」的**工作假设**推演（big-directions §8.3 第 3 条的待定稿立场）。若 #33 最终决议不同，§2.3/§3.3 的倾向需要重估——这是本报告唯一的敏感依赖。
- **#31 已决议（per-question FSRS 卡是题目固有属性）与学习者卡带 FSRS 的共存**：学习者卡的 `fsrs` 块是**卡自身的调度状态**（复习对象是它自己），与题库题的 `fsrs` 块同性质——调度状态落盘从来不是 ADR-0007 禁止的事（节点 frontmatter `fsrs` 与题库 `fsrs` 都落盘）；ADR-0007 禁止的是**把 Mastery 本身写盘**与**把正确率当 Mastery**。共存条件（方案 B 下全部结构性满足）：
  1. 学习者卡的 fsrs/stats 只存在于学习者卡文件，不写节点 frontmatter（作答通道不调 `applyPracticeEvidence`、不推 stage——与题库题作答链路的刻意差异，`index.ts:851-865` 那段对学习者卡不执行）；
  2. 不进 `nodeMastery` 聚合、不当 `nodeComplete` 的 `repCard`（独立目录天然不被扫到，§1.3）；
  3. 不结算 XP（不进 practice 流水的 xp 记账，或恒 0 且不进 settle 对账）；
  4. 复习对象是学习者卡自身，不参与节点 mastery 聚合——`masteryOfFm` 的输入（节点 frontmatter fsrs + practice，`srs.ts:141-156`）不含学习者卡的任何字段。
- 换句话说：**学习者卡带 FSRS 卡不顶撞 ADR-0007，混进题库才顶撞**（repCard 与完成门禁会吃进去，§1.3 表）——这也是 §2 倾向独立域的又一理由。

## 7. 留给 #46 的决策点

1. 归属：是否采纳独立学习者卡域（§2.3）？目录名与课程删除时的去留策略。
2. 分池：独立「我的卡」队列为主入口（§3.3）？是否要 LessonView 的「本节我的卡」插入点、何时做？
3. 卡面：三形态初始集合是否认可？`cloze_rewrite` 的挖空语法（`{{…}}`）定稿。
4. 门禁：长度上限数值（本报告建议 2000/500）与「同 content 哈希防重复」是否入契约？
5. 依赖确认：#33 决议前 E1 不进入实施票（本报告 §6 的敏感依赖）。

## 8. 出处

**本地代码（一手，文件:行号以 2026-09-08 工作区为准）**

- `src/engine/question-bank.ts`（BankQuestion 契约 32-52；KINDS 56-59；作者白名单 61-64；validateBank 71-185；load/save/add/update/evidence/archive 187-338）
- `src/engine/index.ts`（bankSnapshot 181-217；reviewQueue 757-786；questionAnswer 799-914；questionRate 931-952；questionForget 957-1006；nodeMastery 1009-1020；nodeComplete 1048-1133；contentReset 537-573；questionsAll 1230-1259；questionGenerate 1293-1342；questionGenerateSections 1347-1404；interactiveSettle 1406-1441）
- `src/engine/grading.ts`（AlloKind 75-77；PASS_SCORE 89；evaluateAllo 92-157；AI 判卷系统词 168-230；applyPracticeEvidence/EMA 234-249）
- `src/engine/srs.ts`（applyRatingBlock 118-127；previewDue 130-136；masteryValue/masteryOfFm 141-156）
- `src/engine/types.ts`（FsrsBlock 28-35；Fm 38-55；PracticeRec 102-117）
- `src/engine/paths.ts`（bankDir 57 等目录约定 42-63）
- `src/engine/notes.ts`、`src/engine/data-check.ts`（Missing/Broken 纪律；data-check.ts:4 ADR-0004 原则）
- `src/index.ts`（question 端点 559-835）
- `ui/src/components/QuestionCard.tsx`（KIND_LABEL 47-50；分发 129-155；review 变体 92-127）
- `ui/src/components/PracticeFlow.tsx`（buildRounds 54-109；一次作答 166-168）
- `ui/src/pages/LearnPage.tsx`（ReviewSession 159-306；ReviewBanner 50-65）
- `ui/src/pages/BankPage.tsx`（自建题表单 22-102）
- `ui/src/types.ts`（QuestionKind 74-77；QuestionItem 79-94；ReviewCard 187-190）
- `ui/src/components/md.ts`、`ui/src/components/MdView.tsx`（渲染链转义）

**领域文档**

- `CONTEXT.md`（Question/Review Queue/Mastery/Practice Evidence/Forgot 词条）
- `docs/adr/0006-review-vs-practice-rating-split.md`（复习/练习评分刻意分岔）
- `docs/adr/0007-mastery-canonical-derived-not-persisted.md`（Mastery 唯一 canonical 派生不落盘；#19/#31 决议）

**文献依据（引自既有调研笔记，本报告未做新线上调研）**

- `docs/research/2026-09-big-directions.md` §7 E1（Pan et al. 2023 生成效应 d≈0.45；Myers et al. 2024 自出题无益警示 → 脚手架优先：改写/举例/自注优先于自由自出题；「不做判分入账」）；§8.3 第 3 条（学习者产出不算掌握度不算 XP 的边界，待 #33 定稿）；§9 反模式。
- 形态参照（仅形态意义、无规模证据）：Obsidian Spaced Repetition 插件内联卡语法；Mochi / RemNote 的卡片归属（牌组）模型。
