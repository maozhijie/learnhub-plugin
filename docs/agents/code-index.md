# 代码索引（codebase-memory MCP）

本仓用 `codebase-memory-mcp` 这个 MCP 服务探索代码：它是一张代码知识图谱（函数、类、路由、调用/使用边、复杂度属性），用 `search_graph` / `query_graph` / `trace_path` / `get_architecture` 查询，代替逐个读文件。它配在**用户级**（本机：`~/.zcode/cli/config.json`），不在仓库里——所以本仓的每个 worktree 都连同一个服务、同一个存储。

本文是本仓怎么用它、以及不该期待什么。除特别说明，数字均为 2026-09-15 在本机的实测：一个 3 文件的模型仓，以及另一检出的 55k 节点索引。

## 装：只给主检出索引一次，且要带语义边

从**主检出**索引，不要在 worktree 里索引，模式用 `mode: "moderate"`（或 `"full"`）：

```
index_repository(repo_path="C:/Users/test/Desktop/my/learnhub-plugin", mode="moderate")
```

- **`fast` 会悄悄拿走语义搜索。** `fast` 不建相似度/语义边，`semantic_query` 会返回零条并附提示 `semantic_query needs a moderate/full index`。实测：同一组四个关键词在 `fast` 索引上**返回 0 条**，同一批文件以 `moderate` 索引后**返回 3 条**。`fast` 只留给一次性诊断跑。
- **索引按绝对路径分库。** 一 project 一索引、一文件：`~/.cache/codebase-memory-mcp/<路径派生名>.db`（分隔符变连字符，点号保留——例如 `C-Users-test-.zcode-workspace-default-ripwire`）。`list_projects` 的 `size_bytes` 等于该文件在盘上的大小，那份 55k 节点的索引实测 **213 MiB**。检出与它的 worktree 之间零去重——worktree 规则见 `parallel-sessions.md`。
- 索引是一次完整管线跑，不是增量编辑。本机只测过 3 文件仓的 ~2.5 秒；213 MiB 那份自己的时长没测，所以本仓重索引请当成一个决定，而不是顺手一下。
- 排障：守护进程日志在 `~/.cache/codebase-memory-mcp/logs/cbm-daemon.log`。

## 本仓拿它做什么

**该用是约束，怎么用看情况**（`AGENTS.md` 的同一节是简版）：默认先考虑图，但「已确知路径的单点查证」直接读文件更省。下面每条给的是**顺手时机**与实测读数，不是必须动作——按任务取舍；问「还有谁 / 会不会漏」这类闭合性问题时它比 grep 可靠。

1. **改引擎或 host API 之前先算影响面。** `trace_path(function_name="X", direction="inbound")` 沿调用边传递地走调用方。模型仓实测：`gradeAnswer` ← `computeDueItems`（hop 1）← `run`（hop 2），报 `callers_total: 2`。它走的是解析出来的边而不是文本匹配，所以比手工 grep 调用点更便宜也更可靠——在动任何 111 个 agent 工具或端点面依赖的东西之前都值得跑一遍。本仓实测（#249）：`coachToolset` 3 个入边、`renderGrowthGraphView` 3 个调用点，一次查询就锁定了「换白名单不会漏掉远端消费者」。
2. **任务收尾算 blast radius。** `detect_changes(project=...)` 把工作区 diff 解析成改动的符号，列出传递的入向影响面加一份 `impacted_modules` 汇总。实测：1 个改动文件解析出 1 个种子符号、2 个受影响调用方、跨 2 个模块。**注意**：符号是按**上一次索引**解析的，所以任务里新加了导出符号的话，重索引之前别信它。
3. **给分层拿一份独立读数。** `get_architecture(aspects=["clusters"])` 按调用/导入边把节点聚成事实上的模块（常常横切目录布局），`aspects=["cycles"]` 扫调用图里的环形 `CALLS` 依赖（size > 1 的强连通分量）。R1–R7 与 G1–G9 是手工写在 `tests/` 里的；这两个 aspect 是第二意见。不一致请当成一个待回答的问题，而不是自动违规——它和门本身也是不同轴的证据。
4. **按意图找代码，不按名字找。** `search_graph(query="...")` 是对名字与 docstring 的 BM25；`semantic_query=[...]` 负责跨越用词（查 `score` / `evaluate` / `student`，命中了名为 `gradeAnswer`、正文里一个这些词都没有的函数）。当你知道「这件事在哪发生」却不知道标识符时用它。**`score` 不能当置信度读**——上面那些明确命中回来的值约 `-0.015`，即略负；只有相对排序有意义。
5. **带结构的 grep。** `search_code(pattern="...")` 把原始命中归并进包含它们的函数，定义在前、测试在后。对 `src/engine/prompts/` 下的提示词文本，这就是对的工具，配 `file_pattern` / `path_filter`——提示词是惰性字符串，纯文本检索正是你要的，图那一层帮不上什么。

## 不要做的事

- **不要把图当 ground truth。** 索引是 best-effort，并且自报缺口：`index_status` 会返回 `parse_partial`（已索引但含解析器读不了的行段——那里的构造可能缺失）与 `skipped`（完全没索引），`query_graph(graph="missed")` 是同一批缺口的结构化视图。做**否定或穷尽**结论之前——「没有东西调用它」「不存在 X」「只有这一处」——先查 `check_index_coverage`，至少 grep 一下被标记的文件。**图上没有不等于代码里没有。** 本仓的精确匹配面（门基线、棘轮、`PROMPT_CHANGELOG` 条目、ADR 编号）永远从真实文件读。
- **本仓的 ADR 不要用 `manage_adr`。** ADR 住 `docs/adr/`，编号成文件，`npm test` 会读那个目录。`manage_adr` 写的是 MCP 内部一个 per-project store——在一个已有唯一真相源的仓里开第二份，而且不是门读的那份。`index_repository` 每次都会推 `adr_hint` 建议你用它；本仓忽略那条提示。
- **不要在 worktree 里索引，也永远不要传 `persistence: true`。** 见 `parallel-sessions.md`——前者按任务乘以一份 213 MiB 索引，后者在 `repo_path` 里丢下一个大 `.codebase-memory/` 目录。
- **不要反射式重索引**，也不要换个路径再索引一份「干净的」——本仓重索引是一次完整跑，第二个路径是第二个 project，且没有回指。

## 收尾维护

`list_projects` 是路径派生名的平铺列表；把 worktree 系到它共同检出的 `canonical_root` 只在 `index_status(verbose: true)` 里。`delete_project` 是唯一能回收磁盘的东西——它删记录和它的 `.db`——而移除一个 git worktree **不会**移除记录。
