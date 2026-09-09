# 调研：ts-fsrs 喂执行事件日志的工程可行性（2026-09-08）

- 日期：2026-09-08
- 状态：工程调研笔记（回应 wayfinder 票 #79；上游裁决对象 = 设计文档 §1.3 三层判据第②层「数学可复用、事件语义更换——执行事件调度」）
- 边界声明：机制层（睡眠依赖巩固、间隔期正增益、ACT-R 程序化保持曲线）不重述，一律交叉引用深潜笔记 `2026-09-tacit-knowledge-deepdive.md` §1/§3.6；本笔记只回答「FSRS 数学服务执行事件」的工程边界。源码证据 = 本仓库 node_modules 实装（ts-fsrs 5.4.2、@open-spaced-repetition/binding 0.5.0，检索日 2026-09-08）；行号以当前安装版本为准。生态动态（npm/GitHub 现状）标注检索日，非长期锚点。

## 0. TL;DR

1. **「优化器能否接受执行事件+表现评级」的答案分两半**：优化器（binding/fsrs-rs）在数据契约上只看 `(rating: 1-4 整数, delta_t: 天)` 序列（binding 类型声明原文 `/** 1-4 */`），**不关心事件来自答题还是执行**——只要表现评级映射到 1-4，重拟合管线原样可用；映射本身是唯一新增件，且无文献背书、属工程近似。
2. **任意表现评级不能直喂**：FSRS Rating 是封闭四值枚举。ts-fsrs 数学层对 [1,4] 内的分数值（如 2.5）有「算术容忍」（校验只查有限且 1≤g≤4），但 Hard/Easy 乘子按枚举精确判等，分数 g 会静默丢失乘子——契约外行为，不可依赖；优化器侧更是硬性 1-4。**评级映射是必选项，不是可选项**。
3. **stability/difficulty 外部注入是一等公民**：`Card.stability/difficulty` 是普通公开字段，`FSRSAlgorithm.next_state(memory_state, t, g, r?)` 就是纯状态转移函数（memory_state 外部传入、r 可外生覆盖）。仓库 `cardFromFm`（srs.ts）天天在注入，`SCAN_INIT_S/SCAN_INIT_D`（params.ts）是初始状态外部粗估的既有先例。换遗忘曲线在 ts-fsrs 侧有逐实例覆盖点，但契约脆弱（见 §2.4）。
4. **调度器与优化器是分离的，但 TS 侧不是没有优化器**：ts-fsrs 官方口径就是「w/o optimization」的纯调度器；优化器住在 fsrs-rs，TS 官方通道是 `@open-spaced-repetition/binding`（napi 原生 + WASI 双形态，public beta）——**仓库 optimize.ts 已接入该绑定**（月频重训 + ≥400 条写回门禁）。py 子进程/Rust 移植两条路都不需要走。
5. **非单调区间（睡眠增强期）：FSRS-6 幂律形式 R(0)=1 且对 t 单调，参数重拟表达不了「先升后降」**；但本仓库的日粒度设定（`enable_short_term=false`）天然把同日事件的中途增益吸收掉了，t≥1 天的增益最坏被截为「r≈1 的完美复习」——保守、单调安全。先走「评级映射吸收 + 短窗排除」，曲线族替换（覆盖 `forgetting_curve`+`next_interval`、自建拟合）是数据证明需要时的升级路径，不建议起步就做。
6. **推荐路线**：ts-fsrs 调度器 + 现行参数管线原样不动；新增「执行事件 → 表现评级 → 1-4 映射」通道（复用 `applyRatingBlock`，ReviewRec 扩 `rating_source` 或并行日志）；优化器后置启用（binding 已在位，`trainingSequences` 混入执行事件是小改）；非单调按第 5 条阶梯处理。

## 1. 仓库现状

