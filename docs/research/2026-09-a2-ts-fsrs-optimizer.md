# 调研：ts-fsrs 参数优化器可行性与记忆健康仪表盘数据核查（Arc A2 · issue #35）

- 日期：2026-09-08
- 状态：调研完成——优化器可行性、推荐接入路径、数据量下限与仪表盘数据缺口均已核实到一手来源，可直接支撑 A2 立项决策
- 来源说明：外部论断全部取自一手来源——open-spaced-repetition 官方仓库与官方发布包（ts-fsrs、@open-spaced-repetition/binding、fsrs-rs、fsrs-rs-nodejs、py-fsrs、fsrs-optimizer、fsrs4anki wiki）与 Anki 官方手册；其中 @open-spaced-repetition/binding 的 API 以 npm 实际发布的 0.5.0 tarball 解包核读为据（README + dist/index.d.ts + package.json），ts-fsrs 以本地 node_modules 实装 5.4.2 的 dist 导出面为据。本地「数据可用性」论断全部标注代码出处（文件:行）。
- 关联：`docs/research/2026-09-big-directions.md` §3 A2；领域词汇以仓库 `CONTEXT.md` 为准（Question / Review Queue / Forgot / Mastery / XP）

## 0. TL;DR

1. **ts-fsrs 不提供优化器**：现库实装 5.4.2（FSRS-6.0，21 参数），导出面实测全部是调度与预测 API，无任何训练/拟合导出。
2. **但官方 JS/TS 优化器已经存在**：`@open-spaced-repetition/binding`（ts-fsrs 官方 monorepo 的 packages/binding，npm 0.5.0 stable）把 fsrs-rs 的优化器编译成 napi 原生模块 + WASI 双形态，输入 `(rating, delta_t)` 序列即可训出参数向量，Node ≥ 20、含 win32-x64 原生二进制——learnhub（Node ≥ 22）可直接引入。
3. **数据量下限（官方口径）**：Anki 24.04 要求 ≥ 400 条复习日志（更早版本 1000；24.06+ 无硬下限但按数据量决定优化哪些参数）；每天每卡只算第一条；只用 Again/Good 二值评分也能训好；月频重训足够（或每累计 2^n 条重训）。learnhub 日粒度、每题每天至多推一次卡，与该口径天然对齐。
4. **仪表盘三件套**：「每日负载预报」「FSRS 记忆状态分布」字段已齐（题库 q.fsrs 全量聚合即可）；「真实保留率」「预测 vs 真实」「按复习时点的遗忘曲线」缺一份**逐次复习日志**——自评 2/4 档不落流水、复习时点 R/S 未快照、「完成学习」的合成首复习无记录。初始版可用 practice 流水重放近似；稳态版补一条 append-only 复习日志（约 8 字段）即全部转准。

## 1. 问题一：能否「从作答历史重训 21 参数」

### 1.1 ts-fsrs 现状（一手实测）

- `package.json:69`：`ts-fsrs: ^5.4.2`；node_modules 实装 5.4.2，`FSRSVersion = "v5.4.2 using FSRS-6.0"`，`default_w` 为 **21 个元素**（FSRS-6 参数向量）。
- 导出面核查（`node_modules/ts-fsrs/dist/index.d.ts` 与 `index.mjs` 末尾导出清单）：`fsrs` / `generatorParameters` / `createEmptyCard` / `forgetting_curve` / `get_retrievability` / `next` / `restart` / `migrateParameters` / `checkParameters` … 全部是**调度与预测** API；`grep -i optim` 零命中。**结论：ts-fsrs 不含优化器。** 官方立场同句（binding README Notes）：「For scheduler-only workloads, use ts-fsrs.」
- 现库消费点：`src/engine/srs.ts:25-41` `getScheduler` 读 `state/fsrs参数.json` 的 `parameters` 数组（21 参数）注入 `generatorParameters({ request_retention: 0.9, enable_fuzz: false, enable_short_term: false, w })`；该文件靠外部落盘（`src/engine/paths.ts:65`），无优化器入口。**即：只要有人产出 21 参数写进这个文件，调度侧零改动。**

### 1.2 JS/TS 生态的替代路径（open-spaced-repetition 官方，2026-09 现状）

