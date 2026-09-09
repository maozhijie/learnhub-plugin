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

报 `Cannot find package '@deepseek-ai/dsh-llm'` 时是 peer junction 缺失：本插件以 `link:` 装进 profile，Node 按仓库真实路径解析 peer，被 import 的宿主私有包（dsh-llm、dsh-tools，见 `src/index.ts` 顶部）必须以 junction 形式存在于本仓库 `node_modules/@deepseek-ai/`。跑一次脚本补齐：

```sh
node scripts/link-peers.mjs
```

默认从 npx 缓存里 dsh 自带的副本取源（与宿主实际加载同一份，版本天然一致；npm 上虽有同包但 `latest` 标签停在旧版，不能作普通依赖安装）。npx 缓存目录按调用 spec 生成哈希，`npx @deepseek-ai/dsh web` 原地更新不影响 junction；换 spec（如 `dsh@0.2`）会生成新目录致 junction 悬空，重跑脚本即可。设 `DSH_MONOREPO` 可改从 deepseek-harness monorepo 检出取源（本机该检出已删除）。

报 `[learnhub] config.vault 目录不存在` 时是 vault 挪了位置：机器级配置（vault 路径、provider、model）不在仓库里，写在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dsh-learnhub` patch 条目中，按机器现状改那里。

## 并行会话用 worktree 隔离

ZCode 没有会话级分支/worktree 隔离：同目录开多个会话共享同一 checkout 和当前分支，未提交改动与 switch/rebase 会互相踩。并行做多个任务时，每个任务建一个 git worktree、每个 worktree 开一个会话；同一会话内的并行 subagent 共享工作目录，配置隔离不了，只能按文件范围拆分或改走多 worktree。命令与注意事项见 `docs/agents/parallel-sessions.md`。
