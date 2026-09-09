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
- **Dependencies are per worktree.** `node_modules` is not shared; run the install step in each new worktree before building or testing.
- **Per-task boundaries go in the session prompt, not `AGENTS.md`.** `AGENTS.md` is committed, so every worktree sees the identical file. State the worktree's task and branch boundary in the opening prompt to keep the session from drifting into files another session owns.
- **dsh host testing only reflects the linked checkout.** The `web` profile installs this plugin via `link:` to one fixed path, so `npx @deepseek-ai/dsh web` always loads that checkout's build no matter which worktree the session runs in. To smoke-test a worktree's build in the host, re-point the profile's `link:` at the worktree first (and back afterwards).

## Clean up

After the branch is merged:

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