1. **版本**：`package.json` dependencies：`ts-fsrs: ^5.4.2`、`@open-spaced-repetition/binding: ^0.5.0`。npm 检索（2026-09-08）：5.4.2 就是最新稳定版（2026-09-01 发布）；6.0.0 在 beta（beta.8，2026-08-30，将移除 `Date.prototype` 扩展——升级时需过一遍是否用到）；binding 最新即 0.5.0。
2. **调度（src/engine/srs.ts）**：`getScheduler` 用 `generatorParameters({ request_retention: DESIRED_RETENTION(=0.9), enable_fuzz: false, enable_short_term: false, w? })` 构造调度器；`w` 来自个人参数文件 `state/fsrs参数.json`（21 参数数组，优化器重训后写回），无则官方默认。**参数来源 = 优化器写回 + 官方默认兜底，仓库自己没有任何硬编码曲线参数**。
3. **状态注入（srs.ts `cardFromFm`，L44-59）**：frontmatter `fsrs` 块 → ts-fsrs Card 的显式字段赋值（stability/difficulty/reps/lapses，state 恒 Review）。这正是「外部注入/覆盖」已经在生产的证据——S/D 的权威存储是笔记 frontmatter，不是 ts-fsrs 内部。
4. **评分推进（srs.ts `applyRating`/`applyRatingBlock`）**：`RATING_BY_NUM` 把 1-4 映射到 `Rating`，越界回退 Good（L99）；`sched.next(card, now, rating)` 一步推进。调用方集中在 `index.ts`（练习流自动映射 `map.rating`、复习自评、忘记申报等 9 处调用点）。**执行事件通道的天然落点 = 新增一种 `map`（执行回执 → rating），复用 `applyRatingBlock` 即可，调度内核零改动**。
5. **可提取性（srs.ts `retrievability`）**：`sched.get_retrievability(card, now, false)`；复习队列排序、JOL、校准曲线（memory.ts 的 r_pred）都吃这个数。曲线若换族，R 的所有消费方自动跟随（都走同一实例方法）。
6. **memory.ts**：零 ts-fsrs 依赖的纯聚合（forecast/直方图/True Retention/校准/按时点遗忘曲线），`r_pred` 从复习日志快照取。**按时点遗忘曲线（`forgettingCurve`，L107-116）已按 elapsed_days 分桶**——「≤2 天」桶天然是观测睡眠增强期（保留率异常高甚至超基线）的现成观测面，无需新埋点。
7. **adaptive.ts**：只消费 `q.fsrs.difficulty` 与静态难度做等权合成、驱动会话内选题（`combinedDifficulty`），不触碰调度数学。执行事件若带难度信号，走同一合成口即可，无需新接缝。
8. **优化器（src/engine/optimize.ts）**：全部 binding 引用隔离在本文件（注释明言「ts-fsrs 无优化器导出；fsrs-rs 优化器经官方 binding 接入，public beta，API 可能变」）。数据契约：`trainingSequences` 从 `state/review-log.jsonl` 抽真实推进（auto/self，排除 synthetic），每卡每天第一条，首条 delta_t=0，产出 `(rating, delta_t)` 前缀展开序列；`computeParameters(items, { enableShortTerm: false, numRelearningSteps: 0 })` 与调度侧日粒度语义对齐；写回门禁 = ≥400 条（对齐 Anki 24.04 口径）+ in-sample 新旧参对照。**执行事件接入优化器 = 在 `trainingSequences` 的过滤条件里放行执行事件记录（rating 已是 1-4）——一个小 diff，不是新子系统**。

## 2. ts-fsrs 5.4.2 能力边界（源码证据）

### 2.1 Rating 语义 vs 任意表现评级

1. `Rating` 是封闭枚举：Manual=0，Again=1，Hard=2，Good=3，Easy=4；`Grade` = 排除 Manual 的四值。语义上 rating 是「自觉努力度/回忆质量」的粗分代理（FSRS wiki 口径），不是连续表现量表——**「任意表现评级」进入 FSRS 数学必须先落成四值**。
2. 校验行为（dist/index.mjs）：调度路径 `checkGrade`（L356-360）只拒绝非有限或越出 [1,4]；**[1,4] 内的分数（2.5）能通过校验**。数学路径 `next_state`（L944 起）只拒绝 g<0 或 g>4。但 `next_recall_stability`（L881-893）的 Hard/Easy 乘子是 `Rating.Hard === g`、`Rating.Easy === g` 的**精确判等**——g=2.5 会按「普通 Good」算稳定性增益、按连续值算难度增量（`next_difficulty` L852-860 的 `delta_d = -w6·(g-3)` 是线性算术）。结论：**算术上容忍、语义上未定义**——分数 g 静默给出「无乘子」的结果，官方文档不承诺任何行为，优化器（fsrs-rs）侧更是硬性整数。工程裁决：不依赖；映射到四值。
3. 顺带的一个可注入点（标注为**假设，无先例背书**）：`next_state(ms, t, g, r?)` 的 `r` 可外部提供——可以用执行表现合成一个 r_eff ∈ (0,1]（如 0.6+0.4·quality）替代曲线自算的 r。这不动曲线、不动参数，就把「表现好坏」喂进了稳定性更新（r 越低→回忆路径 S 增益越大？注意方向：FSRS 语义里 r 低=快忘了=这次成功回忆更值钱；r 高=轻松回忆=S 增益小。把「表现差但完成了」映成低 r 是语义错位的风险点，需实验裁决）。**放在这里是备选项登记，不是推荐**。