| 路径 | 形态 | 现状（版本/日期） | 备注 |
|---|---|---|---|
| **`@open-spaced-repetition/binding`** | fsrs-rs 优化器的官方 JS 绑定：napi 原生模块（含 `binding-win32-x64-msvc` 等 11 个平台包）+ WASI 回退（`binding-wasm32-wasi`，浏览器可跑） | npm **0.5.0**（2026-06-06，Node ≥ 20）；0.6.0-beta.2（2026-08-13，Node ≥ 24）；README 明示 **public beta，API 可能变** | ts-fsrs 官方 monorepo `packages/binding`；浏览器端有现成先例（Chrome 扩展「FSRS Parameter Optimizer」） |
| `fsrs-rs-nodejs` | fsrs-rs 的 napi 原生绑定（13 平台二进制） | npm 0.9.1（2026-08-20） | 官方但 README 是脚手架文档，API 文档弱于 binding |
| `fsrs-optimizer`（Python） | 官方优化器 CLI/库：`python -m fsrs_optimizer revlog.csv` | PyPI 6.5.0 | 输入 schema：`card_id` / `review_time`(ms) / `review_rating`(1–4) / `review_state`(0–3 可选) / `review_duration`(可选) + `timezone`/`day_start` |
| `py-fsrs`（PyPI 包名 `fsrs`） | 官方 Python 调度库，**现自带 optimizer extra**：`pip install "fsrs[optimizer]"`（torch/numpy/pandas），`Optimizer(review_logs).compute_optimal_parameters() / compute_optimal_retention()` | PyPI 6.3.2 | 官方注明结果「may be slightly different than the numbers computed by Anki」 |

- fsrs-rs 本体是 Rust 参考实现（Anki 内置），README 自述「FSRS for Rust, including Optimizer and Scheduler」，另有 C/Dart/PHP 等官方绑定；`compute_parameters` 即从 `FSRSItem{reviews:[FSRSReview{rating, delta_t}]}` 训参。
- **回答票面问题：官方 JS 优化器不是空白**——不必退而求其次走 Python，进程内方案就是 `@open-spaced-repetition/binding`。

binding 0.5.0 的关键 API（解包 `dist/index.d.ts` 实测）：

- `FSRSBindingReview(rating: number, deltaT: number)`：rating 1–4；**首复习 deltaT 必须为 0**；`FSRSBindingItem(reviews)`＝某张卡按时间序的复习序列。
- `computeParameters(trainSet: FSRSItem[], { enableShortTerm, numRelearningSteps, trainingConfig, progress, timeout }) → Promise<number[]>`：返回参数向量（d.ts 标注 `number[]`；fsrs-rs 6.x 训练 FSRS-6，docs.rs 同时带 FSRS5/FSRS6 默认 decay 常量——落盘前按 `length === 21` 断言即可兜底）。
- `convertCsvToFsrsItems(csv, nextDayStartsAt, timezone, offsetProvider)`：Anki revlog.csv 格式转换（learnhub 可不走 CSV，直接构造 Item）。
- `evaluateWithTimeSeriesSplits(trainSet, options) → { logLoss, rmseBins }`：时序切分评估，即 Anki「Evaluate」按钮同口径。
- `computeOptimalSteps(...)`：学习/重学步推荐——learnhub 日粒度 `enable_short_term=false`，用不上。

### 1.3 数据量下限与重训频率（官方原句）

fsrs4anki 官方 tutorial（Anki 手册 FSRS 章节的底本）：

- 数据量：**「In Anki 24.06+, there is no minimum number of reviews required for optimization. Based on the number of reviews available, Anki will decide which parameters to optimize. In Anki 24.04, at least 400 reviews are required; in older versions, at least 1000 reviews are required.」**
- 健康检查（Anki 手册）：**「Low number of reviews (less than a few hundred). As a machine learning algorithm, FSRS needs data to learn from.」**
- 口径：**「FSRS only takes into account one review per day.」**（每卡每天只算第一条——learnhub「一题一天只推进一次调度」天然一致）
- 评分档位：**「Internally, FSRS treats Again as 'fail' and Hard/Good/Easy as 'pass'.」**；FAQ Q8 明确只用 Again/Good 也能训好。
- 重训频率：**「Once per month should be more than enough. A more sophisticated rule is to optimize after every 2^n reviews: after 512, then after 1024, then after 2048, etc.」**；Anki 手册同义：「once every month is sufficient」。
- 换算到 learnhub：复习日志条数 = 推卡次数。按每天 20–40 条复习的强度，**约 2–3 周可到 400 条**；不足 400 条时保持官方默认参数（tutorial 明示默认参数已远优于 SM-2，不必急于训参）。

### 1.4 推荐接入路径

