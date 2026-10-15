# Reviewer coordination and protocol expertise

Use this guide for src/review/, src/runtime/, src/transport/ and changes to latency,
reliability or agent-facing outcomes. The scarce resource is an isolated reviewer
child; the caller is another agent that needs a bounded, actionable answer.

## Own the right boundary

Review service: validation-to-result coordination, trusted adapter composition,
reuse, rate budget, concurrency and policy application. Runtime adapter: executable
identity, temporary environment, child protocol, model/profile validation and
cleanup. Transport: JSON-RPC initialization, bounded framing, request identity,
cancellation and shutdown. Do not put scheduling in transport or interpret model
items in policy. Keep domain communication explicit through functions/promises.

## Designing reliable coordination

Name the owner of each timeout, capacity limit and AbortSignal. Bound waiting as
well as active model work. If a caller stops waiting before cleanup completes,
keep the underlying resource reserved until the old operation actually settles;
otherwise cancellation can accidentally start overlapping children. Queued work
must be removable without consuming a model call or leaving abort listeners.

When requests share results, require identical canonical scope and account for
explicit confirmations needing fresh review. Each caller owns its result object
and cancellation; one cancellation must not cancel a different agent's review.
Decide whether failures are policy results or incomplete operations before caching
or retrying them. A transient process/transport failure must not become a reusable
policy denial. Preserve original result expiry; do not extend approval freshness
on every cache hit. Reverify cached safe reads.

Retry a review query only for a documented transient failure, under a bounded
attempt/time budget. Never retry the proposed sensitive action as a substitute
for obtaining review. Continue independent work where permitted by host policy.
Keep retry guidance distinct from human authorization and from an actual deny.
Do not add silent fallback reviewers, weaken validation, or automatically switch
the configured model/effort to make a failure disappear.

## Process and IPC invariants

Never execute proposed commands. Keep executable identity pinning, environment
allowlisting, temporary cwd/CODEX_HOME, managed-auth symlink only, no-tools profile,
disabled capabilities/network, and bounded stdout/stderr intact. Never inspect
real auth contents for debugging. Cleanup belongs to the code that acquires the
resource, including errors while starting or negotiating a child.

For MCP/app-server changes, read existing protocol validators and recognize the
difference between requests, notifications, results, and embedded items. Preserve
initialize-before-tools, independent request IDs/cancellation, shutdown behavior,
size bounds across chunk boundaries, and protocol-only stdout. Invalid input
must fail predictably without executing anything.

## Evidence for throughput and quality

Use injected adapters and deferred promises to test ordering, maximum active
children, duplicate calls, queue saturation, cancellation, deadlines, and recovery.
Test cache expiry and reused filesystem state when touching reuse. Measure actual
model-call count and caller outcomes, not just elapsed test-suite time. Keep timing
assertions loose and prefer explicit barriers to arbitrary sleeps.

Separate synthetic coordination measurements from real inference latency and
model-answer quality. Changing a model/prompt requires current official guidance
and a representative evaluation with explicit cost/latency and false-positive/
missed-hazard criteria; use user-authorized real reviews only when needed. A local
fixture test cannot establish that one model gives better answers than another.
