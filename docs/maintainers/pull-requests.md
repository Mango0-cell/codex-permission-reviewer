# GitHub pull request workflow

Use this guide when asked to review a PR, prepare or update a PR, or respond to
review feedback. Read root AGENTS.md, CONTRIBUTING.md, the PR template and the
nearest domain specifications. An issue link is optional; do not invent a ticket
or import a separate organization's workflow.

## Review the whole changed path

Identify the PR number, base branch, head branch and current head SHA. Read the
PR description, complete base-to-head diff and changed files. Trace affected
exports, callers, validators, policies, side effects and compatibility paths into
the surrounding source and tests. Read the relevant architecture/policy/runtime
guide. Search for analogous branches and check relevant success, rejection,
boundary and recovery cases so a narrow code fix does not leave an obvious sibling
case uncovered.

Separate behavior introduced by this PR from gaps already present on its base.
Report the former as PR findings. Mention inherited gaps separately when they are
relevant to the requested scope; do not attribute them to the patch. State the
tested/inspected case families and limits. A review of a bounded matcher cannot
claim coverage of every shell, SQL or other open-ended language unless the
implementation and test matrix support that claim.

Report actionable findings from highest impact to lowest. Each should name the
trigger, consequence and a focused correction. For inline review comments, anchor
each finding to a changed line in the current diff, use the exact current head SHA,
and include the repository-relative path and diff side/line. Do not attach a
comment to an unchanged line; use a general review comment for findings that have
no suitable changed line. Request changes for material correctness or safety
issues, not style preferences. Keep unrelated baseline findings out of the
blocking review.

When submitting comments or a review, use the available GitHub review tool or
`gh` API and verify the target PR and head immediately before posting. The task
must ask for a submitted GitHub review/comment; reading a PR alone does not
authorize changing its state. Preserve the user's requested review outcome.

## Prepare or update a PR

Before creation or editing, inspect the intended base-to-head diff, commit list,
working tree, target base and existing open PRs. Keep behavior fixes, refactors,
architecture/rules and maintenance tooling separate unless the task explicitly
combines them. Use the title and base branch appropriate to the repository and
task. Use `.github/PULL_REQUEST_TEMPLATE.md` and keep its sections useful to this
change; do not add mandatory issue fields.

Write the problem, result, affected scope, design and material risks from the
actual diff. Record commands that really ran and their outcomes. Distinguish
fixture results from live inference or performance claims, and call out checks
that remain pending or unavailable. Include the head SHA when reporting CI; a
green check for an older commit does not validate the current PR head. If a PR is
already open, update that PR instead of creating a duplicate.

Only create, edit, push or submit PR comments when the task authorizes that GitHub
action. Authorization to create or update a PR does not authorize merging it.
Merge only when the task explicitly requests the merge and its stated checks are
satisfied. Never auto-merge or treat green CI alone as merge authorization.

## Respond to review feedback

Read all unresolved review threads and current checks against the latest head.
For each material comment, verify the concern in current code and classify it as
valid, already addressed, or not applicable with evidence. Implement valid fixes
in the owning domain, add meaningful regression coverage, run relevant checks,
and update the PR only within existing task authorization. Reply with the changed
behavior and validation; do not dismiss or resolve an unresolved finding without
checking it. After a push, report the new head SHA and wait for or inspect checks
on that exact commit before calling the PR verified.

For commit format and focused staging, see [the commit conventions](commits.md).
