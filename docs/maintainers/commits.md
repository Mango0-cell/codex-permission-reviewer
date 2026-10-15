# Commit conventions

Read root AGENTS.md and CONTRIBUTING.md first. A commit should capture one
reviewable concern so its diff and message explain the same change. Use judgment:
there is no file-count or line-count quota, and a cohesive change may span its
implementation, tests and documentation.

## Before staging

Inspect the current branch, status and diff. Confirm which edits belong to this
task and leave other contributors' changes untouched. Stage specific paths or
hunks; do not use blanket staging when the worktree contains unrelated edits.
Review the staged diff before committing, including renamed and generated files.
Generated compatibility output should be regenerated through its checked-in
build path rather than edited independently.

If the staged change describes two independent behaviors, split it into separate
commits. Keep a bug fix distinct from a behavior-preserving refactor or a
maintenance-only change unless the task makes them inseparable. Finish a focused
check for the staged concern before committing.

## Message format

Use Conventional Commit format:

```text
<type>(<scope>): <imperative summary>
```

Use one of these types:

| Type | Use |
| --- | --- |
| `feat` | Add a user-visible capability or behavior |
| `fix` | Correct behavior that is wrong or incomplete |
| `refactor` | Restructure code without changing its behavior |
| `test` | Add or change tests without changing production behavior |
| `docs` | Change documentation or agent guidance only |
| `chore` | Adjust build, packaging, dependencies or maintenance tooling |

Use a concise domain scope when it helps a reviewer locate the change: `action`,
`policy`, `approvals`, `review`, `runtime`, `transport`, `cli`, `build`, `agents`,
`ci` or `docs`. For work crossing domains, choose the scope that owns the main
behavior; do not invent an issue identifier or force a scope onto a trivial change.
Write an imperative summary, keep the subject to about 72 characters, and omit a
trailing period. Add a body when the reason or observable effect is not clear from
the subject. Mention focused checks when they help reviewers assess the commit.

Examples:

```text
fix(policy): preserve the human review path for sensitive actions
refactor(review): keep child cleanup with the process owner
docs(agents): add exact-head PR review guidance
```

## Preserve history and authorship

Use the configured Git author identity. Do not invent task identifiers or
co-author/AI-attribution trailers. Do not amend a published/shared commit, bypass
hooks, or rewrite history to hide a reviewable change. Do not push as a side effect
of committing; follow the current task's GitHub authorization and PR workflow.

For PR preparation, see [the PR workflow](pull-requests.md).