### 2.2 state（stability/difficulty）外部注入/覆盖

1. **可以，且是一等公民**：`Card.stability/difficulty` 是接口上的普通字段（index.d.ts L43-57）；`FSRSState { stability, difficulty }` + `next_state(memory_state, t, g, r?)`（L332）把「当前状态」作为显式入参而非隐藏状态。`reschedule(reviews, { update_memory_state })` 还支持从复习历史重放重建记忆状态。
2. 仓库实践与注入同构：`cardFromFm` 每次调度都从落盘 frontmatter 重建 Card；`SCAN_INIT_S=7.0 / SCAN_INIT_D=5.0`（params.ts）是「无复习史时外部粗估初始 S/D」的既有先例。**执行事件通道若需要初始化或纠偏 S/D，机制上零障碍**。

### 2.3 调度器与优化器：分离，但 TS 侧有官方优化器通道

1. **ts-fsrs 无优化器**：导出面（index.d.ts L593）只有调度与数学原语；README 直接把 `@open-spaced-repetition/binding` 列为「Optimizer package」（README L239）。OSR 官方在 Hugging Face 组织页把各实现分类为「w/o optimization: ts-fsrs、go-…」vs 带优化器的 fsrs-rs（检索日 2026-09-08）。
2. **fsrs-rs（crate 名 `fsrs`，检索时 5.0.1）**：Rust 实现，优化器（`compute_parameters`）+ 调度 + 模拟三合一，Anki 原生 FSRS 的底座。
3. **@open-spaced-repetition/binding 0.5.0**：fsrs-rs 的 napi-rs 绑定，**napi 原生 + WASI 双形态**（`dist/` 含 `.node` 各平台预编译与 `fsrs-binding.wasi-browser.js` 浏览器版——learnhub 面板是 web 平台，浏览器版路径存在但 optimize.ts 走主入口，native 不可用时才落 WASI）。导出：`computeParameters`（带 progress/timeout/trainingConfig）、`FSRSBinding.evaluate`、`evaluateWithTimeSeriesSplits`、`computeOptimalSteps`、`convertCsvToFsrsItems`。**public beta：官方明示 API 可能跨版本变化**——optimize.ts 的隔离层注释即为此对冲。
4. **py-fsrs**：Python 侧同样是「纯调度器」定位；优化器是独立的 `FSRS-Optimizer`（PyPI）包。对 learnhub（Node ≥22、插件形态、无 Python 运行时分发渠道），py 路线 = 子进程/旁路部署负担，**无必要**：binding 已覆盖同一 fsrs-rs 优化器。
5. **集成代价排序**：binding（已在位，边际成本≈0）≪ fsrs-rs 自建 napi（重复造官方绑定）≪ py 旁路（运行时分发问题）≪ 手工移植优化器（BW-RS/ML 训练循环，维护黑洞）。

### 2.4 换遗忘曲线的覆盖点（可行但脆弱）

