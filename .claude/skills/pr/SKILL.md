---
name: pr
description: Review a GitHub pull request or prepare, update, or respond to PR feedback in this repository, including checking stacked-PR dependencies and exact-head CI. Use when PR work is requested.
---

# Pull Requests

Read the root `CLAUDE.md` (it imports the canonical `AGENTS.md`) and the
[PR guide](../../../docs/maintainers/pull-requests.md). For code findings, read
the nearest domain specification and relevant architecture, policy or runtime
guide. Trace changed paths through callers and related tests; distinguish
regressions introduced by the PR from inherited gaps, and bound completeness
claims to the cases actually examined.

Tie inline findings to a changed path and line on the current PR head. Verify
the head SHA before posting, use the checked-in template for PR descriptions,
and report only checks observed on the exact head. Follow the commit guide for
staged fixes and replies to feedback.

For dependent PRs, follow the stack workflow in the PR guide. Confirm each layer
is a real dependency or coherent review unit; unrelated work stays independent.
A chain of base branches is not proof of native GitHub stack membership. Verify
membership and order before relying on stack behavior. Merging a middle or top
PR may include every lower layer, so confirm authorization for that exact set
and current checks for each included head.

Honor task authorization for GitHub writes. A review does not authorize posting
comments or merging; merge only when explicitly requested and required checks
pass.
