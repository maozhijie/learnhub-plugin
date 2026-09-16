# Parallel sessions: branch/worktree isolation

ZCode has no built-in per-session branch or worktree assignment. A session is bound to the directory it is opened in: two sessions on the same directory share one checkout and one current branch, so they overwrite each other's uncommitted changes and fight over `git switch` / `git rebase`.

The fix is structural, not configurational: **one git worktree per task, one ZCode session per worktree.** 并行任务的默认形态不再是临时新建 worktree，而是下面这个常驻池；本文其余章节（临时新建、merge back、清理）降级为后备手段。

## 常驻 worktree 池（并行任务默认走这里）

三个**永不销毁**的 worktree 组成池，认领制使用：

| 池位 | 路径 | 分支 | codebase 索引 project 名 |
|---|---|---|---|
| wt-1 | `../learnhub-wt-1` | `wt-1` | `C-Users-test-Desktop-my-learnhub-wt-1` |
| wt-2 | `../learnhub-wt-2` | `wt-2` | `C-Users-test-Desktop-my-learnhub-wt-2` |
| wt-3 | `../learnhub-wt-3` | `wt-3` | `C-Users-test-Desktop-my-learnhub-wt-3` |

常驻的理由：省掉每次「建 worktree + 两处 `npm install`」的固定成本；codebase 索引按绝对路径分库、重索引是一次完整管线跑——**正因池位不销毁，索引才值得建一次、养一世**。下文临时 worktree 的限制大多仍适用于临时场合，唯独「别在 worktree 里建索引」对池位**不适用**（它们是唯一例外）。

任务全流程，工具一律 `scripts/worktree-pool.mjs`：

### ① 认领

```sh
node scripts/worktree-pool.mjs claim --task "<一句话任务描述>"
```

- 脚本以 `flag: 'wx'` **原子**写认领标记（`<仓父目录>/.learnhub-wt-claims/<池位>.json`，含任务与时间戳）：已认领池位自动跳过，两个会话同抢一个池位只有一个成功；全满时报错退出。标记放**仓外**是故意的——git 看不见，不会被 ② 的 `git add -A` 误提交，也不污染池位的 `git status`。
- **绕过脚本、手动跳过标记直接用 = 撞车**。看池况：`node scripts/worktree-pool.mjs status`。
- 同一会话里的并行 subagent 照样认领：subagent 隔离不了工作目录，但文件操作全走池位**绝对路径**、图查询传池位自己的 project 名，即等效隔离。

### ② 同步（先提交本地，再追平远端）

```sh
git -C ../learnhub-wt-N add -A && git -C ../learnhub-wt-N commit -m "wip: sync 前落盘"   # 仅有脏改动时
git -C ../learnhub-wt-N fetch origin
git -C ../learnhub-wt-N rebase origin/main
```

- 最复杂的情形是「云端与本地都有新内容」：**先提交本地**（脏树 rebase 会当场拒绝），rebase 一次性追平；无本地提交时退化为 fast-forward。
- rebase 后 `git log origin/main..HEAD` 过一眼：出现**不是本任务带来的提交** = 上一任务未整合的遗留，先向用户确认再动，别默默带着跑。
- 冲突：停下报告用户，不要自动硬解。

### ③ 刷新索引

```
index_repository(repo_path="C:/Users/test/Desktop/my/learnhub-wt-N", mode="moderate")
```

之后本池位的一切图查询（`search_graph` / `query_graph` / `trace_path` / `detect_changes`）都传上表的 project 名。重索引是完整管线跑、非增量——「认领即刷新」是池制的设计成本，宁慢勿旧（拿不准是否落后时，先按 `code-index.md` §新鲜度用 `index_status` 的 `head_sha` 对 HEAD 秒判）。`persistence: true` 对池位同样禁止。

### ④ 探索与执行

先图后文件的判据照旧（`AGENTS.md` §代码索引）；文件操作用池位绝对路径。

### ⑤ 合入 main 后释放

**默认自动合入（用户 2026-09-16 裁决）：任务收尾时 agent 自己把池位分支合回 main，不等人工。** 判据驱动的执行序列：

