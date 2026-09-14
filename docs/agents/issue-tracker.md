# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`
- **Reference the ticket in the commit**: 实现性提交的标题带上所实现/所关联工单的引用 `(#123)`，一票多提交、一提交多票都照引（`(#88/#89)`）——提交是工单落地史的主要载体，回溯「哪票改了什么」靠它。不用 `Closes`/`Fixes` 关键词（GitHub 永不自动关闭，显式关闭见下条）。与任何工单都无关的纯文档/工具小改可不带。
- **Close an issue when its work lands**: once your implementation commit is on the pushed branch, close the issue you implemented in the same session — `gh issue close <number> --comment "<what shipped, acceptance result, commit sha>"`. 提交只带 `(#123)` 引用、不用 `Closes`（见上条），GitHub 永不自动关闭；the explicit close is the only close. Closing is scoped: only the issue your session implemented — prerequisites and other tickets stay with their own sessions.
- **Land it yourself — merging back is part of the task**: closing the tickets is not the end of the flow. Unless the task says otherwise, the same session merges its delivery branch back into the branch it was cut from (normally main), verifies (full test suite + build in the source checkout), and cleans up its worktree — without waiting for the user to ask for the merge. Step-by-step: `docs/agents/parallel-sessions.md` → "Merge back".

## Sub-issues and blocking edges

结构化工单（`/to-tickets` 的 tracer-bullet 票、`/wayfinder` 的决策票）挂 GitHub 原生 sub-issue 与 blocking 关系。原生关系是依赖的唯一权威载体：它机器可读（`gh issue view <n> --json parent,blockedBy`），并行会话遍历依赖边抢票靠的就是它；正文里的 "Blocked by" 至多是人读摘要。以下 flag 已在本机 gh 2.100+ 实测可用（2026-09-10）：

- **建票时**：`gh issue create --parent <父票号> --blocked-by <阻塞票号,...>`，反向声明用 `--blocking`。
- **挂到已有票**：`gh issue edit <n> --parent <p>`、`--add-sub-issue <m,...>`、`--add-blocked-by <m,...>`、`--add-blocking <m,...>`，各有对应的 `--remove-parent` / `--remove-sub-issue` / `--remove-blocked-by` / `--remove-blocking`。
- **粒度：执行票宜少不宜多。** 一张执行票应是一个会话能一次端到端做完的交付面，不要按技术层或文件清单再切。拆得越细，认领／依赖边／关闭的协调成本涨得比收益快，而纯串行链上的票并行度实际为零。
- **共享受管制面是隐藏的串行化轴（2026-09-14 补，#247 拆票复盘）。** 验收独立不等于合并零冲突：多票同时触碰 prompt-bump 版本单点、params、棘轮基线这类受管制面时，开发可并行但合并要排队——后合并方重跑过门动作。这不改变是否拆票（验收独立性与容量判据优先），但拆票时应在票面注明：共享面的主改动归属哪张票、合并顺序如何排、各票对共享面的触碰是否已最小化（能用注入或引擎侧文字表达的措辞，不新开提示词常量）。
- **票数下限同样有判据：容量风险与受管制单点归并（2026-09-14 补，#247 拆票复盘）。** 「宜少不宜多」不是切到最少：单票超过一个会话的舒适容量（约七成以上）就是撞车风险，多票挤同一受管制单点则合并排队——这两种情况加拆反而提效；反之，常量调整、小 UI 面这类零碎项永远不独立成票（认领开销大于独立性收益），并入最相近的交付面。受管制单点（例如提示词/prompt-bump、params等）应尽量**归并到一票独占**且该票最后合并，让过门动作只发生一次。实例：#247 按此切三票——卡点自报闭环（~五成会话）/ 工具面扩展（~四成五）/ 全图摘要+全部教练提示词（~四成，独占 prompt-bump 最后合并），三票无阻塞边并行开发。

## Sandboxed execution and gh authentication

`gh` normally reads its GitHub token from the OS credential store. On Windows this is the Credential Manager. A sandboxed command may be unable to read that store, so `gh auth status` can incorrectly report that the saved token is invalid even though the same command succeeds outside the sandbox.

If `gh` fails with `HTTP 401: Requires authentication`, first retry the specific `gh` command with elevated/non-sandboxed execution. Prefer narrowly scoped approval prefixes such as `gh issue view`, `gh issue create`, `gh label list`, and `gh auth status`. Avoid granting a blanket `gh` prefix for all operations: `gh` can also perform destructive or high-risk repository actions.

Do not work around this by putting a GitHub token in an environment variable or using `gh auth login --insecure-storage` unless the user explicitly accepts that trade-off. Keeping the token in the OS credential store is the default.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Claim a ticket before working on it

Never start work on an issue before claiming it. Claiming is two steps, both completed before any other action on the ticket:

1. **Assign**: `gh issue edit <n> --add-assignee maozhijie`
2. **Comment immediately**: a one-line claim note ("已认领，开工：<内容> — <UTC 时间>"). The comment is not ceremony: every parallel session on this machine shares the single `maozhijie` account, so the assignee field cannot tell "claimed by this session" from "claimed by another session". The claim comment is the only cross-session visible occupancy marker.

**Re-check right before the work starts, not just when claiming.** Loading context, researching, or grilling can burn an hour between claim and first edit. If a claim comment that isn't yours has appeared on your ticket, drop it untouched and take the next ticket — a re-pick is always cheaper than duplicate work.

This rule is written in an incident's blood: 2026-09-09, two wayfinder sessions on map #73 both ran as `maozhijie`; one claimed by assignment only, the other had no way to see that claim and took an overlapping ticket.

## Transient gh failures: retry once before diagnosing

`gh` calls can fail transiently on this machine: a `gh issue view <n> --comments` may return empty output while the same view succeeds on retry, and GraphQL calls can die with `TLS handshake timeout`. Both observed 2026-09-09, both fine on immediate retry. Retry the same command once before concluding anything about auth, sandboxing, or the issue's existence.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
