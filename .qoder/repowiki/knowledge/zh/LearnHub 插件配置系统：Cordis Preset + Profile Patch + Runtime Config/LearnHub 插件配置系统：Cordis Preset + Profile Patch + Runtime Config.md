---
kind: configuration_system
name: LearnHub 插件配置系统：Cordis Preset + Profile Patch + Runtime Config
category: configuration_system
scope:
    - '**'
source_files:
    - preset/learnhub/preset.yml
    - preset/learnhub/agent.cordis.yml
    - preset/learnhub/user-root-composition.yml
    - cordis.patch.yml
    - src/host/runtime.ts
    - src/host/params.ts
    - build.mjs
---

## 1. 使用的系统与框架

本仓库是一个 Cordis Agent 宿主（dsh）的插件包，配置体系围绕 **Cordis preset/profile** 与宿主运行时配置两层展开：
- **Preset 层**：`preset/learnhub/agent.cordis.yml` 以 YAML 列表声明 agent 组合（persona、工具、skill、delegation、compaction、planning），通过 `@deepseek-ai/cordis-plugin-include` 在用户根 composition 中引用。
- **Profile Patch 层**：`cordis.patch.yml` 是机器级补丁，向宿主注入 `dsh-learnhub` 插件以及 `time-context`、`schedule` 等能力；各机器的 `~/.dsh/profiles/web/cordis.patch.yml` 按 id 覆盖 `config.vault` 部署路径。
- **Runtime Config 层**：`src/host/runtime.ts` 中的 `LearnhubConfig` 接口承载引擎启动参数（vault、centerRel、provider、model、fastEffort、deepEffort、quizAuditRate、corpusDir），由宿主装配时传入并做 fail loud 校验。

此外，构建期通过 `build.mjs` 把 `skills/*` 同步到 `$DSH_HOME/skills`（默认 `~/.dsh/skills`），作为 skill-filesystem 的扫描根，属于“构建时安装型配置”。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `preset/learnhub/preset.yml` | preset 元信息（name/description） |
| `preset/learnhub/agent.cordis.yml` | 完整 agent 组合声明（persona、shell、fs、jobs、skill、goals、planning、compaction、delegation、tool-*） |
| `preset/learnhub/user-root-composition.yml` | 用户根占位，用 `@deepseek-ai/cordis-plugin-include` 引用真实 preset，path 需替换为绝对 file:// URL |
| `cordis.patch.yml` | 机器级 patch，插入 dsh-learnhub、time-context、schedule 三个 id |
| `src/host/runtime.ts` | `LearnhubConfig` 类型定义 + `createHostRuntime()` 装配逻辑（vault/centerRel/provider/model/effort/quizAuditRate/corpusDir 校验与初始化） |
| `src/host/params.ts` | 宿主 API 参数守卫（need/optText/optNumber 等），集中处理请求体/查询串的类型校验与错误统一 |
| `build.mjs` | 构建脚本：编译 lib、拷贝 vendor、同步 skills 到 `$DSH_HOME/skills` |

## 3. 架构与设计决策

### 分层加载顺序
1. **Cordis 启动**：宿主读取 profile 的 `cordis.patch.yml`，注入 dsh-learnhub 插件。
2. **Preset 解析**：通过 `user-root-composition.yml` 中的 `@deepseek-ai/cordis-plugin-include` 加载 `agent.cordis.yml`，组装 persona、工具、技能、委派子代理、计划模式、压缩策略等。
3. **插件 apply**：插件入口调用 `createHostRuntime(ctx, config)`，从上层传入的 `LearnhubConfig` 获取 vault、centerRel、LLM provider/model、effort 档位、quizAuditRate、corpusDir。
4. **运行时校验**：`createHostRuntime` 对 `vault` 必填且存在、`centerRel` 规范化、`quizAuditRate ∈ [0,1]` 做 fail loud 检查；不存在则抛错并提示去对应 profile patch 补配置。
5. **数据目录初始化**：若 vault 内 `state/learnhub.json` 和 `课程注册表.yaml` 均不存在，视为全新库，写入 schema version 戳；旧痕迹一律交由版本硬门判定。
6. **引擎构造**：`new LearnhubEngine({ vault, centerRel, clock, rng, fs })`，所有 I/O 经 `nodeVaultFs` 抽象。
7. **Agent 缝装配**：`AgentSeam` 注入 `llmSeam` / `llmStreamSeam`，调用日志写至 `state/运行日志.md`。

