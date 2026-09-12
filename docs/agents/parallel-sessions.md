# Parallel sessions: branch/worktree isolation

ZCode has no built-in per-session branch or worktree assignment. A session is bound to the directory it is opened in: two sessions on the same directory share one checkout and one current branch, so they overwrite each other's uncommitted changes and fight over `git switch` / `git rebase`.

The fix is structural, not configurational: **one git worktree per task, one ZCode session per worktree.**

## When to use this

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
- **Dependencies are per worktree — and `ui/` is a second, separate install.** `node_modules` is not shared; a new worktree needs BOTH installs: `npm install` at the root（宿主/引擎/测试）AND `cd ui && npm install`（面板子包有自己的 package.json，不会被根安装带出）. Installing the root only is the standard trap: nothing complains at install time — the failure surfaces later as `tests/md-chain.test.ts` dying with `ERR_MODULE_NOT_FOUND: Cannot find package 'remark-gfm'`（该测试经 `ui/src/components/md-chain.ts` 导入子包依赖），and `ui` typecheck/build fail the same way. The error site is far from the cause; it reads like a code bug but is a missing install.
- **Per-task boundaries go in the session prompt, not `AGENTS.md`.** `AGENTS.md` is committed, so every worktree sees the identical file. State the worktree's task and branch boundary in the opening prompt to keep the session from drifting into files another session owns.
- **dsh host testing only reflects the linked checkout.** The `web` profile installs this plugin via `link:` to one fixed path, so `npx @deepseek-ai/dsh web` always loads that checkout's build no matter which worktree the session runs in. To smoke-test a worktree's build in the host, re-point the profile's `link:` at the worktree first (and back afterwards).

## Merge back: the session lands its own branch (default)

Landing is part of the task, not a separate handoff. The flow ends with the branch merged back, not with a pushed feature branch: unless the task explicitly says otherwise, the session that owns the worktree merges its branch back into **the branch it was cut from** (normally main) in the same session — commit → push → close issues (see `issue-tracker.md`) → merge back → verify → clean up. Do not stop and wait for the user to say "merge".

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

## Shared-checkout races: rules from the 2026-09-09 double-ruling

Worktrees are the structural fix, but wayfinder maps invite several sessions onto one map at once, and those sessions sometimes share one checkout anyway. Two rulings landing the same afternoon both picked ADR number 0016 from a stale directory listing and both appended to `CONTEXT.md` within minutes. What worked, in order of when it matters:

- **Re-check `docs/adr/` immediately before writing, and again before staging.** An `ls` taken at session start goes stale while you grill or research. On collision, rename your file to the next free number before the first commit — nothing inside the ADR references its own number, so the rename is free.
- **Treat `CONTEXT.md` as append-only.** New entries go at the end, so concurrent sessions' edits stack instead of overlapping semantically. If the Edit tool reports the file changed since read, re-read the tail and re-apply — that guard is the race being caught, not a tool fault.
- **Stage only your own hunks when you must commit first.** If the other session's edits are still uncommitted in the same file, `git commit <paths>` is wrong — it snapshots the worktree and carries their content under your message. Rebuild the staged blob instead: `git show HEAD:<file>` plus only your additions → `git hash-object -w` → `git update-index --cacheinfo 100644,<sha>,<file>`, then a pathless `git commit` (index-only). Their diff survives in the worktree for their own commit.
- **Expect `M` flags on files you don't own.** Scope every `git add` to files your ticket produced; leave everything else in the worktree untouched, even when it looks abandoned (the other session may be mid-flight).
