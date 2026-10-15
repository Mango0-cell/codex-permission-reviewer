# Approval policy and action-contract expertise

Use this guide when changing src/action/, src/policy/, src/approvals/ or the
shipped permission-review skill. The product is an advisor: a result cannot grant
host permissions or cause execution. Do not widen authorization to avoid latency.

## Separate the decision authorities

| Authority | Owns | Must not become |
| --- | --- | --- |
| Human | Exact user intent and informed authorization in the active task | A claim inferred from retries, model output or an unrelated old approval |
| Isolated model | Advisory assessment of bounded untrusted metadata | A source of executable instructions or host permission |
| Deterministic policy | Non-overridable blockers, verified reads and eligibility | A mechanism to promote model deny/needs_user into allow |
| Host | Actual permissions, execution-time recheck and sandbox | Something this plugin overrides |

Treat action metadata and reviewer responses as separate untrusted interfaces.
Wire schemas live in action/contracts.mjs; normalization, redaction, prompts and
canonical digests in action/metadata.mjs; response parsing in
action/review-result.mjs. Keep strict local response validation even when the
model is asked for structured output. Only the host should add lifecycle metadata.

## Reason about a change across paths

Trace fresh review, explicit confirmation, ordinary result reuse, learned scope,
and any filesystem verification. Ask whether each path still checks the property
you changed. Explicit confirmations require fresh review; cached reads must
reverify actual file state. Caller-supplied roots never replace server trust.

For human approval, identify whether the blocker is missing authorization,
unclear scope, a non-overridable hazard, or reviewer unavailability. Missing
exact authorization is not proof that the action itself is forbidden. Preserve a
fresh explicit-review path for eligible actions, while keeping actual model
rejections and deterministic blockers effective. Do not add blanket overrides.

Canonicalization is part of the security contract. Include every decision input,
including authorization, in the result scope. Changing learned-scope semantics
requires deciding whether the policy version should invalidate old hashes. Never
persist commands, reasons, targets, credentials, or raw model output in approvals.

## False positives and missed hazards

A lexical detector is not a shell/SQL interpreter. Reproduce with inert strings
and check tokens, separators, flag order, wrappers, nested executable strings,
SQL statement boundaries, and qualifier placement. Keep absence of a signal
separate from authorization. Document unsupported dynamic constructs rather than
claiming exhaustive detection. Read policy.mjs's eligibility checks as well as the
command detector before changing one branch.

## Verification

Use controlled model allow/deny/needs_user fixtures and check policy outcomes,
not only text matches. Cover exact human confirmation, scope changes, ambiguity,
sensitive flags, cached/learned paths, and the failure case relevant to the fix.
Use temporary CODEX_HOME and trusted roots for state/filesystem tests; otherwise
inject a fake approval adapter so tests do not read the developer's state.
Never run destructive fixture commands. Update the shipped skill only to describe
real supported outcomes; maintenance instructions belong outside skills/.
