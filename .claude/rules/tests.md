---
paths:
  - "tests/**/*.mjs"
---

Read tests/AGENTS.md. Proposed commands remain inert strings. Use controlled
reviewer adapters and temporary state; never read real auth or developer approval
state. Verify observable outcomes and lifecycle boundaries, with deferred promises
for concurrency. Compare policy results and model-call counts when changing reuse
or scheduling. Do not call a live reviewer or execute destructive fixtures.
