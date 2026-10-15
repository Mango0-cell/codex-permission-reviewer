---
name: reviewer-policy
description: Implement or debug action validation, human confirmation, deterministic authorization, command signals or learned approvals in this permission-reviewer repository.
---

# Reviewer Policy

Read root AGENTS.md and the nearest domain AGENTS.md. Claude Code loads the
same specifications through their CLAUDE.md import mirrors.
Read [the shared expertise guide](../../../docs/maintainers/policy.md) before changing
this area. For navigation or cross-domain changes, use
[the maintenance map](../../../docs/maintenance.md).
Follow [the code-writing conventions](../../../docs/maintainers/engineering.md)
when changing source.

Trace the affected decision through fresh, explicit, cached and learned paths. Preserve the human/model/deterministic/host boundaries and prove outcomes with inert fixtures and isolated state.

This skill is for writing and maintaining the plugin's source. It does not invoke
the permission reviewer for routine engineering work, install global agent rules,
or authorize merges, releases or execution of proposed sensitive commands. Honor
authorization already provided in the task. Run the checks relevant to the change
and report observed behavior, verification and material limitations.
