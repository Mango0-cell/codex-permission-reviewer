---
paths:
  - "src/**/*.mjs"
  - "src/**/*.ts"
  - "scripts/**/*.mjs"
  - "scripts/**/*.ts"
  - "bin/**/*.mjs"
  - "bin/**/*.ts"
---

Read the nearest domain AGENTS.md and docs/maintenance.md's relevant expertise
route before changing responsibility or behavior. Keep action/policy separate
from orchestration, runtime and transport. Only trusted in-process composition
configures adapters. Preserve scripts/ compatibility paths and exports. For a new
folder add AGENTS.md; for a new abstraction name its concrete owner and contract.
