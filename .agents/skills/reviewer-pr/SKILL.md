---
name: reviewer-pr
description: Review, prepare, update, or respond to GitHub pull requests for this permission-reviewer repository.
---

# Reviewer PR

Read root AGENTS.md and [the PR guide](../../../docs/maintainers/pull-requests.md).
For code findings, also read the nearest domain specification and the relevant
architecture, policy or runtime guide. Trace the PR's full changed path through
callers and related tests; separate regressions introduced by this PR from
pre-existing gaps. Keep completeness claims proportional to the actual cases
examined.

Tie inline findings to a changed path and line on the current PR head. Verify the
head SHA before posting. Use the checked-in PR template and report only observed
checks. Follow the commit guide for staged fixes and responses to feedback.

Honor existing task authorization for GitHub writes. A review does not authorize
merging; merge only when explicitly requested and the required checks pass.
