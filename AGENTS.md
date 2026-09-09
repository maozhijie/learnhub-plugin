## Agent skills

### Issue tracker

Issues live in GitHub Issues (`maozhijie/learnhub-plugin`); an issue whose implementation has landed is closed by the implementing agent in the same session. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to Chinese label strings (`待分类`、`待补充信息`、`可交给Agent`、`需人工处理`、`不予修复`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## 本地启动 dsh 宿主

编译后重启宿主才能生效（lib 是宿主启动时加载的，不热更新）：

```sh
npx @deepseek-ai/dsh web
```

`web` 是 profile 名（profile 在 `~/.dsh/profiles/web`，本插件以 `link:` 装在其中）；后台运行、启动完看输出里的本地 URL。

首次报 `Cannot find package '@deepseek-ai/dsh-llm'` 时是 peer junction 缺失，用本机 monorepo 路径补一次（link-peers 默认指向 `C:/Users/test/...`，本机实际在 `C:/Users/Administrator/Desktop/deepseek-harness/packages`）：

```sh
DSH_MONOREPO="C:/Users/Administrator/Desktop/deepseek-harness/packages" node scripts/link-peers.mjs
```

## 并行会话用 worktree 隔离

ZCode 没有会话级分支/worktree 隔离：同目录开多个会话共享同一 checkout 和当前分支，未提交改动与 switch/rebase 会互相踩。并行做多个任务时，每个任务建一个 git worktree、每个 worktree 开一个会话；同一会话内的并行 subagent 共享工作目录，配置隔离不了，只能按文件范围拆分或改走多 worktree。命令与注意事项见 `docs/agents/parallel-sessions.md`。