### 配置来源优先级
- **profile patch 的 `config.vault`** 覆盖 `cordis.patch.yml` 中的默认行（注释明确说明“patch 按行整体替换 config”）。
- **`LearnhubConfig` 缺省值**：`centerRel` 默认 `'学习中心'`，`quizAuditRate` 默认 `DEFAULT_QUIZ_AUDIT_RATE`，`fastEffort`/`deepEffort` 缺省时走引擎默认档。
- **环境变量**：仅 `DSH_HOME` 被 `build.mjs` 用于定位 skills 目标目录；运行时不直接读 `process.env` 注入业务配置。

### 参数校验纪律
`src/host/params.ts` 将全部 HTTP 参数取值收敛到一组守卫函数（`need`/`needQuery`/`requireString`/`requireBoolean`/`requireNumber`/`requireObject`/`requireOneOf` 及对应的 `opt*` 系列），并通过 `readArgs(args, channel, source, bind)` 按声明式 schema 解析。规则包括：
- 必填缺失 → 中文消息 `缺少必填参数：<key>`，统一抛 `ParamError`，由分发层追加路由名。
- 可选参数「省略或合法」：键缺席走省略语义，键在场但类型不符 → fail loud 抛 `非法可选参数：<key>`（#185 收紧）。
- 枚举字段用 `requireOneOf`，唯一允许例外。
- 模块零 I/O、不 import engine 与宿主状态，只认 `Record<string, unknown>` 与 `URL`。

## 4. 约定与约束

- **vault 路径必须显式配置**：`createHostRuntime` 要求 `config.vault` 为非空字符串且目录存在，否则抛错并提示编辑 `~/.dsh/profiles/web/cordis.patch.yml`。
- **学习中心相对路径可配**：`centerRel` 默认 `'学习中心'`，会被规范化（去前后 `/`、Windows 反斜杠转正斜杠）。
- **LLM 行为分档**：`fastEffort`（大纲/节正文机械调用）与 `deepEffort`（高复杂度节点）支持 `'off' | 'low'`，缺省分别走 off 与 low，路由不支持时自动降级为部署默认。
- **出题第二意见门抽样率**：`quizAuditRate` 必须在 `[0,1]`，0 表示关门；装配时 fail loud，不在运行时静默改写。
- **语料落盘目录**：`corpusDir` 缺省使用 `engine.paths.corpusDir`（即 `<center>/state/生成语料`），可覆盖为外部持久目录供离线评审。
- **新库识别**：同时不存在 `state/learnhub.json` 与 `课程注册表.yaml` 才视为全新库并写入 schema 戳；任一存在都走版本迁移流程。
- **技能安装**：`build.mjs` 每次构建把 `skills/*` 目录复制到 `$DSH_HOME/skills`（默认 `~/.dsh/skills`），依赖 `skill-filesystem` 内置扫描根发现，无需额外配置。
- **Preset 引用方式**：`user-root-composition.yml` 仅保留 `@deepseek-ai/cordis-plugin-include` 占位，真实 `agent.cordis.yml` 路径需在本地 `~/.dsh/.agent-presets/learnhub/agent.cordis.yml` 中替换为绝对 `file://` URL，未替换会失败。
- **运行时不可变原则**：除常量外宿主模块级 `let` 归零，所有可变态通过 `HostRuntime` 显式传递（ADR-0048），便于测试注入假 runtime。
- **运行日志**：每次引擎调用结果（成功/失败）追加到 `<center>/state/运行日志.md`，输出截断上限 1500 字符，失败不影响主流程。

## 5. 适用性判断

该仓库具备完整的配置系统：Cordis preset/profile 声明 agent 组合、profile patch 注入插件与能力、`LearnhubConfig` 承载运行时参数、`params.ts` 集中处理 API 参数校验、`build.mjs` 管理构建期技能安装。因此本类别适用。
