# Review orchestration

Own service composition, configured reviewer calls, cache, rate budget, and concurrency. May depend on action, policy, approvals, runtime, and config; never transport. createReviewService accepts trusted in-process adapters for isolated tests. MCP arguments must never configure those adapters. Explicit reviews bypass result cache; cached reads reverify current filesystem state; cancelled requests cannot use cache or learned approvals. Do not cache unredacted model output. Default exports use the real isolated runtime.

Validation: review-policy and filesystem tests.