1. `forgetting_curve` 在 `FSRSAlgorithm` 上是**实例箭头函数属性**（构造时 `this.forgetting_curve = forgetting_curve.bind(this, this.param.w)`，L701）；`get_retrievability`（L1663）与调度器的 R 计算都走 `this.algorithm.forgetting_curve`——**逐实例替换能同时接管 R 与调度读数**。
2. 但参数 Proxy 的 setter 会在 `w` 被写入时**重绑定并 clobber 实例覆盖**（L757：`_this.forgetting_curve = forgetting_curve.bind(this, value)`）。且间隔计算 `next_interval` 走 `interval_modifier = calculate_interval_modifier(request_retention)`（基于 DECAY=-w20 的解析反演）——换曲线族必须连 `next_interval`（及其依赖 `interval_modifier`）一并接管，覆盖面从 1 个属性变 3 个方法。
3. 更根本的：**binding/fsrs-rs 优化器只拟合标准 FSRS 曲线**——换曲线族后个人参数重训这条管线对自定义曲线失效，拟合得自建（scipy 旁路或手写梯度）。这是「换曲线族」真正的大头代价，不在 ts-fsrs 侧而在优化器侧。

## 3. 非单调区间（睡眠增强期）的处理选项

机制背景见深潜 §3.6：运动序列学习间隔期是主动增强（Walker 2002：一夜睡眠 20% 手指敲击速度提升，无准确率损失），而 FSRS 建模「间隔→衰减」。数学核心：FSRS-6 幂律 R(t,S) = (1+FACTOR·t/(9S))^DECAY（DECAY=-w20），**R(0)=1 恒成立、对 t>0 单调**——「表现超过练后基线」要求 R(t)>1 或显式增益项，该形式族内无解。参数重拟的最坏结果是把它吸收成「S 系统性偏大」，方向可预期但形态错误。

| 选项 | 做法 | 工程代价 | 保真度 | 备注 |
|---|---|---|---|---|
| A 评级映射吸收 | 睡眠增强后的执行表现好 → 映到 Easy（或映射表按预期表现校准） | 零数学改动；只写映射函数 | 粗：增益幅度与间隔相关（早期大后期无），四值映射对间隔不敏感，偏差方向=早期系统性高估间隔 | 起步必选；与票面「参数重拟」不冲突——映射先落地，参数重拟后置 |
| B 短窗排除/分段 | ≤24-48h 的执行事件不推进 FSRS 状态（只记账），巩固窗后首个事件才推进 | 低：与现行 `enable_short_term=false` 日粒度语义同构（同日 t=0 事件在 r=curve(0,s)=1 下本就是稳定性 no-op） | 中：把增强窗从「喂错」改为「不喂」，但窗内信息丢弃 | 起步必选；现日粒度设定已天然覆盖大半（见下） |
| C 曲线族替换/加增益项 | 如 R̃(t)=min(1,(1+c(t))·R(t))，c 为有界巩固增益；ts-fsrs 侧覆盖 `forgetting_curve`+`next_interval`+`interval_modifier` | 中-高：3 个覆盖点 + 防 w 写回 clobber + **自建参数拟合**（fsrs-rs 只拟合标准曲线） | 高（若增益项形态选对） | 数据证明需要再上；观测面现成（memory.ts forgettingCurve 的 ≤2 天桶出现超基线保留率） |
| D 换保持模型族 | 技能保持幂律（Anderson, Fincham & Douglass 1999，深潜 §1.4）+ 练习计数自变量的专用模型 | 最高：等于为第②层建独立调度器，FSRS 复用放弃 | 最高（语义对口） | 远期；裁决「第②层最终是否留在 FSRS 数学里」的备选，不是本票交付 |

**日粒度的天然缓冲（重要且常被忽略）**：仓库调度是日粒度（`enable_short_term=false`），同日重复执行不推进稳定性（r=1 → recall 路径增益=0）；跨夜（t=1）事件的 r=curve(1,s) 略低于 1，睡眠增强后的「超预期表现」最坏被截为「r≈1 的完美复习」——**保守、单调安全、不会喂出负增益或发散**。非单调性只在引入亚日粒度执行通道（小时级）时才成为真问题，而那正是设计文档 §1.4 排除的「亚秒级并发反馈引擎」的近邻，短期无此需求。

## 4. 推荐路线（分层，附证据与不确定性）

