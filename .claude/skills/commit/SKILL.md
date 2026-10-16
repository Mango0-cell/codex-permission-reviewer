---
name: commit
description: Prepare a focused Git commit in this repository by reviewing changes, staging only task-related paths or hunks, and choosing a domain-scoped Conventional Commit message. Use when the user asks to commit.
---

# Commit

Read the root `CLAUDE.md` (it imports the canonical `AGENTS.md`) and the
[commit guide](../../../docs/maintainers/commits.md). Check the branch, working
tree and staged diff. Stage only files or hunks for the authorized logical
change; leave unrelated work untouched. Review the staged diff and run a focused
check before committing.

Use the domain scope and message format in the guide. Do not invent task IDs,
bypass hooks, or rewrite published history. A commit does not imply a push or a
PR update; follow the [PR guide](../../../docs/maintainers/pull-requests.md) when
that work is requested.