1. 成果在池位分支已提交且全量 `npm test` 绿（含类型门与棘轮；基线迁移同提交）。
2. 到主检出（`learnhub-plugin`）`fetch origin` 确认 main 未漂移：`wt-N` 基于 `origin/main` 头且主检出差无它人在途提交 → 直接 `git merge --ff-only wt-N`；main 已前进 → 先在池位 `rebase origin/main` 复跑受影响的门再重试 ff。
3. `git push origin main`。
4. 主检出的**脏文件不碰**（可能是他人/用户在途作业）：ff 合并只要不触碰脏文件即可成功；若冲突面涉脏文件，停下报告，不代任何人决断。
5. 合入后再删标记释放：

```sh
node scripts/worktree-pool.mjs release <1|2|3>
```

**豁免**（不合入直接释放或等人工的情形）：任务面未过全量门；票面明说「不落地/仅调研」；用户当次任务另作交代。远程分支 `wt-N` 合入后可留作存档（池分支被复用时会被 ② 强制重置，不构成堆积）。

**成果未整合就释放要慎重**：下一认领者的 ② 会把这些未整合提交一起 rebase 带走。

### 定期保养（用户或定时任务）

只对**未被认领**的池位跑 `node scripts/worktree-pool.mjs sync`（= ② 的同款动作：脏树先提交 → fetch → rebase；冲突自动 abort 保持原状并报告，绝不留冲突态），认领中的一律不碰。索引的批量刷新没有 CLI——让任一会话对各池位重跑一次 ③ 即可。

## When to use this（临时 worktree：后备手段）

Use separate worktrees whenever two or more sessions must work in this repo at the same time (e.g. implementing two independent issues in parallel).

A single session with parallel subagents does not need them and cannot benefit: subagents inside one session always share the session's working directory, and no configuration isolates them. Split such work by file scope instead, or fall back to multi-worktree + multi-session.

## Create

From the main checkout:

```sh
git worktree add ../learnhub-plugin-task1 -b feature/task1
git worktree add ../learnhub-plugin-task2 -b feature/task2
git worktree list
```

Open one ZCode session per worktree directory. Commits, branch switches, and rebases in one worktree never touch the others; the main checkout stays free as the integration point.

## Constraints

- **Uncommitted changes stay behind.** A new worktree checks out committed state only — commit or stash in the source checkout before branching off.
- **Dependencies are per worktree — and `ui/` is a second, separate install.** `node_modules` is not shared; a new worktree needs BOTH installs: `npm install` at the root（宿主/引擎/测试）AND `cd ui && npm install`（面板子包有自己的 package.json，不会被根安装带出）. Installing the root only is the standard trap: nothing complains at install time — the failure surfaces later as `tests/md-chain.test.ts` dying with `ERR_MODULE_NOT_FOUND: Cannot find package 'remark-gfm'`（该测试经 `ui/src/lib/md-chain.ts` 导入子包依赖），and `ui` typecheck/build fail the same way. The error site is far from the cause; it reads like a code bug but is a missing install.
- **Per-task boundaries go in the session prompt, not `AGENTS.md`.** `AGENTS.md` is committed, so every worktree sees the identical file. State the worktree's task and branch boundary in the opening prompt to keep the session from drifting into files another session owns.
- **Never junction `node_modules` into a worktree.** Saving the double install with `mklink /J <worktree>/node_modules <checkout>/node_modules` works for running tests — and then `git worktree remove` **deletes through the junction and wipes the source checkout's `node_modules`**（实测 2026-09-13：#229/#220 两个 worktree 用联接省安装，remove 之后主检出的 root 与 `ui/` 依赖全空，`npm test` 与任何 import 真包的脚本当场 `ERR_MODULE_NOT_FOUND`）。修复 = 主检出重跑两处 `npm install`。联结是 Windows 上「看着像目录的链接」，递归删除工具（git 的 worktree 清理走的就是它）不会替你区分链接与目标——**这条省时技巧的代价是主检出的依赖**，按上一节老实装两份。
- **dsh host testing only reflects the linked checkout.** The `web` profile installs this plugin via `link:` to one fixed path, so `npx @deepseek-ai/dsh web` always loads that checkout's build no matter which worktree the session runs in. To smoke-test a worktree's build in the host, re-point the profile's `link:` at the worktree first (and back afterwards).

## Merge back: only when the session runs on its own branch

**Read the scope first — this section is the worktree flow above, not a default every session must follow.** A single session working directly in the main checkout commits and pushes on the current branch, and that is already landing: nothing was cut, so there is nothing to merge back. Do not create a branch just to have one to merge.