1. **训练器**：新增依赖 `@open-spaced-repetition/binding`（0.5.x stable；Node ≥ 20 与本仓 `engines: >=22` 兼容；win32-x64 有原生二进制）。因为是 public beta，把对它的调用封装进单文件（如 `src/engine/optimize.ts`），隔离 breaking change。
2. **数据构造**：从 practice 流水重建每题复习序列——按 `qid` 分组、按 `ts` 排序、**每卡每天取第一条**；rating 映射 `correct → 3`、`错/Forgot → 1`；补上「完成学习」的合成首复习（见 §2.2）；复习刷卡流的自评 2/4 档初版近似按 3（官方背书二值可用，补了 §2.4 的日志后转准）。产出 `FSRSBindingItem[]`。
3. **训练与评估**：`computeParameters(items, { enableShortTerm: false, numRelearningSteps: 0 })` 对齐 `srs.ts` 的日粒度语义；`evaluateWithTimeSeriesSplits` 得 logLoss / RMSE(bins)，连同训练条数、日期一起写进 `fsrs参数.json` 元数据（可追溯）。
4. **落盘**：参数数组写 `state/fsrs参数.json` 的 `parameters` 字段——`getScheduler` 已消费，**调度侧零改动**。门禁：< 400 条不写（保持默认/现参），评估指标不优于现参也不写。
5. **频率**：月频滚动（或每 +2^n 条），做成手动触发的工具命令而非自动管线（与 Anki「优化不自动发生」同理，避免个人数据少时被噪声参数来回扰动）。

## 2. 问题二：记忆健康仪表盘的数据核查

### 2.1 流水与状态里现在有什么（代码事实）

- **practice.jsonl**（`src/engine/store.ts:78-92`、`src/engine/types.ts:103-117`）：`ts / course / node / ex / answer / correct / judge / qid? / feedback? / elapsed_s? / xp?`。`judge` 为题型名，Forgot 申报为 `'forget'`（`src/engine/index.ts:968-973`）。
- **journal.jsonl**（`types.ts:88-100`）：`ts / course / node / rating / kind / elapsed_days / session? / duration_s? / detail? / xp?`——但 `kind` 全是内容/XP/图账目（`content_*`、`xp_bonus`、`xp_settle`、`graph_*`…），**不是逐次复习日志**。
- **题库**（`src/engine/question-bank.ts:47-51`）：`q.fsrs{stability, difficulty, due, last_review, reps, lapses}` + `q.stats{attempts, correct, last, pending_rating?}`——每题当前快照。
- **评分映射**：练习流 `correct → 3 / 错 → 1`（`index.ts:886-889`）；Forgot → 1（`index.ts:967`）；复习刷卡流答对挂起、背面自评 2/3/4 经 `questionRate` 结算——**只推卡、不落流水**（`index.ts:928-951`）；「完成学习」给没作答过的题写入**合成 rating=3 的首复习**（`index.ts:1088`），不产生 practice 记录。
- 聚合先例：`reviewQueue` 已扫全部题库收集 due ≤ today（`index.ts:757-784`）；`activityCounts` 按日聚合 journal+practice（`store.ts:57-73`）。

### 2.2 逐项清单（已有 / 缺失）

| 仪表盘元素 | 需要的数据 | 结论 |
|---|---|---|
| **每日负载预报**（Anki Forecast + Daily Load = Σ1/I） | 全部题卡的 `due` 与 `stability` | ✅ **已有**：题库 q.fsrs 全量聚合即可（reviewQueue 同款扫描）；forecast 口径「假设不再学新卡且不遗忘」、不含已逾期——Anki stats.html 定义 |
| **FSRS 记忆状态分布**（Stability/Difficulty/Retrievability 直方图） | `q.fsrs` + 当前 R | ✅ **已有**：`srs.ts::retrievability`（`get_retrievability`）现成 |
| **真实保留率**（Pass/Fail 口径：每天第一条、Again=Fail、mature/young 分组） | 复习事件 + 正确性 + 复习时点的间隔/稳定度 | ⚠️ **半有**：Pass/Fail 可从 practice 的 `(qid, ts, correct)` 按 (qid, 天) 去重直接算出（自评 Hard/Good/Easy 都算 Pass，不受 2/4 档丢失影响）；但 mature/young 分组需要复习时点的 stability——当前题库只有最新值，历史区间要靠重放 |
| **预测 vs 真实保留率** | 每次复习时点的 R 预测 vs 实际 rating | ⚠️ **半有**：真实侧有 correct；预测侧——**学习者预测字段不存在（E4 的事），初始版只能用 FSRS 自身预测**；当前时点的 R 可算，历史时点的 R 需按 §2.3 重放（近似） |
| **按复习时点的遗忘曲线**（retention vs elapsed，按 stability/resets/lapses 分桶） | 逐次 `(S_before, elapsed_days, rating)` 序列 | ❌ **缺失**：需重放近似或补日志（§2.4） |
| 自评 2/4 档的准确留痕 | `questionRate` 的 rating 落流水 | ❌ **缺失**：现只推卡（S/D 变化可反推但脆弱） |
| 「完成学习」合成首复习的留痕 | 初始化 rep 的记录 | ❌ **缺失**：无 practice 记录（可用 `reps` 与 practice 计数差检测并合成补齐） |

