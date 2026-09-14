---
kind: error_handling
name: LearnHub 插件的错误处理体系：ParamError + 领域校验错误 + apiRun 统一日志
category: error_handling
scope:
    - '**'
source_files:
    - src/host/params.ts
    - src/host/runtime.ts
    - src/host/handlers.ts
    - src/host/http.ts
    - src/engine/error-cards.ts
---

## 1. 总体方案

本仓库没有统一的业务异常类层次，而是采用「参数层抛 `ParamError`、领域层抛普通 `Error`（或带前缀的自定义消息）、HTTP 分发层统一 catch」的分层策略。核心思路是：**请求入口严格校验参数**，引擎内部用可读的 `Error` 表达业务失败，宿主路由通过 `apiRun` 记录运行日志并原样向上抛出，由上层 HTTP 中间件统一转 JSON 响应。

## 2. 关键文件与职责

- **`src/host/params.ts`**：唯一参数守卫来源。定义 `ParamError extends Error` 以及 `need / needQuery / requireString / requireBoolean / requireNumber / requireObject / requireOneOf / optText / optTrimmed / optRaw / optString / optNumber / optFinite / optBoolean / optTrue / optObject / optList / pick / readArgs` 等函数。所有路由的参数取值都走这里，非法参数一律抛 `ParamError`。
- **`src/host/runtime.ts`**：提供 `apiRun(rt, tool, fn)`——每个 handler 调用引擎的包装器，捕获异常后写入 `state/运行日志.md` 再重新抛出；同时提供 `runLog` 追加结构化日志。
- **`src/host/handlers.ts`**：面板路由表，全部 handler 使用 `sendJson(res, 200, await apiRun(...))` 模式，把引擎返回对象透传出去；参数校验在 handler 内通过 `need / optXxx` 完成，非法时抛 `ParamError`。
- **`src/engine/error-cards.ts`**：领域层错误处理的代表——对错误对比卡文件的加载/写入做 schema 校验，缺失文件视为合法空卡组，存在但格式坏则通过 `cardError('error-card-load' | 'error-card-add' | ... , path, detail)` 构造带操作名和路径的 `Error` 抛出；新增卡时还做去重守卫（同来源题已有活跃卡抛错）。
- **`src/host/http.ts`**：纯技术层，只负责 `sendJson` / `readJson` / MIME 表，不处理错误逻辑。

## 3. 架构与约定

### 3.1 参数校验：fail loud，统一 `ParamError`

`params.ts` 的注释明确约束：必填缺失/类型不符一律抛 `ParamError`，可选参数「省略或合法」——键在场但类型不符也抛 `ParamError`（#185 裁决收紧）。错误消息统一中文，例如 `缺少必填参数：<key>`、`非法可选参数：<key>（应为…）`、`缺少或非法必填参数：<key>（允许：a|b|c）`。分发层根据是否为 `ParamError` 附加路由信息 `(路由 <method> <route>)`，使客户端报错可定位。

### 3.2 引擎业务错误：普通 `Error`，语义化消息

引擎内部不使用自定义异常类，而是直接 `throw new Error(...)` 或 `throw cardError(op, path, detail)`。错误消息通常以 `[模块] 描述` 形式开头（如 `[error-card-add]`、`[learnhub] config.vault 缺失`），便于日志检索。这类错误不是 `ParamError`，会被 `apiRun` 原样上抛，由上层按通用错误处理。

### 3.3 路由出口：`apiRun` 统一日志 + 原样抛错

每个 handler 的写法高度一致：
```ts
sendJson(res, 200, await apiRun(rt, 'api/xxx', () => rt.engine.xxx(...)))
```
`apiRun` 会：
- 成功：序列化输出到运行日志，返回结果给 `sendJson`。
- 失败：记录 `调用失败：...` 到运行日志，然后 `throw err` 原样上抛。

这意味着 HTTP 层的错误呈现由宿主框架（Cordis 插件运行时）决定，LearnHub 自身不在此处拦截。

### 3.4 领域数据完整性：Missing vs Broken

`error-cards.ts` 的注释引用 ADR-0004：「文件缺失 = 合法空卡组；存在但坏 = 抛 Broken」。即读侧对不存在的路径容忍（返回 `{ node, cards: [] }`），但对已存在但解析失败的文档立即抛错，防止静默降级污染数据。

### 3.5 配置装配期 fail loud

`createHostRuntime` 在启动时校验 `config.vault`、`config.quizAuditRate` 等部署参数，不合法直接 `throw new Error('[learnhub] ...')`，不做静默兜底。

## 4. 约定与约束总结

- 所有 HTTP 入参必须经 `params.ts` 的守卫函数取值，禁止手写 `typeof body.x` 守卫。
- 参数错误统一抛 `ParamError`，业务错误抛普通 `Error`（或带前缀的消息），两者在分发层有区分。
- 所有引擎调用必须包在 `apiRun(rt, 'api/...', fn)` 中，以便记录运行日志。
- 领域数据加载遵循 Missing/Broken 纪律：缺失文件不算错，损坏文件必须抛错。
- 错误消息倾向中文且包含上下文（操作名、路径、路由名），便于运维排查。
- 日志失败（`runLog` 写盘）被吞掉，不影响主流程，保证健壮性。

## 5. 未覆盖范围

仓库中没有全局 try/catch 中间件、没有统一的错误码枚举、没有 `panic/recover` 模式（Node.js 环境也不适用）、没有专门的错误响应结构体——错误呈现依赖 Cordis 宿主框架的统一错误处理。测试层通过 `tests/*.test.ts` 断言抛错行为（如 `error-cards.test.ts`、`host-routes.test.ts`）来验证这些约定。
