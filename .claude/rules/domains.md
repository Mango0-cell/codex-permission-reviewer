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
product/code folder add AGENTS.md. The native `.agents/` and `.claude/` setup
trees use provider skill/rule formats and are exempt from nested AGENTS.md and
CLAUDE.md specs. For a new abstraction name its concrete owner and contract.