1. **通道层（立即，调度内核零改动）**：执行事件（真实执行+表现评级）→ 确定性映射函数 → 1-4 → 复用 `applyRatingBlock` 推进；落盘复用 ReviewRec 结构，`rating_source` 扩 `'execution'`（诚实度统计同 synthetic 一样可过滤）或建并行执行日志。映射输入建议用可观测的执行证据（准确率/耗时/自主求助次数），不用主观分。证据：applyRatingBlock 调用面已集中在 index.ts 的 `map.rating` 模式；不确定性：**1-4 映射的保真度无文献背书**，FSRS rating 语义（回忆努力度）与执行表现不完全同构——映射是工程近似，需在真保留率/校准曲线上验证偏差方向。
2. **优化器（后置启用，机制已在位）**：执行事件量过门禁（≥400 条）后，把 `'execution'` 记录放行进 `trainingSequences`（或按事件类型分参数集）。证据：optimize.ts 数据契约只要求 `(rating 1-4, delta_t)`；不确定性：binding public beta（API 可能变）——已被隔离层对冲；执行事件与答题事件混训是否需要分层参数，无先例，先用混训+对照评估兜底。
3. **非单调（A+B 起步，C/D 数据驱动后置）**：映射吸收 + 短窗排除先上线；memory.ts 按时点遗忘曲线的 ≤2 天桶作为增强期的常设观测面，出现超基线保留再立项曲线族替换（§3 选项 C，代价=自建拟合）。不确定性：本用户群执行域的增强期幅度未测——这正是观测面先行的理由。
4. **明确不做**：分数 rating 直喂（§2.1，契约外）；py 子进程/自建 Rust 绑定（§2.3，binding 已覆盖）；起步就换曲线族（§2.4，优化器断链）；亚日粒度执行调度（§1.4 设计裁决已排除近邻形态）。

## 5. 主要来源汇总

- 仓库源码（行号对应当前工作区）：`package.json`（L68-73）；`src/engine/srs.ts`（L10、L17-19、L25-41、L44-59、L87-112、L99）；`src/engine/optimize.ts`（L1-19、L25-27、L41-67、L104-115）；`src/engine/params.ts`（L4、L6、L15-16）；`src/engine/memory.ts`（L107-116）；`src/engine/adaptive.ts`（L18-24）；`src/engine/types.ts`（L149-166）；`src/engine/index.ts`（L1909 附近 `map.rating` 调用面）
- ts-fsrs 5.4.2 实装（node_modules/ts-fsrs/dist/）：`index.d.ts` L9-15（Rating）、L43-57（Card）、L122-125（FSRSState）、L206/L332（FSRSAlgorithm/next_state）、L593-594（导出面无优化器）；`index.mjs` L41-53（TypeConvert.rating 无 clamp）、L356-360（checkGrade）、L701/L757（forgetting_curve 绑定与 Proxy clobber）、L852-860（next_difficulty 线性 delta）、L881-893（next_recall_stability 精确判等乘子）、L944-991（next_state 校验）、L1659-1665（get_retrievability 走实例曲线）
- @open-spaced-repetition/binding 0.5.0（node_modules/@open-spaced-repetition/binding/dist/index.d.ts）：L58-70（FSRSBindingReview：rating 注释 `1-4`、首条 delta_t=0）、L30-36（FSRSBinding）、L76-87（computeParameters 选项）、L94-97（ModelEvaluation）
- 生态动态（检索日 2026-09-08）：[ts-fsrs 官方站](https://open-spaced-repetition.github.io/ts-fsrs/)；[OSR Hugging Face 组织页（ts-fsrs 归类 w/o optimization）](https://huggingface.co/open-spaced-repetition)；[fsrs-rs GitHub（优化器+调度+模拟，Anki 底座）](https://github.com/open-spaced-repetition/fsrs-rs)；[crates.io `fsrs` 5.0.1（compute_parameters）](https://crates.io/crates/fsrs/5.0.1)；[py-fsrs（纯调度器）](https://github.com/open-spaced-repetition/py-fsrs)；[FSRS-Optimizer（PyPI，Python 优化器独立包）](https://pypi.org/project/FSRS-Optimizer/)；npm registry（ts-fsrs 5.4.2 = 2026-09-01，6.0.0-beta.8 = 2026-08-30；binding 0.5.0）
- 机制层交叉引用：`2026-09-tacit-knowledge-deepdive.md` §1.4（技能保持幂律，Anderson et al. 1999）、§3.6（睡眠依赖巩固与间隔期正增益，Walker 2002/2005）；设计裁决 `docs/design/2026-09-learning-expansion-requirements.md` §1.3-1.4（三层判据；不建亚秒级反馈引擎）
