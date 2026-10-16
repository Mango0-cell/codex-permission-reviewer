---
name: policy
description: Implement, debug, or trace this plugin's action validation and authorization policy, human confirmation, command-risk signals, response contract, or learned-approval eligibility.
---

# Policy

Read the root `CLAUDE.md` (it imports the canonical `AGENTS.md`) and the nearest
domain specification. Start with the
[policy guide](../../../docs/maintainers/policy.md); use the
[maintenance map](../../../docs/maintenance.md) for cross-domain ownership and
the [code-writing guide](../../../docs/maintainers/engineering.md) for source
changes.

Trace the affected decision through fresh review, exact explicit authorization,
cached results and learned approvals as applicable. Preserve the host, human,
model and deterministic-policy boundaries. Validate external metadata before
use and prove behavior with inert fixtures and isolated state.

Keep ordinary policy implementation distinct from requested security audits or
runtime coordination work. Do not treat a missing signal or unavailable reviewer
as permission to allow an action. Run relevant checks and report observed
behavior and material limits.
