# Code-writing conventions

Read the root and nearest domain AGENTS.md, then the domain guide for the code you
are changing. Follow the source format declared by the active branch. This
repository favors a small advisory layer with direct, testable module contracts.

## Shape the change around its owner

Trace the trigger, callers, dependencies and observable result before editing.
Keep each rule beside the domain that owns it. Prefer clear functions and direct
calls; introduce an adapter only at a real process, filesystem, storage, model or
protocol boundary. Do not add a framework, generic registry or abstraction solely
to make the folder tree look symmetrical.

Name functions and values for the behavior they carry out. Make inputs, results,
error behavior and side-effect owners visible. Split a function when its distinct
branches have different owners or lifetimes, not just to reduce its line count.
Use comments to explain a constraint, invariant or non-obvious choice rather than
restate the code.

## Validate at boundaries

Treat action metadata, model output, MCP input, environment values and persisted
data as untrusted. Parse them into a normalized internal contract before prompt
construction, authorization or persistence. Reject malformed or oversized input
at the owning boundary; do not silently truncate scope or coerce unknown values.
Keep deterministic policy, reviewer output and host authorization as distinct
inputs to a decision.

When the active source scope is TypeScript, keep `strict` compiler checks enabled,
use `unknown` for external JSON and narrow it with runtime guards, and avoid `any`.
Keep a necessary assertion local to the validator or trusted adapter that proves
it. Do not add `@ts-ignore`, `@ts-nocheck` or unchecked casts to silence a boundary
that still needs validation. In JavaScript scopes, preserve equivalent runtime
validation and use JSDoc only when it makes a non-obvious public contract clearer.
When a branch generates compatibility files from typed source, edit the typed
source and generator, not a second handwritten implementation.

## Make failure and cleanup explicit

Distinguish invalid input, a policy result and an incomplete infrastructure
operation. Return or throw failures in a form the caller can handle; avoid broad
catch-and-continue fallbacks that can turn missing evidence into an allow. Give
each timeout, cancellation signal, queue slot, child process and temporary file a
clear owner. Release acquired resources on success, error and cancellation.

Keep requests, output, concurrency and retained state bounded. Reuse data only
when the canonical scope and eligibility rules match. Do not persist raw proposed
commands, secrets or approval history. Preserve exact user authorization and the
host's final authority.

## Verify behavior that matters

Test the public or domain contract with inert fixture strings, temporary state and
injected trusted adapters. Cover representative valid, invalid, boundary,
cancellation and recovery cases for the changed behavior. Assert decisions,
callers, cleanup and model-call counts where those are the contract; do not test
only private helper wording. Never execute a proposed destructive command,
inspect real credentials or contact a live reviewer in a routine test.