### 2.3 重放可行性（初版不增字段能做到多少）

- **调度是确定性的**：`enable_fuzz=false + enable_short_term=false + 日粒度`（`srs.ts:35-40`）→ 同一参数下，`(rating, elapsed_days)` 序列可精确重放出历史 S/D/R。
- **输入可重建**：practice 按 (qid, 天) 去重 + 乱猜过滤（`elapsed_s < 5s` 且答错不推卡，`params.ts:24`、`index.ts:841-842`）+ 合成首复习补齐 → 与 Anki「每天第一条」口径一致。
- 近似误差来源：(a) 自评 2/4 按 3 近似（官方 FAQ 背书 Again/Good 二值照样准）；(b) 历史重放用的是当前参数（对**训练**无影响——训练本就要在候选参数下重算；对**历史仪表盘**有轻微失真）；(c) 历史上参数更换时点无版本记录。

### 2.4 建议的最小数据增量（稳态版）

新增一条 append-only 复习日志（如 `state/review-log.jsonl`），在每次 FSRS 推进处（`applyRating` 的三个调用方：练习流、`questionRate`、`questionForget`，外加 `nodeComplete` 的合成初始化）追加：

```
{ ts, course, node, qid, rating: 1-4, rating_source: 'auto'|'self',
  elapsed_days, stability_before, difficulty_before, r_pred }
```

一次落点覆盖全部三个缺口（自评档位、复习时点快照、合成首复习）；此后真实保留率、预测对照、遗忘曲线分组**全部免重放、流式累计**，且与优化器输入（`rating + delta_t`）同源——这一条日志是仪表盘与优化器的共同地基。

### 2.5 结论

- A2 两半均可行：优化器是「接现成官方包」，仪表盘是「一道聚合 + 一条新流水」。
- 建议顺序：**先补 review-log**（改动极小，立刻让仪表盘与未来重训的数据变准）→ 仪表盘初始版（负载预报 + 记忆状态分布 + 真实保留率重放版）→ **训练器**（攒满 400 条复习后启用，月频滚动，评估达标才写回 `fsrs参数.json`）。

## 主要出处

**本地代码（一手，路径相对仓库根）**：`package.json:69`；`src/engine/srs.ts:25-41,74-79,118-127`；`src/engine/paths.ts:65`；`src/engine/params.ts:4,6,24`；`src/engine/store.ts:29-92`；`src/engine/types.ts:28-35,88-117`；`src/engine/question-bank.ts:47-51`；`src/engine/index.ts:841-842,866-889,928-973,1081-1092,757-784`；`node_modules/ts-fsrs/dist/index.d.ts`（5.4.2 导出面与 `FSRSVersion`/`default_w` 实测）

**官方仓库与包**：

- @open-spaced-repetition/binding（npm 0.5.0 tarball 实测：README / dist/index.d.ts / package.json）：<https://www.npmjs.com/package/@open-spaced-repetition/binding>；仓库（ts-fsrs monorepo）：<https://github.com/open-spaced-repetition/ts-fsrs>
- fsrs-rs（含 Optimizer 与各语言绑定索引）：<https://github.com/open-spaced-repetition/fsrs-rs>；docs.rs（fsrs 6.6.2，ComputeParametersInput）：<https://docs.rs/fsrs/latest/fsrs/>
- fsrs-rs-nodejs：<https://github.com/open-spaced-repetition/fsrs-rs-nodejs>；npm 0.9.1：<https://www.npmjs.com/package/fsrs-rs-nodejs>
- py-fsrs（内置 optimizer extra）：<https://github.com/open-spaced-repetition/py-fsrs>；PyPI fsrs 6.3.2：<https://pypi.org/project/fsrs/>
- fsrs-optimizer（PyPI 6.5.0，输入 schema）：<https://pypi.org/project/fsrs-optimizer/>
- fsrs4anki 官方 tutorial（数据量下限 / 每天第一条 / Again-Good FAQ / 重训频率 / 评估指标）：<https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md>

**Anki 官方手册**：

- Deck Options · FSRS（Health Check 数据量提示、月频优化、Desired retention）：<https://docs.ankiweb.net/deck-options.html>
- 统计页（True Retention 口径、Forecast/Daily Load、Card Stability/Difficulty/Retrievability 定义）：<https://docs.ankiweb.net/stats.html>