When it does apply (the task owns a `feature/*` branch in its own worktree): landing is part of the task, not a separate handoff, and the flow ends with the branch merged back, not with a pushed feature branch. Unless the task explicitly says otherwise, the session that owns the worktree merges its branch back into **the branch it was cut from** (normally main) in the same session — commit → push → close issues (see `issue-tracker.md`) → merge back → verify → clean up. Do not stop and wait for the user to say "merge".

Run the merge in the source checkout (the integration point), never inside the task worktree:

1. **Re-check the base first.** `git fetch origin`, then compare. If the source branch still points at your branch point, `git merge --ff-only <feature-branch>` — fast-forward keeps the linear history this repo runs on. If it has moved (another session landed first): merge the source branch into your feature branch inside the worktree, re-run the full test suite, push the feature branch again, then do a plain merge in the source checkout. Never rewrite or force-push the source branch.
2. **Respect the source checkout's dirty files.** `git status --short` there first. Other sessions' uncommitted edits are theirs; if the merge would touch a file that is dirty in the source checkout, stop and coordinate — do not stash, revert, or commit their hunks to get the merge through. A merge that touches none of the dirty files is safe to proceed.
3. **Verify after merging.** Run the full test suite and the build in the source checkout — environment insurance (each worktree has its own node_modules) and it refreshes `lib/` so the dsh host loads the merged build on its next restart.
4. **Clean up** (below). Remote feature branches stay on origin unless there is a reason to delete them.

## Clean up

After the branch is merged back (by you, per above):

```sh
git worktree remove ../learnhub-plugin-task1
git branch -d feature/task1
```

## The code index is keyed by path, so worktrees multiply it

The `codebase-memory-mcp` index is keyed by **absolute path**, so every worktree is a separate project holding a complete copy of its own graph — no dedupe, and nothing in `list_projects` links a worktree back to its canonical checkout. Indexing a second worktree means a second full index, not a delta of the first.

Two rules for this repo, both detailed in `docs/agents/code-index.md`:

1. **Index the main checkout once and treat that index as canonical; do not index inside an ad-hoc worktree.** Worktrees here exist to isolate uncommitted changes, not structural knowledge, so the canonical index covers most tasks. If you do need branch-specific structure, call `delete_project` **in the same session, before removing the worktree** — after removal the path-derived name is hard to reconstruct. **唯一例外是常驻池位**（§常驻 worktree 池）：它们永不销毁，各有自己的索引，建一次、每次认领后刷新——`delete_project` 对池位无意义，不存在「移除 worktree 留死记录」的问题。
2. **Never pass `persistence: true` from a worktree.** It writes `.codebase-memory/graph.db.zst` **inside `repo_path`**, leaving a large untracked directory in a worktree — the same class of mess the junction warning above describes. `.gitignore` covers `/.codebase-memory/` as insurance, but the artifact still has to be deleted by hand.

Removing the worktree does **not** remove the project record: it stays in `list_projects` with `status: ready` and its nodes still answerable, `root_exists` / `is_git` turn false, and its `branch` field goes **null** — so the list loses the one field that identified it as a dead worktree. `delete_project` is the only thing that clears the record and its `.db`.

## Shared-checkout races: rules from the 2026-09-09 double-ruling

Worktrees are the structural fix, but wayfinder maps invite several sessions onto one map at once, and those sessions sometimes share one checkout anyway. Two rulings landing the same afternoon both picked ADR number 0016 from a stale directory listing and both appended to `CONTEXT.md` within minutes. What worked, in order of when it matters:

- **Re-check `docs/adr/` immediately before writing, and again before staging.** An `ls` taken at session start goes stale while you grill or research. On collision, rename your file to the next free number before the first commit — nothing inside the ADR references its own number, so the rename is free.
- **Treat `CONTEXT.md` as append-only.** New entries go at the end, so concurrent sessions' edits stack instead of overlapping semantically. If the Edit tool reports the file changed since read, re-read the tail and re-apply — that guard is the race being caught, not a tool fault.
- **Stage only your own hunks when you must commit first.** If the other session's edits are still uncommitted in the same file, `git commit <paths>` is wrong — it snapshots the worktree and carries their content under your message. Rebuild the staged blob instead: `git show HEAD:<file>` plus only your additions → `git hash-object -w` → `git update-index --cacheinfo 100644,<sha>,<file>`, then a pathless `git commit` (index-only). Their diff survives in the worktree for their own commit.
- **Expect `M` flags on files you don't own.** Scope every `git add` to files your ticket produced; leave everything else in the worktree untouched, even when it looks abandoned (the other session may be mid-flight).
