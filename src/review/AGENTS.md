# Review orchestration

Own service composition, configured reviewer calls, cache, rate budget, and concurrency. May depend on action, policy, approvals, runtime, and config; never transport. createReviewService accepts trusted in-process adapters for isolated tests. MCP arguments must never configure those adapters. Explicit reviews bypass result cache; cached reads reverify current filesystem state; cancelled requests cannot use cache or learned approvals. Do not cache unredacted model output. Default exports use the real isolated runtime.

Validation: review-policy and filesystem tests.

The scheduler owns bounded FIFO admission; each request owns a total deadline
covering reuse, queue wait, auth and model/policy work. Keep a running child slot
until adapter cleanup settles even if the caller stops waiting. Never cache
infrastructure failures, extend cached expiry on access, or reuse an explicit
confirmation. Availability metadata is host-owned and never an approval.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
