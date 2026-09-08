# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`
- **Close an issue when its work lands**: once your implementation commit is on the pushed branch, close the issue you implemented in the same session — `gh issue close <number> --comment "<what shipped, acceptance result, commit sha>"`. Commit messages here reference issues as `(#123)` without `Closes` keywords, so GitHub never auto-closes; the explicit close is the only close. Closing is scoped: only the issue your session implemented — prerequisites and other tickets stay with their own sessions.

## Sandboxed execution and gh authentication

`gh` normally reads its GitHub token from the OS credential store. On Windows this is the Credential Manager. A sandboxed command may be unable to read that store, so `gh auth status` can incorrectly report that the saved token is invalid even though the same command succeeds outside the sandbox.

If `gh` fails with `HTTP 401: Requires authentication`, first retry the specific `gh` command with elevated/non-sandboxed execution. Prefer narrowly scoped approval prefixes such as `gh issue view`, `gh issue create`, `gh label list`, and `gh auth status`. Avoid granting a blanket `gh` prefix for all operations: `gh` can also perform destructive or high-risk repository actions.

Do not work around this by putting a GitHub token in an environment variable or using `gh auth login --insecure-storage` unless the user explicitly accepts that trade-off. Keeping the token in the OS credential store is the default.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
