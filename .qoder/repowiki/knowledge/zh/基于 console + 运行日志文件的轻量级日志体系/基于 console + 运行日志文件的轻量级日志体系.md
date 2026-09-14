---
kind: logging_system
name: 基于 console + 运行日志文件的轻量级日志体系
category: logging_system
scope:
    - '**'
source_files:
    - src/host/runtime.ts
    - src/host/jobs.ts
---

## 1. 使用的系统/方案

仓库没有引入任何第三方日志框架（无 winston、pino、bunyan、debug 等依赖），而是采用**两层组合的极简日志方案**：
- **控制台输出**：直接调用 Node.js `console.log` / `console.info` / `console.error`，用于进程标准输出。
- **持久化运行日志**：通过 `src/host/runtime.ts` 中的 `runLog()` 将每次引擎工具调用的结果追加写入 vault 状态目录下的 `state/<学习中心>/运行日志.md`，作为可审计的 Markdown 文件。

该方案由宿主层统一封装，引擎业务代码不直接写日志，仅通过 `apiRun` / `run` 包装器间接落盘。Agent 调用链路在 `AgentSeam.onCall` 回调中同时打 `console.info` 与 `runLog`，实现“stdout + 文件”双通道。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `src/host/runtime.ts` | 定义 `runLog(rt, tool, output)`、`run(rt, tool, fn)`、`apiRun(rt, tool, fn)`；构造 `HostRuntime` 时注入 agent 调用日志；定义 `LOG_LIMIT = 1500` 截断常量 |
| `src/host/jobs.ts` | 生成任务恢复流程中用 `console.error` / `console.log` 打印恢复统计，并调用 `runLog('gen_jobs_restore', ...)` 记录失败 |
| `tests/...` | 测试用例使用 `console.log` 打印诊断信息（测试专用） |

## 3. 架构与约定

### 3.1 日志入口分层
- **宿主层（host）**：唯一负责写日志的地方。`runtime.ts` 提供三个入口：
  - `runLog(rt, tool, output)`：异步追加 Markdown 条目到 `运行日志.md`，每条格式为 `## <ISO 时间> · <tool名>` + fenced code block，内容超过 1500 字符会被截断并追加 `…（已截断）`。
  - `run(rt, tool, fn)`：执行引擎方法后把返回值以字符串形式写入运行日志。
  - `apiRun(rt, tool, fn)`：面板 API 出口，成功时序列化对象写入日志，失败时捕获异常消息写入日志后再抛出。
- **Agent 调用链**：`createHostRuntime` 中 `new AgentSeam({ onCall: r => { console.info(...); runLog(...) } })`，对每次 LLM 调用同时输出控制台行和运行日志。
- **引擎层（engine）**：不直接产生日志，只返回结构化数据；所有副作用由宿主包装。

### 3.2 日志级别策略
仓库未定义正式 log level 枚举，实际使用方式如下：
- `console.info`：正常运行时的重要事件（如 agent 调用详情、任务恢复统计）。
- `console.error`：恢复失败、队列 broken 等错误场景。
- `console.log`：恢复完成后的统计摘要。
- 运行日志文件（`运行日志.md`）不分级别，按调用顺序追加，包含成功与失败两种情况。

### 3.3 结构化字段
运行日志每条记录包含以下字段：
- 时间戳：`new Date().toLocaleString('sv-SE')`（ISO-like 本地化格式）
- 工具名：`tool` 参数（如 `llm_call`、`gen_jobs_restore`）
- 输出摘要：被截断至 1500 字符的字符串或 JSON 序列化结果

Agent 调用日志额外携带：`station`、`mode`、`callNo`、`effort`、`durationMs`、`promptChars`、`replyChars`、`usage.inputTokens/outputTokens/reasoningTokens`。

### 3.4 容错设计
- `runLog` 内部 try/catch 包裹全部 I/O，**日志失败不影响主流程**（fire-and-forget 语义）。
- 任务恢复失败设置 `rt.flags.genQueueBroken` 并写入运行日志，但不中断宿主启动。
- 运行日志文件不存在时自动创建目录并写入表头注释：`# 运行日志\n\n> 插件调用 learnhub 引擎的记录。引擎自动产出，勿手工改。`

## 4. 约定与约束

1. **禁止引擎模块直接写日志**：引擎代码中未发现 `console.*` 调用，日志职责集中在 `host/` 层（经 grep 验证）。业务逻辑应通过 `run` / `apiRun` 包装返回结果。
2. **控制台日志必须带 `[learnhub]` 前缀**：现有 `console.log/info/error` 均使用 `[learnhub]` 或 `[learnhub:agent]` 命名空间前缀，便于在宿主 stdout 中过滤。
3. **运行日志不可手工编辑**：文件头部明确标注“引擎自动产出，勿手工改”，且 `apiRun` 会覆盖失败路径的日志，保证单向追加。
4. **单条日志 1500 字符上限**：`LOG_LIMIT = 1500` 常量强制截断，防止超大响应撑爆日志文件。
5. **日志失败静默**：`runLog` 的 catch 分支吞掉异常，确保日志子系统故障不会污染业务流。
6. **Agent 调用必双写**：`onCall` 回调同时输出 `console.info` 和 `runLog('llm_call', ...)`，形成 stdout + 文件的双重观测面。
7. **测试代码不受约束**：`tests/` 下直接使用 `console.log` 打印调试信息，这是测试专用行为，不应视为生产约定。