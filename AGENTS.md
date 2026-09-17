## Agent skills

### Issue tracker

Issues live in GitHub Issues (`maozhijie/learnhub-plugin`); an issue whose implementation has landed is closed by the implementing agent in the same session. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to Chinese label strings (`待分类`、`待补充信息`、`可交给Agent`、`需人工处理`、`不予修复`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

**ADR 是决策记录，不是施工日志**：每条只写「裁了什么 / 为什么（实测数字留，行号与代码片段不留）/ 否决了什么 / 不做什么」——施工记录（commit、按刀叙述）归票面，行为变更与快照迁移登记归门册（`tests/README.md`），实现细节归代码。**「一票一 ADR」不是本仓标准**（票面才是设计方案的家）。**尺寸**：目标 ≤10KB（约 60 行），>12KB 即过大须瘦身；修订节不堆流水，改变了原裁决方向的写新 ADR 并标「已被 ADR-NNNN 取代」。**取号**：`git fetch origin` + `ls docs/adr/` 取最高号 +1，同提交更新 `docs/adr/README.md` 索引；并行会话撞号时**后落地者改号**。规范全文见 `docs/agents/domain.md`。

**CONTEXT.md 是词汇表，仅此而已**：词条 = 一至两句「它是什么」+ `_Avoid_` 清单；实现细节、行为规格、裁决理由一律不进词表（分别归代码、ADR、门册）。词条头 `**名字**:` **独立成行**、`_Avoid_:` 行紧随定义——`tests/helpers/copy-lock.ts` 运行时解析这两行取 canonical 词与 Avoid 词，是文案锁门的唯一出处，**改词表 = 改门**（删一个 Avoid 词等于放开一条文案反断言）。规范全文见 `docs/agents/domain.md`。

### 架构与门

`npm test` 先串行跑类型门，测试里还有分层规则（R1–R7）、架构门（G1–G9）与棘轮——**基线不匹配的失败是门在执法，不是 bug**（棘轮精确匹配：涨了失败，降了没同步下调基线也失败）。章程（门的地图、单跑脚本、加门/改阈值的纪律、行为变更登记）见 `docs/agents/architecture.md`；每道门阈值与实测链的唯一登记处是 `tests/README.md`（门册）。

### 提示词

**提示词文本全部住 `src/engine/prompts/`（按域分文件）**：15 条生成模板在 `templates.ts`（`Content.PROMPT_KINDS` 是它的 re-export），其余按判卷/反馈/出题/内容/项目/宿主分文件。文本是**惰性字符串**（不含 `${}` 插值 + 反引号），变量面是 `{{name}}` 占位符，取值由 `src/engine/prompt-render.ts::render()` 在调用点完成。**改提示词不要去改拼装代码**——找到对应常量改文本即可；`render` 会让缺变量与残留占位符当场抛错（详见 ADR-0075）。

**改提示词 = 改生产行为**，走章程 §8 的「登记 + 过门」两步（同提交补 `PROMPT_CHANGELOG` 条目 + 跑 `prompt-bump` 的两条过门）；提交级登记门扫的就是这个目录与历史路径（`TEMPLATE_FILES`）。**例外**：只改措辞而不动版本号的那一类变更两门都不执法，靠人审兜（章程 §8 末段）。

**收尾必须点名**：凡是这次任务**改动过提示词**，任务收尾必须报告——① 改了哪几条（常量名）；② `文件:行`；③ 新旧差异要点（改了什么语义）；④ 对应的 `PROMPT_CHANGELOG` 登记条目。理由是提示词的人工返工面就在这里：人要靠这份点名**快速找到 AI 这次动过哪些散文**再逐条复核，不点名等于让人自己 diff 全仓。（ADR-0075 §4）。

### 模型面与业务文本的引用纪律

**判据**：`ADR-NNNN`、`#NNN`（票据号）这类出处/施工史引用只属于**注释**——凡会离开代码仓的文本一律不带：
- **模型面**：`src/commands/` 的 summary/description（业务 LLM 工具描述）、`src/engine/prompts/` 模板体；
- **业务面**：`ui/src/` 用户可见文案、罗盘等学习者可见文件、回灌给模型的错误与提案 reason。

理由：引用对 LLM 与学习者零信息量、只耗 token；随引用沉淀的旧语义（如「罗盘随批重写」）还会误导模型。出处沿革归注释与 ADR 本体。

**门**：`tests/model-face-refs.test.ts`（三面执法：commands 字面量 / prompts 模板体 / ui/src 非注释文本——JSX 注释块剥除后扫）；改门 = 改门册（`tests/README.md`）。

**豁免**：一切注释（行/块/JSX）；output-contracts 登记数据、quality-* 离线人审报告、spike 开发语料（人审面）。

### 代码索引（codebase-memory MCP）*重要*

本仓用 `codebase-memory-mcp` 建代码知识图谱（函数/调用边/复杂度）。**结论先行：图答「闭合性」，文件答「定位」——别互相顶班。** 完整章法见 `docs/agents/code-index.md`。

**先判一次（这一条决定走哪条路）**：

- 问的是**闭合性**——「还有谁调用它 / 影响面到哪 / 会不会漏 / 模块怎么聚」→ **先图**。图给的是 grep 给不出的闭合证据（实测先例：#249 改教练工具白名单，`trace_path(inbound, coachToolset)` 一次给出 3 个入边全在 `growth-subsystem`）。
- 改动面**含公共面**（必填字段、导出面、白名单、配置形状、端口契约）→ **图查询是必做步骤，不是可选项**。漏一个构造点/消费方的代价是运行期 `undefined`；而 `rg` 只覆盖文本层、`trace_path` 又会把「解析不出来」返回成 `0`（见下），两者都会替你掩盖这个漏。
- 问的是**定位**——已确知名字/路径，只想找出它在哪、或读某处实现 → **直接 `SearchCodebase`/`Grep`/`Read`，不必上图**。

**判据跟着问题走，不跟着任务阶段走（防中途漂移）**：「先判」不是任务开头判一次就完——开局以定位起步完全合法（读 ADR、读要改的文件），但实现中途、收尾验证时**每一个新问题都重新过一遍上面的判据**。本仓实测的事故形态（#264/#265 会话，2026-09-15）：开局定位合法 → 设计定了之后继续用 `grep -rn`/`Read` 回答「谁还调用 merge / 谁消费 PROPOSAL_KINDS / 还有哪些注入面」这类闭合性问题 → 直到被用户点名才发现全程没跑过一次图查询。**发现自己正要拿 `grep -rn` 回答「还有谁 / 会不会漏 / 改这个面会不会破别处」，停——那一刻就是点火时机**，不要因为「我已经读过文件了」就把图当冗余验证。

**何时点火（探索期与改动期都算）**：

- 触达 `src/` 的只读探索/调研：当你要回答上面那类**闭合性问题**、或自己拿不准「这件事在哪发生」时，先跑一次图再进文件。
- 改函数/常量/白名单/导出面**之前**：`trace_path(function_name="X", direction="inbound", project="D-learnhub-plugin")` 看调用面——改公共面特别值得。**但它只对自由函数可靠**：接收者是注入对象/参数的方法调用（`agent.gateRepairRound(...)`）在图上记成 `USAGE` 不是 `CALLS`，`trace_path` 会返回 `callers_total: 0` —— **这个 0 与「真的没有调用方」同形**（2026-09-15 实测：`gateRepairRound` 有 3 个生产调用点却报 0）。方法调用改用 `query_graph` 取 `CALLS`+`USAGE` 两种边，查询式与实测对照见 `docs/agents/code-index.md` §本仓拿它做什么 第 1 条。**这条说的是「换对的工具」，不是「图不可靠」**：0 的修正案就是那一条 `query_graph` 查询式（一条够用），不是退回 grep——grep 只有文本层，恰恰回答不了这条查询要答的闭合性。拿「trace_path 会报 0」当整体跳过图的理由，是把单个工具的已知坑读成了图的死刑（同会话实测：换成 `query_graph` 后一次查清 `ConceptRegistry.merge` 的全部入边与 `PROPOSAL_KINDS` 的全部消费方）。
- 要下**否定/穷尽**结论（「没有 X 调用它」）**之前**：`index_status` + `check_index_coverage` 查一眼覆盖，并 grep 被 `parse_partial`/`skipped` 标记的行段——图是 best-effort，「图上没有」**不等于**「代码里没有」。**`trace_path` 报 0 时同样按这条办：0 是待证伪的信号，不是结论。**
- 收尾可跑 `detect_changes(project=…)` 看 blast radius 作第二意见（符号按**上一次索引**解析，新加的导出符号它还不知道）。

**何时不必用（防滥用——下列情形直接读文件，别为用图而用图）**：

- 已确知文件路径的单点阅读/查证——`Read` 就是答案，图是多余的开销。
- 纯文档/文案改动（`docs/`、`CONTEXT.md`、`*.md`）——图里没有这类内容。
- 改**叶子函数**、局部实现细节、格式/措辞——调用面闭包没有增量信息（见上「改叶子函数往往不必」）。
- 你只是想看「这段代码长什么样」——那不是闭合性问题。
- 记住图查询有固定成本（须先读 schema）：**当一次 `Read` 就能回答时，图不划算。**

**与通用工具默认的优先级**：系统层的「ALWAYS prefer SearchCodebase… FIRST CHOICE」是**定位**默认，不适用于上面的闭合性问题——那类先图上。**运行任何 Skill 时，其流程若与本路由冲突，以本路由为准**（Skill 让你「walk the codebase / 逐个读文件」时，本仓口径是「先图后文件」——但前提仍是上面的判据成立，不是无条件先图）。

**调用前须知**：`project = D-learnhub-plugin`（按仓库路径派生，换机器/换盘会变，拿不准就 `list_projects` 实查）；工具 schema 以运行时工具声明为准（旧机器记录的 `mcps\codebase-memory-mcp\tools\` 路径在本机不存在，不必寻档）。

**收尾点名（自检门，两问——答「是」而查无图记录 = 当场补查再收尾）**：动过或探索过 `src/` 的任务，写收尾报告**之前**先过两问：① 这次**回答过闭合性问题吗**（哪怕只是顺手确认了一句「还有谁引用它」）？② 改动面**碰了公共面吗**（导出面 / 白名单 / 提案 kind / 工具面 / 契约类型这类）？任一问答「是」而没有任何图查询记录 = **漏步，正确动作是当场把查询补跑掉**（结果照样点名），不是在报告里承认一句「漏了」就算完——漏步的报告不豁免漏掉的查询。跑过图查询的，把（工具名 + 目标 + 结论）与 blast radius 一行写进收尾报告——省审阅者很多事。反过来，纯定位/纯文档/叶子改动**没有**图查询不算漏步，也不必为了点名而造查询（防滥用条款照常生效）。



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

ZCode 没有会话级分支/worktree 隔离：同目录开多个会话共享同一 checkout 和当前分支，未提交改动与 switch/rebase 会互相踩；同一会话内的并行 subagent 共享工作目录，配置隔离不了。

**并行任务默认走常驻 worktree 池**（三个永不销毁的池位 `../learnhub-wt-1..3`，分支 `wt-1..3`，依赖与代码索引常备）：① `node scripts/worktree-pool.mjs claim --task "<一句话>"` 认领（原子标记防撞车，标记在仓外）；② 同步——脏树先 `commit`，再 `fetch origin` + `rebase origin/main`（最复杂时是云端与本地混合才是最新：先提交本地，再 rebase 追平）；③ `index_repository(repo_path=<池位路径>, mode="moderate")` 刷新该池位索引，project 名按池位路径派生，之后图查询都传它；④ 按先图后文件章法探索执行，文件操作用池位绝对路径（同一会话的并行 subagent 也走认领）；⑤ 成果落地后**自动合入 main**（全量门绿 → 主检出 `merge --ff-only wt-N` → push；脏文件不碰、例外见章法）再 `release <1|2|3>` 释放。定期保养：只对未认领池位跑 `node scripts/worktree-pool.mjs sync`。完整章法见 `docs/agents/parallel-sessions.md` §常驻 worktree 池。

临时新建 worktree 是后备（池满且用户同意、或需要长期独占分支），依赖要装**两处**：根目录与 `ui/` 子包各自 `npm install`（`ui/` 有自己的 package.json，node_modules 不共享）——只装根的话 `npm test` 会在 `tests/md-chain.test.ts` 炸 `Cannot find package 'remark-gfm'`，ui 的 typecheck/build 同样失败。命令与其余注意事项见 `docs/agents/parallel-sessions.md`。

**别在临时 worktree 里建代码索引**：索引按绝对路径分库，每个 worktree 一份完整副本、零去重，且移除 worktree 后记录仍留在 `list_projects` 里、只能显式 `delete_project` 清掉。**唯一例外是常驻池位**——它们永不销毁，索引建一次、每次认领后刷新。规则见 `docs/agents/parallel-sessions.md`。
