---
name: reviewer-architecture
description: Navigate and maintain this permission-reviewer repository, choose domain boundaries and design patterns, or change its folder structure and compatibility entrypoints.
---

# Reviewer Architecture

Read root AGENTS.md and the nearest domain AGENTS.md. Claude Code loads the
same specifications through their CLAUDE.md import mirrors.
Read [the shared expertise guide](../../../docs/maintainers/architecture.md) before changing
this area. For navigation or cross-domain changes, use
[the maintenance map](../../../docs/maintenance.md).

Identify the trigger, owner, callers and observable contract before editing. Use the shared guide to choose a pattern only when the actual problem needs it. Keep behavior changes separate from architecture/rules-only work.

This skill is for writing and maintaining the plugin's source. It does not invoke
the permission reviewer for routine engineering work, install global agent rules,
or authorize merges, releases or execution of proposed sensitive commands. Honor
authorization already provided in the task. Run the checks relevant to the change
and report observed behavior, verification and material limitations.
