# 可达性门与 ops 面正名：命令必须至少一个可达面

命令注册表（ADR-0045）落地后，八道门查的是**形状与一致性**——`engine` 存在性 / 队列阶段 / 唯一性 / handler 覆盖 / 指南投影 / 零运行时依赖 / 声明与面一致——**没有任何一道门查「命令从任何产品面是否可达」**。父票 #254 的一次全链路可达性审计（163 条命令 × UI / agent 工具 / 脚本三面交叉）实测出两件事：**9 条命令没有任何产品入口**（route 在、handler 在、行为快照在，但没有 UI 调用方或 agent 工具能触达），以及**三条路由被误判为孤儿**——`smoke` / `spike` / `quality-review` 实为 `npm run` 脚本驱动的宿主 API（真 provider 只在宿主 ctx，必须走宿主 HTTP），只是声明成了 `panel` 通道。死入口能长期潜伏的机制原因正是：`host-routes-snapshot` 把死路由以一条 200 响应「钉活」——快照是**行为**回归，不是**可达性**回归。

9 条死命令与种子链已由 #255 / #256 删净（ADR-0081 / ADR-0082）。本 ADR 收口剩下的一半：**把三条脚本驱动路由正名为 `ops` 面，并新增一道会把死入口判红的可达性门**。

关键裁决：

- **通道种类扩为 `agent` / `panel` / `ops`**（`ChannelSpec.channel`）。三者都是「投递面」：`agent`＝工具面、`panel`＝面板路由面、`ops`＝`npm run` 脚本驱动的宿主 API 面。`panel` 与 `ops` **都是路由**（都有 `route`，都由 `host/api.ts` 查 `BY_ROUTE` 分发），区别只在**可达面**。字段形状其余不变（`tool` / `route` / `prefix` / `bind` / `phase` / `mode`）。
- **`smoke` / `spike` / `quality-review` 从 `panel` 改声明为 `ops`**：路由与 handler **逐字不变**（仍走宿主 HTTP），只改通道种类。既有门 ④（handler 覆盖）/ ⑧（声明与面一致）按「路由通道（panel+ops）」口径适配——它们本就用 `x.route` 过滤，语义不变，仅正名。
- **新增门⑨ 可达性**：**每个命令必须至少有一个可达面**，面按通道种类定——
  - `agent` 通道 → **注册即产品面**（工具名下发即暴露，无需静态调用点）；
  - `panel` 路由 → 在 **UI 源码**（`ui/src/**` ∪ `src/client/**`）找到**调用点**即可达；
  - `ops` 路由 → 在 **`scripts/`** 找到**调用点**即可达；
  - 判红：命令无任何可达面（无 UI 调用、无脚本调用、无 agent 工具）= 死入口。
  另附一条**ops 面正确性**断言：每条 `ops` 路由必须在 `scripts/` 找到调用点，找不到即红（防止把非脚本驱动的路由误标 `ops`）。
- **两向自检**（ADR-0047 铁律①）：门体与自检**共用同一个纯函数** `scanReachability`（住 `tests/commands.test.ts`，不另写一份正则）——① 合成「panel-only 路由无 UI 调用」样本断言判孤儿；② 断言收集器**看得见真实调用点**（`ui/src` 能匹配 `GET /status`、`src/client` 能匹配 `GET /discuss-pack`、`scripts/` 能匹配 `POST /smoke`），防恒过门。判据是**方法感知的调用点**（`('<METHOD>', '<path>'` 或 `` `/learnhub/api<path>`… `` + 路径终止符），不是「字符串恰好出现」——后者会把注释里的 `src/host/smoke.ts`、别名 `/note-sources`（含 `/note` 子串）、历史死路由 `/review`（含于 `/question-dispute/review`）误当调用。

边界（照着改时别踩）：

- **只覆盖静态可达性**：门看的是源码里的**路径字面量**。「按钮存在但从不渲染」「运行时动态拼路由」这类形态它看不见——这是本门的已知边界，不是可以省的实现细节。
- **`prefix` 静态伺服路由不参与断言**：唯一一条 `GET /vendor/`（vendored katex/three 的伺服前缀），它的消费者是**运行期生成物**——交互件 HTML 的 importmap、引擎提示词里的 `/learnhub/api/vendor/three/...`、伺服端注入的 katex `<link>`——不是 UI 源码里的静态字面量。故前缀伺服命令（`vendor-`）登记为**纯伺服豁免**（无产品命令面，本就无静态调用方）。
- **双通道命令的 panel 路由由工具面兜底**：`question-save`／`project-lifecycle`／`explain-back-pack`／`note-source-exclude`／`note-source-unexclude`／`note-resolve`／`rebuild` 七条命令带有 `agent` 工具，其 panel 路由 UI 未接——命令经工具面可达，故**不判孤儿**。可达性的断言对象是**命令**（「声明即产品面」＝命令要有产品入口），不是「每条路由都有人调」。若将来 UI 接上这些路由，门照常看得见（无需改门）。
- **`src/client/**` 计入 UI 可达面**：它是面板客户端桥的构建入口（`build.mjs` → `lib/client.js`，供宿主页注入），`discuss-pack` / `explain-pack` 的调用点就在这里。它和 `ui/src` 同属「UI 源码」。

同提交迁移（ADR-0047 修订纪律）：

- **无路由/工具/行为面变化**：三条路由只改通道种类，`host-routes-snapshot` / `host-routes-baseline` / `host-tools-*` / `host-face-baseline` **逐字不变**（通道种类不进任何快照面）。
- **文件规模棘轮**：`src/commands/types.ts` 128→131（三行注释），`scripts/arch-baseline.json` 同提交 `--update`。
- **门册/章程**：`tests/README.md` 登记门⑨、阈值来源与已知边界；`docs/agents/architecture.md` 的「注册表八道门」表述同步为「注册表九道门」（ADR-0045 的历史记录不改，由本 ADR 承接）。
- **提示词面**：本票不触碰任何提示词文本，`prompt-bump -- check` 恒绿、无 `PROMPT_CHANGELOG` 条目。

替代方案（否决）：

- **只删死命令、不加门**——下一条死入口仍会静默潜伏（快照继续把它钉活）。门才是把「声明即产品面」变成**会失败的东西**。
- **把可达性判据放在「每条 panel 路由都必须有 UI 调用点」**——会把六条双通道命令的对等 panel 路由（命令经工具面仍可达）误判成孤儿，逼出「加 UI」或「建白名单」两种 scope 外的动作。可达性的判据是**命令**有产品入口。
- **让 `vendor-` 也进断言、用白名单兜**——前缀静态伺服不是产品命令，给它记一条永久豁免不如按 `prefix` 字段**机械豁免**（前缀＝伺服语义，字段即判据）。
- **把可达性门并进 `arch-guards.test.ts`（G10）**——它是对**既有声明数据**（`COMMAND_LIST` + channels）的断言，与八道门同源同缝，住 `tests/commands.test.ts` 不新建 seam（父票 #254 Seam 2）。

取号：0083（合入主检出时顺延：0080 #253 调试日志、0081 #255 doctor、0082 #256 种子链退役）。票面：#257（父 #254）。
