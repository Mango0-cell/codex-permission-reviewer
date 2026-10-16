---
name: architecture
description: Navigate or change this repository's architecture, module boundaries, ownership, compatibility paths, or agent-maintenance structure. Use for structural decisions; use policy or runtime expertise for domain behavior.
---

# Architecture

Read root `AGENTS.md` and the nearest domain specification. Read the
[architecture guide](../../../docs/maintainers/architecture.md) before moving
responsibility or adding a module; use the [maintenance map](../../../docs/maintenance.md)
to locate its owner. Follow the [code-writing guide](../../../docs/maintainers/engineering.md)
when changing source or types.

Trace the trigger, owner, callers, dependencies and observable contract before
editing. Choose a pattern because the problem needs it, preserve stable
entrypoints, and keep behavior changes separate from architecture-only work.
Use the relevant provider-native skill for focused policy, runtime, commit or PR
work rather than loading every guide by default.

This skill does not authorize unrelated GitHub writes, releases or execution of
proposed actions. Honor authorization already provided in the task; run the
checks that cover the changed contracts and report evidence and limits.
