---
name: reviewer-commit
description: Stage and commit focused changes in this permission-reviewer repository using its domain scopes and Conventional Commit format.
---

# Reviewer Commit

Read root AGENTS.md and [the commit guide](../../../docs/maintainers/commits.md).
Check the current branch, status and staged diff. Stage only files or hunks for
the authorized logical change; leave unrelated work untouched. Use the domain
scope and message format in the guide, run a focused check, and review the staged
diff before committing.

Do not invent task identifiers, push as an automatic follow-up, bypass hooks, or
rewrite published history. Preserve existing task authorization and follow
[the PR guide](../../../docs/maintainers/pull-requests.md) when PR work is
requested.
