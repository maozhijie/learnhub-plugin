# 生成语料工具调用载荷·实跑记录（#236 / ADR-0073）

日期：2026-09-13 ｜ 票：#236 ｜ 装置版本：分支 `feature/236-corpus-tool-calls`（ADR-0073 落地态）

## 装置

- **自建宿主，不碰用户宿主**：用户自己的宿主（`127.0.0.1:3080`，`link:` 指向主 checkout）当时在跑，全程未动。另建 profile `check236`（`dsh --profile check236 --from-default-profile web` + `dsh plugin --profile check236 add <worktree>`），用 `--patch` 覆盖层把 vault 指向临时目录 `%TEMP%/learnhub-236-run`，`--port 3099` 另起一实例——加载的正是本票分支的构建（`lib/index.js` 出自 `learnhub-plugin-236`，启动栈迹可证）。
- **真 provider**：`deepseek-official` / `deepseek-v4-flash`（与用户部署同款），真模型调用。
- **临时 vault**：建课 → 应用种子 → 触发教练生长全在临时目录里发生，用户 vault 零写入；跑完即删。

驱动（一次性脚本，不住仓库）：`POST /seed/propose`（真模型起草，产出 2 起点 → 终点「为一批真实数据写出能跑通的统计脚本，并读懂它打印的每个结果在说数据的什么」）→ `POST /proposals/apply`（人审等价的机械直通）→ 起点正文自动入队 → `POST /coach/growth`（面板下发 = 显式重新裁决路径）→ 队列跑空。

## 读数：教练生长 16 件捕获

| 件（时:分:秒） | outcome | 文本侧字符 | `## 工具调用` 段 |
|---|---|---|---|
| 15-23-23 | ok | 79 | `graph_view` · `concept_registry` · `endpoint_anchor` · `compass_read` |
| 15-23-24 | ok | **0** | `behavior_digest` · `bank_overview` |
| 15-23-27 | ok | 847 | 无 |
| 15-24-20 | ok | 854 | 无 |
| 15-24-21.244 | ok | **0** | `graph_view` · `compass_read` |
| 15-24-21.854 | ok | 65 | `concept_registry` · `bank_overview` |
| 15-24-22 | ok | **0** | `node_card{用 Python 列表装一组数并打印求和结果}` · `node_card{为一批真实数据写出能跑通的统计脚本…}` |
| 15-24-25 | ok | 887 | 无 |
| 15-24-28 | ok | **0** | 7 次调用：`graph_view` · 2×`node_card`(真节点名) · `concept_registry` · `compass_read` · `endpoint_anchor` · `bank_overview` · `behavior_digest` |
| 15-25-25 | ok | 1684 | 无 |
| 15-25-26 | ok | **0** | 6 次调用（六个只读视图各一） |
| 15-25-28 | ok | 862 | 无 |
| 15-25-53 | ok | 1024 | 无 |
| 15-25-54 | ok | **0** | `graph_view` · `compass_read` |
| 15-25-55 | ok | **0** | 2×`node_card`(真节点名) · `bank_overview` |
| 15-25-59 | failed | 2095 | 无（schema 门失败：`ops.5.bloom` 非法层级「综合」——真模型内容错误，与本票无关） |

合计：16 件 / **文本为空 7 件** / **带载荷段 9 件**。

### 可评率（同一 corpus，评审器自己的读侧口径）

| 口径 | 可评件 | 可评率 |
|---|---|---|
| 修复前（`isScoreable` 只看 `output`） | 9 / 16 | 56% |
| 修复后（受评对象 = 文本 + 工具调用载荷合并视图） | **16 / 16** | **100%** |

### 真评审器一轮（同一 corpus，真模型）

`POST /learnhub/api/quality-review`：`{stations:["教练生长"], repeats:1, badQuota:2, okQuota:3}` → pool 16、selected 4、**unscoreable 0**、reviews 4、failures 0、8 次真调用（入 26023 / 出 50435 tok）。报告落临时 vault 的 `state/质量评审/2026-09-13T15-30-21-711Z-教练生长.md`。

### 旁证：用户实 vault 的修复前基线

用户自己的 vault（主 checkout 构建，修复前）`state/生成语料/教练生长/` 存量 4 件：**3 件 `outcome: ok` 且 `reply_chars: 0` +「（空输出）」**（`ok-…-0001/0002/0003`）。这 3 件能记成 `ok` 本身就证明它们有工具调用（适配器对「无文本且无工具调用」是抛错的）——即 #224 那 3/4 空壳的成因，与本票修复对象完全一致。

## 发现（对票面口径的一处修正）

**教练工具面是只读白名单**（`graph_view` / `node_card` / `concept_registry` / `behavior_digest` / `bank_overview` / `compass_read` / `endpoint_anchor`，见 `engine/coach-tools.ts`）。所以教练生长站的工具调用是**裁决前的取证查询**（「查图自证名字」），裁决 op 本身仍以文本回程（本例 15-25-25…15-25-59 几件文本 1600+ 字符）。于是：

- 票面「裁决 op 承载在工具调用里」的形态在**工具臂站**（#216 spike 的 `submit`）成立，**在教练站不成立**——教练站的空壳是取证轮，不是裁决轮。
- 修复对这些件的价值是**取证可见**：修复前只看得见「文本为空」，修复后看得见「它查了哪张视图、按哪个**真节点名**查的」（上表 15-24-22/15-25-55 的 `node_card` 参数即裁决前的名字对表证据）。
- 候选发现（不在本票）：回路站的受评对象可再分**取证轮 / 裁决轮**——取证轮给「查得准不准」的量规，裁决轮才是现有「教练回合」量规的对象；否则可评率回升会把取证轮混进裁决轴的抽样池。按 #234 池纪律登记为候选，不自行扩票。
