## Agent skills

### Issue tracker

Issues live in GitHub Issues (`maozhijie/learnhub-plugin`); an issue whose implementation has landed is closed by the implementing agent in the same session. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to Chinese label strings (`待分类`、`待补充信息`、`可交给Agent`、`需人工处理`、`不予修复`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### 架构与门

`npm test` 先串行跑类型门，测试里还有分层规则（R1–R7）、架构门（G1–G9）与棘轮——**基线不匹配的失败是门在执法，不是 bug**（棘轮精确匹配：涨了失败，降了没同步下调基线也失败）。章程（门的地图、单跑脚本、加门/改阈值的纪律、行为变更登记）见 `docs/agents/architecture.md`；每道门阈值与实测链的唯一登记处是 `tests/README.md`（门册）。

### 提示词

**提示词文本全部住 `src/engine/prompts/`（按域分文件）**：15 条生成模板在 `templates.ts`（`Content.PROMPT_KINDS` 是它的 re-export），其余按判卷/反馈/出题/内容/项目/宿主分文件。文本是**惰性字符串**（不含 `${}` 插值 + 反引号），变量面是 `{{name}}` 占位符，取值由 `src/engine/prompt-render.ts::render()` 在调用点完成。**改提示词不要去改拼装代码**——找到对应常量改文本即可；`render` 会让缺变量与残留占位符当场抛错（详见 ADR-0075）。

**改提示词 = 改生产行为**，走章程 §8 的「登记 + 过门」两步（同提交补 `PROMPT_CHANGELOG` 条目 + 跑 `prompt-bump` 的两条过门）；提交级登记门扫的就是这个目录与历史路径（`TEMPLATE_FILES`）。**例外**：只改措辞而不动版本号的那一类变更两门都不执法，靠人审兜（章程 §8 末段）。

**收尾必须点名**：凡是这次任务**改动过提示词**，任务收尾必须报告——① 改了哪几条（常量名）；② `文件:行`；③ 新旧差异要点（改了什么语义）；④ 对应的 `PROMPT_CHANGELOG` 登记条目。理由是提示词的人工返工面就在这里：人要靠这份点名**快速找到 AI 这次动过哪些散文**再逐条复核，不点名等于让人自己 diff 全仓。（ADR-0075 §4）。

### 代码索引（codebase-memory MCP）*重要*
详细内容，参考code-index.md

尽可能使用以提升准确性和降低token消耗

本仓用 `codebase-memory-mcp` 建代码知识图谱（函数/调用边/复杂度）。**探索代码应当先考虑图**：`search_graph`、`trace_path`、`get_architecture` 与逐个读文件是两条路，各有便宜处——图答的是**闭合性**问题（谁调用它、影响面到哪、模块怎么聚），grep 答的是**定位**（我知道名字/路径，找出它在哪）。**已确知路径的单点查证直接读文件更省**；问的是「还有谁」「会不会漏」这类问题时，图比 grep 可靠（实测先例：#249 改教练工具白名单，`trace_path(inbound, coachToolset)` 一次给出 3 个入边全在 `growth-subsystem`——这是 grep 给不出的闭合证据）。

**几个顺手时机（建议，按任务取舍）**：

- 改函数/常量/白名单/导出面之前，`trace_path(function_name="X", direction="inbound")` 看调用面——改公共面时特别值得，改叶子函数往往不必。
- 跨文件找定义或实现、不知道标识符只记得「这件事在哪发生」时，`search_graph(query=…)` / `semantic_query=[…]`（跨用词，需 moderate/full 索引）/ `search_code`。
- 要下「没有 X 调用它」这类否定或穷尽结论前，`index_status` / `check_index_coverage` 查一眼覆盖，并 grep 被 `parse_partial`/`skipped` 标记的行段——图是 best-effort，「图上没有」不等于「代码里没有」。
- 任务收尾可以跑一次 `detect_changes(project=…)` 看 blast radius，作为自检的第二意见（注意：符号按**上一次索引**解析，新加的导出符号它还不知道）。

**建议收尾点名**：动过 `src/` 的任务里，若跑过图查询，把它们（工具名 + 目标 + 结论）与 blast radius 一行写进收尾报告会省审阅者很多事；



## 本地启动 dsh 宿主

编译后重启宿主才能生效（lib 是宿主启动时加载的，不热更新）：

```sh
npx @deepseek-ai/dsh web
```

`web` 是 profile 名（profile 在 `~/.dsh/profiles/web`，本插件以 `link:` 装在其中）；后台运行、启动完看输出里的本地 URL。

报 `Cannot find package '@deepseek-ai/dsh-llm'` 时是 peer junction 缺失：本插件以 `link:` 装进 profile，Node 按仓库真实路径解析 peer，被 import 的宿主私有包（dsh-llm、dsh-tools，见 `src/index.ts` 顶部）必须以 junction 形式存在于本仓库 `node_modules/@deepseek-ai/`。跑一次脚本补齐：

```sh
node scripts/link-peers.mjs
```

默认从 npx 缓存里 dsh 自带的副本取源（与宿主实际加载同一份，版本天然一致；npm 上虽有同包但 `latest` 标签停在旧版，不能作普通依赖安装）。npx 缓存目录按调用 spec 生成哈希，`npx @deepseek-ai/dsh web` 原地更新不影响 junction；换 spec（如 `dsh@0.2`）会生成新目录致 junction 悬空，重跑脚本即可。设 `DSH_MONOREPO` 可改从 deepseek-harness monorepo 检出取源（本机该检出已删除）。

报 `[learnhub] config.vault 目录不存在` 时是 vault 挪了位置：机器级配置（vault 路径、provider、model）不在仓库里，写在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dsh-learnhub` patch 条目中，按机器现状改那里。

启动前与故障时的三条经验：报 `EADDRINUSE 3080` 先查 `netstat -ano | findstr :3080`——很可能是用户自己起的宿主，探活 `curl http://127.0.0.1:3080/learnhub/api/status` 正常就别动它。Agent 需要自己拉起宿主时不要挂在会话后台任务里（会被静默回收，无任何日志），用 `Start-Process -WindowStyle Hidden cmd '/c npx … > 日志 2>&1'` 完全脱离。npx 刚跑完就报 `UNSUPPORTED_SCHEMA`（如 additionalProperties 校验失败）多半是 npx 原地换包瞬间的撕裂读取：当前盘上副本单独复现通过的话，重跑一次即可。

## 并行会话用 worktree 隔离

ZCode 没有会话级分支/worktree 隔离：同目录开多个会话共享同一 checkout 和当前分支，未提交改动与 switch/rebase 会互相踩。并行做多个任务时，每个任务建一个 git worktree、每个 worktree 开一个会话；同一会话内的并行 subagent 共享工作目录，配置隔离不了，只能按文件范围拆分或改走多 worktree。

新 worktree 的依赖要装**两处**：根目录与 `ui/` 子包各自 `npm install`（`ui/` 有自己的 package.json，node_modules 不共享）——只装根的话 `npm test` 会在 `tests/md-chain.test.ts` 炸 `Cannot find package 'remark-gfm'`，ui 的 typecheck/build 同样失败。命令与其余注意事项见 `docs/agents/parallel-sessions.md`。

**别在 worktree 里建代码索引**：索引按绝对路径分库，每个 worktree 一份完整副本、零去重，且移除 worktree 后记录仍留在 `list_projects` 里、只能显式 `delete_project` 清掉。规则见 `docs/agents/parallel-sessions.md`。
