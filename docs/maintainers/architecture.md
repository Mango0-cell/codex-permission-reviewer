# Architecture and navigation expertise

Use this guide to locate responsibility, choose a module boundary, or design a
change. Read ../../AGENTS.md and ../architecture.md first. Domain specs remain
the local contract; this guide explains how to make decisions within it.

## Trace the path before adding structure

Start at the actual trigger. MCP callers enter src/transport/mcp.mjs; installation
enters bin/cli.mjs; existing imports enter scripts/server.mjs or
scripts/app-server-client.mjs. Trace into src/review/service.mjs for coordination,
then into the appropriate action/policy/approvals/runtime domain. Tests mirror
observable boundaries rather than every implementation function.

Use rg to find the symbol, callers, exports, and tests. An existing graphify graph
can help locate relationships, but check its freshness and confirm findings in
source. A stale graph is not evidence of the current call path.

## Pattern selection

| Problem | Preferred design here | Contract to preserve |
| --- | --- | --- |
| Deterministic validation or transformation | Small pure functions and explicit JSON contracts in action/ | Same input yields same result; bounds and unknown-field rejection remain local |
| Deterministic authorization | Policy functions; isolate filesystem verification from text classification | Decisions may restrict model allow, never overwrite model deny |
| Testable process/storage integration | Ports and adapters through trusted in-process composition | Callers cannot inject executable paths, models, or adapters through MCP data |
| Several requests sharing a scarce reviewer | Bounded coordination owned by review/ | Capacity, deadlines, cancellation and cleanup have one owner |
| A child or descriptor needs cleanup | Scoped lifecycle with try/finally and owned cancellation | Release resources on success, error and cancellation |
| Local module communication | Direct functions/promises and explicit data transfer objects | Acyclic imports; no internal RPC, global event bus or hidden mutable registry |
| Persisted approvals | Narrow repository adapter with a versioned canonical scope | Persist only eligible hashes/timestamps; format changes require invalidation reasoning |
| Keep old import/launch paths | Compatibility facade in scripts/ | No duplicate business logic or side effects on import |

These are choices for concrete problems, not a requirement to add classes,
interfaces, factories, repositories, or patterns to every function. Add an
abstraction when it isolates a real boundary or removes a demonstrated source of
errors. Native ESM functions are sufficient for most of this codebase.

## Adding or moving code

Keep action/ independent of policy and orchestration; policy and approvals depend
on action contracts; review coordinates domains; transport depends on the review
service. Runtime configuration is a leaf so loading contracts does not launch or
load process orchestration. Built-in dependencies remain explicit.

For a new module, state ownership, inputs/outputs, error behavior, cancellation
owner if relevant, and callers. For a new folder, add its AGENTS.md. Move logic
once, preserving stable exports through facades. If behavior changes, split the
fix from a refactor so a reviewer can tell what is actually different.

## Placement evidence

For a structural change, put a short ownership note in the PR: responsibility,
current caller/import evidence, chosen path, allowed dependency direction,
public/compatibility surface, and affected domain specs. Explain any new shared
scope from actual consumers rather than naming symmetry. A shallow cohesive
module is valid; avoid generic common/misc/utils folders without a proven owner.
This adapts the evidence-first placement approach used in Beela without importing
its application stack, organization workflows or folder taxonomy.

## Acceptance evidence

Run tests/architecture.test.mjs for dependency direction, cycles, legacy exports,
spec coverage and distribution. For moves, compare the sensitive implementation
before and after; tests alone do not prove no behavior changed. Use the relevant
policy/runtime guide for any altered behavior. Report remaining limitations and
keep examples proportional to the actual change.
