---
name: reviewer-runtime
description: Implement or debug review coordination, performance, cache recovery, child isolation, cancellation or MCP/app-server communication in this permission-reviewer repository.
---

# Reviewer Runtime

Read root AGENTS.md and the nearest domain AGENTS.md. Claude Code loads the
same specifications through their CLAUDE.md import mirrors.
Read [the shared expertise guide](../../../docs/maintainers/runtime.md) before changing
this area. For navigation or cross-domain changes, use
[the maintenance map](../../../docs/maintenance.md).
Follow [the code-writing conventions](../../../docs/maintainers/engineering.md)
when changing source.

Locate the lifecycle owner and model the success, failure, saturation and cancellation paths. Use trusted adapters and controlled concurrency fixtures before changing runtime behavior.

This skill is for writing and maintaining the plugin's source. It does not invoke
the permission reviewer for routine engineering work, install global agent rules,
or authorize merges, releases or execution of proposed sensitive commands. Honor
authorization already provided in the task. Run the checks relevant to the change
and report observed behavior, verification and material limitations.
