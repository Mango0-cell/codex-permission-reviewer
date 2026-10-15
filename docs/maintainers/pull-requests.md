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

## Stack dependent pull requests deliberately

Use a stack when a higher change genuinely depends on a lower one and the work
can be split into focused, independently reviewable layers. Keep foundational
changes at the bottom and dependent changes above them. Do not create a stack to
connect unrelated tasks; keep those PRs independent. In a stack, the bottom PR
targets the trunk branch and each next PR targets the branch immediately below
it.

First inspect the repository, PR numbers, branch names, bases, current head SHAs,
open/merged state, and intended bottom-to-top order. A manual chain of PR base
branches is not proof of a GitHub native stack. Verify native membership using
the stack map in GitHub, the PR REST resource's `stack` object, or the REST
[list stacks endpoint](https://docs.github.com/en/rest/pulls/stacks) filtered by
`pull_request`; compare the returned members and order with the intended chain.
The PR [stack APIs and webhooks guide](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks)
documents these membership fields.

When linking existing PRs, confirm they are open and in the same repository,
that none already belongs to a different stack, and that the ordered list has no
duplicate PRs. GitHub's `gh stack link` accepts existing PR numbers from bottom
to top (for example, `gh stack link 123 124 125`); check the installed command's
help before using it. This command links the PRs on GitHub but does not create
local stack tracking. Linking changes GitHub state, so do it only when the task
authorizes that write. Authorization to register a stack does not authorize
merging it or rewriting published heads. If the CLI command is unavailable,
GitHub also documents stack management through its REST API; choose a supported
route that fits the task. Since `gh stack` is an extension and installed
capabilities vary, inspect `gh --version`, `gh extension list`, `gh stack
--help`, and `gh stack link --help` instead of treating a version claim as a
universal gate. The [quickstart](https://docs.github.com/en/pull-requests/get-started/stacked-prs-quickstart),
[CLI reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands),
and [guidance for other tools](https://docs.github.com/en/pull-requests/reference/use-other-tools-with-stacked-pull-requests)
describe the supported workflows.

Treat a stack merge as a multi-PR operation. GitHub merges from the bottom up;
merging a middle or top PR also merges every lower PR in that stack. Before any
merge, verify the native stack membership, enumerate the exact PRs that would
merge, confirm the task authorizes that whole set, and check current approvals,
branch protections, and exact-head CI for every included layer. A green check
does not authorize a merge. Do not merge unless the task explicitly requests
it.

Merging a lower PR can automatically retarget and rebase the remaining stack,
changing their heads. Do not run `gh stack sync`, local rebases, history rewrites,
or force pushes automatically; those operations need deliberate authorization.
After an authorized base or head change, re-read the complete affected diffs,
verify each current head and base, and wait for or inspect CI and protections on
those exact heads before describing the stack as verified. See GitHub's
[stacked PR overview](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
and [merge guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests)
for native behavior and merge requirements.

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
